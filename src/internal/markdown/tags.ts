// Scanning a JSX-shaped tag, for the MDX direction (docs/prd-mdx.md).
//
// Deliberately not a JavaScript parser, and deliberately not an HTML one.
// What it recognises is `<Name …>`, `</Name>` and `<Name … />` where `Name`
// is a component the *caller* claims — a tag whose name nobody claims is not
// a tag, it is the literal text it has always been. That one rule is what
// lets this exist inside a parser whose documents are full of `<box>` and
// `{braces}` without changing what any of them mean.
//
// Attribute values are read at parse time. A quoted string is a string, a
// bare name is `true`, and `{…}` is **JSON** — until the caller passes
// `expressions`, when a brace that is not JSON is kept as *source* for
// someone else to compile (docs/prd-mdx.md, M2). Nothing is evaluated here
// on either rung: this file finds where an expression ends, and holding it
// as text is what lets one parse be rendered against two scopes.
//
// Finding where it ends is the only part that has to know about JavaScript,
// and it knows the least it can: strings (including template literals and
// their `${…}` holes), comments, and bracket depth. It never parses an
// expression, the way `src/qml/parse.ts` never does.
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
 * The index just past the closing quote of the string literal starting at
 * `from`, or -1 if the text ends first. A template literal's `${…}` holes
 * are walked as expressions, so a brace or a quote inside one counts for
 * nothing outside it.
 */
function skipString(text: string, from: number): number {
  const quote = text[from];
  let i = from + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      const end = closeBrace(text, i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** The index just past a `//` or block comment starting at `from`. */
function skipComment(text: string, from: number): number {
  if (text[from + 1] === '/') {
    const nl = text.indexOf('\n', from);
    return nl === -1 ? text.length : nl;
  }
  const end = text.indexOf('*/', from + 2);
  return end === -1 ? -1 : end + 2;
}

/**
 * The index just past the `}` that closes the `{` at `from`, or -1 if the
 * text ends first — the one piece here that has to know JavaScript's shape.
 * Strings, template holes and comments are stepped over whole, so a brace
 * inside any of them closes nothing.
 */
export function closeBrace(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const end = skipComment(text, i);
      if (end === -1) return -1;
      i = end;
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
 *
 * `expressions` is the second rung: with it, a `{…}` that is not JSON is
 * kept as source instead of making the tag unreadable, and `{...spread}`
 * becomes an attribute. Without it — the default — neither exists, and a
 * document can only hand a component data it wrote down literally.
 */
export function scanTag(
  text: string,
  at: number,
  isComponent: (name: string) => boolean,
  expressions = false,
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
  let spreads = 0;
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

    // `{...props}` — an attribute with no name. Its key records where it
    // sat among the named ones, because a spread after `height` overrides
    // it and one before it does not; `...` cannot collide with a real
    // attribute name, which must start with a letter.
    if (text[i] === '{') {
      if (!expressions) return null;
      const end = closeBrace(text, i);
      if (end === -1) return 'incomplete';
      const inner = text.slice(i + 1, end - 1).trim();
      if (!inner.startsWith('...')) return null;
      attributes[`...${spreads}`] = {
        kind: 'expression',
        src: inner.slice(3).trim(),
      };
      spreads += 1;
      i = end;
      continue;
    }

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
        // Not JSON. On the rung that compiles, that is an expression and it
        // is kept as source; on the rung that does not, it is unreadable and
        // the tag is text.
        if (!expressions) return null;
        attributes[key] = { kind: 'expression', src: src.trim() };
      }
      i = end;
      continue;
    }
    // An unquoted value is HTML's, not JSX's.
    return null;
  }
}
