// The borders' properties as `el.style` keeps them (CSS Backgrounds 3, 3 and
// 5; CSSOM 6.7): each longhand's value in its canonical form, or none for
// what is no value of it; each shorthand — `border`, a side's, `border-width`,
// `border-style`, `border-color` and `border-radius` — set as its longhands,
// and read back from them as short as they go. And `background-color`, which
// is a colour as a border's is.

import { rgbaOf, specifiedColorText } from './color.js';
import { serializeMath } from './calc-tree.js';
import { parseLength, splitValue } from './values.js';
import type { UnitContext } from './values.js';

/** What a value is read against where it is only checked. */
const CHECK: UnitContext = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };
const CSS_WIDE = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const MATH = /^(?:calc|min|max|clamp|round|mod|rem|abs|sign)\(/i;
const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const STYLES = new Set([
  'none',
  'hidden',
  'dotted',
  'dashed',
  'solid',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]);
const DIMENSION = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-z]+)?$/i;

/** A number as CSS writes one. */
const num = (n: number): string => {
  const r = Number(n.toPrecision(6));
  return Object.is(r, -0) ? '0' : String(r);
};

/** A colour in sRGB's legacy form, as Chrome keeps a hex and an `rgb()`
 *  or an `hsl()` of either syntax: its alpha to the eighth bit. */
function legacyText(rgba: readonly number[]): string {
  const [r, g, b] = rgba.slice(0, 3).map((c) => Math.round(c * 255));
  const a = rgba[3];
  if (a >= 1) return `rgb(${r}, ${g}, ${b})`;
  const byte = Math.round(a * 255);
  let text = String(Math.round((byte / 255) * 100) / 100);
  if (Math.round(Number(text) * 255) !== byte)
    text = String(Math.round((byte / 255) * 1000) / 1000);
  return `rgba(${r}, ${g}, ${b}, ${text})`;
}
const COLOR_FUNCTIONS = new Set([
  'color',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'hwb',
  'color-mix',
  'light-dark',
  'contrast-color',
  'device-cmyk',
]);
const LEGACY = /^(?:rgba?|hsla?)\(/i;

/** A colour as `el.style` keeps it: a keyword in lower case, a hex as the
 *  `rgb()` it is, a function in its canonical form; null for none. */
export function colorSpecified(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^[a-z]+$/i.test(v)) {
    const lower = v.toLowerCase();
    if (lower === 'currentcolor' || lower === 'transparent') return lower;
    return rgbaOf(lower) ? lower : null;
  }
  if (v[0] === '#' || LEGACY.test(v)) {
    const rgba = rgbaOf(v);
    if (!rgba) return null;
    return legacyText(rgba);
  }
  if (!v.endsWith(')')) return null;
  const canonical = specifiedColorText(v);
  if (canonical) return canonical;
  // a colour function this reads no canonical form of is kept as written:
  // a relative colour, a mix, `light-dark()`, `contrast-color()`
  const fn = /^([a-z-]+)\(/i.exec(v)?.[1].toLowerCase();
  return fn && COLOR_FUNCTIONS.has(fn) ? v : null;
}

/** A length not below nought, as kept: `0` is `0px`; null for none. With
 *  `percent`, a percentage too. */
function lengthSpecified(token: string, percent: boolean): string | null {
  const t = token.trim();
  if (MATH.test(t)) {
    const v = parseLength(t, CHECK);
    if (v === null || v === 'auto') return null;
    if (!percent && typeof v === 'object') return null;
    return serializeMath(t) ?? null;
  }
  const m = DIMENSION.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 0) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (!unit) return n === 0 ? '0px' : null;
  if (unit === '%') return percent ? `${num(n)}%` : null;
  if (parseLength(`1${unit}`, CHECK) === null) return null;
  return num(n) + unit;
}

/** A `<line-width>` (3.2, and CSS Borders 4's `hairline`): a keyword or a
 *  length not below nought. */
function widthSpecified(token: string): string | null {
  const w = token.trim().toLowerCase();
  if (w === 'thin' || w === 'medium' || w === 'thick' || w === 'hairline')
    return w;
  return lengthSpecified(token, false);
}
const styleSpecified = (token: string): string | null => {
  const w = token.trim().toLowerCase();
  return STYLES.has(w) ? w : null;
};

/** One to four values of a box's sides, each read by `read`. */
function sidesOf(
  value: string,
  read: (t: string) => string | null,
): string[] | null {
  const words = splitValue(value.trim()).filter(Boolean);
  if (!words.length || words.length > 4) return null;
  const v = words.map(read);
  if (v.some((w) => w === null)) return null;
  const [t, r = t, b = t, l = r] = v as string[];
  return [t, r, b, l];
}
/** Four sides as few as say them (CSSOM's shortest serialization). */
function shortest(v: readonly string[]): string {
  const [t, r, b, l] = v;
  if (l !== r) return `${t} ${r} ${b} ${l}`;
  if (b !== t) return `${t} ${r} ${b}`;
  if (r !== t) return `${t} ${r}`;
  return t;
}

