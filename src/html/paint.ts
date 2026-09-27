// Painting a laid-out document.
//
// Two things make this fast enough to be the answer to "what happens on an
// expose", which is one of the two numbers this component is built around:
//
//  - **Every box carries the bounds of everything it draws**, computed once
//    after layout. A repaint intersects that against `paintDamage()` and
//    skips whole subtrees, so an expose of a 40-pixel strip in a document
//    ten thousand pixels tall touches the handful of boxes that overlap it.
//    Ink bounds rather than the border box, because `overflow: visible` means
//    a child may draw outside its parent and a box-rect test would cull
//    something still on screen.
//  - **A paragraph is one glyph batch.** ntk's `TextLayout.draw` emits every
//    line it holds in a single composite, so paint draws each *layout* once
//    rather than each line — which is why `LineText` records where the
//    layout's origin goes rather than where its line does.
//
// The decorations under and over the glyphs are `src/richtext/runs.ts`'s,
// unchanged: the runs handed to ntk were richtext's `TextRun`s, so what comes
// back on the laid-out lines is exactly what that module already knows how to
// draw.
import {
  canFill,
  lineBands,
  paintRunBackgrounds,
  paintRunRules,
} from '../richtext/runs.js';
import type { FillContext } from '../richtext/runs.js';
import { inkColor, isTransparent, resolve } from './css/values.js';
import type { Len } from './css/values.js';
import type { ComputedStyle, LinearGradient } from './css/style.js';
import {
  BOX_RAISES,
  Box,
  INLINE_OFFSETS,
  SHIFTED_LINES,
  TEXT_RAISES,
  TEXT_SHIFTS,
} from './layout/boxes.js';
import type { BoxTree, LineBox, LineText, Marker } from './layout/boxes.js';
import { depthOf, layoutOffsetOf, layoutOffsets } from './layout/inline.js';
import { halves } from './layout/collapse.js';
import { tableGrid } from './layout/grid.js';
import type { Cell } from './layout/grid.js';
import { SvgDrawing, inlineDrawing } from './svg.js';
import type { IntrinsicSize } from './svg.js';
import type { CollapsedBorder } from './layout/collapse.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The context slice painting uses beyond `FillContext`. Everything optional
 *  is missing on the mock backend, where paint is a structural no-op. */
export interface PaintContext extends FillContext {
  beginPath?(): void;
  rect?(x: number, y: number, w: number, h: number): void;
  roundRect?(x: number, y: number, w: number, h: number, radii: number[]): void;
  fill?(rule?: 'nonzero' | 'evenodd'): void;
  createLinearGradient?(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): { addColorStop(offset: number, color: string): void };
  clip?(): void;
  drawImage?(image: unknown, ...args: number[]): void;
  /** ntk's X11 context has patterns; the Cocoa one does not, and tiles. */
  createPattern?(image: unknown, repetition: string): unknown;
  translate?(x: number, y: number): void;
}

export interface PaintOptions {
  /** Where the document's origin sits in the window. Scrolling is this. */
  originX: number;
  originY: number;
  /** Device pixels per logical pixel, for the run rules — a link's
   *  underline is a logical pixel thick, not a device one. Default 1. */
  scale?: number;
  /** The rectangle being repainted, in window coordinates, or null for all. */
  damage: Rect | null;
  /** The document range the selection covers, in code units, or null. */
  selection: { start: number; end: number } | null;
  selectionColor: string | null;
  /** A decoded image for an element, when the host has one. */
  imageFor(box: Box): unknown | null;
  /** A decoded `background-image`, with its size in CSS pixels, once it has
   *  arrived. An SVG may lack either dimension. */
  backgroundImageFor?(url: string): ({ image: unknown } & IntrinsicSize) | null;
  /** The whole element in window coordinates: the canvas the root's
   *  background covers (CSS 2.1 14.2). Absent, the root box is it. */
  canvas?: Rect;
  /** @internal The box whose background went to the canvas instead. */
  canvasSource?: Box | null;
  /** @internal The boxes clipping what is being painted, outermost first. */
  clips?: ClipLevel[];
  /** @internal Whether the tree has a layer below the flow (`hoistNegative`). */
  negative?: boolean;
}

/**
 * The bounds of everything a box and its descendants draw, in document
 * coordinates, into `boundsX`…, with the text `position: relative` moved off
 * its lines where `moved` says there is some. Computed once per layout; the paint pass
 * reads it. Returns how far down the box's content reaches, for the
 * document's height — handed up rather than kept on every box, where
 * writing it and reading it back cost this walk a fifth of its time.
 */
export function computePaintBounds(box: Box, moved = false): number {
  // A box with no rectangle of its own gives only what it holds: nothing,
  // until a child with bounds is met.
  const own = hasRect(box);
  let x1 = own ? box.x : Infinity;
  let y1 = own ? box.y : Infinity;
  let x2 = own ? box.x + box.width : -Infinity;
  let y2 = own ? box.y + box.height : -Infinity;
  // How far down the content reaches, for the document's height: the
  // border box, and every box and line under it, but not past a box that
  // clips what it holds — where the scrollable overflow ends. Out-of-flow
  // boxes are the layout's to count.
  let bottom = y2;
  const lines = box.lines;
  if (lines) {
    let tallest = 0;
    for (const line of lines) {
      x1 = Math.min(x1, line.x);
      y1 = Math.min(y1, line.y);
      x2 = Math.max(x2, line.x + line.width);
      y2 = Math.max(y2, line.y + line.height);
      tallest = Math.max(tallest, line.height);
      if (moved && SHIFTED_LINES.has(line)) {
        // text `position: relative` moved off its line
        for (const text of line.texts) {
          const natural = text.layout.lines[text.layoutLine];
          if (!natural) continue;
          const x = text.drawX + natural.x;
          const y = text.drawY + natural.y;
          x1 = Math.min(x1, x);
          y1 = Math.min(y1, y);
          x2 = Math.max(x2, x + natural.width);
          y2 = Math.max(y2, y + natural.height);
        }
      }
      for (const placed of line.atomics) {
        const atomic = placed.box;
        computePaintBounds(atomic, moved);
        if (atomic.boundsY === Infinity) continue;
        x1 = Math.min(x1, atomic.boundsX);
        y1 = Math.min(y1, atomic.boundsY);
        x2 = Math.max(x2, atomic.boundsX + atomic.boundsWidth);
        y2 = Math.max(y2, atomic.boundsY + atomic.boundsHeight);
      }
    }
    box.maxLineHeight = tallest;
    if (lines.length) {
      const last = lines[lines.length - 1];
      bottom = Math.max(bottom, last.y + last.height);
    }
  }
  const marker = box.marker;
  if (marker?.layout) {
    // The marker hangs in the padding to the left of the content, so it is
    // outside the border box and has to widen the ink bounds or a repaint
    // clipped to a narrow strip drops it.
    x1 = Math.min(x1, marker.x);
    y1 = Math.min(y1, marker.y);
    x2 = Math.max(x2, marker.x + marker.layout.width);
    y2 = Math.max(y2, marker.y + marker.layout.height);
  }
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    const reach = computePaintBounds(child, moved);
    if (!child.outOfFlow) bottom = Math.max(bottom, reach);
    if (child.boundsY === Infinity) continue;
    x1 = Math.min(x1, child.boundsX);
    y1 = Math.min(y1, child.boundsY);
    x2 = Math.max(x2, child.boundsX + child.boundsWidth);
    y2 = Math.max(y2, child.boundsY + child.boundsHeight);
  }
  if (x1 === Infinity) {
    // nothing to draw: no damage meets it, and no parent takes it in
    box.boundsX = Infinity;
    box.boundsY = Infinity;
    box.boundsWidth = 0;
    box.boundsHeight = 0;
  } else {
    box.boundsX = x1;
    box.boundsY = y1;
    box.boundsWidth = x2 - x1;
    box.boundsHeight = y2 - y1;
  }
  buildChildIndexes(box);
  // whether the box clips only matters where its content reaches past it,
  // and its style is one more object a walk of every box would read
  const end = box.y + box.height;
  if (bottom <= end) return end;
  const style = box.style;
  return box.parent &&
    (style.overflowX !== 'visible' || style.overflowY !== 'visible')
    ? end
    : bottom;
}

/**
 * Whether a box has a rectangle of its own to draw in. An inline box has
 * none: it is drawn on its block's lines, which the block's bounds hold,
 * and its `x`…`height` are never laid out. Nor has a table column, drawn in
 * its cells. Taken for rectangles, their (0, 0, 0, 0) stretched every block
 * with a link in it, and every table with a `<col>`, up to the top of the
 * document — and a paint low in a long document went through every block
 * above the viewport, as did a hit test during a selection drag.
 */
function hasRect(box: Box): boolean {
  if (box.kind === 'inline') return false;
  if (box.kind !== 'block') return true;
  const display = box.style.display;
  return display !== 'table-column' && display !== 'table-column-group';
}

/** Children lists past this size get the sorted viewport index; below it a
 *  linear scan is cheaper than keeping one. */
const PAINT_INDEX_MIN = 64;

