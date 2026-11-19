// Whether a gradient is written as CSS Images 4 has it (3.1–3.3), for a
// layer that is to take it or leave the declaration: what comes before the
// stops — a direction, a shape and size, a centre, a colour interpolation
// method — and the stops and hints. True or false where that is clear,
// undefined where this does not read what the value holds: a prefixed
// gradient, whose grammar is another, a math function, a colour function
// this does not know, a gradient of fewer than two stops, which Images 4
// allows and browsers do not all take yet.

import { parseColor, parseLength, splitCommas, splitValue } from './values.js';
import type { UnitContext } from './values.js';
import { SYSTEM_COLOR } from './color.js';

const CHECK: UnitContext = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };

const GRADIENT = /^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/i;

/** What this does not read, and leaves to the gradient's own parse. */
const UNREAD =
  /(?<![\w-])(?:calc|min|max|clamp|sign|abs|round|mod|rem|progress|var|env|attr|alpha|color-layers|contrast-color|light-dark|color-mix)\(|\\|\/\*/i;

const RECTANGULAR = new Set([
  'srgb',
  'srgb-linear',
  'display-p3',
  'display-p3-linear',
  'a98-rgb',
  'prophoto-rgb',
  'rec2020',
  'lab',
  'oklab',
  'xyz',
  'xyz-d50',
  'xyz-d65',
]);
const POLAR = new Set(['hsl', 'hwb', 'lch', 'oklch']);
const HUES = new Set(['shorter', 'longer', 'increasing', 'decreasing']);
const SIDES_X = new Set(['left', 'right']);
const SIDES_Y = new Set(['top', 'bottom']);
const EXTENTS = new Set([
  'closest-side',
  'closest-corner',
  'farthest-side',
  'farthest-corner',
]);

type Answer = boolean | undefined;

/** Whether a value is an unprefixed gradient written as Images 4 has it;
 *  undefined for any other value, or one this does not read. */
export function gradientSyntax(value: string): Answer {
  const m = GRADIENT.exec(value.trim());
  if (!m) return undefined;
  if (UNREAD.test(m[3])) return undefined;
  const kind = m[2].toLowerCase() as 'linear' | 'radial' | 'conic';
  const args = splitCommas(m[3]).map((a) => a.trim());
  if (args.some((a) => !a)) return false;
  let stops = args;
  if (!stopLike(args[0], kind)) {
    const prelude = preludeOk(kind, splitValue(args[0].toLowerCase()));
    if (prelude !== true) return prelude;
    stops = args.slice(1);
  }
  if (stops.length < 2) return stops.length ? undefined : false;
  return stopsOk(stops, kind);
}

/** Whether an argument starts as a colour stop or a hint does: anything but
 *  the words and lengths a gradient's first argument is made of. */
function stopLike(arg: string, kind: string): boolean {
  const words = splitValue(arg.toLowerCase());
  const first = words[0];
  if (first === 'in' || first === 'to' || first === 'at') return false;
  if (kind === 'conic' && first === 'from') return false;
  // an angle or a size with no colour beside it, which no stop is
  if (kind === 'linear' && angle(first) !== null) return colourAt(words) >= 0;
  if (kind === 'radial') {
    if (first === 'circle' || first === 'ellipse' || EXTENTS.has(first)) {
      return false;
    }
    if (length(first) !== null) return colourAt(words) >= 0;
  }
  return true;
}

/** The first index of a word that is a colour, or -1. */
function colourAt(words: string[]): number {
  return words.findIndex((w) => colour(w) === true);
}

/** A `<color-interpolation-method>` at the start of `words`: how many words
 *  it takes, or -1 where it is none or is written wrong. */
function method(words: string[], at: number): number {
  if (words[at] !== 'in') return 0;
  const space = words[at + 1];
  if (space === undefined) return -1;
  if (RECTANGULAR.has(space)) return 2;
  if (!POLAR.has(space)) return -1;
  if (HUES.has(words[at + 2] ?? '') && words[at + 3] === 'hue') return 4;
  return 2;
}

/** Whether what comes before the stops is the gradient's: its own part, a
 *  colour interpolation method before it or after it, each at most once. */
function preludeOk(kind: string, words: string[]): Answer {
  let seenMethod = false;
  let rest = words;
  const first = method(rest, 0);
  if (first < 0) return false;
  if (first) {
    seenMethod = true;
    rest = rest.slice(first);
  } else {
    const at = rest.indexOf('in');
    if (at >= 0) {
      const n = method(rest, at);
      if (n < 0 || at + n !== rest.length) return false;
      seenMethod = true;
      rest = rest.slice(0, at);
    }
  }
  if (!rest.length) return seenMethod;
  if (rest.includes('in')) return false;
  if (kind === 'linear') return direction(rest);
  if (kind === 'radial') return radial(rest);
  return conic(rest);
}

/** A linear gradient's direction: an angle, or `to` a side or a corner. */
function direction(words: string[]): Answer {
  if (words.length === 1) return angle(words[0]) !== null;
  if (words[0] !== 'to' || words.length > 3) return false;
  const sides = words.slice(1);
  const xs = sides.filter((w) => SIDES_X.has(w)).length;
  const ys = sides.filter((w) => SIDES_Y.has(w)).length;
  return xs + ys === sides.length && xs <= 1 && ys <= 1;
}

/** A radial gradient's shape and size, then `at` its centre. */
function radial(words: string[]): Answer {
  const at = words.indexOf('at');
  const ending = at < 0 ? words : words.slice(0, at);
  if (at >= 0 && !position(words.slice(at + 1))) return false;
  if (!ending.length) return at >= 0;
  let shape = '';
  const sizes: string[] = [];
  for (const w of ending) {
    if (w === 'circle' || w === 'ellipse') {
      if (shape) return false;
      shape = w;
    } else sizes.push(w);
  }
  if (!sizes.length) return true;
  if (sizes.length === 1 && EXTENTS.has(sizes[0])) return true;
  if (sizes.some((w) => EXTENTS.has(w))) return false;
  const lens = sizes.map(length);
  if (lens.some((l) => l === null || l < 0)) return false;
  if (sizes.length === 1) {
    // a circle's radius is a length, and only a circle has one
    return shape !== 'ellipse' && !sizes[0].endsWith('%');
  }
  return sizes.length === 2 && shape !== 'circle';
}

/** A conic gradient's `from` an angle and `at` its centre, in that order. */
function conic(words: string[]): Answer {
  let rest = words;
  if (rest[0] === 'from') {
    if (rest[1] === undefined || angle(rest[1]) === null) return false;
    rest = rest.slice(2);
  }
  if (!rest.length) return true;
  if (rest[0] !== 'at') return false;
  return position(rest.slice(1));
}

/** A `<position>` (CSS Values 4, 9.2): one or two values, a keyword or a
 *  length-percentage each, or four, two keywords each with an offset. */
function position(words: string[]): boolean {
  const lp = (w: string) => length(w) !== null;
  const x = (w: string) => SIDES_X.has(w) || w === 'center';
  const y = (w: string) => SIDES_Y.has(w) || w === 'center';
  if (words.length === 1) return x(words[0]) || y(words[0]) || lp(words[0]);
  if (words.length === 2) {
    const [a, b] = words;
    if ((x(a) || lp(a)) && (y(b) || lp(b))) return true;
    return y(a) && x(b);
  }
  if (words.length === 4) {
    const [a, b, c, d] = words;
    if (!lp(b) || !lp(d) || a === 'center' || c === 'center') return false;
    return (
      (SIDES_X.has(a) && SIDES_Y.has(c)) || (SIDES_Y.has(a) && SIDES_X.has(c))
    );
  }
  return false;
}

/** Whether the stops and hints are a gradient's: each stop a colour and up
 *  to two positions, each hint a position alone between two stops. */
function stopsOk(args: string[], kind: string): Answer {
  const at = kind === 'conic' ? anglePercentage : lengthPercentage;
  let hint = true;
  let unknown = false;
  for (let i = 0; i < args.length; i += 1) {
    const words = splitValue(args[i]);
    if (words.length === 1 && at(words[0])) {
      // a hint: not first, not last, not after another
      if (hint || i === args.length - 1) return false;
      hint = true;
      continue;
    }
    const c = colourAt(words.map((w) => w.toLowerCase()));
    const which = c >= 0 ? c : words.findIndex((w) => colour(w) === undefined);
    if (which < 0) return false;
    if (c < 0) unknown = true;
    const positions = words.filter((_, j) => j !== which);
    if (positions.length > 2) return false;
    // the positions follow the colour, or come before it, all together
    if (which !== 0 && which !== words.length - 1) return false;
    if (!positions.every(at)) return false;
    hint = false;
  }
  return unknown ? undefined : true;
}

/** Whether a word is a colour; undefined for a function this leaves to the
 *  colour parser to know. */
function colour(word: string): Answer {
  const w = word.toLowerCase();
  if (w === 'currentcolor' || w === 'transparent') return true;
  if (SYSTEM_COLOR.test(w)) return true;
  if (parseColor(w) !== null) return true;
  if (
    /^[a-z-]+\(/.test(w) &&
    !/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/.test(w)
  ) {
    return undefined;
  }
  return false;
}

/** An angle, in degrees, or null: a zero may be written bare. */
function angle(word: string): number | null {
  const m =
    /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i.exec(
      word,
    );
  if (!m) return null;
  const n = Number(m[1]);
  if (!m[2]) return n === 0 ? 0 : null;
  return n;
}

function anglePercentage(word: string): boolean {
  return (
    angle(word) !== null ||
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%$/.test(word)
  );
}

function lengthPercentage(word: string): boolean {
  return length(word) !== null;
}

/** A length or a percentage as a number of its unit, or null. */
function length(word: string): number | null {
  const len = parseLength(word, CHECK);
  if (len === null || len === 'auto') return null;
  if (typeof len === 'number') return len;
  return len.px ? null : len.pct;
}

/** Whether a `cross-fade()` is written as CSS Images 4 has it (2.6): each
 *  image with a percentage of 0 to 100, or none; undefined for any other
 *  value, or one this does not read. */
export function crossFadeSyntax(value: string): Answer {
  const m = /^cross-fade\(([\s\S]*)\)$/i.exec(value.trim());
  if (!m) return undefined;
  if (UNREAD.test(m[1])) return undefined;
  const args = splitCommas(m[1]).map((a) => a.trim());
  if (!args.length || args.some((a) => !a)) return false;
  for (const arg of args) {
    const words = splitValue(arg);
    const amounts = words.filter(
      (w) =>
        !/^(?:url|image|[a-z-]+-gradient|image-set|cross-fade)\(/i.test(w) &&
        colour(w) !== true,
    );
    if (amounts.length > 1) return false;
    if (amounts.length === 1) {
      const p = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(amounts[0]);
      if (!p || Number(p[1]) < 0 || Number(p[1]) > 100) return false;
    }
  }
  return true;
}
