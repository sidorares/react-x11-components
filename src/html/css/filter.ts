// `filter` (CSS Filter Effects 1): its functions as computed, the colour
// matrices the colour functions come to, how two lists interpolate, and the
// pass that runs the matrices over a group's pixels.
//
// The colour functions are what a page writes most — a logo `grayscale()`
// until it is hovered, a dark theme's `invert(1) hue-rotate(180deg)` — and
// each is a matrix over straight RGB with an offset, which leaves alpha as
// it is (13, "Shorthands defined in terms of SVG filter primitives"):
// `feColorMatrix`'s `saturate` and `hueRotate`, the matrices `grayscale()`
// and `sepia()` spell out, and `feComponentTransfer`'s `linear` for
// `brightness()`, `contrast()` and `invert()`. `opacity()` is the one that
// changes alpha, and a scale of it commutes with every other function here,
// so it is taken out and multiplied into the group's opacity
// (`colourFilter`). `blur()` and `drop-shadow()` are read and computed, so a
// list with them in it interpolates and makes the box what any filter
// makes it, and are not drawn yet.

import { parseAngle, parseFactor } from './transform.js';
import { parseColor, parseLength } from './values.js';
import type { UnitContext } from './values.js';
import { splitValue } from './values.js';

/** A function of a `filter` list, as computed: an amount a number (a
 *  percentage as its fraction), a turn in degrees, and lengths in device
 *  pixels. */
export type FilterFunction =
  | {
      fn:
        | 'brightness'
        | 'contrast'
        | 'grayscale'
        | 'invert'
        | 'opacity'
        | 'saturate'
        | 'sepia';
      amount: number;
    }
  | { fn: 'hue-rotate'; angle: number }
  | { fn: 'blur'; radius: number }
  | {
      fn: 'drop-shadow';
      x: number;
      y: number;
      blur: number;
      /** A colour as `parseColor` leaves it, `currentColor` included. */
      color: string;
    }
  /** A reference to an SVG `<filter>`, which nothing here draws. */
  | { fn: 'url'; url: string };

/** What an amount is with none written: what leaves the image as it is,
 *  but for the four whose argument says how much of the effect to take,
 *  which take all of it (Filter Effects 1, 13). */
const DEFAULT_AMOUNT: Record<string, number> = {
  brightness: 1,
  contrast: 1,
  grayscale: 1,
  invert: 1,
  opacity: 1,
  saturate: 1,
  sepia: 1,
};

/**
 * A `filter`'s value: its functions in the order written, null for `none`,
 * and undefined for what is no filter list, which drops the declaration. A
 * list whose `var()`s were all empty — Tailwind's `filter: var(--tw-blur,)
 * var(--tw-brightness,) …` with none of them set — is no list.
 */
export function parseFilter(
  value: string,
  ctx: UnitContext,
): FilterFunction[] | null | undefined {
  const v = value.trim();
  if (v.toLowerCase() === 'none') return null;
  const parts = splitValue(v);
  if (!parts.length) return undefined;
  const out: FilterFunction[] = [];
  for (const part of parts) {
    const fn = filterFunction(part.trim(), ctx);
    if (!fn) return undefined;
    out.push(fn);
  }
  return out;
}