function buildChildIndexes(box: Box): void {
  box.paintIndex = null;
  box.positionedPaint = null;
  let positioned: Box[] | null = null;
  let paintable = 0;
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (layered(box, child)) (positioned ??= []).push(child);
    else if (!onLine(box, child)) paintable += 1;
  }
  if (positioned) {
    // Pre-sorted once per layout instead of filtered and sorted per paint.
    positioned.sort(byZIndex);
    box.positionedPaint = positioned;
  }
  if (paintable < PAINT_INDEX_MIN) return;
  const boxes: Box[] = [];
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (!layered(box, child) && !onLine(box, child)) boxes.push(child);
  }
  const order = boxes.map((_, i) => i);
  order.sort((a, b) => boxes[a].boundsY - boxes[b].boundsY);
  const sorted = order.map((i) => boxes[i]);
  const prefixBottom: number[] = new Array<number>(sorted.length);
  let running = -Infinity;
  for (let i = 0; i < sorted.length; i += 1) {
    running = Math.max(running, sorted[i].boundsY + sorted[i].boundsHeight);
    prefixBottom[i] = running;
  }
  box.paintIndex = { boxes: sorted, order, prefixBottom };
}

/**
 * The children whose ink can touch `[top, bottom)`, in document order.
 * The prefix maximum of bottoms is monotone, so the first candidate is a
 * binary search; the scan stops at the first sorted top past the bottom.
 */
export function queryChildIndex(
  index: NonNullable<Box['paintIndex']>,
  top: number,
  bottom: number,
): Box[] {
  const { boxes, order, prefixBottom } = index;
  let lo = 0;
  let hi = boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefixBottom[mid] > top) hi = mid;
    else lo = mid + 1;
  }
  const hits: { at: number; box: Box }[] = [];
  for (let i = lo; i < boxes.length; i += 1) {
    const child = boxes[i];
    if (child.boundsY >= bottom) break;
    if (child.boundsY + child.boundsHeight > top)
      hits.push({ at: order[i], box: child });
  }
  // Paint order is document order; the handful of visible children sort in
  // no time, where sorting the whole list per paint was the point of not
  // filtering per paint.
  hits.sort((a, b) => a.at - b.at);
  return hits.map((h) => h.box);
}

/** Paint a laid-out document. */
export function paintDocument(
  ctx: PaintContext,
  tree: BoxTree,
  options: PaintOptions,
): void {
  if (!canFill(ctx)) return;
  ctx.save();
  const canvas = canvasBackground(tree.root);
  if (canvas) paintCanvas(ctx, canvas, tree.root, options);
  paintBox(ctx, tree.root, {
    ...options,
    canvasSource: canvas?.source,
    negative: tree.negative,
  });
  ctx.restore();
}

/**
 * Whose background covers the canvas (CSS 2.1 14.2): the root element's,
 * or — where `<html>` has neither a colour nor an image — the first
 * `<body>`'s, which then paints no background of its own. A document with
 * no `<html>` tag has the root box standing in for its root element, and a
 * `<body>` in it is still the body: mail often starts at `<body style>`.
 * `anchor` is the box the image is positioned against: the root element's,
 * whichever box it came from.
 */
function canvasBackground(root: Box): { source: Box; anchor: Box } | null {
  const has = (b: Box) =>
    !isTransparent(b.style.backgroundColor) ||
    !!b.style.backgroundImage ||
    !!b.style.backgroundGradient;
  const top = root.children.find((c) => c.el?.name === 'html') ?? root;
  if (has(top)) return { source: top, anchor: top };
  const body = top.children.find((c) => c.el?.name === 'body');
  return body && has(body) ? { source: body, anchor: top } : null;
}

function paintCanvas(
  ctx: PaintContext,
  { source, anchor }: { source: Box; anchor: Box },
  root: Box,
  options: PaintOptions,
): void {
  const whole = options.canvas ?? {
    x: root.x + options.originX,
    y: root.y + options.originY,
    width: root.width,
    height: root.height,
  };
  const area = clampRect(
    options,
    Math.round(whole.x),
    Math.round(whole.y),
    Math.ceil(whole.width),
    Math.ceil(whole.height),
  );
  if (!area) return;
  const style = source.style;
  if (
    !isTransparent(style.backgroundColor) &&
    source.style.visibility !== 'hidden'
  ) {
    ctx.fillStyle = inkColor(style.backgroundColor as string, style.color);
    ctx.fillRect(area.x, area.y, area.w, area.h);
  }
  if (
    style.backgroundGradient &&
    ctx.createLinearGradient &&
    source.style.visibility !== 'hidden'
  ) {
    // sized by the root element's box and repeated down the canvas, as a
    // browser does — the stripes a short page with a gradient on its body
    // shows — or by the viewport, where it is fixed
    const box =
      style.backgroundAttachment === 'fixed' && options.canvas
        ? options.canvas
        : paddingBox(anchor, options);
    paintGradient(
      ctx,
      style,
      style.backgroundGradient,
      area,
      snapped(box.x, box.y, box.width, box.height),
    );
  }
  if (style.backgroundImage) {
    paintBackgroundImage(
      ctx,
      style,
      area,
      paddingBox(anchor, options),
      options,
    );
  }
}

/** A box's padding box in window coordinates: where a background image is
 *  positioned. */
function paddingBox(box: Box, options: PaintOptions): Rect {
  return {
    x: box.x + box.borderLeft + options.originX,
    y: frameY(box) + box.borderTop + options.originY,
    width: box.width - box.borderLeft - box.borderRight,
    height: frameHeight(box) - box.borderTop - box.borderBottom,
  };
}

/** What the background and border painters read of a box — which an
 *  inline box's fragment on a line is as well. */
type Frame = Pick<
  Box,
  | 'x'
  | 'y'
  | 'width'
  | 'height'
  | 'captionTop'
  | 'captionBottom'
  | 'borderTop'
  | 'borderRight'
  | 'borderBottom'
  | 'borderLeft'
  | 'style'
>;

/** Where a box's background and border go: its border box, which for a
 *  table leaves out the captions around it (CSS 2.1 17.4). */
function frameY(box: Frame): number {
  return box.y + box.captionTop;
}

function frameHeight(box: Frame): number {
  return box.height - box.captionTop - box.captionBottom;
}

function paintBox(ctx: PaintContext, box: Box, options: PaintOptions): void {
  if (!intersects(box, options)) return;
  // `clip` shows the part of an absolutely positioned box it names, its own
  // background and borders among it (CSS 2.1 11.1.2)
  const clip = box.outOfFlow && box.style.clip ? clipOf(box, options) : null;
  if (clip) {
    if (clip.w <= 0 || clip.h <= 0) return;
    if (!pushClip(ctx, clip, null)) {
      paintContent(ctx, box, options);
      return;
    }
  }
  paintContent(ctx, box, options);
  if (clip) ctx.restore();
}

function paintContent(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  const visible = box.style.visibility === 'visible';
  if (visible) paintOwnBackground(ctx, box, options);
  // a stacking context's descendants with a negative `z-index`, over its
  // background and under everything else in it (CSS 2.1 Appendix E)
  const below = options.negative ? NEGATIVE.get(box) : undefined;
  if (below) {
    for (const child of below) paintPositioned(ctx, child, options);
  }
  if (visible) {
    if (box.marker) paintMarker(ctx, box.marker, options);
    if (box.replaced === 'image') paintImage(ctx, box, options);
    else if (box.replaced === 'svg') paintSvg(ctx, box, options);
  }

  // A box that does not let its content overflow clips it to its padding
  // box, rounded where the box is (CSS 2.1 11.1.1). Everything inside is
  // clipped but a positioned box whose containing block is outside: that
  // is painted once this clip is gone (`paintPositioned`).
  let level: ClipLevel | null = null;
  const clips = clipsOverflow(box);
  // a table's captions are outside the table box that clips, and painted
  // before it does
  if (clips && box.kind === 'table') {
    for (const child of box.children) {
      if (child.kind === 'table-caption') paintBox(ctx, child, options);
    }
  }
  if (clips) {
    // on the pixels the box's own background covers, inside its borders:
    // rounded out to whole pixels instead, a box at a fractional position
    // showed a row of what it clips beyond its background's edge
    const left = box.x + options.originX;
    const top = frameY(box) + options.originY;
    const x = Math.round(left);
    const y = Math.round(top);
    const rect = {
      x: x + box.borderLeft,
      y: y + box.borderTop,
      w: Math.round(left + box.width) - x - box.borderLeft - box.borderRight,
      h:
        Math.round(top + frameHeight(box)) -
        y -
        box.borderTop -
        box.borderBottom,
    };
    if (pushClip(ctx, rect, innerRadii(box))) {
      level = { box, deferred: [] };
      (options.clips ??= []).push(level);
    }
  }

  // The flow this box holds, in CSS 2.1 Appendix E's order: the backgrounds
  // and borders of its in-flow blocks, then its floats, then the lines of
  // them all, then its positioned boxes. Painted a block at a time instead,
  // a float was covered by the background of every block after it — the
  // shaded paragraph beside a floated image hid the image — and a block's
  // text by the next one's background where a negative margin overlapped
  // them. A child that is no plain block of the flow — a table, a flex box,
  // a box that clips, a replaced element — is painted whole in its place.
  const floats: Box[] = [];
  const positioned: Box[] = [];
  paintFlowBackgrounds(ctx, box, options, floats, positioned);
  for (const float of floats) paintBox(ctx, float, options);
  // a hidden box's text is drawn in no ink, so that a visible element's in
  // it is drawn (`runFor`)
  if (box.lines) paintLines(ctx, box, options);
  paintFlowLines(ctx, box, options);
  if (box.collapsed && visible) paintCollapsedBorders(ctx, box, options);

  // `z-index: auto` and 0 in document order, then the positive ones
  if (positioned.length > 1) positioned.sort(byZIndex);
  for (const child of positioned) paintPositioned(ctx, child, options);
  if (level) {
    ctx.restore();
    options.clips!.pop();
    for (const child of level.deferred) paintPositioned(ctx, child, options);
  }
}

