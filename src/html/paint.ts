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
import type {
  BackgroundRepeat,
  BoxShadow,
  ComputedStyle,
  ImageRepeat,
  LinearGradient,
  RepeatMode,
  VisualBox,
} from './css/style.js';
import {
  CONTAIN_LAYOUT,
  CONTAIN_PAINT,
  CONTAIN_SIZE,
  copyStyle,
  scrolls,
} from './css/style.js';
import { contained } from './layout/block.js';
import {
  BOX_RAISES,
  LINE_BOX_RAISES,
  Box,
  CLAMPED,
  CLIPPED_CELLS,
  COLLAPSED_CELLS,
  FADED_BLOCKS,
  PAINT_ORDER,
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
  /** What every drawing is multiplied by: an element's `opacity`. */
  globalAlpha?: number;
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
    // past a clamp point: nothing drawn, and no overflow (CSS Overflow 4,
    // 5.3.1)
    if (CLAMPED.has(child)) {
      child.boundsX = Infinity;
      child.boundsY = Infinity;
      child.boundsWidth = 0;
      child.boundsHeight = 0;
      continue;
    }
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
export function hasRect(box: Box): boolean {
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
  let inner = false;
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.holdsLayers) inner = true;
    if (layered(box, child)) (positioned ??= []).push(child);
    else if (!onLine(box, child)) paintable += 1;
  }
  box.holdsLayers = positioned !== null || inner;
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
  const top = childNamed(root, 'html') ?? root;
  if (has(top)) return { source: top, anchor: top };
  const body = childNamed(top, 'body');
  // containment on either keeps the body's to the body (CSS Containment 2)
  if (!body || top.style.contain || body.style.contain) return null;
  return has(body) ? { source: body, anchor: top } : null;
}

/** A box's child element of that name, or one inside the anonymous boxes
 *  it is wrapped in: a `<body>` in an `<html>` set `display: table` is in
 *  an anonymous row and cell. */
function childNamed(box: Box, name: string): Box | null {
  for (const child of box.children) {
    if (child.el?.name === name) return child;
    if (!child.el) {
      const found = childNamed(child, name);
      if (found) return found;
    }
  }
  return null;
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
          : originBox(anchor, options, style);
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
        originBox(anchor, options, style),
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
    layer.backgroundClip = nth(style.backgroundClips, style.backgroundClip, i);
    layer.backgroundOrigin = nth(
      style.backgroundOrigins,
      style.backgroundOrigin,
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

/** A box's padding box in window coordinates. */
function paddingBox(box: Box, options: PaintOptions): Rect {
  return {
    x: box.x + box.borderLeft + options.originX,
    y: frameY(box) + box.borderTop + options.originY,
    width: box.width - box.borderLeft - box.borderRight,
    height: frameHeight(box) - box.borderTop - box.borderBottom,
  };
}

/** Where a layer of a box's background is placed, in window coordinates:
 *  the box its `background-origin` names (CSS Backgrounds 3, 3.8). */
function originBox(
  box: Frame,
  options: PaintOptions,
  style: ComputedStyle,
): Rect {
  const [t, r, b, l] = edgeInsets(box, style.backgroundOrigin);
  return {
    x: box.x + l + options.originX,
    y: frameY(box) + t + options.originY,
    width: box.width - l - r,
    height: frameHeight(box) - t - b,
  };
}

/**
 * Where a layer of a box's background is painted: the box its
 * `background-clip` names (CSS Backgrounds 3, 3.7), each edge on the pixel
 * it falls nearest, as browsers snap a box — boxes that meet share the
 * column their edge is in, and a rule 1.33px wide is one pixel, not two —
 * with the border box's corners less the widths between (5.3), where
 * `rounded` asks for them. Null where it has no area.
 */
function clipArea(
  box: Frame,
  options: PaintOptions,
  style: ComputedStyle,
  rounded: boolean,
): {
  x: number;
  y: number;
  w: number;
  h: number;
  corners: Corners | null;
} | null {
  const left = box.x + options.originX;
  const top = frameY(box) + options.originY;
  const right = left + box.width;
  const bottom = top + frameHeight(box);
  const [t, r, b, l] = edgeInsets(box, style.backgroundClip);
  const x = Math.round(left + l);
  const y = Math.round(top + t);
  const w = Math.round(right - r) - x;
  const h = Math.round(bottom - b) - y;
  if (!(w > 0 && h > 0)) return null;
  let corners = rounded
    ? cornersOf(
        style,
        Math.round(right) - Math.round(left),
        Math.round(bottom) - Math.round(top),
      )
    : null;
  if (corners && (t || r || b || l)) {
    corners = spreadCorners(
      corners,
      box.width,
      frameHeight(box),
      -t,
      -r,
      -b,
      -l,
    );
  }
  return { x, y, w, h, corners };
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
> &
  // the padding a `content-box` background is inset by, where it has any
  Partial<Pick<Box, 'padTop' | 'padRight' | 'padBottom' | 'padLeft'>>;

/** Where a box's background and border go: its border box, which for a
 *  table leaves out the captions around it (CSS 2.1 17.4). */
function frameY(box: Frame): number {
  return box.y + box.captionTop;
}

function frameHeight(box: Frame): number {
  return box.height - box.captionTop - box.captionBottom;
}

function paintBox(ctx: PaintContext, box: Box, options: PaintOptions): void {
  if (
    !intersects(box, options) ||
    COLLAPSED_CELLS.has(box) ||
    CLAMPED.has(box)
  ) {
    return;
  }
  // An element under full opacity is painted whole in its place, as the
  // group it is (it is a stacking context, CSS Color 4 3.2; `inFlow`): at
  // 0 not at all — the control a page keeps invisible until its row is
  // hovered — and between through the context's alpha. That multiplies
  // each thing drawn rather than the group they make, so where two of its
  // own boxes overlap the lower shows through the upper, as a browser's
  // group does not let it.
  const opacity = opacityOf(box);
  if (opacity <= 0) return;
  const fade = opacity < 1 && typeof ctx.globalAlpha === 'number';
  if (fade) {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha! * opacity;
  }
  // `clip` shows the part of an absolutely positioned box it names, its own
  // background and borders among it (CSS 2.1 11.1.2)
  const clip = box.outOfFlow && box.style.clip ? clipOf(box, options) : null;
  if (!clip || (clip.w > 0 && clip.h > 0)) {
    const clipped = !!clip && pushClip(ctx, clip, null);
    paintContent(ctx, box, options);
    if (clipped) ctx.restore();
  }
  if (fade) ctx.restore();
}

function paintContent(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  const visible = box.style.visibility === 'visible';
  if (visible) paintOwnBackground(ctx, box, options);
  // `content-visibility: hidden` skips what the box holds, its own
  // background, borders and outline drawn (CSS Containment 2, 4)
  if (
    box.style.contentVisibility === 'hidden' &&
    box.kind !== 'replaced' &&
    contained(box, CONTAIN_SIZE)
  ) {
    if (box.style.outlineStyle !== 'none') paintOutline(ctx, box, options);
    return;
  }
  // a stacking context's descendants with a negative `z-index`, over its
  // background and under everything else in it (CSS 2.1 Appendix E)
  const below = options.negative ? NEGATIVE.get(box) : undefined;
  if (below) {
    for (const child of below) paintStacked(ctx, child, options);
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
    const { rect, radii } = clipEdge(box, options);
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
    if (pushClip(ctx, rect, radii)) {
      level = { box, deferred: [] };
      (options.clips ??= []).push(level);
    }
  }

  // The flow this box holds, in CSS 2.1 Appendix E's order: the backgrounds
  // and borders of its in-flow blocks, then its floats, then the lines of
  // them all, then — where it is a stacking context — the positioned boxes
  // in it (`stackLayers`). Painted a block at a time instead,
  // a float was covered by the background of every block after it — the
  // shaded paragraph beside a floated image hid the image — and a block's
  // text by the next one's background where a negative margin overlapped
  // them. A child that is no plain block of the flow — a table, a flex box,
  // a box that clips, a replaced element — is painted whole in its place.
  const floats: Box[] = [];
  paintFlowBackgrounds(ctx, box, options, floats);
  for (const float of floats) paintBox(ctx, float, options);
  // a hidden box's text is drawn in no ink, so that a visible element's in
  // it is drawn (`runFor`)
  if (box.lines) paintLines(ctx, box, options);
  const outlines: Box[] = [];
  paintFlowLines(ctx, box, options, outlines);
  // the outlines of the blocks in the flow over all of its lines, and under
  // its positioned boxes, as browsers draw them (CSS 2.1 Appendix E, step
  // 10 left the choice open): drawn after each block's own lines, an
  // outline went under an inline-block the next block held
  for (const child of outlines) paintOutline(ctx, child, options);
  if (box.collapsed && visible) paintCollapsedBorders(ctx, box, options);

  // `z-index: auto` and 0 in document order, then the positive ones
  const stacked = STACKED.get(box);
  if (stacked) for (const child of stacked) paintStacked(ctx, child, options);
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
      const painted = clipArea(box, options, layer, true);
      const area =
        painted &&
        clampRect(options, painted.x, painted.y, painted.w, painted.h);
      if (area) {
        paintBackgroundImage(
          ctx,
          layer,
          area,
          originBox(box, options, layer),
          options,
          painted.corners,
        );
      }
    });
  }
  if (style.boxShadow) paintShadows(ctx, box, options, true);
  if (!box.bordersCollapsed && !paintBorderImage(ctx, box, options)) {
    paintBorders(ctx, box, options);
  }
  if (box.kind === 'table') paintPartBackgrounds(ctx, box, options);
}

