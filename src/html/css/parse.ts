// The stylesheet parser: text in, rules out, error-tolerant the way CSS
// itself is.
//
// **Why this is written rather than imported**, when `htmlparser2` and
// `css-select` were not: ntk brings `postcss`, so a parser was available —
// but postcss is a *tooling* parser. It keeps source positions, comments and
// raws so a transform can print the file back out, and none of that survives
// into a render. What this needs is the opposite: rules already split by
// selector, specificity already computed, declarations already a flat array,
// and the whole thing thrown away when the sheet changes. That is a
// single-pass tokenizer, and going through postcss's AST would mean building
// a large object graph and immediately walking it again.
//
// Selector *matching* is still `css-select`'s (see cascade.ts). Parsing a
// stylesheet is easy; matching `li:nth-child(2n+1) > a[href^="/"]` correctly
// and quickly is not, and that is the part worth importing.
import { parseLength } from './values.js';

/** One `prop: value` pair, with `!important` already taken off the value. */
export interface Declaration {
  prop: string;
  value: string;
  important: boolean;
}

export interface StyleRule {
  /** One selector — a `a, b` list becomes two rules, so specificity and the
   *  matcher are per-selector rather than per-rule. */
  selector: string;
  /** Packed (ids, classes, types); comparable as a single number. */
  specificity: number;
  /** Document order, the cascade's last tie-breaker. */
  order: number;
  declarations: Declaration[];
  /** The `@media` blocks this rule sits under, outermost first. Each entry
   *  is one block's comma list, which ORs; the blocks themselves AND. Kept
   *  nested rather than flattened because `(min-width: 40em), print` inside
   *  `(max-width: 60em)` is not the same set as the four conditions in a
   *  row, and flattening cannot tell them apart. */
  media: MediaCondition[][] | null;
}

export interface Stylesheet {
  rules: StyleRule[];
  /** `@import` targets, in order — the host fetches them through the
   *  resource seam and splices the result in ahead of this sheet. */
  imports: string[];
  /** Every width a `@media` rule in this sheet switches on. The renderer
   *  keeps these so a resize can tell "the layout changed" from "the
   *  *cascade* changed", and restyle only when it crossed one. */
  breakpoints: number[];
}

/** The tests this evaluates live: a width, a colour scheme, or both.
 *  Anything else — `orientation`, `print`, `prefers-reduced-motion` — is
 *  decided once, at parse time, by `staticPass`. */
export interface MediaCondition {
  min?: number;
  max?: number;
  /** `prefers-color-scheme`, answered from the palette in force. */
  scheme?: 'light' | 'dark';
  /** Set when the query could not be evaluated as a width or scheme test:
   *  `true` keeps the rule, `false` drops it, and neither depends on the
   *  viewport or the theme. */
  staticPass?: boolean;
}

const IMPORTANT_RE = /!\s*important\s*$/i;

/** The at-rules that are rules with a block — which an `@import` after them
 *  is too late for. */
const BLOCK_AT_RULES = new Set([
  'media',
  'supports',
  'font-face',
  'page',
  'keyframes',
  '-webkit-keyframes',
  'counter-style',
  'layer',
  'container',
  'property',
  'font-feature-values',
]);

/**
 * Parse a stylesheet. `order` continues across sheets, so the caller passes
 * a running counter and the cascade's document-order tie-break holds across
 * the whole document rather than restarting per `<style>`.
 *
 * The structure is CSS Syntax's: an at-rule is an at-keyword up to its `;`
 * or its block, a style rule is everything up to its block, and what lies
 * between is read a component value at a time — a string, an escape, a
 * bracketed block with its match — so a brace or a semicolon in a string, in
 * an escape or inside brackets never ends anything. A rule whose selector is
 * not one is dropped whole, and so is a group with any selector in it that
 * is not one (CSS 2.1 4.1.7).
 */
