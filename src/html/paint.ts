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
import { isTransparent } from './css/values.js';
import type { ComputedStyle } from './css/style.js';
import { Box } from './layout/boxes.js';
import type { BoxTree, LineBox } from './layout/boxes.js';
import { layoutOffsets } from './layout/inline.js';

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
  fill?(): void;
  clip?(): void;
  drawImage?(image: unknown, ...args: number[]): void;
}

export interface PaintOptions {
  /** Where the document's origin sits in the window. Scrolling is this. */
  originX: number;
  originY: number;
  /** The rectangle being repainted, in window coordinates, or null for all. */
  damage: Rect | null;
  /** The document range the selection covers, in code units, or null. */
  selection: { start: number; end: number } | null;
  selectionColor: string | null;
  /** A decoded image for an element, when the host has one. */
  imageFor(box: Box): unknown | null;
}

/**
 * The bounds of everything a box and its descendants draw, in document
 * coordinates. Computed once per layout; the paint pass reads it.
 */
export function computePaintBounds(box: Box): Rect {
  let x1 = box.x;
  let y1 = box.y;
  let x2 = box.x + box.width;
  let y2 = box.y + box.height;
  if (box.lines) {
    for (const line of box.lines) {
      x1 = Math.min(x1, line.x);
      y1 = Math.min(y1, line.y);
      x2 = Math.max(x2, line.x + line.width);
      y2 = Math.max(y2, line.y + line.height);
      for (const placed of line.atomics) {
        const bounds = computePaintBounds(placed.box);
        x1 = Math.min(x1, bounds.x);
        y1 = Math.min(y1, bounds.y);
        x2 = Math.max(x2, bounds.x + bounds.width);
        y2 = Math.max(y2, bounds.y + bounds.height);
      }
    }
  }
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    const bounds = computePaintBounds(child);
    x1 = Math.min(x1, bounds.x);
    y1 = Math.min(y1, bounds.y);
    x2 = Math.max(x2, bounds.x + bounds.width);
    y2 = Math.max(y2, bounds.y + bounds.height);
  }
  box.boundsX = x1;
  box.boundsY = y1;
  box.boundsWidth = x2 - x1;
  box.boundsHeight = y2 - y1;
  return { x: x1, y: y1, width: box.boundsWidth, height: box.boundsHeight };
}

/** Paint a laid-out document. */
export function paintDocument(
  ctx: PaintContext,
  tree: BoxTree,
  options: PaintOptions,
): void {
  if (!canFill(ctx)) return;
  ctx.save();
  paintBox(ctx, tree.root, options);
  ctx.restore();
}

function paintBox(ctx: PaintContext, box: Box, options: PaintOptions): void {
  if (!intersects(box, options)) return;
  const style = box.style;
  const visible = style.visibility === 'visible';

  if (visible) {
    paintBackground(ctx, box, options);
    paintBorders(ctx, box, options);
    if (box.markerText) paintMarker(ctx, box, options);
    if (box.replaced === 'image') paintImage(ctx, box, options);
  }

  // In-flow and floated descendants first, then the inline content, then the
  // positioned ones — a flattening of CSS's painting order that is right for
  // everything short of a document that puts a negative z-index under its own
  // parent's background.
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.outOfFlow) continue;
    paintBox(ctx, child, options);
  }

  if (box.lines && visible) paintLines(ctx, box, options);

  const positioned = box.children.filter((c) => c.outOfFlow);
  if (positioned.length) {
    positioned.sort(byZIndex);
    for (const child of positioned) paintBox(ctx, child, options);
  }
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