/** A box's own background, background image and borders, and a table's
 *  parts' backgrounds; a row or a row group paints none of its own. */
function paintOwnBackground(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  // A row or a row group paints nothing of its own: its background is
  // painted in its cells' areas with the table's (`paintPartBackgrounds`),
  // and its borders are the collapsed grid's or none (CSS 2.1 17.6.1)
  if (box.kind === 'table-row' || box.kind === 'table-row-group') return;
  const style = box.style;
  if (box !== options.canvasSource) {
    paintBackground(ctx, box, options);
    if (style.backgroundImage) {
      const left = box.x + options.originX;
      const top = frameY(box) + options.originY;
      const area = clampRect(
        options,
        Math.round(left),
        Math.round(top),
        Math.round(left + box.width) - Math.round(left),
        Math.round(top + frameHeight(box)) - Math.round(top),
      );
      if (area) {
        paintBackgroundImage(
          ctx,
          style,
          area,
          paddingBox(box, options),
          options,
        );
      }
    }
  }
  if (!box.bordersCollapsed) paintBorders(ctx, box, options);
  if (box.kind === 'table') paintPartBackgrounds(ctx, box, options);
}

/** The children of a box a paint may reach, in document order: where the
 *  box keeps a viewport index, those whose ink meets the damage — which
 *  leaves its positioned children out, for `positionedPaint` to give. */
function paintedChildren(box: Box, options: PaintOptions): readonly Box[] {
  const damage = options.damage;
  if (!box.paintIndex || !damage) return box.children;
  return queryChildIndex(
    box.paintIndex,
    damage.y - options.originY,
    damage.y + damage.height - options.originY,
  );
}

/** Whether a child is a plain block of its parent's flow, whose background
 *  goes with the flow's and whose lines with its lines: an in-flow block
 *  that clips nothing and is no stacking context holding a negative
 *  `z-index`, in a parent that is no flex box, where an item is painted
 *  whole (CSS Flexbox 5.4). */
function inFlow(parent: Box, child: Box, options: PaintOptions): boolean {
  if (child.kind !== 'block' || parent.kind === 'flex') return false;
  if (options.negative && NEGATIVE.has(child)) return false;
  const style = child.style;
  return style.overflowX === 'visible' && style.overflowY === 'visible';
}

/**
 * The first pass over a box's flow: each plain block's background and
 * borders, in document order and at any depth, while the floats and the
 * positioned boxes met on the way are kept for their own passes. A child
 * that is no plain block is left for the last pass, where it is painted
 * whole among the lines: its text is text, over every block background,
 * and it stands beside the floats rather than under them.
 */
function paintFlowBackgrounds(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  floats: Box[],
  positioned: Box[],
): void {
  const indexed = box.paintIndex !== null && !!options.damage;
  if (indexed && box.positionedPaint) {
    for (const child of box.positionedPaint) {
      if (!(options.negative && HOISTED.has(child))) positioned.push(child);
    }
  }
  for (const child of paintedChildren(box, options)) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (layered(box, child)) {
      if (!indexed && !(options.negative && HOISTED.has(child))) {
        positioned.push(child);
      }
      continue;
    }
    if (onLine(box, child)) continue;
    if (child.isFloat) {
      floats.push(child);
      continue;
    }
    if (!inFlow(box, child, options) || !intersects(child, options)) continue;
    if (child.style.visibility === 'visible') {
      paintOwnBackground(ctx, child, options);
    }
    paintFlowBackgrounds(ctx, child, options, floats, positioned);
  }
}

/** The last pass over a box's flow: the plain blocks' markers and lines,
 *  and the children painted whole, in document order and at any depth,
 *  over the floats. */
function paintFlowLines(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  for (const child of paintedChildren(box, options)) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (layered(box, child) || onLine(box, child) || child.isFloat) continue;
    if (!inFlow(box, child, options)) {
      // a clipping table's captions were painted before its clip
      if (child.kind === 'table-caption' && clipsOverflow(box)) continue;
      paintBox(ctx, child, options);
      continue;
    }
    if (!intersects(child, options)) continue;
    if (child.marker && child.style.visibility === 'visible') {
      paintMarker(ctx, child.marker, options);
    }
    if (child.lines) paintLines(ctx, child, options);
    paintFlowLines(ctx, child, options);
  }
}

/** A box clipping what it holds, and the positioned boxes inside it that
 *  escape the clip, waiting for it to end. */
interface ClipLevel {
  box: Box;
  deferred: Box[];
}

/**
 * A positioned box, painted under the clips of the boxes its containing
 * block is inside and no others (CSS 2.1 11.1.1): a clip it escapes puts
 * it off until that clip ends. A fixed box escapes them all.
 */
function paintPositioned(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  const clips = options.clips;
  if (clips?.length && box.outOfFlow) {
    let escaped = clips.length;
    if (box.style.position !== 'fixed') {
      let containing = box.parent;
      while (containing?.parent && containing.style.position === 'static') {
        containing = containing.parent;
      }
      escaped = 0;
      for (let i = clips.length - 1; i >= 0; i -= 1) {
        if (holds(clips[i].box, containing)) break;
        escaped += 1;
      }
    }
    if (escaped > 0) {
      clips[clips.length - escaped].deferred.push(box);
      return;
    }
  }
  paintBox(ctx, box, options);
}

/** Whether `inner` is `outer` or inside it. */
function holds(outer: Box, inner: Box | null): boolean {
  for (let at = inner; at; at = at.parent) if (at === outer) return true;
  return false;
}

/**
 * Whether a box clips its content: `overflow` other than `visible`, on a
 * block container (CSS 2.1 11.1.1) — not a table, a row or a row group.
 * The root element's `overflow` is the viewport's, and so is the
 * `<body>`'s where the root's is `visible`, an `<html>` the markup left out
 * among them; the viewport here is the element, which clips anyway.
 */
function clipsOverflow(box: Box): boolean {
  const style = box.style;
  if (style.overflowX === 'visible' && style.overflowY === 'visible') {
    return false;
  }
  const parent = box.parent;
  if (!parent) return false;
  switch (box.kind) {
    case 'block':
    case 'table-cell':
    case 'table-caption':
    case 'flex':
    // the table box, its captions outside it (the CSS 2.1 errata, 11.1.1)
    case 'table':
      break;
    default:
      return false;
  }
  const name = box.el?.name;
  if (name === 'html') return false;
  if (name === 'body') {
    if (parent.el?.name !== 'html') return !!parent.parent;
    return (
      parent.style.overflowX !== 'visible' ||
      parent.style.overflowY !== 'visible'
    );
  }
  return true;
}

/** A box's `clip` region, in window coordinates. */
function clipOf(
  box: Box,
  options: PaintOptions,
): { x: number; y: number; w: number; h: number } {
  const clip = box.style.clip!;
  const left = clip.left ?? 0;
  const top = clip.top ?? 0;
  const right = clip.right ?? box.width;
  const bottom = clip.bottom ?? box.height;
  const x = Math.round(box.x + options.originX + left);
  const y = Math.round(box.y + options.originY + top);
  return {
    x,
    y,
    w: Math.round(box.x + options.originX + right) - x,
    h: Math.round(box.y + options.originY + bottom) - y,
  };
}

/**
 * The radii of a box's padding edge — its border radii less the borders —
 * for a clip, or null where a rectangle clips the same: padding at least a
 * corner's radius on both of its sides keeps the content box clear of the
 * corner, so only content overflowing it both ways at once could tell them
 * apart. A rounded clip is a mask the size of the window on X11, and a code
 * block — rounded, padded, `overflow: hidden` — had one made for every
 * paint.
 */
function innerRadii(box: Box): number[] | null {
  const radii = box.style.borderRadius;
  if (!radii.some((r) => r > 0)) return null;
  const [tl, tr, br, bl] = radii;
  const inner = [
    Math.max(0, tl - Math.max(box.borderTop, box.borderLeft)),
    Math.max(0, tr - Math.max(box.borderTop, box.borderRight)),
    Math.max(0, br - Math.max(box.borderBottom, box.borderRight)),
    Math.max(0, bl - Math.max(box.borderBottom, box.borderLeft)),
  ];
  if (
    clearOf(inner[0], box.padLeft, box.padTop) &&
    clearOf(inner[1], box.padRight, box.padTop) &&
    clearOf(inner[2], box.padRight, box.padBottom) &&
    clearOf(inner[3], box.padLeft, box.padBottom)
  ) {
    return null;
  }
  return inner;
}

/** Whether padding of `x` and `y` beside a corner of radius `r` keeps the
 *  content box out of it. */
function clearOf(r: number, x: number, y: number): boolean {
  return x >= r && y >= r;
}

