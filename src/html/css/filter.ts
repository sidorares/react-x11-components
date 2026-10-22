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
// (`colourFilter`). `blur()` is a Gaussian over the group's pixels
// (`blurPixels`), and reaches past what the box draws by three of its
// standard deviations (`filterOutsets`). `drop-shadow()` is read and
// computed, so a list with it in it interpolates and makes the box what any
// filter makes it, and is not drawn yet.

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

/** What a `filter` list does that the pass can do: its colour matrices in
 *  the order written, each one's result clamped before the next, as each
 *  function's is; the blur; and what alpha is multiplied by. */
export interface ColourFilter {
  matrices: ColourMatrix[];
  /** The standard deviation of the blur its `blur()`s come to, in device
   *  pixels: the root of the sum of their squares, as two Gaussians make
   *  one. 0 for none. Each colour function is a linear map on
   *  premultiplied colour, which a blur, a weighted sum of premultiplied
   *  pixels, commutes with, so where in the list a blur is written changes
   *  nothing but where the clamps fall, and it is run after them. */
  blur: number;
  /** What two filters with one key do the same (`matricesKey`, and the
   *  blur). */
  key: string;
  /** The colour functions and the blur as a filter list a 2d context takes
   *  — canvas's `filter`, which react-x11's native context runs
   *  (`FilterStore`'s `through`) — without `opacity()`, which is the box's
   *  opacity. */
  css: string;
  alpha: number;
  /** Whether the list has a function the pass does not do — a
   *  `drop-shadow()` — which is drawn as though it were not there. */
  partial: boolean;
}

/** The colour functions and the blur of a `filter` list (`ColourFilter`);
 *  null where there are none and alpha is left as it is, and only what the
 *  colour functions leave as they are is in the list. */
export function colourFilter(
  list: readonly FilterFunction[] | null,
): ColourFilter | null {
  if (!list) return null;
  const matrices: ColourMatrix[] = [];
  const css: string[] = [];
  let alpha = 1;
  let blur2 = 0;
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
    if (f.fn === 'blur') {
      blur2 += f.radius * f.radius;
      continue;
    }
    if (f.fn === 'drop-shadow') {
      partial = true;
      continue;
    }
    const m = matrixOf(f);
    if (!m) continue;
    matrices.push(m);
    css.push(
      f.fn === 'hue-rotate'
        ? `hue-rotate(${f.angle}deg)`
        : `${f.fn}(${f.amount})`,
    );
  }
  const blur = Math.sqrt(blur2);
  if (!matrices.length && alpha === 1 && !(blur > 0)) return null;
  if (blur > 0) css.push(`blur(${blur}px)`);
  return {
    matrices,
    blur,
    key:
      blur > 0
        ? `${matricesKey(matrices)} blur ${blur}`
        : matricesKey(matrices),
    css: css.join(' '),
    alpha,
    partial,
  };
}

/** Whether a filter has anything the pass runs over a group's pixels: a
 *  colour matrix or a blur. */
export function runsOverPixels(colour: ColourFilter | null): boolean {
  return !!colour && (colour.matrices.length > 0 || colour.blur > 0);
}

/** How far past what a box draws its filter's output reaches, each side. */
export interface FilterOutsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * How far past what a box and all it holds draw a `filter` list draws:
 * each `blur()` three of its standard deviations further, as far as a
 * Gaussian shows (Skia's blur, and so Chrome's ink overflow, is outset by
 * 3σ), in the order written. Null where it reaches no further — no blur,
 * or a `url()`, which has the whole list ignored (Filter Effects 1, 4).
 * It is ink, and no scrollable overflow.
 */
export function filterOutsets(
  list: readonly FilterFunction[] | null,
): FilterOutsets | null {
  if (!list) return null;
  let reach = 0;
  for (const f of list) {
    if (f.fn === 'url') return null;
    if (f.fn === 'blur' && f.radius > 0) reach += Math.ceil(3 * f.radius);
  }
  return reach > 0
    ? { left: reach, top: reach, right: reach, bottom: reach }
    : null;
}

/**
 * A `backdrop-filter` list as what a 2d context's `filter` takes — canvas's,
 * which react-x11's native context runs, `blur()` among it: the standard
 * deviation of the blur the list's blurs come to, the root of the sum of
 * their squares, in device pixels, and the rest of it, its colour functions
 * and an `opacity()`, as a list (`colours`). Null for a list that draws
 * nothing, or names a `url()`, which has the whole list ignored (Filter
 * Effects 1, 4); a `drop-shadow()`, which reaches past the backdrop, is
 * left out.
 */
