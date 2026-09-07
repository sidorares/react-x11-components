// <ReorderList> — a list the user reorders by dragging its items, or by
// lifting one from the keyboard and walking it with the arrows: a todo list,
// a playlist, a settings dialog's columns, a kanban board when several lists
// share a `group`.
//
// This is the **sortable layer over react-x11's own drag and drop**, the
// position `@dnd-kit/sortable` holds over `@dnd-kit/core` — except that the
// engine is core's (docs/drag-and-drop.md there): the 4px threshold, click
// suppression, `:dragging`/`:drag-over`, the in-app payload arriving by
// reference on `e.items`, edge auto-scroll of any scroll container, the
// `<popup dragPreview>` a preview is drawn in, and the promotion of the same
// drag to XDND — or, on the cocoa backend, to NSDragging — when the pointer
// leaves the app. None of that is here. What is here is what a sortable
// preset is: the insertion arithmetic (`./model.ts`), the indicator, the
// keyboard model, and an event vocabulary that speaks list-and-index rather
// than node-and-pointer.
//
// `docs/prd-reorder.md` is the design record — the survey of dnd-kit,
// hello-pangea, pragmatic-drag-and-drop, React Aria and Framer's Reorder,
// and what each settled. The decisions a reader of this file would not
// guess, each with its paragraph there:
//
//  - **The list is the only drop target; items are not.** One `dropAccept`
//    on the root, one `onDragOver` that reads every item's rectangle and
//    finds the closest edge, and the two items either side of the slot are
//    told to draw or clear their indicator through a per-item setter — so a
//    pointer motion re-renders at most two items and never the list.
//  - **Membership is in the payload's type name.** Lists in a group accept
//    `application/x-react-x11-reorder;scope=group:<name>`; a list on its own
//    accepts `…scope=list:<its uid>`. That keeps "who takes this drop" a
//    declarative fact core answers from `dropAccept` data with no React in
//    the loop — and it has to be, because `e.accept()` in `onDragOver` can
//    only override a node whose `dropAccept` already matched. `canDrop` is
//    the *dynamic* half, and it works the other way round: it can only
//    refuse (`ev.reject()`), which is a decision core lets a handler make.
//  - **A move between lists is two local handlers**, `onInsert` on the list
//    it landed in and `onRemove` on the list it left — React Aria's model,
//    and the order core already fires them in (`onDrop`, then `onDragEnd`
//    "always last"). The target writes where the item landed onto the live
//    payload object, which is how the source can say `to`.
//  - **The hover channel is module state, and it has to be.** `onDragOver`
//    hands the target a `DragEvent`, which carries no `items` — only the
//    drop does — so a target physically cannot write on the payload while
//    the pointer is merely over it. `activeDrag` below is the one-gesture
//    scratchpad the target writes and the source reads in its own `onDrag`,
//    which is what makes `onDragUpdate` able to say *which list* the pointer
//    is over. It is one object for one gesture, never read at import time.
//  - **The indicator, not the slide.** Neighbours do not glide out of the
//    way: this renderer has no transform, and a line at the closest edge
//    answers the same question for a rectangle per item. The one thing that
//    does move is the drop: `dropAnimation` flies a copy of the item from
//    where the pointer let go to where the item landed. That copy is a box
//    **inside the item**, not the ghost popup carried on — a popup outlives
//    the gesture as a real window over the list, and the press that follows
//    a drop by less than the animation lands on it instead of on the list.
//    An absolutely positioned box with `pointerEvents: 'none'` cannot take
//    an input the list should have had.
//  - **The ghost popup is `transparent`.** It is a real window, and the card
//    inside it is rounded, so on an opaque popup the four corners the radius
//    gives up show the window's own ground — white on a light theme, near
//    black on a dark one. Where no compositor runs the window fills itself
//    square, which is what an opaque one looked like anyway.
//  - **An in-window ghost has to lift its whole list, not just its item.**
//    `zIndex` sorts a node among its *siblings* — `paintOrder()` is per
//    node, and there is no stacking context to escape — so a ghost lifted
//    inside its item still paints under a *different* list, which is what a
//    board or a palette-plus-target is made of. The item is lifted over its
//    neighbours and the list root over its own, for the length of the
//    gesture. What that cannot reach is content outside the list's parent;
//    a popup ghost has no such limit, which is why `'auto'` is one. (The
//    in-window ghost was the default on the cocoa backend for exactly one
//    release, while a preview popup there still registered itself as a
//    dragging destination and swallowed the drop — react-x11#488, fixed in
//    2.8.1, which is this package's floor.)
//  - **Every item (or its handle) is a tab stop.** An item is arbitrary
//    content, often with controls of its own; the Tree/Table model of one
//    tab stop with a cursor would leave a button inside a card unreachable.
//  - **A press on a control inside an item is not a drag.** Core arms a drag
//    from the nearest draggable *ancestor* of whatever was pressed, so a
//    press on a `<textinput>` in a card would drag the card after 4px. The
//    item records what the press landed on and cancels the drag at the
//    threshold — `onDragStart`'s `preventDefault()`, which core documents as
//    "the gesture continues as ordinary mouse events". `dragFromInteractive`
//    turns it off; a `<ReorderHandle>` makes the question moot.
//
// It is pure composition of `<box>`, `<popup>` and core's `<Icon>`, so
// there is no `registerElement` here and no side effect at import time.
import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import {
  Icon,
  announce,
  useDragSource,
  useSystemAppearance,
  useTheme,
} from 'react-x11';
import type {
  DragEndEvent,
  DragEvent,
  DragSourceEvent,
  DragSourceProps,
  DrawnNode,
  DropAccept,
  DropEvent,
  KeyboardEvent,
  MouseEvent,
  Theme,
} from 'react-x11';
import type { Style } from 'react-x11/style';
import {
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_HOME,
  XK_LEFT,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';

import { hx } from './hx.js';
// Shared with <Tree> and <Table> — internal, deliberately not a shared
// *module*; the header of src/internal/timers.ts says why. The drop flight
// needs both: a tick after the layout that placed the item, and a clock.
import {
  afterLayout,
  cancelAfterLayout,
  cancelLater,
  later,
} from '../internal/timers.js';
import type { DelayTick, LayoutTick } from '../internal/timers.js';
import {
  closestSlot,
  insertManyAtSlot,
  moveManyToSlot,
  slotMark,
} from './model.js';
import type {
  ReorderEdge,
  ReorderId,
  ReorderOrientation,
  ReorderRect,
} from './model.js';

export {
  arrayMove,
  closestSlot,
  insertAtSlot,
  insertManyAtSlot,
  isNoopSlot,
  moveManyToSlot,
  moveToSlot,
  slotMark,
} from './model.js';
export type {
  ReorderEdge,
  ReorderId,
  ReorderOrientation,
  ReorderPoint,
  ReorderRect,
  ReorderSlot,
} from './model.js';

const h = React.createElement;

/** What `style` props here accept, matching the rest of the package. */
type StyleInput = Style | Style[];

/**
 * The private payload type every item offers. The scope suffix is what
 * `dropAccept` matches on — see the header. Exported because it is the one
 * string only this component writes (the tree-shaking guard keys on it),
 * and because an app's own dropzone may want to refuse or take a list item
 * by name.
 */
export const REORDER_TYPE = 'application/x-react-x11-reorder';

function scopedType(scope: string): string {
  return `${REORDER_TYPE};scope=${scope}`;
}

/** The indicator's thickness. Centred on the edge it marks. */
const INDICATOR = 2;
/** The default handle: two columns of core's `moreVertical` dots. */
const GRIP_DOT = 10;
/**
 * How much of an item, at each end, still reads as an edge once `combine`
 * is on — so the middle half of an item is where a merge lands. Small
 * enough that reordering past a combining list is still comfortable.
 */
const COMBINE_BAND = 0.25;
/** How long the ghost takes to fly to where the item landed. */
const DROP_MS = 180;
/** One step of that flight. Not a frame clock: this is a handful of ticks
 *  moving one override-redirect window, and core's own animation machinery
 *  drives style properties rather than a popup's geometry. */
const FLIGHT_STEP_MS = 16;

/** What the focus target tells a screen reader it can do. */
const HINT =
  'Draggable. Press Space to lift, the arrow keys to move, Space to drop.';

/** Every announcement, in one place, because none of it is localised yet. */
const SAY = {
  lifted: (label: string, at: number, of: number, many: number): string =>
    `Lifted ${label}${many > 1 ? ` and ${many - 1} more` : ''}, ` +
    `position ${at} of ${of}. ` +
    'Use the arrow keys to move, Space to drop, Escape to cancel.',
  pickedUp: (label: string, at: number, of: number, many: number): string =>
    `Dragging ${label}${many > 1 ? ` and ${many - 1} more` : ''}, ` +
    `position ${at} of ${of}.`,
  moved: (label: string, at: number, of: number): string =>
    `${label} moved to position ${at} of ${of}.`,
  dropped: (label: string, at: number, of: number): string =>
    `${label} dropped at position ${at} of ${of}.`,
  droppedInto: (label: string, list: string | undefined): string =>
    `${label} dropped${list ? ` in ${list}` : ' in another list'}.`,
  combined: (label: string, into: string): string =>
    `${label} dropped onto ${into}.`,
  cancelled: (label: string, at: number): string =>
    `Move cancelled. ${label} returned to position ${at}.`,
  returned: (label: string): string => `${label} returned to where it was.`,
};

// --- the events -------------------------------------------------------------

/** Where a drag is being driven from. */
export type ReorderInput = 'pointer' | 'keyboard';

/** A move within one list. `items` is the ids in their new order — what an
 *  app holding ids sets its state to — and `from`/`to` are what one holding
 *  objects hands to `arrayMove`. `ids` is everything that moved, which is
 *  `[id]` unless a multi-drag carried a selection. */
export interface ReorderChange {
  items: ReorderId[];
  id: ReorderId;
  ids: ReorderId[];
  from: number;
  to: number;
}

/** An item from another `<ReorderList>` in the group landed here. `items` is
 *  this list's ids with `id` already in place; `source` is where it came
 *  from — hello-pangea's `{ droppableId, index }`, by other names. `action`
 *  is `'copy'` when the source offered a copy, and then it keeps its own. */
export interface ReorderInsert {
  items: ReorderId[];
  id: ReorderId;
  ids: ReorderId[];
  index: number;
  action: 'move' | 'copy';
  source: { list: string | undefined; index: number };
  event: DropEvent;
}

/** An item of this list was taken by something else: another list in the
 *  group (`to` says which, and where), or — `to: null` — a plain
 *  `dropAccept` node in the app, or another application, that accepted a
 *  `move`. Fires only for a move; a copy leaves the item where it is. */
export interface ReorderRemove {
  items: ReorderId[];
  id: ReorderId;
  ids: ReorderId[];
  index: number;
  to: { list: string | undefined; index: number } | null;
  event: DragEndEvent;
}

/** A drop *onto* an item rather than between two — `combine` on the list
 *  that took it. The dragged item is still the source list's until the app
 *  removes it: a merge is the app's operation, so nothing is reordered and
 *  `onRemove` fires on the source exactly as it does for a cross-list move. */
export interface ReorderCombine {
  id: ReorderId;
  ids: ReorderId[];
  /** The item it was dropped onto, and where that item is. */
  into: ReorderId;
  index: number;
  source: { list: string | undefined; index: number };
  event: DropEvent;
}

/** A foreign payload — files, text, anything `accept` took — dropped at a
 *  slot. The event is core's, so `files`, `text` and `getData` are on it. */
export interface ReorderDrop {
  index: number;
  event: DropEvent;
}

/** What `canDrop` is asked, once per pointer position and again at the drop.
 *  A list item drag names `id`/`ids`/`source`; a foreign payload leaves them
 *  undefined and empty, and `event.types` is what it is offering. */
export interface ReorderDropQuery {
  id?: ReorderId;
  ids: ReorderId[];
  source: { list: string | undefined; index: number } | null;
  /** The slot it would land at. */
  index: number;
  /** The item it would merge into, when the pointer is in a combine band. */
  combine: ReorderId | null;
  event: DragEvent;
}

/** The drag started — a press past the threshold, or a keyboard lift. Fires
 *  on the list the item belongs to. */
export interface ReorderDragStart {
  id: ReorderId;
  ids: ReorderId[];
  index: number;
  input: ReorderInput;
}

/** Where the drag is now. Fires on the list the item belongs to, whichever
 *  list the pointer is over — `over` is null over anything that is not a
 *  list in the group. `over.index` is the index the item would **land at**,
 *  which is what `onReorder`'s `to` and `onInsert`'s `index` will say, not
 *  the raw gap it is hovering. */
export interface ReorderDragUpdate {
  id: ReorderId;
  ids: ReorderId[];
  from: number;
  over: { list: string | undefined; index: number } | null;
  combine: ReorderId | null;
  input: ReorderInput;
}

/** The gesture is over, however it ended. Fires on the list the item
 *  belongs to, after `onReorder`/`onInsert`/`onRemove`. */
export interface ReorderDragEnd {
  id: ReorderId;
  ids: ReorderId[];
  from: number;
  to: { list: string | undefined; index: number } | null;
  combine: ReorderId | null;
  reason: 'drop' | 'cancel';
  input: ReorderInput;
}

// --- the looks --------------------------------------------------------------

/** What `styles.item` and `renderPreview` are handed. */
export interface ReorderItemState {
  id: ReorderId;
  /** The pointer is dragging this item. */
  dragging: boolean;
  /** The keyboard has lifted this item. */
  lifted: boolean;
  disabled: boolean;
  /** Which of this item's edges the indicator is on, while a drag is over
   *  the list. */
  edge: ReorderEdge | null;
  /** A drop here would merge into this item rather than land beside it —
   *  the list's `combine`, and the pointer in this item's middle band. */
  combining: boolean;
  /** While the pointer drags this item: whether whatever is under the
   *  pointer would take it — a list in the group, a dropzone in the app,
   *  another application. False otherwise, the keyboard's lift included. */
  accepted: boolean;
  /** This render is the ghost's copy of the item, not the item in the list.
   *  What a child that renders in both asks before it draws its lighter
   *  version. */
  preview: boolean;
  /** Everything travelling with this item — `[id]`, unless the list's
   *  `selected` held it and a multi-drag picked the set up. */
  ids: readonly ReorderId[];
}

export interface ReorderStyles {
  /** The state seam: merged over the item's own `style`, so it can replace
   *  the wash a held item wears. */
  item?: (state: ReorderItemState) => StyleInput | null | undefined | false;
  handle?: StyleInput;
  /** The insertion line, and the outline a combining item wears — the state
   *  tells them apart. */
  indicator?: StyleInput;
  /** The card the default preview draws the item's children in. */
  preview?: StyleInput;
}

/** How big the ghost is. A function is asked once, at the drag's start. */
export type ReorderPreviewSize =
  | { width: number; height: number }
  | ((state: ReorderItemState) => { width: number; height: number });

// --- props ------------------------------------------------------------------

export interface ReorderListProps {
  /** Names this list in the events other lists receive (`source.list`,
   *  `to.list`). */
  id?: string;
  /** Lists sharing a group accept each other's items. Without one a list
   *  takes only its own. */
  group?: string;
  /** Which way the items run. Decides the indicator's edge and the arrow
   *  keys; the root's `flexDirection` follows it. Default `'vertical'`. */
  orientation?: ReorderOrientation;
  /** Nothing drags, nothing lifts, nothing lands. */
  disabled?: boolean;
  /** The ids a multi-drag picks up together: dragging one of them carries
   *  all of them, in this list's own order. The app holds the selection. */
  selected?: readonly ReorderId[];
  /** An item moved within this list. */
  onReorder?: (change: ReorderChange) => void;
  /** An item arrived from another list in the group. */
  onInsert?: (change: ReorderInsert) => void;
  /** An item of this list was moved elsewhere. */
  onRemove?: (change: ReorderRemove) => void;
  /** A drop *onto* one of this list's items. Needs `combine`. */
  onCombine?: (change: ReorderCombine) => void;
  /** Whether the middle of an item is a merge target rather than an edge.
   *  Without `onCombine` it is inert. Default false. */
  combine?: boolean;
  /** The last word on whether a drop lands here, asked per pointer position
   *  and again at the drop. It can only *refuse* what `group`/`accept`
   *  already matched — see the header. */
  canDrop?: (query: ReorderDropQuery) => boolean;
  /** Foreign payloads the list takes, in core's `dropAccept` vocabulary —
   *  `['files']`, `'text/plain'`, a predicate. Without it every drag that is
   *  not a list item is refused. */
  accept?: DropAccept;
  /** A foreign payload landed, at `index`. */
  onDrop?: (drop: ReorderDrop) => void;
  /** The drag started: a press past the threshold, or a keyboard lift. */
  onDragStart?: (ev: ReorderDragStart) => void;
  /** Where the drag is now — one per pointer position that changed the
   *  answer, and one per keyboard step. */
  onDragUpdate?: (ev: ReorderDragUpdate) => void;
  /** The gesture is over, after the change events. */
  onDragEnd?: (ev: ReorderDragEnd) => void;
  /**
   * The ghost that follows the pointer while an item is held.
   *
   * `'auto'` (the default, and what `true` means) is a `<popup>`: a window
   * of its own, so it follows the pointer out of the list, out of the
   * window, and over other applications, on either backend.
   *
   * `'inline'` draws it as a box inside the list instead — no second window
   * per drag, which a remote display may prefer, at the cost of a ghost
   * that stops at the window's edge and cannot paint over anything outside
   * its own list's parent. `false` leaves only the cursor and the
   * indicator.
   */
  preview?: boolean | 'auto' | 'popup' | 'inline';
  /** What the ghost shows. Default: the item's children again, on a card. */
  renderPreview?: (state: ReorderItemState) => ReactNode;
  /** How big the ghost is. Default: the item's own size. */
  previewSize?: ReorderPreviewSize;
  /** Whether the ghost flies to where the item landed instead of vanishing,
   *  and for how long (default 180ms). Off under the desktop's reduced
   *  motion, whatever this says. */
  dropAnimation?: boolean | number;
  styles?: ReorderStyles;
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

export interface ReorderItemProps {
  id: ReorderId;
  /** Not draggable and not liftable — but still a slot others land beside. */
  disabled?: boolean;
  /** Offered beside the reorder payload, for other targets in the app and
   *  for other applications — core's `dragData`, thunks and all. */
  dragData?: DragSourceProps['dragData'];
  /** What the drag offers. Default `['move']`; `['copy']` makes this list a
   *  palette — the item stays, and the list that takes it gets
   *  `onInsert({ action: 'copy' })`. */
  dragActions?: Array<'copy' | 'move' | 'link'>;
  /** Let a press on a control inside the item start a drag anyway. Off by
   *  default, so a text field, a slider or a button inside a card keeps the
   *  press — see the header. Moot when the item has a handle. */
  dragFromInteractive?: boolean;
  /** What a screen reader calls the item. Default: its own text. */
  'aria-label'?: string;
  style?: StyleInput;
  'data-testname'?: string;
  /** The content — or a function of the item's state, for content that
   *  reacts to the drag. `useReorderItem()` is the same thing for a
   *  component deeper inside. */
  children?: ReactNode | ((state: ReorderItemState) => ReactNode);
}

export interface ReorderHandleProps {
  /** Default "Drag to reorder". */
  'aria-label'?: string;
  style?: StyleInput;
  'data-testname'?: string;
  /** Default: a grip of six dots. */
  children?: ReactNode;
}

// --- shared state -----------------------------------------------------------

/** The live payload behind an item's drag. A thunk hands it over at the
 *  drop, by reference, so the list that takes it can write `to` here and the
 *  source's `onDragEnd` — which core fires last, with no destination — can
 *  report it. */
interface Payload {
  listUid: string;
  list: string | undefined;
  id: ReorderId;
  ids: ReorderId[];
  index: number;
  to?: {
    listUid: string;
    list: string | undefined;
    index: number;
    combine: ReorderId | null;
  };
}

/** Where the pointer is, as the list under it sees things. */
interface DragOver {
  listUid: string;
  list: string | undefined;
  index: number;
  combine: ReorderId | null;
}

/**
 * The gesture's scratchpad — see the header. Written by whichever list the
 * pointer is over, read by the source's own `onDrag`, and null between
 * gestures. One drag at a time is a property of the pointer, not an
 * assumption this makes.
 */
let activeDrag: { payload: Payload; over: DragOver | null } | null = null;

/** One item, as the list sees it. */
interface Entry {
  id: ReorderId;
  node: RefObject<DrawnNode | null>;
  setMark: (mark: { edge: ReorderEdge; combine: boolean } | null) => void;
  focus: () => void;
  label: () => string;
}

/** What the list marked, and on which item. */
interface Mark {
  id: ReorderId;
  edge: ReorderEdge;
  combine: boolean;
}

interface ListShared {
  uid: string;
  id: string | undefined;
  type: string;
  orientation: ReorderOrientation;
  disabled: boolean;
  preview: 'auto' | 'popup' | 'inline' | false;
  renderPreview: ((state: ReorderItemState) => ReactNode) | undefined;
  previewSize: ReorderPreviewSize | undefined;
  dropMs: number;
  styles: ReorderStyles | undefined;
  liftedId: ReorderId | null;
  register(entry: Entry): () => void;
  order(): ReorderId[];
  movingIds(id: ReorderId): ReorderId[];
  lift(id: ReorderId): void;
  drop(): void;
  cancel(): void;
  step(id: ReorderId, where: -1 | 1 | 'home' | 'end'): void;
  focusNeighbour(id: ReorderId, delta: -1 | 1): void;
  dragStarted(id: ReorderId): { index: number; ids: ReorderId[] };
  dragMoved(id: ReorderId): void;
  dragEnded(id: ReorderId, ev: DragEndEvent, payload: Payload | null): void;
}

const ListContext = React.createContext<ListShared | null>(null);

function useList(part: string): ListShared {
  const list = useContext(ListContext);
  if (!list) {
    throw new Error(
      `@react-x11/components: <${part}> has to be inside a <ReorderList>.`,
    );
  }
  return list;
}

/** What an item lends its handle and its content: the drag, the keys, the
 *  look, and the state. */
interface ItemShared {
  state: ReorderItemState;
  disabled: boolean;
  dragProps: DragSourceProps;
  onKeyDown: (ev: KeyboardEvent) => void;
  onBlur: () => void;
  styles: ReorderStyles | undefined;
  attachHandle(ref: RefObject<DrawnNode | null>): () => void;
}

const ItemContext = React.createContext<ItemShared | null>(null);

/**
 * The state of the `<ReorderItem>` a component is rendered inside — what
 * function `children` are handed, for a component deeper in the item. Reads
 * `preview` to tell the ghost's copy from the item in the list.
 */
export function useReorderItem(): ReorderItemState {
  const item = useContext(ItemContext);
  if (!item) {
    throw new Error(
      '@react-x11/components: useReorderItem() has to be called inside a <ReorderItem>.',
    );
  }
  return item.state;
}

const NO_DRAG: DragSourceProps = {};

const noop = (): void => {};
const detachNoop = (): (() => void) => noop;

/** What the preview's copy of the children is handed: the state with
 *  `preview` set, and a handle rendered in the ghost draws its grip and does
 *  nothing else — it is a picture of one. */
function inertItem(
  state: ReorderItemState,
  styles: ReorderStyles | undefined,
): ItemShared {
  return {
    state,
    disabled: true,
    dragProps: NO_DRAG,
    onKeyDown: noop,
    onBlur: noop,
    styles,
    attachHandle: detachNoop,
  };
}

// --- helpers ----------------------------------------------------------------

/** What `DrawnNode` does not declare and a drag has to read: the display
 *  scale `abs` is in, and the props a press landed on. The same widening
 *  `<Tabs>` makes to measure its strip: a ref's public contract is geometry
 *  and focus. */
interface OpaqueNode {
  scale?: number;
  props?: Record<string, unknown>;
}

function scaleOf(node: DrawnNode | null): number {
  const scale = (node as (DrawnNode & OpaqueNode) | null)?.scale;
  return scale && scale > 0 ? scale : 1;
}

/**
 * The elements and roles a press belongs to rather than to the item around
 * them. Roles rather than kinds wherever core's own widgets have one, so an
 * app's `<Button>`, `<Slider>` or `<Switch>` is covered without this
 * knowing what they are made of; kinds for the text elements, which are
 * elements rather than compositions.
 */
const INTERACTIVE_KINDS = new Set(['textinput', 'textarea', 'codeeditor']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

/** Was this press on a control, somewhere between the hit node and the item
 *  around it? */
function pressedControl(
  target: DrawnNode | null,
  item: DrawnNode | null,
): boolean {
  for (let n: DrawnNode | null = target; n; n = n.parent) {
    if (INTERACTIVE_KINDS.has(n.kind)) return true;
    const role = (n as DrawnNode & OpaqueNode).props?.role;
    if (typeof role === 'string' && INTERACTIVE_ROLES.has(role)) return true;
    if (n === item) break;
  }
  return false;
}

/** Every piece of text under a node, joined — what an item is called when
 *  it has no `aria-label`. `textContent()` answers for one node; a card is
 *  several. */
function labelOf(node: DrawnNode | null): string {
  if (!node) return 'item';
  const parts: string[] = [];
  const walk = (n: DrawnNode): void => {
    const text = n.textContent();
    if (text) parts.push(text);
    for (const child of n.children) walk(child);
  };
  walk(node);
  const label = parts.join(' ').trim();
  return label || 'item';
}

/**
 * The list's `dropAccept`: its own scope, plus whatever the app's `accept`
 * says. An array gains the scope and a predicate is or-ed with it, so
 * core's own group matching (`'files'`, `'text'`, `'uris'`) keeps applying
 * to the foreign half — nothing about accept vocabulary is re-implemented
 * here.
 */
function widenAccept(accept: DropAccept | undefined, type: string): DropAccept {
  if (accept === undefined) return [type];
  if (typeof accept === 'function') {
    return (types: string[]) => types.includes(type) || Boolean(accept(types));
  }
  return [...(Array.isArray(accept) ? accept : [accept]), type];
}

/** Whether the app's `accept` — on its own, without the list's scope —
 *  takes what is on offer. `ev.has` is core's alias-aware test, which is
 *  what keeps the semantic groups core's to define. */
function foreignAccepted(
  accept: DropAccept | undefined,
  ev: DragEvent,
): boolean {
  if (accept === undefined) return false;
  if (typeof accept === 'function') return Boolean(accept(ev.types));
  return (Array.isArray(accept) ? accept : [accept]).some((want) =>
    ev.has(want),
  );
}

function refuse(): boolean {
  return false;
}

function sameOver(a: DragOver | null, b: DragOver | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.listUid === b.listUid && a.index === b.index && a.combine === b.combine
  );
}

/** Ease-out cubic — the curve core's own transitions use. */
function ease(t: number): number {
  return 1 - (1 - t) ** 3;
}

// --- the list ---------------------------------------------------------------

/**
 * `<ReorderList onReorder>` around `<ReorderItem id>`s.
 *
 *   <ReorderList onReorder={(e) => setTodos((l) => arrayMove(l, e.from, e.to))}>
 *     {todos.map((t) => (
 *       <ReorderItem key={t.id} id={t.id}><text>{t.title}</text></ReorderItem>
 *     ))}
 *   </ReorderList>
 *
 * The order is read from the tree the list rendered, so it is written once —
 * there is no `items` array to keep beside the children.
 */
export function ReorderList(props: ReorderListProps): ReactElement {
  const {
    id,
    group,
    orientation = 'vertical',
    disabled = false,
    selected,
    onReorder,
    onInsert,
    onRemove,
    onCombine,
    combine = false,
    canDrop,
    accept,
    onDrop,
    onDragStart,
    onDragUpdate,
    onDragEnd,
    preview = 'auto',
    renderPreview,
    previewSize,
    dropAnimation = true,
    styles,
    style,
    'data-testname': testname,
    children,
  } = props;

  const uid = React.useId();
  const type = scopedType(
    group !== undefined ? `group:${group}` : `list:${uid}`,
  );
  const { reducedMotion } = useSystemAppearance();
  const rootRef = useRef<DrawnNode | null>(null);
  const entries = useRef(new Map<ReorderId, Entry>());
  /** The item showing the indicator, and how. */
  const marked = useRef<Mark | null>(null);
  /** The item of *this* list the pointer is dragging, if any. */
  const dragging = useRef<ReorderId | null>(null);
  /** What the last `onDragUpdate` said, so one is not sent per motion. */
  const reportedOver = useRef<DragOver | null>(null);
  /** Whether one of this list's own items is being dragged. State rather
   *  than a ref because the root's stacking depends on it — set twice a
   *  gesture, not per motion. */
  const [holding, setHolding] = useState(false);
  const [lifted, setLifted] = useState<{
    id: ReorderId;
    ids: ReorderId[];
    origin: ReorderId[];
  } | null>(null);
  const liftedRef = useRef(lifted);
  liftedRef.current = lifted;

  // The handlers by ref, so the context value — and with it every item —
  // does not re-render because an app wrote an inline arrow.
  const handlers = useRef({
    onReorder,
    onInsert,
    onRemove,
    onCombine,
    onDrop,
    onDragStart,
    onDragUpdate,
    onDragEnd,
    canDrop,
    accept,
    selected,
    combine,
  });
  handlers.current = {
    onReorder,
    onInsert,
    onRemove,
    onCombine,
    onDrop,
    onDragStart,
    onDragUpdate,
    onDragEnd,
    canDrop,
    accept,
    selected,
    combine,
  };

  /**
   * The ids in tree order — the order the app rendered the items in. A
   * walk of the root's retained children, stopping at each item, so a
   * wrapper around an item costs nothing and an item inside an item is not
   * a thing.
   */
  const order = useCallback((): ReorderId[] => {
    const root = rootRef.current;
    if (!root) return [];
    const byNode = new Map<DrawnNode, ReorderId>();
    for (const entry of entries.current.values()) {
      if (entry.node.current) byNode.set(entry.node.current, entry.id);
    }
    const out: ReorderId[] = [];
    const walk = (n: DrawnNode): void => {
      const found = byNode.get(n);
      if (found !== undefined) {
        out.push(found);
        return;
      }
      for (const child of n.children) walk(child);
    };
    for (const child of root.children) walk(child);
    return out;
  }, []);

  /** What travels when this item is picked up: the selection, in the list's
   *  own order, when the item is in it — and just the item otherwise. */
  const movingIds = useCallback(
    (itemId: ReorderId): ReorderId[] => {
      const set = handlers.current.selected;
      if (!set?.length || !set.includes(itemId)) return [itemId];
      const chosen = new Set(set);
      const ids = order().filter((x) => chosen.has(x));
      return ids.length ? ids : [itemId];
    },
    [order],
  );

  /** The items' boxes in logical pixels — `abs` is device, and the pointer
   *  in a drag event is not. One division, here. */
  const rectsOf = (ids: readonly ReorderId[]): ReorderRect[] => {
    const scale = scaleOf(rootRef.current);
    return ids.map((itemId) => {
      const node = entries.current.get(itemId)?.node.current;
      const { x, y, width, height } = node?.abs ?? {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      };
      return {
        x: x / scale,
        y: y / scale,
        width: width / scale,
        height: height / scale,
      };
    });
  };

  /** Move the indicator: clear the item that had it, set the one that does. */
  const mark = (next: Mark | null): void => {
    const prev = marked.current;
    const same =
      prev !== null &&
      next !== null &&
      prev.id === next.id &&
      prev.edge === next.edge &&
      prev.combine === next.combine;
    if (same) return;
    if (prev) entries.current.get(prev.id)?.setMark(null);
    if (next) {
      entries.current
        .get(next.id)
        ?.setMark({ edge: next.edge, combine: next.combine });
    }
    marked.current = next;
  };

  /** Where a drag event's pointer would land. */
  const slotFor = (
    ev: DragEvent,
    moving: readonly ReorderId[],
  ): { ids: ReorderId[]; slot: number; at: Mark | null } => {
    const ids = order();
    const hit = closestSlot(
      rectsOf(ids),
      { x: ev.x, y: ev.y },
      orientation,
      rootRef.current?.direction ?? 'ltr',
      handlers.current.combine ? COMBINE_BAND : 0,
    );
    if (!hit) return { ids, slot: 0, at: null };
    const over = ids[hit.index]!;
    // an item cannot merge into itself, nor into anything travelling with it
    if (hit.combine && !moving.includes(over)) {
      return {
        ids,
        slot: hit.slot,
        at: { id: over, edge: hit.edge, combine: true },
      };
    }
    // The mark comes from the **slot**, not from the item the slot was read
    // off: the lower half of one item and the upper half of the next are the
    // same gap, and a mark keyed to the item would draw that one insertion
    // point in two places and flip between them mid-gap. See `slotMark`.
    const line = slotMark(ids.length, hit.slot);
    return {
      ids,
      slot: hit.slot,
      at: line && { id: ids[line.index]!, edge: line.edge, combine: false },
    };
  };

  /** What the payload of a drag is, when it is one of ours. */
  const payloadOf = (ev: DragEvent): Payload | null => {
    const items = (ev as Partial<DropEvent>).items;
    const found = items?.[type];
    return found && typeof found === 'object' ? (found as Payload) : null;
  };

  /** The live payload while the pointer is merely *over* us: a `DragEvent`
   *  carries no `items`, so the scratchpad is the only way to know whose
   *  item this is — see the header. */
  const hoveringPayload = (ev: DragEvent): Payload | null => {
    if (!ev.types.includes(type)) return null;
    return payloadOf(ev) ?? activeDrag?.payload ?? null;
  };

  const allowed = (
    ev: DragEvent,
    payload: Payload | null,
    slot: number,
    combining: ReorderId | null,
  ): boolean => {
    const ask = handlers.current.canDrop;
    if (!ask) return true;
    return Boolean(
      ask({
        id: payload?.id,
        ids: payload?.ids ?? [],
        source: payload ? { list: payload.list, index: payload.index } : null,
        index: slot,
        combine: combining,
        event: ev,
      }),
    );
  };

  const onDragOver = (ev: DragEvent): void => {
    // `onDragOver` reaches every node on the path under the pointer, matched
    // or not — so a list has to ask the question `dropAccept` already
    // answered before it promises a slot to a drag it will never be given
    const payload = hoveringPayload(ev);
    if (!payload && !foreignAccepted(handlers.current.accept, ev)) {
      mark(null);
      return;
    }
    const moving = payload?.listUid === uid ? payload.ids : [];
    const { ids, slot, at } = slotFor(ev, moving);
    const combining = at?.combine ? at.id : null;
    if (!allowed(ev, payload, slot, combining)) {
      mark(null);
      if (activeDrag?.over?.listUid === uid) activeDrag.over = null;
      // core keeps the node its `dropAccept` matched; what a handler may do
      // is refuse this position, which is what turns the ghost's `accepted`
      // off and what `canDrop` means
      ev.reject();
      return;
    }
    // one of this list's own items, over a gap that is already its own:
    // nothing would move, so nothing is promised
    const move =
      !combining && moving.length > 0
        ? moveManyToSlot(ids, moving, slot, payload!.id)
        : null;
    if (!combining && moving.length > 0 && move === null) {
      mark(null);
      if (activeDrag?.over?.listUid === uid) activeDrag.over = null;
      return;
    }
    mark(at);
    if (activeDrag) {
      activeDrag.over = {
        listUid: uid,
        list: id,
        // where it would land, not the gap it is over — a same-list move
        // closes the hole it left behind, and a newcomer lands at the gap
        index: move ? move.to : slot,
        combine: combining,
      };
    }
  };

  const onDragLeave = (): void => {
    mark(null);
    if (activeDrag?.over?.listUid === uid) activeDrag.over = null;
  };

  const onDropHere = (ev: DropEvent): void => {
    mark(null);
    const payload = payloadOf(ev);
    const moving = payload?.listUid === uid ? payload.ids : [];
    const { ids, slot, at } = slotFor(ev, moving);
    const combining = at?.combine ? at.id : null;
    if (!allowed(ev, payload, slot, combining)) {
      ev.reject();
      return;
    }
    if (payload) {
      // a copy leaves the source's item where it is; anything else moves it
      const action = ev.action === 'copy' ? 'copy' : 'move';
      payload.to = { listUid: uid, list: id, index: slot, combine: combining };
      if (combining !== null) {
        ev.accept(action);
        handlers.current.onCombine?.({
          id: payload.id,
          ids: payload.ids,
          into: combining,
          index: ids.indexOf(combining),
          source: { list: payload.list, index: payload.index },
          event: ev,
        });
        return;
      }
      if (payload.listUid === uid) {
        // a list does not duplicate into itself: a same-list drop reorders
        const move = moveManyToSlot(ids, payload.ids, slot, payload.id);
        payload.to.index = move ? move.to : payload.index;
        ev.accept('move');
        if (move) {
          handlers.current.onReorder?.({
            items: move.items,
            id: payload.id,
            ids: move.ids,
            from: move.from,
            to: move.to,
          });
        }
        return;
      }
      ev.accept(action);
      handlers.current.onInsert?.({
        items: insertManyAtSlot(ids, payload.ids, slot),
        id: payload.id,
        ids: payload.ids,
        index: slot,
        action,
        source: { list: payload.list, index: payload.index },
        event: ev,
      });
      return;
    }
    // Not a live list item: files, text, another application's drag — or
    // the scope type from another process, which is JSON by then and not
    // ours to act on. The app's `accept` alone decides.
    if (!foreignAccepted(handlers.current.accept, ev)) {
      ev.reject();
      return;
    }
    handlers.current.onDrop?.({ index: slot, event: ev });
  };

  // --- the keyboard's half, lent to the items ------------------------------

  const labelFor = (itemId: ReorderId): string =>
    entries.current.get(itemId)?.label() ?? 'item';

  const lift = useCallback(
    (itemId: ReorderId): void => {
      const ids = order();
      const moving = movingIds(itemId);
      setLifted({ id: itemId, ids: moving, origin: ids });
      const at = ids.indexOf(itemId) + 1;
      handlers.current.onDragStart?.({
        id: itemId,
        ids: moving,
        index: at - 1,
        input: 'keyboard',
      });
      announce(SAY.lifted(labelFor(itemId), at, ids.length, moving.length));
    },
    [order, movingIds],
  );

  const drop = useCallback((): void => {
    const current = liftedRef.current;
    if (!current) return;
    setLifted(null);
    const ids = order();
    const at = ids.indexOf(current.id);
    handlers.current.onDragEnd?.({
      id: current.id,
      ids: current.ids,
      from: current.origin.indexOf(current.id),
      to: { list: id, index: at },
      combine: null,
      reason: 'drop',
      input: 'keyboard',
    });
    announce(SAY.dropped(labelFor(current.id), at + 1, ids.length));
  }, [id, order]);

  const cancel = useCallback((): void => {
    const current = liftedRef.current;
    if (!current) return;
    setLifted(null);
    const ids = order();
    const from = ids.indexOf(current.id);
    const to = current.origin.indexOf(current.id);
    if (from >= 0 && to >= 0 && from !== to) {
      const back = moveManyToSlot(
        ids,
        current.ids,
        to + (to > from ? 1 : 0),
        current.id,
      );
      if (back) {
        handlers.current.onReorder?.({
          items: back.items,
          id: current.id,
          ids: back.ids,
          from: back.from,
          to: back.to,
        });
      }
    }
    handlers.current.onDragEnd?.({
      id: current.id,
      ids: current.ids,
      from,
      to: null,
      combine: null,
      reason: 'cancel',
      input: 'keyboard',
    });
    announce(SAY.cancelled(labelFor(current.id), (to >= 0 ? to : from) + 1));
  }, [order]);

  const step = useCallback(
    (itemId: ReorderId, where: -1 | 1 | 'home' | 'end'): void => {
      const current = liftedRef.current;
      const ids = order();
      const from = ids.indexOf(itemId);
      if (from < 0) return;
      const moving = current?.ids ?? [itemId];
      const set = new Set(moving);
      const held = ids
        .map((x, i) => (set.has(x) ? i : -1))
        .filter((i) => i >= 0);
      // A step moves the whole run **past its next neighbour**, which for one
      // item is the ordinary "swap with the one below". `from + 1` would be
      // inside the run itself for a multi-drag, and land it where it already
      // is — the shape of that bug is a selection that will not move.
      let slot: number;
      if (where === 'home') slot = 0;
      else if (where === 'end') slot = ids.length;
      else if (where === 1) {
        const last = held.at(-1) ?? from;
        const next = ids.findIndex((x, i) => i > last && !set.has(x));
        if (next < 0) return;
        slot = next + 1;
      } else {
        const first = held[0] ?? from;
        let prev = -1;
        for (let i = first - 1; i >= 0; i--) {
          if (!set.has(ids[i]!)) {
            prev = i;
            break;
          }
        }
        if (prev < 0) return;
        slot = prev;
      }
      const move = moveManyToSlot(ids, moving, slot, itemId);
      if (!move) return;
      handlers.current.onReorder?.({
        items: move.items,
        id: itemId,
        ids: move.ids,
        from: move.from,
        to: move.to,
      });
      handlers.current.onDragUpdate?.({
        id: itemId,
        ids: move.ids,
        from,
        over: { list: id, index: move.to },
        combine: null,
        input: 'keyboard',
      });
      announce(SAY.moved(labelFor(itemId), move.to + 1, ids.length));
    },
    [id, order],
  );

  const focusNeighbour = useCallback(
    (itemId: ReorderId, delta: -1 | 1) => {
      const ids = order();
      const next = ids[ids.indexOf(itemId) + delta];
      if (next !== undefined) entries.current.get(next)?.focus();
    },
    [order],
  );

  const register = useCallback((entry: Entry): (() => void) => {
    entries.current.set(entry.id, entry);
    return () => {
      if (entries.current.get(entry.id) === entry) {
        entries.current.delete(entry.id);
      }
      if (marked.current?.id === entry.id) marked.current = null;
    };
  }, []);

  const dragStarted = useCallback(
    (itemId: ReorderId): { index: number; ids: ReorderId[] } => {
      dragging.current = itemId;
      setHolding(true);
      // a pointer drag and a keyboard lift are one gesture's worth of state
      if (liftedRef.current) setLifted(null);
      reportedOver.current = null;
      const ids = order();
      const moving = movingIds(itemId);
      const index = ids.indexOf(itemId);
      handlers.current.onDragStart?.({
        id: itemId,
        ids: moving,
        index,
        input: 'pointer',
      });
      announce(
        SAY.pickedUp(labelFor(itemId), index + 1, ids.length, moving.length),
      );
      return { index, ids: moving };
    },
    [order, movingIds],
  );

  /** One pointer position, on the source's side: core tells the target
   *  first, so the scratchpad is already up to date here. */
  const dragMoved = useCallback((itemId: ReorderId): void => {
    const over = activeDrag?.over ?? null;
    if (sameOver(over, reportedOver.current)) return;
    reportedOver.current = over;
    const payload = activeDrag?.payload;
    handlers.current.onDragUpdate?.({
      id: itemId,
      ids: payload?.ids ?? [itemId],
      from: payload?.index ?? -1,
      over: over ? { list: over.list, index: over.index } : null,
      combine: over?.combine ?? null,
      input: 'pointer',
    });
  }, []);

  const dragEnded = useCallback(
    (itemId: ReorderId, ev: DragEndEvent, payload: Payload | null): void => {
      dragging.current = null;
      reportedOver.current = null;
      setHolding(false);
      mark(null);
      const to = payload?.to;
      const moved = ev.dropped && ev.action === 'move';
      const ids = order();
      // a move within this list has already been reported as a reorder
      const elsewhere = moved && !(to && to.listUid === uid);
      if (elsewhere) {
        handlers.current.onRemove?.({
          items: ids.filter((x) => !(payload?.ids ?? [itemId]).includes(x)),
          id: itemId,
          ids: payload?.ids ?? [itemId],
          index: ids.indexOf(itemId),
          to: to ? { list: to.list, index: to.index } : null,
          event: ev,
        });
      }
      handlers.current.onDragEnd?.({
        id: itemId,
        ids: payload?.ids ?? [itemId],
        from: payload?.index ?? -1,
        to: ev.dropped && to ? { list: to.list, index: to.index } : null,
        combine: to?.combine ?? null,
        reason: ev.dropped ? 'drop' : 'cancel',
        input: 'pointer',
      });
      const label = labelFor(itemId);
      if (!ev.dropped) announce(SAY.returned(label));
      else if (to?.combine != null) {
        announce(SAY.combined(label, labelFor(to.combine)));
      } else if (to && to.listUid === uid) {
        announce(SAY.dropped(label, to.index + 1, ids.length));
      } else if (to) announce(SAY.droppedInto(label, to.list));
    },
    [uid, order],
  );

  const shared = useMemo<ListShared>(
    () => ({
      uid,
      id,
      type,
      orientation,
      disabled,
      preview: preview === true ? 'auto' : preview,
      renderPreview,
      previewSize,
      dropMs:
        reducedMotion || dropAnimation === false
          ? 0
          : dropAnimation === true
            ? DROP_MS
            : dropAnimation,
      styles,
      liftedId: lifted?.id ?? null,
      register,
      order,
      movingIds,
      lift,
      drop,
      cancel,
      step,
      focusNeighbour,
      dragStarted,
      dragMoved,
      dragEnded,
    }),
    [
      uid,
      id,
      type,
      orientation,
      disabled,
      preview,
      renderPreview,
      previewSize,
      dropAnimation,
      reducedMotion,
      styles,
      lifted,
      register,
      order,
      movingIds,
      lift,
      drop,
      cancel,
      step,
      focusNeighbour,
      dragStarted,
      dragMoved,
      dragEnded,
    ],
  );

  const dropAccept = useMemo<DropAccept>(
    () => (disabled ? refuse : widenAccept(accept, type)),
    [accept, type, disabled],
  );

  /** Whether this list's ghost is a box in the window rather than a popup:
   *  the only case where the root's own stacking matters. */
  const inlineGhost = preview === 'inline';

  return hx(
    'box',
    {
      ref: rootRef,
      role: 'list',
      'aria-orientation': orientation,
      'data-testname': testname,
      dropAccept,
      onDragOver: disabled ? undefined : onDragOver,
      onDragLeave: disabled ? undefined : onDragLeave,
      onDrop: disabled ? undefined : onDropHere,
      style: [
        { flexDirection: orientation === 'horizontal' ? 'row' : 'column' },
        style,
        // An in-window ghost is a box inside this list, and `zIndex` only
        // sorts among siblings — so the list itself has to come forward, or
        // the ghost paints under the next list along. See the header.
        holding && inlineGhost ? { zIndex: 1 } : null,
      ],
    },
    h(ListContext.Provider, { value: shared }, children),
  );
}

// --- the item ---------------------------------------------------------------

/** The item's own look, under its `style`. */
function itemStyle(state: ReorderItemState, hasHandle: boolean): Style {
  return { cursor: state.disabled || hasHandle ? undefined : 'grab' };
}

/** An item drawing a ghost of its own has to paint over its neighbours, or
 *  the copy following the pointer slides under the next row down. */
function liftStyle(lifted: boolean): Style | null {
  return lifted ? { zIndex: 3 } : null;
}

/**
 * What a lifted or dragging item wears — the wash the palette already has
 * for "this one", the way a hovered row does. It sits *over* the item's
 * `style`, the way a `:hover` block would: it is state, not look, and an
 * app that painted its rows `$surface` still gets to see which one it is
 * holding. `styles.item(state)` merges over this, so it stays the seam.
 */
function washStyle(state: ReorderItemState, theme: Theme): Style | null {
  return state.lifted || state.dragging
    ? { backgroundColor: theme.surfaceHover }
    : null;
}

/** The line at an edge: across the item and centred on the edge, inside the
 *  item so a scrolling list carries it, logical edges so RTL costs nothing.
 *  A combining item is outlined instead — the drop lands *on* it, and a line
 *  beside it would say the opposite. */
function indicatorStyle(
  mark: { edge: ReorderEdge; combine: boolean },
  orientation: ReorderOrientation,
  theme: Theme,
): Style {
  const base: Style = {
    position: 'absolute',
    zIndex: 1,
    pointerEvents: 'none',
  };
  if (mark.combine) {
    return {
      ...base,
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      borderWidth: INDICATOR,
      borderColor: theme.accent,
      borderRadius: theme.radius,
    };
  }
  const line: Style = { ...base, backgroundColor: theme.accent };
  if (orientation === 'vertical') {
    return {
      ...line,
      left: 0,
      right: 0,
      height: INDICATOR,
      ...(mark.edge === 'before'
        ? { top: -INDICATOR / 2 }
        : { bottom: -INDICATOR / 2 }),
    };
  }
  return {
    ...line,
    top: 0,
    bottom: 0,
    width: INDICATOR,
    ...(mark.edge === 'before'
      ? { start: -INDICATOR / 2 }
      : { end: -INDICATOR / 2 }),
  };
}

/** The card the default preview draws the item on: a surface with a hairline
 *  so it reads as lifted off the list, whatever the list's own ground is. */
function previewStyle(theme: Theme): Style {
  return {
    flexGrow: 1,
    backgroundColor: theme.surface,
    borderWidth: theme.borderWidth,
    borderColor: theme.border,
    borderRadius: theme.radius,
  };
}

/** The badge a multi-drag's ghost wears: how many are travelling. */
function badgeStyle(theme: Theme): Style {
  return {
    position: 'absolute',
    top: -8,
    end: -8,
    minWidth: 18,
    paddingLeft: 5,
    paddingRight: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    backgroundColor: theme.accent,
  };
}

/**
 * `<ReorderItem id>` — one item. Draggable by any part of itself, unless a
 * `<ReorderHandle>` inside it takes that over; a tab stop, with the keyboard
 * model on it, for the same "unless".
 */
export function ReorderItem(props: ReorderItemProps): ReactElement {
  const {
    id,
    disabled: ownDisabled = false,
    dragData,
    dragActions,
    dragFromInteractive = false,
    'aria-label': ariaLabel,
    style,
    'data-testname': testname,
    children,
  } = props;
  const list = useList('ReorderItem');
  const theme = useTheme();
  const nodeRef = useRef<DrawnNode | null>(null);
  const handleRef = useRef<RefObject<DrawnNode | null> | null>(null);
  const [mark, setMark] = useState<{
    edge: ReorderEdge;
    combine: boolean;
  } | null>(null);
  const [hasHandle, setHasHandle] = useState(false);
  const disabled = ownDisabled || list.disabled;
  const lifted = list.liftedId === id;
  const liftedRef = useRef(lifted);
  liftedRef.current = lifted;

  /** The live payload, from the press that started a drag to its end. */
  const payload = useRef<Payload | null>(null);
  /** Where in the item the press landed, so the ghost appears under it
   *  rather than jumping to the cursor; and how big the item was. */
  const grab = useRef({ x: 0, y: 0, width: 0, height: 0 });
  /** What the press landed on, for the interactive-element question, and
   *  where the window is on screen, for the drop flight. */
  const pressed = useRef<DrawnNode | null>(null);
  const windowOrigin = useRef({ x: 0, y: 0 });
  /** Where the ghost was last seen, in screen coordinates, and where the
   *  landing copy is now — an offset from the item's own origin, easing to
   *  nothing. */
  const lastGhost = useRef<{ x: number; y: number } | null>(null);
  const [flight, setFlight] = useState<{ x: number; y: number } | null>(null);
  const ticks = useRef<{ layout: LayoutTick; timer: DelayTick }>({
    layout: null,
    timer: null,
  });

  const label = useCallback(
    (): string => ariaLabel ?? labelOf(nodeRef.current),
    [ariaLabel],
  );

  useEffect(
    () =>
      list.register({
        id,
        node: nodeRef,
        setMark,
        focus: () => {
          (handleRef.current?.current ?? nodeRef.current)?.focus();
        },
        label,
      }),
    [id, list.register, label],
  );

  /** Nothing may outlive the item: a flight tick that fires after unmount
   *  would set state on a component that is gone. */
  useEffect(
    () => () => {
      cancelAfterLayout(ticks.current.layout);
      cancelLater(ticks.current.timer);
    },
    [],
  );

  /**
   * Fly a copy of the item from where the pointer let go to where the item
   * landed, then let it go.
   *
   * Two things make this the shape it is. The landing place is only real
   * once the layout that moved the item has run — hence the tick — and the
   * copy travels in the *item's own* coordinates, as an offset easing to
   * zero, so it is a box inside the list rather than a window over it (see
   * the header). The screen point the pointer let go at is turned into that
   * offset here, which is the only thing the window's origin is needed for.
   */
  const flyHome = useCallback(
    (from: { x: number; y: number }, ms: number): void => {
      ticks.current.layout = afterLayout(() => {
        ticks.current.layout = null;
        const node = nodeRef.current;
        if (!node) {
          setFlight(null);
          return;
        }
        const scale = scaleOf(node);
        const dx = from.x - (windowOrigin.current.x + node.abs.x / scale);
        const dy = from.y - (windowOrigin.current.y + node.abs.y / scale);
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
          setFlight(null);
          return;
        }
        const started = Date.now();
        const stepOn = (): void => {
          const t = Math.min((Date.now() - started) / ms, 1);
          if (t >= 1) {
            ticks.current.timer = null;
            setFlight(null);
            return;
          }
          const left = 1 - ease(t);
          setFlight({ x: dx * left, y: dy * left });
          ticks.current.timer = later(stepOn, FLIGHT_STEP_MS);
        };
        stepOn();
      });
    },
    [],
  );

  const { dragProps, isDragging, position } = useDragSource({
    data: { [list.type]: () => payload.current, ...dragData },
    actions: dragActions ?? ['move'],
    onDragStart: (ev: DragSourceEvent) => {
      // A press on a control inside the item belongs to the control, not to
      // the item around it — core arms from the nearest draggable ancestor,
      // so this is the layer's own answer. Cancelling here leaves the
      // gesture as ordinary mouse events, which is what the control wanted.
      if (
        !dragFromInteractive &&
        !hasHandle &&
        pressedControl(pressed.current, nodeRef.current)
      ) {
        ev.preventDefault();
        return;
      }
      const node = nodeRef.current;
      const scale = scaleOf(node);
      if (node) {
        const { x, y, width, height } = node.abs;
        grab.current = {
          x: ev.x - x / scale,
          y: ev.y - y / scale,
          width: width / scale,
          height: height / scale,
        };
      }
      // the window's own origin on screen, which the ghost's flight home
      // needs and no ref reports: the same point in both spaces, once.
      windowOrigin.current = { x: ev.screenX - ev.x, y: ev.screenY - ev.y };
      const { index, ids } = list.dragStarted(id);
      payload.current = {
        listUid: list.uid,
        list: list.id,
        id,
        ids,
        index,
      };
      activeDrag = { payload: payload.current, over: null };
    },
    onDrag: () => list.dragMoved(id),
    onDragEnd: (ev: DragEndEvent) => {
      const carried = payload.current;
      payload.current = null;
      activeDrag = null;
      const from = lastGhost.current;
      lastGhost.current = null;
      list.dragEnded(id, ev, carried);
      if (from && list.dropMs > 0 && list.preview) flyHome(from, list.dropMs);
    },
  });

  // --- the keyboard --------------------------------------------------------

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (disabled) return;
    const key = ev.keysym;
    const rtl = nodeRef.current?.direction === 'rtl';
    const [prev, next] =
      list.orientation === 'vertical'
        ? [XK_UP, XK_DOWN]
        : rtl
          ? [XK_RIGHT, XK_LEFT]
          : [XK_LEFT, XK_RIGHT];
    const isLifted = liftedRef.current;
    if (key === XK_RETURN || ev.codepoint === 32) {
      if (isLifted) list.drop();
      else list.lift(id);
      ev.preventDefault();
      return;
    }
    if (key === XK_ESCAPE) {
      if (!isLifted) return;
      list.cancel();
      ev.preventDefault();
      return;
    }
    const delta = key === prev ? -1 : key === next ? 1 : 0;
    if (delta !== 0) {
      if (isLifted) list.step(id, delta);
      else list.focusNeighbour(id, delta);
      ev.preventDefault();
      return;
    }
    if (isLifted && (key === XK_HOME || key === XK_END)) {
      list.step(id, key === XK_HOME ? 'home' : 'end');
      ev.preventDefault();
    }
  };

  /** Focus leaving a lifted item drops it where it is — a lifted item nobody
   *  is holding is a list that will not sit still. */
  const onBlur = (): void => {
    if (liftedRef.current) list.drop();
  };

  const attachHandle = useCallback(
    (ref: RefObject<DrawnNode | null>): (() => void) => {
      handleRef.current = ref;
      setHasHandle(true);
      return () => {
        if (handleRef.current === ref) handleRef.current = null;
        setHasHandle(false);
      };
    },
    [],
  );

  const drag = disabled ? NO_DRAG : dragProps;
  const moving =
    isDragging || lifted ? list.movingIds(id) : ([id] as ReorderId[]);
  const state: ReorderItemState = {
    id,
    dragging: isDragging,
    lifted,
    disabled,
    edge: mark?.edge ?? null,
    combining: Boolean(mark?.combine),
    accepted: position?.accepted ?? false,
    preview: false,
    ids: moving,
  };
  // A new object per render, deliberately: `dragProps` is new per render
  // too, and what it keeps current is one handle box and whoever called
  // `useReorderItem()` — both of which want the state of *this* render.
  const itemShared: ItemShared = {
    state,
    disabled,
    dragProps: drag,
    onKeyDown,
    onBlur,
    styles: list.styles,
    attachHandle,
  };
  const previewState: ReorderItemState = { ...state, preview: true };
  const content = typeof children === 'function' ? children(state) : children;

  const size =
    typeof list.previewSize === 'function'
      ? list.previewSize(previewState)
      : (list.previewSize ?? grab.current);
  const ghostAt = position && {
    x: position.x - grab.current.x,
    y: position.y - grab.current.y,
  };
  if (isDragging && ghostAt) lastGhost.current = ghostAt;
  // Where the ghost is drawn. A popup can leave the window and draws over
  // other applications; an in-window copy cannot, and is the opt-in.
  const mode = list.preview === 'auto' ? 'popup' : list.preview;
  /** The item's own origin on screen, which turns a pointer position into an
   *  offset inside the item — what an inline ghost is placed by, and what the
   *  drop flight eases to zero. */
  const originOnScreen = (): { x: number; y: number } | null => {
    const node = nodeRef.current;
    if (!node) return null;
    const scale = scaleOf(node);
    return {
      x: windowOrigin.current.x + node.abs.x / scale,
      y: windowOrigin.current.y + node.abs.y / scale,
    };
  };
  const origin = mode === 'inline' && ghostAt ? originOnScreen() : null;
  /** The offset the in-window copy is drawn at: the pointer's while the item
   *  is held, and the flight's easing to zero once it has landed. One box
   *  either way. */
  const inlineAt =
    flight ??
    (origin && ghostAt
      ? { x: ghostAt.x - origin.x, y: ghostAt.y - origin.y }
      : null);
  const showPopup = Boolean(ghostAt) && mode === 'popup';

  /** The look: the defaults, then the app's `style`. */
  const ownStyle: StyleInput[] = [itemStyle(state, hasHandle), style].filter(
    (s): s is StyleInput => Boolean(s),
  );
  /** The state, over the look: the lift, the wash, then the seam. */
  const stateStyle: StyleInput[] = [
    liftStyle(inlineAt !== null),
    washStyle(state, theme),
    list.styles?.item?.(state) || null,
  ].filter((s): s is StyleInput => Boolean(s));
  /** The ghost's content, drawn twice: once in the popup that follows the
   *  pointer, once in the copy that flies home after the drop. */
  const ghostBody = (): ReactNode =>
    h(
      ItemContext.Provider,
      { value: inertItem(previewState, list.styles) },
      list.renderPreview
        ? list.renderPreview(previewState)
        : hx(
            'box',
            {
              style: [
                ...ownStyle,
                previewStyle(theme),
                // the seam sees the ghost too, with `preview` set
                list.styles?.item?.(previewState) || null,
                list.styles?.preview,
              ],
            },
            typeof children === 'function' ? children(previewState) : children,
          ),
    );

  return hx(
    'box',
    {
      ref: nodeRef,
      role: 'listitem',
      'aria-label': ariaLabel,
      'aria-description': hasHandle || disabled ? undefined : HINT,
      'data-testname': testname,
      // Every press is remembered, whether or not it becomes a drag: at the
      // threshold there is no event saying where the gesture began. Capture
      // phase, so a child that stops propagation cannot hide it.
      onMouseDownCapture: (ev: MouseEvent) => {
        pressed.current = ev.target;
      },
      // without a handle the item is the drag source and the tab stop
      ...(hasHandle ? {} : drag),
      ...(hasHandle
        ? {}
        : {
            focusable: !disabled,
            onKeyDown: disabled ? undefined : onKeyDown,
            onBlur,
          }),
      style: [...ownStyle, ...stateStyle],
    },
    h(ItemContext.Provider, { key: 'content', value: itemShared }, content),
    mark !== null &&
      hx('box', {
        key: 'indicator',
        'data-testname': testname ? `${testname}-indicator` : undefined,
        style: [
          indicatorStyle(mark, list.orientation, theme),
          list.styles?.indicator,
        ],
      }),
    inlineAt !== null &&
      hx(
        'box',
        {
          key: 'ghost',
          // the same box before and after the release: the preview while the
          // pointer holds it, the flight once it has landed
          'data-testname': testname
            ? `${testname}-${flight ? 'flight' : 'preview'}`
            : undefined,
          style: {
            position: 'absolute',
            left: inlineAt.x,
            top: inlineAt.y,
            width: Math.max(1, Math.round(size.width)),
            height: Math.max(1, Math.round(size.height)),
            zIndex: 2,
            // the copy is a picture of the drop, never a target for the
            // press that follows it
            pointerEvents: 'none',
          },
        },
        ghostBody(),
      ),
    showPopup &&
      ghostAt &&
      hx(
        'popup',
        {
          key: 'preview',
          dragPreview: true,
          // a real window, and the card in it is rounded: see the header
          transparent: true,
          theme,
          x: Math.round(ghostAt.x),
          y: Math.round(ghostAt.y),
          width: Math.max(1, Math.round(size.width)),
          height: Math.max(1, Math.round(size.height)),
          'data-testname': testname ? `${testname}-preview` : undefined,
        },
        ghostBody(),
        moving.length > 1 &&
          hx(
            'box',
            {
              key: 'badge',
              'data-testname': testname ? `${testname}-count` : undefined,
              style: badgeStyle(theme),
            },
            hx(
              'text',
              { style: { fontSize: 11, color: theme.accentText } },
              String(moving.length),
            ),
          ),
      ),
  );
}

