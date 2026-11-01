// SVG, drawn.
//
// An inline `<svg>` and an SVG image are drawn by ntk's `SvgView`, over the
// same 2d context as the rest of the document — the drawing core's own
// `<svg>` element uses. It is reached through `react-x11/ntk`, which
// re-exports ntk whole: `SvgView` is a runtime export the subpath's
// declarations do not name, so it is read off the namespace and probed, the
// way `resources.ts` reaches `decodeImage`. Without it an SVG is a box of its
// size with nothing drawn in it, which is what it was before.
//
// What is here is the part CSS and SVG own between them: an SVG's intrinsic
// width, height and ratio, which size its box (CSS 2.1 10.3.2, SVG 2's
// intrinsic sizing), and its viewport — the `viewBox` scaled into the box
// as `preserveAspectRatio` says, and clipped to it.
import { parseDocument } from 'htmlparser2';
import { Element, Text } from 'domhandler';
import type { ChildNode, ParentNode } from 'domhandler';
import * as ntk from 'react-x11/ntk';
import { isSvgRoot, mutationGeneration, rawTextOf } from './dom.js';
import { Cascade, drawingVars } from './css/cascade.js';
import { parseMediaQuery, parseStylesheet } from './css/parse.js';
import type { Stylesheet } from './css/parse.js';
import { isUse, quotedFamilies, urlIds, useHref } from './css/shapes.js';
import type { DrawingUnits, ShapeStyle, ShapeStyles } from './css/shapes.js';
import type { RootLook } from './css/style.js';
import { parseMath } from './css/calc.js';
import {
  AUTO,
  inkColor,
  isTransparent,
  parseColor,
  parseLength,
  resolve,
} from './css/values.js';
import type { UnitContext } from './css/values.js';
import { mapRect, multiply } from './css/transform.js';
import type { Matrix } from './css/transform.js';

export { isSvgRoot, quotedFamilies };

/** What an image says about its own size, in CSS pixels: a width and a
 *  height — a raster image always has both, an SVG those that are absolute
 *  lengths — and its ratio, width over height, or 0 where it has none. */
export interface IntrinsicSize {
  width: number | null;
  height: number | null;
  ratio: number;
}

function svgAttr(el: Element, name: string): string | undefined {
  // an XML parse keeps SVG's camelCase, an HTML one lowercases it
  return el.attribs[name] ?? el.attribs[name.toLowerCase()];
}

/** CSS pixels per unit, for the absolute units. */
const ABSOLUTE: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i;

/** An SVG `width` or `height` in CSS pixels, where it is an absolute length.
 *  A percentage, `auto` and anything unparseable are no length at all, and
 *  a negative one is an error, which is the same. */
function absoluteLength(
  value: string | undefined,
  fontSize: number,
): number | null {
  if (value === undefined) return null;
  const m = LENGTH.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  let px: number;
  if (unit in ABSOLUTE) px = n * ABSOLUTE[unit];
  else if (unit === 'em') px = n * fontSize;
  else if (unit === 'ex') px = (n * fontSize) / 2;
  else return null;
  return px >= 0 ? px : null;
}

