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
// kept as **strings**, never parsed. ntk's context takes a CSS colour for
// `fillStyle` and parses it behind its own cache, so parsing here would be
// work done twice — and the only questions this renderer actually asks about
// a colour are "is it `transparent`" and "is it `currentColor`", both of
// which are string comparisons.

/** A length that layout may still have to resolve. */
export type Len = number | Pct | 'auto';

/** A percentage of something layout knows and computed style does not. */
export interface Pct {
  pct: number;
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
  if (len === AUTO) return fallback;
  return Number.isFinite(base) ? (len.pct / 100) * base : fallback;
}

/** Resolve, but keep "indefinite" distinguishable from zero — what a height
 *  needs, since `height: 50%` of an auto-height parent is not `0`, it is
 *  "there is no height here". */
export function resolveOrNull(len: Len, base: number): number | null {
  if (typeof len === 'number') return len;
  if (len === AUTO) return null;
  return Number.isFinite(base) ? (len.pct / 100) * base : null;
}

/** The font-relative context a length parses against. */
export interface UnitContext {
  /** The element's own `font-size`, already computed. */
  em: number;
  /** The root element's `font-size`. */
  rem: number;
  /** Viewport, for `vw`/`vh`/`vmin`/`vmax`. */
  vw: number;
  vh: number;
}

const LENGTH_RE =
  /^([+-]?(?:\d+\.?\d*|\.\d+))(px|em|rem|pt|pc|in|cm|mm|ex|ch|vw|vh|vmin|vmax|q|%)?$/;

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
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!unit) return bareIsPx ? n : null;
  if (unit === '%') return { pct: n };
  return n * unitScale(unit, ctx);
}

function unitScale(unit: string, ctx: UnitContext): number {
  switch (unit) {
    case 'px':
      return 1;
    case 'em':
      return ctx.em;
    case 'rem':
      return ctx.rem;
    case 'pt':
      return 96 / 72;
    case 'pc':
      return 16;
    case 'in':
      return 96;
    case 'cm':
      return 96 / 2.54;
    case 'mm':
      return 96 / 25.4;
    case 'q':
      return 96 / 101.6;
    // Approximations rather than font queries: both are within a few percent
    // for every text face, and asking the font manager here would make the
    // cascade depend on font loading.
    case 'ex':
      return ctx.em * 0.5;
    case 'ch':
      return ctx.em * 0.5;
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
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

/** `opacity: 50%` is as legal as `opacity: .5`. */
export function parseAlpha(value: string): number | null {
  const v = value.trim();
  if (v.endsWith('%')) {
    const n = Number(v.slice(0, -1));
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

/**
 * Split a value on top-level whitespace, keeping `rgb(1, 2, 3)` and
 * `url(a b.png)` whole. Every shorthand starts here.
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

/** `url(x)`, `url("x")`, or a bare token. `null` for `none`. */
export function parseUrl(value: string): string | null {
  const v = value.trim();
  if (!v || v.toLowerCase() === 'none') return null;
  const m = /^url\(\s*(.*?)\s*\)$/i.exec(v);
  const inner = m ? m[1] : v;
  return unquote(inner) || null;
}

export function unquote(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    (v[0] === '"' || v[0] === "'") &&
    v[v.length - 1] === v[0]
  ) {
    return v.slice(1, -1);
  }
  return v;
}

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

/** A colour token, with `currentColor` substituted. `null` means the value
 *  was not a colour, which is what a shorthand parser branches on. */
export function parseColor(value: string, currentColor: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === 'currentcolor') return currentColor;
  if (lower === 'transparent') return 'transparent';
  if (lower === 'inherit' || lower === 'initial' || lower === 'unset')
    return null;
  if (v.startsWith('#')) return /^#[0-9a-f]{3,8}$/i.test(v) ? v : null;
  if (/^(?:rgb|rgba|hsl|hsla|color|lab|lch|oklab|oklch)\(/i.test(v)) return v;
  return NAMED_COLORS.has(lower) ? lower : null;
}

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

/** Absolute and relative `font-size` keywords, against the CSS scale. */
export function keywordFontSize(
  value: string,
  parentSize: number,
  rootSize: number,
): number | null {
  switch (value.trim().toLowerCase()) {
    case 'xx-small':
      return rootSize * 0.5625;
    case 'x-small':
      return rootSize * 0.625;
    case 'small':
      return rootSize * 0.8125;
    case 'medium':
      return rootSize;
    case 'large':
      return rootSize * 1.125;
    case 'x-large':
      return rootSize * 1.5;
    case 'xx-large':
      return rootSize * 2;
    case 'smaller':
      return parentSize / 1.2;
    case 'larger':
      return parentSize * 1.2;
    default:
      return null;
  }
}
