// Generated content (CSS 2.1 12): what `content`, `counter-reset`,
// `counter-increment` and `quotes` compute to, and the styles a counter is
// written in. Resolving them against a document — which counter is in scope
// where, how deep the quotes are — is the box builder's, because it is a walk
// in document order and the builder is that walk.

/** One part of a `content` value, in the order it was written. */
export type ContentItem =
  | { kind: 'string'; text: string }
  | { kind: 'attr'; name: string }
  | { kind: 'counter'; name: string; style: string }
  | { kind: 'counters'; name: string; separator: string; style: string }
  | {
      kind: 'open-quote' | 'close-quote' | 'no-open-quote' | 'no-close-quote';
    };

/** One name in a `counter-reset` or `counter-increment`, with its number. */
export interface CounterChange {
  name: string;
  value: number;
}

/** English's quotation marks, outer pair first: `quotes`' initial value,
 *  which CSS 2.1 leaves to the user agent. */
export const DEFAULT_QUOTES: readonly string[] = ['“', '”', '‘', '’'];

type Token =
  | { kind: 'string'; text: string }
  | { kind: 'ident'; name: string }
  | { kind: 'function'; name: string; args: Token[][] }
  | { kind: 'number'; value: number };

/**
 * `content`: `normal`, `none`, or its items. An image — `url()` — is dropped
 * rather than the declaration, since the rest of the value still says
 * something; the other items are CSS 2.1's. Null when the value cannot be
 * read, which drops the declaration, as CSS does.
 */
export function parseContent(
  value: string,
): ContentItem[] | 'normal' | 'none' | null {
  const tokens = tokenize(value);
  if (!tokens?.length) return null;
  if (tokens.length === 1 && tokens[0].kind === 'ident') {
    const name = tokens[0].name.toLowerCase();
    if (name === 'normal' || name === 'none') return name;
  }
  const items: ContentItem[] = [];
  for (const token of tokens) {
    if (token.kind === 'string') {
      items.push({ kind: 'string', text: token.text });
    } else if (token.kind === 'ident') {
      const name = token.name.toLowerCase();
      if (
        name === 'open-quote' ||
        name === 'close-quote' ||
        name === 'no-open-quote' ||
        name === 'no-close-quote'
      ) {
        items.push({ kind: name });
      } else return null;
    } else if (token.kind === 'function') {
      const item = contentFunction(token);
      if (item === null) return null;
      if (item !== 'skip') items.push(item);
    } else return null;
  }
  return items;
}

function contentFunction(
  token: Extract<Token, { kind: 'function' }>,
): ContentItem | 'skip' | null {
  const name = token.name.toLowerCase();
  const args = token.args;
  const ident = (i: number): string | null => {
    const arg = args[i];
    return arg?.length === 1 && arg[0].kind === 'ident' ? arg[0].name : null;
  };
  if (name === 'url') return 'skip';
  if (name === 'attr') {
    const attr = ident(0);
    // an HTML attribute's name is case-insensitive, and the DOM keeps it
    // lower case
    return attr && args.length === 1
      ? { kind: 'attr', name: attr.toLowerCase() }
      : null;
  }
  if (name === 'counter') {
    const counter = ident(0);
    if (!counter || args.length > 2) return null;
    const style = args.length > 1 ? ident(1) : 'decimal';
    return style
      ? { kind: 'counter', name: counter, style: style.toLowerCase() }
      : null;
  }
  if (name === 'counters') {
    const counter = ident(0);
    const separator = args[1];
    if (
      !counter ||
      args.length < 2 ||
      args.length > 3 ||
      separator.length !== 1 ||
      separator[0].kind !== 'string'
    ) {
      return null;
    }
    const style = args.length > 2 ? ident(2) : 'decimal';
    return style
      ? {
          kind: 'counters',
          name: counter,
          separator: separator[0].text,
          style: style.toLowerCase(),
        }
      : null;
  }
  return null;
}

/**
 * `counter-reset` and `counter-increment`: `none`, or names each followed by
 * an optional integer — `fallback` where there is none, 0 for a reset and 1
 * for an increment. Null when the value cannot be read.
 */