export function parseStylesheet(text: string, startOrder = 0): Stylesheet {
  text = withoutComments(text);
  const sheet: Stylesheet = { rules: [], imports: [], breakpoints: [] };
  let order = startOrder;
  const breakpoints = new Set<number>();
  // `@import` counts only ahead of every other rule, `@charset` aside
  let importsAllowed = true;

  const walk = (source: string, media: MediaCondition[][] | null): void => {
    let i = 0;
    const n = source.length;
    while (i < n) {
      i = skipTrivia(source, i);
      if (i >= n) break;

      if (source[i] === '@' && startsIdent(source, i + 1)) {
        const at = readAtRule(source, i);
        i = at.end;
        const name = at.name.toLowerCase();
        if (name === 'charset') continue;
        if (name === 'import') {
          if (importsAllowed && media === null) {
            const url = importUrl(at.prelude);
            if (url) sheet.imports.push(url);
          }
          continue;
        }
        // Only a rule that is one closes the imports: `@media;`, `@page;`
        // and an at-rule nobody knows are dropped as though never written.
        if (at.block !== null && BLOCK_AT_RULES.has(name)) {
          importsAllowed = false;
        }
        if (name === 'media' && at.block !== null) {
          const conditions = parseMediaQuery(at.prelude);
          for (const c of conditions) {
            if (c.min !== undefined) breakpoints.add(c.min);
            if (c.max !== undefined) breakpoints.add(c.max + 1);
          }
          // A nested `@media` intersects with the one above it; pushing a
          // level rather than merging keeps "all of these blocks hold" exact
          // when two of them overlap.
          walk(at.block, media ? [...media, conditions] : [conditions]);
        } else if (name === 'supports' && at.block !== null) {
          // Everything in a `@supports` block is markup this renderer either
          // understands or ignores per-declaration, so entering it is closer
          // to right than skipping it.
          walk(at.block, media);
        }
        // @font-face, @keyframes, @page: nothing to do, and the block was
        // already consumed.
        continue;
      }

      // A style rule runs to its block, whatever comes first: a stray `;`
      // or an `@` that names nothing is part of its selector, which then is
      // not one, and the rule goes with it.
      const blockAt = scanTo(source, i, '{');
      if (blockAt >= n) break;
      const prelude = source.slice(i, blockAt).trim();
      const block = readBlock(source, blockAt);
      i = block.end;
      const selectors = selectorList(prelude);
      if (!selectors) continue;
      importsAllowed = false;
      const declarations = parseDeclarations(block.body);
      if (!declarations.length) continue;
      for (const selector of selectors) {
        sheet.rules.push({
          selector,
          specificity: specificityOf(selector),
          order: order++,
          declarations,
          media,
        });
      }
    }
  };

  walk(text, null);
  sheet.breakpoints = [...breakpoints].sort((a, b) => a - b);
  return sheet;
}

/**
 * A style sheet with its comments taken out, strings left alone. CSS drops a
 * comment wherever it stands (CSS 2.1 4.1.9) — between rules, which the
 * scanner already skipped, but also inside a selector: `div /* note *\/ {`
 * kept the note in the selector, the matcher refused it, and the rule was
 * dropped whole. A comment is replaced by nothing, not a space, as the
 * tokenizer does: `.a/**\/.b` is one compound selector.
 */
function withoutComments(text: string): string {
  if (!text.includes('/*')) return text;
  let out = '';
  let from = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i = escapeEnd(text, i) - 1;
      else if (c === quote || c === '\n') quote = '';
      continue;
    }
    if (c === '\\') {
      // an escape: `\/*` is a slash and an asterisk, not a comment
      i += 1;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      out += text.slice(from, i);
      i = close < 0 ? text.length : close + 1;
      from = i + 1;
    }
  }
  return out + text.slice(from);
}

/**
 * Parse a declaration block — also the parser for a `style=""` attribute,
 * which is the same grammar with no braces around it. CSS Syntax's list of
 * declarations: a name, a colon, and everything up to the next `;` that no
 * string or bracket holds; an at-rule in the list is read to its `;` or its
 * block and dropped; anything else is dropped to the next `;`. A value with
 * a `!` left in it once `!important` is taken off is not a value.
 */
