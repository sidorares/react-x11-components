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
import { isSvgRoot, rawTextOf } from './dom.js';
import { Cascade } from './css/cascade.js';
import { parseMediaQuery, parseStylesheet } from './css/parse.js';
import type { Stylesheet } from './css/parse.js';
import { useHref } from './css/shapes.js';
import type { ShapeStyle, ShapeStyles } from './css/shapes.js';
import type { RootLook } from './css/style.js';
import { inkColor, isTransparent, parseColor } from './css/values.js';

export { isSvgRoot };

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
    opts?: { color?: string },
  ): void;
}

type SvgViewConstructor = new (window: null) => SvgViewLike;

function svgViewClass(): SvgViewConstructor | null {
  const ctor = (ntk as unknown as Record<string, unknown>).SvgView;
  return typeof ctor === 'function' ? (ctor as SvgViewConstructor) : null;
}

/** The context slice an SVG needs besides what `SvgView` itself calls. */
interface ClipContext {
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
}

const LENT = new WeakMap<object, Lent>();

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
    ctx: new Proxy(ctx, {
      get(target, key) {
        if (key === 'save') return save;
        if (key === 'restore') return restore;
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
      set: (target, key, value) => Reflect.set(target, key, value),
    }),
  };
  LENT.set(ctx, lent);
  return lent;
}

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
   *  drawing with percentages in it, the viewport they were resolved
   *  against. */
  private _seen = -1;
  private _seenEnds: End[] = [];
  private _seenViewport = '';
  /** The `fill` and `stroke` the view's tree was last given its root's,
   *  and what the document's rules gave the elements in it. */
  private _seenPaint = '';
  /** Whether a length in the tree is a percentage of the viewport; null
   *  until the tree is first read. */
  private _percent: boolean | null = null;
  /** Whether a `<use>` in the tree is one `SvgView` cannot draw as it
   *  stands (`needsExpanding`). */
  private _uses = false;
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
  /** A cascade over them for each colour scheme and scale the image is
   *  drawn at, and what each gave it: by the viewport it was asked at where
   *  a sheet reads the viewport, and under one key where none does. */
  private _cascades = new Map<
    string,
    { cascade: Cascade; own: Map<string, ImagePaint | null> }
  >();

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
    const view = box
      ? this._viewFor(box[2], box[3], paint, shapes)
      : this._viewFor(vw, vh, paint, shapes);
    if (!view) return;
    ctx.save();
    // the view draws on the context lent, which counts its saves
    const lent = lend(ctx);
    const outer = lent.open;
    lent.open = 0;
    try {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const opts = color ? { color } : undefined;
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
      ctx.restore();
    }
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
    if (!sheets.length) return null;
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
    if (grown || this._percent === null) {
      this._percent = hasPercent(root);
      this._uses = needsExpanding(root);
    }
    const sized = this._percent || this._uses;
    const viewport = sized ? `${width}x${height}` : '';
    const painted = shapes ? `${paint}|${shapes.key}` : paint;
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
        sized || shapes || root.name.includes(':')
          ? copyTree(root, sized ? [width, height] : null, reached, shapes)
          : root;
      view.setSvgDom(paint ? withPaint(tree, paint) : tree);
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

/**
 * A drawing's root with its `fill` and `stroke` the document's: a copy of
 * the root, its children the same ones, with the declarations at the end of
 * its `style` — where `SvgView` reads a root's paint, over its presentation
 * attributes, for what is under it to inherit.
 */
function withPaint(root: Element, paint: string): Element {
  const style = root.attribs.style;
  return new Element(
    root.name,
    { ...root.attribs, style: style ? `${style};${paint}` : paint },
    root.children,
  );
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
const INLINE = new WeakMap<Element, SvgDrawing>();

/** The drawing of an inline `<svg>`. */
export function inlineDrawing(el: Element): SvgDrawing {
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

/** What a percentage in it means is not the viewport's: a gradient's are
 *  of the box it paints, and `SvgView` reads those itself. */
const OWN_UNITS = new Set(['lineargradient', 'radialgradient', 'pattern']);

function localName(name: string): string {
  const i = name.indexOf(':');
  return (i < 0 ? name : name.slice(i + 1)).toLowerCase();
}

/** Whether a length under the root is a percentage `SvgView` would read as
 *  a number: it resolves none against the viewport, so `width="100%"` was
 *  a hundred user units. */
function hasPercent(root: Element): boolean {
  const walk = (el: Element): boolean => {
    for (const child of el.children) {
      if (child.type !== 'tag') continue;
      const tag = child as Element;
      if (OWN_UNITS.has(localName(tag.name))) continue;
      for (const name in tag.attribs) {
        if (PERCENT_OF[name] && tag.attribs[name].trim().endsWith('%')) {
          return true;
        }
      }
      if (walk(tag)) return true;
    }
    return false;
  };
  return walk(root);
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
        copyInto(children, target, within, depth + 1, inner, styles);
      }
      if (kept || mine) {
        const paints = { ...kept };
        if (mine) restyle(paints, mine);
        const group = new Element('g', paints, children.splice(0));
        children.push(group);
      }
    } else if (shown(target, hidden, styles)) {
      children.push(copy(target, within, depth + 1, hidden, styles));
    }
    return new Element('g', attribs, children);
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
  ): void => {
    for (const child of el.children) {
      if (child.type === 'tag') {
        if (shown(child as Element, hidden, styles)) {
          children.push(copy(child as Element, resolve, depth, hidden, styles));
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
  ): Element => {
    const own = styles?.get(el);
    hidden = hiddenIn(own, hidden);
    if (localName(el.name) === 'use') {
      const group = expand(el, resolve, depth, hidden, own);
      if (group) return group;
    }
    const here = resolve && !OWN_UNITS.has(localName(el.name));
    const attribs = { ...el.attribs };
    if (own) restyle(attribs, own);
    if (here && viewport && el !== root) {
      for (const name in attribs) {
        const axis = PERCENT_OF[name];
        const value = attribs[name].trim();
        if (!axis || !value.endsWith('%')) continue;
        const pct = parseFloat(value);
        if (!Number.isFinite(pct)) continue;
        const of =
          axis === 'x' ? viewport[0] : axis === 'y' ? viewport[1] : diagonal;
        attribs[name] = String((pct / 100) * of);
      }
    }
    const children: ChildNode[] = [];
    copyInto(children, el, here, depth, hidden, styles);
    return new Element(strip(el.name), attribs, children);
  };
  return copy(root, true);
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