/** How far past its shape a shadow's blur shows: three standard deviations,
 *  the blur being two (CSS Backgrounds 3, 7.1.1). */
function shadowReach(blur: number): number {
  return blur > 0 ? Math.ceil(blur * 1.5) : 0;
}

const SQUARE: Corners = { x: [0, 0, 0, 0], y: [0, 0, 0, 0] };

/** Corners shrunk by `by` — an inner shadow's spread — or grown where it
 *  is negative; a square corner stays square. */
function grownCorners(c: Corners, by: number): Corners {
  const grow = (r: number) => (r > 0 ? Math.max(0, r + by) : 0);
  return {
    x: [grow(c.x[0]), grow(c.x[1]), grow(c.x[2]), grow(c.x[3])],
    y: [grow(c.y[0]), grow(c.y[1]), grow(c.y[2]), grow(c.y[3])],
  };
}

/**
 * One dimension of a corner's radius moved out by `by`, or in where it is
 * negative (CSS Backgrounds 3, 4.2, the outset-adjusted border radius): a
 * radius small beside the outset grows by less than it, and the less the
 * rounder the corner already is — `coverage` is how much of the box's side
 * its two corners take, 1 for an ellipse — so a small rounded corner on a
 * big outset stays nearly square and a circle stays a circle.
 */
function spreadRadius(radius: number, by: number, coverage: number): number {
  if (by <= 0) return radius + by;
  if (radius > by || coverage > 1) return radius + by;
  return radius + by * (1 - (1 - radius / by) ** 3 * (1 - coverage ** 3));
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
      const around =
        spreadCorners(
          corners,
          rect.width,
          rect.height,
          s.spread,
          s.spread,
          s.spread,
          s.spread,
        ) ?? SQUARE;
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
  // a flex box's in the order it laid them out
  const ordered = PAINT_ORDER.get(box);
  if (ordered) return ordered;
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
 *  that clips nothing, is fully opaque and is no stacking context holding
 *  a negative `z-index`, in a parent that is no flex box, where an item is
 *  painted whole (CSS Flexbox 5.4). */
function inFlow(parent: Box, child: Box, options: PaintOptions): boolean {
  if (child.kind !== 'block' || parent.kind === 'flex') return false;
  if (options.negative && NEGATIVE.has(child)) return false;
  const style = child.style;
  return (
    style.overflowX === 'visible' &&
    style.overflowY === 'visible' &&
    opacityOf(child) >= 1 &&
    // containment makes it a stacking context, painted whole
    !contained(child, CONTAIN_LAYOUT | CONTAIN_PAINT)
  );
}

/** How opaque a box is drawn: its own `opacity`, and the one it takes from
 *  an inline box it broke in pieces (`FADED_BLOCKS`). */
function opacityOf(box: Box): number {
  const taken = FADED_BLOCKS.get(box);
  return taken === undefined ? box.style.opacity : box.style.opacity * taken;
}

/** Whether a child is a flex box of its parent's flow — or a grid — that
 *  clips nothing and is no stacking context holding a negative `z-index`:
 *  its background and borders go with the flow's backgrounds, in the
 *  document's order, and its items with the flow's lines, each painted
 *  whole as an inline block is (CSS 2.1 Appendix E, CSS Flexbox 5.4).
 *  Painted whole in its place, its background covered a block after it
 *  that a negative margin drew up over it. */
function flowFlex(parent: Box, child: Box, options: PaintOptions): boolean {
  if (child.kind !== 'flex' || parent.kind === 'flex') return false;
  if (options.negative && NEGATIVE.has(child)) return false;
  const style = child.style;
  return (
    style.overflowX === 'visible' &&
    style.overflowY === 'visible' &&
    !(child.outOfFlow && style.clip) &&
    !contained(child, CONTAIN_LAYOUT | CONTAIN_PAINT)
  );
}

/**
 * The first pass over a box's flow: each plain block's background and
 * borders, in document order and at any depth, while the floats met on the
 * way are kept for their own pass, and the positioned boxes are left to
 * the stacking context that paints them (`stackLayers`). A child that is
 * no plain block is left for the last pass, where it is painted whole
 * among the lines: its text is text, over every block background, and it
 * stands beside the floats rather than under them.
 */
function paintFlowBackgrounds(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  floats: Box[],
): void {
  for (const child of paintedChildren(box, options)) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (layered(box, child) || onLine(box, child)) continue;
    if (CLAMPED.has(child)) continue;
    if (child.isFloat) {
      floats.push(child);
      continue;
    }
    if (flowFlex(box, child, options)) {
      if (child.style.visibility === 'visible' && intersects(child, options)) {
        paintOwnBackground(ctx, child, options);
      }
      continue;
    }
    if (!inFlow(box, child, options) || !intersects(child, options)) continue;
    if (child.style.visibility === 'visible') {
      paintOwnBackground(ctx, child, options);
    }
    paintFlowBackgrounds(ctx, child, options, floats);
  }
}

