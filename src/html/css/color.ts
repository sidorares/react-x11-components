import * as ntk from 'react-x11/ntk';
import { parseMathNumber } from './calc.js';
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

/** A colour as gamma-encoded sRGB, unclipped, and its alpha. */
interface Rgba {
  rgb: Triple;
  a: number;
}

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
  if (RELATIVE.test(body)) return relative(name, body);

  let channels: Component[];
  let alpha: Component | null = null;
  let space = '';
  if (body.includes(',')) {
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
  if (alpha) {
    if (alpha.unit !== '' && alpha.unit !== '%' && alpha.unit !== 'none') {
      return null;
    }
    a = clamp01(alpha.unit === '%' ? alpha.value / 100 : alpha.value);
  }
  const rgb = toSrgb(name, space, channels);
  return rgb ? { rgb, a } : null;
}

const LEGACY = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

/** A space-separated list's items, a function's arguments kept whole. */
function words(text: string): string[] {
  return topLevelParts(text.trim(), ' ').filter(Boolean);
}

/** A channel: a number, a percentage, an angle or `none`, or a math
 *  function standing for a number — `rgb(calc(255 / 2) 0 0)`. */
function channel(token: string): Component | null {
  if (!token.includes('(')) return component(token);
  const n = parseMathNumber(token);
  return n === null ? null : { value: n, unit: '' };
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
  const coords = originIn(name, space, origin.rgb);
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
  if (slash.length === 2) {
    const token = words(slash[1]);
    if (token.length !== 1) return null;
    const alpha = relativeChannel(token[0], known);
    if (!alpha || alpha.unit === 'deg' || alpha.unit === 'grad') return null;
    if (alpha.unit === 'rad' || alpha.unit === 'turn') return null;
    a = clamp01(alpha.unit === '%' ? alpha.value / 100 : alpha.value);
  }
  const rgb = toSrgb(name, space, channels);
  return rgb ? { rgb, a } : null;
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
 *  ranges its keywords take. */
function originIn(name: string, space: string, rgb: Triple): Triple | null {
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

/** The colour in gamma-encoded sRGB, each channel from 0 to 1 (before
 *  clipping), or null where a channel is not one its function takes. */
function toSrgb(name: string, space: string, c: Component[]): Triple | null {
  switch (name) {
    case 'rgb':
    case 'rgba': {
      const r = amount(c[0], 255);
      const g = amount(c[1], 255);
      const b = amount(c[2], 255);
      if (r === null || g === null || b === null) return null;
      return [r / 255, g / 255, b / 255];
    }
    case 'hsl':
    case 'hsla': {
      const h = hue(c[0]);
      const s = amount(c[1], 100);
      const l = amount(c[2], 100);
      if (h === null || s === null || l === null) return null;
      return hslToRgb(h, clamp01(s / 100), clamp01(l / 100));
    }
    case 'hwb': {
      const h = hue(c[0]);
      const w = amount(c[1], 100);
      const b = amount(c[2], 100);
      if (h === null || w === null || b === null) return null;
      return hwbToRgb(h, clamp01(w / 100), clamp01(b / 100));
    }
    case 'lab':
    case 'lch': {
      const l = amount(c[0], 100);
      if (l === null) return null;
      let a: number | null;
      let b: number | null;
      if (name === 'lab') {
        a = amount(c[1], 125);
        b = amount(c[2], 125);
      } else {
        const chroma = amount(c[1], 150);
        const h = hue(c[2]);
        if (chroma === null || h === null) return null;
        [a, b] = polar(Math.max(0, chroma), h);
      }
      if (a === null || b === null) return null;
      // the gamut mapping CSS draws with takes a lightness at either end to
      // white or black, whatever its chroma (CSS Color 4 13.2)
      if (l >= 100) return [1, 1, 1];
      if (l <= 0) return [0, 0, 0];
      const xyz = labToXyzD50(l, a, b);
      return gamma(multiply(XYZ_TO_LINEAR_SRGB, multiply(D50_TO_D65, xyz)));
    }
    case 'oklab':
    case 'oklch': {
      const l = amount(c[0], 1);
      if (l === null) return null;
      let a: number | null;
      let b: number | null;
      if (name === 'oklab') {
        a = amount(c[1], 0.4);
        b = amount(c[2], 0.4);
      } else {
        const chroma = amount(c[1], 0.4);
        const h = hue(c[2]);
        if (chroma === null || h === null) return null;
        [a, b] = polar(Math.max(0, chroma), h);
      }
      if (a === null || b === null) return null;
      if (l >= 1) return [1, 1, 1];
      if (l <= 0) return [0, 0, 0];
      return gamma(oklabToLinearSrgb(l, a, b));
    }
    case 'color': {
      const v: number[] = [];
      for (const channel of c) {
        const x = amount(channel, 1);
        if (x === null) return null;
        v.push(x);
      }
      return predefined(space, v as Triple);
    }
    default:
      return null;
  }
}

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

/** `color-mix(in <space> [<hue> hue]?, <colour> <p>?, <colour> <p>?)`: the
 *  two colours in `space`, premultiplied, weighted by their percentages. */
function mix(body: string): Rgba | null {
  const parts = topLevelParts(body, ',');
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
  const x = toSpace(space, first.colour.rgb);
  const y = toSpace(space, second.colour.rgb);
  if (!x || !y) return null;
  const a1 = first.colour.a;
  const a2 = second.colour.a;
  const alpha = a1 * (1 - t) + a2 * t;
  const hueAt = HUE[space] ?? -1;
  const out: Triple = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    if (i === hueAt) {
      out[i] = mixHue(x[i], y[i], t, method);
    } else {
      // premultiplied, so a transparent side lends its alpha and not its
      // colour: Tailwind's `bg-blue-500/50` is blue, half as opaque
      const v = x[i] * a1 * (1 - t) + y[i] * a2 * t;
      out[i] = alpha === 0 ? 0 : v / alpha;
    }
  }
  const rgb = fromSpace(space, out);
  // percentages that come to less than 100% take their share of the alpha
  return rgb ? { rgb, a: alpha * Math.min(1, sum / 100) } : null;
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
      return null;
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
      return null;
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
