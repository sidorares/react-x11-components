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
  }
  if (to.x || to.y) APPLIED.set(box, to);
  else APPLIED.delete(box);
  return to;
}

/** A scroll offset within `[0, max]`, in whole hundredths: a script's
 *  `scrollTop = 10.004` moves nothing a pixel would show. */
function clampOffset(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(Math.max(0, max), Math.max(0, v)) * 100) / 100;
}

/** Whether an out-of-flow box is positioned against something outside a
 *  scroll container, which then neither moves it nor clips it. */
function escapes(box: Box, scroller: Box): boolean {
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
  const linesOf = (lines: readonly LineBox[] | null, outOfFlow: boolean) => {
    for (const line of lines ?? []) {
      let x2 = line.x + line.width;
      for (const text of line.texts) {
        const natural = text.layout.lines[text.layoutLine];
        if (natural) x2 = Math.max(x2, text.drawX + natural.x + natural.width);
      }
      take(x2, line.y + line.height, outOfFlow);
    }
  };
  const walk = (child: Box, outOfFlow: boolean, margins: boolean) => {
    if (child.kind === 'text' || child.kind === 'break') return;
    if (child.outOfFlow) {
      if (escapes(child, box)) return;
      outOfFlow = true;
      margins = false;
    }
    if (hasRect(child) && child.width + child.height > 0) {
      take(
        child.x + child.width + (margins ? Math.max(0, child.marginRight) : 0),
        child.y +
          child.height +
          (margins ? Math.max(0, child.marginBottom) : 0),
        outOfFlow,
      );
    }
    // what a box clips is its own to scroll
    if (clipsOverflow(child)) return;
    linesOf(child.lines, outOfFlow);
    for (const inner of child.children) walk(inner, outOfFlow, false);
  };
  linesOf(box.lines, false);
  for (const child of box.children) walk(child, false, true);
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