export function parseCounterList(
  value: string,
  fallback: number,
): CounterChange[] | 'none' | null {
  const tokens = tokenize(value);
  if (!tokens?.length) return null;
  if (
    tokens.length === 1 &&
    tokens[0].kind === 'ident' &&
    tokens[0].name.toLowerCase() === 'none'
  ) {
    return 'none';
  }
  const out: CounterChange[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== 'ident') return null;
    // CSS-wide keywords and `none` cannot name a counter
    const lower = token.name.toLowerCase();
    if (
      lower === 'none' ||
      lower === 'inherit' ||
      lower === 'initial' ||
      lower === 'unset'
    ) {
      return null;
    }
    const next = tokens[i + 1];
    if (next?.kind === 'number') {
      if (!Number.isInteger(next.value)) return null;
      out.push({ name: token.name, value: next.value });
      i += 1;
    } else {
      out.push({ name: token.name, value: fallback });
    }
  }
  return out;
}

/** `quotes`: `none`, or pairs of strings, outermost first. Null when the
 *  value cannot be read — an odd number of strings among them. */
export function parseQuotes(value: string): string[] | 'none' | null {
  const tokens = tokenize(value);
  if (!tokens?.length) return null;
  if (
    tokens.length === 1 &&
    tokens[0].kind === 'ident' &&
    tokens[0].name.toLowerCase() === 'none'
  ) {
    return 'none';
  }
  if (tokens.length % 2 !== 0) return null;
  const out: string[] = [];
  for (const token of tokens) {
    if (token.kind !== 'string') return null;
    out.push(token.text);
  }
  return out;
}

/** The mark an `open-quote` (side 0) or `close-quote` (side 1) at a nesting
 *  depth writes: the pair for that depth, or the innermost pair past it. */
export function quoteAt(
  quotes: readonly string[] | 'none',
  depth: number,
  side: 0 | 1,
): string {
  if (quotes === 'none' || quotes.length < 2) return '';
  const pair = Math.min(depth, quotes.length / 2 - 1);
  return quotes[pair * 2 + side];
}

// --- counter styles -----------------------------------------------------------

const GREEK = 'αβγδεζηθικλμνξοπρστυφχψω';

/** The Armenian and Georgian letters by place and digit — units, tens,
 *  hundreds, thousands — as CSS Counter Styles 3 tabulates them. */
const ARMENIAN = ['ԱԲԳԴԵԶԷԸԹ', 'ԺԻԼԽԾԿՀՁՂ', 'ՃՄՅՆՇՈՉՊՋ', 'ՌՍՎՏՐՑՒՓՔ'];
const GEORGIAN = ['აბგდევზჱთ', 'იკლმნჲოპჟ', 'რსტჳფქღყშ', 'ჩცძწჭხჴჯჰ'];

/**
 * A counter's value written in a list style. A value a style has no form for
 * — below 1 in an alphabetic one, past 3,999 in Roman numerals — falls back
 * to decimal, as CSS Counter Styles 3 has every such style do.
 */
export function counterText(n: number, style: string): string {
  switch (style) {
    case 'none':
      return '';
    case 'disc':
      return '•';
    case 'circle':
      return '◦';
    case 'square':
      return '▪';
    case 'decimal-leading-zero': {
      const digits = String(Math.abs(n));
      return `${n < 0 ? '-' : ''}${digits.length < 2 ? '0' : ''}${digits}`;
    }
    case 'lower-roman':
    case 'upper-roman': {
      if (n < 1 || n > 3999) return String(n);
      const out = roman(n);
      return style === 'upper-roman' ? out : out.toLowerCase();
    }
    case 'lower-alpha':
    case 'lower-latin':
      return n < 1 ? String(n) : alphabetic(n, 'abcdefghijklmnopqrstuvwxyz');
    case 'upper-alpha':
    case 'upper-latin':
      return n < 1 ? String(n) : alphabetic(n, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    case 'lower-greek':
      return n < 1 ? String(n) : alphabetic(n, GREEK);
    case 'armenian':
    case 'upper-armenian':
      return n < 1 || n > 9999 ? String(n) : placed(n, ARMENIAN);
    case 'georgian':
      return n < 1 || n > 19999
        ? String(n)
        : n >= 10000
          ? 'ჵ' + (n > 10000 ? placed(n - 10000, GEORGIAN) : '')
          : placed(n, GEORGIAN);
    default:
      return String(n);
  }
}

/** A bijective base-`letters.length` numeral: a, b, … z, aa, ab. */
function alphabetic(n: number, letters: string): string {
  const symbols = [...letters];
  let out = '';
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % symbols.length;
    out = symbols[rem] + out;
    v = Math.floor((v - 1) / symbols.length);
  }
  return out;
}