export function parseDeclarations(text: string): Declaration[] {
  // a `style` attribute comes here without the sheet's pass over comments
  text = withoutComments(text);
  const out: Declaration[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (isSpace(c) || c === ';') {
      i += 1;
      continue;
    }
    if (c === '@' && startsIdent(text, i + 1)) {
      i = readAtRule(text, i).end;
      continue;
    }
    const end = scanTo(text, i, ';');
    if (startsIdent(text, i)) {
      const name = readIdent(text, i);
      let colon = name.end;
      while (colon < end && isSpace(text[colon])) colon += 1;
      if (text[colon] === ':') {
        let value = text.slice(colon + 1, end).trim();
        const important = IMPORTANT_RE.test(value);
        if (important) value = value.replace(IMPORTANT_RE, '').trim();
        if (value && !hasBang(value)) {
          out.push({
            prop: name.value.toLowerCase(),
            value: unescapeValue(value),
            important,
          });
        }
      }
    }
    i = end + 1;
  }
  return out;
}

/** Split `a, b > c, d` on top-level commas. */
export function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < prelude.length) {
    if (prelude[i] === ',') {
      out.push(prelude.slice(start, i).trim());
      start = i + 1;
      i += 1;
    } else {
      i = opens(prelude.charCodeAt(i)) ? componentEnd(prelude, i) : i + 1;
    }
  }
  out.push(prelude.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * A rule's selectors, or null where any of them is not a selector — an
 * empty one in the list, an identifier that starts with a digit, a
 * combinator with nothing after it — and the rule is dropped whole.
 */
export function selectorList(prelude: string): string[] | null {
  if (!prelude) return null;
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number): boolean => {
    const selector = prelude.slice(start, end).trim();
    if (!selector || !isSelector(selector)) return false;
    out.push(selector);
    return true;
  };
  while (i < prelude.length) {
    if (prelude[i] === ',') {
      if (!push(i)) return null;
      start = i + 1;
      i += 1;
    } else {
      i = opens(prelude.charCodeAt(i)) ? componentEnd(prelude, i) : i + 1;
    }
  }
  return push(prelude.length) ? out : null;
}

/**
 * Whether a selector parses as one: compounds of type, universal, class,
 * id, attribute and pseudo selectors, each name a CSS identifier, joined by
 * combinators. What a selector *means* — which pseudo-classes exist — is
 * the matcher's to decide; this only refuses what no grammar would read.
 */
function isSelector(s: string): boolean {
  const n = s.length;
  let i = 0;
  let expectCompound = true;
  while (i < n) {
    const c = s[i];
    if (isSpace(c)) {
      i += 1;
      continue;
    }
    if (c === '>' || c === '+' || c === '~') {
      if (expectCompound) return false;
      expectCompound = true;
      i += 1;
      continue;
    }
    // one compound: simple selectors with nothing between them
    const from = i;
    while (i < n && !isSpace(s[i]) && !'>+~'.includes(s[i])) {
      const d = s[i];
      if (d === '*' || d === '|') {
        i += 1;
      } else if (d === '.' || d === '#') {
        if (!startsIdent(s, i + 1)) return false;
        i = identEnd(s, i + 1);
      } else if (d === '[') {
        let j = i + 1;
        while (j < n && isSpace(s[j])) j += 1;
        if (s[j] === '*' || s[j] === '|') j += 1;
        if (s[j] === '|') j += 1;
        if (!startsIdent(s, j)) return false;
        const end = componentEnd(s, i);
        if (s[end - 1] !== ']') return false;
        i = end;
      } else if (d === ':') {
        const element = s[i + 1] === ':';
        const at = element ? i + 2 : i + 1;
        if (!startsIdent(s, at)) return false;
        const name = readIdent(s, at);
        if (!knownPseudo(name.value.toLowerCase(), element)) return false;
        i = name.end;
        if (s[i] === '(') {
          const end = componentEnd(s, i);
          if (s[end - 1] !== ')') return false;
          i = end;
        }
      } else if (startsIdent(s, i) && i === from) {
        i = identEnd(s, i);
      } else {
        return false;
      }
    }
    expectCompound = false;
  }
  return !expectCompound;
}

/**
 * Whether a pseudo-class or pseudo-element is one: an unknown one makes its
 * selector invalid, and with it the group (CSS 2.1 4.1.7) — which is also
 * what a browser does with another engine's `:-moz-…`. A vendor prefix is
 * let through: which of them a browser knows is its own affair.
 */
function knownPseudo(name: string, element: boolean): boolean {
  if (name.startsWith('-')) return true;
  if (element) return PSEUDO_ELEMENTS.has(name);
  return PSEUDO_CLASSES.has(name) || LEGACY_PSEUDO_ELEMENTS.test(name);
}