/** Clip what follows to a rectangle, rounded where `radii` are: false
 *  where the context cannot clip, and nothing was pushed. */
function pushClip(
  ctx: PaintContext,
  rect: { x: number; y: number; w: number; h: number },
  radii: number[] | null,
): boolean {
  if (!ctx.beginPath || !ctx.rect || !ctx.clip) return false;
  ctx.save();
  ctx.beginPath();
  const w = Math.max(0, rect.w);
  const h = Math.max(0, rect.h);
  if (radii && ctx.roundRect) ctx.roundRect(rect.x, rect.y, w, h, radii);
  else ctx.rect(rect.x, rect.y, w, h);
  ctx.clip();
  return true;
}

/**
 * Whether a child is painted with the positioned boxes, after the flow
 * rather than in it: an absolutely positioned box, and a relatively
 * positioned block, which CSS paints among them in document order (CSS 2.1
 * Appendix E) — a relative box after an absolute one covers it. An inline
 * or an inline-block is painted by its line.
 */
function layered(parent: Box, child: Box): boolean {
  if (child.outOfFlow) return true;
  const position = child.style.position;
  if (position !== 'relative' && position !== 'sticky') return false;
  return child.kind !== 'inline' && !onLine(parent, child);
}

/**
 * Whether a child is painted by its parent's lines rather than as a child:
 * an inline-block or an image in a line of text is placed on the line, and
 * `paintLines` paints it there. Painted as a child as well, its text was
 * drawn twice — darker at every antialiased edge — and a translucent
 * background had its alpha doubled.
 */
function onLine(parent: Box, child: Box): boolean {
  if (parent.lines === null && parent.kind !== 'inline') return false;
  if (child.isFloat || child.outOfFlow) return false;
  return (
    child.kind !== 'inline' && child.kind !== 'text' && child.kind !== 'break'
  );
}

/** Per stacking context, its descendants with a negative `z-index`, in
 *  paint order; and every box so placed, which its parent's positioned
 *  children then leave out. Kept beside the boxes: few documents have one. */
const NEGATIVE = new WeakMap<Box, Box[]>();
const HOISTED = new WeakSet<Box>();

/**
 * Give each stacking context — the root, and a positioned box with a
 * `z-index` — the positioned descendants with a negative `z-index` it paints
 * below its flow (CSS 2.1 9.9.1, Appendix E). They were painted with the
 * rest of the positioned boxes, over the flow, so a box set behind the page
 * with `z-index: -1` covered what it was meant to be under. Asked only of a
 * tree that has one (`BoxTree.negative`).
 */
export function hoistNegative(root: Box): void {
  hoistFrom(root, true);
}

function hoistFrom(box: Box, root: boolean): Box[] | null {
  let pending: Box[] | null = null;
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    // the root element is the root stacking context, over its own borders
    const up = hoistFrom(child, root && child.el?.name === 'html');
    if (up) (pending ??= []).push(...up);
    const z = child.style.zIndex;
    if (child.style.position !== 'static' && typeof z === 'number' && z < 0) {
      (pending ??= []).push(child);
    }
  }
  const style = box.style;
  if (!root && (style.position === 'static' || style.zIndex === 'auto')) {
    return pending;
  }
  if (pending) {
    pending.sort(byZIndex);
    NEGATIVE.set(box, pending);
    for (const b of pending) HOISTED.add(b);
  } else {
    NEGATIVE.delete(box);
  }
  return null;
}

function byZIndex(a: Box, b: Box): number {
  const az = a.style.zIndex === 'auto' ? 0 : a.style.zIndex;
  const bz = b.style.zIndex === 'auto' ? 0 : b.style.zIndex;
  return az - bz;
}

/** Whether anything this box or its descendants draw is in the damage. */
function intersects(box: Box, options: PaintOptions): boolean {
  const damage = options.damage;
  if (!damage) return true;
  const x = box.boundsX + options.originX;
  const y = box.boundsY + options.originY;
  return (
    x < damage.x + damage.width &&
    x + box.boundsWidth > damage.x &&
    y < damage.y + damage.height &&
    y + box.boundsHeight > damage.y
  );
}

/**
 * A fill rectangle clamped to the neighbourhood of the damage.
 *
 * Load-bearing, not an optimization: the X protocol carries a fill's
 * position as Int16 and its size as Uint16, so the background of a box
 * hundreds of thousands of pixels tall *thrown at the server whole* dies in
 * the request encoder — the pixels beyond the viewport were never going to
 * exist, but the numbers still had to fit. The margin keeps rounded corners
 * and antialiasing outside the damage honest; with no damage at all the
 * Int16 envelope itself is the clamp.
 */
const CLAMP_PAD = 64;