function viewBoxParts(el: Element): [number, number, number, number] | null {
  const parts = (svgAttr(el, 'viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  return [parts[0], parts[1], parts[2], parts[3]];
}

function viewBoxOf(el: Element): [number, number, number, number] | null {
  const parts = viewBoxParts(el);
  // a zero or negative extent: as though there were none (see `drawsNothing`)
  return parts && parts[2] > 0 && parts[3] > 0 ? parts : null;
}

/** Whether a `viewBox` with a zero width or height disables the drawing,
 *  as SVG has it: a negative one is an error and as though there were no
 *  `viewBox`, but a zero one is a drawing of nothing. */
function drawsNothing(el: Element): boolean {
  const parts = viewBoxParts(el);
  return (
    parts !== null &&
    parts[2] >= 0 &&
    parts[3] >= 0 &&
    (parts[2] === 0 || parts[3] === 0)
  );
}

/**
 * An SVG root's intrinsic size and ratio (SVG 2, "Intrinsic sizing
 * properties of the viewport of SVG images"): its `width` and `height` where
 * they are absolute, and a ratio from those two, or else from its `viewBox`.
 * `fontSize` is what an `em` in them is, in CSS pixels.
 */
export function svgIntrinsics(el: Element, fontSize = 16): IntrinsicSize {
  const width = absoluteLength(svgAttr(el, 'width'), fontSize);
  const height = absoluteLength(svgAttr(el, 'height'), fontSize);
  let ratio = 0;
  if (width !== null && height !== null && width > 0 && height > 0) {
    ratio = width / height;
  } else {
    const box = viewBoxOf(el);
    if (box) ratio = box[2] / box[3];
  }
  return { width, height, ratio };
}

/**
 * An image's natural size at a pixel density: its pixels over the density,
 * so that a `2x` source is half its pixels across (CSS Images 4, 2.4; HTML's
 * "normalize the source densities"), and a drawing's own size the same. Its
 * ratio is its ratio at any density; a density of 0 leaves it as it is.
 */
export function atDensity(size: IntrinsicSize, density: number): IntrinsicSize {
  if (density === 1 || !(density > 0)) return size;
  return {
    width: size.width === null ? null : size.width / density,
    height: size.height === null ? null : size.height / density,
    ratio: size.ratio,
  };
}

/**
 * An image's size, in device pixels, where nothing sets it: CSS Images 3's
 * default sizing algorithm (5.3.3), against a default object size of
 * `width` by `height` device pixels — a background's positioning area, a
 * list marker's square. Its own size where it has one; the dimension it
 * lacks from its ratio, or else from the default; and one with a ratio
 * alone as large as fits in the default. An SVG may be any of these, and a
 * raster image is the first. `scale` is device pixels per CSS pixel, which
 * the image's own size is in.
 */
export function concreteSize(
  size: IntrinsicSize,
  width: number,
  height: number,
  scale: number,
): [number, number] {
  const { ratio } = size;
  const w = size.width === null ? null : size.width * scale;
  const h = size.height === null ? null : size.height * scale;
  if (w !== null && h !== null) return [w, h];
  if (w !== null) return [w, ratio > 0 ? w / ratio : height];
  if (h !== null) return [ratio > 0 ? h * ratio : width, h];
  if (ratio > 0) {
    return width / height > ratio
      ? [height * ratio, height]
      : [width, width / ratio];
  }
  return [width, height];
}

/** What makes an offscreen surface for a masked element in a drawing, or
 *  null where there is none (`PaintOptions.surface`). */
export type SurfaceMaker = (width: number, height: number) => unknown;

/** The font an inline drawing's text inherits from the box it is drawn
 *  in, the size in CSS pixels: what `SvgView` reads as `opts.font`. */
export interface DrawingFont {
  family: string;
  size: number;
  weight: number;
  style: string;
}

/** The slice of ntk's `SvgView` this draws with. */
interface SvgViewLike {
  naturalWidth: number;
  naturalHeight: number;
  setSvgDom(element: Element): unknown;
  draw(
    ctx: unknown,
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: ViewOptions,
  ): void;
}

/** What `SvgView.draw` is handed besides the rectangle (`SvgDrawing.draw`). */
interface ViewOptions {
  color?: string;
  surface?: SurfaceMaker;
  font?: DrawingFont;
  /** What draws what a `<foreignObject>` holds (`ForeignPainter`), which
   *  an `SvgView` from before sidorares/ntk#549 does not call. */
  foreignObject?: (element: Element, ctx: ClipContext, box: ForeignBox) => void;
}

type SvgViewConstructor = new (window: null) => SvgViewLike;

/** Where a `<foreignObject>` is in the user space it is drawn in, in user
 *  units: its `x`, `y`, `width` and `height`. */
export interface ForeignRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What `SvgView` hands `opts.foreignObject` of an object: its rectangle
 *  in its user space, and what the opacities down to it come to. */
export interface ForeignBox extends ForeignRect {
  opacity: number;
}

/**
 * What paints the HTML a `<foreignObject>` holds, where the drawing reaches
 * it in its paint order (`SvgView`'s `opts.foreignObject`, sidorares/ntk#549):
 * `el` is the document's element, `ctx` the context the drawing draws it
 * on — its matrix the object's user space, clipped to whatever clips the
 * object in the drawing, and lent as the drawing's is (`lend`) — and `box`
 * where the object is in that user space, with its opacity.
 */
export type ForeignPainter = (
  el: Element,
  ctx: ClipContext,
  box: ForeignBox,
) => void;

function svgViewClass(): SvgViewConstructor | null {
  const ctor = (ntk as unknown as Record<string, unknown>).SvgView;
  return typeof ctor === 'function' ? (ctor as SvgViewConstructor) : null;
}

/** The copies `copyTree` made of the document's `<foreignObject>`s, by the
 *  copy: what `SvgView` hands over is the copy, and what paints it is
 *  found by the element. */
const FOREIGN_COPIES = new WeakMap<Element, Element>();

/** Whether `SvgView` hands an object over, by the `draw` it was asked of:
 *  a test's stand-in for the hook wraps it. */
const HANDS_OVER = new WeakMap<object, boolean>();

/** A context that draws nothing, for `drawsForeignObjects`. */
const NOWHERE = {
  globalAlpha: 1,
  save() {},
  restore() {},
  translate() {},
  scale() {},
  transform() {},
};

/**
 * Whether `SvgView` hands a `<foreignObject>` to `opts.foreignObject` to
 * draw (sidorares/ntk#549): asked of the view itself, by drawing an object
 * on a context that draws nothing and seeing whether it was handed over.
 * Where it is not, no object's HTML is built or drawn, as an engine with no
 * seam for it draws none — and a `<switch>` draws what is after it.
 */
export function drawsForeignObjects(): boolean {
  const View = svgViewClass();
  if (!View) return false;
  const draw = View.prototype.draw as object;
  let known = HANDS_OVER.get(draw);
  if (known === undefined) {
    known = false;
    try {
      const view = new View(null);
      const object = new Element('foreignObject', { width: '1', height: '1' });
      view.setSvgDom(new Element('svg', { width: '1', height: '1' }, [object]));
      view.draw(NOWHERE, 0, 0, 1, 1, {
        foreignObject: () => {
          known = true;
        },
      });
    } catch {
      known = false;
    }
    HANDS_OVER.set(draw, known);
  }
  return known;
}

/** A `<foreignObject>`'s `x`, `y`, `width` or `height` in user units: a
 *  number, a length in an absolute unit, or a percentage of the viewport's
 *  side `of` — and `fallback` for none, `auto` or what does not parse. */
function userLength(
  value: string | undefined,
  of: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const v = value.trim();
  const viewport = viewportLength(v, of);
  if (viewport !== null) return viewport;
  const m = LENGTH.exec(v);
  if (!m) return fallback;
  const unit = USER_UNITS[m[2].toLowerCase()] ?? (m[2] ? null : 1);
  return unit === null ? fallback : parseFloat(m[1]) * unit;
}

/**
 * Where a `<foreignObject>` is in its user space (SVG 2, 23.2): its `x`
 * and `y`, 0 where it has none, and its `width` and `height`, which are 0
 * where it has none or they are `auto` — a drawing of nothing — and
 * percentages of the viewport, `[width, height]` in user units. A negative
 * size is an error, and as none.
 */
export function foreignRect(
  el: Element,
  viewport: readonly [number, number],
): ForeignRect {
  const [vw, vh] = viewport;
  const width = userLength(svgAttr(el, 'width'), vw, 0);
  const height = userLength(svgAttr(el, 'height'), vh, 0);
  return {
    x: userLength(svgAttr(el, 'x'), vw, 0),
    y: userLength(svgAttr(el, 'y'), vh, 0),
    width: width > 0 ? width : 0,
    height: height > 0 ? height : 0,
  };
}

/**
 * The viewport of an inline `<svg>` drawn in a content box `width` by
 * `height` CSS pixels, in its user units: its `viewBox`'s size, or the
 * box's where it has none — what a percentage of the viewport in it is of.
 */
export function drawingViewport(
  root: Element,
  width: number,
  height: number,
): [number, number] {
  const box = viewBoxOf(root);
  return box ? [box[2], box[3]] : [width, height];
}

/**
 * The `<foreignObject>`s of a drawing, in its order: each in the drawing's
 * tree and none in what another holds, whose HTML is the other's (an
 * `<svg>` in it is a drawing of its own). Kept until more of the drawing
 * has arrived (`End`), and made again with the drawing at a `refresh()`
 * (`inlineDrawing`).
 */
function foreignObjectsUnder(root: Element): Element[] {
  const found: Element[] = [];
  // the parser keeps a document to 256 elements deep (`dom.ts`)
  const walk = (el: Element): void => {
    for (const child of el.children) {
      if (child.type !== 'tag') continue;
      const tag = child as Element;
      if (localName(tag.name) === 'foreignobject') found.push(tag);
      else walk(tag);
    }
  };
  walk(root);
  return found;
}

/** The context slice an SVG needs besides what `SvgView` itself calls. */
export interface ClipContext {
  save(): void;
  restore(): void;
  beginPath?(): void;
  rect?(x: number, y: number, w: number, h: number): void;
  clip?(): void;
  fill?: unknown;
  fillStyle?: unknown;
  fillRect?(x: number, y: number, w: number, h: number): void;
}

/** A context as a drawing it is lent to sees it (`lend`). */
interface Lent {
  readonly ctx: ClipContext;
  /** The saves the drawing has made on it and not restored. */
  open: number;
  /** The context's alpha as it was lent, which every alpha the drawing
   *  sets is a fraction of. */
  alpha: number;
}

const LENT = new WeakMap<object, Lent>();

/** A context's alpha, where it has one to read. */
function alphaOf(ctx: ClipContext): number {
  const alpha = (ctx as { globalAlpha?: unknown }).globalAlpha;
  return typeof alpha === 'number' && alpha >= 0 && alpha <= 1 ? alpha : 1;
}

/**
 * The context a drawing is lent: the same context, keeping count of the
 * saves the drawing makes on it, so that whatever it leaves saved can be
 * restored after it, and making none of the restores it makes past them.
 *
 * `SvgView` saves the context as it starts to draw, and around an element
 * with a `transform`, and restores in no `finally`: an element it throws
 * on — a colour it cannot read, `fill="var(--c)"` — leaves those saves
 * open. The restore after the drawing then took the last of them for its
 * own save, and the clip to the drawing's box was left on the window's
 * context: everything a later paint drew, in that frame and every frame
 * after, was cut to a sixteen-pixel icon. nextjs.org's blog drew its
 * heading, the icon beside it, and nothing more.
 *
 * And keeping the alpha it was lent at. `SvgView` sets `globalAlpha` to
 * each mark's own, from 1 at its root, so a drawing in an element that
 * fades a thing at a time — a native context, where no group goes on a
 * surface — came out whole: reactmelbourne.com's grain, a full-window
 * `<rect>` at `opacity: .025`, drew the window black on macOS. What the
 * drawing sets is a fraction of the alpha it was lent at, and what it
 * reads is what it set.
 */
function lend(ctx: ClipContext): Lent {
  const known = LENT.get(ctx);
  if (known) return known;
  const bound = new WeakMap<object, unknown>();
  const save = () => {
    ctx.save();
    lent.open += 1;
  };
  const restore = () => {
    if (lent.open === 0) return;
    lent.open -= 1;
    ctx.restore();
  };
  const lent: Lent = {
    open: 0,
    alpha: 1,
    ctx: new Proxy(ctx, {
      get(target, key) {
        if (key === 'save') return save;
        if (key === 'restore') return restore;
        if (key === 'globalAlpha') {
          const now = Reflect.get(target, key) as number;
          return lent.alpha > 0 ? now / lent.alpha : now;
        }
        // on the context itself: an accessor, a method and a private field
        // all see the context they belong to
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        let method = bound.get(value);
        if (!method) {
          method = value.bind(target);
          bound.set(value, method);
        }
        return method;
      },
      set: (target, key, value) =>
        Reflect.set(
          target,
          key,
          key === 'globalAlpha' ? Number(value) * lent.alpha : value,
        ),
    }),
  };
  LENT.set(ctx, lent);
  return lent;
}

/** The axes a drawing is cut to its rectangle on (`SvgDrawing.draw`). */
export interface DrawingCut {
  readonly x: boolean;
  readonly y: boolean;
}

const CUT_BOTH: DrawingCut = { x: true, y: true };

const ALIGN = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/;
const AT: Record<string, number> = { Min: 0, Mid: 0.5, Max: 1 };

/**
 * One SVG drawing: an inline `<svg>` element, or an SVG image's document.
 * The `SvgView` is made at the first draw, so a document whose drawings are
 * never scrolled to never pays for them.
 */
export class SvgDrawing {
  readonly intrinsics: IntrinsicSize;
  private readonly _root: Element;
  private _view: SvgViewLike | null = null;
  /** What the view was last handed the tree for: the root's child count,
   *  and where the root and each element outside it a `<use>` drew ended —
   *  a streamed document grows an inline drawing after its first paint,
   *  and a sprite's symbol after the first icon drawn from it — and, for a
   *  drawing with lengths to work out, what they were worked out against
   *  (`Lengths`). */
  private _seen = -1;
  private _seenEnds: End[] = [];
  private _seenViewport = '';
  /** The `fill` and `stroke` the view's tree was last given its root's,
   *  and what the document's rules gave the elements in it. */
  private _seenPaint = '';
  /** Whether a length in the tree is one `SvgView` reads otherwise than
   *  CSS, which the tree it is handed has worked out (`lengthsToWorkOut`):
   *  a percentage of the viewport, a math function, a length in a unit;
   *  null until the tree is first read. */
  private _lengths: boolean | null = null;
  /** Whether a `<use>` in the tree is one `SvgView` cannot draw as it
   *  stands (`needsExpanding`). */
  private _uses = false;
  /** Whether the tree names an element outside it by a `url(#…)`
   *  (`refersOutside`), which its copy brings. */
  private _outside = false;
  /** The document's last node when a `<use>` was last looked up and its
   *  element not found: a streamed document may bring it yet, and has
   *  when its last node is another. Undefined where none was missing. */
  private _missingAt: ChildNode | null | undefined = undefined;
  private _failed = false;
  /** An SVG image's own document, rather than an element of this one. */
  private readonly _standalone: boolean;
  /** The background an image's root gives its canvas; undefined until it
   *  is first read. */
  private _canvas: string | null | undefined = undefined;
  /** An SVG image's own style sheets, its `<style>` elements': read at its
   *  first draw, and none for most images. */
  private _sheets: Stylesheet[] | null = null;
  /** Whether an image with none has a `var()` to read all the same
   *  (`drawingVars`); null until it is first drawn. */
  private _vars: boolean | null = null;
  /** A cascade over them for each colour scheme and scale the image is
   *  drawn at, and what each gave it: by the viewport it was asked at where
   *  a sheet reads the viewport, and under one key where none does. */
  private _cascades = new Map<
    string,
    { cascade: Cascade; own: Map<string, ImagePaint | null> }
  >();

  /** Whether the drawing has a `<text>` in it, and where the drawing
   *  ended when that was asked (`hasText`). */
  private _text: boolean | null = null;
  private _textEnd: End | null = null;

  /** Its `<foreignObject>`s, and where the drawing ended when they were
   *  looked for (`foreignObjects`). */
  private _foreign: Element[] | null = null;
  private _foreignEnd: End | null = null;

  /** Where it last worked out what it paints reaches (`reach`): for what,
   *  and where the drawing ended then. */
  private _reached: { key: string; end: End; edges: Edges | null } | null =
    null;

  /** What it is drawn from (`drawnFrom`), and where that ended; undefined
   *  until it is first asked for (`keptAs`). */
  private _from: DrawnFrom | undefined = undefined;

  /** The element an SVG image's URL names by its fragment, its own
   *  `:target`: a sprite sheet shows the icon `image.svg#icon` names. */
  private readonly _target: Element | null;

  constructor(
    root: Element,
    intrinsics: IntrinsicSize,
    standalone = false,
    target: Element | null = null,
  ) {
    this._root = root;
    this.intrinsics = intrinsics;
    this._standalone = standalone;
    this._target = target;
  }

  /**
   * Draw into a rectangle — the box's content box, in device pixels —
   * clipped to it. The `viewBox`, where there is one, is fitted to it as
   * `preserveAspectRatio` says; without one a user unit is a CSS pixel,
   * which is `scale` device pixels. `color` is `currentColor`, and `fill`
   * and `stroke` the root's own where the document's styles set them (SVG
   * 2, 13.2): they are properties, which a style sheet's rule sets over
   * the presentation attribute, and what is in the drawing inherits them
   * from its root. `shapes` is what the rules give the elements inside it,
   * the same way, where they give any.
   *
   * `surface` makes what a masked element in it is drawn on, as the
   * document's own masks are (`PaintOptions.surface`): a context that is
   * not ntk's, react-x11's on macOS, has no other way to one. And `font`
   * is what its text inherits — the box's, for an inline drawing, as a
   * browser has it; an image's text starts from its own initial font.
   */
  draw(
    ctx: ClipContext,
    x: number,
    y: number,
    w: number,
    h: number,
    scale: number,
    color?: string,
    fill: string | null = null,
    stroke: string | null = null,
    shapes: ShapeStyles | null = null,
    surface: SurfaceMaker | null = null,
    font: DrawingFont | null = null,
    /** What else its root inherits from the document around it, as
     *  declarations: `stroke-width: 6px;` and the like. */
    inherited = '',
    /** What paints the HTML of its `<foreignObject>`s, where it has any
     *  the document laid out (`ForeignPainter`); none draws nothing of
     *  them. */
    foreign: ForeignPainter | null = null,
    /** What a `rem` and a `vw` in its geometry are of, the document's
     *  (`DrawingUnits`); an image's are its initial font size and the
     *  rectangle it is drawn in. */
    units: DrawingUnits | null = null,
    /** The axes it is cut to the rectangle on: an inline drawing's whose
     *  `overflow` is not `visible` there, which is every one the page says
     *  nothing of (`svg:not(:root) { overflow: hidden }`, SVG 2, 6.14). */
    cut: DrawingCut = CUT_BOTH,
  ): void {
    if (this._failed || !(w > 0 && h > 0)) return;
    // the mock backend has no path API, and SvgView draws paths
    if (!ctx.beginPath || !ctx.rect || !ctx.clip || !ctx.fill) return;
    const root = this._root;
    if (drawsNothing(root)) return;
    if (this._standalone) {
      // the root's background is the canvas's, and an image's canvas is
      // all of the rectangle, wherever its viewport and `viewBox` put the
      // drawing (CSS 2.1 14.2): an inline one's is its box's, painted by
      // the document
      this._canvas ??= canvasBackground(root);
      if (this._canvas && ctx.fillRect) {
        ctx.save();
        ctx.fillStyle = inkColor(this._canvas, color ?? '#000000');
        ctx.fillRect(x, y, w, h);
        ctx.restore();
      }
      // An image's root fills the rectangle it is drawn into, whatever its
      // own `width` and `height` say: they are what its intrinsic size was
      // read from (`svgIntrinsics`), and the rectangle is the concrete size
      // the image was then given — a background's tile, an `<img>`'s box.
      // Blink sizes an SVG embedded as an image to its container the same
      // way. Drawn as two fifths of it, `width="40%"` left the rest of a
      // `background-size: contain` empty. An inline root's percentages are
      // its box's, already (`svgSizeHint`).
    }
    const box = viewBoxOf(root);
    // the viewport in user units, which a percentage is of
    let vw = w / scale;
    let vh = h / scale;
    // An image with no `viewBox` is laid out at its own size, along an
    // axis it has one on, and stretched to the rectangle along it, as a
    // raster image is: Blink gives it a `viewBox` of its own size that
    // `preserveAspectRatio: none` fits. Drawn at its own size, an icon of
    // `width="24" height="24"` shown 48 wide was a quarter of its box.
    let kx = 1;
    let ky = 1;
    if (!box && this._standalone) {
      const own = this.intrinsics;
      if (own.width !== null && own.width > 0) {
        kx = vw / own.width;
        vw = own.width;
      }
      if (own.height !== null && own.height > 0) {
        ky = vh / own.height;
        vh = own.height;
      }
    }
    const paint =
      (fill === null ? '' : `fill:${fill};`) +
      (stroke === null ? '' : `stroke:${stroke};`);
    // what a length in a unit of its font, of the root's or of the
    // viewport's comes to: user units, which are CSS pixels
    const lengths: Lengths = {
      em: font && font.size >= 0 ? font.size : 16,
      rem: units?.rem ?? 16,
      vw: units?.vw ?? w / scale,
      vh: units?.vh ?? h / scale,
    };
    const view = box
      ? this._viewFor(box[2], box[3], paint, shapes, inherited, lengths)
      : this._viewFor(vw, vh, paint, shapes, inherited, lengths);
    if (!view) return;
    ctx.save();
    // the view draws on the context lent, which counts its saves and keeps
    // its alpha
    const lent = lend(ctx);
    const outer = lent.open;
    const outerAlpha = lent.alpha;
    lent.open = 0;
    lent.alpha = alphaOf(ctx);
    try {
      if (cut.x && cut.y) {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
      } else if (cut.x || cut.y) {
        // cut on one axis, and as far as it reaches on the other
        const r = this.reach(x, y, w, h, scale, shapes, lengths.em);
        const x1 = cut.x || !r ? x : Math.min(x, Math.floor(r.x) - 1);
        const y1 = cut.y || !r ? y : Math.min(y, Math.floor(r.y) - 1);
        const x2 = cut.x || !r ? x + w : Math.max(x + w, r.x + r.width + 1);
        const y2 = cut.y || !r ? y + h : Math.max(y + h, r.y + r.height + 1);
        ctx.beginPath();
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
        ctx.clip();
      }
      const opts: ViewOptions = {};
      if (color) opts.color = color;
      if (surface) opts.surface = surface;
      if (font) opts.font = font;
      if (foreign) {
        // what is handed over is the tree's: a copy, where it was copied
        opts.foreignObject = (node, on, object) =>
          foreign(FOREIGN_COPIES.get(node) ?? node, on, object);
      }
      if (!box) {
        view.draw(
          lent.ctx,
          x,
          y,
          view.naturalWidth * scale * kx,
          view.naturalHeight * scale * ky,
          opts,
        );
      } else {
        const fit = (svgAttr(root, 'preserveAspectRatio') ?? '')
          .trim()
          .split(/\s+/);
        if (fit[0] === 'defer') fit.shift();
        if (fit[0] === 'none') {
          view.draw(lent.ctx, x, y, w, h, opts);
        } else {
          const align = ALIGN.exec(fit[0] ?? '') ?? ['xMidYMid', 'Mid', 'Mid'];
          const sx = w / box[2];
          const sy = h / box[3];
          const s = fit[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
          const dw = box[2] * s;
          const dh = box[3] * s;
          view.draw(
            lent.ctx,
            x + (w - dw) * AT[align[1]],
            y + (h - dh) * AT[align[2]],
            dw,
            dh,
            opts,
          );
        }
      }
    } catch {
      // a drawing ntk cannot read is left undrawn, once, rather than thrown
      // out of paint on every frame, where nothing could catch it
      this._failed = true;
    } finally {
      // what the drawing saved and did not restore, before this one's own
      // save — which the restore after it would otherwise have taken, and
      // this one's clip been left on the window's context (`lend`)
      for (; lent.open > 0; lent.open -= 1) ctx.restore();
      lent.open = outer;
      lent.alpha = outerAlpha;
      ctx.restore();
    }
  }

  /**
   * The rectangle around what the drawing paints, drawn into `x`, `y`, `w`
   * and `h` as `draw` draws it, or null where it paints nothing
   * (`drawingReach`): past the rectangle where its shapes reach outside its
   * viewport, which an inline drawing whose `overflow` is `visible` shows.
   * A flow editor draws each edge in an `<svg>` of the default size, 300 by
   * 150, at the corner of its graph, and the edge wherever it goes. `em` is
   * its root's font size, in user units. Worked out again once more of a
   * streamed drawing has arrived, or for another viewport or other rules.
   */
  reach(
    x: number,
    y: number,
    w: number,
    h: number,
    scale: number,
    shapes: ShapeStyles | null,
    em: number,
  ): { x: number; y: number; width: number; height: number } | null {
    if (this._failed || !(w > 0 && h > 0)) return null;
    const root = this._root;
    if (drawsNothing(root)) return null;
    const box = viewBoxOf(root);
    const vw = box ? box[2] : w / scale;
    const vh = box ? box[3] : h / scale;
    const key = `${vw}x${vh}|${em}|${shapes?.key ?? ''}`;
    let kept = this._reached;
    if (!kept || kept.key !== key || moved(kept.end)) {
      const lengths: Lengths = { em, rem: 16, vw: w / scale, vh: h / scale };
      kept = {
        key,
        end: endOf(root),
        edges: drawingReach(root, [vw, vh], lengths, shapes?.of ?? null),
      };
      this._reached = kept;
    }
    const e = kept.edges;
    if (!e) return null;
    // where a user unit is drawn, as `draw` fits the drawing in
    const fit = box
      ? svgTransform(
          fitTransform(box, x, y, w, h, svgAttr(root, 'preserveAspectRatio')),
        )
      : null;
    return mapRect(
      fit ?? [scale, 0, 0, scale, x, y],
      e.x1,
      e.y1,
      e.x2 - e.x1,
      e.y2 - e.y1,
    );
  }

  /**
   * What a raster of the drawing `w` by `h` device pixels is kept by
   * (`PaintOptions.drawingKept`), from the arguments `draw` is handed: all it
   * is set from, as text, or null where no raster can stand for it. By what
   * the drawing says and not by the drawing, since a `refresh()` makes every
   * drawing of a document again (`inlineDrawing`), and a page's scripts
   * refresh at most of its frames; and so the same icon on every row of a
   * list is one raster. **Anything new `draw` reads joins this key.** No text
   * is set in a drawing that has a key (`drawnFrom`), which leaves of its
   * font only the size an `em` in it is of.
   */
  keptAs(
    w: number,
    h: number,
    scale: number,
    color: string,
    fill: string | null,
    stroke: string | null,
    shapes: ShapeStyles | null,
    em: number,
    inherited: string,
    units: DrawingUnits | null,
  ): string | null {
    if (this._failed || !(w > 0 && h > 0)) return null;
    if (!this._from || this._from.ends.some(moved)) {
      this._from = drawnFrom(this._root);
    }
    const from = this._from;
    // a rule may name what is outside the drawing, which no key here holds
    if (!from.source || shapes?.key.includes('url(')) return null;
    let key =
      `inline|${from.source}|${w}x${h}|${scale}|${color}|${fill}|${stroke}` +
      `|${em}|${inherited}|${shapes?.key ?? ''}`;
    if (from.units) key += `|${units?.rem}|${units?.vw}|${units?.vh}`;
    return key;
  }

  /**
   * Whether the drawing sets text: glyphs, which a context that does not
   * scale text with its transform — ntk's — sets level whatever turns the
   * box the drawing is in. Asked again once more of a streamed drawing has
   * arrived.
   */
  hasText(): boolean {
    if (this._text === null || !this._textEnd || moved(this._textEnd)) {
      this._text = holdsText(this._root);
      this._textEnd = endOf(this._root);
    }
    return this._text;
  }

  /**
   * Its `<foreignObject>`s, in its order (`foreignObjectsUnder`): what the
   * box tree builds the HTML of. Looked for again once more of a streamed
   * drawing has arrived; for most drawings, none.
   */
  foreignObjects(): readonly Element[] {
    if (!this._foreign || !this._foreignEnd || moved(this._foreignEnd)) {
      this._foreign = foreignObjectsUnder(this._root);
      this._foreignEnd = endOf(this._root);
    }
    return this._foreign;
  }

  /**
   * Draw an SVG image — an `<img>`'s, a background's, a list marker's — as
   * `draw` does, painted as its own style sheets say. An image is a
   * document of its own: no rule of the page's reaches into it, and its
   * `color` is not the page's. What its `<style>` elements say is given
   * its elements as the page's rules are given a drawing inline, and its
   * root its `color`, `fill` and `stroke`, which an inline root has from
   * its box. `scheme` is the colour scheme of the element that embeds it:
   * what `prefers-color-scheme` answers inside it, as Chrome has it.
   */
  drawImage(
    ctx: ClipContext,
    x: number,
    y: number,
    w: number,
    h: number,
    scale: number,
    scheme: 'light' | 'dark' = 'light',
    surface: SurfaceMaker | null = null,
  ): void {
    if (this._failed || !(w > 0 && h > 0)) return;
    const own = this._ownPaint(w, h, scale, scheme);
    this.draw(
      ctx,
      x,
      y,
      w,
      h,
      scale,
      own?.color,
      own?.fill ?? null,
      own?.stroke ?? null,
      own?.shapes ?? null,
      surface,
    );
  }

  /** What an image's own style sheets give it, drawn `w` by `h` device
   *  pixels, or null where it has none. */
  private _ownPaint(
    w: number,
    h: number,
    scale: number,
    scheme: 'light' | 'dark',
  ): ImagePaint | null {
    const sheets = (this._sheets ??= ownSheets(this._root));
    // with no sheets of its own, a `var()` in its attributes can only be
    // one a `style` in it sets, or has a fallback, and is still read here
    if (!sheets.length) {
      const root = this._root;
      this._vars ??= drawingVars(root, (id) =>
        elementById(documentOf(root), id),
      );
      if (!this._vars) return null;
    }
    const made = `${scheme}|${scale}`;
    let entry = this._cascades.get(made);
    if (!entry) {
      const cascade = new Cascade(
        sheets,
        imageLook(scheme, scale),
        w,
        h,
        scale,
        null,
        null,
        null,
        null,
        this._root,
        this._target,
      );
      entry = { cascade, own: new Map() };
      this._cascades.set(made, entry);
    }
    const { cascade, own } = entry;
    // An image's viewport is the rectangle it is drawn in, which is what a
    // `@media (min-width)` in it, or a `vw`, is of: the answer is kept by
    // that size only where a sheet asks.
    const sized =
      cascade.breakpoints.length > 0 ||
      cascade.readsViewportWidth ||
      cascade.readsViewportHeight;
    const key = sized ? `${w}x${h}` : '';
    const kept = own.get(key);
    if (kept !== undefined) return kept;
    cascade.viewportWidth = w;
    cascade.viewportHeight = h;
    let paint: ImagePaint | null = null;
    try {
      const root = this._root;
      const style = cascade.styleFor(root, cascade.initial, false);
      const ink = (value: string | null): string | null =>
        value === null || value === 'currentColor' || value === 'none'
          ? value
          : inkColor(value, style.color);
      paint = {
        color: style.color,
        fill: ink(style.fill),
        stroke: ink(style.stroke),
        shapes: cascade.shapeStyles(root, style),
      };
    } catch {
      // a sheet this cannot read leaves the image as its attributes draw it
    }
    // a background drawn at many sizes keeps a few of them
    if (own.size >= 8) own.clear();
    own.set(key, paint);
    return paint;
  }

  private _viewFor(
    width: number,
    height: number,
    /** The root's `fill` and `stroke` as declarations, or none. */
    paint = '',
    shapes: ShapeStyles | null = null,
    /** What else the root inherits, as declarations (`draw`). */
    inherited = '',
    lengths: Lengths = DEFAULT_LENGTHS,
  ): SvgViewLike | null {
    const root = this._root;
    const count = root.children.length;
    // more of the document has arrived since a `<use>` found nothing, or
    // more of what the tree was read from: the drawing, a group in it, or
    // a symbol outside it that a chunk ended halfway through
    const arrived =
      (this._missingAt !== undefined &&
        lastNode(documentOf(root)) !== this._missingAt) ||
      this._seenEnds.some(moved);
    const grown = count !== this._seen || arrived;
    if (grown || this._lengths === null) {
      this._lengths = lengthsToWorkOut(root);
      this._uses = needsExpanding(root);
      this._outside = refersOutside(root);
    }
    const sized = this._lengths || this._uses;
    // and, for a drawing with lengths to work out, what they are of
    const viewport = !sized
      ? ''
      : this._lengths
        ? `${width}x${height}|${lengths.em}|${lengths.rem}|${lengths.vw}x${lengths.vh}`
        : `${width}x${height}`;
    const painted = `${paint}|${inherited}|${shapes?.key ?? ''}`;
    if (
      this._view &&
      !grown &&
      viewport === this._seenViewport &&
      painted === this._seenPaint
    ) {
      return this._view;
    }
    const View = svgViewClass();
    if (!View) {
      this._failed = true;
      return null;
    }
    try {
      const view = this._view ?? new View(null);
      const reached: Reached = { missing: false, outside: new Set() };
      const tree =
        sized || shapes || this._outside || root.name.includes(':')
          ? copyTree(
              root,
              sized ? [width, height] : null,
              reached,
              shapes,
              lengths,
            )
          : root;
      view.setSvgDom(
        paint || inherited ? withPaint(tree, paint, inherited) : tree,
      );
      this._missingAt = reached.missing
        ? lastNode(documentOf(root))
        : undefined;
      const ends = [endOf(root)];
      for (const el of reached.outside) ends.push(endOf(el));
      this._view = view;
      this._seen = count;
      this._seenEnds = ends;
      this._seenViewport = viewport;
      this._seenPaint = painted;
      return view;
    } catch {
      this._failed = true;
      return null;
    }
  }
}

/** What `keptAs` keeps a drawing's raster by, of what it says itself. */
interface DrawnFrom {
  /** The number of its text (`sourceNumber`), the same for two drawings
   *  that say the same; 0 where no raster can stand for it. */
  source: number;
  /** Whether a `rem` or a `vw` may be in what it is drawn from. */
  units: boolean;
  /** Where each part of it ended: more of a stream, and it is read again. */
  ends: End[];
}

/** Every text drawings were drawn from, by a number for it, the same while
 *  the text is here: what a key is built from at each paint of each
 *  drawing, where the text itself would be hashed again each time. */
const SOURCES = new Map<string, number>();
let sourceChars = 0;
let sources = 0;

/** How much text `SOURCES` holds before it is forgotten wholesale: a
 *  drawing read after that has a new number, and its raster is made again. */
const SOURCES_KEPT = 8 * 1024 * 1024;

function sourceNumber(text: string): number {
  let n = SOURCES.get(text);
  if (n === undefined) {
    sourceChars += text.length;
    if (sourceChars > SOURCES_KEPT) {
      SOURCES.clear();
      sourceChars = text.length;
    }
    n = ++sources;
    SOURCES.set(text, n);
  }
  return n;
}

/**
 * What a drawing says, for a raster of it (`keptAs`): its elements, their
 * attributes and how they nest, and those of each element outside it that
 * it names — by a `<use>`, an icon sprite's, or by a `url(#…)` (`copyTree`)
 * — and of what those name. Two drawings that come to one text draw the
 * same. No raster stands for a drawing that sets text, which a face arriving
 * would set anew, or has a `<foreignObject>`, whose HTML no text here holds,
 * or names what the document does not have: a stream may bring it, and it
 * is read again when the document moves on.
 */
function drawnFrom(root: Element): DrawnFrom {
  const ends = [endOf(root)];
  const pending = [root];
  const seen = new Set(pending);
  let ids: Map<string, Element> | null = null;
  let text = '';
  let refused = false;
  const name = (id: string): void => {
    ids ??= idsUnder(root);
    if (ids.has(id) || root.attribs.id === id) return;
    const top = documentOf(root);
    const target = elementById(top, id);
    if (!target) {
      refused = true;
      ends.push(endOf(top));
    } else if (!seen.has(target)) {
      seen.add(target);
      pending.push(target);
      ends.push(endOf(target));
    }
  };
  const read = (el: Element): void => {
    const local = localName(el.name);
    if (local === 'text' || local === 'foreignobject') {
      refused = true;
      return;
    }
    text += `<${el.name}`;
    for (const attr in el.attribs) text += `\0${attr}\0${el.attribs[attr]}`;
    urlIds(el.name, el.attribs, name);
    const used = isUse(el) ? useHref(el) : null;
    if (used !== null) name(used);
    for (const child of el.children) {
      if (child.type === 'tag') read(child as Element);
    }
    // where it ends: what is in a group is painted as the group says
    text += '>';
  };
  for (let at = 0; at < pending.length && !refused; at += 1) {
    read(pending[at]);
  }
  if (refused) return { source: 0, units: false, ends };
  return {
    source: sourceNumber(text),
    units: pending.length > 1 || lengthsToWorkOut(root),
    ends,
  };
}

/**
 * A drawing's root with its `fill` and `stroke` the document's: a copy of
 * the root, its children the same ones, with the declarations at the end of
 * its `style` — where `SvgView` reads a root's paint, over its presentation
 * attributes, for what is under it to inherit.
 */
function withPaint(root: Element, paint: string, inherited = ''): Element {
  const style = root.attribs.style;
  const attribs: Record<string, string> = { ...root.attribs };
  if (paint) attribs.style = style ? `${style};${paint}` : paint;
  // what it inherits is under what it says itself: an attribute of its
  // own, and its style and the rules that reach it, which beat attributes
  for (const declaration of inherited.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon);
    if (attribs[name] === undefined)
      attribs[name] = declaration.slice(colon + 1);
  }
  return new Element(root.name, attribs, root.children);
}

/**
 * The colour an SVG image's root element sets as its background, in its
 * `style` attribute — the one place an image can say it, since
 * `background-color` is no presentation attribute — or null for none.
 */
function canvasBackground(root: Element): string | null {
  const style = root.attribs.style;
  if (!style) return null;
  let found: string | null = null;
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    if (name !== 'background-color' && name !== 'background') continue;
    // a `background` shorthand that is a colour alone, as an image's is
    const color = parseColor(declaration.slice(colon + 1));
    found = color && !isTransparent(color) ? color : null;
  }
  return found;
}

/** What an SVG image's own style sheets give it (`SvgDrawing.drawImage`):
 *  its root's `color`, `fill` and `stroke`, and what they give the
 *  elements in it. */
interface ImagePaint {
  color: string;
  fill: string | null;
  stroke: string | null;
  shapes: ShapeStyles | null;
}

/**
 * The style sheets an SVG image's `<style>` elements hold, in order. One
 * that names a type other than CSS's holds none (SVG 2, 6.3), and one with
 * a `media` query holds its rules under it. Its text is its text and CDATA
 * sections, as an XML parse leaves them, and not its comments.
 */
function ownSheets(root: Element): Stylesheet[] {
  const sheets: Stylesheet[] = [];
  const layers = new Map<string, number>();
  let order = 0;
  const stack: Element[] = [root];
  for (let el = stack.pop(); el; el = stack.pop()) {
    for (let i = el.children.length - 1; i >= 0; i -= 1) {
      const child = el.children[i];
      // an XML parse gives a `<style>` a type of its own, as HTML's does
      if (child.type === 'tag' || child.type === 'style') {
        stack.push(child as Element);
      }
    }
    if (el === root || localName(el.name) !== 'style') continue;
    const type = (el.attribs.type ?? '').trim().toLowerCase();
    if (type && type !== 'text/css') continue;
    const media = el.attribs.media?.trim();
    const sheet = parseStylesheet(
      rawTextOf(el),
      order,
      layers,
      null,
      media ? [parseMediaQuery(media)] : null,
    );
    order += sheet.rules.length + 1;
    sheets.push(sheet);
  }
  return sheets;
}

/**
 * The look an SVG image's own document starts from: CSS's initial values,
 * black at `medium`, since nothing of the page's is inherited into an
 * image — only the colour scheme, which its `prefers-color-scheme` answers.
 * Its `prefers-reduced-motion` is answered `no-preference` whatever the
 * desktop says (the cascade's default): nothing in an image moves here.
 */
function imageLook(scheme: 'light' | 'dark', scale: number): RootLook {
  return {
    color: '#000000',
    fontFamily: 'sans-serif',
    fontSize: 16 * scale,
    monoFamily: 'monospace',
    linkColor: '#0000ee',
    borderColor: '#000000',
    mutedColor: '#808080',
    background: 'transparent',
    colorScheme: scheme,
    surface: '#ffffff',
    controlPadY: 0,
    controlBorder: 0,
    controlRadius: 0,
  };
}

/** Drawings of inline `<svg>` elements, per element: the element is the
 *  document's, and outlives the box trees built over it. */
let INLINE = new WeakMap<Element, SvgDrawing>();
let inlineAt = -1;

/**
 * The drawing of an inline `<svg>`. Kept until an application says it
 * changed the DOM (`mutationGeneration`), and made again then, at its
 * next paint. A drawing hands `SvgView` its tree again only where a
 * stream's chunk added to it (`_viewFor`), and `SvgView` reads what it is
 * handed as it is handed it — the root's `viewBox` and size, the ids a
 * `url(#…)` names, the paints it scans — where a shape's own attributes it
 * reads at each draw: a `viewBox` an application changed, and a
 * `refresh()`, was fitted to the box as the new one and drawn through as
 * the old, and a gradient given an id was no paint server, for good. A
 * `refresh()` is a restyle, a build and a layout of the whole document
 * already, and making each drawing again is the same order of work.
 */
export function inlineDrawing(el: Element): SvgDrawing {
  const at = mutationGeneration();
  if (at !== inlineAt) {
    INLINE = new WeakMap();
    inlineAt = at;
  }
  let drawing = INLINE.get(el);
  if (!drawing) {
    drawing = new SvgDrawing(el, svgIntrinsics(el));
    INLINE.set(el, drawing);
  }
  return drawing;
}

/** The geometry a percentage of the viewport can give, and of which of its
 *  dimensions: its width, its height, or its normalized diagonal (SVG 2,
 *  8.9, "Units"). */
const PERCENT_OF: Record<string, 'x' | 'y' | 'd'> = {
  x: 'x',
  width: 'x',
  cx: 'x',
  rx: 'x',
  x1: 'x',
  x2: 'x',
  y: 'y',
  height: 'y',
  cy: 'y',
  ry: 'y',
  y1: 'y',
  y2: 'y',
  r: 'd',
  'stroke-width': 'd',
};

/** A math function, which a geometry property takes as its value (SVG 2,
 *  "Geometry Properties": a `<length-percentage>`) and `SvgView` reads as
 *  no number at all: `width="calc(100% - 1px)"` drew nothing. */
const MATH_FUNCTION = /^(?:calc|min|max|clamp)\(/i;

/** What one of an absolute length's units is in user units, a CSS pixel
 *  each (CSS Values 4, 6.2). */
const USER_UNITS: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

/**
 * A geometry attribute's value in user units where it is a percentage of
 * the viewport (`of`) or a math function of one: `calc(100% - 1px)`, the
 * percentage of `of` and the lengths in its absolute units. Null where it
 * is neither, or is one this cannot read — a relative unit, a sum that does
 * not add up — which is left as written.
 */
function viewportLength(value: string, of: number): number | null {
  if (MATH_FUNCTION.test(value)) {
    const len = parseMath(value, (token) => {
      const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([a-z]+)$/i.exec(
        token,
      );
      const unit = m ? USER_UNITS[m[2].toLowerCase()] : undefined;
      return m && unit !== undefined ? Number(m[1]) * unit : null;
    });
    return len === null || len === 'auto' ? null : resolve(len, of);
  }
  if (!value.endsWith('%')) return null;
  const pct = parseFloat(value);
  return Number.isFinite(pct) ? (pct / 100) * of : null;
}

/** What the lengths in a drawing are worked out against, in its user
 *  units: the font size its root inherits, which an `em` at the root is
 *  of, the root element's, and the viewport's sides (`DrawingUnits`). */
interface Lengths {
  em: number;
  rem: number;
  vw: number;
  vh: number;
}

const DEFAULT_LENGTHS: Lengths = { em: 16, rem: 16, vw: 0, vh: 0 };

/** A length with a unit `SvgView` reads as the number before it — every
 *  unit but `px`: it takes `x2="2.5em"` for 2.5 user units, `1in` for
 *  one, and a `rem` as 16 pixels whatever the root's font size is. */
const UNIT_LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?!px$)[a-z]+$/i;

/** A `font-size` `SvgView` reads otherwise than CSS: of the root's font
 *  size, of the viewport, of a font's "0", or a math function. */
const FOREIGN_SIZE = /(?:\d(?:rem|v(?:w|h|min|max)|[sld]v[wh]|ch|r?lh)\b|\()/i;

/**
 * A geometry attribute's value in user units, where `SvgView` would read it
 * otherwise (`viewportLength`, `UNIT_LENGTH`): a percentage of `of`, the
 * viewport's side or its normalized diagonal; a length in a unit, absolute
 * or of the element's font (`em`), the root element's (`rem`) or the
 * viewport (`vw`); or a math function of those. Null where it is a number,
 * which `SvgView` reads as it is, or none this can read — a list, `auto`, a
 * sum that does not add up — which is left as written.
 */
function geometryLength(
  value: string,
  of: number,
  em: number,
  lengths: Lengths,
): number | null {
  if (!value.endsWith('%') && !MATH_FUNCTION.test(value)) {
    if (!UNIT_LENGTH.test(value)) return null;
  }
  const len = parseLength(value, unitsOf(em, lengths));
  if (len === null || len === AUTO) return null;
  return resolve(len, of);
}

/** A unit context in user units, a CSS pixel each, for an element whose
 *  font size is `em`. */
function unitsOf(em: number, lengths: Lengths): UnitContext {
  return { em, rem: lengths.rem, vw: lengths.vw, vh: lengths.vh, scale: 1 };
}

/** The `font-size` keywords in CSS pixels, as `SvgView` has them. */
const FONT_SIZES: Record<string, number> = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
};

/**
 * An element's font size in user units, given the one it inherits, as
 * `SvgView` reads it — its `font-size` attribute, and the last such
 * declaration in its `style` over that — except that a `rem`, a `vw` and a
 * math function are worked out as CSS has them, where `SvgView` reads them
 * otherwise; `rewrite` is told the size where it does.
 */
function fontSizeOf(
  attribs: Record<string, string>,
  inherited: number,
  lengths: Lengths,
  rewrite: (size: number) => void,
): number {
  let raw = attribs['font-size'];
  const style = attribs.style;
  if (style && style.includes('font-size')) {
    for (const declaration of style.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      if (declaration.slice(0, colon).trim().toLowerCase() !== 'font-size') {
        continue;
      }
      raw = declaration.slice(colon + 1);
    }
  }
  if (raw === undefined) return inherited;
  const v = raw
    .trim()
    .replace(/\s*!important$/i, '')
    .toLowerCase();
  if (v === '' || v === 'inherit') return inherited;
  if (v in FONT_SIZES) return FONT_SIZES[v];
  if (v === 'larger') return inherited * 1.2;
  if (v === 'smaller') return inherited / 1.2;
  const len = parseLength(v, unitsOf(inherited, lengths), true);
  if (len === null || len === AUTO) return inherited;
  const size = resolve(len, inherited);
  if (!(size >= 0)) return inherited;
  if (FOREIGN_SIZE.test(v)) rewrite(size);
  return size;
}

/** What a percentage in it means is not the viewport's: a gradient's are
 *  of the box it paints, and `SvgView` reads those itself. */
const OWN_UNITS = new Set(['lineargradient', 'radialgradient', 'pattern']);

function localName(name: string): string {
  const i = name.indexOf(':');
  return (i < 0 ? name : name.slice(i + 1)).toLowerCase();
}

/** Whether a length under the root is one `SvgView` would read otherwise
 *  than CSS: a percentage, which it resolves against no viewport, so
 *  `width="100%"` was a hundred user units; a math function, which it
 *  reads as none; a length in a unit, which it reads as the number before
 *  it (`UNIT_LENGTH`); and a font size it reads otherwise
 *  (`FOREIGN_SIZE`). */
function lengthsToWorkOut(root: Element): boolean {
  const walk = (el: Element): boolean => {
    for (const child of el.children) {
      if (child.type !== 'tag') continue;
      const tag = child as Element;
      const local = localName(tag.name);
      if (OWN_UNITS.has(local)) continue;
      for (const name in tag.attribs) {
        const value = tag.attribs[name].trim();
        if (name === 'font-size' || name === 'style') {
          const sized = name === 'font-size' || value.includes('font-size');
          if (sized && FOREIGN_SIZE.test(value)) return true;
          continue;
        }
        if (!PERCENT_OF[name]) continue;
        if (
          value.endsWith('%') ||
          MATH_FUNCTION.test(value) ||
          UNIT_LENGTH.test(value)
        ) {
          return true;
        }
      }
      // what a `<foreignObject>` holds is HTML, and not the drawing's
      if (local !== 'foreignobject' && walk(tag)) return true;
    }
    return false;
  };
  return walk(root);
}

/** Whether an element under a root is a `<text>`. */
function holdsText(root: Element): boolean {
  const stack: Element[] = [root];
  for (let el = stack.pop(); el; el = stack.pop()) {
    for (const child of el.children) {
      if (child.type !== 'tag') continue;
      if (localName((child as Element).name) === 'text') return true;
      stack.push(child as Element);
    }
  }
  return false;
}

/** The elements under a root by their ids, the first of each. */
function idsUnder(root: Element): Map<string, Element> {
  const ids = new Map<string, Element>();
  const walk = (el: Element): void => {
    for (const child of el.children) {
      if (child.type !== 'tag') continue;
      const tag = child as Element;
      const id = tag.attribs.id;
      if (id && !ids.has(id)) ids.set(id, tag);
      walk(tag);
    }
  };
  walk(root);
  return ids;
}

/**
 * Whether a `<use>` under the root is one `SvgView` cannot draw as it
 * stands: it looks a reference up among the root's own elements, and draws
 * a `<symbol>` as its children where they are, with the `<use>`'s paint.
 * So one to an element outside the root — an icon sprite's, a hidden
 * `<svg>` of symbols at the top of the page — and one to a symbol with a
 * `viewBox` or a paint of its own are drawn from a copy (`copyTree`).
 */
function needsExpanding(root: Element): boolean {
  let ids: Map<string, Element> | null = null;
  const walk = (el: Element): boolean => {
    for (const child of el.children) {
      if (child.type !== 'tag') continue;
      const tag = child as Element;
      if (localName(tag.name) === 'use') {
        const id = useHref(tag);
        if (id !== null) {
          ids ??= idsUnder(root);
          const target = ids.get(id);
          if (!target) return true;
          if (
            localName(target.name) === 'symbol' &&
            (viewBoxOf(target) || symbolOwn(target))
          ) {
            return true;
          }
        }
      }
      if (walk(tag)) return true;
    }
    return false;
  };
  return walk(root);
}

/**
 * Whether an element under a root names one outside it by a `url(#…)`
 * (`urlIds`): `SvgView` looks a reference up among the root's own
 * elements, so the drawing is drawn from a copy that has it (`copyTree`).
 */
function refersOutside(root: Element): boolean {
  let ids: Map<string, Element> | null = null;
  let outside = false;
  const name = (id: string): void => {
    if (outside) return;
    ids ??= idsUnder(root);
    if (!ids.has(id) && root.attribs.id !== id) outside = true;
  };
  const stack: Element[] = [root];
  for (let el = stack.pop(); el && !outside; el = stack.pop()) {
    urlIds(el.name, el.attribs, name);
    // what a `<foreignObject>` holds is HTML, and not the drawing's
    if (localName(el.name) === 'foreignobject') continue;
    for (const child of el.children) {
      if (child.type === 'tag') stack.push(child as Element);
    }
  }
  return outside;
}

function documentOf(el: Element): ParentNode {
  let top: ParentNode = el;
  while (top.parent) top = top.parent;
  return top;
}

/** The last node of a document, in its order: what a document that is
 *  still arriving has another of once more of it has. */
function lastNode(top: ParentNode): ChildNode | null {
  let last: ChildNode | null = top.lastChild;
  while (last && 'lastChild' in last && last.lastChild) last = last.lastChild;
  return last;
}

/** Where a part of a document ends: its last node, and the length of that
 *  node's text where it is text, since a chunk's text goes on the end of
 *  the text before it (domhandler's `ontext`) and leaves the node as it
 *  was. What a document that is still arriving appends to the part moves
 *  it, and what it appends after the part does not. */
interface End {
  top: ParentNode;
  last: ChildNode | null;
  text: number;
}

function endOf(top: ParentNode): End {
  const last = lastNode(top);
  return { top, last, text: last?.type === 'text' ? last.data.length : -1 };
}

/** Whether more of a part has arrived since its `End` was taken. */
function moved(end: End): boolean {
  const last = lastNode(end.top);
  if (last !== end.last) return true;
  return last?.type === 'text' && last.data.length !== end.text;
}

/** The first element of a document with an id, in its order. */
function elementById(top: ParentNode, id: string): Element | null {
  const stack: ChildNode[] = [...top.children].reverse();
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type !== 'tag') continue;
    const el = node as Element;
    if (el.attribs.id === id) return el;
    for (let i = el.children.length - 1; i >= 0; i -= 1) {
      stack.push(el.children[i]);
    }
  }
  return null;
}

