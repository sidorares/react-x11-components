// The colour arithmetic under `<ColorPicker>`: parse, format, and the HSV
// round trip the field and the hue slider are drawn from.
//
// What is deliberately **not** here: `tint`, `readableInk` and `interpolate`.
// Those are core's, on `react-x11/style`, and re-implementing them here would
// be the vendoring `AGENTS.md` spent three copies of `tint` learning not to
// do. This module adds only what core has no use for — HSV, and turning a
// colour back into a string.
//
// It is private to this component today. The promotion path, if a second one
// needs it: `src/internal/color.ts` first, a `/color` subpath only if an app
// does.
import * as ntk from 'react-x11/ntk';

/**
 * The spellings this package emits.
 *
 * Deliberately shorter than CSS's list, and the reason is measured rather
 * than stylistic: ntk parses hex itself and hands everything else to
 * `parse-color`, which predates modern colour syntax. `rgb(52 152 219 / 50%)`
 * and `hsl(204 70% 53%)` are **not colours** to the renderer that would have
 * to paint them, and `oklch()` is not either. So the picker reads the modern
 * spellings (see {@link parseColor}) and writes only what can be painted.
 */
export type ColorFormat = 'hex' | 'rgb' | 'hsl';

/**
 * A colour, in both of the models the picker needs at once.
 *
 * `r`/`g`/`b` are 0–255 and `a` is 0–1, which is what a string is made of;
 * `h` is 0–360 and `s`/`v` are 0–1, which is what the field and the hue
 * slider are drawn from. Both are carried because the trip between them is
 * lossy in one direction — every grey is hue 0 — and the picker has to keep
 * the hue the user chose. See "the string is lossy" in
 * `docs/prd-color-picker.md`.
 */
export interface ColorChannels {
  /** 0–255. */
  r: number;
  /** 0–255. */
  g: number;
  /** 0–255. */
  b: number;
  /** 0–360. */
  h: number;
  /** 0–1. */
  s: number;
  /** 0–1. */
  v: number;
  /** 0–1. */
  a: number;
}

const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

const round = (n: number): number => Math.round(n);

/** 0–360, wrapped rather than clamped: hue is a circle. */
export function wrapHue(h: number): number {
  const wrapped = h % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** RGB (0–255) → HSV. Grey answers hue 0; the caller decides whether it
 *  would rather keep the hue it already had. */
export function rgbToHsv(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const span = max - min;
  let h = 0;
  if (span !== 0) {
    if (max === rn) h = ((gn - bn) / span) % 6;
    else if (max === gn) h = (bn - rn) / span + 2;
    else h = (rn - gn) / span + 4;
    h *= 60;
  }
  return { h: wrapHue(h), s: max === 0 ? 0 : span / max, v: max };
}

/** HSV → RGB (0–255, rounded). */
export function hsvToRgb(
  h: number,
  s: number,
  v: number,
): { r: number; g: number; b: number } {
  const hue = wrapHue(h) / 60;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const c = val * sat;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = val - c;
  const [r, g, b] =
    hue < 1
      ? [c, x, 0]
      : hue < 2
        ? [x, c, 0]
        : hue < 3
          ? [0, c, x]
          : hue < 4
            ? [0, x, c]
            : hue < 5
              ? [x, 0, c]
              : [c, 0, x];
  return {
    r: round((r + m) * 255),
    g: round((g + m) * 255),
    b: round((b + m) * 255),
  };
}

/** A full {@link ColorChannels} from RGBA, with an optional hue to keep when
 *  the colour itself has none — a grey dragged out of a blue is still blue's
 *  grey as far as the slider is concerned. */
export function channelsFromRgb(
  r: number,
  g: number,
  b: number,
  a = 1,
  hueHint?: number,
): ColorChannels {
  const rr = clamp(round(r), 0, 255);
  const gg = clamp(round(g), 0, 255);
  const bb = clamp(round(b), 0, 255);
  const { h, s, v } = rgbToHsv(rr, gg, bb);
  return {
    r: rr,
    g: gg,
    b: bb,
    h: s === 0 && hueHint !== undefined ? wrapHue(hueHint) : h,
    s,
    v,
    a: clamp(a, 0, 1),
  };
}

/** A full {@link ColorChannels} from HSVA. This is the direction the widget
 *  itself moves in: the model is HSV, and RGB is what falls out of it. */
export function channelsFromHsv(
  h: number,
  s: number,
  v: number,
  a = 1,
): ColorChannels {
  const hue = wrapHue(h);
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const { r, g, b } = hsvToRgb(hue, sat, val);
  return { r, g, b, h: hue, s: sat, v: val, a: clamp(a, 0, 1) };
}

// --- parsing ---------------------------------------------------------------

// #rgb, #rgba, #rrggbb, #rrggbbaa. Five and seven digits are not CSS, and are
// rejected rather than guessed at — the same call ntk's own hex parser makes.
const HEX = /^#([0-9a-f]{3,8})$/i;

/**
 * A number, a percentage, or an angle, as one of `rgb()`/`hsl()`'s arguments.
 * `scale` is what 100% means for this position.
 */
function component(text: string, scale: number): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(%|deg|grad|rad|turn)?$/i.exec(
    text.trim(),
  );
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]?.toLowerCase()) {
    case '%':
      return (n / 100) * scale;
    case 'grad':
      return (n / 400) * 360;
    case 'rad':
      return (n * 180) / Math.PI;
    case 'turn':
      return n * 360;
    default:
      return n;
  }
}

