// SVG's properties as a page's CSSOM reads them (SVG 2, 6, 9, 13 and 15,
// and CSS Masking 1): `fill`, `stroke` and their kin, the geometry
// properties `cx` to `ry`, `stop-color`, the markers and the rendering
// hints. What draws a drawing reads them otherwise (`shapes.ts`, and the
// attributes `SvgView` reads); this is what `el.style` keeps of one and what
// `getComputedStyle` answers for it, for every element, a `<div>` as much as
// a `<circle>`, since each applies to some element and is inherited or not
// whatever it is on.
//
// Each property is its grammar, which says what text a declaration keeps
// (`specified`) or that the declaration is none; its initial value; whether
// it is inherited; and what its computed value reads as (`computed`), its
// lengths in pixels where they are absolute or relative to the font, a
// percentage as it is, and its colours as `rgb()`. Every answer is
// Chromium's, which WPT's `svg/*/parsing` tests hold it to.
import { serializeMath } from './calc-tree.js';
import { parseColor, parseLength } from './values.js';
import type { UnitContext } from './values.js';
import { rgbaOf, specifiedColorText } from './color.js';

/** What a computed value is worked out against: the element's font size and
 *  the root's, the viewport, in CSS pixels, and its `color`, already
 *  computed, for `currentcolor`. */
export interface SvgUnits {
  /** A relative URL resolved, as a computed `url()` is. */
  url(url: string): string;
  em: number;
  rem: number;
  vw: number;
  vh: number;
  ex: () => number;
  ch: () => number;
  color: string;
  /** A colour as `getComputedStyle` writes one (`cssomColor`). */
  colorText(value: string): string;
}

export interface SvgProperty {
  inherited: boolean;
  /** The initial value as it computes. */
  initial: string;
  /** A declaration's value as `el.style` keeps it, or null where it is no
   *  value of the property. */
  specified(value: string): string | null;
  /** A value `specified` kept, as `getComputedStyle` reads it. */
  computed(specified: string, units: SvgUnits): string;
  /** An attribute of the same name on an element this applies to is a
   *  declaration of it (SVG 2, 6.6): what it takes, which may be more than
   *  the property does, a bare number for a length. */
  attribute?(value: string): string | null;
}

/** A number as CSS writes it: as short as it goes, `-0` as `0`. */
const numberText = (n: number): string => {
  const r = Number(n.toPrecision(6));
  return Object.is(r, -0) ? '0' : String(r);
};
/** Computed pixels as `getComputedStyle` writes them, to three places. */
const pxText = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return `${Object.is(r, -0) ? 0 : r}px`;
};
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;
const DIMENSION = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(%|[a-z]+)$/i;
const LENGTH_UNITS = new Set([
  'px',
  'em',
  'ex',
  'ch',
  'rem',
  'cap',
  'ic',
  'lh',
  'rlh',
  'vw',
  'vh',
  'vi',
  'vb',
  'vmin',
  'vmax',
  'svw',
  'svh',
  'lvw',
  'lvh',
  'dvw',
  'dvh',
  'cqw',
  'cqh',
  'cqi',
  'cqb',
  'cqmin',
  'cqmax',
  'cm',
  'mm',
  'q',
  'in',
  'pt',
  'pc',
]);
const MATH = /^(?:calc|min|max|clamp)\(/i;
/** What a length is checked against where its value does not matter. */
const CHECK: UnitContext = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };

/** A `<length-percentage>`, and a `<number>` where `numbers` lets one in,
 *  as a declaration keeps it; null for anything else. */
function lengthPercentage(
  value: string,
  numbers: boolean,
  positive: boolean,
): string | null {
  const v = value.trim();
  if (NUMBER.test(v)) {
    const n = Number(v);
    if (positive && n < 0) return null;
    if (numbers) return numberText(n);
    return n === 0 ? '0px' : null;
  }
  const m = DIMENSION.exec(v);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit !== '%' && !LENGTH_UNITS.has(unit)) return null;
    if (positive && n < 0) return null;
    return numberText(n) + unit;
  }
  if (MATH.test(v)) {
    const out = serializeMath(v);
    if (!out) return null;
    // a calculation is a length, a percentage or a number, and only some
    // of those are taken: a number added to a length is none of them
    if (/^calc\([^a-z%]*\)$/i.test(out)) return numbers ? out : null;
    return parseLength(v, CHECK) === null ? null : out;
  }
  return null;
}

