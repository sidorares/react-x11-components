// Block layout: the driver, and the formatting context everything else hangs
// off.
//
// Boxes are laid out into **absolute document coordinates** in one pass. The
// alternative — relative offsets resolved by a second walk — buys incremental
// relayout of a subtree, and it is not worth it here: paint, hit testing and
// the selection accessors all want absolute rectangles, and every one of them
// runs far more often than layout does. So layout writes what they read.
//
// Float coordinates are absolute for the same reason, which is what lets the
// inline pass ask "how wide is the line at this y" without knowing whose
// formatting context it is inside.
import type { Element } from 'domhandler';
import { implicitAnchorOf, isInputButton, topLayerOrder } from '../dom.js';
import {
  AUTO,
  gapOf,
  isPct,
  isTransparent,
  resolve,
  resolveOrNull,
} from '../css/values.js';
import type { Len } from '../css/values.js';
import {
  anchorCalls,
  anchorInset,
  anchorMathValue,
  areaAlignment,
  areaLines,
  areaTracks,
  isAnchorMath,
  mapAnchorCalls,
  startOf,
} from '../css/anchor.js';
import type {
  AnchorInset,
  AnchorSide,
  AnchorSize,
  AnchorSizeKind,
  AnchorSizeRef,
  InsetSide,
  PositionArea,
  TryTactic,
  WritingAxes,
} from '../css/anchor.js';
import type {
  AnchorSizeField,
  BorderStyle,
  ComputedStyle,
  WritingMode,
  ContentSize,
  GridLine,
  SizeOf,
} from '../css/style.js';
import {
  ANCHOR_SIZE_UNSET,
  CONTAIN_INLINE_SIZE,
  CONTAIN_LAYOUT,
  CONTAIN_PAINT,
  CONTAIN_SIZE,
  WILL_CONTAIN,
  WILL_HOLD_ABSOLUTE,
  WILL_HOLD_FIXED,
  WILL_HOLD_FIXED_BOX,
  INLINE_BEFORE_ABSOLUTE,
  anchorsImplicitly,
  scrolls,
} from '../css/style.js';
import {
  about,
  drawnThrough,
  linearOf,
  matrix4Of,
  matrixOf,
  outOfPlane,
  transformed,
  translation4,
} from '../css/transform.js';
import {
  ASIDE_REACH,
  STUCK,
  anchoredWith,
  applyScrollOffsets,
  clearDefaultAnchors,
  defaultAnchorOf,
  displacementOf,
  escapes as positionedOutside,
  forgetPaneShift,
  isScroller,
  noteAnchorScroll,
  noteDefaultAnchor,
  noteVisibility,
  scrollBack,
  scrollContextOf,
  scrollsAny,
  settleAnchorScrolls,
  updatePositionVisibility,
  scrollStateOf,
  scrolledBy,
  viewportOf,
  wantedScroll,
  wantedScrollTop,
} from './scroll.js';
import type { ScrollOffset, Viewport } from './scroll.js';
import type { Placed } from '../css/transform.js';
import {
  affineOf,
  facesAway,
  multiply4,
  perspective4,
  projectionIsAffine,
  projectionOf,
  translate4,
} from '../css/transform3d.js';
import type { Mat4, Projection } from '../css/transform3d.js';
import { lineOf, spanToName } from './grid-lines.js';
import type { GridLines } from './grid-lines.js';
import {
  columnsOf,
  forgetColumns,
  layoutColumns,
  spansColumns,
} from './multicol.js';
import type { Columns } from './multicol.js';
import {
  BOX_RAISES,
  Box,
  CLAMPED,
  COLUMN_BOXES,
  CLEARED_FROM,
  COLUMN_PIECES,
  CUT_BLOCKS,
  CUT_PIECES,
  GRID_TRACKS,
  FIRST_LINE,
  GENERATED_FROM,
  INLINE_OFFSETS,
  MOVED_OFF_LINES,
  LINE_BOX_RAISES,
  SHIFTED_LINES,
  STICKY_SIZES,
  TEXT_RAISES,
  TEXT_SHIFTS,
  columned,
  containmentApplies,
  isBlank,
} from './boxes.js';
import type {
  BoxTree,
  FirstLineStyler,
  ForeignObject,
  Intrinsic,
  InlineDecoration,
  LineBox,
  MarginStrut,
  Marker,
} from './boxes.js';
import { FloatContext } from './floats.js';
import { drawingViewport, foreignRect } from '../svg.js';
import {
  CUT_LINES,
  emptyLinePoint,
  faceExtentOf,
  isButton,
  joinsBefore,
  layoutInline,
  lineHeightMultiplier,
  spaceBreaksOnly,
  strutOf,
  uncutWidth,
  widestWord,
} from './inline.js';
import type { FontsLike, InlineOptions, InlineResult } from './inline.js';
import type { TextRun } from '../../richtext/index.js';
import { forgetGridItem } from './css-grid.js';
import { forgetMaxContent, layoutFlex, replacedMinimum } from './flex.js';
import { finishCaptions, givenHeight, layoutTable } from './table.js';
import { collapseEdges } from './collapse.js';
import {
  FRAMES,
  FRAME_ROOTS,
  framed,
  frameOf,
  frameRectOf,
  frameSideOf,
  pageRectOf,
  pageSideOf,
  reflectFrame,
  reflects,
  turnsUp,
} from './writing.js';
import type { PhysicalSide } from './writing.js';
import {
  clipsFor,
  computePaintBounds,
  containingBlockOf,
  DOCUMENT_FLOW,
  drawnAtViewport,
  drawsNothing,
  FIXED_BOXES,
  fixedToViewport,
  hoistNegative,
  OUT_OF_FLOW_REACH,
  stackLayers,
} from '../paint.js';

export interface LayoutContext {
  fonts: FontsLike | null;
  /** The engine `fonts` lay text out by (`FontsLike.engine`), which what a
   *  layout keeps of a box was laid out by. */
  engine: FontsLike | null;
  /** Device pixels to a CSS pixel, the unit every length here is in: what
   *  `text-wrap: pretty` scales its scores by (`InlineOptions.scale`). */
  scale?: number;
  /** Whether any block has a `::first-line` (`BoxTree.firstLine`). */
  firstLine?: boolean;
  /** Each box's style on a first line (`BoxTree.firstLineStyler`). */
  firstLineStyler?: FirstLineStyler | null;
  /** Whether a float or an out-of-flow box is in an inline box
   *  (`BoxTree.nestedOutOfLine`). */
  nestedOutOfLine?: boolean;
  /** Whether any box paints its background through its text
   *  (`BoxTree.clipText`). */
  clipText?: boolean;
  viewportWidth: number;
  viewportHeight: number;
  /** Set once a box is placed against the initial containing block, whose
   *  height is the viewport's (`LayoutResult.readsViewportHeight`). */
  readViewportHeight?: boolean;
  /** The viewport's height this layout is made under, and whether it read
   *  it, which every box it notes it laid out keeps (`LaidUnder`). */
  under: LaidUnder;
  /** Out-of-flow boxes, collected in flow order and laid out afterwards —
   *  an absolutely positioned box may be positioned against an ancestor
   *  whose size is not known until its in-flow content has been laid out. */
  positioned: { box: Box; containing: Box }[];
  /** The boxes each anchor name is on, in the document's order, found the
   *  first time a positioned box asks (`indexAnchors`); null where the tree
   *  has no `anchor-name`, and undefined until then. */
  anchors?: Map<string, Box[]> | null;
  /** The root the anchors are found under. */
  anchorRoot?: Box | null;
  /** Each box's place in the tree's order, found with the anchors: what
   *  says whether an anchor precedes the box it anchors. */
  anchorOrder?: Map<Box, number>;
  /** Each element's own box, its first, found with the anchors: what an
   *  implicit anchor element is found as (`implicitAnchorBox`). */
  elementBoxes?: Map<Element, Box>;
  /** Where the pane around the document has the viewport (`setViewport`),
   *  for a box fixed to it anchored in the document, or the other way
   *  round. */
  viewport?: Viewport | null;
  /** How far the layout scrolls a scroll container's content
   *  (`wantedScroll`). */
  scrollOf?: (box: Box) => ScrollOffset;
  /** While an anchored box is placed, the displacement of its default
   *  anchor its anchor references are taken at (`layoutPositioned`), which
   *  the anchors scrolled with that one are seen moved back by
   *  (`anchorRect`). */
  anchorShift?: { anchor: Box; x: number; y: number } | null;
  /** Whether the layout answers a question about the document's size,
   *  which no frame draws (`layoutAsks`). */
  question?: boolean;
  /** Which layout this is, where it may keep a block an earlier layout laid
   *  out (`reuseLaid`): one of the whole document, of a tree with no
   *  anchor, no vertical flow, no `::first-line` and no foreign object. */
  reusePass?: number;
  /** The blocks this layout kept rather than laid out, which it takes the
   *  offsets the passes after the flow put on off (`keepLaid`), and whose
   *  ink, where nothing in them moved, the walk after it keeps
   *  (`computePaintBounds`). */
  reused?: Set<Box>;
  /** The boxes no layout keeps, those that hold a box out of the flow, and
   *  those the passes after a flow move something in (`reuseBlockers`). */
  blockers?: Blockers;
  /** The boxes out of the flow in the blocks this layout kept, which it
   *  does not lay out and the document reaches as far as (`keptPositionedIn`). */
  keptPositioned?: Box[];
  /** Whether a box in the tree is offset after the flow — relative, by a
   *  transform's translation or by a scroll — whose offsets a kept block
   *  has taken off what it holds (`unoffsetHeld`). Where none is, nothing
   *  is taken off, and a kept block is not walked: a walk of all it holds
   *  that reads each box's style was, for a stream's chunk, a walk of the
   *  whole document above the chunk. */
  offsets?: boolean;
  /**
   * Lay a box and everything under it out at a width, at the origin.
   *
   * The recursion back into this file that `flex.ts` and `table.ts` need — a
   * flex item contains blocks, a table cell contains anything at all — passed
   * on the context rather than imported, because the cycle is genuine and the
   * alternative is a module that registers itself at import time. This
   * package's tree-shaking contract forbids exactly that (AGENTS.md, "no side
   * effects at import time anywhere else"), and a field is cheaper than the
   * exception would be.
   *
   * `containing` is the width of the box's containing block where `width`
   * is the box's own, as a flex layout sized it: what the percentages in
   * its padding, its margins and its width limits are of (CSS 2.1 8.3,
   * 8.4, 10.4). Left out, `width` is both — a box probed at the room there
   * is for it. For a table cell it is the width of its row, which its
   * padding's percentages are of, and it says the cell is laid out in its
   * columns: at `width`, whatever its limits say.
   */
  layoutSubtree(box: Box, width: number, containing?: number): void;
  /** How many flex boxes' Yoga passes are running, one inside the last's
   *  measure (`layoutFlex`). */
  flexDepth?: number;
  /** The clamp of the line-clamp container whose formatting context is
   *  being laid out, if any (`layoutInternals`). */
  clamp?: Clamp | null;
  /** Where a layout made while the width is still moving stops, in
   *  document coordinates (`layoutDocument`'s `until`): the flow lays out
   *  no box that starts below it, and sets the rest aside (`setAside`). */
  until?: number;
  /** Whether this layout stops anywhere (`until`, `LayoutContext.keep`), so
   *  that a box may be missing what it set aside from `children`. */
  stopping?: boolean;
  /** The boxes this pass set children aside in, each with the whole list
   *  it had, and the pass's number, which marks what was set aside
   *  (`HELD_BACK`). */
  setAside?: Map<Box, Box[]>;
  pass?: number;
  /** The boxes that hold one placed against something outside them
   *  (`escapingHolders`), which a layout that stops lays out — with all
   *  but such boxes set aside in each — rather than set aside. */
  holders?: ReadonlySet<Box>;
  /**
   * How many of a box's first children a layout made while the width is
   * still moving keeps above where it starts (`keepAbove`), by box: they
   * are not laid out, keep their boxes and their place in the flow, and
   * are set aside as what is below where it stops is (`setAside`), until a
   * layout lays them out again.
   */
  keep?: Map<Box, number>;
  /**
   * The box what can be seen starts at, in a tree no layout has laid out:
   * a layout that stops does not stop before it is laid out, and then stops
   * `below` past where it landed (`layoutDocument`'s `reach`).
   */
  reach?: { box: Box; below: number };
  /** Whether this lays a box out to measure it, rather than where it goes
   *  (`probeWhole`, `measureIntrinsicWidth`): a probe keeps nothing, stops
   *  nowhere, and leaves the places the flow keeps by (`FLOW_PLACE`). */
  probing?: boolean;
  /** How far down a scroll container's content is scrolled once the layout
   *  is done (`wantedScrollTop`), where a layout stops: one stops where
   *  what it shows ends (`layoutBox`). */
  scrollTopOf?: (box: Box) => number;
}

/**
 * A line-clamp container's clamp, carried through its formatting context as
 * the lines in it are laid out (CSS Overflow 4, 5.2 and 5.3.1). Only the
 * lines of that formatting context count: a box that makes one of its own
 * is laid out with none, and counts as a block.
 */
interface Clamp {
  /** The line-clamp container. */
  box: Box;
  /** How many more lines show before the clamp point. */
  left: number;
  /** Whether the clamp point is passed: every box after it in the flow is
   *  invisible, and takes no room (`CLAMPED`). */
  done: boolean;
  /**
   * For `line-clamp: auto`, whose clamp point is after as many lines as
   * the box's height holds: the first pass lays the content out whole and
   * counts the lines that end above `floor` — the box's content bottom, in
   * document coordinates — with what closes below each. `over` once one
   * does not; null where the lines are cut rather than counted.
   */
  fit: { floor: number; lines: number; over: boolean } | null;
}

export interface LayoutResult {
  width: number;
  height: number;
  /**
   * Whether the layout read the viewport's height: a percentage height on
   * the root element, or a box positioned against the initial containing
   * block. A document that did lays out differently in a viewport of
   * another height, and one that did not — most — lays out the same.
   */
  readsViewportHeight: boolean;
  /** Whether the layout stopped where it was asked to (`until`), with the
   *  boxes past it set aside and its height a guess at theirs. */
  partial: boolean;
}

/**
 * The children each box's last layout set aside, by the pass that did
 * (`setAside`): put back before the tree is laid out again, and what tells
 * a box set aside from one laid out (`heldBack`).
 */
const SET_ASIDE = new WeakMap<
  BoxTree,
  { pass: number; boxes: Map<Box, Box[]> }
>();

/** The pass that set a box aside, with everything in it. */
const HELD_BACK = new WeakMap<Box, number>();

/** Passes that set boxes aside, counted, for `HELD_BACK`. */
let setAsidePasses = 0;

/** The pass a box's flow was last probed in (`LayoutContext.probing`): a
 *  probe lays out the children a layout would keep, and leaves them where
 *  it measured them, so a flow probed in a pass keeps none of them. */
const PROBED = new WeakMap<Box, number>();

/** Trees with a box set aside that something laid out is placed against
 *  (`escapes`): laid out whole from then on. */
const LAID_WHOLE = new WeakSet<BoxTree>();

/** Whether a layout that stopped found a box it set aside placed by
 *  something it laid out, and laid the tree out whole (`escapes`). */
export function laidWhole(tree: BoxTree): boolean {
  return LAID_WHOLE.has(tree);
}

/** Every out-of-flow box in a tree, found once (`escapes`). */
const OUT_OF_FLOW = new WeakMap<BoxTree, Box[]>();

/** Put back what the last layout of a tree set aside: before the next
 *  layout of it, or a build of some of its subtrees, which splices them
 *  into the boxes' whole lists (`HtmlViewNode._subtreeBuild`). */
export function putBack(tree: BoxTree): void {
  const aside = SET_ASIDE.get(tree);
  if (!aside) return;
  SET_ASIDE.delete(tree);
  UNSEEN.delete(tree);
  for (const [box, children] of aside.boxes) {
    box.children = children;
    ASIDE_REACH.delete(box);
  }
}

/**
 * The children of each box its tree's last layout set aside some of, whole
 * (`setAside`), or null where it set none aside: what an index of the boxes
 * by element goes down, so that it is the same whenever it is made.
 */
export function asideOf(tree: BoxTree): ReadonlyMap<Box, Box[]> | null {
  return SET_ASIDE.get(tree)?.boxes ?? null;
}

/** Whether the tree's last layout set this box aside, with what it holds
 *  (`heldBack` asks it of a box and every box it is in). */
export function setAsideHere(tree: BoxTree, box: Box): boolean {
  const aside = SET_ASIDE.get(tree);
  return aside !== undefined && HELD_BACK.get(box) === aside.pass;
}

/** Whether the tree's last layout set aside any box. */
export function asideIn(tree: BoxTree): boolean {
  return SET_ASIDE.has(tree);
}

/** Whether the tree's last layout set aside some of a box's children in
 *  its flow: a walk down `children` passes them (`asideOf`). One it set
 *  aside for drawing nothing is `unseenIn`'s. */
export function setAsideIn(tree: BoxTree, box: Box): boolean {
  const whole = SET_ASIDE.get(tree)?.boxes.get(box);
  if (!whole) return false;
  const unseen = UNSEEN.get(tree);
  if (!unseen) return true;
  for (const child of whole) {
    if (!unseen.has(child) && !box.children.includes(child)) return true;
  }
  return false;
}

/** The children of a box its tree's last layout set aside for drawing
 *  nothing (`unseenWhileStopped`). */
export function unseenIn(tree: BoxTree, box: Box): readonly Box[] {
  const unseen = UNSEEN.get(tree);
  if (!unseen) return NO_BOXES;
  const whole = SET_ASIDE.get(tree)?.boxes.get(box);
  return whole ? whole.filter((child) => unseen.has(child)) : NO_BOXES;
}

/** Whether a box was set aside for drawing nothing, or is in one that
 *  was, and in nothing set aside for another reason. */
export function unseenHeld(tree: BoxTree, box: Box): boolean {
  const unseen = UNSEEN.get(tree);
  const aside = SET_ASIDE.get(tree);
  if (!unseen || !aside) return false;
  for (let at: Box | null = box; at; at = at.parent) {
    if (HELD_BACK.get(at) === aside.pass) return unseen.has(at);
  }
  return false;
}

const NO_BOXES: readonly Box[] = [];

/**
 * Whether a box was set aside by its tree's last layout, or is in one that
 * was: it was not laid out, its geometry is a width ago, and nothing that
 * reads the layout — the paint, the hit test, the widgets mounted over the
 * document — finds it from the root. A tree laid out whole has none.
 */
export function heldBack(tree: BoxTree, box: Box): boolean {
  const aside = SET_ASIDE.get(tree);
  if (!aside) return false;
  for (let at: Box | null = box; at; at = at.parent) {
    if (HELD_BACK.get(at) === aside.pass) return true;
  }
  return false;
}

/**
 * Set aside a box's children from `from` on, the ones in flow and the
 * floats, which start below where the layout stops (`LayoutContext.until`).
 * Its out-of-flow children stay: what they are placed against may be
 * laid out. How tall the ones set aside were when last laid out, which is
 * what the box is taller by — a guess, until the layout that lays them out.
 */
function setAside(
  box: Box,
  children: Box[],
  from: number,
  ctx: LayoutContext,
): number {
  const kept = children.slice(0, from);
  const holders = ctx.holders;
  let first: Box | null = null;
  let last: Box | null = null;
  // the holders kept among what is set aside, which the flow lays out
  // after it and whose heights it adds again
  let held = 0;
  let heldSince = 0;
  for (let i = from; i < children.length; i += 1) {
    const child = children[i];
    if (child.outOfFlow) {
      kept.push(child);
      continue;
    }
    if (holders?.has(child)) {
      kept.push(child);
      if (first)
        heldSince += child.height + child.marginTop + child.marginBottom;
      continue;
    }
    HELD_BACK.set(child, ctx.pass!);
    if (child.isFloat || child.kind === 'text') continue;
    first ??= child;
    last = child;
    held = heldSince;
  }
  if (!ctx.setAside!.has(box)) ctx.setAside!.set(box, children);
  box.children = kept;
  if (!first || !last) return 0;
  const span =
    last.y +
    last.height +
    last.marginBottom -
    (first.y - first.marginTop) -
    held;
  return Number.isFinite(span) && span > 0 ? span : 0;
}

/**
 * A box's children with what this pass set aside of them taken back, for
 * a layout of it at another width or another place in the pass, or a
 * probe, which stops nowhere: laid out again from the whole list.
 */
export function wholeAgain(box: Box, ctx: LayoutContext): Box[] {
  const whole = ctx.setAside?.get(box);
  if (whole) {
    for (const child of whole) HELD_BACK.delete(child);
    ctx.setAside!.delete(box);
    ASIDE_REACH.delete(box);
    box.children = whole;
  }
  return box.children;
}

/**
 * Set aside those of a box's children in `aside`, which a layout that
 * stops (`until`) leaves where they were, as tall as they were: what of
 * them is below where it stops, reaching `reach` below the box's content
 * top. A grid's rows are set aside so (`layoutGrid`).
 */
export function setAsideOf(
  box: Box,
  aside: ReadonlySet<Box>,
  reach: number,
  ctx: LayoutContext,
): void {
  const children = box.children;
  if (!ctx.setAside!.has(box)) ctx.setAside!.set(box, children);
  const kept: Box[] = [];
  for (const child of children) {
    if (aside.has(child)) HELD_BACK.set(child, ctx.pass!);
    else kept.push(child);
  }
  box.children = kept;
  ASIDE_REACH.set(box, reach);
}

/**
 * By tree, the absolute boxes its last layout left where they were, with
 * what they hold, for drawing nothing (`unseenWhileStopped`).
 */
const UNSEEN = new WeakMap<BoxTree, Set<Box>>();

/** By tree, the boxes that hold a widget — a control, a player, an
 *  embedded element — and the widget's own: found once. */
const WIDGET_HOLDERS = new WeakMap<BoxTree, Set<Box>>();

function widgetHolders(tree: BoxTree): Set<Box> {
  let holders = WIDGET_HOLDERS.get(tree);
  if (holders) return holders;
  holders = new Set();
  for (const list of [tree.controls, tree.media, tree.embedded]) {
    for (const box of list) {
      for (let at: Box | null = box; at && !holders.has(at); at = at.parent) {
        holders.add(at);
      }
    }
  }
  WIDGET_HOLDERS.set(tree, holders);
  return holders;
}

/**
 * Whether a layout that stops (`until`) may leave an absolute box where
 * its last layout put it, set aside with all it holds as what is below
 * the viewport is: one that draws nothing all through (`drawsNothing`) —
 * hidden, or faded to nothing — that a layout has placed, and that holds
 * no widget, which is mounted over the document wherever the box is. Where
 * it is matters to nothing a reader sees, and the layout at rest gives it
 * its place. GitHub keeps its menus so, laid out shrink-to-fit, and they
 * were a third of every step of a drag. Not a fixed box, which the paint
 * finds by a list of its own (`FIXED_BOXES`), nor one in the top layer, nor
 * any in a tree that anchors, where a box may be placed against it.
 */
function unseenWhileStopped(tree: BoxTree, box: Box): boolean {
  if (box.style.position !== 'absolute' || box.topLayer) return false;
  if (box.layoutSerial === 0 || !box.parent || tree.anchors) return false;
  return drawsNothing(box) && !widgetHolders(tree).has(box);
}

/** Set an absolute box aside from its parent (`unseenWhileStopped`), and
 *  note how far below the parent's content it reached, which a scroll
 *  container's extent counts (`ASIDE_REACH`). */
function holdUnseen(box: Box, ctx: LayoutContext): void {
  const parent = box.parent!;
  const children = parent.children;
  if (!ctx.setAside!.has(parent)) ctx.setAside!.set(parent, children);
  parent.children = children.filter((child) => child !== box);
  HELD_BACK.set(box, ctx.pass!);
  const reach =
    (OUT_OF_FLOW_REACH.get(box) ?? box.y + box.height) - parent.contentY;
  const was = ASIDE_REACH.get(parent);
  if (Number.isFinite(reach) && !(was !== undefined && was >= reach)) {
    ASIDE_REACH.set(parent, reach);
  }
}

/**
 * Whether a box the tree's last layout left where it was for drawing
 * nothing draws now: a restyle in place showed it, and the document is
 * laid out again to place it.
 */
export function showsUnseen(tree: BoxTree): boolean {
  const boxes = UNSEEN.get(tree);
  if (!boxes) return false;
  for (const box of boxes) if (!drawsNothing(box)) return true;
  return false;
}

/** A shrink-to-fit box's content laid out at no width limit, all of it:
 *  a probe stops nowhere (`until`). */
function probeWhole(box: Box, ctx: LayoutContext, floats: FloatContext): void {
  const { until, probing, reach } = ctx;
  ctx.until = undefined;
  ctx.reach = undefined;
  ctx.probing = true;
  standsOff += 1;
  try {
    layoutInternals(box, ctx, Infinity, 0, 0, floats);
  } finally {
    ctx.until = until;
    ctx.reach = reach;
    ctx.probing = probing;
    standsOff -= 1;
  }
}

/** Whether a box is a multicol container, or in one: laid out whole. Its
 *  content is one strip its columns balance, so it neither stops where
 *  the viewport ends nor keeps what is above it. A scroll container stops
 *  where what it shows ends (`layoutBox`). */
export function laidWholeAround(box: Box): boolean {
  for (let at: Box | null = box; at; at = at.parent) {
    if (at.style.columns) return true;
  }
  return false;
}

/**
 * Whether a box set aside is one something laid out places: a fixed box,
 * drawn where the viewport is wherever the flow has it, or an absolute one
 * whose offsets put it against a box that was laid out. One placed where
 * the flow would have it is below where the layout stopped.
 */
function escapes(tree: BoxTree): boolean {
  for (const box of outOfFlowOf(tree)) {
    if (!heldBack(tree, box)) continue;
    if (box.style.position === 'fixed' || box.topLayer) return true;
    if (box.style.top === AUTO && box.style.bottom === AUTO) continue;
    const containing = containingBlockFor(box);
    if (containing && !heldBack(tree, containing)) return true;
  }
  return false;
}

/** Every out-of-flow box in a tree, found once. */
function outOfFlowOf(tree: BoxTree): Box[] {
  let boxes = OUT_OF_FLOW.get(tree);
  if (!boxes) {
    boxes = [];
    const stack: Box[] = [tree.root];
    while (stack.length) {
      const box = stack.pop()!;
      if (box.outOfFlow) boxes.push(box);
      for (const child of box.children) stack.push(child);
    }
    OUT_OF_FLOW.set(tree, boxes);
  }
  return boxes;
}

/**
 * Where a block-level child was last laid out in its parent's flow,
 * against the parent's content top then — which holds wherever the parent
 * has moved since, as long as the child has not been laid out again
 * (`FLOW_GEN`). A layout that keeps the child (`keepAbove`) resumes the
 * flow after it from here: as far below the content top as it ended, with
 * the margin it left hanging, and the floats as low as they reached.
 */
interface FlowPlace {
  /** The parent's flow it was laid out in, or kept by (`FLOW_GEN`). */
  gen: number;
  /** Its border box's top and bottom, against the content top. */
  top: number;
  bottom: number;
  /** The margin hanging below it, for the next sibling to collapse with. */
  hanging: MarginStrut;
  /** How low the floats of the flow it is in reached once it was laid out,
   *  against the content top; -Infinity where none had. */
  floats: number;
  /** Whether its margins collapsed through it, empty: the flow does not
   *  resume after one, where the margins hanging are more than its own. */
  through: boolean;
}

const FLOW_PLACE = new WeakMap<Box, FlowPlace>();

/** How many times each box's flow was laid out, not counting probes: what a
 *  child's place is current against (`FlowPlace.gen`). */
const FLOW_GEN = new WeakMap<Box, number>();

/**
 * What a block's last layout in its parent's flow was laid out from, from
 * outside it, and what of the box it left that its parent's flow resets
 * before it lays a child out (`resolveEdges`): where nothing it is laid out
 * from has changed, and neither it nor anything in it has been laid out
 * since or changed (`Box.layoutSerial`, `forgetSizes`), a later layout of
 * the flow keeps it, moved to where it goes (`reuseLaid`). A page's script
 * that changes one card lays out the card and the boxes it is in, and moves
 * the rest.
 */
interface Laid {
  /** The layout it was laid out in (`LayoutContext.reusePass`). */
  pass: number;
  serial: number;
  /** The room its flow had, its percentage height base, the viewport's
   *  height and the scale and the fonts it was laid out at. Not the
   *  viewport's width, which is `mayKeepLaid`'s to say. */
  width: number;
  base: number;
  under: LaidUnder;
  scale: number | undefined;
  fonts: FontsLike | null;
  /** Where it went from where the flow had it, before any offset moved it. */
  dx: number;
  dy: number;
  /** Its bottom margin with what came out through its bottom edge. */
  marginBottom: number;
  bottomStrut: MarginStrut | null;
  /** The first box out of the flow it left waiting to be positioned, where
   *  it left any, and where: a later layout in this one finds it there, or
   *  a clamp took it back (`layoutClamped`). */
  queued: { at: number; first: LayoutContext['positioned'][number] } | null;
}

const LAID = new WeakMap<Box, Laid>();

/**
 * What a block in a flow came to the last time a probe laid it out
 * (`LayoutContext.probing`), for a later probe of the flow to take in its
 * place (`STOOD`). A probe lays a box out at no width, or at none at all,
 * to measure it, and all it reads of a block in a flow is how far down it
 * reaches, the margin it leaves hanging and what the walk of what it drew
 * finds (`intrinsicWidth`) — the same at the same room, while nothing in it
 * changes (`forgetSizes`, which drops this). Laid out again instead, at
 * each probe, the blocks of a webmail page's list of messages were laid out
 * at no width whenever a spinner came into its footer, and again at their
 * own width by the layout after, which could keep none of them.
 */
interface Stand {
  /** What it was laid out from, as a kept block's (`Laid`). */
  width: number;
  base: number;
  under: LaidUnder;
  scale: number | undefined;
  fonts: FontsLike | null;
  /** The layout it is of (`Box.layoutSerial`), which a walk reads. */
  serial: number;
  /** How far below where the flow placed it its border box reaches, and
   *  its bottom margin with what came out through its bottom edge. */
  bottom: number;
  hanging: MarginStrut;
  /** What a walk of that layout reads of it (`intrinsicWidth`), read as
   *  it was laid out: its width, the widest thing in it — NaN for a box
   *  with a width of its own, whose walk reads none — and whether a line
   *  in it was cut short. */
  boxWidth: number;
  inner: number;
  cut: boolean;
}

/** By box, what it came to in the probes that laid it out, one a room, the
 *  latest last: no more than `STAND_WIDTHS` of them. A probe of a pane
 *  measures what is in it at its widest and its narrowest, and lays it out
 *  at the widths between that a flex layout asks of it, each in its turn. */
const STANDS = new WeakMap<Box, Stand[]>();
const STAND_WIDTHS = 8;

/** Note what a box came to in a probe, in place of one in that room. */
function noteStand(box: Box, stand: Stand): void {
  const made = STANDS.get(box);
  if (made === undefined) {
    STANDS.set(box, [stand]);
    return;
  }
  const at = made.findIndex((one) => one.width === stand.width);
  if (at >= 0) made.splice(at, 1);
  made.push(stand);
  if (made.length > STAND_WIDTHS) made.shift();
}

/** What a box came to in the probe layout it has, where one noted it. */
function standOf(box: Box): Stand | undefined {
  const made = STANDS.get(box);
  if (made === undefined) return undefined;
  for (let i = made.length - 1; i >= 0; i -= 1) {
    if (made[i].serial === box.layoutSerial) return made[i];
  }
  return undefined;
}

/**
 * The blocks a probe took from what they came to before (`Stand`), where
 * their flow did not lay them out: they are where the last layout of them
 * put them, which is not where the probe has them, and a walk of what the
 * probe drew reads them from this. Until their flow places them again.
 */
const STOOD = new WeakMap<Box, Stand>();
/** Whether any block has stood for a probe, so that a flow with none to
 *  forget asks nothing. */
let stoodAny = false;

/** How many probes are under way (`measureIntrinsicWidth`), whose walks
 *  read the blocks that stood for them: a walk of a layout reads what it
 *  laid out. And how many of them take none: the shrink-to-fit probe's
 *  caller reads the words of what it laid out (`wordBound`), which a block
 *  that stood has as its last layout set them. */
let probesOpen = 0;
let standsOff = 0;

/** How many blocks probes took from what they came to before, for a test
 *  to count. */
let standsTaken = 0;
export function standsMade(): number {
  return standsTaken;
}

/** How many layouts were left partial — a block stood in them, or a probe
 *  kept a layout one stood in — counted, so that a layout around one can
 *  tell it is partial too (`LAID_OWN`, a flex item's `Natural`), which no
 *  layout but a probe may keep. */
let partials = 0;
export function partialsMade(): number {
  return partials;
}
/** Note that a probe kept a partial layout, which makes the one around it
 *  partial. */
export function keptPartial(): void {
  partials += 1;
}

/** What a block came to in a probe, where it is to stand for it in this
 *  one: laid out in the same room, from the same things. */
function standFor(child: Box, ctx: LayoutContext, width: number): Stand | null {
  const made = STANDS.get(child);
  if (made === undefined) return null;
  let stand: Stand | undefined;
  for (let i = made.length - 1; i >= 0; i -= 1) {
    if (made[i].width === width) {
      stand = made[i];
      break;
    }
  }
  if (
    stand === undefined ||
    !Object.is(stand.base, child.percentHeightBase) ||
    !heightHolds(stand.under, ctx) ||
    stand.scale !== ctx.scale ||
    stand.fonts !== ctx.engine
  ) {
    return null;
  }
  return stand;
}

/**
 * Note what a block a probe has just laid out came to (`Stand`), its walk
 * read now: what a later walk of the probe reads of it then, as of a block
 * that stood, each block once. A walk at the narrowest reads none of this
 * (`narrowestOf`), which no layout says.
 */
function standAfter(
  child: Box,
  ctx: LayoutContext,
  width: number,
  childY: number,
): void {
  let inner = NaN;
  const seen = { cut: false };
  if (typeof child.style.width !== 'number') {
    inner = intrinsicWidth(child, seen);
  }
  noteStand(child, {
    width,
    base: child.percentHeightBase,
    under: ctx.under,
    scale: ctx.scale,
    fonts: ctx.engine,
    serial: child.layoutSerial,
    bottom: child.y + child.height - childY,
    hanging: bottomOf(child),
    boxWidth: child.width,
    inner,
    cut: seen.cut,
  });
}

/**
 * The viewport's height a layout was made under, and whether the layout
 * read it (`LayoutResult.readsViewportHeight`), which it is taken to have
 * until it ends. One a layout, shared by every box it notes it laid out
 * (`Laid`, a grid item's `ItemLaid`, a flex item's `Natural`): a layout
 * that read none of it laid them out as it would have under any height,
 * and a later layout keeps them under another (`heightHolds`). A pane's
 * height is a frame's to decide, after the document's first layout, and
 * the layout after that one laid out again every block, every flex item
 * and every grid item the first had laid out.
 */
export interface LaidUnder {
  height: number;
  read: boolean;
}

/** Whether what a layout made under `under` holds under this layout's
 *  viewport: the same height, or one that layout read none of. */
function heightHolds(under: LaidUnder, ctx: LayoutContext): boolean {
  if (under.height !== ctx.viewportHeight && under.read) return false;
  // a frame kept in a block reads the height it read, or a move of the
  // height would lay nothing out (`frameInlineSize`)
  if (framed.any && under.read) ctx.readViewportHeight = true;
  return true;
}

/** Every layout that may keep blocks counted, for `Laid.pass`. */
let reusePasses = 0;

/** How many blocks layouts have kept (`reuseLaid`), for a test to say that
 *  some were. */
let keptBlocks = 0;
export function blocksKept(): number {
  return keptBlocks;
}

/** Note what a block just laid out in a flow at `contentLeft` and `y`, in
 *  `width`, was laid out from (`Laid`). */
function noteLaid(
  child: Box,
  ctx: LayoutContext,
  contentLeft: number,
  y: number,
  width: number,
  /** How many boxes waited to be positioned before it was laid out. */
  waiting: number,
): void {
  if (ctx.blockers!.blockers.has(child)) {
    LAID.delete(child);
    return;
  }
  LAID.set(child, {
    pass: ctx.reusePass!,
    serial: child.layoutSerial,
    width,
    base: child.percentHeightBase,
    under: ctx.under,
    scale: ctx.scale,
    fonts: ctx.engine,
    dx: child.x - contentLeft,
    dy: child.y - y,
    marginBottom: child.marginBottom,
    bottomStrut: child.bottomStrut,
    queued:
      ctx.positioned.length > waiting
        ? { at: waiting, first: ctx.positioned[waiting] }
        : null,
  });
}

/**
 * Keep a block an earlier layout laid out (`Laid`), where it goes in this
 * one: moved there with all it holds, from where it is drawn — its own
 * relative offset and those of the boxes it is in are put on again after
 * the flow, and the offsets inside it are still on, which those passes
 * leave (`LayoutContext.reused`). False where anything it was laid out from
 * is otherwise, or it was laid out since: a probe of what it is in.
 *
 * Laid out earlier in this layout it is only moved: none of that is on it
 * yet, what is in it is waiting to be positioned already, and its ink is no
 * ink of before to keep. A flex box lays out what it holds at each size it
 * asks about, one inside another: a mail page's list of messages was laid
 * out ten times a layout at the one width, nine of them for nothing. But
 * not in a layout that stops, which may have cut it short for being lower
 * down than it is now.
 */
function reuseLaid(
  child: Box,
  ctx: LayoutContext,
  contentLeft: number,
  y: number,
  width: number,
): boolean {
  const laid = LAID.get(child);
  if (
    laid === undefined ||
    laid.serial !== child.layoutSerial ||
    laid.width !== width ||
    !Object.is(laid.base, child.percentHeightBase) ||
    !heightHolds(laid.under, ctx) ||
    laid.scale !== ctx.scale ||
    laid.fonts !== ctx.engine ||
    ctx.blockers!.blockers.has(child) ||
    !Number.isFinite(child.x) ||
    !Number.isFinite(child.y)
  ) {
    return false;
  }
  if (laid.pass !== ctx.reusePass) keepLaid(child, ctx);
  else if (
    ctx.until !== undefined ||
    (laid.queued && ctx.positioned[laid.queued.at] !== laid.queued.first)
  ) {
    return false;
  }
  child.marginBottom = laid.marginBottom;
  child.bottomStrut = laid.bottomStrut;
  moveTo(child, contentLeft + laid.dx, y + laid.dy);
  return true;
}

/**
 * Whether a layout may keep a box an earlier layout laid out, as that one
 * left it (`reuseLaid`, and a flex item's `keptNatural`): where both keep
 * boxes (`LayoutContext.reusePass`), at the same viewport height — or at
 * another the earlier one read none of (`heightHolds`) — scale and fonts,
 * the box no blocker (`reuseBlockers`) and placed where it can be moved
 * from. What the box itself was laid out from is the caller's to
 * compare, and whether anything in it changed since is `forgetSizes`'.
 *
 * At any viewport width. Only a box placed against the initial containing
 * block reads one (`containingRect`), and that box is a blocker, as all
 * around it are; a `vw` is a style's, whose restyle forgets what it changes
 * (`forgetSizes`). Compared, every step of a window's edge threw away
 * every kept layout there was, and a mail page laid its 2,499 senders and
 * its rows out again at the widths they already had: 13,000 boxes for 4px.
 */
export function mayKeepLaid(
  box: Box,
  ctx: LayoutContext,
  was: {
    pass: number;
    under: LaidUnder;
    scale: number | undefined;
    fonts: FontsLike | null;
  },
  /** Whether a probe may keep it: its caller has asked what a probe needs
   *  of the layout it keeps (`keepsNatural`). */
  probes = false,
): boolean {
  return (
    ctx.reusePass !== undefined &&
    (probes || !ctx.probing) &&
    !Number.isNaN(was.pass) &&
    was.pass !== ctx.reusePass &&
    heightHolds(was.under, ctx) &&
    was.scale === ctx.scale &&
    was.fonts === ctx.engine &&
    !ctx.blockers!.blockers.has(box) &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y)
  );
}

/**
 * Keep a box an earlier layout laid out (`mayKeepLaid`), for its caller to
 * move where this layout puts it: what it holds, where its layout put it,
 * as a flow reads a block it has just laid out — the offsets the passes
 * after the last flow put on are taken off, and put on again after this
 * one, once a layout however many times it keeps the box — and the boxes
 * out of the flow in it, which this layout does not lay out, counted in
 * the document's reach.
 */
export function keepLaid(box: Box, ctx: LayoutContext): void {
  if (ctx.reused!.has(box)) return;
  const { holders, moved } = ctx.blockers!;
  if (ctx.offsets !== false && moved.has(box)) unoffsetHeld(box, moved);
  ctx.reused!.add(box);
  if (holders.has(box)) keptPositionedIn(box, holders, ctx.keptPositioned!);
  keptBlocks += 1;
}

/**
 * The boxes no layout keeps (`LayoutContext.blockers`), the ones that hold
 * a box out of the flow (`Blockers.holders`), and the ones the passes after
 * a flow move something in (`Blockers.moved`). A box out of the flow is
 * laid out after the flow against its containing block, so a block that
 * holds one can be kept where that block is in it too, and the box moves
 * with it; the boxes between the two cannot, and neither can the box. A
 * box in the top layer, or fixed to the viewport, is placed against no box
 * in the document, and a relative or a sticky inline box broken around
 * blocks moves blocks beside what holds it (`CUT_BLOCKS`): every box around
 * one is a blocker. A sticky box is none: where it sticks is worked out
 * again after every flow, from where the flow put it, and a kept block
 * takes the shift off it as it takes a relative offset off
 * (`unoffsetHeld`). Once a tree.
 */
function reuseBlockers(tree: BoxTree): Blockers {
  let found = BLOCKERS.get(tree);
  if (found) return found;
  found = {
    blockers: new Set<Box>(),
    holders: new Set<Box>(),
    moved: new Set<Box>(),
  };
  BLOCKERS.set(tree, found);
  noteBlockers([tree.root], found);
  return found;
}

/** `reuseBlockers` of the boxes on `stack` and all they hold: where one
 *  is placed against what is outside it, the boxes between, and those that
 *  hold it; and where one is moved after the flow, it and those that hold
 *  it. One loop with all of it in it: a walk of every box of a tree, whose
 *  step a function of its own made a loop that its optimized code left at
 *  every box with children, and was thrown away for leaving. */
function noteBlockers(
  stack: Box[],
  { blockers, holders, moved }: Blockers,
): void {
  while (stack.length) {
    const box = stack.pop()!;
    const position = box.style.position;
    if (movesAfterFlow(box)) {
      for (let up: Box | null = box; up && !moved.has(up); up = up.parent) {
        moved.add(up);
      }
    }
    // what is in a flow in another writing mode is laid out with what holds
    // it, or moved whole with it where that is kept: its heights run across
    // the page, so no block in it is kept alone
    if (framed.any && FRAMES.has(box)) {
      const held = [box];
      while (held.length) {
        const at = held.pop()!;
        blockers.add(at);
        for (const child of at.children) held.push(child);
      }
    }
    if (
      box.outOfFlow ||
      box.topLayer ||
      // an inline box broken around blocks moves them with its offset,
      // and they are beside the block that holds it (`CUT_BLOCKS`)
      ((position === 'relative' || position === 'sticky') &&
        box.kind === 'inline' &&
        box.cut !== 0)
    ) {
      const placed = box.outOfFlow || box.topLayer;
      // the box it is placed against, which holds it whole
      const containing =
        placed && !box.topLayer && box.style.position !== 'fixed'
          ? containingBlockFor(box)
          : null;
      if (!placed || !movesWithFlow(box, containing)) {
        let at: Box | null = box;
        for (; at && at !== containing; at = at.parent) blockers.add(at);
      }
      if (placed) {
        for (let up = box.parent; up && !holders.has(up); up = up.parent) {
          holders.add(up);
        }
      }
    }
    for (const child of box.children) stack.push(child);
  }
}

/**
 * Whether an absolute box is placed by nothing of the box it is placed
 * against (`containing`), so that a block kept around it moves it where the
 * block goes (`translate`), as its own layout would have: one with no
 * inset is where the flow put it (CSS 2.1 10.3.7, 10.6.4), and one whose
 * size and edges are lengths of its own is as large whatever that box
 * comes to. A link's `sr-only` label for a screen reader is one —
 * `position: absolute; width: 1px; height: 1px; margin: -1px` — and with
 * it a blocker, every paragraph, list and aside around such a link on
 * joshwcomeau.com was laid out again at every layout of the page, at rest
 * and at each step of a drag. Not where a scroll container is between the
 * two, whose scroll leaves the box where it is (`escapes`).
 */
function movesWithFlow(box: Box, containing: Box | null): boolean {
  const s = box.style;
  if (s.position !== 'absolute' || box.topLayer) return false;
  if (s.top !== AUTO || s.right !== AUTO || s.bottom !== AUTO) return false;
  if (s.left !== AUTO) return false;
  if (typeof s.width !== 'number' || typeof s.height !== 'number') {
    return false;
  }
  if (s.widthKeyword || s.heightKeyword) return false;
  if (s.minWidthKeyword || s.maxWidthKeyword) return false;
  if (s.minHeightKeyword || s.maxHeightKeyword) return false;
  if (isPct(s.minWidth) || isPct(s.minHeight)) return false;
  if (s.maxWidth !== 'none' && isPct(s.maxWidth)) return false;
  if (s.maxHeight !== 'none' && isPct(s.maxHeight)) return false;
  for (const edge of [
    s.marginTop,
    s.marginRight,
    s.marginBottom,
    s.marginLeft,
    s.paddingTop,
    s.paddingRight,
    s.paddingBottom,
    s.paddingLeft,
  ]) {
    if (isPct(edge)) return false;
  }
  for (let at = box.parent; at && at !== containing; at = at.parent) {
    if (isScroller(at)) return false;
  }
  return true;
}

/**
 * `reuseBlockers` of a tree a build of subtrees made from `from`
 * (`buildSubtrees`), from `from`'s: its boxes but those it `replaced`, and
 * what each of the `added` boxes is and holds — where a box around one of
 * them stays a blocker for what a replaced box was, which keeps less and
 * never more. Nothing where `from` was never laid out keeping blocks: the
 * walk of the new tree is its first layout's. A stream's chunk makes a new
 * tree, and a walk of all of it for this was a twentieth of its layout.
 */
export function carryBlockers(
  from: BoxTree,
  to: BoxTree,
  replaced: readonly ReadonlySet<Box>[],
  added: readonly Box[],
): void {
  const was = BLOCKERS.get(from);
  if (!was) return;
  const found: Blockers = {
    blockers: new Set(was.blockers),
    holders: new Set(was.holders),
    moved: new Set(was.moved),
  };
  for (const boxes of replaced) {
    for (const box of boxes) {
      found.blockers.delete(box);
      found.holders.delete(box);
      found.moved.delete(box);
    }
  }
  noteBlockers([...added], found);
  BLOCKERS.set(to, found);
}

/** What `reuseBlockers` found of a tree. */
interface Blockers {
  blockers: Set<Box>;
  holders: Set<Box>;
  /**
   * Every box the passes after a flow move, or move what it holds
   * (`movesAfterFlow`), and every box that holds one: the boxes those
   * passes, and the one that takes what they did off a kept block
   * (`unoffsetHeld`), walk. A box outside it has nothing in it any of them
   * moves, and they pass it by: joshwcomeau.com's article is 3,380 boxes,
   * a tenth of them in it, and each walked all of them at every layout of
   * the page.
   */
  moved: Set<Box>;
}

const BLOCKERS = new WeakMap<BoxTree, Blockers>();

/**
 * Whether the passes after a flow move a box, or what it holds
 * (`Blockers.moved`): a relative box an inset moves — one with none moves
 * nowhere, and joshwcomeau.com's inline code and links are 314 of them — a
 * sticky one, a transformed one but for an inline box, which no transform
 * moves, and a scroll container, whose scroll moves what it holds.
 */
function movesAfterFlow(box: Box): boolean {
  if (box.kind === 'text' || box.kind === 'break') return false;
  const style = box.style;
  const position = style.position;
  if (position === 'sticky') return true;
  if (
    position === 'relative' &&
    (style.top !== AUTO ||
      style.right !== AUTO ||
      style.bottom !== AUTO ||
      style.left !== AUTO)
  ) {
    return true;
  }
  return (box.kind !== 'inline' && transformed(style)) || isScroller(box);
}

/**
 * Note that boxes restyled in place may be ones the passes after a flow
 * move now (`Blockers.moved`): a transform a hover or an animation put on
 * it, or an inset on a relative box, which a restyle in place takes where
 * nothing else about the box changes (`hoverChange`, `lengthChange`).
 * Whatever else makes a box one — a position, an overflow — builds the
 * boxes again, and the tree it builds is noted as it is laid out. Never
 * taken out: a box in it that moves nothing costs a walk.
 */
export function noteMoving(tree: BoxTree, boxes: Iterable<Box>): void {
  const moved = BLOCKERS.get(tree)?.moved;
  if (!moved) return;
  for (const box of boxes) {
    if (moved.has(box) || !movesAfterFlow(box)) continue;
    for (let up: Box | null = box; up && !moved.has(up); up = up.parent) {
      moved.add(up);
    }
  }
}

/**
 * Take off what the passes after a flow moved the boxes in a block by —
 * their transforms' translations, their relative and sticky offsets and
 * their scrolls (`applyRelativeOffsets`, `restickAll`,
 * `applyScrollOffsets`) — and not the block's own, which moves all it
 * holds alike: what it holds is where the block's last layout put it, from
 * its corner, and a flow that reads it finds it there. Each is a move of
 * the same boxes, and moves add up in any order. A relative offset is
 * worked out again from sizes a kept block keeps; a sticky one is not,
 * since where it sticks turns on where the block is, so it is taken off by
 * how far it moved the box (`STUCK`), which the element's scroll of the
 * pane (`restickToViewport`) and a scroll container's (`restickWithin`)
 * keep as they move it. What a box in the top layer or an inline broken
 * around blocks moves is in no kept block (`reuseBlockers`).
 */
function unoffsetHeld(block: Box, moved: ReadonlySet<Box>): void {
  for (const child of block.children) {
    if (moved.has(child)) unoffset(child, moved);
  }
  scrollBack(block, translate);
}

function unoffset(box: Box, moved: ReadonlySet<Box>): void {
  for (const child of box.children) {
    if (moved.has(child)) unoffset(child, moved);
  }
  if (box.kind === 'text' || box.kind === 'break') return;
  const style = box.style;
  if (transformed(style) && box.kind !== 'inline') {
    const [dx, dy] = translationOf(box);
    if (dx || dy) translate(box, -dx, -dy, inTopLayer);
  }
  if (style.position === 'relative') {
    const [dx, dy] = relativeOffset(box);
    if (dx || dy) {
      offsetBox(box, -dx, -dy, false);
      if (box.kind === 'inline') offsetInline(box, -dx, -dy);
    }
  } else if (style.position === 'sticky') {
    const stuck = STUCK.get(box);
    if (stuck) {
      // where the flow has it, and no shift on, until the passes after
      // this flow work one out
      STUCK.delete(box);
      const [dx, dy] = stuck;
      if (dx || dy) {
        offsetBox(box, -dx, -dy, true);
        if (box.kind === 'inline') offsetInline(box, -dx, -dy);
      }
    }
  }
  scrollBack(box, translate);
}

/** The boxes out of the flow in a block a layout kept, which it lays out
 *  none of and counts in the document's reach (`LayoutContext.keptPositioned`):
 *  found down the boxes that hold one (`Blockers.holders`). */
function keptPositionedIn(
  box: Box,
  holders: ReadonlySet<Box>,
  into: Box[],
): void {
  for (const child of box.children) {
    if (child.outOfFlow) into.push(child);
    if (holders.has(child)) keptPositionedIn(child, holders, into);
  }
}

/** Whether a flow is in a multicol container, or is one's. */
function inMulticol(box: Box): boolean {
  for (let at: Box | null = box; at; at = at.parent) {
    if (at.style.columns) return true;
  }
  return false;
}

/**
 * The blocks a layout made while the width is still moving keeps above
 * where it starts, by the box whose flow they lead (`LayoutContext.keep`):
 * the run of first children of each box on the way down to what is at
 * `top` — the top of what can be seen, in document coordinates — that
 * ended above it when last laid out, with their ink. What is kept is not
 * laid out: it keeps its boxes and its height, so what can be seen is laid
 * out where it was, whatever a page above it comes to at the new width,
 * and a layout at the width the drag rests at lays it out again
 * (`layoutDocument`, `_stopAt`). Wikipedia's longest articles reflowed at
 * the rate of all of the article above the paragraph being read, and laid
 * out whole at every step of a drag past half way down.
 *
 * A run stops before a box laid out as no part of its parent's flow — out
 * of the flow, or not since the parent's last layout — and before one
 * that holds a box placed against something outside it, a fixed box or
 * an absolute one with offsets, which would be left where it was. And it
 * ends with a block the flow can resume after: not a float, not an empty
 * block its margins collapse through, and none whose floats reach down to
 * the first child laid out, since the floats of what is kept are not in
 * the flow that is laid out. The walk goes on down into the block after
 * the run that reaches below `top` — by its ink, since a box as tall as the
 * viewport, `html { height: 100% }`, holds a document that runs on below
 * it — and into each item of a flex, grid or table container that does,
 * since a grid's columns are side by side: a page's column of text, and
 * the menu beside it. A multicol container, an inline formatting context
 * and a line-clamp container are laid out whole.
 */
function keepAbove(tree: BoxTree, top: number): Map<Box, number> | null {
  const keep = new Map<Box, number>();
  const root = tree.root;
  keepIn(root, root.contentY, 0, top, escapingHolders(tree), keep, 0);
  return keep.size ? keep : null;
}

/**
 * `keepAbove` in one box: `contentTop` is where its content starts now, in
 * document coordinates, and `drift` how far that is from the coordinates
 * its last layout gave it — a box kept is not moved with its parent, and
 * neither is anything in it, so what it holds is off by as much.
 */
function keepIn(
  box: Box,
  contentTop: number,
  drift: number,
  top: number,
  escaping: Set<Box>,
  keep: Map<Box, number>,
  depth: number,
): void {
  if (depth > MAX_KEEP_DEPTH) return;
  if (box.style.columns || box.style.lineClamp !== null) return;
  // what a scroll container holds is where it is scrolled to
  if (isScroller(box)) return;
  if (box.kind === 'flex' || box.kind === 'table') {
    // placed by their container's algorithm, and laid out with it
    for (const item of box.children) {
      if (item.outOfFlow || item.kind === 'text') continue;
      const at = item.y + drift;
      if (at > top || at + reachOf(item) <= top) continue;
      const inner = item.contentY + drift;
      keepIn(item, inner, drift, top, escaping, keep, depth + 1);
    }
    return;
  }
  if (box.kind !== 'block' || establishesInlineContext(box)) return;
  const children = box.children;
  const gen = FLOW_GEN.get(box);
  // the run that ended above `top`, ink and all, and the last block in it
  // the flow can resume after
  let resume = 0;
  for (let run = 0; run < children.length; run += 1) {
    const child = children[run];
    if (child.outOfFlow || child.kind === 'text' || escaping.has(child)) break;
    const place = FLOW_PLACE.get(child);
    if (!place || place.gen !== gen) break;
    if (
      contentTop + place.bottom > top ||
      contentTop + place.top + reachOf(child) > top
    ) {
      break;
    }
    if (!child.isFloat && !place.through) resume = run + 1;
  }
  // …whose floats end above the first child laid out
  for (; resume > 0; resume -= 1) {
    const next = FLOW_PLACE.get(children[resume]);
    if (!next || next.gen !== gen) continue;
    const last = FLOW_PLACE.get(children[resume - 1])!;
    if (
      !children[resume - 1].isFloat &&
      !last.through &&
      last.floats <= next.top
    ) {
      break;
    }
  }
  if (resume > 0 && resume < children.length) keep.set(box, resume);
  // on down into the block what can be seen starts in, past what ends
  // above it after the run, which is laid out
  for (let i = resume; i < children.length; i += 1) {
    const child = children[i];
    if (child.outOfFlow || child.isFloat || child.kind === 'text') continue;
    const place = FLOW_PLACE.get(child);
    if (!place || place.gen !== gen) return;
    const at = contentTop + place.top;
    if (at > top) return;
    if (at + reachOf(child) <= top) continue;
    const inner = at + child.borderTop + child.padTop;
    keepIn(child, inner, at - child.y, top, escaping, keep, depth + 1);
    return;
  }
}

/** How deep `keepAbove` goes before it stops looking: deeper than any
 *  document nests the paragraph it is reading in. */
const MAX_KEEP_DEPTH = 64;

/** How far below its own top what a box draws reaches, as last laid out
 *  and drawn: its height, or its ink where what it holds overflows it. */
function reachOf(box: Box): number {
  const ink = box.boundsHeight > 0 ? box.boundsY + box.boundsHeight - box.y : 0;
  return Math.max(box.height, ink);
}

/**
 * The box at the top of what can be seen, as the tree was last laid out —
 * what a layout at another width keeps where it is on screen: CSS Scroll
 * Anchoring 1's anchor node (6.2), but for floats, which do not move with
 * the flow. Walked in tree order from the root: a block that starts at or
 * below `top`, in document coordinates, is the anchor; one that reaches
 * across it is looked in, and is the anchor where it holds no block but
 * lines of text; one in which nothing reaches below `top` — a menu column
 * beside the text, its links at the page's top — is passed over for the
 * next. Null for a document with no block reaching below `top`.
 */
export function anchorAt(tree: BoxTree, top: number): Box | null {
  framed.any = tree.vertical;
  return anchorIn(tree.root, top, 0);
}

function anchorIn(box: Box, top: number, depth: number): Box | null {
  if (depth > MAX_KEEP_DEPTH) return null;
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat || child.kind === 'text') continue;
    if (isInlineLevel(child) || !(child.height > 0)) continue;
    if (child.y + reachOf(child) <= top) continue;
    if (child.y >= top) return child;
    // what a vertical flow holds is laid out across the page, and moves
    // with its root (`layoutFramed`)
    if (framed.any && FRAMES.has(child)) return child;
    const inside = anchorIn(child, top, depth + 1);
    if (inside) return inside;
    if (establishesInlineContext(child) || child.kind === 'replaced') {
      return child;
    }
  }
  return null;
}

/** Note where a child of a flow was laid out (`FLOW_PLACE`), against the
 *  flow's content top. *//** Note where a child of a flow was laid out (`FLOW_PLACE`), against the
 *  flow's content top. */
function placed(
  child: Box,
  gen: number,
  contentTop: number,
  hanging: MarginStrut,
  floats: FloatContext,
  through: boolean,
): void {
  const reach = floats.bottom;
  FLOW_PLACE.set(child, {
    gen,
    top: child.y - contentTop,
    bottom: child.y + child.height - contentTop,
    hanging,
    floats: reach === -Infinity ? -Infinity : reach - contentTop,
    through,
  });
}

/**
 * The boxes that hold a box placed against something outside them: a
 * fixed box, drawn where the viewport is wherever the flow has it, or an
 * absolute one whose offsets put it against a containing block further
 * out. Kept (`keepAbove`), the box would be left where it was, wherever
 * what it is placed against went.
 */
function escapingHolders(tree: BoxTree): Set<Box> {
  let holders = HOLDERS.get(tree);
  if (holders) return holders;
  holders = new Set<Box>();
  HOLDERS.set(tree, holders);
  for (const box of outOfFlowOf(tree)) {
    const fixed = box.style.position === 'fixed' || box.topLayer;
    if (!fixed && box.style.top === AUTO && box.style.bottom === AUTO) {
      continue;
    }
    const containing = fixed ? null : containingBlockFor(box);
    for (let at = box.parent; at && at !== containing; at = at.parent) {
      if (holders.has(at)) break;
      holders.add(at);
    }
  }
  return holders;
}

/** By tree, what `escapingHolders` found, once: what is out of the flow is
 *  the tree's (`outOfFlowOf`). */
const HOLDERS = new WeakMap<BoxTree, Set<Box>>();

/**
 * Lay the whole document out at a width — or, given `until`, what starts
 * above it, with the rest set aside (`setAside`); and given `above`, the
 * top of what can be seen, what ends below it, with the blocks that ended
 * above it kept as they were (`keepAbove`). Given `seenAt`, a box of a tree
 * no layout has laid out, where what can be seen starts, it stops nowhere
 * before that box is laid out, and `below` past where it lands: the boxes
 * a breakpoint built have no places to keep, and the text above the box
 * may come to more at the new band than `until` allowed for.
 */
export function layoutDocument(
  tree: BoxTree,
  fonts: FontsLike | null,
  viewportWidth: number,
  viewportHeight: number,
  scale = 1,
  until?: number,
  above?: number,
  seenAt?: { box: Box; below: number },
): LayoutResult {
  // what the last layout set aside is laid out, or set aside again
  putBack(tree);
  // whether any box's layout asks whether it holds a frame
  framed.any = tree.vertical;
  const cuts =
    (until !== undefined || above !== undefined) && !LAID_WHOLE.has(tree);
  if (cuts && !OUT_OF_FLOW.has(tree)) escapes(tree);
  const keep = cuts && above !== undefined ? keepAbove(tree, above) : null;
  const reusing = !cuts && !tree.anchors && !tree.firstLine && !tree.foreign;
  const ctx: LayoutContext = {
    fonts,
    engine: fonts?.engine ?? fonts,
    scale,
    viewportWidth,
    viewportHeight,
    under: { height: viewportHeight, read: true },
    positioned: [],
    stopping: cuts,
    layoutSubtree: (box, width, containing) =>
      layoutSubtree(box, ctx, width, containing),
    firstLine: tree.firstLine,
    firstLineStyler: tree.firstLineStyler,
    nestedOutOfLine: tree.nestedOutOfLine,
    clipText: tree.clipText,
    anchorRoot: tree.anchors ? tree.root : null,
    ...(reusing
      ? {
          reusePass: ++reusePasses,
          reused: new Set<Box>(),
          blockers: reuseBlockers(tree),
          keptPositioned: [],
          offsets: tree.relative || scrollsAny(tree),
        }
      : null),
    ...(tree.anchors
      ? {
          viewport: viewportOf(tree),
          scrollOf: (box: Box) => wantedScroll(tree, box),
          question: QUESTIONS.has(tree),
        }
      : null),
    ...(cuts
      ? {
          until,
          setAside: new Map<Box, Box[]>(),
          pass: ++setAsidePasses,
          holders: escapingHolders(tree),
          scrollTopOf: (box: Box) => wantedScrollTop(tree, box),
          ...(keep ? { keep } : null),
          ...(seenAt ? { reach: seenAt } : null),
        }
      : null),
  };
  const root = tree.root;
  // what the last layout noted of anchored boxes is of where it placed
  // them, and of boxes that may be anchored no more
  if (tree.anchors) clearDefaultAnchors(root);
  // The root box is the initial containing block, and where the markup
  // writes no element for it, it stands in for one too (`Cascade.rootStyle`):
  // a fragment's `<body>`, or the `<html>` implied around a `<body>`. It is
  // laid out where that element is, inside its margins, so a border on it is
  // drawn where the margins leave it, and not at the window's edge; what
  // takes the initial containing block for its own — a box positioned
  // against it, the canvas — takes the viewport (`containingRect`,
  // `DOCUMENT_FLOW`). A body is a block in the formatting context of the
  // `<html>` around it, which has no edges of its own here, so its top
  // margin collapses with its first block's where nothing parts them, and
  // the box starts where that margin ends, as a body in an `<html>` does.
  // The root element's margins collapse with nothing (CSS 2.1 8.3.1).
  resolveEdges(root, viewportWidth);
  const body = tree.impliedHtml !== null;
  if (body) STANDS_FOR_BODY.add(root);
  const own = standInHeight(tree, viewportHeight);
  if (own !== null && own.outer !== null) handPercentBase(root, own.inner);
  if (body || tree.impliedRoot) {
    // and is as wide as that element is, a block in a containing block the
    // viewport wide — the `<html>` implied around a body, with no edges
    // here, or the initial containing block around the root element — so
    // its `width`, its limits and its `auto` margins are its own: a body
    // set `max-width: 100px; margin: 0 auto` was the window wide at its
    // left edge, where Chrome centres it. That containing block's
    // direction is the implied `<html>`'s, or the root element's own
    // (CSS 2.1 10.1), which says which margin an over-constrained width
    // leaves to the room.
    root.width = blockWidth(root, viewportWidth, viewportWidth, ctx);
    const rtl = (tree.impliedHtml ?? root.style).direction === 'rtl';
    placeBlock(root, 0, 0, viewportWidth, rtl);
  } else {
    root.x = root.marginLeft;
    root.width = Math.max(
      root.horizontalExtra,
      viewportWidth - root.marginLeft - root.marginRight,
    );
  }
  const contentWidth = root.contentWidth;
  const floats = new FloatContext(root.contentX, root.contentX + contentWidth);
  root.y = body
    ? marginOf(collapsedTopMargin(root, viewportWidth, floats))
    : root.marginTop;
  // the initial containing block is the viewport's size, which a percentage
  // height on the root element resolves against (CSS 2.1 10.1, 10.5); a
  // fragment has no root element, and the box standing in for its body has
  // the body's `auto` height to give, and a root box standing in for the
  // root element took its height, or a limit on it, of the viewport above
  let readsViewportHeight = own?.viewport === true;
  for (const child of root.children) {
    if (child.el?.name !== 'html') continue;
    child.percentHeightBase = viewportHeight;
    if (readsPercentHeight(child.style)) readsViewportHeight = true;
  }
  const flow = layoutChildren(root, ctx, floats, root.contentY, contentWidth);
  const aside = ctx.setAside;
  if (aside?.size) {
    SET_ASIDE.set(tree, { pass: ctx.pass!, boxes: aside });
    // a box set aside that something laid out places would be missing
    // from where it is drawn: this tree is laid out whole
    if (escapes(tree)) {
      LAID_WHOLE.add(tree);
      return layoutDocument(tree, fonts, viewportWidth, viewportHeight, scale);
    }
  }
  // A formatting context holds its floats and the margins of its last
  // blocks: the initial containing block, the root element. A body does
  // not: its floats hang out of it into the `<html>` around it, which
  // holds them, and its last blocks' margins collapse with its own below
  // it, as they do out of any block.
  const floatBottom = floats.bottom === -Infinity ? -Infinity : floats.bottom;
  const contains = establishesBFC(root);
  const grown =
    (contains
      ? Math.max(flow.height, floatBottom - root.contentY)
      : flow.height) + root.verticalExtra;
  // An element the root box stands in for is as tall as what it holds
  // where its height is `auto`, within its `min-height` and `max-height`
  // (CSS 2.1 10.7), as one written in the markup is: `html { min-height:
  // 100% }` is a window tall however little the page holds. A minimum
  // that sets the height has parted the last block's bottom margin from
  // the body's (`layoutChildren`), which reads the same limits.
  root.height = own === null ? grown : (own.outer ?? clampHeight(root, grown));
  const flowBottom = Math.max(
    root.y + root.height + marginOf(join(flow.hanging, root.marginBottom)),
    floatBottom,
  );
  DOCUMENT_FLOW.set(tree, { width: viewportWidth, height: flowBottom });

  // Positioned boxes last, and in the order they were found, so a later one
  // can be positioned against an earlier one's resolved rectangle.
  // Where the layout stops, one that draws nothing waits for the layout
  // at rest (`unseenWhileStopped`).
  const stopped = aside !== undefined && ctx.until !== undefined;
  let unseen: Set<Box> | null = null;
  // in a tree with anchors, in the order a browser lays them out: as each
  // containing block's layout ends, and those a positioned box holds with
  // it — so an anchor is laid out before a box anchored to it that comes
  // first in the tree, as CSS Anchor Positioning 1, 2.3 has it acceptable
  const finish = tree.anchors ? finishOrder(root) : null;
  if (finish) inFinishOrder(ctx.positioned, 0, finish);
  for (let i = 0; i < ctx.positioned.length; i += 1) {
    const { box, containing } = ctx.positioned[i];
    if (stopped && unseenWhileStopped(tree, box)) {
      holdUnseen(box, ctx);
      (unseen ??= new Set()).add(box);
      continue;
    }
    const found = ctx.positioned.length;
    layoutPositioned(box, containing, ctx);
    if (finish && ctx.positioned.length > found) {
      if (found > i + 1) {
        ctx.positioned.splice(i + 1, 0, ...ctx.positioned.splice(found));
      }
      inFinishOrder(
        ctx.positioned,
        i + 1,
        finish,
        i + 1 + ctx.positioned.length - found,
      );
    }
  }
  if (unseen) {
    UNSEEN.set(tree, unseen);
    if (!SET_ASIDE.has(tree)) {
      SET_ASIDE.set(tree, { pass: ctx.pass!, boxes: aside! });
    }
  }

  // `position: relative` moves a box after everything else has been placed
  // against where it *was* — which is the whole of what makes it relative —
  // and the ink bounds are computed after that, so culling sees where boxes
  // ended up rather than where they were laid out.
  // Where the layout keeps blocks, only down what holds a box any of the
  // passes after the flow move (`Blockers.moved`).
  const moved = ctx.blockers?.moved;
  if (tree.relative) {
    applyRelativeOffsets(root, viewportWidth, viewportHeight, fonts, moved);
  }
  // and a scroll container moves what it holds by where it is scrolled to,
  // the same way: everything else reads the boxes where they are drawn
  applyScrollOffsets(tree, translate, moved);
  // and `position-visibility` hides what it hides where all of that left
  // the boxes, with how far that scrolled the anchors noted
  if (tree.anchors) settleAnchorScrolls(root, ctx.viewport ?? null);
  updatePositionVisibility(root, ctx.viewport ?? null);
  // and a sticky box keeps to the scroll container it is in where it is
  // scrolled to, which it was placed in as though it were scrolled to its
  // start; the ones the viewport keeps are the element's to place again
  // where the pane around it is scrolled to (`restickToViewport`)
  const viewportSticky = tree.relative ? restickAll(root, moved) : null;
  if (viewportSticky) VIEWPORT_STICKY.set(tree, viewportSticky);
  else VIEWPORT_STICKY.delete(tree);
  // the ink of what nothing laid out or moved, where the layout kept
  // blocks, as the walk after the last layout found it
  const reach = computePaintBounds(
    root,
    tree.movedInline,
    moved ? { moves: moved, kept: ctx.reused! } : undefined,
  );
  if (tree.negative) hoistNegative(root);
  stackLayers(root);

  // The document is as tall as what overflows the root, not the root: an
  // `html, body { height: 100% }` a window tall holds a message longer than
  // the window, and the element sizes to all of it. Not what a box that
  // clips its overflow holds: that is its own to scroll, and the root's
  // scrollable overflow takes in a positioned box only where no box on the
  // way to it clips it (CSS Overflow 3, 2.2): an absolute box 900px down
  // an `overflow: hidden` card made a page a browser shows 400px tall run
  // on to 980, blank
  let bottom = Math.max(flowBottom, reach);
  let fixed: Box[] | null = null;
  // and the ones in the blocks it kept, which no box fixed to the viewport
  // is among (`reuseBlockers`)
  for (const box of ctx.keptPositioned ?? []) {
    if (box.style.position === 'fixed' || clipsFor(box, root).length) continue;
    bottom = Math.max(bottom, OUT_OF_FLOW_REACH.get(box) ?? box.y + box.height);
  }
  for (const { box } of ctx.positioned) {
    if (box.style.position === 'fixed') {
      if (fixedToViewport(box)) (fixed ??= []).push(box);
      continue;
    }
    if (clipsFor(box, root).length) continue;
    // and what it holds, where it does not clip it: a page set in an
    // absolute wrapper 497px tall runs on below it, and the document with
    // it — design 094 was a window tall and no taller, its text past the
    // end of the scroll
    bottom = Math.max(bottom, OUT_OF_FLOW_REACH.get(box) ?? box.y + box.height);
  }
  if (fixed) FIXED_BOXES.set(tree, fixed);
  else FIXED_BOXES.delete(tree);
  if (tree.foreign) layoutForeign(tree.foreign, fonts, scale);
  // what this layout laid out holds under another height where it read
  // none of this one's
  ctx.under.read = readsViewportHeight || ctx.readViewportHeight === true;
  return {
    width: viewportWidth,
    height: bottom,
    readsViewportHeight: ctx.under.read,
    partial: (aside?.size ?? 0) > 0,
  };
}

/**
 * The HTML of each `<foreignObject>` in the document's drawings, laid out
 * as a document of its own (`ForeignObject`): the object's `width` and
 * `height` its viewport, in device pixels — a user unit is a CSS pixel of
 * the drawing's, zoomed as its box is, and the drawing's `viewBox` and
 * transforms are a matrix the paint draws it through. Laid out again only
 * where that size moved, since nothing in the object is laid out against
 * anything outside it: its box is the containing block of all it holds,
 * fixed boxes among them (SVG 2, 23.2). Before the drawing's box is laid
 * out it has no size, and a percentage of its viewport is of none.
 */
function layoutForeign(
  objects: ReadonlyMap<Element, ForeignObject>,
  fonts: FontsLike | null,
  scale: number,
): void {
  for (const object of objects.values()) {
    const svg = object.svg;
    if (!svg.el) continue;
    const unit = scale * svg.style.effectiveZoom;
    const viewport = drawingViewport(
      svg.el,
      svg.contentWidth / unit,
      svg.contentHeight / unit,
    );
    const rect = foreignRect(object.el, viewport);
    const width = rect.width * unit;
    const height = rect.height * unit;
    if (
      object.scale === unit &&
      object.width === width &&
      object.height === height
    ) {
      continue;
    }
    object.scale = unit;
    object.width = width;
    object.height = height;
    if (width > 0 && height > 0) {
      layoutDocument(object.tree, fonts, width, height, scale);
    }
  }
}

/**
 * How tall the element the root box stands in for says it is, where that
 * is definite (CSS 2.1 10.5), and what its percentages are of. A
 * fragment's root box stands in for its body: a length, `100vh` among
 * them, or a percentage of the `<html>` implied around it where that has a
 * height of its own — a length, or a percentage of the viewport, as
 * `html, body { height: 100% }` fills a window. A document with a `<body>`
 * and no `<html>` has it standing in for the `<html>` implied around the
 * body, which is the root element: its percentages are of the viewport
 * (10.1), as an `<html>` written in the markup has them. The base is the
 * root box's own, which its `min-height` and `max-height` resolve
 * against as well, whether or not its height is set.
 *
 * Its border box, and its content box, which what it holds takes its
 * percentages of — null and NaN where the height is `auto`, and the box
 * is as tall as what is in it, within its limits; `viewport` where any of
 * it read the viewport's height. Null where the document has an `<html>`
 * of its own, and the root box is the initial containing block alone.
 */
function standInHeight(
  tree: BoxTree,
  viewportHeight: number,
): { outer: number | null; inner: number; viewport: boolean } | null {
  const html = tree.impliedHtml;
  if (!html && !tree.impliedRoot) return null;
  const root = tree.root;
  const style = root.style;
  const base = html
    ? resolveOrNull(html.height, viewportHeight)
    : viewportHeight;
  root.percentHeightBase = base ?? NaN;
  const viewport = readsPercentHeight(style) && (!html || isPct(html.height));
  const set = resolveOrNull(style.height, root.percentHeightBase);
  if (set === null) return { outer: null, inner: NaN, viewport };
  const extra = root.verticalExtra;
  const outer = clampHeight(
    root,
    style.boxSizing === 'border-box' ? Math.max(set, extra) : set + extra,
  );
  return { outer, inner: Math.max(0, outer - extra), viewport };
}

/** Whether a box's height, or a limit on it, is a percentage. */
function readsPercentHeight(style: ComputedStyle): boolean {
  const { height, minHeight, maxHeight } = style;
  return (
    isPct(height) ||
    isPct(minHeight) ||
    (maxHeight !== 'none' && isPct(maxHeight))
  );
}

/** No margin at all, shared: most joins leave a strut as it was. */
const NO_MARGIN: MarginStrut = Object.freeze({ pos: 0, neg: 0 });

/** One margin, as a strut to collapse others with. */
function marginStrut(margin: number): MarginStrut {
  if (margin > 0) return { pos: margin, neg: 0 };
  if (margin < 0) return { pos: 0, neg: margin };
  return NO_MARGIN;
}

/**
 * A strut with one more margin collapsed into it: the largest positive
 * and the most negative stay apart, and add up only where the margin is
 * read (`marginOf`) — CSS 8.3.1's rule, whole. A `-8px` pull still works
 * against a `40px` push and comes out at `32`, and a third margin after
 * them collapses with the two, not with their sum.
 */
function join(strut: MarginStrut, margin: number): MarginStrut {
  if (margin > strut.pos) return { pos: margin, neg: strut.neg };
  if (margin < strut.neg) return { pos: strut.pos, neg: margin };
  return strut;
}

/** Two sets of adjoining margins collapsed into one. */
function joinStruts(a: MarginStrut, b: MarginStrut): MarginStrut {
  if (b.pos <= a.pos && b.neg >= a.neg) return a;
  if (a.pos <= b.pos && a.neg >= b.neg) return b;
  return { pos: Math.max(a.pos, b.pos), neg: Math.min(a.neg, b.neg) };
}

/** The margin a strut comes to. */
function marginOf(strut: MarginStrut): number {
  return strut.pos + strut.neg;
}

/** A box's bottom margin as the next sibling's collapses with it, with
 *  what came out through its bottom edge where anything did. */
function bottomOf(box: Box): MarginStrut {
  return box.bottomStrut ?? marginStrut(box.marginBottom);
}

/**
 * A block's top margin as its placement uses it: its own, collapsed with
 * every margin that adjoins it (CSS 2.1 8.3.1). That is its first in-flow
 * child's while nothing parts them — no top border, no top padding, no
 * formatting context of its own, no line of text first — and that child's
 * first child's, down the chain; and past a child that is empty, its bottom
 * margin and the next child's top, because an empty block's two margins
 * adjoin each other. The children the chain went through are marked, so
 * their own layout does not apply the margin a second time. Without it
 * `<div><p>` stood a paragraph's margin lower than `<p>`, and a `<div>`
 * holding only an absolute image stood the rest of a document a body's
 * margin lower than a browser does.
 */
function collapsedTopMargin(
  box: Box,
  containingWidth: number,
  floats: FloatContext | null = null,
  y = 0,
  pending: MarginStrut = NO_MARGIN,
): MarginStrut {
  floatsPassed = false;
  floatsLeft = 0;
  floatsRight = 0;
  passedLeft = false;
  passedRight = false;
  walkFloats = floats;
  walkY = y;
  walkPending = pending;
  return absorbChildren(box, containingWidth, marginStrut(box.marginTop));
}

/** Whether the last `absorbChildren` went through every child in flow of
 *  its box, each empty and absorbed whole — which is what lets the caller
 *  take that box's bottom margin too. Read straight after the call. */
let throughAll = false;
/** Whether the walk has passed a float, and how wide the floats it passed
 *  on each side are, their margin boxes as their styles state them — NaN
 *  once one does not. Such a float is placed where the margin ends, so it
 *  moves with the margin, and a new formatting context the margin reaches
 *  next has to be able to sit beside it. */
let floatsPassed = false;
let floatsLeft = 0;
let floatsRight = 0;
/** Which sides the floats the walk passed are on. */
let passedLeft = false;
let passedRight = false;
/** Where the margin the walk collapses starts, and the floats placed before
 *  it: what says whether a cleared child in it has clearance. */
let walkFloats: FloatContext | null = null;
let walkY = 0;
let walkPending: MarginStrut = NO_MARGIN;

/**
 * Collapse into `margin` the margins of `at`'s children that adjoin its top
 * edge, marking each child it takes, and return it. The walk stops at the
 * first child something parts from the margin — a line, a clearance, a
 * border, padding or height, a formatting context of its own — and counts
 * a child empty only where its layout is sure to agree, since this runs
 * before anything is laid out and the parent is placed by what it answers:
 * an inline box with an edge, or a percentage, stops it where it might have
 * gone on.
 */
function absorbChildren(
  at: Box,
  width: number,
  margin: MarginStrut,
): MarginStrut {
  let whole = true;
  /** `at`'s content width, worked out when a child first needs it: most
   *  blocks start with text, and never do. */
  let inner = -1;
  for (const child of at.children) {
    if (child.outOfFlow) continue;
    if (child.kind === 'text') {
      if (makesNoLine(child)) continue;
      // a line box stops a margin
      whole = false;
      break;
    }
    const floated = child.isFloat;
    const inLine =
      !floated &&
      (child.kind === 'inline' ||
        child.kind === 'break' ||
        isInlineLevel(child));
    if (inLine) {
      const made = phantom(child);
      if (made === 0) {
        whole = false;
        break;
      }
      if (made === 1) continue;
    }
    if (inner < 0) {
      if (!topOpen(at)) {
        whole = false;
        break;
      }
      inner = Math.max(0, blockWidth(at, width) - at.horizontalExtra);
    }
    if (floated) {
      passFloat(child, inner);
      continue;
    }
    if (inLine) {
      passFloatsIn(child, inner);
      continue;
    }
    resolveEdges(child, inner);
    /** The margin that collapses up through the child's top edge, where
     *  it had to be worked out before the child was taken. */
    let through: MarginStrut | null = null;
    if (child.style.clear !== 'none') {
      // Where it would be with `clear: none` is where its top margin and
      // every one that comes up through its top edge put it: a large
      // margin inside it takes it past the floats as surely as its own
      // (CSS 2.1 9.5.2). The walk into it is undone where it has
      // clearance, which it passes no float for.
      const passed = passedFloats(child.style.clear);
      const walked = passed ? null : saveWalk();
      if (!passed) {
        through = absorbChildren(child, inner, join(margin, child.marginTop));
      }
      if (passed || hasClearance(child, through!)) {
        if (walked) restoreWalk(walked);
        child.topAbsorbed = 0;
        whole = false;
        break;
      }
    }
    if (
      floatsPassed &&
      (child.kind === 'replaced' || establishesBFC(child)) &&
      !fitsBeside(child, inner)
    ) {
      // it would be pushed below the floats the margin carries, so it
      // separates from them as clearance does: the margin stops above it,
      // and it sits under the floats rather than a margin under them
      child.topAbsorbed = 3;
      whole = false;
      break;
    }
    margin =
      through ?? absorbChildren(child, inner, join(margin, child.marginTop));
    if (!throughAll || !bottomOpen(child)) {
      child.topAbsorbed = 1;
      whole = false;
      break;
    }
    child.topAbsorbed = 2;
    margin = join(margin, child.marginBottom);
  }
  throughAll = whole && (inner >= 0 || topOpen(at));
  return margin;
}

/** Whether a box's top margin adjoins its first child's: a block, with no
 *  border or padding at the top and no formatting context of its own. */
function topOpen(box: Box): boolean {
  return (
    box.kind === 'block' &&
    box.borderTop === 0 &&
    box.padTop === 0 &&
    !establishesBFC(box)
  );
}

/** Whether nothing at an empty block's bottom holds its margins apart: no
 *  border, padding or height there — nor a height its ratio gives it from
 *  its width — and no marker to stand a line tall. A percentage says no,
 *  whatever it resolves to. */
function bottomOpen(box: Box): boolean {
  const { height, minHeight, aspectRatio } = box.style;
  return (
    box.borderBottom === 0 &&
    box.padBottom === 0 &&
    !box.marker &&
    (height === 0 ||
      (height === AUTO &&
        !aspectRatio &&
        box.style.heightKeyword !== 'stretch')) &&
    (minHeight === AUTO || minHeight === 0) &&
    box.style.minHeightKeyword !== 'stretch'
  );
}

/** Whether a text makes no line of its own: white space that collapses
 *  away. A no-break space is not white space to CSS, though `\s` says it
 *  is, and white space that is kept makes a line. */
function makesNoLine(text: Box): boolean {
  const ws = text.style.whiteSpace;
  return (ws === 'normal' || ws === 'nowrap') && COLLAPSIBLE.test(text.text);
}
const COLLAPSIBLE = /^[ \t\n\r\f]*$/;

/** Whether an inline box makes no line either — nothing in it that does,
 *  and no margin, border or padding on any side: the phantom line of CSS
 *  2.1 9.4.2, which a margin collapses through. `0` where it makes one,
 *  `1` where it does not, and `2` where it does not and holds a float, which
 *  the walk has to pass. The children go first: most inline boxes hold text,
 *  and that answers without a look at their edges. */
function phantom(box: Box): 0 | 1 | 2 {
  if (box.kind !== 'inline' || box.style.display !== 'inline') return 0;
  let made: 1 | 2 = 1;
  for (const child of box.children) {
    if (child.outOfFlow) continue;
    if (child.isFloat) {
      made = 2;
      continue;
    }
    if (child.kind === 'text') {
      if (makesNoLine(child)) continue;
      return 0;
    }
    const inner = phantom(child);
    if (inner === 0) return 0;
    if (inner === 2) made = 2;
  }
  const style = box.style;
  return noLength(style.marginLeft) &&
    noLength(style.marginRight) &&
    noLength(style.marginTop) &&
    noLength(style.marginBottom) &&
    noLength(style.paddingLeft) &&
    noLength(style.paddingRight) &&
    noLength(style.paddingTop) &&
    noLength(style.paddingBottom) &&
    !hasBorder(style.borderLeftStyle, style.borderLeftWidth) &&
    !hasBorder(style.borderRightStyle, style.borderRightWidth) &&
    !hasBorder(style.borderTopStyle, style.borderTopWidth) &&
    !hasBorder(style.borderBottomStyle, style.borderBottomWidth)
    ? made
    : 0;
}

/** Pass the floats in a phantom inline box, at any depth. */
function passFloatsIn(box: Box, width: number): void {
  for (const child of box.children) {
    if (child.isFloat) passFloat(child, width);
    else if (child.kind === 'inline') passFloatsIn(child, width);
  }
}

function noLength(len: Len): boolean {
  return len === 0 || len === AUTO;
}

function hasBorder(style: BorderStyle, width: number): boolean {
  return style !== 'none' && style !== 'hidden' && width !== 0;
}

/** Count a float the walk passes toward the room a new formatting context
 *  after it would have beside it. */
function passFloat(float: Box, width: number): void {
  resolveEdges(float, width);
  floatsPassed = true;
  if (float.style.float === 'right') {
    floatsRight += statedOuterWidth(float, width);
    passedRight = true;
  } else {
    floatsLeft += statedOuterWidth(float, width);
    passedLeft = true;
  }
}

/** Whether the walk passed a float that a `clear` clears, which the margin
 *  carries down with it: a child that clears one has clearance whatever
 *  its margin is. */
function passedFloats(clear: Box['style']['clear']): boolean {
  return (
    ((clear === 'left' || clear === 'both') && passedLeft) ||
    ((clear === 'right' || clear === 'both') && passedRight)
  );
}

/**
 * Whether a cleared child in the margin the walk collapses has clearance
 * from a float placed before the walk, which parts it from that margin
 * (CSS 2.1 9.5.2): where `through`, the margin that collapses up through
 * its top edge, does not take it below the float already. A child with none
 * is like any other, and the margin goes on up through it: stopped there, a
 * large margin under a float was spent inside its parent, whose background
 * showed above it.
 */
function hasClearance(child: Box, through: MarginStrut): boolean {
  if (!walkFloats) return true;
  const floor = walkFloats.clearance(child.style.clear);
  if (floor === -Infinity) return false;
  return walkY + marginOf(joinStruts(walkPending, through)) < floor;
}

/** What the walk has passed, to be put back where a look ahead into a
 *  child is undone. */
function saveWalk(): [boolean, number, number, boolean, boolean] {
  return [floatsPassed, floatsLeft, floatsRight, passedLeft, passedRight];
}

function restoreWalk([passed, left, right, onLeft, onRight]: ReturnType<
  typeof saveWalk
>): void {
  floatsPassed = passed;
  floatsLeft = left;
  floatsRight = right;
  passedLeft = onLeft;
  passedRight = onRight;
}

/** Whether a new formatting context fits beside the floats the walk passed
 *  (CSS 2.1 9.5), as `layoutBesideFloats` places it: where its width and
 *  theirs are stated, whether its border box, set in from its margins or
 *  the floats, ends before them or the room does; where the floats' are
 *  not, yes, and a box of `width: auto` there shrinks to the room it has. */
function fitsBeside(box: Box, width: number): boolean {
  const stated =
    statedOuterWidth(box, width) - box.marginLeft - box.marginRight;
  const lo = floatsLeft ? floatsLeft : -Infinity;
  const hi = floatsRight ? width - floatsRight : Infinity;
  const [start, end] = besideFloats(box, 0, width, lo, hi);
  const across = Number.isNaN(stated)
    ? Math.max(box.horizontalExtra, end - start)
    : stated;
  return box.parent?.style.direction === 'rtl'
    ? !(end - across < Math.max(Math.min(0, box.marginLeft), lo) - 0.01)
    : !(
        start + across >
        Math.min(width - Math.min(0, box.marginRight), hi) + 0.01
      );
}

/** A box's margin-box width as its style states it, before it is laid out:
 *  NaN for `width: auto`, which only layout can answer. */
function statedOuterWidth(box: Box, containingWidth: number): number {
  const { width, boxSizing } = box.style;
  if (width === AUTO) return NaN;
  const set = resolve(width, containingWidth, NaN);
  const border =
    boxSizing === 'border-box'
      ? Math.max(set, box.horizontalExtra)
      : set + box.horizontalExtra;
  return border + box.marginLeft + box.marginRight;
}

/**
 * Whether a box's top and bottom margins collapse through it: a block with
 * no height, no border or padding, no line in it and no formatting context
 * of its own, whose blocks are all the same (CSS 2.1 8.3.1). An empty
 * `<div>` between two paragraphs is the case: its margins and theirs are
 * one margin, where they were stacked.
 */
function collapsesThrough(box: Box): boolean {
  if (box.kind !== 'block' || box.height !== 0) return false;
  if (box.lines?.length || establishesBFC(box)) return false;
  const min = resolveOrNull(box.style.minHeight, box.percentHeightBase);
  if (min !== null && min > 0) return false;
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    // what is in line made a line or did not, and the lines said which
    if (
      child.kind === 'text' ||
      child.kind === 'inline' ||
      child.kind === 'break' ||
      isInlineLevel(child)
    ) {
      continue;
    }
    if (!collapsesThrough(child)) return false;
  }
  return true;
}

/** What a box's children came to: their height, and the margin still hanging
 *  past the last of them when the box's own bottom edge does not stop it. */
interface FlowResult {
  height: number;
  hanging: MarginStrut;
}

/**
 * Lay out a box's children as a block formatting context's contents, or as
 * one inline formatting context when they are all inline-level.
 */
function layoutChildren(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  contentTop: number,
  contentWidth: number,
  leading = 0,
): FlowResult {
  const contentLeft = box.contentX;
  if (establishesInlineContext(box)) {
    // a line box stops a margin: the leading one is spent above the lines
    const height = layoutInlineContent(
      box,
      ctx,
      floats,
      contentTop + leading,
      contentWidth,
      contentLeft,
    );
    return { height: height + leading, hanging: NO_MARGIN };
  }

  let y = contentTop;
  /** The margin left hanging by the previous sibling — or, before the first
   *  child, the one `leading` hands down — for collapsing. */
  let pendingMargin = marginStrut(leading);
  /** How many floats were placed before this box's content began, while
   *  nothing has yet fixed where the content is: a margin that collapses
   *  up through its top edge would take the ones placed since down with
   *  it (`clearanceSince`). Infinity once a child in flow has fixed it,
   *  and from the start where a border, padding or a formatting context
   *  of its own does. */
  let openFloats = topOpen(box) ? floats.count : Infinity;
  let first = true;
  /** Whether every child in flow so far was absorbed whole into this box's
   *  top margin: the walk that marked the next child reached it only
   *  through them, so past any other its mark is an earlier pass's. Asked
   *  of the box only once a child carries a mark, which few do. */
  let open: boolean | null = null;
  /** Whether the margin still hanging collapsed with a top margin that has
   *  clearance, an empty block cleared past a float's, and the margin that
   *  makes: the block's own two and what the empty blocks after it add to
   *  them. It stays in this box rather than escape its bottom (CSS 2.1
   *  8.3.1, 10.6.3). */
  let cleared = false;
  let afterClear = NO_MARGIN;
  /** The cleared block's own top margin: its top border edge is that far
   *  inside the margin its margins and the ones after it collapse to. */
  let clearTop = 0;
  // this box's first formatted line is its first child's in flow (CSS 2.1
  // 5.12.1), which its `::first-line` is handed to
  let firstLine = ctx.firstLine ? firstLineOf(box) : null;
  // and the room a list item's marker takes on it (`MARKER_ROOM`): an
  // inside marker's is handed down to the line it is on, and an outside
  // one's is room above the baseline of the first child that has a line,
  // which goes lower where the marker reaches higher (`MARKER_ASCENT`)
  let pushed = MARKER_ASCENT.get(box) ?? null;
  let marked = pushed === null ? (MARKER_ROOM.get(box) ?? null) : null;
  const clamp = ctx.clamp ?? null;
  // A layout that stops (`until`) lays out no child that starts below
  // where it stops, and sets it aside. One this pass set aside already, in
  // a layout of this box at another width or another place, is laid out
  // again from the whole list, and set aside again where it starts below.
  // a probe, which stops nowhere, lays out what was set aside too
  let children = wholeAgain(box, ctx);
  let stopped = false;
  /** Whether this flow is in a multicol container, which sets what it
   *  holds in its columns once it is laid out: no child of it is kept
   *  (`reuseLaid`). Asked once, where a child might be. */
  let inColumnsFlow: boolean | null = null;
  /** Whether this flow is a multicol container's or a scroll
   *  container's, or in one, which is laid out whole (`laidWholeAround`).
   *  Asked once, where the layout would stop. */
  let inColumns: boolean | null = null;
  // The places this flow puts its children in are kept against this
  // layout of it (`FLOW_PLACE`); a probe's are no place at all
  const probing = ctx.probing === true;
  const gen = probing ? 0 : (FLOW_GEN.get(box) ?? 0) + 1;
  if (probing) PROBED.set(box, ctx.pass ?? 0);
  else FLOW_GEN.set(box, gen);
  // A layout that keeps what is above where it starts (`keepAbove`) lays
  // out none of the first children it keeps, and resumes the flow after
  // them where it was: as far below the content top as they reached, with
  // the margin they left hanging. What they place in the flow — their
  // floats, the first line, a marker's room — is all above it.
  const keeps = probing ? undefined : ctx.keep?.get(box);
  if (
    keeps !== undefined &&
    keeps < children.length &&
    clamp === null &&
    PROBED.get(box) !== ctx.pass &&
    !(inColumns ??= laidWholeAround(box))
  ) {
    const last = FLOW_PLACE.get(children[keeps - 1]);
    if (last) {
      if (!ctx.setAside!.has(box)) ctx.setAside!.set(box, children);
      for (let i = 0; i < keeps; i += 1) {
        const child = children[i];
        HELD_BACK.set(child, ctx.pass!);
        const place = FLOW_PLACE.get(child);
        if (place) place.gen = gen;
      }
      box.children = children = children.slice(keeps);
      y = contentTop + last.bottom;
      pendingMargin = last.hanging;
      first = false;
      open = false;
      openFloats = Infinity;
      firstLine = null;
      marked = null;
      pushed = null;
    }
  }

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (stopped) {
      // what is set aside, but for what holds a box placed against
      // something outside it, which is laid out to reach that box
      if (!child.outOfFlow && !ctx.holders?.has(child)) continue;
    } else if (
      ctx.until !== undefined &&
      y > ctx.until &&
      ctx.reach === undefined &&
      !(inColumns ??= laidWholeAround(box))
    ) {
      // the rest as tall as it was, after the margin hanging above it
      y += marginOf(pendingMargin) + setAside(box, children, index, ctx);
      ASIDE_REACH.set(box, y - contentTop);
      pendingMargin = NO_MARGIN;
      open = false;
      openFloats = Infinity;
      cleared = false;
      stopped = true;
      if (!child.outOfFlow && !ctx.holders?.has(child)) continue;
    }
    if (child.kind === 'text' && isBlank(child.text)) continue;
    // Past a line-clamp container's clamp point, a box in flow or floating
    // is invisible and takes no room (CSS Overflow 4, 5.3.1); a positioned
    // box keeps its place, invisible only where its containing block is.
    if (clamp !== null && !child.outOfFlow) {
      if (clamp.done) {
        hideClamped(child);
        continue;
      }
      CLAMPED.delete(child);
    }
    const handedHere = firstLine !== null;
    if (firstLine && !child.outOfFlow && !child.isFloat) {
      if (!FIRST_LINE.has(child)) HANDED.set(child, firstLine);
      firstLine = null;
    }
    // the room a marker takes on the line this child starts, which its
    // layout reads (`MARKER_ROOM`), is no part of what it was laid out from
    const markedHere = marked !== null;
    if (marked && !child.outOfFlow && !child.isFloat) {
      MARKER_ROOM.set(child, marked);
      marked = null;
    }
    if (child.outOfFlow) {
      const top = y + marginOf(pendingMargin);
      if (INLINE_BEFORE_ABSOLUTE.has(child.style)) {
        // one that was inline-level is on a line of its own, beside the
        // floats there, where the line's alignment puts what it holds
        const band = floats.bandAt(
          top,
          1,
          contentLeft,
          contentLeft + contentWidth,
        );
        const at = emptyLinePoint(box.style, band.left, band.right);
        placeStatic(child, box, at, 0, top);
      } else placeStatic(child, box, contentLeft, contentWidth, top);
      ctx.positioned.push({
        box: child,
        containing: containingBlockFor(child) ?? box,
      });
      continue;
    }
    if (child.isFloat) {
      layoutFloat(
        child,
        ctx,
        floats,
        y + marginOf(pendingMargin),
        contentLeft,
        contentWidth,
      );
      if (!probing)
        placed(child, gen, contentTop, pendingMargin, floats, false);
      continue;
    }

    resolveEdges(child, contentWidth);
    // A child whose margin this box already spent — collapsed through its
    // top edge — sits at the content top; any other brings its own margin,
    // collapsed with its first descendants' where nothing parts them.
    let absorbed = child.topAbsorbed;
    if (absorbed !== 0 && !(open ??= topOpen(box))) absorbed = 0;
    const top = absorbed
      ? NO_MARGIN
      : collapsedTopMargin(child, contentWidth, floats, y, pendingMargin);
    const collapsed = joinStruts(pendingMargin, top);
    // After an empty block cleared past a float, what collapses with its
    // margins is placed from its top border edge, less its own top
    // margin, which is above that edge: the depth the margin they make
    // reaches below it (CSS 2.1 8.3.1), as the box's bottom is below it
    // where the block is the last in it
    const at: number = cleared
      ? y + Math.max(0, marginOf(joinStruts(afterClear, top)) - clearTop)
      : y + marginOf(collapsed);
    let childY = at;
    const clear = child.style.clear;
    const clearance = floats.clearance(clear);
    if (clearance > -Infinity) {
      // A float placed before anything fixed where this box's content is
      // goes down with the margin where `clear` is none, so the child is
      // never below it there: it has clearance, and its border edge goes
      // under the floats whatever its margin is, which may take it back
      // up (CSS 2.1 9.5.2, as the browsers read it). A margin under a
      // float in an empty block put a block that cleared it the margin
      // below the float, and its parent's background showed between.
      // And one the walk that placed this box reached through every child
      // before it, and stopped at for its clearance, has it too: where
      // it would have been with `clear: none`, its margin collapsed up
      // through this box's top, is above the floats, so its border edge
      // goes under them, and its own margin, held apart there, may not
      // take it lower. The clearance is negative then.
      if (
        (openFloats !== Infinity &&
          floats.clearanceSince(clear, openFloats) > -Infinity) ||
        (child.topAbsorbed === 0 && (open ?? topOpen(box)))
      ) {
        childY = clearance;
      } else if (clearance > childY) childY = clearance;
    }

    const counted = clamp?.fit?.lines ?? 0;
    const floatMark = floats.count;
    // A probe takes a block it laid out before in the same room, from the
    // same things, for what it came to then (`Stand`), where nothing but
    // the room reaches into it: no float, no clearance, no first line or
    // marker handed down, no clamp, no columns, no other way to write. Not
    // a table, which the pass keeps at a width it laid it out at already
    // (`kept`): standing, it would leave the layout around it partial,
    // which no layout but a probe may keep, and a table in a table's cell
    // was laid out again at every level
    const standable =
      probing &&
      standsOff === 0 &&
      clamp === null &&
      !markedHere &&
      !handedHere &&
      pushed === null &&
      childY === at &&
      child.kind !== 'replaced' &&
      child.kind !== 'table' &&
      floats.bottom <= childY &&
      !framed.any &&
      !(columned.any && (inColumnsFlow ??= inMulticol(box)));
    const stand = standable ? standFor(child, ctx, contentWidth) : null;
    if (stand !== null) {
      STOOD.set(child, stand);
      stoodAny = true;
      standsTaken += 1;
      partials += 1;
      first = false;
      CLEARED_FROM.delete(child);
      open = false;
      y = childY + stand.bottom;
      pendingMargin = stand.hanging;
      openFloats = Infinity;
      cleared = false;
      afterClear = NO_MARGIN;
      clearTop = 0;
      continue;
    }
    if (stoodAny) STOOD.delete(child);
    // A block laid out by an earlier layout from what it has now — the same
    // room, the same percentage base, no float reaching into it — and
    // neither laid out nor changed since (`reuseLaid`) is moved to where
    // this one puts it, all it holds with it (`LAID`)
    const keepable =
      ctx.reused !== undefined &&
      !probing &&
      clamp === null &&
      !markedHere &&
      child.kind !== 'replaced' &&
      floats.bottom <= childY &&
      !(columned.any && (inColumnsFlow ??= inMulticol(box)));
    if (keepable && reuseLaid(child, ctx, contentLeft, childY, contentWidth)) {
      // laid out where it was, and moved here
    } else {
      const waiting = ctx.positioned.length;
      if (
        !floats.isEmpty &&
        (child.kind === 'replaced' || establishesBFC(child))
      ) {
        layoutBesideFloats(
          child,
          ctx,
          floats,
          contentLeft,
          childY,
          contentWidth,
        );
      } else {
        layoutBlockLevel(child, ctx, floats, contentLeft, childY, contentWidth);
      }
      // what it was laid out from, for a later layout to keep it by, where
      // it put no float in this flow
      if (keepable && floats.count === floatMark) {
        noteLaid(child, ctx, contentLeft, childY, contentWidth, waiting);
      } else LAID.delete(child);
      // and for a later probe, what it came to
      if (standable && floats.count === floatMark && !collapsesThrough(child)) {
        standAfter(child, ctx, contentWidth, childY);
      }
    }
    if (pushed !== null) {
      const line = firstLineIn(child);
      if (line) {
        const push = pushed - (line.y + line.baseline - child.y);
        if (push > 0) {
          translate(child, 0, push);
          floats.moveSince(floatMark, push);
        }
        pushed = null;
      }
    }
    // a block with none of the flow's lines in it — an image, a box of a
    // formatting context of its own — puts the clamp point of an `auto`
    // clamp before it where it ends below the room
    const fit = clamp?.fit;
    if (fit && !fit.over && fit.lines === counted) {
      const bottom =
        child.y +
        child.height -
        child.padBottom -
        child.borderBottom +
        closingBelow(child, clamp!.box);
      if (bottom > fit.floor) fit.over = true;
    }
    first = false;
    const moved = childY !== at;
    if (moved) CLEARED_FROM.set(child, at);
    else CLEARED_FROM.delete(child);
    if (!moved && collapsesThrough(child)) {
      // nothing in it parts its margins: they and the ones either side of
      // it are one (CSS 2.1 8.3.1), still hanging for what comes next —
      // or, where the walk took them all into this box's top margin, spent
      if (absorbed === 2) {
        pendingMargin = collapsed;
        if (!probing)
          placed(child, gen, contentTop, pendingMargin, floats, true);
        continue;
      }
      open = false;
      pendingMargin = joinStruts(collapsed, bottomOf(child));
      if (cleared) {
        afterClear = joinStruts(joinStruts(afterClear, top), bottomOf(child));
      }
      if (!probing) placed(child, gen, contentTop, pendingMargin, floats, true);
      continue;
    }
    open = false;
    y = child.y + child.height;
    pendingMargin = bottomOf(child);
    openFloats = Infinity;
    // cleared, and empty: its margins collapse together, and what follows
    // collapses with them, a top margin that has clearance (CSS 2.1 8.3.1)
    cleared = moved && collapsesThrough(child);
    afterClear = cleared ? joinStruts(top, bottomOf(child)) : NO_MARGIN;
    clearTop = cleared ? marginOf(top) : 0;
    if (!probing) {
      placed(child, gen, contentTop, pendingMargin, floats, cleared);
    }
  }

  // The last child's bottom margin collapses through the parent's bottom
  // edge unless a border, padding, a specified height or a formatting
  // context of its own stops it — which is why a `<div>` around a `<p>` is
  // not 16px taller than the paragraph. The margin is not *lost*, though: it
  // escapes, and the caller merges it into the box's own bottom margin so
  // the next sibling still sees it. Dropping it here was the bug that made
  // `<div><p>…</p></div><p>…</p>` set the two paragraphs solid.
  // A percentage of a height that depends on content computes to `auto`
  // (CSS 2.1 10.5), and lets it through as `auto` does: a `height: 100%`
  // wrapper in an `auto` body kept its last child's margin inside it
  if (
    !first &&
    !cleared &&
    !box.borderBottom &&
    !box.padBottom &&
    specifiedHeight(box) === null &&
    !establishesBFC(box)
  ) {
    const height = y - contentTop;
    // A minimum height that makes the box taller parts the margin from its
    // bottom, and spends it: the margin neither escapes nor makes the box
    // taller still. 8.3.1 has it collapse only through a box of no
    // `min-height`; browsers part it only where the minimum is what sets
    // the height, and the suite has it so. A maximum leaves it to collapse
    // through, as 8.3.1 has it, where the suite has a test either way
    const parted =
      box.style.minHeight !== AUTO &&
      clampHeight(box, height + box.verticalExtra) > height + box.verticalExtra;
    return { height, hanging: parted ? NO_MARGIN : pendingMargin };
  }
  // The cleared block's top border edge is where it would be with a border
  // at its bottom, its top margin's depth inside the margin they all make:
  // the box ends where that margin does, below the edge by what exceeds
  // the top margin (8.3.1, 10.6.3)
  if (cleared) {
    return {
      height: y + Math.max(0, marginOf(afterClear) - clearTop) - contentTop,
      hanging: NO_MARGIN,
    };
  }
  return {
    height: y + marginOf(pendingMargin) - contentTop,
    hanging: NO_MARGIN,
  };
}

/**
 * A block that makes its own formatting context — a table, a box that
 * clips its overflow — or a block-level image does not flow round the
 * floats beside it: it is a rectangle beside them (CSS 2.1 9.5), in the
 * room they leave at its top, or lower down where it does not fit there.
 * An image floated left with an `overflow: hidden` block of text beside it
 * is the layout this is for; the block ran under the image.
 */
function layoutBesideFloats(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  contentLeft: number,
  y: number,
  contentWidth: number,
): void {
  const right = contentLeft + contentWidth;
  const style = box.style;
  // auto margins, and HTML's alignment, place the box in the room the
  // floats leave, as browsers do
  const inRoom =
    style.marginLeft === AUTO ||
    style.marginRight === AUTO ||
    !!box.parent?.style.alignBlocks;
  const rtl = box.parent?.style.direction === 'rtl';
  // Otherwise its margins are its containing block's, and may overlap a
  // float on their own side; its border box may not. So a column beside a
  // 200px sidebar with a margin of 220px starts 220px in, not 420px. A
  // float is looked for as far out as a negative margin takes the box
  resolveEdges(box, contentWidth);
  const reachLeft = inRoom
    ? contentLeft
    : Math.min(contentLeft, contentLeft + box.marginLeft);
  const reachRight = inRoom ? right : Math.max(right, right - box.marginRight);
  let at = y;
  for (let tries = 0; tries < 64; tries += 1) {
    let band = floats.bandAt(at, 1, reachLeft, reachRight, !inRoom);
    let fits = false;
    // The room is what the floats leave over the box's whole height, not at
    // its top: a float that starts lower down, beside the box, narrows it
    // too (CSS 2.1 9.5). Known only once the box is laid out, so a box
    // that runs into one is laid out again in what is left.
    for (let settle = 0; settle < 8; settle += 1) {
      const room = band.right - band.left;
      const lo = band.left > reachLeft ? band.left : -Infinity;
      const hi = band.right < reachRight ? band.right : Infinity;
      if (inRoom) layoutBlockLevel(box, ctx, floats, band.left, at, room);
      else {
        const [start, end] = besideFloats(box, contentLeft, right, lo, hi);
        layoutBlockLevel(
          box,
          ctx,
          floats,
          start - box.marginLeft,
          at,
          end - start + box.marginLeft + box.marginRight,
          contentWidth,
        );
      }
      // its border box, from its top: its margins may overlap a float, and
      // a negative top margin takes the box up past one it then meets
      const over = floats.bandAt(
        at,
        box.height,
        reachLeft,
        reachRight,
        !inRoom,
      );
      if (over.left > band.left + 0.5 || over.right < band.right - 0.5) {
        band = over;
        continue;
      }
      // Where no float narrows the room on either side, the box is where
      // it would be were there none, and one too wide for its containing
      // block overflows it here: below the floats it would be the same box
      // in the same room. Blink tests a fit only against a side a float is
      // on (`can_expand_outside_opportunity`, BlockLayoutAlgorithm::
      // LayoutNewFormattingContext). Design 209's 247px heading, which
      // clips its overflow, in a 240px column beside a float that ends
      // left of the column, went under the float, 555px down.
      if (lo === -Infinity && hi === Infinity) fits = true;
      // What is too wide overflows at the end of the line, as far as a
      // negative margin there takes it, but no further into a float or
      // past the room; at the start it would run into the floats, and
      // waits below them (the suite's floats-wrap-bfc-with-margin tests)
      else if (inRoom) {
        fits = box.marginLeft + box.width + box.marginRight <= room + 0.5;
      } else if (rtl) {
        const limit = Math.max(contentLeft + Math.min(0, box.marginLeft), lo);
        fits = box.x >= limit - 0.5;
      } else {
        const limit = Math.min(right - Math.min(0, box.marginRight), hi);
        fits = box.x + box.width <= limit + 0.5;
      }
      break;
    }
    if (fits) return;
    // under the float it meets, which may start below its top
    const below = floats.nextEdgeBelow(at, Math.max(1, box.height));
    if (below === null || below <= at) break;
    at = below;
  }
  layoutBlockLevel(box, ctx, floats, contentLeft, at, contentWidth);
}

/**
 * The left and right edges a block with a formatting context of its own
 * has for its border box beside floats that reach `lo` from the left and
 * `hi` from the right (infinite where none does): each margin set in from
 * its containing block's edge, or the float's where that is further in.
 */
function besideFloats(
  box: Box,
  left: number,
  right: number,
  lo: number,
  hi: number,
): [number, number] {
  // Where a float narrows the containing block's room on either side, a
  // negative margin takes the box no further out than the containing
  // block's edge, as every engine has it; where none does, the margins
  // are the containing block's in full. The suite's
  // floats-wrap-bfc-with-margin-006 to -009 propose otherwise, and pass in
  // no browser.
  const beside = lo > left || hi < right;
  const ml = beside ? Math.max(0, box.marginLeft) : box.marginLeft;
  const mr = beside ? Math.max(0, box.marginRight) : box.marginRight;
  return [Math.max(left + ml, lo), Math.min(right - mr, hi)];
}

function layoutInlineContent(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  contentTop: number,
  contentWidth: number,
  contentLeft: number,
): number {
  // a line-clamp container whose clamp point is at its start shows none of
  // its own lines
  const clamp = ctx.clamp ?? null;
  if (clamp !== null && (clamp.done || clamp.left <= 0)) {
    box.lines = [];
    box.floatRow = 0;
    return 0;
  }
  // An absolute box's static position is the block's; a float is placed
  // on the line it is on, as the lines reach it (`floatBoxes`).
  const floated = placeOutOfLine(
    box,
    box,
    ctx,
    contentTop,
    contentWidth,
    contentLeft,
  );
  // Atomics have to be sized before the line breaker can place them.
  sizeAtomics(box, ctx, contentWidth);

  const firstLine = ctx.firstLine ? firstLineOf(box) : null;
  const options = {
    fonts: ctx.fonts,
    width: contentWidth,
    startY: contentTop,
    floats,
    originX: contentLeft,
    scale: ctx.scale,
    firstLined: firstLine !== null,
    clipText: ctx.clipText,
    firstStrut: MARKER_ROOM.get(box),
    floatBoxes: floated
      ? {
          size: (child: Box) => sizeFloat(child, ctx, contentWidth),
          place: (child: Box, y: number) =>
            placeFloat(child, floats, y, contentLeft, contentWidth),
        }
      : undefined,
    // the lines the clamp leaves, where it cuts rather than counts
    clamp:
      clamp !== null && clamp.fit === null && clamp.left !== Infinity
        ? {
            lines: clamp.left,
            ellipsis: box.style.blockEllipsis,
            follows: followsInFlow(box, clamp.box),
            legacy: clamp.box.style.clampContinue === 'legacy',
          }
        : undefined,
  };
  // A `::first-line` that sets the line's fonts moves where it breaks, so
  // the line is found in them (`InlineOptions.firstLineStyle`); its text
  // takes the pseudo-element's colour there too
  const restyled =
    firstLine && ctx.firstLineStyler && setsFonts(firstLine, box.style)
      ? { style: firstLine, styler: ctx.firstLineStyler }
      : undefined;
  let result = layoutInline(
    box,
    restyled ? { ...options, firstLineStyle: restyled } : options,
  );
  if (
    firstLine &&
    !restyled &&
    firstLine.color !== box.style.color &&
    result.lines.length
  ) {
    // the first line's text in its `::first-line` colour, laid out again
    // with its runs cut where the line ends (CSS 2.1 5.12.1), beside the
    // floats the first pass placed — and measured with them
    const placed = result;
    result = layoutInline(box, {
      ...options,
      floatBoxes: undefined,
      firstLine: {
        color: firstLine.color,
        from: box.style.color,
        end: result.lines[0].textEnd,
      },
    });
    if (placed.lines.length === result.lines.length) {
      placed.lines.forEach((line, i) => {
        if (line.floats) result.lines[i].floats = line.floats;
      });
    }
    result.floatRow = placed.floatRow;
  }
  box.floatRow = result.floatRow ?? 0;
  if (clamp !== null) countLines(clamp, box, result, contentTop, options.clamp);
  if (
    firstLine &&
    ctx.fonts &&
    result.lines.length &&
    !isTransparent(firstLine.backgroundColor)
  ) {
    result.lines[0].background = {
      style: firstLine,
      ...faceExtentOf(ctx.fonts, firstLine),
    };
  }
  // The inline pass works in content-box coordinates; move the result into
  // document space now, so nothing below this line has to know the
  // difference.
  for (const line of result.lines) {
    line.x += contentLeft;
    line.y += contentTop;
    for (const placed of line.atomics) {
      placed.x += contentLeft;
      placed.y += contentTop;
      moveTo(placed.box, placed.x, placed.y + placed.box.marginTop);
    }
    for (const text of line.texts) {
      text.drawX += contentLeft;
      text.drawY += contentTop;
    }
    for (const edge of line.edges ?? []) edge.x += contentLeft;
  }
  box.lines = result.lines;
  return result.height;
}

/**
 * A block's lines, counted against the clamp: the ones left, or for an
 * `auto` clamp's first pass, the ones that end above its floor. The clamp
 * point is passed where they were cut, or where they were all the lines
 * left and more of the container follows them.
 */
function countLines(
  clamp: Clamp,
  box: Box,
  result: InlineResult,
  contentTop: number,
  cut: InlineOptions['clamp'],
): void {
  const fit = clamp.fit;
  if (fit !== null) {
    if (fit.over) return;
    const below = closingBelow(box, clamp.box);
    for (const line of result.lines) {
      if (contentTop + line.y + line.height + below > fit.floor) {
        fit.over = true;
        return;
      }
      fit.lines += 1;
    }
    return;
  }
  clamp.left -= result.lines.length;
  if (result.cut || (clamp.left <= 0 && cut?.follows)) clamp.done = true;
}

/** Mark a box past a clamp point, and take from everything in it the lines
 *  a layout before gave it: a hidden box is not laid out, and nothing —
 *  a selection, a caret — may find text in it where it stood. */
function hideClamped(box: Box): void {
  CLAMPED.add(box);
  const stack = [box];
  while (stack.length) {
    const at = stack.pop()!;
    at.lines = null;
    for (const child of at.children) stack.push(child);
  }
}

/**
 * How far below a box's content a line-clamp container's content ends,
 * where the clamp point is just after it: the bottom padding, border and
 * margin of the box and of each block around it in the container, the
 * margins collapsed where nothing parts them.
 */
function closingBelow(box: Box, container: Box): number {
  let below = 0;
  let margin = 0;
  for (let at: Box | null = box; at && at !== container; at = at.parent) {
    const edge = at.padBottom + at.borderBottom;
    if (edge) {
      below += margin + edge;
      margin = 0;
    }
    margin = Math.max(margin, at.marginBottom);
  }
  return below + margin;
}

/**
 * Whether anything in flow follows a block in a line-clamp container — a
 * block after it, or after a block around it. Then a clamp point is just
 * after its last line, which ends in an ellipsis (CSS Overflow 4, 4.2);
 * where nothing does, the lines end where the content does.
 */
function followsInFlow(box: Box, container: Box): boolean {
  for (let at = box; at !== container && at.parent; at = at.parent) {
    const siblings = at.parent.children;
    for (let i = siblings.indexOf(at) + 1; i < siblings.length; i += 1) {
      const next = siblings[i];
      if (next.outOfFlow || next.isFloat || makesNothing(next)) continue;
      return true;
    }
  }
  return false;
}

/** Whether a box in flow makes neither a line nor a height of its own: a
 *  block of phantom lines — the rest of an inline box a block broke — with
 *  no edge or height to part it, which puts no clamp point after the line
 *  before it. */
function makesNothing(box: Box): boolean {
  if (box.kind === 'text') return makesNoLine(box);
  if (box.kind === 'inline') return phantom(box) !== 0;
  if (box.kind !== 'block' || establishesBFC(box)) return false;
  const style = box.style;
  if (
    style.height !== AUTO ||
    style.minHeight !== AUTO ||
    !noLength(style.paddingTop) ||
    !noLength(style.paddingBottom) ||
    hasBorder(style.borderTopStyle, style.borderTopWidth) ||
    hasBorder(style.borderBottomStyle, style.borderBottomWidth)
  ) {
    return false;
  }
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    if (!makesNothing(child)) return false;
  }
  return true;
}

/** Whether a `::first-line` style sets its line's text otherwise than its
 *  block's: in another face, size or line height, spaced apart, or in
 *  capitals. */
function setsFonts(line: ComputedStyle, block: ComputedStyle): boolean {
  return (
    line.fontFamily !== block.fontFamily ||
    line.fontSize !== block.fontSize ||
    line.fontWeight !== block.fontWeight ||
    line.fontStyle !== block.fontStyle ||
    line.fontStretch !== block.fontStretch ||
    line.lineHeight !== block.lineHeight ||
    line.lineHeightIsLength !== block.lineHeightIsLength ||
    line.letterSpacing !== block.letterSpacing ||
    line.fontVariantCaps !== block.fontVariantCaps ||
    line.fontVariantNumeric !== block.fontVariantNumeric ||
    line.fontVariantLigatures !== block.fontVariantLigatures ||
    line.fontVariantPosition !== block.fontVariantPosition ||
    line.fontKerning !== block.fontKerning ||
    line.fontFeatureSettings !== block.fontFeatureSettings ||
    line.textTransform !== block.textTransform
  );
}

/** `::first-line` styles handed down to the first child in flow of a box
 *  that has one, whose first line is the box's (`layoutChildren`). */
const HANDED = new WeakMap<Box, ComputedStyle>();

/** The `::first-line` style a box's first line takes: its own, or one an
 *  ancestor handed it. */
function firstLineOf(box: Box): ComputedStyle | null {
  return FIRST_LINE.get(box) ?? HANDED.get(box) ?? null;
}

/** Size every atomic in an inline context. */
function sizeAtomics(box: Box, ctx: LayoutContext, contentWidth: number): void {
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    if (child.kind === 'inline') {
      sizeAtomics(child, ctx, contentWidth);
      continue;
    }
    if (child.kind === 'text' || child.kind === 'break') continue;
    resolveEdges(child, contentWidth);
    layoutAtomic(child, ctx, contentWidth);
  }
}

/** An inline-level box that lays out as a block inside: `inline-block`, a
 *  replaced element, an `inline-table`. */
function layoutAtomic(
  box: Box,
  ctx: LayoutContext,
  availableWidth: number,
): void {
  if (box.kind === 'replaced') {
    sizeReplaced(box, availableWidth);
    return;
  }
  const width = shrinkToFitWidth(box, ctx, availableWidth);
  layoutOwn(box, ctx, width);
}

/**
 * Lay out a box that sizes itself — a float, an inline-block, an absolute
 * box — at its own width, where nothing outside it reaches in: or, where
 * this pass has already laid it out at that width with the same edges,
 * leave it as it was and move it back to where a layout puts it.
 *
 * Measuring a box's content lays its content out, and so a float in a
 * float was laid out twice a level — as its parent measured, and as its
 * parent was laid out at the width it measured — and a hundred of them,
 * the markup of a broken page, never finished. What a caller does to the
 * box after its layout is move it, and stretch its height, which is put
 * back; its own, and its content's, are the layout's.
 */
function layoutOwn(box: Box, ctx: LayoutContext, width: number): void {
  const laid = LAID_OWN.get(box);
  if (
    laid !== undefined &&
    laid.ctx === ctx &&
    // and nothing, a probe of its content, has laid it out since
    laid.serial === box.layoutSerial &&
    (ctx.probing === true || !laid.partial) &&
    laid.width === width &&
    // NaN where no height is a base, which `===` would never find again
    Object.is(laid.base, box.percentHeightBase) &&
    laid.padTop === box.padTop &&
    laid.padRight === box.padRight &&
    laid.padBottom === box.padBottom &&
    laid.padLeft === box.padLeft &&
    // and was put somewhere it can be moved back from: a right float in a
    // content measured at no width limit stands at an infinite x, and
    // moved back by it, came out at NaN
    Number.isFinite(box.x) &&
    Number.isFinite(box.y)
  ) {
    if (laid.partial) partials += 1;
    box.height = laid.height;
    moveTo(box, 0, 0);
    return;
  }
  const stands = partials;
  layoutInternals(box, ctx, width, 0, 0);
  LAID_OWN.set(box, {
    ctx,
    serial: box.layoutSerial,
    width,
    base: box.percentHeightBase,
    padTop: box.padTop,
    padRight: box.padRight,
    padBottom: box.padBottom,
    padLeft: box.padLeft,
    height: box.height,
    partial: partials !== stands,
  });
}

/** Every box's layout counted, for `Box.layoutSerial`. */
let layoutSerial = 0;

/** How many boxes have been laid out, for a test to count what a layout
 *  lays out again. */
export function boxLayoutsMade(): number {
  return layoutSerial;
}

/**
 * Whether a box's layout is one this pass made at `width`, with the same
 * edges and the same height to take percentages of, and nothing has laid
 * it out since (`keep`): what a table in a table in a table is asked for
 * again at every level, and at the same width each time. Its height is put
 * back, where a caller may have stretched it; where it stands is the
 * caller's to move it to.
 */
function kept(box: Box, ctx: LayoutContext, width: number): boolean {
  const laid = LAID_OWN.get(box);
  if (
    laid === undefined ||
    laid.ctx !== ctx ||
    laid.serial !== box.layoutSerial ||
    (laid.partial && ctx.probing !== true) ||
    laid.width !== width ||
    !Object.is(laid.base, box.percentHeightBase) ||
    laid.padTop !== box.padTop ||
    laid.padRight !== box.padRight ||
    laid.padBottom !== box.padBottom ||
    laid.padLeft !== box.padLeft ||
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y)
  ) {
    return false;
  }
  if (laid.partial) partials += 1;
  box.height = laid.height;
  return true;
}

/** Note the layout a box was just given, at `width`, for `kept`: one left
 *  partial since `stands` (`partialsMade`) is partial. */
function keep(
  box: Box,
  ctx: LayoutContext,
  width: number,
  stands: number,
): void {
  LAID_OWN.set(box, {
    partial: partials !== stands,
    ctx,
    serial: box.layoutSerial,
    width,
    base: box.percentHeightBase,
    padTop: box.padTop,
    padRight: box.padRight,
    padBottom: box.padBottom,
    padLeft: box.padLeft,
    height: box.height,
  });
}

/** What `layoutOwn` laid each box out at, and in which pass. */
const LAID_OWN = new WeakMap<
  Box,
  {
    ctx: LayoutContext;
    serial: number;
    width: number;
    base: number;
    padTop: number;
    padRight: number;
    padBottom: number;
    padLeft: number;
    height: number;
    /** Whether a block in it stood for a probe (`STOOD`), and is where an
     *  earlier layout put it: only a probe may keep it. */
    partial: boolean;
  }
>();

function layoutBlockLevel(
  box: Box,
  ctx: LayoutContext,
  outerFloats: FloatContext,
  contentLeft: number,
  y: number,
  containingWidth: number,
  /** What percentages are of: the containing block's width, where the
   *  room is narrower than it beside floats */
  percentBase = containingWidth,
): void {
  resolveEdges(box, percentBase);

  if (box.kind === 'replaced') {
    sizeReplaced(box, percentBase, containingWidth);
    placeBlock(box, contentLeft, y, containingWidth);
    return;
  }

  const width = blockWidth(box, containingWidth, percentBase, ctx);
  if (box.kind === 'table' && kept(box, ctx, width)) {
    // laid out at this width earlier in the pass, and not since: put where
    // a layout would put it, and moved there whole
    const laid = box.width;
    const x = box.x;
    const top = box.y;
    box.width = width;
    placeBlock(box, contentLeft, y, containingWidth);
    if (laid !== width && Number.isFinite(containingWidth)) {
      box.width = laid;
      placeBlock(box, contentLeft, y, containingWidth);
    }
    box.width = laid;
    const to = { x: box.x, y: box.y };
    box.x = x;
    box.y = top;
    moveTo(box, to.x, to.y);
    return;
  }
  box.width = width;
  placeBlock(box, contentLeft, y, containingWidth);
  const stands = partials;
  layoutInternals(box, ctx, width, box.x, box.y, outerFloats);
  // what can be seen starts here: the layout stops as far past it as it
  // was asked to (`LayoutContext.reach`)
  if (ctx.reach?.box === box) {
    ctx.until = box.y + ctx.reach.below;
    ctx.reach = undefined;
  }
  if (
    box.kind === 'table' &&
    box.width !== width &&
    Number.isFinite(containingWidth)
  ) {
    // a table shrinks to its columns once it is laid out, where it was
    // placed as wide as its room: placed again, its auto margins centre it
    // — in a room that has a width, and not in the unbounded one a
    // shrink-to-fit probe lays it out in
    const x = box.x;
    placeBlock(box, contentLeft, y, containingWidth);
    const dx = box.x - x;
    box.x = x;
    translate(box, dx, 0);
  }
  if (box.kind === 'table') keep(box, ctx, width, stands);
}

/**
 * Lay a block-level box out as a block in a containing block of a width,
 * at its own `width` or at the room its margins leave, with the offset its
 * margins give it; the caller moves it into place. What a table's caption
 * is, in the box around the table.
 */
export function layoutBlockIn(
  box: Box,
  ctx: LayoutContext,
  containingWidth: number,
): void {
  resolveEdges(box, containingWidth);
  const width = blockWidth(box, containingWidth, containingWidth, ctx);
  box.width = width;
  placeBlock(box, 0, 0, containingWidth);
  layoutInternals(box, ctx, width, box.x, 0);
}

/**
 * The width a min-content probe lays a box out at: none at all. Every line
 * breaks at every opportunity there, and the widest is the longest word —
 * which is what both text engines answer at zero; react-x11's CoreText
 * engine answers it at zero only, and at a pixel breaks inside words, so a
 * probe a pixel wide gave every table cell on macOS a min-content a
 * character or two wide.
 */
export const MIN_CONTENT_PROBE = 0;

/**
 * Lay a box out at a width and report the widest thing it drew.
 *
 * This is what a table column asks twice — once unbounded for max-content,
 * once at a hair's width for min-content — and it exists rather than the
 * caller reading `box.width` because a `width: auto` box laid out unbounded
 * *is* unbounded: it fills its containing block, and its containing block was
 * `Infinity`. The answer has to come from what the content came to, which is
 * exactly what `intrinsicWidth` walks.
 *
 * A box with a width of its own answers with it, as its contribution to
 * whatever is sizing it — unless `content` asks for what the content
 * alone came to, which is how a table cell's is taken: its `width` is
 * weighed apart, and answered with the width the probe laid it out at,
 * a cell set to 10% measured no wider than its padding.
 */
export function measureIntrinsicWidth(
  box: Box,
  ctx: LayoutContext,
  available: number,
  content = false,
): number {
  // not through `ctx.layoutSubtree`, which is this and one frame more on
  // the stack for every level of a document that measures what it holds
  // (`layoutTable`) — and with no stop: a probe measures all of what the
  // box holds, which a layout that stops (`until`) would leave out of a
  // probe at no width, as tall as its words
  const { until, probing, reach } = ctx;
  ctx.until = undefined;
  ctx.reach = undefined;
  ctx.probing = true;
  // and the walk of what it laid out reads the blocks that stood for it
  probesOpen += 1;
  try {
    try {
      layoutSubtree(box, ctx, available, undefined, true);
    } finally {
      ctx.until = until;
      ctx.reach = reach;
      ctx.probing = probing;
    }
    const specified = box.style.width;
    if (!content && specified !== AUTO && Number.isFinite(box.width)) {
      return box.width;
    }
    return (
      intrinsicWidth(
        box,
        undefined,
        available === MIN_CONTENT_PROBE ? ctx : undefined,
      ) + box.horizontalExtra
    );
  } finally {
    probesOpen -= 1;
  }
}

/**
 * Lay a box and everything under it out at a width, at the origin — what
 * `LayoutContext.layoutSubtree` hands to `flex.ts` and `css-grid.ts`, and
 * what the shrink-to-fit probe and a table's cells use. A replaced box is
 * sized rather than laid out, because there is nothing inside it to lay out.
 */
export function layoutSubtree(
  box: Box,
  ctx: LayoutContext,
  width: number,
  /** Its containing block's width, where `width` is the box's own. */
  containing?: number,
  /** Whether this lays it out to measure it (`measureIntrinsicWidth`). */
  measuring = false,
): void {
  const base = containing ?? width;
  resolveEdges(box, Number.isFinite(base) ? base : 0);
  if (box.kind === 'replaced') {
    sizeReplaced(box, width);
    box.x = 0;
    box.y = 0;
    return;
  }
  // Within its limits, a percentage among them of its containing block's
  // width and not of its own: a flex item `max-width: 50%` that the flex
  // layout made half its row was laid out at a quarter of it. An
  // intrinsic limit is among them, as it is in a block's flow: without it,
  // a flex or grid item `min-width: max-content` that its layout made as
  // wide as its content was laid out at a smaller `max-width`, where the
  // minimum wins (CSS Sizing 3, 3.1). Not where the box is laid out to be
  // measured, since that is what an intrinsic limit is measured from.
  //
  // A table cell laid out in its columns, which hand it its row's width,
  // is as wide as they are (CSS Tables 3, 3.10.2): its limits are theirs
  // to weigh (3.8.2), and have been. Clamped again, `td { max-width:
  // 50px }` in a column 200 wide set its text in 50 of it. Probed for
  // what it asks of them, at none, it keeps within its length limits as
  // any box does; a percentage one is of nothing and does not hold it.
  let borderBox = Infinity;
  if (Number.isFinite(width)) {
    if (box.kind !== 'table-cell') {
      borderBox = clampWidth(box, width, base, measuring ? undefined : ctx);
    } else if (containing !== undefined) borderBox = width;
    else borderBox = clampWidth(box, width, NaN);
  }
  layoutInternals(box, ctx, borderBox, 0, 0);
}

/**
 * Lay a box's inside out and give it a height. `outerFloats` is the parent's
 * float context, passed only when this box does *not* establish one of its
 * own — which is the difference between text flowing beside a float that
 * started in an earlier sibling and text that starts below it.
 *
 * A line-clamp container's clamp is carried through its formatting context
 * (`Clamp`), and a box that makes one of its own is laid out outside it.
 */
function layoutInternals(
  box: Box,
  ctx: LayoutContext,
  borderBoxWidth: number,
  x: number,
  y: number,
  outerFloats?: FloatContext,
): void {
  const outer = ctx.clamp ?? null;
  const lines = box.style.lineClamp;
  if (lines === null && (outer === null || !establishesBFC(box))) {
    layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
    return;
  }
  if (lines === null) {
    ctx.clamp = null;
    layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
  } else {
    layoutClamped(box, ctx, lines, borderBoxWidth, x, y, outerFloats);
  }
  ctx.clamp = outer;
}

/**
 * A line-clamp container, laid out with its clamp. `line-clamp: auto`'s
 * clamp point is after the lines its height holds, where it has a height
 * of its own (CSS Overflow 4, 5.3.1): the content is laid out whole to
 * count them, and again cut after them, where they are not all of it.
 */
function layoutClamped(
  box: Box,
  ctx: LayoutContext,
  lines: number,
  borderBoxWidth: number,
  x: number,
  y: number,
  outerFloats?: FloatContext,
): void {
  const floor = lines === Infinity ? autoFloor(box, y) : Infinity;
  if (floor === Infinity) {
    // counted against the number, or where `auto` has no height to fill,
    // against none: the boxes a clamp hid before show again
    ctx.clamp = { box, left: lines, done: false, fit: null };
    layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
    return;
  }
  const fit = { floor, lines: 0, over: false };
  ctx.clamp = { box, left: Infinity, done: false, fit };
  const positioned = ctx.positioned.length;
  layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
  if (!fit.over) return;
  ctx.positioned.length = positioned;
  ctx.clamp = { box, left: fit.lines, done: fit.lines === 0, fit: null };
  layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
}

/** Where an `auto` clamp's lines have to end by, in document coordinates:
 *  the content bottom of a box as tall as its `height`, or `max-height`,
 *  lets it be — Infinity where neither is set. */
function autoFloor(box: Box, y: number): number {
  const set = resolveOrNull(box.style.height, box.percentHeightBase);
  const outer =
    set === null
      ? Infinity
      : box.style.boxSizing === 'border-box'
        ? Math.max(set, box.verticalExtra)
        : set + box.verticalExtra;
  const height = clampHeight(box, outer);
  return Number.isFinite(height)
    ? y + height - box.padBottom - box.borderBottom
    : Infinity;
}

function layoutBox(
  box: Box,
  ctx: LayoutContext,
  borderBoxWidth: number,
  x: number,
  y: number,
  outerFloats?: FloatContext,
): void {
  const until = ctx.until;
  if (until === undefined || ctx.probing || !isScroller(box)) {
    layoutBoxAt(box, ctx, borderBoxWidth, x, y, outerFloats);
    return;
  }
  // What a scroll container holds is where it is scrolled to, not where
  // the document's viewport is: it stops a viewport past what its
  // scrollport shows, or past where the document stops if that is sooner,
  // scrolled — the coordinates its content is laid out in are no scroll's
  ctx.until = scrollerUntil(box, ctx, until, y);
  try {
    layoutBoxAt(box, ctx, borderBoxWidth, x, y, outerFloats);
  } finally {
    ctx.until = until;
  }
}

/**
 * Where a layout that stops at `until` stops inside a scroll container laid
 * out at `y`: as far below what its scrollport shows as the document's
 * layout stops below what the viewport shows, where its height bounds the
 * scrollport, and where the document's stops otherwise — each moved down
 * by how far the container is scrolled. Wikipedia's menus, RFC 9110's
 * contents and every docs site's sidebar are scroll containers a window
 * tall, and were laid out whole at every step of a drag.
 */
function scrollerUntil(
  box: Box,
  ctx: LayoutContext,
  until: number,
  y: number,
): number {
  const scrolled = ctx.scrollTopOf?.(box) ?? 0;
  const own = percentBaseInside(box);
  const client = Number.isFinite(own)
    ? own
    : clampHeight(box, Infinity) - box.verticalExtra;
  const shows = y + box.borderTop + box.padTop + client;
  return scrolled + Math.min(until, shows + ctx.viewportHeight);
}

function layoutBoxAt(
  box: Box,
  ctx: LayoutContext,
  borderBoxWidth: number,
  x: number,
  y: number,
  outerFloats?: FloatContext,
): void {
  box.layoutSerial = ++layoutSerial;
  // laid out after all, and what it holds with it
  if (ctx.reused?.size) ctx.reused.delete(box);
  box.x = x;
  box.y = y;
  box.width = borderBoxWidth;
  const contentWidth = box.contentWidth;
  givePercentBase(box, percentBaseInside(box));

  if (box.kind === 'flex') {
    const height = layoutFlex(box, ctx, contentWidth);
    finishHeight(box, height);
    return;
  }
  if (box.kind === 'table') {
    const height = layoutTable(box, ctx, contentWidth);
    finishHeight(box, height);
    finishCaptions(box);
    return;
  }
  // the root of a flow in a vertical writing mode, which holds its frame
  if (framed.any) {
    const frame = FRAMES.get(box);
    if (frame) {
      layoutFramed(box, frame, ctx);
      return;
    }
  }

  // A multicol container's content is laid out as one column, all of it,
  // and then set in the columns there are (`layoutColumns`)
  const columns = columnsOf(box, contentWidth);
  // the rows of columns the last layout set its content in, which this
  // one sets again (`layoutColumns`)
  if (box.style.columns) COLUMN_BOXES.delete(box);
  const flowWidth = columns ? columns.width : contentWidth;
  const ownFloats = establishesBFC(box) || !outerFloats;
  const floats = ownFloats
    ? new FloatContext(box.contentX, box.contentX + flowWidth)
    : outerFloats;
  // the line a pass before gave a marker, which this one may not
  if (box.marker) box.lines = null;
  if (box.marker && ctx.fonts) {
    const room = markerRoom(box, box.marker, ctx.fonts);
    if (room) MARKER_ROOM.set(box, room);
    else MARKER_ROOM.delete(box);
    if (box.style.listStylePosition === 'inside') MARKER_ASCENT.delete(box);
    else MARKER_ASCENT.set(box, markerAscent(box, box.marker, ctx.fonts));
  }
  // a column wide while its content is laid out, for what reads the box
  // it is in rather than the width it is handed
  // and about a box that spans them, in rows of columns (`layoutRows`)
  const rows =
    columns && columns.count > 1 && box.children.some(spansColumns)
      ? layoutRows(box, ctx, columns, contentWidth, borderBoxWidth)
      : null;
  if (columns) box.width = columns.width + box.horizontalExtra;
  const flow =
    rows === null
      ? layoutChildren(box, ctx, floats, box.contentY, flowWidth)
      : { height: rows, hanging: NO_MARGIN };
  box.width = borderBoxWidth;
  // A list item with a marker and no line holds one, the marker's, a line
  // of its own face tall: an empty `<li>` is a line tall in a browser, and
  // an inline-block around one sits on its marker's baseline.
  let height = flow.height;
  if (box.marker && ctx.fonts && !firstLineIn(box)) {
    const own = strutOf(ctx.fonts, box.style);
    // as tall as the marker on it, as a first line with text is
    const room = MARKER_ROOM.get(box);
    const strut = room
      ? {
          ascent: Math.max(own.ascent, room.ascent),
          descent: Math.max(own.descent, room.descent),
        }
      : own;
    const line = strut.ascent + strut.descent;
    box.lines = [
      {
        x: box.contentX,
        y: box.contentY,
        width: 0,
        height: line,
        baseline: strut.ascent,
        texts: [],
        textStart: box.subtreeTextStart,
        textEnd: box.subtreeTextStart,
        atomics: [],
      },
    ];
    height = Math.max(height, line);
  }
  // A box that establishes a formatting context contains its own floats, so
  // it has to be at least as tall as they are. One that does not, does not —
  // that is the classic "collapsed parent" every author has met.
  // Past a clamp point, a line-clamp container clips its floats rather
  // than holding them (CSS Overflow 4, 5.3.1).
  const clamped = ctx.clamp?.box === box && ctx.clamp.done;
  const withFloats =
    ownFloats && !clamped
      ? Math.max(
          height,
          floats.bottom === -Infinity ? 0 : floats.bottom - box.contentY,
        )
      : height;
  if (rows !== null) finishHeight(box, rows);
  else if (columns) {
    finishHeight(
      box,
      layoutColumns(box, columns, withFloats, columnLimit(box)),
    );
  } else {
    if (box.style.columns) forgetColumns(box);
    finishHeight(box, withFloats);
  }
  // The margin that escaped through this box's bottom edge becomes part of
  // its own: the parent's flow loop reads `child.marginBottom` for the next
  // sibling's collapse, which is exactly where an escaped margin goes.
  // Kept as a strut too, for the next sibling's margins to collapse with
  // all of the ones it came to rather than with their sum.
  if (flow.hanging.pos || flow.hanging.neg) {
    const bottom = join(flow.hanging, box.marginBottom);
    box.bottomStrut = bottom;
    box.marginBottom = marginOf(bottom);
  } else box.bottomStrut = null;
  if (box.marker) layoutMarker(box, box.marker, ctx);
  if (isButtonBlock(box)) {
    BUTTON_CONTENT.set(box, { height: withFloats, down: 0 });
    centreButton(box);
  }
}

/**
 * The root of an orthogonal flow (CSS Writing Modes 4, 7.3), laid out by its
 * parent in the page's axes and holding its frame, which is laid out in the
 * flow's: across the frame is down the page (`layout/writing.ts`).
 *
 * The frame is as wide as the root's height where the root has one of its
 * own, and else as wide as its content asks within the room there is down
 * the page — its containing block's height where that is definite, and the
 * viewport's where it is not (7.3.1), less the root's own margins, borders
 * and padding down it: fit-content, its max-content where that fits and no
 * narrower than its min-content. The root is as tall as that, and as wide
 * as its parent's layout made it, which asks it for what the frame came to
 * down its own block axis (`intrinsicWidth`); the frame's corner goes where
 * the turn puts the flow's start, the right of the root's content box for
 * the modes turned clockwise and its bottom left for `sideways-lr`.
 *
 * The frame is laid out whole: what a layout that stops would stop at is a
 * height down the page, and the frame's heights are across it.
 */
function layoutFramed(box: Box, frame: Box, ctx: LayoutContext): void {
  const mode = box.style.writingMode;
  const inline = frameInlineSize(box, frame, ctx);
  const across = box.contentWidth;
  const { until, reach, keep } = ctx;
  ctx.until = undefined;
  ctx.reach = undefined;
  ctx.keep = undefined;
  try {
    resolveEdges(frame, inline);
    frame.percentHeightBase = Number.isFinite(across) ? across : NaN;
    layoutInternals(frame, ctx, inline, 0, 0);
  } finally {
    ctx.until = until;
    ctx.reach = reach;
    ctx.keep = keep;
  }
  const block = frame.height;
  // an orthogonal flow is as wide as its block size, at its least and its
  // most alike (7.3.2): what its parent sizes it from
  box.intrinsicMinContent = block + box.horizontalExtra;
  finishHeight(box, inline);
  const room = Number.isFinite(across) ? across : block;
  if (turnsUp(mode)) {
    moveTo(frame, box.contentX, box.contentY + box.contentHeight);
  } else moveTo(frame, box.contentX + room, box.contentY);
  if (reflects(mode)) reflectFrame(frame, room, translate, moveLine);
}

/** How wide a frame is laid out, which is how tall its root's content box
 *  is (`layoutFramed`). */
function frameInlineSize(box: Box, frame: Box, ctx: LayoutContext): number {
  const own = percentBaseInside(box);
  if (Number.isFinite(own)) return own;
  // the initial containing block's, which is the viewport's height, read
  // as a percentage height on the root reads it (`readsViewportHeight`)
  let base = box.percentHeightBase;
  if (!Number.isFinite(base)) {
    base = ctx.viewportHeight;
    ctx.readViewportHeight = true;
  }
  const room = clampHeight(
    box,
    Math.max(0, base - box.marginTop - box.marginBottom),
  );
  const available = Math.max(0, room - box.verticalExtra);
  if (frame.intrinsicMaxContent < 0) {
    frame.intrinsicMaxContent = measureIntrinsicWidth(frame, ctx, Infinity);
  }
  let size = frame.intrinsicMaxContent;
  if (size > available) {
    if (frame.intrinsicMinContent < 0) {
      frame.intrinsicMinContent = measureIntrinsicWidth(
        frame,
        ctx,
        MIN_CONTENT_PROBE,
      );
    }
    size = Math.max(frame.intrinsicMinContent, available);
  }
  // within its own `min-height` and `max-height`
  return clampHeight(box, size + box.verticalExtra) - box.verticalExtra;
}

/** Move a line and what is on it down by `dy`, as `translate` moves a
 *  block's lines. */
function moveLine(line: LineBox, dy: number): void {
  if (!dy) return;
  line.y += dy;
  for (const text of line.texts) text.drawY += dy;
  for (const placed of line.atomics) {
    placed.y += dy;
    translate(placed.box, 0, dy);
  }
}

/**
 * A multicol container's content about the boxes that span its columns
 * (`column-span: all`, CSS Multi-column 1, 6): what comes before one is set
 * in columns of its own, balanced, the spanner under them across the whole
 * container, and what comes after in columns under that. A spanner is a
 * formatting context of its own and its margins collapse with no column
 * content's, only with the spanner's next to it. Answers the content's
 * height.
 */
function layoutRows(
  box: Box,
  ctx: LayoutContext,
  columns: Columns,
  contentWidth: number,
  borderBoxWidth: number,
): number {
  const all = box.children;
  const limit = columnLimit(box);
  const top = box.contentY;
  let y = top;
  /** The bottom margin of the spanner just before, which the next thing
   *  comes under: all of it, or what the next spanner's does not cover. */
  let margin: number | null = null;
  let from = 0;
  try {
    for (let i = 0; i <= all.length; i += 1) {
      const child = all[i];
      if (child && !spansColumns(child)) continue;
      const row = all.slice(from, i);
      from = i + 1;
      if (row.length) {
        const set = row.some(
          (in_) =>
            in_.kind !== 'text' && in_.kind !== 'break' && !in_.outOfFlow,
        );
        if (set && margin !== null) {
          y += margin;
          margin = null;
        }
        // the row's content as a strip a column wide, and then in columns,
        // no taller than the container has left
        box.children = row;
        box.width = columns.width + box.horizontalExtra;
        const floats = new FloatContext(
          box.contentX,
          box.contentX + columns.width,
        );
        const flow = layoutChildren(box, ctx, floats, y, columns.width);
        box.width = borderBoxWidth;
        const strip = Math.max(
          flow.height,
          floats.bottom === -Infinity ? 0 : floats.bottom - y,
        );
        y += layoutColumns(
          box,
          columns,
          strip,
          Math.max(0, limit - (y - top)),
          y,
        );
      }
      if (!child) break;
      resolveEdges(child, contentWidth);
      y +=
        margin === null ? child.marginTop : Math.max(margin, child.marginTop);
      layoutBlockLevel(
        child,
        ctx,
        new FloatContext(box.contentX, box.contentX + contentWidth),
        box.contentX,
        y,
        contentWidth,
      );
      y = child.y + child.height;
      margin = child.marginBottom;
    }
  } finally {
    box.children = all;
    box.width = borderBoxWidth;
  }
  return y + (margin ?? 0) - top;
}

/** The tallest a multicol container's columns may be: its own height where
 *  it has one, and its `max-height`; no limit where it has neither. */
function columnLimit(box: Box): number {
  const height = box.height;
  finishHeight(box, specifiedHeight(box) === null ? Infinity : 0);
  const limit = box.height - box.verticalExtra;
  box.height = height;
  return Math.max(0, limit);
}

/**
 * The room a list item's marker takes about its first line's baseline,
 * handed to the box that line is in: an image's height above it, its
 * bottom on the baseline as an inline image's is, and a marker in a face
 * of its own — a `::marker` rule's — its face at its line height. CSS 2.1
 * (12.5.1) leaves where an outside marker goes to the user agent; Blink
 * and Gecko both set it on the item's first line and make the line as tall
 * as it, and design 032's bullets, images taller than its 10px text, set
 * every item's first line lower than ours did.
 */
const MARKER_ROOM = new WeakMap<Box, InlineDecoration>();

function markerRoom(
  box: Box,
  marker: Marker,
  fonts: FontsLike,
): InlineDecoration | null {
  if (marker.image) {
    return marker.image.height > 0
      ? { ascent: marker.image.height, descent: 0 }
      : null;
  }
  return marker.style && marker.style !== box.style
    ? strutOf(fonts, marker.style)
    : null;
}

/**
 * How far an outside marker reaches above the baseline it sits on. The
 * marker is a line of its own face, the item's or a `::marker` rule's, so a
 * bullet or a number reaches its face's ascent on that line, and an image,
 * set on the line bottom on the baseline, the higher of that and its own
 * height. Where the item's first line is in a block inside it — a link set
 * `display: block`, a paragraph — and the block's first baseline is nearer
 * its top than that, the block goes lower by the difference, and its line
 * stays the height it was: CSS 2.1 (12.5.1) leaves this to the user agent,
 * and Blink aligns the marker's baseline with the block's and pushes the
 * block down (`UnpositionedListMarker::AddToBox`). Its first line grew
 * instead, and design 196's links, under 18px bullets, were 21px tall where
 * Chrome has them 14px, 7px lower. On the item's own line the two come to
 * the same: the line grows by what the push would have moved it.
 */
const MARKER_ASCENT = new WeakMap<Box, number>();

function markerAscent(box: Box, marker: Marker, fonts: FontsLike): number {
  const ascent = strutOf(fonts, marker.style ?? box.style).ascent;
  return marker.image ? Math.max(marker.image.height, ascent) : ascent;
}

/** The first line box anywhere under a box, in layout order. */
function firstLineIn(box: Box): LineBox | null {
  if (box.lines?.length) return box.lines[0];
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    const found = firstLineIn(child);
    if (found) return found;
  }
  return null;
}

/**
 * A list item's marker.
 *
 * `outside` — the default, and what `<ul>`'s padding leaves room for — sits
 * in the padding to the left of the content, right-aligned against it so a
 * list numbered past 9 stays lined up. `inside` sits at the content edge and
 * the text does not reserve room for it, which is what the keyword means.
 *
 * The marker is laid out here rather than being a box because it is not
 * content: it must not join the selection, or copying a list would paste a
 * bullet before every line.
 */
const MARKER_GAPS = new WeakMap<FontsLike, Map<string, number>>();

/**
 * The gap after a marker, a space's width in its face: kept per face and
 * fonts, since a list is a column of markers set alike, and laying the
 * space out for each of them was most of what a long document's markers
 * cost.
 */
function markerGap(fonts: FontsLike, face: Omit<TextRun, 'text'>): number {
  let gaps = MARKER_GAPS.get(fonts);
  if (!gaps) MARKER_GAPS.set(fonts, (gaps = new Map()));
  const key = `${face.family}\u0001${face.size}\u0001${String(face.weight ?? '')}\u0001${String(face.style ?? '')}`;
  let gap = gaps.get(key);
  if (gap === undefined) {
    gap = fonts.layout([{ text: '\u00a0', ...face }], face, {}).width;
    gaps.set(key, gap);
  }
  return gap;
}

function layoutMarker(box: Box, marker: Marker, ctx: LayoutContext): void {
  const fonts = ctx.fonts;
  if (!fonts) return;
  const style = box.style;
  if (marker.image) {
    // an image: its bottom on the first line's baseline, as an inline
    // image's is, and its own gap before the content (`MARKER_IMAGE_GAP`)
    const first = firstLineIn(box);
    marker.y = first
      ? first.y + first.baseline - marker.image.height
      : box.contentY;
    const { gap } = marker.image;
    // at the start of the line, which is its right in a right-to-left item
    marker.x =
      style.direction === 'rtl'
        ? box.contentX + box.contentWidth + gap
        : box.contentX - gap - marker.image.width;
    return;
  }
  // in its own style where a `::marker` rule gives it one — the colour and
  // the face a bullet or a number is set in — and the item's where not
  const set = marker.style ?? style;
  const face = {
    family: set.fontFamily,
    size: set.fontSize,
    color: set.color,
    ...(marker.style
      ? {
          weight: set.fontWeight,
          style:
            set.fontStyle === 'normal'
              ? ('normal' as const)
              : ('italic' as const),
        }
      : null),
  };
  // set in a line of the item's own height, so that where the item has no
  // line of its own the marker stands where its first would have been
  // in the item's direction, which puts a number's full stop on its left
  // in a right-to-left list, as the bidi algorithm has it
  const layout = fonts.layout([{ text: marker.text, ...face }], face, {
    lineHeight: lineHeightMultiplier(fonts, style),
    direction: style.direction,
  });
  marker.layout = layout;
  // a space between it and the content — the one its style's suffix ends
  // in, or its own text's — in its own face: a line measures without the
  // spaces it ends in, and with a no-break space, which `content: "1.\a0"`
  // writes and which was a second gap on top of its own
  const trailing = marker.flush
    ? (/[ \t\n\r\f]*$/.exec(marker.text)?.[0].length ?? 0)
    : 1;
  const gap = trailing ? trailing * markerGap(fonts, face) : 0;
  // The marker sits on the first line of the item's *content*, which is not
  // always the item's own: an `<li>` holding a paragraph, or one holding text
  // and a nested list, has its inline content in an anonymous block. Looking
  // only at `box.lines` puts the marker of every such item at the content
  // top, which reads as a missing bullet rather than a misplaced one. An
  // empty item is still a list item, and its marker a line at its top.
  const first = firstLineIn(box);
  const own = layout.lines[0];
  marker.y = first
    ? first.y + first.baseline - (own ? own.baseline : style.fontSize)
    : box.contentY;
  marker.x =
    style.listStylePosition === 'inside'
      ? box.contentX
      : style.direction === 'rtl'
        ? box.contentX + box.contentWidth + gap
        : box.contentX - gap - layout.width;
}

/**
 * The height a percentage `height` inside a box resolves against: its own
 * content height, where that is set rather than grown from its content —
 * a length, or a percentage that itself resolved (CSS 2.1 10.5). NaN, and
 * so `auto`, where it is not. An anonymous box is no containing block for
 * this (9.2.1.1) and hands on its parent's.
 *
 * The root element's is the viewport's height, so `html, body { height:
 * 100% }` — which mail sets as often as not — is a window tall, as in a
 * browser; the document is as tall as what overflows it, so a message
 * longer than the window is not cut off (`layoutDocument`).
 */
export function percentBaseInside(box: Box): number {
  const flexed = FLEXED_HEIGHT.get(box);
  if (flexed !== undefined) return flexed;
  if (!box.el && !box.pseudo) return box.percentHeightBase;
  const resolved = specifiedHeight(box);
  if (resolved === null) {
    // a height `aspect-ratio` gives from a width is as definite as the width
    const ratio = ratioHeight(box);
    if (ratio === null) return NaN;
    return Math.max(
      0,
      clampHeight(box, ratio + box.verticalExtra) - box.verticalExtra,
    );
  }
  const set = Math.max(0, resolved);
  const borderBox =
    box.style.boxSizing === 'border-box'
      ? Math.max(set, box.verticalExtra)
      : set + box.verticalExtra;
  return Math.max(0, clampHeight(box, borderBox) - box.verticalExtra);
}

/** Whether anything in a box takes a percentage of a height: what a height
 *  a flex or grid layout makes definite changes. Kept for the tree's life. */
export function percentHeightsIn(box: Box): boolean {
  let found = PERCENT_HEIGHTS.get(box);
  if (found === undefined) {
    found = false;
    // a column's basis is a height too
    const column =
      box.kind === 'flex' &&
      !box.style.grid &&
      box.style.flexDirection.startsWith('column');
    for (const child of box.children) {
      const style = child.style;
      if (
        isPct(style.height) ||
        isPct(style.minHeight) ||
        (style.maxHeight !== 'none' && isPct(style.maxHeight)) ||
        (column && style.flexBasis !== 'content' && isPct(style.flexBasis)) ||
        percentHeightsIn(child)
      ) {
        found = true;
        break;
      }
    }
    PERCENT_HEIGHTS.set(box, found);
  }
  return found;
}

const PERCENT_HEIGHTS = new WeakMap<Box, boolean>();

/**
 * A box's own height, where it has one, as `box-sizing` measures it: a
 * length, a percentage of a height that resolves, or `stretch`'s, and else
 * none, which is `auto`.
 */
function specifiedHeight(box: Box): number | null {
  const style = box.style;
  if (style.heightKeyword === 'stretch') {
    const outer = stretchHeight(box);
    if (outer === null) return null;
    return style.boxSizing === 'border-box'
      ? outer
      : Math.max(0, outer - box.verticalExtra);
  }
  return resolveOrNull(style.height, box.percentHeightBase);
}

/** Where an absolutely positioned box's `stretch` height starts in its
 *  containing block: its `top`, or its static position where it has
 *  neither offset (`layoutPositioned`). */
const STRETCH_TOP = new WeakMap<Box, number>();

/**
 * A replaced box's `stretch` sizes, which `sizeReplaced` knows nothing of:
 * the width it was given for one across, the height its offsets leave for
 * one down, and through its ratio, the other where that is `auto`.
 */
function stretchReplaced(
  box: Box,
  across: number | null,
  containingWidth: number,
): void {
  const style = box.style;
  const down = style.heightKeyword === 'stretch' ? stretchHeight(box) : null;
  if (across === null && down === null) return;
  if (across !== null) box.width = across;
  if (down !== null) box.height = clampHeight(box, down);
  if (across !== null && down === null && style.height === AUTO) {
    const tall = heightThroughRatio(box, across);
    if (tall !== null) box.height = clampHeight(box, tall);
  } else if (down !== null && across === null && style.width === AUTO) {
    const wide = widthThroughRatio(box, box.height);
    if (wide !== null) box.width = clampWidth(box, wide, containingWidth);
  }
}

/**
 * The border-box height `stretch` makes of a box (CSS Sizing 3, 4.2): what
 * its margins leave of the height its percentages are of, where that is
 * definite, and else none. A margin of an in-flow block that its parent's
 * border or padding does not part from the parent's edge, in a parent that
 * is no formatting context of its own, counts as none, as the margin would
 * collapse with the parent's.
 */
function stretchHeight(box: Box): number | null {
  const base = box.percentHeightBase;
  if (!Number.isFinite(base)) return null;
  const style = box.style;
  if (style.position === 'absolute' || style.position === 'fixed') {
    // what its offsets leave of its containing block, an `auto` one none
    // — or its static position, where both are (`layoutPositioned`)
    const top = STRETCH_TOP.get(box) ?? resolveOrNull(style.top, base) ?? 0;
    const bottom = resolveOrNull(style.bottom, base) ?? 0;
    return Math.max(
      box.verticalExtra,
      base - top - bottom - box.marginTop - box.marginBottom,
    );
  }
  const parent = box.parent;
  const inFlow =
    parent !== null &&
    !box.outOfFlow &&
    !box.isFloat &&
    box.kind !== 'replaced' &&
    !isInlineLevel(box) &&
    !establishesBFC(parent);
  const top = inFlow && !parent.borderTop && !parent.padTop ? 0 : box.marginTop;
  const bottom =
    inFlow && !parent.borderBottom && !parent.padBottom ? 0 : box.marginBottom;
  return Math.max(box.verticalExtra, base - top - bottom);
}

/**
 * The content height a flex or grid layout made definite for an item — a
 * stretched item's, a flexed one's in a container of a definite height (CSS
 * Flexbox 9.8), a grid item's stretched down its area (CSS Grid 1, 11.1) —
 * which what is in it takes its percentages of, and which an item that is
 * a flex or grid container itself lays its own items out in, and a table
 * shares out among its rows. Set by `flex.ts` and `css-grid.ts` for the
 * item's own layout alone, and by `layoutPositioned` for an absolute box's
 * between two offsets.
 */
export const FLEXED_HEIGHT = new WeakMap<Box, number>();

/**
 * The content height a flex layout gave an item without making it definite:
 * flexed along a column that has no height of its own, which 9.8 leaves
 * indefinite. An item that is a flex or grid container lays its own items
 * out in it all the same — it is its used size (9.7) — as a table shares
 * it among its rows, and nothing in it takes a percentage of it. Set by
 * `flex.ts` for the item's own layout alone.
 */
export const USED_HEIGHT = new WeakMap<Box, number>();

/**
 * A table a grid or a flex layout gives its width, whose `auto` width is
 * then the one it is laid out at. `normal` stretches any grid item but a
 * replaced one across its area (CSS Grid 1, 6.2), and a flex item across a
 * column's line (CSS Flexbox 9.4, step 11), a table among them; and a flex
 * item along a row is the size the line flexed it to (9.7) — where in a
 * block's flow a table's `auto` width is its columns' (CSS 2.1 17.5.2;
 * Blink leaves tables out of the boxes a block stretches, `space_utils.cc`,
 * and stretches them in a grid, `grid_item.cc`, and a flex box). Set by
 * `css-grid.ts` and `flex.ts` for the item's own layout alone, and never
 * while its widths are measured.
 */
export const STRETCHED_ACROSS = new WeakSet<Box>();

/**
 * Hand a box's children the height their percentages resolve against —
 * through inline boxes, which are no containing block, to the inline-block
 * or image in them. Nearly every box has none to give, and its children
 * hold NaN until it has, so it visits them only when there is a height, or
 * was one on the last pass: visiting every child of every block on every
 * pass cost more than laying out a table.
 */
function givePercentBase(box: Box, base: number): void {
  const given = !Number.isNaN(base);
  if (!given && !box.gavePercentBase) return;
  box.gavePercentBase = given;
  handPercentBase(box, base);
}

function handPercentBase(box: Box, base: number): void {
  for (const child of box.children) {
    child.percentHeightBase = base;
    if (child.kind === 'inline') handPercentBase(child, base);
  }
}

/**
 * The content height `aspect-ratio` gives a box whose height is `auto`, from
 * its width (CSS Sizing 4, 5.1): the ratio is of the box its `box-sizing`
 * names, which is the border box in everything Tailwind writes. Null where
 * it has none, or a height of its own; a replaced box is sized apart.
 */
export function ratioHeight(box: Box): number | null {
  const ratio = boxRatio(box);
  if (!ratio) return null;
  if (resolveOrNull(box.style.height, box.percentHeightBase) !== null) {
    return null;
  }
  return ratio.border
    ? Math.max(0, box.width / ratio.ratio - box.verticalExtra)
    : Math.max(0, box.contentWidth / ratio.ratio);
}

/**
 * A box's `aspect-ratio` where it is not replaced, and whether it is of its
 * border box — a ratio written alone under `box-sizing: border-box` — or
 * of its content box, as one written `auto` with it is whatever the
 * `box-sizing` (CSS Sizing 4, 5.1).
 */
export function boxRatio(box: Box): { ratio: number; border: boolean } | null {
  const aspect = box.style.aspectRatio;
  if (!aspect || box.kind === 'replaced' || !(aspect.ratio > 0)) return null;
  return {
    ratio: aspect.ratio,
    border: box.style.boxSizing === 'border-box' && !aspect.auto,
  };
}

/** A border-box height through a box's ratio into its border-box width,
 *  or null where the box has no ratio of its own. */
export function widthFromHeight(box: Box, height: number): number | null {
  const ratio = boxRatio(box);
  return ratio ? acrossRatio(box, ratio, height) : null;
}

/** A replaced element's ratio: its `aspect-ratio`, unless that says `auto`
 *  and it has one of its own, as `sizeReplaced` takes it. */
export function replacedRatio(box: Box): number {
  const own = ownIntrinsic(box);
  const aspect = box.style.aspectRatio;
  const natural = own ? own.ratio : 0;
  return aspect && !(aspect.auto && natural > 0) ? aspect.ratio : natural;
}

/**
 * A replaced element's own size and ratio, as layout is to read them: its
 * content's, or under size containment none but the size
 * `contain-intrinsic-size` gives it (CSS Containment 2, 3.2) — which is how
 * HTML lays out an image whose `sizes` is `auto`, so that the candidate its
 * width picks cannot change that width. Every reader in layout goes
 * through this, the flex item's least size and basis among them.
 */
export function ownIntrinsic(box: Box): Intrinsic | null {
  if (!contained(box, CONTAIN_SIZE)) return box.intrinsic;
  const style = box.style;
  return {
    width: style.containIntrinsicWidth ?? 0,
    height: style.containIntrinsicHeight ?? 0,
    ratio: 0,
    missing: 0,
  };
}

/** A border-box height through any box's ratio into its border-box width
 *  — a replaced element's is of its content box — or null where it has
 *  none. */
export function widthThroughRatio(box: Box, height: number): number | null {
  if (box.kind !== 'replaced') return widthFromHeight(box, height);
  const ratio = replacedRatio(box);
  return ratio > 0
    ? Math.max(0, height - box.verticalExtra) * ratio + box.horizontalExtra
    : null;
}

/** A border-box width through any box's ratio into its border-box height,
 *  or null where it has none. */
export function heightThroughRatio(box: Box, width: number): number | null {
  if (box.kind !== 'replaced') return heightFromWidth(box, width);
  const ratio = replacedRatio(box);
  return ratio > 0
    ? Math.max(0, width - box.horizontalExtra) / ratio + box.verticalExtra
    : null;
}

/** A border-box width through a box's ratio into its border-box height,
 *  or null where the box has no ratio of its own. */
export function heightFromWidth(box: Box, width: number): number | null {
  const ratio = boxRatio(box);
  if (!ratio) return null;
  return ratio.border
    ? width / ratio.ratio
    : Math.max(0, width - box.horizontalExtra) / ratio.ratio +
        box.verticalExtra;
}

/** A border-box height through a box's ratio into its border-box width. */
function acrossRatio(
  box: Box,
  ratio: { ratio: number; border: boolean },
  height: number,
): number {
  return ratio.border
    ? height * ratio.ratio
    : Math.max(0, height - box.verticalExtra) * ratio.ratio +
        box.horizontalExtra;
}

/**
 * The border-box width `aspect-ratio` gives a box whose width is `auto`
 * from a height of its own, within its least and greatest heights (CSS
 * Sizing 4, 5.1): a block is that wide, not as wide as its room — and so
 * is one whose width is its content's, `min-content` or `fit-content`, as
 * its content is that height through its ratio (5.3). Null where it has
 * no ratio, no height or a length for a width.
 */
export function ratioWidth(box: Box): number | null {
  const ratio = boxRatio(box);
  const style = box.style;
  if (!ratio || style.width !== AUTO) return null;
  const set = resolveOrNull(style.height, box.percentHeightBase);
  if (set === null) return null;
  const outer = clampHeight(
    box,
    style.boxSizing === 'border-box'
      ? Math.max(set, box.verticalExtra)
      : set + box.verticalExtra,
  );
  return acrossRatio(box, ratio, outer);
}

/**
 * A width its ratio gave a box, no narrower than its content at its
 * narrowest where its least width is `auto` and it shows what overflows
 * it — the automatic minimum of a box with a ratio (5.2) — though no
 * wider for that than its greatest width.
 */
function ratioMinimum(
  box: Box,
  width: number,
  containingWidth: number,
  ctx?: LayoutContext,
): number {
  const style = box.style;
  if (
    !ctx ||
    style.minWidth !== AUTO ||
    style.minWidthKeyword ||
    scrolls(style)
  ) {
    return width;
  }
  if (box.intrinsicMinContent < 0) {
    const saved = box.lines;
    box.intrinsicMinContent = measureIntrinsicWidth(
      box,
      ctx,
      MIN_CONTENT_PROBE,
    );
    box.lines = saved;
    resolveEdges(box, containingWidth);
  }
  const max =
    style.maxWidth === 'none'
      ? Infinity
      : (resolveOrNull(style.maxWidth, containingWidth) ?? Infinity) +
        (style.boxSizing === 'border-box' ? 0 : box.horizontalExtra);
  return Math.max(width, Math.min(box.intrinsicMinContent, max));
}

/** A table cell's height as its content came to, border box, apart from a
 *  height it sets: what `vertical-align` moves in the cell (`table.ts`). */
export const CELL_CONTENT = new WeakMap<Box, number>();

function finishHeight(box: Box, contentHeight: number): void {
  // as though it held nothing, under size containment
  if (contained(box, CONTAIN_SIZE)) {
    contentHeight = box.style.containIntrinsicHeight ?? 0;
  }
  if (box.kind === 'table-cell') {
    CELL_CONTENT.set(box, contentHeight + box.verticalExtra);
  }
  // A table a flex or grid layout gave a height is as tall as that, or as
  // its rows where they need more, which `layoutTable` has shared it out
  // among — whatever height it has of its own, which the flex layout
  // started from (`layoutTable`)
  if (box.kind === 'table' && Number.isFinite(givenHeight(box))) {
    box.height = contentHeight + box.verticalExtra;
    return;
  }
  const set = specifiedHeight(box);
  // at least zero: a `calc()` may come to less
  const specified = set === null ? null : Math.max(0, set);
  if (specified !== null && box.kind === 'table') {
    // A table's height is a least one, which `layoutTable` has shared out
    // to its rows: one set shorter than they are leaves them their height
    // (CSS 2.1 17.5.3). Taken as the table's, it ended its background
    // over its rows, and a float after it went up beside them.
    const outer =
      box.style.boxSizing === 'border-box'
        ? specified
        : specified + box.verticalExtra;
    box.height = Math.max(
      clampHeight(box, outer),
      contentHeight + box.verticalExtra,
    );
    return;
  }
  if (specified === null && box.style.aspectRatio) {
    const ratio = ratioHeight(box);
    if (ratio !== null) {
      // the ratio's height, grown to what the box holds unless it clips it
      // or has a least height of its own (5.2: the automatic minimum of a
      // box with a ratio is its content, and `min-height: 0` is none)
      const automatic =
        box.style.minHeight === AUTO &&
        box.style.minHeightKeyword === null &&
        !scrolls(box.style);
      contentHeight = automatic ? Math.max(ratio, contentHeight) : ratio;
    }
  }
  // a `calc-size()` of the content's height (CSS Values 5, 9)
  if (specified === null && box.style.heightSize) {
    box.height = clampHeight(
      box,
      sizedBy(
        box.style.heightSize,
        contentHeight + box.verticalExtra,
        box.verticalExtra,
        box.style.boxSizing,
        box.percentHeightBase,
      ),
    );
    return;
  }
  const height = specified ?? contentHeight;
  const borderBox =
    box.style.boxSizing === 'border-box' && specified !== null
      ? Math.max(height, box.verticalExtra)
      : height + box.verticalExtra;
  box.height = clampHeight(box, borderBox);
}

export function clampHeight(box: Box, height: number): number {
  let out = height;
  const base = box.percentHeightBase;
  // a percentage of a height nothing sets is zero for a minimum (CSS 2.1
  // 10.7), which leaves a `calc()` its pixels; so is `stretch`, which is a
  // border-box height where it is one
  if (box.style.maxHeightKeyword === 'stretch') {
    out = Math.min(out, stretchHeight(box) ?? Infinity);
  }
  if (box.style.minHeightKeyword === 'stretch') {
    out = Math.max(out, stretchHeight(box) ?? 0);
  }
  const min =
    box.style.minHeight === AUTO
      ? 0
      : resolve(box.style.minHeight, Number.isFinite(base) ? base : 0);
  const max =
    box.style.maxHeight === 'none'
      ? null
      : resolveOrNull(box.style.maxHeight, base);
  if (max !== null)
    out = Math.min(
      out,
      max + (box.style.boxSizing === 'border-box' ? 0 : box.verticalExtra),
    );
  if (min !== null)
    out = Math.max(
      out,
      min + (box.style.boxSizing === 'border-box' ? 0 : box.verticalExtra),
    );
  // no shorter than its padding and borders, as `clampWidth` is no
  // narrower
  return Math.max(box.verticalExtra, out);
}

/** Place a block-level box horizontally, honouring `margin: auto`. */
function placeBlock(
  box: Box,
  contentLeft: number,
  y: number,
  containingWidth: number,
  /** Whether the containing block is right-to-left: its parent's, but for
   *  the root box, which has none (`layoutDocument`). */
  rtl = box.parent?.style.direction === 'rtl',
): void {
  const style = box.style;
  const leftAuto = style.marginLeft === AUTO;
  const rightAuto = style.marginRight === AUTO;
  const slack = containingWidth - box.width - box.marginLeft - box.marginRight;
  // what the width and the margins do not add up to goes to the margin at
  // the end: the right one, or in a right-to-left containing block the
  // left one, and a box too wide overflows there (CSS 2.1 10.3.3)
  // an alignment around it places a box its margins do not (HTML's
  // `<center>` and `align`)
  const aligned = leftAuto || rightAuto ? null : box.parent?.style.alignBlocks;
  let left = contentLeft + box.marginLeft;
  // In the unbounded room a shrink-to-fit probe lays a box out in, there is
  // no slack to share: half of an infinite one put an auto-margined box at
  // x = Infinity, and the pass after moved it from there by a finite amount
  // — NaN, which went up every ink bound above it and left a whole article
  // unpainted.
  if (!Number.isFinite(slack)) {
    box.x = left;
    box.y = y;
    return;
  }
  if (slack > 0) {
    if (leftAuto && rightAuto) left = contentLeft + slack / 2 + box.marginLeft;
    else if (aligned) {
      if (aligned === 'center') left += slack / 2;
      else if (aligned === 'right') left += slack;
    } else if (leftAuto || (rtl && !rightAuto)) {
      left = contentLeft + slack + box.marginLeft;
    }
  } else if (rtl) {
    left = contentLeft + slack + box.marginLeft;
  }
  box.x = left;
  box.y = y;
}

/** The border-box width of an in-flow block-level box: the room its
 *  margins leave, a length, or an intrinsic size where `ctx` is there to
 *  measure it with. */
function blockWidth(
  box: Box,
  containingWidth: number,
  percentBase = containingWidth,
  ctx?: LayoutContext,
): number {
  const style = box.style;
  const available = containingWidth - box.marginLeft - box.marginRight;
  if (style.width === AUTO || cyclicWidth(style, percentBase)) {
    // a width its height gives it through its ratio
    const fromRatio = ratioWidth(box);
    if (fromRatio !== null) {
      const clamped = clampWidth(box, fromRatio, percentBase, ctx);
      return ratioMinimum(box, clamped, percentBase, ctx);
    }
    const room = Math.max(0, available);
    const keyword =
      style.widthKeyword ?? (fitsContent(box) ? 'fit-content' : null);
    let width =
      keyword && ctx
        ? contentSizedWidth(box, ctx, keyword, room, percentBase)
        : room;
    // a `calc-size()` of that width (CSS Values 5, 9)
    if (style.widthSize) {
      width = sizedBy(
        style.widthSize,
        width,
        box.horizontalExtra,
        style.boxSizing,
        percentBase,
      );
    }
    return clampWidth(
      box,
      transferredWidth(box, width),
      percentBase,
      ctx,
      containingWidth,
    );
  }
  // at least zero: a `calc()` may come to less
  const specified = Math.max(0, resolve(style.width, percentBase, 0));
  const borderBox =
    style.boxSizing === 'border-box'
      ? Math.max(specified, box.horizontalExtra)
      : specified + box.horizontalExtra;
  return clampWidth(box, borderBox, percentBase, ctx, containingWidth);
}

/**
 * A border-box size a `calc-size()` makes of the one its keyword gives a
 * box, `border` that size as a border box (CSS Values 5, 9): `size` of it,
 * as the property measures it — its content box but under `box-sizing:
 * border-box` — with `plus` added, a percentage of `base`, and none of it
 * less than nothing.
 */
export function sizedBy(
  sized: SizeOf,
  border: number,
  extra: number,
  boxSizing: ComputedStyle['boxSizing'],
  base: number,
): number {
  const content = boxSizing !== 'border-box';
  const basis = content ? Math.max(0, border - extra) : border;
  const plus = resolve(sized.plus, Number.isFinite(base) ? base : 0);
  const value = Math.max(0, sized.size * basis + plus);
  return content ? value + extra : Math.max(value, extra);
}

/**
 * Whether a block-level box's `width: auto` is `fit-content` and not the
 * room its margins leave: a `<button>`'s, of which HTML's rendering section
 * says "If the computed value of 'inline-size' is 'auto', then the used
 * value is the fit-content inline size" (button layout, 15.5.3) — whatever
 * it is laid out as inside, a block, a flex box or a grid, as Blink leaves
 * it out of the boxes whose `auto` stretches
 * (`ShouldBlockContainerChildStretchAutoInlineSize`). Set `display: block`
 * to stand on a line of its own, a button was as wide as the line, where it
 * is as wide as its label. Not one a flex box, a grid or a pair of offsets
 * sizes, which stretch it still.
 *
 * Asked of every block: most are told from a button by the length of their
 * name.
 */
function fitsContent(box: Box): boolean {
  if (box.el === null) return false;
  const n = box.el.name.length;
  return (n === 6 || n === 5) && isButton(box);
}

/**
 * Whether a box's `width` is a percentage of a width that is not there to
 * take it of: its containing block's, while that is being found from what
 * it holds — a float's, an inline-block's, a flex item's or a table cell's
 * content measured at its widest. The percentage is cyclic, and the box is
 * measured as though its width were `auto` (CSS Sizing 3, 5.2.1); it is a
 * share of the width that comes to once there is one.
 *
 * Taken as a share of nothing, the box was no width at all, and its content
 * wrapped at every word in it: a float around a `width: 100%` block was as
 * wide as the block's longest word, and one around a `width: 100%` flex box
 * of a label that clips — the branch button of a GitHub repository — as
 * wide as nothing, its label gone.
 */
export function cyclicWidth(style: ComputedStyle, base: number): boolean {
  return isPct(style.width) && !Number.isFinite(base);
}

/**
 * A width a box with a ratio and no height of its own works out for itself
 * within the least and greatest widths its least and greatest heights make
 * through its ratio (CSS Sizing 4, 5.2) — those of its own winning where
 * the two disagree, as `clampWidth` after this makes them. A block the
 * room would stretch is no wider than its greatest height lets it be. A
 * width a flex box or a grid gives an item is not, which is theirs.
 */
export function transferredWidth(box: Box, width: number): number {
  const style = box.style;
  const ratio = boxRatio(box);
  if (!ratio || resolveOrNull(style.height, box.percentHeightBase) !== null) {
    return width;
  }
  const heightOf = (len: Len) => {
    const px = resolveOrNull(len, box.percentHeightBase);
    if (px === null || !Number.isFinite(px)) return null;
    return style.boxSizing === 'border-box'
      ? Math.max(px, box.verticalExtra)
      : px + box.verticalExtra;
  };
  const maxH = style.maxHeight === 'none' ? null : heightOf(style.maxHeight);
  const minH = style.minHeight === AUTO ? null : heightOf(style.minHeight);
  let out = width;
  if (maxH !== null) out = Math.min(out, acrossRatio(box, ratio, maxH));
  if (minH !== null) out = Math.max(out, acrossRatio(box, ratio, minH));
  return out;
}

/**
 * A border-box height within what a box's ratio makes of its least and
 * greatest widths: how a flex item's content size suggestion down a
 * column is held (CSS Flexbox 4.5). Unchanged where it has no ratio.
 */
export function transferredHeight(
  box: Box,
  height: number,
  containingWidth: number,
): number {
  const ratio = boxRatio(box);
  if (!ratio) return height;
  const style = box.style;
  const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
  const down = (width: number) => heightFromWidth(box, width + extra)!;
  let out = height;
  if (style.maxWidth !== 'none') {
    const most = resolveOrNull(style.maxWidth, containingWidth);
    if (most !== null) out = Math.min(out, down(most));
  }
  const least =
    style.minWidth === AUTO
      ? null
      : resolveOrNull(style.minWidth, containingWidth);
  if (least !== null && least > 0) out = Math.max(out, down(least));
  return out;
}

/** A width within `min-width` and `max-width` — the minimum winning — the
 *  intrinsic ones among them where `ctx` is there to measure them. */
export function clampWidth(
  box: Box,
  width: number,
  containingWidth: number,
  ctx?: LayoutContext,
  /** The room a `stretch` limit fills, where it is less than the
   *  containing block beside floats. */
  room = containingWidth,
): number {
  const style = box.style;
  const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
  let out = width;
  const max =
    style.maxWidth === 'none'
      ? null
      : resolveOrNull(style.maxWidth, containingWidth);
  if (max !== null) out = Math.min(out, max + extra);
  if (style.maxWidthKeyword && ctx) {
    out = Math.min(
      out,
      keywordWidth(box, ctx, style.maxWidthKeyword, containingWidth, room),
    );
  }
  // `auto` is 0 but for a flex item, which `flex.ts` answers
  const min =
    style.minWidth === AUTO
      ? 0
      : resolveOrNull(style.minWidth, containingWidth);
  if (min !== null) out = Math.max(out, min + extra);
  if (style.minWidthKeyword && ctx) {
    out = Math.max(
      out,
      keywordWidth(box, ctx, style.minWidthKeyword, containingWidth, room),
    );
  }
  // and no narrower than its padding and borders: a `border-box` length
  // less than them leaves its content box none wide, and not less (CSS
  // Sizing 3, 3.3)
  return Math.max(box.horizontalExtra, out);
}

/** An intrinsic `min-width` or `max-width` in the room a box's margins
 *  leave it. Apart from `clampWidth`, which every block is sized through,
 *  so that it makes nothing for the ones that have none. */
function keywordWidth(
  box: Box,
  ctx: LayoutContext,
  keyword: ContentSize,
  containingWidth: number,
  stretchRoom = containingWidth,
): number {
  const of = keyword === 'stretch' ? stretchRoom : containingWidth;
  const room = Math.max(0, of - box.marginLeft - box.marginRight);
  return contentSizedWidth(box, ctx, keyword, room, containingWidth);
}

/**
 * A box's border-box width from an intrinsic size (CSS Sizing 3, 3.1): its
 * max-content width, its min-content width, or `fit-content` — the
 * max-content width where `available` holds it, and `available` where it
 * does not, but never less than the min-content width. Each is measured
 * once a box, as a table cell's are, and by laying the box out on its own,
 * which resolves its edges against nothing: they are resolved again
 * against `percentBase`, as its caller had them.
 */
export function contentSizedWidth(
  box: Box,
  ctx: LayoutContext,
  size: ContentSize,
  available: number,
  percentBase: number,
): number {
  // `stretch` is the room, whatever the content (CSS Sizing 4)
  if (size === 'stretch') return Math.max(0, available);
  // a height of its own through a ratio is its content's width at any size
  const fromRatio = ratioWidth(box);
  if (fromRatio !== null) return fromRatio;
  // the content's sizes, whatever width the box has of its own: a
  // `min-width: max-content` beside a `width` is its content's widest,
  // and a probe of the box at no width answered the probe's width
  if (box.intrinsicMaxContent < 0) {
    box.intrinsicMaxContent = measureIntrinsicWidth(box, ctx, Infinity, true);
  }
  if (size !== 'max-content' && box.intrinsicMinContent < 0) {
    box.intrinsicMinContent = measureIntrinsicWidth(
      box,
      ctx,
      MIN_CONTENT_PROBE,
      true,
    );
  }
  // The probes resolved a percentage of the box's padding or border
  // against nothing, which is how the sizes are kept, whatever the width
  // around the box: what one comes to against `percentBase` goes on top.
  // Left out, `width: max-content; padding-left: 10%` was as wide as its
  // content, the padding inside it.
  resolveEdges(box, 0);
  const bare = box.horizontalExtra;
  resolveEdges(box, Number.isFinite(percentBase) ? percentBase : 0);
  const extra = box.horizontalExtra - bare;
  const max = box.intrinsicMaxContent + extra;
  if (size === 'max-content') return max;
  const min = box.intrinsicMinContent + extra;
  if (size === 'min-content') return min;
  return Math.min(
    max,
    Math.max(min, fitRoom(box, size, available, percentBase)),
  );
}

/** The room `fit-content` fits a box's content in: what its margins leave,
 *  or `fit-content()`'s argument as a width of its own, of `percentBase`
 *  where it is a percentage — an indefinite one leaving the content its
 *  widest. */
function fitRoom(
  box: Box,
  size: ContentSize,
  available: number,
  percentBase: number,
): number {
  if (typeof size !== 'object') return available;
  const fit = Math.max(0, resolve(size.fit, percentBase, 0));
  return box.style.boxSizing === 'border-box'
    ? Math.max(fit, box.horizontalExtra)
    : fit + box.horizontalExtra;
}

/**
 * Shrink-to-fit: the width a float, an inline-block or a positioned box with
 * `width: auto` takes.
 *
 * CSS says `min(max(preferred-minimum, available), preferred)`, where the two
 * preferred widths are the max-content and min-content sizes. This computes
 * the max-content size by laying the box out unconstrained and skips the
 * min-content one, which costs a second full pass and only changes the answer
 * when a single unbreakable word is wider than the space — where the box
 * overflows either way. The measured pass is thrown away; the caller lays the
 * box out again at the width this returns.
 */
function shrinkToFitWidth(
  box: Box,
  ctx: LayoutContext,
  available: number,
  /** How far into the containing block the box's room starts: an
   *  absolute box's offset, or its static position. */
  offset = 0,
): number {
  const style = box.style;
  if (style.width !== AUTO && !cyclicWidth(style, available)) {
    const specified = Math.max(0, resolve(style.width, available, 0));
    const borderBox =
      style.boxSizing === 'border-box'
        ? Math.max(specified, box.horizontalExtra)
        : specified + box.horizontalExtra;
    return clampWidth(box, borderBox, available, ctx);
  }
  // `stretch` fills the room its margins leave, as a block's `auto` does
  if (style.widthKeyword === 'stretch') {
    const room = available - offset - box.marginLeft - box.marginRight;
    return clampWidth(box, Math.max(0, room), available, ctx);
  }
  // a width its height gives it through its ratio, as a block's
  const fromRatio = ratioWidth(box);
  if (fromRatio !== null) {
    const clamped = clampWidth(box, fromRatio, available, ctx);
    return ratioMinimum(box, clamped, available, ctx);
  }
  // `fit-content` is what shrink-to-fit is; the other two are not bounded
  // by the room, or not by the longest line, and `fit-content()` by a room
  // of its own
  const keyword = style.widthKeyword;
  if (keyword !== null && keyword !== 'fit-content') {
    const width = contentSizedWidth(box, ctx, keyword, available, available);
    return clampWidth(box, transferredWidth(box, width), available, ctx);
  }
  const probe = new FloatContext(0, Infinity);
  const saved = box.lines;
  // Its content's width with no limit on it is the same at every width, so
  // it is probed once in the box's life, as a cell's is. Probed every time
  // it was asked, a float in a float was probed as often as there were
  // floats around it, and each probe laid out all of the floats inside.
  let content = PREFERRED.get(box);
  let probed = false;
  if (content === undefined) {
    probeWhole(box, ctx, probe);
    content = intrinsicWidth(box);
    PREFERRED.set(box, content);
    probed = true;
  }
  const preferred = content + box.horizontalExtra;
  // the room is the containing block's, less the box's margins and where
  // it starts (CSS 2.1 10.3.5, 10.3.7, 10.3.9): a float with side margins
  // was as wide as its containing block, and stood out of it by them
  const room = Math.max(
    0,
    available - offset - box.marginLeft - box.marginRight,
  );
  let width = Math.max(preferred, 0);
  if (
    width > room &&
    box.intrinsicMinContent < 0 &&
    ctx.fonts !== null &&
    !probed
  ) {
    // the words the floor is read from are the probe's
    probeWhole(box, ctx, probe);
  }
  // and where its content does not fit the room, its longest word is the
  // least it comes to: `min(max(min-content, room), max-content)`. That
  // matters only for a word wider than the room, which the widest word
  // between spaces bounds, from the probe just laid out; only past the
  // room is the min-content width measured — a second probe, at a width
  // every line breaks at — and it is kept on the box, as a cell's is
  const fonts = ctx.fonts;
  const floored =
    width > room &&
    box.intrinsicMinContent < 0 &&
    fonts !== null &&
    wordBound(box, fonts, false) + box.horizontalExtra > room &&
    wordBound(box, fonts, true) + box.horizontalExtra > room;
  box.lines = saved;
  if (floored) {
    box.intrinsicMinContent = measureIntrinsicWidth(
      box,
      ctx,
      MIN_CONTENT_PROBE,
    );
    box.lines = saved;
    // the probe resolved the box's edges against the width it was given
    resolveEdges(box, available);
  }
  if (width > room)
    width = Math.min(width, Math.max(box.intrinsicMinContent, room));
  return clampWidth(box, transferredWidth(box, width), available, ctx);
}

/** A shrink-to-fit box's content width at no width limit, the once
 *  (`shrinkToFitWidth`); a box's lifetime is the cache's, as for
 *  `Box.intrinsicMaxContent`. */
const PREFERRED = new WeakMap<Box, number>();

/**
 * Forget what a box's layouts keep for its life of how big it is — the
 * widths it is measured to (`intrinsicMinContent`, `intrinsicMaxContent`,
 * `PREFERRED`, a flex item's `MAX_CONTENT`), whether what it holds takes a
 * percentage of a height (`PERCENT_HEIGHTS`), and the place its flow keeps
 * it at (`FLOW_PLACE`) — and the same of every box it is in, which take it
 * in: a box restyled in place to other lengths, laid out again from them
 * (`_restyleInPlace`'s `lengths`). Each is worked out again where it is
 * next asked for.
 */
export function forgetSizes(box: Box): void {
  for (let at: Box | null = box; at; at = at.parent) forgetOne(at);
}

function forgetOne(at: Box): void {
  at.intrinsicMinContent = -1;
  at.intrinsicMaxContent = -1;
  PREFERRED.delete(at);
  PERCENT_HEIGHTS.delete(at);
  FLOW_PLACE.delete(at);
  LAID.delete(at);
  STANDS.delete(at);
  if (stoodAny) STOOD.delete(at);
  forgetMaxContent(at);
  forgetGridItem(at);
}

/**
 * `forgetSizes` of a box that took other lengths in place, and that no layout
 * has reached it since, as none has one just built, nor the block its lines
 * are on where it is inline: `exactMinContent` adds up a box's last layout, its
 * lines and its edges, which are of the lengths it had. A flex item's automatic
 * minimum came to the word and the padding of the width before.
 */
export function forgetLayout(box: Box): void {
  forgetSizes(box);
  for (let at: Box | null = box; at; at = at.parent) {
    at.layoutSerial = 0;
    if (at.kind !== 'inline') break;
  }
}

/**
 * `forgetSizes` of all a box holds as well, and of the boxes around it up
 * to one a call before it reached, whose own way up was gone over then:
 * for a run of blocks set again, whose text may be in an inline-block's or
 * a table's cell (`HtmlViewNode._takeFaces`), where one call for each would
 * go over the document's root as many times. As in `forgetLayout`, no layout
 * has reached what it holds since: its lines are in the face before.
 */
export function forgetSizesIn(box: Box, up: Set<Box>): void {
  box.layoutSerial = 0;
  const stack: Box[] = [...box.children];
  while (stack.length) {
    const at = stack.pop()!;
    forgetOne(at);
    at.layoutSerial = 0;
    for (const child of at.children) stack.push(child);
  }
  for (let at: Box | null = box; at && !up.has(at); at = at.parent) {
    up.add(at);
    forgetOne(at);
  }
}

/**
 * A box's min-content width as its words give it, laid out at no width
 * limit, and null where they may not: blocks and plain text that breaks
 * only at its spaces (`spaceBreaksOnly`) are as narrow as their widest
 * word (`widestWord`) with the edges of the blocks between, which is what
 * the probe finds (`MIN_CONTENT_PROBE`) — for a fifteenth of the cost on
 * ntk, which searches every word of that probe for a place to cut it, as
 * none fits in no width at all. Anything else
 * is left to the probe: another kind of break, an inline box's edges, a
 * box on a line, a float, a table or a flex box, text that does not wrap
 * or is indented, a block with widths of its own.
 */
export function exactMinContent(
  box: Box,
  fonts: FontsLike,
  /** Whether what a layout that stops set aside may be missing from it,
   *  which a walk down `children` would take for nothing. */
  stopped = false,
  /** Whether it is the box's content that is asked about, which a width of
   *  its own has no say in. */
  content = false,
): number | null {
  // a grid's is its columns', and a replaced element has no words: read as
  // its widest word, a row of two in a flex column's item was as narrow as
  // the wider of them
  if (
    box.kind !== 'block' &&
    box.kind !== 'table-cell' &&
    box.kind !== 'flex'
  ) {
    return null;
  }
  if (!answersExactly || (box.kind === 'flex' && stopped)) return null;
  if (
    !lengthEdges(box.style) ||
    (!content && hasWidths(box.style, noWidthInNoRoom)) ||
    contained(box, CONTAIN_WIDTH)
  ) {
    return null;
  }
  // an orthogonal flow is as wide as its block size, which no word says
  if (framed.any && FRAMES.has(box)) return null;
  const inner = exactInner(box, fonts);
  if (inner === null) return null;
  minContentsAnswered += 1;
  return inner + box.horizontalExtra;
}

/** Whether `exactMinContent` answers: a test holds what it answers to what
 *  a probe lays out to find. */
let answersExactly = true;
export function answerMinContentExactly(answer: boolean): void {
  answersExactly = answer;
}

/** How many boxes `exactMinContent` has answered for, for a test to say
 *  that some were. */
let minContentsAnswered = 0;
export function minContentsExact(): number {
  return minContentsAnswered;
}

/** `exactMinContent` inside a box's edges, of a box some layout has laid
 *  out, whose lines say its words: an item a flex box asks about first has
 *  none, and read as nothing it was held to no width at all. */
function exactInner(box: Box, fonts: FontsLike): number | null {
  if (box.layoutSerial === 0) return null;
  if (box.kind === 'flex') return exactItems(box, fonts);
  return box.kind === 'block' || box.kind === 'table-cell'
    ? exactWords(box, fonts)
    : null;
}

/**
 * A flex box's min-content width as its items' give it (CSS Flexbox 9.9.1),
 * which `intrinsicWidth` reads the same way from a probe: side by side and
 * the gaps between them along a line that does not wrap, and the widest of
 * them along one that does, where each may be a line of its own, and down a
 * column. Null for a grid, whose tracks are not its items.
 */
function exactItems(box: Box, fonts: FontsLike): number | null {
  const style = box.style;
  if (style.grid) return null;
  const along = oneLineRow(style);
  let widest = 0;
  let total = 0;
  let items = 0;
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.outOfFlow) continue;
    const contribution = exactContribution(child, fonts, along);
    if (contribution === null) return null;
    if (along) {
      total += contribution;
      items += 1;
    } else widest = Math.max(widest, contribution);
  }
  if (items) {
    widest = Math.max(
      widest,
      total + gapOf(style.columnGap, NaN) * (items - 1),
    );
  }
  return widest;
}

/** Whether a flex box lays its items along one line of a row, which is
 *  where an item's flex basis has a say in how narrow the line comes. */
function oneLineRow(style: ComputedStyle): boolean {
  return style.flexDirection.startsWith('row') && style.flexWrap === 'nowrap';
}

/**
 * What a box gives what holds it at its narrowest, from what its words and
 * edges come to (`itemAtNarrowest`); null for what has to be laid out to be
 * found: an edge a percentage of the room, a table, or a width that is a
 * size of its content, which a layout works out.
 */
function exactContribution(
  child: Box,
  fonts: FontsLike,
  along: boolean,
): number | null {
  const style = child.style;
  if (
    child.kind === 'table' ||
    child.kind === 'table-cell' ||
    (child.layoutSerial === 0 && child.kind !== 'replaced') ||
    !lengthEdges(style) ||
    style.widthKeyword !== null ||
    style.minWidthKeyword !== null ||
    style.maxWidthKeyword !== null ||
    style.aspectRatio !== null ||
    style.lineClamp !== null ||
    style.columns !== 0 ||
    style.visibility === 'collapse' ||
    contained(child, CONTAIN_WIDTH) ||
    (framed.any && FRAMES.has(child))
  ) {
    return null;
  }
  return itemAtNarrowest(child, along, null, () => {
    if (child.kind === 'replaced') return replacedMinimum(child, 0);
    const inner = exactInner(child, fonts);
    return inner === null ? null : inner + child.horizontalExtra;
  });
}

/**
 * What an item gives its flex box's min-content width, its margins in it,
 * which is Chromium's reading of CSS Flexbox 9.9.1. Its width, or its
 * content at its narrowest (`least`) where it has none: a percentage is of
 * nothing here, and `calc(50% + 4px)` as much as `100%` is no width at all
 * (CSS Sizing 3, 5.2.1). All within its least and greatest widths, of which
 * a percentage is of nothing as well, which leaves a greatest one none.
 *
 * Along a line that does not wrap, a flex basis of a length has its say
 * before those limits: an item that may not grow is no wider than it and
 * one that may not shrink no narrower. Not one its content sizes, where
 * `flex: none` gives what `flex: 1` does, nor a percentage, which is of
 * nothing either. And an item's automatic minimum holds it there, as it
 * holds it in a layout (4.5): under `flex: 0 0 10px` it is no narrower than
 * its content, or its width where that is less, unless it scrolls.
 *
 * Along a line that wraps a basis has no say, whatever 9.9.1 has it do: an
 * item is as wide as it is, on a line of its own or not.
 */
function itemAtNarrowest(
  child: Box,
  along: boolean,
  ctx: LayoutContext | null,
  content: () => number | null,
): number | null {
  const style = child.style;
  // the content, the once: asked for twice at every level, a deep document
  // would ask 2^depth times
  let known: number | null | undefined;
  const least = (): number | null =>
    known === undefined ? (known = content()) : known;
  const edges = extraInNoRoom(child);
  const extra = style.boxSizing === 'border-box' ? 0 : edges;
  const ofContent = (size: ContentSize | null): number | null => {
    if (size === null || size === 'stretch' || ctx === null) return null;
    const width = contentSizedWidth(child, ctx, size, 0, 0);
    forgetAround(child);
    return width;
  };
  const stated =
    ofContent(style.widthKeyword) ??
    (typeof style.width === 'number'
      ? Math.max(style.width + extra, edges)
      : null);
  let size = stated ?? least();
  if (size === null) return null;
  // what is replaced may be as narrow as a percentage of nothing lets it be
  // (CSS Sizing 3, 5.2.2), which is before a basis has its say
  if (child.kind === 'replaced' && typeof style.maxWidth === 'object') {
    size = edges;
  }
  const basis = along ? lengthBasis(style.flexBasis) : null;
  if (basis !== null) {
    const base = Math.max(basis + extra, edges);
    if (style.flexGrow === 0) size = Math.min(size, base);
    if (style.flexShrink === 0) size = Math.max(size, base);
  }
  const most = Math.min(
    typeof style.maxWidth === 'number' ? style.maxWidth + extra : Infinity,
    ofContent(style.maxWidthKeyword) ?? Infinity,
  );
  size = Math.min(size, most);
  let floor = Math.max(
    edges,
    style.minWidth === AUTO ? 0 : resolve(style.minWidth, 0) + extra,
    ofContent(style.minWidthKeyword) ?? 0,
  );
  if ((basis !== null && heldAtItsContent(style)) || child.kind === 'table') {
    const narrowest = least();
    if (narrowest === null) return null;
    floor = Math.max(
      floor,
      child.kind === 'table'
        ? narrowest
        : Math.min(narrowest, stated ?? Infinity, most),
    );
  }
  return (
    Math.max(size, floor) +
    edge(style.marginLeft, 0) +
    edge(style.marginRight, 0)
  );
}

/** Whether an item has an automatic minimum along a row (CSS Flexbox 4.5). */
function heldAtItsContent(style: ComputedStyle): boolean {
  return (
    style.minWidth === AUTO && style.minWidthKeyword === null && !scrolls(style)
  );
}

/** A flex basis that is a length: not `auto` or `content`, which its content
 *  or its width answers, nor a percentage, even of a length added to it. */
function lengthBasis(basis: ComputedStyle['flexBasis']): number | null {
  return typeof basis === 'number' ? basis : null;
}

/** A box's padding and borders across where there is no room, of which a
 *  percentage is nothing: what it is measured with, whatever it was last
 *  laid out in (`contentSizedWidth`). */
function extraInNoRoom(box: Box): number {
  const style = box.style;
  if (
    typeof style.paddingLeft === 'number' &&
    typeof style.paddingRight === 'number'
  ) {
    return box.horizontalExtra;
  }
  return (
    Math.max(0, edge(style.paddingLeft, 0)) +
    Math.max(0, edge(style.paddingRight, 0)) +
    box.borderLeft +
    box.borderRight
  );
}

/**
 * What a box's content comes to at its narrowest, its border box's, for a
 * walk of a min-content probe, which what the probe made of the box may not
 * say: a flex item that may not shrink was laid out at its widest, one that
 * grows at its share, and anything at all across a box with a least width
 * of its own at that width.
 *
 * So a flex box is asked of its items, with no layout of it, and a box laid
 * out at no width is read as it was. Only what has lines of its own and was
 * laid out wider is asked of its words, or laid out at no width: at each
 * level of a document, the arithmetic would walk what it holds again.
 * Kept for a flex item's life, as a layout's own asking is (`minContentOf`
 * in `flex.ts`).
 */
function narrowestOf(child: Box, ctx: LayoutContext): number {
  if (child.kind === 'replaced') {
    return replacedMinimum(child, 0) ?? child.width;
  }
  if (child.intrinsicMinContent >= 0) return child.intrinsicMinContent;
  let width: number;
  if (flexItems(child) || laidInNoRoom(child)) {
    width = intrinsicWidth(child, undefined, ctx) + extraInNoRoom(child);
  } else {
    const exact = ctx.fonts
      ? exactMinContent(child, ctx.fonts, ctx.stopping, true)
      : null;
    if (exact !== null) width = exact;
    else {
      width = measureIntrinsicWidth(child, ctx, MIN_CONTENT_PROBE, true);
      forgetAround(child);
    }
  }
  if (child.parent !== null && flexItems(child.parent)) {
    child.intrinsicMinContent = width;
  }
  return width;
}

/** Whether a box was laid out as narrow as it comes, and can be read as it
 *  stands: at no width, or a table with no room, which is as wide as its
 *  columns there. Laid out again, a table in a table's cell was laid out once
 *  more at every level. */
function laidInNoRoom(box: Box): boolean {
  if (box.layoutSerial === 0) return false;
  if (box.width <= extraInNoRoom(box)) return true;
  const parent = box.parent;
  return (
    box.kind === 'table' &&
    box.style.width === AUTO &&
    parent !== null &&
    !flexItems(parent) &&
    parent.width <= extraInNoRoom(parent)
  );
}

/** Whether a box's items say how wide it is: a flex box's, and not those of
 *  one its containment or its frame answers for instead, or of a grid, which
 *  has that `display` and is as wide as its tracks: tracks are of the last
 *  layout, and one a probe's block stood for was the probe's at no limit. */
function flexItems(box: Box): boolean {
  const display = box.style.display;
  return (
    (display === 'flex' || display === 'inline-flex') &&
    !box.style.grid &&
    !contained(box, CONTAIN_WIDTH) &&
    !(framed.any && FRAMES.has(box))
  );
}

/**
 * Note that a box in what a probe walks was laid out by the walk: the layout
 * after the probe keeps what around it has not moved (`Laid`, `Natural`,
 * `ItemLaid`, each by `Box.layoutSerial`), which would leave this one as the
 * walk left it, at no width.
 */
function forgetAround(box: Box): void {
  for (let at = box.parent; at; at = at.parent) {
    at.layoutSerial = ++layoutSerial;
  }
}

/** Whether a box's edges across are lengths, or an `auto` margin, which is
 *  none where there is no room: not a percentage of the room. */
function lengthEdges(style: ComputedStyle): boolean {
  return (
    typeof style.paddingLeft === 'number' &&
    typeof style.paddingRight === 'number' &&
    (typeof style.marginLeft === 'number' || style.marginLeft === AUTO) &&
    (typeof style.marginRight === 'number' || style.marginRight === AUTO)
  );
}

/** Whether a width comes to nothing in no room, as `width: 100%` and
 *  `calc(100% - 57px)` do: no width at all to a min-content probe (CSS Sizing
 *  3, 5.2.1), where one a length is added to is that length. */
function noWidthInNoRoom(width: ComputedStyle['width']): boolean {
  return width === AUTO || (typeof width === 'object' && !(width.px! > 0));
}

/** Whether a style sets its box's width, or its least or greatest width,
 *  but for a width `none` says is none. */
function hasWidths(
  style: ComputedStyle,
  none: (width: ComputedStyle['width']) => boolean,
): boolean {
  return (
    !none(style.width) ||
    style.widthKeyword !== null ||
    (style.minWidth !== 0 && style.minWidth !== AUTO) ||
    style.minWidthKeyword !== null ||
    style.maxWidth !== 'none' ||
    style.maxWidthKeyword !== null
  );
}

function exactWords(box: Box, fonts: FontsLike): number | null {
  const style = box.style;
  // a line that does not wrap is one word, as wide as the line
  const whole = style.whiteSpace === 'nowrap';
  if ((style.whiteSpace !== 'normal' && !whole) || style.textIndent !== 0) {
    return null;
  }
  let widest = 0;
  if (box.lines) {
    let last: object | null = null;
    for (const line of box.lines) {
      if (whole) {
        // what is on it stays on it, as wide as it is laid out where that
        // is as narrow as it comes
        for (const { box: atomic } of line.atomics) {
          const least = exactContribution(atomic, fonts, false);
          const laid = atomic.width + atomic.marginLeft + atomic.marginRight;
          if (least === null || Math.abs(least - laid) > 0.01) return null;
        }
        const uncut = uncutLine(line, fonts, true);
        if (uncut === null) return null;
        widest = Math.max(widest, uncut);
        continue;
      }
      if (line.atomics.length || line.edges?.length) return null;
      for (const text of line.texts) {
        if (text.layout === last) continue;
        last = text.layout;
        if (!spaceBreaksOnly(text.layout)) return null;
        widest = Math.max(widest, widestWord(fonts, text.layout));
      }
    }
  }
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.kind === 'inline') {
      if (!plainInline(child, style.whiteSpace)) return null;
      continue;
    }
    if (child.isFloat) return null;
    if (child.outOfFlow) continue;
    const contribution = exactContribution(child, fonts, false);
    if (contribution === null) return null;
    widest = Math.max(widest, contribution);
  }
  return widest;
}

/** How wide a line is as a min-content width reads it: one cut short by
 *  `text-overflow` as wide as its text, or its widest word where it may
 *  wrap, which the line no longer says (CSS Overflow 3, 5.1: it is ink
 *  alone). Null where nothing here says that. */
function uncutLine(
  line: LineBox,
  fonts: FontsLike,
  whole: boolean,
): number | null {
  if (!CUT_LINES.has(line) && !line.texts.some((t) => t.layout.truncated)) {
    return line.width;
  }
  if (line.texts.length !== 1 || line.atomics.length) return null;
  const layout = line.texts[0].layout;
  const uncut = whole ? uncutWidth(fonts, layout) : widestWord(fonts, layout);
  return uncut === Infinity ? null : uncut;
}

/** Whether an inline box and what is in it wrap as the text around them
 *  does. */
function plainInline(box: Box, whiteSpace: string): boolean {
  if (box.style.whiteSpace !== whiteSpace) return false;
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.kind !== 'inline' || !plainInline(child, whiteSpace)) {
      return false;
    }
  }
  return true;
}

/**
 * An upper bound of a laid-out block's min-content width inside its edges:
 * the widest word of its lines (`widestWord`, measured or estimated from
 * its characters), the widest box on them, and the same of each block in
 * it with that block's edges. A table, a flex
 * box and anything else not laid out as blocks and lines is as wide as the
 * probe made it, which is more than it has to be; a box that is itself one
 * has no bound.
 */
function wordBound(box: Box, fonts: FontsLike, measured: boolean): number {
  if (box.kind !== 'block') return Infinity;
  if (framed.any && FRAMES.has(box)) return Infinity;
  let widest = 0;
  // a line that does not wrap is one word: a `nowrap` tooltip in a narrow
  // containing block was cut to its width, the rest of the line out of it
  const unbroken =
    box.style.whiteSpace === 'nowrap' || box.style.whiteSpace === 'pre';
  if (box.lines) {
    let last: object | null = null;
    for (const line of box.lines) {
      if (unbroken) widest = Math.max(widest, line.width);
      // a word across inline boxes' edges is in two fragments of text, and
      // as wide as its parts in both and the edges between: bound by the
      // widest word of each, a float in a narrow room took a letter of a
      // word of letters in bordered spans for its least width, and was cut
      // to the room (`joinsBefore`)
      let chain = 0;
      for (const text of line.texts) {
        const joins = joinsBefore(text);
        if (joins === undefined && text.layout === last) continue;
        last = text.layout;
        const own = widestWord(fonts, text.layout, measured);
        chain = joins === undefined ? own : chain + joins + own;
        widest = Math.max(widest, chain);
      }
      for (const placed of line.atomics) {
        const b = placed.box;
        widest = Math.max(widest, b.width + b.marginLeft + b.marginRight);
      }
    }
  }
  for (const child of box.children) {
    if (child.outOfFlow) continue;
    if (
      child.kind !== 'block' &&
      child.kind !== 'flex' &&
      child.kind !== 'table' &&
      child.kind !== 'replaced'
    )
      continue;
    const edges = child.marginLeft + child.marginRight;
    const inner =
      child.kind === 'block' && child.style.width === AUTO
        ? wordBound(child, fonts, measured) + child.horizontalExtra
        : child.width;
    widest = Math.max(widest, inner + edges);
  }
  return widest;
}

/**
 * The widest thing a laid-out box drew — its max-content width.
 *
 * A block child laid out at an unbounded width *has* an unbounded width (a
 * `width: auto` block fills its containing block, and its containing block
 * was `Infinity`), so its own width says nothing and only what it drew does.
 * Skipping the non-finite ones is what stops the probe from answering
 * `Infinity` for every box that contains a paragraph.
 *
 * `seen.cut` is set where a line it measured was cut short by
 * `text-overflow`, in a box with a width to cut it at: the line is wider
 * than it was drawn, and the answer is of what was drawn.
 *
 * `narrowest` says the box was laid out by the min-content probe
 * (`MIN_CONTENT_PROBE`), and the answer is its min-content width: the
 * probe lays a box out at no width, but one with a least width of its own
 * at that, and nothing in the layout tells the two apart. It is the probe's
 * context, since not all of that can be read from what it laid out
 * (`narrowestOf`).
 */
export function intrinsicWidth(
  box: Box,
  seen?: { cut: boolean },
  narrowest?: LayoutContext,
): number {
  // under size containment, as though it held nothing: the size
  // `contain-intrinsic-size` gives it, or none (CSS Containment 2, 3.2)
  if (contained(box, CONTAIN_WIDTH)) {
    return box.style.containIntrinsicWidth ?? 0;
  }
  // the root of an orthogonal flow is as wide as its frame came to down
  // its block axis, at its least and its most (CSS Writing Modes 4, 7.3.2),
  // which every layout of it lays out (`layoutFramed`)
  if (framed.any) {
    const frame = FRAMES.get(box);
    if (frame) return Number.isFinite(frame.height) ? frame.height : 0;
  }
  // a table is as wide as its layout made it: its columns, the spacing
  // either side of them and between, and its captions' least (`layoutTable`)
  // — at no width limit its widest, and at none its narrowest. What it
  // holds says less: its rows run from the first column to the last, the
  // spacing either side outside them, and measured by them a table in a
  // flex row, a grid, a float or an `inline-table` came to that much too
  // narrow, and its columns gave it up
  if (box.kind === 'table' && Number.isFinite(box.width)) {
    return Math.max(0, box.width - box.horizontalExtra);
  }
  // a grid laid out at no width limit has its columns at their widest, and
  // is as wide as they are — an item that runs past its column makes it no
  // wider — or, where it has none, as where its items end
  if (box.style.grid) {
    const cols = GRID_TRACKS.get(box)?.cols;
    if (cols?.length) return cols[cols.length - 1][1] - cols[0][0];
    let right = 0;
    for (const child of box.children) {
      if (child.outOfFlow || child.kind === 'text') continue;
      right = Math.max(
        right,
        child.x - box.contentX + child.width + child.marginRight,
      );
    }
    return right;
  }
  let widest = 0;
  // A row of flex items is as wide as all of them side by side, and gaps
  // between them; any other box is as wide as the widest thing in it. So
  // is a row that wraps, at its narrowest: each of its items may be a line
  // of its own, and it is as wide as the widest of them (CSS Flexbox
  // 9.9.1). Summed, a wrapping row of three 30px items made a
  // `width: min-content` box around it 90 wide, the items side by side,
  // where Chrome has 30, one under another
  const display = box.style.display;
  const row =
    (display === 'flex' || display === 'inline-flex') &&
    box.style.flexDirection.startsWith('row');
  const wraps = row && narrowest && box.style.flexWrap !== 'nowrap';
  let total = 0;
  let items = 0;
  const lines = box.lines;
  if (lines) {
    // a float met in a line stands beside what the line holds, at its
    // width, as does a row of them beside no line
    const fonts = narrowest?.fonts;
    const whole = box.style.whiteSpace === 'nowrap';
    for (const line of lines) {
      const width =
        (fonts ? uncutLine(line, fonts, whole) : null) ?? line.width;
      widest = Math.max(widest, width + (line.floats ?? 0));
    }
    widest = Math.max(widest, box.floatRow);
    // a line `text-overflow` cut short is wider than this finds it
    if (seen && !seen.cut && box.style.textOverflow === 'ellipsis') {
      seen.cut = lines.some(
        (line) =>
          CUT_LINES.has(line) ||
          line.texts.some((text) => text.layout.truncated),
      );
    }
  }
  // Floats among blocks stand side by side too, as many as come together,
  // where each block in flow is a line of its own; one with a formatting
  // context of its own stands beside them (as Blink measures them). Taken
  // for the widest of them, a floated menu's items were one under another.
  // That is at the box's widest, laid out at no width limit; at its
  // narrowest each is as narrow as it can be, and one under another.
  const sideBySide = !Number.isFinite(box.width);
  let left = 0;
  let right = 0;
  /** In a multicol container, the widest box that spans its columns. */
  const spanning = box.style.columns !== 0 && box.kind === 'block';
  let across = 0;
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.outOfFlow) continue;
    // what sits in the lines is measured with them, indent and all: an
    // inline-block after a negative `text-indent` ends where its line does
    if (lines && (isInlineLevel(child) || child.isFloat)) continue;
    const style = child.style;
    const margins = child.marginLeft + child.marginRight;
    // a block a probe took for what it came to before is where the last
    // layout put it, and is what it came to then (`STOOD`); one a probe
    // laid out was read as it was laid out (`standAfter`)
    const stood =
      (stoodAny && probesOpen > 0 ? STOOD.get(child) : undefined) ??
      standOf(child);
    const width = stood !== undefined ? stood.boxWidth : child.width;
    const own = Number.isFinite(width) ? width + margins : 0;
    // a minimum's percentage is of zero here (CSS Sizing 3 5.2.1), which
    // leaves a `calc()` its pixels
    const min =
      style.minWidth === 0 || style.minWidth === AUTO
        ? 0
        : resolve(style.minWidth, 0) + contentExtra(child);
    let contribution: number;
    // At its narrowest it is what its own narrowest makes it, which no
    // width it was laid out at says.
    if (
      narrowest &&
      style.aspectRatio === null &&
      style.visibility !== 'collapse'
    ) {
      contribution = itemAtNarrowest(child, row && !wraps, narrowest, () =>
        narrowestOf(child, narrowest),
      )!;
      // A width of its own is what a child contributes, whatever its content
      // does past it (CSS Sizing 3 5.1); a percentage one is cyclic here and
      // counts as `auto`, so its content decides.
    } else if (typeof style.width === 'number') {
      contribution = Math.max(own, min + margins);
      // And it is that width where the box was laid out at less. In a row
      // of flex items it was shrunk to fit the width this is measured at,
      // and what an item gives its flex box's own size is its width (CSS
      // Flexbox 9.9.3); under a percentage `max-width` it was cut short,
      // by a percentage of the size being worked out, which is none to
      // what a box contributes (5.2.1). But a replaced box's is of nothing
      // at its least and none at its most: as it was laid out.
      const cyclic = typeof style.maxWidth === 'object';
      if (cyclic ? child.kind !== 'replaced' : row) {
        let stated = style.width + contentExtra(child);
        if (typeof style.maxWidth === 'number') {
          stated = Math.min(stated, style.maxWidth + contentExtra(child));
        }
        stated = Math.max(stated, child.horizontalExtra, min);
        contribution = Math.max(contribution, stated + margins);
      }
    } else {
      let drew: number;
      if (stood !== undefined && narrowest) {
        // read from a walk that was not at its narrowest (`standAfter`)
        drew = narrowestOf(child, narrowest) - extraInNoRoom(child);
      } else if (stood !== undefined) {
        drew = stood.inner;
        if (seen && stood.cut) seen.cut = true;
      } else drew = intrinsicWidth(child, seen, narrowest);
      let inner = drew + child.horizontalExtra;
      if (typeof style.maxWidth === 'number') {
        inner = Math.min(inner, style.maxWidth + contentExtra(child));
      }
      if (min > inner) inner = min;
      contribution = Math.max(inner + margins, own);
    }
    // laid out with no limit on its width an item is as wide as its content,
    // whatever its flex basis, and one that may not shrink is no narrower
    // than a length of it: a flex box was narrower at its widest than at its
    // narrowest, and an item with room for the first was never asked for
    // the second
    if (row && sideBySide && style.flexShrink === 0) {
      const basis = lengthBasis(style.flexBasis);
      if (basis !== null) {
        const extra = contentExtra(child);
        const most =
          typeof style.maxWidth === 'number'
            ? style.maxWidth + extra
            : Infinity;
        const base = Math.max(basis + extra, child.horizontalExtra);
        contribution = Math.max(contribution, Math.min(base, most) + margins);
      }
    }
    if (spanning && spansColumns(child)) {
      // across the columns, and no part of what a column is as wide as
      across = Math.max(across, contribution);
      continue;
    }
    if (row && !wraps) {
      total += contribution;
      items += 1;
    } else if (wraps || !sideBySide) widest = Math.max(widest, contribution);
    else if (child.isFloat) {
      const clear = style.clear;
      if (clear !== 'none') {
        widest = Math.max(widest, left + right);
        if (clear !== 'right') left = 0;
        if (clear !== 'left') right = 0;
      }
      if (style.float === 'right') right += contribution;
      else left += contribution;
    } else {
      const beside = establishesBFC(child) ? left + right : 0;
      widest = Math.max(widest, beside + contribution, left + right);
      left = 0;
      right = 0;
    }
  }
  widest = Math.max(widest, left + right);
  if (row && items) {
    const gap = gapOf(box.style.columnGap, NaN);
    widest = Math.max(widest, total + gap * (items - 1));
  }
  // A multicol container is as wide as its columns side by side, each as
  // wide as its content or as `column-width` where that is wider, and the
  // gaps between them (as Blink measures one,
  // `NGColumnLayoutAlgorithm::ComputeMinMaxSizes`)
  if (box.style.columns && box.kind === 'block') {
    const count = box.style.columnCount ?? 1;
    const gap = box.style.columnGapNormal
      ? box.style.fontSize
      : gapOf(box.style.columnGap, NaN);
    widest = Math.max(widest, box.style.columnWidth ?? 0);
    // and no narrower than a box that spans them
    widest = Math.max(widest * count + gap * (count - 1), across);
  }
  return widest;
}

/** What a box's own width leaves out of its border box: its padding and
 *  border, unless `box-sizing` puts them in. */
function contentExtra(box: Box): number {
  return box.style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
}

/**
 * A replaced box's size, from its style and what it has of an intrinsic
 * width, height and ratio (CSS 2.1 10.3.2 and 10.6.2), within its minimum
 * and maximum (10.4, 10.7).
 *
 * An image has all three, a frame and a control their default size and no
 * ratio — so the axis the style does not set keeps its own, and a text field
 * `width: 100%` is not stretched to twice its height. An SVG may have any of
 * them: a height and nothing else is 300 pixels wide, a ratio and nothing
 * else fills its containing block, and nothing at all is 300 by 150 — the
 * default object size, which the builder leaves in `Intrinsic` for an axis
 * its `missing` names.
 *
 * A limit applied to one axis carries to the other through the ratio: an
 * image `max-width: 100%` narrower than itself keeps its proportions, where
 * clamping each axis alone squashed it — the `<img width="600">` of every
 * mail template, in a narrow column.
 */
function sizeReplaced(
  box: Box,
  containingWidth: number,
  /** The room `stretch` fills: the containing block's width, or less of
   *  it beside floats (CSS Sizing 3, 4.2). */
  stretchRoom = containingWidth,
): void {
  const style = box.style;
  const base = box.percentHeightBase;
  // everything below is the content box's; a `border-box` length is not
  const hx = style.boxSizing === 'border-box' ? box.horizontalExtra : 0;
  const vx = style.boxSizing === 'border-box' ? box.verticalExtra : 0;
  const across = (len: Len): number | null => {
    const v = resolveOrNull(len, containingWidth);
    return v === null ? null : Math.max(0, v - hx);
  };
  const down = (len: Len): number | null => {
    const v = resolveOrNull(len, base);
    return v === null ? null : Math.max(0, v - vx);
  };
  // `stretch` is what the margins leave of the containing block, as a
  // content box, and of its height where that is definite
  const stretchedHeight =
    style.heightKeyword === 'stretch' ? stretchHeight(box) : null;
  const stretchedWidth = Number.isFinite(stretchRoom)
    ? Math.max(
        0,
        stretchRoom - box.marginLeft - box.marginRight - box.horizontalExtra,
      )
    : null;
  const width =
    style.widthKeyword === 'stretch' && stretchedWidth !== null
      ? stretchedWidth
      : across(style.width);
  const height =
    stretchedHeight !== null
      ? Math.max(0, stretchedHeight - box.verticalExtra)
      : down(style.height);
  const minW =
    (style.minWidthKeyword === 'stretch' ? stretchedWidth : null) ??
    across(style.minWidth) ??
    0;
  const minH = down(style.minHeight) ?? 0;
  // a maximum below the minimum is the minimum (10.4)
  const maxW = Math.max(
    minW,
    style.maxWidthKeyword === 'stretch' && stretchedWidth !== null
      ? stretchedWidth
      : style.maxWidth === 'none'
        ? Infinity
        : (across(style.maxWidth) ?? Infinity),
  );
  const maxH = Math.max(
    minH,
    style.maxHeight === 'none' ? Infinity : (down(style.maxHeight) ?? Infinity),
  );
  // under size containment, as though it had no size or ratio of its own
  // but the one `contain-intrinsic-size` gives it (`ownIntrinsic`)
  const own = ownIntrinsic(box) ?? NO_INTRINSIC;
  const iw = own.missing & 1 ? null : own.width;
  const ih = own.missing & 2 ? null : own.height;
  // `aspect-ratio` over its own, unless written `auto` and it has one
  const aspect = style.aspectRatio;
  const pages = aspect !== null && !(aspect.auto && own.ratio > 0);
  const ratio = pages ? aspect.ratio : own.ratio;
  // A ratio of the page's is of the box `box-sizing` names (CSS Sizing 4,
  // 5.1): one axis's content size to the other's goes through the border
  // box there. Written with `auto`, it is of the content box, as the
  // replaced element's own is, whichever it is.
  const outer = pages && !aspect.auto && style.boxSizing === 'border-box';
  const ox = outer ? box.horizontalExtra : 0;
  const oy = outer ? box.verticalExtra : 0;
  const widthOf = (h: number): number => Math.max(0, (h + oy) * ratio - ox);
  const heightOf = (w: number): number => Math.max(0, (w + ox) / ratio - oy);
  // the width a block would have here: what a ratio with no size fills, and
  // an `hr`, whose whole appearance is its border across the line
  const room = (): number => {
    const w =
      containingWidth - box.marginLeft - box.marginRight - box.horizontalExtra;
    return Number.isFinite(w) ? Math.max(0, w) : 0;
  };

  let w: number;
  let h: number;
  if (width === null && height === null && ratio > 0) {
    // both auto, with a ratio: the size it asks for, then the table in 10.4,
    // which moves both axes together
    if (iw !== null) {
      w = iw;
      h = ih ?? heightOf(iw);
    } else if (ih !== null) {
      h = ih;
      w = widthOf(ih);
    } else {
      // a ratio and no size: CSS 2.1 leaves it undefined and suggests the
      // width a block would have, which is what browsers do — or, where the
      // containing block waits on this box, the default object size
      w = Number.isFinite(containingWidth) ? room() : own.width;
      h = heightOf(w);
    }
    [w, h] = constrained(w, h, minW, maxW, minH, maxH);
  } else {
    // one axis set, or no ratio: the width, clamped, and then the height
    // from the width that was used (10.3.2's "the rules above are applied
    // again" for a limit)
    const usedHeight = height === null ? null : clamp(height, minH, maxH);
    if (width !== null) w = width;
    else if (usedHeight !== null && ratio > 0) w = widthOf(usedHeight);
    else if (box.replaced === 'hr') w = room();
    else w = own.width;
    w = clamp(w, minW, maxW);
    if (usedHeight !== null) h = usedHeight;
    else if (ratio > 0) h = clamp(heightOf(w), minH, maxH);
    else h = clamp(own.height, minH, maxH);
  }
  box.width = w + box.horizontalExtra;
  box.height = h + box.verticalExtra;
}

/** What a replaced box with nothing to say about its size has: `hr`. */
const NO_INTRINSIC: Intrinsic = { width: 0, height: 0, missing: 0, ratio: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * CSS 2.1 10.4's table, for a replaced box sized by its ratio alone: a
 * limit on either axis is met by scaling both, and where the two axes' limits
 * disagree, the one that asks for more change wins.
 */
function constrained(
  w: number,
  h: number,
  minW: number,
  maxW: number,
  minH: number,
  maxH: number,
): [number, number] {
  if (!(w > 0 && h > 0)) return [clamp(w, minW, maxW), clamp(h, minH, maxH)];
  if (w > maxW && h > maxH) {
    return maxW / w <= maxH / h
      ? [maxW, Math.max(minH, (maxW * h) / w)]
      : [Math.max(minW, (maxH * w) / h), maxH];
  }
  if (w < minW && h < minH) {
    return minW / w <= minH / h
      ? [Math.min(maxW, (minH * w) / h), minH]
      : [minW, Math.min(maxH, (minW * h) / w)];
  }
  if (w < minW && h > maxH) return [minW, maxH];
  if (w > maxW && h < minH) return [maxW, minH];
  if (w > maxW) return [maxW, Math.max((maxW * h) / w, minH)];
  if (w < minW) return [minW, Math.min((minW * h) / w, maxH)];
  if (h > maxH) return [Math.max((maxH * w) / h, minW), maxH];
  if (h < minH) return [Math.min((minH * w) / h, maxW), minH];
  return [w, h];
}

/**
 * Place and size a float, and register it with the formatting context.
 *
 * The formatting context holds every float in it, and its band is as wide
 * as its root; a float is placed within its own containing block's content
 * box, which may be narrower (CSS 2.1 9.5.1, rules 1 and 7). Floats placed
 * earlier still push it over wherever they reach into that box. Placed in
 * the formatting context's band, a float in a nested block sat at the
 * root's edge — outside its parent's padding and the body's margin.
 */
function layoutFloat(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  y: number,
  containingLeft: number,
  containingWidth: number,
): void {
  sizeFloat(box, ctx, containingWidth);
  placeFloat(box, floats, y, containingLeft, containingWidth);
}

/** Lay a float out at its own width, and answer its outer width. */
function sizeFloat(
  box: Box,
  ctx: LayoutContext,
  containingWidth: number,
): number {
  resolveEdges(box, containingWidth);
  if (box.kind === 'replaced') sizeReplaced(box, containingWidth);
  else layoutOwn(box, ctx, shrinkToFitWidth(box, ctx, containingWidth));
  return box.width + box.marginLeft + box.marginRight;
}

/** Put a float that is laid out as high as it goes from `y`, and to its
 *  side, and note it in the float context. */
function placeFloat(
  box: Box,
  floats: FloatContext,
  y: number,
  containingLeft: number,
  containingWidth: number,
): void {
  const outerWidth = box.width + box.marginLeft + box.marginRight;
  const clearance = floats.clearance(box.style.clear);
  const from = Math.max(y, clearance === -Infinity ? y : clearance);
  const left = containingLeft;
  const right = containingLeft + containingWidth;
  const top = floats.placeAt(
    from,
    outerWidth,
    box.style.float === 'right' ? 'right' : 'left',
    left,
    right,
  );
  const band = floats.bandAt(top, 1, left, right);
  const x =
    box.style.float === 'right'
      ? band.right - outerWidth + box.marginLeft
      : band.left + box.marginLeft;
  // A right float in content measured at no width limit stands at an
  // infinite x, where its box is not put: a box at infinity cannot be moved
  // back, so everything in it was laid out again at its next layout — at
  // every level of a nest of such floats, the innermost as many times as
  // there were levels. What a measure reads of it is its width, and the
  // float context keeps where it stands.
  moveTo(
    box,
    Number.isFinite(x) ? x : band.left + box.marginLeft,
    top + box.marginTop,
  );
  floats.add({
    left: x - box.marginLeft,
    right: x - box.marginLeft + outerWidth,
    top,
    bottom: top + box.height + box.marginTop + box.marginBottom,
    side: box.style.float === 'right' ? 'right' : 'left',
  });
}

/** Whether a box is a form control's: a replaced box for what draws it,
 *  a widget, and an inline block for how it is sized. */
function isControl(box: Box): boolean {
  switch (box.replaced) {
    case 'input':
    case 'textarea':
    case 'select':
    case 'button':
    case 'checkbox':
    case 'radio':
      return true;
    default:
      return false;
  }
}

/** The style of the position option an anchor-positioned box was placed
 *  by, its anchor functions come to lengths: its computed style, as
 *  `getComputedStyle` reads it (CSS Anchor Positioning 1, 6.2: the
 *  position option's styles are the box's; 5.1: an `anchor-size()` is a
 *  length once the box is placed). None where it is the box's own. */
const PLACED_STYLE = new WeakMap<Box, ComputedStyle>();

/** The style a box was placed by (`PLACED_STYLE`), or null where it is its
 *  own. */
export function placedStyleOf(box: Box): ComputedStyle | null {
  return PLACED_STYLE.get(box) ?? null;
}

/** The position option an anchor-positioned box was placed by, by box:
 *  the option's text, as an anchored container query matches it, where it
 *  was one of its `position-try-fallbacks`; none where it was its own. */
export const ANCHOR_FALLBACK = new WeakMap<Box, string>();

/**
 * What placing a box against its default anchor gives it beside its style
 * (`anchoredStyle`): the cells of its `position-area`, which it takes for
 * its containing block, and the alignment `normal` is in them; the
 * anchor's centre, which `anchor-center` centres it on; and which edges of
 * what it is placed in are its anchor's, and move with it.
 */
interface Anchoring {
  /** The `position-area`'s cells, or null where it has none. */
  area: CbRect | null;
  /** How far along the cells' free room `normal` aligns the box, across
   *  and down (CSS Anchor Positioning 1, 4.1): towards the anchor — or null
   *  where the cells are all three tracks of the axis, which is
   *  `anchor-center`. */
  across: number | null;
  down: number | null;
  /** The default anchor's centre, or null where it has none. */
  centre: { x: number; y: number } | null;
  /** The edges of its inset-modified containing block a scroll of its
   *  default anchor moves with the anchor (`Edges`). */
  moving: number;
}

/** The edges of a rectangle, as bits. */
const enum Edges {
  Left = 1,
  Right = 2,
  Top = 4,
  Bottom = 8,
}

/** Where a positioned box was placed in: its inset-modified containing
 *  block (CSS Position 3, 3.5), whether its insets had to give way to leave
 *  it any room at all (3.5.2), which no box fits, and which of its edges
 *  are its default anchor's (`Anchoring.moving`). */
interface Placement extends CbRect {
  corrected: boolean;
  moving: number;
}

/**
 * The position option each anchored element was last placed by: its last
 * successful position option (CSS Anchor Positioning 1, 6.5.1.1), kept by
 * element, and by pseudo-element under it, across layouts and builds.
 * `key` is what it holds for: its `position`, its default anchor and its
 * options, a change of any of which is a fallback-sensitive change
 * (6.5.1).
 */
interface LastPosition {
  key: string;
  option: number;
}
const LAST_POSITIONS = new WeakMap<object, Map<string, LastPosition>>();

/** The options layouts placed boxes by since the last rendering, which
 *  become their last successful ones there (`commitLastPositions`). */
const PENDING_POSITIONS = new Map<
  Map<string, LastPosition>,
  Map<string, LastPosition>
>();

/** A layout placed a box by an option: kept for the next rendering. */
function notePosition(
  map: Map<string, LastPosition>,
  at: string,
  position: LastPosition,
): void {
  let pending = PENDING_POSITIONS.get(map);
  if (!pending) PENDING_POSITIONS.set(map, (pending = new Map()));
  pending.set(at, position);
}

/**
 * Make the options the layouts since the last rendering placed boxes by
 * their last successful position options (CSS Anchor Positioning 1,
 * 6.5.1.1): HTML updates it as it gathers the resize observations, once a
 * rendering, so a layout a script forces between two — `offsetTop` read
 * after a style change — tries what the last rendering had, and what it
 * places a box by is no box's last successful option until a rendering.
 */
export function commitLastPositions(): void {
  if (!PENDING_POSITIONS.size) return;
  for (const [map, pending] of PENDING_POSITIONS) {
    for (const [at, position] of pending) map.set(at, position);
  }
  PENDING_POSITIONS.clear();
}

/** The options in the order `position-try-order` sorts them (CSS Anchor
 *  Positioning 1, 6.3): by the room each leaves the box on its axis, the
 *  most first, a tie in the order written. */
function sortedOptions(
  count: number,
  _order: string,
  room: (index: number) => number,
): number[] {
  const rooms = Array.from({ length: count }, (_, i) => room(i));
  return rooms.map((_, i) => i).sort((a, b) => rooms[b] - rooms[a]);
}

/**
 * How much room an option's insets leave a box, along the axis its
 * `position-try-order` names (6.3): the size of its inset-modified
 * containing block there — its containing block, or its area's cells —
 * with `auto` insets nought.
 */
function roomOf(style: ComputedStyle, cb: CbRect, axes: AnchorAxes): number {
  const order = style.positionTryOrder;
  let down: boolean;
  if (order === 'most-width' || order === 'most-height') {
    // the page's axis, which a frame of a vertical flow has turned
    down = (order === 'most-height') !== !!axes.frame;
  } else {
    const block = blockDown(axes, axes.cb);
    down = order === 'most-block-size' ? block : !block;
  }
  const size = down ? cb.height : cb.width;
  const [a, b] = down ? [style.top, style.bottom] : [style.left, style.right];
  return size - (resolveOrNull(a, size) ?? 0) - (resolveOrNull(b, size) ?? 0);
}

/** Where an anchored box's last position is kept: by its element, or by
 *  the element a pseudo-element's box hangs off. */
function lastPositionOf(box: Box): [Map<string, LastPosition>, string] | null {
  const owner = box.el ?? (box.pseudo ? box.parent?.el : null);
  if (!owner) return null;
  let map = LAST_POSITIONS.get(owner);
  if (!map) LAST_POSITIONS.set(owner, (map = new Map()));
  return [map, box.el ? '' : (box.pseudo ?? '')];
}

/**
 * An absolutely positioned box, against its containing block — and where
 * it is anchor-positioned (CSS Anchor Positioning 1), against its anchor
 * as well: its `anchor()` insets and `anchor-size()` sizes come to what the
 * anchor's box makes of them, a `position-area` puts it in the cells of the
 * grid the anchor makes of its containing block, and `anchor-center`
 * centres it on the anchor.
 *
 * Where it has `position-try-fallbacks`, it keeps the option it was last
 * placed by — its own, at first — while that fits its inset-modified
 * containing block (6.5.1.1), and is tried with each other option in turn
 * where it does not — its own, a `@position-try` rule's style, tactics, a
 * `position-area` — keeping the first that fits, or the one it had where
 * none does (6.5). The option it took is noted for an anchored container
 * query (`ANCHOR_FALLBACK`).
 *
 * Where its default anchor is in another scroll context — scrolled by a
 * scroll container that does not scroll the box, or by the pane, where the
 * box is fixed to the viewport, or the other way round — it is placed
 * against the anchors that scroll with that one where the scroll has them
 * (3.3), and moved back to where they are with nothing scrolled, which the
 * scroll after the layout moves it on from as it moves them: by
 * `scrollContent` for a scroll container's, and by `followPane` for the
 * pane's. What a scroll asks of it with no layout is noted
 * (`AnchorScroll`).
 */
function layoutPositioned(box: Box, containing: Box, ctx: LayoutContext): void {
  const style = box.style;
  if (
    !style.anchorInsets &&
    !style.anchorSizes &&
    !style.positionArea &&
    !style.positionTryFallbacks &&
    !style.justifyAnchorCenter &&
    !style.alignAnchorCenter
  ) {
    positionedIn(box, containing, ctx, null);
    return;
  }
  forgetPaneShift(box);
  const cb =
    containing.kind === 'inline'
      ? inlineContainingBlock(containing, box, ctx)
      : (gridArea(box, containing, ctx) ?? containingRect(containing, ctx));
  const options = style.positionTryFallbacks ?? [];
  const root = ctx.anchorRoot ?? null;
  const axes = anchorAxesOf(box, containing);
  // what scrolls its default anchor and not it, and how far it has now
  const anchor = defaultAnchorBox(box, style, ctx);
  const context =
    anchor &&
    scrollContextOf(anchor, box, (b) => drawnAtViewport(b) && !!ctx.viewport);
  const [sx, sy] = context
    ? displacementOf(context, ctx.viewport ?? null, (s) =>
        ctx.scrollOf ? ctx.scrollOf(s) : { x: 0, y: 0 },
      )
    : [0, 0];
  // the option it was placed by last, where it is the same box it was
  const kept = options.length ? lastPositionOf(box) : null;
  const key = `${style.position} ${style.positionAnchor} ${options
    .map((o) => o.text)
    .join(',')} ${style.positionTryRules}`;
  const last = kept?.[0].get(kept[1]);
  let start =
    last?.key === key && last.option < options.length ? last.option : -1;
  // the style each option made of the box's, its tactics applied, and
  // with its anchor functions come to lengths
  const triedStyles = new Map<number, ComputedStyle>();
  const resolvedStyles = new Map<number, ComputedStyle>();
  const triedStyle = (index: number): ComputedStyle | null => {
    const known = triedStyles.get(index);
    if (known) return known;
    const option = index < 0 ? null : options[index];
    let tried = style;
    if (option?.name != null) {
      const named = style.positionTryStyles?.[index];
      // an option naming no rule there is is none
      if (!named) return null;
      tried = named;
    }
    tried = triedWith(
      tried,
      option?.tactics ?? NO_TACTICS,
      option?.area ?? null,
      axes,
    );
    triedStyles.set(index, tried);
    return tried;
  };
  const place = (index: number): Placement | null => {
    const tried = triedStyle(index);
    if (!tried) return null;
    ctx.anchorShift = anchor && (sx || sy) ? { anchor, x: sx, y: sy } : null;
    try {
      const { resolved, anchoring } = anchoredStyle(box, tried, cb, ctx, axes);
      resolvedStyles.set(index, resolved);
      box.style = resolved;
      return positionedIn(box, containing, ctx, anchoring);
    } finally {
      box.style = style;
      ctx.anchorShift = null;
    }
  };
  let chosen = start;
  let placed = place(start);
  if (!placed && start >= 0) {
    start = chosen = -1;
    placed = place(-1);
  }
  if (options.length && !(placed && fitsIn(box, placed))) {
    // each option it is not placed by, its own first (6.5), and the others
    // in the order `position-try-order` sorts them
    let found = false;
    const order =
      style.positionTryOrder === 'normal' || options.length < 2
        ? options.map((_, i) => i)
        : sortedOptions(options.length, style.positionTryOrder, (i) => {
            const tried = triedStyle(i);
            if (!tried) return -Infinity;
            ctx.anchorShift =
              anchor && (sx || sy) ? { anchor, x: sx, y: sy } : null;
            try {
              const { resolved, anchoring } = anchoredStyle(
                box,
                tried,
                cb,
                ctx,
                axes,
              );
              return roomOf(resolved, anchoring?.area ?? cb, axes);
            } finally {
              ctx.anchorShift = null;
            }
          });
    for (const i of [-1, ...order]) {
      if (i === start) continue;
      const tried = place(i);
      if (tried && fitsIn(box, tried)) {
        chosen = i;
        placed = tried;
        found = true;
        break;
      }
    }
    // and where none does, the one it had
    if (!found) placed = place(start);
  }
  if (chosen >= 0) ANCHOR_FALLBACK.set(box, options[chosen].text);
  else ANCHOR_FALLBACK.delete(box);
  const own = resolvedStyles.get(chosen);
  if (own && own !== style) PLACED_STYLE.set(box, own);
  else PLACED_STYLE.delete(box);
  if (kept && !ctx.question)
    notePosition(kept[0], kept[1], { key, option: chosen });
  // whether `position-visibility` may hide it, and whether it overflows
  // where it ends up (5.4)
  if (root && style.positionVisibility & 3) {
    noteVisibility(root, box, !(placed && fitsIn(box, placed)));
  }
  if (!context || !root || !placed) return;
  // moved to where its anchor is with nothing scrolled, on the axes it
  // follows its anchor on — which the last placement noted
  const on = defaultAnchorOf(root, box) ?? { x: false, y: false };
  const mx = box.x - box.marginLeft;
  const my = box.y - box.marginTop;
  noteAnchorScroll(root, box, {
    scrollers: context.scrollers,
    pane: context.pane,
    x: on.x,
    y: on.y,
    rx: sx,
    ry: sy,
    room: {
      x: placed.x - mx,
      y: placed.y - my,
      width: placed.width,
      height: placed.height,
    },
    fixedEdges: ~placed.moving & 15,
    width: box.width + box.marginLeft + box.marginRight,
    height: box.height + box.marginTop + box.marginBottom,
    corrected: placed.corrected,
    refits: options.length > 0,
    dx: null,
    dy: null,
  });
  const dx = on.x ? sx : 0;
  const dy = on.y ? sy : 0;
  if (dx || dy) translate(box, dx, dy, () => false);
}

/** Whether a box's margin box is inside the rectangle it was placed in, to
 *  within half a pixel. */
function fitsIn(box: Box, at: Placement): boolean {
  return (
    !at.corrected &&
    box.x - box.marginLeft >= at.x - 0.5 &&
    box.y - box.marginTop >= at.y - 0.5 &&
    box.x + box.width + box.marginRight <= at.x + at.width + 0.5 &&
    box.y + box.height + box.marginBottom <= at.y + at.height + 0.5
  );
}

/**
 * A style with its anchor functions worked out for a containing block:
 * each `anchor()` inset as the distance from the containing block's edge
 * to the anchor's — or the cells' edge, where it has a `position-area` —
 * and each `anchor-size()` as the anchor's size, alone or in a math
 * function, or the fallback each holds already where there is no anchor;
 * and what else its default anchor makes of it (`Anchoring`).
 */
function anchoredStyle(
  box: Box,
  style: ComputedStyle,
  cb: CbRect,
  ctx: LayoutContext,
  axes: AnchorAxes,
): { resolved: ComputedStyle; anchoring: Anchoring | null } {
  let resolved = style;
  const own = (): ComputedStyle =>
    resolved === style ? (resolved = { ...style }) : resolved;
  // which end of each of its axes the logical sides start at
  const startLow = [
    startsLow(axes, false, axes.cb),
    startsLow(axes, true, axes.cb),
  ];
  const selfLow = [
    startsLow(axes, false, axes.own),
    startsLow(axes, true, axes.own),
  ];
  const defaultAnchor = defaultAnchorBox(box, style, ctx);
  const anchor = defaultAnchor && anchorRect(defaultAnchor, box, ctx);
  // the edges a scroll of the default anchor moves with it
  let moving = 0;
  // the cells of its `position-area` (3.1.1): between lines at the
  // containing block's edges, or the anchor's where it reaches past them,
  // and at the anchor's
  let area: CbRect | null = null;
  let alongX: number | null = null;
  let alongY: number | null = null;
  // its tracks those of its layout (`triedWith`)
  const positionArea = style.positionArea;
  if (positionArea && anchor) {
    const { cols, rows } = positionArea;
    const xs = areaLines(cb.x, cb.width, anchor.x, anchor.width);
    const ys = areaLines(cb.y, cb.height, anchor.y, anchor.height);
    area = {
      x: xs[cols[0]],
      y: ys[rows[0]],
      width: Math.max(0, xs[cols[1] + 1] - xs[cols[0]]),
      height: Math.max(0, ys[rows[1] + 1] - ys[rows[0]]),
    };
    const all = ([s, e]: readonly [number, number]) => s === 0 && e === 2;
    alongX = all(cols) ? null : areaAlignment(cols);
    alongY = all(rows) ? null : areaAlignment(rows);
    // the lines at the anchor's edges
    if (cols[0] > 0) moving |= Edges.Left;
    if (cols[1] < 2) moving |= Edges.Right;
    if (rows[0] > 0) moving |= Edges.Top;
    if (rows[1] < 2) moving |= Edges.Bottom;
  }
  // which are the containing block its insets are against
  const against = area ?? cb;
  const insets = style.anchorInsets;
  if (insets) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const inset = insets[side];
      if (!inset) continue;
      const across = side === 'left' || side === 'right';
      let scrolled = false;
      const values = anchorCalls(inset).map((ref) => {
        // a side of the other axis is no `anchor()` of this inset's, which
        // is its fallback (CSS Anchor Positioning 1, 3.2.1)
        if (typeof ref.side === 'string' && OTHER_AXIS[side].has(ref.side)) {
          return null;
        }
        const at = referencedAnchor(box, style, ref.name, ctx);
        if (!at) return null;
        const of = anchorRect(at, box, ctx);
        if (defaultAnchor && sameScrollContext(at, defaultAnchor)) {
          scrolled = true;
        }
        return anchorInset(
          side,
          ref.side,
          across ? of.x : of.y,
          across ? of.width : of.height,
          across ? against.x : against.y,
          across ? against.width : against.height,
          startLow[across ? 0 : 1],
          selfLow[across ? 0 : 1],
        );
      });
      if (isAnchorMath(inset)) {
        own()[side] = anchorMathValue(inset, values) ?? AUTO;
      } else if (values[0] !== null) own()[side] = values[0];
      if (scrolled) moving |= EDGE_OF[side];
    }
  }
  const sizes = style.anchorSizes;
  if (sizes) {
    for (const [prop, size] of Object.entries(sizes) as [
      AnchorSizeField,
      AnchorSize,
    ][]) {
      if (!size) continue;
      const values = anchorCalls(size).map((ref) => {
        const at = referencedAnchor(box, style, ref.name, ctx);
        if (!at) return null;
        const of = anchorRect(at, box, ctx);
        return laidDimension(axes, ref.size) === 'width' ? of.width : of.height;
      });
      const set = own() as unknown as Record<string, unknown>;
      if (isAnchorMath(size)) {
        // a length like any other, which `box-sizing` says the box of
        set[prop] = anchorMathValue(size, values) ?? ANCHOR_SIZE_UNSET[prop];
        continue;
      }
      const value = values[0];
      if (value === null) continue;
      // a least or a greatest size, an inset or a margin the length
      if (prop !== 'width' && prop !== 'height') {
        set[prop] = value;
        continue;
      }
      // the anchor's border box, which a box sized to it takes as its own
      // border box
      const extra =
        prop === 'width'
          ? box.borderLeft + box.borderRight + box.padLeft + box.padRight
          : box.borderTop + box.borderBottom + box.padTop + box.padBottom;
      own()[prop] =
        style.boxSizing === 'border-box' ? value : Math.max(0, value - extra);
    }
  }
  // its default anchor, which a scroll moves it with (3.3) on each axis
  // it is placed against an anchor scrolled with it on: an edge of what it
  // is placed in that is the anchor's, a `position-area` or
  // `anchor-center`
  if (defaultAnchor && ctx.anchorRoot) {
    noteDefaultAnchor(
      ctx.anchorRoot,
      box,
      defaultAnchor,
      !!positionArea ||
        style.justifyAnchorCenter ||
        !!(moving & (Edges.Left | Edges.Right)),
      !!positionArea ||
        style.alignAnchorCenter ||
        !!(moving & (Edges.Top | Edges.Bottom)),
    );
  }
  const centre = anchor
    ? { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 }
    : null;
  return {
    resolved,
    anchoring:
      area || centre || moving
        ? { area, across: alongX, down: alongY, centre, moving }
        : null,
  };
}

const EDGE_OF: Record<InsetSide, number> = {
  left: Edges.Left,
  right: Edges.Right,
  top: Edges.Top,
  bottom: Edges.Bottom,
};

/**
 * The rectangle of an anchor `box` found (`referencedAnchor`), in document
 * coordinates — an inline box by the rectangle around its fragments.
 */
function anchorRect(anchor: Box, box: Box, ctx: LayoutContext): CbRect {
  const rect =
    anchor.kind === 'inline'
      ? inlineContainingBlock(anchor, box, ctx)
      : {
          x: anchor.x,
          y: anchor.y,
          width: anchor.width,
          height: anchor.height,
        };
  const [dx, dy] = relativeShift(anchor, box);
  // and where the box's anchor references are taken at a displacement of
  // its default anchor, one scrolled with that seen moved back by it
  const shift = ctx.anchorShift;
  const back =
    shift && sameScrollContext(anchor, shift.anchor) ? shift : NO_SHIFT;
  const at = { ...rect, x: rect.x + dx - back.x, y: rect.y + dy - back.y };
  return framed.any ? inFrameOf(at, anchor, box) : at;
}

/**
 * A rectangle laid out where `from` is, in the axes `box` is laid out in:
 * the page's, through the turn of the frame of a vertical writing mode
 * `from` is in, and into the frame `box` is in (`layout/writing.ts`). Two
 * boxes in one frame are in its axes both.
 */
function inFrameOf(rect: CbRect, from: Box, box: Box): CbRect {
  const theirs = frameOf(from);
  const ours = frameOf(box);
  if (theirs === ours) return rect;
  const page = theirs
    ? pageRectOf(theirs, rect, FRAME_ROOTS.get(theirs)!.style.writingMode)
    : rect;
  return ours
    ? frameRectOf(ours, page, FRAME_ROOTS.get(ours)!.style.writingMode)
    : page;
}

/**
 * The axes an anchored box is laid out in, as the page has them: the frame
 * of a vertical writing mode it is in, turned (`layout/writing.ts`), or the
 * page's own; and the writing modes the logical keywords it is placed by
 * read — its containing block's (CSS Anchor Positioning 1, 3.2), and its
 * own for the `self-` ones.
 */
interface AnchorAxes {
  frame: Box | null;
  /** The frame's writing mode, which says which way it is turned. */
  mode: WritingMode;
  cb: WritingAxes;
  own: WritingAxes;
}

function anchorAxesOf(box: Box, containing: Box): AnchorAxes {
  const frame = framed.any ? frameOf(box) : null;
  return {
    frame,
    mode: frame ? FRAME_ROOTS.get(frame)!.style.writingMode : 'horizontal-tb',
    cb: {
      mode: containing.style.writingMode,
      rtl: containing.style.direction === 'rtl',
    },
    own: {
      mode: box.style.writingMode,
      rtl: box.style.direction === 'rtl',
    },
  };
}

/** The side of a box's layout a side of the page is. */
function laidSide(axes: AnchorAxes, side: PhysicalSide): PhysicalSide {
  return axes.frame ? frameSideOf(side, axes.mode) : side;
}

/** The page's axis one of a box's layout's is — down where `down`. */
function pageAxisOf(axes: AnchorAxes, down: boolean): 'x' | 'y' {
  return down !== !!axes.frame ? 'y' : 'x';
}

/** Whether a writing mode starts an axis of a box's layout — down where
 *  `down` — at its top or its left, which its logical keywords read from. */
function startsLow(
  axes: AnchorAxes,
  down: boolean,
  writing: WritingAxes,
): boolean {
  const pageAxis = pageAxisOf(axes, down);
  const side = laidSide(axes, startOf(pageAxis, writing.mode, writing.rtl));
  return side === 'top' || side === 'left';
}

/** Whether a writing mode's block axis is down a box's layout. */
function blockDown(axes: AnchorAxes, writing: WritingAxes): boolean {
  const pageBlock = writing.mode === 'horizontal-tb' ? 'y' : 'x';
  return pageAxisOf(axes, true) === pageBlock;
}

/** The size of a box's layout an `anchor-size()` reads: a physical one as
 *  it is, the frame having turned it (`framedStyle`), and a logical one
 *  along the axis its writing mode has it on. */
function laidDimension(
  axes: AnchorAxes,
  size: AnchorSizeKind,
): 'width' | 'height' {
  if (size === 'width' || size === 'height') return size;
  const writing = size.startsWith('self-') ? axes.own : axes.cb;
  const block = blockDown(axes, writing);
  const down = size.endsWith('block') ? block : !block;
  return down ? 'height' : 'width';
}

/** A `position-area` as the tracks of a box's layout (`areaTracks`), the
 *  frame's of a vertical writing mode turned from the page's. */
function laidArea(area: PositionArea, axes: AnchorAxes): PositionArea {
  const { cols, rows } = areaTracks(area, axes.cb, axes.own);
  if (!axes.frame) return { cols, rows, logicalCols: false, text: area.text };
  // each of the frame's axes is one of the page's, from the side the
  // frame's start of it is drawn at
  const from = (side: PhysicalSide): [number, number] => {
    const page = pageSideOf(side, axes.mode);
    const t = page === 'left' || page === 'right' ? cols : rows;
    return page === 'left' || page === 'top' ? t : [2 - t[1], 2 - t[0]];
  };
  return {
    cols: from('left'),
    rows: from('top'),
    logicalCols: false,
    text: area.text,
  };
}

const NO_TACTICS: readonly TryTactic[] = [];

const NO_SHIFT = { x: 0, y: 0 };

/** The physical sides an inset's `anchor()` may not read: the other
 *  axis's. */
const ACROSS = new Set(['left', 'right']);
const DOWN = new Set(['top', 'bottom']);
const OTHER_AXIS: Record<InsetSide, ReadonlySet<string>> = {
  top: ACROSS,
  bottom: ACROSS,
  left: DOWN,
  right: DOWN,
};

/** Whether one scroll moves two anchors alike: in the same scroll
 *  container, and fixed to the viewport both or neither. */
function sameScrollContext(a: Box, b: Box): boolean {
  if (a === b) return true;
  return (
    nearestScrollerOf(a) === nearestScrollerOf(b) &&
    drawnAtViewport(a) === drawnAtViewport(b)
  );
}

/**
 * How far relative positioning moves an anchor that it does not move the
 * box placed against it, which the box is laid out before
 * (`applyRelativeOffsets`): the offsets of the anchor and the boxes around
 * it below the box's containing block. Those of the containing block and
 * what is around it move the two alike, and a relative box between them
 * is the containing block of what is absolute in it, and moves nothing
 * fixed (`escapes`). An anchor `position: relative; top: 100px` was where
 * the flow had it.
 */
function relativeShift(anchor: Box, box: Box): [number, number] {
  const containing = containingBlockFor(box);
  let dx = 0;
  let dy = 0;
  for (let at: Box | null = anchor; at && at !== containing; at = at.parent) {
    if (at.style.position !== 'relative') continue;
    const [x, y] = relativeOffset(at);
    dx += x;
    dy += y;
  }
  return [dx, dy];
}

/**
 * The box an anchor reference of `style` finds for `box`: the anchor a name
 * it gives finds, in the tree its anchor functions were written in, and
 * where it gives none, the box's default anchor (`defaultAnchorBox`).
 */
function referencedAnchor(
  box: Box,
  style: ComputedStyle,
  name: string | null,
  ctx: LayoutContext,
): Box | null {
  return name === null
    ? defaultAnchorBox(box, style, ctx)
    : anchorBoxFor(box, name, ctx, style.anchorFunctionsTree);
}

/**
 * A box's default anchor (CSS Anchor Positioning 1, `position-anchor`): the
 * anchor its `position-anchor` names, in the tree that name was written in,
 * or its implicit anchor element for `auto`, and for `normal` where it is
 * in a `position-area` (`anchorsImplicitly`); none for `none`.
 */
function defaultAnchorBox(
  box: Box,
  style: ComputedStyle,
  ctx: LayoutContext,
): Box | null {
  const name = style.positionAnchor;
  if (name !== null) {
    return anchorBoxFor(box, name, ctx, style.positionAnchorTree);
  }
  return anchorsImplicitly(style) ? implicitAnchorBox(box, ctx) : null;
}

/**
 * The box of a box's implicit anchor element (CSS Anchor Positioning 1,
 * 2.2), where it is an acceptable anchor: a pseudo-element's originating
 * element's, and a popover's the element that showed it (HTML 6.12,
 * `implicitAnchorOf`) — its `popovertarget` button, or `showPopover()`'s
 * `source`. A name has nothing to do with it, so no tree scopes it and no
 * `anchor-scope` keeps it away.
 */
function implicitAnchorBox(box: Box, ctx: LayoutContext): Box | null {
  const el = box.pseudo ? GENERATED_FROM.get(box) : box.el;
  const of = box.pseudo ? el : el && implicitAnchorOf(el);
  if (!of || !indexAnchors(ctx)) return null;
  const anchor = ctx.elementBoxes!.get(of);
  if (!anchor || holds(box, anchor)) return null;
  return acceptableAnchor(anchor, box, ctx.anchorOrder!) ? anchor : null;
}

/**
 * The box an anchor name finds for `box` (`referencedAnchor`): the last in
 * the document's order with the name that is not `box` or inside it, and
 * is an acceptable anchor (CSS Anchor Positioning 1, 2.2 and 2.3). Null
 * where there is none.
 */
function anchorBoxFor(
  box: Box,
  name: string,
  ctx: LayoutContext,
  /** The tree the reference was written in (`ComputedStyle.anchorNamesTree`
   *  and its kin): a name of another tree is not the one it means. */
  tree: object | null,
): Box | null {
  if (!indexAnchors(ctx)) return null;
  const list = ctx.anchors?.get(name);
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const anchor = list[i];
    if (holds(box, anchor)) continue;
    // a tree-scoped name, matched strictly (CSS Shadow 1, 3.5): a shadow
    // tree's `--a` is not the page's
    if (anchor.style.anchorNamesTree !== tree) continue;
    if (scopedAway(anchor, box, name)) continue;
    if (!acceptableAnchor(anchor, box, ctx.anchorOrder!)) continue;
    return anchor;
  }
  return null;
}

/**
 * The anchors of the tree a layout is under, found the first time a
 * positioned box asks: the boxes each name is on, each box's place in the
 * tree's order, and each element's own box. False where the tree has none.
 */
function indexAnchors(ctx: LayoutContext): boolean {
  if (!ctx.anchorRoot) return false;
  if (ctx.anchors !== undefined) return true;
  // what the last layout noted of default anchors is of its boxes
  clearDefaultAnchors(ctx.anchorRoot);
  const found = new Map<string, Box[]>();
  // an element's first box with its names, which is its own: the boxes
  // inside it that carry its style — a button's label, an anonymous block
  // — are not the anchor; and a `::before`'s or an `::after`'s, which is
  // one too (CSS Anchor Positioning 1, 2.1)
  const seen = new Set<object>();
  // and the first of all, what the element is as an implicit anchor
  const elements = new Map<Element, Box>();
  const order = new Map<Box, number>();
  const stack: Box[] = [ctx.anchorRoot];
  while (stack.length) {
    const at = stack.pop()!;
    order.set(at, order.size);
    if (at.pseudo === null && at.el && !elements.has(at.el)) {
      elements.set(at.el, at);
    }
    const names = at.style.anchorNames;
    const own =
      at.pseudo === null
        ? !!at.el && !seen.has(at.el)
        : (at.pseudo === 'before' || at.pseudo === 'after') &&
          at.parent?.pseudo !== at.pseudo;
    if (names && own) {
      if (at.el) seen.add(at.el);
      for (const n of names) {
        let list = found.get(n);
        if (!list) found.set(n, (list = []));
        list.push(at);
      }
    }
    for (let i = at.children.length - 1; i >= 0; i -= 1) {
      stack.push(at.children[i]);
    }
  }
  ctx.anchors = found;
  ctx.anchorOrder = order;
  ctx.elementBoxes = elements;
  return true;
}

/**
 * Whether `anchor-scope` keeps an anchor's name from a box (CSS Anchor
 * Positioning 1, 2.4): the nearest element around the anchor, itself
 * included, that scopes the name — by naming it, or by `all` — has the box
 * outside it; or an element around the box that scopes it has the anchor
 * outside it, since a scope limits what is in it to the anchors in it as
 * well. A scope reaches only the names of its own tree, as a strictly
 * matched tree-scoped name does (CSS Shadow 1, 3.5): `anchor-scope` set
 * through `::part()` scopes the page's names inside the part, and one a
 * shadow tree sets on its host none of the page's. An element's own box is
 * the one asked, and not the boxes inside it that carry its style.
 */
function scopedAway(anchor: Box, box: Box, name: string): boolean {
  const tree = anchor.style.anchorNamesTree;
  const scopes = (at: Box): boolean => {
    const scope = at.style.anchorScope;
    if (scope === 'none' || at.style.anchorScopeTree !== tree) return false;
    const own =
      at.pseudo === null
        ? !!at.el && at.parent?.el !== at.el
        : at.pseudo === 'before' || at.pseudo === 'after';
    return own && (scope === 'all' || scope.split(', ').includes(name));
  };
  const holds = (at: Box, b: Box): boolean => {
    for (let c: Box | null = b; c; c = c.parent) if (c === at) return true;
    return false;
  };
  for (let at: Box | null = anchor; at; at = at.parent) {
    if (scopes(at)) return !holds(at, box);
  }
  for (let at = box.parent; at; at = at.parent) {
    if (scopes(at) && !holds(at, anchor)) return true;
  }
  return false;
}

/** The scroll container a box is scrolled in: the nearest around it, or
 *  null for the viewport. */
function nearestScrollerOf(box: Box): Box | null {
  for (let at = box.parent; at; at = at.parent) {
    if (isScroller(at)) return at;
  }
  return null;
}

/**
 * Whether an anchor is laid out before the box it would anchor, as CSS
 * Anchor Positioning 1, 2.3 has an acceptable anchor element: no later in
 * the top layer than the box (`topLayerRank`); inside the box's containing
 * block, or the box's containing block is the initial one; and where the
 * two share a containing block, the anchor not absolutely positioned or
 * before the box in the tree, and otherwise the last containing block on
 * the anchor's chain before the box's the same.
 */
function acceptableAnchor(
  anchor: Box,
  box: Box,
  order: Map<Box, number>,
): boolean {
  if (topLayerRank(anchor) > topLayerRank(box)) return false;
  const positioned = (b: Box) =>
    b.style.position === 'absolute' || b.style.position === 'fixed';
  const cbOf = (b: Box): Box | null =>
    positioned(b) ? containingBlockOf(b) : b.parent;
  const cb = cbOf(box);
  const initial = cb === null || cb.parent === null;
  if (!initial) {
    let within = false;
    for (let at = anchor.parent; at; at = at.parent) {
      if (at === cb) {
        within = true;
        break;
      }
    }
    if (!within) return false;
  }
  // the last box on the anchor's chain of containing blocks before the
  // box's own
  let last = anchor;
  for (let at = cbOf(anchor); at && at !== cb; at = cbOf(at)) last = at;
  if (!positioned(last)) return true;
  return (order.get(last) ?? 0) < (order.get(box) ?? 0);
}

/**
 * Where a box is laid out among the top layer's (CSS Position 4, 3.1): 0
 * for one in none, and after it each element's box in the order it went
 * into the layer, its `::backdrop`'s first — what is in the top layer
 * being laid out after everything that is not, as it is painted over it.
 * A modal dialog anchored in the page is no anchor of a box below it.
 */
function topLayerRank(box: Box): number {
  for (let at: Box | null = box; at; at = at.parent) {
    if (!at.topLayer) continue;
    const el = at.el ?? at.parent?.el;
    if (!el) return 1;
    return 2 + 2 * topLayerOrder(el) + (at.pseudo === 'backdrop' ? 0 : 1);
  }
  return 0;
}

/**
 * A style tried again by tactics (CSS Anchor Positioning 1, 4.1), and in a
 * `position-area` that replaces its own where `area` is one: `flip-block`
 * mirrors it down — its top inset and margin swapped for its bottom ones,
 * an `anchor()` reading the other side, its area's rows the other way
 * round — `flip-inline` across, and `flip-start` about the diagonal from
 * its start, its insets, margins, sizes and area swapped between the axes.
 */
function triedWith(
  style: ComputedStyle,
  tactics: readonly TryTactic[],
  area: PositionArea | null,
  axes: AnchorAxes,
): ComputedStyle {
  const placed = area ?? style.positionArea;
  if (!tactics.length && !placed) return style;
  const out: ComputedStyle = { ...style };
  // the area as the tracks of the box's layout, which a tactic flips
  if (placed) out.positionArea = laidArea(placed, axes);
  // the axes of the containing block's writing mode, and the page's, as
  // the box's layout has them (4.1)
  const block = blockDown(axes, axes.cb);
  const x = pageAxisOf(axes, true) === 'x';
  for (const tactic of tactics) {
    if (tactic === 'flip-start') flipStart(out, axes);
    else {
      flipAxis(
        out,
        tactic === 'flip-block'
          ? block
          : tactic === 'flip-inline'
            ? !block
            : tactic === 'flip-x'
              ? x
              : !x,
      );
    }
  }
  return out;
}

/** The side an `anchor()`'s side is on mirrored along an axis. */
function mirroredSide(side: AnchorSide, down: boolean): AnchorSide {
  if (typeof side === 'number') return 1 - side;
  const pairs: Record<string, AnchorSide> = down
    ? { top: 'bottom', bottom: 'top' }
    : { left: 'right', right: 'left' };
  const flipped = pairs[side];
  if (flipped) return flipped;
  if (side === 'inside' || side === 'outside' || side === 'center') {
    return side;
  }
  // `start` and `end`, which an axis flipped turns about
  return side === 'start'
    ? 'end'
    : side === 'end'
      ? 'start'
      : side === 'self-start'
        ? 'self-end'
        : 'self-start';
}

/** A self-alignment's position mirrored along its axis. */
const FLIPPED_SELF: Partial<
  Record<
    ComputedStyle['alignSelf'],
    ComputedStyle['alignSelf'] & ComputedStyle['justifySelf']
  >
> = {
  'flex-start': 'flex-end',
  'flex-end': 'flex-start',
};

function flipAxis(style: ComputedStyle, down: boolean): void {
  const [a, b] = down
    ? (['top', 'bottom'] as const)
    : (['left', 'right'] as const);
  const [ma, mb] = down
    ? (['marginTop', 'marginBottom'] as const)
    : (['marginLeft', 'marginRight'] as const);
  [style[a], style[b]] = [style[b], style[a]];
  [style[ma], style[mb]] = [style[mb], style[ma]];
  // its self-alignment the other way along the axis (4.1): a box aligned
  // to the start is aligned to the end
  if (down) style.alignSelf = FLIPPED_SELF[style.alignSelf] ?? style.alignSelf;
  else style.justifySelf = FLIPPED_SELF[style.justifySelf] ?? style.justifySelf;
  if (style.anchorSizes) {
    style.anchorSizes = movedSizes(style.anchorSizes, {
      [a]: b,
      [b]: a,
      [ma]: mb,
      [mb]: ma,
    });
  }
  const insets = style.anchorInsets;
  if (insets) {
    const out: Partial<Record<InsetSide, AnchorInset>> = { ...insets };
    delete out[a];
    delete out[b];
    const ia = insets[a];
    const ib = insets[b];
    const mirrored = (inset: AnchorInset) =>
      mapAnchorCalls(inset, (ref) => ({
        ...ref,
        side: mirroredSide(ref.side, down),
      }));
    if (ia) out[b] = mirrored(ia);
    if (ib) out[a] = mirrored(ib);
    style.anchorInsets = out;
  }
  const area = style.positionArea;
  if (area) {
    const flip = ([s, e]: readonly [number, number]): [number, number] => [
      2 - e,
      2 - s,
    ];
    style.positionArea = down
      ? { ...area, rows: flip(area.rows) }
      : { ...area, cols: flip(area.cols) };
  }
}

/**
 * `flip-start` (CSS Anchor Positioning 1, 4.1): the box mirrored about the
 * diagonal from the start corner of its containing block's writing mode —
 * each side swapped with the side the diagonal takes it to, in the axes the
 * box is laid out in, and its sizes, its `anchor-size()`s' axes, its
 * area's tracks and its self-alignment with them.
 */
function flipStart(style: ComputedStyle, axes: AnchorAxes): void {
  // the start sides of the two axes, which the diagonal swaps, and their
  // ends with them
  const blockStart = startSide(axes, blockDown(axes, axes.cb));
  const inlineStart = startSide(axes, !blockDown(axes, axes.cb));
  const swap: Record<PhysicalSide, PhysicalSide> = {
    [blockStart]: inlineStart,
    [inlineStart]: blockStart,
    [OPPOSITE[blockStart]]: OPPOSITE[inlineStart],
    [OPPOSITE[inlineStart]]: OPPOSITE[blockStart],
  } as Record<PhysicalSide, PhysicalSide>;
  const from = { ...style };
  for (const side of SIDES) {
    const to = swap[side];
    style[to] = from[side];
    style[MARGIN_OF[to]] = from[MARGIN_OF[side]];
  }
  [style.width, style.height] = [style.height, style.width];
  [style.minWidth, style.minHeight] = [style.minHeight, style.minWidth];
  [style.maxWidth, style.maxHeight] = [style.maxHeight, style.maxWidth];
  [style.justifySelf, style.alignSelf] = [
    alignSelfAs(style.alignSelf),
    justifySelfAs(style.justifySelf),
  ];
  [style.justifyAnchorCenter, style.alignAnchorCenter] = [
    style.alignAnchorCenter,
    style.justifyAnchorCenter,
  ];
  const insets = style.anchorInsets;
  if (insets) {
    const out: Partial<Record<InsetSide, AnchorInset>> = {};
    for (const [side, inset] of Object.entries(insets) as [
      InsetSide,
      AnchorInset,
    ][]) {
      out[swap[side]] = mapAnchorCalls(inset, (ref) =>
        typeof ref.side === 'string' && ref.side in swap
          ? { ...ref, side: swap[ref.side as PhysicalSide] }
          : ref,
      );
    }
    style.anchorInsets = out;
  }
  const sizes = style.anchorSizes;
  if (sizes) {
    const to: Partial<Record<AnchorSizeField, AnchorSizeField>> = {
      width: 'height',
      height: 'width',
      minWidth: 'minHeight',
      minHeight: 'minWidth',
      maxWidth: 'maxHeight',
      maxHeight: 'maxWidth',
    };
    for (const side of SIDES) {
      to[side] = swap[side];
      to[MARGIN_OF[side]] = MARGIN_OF[swap[side]];
    }
    style.anchorSizes = movedSizes(sizes, to, (ref) => ({
      ...ref,
      size: OTHER_SIZE[ref.size],
    }));
  }
  const area = style.positionArea;
  if (area) {
    // a track's index runs from the top or the left: the tracks down go
    // across from the side the top goes to, and the other way round
    const moved = (
      tracks: readonly [number, number],
      side: PhysicalSide,
    ): [number, number] =>
      side === 'top' || side === 'left'
        ? [tracks[0], tracks[1]]
        : [2 - tracks[1], 2 - tracks[0]];
    style.positionArea = {
      cols: moved(area.rows, swap.top),
      rows: moved(area.cols, swap.left),
      logicalCols: false,
    };
  }
}

/** A style's `anchor-size()`s each under the field `to` moves it to, or
 *  its own, with each call made another by `call`. */
function movedSizes(
  sizes: Readonly<Partial<Record<AnchorSizeField, AnchorSize>>>,
  to: Partial<Record<AnchorSizeField, AnchorSizeField>>,
  call?: (ref: AnchorSizeRef) => AnchorSizeRef,
): Partial<Record<AnchorSizeField, AnchorSize>> {
  const out: Partial<Record<AnchorSizeField, AnchorSize>> = {};
  for (const [field, size] of Object.entries(sizes) as [
    AnchorSizeField,
    AnchorSize,
  ][]) {
    out[to[field] ?? field] = call ? mapAnchorCalls(size, call) : size;
  }
  return out;
}

/** The side of a box's layout a writing mode starts one of its axes at. */
function startSide(axes: AnchorAxes, down: boolean): PhysicalSide {
  const low = startsLow(axes, down, axes.cb);
  return down ? (low ? 'top' : 'bottom') : low ? 'left' : 'right';
}

const SIDES: readonly PhysicalSide[] = ['top', 'right', 'bottom', 'left'];

const OPPOSITE: Record<PhysicalSide, PhysicalSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

const MARGIN_OF = {
  top: 'marginTop',
  right: 'marginRight',
  bottom: 'marginBottom',
  left: 'marginLeft',
} as const;

const OTHER_SIZE: Record<AnchorSizeKind, AnchorSizeKind> = {
  width: 'height',
  height: 'width',
  inline: 'block',
  block: 'inline',
  'self-inline': 'self-block',
  'self-block': 'self-inline',
};

/** An `align-self` as a `justify-self` (`flip-start`): the two take the
 *  same positions, and `baseline` only down. */
function alignSelfAs(
  value: ComputedStyle['alignSelf'],
): ComputedStyle['justifySelf'] {
  return value === 'baseline' ? 'normal' : value;
}

function justifySelfAs(
  value: ComputedStyle['justifySelf'],
): ComputedStyle['alignSelf'] {
  return value;
}

/**
 * An absolutely positioned box, against its containing block: a box's
 * padding box, or an inline box's fragments (`inlineContainingBlock`) —
 * or the cells of a `position-area` (`Anchoring`). An axis with neither
 * offset takes the static position, where the box would have been in flow
 * (`placeStatic`, and `staticPositions` in a line); one its self-alignment
 * aligns is aligned in its inset-modified containing block
 * (`selfAligned`). Answers that rectangle, which says whether it fits.
 */
function positionedIn(
  box: Box,
  containing: Box,
  ctx: LayoutContext,
  anchoring: Anchoring | null,
): Placement {
  // a grid's is the box's grid area (CSS Grid 1, 9.1), whether the box is
  // the grid's child or deeper in it
  const area =
    containing.kind === 'inline' ? null : gridArea(box, containing, ctx);
  // the containing block as it is before a `position-area` takes its cells
  // of it, which a box too big for them is held in as far as it can be
  const whole =
    containing.kind === 'inline'
      ? inlineContainingBlock(containing, box, ctx)
      : (area ?? containingRect(containing, ctx));
  // and a box in a `position-area` is in the area's cells
  const placed = anchoring?.area ?? null;
  const { x: cbX, y: cbY, width: cbWidth, height: cbHeight } = placed ?? whole;
  resolveEdges(box, cbWidth);
  box.percentHeightBase = cbHeight;

  const style = box.style;
  let left = resolveOrNull(style.left, cbWidth);
  let right = resolveOrNull(style.right, cbWidth);
  let top = resolveOrNull(style.top, cbHeight);
  let bottom = resolveOrNull(style.bottom, cbHeight);
  // an axis its self-alignment places it on (CSS Position 3, 4.3): sized
  // and placed in the rectangle its insets leave, an `auto` inset nought
  const alignX = selfAligned(
    box,
    false,
    cbX,
    cbWidth,
    left,
    right,
    anchoring,
    containing.style.direction === 'rtl',
  );
  const alignY = selfAligned(box, true, cbY, cbHeight, top, bottom, anchoring);
  if (alignX) {
    left = alignX.startInset;
    right = alignX.endInset;
  }
  if (alignY) {
    top = alignY.startInset;
    bottom = alignY.endInset;
  }
  // what both offsets down and the margins leave of the containing block,
  // and NaN where it has no pair of them, or is aligned in what they leave
  const fill =
    top !== null && bottom !== null && (!alignY || alignY.stretch)
      ? Math.max(0, cbHeight - top - bottom - box.marginTop - box.marginBottom)
      : NaN;

  // with neither offset on an axis, the box is where the flow would have
  // put it (CSS 2.1 10.3.7, 10.6.4): against its start edge, which is the
  // right one in a right-to-left flow. A grid's own child is aligned in its
  // grid area instead, where that is its containing block; a box deeper in
  // the grid is where its own flow put it.
  const inArea =
    !placed &&
    area !== null &&
    box.staticPosition?.inside !== undefined &&
    box.staticPosition.from === containing;
  // one in the top layer is at the start of its containing block, which
  // is no box's in the flow it was in (CSS Position 4, 3.1), and one in a
  // `position-area` is aligned in it
  const at = placed || inArea || box.topLayer ? null : box.staticPosition;
  const rtl = (at?.from ?? containing).style.direction === 'rtl';
  // where the box is as a flex box's or a grid's one item, aligned in it —
  // or in its grid area
  const room = inArea
    ? {
        x: cbX,
        y: cbY,
        width: cbWidth,
        height: cbHeight,
        ...staticAlignment(box, containing, false),
      }
    : at?.inside
      ? { ...insideRect(at.from, at.inside.box), ...at.inside }
      : null;
  // and a shrink-to-fit box's room starts at the offset on the side it has
  // one, or at its static position: `left: 50%` leaves it half the width —
  // and one aligned between its insets has what they leave
  const offset = alignX
    ? cbWidth - alignX.size
    : (left ??
      right ??
      (!at
        ? 0
        : rtl
          ? cbX + cbWidth - (at.from.x + at.right)
          : at.from.x + at.x - cbX));

  let width: number;
  let stretched = NaN;
  if (style.width !== AUTO) {
    width = blockWidth(box, cbWidth, cbWidth, ctx);
  } else if (style.widthKeyword === 'stretch') {
    // what its offsets and margins leave of its containing block — an
    // `auto` offset leaving all it has, but where both are, the start is
    // its static position (CSS Position 3, 4.1)
    const start = left ?? (right === null ? offset : 0);
    const room =
      cbWidth - start - (right ?? 0) - box.marginLeft - box.marginRight;
    width = clampWidth(box, Math.max(0, room), cbWidth, ctx);
  } else if (style.widthKeyword || ratioWidth(box) !== null) {
    // an intrinsic size, which both offsets do not stretch, or a height of
    // its own through its ratio
    width = shrinkToFitWidth(box, ctx, cbWidth, offset);
  } else if (alignX && !alignX.stretch) {
    // aligned, it is as wide as its content in what its insets leave, which
    // they do not stretch it to (CSS Position 3, 4.1)
    width = shrinkToFitWidth(box, ctx, cbWidth, offset);
  } else if (
    boxRatio(box) &&
    (left === null || right === null) &&
    top !== null &&
    bottom !== null &&
    !Number.isNaN(fill)
  ) {
    // the height its offsets leave it through its ratio, where its width
    // has no pair of them to stretch it (CSS Sizing 4, 5.1)
    const tall = clampHeight(box, fill);
    width = ratioMinimum(
      box,
      clampWidth(box, widthFromHeight(box, tall)!, cbWidth, ctx),
      cbWidth,
      ctx,
    );
  } else if (left !== null && right !== null) {
    stretched = Math.max(
      0,
      cbWidth - left - right - box.marginLeft - box.marginRight,
    );
    // within its least and greatest width, which make it a width as one
    // set would, and the margins' rules run again with it (CSS 2.1 10.4) —
    // and those of its height, through a ratio (CSS Sizing 4, 5.1)
    width = clampWidth(box, transferredWidth(box, stretched), cbWidth, ctx);
  } else {
    width = shrinkToFitWidth(box, ctx, cbWidth, offset);
  }

  // `stretch` down: what its offsets leave, from its static position where
  // it has neither
  if (
    style.heightKeyword === 'stretch' ||
    style.minHeightKeyword === 'stretch'
  ) {
    STRETCH_TOP.set(
      box,
      top ?? (bottom === null && at ? at.from.y + at.y - cbY : 0),
    );
  }
  // A form control is an inline block to CSS and no replaced element,
  // whatever draws it (HTML's rendering section): with both offsets and no
  // size of its own it fills what they leave, as any box does, where an
  // image keeps its own (10.3.8, 10.6.5). A page lays an invisible
  // `<select>` over a picker it draws, `position: absolute; inset: 0`, to
  // take the press, and it has to cover it.
  const control = isControl(box);
  // Both offsets and no height: the box fills what they leave, its `auto`
  // margins nothing (10.6.4, rule 5) — but a box with a ratio has its
  // height from its width, and a table is as tall as its rows, as it is as
  // wide as its columns between two offsets: `normal` stretches neither
  // (Blink: "Replaced/tables don't stretch in abspos",
  // `out_of_flow_layout_part.cc`), and a table taken to the height its
  // offsets leave was that tall around rows that were not. Nor does a
  // height of its content's, `fit-content` and its kin, which a modal
  // dialog is between `inset-block: 0`, centred in the viewport by its
  // `auto` margins
  const stretches =
    !Number.isNaN(fill) &&
    style.height === AUTO &&
    (style.heightKeyword === null || style.heightKeyword === 'stretch') &&
    (box.kind !== 'replaced' || control) &&
    box.kind !== 'table' &&
    !boxRatio(box);
  if (box.kind === 'replaced') {
    sizeReplaced(box, cbWidth);
    stretchReplaced(
      box,
      style.widthKeyword === 'stretch' ||
        (control &&
          style.width === AUTO &&
          style.widthKeyword === null &&
          left !== null &&
          right !== null &&
          (!alignX || alignX.stretch))
        ? width
        : null,
      cbWidth,
    );
  } else if (stretches && style.heightKeyword === null) {
    // That height is definite, a stretch-fit size against a containing
    // block, which is always definite to the box (CSS Sizing 3, 2.1), so
    // the box is laid out in it, as a grid item stretched down its area
    // is: what is in it takes its percentages of it, and a grid or a flex
    // box sizes and aligns its content in it (CSS Grid 1, 11.1; CSS
    // Flexbox 9.2) — as `height: stretch` is laid out in it already
    // (`specifiedHeight`). Laid out first and stretched after, `inset: 4px;
    // display: grid; place-content: center` held its icon at the top.
    FLEXED_HEIGHT.set(
      box,
      Math.max(0, clampHeight(box, fill) - box.verticalExtra),
    );
    try {
      layoutOwn(box, ctx, width);
    } finally {
      FLEXED_HEIGHT.delete(box);
    }
  } else layoutOwn(box, ctx, width);

  let x: number;
  if (alignX) {
    x =
      alignedStart(
        alignX,
        box.width + box.marginLeft + box.marginRight,
        whole.x,
        whole.width,
      ) + box.marginLeft;
  } else if (
    left !== null &&
    right !== null &&
    (style.width !== AUTO ||
      style.widthKeyword !== null ||
      box.kind === 'replaced' ||
      width !== stretched)
  ) {
    // Both offsets and a width: what is left over goes to the margins that
    // are `auto`, shared where both are, and where none is, the end offset
    // gives way (10.3.7, 10.3.8).
    const rest = cbWidth - left - right - box.width;
    const autoLeft = style.marginLeft === AUTO;
    const autoRight = style.marginRight === AUTO;
    const endRtl = containing.style.direction === 'rtl';
    if (autoLeft && autoRight) {
      if (rest >= 0) {
        box.marginLeft = rest / 2;
        box.marginRight = rest / 2;
      } else if (endRtl) {
        box.marginRight = 0;
        box.marginLeft = rest;
      } else {
        box.marginLeft = 0;
        box.marginRight = rest;
      }
    } else if (autoLeft) {
      box.marginLeft = rest - box.marginRight;
    } else if (autoRight) {
      box.marginRight = rest - box.marginLeft;
    }
    x =
      endRtl && !autoLeft && !autoRight
        ? cbX + cbWidth - right - box.width - box.marginRight
        : cbX + left + box.marginLeft;
  } else {
    x =
      left !== null
        ? cbX + left + box.marginLeft
        : right !== null
          ? cbX + cbWidth - right - box.width - box.marginRight
          : room
            ? alignedIn(
                room.x,
                room.width,
                room.across,
                box.width + box.marginLeft + box.marginRight,
                rtl,
              ) + box.marginLeft
            : rtl
              ? (at ? at.from.x + at.right : cbX + cbWidth) -
                box.width -
                box.marginRight
              : (at ? at.from.x + at.x : cbX) + box.marginLeft;
  }
  let y: number;
  if (alignY) {
    if (stretches) {
      box.height = clampHeight(box, fill);
      centreButton(box);
    }
    y =
      alignedStart(
        alignY,
        box.height + box.marginTop + box.marginBottom,
        whole.y,
        whole.height,
      ) + box.marginTop;
  } else if (top !== null && bottom !== null) {
    // a box that fills what its offsets leave, unless `min-height` or
    // `max-height` moves that, which makes it a height like one set, and
    // the rules run again with it (10.7)
    if (stretches) {
      box.height = clampHeight(box, fill);
      centreButton(box);
    }
    if (!stretches || box.height !== fill) {
      // and a height: the `auto` margins share the rest, and where none
      // is `auto`, `bottom` gives way (10.6.4, 10.6.5)
      const rest = cbHeight - top - bottom - box.height;
      const autoTop = style.marginTop === AUTO;
      const autoBottom = style.marginBottom === AUTO;
      if (autoTop && autoBottom) {
        box.marginTop = rest / 2;
        box.marginBottom = rest / 2;
      } else if (autoTop) {
        box.marginTop = rest - box.marginBottom;
      } else if (autoBottom) {
        box.marginBottom = rest - box.marginTop;
      }
    }
    y = cbY + top + box.marginTop;
  } else {
    y =
      top !== null
        ? cbY + top + box.marginTop
        : bottom !== null
          ? cbY + cbHeight - bottom - box.height - box.marginBottom
          : room
            ? alignedIn(
                room.y,
                room.height,
                room.down,
                box.height + box.marginTop + box.marginBottom,
                false,
              ) + box.marginTop
            : (at ? at.from.y + at.y : cbY) + box.marginTop;
  }
  moveTo(box, x, y);
  // the rectangle its insets leave of its containing block, which it has
  // to fit in to be in no need of another position (CSS Anchor
  // Positioning 1, 6.5)
  const [ix, iw, cx] = alignX
    ? [alignX.start, alignX.size, alignX.corrected]
    : insetSpan(cbX, cbWidth, left, right);
  const [iy, ih, cy] = alignY
    ? [alignY.start, alignY.size, alignY.corrected]
    : insetSpan(cbY, cbHeight, top, bottom);
  return {
    x: ix,
    y: iy,
    width: iw,
    height: ih,
    corrected: cx || cy,
    moving: anchoring?.moving ?? 0,
  };
}

/** One axis of the rectangle a box's insets leave of its containing block,
 *  an `auto` inset nought: its start, its size, and whether the insets
 *  went past each other, which leaves it none. */
function insetSpan(
  start: number,
  size: number,
  a: number | null,
  b: number | null,
): [number, number, boolean] {
  const room = size - (a ?? 0) - (b ?? 0);
  return [start + (a ?? 0), Math.max(0, room), room < 0];
}

/**
 * An axis an absolutely positioned box's self-alignment places it on (CSS
 * Position 3, 4.3): the inset-modified containing block — its insets,
 * `auto` ones nought, having given way where they went past each other
 * (3.5.2) — and where in it the box goes: `along` of its free room from
 * the start, or centred on `centre`.
 */
interface SelfAligned {
  start: number;
  size: number;
  corrected: boolean;
  /** The insets, as offsets size the box. */
  startInset: number;
  endInset: number;
  along: number;
  /** The default anchor's centre, for `anchor-center`. */
  centre: number | null;
  /** Whether an `auto` size fills it. */
  stretch: boolean;
  /** Whether it may overflow as its alignment has it, where the default
   *  would hold it in: `normal` against the one inset it has in a
   *  `position-area` (CSS Anchor Positioning 1, 4.1). */
  unsafe: boolean;
}

/**
 * How an absolutely positioned box is aligned on an axis, by `justify-self`
 * across and `align-self` down — or null where it is placed as it always
 * was, by an inset's edge, its `auto` margins or its static position. In a
 * `position-area`'s cells, `normal` aligns it towards the anchor, or
 * centres it on the anchor where the cells are all three tracks of the
 * axis (CSS Anchor Positioning 1, 4.1), and every `auto` inset and margin
 * is nought (3.1); `anchor-center` centres it on its default anchor,
 * making the same of its `auto` insets and margins (4.2), and is `center`
 * where it has none. Elsewhere the box is aligned between two insets that
 * are not `auto`, where neither margin is (CSS Position 3, 4.3): `start`,
 * `end` and `center`; `normal` and `stretch` fill what they leave, as they
 * always did.
 */
function selfAligned(
  box: Box,
  down: boolean,
  cbStart: number,
  cbSize: number,
  start: number | null,
  end: number | null,
  anchoring: Anchoring | null,
  rtl = false,
): SelfAligned | null {
  const style = box.style;
  const value = down ? style.alignSelf : style.justifySelf;
  const anchorCentre = anchoring?.centre
    ? down
      ? anchoring.centre.y
      : anchoring.centre.x
    : null;
  const normal = value === 'auto' || value === 'normal' || value === 'baseline';
  let along =
    value === 'center'
      ? 0.5
      : value === 'flex-end'
        ? rtl
          ? 0
          : 1
        : rtl
          ? 1
          : 0;
  let centre: number | null = null;
  let stretch = false;
  let unsafe = false;
  if (
    (down ? style.alignAnchorCenter : style.justifyAnchorCenter) &&
    anchorCentre !== null
  ) {
    centre = anchorCentre;
  } else if (anchoring?.area) {
    if (value === 'stretch') {
      stretch = true;
      along = rtl ? 1 : 0;
    } else if (normal) {
      if ((start === null) !== (end === null)) {
        // towards the inset it has, as one inset alone places a box
        along = start !== null ? 0 : 1;
        unsafe = true;
      } else {
        const area = down ? anchoring.down : anchoring.across;
        if (area === null) centre = anchorCentre;
        else along = area;
      }
    }
  } else {
    if (normal || value === 'stretch' || start === null || end === null) {
      return null;
    }
    const [ma, mb] = down
      ? [style.marginTop, style.marginBottom]
      : [style.marginLeft, style.marginRight];
    if (ma === AUTO || mb === AUTO) return null;
  }
  let a = start ?? 0;
  let b = end ?? 0;
  const room = cbSize - a - b;
  // insets that go past each other: the weaker gives way, the `auto` one
  // where one is, and otherwise the end's (CSS Position 3, 3.5.2)
  if (room < 0) {
    if (start === null && end !== null) a += room;
    else if (end === null && start !== null) b += room;
    else if (rtl) a += room;
    else b += room;
  }
  return {
    start: cbStart + a,
    size: Math.max(0, room),
    corrected: room < 0,
    startInset: a,
    endInset: b,
    along,
    centre,
    stretch,
    unsafe,
  };
}

/**
 * Where a margin box `outer` long starts on an aligned axis (`selfAligned`)
 * of a box whose containing block, before a `position-area` took its cells
 * of it, runs from `cbStart` for `cbSize`. Held inside the inset-modified
 * containing block where it fits, as CSS Box Alignment 3, 4.4.1.2 has the
 * default overflow alignment; where it does not, covering it as far as the
 * rectangle around it and the containing block allows, and at that
 * rectangle's start where it is larger still. Unsafe, where it is aligned
 * as it says.
 */
function alignedStart(
  a: SelfAligned,
  outer: number,
  cbStart: number,
  cbSize: number,
): number {
  const free = a.size - outer;
  const want =
    a.centre !== null ? a.centre - outer / 2 : a.start + a.along * free;
  if (a.unsafe) return want;
  const within = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  if (free >= 0) return within(want, a.start, a.start + free);
  const lo = Math.min(a.start, cbStart);
  const hi = Math.max(a.start + a.size, cbStart + cbSize);
  if (outer > hi - lo) return lo;
  return within(
    want,
    Math.max(lo, a.start + a.size - outer),
    Math.min(a.start, hi - outer),
  );
}

/** A box's content box or its padding box, as its layout left them. */
function insideRect(
  box: Box,
  which: 'content' | 'padding',
): { x: number; y: number; width: number; height: number } {
  if (which === 'content') {
    return {
      x: box.contentX,
      y: box.contentY,
      width: box.contentWidth,
      height: Math.max(0, box.height - box.verticalExtra),
    };
  }
  return {
    x: box.x + box.borderLeft,
    y: box.y + box.borderTop,
    width: Math.max(0, box.width - box.borderLeft - box.borderRight),
    height: Math.max(0, box.height - box.borderTop - box.borderBottom),
  };
}

/** Where a margin box of a size starts in a room, `along` of the free room
 *  before it from the room's start — its right end where `rtl`. */
function alignedIn(
  start: number,
  size: number,
  along: number,
  outer: number,
  rtl: boolean,
): number {
  const free = size - outer;
  return rtl ? start + size - outer - along * free : start + along * free;
}

/**
 * The grid area a box positioned in a grid takes for its containing block
 * (CSS Grid 1, 9.1): between the lines its placement names, where the grid
 * has them, and the grid's padding edge where a line is `auto`, is no line
 * of the grid, or is only a `span`. Null for a box whose containing block
 * is no grid.
 */
function gridArea(
  box: Box,
  containing: Box,
  ctx: LayoutContext,
): CbRect | null {
  const tracks = GRID_TRACKS.get(containing);
  if (!tracks) return null;
  const style = box.style;
  const pad = containingRect(containing, ctx);
  const [x, width] = areaSpan(
    style.gridColumnStart,
    style.gridColumnEnd,
    tracks.cols,
    tracks.colLines,
    containing.contentX,
    pad.x,
    pad.width,
  );
  const [y, height] = areaSpan(
    style.gridRowStart,
    style.gridRowEnd,
    tracks.rows,
    tracks.rowLines,
    containing.contentY,
    pad.y,
    pad.height,
  );
  return { x, y, width, height };
}

/** One axis of a grid area: its start and its size in document
 *  coordinates. A line is a track's start where it starts one and a
 *  track's end where it ends one, so a gap is in neither; a line by name
 *  is the one the placement would take. */
function areaSpan(
  start: GridLine,
  end: GridLine,
  tracks: readonly [number, number][],
  lines: GridLines,
  origin: number,
  edge: number,
  size: number,
): [number, number] {
  const count = tracks.length;
  // a line the grid has, or null for auto, a span and one it has not
  const at = (line: GridLine, side: 'start' | 'end'): number | null => {
    const index = lineOf(lines, line, side);
    return index !== null && count > 0 && index >= 0 && index <= count
      ? index
      : null;
  };
  const spanOf = (line: GridLine) => (line && 'span' in line ? line : null);
  let from = at(start, 'start');
  let to = at(end, 'end');
  const startSpan = spanOf(start);
  const endSpan = spanOf(end);
  if (from === null && to !== null && startSpan) {
    const f =
      startSpan.name !== undefined
        ? spanToName(lines, startSpan.name, startSpan.span, to, false)
        : to - startSpan.span;
    from = f >= 0 ? f : null;
  }
  if (to === null && from !== null && endSpan) {
    const t =
      endSpan.name !== undefined
        ? spanToName(lines, endSpan.name, endSpan.span, from, true)
        : from + endSpan.span;
    to = t <= count ? t : null;
  }
  if (from !== null && to !== null && to < from) [from, to] = [to, from];
  const a =
    from === null
      ? edge
      : origin + (from < count ? tracks[from][0] : tracks[from - 1][1]);
  const b =
    to === null || to === from
      ? edge + size
      : origin + (to >= 1 ? tracks[to - 1][1] : tracks[0][0]);
  return [a, Math.max(0, b - a)];
}

/** A containing block's rectangle, in document coordinates. */
interface CbRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The containing block a box that lays itself out gives: its padding box
 * (CSS 2.1 10.1), not its content box — `left: 0` in a padded box is at
 * its padding edge — and with nothing positioned around it the initial
 * one, as tall as the viewport rather than as the document, which a fixed
 * box's is too.
 */
function containingRect(containing: Box, ctx: LayoutContext): CbRect {
  // a layout that reads the viewport's height lays out differently in
  // another (`LayoutResult.readsViewportHeight`)
  if (!containing.parent) ctx.readViewportHeight = true;
  return paddingRectOf(containing, ctx.viewportWidth, ctx.viewportHeight);
}

/** A box's padding box, where the boxes it positions are placed: the root
 *  box's is the initial containing block, the viewport at the document's
 *  top (CSS 2.1 10.1), not the box of the element the root box stands in
 *  for, inside its margins and its border (`layoutDocument`). */
function paddingRectOf(
  containing: Box,
  viewportWidth: number,
  viewportHeight: number,
  /** Whether the tree may hold a frame, which a layout knows already. */
  turned = framed.any,
): CbRect {
  if (!containing.parent) {
    return { x: 0, y: 0, width: viewportWidth, height: viewportHeight };
  }
  // a frame's, which its turn makes the containing block of what it
  // holds, is its root's padding box as the frame lays it out: the frame
  // itself is only as tall as what is in it, which the page has as wide
  const root = turned ? FRAME_ROOTS.get(containing) : undefined;
  if (root) {
    return frameRectOf(
      containing,
      paddingRectOf(root, viewportWidth, viewportHeight, false),
      root.style.writingMode,
    );
  }
  return {
    x: containing.x + containing.borderLeft,
    y: containing.y + containing.captionTop + containing.borderTop,
    width: Math.max(
      0,
      containing.width - containing.borderLeft - containing.borderRight,
    ),
    height: Math.max(
      0,
      containing.height -
        containing.captionTop -
        containing.captionBottom -
        containing.borderTop -
        containing.borderBottom,
    ),
  };
}

/**
 * The containing block a `position: relative` inline box gives (CSS 2.1
 * 10.1, item 4): from the padding edge its first fragment starts at to the
 * one its last ends at, over the top of the first and the bottom of the
 * last. The box lays nothing out of its own — its fragments are on its
 * block's lines — so read as a box that does, it was a rectangle of no size
 * at the page's corner, and a tooltip under a positioned link came up
 * there. A box with no fragment at all stands where the box inside it
 * would have been in flow.
 */
function inlineContainingBlock(
  inline: Box,
  box: Box,
  ctx: LayoutContext,
): CbRect {
  let block = inline.parent;
  while (block && block.kind === 'inline') block = block.parent;
  const face = ctx.fonts ? faceExtentOf(ctx.fonts, inline.style) : null;
  let first: CbRect | null = null;
  let last: CbRect | null = null;
  for (const line of block?.lines ?? []) {
    const span = spanOn(line, inline);
    if (!span) continue;
    const [top, bottom] = fragmentRow(line, inline, face, false);
    const rect = {
      x: span[0],
      y: top,
      width: span[1] - span[0],
      height: bottom - top,
    };
    first ??= rect;
    last = rect;
  }
  if (!first || !last) {
    const at = box.staticPosition;
    const x = at ? at.from.x + at.x : 0;
    const y = at ? at.from.y + at.y : 0;
    const height = face ? face.ascent + face.descent : 0;
    return { x, y, width: 0, height };
  }
  const rtl = inline.style.direction === 'rtl';
  const start = rtl ? first.x + first.width : first.x;
  const end = rtl ? last.x : last.x + last.width;
  let x = Math.min(start, end);
  let width = Math.abs(end - start);
  if (rtl ? end > start : end < start) {
    // the last fragment ends before the first begins, which CSS 2.1 leaves
    // undefined: both, then, as a browser takes them
    x = Math.min(first.x, last.x);
    width = Math.max(first.x + first.width, last.x + last.width) - x;
  }
  return { x, y: first.y, width, height: last.y + last.height - first.y };
}

/** How far an inline box's padding box reaches across a line, left and
 *  right; null where nothing of it is on the line. */
function spanOn(
  line: LineBox,
  inline: Box,
  /** To its border edges, where it starts or ends here, rather than its
   *  padding edges. */
  border = false,
): [number, number] | null {
  const shifted = SHIFTED_LINES.has(line);
  let left = Infinity;
  let right = -Infinity;
  for (const text of line.texts) {
    const natural = text.layout.lines[text.layoutLine];
    const boxAt = text.spans.boxAt;
    if (!natural || !boxAt) continue;
    // where the line has it, not where an offset of a box in it moved it
    const shift = shifted ? TEXT_SHIFTS.get(text) : undefined;
    const x = text.drawX - (shift?.x ?? 0) + natural.x;
    for (const run of natural.runs) {
      const owner = boxAt.call(text.spans, run.start);
      if (!owner || !holds(inline, owner)) continue;
      // within the line: a space a line ends on hangs past it
      const from = Math.max(x, x + run.x);
      const to = Math.min(x + natural.width, x + run.x + run.width);
      if (to <= from) continue;
      left = Math.min(left, from);
      right = Math.max(right, to);
    }
  }
  for (const placed of line.atomics) {
    if (!holds(inline, placed.box)) continue;
    left = Math.min(left, placed.x - placed.box.marginLeft);
    right = Math.max(
      right,
      placed.x + placed.box.width + placed.box.marginRight,
    );
  }
  for (const edge of line.edges ?? []) {
    if (edge.box !== inline) {
      if (!holds(inline, edge.box)) continue;
      left = Math.min(left, edge.x);
      right = Math.max(right, edge.x + edge.width);
      continue;
    }
    // its own: the padding edge, inside the margin and the border
    const onLeft =
      (edge.side === 'start') !== (inline.style.direction === 'rtl');
    if (onLeft) {
      const at = edge.x + inline.marginLeft + (border ? 0 : inline.borderLeft);
      left = Math.min(left, at);
      right = Math.max(right, at);
    } else {
      const at =
        edge.x +
        edge.width -
        inline.marginRight -
        (border ? 0 : inline.borderRight);
      left = Math.min(left, at);
      right = Math.max(right, at);
    }
  }
  return left <= right ? [left, right] : null;
}

/**
 * How far up and down a line an inline box's fragment reaches: its face
 * about its own baseline, which `vertical-align` may raise off the line's,
 * and its padding, and its border where `border` says so. The whole line
 * where there is no face to ask.
 */
function fragmentRow(
  line: LineBox,
  inline: Box,
  face: InlineDecoration | null,
  border: boolean,
): [number, number] {
  if (!face) return [line.y, line.y + line.height];
  const baseline =
    line.y +
    line.baseline -
    (LINE_BOX_RAISES.get(line)?.get(inline) ?? BOX_RAISES.get(inline) ?? 0);
  return [
    baseline - face.ascent - inline.padTop - (border ? inline.borderTop : 0),
    baseline +
      face.descent +
      inline.padBottom +
      (border ? inline.borderBottom : 0),
  ];
}

/**
 * Lay out the floats in a block's inline content and give its positioned
 * boxes their static positions — at any depth of inline box, which lays
 * nothing out of its own: a float or an absolute box inside a `<span>` is
 * the paragraph's as much as one beside it. Met only among the block's own
 * children, one in an inline box was never laid out at all, and stood at
 * the page's corner with no size.
 */
/** Give the absolute boxes in a block's inline content their static
 *  position, and answer whether the content holds a float. */
function placeOutOfLine(
  parent: Box,
  block: Box,
  ctx: LayoutContext,
  contentTop: number,
  contentWidth: number,
  contentLeft: number,
): boolean {
  let floated = false;
  for (const child of parent.children) {
    if (child.outOfFlow) {
      placeStatic(child, block, contentLeft, contentWidth, contentTop);
      ctx.positioned.push({
        box: child,
        containing: containingBlockFor(child) ?? block,
      });
    } else if (child.isFloat) {
      floated = true;
    } else if (child.kind === 'inline' && ctx.nestedOutOfLine) {
      const inner = placeOutOfLine(
        child,
        block,
        ctx,
        contentTop,
        contentWidth,
        contentLeft,
      );
      floated ||= inner;
    }
  }
  return floated;
}

/** Where an out-of-flow box would have gone in its parent's flow: its
 *  margin edge's, at either side, kept from the parent's corner, which may
 *  yet move. */
function placeStatic(
  box: Box,
  parent: Box,
  x: number,
  width: number,
  y: number,
): void {
  box.staticPosition = {
    from: parent,
    x: x - parent.x,
    right: x + width - parent.x,
    y: y - parent.y,
  };
}

/**
 * An absolutely positioned child of a flex box or a grid, laid out once the
 * flow is: against its own containing block, which the box is only where
 * it is positioned, from where it is as the box's one item — at the start
 * of a flex box's content box (CSS Flexbox 4.1), of a grid's padding box
 * (CSS Grid 1, 9.1). Pushed against the box whatever it was, one in a
 * static flex box was placed from the box's corner, and `fixed` one from
 * a grid.
 */
export function positionOutOfFlow(
  child: Box,
  container: Box,
  ctx: LayoutContext,
  flex: boolean,
): void {
  if (flex) {
    placeStatic(
      child,
      container,
      container.contentX,
      container.contentWidth,
      container.contentY,
    );
  } else {
    placeStatic(
      child,
      container,
      container.x + container.borderLeft,
      container.width - container.borderLeft - container.borderRight,
      container.y + container.borderTop,
    );
  }
  child.staticPosition!.inside = {
    box: flex ? 'content' : 'padding',
    ...staticAlignment(child, container, flex),
  };
  ctx.positioned.push({
    box: child,
    containing: containingBlockFor(child) ?? container,
  });
}

/** How far along its free room a flex box's or a grid's one item is set:
 *  0 at the start, ½ in the middle, 1 at the end, across (from the inline
 *  start) and down. A flex box's main axis by `justify-content`, and the
 *  cross by `align-self`; a grid's by `justify-self` and `align-self`,
 *  each falling back to the container's `-items`. */
function staticAlignment(
  child: Box,
  container: Box,
  flex: boolean,
): { across: number; down: number } {
  const own = child.style;
  const style = container.style;
  const factor = (align: string): number =>
    align === 'flex-end' ? 1 : align === 'center' ? 0.5 : 0;
  const cross = factor(
    own.alignSelf === AUTO ? style.alignItems : own.alignSelf,
  );
  if (!flex) {
    const justify =
      own.justifySelf === 'auto' ? style.justifyItems : own.justifySelf;
    return { across: factor(justify), down: cross };
  }
  const justify = style.justifyContent;
  let main =
    justify === 'flex-end' || justify === 'end' || justify === 'right'
      ? 1
      : justify === 'center' ||
          justify === 'space-around' ||
          justify === 'space-evenly'
        ? 0.5
        : 0;
  if (style.flexDirection.endsWith('-reverse')) main = 1 - main;
  return style.flexDirection.startsWith('row')
    ? { across: main, down: cross }
    : { across: cross, down: main };
}

/** The nearest positioned ancestor, or null for the initial containing
 *  block. Walks the box tree rather than the DOM, so an anonymous box in
 *  between is transparent — which is what the spec means by "the nearest
 *  positioned ancestor". A box in the top layer has the root's, the
 *  viewport or the initial containing block, whatever is around it. */
function containingBlockFor(box: Box): Box | null {
  const fixed = box.style.position === 'fixed';
  let node = box.parent;
  if (box.topLayer) {
    while (node?.parent) node = node.parent;
    return node;
  }
  while (node) {
    if (containsOutOfFlow(node, fixed) || node.parent === null) return node;
    node = node.parent;
  }
  return null;
}

/**
 * Whether a box is the containing block of the boxes in it positioned out
 * of the flow: of the fixed ones (`fixed`), or of the absolute ones. A
 * fixed box's is the viewport, whatever is positioned around it — but a
 * transformed box is one for it too, and one with layout or paint
 * containment (CSS Containment 2, 3.3), and one a filter or `will-change`
 * makes one (`holdsOutOfFlow`). The initial containing block aside, which
 * is no box's.
 */
export function containsOutOfFlow(box: Box, fixed: boolean): boolean {
  return (
    (!fixed && box.style.position !== 'static') ||
    transformed(box.style) ||
    contained(box, CONTAIN_LAYOUT | CONTAIN_PAINT) ||
    holdsOutOfFlow(box, fixed)
  );
}

/** The size containments that hold a box's width: `size` and
 *  `inline-size`. */
const CONTAIN_WIDTH = CONTAIN_SIZE | CONTAIN_INLINE_SIZE;

export { containmentApplies };

/**
 * Whether a box has any of the containments `bits` names, as they apply
 * to it (CSS Containment 2, 3): none to an inline box that is no atomic
 * one, and none to a table's inner parts but a cell — nor size
 * containment to a table or a cell.
 */
export function contained(box: Box, bits: number): boolean {
  const set = box.style.contain & bits;
  return set !== 0 && containmentApplies(box, set);
}

/**
 * Whether a filter, or what `will-change` names, makes a box the containing
 * block of the fixed boxes in it (`fixed`), or of the absolute ones. A
 * filter makes any box one of both, an inline box as well (Filter Effects
 * 1, 2), and so does a backdrop filter (Filter Effects 2, 2). A name in `will-change` makes a box what a value of its property
 * would, on the boxes the property applies to (CSS Will Change 1, 2;
 * `WILL_CHANGES`) — a filter on any box, a transform on a box that is not
 * inline, containment where it applies, and `position`, every value of
 * which but `static` holds absolute boxes and none fixed ones.
 */
export function holdsOutOfFlow(box: Box, fixed: boolean): boolean {
  // a backdrop filter as a filter does (Filter Effects 2, 2)
  if (box.style.filter !== null || box.style.backdropFilter !== null) {
    return true;
  }
  const bits = box.style.willChange;
  if (!bits) return false;
  if (bits & WILL_HOLD_FIXED) return true;
  if (bits & WILL_HOLD_FIXED_BOX && box.kind !== 'inline') return true;
  if (
    bits & WILL_CONTAIN &&
    containmentApplies(box, CONTAIN_LAYOUT | CONTAIN_PAINT)
  ) {
    return true;
  }
  return !fixed && !!(bits & WILL_HOLD_ABSOLUTE);
}

/** Move a box and everything under it, keeping the subtree's shape. */
export function moveTo(box: Box, x: number, y: number): void {
  // A position only a probe of an unbounded width comes to — a column after
  // an infinitely wide one — is no place to move a box to: it stays where
  // it is, since the probe only wants its size, and the pass after moves it
  // from somewhere finite (see `placeBlock`).
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  translate(box, x - box.x, y - box.y);
}

/**
 * Move what a box holds down, and not the box: a table cell's content
 * sits where its `vertical-align` puts it, in a box that fills the row, and
 * a button's in the middle of its own (`centreButton`).
 *
 * The static positions the box gave the absolutely positioned boxes in its
 * flow go down with the content: each is where its box "would have been in
 * the normal flow" (CSS 2.1 10.6.4), and the flow is what moved. They are
 * kept from the box's own corner, which stays, so that moving the boxes
 * alone left them behind: a badge with no offsets in a `vertical-align:
 * middle` cell stood at the cell's top, over an icon 22px further down.
 *
 * It adds to where the content stands, so it is asked for once for each
 * layout of the box, which puts the content and the static positions back
 * at the top. A table lays a cell out and moves its content in one pass
 * over its cells, however many times a pass lays the table out, and one
 * whose layout is kept (`kept`) is moved whole, the cell with it; a button
 * counts how far down its content stands (`centreButton`).
 */
export function moveContent(box: Box, dy: number): void {
  if (!dy) return;
  translate(box, 0, dy);
  box.y -= dy;
  moveStatics(box, box, dy);
}

/** Whether a box is a `<button>`'s own, laid out as a block container: the
 *  one HTML's button layout sets an anonymous button content box in, as it
 *  does an input button's the page drew. Not the text in it, whose element
 *  is the button too; not a button that is a flex box or a grid, which has
 *  no such box. */
function isButtonBlock(box: Box): boolean {
  return (
    box.kind === 'block' &&
    box.el !== null &&
    (box.el.name === 'button' || isInputButton(box.el))
  );
}

/** How tall a `<button>`'s content came to, and how far down its content
 *  box it stands for being centred in it (`centreButton`). */
const BUTTON_CONTENT = new WeakMap<Box, { height: number; down: number }>();

/**
 * Centre a `<button>`'s content down its content box, where the box is the
 * taller: a button's content is in an anonymous box of its own that is
 * "centered vertically" where it "does not overflow in the vertical axis"
 * (HTML 15.5.5, button layout), and is at the top where it does. Blink
 * moves a button's children down by half the room left, clamped at none
 * (`AlignBlockContent`); set at the top as any block's is, the two lines of
 * a 60px sidebar picker on nextjs.org sat 4px high in it.
 *
 * Asked for when the button is laid out, and again wherever its height is
 * given to it afterwards — a flex or a grid item stretched to its line, or
 * put back to the height it was measured at, and an absolute box between
 * two offsets: the content moves by the difference from where it was last
 * put. A button that is a flex box or a grid has no such box, and its
 * content is where its own alignment puts it.
 */
export function centreButton(box: Box): void {
  if (!isButtonBlock(box)) return;
  const content = BUTTON_CONTENT.get(box);
  if (content === undefined) return;
  const down = Math.max(0, (box.contentHeight - content.height) / 2);
  const by = down - content.down;
  if (by === 0 || !Number.isFinite(by)) return;
  content.down = down;
  // and the static positions kept from its corner with it: a menu under a
  // button's label opens under the label, where the label went
  moveContent(box, by);
}

/** Move the static positions a block gave the absolutely positioned boxes
 *  in its flow, at any depth of inline box, which are kept from its own
 *  corner and not from its content's (`moveContent`). One from a box
 *  inside it is kept from that box's corner, which moved with the rest. */
function moveStatics(parent: Box, block: Box, dy: number): void {
  for (const child of parent.children) {
    if (child.outOfFlow) {
      if (child.staticPosition?.from === block) child.staticPosition.y += dy;
    } else if (child.kind === 'inline') moveStatics(child, block, dy);
  }
}

/** Move a box and all it holds, its lines and their text with it — but for
 *  the boxes `stays` names, and what they hold: what a scroll container
 *  scrolls is what it is the containing block of (`scroll.ts`). */
export function translate(
  box: Box,
  dx: number,
  dy: number,
  stays?: (box: Box) => boolean,
): void {
  if (!dx && !dy) return;
  box.x += dx;
  box.y += dy;
  // a list item's marker is placed in the same coordinates as its lines
  if (box.marker) {
    box.marker.x += dx;
    box.marker.y += dy;
  }
  // the pieces columns broke it in, which are kept beside it
  if (columned.any) {
    const pieces = COLUMN_PIECES.get(box);
    if (pieces) {
      for (const piece of pieces) {
        piece.x += dx;
        piece.y += dy;
        piece.wholeY += dy;
      }
    }
  }
  if (box.lines) {
    for (const line of box.lines) {
      line.x += dx;
      line.y += dy;
      for (const text of line.texts) {
        text.drawX += dx;
        text.drawY += dy;
      }
      for (const placed of line.atomics) {
        placed.x += dx;
        placed.y += dy;
      }
      for (const edge of line.edges ?? []) edge.x += dx;
    }
  }
  for (const child of box.children) {
    if (!stays?.(child)) translate(child, dx, dy, stays);
  }
}

/** Resolve the margin, border and padding edges against a containing width.
 *  Percentages on *every* one of them are of the containing block's width,
 *  vertical padding included — which surprises everyone once. */
export function resolveEdges(box: Box, containingWidth: number): void {
  const style = box.style;
  box.borderTop =
    style.borderTopStyle === 'none' || style.borderTopStyle === 'hidden'
      ? 0
      : style.borderTopWidth;
  box.borderRight =
    style.borderRightStyle === 'none' || style.borderRightStyle === 'hidden'
      ? 0
      : style.borderRightWidth;
  box.borderBottom =
    style.borderBottomStyle === 'none' || style.borderBottomStyle === 'hidden'
      ? 0
      : style.borderBottomWidth;
  box.borderLeft =
    style.borderLeftStyle === 'none' || style.borderLeftStyle === 'hidden'
      ? 0
      : style.borderLeftWidth;
  // at least zero: a `calc()` may come to less
  box.padTop = Math.max(0, edge(style.paddingTop, containingWidth));
  box.padRight = Math.max(0, edge(style.paddingRight, containingWidth));
  box.padBottom = Math.max(0, edge(style.paddingBottom, containingWidth));
  box.padLeft = Math.max(0, edge(style.paddingLeft, containingWidth));
  box.marginTop = edge(style.marginTop, containingWidth);
  box.marginRight = edge(style.marginRight, containingWidth);
  box.marginBottom = edge(style.marginBottom, containingWidth);
  box.marginLeft = edge(style.marginLeft, containingWidth);
  box.bottomStrut = null;
  // A table's parts but its caption have no margins, and its rows and row
  // groups no padding either (CSS 2.1 8.3, 8.4): a cell set `margin: 50px`
  // left a gap in its table that no browser draws. The values stay theirs,
  // for a cell to inherit (`padding: inherit`); they only do nothing here.
  if (
    box.kind === 'table-cell' ||
    box.kind === 'table-row' ||
    box.kind === 'table-row-group'
  ) {
    box.marginTop = 0;
    box.marginRight = 0;
    box.marginBottom = 0;
    box.marginLeft = 0;
    if (box.kind !== 'table-cell') {
      box.padTop = 0;
      box.padRight = 0;
      box.padBottom = 0;
      box.padLeft = 0;
    }
  }
  if (box.kind === 'table' || box.kind === 'table-cell') collapseEdges(box);
}

function edge(len: Len, containingWidth: number): number {
  if (len === AUTO) return 0;
  return resolve(len, containingWidth, 0);
}

/** Whether every in-flow child is inline-level, which is what makes this box
 *  an inline formatting context rather than a block one. */
function establishesInlineContext(box: Box): boolean {
  if (box.kind === 'table' || box.kind === 'flex') return false;
  let sawInline = false;
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    switch (child.kind) {
      case 'text':
      case 'inline':
      case 'break':
        sawInline = true;
        break;
      default:
        if (isInlineLevel(child)) sawInline = true;
        else return false;
        break;
    }
  }
  return sawInline;
}

export function isInlineLevel(box: Box): boolean {
  const d = box.style.display;
  return (
    d === 'inline' ||
    d === 'inline-block' ||
    d === 'inline-flex' ||
    d === 'inline-table' ||
    // an image told to be a table's part is inline (CSS Display 3, 2.4)
    (box.kind === 'replaced' && d.startsWith('table-'))
  );
}

/** Whether a box establishes a block formatting context — contains its own
 *  floats, and does not collapse margins through its edges. */
export function establishesBFC(box: Box): boolean {
  const style = box.style;
  if (scrolls(style)) return true;
  if (style.flowRoot) return true;
  // the root of a flow in another writing mode (CSS Writing Modes 4, 3.1)
  if (framed.any && FRAMES.has(box)) return true;
  // layout and paint containment make an independent formatting context,
  // and so does being a size container (CSS Conditional 5, 3.1), where
  // its containment applies
  if (contained(box, CONTAIN_LAYOUT | CONTAIN_PAINT)) return true;
  if (
    style.containerType !== 'normal' &&
    containmentApplies(box, CONTAIN_WIDTH)
  ) {
    return true;
  }
  // `continue: collapse` makes a block container a formatting context of
  // its own (CSS Overflow 4, 5.3)
  if (style.lineClamp !== null) return true;
  if (style.float !== 'none') return true;
  if (style.position === 'absolute' || style.position === 'fixed') return true;
  // a multicol container (CSS Multi-column 1, 2), and a box that spans
  // one's columns (6)
  if (style.columns && box.kind === 'block') return true;
  if (style.columnSpan && box.parent?.style.columns) return true;
  if (
    style.display === 'inline-block' ||
    style.display === 'flex' ||
    style.display === 'inline-flex'
  ) {
    return true;
  }
  if (
    box.kind === 'table-cell' ||
    box.kind === 'table-caption' ||
    box.kind === 'table'
  ) {
    return true;
  }
  // a flex item, and a grid's: each an independent formatting context, which
  // the margins of what it holds stay inside (CSS Flexbox 1, 4; CSS Grid 1,
  // 6.1)
  if (box.parent?.kind === 'flex' && !box.outOfFlow) return true;
  // The root element establishes the document's formatting context. Here it
  // is a box below the synthetic initial containing block, so it is named:
  // without it, <html>'s own margin collapsed with <body>'s first block's.
  if (box.el?.name === 'html') return true;
  // a button's content is in a formatting context of its own, the
  // anonymous button content box's (HTML 15.5.5), whatever its `display`
  if (isButtonBlock(box)) return true;
  // and the initial containing block, the root box — but not where it
  // stands in for a fragment's body, which is a block in the `<html>`
  // implied around it (`layoutDocument`)
  return box.parent === null && !STANDS_FOR_BODY.has(box);
}

/** Each box of a tree by where its layout ends, in a walk of it: what is
 *  in a box ends before it, and a box before another in the tree ends
 *  before it where neither holds the other. */
function finishOrder(root: Box): Map<Box, number> {
  const order = new Map<Box, number>();
  const stack: [Box, number][] = [[root, 0]];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const [box, next] = top;
    if (next < box.children.length) {
      top[1] = next + 1;
      stack.push([box.children[next], 0]);
    } else {
      order.set(box, order.size);
      stack.pop();
    }
  }
  return order;
}

/** Sort the positioned boxes from `from` to `to` by where the layouts of
 *  their containing blocks end (`finishOrder`), keeping the order they
 *  were found in for one containing block. */
function inFinishOrder(
  list: { box: Box; containing: Box }[],
  from: number,
  finish: Map<Box, number>,
  to = list.length,
): void {
  if (to - from < 2) return;
  const part = list.slice(from, to);
  part.sort(
    (a, b) =>
      (finish.get(a.containing) ?? finish.size) -
      (finish.get(b.containing) ?? finish.size),
  );
  for (let i = 0; i < part.length; i += 1) list[from + i] = part[i];
}

/** The root boxes that stand in for a fragment's `<body>` (`BoxTree.impliedHtml`):
 *  blocks in the formatting context of the `<html>` around them, which has no
 *  box, rather than its root. Marked as each is laid out. */
const STANDS_FOR_BODY = new WeakSet<Box>();

/** What a box's `position: relative` offset moves it by, applied after
 *  layout so it does not affect anything else's position — which is the
 *  whole of what makes it *relative* — and its translation with it, and
 *  where `position: sticky` puts one at rest (`stickyOffset`). Given
 *  `moved`, only down the boxes in it (`Blockers.moved`). */
export function applyRelativeOffsets(
  box: Box,
  viewportWidth: number,
  viewportHeight: number,
  fonts: FontsLike | null,
  moved?: ReadonlySet<Box>,
): void {
  for (const child of box.children) {
    if (moved && !moved.has(child)) continue;
    applyRelativeOffsets(child, viewportWidth, viewportHeight, fonts, moved);
  }
  // a text or a break carries its element's style, and moves with it
  if (box.kind === 'text' || box.kind === 'break') return;
  const style = box.style;
  if (transformed(style) && box.kind !== 'inline') {
    // a transform moves the box it is on, and an inline box is none —
    // and what it holds but for what is in the top layer, which nothing
    // around it moves
    const [dx, dy] = translationOf(box);
    if (dx || dy) {
      translate(box, dx, dy, inTopLayer);
      movedOffLine(box);
    }
  }
  if (style.position !== 'relative' && style.position !== 'sticky') return;
  const sticky = style.position === 'sticky';
  if (box.kind === 'inline') {
    // a sticky box's first piece places them all, and has moved this one
    if (sticky && box.cut & 1) return;
    // the lines under it are where no offset of it has them
    INLINE_OFFSETS.delete(box);
    if (sticky) setStickyRect(box, fonts);
  }
  const [dx, dy] = sticky
    ? stickyOffset(box, viewportWidth, viewportHeight)
    : relativeOffset(box);
  if (sticky) noteStuck(box, dx, dy);
  if (!(dx || dy)) return;
  if (sticky) {
    moveSticky(box, dx, dy);
    return;
  }
  offsetBox(box, dx, dy, false);
  if (box.kind !== 'inline') {
    movedOffLine(box);
    return;
  }
  offsetInline(box, dx, dy);
  // the blocks it was broken around move with it (9.2.1.1)
  const blocks = box.cut ? CUT_BLOCKS.get(box) : undefined;
  if (blocks) for (const block of blocks) offsetBox(block, dx, dy, false);
}

/** Note how far stickiness moved a box from where the flow has it, and an
 *  inline box broken around blocks all its pieces. */
function noteStuck(box: Box, dx: number, dy: number): void {
  const at: [number, number] = [dx, dy];
  STUCK.set(box, at);
  if (box.cut) {
    for (const piece of CUT_PIECES.get(box) ?? []) STUCK.set(piece, at);
  }
}

/** Move a sticky box and all that goes with it: a box and what it holds, or
 *  an inline box's text on its lines, and what it was broken around, its
 *  pieces and its blocks alike, as one (9.2.1.1). */
function moveSticky(box: Box, dx: number, dy: number): void {
  offsetBox(box, dx, dy, true);
  followSticky(box, dx, dy);
  if (box.kind !== 'inline') {
    movedOffLine(box);
    return;
  }
  offsetInline(box, dx, dy);
  if (!box.cut) return;
  for (const piece of CUT_PIECES.get(box) ?? []) {
    offsetBox(piece, dx, dy, true);
    offsetInline(piece, dx, dy);
  }
  for (const block of CUT_BLOCKS.get(box) ?? []) {
    offsetBox(block, dx, dy, true);
  }
}

/** Whether a box is in the top layer, which no box around it moves. */
const inTopLayer = (box: Box): boolean => box.topLayer;

/**
 * Move what a relative or a sticky offset moves: a box and all it holds,
 * but for a box fixed to something outside it — the viewport, or a
 * transformed box it is in — which is positioned against that and not
 * against what holds it. A relative offset moves such a box only along an
 * axis it has no inset on, where it is at its static position, and a
 * sticky one along neither, as Chrome has both. Moved with the header it
 * is in as the header stuck, and to the viewport as well, docs.github.com's
 * search dialog went down the window as the page went up. Only a fixed box
 * is asked about: an absolute box in a relative or a sticky one is
 * positioned against it, and in a block that broke an inline box in pieces
 * (`CUT_BLOCKS`) stands outside the box in the tree but not in the flow.
 * And a box in the top layer, which is at no place in the flow of what
 * holds it, and is moved by no offset of its (CSS Position 4, 3.1).
 */
function offsetBox(box: Box, dx: number, dy: number, sticky: boolean): void {
  const fixed: Box[] = [];
  translate(box, dx, dy, (child) => {
    if (child.topLayer) return true;
    if (child.style.position !== 'fixed') return false;
    if (!positionedOutside(child, box)) return false;
    fixed.push(child);
    return true;
  });
  if (sticky) return;
  for (const child of fixed) {
    const style = child.style;
    const sx = style.left === AUTO && style.right === AUTO ? dx : 0;
    const sy = style.top === AUTO && style.bottom === AUTO ? dy : 0;
    if (sx || sy) offsetBox(child, sx, sy, false);
  }
}

// what makes a box a containing block and a layer, as a positioned box is,
// is asked here by the layouts beside this one
export { transformed };

/** How far a box's transform moves it — `translate`, and the translation
 *  its `transform` comes to with its turns and scales: a percentage is of
 *  its own border box (CSS Transforms 1, 7). The rest of the transform is
 *  paint's (`placedMatrix`). */
export function translationOf(box: Box, style = box.style): [number, number] {
  if (!transformed(style)) return [0, 0];
  const m = matrixOf(style, box.width, box.height);
  return [m[4], m[5]];
}

/**
 * The matrix a box is painted through, in the document's coordinates: what
 * its transform does besides move it — a turn, a scale, a skew — about its
 * `transform-origin`, where layout has put it (`applyRelativeOffsets`). Null
 * for a box that only moves across and down, which is every box but a
 * few, and for an inline box, which no transform applies to (CSS
 * Transforms 1, 2: a transformable element is no inline box). A transform
 * out of the plane — a move toward the viewer among it — comes to what the
 * box's plane does through it, seen in its containing block's
 * `perspective` (`projectedMatrix`).
 */
export function placedMatrix(box: Box): Placed | null {
  const style = box.style;
  if (!drawnThrough(style)) return null;
  if (box.kind === 'inline' || box.kind === 'text' || box.kind === 'break') {
    return null;
  }
  const solid = outOfPlane(style);
  const linear = solid ? null : linearOf(style);
  if (!solid && !linear) return null;
  const origin = style.transformOrigin;
  const ox = box.x + resolve(origin[0], box.width, 0);
  const oy = box.y + resolve(origin[1], box.height, 0);
  return linear ? about(linear, ox, oy) : projectedMatrix(box, ox, oy);
}

/** A matrix that flattens the plane to nothing, which draws nothing and is
 *  under no point. */
const NOWHERE: Placed = [0, 0, 0, 0, 0, 0];

/**
 * `placedMatrix` for a transform out of the plane (CSS Transforms 2, 6): its
 * 4×4 less the translation layout moved the box by, about the origin where
 * layout put it — the depth of `transform-origin` with it — and in the
 * perspective of the box it is laid out in where that has one
 * (`perspectiveFor`), from that box's `perspective-origin`. What the box's
 * plane comes to through that is a projection, which is a matrix of the
 * plane where all of it is as far from the viewer as any of it — no
 * perspective, or none it is turned in — and draws the side that goes away
 * smaller where it is not. A box wholly behind the viewer is nowhere, and
 * so is one turned to face away from it under `backface-visibility:
 * hidden` — by its own transform and the perspective, since what a box
 * holds is flattened into its plane (`transform-style: flat`).
 */
function projectedMatrix(box: Box, ox: number, oy: number): Placed | null {
  const style = box.style;
  const m = matrix4Of(style, box.width, box.height)!;
  const [tx, ty] = translation4(m);
  const oz = style.transformOriginZ;
  let placed = multiply4(
    translate4(ox, oy, oz),
    multiply4(multiply4(translate4(-tx, -ty, 0), m), translate4(-ox, -oy, -oz)),
  );
  const seen = perspectiveAround(box);
  if (seen) placed = multiply4(seen, placed);
  if (style.backfaceVisibility === 'hidden' && facesAway(placed)) {
    return NOWHERE;
  }
  const p = projectionOf(placed);
  // the furthest any corner of the box is: none in front of the viewer, and
  // nothing of it is seen
  let most = -Infinity;
  for (const [x, y] of [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ]) {
    most = Math.max(most, p[6] * x + p[7] * y + p[8]);
  }
  if (!(most > 0)) return NOWHERE;
  if (!projectionIsAffine(p)) {
    return p.map((v) => v / most) as unknown as Projection;
  }
  const a = affineOf(p);
  const near = (u: number, v: number) => Math.abs(u - v) < 1e-9;
  return near(a[0], 1) &&
    near(a[1], 0) &&
    near(a[2], 0) &&
    near(a[3], 1) &&
    near(a[4], 0) &&
    near(a[5], 0)
    ? null
    : a;
}

/**
 * The perspective a box's transform is seen in (`perspectiveFor`), as a
 * 4×4 in the document's coordinates: that box's `perspective`, from its
 * `perspective-origin` where layout put it. Null where there is none. What
 * the document draws a box out of the plane through (`projectedMatrix`),
 * and what a layer that carries one is turned through
 * (`src/html/sprites.ts`).
 */
export function perspectiveAround(box: Box): Mat4 | null {
  const holder = perspectiveFor(box);
  if (!holder) return null;
  const at = holder.style.perspectiveOrigin;
  const px = holder.x + resolve(at[0], holder.width, 0);
  const py = holder.y + resolve(at[1], holder.height, 0);
  return multiply4(
    multiply4(translate4(px, py, 0), perspective4(holder.style.perspective!)),
    translate4(-px, -py, 0),
  );
}

/**
 * The box whose `perspective` a box's transform is seen in: the nearest
 * with one up its containing blocks — the box it is positioned in, for one
 * out of the flow, and its parent for one in it (CSS Transforms 2, 6) —
 * through boxes positioned and not transformed, as Blink hangs a box's
 * transform under the perspective of the nearest box above it that has
 * one. Not past a box with a transform of its own: what that holds is
 * flattened into its plane (`transform-style: flat`), which its own
 * transform is all the perspective around it sees of. No inline box's.
 * Null where there is none.
 */
function perspectiveFor(box: Box): Box | null {
  for (let at = holderOf(box); at; at = holderOf(at)) {
    // an inline box is not transformable, and has no rectangle to be seen
    // from (CSS Transforms 1, 2)
    if (at.kind === 'inline') continue;
    const style = at.style;
    if (style.perspective !== null) return at;
    if (
      style.transform !== null ||
      style.translate !== null ||
      style.rotate !== null ||
      style.scale !== null
    ) {
      return null;
    }
  }
  return null;
}

/** The box a box's transform is placed in (`perspectiveFor`): the one it is
 *  positioned in, out of the flow, and its parent in it. */
function holderOf(box: Box): Box | null {
  const position = box.style.position;
  return position === 'absolute' || position === 'fixed'
    ? containingBlockFor(box)
    : box.parent;
}

/**
 * Move a laid-out box, and everything in it, by how far its translation
 * changed when its style went from `was` to the one it has — what
 * `applyRelativeOffsets` moves it by now, less what it moved it by then.
 * For a style changed in place, where nothing else moves (a `transform` is
 * what makes that true). Not for an inline box, whose text is what moves.
 */
export function retranslate(box: Box, was: ComputedStyle): void {
  const [x0, y0] = translationOf(box, was);
  const [x1, y1] = translationOf(box);
  if (x1 === x0 && y1 === y0) return;
  translate(box, x1 - x0, y1 - y0);
  movedOffLine(box);
}

/** How far `position: relative` moves a box. */
function relativeOffset(box: Box): [number, number] {
  const style = box.style;
  const parentWidth = box.parent ? box.parent.contentWidth : 0;
  const left = resolveOrNull(style.left, parentWidth);
  const right = resolveOrNull(style.right, parentWidth);
  // a percentage down is of a height the containing block sets, as a
  // percentage height is, and `auto` where its content decides it
  const top = resolveOrNull(style.top, box.percentHeightBase);
  const bottom = resolveOrNull(style.bottom, box.percentHeightBase);
  // both set is over-constrained, and the containing block's direction
  // says which wins: `left` left to right, `right` right to left (9.4.3)
  const rtl = box.parent?.style.direction === 'rtl';
  const dx = right !== null && (left === null || rtl) ? -right : (left ?? 0);
  const dy = top ?? (bottom !== null ? -bottom : 0);
  return [dx, dy];
}

/** An inset as `getComputedStyle` answers it: a length in device pixels,
 *  `auto`, or null where the computed value is the answer. */
export type ResolvedInset = number | 'auto' | null;

/**
 * The insets `getComputedStyle` answers for a positioned box: the used
 * values (CSSOM 9, "resolved value"), top, right, bottom and left. A
 * relative box's are its offsets, each side its own where it is set and
 * the negation of the side opposite where it is `auto`; a sticky box's
 * keep `auto`, and a percentage resolves. An absolute or a fixed box's are
 * where layout put its margin box in its containing block's padding box —
 * an `anchor()`, a `position-area` and a fallback included — but on an
 * axis both of whose insets are lengths, which may be over-constrained and
 * are then their computed values, a percentage resolved. Null for a box
 * that is not positioned, or is placed in an inline box.
 */
export function resolvedInsets(
  box: Box,
  viewportWidth: number,
  viewportHeight: number,
): ResolvedInset[] | null {
  const style = box.style;
  const { position } = style;
  if (position === 'static') return null;
  const sides = [style.top, style.right, style.bottom, style.left];
  if (position === 'relative' || position === 'sticky') {
    const across = box.parent ? box.parent.contentWidth : 0;
    const set = sides.map((len, i) =>
      resolveOrNull(len, i % 2 ? across : box.percentHeightBase),
    );
    if (position === 'sticky') {
      return set.map((v, i) => (sides[i] === AUTO ? 'auto' : v));
    }
    return set.map((v, i) => {
      if (v !== null) return v;
      // a percentage of an indefinite height is the computed value
      if (sides[i] !== AUTO) return null;
      const opposite = set[(i + 2) % 4];
      return opposite === null ? 0 : -opposite;
    });
  }
  const containing = containingBlockFor(box);
  if (!containing || containing.kind === 'inline') return null;
  const cb = paddingRectOf(containing, viewportWidth, viewportHeight, true);
  // where layout placed them, before a scroll moved either: a scroll
  // moves a box back by its offset, which is added back
  const [bx, by] = scrolledBy(box);
  const [cx, cy] = containing.parent ? scrolledBy(containing) : [0, 0];
  const top = box.y + by - box.marginTop - (cb.y + cy);
  const left = box.x + bx - box.marginLeft - (cb.x + cx);
  const used = [
    top,
    cb.width - left - box.marginLeft - box.width - box.marginRight,
    cb.height - top - box.marginTop - box.height - box.marginBottom,
    left,
  ];
  const anchored = style.anchorInsets;
  const lengths = (i: number): boolean =>
    sides[i] !== AUTO &&
    !anchored?.[INSET_SIDES[i]] &&
    sides[i + 2] !== AUTO &&
    !anchored?.[INSET_SIDES[i + 2]];
  return used.map((v, i) => {
    const axis = i % 2;
    if (!lengths(axis)) return v;
    return resolveOrNull(sides[i], axis ? cb.width : cb.height) ?? v;
  });
}

const INSET_SIDES = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Where `position: sticky` puts a box at rest (CSS Positioned Layout 3,
 * 3.4): moved only as far as keeps its border box inside the sticky view
 * rectangle — its nearest scroll container's scrollport, scrolled to its
 * start, less its insets — and no further than keeps its margin box in its
 * containing block, `top` winning over `bottom` and the start side over the
 * end. Nothing here scrolls a box the document holds, so for one of those
 * this is where the box stays until `restickAll` places it again. Against
 * the viewport only its `top` and its start side are kept, which put a box
 * where a browser starts it, scrolled to the top: the element places it
 * again where the pane around it is scrolled to (`restickToViewport`), and
 * where nothing scrolls the element, this is where it stays. Taken as
 * `relative`, a box stood its `top` below where a browser starts it:
 * Wikipedia's contents, 24px low.
 */
function stickyOffset(
  box: Box,
  viewportWidth: number,
  viewportHeight: number,
): [number, number] {
  const style = box.style;
  // the scroll container a sticky box keeps to: the nearest box that
  // scrolls, or the viewport, whose are the root's and the body's overflow
  let port = box.parent;
  while (port && !scrolls(port.style)) port = port.parent;
  const tag = port?.el?.name;
  const inside = !!port && tag !== 'html' && tag !== 'body';
  const cb = stickyContainer(box);
  const size = stickySizeOf(box);
  if (!cb || !size) return [0, 0];
  // its own transform has moved it, and none around it has yet: this pass
  // comes up from the leaves (`movedByTransforms`)
  const [tx, ty] = movedByTransforms(box, box.parent);
  // the scrollport, at its start: a scroll container's padding box, or
  // the viewport, which the document's top is at
  const px = port && inside ? port.x + port.borderLeft : 0;
  const py = port && inside ? port.y + port.borderTop : 0;
  const pw =
    port && inside
      ? port.width - port.borderLeft - port.borderRight
      : viewportWidth;
  const ph =
    port && inside
      ? port.height - port.borderTop - port.borderBottom
      : viewportHeight;
  const dx = stuck(
    box.x - tx,
    size.width,
    box.marginLeft,
    box.marginRight,
    cb.contentX,
    cb.contentWidth,
    px,
    pw,
    resolveOrNull(style.left, pw),
    inside ? resolveOrNull(style.right, pw) : null,
    // `left` wins where both hold, or `right` in a right-to-left block
    cb.style.direction !== 'rtl',
  );
  const dy = stuck(
    box.y - ty,
    size.height,
    ownMarginTop(box, cb),
    ownMarginBottom(box, cb),
    cb.contentY,
    cb.contentHeight,
    py,
    ph,
    resolveOrNull(style.top, ph),
    inside ? resolveOrNull(style.bottom, ph) : null,
    true,
  );
  return [dx, dy];
}

/**
 * How far the transforms of a box and of the boxes around it have moved it
 * (`applyRelativeOffsets`), up to `stop` and not `stop`'s. Stickiness is
 * layout's and a transform moves what layout placed, so a sticky box is
 * measured from where it would be with none, as all three engines measure
 * it, and its transform is added to where it sticks. Measured from where the
 * transform had it, stickiness took the transform back: a header stuck to
 * the top with `translateY(-100%)` to hide it stayed in view, and one moved
 * in place went by the difference and stuck by what it stuck by before, so
 * it came to rest somewhere no layout would put it.
 */
function movedByTransforms(box: Box, stop: Box | null): [number, number] {
  let x = 0;
  let y = 0;
  for (let at: Box | null = box; at && at !== stop; at = at.parent) {
    if (at.kind !== 'inline' && transformed(at.style)) {
      const [dx, dy] = translationOf(at);
      x += dx;
      y += dy;
    }
  }
  return [x, y];
}

/**
 * The containing block a sticky box keeps inside: the nearest block around
 * it, past the inline boxes between and an anonymous block the fix-up put
 * it in, which no page wrote, as Chrome and WebKit have it. In one, a span
 * beside a block had a line's height to move in. A frame is an anonymous
 * block too, and is where it is laid out: past it is another's axes.
 */
function stickyContainer(box: Box): Box | null {
  let cb = box.parent;
  while (
    cb &&
    (cb.kind === 'inline' ||
      (cb.parent &&
        !cb.el &&
        !cb.pseudo &&
        !(framed.any && FRAME_ROOTS.has(cb))))
  ) {
    cb = cb.parent;
  }
  return cb;
}

/**
 * Set a sticky inline box's rect from its lines, where the flow has it. No
 * layout sets an inline box's rect, and every move adds up on it (`translate`),
 * so it said nothing of where the box is, and how far a box stuck turned on
 * how many layouts had run. It is as paint and `elementRect` find the box,
 * and as Chrome and WebKit take it: around its own fragments' border boxes,
 * so a line taller than its face or an image hanging off it reach past it,
 * with what it was broken around in it. A relative offset of a box inside it
 * is no part of it. Its place is the box's `x` and `y`, and from here it
 * moves as a block's does: with the lines under it, and by what `STUCK` says,
 * which `placeSticky` reads it back by. Its size is kept beside it
 * (`STICKY_SIZES`), since a box with one paints as a rectangle.
 */
function setStickyRect(box: Box, fonts: FontsLike | null): void {
  const pieces = box.cut ? CUT_PIECES.get(box) : undefined;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const take = (x: number, y: number, right: number, bottom: number): void => {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, right);
    y2 = Math.max(y2, bottom);
  };
  for (const piece of pieces ? [box, ...pieces] : [box]) {
    INLINE_OFFSETS.delete(piece);
    let block = piece.parent;
    while (block && block.kind === 'inline') block = block.parent;
    const face = fonts ? faceExtentOf(fonts, piece.style) : null;
    for (const line of block?.lines ?? []) {
      const span = spanOn(line, piece, true);
      if (!span) continue;
      const [top, bottom] = fragmentRow(line, piece, face, true);
      take(span[0], top, span[1], bottom);
    }
  }
  if (pieces) {
    for (const block of CUT_BLOCKS.get(box) ?? []) {
      take(block.x, block.y, block.x + block.width, block.y + block.height);
    }
  }
  if (x2 < x1) {
    STICKY_SIZES.delete(box);
    return;
  }
  box.x = x1;
  box.y = y1;
  STICKY_SIZES.set(box, { width: x2 - x1, height: y2 - y1 });
}

/** How large a sticky box's rect is: none for an inline box with nothing on
 *  its lines, which has no fragment to hold and draws nothing. */
function stickySizeOf(box: Box): { width: number; height: number } | undefined {
  return box.kind === 'inline' ? STICKY_SIZES.get(box) : box;
}

/** A sticky box's top margin, which keeps it inside its containing block
 *  as its bottom one does: an inline box's takes no room on its line, and no
 *  layout resolves it, and it counts here all the same in Chrome and WebKit. */
function ownMarginTop(box: Box, cb: Box): number {
  return box.kind === 'inline'
    ? edge(box.style.marginTop, cb.contentWidth)
    : box.marginTop;
}

/**
 * A sticky box's own bottom margin, which every engine keeps it inside its
 * containing block by: not the margin a last child takes through its foot
 * (`bottomStrut`), which the box carries for its next sibling to collapse
 * with, and an inline box's, which no layout resolves (`ownMarginTop`).
 * github.blog's contents list ends on an item with a 64px bottom margin,
 * and held by it the list stopped 64px above the end of its sidebar.
 */
function ownMarginBottom(box: Box, cb: Box): number {
  return box.bottomStrut || box.kind === 'inline'
    ? edge(box.style.marginBottom, cb.contentWidth)
    : box.marginBottom;
}

/**
 * How far a sticky box moves along one axis: toward the end until its
 * start edge is `start` inside the scrollport's, or toward the start until
 * its end edge is `end` inside the scrollport's, each no further than its
 * margin box stays in its containing block — and where both would move
 * it, `startWins` says which does.
 */
function stuck(
  at: number,
  size: number,
  marginStart: number,
  marginEnd: number,
  cbAt: number,
  cbSize: number,
  portAt: number,
  portSize: number,
  start: number | null,
  end: number | null,
  startWins: boolean,
): number {
  let byStart = 0;
  if (start !== null && Number.isFinite(start) && at < portAt + start) {
    const room = cbAt + cbSize - (at + size + marginEnd);
    byStart = Math.max(0, Math.min(portAt + start - at, room));
  }
  let byEnd = 0;
  if (end !== null && Number.isFinite(end)) {
    const over = at + size - (portAt + portSize - end);
    const room = at - marginStart - cbAt;
    if (over > 0) byEnd = -Math.max(0, Math.min(over, room));
  }
  return startWins ? byStart || byEnd : byEnd || byStart;
}

/**
 * Place the sticky boxes a scroll container keeps again, where it is
 * scrolled to (CSS Positioned Layout 3, 3.4): each one whose nearest scroll
 * container it is. Answers whether one moved. A scroll moves the content,
 * sticky boxes with it (`scroll.ts`), and this moves them back as far as
 * their insets say: a header stuck to the top of a scrolling list stays at
 * its top until its containing block leaves.
 */
export function restickWithin(scroller: Box): boolean {
  let moved = false;
  const visit = (box: Box): void => {
    for (const child of box.children) {
      if (child.style.position === 'sticky' && stickyBox(child)) {
        if (restick(child, scroller)) moved = true;
      }
      // a scroll container inside keeps its own
      if (!isScroller(child)) visit(child);
    }
  };
  visit(scroller);
  return moved;
}

/** `restickWithin` for every scroll container in a tree: after a layout,
 *  which placed each sticky box as though its container were scrolled to
 *  its start. Answers the sticky boxes the viewport keeps, in tree order,
 *  an outer one ahead of one in it — but for one in a box fixed to the
 *  viewport, which no scroll of it moves. Given `moved`, only down the
 *  boxes in it (`Blockers.moved`), where every sticky box is. */
function restickAll(root: Box, moved?: ReadonlySet<Box>): Box[] | null {
  let viewport: Box[] | null = null;
  const visit = (box: Box, port: Box | null, fixed: boolean): void => {
    for (const child of box.children) {
      if (moved && !moved.has(child)) continue;
      if (child.style.position === 'sticky' && stickyBox(child)) {
        if (port) restick(child, port);
        else if (!fixed) (viewport ??= []).push(child);
      }
      visit(
        child,
        isScroller(child) ? child : port,
        fixed || (port === null && fixedToViewport(child)),
      );
    }
  };
  visit(root, null, false);
  return viewport;
}

/** Whether a box whose style is sticky is one a scroll places again: not a
 *  text or a break, which carries its element's style and is no box of its
 *  own — taken for one, a sticky element's text was placed at where its
 *  rect had drifted to, and the ink of every box around it grown to reach
 *  it — nor an inline box with no rect, or a piece of one its first piece
 *  moves. */
function stickyBox(box: Box): boolean {
  if (box.kind === 'text' || box.kind === 'break') return false;
  return !(box.cut & 1) && stickySizeOf(box) !== undefined;
}

/** The sticky boxes each tree's viewport keeps (`restickAll`): placed at
 *  rest by the layout (`stickyOffset`), and again by the element where the
 *  pane around it is scrolled to (`restickToViewport`). */
export const VIEWPORT_STICKY = new WeakMap<object, readonly Box[]>();

const HELD_SETS = new WeakMap<readonly Box[], ReadonlySet<Box>>();

/** The sticky boxes a tree's viewport keeps, as a set. */
export function heldSet(tree: object): ReadonlySet<Box> | null {
  const held = VIEWPORT_STICKY.get(tree);
  if (!held?.length) return null;
  let set = HELD_SETS.get(held);
  if (!set) HELD_SETS.set(held, (set = new Set(held)));
  return set;
}

/**
 * How far the sticky boxes the viewport keeps have moved a box from where
 * the flow has it, in device pixels: what a scroll of the pane around the
 * element moves it by, and lays nothing out. Zero for a box in one that
 * only scrolls with the text; null for a box in none, and for one that
 * goes with none of them (`offsetBox`): in the top layer, or fixed to
 * something outside them. `scaleAround` says how large a sticky box's
 * offset is drawn, for what is placed where the box is drawn rather than
 * where it was laid out (`scaleAround` in `paint.ts`).
 */
export function heldShift(
  tree: object,
  box: Box,
  scaleAround?: (sticky: Box) => number,
): { x: number; y: number } | null {
  const kept = heldSet(tree);
  if (!kept) return null;
  let shift: { x: number; y: number } | null = null;
  let fixed: Box | null = null;
  for (let at: Box | null = box; at && !at.topLayer; at = at.parent) {
    if (kept.has(at) && !(fixed && positionedOutside(fixed, at))) {
      const stuck = STUCK.get(at);
      shift ??= { x: 0, y: 0 };
      if (stuck) {
        const k = scaleAround?.(at) ?? 1;
        shift.x += k * stuck[0];
        shift.y += k * stuck[1];
      }
    }
    if (at.style.position === 'fixed') fixed = at;
  }
  return shift;
}

/** The trees whose next layout answers a question about their size —
 *  core's content floors, at a fraction of the width they are drawn at —
 *  which keeps no anchored box's last position option (`LAST_POSITIONS`):
 *  no frame draws it there. */
const QUESTIONS = new WeakSet<BoxTree>();

/** Say whether a tree's next layout answers a question about its size. */
export function layoutAsks(tree: BoxTree, asks: boolean): void {
  if (asks) QUESTIONS.add(tree);
  else QUESTIONS.delete(tree);
}

/**
 * Place the sticky boxes the viewport keeps (`VIEWPORT_STICKY`) against
 * its scrollport where the pane around the element has scrolled the
 * document to — `port`, in the document's coordinates — as `restick`
 * places one against a scroll container in the document. A layout placed
 * them as though the document were at its top, and the pane's scroll moves
 * no box, so without this a contents list `top: 80px` scrolled away with
 * the article beside it, where a browser keeps it below the page's header.
 * Both insets of an axis hold here, as they do in a scroll container: the
 * scroll is known, so a `bottom: 0` keeps a footer at the foot of what is
 * seen, and goes with its containing block. Answers the boxes that moved.
 */
export function restickToViewport(
  boxes: readonly Box[],
  port: { x: number; y: number; width: number; height: number },
): Box[] | null {
  let moved: Box[] | null = null;
  for (const box of boxes) {
    const cb = stickyContainer(box);
    if (!cb) continue;
    const at = placeSticky(
      box,
      cb,
      null,
      port.x,
      port.y,
      port.width,
      port.height,
      cb.contentX,
      cb.contentY,
      cb.contentWidth,
      cb.contentHeight,
    );
    if (at) (moved ??= []).push(box);
  }
  return moved;
}

/** A sticky box placed again against the scrollport of its scroll
 *  container, as `stickyOffset` places it, where the container is
 *  scrolled to; whether it moved. */
function restick(box: Box, port: Box): boolean {
  const cb = stickyContainer(box);
  if (!cb) return false;
  // the containing block where it is the scroll container is all it
  // scrolls, from where the scroll has its start
  let cbx = cb.contentX;
  let cby = cb.contentY;
  let cbw = cb.contentWidth;
  let cbh = cb.contentHeight;
  if (cb === port) {
    const state = scrollStateOf(port);
    cbx -= state.x;
    cby -= state.y;
    cbw = Math.max(cbw, state.width - port.padLeft - port.padRight);
    cbh = Math.max(cbh, state.height - port.padTop - port.padBottom);
  }
  return placeSticky(
    box,
    cb,
    port,
    port.x + port.borderLeft,
    port.y + port.borderTop,
    port.width - port.borderLeft - port.borderRight,
    port.height - port.borderTop - port.borderBottom,
    cbx,
    cby,
    cbw,
    cbh,
  );
}

/** A sticky box placed against a scrollport (`px`…`ph`) within its
 *  containing block (`cbx`…`cbh`), from where the flow has it: that far
 *  less from where it is now (`STUCK`), and less what transforms moved
 *  (`movedByTransforms`) — those that moved it alone, and those that moved
 *  its containing block with it but not the scrollport of `scroller`, or of
 *  the viewport for none. Whether it moved. */
function placeSticky(
  box: Box,
  cb: Box,
  scroller: Box | null,
  px: number,
  py: number,
  pw: number,
  ph: number,
  cbx: number,
  cby: number,
  cbw: number,
  cbh: number,
): boolean {
  const size = stickySizeOf(box);
  if (!size) return false;
  const was = STUCK.get(box) ?? [0, 0];
  const style = box.style;
  const [ownX, ownY] = movedByTransforms(box, cb);
  const [withX, withY] = movedByTransforms(cb, scroller);
  const dx = stuck(
    box.x - was[0] - ownX - withX,
    size.width,
    box.marginLeft,
    box.marginRight,
    cbx - withX,
    cbw,
    px,
    pw,
    resolveOrNull(style.left, pw),
    resolveOrNull(style.right, pw),
    cb.style.direction !== 'rtl',
  );
  const dy = stuck(
    box.y - was[1] - ownY - withY,
    size.height,
    ownMarginTop(box, cb),
    ownMarginBottom(box, cb),
    cby - withY,
    cbh,
    py,
    ph,
    resolveOrNull(style.top, ph),
    resolveOrNull(style.bottom, ph),
    true,
  );
  const mx = dx - was[0];
  const my = dy - was[1];
  noteStuck(box, dx, dy);
  if (!mx && !my) return false;
  moveSticky(box, mx, my);
  return true;
}

/** Move what is anchored to a sticky box, or to something in it, as far
 *  as its stickiness moved it, on the axes each follows its anchor on
 *  (`anchoredWith`): a box anchored below a header stuck to the top of a
 *  list stays below it. */
function followSticky(box: Box, dx: number, dy: number): void {
  if (box.kind === 'inline') return;
  for (const { box: anchored, x, y } of anchoredWith(box)) {
    if (!(x && dx) && !(y && dy)) continue;
    translate(anchored, x ? dx : 0, y ? dy : 0, () => false);
    movedOffLine(anchored);
  }
}

/**
 * Move an inline box's text where `position: relative` or `sticky` puts the
 * box. Its text is on its block's lines, laid out apart from the text
 * around it (`collect`), and those fragments are what move; the lines stay
 * where they are (CSS 2.1 9.4.3). A box inside it has moved its own
 * already, so a text in both moves by the two together. Moves add up, as
 * they do on the text, since a scroll moves a sticky box from where it was
 * held: `applyRelativeOffsets` starts them from nothing.
 */
function offsetInline(box: Box, dx: number, dy: number): void {
  let block = box.parent;
  while (block && block.kind === 'inline') block = block.parent;
  const lines = block?.lines;
  if (!lines) return;
  const moved = INLINE_OFFSETS.get(box);
  INLINE_OFFSETS.set(box, {
    x: (moved?.x ?? 0) + dx,
    y: (moved?.y ?? 0) + dy,
  });
  for (const line of lines) {
    for (const text of line.texts) {
      const owner = text.spans.boxAt?.(text.layoutStart);
      if (!owner || !holds(box, owner)) continue;
      text.drawX += dx;
      text.drawY += dy;
      const was = TEXT_SHIFTS.get(text);
      const x = (was?.x ?? 0) + dx;
      const y = (was?.y ?? 0) + dy;
      markMovedOff(lines, line);
      if (Math.abs(x) >= HOME_WITHIN || Math.abs(y) >= HOME_WITHIN) {
        TEXT_SHIFTS.set(text, { x, y });
        SHIFTED_LINES.add(line);
        continue;
      }
      // where its line has it again, as a sticky box let go comes home: a
      // line among the moved ones has all its text's ink read
      TEXT_SHIFTS.delete(text);
      if (!holdsMoved(line)) SHIFTED_LINES.delete(line);
    }
  }
}

/** How far a text may be from where its line has it and be there: moves
 *  there and back add up to no more than this in floating point. */
const HOME_WITHIN = 1e-6;

/** Whether anything on a line is off it (`SHIFTED_LINES`): moved by a box
 *  around it, or raised by `vertical-align`. */
function holdsMoved(line: LineBox): boolean {
  if (LINE_BOX_RAISES.has(line)) return true;
  return line.texts.some((t) => TEXT_SHIFTS.has(t) || TEXT_RAISES.has(t));
}

/** Mark the line an inline-block or an image a box moved off was placed
 *  on, where it was on one: the line stays, and the box is drawn where it
 *  went (`MOVED_OFF_LINES`). */
function movedOffLine(box: Box): void {
  let block = box.parent;
  while (block && block.kind === 'inline') block = block.parent;
  const lines = block?.lines;
  if (!lines) return;
  for (const line of lines) {
    for (const placed of line.atomics) {
      if (placed.box !== box) continue;
      markMovedOff(lines, line);
      return;
    }
  }
}

function markMovedOff(lines: LineBox[], line: LineBox): void {
  const moved = MOVED_OFF_LINES.get(lines);
  if (moved) moved.add(line);
  else MOVED_OFF_LINES.set(lines, new Set([line]));
}

/** Whether `inner` is `outer` or inside it. */
function holds(outer: Box, inner: Box): boolean {
  for (let at: Box | null = inner; at; at = at.parent) {
    if (at === outer) return true;
  }
  return false;
}