const PSEUDO_ELEMENTS = new Set([
  'before',
  'after',
  'first-line',
  'first-letter',
  'selection',
  'placeholder',
  'marker',
  'backdrop',
  'file-selector-button',
  'cue',
  'part',
  'slotted',
  'spelling-error',
  'grammar-error',
  'target-text',
  'highlight',
  'details-content',
]);

const PSEUDO_CLASSES = new Set([
  // css-select's own, which the matcher answers and the docs promise
  'button',
  'checkbox',
  'file',
  'header',
  'icontains',
  'image',
  'input',
  'parent',
  'password',
  'radio',
  'reset',
  'selected',
  'submit',
  'text',
  // CSS's
  'active',
  'any-link',
  'autofill',
  'blank',
  'checked',
  'closed',
  'contains',
  'current',
  'default',
  'defined',
  'dir',
  'disabled',
  'empty',
  'enabled',
  'first',
  'first-child',
  'first-of-type',
  'focus',
  'focus-visible',
  'focus-within',
  'fullscreen',
  'future',
  'has',
  'host',
  'host-context',
  'hover',
  'in-range',
  'indeterminate',
  'invalid',
  'is',
  'lang',
  'last-child',
  'last-of-type',
  'left',
  'link',
  'local-link',
  'matches',
  'modal',
  'not',
  'nth-child',
  'nth-col',
  'nth-last-child',
  'nth-last-col',
  'nth-last-of-type',
  'nth-of-type',
  'only-child',
  'only-of-type',
  'open',
  'optional',
  'out-of-range',
  'past',
  'paused',
  'picture-in-picture',
  'placeholder-shown',
  'playing',
  'popover-open',
  'read-only',
  'read-write',
  'required',
  'right',
  'root',
  'scope',
  'state',
  'target',
  'target-within',
  'user-invalid',
  'user-valid',
  'valid',
  'visited',
  'where',
]);

/**
 * Specificity, packed. Counted from the selector text rather than from a
 * parse: `#a` is an id, `.a`/`[a]`/`:a` is a class, a bare name is a type,
 * and a pseudo-*element* (`::before`) counts as a type. Functional
 * pseudo-classes are counted as one class each, which is right for
 * `:hover`/`:nth-child()` and approximate for `:is()`/`:not()` — whose
 * specificity is their argument's. The approximation costs an author who
 * writes `:is(#id)` and expects it to beat a class; nothing else.
 */
const LEGACY_PSEUDO_ELEMENTS = /^(?:before|after|first-line|first-letter)$/i;

export function specificityOf(selector: string): number {
  let ids = 0;
  let classes = 0;
  let types = 0;
  let i = 0;
  const n = selector.length;
  while (i < n) {
    const c = selector[i];
    if (c === '#') {
      ids += 1;
      i = identEnd(selector, i + 1);
    } else if (c === '.') {
      classes += 1;
      i = identEnd(selector, i + 1);
    } else if (c === '[') {
      classes += 1;
      i = componentEnd(selector, i);
    } else if (c === ':') {
      if (selector[i + 1] === ':') {
        types += 1;
        i = identEnd(selector, i + 2);
      } else {
        const name = readIdent(selector, i + 1);
        // CSS 2 spelled the four pseudo-elements it had with one colon
        if (LEGACY_PSEUDO_ELEMENTS.test(name.value)) {
          types += 1;
        } else {
          classes += 1;
        }
        i = name.end;
        if (selector[i] === '(') i = componentEnd(selector, i);
      }
    } else if (c === '*' || c === '|') {
      // the universal selector, and a namespace's bar, count nothing
      i += 1;
    } else if (startsIdent(selector, i)) {
      types += 1;
      i = identEnd(selector, i);
    } else {
      i += 1;
    }
  }
  return ids * 1_000_000 + classes * 1_000 + types;
}

// --- the little scanner -----------------------------------------------------

function skipTrivia(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && isSpace(text[i])) i += 1;
    if (text[i] === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    // A stray `<!--` / `-->` is legal at the top of an old stylesheet.
    if (text.startsWith('<!--', i)) {
      i += 4;
      continue;
    }
    if (text.startsWith('-->', i)) {
      i += 3;
      continue;
    }
    return i;
  }
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