function clampRect(
  options: PaintOptions,
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  const damage = options.damage;
  const left = damage ? damage.x - CLAMP_PAD : -COORD_LIMIT;
  const top = damage ? damage.y - CLAMP_PAD : -COORD_LIMIT;
  const right = damage ? damage.x + damage.width + CLAMP_PAD : COORD_LIMIT;
  const bottom = damage ? damage.y + damage.height + CLAMP_PAD : COORD_LIMIT;
  const x1 = Math.max(x, left);
  const y1 = Math.max(y, top);
  const x2 = Math.min(x + w, right);
  const y2 = Math.min(y + h, bottom);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function paintBackground(
  ctx: PaintContext,
  box: Frame,
  options: PaintOptions,
): void {
  const color = box.style.backgroundColor;
  const gradient = box.style.backgroundGradient;
  const solid = !isTransparent(color);
  if (!solid && !gradient) return;
  // each edge on the pixel it falls nearest, as browsers snap a box: boxes
  // that meet share the column their edge is in, and a rule 1.33px wide is
  // one pixel, not two
  const left = box.x + options.originX;
  const top = frameY(box) + options.originY;
  const x = Math.round(left);
  const y = Math.round(top);
  const w = Math.round(left + box.width) - x;
  const h = Math.round(top + frameHeight(box)) - y;
  const rect = clampRect(options, x, y, w, h);
  if (!rect) return;
  const radii = box.style.borderRadius;
  const rounded =
    radii.some((r) => r > 0) && ctx.roundRect && ctx.fill && ctx.beginPath;
  const fill = (): void => {
    if (rounded) {
      // The clamp can only have cut edges further than CLAMP_PAD outside
      // the damage, and a sane radius is smaller than that — so a corner
      // that survives the cut is whole, and a cut edge is offscreen.
      ctx.beginPath!();
      ctx.roundRect!(rect.x, rect.y, rect.w, rect.h, radii.slice());
      ctx.fill!();
    } else ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  };
  if (solid) {
    ctx.fillStyle = inkColor(color as string, box.style.color);
    fill();
  }
  if (gradient && ctx.createLinearGradient) {
    // over the colour, as the layer an image is: the size of the padding
    // box, which is where it starts, and repeated under the borders — or
    // the viewport's, where it is fixed; its line runs across the whole of
    // it, not the part this paint reaches
    const fixed = box.style.backgroundAttachment === 'fixed' && options.canvas;
    const at = fixed
      ? snapped(fixed.x, fixed.y, fixed.width, fixed.height)
      : snapped(
          left + box.borderLeft,
          top + box.borderTop,
          box.width - box.borderLeft - box.borderRight,
          frameHeight(box) - box.borderTop - box.borderBottom,
        );
    if (rounded) {
      // one fill in the rounded shape; under the borders it carries on
      // with its end colours where a browser would show the next tile
      if (!(at.width > 0 && at.height > 0)) return;
      ctx.fillStyle = linearGradient(
        ctx,
        gradient,
        at.x,
        at.y,
        at.width,
        at.height,
        box.style.color,
      );
      fill();
    } else paintGradient(ctx, box.style, gradient, rect, at);
  }
}

/** A rectangle with each edge on the pixel it falls nearest. */
function snapped(x: number, y: number, w: number, h: number): Rect {
  const left = Math.round(x);
  const top = Math.round(y);
  return {
    x: left,
    y: top,
    width: Math.round(x + w) - left,
    height: Math.round(y + h) - top,
  };
}

/**
 * A gradient layer across `area`: an image the size of `at`, where it
 * starts, repeated as `background-repeat` says (CSS Backgrounds 3, 3.9 —
 * an image with no size of its own is the size of its positioning area).
 * Each tile is its own fill, so a tile's colours are the first's.
 */
function paintGradient(
  ctx: PaintContext,
  style: ComputedStyle,
  gradient: LinearGradient,
  area: { x: number; y: number; w: number; h: number },
  at: Rect,
): void {
  const w = at.width;
  const h = at.height;
  if (!(w > 0 && h > 0)) return;
  const repeat = style.backgroundRepeat;
  const acrossX = repeat === 'repeat' || repeat === 'repeat-x';
  const acrossY = repeat === 'repeat' || repeat === 'repeat-y';
  const fromX = acrossX ? at.x - Math.ceil((at.x - area.x) / w) * w : at.x;
  const fromY = acrossY ? at.y - Math.ceil((at.y - area.y) / h) * h : at.y;
  const toX = acrossX ? area.x + area.w : at.x + w;
  const toY = acrossY ? area.y + area.h : at.y + h;
  if (Math.ceil((toX - fromX) / w) * Math.ceil((toY - fromY) / h) > MAX_TILES) {
    // a sliver of a root repeated down a long canvas: the one tile, and
    // its end colours on past it
    ctx.fillStyle = linearGradient(
      ctx,
      gradient,
      at.x,
      at.y,
      w,
      h,
      style.color,
    );
    ctx.fillRect(area.x, area.y, area.w, area.h);
    return;
  }
  for (let y = fromY; y < toY; y += h) {
    const top = Math.max(y, area.y);
    const bottom = Math.min(y + h, area.y + area.h);
    if (bottom <= top) continue;
    for (let x = fromX; x < toX; x += w) {
      const left = Math.max(x, area.x);
      const right = Math.min(x + w, area.x + area.w);
      if (right <= left) continue;
      ctx.fillStyle = linearGradient(ctx, gradient, x, y, w, h, style.color);
      ctx.fillRect(left, top, right - left, bottom - top);
    }
  }
}

/**
 * A `linear-gradient()` across a box (CSS Images 3, 3.1.1): its line
 * through the box's centre at its angle, as long as the box is across at
 * that angle, so its ends are the colours at the corners that line points
 * to; a corner's angle is the one whose perpendicular runs through the
 * other two corners. A stop without a position is spread evenly between
 * its neighbours', and none is before the one before it. A stop off the
 * line lengthens it, so the colours at its ends are the ones between.
 */
function linearGradient(
  ctx: PaintContext,
  gradient: LinearGradient,
  x: number,
  y: number,
  w: number,
  h: number,
  currentColor: string,
): unknown {
  let angle = gradient.angle;
  if (gradient.corner) {
    const turn = Math.atan2(h, w);
    angle =
      gradient.corner === 'top right'
        ? turn
        : gradient.corner === 'bottom right'
          ? Math.PI - turn
          : gradient.corner === 'bottom left'
            ? Math.PI + turn
            : 2 * Math.PI - turn;
  }
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  const length = Math.abs(w * dx) + Math.abs(h * dy);
  const stops = gradient.stops;
  const at: (number | null)[] = stops.map((stop) =>
    stop.at === null
      ? null
      : length > 0
        ? resolve(stop.at, length) / length
        : 0,
  );
  if (at[0] === null) at[0] = 0;
  if (at[at.length - 1] === null) at[at.length - 1] = 1;
  for (let i = 1; i < at.length; i += 1) {
    if (at[i] === null) {
      // spread the ones without a position between the ones with
      let j = i;
      while (at[j] === null) j += 1;
      const from = at[i - 1]!;
      const to = at[j]!;
      for (let k = i; k < j; k += 1) {
        at[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
      }
    }
    at[i] = Math.max(at[i]!, at[i - 1]!);
  }
  // the context's offsets are 0 to 1, so a line that stops reach past runs
  // from the first to the last, and the box sees the part of it between
  const from = Math.min(0, at[0]!);
  const to = Math.max(1, at[at.length - 1]!);
  const startX = x + w / 2 - (dx * length) / 2;
  const startY = y + h / 2 - (dy * length) / 2;
  const g = ctx.createLinearGradient!(
    startX + dx * length * from,
    startY + dy * length * from,
    startX + dx * length * to,
    startY + dy * length * to,
  );
  for (let i = 0; i < stops.length; i += 1) {
    g.addColorStop(
      (at[i]! - from) / (to - from),
      inkColor(stops[i].color, currentColor),
    );
  }
  return g;
}

/**
 * The backgrounds of a table's column groups, columns, row groups and rows
 * (CSS 2.1 17.5.1), in that order: over the table's own and under its
 * cells', in the area of each cell in them. So the spacing between the
 * cells shows the table, and a row group with no cells in it shows nothing,
 * as neither laid its background over the whole of its box. An image is
 * placed against the part's own box and seen through its cells. A column is
 * laid out nowhere, so its box is the one its cells make: from the first of
 * its columns to the last, and from the table's first row to its last. And
 * where borders are separate a part's edges are its cells' border edges
 * (17.5.1), so a row's box runs from its first cell to its last, without
 * the spacing either side of them that the row's laid-out box holds.
 */
function paintPartBackgrounds(
  ctx: PaintContext,
  table: Box,
  options: PaintOptions,
): void {
  const grid = tableGrid(table);
  const { cells } = grid;
  const layers: [(Box | null)[], (cell: Cell) => number][] = [
    [grid.columnGroups, columnOf],
    [grid.columnBoxes, columnOf],
    [grid.groups, (cell) => cell.row],
    [grid.rows, (cell) => cell.row],
  ];
  // each part's box, and the cells' extent across the table, found once
  const areas = new Map<Box, Rect>();
  let across: Rect | null = null;
  for (const [layer, indexOf] of layers) {
    if (!layer.some(paintsPart)) continue;
    const columns = indexOf === columnOf;
    for (const cell of cells) {
      const part = layer[indexOf(cell)];
      if (!part || !paintsPart(part)) continue;
      const box = cell.box;
      paintBackground(
        ctx,
        {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          captionTop: 0,
          captionBottom: 0,
          borderTop: 0,
          borderRight: 0,
          borderBottom: 0,
          borderLeft: 0,
          style: part.style,
        },
        options,
      );
      if (part.style.backgroundImage) {
        const left = box.x + options.originX;
        const top = box.y + options.originY;
        const area = clampRect(
          options,
          Math.round(left),
          Math.round(top),
          Math.round(left + box.width) - Math.round(left),
          Math.round(top + box.height) - Math.round(top),
        );
        if (area) {
          let at = areas.get(part);
          if (!at) {
            at = columns
              ? columnBox(part, layer, grid.rows, cells, options)
              : paddingBox(part, options);
            if (!columns && table.style.borderCollapse !== 'collapse') {
              across ??= columnBox(null, null, grid.rows, cells, options);
              at = { ...at, x: across.x, width: across.width };
            }
            areas.set(part, at);
          }
          paintBackgroundImage(ctx, part.style, area, at, options);
        }
      }
    }
  }
}

const columnOf = (cell: Cell): number => cell.column;

/** Whether a table part has a background to paint: a colour, or an image. */
function paintsPart(box: Box | null): boolean {
  if (box === null || box.style.visibility !== 'visible') return false;
  return (
    !isTransparent(box.style.backgroundColor) || !!box.style.backgroundImage
  );
}

/** The box a column or a column group would have, in window coordinates:
 *  across its columns, as its cells lay them out, and down the table's
 *  rows — or, with no part, across all of them. */
function columnBox(
  part: Box | null,
  layer: (Box | null)[] | null,
  rows: Box[],
  cells: Cell[],
  options: PaintOptions,
): Rect {
  let first = 0;
  let last = 0;
  if (part && layer) {
    first = layer.indexOf(part);
    last = layer.lastIndexOf(part);
  } else {
    for (const cell of cells) {
      last = Math.max(last, cell.column + cell.colSpan - 1);
    }
  }
  let left = Infinity;
  let right = -Infinity;
  for (const cell of cells) {
    if (cell.column === first) left = Math.min(left, cell.box.x);
    if (cell.column + cell.colSpan - 1 === last) {
      right = Math.max(right, cell.box.x + cell.box.width);
    }
  }
  const top = rows.length ? rows[0].y : 0;
  const end = rows.length ? rows[rows.length - 1] : null;
  const bottom = end ? end.y + end.height : 0;
  if (!(right > left)) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: left + options.originX,
    y: top + options.originY,
    width: right - left,
    height: bottom - top,
  };
}

/** How many tiles a repeating background may draw one by one, where the
 *  context has no pattern to fill with. Past it, the image draws once. */
const MAX_TILES = 4096;

/**
 * A `background-image` (CSS 2.1 14.2.1): positioned in `at`, the padding
 * box — or the viewport, the element, for `background-attachment: fixed` —
 * repeated across `area`, the border box within the damage, over the
 * colour and under the borders. Filled with a pattern where the context has
 * one, drawn a tile at a time where it does not.
 */
function paintBackgroundImage(
  ctx: PaintContext,
  style: ComputedStyle,
  area: { x: number; y: number; w: number; h: number },
  at: Rect,
  options: PaintOptions,
): void {
  if (style.backgroundAttachment === 'fixed' && options.canvas) {
    at = options.canvas;
  }
  const url = style.backgroundImage;
  const loaded = url ? options.backgroundImageFor?.(url) : null;
  if (!loaded) return;
  const svg = loaded.image instanceof SvgDrawing ? loaded.image : null;
  if (!svg && !ctx.drawImage) return;
  // an image pixel is a CSS pixel, and the box is device
  const scale = options.scale ?? 1;
  const [iw, ih] = tileSize(loaded, at, scale);
  if (!(iw > 0 && ih > 0)) return;
  const offset = (len: Len, extent: number, size: number): number =>
    resolve(len, extent - size);
  const x0 = Math.round(at.x + offset(style.backgroundPositionX, at.width, iw));
  const y0 = Math.round(
    at.y + offset(style.backgroundPositionY, at.height, ih),
  );
  const repeat = style.backgroundRepeat;
  const acrossX = repeat === 'repeat' || repeat === 'repeat-x';
  const acrossY = repeat === 'repeat' || repeat === 'repeat-y';
  // the tiles that reach the area: from the first at or before its edge
  const fromX = acrossX ? x0 - Math.ceil((x0 - area.x) / iw) * iw : x0;
  const fromY = acrossY ? y0 - Math.ceil((y0 - area.y) / ih) * ih : y0;
  const toX = acrossX ? area.x + area.w : x0 + iw;
  const toY = acrossY ? area.y + area.h : y0 + ih;

  ctx.save();
  if (ctx.beginPath && ctx.rect && ctx.clip) {
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
  }
  const tiles = Math.ceil((toX - fromX) / iw) * Math.ceil((toY - fromY) / ih);
  if (svg) {
    // a drawing is drawn a tile at a time, at the size it was given
    if (tiles <= MAX_TILES) {
      for (let y = fromY; y < toY; y += ih) {
        for (let x = fromX; x < toX; x += iw)
          svg.draw(ctx, x, y, iw, ih, scale);
      }
    } else {
      svg.draw(ctx, x0, y0, iw, ih, scale);
    }
  } else if (tiles > 1 && scale === 1 && ctx.createPattern && ctx.translate) {
    // a pattern tiles from the origin of the space it is filled in
    ctx.fillStyle = ctx.createPattern(loaded.image, 'repeat');
    ctx.translate(x0, y0);
    ctx.fillRect(fromX - x0, fromY - y0, toX - fromX, toY - fromY);
  } else if (tiles <= MAX_TILES) {
    for (let y = fromY; y < toY; y += ih) {
      for (let x = fromX; x < toX; x += iw) {
        ctx.drawImage!(loaded.image, x, y, iw, ih);
      }
    }
  } else {
    ctx.drawImage!(loaded.image, x0, y0, iw, ih);
  }
  ctx.restore();
}

/**
 * A background image's size, in device pixels, where nothing sets it — CSS
 * 2.1 has no `background-size` — which is CSS Images' default sizing: an
 * image's own size where it has one; the dimension it lacks from its ratio,
 * or else from the positioning area; and one with a ratio alone as large as
 * fits in the area. An SVG may be any of these, and a raster image is the
 * first.
 */
function tileSize(
  size: IntrinsicSize,
  area: Rect,
  scale: number,
): [number, number] {
  const { ratio } = size;
  const width = size.width === null ? null : size.width * scale;
  const height = size.height === null ? null : size.height * scale;
  if (width !== null && height !== null) return [width, height];
  if (width !== null) return [width, ratio > 0 ? width / ratio : area.height];
  if (height !== null) return [ratio > 0 ? height * ratio : area.width, height];
  if (ratio > 0) {
    return area.width / area.height > ratio
      ? [area.height * ratio, area.height]
      : [area.width, area.width / ratio];
  }
  return [area.width, area.height];
}

/**
 * Borders, as four rectangles.
 *
 * Not as a stroked path, for the reason richtext gives about its underlines:
 * the mock backend has no path API, and a 1px border on a pixel grid is a
 * rectangle rather than something an antialiased stroke improves. Corners are
 * mitred by drawing the top and bottom full-width and the sides between them,
 * which is right whenever the two sides share a colour and close enough when
 * they do not.
 */
function paintBorders(
  ctx: PaintContext,
  box: Frame,
  options: PaintOptions,
): void {
  // most boxes have none, and are asked on every paint
  if (!(box.borderTop || box.borderRight || box.borderBottom || box.borderLeft))
    return;
  const s = box.style;
  const left = box.x + options.originX;
  const top = frameY(box) + options.originY;
  const x = Math.round(left);
  const y = Math.round(top);
  const w = Math.round(left + box.width) - x;
  const h = Math.round(top + frameHeight(box)) - y;
  if (w <= 0 || h <= 0) return;
  if (roundedRing(ctx, box, x, y, w, h, options)) return;

  const edge = (
    ex: number,
    ey: number,
    ew: number,
    eh: number,
    style: ComputedStyle['borderTopStyle'],
    color: string,
    horizontal: boolean,
  ): void => {
    const rect = clampRect(options, ex, ey, ew, eh);
    if (!rect) return;
    ctx.fillStyle = inkColor(color, s.color);
    // The un-clamped start is the dash phase's origin, so the pattern does
    // not crawl as the viewport moves along a long edge.
    fillEdge(ctx, rect, horizontal ? ex : ey, style, horizontal);
  };
  if (box.borderTop > 0 && !isTransparent(s.borderTopColor)) {
    edge(x, y, w, box.borderTop, s.borderTopStyle, s.borderTopColor, true);
  }
  if (box.borderBottom > 0 && !isTransparent(s.borderBottomColor)) {
    edge(
      x,
      y + h - box.borderBottom,
      w,
      box.borderBottom,
      s.borderBottomStyle,
      s.borderBottomColor,
      true,
    );
  }
  if (box.borderLeft > 0 && !isTransparent(s.borderLeftColor)) {
    edge(
      x,
      y + box.borderTop,
      box.borderLeft,
      h - box.borderTop - box.borderBottom,
      s.borderLeftStyle,
      s.borderLeftColor,
      false,
    );
  }
  if (box.borderRight > 0 && !isTransparent(s.borderRightColor)) {
    edge(
      x + w - box.borderRight,
      y + box.borderTop,
      box.borderRight,
      h - box.borderTop - box.borderBottom,
      s.borderRightStyle,
      s.borderRightColor,
      false,
    );
  }
}

/**
 * A rounded box's border as the ring between its border edge and its
 * padding edge, each rounded, where every side that has a border has one
 * of the same colour and a solid rule: a card's or a button's. Drawn
 * straight, its corners were square over the background's rounded ones,
 * and an accent border down one side did not follow the corner. The inner
 * radius is the outer less the wider border at that corner (CSS
 * Backgrounds 3, 5.2). False where the border is not such a one, and it is
 * drawn a side at a time.
 */
function roundedRing(
  ctx: PaintContext,
  box: Frame,
  x: number,
  y: number,
  w: number,
  h: number,
  options: PaintOptions,
): boolean {
  const s = box.style;
  const radii = s.borderRadius;
  if (!(radii[0] || radii[1] || radii[2] || radii[3])) return false;
  if (!ctx.roundRect || !ctx.fill || !ctx.beginPath) return false;
  const sides: [number, string, string][] = [
    [box.borderTop, s.borderTopColor, s.borderTopStyle],
    [box.borderRight, s.borderRightColor, s.borderRightStyle],
    [box.borderBottom, s.borderBottomColor, s.borderBottomStyle],
    [box.borderLeft, s.borderLeftColor, s.borderLeftStyle],
  ];
  let color: string | null = null;
  for (const [width, ink, style] of sides) {
    if (!width) continue;
    if (style !== 'solid' || (color !== null && ink !== color)) return false;
    color = ink;
  }
  if (color === null) return true;
  if (isTransparent(color)) return true;
  const rect = clampRect(options, x, y, w, h);
  if (!rect) return true;
  const top = box.borderTop;
  const right = box.borderRight;
  const bottom = box.borderBottom;
  const left = box.borderLeft;
  const inner = [
    radii[0] - Math.max(top, left),
    radii[1] - Math.max(top, right),
    radii[2] - Math.max(bottom, right),
    radii[3] - Math.max(bottom, left),
  ].map((r) => Math.max(0, r));
  ctx.fillStyle = inkColor(color, s.color);
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radii.slice());
  ctx.roundRect(
    rect.x + left,
    rect.y + top,
    Math.max(0, rect.w - left - right),
    Math.max(0, rect.h - top - bottom),
    inner,
  );
  ctx.fill('evenodd');
  return true;
}

