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
import {
  AUTO,
  alphaOf,
  inkColor,
  isTransparent,
  resolve,
} from './css/values.js';
import { SCHEME_COLORS, blend, borderShades } from './css/color.js';
import type { Len } from './css/values.js';
import type {
  BackgroundClip,
  BackgroundRepeat,
  BoxShadow,
  ComputedStyle,
  Gradient,
  GradientStop,
  ImageRepeat,
  LinearGradient,
  RadialGradient,
  RepeatMode,
} from './css/style.js';
import {
  CONTAIN_LAYOUT,
  CONTAIN_PAINT,
  CONTAIN_SIZE,
  copyStyle,
  masked,
  scrolls,
} from './css/style.js';
import { LARGEST } from './css/calc.js';
import { invert, mapRect, transformed } from './css/transform.js';
import type { Matrix } from './css/transform.js';
import { contained, placedMatrix } from './layout/block.js';
import {
  BOX_RAISES,
  LINE_BOX_RAISES,
  PADDED_FACES,
  Box,
  CLAMPED,
  CLIPPED_CELLS,
  COLLAPSED_CELLS,
  COLUMN_LINES,
  COLUMN_PIECES,
  COLUMN_ROWS,
  columned,
  FADED_BLOCKS,
  PAINT_ORDER,
  INLINE_OFFSETS,
  MOVED_OFF_LINES,
  SHADOWED_TEXT,
  SHIFTED_LINES,
  TEXT_RAISES,
  TEXT_SHIFTS,
} from './layout/boxes.js';
import type {
  BoxTree,
  ColumnPiece,
  EdgePlacement,
  LineBox,
  LineText,
  Marker,
  SelectionStyler,
  ShapeStyler,
} from './layout/boxes.js';
import type { SelectionStyle } from './css/cascade.js';
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
  roundRect?(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: (number | { x: number; y: number })[],
  ): void;
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
  createRadialGradient?(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): { addColorStop(offset: number, color: string): void };
  /** Multiplies the current matrix, which a fill's paint is sampled
   *  through and a path already laid down is not. */
  transform?(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
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
  /** Multiplies the context's matrix: what a transformed box is drawn
   *  through (`paintTransformed`). */
  transform?(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
  /** Whether text drawn under a matrix that turns or scales is drawn
   *  turned and scaled, glyphs and all: the native contexts', and not
   *  ntk's, whose glyphs are drawn as they were shaped. */
  scalesText?: boolean;
  /** What every drawing is multiplied by: an element's `opacity`. */
  globalAlpha?: number;
  /** How a drawing meets what is under it; a value a backend does not
   *  have does not stick, and reads back as the one before. */
  globalCompositeOperation?: string;
}

/** An offscreen surface, as painting uses one. */
export interface Offscreen {
  getContext(kind: '2d'): unknown;
  destroy?(): void;
}

export interface PaintOptions {
  /** Where the document's origin sits in the window. Scrolling is this. */
  originX: number;
  originY: number;
  /** Device pixels per logical pixel, for the run rules — the two lines
   *  of a double one are a logical pixel apart, not a device one; a rule's
   *  thickness is its style's, in device pixels already. Default 1. */
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
  /** The viewport the document is seen through, in window coordinates:
   *  the scroll pane's, where one scrolls the element. What a fixed
   *  background is placed against (CSS 2.1 14.2.1) and where a fixed box
   *  is drawn (9.6.1), both laid out against the viewport at the
   *  document's top. Absent, the element is it. */
  viewport?: Rect;
  /** @internal Painting a fixed box already moved to the viewport. */
  atViewport?: boolean;
  /** A transparent surface `width` by `height` to draw on and composite
   *  with `drawImage`, the caller's to `destroy` once it has: a masked
   *  element is drawn on one. Null where there is no surface to be had. */
  surface?(width: number, height: number): Offscreen | null;
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
  /** @internal Each box's `::selection`, where a rule styles one
   *  (`BoxTree.selectionStyler`). */
  selectionStyler?: SelectionStyler | null;
  /** @internal What the rules give the shapes in each drawing, where one
   *  could reach any (`BoxTree.shapeStyler`). */
  shapeStyler?: ShapeStyler | null;
}

/**
 * The bounds of everything a box and its descendants draw, in document
 * coordinates, into `boundsX`…, with the text `position: relative` moved off
 * its lines where `moved` says there is some. Computed once per layout; the paint pass
 * reads it. Returns how far down the box's content reaches, for the
 * document's height — handed up rather than kept on every box, where
 * writing it and reading it back cost this walk a fifth of its time.
 */
/**
 * How far down an out-of-flow box's scrollable overflow reaches: its border
 * box, and what it holds where it does not clip it (`computePaintBounds`),
 * which the box it is in does not take in and the document does
 * (`layoutDocument`).
 */
export const OUT_OF_FLOW_REACH = new WeakMap<Box, number>();

/**
 * How far above and below a block's lines its inline content draws, at
 * most, by the array its lines are: glyphs taller than a `line-height` under
 * their face's height, and an atomic's ink past the line it is on. The
 * slack a paint's cull of the lines takes on top of their own rows
 * (`paintLines`); none for the lines of almost every block, whose content
 * is inside them.
 */
const LINE_INK = new WeakMap<
  readonly LineBox[],
  { above: number; below: number }
>();

/**
 * For a box painted through a matrix (`placedMatrix`), the bounds of what
 * it and its descendants draw before the matrix is applied: what
 * `boundsX`… would have been, which are where it puts them. The paint
 * inside the box, and a point taken back into it, are in these.
 */
const UNTRANSFORMED = new WeakMap<Box, Rect>();

/** The bounds of what a box painted through a matrix draws, in its own
 *  coordinates: asked of a box `placedMatrix` answers for, whose entry the
 *  last `computePaintBounds` wrote. */
export function ownBounds(box: Box): Rect {
  return (
    UNTRANSFORMED.get(box) ?? {
      x: box.boundsX,
      y: box.boundsY,
      width: box.boundsWidth,
      height: box.boundsHeight,
    }
  );
}

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
  // boxes are the layout's to count. A border box of no area reaches
  // nowhere, as a browser has it (Blink's `ScrollableOverflowCalculator`
  // adds no empty rect): the empty blocks a design leaves at its end,
  // below the last one's bottom margin, made the page that margin taller
  const empty = own && !(box.width > 0 && box.height > 0);
  let bottom = empty ? -Infinity : y2;
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
  // An inline box's fragments are boxes on the lines they are on, and its
  // padding and border reach above and below those lines: they count in
  // the scrollable overflow of the block it is in (CSS Overflow 3, 2.2) —
  // Blink adds each inline box fragment's border box
  // (`ScrollableOverflowCalculator::AddItemsInternal`). Design 150's footer
  // links, 50px of padding under their text, made Chrome's page 19px
  // taller than the box they end. Only a box with padding or a border
  // above or below its text can reach past its lines.
  if (
    box.kind === 'inline' &&
    box.padTop + box.padBottom + box.borderTop + box.borderBottom > 0
  ) {
    const reach = inlineFragmentsReach(box);
    if (reach) {
      x1 = Math.min(x1, reach.x1);
      y1 = Math.min(y1, reach.y1);
      x2 = Math.max(x2, reach.x2);
      y2 = Math.max(y2, reach.y2);
      bottom = Math.max(bottom, reach.y2);
    }
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
    else OUT_OF_FLOW_REACH.set(child, reach);
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
  //
  // And a line's text is drawn from its face's ascent above the baseline to
  // its descent below, its content area (CSS 2.1 10.6.1), which is past the
  // line box wherever `line-height` is under the face's height: a line box
  // is its line-height, whatever its glyphs are. Zen Garden 215's 91px title
  // sits on the 20px lines its body's `line-height: 1.25em` gave it, as a
  // length, and hangs 40px above them and 40px below — ink that a repaint
  // of those rows has to reach, where the lines alone do not.
  let above = 0;
  let below = 0;
  if (lines) {
    const movedOff = MOVED_OFF_LINES.get(lines);
    for (const line of lines) {
      let top = line.y;
      let bottom = line.y + line.height;
      for (const placed of line.atomics) {
        const atomic = placed.box;
        if (atomic.boundsY === Infinity) continue;
        x1 = Math.min(x1, atomic.boundsX);
        y1 = Math.min(y1, atomic.boundsY);
        x2 = Math.max(x2, atomic.boundsX + atomic.boundsWidth);
        y2 = Math.max(y2, atomic.boundsY + atomic.boundsHeight);
        top = Math.min(top, atomic.boundsY);
        bottom = Math.max(bottom, atomic.boundsY + atomic.boundsHeight);
      }
      // what `position: relative` moved off a line the cull finds on its
      // own (`reachedOff`), wherever it went
      if (movedOff?.has(line)) continue;
      for (const text of line.texts) {
        const natural = text.layout.lines[text.layoutLine];
        if (!natural) continue;
        const baseline = text.drawY + natural.baseline;
        top = Math.min(top, baseline - (natural.ascent ?? 0));
        bottom = Math.max(bottom, baseline + (natural.descent ?? 0));
      }
      if (top < line.y) {
        y1 = Math.min(y1, top);
        above = Math.max(above, line.y - top);
      }
      if (bottom > line.y + line.height) {
        y2 = Math.max(y2, bottom);
        below = Math.max(below, bottom - line.y - line.height);
      }
    }
  }
  if (lines && (above > 0 || below > 0)) LINE_INK.set(lines, { above, below });
  else if (lines) LINE_INK.delete(lines);
  // a `clip-path` cuts the box and all it holds: no ink past the path, and
  // none where it leaves nothing — though the scrollable overflow is what
  // it was, as a browser has it, which is why a page that hides a box with
  // one makes it a pixel square as well
  if (own && box.style.clipPath) {
    const { rect } = clipPathOf(box, DOCUMENT);
    x1 = Math.max(x1, rect.x);
    y1 = Math.max(y1, rect.y);
    x2 = Math.min(x2, rect.x + rect.w);
    y2 = Math.min(y2, rect.y + rect.h);
    if (!(x2 > x1 && y2 > y1)) x1 = Infinity;
  }
  // A box that turns, scales or skews draws what it holds through its
  // matrix (`paintTransformed`): its ink is where that puts it, the
  // rectangle around the one it would have filled, and the one it would
  // have filled is kept for the paint inside it, which is in its own
  // coordinates. One flattened to nothing draws nothing.
  const matrix = own ? placedMatrix(box) : null;
  if (matrix && x1 !== Infinity) {
    UNTRANSFORMED.set(box, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    if (invert(matrix)) {
      // no further than a length reaches (`LARGEST`): a page's
      // `scale(1e30)` is a box as large as a browser holds one, and no
      // larger
      const to = mapRect(matrix, x1, y1, x2 - x1, y2 - y1);
      x1 = Math.max(to.x, -LARGEST);
      y1 = Math.max(to.y, -LARGEST);
      x2 = Math.min(to.x + to.width, LARGEST);
      y2 = Math.min(to.y + to.height, LARGEST);
    } else x1 = Infinity;
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
  const end = empty ? -Infinity : box.y + box.height;
  let reach = end;
  if (bottom > end) {
    const style = box.style;
    reach =
      box.parent &&
      (style.overflowX !== 'visible' || style.overflowY !== 'visible')
        ? end
        : bottom;
  }
  // the scrollable overflow of a transformed box is where its transform
  // puts it (CSS Overflow 3, 2.2)
  if (!matrix || reach === -Infinity) return reach;
  const to = mapRect(matrix, box.x, box.y, box.width, reach - box.y);
  return Math.min(to.y + to.height, LARGEST);
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

/**
 * Where an inline box's fragments are, over the lines of the block it is
 * in that hold its text: from its face's ascent and its top padding and
 * border above each line's baseline to its descent and its bottom ones
 * below, as `paintInlineBoxes` draws them. Null for a box with no text or
 * no face.
 */
function inlineFragmentsReach(
  box: Box,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const face = box.decoration ?? PADDED_FACES.get(box);
  if (!face || box.subtreeTextEnd <= box.subtreeTextStart) return null;
  let block = box.parent;
  while (block && block.kind === 'inline') block = block.parent;
  const lines = block?.lines;
  if (!lines?.length) return null;
  const from = box.subtreeTextStart;
  const to = box.subtreeTextEnd;
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].textEnd > from) hi = mid;
    else lo = mid + 1;
  }
  const moved = offsetOf(box);
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (let i = lo; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.textStart >= to) break;
    if (line.textEnd <= from) continue;
    const raise = SHIFTED_LINES.has(line)
      ? (LINE_BOX_RAISES.get(line)?.get(box) ?? BOX_RAISES.get(box) ?? 0)
      : 0;
    const baseline = line.y + line.baseline - raise + (moved?.y ?? 0);
    x1 = Math.min(x1, line.x);
    x2 = Math.max(x2, line.x + line.width);
    y1 = Math.min(y1, baseline - face.ascent - box.padTop - box.borderTop);
    y2 = Math.max(
      y2,
      baseline + face.descent + box.padBottom + box.borderBottom,
    );
  }
  return x1 === Infinity ? null : { x1, y1, x2, y2 };
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
  const canvas = canvasBackground(tree);
  const scheme = rootScheme(tree);
  if (scheme !== tree.paletteScheme) {
    // A document is drawn on the window's own ground, the palette's, as an
    // embedded one is on a transparent canvas. Where its root's colour
    // scheme is not the scheme of what it is embedded in, its canvas is
    // opaque, in the `Canvas` colour of its own (CSS Color Adjust 1, 2.2):
    // a page that says it is light, and sets its text dark on no
    // background, is not read against a dark window.
    const area = canvasArea(tree.root, options);
    if (area) {
      ctx.fillStyle = SCHEME_COLORS[scheme].canvas;
      ctx.fillRect(area.x, area.y, area.w, area.h);
    }
  }
  if (canvas) paintCanvas(ctx, canvas, tree.root, options);
  paintBox(ctx, tree.root, {
    ...options,
    canvasSource: canvas?.source,
    negative: tree.negative,
    selectionStyler: options.selection ? tree.selectionStyler : null,
    shapeStyler: tree.shapeStyler,
  });
  ctx.restore();
}

/** What covers the canvas: a style's background, the box that would have
 *  painted it and now paints none, and the box its image is placed by. */
interface CanvasBackground {
  style: ComputedStyle;
  source: Box | null;
  anchor: Box;
}

