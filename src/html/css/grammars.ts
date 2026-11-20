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
import { splitValue } from './values.js';

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

/** The properties read here, by name. */
export const GRAMMARS: Readonly<
  Record<string, (word: string) => string | null | undefined>
> = {
  'font-variation-settings': fontVariationSettings,
  // a `<position>` of CSS Values 4, which has no three-value form
  'object-position': (word) => positionSpecified(splitValue(word)),
};
