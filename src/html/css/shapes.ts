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
import {
  inkColor,
  parseAlpha,
  parseColor,
  parseLength,
  splitCommas,
  splitValue,
} from './values.js';
import type { UnitContext } from './values.js';

/**
 * What a length in a drawing is of besides its own font size and its
 * viewport, in CSS pixels, which are its user units: the root element's
 * font size, a `rem`, and the sides of the document's viewport, a `vw` and
 * its kin (`Cascade.drawingUnits`). Unzoomed, since what zooms a drawing
 * is the scale it is drawn at (`paintSvg`): a `1vw` in a drawing under
 * `zoom: 4` is a hundredth of the viewport in user units, drawn four
 * device pixels to each.
 */
export interface DrawingUnits {
  rem: number;
  vw: number;
  vh: number;
}

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
  'stroke-dasharray': true,
  'stroke-dashoffset': true,
  'fill-rule': true,
  'fill-opacity': true,
  'stroke-opacity': true,
  'clip-rule': true,
  color: true,
  visibility: true,
  // what a `<text>` is set in: `text { font: 10px/1 Ahem }` sets it as a
  // paragraph's, and its `em`s are of it
  font: true,
  'font-family': true,
  'font-size': true,
  'font-style': true,
  'font-weight': true,
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
  // and its font, which its text inherits (`SvgDrawing.draw`'s `font`)
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
]);

/** Each at its initial value (SVG 2, 13; CSS Color 4; CSS Display 3). */
const INITIAL: Record<string, string> = {
  fill: '#000000',
  stroke: 'none',
  'stroke-width': '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-miterlimit': '4',
  'stroke-dasharray': 'none',
  'stroke-dashoffset': '0',
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
  'font-size': 'medium',
  'font-style': 'normal',
  'font-weight': '400',
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
    if (prop === 'font-family') {
      return quotedFamilies(ctx.units.initial?.fontFamily ?? 'sans-serif');
    }
    return prop === 'color'
      ? (ctx.units.initial?.color ?? '#000000')
      : (INITIAL[prop] ?? null);
  }
  if (wide === 'unset' || wide === 'revert' || wide === 'revert-layer') {
    return PROPS[prop] ? 'inherit' : (INITIAL[prop] ?? null);
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
    case 'stroke-dasharray': {
      // `none`, or lengths split on commas and white space, each in user
      // units as `stroke-width` takes one; a negative one is an error
      // (SVG 2, 13.5.5), and so here is a percentage, of the viewport's
      // diagonal, which only the drawing has
      if (value.toLowerCase() === 'none') return 'none';
      const parts = value.split(/[\s,]+/).filter(Boolean);
      if (!parts.length) return null;
      const out: number[] = [];
      for (const part of parts) {
        const px = NUMBER.test(part) ? Number(part) : lengthIn(part, ctx.units);
        if (px === null || !(px >= 0)) return null;
        out.push(px);
      }
      return out.join(' ');
    }
    case 'stroke-dashoffset': {
      const px = NUMBER.test(value)
        ? Number(value)
        : lengthIn(value, ctx.units);
      return px === null ? null : String(px);
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
    case 'font-size': {
      // a keyword, and a size of what the element inherits — an `em`, an
      // `ex`, a percentage — `SvgView` works out against the size it has
      // for the parent, as the drawing's own lengths in them are worked out
      // (`copyTree`); any other length is user units
      const v = value.toLowerCase();
      if (FONT_SIZE_WORDS.has(v) || INHERITED_SIZE.test(v)) return v;
      const px = lengthIn(value, ctx.units);
      return px !== null && px >= 0 ? String(px) : null;
    }
    case 'font-family': {
      const names = splitCommas(value);
      if (!names.length || !names.every(isFamilyName)) return null;
      const list = names
        .map((name) =>
          /^['"]/.test(name)
            ? name.slice(1, -1)
            : name.trim().replace(/\s+/g, ' '),
        )
        .join(', ');
      // the families the document loads itself, as the text engine knows
      // them (`fonts.ts`): a page's `Ahem` is no name the engine has
      return quotedFamilies(ctx.units.families?.(list) ?? list);
    }
    case 'font-weight': {
      const v = value.toLowerCase();
      if (/^(?:normal|bold|bolder|lighter)$/.test(v)) return v;
      const n = NUMBER.test(v) ? Number(v) : NaN;
      return n >= 1 && n <= 1000 ? String(n) : null;
    }
    case 'font-style': {
      const v = value.toLowerCase();
      if (v === 'normal' || v === 'italic') return v;
      return /^oblique\b/.test(v) ? 'oblique' : null;
    }
    default:
      return null;
  }
}

/** The `font-size` keywords, which `SvgView` reads as they are. */
const FONT_SIZE_WORDS = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'larger',
  'smaller',
]);

