// Generated content (CSS 2.1 12): what `content`, `counter-reset`,
// `counter-increment`, `counter-set` and `quotes` compute to, and the styles
// a counter is written in. Resolving them against a document — which counter is in scope
// where, how deep the quotes are — is the box builder's, because it is a walk
// in document order and the builder is that walk.

import { parseUrl, urlEnd } from './parse.js';
import {
  CounterStyles,
  counterStyleName,
  symbolsFunction,
} from './counter-styles.js';

/** One part of a `content` value, in the order it was written. */
export type ContentItem =
  | { kind: 'string'; text: string }
  | { kind: 'url'; url: string }
  | { kind: 'attr'; name: string }
  | { kind: 'counter'; name: string; style: string }
  | { kind: 'counters'; name: string; separator: string; style: string }
  | {
      kind: 'open-quote' | 'close-quote' | 'no-open-quote' | 'no-close-quote';
    };

/** One name in a `counter-reset`, `counter-increment` or `counter-set`,
 *  with its number. */
export interface CounterChange {
  name: string;
  value: number;
  /** A reset's `reversed(name)`: a counter that counts down (CSS Lists 3,
   *  4.4.2), which the list items in it take one from each. */
  reversed?: true;
  /** A reversed counter written with no number, which starts at as many
   *  as its scope counts: its `value` is the box builder's to work out. */
  counted?: true;
}

/** English's quotation marks, outer pair first: what `quotes: auto` is for
 *  a language with none of its own, and for none. */
export const DEFAULT_QUOTES: readonly string[] = ['“', '”', '‘', '’'];

/**
 * Each language's quotation marks, outer pair then inner, where they are
 * not its parent's — `fr-ch`'s where they are not `fr`'s, `fr`'s where
 * they are not English's — from CLDR's delimiters, which Chrome reads
 * through ICU. What `quotes: auto` makes of the element's language (CSS
 * Content 3, 2.1): `<q>` in a French page is «un ‹deux› trois».
 */
const QUOTES_BY_LANGUAGE: Record<string, string> = {
  agq: '„”‚’',
  am: '«»‹›',
  ar: '”“’‘',
  ast: '«»“”',
  'az-arab': '«»‹›',
  'az-cyrl': '«»‹›',
  bas: '«»„“',
  be: '«»„“',
  bg: '„“„“',
  blo: '«»“”',
  bm: '«»“”',
  'bm-nkoo': '“”‘’',
  br: '«»“”',
  bs: '„”‘’',
  'bs-cyrl': '„“‚‘',
  bua: '«»„“',
  ca: '«»“”',
  cs: '„“‚‘',
  cv: '«»“”',
  de: '„“‚‘',
  dsb: '„“‚‘',
  dua: '«»‘’',
  dyo: '«»“”',
  el: '«»“”',
  'el-polyton': '«»‘’',
  eo: '“”«»',
  'es-us': '«»“”',
  et: '„“‚‘',
  eu: '«»“”',
  ewo: '«»“”',
  fa: '«»‹›',
  ff: '„”‚’',
  'ff-adlm': '“”‘’',
  fi: '””’’',
  fr: '«»«»',
  'fr-ca': '«»”“',
  'fr-ch': '«»‹›',
  fur: '‘’“”',
  gsw: '«»‹›',
  he: '””’’',
  hr: '„“‚‘',
  hsb: '„“‚‘',
  ht: '«»«»',
  hu: '„”»«',
  hy: '«»«»',
  ia: '‘’“”',
  ie: '«»“”',
  is: '„“‚‘',
  it: '«»“”',
  ja: '「」『』',
  jgo: '«»‹›',
  ka: '„“«»',
  kab: '«»“”',
  kk: '«»“”',
  'kk-arab': '»«›‹',
  kkj: '«»‹›',
  ksf: '«»‘’',
  ksh: '„“‚‘',
  ky: '«»„“',
  lag: '””’’',
  lb: '„“‚‘',
  lij: '«»“”',
  lld: '”“’‘',
  lt: '„“„“',
  luy: '„“‚‘',
  mg: '«»“”',
  mk: '„“‚‘',
  'ms-arab': '”“’‘',
  mua: '«»“”',
  mzn: '«»‹›',
  nb: '«»‘’',
  nds: '„“‚‘',
  nl: '‘’‘’',
  nmg: '„”«»',
  nn: '«»‘’',
  nnh: '«»“”',
  no: '«»‘’',
  oc: '«»«»',
  os: '«»„“',
  pl: '„”«»',
  pms: '«»“”',
  prg: '„“„“',
  'pt-ao': '«»“”',
  'pt-ch': '«»“”',
  'pt-cv': '«»“”',
  'pt-gq': '«»“”',
  'pt-gw': '«»“”',
  'pt-lu': '«»“”',
  'pt-mo': '«»“”',
  'pt-mz': '«»“”',
  'pt-pt': '«»“”',
  'pt-st': '«»“”',
  'pt-tl': '«»“”',
  rm: '«»‹›',
  rn: '””’’',
  ro: '„”«»',
  ru: '«»„“',
  rw: '«»‘’',
  sah: '«»„“',
  sc: '«»“”',
  sdh: '«»‹›',
  se: '””’’',
  sg: '«»“”',
  sgs: '„“„“',
  shi: '«»„”',
  sk: '„“‚‘',
  sl: '„“‚‘',
  sn: '””’’',
  sr: '„”’’',
  st: '“’“”',
  sv: '””’’',
  syr: '”“’‘',
  szl: '„”»«',
  ti: '«»“”',
  'ti-er': '‘’“”',
  tk: '“”“”',
  tn: '‘’“”',
  tyv: '«»„“',
  ug: '»«›‹',
  uk: '«»„“',
  ur: '”“’‘',
  uz: '“”’‘',
  'uz-arab': '“”‘’',
  'uz-cyrl': '“”‘’',
  wae: '«»‹›',
  yav: '«»«»',
  yi: '””’’',
  yue: '「」『』',
  zgh: '«»„”',
  'zh-hk': '「」『』',
  'zh-hant': '「」『』',
  'zh-mo': '「」『』',
  'zh-tw': '「」『』',
};