/**
 * A table's collapsed borders: one per segment of its grid, centred on the
 * line, reaching across the borders it meets at either end. The winners
 * are painted last, so where two cross, the corner is the one that won
 * (CSS 2.1 17.6.2.1). Painted over the cells, as the table's borders are.
 */
function paintCollapsedBorders(
  ctx: PaintContext,
  table: Box,
  options: PaintOptions,
): void {
  const grid = table.collapsed!;
  const { rows: R, columns: C, lineX, lineY, horizontal, vertical } = grid;
  if (lineX.length !== C + 1 || lineY.length !== R + 1) return;
  const ox = Math.round(table.x + options.originX);
  const oy = Math.round(table.y + options.originY);
  const widthOf = (b: CollapsedBorder | null): number => (b ? b.width : 0);
  const h = (line: number, c: number): number =>
    c < 0 || c >= C ? 0 : widthOf(horizontal[line * C + c]);
  const v = (r: number, line: number): number =>
    r < 0 || r >= R ? 0 : widthOf(vertical[r * (C + 1) + line]);
  const segments: {
    border: CollapsedBorder;
    x: number;
    y: number;
    w: number;
    h: number;
    horizontal: boolean;
  }[] = [];
  for (let line = 0; line <= R; line += 1) {
    for (let c = 0; c < C; c += 1) {
      const border = horizontal[line * C + c];
      if (!border) continue;
      const start = halves(Math.max(v(line - 1, c), v(line, c)))[0];
      const end = halves(Math.max(v(line - 1, c + 1), v(line, c + 1)))[1];
      const x = ox + Math.round(lineX[c]) - start;
      segments.push({
        border,
        x,
        y: oy + Math.round(lineY[line]) - halves(border.width)[0],
        w: ox + Math.round(lineX[c + 1]) + end - x,
        h: border.width,
        horizontal: true,
      });
    }
  }
  for (let r = 0; r < R; r += 1) {
    for (let line = 0; line <= C; line += 1) {
      const border = vertical[r * (C + 1) + line];
      if (!border) continue;
      const start = halves(Math.max(h(r, line - 1), h(r, line)))[0];
      const end = halves(Math.max(h(r + 1, line - 1), h(r + 1, line)))[1];
      const y = oy + Math.round(lineY[r]) - start;
      segments.push({
        border,
        x: ox + Math.round(lineX[line]) - halves(border.width)[0],
        y,
        w: border.width,
        h: oy + Math.round(lineY[r + 1]) + end - y,
        horizontal: false,
      });
    }
  }
  segments.sort((a, b) => a.border.rank - b.border.rank);
  for (const s of segments) {
    if (isTransparent(s.border.color)) continue;
    const rect = clampRect(options, s.x, s.y, s.w, s.h);
    if (!rect) continue;
    ctx.fillStyle = s.border.color;
    fillEdge(ctx, rect, s.horizontal ? s.x : s.y, s.border.style, s.horizontal);
  }
}