/** A character an identifier may start with, before escapes: a letter, an
 *  underscore, anything past ASCII. */
function isNameStart(c: string | undefined): boolean {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    code === 0x5f ||
    code >= 0x80
  );
}

function isNameChar(c: string | undefined): boolean {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return isNameStart(c) || (code >= 0x30 && code <= 0x39) || code === 0x2d;
}

/** Whether a backslash at `at` escapes what follows — not a newline, and
 *  not the end of the text. */
function isEscape(text: string, at: number): boolean {
  return text[at] === '\\' && at + 1 < text.length && text[at + 1] !== '\n';
}

/**
 * Whether an identifier starts at `at` (CSS Syntax 4.3.10): a name-start
 * character or an escape, after at most one hyphen — or two hyphens. Every
 * character this accepts, `readIdent` steps over: a scan that finds an
 * identifier and then reads none of it never moves again, which is how a
 * `*` selector once hung the application.
 */
export function startsIdent(text: string, at: number): boolean {
  const c = text[at];
  if (c === '-') {
    const d = text[at + 1];
    return isNameStart(d) || d === '-' || isEscape(text, at + 1);
  }
  return isNameStart(c) || isEscape(text, at);
}

/** Where an identifier from `at` ends, its escapes stepped over. */
function identEnd(text: string, at: number): number {
  let i = at;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2d ||
      code === 0x5f ||
      code >= 0x80
    ) {
      i += 1;
    } else if (code === 0x5c && isEscape(text, i)) {
      i = readEscape(text, i).end;
    } else {
      break;
    }
  }
  return i;
}

/** An identifier from `at`, its escapes resolved, and where it ends. */
export function readIdent(
  text: string,
  at: number,
): { value: string; end: number } {
  const end = identEnd(text, at);
  const raw = text.slice(at, end);
  if (!raw.includes('\\')) return { value: raw, end };
  let value = '';
  let i = at;
  while (i < end) {
    if (text[i] === '\\') {
      const escape = readEscape(text, i);
      value += escape.char;
      i = escape.end;
    } else {
      value += text[i];
      i += 1;
    }
  }
  return { value, end };
}

/** The character an escape at `at` stands for, and where it ends: up to six
 *  hex digits and one white space after them, or the next character. */
function readEscape(text: string, at: number): { char: string; end: number } {
  let i = at + 1;
  let hex = '';
  while (hex.length < 6 && i < text.length && /[0-9a-fA-F]/.test(text[i])) {
    hex += text[i];
    i += 1;
  }
  if (!hex) return { char: text[i] ?? '�', end: i + 1 };
  if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
  else if (isSpace(text[i] ?? '')) i += 1;
  const code = parseInt(hex, 16);
  const char =
    code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      ? '�'
      : String.fromCodePoint(code);
  return { char, end: i };
}

/**
 * Where the component value starting at `at` ends (CSS Syntax 5.4.7): a
 * string to its closing quote (or the line that breaks it), an escape, a
 * `url(…)` to its parenthesis, a bracketed block to its match — whatever
 * closing brackets of another kind it holds — and otherwise one character.
 * Every scan below goes through this, so a brace in a string, a bracket
 * escaped with a backslash and a semicolon in `url(a;b)` are what they are
 * everywhere at once.
 */
function componentEnd(text: string, at: number): number {
  const c = text[at];
  if (c === '"' || c === "'") return stringEnd(text, at);
  if (c === '\\') return isEscape(text, at) ? readEscape(text, at).end : at + 1;
  if (c === '(' || c === '[' || c === '{') return blockEnd(text, at);
  if (
    (c === 'u' || c === 'U') &&
    text[at + 3] === '(' &&
    text.slice(at, at + 3).toLowerCase() === 'url' &&
    !isNameChar(text[at - 1])
  ) {
    return urlEnd(text, at + 3);
  }
  return at + 1;
}

function stringEnd(text: string, at: number): number {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === quote) return i + 1;
    // a newline ends a string that has not ended: it is a bad string, and
    // the newline is not in it
    if (c === '\n' || c === '\r' || c === '\f') return i;
    i = c === '\\' ? escapeEnd(text, i) : i + 1;
  }
  return text.length;
}

/** Where a backslash at `at` stops meaning something inside a string: a
 *  newline after it continues the line, and an escape — six hex digits and
 *  the white space after them included — is read whole. */