/**
 * Whose background covers the canvas (CSS 2.1 14.2): the root element's,
 * or — where `<html>` has neither a colour nor an image — the first
 * `<body>`'s, which then paints no background of its own. A document with
 * no `<html>` tag has the root box standing in for its root element, and a
 * `<body>` in it is still the body: mail often starts at `<body style>`.
 * With neither tag, the root box stands in for the body, and the `<html>`
 * around it is implied: an `html { … }` or a `:root { … }` background, which
 * a test's reference sets on a document with no tags at all, has no box
 * but the canvas to be painted on. `anchor` is the box the image is
 * positioned against: the root element's, whichever box it came from.
 */
function canvasBackground(tree: BoxTree): CanvasBackground | null {
  const root = tree.root;
  const has = (s: ComputedStyle) =>
    !isTransparent(s.backgroundColor) ||
    !!s.backgroundImage ||
    !!s.backgroundGradient ||
    !!s.backgroundImages;
  const implied = tree.impliedHtml;
  if (implied) {
    // an `<html>` that is not displayed has no background to give
    if (implied.display === 'none') return null;
    if (has(implied)) return { style: implied, source: null, anchor: root };
    // containment on either keeps the body's to the body (CSS Containment 2)
    if (implied.contain || root.style.contain) return null;
    return has(root.style)
      ? { style: root.style, source: root, anchor: root }
      : null;
  }
  const top = childNamed(root, 'html') ?? root;
  if (has(top.style)) return { style: top.style, source: top, anchor: top };
  const body = childNamed(top, 'body');
  if (!body || top.style.contain || body.style.contain) return null;
  return has(body.style)
    ? { style: body.style, source: body, anchor: top }
    : null;
}

/** The used colour scheme of the document's root element: the `<html>`'s,
 *  or that of whichever box stands in for it (`canvasBackground`). */
function rootScheme(tree: BoxTree): 'light' | 'dark' {
  if (tree.impliedHtml) return tree.impliedHtml.colorScheme;
  return (childNamed(tree.root, 'html') ?? tree.root).style.colorScheme;
}

/** The canvas, cut to what is being painted: the whole element where the
 *  host says what that is, and else the root box. */
function canvasArea(
  root: Box,
  options: PaintOptions,
): { x: number; y: number; w: number; h: number } | null {
  const whole = options.canvas ?? {
    x: root.x + options.originX,
    y: root.y + options.originY,
    width: root.width,
    height: root.height,
  };
  return clampRect(
    options,
    Math.round(whole.x),
    Math.round(whole.y),
    Math.ceil(whole.width),
    Math.ceil(whole.height),
  );
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
  { style: source, anchor }: CanvasBackground,
  root: Box,
  options: PaintOptions,
): void {
  const area = canvasArea(root, options);
  if (!area) return;
  const layers = layersOf(source) ?? [source];
  const visible = source.visibility === 'visible';
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const style = layers[i];
    if (!isTransparent(style.backgroundColor) && visible) {
      ctx.fillStyle = inkColor(style.backgroundColor as string, style.color);
      ctx.fillRect(area.x, area.y, area.w, area.h);
    }
    if (style.backgroundGradient && visible) {
      // sized by the root element's box and repeated down the canvas, as a
      // browser does — the stripes a short page with a gradient on its
      // body shows — or by the viewport, where it is fixed
      const box =
        style.backgroundAttachment === 'fixed' && options.canvas
          ? (options.viewport ?? options.canvas)
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
  // (`paintClippedText`), and not as a box — but for what `border-area
  // text` paints in the border as well
  const style = box.style;
  if (style.backgroundClipText && style.backgroundClip !== 'border-area') {
    return;
  }
  const layers = layersOf(style);
  if (!layers) {
    paintLayer(ctx, box, options, style, image);
    return;
  }
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    paintLayer(ctx, box, options, layers[i], image);
  }
}

function paintLayer(
  ctx: PaintContext,
  box: Frame,
  options: PaintOptions,
  layer: ComputedStyle,
  image?: (layer: ComputedStyle) => void,
): void {
  // painted over the border box, inside what the border paints
  const area = layer.backgroundClip === 'border-area';
  if (area && !pushBorderArea(ctx, box, options)) return;
  paintBackground(ctx, box, options, layer);
  if (image && layer.backgroundImage) image(layer);
  if (area) ctx.restore();
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
 *  the box its `background-origin` names (CSS Backgrounds 3, 3.8) — of the
 *  whole strip, for a fragment of an inline box that is sliced. */
function originBox(
  frame: Frame,
  options: PaintOptions,
  style: ComputedStyle,
): Rect {
  const box = frame.strip ?? frame;
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
  Partial<Pick<Box, 'padTop' | 'padRight' | 'padBottom' | 'padLeft'>> & {
    /** Of an inline box's fragment, where the box goes on to another line:
     *  its fragments laid end to end as one box, which its images and
     *  gradients are placed in (`box-decoration-break: slice`). */
    strip?: Frame;
  };

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
  if (masked(box.style) && paintMasked(ctx, box, options)) {
    if (fade) ctx.restore();
    return;
  }
  // `clip` shows the part of an absolutely positioned box it names, its own
  // background and borders among it (CSS 2.1 11.1.2), and `clip-path` the
  // part of any box (`pushOwnClips`) — the content painted here, not in a
  // call of its own: a frame more a level and a deep document ran out of
  // stack
  const pushed = pushOwnClips(ctx, box, options);
  if (pushed >= 0) {
    paintContent(ctx, box, pathClips(box) ? underPath(options) : options);
    for (let i = 0; i < pushed; i += 1) ctx.restore();
  }
  if (fade) ctx.restore();
}

/** How large a surface a transformed box is drawn on: a large window's
 *  worth of pixels twice over, and no side longer than a pixmap's may be. */
const RASTER_LIMIT = 16 * 1024 * 1024;
const RASTER_SIDE = 16384;

/** What XRender carries a picture's transform in is 16.16 fixed point: a
 *  number past this does not fit, and is thrown out of the request's
 *  encoder. */
const FIXED_LIMIT = 32000;

/**
 * A box that turns, scales or skews (CSS Transforms 1): painted as it was
 * laid out, through its matrix — about its `transform-origin`, where its
 * translation has already put it (`placedMatrix`). What it holds is
 * painted with it, as the stacking context it is (`stacksLayers`), culled
 * against the damage taken back through the matrix.
 *
 * The native contexts draw everything through a matrix, a text layout's
 * outlines among it, glyphs and all (`scalesText`). ntk's draws paths
 * through one; a glyph it draws as it was shaped, upright and at its size,
 * where the matrix puts its origin, and an image through a transform the
 * server holds in fixed point, which a picture drawn small far across a
 * window does not fit. So there only a box that is paths and flat colour —
 * an icon, a chevron, a spinner — is drawn through the matrix, and any
 * other on a surface of its own, as it was laid out, with the surface
 * drawn through the matrix (`paintRaster`): a picture of its text rather
 * than the text, resampled, and right about where it is and which way up.
 *
 * A context with no `transform` draws the box where it was laid out: the
 * headless mock, which draws nothing, and a recording one.
 */
function paintTransformed(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  const matrix = placedMatrix(box);
  if (!matrix) {
    paintBox(ctx, box, options);
    return;
  }
  if (
    !intersects(box, options) ||
    COLLAPSED_CELLS.has(box) ||
    CLAMPED.has(box)
  ) {
    return;
  }
  if (typeof ctx.transform !== 'function') {
    paintPlaced(ctx, box, options);
    return;
  }
  // In the window's coordinates, where the document's origin is the
  // options': T(origin) · matrix · T(-origin). And about an origin moved
  // with the box's corner to the pixel it is drawn from: what is painted is
  // snapped to the pixel grid a box at a time, so a box a fraction of a
  // pixel down the page is drawn from a whole one, and turned about where
  // it was laid out it came back off the grid — a square mirrored onto
  // itself showed a line of what was under it along each side. A browser
  // snaps a transformed box's corner before its transform the same way.
  const left = box.x + options.originX;
  const top = box.y + options.originY;
  const ox = options.originX + Math.round(left) - left;
  const oy = options.originY + Math.round(top) - top;
  const [a, b, c, d] = matrix;
  const through: Matrix = [
    a,
    b,
    c,
    d,
    matrix[4] + ox - (a * ox + c * oy),
    matrix[5] + oy - (b * ox + d * oy),
  ];
  const back = invert(through);
  if (!back) return;
  const damage = options.damage;
  const inside: PaintOptions = {
    ...options,
    damage:
      damage && mapRect(back, damage.x, damage.y, damage.width, damage.height),
  };
  if (
    ctx.scalesText !== true &&
    !drawnAsPaths(box) &&
    paintRaster(ctx, box, inside, through)
  ) {
    return;
  }
  ctx.save();
  ctx.transform(a, b, c, d, through[4], through[5]);
  paintPlaced(ctx, box, inside);
  ctx.restore();
}

/**
 * Whether a box's style turns, scales or skews it, which is asked before
 * every box that may be one is painted (`paintPositioned`, `paintLines`) —
 * there, and not in `paintBox`, whose frame is one of three a level of
 * nesting costs the stack: a name more in it, and a document a thousand
 * boxes deep ran out.
 */
function turns(box: Box): boolean {
  const style = box.style;
  return (
    style.transform !== null || style.rotate !== null || style.scale !== null
  );
}

/**
 * `paintBox` for a box whose ink bounds are not in the coordinates it is
 * being painted in, and so is not culled by them: one painted through a
 * matrix, in its own (`paintTransformed`).
 */
function paintPlaced(ctx: PaintContext, box: Box, options: PaintOptions): void {
  const opacity = opacityOf(box);
  if (opacity <= 0) return;
  const fade = opacity < 1 && typeof ctx.globalAlpha === 'number';
  if (fade) {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha! * opacity;
  }
  if (!masked(box.style) || !paintMasked(ctx, box, options)) {
    paintClipped(ctx, box, options);
  }
  if (fade) ctx.restore();
}

/**
 * Whether all a box and what it holds draw is paths and flat colour:
 * backgrounds, borders, outlines and inline drawings — no text and no list
 * marker, whose glyphs a context may not turn, and no image, gradient,
 * shadow or mask, which one draws through a picture's transform
 * (`paintTransformed`).
 */
function drawnAsPaths(box: Box): boolean {
  if (box.subtreeTextEnd > box.subtreeTextStart) return false;
  const stack: Box[] = [box];
  while (stack.length) {
    const at = stack.pop()!;
    if (at.marker || at.replaced === 'image') return false;
    const style = at.style;
    if (
      style.backgroundImage !== null ||
      style.backgroundGradient !== null ||
      style.backgroundImages !== null ||
      style.boxShadow !== null ||
      style.borderImage.source !== null ||
      masked(style)
    ) {
      return false;
    }
    for (const child of at.children) stack.push(child);
  }
  return true;
}

/**
 * A transformed box painted on a surface of its own, as it was laid out,
 * and the surface drawn through its matrix: the part of what it draws that
 * the damage reaches. True where that is done — or is nothing to do, or
 * cannot be: a part too large for a surface, or a matrix that does not fit
 * the fixed point a picture's transform is sent in, which is one that draws
 * the box a thirtieth its size far across a window, or flatter than can be
 * seen. None of it is drawn then. False where the context has no surface to
 * draw on, and the caller draws the box through the matrix itself.
 */
function paintRaster(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  through: Matrix,
): boolean {
  if (!options.surface || !ctx.drawImage) return false;
  const own = ownBounds(box);
  let x0 = Math.floor(own.x + options.originX);
  let y0 = Math.floor(own.y + options.originY);
  let x1 = Math.ceil(own.x + own.width + options.originX);
  let y1 = Math.ceil(own.y + own.height + options.originY);
  const damage = options.damage;
  if (damage) {
    // a pixel more each way: the edge of what is drawn is sampled from
    // beside it
    x0 = Math.max(x0, Math.floor(damage.x) - 1);
    y0 = Math.max(y0, Math.floor(damage.y) - 1);
    x1 = Math.min(x1, Math.ceil(damage.x + damage.width) + 1);
    y1 = Math.min(y1, Math.ceil(damage.y + damage.height) + 1);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 0 && h > 0)) return true;
  if (w > RASTER_SIDE || h > RASTER_SIDE || w * h > RASTER_LIMIT) return true;
  // what the context makes of the draw below: the picture's transform is
  // the inverse of its matrix after the surface's place in it
  const placed = invert([
    through[0],
    through[1],
    through[2],
    through[3],
    through[0] * x0 + through[2] * y0 + through[4],
    through[1] * x0 + through[3] * y0 + through[5],
  ]);
  if (!placed || placed.some((n) => Math.abs(n) > FIXED_LIMIT)) return true;
  const surface = options.surface(w, h);
  if (!surface) return false;
  try {
    // the surface's own coordinates, the window's moved to its corner
    const on: PaintOptions = {
      ...options,
      originX: options.originX - x0,
      originY: options.originY - y0,
      damage: { x: 0, y: 0, width: w, height: h },
      canvas: options.canvas && {
        ...options.canvas,
        x: options.canvas.x - x0,
        y: options.canvas.y - y0,
      },
      viewport: options.viewport && {
        ...options.viewport,
        x: options.viewport.x - x0,
        y: options.viewport.y - y0,
      },
      clips: [],
    };
    paintPlaced(surface.getContext('2d') as PaintContext, box, on);
    ctx.save();
    ctx.transform!(
      through[0],
      through[1],
      through[2],
      through[3],
      through[4],
      through[5],
    );
    ctx.drawImage(surface, x0, y0);
    ctx.restore();
    return true;
  } finally {
    surface.destroy?.();
  }
}

/** A box and what it holds, cut to its `clip` and its `clip-path` as
 *  `paintBox` cuts it. */
function paintClipped(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  const pushed = pushOwnClips(ctx, box, options);
  if (pushed < 0) return;
  paintContent(ctx, box, pathClips(box) ? underPath(options) : options);
  for (let i = 0; i < pushed; i += 1) ctx.restore();
}

/**
 * Cut what follows to what a box shows of itself: the part its `clip`
 * names, where it is absolutely positioned, and the part its `clip-path`
 * does (CSS Masking 1, 5.1). How many clips were pushed, for the caller to
 * restore — none where the context cannot clip — or -1 where they leave
 * none of the box to show, and nothing was pushed.
 */