function paintBackground(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  const color = box.style.backgroundColor;
  if (isTransparent(color)) return;
  const x = Math.round(box.x + options.originX);
  const y = Math.round(box.y + options.originY);
  const w = Math.ceil(box.width);
  const h = Math.ceil(box.height);
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color as string;
  const radii = box.style.borderRadius;
  if (radii.some((r) => r > 0) && ctx.roundRect && ctx.fill && ctx.beginPath) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radii.slice());
    ctx.fill();
    return;
  }
  ctx.fillRect(x, y, w, h);
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
  box: Box,
  options: PaintOptions,
): void {
  const s = box.style;
  const x = Math.round(box.x + options.originX);
  const y = Math.round(box.y + options.originY);
  const w = Math.ceil(box.width);
  const h = Math.ceil(box.height);
  if (w <= 0 || h <= 0) return;

  if (box.borderTop > 0 && !isTransparent(s.borderTopColor)) {
    ctx.fillStyle = s.borderTopColor;
    fillEdge(ctx, x, y, w, box.borderTop, s.borderTopStyle, true);
  }
  if (box.borderBottom > 0 && !isTransparent(s.borderBottomColor)) {
    ctx.fillStyle = s.borderBottomColor;
    fillEdge(
      ctx,
      x,
      y + h - box.borderBottom,
      w,
      box.borderBottom,
      s.borderBottomStyle,
      true,
    );
  }
  if (box.borderLeft > 0 && !isTransparent(s.borderLeftColor)) {
    ctx.fillStyle = s.borderLeftColor;
    fillEdge(
      ctx,
      x,
      y + box.borderTop,
      box.borderLeft,
      h - box.borderTop - box.borderBottom,
      s.borderLeftStyle,
      false,
    );
  }
  if (box.borderRight > 0 && !isTransparent(s.borderRightColor)) {
    ctx.fillStyle = s.borderRightColor;
    fillEdge(
      ctx,
      x + w - box.borderRight,
      y + box.borderTop,
      box.borderRight,
      h - box.borderTop - box.borderBottom,
      s.borderRightStyle,
      false,
    );
  }
}

function fillEdge(
  ctx: PaintContext,
  x: number,
  y: number,
  a: number,
  b: number,
  style: ComputedStyle['borderTopStyle'],
  horizontal: boolean,
): void {
  const length = horizontal ? a : b;
  const thickness = horizontal ? b : a;
  if (length <= 0 || thickness <= 0) return;
  if (style === 'dashed' || style === 'dotted') {
    const period = style === 'dotted' ? thickness * 2 : thickness * 3;
    const on = style === 'dotted' ? thickness : thickness * 2;
    for (let i = 0; i < length; i += period) {
      const run = Math.min(on, length - i);
      if (horizontal) ctx.fillRect(x + i, y, run, thickness);
      else ctx.fillRect(x, y + i, thickness, run);
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
  if (horizontal) ctx.fillRect(x, y, a, b);
  else ctx.fillRect(x, y, a, b);
}

/** A list item's bullet or number, in the margin. */
function paintMarker(ctx: PaintContext, box: Box, options: PaintOptions): void {
  const marker = box.markerLayout;
  if (!marker) return;
  const x = box.markerX + options.originX;
  const y = box.markerY + options.originY;
  marker.draw(ctx, x, y);
}

function paintImage(ctx: PaintContext, box: Box, options: PaintOptions): void {
  const image = options.imageFor(box);
  const x = Math.round(box.contentX + options.originX);
  const y = Math.round(box.contentY + options.originY);
  const w = Math.ceil(box.contentWidth);
  const h = Math.ceil(box.contentHeight);
  if (w <= 0 || h <= 0) return;
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

function paintLines(ctx: PaintContext, box: Box, options: PaintOptions): void {
  const lines = box.lines;
  if (!lines) return;
  const dx = options.originX;
  const dy = options.originY;
  const damage = options.damage;

  // One `draw` per layout, not per line: a paragraph is a single glyph
  // composite, and drawing it once per line would be one X request per line
  // for the same batch.
  const drawn = new Set<unknown>();

  for (const line of lines) {
    if (damage && !lineInDamage(line, dx, dy, damage)) continue;

    for (const text of line.texts) {
      const natural = text.layout.lines[text.layoutLine];
      if (natural)
        paintRunBackgrounds(ctx, natural, text.drawX + dx, text.drawY + dy);
    }
    paintSelection(ctx, line, options);
    for (const text of line.texts) {
      if (drawn.has(text.layout)) continue;
      drawn.add(text.layout);
      text.layout.draw(ctx, text.drawX + dx, text.drawY + dy);
    }
    for (const text of line.texts) {
      const natural = text.layout.lines[text.layoutLine];
      if (natural)
        paintRunRules(ctx, natural, text.drawX + dx, text.drawY + dy);
    }
    for (const placed of line.atomics) paintBox(ctx, placed.box, options);
  }
}

function lineInDamage(
  line: LineBox,
  dx: number,
  dy: number,
  damage: Rect,
): boolean {
  const y = line.y + dy;
  return y < damage.y + damage.height && y + line.height > damage.y;
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
    const layoutFrom = text.layoutStart + (from - text.textStart);
    const layoutTo = text.layoutStart + (to - text.textStart);
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
