// Grammars a page's script is answered by, for properties the cascade
// reads otherwise or not at all: what `el.style`'s setter, `setProperty`,
// `cssText` and `CSS.supports()` take of a value, and its canonical text.
// Each is null for a value its property does not take and undefined where
// it cannot say, as `specifiedValue` is, and is asked after a CSS-wide
// keyword and a substituted value have been let through. Each refuses only
// what Chromium, Firefox and WebKit all refuse, from WPT's `-invalid`
// parsing tests and the `-valid` ones beside them.
import { positionSpecified } from './backgrounds-specified.js';
import { mathNumber } from './math.js';
import { parseLength, splitValue } from './values.js';
import type { UnitContext } from './values.js';

const CHECK: UnitContext = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const MATH = /^[a-z-]+\(/i;

/** A number as CSSOM serializes one. */
function numberText(word: string): string {
  return String(Number(word));
}

/** A `<number>`, or a math function coming to one, as it serializes. */
function numberOf(word: string): string | null {
  if (NUMBER.test(word)) return numberText(word);
  if (!MATH.test(word)) return null;
  const math = mathNumber(word);
  return math === undefined ? word : math;
}

/** The text of a CSS string at the start of `text`, its escapes read, and
 *  where it ends; null where `text` starts with none or it is not closed. */
function readString(text: string): { value: string; end: number } | null {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let i = 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === quote) return { value, end: i + 1 };
    if (c === '\n') return null;
    if (c !== '\\') {
      value += c;
      continue;
    }
    const hex = /^[0-9a-f]{1,6}[ \t\n]?/i.exec(text.slice(i + 1));
    if (hex) {
      const code = parseInt(hex[0], 16);
      value +=
        code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? '\ufffd'
          : String.fromCodePoint(code);
      i += hex[0].length;
    } else if (i + 1 < text.length) {
      i += 1;
      if (text[i] !== '\n') value += text[i];
    }
  }
  return null;
}

