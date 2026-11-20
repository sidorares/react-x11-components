// Whether a value is a `<color>` by its grammar (CSS Color 4, 5 and 6), as
// a page's script is answered: what the cascade reads of a colour is
// lenient where a script must be told no, so a mix with no comma after its
// method, a relative colour adding a percentage to a channel, which is a
// number, or a named colour with a non-ASCII letter that lower-cases to an
// ASCII one were all taken. True for a colour, false for what is none, and
// undefined where this cannot say, which leaves the value to what the
// cascade makes of it. It refuses only what Chromium, Firefox and WebKit
// all refuse (WPT's `css/css-color/parsing/*-invalid` tests), and what
// only some take — `alpha()`, `color-layers()` — it reads as those do.
import { colorSpecified } from './borders-specified.js';
import { rgbaOf, SYSTEM_COLOR } from './color.js';
import { mathKind } from './math.js';

type Verdict = boolean | undefined;

/** False where any is, else undefined where any is, else true. */
function all(verdicts: Iterable<Verdict>): Verdict {
  let out: Verdict = true;
  for (const v of verdicts) {
    if (v === false) return false;
    if (v === undefined) out = undefined;
  }
  return out;
}

/** `text` split at `sep` at its top level, outside brackets and strings;
 *  white space when `sep` is a space. */
function split(text: string, sep: ',' | '/' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && (sep === ' ' ? /\s/.test(c) : c === sep)) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  const parts = out.map((part) => part.trim());
  return sep === ' ' ? parts.filter(Boolean) : parts;
}

/** A function's name, in lower case, and what is between its brackets,
 *  where all of `text` is one function; null where it is not. */
function functionOf(text: string): { name: string; body: string } | null {
  const head = /^([a-z][a-z0-9-]*)\(/i.exec(text);
  if (!head || !text.endsWith(')')) return null;
  let depth = 0;
  for (let i = head[0].length - 1; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && (depth -= 1) === 0 && i < text.length - 1) {
      return null;
    }
  }
  if (depth !== 0) return null;
  return {
    name: head[1].toLowerCase(),
    body: text.slice(head[0].length, -1).trim(),
  };
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;
const PERCENT = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?%$/i;
const ANGLE =
  /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?:deg|grad|rad|turn)$/i;