/** A length's computed text: pixels where it is absolute or relative to
 *  the font, a percentage, and `calc()` of the two, as Chromium reads it. */
function lengthComputed(text: string, units: SvgUnits): string {
  if (text === 'auto' || text === 'none') return text;
  if (NUMBER.test(text)) return pxText(Number(text));
  const ctx: UnitContext = {
    em: units.em,
    rem: units.rem,
    vw: units.vw,
    vh: units.vh,
    scale: 1,
    ex: units.ex,
    ch: units.ch,
  };
  // a calculation with no unit in it is a number of pixels
  const plain = /^calc\(\s*([^a-z%()]*)\)$/i.exec(text);
  if (plain && NUMBER.test(plain[1].trim())) {
    return pxText(Number(plain[1].trim()));
  }
  const len = parseLength(text, ctx, true);
  if (typeof len === 'number') return pxText(len);
  if (len && typeof len === 'object' && !len.of) {
    const pct = `${numberText(len.pct)}%`;
    if (!len.px) return pct;
    const sign = len.px < 0 ? '-' : '+';
    return `calc(${pct} ${sign} ${pxText(Math.abs(len.px))})`;
  }
  return text;
}
/** A non-negative length is clamped where a calculation takes it under
 *  nought (CSS Values 4, 10.12). */
const clampedComputed = (text: string, units: SvgUnits): string => {
  const out = lengthComputed(text, units);
  return /^-[\d.]+px$/.test(out) ? '0px' : out;
};

/** One of a set of keywords, as written in lower case. */
const keyword =
  (...words: string[]) =>
  (value: string): string | null => {
    const v = value.trim().toLowerCase();
    return words.includes(v) ? v : null;
  };
const asIs = (specified: string): string => specified;

/** A `url()` as it computes: absolute, but for a fragment of the document's
 *  own, which stays one (CSS Values 4, 4.5.1). */
function urlComputed(specified: string, units: SvgUnits): string {
  const m = /^url\("((?:[^"\\]|\\.)*)"\)$/.exec(specified);
  if (!m || m[1].startsWith('#')) return specified;
  const url = units.url(m[1].replace(/\\(.)/g, '$1'));
  return `url("${url.replace(/(["\\])/g, '\\$1')}")`;
}
/** A `url()` as a declaration keeps one: quoted. */
function urlOf(value: string): string | null {
  const m = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]*))\s*\)$/i.exec(value);
  if (!m) return null;
  const url = m[1] ?? m[2] ?? m[3] ?? '';
  return `url("${url.replace(/(["\\])/g, '\\$1')}")`;
}
/** A value's parts: what is in parentheses stays together. */
function partsOf(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let word = '';
  for (const c of value.trim()) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (/\s/.test(c) && depth === 0) {
      if (word) out.push(word);
      word = '';
    } else word += c;
  }
  if (word) out.push(word);
  return out;
}

/** A `<paint>` (SVG 2, 13.2): `none`, a colour, `context-fill`,
 *  `context-stroke`, or a `url()` with a fallback of `none` or a colour. */
function paint(value: string): string | null {
  const parts = partsOf(value);
  if (parts.length === 1) {
    const word = parts[0].toLowerCase();
    if (
      word === 'none' ||
      word === 'context-fill' ||
      word === 'context-stroke'
    ) {
      return word;
    }
    return urlOf(parts[0]) ?? color(parts[0]);
  }
  if (parts.length === 2) {
    const url = urlOf(parts[0]);
    if (!url) return null;
    const fallback =
      parts[1].toLowerCase() === 'none' ? 'none' : color(parts[1]);
    return fallback ? `${url} ${fallback}` : null;
  }
  return null;
}
function paintComputed(specified: string, units: SvgUnits): string {
  const parts = partsOf(specified);
  const one = (part: string): string =>
    /^(none|context-fill|context-stroke)$/.test(part)
      ? part
      : part.startsWith('url(')
        ? urlComputed(part, units)
        : colorComputed(part, units);
  return parts.map(one).join(' ');
}
function colorComputed(value: string, units: SvgUnits): string {
  const parsed =
    value.toLowerCase() === 'currentcolor' ? units.color : parseColor(value);
  return parsed ? units.colorText(parsed) : value;
}
/** A `<color>` as a declaration keeps it, as Chromium does: a name as it
 *  is, in lower case, `currentcolor`, a hexadecimal colour as `rgb()`, and
 *  a function in its canonical form. */