/** The last pass over a box's flow: the plain blocks' markers and lines,
 *  and the children painted whole, in document order and at any depth,
 *  over the floats. */
function paintFlowLines(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  outlines: Box[],
): void {
  for (const child of paintedChildren(box, options)) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (layered(box, child) || onLine(box, child) || child.isFloat) continue;
    if (CLAMPED.has(child)) continue;
    if (flowFlex(box, child, options)) {
      if (!intersects(child, options)) continue;
      // its items, each whole, in `order` — one `float` makes no float of
      for (const item of paintedChildren(child, options)) {
        if (item.kind === 'text' || item.kind === 'break') continue;
        if (layered(child, item) || CLAMPED.has(item)) continue;
        paintBox(ctx, item, options);
      }
      if (child.style.outlineStyle !== 'none') outlines.push(child);
      continue;
    }
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
    paintFlowLines(ctx, child, options, outlines);
    // an inline box's is drawn a fragment at a time, on its lines
    if (child.style.outlineStyle !== 'none' && child.kind !== 'inline') {
      outlines.push(child);
    }
  }
}

/** Where a box that clips its overflow clips it: on the pixels its own
 *  background covers, inside its borders. Rounded out to whole pixels
 *  instead, a box at a fractional position showed a row of what it clips
 *  beyond its background's edge. */
function overflowClip(
  box: Box,
  options: PaintOptions,
): { x: number; y: number; w: number; h: number } {
  const left = box.x + options.originX;
  const top = frameY(box) + options.originY;
  const x = Math.round(left);
  const y = Math.round(top);
  return {
    x: x + box.borderLeft,
    y: y + box.borderTop,
    w: Math.round(left + box.width) - x - box.borderLeft - box.borderRight,
    h:
      Math.round(top + frameHeight(box)) - y - box.borderTop - box.borderBottom,
  };
}

/**
 * The edge a box that clips cuts what it holds at: its padding box where it
 * scrolls, and for `overflow: clip` and paint containment its overflow clip
 * edge — the box `overflow-clip-margin` names moved out by its length, or
 * in where that is negative (CSS Overflow 4, 3.2). Its corners are the
 * padding box's moved out as a spread moves them, which is what browsers
 * draw where the text measures from the border edge. Along an axis it lets
 * overflow show, nothing is cut.
 */
function clipEdge(
  box: Box,
  options: PaintOptions,
): {
  rect: { x: number; y: number; w: number; h: number };
  radii: Corners | null;
} {
  const style = box.style;
  const painted = contained(box, CONTAIN_PAINT);
  if (
    scrolls(style) ||
    (!painted && style.overflowX !== 'clip' && style.overflowY !== 'clip')
  ) {
    return { rect: overflowClip(box, options), radii: innerRadii(box) };
  }
  // From the padding box, as a browser draws it: out to the box the
  // margin is from and then by the margin, its rounded corners moving out
  // with it as a spread moves them
  const margin = style.overflowClipMargin * (options.scale ?? 1);
  const bt = box.borderTop;
  const br = box.borderRight;
  const bb = box.borderBottom;
  const bl = box.borderLeft;
  const [it, ir, ib, il] = edgeInsets(box, style.overflowClipBox);
  const t = bt - it + margin;
  const r = br - ir + margin;
  const b = bb - ib + margin;
  const l = bl - il + margin;
  const left = box.x + options.originX + bl;
  const top = frameY(box) + options.originY + bt;
  const width = box.width - bl - br;
  const height = frameHeight(box) - bt - bb;
  let x = Math.round(left - l);
  let y = Math.round(top - t);
  let w = Math.round(left + width + r) - x;
  let h = Math.round(top + height + b) - y;
  const corners = cornersOf(style, box.width, frameHeight(box));
  let radii = corners
    ? spreadCorners(
        insetCorners(corners, bt, br, bb, bl),
        width,
        height,
        t,
        r,
        b,
        l,
      )
    : null;
  const openX = !painted && style.overflowX === 'visible';
  const openY = !painted && style.overflowY === 'visible';
  if (openX || openY) {
    // as far as the damage reaches, or the coordinates a clip can carry
    const damage = options.damage;
    radii = null;
    if (openX) {
      x = damage ? damage.x - CLAMP_PAD : -COORD_LIMIT;
      w = damage ? damage.width + 2 * CLAMP_PAD : 2 * COORD_LIMIT;
    }
    if (openY) {
      y = damage ? damage.y - CLAMP_PAD : -COORD_LIMIT;
      h = damage ? damage.height + 2 * CLAMP_PAD : 2 * COORD_LIMIT;
    }
  }
  return { rect: { x, y, w, h }, radii };
}

/**
 * The corners of a box `width` by `height` moved out by each side's
 * distance, or in where it is negative (`spreadRadius`) — an outer
 * shadow's spread, an overflow clip edge; a square corner stays square,
 * and so does one that comes to nothing either way. Null where none is
 * left rounded.
 */