/** A math function's name, which a channel may be. */
const MATH =
  /^(?:calc|min|max|clamp|round|mod|rem|sin|cos|tan|asin|acos|atan2|atan|pow|sqrt|hypot|log|exp|abs|sign|progress)\(/i;
/** `none` anywhere inside a math function, which no calculation takes. */
const NONE_IN_MATH = /(?<![\w-])none(?![\w(-])/i;

/** The spaces a mix interpolates in, and which of them are polar. */
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
const HUE_METHODS = new Set(['shorter', 'longer', 'increasing', 'decreasing']);
/** `color()`'s spaces. */
const PREDEFINED = new Set([
  'srgb',
  'srgb-linear',
  'display-p3',
  'display-p3-linear',
  'a98-rgb',
  'prophoto-rgb',
  'rec2020',
  'xyz',
  'xyz-d50',
  'xyz-d65',
]);
/** A `<blend-mode>` (Compositing 1, 10), which `color-layers()` takes. */
const BLEND_MODES = new Set([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

/** Each colour function's channels, and which of them is a hue. */
const CHANNELS: Record<string, { names: string[]; hue: number }> = {
  rgb: { names: ['r', 'g', 'b'], hue: -1 },
  rgba: { names: ['r', 'g', 'b'], hue: -1 },
  hsl: { names: ['h', 's', 'l'], hue: 0 },
  hsla: { names: ['h', 's', 'l'], hue: 0 },
  hwb: { names: ['h', 'w', 'b'], hue: 0 },
  lab: { names: ['l', 'a', 'b'], hue: -1 },
  oklab: { names: ['l', 'a', 'b'], hue: -1 },
  lch: { names: ['l', 'c', 'h'], hue: 2 },
  oklch: { names: ['l', 'c', 'h'], hue: 2 },
};

/** A channel or an alpha: a number, a percentage, an angle where it is a
 *  hue, `none`, one of `keywords`, or a calculation of those, each keyword
 *  a number in it. */
function channel(token: string, hue: boolean, keywords: string[]): Verdict {
  const lower = token.toLowerCase();
  if (lower === 'none' || keywords.includes(lower)) return true;
  if (NUMBER.test(token) || PERCENT.test(token)) return true;
  if (ANGLE.test(token)) return hue;
  if (!MATH.test(token)) return token.includes('(') ? undefined : false;
  if (NONE_IN_MATH.test(token)) return false;
  const words = keywords.length
    ? new RegExp(`(?<![\\w.-])(?:${keywords.join('|')})(?![\\w(-])`, 'gi')
    : null;
  const read = words ? token.replace(words, '1') : token;
  // a name no channel has, and no constant of a calculation
  for (const m of read.matchAll(/(?<![\w.-])([a-z][a-z-]*)(?![\w(-])/gi)) {
    if (!/^(?:e|pi|infinity|nan)$/i.test(m[1])) return false;
  }
  const kind = mathKind(read);
  if (kind === undefined) return undefined;
  return kind === 'number' || kind === 'percent' || (hue && kind === 'angle');
}

/** A calculation in an absolute colour's channel: one whose types go
 *  together as a channel's, and none with `none` in it. */
function absoluteChannels(body: string): Verdict {
  const tokens = split(body, ',')
    .flatMap((part) => split(part, '/'))
    .flatMap((part) => split(part, ' '));
  return all(
    tokens
      .filter((token) => MATH.test(token))
      .map((token) => {
        if (NONE_IN_MATH.test(token)) return false;
        const kind = mathKind(token);
        if (kind === undefined) return undefined;
        return kind === 'number' || kind === 'percent' || kind === 'angle';
      }),
  );
}

/** A relative colour (CSS Color 5, 4): `from` and its origin, the space for
 *  `color()`, three channels and an alpha or none, with no commas. */
function relative(name: string, body: string): Verdict {
  if (split(body, ',').length > 1) return false;
  const slash = split(body, '/');
  if (slash.length > 2) return false;
  const words = split(slash[0], ' ');
  if (words[0]?.toLowerCase() !== 'from' || words.length < 2) return false;
  const origin = color(words[1]);
  let rest = words.slice(2);
  let spec = CHANNELS[name];
  if (name === 'color') {
    const space = rest[0]?.toLowerCase();
    if (!space) return false;
    if (space.startsWith('--')) return undefined;
    if (!PREDEFINED.has(space)) return false;
    rest = rest.slice(1);
    spec = {
      names: space.startsWith('xyz') ? ['x', 'y', 'z'] : ['r', 'g', 'b'],
      hue: -1,
    };
  }
  if (rest.length !== 3) return false;
  const keywords = [...spec.names, 'alpha'];
  const alpha = slash.length === 2 ? split(slash[1], ' ') : [];
  if (slash.length === 2 && alpha.length !== 1) return false;
  return all([
    origin,
    ...rest.map((token, i) => channel(token, i === spec.hue, keywords)),
    ...alpha.map((token) => channel(token, false, keywords)),
  ]);
}

/** `color-mix()` (CSS Color 5, 3): an interpolation method or none, then
 *  one or more colours, each with a percentage of 0 to 100 or none. */
function mix(body: string): Verdict {
  const args = split(body, ',');
  let colours = args;
  const method = split(args[0] ?? '', ' ');
  if (method[0]?.toLowerCase() === 'in') {
    colours = args.slice(1);
    const space = method[1]?.toLowerCase();
    if (!space) return false;
    if (space.startsWith('--')) return undefined;
    if (method.length === 2) {
      if (!RECTANGULAR.has(space) && !POLAR.has(space)) return false;
    } else if (
      method.length !== 4 ||
      !POLAR.has(space) ||
      !HUE_METHODS.has(method[2].toLowerCase()) ||
      method[3].toLowerCase() !== 'hue'
    ) {
      return false;
    }
  }
  if (!colours.length) return false;
  return all(
    colours.map((arg): Verdict => {
      const parts = split(arg, ' ');
      if (parts.length < 1 || parts.length > 2) return false;
      const amounts = parts.filter(
        (p) => PERCENT.test(p) || (MATH.test(p) && mathKind(p) === 'percent'),
      );
      const hues = parts.filter((p) => !amounts.includes(p));
      if (hues.length !== 1 || amounts.length > 1) return false;
      const amount = amounts[0];
      if (amount && PERCENT.test(amount)) {
        const n = parseFloat(amount);
        if (n < 0 || n > 100) return false;
      }
      return color(hues[0]);
    }),
  );
}

/** `alpha()` (CSS Color 5, 4.1): `from` a colour, then `/` and one alpha,
 *  of a number, a percentage, `none`, `alpha` or a calculation of those. */
function alphaOf(body: string): Verdict {
  const slash = split(body, '/');
  if (slash.length !== 2 || split(body, ',').length > 1) return false;
  const words = split(slash[0], ' ');
  const alpha = split(slash[1], ' ');
  if (words.length !== 2 || words[0].toLowerCase() !== 'from') return false;
  if (alpha.length !== 1) return false;
  return all([color(words[1]), channel(alpha[0], false, ['alpha'])]);
}

/** `color-layers()` (CSS Color 6, 4): a blend mode or none, then one or
 *  more colours, each one alone. */
function layers(body: string): Verdict {
  const args = split(body, ',');
  const blend = args.length > 1 && BLEND_MODES.has(args[0].toLowerCase());
  const colours = blend ? args.slice(1) : args;
  return all(
    colours.map((arg) => (split(arg, ' ').length === 1 ? color(arg) : false)),
  );
}

/** Whether `text` is one colour. */
function color(text: string): Verdict {
  const t = text.trim();
  if (!t) return false;
  // an escape is the cascade's to read
  if (t.includes('\\')) return undefined;
  // a named colour's letters are ASCII's, which no other letter folds to
  if (!/^[\t\n\f\r\x20-\x7e]*$/.test(t)) return false;
  if (t[0] === '#') return colorSpecified(t) !== null;
  if (/^[a-z][a-z-]*$/i.test(t)) {
    const lower = t.toLowerCase();
    return (
      lower === 'currentcolor' ||
      lower === 'transparent' ||
      SYSTEM_COLOR.test(t) ||
      rgbaOf(lower) !== null
    );
  }
  if (MATH.test(t)) return false;
  const fn = functionOf(t);
  if (!fn) return false;
  const { name, body } = fn;
  switch (name) {
    case 'rgb':
    case 'rgba':
    case 'hsl':
    case 'hsla':
    case 'hwb':
    case 'lab':
    case 'lch':
    case 'oklab':
    case 'oklch':
    case 'color':
      if (/^from\s/i.test(body)) return relative(name, body);
      return absoluteChannels(body) === false ? false : undefined;
    case 'color-mix':
      return mix(body);
    case 'alpha':
      return alphaOf(body);
    case 'color-layers':
      return layers(body);
    case 'light-dark': {
      const args = split(body, ',');
      return args.length === 2 ? all(args.map(color)) : false;
    }
    default:
      // `contrast-color()`, `device-cmyk()` and what this does not know
      return undefined;
  }
}

/** Whether a colour property's value is a colour; undefined where this
 *  cannot say. */
export function colorValid(value: string): Verdict {
  return color(value.replace(/\/\*[\s\S]*?\*\//g, ' '));
}

/** A `color-layers()` value as all three write it back: its blend mode in
 *  lower case and left out where it is `normal`; null where `value` is no
 *  `color-layers()`. */
export function colorLayersText(value: string): string | null {
  const fn = functionOf(value.trim());
  if (fn?.name !== 'color-layers') return null;
  const args = split(fn.body, ',');
  if (args.length > 1 && BLEND_MODES.has(args[0].toLowerCase())) {
    const mode = args[0].toLowerCase();
    args.splice(0, 1, ...(mode === 'normal' ? [] : [mode]));
  }
  return `color-layers(${args.join(', ')})`;
}