/**
 * Split a functional colour's argument list, in either syntax: legacy commas
 * (`rgb(1, 2, 3)`), or modern spaces with the alpha behind a slash
 * (`rgb(1 2 3 / 50%)`). Answers the three positional arguments and the alpha
 * separately, so the caller does not have to care which spelling it read.
 */
function args(body: string): { parts: string[]; alpha: string | null } | null {
  const [head, alpha, ...rest] = body.split('/');
  if (rest.length) return null;
  const source = head.trim();
  if (!source) return null;
  const parts = source.includes(',')
    ? source.split(',').map((p) => p.trim())
    : source.split(/\s+/);
  if (alpha !== undefined) {
    return parts.length === 3 ? { parts, alpha: alpha.trim() } : null;
  }
  // legacy `rgba(r, g, b, a)` puts the alpha in the list
  if (parts.length === 4 && source.includes(','))
    return { parts: parts.slice(0, 3), alpha: parts[3] };
  return parts.length === 3 ? { parts, alpha: null } : null;
}

function parseHex(value: string): ColorChannels | null {
  const m = HEX.exec(value);
  if (!m) return null;
  const digits = m[1];
  const short = digits.length === 3 || digits.length === 4;
  if (!short && digits.length !== 6 && digits.length !== 8) return null;
  const at = (i: number): number =>
    short
      ? parseInt(digits[i], 16) * 0x11
      : parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  const hasAlpha = digits.length === 4 || digits.length === 8;
  return channelsFromRgb(at(0), at(1), at(2), hasAlpha ? at(3) / 255 : 1);
}

/**
 * A CSS colour → channels, or null when it is not one.
 *
 * **Wider than the renderer's parser, on purpose.** A colour arriving here
 * came from a person — a clipboard, a config file, a design tool — and
 * normalizing it is what a picker is for, so the modern space-separated
 * syntax and `deg`/`turn` hues are read even though nothing can paint them
 * yet. What comes back out is another matter: see {@link formatColor}.
 *
 * Named colours are answered by ntk, which owns that table already.
 */
export function parseColor(value: string): ColorChannels | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.startsWith('#')) return parseHex(text);

  const fn = /^(rgba?|hsla?)\s*\(([^()]*)\)$/i.exec(text);
  if (fn) {
    const name = fn[1].toLowerCase();
    const split = args(fn[2]);
    if (!split) return null;
    const alpha =
      split.alpha === null ? 1 : (component(split.alpha, 1) ?? null);
    if (alpha === null) return null;
    if (name.startsWith('rgb')) {
      const rgb = split.parts.map((p) => component(p, 255));
      if (rgb.some((c) => c === null)) return null;
      const [r, g, b] = rgb as number[];
      return channelsFromRgb(r, g, b, alpha);
    }
    const h = component(split.parts[0], 360);
    const s = component(split.parts[1], 1);
    const l = component(split.parts[2], 1);
    if (h === null || s === null || l === null) return null;
    return channelsFromHsl(h, clamp(s, 0, 1), clamp(l, 0, 1), alpha);
  }

  return namedColor(text);
}

/** HSL → channels. HSL is an input and an output spelling; the widget's own
 *  model is HSV, so this converts rather than storing a third one. */