/** A string as CSSOM serializes one. */
function stringText(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

/** Commas at the top level of a value, outside brackets and strings. */
function splitTop(text: string): string[] {
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
    else if (c === ',' && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out.map((part) => part.trim());
}

/** `normal`, or a list of a four-character tag of printable ASCII and a
 *  number for it (CSS Fonts 4, 9.3). */
function fontVariationSettings(word: string): string | null {
  if (/^normal$/i.test(word)) return 'normal';
  const out: string[] = [];
  for (const part of splitTop(word)) {
    const tag = readString(part);
    if (!tag || !/^[\x20-\x7e]{4}$/.test(tag.value)) return null;
    const rest = part.slice(tag.end).trim();
    if (!rest || /\s/.test(rest.replace(/\([^]*\)/, '()'))) return null;
    const n = numberOf(rest);
    if (n === null) return null;
    out.push(`${stringText(tag.value)} ${n}`);
  }
  return out.join(', ');
}

/** Each of `set`'s keywords at most once, and nothing else; null where a
 *  word is none of them or comes twice. */
function keywordsOf(word: string, set: ReadonlySet<string>): string[] | null {
  const words = splitValue(word).map((w) => w.toLowerCase());
  if (!words.length || new Set(words).size !== words.length) return null;
  return words.every((w) => set.has(w)) ? words : null;
}

/** `words`, in the order `order` gives them. */
function inOrder(words: readonly string[], order: readonly string[]): string {
  return order.filter((w) => words.includes(w)).join(' ');
}

/** `object-fit` (CSS Images 3, 5.5; 4, 5.5): one keyword, or `contain` or
 *  `cover` with `scale-down`, which with `contain` is `scale-down`. */
function objectFit(word: string): string | null {
  const words = keywordsOf(
    word,
    new Set(['fill', 'contain', 'cover', 'none', 'scale-down']),
  );
  if (!words || words.length > 2) return null;
  if (words.length === 1) return words[0];
  if (!words.includes('scale-down')) return null;
  const other = words.find((w) => w !== 'scale-down');
  if (other === 'contain') return 'scale-down';
  return other === 'cover' ? 'cover scale-down' : null;
}

const SYNTHESIS = ['weight', 'style', 'oblique-only', 'small-caps', 'position'];

/** `font-synthesis` (CSS Fonts 4, 7.6): `none`, or each of its kinds at
 *  most once, `style` and `oblique-only` not both, in the order CSS lists
 *  them. */
function fontSynthesis(word: string): string | null {
  if (/^none$/i.test(word)) return 'none';
  const words = keywordsOf(word, new Set(SYNTHESIS));
  if (!words || (words.includes('style') && words.includes('oblique-only'))) {
    return null;
  }
  return inOrder(words, SYNTHESIS);
}

/** `font-style` (CSS Fonts 4, 3.3): a keyword, or `oblique` and an angle,
 *  which the cascade judges. */
function fontStyle(word: string): string | null | undefined {
  const words = splitValue(word);
  const first = words[0]?.toLowerCase();
  if (words.length === 1) {
    return first === 'normal' || first === 'italic' || first === 'oblique'
      ? first
      : null;
  }
  return words.length === 2 && first === 'oblique' ? undefined : null;
}

const DECORATION_LINES = ['underline', 'overline', 'line-through', 'blink'];

/** `text-decoration-line` (CSS Text Decoration 4, 2.1): `none`, a
 *  spelling or grammar error alone, or the lines each at most once, in
 *  the order CSS lists them. */
function textDecorationLine(word: string): string | null {
  const lower = word.toLowerCase();
  if (/^(?:none|spelling-error|grammar-error)$/.test(lower)) return lower;
  const words = keywordsOf(word, new Set(DECORATION_LINES));
  return words && inOrder(words, DECORATION_LINES);
}

/** `text-overflow` (CSS Overflow 4, 4.1): one or two of `clip`,
 *  `ellipsis` and a string. */
function textOverflow(word: string): string | null | undefined {
  const words = splitValue(word);
  if (words.length < 1 || words.length > 2) return null;
  const read = words.map((w) => {
    const lower = w.toLowerCase();
    if (lower === 'clip' || lower === 'ellipsis') return lower;
    const s = readString(w);
    return s && s.end === w.length ? w : null;
  });
  if (read.some((w) => w === null)) return null;
  return words.length === 1 ? read[0] : undefined;
}

const ALIGNMENT_BASELINES = new Set([
  'baseline',
  'text-bottom',
  'alphabetic',
  'ideographic',
  'middle',
  'central',
  'mathematical',
  'text-top',
]);
const SHIFTS = new Set(['sub', 'super', 'top', 'center', 'bottom']);

/** A length or a percentage, or a calculation, as written; null for
 *  anything else. A plain 0 is a length. */
function lengthPercentage(word: string): string | null {
  if (MATH.test(word)) return word;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%$/i.test(word)) return word;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/i.exec(word);
  if (!m) return null;
  if (!m[2]) return Number(m[1]) === 0 ? '0px' : null;
  return parseLength(`1${m[2]}`, CHECK) === null ? null : word;
}

/** `vertical-align` (CSS Inline 3, 4.2): a baseline source, an alignment
 *  baseline and a shift, each at most once and in any order, written
 *  back in that order with `baseline` and a shift of nought left out. */
function verticalAlign(word: string): string | null {
  const words = splitValue(word);
  if (!words.length || words.length > 3) return null;
  let source: string | null = null;
  let alignment: string | null = null;
  let shift: string | null = null;
  for (const w of words) {
    const lower = w.toLowerCase();
    if (lower === 'first' || lower === 'last') {
      if (source) return null;
      source = lower;
    } else if (ALIGNMENT_BASELINES.has(lower)) {
      if (alignment) return null;
      alignment = lower;
    } else {
      if (shift) return null;
      shift = SHIFTS.has(lower) ? lower : lengthPercentage(w);
      if (shift === null) return null;
    }
  }
  if (shift !== null && /^[+-]?0(?:\.0*)?(?:[a-z]+)?$/i.test(shift)) {
    shift = null;
  }
  const out = [source, alignment === 'baseline' ? null : alignment, shift];
  return out.filter(Boolean).join(' ') || 'baseline';
}

const OUTER = new Set(['block', 'inline', 'run-in']);
const INNER = new Set([
  'flow',
  'flow-root',
  'table',
  'flex',
  'grid',
  'ruby',
  'grid-lanes',
  'math',
]);

/** `display` of more than one word (CSS Display 3, 2): an outer type, an
 *  inner one and `list-item`, each at most once, `list-item` only with
 *  `flow` or `flow-root`, written back in its shortest form. One word is
 *  the cascade's to judge, but `flow`, which is `block`. */
function display(word: string): string | null | undefined {
  const words = splitValue(word).map((w) => w.toLowerCase());
  if (words.length === 1) return words[0] === 'flow' ? 'block' : undefined;
  if (words.length > 3 || new Set(words).size !== words.length) return null;
  let outer = 'block';
  let inner = 'flow';
  let listItem = false;
  let saidOuter = false;
  let saidInner = false;
  for (const w of words) {
    if (w === 'list-item') listItem = true;
    else if (OUTER.has(w) && !saidOuter) [outer, saidOuter] = [w, true];
    else if (INNER.has(w) && !saidInner) [inner, saidInner] = [w, true];
    else return null;
  }
  if (listItem) {
    if (inner !== 'flow' && inner !== 'flow-root') return null;
    return [
      outer === 'block' ? null : outer,
      inner === 'flow' ? null : inner,
      'list-item',
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (outer === 'run-in')
    return inner === 'flow' ? 'run-in' : `run-in ${inner}`;
  if (outer === 'block') {
    if (inner === 'flow') return 'block';
    return inner === 'ruby' || inner === 'math' ? `block ${inner}` : inner;
  }
  switch (inner) {
    case 'flow':
      return 'inline';
    case 'flow-root':
      return 'inline-block';
    case 'ruby':
      return 'ruby';
    case 'grid-lanes':
      return 'inline grid-lanes';
    case 'math':
      return 'math';
    default:
      return `inline-${inner}`;
  }
}

/** `opacity` (CSS Color 4, 6.2): a number, or a percentage, which is the
 *  number it stands for; a calculation is the cascade's. */
function opacity(word: string): string | null | undefined {
  if (MATH.test(word)) return undefined;
  if (NUMBER.test(word)) return numberText(word);
  const pct = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)%$/i.exec(word);
  return pct ? String(Number(pct[1]) / 100) : null;
}

/** `image-orientation` (CSS Images 3, 5.3): `from-image` or `none`; the
 *  angles of an earlier draft are no longer taken. */
function imageOrientation(word: string): string | null {
  const lower = word.toLowerCase();
  return lower === 'from-image' || lower === 'none' ? lower : null;
}

/** `caret-color` (CSS UI 4, 6.2.2): `auto`, a colour, or a colour and
 *  `auto` after it; which words are colours is the cascade's to say. */
function caretColor(word: string): null | undefined {
  const words = splitValue(word);
  if (words.length === 1) {
    return /^[+-]?[\d.]/.test(words[0]) ? null : undefined;
  }
  return words.length === 2 &&
    words[1].toLowerCase() === 'auto' &&
    words[0].toLowerCase() !== 'auto' &&
    !/^[+-]?[\d.]/.test(words[0])
    ? undefined
    : null;
}

/** One keyword of a few, in lower case. */
const oneOf =
  (...words: string[]) =>
  (word: string): string | null => {
    const lower = word.toLowerCase();
    return words.includes(lower) ? lower : null;
  };

/** `initial-letter` (CSS Inline 3, 7.2): `normal`, or a size of 1 or more
 *  with a sink of 1 or more, `drop` or `raise` after it or none, written
 *  back size first. */
function initialLetter(word: string): string | null {
  const words = splitValue(word).map((w) => w.toLowerCase());
  if (words.length === 1 && words[0] === 'normal') return 'normal';
  if (!words.length || words.length > 2) return null;
  const sinks: string[] = words.filter((w) => w === 'drop' || w === 'raise');
  const numbers = words.filter((w) => !sinks.includes(w));
  if (sinks.length > 1 || numbers.length < 1) return null;
  const atLeastOne = (w: string): boolean =>
    MATH.test(w) || (NUMBER.test(w) && Number(w) >= 1);
  if (!numbers.every(atLeastOne)) return null;
  return [...numbers, ...sinks].join(' ');
}

/** `hanging-punctuation` (CSS Text 3, 8.2): `none`, or `first`, `last`
 *  and one of `force-end` and `allow-end`, each at most once, as written. */
function hangingPunctuation(word: string): string | null {
  if (/^none$/i.test(word)) return 'none';
  const words = keywordsOf(
    word,
    new Set(['first', 'last', 'force-end', 'allow-end']),
  );
  if (!words || (words.includes('force-end') && words.includes('allow-end'))) {
    return null;
  }
  return words.join(' ');
}

/** `text-decoration-skip-spaces` (CSS Text Decoration 4, 2.8): `none`,
 *  `all`, or `start` and `end`, either or both, in that order. */
function skipSpaces(word: string): string | null {
  const lower = word.toLowerCase();
  if (lower === 'none' || lower === 'all') return lower;
  const words = keywordsOf(word, new Set(['start', 'end']));
  return words && inOrder(words, ['start', 'end']);
}

/** `block-ellipsis` (CSS Overflow 4, 5.4): `no-ellipsis`, `ellipsis` or a
 *  string. */
function blockEllipsis(word: string): string | null {
  const lower = word.toLowerCase();
  if (lower === 'no-ellipsis' || lower === 'ellipsis') return lower;
  const s = readString(word);
  return s && s.end === word.length ? word : null;
}

/** The properties read here, by name. */
export const GRAMMARS: Readonly<
  Record<string, (word: string) => string | null | undefined>
> = {
  'font-variation-settings': fontVariationSettings,
  // a `<position>` of CSS Values 4, which has no three-value form
  'object-position': (word) => positionSpecified(splitValue(word)),
  'object-fit': objectFit,
  'font-synthesis': fontSynthesis,
  'font-style': fontStyle,
  'text-decoration-line': textDecorationLine,
  'text-overflow': textOverflow,
  'vertical-align': verticalAlign,
  display,
  opacity,
  'image-orientation': imageOrientation,
  'caret-color': caretColor,
  'initial-letter': initialLetter,
  'baseline-source': oneOf('auto', 'first', 'last'),
  'text-group-align': oneOf('none', 'start', 'end', 'left', 'right', 'center'),
  'hanging-punctuation': hangingPunctuation,
  'text-decoration-skip-spaces': skipSpaces,
  'block-ellipsis': blockEllipsis,
  'scroll-marker-group': oneOf('none', 'before', 'after'),
};