function fillEdge(
  ctx: PaintContext,
  rect: { x: number; y: number; w: number; h: number },
  phaseOrigin: number,
  style: ComputedStyle['borderTopStyle'],
  horizontal: boolean,
): void {
  const { x, y, w, h } = rect;
  const length = horizontal ? w : h;
  const thickness = horizontal ? h : w;
  if (length <= 0 || thickness <= 0) return;
  if (style === 'dashed' || style === 'dotted') {
    const period = style === 'dotted' ? thickness * 2 : thickness * 3;
    const on = style === 'dotted' ? thickness : thickness * 2;
    const from = horizontal ? x : y;
    // Start on the pattern boundary at or before the clamped start, so the
    // dash the viewport cuts into is the same dash it always was.
    let i = Math.floor((from - phaseOrigin) / period) * period + phaseOrigin;
    for (; i < from + length; i += period) {
      const start = Math.max(i, from);
      const run = Math.min(i + on, from + length) - start;
      if (run <= 0) continue;
      if (horizontal) ctx.fillRect(start, y, run, thickness);
      else ctx.fillRect(x, start, thickness, run);
    }
    return;
  }
  if (style === 'double' && thickness >= 3) {
    const band = Math.max(1, Math.floor(thickness / 3));
    if (horizontal) {
      ctx.fillRect(x, y, length, band);
      ctx.fillRect(x, y + thickness - band, length, band);
    } else {
      ctx.fillRect(x, y, band, length);
      ctx.fillRect(x + thickness - band, y, band, length);
    }
    return;
  }
  ctx.fillRect(x, y, w, h);
}

/** A list item's bullet or number, in the margin. */
function paintMarker(
  ctx: PaintContext,
  marker: Marker,
  options: PaintOptions,
): void {
  marker.layout?.draw(
    ctx,
    marker.x + options.originX,
    marker.y + options.originY,
  );
}

function paintImage(ctx: PaintContext, box: Box, options: PaintOptions): void {
  const image = options.imageFor(box);
  const left = box.contentX + options.originX;
  const top = box.contentY + options.originY;
  const x = Math.round(left);
  const y = Math.round(top);
  const w = Math.round(left + box.contentWidth) - x;
  const h = Math.round(top + box.contentHeight) - y;
  if (w <= 0 || h <= 0) return;
  if (image instanceof SvgDrawing) {
    image.draw(ctx, x, y, w, h, options.scale ?? 1);
    return;
  }
  if (image && ctx.drawImage) {
    ctx.drawImage(image, x, y, w, h);
    return;
  }
  // No image yet, or no image at all: a faint frame where it will be, so a
  // document with blocked resources still reads as a document with pictures
  // in it rather than as one with holes.
  if (!box.style.backgroundColor) {
    ctx.fillStyle = box.style.color;
    const t = 1;
    ctx.fillRect(x, y, w, t);
    ctx.fillRect(x, y + h - t, w, t);
    ctx.fillRect(x, y, t, h);
    ctx.fillRect(x + w - t, y, t, h);
  }
}

/** An inline `<svg>`, drawn in its content box. Its `currentColor` is the
 *  box's `color`, as an icon's is the text's around it. */
function paintSvg(ctx: PaintContext, box: Box, options: PaintOptions): void {
  if (!box.el) return;
  const x = Math.round(box.contentX + options.originX);
  const y = Math.round(box.contentY + options.originY);
  const w = Math.round(box.contentX + options.originX + box.contentWidth) - x;
  const h = Math.round(box.contentY + options.originY + box.contentHeight) - y;
  inlineDrawing(box.el).draw(
    ctx,
    x,
    y,
    w,
    h,
    options.scale ?? 1,
    box.style.color,
  );
}

/**
 * The X protocol carries glyph positions as Int16, so anything drawn past
 * ±32767 window coordinates does not clip — it throws in the encoder. The
 * caller bounds a full repaint to the window (see `HtmlViewNode.paint`),
 * which keeps every *culled* coordinate in range; this margin is how far a
 * drawn layout's own lines may run past the damage before the batch itself
 * would overflow.
 */
const COORD_LIMIT = 30000;

function paintLines(ctx: PaintContext, box: Box, options: PaintOptions): void {
  const lines = box.lines;
  if (!lines) return;
  const dx = options.originX;
  const dy = options.originY;
  const damage = options.damage;

  // Three passes over the visible lines, not one: ntk draws a whole layout
  // in one glyph batch, so a multi-line paragraph's ink all lands on the
  // first line that references it — and anything painted "under the ink" on
  // a later line would land *over* it. Everything under the glyphs is
  // painted for every line first, then the ink once per layout, then the
  // rules over it.
  const visible: LineBox[] = [];
  if (damage) {
    // Lines are built top to bottom, so `y` is monotone; a line's *bottom*
    // is not (heights vary), which is what the tallest-line slack is for.
    // Start at the first line that could reach the damage, stop at the
    // first one past it: the cost is the visible lines, not the box's.
    const top = damage.y - dy;
    const bottom = top + damage.height;
    let lo = 0;
    let hi = lines.length;
    const slack = top - box.maxLineHeight;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].y > slack) hi = mid;
      else lo = mid + 1;
    }
    for (let i = lo; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.y >= bottom) break;
      if (line.y + line.height > top) visible.push(line);
    }
  } else {
    visible.push(...lines);
  }
  if (!visible.length) return;

  for (const line of visible) {
    if (line.background) paintLineBackground(ctx, line, options);
    paintInlineBoxes(ctx, line, options);
    for (const text of line.texts) {
      const natural = text.layout.lines[text.layoutLine];
      if (natural)
        paintRunBackgrounds(
          ctx,
          natural,
          text.drawX + dx,
          text.drawY + dy,
          options.scale ?? 1,
        );
    }
    paintSelection(ctx, line, options);
  }

  // an underline goes under the glyphs, a line through over them (CSS 2.1
  // Appendix E): a descender crosses its own underline
  paintRules(ctx, visible, dx, dy, options.scale ?? 1, 'under');

  // One `draw` per layout: a paragraph is a single glyph composite, and
  // drawing it once per line would be one X request per line for the same
  // batch.
  const drawn = new Set<unknown>();
  for (const line of visible) {
    for (const text of line.texts) {
      if (drawn.has(text.layout)) continue;
      drawn.add(text.layout);
      const top = text.drawY + dy;
      if (top < -COORD_LIMIT || top + text.layout.height > COORD_LIMIT) {
        // A single layout so tall its own lines overflow the Int16 envelope
        // — a one-paragraph document tens of thousands of pixels high. The
        // element scrolling itself (phase 2, see the PRD) is the real
        // answer; until then the overflowing batch is skipped rather than
        // thrown from the protocol encoder.
        continue;
      }
      text.layout.draw(ctx, text.drawX + dx, top);
    }
  }

  paintRules(ctx, visible, dx, dy, options.scale ?? 1, 'over');
  for (const line of visible) {
    for (const placed of line.atomics) paintBox(ctx, placed.box, options);
  }
}

/** One pass of the lines' run rules, `under` or `over` their glyphs. */
function paintRules(
  ctx: PaintContext,
  lines: LineBox[],
  dx: number,
  dy: number,
  scale: number,
  rules: 'under' | 'over',
): void {
  for (const line of lines) {
    const shifted = SHIFTED_LINES.has(line);
    for (const text of line.texts) {
      const natural = text.layout.lines[text.layoutLine];
      if (natural) {
        paintRunRules(
          ctx,
          natural,
          text.drawX + dx,
          text.drawY + dy + (shifted ? ruleDrop(text) : 0),
          scale,
          rules,
        );
      }
    }
  }
}

/**
 * How far below a raised text its rules go: to the baseline of the element
 * that decorates it. `vertical-align` moves the text and not the lines an
 * element outside it draws through it, which stay on that element's
 * baseline (CSS Text Decoration 3, 2.1). `position: relative` moves both.
 */
function ruleDrop(text: LineText): number {
  const raise = TEXT_RAISES.get(text);
  if (!raise) return 0;
  const owner = text.spans.boxAt?.(text.layoutStart);
  for (let at = owner?.parent; at?.kind === 'inline'; at = at.parent) {
    if (at.style.textDecorationLine !== 'none') {
      return raise - (BOX_RAISES.get(at) ?? 0);
    }
  }
  return raise;
}

