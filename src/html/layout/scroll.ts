// Scroll containers inside a document: a box whose `overflow` is other than
// `visible` and `clip` scrolls what it holds (CSS Overflow 3, 3).
//
// A scroll moves the content and nothing else, so it is done the way
// `position: relative` is: after layout, the boxes and lines a scroll
// container holds are moved by its offset (`applyScrollOffsets`), and its
// clip cuts them, which it did already. Everything that reads a box — paint
// and its culling, the hit test, the selection, `elementRect`, the controls,
// frames and players mounted beside the document — finds it where it is
// drawn, with no notion of a scroll in any of them. What the offsets are is
// the element's, kept by the element across builds and layouts
// (`HtmlViewNode`), and each layout moves the boxes it made by them again.
//
// What a scroll container moves is what it is the scroll container of: its
// lines, its in-flow boxes and the out-of-flow boxes whose containing block
// it holds. A box positioned against something outside it stays, as it is
// not clipped by it either (CSS 2.1 11.1.1): a fixed header inside a
// scrolling `main` stays where it is.
import type { Element } from 'domhandler';

import { scrolls } from '../css/style.js';
import { CLAMPED } from './boxes.js';
import type { Box, BoxTree, LineBox } from './boxes.js';
import { clipsOverflow, containingBlockOf, hasRect, holds } from '../paint.js';

/** Where a scroll container is scrolled to, in CSS pixels from the start
 *  of its content. */
export interface ScrollOffset {
  x: number;
  y: number;
}

/** What a scroll container reads back: where it is scrolled to, how far it
 *  can be, and its scrollport, as `scrollTop`, `scrollHeight` and
 *  `clientHeight` answer — CSS pixels. */
export interface ScrollState {
  /** The offset its content is moved by now. */
  x: number;
  y: number;
  /** The scrollable overflow's size (`scrollWidth`, `scrollHeight`): at
   *  least the scrollport's. */
  width: number;
  height: number;
  /** The padding box, which is the scrollport: no room is taken for a
   *  scroll bar, which is drawn over the content where it is drawn at all,
   *  as an overlay scroll bar is. */
  clientWidth: number;
  clientHeight: number;
  /** The border's width at its top and its left (`clientTop`). */
  clientTop: number;
  clientLeft: number;
}

/** How a box and what it holds are moved: `translate` in `block.ts`, with
 *  the boxes `stays` names left where they are, and what they hold. */
export type MoveBox = (
  box: Box,
  dx: number,
  dy: number,
  stays?: (box: Box) => boolean,
) => void;

/** The offsets a tree's layout moves its scroll containers by, by their
 *  elements, in CSS pixels, and the scale the tree is laid out at: the
 *  node's, handed over before each layout. */
const OFFSETS = new WeakMap<
  BoxTree,
  { offsets: ReadonlyMap<Element, ScrollOffset>; scale: number }
>();

/** How far each sticky box was moved from where the flow has it, by
 *  `applyRelativeOffsets` and since by `restick` (`block.ts`): a new place
 *  for it is that far less from where it is, and how far a scroll
 *  container reaches is measured where the flow has it, as a browser's
 *  scrollable overflow is. */
export const STUCK = new WeakMap<Box, [number, number]>();

/** The offset each scroll container's content is moved by now. A layout
 *  puts every box it lays out back where no scroll has it, and clears its
 *  entry as it moves it again. */
const APPLIED = new WeakMap<Box, ScrollOffset>();

/** The trees some layout moved a scroll container's content in, whose
 *  next layout clears what it moved them by. */
const SCROLLED = new WeakSet<BoxTree>();

/** Each scroll container's scrollable overflow, worked out once a layout
 *  (`extentOf`): what its content comes to doesn't change as it scrolls. */
let extents = new WeakMap<Box, { width: number; height: number }>();

/** Hand a tree the offsets its layouts move its scroll containers by, in
 *  CSS pixels, and the scale its boxes are laid out at. */
