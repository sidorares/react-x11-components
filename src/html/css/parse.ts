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
import { resolveUrl } from '../url.js';
import { parseLength } from './values.js';
import { hasVar, unbalanced, validVars } from './vars.js';

/** One `prop: value` pair, with `!important` already taken off the value. */
export interface Declaration {
  prop: string;
  value: string;
  important: boolean;
  /** A custom property, `--name`, whose name keeps its case. */
  custom?: true;
  /** The value has a `var()` to replace before it is read. */
  vars?: true;
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
  /** The cascade layer this rule is in (CSS Cascade 5): the rank of each
   *  layer on its path, outermost first, in the order the document first
   *  names them. Null for a rule in no layer, which outranks every layer. */
  layer: readonly number[] | null;
}

export interface Stylesheet {
  rules: StyleRule[];
  /** `@import` targets, in order — the host fetches them through the
   *  resource seam and splices the result in ahead of this sheet. Absolute
   *  when the sheet was parsed with a base. */
  imports: string[];
  /** Every width a `@media` rule in this sheet switches on. The renderer
   *  keeps these so a resize can tell "the layout changed" from "the
   *  *cascade* changed", and restyle only when it crossed one. */
  breakpoints: number[];
  /** Whether a `@media` rule in this sheet tests the viewport's height,
   *  which makes a document restyle when the height moves, as a `vh`
   *  does. */
  readsHeight?: boolean;
  /** The `@font-face` rules, in order (see `fonts.ts`). */
  fontFaces: FontFaceRule[];
  /** `@counter-style` rules, in order: a name and its descriptors, which
   *  the cascade reads into counter styles (CSS Counter Styles 3, 3). */
  counterStyles?: { prelude: string; declarations: Declaration[] }[];
}

/**
 * One `@font-face` (CSS Fonts 4, 4): a face of a family, and where to get
 * it. The descriptors are kept to what choosing and registering a face
 * reads — `font-stretch`, `font-display` and the feature descriptors are
 * not.
 */
export interface FontFaceRule {
  /** The family as the document names it, unquoted. */
  family: string;
  /** The `url()`s of `src`, in order, each with its `format()` hint
   *  lowercased; `local()` entries are left out. */
  sources: FontFaceSource[];
  /** The weights the face covers: `[400, 400]` for a static regular, a
   *  range for a variable face. */
  weight: [number, number];
  style: 'normal' | 'italic';
  /** Code point ranges, inclusive; null for every code point. */
  unicodeRange: [number, number][] | null;
  /** The `@media` blocks the rule sits under, as a style rule's. */
  media: MediaCondition[][] | null;
}

export interface FontFaceSource {
  url: string;
  format: string | null;
}

/** The tests this evaluates live: a width, a height, a colour scheme.
 *  Anything else — `orientation`, `print`, `prefers-reduced-motion` — is
 *  decided once, at parse time, by `staticPass`. */
export interface MediaCondition {
  min?: number;
  max?: number;
  /** The viewport's height, as `min`/`max` its width: `min-height`,
   *  `max-height` and a range on `height` (Media Queries 4, 4.2). */
  minHeight?: number;
  maxHeight?: number;
  /** `prefers-color-scheme`, answered from the palette in force. */
  scheme?: 'light' | 'dark';
  /** Set when the query could not be evaluated as a width or scheme test:
   *  `true` keeps the rule, `false` drops it, and neither depends on the
   *  viewport or the theme. */
  staticPass?: boolean;
}

const IMPORTANT_RE = /!\s*important\s*$/i;