function spreadCorners(
  c: Corners,
  width: number,
  height: number,
  top: number,
  right: number,
  bottom: number,
  left: number,
): Corners | null {
  const x: Corners['x'] = [0, 0, 0, 0];
  const y: Corners['y'] = [0, 0, 0, 0];
  let rounded = false;
  for (let i = 0; i < 4; i += 1) {
    if (!(c.x[i] > 0 && c.y[i] > 0)) continue;
    const coverage = 2 * Math.min(c.x[i] / width, c.y[i] / height);
    const rx = spreadRadius(
      c.x[i],
      i === 0 || i === 3 ? left : right,
      coverage,
    );
    const ry = spreadRadius(c.y[i], i < 2 ? top : bottom, coverage);
    if (!(rx > 0 && ry > 0)) continue;
    x[i] = rx;
    y[i] = ry;
    rounded = true;
  }
  return rounded ? { x, y } : null;
}

/** How far in from a box's border box the box a `<visual-box>` names is:
 *  top, right, bottom and left. */
function edgeInsets(
  box: Frame,
  which: VisualBox,
): readonly [number, number, number, number] {
  if (which === 'border-box') return NO_INSETS;
  const t = box.borderTop;
  const r = box.borderRight;
  const b = box.borderBottom;
  const l = box.borderLeft;
  if (which === 'padding-box') return [t, r, b, l];
  return [
    t + (box.padTop ?? 0),
    r + (box.padRight ?? 0),
    b + (box.padBottom ?? 0),
    l + (box.padLeft ?? 0),
  ];
}

