// Scanning a JSX-shaped tag, for the MDX direction (docs/prd-mdx.md).
//
// Deliberately not a JavaScript parser, and deliberately not an HTML one.
// What it recognises is `<Name …>`, `</Name>` and `<Name … />` where `Name`
// is a component the *caller* claims — a tag whose name nobody claims is not
// a tag, it is the literal text it has always been. That one rule is what
// lets this exist inside a parser whose documents are full of `<box>` and
// `{braces}` without changing what any of them mean.
//
// Attribute values resolve at parse time and evaluate nothing: a quoted
// string is a string, a bare name is `true`, and `{…}` is **JSON**. A brace
// that is not JSON makes the whole tag unreadable, and an unreadable tag
// falls back to text, the way a half-arrived link does. The rung that
// compiles `{…}` instead is M2, and it is the reason the AST holds an
// attribute as a tagged value rather than a bare one.
import type { AttributeValue } from './ast.js';

/** A tag's shape. `end` is the index just past its `>`. */
export interface ScannedTag {
  kind: 'open' | 'close' | 'self';
  name: string;
  attributes: Record<string, AttributeValue>;
  end: number;
}

/**
 * What a scan can say. `null` is "not a tag, never will be"; `'incomplete'`
 * is "could still become one if more text arrives", which is what a
 * streaming document needs in order to hold the tail back rather than
 * flashing `<Cha` on the screen.
 */
export type ScanResult = ScannedTag | 'incomplete' | null;

/** A component name, dotted paths included. Deliberately not HTML's. */
const RE_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/;
/** An attribute name: JSX's, plus the `-` and `:` that data attributes use. */
const RE_ATTR = /^[A-Za-z_$][\w$:-]*/;

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * The index just past the `}` that closes the `{` at `from`, or -1 if the
 * text ends first. String-aware, so a brace inside a JSON string does not
 * close anything; it does not need to know anything else about JavaScript,
 * because on this rung the contents must be JSON to be accepted at all.
 */
function closeBrace(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        i += text[i] === '\\' ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * Scan the tag starting at `text[at]`, which must be `<`.
 *
 * `isComponent` is asked before anything else is parsed, so a `<` that opens
 * nothing anybody claims costs one regex and a lookup.
 */
export function scanTag(
  text: string,
  at: number,
  isComponent: (name: string) => boolean,
): ScanResult {
  if (text[at] !== '<') return null;
  let i = at + 1;

  const close = text[i] === '/';
  if (close) i += 1;

  const nameMatch = RE_NAME.exec(text.slice(i));
  if (!nameMatch) {
    // `<` at the very end could still grow into a tag; anything else is text.
    return i >= text.length ? 'incomplete' : null;
  }
  const name = nameMatch[0];
  i += name.length;
  // A name that reaches the end may still be growing — `<Cha` could be
  // `<Chart`, and a document that decided too early would flash the wrong
  // thing. Only ask about names we have all of.
  if (i >= text.length) return 'incomplete';
  if (!isComponent(name)) return null;

  if (close) {
    while (isSpace(text[i])) i += 1;
    if (i >= text.length) return 'incomplete';
    if (text[i] !== '>') return null;
    return { kind: 'close', name, attributes: {}, end: i + 1 };
  }

  const attributes: Record<string, AttributeValue> = {};
  for (;;) {
    const hadSpace = isSpace(text[i]);
    while (isSpace(text[i])) i += 1;
    if (i >= text.length) return 'incomplete';

    if (text[i] === '>') return { kind: 'open', name, attributes, end: i + 1 };
    if (text[i] === '/') {
      i += 1;
      while (isSpace(text[i])) i += 1;
      if (i >= text.length) return 'incomplete';
      if (text[i] !== '>') return null;
      return { kind: 'self', name, attributes, end: i + 1 };
    }

    // `<Chart data="x"height={2}>` is a typo, not a tag.
    if (!hadSpace) return null;

    const attr = RE_ATTR.exec(text.slice(i));
    if (!attr) return null;
    const key = attr[0];
    i += key.length;
    if (i >= text.length) return 'incomplete';

    if (text[i] !== '=') {
      // A bare attribute is `true`, as it is in JSX.
      attributes[key] = { kind: 'literal', value: true };
      continue;
    }
    i += 1;
    if (i >= text.length) return 'incomplete';

    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end === -1) return 'incomplete';
      attributes[key] = { kind: 'literal', value: text.slice(i + 1, end) };
      i = end + 1;
      continue;
    }
    if (ch === '{') {
      const end = closeBrace(text, i);
      if (end === -1) return 'incomplete';
      const src = text.slice(i + 1, end - 1);
      try {
        attributes[key] = { kind: 'literal', value: JSON.parse(src) };
      } catch {
        // Not JSON, so not readable on this rung. The tag is text.
        return null;
      }
      i = end;
      continue;
    }
    // An unquoted value is HTML's, not JSX's.
    return null;
  }
}
