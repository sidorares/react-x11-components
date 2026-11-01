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
import { CLAMPED, clampBox, unclampBox } from './boxes.js';
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

/** How many boxes measuring scroll containers has walked (`extentOf`), for a
 *  test to count what a paint walks. */
let extentWalkedCount = 0;
export function extentWalked(): number {
  return extentWalkedCount;
}

/**
 * How far below a box's content top what a layout that stopped set aside
 * of its children ends (`setAside`): what it set aside is as tall as it
 * was, and a scroll container's scrollable overflow reaches as far
 * (`extentOf`), so a container scrolled down its content stays where it
 * was while a drag lays out only what it shows. From the content top, and
 * not as a place, since what moves a box after its layout — a relative
 * offset, a scroll around it — moves its content top with it.
 */
export const ASIDE_REACH = new WeakMap<Box, number>();

/** How far down a tree's next layout scrolls a scroll container's content,
 *  in the device pixels its boxes are laid out in: what the node handed
 *  over for its element (`setScrollOffsets`), before `applyScrollOffsets`
 *  keeps it within how far the container can be scrolled. */
export function wantedScrollTop(tree: BoxTree, box: Box): number {
  const given = OFFSETS.get(tree);
  const want = box.el ? given?.offsets.get(box.el) : undefined;
  return want ? want.y * given!.scale : 0;
}

/** Whether a layout of `tree` moves any scroll container's content, or
 *  did: what a kept block's offsets are taken off for (`unoffsetHeld`). */
export function scrollsAny(tree: BoxTree): boolean {
  return !!OFFSETS.get(tree)?.offsets.size || SCROLLED.has(tree);
}

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
 * with no offset moves nothing and costs a style read. Given `moved`, only
 * down the boxes in it, which every scroll container is
 * (`Blockers.moved` in `block.ts`).
 */