const NO_INSETS = [0, 0, 0, 0] as const;

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
    const containing = containingBlockOf(box);
    if (containing) {
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

/**
 * The box an out-of-flow box is positioned in, whose clips are the ones it
 * is under (`paintPositioned`, and the hit test's `deepestAt`): its nearest
 * positioned or translated ancestor, or the root. Null for a fixed box,
 * which is under none.
 */
export function containingBlockOf(box: Box): Box | null {
  if (box.style.position === 'fixed') return null;
  let containing = box.parent;
  while (
    containing?.parent &&
    containing.style.position === 'static' &&
    !containing.style.translate &&
    !containing.style.transformTranslate
  ) {
    containing = containing.parent;
  }
  return containing;
}

/** Whether anything in a box is positioned out of the flow, which may be
 *  outside the box's clip; kept for the tree's life. */
export function holdsAbsolute(box: Box): boolean {
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
export function holds(outer: Box, inner: Box | null): boolean {
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
export function clipsOverflow(box: Box): boolean {
  if (CLIPPED_CELLS.has(box)) return true;
  const style = box.style;
  if (
    style.overflowX === 'visible' &&
    style.overflowY === 'visible' &&
    // paint containment clips as `overflow: clip` does (CSS Containment
    // 2, 3.5)
    !contained(box, CONTAIN_PAINT)
  ) {
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
    // where the root's `overflow` is `visible`, the body's is the
    // viewport's — but not where either has any containment (CSS
    // Containment 2), which keeps it the body's own
    return (
      parent.style.overflowX !== 'visible' ||
      parent.style.overflowY !== 'visible' ||
      !!parent.style.contain ||
      !!box.style.contain
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
  // a flex item with a `z-index` is a stacking context, positioned or not
  // (CSS Flexbox 5.4), and a grid's
  if (parent.kind === 'flex' && typeof style.zIndex === 'number') return true;
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

/**
 * Per stacking context — the root, and a positioned box with a `z-index` —
 * the positioned boxes it paints over its flow (CSS 2.1 9.9.1, Appendix E,
 * steps 8 and 9): every one in it that no stacking context inside it
 * paints, at any depth, in document order and then by `z-index`. Painted
 * by their parent after its flow, as they were, the ones in a box painted
 * whole — one that clips, a table, a flex box, a float, a positioned box
 * with no `z-index` — were painted with it, among the flow around it: a
 * box absolute in an `overflow: hidden` one went under a positioned box
 * before it, and a menu with a `z-index` in a positioned header under the
 * positioned content after the header.
 */
const STACKED = new WeakMap<Box, Box[]>();

/** Between a positioned box and the stacking context that paints it, the
 *  boxes whose clips it is under (`clipsFor`), outermost first. */
const CLIPS_BETWEEN = new WeakMap<Box, Box[]>();
const NO_CLIPS: Box[] = [];

/** Gather each stacking context's positioned boxes (`STACKED`); once per
 *  layout, after `hoistNegative`, whose boxes it leaves where they are. */
export function stackLayers(root: Box): void {
  const list: Box[] = [];
  if (root.holdsLayers) gatherLayers(root, root, list);
  settleLayers(root, list);
}

function gatherLayers(box: Box, context: Box, into: Box[]): void {
  for (const child of PAINT_ORDER.get(box) ?? box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    // a positioned box past a clamp point, or in a box that is
    if (CLAMPED.has(child)) continue;
    // one below the flow is on its stacking context's list already
    const below = HOISTED.has(child);
    if (below || layered(box, child)) {
      const clips = clipsFor(child, context);
      if (clips.length) CLIPS_BETWEEN.set(child, clips);
      else CLIPS_BETWEEN.delete(child);
      if (!below) into.push(child);
    }
    if (below || stacksLayers(child)) {
      const own: Box[] = [];
      if (child.holdsLayers) gatherLayers(child, child, own);
      settleLayers(child, own);
    } else if (child.holdsLayers) {
      gatherLayers(child, context, into);
    }
  }
}

function settleLayers(box: Box, list: Box[]): void {
  if (!list.length) {
    STACKED.delete(box);
    return;
  }
  // a stable sort: `z-index: auto` and 0 in document order, then the
  // positive ones, each in document order
  list.sort(byZIndex);
  STACKED.set(box, list);
}

/**
 * Whether a box is a stacking context, which paints the positioned boxes in
 * it itself, and the ones below its flow: positioned with a `z-index`, or a
 * flex item with one; fixed or sticky with none (CSS Positioned Layout 3, as
 * browsers paint them — a fixed header's box set behind its content with
 * `z-index: -1` went behind the page); or under full opacity (CSS Color 4
 * 3.2), its own or the opacity it takes from an inline box it broke
 * (`FADED_BLOCKS`), which is painted as one group — faded with it, or at
 * `opacity: 0` not at all, where its root context drew a hover menu's
 * absolute children.
 */
function stacksLayers(box: Box): boolean {
  const style = box.style;
  if (style.position === 'fixed' || style.position === 'sticky') return true;
  if (style.opacity < 1 || FADED_BLOCKS.has(box)) return true;
  // layout and paint containment make one (CSS Containment 2, 3.3, 3.5)
  if (contained(box, CONTAIN_LAYOUT | CONTAIN_PAINT)) return true;
  if (typeof style.zIndex !== 'number') return false;
  return style.position !== 'static' || flexItem(box);
}

/** Whether a box is an item of a flex box — or a grid, to the box tree the
 *  same — which a `z-index` makes a stacking context unpositioned. */
function flexItem(box: Box): boolean {
  return !box.outOfFlow && box.parent?.kind === 'flex';
}

/**
 * The boxes between a positioned box and its stacking context whose clips
 * it is under: the ones that clip their overflow, or are cut to a `clip`,
 * at or above its containing block (CSS 2.1 11.1.1). An absolute box is
 * outside a box that clips where its containing block is, a fixed one
 * outside every one, and a relative one inside every one.
 */
function clipsFor(box: Box, context: Box): Box[] {
  let from: Box | null = box.parent;
  if (box.outOfFlow) {
    const fixed = box.style.position === 'fixed';
    while (from && from !== context) {
      const style = from.style;
      if (style.translate || style.transformTranslate) break;
      if (!fixed && style.position !== 'static') break;
      from = from.parent;
    }
  }
  let clips: Box[] | null = null;
  for (let at = from; at && at !== context; at = at.parent) {
    if (clipsOverflow(at) || (at.outOfFlow && at.style.clip)) {
      (clips ??= []).push(at);
    }
  }
  return clips ? clips.reverse() : NO_CLIPS;
}

/**
 * A positioned box its stacking context paints, under the clips of the
 * boxes between them that hold it (`clipsFor`): inside them, where its
 * parent painted it, it was. A clip of no area leaves none of it to paint.
 */
function paintStacked(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  if (!intersects(box, options)) return;
  const between = CLIPS_BETWEEN.get(box);
  if (!between) {
    paintPositioned(ctx, box, options);
    return;
  }
  let pushed = 0;
  let empty = false;
  for (const clipper of between) {
    if (clipper.outOfFlow && clipper.style.clip) {
      const rect = clipOf(clipper, options);
      if (rect.w <= 0 || rect.h <= 0) empty = true;
      else if (pushClip(ctx, rect, null)) pushed += 1;
    }
    if (!empty && clipsOverflow(clipper)) {
      const { rect, radii } = clipEdge(clipper, options);
      if (rect.w <= 0 || rect.h <= 0) empty = true;
      else if (pushClip(ctx, rect, radii)) pushed += 1;
    }
    if (empty) break;
  }
  if (!empty) paintPositioned(ctx, box, options);
  for (let i = 0; i < pushed; i += 1) ctx.restore();
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
    if (
      typeof z === 'number' &&
      z < 0 &&
      (child.style.position !== 'static' || flexItem(child))
    ) {
      (pending ??= []).push(child);
    }
  }
  if (!root && !stacksLayers(box)) return pending;
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
  const area = clipArea(
    box,
    options,
    style,
    !!(ctx.roundRect && ctx.fill && ctx.beginPath),
  );
  const rect = area && clampRect(options, area.x, area.y, area.w, area.h);
  if (!rect) return;
  const rounded = area.corners;
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
    const origin = fixed || originBox(box, options, style);
    const at = snapped(origin.x, origin.y, origin.width, origin.height);
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
  const repeat = style.backgroundRepeat;
  const [w, h] = roundedTile(
    style.backgroundSize,
    repeat,
    sizedTile(style.backgroundSize, NO_SIZE, at, 1),
    at,
  );
  if (!(w > 0 && h > 0)) return;
  const x0 =
    w === at.width
      ? at.x
      : at.x + resolve(style.backgroundPositionX, at.width - w);
  const y0 =
    h === at.height
      ? at.y
      : at.y + resolve(style.backgroundPositionY, at.height - h);
  const across = tileRun(
    repeat[0],
    x0,
    w,
    area.x,
    area.x + area.w,
    at.x,
    at.width,
  );
  const down = tileRun(
    repeat[1],
    y0,
    h,
    area.y,
    area.y + area.h,
    at.y,
    at.height,
  );
  const { from: fromX, to: toX, step: stepX } = across;
  const { from: fromY, to: toY, step: stepY } = down;
  if (
    Math.ceil((toX - fromX) / stepX) * Math.ceil((toY - fromY) / stepY) >
    MAX_TILES
  ) {
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
  for (let y = fromY; y < toY; y += stepY) {
    const top = Math.max(y, area.y);
    const bottom = Math.min(y + h, area.y + area.h);
    if (bottom <= top) continue;
    for (let x = fromX; x < toX; x += stepX) {
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
  const repeat = style.backgroundRepeat;
  const [iw, ih] = roundedTile(
    style.backgroundSize,
    repeat,
    sizedTile(style.backgroundSize, loaded, at, scale),
    at,
  );
  if (!(iw > 0 && ih > 0)) return;
  const offset = (len: Len, extent: number, size: number): number =>
    resolve(len, extent - size);
  const x0 = Math.round(at.x + offset(style.backgroundPositionX, at.width, iw));
  const y0 = Math.round(
    at.y + offset(style.backgroundPositionY, at.height, ih),
  );
  // the tiles that reach the area: from the first at or before its edge
  const across = tileRun(
    repeat[0],
    x0,
    iw,
    area.x,
    area.x + area.w,
    at.x,
    at.width,
  );
  const down = tileRun(
    repeat[1],
    y0,
    ih,
    area.y,
    area.y + area.h,
    at.y,
    at.height,
  );
  const { from: fromX, to: toX, step: stepX } = across;
  const { from: fromY, to: toY, step: stepY } = down;

  ctx.save();
  if (ctx.beginPath && ctx.rect && ctx.clip) {
    ctx.beginPath();
    // in the box's corners, as its colour is (CSS Backgrounds 3, 5.3)
    if (corners && ctx.roundRect) {
      roundedRect(ctx, area.x, area.y, area.w, area.h, corners);
    } else ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
  }
  const tiles =
    Math.ceil((toX - fromX) / stepX) * Math.ceil((toY - fromY) / stepY);
  if (svg) {
    // a drawing is drawn a tile at a time, at the size it was given
    if (tiles <= MAX_TILES) {
      for (let y = fromY; y < toY; y += stepY) {
        for (let x = fromX; x < toX; x += stepX)
          svg.draw(ctx, Math.round(x), Math.round(y), iw, ih, scale);
      }
    } else {
      svg.draw(ctx, x0, y0, iw, ih, scale);
    }
  } else if (
    tiles > 1 &&
    iw === loaded.width &&
    ih === loaded.height &&
    stepX === iw &&
    stepY === ih &&
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
    // each tile's edges on the pixels they fall nearest, so tiles `space`
    // sets apart or `round` sizes to a fraction meet without a seam
    for (let y = fromY; y < toY; y += stepY) {
      const top = Math.round(y);
      const height = Math.round(y + ih) - top;
      for (let x = fromX; x < toX; x += stepX) {
        const left = Math.round(x);
        ctx.drawImage!(
          loaded.image,
          left,
          top,
          Math.round(x + iw) - left,
          height,
        );
      }
    }
  } else {
    ctx.drawImage!(loaded.image, x0, y0, iw, ih);
  }
  ctx.restore();
}

/**
 * Where a background's tiles fall along one axis (CSS Backgrounds 3, 3.4):
 * from the first at or before the painting area's start, a step apart, to
 * its end. `space` fits as many whole tiles into the positioning area as it
 * holds, the first and last against its edges and the rest spread evenly
 * between — or one, where two do not fit, placed as `background-position`
 * says — and `round`'s tile is already the size that fits (`roundedTile`).
 */
function tileRun(
  mode: RepeatMode,
  start: number,
  size: number,
  areaStart: number,
  areaEnd: number,
  originStart: number,
  originSize: number,
): { from: number; step: number; to: number } {
  let step = size;
  if (mode === 'space') {
    const fits = Math.floor(originSize / size + 1e-6);
    if (fits < 2) return { from: start, step, to: start + size };
    step = size + (originSize - fits * size) / (fits - 1);
    start = originStart;
  } else if (mode === 'no-repeat') {
    return { from: start, step, to: start + size };
  }
  return {
    from: start - Math.ceil((start - areaStart) / step) * step,
    step,
    to: areaEnd,
  };
}

/**
 * A tile that `round` fits a whole number of times into the positioning
 * area along the axes it rounds (CSS Backgrounds 3, 3.9): the nearest whole
 * number, and one at least. Rounded one way only, with the size `auto` the
 * other way, the tile keeps its ratio.
 */
function roundedTile(
  size: ComputedStyle['backgroundSize'],
  [modeX, modeY]: BackgroundRepeat,
  [w, h]: [number, number],
  at: Rect,
): [number, number] {
  const acrossRounds = modeX === 'round' && w > 0 && at.width > 0;
  const downRounds = modeY === 'round' && h > 0 && at.height > 0;
  if (!acrossRounds && !downRounds) return [w, h];
  const w2 = acrossRounds
    ? at.width / Math.max(1, Math.round(at.width / w))
    : w;
  const h2 = downRounds
    ? at.height / Math.max(1, Math.round(at.height / h))
    : h;
  const autoW =
    size === 'auto' || (typeof size !== 'string' && size[0] === 'auto');
  const autoH =
    size === 'auto' || (typeof size !== 'string' && size[1] === 'auto');
  if (acrossRounds && !downRounds && autoH) return [w2, (h * w2) / w];
  if (downRounds && !acrossRounds && autoW) return [(w * h2) / h, h2];
  return [w2, h2];
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
 * A box's border image in place of its border's style (CSS Backgrounds 3,
 * 6.2): the image cut into nine by its slices, drawn over the border image
 * area — the border box grown by the outset — in the nine parts the widths
 * make. The corners are scaled into theirs, the edges scaled to their
 * sides' widths and repeated along them as `border-image-repeat` says, and
 * the middle drawn only where `fill` asks for it. False where there is no
 * image to draw, or none here yet, and the border is drawn as its style
 * says.
 */
function paintBorderImage(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): boolean {
  const spec = box.style.borderImage;
  const source = spec.source;
  if (!source || !ctx.drawImage) return false;
  const loaded =
    typeof source === 'string' ? options.backgroundImageFor?.(source) : null;
  if (typeof source === 'string' && !loaded) return false;
  const scale = options.scale ?? 1;
  const borders = [
    box.borderTop,
    box.borderRight,
    box.borderBottom,
    box.borderLeft,
  ];
  const outset = spec.outset.map((o, i) =>
    typeof o === 'number' ? o : o.times * borders[i],
  );
  const left = box.x + options.originX - outset[3];
  const top = frameY(box) + options.originY - outset[0];
  const aw = box.width + outset[1] + outset[3];
  const ah = frameHeight(box) + outset[0] + outset[2];
  // the image's size, CSS Images' default sizing in the area: a drawing
  // with no size of its own is as large as it fits there, and a gradient,
  // which has none, is the area's
  const [cw, ch] = loaded
    ? tileSize(loaded, { x: 0, y: 0, width: aw, height: ah }, scale)
    : [aw, ah];
  const iw = cw / scale;
  const ih = ch / scale;
  if (!(iw > 0 && ih > 0)) return false;
  const key =
    typeof source === 'string' ? source : gradientKey(source, box.style.color);
  // A drawing or a gradient is drawn once at that size and cut as a raster
  // is, so that each piece stretches its part of the one picture
  let image = loaded?.image;
  let unitX = 1;
  let unitY = 1;
  if (!loaded || image instanceof SvgDrawing) {
    const svg = image instanceof SvgDrawing ? image : null;
    const w = Math.max(1, Math.round(cw));
    const h = Math.max(1, Math.round(ch));
    const drawn = options.cached?.(
      `border-image|${key}|${w}x${h}`,
      w,
      h,
      (sctx) => {
        if (svg) svg.draw(sctx, 0, 0, w, h, scale);
        else if (typeof source !== 'string' && sctx.createLinearGradient) {
          sctx.fillStyle = linearGradient(
            sctx,
            source,
            0,
            0,
            w,
            h,
            box.style.color,
          );
          sctx.fillRect(0, 0, w, h);
        }
      },
    );
    if (!drawn) return false;
    image = drawn;
    unitX = w / iw;
    unitY = h / ih;
  }
  // the slices, image pixels in from each edge, and none past the image
  const slices = spec.slice.map((s, i) =>
    Math.min(i % 2 ? iw : ih, Math.max(0, resolve(s, i % 2 ? iw : ih))),
  );
  const widths = spec.width.map((w, i) => {
    if (w === 'auto') return slices[i] * scale;
    if (typeof w === 'number') return w;
    if ('times' in w) return w.times * borders[i];
    return resolve(w, i % 2 ? aw : ah);
  });
  // widths that overlap across the area are scaled down together
  const f = Math.min(
    aw / (widths[1] + widths[3]),
    ah / (widths[0] + widths[2]),
  );
  if (f < 1) for (let i = 0; i < 4; i += 1) widths[i] *= f;
  const [st, sr, sb, sl] = slices;
  const [wt, wr, wb, wl] = widths;
  // Each column and row of the image, as from and to: the slices may
  // overlap, and each corner is still all of its own; the edges and the
  // middle between two that meet or cross are empty (6.2)
  const sx = [
    [0, sl],
    [sl, Math.max(sl, iw - sr)],
    [iw - sr, iw],
  ];
  const sy = [
    [0, st],
    [st, Math.max(st, ih - sb)],
    [ih - sb, ih],
  ];
  const dx = [
    Math.round(left),
    Math.round(left + wl),
    Math.round(left + aw - wr),
    Math.round(left + aw),
  ];
  const dy = [
    Math.round(top),
    Math.round(top + wt),
    Math.round(top + ah - wb),
    Math.round(top + ah),
  ];
  const sized = `${Math.round(cw)}x${Math.round(ch)}`;
  const part = (col: number, row: number, across: number, down: number) => {
    // the piece, whole pixels of the image
    const px = Math.round(sx[col][0] * unitX);
    const py = Math.round(sy[row][0] * unitY);
    const pw = Math.round(sx[col][1] * unitX) - px;
    const ph = Math.round(sy[row][1] * unitY) - py;
    const w = dx[col + 1] - dx[col];
    const h = dy[row + 1] - dy[row];
    if (!(pw > 0 && ph > 0 && w > 0 && h > 0)) return;
    const [modeX, modeY] = spec.repeat;
    const runX = edgeRun(col === 1 ? modeX : 'stretch', dx[col], w, across);
    const runY = edgeRun(row === 1 ? modeY : 'stretch', dy[row], h, down);
    // A piece drawn at another size is filtered, and the filter reads past
    // the piece's edge into its neighbours in the image: the middle's
    // colour bled into every edge. Copied out to a surface of its own, a
    // piece is padded at its own edge, as a browser draws it.
    let source = image;
    let ox = px;
    let oy = py;
    const scaled =
      runX.some(([a, b, c0, c1]) => b - a !== (c1 - c0) * pw) ||
      runY.some(([a, b, c0, c1]) => b - a !== (c1 - c0) * ph);
    const piece =
      scaled &&
      options.cached?.(
        `border-image|${key}|${sized}|${px},${py},${pw},${ph}`,
        pw,
        ph,
        (sctx) => sctx.drawImage!(image, px, py, pw, ph, 0, 0, pw, ph),
      );
    if (piece) {
      source = piece;
      ox = 0;
      oy = 0;
    }
    for (const [x0, x1, cx0, cx1] of runX) {
      for (const [y0, y1, cy0, cy1] of runY) {
        ctx.drawImage!(
          source,
          ox + cx0 * pw,
          oy + cy0 * ph,
          (cx1 - cx0) * pw,
          (cy1 - cy0) * ph,
          x0,
          y0,
          x1 - x0,
          y1 - y0,
        );
      }
    }
  };
  // Along an edge, a tile is the slice scaled to the side's width; the
  // middle's is scaled as the top edge is across and the left edge is
  // down, or the bottom and the right, or not at all
  const factor = (d: number, s: number) => (s > 0 && d > 0 ? d / s : 0);
  const top0 = factor(dy[1] - dy[0], st) || factor(dy[3] - dy[2], sb) || scale;
  const left0 = factor(dx[1] - dx[0], sl) || factor(dx[3] - dx[2], sr) || scale;
  const middleW = (sx[1][1] - sx[1][0]) * top0;
  const middleH = (sy[1][1] - sy[1][0]) * left0;
  part(0, 0, 0, 0);
  part(2, 0, 0, 0);
  part(0, 2, 0, 0);
  part(2, 2, 0, 0);
  part(1, 0, (sx[1][1] - sx[1][0]) * factor(dy[1] - dy[0], st), 0);
  part(1, 2, (sx[1][1] - sx[1][0]) * factor(dy[3] - dy[2], sb), 0);
  part(0, 1, 0, (sy[1][1] - sy[1][0]) * factor(dx[1] - dx[0], sl));
  part(2, 1, 0, (sy[1][1] - sy[1][0]) * factor(dx[3] - dx[2], sr));
  if (spec.fill) part(1, 1, middleW, middleH);
  return true;
}

const GRADIENT_KEYS = new WeakMap<LinearGradient, string>();

/** A gradient as a key for what is drawn of it: its angle and stops, and
 *  the colour `currentColor` among them is. */
function gradientKey(gradient: LinearGradient, color: string): string {
  let key = GRADIENT_KEYS.get(gradient);
  if (key === undefined) {
    key = JSON.stringify(gradient);
    GRADIENT_KEYS.set(gradient, key);
  }
  return `${key}|${color}`;
}

/**
 * The tiles of a border image part along one axis, each as where it is
 * drawn — its start and end, whole pixels — and the fraction of the slice
 * it shows, which is all of it but where the part cuts a tile. `stretch`
 * is one tile over the part; `repeat` tiles of `tile`'s size centred on it;
 * `round` as many as fit, the nearest whole number, sized to fill it; and
 * `space` as many whole ones as fit, the room left spread around them
 * (CSS Backgrounds 3, 6.5). A tile of no size is the part's.
 */
function edgeRun(
  mode: ImageRepeat,
  start: number,
  length: number,
  tile: number,
): [number, number, number, number][] {
  if (mode === 'stretch' || !(tile > 0)) return [[start, start + length, 0, 1]];
  const end = start + length;
  const tiles: [number, number, number, number][] = [];
  let step = tile;
  let from: number;
  if (mode === 'round') {
    step = tile = length / Math.max(1, Math.round(length / tile));
    from = start;
  } else if (mode === 'space') {
    const fits = Math.floor(length / tile + 1e-6);
    if (!fits) return tiles;
    const gap = (length - fits * tile) / (fits + 1);
    step = tile + gap;
    from = start + gap;
  } else {
    // centred: the first tile at or before the start
    from = start + (length - tile) / 2;
    from -= Math.ceil((from - start) / tile) * tile;
  }
  for (let at = from; at < end - 1e-6 && tiles.length < MAX_TILES; at += step) {
    const a = Math.max(at, start);
    const b = Math.min(at + tile, end);
    const x0 = Math.round(a);
    const x1 = Math.round(b);
    if (x1 <= x0) continue;
    tiles.push([x0, x1, (a - at) / tile, (b - at) / tile]);
  }
  return tiles;
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
  const ox = table.x + options.originX;
  const oy = table.y + options.originY;
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
  // rounded there, on the page: a line at 12.5 carries a 25px border from
  // 0, where rounding the line first and taking a whole half off drew it
  // from 1, and a line 18.4 into a table at 50.4 carries a pixel's from
  // 69, where rounding the two apart drew it from 68
  const from = (origin: number, line: number, width: number): number =>
    Math.round(origin + line - width / 2);
  for (let line = 0; line <= R; line += 1) {
    for (let c = 0; c < C; c += 1) {
      const border = horizontal[line * C + c];
      if (!border) continue;
      const start = Math.max(v(line - 1, c), v(line, c));
      const end = Math.max(v(line - 1, c + 1), v(line, c + 1));
      const x = from(ox, lineX[c], start);
      segments.push({
        border,
        x,
        y: from(oy, lineY[line], border.width),
        w: from(ox, lineX[c + 1], end) + end - x,
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
      const y = from(oy, lineY[r], start);
      segments.push({
        border,
        x: from(ox, lineX[line], border.width),
        y,
        w: border.width,
        h: from(oy, lineY[r + 1], end) + end - y,
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
    // on the pixel grid, as a background's tile is: a fraction of a pixel
    // is a blur, or a row of the image the next pixel's
    const at = fitted(box, x, y, w, h);
    at.x = Math.round(at.x);
    at.y = Math.round(at.y);
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
  if (!own) return { x, y, w, h };
  // what of its size it has of its own: an SVG may have a ratio from its
  // `viewBox` and neither side, or one side
  const hasWidth = !(own.missing & 1) && own.width > 0;
  const hasHeight = !(own.missing & 2) && own.height > 0;
  const ratio =
    own.ratio > 0
      ? own.ratio
      : hasWidth && hasHeight
        ? own.width / own.height
        : 0;
  // at its ratio within the box, and over the whole of it; the box where
  // it has none
  const within: [number, number] = !ratio
    ? [w, h]
    : w / h > ratio
      ? [h * ratio, h]
      : [w, w / ratio];
  const over: [number, number] = !ratio
    ? [w, h]
    : w / h > ratio
      ? [w, w / ratio]
      : [h * ratio, h];
  // its own size: a side it lacks from the other through its ratio, and
  // with neither side, within the box (CSS Images 3, 5.2)
  const natural = (): [number, number] =>
    hasWidth && hasHeight
      ? [own.width, own.height]
      : hasWidth
        ? [own.width, ratio ? own.width / ratio : h]
        : hasHeight
          ? [ratio ? own.height * ratio : w, own.height]
          : within;
  let dw = w;
  let dh = h;
  if (fit === 'contain') [dw, dh] = within;
  else if (fit === 'cover') [dw, dh] = over;
  else if (fit === 'none') [dw, dh] = natural();
  else if (fit === 'scale-down') {
    const n = natural();
    [dw, dh] = n[0] * n[1] <= within[0] * within[1] ? n : within;
  }
  // `fill` is the box's size; placed, it has no room to move in by a
  // percentage, but it does by a length — `right 2px` puts it two pixels
  // in from the right, and cut there
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

  const bleeds: Bleed[] = [];
  for (const line of visible) {
    if (line.background) paintLineBackground(ctx, line, options);
    paintInlineBoxes(ctx, line, options, line === lines[0] ? null : bleeds);
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
  if (bleeds.length) paintBleeds(ctx, bleeds, options);
  // an atomic set below the flow with a negative `z-index` is its
  // stacking context's to paint, there (`hoistNegative`): painted by its
  // line as well, it came back over the box it was under
  const hoisted = options.negative;
  for (const line of visible) {
    for (const placed of line.atomics) {
      if (hoisted && HOISTED.has(placed.box)) continue;
      paintBox(ctx, placed.box, options);
    }
  }
}

/** An inline box's fragment whose padding or border reaches up over the
 *  lines before its own, and where its own line starts. */
interface Bleed {
  fragment: Frame;
  lineTop: number;
}

/**
 * The part of each such fragment above its line, drawn again over the
 * text there. CSS 2.1 Appendix E paints a block's inline content a line at
 * a time, backgrounds before text, so a box on the second line with
 * padding enough to reach the first is drawn over the first line's text;
 * the ink here goes on in one batch after every line's backgrounds
 * (`paintLines`), which left that text over it.
 */
function paintBleeds(
  ctx: PaintContext,
  bleeds: Bleed[],
  options: PaintOptions,
): void {
  if (!ctx.save || !ctx.restore || !ctx.beginPath || !ctx.rect || !ctx.clip)
    return;
  for (const { fragment, lineTop } of bleeds) {
    const left = Math.floor(fragment.x + options.originX) - 1;
    const top = Math.floor(fragment.y + options.originY) - 1;
    const bottom = Math.round(lineTop + options.originY);
    if (bottom <= top) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, Math.ceil(fragment.width) + 2, bottom - top);
    ctx.clip();
    paintLayers(ctx, fragment, options);
    paintBorders(ctx, fragment, options);
    ctx.restore();
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
  /** Where a fragment that reaches up over the lines before goes, to be
   *  drawn again over their text; null for a block's first line. */
  bleeds: Bleed[] | null = null,
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
    const own = shifted
      ? baseline -
        (LINE_BOX_RAISES.get(line)?.get(box) ?? BOX_RAISES.get(box) ?? 0)
      : baseline;
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
      padTop: box.padTop,
      padBottom: box.padBottom,
      padLeft: leftEnds ? box.padLeft : 0,
      padRight: rightEnds ? box.padRight : 0,
      style,
    };
    if (fragment.width <= 0) continue;
    paintLayers(ctx, fragment, options);
    paintBorders(ctx, fragment, options);
    if (box.style.outlineStyle !== 'none') paintOutline(ctx, fragment, options);
    if (bleeds && fragment.y < line.y - 0.5) {
      bleeds.push({ fragment, lineTop: line.y + (moved?.y ?? 0) });
    }
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