/** How deep a `<use>` may be of a `<use>`: one that reaches itself stops. */
const USE_DEPTH = 8;

/** A `<use>`'s `width` or `height`, in user units: a number, or a
 *  percentage of the viewport's; null for none, and for `auto`. */
function useLength(value: string | undefined, of: number): number | null {
  if (value === undefined) return null;
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return value.trim().endsWith('%') ? (n / 100) * of : n;
}

/** The transform that fits a `viewBox` into a viewport at `x`, `y`, as
 *  `preserveAspectRatio` says (SVG 2, 8.2). */
function fitTransform(
  box: [number, number, number, number],
  x: number,
  y: number,
  width: number,
  height: number,
  preserve: string | undefined,
): string {
  const fit = (preserve ?? '').trim().split(/\s+/);
  if (fit[0] === 'defer') fit.shift();
  let sx = width / box[2];
  let sy = height / box[3];
  if (fit[0] !== 'none') {
    const align = ALIGN.exec(fit[0] ?? '') ?? ['xMidYMid', 'Mid', 'Mid'];
    const scale = fit[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    x += (width - box[2] * scale) * AT[align[1]];
    y += (height - box[3] * scale) * AT[align[2]];
    sx = scale;
    sy = scale;
  }
  return `translate(${x - box[0] * sx},${y - box[1] * sy}) scale(${sx},${sy})`;
}

/** What a `<use>` says of where its element goes, and not of how it looks:
 *  the rest is the group's the element is drawn in. */
const USE_PLACEMENT = new Set([
  'href',
  'xlink:href',
  'x',
  'y',
  'width',
  'height',
]);

/** A `<symbol>`'s attributes that paint what is in it: its presentation
 *  attributes and its `style` (SVG 2, 6.3). Not where it goes, the viewport
 *  it makes or a name, which a symbol's copy is no group to have. */
const SYMBOL_PAINTS = new Set([
  'style',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'color',
  'opacity',
  'visibility',
  'display',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
]);

/** A `<symbol>`'s own attributes that paint what is in it, or null where
 *  it has none: Chrome draws a sprite's `<symbol fill="…">` in that fill,
 *  where `SvgView` draws a symbol's children alone. */
function symbolOwn(symbol: Element): Record<string, string> | null {
  let kept: Record<string, string> | null = null;
  for (const name in symbol.attribs) {
    if (SYMBOL_PAINTS.has(name)) (kept ??= {})[name] = symbol.attribs[name];
  }
  return kept;
}

/** What a copy of a drawing reached outside its root: whether a `<use>`
 *  in it found nothing, and the elements one was drawn from. */
interface Reached {
  missing: boolean;
  outside: Set<Element>;
}

/**
 * The tree `SvgView` reads, where the document's own will not do: with
 * local names — `SvgView` knows `rect`, not `svg:rect`, and a prefix is
 * dropped only where it is bound to SVG — and with its percentages resolved
 * against a viewport of `[width, height]` user units, where one is given;
 * and with each `<use>` that `SvgView` cannot draw (`needsExpanding`) as a
 * group of what it refers to (SVG 2, 5.5): the element, from wherever in
 * the document it is, or a symbol's children, its `viewBox` fitted to the
 * viewport the `<use>` gives it — its `width` and `height`, and all of the
 * drawing's where it has none. `reached` is told where one refers to an
 * element the document does not have, and of each element outside the root
 * that one was drawn from.
 *
 * And with what the document's rules give each element (`shapes`), where
 * `SvgView` reads an element's own: at the end of its `style`, over its
 * presentation attributes and over what that attribute says, which the
 * cascade that made them has weighed already. An element a rule gives
 * `display: none` is left out, with what is in it, and a shape one hides
 * — `visibility` is inherited, and a shape in a hidden group may be shown
 * again — is left out alone. What a `<use>` draws has what the rules give
 * its copy (`ShapeStyles.used`), which may not be what they give the
 * element where it stands, so where they give anything, every `<use>` is
 * drawn from a copy here.
 */
function copyTree(
  root: Element,
  viewport: [number, number] | null,
  reached?: Reached,
  shapes: ShapeStyles | null = null,
  lengths: Lengths = DEFAULT_LENGTHS,
): Element {
  const colon = root.name.indexOf(':');
  const prefix = colon < 0 ? null : `${root.name.slice(0, colon)}:`;
  const strip = (name: string): string =>
    prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  const diagonal = viewport
    ? Math.sqrt((viewport[0] ** 2 + viewport[1] ** 2) / 2)
    : 0;
  let ids: Map<string, Element> | null = null;
  const expand = (
    use: Element,
    resolve: boolean,
    depth: number,
    hidden: boolean,
    /** What the rules give the `<use>`. */
    own: ShapeStyle | undefined,
    /** The `<use>`'s font size, which the copy inherits. */
    size: number,
  ): Element | null => {
    const id = useHref(use);
    if (id === null || depth >= USE_DEPTH) return null;
    ids ??= idsUnder(root);
    const inside = ids.get(id);
    const target = inside ?? elementById(documentOf(root), id);
    if (!target) {
      if (reached) reached.missing = true;
      return null;
    }
    if (!inside) reached?.outside.add(target);
    const symbol = localName(target.name) === 'symbol';
    const box = symbol ? viewBoxOf(target) : null;
    const kept = symbol ? symbolOwn(target) : null;
    // one of the root's own that `SvgView` draws as it is: with no
    // viewport to fit, no paint of a symbol's own, and no rule's styles
    if (inside && !box && !kept && !shapes) return null;
    // what the rules give the copy, element by element
    const styles = shapes?.used?.get(use) ?? null;
    const attribs: Record<string, string> = {};
    for (const name in use.attribs) {
      if (!USE_PLACEMENT.has(name)) attribs[name] = use.attribs[name];
    }
    if (own) restyle(attribs, own);
    const x = parseFloat(use.attribs.x ?? '') || 0;
    const y = parseFloat(use.attribs.y ?? '') || 0;
    let placed = '';
    if (box && viewport) {
      const width =
        useLength(use.attribs.width, viewport[0]) ??
        useLength(target.attribs.width, viewport[0]) ??
        viewport[0];
      const height =
        useLength(use.attribs.height, viewport[1]) ??
        useLength(target.attribs.height, viewport[1]) ??
        viewport[1];
      placed = fitTransform(
        box,
        x,
        y,
        width,
        height,
        svgAttr(target, 'preserveAspectRatio'),
      );
    } else if (x || y) placed = `translate(${x},${y})`;
    const transform = `${attribs.transform ?? ''} ${placed}`.trim();
    if (transform) attribs.transform = transform;
    // a length in a symbol with a `viewBox` is of that, and left as it is
    const within = resolve && !box;
    const children: ChildNode[] = [];
    if (symbol) {
      // The symbol is the top of the copy, and paints what is in it: its
      // attributes, and what the rules give it there. `SvgView` draws a
      // symbol's children alone, so they go in a group that is it. Where
      // it stands a symbol is drawn by nobody, so `display: none` takes
      // nothing from it there (`UNDRAWN`); at the top of a copy it takes
      // the copy, as Chrome has it.
      const mine = styles?.get(target);
      const inner = hiddenIn(mine, hidden);
      if (mine?.display !== 'none') {
        copyInto(children, target, within, depth + 1, inner, styles, size);
      }
      if (kept || mine) {
        const paints = { ...kept };
        if (mine) restyle(paints, mine);
        const group = new Element('g', paints, children.splice(0));
        children.push(group);
      }
    } else if (shown(target, hidden, styles)) {
      children.push(copy(target, within, depth + 1, hidden, styles, size));
    }
    return new Element('g', attribs, children);
  };
  /** What the drawing names outside the root, copied, by its id: an
   *  element a `<use>` in a `<clipPath>` names, and one a `url(#…)` names
   *  (`urlIds`) — a marker, a gradient, a clip path. `SvgView` looks a
   *  reference up in the tree it is given, so they go in it, in a `<defs>`
   *  at its end. One a `url(#…)` names is styled as the rules have it
   *  where it stands (`ShapeStyles.of`); a `<use>`'s, as it is written. */
  const brought = new Map<string, Element | null>();
  const bring = (
    id: string | null,
    resolve: boolean,
    depth: number,
    size: number,
    styles: ReadonlyMap<Element, ShapeStyle> | null,
  ): void => {
    if (id === null || brought.has(id) || depth >= USE_DEPTH) return;
    ids ??= idsUnder(root);
    if (ids.has(id) || root.attribs.id === id) return;
    brought.set(id, null);
    const target = elementById(documentOf(root), id);
    if (!target) {
      if (reached) reached.missing = true;
      return;
    }
    reached?.outside.add(target);
    // a marker's lengths are of the viewport it makes, not the root's
    const own = resolve && localName(target.name) !== 'marker';
    brought.set(id, copy(target, own, depth + 1, false, styles, size));
  };
  /** Whether an element is drawn at all, in a group that is hidden or
   *  not: one no rule gives `display: none`, and no shape a rule hides. */
  const shown = (
    el: Element,
    hidden: boolean,
    styles: ReadonlyMap<Element, ShapeStyle> | null,
  ): boolean => {
    if (!styles) return true;
    const own = styles.get(el);
    const name = localName(el.name);
    if (own?.display === 'none' && !UNDRAWN.has(name)) return false;
    return !(hiddenIn(own, hidden) && HIDEABLE.has(name));
  };
  const copyInto = (
    children: ChildNode[],
    el: Element,
    resolve: boolean,
    depth: number,
    hidden: boolean,
    styles: ReadonlyMap<Element, ShapeStyle> | null,
    /** The font size `el` has, which its children inherit. */
    size: number,
  ): void => {
    for (const child of el.children) {
      if (child.type === 'tag') {
        if (shown(child as Element, hidden, styles)) {
          children.push(
            copy(child as Element, resolve, depth, hidden, styles, size),
          );
        }
      } else if (child.type === 'text') children.push(new Text(child.data));
    }
  };
  const copy = (
    el: Element,
    resolve: boolean,
    depth = 0,
    /** Whether the element inherits a `visibility` of `hidden`. */
    hidden = false,
    /** What the rules give the elements of the tree it is in: the
     *  drawing's, or a `<use>`'s copy's. */
    styles: ReadonlyMap<Element, ShapeStyle> | null = shapes?.of ?? null,
    /** The font size the element inherits, in user units. */
    inherited: number = lengths.em,
  ): Element => {
    const own = styles?.get(el);
    hidden = hiddenIn(own, hidden);
    const attribs = { ...el.attribs };
    if (own) restyle(attribs, own);
    // its own font size, which an `em` in its lengths is of, written out
    // where `SvgView` would read it otherwise
    const size = fontSizeOf(attribs, inherited, lengths, (px) => {
      attribs.style = `${attribs.style ? `${attribs.style};` : ''}font-size:${px}`;
    });
    if (localName(el.name) === 'use') {
      // One in a `<clipPath>` clips as the shape or the text it names, and
      // a group clips as nothing (CSS Masking 1, 6.3): it stays a use.
      const parent = el.parent;
      if (parent?.type === 'tag' && localName(parent.name) === 'clippath') {
        bring(useHref(el), resolve, depth, size, null);
      } else {
        const group = expand(el, resolve, depth, hidden, own, size);
        if (group) return group;
      }
    }
    // what it names outside the root, which comes with it
    urlIds(el.name, attribs, (id) =>
      bring(id, resolve, depth, size, shapes?.of ?? null),
    );
    const here = resolve && !OWN_UNITS.has(localName(el.name));
    if (here && viewport && el !== root) {
      for (const name in attribs) {
        const axis = PERCENT_OF[name];
        if (!axis) continue;
        const of =
          axis === 'x' ? viewport[0] : axis === 'y' ? viewport[1] : diagonal;
        const length = geometryLength(attribs[name].trim(), of, size, lengths);
        if (length !== null) attribs[name] = String(length);
      }
    }
    const children: ChildNode[] = [];
    // what a `<foreignObject>` holds is HTML, which the document draws
    // into it (`ForeignPainter`) from the element: the copy holds none of
    // it, and is mapped to the element
    const object = localName(el.name) === 'foreignobject';
    if (!object) copyInto(children, el, here, depth, hidden, styles, size);
    const made = new Element(strip(el.name), attribs, children);
    if (object) FOREIGN_COPIES.set(made, el);
    return made;
  };
  const tree = copy(root, true);
  const defs: Element[] = [];
  for (const el of brought.values()) if (el) defs.push(el);
  if (defs.length) tree.children.push(new Element('defs', {}, defs));
  return tree;
}

/** What `display: none` takes nothing from: `SvgView` draws none of them
 *  where they stand, and what refers to one still finds it (SVG 2, 5.3). */
const UNDRAWN = new Set([
  'defs',
  'symbol',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
  'marker',
  'style',
]);

/** What `visibility: hidden` leaves undrawn: the elements with something
 *  of their own to draw, and a `<use>`, since what it draws inherits the
 *  property from it. */
const HIDEABLE = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'image',
  'use',
]);