function color(value: string): string | null {
  const v = value.trim();
  const word = v.toLowerCase();
  if (word === 'currentcolor') return 'currentcolor';
  if (/^[a-z-]+$/.test(word)) return parseColor(word) !== null ? word : null;
  // a hexadecimal colour and the legacy functions are `rgb()` (CSS Color 4,
  // 15.1), the rest canonical in their own form
  if (v.startsWith('#') || /^(?:rgba?|hsla?|hwb)\(/i.test(v)) {
    const rgba = parseColor(v) === null ? null : rgbaOf(v);
    if (!rgba) return null;
    const [r, g, b] = rgba.slice(0, 3).map((c) => Math.round(c * 255));
    const a = rgba[3];
    return a >= 1
      ? `rgb(${r}, ${g}, ${b})`
      : `rgba(${r}, ${g}, ${b}, ${numberText(Math.round(a * 1000) / 1000)})`;
  }
  return specifiedColorText(v) ?? (parseColor(v) !== null ? v : null);
}

/** A `<number>` or a `<percentage>` the opacities take (CSS Color 4,
 *  4.1), kept as a number: `50%` is `0.5`. */
function alpha(value: string): string | null {
  const v = value.trim();
  if (NUMBER.test(v)) return numberText(Number(v));
  const m = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)%$/i.exec(v);
  if (m) return numberText(Number(m[1]) / 100);
  if (MATH.test(v)) return serializeMath(v);
  return null;
}
const alphaComputed = (specified: string): string => {
  const plain = /^calc\((.*)\)$/i.exec(specified)?.[1] ?? specified;
  const n = Number(plain);
  return Number.isFinite(n)
    ? numberText(Math.min(1, Math.max(0, n)))
    : specified;
};

/** `paint-order` (SVG 2, 13.6), in its shortest form: what is left of the
 *  three after those written is in their usual order, so a word is left
 *  off where the order is that one. */
function paintOrder(value: string): string | null {
  const words = value.trim().toLowerCase().split(/\s+/);
  if (words.length === 1 && words[0] === 'normal') return 'normal';
  const all = ['fill', 'stroke', 'markers'];
  if (
    !words.length ||
    words.some((w) => !all.includes(w)) ||
    new Set(words).size !== words.length
  ) {
    return null;
  }
  const order = [...words, ...all.filter((w) => !words.includes(w))];
  // the order each word's absence would give, after the ones before it
  for (let n = 1; n <= 3; n += 1) {
    const head = order.slice(0, n);
    const rest = all.filter((w) => !head.includes(w));
    if (order.slice(n).join(' ') === rest.join(' ')) return head.join(' ');
  }
  return order.join(' ');
}

/** `stroke-dasharray` (SVG 2, 13.5.6): `none`, or lengths, percentages and
 *  numbers, kept apart by commas. */
function dashArray(value: string): string | null {
  const v = value.trim();
  if (v.toLowerCase() === 'none') return 'none';
  if (/,\s*$|^\s*,|,\s*,/.test(v)) return null;
  const items = partsOf(v.replace(/,/g, ' , ')).filter((part) => part !== ',');
  if (!items.length) return null;
  const out: string[] = [];
  for (const item of items) {
    const one = lengthPercentage(item, true, true);
    if (one === null) return null;
    out.push(one);
  }
  return out.join(', ');
}

const lengthProperty = (
  initial: string,
  inherited: boolean,
  opts: { positive?: boolean; auto?: boolean; numbers?: boolean } = {},
): SvgProperty => ({
  inherited,
  initial,
  specified: (value) => {
    if (opts.auto && value.trim().toLowerCase() === 'auto') return 'auto';
    return lengthPercentage(value, !!opts.numbers, !!opts.positive);
  },
  computed: opts.positive ? clampedComputed : lengthComputed,
  // an attribute takes a bare number for a length in user units
  attribute: (value) => {
    if (opts.auto && value.trim().toLowerCase() === 'auto') return 'auto';
    return lengthPercentage(value, true, !!opts.positive);
  },
});
const keywordProperty = (
  inherited: boolean,
  ...words: string[]
): SvgProperty => ({
  inherited,
  initial: words[0],
  specified: keyword(...words),
  computed: asIs,
});
const alphaProperty = (inherited: boolean): SvgProperty => ({
  inherited,
  initial: '1',
  specified: alpha,
  computed: alphaComputed,
});
const colorProperty = (initial: string, inherited: boolean): SvgProperty => ({
  inherited,
  initial,
  specified: color,
  computed: colorComputed,
});
const marker: SvgProperty = {
  inherited: true,
  initial: 'none',
  specified: (value) =>
    value.trim().toLowerCase() === 'none' ? 'none' : urlOf(value.trim()),
  computed: (specified, units) =>
    specified === 'none' ? 'none' : urlComputed(specified, units),
};

