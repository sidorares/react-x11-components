// CSS values: the length model, and the small parsers every property needs.
//
// The one decision worth stating is **when a unit resolves**. `em`, `rem`,
// `pt`, `pc`, `in`, `cm`, `mm`, `ex`, `ch`, `vw` and `vh` all resolve at
// *computed-style* time — they depend on the element's own font, the root
// font or the viewport, and all three are known before layout runs. `%` and
// `auto` do not: they need the containing block, which is layout's to know.
//
// That split is what makes a resize cheap. Restyling is the expensive half of
// the pipeline (selector matching, inheritance, shorthand expansion) and a
// resize does not need it: nothing in a computed style depends on the width
// except the percentages, and those were deliberately left unresolved so
// layout can resolve them against a new containing block on its own.
//
// Colours are the other half of that decision, from the other side: they are
// kept as **strings**, never parsed into components, since the only
// questions this renderer asks about a colour are "is it `transparent`" and
// "is it `currentColor`", both string comparisons. A named or hex colour
// goes to the context as written. A functional one is read once, in
// `color.ts`, and written back in the form every context reads the same.

import type { ComputedStyle } from './style.js';
import { functionalColor } from './color.js';
import { LARGEST, parseMath, parseMathNumber } from './calc.js';

/** A length that layout may still have to resolve. */
export type Len = number | Pct | 'auto';

/** A percentage of something layout knows and computed style does not. */
export interface Pct {
  pct: number;
  /** A length added to it: `calc(100% - 20px)`, or a background position
   *  written from its far edge, `right 10px`. */
  px?: number;
  /** In place of the two: `min()` or `max()` with a percentage among its
   *  arguments, which is a different sum at every base (`calc.ts`). */
  of?: { max: boolean; args: Len[] };
}

export const AUTO = 'auto';

export function isPct(len: Len): len is Pct {
  return typeof len === 'object';
}

/**
 * A length against a base. `auto` and a percentage of an indefinite base
 * (`NaN`, which is what an unresolved containing block is) both answer
 * `fallback` — the caller's "then I decide", which for a width is
 * shrink-to-fit and for a margin is zero.
 */
export function resolve(len: Len, base: number, fallback = 0): number {
  if (typeof len === 'number') return len;
  if (len === AUTO || !Number.isFinite(base)) return fallback;
  const px = len.of ? compared(len.of, base) : ofBase(len, base);
  return px > LARGEST ? LARGEST : px < -LARGEST ? -LARGEST : px;
}

/** A gap between flex items or grid tracks: a length, or a percentage of
 *  the content box's size along it — of nothing where that is not known,
 *  as a gap in an intrinsic size is (CSS Box Alignment 3, 8.3). */
export function gapOf(len: Len, base: number): number {
  return Math.max(0, resolve(len, Number.isFinite(base) ? base : 0));
}

/** Resolve, but keep "indefinite" distinguishable from zero — what a height
 *  needs, since `height: 50%` of an auto-height parent is not `0`, it is
 *  "there is no height here". */
export function resolveOrNull(len: Len, base: number): number | null {
  if (typeof len === 'number') return len;
  if (len === AUTO || !Number.isFinite(base)) return null;
  return len.of ? compared(len.of, base) : ofBase(len, base);
}

function ofBase(len: Pct, base: number): number {
  return (len.pct / 100) * base + (len.px ?? 0);
}

function compared(of: { max: boolean; args: Len[] }, base: number): number {
  let out = of.max ? -Infinity : Infinity;
  for (const arg of of.args) {
    const v = resolve(arg, base);
    out = of.max ? Math.max(out, v) : Math.min(out, v);
  }
  return out;
}