function escapeEnd(text: string, at: number): number {
  if (text[at + 1] === '\r' && text[at + 2] === '\n') return at + 3;
  if (isEscape(text, at)) return readEscape(text, at).end;
  return Math.min(text.length, at + 2);
}

function blockEnd(text: string, at: number): number {
  const open = text.charCodeAt(at);
  const close = open === 0x28 ? 0x29 : open === 0x5b ? 0x5d : 0x7d;
  let i = at + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === close) return i + 1;
    // a closing bracket of another kind inside is only a token
    i = opens(code) ? componentEnd(text, i) : i + 1;
  }
  return text.length;
}

/** Whether a character starts a component value longer than itself: a
 *  quote, an escape, an opening bracket, or the `u` of a `url(`. Every other
 *  character is its own, which is what keeps a scan a loop over codes. */
function opens(code: number): boolean {
  return (
    code === 0x22 ||
    code === 0x27 ||
    code === 0x5c ||
    code === 0x28 ||
    code === 0x5b ||
    code === 0x7b ||
    code === 0x75 ||
    code === 0x55
  );
}

/** `url(` at the parenthesis: a quoted argument is a function like any
 *  other; an unquoted one runs to its `)` with its escapes. */
function urlEnd(text: string, paren: number): number {
  let i = paren + 1;
  while (i < text.length && isSpace(text[i])) i += 1;
  if (text[i] === '"' || text[i] === "'") return blockEnd(text, paren);
  while (i < text.length) {
    const c = text[i];
    if (c === ')') return i + 1;
    i += c === '\\' ? 2 : 1;
  }
  return text.length;
}

/** The first `target` from `at` that no string, escape or bracket holds, or
 *  the length of the text. */
function scanTo(text: string, at: number, target: string): number {
  const want = target.charCodeAt(0);
  let i = at;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === want) return i;
    i = opens(code) ? componentEnd(text, i) : i + 1;
  }
  return text.length;
}

/** Whether a `!` stands in a value outside its strings and brackets. */
function hasBang(value: string): boolean {
  return value.includes('!') && scanTo(value, 0, '!') < value.length;
}

/**
 * A value with its escapes resolved outside its strings and `url()`s:
 * `\67reen` is `green`. A string keeps its escapes for whoever reads its
 * text, `content` among them.
 */
function unescapeValue(value: string): string {
  if (!value.includes('\\')) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (isEscape(value, i)) {
      // Resolved where it stands for a name character; any other it is part
      // of an identifier that a value parser should see as one, not as the
      // tab or the semicolon it names — `red \9` is not `red`.
      const escape = readEscape(value, i);
      out += isNameChar(escape.char) ? escape.char : value.slice(i, escape.end);
      i = escape.end;
      continue;
    }
    const end = componentEnd(value, i);
    out += value.slice(i, end);
    i = end;
  }
  return out;
}

/**
 * A `{…}` block: its body, and where the text goes on after it. The end of
 * a style sheet closes a block still open (CSS 2.1 4.2), so a block the end
 * cut off is everything after its brace. Cutting its last character as if
 * it were the `}` made `color: blue` `color: blu` — and left an unclosed
 * `rgb(` to reach paint whole or not, by where the sheet's whitespace fell.
 */
function readBlock(
  text: string,
  braceAt: number,
): { body: string; end: number } {
  const end = blockEnd(text, braceAt);
  const closed = text[end - 1] === '}' && end - 1 > braceAt;
  return { body: text.slice(braceAt + 1, closed ? end - 1 : end), end };
}

interface AtRule {
  name: string;
  prelude: string;
  block: string | null;
  end: number;
}

/** An at-rule: its name, and everything up to its `;` or its block. */
function readAtRule(text: string, at: number): AtRule {
  const name = readIdent(text, at + 1);
  let i = name.end;
  while (i < text.length && text[i] !== ';' && text[i] !== '{') {
    i = opens(text.charCodeAt(i)) ? componentEnd(text, i) : i + 1;
  }
  const prelude = text.slice(name.end, i).trim();
  if (text[i] === '{') {
    const block = readBlock(text, i);
    return { name: name.value, prelude, block: block.body, end: block.end };
  }
  return {
    name: name.value,
    prelude,
    block: null,
    end: Math.min(text.length, i + 1),
  };
}