/** A size in a unit of the font the element inherits, or a percentage of
 *  it. */
const INHERITED_SIZE = /^[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?(?:em|ex|%)$/;

/** A family name: quoted, or identifiers (CSS Fonts 4, 2.1). */
function isFamilyName(name: string): boolean {
  const n = name.trim();
  if (/^(['"]).*\1$/s.test(n)) return n.length >= 2;
  return (
    n !== '' &&
    n
      .split(/\s+/)
      .every((word) =>
        /^-?(?:[_a-z\u00a0-\uffff]|\\.)(?:[-\w\u00a0-\uffff]|\\.)*$/i.test(
          word,
        ),
      )
  );
}

/**
 * The longhands a `font` shorthand gives a shape (CSS Fonts 4, 2.8), each
 * as `shapeValue` writes it: its style, its weight, its size and its
 * family, the first two back to their initial values where it names
 * neither. Null for a value that is no font — a size and a family are what
 * it must have — and for a system font, which nothing here has a table
 * for. Its line height and its variants are nothing a drawing reads.
 */
export function shapeFont(
  raw: string,
  ctx: ShapeContext,
): Record<string, string> | null {
  const value = raw.trim();
  const wide = value.toLowerCase();
  if (
    wide === 'inherit' ||
    wide === 'initial' ||
    wide === 'unset' ||
    wide === 'revert' ||
    wide === 'revert-layer'
  ) {
    const out: Record<string, string> = {};
    for (const prop of FONT_LONGHANDS) {
      const one = shapeValue(prop, wide, ctx);
      if (one !== null) out[prop] = one;
    }
    return out;
  }
  const parts = splitValue(value);
  if (parts.length < 2) return null;
  let style = 'normal';
  let weight = '400';
  let i = 0;
  for (; i < parts.length; i += 1) {
    const v = parts[i].toLowerCase();
    if (v === 'normal' || v === 'small-caps' || FONT_WIDTHS.has(v)) continue;
    if (v === 'italic' || v === 'oblique') style = v;
    else if (/^(?:bold|bolder|lighter|\d+)$/.test(v)) {
      const w = shapeValue('font-weight', v, ctx);
      if (w === null) return null;
      weight = w;
    } else break;
  }
  // `12px/1.5`, or the same with space round the slash
  const slash = (parts[i] ?? '').indexOf('/');
  const sizeText = slash < 0 ? parts[i] : parts[i].slice(0, slash);
  let next = i + 1;
  if (slash < 0 && parts[next]?.startsWith('/')) {
    next += parts[next] === '/' ? 2 : 1;
  } else if (slash === parts[i]?.length - 1) next += 1;
  const size = sizeText ? shapeValue('font-size', sizeText, ctx) : null;
  const family = shapeValue('font-family', parts.slice(next).join(' '), ctx);
  if (size === null || size === 'inherit' || family === null) return null;
  return {
    'font-style': style,
    'font-weight': weight,
    'font-size': size,
    'font-family': family,
  };
}

const FONT_LONGHANDS = [
  'font-style',
  'font-weight',
  'font-size',
  'font-family',
];

/** A width by its keyword, which a `font` may name and a drawing does not
 *  read (CSS Fonts 4, 2.7's `<font-width-css3>`). */
const FONT_WIDTHS = new Set([
  'ultra-condensed',
  'extra-condensed',
  'condensed',
  'semi-condensed',
  'semi-expanded',
  'expanded',
  'extra-expanded',
  'ultra-expanded',
]);

/** The generic families, which a font list names without quotes. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

/**
 * A style's family list as a `font` shorthand names it, for `SvgView` to
 * set its text in: each family quoted but the generic ones. The list a
 * style holds has its quotes taken off (`familyList`), and a name that is
 * not identifiers — `Font Awesome 6 Free` — makes a shorthand that a
 * context's parser drops whole, and the text is set in whatever font the
 * context had last.
 */
export function quotedFamilies(list: string): string {
  return list
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) =>
      GENERIC_FAMILIES.has(name.toLowerCase())
        ? name
        : `"${name.replace(/["\\]/g, '\\$&')}"`,
    )
    .join(', ');
}

/** A length in user units, which are CSS pixels; null for none, and for a
 *  percentage. */
function lengthIn(value: string, units: UnitContext): number | null {
  const length = parseLength(value, units);
  return typeof length === 'number' ? length / units.scale : null;
}