/**
 * The context a length parses against.
 *
 * Every length that comes out of `parseLength` is in **device pixels** —
 * the unit the box tree, the paint and the hit tests all share. `em`, `rem`,
 * `vw` and `vh` are already device (the root font size and the viewport are
 * handed over that way); the absolute units are CSS pixels the author wrote,
 * and `scale` is how many device pixels one of those is (core's
 * `docs/scale.md`). At 1x it is the identity, which is how a renderer that
 * never multiplied passed every test and drew a `16px` heading eight logical
 * pixels tall on a retina panel.
 */
export interface UnitContext {
  /** The element's own `font-size`, already computed. */
  em: number;
  /** The root element's `font-size`. */
  rem: number;
  /** Viewport, for `vw`/`vh`/`vmin`/`vmax` and their kin (`viewportUnit`). */
  vw: number;
  vh: number;
  /** Device pixels per CSS pixel — the display scale. */
  scale: number;
  /** The x-height of the font the lengths are in, asked only for a length
   *  in `ex`; half an em where it is missing. */
  ex?: () => number;
  /** The advance of that font's "0", asked only for a length in `ch`; half
   *  an em where it is missing. */
  ch?: () => number;
  /** A computed `font-family` list with the families the document loads
   *  itself, with `@font-face`, put as the text engine knows them — see
   *  `fonts.ts`. Absent, the list is the one the author wrote. */
  families?: (list: string) => string;
  /** The family a `font-family` list with no generic family at its end
   *  goes on to: the document's own, for a list an author wrote, and none
   *  for the UA sheet's, which names the host's faces. */
  fallbackFamily?: () => string | null;
  /** The list the UA sheet names the host's code face by (`monoFamily`),
   *  which stands for the generic `monospace` there — the face a browser
   *  sets that generic in is its own, a setting a reader can change — and
   *  null for a list an author wrote, which is that generic only where it
   *  says `monospace`. */
  codeFamily?: () => string | null;
  /** The element's line height and the root's, for `lh` and `rlh`, asked
   *  only for a length in them; 1.2em where they are missing. */
  lh?: () => number;
  rlh?: () => number;
  /** Every property at its initial value, which `initial` sets one to. */
  initial?: ComputedStyle;
  /** The palette's focus ring, which `-webkit-focus-ring-color` is. */
  focusRing?: string;
  /** The scheme the palette is, the reader's preference, which a
   *  `color-scheme` that names it takes (`usedColorScheme`); `initial`'s,
   *  which is `normal`'s, where it is missing. */
  paletteScheme?: 'light' | 'dark';
  /** Each system colour as the `light-dark()` it is, the palette's in the
   *  palette's scheme (`systemColorTable`); Chrome's where it is missing. */
  systemColors?: Map<string, string>;
}

/** A CSS number (CSS Syntax 3 4.3.12): a sign, digits with at most one
 *  point and a digit after it, and an exponent — `1e1px` is ten pixels, and
 *  `1.px` is no length. */
const NUMBER_SRC = '[+-]?(?:\\d*\\.\\d+|\\d+)(?:e[+-]?\\d+)?';

const LENGTH_RE = new RegExp(
  `^(${NUMBER_SRC})(px|em|rem|pt|pc|in|cm|mm|ex|ch|lh|rlh|[sld]?v(?:w|h|i|b|min|max)|q|%)?$`,
);

/**
 * The viewport unit a viewport-percentage length is (CSS Values 4, 6.1.2),
 * or null for another unit. The small, large and dynamic viewports —
 * `svh`, `lvh`, `dvh` and their kin — are the one viewport here, as they
 * are on a desktop, where no toolbar comes and goes over the page; and the
 * inline and block axes, `vi` and `vb`, are the width and the height of
 * the horizontal writing mode every document here is laid out in.
 */
export function viewportUnit(
  unit: string,
): 'vw' | 'vh' | 'vmin' | 'vmax' | null {
  const u = unit.toLowerCase();
  const bare = /^[sld]v/.test(u) ? u.slice(1) : u;
  switch (bare) {
    case 'vw':
    case 'vi':
      return 'vw';
    case 'vh':
    case 'vb':
      return 'vh';
    case 'vmin':
    case 'vmax':
      return bare;
    default:
      return null;
  }
}