/** The marks `quotes: auto` gives an element of a language: its tag's, or
 *  the nearest of the tags it narrows, or English's. */
export function languageQuotes(lang: string): readonly string[] {
  let tag = lang.trim().toLowerCase().replace(/_/g, '-');
  while (tag) {
    if (Object.hasOwn(QUOTES_BY_LANGUAGE, tag)) {
      return [...QUOTES_BY_LANGUAGE[tag]];
    }
    const cut = tag.lastIndexOf('-');
    tag = cut < 0 ? '' : tag.slice(0, cut);
  }
  return DEFAULT_QUOTES;
}

export type Token =
  | { kind: 'string'; text: string }
  | { kind: 'url'; url: string }
  | { kind: 'ident'; name: string }
  | { kind: 'function'; name: string; args: Token[][] }
  | { kind: 'number'; value: number };

/**
 * `content`: `normal`, `none`, or its items, CSS 2.1's: strings, images,
 * `attr()`, counters and quotes. Null when the value cannot be read, which
 * drops the declaration, as CSS does.
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
    } else if (token.kind === 'url') {
      items.push(token);
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
      items.push(item);
    } else return null;
  }
  return items;
}

function contentFunction(
  token: Extract<Token, { kind: 'function' }>,
): ContentItem | null {
  const name = token.name.toLowerCase();
  const args = token.args;
  const ident = (i: number): string | null => {
    const arg = args[i];
    return arg?.length === 1 && arg[0].kind === 'ident' ? arg[0].name : null;
  };
  // a counter style: a name, as `list-style-type` takes one, `symbols()`,
  // or `none`
  const styleOf = (i: number): string | null => {
    const arg = args[i];
    if (arg?.length !== 1) return null;
    const token = arg[0];
    if (token.kind === 'function') return symbolsFunction(token);
    if (token.kind !== 'ident') return null;
    return token.name.toLowerCase() === 'none'
      ? 'none'
      : counterStyleName(token.name);
  };
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
    const style = args.length > 1 ? styleOf(1) : 'decimal';
    return style ? { kind: 'counter', name: counter, style } : null;
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
    const style = args.length > 2 ? styleOf(2) : 'decimal';
    return style
      ? {
          kind: 'counters',
          name: counter,
          separator: separator[0].text,
          style,
        }
      : null;
  }
  return null;
}

/**
 * `counter-reset`, `counter-increment` and `counter-set`: `none`, or names
 * each followed by an optional integer — `fallback` where there is none, 0
 * for a reset and a set and 1 for an increment. A reset's name may be
 * `reversed(name)` (`reversible`). Null when the value cannot be read.
 */
