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
import { isSvgRoot } from './dom.js';
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

/**
 * The `width`/`height` of an inline `<svg>` as CSS: they are presentation
 * attributes for the properties of the same names (SVG 2, 5.1.1), so
 * `height="50%"` is a percentage of the containing block like a style's.
 * A bare number is pixels; null for what CSS would not parse.
 */
export function svgSizeHint(value: string): string | null {
  const v = value.trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%$/i.test(v)) return v;
  const m = LENGTH.exec(v);
  if (!m) return null;
  return m[2] ? v : `${parseFloat(m[1])}px`;
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
  /** What the view was last handed the tree for: the root's child count
   *  and last child — a streamed document grows an inline drawing after its
   *  first paint — and, for a drawing with percentages in it, the viewport
   *  they were resolved against. */
  private _seen = -1;
  private _seenLast: ChildNode | null = null;
  private _seenViewport = '';
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

  constructor(root: Element, intrinsics: IntrinsicSize, standalone = false) {
    this._root = root;
    this.intrinsics = intrinsics;
    this._standalone = standalone;
  }

  /**
   * Draw into a rectangle — the box's content box, in device pixels —
   * clipped to it. The `viewBox`, where there is one, is fitted to it as
   * `preserveAspectRatio` says; without one a user unit is a CSS pixel,
   * which is `scale` device pixels. `color` is `currentColor`.
   */
  draw(
    ctx: ClipContext,
    x: number,
    y: number,
    w: number,
    h: number,
    scale: number,
    color?: string,
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
    const view = box
      ? this._viewFor(box[2], box[3])
      : this._viewFor(w / scale, h / scale);
    if (!view) return;
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const opts = color ? { color } : undefined;
      if (!box) {
        view.draw(
          ctx,
          x,
          y,
          view.naturalWidth * scale,
          view.naturalHeight * scale,
          opts,
        );
      } else {
        const fit = (svgAttr(root, 'preserveAspectRatio') ?? '')
          .trim()
          .split(/\s+/);
        if (fit[0] === 'defer') fit.shift();
        if (fit[0] === 'none') {
          view.draw(ctx, x, y, w, h, opts);
        } else {
          const align = ALIGN.exec(fit[0] ?? '') ?? ['xMidYMid', 'Mid', 'Mid'];
          const sx = w / box[2];
          const sy = h / box[3];
          const s = fit[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
          const dw = box[2] * s;
          const dh = box[3] * s;
          view.draw(
            ctx,
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
      ctx.restore();
    }
  }

  private _viewFor(width: number, height: number): SvgViewLike | null {
    const root = this._root;
    const count = root.children.length;
    const last = root.lastChild;
    // more of the document has arrived since a `<use>` found nothing
    const arrived =
      this._missingAt !== undefined &&
      lastNode(documentOf(root)) !== this._missingAt;
    const grown = count !== this._seen || last !== this._seenLast || arrived;
    if (grown || this._percent === null) {
      this._percent = hasPercent(root);
      this._uses = needsExpanding(root);
    }
    const sized = this._percent || this._uses;
    const viewport = sized ? `${width}x${height}` : '';
    if (this._view && !grown && viewport === this._seenViewport) {
      return this._view;
    }
    const View = svgViewClass();
    if (!View) {
      this._failed = true;
      return null;
    }
    try {
      const view = this._view ?? new View(null);
      const missing = { any: false };
      view.setSvgDom(
        sized || root.name.includes(':')
          ? copyTree(root, sized ? [width, height] : null, missing)
          : root,
      );
      this._missingAt = missing.any ? lastNode(documentOf(root)) : undefined;
      this._view = view;
      this._seen = count;
      this._seenLast = last;
      this._seenViewport = viewport;
      return view;
    } catch {
      this._failed = true;
      return null;
    }
  }
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

/** The element a `<use>` refers to by a fragment, its id: one in another
 *  document is none here, where nothing is fetched for a drawing. */
function useTarget(el: Element): string | null {
  const href = el.attribs.href ?? el.attribs['xlink:href'] ?? '';
  return href.length > 1 && href.startsWith('#') ? href.slice(1) : null;
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
 * a `<symbol>` as its children where they are. So one to an element
 * outside the root — an icon sprite's, a hidden `<svg>` of symbols at the
 * top of the page — and one to a symbol with a `viewBox` of its own are
 * drawn from a copy (`copyTree`).
 */
function needsExpanding(root: Element): boolean {
  let ids: Map<string, Element> | null = null;
  const walk = (el: Element): boolean => {
    for (const child of el.children) {
      if (child.type !== 'tag') continue;
      const tag = child as Element;
      if (localName(tag.name) === 'use') {
        const id = useTarget(tag);
        if (id !== null) {
          ids ??= idsUnder(root);
          const target = ids.get(id);
          if (!target) return true;
          if (localName(target.name) === 'symbol' && viewBoxOf(target)) {
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

/**
 * The tree `SvgView` reads, where the document's own will not do: with
 * local names — `SvgView` knows `rect`, not `svg:rect`, and a prefix is
 * dropped only where it is bound to SVG — and with its percentages resolved
 * against a viewport of `[width, height]` user units, where one is given;
 * and with each `<use>` that `SvgView` cannot draw (`needsExpanding`) as a
 * group of what it refers to (SVG 2, 5.5): the element, from wherever in
 * the document it is, or a symbol's children, its `viewBox` fitted to the
 * viewport the `<use>` gives it — its `width` and `height`, and all of the
 * drawing's where it has none. `missing.any` is set where one refers to an
 * element the document does not have.
 */
function copyTree(
  root: Element,
  viewport: [number, number] | null,
  missing?: { any: boolean },
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
  ): Element | null => {
    const id = useTarget(use);
    if (id === null || depth >= USE_DEPTH) return null;
    ids ??= idsUnder(root);
    const inside = ids.get(id);
    const target = inside ?? elementById(documentOf(root), id);
    if (!target) {
      if (missing) missing.any = true;
      return null;
    }
    const symbol = localName(target.name) === 'symbol';
    const box = symbol ? viewBoxOf(target) : null;
    // one of the root's own with no viewport to fit: `SvgView` draws it
    if (inside && !box) return null;
    const attribs: Record<string, string> = {};
    for (const name in use.attribs) {
      if (!USE_PLACEMENT.has(name)) attribs[name] = use.attribs[name];
    }
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
      for (const child of target.children) {
        if (child.type === 'tag') {
          children.push(copy(child as Element, within, depth + 1));
        }
      }
    } else children.push(copy(target, within, depth + 1));
    return new Element('g', attribs, children);
  };
  const copy = (el: Element, resolve: boolean, depth = 0): Element => {
    if (localName(el.name) === 'use') {
      const group = expand(el, resolve, depth);
      if (group) return group;
    }
    const here = resolve && !OWN_UNITS.has(localName(el.name));
    const attribs = { ...el.attribs };
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
    for (const child of el.children) {
      if (child.type === 'tag') {
        children.push(copy(child as Element, here, depth));
      } else if (child.type === 'text') children.push(new Text(child.data));
    }
    return new Element(strip(el.name), attribs, children);
  };
  return copy(root, true);
}

/**
 * An SVG image's bytes as a drawing, or null for bytes that are not SVG —
 * which is how a PNG or a JPEG goes on to the image decoder. Nothing names
 * the type, so it is sniffed: markup, with an `<svg>` root.
 */
export function svgFromBytes(bytes: Uint8Array): SvgDrawing | null {
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
    return root ? new SvgDrawing(root, svgIntrinsics(root), true) : null;
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