/** Whether an element is hidden, given whether what it is in is. */
function hiddenIn(own: ShapeStyle | undefined, hidden: boolean): boolean {
  const visibility = own?.visibility;
  return visibility === undefined || visibility === 'inherit'
    ? hidden
    : visibility === 'hidden';
}

/**
 * An element's attributes with what the rules give it: each property at
 * the end of its `style`, where `SvgView` reads it over the attribute of
 * its name — but `opacity`, which it reads from the attribute alone. One
 * the rules put back to what the element inherits is taken out of both.
 */
function restyle(attribs: Record<string, string>, own: ShapeStyle): void {
  let style = attribs.style ?? '';
  let added = '';
  for (const prop in own) {
    const value = own[prop];
    if (prop === 'display' || prop === 'visibility') continue;
    if (value === 'inherit') {
      delete attribs[prop];
      if (style) {
        style = style
          .split(';')
          .filter((d) => d.slice(0, d.indexOf(':')).trim() !== prop)
          .join(';');
      }
    } else if (prop === 'opacity') attribs.opacity = value;
    else added += `${prop}:${value};`;
  }
  style = style && added ? `${style};${added}` : style || added;
  if (style) attribs.style = style;
  else delete attribs.style;
}

/**
 * An SVG image's bytes as a drawing, or null for bytes that are not SVG —
 * which is how a PNG or a JPEG goes on to the image decoder. Nothing names
 * the type, so it is sniffed: markup, with an `<svg>` root.
 */
