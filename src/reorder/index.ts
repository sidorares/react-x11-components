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
// drag to XDND when the pointer leaves the app. None of that is here. What
// is here is what a sortable preset is: the insertion arithmetic
// (`./model.ts`), the indicator, the keyboard model, and an event vocabulary
// that speaks list-and-index rather than node-and-pointer.
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
//    only override a node whose `dropAccept` already matched.
//  - **A move between lists is two local handlers**, `onInsert` on the list
//    it landed in and `onRemove` on the list it left — React Aria's model,
//    and the order core already fires them in (`onDrop`, then `onDragEnd`
//    "always last"). The target writes where the item landed onto the live
//    payload object, which is how the source can say `to`.
//  - **The indicator, not the slide.** Neighbours do not glide out of the
//    way: this renderer has no transform, and a line at the closest edge
//    answers "where will this land?" for a rectangle per item and no
//    measurement. The PRD records what a slide would cost and where it
//    would plug in.
//  - **Every item (or its handle) is a tab stop.** An item is arbitrary
//    content, often with controls of its own; the Tree/Table model of one
//    tab stop with a cursor would leave a button inside a card unreachable.
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
import { Icon, announce, useDragSource, useTheme } from 'react-x11';
import type {
  DragEndEvent,
  DragEvent,
  DragSourceEvent,
  DragSourceProps,
  DrawnNode,
  DropAccept,
  DropEvent,
  KeyboardEvent,
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
import {
  arrayMove,
  closestSlot,
  insertAtSlot,
  isNoopSlot,
  moveToSlot,
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
  isNoopSlot,
  moveToSlot,
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

/** What the focus target tells a screen reader it can do. */
const HINT =
  'Draggable. Press Space to lift, the arrow keys to move, Space to drop.';

/** Every announcement, in one place, because none of it is localised yet. */
const SAY = {
  lifted: (label: string, at: number, of: number): string =>
    `Lifted ${label}, position ${at} of ${of}. ` +
    'Use the arrow keys to move, Space to drop, Escape to cancel.',
  moved: (label: string, at: number, of: number): string =>
    `${label} moved to position ${at} of ${of}.`,
  dropped: (label: string, at: number, of: number): string =>
    `${label} dropped at position ${at} of ${of}.`,
  cancelled: (label: string, at: number): string =>
    `Move cancelled. ${label} returned to position ${at}.`,
};

// --- the events -------------------------------------------------------------

/** A move within one list. `items` is the ids in their new order — what an
 *  app holding ids sets its state to — and `from`/`to` are what one holding
 *  objects hands to `arrayMove`. */
export interface ReorderChange {
  items: ReorderId[];
  id: ReorderId;
  from: number;
  to: number;
}

/** An item from another `<ReorderList>` in the group landed here. `items` is
 *  this list's ids with `id` already in place; `source` is where it came
 *  from — hello-pangea's `{ droppableId, index }`, by other names. */
export interface ReorderInsert {
  items: ReorderId[];
  id: ReorderId;
  index: number;
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
  index: number;
  to: { list: string | undefined; index: number } | null;
  event: DragEndEvent;
}

/** A foreign payload — files, text, anything `accept` took — dropped at a
 *  slot. The event is core's, so `files`, `text` and `getData` are on it. */
export interface ReorderDrop {
  index: number;
  event: DropEvent;
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
  /** While the pointer drags this item: whether whatever is under the
   *  pointer would take it — a list in the group, a dropzone in the app,
   *  another application. False otherwise, the keyboard's lift included. */
  accepted: boolean;
  /** This render is the ghost's copy of the item, not the item in the list.
   *  What a child that renders in both asks before it draws its lighter
   *  version. */
  preview: boolean;
}

export interface ReorderStyles {
  /** Merged over the item's default look, under the item's own `style`. */
  item?: (state: ReorderItemState) => StyleInput | null | undefined | false;
  handle?: StyleInput;
  indicator?: StyleInput;
  /** The card the default preview draws the item's children in. */
  preview?: StyleInput;
}

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
  /** An item moved within this list. */
  onReorder?: (change: ReorderChange) => void;
  /** An item arrived from another list in the group. */
  onInsert?: (change: ReorderInsert) => void;
  /** An item of this list was moved elsewhere. */
  onRemove?: (change: ReorderRemove) => void;
  /** Foreign payloads the list takes, in core's `dropAccept` vocabulary —
   *  `['files']`, `'text/plain'`, a predicate. Without it every drag that is
   *  not a list item is refused. */
  accept?: DropAccept;
  /** A foreign payload landed, at `index`. */
  onDrop?: (drop: ReorderDrop) => void;
  /** Whether a ghost follows the pointer. Default true. */
  preview?: boolean;
  /** What the ghost shows. Default: the item's children again, on a card. */
  renderPreview?: (state: ReorderItemState) => ReactNode;
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
  /** What the drag offers. Default `['move']`. */
  dragActions?: Array<'copy' | 'move' | 'link'>;
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
  index: number;
  to?: { listUid: string; list: string | undefined; index: number };
}

/** One item, as the list sees it. */
interface Entry {
  id: ReorderId;
  node: RefObject<DrawnNode | null>;
  setEdge: (edge: ReorderEdge | null) => void;
  focus: () => void;
  label: () => string;
}

interface ListShared {
  uid: string;
  id: string | undefined;
  type: string;
  orientation: ReorderOrientation;
  disabled: boolean;
  preview: boolean;
  renderPreview: ((state: ReorderItemState) => ReactNode) | undefined;
  styles: ReorderStyles | undefined;
  liftedId: ReorderId | null;
  register(entry: Entry): () => void;
  order(): ReorderId[];
  lift(id: ReorderId): void;
  drop(): void;
  cancel(): void;
  step(id: ReorderId, where: -1 | 1 | 'home' | 'end'): void;
  focusNeighbour(id: ReorderId, delta: -1 | 1): void;
  dragStarted(id: ReorderId): number;
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
 *  scale `abs` is in. The same widening `<Tabs>` makes to measure its strip. */
interface ScaledNode {
  scale?: number;
}

function scaleOf(node: DrawnNode | null): number {
  const scale = (node as (DrawnNode & ScaledNode) | null)?.scale;
  return scale && scale > 0 ? scale : 1;
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
    onReorder,
    onInsert,
    onRemove,
    accept,
    onDrop,
    preview = true,
    renderPreview,
    styles,
    style,
    'data-testname': testname,
    children,
  } = props;

  const uid = React.useId();
  const type = scopedType(
    group !== undefined ? `group:${group}` : `list:${uid}`,
  );
  const rootRef = useRef<DrawnNode | null>(null);
  const entries = useRef(new Map<ReorderId, Entry>());
  /** The item showing the indicator, and on which edge. */
  const over = useRef<{ id: ReorderId; edge: ReorderEdge } | null>(null);
  /** The item of *this* list the pointer is dragging, if any. */
  const dragging = useRef<ReorderId | null>(null);
  const [lifted, setLifted] = useState<{
    id: ReorderId;
    origin: ReorderId[];
  } | null>(null);
  const liftedRef = useRef(lifted);
  liftedRef.current = lifted;

  // The handlers by ref, so the context value — and with it every item —
  // does not re-render because an app wrote an inline arrow.
  const handlers = useRef({ onReorder, onInsert, onRemove, onDrop, accept });
  handlers.current = { onReorder, onInsert, onRemove, onDrop, accept };

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
  const showEdge = (
    next: { id: ReorderId; edge: ReorderEdge } | null,
  ): void => {
    const prev = over.current;
    const same =
      prev !== null &&
      next !== null &&
      prev.id === next.id &&
      prev.edge === next.edge;
    if (same) return;
    if (prev) entries.current.get(prev.id)?.setEdge(null);
    if (next) entries.current.get(next.id)?.setEdge(next.edge);
    over.current = next;
  };

  /** Where a drag event's pointer would insert. */
  const slotFor = (
    ev: DragEvent,
  ): {
    ids: ReorderId[];
    slot: number;
    at: { id: ReorderId; edge: ReorderEdge } | null;
  } => {
    const ids = order();
    const hit = closestSlot(
      rectsOf(ids),
      { x: ev.x, y: ev.y },
      orientation,
      rootRef.current?.direction ?? 'ltr',
    );
    if (!hit) return { ids, slot: 0, at: null };
    return {
      ids,
      slot: hit.slot,
      at: { id: ids[hit.index]!, edge: hit.edge },
    };
  };

  const onDragOver = (ev: DragEvent): void => {
    // `onDragOver` reaches every node on the path under the pointer, matched
    // or not — so a list has to ask the question `dropAccept` already
    // answered before it promises a slot to a drag it will never be given
    if (
      !ev.types.includes(type) &&
      !foreignAccepted(handlers.current.accept, ev)
    ) {
      showEdge(null);
      return;
    }
    const { ids, slot, at } = slotFor(ev);
    // one of this list's own items, over a gap that is already its own:
    // nothing would move, so nothing is promised
    const own = dragging.current;
    if (own !== null && isNoopSlot(ids.indexOf(own), slot)) {
      showEdge(null);
      return;
    }
    showEdge(at);
  };

  const onDragLeave = (): void => showEdge(null);

  const onDropHere = (ev: DropEvent): void => {
    showEdge(null);
    const { ids, slot } = slotFor(ev);
    const payload = ev.items?.[type] as Payload | undefined;
    if (payload && typeof payload === 'object') {
      if (payload.listUid === uid) {
        const move = moveToSlot(ids, payload.id, slot);
        payload.to = {
          listUid: uid,
          list: id,
          index: move ? move.to : payload.index,
        };
        ev.accept('move');
        if (move) handlers.current.onReorder?.({ ...move, id: payload.id });
        return;
      }
      payload.to = { listUid: uid, list: id, index: slot };
      ev.accept('move');
      handlers.current.onInsert?.({
        items: insertAtSlot(ids, payload.id, slot),
        id: payload.id,
        index: slot,
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

  const say = (
    itemId: ReorderId,
  ): { label: string; at: number; of: number } => {
    const ids = order();
    return {
      label: entries.current.get(itemId)?.label() ?? 'item',
      at: ids.indexOf(itemId) + 1,
      of: ids.length,
    };
  };

  const lift = useCallback(
    (itemId: ReorderId): void => {
      const ids = order();
      setLifted({ id: itemId, origin: ids });
      const { label, at, of } = say(itemId);
      announce(SAY.lifted(label, at, of));
    },
    // `say` and `order` read refs; neither changes identity in a way that
    // matters here
    [],
  );

  const drop = useCallback((): void => {
    const current = liftedRef.current;
    if (!current) return;
    setLifted(null);
    const { label, at, of } = say(current.id);
    announce(SAY.dropped(label, at, of));
  }, []);

  const cancel = useCallback((): void => {
    const current = liftedRef.current;
    if (!current) return;
    setLifted(null);
    const ids = order();
    const from = ids.indexOf(current.id);
    const to = current.origin.indexOf(current.id);
    if (from >= 0 && to >= 0 && from !== to) {
      handlers.current.onReorder?.({
        items: arrayMove(ids, from, to),
        id: current.id,
        from,
        to,
      });
    }
    const label = entries.current.get(current.id)?.label() ?? 'item';
    announce(SAY.cancelled(label, (to >= 0 ? to : from) + 1));
  }, []);

  const step = useCallback(
    (itemId: ReorderId, where: -1 | 1 | 'home' | 'end'): void => {
      const ids = order();
      const from = ids.indexOf(itemId);
      if (from < 0) return;
      const to =
        where === 'home'
          ? 0
          : where === 'end'
            ? ids.length - 1
            : Math.min(Math.max(from + where, 0), ids.length - 1);
      if (to === from) return;
      handlers.current.onReorder?.({
        items: arrayMove(ids, from, to),
        id: itemId,
        from,
        to,
      });
      const label = entries.current.get(itemId)?.label() ?? 'item';
      announce(SAY.moved(label, to + 1, ids.length));
    },
    [],
  );

  const focusNeighbour = useCallback((itemId: ReorderId, delta: -1 | 1) => {
    const ids = order();
    const next = ids[ids.indexOf(itemId) + delta];
    if (next !== undefined) entries.current.get(next)?.focus();
  }, []);

  const register = useCallback((entry: Entry): (() => void) => {
    entries.current.set(entry.id, entry);
    return () => {
      if (entries.current.get(entry.id) === entry) {
        entries.current.delete(entry.id);
      }
      if (over.current?.id === entry.id) over.current = null;
    };
  }, []);

  const dragStarted = useCallback((itemId: ReorderId): number => {
    dragging.current = itemId;
    // a pointer drag and a keyboard lift are one gesture's worth of state
    if (liftedRef.current) setLifted(null);
    return order().indexOf(itemId);
  }, []);

  const dragEnded = useCallback(
    (itemId: ReorderId, ev: DragEndEvent, payload: Payload | null): void => {
      dragging.current = null;
      showEdge(null);
      if (!ev.dropped || ev.action !== 'move') return;
      const to = payload?.to;
      // a move within this list: `onReorder` already said so, at the drop
      if (to && to.listUid === uid) return;
      const ids = order();
      handlers.current.onRemove?.({
        items: ids.filter((x) => x !== itemId),
        id: itemId,
        index: ids.indexOf(itemId),
        to: to ? { list: to.list, index: to.index } : null,
        event: ev,
      });
    },
    [uid],
  );

  const shared = useMemo<ListShared>(
    () => ({
      uid,
      id,
      type,
      orientation,
      disabled,
      preview,
      renderPreview,
      styles,
      liftedId: lifted?.id ?? null,
      register,
      order,
      lift,
      drop,
      cancel,
      step,
      focusNeighbour,
      dragStarted,
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
      styles,
      lifted,
      register,
      order,
      lift,
      drop,
      cancel,
      step,
      focusNeighbour,
      dragStarted,
      dragEnded,
    ],
  );

  const dropAccept = useMemo<DropAccept>(
    () => (disabled ? refuse : widenAccept(accept, type)),
    [accept, type, disabled],
  );

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
 *  item so a scrolling list carries it, logical edges so RTL costs nothing. */
function indicatorStyle(
  edge: ReorderEdge,
  orientation: ReorderOrientation,
  theme: Theme,
): Style {
  const base: Style = {
    position: 'absolute',
    zIndex: 1,
    pointerEvents: 'none',
    backgroundColor: theme.accent,
  };
  if (orientation === 'vertical') {
    return {
      ...base,
      left: 0,
      right: 0,
      height: INDICATOR,
      ...(edge === 'before'
        ? { top: -INDICATOR / 2 }
        : { bottom: -INDICATOR / 2 }),
    };
  }
  return {
    ...base,
    top: 0,
    bottom: 0,
    width: INDICATOR,
    ...(edge === 'before'
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
    'aria-label': ariaLabel,
    style,
    'data-testname': testname,
    children,
  } = props;
  const list = useList('ReorderItem');
  const theme = useTheme();
  const nodeRef = useRef<DrawnNode | null>(null);
  const handleRef = useRef<RefObject<DrawnNode | null> | null>(null);
  const [edge, setEdge] = useState<ReorderEdge | null>(null);
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

  const label = useCallback(
    (): string => ariaLabel ?? labelOf(nodeRef.current),
    [ariaLabel],
  );

  useEffect(
    () =>
      list.register({
        id,
        node: nodeRef,
        setEdge,
        focus: () => {
          (handleRef.current?.current ?? nodeRef.current)?.focus();
        },
        label,
      }),
    [id, list.register, label],
  );

  const { dragProps, isDragging, position } = useDragSource({
    data: { [list.type]: () => payload.current, ...dragData },
    actions: dragActions ?? ['move'],
    onDragStart: (ev: DragSourceEvent) => {
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
      payload.current = {
        listUid: list.uid,
        list: list.id,
        id,
        index: list.dragStarted(id),
      };
    },
    onDragEnd: (ev: DragEndEvent) => {
      const carried = payload.current;
      payload.current = null;
      list.dragEnded(id, ev, carried);
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
  const state: ReorderItemState = {
    id,
    dragging: isDragging,
    lifted,
    disabled,
    edge,
    accepted: position?.accepted ?? false,
    preview: false,
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

  /** The look: the defaults, then the app's `style`. */
  const ownStyle: StyleInput[] = [itemStyle(state, hasHandle), style].filter(
    (s): s is StyleInput => Boolean(s),
  );
  /** The state, over the look: the wash, then the seam. */
  const stateStyle: StyleInput[] = [
    washStyle(state, theme),
    list.styles?.item?.(state) || null,
  ].filter((s): s is StyleInput => Boolean(s));

  const showPreview = isDragging && position !== null && list.preview;

  return hx(
    'box',
    {
      ref: nodeRef,
      role: 'listitem',
      'aria-label': ariaLabel,
      'aria-description': hasHandle || disabled ? undefined : HINT,
      'data-testname': testname,
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
    edge !== null &&
      hx('box', {
        key: 'indicator',
        'data-testname': testname ? `${testname}-indicator` : undefined,
        style: [
          indicatorStyle(edge, list.orientation, theme),
          list.styles?.indicator,
        ],
      }),
    showPreview &&
      hx(
        'popup',
        {
          key: 'preview',
          dragPreview: true,
          theme,
          x: position.x - grab.current.x,
          y: position.y - grab.current.y,
          width: Math.max(1, Math.round(grab.current.width)),
          height: Math.max(1, Math.round(grab.current.height)),
          'data-testname': testname ? `${testname}-preview` : undefined,
        },
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
                typeof children === 'function'
                  ? children(previewState)
                  : children,
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