const NUMBER_RE = new RegExp(`^${NUMBER_SRC}$`, 'i');

/** A math function: `calc()`, `min()`, `max()` or `clamp()`. */
const MATH = /^(?:-webkit-)?calc\(|^(?:min|max|clamp)\(/i;

/**
 * Parse a length. Returns `null` for anything that is not one, which is how
 * every caller tells "the author wrote something else" from "the author wrote
 * zero" — a distinction `0` cannot carry and which decides whether a
 * declaration is applied at all.
 *
 * A bare number is a length only when `bareIsPx` says so: it is right for a
 * `width="600"` presentation attribute and wrong for `line-height: 1.5`.
 */
export function parseLength(
  value: string,
  ctx: UnitContext,
  bareIsPx = false,
): Len | null {
  const v = value.trim().toLowerCase();
  if (v === 'auto') return AUTO;
  if (v === '0') return 0;
  const m = LENGTH_RE.exec(v);
  if (!m) {
    // `calc()` and its kin, down to pixels and a percentage (CSS Values 4 10)
    if (!MATH.test(v)) return null;
    return parseMath(v, (token) => {
      const len = parseLength(token, ctx);
      return typeof len === 'number' ? len : null;
    });
  }
  const n = Number(m[1]);
  const unit = m[2] && (viewportUnit(m[2]) ?? m[2]);
  // a zero needs no unit however it is written — `-0`, `+0`, `0.0`
  if (!unit) return n === 0 ? 0 : bareIsPx ? n * ctx.scale : null;
  if (unit === '%') return { pct: n };
  // Kept to what a browser holds: a `1e308px` height or margin, which a
  // hostile or broken page writes, added up past what a number holds, and
  // the document's height came to infinity
  const px = n * unitScale(unit, ctx);
  return px > LARGEST ? LARGEST : px < -LARGEST ? -LARGEST : px;
}

/** Device pixels per one of `unit`. The absolute units are CSS pixels and
 *  multiples of them, so they carry the display scale; the relative ones
 *  resolve against values that are device already. */
function unitScale(unit: string, ctx: UnitContext): number {
  switch (unit) {
    case 'px':
      return ctx.scale;
    case 'em':
      return ctx.em;
    case 'rem':
      return ctx.rem;
    case 'pt':
      return (96 / 72) * ctx.scale;
    case 'pc':
      return 16 * ctx.scale;
    case 'in':
      return 96 * ctx.scale;
    case 'cm':
      return (96 / 2.54) * ctx.scale;
    case 'mm':
      return (96 / 25.4) * ctx.scale;
    case 'q':
      return (96 / 101.6) * ctx.scale;
    // The font's own x-height where the cascade was handed a way to ask
    // for it, and half an em where it was not, which is within a few
    // percent for most text faces — and for Ahem, whose x-height is 0.8em,
    // is not.
    case 'ex':
      return ctx.ex ? ctx.ex() : ctx.em * 0.5;
    // the advance of the font's "0" (CSS Values 4, 6.1.1), where the
    // cascade can ask for it: half an em is Times's, a little under
    // Arial's, and half of Ahem's and a monospace font's
    case 'ch':
      return ctx.ch ? ctx.ch() : ctx.em * 0.5;
    // the computed `line-height`, `normal` as the font's own (CSS Values
    // 4, 6.1.1)
    case 'lh':
      return ctx.lh ? ctx.lh() : ctx.em * 1.2;
    case 'rlh':
      return ctx.rlh ? ctx.rlh() : ctx.rem * 1.2;
    case 'vw':
      return ctx.vw / 100;
    case 'vh':
      return ctx.vh / 100;
    case 'vmin':
      return Math.min(ctx.vw, ctx.vh) / 100;
    case 'vmax':
      return Math.max(ctx.vw, ctx.vh) / 100;
    default:
      return 1;
  }
}

/** A plain number — `flex-grow`, `opacity`, `z-index`, `line-height`. */
export function parseNumber(value: string): number | null {
  // `Number()` alone reads `0x10`, `1.` and white space as numbers
  const v = value.trim();
  if (!NUMBER_RE.test(v)) return MATH.test(v) ? parseMathNumber(v) : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** `opacity: 50%` is as legal as `opacity: .5`. */
export function parseAlpha(value: string): number | null {
  const v = value.trim();
  const pct = v.endsWith('%');
  const n = parseNumber(pct ? v.slice(0, -1) : v);
  if (n === null) return null;
  return Math.max(0, Math.min(1, pct ? n / 100 : n));
}

/** What may follow a function's `)` in the part it ends (`splitValue`). */
const JOINED = /[\s,/)]/;

/**
 * Split a value on top-level whitespace, keeping `rgb(1, 2, 3)` and
 * `url(a b.png)` whole. Every shorthand starts here.
 *
 * A function is a component value of its own, ended by its `)` (CSS Syntax
 * 3, 5.4.9), so what follows it straight after is the next one: a minified
 * sheet writes `translate(2px,0)rotate(0)` and `calc(100% - 7px)0`, and
 * read as one part, Tailwind's every transform was no transform. A comma
 * or a slash after it is left where it is, for the callers that find them.
 */
export function splitValue(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quote) {
      if (c === quote && value[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      if (depth === 1 && i + 1 < value.length && !JOINED.test(value[i + 1])) {
        out.push(value.slice(start, i + 1));
        start = i + 1;
      }
      depth = Math.max(0, depth - 1);
    } else if (
      depth === 0 &&
      (c === ' ' || c === '\t' || c === '\n' || c === '\r')
    ) {
      if (i > start) out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (value.length > start) out.push(value.slice(start));
  return out;
}

/** Split on top-level commas — `font-family`, `background`'s layer list. */
export function splitCommas(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quote) {
      if (c === quote && value[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

/** The four sides a `margin`/`padding`/`border-width` shorthand expands to,
 *  in CSS's top-right-bottom-left order. */
export function fourSides<T>(parts: T[]): [T, T, T, T] {
  const [a, b = a, c = a, d = b] = parts;
  return [a, b, c, d];
}

/** A colour as it is about to be used: `currentColor` resolved against the
 *  element's own ink, everything else passed through. */
export function inkColor(color: string, current: string): string {
  if (color === 'currentColor') return current;
  // a `color-mix()` or a relative colour with `currentColor` in it waits
  // for the colour too; every other functional colour was read when it was
  // parsed, to `#rrggbb` or `rgba()` with no letters in it
  if (color.charCodeAt(color.length - 1) === 41 && HAS_CURRENT.test(color)) {
    return functionalColor(color.replace(CURRENT, current)) ?? current;
  }
  return color;
}

const CURRENT = /currentcolor/gi;
const HAS_CURRENT = /currentcolor/i;
const RELATIVE_COLOR = /^[a-z]+\(\s*from\s/i;

/** Whether a colour paints anything at all. Two string tests rather than a
 *  parse, for the reason at the top of the file. */
export function isTransparent(color: string | null | undefined): boolean {
  if (!color) return true;
  const c = color.trim().toLowerCase();
  if (c === 'transparent' || c === 'none') return true;
  // `rgba(…, 0)` / `hsla(…, 0)` — the zero-alpha forms, which pages really
  // do write for a "no background" that inherits nothing.
  return /^(?:rgba|hsla)\([^)]*[,/]\s*0*(?:\.0+)?\s*\)$/.test(c);
}

/**
 * A colour's opacity, 0 to 1, as `parseColor` leaves it: a hex colour's
 * fourth or eighth digits, an `rgba()`'s last number, and nothing for
 * `transparent`; every other colour, `currentColor` among them, is taken
 * for opaque.
 */
export function alphaOf(color: string): number {
  if (color === 'transparent') return 0;
  if (color.charCodeAt(0) === 35) {
    // `#rgba` and `#rrggbbaa`
    if (color.length === 5) return parseInt(color[4], 16) / 15;
    if (color.length === 9) return parseInt(color.slice(7), 16) / 255;
    return 1;
  }
  const m = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(color);
  return m ? Number(m[1]) : 1;
}

/**
 * A colour token. `null` means the value was not a colour, which is what a
 * shorthand parser branches on.
 *
 * `currentColor` survives as the literal token rather than being substituted:
 * it means "this element's `color`" at *use* time, and substituting at parse
 * time freezes whatever the colour happened to be mid-cascade — a rule
 * writing `border-bottom: 1px solid` and then `color: red` would keep the
 * inherited ink on its border. `inkColor` is the other half.
 */
export function parseColor(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === 'currentcolor') return 'currentColor';
  if (lower === 'transparent') return 'transparent';
  if (lower === 'inherit' || lower === 'initial' || lower === 'unset')
    return null;
  // three, four, six or eight digits: ntk's context throws from paint on
  // five or seven, and a typo'd `#ff000` took the application down
  if (v.startsWith('#')) return HEX_COLOR.test(v) ? v : null;
  if (/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(v)) {
    // a mix or a relative colour with `currentColor` in it is kept to be
    // worked out where it is used (`inkColor`), once it is known to be one
    if (HAS_CURRENT.test(v)) {
      if (/^color-mix\(/i.test(v)) {
        return functionalColor(v.replace(CURRENT, '#000')) === null
          ? null
          : `color-mix(${v.slice(v.indexOf('(') + 1)}`;
      }
      if (RELATIVE_COLOR.test(v)) {
        return functionalColor(v.replace(CURRENT, '#000')) === null
          ? null
          : `${v.slice(0, v.indexOf('(')).toLowerCase()}${v.slice(v.indexOf('('))}`;
      }
    }
    return functionalColor(v);
  }
  return NAMED_COLORS.has(lower) ? lower : null;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The CSS named colours. The list is here rather than reached through ntk's
 * `parse-color` because the only question asked of it is "is this token a
 * colour or is it the next keyword in a shorthand" — `border: 1px solid red`
 * has to tell `solid` from `red` before anything is parsed, and a parser that
 * answers by throwing is not a predicate.
 */
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen'
  ).split(' '),
);

/** `font-weight`, as the number ntk's font matcher wants. */
export function parseWeight(value: string, inherited: number): number {
  const v = value.trim().toLowerCase();
  switch (v) {
    case 'normal':
      return 400;
    case 'bold':
      return 700;
    // Relative weights are relative to the *parent's* computed weight, which
    // is why this takes it rather than reading a constant.
    case 'bolder':
      return inherited >= 600 ? 900 : inherited >= 400 ? 700 : 400;
    case 'lighter':
      return inherited >= 700 ? 400 : inherited >= 500 ? 300 : 100;
    default: {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(1, Math.min(1000, n)) : inherited;
    }
  }
}

/** `font-stretch`'s keywords, as the percentages they are (CSS Fonts 4,
 *  2.3). */
const STRETCHES: Readonly<Record<string, number>> = {
  'ultra-condensed': 50,
  'extra-condensed': 62.5,
  condensed: 75,
  'semi-condensed': 87.5,
  normal: 100,
  'semi-expanded': 112.5,
  expanded: 125,
  'extra-expanded': 150,
  'ultra-expanded': 200,
};

/**
 * `font-stretch` (CSS Fonts 4, 2.3), the width text is set at as a
 * percentage of its face's normal width: a keyword, or a percentage that is
 * not below 0%. Null for anything else, and the declaration is dropped.
 * `keywordsOnly` is the `font` shorthand's case, which takes the keywords
 * alone: there `75%` would be read as a size.
 */
export function parseStretch(
  value: string,
  keywordsOnly = false,
): number | null {
  const v = value.trim().toLowerCase();
  if (Object.hasOwn(STRETCHES, v)) return STRETCHES[v];
  if (keywordsOnly) return null;
  let pct: number | null = null;
  if (v.endsWith('%') && NUMBER_RE.test(v.slice(0, -1))) {
    pct = Number(v.slice(0, -1));
  } else if (MATH.test(v)) {
    // `calc(50% + 25%)`, which comes to a percentage and nothing more
    const len = parseMath(v, () => null);
    if (len !== null && isPct(len) && !len.of && !len.px) pct = len.pct;
  }
  return pct !== null && Number.isFinite(pct) && pct >= 0 ? pct : null;
}

/** The generic fixed-width family's size to everyone else's: 13 to 16, the
 *  two default sizes every browser keeps. */
export const FIXED_SIZE = 13 / 16;

/**
 * The absolute-size keywords as fractions of `medium`: a browser's table
 * for its 16px default, 9, 10, 13, 16, 18, 24 and 32 pixels, and the row
 * for its 13px fixed-width default the generic `monospace` is read from,
 * 9, 10, 12, 13, 16, 20 and 26 — a `<pre>` at `large` is 16px in Blink,
 * Gecko and WebKit alike.
 */
const KEYWORD_SIZES = new Map<string, readonly [number, number]>([
  ['xx-small', [9 / 16, 9 / 16]],
  ['x-small', [10 / 16, 10 / 16]],
  ['small', [13 / 16, 12 / 16]],
  ['medium', [1, FIXED_SIZE]],
  ['large', [18 / 16, 1]],
  ['x-large', [24 / 16, 20 / 16]],
  ['xx-large', [2, 26 / 16]],
]);

/** Absolute and relative `font-size` keywords, against the CSS scale, or
 *  the generic `monospace`'s where `fixed`. */
export function keywordFontSize(
  value: string,
  parentSize: number,
  rootSize: number,
  fixed = false,
): number | null {
  const v = value.trim().toLowerCase();
  const sizes = KEYWORD_SIZES.get(v);
  if (sizes) return rootSize * sizes[fixed ? 1 : 0];
  if (v === 'smaller') return parentSize / 1.2;
  if (v === 'larger') return parentSize * 1.2;
  return null;
}

/**
 * What a font size is worked out from (`ComputedStyle.fontSizeBasis`): an
 * absolute-size keyword; `relative`, a length in a unit of the font's, a
 * percentage, `smaller` or `larger` of a size that is a keyword or relative
 * itself, all the way up to the root's `medium`; or `absolute`, any other
 * length or a size under one.
 */
export type FontSizeBasis =
  | 'absolute'
  | 'relative'
  | 'xx-small'
  | 'x-small'
  | 'small'
  | 'medium'
  | 'large'
  | 'x-large'
  | 'xx-large';

/**
 * The basis of a `font-size` an element sets itself, under a parent's
 * size of `parent`'s basis. Blink's `ConvertFontSize`: a length in a unit
 * of the font's, `em`, `ex`, `ch`, `lh` and `rlh` but not `rem`, and a
 * percentage, `smaller` and `larger` are relative where the parent's size
 * is, and any other length is absolute, as is a `calc()` whatever is in
 * it. WebKit has the same rule, but takes an `rlh` as a length.
 */
export function fontSizeBasis(
  value: string,
  parent: FontSizeBasis,
): FontSizeBasis {
  const v = value.trim().toLowerCase();
  if (KEYWORD_SIZES.has(v)) return v as FontSizeBasis;
  if (v !== 'smaller' && v !== 'larger' && !RELATIVE_SIZE.test(v)) {
    return 'absolute';
  }
  return parent === 'absolute' ? 'absolute' : 'relative';
}

const RELATIVE_SIZE = new RegExp(`^${NUMBER_SRC}(?:em|ex|ch|r?lh|%)$`);