export function svgFromBytes(
  bytes: Uint8Array,
  fragment = '',
): SvgDrawing | null {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (
    bytes[i] === 0x20 ||
    bytes[i] === 0x09 ||
    bytes[i] === 0x0a ||
    bytes[i] === 0x0d
  ) {
    i += 1;
  }
  if (bytes[i] !== 0x3c) return null;
  const text = textOf(bytes);
  if (!/<(?:[a-z0-9_-]+:)?svg[\s>/]/i.test(text)) return null;
  try {
    const doc = parseDocument(text, { xmlMode: true });
    const root = findRoot(doc.children);
    if (!root) return null;
    const target = fragment ? elementById(doc, fragment) : null;
    return new SvgDrawing(root, svgIntrinsics(root), true, target);
  } catch {
    return null;
  }
}

function findRoot(nodes: ChildNode[]): Element | null {
  for (const node of nodes) {
    if (node.type !== 'tag') continue;
    const el = node as Element;
    if (isSvgRoot(el)) return el;
    const inner = findRoot(el.children);
    if (inner) return inner;
  }
  return null;
}

type DecoderConstructor = new (label: string) => {
  decode(input: Uint8Array): string;
};

function textOf(bytes: Uint8Array): string {
  const Decoder = (globalThis as { TextDecoder?: DecoderConstructor })
    .TextDecoder;
  if (Decoder) return new Decoder('utf-8').decode(bytes);
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** A rectangle by its edges, in a drawing's user space. */
interface Edges {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** What a reach is worked out against: the viewport its percentages are
 *  of, the lengths its units are, and what the rules give its elements. */
interface ReachContext {
  viewport: [number, number];
  lengths: Lengths;
  styles: ReadonlyMap<Element, ShapeStyle> | null;
  find: (id: string) => Element | null;
  /** What is being walked now: a `<use>` naming what it is in finds it. */
  walking: Set<Element>;
}

/** What a shape inherits that its reach is of: how wide its stroke is,
 *  the markers on its vertices, and its font size. */
interface ReachInherited {
  stroke: number;
  markers: readonly Element[];
  size: number;
}

/** The properties that put a marker on a shape's vertices, each inherited
 *  (SVG 2, 11.6.1); `marker` is the shorthand of them. */
const MARKER_PROPERTIES = ['marker-start', 'marker-mid', 'marker-end'];

/** The elements that draw nothing where they stand. */
const DRAWS_NOTHING = new Set([
  'defs',
  'symbol',
  'marker',
  'pattern',
  'lineargradient',
  'radialgradient',
  'clippath',
  'mask',
  'filter',
  'style',
  'script',
  'title',
  'desc',
  'metadata',
]);

/** What `parseSvgPath` makes of a path's data: its commands, absolute,
 *  arcs as cubics. */
interface PathCommand {
  type: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

type ParseSvgPath = (d: string) => PathCommand[];

function parseSvgPath(): ParseSvgPath | null {
  const parse = (ntk as unknown as Record<string, unknown>).parseSvgPath;
  return typeof parse === 'function' ? (parse as ParseSvgPath) : null;
}

/** An SVG `transform` attribute as a matrix (SVG 2's own syntax: numbers
 *  with no units), or null for none, and the identity for one this cannot
 *  read, which `SvgView` draws as none. */
function svgTransform(value: string | undefined): Matrix | null {
  if (!value || !value.trim()) return null;
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  for (const [, fn, args] of value.matchAll(
    /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi,
  )) {
    const n = args
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (!n.every(Number.isFinite)) return [1, 0, 0, 1, 0, 0];
    const rad = ((n[0] ?? 0) * Math.PI) / 180;
    let t: Matrix;
    switch (fn.toLowerCase()) {
      case 'matrix':
        if (n.length < 6) return [1, 0, 0, 1, 0, 0];
        t = [n[0], n[1], n[2], n[3], n[4], n[5]];
        break;
      case 'translate':
        t = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
        break;
      case 'scale':
        t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        const cx = n[1] ?? 0;
        const cy = n[2] ?? 0;
        t = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
        break;
      }
      case 'skewx':
        t = [1, 0, Math.tan(rad), 1, 0, 0];
        break;
      default:
        t = [1, Math.tan(rad), 0, 1, 0, 0];
    }
    m = multiply(m, t);
  }
  return m;
}

/** One of an element's properties as it draws it: what the rules give it,
 *  else its `style`'s last declaration of it, else its attribute. */
function propertyOf(
  el: Element,
  name: string,
  styles: ReadonlyMap<Element, ShapeStyle> | null,
): string | undefined {
  const ruled = styles?.get(el)?.[name];
  if (ruled !== undefined) return ruled;
  const style = el.attribs.style;
  let found: string | undefined;
  if (style && style.includes(name)) {
    for (const declaration of style.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      if (declaration.slice(0, colon).trim().toLowerCase() === name) {
        found = declaration.slice(colon + 1).trim();
      }
    }
  }
  return found ?? svgAttr(el, name);
}

/** A length of a drawing's geometry in user units: a number, or what
 *  `geometryLength` works out; `fallback` for one it cannot read. */
function reachLength(
  value: string | undefined,
  of: number,
  size: number,
  ctx: ReachContext,
  fallback = 0,
): number {
  if (value === undefined) return fallback;
  const v = value.trim();
  const n = Number(v);
  if (v !== '' && Number.isFinite(n)) return n;
  const worked = geometryLength(v, of, size, ctx.lengths);
  if (worked !== null) return worked;
  const lead = parseFloat(v);
  return Number.isFinite(lead) ? lead : fallback;
}

function grow(into: Edges | null, by: Edges | null): Edges | null {
  if (!by) return into;
  if (!into) return { ...by };
  into.x1 = Math.min(into.x1, by.x1);
  into.y1 = Math.min(into.y1, by.y1);
  into.x2 = Math.max(into.x2, by.x2);
  into.y2 = Math.max(into.y2, by.y2);
  return into;
}

function padded(edges: Edges | null, by: number): Edges | null {
  if (!edges || !(by > 0)) return edges;
  return {
    x1: edges.x1 - by,
    y1: edges.y1 - by,
    x2: edges.x2 + by,
    y2: edges.y2 + by,
  };
}

function through(m: Matrix | null, edges: Edges | null): Edges | null {
  if (!edges || !m) return edges;
  const r = mapRect(
    m,
    edges.x1,
    edges.y1,
    edges.x2 - edges.x1,
    edges.y2 - edges.y1,
  );
  return { x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height };
}

/** The rectangle around a list of points. */
function around(points: number[]): Edges | null {
  let out: Edges | null = null;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out = grow(out, { x1: x, y1: y, x2: x, y2: y });
  }
  return out;
}

/** The markers an element may put on its vertices: those it inherits and
 *  those it names itself. One it names over one it inherits leaves both
 *  here, which is more than it draws, and as far as a reach needs. */
function markersOf(
  el: Element,
  up: readonly Element[],
  ctx: ReachContext,
): readonly Element[] {
  const shorthand = propertyOf(el, 'marker', ctx.styles);
  let out: Element[] | null = null;
  for (const name of MARKER_PROPERTIES) {
    const value = propertyOf(el, name, ctx.styles) ?? shorthand;
    const m = value && /url\(\s*['"]?#([^'")\s]+)/.exec(value);
    const marker = m ? ctx.find(m[1]) : null;
    if (!marker || localName(marker.name) !== 'marker') continue;
    (out ??= [...up]).push(marker);
  }
  return out ?? up;
}

/** How far past its vertices a shape's markers reach, at most: each
 *  marker's viewport, wherever its reference point is in it and however it
 *  is turned, a stroke width a unit unless it says otherwise. */
function markerReach(
  markers: readonly Element[],
  stroke: number,
  ctx: ReachContext,
): number {
  let reach = 0;
  for (const marker of markers) {
    const w = reachLength(svgAttr(marker, 'markerWidth'), 0, 16, ctx, 3);
    const h = reachLength(svgAttr(marker, 'markerHeight'), 0, 16, ctx, 3);
    const units =
      (svgAttr(marker, 'markerUnits') ?? '').trim() === 'userSpaceOnUse'
        ? 1
        : stroke;
    // twice the diagonal: the reference point may be at a corner
    reach = Math.max(reach, 2 * Math.hypot(w, h) * units);
  }
  return reach;
}

/**
 * The rectangle around what an element of a drawing paints, in its
 * parent's user space, or null where it paints nothing: its geometry, its
 * stroke past it, its markers, its text as far as its letters could reach,
 * what a `<use>` draws and what a `<filter>`'s region takes in. Generous
 * where it cannot be exact — a stroke reaches as far as its miters could,
 * a letter is as wide as it is tall — since what is outside it is not
 * painted where a repaint does not reach the box (`SvgDrawing.reach`).
 */
function reachOf(
  el: Element,
  ctx: ReachContext,
  up: ReachInherited,
  depth: number,
): Edges | null {
  const name = localName(el.name);
  if (DRAWS_NOTHING.has(name) || depth > 64) return null;
  if (propertyOf(el, 'display', ctx.styles)?.trim() === 'none') return null;
  const [vw, vh] = ctx.viewport;
  const diagonal = Math.sqrt((vw * vw + vh * vh) / 2);
  let size = up.size;
  const ownSize = propertyOf(el, 'font-size', ctx.styles);
  if (ownSize !== undefined) {
    size = fontSizeOf({ 'font-size': ownSize }, up.size, ctx.lengths, () => {});
  }
  const strokeWidth = propertyOf(el, 'stroke-width', ctx.styles);
  const stroke =
    strokeWidth === undefined || strokeWidth === 'inherit'
      ? up.stroke
      : Math.abs(reachLength(strokeWidth, diagonal, size, ctx, up.stroke));
  const markers = markersOf(el, up.markers, ctx);
  const inherited: ReachInherited = { stroke, markers, size };
  const len = (attr: string, of: number): number =>
    reachLength(svgAttr(el, attr), of, size, ctx);
  // a stroke past the geometry, as far as a miter at the default limit
  // takes it; and the markers on its vertices
  const shape = (edges: Edges | null): Edges | null => {
    const pad = 2 * stroke + markerReach(markers, stroke, ctx);
    return padded(edges, pad);
  };
  let edges: Edges | null = null;
  switch (name) {
    case 'rect':
    case 'image':
    case 'foreignobject': {
      const x = len('x', vw);
      const y = len('y', vh);
      edges = {
        x1: x,
        y1: y,
        x2: x + len('width', vw),
        y2: y + len('height', vh),
      };
      if (name === 'rect') edges = shape(edges);
      break;
    }
    case 'circle':
    case 'ellipse': {
      const cx = len('cx', vw);
      const cy = len('cy', vh);
      const rx = name === 'circle' ? len('r', diagonal) : len('rx', vw);
      const ry = name === 'circle' ? rx : len('ry', vh);
      edges = shape({ x1: cx - rx, y1: cy - ry, x2: cx + rx, y2: cy + ry });
      break;
    }
    case 'line':
      edges = shape(
        around([len('x1', vw), len('y1', vh), len('x2', vw), len('y2', vh)]),
      );
      break;
    case 'polyline':
    case 'polygon':
      edges = shape(
        around(
          (el.attribs.points ?? '')
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number),
        ),
      );
      break;
    case 'path': {
      const parse = parseSvgPath();
      const d = el.attribs.d;
      if (!parse || !d) break;
      const points: number[] = [];
      try {
        for (const c of parse(d)) {
          if (c.x !== undefined && c.y !== undefined) points.push(c.x, c.y);
          if (c.x1 !== undefined && c.y1 !== undefined) points.push(c.x1, c.y1);
          if (c.x2 !== undefined && c.y2 !== undefined) points.push(c.x2, c.y2);
        }
      } catch {
        break;
      }
      edges = shape(around(points));
      break;
    }
    case 'text': {
      // every position its text is set from, and as far either way of them
      // as its letters could reach, at an em each
      const points: number[] = [];
      let letters = 0;
      const read = (at: Element): void => {
        const xs = (svgAttr(at, 'x') ?? '').split(/[\s,]+/).filter(Boolean);
        const ys = (svgAttr(at, 'y') ?? '').split(/[\s,]+/).filter(Boolean);
        for (let i = 0; i < Math.max(xs.length, ys.length, 1); i += 1) {
          points.push(
            reachLength(xs[i] ?? xs[0], vw, size, ctx),
            reachLength(ys[i] ?? ys[0], vh, size, ctx),
          );
        }
        for (const child of at.children) {
          if (child.type === 'text') letters += child.data.length;
          else if (child.type === 'tag') {
            const inner = child as Element;
            if (localName(inner.name) === 'textpath') {
              const id = useHref(inner);
              const path = id === null ? null : ctx.find(id);
              if (path) {
                edges = grow(edges, reachOf(path, ctx, inherited, depth + 1));
              }
            }
            read(inner);
          }
        }
      };
      read(el);
      const reach = Math.max(1, letters) * size + 2 * stroke;
      const at = around(points);
      if (at) {
        edges = grow(edges, {
          x1: at.x1 - reach,
          y1: at.y1 - 2 * size - 2 * stroke,
          x2: at.x2 + reach,
          y2: at.y2 + 2 * size + 2 * stroke,
        });
      }
      edges = padded(edges, 2 * size);
      break;
    }
    case 'use': {
      const id = useHref(el);
      const target = id === null ? null : ctx.find(id);
      if (!target || ctx.walking.has(target)) break;
      const x = len('x', vw);
      const y = len('y', vh);
      ctx.walking.add(target);
      try {
        if (localName(target.name) !== 'symbol') {
          // moved by the use's `x` and `y`, as `copyTree` moves it
          edges = through(
            [1, 0, 0, 1, x, y],
            reachOf(target, ctx, inherited, depth + 1),
          );
          break;
        }
        // a symbol is a viewport, of the use's size or its own, its
        // `viewBox` fitted in; and what it draws past it, which its
        // `overflow` may show
        const w = reachLength(
          el.attribs.width ?? svgAttr(target, 'width'),
          vw,
          size,
          ctx,
          vw,
        );
        const h = reachLength(
          el.attribs.height ?? svgAttr(target, 'height'),
          vh,
          size,
          ctx,
          vh,
        );
        const box = viewBoxOf(target);
        const fit = box
          ? svgTransform(
              fitTransform(
                box,
                x,
                y,
                w,
                h,
                svgAttr(target, 'preserveAspectRatio'),
              ),
            )
          : ([1, 0, 0, 1, x, y] as const);
        const inner: ReachContext = box
          ? { ...ctx, viewport: [box[2], box[3]] }
          : ctx;
        edges = grow(
          { x1: x, y1: y, x2: x + w, y2: y + h },
          through(fit, childrenReach(target, inner, inherited, depth + 1)),
        );
      } finally {
        ctx.walking.delete(target);
      }
      break;
    }
    case 'svg': {
      // a viewport in it: cut to its rectangle unless it shows what
      // overflows it, as `SvgView` cuts it
      const x = len('x', vw);
      const y = len('y', vh);
      const w = reachLength(svgAttr(el, 'width'), vw, size, ctx, vw);
      const h = reachLength(svgAttr(el, 'height'), vh, size, ctx, vh);
      const overflow = propertyOf(el, 'overflow', ctx.styles)?.trim();
      if (overflow !== 'visible' && overflow !== 'auto') {
        edges = { x1: x, y1: y, x2: x + w, y2: y + h };
        break;
      }
      const box = viewBoxOf(el);
      const inner: ReachContext = {
        ...ctx,
        viewport: box ? [box[2], box[3]] : [w, h],
      };
      const fit = box
        ? svgTransform(
            fitTransform(box, x, y, w, h, svgAttr(el, 'preserveAspectRatio')),
          )
        : ([1, 0, 0, 1, x, y] as const);
      edges = grow(
        { x1: x, y1: y, x2: x + w, y2: y + h },
        through(fit, childrenReach(el, inner, inherited, depth + 1)),
      );
      break;
    }
    default:
      edges = childrenReach(el, ctx, inherited, depth + 1);
  }
  // a filter draws as far as its region (Filter Effects 1, 5.1): by
  // default a tenth of the bounding box either way, and anywhere a
  // `filterUnits` of the user space puts it
  const filter = propertyOf(el, 'filter', ctx.styles);
  if (edges && filter && filter.trim() !== 'none') {
    const m = /url\(\s*['"]?#([^'")\s]+)/.exec(filter);
    const region = m ? ctx.find(m[1]) : null;
    const w = edges.x2 - edges.x1;
    const h = edges.y2 - edges.y1;
    if (region && localName(region.name) === 'filter') {
      const user =
        (svgAttr(region, 'filterUnits') ?? '').trim() === 'userSpaceOnUse';
      const of = (
        attr: string,
        base: number,
        span: number,
        initial: number,
      ) => {
        const v = svgAttr(region, attr)?.trim();
        if (v === undefined || v === '') return base + span * initial;
        if (user)
          return reachLength(
            v,
            attr === 'x' || attr === 'width' ? vw : vh,
            size,
            ctx,
          );
        const f = v.endsWith('%') ? parseFloat(v) / 100 : Number(v);
        return base + span * (Number.isFinite(f) ? f : initial);
      };
      const x = user ? of('x', 0, vw, -0.1) : of('x', edges.x1, w, -0.1);
      const y = user ? of('y', 0, vh, -0.1) : of('y', edges.y1, h, -0.1);
      const fw = user ? of('width', 0, vw, 1.2) : of('width', 0, w, 1.2);
      const fh = user ? of('height', 0, vh, 1.2) : of('height', 0, h, 1.2);
      edges = grow(edges, { x1: x, y1: y, x2: x + fw, y2: y + fh });
    } else {
      // a CSS filter function, a blur or a shadow: as far again as the box
      edges = padded(edges, Math.max(w, h));
    }
  }
  return through(svgTransform(el.attribs.transform), edges);
}

function childrenReach(
  el: Element,
  ctx: ReachContext,
  up: ReachInherited,
  depth: number,
): Edges | null {
  let out: Edges | null = null;
  for (const child of el.children) {
    if (child.type !== 'tag') continue;
    out = grow(out, reachOf(child as Element, ctx, up, depth));
  }
  return out;
}

/** The rectangle around what a drawing paints, in its root's user space
 *  (`reachOf`), or null where it paints nothing. */
function drawingReach(
  root: Element,
  viewport: [number, number],
  lengths: Lengths,
  styles: ReadonlyMap<Element, ShapeStyle> | null,
): Edges | null {
  let ids: Map<string, Element> | null = null;
  const ctx: ReachContext = {
    viewport,
    lengths,
    styles,
    find: (id) =>
      (ids ??= idsUnder(root)).get(id) ?? elementById(documentOf(root), id),
    walking: new Set([root]),
  };
  const stroke = propertyOf(root, 'stroke-width', styles);
  const up: ReachInherited = {
    stroke: stroke === undefined ? 1 : Math.abs(parseFloat(stroke)) || 1,
    markers: [],
    size: lengths.em,
  };
  up.markers = markersOf(root, [], ctx);
  return childrenReach(root, ctx, up, 0);
}