/** A layer's name: identifiers joined by dots. */
const LAYER_NAME =
  /^-?[_a-zA-Z\u00a0-\uffff][\w\u00a0-\uffff-]*(?:\.-?[_a-zA-Z\u00a0-\uffff][\w\u00a0-\uffff-]*)*$/;

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
export function parseStylesheet(
  text: string,
  startOrder = 0,
  /** The document's layers, by their full names, ranked in the order the
   *  document first names them: one map across all of its sheets, since a
   *  layer one sheet names first is the same layer in the next. */
  layers: Map<string, number> = new Map(),
  /** The URL the sheet's own relative URLs resolve against — its own, or
   *  the document's for a `<style>` — or null to leave them as written.
   *  Every `url()`, `@import` and `@font-face` source comes out absolute. */
  base: string | null = null,
): Stylesheet {
  text = withoutComments(text);
  const sheet: Stylesheet = {
    rules: [],
    imports: [],
    breakpoints: [],
    fontFaces: [],
  };
  let order = startOrder;
  const breakpoints = new Set<number>();
  // `@import` counts only ahead of every other rule, `@charset` aside
  let importsAllowed = true;

  /** A layer's rank, named for the first time if it has not been. */
  const rankOf = (name: string): number => {
    let rank = layers.get(name);
    if (rank === undefined) {
      rank = layers.size;
      layers.set(name, rank);
    }
    return rank;
  };
  /** The path of ranks down to a layer, `a.b` inside `outer` being three
   *  levels, and the layer's full name. */
  const enter = (
    name: string,
    layer: readonly number[] | null,
    path: string,
  ): [number[], string] => {
    const ranks = layer ? [...layer] : [];
    let full = path;
    for (const part of name.split('.')) {
      full = full ? `${full}.${part}` : part;
      ranks.push(rankOf(full));
    }
    return [ranks, full];
  };
  let anonymous = 0;

  const walk = (
    source: string,
    media: MediaCondition[][] | null,
    layer: readonly number[] | null = null,
    path = '',
  ): void => {
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
            if (url && importApplies(at.prelude)) {
              sheet.imports.push(resolveUrl(url, base));
            }
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
            if (c.max !== undefined) breakpoints.add(c.max + MAX_EDGE);
            if (c.minHeight !== undefined || c.maxHeight !== undefined) {
              sheet.readsHeight = true;
            }
          }
          // A nested `@media` intersects with the one above it; pushing a
          // level rather than merging keeps "all of these blocks hold" exact
          // when two of them overlap.
          walk(
            at.block,
            media ? [...media, conditions] : [conditions],
            layer,
            path,
          );
        } else if (name === 'supports' && at.block !== null) {
          // Everything in a `@supports` block is markup this renderer either
          // understands or ignores per-declaration, so entering it is closer
          // to right than skipping it — but for a condition it can answer
          // false (`supportsCondition`)
          if (supportsCondition(at.prelude) !== false) {
            walk(at.block, media, layer, path);
          }
        } else if (name === 'layer') {
          // `@layer a, b;` names layers, and so fixes their order, and
          // `@layer a { … }` puts rules in one; one with no name is a layer
          // of its own. Tailwind 4 writes all of its CSS in four of them.
          const names = at.prelude
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
          if (!names.every((part) => LAYER_NAME.test(part))) continue;
          if (at.block === null) {
            for (const part of names) enter(part, layer, path);
          } else if (names.length <= 1) {
            const [ranks, full] = enter(
              names[0] ?? `\u0000${anonymous++}`,
              layer,
              path,
            );
            walk(at.block, media, ranks, full);
          }
        } else if (name === 'font-face' && at.block !== null) {
          const face = parseFontFace(at.block, base, media);
          if (face) sheet.fontFaces.push(face);
        } else if (name === 'counter-style' && at.block !== null) {
          (sheet.counterStyles ??= []).push({
            prelude: at.prelude,
            declarations: parseDeclarations(at.block),
          });
        }
        // @keyframes, @page: nothing to do, and the block was already
        // consumed.
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
      const selectors = rawSelectors(prelude);
      if (!selectors) continue;
      importsAllowed = false;
      styleRule(selectors, block.body, media, layer, path, 0);
    }
  };

  /**
   * A style rule, and the rules nested in it (CSS Nesting 1): a rule inside
   * a rule's block is relative to it, `&` standing for it and a selector
   * without one a descendant of it, and an `@media`, `@supports` or
   * `@layer` inside one holds declarations for the same selectors, under
   * its condition. Tailwind 4 writes its variants so — `md:flex` is
   * `.md\:flex { @media (width >= 48rem) { display: flex } }`, and
   * `hover:` is `&:hover` — and they were dropped with the rule. Each
   * nested rule comes after its parent's declarations in the cascade's
   * order, as it comes after them in the sheet.
   */
  const styleRule = (
    selectors: string[],
    body: string,
    media: MediaCondition[][] | null,
    layer: readonly number[] | null,
    path: string,
    depth: number,
  ): void => {
    // the plain case, a block with nothing nested in it
    if (!body.includes('{')) {
      emit(selectors, parseDeclarations(body), media, layer);
      return;
    }
    const { declarations, nested } = splitNested(body);
    emit(selectors, parseDeclarations(declarations), media, layer);
    if (depth >= MAX_NESTING) return;
    for (const item of nested) {
      if (item.kind === 'rule') {
        const inner = nestedSelectors(item.prelude, selectors);
        if (inner) styleRule(inner, item.body, media, layer, path, depth + 1);
        continue;
      }
      const name = item.name.toLowerCase();
      if (item.block === null) continue;
      if (name === 'media') {
        const conditions = parseMediaQuery(item.prelude);
        for (const c of conditions) {
          if (c.min !== undefined) breakpoints.add(c.min);
          if (c.max !== undefined) breakpoints.add(c.max + MAX_EDGE);
          if (c.minHeight !== undefined || c.maxHeight !== undefined) {
            sheet.readsHeight = true;
          }
        }
        styleRule(
          selectors,
          item.block,
          media ? [...media, conditions] : [conditions],
          layer,
          path,
          depth + 1,
        );
      } else if (name === 'supports') {
        if (supportsCondition(item.prelude) !== false) {
          styleRule(selectors, item.block, media, layer, path, depth + 1);
        }
      } else if (name === 'layer' && LAYER_NAME.test(item.prelude.trim())) {
        const [ranks, full] = enter(item.prelude.trim(), layer, path);
        styleRule(selectors, item.block, media, ranks, full, depth + 1);
      }
    }
  };

  const emit = (
    selectors: string[],
    declarations: Declaration[],
    media: MediaCondition[][] | null,
    layer: readonly number[] | null,
  ): void => {
    if (!declarations.length) return;
    if (base !== null) {
      for (const d of declarations) d.value = absoluteUrls(d.value, base);
    }
    for (const raw of selectors) {
      const selector = raw.includes('\\') ? forMatcher(raw) : raw;
      sheet.rules.push({
        selector,
        specificity: specificityOf(selector),
        order: order++,
        declarations,
        media,
        layer,
      });
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
 * dropped whole. In a selector a comment is replaced by nothing, as the
 * tokenizer does: `.a/**\/.b` is one compound selector. In a declaration
 * it is replaced by a space, since there it still ends the token before it:
 * `1/**\/0px` is two values and no length, and `-/**\/10px` is no
 * negative one. `decls` says the text starts inside a declaration block,
 * which a `style` attribute does.
 */
function withoutComments(text: string, decls = false): string {
  if (!text.includes('/*')) return text;
  let out = '';
  let from = 0;
  let quote = '';
  // for each open block, whether it holds declarations rather than rules
  const blocks: boolean[] = [];
  let prelude = 0;
  // whether the rule being read is an at-rule, once its first token says
  let atRule: boolean | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i = escapeEnd(text, i) - 1;
      else if (c === quote || c === '\n') quote = '';
      continue;
    }
    if (atRule === null && !isSpace(c) && !(c === '/' && text[i + 1] === '*')) {
      atRule = c === '@';
    }
    if (c === '\\') {
      // an escape: `\/*` is a slash and an asterisk, not a comment
      i += 1;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (
      (c === 'u' || c === 'U') &&
      text[i + 3] === '(' &&
      text.slice(i, i + 3).toLowerCase() === 'url' &&
      !isNameChar(text[i - 1])
    ) {
      // an unquoted url is one token, `/*` and all: `url(a/*b)` is no
      // comment, and taken for one it ran on through the rest of the sheet
      i = urlEnd(text, i + 3) - 1;
    } else if (c === '{') {
      const inDecls = blocks.length ? blocks[blocks.length - 1] : decls;
      blocks.push(inDecls || !opensRuleList(text, prelude, i));
      prelude = i + 1;
      atRule = null;
    } else if (c === '}') {
      blocks.pop();
      prelude = i + 1;
      atRule = null;
    } else if (c === ';') {
      prelude = i + 1;
      atRule = null;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const inDecls = blocks.length ? blocks[blocks.length - 1] : decls;
      // `@media/**\/all` is `@media all`
      out += text.slice(from, i) + (inDecls || atRule ? ' ' : '');
      i = close < 0 ? text.length : close + 1;
      from = i + 1;
    }
  }
  return out + text.slice(from);
}

/** Whether the block a `{` at `end` opens holds rules rather than
 *  declarations: a conditional or grouping at-rule's does. */
function opensRuleList(text: string, from: number, end: number): boolean {
  let j = from;
  while (j < end && (isSpace(text[j]) || text[j] === '/')) {
    if (text[j] === '/' && text[j + 1] === '*') {
      const close = text.indexOf('*/', j + 2);
      j = close < 0 ? end : close + 2;
    } else if (text[j] === '/') {
      break;
    } else {
      j += 1;
    }
  }
  return text[j] === '@' && RULE_LIST_AT.test(text.slice(j + 1, end));
}

const RULE_LIST_AT =
  /^(?:media|supports|document|-moz-document|layer|container|scope|starting-style)(?![\w-])/i;

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
  text = withoutComments(text, true);
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
        const raw = text.slice(colon + 1, end);
        let value = raw.trim();
        const important = IMPORTANT_RE.test(value);
        if (important) value = value.replace(IMPORTANT_RE, '').trim();
        const custom = name.value.startsWith('--');
        // `--` alone is no custom property's name, and a bracket closed
        // that nothing opened makes a value none
        if (
          (value || custom) &&
          !hasBang(value) &&
          name.value !== '--' &&
          !(custom && unbalanced(value))
        ) {
          const declaration: Declaration = {
            // a custom property's name is case-sensitive
            prop: custom ? name.value : name.value.toLowerCase(),
            value: unescapeValue(value),
            important,
          };
          if (custom) declaration.custom = true;
          if (hasVar(value)) {
            // a `var()` that is none is a declaration that is none — read
            // untrimmed, since a newline in a string the end left open
            // makes a bad string, where the end alone closes it
            if (!validVars(raw)) {
              i = end + 1;
              continue;
            }
            declaration.vars = true;
          }
          out.push(declaration);
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
  const raw = rawSelectors(prelude);
  return raw && raw.map((s) => (s.includes('\\') ? forMatcher(s) : s));
}

/** A rule's selectors as written, or null where any of them is not one:
 *  what `selectorList` hands the matcher before its escapes are read, and
 *  what a nested rule's `&` stands for. */
function rawSelectors(prelude: string): string[] | null {
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
 * A selector's escapes as css-select reads them right. Its hex escapes go
 * in lower case: css-what takes the space that ends `\\6C ` for a
 * descendant combinator, where after `\\6c ` it does not. And in a string
 * an escaped newline goes, since it only continues the line (CSS 2.1
 * 4.3.7): `[title="a\\` and a newline and `b"]` is `[title="ab"]`.
 */
function forMatcher(selector: string): string {
  let quote = '';
  let out = '';
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '\\') {
      const end = escapeEnd(selector, i);
      const escape = selector.slice(i, end);
      if (/^\\[0-9a-f]/i.test(escape)) {
        // the hex digits, and the one space that may end them
        out += escape.toLowerCase().replace(/\s+$/, ' ');
      } else if (!(quote && /^\\[\n\r\f]/.test(escape))) {
        out += escape;
      }
      i = end - 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    }
    out += c;
  }
  return out;
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
  // a pseudo-element ends its selector (CSS 2.1 5.10): `p:first-line p`
  // is none, and neither is `p:first-line[id]` — but for the user action
  // pseudo-classes Selectors 4 lets follow one, as in `a::before:hover`
  let ended = false;
  while (i < n) {
    const c = s[i];
    if (isSpace(c)) {
      i += 1;
      continue;
    }
    if (ended) return false;
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
      if (
        ended &&
        !(
          d === ':' &&
          s[i + 1] !== ':' &&
          USER_ACTIONS.test(readIdent(s, i + 1).value)
        )
      ) {
        return false;
      }
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
        // an operator needs a value after it: `[title~=]` is no selector,
        // and takes its group with it (CSS 2.1 4.1.7)
        let k = identEnd(s, j);
        if (s[k] === '|' && s[k + 1] !== '=' && startsIdent(s, k + 1)) {
          k = identEnd(s, k + 1);
        }
        while (k < end - 1 && isSpace(s[k])) k += 1;
        if (k < end - 1) {
          if (s[k] === '=') k += 1;
          else if ('~|^$*'.includes(s[k]) && s[k + 1] === '=') k += 2;
          else return false;
          while (k < end - 1 && isSpace(s[k])) k += 1;
          if (k >= end - 1) return false;
        }
        i = end;
      } else if (d === ':') {
        const element = s[i + 1] === ':';
        const at = element ? i + 2 : i + 1;
        if (!startsIdent(s, at)) return false;
        const name = readIdent(s, at);
        // ASCII's case only (CSS 2.1 4.1.3): Unicode's makes `:lin\u212A`,
        // with a Kelvin sign, `:link`
        const lower = asciiLower(name.value);
        if (!knownPseudo(lower, element)) return false;
        if (element || LEGACY_PSEUDO_ELEMENTS.test(lower)) ended = true;
        i = name.end;
        if (s[i] === '(') {
          const end = componentEnd(s, i);
          if (s[end - 1] !== ')') return false;
          if (!element && !argumentFits(lower, s.slice(i + 1, end - 1))) {
            return false;
          }
          i = end;
        } else if (!element && NEEDS_ARGUMENT.has(lower)) return false;
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
 * Whether a pseudo-class takes the argument it is given: one where it
 * takes one — `:lang()` names no language, and makes its group invalid as
 * an unknown name does — and none where it takes none. `:is()` and
 * `:where()` forgive an empty list; a vendor's are its own affair.
 */
function argumentFits(name: string, argument: string): boolean {
  if (name.startsWith('-')) return true;
  if (NEEDS_ARGUMENT.has(name)) {
    return name === 'is' || name === 'where' || /\S/.test(argument);
  }
  return MAY_TAKE_ARGUMENT.has(name);
}

/** A name with its ASCII letters in lower case, and no other letter's. */
export function asciiLower(name: string): string {
  return name.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
}

/** The pseudo-classes that are functions, and are nothing without it. */
const NEEDS_ARGUMENT = new Set([
  'contains',
  'dir',
  'has',
  'host-context',
  'icontains',
  'is',
  'lang',
  'matches',
  'not',
  'nth-child',
  'nth-col',
  'nth-last-child',
  'nth-last-col',
  'nth-last-of-type',
  'nth-of-type',
  'state',
  'where',
]);

/** The ones that are a pseudo-class with an argument or without. */
const MAY_TAKE_ARGUMENT = new Set(['current', 'future', 'host', 'past']);

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

/** The pseudo-classes that may follow a pseudo-element. */
const USER_ACTIONS = /^(?:hover|active|focus|focus-visible|focus-within)$/i;

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
/** Where an escape at `at` ends: past its hex digits and the one space
 *  that may close them, or past the character it escapes. */
export function escapeEnd(text: string, at: number): number {
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
/** Where a `url(` whose parenthesis is at `paren` ends: past its `)`. */
export function urlEnd(text: string, paren: number): number {
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

/**
 * A `url(…)` as CSS Syntax 3 reads it (4.3.6): quoted, a string, which the
 * end of the sheet may close as it closes the parenthesis; or unquoted, to
 * its `)`, with white space only around it and its escapes resolved. `null`
 * for `none`, or a url of nothing. `undefined` for a bad url — a quote, a
 * parenthesis or white space inside an unquoted one, or anything after a
 * quoted one's string — which makes the declaration it is in invalid.
 */
export function parseUrl(value: string): string | null | undefined {
  const v = value.trim();
  if (!v || v.toLowerCase() === 'none') return null;
  if (!/^url\(/i.test(v)) return unquote(v) || null;
  let i = 4;
  while (i < v.length && isSpace(v[i])) i += 1;
  let out = '';
  const quote = v[i];
  if (quote === '"' || quote === "'") {
    i += 1;
    while (i < v.length && v[i] !== quote) {
      if (v[i] === '\\') {
        if (v[i + 1] === '\n') {
          i += 2;
          continue;
        }
        const escape = readEscape(v, i);
        out += escape.char;
        i = escape.end;
      } else {
        out += v[i];
        i += 1;
      }
    }
    i += 1;
    while (i < v.length && isSpace(v[i])) i += 1;
    if (i < v.length && v[i] !== ')') return undefined;
    return rest(v, i) ? undefined : out || null;
  }
  while (i < v.length && v[i] !== ')') {
    const c = v[i];
    if (isSpace(c)) {
      while (i < v.length && isSpace(v[i])) i += 1;
      if (i < v.length && v[i] !== ')') return undefined;
      break;
    }
    if (c === '"' || c === "'" || c === '(') return undefined;
    if (c === '\\') {
      if (!isEscape(v, i)) return undefined;
      const escape = readEscape(v, i);
      out += escape.char;
      i = escape.end;
      continue;
    }
    out += c;
    i += 1;
  }
  return rest(v, i) ? undefined : out || null;
}

/** Whether anything follows a url's `)` at `at`: `url(a) repeat` is no
 *  image, and the declaration it is in is invalid. */
function rest(v: string, at: number): boolean {
  return at + 1 < v.length && v.slice(at + 1).trim() !== '';
}

function unquote(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    (v[0] === '"' || v[0] === "'") &&
    v[v.length - 1] === v[0]
  ) {
    return v.slice(1, -1);
  }
  return v;
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
  if (!value.includes('!')) return false;
  for (let at = scanTo(value, 0, '!'); at < value.length;) {
    // `<!--` is a token of its own, which a custom property may hold
    if (value[at - 1] !== '<' || !value.startsWith('--', at + 1)) return true;
    at = scanTo(value, at + 1, '!');
  }
  return false;
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

/** Where a width past a maximum starts, for the widths a restyle is due
 *  at: a sixty-fourth of a pixel past it, where the widths a display scale
 *  divides a device width into (`640.5` at 2x) fall on the right side. */
const MAX_EDGE = 1 / 64;

/**
 * A width range in Media Queries 4's syntax — `(width >= 48rem)`, `(60rem >
 * width)`, `(40rem <= width < 60rem)` — as the widths it holds between, or
 * null for a term that is not one. A strict bound is a sixty-fourth of a
 * pixel inside the value, where a viewport's width never lands.
 */
function widthRange(
  term: string,
  feature: 'width' | 'height' = 'width',
): { min?: number; max?: number } | null {
  const inner = /^\(\s*(.*?)\s*\)$/.exec(term)?.[1];
  if (!inner || !/[<>=]/.test(inner)) return null;
  const parts = inner.split(/\s*(<=|>=|<|>|=)\s*/);
  const isWidth = (part: string) => part.toLowerCase() === feature;
  const out: { min?: number; max?: number } = {};
  // `width OP value`, with the operator read from the width's side
  const bound = (op: string, value: string): boolean => {
    const len = parseLength(value, ZERO_UNITS);
    if (typeof len !== 'number') return false;
    const edge = 1 / 64;
    if (op === '>=' || op === '=') out.min = Math.max(out.min ?? 0, len);
    if (op === '>') out.min = Math.max(out.min ?? 0, len + edge);
    if (op === '<=' || op === '=') out.max = Math.min(out.max ?? Infinity, len);
    if (op === '<') out.max = Math.min(out.max ?? Infinity, len - edge);
    return true;
  };
  const flip: Record<string, string> = {
    '<': '>',
    '<=': '>=',
    '>': '<',
    '>=': '<=',
    '=': '=',
  };
  if (parts.length === 3 && isWidth(parts[0])) {
    return bound(parts[1], parts[2]) ? out : null;
  }
  if (parts.length === 3 && isWidth(parts[2])) {
    return bound(flip[parts[1]], parts[0]) ? out : null;
  }
  if (parts.length === 5 && isWidth(parts[2])) {
    return bound(flip[parts[1]], parts[0]) && bound(parts[3], parts[4])
      ? out
      : null;
  }
  return null;
}

/** How deep rules may nest before the ones further in are dropped: far
 *  past anything written by hand or by a framework, and short of what a
 *  generated sheet could make of the stack. */
const MAX_NESTING = 16;

type Nested =
  | { kind: 'rule'; prelude: string; body: string }
  | { kind: 'at'; name: string; prelude: string; block: string | null };

/**
 * A style rule's block, parted into its declarations and the rules nested
 * in it. A declaration runs to its `;` and a nested rule to its block,
 * whichever comes first — `color: red;` and `a:hover { … }` — and a custom
 * property is a declaration whatever its value holds.
 */
function splitNested(body: string): {
  declarations: string;
  nested: Nested[];
} {
  let declarations = '';
  const nested: Nested[] = [];
  let i = 0;
  while (i < body.length) {
    i = skipTrivia(body, i);
    if (i >= body.length) break;
    if (body[i] === ';') {
      i += 1;
      continue;
    }
    if (body[i] === '@' && startsIdent(body, i + 1)) {
      const at = readAtRule(body, i);
      nested.push({
        kind: 'at',
        name: at.name,
        prelude: at.prelude,
        block: at.block,
      });
      i = at.end;
      continue;
    }
    const semi = scanTo(body, i, ';');
    const brace = scanTo(body, i, '{');
    if (brace < semi && !CUSTOM_DECLARATION.test(body.slice(i, brace))) {
      const block = readBlock(body, brace);
      nested.push({
        kind: 'rule',
        prelude: body.slice(i, brace).trim(),
        body: block.body,
      });
      i = block.end;
      continue;
    }
    declarations += `${body.slice(i, semi)};`;
    i = semi + 1;
  }
  return { declarations, nested };
}

const CUSTOM_DECLARATION = /^\s*--[\w-]*\s*:/;

/**
 * A nested rule's selectors against its parent's, as written (CSS Nesting
 * 1, 3): a selector that starts with `&` is the parent's with the rest
 * after it, `&:hover` the parent hovered; any other `&` is `:is()` of the
 * parent; one with none is relative to the parent, a descendant unless it
 * starts with a combinator. Null where one of them comes to no selector.
 */
function nestedSelectors(prelude: string, parents: string[]): string[] | null {
  const out: string[] = [];
  for (const part of splitTopLevel(prelude, ',')) {
    const written = part.trim();
    if (!written) return null;
    const own = hasNesting(written) ? written : `& ${written}`;
    for (const parent of parents) {
      const resolved =
        own[0] === '&' &&
        !hasNesting(own.slice(1)) &&
        !/^[\w-]/.test(own.slice(1))
          ? parent + own.slice(1)
          : replaceNesting(own, `:is(${parent})`);
      if (!isSelector(resolved)) return null;
      out.push(resolved);
    }
  }
  return out;
}

/** Whether a selector has a `&` outside its strings and escapes. */
function hasNesting(selector: string): boolean {
  return replaceNesting(selector, '') !== selector;
}

/** A selector with every `&` outside its strings and escapes replaced. */
function replaceNesting(selector: string, by: string): string {
  if (!selector.includes('&')) return selector;
  let out = '';
  let quote = '';
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '\\') {
      out += selector.slice(i, i + 2);
      i += 1;
    } else if (quote) {
      if (c === quote) quote = '';
      out += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else out += c === '&' ? by : c;
  }
  return out;
}

/** A list's items at the top level: no string, escape or bracket parts
 *  them. */
function splitTopLevel(text: string, at: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === at) {
      out.push(text.slice(start, i));
      start = i + 1;
      i += 1;
    } else {
      i = opens(text.charCodeAt(i)) ? componentEnd(text, i) : i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function importUrl(prelude: string): string | null {
  const m = /^\s*(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/.exec(prelude);
  return m ? m[1] : null;
}

/** Whether an `@import`'s media list, the rest of its prelude after the
 *  URL, lets it apply here: a list that only names other media, `print` or
 *  `braille`, leaves the sheet out (CSS 2.1 6.3). A list that depends on the
 *  width is taken to apply; an import is fetched once, not per width. */
function importApplies(prelude: string): boolean {
  const m =
    /^\s*(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')(.*)$/s.exec(
      prelude,
    );
  const list = m?.[1].trim();
  if (!list) return true;
  return parseMediaQuery(list).some((c) => c.staticPass !== false);
}

/**
 * A declaration value with every `url()` in it made absolute against `base`
 * — inside a function too, `image-set()` or a `var()` fallback, and never
 * inside a string. `url(#id)`, a reference into the document itself, is left
 * as it is, as are a `data:` URL, absolute already, and a url that is none.
 */
export function absoluteUrls(value: string, base: string): string {
  if (!/url\(/i.test(value)) return value;
  let out = '';
  let from = 0;
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === '"' || c === "'") {
      i = stringEnd(value, i);
      continue;
    }
    if (c === '\\') {
      i = escapeEnd(value, i);
      continue;
    }
    if (
      (c === 'u' || c === 'U') &&
      value[i + 3] === '(' &&
      value.slice(i, i + 3).toLowerCase() === 'url' &&
      !isNameChar(value[i - 1])
    ) {
      const end = urlEnd(value, i + 3);
      const url = parseUrl(value.slice(i, end));
      if (typeof url === 'string' && url[0] !== '#' && !/^data:/i.test(url)) {
        const resolved = resolveUrl(url, base);
        if (resolved !== url) {
          out += value.slice(from, i) + cssUrl(resolved);
          from = end;
        }
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return from === 0 ? value : out + value.slice(from);
}

/** A URL as a `url()` that reads back as it: quoted, with the characters a
 *  string cannot hold as they are escaped. */
function cssUrl(url: string): string {
  const escaped = url.replace(/[\\"\n]/g, (c) =>
    c === '\n' ? '\\a ' : `\\${c}`,
  );
  return `url("${escaped}")`;
}

/** The generic families: a `@font-face` may not take one's name, and one
 *  that did would take over every element that asks for it. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
  'inherit',
  'initial',
  'unset',
  'revert',
  'default',
]);

/**
 * A `@font-face` block, or null when it names no family, or no source this
 * can ask for: `local()` names a face the system has, which this does not
 * look up, and a family that is only `local()`s is left to the system as it
 * would be anyway.
 */
function parseFontFace(
  block: string,
  base: string | null,
  media: MediaCondition[][] | null,
): FontFaceRule | null {
  let family: string | null = null;
  let src: string | null = null;
  let weight: [number, number] = [400, 400];
  let style: 'normal' | 'italic' = 'normal';
  let unicodeRange: [number, number][] | null = null;
  // a descriptor that is not one is dropped, as a declaration is, and the
  // one before it stands
  for (const d of parseDeclarations(block)) {
    if (d.prop === 'font-family') {
      family = faceFamily(d.value) ?? family;
    } else if (d.prop === 'src') {
      src = d.value;
    } else if (d.prop === 'font-weight') {
      weight = faceWeight(d.value) ?? weight;
    } else if (d.prop === 'font-style') {
      const v = d.value.trim().toLowerCase();
      if (v === 'normal') style = 'normal';
      else if (v === 'italic' || /^oblique\b/.test(v)) style = 'italic';
    } else if (d.prop === 'unicode-range') {
      unicodeRange = unicodeRanges(d.value) ?? unicodeRange;
    }
  }
  if (!family || src === null) return null;
  const sources: FontFaceSource[] = [];
  for (const part of splitTopLevel(src, ',')) {
    const item = part.trim();
    if (!/^url\(/i.test(item)) continue;
    const end = urlEnd(item, 3);
    const url = parseUrl(item.slice(0, end));
    if (typeof url !== 'string') continue;
    // `format("woff2")`, the older `format(woff2)`, or a list of them, of
    // which the first says enough
    const hint = /format\(\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))/i.exec(
      item.slice(end),
    );
    const format = hint ? (hint[1] ?? hint[2] ?? hint[3]).toLowerCase() : null;
    sources.push({ url: resolveUrl(url, base), format });
  }
  if (!sources.length) return null;
  return { family, sources, weight, style, unicodeRange, media };
}

/** A `@font-face`'s one family name: a string, or identifiers, which one
 *  space joins. Not a list, and not a generic family's name. */
function faceFamily(value: string): string | null {
  const v = value.trim();
  let name: string;
  if (v[0] === '"' || v[0] === "'") {
    if (stringEnd(v, 0) !== v.length) return null;
    name = unquote(v).trim();
  } else {
    const words = v.split(/\s+/);
    for (const word of words) {
      if (!startsIdent(word, 0) || readIdent(word, 0).end !== word.length) {
        return null;
      }
    }
    name = words.join(' ');
  }
  if (!name || name.includes(',')) return null;
  return GENERIC_FAMILIES.has(name.toLowerCase()) ? null : name;
}

/** A `@font-face`'s `font-weight`: one weight, or the range a variable face
 *  covers. `auto` — the file's own range — is taken to be every weight. */
function faceWeight(value: string): [number, number] | null {
  const parts = value.trim().toLowerCase().split(/\s+/);
  const one = (p: string): number | null => {
    if (p === 'normal') return 400;
    if (p === 'bold') return 700;
    if (!/^\d+(?:\.\d+)?$/.test(p)) return null;
    const n = Number(p);
    return n >= 1 && n <= 1000 ? n : null;
  };
  if (parts.length === 1) {
    if (parts[0] === 'auto') return [1, 1000];
    const w = one(parts[0]);
    return w === null ? null : [w, w];
  }
  if (parts.length !== 2) return null;
  const a = one(parts[0]);
  const b = one(parts[1]);
  if (a === null || b === null) return null;
  return a <= b ? [a, b] : [b, a];
}

/** `unicode-range`: `U+26`, `U+0-7F`, `U+4??` — inclusive ranges, or null
 *  when any part is not one, and the descriptor is dropped. */
function unicodeRanges(value: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const part of value.split(',')) {
    const m = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!m) return null;
    let lo: number;
    let hi: number;
    if (m[1].includes('?')) {
      if (m[2] || !/^[0-9a-f]*\?+$/i.test(m[1])) return null;
      lo = parseInt(m[1].replace(/\?/g, '0'), 16);
      hi = parseInt(m[1].replace(/\?/g, 'f'), 16);
    } else {
      lo = parseInt(m[1], 16);
      hi = m[2] ? parseInt(m[2], 16) : lo;
    }
    if (hi < lo || lo > 0x10ffff) return null;
    out.push([lo, Math.min(hi, 0x10ffff)]);
  }
  return out.length ? out : null;
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
    let sawHeight = false;
    const negated = /^\s*not\b/i.test(group);
    for (const part of group.split(/\s+and\s+/i)) {
      const term = part
        .trim()
        .replace(/^not\s+/i, '')
        .replace(/^only\s+/i, '');
      if (!term) continue;
      // Media Queries 4's ranges, which Tailwind 4 writes its breakpoints
      // in: `(width >= 48rem)`, `(40rem <= width < 60rem)`
      const range = widthRange(term);
      if (range) {
        if (range.min !== undefined) {
          condition.min = Math.max(condition.min ?? 0, range.min);
        }
        if (range.max !== undefined) {
          condition.max = Math.min(condition.max ?? Infinity, range.max);
        }
        sawWidth = true;
        continue;
      }
      const heights = widthRange(term, 'height');
      if (heights) {
        if (heights.min !== undefined) {
          condition.minHeight = Math.max(condition.minHeight ?? 0, heights.min);
        }
        if (heights.max !== undefined) {
          condition.maxHeight = Math.min(
            condition.maxHeight ?? Infinity,
            heights.max,
          );
        }
        sawHeight = true;
        continue;
      }
      const feature = mediaFeature(term);
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
        } else if (key === 'min-height' && px !== null) {
          // the viewport's height, answered live as its width is: a
          // design that sets its heading's size by the window's height
          // took the tallest step's at every height
          condition.minHeight = Math.max(condition.minHeight ?? 0, px);
          sawHeight = true;
        } else if (key === 'max-height' && px !== null) {
          condition.maxHeight = Math.min(condition.maxHeight ?? Infinity, px);
          sawHeight = true;
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
      // any other medium is not this one: `print`, `speech`, and the ones
      // CSS 2.1 named that Media Queries retired, `braille`, `embossed`,
      // `handheld`, `projection`, `tty`, `tv`. A term that is no name is
      // left as it was.
      if (/^[a-z-]+$/.test(type)) pass = false;
    }
    if (negated) {
      // `not` over a scheme is the other scheme. `not` over a width range
      // is not expressible as one range; the honest reduction is to decide
      // it statically rather than invert it wrongly.
      if (!sawWidth && !sawHeight && pass && condition.scheme) {
        out.push({ scheme: condition.scheme === 'dark' ? 'light' : 'dark' });
        continue;
      }
      out.push({
        staticPass: !sawWidth && !sawHeight && pass ? false : !pass,
      });
      continue;
    }
    if (!pass) {
      out.push({ staticPass: false });
      continue;
    }
    if (
      !sawWidth &&
      !sawHeight &&
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

/**
 * The properties whose support a `@supports` condition is answered for:
 * the mask's, which pages test before they draw an icon as a masked colour
 * and keep a background image under `not` for an engine without them.
 * Drawn here, and the fallback drawn too, an icon was its image in black
 * under the mask, over the colour it was meant to be.
 */
const ANSWERED = new Set(
  [
    'mask',
    'mask-image',
    'mask-repeat',
    'mask-position',
    'mask-size',
    'mask-origin',
    'mask-clip',
  ].flatMap((name) => [name, `-webkit-${name}`]),
);

/**
 * Whether a `@supports` condition holds (CSS Conditional 3, 6): true or
 * false where it turns on declarations of the properties this answers for
 * (`ANSWERED`), combined by `not`, `and` and `or`; null where it turns on
 * anything else, or is none, and the block is entered as every one was.
 * Answering more is not safe without a list of what this draws: Tailwind 4
 * keeps its variables' starting values under a test for engines without
 * `@property`, which this is, and false there would drop every shadow and
 * gradient it writes.
 */
export function supportsCondition(prelude: string): boolean | null {
  const text = prelude.trim();
  if (/^not\b/i.test(text)) {
    const inner = supportsCondition(text.slice(3));
    return inner === null ? null : !inner;
  }
  // the terms at the top level, and the one operator between them
  const terms: string[] = [];
  let op = '';
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && /\s/.test(c)) {
      const word = /^\s+(and|or)\s+/i.exec(text.slice(i));
      if (!word) continue;
      const next = word[1].toLowerCase();
      // `and` and `or` mixed without parentheses is no condition
      if (op && op !== next) return null;
      op = next;
      terms.push(text.slice(start, i));
      i += word[0].length - 1;
      start = i + 1;
    }
    if (depth < 0) return null;
  }
  if (terms.length) {
    terms.push(text.slice(start));
    const values = terms.map(supportsCondition);
    if (op === 'and') {
      if (values.includes(false)) return false;
      return values.includes(null) ? null : true;
    }
    if (values.includes(true)) return true;
    return values.includes(null) ? null : false;
  }
  // one term: a condition in parentheses, or a declaration in them
  if (!(text.startsWith('(') && text.endsWith(')'))) return null;
  const inner = text.slice(1, -1).trim();
  if (inner.startsWith('(') || /^not\b/i.test(inner)) {
    return supportsCondition(inner);
  }
  const declaration = /^([a-z-]+)\s*:\s*(\S[\s\S]*)$/i.exec(inner);
  if (!declaration || !ANSWERED.has(declaration[1].toLowerCase())) return null;
  return true;
}

/**
 * A `(name: value)` media feature: the whole term, its name, and its value
 * read to the parenthesis that closes the feature, or null where the term is
 * no such thing. A value may hold parentheses of its own: MediaWiki's
 * breakpoints are `(max-width: calc(640px - 1px))`, and a value read to the
 * first `)` found no feature there — the term was passed over as though it
 * said nothing, and every narrow-screen rule held at every width.
 */
function mediaFeature(term: string): [string, string, string] | null {
  const m = /^\(\s*([a-z-]+)\s*:([\s\S]*)\)$/i.exec(term);
  if (!m) return null;
  let depth = 0;
  for (const c of m[2]) {
    if (c === '(') depth += 1;
    else if (c === ')' && --depth < 0) return null;
  }
  const value = m[2].trim();
  return depth === 0 && value ? [term, m[1], value] : null;
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
  /** The viewport's height in CSS pixels; a test of it holds at no height
   *  where none is given. */
  height = NaN,
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
        (c.minHeight === undefined || height >= c.minHeight) &&
        (c.maxHeight === undefined || height <= c.maxHeight) &&
        (c.scheme === undefined || c.scheme === scheme)
      ) {
        any = true;
      }
    }
    if (!any) return false;
  }
  return true;
}