/** `border` or a side's: a width, a style and a colour in any order, each
 *  once, each left at its initial value where it is not said. */
function lineOf(value: string): [string, string, string] | null {
  const words = splitValue(value.trim()).filter(Boolean);
  if (!words.length || words.length > 3) return null;
  let width: string | null = null;
  let style: string | null = null;
  let color: string | null = null;
  for (const w of words) {
    const s: string | null = style === null ? styleSpecified(w) : null;
    if (s !== null) {
      style = s;
      continue;
    }
    const wd: string | null = width === null ? widthSpecified(w) : null;
    if (wd !== null) {
      width = wd;
      continue;
    }
    const c: string | null = color === null ? colorSpecified(w) : null;
    if (c !== null) {
      color = c;
      continue;
    }
    return null;
  }
  return [width ?? 'medium', style ?? 'none', color ?? 'currentcolor'];
}
const lineText = ([w, s, c]: readonly string[]): string => {
  const parts = [
    w === 'medium' ? '' : w,
    s === 'none' ? '' : s,
    c === 'currentcolor' ? '' : c,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : 'medium';
};

/** A corner's radius (5.1): one or two length-percentages, not below
 *  nought, the second the first where it is left out. */
function cornerOf(value: string): [string, string] | null {
  const words = splitValue(value.trim()).filter(Boolean);
  if (!words.length || words.length > 2) return null;
  const v = words.map((w) => lengthSpecified(w, true));
  if (v.some((w) => w === null)) return null;
  return [v[0]!, v[1] ?? v[0]!];
}
const cornerText = ([h, v]: readonly string[]): string =>
  h === v ? h : `${h} ${v}`;
/** `border-radius`: up to four across, then `/` and up to four down. */
function radiiOf(value: string): [string[], string[]] | null {
  const words = splitValue(value.trim()).filter(Boolean);
  const slash = words.indexOf('/');
  if (slash >= 0 && words.indexOf('/', slash + 1) >= 0) return null;
  const across = slash < 0 ? words : words.slice(0, slash);
  const down = slash < 0 ? across : words.slice(slash + 1);
  const four = (part: string[]): string[] | null => {
    if (!part.length || part.length > 4) return null;
    const v = part.map((w) => lengthSpecified(w, true));
    if (v.some((w) => w === null)) return null;
    const [a, b = a, c = a, d = b] = v as string[];
    return [a, b, c, d];
  };
  const h = four(across);
  const v = four(down);
  return h && v ? [h, v] : null;
}

/** A colour longhand: as `colorSpecified` has it, but undefined — kept as
 *  written — for a colour function it reads no canonical form of. */
function colorLonghand(value: string): string | null | undefined {
  const c = colorSpecified(value);
  return c !== null &&
    c === value &&
    c.includes('(') &&
    !LEGACY.test(c) &&
    !specifiedColorText(c)
    ? undefined
    : c;
}

const LONGHAND = /^border-(top|right|bottom|left)-(width|style|color)$/;
const CORNER = /^border-(top|bottom)-(left|right)-radius$/;

/** A border property as `el.style` keeps it; undefined for a name this is
 *  not, or a value every property takes. */
export function borderSpecified(
  name: string,
  value: string,
): string | null | undefined {
  const v = value.trim();
  if (CSS_WIDE.test(v)) return undefined;
  if (name === 'background-color') return colorLonghand(v);
  const long = LONGHAND.exec(name);
  if (long) {
    if (splitValue(v).filter(Boolean).length !== 1) return null;
    return long[2] === 'width'
      ? widthSpecified(v)
      : long[2] === 'style'
        ? styleSpecified(v)
        : colorLonghand(v);
  }
  if (CORNER.test(name)) {
    const c = cornerOf(v);
    return c && cornerText(c);
  }
  switch (name) {
    case 'border-width': {
      const s = sidesOf(v, widthSpecified);
      return s && shortest(s);
    }
    case 'border-style': {
      const s = sidesOf(v, styleSpecified);
      return s && shortest(s);
    }
    case 'border-color': {
      const s = sidesOf(v, colorSpecified);
      return s && shortest(s);
    }
    case 'border':
    case 'border-top':
    case 'border-right':
    case 'border-bottom':
    case 'border-left': {
      const l = lineOf(v);
      return l && lineText(l);
    }
    case 'border-radius':
    case '-webkit-border-radius': {
      // `-webkit-border-radius: 1px 2px` is a corner of both, as it was
      const r =
        name === '-webkit-border-radius' &&
        !v.includes('/') &&
        splitValue(v).filter(Boolean).length === 2
          ? radiiOf(splitValue(v).filter(Boolean).join(' / '))
          : radiiOf(v);
      if (!r) return null;
      const h = shortest(r[0]);
      const d = shortest(r[1]);
      return h === d ? h : `${h} / ${d}`;
    }
  }
  return undefined;
}

/** The border-image longhands `border` sets back to their initial
 *  values (3.6). */
const IMAGE_RESET: [string, string][] = [
  ['border-image-source', 'none'],
  ['border-image-slice', '100%'],
  ['border-image-width', '1'],
  ['border-image-outset', '0'],
  ['border-image-repeat', 'stretch'],
];

/** A border shorthand's longhands, from its canonical value; null for a
 *  name this does not expand. */
export function borderLonghands(
  name: string,
  value: string,
): [string, string][] | null {
  const out = longhandsOf(name, value);
  if (out || !SHORTHANDS.has(name)) return out;
  // what it would set, for a value it does not take: the names a
  // declaration of it replaces
  return namesOf(name).map((n) => [n, value]);
}
/** A border shorthand's longhands, in the order it sets them. */
function namesOf(name: string): string[] {
  const sides = (kind: string): string[] =>
    SIDES.map((side) => `border-${side}-${kind}`);
  switch (name) {
    case 'border':
      return [
        ...sides('width'),
        ...sides('style'),
        ...sides('color'),
        ...IMAGE_RESET.map(([n]) => n),
      ];
    case 'border-width':
    case 'border-style':
    case 'border-color':
      return sides(name.slice(7));
    case 'border-radius':
    case '-webkit-border-radius':
      return CORNERS.map((c) => `border-${c}-radius`);
    case 'border-image':
      return IMAGE_RESET.map(([n]) => n);
  }
  return ['width', 'style', 'color'].map((k) => `${name}-${k}`);
}
const SHORTHANDS = new Set([
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-width',
  'border-style',
  'border-color',
  'border-radius',
  '-webkit-border-radius',
]);
function longhandsOf(name: string, value: string): [string, string][] | null {
  const four = (
    kind: string,
    read: (t: string) => string | null,
  ): [string, string][] | null => {
    const s = sidesOf(value, read);
    return s && SIDES.map((side, i) => [`border-${side}-${kind}`, s[i]]);
  };
  switch (name) {
    case 'border-width':
      return four('width', widthSpecified);
    case 'border-style':
      return four('style', styleSpecified);
    case 'border-color':
      return four('color', colorSpecified);
    case 'border': {
      const l = lineOf(value);
      if (!l) return null;
      const out: [string, string][] = [];
      for (const [k, kind] of ['width', 'style', 'color'].entries()) {
        for (const side of SIDES) out.push([`border-${side}-${kind}`, l[k]]);
      }
      return [...out, ...IMAGE_RESET];
    }
    case 'border-top':
    case 'border-right':
    case 'border-bottom':
    case 'border-left': {
      const l = lineOf(value);
      return (
        l && [
          [`${name}-width`, l[0]],
          [`${name}-style`, l[1]],
          [`${name}-color`, l[2]],
        ]
      );
    }
    case 'border-radius':
    case '-webkit-border-radius': {
      const canonical = borderSpecified(name, value);
      if (!canonical) return null;
      const r = radiiOf(canonical);
      return (
        r &&
        CORNERS.map((c, i) => [
          `border-${c}-radius`,
          cornerText([r[0][i], r[1][i]]),
        ])
      );
    }
  }
  return null;
}

/** A border shorthand read back from its longhands, '' where they make
 *  none; null for a name this does not compose. */
export function borderComposed(
  name: string,
  longhand: (name: string) => string | null,
): string | null {
  const names = LONGHANDS_OF[name];
  if (!names) return null;
  // a keyword every property takes is the shorthand's only where every
  // longhand has it, and a value still to be substituted is none of it
  const values = names.map(longhand);
  const wide = values.filter(
    (v) => v !== null && (CSS_WIDE.test(v) || /\b(?:var|env|attr)\(/i.test(v)),
  );
  if (wide.length) {
    return wide.length === names.length &&
      values.every((v) => v === values[0]) &&
      CSS_WIDE.test(values[0]!)
      ? values[0]!
      : '';
  }
  return composed(name, longhand);
}

function composed(
  name: string,
  longhand: (name: string) => string | null,
): string {
  const four = (kind: string): string[] | null => {
    const v = SIDES.map((side) => longhand(`border-${side}-${kind}`));
    return v.some((x) => x === null) ? null : (v as string[]);
  };
  switch (name) {
    case 'border-width':
    case 'border-style':
    case 'border-color': {
      const v = four(name.slice(7));
      return v ? shortest(v) : '';
    }
    case 'border-top':
    case 'border-right':
    case 'border-bottom':
    case 'border-left': {
      const v = ['width', 'style', 'color'].map((k) =>
        longhand(`${name}-${k}`),
      );
      return v.some((x) => x === null) ? '' : lineText(v as string[]);
    }
    case 'border': {
      const sides = ['width', 'style', 'color'].map((k) => four(k));
      if (sides.some((s) => !s || s.some((x) => x !== s[0]))) return '';
      // the image is no part of what `border` can say otherwise
      for (const [n, v] of IMAGE_RESET) {
        const own = longhand(n);
        if (own !== null && own !== v) return '';
      }
      return lineText(sides.map((s) => s![0]));
    }
    case 'border-radius':
    case '-webkit-border-radius': {
      const corners = CORNERS.map((c) => longhand(`border-${c}-radius`));
      if (corners.some((c) => c === null)) return '';
      const pairs = corners.map((c) => {
        const [h, v = h] = splitValue(c!).filter(Boolean);
        return [h, v];
      });
      const h = shortest(pairs.map((p) => p[0]));
      const d = shortest(pairs.map((p) => p[1]));
      return h === d ? h : `${h} / ${d}`;
    }
    case 'border-image': {
      // only all of it at its initial values says itself shortly
      const all = IMAGE_RESET.every(([n, v]) => longhand(n) === v);
      return all ? 'none' : '';
    }
  }
  return '';
}

/** Each border shorthand's longhands, in the order it sets them. */
const LONGHANDS_OF: Record<string, readonly string[]> = Object.fromEntries(
  [...SHORTHANDS, 'border-image'].map((name) => [name, namesOf(name)]),
);

/** Shorthands in CSSOM's preferred order: those of more longhands first,
 *  then by name, a prefixed one last. */
const PREFERRED = Object.keys(LONGHANDS_OF).sort((a, b) => {
  const d = LONGHANDS_OF[b].length - LONGHANDS_OF[a].length;
  if (d) return d;
  if (a.startsWith('-') !== b.startsWith('-'))
    return a.startsWith('-') ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
});

/**
 * A declaration block's border longhands as the shorthands they make
 * (CSSOM 6.7.2, "serialize a CSS declaration block"): at the place of the
 * first longhand of a shorthand every one of whose longhands the block
 * declares, of one priority, and which composes, the shorthand, and the
 * longhands it says no more.
 */
export function collapseBorders<
  D extends { prop: string; value: string; important: boolean },
>(
  declarations: readonly D[],
): (D | { prop: string; value: string; important: boolean })[] {
  if (!declarations.some((d) => d.prop.startsWith('border-')))
    return declarations as D[];
  const last = new Map<string, D>();
  for (const d of declarations) last.set(d.prop, d);
  const done = new Set<string>();
  const out: (D | { prop: string; value: string; important: boolean })[] = [];
  for (const d of declarations) {
    if (done.has(d.prop)) continue;
    if (last.get(d.prop) !== d) continue;
    let placed = false;
    for (const name of PREFERRED) {
      const names = LONGHANDS_OF[name];
      if (!names.includes(d.prop)) continue;
      if (names.some((n) => !last.has(n) || done.has(n))) continue;
      const important = d.important;
      if (names.some((n) => last.get(n)!.important !== important)) continue;
      const value = borderComposed(name, (n) => last.get(n)?.value ?? null);
      if (!value) continue;
      out.push({ prop: name, value, important });
      for (const n of names) done.add(n);
      placed = true;
      break;
    }
    if (!placed) {
      out.push(d);
      done.add(d.prop);
    }
  }
  return out;
}

/** A declaration of a border shorthand as the longhands it sets; null for
 *  any other, and for a value the shorthand does not take or that is no
 *  value yet. */
export function borderDeclared(
  name: string,
  value: string,
): [string, string][] | null {
  const prop = name.toLowerCase();
  if (!SHORTHANDS.has(prop) && prop !== 'border-image') return null;
  if (/\b(?:var|env|attr)\(/i.test(value)) return null;
  const v = value.trim();
  if (CSS_WIDE.test(v)) return namesOf(prop).map((n) => [n, v.toLowerCase()]);
  // `border-image` is read as its longhands only where `cssText` wrote it
  if (prop === 'border-image')
    return v.toLowerCase() === 'none' ? IMAGE_RESET : null;
  const canonical = borderSpecified(prop, v);
  return canonical ? borderLonghands(prop, canonical) : null;
}