/**
 * The backgrounds and borders of the inline boxes on one line — a `<mark>`, a
 * padded `<span>`, a link set as a button — under the text, a fragment each:
 * from the ascent to the descent of the box's own face, with its vertical
 * padding and border beyond (CSS 2.1 10.6.1, 10.8.1, which is also why they
 * do not make the line taller), and across the box's text and atomics on
 * this line out to its padding and border where it starts or ends. Outer
 * boxes first, so a highlight shows behind a nested element's text too. A
 * run finds its element from its place in the document, as a click does.
 */
/** A `::first-line` background: behind all the line's content, across it,
 *  over its face's height from the baseline, as an inline box around the
 *  line's content would be painted. */
function paintLineBackground(
  ctx: PaintContext,
  line: LineBox,
  options: PaintOptions,
): void {
  const background = line.background!;
  let left = Infinity;
  let right = -Infinity;
  let baseline = line.y + line.baseline;
  const shifted = SHIFTED_LINES.has(line);
  for (const text of line.texts) {
    const natural = text.layout.lines[text.layoutLine];
    if (!natural) continue;
    // where the line has it, not where `position: relative` moved it or
    // `vertical-align` raised it
    const shift = shifted ? TEXT_SHIFTS.get(text) : undefined;
    const raise = shifted ? (TEXT_RAISES.get(text) ?? 0) : 0;
    const x = text.drawX - (shift?.x ?? 0) + natural.x;
    baseline = text.drawY - (shift?.y ?? 0) + raise + natural.baseline;
    left = Math.min(left, x);
    right = Math.max(right, x + natural.width);
  }
  for (const placed of line.atomics) {
    left = Math.min(left, placed.x - placed.box.marginLeft);
    right = Math.max(
      right,
      placed.x + placed.box.width + placed.box.marginRight,
    );
  }
  if (!(right > left)) return;
  const top = baseline - background.ascent;
  paintBackground(
    ctx,
    {
      x: left,
      y: top,
      width: right - left,
      height: baseline + background.descent - top,
      captionTop: 0,
      captionBottom: 0,
      borderTop: 0,
      borderBottom: 0,
      borderLeft: 0,
      borderRight: 0,
      style: background.style,
    },
    options,
  );
}

function paintInlineBoxes(
  ctx: PaintContext,
  line: LineBox,
  options: PaintOptions,
): void {
  let fragments: Map<Box, InlineFragment> | null = null;
  const widen = (box: Box, left: number, right: number): void => {
    fragments ??= new Map();
    const f = fragments.get(box);
    if (f) {
      f.left = Math.min(f.left, left);
      f.right = Math.max(f.right, right);
    } else {
      fragments.set(box, { left, right, start: false, end: false });
    }
  };
  // Every text on a line is drawn on one baseline (`finishLine`), and an
  // engine's is from the top of its layout rather than of the line. Taken
  // where the line has each text: a box `position: relative` moves is
  // moved by its own offset below, and the boxes around it are not.
  let baseline = line.y + line.baseline;
  const shifted = SHIFTED_LINES.has(line);
  for (const text of line.texts) {
    const natural = text.layout.lines[text.layoutLine];
    const boxAt = text.spans.boxAt;
    if (!natural || !boxAt) continue;
    const shift = shifted ? TEXT_SHIFTS.get(text) : undefined;
    const raise = shifted ? (TEXT_RAISES.get(text) ?? 0) : 0;
    baseline = text.drawY - (shift?.y ?? 0) + raise + natural.baseline;
    const x = text.drawX - (shift?.x ?? 0) + natural.x;
    for (const run of natural.runs) {
      const owner = boxAt.call(text.spans, run.start);
      if (!owner) continue;
      // Within the line: a space a line ends on hangs past it, and CoreText
      // keeps it in the run it ends even where the line's width does not.
      const left = Math.max(x, x + run.x);
      const right = Math.min(x + natural.width, x + run.x + run.width);
      if (right <= left) continue;
      for (const box of decoratedAncestors(owner)) widen(box, left, right);
    }
  }
  for (const placed of line.atomics) {
    const atomic = placed.box;
    for (const box of decoratedAncestors(atomic)) {
      widen(
        box,
        placed.x - atomic.marginLeft,
        placed.x + atomic.width + atomic.marginRight,
      );
    }
  }
  for (const edge of line.edges ?? []) {
    const box = edge.box;
    if (!box.decoration) continue;
    // The element's `direction` says which side its start is on, whatever
    // its text reads as (CSS 2.1 8.6); the edge's margin is outside the box,
    // its border and padding inside.
    const onLeft = (edge.side === 'start') !== (box.style.direction === 'rtl');
    if (onLeft) {
      const left = edge.x + box.marginLeft;
      widen(box, left, left);
    } else {
      const right = edge.x + edge.width - box.marginRight;
      widen(box, right, right);
    }
    const f = fragments!.get(box)!;
    if (edge.side === 'start') f.start = true;
    else f.end = true;
  }
  if (!fragments) return;
  const boxes = [...(fragments as Map<Box, InlineFragment>).keys()].sort(
    (a, b) => depthOf(a) - depthOf(b),
  );
  for (const box of boxes) {
    if (box.style.visibility !== 'visible') continue;
    const f = (fragments as Map<Box, InlineFragment>).get(box)!;
    const face = box.decoration!;
    // on its own baseline, which `vertical-align` may raise off the line's
    const own = shifted ? baseline - (BOX_RAISES.get(box) ?? 0) : baseline;
    const top = own - face.ascent - box.padTop - box.borderTop;
    const bottom = own + face.descent + box.padBottom + box.borderBottom;
    // Sliced where the box goes on to another line: no border and no
    // rounded corner on a side it does not end on (`box-decoration-break:
    // slice`, CSS's default). Left and right swap for right-to-left text.
    const rtl = box.style.direction === 'rtl';
    const leftEnds = rtl ? f.end : f.start;
    const rightEnds = rtl ? f.start : f.end;
    const [tl, tr, br, bl] = box.style.borderRadius;
    const moved = shifted ? offsetOf(box) : null;
    const fragment: Frame = {
      x: f.left + (moved?.x ?? 0),
      y: top + (moved?.y ?? 0),
      width: f.right - f.left,
      height: bottom - top,
      captionTop: 0,
      captionBottom: 0,
      borderTop: box.borderTop,
      borderBottom: box.borderBottom,
      borderLeft: leftEnds ? box.borderLeft : 0,
      borderRight: rightEnds ? box.borderRight : 0,
      style: {
        ...box.style,
        borderRadius: [
          leftEnds ? tl : 0,
          rightEnds ? tr : 0,
          rightEnds ? br : 0,
          leftEnds ? bl : 0,
        ],
      },
    };
    if (fragment.width <= 0) continue;
    paintBackground(ctx, fragment, options);
    paintBorders(ctx, fragment, options);
  }
}

/** How far `position: relative` moved an inline box: its own offset, and
 *  those of the inline boxes around it. */
function offsetOf(box: Box): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let moved = false;
  for (let at: Box | null = box; at?.kind === 'inline'; at = at.parent) {
    const offset = INLINE_OFFSETS.get(at);
    if (!offset) continue;
    x += offset.x;
    y += offset.y;
    moved = true;
  }
  return moved ? { x, y } : null;
}

interface InlineFragment {
  left: number;
  right: number;
  /** Whether the box opens or closes on this line. */
  start: boolean;
  end: boolean;
}

/** The inline boxes around a box, within its line's block, that paint a
 *  background or a border — outermost last. */
const DECORATED = new WeakMap<Box, Box[]>();

function decoratedAncestors(box: Box): Box[] {
  let found = DECORATED.get(box);
  if (found) return found;
  found = [];
  for (let at = box.parent; at && at.kind === 'inline'; at = at.parent) {
    if (at.decoration) found.push(at);
  }
  DECORATED.set(box, found);
  return found;
}

/**
 * The band the document selection covers on one line.
 *
 * Translucent under the glyphs rather than inverted over them, so the ink
 * keeps its contrast on either palette — the same call `<textarea>` and
 * `<richtext>` both make.
 */
function paintSelection(
  ctx: PaintContext,
  line: LineBox,
  options: PaintOptions,
): void {
  const range = options.selection;
  if (!range || range.end <= range.start || !options.selectionColor) return;
  if (line.textEnd <= range.start || line.textStart >= range.end) return;
  ctx.fillStyle = options.selectionColor;
  for (const text of line.texts) {
    const natural = text.layout.lines[text.layoutLine];
    if (!natural) continue;
    const from = Math.max(range.start, text.textStart);
    const to = Math.min(range.end, text.textEnd);
    if (to <= from) continue;
    const offsets = layoutOffsets(text.layout);
    const layoutFrom = layoutOffsetOf(text, from);
    const layoutTo = layoutOffsetOf(text, to, true);
    for (const band of lineBands(
      text.layout,
      natural,
      offsets,
      layoutFrom,
      layoutTo,
    )) {
      ctx.fillRect(
        Math.round(band.x + text.drawX + options.originX),
        Math.round(line.y + options.originY),
        Math.ceil(band.width),
        Math.ceil(line.height),
      );
    }
  }
}