export function backdropFilter(
  list: readonly FilterFunction[],
): { colours: string; blur: number } | null {
  if (list.some((f) => f.fn === 'url')) return null;
  const colour = colourFilter(
    list.filter((f) => f.fn !== 'blur' && f.fn !== 'drop-shadow'),
  );
  let blur2 = 0;
  for (const f of list) if (f.fn === 'blur') blur2 += f.radius * f.radius;
  const blur = Math.sqrt(blur2);
  const parts: string[] = [];
  if (colour?.css) parts.push(colour.css);
  if (colour && colour.alpha < 1) parts.push(`opacity(${colour.alpha})`);
  if (!(blur > 0) && !parts.length) return null;
  return { colours: parts.join(' '), blur };
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

/**
 * A Gaussian of standard deviation `sigma` run over straight RGBA pixels in
 * place — on premultiplied colour, as a filter primitive works, with
 * nothing past the edges — the way `feGaussianBlur` has it (Filter Effects
 * 1, 9.15): from a deviation of 2 up, three box blurs one after the other
 * across and three down, which come to within a few percent of the
 * Gaussian; under it, the Gaussian itself, a kernel three deviations each
 * side. Run where no context runs a filter itself, over the pixels read
 * back for a box (`FilterStore.filtered`).
 */
export function blurPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  sigma: number,
): void {
  if (!(sigma > 0) || width <= 0 || height <= 0) return;
  const n = width * height;
  const planes = [
    new Float32Array(n),
    new Float32Array(n),
    new Float32Array(n),
    new Float32Array(n),
  ];
  const [r, g, b, alpha] = planes;
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    const k = a / 255;
    r[p] = data[i] * k;
    g[p] = data[i + 1] * k;
    b[p] = data[i + 2] * k;
    alpha[p] = a;
  }
  const pass = blurPass(sigma);
  const long = Math.max(width, height);
  const line = new Float64Array(long);
  const spare = new Float64Array(long);
  for (const plane of planes) {
    for (let y = 0; y < height; y += 1) {
      const at = y * width;
      for (let x = 0; x < width; x += 1) line[x] = plane[at + x];
      const out = pass(line, spare, width);
      for (let x = 0; x < width; x += 1) plane[at + x] = out[x];
    }
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) line[y] = plane[y * width + x];
      const out = pass(line, spare, height);
      for (let y = 0; y < height; y += 1) plane[y * width + x] = out[y];
    }
  }
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const a = alpha[p];
    if (!(a > 0.5)) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      continue;
    }
    const k = 255 / a;
    data[i] = r[p] * k;
    data[i + 1] = g[p] * k;
    data[i + 2] = b[p] * k;
    data[i + 3] = a;
  }
}

/**
 * One line's blur, `feGaussianBlur`'s: `line` and `spare` the two buffers
 * it moves between, the result in whichever it ends in. Three box blurs of
 * `d` where `d` is odd, each centred on the pixel; where it is even, two of
 * `d` centred on the boundaries either side of the pixel and one of `d + 1`
 * centred on it.
 */
function blurPass(
  sigma: number,
): (line: Float64Array, spare: Float64Array, len: number) => Float64Array {
  if (sigma >= 2) {
    const d = Math.floor((sigma * 3 * Math.sqrt(2 * Math.PI)) / 4 + 0.5);
    const half = d >> 1;
    const windows: [number, number][] =
      d % 2 === 1
        ? [
            [-half, half],
            [-half, half],
            [-half, half],
          ]
        : [
            [-half, half - 1],
            [-half + 1, half],
            [-half, half],
          ];
    return (line, spare, len) => {
      let from = line;
      let to = spare;
      for (const [lo, hi] of windows) {
        boxBlur(from, to, len, lo, hi);
        [from, to] = [to, from];
      }
      return from;
    };
  }
  const reach = Math.ceil(3 * sigma);
  const weights = new Float64Array(2 * reach + 1);
  let total = 0;
  for (let k = -reach; k <= reach; k += 1) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    weights[k + reach] = w;
    total += w;
  }
  for (let k = 0; k < weights.length; k += 1) weights[k] /= total;
  return (line, spare, len) => {
    for (let i = 0; i < len; i += 1) {
      let sum = 0;
      const lo = Math.max(0, i - reach);
      const hi = Math.min(len - 1, i + reach);
      for (let j = lo; j <= hi; j += 1) sum += line[j] * weights[j - i + reach];
      spare[i] = sum;
    }
    return spare;
  };
}

/** The mean of `src` over the window from `i + lo` to `i + hi` into each
 *  `dst[i]`, what is past either end counting as nothing. */
function boxBlur(
  src: Float64Array,
  dst: Float64Array,
  len: number,
  lo: number,
  hi: number,
): void {
  const size = hi - lo + 1;
  let sum = 0;
  for (let k = Math.max(0, lo); k <= Math.min(len - 1, hi); k += 1) {
    sum += src[k];
  }
  for (let i = 0; i < len; i += 1) {
    dst[i] = sum / size;
    const enter = i + hi + 1;
    const leave = i + lo;
    if (enter < len) sum += src[enter];
    if (leave >= 0 && leave < len) sum -= src[leave];
  }
}
