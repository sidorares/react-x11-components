// What a style sheet says of the shapes in a drawing.
//
// An inline `<svg>` is a replaced box: the box builder stops at it, and no
// computed style is made for what is inside. `fill`, `stroke` and their kin
// are properties all the same (SVG 2, 6.2 and 13.2), which a rule of the
// document's sets on a `<path>` as it would on a paragraph — a logo's
// `.dark .logo path { fill: #fff }` — and a drawing exported with a style
// sheet of its own, `.st0 { fill: #fff }` on `<path class="st0">`, has all
// its colours in one. So the cascade is run for them narrowly
// (`Cascade.shapeStyles`): over the rules that declare one of the
// properties here, and down to values `SvgView` reads from a `style`
// attribute, which is where the drawing's copy of an element carries them
// (`svg.ts`). A `ComputedStyle` per `<path>` would be a few hundred
// properties for the dozen a shape has, on a page of hundreds of icons.
import type { Element } from 'domhandler';
import { LIGHT_DARK, SYSTEM_COLOR, lightDark, systemColors } from './color.js';
import { inkColor, parseAlpha, parseColor, parseLength } from './values.js';
import type { UnitContext } from './values.js';

/** What the rules give one element of a drawing: each property they set,
 *  as `SvgView` reads it — `inherit` for one they put back to what the
 *  element inherits, over its own attribute. */
export type ShapeStyle = Readonly<Record<string, string>>;

/** What the rules give the elements of one drawing, and all of it as a
 *  string: what a drawing's tree was last made with (`SvgDrawing`). */
export interface ShapeStyles {
  /** Each element's, where it stands. */
  readonly of: ReadonlyMap<Element, ShapeStyle>;
  /**
   * What they give the copy a `<use>` draws, by the `<use>`, then by each
   * element of the copy's original; null where they give none. A copy is
   * styled in a tree of its own, which its original is the top of (SVG 2,
   * 5.5.3, as Chrome has it): a rule finds no ancestor of that element's
   * and none of the `<use>`'s, and no sibling of it, and what the top
   * inherits is the `<use>`'s. So `symbol .line` reaches a sprite's line
   * where `.sprite .line` does not, and an element a `<use>` draws may be
   * styled otherwise than where it stands.
   */
  readonly used: ReadonlyMap<Element, ReadonlyMap<Element, ShapeStyle>> | null;
  readonly key: string;
}

/** The id a `<use>` names the element it draws by: a fragment of its
 *  `href`. One in another document is none here, where nothing is fetched
 *  for a drawing. */
export function useHref(el: Element): string | null {
  const href = el.attribs.href ?? el.attribs['xlink:href'] ?? '';
  return href.length > 1 && href.startsWith('#') ? href.slice(1) : null;
}

/** Whether an element is a `<use>`, with a prefix or not. */
export function isUse(el: Element): boolean {
  const name = el.name;
  if (name === 'use') return true;
  const i = name.indexOf(':');
  return i >= 0 && name.slice(i + 1).toLowerCase() === 'use';
}

/** Each property read, and whether it is inherited. */
const PROPS: Record<string, boolean> = {
  fill: true,
  stroke: true,
  'stroke-width': true,
  'stroke-linecap': true,
  'stroke-linejoin': true,
  'stroke-miterlimit': true,
  'fill-rule': true,
  'fill-opacity': true,
  'stroke-opacity': true,
  'clip-rule': true,
  color: true,
  visibility: true,
  opacity: false,
  display: false,
  'clip-path': false,
  'stop-color': false,
  'stop-opacity': false,
};

/** Whether a rule with this declaration is one to keep for drawings. */
export function isShapeProp(prop: string): boolean {
  return PROPS[prop] !== undefined;
}

/** The properties the drawing's box has from its computed style already:
 *  its paint, which `paintSvg` hands the drawing, and what makes it a box,
 *  shown, see-through and cut as one. */
export const ROOT_BOX_PROPS: ReadonlySet<string> = new Set([
  'fill',
  'stroke',
  'color',
  'display',
  'visibility',
  'opacity',
  'clip-path',
]);

/** Each at its initial value (SVG 2, 13; CSS Color 4; CSS Display 3). */
const INITIAL: Record<string, string> = {
  fill: '#000000',
  stroke: 'none',
  'stroke-width': '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-miterlimit': '4',
  'fill-rule': 'nonzero',
  'fill-opacity': '1',
  'stroke-opacity': '1',
  'clip-rule': 'nonzero',
  visibility: 'visible',
  opacity: '1',
  display: 'inline',
  'clip-path': 'none',
  'stop-color': '#000000',
  'stop-opacity': '1',
};

/** The elements a rule's subject can be, where it names one by its type,
 *  for the rule to reach into a drawing: the ones `SvgView` draws, or
 *  reads a paint from. `a` is both languages'. */
export const SHAPE_TAGS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'a',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'use',
  'symbol',
  'switch',
  'image',
  'stop',
  'clippath',
]);

/** What a shape's values are read against: the drawing's own `color` and
 *  colour scheme, and its font size for a length in `em`. */
export interface ShapeContext {
  color: string;
  scheme: 'light' | 'dark';
  units: UnitContext;
}