const ROMAN: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function roman(n: number): string {
  let v = n;
  let out = '';
  for (const [value, sym] of ROMAN) {
    while (v >= value) {
      out += sym;
      v -= value;
    }
  }
  return out;
}

/** An additive numeral with one letter per nonzero place, largest first. */
function placed(n: number, places: string[]): string {
  let out = '';
  for (let place = places.length - 1; place >= 0; place -= 1) {
    const digit = Math.floor(n / 10 ** place) % 10;
    if (digit) out += [...places[place]][digit - 1];
  }
  return out;
}

// --- the tokenizer ------------------------------------------------------------

/**
 * A value as strings, identifiers, numbers and functions with their
 * comma-separated arguments. Null when a character belongs to none of them.
 * The declaration reaching here has had its comments removed by the
 * stylesheet parser.
 */
function tokenize(value: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  const n = value.length;
  const read = (stopAt: string): Token[] | null => {
    const tokens: Token[] = [];
    while (i < n) {
      const c = value[i];
      if (/\s/.test(c)) {
        i += 1;
        continue;
      }
      if (stopAt.includes(c)) return tokens;
      if (c === '"' || c === "'") {
        const text = readString(c);
        if (text === null) return null;
        tokens.push({ kind: 'string', text });
        continue;
      }
      if (
        /[0-9+\-.]/.test(c) &&
        /^[+-]?(\d+\.?\d*|\.\d+)/.test(value.slice(i))
      ) {
        const m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(value.slice(i))!;
        // a name can start with `-`, and `-foo` is not a number
        if (!/[a-zA-Z_\\]/.test(value[i + m[0].length] ?? '')) {
          tokens.push({ kind: 'number', value: Number(m[0]) });
          i += m[0].length;
          continue;
        }
      }
      const name = readIdent();
      if (name === null) return null;
      if (value[i] === '(') {
        i += 1;
        if (name.toLowerCase() === 'url') {
          const close = value.indexOf(')', i);
          if (close < 0) return null;
          i = close + 1;
          tokens.push({ kind: 'function', name, args: [] });
          continue;
        }
        const args: Token[][] = [];
        for (;;) {
          const arg = read(',)');
          if (arg === null) return null;
          args.push(arg);
          if (value[i] === ',') {
            i += 1;
            continue;
          }
          if (value[i] === ')') {
            i += 1;
            break;
          }
          // the end of the value closes what is open, as it does anywhere
          // in CSS (2.1 4.2)
          break;
        }
        tokens.push({ kind: 'function', name, args });
        continue;
      }
      tokens.push({ kind: 'ident', name });
    }
    return tokens;
  };

  const readString = (quote: string): string | null => {
    i += 1;
    let text = '';
    while (i < n) {
      const c = value[i];
      if (c === quote) {
        i += 1;
        return text;
      }
      if (c === '\\') {
        text += readEscape();
        continue;
      }
      // a newline ends a string unclosed, which makes it invalid
      if (c === '\n') return null;
      text += c;
      i += 1;
    }
    // the end of the value closes a string left open
    return text;
  };

  const readIdent = (): string | null => {
    let name = '';
    while (i < n) {
      const c = value[i];
      if (/[a-zA-Z0-9_\-\u0080-￿]/.test(c)) {
        name += c;
        i += 1;
      } else if (c === '\\') {
        name += readEscape();
      } else break;
    }
    return name && !/^-?\d/.test(name) ? name : null;
  };

  /** A backslash and what follows it: up to six hex digits and one white
   *  space after them, a line continuation, or the character itself. */
  const readEscape = (): string => {
    i += 1;
    if (i >= n) return '';
    const hex = /^[0-9a-fA-F]{1,6}/.exec(value.slice(i));
    if (hex) {
      i += hex[0].length;
      if (value[i] === '\r' && value[i + 1] === '\n') i += 2;
      else if (/[ \t\n\r\f]/.test(value[i] ?? '')) i += 1;
      const code = parseInt(hex[0], 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? '�'
        : String.fromCodePoint(code);
    }
    const c = value[i];
    i += 1;
    if (c === '\n') return '';
    if (c === '\r') {
      if (value[i] === '\n') i += 1;
      return '';
    }
    return c;
  };

  const tokens = read('');
  if (tokens === null || i < n) return null;
  out.push(...tokens);
  return out;
}