export function setScrollOffsets(
  tree: BoxTree,
  offsets: ReadonlyMap<Element, ScrollOffset>,
  scale: number,
): void {
  OFFSETS.set(tree, { offsets, scale });
}

/**
 * Whether a box is a scroll container: an element's box that clips what
 * overflows it, with an `overflow` that scrolls on either axis — `hidden`
 * included, which a script may scroll and the wheel may not. The root's and
 * the `<body>`'s `overflow` are the viewport's by now
 * (`propagateOverflow`), and the viewport is the box around the document.
 */
export function isScroller(box: Box): boolean {
  return box.el !== null && scrolls(box.style) && clipsOverflow(box);
}

/** Whether the wheel scrolls a scroll container on an axis: `auto` and
 *  `scroll` do, `hidden` does not (CSS Overflow 3, 3.1). */
export function wheelScrolls(box: Box, axis: 'x' | 'y'): boolean {
  const v = axis === 'x' ? box.style.overflowX : box.style.overflowY;
  return v === 'auto' || v === 'scroll';
}

/**
 * Move every scroll container's content by the offset its element is
 * scrolled to, each kept within how far it can be: after layout, and before
 * the ink bounds are worked out, as `position: relative` is. A container
 * with no offset moves nothing and costs a style read.
 */
export function applyScrollOffsets(tree: BoxTree, move: MoveBox): void {
  extents = new WeakMap();
  const given = OFFSETS.get(tree);
  const offsets = given?.offsets;
  const s = given?.scale ?? 1;
  if (!offsets?.size && !SCROLLED.has(tree)) return;
  if (offsets?.size) SCROLLED.add(tree);
  else SCROLLED.delete(tree);
  const stack: Box[] = [tree.root];
  while (stack.length) {
    const box = stack.pop()!;
    // laid out where no scroll has it
    APPLIED.delete(box);
    const want = box.el ? offsets?.get(box.el) : undefined;
    if (want && (want.x || want.y) && isScroller(box)) {
      scrollContent(box, want.x * s, want.y * s, move);
    }
    for (let i = box.children.length - 1; i >= 0; i -= 1) {
      stack.push(box.children[i]);
    }
  }
}

/**
 * Scroll a container's content to an offset, in the device pixels its boxes
 * are laid out in, kept within how far it can be: moved by the difference
 * from where it is now. Answers the offset it came to. The ink bounds are
 * the caller's to work out again.
 */
export function scrollContent(
  box: Box,
  x: number,
  y: number,
  move: MoveBox,
): ScrollOffset {
  const state = scrollStateOf(box);
  const to = {
    x: clampOffset(x, state.width - state.clientWidth),
    y: clampOffset(y, state.height - state.clientHeight),
  };
  const dx = to.x - state.x;
  const dy = to.y - state.y;
  if (dx || dy) {
    const stays = (child: Box) => escapes(child, box);
    moveLines(box.lines, -dx, -dy);
    for (const child of box.children) {
      if (!stays(child)) move(child, -dx, -dy, stays);
    }
    // and a box anchored to something it scrolls, outside it, with its
    // anchor (CSS Anchor Positioning 1, 6.2, the default scroll shift)
    for (const { box: anchored, x, y } of anchoredAcross(box)) {
      if ((x && dx) || (y && dy)) {
        move(anchored, x ? -dx : 0, y ? -dy : 0, () => false);
      }
    }
  }
  if (to.x || to.y) APPLIED.set(box, to);
  else APPLIED.delete(box);
  return to;
}

/**
 * How far the scroll containers around a box moved it from where layout
 * put it, across and down, in the device pixels its boxes are laid out in:
 * the offsets of those that move it, which a box positioned against
 * something outside one is not (`escapes`). What CSSOM View's offset
 * attributes add back, since they measure a box where it is laid out
 * (`offsetTop`, 7).
 */
