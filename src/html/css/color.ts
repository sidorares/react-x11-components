import * as ntk from 'react-x11/ntk';
import { parseMathChannel } from './calc.js';
import { closingParen, topLevelComma } from './vars.js';

// CSS Color 4's functional colours: read here, and written back in the one
// form every drawing context reads — `#rrggbb`, or `rgba(r, g, b, a)` with
// channels from 0 to 255.
//
// They used to be handed to the context as written, since ntk's context
// parses a CSS colour for `fillStyle` itself. It reads less than CSS has: the
// comma forms of `rgb()` and `hsl()` and nothing else — no space-separated
// `rgb(59 130 246 / 1)`, which Tailwind 3's utilities are written in, no
// `oklch()`, which Tailwind 4's palette is, no `lab()`, `hwb()` or `color()`
// — and it read `rgb()`'s percentages as numbers from 0 to 255, so
// `rgb(0%, 50%, 0%)` was nearly black. Reading the value here also leaves a
// document one reading of a colour on both backends.
//
// A colour outside sRGB is clipped into it channel by channel, which is what
// an sRGB drawing context can show.

/** The value of a colour function, or null where it is not one. */
export function functionalColor(value: string): string | null {
  let hit = CACHE.get(value);
  if (hit === undefined) {
    hit = readFunction(value);
    // a document repeats its colours, a utility stylesheet most of all
    if (CACHE.size >= 1024) CACHE.clear();
    CACHE.set(value, hit);
  }
  return hit;
}

const CACHE = new Map<string, string | null>();

type Unit = '' | '%' | 'deg' | 'grad' | 'rad' | 'turn' | 'none';

interface Component {
  value: number;
  unit: Unit;
}