export function applyScrollOffsets(
  tree: BoxTree,
  move: MoveBox,
  moved?: ReadonlySet<Box>,
): void {
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
      const child = box.children[i];
      if (!moved || moved.has(child)) stack.push(child);
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
 * Take a scroll container's content back to where its layout put it, from
 * where it is scrolled to (`APPLIED`): what a layout that keeps a block an
 * earlier one laid out does to each container in it, which the scroll after
 * the flow then scrolls as it does a container just laid out
 * (`applyScrollOffsets`). Nothing anchored, in a tree that keeps a block.
 */
export function scrollBack(box: Box, move: MoveBox): void {
  const at = APPLIED.get(box);
  if (!at) return;
  APPLIED.delete(box);
  const stays = (child: Box) => escapes(child, box);
  moveLines(box.lines, at.x, at.y);
  for (const child of box.children) {
    if (!stays(child)) move(child, at.x, at.y, stays);
  }
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
    extentWalkedCount += 1;
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
    aside(child, outOfFlow, dy);
  };
  // and what a layout that stopped set aside, which reaches as far below
  // its holder's content as it did: the container's own content is where
  // it is scrolled to, and what is in it moved with it
  const aside = (holder: Box, outOfFlow: boolean, dy: number) => {
    const reach = ASIDE_REACH.get(holder);
    if (reach !== undefined)
      take(left, holder.contentY + reach + dy, outOfFlow);
  };
  linesOf(box.lines, false, 0, 0);
  for (const child of box.children) walk(child, false, true, 0, 0);
  aside(box, false, -(at?.y ?? 0));
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
 * `scrollbar-width: none` or a page's `::-webkit-scrollbar` (`hiddenOf`)
 * hides it. Each stops short of the other's corner where both show.
 *
 * Asked in the order the answers cost: the style, then the extent, a walk of
 * what the container holds once a layout, then `hiddenOf`, a selector match
 * every time. So `overflow: hidden`, which a script may scroll and which no
 * bar shows on, costs a style read however much it holds, and a paint never
 * measures it: `scrollStateOf` does, for what reads `scrollHeight`.
 */
export function scrollBarsOf(
  box: Box,
  scale: number,
  hiddenOf?: (box: Box) => { x: boolean; y: boolean },
): ScrollBar[] {
  const wheelX = wheelScrolls(box, 'x');
  const wheelY = wheelScrolls(box, 'y');
  if (!wheelX && !wheelY) return [];
  if (!isScroller(box) || box.style.scrollbarWidth === 'none') return [];
  const state = scrollStateOf(box);
  const overflowsX = wheelX && state.width > state.clientWidth + 0.5;
  const overflowsY = wheelY && state.height > state.clientHeight + 0.5;
  if (!overflowsX && !overflowsY) return [];
  const hidden = hiddenOf?.(box);
  const x = overflowsX && !hidden?.x;
  const y = overflowsY && !hidden?.y;
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
  ANCHOR_SCROLLS.delete(root);
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
 * default anchor a box between the two clips away entirely — or the
 * viewport does, for a box fixed to it whose anchor the pane scrolls,
 * given where the pane has it (`viewport`, in the document's device
 * pixels). The boxes that were hidden or shown by it.
 */
export function positionVisibilityBoxes(root: Box): Box[] {
  return [...(VISIBILITY.get(root)?.keys() ?? [])];
}

export function updatePositionVisibility(
  root: Box,
  viewport: Viewport | null = null,
): Box[] {
  const map = VISIBILITY.get(root);
  if (!map?.size) return [];
  const anchors = DEFAULT_ANCHORS.get(root);
  const scrolled = ANCHOR_SCROLLS.get(root);
  const changed: Box[] = [];
  for (const [box, overflows] of map) {
    const bits = box.style.positionVisibility;
    const anchor = anchors?.get(box)?.anchor;
    const hidden =
      (!!(bits & 2) && overflows) ||
      (!!(bits & 1) &&
        !!anchor &&
        (invisible(anchor) ||
          clippedAway(anchor, box) ||
          (scrolled?.get(box)?.pane === 1 &&
            !!viewport &&
            outside(anchor, viewport))));
    if (hidden === CLAMPED.has(box)) continue;
    if (hidden) clampBox(box);
    else unclampBox(box);
    changed.push(box);
  }
  return changed;
}

/** Whether an anchor is not seen however it is placed (CSS Anchor
 *  Positioning 1, 5.4): `visibility` hides it, or it is in a box hidden
 *  already — by `position-visibility`, an anchored box whose own anchor is
 *  gone, which a box anchored to it goes with in turn, the boxes before it
 *  in the order they are laid out having been asked first. */
function invisible(anchor: Box): boolean {
  if (anchor.style.visibility !== 'visible') return true;
  for (let at: Box | null = anchor; at; at = at.parent) {
    if (CLAMPED.has(at)) return true;
  }
  return false;
}

/** Whether a box is wholly outside a rectangle — but for one of no size,
 *  which is outside nothing it is on the edge of. */
function outside(
  anchor: Box,
  r: { x: number; y: number; width: number; height: number },
): boolean {
  if (anchor.kind === 'inline') return false;
  return (
    anchor.x >= r.x + r.width ||
    anchor.x + anchor.width <= r.x ||
    anchor.y >= r.y + r.height ||
    anchor.y + anchor.height <= r.y
  );
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
    if (
      outside(anchor, {
        x: at.x + at.borderLeft,
        y: at.y + at.borderTop,
        width: at.width - at.borderLeft - at.borderRight,
        height: at.height - at.borderTop - at.borderBottom,
      })
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

/** The axes a box was last noted to follow its default anchor on
 *  (`noteDefaultAnchor`), or null where it has none. */
export function defaultAnchorOf(
  root: Box,
  box: Box,
): { anchor: Box; x: boolean; y: boolean } | null {
  return DEFAULT_ANCHORS.get(root)?.get(box) ?? null;
}

/** Whether a scroll container's scroll moves a box: inside it, and not
 *  positioned against something outside it on the way down. */
function movedBy(scroller: Box, b: Box): boolean {
  for (let at: Box | null = b; at; at = at.parent) {
    if (at === scroller) return true;
    if (at.parent === scroller && escapes(at, scroller)) return false;
    if (at.outOfFlow && !holds(scroller, containingBlockOf(at))) return false;
  }
  return false;
}

/** The boxes anchored to something inside `scroller`, that are outside it
 *  themselves: what its scroll moves with their anchors — and what is
 *  anchored to those in turn (`followersOf`). */
export function anchoredAcross(
  scroller: Box,
): { box: Box; x: boolean; y: boolean }[] {
  return followersOf(
    scroller,
    (anchor, anchored) =>
      anchor !== scroller &&
      movedBy(scroller, anchor) &&
      !movedBy(scroller, anchored),
  );
}

/** The boxes anchored to `moved` or to something in it, that are outside
 *  it themselves, and what is anchored to those in turn: what a move of it
 *  that is no layout's — `position: sticky` placing it again, for one —
 *  moves with their anchors (CSS Anchor Positioning 1, 3.3: the remembered
 *  scroll offset takes in what a scroll does to a sticky box). */
export function anchoredWith(
  moved: Box,
): { box: Box; x: boolean; y: boolean }[] {
  return followersOf(
    moved,
    (anchor, anchored) => within(anchor, moved) && !within(anchored, moved),
  );
}

/**
 * The anchored boxes of the tree `at` is in whose default anchors a move
 * moves and the boxes not (`moves`), on the axes each follows its anchor
 * on — and, as a chain, every box anchored to one of those or to something
 * in it, and not in it itself, on the axes it and the one before it both
 * follow on: the default scroll shift of a box whose default anchor is an
 * anchored box a scroll shifts is that one's, since its anchor is where
 * that shift has it (3.3).
 */
function followersOf(
  at: Box,
  moves: (anchor: Box, anchored: Box) => boolean,
): { box: Box; x: boolean; y: boolean }[] {
  let root = at;
  while (root.parent) root = root.parent;
  const map = DEFAULT_ANCHORS.get(root);
  if (!map?.size) return [];
  const out: { box: Box; x: boolean; y: boolean }[] = [];
  const taken = new Set<Box>();
  for (const [anchored, { anchor, x, y }] of map) {
    if (moves(anchor, anchored)) {
      out.push({ box: anchored, x, y });
      taken.add(anchored);
    }
  }
  // what is anchored to a box that moves, the boxes it moves taken in
  // turn, which a chain of any length comes to
  for (let i = 0; i < out.length; i += 1) {
    const by = out[i];
    for (const [anchored, { anchor, x, y }] of map) {
      if (taken.has(anchored)) continue;
      if (!within(anchor, by.box) || within(anchored, by.box)) continue;
      const along = { box: anchored, x: x && by.x, y: y && by.y };
      if (!along.x && !along.y) continue;
      out.push(along);
      taken.add(anchored);
    }
  }
  return out;
}

/** Whether `box` is `around` or in it. */
function within(box: Box, around: Box): boolean {
  for (let at: Box | null = box; at; at = at.parent) {
    if (at === around) return true;
  }
  return false;
}

/** Where the pane around a document has the viewport: its corner, in the
 *  document's device pixels — how far the pane's scroll moves what is
 *  fixed to it from where it was laid out — and its size. */
export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The viewport each tree's next layout is seen through, handed over by
 *  the node before it (`setViewport`). */
const VIEWPORTS = new WeakMap<BoxTree, Viewport>();

/** Hand a tree where the pane around it has the viewport, for an anchored
 *  box whose anchor the pane scrolls and it does not, or the other way
 *  round. */
export function setViewport(tree: BoxTree, viewport: Viewport | null): void {
  if (viewport) VIEWPORTS.set(tree, viewport);
  else VIEWPORTS.delete(tree);
}

/** Where a tree's layout has the viewport (`setViewport`), or null. */
export function viewportOf(tree: BoxTree): Viewport | null {
  return VIEWPORTS.get(tree) ?? null;
}

/** How far a tree's next layout scrolls a scroll container's content, both
 *  ways, in the device pixels its boxes are laid out in. */
export function wantedScroll(tree: BoxTree, box: Box): ScrollOffset {
  const given = OFFSETS.get(tree);
  const want = box.el ? given?.offsets.get(box.el) : undefined;
  if (!want) return { x: 0, y: 0 };
  return { x: want.x * given!.scale, y: want.y * given!.scale };
}

/**
 * An anchor-positioned box whose default anchor is in another scroll
 * context than its own (CSS Anchor Positioning 1, 3.3): scrolled by scroll
 * containers that do not scroll the box, or by the pane where the box is
 * fixed to the viewport — or fixed where the box is not. How a scroll
 * displaces the anchor from the box, what the box's anchor references were
 * taken at (its remembered scroll offset), and what it has to fit in,
 * which a scroll asks again with no layout (`refitAnchored`).
 */
export interface AnchorScroll {
  /** The scroll containers that scroll the anchor and not the box. */
  scrollers: readonly Box[];
  /** 1 where the pane scrolls the anchor and not the box, -1 where it
   *  scrolls the box and not the anchor, 0 where it scrolls both. */
  pane: number;
  /** The axes the box follows its anchor on. */
  x: boolean;
  y: boolean;
  /** The displacement its layout placed it at, which a scroll shifts it
   *  from by its difference from what it is now. */
  rx: number;
  ry: number;
  /** Its inset-modified containing block, from its margin box's corner as
   *  laid out, before any shift, and its margin box's size. */
  room: { x: number; y: number; width: number; height: number };
  /** The edges of that rectangle a scroll that moves the anchor leaves
   *  where they are — the containing block's, and not the anchor's — as
   *  bits: left 1, right 2, top 4, bottom 8. Only those can a scroll take
   *  the box over, since the others move with it. */
  fixedEdges: number;
  width: number;
  height: number;
  /** Whether its insets left it no room at all, which nothing fits. */
  corrected: boolean;
  /** Whether a placement that no longer fits is laid out again, to try its
   *  position options (6.5). */
  refits: boolean;
  /** The displacement its layout was at, once the layout has scrolled
   *  everything (`settleAnchorScrolls`): what was tried there is not tried
   *  again at a scroll that moves nothing. */
  dx: number | null;
  dy: number | null;
}

/** Each anchored box in another scroll context than its default anchor's,
 *  by the root of its tree. */
const ANCHOR_SCROLLS = new WeakMap<Box, Map<Box, AnchorScroll>>();

export function noteAnchorScroll(
  root: Box,
  box: Box,
  state: AnchorScroll,
): void {
  let map = ANCHOR_SCROLLS.get(root);
  if (!map) ANCHOR_SCROLLS.set(root, (map = new Map()));
  map.set(box, state);
}

/** The anchored boxes of a tree in another scroll context than their
 *  default anchors' (`AnchorScroll`), or none. */
export function anchorScrollsOf(root: Box): ReadonlyMap<Box, AnchorScroll> {
  return ANCHOR_SCROLLS.get(root) ?? NO_ANCHOR_SCROLLS;
}

const NO_ANCHOR_SCROLLS: ReadonlyMap<Box, AnchorScroll> = new Map();

/**
 * The scroll containers that scroll a box's default anchor and not the box,
 * and whether the pane does (`AnchorScroll.pane`), with `atViewport` saying
 * whether a box is drawn fixed to the viewport; null where nothing scrolls
 * one and not the other.
 */
export function scrollContextOf(
  anchor: Box,
  box: Box,
  atViewport: (box: Box) => boolean,
): { scrollers: Box[]; pane: number } | null {
  let scrollers: Box[] | null = null;
  for (let at = anchor.parent; at; at = at.parent) {
    if (isScroller(at) && movedBy(at, anchor) && !movedBy(at, box)) {
      (scrollers ??= []).push(at);
    }
  }
  const fixedBox = atViewport(box);
  const fixedAnchor = atViewport(anchor);
  const pane = fixedBox === fixedAnchor ? 0 : fixedBox ? 1 : -1;
  if (!scrollers && !pane) return null;
  return { scrollers: scrollers ?? [], pane };
}

/** How far scrolls displace a box's default anchor from it now: the
 *  offsets of the scroll containers between them, as they are scrolled to
 *  (`offsetOf`), and the pane's, where the viewport is. */
export function displacementOf(
  context: { scrollers: readonly Box[]; pane: number },
  viewport: { x: number; y: number } | null,
  offsetOf: (scroller: Box) => ScrollOffset = scrollStateOf,
): [number, number] {
  let x = 0;
  let y = 0;
  for (const scroller of context.scrollers) {
    const at = offsetOf(scroller);
    x += at.x;
    y += at.y;
  }
  if (context.pane && viewport) {
    x += context.pane * viewport.x;
    y += context.pane * viewport.y;
  }
  return [x, y];
}

/** Whether an anchored box still fits what it has to (`AnchorScroll.room`)
 *  with its anchor displaced by `d`: shifted from where it was laid out by
 *  the default scroll shift, the difference from the displacement it was
 *  laid out at, against the edges of the room that stay where they are. */
export function fitsDisplaced(
  state: AnchorScroll,
  [dx, dy]: readonly [number, number],
): boolean {
  if (state.corrected) return false;
  const sx = state.x ? state.rx - dx : 0;
  const sy = state.y ? state.ry - dy : 0;
  const { room, fixedEdges: f } = state;
  return (
    (!(f & 1) || sx >= room.x - 0.5) &&
    (!(f & 2) || sx + state.width <= room.x + room.width + 0.5) &&
    (!(f & 4) || sy >= room.y - 0.5) &&
    (!(f & 8) || sy + state.height <= room.y + room.height + 0.5)
  );
}

/** Note where a layout has the anchors of its tree displaced to, once it
 *  has scrolled everything (`applyScrollOffsets`). */
export function settleAnchorScrolls(
  root: Box,
  viewport: { x: number; y: number } | null,
): void {
  for (const state of ANCHOR_SCROLLS.get(root)?.values() ?? []) {
    const [dx, dy] = displacementOf(state, viewport);
    state.dx = dx;
    state.dy = dy;
  }
}

/**
 * After a scroll — of a container in the document, or of the pane, which
 * has the viewport at `viewport` now — what it did to the anchored boxes
 * whose anchors it displaced: whether each still fits, noted for
 * `position-visibility`, and whether one with position options no longer
 * does where its layout did not try them, which a layout does (CSS Anchor
 * Positioning 1, 6.5): true where one is owed.
 */
export function refitAnchored(
  root: Box,
  viewport: { x: number; y: number } | null,
): boolean {
  const map = ANCHOR_SCROLLS.get(root);
  if (!map) return false;
  let owed = false;
  for (const [box, state] of map) {
    const d = displacementOf(state, viewport);
    const fits = fitsDisplaced(state, d);
    if (box.style.positionVisibility & 2) noteVisibility(root, box, !fits);
    if (
      !fits &&
      state.refits &&
      (Math.abs(d[0] - (state.dx ?? NaN)) > 0.5 ||
        Math.abs(d[1] - (state.dy ?? NaN)) > 0.5)
    ) {
      owed = true;
    }
  }
  return owed;
}

/** How far each box is moved by the pane's scroll (`followPane`), from
 *  where its layout left it. */
const PANE_SHIFT = new WeakMap<Box, [number, number]>();

/** A layout places a box afresh, with no shift of the pane's on it. */
export function forgetPaneShift(box: Box): void {
  PANE_SHIFT.delete(box);
}

/**
 * Move each anchored box whose anchor the pane scrolls and it does not —
 * fixed to the viewport, anchored in the document — or the other way round
 * with its anchor, on the axes it follows it on, to where the pane has the
 * viewport now (CSS Anchor Positioning 1, 3.3): the default scroll shift a
 * scroll of the pane makes, which lays nothing out. The boxes it moved, or
 * null.
 */
export function followPane(
  root: Box,
  viewport: { x: number; y: number } | null,
  move: MoveBox,
): Box[] | null {
  const map = ANCHOR_SCROLLS.get(root);
  if (!map) return null;
  let moved: Box[] | null = null;
  for (const [box, state] of map) {
    if (!state.pane) continue;
    const wantX = state.x && viewport ? -state.pane * viewport.x : 0;
    const wantY = state.y && viewport ? -state.pane * viewport.y : 0;
    const [hadX, hadY] = PANE_SHIFT.get(box) ?? [0, 0];
    if (wantX === hadX && wantY === hadY) continue;
    move(box, wantX - hadX, wantY - hadY, () => false);
    PANE_SHIFT.set(box, [wantX, wantY]);
    (moved ??= []).push(box);
  }
  return moved;
}