/**
 * A `fill` or a `stroke` (SVG 2, 13.2): `none`, a colour, or a `url()`
 * naming a gradient in the drawing, with what follows it, its fallback,
 * left off. Null for anything else, `context-fill` and `context-stroke`
 * among it, which only a marker or a `<use>` has a context for.
 */
export function svgPaint(value: string): string | null {
  const v = value.trim();
  if (v.toLowerCase() === 'none') return 'none';
  const url = /^url\(\s*(['"]?)(#[^'")\s]+)\1\s*\)/i.exec(v);
  if (url) return `url(${url[2]})`;
  return parseColor(v);
}

const NUMBER = /^[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?$/i;

/** A word of a `display` that makes a box (CSS Display 3, 2). */
const DISPLAY =
  /^(?:block|inline|run-in|flow|flow-root|table|flex|grid|ruby|list-item|contents|inline-[a-z]+|table-[a-z-]+|ruby-[a-z-]+|-webkit-[a-z-]+)$/;

const LINE_JOINS: Record<string, string> = {
  miter: 'miter',
  round: 'round',
  bevel: 'bevel',
  // the two a canvas has no join for end in a miter, clipped or not
  'miter-clip': 'miter',
  arcs: 'miter',
};

/** The properties of a shape that a colour is written in. */
const SHAPE_COLORS = new Set(['fill', 'stroke', 'color', 'stop-color']);

/**
 * One declaration's value as a drawing reads it, or null for a value the
 * property does not take, which leaves the declaration out of the cascade
 * as any invalid one is left. `inherit` for a CSS-wide keyword that puts an
 * inherited property back to what the element inherits.
 */
export function shapeValue(
  prop: string,
  raw: string,
  ctx: ShapeContext,
): string | null {
  let value = raw.trim();
  const wide = value.toLowerCase();
  if (wide === 'inherit') return PROPS[prop] ? 'inherit' : null;
  if (wide === 'initial') {
    return prop === 'color'
      ? (ctx.units.initial?.color ?? '#000000')
      : INITIAL[prop];
  }
  if (wide === 'unset' || wide === 'revert' || wide === 'revert-layer') {
    return PROPS[prop] ? 'inherit' : INITIAL[prop];
  }
  if (SHAPE_COLORS.has(prop) && SYSTEM_COLOR.test(value)) {
    value = systemColors(value, ctx.units.systemColors);
  }
  if (LIGHT_DARK.test(value)) {
    const picked = lightDark(value, ctx.scheme);
    if (picked === null) return null;
    value = picked;
  }
  switch (prop) {
    case 'fill':
    case 'stroke': {
      const paint = svgPaint(value);
      // `currentColor` is the shape's own `color`, which the drawing knows
      return paint === null || paint === 'currentColor'
        ? paint
        : inkColor(paint, ctx.color);
    }
    case 'color':
    case 'stop-color': {
      const color = parseColor(value);
      return color === null ? null : inkColor(color, ctx.color);
    }
    case 'stroke-width': {
      // a number is user units, as a length in pixels is; a percentage is
      // of the viewport's diagonal, which only the drawing has
      const px = NUMBER.test(value)
        ? Number(value)
        : lengthIn(value, ctx.units);
      return px !== null && px >= 0 ? String(px) : null;
    }
    case 'stroke-miterlimit': {
      const n = NUMBER.test(value) ? Number(value) : NaN;
      return n >= 1 ? String(n) : null;
    }
    case 'fill-opacity':
    case 'stroke-opacity':
    case 'stop-opacity':
    case 'opacity': {
      const a = parseAlpha(value);
      return a === null ? null : String(a);
    }
    case 'stroke-linecap': {
      const v = value.toLowerCase();
      return v === 'butt' || v === 'round' || v === 'square' ? v : null;
    }
    case 'stroke-linejoin':
      return LINE_JOINS[value.toLowerCase()] ?? null;
    case 'fill-rule':
    case 'clip-rule': {
      const v = value.toLowerCase();
      return v === 'nonzero' || v === 'evenodd' ? v : null;
    }
    case 'clip-path': {
      // `none`, or the `<clipPath>` a `url()` names in the drawing: a
      // shape of CSS's own is one `SvgView` does not cut to
      if (value.toLowerCase() === 'none') return 'none';
      const url = /^url\(\s*(['"]?)(#[^'")\s]+)\1\s*\)$/i.exec(value);
      return url ? `url(${url[2]})` : null;
    }
    case 'visibility': {
      const v = value.toLowerCase();
      if (v === 'visible') return v;
      return v === 'hidden' || v === 'collapse' ? 'hidden' : null;
    }
    case 'display': {
      // `none`, or some box: which one is nothing to a shape
      const v = value.toLowerCase();
      if (v === 'none') return v;
      return v.split(/\s+/).every((word) => DISPLAY.test(word))
        ? 'inline'
        : null;
    }
    default:
      return null;
  }
}

/** A length in user units, which are CSS pixels; null for none, and for a
 *  percentage. */
function lengthIn(value: string, units: UnitContext): number | null {
  const length = parseLength(value, units);
  return typeof length === 'number' ? length / units.scale : null;
}
