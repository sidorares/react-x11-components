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
import { alphaOf, inkColor, isTransparent, resolve } from './css/values.js';
import { blend, borderShades } from './css/color.js';
import type { Len } from './css/values.js';
import type { BoxShadow, ComputedStyle, LinearGradient } from './css/style.js';
import { copyStyle } from './css/style.js';
import {
  BOX_RAISES,
  Box,
  CLIPPED_CELLS,
  COLLAPSED_CELLS,
  INLINE_OFFSETS,
  SHADOWED_TEXT,
  SHIFTED_LINES,
  TEXT_RAISES,
  TEXT_SHIFTS,
} from './layout/boxes.js';
import type { BoxTree, LineBox, LineText, Marker } from './layout/boxes.js';
import {
  CLIPPED_TEXT,
  clipBoxOf,
  depthOf,
  inklessLayout,
  layoutOffsetOf,
  layoutOffsets,
} from './layout/inline.js';
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
  moveTo?(x: number, y: number): void;
  lineTo?(x: number, y: number): void;
  bezierCurveTo?(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x: number,
    y: number,
  ): void;
  closePath?(): void;
  fill?(rule?: 'nonzero' | 'evenodd'): void;
  createLinearGradient?(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): { addColorStop(offset: number, color: string): void };
  clip?(): void;
  /** Canvas shadows: ntk bakes and caches the blur, CoreGraphics draws it. */
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
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
  /** A drawing made once for its key on a surface `width` by `height` and
   *  kept, to be drawn with `drawImage`: a blurred shadow, whose blur is
   *  the cost. Null where there is no surface to be had. */
  cached?(
    key: string,
    width: number,
    height: number,
    draw: (ctx: PaintContext) => void,
  ): unknown;
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
  // A shadow is ink past the box, and no overflow: a repaint of the strip
  // under a card has to reach the card, and the document is no taller.
  const shadows = own ? box.style.boxShadow : null;
  if (shadows) {
    for (const shadow of shadows) {
      if (shadow.inset) continue;
      const reach = shadow.spread + shadowReach(shadow.blur);
      x1 = Math.min(x1, box.x + shadow.x - reach);
      y1 = Math.min(y1, box.y + shadow.y - reach);
      x2 = Math.max(x2, box.x + box.width + shadow.x + reach);
      y2 = Math.max(y2, box.y + box.height + shadow.y + reach);
    }
  }
  // and so is an outline
  if (own && box.style.outlineStyle !== 'none') {
    const reach = Math.max(0, box.style.outlineOffset + box.style.outlineWidth);
    x1 = Math.min(x1, box.x - reach);
    y1 = Math.min(y1, box.y - reach);
    x2 = Math.max(x2, box.x + box.width + reach);
    y2 = Math.max(y2, box.y + box.height + reach);
  }
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
    }
    box.maxLineHeight = tallest;
    if (lines.length) {
      const last = lines[lines.length - 1];
      bottom = Math.max(bottom, last.y + last.height);
    }
  }
  const marker = box.marker;
  const drawn = marker?.image ?? marker?.layout;
  if (marker && drawn) {
    // The marker hangs in the padding to the left of the content, so it is
    // outside the border box and has to widen the ink bounds or a repaint
    // clipped to a narrow strip drops it.
    x1 = Math.min(x1, marker.x);
    y1 = Math.min(y1, marker.y);
    x2 = Math.max(x2, marker.x + drawn.width);
    y2 = Math.max(y2, marker.y + drawn.height);
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
  // An atomic on a line is the box's, or an inline box's in it, so the walk
  // above has its bounds already: walked from its line as well, an
  // inline-block in an inline-block was walked twice a level, and twenty of
  // them took seventy milliseconds a layout.
  if (lines) {
    for (const line of lines) {
      for (const placed of line.atomics) {
        const atomic = placed.box;
        if (atomic.boundsY === Infinity) continue;
        x1 = Math.min(x1, atomic.boundsX);
        y1 = Math.min(y1, atomic.boundsY);
        x2 = Math.max(x2, atomic.boundsX + atomic.boundsWidth);
        y2 = Math.max(y2, atomic.boundsY + atomic.boundsHeight);
      }
    }
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
  // A box with no rectangle reaches as far as what it holds, and no
  // further: its `y` and `height` were never laid out, but moving a laid
  // out subtree (`translate`) moves them with the rest, so they add up
  // across passes. A flex item laid out at one width and then another had a
  // link in it reach a document's height below its end.
  if (!own) return bottom;
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
    !!b.style.backgroundGradient ||
    !!b.style.backgroundImages;
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
  const layers = layersOf(source.style) ?? [source.style];
  const visible = source.style.visibility === 'visible';
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const style = layers[i];
    if (!isTransparent(style.backgroundColor) && visible) {
      ctx.fillStyle = inkColor(style.backgroundColor as string, style.color);
      ctx.fillRect(area.x, area.y, area.w, area.h);
    }
    if (style.backgroundGradient && ctx.createLinearGradient && visible) {
      // sized by the root element's box and repeated down the canvas, as a
      // browser does — the stripes a short page with a gradient on its
      // body shows — or by the viewport, where it is fixed
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
}

const LAYERS = new WeakMap<ComputedStyle, ComputedStyle[]>();

/**
 * A style for each of a background's layers, top first, where it has more
 * than one (CSS Backgrounds 3, 2.1); null where it has one, which the style
 * itself is. Each is the box's own style with the layer's image, repeat,
 * size, attachment and position in place of the first's — a property with
 * fewer values than there are images taking them over again — and the
 * colour on the bottom layer alone, which is painted first, under the
 * others. Made once a style, so a repaint makes none.
 */
function layersOf(style: ComputedStyle): ComputedStyle[] | null {
  const images = style.backgroundImages;
  if (!images) return null;
  let layers = LAYERS.get(style);
  if (layers) return layers;
  const nth = <T>(list: T[] | null, first: T, i: number): T =>
    list ? list[i % list.length] : first;
  layers = images.map((image, i) => {
    const layer = Object.create(style) as ComputedStyle;
    layer.backgroundImages = null;
    layer.backgroundImage = typeof image === 'string' ? image : null;
    layer.backgroundGradient = typeof image === 'string' ? null : image;
    layer.backgroundRepeat = nth(
      style.backgroundRepeats,
      style.backgroundRepeat,
      i,
    );
    layer.backgroundSize = nth(style.backgroundSizes, style.backgroundSize, i);
    layer.backgroundAttachment = nth(
      style.backgroundAttachments,
      style.backgroundAttachment,
      i,
    );
    [layer.backgroundPositionX, layer.backgroundPositionY] = nth(
      style.backgroundPositions,
      [style.backgroundPositionX, style.backgroundPositionY],
      i,
    );
    if (i < images.length - 1) layer.backgroundColor = null;
    return layer;
  });
  LAYERS.set(style, layers);
  return layers;
}

/**
 * A box's background: its colour and each of its layers, bottom first.
 * `paintBackground` draws a colour and a gradient, and `image`, where a
 * caller draws images, a layer that is one.
 */
function paintLayers(
  ctx: PaintContext,
  box: Frame,
  options: PaintOptions,
  image?: (layer: ComputedStyle) => void,
): void {
  // a background painted through the text is painted with it
  // (`paintClippedText`), and not as a box
  if (box.style.backgroundClipText) return;
  const layers = layersOf(box.style);
  if (!layers) {
    paintBackground(ctx, box, options, box.style);
    if (image && box.style.backgroundImage) image(box.style);
    return;
  }
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    paintBackground(ctx, box, options, layers[i]);
    if (image && layers[i].backgroundImage) image(layers[i]);
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
  if (!intersects(box, options) || COLLAPSED_CELLS.has(box)) return;
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
    // Clipped to no area, nothing in the box shows but an absolute box
    // whose containing block is outside it, and where it holds none what it
    // holds is not painted at all: a menu at `max-height: 0`. Clipped to an
    // empty rectangle instead, it was painted through a mask the size of
    // the window, which is what an empty rectangle is to the context, built
    // again at every restore — and a nest of them did that at every level.
    if ((rect.w <= 0 || rect.h <= 0) && !holdsAbsolute(box)) {
      if (box.style.outlineStyle !== 'none' && box.kind !== 'inline') {
        paintOutline(ctx, box, options);
      }
      return;
    }
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
  // over all of it, outside the box's own clip; an inline box's is drawn a
  // fragment at a time, on its lines
  if (box.style.outlineStyle !== 'none' && box.kind !== 'inline') {
    paintOutline(ctx, box, options);
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
  if (hidden(box)) return;
  const style = box.style;
  if (style.boxShadow) paintShadows(ctx, box, options, false);
  if (box !== options.canvasSource) {
    paintLayers(ctx, box, options, (layer) => {
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
          layer,
          area,
          paddingBox(box, options),
          options,
          cornersOf(
            style,
            Math.round(left + box.width) - Math.round(left),
            Math.round(top + frameHeight(box)) - Math.round(top),
          ),
        );
      }
    });
  }
  if (style.boxShadow) paintShadows(ctx, box, options, true);
  if (!box.bordersCollapsed) paintBorders(ctx, box, options);
  if (box.kind === 'table') paintPartBackgrounds(ctx, box, options);
}

/** How far past its shape a shadow's blur shows: three standard deviations,
 *  the blur being two (CSS Backgrounds 3, 7.1.1). */
function shadowReach(blur: number): number {
  return blur > 0 ? Math.ceil(blur * 1.5) : 0;
}

const SQUARE: Corners = { x: [0, 0, 0, 0], y: [0, 0, 0, 0] };

/** Corners grown by `by` — a spread's, which rounds a shadow with its box —
 *  or shrunk where it is negative; a square corner stays square. */
function grownCorners(c: Corners, by: number): Corners {
  const grow = (r: number) => (r > 0 ? Math.max(0, r + by) : 0);
  return {
    x: [grow(c.x[0]), grow(c.x[1]), grow(c.x[2]), grow(c.x[3])],
    y: [grow(c.y[0]), grow(c.y[1]), grow(c.y[2]), grow(c.y[3])],
  };
}

/**
 * A box's shadows (CSS Backgrounds 3, 7.1), the outer ones under its
 * background and the inset ones over it, back to front. A shadow with no
 * blur is a shape of one colour, and one that only spreads, the ring
 * Tailwind's `ring-*` draws a border with, is the band between two shapes.
 * A blurred one is the context's shadow of a shape drawn clear of the
 * window, so only the shadow lands: ntk bakes and caches the blur, and
 * CoreGraphics draws it. An outer shadow is not drawn under its box, which
 * the box's own opaque colour usually sees to; where it does not, the
 * shadow is clipped out of the box, a clip the size of the window on X11.
 * An inset one is clipped to the padding box.
 */
function paintShadows(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  inset: boolean,
): void {
  const shadows = box.style.boxShadow!;
  if (!ctx.beginPath || !ctx.fill || !ctx.roundRect) return;
  const style = box.style;
  const left = box.x + options.originX;
  const top = frameY(box) + options.originY;
  const rect = snapped(left, top, box.width, frameHeight(box));
  if (!(rect.width > 0 && rect.height > 0)) return;
  const corners = cornersOf(style, rect.width, rect.height) ?? SQUARE;
  const canShadow = 'shadowBlur' in ctx;
  if (!inset) {
    const bg = style.backgroundColor;
    const covered =
      !!bg && !isTransparent(bg) && alphaOf(inkColor(bg, style.color)) === 1;
    for (let i = shadows.length - 1; i >= 0; i -= 1) {
      const s = shadows[i];
      if (s.inset || (s.blur > 0 && !canShadow)) continue;
      const shape = {
        x: rect.x + s.x - s.spread,
        y: rect.y + s.y - s.spread,
        width: rect.width + 2 * s.spread,
        height: rect.height + 2 * s.spread,
      };
      if (!(shape.width > 0 && shape.height > 0)) continue;
      const reach = shadowReach(s.blur);
      if (
        !clampRect(
          options,
          shape.x - reach,
          shape.y - reach,
          shape.width + 2 * reach,
          shape.height + 2 * reach,
        )
      ) {
        continue;
      }
      // Cut, as a background is (`clampRect`), to what the paint reaches
      // and as far again as the blur does, so the cut edges cast nothing
      // on it. A shadow down a box thousands of pixels tall went to the
      // server whole, and its outline, sent in 16.16 fixed point, threw.
      const within = reach + CLAMP_PAD;
      const cut = clampAround(options, shape, within);
      if (!cut) continue;
      Object.assign(shape, cut);
      const own = clampAround(options, rect, within) ?? rect;
      const around = grownCorners(corners, s.spread);
      const color = inkColor(s.color, style.color);
      if (!(s.blur > 0) && !s.x && !s.y && s.spread >= 0 && !covered) {
        // a ring about the box: the band between it and the spread
        ctx.fillStyle = color;
        fillRing(ctx, shape, around, own, corners);
        continue;
      }
      if (!(s.blur > 0) && covered) {
        // a hard shadow, under a box that hides what falls under it
        fillShadow(
          ctx,
          s,
          color,
          (dx) => {
            roundedRect(
              ctx,
              shape.x - dx,
              shape.y,
              shape.width,
              shape.height,
              around,
            );
          },
          0,
        );
        continue;
      }
      if (
        bakedOuter(
          ctx,
          options,
          s,
          color,
          shape,
          around,
          covered ? null : { rect: own, corners },
        )
      ) {
        continue;
      }
      // what of the shadow falls under the box is not drawn
      const clipped = !covered && ctx.clip && ctx.rect && ctx.save;
      if (clipped) {
        ctx.save();
        ctx.beginPath();
        ctx.rect!(
          shape.x - reach - 1,
          shape.y - reach - 1,
          shape.width + 2 * reach + 2,
          shape.height + 2 * reach + 2,
        );
        roundedRect(
          ctx,
          own.x,
          own.y,
          own.width,
          own.height,
          corners,
          true,
          true,
        );
        ctx.clip!();
      }
      fillShadow(
        ctx,
        s,
        color,
        (dx) => {
          roundedRect(
            ctx,
            shape.x - dx,
            shape.y,
            shape.width,
            shape.height,
            around,
          );
        },
        shape.x + shape.width + reach,
      );
      if (clipped) ctx.restore();
    }
    return;
  }
  // the padding box, which an inset shadow falls inside
  const pad = {
    x: rect.x + box.borderLeft,
    y: rect.y + box.borderTop,
    width: rect.width - box.borderLeft - box.borderRight,
    height: rect.height - box.borderTop - box.borderBottom,
  };
  if (!(pad.width > 0 && pad.height > 0)) return;
  if (!clampRect(options, pad.x, pad.y, pad.width, pad.height)) return;
  // cut as an outer shadow is, by as far as any of them reaches: what is
  // cast from beside a cut edge falls short of what the paint reaches
  let furthest = 0;
  for (const s of shadows) {
    if (s.inset) {
      furthest = Math.max(
        furthest,
        shadowReach(s.blur) + Math.abs(s.x) + Math.abs(s.y) + 1,
      );
    }
  }
  const padCut = clampAround(options, pad, furthest + CLAMP_PAD);
  if (!padCut) return;
  Object.assign(pad, padCut);
  const inner = insetCorners(
    corners,
    box.borderTop,
    box.borderRight,
    box.borderBottom,
    box.borderLeft,
  );
  for (let i = shadows.length - 1; i >= 0; i -= 1) {
    const s = shadows[i];
    if (!s.inset || (s.blur > 0 && !canShadow)) continue;
    const color = inkColor(s.color, style.color);
    // the hole the shadow is cast around, moved and shrunk by the spread
    const hole = {
      x: pad.x + s.x + s.spread,
      y: pad.y + s.y + s.spread,
      width: Math.max(0, pad.width - 2 * s.spread),
      height: Math.max(0, pad.height - 2 * s.spread),
    };
    const within = grownCorners(inner, -s.spread);
    if (!(s.blur > 0) && !s.x && !s.y && s.spread >= 0) {
      // Tailwind's `ring-inset`: a band inside the padding edge
      ctx.fillStyle = color;
      fillRing(ctx, pad, inner, hole, within);
      continue;
    }
    if (bakedInset(ctx, options, s, color, pad, inner, hole, within)) continue;
    if (!ctx.clip || !ctx.save || !ctx.rect) continue;
    ctx.save();
    ctx.beginPath();
    roundedRect(ctx, pad.x, pad.y, pad.width, pad.height, inner);
    ctx.clip();
    // a frame around the hole, as wide as the blur and the offset reach
    const reach = shadowReach(s.blur) + Math.abs(s.x) + Math.abs(s.y) + 1;
    const frame = {
      x: pad.x - reach,
      y: pad.y - reach,
      width: pad.width + 2 * reach,
      height: pad.height + 2 * reach,
    };
    fillShadow(
      ctx,
      s,
      color,
      (dx) => {
        ctx.rect!(frame.x - dx, frame.y, frame.width, frame.height);
        if (hole.width > 0 && hole.height > 0) {
          roundedRect(
            ctx,
            hole.x - dx,
            hole.y,
            hole.width,
            hole.height,
            within,
            true,
            true,
          );
        }
      },
      frame.x + frame.width + shadowReach(s.blur),
    );
    ctx.restore();
  }
}

/** Corners as part of a key. */
function cornerKey(c: Corners): string {
  return `${c.x.join(',')}/${c.y.join(',')}`;
}

/**
 * An outer shadow drawn once on a surface of its own and composited: the
 * shape's shadow, and where `box` is given the box cut out of it — so a box
 * that shows what is behind it shows no shadow there, with the clip on the
 * small surface rather than the window. False where there is no surface.
 */
function bakedOuter(
  ctx: PaintContext,
  options: PaintOptions,
  s: BoxShadow,
  color: string,
  shape: Rect,
  around: Corners,
  box: { rect: Rect; corners: Corners } | null,
): boolean {
  if (!options.cached || !ctx.drawImage) return false;
  const reach = shadowReach(s.blur) + 1;
  const x0 = Math.floor(shape.x) - reach;
  const y0 = Math.floor(shape.y) - reach;
  const w = Math.ceil(shape.x + shape.width) + reach - x0;
  const h = Math.ceil(shape.y + shape.height) + reach - y0;
  const sx = shape.x - x0;
  const sy = shape.y - y0;
  const cut = box && {
    x: box.rect.x - x0,
    y: box.rect.y - y0,
    width: box.rect.width,
    height: box.rect.height,
  };
  const key = [
    'shadow',
    w,
    h,
    sx,
    sy,
    shape.width,
    shape.height,
    cornerKey(around),
    s.blur,
    color,
    cut
      ? `${cut.x},${cut.y},${cut.width},${cut.height},${cornerKey(box.corners)}`
      : '',
  ].join('|');
  const image = options.cached(key, w, h, (sctx) => {
    if (cut) {
      sctx.save();
      sctx.beginPath!();
      sctx.rect!(0, 0, w, h);
      roundedRect(
        sctx,
        cut.x,
        cut.y,
        cut.width,
        cut.height,
        box.corners,
        true,
        true,
      );
      sctx.clip!();
    }
    fillShadow(
      sctx,
      s,
      color,
      (dx) => {
        roundedRect(sctx, sx - dx, sy, shape.width, shape.height, around);
      },
      sx + shape.width + reach,
    );
    if (cut) sctx.restore();
  });
  if (!image) return false;
  ctx.drawImage(image, x0, y0);
  return true;
}

/**
 * An inset shadow drawn once on a surface the size of the padding box and
 * composited: a frame around the hole, whose shadow falls inside, clipped
 * to the padding box's corners on the surface. False where there is none.
 */
function bakedInset(
  ctx: PaintContext,
  options: PaintOptions,
  s: BoxShadow,
  color: string,
  pad: Rect,
  inner: Corners,
  hole: Rect,
  within: Corners,
): boolean {
  if (!options.cached || !ctx.drawImage) return false;
  const w = Math.round(pad.width);
  const h = Math.round(pad.height);
  const hx = hole.x - pad.x;
  const hy = hole.y - pad.y;
  const reach = shadowReach(s.blur) + Math.abs(s.x) + Math.abs(s.y) + 1;
  const key = [
    'inset',
    w,
    h,
    cornerKey(inner),
    hx,
    hy,
    hole.width,
    hole.height,
    cornerKey(within),
    s.blur,
    color,
  ].join('|');
  const image = options.cached(key, w, h, (sctx) => {
    sctx.save();
    sctx.beginPath!();
    roundedRect(sctx, 0, 0, w, h, inner);
    sctx.clip!();
    fillShadow(
      sctx,
      s,
      color,
      (dx) => {
        sctx.rect!(-reach - dx, -reach, w + 2 * reach, h + 2 * reach);
        if (hole.width > 0 && hole.height > 0) {
          roundedRect(
            sctx,
            hx - dx,
            hy,
            hole.width,
            hole.height,
            within,
            true,
            true,
          );
        }
      },
      w + reach + shadowReach(s.blur),
    );
    sctx.restore();
  });
  if (!image) return false;
  ctx.drawImage(image, pad.x, pad.y);
  return true;
}

/**
 * Fill a shadow's shape: in its colour where it has no blur, and otherwise
 * as the context's shadow of the shape drawn `dx` to the left — clear of
 * the window, its right edge at `right` before the move — with the shadow
 * offset back by as much, so that only the shadow lands.
 */
function fillShadow(
  ctx: PaintContext,
  s: BoxShadow,
  color: string,
  shape: (dx: number) => void,
  right: number,
): void {
  if (!(s.blur > 0)) {
    ctx.fillStyle = color;
    ctx.beginPath!();
    shape(0);
    ctx.fill!();
    return;
  }
  const dx = Math.ceil(right) + 1;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = s.blur;
  ctx.shadowOffsetX = dx;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = '#000000';
  ctx.beginPath!();
  shape(dx);
  ctx.fill!();
  ctx.restore();
}

/**
 * The band between two rounded rectangles, the inner inside the outer, in
 * the colour already set. Where a side has no band the two edges meet, and
 * they have to be drawn one way to cancel: two `roundRect`s under the
 * even-odd rule, or two paths of curves, the inside run backwards under
 * the non-zero rule — ntk leaves a hairline along a curve drawn twice the
 * same way, and an arc beside a curve never quite meets it.
 */
function fillRing(
  ctx: PaintContext,
  outer: Rect,
  outerCorners: Corners,
  inner: Rect,
  innerCorners: Corners,
): void {
  const curves =
    canCurve(ctx) &&
    (!circlesFit(outerCorners, outer.width, outer.height) ||
      !circlesFit(innerCorners, inner.width, inner.height));
  ctx.beginPath!();
  roundedRect(
    ctx,
    outer.x,
    outer.y,
    outer.width,
    outer.height,
    outerCorners,
    curves,
  );
  if (inner.width > 0 && inner.height > 0) {
    roundedRect(
      ctx,
      inner.x,
      inner.y,
      inner.width,
      inner.height,
      innerCorners,
      curves,
      true,
    );
  }
  ctx.fill!(curves ? 'nonzero' : 'evenodd');
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
    // an inline box's is drawn a fragment at a time, on its lines
    if (child.style.outlineStyle !== 'none' && child.kind !== 'inline') {
      paintOutline(ctx, child, options);
    }
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
      while (
        containing?.parent &&
        containing.style.position === 'static' &&
        !containing.style.translate &&
        !containing.style.transformTranslate
      ) {
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

/** Whether anything in a box is positioned out of the flow, which may be
 *  outside the box's clip; kept for the tree's life. */
function holdsAbsolute(box: Box): boolean {
  let holds = HOLDS_ABSOLUTE.get(box);
  if (holds === undefined) {
    holds = false;
    for (const child of box.children) {
      if (child.outOfFlow || holdsAbsolute(child)) {
        holds = true;
        break;
      }
    }
    HOLDS_ABSOLUTE.set(box, holds);
  }
  return holds;
}

const HOLDS_ABSOLUTE = new WeakMap<Box, boolean>();

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
  if (CLIPPED_CELLS.has(box)) return true;
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
function innerRadii(box: Box): Corners | null {
  const corners = cornersOf(box.style, box.width, frameHeight(box));
  if (!corners) return null;
  const inner = insetCorners(
    corners,
    box.borderTop,
    box.borderRight,
    box.borderBottom,
    box.borderLeft,
  );
  const { x, y } = inner;
  if (
    box.padLeft >= x[0] &&
    box.padTop >= y[0] &&
    box.padRight >= x[1] &&
    box.padTop >= y[1] &&
    box.padRight >= x[2] &&
    box.padBottom >= y[2] &&
    box.padLeft >= x[3] &&
    box.padBottom >= y[3]
  ) {
    return null;
  }
  return inner;
}

/** The corners of a box's content edge, inside its borders and padding;
 *  null where every one of them is square. */
function contentCorners(box: Box): Corners | null {
  const corners = cornersOf(box.style, box.width, frameHeight(box));
  if (!corners) return null;
  const inner = insetCorners(
    corners,
    box.borderTop + box.padTop,
    box.borderRight + box.padRight,
    box.borderBottom + box.padBottom,
    box.borderLeft + box.padLeft,
  );
  for (let i = 0; i < 4; i += 1) {
    if (inner.x[i] > 0 && inner.y[i] > 0) return inner;
  }
  return null;
}

/** A box's corners in pixels: each one's horizontal and vertical radius,
 *  from the top left. */
interface Corners {
  x: [number, number, number, number];
  y: [number, number, number, number];
}

/**
 * The radii of a box's corners in pixels (CSS Backgrounds 3, 5.1): a
 * percentage is of the box's width across and of its height down, a corner
 * with either radius nought is square, and where the two on a side would
 * overlap all eight are reduced together (5.5) — which is what makes `50%`
 * an ellipse and `calc(infinity * 1px)` a pill. Null where every corner is
 * square, which is almost every box and the first thing asked.
 */
function cornersOf(style: ComputedStyle, w: number, h: number): Corners | null {
  const across = style.borderRadius;
  const down = style.borderRadiusY;
  if (
    down === null &&
    across[0] === 0 &&
    across[1] === 0 &&
    across[2] === 0 &&
    across[3] === 0
  ) {
    return null;
  }
  const vertical = down ?? across;
  const x: Corners['x'] = [0, 0, 0, 0];
  const y: Corners['y'] = [0, 0, 0, 0];
  let rounded = false;
  for (let i = 0; i < 4; i += 1) {
    const rx = resolve(across[i], w);
    const ry = resolve(vertical[i], h);
    if (!(rx > 0 && ry > 0)) continue;
    x[i] = rx;
    y[i] = ry;
    rounded = true;
  }
  if (!rounded) return null;
  let f = 1;
  const fit = (side: number, sum: number): void => {
    if (sum > side) f = Math.min(f, Math.max(0, side) / sum);
  };
  fit(w, x[0] + x[1]);
  fit(h, y[1] + y[2]);
  fit(w, x[2] + x[3]);
  fit(h, y[3] + y[0]);
  if (f < 1) {
    for (let i = 0; i < 4; i += 1) {
      x[i] *= f;
      y[i] *= f;
    }
  }
  return { x, y };
}

/** The corners of an edge inside a box's outer one — its padding edge,
 *  inside its borders: each radius less the width of the border across it
 *  (CSS Backgrounds 3, 5.2), and square where that leaves none. */
function insetCorners(
  c: Corners,
  top: number,
  right: number,
  bottom: number,
  left: number,
): Corners {
  const x: Corners['x'] = [
    Math.max(0, c.x[0] - left),
    Math.max(0, c.x[1] - right),
    Math.max(0, c.x[2] - right),
    Math.max(0, c.x[3] - left),
  ];
  const y: Corners['y'] = [
    Math.max(0, c.y[0] - top),
    Math.max(0, c.y[1] - top),
    Math.max(0, c.y[2] - bottom),
    Math.max(0, c.y[3] - bottom),
  ];
  return { x, y };
}

/** How far along a quarter ellipse's radius its Bézier handles reach. */
const KAPPA = 0.5522847498307936;

/**
 * Whether `roundRect` draws these corners as CSS has them: every one a
 * circle, and none more than half the shorter side — the Cocoa context's
 * clamps each corner to that on its own, where CSS reduces them together.
 */
function circlesFit(c: Corners, w: number, h: number): boolean {
  const [a, b, d, e] = c.x;
  const [p, q, r, t] = c.y;
  return (
    a === p &&
    b === q &&
    d === r &&
    e === t &&
    Math.max(a, b, d, e) <= Math.min(w, h) / 2
  );
}

/** Whether the context builds a path of curves, as both backends' do. */
function canCurve(ctx: PaintContext): boolean {
  return !!(ctx.moveTo && ctx.lineTo && ctx.bezierCurveTo && ctx.closePath);
}

/**
 * A rectangle with rounded corners, added to the path being built as a
 * subpath of its own: `roundRect` where its circles fit, which ntk fills
 * quickest, and four curves where they do not — an ellipse, which the
 * Cocoa context's `roundRect` cannot draw at all. `curves` asks for the
 * curves regardless, and `reverse` has them run anticlockwise, which is
 * how a hole is cut in the subpath around it.
 */
function roundedRect(
  ctx: PaintContext,
  x: number,
  y: number,
  w: number,
  h: number,
  c: Corners,
  curves = !circlesFit(c, w, h),
  reverse = false,
): void {
  const [a, b, d, e] = c.x;
  const [p, q, r, t] = c.y;
  if (!curves || !canCurve(ctx)) {
    ctx.roundRect!(x, y, w, h, [
      Math.min(a, p),
      Math.min(b, q),
      Math.min(d, r),
      Math.min(e, t),
    ]);
    return;
  }
  const k = 1 - KAPPA;
  const right = x + w;
  const bottom = y + h;
  const moveTo = ctx.moveTo!.bind(ctx);
  const lineTo = ctx.lineTo!.bind(ctx);
  const curveTo = ctx.bezierCurveTo!.bind(ctx);
  if (!reverse) {
    moveTo(x + a, y);
    lineTo(right - b, y);
    curveTo(right - b * k, y, right, y + q * k, right, y + q);
    lineTo(right, bottom - r);
    curveTo(right, bottom - r * k, right - d * k, bottom, right - d, bottom);
    lineTo(x + e, bottom);
    curveTo(x + e * k, bottom, x, bottom - t * k, x, bottom - t);
    lineTo(x, y + p);
    curveTo(x, y + p * k, x + a * k, y, x + a, y);
  } else {
    moveTo(x + a, y);
    curveTo(x + a * k, y, x, y + p * k, x, y + p);
    lineTo(x, bottom - t);
    curveTo(x, bottom - t * k, x + e * k, bottom, x + e, bottom);
    lineTo(right - d, bottom);
    curveTo(right - d * k, bottom, right, bottom - r * k, right, bottom - r);
    lineTo(right, y + q);
    curveTo(right, y + q * k, right - b * k, y, right - b, y);
  }
  ctx.closePath!();
}

/** Clip what follows to a rectangle, rounded where `radii` are: false
 *  where the context cannot clip, and nothing was pushed. */
function pushClip(
  ctx: PaintContext,
  rect: { x: number; y: number; w: number; h: number },
  radii: Corners | null,
): boolean {
  if (!ctx.beginPath || !ctx.rect || !ctx.clip) return false;
  ctx.save();
  ctx.beginPath();
  const w = Math.max(0, rect.w);
  const h = Math.max(0, rect.h);
  if (radii && ctx.roundRect) roundedRect(ctx, rect.x, rect.y, w, h, radii);
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
  const style = child.style;
  if (
    style.position !== 'relative' &&
    style.position !== 'sticky' &&
    !style.translate &&
    !style.transformTranslate
  ) {
    return false;
  }
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

/** `clampRect` with a margin of its own, as a `Rect`. */
function clampAround(options: PaintOptions, r: Rect, pad: number): Rect | null {
  const damage = options.damage;
  const x1 = Math.max(r.x, damage ? damage.x - pad : -COORD_LIMIT);
  const y1 = Math.max(r.y, damage ? damage.y - pad : -COORD_LIMIT);
  const x2 = Math.min(
    r.x + r.width,
    damage ? damage.x + damage.width + pad : COORD_LIMIT,
  );
  const y2 = Math.min(
    r.y + r.height,
    damage ? damage.y + damage.height + pad : COORD_LIMIT,
  );
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

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
  style: ComputedStyle,
): void {
  const color = style.backgroundColor;
  const gradient = style.backgroundGradient;
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
  const rounded =
    ctx.roundRect && ctx.fill && ctx.beginPath ? cornersOf(style, w, h) : null;
  const fill = (): void => {
    if (rounded) {
      // The clamp can only have cut edges further than CLAMP_PAD outside
      // the damage, and a sane radius is smaller than that — so a corner
      // that survives the cut is whole, and a cut edge is offscreen.
      ctx.beginPath!();
      roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, rounded);
      ctx.fill!();
    } else ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  };
  if (solid) {
    ctx.fillStyle = inkColor(color as string, style.color);
    fill();
  }
  if (gradient && ctx.createLinearGradient) {
    // over the colour, as the layer an image is: the size of the padding
    // box, which is where it starts, and repeated under the borders — or
    // the viewport's, where it is fixed; its line runs across the whole of
    // it, not the part this paint reaches
    const fixed = style.backgroundAttachment === 'fixed' && options.canvas;
    const at = fixed
      ? snapped(fixed.x, fixed.y, fixed.width, fixed.height)
      : snapped(
          left + box.borderLeft,
          top + box.borderTop,
          box.width - box.borderLeft - box.borderRight,
          frameHeight(box) - box.borderTop - box.borderBottom,
        );
    if (rounded && style.backgroundSize !== 'auto' && ctx.clip) {
      // tiles of the size it was given, cut to the rounded shape
      ctx.save();
      ctx.beginPath!();
      roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, rounded);
      ctx.clip();
      paintGradient(ctx, style, gradient, rect, at);
      ctx.restore();
    } else if (rounded) {
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
        style.color,
        rect,
      );
      fill();
    } else paintGradient(ctx, style, gradient, rect, at);
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

/** A gradient's own size: none, and no ratio. */
const NO_SIZE: IntrinsicSize = { width: null, height: null, ratio: 0 };

/**
 * A gradient layer across `area`: an image the size `background-size`
 * gives it, the size of `at` where that is `auto` (CSS Backgrounds 3, 3.9 —
 * an image with no size of its own is the size of its positioning area),
 * placed by `background-position` and repeated as `background-repeat`
 * says. Each tile is its own fill, so a tile's colours are the first's.
 */
function paintGradient(
  ctx: PaintContext,
  style: ComputedStyle,
  gradient: LinearGradient,
  area: { x: number; y: number; w: number; h: number },
  at: Rect,
): void {
  // a gradient has no size of its own: the positioning area's, unless
  // `background-size` gives it one, and then `background-position` places
  // it in the area as it does an image
  const [w, h] = sizedTile(style.backgroundSize, NO_SIZE, at, 1);
  if (!(w > 0 && h > 0)) return;
  const x0 =
    w === at.width
      ? at.x
      : at.x + resolve(style.backgroundPositionX, at.width - w);
  const y0 =
    h === at.height
      ? at.y
      : at.y + resolve(style.backgroundPositionY, at.height - h);
  const repeat = style.backgroundRepeat;
  const acrossX = repeat === 'repeat' || repeat === 'repeat-x';
  const acrossY = repeat === 'repeat' || repeat === 'repeat-y';
  const fromX = acrossX ? x0 - Math.ceil((x0 - area.x) / w) * w : x0;
  const fromY = acrossY ? y0 - Math.ceil((y0 - area.y) / h) * h : y0;
  const toX = acrossX ? area.x + area.w : x0 + w;
  const toY = acrossY ? area.y + area.h : y0 + h;
  if (Math.ceil((toX - fromX) / w) * Math.ceil((toY - fromY) / h) > MAX_TILES) {
    // a sliver of a root repeated down a long canvas: the one tile, and
    // its end colours on past it
    ctx.fillStyle = linearGradient(
      ctx,
      gradient,
      x0,
      y0,
      w,
      h,
      style.color,
      area,
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
      const tile = { x: left, y: top, w: right - left, h: bottom - top };
      ctx.fillStyle = linearGradient(
        ctx,
        gradient,
        x,
        y,
        w,
        h,
        style.color,
        tile,
      );
      ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
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
  visible: { x: number; y: number; w: number; h: number } | null = null,
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
  const x0 = startX + dx * length * from;
  const y0 = startY + dy * length * from;
  const x1 = startX + dx * length * to;
  const y1 = startY + dy * length * to;
  const colors = stops.map((stop) => inkColor(stop.color, currentColor));
  if (
    visible &&
    length > 0 &&
    !(
      Math.abs(x0) < GRADIENT_REACH &&
      Math.abs(y0) < GRADIENT_REACH &&
      Math.abs(x1) < GRADIENT_REACH &&
      Math.abs(y1) < GRADIENT_REACH
    )
  ) {
    return clippedGradient(
      ctx,
      at as number[],
      colors,
      startX,
      startY,
      dx * length,
      dy * length,
      visible,
    );
  }
  const g = ctx.createLinearGradient!(x0, y0, x1, y1);
  for (let i = 0; i < stops.length; i += 1) {
    g.addColorStop((at[i]! - from) / (to - from), colors[i]);
  }
  return g;
}

/**
 * How far from the origin a gradient's line may end. X RENDER takes the
 * ends in 16.16 fixed point, and a pair past ±32,767 pixels threw from the
 * paint: a gradient down a document's long wrapper, scrolled far enough,
 * or a stop at `calc(1px / 0)`.
 */
const GRADIENT_REACH = 16384;

/**
 * A gradient's line cut to the part `visible` sees — the colours the rest
 * of it holds are never drawn — and moved along its perpendicular to run
 * through `visible`, which a linear gradient's colours do not change
 * along. `at` is where each stop is on the line from (`sx`, `sy`) that
 * runs (`lx`, `ly`) for 1; a stop before or past the part is its colour
 * there instead.
 */
function clippedGradient(
  ctx: PaintContext,
  at: number[],
  colors: string[],
  sx: number,
  sy: number,
  lx: number,
  ly: number,
  visible: { x: number; y: number; w: number; h: number },
): unknown {
  const along = (px: number, py: number): number =>
    ((px - sx) * lx + (py - sy) * ly) / (lx * lx + ly * ly);
  // and no further out than a context draws
  const left = Math.max(visible.x, -GRADIENT_REACH);
  const top = Math.max(visible.y, -GRADIENT_REACH);
  const right = Math.max(left, Math.min(visible.x + visible.w, GRADIENT_REACH));
  const bottom = Math.max(top, Math.min(visible.y + visible.h, GRADIENT_REACH));
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const [px, py] of [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ]) {
    const t = along(px, py);
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
  }
  if (!(t1 > t0)) t1 = t0 + 1e-6;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const tc = along(cx, cy);
  const g = ctx.createLinearGradient!(
    cx + (t0 - tc) * lx,
    cy + (t0 - tc) * ly,
    cx + (t1 - tc) * lx,
    cy + (t1 - tc) * ly,
  );
  // the colour at a place on the line: a stop's, or between two
  const colorAt = (t: number): string => {
    if (!(t > at[0])) return colors[0];
    for (let i = 1; i < at.length; i += 1) {
      if (t > at[i]) continue;
      const span = at[i] - at[i - 1];
      const f = span > 0 ? (t - at[i - 1]) / span : 1;
      return (
        blend(colors[i - 1], colors[i], f) ??
        (f < 0.5 ? colors[i - 1] : colors[i])
      );
    }
    return colors[colors.length - 1];
  };
  g.addColorStop(0, colorAt(t0));
  for (let i = 0; i < at.length; i += 1) {
    if (at[i] > t0 && at[i] < t1) {
      g.addColorStop((at[i] - t0) / (t1 - t0), colors[i]);
    }
  }
  g.addColorStop(1, colorAt(t1));
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
      if (!part || !paintsPart(part) || hidden(cell.box)) continue;
      const box = cell.box;
      const frame: Frame = {
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
      };
      paintLayers(ctx, frame, options, (style) => {
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
          paintBackgroundImage(ctx, style, area, at, options);
        }
      });
    }
  }
}

const columnOf = (cell: Cell): number => cell.column;

/**
 * A cell `empty-cells: hide` leaves undrawn: one with no content, where
 * borders are separate — no background of its own or of its row, its
 * column or their groups, and no borders (CSS 2.1 17.6.1.1). A cell holds
 * content when anything in its flow does, an empty element or a float
 * among it, but not white space its `white-space` collapses away.
 */
function hidden(cell: Box): boolean {
  if (cell.kind !== 'table-cell' || cell.style.emptyCells !== 'hide') {
    return false;
  }
  if (cell.bordersCollapsed) return false;
  for (const child of cell.children) {
    if (child.outOfFlow) continue;
    if (child.kind !== 'text' || !BLANK_TEXT.test(child.text)) return false;
    const ws = child.style.whiteSpace;
    if (ws === 'pre' || ws === 'pre-wrap') return false;
    if (ws === 'pre-line' && /[\n\r]/.test(child.text)) return false;
  }
  return true;
}

const BLANK_TEXT = /^[ \t\n\r\f]*$/;

/** Whether a table part has a background to paint: a colour, or an image. */
function paintsPart(box: Box | null): boolean {
  if (box === null || box.style.visibility !== 'visible') return false;
  return (
    !isTransparent(box.style.backgroundColor) ||
    !!box.style.backgroundImage ||
    !!box.style.backgroundImages
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
  corners: Corners | null = null,
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
  const [iw, ih] = sizedTile(style.backgroundSize, loaded, at, scale);
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
    // in the box's corners, as its colour is (CSS Backgrounds 3, 5.3)
    if (corners && ctx.roundRect) {
      roundedRect(ctx, area.x, area.y, area.w, area.h, corners);
    } else ctx.rect(area.x, area.y, area.w, area.h);
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
  } else if (
    tiles > 1 &&
    iw === loaded.width &&
    ih === loaded.height &&
    ctx.createPattern &&
    ctx.translate
  ) {
    // a pattern tiles from the origin of the space it is filled in, and
    // draws the image at its own size: a tile of a device pixel an image
    // pixel, which is 1x and `background-size` leaving it be
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
 * A background tile's size (CSS Backgrounds 3, 3.9, over CSS Images' sizing
 * of an object): `auto` is the image's own, as `tileSize` has it; `cover`
 * and `contain` scale it to fill the positioning area or to fit inside it,
 * keeping its ratio, and one with no ratio is the size of the area; and a
 * width or a height alone takes the other from the ratio, or else from the
 * image's own size in it, or else from the area. Percentages are of the
 * area.
 */
function sizedTile(
  size: ComputedStyle['backgroundSize'],
  image: IntrinsicSize,
  area: Rect,
  scale: number,
): [number, number] {
  if (size === 'auto') return tileSize(image, area, scale);
  const { ratio } = image;
  if (size === 'cover' || size === 'contain') {
    if (!(ratio > 0 && area.height > 0)) return [area.width, area.height];
    const wider = area.width / area.height > ratio;
    return (size === 'cover') === wider
      ? [area.width, area.width / ratio]
      : [area.height * ratio, area.height];
  }
  const [sw, sh] = size;
  const w = sw === 'auto' ? null : resolve(sw, area.width);
  const h = sh === 'auto' ? null : resolve(sh, area.height);
  if (w !== null && h !== null) return [w, h];
  if (w !== null) {
    if (ratio > 0) return [w, w / ratio];
    return [w, image.height === null ? area.height : image.height * scale];
  }
  if (h !== null) {
    if (ratio > 0) return [h * ratio, h];
    return [image.width === null ? area.width : image.width * scale, h];
  }
  return tileSize(image, area, scale);
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
/**
 * A box's outline (CSS 2.1 18.4, CSS UI 4 5): a border of its own width,
 * style and colour round the border box grown by `outline-offset` — which
 * a negative offset brings inside it, as Tailwind UI's `-outline-offset-1`
 * frames an image with a hairline over its edge — with the box's corners
 * grown along with it, and taking no room. Drawn over the box's content,
 * which is where a browser draws it; `auto` is drawn solid.
 */
function paintOutline(
  ctx: PaintContext,
  box: Frame,
  options: PaintOptions,
): void {
  const s = box.style;
  const width = s.outlineWidth;
  if (!(width > 0) || s.visibility !== 'visible') return;
  const grow = s.outlineOffset + width;
  const height = frameHeight(box);
  const w = box.width + 2 * grow;
  const h = height + 2 * grow;
  if (!(w > 0 && h > 0)) return;
  const corners = cornersOf(s, box.width, height);
  const kind = s.outlineStyle === 'auto' ? 'solid' : s.outlineStyle;
  const grown = (r: number): number => (r > 0 ? Math.max(0, r + grow) : 0);
  const ring = copyStyle(s);
  ring.borderTopStyle = kind;
  ring.borderRightStyle = kind;
  ring.borderBottomStyle = kind;
  ring.borderLeftStyle = kind;
  ring.borderTopColor = s.outlineColor;
  ring.borderRightColor = s.outlineColor;
  ring.borderBottomColor = s.outlineColor;
  ring.borderLeftColor = s.outlineColor;
  ring.borderRadius = corners
    ? (corners.x.map(grown) as ComputedStyle['borderRadius'])
    : [0, 0, 0, 0];
  ring.borderRadiusY = corners
    ? (corners.y.map(grown) as ComputedStyle['borderRadius'])
    : null;
  paintBorders(
    ctx,
    {
      x: box.x - grow,
      y: frameY(box) - grow,
      width: w,
      height: h,
      captionTop: 0,
      captionBottom: 0,
      borderTop: width,
      borderRight: width,
      borderBottom: width,
      borderLeft: width,
      style: ring,
    },
    options,
  );
}

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
  if (sculpted(s) && paintSculpted(ctx, box, x, y, w, h, options)) return;

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
  if (!ctx.roundRect || !ctx.fill || !ctx.beginPath) return false;
  const corners = cornersOf(s, w, h);
  if (!corners) return false;
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
  ctx.fillStyle = inkColor(color, s.color);
  fillRing(
    ctx,
    { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
    corners,
    {
      x: rect.x + left,
      y: rect.y + top,
      width: Math.max(0, rect.w - left - right),
      height: Math.max(0, rect.h - top - bottom),
    },
    insetCorners(corners, top, right, bottom, left),
  );
  return true;
}

/** The border styles drawn in two shades, as though lit from the top left. */
const SCULPTED = new Set(['groove', 'ridge', 'inset', 'outset']);

function sculpted(s: ComputedStyle): boolean {
  return (
    SCULPTED.has(s.borderTopStyle) ||
    SCULPTED.has(s.borderRightStyle) ||
    SCULPTED.has(s.borderBottomStyle) ||
    SCULPTED.has(s.borderLeftStyle)
  );
}

/**
 * A border with a 3D style in it, a side at a time as a trapezoid whose
 * ends meet its neighbours' on the diagonal, so a corner is shared rather
 * than stacked (CSS 2.1 8.5.3). `inset` shades its top and left in the
 * colour's shadow and `outset` its bottom and right; `groove` is `inset`
 * outside `outset`, a band each, and `ridge` the other way round
 * (`borderShades`). A side of any other style takes its trapezoid in its
 * colour. The trapezoids are clamped to the painted area, which leaves a
 * cut end square and out of sight and keeps a long box's far corners out
 * of X's coordinates. False where the context cannot draw a path, and the
 * sides are drawn straight.
 */
function paintSculpted(
  ctx: PaintContext,
  box: Frame,
  x: number,
  y: number,
  w: number,
  h: number,
  options: PaintOptions,
): boolean {
  if (!ctx.beginPath || !ctx.moveTo || !ctx.lineTo || !ctx.fill) return false;
  const area = clampRect(options, x, y, w, h);
  if (!area) return true;
  const s = box.style;
  const t = box.borderTop;
  const r = box.borderRight;
  const b = box.borderBottom;
  const l = box.borderLeft;
  const cx = (v: number) =>
    Math.max(area.x - 1, Math.min(v, area.x + area.w + 1));
  const cy = (v: number) =>
    Math.max(area.y - 1, Math.min(v, area.y + area.h + 1));
  /** The band between the edge `outer` of the way in and `inner`, for one
   *  side: 0 is the border box, 1 the padding box. */
  const band = (side: number, outer: number, inner: number, color: string) => {
    const at = (k: number) => ({
      x0: x + l * k,
      y0: y + t * k,
      x1: x + w - r * k,
      y1: y + h - b * k,
    });
    const o = at(outer);
    const i = at(inner);
    const points =
      side === 0
        ? [o.x0, o.y0, o.x1, o.y0, i.x1, i.y0, i.x0, i.y0]
        : side === 1
          ? [o.x1, o.y0, o.x1, o.y1, i.x1, i.y1, i.x1, i.y0]
          : side === 2
            ? [o.x1, o.y1, o.x0, o.y1, i.x0, i.y1, i.x1, i.y1]
            : [o.x0, o.y1, o.x0, o.y0, i.x0, i.y0, i.x0, i.y1];
    ctx.fillStyle = color;
    ctx.beginPath!();
    ctx.moveTo!(cx(points[0]), cy(points[1]));
    for (let k = 2; k < 8; k += 2)
      ctx.lineTo!(cx(points[k]), cy(points[k + 1]));
    ctx.closePath?.();
    ctx.fill!();
  };
  const sides: [number, string, string][] = [
    [t, s.borderTopStyle, s.borderTopColor],
    [r, s.borderRightStyle, s.borderRightColor],
    [b, s.borderBottomStyle, s.borderBottomColor],
    [l, s.borderLeftStyle, s.borderLeftColor],
  ];
  for (let side = 0; side < 4; side += 1) {
    const [width, style, raw] = sides[side];
    if (!(width > 0) || style === 'none' || style === 'hidden') continue;
    if (isTransparent(raw)) continue;
    const color = inkColor(raw, s.color);
    if (!SCULPTED.has(style)) {
      band(side, 0, 1, color);
      continue;
    }
    const shades = borderShades(color) ?? { lit: color, shadowed: color };
    // the top and the left face the light
    const lit = side === 0 || side === 3;
    const shade = (sunk: boolean) =>
      sunk === lit ? shades.shadowed : shades.lit;
    if (style === 'inset' || style === 'outset') {
      band(side, 0, 1, shade(style === 'inset'));
    } else {
      band(side, 0, 0.5, shade(style === 'groove'));
      band(side, 0.5, 1, shade(style !== 'groove'));
    }
  }
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
    /** Where on the grid it starts: its row, and its column. */
    row: number;
    column: number;
  }[] = [];
  // A border centred on a grid line starts half its width before it,
  // rounded there: a line at 12.5 carries a 25px border from 0, where
  // rounding the line first and taking a whole half off drew it from 1
  const from = (line: number, width: number): number =>
    Math.round(line - width / 2);
  for (let line = 0; line <= R; line += 1) {
    for (let c = 0; c < C; c += 1) {
      const border = horizontal[line * C + c];
      if (!border) continue;
      const start = Math.max(v(line - 1, c), v(line, c));
      const end = Math.max(v(line - 1, c + 1), v(line, c + 1));
      const x = ox + from(lineX[c], start);
      segments.push({
        border,
        x,
        y: oy + from(lineY[line], border.width),
        w: ox + from(lineX[c + 1], end) + end - x,
        h: border.width,
        horizontal: true,
        row: line,
        column: c,
      });
    }
  }
  for (let r = 0; r < R; r += 1) {
    for (let line = 0; line <= C; line += 1) {
      const border = vertical[r * (C + 1) + line];
      if (!border) continue;
      const start = Math.max(h(r, line - 1), h(r, line));
      const end = Math.max(h(r + 1, line - 1), h(r + 1, line));
      const y = oy + from(lineY[r], start);
      segments.push({
        border,
        x: ox + from(lineX[line], border.width),
        y,
        w: border.width,
        h: oy + from(lineY[r + 1], end) + end - y,
        horizontal: false,
        row: r,
        column: line,
      });
    }
  }
  // The winners last, where segments cross — and between two that won
  // alike, the one further up and further left, as between two borders
  // on one segment (CSS 2.1 17.6.2.1): a corner four equal borders meet
  // at is the top-left cell's. Painted in the order they were found, the
  // segment below a corner took it.
  segments.sort(
    (a, b) =>
      a.border.rank - b.border.rank || b.row - a.row || b.column - a.column,
  );
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
  const x = marker.x + options.originX;
  const y = marker.y + options.originY;
  if (marker.image) {
    // `list-style-image`'s, at its own size
    const { url, width, height } = marker.image;
    const loaded = options.backgroundImageFor?.(url);
    if (!loaded || !(width > 0 && height > 0)) return;
    if (loaded.image instanceof SvgDrawing) {
      loaded.image.draw(ctx, x, y, width, height, options.scale ?? 1);
    } else ctx.drawImage?.(loaded.image, x, y, width, height);
    return;
  }
  marker.layout?.draw(ctx, x, y);
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
  if (image instanceof SvgDrawing || (image && ctx.drawImage)) {
    const at = fitted(box, x, y, w, h);
    // trimmed to the curve of its content edge (CSS Backgrounds 3, 5.3):
    // an avatar is a round photograph. A rounded clip is a mask the size
    // of the window on X11, so only a box that has corners pays for one;
    // an image `object-fit` puts past its box is cut by a rectangle
    const corners = contentCorners(box);
    const past =
      at.x < x || at.y < y || at.x + at.w > x + w || at.y + at.h > y + h;
    const clipped =
      (!!corners || past) && pushClip(ctx, { x, y, w, h }, corners);
    if (image instanceof SvgDrawing) {
      image.draw(ctx, at.x, at.y, at.w, at.h, options.scale ?? 1);
    } else ctx.drawImage!(image, at.x, at.y, at.w, at.h);
    if (clipped) ctx.restore();
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

/**
 * Where an image is drawn in its content box (CSS Images 3, 5.5):
 * stretched to it, the `fill` everything is by default, or at its own
 * ratio — within it (`contain`), over the whole of it (`cover`, which
 * Tailwind's `object-cover` avatars and card images are), at its own size
 * (`none`), or the smaller of those two (`scale-down`) — and placed by
 * `object-position`, the middle unless it says otherwise.
 */
function fitted(
  box: Box,
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  const fit = box.style.objectFit;
  const own = box.intrinsic;
  if (
    fit === 'fill' ||
    !own ||
    own.missing ||
    !(own.width > 0 && own.height > 0)
  ) {
    return { x, y, w, h };
  }
  const contain = Math.min(w / own.width, h / own.height);
  const scale =
    fit === 'contain'
      ? contain
      : fit === 'cover'
        ? Math.max(w / own.width, h / own.height)
        : fit === 'none'
          ? 1
          : Math.min(1, contain);
  const dw = own.width * scale;
  const dh = own.height * scale;
  return {
    x: x + resolve(box.style.objectPositionX, w - dw),
    y: y + resolve(box.style.objectPositionY, h - dh),
    w: dw,
    h: dh,
  };
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

  if (SHADOWED_TEXT.has(box)) paintTextShadows(ctx, visible, options);

  // an underline goes under the glyphs, a line through over them (CSS 2.1
  // Appendix E): a descender crosses its own underline
  paintRules(ctx, visible, dx, dy, options.scale ?? 1, 'under');

  if (CLIPPED_TEXT.has(box)) paintClippedText(ctx, box, visible, options);

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

/**
 * The backgrounds painted through text (`background-clip: text`, CSS
 * Backgrounds 4): Tailwind's `bg-clip-text text-transparent` over a
 * gradient, which is how a landing page colours its headline. The text is
 * laid out again with no ink of its own (`inklessLayout`) and drawn with
 * the box's background as the fill — a gradient, which both engines fill
 * glyphs with, or its colour — clipped to the runs that are the box's, so
 * the text around them keeps its own ink. The gradient spans the box's
 * padding box, or an inline box's own runs and its padding.
 */
function paintClippedText(
  ctx: PaintContext,
  block: Box,
  lines: LineBox[],
  options: PaintOptions,
): void {
  if (!ctx.save || !ctx.restore || !ctx.beginPath || !ctx.rect || !ctx.clip)
    return;
  const dx = options.originX;
  const dy = options.originY;
  interface Part {
    layout: LineText['layout'];
    x: number;
    y: number;
    rects: Rect[];
  }
  // each box's runs, a layout at a time: one draw a layout, clipped to all
  // of them
  const parts = new Map<Box, Map<object, Part>>();
  for (const line of lines) {
    for (const text of line.texts) {
      const natural = text.layout.lines[text.layoutLine];
      if (!natural) continue;
      const x = text.drawX + dx;
      const y = text.drawY + dy;
      // a glyph may reach past its line box, where its line is tight
      const top =
        y + Math.min(natural.y, natural.baseline - (natural.ascent ?? 0)) - 2;
      const bottom =
        y +
        Math.max(
          natural.y + natural.height,
          natural.baseline + (natural.descent ?? 0),
        ) +
        2;
      for (const run of natural.runs) {
        const clip = clipBoxOf(text.spans.boxAt?.(run.start) ?? null, block);
        if (!clip) continue;
        let byLayout = parts.get(clip);
        if (!byLayout) parts.set(clip, (byLayout = new Map()));
        let part = byLayout.get(text.layout);
        if (!part) {
          part = { layout: text.layout, x, y, rects: [] };
          byLayout.set(text.layout, part);
        }
        part.rects.push({
          x: x + natural.x + run.x - 1,
          y: top,
          width: run.width + 2,
          height: bottom - top,
        });
      }
    }
  }
  for (const [clip, byLayout] of parts) {
    const list = [...byLayout.values()];
    const style = clip.style;
    let area: Rect;
    if (clip === block) area = paddingBox(block, options);
    else {
      // an inline box: its runs, and its padding round them
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const part of list) {
        for (const r of part.rects) {
          x0 = Math.min(x0, r.x);
          y0 = Math.min(y0, r.y);
          x1 = Math.max(x1, r.x + r.width);
          y1 = Math.max(y1, r.y + r.height);
        }
      }
      area = {
        x: x0 - clip.padLeft,
        y: y0 - clip.padTop,
        width: x1 - x0 + clip.padLeft + clip.padRight,
        height: y1 - y0 + clip.padTop + clip.padBottom,
      };
    }
    const gradient =
      style.backgroundGradient ??
      (style.backgroundImages?.find(
        (image): image is LinearGradient =>
          image !== null && typeof image !== 'string',
      ) ||
        null);
    let fill: unknown = null;
    if (gradient && ctx.createLinearGradient) {
      if (!(area.width > 0 && area.height > 0)) continue;
      // the text it shows through: what the fill is drawn over
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const part of list) {
        for (const r of part.rects) {
          x0 = Math.min(x0, r.x);
          y0 = Math.min(y0, r.y);
          x1 = Math.max(x1, r.x + r.width);
          y1 = Math.max(y1, r.y + r.height);
        }
      }
      fill = linearGradient(
        ctx,
        gradient,
        area.x,
        area.y,
        area.width,
        area.height,
        style.color,
        x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null,
      );
    } else if (!isTransparent(style.backgroundColor)) {
      fill = inkColor(style.backgroundColor as string, style.color);
    }
    if (fill === null) continue;
    for (const part of list) {
      const inkless = inklessLayout(part.layout);
      if (!inkless) continue;
      ctx.save();
      ctx.beginPath();
      for (const r of part.rects) ctx.rect(r.x, r.y, r.width, r.height);
      ctx.clip();
      ctx.fillStyle = fill;
      inkless.draw(ctx, part.x, part.y);
      ctx.restore();
    }
  }
}

/** The shadows one stretch of a layout's text casts, and the colour its
 *  `currentColor` is. */
interface Cast {
  shadows: BoxShadow[];
  color: string;
}

/**
 * The shadows text casts (CSS Text Decoration 3, 4), under it and its
 * underline: a layout drawn again for each shadow, the last first, as
 * `fillShadow` draws a box's — clear of the window to the left, the
 * shadow offset back by as much — so that only the shadow lands. The
 * engines draw a layout's glyphs in its runs' own colours, and a copy in a
 * shadow's would be another layout. One whose runs do not all cast the
 * same shadows draws each stretch's clipped to it, a line at a time.
 */
function paintTextShadows(
  ctx: PaintContext,
  lines: LineBox[],
  options: PaintOptions,
): void {
  if (!('shadowBlur' in ctx) || !ctx.save || !ctx.restore) return;
  const dx = options.originX;
  const dy = options.originY;
  const whole = new Set<unknown>();
  for (const line of lines) {
    for (const text of line.texts) {
      const layout = text.layout;
      const top = text.drawY + dy;
      if (top < -COORD_LIMIT || top + layout.height > COORD_LIMIT) continue;
      const cast = castOf(text);
      if (cast === null) continue;
      const left = text.drawX + dx;
      if (cast !== MIXED) {
        // every run casts the same: the layout's once for each shadow
        if (whole.has(layout)) continue;
        whole.add(layout);
        castShadows(ctx, text, left, top, cast, null);
        continue;
      }
      const natural = layout.lines[text.layoutLine];
      if (!natural || !text.spans.boxAt) continue;
      for (const [stretch, from, to] of stretchesOf(text, natural)) {
        castShadows(ctx, text, left, top, stretch, {
          x: left + natural.x + from,
          y: text.drawY + dy + natural.y,
          width: to - from,
          height: natural.height,
        });
      }
    }
  }
}

/** A layout whose runs do not all cast the same shadows. */
const MIXED: Cast = { shadows: [], color: '' };

/** What a layout's runs cast: null for none, the one cast of all of them,
 *  or `MIXED`. Kept by the map of its runs to their boxes, which is its
 *  paragraph's own — not by the layout, which another paragraph of the same
 *  runs may share, casting other shadows or none, since a shadow is no
 *  field of a run. */
const CASTS = new WeakMap<object, Cast | null>();

function castOf(text: LineText): Cast | null {
  const layout = text.layout;
  if (CASTS.has(text.spans)) return CASTS.get(text.spans)!;
  let cast: Cast | null | undefined;
  const boxAt = text.spans.boxAt;
  for (const natural of layout.lines) {
    for (const run of natural.runs) {
      // a spacer, or a bidi control, is no one's text and draws nothing
      const style = boxAt?.call(text.spans, run.start)?.style;
      if (!style) continue;
      const shadows = style.textShadow;
      const next = shadows ? { shadows, color: style.color } : null;
      if (cast === undefined) cast = next;
      else if (!sameCast(cast, next)) cast = MIXED;
      if (cast === MIXED) break;
    }
    if (cast === MIXED) break;
  }
  CASTS.set(text.spans, cast ?? null);
  return cast ?? null;
}

function sameCast(a: Cast | null, b: Cast | null): boolean {
  return (
    a === b || (!!a && !!b && a.shadows === b.shadows && a.color === b.color)
  );
}

/** The stretches of one line of a layout that cast shadows: each cast, and
 *  where along the line its runs start and end. */
function stretchesOf(
  text: LineText,
  natural: LineText['layout']['lines'][number],
): [Cast, number, number][] {
  const out: [Cast, number, number][] = [];
  for (const run of natural.runs) {
    const style = text.spans.boxAt!.call(text.spans, run.start)?.style;
    if (!style?.textShadow) continue;
    const cast = { shadows: style.textShadow, color: style.color };
    const last = out[out.length - 1];
    if (last && sameCast(last[0], cast) && Math.abs(last[2] - run.x) < 0.5) {
      last[2] = Math.max(last[2], run.x + run.width);
    } else out.push([cast, run.x, run.x + run.width]);
  }
  return out;
}

/** A layout's shadows, drawn where `left` and `top` put it, each clipped to
 *  `stretch` where the layout's runs do not all cast them. */
function castShadows(
  ctx: PaintContext,
  text: LineText,
  left: number,
  top: number,
  cast: Cast,
  stretch: { x: number; y: number; width: number; height: number } | null,
): void {
  const layout = text.layout;
  // clear of the window: the far end of its furthest line, which a line
  // `text-align` moves in from the layout's left reaches past its width,
  // at the window's left
  let right = layout.width;
  for (const natural of layout.lines) {
    right = Math.max(right, natural.x + natural.width);
  }
  const shift = Math.ceil(left + right) + 1;
  for (let i = cast.shadows.length - 1; i >= 0; i -= 1) {
    const s = cast.shadows[i];
    ctx.save!();
    if (stretch && ctx.beginPath && ctx.rect && ctx.clip) {
      // the stretch, as far as its shadow falls
      const reach = shadowReach(s.blur);
      ctx.beginPath();
      ctx.rect(
        stretch.x + Math.min(0, s.x) - reach,
        stretch.y + Math.min(0, s.y) - reach,
        stretch.width + Math.abs(s.x) + 2 * reach,
        stretch.height + Math.abs(s.y) + 2 * reach,
      );
      ctx.clip();
    }
    ctx.shadowColor = inkColor(s.color, cast.color);
    // CoreGraphics casts no shadow with no blur at all: a hard one is one
    // blurred too little to see
    ctx.shadowBlur = s.blur > 0 ? s.blur : 0.01;
    ctx.shadowOffsetX = s.x + shift;
    ctx.shadowOffsetY = s.y;
    layout.draw(ctx, left - shift, top);
    ctx.restore!();
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
  paintLayers(
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
    const moved = shifted ? offsetOf(box) : null;
    const style = fragmentStyle(box.style, leftEnds, rightEnds);
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
      style,
    };
    if (fragment.width <= 0) continue;
    paintLayers(ctx, fragment, options);
    paintBorders(ctx, fragment, options);
    if (box.style.outlineStyle !== 'none') paintOutline(ctx, fragment, options);
  }
}

/** An inline box's style on a line it does not both start and end on: no
 *  rounded corner on a side it goes on from. Made once a style and a pair
 *  of ends, so a repaint copies no style and the layers made of it are
 *  found again. */
const FRAGMENT_STYLES = new WeakMap<
  ComputedStyle,
  (ComputedStyle | undefined)[]
>();

function fragmentStyle(
  style: ComputedStyle,
  leftEnds: boolean,
  rightEnds: boolean,
): ComputedStyle {
  if (leftEnds && rightEnds) return style;
  let made = FRAGMENT_STYLES.get(style);
  if (!made) {
    made = [];
    FRAGMENT_STYLES.set(style, made);
  }
  const which = (leftEnds ? 1 : 0) | (rightEnds ? 2 : 0);
  let out = made[which];
  if (!out) {
    const ends = (radii: ComputedStyle['borderRadius']) =>
      [
        leftEnds ? radii[0] : 0,
        rightEnds ? radii[1] : 0,
        rightEnds ? radii[2] : 0,
        leftEnds ? radii[3] : 0,
      ] as ComputedStyle['borderRadius'];
    out = copyStyle(style);
    out.borderRadius = ends(style.borderRadius);
    out.borderRadiusY = style.borderRadiusY ? ends(style.borderRadiusY) : null;
    made[which] = out;
  }
  return out;
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