function importUrl(prelude: string): string | null {
  const m = /^\s*(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/.exec(prelude);
  return m ? m[1] : null;
}

/**
 * A `@media` prelude, reduced to the width and colour-scheme tests this can
 * honour. Each comma group is one condition and they are OR-ed; within a
 * group, `and` means the tests intersect, so a group with a feature this
 * does not understand is decided statically by that feature alone.
 */
export function parseMediaQuery(prelude: string): MediaCondition[] {
  const out: MediaCondition[] = [];
  for (const group of splitSelectors(prelude)) {
    const condition: MediaCondition = {};
    let pass = true;
    let sawWidth = false;
    const negated = /^\s*not\b/i.test(group);
    for (const part of group.split(/\s+and\s+/i)) {
      const term = part
        .trim()
        .replace(/^not\s+/i, '')
        .replace(/^only\s+/i, '');
      if (!term) continue;
      const feature = /^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/i.exec(term);
      if (feature) {
        const key = feature[1].toLowerCase();
        const len = parseLength(feature[2], ZERO_UNITS);
        const px = typeof len === 'number' ? len : null;
        if (key === 'min-width' && px !== null) {
          condition.min = Math.max(condition.min ?? 0, px);
          sawWidth = true;
        } else if (key === 'max-width' && px !== null) {
          condition.max = Math.min(condition.max ?? Infinity, px);
          sawWidth = true;
        } else if (key === 'prefers-color-scheme') {
          // Answered live, from the palette in force: a document dropped
          // into a dark application takes its dark branch, and follows the
          // desktop when that changes. The two schemes are the whole
          // vocabulary; anything else never matches.
          const scheme = feature[2].trim().toLowerCase();
          if (scheme === 'light' || scheme === 'dark') {
            if (condition.scheme && condition.scheme !== scheme) pass = false;
            condition.scheme = scheme;
          } else {
            pass = false;
          }
        } else if (key === 'prefers-reduced-motion') {
          // Nothing here moves, so there is nothing to reduce: the branch an
          // animated page keeps for this preference is not one this
          // renderer needs.
          pass = false;
        } else if (key === 'orientation') {
          pass = feature[2].trim().toLowerCase() === 'landscape';
        }
        continue;
      }
      const type = term.toLowerCase();
      if (type === 'screen' || type === 'all') continue;
      if (type === 'print' || type === 'speech') pass = false;
    }
    if (negated) {
      // `not` over a scheme is the other scheme. `not` over a width range
      // is not expressible as one range; the honest reduction is to decide
      // it statically rather than invert it wrongly.
      if (!sawWidth && pass && condition.scheme) {
        out.push({ scheme: condition.scheme === 'dark' ? 'light' : 'dark' });
        continue;
      }
      out.push({ staticPass: !sawWidth && pass ? false : !pass });
      continue;
    }
    if (!pass) {
      out.push({ staticPass: false });
      continue;
    }
    if (
      !sawWidth &&
      condition.scheme === undefined &&
      condition.min === undefined &&
      condition.max === undefined
    ) {
      out.push({ staticPass: true });
      continue;
    }
    out.push(condition);
  }
  return out.length ? out : [{ staticPass: true }];
}

/** A `@media` width is compared with the viewport in CSS pixels — the
 *  cascade divides the device width by the scale before asking — so the
 *  thresholds parse at scale 1 whatever panel the document lands on. */
const ZERO_UNITS = { em: 16, rem: 16, vw: 0, vh: 0, scale: 1 };

/** Whether a rule's `@media` blocks all hold at this viewport width, under
 *  this colour scheme. */
export function mediaMatches(
  media: MediaCondition[][] | null,
  width: number,
  scheme: 'light' | 'dark' = 'light',
): boolean {
  if (!media) return true;
  for (const block of media) {
    let any = false;
    for (const c of block) {
      if (c.staticPass !== undefined) {
        if (c.staticPass) any = true;
        continue;
      }
      if (
        (c.min === undefined || width >= c.min) &&
        (c.max === undefined || width <= c.max) &&
        (c.scheme === undefined || c.scheme === scheme)
      ) {
        any = true;
      }
    }
    if (!any) return false;
  }
  return true;
}