export function scrolledBy(box: Box): [number, number] {
  let x = 0;
  let y = 0;
  for (let scroller = box.parent; scroller; scroller = scroller.parent) {
    const at = APPLIED.get(scroller);
    if (at && scrollMoves(scroller, box)) {
      x += at.x;
      y += at.y;
    }
  }
  return [x, y];
}

/**
 * Whether a scroll container's scroll moves a box: the box is in it, and
 * neither the box nor any box between them is positioned against
 * something outside it (`escapes`), which `scrollContent` leaves where it
 * is with all it holds. What a script's `scrollIntoView` asks of each
 * scroll container around an element (CSSOM View 7.1).
 */
export function scrollMoves(scroller: Box, box: Box): boolean {
  for (let b: Box | null = box; b !== scroller; b = b.parent) {
    if (!b || escapes(b, scroller)) return false;
  }
  return box !== scroller;
}

/** A scroll offset within `[0, max]`, in whole hundredths: a script's
 *  `scrollTop = 10.004` moves nothing a pixel would show. */
function clampOffset(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(Math.max(0, max), Math.max(0, v)) * 100) / 100;
}

/** Whether an out-of-flow box is positioned against something outside a
 *  scroll container, which then neither moves it nor clips it — or
 *  outside a sticky or a relative box, whose offset moves it no more than
 *  a scroll does (`applyRelativeOffsets`, `placeSticky`). */
export function escapes(box: Box, scroller: Box): boolean {
  if (!box.outOfFlow) return false;
  return !holds(scroller, containingBlockOf(box));
}