function filterFunction(
  part: string,
  ctx: UnitContext,
): FilterFunction | undefined {
  const url = /^url\(\s*(['"]?)(.*?)\1\s*\)$/is.exec(part);
  if (url) return { fn: 'url', url: url[2] };
  const m = /^([a-z-]+)\((.*)\)$/is.exec(part);
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  const arg = m[2].trim();
  if (name in DEFAULT_AMOUNT) {
    if (!arg) return { fn: name as 'grayscale', amount: DEFAULT_AMOUNT[name] };
    const amount = parseFactor(arg);
    // none of them takes a negative amount
    if (amount === null || amount < 0) return undefined;
    return { fn: name as 'grayscale', amount };
  }
  switch (name) {
    case 'hue-rotate': {
      if (!arg) return { fn: 'hue-rotate', angle: 0 };
      const angle = parseAngle(arg);
      return angle === null ? undefined : { fn: 'hue-rotate', angle };
    }
    case 'blur': {
      if (!arg) return { fn: 'blur', radius: 0 };
      const radius = parseLength(arg, ctx);
      // a length, and not a percentage of anything
      if (typeof radius !== 'number' || radius < 0) return undefined;
      return { fn: 'blur', radius };
    }
    case 'drop-shadow':
      return dropShadow(arg, ctx);
  }
  return undefined;
}

/** `drop-shadow()`'s argument: a colour, before or after two or three
 *  lengths written together — the offset across, down and a blur that is
 *  not negative — and no spread, which a shadow of an image's alpha does
 *  not have (Filter Effects 1, 13). */
function dropShadow(arg: string, ctx: UnitContext): FilterFunction | undefined {
  let color: string | null = null;
  const lengths: number[] = [];
  let closed = false;
  for (const token of splitValue(arg)) {
    const len = parseLength(token, ctx);
    if (typeof len === 'number') {
      if (closed || lengths.length === 3) return undefined;
      lengths.push(len);
      continue;
    }
    const c = parseColor(token);
    if (c === null || color !== null) return undefined;
    color = c;
    closed = lengths.length > 0;
  }
  if (lengths.length < 2) return undefined;
  const [x, y, blur = 0] = lengths;
  if (blur < 0) return undefined;
  return { fn: 'drop-shadow', x, y, blur, color: color ?? 'currentColor' };
}

/**
 * What a function is at nothing — its "initial value for interpolation"
 * (Filter Effects 1, 10.4): the function that leaves the image as it is,
 * which `none` at one end of an interpolation is a list of, and a shorter
 * list is filled out with.
 */
function atNothing(f: FilterFunction): FilterFunction {
  switch (f.fn) {
    case 'hue-rotate':
      return { fn: 'hue-rotate', angle: 0 };
    case 'blur':
      return { fn: 'blur', radius: 0 };
    case 'drop-shadow':
      return { fn: 'drop-shadow', x: 0, y: 0, blur: 0, color: 'transparent' };
    case 'url':
      return f;
    case 'grayscale':
    case 'invert':
    case 'sepia':
      return { fn: f.fn, amount: 0 };
    default:
      return { fn: f.fn, amount: 1 };
  }
}

/**
 * The list `q` of the way from `a` to `b` (Filter Effects 1, 10.4): function
 * by function where the two are alike in the order they are written, the
 * shorter filled out with the longer's functions at nothing, and `none` a
 * list of the other's at nothing. Undefined where they are not alike, or
 * either refers to a `<filter>`, and the property goes over at half-way.
 * `mix` is the interpolation of one function's fields, a colour's among
 * them, which is the caller's.
 */
export function interpolateFilters(
  a: readonly FilterFunction[] | null,
  b: readonly FilterFunction[] | null,
  q: number,
  mix: (x: unknown, y: unknown, q: number) => unknown,
): FilterFunction[] | null | undefined {
  if (!a && !b) return null;
  const from = a ?? [];
  const to = b ?? [];
  const n = Math.max(from.length, to.length);
  const out: FilterFunction[] = [];
  for (let i = 0; i < n; i += 1) {
    const x = from[i] ?? atNothing(to[i]);
    const y = to[i] ?? atNothing(from[i]);
    if (x.fn !== y.fn || x.fn === 'url') return undefined;
    const value = mix(x, y, q);
    if (value === undefined) return undefined;
    out.push(value as FilterFunction);
  }
  return out;
}

/** A colour function as a matrix over straight RGB in 0–255: three rows,
 *  each the weights of red, green and blue and an offset. Alpha is left
 *  as it is. */
export type ColourMatrix = Float64Array;

/** What a `filter` list does that a colour pass can do: its colour
 *  matrices in the order written, each one's result clamped before the
 *  next, as each function's is; and what alpha is multiplied by. */
export interface ColourFilter {
  matrices: ColourMatrix[];
  /** What two filters with one key do the same (`matricesKey`). */
  key: string;
  alpha: number;
  /** Whether the list has a function the pass does not do — `blur()`,
   *  `drop-shadow()`, a `url()` — which is drawn as though it were not
   *  there. */
  partial: boolean;
}

/** The colour functions of a `filter` list (`ColourFilter`); null where
 *  there are none and alpha is left as it is, and only what the colour
 *  functions leave as they are is in the list. */
export function colourFilter(
  list: readonly FilterFunction[] | null,
): ColourFilter | null {
  if (!list) return null;
  const matrices: ColourMatrix[] = [];
  let alpha = 1;
  let partial = false;
  for (const f of list) {
    if (f.fn === 'url') {
      // a reference to a `<filter>` that is not there has the whole list
      // ignored (Filter Effects 1, 4), and nothing here draws one
      return null;
    }
    if (f.fn === 'opacity') {
      alpha *= unit(f.amount);
      continue;
    }
    if (f.fn === 'blur' || f.fn === 'drop-shadow') {
      partial = true;
      continue;
    }
    const m = matrixOf(f);
    if (m) matrices.push(m);
  }
  if (!matrices.length && alpha === 1) return null;
  return { matrices, key: matricesKey(matrices), alpha, partial };
}

/** One colour function's matrix, null where it leaves every colour as it
 *  is (Filter Effects 1, 13). */
function matrixOf(f: FilterFunction): ColourMatrix | null {
  switch (f.fn) {
    case 'grayscale': {
      const a = unit(f.amount);
      if (a === 0) return null;
      const k = 1 - a;
      return rows(
        [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k],
        [0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k],
        [0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k],
      );
    }
    case 'sepia': {
      const a = unit(f.amount);
      if (a === 0) return null;
      const k = 1 - a;
      return rows(
        [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k],
        [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k],
        [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k],
      );
    }
    case 'saturate': {
      const s = Math.max(0, f.amount);
      if (s === 1) return null;
      return rows(
        [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
      );
    }
    case 'hue-rotate': {
      if (f.angle % 360 === 0) return null;
      const t = (f.angle * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      return rows(
        [
          0.213 + c * 0.787 - s * 0.213,
          0.715 - c * 0.715 - s * 0.715,
          0.072 - c * 0.072 + s * 0.928,
        ],
        [
          0.213 - c * 0.213 + s * 0.143,
          0.715 + c * 0.285 + s * 0.14,
          0.072 - c * 0.072 - s * 0.283,
        ],
        [
          0.213 - c * 0.213 - s * 0.787,
          0.715 - c * 0.715 + s * 0.715,
          0.072 + c * 0.928 + s * 0.072,
        ],
      );
    }
    // `feComponentTransfer`'s `linear`: each channel times a slope, plus
    // an intercept
    case 'brightness': {
      const b = Math.max(0, f.amount);
      return b === 1 ? null : linear(b, 0);
    }
    case 'contrast': {
      const c = Math.max(0, f.amount);
      return c === 1 ? null : linear(c, 0.5 - 0.5 * c);
    }
    case 'invert': {
      const a = unit(f.amount);
      return a === 0 ? null : linear(1 - 2 * a, a);
    }
  }
  return null;
}

/** An amount that is a share of the effect: more than all of it is all of
 *  it (Filter Effects 1, 13), and an easing that overshoots below none of
 *  it is none. */
function unit(amount: number): number {
  return amount < 0 ? 0 : amount > 1 ? 1 : amount;
}

function rows(r: number[], g: number[], b: number[]): ColourMatrix {
  return Float64Array.of(...r, 0, ...g, 0, ...b, 0);
}

/** A slope and an intercept, the intercept a fraction of full. */
function linear(slope: number, intercept: number): ColourMatrix {
  const at = intercept * 255;
  return Float64Array.of(slope, 0, 0, at, 0, slope, 0, at, 0, 0, slope, at);
}

/** A key for a list of matrices: two lists with one key do the same. */
export function matricesKey(matrices: readonly ColourMatrix[]): string {
  let key = '';
  for (const m of matrices) key += `${m.join(',')};`;
  return key;
}

/**
 * The matrices run over straight RGBA pixels, `src` into `dst` — the two
 * the same length, and as `getImageData` hands them over and
 * `putImageData` takes them — each function's result clamped to what a
 * channel holds before the next, as Filter Effects 1 has it. A pixel with
 * no alpha is left with none: its colour is no colour.
 */
export function applyMatrices(
  src: Uint8ClampedArray | Uint8Array,
  dst: Uint8ClampedArray,
  matrices: readonly ColourMatrix[],
): void {
  const n = src.length;
  if (matrices.length === 1) {
    // one function, which is nearly every list: no clamping between, and
    // the store into a clamped array clamps and rounds the result
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11] = matrices[0];
    for (let i = 0; i < n; i += 4) {
      const a = src[i + 3];
      dst[i + 3] = a;
      if (a === 0) {
        dst[i] = 0;
        dst[i + 1] = 0;
        dst[i + 2] = 0;
        continue;
      }
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];
      dst[i] = m0 * r + m1 * g + m2 * b + m3;
      dst[i + 1] = m4 * r + m5 * g + m6 * b + m7;
      dst[i + 2] = m8 * r + m9 * g + m10 * b + m11;
    }
    return;
  }
  for (let i = 0; i < n; i += 4) {
    const a = src[i + 3];
    dst[i + 3] = a;
    if (a === 0) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      continue;
    }
    let r = src[i];
    let g = src[i + 1];
    let b = src[i + 2];
    for (const m of matrices) {
      const r1 = m[0] * r + m[1] * g + m[2] * b + m[3];
      const g1 = m[4] * r + m[5] * g + m[6] * b + m[7];
      const b1 = m[8] * r + m[9] * g + m[10] * b + m[11];
      r = r1 < 0 ? 0 : r1 > 255 ? 255 : r1;
      g = g1 < 0 ? 0 : g1 > 255 ? 255 : g1;
      b = b1 < 0 ? 0 : b1 > 255 ? 255 : b1;
    }
    dst[i] = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
  }
}