function pushOwnClips(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): number {
  const style = box.style;
  const clip = box.outOfFlow && style.clip ? clipOf(box, options) : null;
  if (clip && !(clip.w > 0 && clip.h > 0)) return -1;
  const path = pathClips(box) ? clipPathOf(box, options) : null;
  if (path && !(path.rect.w > 0 && path.rect.h > 0)) return -1;
  let pushed = 0;
  if (clip && pushClip(ctx, clip, null)) pushed += 1;
  if (path && pushClip(ctx, path.rect, path.radii)) pushed += 1;
  return pushed;
}

/** Whether a box is cut to a `clip-path`: one with a rectangle of its own
 *  for the path to be measured in. An inline box is drawn on its block's
 *  lines, and is not cut. */
export function pathClips(box: Box): boolean {
  return box.style.clipPath !== null && hasRect(box);
}

/**
 * The options what a box cut to a `clip-path` holds is painted with: no
 * clip around it for a positioned box to escape. The path cuts all the
 * element holds, whatever that is positioned from, where a box that clips
 * its overflow lets out a box whose containing block is outside it — put
 * off until that clip ended (`paintPositioned`), one in here was painted
 * with the path gone too.
 */
function underPath(options: PaintOptions): PaintOptions {
  return { ...options, clips: [] };
}

const MASK_LAYERS = new WeakMap<ComputedStyle, ComputedStyle[]>();

/** No corners: a mask layer is placed in the box's rectangle, which its
 *  radii do not round (CSS Masking 1, 7). */
const SQUARE_RADII: ComputedStyle['borderRadius'] = [0, 0, 0, 0];

/**
 * A style for each of a box's mask layers, top first, as `layersOf` makes
 * a background's: the box's own style with the layer's image, repeat, size,
 * position, origin and clip in its background's place, and no colour — so
 * the background painter places and repeats a mask layer as it does a
 * background layer, which is what CSS Masking 1 says a mask layer is (7).
 * Made once a style.
 */
function maskLayersOf(style: ComputedStyle): ComputedStyle[] {
  let layers = MASK_LAYERS.get(style);
  if (layers) return layers;
  const mask = style.mask;
  const nth = <T>(list: readonly T[], i: number): T => list[i % list.length];
  layers = mask.images.map((image, i) => {
    const layer = Object.create(style) as ComputedStyle;
    layer.backgroundColor = null;
    layer.backgroundImages = null;
    layer.backgroundImage = typeof image === 'string' ? image : null;
    layer.backgroundGradient =
      image !== null && typeof image !== 'string' ? image : null;
    layer.backgroundRepeat = nth(mask.repeats, i);
    layer.backgroundSize = nth(mask.sizes, i);
    layer.backgroundAttachment = 'scroll';
    [layer.backgroundPositionX, layer.backgroundPositionY] = nth(
      mask.positions,
      i,
    );
    layer.backgroundOrigin = nth(mask.origins, i);
    layer.backgroundClip = nth(mask.clips, i);
    layer.backgroundClipText = false;
    layer.borderRadius = SQUARE_RADII;
    layer.borderRadiusY = null;
    return layer;
  });
  MASK_LAYERS.set(style, layers);
  return layers;
}

/**
 * A masked box (CSS Masking 1, 7): the box and what it holds drawn on a
 * surface of their own, which the alpha of its mask layers — painted as a
 * background's are, on a second surface, each added over the ones below
 * it — then cuts with `destination-in`, and the result drawn in its place,
 * as the group a mask makes. Only the mask painting area, the border box,
 * can show, and only its part in the damage is drawn.
 *
 * A layer whose image has not arrived is transparent black (7.2), so a box
 * none of whose layers can be drawn yet draws nothing: an icon masked out
 * of its `background-color` is not a solid square while its image loads.
 * False where there is no surface to draw on, or no `destination-in` to
 * draw with, and the caller paints the box unmasked.
 */
function paintMasked(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): boolean {
  const layers = maskLayersOf(box.style);
  const drawable = layers.some(
    (layer) =>
      !!layer.backgroundGradient ||
      (!!layer.backgroundImage &&
        !!options.backgroundImageFor?.(layer.backgroundImage)),
  );
  if (!drawable) return true;
  if (!options.surface || !ctx.drawImage) return false;
  let x0 = Math.floor(box.x + options.originX);
  let y0 = Math.floor(frameY(box) + options.originY);
  let x1 = Math.ceil(box.x + box.width + options.originX);
  let y1 = Math.ceil(frameY(box) + frameHeight(box) + options.originY);
  const damage = options.damage;
  if (damage) {
    x0 = Math.max(x0, Math.floor(damage.x));
    y0 = Math.max(y0, Math.floor(damage.y));
    x1 = Math.min(x1, Math.ceil(damage.x + damage.width));
    y1 = Math.min(y1, Math.ceil(damage.y + damage.height));
  }
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 0 && h > 0)) return true;
  const content = options.surface(w, h);
  const mask = content && options.surface(w, h);
  try {
    if (!content || !mask) return false;
    const cctx = content.getContext('2d') as PaintContext;
    const mctx = mask.getContext('2d') as PaintContext;
    // the surfaces' own coordinates, the window's moved to their corner
    const on: PaintOptions = {
      ...options,
      originX: options.originX - x0,
      originY: options.originY - y0,
      damage: { x: 0, y: 0, width: w, height: h },
      canvas: options.canvas && {
        ...options.canvas,
        x: options.canvas.x - x0,
        y: options.canvas.y - y0,
      },
      viewport: options.viewport && {
        ...options.viewport,
        x: options.viewport.x - x0,
        y: options.viewport.y - y0,
      },
      clips: [],
    };
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      paintLayer(mctx, box, on, layers[i], frameImages(mctx, box, on));
    }
    paintClipped(cctx, box, on);
    cctx.globalCompositeOperation = 'destination-in';
    if (cctx.globalCompositeOperation !== 'destination-in') return false;
    cctx.drawImage!(mask, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(content, x0, y0);
    return true;
  } finally {
    content?.destroy?.();
    mask?.destroy?.();
  }
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
  if (columned.any) {
    const pieces = COLUMN_PIECES.get(box);
    if (pieces) {
      paintColumnPieces(ctx, box, pieces, options);
      return;
    }
  }
  if (style.boxShadow) paintShadows(ctx, box, options, false);
  if (box !== options.canvasSource) {
    paintLayers(ctx, box, options, frameImages(ctx, box, options));
  }
  if (style.boxShadow) paintShadows(ctx, box, options, true);
  if (!box.bordersCollapsed && !paintBorderImage(ctx, box, options)) {
    paintBorders(ctx, box, options);
  }
  if (box.kind === 'table') paintPartBackgrounds(ctx, box, options);
}

/**
 * The background and the borders of a block a column break falls inside
 * (CSS Multi-column 1), a piece at a time: drawn in each column as the
 * whole box standing there, and cut to the piece of it that is — which is
 * `box-decoration-break: slice`, CSS's default (CSS Fragmentation 3, 6.1):
 * no border and no padding at a break, and the background going on from
 * one piece to the next. Its shadow is not drawn: a sliced box casts one as
 * a whole and this has no whole box to cast it from.
 */
function paintColumnPieces(
  ctx: PaintContext,
  box: Box,
  pieces: readonly ColumnPiece[],
  options: PaintOptions,
): void {
  if (!ctx.save || !ctx.restore || !ctx.beginPath || !ctx.rect || !ctx.clip)
    return;
  for (const piece of pieces) {
    if (!(piece.height > 0 && piece.width > 0)) continue;
    const frame: Frame = {
      x: piece.x,
      y: piece.wholeY,
      width: piece.width,
      height: piece.wholeHeight,
      captionTop: 0,
      captionBottom: 0,
      borderTop: box.borderTop,
      borderRight: box.borderRight,
      borderBottom: box.borderBottom,
      borderLeft: box.borderLeft,
      padTop: box.padTop,
      padRight: box.padRight,
      padBottom: box.padBottom,
      padLeft: box.padLeft,
      style: box.style,
    };
    const left = Math.round(piece.x + options.originX);
    const top = Math.round(piece.y + options.originY);
    const right = Math.round(piece.x + piece.width + options.originX);
    const bottom = Math.round(piece.y + piece.height + options.originY);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    paintLayers(ctx, frame, options, frameImages(ctx, frame, options));
    paintBorders(ctx, frame, options);
    ctx.restore();
  }
}

/**
 * Clip to the rows of a text's layout that are in the text's column
 * (`COLUMN_ROWS`), where the layout is drawn at `left` and `top`: the rest
 * of it is another column's, drawn there. Answers whether it clipped, and
 * the caller restores.
 */
function clipToRows(
  ctx: PaintContext,
  text: LineText,
  rows: { top: number; bottom: number },
  left: number,
  top: number,
): boolean {
  if (!ctx.save || !ctx.restore || !ctx.beginPath || !ctx.rect || !ctx.clip)
    return false;
  const y1 = Math.round(top + rows.top);
  const y2 = Math.round(top + rows.bottom);
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    Math.floor(left) - ROW_REACH,
    y1,
    Math.ceil(text.layout.width) + 2 * ROW_REACH,
    y2 - y1,
  );
  ctx.clip();
  return true;
}

/** How far to either side of its layout a column's text may draw. */
const ROW_REACH = 2048;

/**
 * How `paintLayers` draws a frame's image layers: each in the area its
 * `background-clip` names, from the box its `background-origin` names
 * (CSS Backgrounds 3, 3.7 and 3.8) — a block's, or an inline box's
 * fragment's, whose background is its images as much as its colour.
 */
