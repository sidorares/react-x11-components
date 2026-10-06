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
import { SCHEME_COLORS, blend, borderShades, fadeColor } from './css/color.js';
import type { Len } from './css/values.js';
import type {
  BackgroundClip,
  BackgroundRepeat,
  BoxShadow,
  ClipPath,
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
  densityOf,
  gradientOf,
  masked,
  scrolls,
  urlImageOf,
  urlOf,
  WILL_CONTAIN,
  WILL_STACK,
  WILL_STACK_BOX,
  WILL_STACK_Z,
} from './css/style.js';
import { LARGEST } from './css/calc.js';
import {
  drawnThrough,
  invert,
  mapRect,
  multiply,
  transformed,
} from './css/transform.js';
import type { Matrix, Placed } from './css/transform.js';
import {
  inFront,
  invertProjection,
  project,
  projectionAfter,
  projectionMoved,
  tangentAt,
} from './css/transform3d.js';
import type { Projection } from './css/transform3d.js';
import {
  contained,
  containmentApplies,
  placedMatrix,
  holdsOutOfFlow,
} from './layout/block.js';
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
  inlineFade,
  textFade,
} from './layout/boxes.js';
import type {
  AtomicPlacement,
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
import type { Element } from './dom.js';
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
import {
  SvgDrawing,
  atDensity,
  concreteSize,
  inlineDrawing,
  quotedFamilies,
} from './svg.js';
import type { IntrinsicSize, SurfaceMaker } from './svg.js';
import type { CollapsedBorder } from './layout/collapse.js';
import { colourFilter } from './css/filter.js';
import type { ColourFilter, FilterFunction } from './css/filter.js';
import type { FilterStore } from './filters.js';

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
  clip?(rule?: 'nonzero' | 'evenodd'): void;
  /** Canvas shadows: ntk bakes and caches the blur, CoreGraphics draws it. */
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  drawImage?(image: unknown, ...args: number[]): void;
  /** Transparent again, where the context draws on a surface. */
  clearRect?(x: number, y: number, width: number, height: number): void;
  /** An image drawn through a 3×3 projection, row-major, in one draw, its
   *  pixel (u, v) where the projection takes it and the matrix then: the
   *  Wayland context's, which interpolates in perspective on the GPU, and
   *  no other's. False, having drawn nothing, where a corner of the image
   *  is behind the viewer (`drawProjected`). */
  drawImageProjected?(image: unknown, matrix: readonly number[]): boolean;
  /** ntk's X11 context has patterns; the Cocoa one does not, and tiles. */
  createPattern?(image: unknown, repetition: string): unknown;
  translate?(x: number, y: number): void;
  /** The context's matrix, and the context's matrix set outright: a clip
   *  laid on the surface's own pixels under a box's (`castOutside`), and
   *  whether a copy lands on them (`gradientStrip`). */
  getTransform?(): {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  };
  setTransform?(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
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
  /** Whether a surface drawn under an alpha below 1 costs about what it
   *  costs at 1: the macOS context, over a bridge that scales a surface's
   *  pixels by the alpha (react-x11 `fadesSurfacesCheaply`). */
  fadesSurfacesCheaply?: boolean;
  /** What every drawing is multiplied by: an element's `opacity`. */
  globalAlpha?: number;
  /** How a drawing meets what is under it; a value a backend does not
   *  have does not stick, and reads back as the one before. */
  globalCompositeOperation?: string;
  /** Canvas's filter list, which react-x11's native contexts run for the
   *  colour functions, and no other does; a list one does not run does
   *  not stick (`FilterStore`'s `through`). */
  filter?: string;
  /** How an image drawn scaled or turned is resampled, canvas's: the
   *  native contexts' (react-x11 `imageSmoothingQuality`), and not ntk's.
   *  A value a context cannot set does not stick. */
  imageSmoothingQuality?: 'low' | 'medium' | 'high';
}

/** An offscreen surface, as painting uses one. */
export interface Offscreen {
  getContext(kind: '2d'): unknown;
  destroy?(): void;
}

/**
 * Where a box drawn on a surface through its matrix keeps that surface from
 * one paint to the next (`paintSprite`): the element's, which knows which
 * boxes are animating and forgets a surface whose box draws something else
 * now.
 */
export interface SpriteSource {
  /** The surface kept for `box`, drawn at this size under `key`, or null. */
  kept(box: Box, width: number, height: number, key: string): Offscreen | null;
  /** Whether an animation is under way on `box`'s element. */
  animates(box: Box): boolean;
  /** Whether an animation is under way on what the box holds, which paints
   *  it again at each of its frames: it keeps a surface however large. */
  animatesWithin?(box: Box): boolean;
  /** What a kept surface holds that a build since changed, in the
   *  document's coordinates, handed over once (`SpriteStore.carry`). */
  stale?(box: Box): Rect[] | null;
  /** A transparent surface to keep for `box` from now on, to be drawn under
   *  `key` — while it animates, where `animated`, and otherwise until what
   *  it draws changes: null where the surface would not fit, and the box is
   *  drawn for this paint alone. */
  keep(
    box: Box,
    width: number,
    height: number,
    key: string,
    animated: boolean,
  ): Offscreen | null;
}

/**
 * A paint of a drag of the window's edge (`PaintOptions.drag`), which a
 * drag that falls behind it draws cheaper (`HtmlViewNode._behind`), with
 * the document's animations paused: a background image whose size moves
 * with the drag is drawn at the nearest of sizes `SIZE_STEP` apart
 * (`steppedTile`), and a box a paused animation turns or scales from the
 * surface kept for it (`paintTransformed`), so that each is copied at the
 * frames of the drag rather than drawn again.
 */
export interface DragPaint {
  /** Whether the drag is drawn cheaper. */
  readonly cheap: boolean;
  /** Whether a background layer, its tile `width` by `height` now, was
   *  another size at a frame of the drag before: one whose size moves
   *  with it. Asked at every frame, so that it knows. */
  moved(layer: object, width: number, height: number): boolean;
  /** Whether an animation of the box's own is under way, and paused. */
  paused(box: Box): boolean;
  /** Called as anything is drawn cheaper, for the paint once the drag
   *  rests to draw it as at rest. */
  drawn(): void;
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
  /** The document range the selection covers, in code units, or null, and
   *  the runs in it no selection takes (`BoxTree.unselectable`), which it
   *  leaves unlit. */
  selection: {
    start: number;
    end: number;
    skip?: readonly number[];
  } | null;
  selectionColor: string | null;
  /** A decoded image for an element, when the host has one. */
  imageFor(box: Box): unknown | null;
  /** The `<video>`s a player is mounted over (`media.ts`), which draw no
   *  frame where they have no poster: the player's picture is what goes
   *  there. */
  mounted?: ReadonlySet<Element>;
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
  /** A block of a small background image's tiles, made for its key on a
   *  surface `width` by `height` and kept, to be drawn with `drawImage`
   *  (`tileBlock`). Null where there is no surface to be had. */
  tilesKept?(
    key: string,
    width: number,
    height: number,
    draw: (ctx: PaintContext) => void,
  ): unknown;
  /** An SVG image's raster at a size, or a raster image's at another than
   *  its own, made for its key on a surface `width` by `height` and kept,
   *  to be drawn with `drawImage` (`drawSvg`, `drawRaster`); null where it
   *  is not kept, and the image is drawn itself. */
  drawingKept?(
    key: string,
    width: number,
    height: number,
    draw: (ctx: PaintContext) => void,
  ): unknown;
  /** Surfaces kept from one paint to the next for the boxes whose
   *  transform is animating (`paintSprite`). Absent, each paint draws such
   *  a box again. */
  sprites?: SpriteSource | null;
  /** Where a filtered box's pixels are kept from one paint to the next,
   *  read back and run through its colour functions (`paintFiltered`).
   *  Absent, a filter's colour functions are not drawn. */
  filters?: FilterStore | null;
  /** The boxes a presenter has on layers of their own (`src/html/sprites.ts`):
   *  each is a hole in the document, it and all it holds, where the layer
   *  shows through. */
  lifted?: ReadonlySet<Box> | null;
  /** The boxes whose outer shadows a presenter draws on a layer of their
   *  own (`shadowPartOf`): the document draws the box, but not them. */
  shadowless?: ReadonlySet<Box> | null;
  /** Set while the window's edge is dragged (`liveResizing`). */
  drag?: DragPaint | null;
  /** @internal The box whose background went to the canvas instead. */
  canvasSource?: Box | null;
  /** @internal The boxes clipping what is being painted, outermost first. */
  clips?: ClipLevel[];
  /** @internal Whether the tree has a layer below the flow (`hoistNegative`). */
  negative?: boolean;
  /** @internal The tree's boxes fixed to the viewport (`FIXED_BOXES`). */
  fixed?: readonly Box[] | null;
  /** @internal Each box's `::selection`, where a rule styles one
   *  (`BoxTree.selectionStyler`). */
  selectionStyler?: SelectionStyler | null;
  /** @internal What the rules give the shapes in each drawing, where one
   *  could reach any (`BoxTree.shapeStyler`). */
  shapeStyler?: ShapeStyler | null;
  /** @internal The matrix the context draws through, from the coordinates
   *  being painted in to the window's, inside a box drawn through its
   *  transform (`paintTransformed`): what a shadow's offset and blur, which
   *  a context takes in the window's coordinates, are carried out through
   *  (`aside`). Absent, the two are one. */
  matrix?: Matrix;
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
    const out = shadowOutsets(shadows);
    x1 -= out.left;
    y1 -= out.top;
    x2 += out.right;
    y2 += out.bottom;
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
  // above or below its text can reach past its lines. And the shadows its
  // fragments cast are ink past them, as a block's are, and no overflow:
  // a repaint of the strip under a link's has to reach it, and so does
  // the cull of the lines it is under (`LINE_CASTS`).
  if (box.kind === 'inline') {
    const padded =
      box.padTop + box.padBottom + box.borderTop + box.borderBottom > 0;
    const shadows = box.style.boxShadow;
    const out = shadows ? shadowOutsets(shadows) : null;
    const reach = padded || out ? inlineFragmentsReach(box, out) : null;
    if (reach) {
      x1 = Math.min(x1, reach.x1 - (out?.left ?? 0));
      y1 = Math.min(y1, reach.y1 - (out?.top ?? 0));
      x2 = Math.max(x2, reach.x2 + (out?.right ?? 0));
      y2 = Math.max(y2, reach.y2 + (out?.bottom ?? 0));
      if (padded) bottom = Math.max(bottom, reach.y2);
    }
  }
  const lines = box.lines;
  // what the inline boxes on its lines cast past them, which they say
  // again as they are walked below
  if (lines && CAST_LINES.has(lines)) {
    CAST_LINES.delete(lines);
    for (const line of lines) LINE_CASTS.delete(line);
  }
  // and the shadows its text casts, as far past the text as they fall: an
  // expose of the strip they fall in, or a hover that fades them, has to
  // reach them
  const cast = lines ? textShadowReach(box) : null;
  if (lines) {
    let tallest = 0;
    for (const line of lines) {
      x1 = Math.min(x1, line.x - (cast?.left ?? 0));
      y1 = Math.min(y1, line.y);
      x2 = Math.max(x2, line.x + line.width + (cast?.right ?? 0));
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
      // and the shadows its inline boxes cast past it
      const casts = LINE_CASTS.get(line);
      if (casts) {
        top = Math.min(top, casts.top);
        bottom = Math.max(bottom, casts.bottom);
      }
      // what `position: relative` moved off a line the cull finds on its
      // own (`reachedOff`), wherever it went
      if (movedOff?.has(line)) continue;
      for (const text of line.texts) {
        const natural = text.layout.lines[text.layoutLine];
        if (!natural) continue;
        const baseline = text.drawY + natural.baseline;
        top = Math.min(
          top,
          baseline - (natural.ascent ?? 0) - (cast?.top ?? 0),
        );
        bottom = Math.max(
          bottom,
          baseline + (natural.descent ?? 0) + (cast?.bottom ?? 0),
        );
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
  // and its style is one more object a walk of every box would read. The
  // same answer as the clip it is painted under (`clipsOverflow`), so paint
  // containment, which clips as `overflow: clip` does, ends the reach too
  const end = empty ? -Infinity : box.y + box.height;
  const reach = bottom > end && !clipsOverflow(box) ? bottom : end;
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
 * no face. Where it casts shadows `out` past them, each line notes how far
 * above and below it they fall (`LINE_CASTS`).
 */
function inlineFragmentsReach(
  box: Box,
  out: Outsets | null,
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
    const top = baseline - face.ascent - box.padTop - box.borderTop;
    const bottom = baseline + face.descent + box.padBottom + box.borderBottom;
    x1 = Math.min(x1, line.x);
    x2 = Math.max(x2, line.x + line.width);
    y1 = Math.min(y1, top);
    y2 = Math.max(y2, bottom);
    // only where they fall past the line, which a link's underline does
    // where the line is no taller than its text
    if (
      out &&
      (top - out.top < line.y || bottom + out.bottom > line.y + line.height)
    ) {
      const was = LINE_CASTS.get(line);
      LINE_CASTS.set(line, {
        top: Math.min(top - out.top, was?.top ?? Infinity),
        bottom: Math.max(bottom + out.bottom, was?.bottom ?? -Infinity),
      });
      CAST_LINES.add(lines);
    }
  }
  return x1 === Infinity ? null : { x1, y1, x2, y2 };
}

/** How far above and below a line the shadows of the inline boxes on it
 *  fall, in the document's coordinates (`inlineFragmentsReach`): a line
 *  the damage misses is painted where they reach into it (`inkInto`). Said
 *  again each time the boxes' bounds are, for the lines of a block in
 *  `CAST_LINES`, which the block forgets first. */
const LINE_CASTS = new WeakMap<LineBox, { top: number; bottom: number }>();
const CAST_LINES = new WeakSet<readonly LineBox[]>();

/** How far past a block's text the shadows it casts fall on each side, at
 *  most (`SHADOWED_TEXT`); null where its text casts none. */
function textShadowReach(
  box: Box,
): { left: number; top: number; right: number; bottom: number } | null {
  const casts = SHADOWED_TEXT.get(box);
  if (!casts) return null;
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  for (const shadows of casts) {
    for (const s of shadows) {
      const reach = shadowReach(s.blur);
      left = Math.max(left, reach - s.x);
      right = Math.max(right, reach + s.x);
      top = Math.max(top, reach - s.y);
      bottom = Math.max(bottom, reach + s.y);
    }
  }
  return { left, top, right, bottom };
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
  // under a canvas of a colour of its own with no transparency, which
  // covers all of it, the scheme's is a fill nobody sees
  if (scheme !== tree.paletteScheme && !coloursCanvas(canvas)) {
    // A document is drawn on the window's own ground, the palette's, as an
    // embedded one is on a transparent canvas. Where its root's colour
    // scheme is not the scheme of what it is embedded in, its canvas is
    // opaque, in the `Canvas` colour of its own (CSS Color Adjust 1, 2.2):
    // a page that says it is light, and sets its text dark on no
    // background, is not read against a dark window.
    const area = canvasArea(tree, options);
    if (area) {
      ctx.fillStyle = SCHEME_COLORS[scheme].canvas;
      ctx.fillRect(area.x, area.y, area.w, area.h);
    }
  }
  if (canvas) paintCanvas(ctx, canvas, tree, options);
  paintBox(ctx, tree.root, {
    ...options,
    canvasSource: canvas?.source,
    negative: tree.negative,
    fixed: FIXED_BOXES.get(tree) ?? null,
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
  anchor: Frame;
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
 * positioned against: the root element's, whichever box it came from —
 * there, the implied `<html>`'s, which no box is laid out for
 * (`impliedFrame`).
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
    if (has(implied)) {
      return { style: implied, source: null, anchor: impliedFrame(tree) };
    }
    // containment on either keeps the body's to the body (CSS Containment 2)
    if (implied.contain || root.style.contain) return null;
    return has(root.style)
      ? { style: root.style, source: root, anchor: impliedFrame(tree) }
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

/** Whether a canvas background paints the whole canvas in an opaque
 *  colour (`paintCanvas`), which nothing under it shows through. */
function coloursCanvas(canvas: CanvasBackground | null): boolean {
  if (!canvas || canvas.style.visibility !== 'visible') return false;
  const color = canvas.style.backgroundColor;
  if (isTransparent(color)) return false;
  return alphaOf(inkColor(color as string, canvas.style.color)) === 1;
}

/**
 * Whether a document paints its canvas — every pixel of the element, before
 * anything else — opaque: in the `Canvas` colour of a scheme of its own, or
 * in an opaque colour of its own (`paintDocument`). What `<Html>` promises
 * core in `opaqueRect()`, which skips every fill under the element.
 */
export function opaqueCanvas(tree: BoxTree): boolean {
  return (
    rootScheme(tree) !== tree.paletteScheme ||
    coloursCanvas(canvasBackground(tree))
  );
}

/** The used colour scheme of the document's root element: the `<html>`'s,
 *  or that of whichever box stands in for it (`canvasBackground`). */
function rootScheme(tree: BoxTree): 'light' | 'dark' {
  if (tree.impliedHtml) return tree.impliedHtml.colorScheme;
  return (childNamed(tree.root, 'html') ?? tree.root).style.colorScheme;
}

/**
 * The box of the `<html>` a fragment's body is implied in, which the
 * layout makes none for: it has no edges here, so it is the initial
 * containing block as far down as the body's margin box and its floats
 * reach (`DOCUMENT_FLOW`). Not the root box, which is the body's, inside
 * its margins.
 */
function impliedFrame(tree: BoxTree): Frame {
  const root = tree.root;
  const flow = DOCUMENT_FLOW.get(tree) ?? root;
  return {
    x: 0,
    y: 0,
    width: flow.width,
    height: flow.height,
    captionTop: 0,
    captionBottom: 0,
    borderTop: 0,
    borderRight: 0,
    borderBottom: 0,
    borderLeft: 0,
    style: tree.impliedHtml ?? root.style,
  };
}

/** The canvas, cut to what is being painted: the whole element where the
 *  host says what that is, and else the initial containing block as far
 *  down as the document's flow reaches (`DOCUMENT_FLOW`). */
function canvasArea(
  tree: BoxTree,
  options: PaintOptions,
): { x: number; y: number; w: number; h: number } | null {
  const flow = DOCUMENT_FLOW.get(tree) ?? tree.root;
  const whole = options.canvas ?? {
    x: options.originX,
    y: options.originY,
    width: flow.width,
    height: flow.height,
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
  tree: BoxTree,
  options: PaintOptions,
): void {
  const area = canvasArea(tree, options);
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
        options,
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
    layer.backgroundImage = urlImageOf(image);
    layer.backgroundGradient = gradientOf(image);
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
 * `rounded` asks for them — cut to what the paint reaches (`clampArea`).
 * Null where it has no area there.
 */
function clipArea(
  box: Frame,
  options: PaintOptions,
  style: ComputedStyle,
  rounded: boolean,
): Area | null {
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
  return clampArea(options, x, y, w, h, corners);
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
    options.lifted?.has(box) ||
    !intersects(box, options) ||
    COLLAPSED_CELLS.has(box) ||
    CLAMPED.has(box)
  ) {
    return;
  }
  // An element under full opacity is painted whole, as the group it is
  // (it is a stacking context, CSS Color 4 3.2; `layered`): at
  // 0 not at all — the control a page keeps invisible until its row is
  // hovered — and between on a surface of its own, faded as it is drawn
  // (`paintGroup`). Where there is no surface, or nothing it draws can
  // fall on anything else it draws, through the context's alpha, which
  // multiplies each thing drawn rather than the group they make.
  const opacity = opacityOf(box);
  if (opacity <= 0) return;
  if (
    box.style.filter !== null &&
    paintFiltered(ctx, box, options, null, opacity)
  ) {
    return;
  }
  if (opacity < 1 && paintGroup(ctx, box, options, opacity)) return;
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

/** How large a surface a box drawn on one keeps while nothing animates it
 *  (`paintSprite`): a card's, a button's, a badge's. A larger one is drawn
 *  again where each paint reaches it, as a panel's is. */
const KEPT_STILL = 128 * 1024;

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
    options.lifted?.has(box) ||
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
  if (matrix.length === 9) {
    paintProjected(ctx, box, options, projectionMoved(matrix, ox, oy));
    return;
  }
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
    matrix: options.matrix ? multiply(options.matrix, through) : through,
  };
  // a filter's colour functions are run over the box as laid out, and the
  // result drawn through the matrix (Filter Effects 1, 2: the filter
  // comes before the transform)
  if (
    box.style.filter !== null &&
    paintFiltered(ctx, box, inside, through, opacityOf(box))
  ) {
    return;
  }
  if (
    ctx.scalesText !== true &&
    !drawnAsPaths(box) &&
    paintRaster(ctx, box, inside, through)
  ) {
    return;
  }
  const opacity = opacityOf(box);
  if (opacity <= 0) return;
  // A drag drawn cheaper pauses the document's animations, and a box one
  // of them turns or scales draws at each frame of the drag what it drew
  // at the one before: from the surface kept for it, through its matrix,
  // as X11 draws it at every frame — where the context could draw it
  // through the matrix itself, and set Zen Garden 214's enso from its
  // paths at every frame of a drag.
  const drag = options.drag;
  if (
    drag?.cheap &&
    drag.paused(box) &&
    options.sprites &&
    paintSprite(ctx, box, inside, through, opacity)
  ) {
    drag.drawn();
    return;
  }
  if (
    opacity < 1 &&
    paintGroupThrough(ctx, box, options, inside, through, opacity)
  ) {
    return;
  }
  ctx.save();
  ctx.transform(a, b, c, d, through[4], through[5]);
  paintPlaced(ctx, box, inside);
  ctx.restore();
}

/**
 * A box a perspective shows the far side of smaller than the near one
 * (CSS Transforms 2, 6; `placedMatrix`): what its plane comes to is a
 * projection, and a context draws through a matrix of the plane and no
 * more. So the box is painted on a surface of its own, as it was laid out,
 * and the surface drawn through the projection a tile of the device's
 * pixels at a time (`drawProjected`) — resampled, as a browser draws a
 * layer in perspective, and at the box's opacity, as the group it is. The
 * surface is the part of the box the damage reaches, taken back through
 * the projection, or the whole of it kept while its transform animates
 * (`spriteFor`). With no surface to be had it is drawn through the matrix
 * of the plane nearest the projection at its middle.
 *
 * `through` is in the coordinates being painted in. The tiles are whole
 * pixels of the device, so where the context draws through a matrix of a
 * box around this one (`PaintOptions.matrix`) the projection is drawn
 * after it, from the device's coordinates: a tile cut out in the turned
 * box's would be a turned square, and its edges would not meet.
 */
function paintProjected(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  through: Projection,
): void {
  const opacity = opacityOf(box);
  if (opacity <= 0) return;
  if (
    !options.surface ||
    !ctx.drawImage ||
    !ctx.beginPath ||
    !ctx.rect ||
    !ctx.clip
  ) {
    const near = tangentAt(
      through,
      box.x + box.width / 2 + options.originX,
      box.y + box.height / 2 + options.originY,
    );
    const back = near && invert(near);
    if (!near || !back) return;
    const damage = options.damage;
    ctx.save();
    ctx.transform!(near[0], near[1], near[2], near[3], near[4], near[5]);
    paintPlaced(ctx, box, {
      ...options,
      damage:
        damage &&
        mapRect(back, damage.x, damage.y, damage.width, damage.height),
      matrix: options.matrix ? multiply(options.matrix, near) : near,
    });
    ctx.restore();
    return;
  }
  const outer = options.matrix;
  const undo = outer ? invert(outer) : null;
  if (outer && !undo) return;
  const total = outer ? projectionAfter(outer, through) : through;
  const back = invertProjection(total);
  if (!back) return;
  const reach = options.damage ?? options.canvas ?? null;
  const bound =
    reach && outer
      ? mapRect(outer, reach.x, reach.y, reach.width, reach.height)
      : reach;
  const tolerance = TILE_ERROR * (options.scale ?? 1);
  ctx.save();
  try {
    if (undo) {
      ctx.transform!(undo[0], undo[1], undo[2], undo[3], undo[4], undo[5]);
    }
    const colour = box.style.filter && colourOf(box.style.filter);
    const filtered = colour?.matrices.length
      ? filteredFor(ctx, box, options, total, colour)
      : null;
    // a filtered box with nothing read for it yet draws nothing
    if (filtered === undefined) return;
    const kept =
      filtered ?? (options.sprites ? spriteFor(box, options, total) : null);
    if (kept) {
      const { surface, x, y, width, height } = kept;
      drawProjected(
        ctx,
        surface,
        total,
        x,
        y,
        width,
        height,
        opacity,
        bound,
        tolerance,
      );
      return;
    }
    const own = ownBounds(box);
    let x0 = Math.floor(own.x + options.originX);
    let y0 = Math.floor(own.y + options.originY);
    let x1 = Math.ceil(own.x + own.width + options.originX);
    let y1 = Math.ceil(own.y + own.height + options.originY);
    if (options.damage && bound) {
      // where the damage comes from on the box, a pixel more each way: the
      // edge of what is drawn is sampled from beside it. All of the box
      // where some of the damage is beyond the horizon, behind the viewer.
      let sx0 = Infinity;
      let sy0 = Infinity;
      let sx1 = -Infinity;
      let sy1 = -Infinity;
      for (const [x, y] of [
        [bound.x, bound.y],
        [bound.x + bound.width, bound.y],
        [bound.x, bound.y + bound.height],
        [bound.x + bound.width, bound.y + bound.height],
      ]) {
        const from = project(back, x, y);
        if (!from) {
          sx0 = -Infinity;
          sx1 = Infinity;
          sy0 = -Infinity;
          sy1 = Infinity;
          break;
        }
        sx0 = Math.min(sx0, from[0]);
        sy0 = Math.min(sy0, from[1]);
        sx1 = Math.max(sx1, from[0]);
        sy1 = Math.max(sy1, from[1]);
      }
      x0 = Math.max(x0, Math.floor(sx0) - 1);
      y0 = Math.max(y0, Math.floor(sy0) - 1);
      x1 = Math.min(x1, Math.ceil(sx1) + 1);
      y1 = Math.min(y1, Math.ceil(sy1) + 1);
    }
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 0 && h > 0)) return;
    if (w > RASTER_SIDE || h > RASTER_SIDE || w * h > RASTER_LIMIT) return;
    const surface = options.surface(w, h);
    if (!surface) return;
    try {
      paintUnfaded(
        surface.getContext('2d') as PaintContext,
        box,
        onSurface(options, x0, y0, w, h),
      );
      drawProjected(
        ctx,
        surface,
        total,
        x0,
        y0,
        w,
        h,
        opacity,
        bound,
        tolerance,
      );
    } finally {
      surface.destroy?.();
    }
  } finally {
    ctx.restore();
  }
}

/** How far a tile's matrix may put a point of the surface from where the
 *  projection does, in logical pixels (`drawProjected`): what a line that
 *  crosses from one tile to the next can be off by where it does. */
const TILE_ERROR = 0.25;

/** A tile no wider and no taller than this is not cut again, whatever its
 *  matrix is off by, and past this many tiles none is: only near the
 *  horizon, where a pixel of the device is a field of the surface's. */
const TILE_LEAST = 4;
const TILES_MOST = 4096;

/**
 * A surface with its corner at (`x0`, `y0`), `width` by `height`, drawn
 * through a projection at `opacity`: the device's pixels it lands on cut
 * into tiles of whole pixels, each drawn through the matrix of the plane
 * nearest the projection at its middle (`tangentAt`) and clipped to the
 * tile. A tile is cut in two across its longer side until its matrix puts
 * each of its corners within `tolerance` of where the projection does, so
 * tiles are large where the projection is all but a matrix — a box turned
 * a little, or seen from far off — and small where it bends. Their clips
 * are whole pixels and meet edge to edge: nothing is drawn twice, which a
 * fade would show, and no seam shows between two, which clips cut through
 * a pixel would leave half covered twice over. A line that crosses from
 * one tile to the next is off by no more than the tolerance where it does.
 * Only what is in `bound` is drawn, and nothing behind the viewer.
 */
function drawProjected(
  ctx: PaintContext,
  surface: Offscreen,
  p: Projection,
  x0: number,
  y0: number,
  width: number,
  height: number,
  opacity: number,
  bound: Rect | null,
  tolerance: number,
): void {
  // where the part of it in front of the viewer lands
  let X0 = Infinity;
  let Y0 = Infinity;
  let X1 = -Infinity;
  let Y1 = -Infinity;
  for (const [x, y] of inFront(p, [
    [x0, y0],
    [x0 + width, y0],
    [x0 + width, y0 + height],
    [x0, y0 + height],
  ])) {
    const to = project(p, x, y);
    if (!to) continue;
    X0 = Math.min(X0, to[0]);
    Y0 = Math.min(Y0, to[1]);
    X1 = Math.max(X1, to[0]);
    Y1 = Math.max(Y1, to[1]);
  }
  X0 = Math.max(Math.floor(X0), -FIXED_LIMIT);
  Y0 = Math.max(Math.floor(Y0), -FIXED_LIMIT);
  X1 = Math.min(Math.ceil(X1), FIXED_LIMIT);
  Y1 = Math.min(Math.ceil(Y1), FIXED_LIMIT);
  // The tiles are cut from all of it, whatever the bound, and those the
  // bound misses are passed over before they are cut again: a paint of part
  // of the box draws the very tiles a paint of all of it does there. Cut
  // from the bound instead, a repaint drew it through other matrices, a
  // level or a few apart from what was around it.
  const whole = [X0, Y0, X1, Y1];
  if (bound) {
    X0 = Math.max(X0, Math.floor(bound.x));
    Y0 = Math.max(Y0, Math.floor(bound.y));
    X1 = Math.min(X1, Math.ceil(bound.x + bound.width));
    Y1 = Math.min(Y1, Math.ceil(bound.y + bound.height));
  }
  if (!(X1 > X0 && Y1 > Y0)) return;
  const back = invertProjection(p);
  if (!back) return;
  ctx.save();
  if (opacity < 1 && typeof ctx.globalAlpha === 'number') {
    ctx.globalAlpha *= opacity;
  }
  // One draw where the context draws in perspective — the Wayland one, on
  // the GPU — over the pixels the tiles would cover. Zen Garden 219's tilted
  // sidebar was 258 tiles a frame there, each a batch of its own since each
  // is clipped, at 11 frames a second on a virgl VM where 7 tiles ran at 25.
  // Tiles where the context has no such draw, or declines one for a corner
  // behind the viewer.
  if (ctx.drawImageProjected && ctx.beginPath && ctx.rect && ctx.clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(X0, Y0, X1 - X0, Y1 - Y0);
    ctx.clip();
    // the surface's pixel (u, v) is the point (x0 + u, y0 + v) `p` takes
    const drawn = ctx.drawImageProjected(surface, [
      p[0],
      p[1],
      p[0] * x0 + p[1] * y0 + p[2],
      p[3],
      p[4],
      p[3] * x0 + p[4] * y0 + p[5],
      p[6],
      p[7],
      p[6] * x0 + p[7] * y0 + p[8],
    ]);
    ctx.restore();
    if (drawn) {
      ctx.restore();
      return;
    }
  }
  // Bilinear, as a layer in perspective is drawn: each tile's matrix is
  // within a fraction of a pixel of the plane's, and on macOS a context's
  // own 'medium' resamples the whole surface for each tile, whatever its
  // clip — 784 tiles of a 1400 by 1120 surface took 200 ms there, and 27
  // at 'low' (react-x11's `imageSmoothingQuality`, windowkit/appkit#109).
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'low';
  const area = { x0, y0, x1: x0 + width, y1: y0 + height };
  const tiles = whole;
  let made = 1;
  while (tiles.length) {
    const by = tiles.pop()!;
    const bx = tiles.pop()!;
    const ay = tiles.pop()!;
    const ax = tiles.pop()!;
    if (bx <= X0 || ax >= X1 || by <= Y0 || ay >= Y1) continue;
    const last = made >= TILES_MOST;
    const fit = tileFit(p, back, ax, ay, bx, by, area, tolerance, last);
    if (fit === MISSES) continue;
    if (fit === CUT_ACROSS || fit === CUT_DOWN) {
      made += 1;
      // a side of one pixel is cut no further
      if (fit === CUT_ACROSS ? bx - ax > 1 : by - ay <= 1) {
        const mid = ax + Math.floor((bx - ax) / 2);
        tiles.push(ax, ay, mid, by, mid, ay, bx, by);
      } else {
        const mid = ay + Math.floor((by - ay) / 2);
        tiles.push(ax, ay, bx, mid, ax, mid, bx, by);
      }
      continue;
    }
    // what of the tile the bound holds
    const cx = Math.max(ax, X0);
    const cy = Math.max(ay, Y0);
    ctx.save();
    ctx.beginPath!();
    ctx.rect!(cx, cy, Math.min(bx, X1) - cx, Math.min(by, Y1) - cy);
    ctx.clip!();
    ctx.transform!(fit[0], fit[1], fit[2], fit[3], fit[4], fit[5]);
    ctx.drawImage!(surface, x0, y0);
    ctx.restore();
  }
  ctx.restore();
}

/** What a tile is (`tileFit`): none of the surface, or cut in two across
 *  its width or across its height. */
const MISSES = 0;
const CUT_ACROSS = 1;
const CUT_DOWN = 2;

/**
 * The matrix a tile from (`ax`, `ay`) to (`bx`, `by`) is drawn through, or
 * whether it misses the surface or is cut (`drawProjected`). The matrix is
 * the projection's nearest at the tile's middle (`tangentAt`), moved half
 * the way to where that puts the corners on average: a projection that
 * bends one way across the tile puts its middle and its corners off by
 * half as much each, where the nearest matrix puts the middle right and
 * the corners off by all of it. A tile its matrix leaves off by more than
 * `tolerance` is cut across the way the projection bends more — along, up
 * and down, or both ways at once, which a cut either way halves — and the
 * longer way where neither is the more.
 */
function tileFit(
  p: Projection,
  back: Projection,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  area: { x0: number; y0: number; x1: number; y1: number },
  tolerance: number,
  last: boolean,
): Matrix | typeof MISSES | typeof CUT_ACROSS | typeof CUT_DOWN {
  const least = last || (bx - ax <= TILE_LEAST && by - ay <= TILE_LEAST);
  const longer = bx - ax >= by - ay ? CUT_ACROSS : CUT_DOWN;
  // the corners, the middles of the four edges and the middle: where each
  // comes from on the surface
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const at = [ax, ay, bx, ay, ax, by, bx, by, ax, my, bx, my, mx, ay, mx, by];
  const from: number[] = [];
  let left = 0;
  let right = 0;
  let above = 0;
  let below = 0;
  for (let i = 0; i < 16; i += 2) {
    const s = project(back, at[i], at[i + 1]);
    // the tile reaches past the horizon: what is beyond it is behind the
    // viewer, and a tile at it is a field of the surface in a pixel
    if (!s) return least ? MISSES : longer;
    from.push(s[0], s[1]);
    if (i < 8) {
      if (s[0] < area.x0) left += 1;
      if (s[0] > area.x1) right += 1;
      if (s[1] < area.y0) above += 1;
      if (s[1] > area.y1) below += 1;
    }
  }
  // a tile is the four-sided figure its corners come from, and one with
  // all four past one side of the surface has all of it there
  if (left === 4 || right === 4 || above === 4 || below === 4) return MISSES;
  const middle = project(back, mx, my);
  const m = middle && tangentAt(p, middle[0], middle[1]);
  if (!m) return least ? MISSES : longer;
  // how far the nearest matrix puts each point from where it lands
  const off: number[] = [];
  for (let i = 0; i < 16; i += 2) {
    const sx = from[i];
    const sy = from[i + 1];
    off.push(
      m[0] * sx + m[2] * sy + m[4] - at[i],
      m[1] * sx + m[3] * sy + m[5] - at[i + 1],
    );
  }
  // half the corners' mean, which the matrix is moved back by
  const hx = (off[0] + off[2] + off[4] + off[6]) / 8;
  const hy = (off[1] + off[3] + off[5] + off[7]) / 8;
  const fit: Matrix = [m[0], m[1], m[2], m[3], m[4] - hx, m[5] - hy];
  if (least) return fit;
  let worst = hx * hx + hy * hy;
  for (let i = 0; i < 8; i += 2) {
    const ex = off[i] - hx;
    const ey = off[i + 1] - hy;
    worst = Math.max(worst, ex * ex + ey * ey);
  }
  if (worst <= tolerance * tolerance) return fit;
  // which way it bends: along, as the middles of the sides do; up and
  // down, as the middles of the top and the bottom do; and both at once,
  // as the corners do against each other
  const along = Math.hypot((off[8] + off[10]) / 2, (off[9] + off[11]) / 2);
  const down = Math.hypot((off[12] + off[14]) / 2, (off[13] + off[15]) / 2);
  const both = Math.hypot(
    (off[0] - off[2] - off[4] + off[6]) / 4,
    (off[1] - off[3] - off[5] + off[7]) / 4,
  );
  if (along > down + both) return CUT_ACROSS;
  if (down > along + both) return CUT_DOWN;
  return longer;
}

/**
 * Whether a box's style turns, scales or skews it, or moves it toward the
 * viewer (`drawnThrough`), which is asked before every box that may be one
 * is painted (`paintPositioned`, `paintLines`) — there, and not in
 * `paintBox`, whose frame is one of three a level of nesting costs the
 * stack: a name more in it, and a document a thousand boxes deep ran out.
 */
function turns(box: Box): boolean {
  return drawnThrough(box.style);
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
  paintUnfaded(ctx, box, options);
  if (fade) ctx.restore();
}

/**
 * A box on a layer of its own (`src/html/sprites.ts`): it and all it holds,
 * as laid out, at full opacity and through no matrix — the layer carries
 * both — on a context in the window's coordinates, as the document's are.
 * Nothing culls it: the layer holds the whole of it.
 */
export function paintLiftedBox(
  ctx: PaintContext,
  tree: BoxTree,
  box: Box,
  options: PaintOptions,
  /** The boxes lifted inside it, on layers of their own in its: holes in
   *  it, as it is one in the document. */
  holes: ReadonlySet<Box> | null = null,
): void {
  if (!canFill(ctx)) return;
  // where the document draws it: at the viewport, for one fixed to it or in
  // one that is (`atViewport`)
  const viewport = options.viewport;
  const placed =
    viewport && !options.atViewport && drawnAtViewport(box)
      ? { originX: viewport.x, originY: viewport.y, atViewport: true }
      : null;
  paintUnfaded(ctx, box, {
    ...options,
    ...placed,
    damage: null,
    clips: [],
    lifted: holes,
    sprites: null,
    matrix: undefined,
    canvasSource: canvasBackground(tree)?.source,
    negative: tree.negative,
    fixed: FIXED_BOXES.get(tree) ?? null,
    selectionStyler: options.selection ? tree.selectionStyler : null,
    shapeStyler: tree.shapeStyler,
  });
}

/** `paintPlaced` at full opacity: a box drawn on a surface of its own, which
 *  is faded as it is composited (`paintRaster`). */
function paintUnfaded(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): void {
  if (!masked(box.style) || !paintMasked(ctx, box, options)) {
    paintClipped(ctx, box, options);
  }
}

/**
 * Whether all a box and what it holds draw is paths and flat colour:
 * backgrounds, borders, outlines and inline drawings with no text in them
 * — no text and no list marker, whose glyphs a context may not turn, and
 * no image, gradient, shadow or mask, which one draws through a picture's
 * transform (`paintTransformed`).
 */
function drawnAsPaths(box: Box): boolean {
  if (box.subtreeTextEnd > box.subtreeTextStart) return false;
  const stack: Box[] = [box];
  while (stack.length) {
    const at = stack.pop()!;
    if (at.marker || at.replaced === 'image') return false;
    // a drawing's text is glyphs too: bun.sh's badge turned and its
    // words stayed level
    if (at.replaced === 'svg' && at.el && inlineDrawing(at.el).hasText()) {
      return false;
    }
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
 * the damage reaches, or the whole of it on the surface kept for a box
 * whose transform is animating (`paintSprite`). It is painted whole and
 * faded as the surface is drawn, as the group it is (CSS Color 4, 3.2): an
 * opacity on the box does not show its background through its text. True
 * where that is done — or is nothing to do, or cannot be: a part too large
 * for a surface, or a matrix that does not fit the fixed point a picture's
 * transform is sent in, which is one that draws the box a thirtieth its
 * size far across a window, or flatter than can be seen. None of it is
 * drawn then. False where the context has no surface to draw on, and the
 * caller draws the box through the matrix itself.
 */
function paintRaster(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  through: Matrix,
): boolean {
  if (!options.surface || !ctx.drawImage) return false;
  const opacity = opacityOf(box);
  if (opacity <= 0) return true;
  if (options.sprites && paintSprite(ctx, box, options, through, opacity)) {
    return true;
  }
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
  if (!fitsFixedPoint(through, x0, y0)) return true;
  const surface = options.surface(w, h);
  if (!surface) return false;
  try {
    paintUnfaded(
      surface.getContext('2d') as PaintContext,
      box,
      onSurface(options, x0, y0, w, h),
    );
    drawThrough(ctx, surface, through, x0, y0, opacity);
    return true;
  } finally {
    surface.destroy?.();
  }
}

/**
 * A box drawn from the surface it keeps from one paint to the next
 * (`PaintOptions.sprites`), where it keeps one — its transform or its
 * opacity is animating: the whole box painted on it once, and each frame
 * after it only drawn through the matrix the frame has (`paintRaster`), or
 * at the opacity it has (`paintGroup`). A turn, a scale and an opacity
 * leave what is on the surface as it was. True where the box is drawn so;
 * false where it keeps no surface, and it is painted for this paint alone.
 *
 * What the surface holds is the box and all it holds, at the fraction of a
 * pixel its corner falls on — what every box in it is snapped to the grid
 * by — under the document selection's part in its text, and nothing else:
 * that is its key. Everything else that changes what it draws is a change
 * of its boxes, which the element forgets the surface for. The root's box
 * and the canvas's are not kept, nor one that draws against the viewport
 * inside it (`drawsAgainstViewport`), all of which draw what a scroll moves.
 */
function paintSprite(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  through: Matrix | null,
  opacity: number,
): boolean {
  const kept = spriteFor(box, options, through);
  if (!kept) return false;
  drawThrough(ctx, kept.surface, through, kept.x, kept.y, opacity);
  return true;
}

/** A surface kept for a box, with where its corner is. */
interface Kept {
  surface: Offscreen;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `paintSprite`'s surface: the one the box keeps, or a new one it keeps
 *  from now on with the box painted on it; null where it keeps none. */
function spriteFor(
  box: Box,
  options: PaintOptions,
  through: Placed | null,
): Kept | null {
  const sprites = options.sprites!;
  if (!box.parent || box === options.canvasSource) return null;
  // in its own coordinates where it is drawn through a matrix, and where it
  // is drawn otherwise — its ink, all of it
  const own = through
    ? ownBounds(box)
    : {
        x: box.boundsX,
        y: box.boundsY,
        width: box.boundsWidth,
        height: box.boundsHeight,
      };
  const left = own.x + options.originX;
  const top = own.y + options.originY;
  const x0 = Math.floor(left);
  const y0 = Math.floor(top);
  const w = Math.ceil(left + own.width) - x0;
  const h = Math.ceil(top + own.height) - y0;
  if (!(w > 0 && h > 0)) return null;
  if (w > RASTER_SIDE || h > RASTER_SIDE || w * h > RASTER_LIMIT) return null;
  // a projection is drawn a tile at a time, each tile's matrix asked then
  if (through?.length === 6 && !fitsFixedPoint(through, x0, y0)) return null;
  const key = spriteKey(box, options, through, left - x0, top - y0);
  let surface = sprites.kept(box, w, h, key);
  const on = (): PaintOptions =>
    through ? onSurface(options, x0, y0, w, h) : inGroup(options, x0, y0, w, h);
  if (surface) {
    const stale = sprites.stale?.(box);
    if (stale?.length) {
      repaintStale(surface, box, on(), options, x0, y0, w, h, stale);
    }
  } else {
    // A box painted again at every frame of an animation inside it keeps
    // its surface however large, while the animation runs: what changes is
    // painted again on it, and the rest is not (`repaintStale`).
    const animated =
      sprites.animates(box) || (sprites.animatesWithin?.(box) ?? false);
    if (!animated && w * h > KEPT_STILL) return null;
    if (drawsAgainstViewport(box)) return null;
    surface = sprites.keep(box, w, h, key, animated);
    if (!surface) return null;
    paintUnfaded(surface.getContext('2d') as PaintContext, box, on());
  }
  return { surface, x: x0, y: y0, width: w, height: h };
}

/**
 * The part of a box's kept surface a build said changed — the ink, before
 * and after, of what moved inside the box, in the document's coordinates —
 * cleared and painted again, and the rest left as it is. One region round
 * them all: the boxes a damage reaches are painted whole, and what is
 * outside it is clipped away.
 */
function repaintStale(
  surface: Offscreen,
  box: Box,
  on: PaintOptions,
  options: PaintOptions,
  x0: number,
  y0: number,
  width: number,
  height: number,
  stale: Rect[],
): void {
  const ctx = surface.getContext('2d') as PaintContext;
  if (!ctx.clearRect || !ctx.beginPath || !ctx.rect || !ctx.clip) return;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of stale) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  // a pixel round it: what is drawn at the edge of a box is sampled from
  // beside it
  const ax = Math.max(0, Math.floor(x1 + options.originX) - x0 - 1);
  const ay = Math.max(0, Math.floor(y1 + options.originY) - y0 - 1);
  const bx = Math.min(width, Math.ceil(x2 + options.originX) - x0 + 1);
  const by = Math.min(height, Math.ceil(y2 + options.originY) - y0 + 1);
  if (!(bx > ax && by > ay)) return;
  const area = { x: ax, y: ay, width: bx - ax, height: by - ay };
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.width, area.height);
  ctx.clip();
  ctx.clearRect(area.x, area.y, area.width, area.height);
  paintUnfaded(ctx, box, { ...on, damage: area });
  ctx.restore();
}

/**
 * A box a `filter`'s colour functions are run over (Filter Effects 1, 13):
 * painted whole, as the group the filter makes it, on a surface of its
 * own, and the surface's pixels run through the matrices before it is
 * drawn — at the box's opacity, and through `through` where it turns.
 * Where the context runs a filter itself, canvas's `filter`, the surface is
 * drawn through it; elsewhere its pixels come back a round trip after they
 * are asked for, so they are read and kept (`src/html/filters.ts`), and
 * until a read arrives the box is drawn from the one before, or not at
 * all. True where it is drawn so, or is to draw nothing yet; false where
 * there is nothing to run, or no way to — the headless mock, a
 * box too large for a surface, an inline box, whose text is drawn on its
 * block's lines — and the caller paints the box as it is.
 */
function paintFiltered(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  through: Matrix | null,
  opacity: number,
): boolean {
  const colour = colourOf(box.style.filter!);
  if (!colour?.matrices.length) return false;
  const kept = filteredFor(ctx, box, options, through, colour);
  if (kept === null) return false;
  if (kept) drawThrough(ctx, kept.surface, through, kept.x, kept.y, opacity);
  return true;
}

/**
 * The surface a filtered box is drawn from (`paintFiltered`): the newest
 * pixels read for its element, run through the matrices it has now, and a
 * read asked for where those were not read under the key it draws under
 * now (`spriteKey`). Undefined where nothing the box's size has been read
 * yet, and nothing is drawn; null where no surface can be had.
 */
function filteredFor(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  through: Placed | null,
  colour: ColourFilter,
): Kept | null | undefined {
  const store = options.filters;
  if (!store || !options.surface || !ctx.drawImage) return null;
  if (box.kind === 'inline') return null;
  const own = through
    ? ownBounds(box)
    : {
        x: box.boundsX,
        y: box.boundsY,
        width: box.boundsWidth,
        height: box.boundsHeight,
      };
  const left = own.x + options.originX;
  const top = own.y + options.originY;
  const x0 = Math.floor(left);
  const y0 = Math.floor(top);
  if (!(own.width > 0 && own.height > 0)) return undefined;
  // a pixel more than the box each way, wherever within a pixel its corner
  // falls: a box moving a fraction at a time — a card lifted on hover —
  // came to one height and the next alternately, and what was read at the
  // other was no use to it
  const w = Math.ceil(own.width) + 1;
  const h = Math.ceil(own.height) + 1;
  if (w > RASTER_SIDE || h > RASTER_SIDE || w * h > RASTER_LIMIT) return null;
  if (through?.length === 6 && !fitsFixedPoint(through, x0, y0)) {
    return undefined;
  }
  // what the box draws, and not where within a pixel its corner falls,
  // which moves under it every frame of a transition (`placed`)
  const fx = left - x0;
  const fy = top - y0;
  let key = spriteKey(box, options, through, 0, 0);
  // a background fixed to the viewport in it is where the viewport is
  if (drawsAgainstViewport(box)) {
    key += ` ${options.viewport?.x ?? 0} ${options.viewport?.y ?? 0}`;
  }
  const kept = store.at(box.el ?? box, box.pseudo ?? '', box, w, h, key);
  // a context that runs a filter itself — react-x11's native ones, canvas's
  // `filter` — is handed the group this paint makes, and nothing lags
  if (!store.unfiltered && 'filter' in ctx) {
    if (!kept.fresh) {
      const group = store.group(kept, fx, fy);
      if (!group) return null;
      paintUnfaded(
        group.ctx as PaintContext,
        box,
        through
          ? onSurface(options, x0, y0, w, h)
          : inGroup(options, x0, y0, w, h),
      );
    }
    const out = store.through(kept, colour.css);
    if (out) {
      store.placed(kept, fx, fy);
      return {
        surface: out,
        x: left - kept.rawX,
        y: top - kept.rawY,
        width: w,
        height: h,
      };
    }
  }
  if (!kept.fresh && !kept.reading) {
    const surface = options.surface(w, h);
    if (!surface) return null;
    const on = surface.getContext('2d') as PaintContext;
    paintUnfaded(
      on,
      box,
      through
        ? onSurface(options, x0, y0, w, h)
        : inGroup(options, x0, y0, w, h),
    );
    if (!store.read(kept, surface, on, fx, fy)) return null;
  }
  // the newest pixels read for it, through the filter it has now: a read
  // under way lags what is drawn, and never the filter. One read with the
  // box's corner at another fraction of a pixel is drawn with that corner
  // where the box's is now: drawn at the box's whole pixel, a phone that
  // turned and rose on ekazinich.com's hover jumped a pixel at each frame
  // drawn from a read and back at each drawn from the next
  if (!kept.raw) return undefined;
  const surface = store.filtered(kept, colour.matrices, colour.key);
  if (!surface) return undefined;
  store.placed(kept, fx, fy);
  return {
    surface,
    x: left - kept.rawX,
    y: top - kept.rawY,
    width: w,
    height: h,
  };
}

/** What a kept surface's drawing depends on beyond its box's: whether it
 *  is drawn through a matrix, where its corner falls within a pixel, the
 *  display's scale, and the part of the box's text the selection covers,
 *  and in what colour. */
function spriteKey(
  box: Box,
  options: PaintOptions,
  through: Placed | null,
  fractionX: number,
  fractionY: number,
): string {
  let selected = '';
  const range = options.selection;
  if (range && range.end > range.start) {
    const from = Math.max(range.start, box.subtreeTextStart);
    const to = Math.min(range.end, box.subtreeTextEnd);
    if (to > from) selected = `${from}-${to} ${options.selectionColor}`;
  }
  const kind = through ? 'turned' : 'group';
  return `${kind} ${fractionX} ${fractionY} ${options.scale ?? 1} ${selected}`;
}

/** Whether a box or anything in it draws a background fixed to the
 *  viewport, which a scroll moves under it. */
export function drawsAgainstViewport(box: Box): boolean {
  const stack: Box[] = [box];
  while (stack.length) {
    const at = stack.pop()!;
    const style = at.style;
    if (
      style.backgroundAttachment === 'fixed' ||
      style.backgroundAttachments?.includes('fixed')
    ) {
      return true;
    }
    for (const child of at.children) stack.push(child);
  }
  return false;
}

/** Whether a box holds one fixed to the viewport, which is drawn where the
 *  viewport is now — past the ink the box was laid out with, once the
 *  document scrolls — and so is no part of a surface the size of that ink.
 *  A transform holds the fixed boxes in it, and an opacity does not. */
function holdsViewportFixed(box: Box, options: PaintOptions): boolean {
  if (!options.fixed) return false;
  for (const fixed of options.fixed) {
    for (let at = fixed.parent; at; at = at.parent) if (at === box) return true;
  }
  return false;
}

/**
 * A box under full opacity painted whole on a surface of its own, and the
 * surface drawn at its opacity: the group CSS Color 4 (3.2) makes it, where
 * fading each thing it draws on its own showed the one under it through it —
 * a card's background through its text, a header through the badge over
 * it. The surface is the part of the box's ink the damage reaches; while
 * the box's opacity animates, all of it, kept from one frame to the next
 * (`paintSprite`), so a frame of a fade draws the surface at another
 * opacity and paints nothing. A positioned box in it that escapes a clip
 * around it is painted where that clip ends, outside the group, as it was.
 * True where the box is drawn so; false where there is no surface to be
 * had — the headless mock — or a part too large for one, where nothing
 * it draws can fall on anything else it draws (`drawsOverItself`), which
 * fading each thing does as well, where it holds a box fixed to the
 * viewport (`holdsViewportFixed`), or where the context is a native one
 * (`groupsOnSurfaces`), and the caller fades each.
 */
function paintGroup(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  opacity: number,
): boolean {
  if (!options.surface || !groupsOnSurfaces(ctx)) return false;
  if (!drawsOverItself(ctx, box, options) || holdsViewportFixed(box, options)) {
    return false;
  }
  if (options.sprites && paintSprite(ctx, box, options, null, opacity)) {
    return true;
  }
  let x0 = Math.floor(box.boundsX + options.originX);
  let y0 = Math.floor(box.boundsY + options.originY);
  let x1 = Math.ceil(box.boundsX + box.boundsWidth + options.originX);
  let y1 = Math.ceil(box.boundsY + box.boundsHeight + options.originY);
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
  if (w > RASTER_SIDE || h > RASTER_SIDE || w * h > RASTER_LIMIT) return false;
  const surface = options.surface(w, h);
  if (!surface) return false;
  try {
    paintUnfaded(
      surface.getContext('2d') as PaintContext,
      box,
      inGroup(options, x0, y0, w, h),
    );
    drawThrough(ctx, surface, null, x0, y0, opacity);
    return true;
  } finally {
    surface.destroy?.();
  }
}

/**
 * `paintGroup` for a box drawn through its matrix by the context itself
 * (`paintTransformed`): drawn through the matrix onto a surface the size of
 * the part of where it lands that the damage reaches, as the window would
 * have it, and the surface drawn at the box's opacity. Its text is turned
 * as the context turns text, and nothing is resampled.
 */
function paintGroupThrough(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  inside: PaintOptions,
  through: Matrix,
  opacity: number,
): boolean {
  if (!options.surface || !groupsOnSurfaces(ctx)) return false;
  if (!drawsOverItself(ctx, box, options)) return false;
  // a box that turns has its own ink bounds where it is drawn
  let x0 = Math.floor(box.boundsX + options.originX);
  let y0 = Math.floor(box.boundsY + options.originY);
  let x1 = Math.ceil(box.boundsX + box.boundsWidth + options.originX);
  let y1 = Math.ceil(box.boundsY + box.boundsHeight + options.originY);
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
  if (w > RASTER_SIDE || h > RASTER_SIDE || w * h > RASTER_LIMIT) return false;
  const surface = options.surface(w, h);
  if (!surface) return false;
  try {
    // A surface's context may be its one state for good (the Cocoa one
    // is): the matrix is put back as it was.
    const on = surface.getContext('2d') as PaintContext;
    on.save();
    on.translate!(-x0, -y0);
    on.transform!(
      through[0],
      through[1],
      through[2],
      through[3],
      through[4],
      through[5],
    );
    // what it draws clear of the surface is clear of the surface's corner
    paintUnfaded(on, box, {
      ...inside,
      matrix: multiply([1, 0, 0, 1, -x0, -y0], through),
    });
    on.restore();
    drawThrough(ctx, surface, null, x0, y0, opacity);
    return true;
  } finally {
    surface.destroy?.();
  }
}

/**
 * Whether a context fades a group on a surface of its own (`paintGroup`):
 * ntk's, which X11 and Wayland draw with, whose server composites a surface
 * in a request and sets a box's glyphs again from scratch; and a native one
 * that says a surface under an alpha costs about what it costs at 1
 * (`fadesSurfacesCheaply`, react-x11#810) — macOS over a bridge that scales
 * a surface's pixels rather than drawing it through CoreGraphics' own
 * alpha, which cost a faded card twice what drawing it again did. A native
 * context that does not say so — Windows, and macOS over an older bridge —
 * fades each thing a box draws, as every context did.
 */
function groupsOnSurfaces(ctx: PaintContext): boolean {
  if (!ctx.drawImage) return false;
  return ctx.scalesText !== true || ctx.fadesSurfacesCheaply === true;
}

/** `onSurface` for a group: what escapes a clip around the box is painted
 *  where that clip ends, by the box painting the clip, as it was. */
function inGroup(
  options: PaintOptions,
  x0: number,
  y0: number,
  width: number,
  height: number,
): PaintOptions {
  return { ...onSurface(options, x0, y0, width, height), clips: options.clips };
}

/** How many boxes `drawsOverItself` looks through before it takes the box
 *  for one that does. */
const OVERLAP_PROBE = 64;

/**
 * Whether two things a box draws can fall on one pixel — a background under
 * its text, borders round a background, a child over its parent — where
 * fading each thing on its own shows the one under it through it. One thing
 * drawn — a background alone, text alone, an image alone, the backdrop a
 * dialog dims a page with — is faded the same either way, and needs no
 * surface. A box with more than `OVERLAP_PROBE` in it is taken for one
 * that does.
 *
 * An inline box's text, its background and borders, and what is on its
 * lines are drawn on its block's lines, each faded there (`inlineFade`),
 * and none of it in its own paint: what that draws, and a group of its
 * would hold, is the floats and the positioned boxes in it (`paintedApart`).
 */
function drawsOverItself(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
): boolean {
  let things = 0;
  let looked = 0;
  const stack: Box[] = box.kind === 'inline' ? paintedApart(box) : [box];
  for (const at of stack) {
    // the text is one thing, and the selection under it another — and the
    // text is a group of its own where the context does not fade glyphs
    if (at.subtreeTextEnd > at.subtreeTextStart) {
      things += fadesGlyphs(ctx) ? 1 : 2;
      const range = options.selection;
      if (
        range &&
        range.start < at.subtreeTextEnd &&
        range.end > at.subtreeTextStart
      ) {
        things += 1;
      }
    }
  }
  if (things > 1) return true;
  while (stack.length) {
    const at = stack.pop()!;
    looked += 1;
    if (looked > OVERLAP_PROBE) return true;
    things += thingsDrawn(at);
    if (things > 1) return true;
    for (const child of at.children) stack.push(child);
  }
  return false;
}

/** What an inline box's own paint draws (`paintContent`): the floats in it,
 *  through the inline boxes in it, and the positioned boxes it paints as
 *  the stacking context its opacity makes it (`stackLayers`). */
function paintedApart(box: Box): Box[] {
  const out = [...(NEGATIVE.get(box) ?? []), ...(STACKED.get(box) ?? [])];
  const stack = [...box.children];
  while (stack.length) {
    const at = stack.pop()!;
    if (at.isFloat) out.push(at);
    else if (at.kind === 'inline') stack.push(...at.children);
  }
  return out;
}

/**
 * Whether a context draws glyphs at its `globalAlpha`: the native ones do
 * (`scalesText`). ntk's draws a text layout's glyphs in its runs' colours
 * whatever alpha the context holds, so on X11 and Wayland text in a faded
 * element is faded only by the composite of the group it is drawn in, and
 * a paragraph at `opacity: .5` drew at full strength.
 */
function fadesGlyphs(ctx: PaintContext): boolean {
  return ctx.scalesText === true;
}

/** What a box draws of its own, for `drawsOverItself`: borders twice, which
 *  meet at the corners, and a replaced element other than an image twice —
 *  a drawing's shapes, a control's parts. Text takes the style of the box
 *  it is set in, whose background and borders it does not draw. */
function thingsDrawn(box: Box): number {
  if (box.kind === 'text' || box.kind === 'break') return 0;
  const style = box.style;
  if (style.visibility !== 'visible') return 0;
  let things = 0;
  if (
    !isTransparent(style.backgroundColor) ||
    style.backgroundImage !== null ||
    style.backgroundImages !== null ||
    style.backgroundGradient !== null
  ) {
    things += 1;
  }
  if (box.borderTop || box.borderRight || box.borderBottom || box.borderLeft) {
    things += 2;
  }
  if (box.collapsed) things += 2;
  if (style.boxShadow !== null) things += 1;
  if (style.outlineStyle !== 'none' && style.outlineWidth > 0) things += 1;
  if (style.textShadow !== null || style.textDecorationLine !== 'none') {
    things += 1;
  }
  if (box.marker) things += 1;
  if (box.replaced !== 'none') things += box.replaced === 'image' ? 1 : 2;
  return things;
}

/** The options a box is painted with on a surface `width` by `height`
 *  whose corner is at (`x0`, `y0`) in the window: its own coordinates, the
 *  window's moved to its corner. */
function onSurface(
  options: PaintOptions,
  x0: number,
  y0: number,
  width: number,
  height: number,
): PaintOptions {
  return {
    ...options,
    originX: options.originX - x0,
    originY: options.originY - y0,
    damage: { x: 0, y: 0, width, height },
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
    // drawn on the surface as laid out, and the surface through the matrix
    matrix: undefined,
  };
}

/** Whether a surface at (`x0`, `y0`) can be drawn through `through`: the
 *  picture's transform the context makes of it, the inverse of the matrix
 *  after the surface's place in it, fits the fixed point it is sent in. */
function fitsFixedPoint(through: Matrix, x0: number, y0: number): boolean {
  const placed = invert([
    through[0],
    through[1],
    through[2],
    through[3],
    through[0] * x0 + through[2] * y0 + through[4],
    through[1] * x0 + through[3] * y0 + through[5],
  ]);
  return !!placed && !placed.some((n) => Math.abs(n) > FIXED_LIMIT);
}

/** A surface with its corner at (`x0`, `y0`) drawn through `through`, where
 *  there is one, at `opacity` times the context's. */
function drawThrough(
  ctx: PaintContext,
  surface: Offscreen,
  through: Matrix | null,
  x0: number,
  y0: number,
  opacity: number,
): void {
  ctx.save();
  if (through) {
    ctx.transform!(
      through[0],
      through[1],
      through[2],
      through[3],
      through[4],
      through[5],
    );
  }
  if (opacity < 1 && typeof ctx.globalAlpha === 'number') {
    ctx.globalAlpha *= opacity;
  }
  ctx.drawImage!(surface, x0, y0);
  ctx.restore();
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
  if (path && pushPathClip(ctx, path)) pushed += 1;
  return pushed;
}

/** Cut what follows to a `clip-path`: its polygon, where it is one and the
 *  context draws one, and its rectangle elsewhere. */
function pushPathClip(ctx: PaintContext, path: PathClip): boolean {
  const points = path.polygon;
  if (!points || !ctx.moveTo || !ctx.lineTo) {
    return pushClip(ctx, path.rect, path.radii);
  }
  if (!ctx.beginPath || !ctx.clip) return false;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) {
    ctx.lineTo(points[i], points[i + 1]);
  }
  ctx.closePath?.();
  if (path.rule === 'evenodd') ctx.clip('evenodd');
  else ctx.clip();
  return true;
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
    layer.backgroundImage = urlImageOf(image);
    layer.backgroundGradient = gradientOf(image);
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
  const drawable = layers.some((layer) => {
    if (layer.backgroundGradient) return true;
    const url = urlOf(layer.backgroundImage);
    return url !== null && !!options.backgroundImageFor?.(url);
  });
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
    const on = onSurface(options, x0, y0, w, h);
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
  const table = clips && box.kind === 'table';
  if (table) paintFlow(ctx, box, options, CAPTIONS);
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

  // its marker under its clip with the rest, an outside one among it, as
  // all three browsers cut it
  if (visible && box.marker) {
    paintMarker(ctx, box.marker, options, box.style.colorScheme);
  }
  paintFlow(ctx, box, options, table ? GRID : ALL_PARTS);

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
    const area = clipArea(frame, options, layer, true);
    if (area) {
      paintBackgroundImage(
        ctx,
        layer,
        area,
        originBox(frame, options, layer),
        options,
        area.corners,
      );
    }
  };
}

/** How far past its shape a shadow's blur shows: three standard deviations,
 *  the blur being two (CSS Backgrounds 3, 7.1.1). */
function shadowReach(blur: number): number {
  return blur > 0 ? Math.ceil(blur * 1.5) : 0;
}

/** How far past its border box a box's outer shadows fall on each side, at
 *  most: by their offset, spread and blur. Made once a list. */
interface Outsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const OUTSETS = new WeakMap<readonly BoxShadow[], Outsets>();

function shadowOutsets(shadows: readonly BoxShadow[]): Outsets {
  let out = OUTSETS.get(shadows);
  if (out) return out;
  out = { left: 0, top: 0, right: 0, bottom: 0 };
  for (const s of shadows) {
    if (s.inset) continue;
    const reach = s.spread + shadowReach(s.blur);
    out.left = Math.max(out.left, reach - s.x);
    out.right = Math.max(out.right, reach + s.x);
    out.top = Math.max(out.top, reach - s.y);
    out.bottom = Math.max(out.bottom, reach + s.y);
  }
  OUTSETS.set(shadows, out);
  return out;
}

const SQUARE: Corners = { x: [0, 0, 0, 0], y: [0, 0, 0, 0] };

/** A rectangle with no area, where a ring has no inside. */
const NOWHERE: Rect = { x: 0, y: 0, width: 0, height: 0 };

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
 * the box's own opaque colour usually sees to; where it does not, a hard
 * one with square corners is drawn as the bands of it beside the box, and
 * any other is clipped out of the box, a clip the size of the window on
 * X11. An inset one is clipped to the padding box. The box is a block's,
 * or the one an inline box's fragment casts its shadows from
 * (`paintFragmentShadows`).
 */
function paintShadows(
  ctx: PaintContext,
  box: Frame,
  options: PaintOptions,
  inset: boolean,
): void {
  const shadows = box.style.boxShadow!;
  if (!ctx.beginPath || !ctx.fill || !ctx.roundRect) return;
  // on a layer of their own, the render server's to draw
  if (!inset && options.shadowless?.has(box as Box)) return;
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
      // Cut, as a background is (`clampArea`), to what the paint reaches
      // and as far again as the blur does, so the cut edges cast nothing
      // on it, and the box with it, which a ring is the band outside and
      // the shadow is clipped out of. A shadow down a box thousands of
      // pixels tall went to the server whole, and its outline, sent in
      // 16.16 fixed point, threw.
      const [cut, own] = clampPair(
        options,
        reach + CLAMP_PAD,
        { rect: shape, corners: around },
        { rect, corners },
      );
      if (!cut) continue;
      const { x, y, width, height } = cut.rect;
      const color = inkColor(s.color, style.color);
      if (!(s.blur > 0) && !s.x && !s.y && s.spread >= 0 && !covered) {
        // a ring about the box: the band between it and the spread
        ctx.fillStyle = color;
        fillRing(
          ctx,
          cut.rect,
          cut.corners,
          own ? own.rect : NOWHERE,
          own ? own.corners : SQUARE,
        );
        continue;
      }
      if (!(s.blur > 0) && covered) {
        // a hard shadow, under a box that hides what falls under it
        fillShadow(ctx, options, s, color, () => {
          roundedRect(ctx, x, y, width, height, cut.corners);
        });
        continue;
      }
      if (
        !(s.blur > 0) &&
        squareCorners(cut.corners) &&
        (!own || squareCorners(own.corners))
      ) {
        // A hard shadow with square corners, under a box that shows what
        // is behind it: the shape less the part of the box over it, which
        // needs no clip either. The line a link's `0 2px 0` draws under
        // each of its fragments is one, and clipped out of the box, each
        // was a mask the size of the window on X11.
        ctx.fillStyle = color;
        fillOutside(ctx, cut.rect, own ? overlapOf(cut.rect, own.rect) : null);
        continue;
      }
      const cast = () =>
        fillShadow(
          ctx,
          options,
          s,
          color,
          (mx, my) => {
            shadowShape(ctx, x + mx, y + my, width, height, cut.corners);
          },
          { x, y, width, height },
        );
      // what of the shadow falls under the box is not drawn
      if (covered || !ctx.clip || !ctx.rect || !ctx.save) cast();
      else {
        castOutside(
          ctx,
          {
            x: x - reach - 1,
            y: y - reach - 1,
            width: width + 2 * reach + 2,
            height: height + 2 * reach + 2,
          },
          own,
          cast,
        );
      }
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
    // The hole the shadow is cast around, moved and shrunk by the spread,
    // cut with the padding box: made from the cut one, it was a spread in
    // from the cut rather than from the box's edge, and a spread wider
    // than the margin left none.
    const [area, hole] = clampPair(
      options,
      furthest + CLAMP_PAD,
      { rect: pad, corners: inner },
      {
        rect: {
          x: pad.x + s.x + s.spread,
          y: pad.y + s.y + s.spread,
          width: Math.max(0, pad.width - 2 * s.spread),
          height: Math.max(0, pad.height - 2 * s.spread),
        },
        corners: grownCorners(inner, -s.spread),
      },
    );
    if (!area) continue;
    if (!(s.blur > 0) && !s.x && !s.y && s.spread >= 0) {
      // Tailwind's `ring-inset`: a band inside the padding edge
      ctx.fillStyle = color;
      fillRing(
        ctx,
        area.rect,
        area.corners,
        hole ? hole.rect : NOWHERE,
        hole ? hole.corners : SQUARE,
      );
      continue;
    }
    if (!ctx.clip || !ctx.save || !ctx.rect) continue;
    const { x, y, width, height } = area.rect;
    ctx.save();
    ctx.beginPath();
    roundedRect(ctx, x, y, width, height, area.corners);
    ctx.clip();
    // a frame around the hole, as wide as the blur and the offset reach
    const reach = shadowReach(s.blur) + Math.abs(s.x) + Math.abs(s.y) + 1;
    const frame = {
      x: x - reach,
      y: y - reach,
      width: width + 2 * reach,
      height: height + 2 * reach,
    };
    fillShadow(
      ctx,
      options,
      s,
      color,
      (mx, my) => {
        ctx.rect!(frame.x + mx, frame.y + my, frame.width, frame.height);
        if (hole) {
          const { rect: r } = hole;
          shadowShape(ctx, r.x + mx, r.y + my, r.width, r.height, hole.corners);
        }
      },
      frame,
      'evenodd',
    );
    ctx.restore();
  }
}

/**
 * Fill a shadow's shape: in its colour where it has no blur, and otherwise
 * as the context's shadow of the shape drawn clear of the window, where
 * `aside` moves it from `bounds`, so that only the shadow lands.
 */
/**
 * `cast`, an outer shadow, drawn in `bounds` less `own`, the box it is cast
 * from, which shows what falls under it (CSS Backgrounds 3, 7.1.1).
 *
 * Cut out of `bounds` with one clip, a rounded box makes the clip a mask
 * the size of `bounds` on macOS, and CoreGraphics draws all of a shadow
 * through it at four times what it costs through a rectangle: a card's
 * 200px glow at 2x took 16 ms where it takes 4.5, at every frame of the
 * hover that brings it in. So where the context's matrix only moves and
 * scales, the shadow is drawn in the bands of `bounds` around the box,
 * each clipped to a rectangle, and over the box itself clipped by its
 * outline as well, so the mask is the box's size. Each rectangle is of
 * whole pixels of the surface, rounded out from the box, since an edge a
 * fraction of a pixel in is a mask too.
 */
function castOutside(
  ctx: PaintContext,
  bounds: Rect,
  own: { rect: Rect; corners: Corners } | null,
  cast: () => void,
): void {
  const outline = (): void => {
    ctx.beginPath!();
    ctx.rect!(bounds.x, bounds.y, bounds.width, bounds.height);
    if (own) {
      const { rect: r } = own;
      roundedRect(ctx, r.x, r.y, r.width, r.height, own.corners, true, true);
    }
    ctx.clip!();
  };
  const m = ctx.getTransform?.();
  if (
    !own ||
    !m ||
    !ctx.setTransform ||
    m.b !== 0 ||
    m.c !== 0 ||
    !(m.a > 0 && m.d > 0)
  ) {
    ctx.save!();
    outline();
    cast();
    ctx.restore!();
    return;
  }
  const r = own.rect;
  const x0 = Math.floor(m.a * bounds.x + m.e);
  const y0 = Math.floor(m.d * bounds.y + m.f);
  const x1 = Math.ceil(m.a * (bounds.x + bounds.width) + m.e);
  const y1 = Math.ceil(m.d * (bounds.y + bounds.height) + m.f);
  const clampX = (v: number) => Math.min(x1, Math.max(x0, v));
  const clampY = (v: number) => Math.min(y1, Math.max(y0, v));
  const bx0 = clampX(Math.floor(m.a * r.x + m.e));
  const by0 = clampY(Math.floor(m.d * r.y + m.f));
  const bx1 = clampX(Math.ceil(m.a * (r.x + r.width) + m.e));
  const by1 = clampY(Math.ceil(m.d * (r.y + r.height) + m.f));
  // above, below, to the left, to the right, and over the box
  const parts: [number, number, number, number][] = [
    [x0, y0, x1, by0],
    [x0, by1, x1, y1],
    [x0, by0, bx0, by1],
    [bx1, by0, x1, by1],
    [bx0, by0, bx1, by1],
  ];
  for (let i = 0; i < parts.length; i += 1) {
    const [px0, py0, px1, py1] = parts[i];
    if (!(px1 > px0 && py1 > py0)) continue;
    ctx.save!();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath!();
    ctx.rect!(px0, py0, px1 - px0, py1 - py0);
    ctx.clip!();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    if (i === 4) outline();
    cast();
    ctx.restore!();
  }
}

function fillShadow(
  ctx: PaintContext,
  options: PaintOptions,
  s: BoxShadow,
  color: string,
  shape: (mx: number, my: number) => void,
  bounds: Rect | null = null,
  rule: 'nonzero' | 'evenodd' = 'nonzero',
): void {
  if (!(s.blur > 0) || !bounds) {
    ctx.fillStyle = color;
    ctx.beginPath!();
    shape(0, 0);
    ctx.fill!(rule);
    return;
  }
  const move = aside(
    options.matrix,
    bounds.x,
    bounds.y,
    bounds.x + bounds.width + shadowReach(s.blur),
    bounds.y + bounds.height,
    0,
    0,
    s.blur,
  );
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = move.blur;
  ctx.shadowOffsetX = move.offsetX;
  ctx.shadowOffsetY = move.offsetY;
  ctx.fillStyle = '#000000';
  ctx.beginPath!();
  shape(move.x, move.y);
  ctx.fill!(rule);
  ctx.restore();
}

/** Where `aside` moves a drawing, and the shadow that lands it back. */
interface Aside {
  /** The move, in the coordinates painted in. */
  x: number;
  y: number;
  /** The shadow's offset and blur, in the window's. */
  offsetX: number;
  offsetY: number;
  blur: number;
}

/**
 * How a drawing whose shadow alone is to land is drawn clear of the window:
 * moved left, in the window, until the right edge of what it covers — `x0`
 * to `x1` across, `y0` to `y1` down, in the coordinates painted in — is
 * past the window's left, and its shadow offset back by as much, with the
 * shadow's own offset (`sx`, `sy`) and `blur` on top.
 *
 * A context takes a shadow's offset and blur in the window's coordinates,
 * whatever matrix it draws through (HTML, "shadows"), where a transformed
 * box is rendered, shadows and all, in the coordinates its transform makes
 * (CSS Transforms 1, 3). So under `matrix` the move is made in the window
 * and taken back through it, the shadow's offset is carried out through
 * it, and its blur scaled as it scales a length — the square root of what
 * it does to an area. Moved in the box's own coordinates and offset back
 * by as much in the window's, a card drawn at 101% cast its glow a
 * hundredth of the way across the window short of itself.
 */
function aside(
  matrix: Matrix | undefined,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  sx: number,
  sy: number,
  blur: number,
): Aside {
  const back = matrix && invert(matrix);
  if (!matrix || !back) {
    const shift = Math.ceil(x1) + 1;
    return { x: -shift, y: 0, offsetX: shift + sx, offsetY: sy, blur };
  }
  const reach = mapRect(matrix, x0, y0, x1 - x0, y1 - y0);
  const shift = Math.ceil(reach.x + reach.width) + 1;
  const [a, b, c, d] = matrix;
  return {
    x: -shift * back[0],
    y: -shift * back[1],
    offsetX: shift + a * sx + c * sy,
    offsetY: b * sx + d * sy,
    blur: blur * Math.sqrt(Math.abs(a * d - b * c)),
  };
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

/** Whether no corner is rounded: none has a radius both across and down. */
function squareCorners(c: Corners): boolean {
  for (let i = 0; i < 4; i += 1) if (c.x[i] > 0 && c.y[i] > 0) return false;
  return true;
}

/** Where two rectangles overlap: null where they do not. */
function overlapOf(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/**
 * A rectangle less a hole in it, in the colour already set: the bands
 * above, below and to either side of the hole, side by side in one path.
 * Not a rectangle and its hole filled even-odd, which is a ring's
 * (`fillRing`): where the hole shares an edge with the rectangle off the
 * pixel grid, as a shadow offset 1.5px shares the box's sides, ntk covers
 * the pixels along it once for each and draws them full, a hairline down
 * the side.
 */
function fillOutside(ctx: PaintContext, outer: Rect, hole: Rect | null): void {
  ctx.beginPath!();
  if (!hole) {
    ctx.rect!(outer.x, outer.y, outer.width, outer.height);
    ctx.fill!();
    return;
  }
  const right = outer.x + outer.width;
  const bottom = outer.y + outer.height;
  const holeRight = hole.x + hole.width;
  const holeBottom = hole.y + hole.height;
  if (hole.y > outer.y) {
    ctx.rect!(outer.x, outer.y, outer.width, hole.y - outer.y);
  }
  if (holeBottom < bottom) {
    ctx.rect!(outer.x, holeBottom, outer.width, bottom - holeBottom);
  }
  if (hole.x > outer.x) {
    ctx.rect!(outer.x, hole.y, hole.x - outer.x, hole.height);
  }
  if (holeRight < right) {
    ctx.rect!(holeRight, hole.y, right - holeRight, hole.height);
  }
  ctx.fill!();
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

/** Whether a child is a box of its parent's flow, painted in the flow's
 *  passes rather than whole in its place: its background with the flow's
 *  backgrounds, its lines with the flow's lines, and what it holds in the
 *  same passes at any depth (CSS 2.1 Appendix E, steps 4 to 7). That is an
 *  in-flow block, one that clips among them, and a table with its parts
 *  and captions. It is not an item of a flex box, which is painted whole
 *  (CSS Flexbox 5.4), nor the root element holding boxes below its flow,
 *  which it paints itself (`hoistNegative`). One that is a stacking context
 *  is painted with the positioned boxes, and is not asked (`layered`). */
function inFlow(parent: Box, child: Box, options: PaintOptions): boolean {
  if (parent.kind === 'flex') return false;
  switch (child.kind) {
    case 'block':
    case 'table':
    case 'table-row-group':
    case 'table-row':
    case 'table-cell':
    case 'table-caption':
      return !(options.negative && NEGATIVE.has(child));
    default:
      return false;
  }
}

/** How opaque a box is drawn: its own `opacity`, a filter's `opacity()`
 *  functions, and the opacity it takes from an inline box it broke in
 *  pieces (`FADED_BLOCKS`). */
function opacityOf(box: Box): number {
  const style = box.style;
  const own =
    style.filter === null
      ? style.opacity
      : style.opacity * (colourOf(style.filter)?.alpha ?? 1);
  const taken = FADED_BLOCKS.get(box);
  return taken === undefined ? own : own * taken;
}

/** What a filter's colour functions come to, kept by the list: asked at
 *  each paint of a box with one. */
const COLOUR_FILTERS = new WeakMap<
  readonly FilterFunction[],
  ColourFilter | null
>();

function colourOf(list: readonly FilterFunction[]): ColourFilter | null {
  let known = COLOUR_FILTERS.get(list);
  if (known === undefined) {
    known = colourFilter(list);
    COLOUR_FILTERS.set(list, known);
  }
  return known;
}

/** Whether a child is a flex box of its parent's flow, or a grid. Its
 *  background and borders go with the flow's backgrounds, in the
 *  document's order. Its items go with the flow's lines, under its clip
 *  where it clips, each painted whole as an inline block is (CSS 2.1
 *  Appendix E, CSS Flexbox 5.4). Painted whole in its place, its
 *  background covered a block after it that a negative margin drew up
 *  over it. One that is a stacking context is painted with the positioned
 *  boxes (`layered`). */
function flowFlex(parent: Box, child: Box, options: PaintOptions): boolean {
  if (child.kind !== 'flex' || parent.kind === 'flex') return false;
  // the root element holding boxes below its flow paints them itself
  return !(options.negative && NEGATIVE.has(child));
}

/** Which of a box's children a pass over its flow takes: all of them, or,
 *  of a table that clips, either its captions alone, which are outside the
 *  table box and its clip (the CSS 2.1 errata, 11.1.1), or all but them. */
type Part = 0 | 1 | 2;
const ALL_PARTS: Part = 0;
const CAPTIONS: Part = 1;
const GRID: Part = 2;

/** What a pass over a flow leaves to a later pass: the floats it met to the
 *  floats' pass, the outlines to the outlines'. Each is kept with the boxes
 *  between it and the flow's own box that clip what they hold, outermost
 *  first, and is painted in its turn under their clips (`paintLater`). */
interface Later {
  boxes: Box[];
  clips: (readonly Box[])[];
}

/** The first pass's state: the floats it leaves to theirs, and the boxes
 *  that clip it has walked into, with their clips, which are pushed only
 *  once something under them draws (`pushEntered`). A box of text and
 *  images draws nothing in this pass, and on X11 a rounded clip is a mask
 *  the size of the window, made again at every restore: pushed whether or
 *  not anything drew, a page of rounded cards painted an eighth slower. */
interface BackgroundPass {
  floats: Later;
  entered: { box: Box; clip: ClipEdge }[];
  /** How many of `entered` are pushed, the outermost first. */
  pushed: number;
}

/**
 * The flow a box holds, in CSS 2.1 Appendix E's order: the backgrounds and
 * borders of its in-flow blocks and tables, then its floats, then the lines
 * of them all, then their outlines. The positioned boxes in it are left to
 * the stacking context that paints them (`stackLayers`). Painted a block
 * at a time instead, a float was covered by the background of every block
 * after it, so the shaded paragraph beside a floated image hid the image,
 * and a block's text was covered by the next one's background where a
 * negative margin overlapped them.
 *
 * A box that clips is in the flow too, unless it is a stacking context. Its
 * own background goes with the flow's, and what it holds goes in each pass
 * under its clip (`flowClip`). A table is the same: its backgrounds, its
 * parts' and its cells' with the blocks', then its collapsed borders over
 * them, its cells' floats with the floats and their lines with the lines.
 * Chrome, Firefox and Safari paint both so. Painted whole at the lines'
 * turn, a box that clips, or a table, covered a block after it that a
 * negative margin drew up over it, and the hit test found that block.
 */
function paintFlow(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  part: Part,
): void {
  const floats: Later = { boxes: [], clips: [] };
  const pass: BackgroundPass = { floats, entered: [], pushed: 0 };
  paintFlowBackgrounds(ctx, box, options, NO_CLIPS, part, pass);
  if (
    box.collapsed &&
    part !== CAPTIONS &&
    box.style.visibility === 'visible'
  ) {
    paintCollapsedBorders(ctx, box, options);
  }
  paintLater(ctx, floats, options, true);
  // a hidden box's text is drawn in no ink, so that a visible element's in
  // it is drawn (`runFor`)
  if (box.lines) paintLines(ctx, box, options);
  const outlines: Later = { boxes: [], clips: [] };
  paintFlowLines(ctx, box, options, NO_CLIPS, part, outlines);
  // the outlines of the blocks in the flow over all of its lines, and under
  // its positioned boxes, as browsers draw them (CSS 2.1 Appendix E, step
  // 10 left the choice open): drawn after each block's own lines, an
  // outline went under an inline-block the next block held
  paintLater(ctx, outlines, options, false);
}

/** Whether a pass takes a child (`Part`). */
function takes(part: Part, child: Box): boolean {
  return (
    part === ALL_PARTS ||
    (child.kind === 'table-caption') === (part === CAPTIONS)
  );
}

/**
 * The first pass over a box's flow: the backgrounds and borders of its
 * blocks and tables, in document order and at any depth. A table's
 * collapsed borders follow its cells' backgrounds and the blocks in them.
 * The floats met on the way are kept for their own pass. A child that is no
 * box of the flow is left for the last pass, where it is painted whole
 * among the lines: its text is text, over every block background, and it
 * stands beside the floats rather than under them.
 */
function paintFlowBackgrounds(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  clips: readonly Box[],
  part: Part,
  pass: BackgroundPass,
): void {
  for (const child of paintedChildren(box, options)) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (!takes(part, child)) continue;
    if (layered(box, child) || onLine(box, child)) continue;
    if (CLAMPED.has(child)) continue;
    if (child.isFloat) {
      pass.floats.boxes.push(child);
      pass.floats.clips.push(clips);
      continue;
    }
    if (flowFlex(box, child, options)) {
      if (child.style.visibility === 'visible' && intersects(child, options)) {
        if (pass.pushed < pass.entered.length && drawsOwn(child)) {
          pushEntered(ctx, options, pass);
        }
        paintOwnBackground(ctx, child, options);
      }
      continue;
    }
    if (!inFlow(box, child, options) || !intersects(child, options)) continue;
    if (child.kind === 'table-cell' && COLLAPSED_CELLS.has(child)) continue;
    const visible = child.style.visibility === 'visible';
    if (visible) {
      if (pass.pushed < pass.entered.length && drawsOwn(child)) {
        pushEntered(ctx, options, pass);
      }
      paintOwnBackground(ctx, child, options);
    }
    // what it holds, under its clip where it clips, in a function of its
    // own: each name more in this one is stack a level of nesting takes
    if (clipsOverflow(child)) {
      paintClippedBackgrounds(ctx, child, options, clips, pass);
      continue;
    }
    paintFlowBackgrounds(ctx, child, options, clips, ALL_PARTS, pass);
    if (child.collapsed && visible) {
      pushEntered(ctx, options, pass);
      paintCollapsedBorders(ctx, child, options);
    }
  }
}

/** The first pass through a box of the flow that clips: a table's
 *  captions, which are outside its clip, and then what it holds under its
 *  clip, a table's collapsed borders among it. */
function paintClippedBackgrounds(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  clips: readonly Box[],
  pass: BackgroundPass,
): void {
  const table = box.kind === 'table';
  if (table) paintFlowBackgrounds(ctx, box, options, clips, CAPTIONS, pass);
  const clip = flowClip(box, options);
  if (!clip) return;
  const entered = pass.entered;
  entered.push({ box, clip });
  const inner = [...clips, box];
  paintFlowBackgrounds(
    ctx,
    box,
    options,
    inner,
    table ? GRID : ALL_PARTS,
    pass,
  );
  if (box.collapsed && box.style.visibility === 'visible') {
    pushEntered(ctx, options, pass);
    paintCollapsedBorders(ctx, box, options);
  }
  if (pass.pushed === entered.length) {
    popFlowClip(ctx, options, false);
    pass.pushed -= 1;
  }
  entered.pop();
}

/** Push the clips of the boxes the first pass has walked into that are not
 *  pushed yet, before something under them draws (`BackgroundPass`). */
function pushEntered(
  ctx: PaintContext,
  options: PaintOptions,
  pass: BackgroundPass,
): void {
  for (; pass.pushed < pass.entered.length; pass.pushed += 1) {
    const { box, clip } = pass.entered[pass.pushed];
    pushFlowClip(ctx, box, clip, options, false);
  }
}

/** Whether a box draws anything of its own in the first pass, as far as its
 *  style says (`paintOwnBackground`): a background, a border or a shadow,
 *  and a table its parts' backgrounds. */
function drawsOwn(box: Box): boolean {
  const style = box.style;
  return (
    !isTransparent(style.backgroundColor) ||
    style.backgroundImage !== null ||
    style.backgroundImages !== null ||
    style.backgroundGradient !== null ||
    style.boxShadow !== null ||
    style.borderImage.source !== null ||
    box.borderTop > 0 ||
    box.borderRight > 0 ||
    box.borderBottom > 0 ||
    box.borderLeft > 0 ||
    box.kind === 'table'
  );
}

/** The last pass over a box's flow: the markers and lines of its blocks and
 *  tables, and the children painted whole, in document order and at any
 *  depth, over the floats. The outlines met on the way are kept for their
 *  own pass. */
function paintFlowLines(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  clips: readonly Box[],
  part: Part,
  outlines: Later,
): void {
  for (const child of paintedChildren(box, options)) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (!takes(part, child)) continue;
    if (layered(box, child) || onLine(box, child) || child.isFloat) continue;
    if (CLAMPED.has(child)) continue;
    if (flowFlex(box, child, options)) {
      if (!intersects(child, options)) continue;
      paintFlexItems(ctx, child, options);
      if (child.style.outlineStyle !== 'none') {
        outlines.boxes.push(child);
        outlines.clips.push(clips);
      }
      continue;
    }
    if (!inFlow(box, child, options)) {
      paintBox(ctx, child, options);
      continue;
    }
    if (!intersects(child, options)) continue;
    if (child.kind === 'table-cell' && COLLAPSED_CELLS.has(child)) continue;
    // What it holds, under its clip where it clips. The work of the clip is
    // in a function of its own, and so are a flex box's items: each name
    // more in this one is stack a level of nesting takes, and a deep
    // document ran out of it.
    const inner = clipsOverflow(child)
      ? enterFlowClip(ctx, child, options, clips, outlines)
      : clips;
    if (inner) {
      // its marker, an outside one under its clip with the rest, as all
      // three browsers cut it
      if (child.marker && child.style.visibility === 'visible') {
        paintMarker(ctx, child.marker, options, child.style.colorScheme);
      }
      if (child.lines) paintLines(ctx, child, options);
      paintFlowLines(
        ctx,
        child,
        options,
        inner,
        inner !== clips && child.kind === 'table' ? GRID : ALL_PARTS,
        outlines,
      );
      if (inner !== clips) popFlowClip(ctx, options, true);
    }
    // its own outside its clip, over the lines after it
    if (child.style.outlineStyle !== 'none') {
      outlines.boxes.push(child);
      outlines.clips.push(clips);
    }
  }
}

/** A flex box's items, each whole, in `order` — one `float` makes no float
 *  of — under its clip where it clips (`flowFlex`). */
function paintFlexItems(ctx: PaintContext, box: Box, options: PaintOptions) {
  const clip = clipsOverflow(box) ? flowClip(box, options) : undefined;
  if (clip === null) return;
  if (clip) pushFlowClip(ctx, box, clip, options, true);
  for (const item of paintedChildren(box, options)) {
    if (item.kind === 'text' || item.kind === 'break') continue;
    if (layered(box, item) || CLAMPED.has(item)) continue;
    paintBox(ctx, item, options);
  }
  if (clip) popFlowClip(ctx, options, true);
}

/** The last pass into a box of the flow that clips: a table's captions,
 *  which are outside its clip, and then its clip pushed. The clips what it
 *  holds is under, its own last, or null where its clip shows nothing. */
function enterFlowClip(
  ctx: PaintContext,
  box: Box,
  options: PaintOptions,
  clips: readonly Box[],
  outlines: Later,
): readonly Box[] | null {
  if (box.kind === 'table') {
    paintFlowLines(ctx, box, options, clips, CAPTIONS, outlines);
  }
  const clip = flowClip(box, options);
  if (!clip) return null;
  pushFlowClip(ctx, box, clip, options, true);
  return [...clips, box];
}

/** The edge a box of the flow clips what it holds at (`clipEdge`). Null
 *  where it has no area and nothing under it shows: there is no positioned
 *  box in it, which may be outside the clip. */
function flowClip(box: Box, options: PaintOptions): ClipEdge | null {
  const clip = clipEdge(box, options);
  const { w, h } = clip.rect;
  return (w <= 0 || h <= 0) && !holdsAbsolute(box) ? null : clip;
}

/** Push a box's clip (`flowClip`). With `levels`, also push a level for
 *  `paintPositioned`: a pass that paints boxes whole may reach a positioned
 *  box whose containing block is outside the clip, inside an inline-block
 *  that is a stacking context, and that box is put off until the clip
 *  ends, as `paintContent` puts it off. On a context that cannot clip,
 *  nothing is pushed, and `popFlowClip` pops nothing. */
function pushFlowClip(
  ctx: PaintContext,
  box: Box,
  clip: ClipEdge,
  options: PaintOptions,
  levels: boolean,
): void {
  if (!pushClip(ctx, clip.rect, clip.radii)) return;
  if (levels) (options.clips ??= []).push({ box, deferred: [] });
}

/** End a clip `pushFlowClip` pushed, and paint what its level put off. */
function popFlowClip(
  ctx: PaintContext,
  options: PaintOptions,
  levels: boolean,
): void {
  if (!canClip(ctx)) return;
  ctx.restore();
  if (!levels) return;
  const level = options.clips!.pop()!;
  for (const child of level.deferred) paintPositioned(ctx, child, options);
}

/** The floats or the outlines a pass over a flow left (`Later`), each
 *  under the clips of the boxes it was found in. */
function paintLater(
  ctx: PaintContext,
  later: Later,
  options: PaintOptions,
  floats: boolean,
): void {
  for (let i = 0; i < later.boxes.length; i += 1) {
    const box = later.boxes[i];
    let pushed = 0;
    let shown = true;
    for (const clipper of later.clips[i]) {
      const clip = flowClip(clipper, options);
      if (!clip) {
        shown = false;
        break;
      }
      pushFlowClip(ctx, clipper, clip, options, floats);
      pushed += 1;
    }
    if (shown) {
      if (floats) paintBox(ctx, box, options);
      else paintOutline(ctx, box, options);
    }
    for (let j = 0; j < pushed; j += 1) popFlowClip(ctx, options, floats);
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

/** Where a box that clips cuts what it holds (`clipEdge`). */
interface ClipEdge {
  rect: { x: number; y: number; w: number; h: number };
  radii: Corners | null;
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
function clipEdge(box: Box, options: ClipSpace): ClipEdge {
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
export function spreadCorners(
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
  // the document's top left, the initial containing block's, which the
  // box was laid out against, drawn at the viewport's: the scroll undone.
  // Not the root box's, which is inside the margins of the element it
  // stands in for (`layoutDocument`)
  return {
    ...options,
    originX: viewport.x,
    originY: viewport.y,
    atViewport: true,
  };
}

/** Per tree, its boxes fixed to the viewport (`fixedToViewport`), found
 *  as the layout positions them: what the element answers a scroll pane's
 *  blit with (`HtmlViewNode.viewportFixedRects`). */
export const FIXED_BOXES = new WeakMap<object, Box[]>();

/** Per tree, the initial containing block as far down as the document's
 *  flow reaches, the root element's margin box and the floats in it: the
 *  canvas, where the host gives it no size (`canvasArea`), and the box of
 *  the `<html>` implied around a fragment's body, which places the
 *  canvas's image (`canvasBackground`). The root box is inside its margins
 *  (`layoutDocument`), so neither is the root box. Set by the layout. */
export const DOCUMENT_FLOW = new WeakMap<
  object,
  { width: number; height: number }
>();

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

/** Whether a box is drawn where the viewport is (`atViewport`): fixed to
 *  it, or in a box that is. Such a box keeps its place on the screen as
 *  the pane scrolls the document under it. */
export function drawnAtViewport(box: Box): boolean {
  for (let at: Box | null = box; at?.parent; at = at.parent) {
    if (at.style.position === 'fixed' && fixedToViewport(at)) return true;
  }
  return false;
}

/** Whether a box is the containing block of the fixed boxes in it: a
 *  transformed box, one with layout or paint containment, or one that
 *  names either in `will-change`, or a filter (`holdsOutOfFlow`). */
function holdsFixed(box: Box): boolean {
  return (
    transformed(box.style) ||
    contained(box, CONTAIN_LAYOUT | CONTAIN_PAINT) ||
    holdsOutOfFlow(box, true)
  );
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
    !transformed(containing.style) &&
    !holdsOutOfFlow(containing, false)
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
 * The root element's `overflow` and the `<body>`'s it gives the viewport
 * are `visible` by the time they are read here (`propagateOverflow`), so a
 * root clips only under paint containment, as Chrome has it, and a body
 * only where it kept its `overflow`.
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
  // the root box is the initial containing block, which clips nothing
  if (!box.parent) return false;
  switch (box.kind) {
    case 'block':
    case 'table-cell':
    case 'table-caption':
    case 'flex':
    // the table box, its captions outside it (the CSS 2.1 errata, 11.1.1)
    case 'table':
      return true;
    default:
      return false;
  }
}

/**
 * What the boxes around `box` cut it to, in the document's coordinates, for
 * a layer that has to show it as the document would (`src/html/sprites.ts`):
 * the clip edge of each box that clips what it holds and holds `box` —
 * not one an out-of-flow box on the way escapes by having its containing
 * block outside it (`containingBlockOf`), nor a table's for its caption —
 * and a `clip` on `box` or one of them, up to the root, whose overflow is
 * the viewport's. A rounded edge that `extent`, everywhere `box` can be,
 * keeps clear of does not cut it at all; one it reaches cuts it to a
 * rectangle with round corners (`radius`), where its corners are one
 * circle's and every other clip holds it, as a layer's box can be cut.
 * Undefined where nothing cuts `box`; null where something cuts it in a way
 * neither can. Up to `within` and no further, where it is given: the box
 * whose layer `box`'s goes in, which the clips above it cut already.
 */
export function clipFor(
  box: Box,
  extent: Rect,
  scale: number,
  within: Box | null = null,
): { rect: Rect; radius: number } | null | undefined {
  const space: ClipSpace = { originX: 0, originY: 0, scale, damage: null };
  let clip: Rect | undefined;
  const cut = (r: { x: number; y: number; w: number; h: number }): void => {
    const x = Math.max(r.x, clip ? clip.x : -Infinity);
    const y = Math.max(r.y, clip ? clip.y : -Infinity);
    const right = Math.min(r.x + r.w, clip ? clip.x + clip.width : Infinity);
    const bottom = Math.min(r.y + r.h, clip ? clip.y + clip.height : Infinity);
    clip = {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    };
  };
  if (box.outOfFlow && box.style.clip) cut(clipOf(box, space));
  // the one with round corners that reaches it, if any does
  let rounded: { x: number; y: number; w: number; h: number } | null = null;
  let radius = 0;
  // the out-of-flow boxes on the way up, each clipped only by the boxes
  // that hold its containing block
  const escaping: Box[] = box.outOfFlow ? [box] : [];
  let below = box;
  for (let at = box.parent; at?.parent; below = at, at = at.parent) {
    const applies =
      !(at.kind === 'table' && below.kind === 'table-caption') &&
      escaping.every((o) => holds(at, containingBlockOf(o)));
    if (applies) {
      if (clipsOverflow(at)) {
        const { rect, radii } = clipEdge(at, space);
        if (radii) {
          let r = 0;
          for (const v of radii.x) r = Math.max(r, v);
          for (const v of radii.y) r = Math.max(r, v);
          const clear =
            extent.x >= rect.x + r &&
            extent.y >= rect.y + r &&
            extent.x + extent.width <= rect.x + rect.w - r &&
            extent.y + extent.height <= rect.y + rect.h - r;
          if (!clear) {
            const circle = circleOf(radii);
            if (circle === null || rounded) return null;
            rounded = rect;
            radius = circle;
          }
        } else {
          cut(rect);
        }
      }
      if (at.outOfFlow && at.style.clip) cut(clipOf(at, space));
    }
    if (at === within) break;
    if (at.outOfFlow) escaping.push(at);
  }
  if (rounded) {
    // the rounded box is the clip, which every other clip has to hold
    const c = clip as Rect | undefined;
    if (
      c &&
      !(
        c.x <= rounded.x &&
        c.y <= rounded.y &&
        c.x + c.width >= rounded.x + rounded.w &&
        c.y + c.height >= rounded.y + rounded.h
      )
    ) {
      return null;
    }
    return {
      rect: { x: rounded.x, y: rounded.y, width: rounded.w, height: rounded.h },
      radius,
    };
  }
  return clip && { rect: clip, radius: 0 };
}

/** The radius of corners that are all one circle's, or null where they
 *  are not: ellipses, or of more than one size. */
function circleOf(c: Corners): number | null {
  const r = c.x[0];
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(c.x[i] - r) > 1e-3 || Math.abs(c.y[i] - r) > 1e-3) {
      return null;
    }
  }
  return r;
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
 * the element's own corners, where no shape is written. A `polygon()` is
 * its vertices, where they fall, and the whole pixels around them as its
 * rectangle — of no area where they are all on a line, which leaves
 * nothing to show.
 */
function clipPathOf(box: Box, options: ClipSpace): PathClip {
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
  if (path.shape === 'polygon') {
    return polygonClip(path, x0, y0, width, height);
  }
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
  return { rect, radii, polygon: null, rule: 'nonzero' };
}

/** What a `clip-path` cuts to, in window coordinates (`clipPathOf`). */
interface PathClip {
  /** The rectangle, or the one around a polygon. */
  rect: { x: number; y: number; w: number; h: number };
  radii: Corners | null;
  /** A polygon's vertices, `x, y` by turns; null for a rectangle. */
  polygon: number[] | null;
  rule: 'nonzero' | 'evenodd';
}

/**
 * A `polygon()` placed in the box at `x0, y0` it is measured in: each
 * vertex a length, or a percentage of the box's width or height, from its
 * top left. The box is on the pixels its background is drawn on, each edge
 * the one it falls nearest, and the vertices are where they fall in it: a
 * polygon along the edges of a box laid out a fraction of a pixel down
 * drew a row of half coverage above and below the background it cut.
 */
function polygonClip(
  path: ClipPath,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
): PathClip {
  const x0 = Math.round(boxX);
  const y0 = Math.round(boxY);
  const width = Math.round(boxX + boxWidth) - x0;
  const height = Math.round(boxY + boxHeight) - y0;
  const points = path.points!;
  const polygon: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const px = x0 + resolve(points[i], width);
    const py = y0 + resolve(points[i + 1], height);
    polygon.push(px, py);
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  const x = Math.floor(minX);
  const y = Math.floor(minY);
  const rect = encloses(polygon)
    ? { x, y, w: Math.ceil(maxX) - x, h: Math.ceil(maxY) - y }
    : { x, y, w: 0, h: 0 };
  return { rect, radii: null, polygon, rule: path.fillRule };
}

/** Whether a polygon encloses anything: not where every vertex is on one
 *  line, one vertex or two among them. Its area is no test, since a bow
 *  tie's two halves wind opposite ways and come to none. */
function encloses(points: readonly number[]): boolean {
  const [x0, y0] = points;
  let dx = 0;
  let dy = 0;
  for (let i = 2; i + 1 < points.length; i += 2) {
    const ex = points[i] - x0;
    const ey = points[i + 1] - y0;
    if (dx === 0 && dy === 0) {
      dx = ex;
      dy = ey;
    } else if (Math.abs(dx * ey - dy * ex) > 1e-9 * (dx * dx + dy * dy)) {
      return true;
    }
  }
  return false;
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
  const { rect, radii, polygon, rule } = clipPathOf(box, DOCUMENT);
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  if (x < rect.x || x >= right || y < rect.y || y >= bottom) return false;
  if (polygon) return inPolygon(polygon, rule, x, y);
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
 * Whether a point is inside a polygon, its vertices `x, y` by turns: where
 * a ray from it to the right crosses the edges a number of times other than
 * none — counting each by the way it crosses, under `nonzero`, and each
 * once, under `evenodd`. An edge's bottom end is in it and its top end not,
 * so a ray through a vertex counts the two edges there once.
 */
function inPolygon(
  points: readonly number[],
  rule: 'nonzero' | 'evenodd',
  x: number,
  y: number,
): boolean {
  let winding = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 2) {
    const ax = points[i];
    const ay = points[i + 1];
    const bx = points[(i + 2) % n];
    const by = points[(i + 3) % n];
    if (ay <= y === by <= y) continue;
    // where the edge is at the point's height, and the point left of it
    const at = ax + ((y - ay) / (by - ay)) * (bx - ax);
    if (x < at) winding += by > ay ? 1 : -1;
  }
  return rule === 'evenodd' ? winding % 2 !== 0 : winding !== 0;
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
export function contentCorners(box: Box): Corners | null {
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
export interface Corners {
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
export function cornersOf(
  style: ComputedStyle,
  w: number,
  h: number,
): Corners | null {
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

/** Whether a context can clip what follows; the mock backend's cannot. */
function canClip(ctx: PaintContext): boolean {
  return !!(ctx.beginPath && ctx.rect && ctx.clip);
}

/** Clip what follows to a rectangle, rounded where `radii` are: false
 *  where the context cannot clip, and nothing was pushed. */
function pushClip(
  ctx: PaintContext,
  rect: { x: number; y: number; w: number; h: number },
  radii: Corners | null,
): boolean {
  if (!canClip(ctx)) return false;
  ctx.save();
  ctx.beginPath!();
  const w = Math.max(0, rect.w);
  const h = Math.max(0, rect.h);
  if (radii && ctx.roundRect) roundedRect(ctx, rect.x, rect.y, w, h, radii);
  else ctx.rect!(rect.x, rect.y, w, h);
  ctx.clip!();
  return true;
}

/**
 * Whether a child is painted with the positioned boxes, after the flow
 * rather than in it: an absolutely positioned box, and a relatively
 * positioned block, which CSS paints among them in document order (CSS 2.1
 * Appendix E) — a relative box after an absolute one covers it. And a box
 * that is a stacking context unpositioned — under full opacity,
 * filtered, transformed, masked, cut to a path, contained, isolated —
 * which is
 * painted in the
 * layer of the positioned boxes with a `z-index` of 0, in the document's
 * order among them (Appendix E, step 8; CSS Color 4, 3.2), as Chrome,
 * Firefox and Safari paint and hit-test it, block, float and flex item
 * alike: painted whole in its place in the flow, a translucent box went
 * under the text of a block after it that a negative margin drew up over
 * it, and under a relative box before it. An inline-block or an image is
 * one of them as much as a block is, the three engines agreeing again:
 * painted by its line, it went under the text a negative margin drew over
 * it, of its line and of a block after it, and under a positioned box
 * before it. An inline box is painted by its lines, a fragment at a time.
 */
export function layered(parent: Box, child: Box): boolean {
  if (child.outOfFlow) return true;
  const style = child.style;
  // a flex item with a `z-index` is a stacking context, positioned or not
  // (CSS Flexbox 5.4), and a grid's
  if (parent.kind === 'flex' && typeof style.zIndex === 'number') return true;
  if (
    style.position !== 'relative' &&
    style.position !== 'sticky' &&
    !stacksLayers(child)
  ) {
    return false;
  }
  return child.kind !== 'inline';
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

/**
 * Whether anything the document paints after `box` puts ink within
 * `extent`, in the document's coordinates: what a layer drawn over the
 * document in `box`'s place would wrongly cover (`src/html/sprites.ts`) —
 * but for the boxes in `above`, which are layers of their own over it,
 * with everything they hold.
 * In `paintContent`'s order (CSS 2.1 Appendix E), a stacking context
 * paints its flow, its layers and then its outline, so after a box painted
 * as one of its context's layers come the layers after it in that list,
 * the context's outline, and then the same of the context in the one
 * around it, up to the root. The flow it is over and every layer before it
 * are under it wherever it goes. A box fixed to the viewport is left out,
 * since where it is drawn turns on the scroll, which the caller asks about
 * itself (`FIXED_BOXES`). Null where `box`, or a context on the way up,
 * is not painted from a list of layers — a box in the flow, one below it
 * (`NEGATIVE`), one an inline box paints on its lines — and the caller has
 * to ask of every box instead.
 */
export function paintedAfter(
  box: Box,
  extent: Rect,
  fixedExtent: Rect | null = null,
  above: ReadonlySet<Box> | null = null,
): boolean | null {
  return walkPaintedAfter(box, extent, fixedExtent, above, () => true);
}

/**
 * The layers `paintedAfter` finds: each a box the document paints after
 * `box` whose ink is within `extent`, from the one painted first — what a
 * layer of `box`'s would cover, and what would have to be layers of their
 * own over it for it to be one (`HtmlViewNode.sprites`). Null where
 * `paintedAfter` is, and where the outline of a context around `box`
 * reaches the extent, which is no box to give a layer.
 */
export function coverersAfter(
  box: Box,
  extent: Rect,
  fixedExtent: Rect | null = null,
  above: ReadonlySet<Box> | null = null,
): Box[] | null {
  const found: Box[] = [];
  const stopped = walkPaintedAfter(box, extent, fixedExtent, above, (later) => {
    found.push(later);
    return false;
  });
  return stopped === false ? found : null;
}

/** The walk `paintedAfter` and `coverersAfter` share: each layer painted
 *  after `box` whose ink is within the extent is handed to `meet`, which
 *  stops the walk by answering true. True where it was stopped, or an
 *  outline reaches the extent; false where neither; null where `box`, or a
 *  context on the way up, is painted from no list of layers. */
function walkPaintedAfter(
  box: Box,
  extent: Rect,
  fixedExtent: Rect | null,
  above: ReadonlySet<Box> | null,
  meet: (later: Box) => boolean,
): boolean | null {
  let item = box;
  while (item.parent) {
    // its context: the nearest box that paints layers, which has it among
    // them where it is one
    let context: Box | null = item.parent;
    while (context && !STACKED.has(context)) context = context.parent;
    const list = context ? STACKED.get(context)! : null;
    const index = list ? list.indexOf(item) : -1;
    if (!context || index < 0) return null;
    for (let k = index + 1; k < list!.length; k += 1) {
      const later = list![k];
      // a layer of its own over this one's, with all it holds (`above`)
      if (above?.has(later)) continue;
      // one fixed to the viewport is asked about at every frame, where the
      // scroll has it (`fixedWithin`), but by a box at the viewport too,
      // which it keeps its place against
      const fixed = fixedToViewport(later);
      if (fixed && !fixedExtent) continue;
      if (!(later.boundsWidth > 0 && later.boundsHeight > 0)) continue;
      const ink = {
        x: later.boundsX,
        y: later.boundsY,
        width: later.boundsWidth,
        height: later.boundsHeight,
      };
      if (meets(ink, fixed ? fixedExtent! : extent) && meet(later)) {
        return true;
      }
    }
    if (outlineMeets(context, extent)) return true;
    item = context;
  }
  return false;
}

/**
 * Where `box` is in the order the document paints its layers, as
 * `paintedAfter` walks it: its index among its context's layers, after its
 * context's place in the same terms, from the root down — compared index
 * by index, a box painted later has the larger key. Null where it, or a
 * context on the way up, is not painted from a list of layers.
 */
export function paintOrderOf(box: Box): number[] | null {
  const key: number[] = [];
  let item = box;
  while (item.parent) {
    let context: Box | null = item.parent;
    while (context && !STACKED.has(context)) context = context.parent;
    const index = context ? STACKED.get(context)!.indexOf(item) : -1;
    if (!context || index < 0) return null;
    key.push(index);
    item = context;
  }
  return key.reverse();
}

/** Whether two rectangles share any area. */
function meets(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Whether a box's outline, the ring `paintOutline` draws, reaches into
 *  `rect`: what is inside the ring all of it is clear of it. */
function outlineMeets(box: Box, rect: Rect): boolean {
  const s = box.style;
  if (s.outlineStyle === 'none' || !(s.outlineWidth > 0)) return false;
  if (s.visibility !== 'visible') return false;
  const grow = s.outlineOffset + s.outlineWidth;
  const top = frameY(box);
  const height = frameHeight(box);
  const outer = {
    x: box.x - grow,
    y: top - grow,
    width: box.width + 2 * grow,
    height: height + 2 * grow,
  };
  if (!meets(outer, rect)) return false;
  const off = s.outlineOffset;
  return !(
    rect.x >= box.x - off &&
    rect.y >= top - off &&
    rect.x + rect.width <= box.x + box.width + off &&
    rect.y + rect.height <= top + height + off
  );
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
 * filtered (Filter Effects 1, 2); or under full opacity (CSS Color 4
 * 3.2), its own or the opacity it takes from an inline box it broke
 * (`FADED_BLOCKS`), which is painted as one group — faded with it, or at
 * `opacity: 0` not at all, where its root context drew a hover menu's
 * absolute children.
 */
export function stacksLayers(box: Box): boolean {
  const style = box.style;
  if (style.position === 'fixed' || style.position === 'sticky') return true;
  if (style.opacity < 1) return true;
  // and a filter, which is applied to the group (Filter Effects 1, 2)
  if (style.filter !== null) return true;
  // and so does a mask, which is applied to the group (CSS Masking 1, 7),
  // and a clip path, which cuts it (5.1)
  if (masked(style) || pathClips(box)) return true;
  // layout and paint containment make one (CSS Containment 2, 3.3, 3.5),
  // and isolation, whose whole purpose that is (CSS Compositing 1, 3.2)
  if (contained(box, CONTAIN_LAYOUT | CONTAIN_PAINT)) return true;
  if (style.isolation === 'isolate' && box.kind !== 'inline') return true;
  // and a transform (CSS Transforms 1, 3), on a box one applies to: what it
  // holds is painted with it, through its matrix, and not by a context
  // outside it
  if (transformed(style) && box.kind !== 'inline') return true;
  if (
    typeof style.zIndex === 'number' &&
    (style.position !== 'static' || flexItem(box))
  ) {
    return true;
  }
  // and naming any of them in `will-change`, which a running animation of
  // one does as well (CSS Will Change 1, 2; Web Animations 1, 5.6)
  if (style.willChange && willStack(box)) return true;
  // the opacity taken from an inline box, asked last: `layered` asks this
  // of every box in the flow at every paint, and a map lookup is the one
  // question here that is not a field read
  return FADED_BLOCKS.has(box);
}

/** Whether what `will-change` names makes a box a stacking context: each
 *  name on the boxes its property applies to (`WILL_CHANGES`) — an opacity
 *  on any box, a transform on one that is not inline, a `z-index` where
 *  one applies, containment where it does. */
function willStack(box: Box): boolean {
  const bits = box.style.willChange;
  if (bits & WILL_STACK) return true;
  if (bits & WILL_STACK_BOX && box.kind !== 'inline') return true;
  if (
    bits & WILL_STACK_Z &&
    (box.style.position !== 'static' || flexItem(box))
  ) {
    return true;
  }
  return (
    !!(bits & WILL_CONTAIN) &&
    containmentApplies(box, CONTAIN_LAYOUT | CONTAIN_PAINT)
  );
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
  // a caption is outside the table box that clips (`paintContent`)
  if (box.kind === 'table-caption' && from && from !== context) {
    from = from.parent;
  }
  if (box.outOfFlow) {
    const fixed = box.style.position === 'fixed';
    while (from && from !== context) {
      const style = from.style;
      if (transformed(style) || holdsOutOfFlow(from, fixed)) break;
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
  // each clip pushed, and the level of one that clips an overflow
  const pushed: (ClipLevel | null)[] = [];
  let empty = false;
  for (const clipper of between) {
    if (clipper.outOfFlow && clipper.style.clip) {
      const rect = clipOf(clipper, options);
      if (rect.w <= 0 || rect.h <= 0) empty = true;
      else if (pushClip(ctx, rect, null)) pushed.push(null);
    }
    if (!empty && clipsOverflow(clipper)) {
      // A level, as `paintContent` makes one: an absolute box the box
      // paints whose containing block is outside the clip is put off until
      // the clip ends (`paintPositioned`) — one in a translucent box under
      // it, a stacking context and no containing block, which was cut off
      // with the box once the box was painted here rather than in its
      // place. And a clip of no area is pushed where that may be so.
      const { rect, radii } = clipEdge(clipper, options);
      if ((rect.w <= 0 || rect.h <= 0) && !holdsAbsolute(box)) empty = true;
      else if (pushClip(ctx, rect, radii)) {
        const level: ClipLevel = { box: clipper, deferred: [] };
        (options.clips ??= []).push(level);
        pushed.push(level);
      }
    }
    if (empty) break;
  }
  if (!empty) paintPositioned(ctx, box, options);
  for (let i = pushed.length - 1; i >= 0; i -= 1) {
    ctx.restore();
    const level = pushed[i];
    if (!level) continue;
    options.clips!.pop();
    for (const child of level.deferred) paintPositioned(ctx, child, options);
  }
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
 *  among them for being a stacking context alone, a transform's or an
 *  opacity's, which is painted in the document's order whatever `z-index`
 *  it was given. */
export function layerOf(box: Box): number {
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

/** A rectangle with its corners, square where they are null. */
interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
  corners: Corners | null;
}

/**
 * `clampRect` for a rectangle that may be rounded, with the corners it is
 * left with. Where no radius is larger than `CLAMP_PAD` they are its own,
 * and it is cut as a square one is: a corner the cut leaves on a cut edge
 * curves no further in from it than the margin, which keeps it out of what
 * is painted. A larger radius, a circle's or a pill's, would bend into it
 * — a circle 400 across repainted a strip at a time was another shape in
 * every strip across its curve — so there the window is moved out past
 * any curve it would cross, and a corner on a side it cut is square
 * (`cutRounded`, as a rounded border's ring is cut).
 */
function clampArea(
  options: PaintOptions,
  x: number,
  y: number,
  w: number,
  h: number,
  corners: Corners | null,
): Area | null {
  if (corners && curvesPast(corners, CLAMP_PAD)) {
    const shape = { rect: { x, y, width: w, height: h }, corners };
    const cut = cutRounded(roundedWindow(options, [shape]), shape);
    if (!cut) return null;
    const { rect } = cut;
    return {
      x: rect.x,
      y: rect.y,
      w: rect.width,
      h: rect.height,
      corners: cut.corners,
    };
  }
  const rect = clampRect(options, x, y, w, h);
  return rect && { x: rect.x, y: rect.y, w: rect.w, h: rect.h, corners };
}

/**
 * Two rounded rectangles drawn against each other — a shadow's shape and
 * the box it is clipped out of, a hole and what it is cut in — cut to one
 * window, `pad` round what the paint reaches, as `clampArea` cuts one:
 * where neither has a corner that curves further than `CLAMP_PAD`, as
 * square ones are, keeping their corners, and otherwise to a window moved
 * out past every curve of either it would cross, each square on the sides
 * it cut. `CLAMP_PAD` and not `pad`, because what a shadow's margin has
 * past it is what the blur casts back across the cut, and a corner bent
 * into the margin is cast that far further in. Null for one with nothing
 * in the window.
 */
function clampPair(
  options: PaintOptions,
  pad: number,
  a: Rounded,
  b: Rounded,
): [Rounded | null, Rounded | null] {
  if (!curvesPast(a.corners, CLAMP_PAD) && !curvesPast(b.corners, CLAMP_PAD)) {
    return [clampKeeping(options, a, pad), clampKeeping(options, b, pad)];
  }
  const cut = roundedWindow(options, [a, b], pad);
  return [cutRounded(cut, a), cutRounded(cut, b)];
}

/** `clampAround` for a rounded rectangle, keeping its corners. */
function clampKeeping(
  options: PaintOptions,
  { rect, corners }: Rounded,
  pad: number,
): Rounded | null {
  const cut = clampAround(options, rect, pad);
  return cut && { rect: cut, corners };
}

/** Whether a corner curves further than `by` along either of its sides. */
function curvesPast({ x, y }: Corners, by: number): boolean {
  for (let i = 0; i < 4; i += 1) if (x[i] > by || y[i] > by) return true;
  return false;
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
  const rect = clipArea(
    box,
    options,
    style,
    !!(ctx.roundRect && ctx.fill && ctx.beginPath),
  );
  if (!rect) return;
  const rounded = rect.corners;
  const fill = (): void => {
    if (rounded) {
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
      paintGradient(ctx, style, gradient, rect, at, options);
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
    } else paintGradient(ctx, style, gradient, rect, at, options);
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
  options: PaintOptions,
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
    gradientTile(ctx, gradient, x0, y0, w, h, style.color, area, options);
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
      gradientTile(ctx, gradient, x, y, w, h, style.color, tile, options);
    }
  }
}

/** A gradient `w` by `h` at (`x`, `y`), filled in `part` of it. */
function gradientTile(
  ctx: PaintContext,
  gradient: Gradient,
  x: number,
  y: number,
  w: number,
  h: number,
  currentColor: string,
  part: { x: number; y: number; w: number; h: number },
  options: PaintOptions,
): void {
  if (gradientStrip(ctx, gradient, x, y, w, h, currentColor, part, options)) {
    return;
  }
  const paint = gradientFill(ctx, gradient, x, y, w, h, currentColor, part);
  if (paint) fillGradient(ctx, paint, part);
}

/** How wide a strip of a gradient is shaded (`gradientStrip`). */
const STRIP = 64;

/** The least a gradient fills before it is shaded as a strip. */
const STRIP_AREA = 64 * 1024;

/**
 * A linear gradient that runs straight down or straight across, filled in
 * `part` from a strip of it `STRIP` pixels wide, shaded on a surface and
 * copied along the axis its colours do not change on. A gradient is
 * shaded a pixel at a time, which on macOS is some 3.6 ns a pixel at 2x,
 * and a copy of pixels as they are a tenth of that: a page's body,
 * `linear-gradient(to bottom, …)` from its top to its foot, took 7 ms of
 * every frame that repainted most of a window. Only where the context
 * draws in whole pixels of its own, a copy landing on the pixels the strip
 * was shaded for, and only where a part is large enough to be worth a
 * surface; false where it is not done, and the gradient is filled itself.
 */
function gradientStrip(
  ctx: PaintContext,
  gradient: Gradient,
  x: number,
  y: number,
  w: number,
  h: number,
  currentColor: string,
  part: { x: number; y: number; w: number; h: number },
  options: PaintOptions,
): boolean {
  if (gradient.kind !== 'linear' || gradient.corner) return false;
  const down = Math.abs(Math.sin(gradient.angle)) < 1e-9;
  if (!down && Math.abs(Math.cos(gradient.angle)) >= 1e-9) return false;
  const { x: px, y: py, w: pw, h: ph } = part;
  const long = down ? pw : ph;
  if (long < 4 * STRIP || pw * ph < STRIP_AREA) return false;
  if (!options.surface || !ctx.drawImage || !ctx.getTransform) return false;
  if (![px, py, pw, ph].every(Number.isInteger)) return false;
  const m = ctx.getTransform();
  if (m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1) return false;
  if (!Number.isInteger(m.e) || !Number.isInteger(m.f)) return false;
  const sw = down ? STRIP : pw;
  const sh = down ? ph : STRIP;
  const surface = options.surface(sw, sh);
  if (!surface) return false;
  try {
    // the part's corner at the strip's
    const on = surface.getContext('2d') as PaintContext;
    const strip = { x: 0, y: 0, w: sw, h: sh };
    const paint = gradientFill(
      on,
      gradient,
      x - px,
      y - py,
      w,
      h,
      currentColor,
      strip,
    );
    if (!paint) return false;
    fillGradient(on, paint, strip);
    for (let at = 0; at < long; at += STRIP) {
      const n = Math.min(STRIP, long - at);
      if (down) ctx.drawImage(surface, 0, 0, n, ph, px + at, py, n, ph);
      else ctx.drawImage(surface, 0, 0, pw, n, px, py + at, pw, n);
    }
    return true;
  } finally {
    surface.destroy?.();
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

/** How many tiles of a repeating background make it worth drawing them
 *  from a block of them (`tileBlock`) rather than one by one. */
const BLOCK_FROM = 16;

/** The side, in device pixels, a block of tiles is made up to along each
 *  axis the image repeats on, and the most pixels one may hold. */
const BLOCK_SIDE = 256;
const BLOCK_PIXELS = 1 << 20;

/** The most copies a level of a block is made of (`tileBlock`). */
const BLOCK_COPIES = 16;

/** A number for a decoded image, the same while it lives: its part in the
 *  key of a block of its tiles (`tileBlock`), or of a raster kept of it at
 *  a size (`drawRaster`). */
const IMAGES = new WeakMap<object, number>();
let images = 0;

function imageId(image: object): number {
  let id = IMAGES.get(image);
  if (id === undefined) IMAGES.set(image, (id = ++images));
  return id;
}

/** Whether a background's tiles repeat along an axis, by its mode, which
 *  keeps a block's key the same however much of a box a paint reaches: all
 *  but `no-repeat`, and `space` with room for no more than one. */
function repeats(mode: RepeatMode, run: number, size: number): boolean {
  return mode !== 'no-repeat' && (mode !== 'space' || run > size);
}

/**
 * A block of a repeating background's tiles, `iw` by `ih` device pixels
 * each, kept on a surface (`PaintOptions.tilesKept`) and drawn in their
 * place: a block at least `BLOCK_SIDE` along each axis the image repeats
 * on. A tile is drawn with a `drawImage` of its own where a context has no
 * pattern — on macOS, and on X11 at any scale but 1, where a tile is not
 * the image's own size — so the 4 by 4 GIF a Zen Garden design lays
 * across a box was thousands of calls a paint, and the 1 pixel wide strip
 * across its page a thousand: a frame of a resize of 008 painted for 35
 * ms. Each tile is where the one by one path draws it, a whole number of
 * device pixels from the last, and a surface drawn where it is takes it
 * pixel for pixel. A block is made a level at a time, each of at most
 * `BLOCK_COPIES` of the level under it a side, so a tile of a pixel or two
 * costs a few hundred draws to make once. Null where a block is no gain or
 * none can be had.
 */
function tileBlock(
  image: unknown,
  iw: number,
  ih: number,
  across: boolean,
  down: boolean,
  options: PaintOptions,
): { surface: unknown; width: number; height: number } | null {
  const keep = options.tilesKept;
  if (!keep || typeof image !== 'object' || image === null) return null;
  const id = imageId(image);
  let source: unknown = image;
  let w = iw;
  let h = ih;
  for (let level = 0; ; level += 1) {
    const kx = across ? Math.min(BLOCK_COPIES, Math.ceil(BLOCK_SIDE / w)) : 1;
    const ky = down ? Math.min(BLOCK_COPIES, Math.ceil(BLOCK_SIDE / h)) : 1;
    if ((kx <= 1 && ky <= 1) || w * kx * h * ky > BLOCK_PIXELS) break;
    const from = source;
    const tw = w;
    const th = h;
    const made = keep(
      `${id}|${iw}x${ih}|${across ? 1 : 0}${down ? 1 : 0}|${level}`,
      tw * kx,
      th * ky,
      (sctx) => {
        for (let j = 0; j < ky; j += 1) {
          for (let i = 0; i < kx; i += 1) {
            // the image at the tile's size; a level above it as it is
            if (level === 0) sctx.drawImage!(from, i * tw, j * th, tw, th);
            else sctx.drawImage!(from, i * tw, j * th);
          }
        }
      },
    );
    if (!made) break;
    source = made;
    w = tw * kx;
    h = th * ky;
  }
  return source === image ? null : { surface: source, width: w, height: h };
}

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
  const url = urlOf(style.backgroundImage);
  const loaded = url !== null ? options.backgroundImageFor?.(url) : null;
  if (!loaded) return;
  const svg = loaded.image instanceof SvgDrawing ? loaded.image : null;
  if (!svg && !ctx.drawImage) return;
  // an image pixel is a CSS pixel, and the box is device — but for one an
  // `image-set()` chose at another density, whose pixels are that many to
  // the CSS pixel: a `2x` image is half its pixels across
  const scale = options.scale ?? 1;
  const repeat = style.backgroundRepeat;
  const natural = atDensity(loaded, densityOf(style.backgroundImage));
  let tile = sizedTile(style.backgroundSize, natural, at, scale);
  const drag = options.drag;
  const stepped =
    drag && steppedTile(style.backgroundSize, tile, natural.ratio);
  if (stepped && drag.moved(style, tile[0], tile[1]) && drag.cheap) {
    tile = stepped;
    drag.drawn();
  }
  const [iw, ih] = roundedTile(style.backgroundSize, repeat, tile, at);
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
  let block: ReturnType<typeof tileBlock> = null;
  if (svg) {
    // a drawing is drawn a tile at a time, at the size it was given
    if (tiles <= MAX_TILES) {
      for (let y = fromY; y < toY; y += stepY) {
        for (let x = fromX; x < toX; x += stepX) {
          drawSvg(
            ctx,
            svg,
            Math.round(x),
            Math.round(y),
            iw,
            ih,
            style.colorScheme,
            options,
          );
        }
      }
    } else {
      drawSvg(ctx, svg, x0, y0, iw, ih, style.colorScheme, options);
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
  } else if (
    tiles > BLOCK_FROM &&
    stepX === iw &&
    stepY === ih &&
    Number.isInteger(iw) &&
    Number.isInteger(ih) &&
    Number.isInteger(fromX) &&
    Number.isInteger(fromY) &&
    (block = tileBlock(
      loaded.image,
      iw,
      ih,
      repeats(repeat[0], toX - fromX, iw),
      repeats(repeat[1], toY - fromY, ih),
      options,
    )) !== null &&
    Math.ceil((toX - fromX) / block.width) *
      Math.ceil((toY - fromY) / block.height) <=
      MAX_TILES
  ) {
    for (let y = fromY; y < toY; y += block.height) {
      for (let x = fromX; x < toX; x += block.width) {
        ctx.drawImage!(block.surface, x, y);
      }
    }
  } else if (tiles <= MAX_TILES) {
    // each tile's edges on the pixels they fall nearest, so tiles `space`
    // sets apart or `round` sizes to a fraction meet without a seam; and
    // one at another size than the image's from a raster kept at it
    // (`drawRaster`), as an `<img>` is: at 2x every tile is
    for (let y = fromY; y < toY; y += stepY) {
      const top = Math.round(y);
      const height = Math.round(y + ih) - top;
      for (let x = fromX; x < toX; x += stepX) {
        const left = Math.round(x);
        drawRaster(
          ctx,
          loaded.image,
          left,
          top,
          Math.round(x + iw) - left,
          height,
          options,
          area,
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
 * of an object): `auto` is the image's own, as `concreteSize` has it; `cover`
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
  if (size === 'auto')
    return concreteSize(image, area.width, area.height, scale);
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
  return concreteSize(image, area.width, area.height, scale);
}

/** How far apart, as a fraction, the sizes are that a drag drawn cheaper
 *  draws a scaled background at (`steppedTile`): the most an image is
 *  drawn larger than at rest, or smaller where it is to fit. */
const SIZE_STEP = 0.04;
const STEP_LOG = Math.log1p(SIZE_STEP);

/** `n` on the nearest of the sizes `SIZE_STEP` apart — a whole power of
 *  `1 + SIZE_STEP` — above it, or below. */
function onStep(n: number, up: boolean): number {
  const k = Math.log(n) / STEP_LOG;
  return Math.exp((up ? Math.ceil(k) : Math.floor(k)) * STEP_LOG);
}

/**
 * A background tile `sizedTile` sized from its area, on the nearest of the
 * sizes `SIZE_STEP` apart, for a drag drawn cheaper (`DragPaint`); null
 * where its size is none of the area's. Each width of a drag sized a
 * `cover` photograph anew, and drew it, resampled, at every frame; a size
 * on a step holds across the frames of a few per cent of the drag, and the
 * raster kept of it is copied. `cover` and a percentage step up, so the
 * image still covers what it covered, and `contain` down, so it still
 * fits; a side `auto` keeps the image's ratio to the side that stepped.
 * Whole pixels, from the step alone, so every width on one step draws the
 * same.
 */
function steppedTile(
  size: ComputedStyle['backgroundSize'],
  [w, h]: [number, number],
  ratio: number,
): [number, number] | null {
  if (size === 'auto' || !(w > 0 && h > 0)) return null;
  if (size === 'cover' || size === 'contain') {
    if (!(ratio > 0)) return null;
    const up = size === 'cover';
    const across = onStep(w, up);
    const whole = up ? Math.ceil : Math.floor;
    return [whole(across), whole(across / ratio)];
  }
  const [sw, sh] = size;
  const pw = typeof sw === 'object';
  const ph = typeof sh === 'object';
  if (!pw && !ph) return null;
  const across = pw ? Math.ceil(onStep(w, true)) : w;
  const down = ph ? Math.ceil(onStep(h, true)) : h;
  if (pw && sh === 'auto' && ratio > 0) {
    return [across, Math.ceil(across / ratio)];
  }
  if (ph && sw === 'auto' && ratio > 0) {
    return [Math.ceil(down * ratio), down];
  }
  return [across, down];
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
 * inner one and each side takes its half (CSS Backgrounds 3, 4.4), so a side
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
 * taking its half (CSS Backgrounds 3, 4.4): where both have a width, they
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
 * Fill a polygon, its corners as `x, y` pairs, cut to `area`: the part of
 * it near what is painted, which is what keeps a side thousands of pixels
 * long inside X's coordinates. Cut edge by edge rather than by moving its
 * corners in, which would turn a diagonal that crosses the painted area: a
 * slanted divider, `border-left: 100vw solid transparent`, has a corner far
 * outside it. A polygon that is not convex, a rounded ring's share, may
 * come out of the cut with an edge run there and back along the area's
 * border, which fills nothing, and that border is outside the paint.
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
  const url = urlOf(source);
  const gradient = gradientOf(source);
  const loaded = url !== null ? options.backgroundImageFor?.(url) : null;
  if (url !== null && !loaded) return false;
  // an image an `image-set()` chose at another density is that many of its
  // pixels to the CSS pixel, its slices' unit too — as Chrome, Firefox and
  // WebKit slice one
  const density = densityOf(source);
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
    ? concreteSize(atDensity(loaded, density), aw, ah, scale)
    : [aw, ah];
  const iw = cw / scale;
  const ih = ch / scale;
  if (!(iw > 0 && ih > 0)) return false;
  const key = url ?? gradientKey(gradient!, box.style.color);
  // A drawing or a gradient is drawn once at that size and cut as a raster
  // is, so that each piece stretches its part of the one picture
  let image = loaded?.image;
  let unitX = density > 0 ? density : 1;
  let unitY = unitX;
  if (!loaded || image instanceof SvgDrawing) {
    const svg = image instanceof SvgDrawing ? image : null;
    const w = Math.max(1, Math.round(cw));
    const h = Math.max(1, Math.round(ch));
    const scheme = box.style.colorScheme;
    const drawn = options.cached?.(
      `border-image|${key}|${w}x${h}|${scheme}`,
      w,
      h,
      (sctx) => {
        if (svg) {
          svg.drawImage(sctx, 0, 0, w, h, scale, scheme, surfaceMaker(options));
        } else if (gradient) {
          const paint = gradientFill(
            sctx,
            gradient,
            0,
            0,
            w,
            h,
            box.style.color,
          );
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

/** A gradient with each of its stops faded by `fade`, `currentColor` among
 *  them the colour it is: the gradient faded, as each stop is faded alike. */
function fadedGradient(
  gradient: Gradient,
  fade: number,
  currentColor: string,
): Gradient {
  if (!(fade < 1)) return gradient;
  return {
    ...gradient,
    stops: gradient.stops.map((stop) => ({
      ...stop,
      color: fadeColor(inkColor(stop.color, currentColor), fade),
    })),
  };
}

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
 * padding edge, each rounded, where every side that has a border has a
 * solid rule: a card's or a button's. Drawn straight, its corners were
 * square over the background's rounded ones, and an accent border down one
 * side did not follow the corner. The inner radius is the outer less the
 * wider border at that corner (CSS Backgrounds 3, 5.2). Sides of one colour
 * are one fill; sides of more are each given their share of the ring
 * (`ringSides`). An `inset` or an `outset` side is a solid one in its shade
 * (`sculptedInk`), so a field the page rounded, its 2px inset border the
 * UA's, is rounded as a browser rounds it. False where the border is not
 * such a one, and it is drawn a side at a time.
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
  if (!ctx.fill || !ctx.beginPath) return false;
  const corners = cornersOf(s, w, h);
  if (!corners) return false;
  const sides: [number, string, ComputedStyle['borderTopStyle']][] = [
    [box.borderTop, s.borderTopColor, s.borderTopStyle],
    [box.borderRight, s.borderRightColor, s.borderRightStyle],
    [box.borderBottom, s.borderBottomColor, s.borderBottomStyle],
    [box.borderLeft, s.borderLeftColor, s.borderLeftStyle],
  ];
  let color: string | null = null;
  let mixed = false;
  for (const [width, ink, style] of sides) {
    if (!width) continue;
    if (!ringed(style)) return false;
    // two shades, a side's share each
    if (style !== 'solid') mixed = true;
    if (color !== null && ink !== color) mixed = true;
    color = ink;
  }
  if (mixed) return ringSides(ctx, box, x, y, w, h, corners, options);
  if (!ctx.roundRect) return false;
  if (color === null) return true;
  if (isTransparent(color)) return true;
  wholeRing(ctx, box, inkColor(color, s.color), x, y, w, h, corners, options);
  return true;
}

/** The ring of a rounded border in one colour, cut to what the paint
 *  reaches (`cutRing`). */
function wholeRing(
  ctx: PaintContext,
  box: Frame,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  corners: Corners,
  options: PaintOptions,
): void {
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
  if (!ring) return;
  const { outer, inner } = ring;
  ctx.fillStyle = color;
  fillRing(
    ctx,
    outer.rect,
    outer.corners,
    inner ? inner.rect : NOWHERE,
    inner ? inner.corners : outer.corners,
  );
}

/** How far a chord of a flattened corner may stray from its curve, in
 *  device pixels: a sixteenth, well inside what antialiasing shows. */
const CURVE_TOLERANCE = 1 / 16;

/** How far past a cut a share reaches under the one drawn over it, in
 *  device pixels: past the antialiased edge of either. */
const SEAM = 1.5;

/** Which way a border's sides run at each corner, clockwise from the top
 *  left: the side that ends at corner i arrives along `ALONG[i]`, and the
 *  side that begins there leaves along `ALONG[i + 1]`. */
const ALONG: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * A rounded border whose solid sides are not all one colour, each side's
 * share of the ring filled in its own. Where two sides of different colours
 * meet, the corner is cut on the line from the border box's corner through
 * the padding box's, as Blink cuts it: CSS Backgrounds 3, 4.4 puts the
 * transition on the curve at a point that follows the ratio of the two
 * widths and leaves the rest to the UA. A corner between a side and one
 * with no width is all the side's (4.4 again), and sides of one colour that
 * meet are one fill, so nothing is cut where the colour does not change.
 * Drawn a side at a time, the spinner the web draws — `border-radius: 50%`
 * with one side of another colour — was a square frame.
 *
 * A share is a polygon: the curves flattened to chords no further than
 * `CURVE_TOLERANCE` from them, so that it is cut to what the paint reaches
 * as the square corners are (`fillPolygon`) and a large ring repainted a
 * strip at a time is the same ring. False where the context draws no
 * lines, and the sides are drawn straight.
 */
function ringSides(
  ctx: PaintContext,
  box: Frame,
  x: number,
  y: number,
  w: number,
  h: number,
  corners: Corners,
  options: PaintOptions,
): boolean {
  if (!ctx.moveTo || !ctx.lineTo) return false;
  const area = clampRect(options, x, y, w, h);
  if (!area) return true;
  const s = box.style;
  const widths = [
    box.borderTop,
    box.borderRight,
    box.borderBottom,
    box.borderLeft,
  ];
  const colors = [
    s.borderTopColor,
    s.borderRightColor,
    s.borderBottomColor,
    s.borderLeftColor,
  ];
  const styles = [
    s.borderTopStyle,
    s.borderRightStyle,
    s.borderBottomStyle,
    s.borderLeftStyle,
  ];
  // what each side is painted in, null where it paints nothing
  const inks = widths.map((width, i) => {
    if (!(width > 0) || isTransparent(colors[i])) return null;
    const ink = inkColor(colors[i], s.color);
    const style = styles[i];
    return style === 'inset' || style === 'outset'
      ? sculptedInk(ink, i, style === 'inset')
      : ink;
  });
  // Corners from the top left, clockwise. Corner i is where side i - 1
  // ends and side i begins: the top left ends the left and begins the top.
  // Two sides of one colour are joined across their corner.
  const joined = [0, 1, 2, 3].map((i) => {
    const before = (i + 3) % 4;
    return widths[before] > 0 && widths[i] > 0 && inks[before] === inks[i];
  });
  if (!joined.includes(false)) {
    // one colour after all, `currentColor` and the colour it is
    if (!ctx.roundRect) return false;
    if (inks[0] !== null) {
      wholeRing(ctx, box, inks[0], x, y, w, h, corners, options);
    }
    return true;
  }
  const [t, r, b, l] = widths;
  const x1 = x + w;
  const y1 = y + h;
  // the padding box, inside the borders
  const ix0 = x + l;
  const iy0 = y + t;
  const ix1 = Math.max(ix0, x1 - r);
  const iy1 = Math.max(iy0, y1 - b);
  const inside = insetCorners(corners, t, r, b, l);
  const hollow = ix1 > ix0 && iy1 > iy0;
  // each corner's point on the border box and on the padding box, which
  // way it points, and the quarter ellipses that round the two there
  const sx = [-1, 1, 1, -1];
  const sy = [-1, -1, 1, 1];
  const ox = [x, x1, x1, x];
  const oy = [y, y, y1, y1];
  const px = [ix0, ix1, ix1, ix0];
  const py = [iy0, iy0, iy1, iy1];
  type Quarter = { cx: number; cy: number; rx: number; ry: number } | null;
  const quarter = (
    i: number,
    cornerX: number,
    cornerY: number,
    rx: number,
    ry: number,
  ): Quarter =>
    rx > 0 && ry > 0
      ? { cx: cornerX - sx[i] * rx, cy: cornerY - sy[i] * ry, rx, ry }
      : null;
  const outer: Quarter[] = [];
  const inner: Quarter[] = [];
  for (let i = 0; i < 4; i += 1) {
    outer.push(quarter(i, ox[i], oy[i], corners.x[i], corners.y[i]));
    inner.push(
      hollow ? quarter(i, px[i], py[i], inside.x[i], inside.y[i]) : null,
    );
  }
  // A corner's quarter turns clockwise from the angle it starts at: the top
  // left's from pointing left to pointing up.
  const QUARTER = Math.PI / 2;
  const start = (i: number): number => Math.PI + i * QUARTER;
  /** Where a line from (fromX, fromY) along (dx, dy) first meets a quarter
   *  ellipse, as the angle it is at; the line starts outside it. */
  const crossing = (
    i: number,
    q: Quarter,
    fromX: number,
    fromY: number,
    dx: number,
    dy: number,
  ): number => {
    const a0 = start(i);
    if (!q) return a0;
    const ux = (fromX - q.cx) / q.rx;
    const uy = (fromY - q.cy) / q.ry;
    const vx = dx / q.rx;
    const vy = dy / q.ry;
    const qa = vx * vx + vy * vy;
    const qb = ux * vx + uy * vy;
    const disc = qb * qb - qa * (ux * ux + uy * uy - 1);
    const k = qa > 0 && disc > 0 ? (-qb - Math.sqrt(disc)) / qa : 0;
    let a = Math.atan2(uy + k * vy, ux + k * vx);
    // into the quarter's own turn
    a += 2 * Math.PI * Math.round((a0 + QUARTER / 2 - a) / (2 * Math.PI));
    return Math.min(a0 + QUARTER, Math.max(a0, a));
  };
  // Where the shares meet at each corner, as angles on its two quarters: on
  // the cut, or at the end of the corner where one side has no width and
  // the other has all of it — the side that has none paints nothing.
  const cutOuter: number[] = [];
  const cutInner: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const before = widths[(i + 3) % 4] > 0;
    const after = widths[i] > 0;
    if (before && after) {
      const dx = px[i] - ox[i];
      const dy = py[i] - oy[i];
      cutOuter.push(crossing(i, outer[i], ox[i], oy[i], dx, dy));
      cutInner.push(crossing(i, inner[i], px[i], py[i], dx, dy));
    } else {
      const end = before ? start(i) + QUARTER : start(i);
      cutOuter.push(end);
      cutInner.push(end);
    }
  }
  // The shares, a run of sides of one colour each, from the corner the
  // colour changes at to the next one it changes at. Those that show what
  // is under them are drawn first.
  const runs: { from: number; to: number; ink: string | null }[] = [];
  for (let i = 0; i < 4; i += 1) {
    if (joined[i]) continue;
    let j = (i + 1) % 4;
    while (joined[j]) j = (j + 1) % 4;
    runs.push({ from: i, to: j, ink: inks[i] });
  }
  const opaque = (ink: string | null): boolean =>
    ink !== null && alphaOf(ink) === 1;
  runs.sort((a, b) => Number(opaque(a.ink)) - Number(opaque(b.ink)));
  /** Whether a share reaches past its cut at a corner, under the one on
   *  the other side of it: where that one is drawn after it and covers it. */
  const under = (k: number, corner: number): boolean => {
    const before = widths[(corner + 3) % 4] > 0;
    if (!(before && widths[corner] > 0)) return false;
    const other = runs.findIndex(
      (run) => run !== runs[k] && (run.from === corner || run.to === corner),
    );
    return other > k && opaque(runs[other].ink);
  };
  // The straight part of each side's edge, between the quarters at its
  // ends, on the border edge and the padding edge: as far as a share may
  // reach along it past a corner.
  const straight = (q: Quarter[], across: number, down: number): number[] => {
    const rx = (i: number) => q[i]?.rx ?? 0;
    const ry = (i: number) => q[i]?.ry ?? 0;
    return [
      across - rx(0) - rx(1),
      down - ry(1) - ry(2),
      across - rx(2) - rx(3),
      down - ry(3) - ry(0),
    ].map((v) => Math.max(0, v));
  };
  const outerRoom = straight(outer, w, h);
  const innerRoom = straight(inner, ix1 - ix0, iy1 - iy0);
  /**
   * A share's end moved past the cut at a corner, onto the other share,
   * along an edge from the angle `a` it is at on a quarter: `forward` the
   * way the corner turns, onto the side that begins there, or back onto
   * the side that ends there. Far enough that the line it ends on is
   * `SEAM` from the cut, whatever angle the two make; as the angle it
   * reaches on the quarter and how far it goes on along the straight edge
   * past it, no further than `room`.
   */
  const past = (
    q: Quarter,
    i: number,
    a: number,
    forward: boolean,
    room: number,
  ): [number, number] => {
    const end = forward ? start(i) + QUARTER : start(i);
    const sign = forward ? 1 : -1;
    const [ex, ey] = forward ? ALONG[(i + 1) % 4] : ALONG[i];
    // the way it goes, and the sine of its angle with the cut
    let tx = forward ? ex : -ex;
    let ty = forward ? ey : -ey;
    if (q && a !== end) {
      const speed = Math.hypot(q.rx * Math.sin(a), q.ry * Math.cos(a));
      tx = (sign * -q.rx * Math.sin(a)) / speed;
      ty = (sign * q.ry * Math.cos(a)) / speed;
    }
    const dx = px[i] - ox[i];
    const dy = py[i] - oy[i];
    const sine = Math.abs(tx * dy - ty * dx) / Math.hypot(dx, dy);
    let left = SEAM / Math.max(0.25, sine);
    let at = a;
    for (let n = 0; q && n < 8 && left > 0 && at !== end; n += 1) {
      const speed = Math.hypot(q.rx * Math.sin(at), q.ry * Math.cos(at));
      const turn = Math.abs(end - at);
      if (left >= turn * speed) {
        left -= turn * speed;
        at = end;
      } else {
        at += (sign * left) / speed;
        left = 0;
      }
    }
    return [at, at === end ? Math.min(left, room) : 0];
  };
  const points: number[] = [];
  /** The point at an angle on a quarter, or the corner where it is square,
   *  and `over` on past the quarter's end along the edge `along`. */
  const point = (
    q: Quarter,
    a: number,
    cx: number,
    cy: number,
    over = 0,
    along: readonly number[] = ALONG[0],
  ): void => {
    const x = (q ? q.cx + q.rx * Math.cos(a) : cx) + over * along[0];
    const y = (q ? q.cy + q.ry * Math.sin(a) : cy) + over * along[1];
    const n = points.length;
    if (n && points[n - 2] === x && points[n - 1] === y) return;
    points.push(x, y);
  };
  /** A quarter's curve from one angle to another, as chords, after the
   *  point it starts at. */
  const sweep = (q: Quarter, from: number, to: number): void => {
    if (!q || from === to) return;
    const radius = Math.max(q.rx, q.ry);
    const step =
      radius > CURVE_TOLERANCE
        ? 2 * Math.acos(1 - CURVE_TOLERANCE / radius)
        : QUARTER;
    const n = Math.min(64, Math.ceil(Math.abs(to - from) / step));
    for (let k = 1; k <= n; k += 1) {
      point(q, from + ((to - from) * k) / n, 0, 0);
    }
  };
  for (let k = 0; k < runs.length; k += 1) {
    const { from: i, to: j, ink } = runs[k];
    if (ink === null) continue;
    // Where the share starts and ends on each edge. Two antialiased fills
    // that meet on a line each cover half of the pixels along it, and what
    // is under the border shows through between them. So a share reaches
    // on under the one drawn after it and covering it, and that one's
    // edge is the cut, over it — as Blink overdraws a corner, and as the
    // square corners are drawn.
    let [so, soOver] = [cutOuter[i], 0];
    let [si, siOver] = [cutInner[i], 0];
    let [eo, eoOver] = [cutOuter[j], 0];
    let [ei, eiOver] = [cutInner[j], 0];
    const back = (i + 3) % 4;
    if (under(k, i)) {
      [so, soOver] = past(outer[i], i, so, false, outerRoom[back]);
      [si, siOver] = past(inner[i], i, si, false, innerRoom[back]);
    }
    if (under(k, j)) {
      [eo, eoOver] = past(outer[j], j, eo, true, outerRoom[j]);
      [ei, eiOver] = past(inner[j], j, ei, true, innerRoom[j]);
    }
    const onward = ALONG[(j + 1) % 4];
    const backward = [-ALONG[i][0], -ALONG[i][1]];
    points.length = 0;
    // along the border edge, clockwise
    point(outer[i], so, ox[i], oy[i], soOver, backward);
    point(outer[i], so, ox[i], oy[i]);
    sweep(outer[i], so, start(i) + QUARTER);
    for (let c = (i + 1) % 4; ; c = (c + 1) % 4) {
      point(outer[c], start(c), ox[c], oy[c]);
      if (c === j) break;
      sweep(outer[c], start(c), start(c) + QUARTER);
    }
    sweep(outer[j], start(j), eo);
    point(outer[j], eo, ox[j], oy[j], eoOver, onward);
    // and back along the padding edge
    point(inner[j], ei, px[j], py[j], eiOver, onward);
    point(inner[j], ei, px[j], py[j]);
    sweep(inner[j], ei, start(j));
    for (let c = (j + 3) % 4; ; c = (c + 3) % 4) {
      point(inner[c], start(c) + QUARTER, px[c], py[c]);
      if (c === i) break;
      sweep(inner[c], start(c) + QUARTER, start(c));
    }
    sweep(inner[i], start(i) + QUARTER, si);
    point(inner[i], si, px[i], py[i], siOver, backward);
    ctx.fillStyle = ink;
    fillPolygon(ctx, points, area);
  }
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
 * of the box a paint reached. The window is the border edge's
 * (`roundedWindow`), whose curves the padding edge's run inside, and each
 * edge is cut to it as `cutRounded` cuts one. Null where the ring has
 * nothing in the window.
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
  const edge = { rect: { x, y, width: w, height: h }, corners };
  const cut = roundedWindow(options, [edge]);
  const outer = cutRounded(cut, edge);
  if (!outer) return null;
  const iw = w - left - right;
  const ih = h - top - bottom;
  const inner =
    iw > 0 && ih > 0
      ? cutRounded(cut, {
          rect: { x: x + left, y: y + top, width: iw, height: ih },
          corners: insetCorners(corners, top, right, bottom, left),
        })
      : null;
  // a window inside the padding edge, where the ring has nothing
  if (inner && sameRounded(outer, inner)) return null;
  return { outer, inner };
}

/** Where a paint is cut to (`roundedWindow`): left, top, right, bottom. */
type Cut = [number, number, number, number];

/**
 * The window `clampRect` cuts to, `pad` round what the paint reaches, for
 * rectangles with rounded corners: a cut is straight, so a side of it is
 * moved out past any corner's curve it would cross, in any of them.
 */
function roundedWindow(
  options: PaintOptions,
  shapes: readonly Rounded[],
  pad = CLAMP_PAD,
): Cut {
  // where each corner's curve runs, across and down
  const across: [number, number][] = [];
  const down: [number, number][] = [];
  for (const { rect, corners } of shapes) {
    const { x, y, width: w, height: h } = rect;
    const { x: cx, y: cy } = corners;
    across.push(
      [x, x + cx[0]],
      [x + w - cx[1], x + w],
      [x + w - cx[2], x + w],
      [x, x + cx[3]],
    );
    down.push(
      [y, y + cy[0]],
      [y, y + cy[1]],
      [y + h - cy[2], y + h],
      [y + h - cy[3], y + h],
    );
  }
  const d = options.damage;
  const side = (at: number, spans: [number, number][], towards: number) =>
    Math.max(
      -COORD_LIMIT,
      Math.min(COORD_LIMIT, outOfSpans(at, spans, towards)),
    );
  return [
    side(d ? d.x - pad : -COORD_LIMIT, across, -1),
    side(d ? d.y - pad : -COORD_LIMIT, down, -1),
    side(d ? d.x + d.width + pad : COORD_LIMIT, across, 1),
    side(d ? d.y + d.height + pad : COORD_LIMIT, down, 1),
  ];
}

/**
 * A rounded rectangle cut to a window (`roundedWindow`), as `clampRect`
 * cuts a rectangle: a corner on a side the window cut is square, its
 * curve being outside, and the rest are whole. Null where none of it is in
 * the window.
 */
function cutRounded(
  [x0, y0, x1, y1]: Cut,
  { rect: { x, y, width: w, height: h }, corners: c }: Rounded,
): Rounded | null {
  const l = Math.max(x, x0);
  const t = Math.max(y, y0);
  const r = Math.min(x + w, x1);
  const b = Math.min(y + h, y1);
  if (r <= l || b <= t) return null;
  // the corners of the sides the window left where they were
  const kept = [
    t === y && l === x,
    t === y && r === x + w,
    b === y + h && r === x + w,
    b === y + h && l === x,
  ];
  return {
    rect: { x: l, y: t, width: r - l, height: b - t },
    corners: {
      x: c.x.map((v, i) => (kept[i] ? v : 0)) as Corners['x'],
      y: c.y.map((v, i) => (kept[i] ? v : 0)) as Corners['y'],
    },
  };
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
 * fills where a rounded border is solid, inset or outset, the ring the
 * trapezoids of a 3D style make, and otherwise the rectangles `fillSide`
 * fills a side at a time — the dots, the dashes, the two lines of a double
 * border joined as they are painted, by the sides' colours though neither
 * is drawn. All of them run clockwise and a ring's inside the other way, so
 * the clip is the union by the non-zero rule, the one every context's
 * `clip` takes. Each is placed from the box's edges and then cut to the
 * painted area: placed from the cut, a border wider than `CLAMP_PAD` put
 * its bands and its ring's hole a border's width in from wherever the paint
 * was cut, and the background was painted over the content of a box
 * repainted in part. False where the border paints nothing in the painted
 * area or the context cannot clip, and nothing is pushed.
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

/** Whether every side a box has a border on is solid, or inset or outset,
 *  which a rounded box draws as one ring (`roundedRing`). */
function solidBorder(box: Frame): boolean {
  const s = box.style;
  return (
    (!box.borderTop || ringed(s.borderTopStyle)) &&
    (!box.borderRight || ringed(s.borderRightStyle)) &&
    (!box.borderBottom || ringed(s.borderBottomStyle)) &&
    (!box.borderLeft || ringed(s.borderLeftStyle))
  );
}

/** Whether a side of a rounded box is its share of the ring: a solid one in
 *  its colour, an inset or an outset one in its shade (`sculptedInk`). */
function ringed(style: ComputedStyle['borderTopStyle']): boolean {
  return style === 'solid' || style === 'inset' || style === 'outset';
}

/** The border styles drawn in two shades, as though lit from the top left. */
const SCULPTED = new Set(['groove', 'ridge', 'inset', 'outset']);

/** The shade a side of a 3D border is painted in, the top first and
 *  clockwise: a sunk one's top and left, which face the light, in the
 *  colour's shadow and its bottom and right lit, and a raised one's the
 *  other way round (`borderShades`). */
function sculptedInk(color: string, side: number, sunk: boolean): string {
  const shades = borderShades(color) ?? { lit: color, shadowed: color };
  const facing = side === 0 || side === 3;
  return sunk === facing ? shades.shadowed : shades.lit;
}

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
    const shade = (sunk: boolean) => sculptedInk(color, side, sunk);
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
 * (CSS 2.1 17.6.2.1). Painted over the cells' backgrounds and those of the
 * blocks in them, and under their floats and lines (`paintFlow`), as
 * browsers paint them.
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
    if (!clampRect(options, s.x, s.y, s.w, s.h)) continue;
    ctx.fillStyle = s.border.color;
    fillEdge(ctx, options, s.x, s.y, s.w, s.h, s.border.style, s.horizontal);
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
  if (horizontal) fillEdge(ctx, options, ex, ey, w, width, style, true);
  else fillEdge(ctx, options, ex, ey, width, h - t - b, style, false);
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

/**
 * A side at `x, y`, `w` by `h`, running across when `horizontal`, as the
 * rectangles its style makes, each cut to what the paint reaches. The
 * dashes, the dots and a double side's lines are measured from the side
 * and cut after: measured from the cut, a side wider than `CLAMP_PAD` had
 * dashes as long and as far apart as the cut was wide, starting wherever
 * it started, and a strip repainted down one dash was striped across it.
 */
function fillEdge(
  ctx: Pick<FillContext, 'fillRect'>,
  options: PaintOptions,
  x: number,
  y: number,
  w: number,
  h: number,
  style: ComputedStyle['borderTopStyle'],
  horizontal: boolean,
): void {
  const length = horizontal ? w : h;
  const thickness = horizontal ? h : w;
  if (!(length > 0 && thickness > 0)) return;
  const fill = (fx: number, fy: number, fw: number, fh: number): void => {
    const rect = clampRect(options, fx, fy, fw, fh);
    if (rect) ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  };
  if (style === 'dashed' || style === 'dotted') {
    // what of the side the paint reaches, so that a side far longer than
    // that is not walked from its start
    const cut = clampRect(options, x, y, w, h);
    if (!cut) return;
    const period = style === 'dotted' ? thickness * 2 : thickness * 3;
    const on = style === 'dotted' ? thickness : thickness * 2;
    const start = horizontal ? x : y;
    const end = start + length;
    const from = horizontal ? cut.x : cut.y;
    const to = from + (horizontal ? cut.w : cut.h);
    // from the side's start, so the dash the paint cuts into is the one it
    // always was
    for (
      let i = start + Math.floor((from - start) / period) * period;
      i < to;
      i += period
    ) {
      const run = Math.min(i + on, end) - i;
      if (horizontal) fill(i, y, run, thickness);
      else fill(x, i, thickness, run);
    }
    return;
  }
  if (style === 'double' && thickness >= 3) {
    const band = doubleBand(thickness);
    if (horizontal) {
      fill(x, y, length, band);
      fill(x, y + thickness - band, length, band);
    } else {
      fill(x, y, band, length);
      fill(x + thickness - band, y, band, length);
    }
    return;
  }
  fill(x, y, w, h);
}

/** A list item's bullet or number, in the margin. */
function paintMarker(
  ctx: PaintContext,
  marker: Marker,
  options: PaintOptions,
  /** The item's colour scheme, which an SVG image in it is drawn in. */
  scheme: 'light' | 'dark',
): void {
  const x = marker.x + options.originX;
  const y = marker.y + options.originY;
  if (marker.image) {
    // `list-style-image`'s, at its own size
    const { url, width, height } = marker.image;
    const loaded = options.backgroundImageFor?.(url);
    if (!loaded || !(width > 0 && height > 0)) return;
    if (loaded.image instanceof SvgDrawing) {
      drawSvg(ctx, loaded.image, x, y, width, height, scheme, options);
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
      drawSvg(
        ctx,
        image,
        at.x,
        at.y,
        at.w,
        at.h,
        box.style.colorScheme,
        options,
      );
    } else {
      // what of a large one is drawn: its box within the damage
      const damage = options.damage;
      const within = damage
        ? {
            x: Math.max(x, damage.x),
            y: Math.max(y, damage.y),
            w: Math.min(x + w, damage.x + damage.width) - Math.max(x, damage.x),
            h:
              Math.min(y + h, damage.y + damage.height) - Math.max(y, damage.y),
          }
        : { x, y, w, h };
      drawRaster(ctx, image, at.x, at.y, at.w, at.h, options, within);
    }
    if (clipped) ctx.restore();
    return;
  }
  // No image yet, or no image at all: a faint frame where it will be, so a
  // document with blocked resources still reads as a document with pictures
  // in it rather than as one with holes — but for a video a player shows,
  // which is no hole.
  if (box.el && options.mounted?.has(box.el)) return;
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
  const scale = options.scale ?? 1;
  inlineDrawing(box.el).draw(
    ctx,
    x,
    y,
    w,
    h,
    scale,
    style.color,
    paint(style.fill),
    paint(style.stroke),
    options.shapeStyler?.(box) ?? null,
    surfaceMaker(options),
    // its text is set in the box's font where it names none, as a
    // browser sets it: a size is a CSS pixel, which is a user unit
    {
      family: quotedFamilies(style.fontFamily),
      size: style.fontSize / scale,
      weight: style.fontWeight,
      style: style.fontStyle,
    },
  );
}

/** A number for an SVG image, the same while it lives: its part in the key
 *  of a raster kept of it (`drawSvg`). */
const DRAWINGS = new WeakMap<SvgDrawing, number>();
let drawings = 0;

/**
 * An SVG image, `w` by `h` device pixels at (`x`, `y`), drawn from a raster
 * of it kept at that size (`drawingKept`) where the context draws in whole
 * pixels of its own: no matrix (`PaintOptions.matrix`) and a corner on the
 * grid, where a raster copied is the drawing set again, pixel for pixel.
 * Elsewhere, and where none is kept, from its paths. A drawing of a few
 * tens of kilobytes took milliseconds to set from its paths, at every
 * paint that reached it: Zen Garden 219's fixed backgrounds at every frame
 * of a scroll, the panels its hovers move at every frame they moved.
 */
function drawSvg(
  ctx: PaintContext,
  svg: SvgDrawing,
  x: number,
  y: number,
  w: number,
  h: number,
  scheme: 'light' | 'dark',
  options: PaintOptions,
): void {
  const scale = options.scale ?? 1;
  if (
    !options.matrix &&
    options.drawingKept &&
    ctx.drawImage &&
    Number.isInteger(x) &&
    Number.isInteger(y)
  ) {
    let n = DRAWINGS.get(svg);
    if (n === undefined) DRAWINGS.set(svg, (n = ++drawings));
    const kept = options.drawingKept(
      `${n}|${w}x${h}|${scale}|${scheme}`,
      Math.ceil(w),
      Math.ceil(h),
      (sctx) =>
        svg.drawImage(sctx, 0, 0, w, h, scale, scheme, surfaceMaker(options)),
    );
    if (kept) {
      ctx.drawImage(kept, x, y);
      return;
    }
  }
  svg.drawImage(ctx, x, y, w, h, scale, scheme, surfaceMaker(options));
}

/**
 * A raster image, `w` by `h` device pixels at (`x`, `y`), drawn from a
 * raster of it kept at that size (`drawingKept`) where the draw resamples
 * it — the image is not that many pixels — and the context draws in whole
 * pixels of its own: no matrix and a corner on the grid, where a raster
 * copied is the image drawn there again, pixel for pixel, as an SVG
 * image's is (`drawSvg`). Elsewhere, and where none is kept, the image
 * itself. CoreGraphics reads all of a source for a draw that scales it,
 * whatever the clip, so a photograph drawn small cost its whole size at
 * every paint that reached any of it: the Zen Garden's all-designs page
 * draws a preview of 1022 by 1132 pixels at a third of that, 2.5 ms a
 * draw, nine of them in each frame of a card's hover.
 */
function drawRaster(
  ctx: PaintContext,
  image: unknown,
  x: number,
  y: number,
  w: number,
  h: number,
  options: PaintOptions,
  within: { x: number; y: number; w: number; h: number } | null = null,
): void {
  const own = image as { width?: unknown; height?: unknown };
  if (
    (own.width !== w || own.height !== h) &&
    typeof own.width === 'number' &&
    typeof own.height === 'number' &&
    !options.matrix &&
    options.drawingKept &&
    Number.isInteger(x) &&
    Number.isInteger(y)
  ) {
    if (
      w * h > RASTER_TILE * RASTER_TILE &&
      Number.isInteger(w) &&
      Number.isInteger(h)
    ) {
      drawRasterTiles(ctx, image, x, y, w, h, options, within);
      return;
    }
    const kept = options.drawingKept(
      `image|${imageId(image as object)}|${w}x${h}`,
      Math.ceil(w),
      Math.ceil(h),
      (sctx) => sctx.drawImage!(image, 0, 0, w, h),
    );
    if (kept) {
      ctx.drawImage!(kept, x, y);
      return;
    }
  }
  ctx.drawImage!(image, x, y, w, h);
}

/** The side of a tile a large raster is kept in (`drawRasterTiles`), in
 *  device pixels: a tile is a quarter of what the kept drawings' cache
 *  takes in one surface. */
const RASTER_TILE = 1024;

/**
 * A raster image too large to keep on one surface at the size it is drawn
 * at, kept a tile of `RASTER_TILE` device pixels at a time, and only the
 * tiles that reach `within` drawn — each the image drawn at its whole size
 * on the tile's surface, moved by the tile's corner, so a tile copied is
 * the image drawn there again, pixel for pixel. A tile not kept yet is the
 * image drawn under a clip to it, and where none is, the image drawn once.
 * Zen Garden 101's page is a 1972 by 667 GIF behind the whole document,
 * and at 2x CoreGraphics resampled all of it at every paint: 4 to 6 ms of
 * each frame of a resize, which copies of its tiles take a fraction of.
 */
function drawRasterTiles(
  ctx: PaintContext,
  image: unknown,
  x: number,
  y: number,
  w: number,
  h: number,
  options: PaintOptions,
  within: { x: number; y: number; w: number; h: number } | null,
): void {
  const id = imageId(image as object);
  // the tiles that reach what is painted, of those that make the image
  let left = 0;
  let top = 0;
  let right = Math.ceil(w / RASTER_TILE);
  let bottom = Math.ceil(h / RASTER_TILE);
  if (within) {
    left = Math.max(left, Math.floor((within.x - x) / RASTER_TILE));
    top = Math.max(top, Math.floor((within.y - y) / RASTER_TILE));
    right = Math.min(right, Math.ceil((within.x + within.w - x) / RASTER_TILE));
    bottom = Math.min(
      bottom,
      Math.ceil((within.y + within.h - y) / RASTER_TILE),
    );
  }
  const missed: { x: number; y: number; w: number; h: number }[] = [];
  let tiles = 0;
  for (let j = top; j < bottom; j += 1) {
    for (let i = left; i < right; i += 1) {
      tiles += 1;
      const tx = i * RASTER_TILE;
      const ty = j * RASTER_TILE;
      const tw = Math.min(RASTER_TILE, w - tx);
      const th = Math.min(RASTER_TILE, h - ty);
      const kept = options.drawingKept!(
        `image|${id}|${w}x${h}|${i},${j}`,
        tw,
        th,
        (sctx) => sctx.drawImage!(image, -tx, -ty, w, h),
      );
      if (kept) ctx.drawImage!(kept, x + tx, y + ty);
      else missed.push({ x: x + tx, y: y + ty, w: tw, h: th });
    }
  }
  if (missed.length === 0) return;
  if (missed.length === tiles || !canClip(ctx)) {
    ctx.drawImage!(image, x, y, w, h);
    return;
  }
  for (const tile of missed) {
    pushClip(ctx, tile, null);
    ctx.drawImage!(image, x, y, w, h);
    ctx.restore();
  }
}

/** What makes the surface a masked element inside a drawing is drawn on:
 *  the one the document's own masks are drawn on. */
function surfaceMaker(options: PaintOptions): SurfaceMaker | null {
  const make = options.surface;
  return make ? (width, height) => make(width, height) : null;
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
  const dy = options.originY;
  const damage = options.damage;

  const visible: LineBox[] = [];
  if (damage) {
    // Lines are built top to bottom, so `y` is monotone; a line's *bottom*
    // is not (heights vary), which is what the tallest-line slack is for.
    // Start at the first line that could reach the damage, stop at the
    // first one past it: the cost is the visible lines, not the box's.
    // And the lines whose text casts a shadow that falls in it, from as far
    // above or below as the shadows fall (`textShadowReach`)
    const cast = textShadowReach(box);
    const top = damage.y - dy - (cast?.bottom ?? 0);
    const bottom = damage.y - dy + damage.height + (cast?.top ?? 0);
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
  // A line's atomics are painted in their turn among its text (CSS 2.1
  // Appendix E, 7.2.1), and so is all of a line before a later one: drawn
  // after it all, an inline-block a negative margin had a word after it
  // drawn over went over the word, and over the text of the next line it
  // hung into. They are painted after their stretch of the lines' text,
  // which is that order wherever nothing after one in the document is
  // under it, so the lines are painted in parts only where something is
  // (`lineParts`): text after an atomic it covers starts a part of its
  // own. It is never inside a layout: an atomic ends the text before it.
  const parts = lineParts(lines, visible);
  if (!parts) paintLinePart(ctx, box, lines, visible, options, null);
  else {
    for (const part of parts) {
      paintLinePart(ctx, box, lines, part.lines, options, part);
    }
  }
}

/** What of a block's visible lines `paintLines` paints, a part of them at
 *  a time (`LinePart`), or all of them in one where `part` is null. */
function paintLinePart(
  ctx: PaintContext,
  box: Box,
  lines: LineBox[],
  visible: LineBox[],
  options: PaintOptions,
  part: LinePart | null,
): void {
  const dx = options.originX;
  const dy = options.originY;
  const skip = part?.skip;
  // Three passes over the visible lines, not one: ntk draws a whole layout
  // in one glyph batch, so a multi-line paragraph's ink all lands on the
  // first line that references it — and anything painted "under the ink" on
  // a later line would land *over* it. Everything under the glyphs is
  // painted for every line first, then the ink once per layout, then the
  // rules over it.
  const bleeds: Bleed[] = [];
  for (const line of visible) {
    if (line.background && (!part || startsIn(part, line))) {
      paintLineBackground(ctx, line, options);
    }
    paintInlineBoxes(
      ctx,
      line,
      lines,
      options,
      line === lines[0] ? null : bleeds,
      part,
    );
    for (const text of line.texts) {
      if (skip?.has(text)) continue;
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
    paintSelection(ctx, line, options, skip);
  }

  if (SHADOWED_TEXT.has(box)) paintTextShadows(ctx, visible, options, skip);

  // an underline goes under the glyphs, a line through over them (CSS 2.1
  // Appendix E): a descender crosses its own underline
  paintRules(ctx, visible, dx, dy, options.scale ?? 1, 'under', skip);

  if (CLIPPED_TEXT.has(box)) {
    paintClippedText(ctx, box, visible, options, skip);
  }

  // One `draw` per layout: a paragraph is a single glyph composite, and
  // drawing it once per line would be one X request per line for the same
  // batch.
  const drawn = new Set<unknown>();
  // text a `::selection` colours is drawn in that colour where selected
  const recolored = options.selectionStyler
    ? recoloredBands(visible, options, skip)
    : null;
  for (const line of visible) {
    for (const text of line.texts) {
      if (skip?.has(text)) continue;
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
      if (bands) {
        drawRecolored(ctx, options, text.layout, text.drawX + dx, top, bands);
      } else text.layout.draw(ctx, text.drawX + dx, top);
      if (clipped) ctx.restore();
    }
  }

  paintRules(ctx, visible, dx, dy, options.scale ?? 1, 'over', skip);
  if (bleeds.length) paintBleeds(ctx, bleeds, options);
  // One painted with the positioned boxes is its stacking context's to
  // paint, there (`layered`) — one set below the flow with a negative
  // `z-index` among them (`hoistNegative`): painted by its line as well,
  // it came back over the box it was under.
  for (const line of visible) {
    for (const placed of line.atomics) {
      const atomic = placed.box;
      if (skip?.has(placed) || liftedOff(atomic)) continue;
      // drawn on its line rather than in the inline boxes it is in, which
      // fade it here (`inlineFade`)
      const fade = inlineFade(atomic.parent);
      if (fade <= 0) continue;
      const faded = fade < 1 && typeof ctx.globalAlpha === 'number';
      if (faded) {
        ctx.save();
        ctx.globalAlpha = ctx.globalAlpha! * fade;
      }
      paintBox(ctx, atomic, options);
      if (faded) ctx.restore();
    }
  }
}

/** Whether an atomic on a line is painted with the positioned boxes, and
 *  not by its line (`layered`). */
function liftedOff(box: Box): boolean {
  return box.parent !== null && layered(box.parent, box);
}

/**
 * A stretch of a block's visible lines, in the document's order, that
 * `paintLines` paints before the next: an atomic and what is before it, or
 * what is after one, up to the next atomic that covers what is after it.
 * The items of its lines that another part paints are in `skip`, and only
 * its first and last lines have any; how far its inline boxes' fragments
 * and a `::first-line` background on those go with it, its places there
 * say (`placesOn`).
 */
interface LinePart {
  lines: LineBox[];
  skip: Set<LineText | AtomicPlacement>;
  /** Its first item's place on its first line, and the place on its last
   *  line of the first item it does not paint: Infinity where it paints
   *  all of it. */
  from: number;
  to: number;
}

/** Whether a part of a block's lines paints what is at the start of one of
 *  its lines. */
function startsIn(part: LinePart, line: LineBox): boolean {
  return line !== part.lines[0] || part.from === 0;
}

/**
 * Each text and atomic on a line, with its place among them all in the
 * document's order (`AtomicPlacement.before`): `line.texts` and
 * `line.atomics` are each in that order, and apart.
 */
function placesOn(
  line: LineBox,
  each: (item: LineText | AtomicPlacement, place: number) => void,
): void {
  const texts = line.texts;
  const atomics = line.atomics;
  let j = 0;
  for (let i = 0; i <= texts.length; i += 1) {
    while (j < atomics.length && atomics[j].before <= i) {
      each(atomics[j], i + j);
      j += 1;
    }
    if (i < texts.length) each(texts[i], i + j);
  }
}

/**
 * Where `paintLines` has to paint a block's visible lines in parts, so that
 * an atomic is painted in its turn among their text: after an atomic that
 * what is after it in the document is drawn over. Null where nothing is,
 * which is nearly every block, painted in one part as it always was.
 */
function lineParts(lines: LineBox[], visible: LineBox[]): LinePart[] | null {
  // the lines columns took apart are in no order down the page
  const apart = columned.any && COLUMN_LINES.has(lines);
  const above = LINE_INK.get(lines)?.above ?? 0;
  let cuts: [number, number][] | null = null;
  for (let i = 0; i < visible.length; i += 1) {
    const atomics = visible[i].atomics;
    for (let j = 0; j < atomics.length; j += 1) {
      const placed = atomics[j];
      if (liftedOff(placed.box)) continue;
      if (!coversLater(visible, i, placed, above, apart)) continue;
      // after it: its place, and one
      (cuts ??= []).push([i, placed.before + j + 1]);
    }
  }
  if (!cuts) return null;
  const parts: LinePart[] = [];
  let first = 0;
  let from = 0;
  cuts.push([visible.length - 1, Infinity]);
  for (const [last, to] of cuts) {
    const skip = new Set<LineText | AtomicPlacement>();
    placesOn(visible[first], (item, place) => {
      if (place < from) skip.add(item);
    });
    placesOn(visible[last], (item, place) => {
      if (place >= to) skip.add(item);
    });
    parts.push({ lines: visible.slice(first, last + 1), skip, from, to });
    // and the next from there, or from the next line where that is the
    // end of this one
    const line = visible[last];
    if (to >= line.texts.length + line.atomics.length) {
      first = last + 1;
      from = 0;
    } else {
      first = last;
      from = to;
    }
    if (first >= visible.length) break;
  }
  return parts;
}

/**
 * Whether what an atomic draws reaches text after it in the document, which
 * is painted over it: on its line after it, or on a line after its line.
 */
function coversLater(
  visible: LineBox[],
  at: number,
  placed: AtomicPlacement,
  /** How far a line's glyphs reach above it (`LINE_INK`). */
  above: number,
  apart: boolean,
): boolean {
  const box = placed.box;
  const known = Number.isFinite(box.boundsY);
  const x1 = known ? box.boundsX : box.x;
  const y1 = known ? box.boundsY : box.y;
  const x2 = x1 + (known ? box.boundsWidth : box.width);
  const y2 = y1 + (known ? box.boundsHeight : box.height);
  if (!(x2 > x1 && y2 > y1)) return false;
  const line = visible[at];
  for (let i = placed.before; i < line.texts.length; i += 1) {
    if (textMeets(line.texts[i], x1, y1, x2, y2)) return true;
  }
  for (let k = at + 1; k < visible.length; k += 1) {
    const next = visible[k];
    if (next.y - above >= y2) {
      if (apart) continue;
      break;
    }
    for (const text of next.texts) {
      if (textMeets(text, x1, y1, x2, y2)) return true;
    }
  }
  return false;
}

/** Whether a text on a line, where its glyphs reach from ascent to descent
 *  and across its run of the line, meets a rectangle. */
function textMeets(
  text: LineText,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const natural = text.layout.lines[text.layoutLine];
  if (!natural) return false;
  const left = text.drawX + natural.x;
  const right = left + natural.width + (text.trail ?? 0);
  if (right <= x1 || left >= x2) return false;
  const baseline = text.drawY + natural.baseline;
  const top = Math.min(
    text.drawY + natural.y,
    baseline - (natural.ascent ?? 0),
  );
  const bottom = Math.max(
    text.drawY + natural.y + natural.height,
    baseline + (natural.descent ?? 0),
  );
  return top < y2 && bottom > y1;
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
 *  ink is, its texts, where they are drawn, their glyphs from ascent to
 *  descent, and the shadows its inline boxes cast — reaches the rows
 *  between `top` and `bottom`: what was moved off it, and what hangs past
 *  it. */
function inkInto(line: LineBox, top: number, bottom: number): boolean {
  const casts = LINE_CASTS.get(line);
  if (casts && casts.top < bottom && casts.bottom > top) return true;
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

/** An inline box's fragment whose padding, border or shadow reaches up
 *  over the lines before its own, the box its shadows are cast from
 *  (`paintFragmentShadows`), where its own line starts, and how faded the
 *  box is drawn (`inlineFade`). */
interface Bleed {
  fragment: Frame;
  caster: Frame;
  lineTop: number;
  fade: number;
}

/**
 * The part of each such fragment above its line, drawn again over the
 * text there. CSS 2.1 Appendix E paints a block's inline content a line at
 * a time, backgrounds before text, so a box on the second line with
 * padding enough to reach the first is drawn over the first line's text,
 * and so is a shadow it casts that far; the ink here goes on in one batch
 * after every line's backgrounds (`paintLines`), which left that text over
 * it.
 */
function paintBleeds(
  ctx: PaintContext,
  bleeds: Bleed[],
  options: PaintOptions,
): void {
  if (!ctx.save || !ctx.restore || !ctx.beginPath || !ctx.rect || !ctx.clip)
    return;
  for (const { fragment, caster, lineTop, fade } of bleeds) {
    const shadows = fragment.style.boxShadow;
    const out = shadows ? shadowOutsets(shadows) : null;
    const left =
      Math.floor(fragment.x - (out?.left ?? 0) + options.originX) - 1;
    const top = Math.floor(fragment.y - (out?.top ?? 0) + options.originY) - 1;
    const width =
      Math.ceil(fragment.width + (out ? out.left + out.right : 0)) + 2;
    const bottom = Math.round(lineTop + options.originY);
    if (bottom <= top) continue;
    ctx.save();
    if (fade < 1 && typeof ctx.globalAlpha === 'number') {
      ctx.globalAlpha *= fade;
    }
    ctx.beginPath();
    ctx.rect(left, top, width, bottom - top);
    ctx.clip();
    if (shadows) paintFragmentShadows(ctx, fragment, caster, options, false);
    paintLayers(ctx, fragment, options, frameImages(ctx, fragment, options));
    if (shadows) paintFragmentShadows(ctx, fragment, caster, options, true);
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
  /** What of the lines another part of them paints (`LinePart`). */
  skip?: ReadonlySet<unknown>,
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
      if (skip?.has(text)) continue;
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
        const clip = clipBoxOf(text.spans.boxAt?.(run.start) ?? null);
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
    // an inline box's background, faded with it and the inline boxes
    // around it (`inlineFade`) — in its colours, since ntk draws glyphs at
    // full strength whatever the context's alpha is
    const fade = inlineFade(clip);
    if (fade <= 0) continue;
    const list = [...byLayout.values()];
    const style = clip.style;
    let area: Rect;
    if (clip.kind !== 'inline') area = paddingBox(clip, options);
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
    const found =
      style.backgroundGradient ??
      gradientOf(
        style.backgroundImages?.find((image) => gradientOf(image)) ?? null,
      );
    const gradient = found && fadedGradient(found, fade, style.color);
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
      fill = fadeColor(
        inkColor(style.backgroundColor as string, style.color),
        fade,
      );
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

/** The shadows one stretch of a layout's text casts, the colour its
 *  `currentColor` is, and how much the inline boxes around the text fade
 *  them (`textFade`). */
interface Cast {
  shadows: BoxShadow[];
  color: string;
  fade: number;
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
  /** What of the lines another part of them paints (`LinePart`). */
  skip?: ReadonlySet<unknown>,
): void {
  if (!('shadowBlur' in ctx) || !ctx.save || !ctx.restore) return;
  const dx = options.originX;
  const dy = options.originY;
  const whole = new Set<unknown>();
  for (const line of lines) {
    for (const text of line.texts) {
      if (skip?.has(text)) continue;
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
        castShadows(ctx, options, text, left, top, cast, null);
        if (clipped) ctx.restore();
        continue;
      }
      const natural = layout.lines[text.layoutLine];
      if (!natural || !text.spans.boxAt) continue;
      for (const [stretch, from, to] of stretchesOf(text, natural)) {
        castShadows(ctx, options, text, left, top, stretch, {
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
const MIXED: Cast = { shadows: [], color: '', fade: 1 };

/** What a layout's runs cast: null for none, the one cast of all of them,
 *  or `MIXED`. Kept by the map of its runs to their boxes, which is its
 *  paragraph's own — not by the layout, which another paragraph of the same
 *  runs may share, casting other shadows or none, since a shadow is no
 *  field of a run — until a restyle in place changes what its boxes cast
 *  (`forgetCasts`). */
const CASTS = new WeakMap<object, Cast | null>();

/** A restyle in place (a `:hover`, a frame of an animation) has given the
 *  boxes of a layout's runs new styles, which may cast other shadows, in
 *  another colour or faded otherwise: the layout's cast is asked again. */
export function forgetCasts(spans: object): void {
  CASTS.delete(spans);
}

function castOf(text: LineText): Cast | null {
  const layout = text.layout;
  if (CASTS.has(text.spans)) return CASTS.get(text.spans)!;
  let cast: Cast | null | undefined;
  const boxAt = text.spans.boxAt;
  for (const natural of layout.lines) {
    for (const run of natural.runs) {
      // a spacer, or a bidi control, is no one's text and draws nothing
      const box = boxAt?.call(text.spans, run.start);
      if (!box) continue;
      const shadows = box.style.textShadow;
      const next = shadows
        ? { shadows, color: box.style.color, fade: textFade(box) }
        : null;
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
    a === b ||
    (!!a &&
      !!b &&
      a.shadows === b.shadows &&
      a.color === b.color &&
      a.fade === b.fade)
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
    const box = text.spans.boxAt!.call(text.spans, run.start);
    if (!box?.style.textShadow) continue;
    const cast = {
      shadows: box.style.textShadow,
      color: box.style.color,
      fade: textFade(box),
    };
    const last = out[out.length - 1];
    if (last && sameCast(last[0], cast) && Math.abs(last[2] - run.x) < 0.5) {
      last[2] = Math.max(last[2], run.x + run.width);
    } else out.push([cast, run.x, run.x + run.width]);
  }
  return out;
}

/**
 * Whether a context casts a shadow from what it draws, its colour's alpha
 * and all, rather than from the coverage alone, as ntk's does and a
 * browser casts a text's — so that `color: transparent` with a
 * `text-shadow` is blurred text there. The native contexts (`scalesText`)
 * are the first: on macOS, text in a transparent colour casts no shadow,
 * and a run faded by the inline boxes around it (`fadeRun`) casts one
 * faded as much already. Windows' is taken to cast as macOS's does, and
 * has not been tried.
 */
function castsFromInk(ctx: PaintContext): boolean {
  return ctx.scalesText === true;
}

/** A layout's shadows, drawn where `left` and `top` put it, each clipped to
 *  `stretch` where the layout's runs do not all cast them. */
function castShadows(
  ctx: PaintContext,
  options: PaintOptions,
  text: LineText,
  left: number,
  top: number,
  cast: Cast,
  stretch: { x: number; y: number; width: number; height: number } | null,
): void {
  if (cast.fade <= 0) return;
  // faded by the inline boxes around the text, as its glyphs are — which
  // a context that casts from what it draws has done already
  const fade = castsFromInk(ctx) ? 1 : cast.fade;
  const layout = text.layout;
  // clear of the window: the far end of its furthest line, which a line
  // `text-align` moves in from the layout's left reaches past its width,
  // at the window's left
  let right = layout.width;
  for (const natural of layout.lines) {
    right = Math.max(right, natural.x + natural.width);
  }
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
    ctx.shadowColor = fadeColor(inkColor(s.color, cast.color), fade);
    // CoreGraphics casts no shadow with no blur at all: a hard one is one
    // blurred too little to see
    const move = aside(
      options.matrix,
      left,
      top,
      left + right,
      top + layout.height,
      s.x,
      s.y,
      s.blur > 0 ? s.blur : 0.01,
    );
    ctx.shadowBlur = move.blur;
    ctx.shadowOffsetX = move.offsetX;
    ctx.shadowOffsetY = move.offsetY;
    layout.draw(ctx, left + move.x, top + move.y);
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
  /** What of the lines another part of them paints (`LinePart`). */
  skip?: ReadonlySet<unknown>,
): void {
  for (const line of lines) {
    const shifted = SHIFTED_LINES.has(line);
    for (const text of line.texts) {
      if (skip?.has(text)) continue;
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
function fragmentsOn(
  line: LineBox,
  /** Whether to say where in the line's order each fragment starts
   *  (`InlineFragment.first`). */
  places = false,
): Map<Box, InlineFragment[]> | null {
  /** What is on the line, where, and which decorated boxes it is in. */
  const marks: {
    left: number;
    right: number;
    boxes: readonly Box[];
    /** An edge's own box, whose fragment it opens or closes. */
    edge?: EdgePlacement;
    /** Its text's or atomic's place on the line (`placesOn`). */
    place?: number;
  }[] = [];
  const shifted = SHIFTED_LINES.has(line);
  const atomics = line.atomics;
  let before = 0;
  for (let i = 0; i < line.texts.length; i += 1) {
    const text = line.texts[i];
    const natural = text.layout.lines[text.layoutLine];
    const boxAt = text.spans.boxAt;
    if (places)
      while (before < atomics.length && atomics[before].before <= i)
        before += 1;
    const place = places ? i + before : undefined;
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
      marks.push({ left, right, boxes: decoratedAncestors(owner), place });
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
        place,
      });
    }
  }
  for (let j = 0; j < atomics.length; j += 1) {
    const placed = atomics[j];
    const atomic = placed.box;
    marks.push({
      left: placed.x - atomic.marginLeft,
      right: placed.x + atomic.width + atomic.marginRight,
      boxes: decoratedAncestors(atomic),
      place: places ? placed.before + j : undefined,
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
      if (mark.place !== undefined) {
        open.first = Math.min(open.first ?? Infinity, mark.place);
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
  /** The part of the lines being painted, whose fragments are the ones
   *  that start in it: one is painted before what it is around, and over
   *  an atomic before it (`LinePart`). */
  part: LinePart | null = null,
): void {
  // where the part starts and ends on this line, in places
  const from = part && line === part.lines[0] ? part.from : 0;
  const to =
    part && line === part.lines[part.lines.length - 1] ? part.to : Infinity;
  const whole = from === 0 && to === Infinity;
  const fragments = fragmentsOn(line, !whole);
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
    // faded by its own opacity and the inline boxes' around it, each
    // fragment on its own (`inlineFade`)
    const fade = inlineFade(box);
    if (fade <= 0) continue;
    for (const f of fragments.get(box)!) {
      if (!whole) {
        const first = f.first ?? 0;
        if (first < from || first >= to) continue;
      }
      paintInlineFragment(
        ctx,
        line,
        lines,
        options,
        bleeds,
        box,
        f,
        baseline,
        fade,
      );
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
  fade: number,
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
    // Its images and gradients placed along the strip its fragments make,
    // where it goes on to another line, and its shadows cast by it, cut
    // where this fragment is: a sliced box is drawn as though it had not
    // broken (CSS Fragmentation 3, 5.4). From its own box where it is on
    // this line alone, or `clone` says each fragment is its own.
    const shadows = style.boxShadow;
    let caster: Frame = fragment;
    if (
      !(f.start && f.end) &&
      box.style.boxDecorationBreak === 'slice' &&
      (shadows !== null || sliced(box.style))
    ) {
      const strip = stripFor(lines, line, box, fragment);
      if (strip && sliced(box.style)) fragment.strip = strip;
      if (strip && shadows) caster = strip;
    }
    const faded = fade < 1 && typeof ctx.globalAlpha === 'number';
    if (faded) {
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha! * fade;
    }
    // the outer shadows under the background, the inset ones over it and
    // under the border, as a block's (CSS Backgrounds 3, 7.1)
    if (shadows) paintFragmentShadows(ctx, fragment, caster, options, false);
    paintLayers(ctx, fragment, options, frameImages(ctx, fragment, options));
    if (shadows) paintFragmentShadows(ctx, fragment, caster, options, true);
    paintBorders(ctx, fragment, options);
    if (box.style.outlineStyle !== 'none') paintOutline(ctx, fragment, options);
    if (faded) ctx.restore();
    const reach = shadows ? shadowOutsets(shadows).top : 0;
    if (bleeds && fragment.y - reach < line.y - 0.5) {
      bleeds.push({
        fragment,
        caster,
        lineTop: line.y + (moved?.y ?? 0),
        fade,
      });
    }
  }
}

/**
 * The shadows of one kind an inline box's fragment casts, from `caster`:
 * the fragment itself, or the strip its fragments make laid end to end
 * (`stripFor`), cut at each edge of the fragment's that the strip goes on
 * past. So a sliced box casts no shadow at an edge where it breaks, and one
 * that runs along it — a ring's top and bottom, the line a link's `0 2px 0`
 * draws under it — runs on to the cut (CSS Fragmentation 3, 5.4), as
 * Chrome, Firefox and Safari draw them. Where a shadow is offset along the
 * line by more than the fragments past the break reach, they part: Chrome
 * casts it from the fragment run on past the break without end, Firefox
 * and Safari from the fragment alone, and this from the unbroken box, as
 * the spec has it.
 */
function paintFragmentShadows(
  ctx: PaintContext,
  fragment: Frame,
  caster: Frame,
  options: PaintOptions,
  inset: boolean,
): void {
  const shadows = fragment.style.boxShadow!;
  if (!shadows.some((s) => s.inset === inset)) return;
  if (caster === fragment) {
    paintShadows(ctx, fragment, options, inset);
    return;
  }
  if (!ctx.save || !ctx.restore || !ctx.beginPath || !ctx.rect || !ctx.clip)
    return;
  // cut on the pixel the fragment's background is cut on, and on a side the
  // box ends on, as far out as the shadows fall
  const out = shadowOutsets(shadows);
  const dx = options.originX;
  const dy = options.originY;
  const right = fragment.x + fragment.width;
  const left =
    caster.x < fragment.x - 0.01
      ? Math.round(fragment.x + dx)
      : Math.floor(fragment.x - out.left + dx) - 1;
  const end =
    caster.x + caster.width > right + 0.01
      ? Math.round(right + dx)
      : Math.ceil(right + out.right + dx) + 1;
  const top = Math.floor(fragment.y - out.top + dy) - 1;
  const bottom = Math.ceil(fragment.y + fragment.height + out.bottom + dy) + 1;
  if (!(end > left)) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, end - left, bottom - top);
  ctx.clip();
  paintShadows(ctx, caster, options, inset);
  ctx.restore();
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

/** Of a block's lines, by the array they are, the strip of each decorated
 *  inline box on them, which its images are placed along and its shadows
 *  cast from (`sliced`, `paintFragmentShadows`): made once a layout, as
 *  `MOVED_OFF_LINES` is, so a repaint of one line reads the lines before it
 *  without going over them again. A restyle in place that decorates a box
 *  or stops decorating one forgets them (`forgetDecoratedAncestors`). */
const STRIPS = new WeakMap<readonly LineBox[], Map<Box, Strip>>();

function stripsOf(lines: readonly LineBox[]): Map<Box, Strip> {
  const strips = new Map<Box, Strip>();
  for (const line of lines) {
    const fragments = fragmentsOn(line);
    if (!fragments) continue;
    for (const [box, list] of fragments) {
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
  /** The place on the line of the first text or atomic it is around
   *  (`placesOn`), where that was asked; none for one around nothing but
   *  its edges, which goes with the line's start. */
  first?: number;
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
 *  walk above climbs — looks again. So do the strips of its block's lines,
 *  which are of the boxes decorated (`STRIPS`). A document built again has
 *  new boxes, and so no lists. */
export function forgetDecoratedAncestors(box: Box): void {
  const stack = [...box.children];
  while (stack.length) {
    const at = stack.pop()!;
    DECORATED.delete(at);
    if (at.kind === 'inline') stack.push(...at.children);
  }
  let block = box.parent;
  while (block?.kind === 'inline') block = block.parent;
  if (block?.lines) STRIPS.delete(block.lines);
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
  /** What of the line another part of its lines paints (`LinePart`). */
  skip?: ReadonlySet<unknown>,
): void {
  for (const band of selectedBands(line, options, skip)) {
    const fill = band.style ? band.style.background : options.selectionColor;
    if (!fill || isTransparent(fill) || band.fade <= 0) continue;
    ctx.fillStyle = fadeColor(fill, band.fade);
    ctx.fillRect(band.x, band.y, band.width, band.height);
  }
}

/** A stretch of selected text on one line, in window pixels, and the
 *  `::selection` of the element it is in: null for the palette's. */
interface SelectedBand extends Rect {
  style: SelectionStyle | null;
  /** How much the inline boxes around its text fade it (`textFade`), whose
   *  highlight is drawn as a part of what they hold. */
  fade: number;
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
function selectedBands(
  line: LineBox,
  options: PaintOptions,
  skip?: ReadonlySet<unknown>,
): SelectedBand[] {
  const range = options.selection;
  if (!range || range.end <= range.start) return NO_BANDS;
  if (line.textEnd <= range.start || line.textStart >= range.end) {
    return NO_BANDS;
  }
  const out: SelectedBand[] = [];
  for (const text of line.texts) {
    if (skip?.has(text)) continue;
    const natural = text.layout.lines[text.layoutLine];
    if (!natural) continue;
    const from = Math.max(range.start, text.textStart);
    const to = Math.min(range.end, text.textEnd);
    if (to <= from) continue;
    const offsets = layoutOffsets(text.layout);
    const rows = selectionRows(line, text, natural);
    const y = Math.round(rows.y + options.originY);
    const height = Math.ceil(rows.height);
    // less the text no selection takes: generated content, mostly
    const pieces = range.skip?.length
      ? selectedPieces(from, to, range.skip)
      : [[from, to] as const];
    for (const [a, b] of pieces) {
      selectedIn(text, natural, offsets, a, b, y, height, options, out);
    }
  }
  return out;
}

/** A document range, in code units, less the runs no selection takes
 *  (`BoxTree.unselectable`): what a highlight lights of it. */
export function selectedPieces(
  from: number,
  to: number,
  skip: readonly number[],
): (readonly [number, number])[] {
  const out: [number, number][] = [];
  let at = from;
  for (let i = 0; i < skip.length && at < to; i += 2) {
    if (skip[i + 1] <= at) continue;
    if (skip[i] >= to) break;
    if (skip[i] > at) out.push([at, skip[i]]);
    at = Math.max(at, skip[i + 1]);
  }
  if (at < to) out.push([at, to]);
  return out;
}

/** The bands of one stretch of a line text's selected text, from `from` to
 *  `to` in the document's code units, a band for each `::selection` and
 *  fade over it (`selectionPieces`). */
function selectedIn(
  text: LineText,
  natural: LineText['layout']['lines'][number],
  offsets: ReturnType<typeof layoutOffsets>,
  from: number,
  to: number,
  y: number,
  height: number,
  options: PaintOptions,
  out: SelectedBand[],
): void {
  const layoutFrom = layoutOffsetOf(text, from);
  const layoutTo = layoutOffsetOf(text, to, true);
  const pieces = selectionPieces(
    text,
    natural,
    layoutFrom,
    layoutTo,
    options.selectionStyler ?? null,
  ) ?? [{ from: layoutFrom, to: layoutTo, style: null, fade: 1 }];
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
        fade: piece.fade,
        layout: text.layout,
      });
    }
  }
}

/** A stretch of a line's selected text, in the layout's offsets, that one
 *  `::selection` styles and the inline boxes around it fade alike. */
interface SelectionPiece {
  from: number;
  to: number;
  style: SelectionStyle | null;
  fade: number;
}

/**
 * A line's selected text, `from` to `to` in the layout's offsets, cut where
 * the `::selection` over it changes, or how much the inline boxes around it
 * fade it (`textFade`): a run's are its element's, and a run of no
 * element's — an inline box's edge, laid out as a spacer — the one beside
 * it, so a styled band has no palette-coloured gap at a `<span>`. Null
 * where no rule styles a selection and no box around the text fades it,
 * which is one piece.
 */
function selectionPieces(
  text: LineText,
  natural: LineText['layout']['lines'][number],
  from: number,
  to: number,
  styler: SelectionStyler | null,
): SelectionPiece[] | null {
  const runs = natural.runs
    .filter((run) => run.end > from && run.start < to)
    .sort((a, b) => a.start - b.start);
  const boxAt = text.spans.boxAt;
  const styles: (SelectionStyle | null | undefined)[] = [];
  const fades: (number | undefined)[] = [];
  // selected text nobody can see is lit by no band and set in no colour:
  // a heading a page hid under the `::after` it shows was drawn over it
  const unseen: boolean[] = [];
  let faded = false;
  let hidden = false;
  for (const run of runs) {
    const box = boxAt?.call(text.spans, run.start) ?? null;
    styles.push(box ? (styler?.(box) ?? null) : undefined);
    const fade = box ? textFade(box) : undefined;
    if (fade !== undefined && fade < 1) faded = true;
    fades.push(fade);
    const away = !!box && box.style.visibility !== 'visible';
    if (away) hidden = true;
    unseen.push(away);
  }
  if (!styler && !faded && !hidden) return null;
  for (let i = 1; i < runs.length; i += 1) {
    if (styles[i] === undefined) styles[i] = styles[i - 1];
    if (fades[i] === undefined) fades[i] = fades[i - 1];
  }
  for (let i = runs.length - 2; i >= 0; i -= 1) {
    if (styles[i] === undefined) styles[i] = styles[i + 1];
    if (fades[i] === undefined) fades[i] = fades[i + 1];
  }
  const out: SelectionPiece[] = [];
  let apart = false;
  runs.forEach((run, i) => {
    if (unseen[i]) {
      apart = true;
      return;
    }
    const style = styles[i] ?? null;
    const fade = fades[i] ?? 1;
    const last = out[out.length - 1];
    if (last && !apart && last.style === style && last.fade === fade) {
      last.to = Math.min(to, run.end);
    } else {
      apart = false;
      out.push({
        from: Math.max(from, run.start),
        to: Math.min(to, run.end),
        style,
        fade,
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
  skip?: ReadonlySet<unknown>,
): Map<unknown, SelectedBand[]> | null {
  let out: Map<unknown, SelectedBand[]> | null = null;
  for (const line of lines) {
    for (const band of selectedBands(line, options, skip)) {
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
 * colours. A band's colour is faded as the inline boxes around its text
 * fade it, as the glyphs it replaces were (`fadeRun`) — but by a context
 * that casts from what it draws, which casts from those faded glyphs.
 */
function drawRecolored(
  ctx: PaintContext,
  options: PaintOptions,
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
  const move = aside(
    options.matrix,
    left,
    top,
    left + right,
    top + layout.height,
    0,
    0,
    0.01,
  );
  const colors = new Map<string, SelectedBand[]>();
  const inked = castsFromInk(ctx);
  for (const band of bands) {
    const color = inked
      ? band.style!.color!
      : fadeColor(band.style!.color!, band.fade);
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
    ctx.shadowBlur = move.blur;
    ctx.shadowOffsetX = move.offsetX;
    ctx.shadowOffsetY = move.offsetY;
    layout.draw(ctx, left + move.x, top + move.y);
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