export function parseCounterList(
  value: string,
  fallback: number,
  reversible = false,
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
    let name: string;
    let reversed = false;
    if (token.kind === 'ident') name = token.name;
    else if (
      reversible &&
      token.kind === 'function' &&
      token.name.toLowerCase() === 'reversed' &&
      token.args.length === 1 &&
      token.args[0].length === 1 &&
      token.args[0][0].kind === 'ident'
    ) {
      name = token.args[0][0].name;
      reversed = true;
    } else return null;
    // CSS-wide keywords and `none` cannot name a counter
    const lower = name.toLowerCase();
    if (
      lower === 'none' ||
      lower === 'inherit' ||
      lower === 'initial' ||
      lower === 'unset'
    ) {
      return null;
    }
    const next = tokens[i + 1];
    let change: CounterChange;
    if (next?.kind === 'number') {
      if (!Number.isInteger(next.value)) return null;
      change = { name, value: next.value };
      i += 1;
    } else if (reversed) change = { name, value: 0, counted: true };
    else change = { name, value: fallback };
    if (reversed) change.reversed = true;
    out.push(change);
  }
  return out;
}

/**
 * `list-style-type`: `none`, a counter style — its name, lower-cased where
 * the specification defines it and kept as it is written where a document
 * does (CSS Counter Styles 3, 3), or `symbols()` — or a string the marker
 * is written as (CSS Lists 3, 3.3), kept with the `"` it was quoted in so
 * it cannot be taken for a name. Null when the value is none of those.
 */
export function parseListStyleType(value: string): string | null {
  const tokens = tokenize(value);
  if (tokens?.length !== 1) return null;
  const token = tokens[0];
  if (token.kind === 'string') return `"${token.text}`;
  if (token.kind === 'function') return symbolsFunction(token);
  if (token.kind !== 'ident') return null;
  const lower = token.name.toLowerCase();
  if (/^(inherit|initial|unset|default|revert|revert-layer)$/.test(lower)) {
    return null;
  }
  return lower === 'none' ? 'none' : counterStyleName(token.name);
}

/** `quotes`: `none`, `auto`, or pairs of strings, outermost first. Null
 *  when the value cannot be read — an odd number of strings among them. */
export function parseQuotes(value: string): string[] | 'none' | 'auto' | null {
  const tokens = tokenize(value);
  if (!tokens?.length) return null;
  if (tokens.length === 1 && tokens[0].kind === 'ident') {
    const name = tokens[0].name.toLowerCase();
    return name === 'none' || name === 'auto' ? name : null;
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
  quotes: readonly string[] | 'none' | 'auto',
  depth: number,
  side: 0 | 1,
  /** The element's language, for `auto`. */
  lang = '',
): string {
  if (quotes === 'none') return '';
  const marks = quotes === 'auto' ? languageQuotes(lang) : quotes;
  if (marks.length < 2) return '';
  const pair = Math.min(depth, marks.length / 2 - 1);
  return marks[pair * 2 + side];
}

// --- counter styles -----------------------------------------------------------

let predefined: CounterStyles | null = null;

/** A counter's value in one of the styles the specification defines, or
 *  `none`'s nothing, where no document's rules are in reach. */
export function counterText(n: number, style: string): string {
  if (style === 'none') return '';
  return (predefined ??= new CounterStyles()).text(n, style);
}

// --- the tokenizer ------------------------------------------------------------

/**
 * A value as strings, identifiers, numbers and functions with their
 * comma-separated arguments. Null when a character belongs to none of them.
 * The declaration reaching here has had its comments removed by the
 * stylesheet parser.
 */
export function tokenize(value: string): Token[] | null {
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
      const start = i;
      const name = readIdent();
      if (name === null) return null;
      if (value[i] === '(') {
        if (name.toLowerCase() === 'url') {
          // a url token, read as a background's is; a bad one is no value
          const end = urlEnd(value, i);
          const url = parseUrl(value.slice(start, end));
          if (url === undefined) return null;
          if (url !== null) tokens.push({ kind: 'url', url });
          i = end;
          continue;
        }
        i += 1;
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