export function channelsFromHsl(
  h: number,
  s: number,
  l: number,
  a = 1,
): ColorChannels {
  const v = l + s * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  return channelsFromHsv(h, sv, v, a);
}

/** Channels → HSL, for the `hsl()` spelling and the channel fields. */
export function hslOf(c: ColorChannels): { h: number; s: number; l: number } {
  const l = c.v * (1 - c.s / 2);
  const s = l === 0 || l === 1 ? 0 : (c.v - l) / Math.min(l, 1 - l);
  return { h: c.h, s, l };
}

/**
 * A named CSS colour, through ntk's table.
 *
 * ntk exports `cssColorStraight` at runtime but it is not on
 * `react-x11/ntk`'s *typed* list — the declarations are deliberately loose
 * rather than a hand-written mirror that would drift — so it is reached off
 * the namespace, the way `src/html/resources.ts` reaches its decoder. (The
 * default export is not the namespace: ntk's is `{ createClient }` alone.)
 * Keeping the table there rather than shipping 148 names of our own is the
 * point: one list, and it is the one the renderer paints from.
 */
function namedColor(text: string): ColorChannels | null {
  const parse = (ntk as Record<string, unknown>).cssColorStraight;
  if (typeof parse !== 'function') return null;
  const rgba = (parse as (v: string) => number[] | null)(text);
  if (!rgba) return null;
  const [r, g, b, a] = rgba;
  return channelsFromRgb(r * 255, g * 255, b * 255, a);
}

/** Which spelling a string is written in, or null when it is not a colour
 *  this package writes — a named colour has no format of its own to keep. */
export function formatOf(value: string): ColorFormat | null {
  const text = value.trim();
  if (text.startsWith('#')) return 'hex';
  if (/^rgba?\s*\(/i.test(text)) return 'rgb';
  if (/^hsla?\s*\(/i.test(text)) return 'hsl';
  return null;
}

// --- formatting ------------------------------------------------------------

const hex2 = (n: number): string =>
  clamp(round(n), 0, 255).toString(16).padStart(2, '0');

/** Trim a float for display: 0.5 rather than 0.50, 70% rather than 70.0%. */
const trim = (n: number, places = 2): string =>
  String(Number(n.toFixed(places)));

/**
 * Channels → a string this renderer can paint.
 *
 * `alpha` is what decides whether transparency is spelled at all — a picker
 * without an alpha strip must not start emitting `rgba()` because the value
 * it was handed had one. Hex takes `#rrggbbaa`, which ntk parses; the
 * functional forms take the **legacy comma** spelling, which is the only one
 * `parse-color` under ntk understands.
 */
export function formatColor(
  c: ColorChannels,
  format: ColorFormat = 'hex',
  alpha = true,
): string {
  const a = alpha ? clamp(c.a, 0, 1) : 1;
  const opaque = a >= 1;
  switch (format) {
    case 'rgb':
      return opaque
        ? `rgb(${c.r}, ${c.g}, ${c.b})`
        : `rgba(${c.r}, ${c.g}, ${c.b}, ${trim(a)})`;
    case 'hsl': {
      const { h, s, l } = hslOf(c);
      const body = `${round(h)}, ${trim(s * 100, 1)}%, ${trim(l * 100, 1)}%`;
      return opaque ? `hsl(${body})` : `hsla(${body}, ${trim(a)})`;
    }
    default:
      return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${opaque ? '' : hex2(a * 255)}`;
  }
}

/** The opaque `#rrggbb` of a colour — what a swatch is filled with when the
 *  checkerboard behind it is doing the transparency. */
export function opaqueHex(c: ColorChannels): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

// --- contrast --------------------------------------------------------------

function channelLuminance(n: number): number {
  const c = n / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. Alpha is ignored — a translucent colour has no
 *  contrast of its own, only one against whatever is behind it. */
export function relativeLuminance(c: ColorChannels): number {
  return (
    0.2126 * channelLuminance(c.r) +
    0.7152 * channelLuminance(c.g) +
    0.0722 * channelLuminance(c.b)
  );
}

/** The WCAG contrast ratio between two colours, 1–21. Returns null when
 *  either is not a colour. */
export function contrastRatio(
  a: string | ColorChannels,
  b: string | ColorChannels,
): number | null {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) return null;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The grade a ratio earns for body text: 'AAA', 'AA', or 'fail'. */
export function contrastGrade(ratio: number): 'AAA' | 'AA' | 'fail' {
  return ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : 'fail';
}