function moveLines(
  lines: readonly LineBox[] | null | undefined,
  dx: number,
  dy: number,
): void {
  if (!lines) return;
  for (const line of lines) {
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

/** Where a scroll container is scrolled to, how far it can be, and its
 *  scrollport, in the device pixels its boxes are laid out in. */
export function scrollStateOf(box: Box): ScrollState {
  const at = APPLIED.get(box);
  const clientWidth = Math.max(0, box.width - box.borderLeft - box.borderRight);
  const clientHeight = Math.max(
    0,
    box.height - box.borderTop - box.borderBottom,
  );
  const extent = extentOf(box, at);
  return {
    x: at?.x ?? 0,
    y: at?.y ?? 0,
    width: Math.max(clientWidth, extent.width),
    height: Math.max(clientHeight, extent.height),
    clientWidth,
    clientHeight,
    clientTop: box.borderTop,
    clientLeft: box.borderLeft,
  };
}

/**
 * How far a scroll container's content reaches from its padding box's
 * corner, at no scroll, as Blink measures `scrollWidth` and `scrollHeight`
 * (CSS Overflow 3, 2.2, scrollable overflow): its in-flow children's margin
 * boxes and lines, and the boxes and lines in them, with its end padding
 * past them; the out-of-flow boxes positioned against it or inside it, by
 * their border boxes; and none of what a box inside it clips, past that
 * box. Measured where its content is now, and taken back by the offset it
 * was moved by.
 */
function extentOf(
  box: Box,
  at: ScrollOffset | undefined,
): { width: number; height: number } {
  let extent = extents.get(box);
  if (extent) return extent;
  const left = box.x + box.borderLeft;
  const top = box.y + box.borderTop;
  let right = -Infinity;
  let bottom = -Infinity;
  let outRight = -Infinity;
  let outBottom = -Infinity;
  const take = (x2: number, y2: number, outOfFlow: boolean) => {
    if (outOfFlow) {
      outRight = Math.max(outRight, x2);
      outBottom = Math.max(outBottom, y2);
    } else {
      right = Math.max(right, x2);
      bottom = Math.max(bottom, y2);
    }
  };
  // `dx` and `dy` take a sticky box, and what is in it, back to where the
  // flow has it
  const linesOf = (
    lines: readonly LineBox[] | null,
    outOfFlow: boolean,
    dx: number,
    dy: number,
  ) => {
    for (const line of lines ?? []) {
      let x2 = line.x + line.width;
      for (const text of line.texts) {
        const natural = text.layout.lines[text.layoutLine];
        if (natural) x2 = Math.max(x2, text.drawX + natural.x + natural.width);
      }
      take(x2 + dx, line.y + line.height + dy, outOfFlow);
    }
  };
  const walk = (
    child: Box,
    outOfFlow: boolean,
    margins: boolean,
    dx: number,
    dy: number,
  ) => {
    if (child.kind === 'text' || child.kind === 'break') return;
    if (child.outOfFlow) {
      if (escapes(child, box)) return;
      outOfFlow = true;
      margins = false;
    }
    const stuck = child.style.position === 'sticky' ? STUCK.get(child) : null;
    if (stuck) {
      dx -= stuck[0];
      dy -= stuck[1];
    }
    if (hasRect(child) && child.width + child.height > 0) {
      take(
        child.x +
          dx +
          child.width +
          (margins ? Math.max(0, child.marginRight) : 0),
        child.y +
          dy +
          child.height +
          (margins ? Math.max(0, child.marginBottom) : 0),
        outOfFlow,
      );
    }
    // what a box clips is its own to scroll
    if (clipsOverflow(child)) return;
    linesOf(child.lines, outOfFlow, dx, dy);
    for (const inner of child.children) walk(inner, outOfFlow, false, dx, dy);
  };
  linesOf(box.lines, false, 0, 0);
  for (const child of box.children) walk(child, false, true, 0, 0);
  const shift = { x: at?.x ?? 0, y: at?.y ?? 0 };
  // the end padding is past the in-flow content, and the out-of-flow boxes
  // reach as far as they reach
  const width = Math.max(
    right === -Infinity ? 0 : right + shift.x - left + box.padRight,
    outRight === -Infinity ? 0 : outRight + shift.x - left,
  );
  const height = Math.max(
    bottom === -Infinity ? 0 : bottom + shift.y - top + box.padBottom,
    outBottom === -Infinity ? 0 : outBottom + shift.y - top,
  );
  extent = { width, height };
  extents.set(box, extent);
  return extent;
}

/**
 * A scroll container's bar on one axis, in the device pixels its boxes are
 * laid out in: the track it runs in and the thumb, which is drawn over the
 * content as an overlay bar is, the way core draws a pane's
 * (`scrollbarGeometry`), so a document's lists and the pane around it look
 * alike.
 */
export interface ScrollBar {
  axis: 'x' | 'y';
  trackStart: number;
  trackLength: number;
  thumbStart: number;
  thumbLength: number;
  /** Where the bar is across the axis, and how thick. */
  crossStart: number;
  thickness: number;
  /** How far the thumb and the content can travel. */
  travel: number;
  range: number;
}

/** Core's bar: 6 logical pixels thick (4 where `scrollbar-width: thin`),
 *  2 in from the edge, its thumb no shorter than 20. */
const BAR = 6;
const THIN_BAR = 4;
const BAR_INSET = 2;
const MIN_THUMB = 20;
/** How far past the drawn bar a press still takes it: the bar is thin,
 *  the pointer's target is not (core's `SCROLLBAR_SLOP`). */
const BAR_SLOP = 4;

/**
 * The bars a scroll container draws: on each axis whose `overflow` the user
 * may scroll (`auto`, `scroll`) and whose content overflows, but where
 * `scrollbar-width: none` or a page's `::-webkit-scrollbar` (`hidden`)
 * hides it. Each stops short of the other's corner where both show.
 */
export function scrollBarsOf(
  box: Box,
  scale: number,
  hidden: { x: boolean; y: boolean },
): ScrollBar[] {
  if (!isScroller(box) || box.style.scrollbarWidth === 'none') return [];
  const state = scrollStateOf(box);
  const shows = (axis: 'x' | 'y') =>
    wheelScrolls(box, axis) &&
    !hidden[axis] &&
    (axis === 'x'
      ? state.width > state.clientWidth + 0.5
      : state.height > state.clientHeight + 0.5);
  const x = shows('x');
  const y = shows('y');
  const thickness =
    (box.style.scrollbarWidth === 'thin' ? THIN_BAR : BAR) * scale;
  const inset = BAR_INSET * scale;
  const left = box.x + box.borderLeft;
  const top = box.y + box.borderTop;
  const bars: ScrollBar[] = [];
  const bar = (axis: 'x' | 'y'): ScrollBar | null => {
    const horizontal = axis === 'x';
    const viewport = horizontal ? state.clientWidth : state.clientHeight;
    const content = horizontal ? state.width : state.height;
    const crossSize = horizontal ? state.clientHeight : state.clientWidth;
    if (crossSize < thickness + inset) return null;
    const shorten = (horizontal ? y : x) ? thickness + inset : 0;
    const length = viewport - shorten;
    if (length <= 0) return null;
    const thumbLength = Math.min(
      length,
      Math.max(MIN_THUMB * scale, (length * length) / content),
    );
    const range = content - viewport;
    const travel = Math.max(0, length - thumbLength);
    const scroll = horizontal ? state.x : state.y;
    const trackStart = horizontal ? left : top;
    return {
      axis,
      trackStart,
      trackLength: length,
      thumbStart: trackStart + (range > 0 ? (scroll / range) * travel : 0),
      thumbLength,
      crossStart: (horizontal ? top : left) + crossSize - thickness - inset,
      thickness,
      travel,
      range,
    };
  };
  if (y) {
    const b = bar('y');
    if (b) bars.push(b);
  }
  if (x) {
    const b = bar('x');
    if (b) bars.push(b);
  }
  return bars;
}

/** A bar's thumb as a rectangle. */
export function thumbRect(bar: ScrollBar): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return bar.axis === 'x'
    ? {
        x: bar.thumbStart,
        y: bar.crossStart,
        width: bar.thumbLength,
        height: bar.thickness,
      }
    : {
        x: bar.crossStart,
        y: bar.thumbStart,
        width: bar.thickness,
        height: bar.thumbLength,
      };
}

/** Whether a point is on a bar, within a slop of it, and on its thumb or
 *  its track. */
export function scrollBarHit(
  bar: ScrollBar,
  x: number,
  y: number,
  scale: number,
): 'thumb' | 'track' | null {
  const across = bar.axis === 'x' ? y : x;
  const along = bar.axis === 'x' ? x : y;
  const slop = BAR_SLOP * scale;
  if (
    across < bar.crossStart - slop ||
    across > bar.crossStart + bar.thickness + slop
  ) {
    return null;
  }
  if (along < bar.trackStart || along > bar.trackStart + bar.trackLength) {
    return null;
  }
  return along >= bar.thumbStart && along <= bar.thumbStart + bar.thumbLength
    ? 'thumb'
    : 'track';
}

/** Each anchor-positioned box and the box of its default anchor, by the
 *  root of the tree they were laid out in (`noteDefaultAnchor`). */
const DEFAULT_ANCHORS = new WeakMap<
  Box,
  Map<Box, { anchor: Box; x: boolean; y: boolean }>
>();

/** A layout begins resolving anchors in the tree under `root`: what the
 *  last one noted is of boxes it may have replaced. */
export function clearDefaultAnchors(root: Box): void {
  DEFAULT_ANCHORS.delete(root);
  VISIBILITY.delete(root);
}

/** Each box `position-visibility` may hide, by the root of its tree, and
 *  whether it overflowed its containing block where layout placed it. */
const VISIBILITY = new WeakMap<Box, Map<Box, boolean>>();

/** Layout placed a box `position-visibility` may hide. */
export function noteVisibility(root: Box, box: Box, overflows: boolean): void {
  let map = VISIBILITY.get(root);
  if (!map) VISIBILITY.set(root, (map = new Map()));
  map.set(box, overflows);
}

/**
 * Which boxes `position-visibility` hides now (CSS Anchor Positioning 1,
 * 5.4), strongly — passed over by paint and by the paint bounds, as a box
 * past a clamp point is (`CLAMPED`): one with `no-overflow` that
 * overflowed its containing block, and one with `anchors-visible` whose
 * default anchor a box between the two clips away entirely. The boxes
 * that were hidden or shown by it.
 */
export function positionVisibilityBoxes(root: Box): Box[] {
  return [...(VISIBILITY.get(root)?.keys() ?? [])];
}

export function updatePositionVisibility(root: Box): Box[] {
  const map = VISIBILITY.get(root);
  if (!map?.size) return [];
  const anchors = DEFAULT_ANCHORS.get(root);
  const changed: Box[] = [];
  for (const [box, overflows] of map) {
    const bits = box.style.positionVisibility;
    const anchor = anchors?.get(box)?.anchor;
    const hidden =
      (!!(bits & 2) && overflows) ||
      (!!(bits & 1) && !!anchor && clippedAway(anchor, box));
    if (hidden === CLAMPED.has(box)) continue;
    if (hidden) CLAMPED.add(box);
    else CLAMPED.delete(box);
    changed.push(box);
  }
  return changed;
}

/** Whether a box that clips what overflows it, between an anchor and the
 *  containing block of the box it anchors, leaves nothing of the anchor. */
function clippedAway(anchor: Box, box: Box): boolean {
  // an inline box has no rectangle of its own to cut, only its lines'
  if (anchor.kind === 'inline') return false;
  const cb = containingBlockOf(box);
  // up the anchor's chain of containing blocks: a box positioned out of a
  // clip is not cut by it
  const up = (b: Box): Box | null =>
    b.style.position === 'absolute' || b.style.position === 'fixed'
      ? containingBlockOf(b)
      : b.parent;
  for (let at = up(anchor); at && at !== cb; at = up(at)) {
    if (!clipsOverflow(at)) continue;
    const x = at.x + at.borderLeft;
    const y = at.y + at.borderTop;
    const w = at.width - at.borderLeft - at.borderRight;
    const h = at.height - at.borderTop - at.borderBottom;
    if (
      anchor.x >= x + w ||
      anchor.x + anchor.width <= x ||
      anchor.y >= y + h ||
      anchor.y + anchor.height <= y
    ) {
      return true;
    }
  }
  return false;
}

/** Layout placed `box` against `anchor`, its default anchor, across
 *  where `x` and down where `y`: the axes its scroll moves it on. */
export function noteDefaultAnchor(
  root: Box,
  box: Box,
  anchor: Box,
  x: boolean,
  y: boolean,
): void {
  let map = DEFAULT_ANCHORS.get(root);
  if (!map) DEFAULT_ANCHORS.set(root, (map = new Map()));
  map.set(box, { anchor, x, y });
}

/** The boxes anchored to something inside `scroller`, that are outside it
 *  themselves: what its scroll moves with their anchors. */
export function anchoredAcross(
  scroller: Box,
): { box: Box; x: boolean; y: boolean }[] {
  let root = scroller;
  while (root.parent) root = root.parent;
  const map = DEFAULT_ANCHORS.get(root);
  if (!map?.size) return [];
  // what the scroller moves: inside it, and not positioned against
  // something outside it on the way down
  const movedBy = (b: Box) => {
    for (let at: Box | null = b; at; at = at.parent) {
      if (at === scroller) return true;
      if (at.parent === scroller && escapes(at, scroller)) return false;
      if (at.outOfFlow && !holds(scroller, containingBlockOf(at))) {
        return false;
      }
    }
    return false;
  };
  const out: { box: Box; x: boolean; y: boolean }[] = [];
  for (const [anchored, { anchor, x, y }] of map) {
    if (anchor !== scroller && movedBy(anchor) && !movedBy(anchored)) {
      out.push({ box: anchored, x, y });
    }
  }
  return out;
}