// --- the handle -------------------------------------------------------------

/**
 * `<ReorderHandle>` — the one part of an item that drags it. Rendering one
 * inside a `<ReorderItem>` is the whole opt-in: the item stops being the
 * press target and the tab stop, and this is both.
 */
export function ReorderHandle(props: ReorderHandleProps): ReactElement {
  const {
    'aria-label': ariaLabel = 'Drag to reorder',
    style,
    'data-testname': testname,
    children,
  } = props;
  const item = useContext(ItemContext);
  if (!item) {
    throw new Error(
      '@react-x11/components: <ReorderHandle> has to be inside a <ReorderItem>.',
    );
  }
  const ref = useRef<DrawnNode | null>(null);
  const { attachHandle } = item;
  useLayoutEffect(() => attachHandle(ref), [attachHandle]);

  return hx(
    'box',
    {
      ref,
      role: 'button',
      'aria-label': ariaLabel,
      'aria-description': item.disabled ? undefined : HINT,
      'data-testname': testname,
      focusable: !item.disabled,
      ...item.dragProps,
      onKeyDown: item.disabled ? undefined : item.onKeyDown,
      onBlur: item.onBlur,
      style: [
        {
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'center',
          padding: 2,
          borderRadius: 3,
          cursor: item.disabled ? undefined : 'grab',
        },
        !item.disabled && { ':hover': { backgroundColor: '$surfaceHover' } },
        item.styles?.handle,
        style,
      ],
    },
    children ??
      // two columns of core's three dots: the grip every list draws, made of
      // the affordance set rather than drawn here
      hx(
        'box',
        { key: 'grip', style: { flexDirection: 'row' } },
        h(Icon, {
          key: 'a',
          name: 'moreVertical',
          size: GRIP_DOT,
          color: '$textMuted',
        }),
        h(Icon, {
          key: 'b',
          name: 'moreVertical',
          size: GRIP_DOT,
          color: '$textMuted',
        }),
      ),
  );
}