/** Each of SVG's properties this answers for, by name. */
export const SVG_PROPERTIES: Readonly<Record<string, SvgProperty>> = {
  fill: {
    inherited: true,
    initial: 'rgb(0, 0, 0)',
    specified: paint,
    computed: paintComputed,
  },
  'fill-opacity': alphaProperty(true),
  'fill-rule': keywordProperty(true, 'nonzero', 'evenodd'),
  stroke: {
    inherited: true,
    initial: 'none',
    specified: paint,
    computed: paintComputed,
  },
  'stroke-opacity': alphaProperty(true),
  'stroke-width': {
    ...lengthProperty('1px', true, { numbers: true, positive: true }),
  },
  'stroke-linecap': keywordProperty(true, 'butt', 'round', 'square'),
  'stroke-linejoin': keywordProperty(
    true,
    'miter',
    'miter-clip',
    'round',
    'bevel',
    'arcs',
  ),
  'stroke-miterlimit': {
    inherited: true,
    initial: '4',
    specified: (value) => {
      const v = value.trim();
      if (NUMBER.test(v)) return Number(v) < 0 ? null : numberText(Number(v));
      return MATH.test(v) ? serializeMath(v) : null;
    },
    computed: asIs,
  },
  'stroke-dasharray': {
    inherited: true,
    initial: 'none',
    specified: dashArray,
    computed: (specified, units) =>
      specified === 'none'
        ? 'none'
        : specified
            .split(', ')
            .map((item) => clampedComputed(item, units))
            .join(', '),
  },
  'stroke-dashoffset': lengthProperty('0px', true, { numbers: true }),
  'paint-order': {
    inherited: true,
    initial: 'normal',
    specified: paintOrder,
    computed: asIs,
  },
  'marker-start': marker,
  'marker-mid': marker,
  'marker-end': marker,
  'stop-color': colorProperty('rgb(0, 0, 0)', false),
  'stop-opacity': alphaProperty(false),
  'flood-color': colorProperty('rgb(0, 0, 0)', false),
  'flood-opacity': alphaProperty(false),
  'lighting-color': colorProperty('rgb(255, 255, 255)', false),
  'clip-rule': keywordProperty(true, 'nonzero', 'evenodd'),
  'color-interpolation': keywordProperty(true, 'srgb', 'auto', 'linearrgb'),
  'color-interpolation-filters': keywordProperty(
    true,
    'linearrgb',
    'auto',
    'srgb',
  ),
  'shape-rendering': keywordProperty(
    true,
    'auto',
    'optimizespeed',
    'crispedges',
    'geometricprecision',
  ),
  'text-rendering': keywordProperty(
    true,
    'auto',
    'optimizespeed',
    'optimizelegibility',
    'geometricprecision',
  ),
  'image-rendering': keywordProperty(
    true,
    'auto',
    'optimizespeed',
    'optimizequality',
    'smooth',
    'high-quality',
    'crisp-edges',
    'pixelated',
  ),
  'text-anchor': keywordProperty(true, 'start', 'middle', 'end'),
  'dominant-baseline': keywordProperty(
    true,
    'auto',
    'text-bottom',
    'alphabetic',
    'ideographic',
    'middle',
    'central',
    'mathematical',
    'hanging',
    'text-top',
  ),
  'alignment-baseline': keywordProperty(
    false,
    'baseline',
    'text-bottom',
    'alphabetic',
    'ideographic',
    'middle',
    'central',
    'mathematical',
    'text-top',
  ),
  'vector-effect': keywordProperty(false, 'none', 'non-scaling-stroke'),
  'mask-type': keywordProperty(false, 'luminance', 'alpha'),
  'buffered-rendering': keywordProperty(true, 'auto', 'dynamic', 'static'),
  cx: lengthProperty('0px', false),
  cy: lengthProperty('0px', false),
  x: lengthProperty('0px', false),
  y: lengthProperty('0px', false),
  r: lengthProperty('0px', false, { positive: true }),
  rx: lengthProperty('auto', false, { positive: true, auto: true }),
  ry: lengthProperty('auto', false, { positive: true, auto: true }),
  // a path's geometry (SVG 2, 9.3.2): `path()` of the data, as Chromium
  // writes it, a command and each of its numbers apart by a space
  d: {
    inherited: false,
    initial: 'none',
    specified(value) {
      const v = value.trim();
      if (/^none$/i.test(v)) return 'none';
      const m = /^path\(\s*(["'])([^]*)\1\s*\)$/i.exec(v);
      if (!m) return null;
      const text = pathDataText(m[2], false);
      return text === null ? null : text ? `path("${text}")` : 'none';
    },
    computed: (specified) => specified,
    attribute(value) {
      // what is path data up to its first error is drawn (SVG 2, 9.5.4)
      const text = pathDataText(value, true);
      return text ? `path("${text}")` : 'none';
    },
  },
};

/** How many numbers each path command takes. */
const PATH_ARGS: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};
const PATH_NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
/** Path data written as Chromium writes a computed `d`: every command
 *  spelled out, a repeated one too, `Z` for either close, and numbers to six
 *  figures. Null where it is not path data, or, with `prefix`, the data up
 *  to the first error. */
export function pathDataText(text: string, prefix: boolean): string | null {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  const space = (): void => {
    while (i < n && /[\s,]/.test(text[i])) i++;
  };
  const read = (flag: boolean): number | null => {
    space();
    if (flag) {
      if (text[i] === '0' || text[i] === '1') return +text[i++];
      return null;
    }
    PATH_NUMBER.lastIndex = i;
    const m = PATH_NUMBER.exec(text);
    if (!m) return null;
    i += m[0].length;
    return +m[0];
  };
  const fail = (): string | null => (prefix ? out.join(' ') : null);
  space();
  let cmd = '';
  while (i < n) {
    const ch = text[i];
    if (/[A-Za-z]/.test(ch)) {
      if (!(ch.toUpperCase() in PATH_ARGS)) return fail();
      if (!out.length && ch !== 'M' && ch !== 'm') return fail();
      cmd = ch;
      i++;
    } else if (!cmd || cmd === 'Z' || cmd === 'z') return fail();
    const up = cmd.toUpperCase();
    const args: string[] = [];
    for (let k = 0; k < PATH_ARGS[up]; k++) {
      const v = read(up === 'A' && (k === 3 || k === 4));
      if (v === null) return fail();
      args.push(numberText(v));
    }
    out.push(up === 'Z' ? 'Z' : [cmd, ...args].join(' '));
    if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    space();
  }
  return out.join(' ');
}

/** Which of the geometry properties an element's attribute stands for
 *  (SVG 2, 9.4): `cx` on a circle or an ellipse, `x` on a rectangle, an
 *  image, a `<foreignObject>`, an `<svg>` or a `<use>`. */
const GEOMETRY_ON: Record<string, ReadonlySet<string>> = {
  cx: new Set(['circle', 'ellipse']),
  cy: new Set(['circle', 'ellipse']),
  r: new Set(['circle']),
  rx: new Set(['rect', 'ellipse']),
  ry: new Set(['rect', 'ellipse']),
  x: new Set(['rect', 'image', 'foreignobject', 'svg', 'use', 'symbol']),
  y: new Set(['rect', 'image', 'foreignobject', 'svg', 'use', 'symbol']),
  d: new Set(['path']),
};

/** Whether an SVG element's attribute of a property's name is a
 *  declaration of it: every presentation attribute but the geometry
 *  properties', which are each on the elements they size. */
export function presentsProperty(tag: string, prop: string): boolean {
  const on = GEOMETRY_ON[prop];
  return on ? on.has(tag.toLowerCase()) : prop in SVG_PROPERTIES;
}

/** The `marker` shorthand's three, each its value. */
export const MARKER_LONGHANDS = ['marker-start', 'marker-mid', 'marker-end'];