const NUMBER = /^([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?$/i;

function component(token: string): Component | null {
  if (token.toLowerCase() === 'none') return { value: 0, unit: 'none' };
  const m = NUMBER.exec(token);
  if (!m) return null;
  return {
    value: parseFloat(m[1]),
    unit: (m[2] ?? '').toLowerCase() as Unit,
  };
}

function readFunction(value: string): string | null {
  const colour = readRgbaFunction(value);
  return colour ? serialize(colour.rgb, colour.a) : null;
}

/**
 * The two shades a 3D border style paints in (`groove`, `ridge`, `inset`,
 * `outset`), as Chromium shades them: the shadowed sides the colour
 * darkened — its brightest channel down by a third — and the lit sides the
 * colour itself; but where darkening leaves black, the colour is the
 * shadow and the lit sides are lightened instead, so a black groove is
 * black against #545454 rather than black against black. Null for a
 * colour this cannot read, `currentColor` resolved first.
 */
export function borderShades(
  color: string,
): { lit: string; shadowed: string } | null {
  const read = readRgba(color);
  if (!read) return null;
  const { rgb, a } = read;
  const v = Math.max(rgb[0], rgb[1], rgb[2]);
  const dark = v > 0.33 ? (v - 0.33) / v : 0;
  const css = (c: Triple) =>
    `rgba(${c.map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255)).join(', ')}, ${a})`;
  if (dark > 0) return { lit: css(rgb), shadowed: css(scaled(rgb, dark)) };
  const light =
    v === 0
      ? ([0.33, 0.33, 0.33] as Triple)
      : scaled(rgb, Math.min(1, v + 0.33) / v);
  return { lit: css(light), shadowed: css(rgb) };
}

/**
 * The colour a fraction `t` of the way from `a` to `b`, premultiplied, as a
 * gradient interpolates between two stops (CSS Images 4, 3.4.3): so a
 * transparent stop lends its alpha and not its colour. Null for a colour
 * this cannot read.
 */
export function blend(a: string, b: string, t: number): string | null {
  const x = readRgba(a);
  const y = readRgba(b);
  if (!x || !y) return null;
  const alpha = x.a + (y.a - x.a) * t;
  if (!(alpha > 0)) return 'transparent';
  const rgb = [0, 1, 2].map(
    (i) => (x.rgb[i] * x.a + (y.rgb[i] * y.a - x.rgb[i] * x.a) * t) / alpha,
  ) as Triple;
  return serialize(rgb, alpha);
}

/**
 * A colour with its alpha multiplied by `by`: what the opacity of an
 * element around a thing fades it to, where it is drawn on its own rather
 * than in its element's group (CSS Color 4, 3.2). The colour as it was
 * where this cannot read it.
 */
export function fadeColor(color: string, by: number): string {
  if (!(by < 1)) return color;
  const read = readRgba(color);
  if (!read) return color;
  const alpha = read.a * Math.max(0, by);
  return alpha > 0 ? serialize(read.rgb, alpha) : 'transparent';
}

/** A colour as straight sRGB, each channel and its alpha 0 to 1, or null
 *  where this cannot read it: `currentColor`, say, which the caller
 *  resolves first. */
export function rgbaOf(value: string): [number, number, number, number] | null {
  const read = readRgba(value);
  if (!read) return null;
  return [
    clamp01(read.rgb[0]),
    clamp01(read.rgb[1]),
    clamp01(read.rgb[2]),
    clamp01(read.a),
  ];
}

function scaled(c: Triple, k: number): Triple {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** A colour as gamma-encoded sRGB, unclipped, and its alpha; and, where
 *  its computed value is no legacy sRGB colour, the form that value keeps
 *  (`ColorForm`). */
interface Rgba {
  rgb: Triple;
  a: number;
  form?: ColorForm;
}

/**
 * A colour as its computed value keeps it, where that is no legacy sRGB
 * colour (CSS Color 4, 15; CSS Color 5, 3 and 4): the space it was written
 * or mixed in, and its components there. A `lab()`, an `lch()`, an
 * `oklab()` and an `oklch()` keep their own; a `color()`, a mix in an RGB
 * or an XYZ space and a relative `rgb()` keep a `color()` space; and an
 * `rgb()`, an `hsl()` or an `hwb()` keeps its own only where a component is
 * `none`, which no other form can say. What a drawing context is handed is
 * the sRGB colour beside it, as before: this is for `getComputedStyle`
 * alone (`colorFormText`).
 */
export interface ColorForm {
  /** `rgb`, `hsl`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, or a `color()`
   *  space — `srgb`, `srgb-linear`, `display-p3`, `xyz-d65`, …. */
  space: string;
  /** The components in that space: an `hsl()`'s saturation and lightness
   *  and an `hwb()`'s whiteness and blackness in percent, a hue in
   *  degrees, an `rgb()`'s channels from 0 to 255. */
  c: Triple;
  a: number;
  /** Which are `none`: a bit a component, and `ALPHA` for the alpha. A
   *  component that is none is 0 in `c`. */
  none: number;
}

/** The alpha's bit in `ColorForm.none`. */
const ALPHA = 8;

/** Any colour but `currentColor`, as numbers: what `color-mix()` mixes. */
function readRgba(value: string): Rgba | null {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (lower === 'transparent') return { rgb: [0, 0, 0], a: 0 };
  if (v.startsWith('#')) return readHex(v);
  if (v.includes('(')) return readRgbaFunction(v);
  const named = cssColorStraight?.(lower);
  if (!Array.isArray(named) || named.length < 3) return null;
  return {
    rgb: [named[0], named[1], named[2]],
    a: named.length > 3 ? named[3] : 1,
  };
}

function readHex(v: string): Rgba | null {
  const hex = v.slice(1);
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const long = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  const byte = (i: number) => parseInt(long.slice(i * 2, i * 2 + 2), 16) / 255;
  return {
    rgb: [byte(0), byte(1), byte(2)],
    a: long.length === 8 ? byte(3) : 1,
  };
}

/** ntk's reading of a named colour. It is on ntk's entry point but not in
 *  react-x11/ntk's declarations, so it is probed. */
const cssColorStraight = (
  ntk as unknown as { cssColorStraight?: (value: string) => unknown }
).cssColorStraight as ((value: string) => number[] | null) | undefined;

function readRgbaFunction(value: string): Rgba | null {
  const open = value.indexOf('(');
  if (open < 0) return null;
  const name = value.slice(0, open).toLowerCase();
  let body = value.slice(open + 1);
  // the end of a style sheet closes whatever is still open (CSS 2.1 4.2):
  // `rgb(0, 128, 0` as a sheet's last words is green
  if (body.endsWith(')')) body = body.slice(0, -1);
  if (name === 'color-mix') return mix(body);
  if (name === 'contrast-color') return contrast(body);
  if (RELATIVE.test(body)) return relative(name, body);

  let channels: Component[];
  let alpha: Component | null = null;
  let space = '';
  // a comma inside a channel's math, `clamp(30%, 45%, 60%)`, is not one
  if (topLevelComma(body) >= 0) {
    // the legacy comma form, which only these four have
    if (!LEGACY.has(name)) return null;
    const parts = topLevelParts(body, ',');
    if (parts.length !== 3 && parts.length !== 4) return null;
    const read: Component[] = [];
    for (const part of parts) {
      const token = part.trim();
      if (!token || topLevelParts(token, ' ').length > 1) return null;
      const c = channel(token);
      if (!c || c.unit === 'none') return null;
      read.push(c);
    }
    channels = read.slice(0, 3);
    alpha = read[3] ?? null;
    if (name === 'rgb' || name === 'rgba') {
      // all numbers or all percentages
      const unit = channels[0].unit;
      if (unit !== '' && unit !== '%') return null;
      if (channels[1].unit !== unit || channels[2].unit !== unit) return null;
    } else if (channels[1].unit !== '%' || channels[2].unit !== '%') {
      return null;
    }
  } else {
    const slash = topLevelParts(body, '/');
    if (slash.length > 2) return null;
    const tokens = words(slash[0]);
    if (name === 'color') space = (tokens.shift() ?? '').toLowerCase();
    if (tokens.length !== 3) return null;
    const read: Component[] = [];
    for (const token of tokens) {
      const c = channel(token);
      if (!c) return null;
      read.push(c);
    }
    channels = read;
    if (slash.length === 2) {
      const token = words(slash[1]);
      if (token.length !== 1) return null;
      alpha = channel(token[0]);
      if (!alpha) return null;
    }
  }

  let a = 1;
  let none = 0;
  if (alpha) {
    if (alpha.unit !== '' && alpha.unit !== '%' && alpha.unit !== 'none') {
      return null;
    }
    if (alpha.unit === 'none') none = ALPHA;
    a = clamp01(alpha.unit === '%' ? alpha.value / 100 : alpha.value);
  }
  const v = resolved(name, channels);
  const rgb = v && toSrgb(name, space, v);
  if (!v || !rgb) return null;
  for (let i = 0; i < 3; i += 1)
    if (channels[i].unit === 'none') none |= 1 << i;
  const form = absoluteForm(name, space, v, a, none);
  return form ? { rgb, a, form } : { rgb, a };
}

const LEGACY = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

/** A space-separated list's items, a function's arguments kept whole. */
function words(text: string): string[] {
  return topLevelParts(text.trim(), ' ').filter(Boolean);
}

/** A channel: a number, a percentage, an angle or `none`, or a math
 *  function standing for one of the first three — `rgb(calc(255 / 2) 0
 *  0)`, `hsl(140 clamp(30%, 45%, 60%) 42%)`. */
function channel(token: string): Component | null {
  if (!token.includes('(')) return component(token);
  return parseMathChannel(token);
}

// --- relative colours (CSS Color 5, 4) -------------------------------------

const RELATIVE = /^\s*from\s/i;

/**
 * A relative colour, `rgb(from <colour> r g b / alpha)` and its kind in
 * each function: the origin colour taken into the function's space, and
 * each channel a number, a keyword that is one of the origin's channels,
 * or a calculation with them in it. The keywords are numbers in the
 * function's own range (`r` from 0 to 255, `s` and `l` from 0 to 100, an
 * angle's degrees), and an alpha left out is the origin's, not 1. The
 * origin is any colour but `currentColor`, which `parseColor` keeps the
 * colour to be resolved where it is used.
 */
function relative(name: string, body: string): Rgba | null {
  const slash = topLevelParts(body, '/');
  if (slash.length > 2) return null;
  const tokens = words(slash[0]);
  if (tokens.length < 2 || tokens[0].toLowerCase() !== 'from') return null;
  const origin = readRgba(tokens[1]);
  if (!origin) return null;
  const rest = tokens.slice(2);
  const space = name === 'color' ? (rest.shift() ?? '').toLowerCase() : '';
  if (rest.length !== 3) return null;
  const coords = originIn(name, space, origin);
  const keys = CHANNEL_NAMES[name] ?? (XYZ_SPACES.has(space) ? 'xyz' : 'rgb');
  if (!coords) return null;
  const known = new Map<string, number>([['alpha', origin.a]]);
  for (let i = 0; i < 3; i += 1) {
    // a hue a grey has none of is `none`, which is 0
    known.set(keys[i], Number.isNaN(coords[i]) ? 0 : coords[i]);
  }
  const channels: Component[] = [];
  for (const token of rest) {
    const c = relativeChannel(token, known);
    if (!c) return null;
    channels.push(c);
  }
  let a = origin.a;
  let none = 0;
  if (slash.length === 2) {
    const token = words(slash[1]);
    if (token.length !== 1) return null;
    const alpha = relativeChannel(token[0], known);
    if (!alpha || alpha.unit === 'deg' || alpha.unit === 'grad') return null;
    if (alpha.unit === 'rad' || alpha.unit === 'turn') return null;
    if (alpha.unit === 'none') none = ALPHA;
    a = clamp01(alpha.unit === '%' ? alpha.value / 100 : alpha.value);
  }
  const v = resolved(name, channels);
  const rgb = v && toSrgb(name, space, v);
  if (!v || !rgb) return null;
  for (let i = 0; i < 3; i += 1)
    if (channels[i].unit === 'none') none |= 1 << i;
  return { rgb, a, form: relativeForm(name, space, v, rgb, a, none) };
}

/** Each function's channel keywords, in order. */
const CHANNEL_NAMES: Record<string, string> = {
  rgb: 'rgb',
  rgba: 'rgb',
  hsl: 'hsl',
  hsla: 'hsl',
  hwb: 'hwb',
  lab: 'lab',
  lch: 'lch',
  oklab: 'lab',
  oklch: 'lch',
};

const XYZ_SPACES = new Set(['xyz', 'xyz-d50', 'xyz-d65']);

/** A channel of a relative colour: a keyword is the origin's channel, and
 *  a calculation is worked out with the keywords' values put in. */
function relativeChannel(
  token: string,
  known: Map<string, number>,
): Component | null {
  const value = known.get(token.toLowerCase());
  if (value !== undefined) return { value, unit: '' };
  if (!token.includes('(')) return component(token);
  let unknown = false;
  const text = token.replace(KEYWORD, (word) => {
    const v = known.get(word.toLowerCase());
    // a function's name, `pi`, `e`, `infinity`: the calculation's own
    if (v === undefined) {
      if (!/^(?:pi|e|-?infinity|nan)$/i.test(word)) unknown = true;
      return word;
    }
    return `(${v})`;
  });
  if (unknown) return null;
  return channel(text);
}

/** A word in a calculation that is not a function's name. */
const KEYWORD = /(?<![\w.-])-?[a-z][\w-]*(?![\w(-])/gi;

/** The origin colour's channels in a relative colour's function, in the
 *  ranges its keywords take: the ones its computed value keeps where it is
 *  of that space already, so `lab(from lab(200 300 400) l a b)` reads the
 *  `a` and `b` that sRGB has no room for, and `none` is 0. */
function originIn(name: string, space: string, origin: Rgba): Triple | null {
  const form = origin.form;
  if (form && form.space === formSpaceOf(name, space)) return form.c;
  const rgb = origin.rgb;
  switch (name) {
    case 'rgb':
    case 'rgba':
      return scaled(rgb, 255);
    case 'hsl':
    case 'hsla':
      return srgbToHsl(rgb);
    case 'hwb':
    case 'lab':
    case 'lch':
    case 'oklab':
    case 'oklch':
      return toSpace(name, rgb);
    case 'color':
      return toSpace(space, rgb) ?? toPredefined(space, rgb);
    default:
      return null;
  }
}

/** Gamma-encoded sRGB in one of `color()`'s RGB spaces, as `predefined`
 *  reads them back. */
function toPredefined(space: string, rgb: Triple): Triple | null {
  const xyz = multiply(LINEAR_SRGB_TO_XYZ, linearize(rgb));
  switch (space) {
    case 'display-p3':
      return multiply(XYZ_TO_P3, xyz).map(srgbEncode) as Triple;
    case 'display-p3-linear':
      return multiply(XYZ_TO_P3, xyz);
    case 'a98-rgb':
      return multiply(XYZ_TO_A98, xyz).map(
        (x) => Math.sign(x) * Math.abs(x) ** (256 / 563),
      ) as Triple;
    case 'prophoto-rgb':
      return multiply(XYZ_D50_TO_PROPHOTO, multiply(D65_TO_D50, xyz)).map(
        prophotoEncode,
      ) as Triple;
    case 'rec2020':
      return multiply(XYZ_TO_REC2020, xyz).map(rec2020Encode) as Triple;
    default:
      return null;
  }
}

/** A channel as a number, or null where its unit is not one it takes:
 *  `pct` is what 100% means for it. */
function amount(c: Component, pct: number): number | null {
  if (c.unit === '') return c.value;
  if (c.unit === 'none') return 0;
  if (c.unit === '%') return (c.value / 100) * pct;
  return null;
}

function hue(c: Component): number | null {
  switch (c.unit) {
    case '':
    case 'deg':
      return c.value;
    case 'grad':
      return c.value * 0.9;
    case 'rad':
      return (c.value * 180) / Math.PI;
    case 'turn':
      return c.value * 360;
    case 'none':
      return 0;
    default:
      return null;
  }
}

type Triple = [number, number, number];

/** A function's channels as numbers in its own ranges — an `rgb()`'s from
 *  0 to 255, a percentage of `hsl()`'s and `hwb()`'s in percent, a hue in
 *  degrees, a `lab()`'s and an `oklab()`'s as their numbers — or null
 *  where a channel is not one its function takes. `none` is 0. */
function resolved(name: string, c: Component[]): Triple | null {
  let v: (number | null)[];
  switch (name) {
    case 'rgb':
    case 'rgba':
      v = [amount(c[0], 255), amount(c[1], 255), amount(c[2], 255)];
      break;
    case 'hsl':
    case 'hsla':
    case 'hwb':
      v = [hue(c[0]), amount(c[1], 100), amount(c[2], 100)];
      break;
    case 'lab':
      v = [amount(c[0], 100), amount(c[1], 125), amount(c[2], 125)];
      break;
    case 'lch':
      v = [amount(c[0], 100), amount(c[1], 150), hue(c[2])];
      break;
    case 'oklab':
      v = [amount(c[0], 1), amount(c[1], 0.4), amount(c[2], 0.4)];
      break;
    case 'oklch':
      v = [amount(c[0], 1), amount(c[1], 0.4), hue(c[2])];
      break;
    case 'color':
      v = [amount(c[0], 1), amount(c[1], 1), amount(c[2], 1)];
      break;
    default:
      return null;
  }
  if (v[0] === null || v[1] === null || v[2] === null) return null;
  return v as Triple;
}

/** The colour in gamma-encoded sRGB, each channel from 0 to 1 (before
 *  clipping), from its function's channels as `resolved` reads them; null
 *  for a `color()` space there is none of. */
function toSrgb(name: string, space: string, v: Triple): Triple | null {
  switch (name) {
    case 'rgb':
    case 'rgba':
      return [v[0] / 255, v[1] / 255, v[2] / 255];
    case 'hsl':
    case 'hsla':
      return hslToRgb(v[0], clamp01(v[1] / 100), clamp01(v[2] / 100));
    case 'hwb':
      return hwbToRgb(v[0], clamp01(v[1] / 100), clamp01(v[2] / 100));
    case 'lab':
    case 'lch': {
      const l = v[0];
      const [a, b] =
        name === 'lab' ? [v[1], v[2]] : polar(Math.max(0, v[1]), v[2]);
      // the gamut mapping CSS draws with takes a lightness at either end to
      // white or black, whatever its chroma (CSS Color 4 13.2)
      if (l >= 100) return [1, 1, 1];
      if (l <= 0) return [0, 0, 0];
      const xyz = labToXyzD50(l, a, b);
      return gamma(multiply(XYZ_TO_LINEAR_SRGB, multiply(D50_TO_D65, xyz)));
    }
    case 'oklab':
    case 'oklch': {
      const l = v[0];
      const [a, b] =
        name === 'oklab' ? [v[1], v[2]] : polar(Math.max(0, v[1]), v[2]);
      if (l >= 1) return [1, 1, 1];
      if (l <= 0) return [0, 0, 0];
      return gamma(oklabToLinearSrgb(l, a, b));
    }
    case 'color':
      return predefined(space, v);
    default:
      return null;
  }
}

// --- the forms a computed value keeps (CSS Color 4, 15) ---------------------

/** The space a form of a function's is in, `color()`'s `xyz` as the
 *  `xyz-d65` it is. */
function formSpaceOf(name: string, space: string): string {
  if (name === 'color') return space === 'xyz' ? 'xyz-d65' : space;
  if (name === 'rgba') return 'rgb';
  if (name === 'hsla') return 'hsl';
  return name;
}

/** A hue as a computed value keeps it: in [0, 360), and 0 for one that is
 *  no number. */
function hueOf(h: number): number {
  const r = ((h % 360) + 360) % 360;
  return r >= 0 && r < 360 ? r : 0;
}

/** A number no calculation's `NaN` is: 0 where it is (CSS Values 4,
 *  10.9). */
function finite(x: number): number {
  return Number.isNaN(x) ? 0 : x;
}

function between(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : finite(x);
}

/** The form an absolute colour's computed value keeps, from its channels
 *  as `resolved` reads them; none for an `rgb()`, an `hsl()` or an `hwb()`
 *  with no `none` in it, which is a legacy sRGB colour. */
function absoluteForm(
  name: string,
  space: string,
  v: Triple,
  a: number,
  none: number,
): ColorForm | undefined {
  switch (name) {
    case 'rgb':
    case 'rgba':
      if (!none) return undefined;
      return {
        space: 'rgb',
        c: [finite(v[0]), finite(v[1]), finite(v[2])],
        a,
        none,
      };
    case 'hsl':
    case 'hsla':
    case 'hwb':
      if (!none) return undefined;
      return {
        space: formSpaceOf(name, space),
        c: [hueOf(v[0]), finite(v[1]), finite(v[2])],
        a,
        none,
      };
    default:
      return ownForm(name, space, v, a, none);
  }
}

/** A `lab()`'s, an `lch()`'s, an `oklab()`'s, an `oklch()`'s or a
 *  `color()`'s form: its lightness within its range, its chroma none below
 *  nought and its hue in a turn — at parsed-value time, as CSS Color 4 has
 *  them — and a `color()`'s channels as they are, unclamped. */
function ownForm(
  name: string,
  space: string,
  v: Triple,
  a: number,
  none: number,
): ColorForm | undefined {
  switch (name) {
    case 'lab':
      return {
        space: name,
        c: [between(v[0], 0, 100), finite(v[1]), finite(v[2])],
        a,
        none,
      };
    case 'oklab':
      return {
        space: name,
        c: [between(v[0], 0, 1), finite(v[1]), finite(v[2])],
        a,
        none,
      };
    case 'lch':
      return {
        space: name,
        c: [between(v[0], 0, 100), Math.max(0, finite(v[1])), hueOf(v[2])],
        a,
        none,
      };
    case 'oklch':
      return {
        space: name,
        c: [between(v[0], 0, 1), Math.max(0, finite(v[1])), hueOf(v[2])],
        a,
        none,
      };
    case 'color':
      return {
        space: formSpaceOf(name, space),
        c: [finite(v[0]), finite(v[1]), finite(v[2])],
        a,
        none,
      };
    default:
      return undefined;
  }
}

/** A relative colour's form (CSS Color 5, 4): in its function's own space,
 *  but for `rgb()`, `hsl()` and `hwb()`, whose channels need not be in the
 *  sRGB gamut, and which keep them unclamped in `color(srgb …)` — or, with
 *  a `none` in them, in their own function. */
function relativeForm(
  name: string,
  space: string,
  v: Triple,
  rgb: Triple,
  a: number,
  none: number,
): ColorForm | undefined {
  switch (name) {
    case 'rgb':
    case 'rgba':
      return {
        space: 'srgb',
        c: [finite(v[0]) / 255, finite(v[1]) / 255, finite(v[2]) / 255],
        a,
        none,
      };
    case 'hsl':
    case 'hsla':
    case 'hwb':
      if (none) return absoluteForm(name, space, v, a, none);
      return {
        space: 'srgb',
        c: [finite(rgb[0]), finite(rgb[1]), finite(rgb[2])],
        a,
        none,
      };
    default:
      return ownForm(name, space, v, a, none);
  }
}

/** A colour's components in a space a mix is taken in, with which of them
 *  are `none`: its own, where its computed value keeps that space, so a
 *  `none` it was written with is carried into the mix (CSS Color 4,
 *  12.2); else converted from sRGB, where a hue a grey has none of is
 *  `none` too (12.3). */
function inSpace(
  space: string,
  colour: Rgba,
): { v: Triple; none: number } | null {
  const form = colour.form;
  if (form) {
    if (form.space === formSpaceOf('color', space)) {
      return { v: form.c, none: form.none };
    }
    if (form.space === 'rgb' && space === 'srgb') {
      return { v: scaled(form.c, 1 / 255), none: form.none };
    }
  }
  const v = toSpace(space, colour.rgb);
  if (!v) return null;
  let none = form ? form.none & ALPHA : 0;
  let out = v;
  for (let i = 0; i < 3; i += 1) {
    if (!Number.isNaN(v[i])) continue;
    if (out === v) out = [v[0], v[1], v[2]];
    out[i] = 0;
    none |= 1 << i;
  }
  return { v: out, none };
}

/** A form as `getComputedStyle` reads it (CSS Color 4, 15.3–15.5): the
 *  function or `color()` with its space, each component a number of up to
 *  six significant digits or `none`, a percentage where `hsl()` and
 *  `hwb()` have one, and the alpha after a slash where it is not 1. */
function serializeForm(f: ColorForm): string {
  const part = (i: number, pct = false): string =>
    f.none & (1 << i) ? 'none' : `${formNumber(f.c[i])}${pct ? '%' : ''}`;
  const alpha =
    f.none & ALPHA ? ' / none' : f.a === 1 ? '' : ` / ${formNumber(f.a)}`;
  switch (f.space) {
    case 'rgb':
    case 'lab':
    case 'lch':
    case 'oklab':
    case 'oklch':
      return `${f.space}(${part(0)} ${part(1)} ${part(2)}${alpha})`;
    case 'hsl':
    case 'hwb':
      return `${f.space}(${part(0)} ${part(1, true)} ${part(2, true)}${alpha})`;
    default:
      return `color(${f.space} ${part(0)} ${part(1)} ${part(2)}${alpha})`;
  }
}

/** A component as a computed colour serializes it: six significant digits,
 *  with nothing left of a rounding error below a millionth, and an
 *  infinity as the calculation it can only be written as. */
function formNumber(x: number): string {
  if (x === Infinity) return 'calc(infinity)';
  if (x === -Infinity) return 'calc(-infinity)';
  const r = Number(finite(x).toPrecision(6));
  return Math.abs(r) < 1e-6 ? '0' : String(r);
}

/**
 * A colour as `getComputedStyle` reads it where its computed value keeps
 * a space of its own (`ColorForm`): `color(srgb 0.5 0 0.5)` for a mix in
 * sRGB, `oklch(0.623 0.214 259.815)` as it was written, a relative
 * colour's channels unclamped. Null for a legacy sRGB colour, which
 * `rgb()` says, for `currentColor`, which the caller resolves first, and
 * for what is no colour.
 */
export function colorFormText(value: string): string | null {
  let hit = FORM_CACHE.get(value);
  if (hit === undefined) {
    const form = readRgba(value)?.form;
    hit = form ? serializeForm(form) : null;
    if (FORM_CACHE.size >= 1024) FORM_CACHE.clear();
    FORM_CACHE.set(value, hit);
  }
  return hit;
}

const FORM_CACHE = new Map<string, string | null>();

/**
 * An absolute colour function as a declaration keeps it (CSSOM 6.7.2):
 * its name in lower case, each math function in it simplified to the one
 * value it comes to, as `calc(<value>)`, and each number in its shortest
 * form — `calc(1 + 1 / 1)` as `calc(2)`, `.5` as `0.5`. Null where it is
 * none this reads, and for a relative colour, whose calculations name its
 * origin's channels and are kept as written.
 */
export function specifiedColorText(value: string): string | null {
  const v = value.trim();
  const open = v.indexOf('(');
  if (open < 0 || !v.endsWith(')')) return null;
  const name = v.slice(0, open).toLowerCase();
  if (!SPECIFIED_FUNCTIONS.has(name)) return null;
  const body = v.slice(open + 1, -1).trim();
  if (RELATIVE.test(body) || !readRgbaFunction(v)) return null;
  const piece = (token: string): string | null => {
    if (token.toLowerCase() === 'none') return 'none';
    const c = channel(token);
    if (!c) return null;
    const n = `${formNumber(c.value)}${c.unit}`;
    return token.includes('(') ? `calc(${n})` : n;
  };
  const pieces = (tokens: string[]): string[] | null => {
    const out: string[] = [];
    for (const token of tokens) {
      const p = piece(token.trim());
      if (p === null) return null;
      out.push(p);
    }
    return out;
  };
  if (topLevelComma(body) >= 0) {
    const out = pieces(topLevelParts(body, ','));
    return out && `${name}(${out.join(', ')})`;
  }
  const slash = topLevelParts(body, '/');
  const tokens = words(slash[0]);
  const space = name === 'color' ? `${tokens.shift()?.toLowerCase()} ` : '';
  const out = pieces(tokens);
  const alpha = slash.length === 2 ? pieces(words(slash[1])) : [];
  if (!out || !alpha) return null;
  const tail = alpha.length ? ` / ${alpha[0]}` : '';
  return `${name}(${space}${out.join(' ')}${tail})`;
}

const SPECIFIED_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
]);

/** One of `color()`'s predefined spaces, in gamma-encoded sRGB. */
function predefined(space: string, v: Triple): Triple | null {
  switch (space) {
    case 'srgb':
      return v;
    case 'srgb-linear':
      return gamma(v);
    case 'display-p3':
      return fromXyzD65(multiply(P3_TO_XYZ, v.map(srgbLinear) as Triple));
    case 'display-p3-linear':
      return fromXyzD65(multiply(P3_TO_XYZ, v));
    case 'a98-rgb':
      return fromXyzD65(
        multiply(
          A98_TO_XYZ,
          v.map((x) => Math.sign(x) * Math.abs(x) ** (563 / 256)) as Triple,
        ),
      );
    case 'prophoto-rgb':
      return fromXyzD65(
        multiply(
          D50_TO_D65,
          multiply(PROPHOTO_TO_XYZ_D50, v.map(prophotoLinear) as Triple),
        ),
      );
    case 'rec2020':
      return fromXyzD65(
        multiply(REC2020_TO_XYZ, v.map(rec2020Linear) as Triple),
      );
    case 'xyz':
    case 'xyz-d65':
      return fromXyzD65(v);
    case 'xyz-d50':
      return fromXyzD65(multiply(D50_TO_D65, v));
    default:
      return null;
  }
}

// --- color-mix() (CSS Color 5 3) ---------------------------------------------

/** `color-mix([in <space> [<hue> hue]?,]? <colour> <p>?, <colour> <p>?)`:
 *  the two colours in `space`, premultiplied, weighted by their
 *  percentages. With no space named the mix is in `oklab` (CSS Color 5,
 *  3.1). */
function mix(body: string): Rgba | null {
  let parts = topLevelParts(body, ',');
  if (parts.length === 2) parts = ['in oklab', ...parts];
  if (parts.length !== 3) return null;
  const head = parts[0].trim().toLowerCase().split(/\s+/);
  if (head[0] !== 'in' || head.length < 2) return null;
  const space = head[1];
  let method = 'shorter';
  if (head.length === 4 && head[3] === 'hue' && space in HUE) {
    if (!HUE_METHODS.has(head[2])) return null;
    method = head[2];
  } else if (head.length !== 2) {
    return null;
  }
  const first = weighted(parts[1]);
  const second = weighted(parts[2]);
  if (!first || !second) return null;
  let p1 = first.pct;
  let p2 = second.pct;
  if (p1 === null && p2 === null) p1 = p2 = 50;
  else if (p1 === null) p1 = 100 - (p2 as number);
  else if (p2 === null) p2 = 100 - p1;
  const sum = (p1 as number) + (p2 as number);
  if (!(sum > 0)) return null;
  const t = (p2 as number) / sum;
  const x = inSpace(space, first.colour);
  const y = inSpace(space, second.colour);
  if (!x || !y) return null;
  // a component `none` on one side is the other's, and on both stays
  // `none` (CSS Color 4, 12.2) — the alpha too, which then weighs nothing
  let none = x.none & y.none;
  const a1 =
    x.none & ALPHA ? (none & ALPHA ? 1 : second.colour.a) : first.colour.a;
  const a2 =
    y.none & ALPHA ? (none & ALPHA ? 1 : first.colour.a) : second.colour.a;
  const alpha = a1 * (1 - t) + a2 * t;
  const hueAt = HUE[space] ?? -1;
  const out: Triple = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const bit = 1 << i;
    if (none & bit) continue;
    const xi = x.none & bit ? y.v[i] : x.v[i];
    const yi = y.none & bit ? x.v[i] : y.v[i];
    if (i === hueAt) {
      out[i] = mixHue(xi, yi, t, method);
    } else {
      // premultiplied, so a transparent side lends its alpha and not its
      // colour: Tailwind's `bg-blue-500/50` is blue, half as opaque
      const v = xi * a1 * (1 - t) + yi * a2 * t;
      out[i] = alpha === 0 ? 0 : v / alpha;
    }
  }
  const rgb = fromSpace(space, out);
  if (!rgb) return null;
  // percentages that come to less than 100% take their share of the alpha,
  // and one that is `none` is drawn as nought
  const a = (none & ALPHA ? 0 : alpha) * Math.min(1, sum / 100);
  // the computed value is in the space mixed in (CSS Color 5, 3.1): an
  // `hsl()` or an `hwb()` mix is sRGB, as `color(srgb …)`, but where it
  // has a `none` to keep
  const form: ColorForm =
    (space === 'hsl' || space === 'hwb') && !none
      ? { space: 'srgb', c: rgb, a, none }
      : { space: formSpaceOf('color', space), c: out, a, none };
  return { rgb, a, form };
}

// --- contrast-color() (CSS Color 5 4) ----------------------------------------

/** `contrast-color(<colour>)`: white or black, whichever has the greater
 *  WCAG 2.1 contrast ratio against the colour, as Chrome and Safari answer
 *  it. The colour is read as it is, its alpha set aside. */
function contrast(body: string): Rgba | null {
  const text = body.trim();
  if (topLevelParts(text, ' ').filter(Boolean).length !== 1) return null;
  const read = readRgba(text);
  if (!read) return null;
  const linear = read.rgb.map((c) => {
    const v = clamp01(c);
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const y = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const onWhite = 1.05 / (y + 0.05);
  const onBlack = (y + 0.05) / 0.05;
  return onBlack >= onWhite
    ? { rgb: [0, 0, 0], a: 1 }
    : { rgb: [1, 1, 1], a: 1 };
}

/** Which component of a polar space is its hue. */
const HUE: Record<string, number> = { hsl: 0, hwb: 0, lch: 2, oklch: 2 };

const HUE_METHODS = new Set(['shorter', 'longer', 'increasing', 'decreasing']);

/** A colour and the percentage beside it, either way round. */
function weighted(text: string): { colour: Rgba; pct: number | null } | null {
  const tokens = topLevelParts(text.trim(), ' ').filter(Boolean);
  let pct: number | null = null;
  let colour: string | null = null;
  for (const token of tokens) {
    const m = /^((?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)%$/i.exec(token);
    if (m) {
      if (pct !== null) return null;
      pct = Number(m[1]);
      if (pct > 100) return null;
    } else {
      if (colour !== null) return null;
      colour = token;
    }
  }
  const read = colour === null ? null : readRgba(colour);
  return read ? { colour: read, pct } : null;
}

/** `text` split on `sep` outside brackets. */
function topLevelParts(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && (c === sep || (sep === ' ' && /\s/.test(c)))) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function mixHue(h1: number, h2: number, t: number, method: string): number {
  // an achromatic side has no hue, and takes the other's
  if (Number.isNaN(h1)) return Number.isNaN(h2) ? 0 : h2;
  if (Number.isNaN(h2)) return h1;
  let a = ((h1 % 360) + 360) % 360;
  let b = ((h2 % 360) + 360) % 360;
  const d = b - a;
  if (method === 'longer') {
    if (d > 0 && d < 180) a += 360;
    else if (d > -180 && d <= 0) b += 360;
  } else if (method === 'increasing') {
    if (d < 0) b += 360;
  } else if (method === 'decreasing') {
    if (d > 0) a += 360;
  } else if (d > 180) {
    a += 360;
  } else if (d < -180) {
    b += 360;
  }
  return (((a + (b - a) * t) % 360) + 360) % 360;
}

/** Gamma-encoded sRGB into a space a mix can be taken in. */
function toSpace(space: string, rgb: Triple): Triple | null {
  switch (space) {
    case 'srgb':
      return rgb;
    case 'srgb-linear':
      return linearize(rgb);
    case 'xyz':
    case 'xyz-d65':
      return multiply(LINEAR_SRGB_TO_XYZ, linearize(rgb));
    case 'xyz-d50':
      return multiply(D65_TO_D50, multiply(LINEAR_SRGB_TO_XYZ, linearize(rgb)));
    case 'lab':
    case 'lch': {
      const lab = xyzD50ToLab(
        multiply(D65_TO_D50, multiply(LINEAR_SRGB_TO_XYZ, linearize(rgb))),
      );
      return space === 'lab' ? lab : toPolar(lab, 0.0015);
    }
    case 'oklab':
    case 'oklch': {
      const oklab = linearSrgbToOklab(linearize(rgb));
      return space === 'oklab' ? oklab : toPolar(oklab, 0.000004);
    }
    case 'hsl':
      return srgbToHsl(rgb);
    case 'hwb': {
      const [h] = srgbToHsl(rgb);
      return [h, Math.min(...rgb) * 100, (1 - Math.max(...rgb)) * 100];
    }
    default:
      // `display-p3`, `rec2020` and the rest of `color()`'s
      return toPredefined(space, rgb);
  }
}

/** A space's components back to gamma-encoded sRGB. */
function fromSpace(space: string, c: Triple): Triple | null {
  switch (space) {
    case 'srgb':
      return c;
    case 'srgb-linear':
      return gamma(c);
    case 'xyz':
    case 'xyz-d65':
      return fromXyzD65(c);
    case 'xyz-d50':
      return fromXyzD65(multiply(D50_TO_D65, c));
    case 'lab':
    case 'lch': {
      const [l, a, b] =
        space === 'lab' ? c : [c[0], ...polar(Math.max(0, c[1]), c[2])];
      return fromXyzD65(multiply(D50_TO_D65, labToXyzD50(l, a, b)));
    }
    case 'oklab':
    case 'oklch': {
      const [l, a, b] =
        space === 'oklab' ? c : [c[0], ...polar(Math.max(0, c[1]), c[2])];
      return gamma(oklabToLinearSrgb(l, a, b));
    }
    case 'hsl':
      return hslToRgb(c[0], clamp01(c[1] / 100), clamp01(c[2] / 100));
    case 'hwb':
      return hwbToRgb(c[0], clamp01(c[1] / 100), clamp01(c[2] / 100));
    default:
      return predefined(space, c);
  }
}

function linearize(rgb: Triple): Triple {
  return rgb.map(srgbLinear) as Triple;
}

function linearSrgbToOklab([r, g, b]: Triple): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function xyzD50ToLab(xyz: Triple): Triple {
  const f = xyz.map((v, i) => {
    const x = v / D50_WHITE[i];
    return x > EPSILON ? Math.cbrt(x) : (KAPPA * x + 16) / 116;
  });
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

/** Lightness, chroma and hue — no hue where there is next to no chroma,
 *  which is what a grey's hue is. */
function toPolar([l, a, b]: Triple, grey: number): Triple {
  const chroma = Math.sqrt(a * a + b * b);
  if (chroma < grey) return [l, chroma, NaN];
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return [l, chroma, h < 0 ? h + 360 : h];
}

function srgbToHsl([r, g, b]: Triple): Triple {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (min + max) / 2;
  const d = max - min;
  if (d === 0) return [NaN, 0, l * 100];
  const s = l === 0 || l === 1 ? 0 : (max - l) / Math.min(l, 1 - l);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function serialize(rgb: Triple, a: number): string {
  const [r, g, b] = rgb.map((x) => Math.round(clamp01(x) * 255));
  if (a === 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function polar(chroma: number, h: number): [number, number] {
  const rad = (h * Math.PI) / 180;
  return [chroma * Math.cos(rad), chroma * Math.sin(rad)];
}

// --- the conversions: CSS Color 4's sample code (§18) -----------------------

function hslToRgb(h: number, s: number, l: number): Triple {
  const hue = ((h % 360) + 360) % 360;
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function hwbToRgb(h: number, w: number, b: number): Triple {
  if (w + b >= 1) {
    const gray = w / (w + b);
    return [gray, gray, gray];
  }
  const rgb = hslToRgb(h, 1, 0.5);
  return rgb.map((x) => x * (1 - w - b) + w) as Triple;
}

const KAPPA = 24389 / 27;
const EPSILON = 216 / 24389;
const D50_WHITE: Triple = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

function labToXyzD50(l: number, a: number, b: number): Triple {
  const f1 = (l + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const x = f0 ** 3 > EPSILON ? f0 ** 3 : (116 * f0 - 16) / KAPPA;
  const y = l > KAPPA * EPSILON ? f1 ** 3 : l / KAPPA;
  const z = f2 ** 3 > EPSILON ? f2 ** 3 : (116 * f2 - 16) / KAPPA;
  return [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]];
}

function oklabToLinearSrgb(l: number, a: number, b: number): Triple {
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
}

function fromXyzD65(xyz: Triple): Triple {
  return gamma(multiply(XYZ_TO_LINEAR_SRGB, xyz));
}

function srgbLinear(x: number): number {
  const abs = Math.abs(x);
  return abs <= 0.04045
    ? x / 12.92
    : Math.sign(x) * ((abs + 0.055) / 1.055) ** 2.4;
}

function gamma(rgb: Triple): Triple {
  return rgb.map(srgbEncode) as Triple;
}

function srgbEncode(x: number): number {
  const abs = Math.abs(x);
  return abs > 0.0031308
    ? Math.sign(x) * (1.055 * abs ** (1 / 2.4) - 0.055)
    : 12.92 * x;
}

function prophotoLinear(x: number): number {
  const abs = Math.abs(x);
  return abs <= 16 / 512 ? x / 16 : Math.sign(x) * abs ** 1.8;
}

function prophotoEncode(x: number): number {
  const abs = Math.abs(x);
  return abs < 1 / 512 ? x * 16 : Math.sign(x) * abs ** (1 / 1.8);
}

function rec2020Encode(x: number): number {
  const alpha = 1.09929682680944;
  const beta = 0.018053968510807;
  const abs = Math.abs(x);
  return abs < beta
    ? x * 4.5
    : Math.sign(x) * (alpha * abs ** 0.45 - (alpha - 1));
}

function rec2020Linear(x: number): number {
  const alpha = 1.09929682680944;
  const beta = 0.018053968510807;
  const abs = Math.abs(x);
  return abs < beta * 4.5
    ? x / 4.5
    : Math.sign(x) * ((abs + alpha - 1) / alpha) ** (1 / 0.45);
}

function multiply(m: readonly Triple[], v: Triple): Triple {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

// Each takes its space's white to its white point's XYZ, which the tests
// check by sending white through every space.

const LINEAR_SRGB_TO_XYZ: readonly Triple[] = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];

const D65_TO_D50: readonly Triple[] = [
  [1.0479297925449969, 0.022946870601609652, -0.05019226628920524],
  [0.02962780877005599, 0.9904344267538799, -0.017073799063418826],
  [-0.009243040646204504, 0.015055191490298152, 0.7518742814281371],
];

const XYZ_TO_LINEAR_SRGB: readonly Triple[] = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
];

const D50_TO_D65: readonly Triple[] = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];

const P3_TO_XYZ: readonly Triple[] = [
  [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
  [35783 / 156275, 247089 / 357200, 198249 / 2500400],
  [0, 32229 / 714400, 5220557 / 5000800],
];

const A98_TO_XYZ: readonly Triple[] = [
  [573536 / 994567, 263643 / 1420810, 187206 / 994567],
  [591459 / 1989134, 6239551 / 9945670, 374412 / 4972835],
  [53769 / 1989134, 351524 / 4972835, 4929758 / 4972835],
];

const PROPHOTO_TO_XYZ_D50: readonly Triple[] = [
  [0.7977666449006423, 0.13518129740053308, 0.0313477341283922],
  [0.2880748288194013, 0.711835234241873, 0.00008993693872564],
  [0, 0, 0.8251046025104602],
];

const REC2020_TO_XYZ: readonly Triple[] = [
  [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
  [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
  [0, 19567812 / 697040785, 295819943 / 278816314],
];

// The way back from XYZ to each RGB space, which a relative colour's origin
// is taken into.

const XYZ_TO_P3: readonly Triple[] = [
  [446124 / 178915, -333277 / 357830, -72051 / 178915],
  [-14852 / 17905, 63121 / 35810, 423 / 17905],
  [11844 / 330415, -50337 / 660830, 316169 / 330415],
];

const XYZ_TO_A98: readonly Triple[] = [
  [1829569 / 896150, -506331 / 896150, -308931 / 896150],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [16779 / 1248040, -147721 / 1248040, 1266979 / 1248040],
];

const XYZ_D50_TO_PROPHOTO: readonly Triple[] = [
  [1.3457868816471583, -0.25557208737979464, -0.05110186497554526],
  [-0.5446307051249019, 1.5082477428451468, 0.02052744743642139],
  [0, 0, 1.2119675456389452],
];

const XYZ_TO_REC2020: readonly Triple[] = [
  [30757411 / 17917100, -6372589 / 17917100, -4539589 / 17917100],
  [-19765991 / 29648200, 47925759 / 29648200, 467509 / 29648200],
  [792561 / 44930125, -1921689 / 44930125, 42328811 / 44930125],
];

// --- colour schemes ---------------------------------------------------------

/** Whether a value has a `light-dark()` in it. */
export const LIGHT_DARK = /(?:^|[^\w-])light-dark\(/i;
const LIGHT_DARK_AT = /(?:^|[^\w-])(light-dark\()/gi;

/**
 * A value with each `light-dark()` in it replaced by the branch `scheme`
 * picks (CSS Color 5, 7): the first where the element's used colour
 * scheme is light, the second where it is dark. Replaced in the text, as a
 * `var()` is, so a branch can be any colour — or another `light-dark()` —
 * in any value a colour stands in. Null where one is not two arguments,
 * which makes the declaration invalid.
 */
export function lightDark(
  value: string,
  scheme: 'light' | 'dark',
): string | null {
  // kept by the value: the UA sheet's link colour is one, so every link of
  // every document asks, and a theme's are a few asked by every element
  const kept = PICKED[scheme];
  let picked = kept.get(value);
  if (picked === undefined) {
    picked = pickScheme(value, scheme);
    if (kept.size >= 512) kept.clear();
    kept.set(value, picked);
  }
  return picked;
}

const PICKED = {
  light: new Map<string, string | null>(),
  dark: new Map<string, string | null>(),
};

function pickScheme(value: string, scheme: 'light' | 'dark'): string | null {
  let out = value;
  // a branch can hold another, which the next round replaces
  for (let round = 0; round < 32; round += 1) {
    LIGHT_DARK_AT.lastIndex = 0;
    const m = LIGHT_DARK_AT.exec(out);
    if (!m) return out;
    const open = m.index + m[0].length;
    const start = open - m[1].length;
    const close = closingParen(out, open);
    if (close < 0) return null;
    const inner = out.slice(open, close);
    const comma = topLevelComma(inner);
    if (comma < 0) return null;
    const light = inner.slice(0, comma).trim();
    const dark = inner.slice(comma + 1).trim();
    if (!light || !dark || topLevelComma(dark) >= 0) return null;
    out =
      out.slice(0, start) +
      (scheme === 'dark' ? dark : light) +
      out.slice(close + 1);
  }
  return null;
}

/**
 * The scheme an element with this `color-scheme` is drawn in (CSS Color
 * Adjust 1, 2.2), given the one `preferred` — the palette's, which stands
 * for the reader's preference: that one where the element supports it,
 * else the first it names that is one, else the one `normal` gives — the
 * user agent's default, `normal`, which is the palette's own unless the
 * host says otherwise (`defaultColorScheme`). Null for a value that is not
 * a `color-scheme`.
 */
export function usedColorScheme(
  value: string,
  preferred: 'light' | 'dark' = 'light',
  normal: 'light' | 'dark' = preferred,
): 'light' | 'dark' | null {
  const words = value.trim().toLowerCase().split(/\s+/);
  if (words.length === 1 && words[0] === 'normal') return normal;
  // `[ light | dark | <custom-ident> ]+ && only?`: `only` once, first or
  // last, and never on its own
  const only = words.indexOf('only');
  if (only >= 0) {
    if (only !== 0 && only !== words.length - 1) return null;
    words.splice(only, 1);
    if (!words.length) return null;
  }
  let first: 'light' | 'dark' | null = null;
  for (const word of words) {
    if (!SCHEME_IDENT.test(word) || NOT_SCHEMES.has(word)) return null;
    if (word === preferred) return preferred;
    if (!first && (word === 'light' || word === 'dark')) first = word;
  }
  // naming none it knows, it is as though it said `normal`
  return first ?? normal;
}

/**
 * A `color-scheme` as `getComputedStyle` reads it: `normal`, or the schemes
 * it names in order — `light` and `dark` lower-cased, a custom name as
 * written — and `only` last, wherever it was written, as Chrome serialises
 * it. For a value `usedColorScheme` takes.
 */
export function colorSchemeKeywords(value: string): string {
  const words = value.trim().split(/\s+/);
  if (words.length === 1 && words[0].toLowerCase() === 'normal') {
    return 'normal';
  }
  let only = false;
  const out: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower === 'only') only = true;
    else out.push(lower === 'light' || lower === 'dark' ? lower : word);
  }
  if (only) out.push('only');
  return out.join(' ');
}

/**
 * A browser's own colours in each scheme — the system colours `Canvas`,
 * `CanvasText` and `LinkText` (CSS Color 4, 6.2), as Chrome has them, and
 * the grey its UA sheet draws a `::placeholder` in, the same in both: what
 * a document is drawn in where its root's scheme is not the palette's,
 * which has the colours of its own scheme and of no other.
 */
export const SCHEME_COLORS = {
  light: {
    canvas: '#ffffff',
    text: '#000000',
    link: '#0000ee',
    placeholder: '#757575',
  },
  dark: {
    canvas: '#121212',
    text: '#ffffff',
    link: '#9e9eff',
    placeholder: '#757575',
  },
} as const;

// --- system colours (CSS Color 4, 6.2) -------------------------------------

/**
 * The system colours, in light and in dark, as Chrome has them where the
 * platform says nothing (Blink's `LayoutTheme::DefaultSystemColor`): the
 * colours of a browser's own page and controls, which a page names to
 * look like one and which follow its colour scheme.
 */
const SYSTEM_COLORS: Record<string, readonly [string, string]> = {
  accentcolor: ['#0075ff', '#0075ff'],
  accentcolortext: ['#ffffff', '#ffffff'],
  activetext: ['#ff0000', '#ff0000'],
  buttonborder: ['#767676', '#6b6b6b'],
  buttonface: ['#efefef', '#6b6b6b'],
  buttontext: ['#000000', '#ffffff'],
  canvas: ['#ffffff', '#121212'],
  canvastext: ['#000000', '#ffffff'],
  field: ['#ffffff', '#3b3b3b'],
  fieldtext: ['#000000', '#ffffff'],
  graytext: ['#808080', '#808080'],
  highlight: ['#b3d7ff', '#99c8ff'],
  highlighttext: ['#000000', '#000000'],
  linktext: ['#0000ee', '#9e9eff'],
  mark: ['#ffff00', '#ffff00'],
  marktext: ['#000000', '#000000'],
  selecteditem: ['#b3d7ff', '#99c8ff'],
  selecteditemtext: ['#000000', '#3b3b3b'],
  visitedtext: ['#551a8b', '#d0adf0'],
};

/** A system colour as Chrome has it in a scheme, where no palette stands
 *  for the platform: what a control in the scheme that is not the
 *  palette's is drawn in. */
export function browserSystemColor(
  name: string,
  scheme: 'light' | 'dark',
): string {
  return SYSTEM_COLORS[name][scheme === 'dark' ? 1 : 0];
}

/** The deprecated system colours, each the same as one of the rest
 *  (CSS Color 4, 6.3). */
const DEPRECATED_COLORS: Record<string, string> = {
  activeborder: 'buttonborder',
  inactiveborder: 'buttonborder',
  threeddarkshadow: 'buttonborder',
  threedhighlight: 'buttonborder',
  threedlightshadow: 'buttonborder',
  threedshadow: 'buttonborder',
  windowframe: 'buttonborder',
  buttonhighlight: 'buttonface',
  buttonshadow: 'buttonface',
  threedface: 'buttonface',
  activecaption: 'canvas',
  appworkspace: 'canvas',
  background: 'canvas',
  inactivecaption: 'canvas',
  infobackground: 'canvas',
  menu: 'canvas',
  scrollbar: 'canvas',
  window: 'canvas',
  captiontext: 'canvastext',
  infotext: 'canvastext',
  menutext: 'canvastext',
  windowtext: 'canvastext',
  inactivecaptiontext: 'graytext',
};

/** The palette's colours a system colour is, in the palette's scheme. */
export interface PaletteColors {
  color: string;
  background: string;
  linkColor: string;
  surface: string;
  borderColor: string;
  mutedColor: string;
  colorScheme: 'light' | 'dark';
}

/** Which of the palette's colours each system colour is: the window's
 *  ground and ink, its links and accent, its controls'. */
const FROM_PALETTE: Record<string, keyof PaletteColors> = {
  accentcolor: 'linkColor',
  buttonborder: 'borderColor',
  buttonface: 'surface',
  buttontext: 'color',
  canvas: 'background',
  canvastext: 'color',
  field: 'background',
  fieldtext: 'color',
  graytext: 'mutedColor',
  linktext: 'linkColor',
};

/**
 * Each system colour's name, lower-cased, and the `light-dark()` it is.
 * The palette is this renderer's platform, so in the palette's scheme the
 * colours it has are its own: `Canvas` is the window's ground and
 * `CanvasText` its text, as an unstyled document is drawn. In the other
 * scheme, and in an SVG image, which has no palette, they are Chrome's.
 */
export function systemColorTable(
  palette: PaletteColors | null,
): Map<string, string> {
  const table = new Map<string, string>();
  const own = palette?.colorScheme === 'dark' ? 1 : 0;
  const pairOf = (name: string): string => {
    const pair = [...SYSTEM_COLORS[name]];
    const token = palette && FROM_PALETTE[name];
    if (token) pair[own] = palette[token] as string;
    return `light-dark(${pair[0]}, ${pair[1]})`;
  };
  for (const name of Object.keys(SYSTEM_COLORS)) table.set(name, pairOf(name));
  for (const [name, same] of Object.entries(DEPRECATED_COLORS)) {
    table.set(name, table.get(same)!);
  }
  return table;
}

/** Chrome's own, for a cascade with no palette. */
let CHROME_TABLE: Map<string, string> | null = null;

/** Whether a value names a system colour: a word of its own, not a part
 *  of a name, a path or a string. Written out, as a pattern built from the
 *  tables would be a call at load. */
export const SYSTEM_COLOR =
  /(?<![\w.#/'"-])(?:inactivecaptiontext|threedlightshadow|selecteditemtext|threeddarkshadow|accentcolortext|threedhighlight|buttonhighlight|inactivecaption|inactiveborder|infobackground|highlighttext|activecaption|buttonborder|selecteditem|activeborder|threedshadow|buttonshadow|appworkspace|accentcolor|visitedtext|windowframe|captiontext|activetext|buttonface|buttontext|canvastext|threedface|background|windowtext|fieldtext|highlight|scrollbar|graytext|linktext|marktext|infotext|menutext|canvas|window|field|mark|menu)(?![\w.(/'"-])/i;
const SYSTEM_COLOR_AT =
  /(?<![\w.#/'"-])(?:inactivecaptiontext|threedlightshadow|selecteditemtext|threeddarkshadow|accentcolortext|threedhighlight|buttonhighlight|inactivecaption|inactiveborder|infobackground|highlighttext|activecaption|buttonborder|selecteditem|activeborder|threedshadow|buttonshadow|appworkspace|accentcolor|visitedtext|windowframe|captiontext|activetext|buttonface|buttontext|canvastext|threedface|background|windowtext|fieldtext|highlight|scrollbar|graytext|linktext|marktext|infotext|menutext|canvas|window|field|mark|menu)(?![\w.(/'"-])/gi;

/** A value with each system colour in it replaced by the `light-dark()` it
 *  is, which the element's scheme then picks a branch of. */
export function systemColors(
  value: string,
  table: Map<string, string> | undefined,
): string {
  const colors = table ?? (CHROME_TABLE ??= systemColorTable(null));
  return value.replace(
    SYSTEM_COLOR_AT,
    (word) => colors.get(word.toLowerCase()) ?? word,
  );
}

const SCHEME_IDENT = /^-?(?:[a-z_]|--)[\w-]*$/;
/** What a scheme's name cannot be: the keywords the grammar has, and the
 *  CSS-wide ones, which reach here only in a list. */
const NOT_SCHEMES = new Set([
  'normal',
  'only',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'default',
]);