function frameImages(
  ctx: PaintContext,
  frame: Frame,
  options: PaintOptions,
): (layer: ComputedStyle) => void {
  return (layer) => {
    const painted = clipArea(frame, options, layer, true);
    const area =
      painted && clampRect(options, painted.x, painted.y, painted.w, painted.h);
    if (area) {
      paintBackgroundImage(
        ctx,
        layer,
        area,
        originBox(frame, options, layer),
        options,
        painted.corners,
      );
    }
  };
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
          shadowShape(
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
          shadowShape(
            ctx,
            hole.x - dx,
            hole.y,
            hole.width,
            hole.height,
            within,
          );
        }
      },
      frame.x + frame.width + shadowReach(s.blur),
      'evenodd',
    );
    ctx.restore();
  }
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
  rule: 'nonzero' | 'evenodd' = 'nonzero',
): void {
  if (!(s.blur > 0)) {
    ctx.fillStyle = color;
    ctx.beginPath!();
    shape(0);
    ctx.fill!(rule);
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
  ctx.fill!(rule);
  ctx.restore();
}

/**
 * A shadow's shape, spelled the way a 2d context recognises one: a `rect`,
 * or a `roundRect` with each corner's own radii, elliptical where the
 * corner is. react-x11's contexts draw the blurred shadow of such a shape —
 * and of a `rect` less such a shape, filled `evenodd` — from a tile they
 * keep, where one built of curves they blur afresh on every fill.
 */
function shadowShape(
  ctx: PaintContext,
  x: number,
  y: number,
  w: number,
  h: number,
  c: Corners,
): void {
  if (c.x.every((r) => r === 0) || c.y.every((r) => r === 0)) {
    ctx.rect!(x, y, w, h);
    return;
  }
  // a circular corner as the number every context has always taken; only
  // an elliptical one as the point
  const corner = (i: number) =>
    c.x[i] === c.y[i] ? c.x[i] : { x: c.x[i], y: c.y[i] };
  ctx.roundRect!(x, y, w, h, [corner(0), corner(1), corner(2), corner(3)]);
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
    !masked(style) &&
    // cut to a path with all it holds, as one group
    !style.clipPath &&
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
    !masked(style) &&
    !style.clipPath &&
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
  options: ClipSpace,
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
  options: ClipSpace,
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
 *  top, right, bottom and left — none for `border-area`, whose layer is
 *  painted over the border box inside what the border paints. */
function edgeInsets(
  box: Frame,
  which: BackgroundClip,
): readonly [number, number, number, number] {
  if (which === 'border-box' || which === 'border-area') return NO_INSETS;
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
  // through its matrix, where it turns, scales or skews
  if (turns(box)) paintTransformed(ctx, box, atViewport(box, options));
  else paintBox(ctx, box, atViewport(box, options));
}

/**
 * The options a box is painted with where it is fixed to the viewport
 * (CSS 2.1 9.6.1): laid out against the viewport at the document's top,
 * and drawn where the viewport is now, however far the pane that scrolls
 * the element has moved it — a fixed header scrolled away with the text.
 * Once for a box and all it holds.
 */
function atViewport(box: Box, options: PaintOptions): PaintOptions {
  const viewport = options.viewport;
  if (!viewport || options.atViewport || !fixedToViewport(box)) {
    return options;
  }
  // where the document's top left is from the viewport's, less where the
  // viewport is in the document: the scroll
  const root = rootOf(box);
  const dx = viewport.x - options.originX - root.x;
  const dy = viewport.y - options.originY - root.y;
  return {
    ...options,
    originX: options.originX + dx,
    originY: options.originY + dy,
    atViewport: true,
  };
}

/** Per tree, its boxes fixed to the viewport (`fixedToViewport`), found
 *  as the layout positions them: what the element answers a scroll pane's
 *  blit with (`HtmlViewNode.viewportFixedRects`). */
export const FIXED_BOXES = new WeakMap<object, Box[]>();

/** Whether a box is fixed to the viewport: `position: fixed` with no
 *  transformed or contained box around it, which would be its containing
 *  block instead (CSS Transforms 1, CSS Containment 2, 3.3). */
export function fixedToViewport(box: Box): boolean {
  if (box.style.position !== 'fixed') return false;
  for (let at = box.parent; at?.parent; at = at.parent) {
    if (holdsFixed(at)) return false;
  }
  return true;
}

/** Whether a box is the containing block of the fixed boxes in it: a
 *  transformed box, or one with layout or paint containment. */
function holdsFixed(box: Box): boolean {
  return (
    transformed(box.style) || contained(box, CONTAIN_LAYOUT | CONTAIN_PAINT)
  );
}

function rootOf(box: Box): Box {
  let root = box;
  while (root.parent) root = root.parent;
  return root;
}

/**
 * The box an out-of-flow box is positioned in, whose clips are the ones it
 * is under (`paintPositioned`, and the hit test's `deepestAt`): its nearest
 * positioned or transformed ancestor, or the root. Null for a box fixed to
 * the viewport, which is under none — one in a transformed box is fixed to
 * that, and under what it is under.
 */
export function containingBlockOf(box: Box): Box | null {
  if (box.style.position === 'fixed') {
    for (let at = box.parent; at?.parent; at = at.parent) {
      if (holdsFixed(at)) return at;
    }
    return null;
  }
  let containing = box.parent;
  while (
    containing?.parent &&
    containing.style.position === 'static' &&
    !transformed(containing.style)
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
  options: ClipSpace,
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

/** What placing a clip reads of a paint's options: where the document's
 *  origin is, its scale, and how far an axis left open has to reach. */
type ClipSpace = Pick<PaintOptions, 'originX' | 'originY' | 'scale' | 'damage'>;

/** The document's own coordinates, as a space to place a clip in. */
const DOCUMENT: ClipSpace = { originX: 0, originY: 0, scale: 1, damage: null };

/**
 * A box's `clip-path` in window coordinates (CSS Masking 1, 5.1): the
 * rectangle its shape is (CSS Shapes 1, 3.1), each edge on the pixel it
 * falls nearest as a box's are, and its corners where it has any — of no
 * area where the shape leaves none of the box to show. Measured in the box
 * the path names, the border box unless it says: `inset()` in from its
 * edges, `rect()` and `xywh()` from its top left, and the box itself, with
 * the element's own corners, where no shape is written.
 */
function clipPathOf(
  box: Box,
  options: ClipSpace,
): {
  rect: { x: number; y: number; w: number; h: number };
  radii: Corners | null;
} {
  const path = box.style.clipPath!;
  // the box it is measured in, in from the border box — or out from it
  const within = path.box;
  const [it, ir, ib, il] =
    within === 'margin-box'
      ? [-box.marginTop, -box.marginRight, -box.marginBottom, -box.marginLeft]
      : edgeInsets(box, within);
  const width = Math.max(0, box.width - il - ir);
  const height = Math.max(0, frameHeight(box) - it - ib);
  // how far in from that box's edges the rectangle's are
  const [a, b, c, d] = path.lengths;
  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;
  if (path.shape === 'inset') {
    top = resolve(a, height);
    right = resolve(b, width);
    bottom = resolve(c, height);
    left = resolve(d, width);
    // a pair that adds up to more than the box is across is reduced to
    // it, each in its proportion, as overlapping radii are (3.1):
    // `inset(50%)` and `inset(75%)` are both the box's centre, and nothing
    if (left + right > width && left > 0 && right > 0) {
      const f = Math.max(0, width) / (left + right);
      left *= f;
      right *= f;
    }
    if (top + bottom > height && top > 0 && bottom > 0) {
      const f = Math.max(0, height) / (top + bottom);
      top *= f;
      bottom *= f;
    }
  } else if (path.shape === 'rect') {
    // four edges from the top and the left, `auto` the box's own; the
    // right and the bottom are no less than the left and the top
    top = a === AUTO ? 0 : resolve(a, height);
    left = d === AUTO ? 0 : resolve(d, width);
    right = b === AUTO ? 0 : width - Math.max(left, resolve(b, width));
    bottom = c === AUTO ? 0 : height - Math.max(top, resolve(c, height));
  } else if (path.shape === 'xywh') {
    left = resolve(a, width);
    top = resolve(b, height);
    right = width - left - Math.max(0, resolve(c, width));
    bottom = height - top - Math.max(0, resolve(d, height));
  }
  const x0 = box.x + options.originX + il;
  const y0 = frameY(box) + options.originY + it;
  const x = Math.round(x0 + left);
  const y = Math.round(y0 + top);
  const rect = {
    x,
    y,
    w: Math.max(0, Math.round(x0 + width - right) - x),
    h: Math.max(0, Math.round(y0 + height - bottom) - y),
  };
  let radii: Corners | null = null;
  if (path.shape === null) {
    // the box alone: its edge, shaped as the element's corners shape it
    const corners = cornersOf(box.style, box.width, frameHeight(box));
    if (corners) {
      radii =
        within === 'margin-box'
          ? spreadCorners(
              corners,
              box.width,
              frameHeight(box),
              -it,
              -ir,
              -ib,
              -il,
            )
          : roundedOf(insetCorners(corners, it, ir, ib, il));
    }
  } else if (path.radii) {
    // a percentage is of the box the shape is in, and the radii are fitted
    // to the rectangle they round
    radii = cornersFor(path.radii, path.radiiY, width, height, rect.w, rect.h);
  }
  return { rect, radii };
}

/** Corners, or null where every one of them is square. */
function roundedOf(c: Corners): Corners | null {
  for (let i = 0; i < 4; i += 1) if (c.x[i] > 0 && c.y[i] > 0) return c;
  return null;
}

/**
 * Whether a point of the document is in what a box's `clip-path` leaves of
 * it: what a hit test asks, since nothing the path cuts away — of the box
 * or of anything in it — is under a pointer (`deepestAt`).
 */
export function inClipPath(box: Box, x: number, y: number): boolean {
  const { rect, radii } = clipPathOf(box, DOCUMENT);
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  if (x < rect.x || x >= right || y < rect.y || y >= bottom) return false;
  if (!radii) return true;
  // inside the rectangle, and past a corner's curve: each corner is a
  // quarter of an ellipse about a centre its radii in from the two edges
  for (let i = 0; i < 4; i += 1) {
    const rx = radii.x[i];
    const ry = radii.y[i];
    if (!(rx > 0 && ry > 0)) continue;
    const onLeft = i === 0 || i === 3;
    const cx = onLeft ? rect.x + rx : right - rx;
    const cy = i < 2 ? rect.y + ry : bottom - ry;
    if (onLeft ? x >= cx : x <= cx) continue;
    if (i < 2 ? y >= cy : y <= cy) continue;
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    if (dx * dx + dy * dy > 1) return false;
  }
  return true;
}

/**
 * Whether a point of the document is in the part of a box its `clip` shows
 * (CSS 2.1 11.1.2) — anywhere, for a box that is cut to none: what a hit
 * test asks, since what the clip cuts away is not drawn (`deepestAt`). What
 * it cuts away is the box and what is painted with it: all the box holds
 * where it is a stacking context (`stacksLayers`), and elsewhere all but a
 * fixed box, which the context around it paints under no clip
 * (`clipsFor`). Chrome cuts that one too.
 */
export function inClip(box: Box, x: number, y: number): boolean {
  if (!box.outOfFlow || !box.style.clip) return true;
  const rect = clipOf(box, DOCUMENT);
  return (
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
  );
}

/**
 * The part of the document a box shows through, in the document's own
 * pixels, or null where nothing cuts it: the `clip` it is cut to (CSS 2.1
 * 11.1.2), and the clips of the boxes it is under — each that clips its
 * overflow or is cut to a `clip` of its own, from its containing block up
 * (11.1.1), so an absolute box is outside a box that clips where its
 * containing block is, and a fixed one outside them all. And every
 * `clip-path` from the box up, its own among them: a path cuts all its
 * element holds, whatever that is positioned from (CSS Masking 1, 5.1) —
 * to the rectangle a path's shape is, its corners left square. A rectangle
 * of no area where none of it shows. Painting cuts what it draws as it
 * walks down; this is for what is not painted here and has to be cut all
 * the same, a control's widget (`controlRectsOf`).
 */
export function clipAround(box: Box, scale = 1): Rect | null {
  const space: ClipSpace = { originX: 0, originY: 0, scale, damage: null };
  let x0 = -Infinity;
  let y0 = -Infinity;
  let x1 = Infinity;
  let y1 = Infinity;
  let cut = false;
  const under = (rect: { x: number; y: number; w: number; h: number }) => {
    cut = true;
    x0 = Math.max(x0, rect.x);
    y0 = Math.max(y0, rect.y);
    x1 = Math.min(x1, rect.x + rect.w);
    y1 = Math.min(y1, rect.y + rect.h);
  };
  if (box.outOfFlow && box.style.clip) under(clipOf(box, space));
  // what holds a box, as clips go: its parent, or out of the flow its
  // containing block, and the boxes between them do not clip it
  const holder = (inner: Box): Box | null =>
    inner.outOfFlow ? containingBlockOf(inner) : inner.parent;
  for (let outer = holder(box); outer; outer = holder(outer)) {
    if (outer.outOfFlow && outer.style.clip) under(clipOf(outer, space));
    if (clipsOverflow(outer)) under(clipEdge(outer, space).rect);
  }
  for (let at: Box | null = box; at; at = at.parent) {
    if (pathClips(at)) under(clipPathOf(at, space).rect);
  }
  if (!cut) return null;
  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
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
  return cornersFor(across, down, w, h, w, h);
}

/**
 * Radii as corners in pixels: each a length or a percentage of a box `w`
 * by `h`, across and down, and all of them reduced together where two on a
 * side of the rectangle they round — `fitW` by `fitH`, which for a
 * `border-radius` is that box, and for a `clip-path`'s `round` is the
 * rectangle inside it — would overlap. Null where every corner is square.
 */
function cornersFor(
  across: readonly Len[],
  down: readonly Len[] | null,
  w: number,
  h: number,
  fitW: number,
  fitH: number,
): Corners | null {
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
  fit(fitW, x[0] + x[1]);
  fit(fitH, y[1] + y[2]);
  fit(fitW, x[2] + x[3]);
  fit(fitH, y[3] + y[0]);
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
    !transformed(style)
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
export function onLine(parent: Box, child: Box): boolean {
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
 * `z-index: -1` went behind the page); transformed (CSS Transforms 1, 3);
 * or under full opacity (CSS Color 4
 * 3.2), its own or the opacity it takes from an inline box it broke
 * (`FADED_BLOCKS`), which is painted as one group — faded with it, or at
 * `opacity: 0` not at all, where its root context drew a hover menu's
 * absolute children.
 */
export function stacksLayers(box: Box): boolean {
  const style = box.style;
  if (style.position === 'fixed' || style.position === 'sticky') return true;
  if (style.opacity < 1 || FADED_BLOCKS.has(box)) return true;
  // and so does a mask, which is applied to the group (CSS Masking 1, 7),
  // and a clip path, which cuts it (5.1)
  if (masked(style) || pathClips(box)) return true;
  // layout and paint containment make one (CSS Containment 2, 3.3, 3.5)
  if (contained(box, CONTAIN_LAYOUT | CONTAIN_PAINT)) return true;
  // and a transform (CSS Transforms 1, 3), on a box one applies to: what it
  // holds is painted with it, through its matrix, and not by a context
  // outside it
  if (transformed(style) && box.kind !== 'inline') return true;
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
export function clipsFor(box: Box, context: Box): Box[] {
  let from: Box | null = box.parent;
  if (box.outOfFlow) {
    const fixed = box.style.position === 'fixed';
    while (from && from !== context) {
      const style = from.style;
      if (transformed(style)) break;
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
  options = atViewport(box, options);
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
  return layerOf(a) - layerOf(b);
}

/** The `z-index` a box is ordered by among its stacking context's layers:
 *  its own where one applies — to a positioned box, and to a flex or a grid
 *  item (CSS 2.1 9.9.1, CSS Flexbox 5.4) — and none for a box that is
 *  among them for its transform alone, which is painted in the document's
 *  order whatever `z-index` it was given. */
function layerOf(box: Box): number {
  const style = box.style;
  const z = style.zIndex;
  if (z === 'auto') return 0;
  return style.position !== 'static' || flexItem(box) ? z : 0;
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
  if (gradient) {
    // over the colour, as the layer an image is: the size of the padding
    // box, which is where it starts, and repeated under the borders — or
    // the viewport's, where it is fixed; its line runs across the whole of
    // it, not the part this paint reaches
    const fixed =
      style.backgroundAttachment === 'fixed' &&
      (options.viewport ?? options.canvas);
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
      const paint = gradientFill(
        ctx,
        gradient,
        at.x,
        at.y,
        at.width,
        at.height,
        style.color,
        rect,
      );
      if (paint) fillGradient(ctx, paint, rect, rounded);
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
  gradient: Gradient,
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
    const paint = gradientFill(ctx, gradient, x0, y0, w, h, style.color, area);
    if (paint) fillGradient(ctx, paint, area);
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
      const paint = gradientFill(ctx, gradient, x, y, w, h, style.color, tile);
      if (paint) fillGradient(ctx, paint, tile);
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
  const at = stopOffsets(stops, length);
  // the context's offsets are 0 to 1, so a line that stops reach past runs
  // from the first to the last, and the box sees the part of it between
  const from = Math.min(0, at[0]);
  const to = Math.max(1, at[at.length - 1]);
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
    g.addColorStop((at[i] - from) / (to - from), colors[i]);
  }
  return g;
}

/**
 * Where each of a gradient's stops is along a line `length` long, as a
 * fraction of it (CSS Images 3, 3.5.1): a stop without a position is
 * spread evenly between its neighbours', the first at 0 and the last at 1
 * where they have none, and none is before the one before it.
 */
function stopOffsets(stops: GradientStop[], length: number): number[] {
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
  return at as number[];
}

/** What a gradient fills with: the context's gradient, or the one colour
 *  it comes to, and the matrix it is sampled through where it is an
 *  ellipse — a context's radial gradients are circles, and an ellipse is
 *  one stretched along its longer axis. */
interface GradientFill {
  style: unknown;
  matrix: [number, number, number, number, number, number] | null;
}

/** A gradient's fill for a box at (`x`, `y`), `w` by `h`: null where the
 *  context draws no gradient of its kind. */
function gradientFill(
  ctx: PaintContext,
  gradient: Gradient,
  x: number,
  y: number,
  w: number,
  h: number,
  currentColor: string,
  visible: { x: number; y: number; w: number; h: number } | null = null,
): GradientFill | null {
  if (gradient.kind === 'radial') {
    return radialGradient(ctx, gradient, x, y, w, h, currentColor, visible);
  }
  if (!ctx.createLinearGradient) return null;
  return {
    style: linearGradient(ctx, gradient, x, y, w, h, currentColor, visible),
    matrix: null,
  };
}

/**
 * A `radial-gradient()` across a box (CSS Images 3, 3.2.2): centred where
 * its position puts it, and as large as its radii, or as its keyword says
 * — the side or the corner of the box nearest the centre or furthest from
 * it, and for an ellipse through a corner, the ellipse with the shape the
 * sides would give it. The stops are spaced along the ray from the centre
 * to the ending shape's edge, which for an ellipse is its horizontal
 * radius; one before the centre, where the ray starts, gives the colour
 * there and no more, and one past the edge carries the gradient on.
 *
 * A shape with no width or no height is drawn as its last colour, as
 * Chrome draws each (crbug.com/635727): the spec draws a zero width as a
 * gradient mirrored about the centre line, which Chrome does not.
 */
function radialGradient(
  ctx: PaintContext,
  gradient: RadialGradient,
  x: number,
  y: number,
  w: number,
  h: number,
  currentColor: string,
  visible: { x: number; y: number; w: number; h: number } | null = null,
): GradientFill | null {
  const colors = gradient.stops.map((stop) =>
    inkColor(stop.color, currentColor),
  );
  const cx = resolve(gradient.at[0], w);
  const cy = resolve(gradient.at[1], h);
  let rx: number;
  let ry: number;
  if (gradient.radii) {
    rx = resolve(gradient.radii[0], w);
    ry = resolve(gradient.radii[1], h);
  } else {
    const extent = gradient.extent ?? 'farthest-corner';
    const side = extent.startsWith('closest') ? Math.min : Math.max;
    const sx = side(Math.abs(cx), Math.abs(w - cx));
    const sy = side(Math.abs(cy), Math.abs(h - cy));
    const corner = extent.endsWith('corner');
    if (gradient.circle) {
      rx = ry = corner ? Math.hypot(sx, sy) : side(sx, sy);
    } else {
      // through the corner, in the shape the sides give it
      rx = corner ? sx * Math.SQRT2 : sx;
      ry = corner ? sy * Math.SQRT2 : sy;
    }
  }
  if (!(rx > 0 && ry > 0)) {
    return { style: colors[colors.length - 1], matrix: null };
  }
  if (!hasRadialGradients(ctx)) return null;
  let at = stopOffsets(gradient.stops, rx);
  let inks = colors;
  if (at[0] < 0) {
    // the colour at the centre, between the stops either side of it
    const first = colorAlong(at, colors, 0);
    const i = at.findIndex((t) => t > 0);
    if (i < 0) return { style: first, matrix: null };
    at = [0, ...at.slice(i)];
    inks = [first, ...colors.slice(i)];
  }
  const ax = x + cx;
  const ay = y + cy;
  const seen = visible ?? { x, y, w, h };
  if (!(Math.abs(ax) < RADIAL_REACH && Math.abs(ay) < RADIAL_REACH)) {
    return farRadial(ctx, at, inks, ax, ay, rx, ry, seen);
  }
  let to = Math.max(1, at[at.length - 1]);
  if (Math.max(rx, ry) * to > GRADIENT_REACH) {
    // as far along the ray as what is seen of it reaches, and no further:
    // a circle a context cannot carry, cut to the part it draws
    let reach = 0;
    for (const px of [seen.x, seen.x + seen.w]) {
      for (const py of [seen.y, seen.y + seen.h]) {
        reach = Math.max(reach, Math.hypot((px - ax) / rx, (py - ay) / ry));
      }
    }
    if (reach > 0 && reach < to) {
      const last = colorAlong(at, inks, reach);
      const kept = at.filter((t) => t < reach).length;
      at = [...at.slice(0, kept), reach];
      inks = [...inks.slice(0, kept), last];
      to = reach;
    }
  }
  const circle = rx === ry;
  // a circle as wide as the ellipse is narrow, stretched along the other
  // axis: the matrix only ever widens, so its inverse, which a context
  // samples the gradient through, reaches no further than the centre does
  const r = Math.min(rx, ry);
  const g = circle
    ? ctx.createRadialGradient!(ax, ay, 0, ax, ay, r * to)
    : ctx.createRadialGradient!(0, 0, 0, 0, 0, r * to);
  for (let i = 0; i < at.length; i += 1) {
    g.addColorStop(at[i] / to, inks[i]);
  }
  return {
    style: g,
    matrix: circle ? null : [rx / r, 0, 0, ry / r, ax, ay],
  };
}

/**
 * How far from the origin a radial gradient's centre may be and still be
 * the context's to draw: ntk makes a gradient past what X RENDER carries at
 * a scale that fits, and its 16.16 matrix holds that scale to a fraction of
 * a pixel to here.
 */
const RADIAL_REACH = 1 << 18;

/**
 * A radial gradient whose centre is further off than a context carries —
 * `at 0 calc(infinity * 1px)`, which comes to the largest length there is —
 * across the part of it that is seen: from that far its rings are as good
 * as straight, so it is drawn as the linear gradient that runs the way the
 * rings spread there, as fast as they do, cut to what is seen as a linear
 * gradient's line is. The rings bend away from it by the square of what is
 * seen over eight times the distance, under a pixel from here.
 */
function farRadial(
  ctx: PaintContext,
  at: number[],
  colors: string[],
  ax: number,
  ay: number,
  rx: number,
  ry: number,
  seen: { x: number; y: number; w: number; h: number },
): GradientFill | null {
  if (!ctx.createLinearGradient) return null;
  // the middle of what is seen, in the circle's own space, and how fast
  // the gradient runs there, a pixel
  const px = seen.x + seen.w / 2;
  const py = seen.y + seen.h / 2;
  const ux = (px - ax) / rx;
  const uy = (py - ay) / ry;
  const t = Math.hypot(ux, uy);
  const gx = ux / rx / t;
  const gy = uy / ry / t;
  const g2 = gx * gx + gy * gy;
  if (!(t > 0 && g2 > 0 && Number.isFinite(t / g2))) {
    return { style: colorAlong(at, colors, t), matrix: null };
  }
  // the line it runs along, from where it would start to where it is 1
  const lx = gx / g2;
  const ly = gy / g2;
  return {
    style: clippedGradient(
      ctx,
      at,
      colors,
      px - lx * t,
      py - ly * t,
      lx,
      ly,
      seen,
    ),
    matrix: null,
  };
}

/**
 * Whether a context draws radial gradients. react-x11's macOS and Windows
 * contexts have the method and paint what it returns flat, in one colour
 * — over whatever a vignette was meant to let through — and theirs takes
 * no circles, which is how it is told from one that draws them: ntk's and
 * the Wayland context's take the six numbers canvas gives it. There a
 * radial gradient is drawn as nothing, as every one was.
 */
function hasRadialGradients(ctx: PaintContext): boolean {
  return (ctx.createRadialGradient?.length ?? 0) >= 6;
}

/**
 * Fills a rectangle, rounded where `corners` says, with a gradient. An
 * ellipse's shape is laid down first and filled under its matrix, which a
 * context applies to the fill's paint and not to a path it already has.
 */
function fillGradient(
  ctx: PaintContext,
  fill: GradientFill,
  r: { x: number; y: number; w: number; h: number },
  corners: Corners | null = null,
): void {
  ctx.fillStyle = fill.style;
  if (!fill.matrix) {
    if (corners) {
      ctx.beginPath!();
      roundedRect(ctx, r.x, r.y, r.w, r.h, corners);
      ctx.fill!();
    } else ctx.fillRect(r.x, r.y, r.w, r.h);
    return;
  }
  if (!ctx.transform || !ctx.beginPath || !ctx.rect || !ctx.fill) return;
  ctx.save();
  ctx.beginPath();
  if (corners) roundedRect(ctx, r.x, r.y, r.w, r.h, corners);
  else ctx.rect(r.x, r.y, r.w, r.h);
  ctx.transform(...fill.matrix);
  ctx.fill();
  ctx.restore();
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
  g.addColorStop(0, colorAlong(at, colors, t0));
  for (let i = 0; i < at.length; i += 1) {
    if (at[i] > t0 && at[i] < t1) {
      g.addColorStop((at[i] - t0) / (t1 - t0), colors[i]);
    }
  }
  g.addColorStop(1, colorAlong(at, colors, t1));
  return g;
}

/** The colour at a place along a gradient whose stops are at `at`: a
 *  stop's, or between two. */
function colorAlong(at: number[], colors: string[], t: number): string {
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
    at = options.viewport ?? options.canvas;
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

/**
 * Borders, a side at a time.
 *
 * As rectangles where they can be, the top and the bottom full width and
 * the sides between them, and not as a stroked path, for the reason
 * richtext gives about its underlines: the mock backend has no path API, and
 * a 1px border on a pixel grid is a rectangle rather than something an
 * antialiased stroke improves. That is every border whose sides share a
 * colour, where a corner looks the same whichever side it is given to.
 *
 * Where two sides that meet differ in colour — one of them transparent
 * included — the corner is cut on the diagonal from its outer point to its
 * inner one and each side takes its half (CSS Backgrounds 3, 4.3), so a side
 * is a trapezoid, and a triangle where the box inside the borders has no
 * width: the CSS triangle a dropdown's caret and a tooltip's arrow are
 * drawn with, which came out as the rectangle around it. Only a solid side
 * is cut, and only against a side that is solid or paints nothing; dots,
 * dashes and a double border's two lines keep their rectangles, the lines
 * joined where two double sides of one colour meet (`fillSide`).
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
  if (sculpted(s) && paintSculpted(ctx, box, x, y, w, h, options)) return;

  const t = box.borderTop;
  const r = box.borderRight;
  const b = box.borderBottom;
  const l = box.borderLeft;
  /** What a side is painted in, null where it paints nothing. */
  const ink = (width: number, color: string): string | null =>
    width > 0 && !isTransparent(color) ? inkColor(color, s.color) : null;
  const topInk = ink(t, s.borderTopColor);
  const rightInk = ink(r, s.borderRightColor);
  const bottomInk = ink(b, s.borderBottomColor);
  const leftInk = ink(l, s.borderLeftColor);
  // the corners cut on the diagonal; none where the context draws no path,
  // and the sides are rectangles
  const paths = !!(ctx.beginPath && ctx.moveTo && ctx.lineTo && ctx.fill);
  const topStyle = s.borderTopStyle;
  const rightStyle = s.borderRightStyle;
  const bottomStyle = s.borderBottomStyle;
  const leftStyle = s.borderLeftStyle;
  const tl = paths && mitred(t, l, topInk, leftInk, topStyle, leftStyle);
  const tr = paths && mitred(t, r, topInk, rightInk, topStyle, rightStyle);
  const br =
    paths && mitred(b, r, bottomInk, rightInk, bottomStyle, rightStyle);
  const bl = paths && mitred(b, l, bottomInk, leftInk, bottomStyle, leftStyle);

  const widths = [t, r, b, l];
  const joins = doubleJoins(box);
  /** A side with square corners, the top first and clockwise. */
  const edge = (
    at: number,
    style: ComputedStyle['borderTopStyle'],
    color: string,
  ): void => {
    ctx.fillStyle = color;
    fillSide(ctx, options, at, x, y, w, h, widths, style, joins);
  };
  /** A side with a cut corner: its outer edge and then its inner one. */
  const side = (points: number[], color: string): void => {
    const area = clampRect(options, x, y, w, h);
    if (!area) return;
    ctx.fillStyle = color;
    fillPolygon(ctx, points, area);
  };
  // the border box's far edges, and the padding box inside it
  const x1 = x + w;
  const y1 = y + h;
  const px0 = x + l;
  const py0 = y + t;
  const px1 = Math.max(px0, x1 - r);
  const py1 = Math.max(py0, y1 - b);
  // The left and the right are drawn after the top and the bottom. Where
  // one of them is opaque it draws its half of a cut corner over the side
  // drawn before, which keeps the whole corner: two halves each
  // antialiased along the diagonal would let what is under the border
  // show through between them.
  const over = (color: string | null): boolean =>
    color !== null && alphaOf(color) === 1;
  if (topInk !== null) {
    const cutLeft = tl && !over(leftInk);
    const cutRight = tr && !over(rightInk);
    if (cutLeft || cutRight) {
      side(
        [x, y, x1, y, cutRight ? px1 : x1, py0, cutLeft ? px0 : x, py0],
        topInk,
      );
    } else edge(0, topStyle, topInk);
  }
  if (bottomInk !== null) {
    const cutLeft = bl && !over(leftInk);
    const cutRight = br && !over(rightInk);
    if (cutLeft || cutRight) {
      side(
        [x1, y1, x, y1, cutLeft ? px0 : x, py1, cutRight ? px1 : x1, py1],
        bottomInk,
      );
    } else edge(2, bottomStyle, bottomInk);
  }
  if (leftInk !== null) {
    if (tl || bl) {
      side([x, bl ? y1 : py1, x, tl ? y : py0, px0, py0, px0, py1], leftInk);
    } else edge(3, leftStyle, leftInk);
  }
  if (rightInk !== null) {
    if (tr || br) {
      side([x1, tr ? y : py0, x1, br ? y1 : py1, px1, py1, px1, py0], rightInk);
    } else edge(1, rightStyle, rightInk);
  }
}

/**
 * Whether the corner two sides meet at is cut on its diagonal, each side
 * taking its half (CSS Backgrounds 3, 4.3): where both have a width, they
 * are painted in different colours or only one is painted at all, and each
 * is solid or unpainted. Sides of one colour make the same corner either
 * way, and so does a corner of a single pixel, which is left to the side
 * that has it.
 */
function mitred(
  a: number,
  b: number,
  inkA: string | null,
  inkB: string | null,
  styleA: ComputedStyle['borderTopStyle'],
  styleB: ComputedStyle['borderTopStyle'],
): boolean {
  if (!(a > 0 && b > 0) || (a <= 1 && b <= 1) || inkA === inkB) return false;
  return (
    (inkA === null || styleA === 'solid') &&
    (inkB === null || styleB === 'solid')
  );
}

/**
 * Fill a convex polygon, its corners as `x, y` pairs, cut to `area`: the
 * part of it near what is painted, which is what keeps a side thousands of
 * pixels long inside X's coordinates. Cut edge by edge rather than by
 * moving its corners in, which would turn a diagonal that crosses the
 * painted area: a slanted divider, `border-left: 100vw solid transparent`,
 * has a corner far outside it.
 */
function fillPolygon(
  ctx: PaintContext,
  points: number[],
  area: { x: number; y: number; w: number; h: number },
): void {
  const bounds = [area.x, area.y, area.x + area.w, area.y + area.h];
  let cut = points;
  // each edge of the area in turn: what is inside it is kept, and an edge
  // of the polygon that crosses it ends on it (Sutherland–Hodgman)
  for (let edge = 0; edge < 4 && cut.length; edge += 1) {
    const axis = edge & 1;
    const bound = bounds[edge];
    const sign = edge < 2 ? 1 : -1;
    const from = cut;
    cut = [];
    for (let i = 0; i < from.length; i += 2) {
      const j = (i + 2) % from.length;
      const da = sign * (from[i + axis] - bound);
      const db = sign * (from[j + axis] - bound);
      if (da >= 0) cut.push(from[i], from[i + 1]);
      if (da < 0 !== db < 0) {
        const k = da / (da - db);
        const other =
          from[i + 1 - axis] + (from[j + 1 - axis] - from[i + 1 - axis]) * k;
        if (axis) cut.push(other, bound);
        else cut.push(bound, other);
      }
    }
  }
  if (cut.length < 6) return;
  ctx.beginPath!();
  ctx.moveTo!(cut[0], cut[1]);
  for (let i = 2; i < cut.length; i += 2) ctx.lineTo!(cut[i], cut[i + 1]);
  ctx.closePath?.();
  ctx.fill!();
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
        else if (typeof source !== 'string') {
          const paint = gradientFill(sctx, source, 0, 0, w, h, box.style.color);
          if (paint) fillGradient(sctx, paint, { x: 0, y: 0, w, h });
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

const GRADIENT_KEYS = new WeakMap<Gradient, string>();

/** A gradient as a key for what is drawn of it: its angle and stops, and
 *  the colour `currentColor` among them is. */
function gradientKey(gradient: Gradient, color: string): string {
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
  const ring = cutRing(
    options,
    x,
    y,
    w,
    h,
    corners,
    box.borderTop,
    box.borderRight,
    box.borderBottom,
    box.borderLeft,
  );
  if (!ring) return true;
  const { outer, inner } = ring;
  ctx.fillStyle = inkColor(color, s.color);
  fillRing(
    ctx,
    outer.rect,
    outer.corners,
    inner ? inner.rect : { x: 0, y: 0, width: 0, height: 0 },
    inner ? inner.corners : outer.corners,
  );
  return true;
}

/** A rectangle and the radii of its corners. */
interface Rounded {
  rect: Rect;
  corners: Corners;
}

/**
 * A rounded box's ring — its border edge and its padding edge, the box
 * inside its borders — cut to the neighbourhood of what is being painted,
 * as `clampRect` cuts a rectangle. Both edges are the box's own, cut to
 * one window, so what is left is the part of the true ring in it. Cutting
 * the box first and insetting the cut by the borders put the hole a
 * border's width in from the cut rather than from the box's edge, and left
 * none where a border was wider than `CLAMP_PAD`: the ring filled whatever
 * of the box a paint reached. A cut is straight, so a side of the window
 * is moved out past any corner's curve it would cross, and a corner on a
 * side the window cut is square, its curve being outside. Null where the
 * ring has nothing in the window.
 */
function cutRing(
  options: PaintOptions,
  x: number,
  y: number,
  w: number,
  h: number,
  corners: Corners,
  top: number,
  right: number,
  bottom: number,
  left: number,
): { outer: Rounded; inner: Rounded | null } | null {
  const { x: cx, y: cy } = corners;
  // where each corner's curve runs, across and down — the padding edge's
  // run inside the border edge's
  const across: [number, number][] = [
    [x, x + cx[0]],
    [x + w - cx[1], x + w],
    [x + w - cx[2], x + w],
    [x, x + cx[3]],
  ];
  const down: [number, number][] = [
    [y, y + cy[0]],
    [y, y + cy[1]],
    [y + h - cy[2], y + h],
    [y + h - cy[3], y + h],
  ];
  const d = options.damage;
  const side = (at: number, spans: [number, number][], towards: number) =>
    Math.max(
      -COORD_LIMIT,
      Math.min(COORD_LIMIT, outOfSpans(at, spans, towards)),
    );
  const x0 = side(d ? d.x - CLAMP_PAD : -COORD_LIMIT, across, -1);
  const y0 = side(d ? d.y - CLAMP_PAD : -COORD_LIMIT, down, -1);
  const x1 = side(d ? d.x + d.width + CLAMP_PAD : COORD_LIMIT, across, 1);
  const y1 = side(d ? d.y + d.height + CLAMP_PAD : COORD_LIMIT, down, 1);
  const cut = (
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    c: Corners,
  ): Rounded | null => {
    const l = Math.max(rx, x0);
    const t = Math.max(ry, y0);
    const r = Math.min(rx + rw, x1);
    const b = Math.min(ry + rh, y1);
    if (r <= l || b <= t) return null;
    // the corners of the sides the window left where they were
    const kept = [
      t === ry && l === rx,
      t === ry && r === rx + rw,
      b === ry + rh && r === rx + rw,
      b === ry + rh && l === rx,
    ];
    return {
      rect: { x: l, y: t, width: r - l, height: b - t },
      corners: {
        x: c.x.map((v, i) => (kept[i] ? v : 0)) as Corners['x'],
        y: c.y.map((v, i) => (kept[i] ? v : 0)) as Corners['y'],
      },
    };
  };
  const outer = cut(x, y, w, h, corners);
  if (!outer) return null;
  const iw = w - left - right;
  const ih = h - top - bottom;
  const inner =
    iw > 0 && ih > 0
      ? cut(
          x + left,
          y + top,
          iw,
          ih,
          insetCorners(corners, top, right, bottom, left),
        )
      : null;
  // a window inside the padding edge, where the ring has nothing
  if (inner && sameRounded(outer, inner)) return null;
  return { outer, inner };
}

/** A position moved out of any of `spans` it is inside, towards their
 *  starts where `towards` is negative and their ends where it is not. */
function outOfSpans(
  at: number,
  spans: readonly [number, number][],
  towards: number,
): number {
  for (let moved = true; moved;) {
    moved = false;
    for (const [from, to] of spans) {
      if (at > from && at < to) {
        at = towards < 0 ? from : to;
        moved = true;
      }
    }
  }
  return at;
}

/** Whether two rounded rectangles are one shape. */
function sameRounded(a: Rounded, b: Rounded): boolean {
  return (
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height &&
    a.corners.x.every((v, i) => v === b.corners.x[i]) &&
    a.corners.y.every((v, i) => v === b.corners.y[i])
  );
}

/**
 * Clip to what a box's border paints, for a layer of `background-clip:
 * border-area` (CSS Backgrounds 4, 2.1): each side's width and style, and
 * not its colour — a transparent border still has an area, which is what
 * the value is for. The shapes are the border painter's own, so that the
 * background shows exactly where that border would: the ring `roundedRing`
 * fills where a rounded border is solid, the ring the trapezoids of a 3D
 * style make, and otherwise the rectangles `fillSide` fills a side at a
 * time — the dots, the dashes, the two lines of a double border joined as
 * they are painted, by the sides' colours though neither is drawn. All of
 * them run clockwise and a ring's inside the other way, so the clip is the
 * union by the non-zero rule, the one every context's `clip` takes. Each
 * is placed from the box's edges and then cut to the painted area: placed
 * from the cut, a border wider than `CLAMP_PAD` put its bands and its
 * ring's hole a border's width in from wherever the paint was cut, and
 * the background was painted over the content of a box repainted in part.
 * False where the border paints nothing in the painted area or the context
 * cannot clip, and nothing is pushed.
 */
function pushBorderArea(
  ctx: PaintContext,
  box: Frame,
  options: PaintOptions,
): boolean {
  const t = box.borderTop;
  const r = box.borderRight;
  const b = box.borderBottom;
  const l = box.borderLeft;
  if (!(t || r || b || l) || !ctx.beginPath || !ctx.rect || !ctx.clip) {
    return false;
  }
  const s = box.style;
  const left = box.x + options.originX;
  const top = frameY(box) + options.originY;
  const x = Math.round(left);
  const y = Math.round(top);
  const w = Math.round(left + box.width) - x;
  const h = Math.round(top + frameHeight(box)) - y;
  if (w <= 0 || h <= 0) return false;
  if (!clampRect(options, x, y, w, h)) return false;
  const corners = cornersOf(s, w, h);
  ctx.save();
  ctx.beginPath();
  // how many shapes the path has: none, and the border paints nothing here
  let shapes = 0;
  if (corners && canCurve(ctx) && solidBorder(box)) {
    const ring = cutRing(options, x, y, w, h, corners, t, r, b, l);
    if (ring) {
      const add = ({ rect, corners: c }: Rounded, hole: boolean): void =>
        roundedRect(
          ctx,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          c,
          true,
          hole,
        );
      add(ring.outer, false);
      // the padding edge run the other way, which cuts it out
      if (ring.inner) add(ring.inner, true);
      shapes = 1;
    }
  } else {
    // A side at a time, from the box's edges and cut to the painted area
    // after: a 3D side as a band, which the trapezoids cover between them,
    // and any other as `fillSide` fills it.
    const path = {
      fillRect(ex: number, ey: number, ew: number, eh: number) {
        ctx.rect!(ex, ey, ew, eh);
        shapes += 1;
      },
    };
    const widths = [t, r, b, l];
    const joins = doubleJoins(box);
    const styles: ComputedStyle['borderTopStyle'][] = sculpted(s)
      ? ['solid', 'solid', 'solid', 'solid']
      : [
          s.borderTopStyle,
          s.borderRightStyle,
          s.borderBottomStyle,
          s.borderLeftStyle,
        ];
    for (let at = 0; at < 4; at += 1) {
      if (widths[at] > 0) {
        fillSide(path, options, at, x, y, w, h, widths, styles[at], joins);
      }
    }
  }
  if (!shapes) {
    ctx.restore();
    return false;
  }
  ctx.clip();
  return true;
}

/** Whether every side a box has a border on is solid, which a rounded box
 *  draws as one ring (`roundedRing`). */
function solidBorder(box: Frame): boolean {
  const s = box.style;
  return (
    (!box.borderTop || s.borderTopStyle === 'solid') &&
    (!box.borderRight || s.borderRightStyle === 'solid') &&
    (!box.borderBottom || s.borderBottomStyle === 'solid') &&
    (!box.borderLeft || s.borderLeftStyle === 'solid')
  );
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
 * colour. The trapezoids are cut to the painted area (`fillPolygon`), which
 * keeps a long box's far corners out of X's coordinates and a join on its
 * diagonal: its corners clamped in, a border wider than `CLAMP_PAD` turned
 * the join to cross the damage at 45° wherever it was, and a scrolled
 * strip smeared the corners of a thick one. False where the context cannot
 * draw a path, and the sides are drawn straight.
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
    fillPolygon(ctx, points, area);
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

/**
 * One side of a border box at `x, y`, `w` by `h` — `at` counts the top
 * first and clockwise — as rectangles cut to what the paint reaches: the
 * top and the bottom the width of the box and the left and the right
 * between them, so a corner is a square of one side or the other.
 *
 * A double side is two lines, a band each along its outer and its inner
 * edge. Where it meets another double side of its colour (`joins`, the
 * top left corner first) the lines of the two meet as two frames do, one
 * inside the other (CSS Backgrounds 3, 4.2 and 4.3): the outer line of the
 * left or the right runs on to the outer line of the top or the bottom,
 * and the inner line of the top or the bottom stops at the inner line of
 * the side. With square corners the outer frame was open at each of them
 * and the inner line of the top ran on past the side's to the border edge.
 * Each line is cut to the paint on its own, so a border wider than the
 * reach around the paint keeps its lines at its edges, and not at the
 * edges of the part of it cut out.
 */
function fillSide(
  ctx: Pick<FillContext, 'fillRect'>,
  options: PaintOptions,
  at: number,
  x: number,
  y: number,
  w: number,
  h: number,
  widths: readonly number[],
  style: ComputedStyle['borderTopStyle'],
  joins: readonly boolean[],
): void {
  const [t, r, b, l] = widths;
  const width = widths[at];
  const horizontal = (at & 1) === 0;
  if (style === 'double' && width >= 3) {
    const band = doubleBand(width);
    const line = (lx: number, ly: number, lw: number, lh: number): void => {
      const rect = clampRect(options, lx, ly, lw, lh);
      if (rect) ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    };
    if (horizontal) {
      // the outer line the width of the box, and the inner one from the
      // inner line of a side it joins, or from the edge of the box
      const from = joins[at === 0 ? 0 : 3] ? x + l - doubleBand(l) : x;
      const to = joins[at === 0 ? 1 : 2] ? x + w - r + doubleBand(r) : x + w;
      line(x, at === 0 ? y : y + h - band, w, band);
      line(from, at === 0 ? y + t - band : y + h - b, to - from, band);
    } else {
      // the outer line from the outer line of a side it joins, or from
      // that side's inner edge, and the inner one between the two sides
      const from = joins[at === 3 ? 0 : 1] ? y + doubleBand(t) : y + t;
      const to = joins[at === 3 ? 3 : 2] ? y + h - doubleBand(b) : y + h - b;
      line(at === 3 ? x : x + w - band, from, band, to - from);
      line(at === 3 ? x + l - band : x + w - r, y + t, band, h - t - b);
    }
    return;
  }
  const ex = at === 1 ? x + w - r : x;
  const ey = at === 0 ? y : at === 2 ? y + h - b : y + t;
  const rect = horizontal
    ? clampRect(options, ex, ey, w, width)
    : clampRect(options, ex, ey, width, h - t - b);
  // The un-clamped start is the dash phase's origin, so the pattern does
  // not crawl as the viewport moves along a long edge.
  if (rect) fillEdge(ctx, rect, horizontal ? ex : ey, style, horizontal);
}

/**
 * The corners of a box where two double sides of one colour meet, the top
 * left first and clockwise, and whose lines `fillSide` joins. By the
 * colours as written, a transparent one included, which is how a clip to
 * the border's area draws the border it does not paint.
 */
function doubleJoins(box: Frame): readonly boolean[] {
  const s = box.style;
  const color = (
    width: number,
    style: ComputedStyle['borderTopStyle'],
    value: string,
  ): string | null =>
    style === 'double' && width >= 3 ? inkColor(value, s.color) : null;
  const top = color(box.borderTop, s.borderTopStyle, s.borderTopColor);
  const bottom = color(
    box.borderBottom,
    s.borderBottomStyle,
    s.borderBottomColor,
  );
  if (top === null && bottom === null) return UNJOINED;
  const right = color(box.borderRight, s.borderRightStyle, s.borderRightColor);
  const left = color(box.borderLeft, s.borderLeftStyle, s.borderLeftColor);
  return [
    top !== null && top === left,
    top !== null && top === right,
    bottom !== null && bottom === right,
    bottom !== null && bottom === left,
  ];
}

const UNJOINED: readonly boolean[] = [false, false, false, false];

/** How wide each of a double border's two lines is, the gap between them
 *  what is left of the side. */
function doubleBand(thickness: number): number {
  return Math.max(1, Math.floor(thickness / 3));
}

function fillEdge(
  ctx: Pick<FillContext, 'fillRect'>,
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
    const band = doubleBand(thickness);
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
 *  box's `color`, as an icon's is the text's around it, and what it is
 *  painted with the box's `fill` and `stroke`, where the document's style
 *  sheets set them: an icon set's `.icon { fill: currentColor }`. What
 *  they give a shape inside it is asked for here (`BoxTree.shapeStyler`). */
function paintSvg(ctx: PaintContext, box: Box, options: PaintOptions): void {
  if (!box.el) return;
  const x = Math.round(box.contentX + options.originX);
  const y = Math.round(box.contentY + options.originY);
  const w = Math.round(box.contentX + options.originX + box.contentWidth) - x;
  const h = Math.round(box.contentY + options.originY + box.contentHeight) - y;
  const style = box.style;
  const paint = (value: string | null): string | null =>
    value === null || value === 'currentColor' || value === 'none'
      ? value
      : inkColor(value, style.color);
  inlineDrawing(box.el).draw(
    ctx,
    x,
    y,
    w,
    h,
    options.scale ?? 1,
    style.color,
    paint(style.fill),
    paint(style.stroke),
    options.shapeStyler?.(box) ?? null,
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
    // and a line whose glyphs, or an atomic on it, reach past it
    // (`LINE_INK`) is drawn where they reach
    const ink = LINE_INK.get(lines);
    const above = ink?.above ?? 0;
    const below = ink?.below ?? 0;
    const slack = top - box.maxLineHeight - below;
    // the lines columns took apart are in no order down the page
    const apart = columned.any && COLUMN_LINES.has(lines);
    while (!apart && lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].y > slack) hi = mid;
      else lo = mid + 1;
    }
    for (let i = lo; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.y - above >= bottom) {
        if (apart) continue;
        break;
      }
      if (line.y < bottom && line.y + line.height > top) visible.push(line);
      else if (ink && inkInto(line, top, bottom)) {
        visible.push(line);
      }
    }
    // and a line the damage misses whose text or inline-block `position:
    // relative` moved into it: drawn by its line, it went undrawn with it
    const moved = MOVED_OFF_LINES.get(lines);
    if (moved && reachedOff(visible, moved, top, bottom)) {
      const drawn = new Set(visible);
      for (const line of moved) {
        if (inkInto(line, top, bottom)) drawn.add(line);
      }
      visible.length = 0;
      for (const line of lines) if (drawn.has(line)) visible.push(line);
    }
  } else {
    visible.push(...lines);
  }
  if (!visible.length) return;

  const bleeds: Bleed[] = [];
  for (const line of visible) {
    if (line.background) paintLineBackground(ctx, line, options);
    paintInlineBoxes(
      ctx,
      line,
      lines,
      options,
      line === lines[0] ? null : bleeds,
    );
    for (const text of line.texts) {
      const natural = text.layout.lines[text.layoutLine];
      if (!natural) continue;
      for (const laid of [natural, trailOf(text, natural)]) {
        if (!laid) continue;
        paintRunBackgrounds(
          ctx,
          laid,
          text.drawX + dx,
          text.drawY + dy,
          options.scale ?? 1,
        );
      }
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
  // text a `::selection` colours is drawn in that colour where selected
  const recolored = options.selectionStyler
    ? recoloredBands(visible, options)
    : null;
  for (const line of visible) {
    for (const text of line.texts) {
      // once for each column its lines are in, where they are in several
      const rows = columned.any ? COLUMN_ROWS.get(text) : undefined;
      if (drawn.has(rows ?? text.layout)) continue;
      drawn.add(rows ?? text.layout);
      const top = text.drawY + dy;
      if (top < -COORD_LIMIT || top + text.layout.height > COORD_LIMIT) {
        // A single layout so tall its own lines overflow the Int16 envelope
        // — a one-paragraph document tens of thousands of pixels high. The
        // element scrolling itself (phase 2, see the PRD) is the real
        // answer; until then the overflowing batch is skipped rather than
        // thrown from the protocol encoder.
        continue;
      }
      const bands = recolored?.get(text.layout);
      const clipped =
        rows !== undefined && clipToRows(ctx, text, rows, text.drawX + dx, top);
      if (bands) drawRecolored(ctx, text.layout, text.drawX + dx, top, bands);
      else text.layout.draw(ctx, text.drawX + dx, top);
      if (clipped) ctx.restore();
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
      if (turns(placed.box)) paintTransformed(ctx, placed.box, options);
      else paintBox(ctx, placed.box, options);
    }
  }
}

/** Whether any of the lines moved content was taken off, and the damage
 *  does not already draw, has it within the damage's rows. */
function reachedOff(
  visible: readonly LineBox[],
  moved: ReadonlySet<LineBox>,
  top: number,
  bottom: number,
): boolean {
  for (const line of moved) {
    if (!visible.includes(line) && inkInto(line, top, bottom)) return true;
  }
  return false;
}

/** Whether what a line draws — its inline-blocks and images, where their
 *  ink is, and its texts, where they are drawn, their glyphs from ascent to
 *  descent — reaches the rows between `top` and `bottom`: what was moved off
 *  it, and what hangs past it. */
function inkInto(line: LineBox, top: number, bottom: number): boolean {
  for (const placed of line.atomics) {
    const box = placed.box;
    if (box.boundsY < bottom && box.boundsY + box.boundsHeight > top) {
      return true;
    }
  }
  for (const text of line.texts) {
    const natural = text.layout.lines[text.layoutLine];
    if (!natural) continue;
    const baseline = text.drawY + natural.baseline;
    const y1 = Math.min(
      text.drawY + natural.y,
      baseline - (natural.ascent ?? 0),
    );
    const y2 = Math.max(
      text.drawY + natural.y + natural.height,
      baseline + (natural.descent ?? 0),
    );
    if (y1 < bottom && y2 > top) return true;
  }
  return false;
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
    paintLayers(ctx, fragment, options, frameImages(ctx, fragment, options));
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
        (image): image is Gradient =>
          image !== null && typeof image !== 'string',
      ) ||
        null);
    let fill: unknown = null;
    // where the fill is a picture of the gradient, the corner it starts at
    let origin: { x: number; y: number } | null = null;
    if (gradient) {
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
      const paint = gradientFill(
        ctx,
        gradient,
        area.x,
        area.y,
        area.width,
        area.height,
        style.color,
        x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null,
      );
      if (paint?.matrix) {
        // An ellipse is a circle filled through a matrix, which would draw
        // the glyphs through it too: they are filled with a picture of the
        // gradient instead, drawn once at the area's size
        const left = Math.round(area.x);
        const top = Math.round(area.y);
        const w = Math.max(1, Math.round(area.x + area.width) - left);
        const h = Math.max(1, Math.round(area.y + area.height) - top);
        const picture =
          ctx.createPattern && ctx.translate
            ? options.cached?.(
                `clip-text|${gradientKey(gradient, style.color)}|${w}x${h}`,
                w,
                h,
                (sctx) => {
                  const p = gradientFill(
                    sctx,
                    gradient,
                    0,
                    0,
                    w,
                    h,
                    style.color,
                  );
                  if (p) fillGradient(sctx, p, { x: 0, y: 0, w, h });
                },
              )
            : null;
        if (!picture) continue;
        fill = ctx.createPattern!(picture, 'no-repeat');
        origin = { x: left, y: top };
      } else if (paint) fill = paint.style;
    }
    if (fill === null && !isTransparent(style.backgroundColor)) {
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
      if (origin) {
        // a pattern is placed from the origin of the space it fills
        ctx.translate!(origin.x, origin.y);
        inkless.draw(ctx, part.x - origin.x, part.y - origin.y);
      } else inkless.draw(ctx, part.x, part.y);
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
        // every run casts the same: the layout's once for each shadow, in
        // each column its lines are in
        const rows = columned.any ? COLUMN_ROWS.get(text) : undefined;
        if (whole.has(rows ?? layout)) continue;
        whole.add(rows ?? layout);
        const clipped =
          rows !== undefined && clipToRows(ctx, text, rows, left, top);
        castShadows(ctx, text, left, top, cast, null);
        if (clipped) ctx.restore();
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
      if (!natural) continue;
      for (const laid of [natural, trailOf(text, natural)]) {
        if (!laid) continue;
        paintRunRules(
          ctx,
          laid,
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
 * The spaces a text ends on where its line goes on after them
 * (`LineText.trail`), as a line of one run to draw the decorations of: the
 * run they are the end of, as wide as they are, after the line's content.
 * The engine stripped them from the piece it laid out as a line, and a
 * link's underline stopped at its last letter, a space short of where a
 * browser draws it. Null where the text has none, or reads right to left.
 */
function trailOf<L extends LineText['layout']['lines'][number]>(
  text: LineText,
  natural: L,
): L | null {
  if (!text.trail || !text.trailRun) return null;
  const last = natural.runs[natural.runs.length - 1];
  if (!last || last.run?.direction === 'rtl') return null;
  return {
    ...natural,
    runs: [
      { ...last, x: natural.width, width: text.trail, span: text.trailRun },
    ],
  };
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

/**
 * The fragments of the decorated inline boxes on a line: how far across it
 * each reaches, its border box, and whether the box opens or closes on it.
 * Where the line holds text `position: relative` moved, taken where the
 * text was: a fragment is moved by its own box's offset.
 *
 * A box is more than one fragment on a line where bidi reordering puts
 * what is not the box's between parts of it (CSS 2.1 9.10): a letter of
 * another element, an atomic, another element's edge. Its parts are one
 * fragment wherever nothing else comes between them, whatever room is
 * between them — a space it hangs, a box of its own inside it — so a line
 * that reads one way has one fragment of each box, as it always had.
 */
function fragmentsOn(line: LineBox): Map<Box, InlineFragment[]> | null {
  /** What is on the line, where, and which decorated boxes it is in. */
  const marks: {
    left: number;
    right: number;
    boxes: readonly Box[];
    /** An edge's own box, whose fragment it opens or closes. */
    edge?: EdgePlacement;
  }[] = [];
  const shifted = SHIFTED_LINES.has(line);
  for (const text of line.texts) {
    const natural = text.layout.lines[text.layoutLine];
    const boxAt = text.spans.boxAt;
    if (!natural || !boxAt) continue;
    const shift = shifted ? TEXT_SHIFTS.get(text) : undefined;
    const x = text.drawX - (shift?.x ?? 0) + natural.x;
    for (const run of natural.runs) {
      const owner = boxAt.call(text.spans, run.start);
      if (!owner) continue;
      // Within the line: a space a line ends on hangs past it, and CoreText
      // keeps it in the run it ends even where the line's width does not.
      const left = Math.max(x, x + run.x);
      const right = Math.min(x + natural.width, x + run.x + run.width);
      if (right <= left) continue;
      marks.push({ left, right, boxes: decoratedAncestors(owner) });
    }
    // and the spaces `pre-wrap` keeps that the line ends on, which hang
    // past it and are their box's all the same (`LineText.hung`)
    for (const space of text.hung ?? []) {
      const owner = boxAt.call(text.spans, space.at);
      if (!owner) continue;
      const left = text.drawX - (shift?.x ?? 0) + space.x;
      marks.push({
        left,
        right: left + space.width,
        boxes: decoratedAncestors(owner),
      });
    }
  }
  for (const placed of line.atomics) {
    const atomic = placed.box;
    marks.push({
      left: placed.x - atomic.marginLeft,
      right: placed.x + atomic.width + atomic.marginRight,
      boxes: decoratedAncestors(atomic),
    });
  }
  for (const edge of line.edges ?? []) {
    marks.push({
      left: edge.x,
      right: edge.x + edge.width,
      boxes: decoratedAncestors(edge.box),
      edge,
    });
  }
  let fragments: Map<Box, InlineFragment[]> | null = null;
  // each box's parts, left to right
  const parts = new Map<Box, typeof marks>();
  for (const mark of marks) {
    for (const box of mark.boxes) {
      let list = parts.get(box);
      if (!list) parts.set(box, (list = []));
      list.push(mark);
    }
    const own = mark.edge?.box;
    if (own?.decoration) {
      let list = parts.get(own);
      if (!list) parts.set(own, (list = []));
      list.push(mark);
    }
  }
  for (const [box, list] of parts) {
    list.sort((a, b) => a.left - b.left || a.right - b.right);
    const out: InlineFragment[] = [];
    let open: InlineFragment | null = null;
    let reach = -Infinity;
    for (const mark of list) {
      // The element's `direction` says which side its start is on, whatever
      // its text reads as (CSS 2.1 8.6); its own edge's margin is outside
      // the box, its border and padding inside.
      let left = mark.left;
      let right = mark.right;
      const own = mark.edge?.box === box ? mark.edge : null;
      if (own) {
        const onLeft =
          (own.side === 'start') !== (box.style.direction === 'rtl');
        if (onLeft) left = right = own.x + box.marginLeft;
        else left = right = own.x + own.width - box.marginRight;
      }
      if (!open || between(marks, box, reach, mark.left)) {
        open = { left, right, start: false, end: false };
        out.push(open);
      } else {
        open.left = Math.min(open.left, left);
        open.right = Math.max(open.right, right);
      }
      reach = Math.max(reach, mark.right);
      if (own) {
        if (own.side === 'start') open.start = true;
        else open.end = true;
      }
    }
    (fragments ??= new Map()).set(box, out);
  }
  return fragments;
}

/** Whether anything on a line that is not in a box lies between two of its
 *  parts, from `left` to `right`: what splits it into two fragments. */
function between(
  marks: readonly {
    left: number;
    right: number;
    boxes: readonly Box[];
    edge?: EdgePlacement;
  }[],
  box: Box,
  left: number,
  right: number,
): boolean {
  if (right - left < 0.5) return false;
  for (const mark of marks) {
    if (mark.right - mark.left < 0.5) continue;
    if (mark.boxes.includes(box) || mark.edge?.box === box) continue;
    const middle = (mark.left + mark.right) / 2;
    if (middle > left && middle < right) return true;
  }
  return false;
}

function paintInlineBoxes(
  ctx: PaintContext,
  line: LineBox,
  /** The block's lines, which `line` is one of. */
  lines: readonly LineBox[],
  options: PaintOptions,
  /** Where a fragment that reaches up over the lines before goes, to be
   *  drawn again over their text; null for a block's first line. */
  bleeds: Bleed[] | null = null,
): void {
  const fragments = fragmentsOn(line);
  if (!fragments) return;
  // Every text on a line is drawn on one baseline (`finishLine`), and an
  // engine's is from the top of its layout rather than of the line. Taken
  // where the line has each text: a box `position: relative` moves is
  // moved by its own offset below, and the boxes around it are not.
  let baseline = line.y + line.baseline;
  const shifted = SHIFTED_LINES.has(line);
  for (const text of line.texts) {
    const natural = text.layout.lines[text.layoutLine];
    if (!natural || !text.spans.boxAt) continue;
    const shift = shifted ? TEXT_SHIFTS.get(text) : undefined;
    const raise = shifted ? (TEXT_RAISES.get(text) ?? 0) : 0;
    baseline = text.drawY - (shift?.y ?? 0) + raise + natural.baseline;
  }
  const boxes = [...fragments.keys()].sort((a, b) => depthOf(a) - depthOf(b));
  for (const box of boxes) {
    if (box.style.visibility !== 'visible') continue;
    for (const f of fragments.get(box)!) {
      paintInlineFragment(ctx, line, lines, options, bleeds, box, f, baseline);
    }
  }
}

/** One fragment of an inline box on a line (`paintInlineBoxes`). */
function paintInlineFragment(
  ctx: PaintContext,
  line: LineBox,
  lines: readonly LineBox[],
  options: PaintOptions,
  bleeds: Bleed[] | null,
  box: Box,
  f: InlineFragment,
  baseline: number,
): void {
  const shifted = SHIFTED_LINES.has(line);
  {
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
    if (fragment.width <= 0) return;
    // its images and gradients from the strip its fragments make, where it
    // goes on to another line, and from its own padding box where it is
    // on this one alone or `clone` says each fragment is its own
    if (!(f.start && f.end) && sliced(box.style)) {
      const strip = stripFor(lines, line, box, fragment);
      if (strip) fragment.strip = strip;
    }
    paintLayers(ctx, fragment, options, frameImages(ctx, fragment, options));
    paintBorders(ctx, fragment, options);
    if (box.style.outlineStyle !== 'none') paintOutline(ctx, fragment, options);
    if (bleeds && fragment.y < line.y - 0.5) {
      bleeds.push({ fragment, lineTop: line.y + (moved?.y ?? 0) });
    }
  }
}

/** Whether an inline box places background images or gradients, which
 *  `slice` places across its fragments, as one box end to end. */
function sliced(style: ComputedStyle): boolean {
  return (
    style.boxDecorationBreak === 'slice' &&
    (style.backgroundImage !== null ||
      style.backgroundGradient !== null ||
      style.backgroundImages !== null)
  );
}

/** Where an inline box's fragments sit along the strip they make laid end
 *  to end: how wide it is, on how many lines, and how far along it each
 *  line's fragment starts, in the box's direction. */
interface Strip {
  width: number;
  lines: number;
  before: Map<LineBox, number>;
}

/** Of a block's lines, by the array they are, the strip of each inline box
 *  on them that `sliced` says places images across its fragments: made
 *  once a layout, as `MOVED_OFF_LINES` is, so a repaint of one line reads
 *  the lines before it without going over them again. What `sliced` reads
 *  is never restyled in place (`HtmlViewNode`), which lays the lines out
 *  again instead. */
const STRIPS = new WeakMap<readonly LineBox[], Map<Box, Strip>>();

function stripsOf(lines: readonly LineBox[]): Map<Box, Strip> {
  const strips = new Map<Box, Strip>();
  for (const line of lines) {
    const fragments = fragmentsOn(line);
    if (!fragments) continue;
    for (const [box, list] of fragments) {
      if (!sliced(box.style)) continue;
      let strip = strips.get(box);
      if (!strip) {
        strip = { width: 0, lines: 0, before: new Map() };
        strips.set(box, strip);
      }
      strip.before.set(line, strip.width);
      for (const f of list) strip.width += Math.max(0, f.right - f.left);
      strip.lines += 1;
    }
  }
  return strips;
}

/**
 * The box an inline box's fragment on `line` is a slice of (CSS
 * Fragmentation 3, 5.4): the box's fragments laid end to end in its
 * direction, as though it had not wrapped — as wide as
 * they are together, with the box's own borders and padding at its two
 * ends, placed so that this fragment is where it falls along it. So an
 * image `no-repeat` at the start is on the first fragment alone, and a
 * gradient runs once across them all. Undefined where the box is on one
 * line.
 */
function stripFor(
  lines: readonly LineBox[],
  line: LineBox,
  box: Box,
  fragment: Frame,
): Frame | undefined {
  let strips = STRIPS.get(lines);
  if (!strips) {
    strips = stripsOf(lines);
    STRIPS.set(lines, strips);
  }
  const strip = strips.get(box);
  const before = strip?.before.get(line);
  if (!strip || strip.lines < 2 || before === undefined) return undefined;
  const x =
    box.style.direction === 'rtl'
      ? fragment.x + fragment.width + before - strip.width
      : fragment.x - before;
  return {
    ...fragment,
    x,
    width: strip.width,
    borderLeft: box.borderLeft,
    borderRight: box.borderRight,
    padLeft: box.padLeft,
    padRight: box.padRight,
  };
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

/** A restyle in place (a `:hover`) gave an inline box a decoration where it
 *  had none, or took it away, and the lists kept above do not know: every
 *  box whose list could name it — inside it, through the inline boxes the
 *  walk above climbs — looks again. A document built again has new boxes,
 *  and so no lists. */
export function forgetDecoratedAncestors(box: Box): void {
  const stack = [...box.children];
  while (stack.length) {
    const at = stack.pop()!;
    DECORATED.delete(at);
    if (at.kind === 'inline') stack.push(...at.children);
  }
}

/**
 * The band the document selection covers on one line.
 *
 * Translucent under the glyphs rather than inverted over them, so the ink
 * keeps its contrast on either palette — the same call `<textarea>` and
 * `<richtext>` both make. From the top of the line to its bottom, and past
 * them over the glyphs where they are taller than the line (`selectionRows`).
 */
function paintSelection(
  ctx: PaintContext,
  line: LineBox,
  options: PaintOptions,
): void {
  for (const band of selectedBands(line, options)) {
    const fill = band.style ? band.style.background : options.selectionColor;
    if (!fill || isTransparent(fill)) continue;
    ctx.fillStyle = fill;
    ctx.fillRect(band.x, band.y, band.width, band.height);
  }
}

/** A stretch of selected text on one line, in window pixels, and the
 *  `::selection` of the element it is in: null for the palette's. */
interface SelectedBand extends Rect {
  style: SelectionStyle | null;
  /** The layout whose text it is. */
  layout: unknown;
}

const NO_BANDS: SelectedBand[] = [];

/**
 * Where the document selection covers a line's text, a band for each
 * stretch of it one `::selection` styles, in window pixels as the band is
 * filled — rounded, so a band's text is drawn to its edges and no further
 * (`drawRecolored`).
 */
function selectedBands(line: LineBox, options: PaintOptions): SelectedBand[] {
  const range = options.selection;
  if (!range || range.end <= range.start) return NO_BANDS;
  if (line.textEnd <= range.start || line.textStart >= range.end) {
    return NO_BANDS;
  }
  const styler = options.selectionStyler;
  const out: SelectedBand[] = [];
  for (const text of line.texts) {
    const natural = text.layout.lines[text.layoutLine];
    if (!natural) continue;
    const from = Math.max(range.start, text.textStart);
    const to = Math.min(range.end, text.textEnd);
    if (to <= from) continue;
    const offsets = layoutOffsets(text.layout);
    const layoutFrom = layoutOffsetOf(text, from);
    const layoutTo = layoutOffsetOf(text, to, true);
    const rows = selectionRows(line, text, natural);
    const y = Math.round(rows.y + options.originY);
    const height = Math.ceil(rows.height);
    const pieces = styler
      ? stylePieces(text, natural, layoutFrom, layoutTo, styler)
      : [{ from: layoutFrom, to: layoutTo, style: null }];
    for (const piece of pieces) {
      for (const band of lineBands(
        text.layout,
        natural,
        offsets,
        piece.from,
        piece.to,
      )) {
        out.push({
          x: Math.round(band.x + text.drawX + options.originX),
          y,
          width: Math.ceil(band.width),
          height,
          style: piece.style,
          layout: text.layout,
        });
      }
    }
  }
  return out;
}

/**
 * A line's selected text, `from` to `to` in the layout's offsets, cut where
 * the `::selection` over it changes: a run's is its element's, and a run of
 * no element's — an inline box's edge, laid out as a spacer — the one
 * beside it, so a styled band has no palette-coloured gap at a `<span>`.
 */
function stylePieces(
  text: LineText,
  natural: LineText['layout']['lines'][number],
  from: number,
  to: number,
  styler: SelectionStyler,
): { from: number; to: number; style: SelectionStyle | null }[] {
  const runs = natural.runs
    .filter((run) => run.end > from && run.start < to)
    .sort((a, b) => a.start - b.start);
  const boxAt = text.spans.boxAt;
  const styles: (SelectionStyle | null | undefined)[] = runs.map((run) => {
    const box = boxAt?.call(text.spans, run.start) ?? null;
    return box ? styler(box) : undefined;
  });
  for (let i = 1; i < styles.length; i += 1) {
    if (styles[i] === undefined) styles[i] = styles[i - 1];
  }
  for (let i = styles.length - 2; i >= 0; i -= 1) {
    if (styles[i] === undefined) styles[i] = styles[i + 1];
  }
  const out: { from: number; to: number; style: SelectionStyle | null }[] = [];
  runs.forEach((run, i) => {
    const style = styles[i] ?? null;
    const last = out[out.length - 1];
    if (last && last.style === style) last.to = Math.min(to, run.end);
    else {
      out.push({
        from: Math.max(from, run.start),
        to: Math.min(to, run.end),
        style,
      });
    }
  });
  return out;
}

/**
 * The layouts whose selected text a `::selection` gives a colour of its
 * own, each with the bands it is drawn in that colour (`drawRecolored`).
 * Null where none does, which is every document with no such rule.
 */
function recoloredBands(
  lines: LineBox[],
  options: PaintOptions,
): Map<unknown, SelectedBand[]> | null {
  let out: Map<unknown, SelectedBand[]> | null = null;
  for (const line of lines) {
    for (const band of selectedBands(line, options)) {
      if (!band.style?.color || !(band.width > 0)) continue;
      out ??= new Map();
      const list = out.get(band.layout);
      if (list) list.push(band);
      else out.set(band.layout, [band]);
    }
  }
  return out;
}

/**
 * A layout with some of its text selected in a `::selection`'s colour
 * (CSS Pseudo 4, 3.2): its own colours everywhere but those bands, and in
 * each band the glyphs in that band's colour — cast there as a hard shadow
 * from the layout drawn clear of the window, the way `castShadows` draws a
 * text shadow, since a layout draws in its runs' own colours. Drawn over
 * rather than in place of the text, the old glyphs' edges showed round the
 * new ones. Where the context cannot clip or cast, the text keeps its own
 * colours.
 */
function drawRecolored(
  ctx: PaintContext,
  layout: LineText['layout'],
  left: number,
  top: number,
  bands: SelectedBand[],
): void {
  if (
    !ctx.save ||
    !ctx.restore ||
    !ctx.beginPath ||
    !ctx.rect ||
    !ctx.clip ||
    !('shadowBlur' in ctx)
  ) {
    layout.draw(ctx, left, top);
    return;
  }
  ctx.save();
  ctx.beginPath();
  for (const r of outsideOf(bands)) ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
  layout.draw(ctx, left, top);
  ctx.restore();
  let right = layout.width;
  for (const natural of layout.lines) {
    right = Math.max(right, natural.x + natural.width);
  }
  const shift = Math.ceil(left + right) + 1;
  const colors = new Map<string, SelectedBand[]>();
  for (const band of bands) {
    const color = band.style!.color!;
    const group = colors.get(color);
    if (group) group.push(band);
    else colors.set(color, [band]);
  }
  for (const [color, group] of colors) {
    ctx.save();
    ctx.beginPath();
    for (const r of group) ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    ctx.shadowColor = color;
    ctx.shadowBlur = 0.01;
    ctx.shadowOffsetX = shift;
    ctx.shadowOffsetY = 0;
    layout.draw(ctx, left - shift, top);
    ctx.restore();
  }
}

/** Everything but some rectangles, as rectangles: a strip between each two
 *  of their edges, less what of it they cover. */
function outsideOf(rects: readonly Rect[]): Rect[] {
  const far = COORD_LIMIT;
  const edges = new Set<number>();
  for (const r of rects) {
    edges.add(r.y);
    edges.add(r.y + r.height);
  }
  const ys = [...edges].sort((a, b) => a - b);
  const out: Rect[] = [
    { x: -far, y: -far, width: 2 * far, height: ys[0] + far },
    {
      x: -far,
      y: ys[ys.length - 1],
      width: 2 * far,
      height: far - ys[ys.length - 1],
    },
  ];
  for (let i = 0; i + 1 < ys.length; i += 1) {
    const y0 = ys[i];
    const y1 = ys[i + 1];
    const spans = rects
      .filter((r) => r.y <= y0 && r.y + r.height >= y1)
      .sort((a, b) => a.x - b.x);
    let x = -far;
    for (const r of spans) {
      if (r.x > x) out.push({ x, y: y0, width: r.x - x, height: y1 - y0 });
      x = Math.max(x, r.x + r.width);
    }
    if (x < far) out.push({ x, y: y0, width: far - x, height: y1 - y0 });
  }
  return out;
}

/**
 * The rows a highlight over a line's text covers: the line box's, united
 * with the text's content area — its face's ascent above the baseline to
 * its descent below (CSS 2.1 10.6.1) — which is taller wherever
 * `line-height` is under the face's height. Blink unites the two in the
 * block direction (`ExpandSelectionRectToLineHeight`), so a selection over
 * a tall line fills it and one over tall glyphs on a short line covers
 * them: Zen Garden 215's 91px title on 20px lines had a band a fifth of
 * its letters' height through their middle.
 */
export function selectionRows(
  line: LineBox,
  text: LineText,
  natural: { baseline: number; ascent?: number; descent?: number },
): { y: number; height: number } {
  const baseline = text.drawY + natural.baseline;
  const top = Math.min(line.y, baseline - (natural.ascent ?? 0));
  const bottom = Math.max(
    line.y + line.height,
    baseline + (natural.descent ?? 0),
  );
  return { y: top, height: bottom - top };
}
