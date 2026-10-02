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
import { parseLength, parseStretch, splitValue } from './values.js';
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
  /** The computed fields the declaration sets, in place of reading its
   *  value: what an animation comes to between two frames, which no value
   *  written in CSS need be (`Cascade._animatedDeclarations`). */
  computed?: Readonly<Record<string, unknown>>;
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
  /** Each import's media query list, where it has one: the condition the
   *  sheet it brings in is under, as though an `@media` block were around
   *  all of it (CSS Cascade 4, 2). Null for an import with none. */
  importConditions: (MediaCondition[] | null)[];
  /** Every width a `@media` rule in this sheet switches on. The renderer
   *  keeps these so a resize can tell "the layout changed" from "the
   *  *cascade* changed", and restyle only when it crossed one. */
  breakpoints: number[];
  /** Whether a `@media` rule in this sheet tests the viewport's height,
   *  which makes a document restyle when the height moves, as a `vh`
   *  does. */
  readsHeight?: boolean;
  /** Whether one tests its aspect ratio, which a width that crosses no
   *  breakpoint can change: the document restyles as one with a `vw`
   *  does. */
  readsWidth?: boolean;
  /** The `@font-face` rules, in order (see `fonts.ts`). */
  fontFaces: FontFaceRule[];
  /** `@counter-style` rules, in order: a name and its descriptors, which
   *  the cascade reads into counter styles (CSS Counter Styles 3, 3). */
  counterStyles?: { prelude: string; declarations: Declaration[] }[];
  /** `@keyframes` rules, in order (`KeyframesRule`). */
  keyframes?: KeyframesRule[];
}

/**
 * One `@keyframes` rule (CSS Animations 1, 3): the frames of the animation
 * an `animation-name` names. Which rule a name finds is the cascade's to
 * say (`Cascade.keyframes`): the last of its name whose media hold, in the
 * latest layer, and never a prefixed one over one that is not.
 */
export interface KeyframesRule {
  /** As written: a name is case-sensitive, as a custom ident is. */
  name: string;
  /** `@-webkit-keyframes`, which Chrome reads and which never takes the
   *  place of an `@keyframes` of the same name, wherever either comes. */
  prefixed: boolean;
  /** The frames in the order written, which is the order two at one
   *  offset cascade in. */
  frames: Keyframe[];
  /** The `@media` blocks the rule sits under, as a style rule's. */
  media: MediaCondition[][] | null;
  /** The cascade layer the rule is in, as a style rule's. */
  layer: readonly number[] | null;
}

/** One frame of a `@keyframes`: a block of declarations at the offsets its
 *  selector names. */
export interface Keyframe {
  /** Where in an iteration the frame is, 0 to 1: one per selector in its
   *  list, `from` 0 and `to` 1. */
  offsets: number[];
  /** What the frame sets: no `!important` one, which a frame ignores, and
   *  none of the animation's or a transition's own properties. */
  declarations: Declaration[];
  /** The `animation-timing-function` the frame eases to the next one by,
   *  as written; null where it gives none and the animation's is used. */
  easing: string | null;
}

/**
 * One `@font-face` (CSS Fonts 4, 4): a face of a family, and where to get
 * it. The descriptors are kept to what choosing and registering a face
 * reads — `font-display` and the feature descriptors are not.
 */
export interface FontFaceRule {
  /** The family as the document names it, unquoted. */
  family: string;
  /** The entries of `src`, in order, which is the order they are tried in:
   *  a `url()` with its `format()` hint lowercased, or the name a `local()`
   *  asks the system for. */
  sources: FontFaceSource[];
  /** The weights the face covers: `[400, 400]` for a static regular, a
   *  range for a variable face. */
  weight: [number, number];
  style: 'normal' | 'italic';
  /** The widths the face covers, as `font-stretch` percentages: `[75, 75]`
   *  for a condensed face, a range for a variable one. Null for `auto`,
   *  which is matched as `normal` and sets no bound on a `wdth` axis
   *  (CSS Fonts 4, 4.4). */
  stretch: [number, number] | null;
  /** Code point ranges, inclusive; null for every code point. */
  unicodeRange: [number, number][] | null;
  /** The `@media` blocks the rule sits under, as a style rule's. */
  media: MediaCondition[][] | null;
}

export type FontFaceSource =
  | { url: string; format: string | null }
  /** `local(Arial)`: a face the system has, by name and unquoted. */
  | { local: string };

/** The tests this evaluates live, all of which must hold: bounds on the
 *  width, the height, the resolution and the aspect ratio, and a colour
 *  scheme. A query's `or` is more than one condition, and its `not` the
 *  bounds on the other side (`parseMediaQuery`). Anything else — `print`,
 *  `hover`, `prefers-reduced-motion` — is decided once, at parse time, by
 *  `staticPass`. */
export interface MediaCondition {
  min?: number;
  max?: number;
  /** The viewport's height, as `min`/`max` its width: `min-height`,
   *  `max-height` and a range on `height` (Media Queries 4, 4.2). */
  minHeight?: number;
  maxHeight?: number;
  /** The display's resolution in dots per CSS pixel, its scale: `min-`
   *  and `max-resolution`, and WebKit's `-webkit-min-device-pixel-ratio`,
   *  which a design writes to swap in its high-DPI images. */
  minResolution?: number;
  maxResolution?: number;
  /** The viewport's width over its height: `aspect-ratio` and its `min-`
   *  and `max-`, the device's the viewport's too, and `orientation`, which
   *  is landscape where the width is the greater. */
  minAspect?: number;
  maxAspect?: number;
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
  /** The media queries the whole sheet is under, outermost first: the ones
   *  of the `@import` that brought it in, and of the imports that brought
   *  that sheet in. Every rule and face in it is under them, as one inside
   *  an `@media` block is under the block's. */
  under: MediaCondition[][] | null = null,
): Stylesheet {
  text = withoutComments(text);
  const sheet: Stylesheet = {
    rules: [],
    imports: [],
    importConditions: [],
    breakpoints: [],
    fontFaces: [],
  };
  let order = startOrder;
  const breakpoints = new Set<number>();
  /** What a media query list tests that a resize has to restyle for: the
   *  widths it changes its mind at, and whether it reads the height. */
  const note = (conditions: MediaCondition[]): void => {
    for (const c of conditions) {
      if (c.min !== undefined) breakpoints.add(c.min);
      if (c.max !== undefined) breakpoints.add(c.max + MAX_EDGE);
      if (c.minHeight !== undefined || c.maxHeight !== undefined) {
        sheet.readsHeight = true;
      }
      if (c.minAspect !== undefined || c.maxAspect !== undefined) {
        sheet.readsHeight = true;
        sheet.readsWidth = true;
      }
    }
  };
  for (const conditions of under ?? []) note(conditions);
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
          if (importsAllowed && media === under) {
            const url = importUrl(at.prelude);
            const conditions = importConditions(at.prelude);
            if (url && conditions !== false) {
              sheet.imports.push(resolveUrl(url, base));
              sheet.importConditions.push(conditions);
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
          note(conditions);
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
        } else if (
          (name === 'keyframes' || name === '-webkit-keyframes') &&
          at.block !== null
        ) {
          const keyframes = parseKeyframes(at.prelude, at.block);
          if (keyframes) {
            (sheet.keyframes ??= []).push({
              ...keyframes,
              prefixed: name !== 'keyframes',
              media,
              layer,
            });
          }
        }
        // @page, and an at-rule nobody knows: nothing to do, and the block
        // was already consumed.
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
        note(conditions);
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

  walk(text, under);
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
 * and a pseudo-*element* (`::before`) counts as a type. A pseudo-class
 * that takes selectors counts as Selectors 4 (17) has it: `:is()`,
 * `:not()` and `:has()` as the most specific selector in their list,
 * `:where()` as nothing, and `:nth-child(An+B of S)` as a class and the
 * most specific in S. Counted as a class each, `:where()` was not the
 * zero a library writes it to be: a typography plugin's
 * `.prose :where(p)` beat a page's own `.intro p`.
 */
const LEGACY_PSEUDO_ELEMENTS = /^(?:before|after|first-line|first-letter)$/i;

/** The pseudo-classes that may follow a pseudo-element. */
const USER_ACTIONS = /^(?:hover|active|focus|focus-visible|focus-within)$/i;

export function specificityOf(selector: string): number {
  let ids = 0;
  let classes = 0;
  let types = 0;
  /** What the selectors inside pseudo-classes come to, packed. */
  let inner = 0;
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
        const lower = name.value.toLowerCase();
        i = name.end;
        let argument: string | null = null;
        if (selector[i] === '(') {
          const end = componentEnd(selector, i);
          argument = selector.slice(i + 1, end - 1);
          i = end;
        }
        // CSS 2 spelled the four pseudo-elements it had with one colon
        if (LEGACY_PSEUDO_ELEMENTS.test(name.value)) {
          types += 1;
        } else if (argument !== null && SELECTOR_LIST_PSEUDOS.has(lower)) {
          inner += mostSpecific(argument);
        } else if (argument !== null && lower === 'where') {
          // nothing
        } else {
          classes += 1;
          if (argument !== null && NTH_OF_PSEUDOS.has(lower)) {
            const of = /\sof\s/i.exec(argument);
            if (of)
              inner += mostSpecific(argument.slice(of.index + of[0].length));
          }
        }
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
  return ids * 1_000_000 + classes * 1_000 + types + inner;
}

/** The pseudo-classes whose specificity is their argument's most specific
 *  selector, the old names of `:is()` among them. */
const SELECTOR_LIST_PSEUDOS = new Set([
  'is',
  'not',
  'has',
  'matches',
  '-webkit-any',
  '-moz-any',
]);

/** The pseudo-classes an `of S` may follow. */
const NTH_OF_PSEUDOS = new Set(['nth-child', 'nth-last-child']);

/** The specificity of the most specific selector in a list, packed. */
function mostSpecific(list: string): number {
  let most = 0;
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= list.length; i += 1) {
    const c = list[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === '"' || c === "'" || c === '\\') {
      i = componentEnd(list, i) - 1;
    } else if ((c === ',' && depth === 0) || i === list.length) {
      most = Math.max(most, specificityOf(list.slice(start, i)));
      start = i + 1;
    }
  }
  return most;
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

/** How far past a ratio a bound beyond it is — an aspect ratio's or a
 *  resolution's: past square is any width over the height. A power of two,
 *  so that a bound taken to its opposite and back is the number it was:
 *  `not (orientation: landscape)` is portrait, a square viewport included. */
const RATIO_EDGE = 2 ** -30;

/**
 * The media features that are the viewport's width and its height here.
 * `device-width` and `device-height` are the Web-exposed screen area's
 * (Media Queries 4, appendix A), which a user agent may answer with the
 * viewport's (CSSOM View 2.3), and a document drawn into an element has no
 * screen of its own to answer with. Deprecated, and still what a page from
 * before `width` asks with: DuckDuckGo Lite's phone sheet is
 * `(max-device-width: 700px)`, and a query that went unread held, so a
 * desktop window got the phone's 12px dropdowns.
 */
const VIEWPORT_SIDES = {
  width: new Set(['width', 'device-width']),
  height: new Set(['height', 'device-height']),
};

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
  const isWidth = (part: string) =>
    VIEWPORT_SIDES[feature].has(part.toLowerCase());
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

/**
 * An `@import`'s media query list, the rest of its prelude after the URL:
 * null where it has none, and false where no query in it can ever hold
 * here — a list that only names other media, `print` or `braille` — which
 * leaves the sheet out, unasked for (CSS 2.1 6.3). Any other list is the
 * condition the sheet it imports is under (CSS Cascade 4, 2): the sheet is
 * fetched once, and its rules hold at the widths the list does. Taken to
 * hold at every width, as it was, a design that imports a sheet a
 * breakpoint — the Zen Garden's 219, `@import url("219-1367.css") all and
 * (min-width: 1367px)` — had all of them at once.
 */
function importConditions(prelude: string): MediaCondition[] | null | false {
  const m =
    /^\s*(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')(.*)$/s.exec(
      prelude,
    );
  const list = m?.[1].trim();
  if (!list) return null;
  const conditions = parseMediaQuery(list);
  if (!conditions.some((c) => c.staticPass !== false)) return false;
  // one that always holds is no condition
  return conditions.some((c) => c.staticPass === true) ? null : conditions;
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

/** The properties a keyframe does not set: the animation's own, and a
 *  transition's (CSS Animations 1, 3). */
const NOT_IN_KEYFRAMES = /^(?:-webkit-)?(?:animation|transition)(?:-|$)/;

/** A `<number-token>` percentage, `+12.5%` or `1e2%`. */
const KEYFRAME_PERCENT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%$/i;

/**
 * A `@keyframes` block's name and frames (CSS Animations 1, 3), or null
 * where its prelude is no name. A frame whose selector is not a list of
 * `from`, `to` and percentages from 0 to 100 is dropped whole, as a style
 * rule with a bad selector is, and the frames around it stand.
 */
function parseKeyframes(
  prelude: string,
  block: string,
): { name: string; frames: Keyframe[] } | null {
  const name = keyframesName(prelude);
  if (name === null) return null;
  const frames: Keyframe[] = [];
  let i = 0;
  const n = block.length;
  while (i < n) {
    i = skipTrivia(block, i);
    if (i >= n) break;
    // a frame holds declarations and nothing else
    if (block[i] === '@' && startsIdent(block, i + 1)) {
      i = readAtRule(block, i).end;
      continue;
    }
    const braceAt = scanTo(block, i, '{');
    if (braceAt >= n) break;
    const selector = block.slice(i, braceAt);
    const body = readBlock(block, braceAt);
    i = body.end;
    const offsets = keyframeOffsets(selector);
    if (!offsets) continue;
    let easing: string | null = null;
    const declarations: Declaration[] = [];
    for (const d of parseDeclarations(body.body)) {
      if (d.important) continue;
      if (
        d.prop === 'animation-timing-function' ||
        d.prop === '-webkit-animation-timing-function'
      ) {
        easing = d.value;
      } else if (!NOT_IN_KEYFRAMES.test(d.prop)) {
        declarations.push(d);
      }
    }
    frames.push({ offsets, declarations, easing });
  }
  return { name, frames };
}

/** A `@keyframes` prelude's name: a string, or an identifier that is not
 *  `none` or a CSS-wide keyword; null for anything else. */
function keyframesName(prelude: string): string | null {
  const v = prelude.trim();
  if (!v) return null;
  if (v[0] === '"' || v[0] === "'") {
    const name = unquote(v);
    return name !== v && name ? name : null;
  }
  if (!startsIdent(v, 0)) return null;
  const ident = readIdent(v, 0);
  if (ident.end !== v.length) return null;
  return KEYFRAMES_RESERVED.has(ident.value.toLowerCase()) ? null : ident.value;
}

const KEYFRAMES_RESERVED = new Set([
  'none',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'default',
]);

/** A keyframe selector's offsets, 0 to 1, or null where any of its list is
 *  not one. */
function keyframeOffsets(selector: string): number[] | null {
  const out: number[] = [];
  for (const part of selector.split(',')) {
    const v = part.trim().toLowerCase();
    if (v === 'from') out.push(0);
    else if (v === 'to') out.push(1);
    else if (KEYFRAME_PERCENT.test(v)) {
      const pct = Number(v.slice(0, -1));
      if (!(pct >= 0 && pct <= 100)) return null;
      out.push(pct / 100);
    } else {
      return null;
    }
  }
  return out;
}

/**
 * A `@font-face` block, or null when it names no family or no source — a
 * rule CSS Fonts 4 (4.3) drops whole. A rule whose sources are all
 * `local()`s is a rule like any other: its family is the document's, and
 * left out here, `"GeistSans Fallback"` — next/font's `src: local("Arial")`
 * with the metrics adjusted — reached the text engine as a name to look up,
 * where fontconfig's nearest guess for a family nobody has set a site's
 * headings in Gill Sans Ultra Bold.
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
  let stretch: [number, number] | null = null;
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
    } else if (d.prop === 'font-stretch') {
      const range = faceStretch(d.value);
      if (range !== undefined) stretch = range;
    } else if (d.prop === 'unicode-range') {
      unicodeRange = unicodeRanges(d.value) ?? unicodeRange;
    }
  }
  if (!family || src === null) return null;
  const sources: FontFaceSource[] = [];
  for (const part of splitTopLevel(src, ',')) {
    const item = part.trim();
    // `local(Gentium Bold)`, `local("Gentium Bold")`: a name as a family's
    // is written, and like one never a keyword (`local(inherit)`)
    const local = /^local\(([\s\S]*)\)$/i.exec(item);
    if (local) {
      const name = faceFamily(local[1]);
      if (name) sources.push({ local: name });
      continue;
    }
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
  return { family, sources, weight, style, stretch, unicodeRange, media };
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

/**
 * A `@font-face`'s `font-stretch` (CSS Fonts 4, 4.4): `auto`, one width or
 * the range a variable face covers, each a keyword or a percentage, as the
 * property takes them — null for `auto`, and undefined for a value that is
 * none of them, which drops the descriptor. A range written high to low is
 * the same range.
 *
 * Chrome and Safari drop a range with a keyword in it, and Chrome reads
 * `normal` as `auto`; Firefox reads both as the spec has them, and so does
 * this.
 */
function faceStretch(value: string): [number, number] | null | undefined {
  const parts = splitValue(value);
  if (parts.length === 1 && parts[0].toLowerCase() === 'auto') return null;
  if (parts.length < 1 || parts.length > 2) return undefined;
  const ends = parts.map((p) => parseStretch(p));
  const [a, b = a] = ends;
  if (a === null || b === null) return undefined;
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
 * A media query list (Media Queries 4, 3), as the conditions it holds
 * under: any one of them is enough, and each is a run of tests that must
 * all hold. A query is read by Media Queries 4's grammar — `and`, `or` and
 * `not`, over features in parentheses and conditions in them — and one that
 * is none, `(a) and (b) or (c)` or `only (a)`, holds nowhere (3.2). A
 * feature nothing knows, or a value its feature does not take, is neither
 * true nor false (3.2's unknown): `not (unknown: 1)` holds nowhere, as
 * `(unknown: 1)` does, and `(unknown: 1) or (a)` holds where `(a)` does.
 *
 * Every test here bounds one side of one number — the width, the height,
 * the resolution, the aspect ratio — or names the scheme, so the opposite
 * of a test is a bound on the other side, and the opposite of a run a
 * choice of them: `not (max-width: 600px)` is a `min` just past 600px, and
 * `not (400px <= width <= 700px)` the two sides of it. So a condition stays
 * a run of tests however the query was written, which is what
 * `mediaMatches` answers at any width and the cascade reads its
 * breakpoints from. A query that ran `or` into one term held at every
 * width, and a `not` over a width was decided once, and held at none.
 */
export function parseMediaQuery(prelude: string): MediaCondition[] {
  const out: MediaCondition[] = [];
  for (const query of splitSelectors(prelude)) {
    const holds = queryHolds(query);
    if (!holds.length) out.push({ staticPass: false });
    else if (holds.some(isAlways)) out.push({ staticPass: true });
    else out.push(...holds);
  }
  return out.length ? out : [{ staticPass: true }];
}

/** A media query's condition, read: a feature's tests, a fact whatever the
 *  viewport — or null, a feature nothing knows — or parts. */
type MediaPart =
  | { test: MediaCondition }
  | { fact: boolean | null }
  | { not: MediaPart }
  | { and: MediaPart[] }
  | { or: MediaPart[] };

const UNKNOWN: MediaPart = { fact: null };

/** A run of no tests, which holds everywhere. */
function isAlways(c: MediaCondition): boolean {
  return Object.keys(c).length === 0;
}

/**
 * Where a part holds, or where it fails, as conditions any one of which is
 * enough. A part nothing knows does neither, and a `not` asks the part it
 * negates the other question; so only a query with a `not` in it ever asks
 * where a test fails.
 */
function where(part: MediaPart, holds: boolean): MediaCondition[] {
  if ('test' in part) return holds ? [part.test] : opposites(part.test);
  if ('fact' in part) return part.fact === holds ? [{}] : [];
  if ('not' in part) return where(part.not, !holds);
  // `and` holds where every part does and fails where any does; `or` the
  // other way round
  const all = 'and' in part;
  const lists = (all ? part.and : part.or).map((p) => where(p, holds));
  return all === holds ? everyOf(lists) : someOf(lists);
}

/** The words a media type may not be (Media Queries 4, 3). */
const NOT_A_TYPE = new Set(['not', 'and', 'or', 'only', 'layer']);

/** Where one query of a list holds: nowhere where it is none. */
function queryHolds(text: string): MediaCondition[] {
  const tokens = mediaTokens(text);
  const first = tokens[0];
  // a condition, unless it starts with a media type: a `not` before a word
  // is the query's, and before a parenthesis the condition's
  if (
    first?.kind !== 'word' ||
    (first.text === 'not' && tokens[1]?.kind !== 'word')
  ) {
    const cursor = { tokens, at: 0, depth: 0 };
    const part = mediaCondition(cursor, true);
    return part && cursor.at === tokens.length ? where(part, true) : [];
  }
  // `[ not | only ]? <media-type> [ and <media-condition-without-or> ]?`
  const negated = first.text === 'not';
  let at = negated || first.text === 'only' ? 1 : 0;
  const type = tokens[at];
  if (type?.kind !== 'word' || NOT_A_TYPE.has(type.text)) return [];
  at += 1;
  let condition: MediaPart | null = null;
  if (at < tokens.length) {
    const and = tokens[at];
    if (and.kind !== 'word' || and.text !== 'and') return [];
    const cursor = { tokens, at: at + 1, depth: 0 };
    condition = mediaCondition(cursor, false);
    if (!condition || cursor.at !== tokens.length) return [];
  }
  // any medium but the screen is not this one: `print`, `speech`, and the
  // ones CSS 2.1 named that Media Queries retired, `braille`, `embossed`,
  // `handheld`, `projection`, `tty`, `tv`, as is a name nobody has
  const part: MediaPart =
    type.text === 'screen' || type.text === 'all'
      ? (condition ?? { fact: true })
      : { fact: false };
  return where(part, !negated);
}

/**
 * The tokens of a media query its grammar turns on: words, blocks in
 * parentheses, functions, and anything else. White space only parts them,
 * so a word may follow a block with none between: DuckDuckGo writes
 * `(max-device-width: 701px)and (orientation: landscape)`. A word with a
 * `(` straight after it is a function, as CSS Syntax reads one, which
 * makes `(a) and(b)` and `(a)or(b)` no queries, as in every browser.
 */
type MediaToken =
  /** lowercased, its escapes read */
  | { kind: 'word'; text: string }
  /** what is inside the parentheses */
  | { kind: 'block'; text: string }
  | { kind: 'function' }
  | { kind: 'other' };

function mediaTokens(text: string): MediaToken[] {
  const out: MediaToken[] = [];
  let i = 0;
  while (i < text.length) {
    if (isSpace(text[i])) {
      i += 1;
    } else if (text[i] === '(') {
      const block = parenBlock(text, i);
      out.push({ kind: 'block', text: block.inner });
      i = block.end;
    } else if (startsIdent(text, i)) {
      const ident = readIdent(text, i);
      if (text[ident.end] === '(') {
        out.push({ kind: 'function' });
        i = parenBlock(text, ident.end).end;
      } else {
        out.push({ kind: 'word', text: ident.value.toLowerCase() });
        i = ident.end;
      }
    } else {
      out.push({ kind: 'other' });
      i = componentEnd(text, i);
    }
  }
  return out;
}

/** A block from its `(`: what is inside, and where it ends — the end of
 *  the text where nothing closes it, as CSS Syntax closes it there. */
function parenBlock(text: string, at: number): { inner: string; end: number } {
  let i = at + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x29) return { inner: text.slice(at + 1, i), end: i + 1 };
    i = opens(code) ? componentEnd(text, i) : i + 1;
  }
  return { inner: text.slice(at + 1), end: text.length };
}

/** Tokens being read, and how many parentheses deep. */
interface MediaCursor {
  tokens: MediaToken[];
  at: number;
  depth: number;
}

/** How deep conditions in parentheses are read; one further in is taken
 *  for a part nothing knows. */
const MAX_MEDIA_DEPTH = 16;

/**
 * `<media-condition>`, or `<media-condition-without-or>` where `or` is not
 * allowed — after a media type: a `not` and the part it negates, or parts
 * joined all by `and` or all by `or`. Null where the tokens are none; what
 * is left after one is the caller's to refuse.
 */
function mediaCondition(
  cursor: MediaCursor,
  allowOr: boolean,
): MediaPart | null {
  const first = cursor.tokens[cursor.at];
  if (first?.kind === 'word' && first.text === 'not') {
    cursor.at += 1;
    const part = mediaInParens(cursor);
    return part && { not: part };
  }
  const parts: MediaPart[] = [];
  let join = '';
  for (;;) {
    const part = mediaInParens(cursor);
    if (!part) return null;
    parts.push(part);
    const next = cursor.tokens[cursor.at];
    if (next?.kind !== 'word' || (next.text !== 'and' && next.text !== 'or')) {
      break;
    }
    // `and` and `or` at one level, unparenthesised, is no condition
    if (join ? next.text !== join : next.text === 'or' && !allowOr) {
      return null;
    }
    join = next.text;
    cursor.at += 1;
  }
  if (parts.length === 1) return parts[0];
  return join === 'or' ? { or: parts } : { and: parts };
}

/** `<media-in-parens>`: a condition in parentheses, or a feature, or
 *  anything else in them or in a function, which nothing knows. */
function mediaInParens(cursor: MediaCursor): MediaPart | null {
  const token = cursor.tokens[cursor.at];
  if (token?.kind === 'function') {
    cursor.at += 1;
    return UNKNOWN;
  }
  if (token?.kind !== 'block') return null;
  cursor.at += 1;
  // only a parenthesis or a `not` starts a condition; anything else in
  // parentheses is a feature, or nothing anybody knows either way
  if (cursor.depth < MAX_MEDIA_DEPTH && /^\s*(?:\(|not\s)/i.test(token.text)) {
    const inner = {
      tokens: mediaTokens(token.text),
      at: 0,
      depth: cursor.depth + 1,
    };
    const part = mediaCondition(inner, true);
    if (part && inner.at === inner.tokens.length) return part;
  }
  const test = featureTest(`(${token.text})`);
  return test === null || typeof test === 'boolean' ? { fact: test } : { test };
}

/** Lists of conditions any one of which is enough, as one such list. */
function someOf(lists: MediaCondition[][]): MediaCondition[] {
  const out = lists.flat();
  return out.some(isAlways) ? [{}] : out;
}

/** A query long enough to make more ways than this through its parts is no
 *  query anybody writes: it is taken to hold nowhere, rather than taking
 *  the time. */
const MAX_MEDIA_WAYS = 64;

/** Lists of conditions, one from each of which must hold, as one list of
 *  conditions any one of which is enough: every way of taking one from each,
 *  its bounds met. A way whose bounds cross holds nowhere, and is left out. */
function everyOf(lists: MediaCondition[][]): MediaCondition[] {
  let out = lists[0] ?? [{}];
  for (const list of lists.slice(1)) {
    const next: MediaCondition[] = [];
    for (const a of out) {
      for (const b of list) {
        const both = meet(a, b);
        if (both) next.push(both);
      }
    }
    if (next.length > MAX_MEDIA_WAYS) return [];
    out = next;
  }
  return out;
}

/** The bounds a condition keeps, lower and upper, and how far past one a
 *  bound beyond it is. */
type Bound =
  | 'min'
  | 'max'
  | 'minHeight'
  | 'maxHeight'
  | 'minResolution'
  | 'maxResolution'
  | 'minAspect'
  | 'maxAspect';
const BOUNDS: [Bound, Bound, number][] = [
  ['min', 'max', MAX_EDGE],
  ['minHeight', 'maxHeight', MAX_EDGE],
  ['minResolution', 'maxResolution', RATIO_EDGE],
  ['minAspect', 'maxAspect', RATIO_EDGE],
];

/** Two runs of tests as one, or null where nothing passes both. */
function meet(a: MediaCondition, b: MediaCondition): MediaCondition | null {
  const out: MediaCondition = { ...a };
  for (const [lo, hi] of BOUNDS) {
    const min = b[lo];
    const max = b[hi];
    if (min !== undefined) out[lo] = Math.max(out[lo] ?? -Infinity, min);
    if (max !== undefined) out[hi] = Math.min(out[hi] ?? Infinity, max);
    if ((out[lo] ?? -Infinity) > (out[hi] ?? Infinity)) return null;
  }
  if (b.scheme !== undefined) {
    if (out.scheme !== undefined && out.scheme !== b.scheme) return null;
    out.scheme = b.scheme;
  }
  return out;
}

/** Where a run of tests fails: past any one of its bounds, or under the
 *  other scheme. */
function opposites(test: MediaCondition): MediaCondition[] {
  const out: MediaCondition[] = [];
  for (const [lo, hi, edge] of BOUNDS) {
    const min = test[lo];
    const max = test[hi];
    if (min !== undefined) out.push(bounded(hi, min - edge));
    if (max !== undefined) out.push(bounded(lo, max + edge));
  }
  if (test.scheme) {
    out.push({ scheme: test.scheme === 'dark' ? 'light' : 'dark' });
  }
  return out;
}

function bounded(bound: Bound, value: number): MediaCondition {
  const out: MediaCondition = {};
  out[bound] = value;
  return out;
}

/** The size features: the viewport's width and height, bare, `min-` or
 *  `max-`, the device's as well. */
const SIZE_FEATURES = /^(min-|max-)?(?:device-)?(width|height)$/;

/**
 * A feature in parentheses, answered: the bounds it sets, true or false
 * where a desktop screen answers it whatever the viewport, or null where
 * it is no feature anybody knows or has a value its feature does not take.
 */
function featureTest(term: string): MediaCondition | boolean | null {
  // Media Queries 4's ranges, which Tailwind 4 writes its breakpoints in:
  // `(width >= 48rem)`, `(40rem <= width < 60rem)`
  const widths = widthRange(term);
  if (widths) return widths;
  const heights = widthRange(term, 'height');
  if (heights) {
    const out: MediaCondition = {};
    if (heights.min !== undefined) out.minHeight = heights.min;
    if (heights.max !== undefined) out.maxHeight = heights.max;
    return out;
  }
  const feature = mediaFeature(term);
  if (!feature) {
    // a feature in the boolean context, `(hover)`: true where its value is
    // anything but zero or none
    const flag = /^\(\s*(-?[a-z][a-z0-9-]*)\s*\)$/i.exec(term);
    if (!flag) return null;
    const key = flag[1].toLowerCase();
    if (BOOLEAN_TRUE.has(key)) return true;
    if (RESOLUTION_FEATURES.has(key)) {
      return key.includes('min-') || key.includes('max-') ? null : true;
    }
    return desktopFeature(key, null);
  }
  const key = feature[1].toLowerCase();
  const value = feature[2];
  const size = SIZE_FEATURES.exec(key);
  if (size) {
    // The viewport's height is answered live as its width is: a design that
    // sets its heading's size by the window's height took the tallest
    // step's at every height. `device-` is the viewport's too: the screen
    // an element is drawn on is the element's box. A size that is no
    // length is a value the feature does not take: `(min-width:0\0)`, the
    // hack that kept a block for Internet Explorer 9 and 10, held here as a
    // query that asked nothing, and its rules applied.
    const px = parseLength(value, ZERO_UNITS);
    if (typeof px !== 'number') return null;
    const [lo, hi]: [Bound, Bound] =
      size[2] === 'width' ? ['min', 'max'] : ['minHeight', 'maxHeight'];
    const out: MediaCondition = {};
    if (size[1] !== 'max-') out[lo] = px;
    if (size[1] !== 'min-') out[hi] = px;
    return out;
  }
  if (key === 'prefers-color-scheme') {
    // Answered live, from the palette in force: a document dropped into a
    // dark application takes its dark branch, and follows the desktop when
    // that changes. The two schemes are the whole vocabulary.
    const scheme = value.trim().toLowerCase();
    return scheme === 'light' || scheme === 'dark' ? { scheme } : null;
  }
  if (key === 'orientation') {
    // the viewport's, as its aspect ratio: portrait where its height is at
    // least its width (Media Queries 4, 4.5)
    const orientation = value.trim().toLowerCase();
    if (orientation === 'portrait') return { maxAspect: 1 };
    if (orientation === 'landscape') return { minAspect: 1 + RATIO_EDGE };
    return null;
  }
  if (ASPECT_FEATURES.test(key)) {
    const ratio = ratioOf(value);
    if (ratio === null) return null;
    const out: MediaCondition = {};
    if (!key.startsWith('max-')) out.minAspect = ratio;
    if (!key.startsWith('min-')) out.maxAspect = ratio;
    return out;
  }
  if (RESOLUTION_FEATURES.has(key)) {
    const dppx = resolutionOf(value, key.startsWith('-webkit-'));
    if (dppx === null) return null;
    const out: MediaCondition = {};
    if (!key.includes('max-')) out.minResolution = dppx;
    if (!key.includes('min-')) out.maxResolution = dppx;
    return out;
  }
  // any other feature as a desktop screen with a mouse answers it, and one
  // nothing knows is unknown (Media Queries 4, 3.2): Firefox's and Opera's
  // resolution features, which a design lists beside WebKit's, held here,
  // and a page at one dot to the pixel took the rules it keeps for two
  return desktopFeature(key, value);
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

/** `aspect-ratio` and the device's, bare or `min-`/`max-`. */
const ASPECT_FEATURES = /^(?:min-|max-)?(?:device-)?aspect-ratio$/;

/** A ratio, `16/9` or `16 / 9` or `1.5`, as a number; null for anything
 *  else, or a ratio of nothing. */
function ratioOf(value: string): number | null {
  const m = /^\s*(\d*\.?\d+)\s*(?:\/\s*(\d*\.?\d+)\s*)?$/.exec(value);
  if (!m) return null;
  const ratio = Number(m[1]) / (m[2] === undefined ? 1 : Number(m[2]));
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/** The resolution features, the standard's and WebKit's, which Chrome
 *  answers; `min--moz-device-pixel-ratio` and `-o-min-device-pixel-ratio`
 *  are no feature of its, and none of this. */
const RESOLUTION_FEATURES = new Set([
  'resolution',
  'min-resolution',
  'max-resolution',
  '-webkit-device-pixel-ratio',
  '-webkit-min-device-pixel-ratio',
  '-webkit-max-device-pixel-ratio',
]);

/** A resolution in dots per CSS pixel: `2dppx`, `2x`, `192dpi`, `75.6dpcm`,
 *  or WebKit's device pixel ratio, a number. Null for anything else. */
function resolutionOf(value: string, ratio: boolean): number | null {
  const m = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(dppx|x|dpi|dpcm)?\s*$/i.exec(
    value,
  );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (ratio) return unit ? null : n;
  if (unit === 'dppx' || unit === 'x') return n;
  if (unit === 'dpi') return n / 96;
  if (unit === 'dpcm') return (n * 2.54) / 96;
  return null;
}

/** The features true in the boolean context whatever the viewport: a
 *  size, a scheme, an orientation, there is always one. */
const BOOLEAN_TRUE = new Set([
  'width',
  'height',
  'device-width',
  'device-height',
  'aspect-ratio',
  'orientation',
  'prefers-color-scheme',
]);

/**
 * A media feature as a desktop screen driven by a mouse answers it — the
 * device `<Html>` draws on — for the features that do not depend on the
 * viewport: true or false, or null for a feature nothing knows, or a value
 * its feature does not take, which is unknown (Media Queries 4, 3.2): it
 * holds no more under `not` than without it, so each feature lists every
 * value it takes. `value` is null in the boolean context. The colour is
 * eight bits a component on no palette and no grid; scripts never run
 * here, so `scripting` is `none`.
 */
function desktopFeature(key: string, value: string | null): boolean | null {
  const v = value?.trim().toLowerCase() ?? null;
  const numeric = (feature: string, has: number): boolean | null => {
    const bare = key.replace(/^(min|max)-/, '');
    if (bare !== feature) return null;
    if (v === null) return key === feature ? has !== 0 : null;
    // an integer, and nothing else
    if (!/^[+-]?\d+$/.test(v)) return null;
    const n = Number(v);
    if (key.startsWith('min-')) return has >= n;
    if (key.startsWith('max-')) return has <= n;
    return has === n;
  };
  const keyword = (answers: Record<string, boolean>, bool: boolean) =>
    v === null ? bool : Object.hasOwn(answers, v) ? answers[v] : null;
  switch (key) {
    case 'hover':
    case 'any-hover':
      return keyword({ hover: true, none: false }, true);
    case 'pointer':
    case 'any-pointer':
      return keyword({ fine: true, coarse: false, none: false }, true);
    case 'update':
      return keyword({ fast: true, slow: false, none: false }, true);
    case 'overflow-block':
      return keyword({ scroll: true, none: false, paged: false }, true);
    case 'overflow-inline':
      return keyword({ scroll: true, none: false }, true);
    case 'scan':
      return keyword({ interlace: false, progressive: false }, false);
    case 'color-gamut':
      return keyword({ srgb: true, p3: false, rec2020: false }, true);
    case 'dynamic-range':
    case 'video-dynamic-range':
      return keyword({ standard: true, high: false }, true);
    case 'prefers-contrast':
      return keyword(
        { 'no-preference': true, more: false, less: false, custom: false },
        false,
      );
    // No preference, which is what a desktop browser answers where its user
    // has not asked for less motion: a page that keeps its animations under
    // `(prefers-reduced-motion: no-preference)` runs them here, as it does
    // in Chrome. The desktop's own setting, which core follows for its own
    // loops (`useSystemAppearance().reducedMotion`), is not read yet.
    // `animate={false}` does not answer `reduce`: it draws this page with
    // its animations at rest, as Chrome draws it with each at no length,
    // where `reduce` styles another page — one that shows under it what
    // `no-preference` hides.
    case 'prefers-reduced-motion':
    case 'prefers-reduced-transparency':
    case 'prefers-reduced-data':
      return keyword({ 'no-preference': true, reduce: false }, false);
    case 'forced-colors':
      return keyword({ none: true, active: false }, false);
    case 'scripting':
      return keyword(
        { none: true, 'initial-only': false, enabled: false },
        false,
      );
    case 'display-mode':
      return keyword(
        {
          browser: true,
          fullscreen: false,
          standalone: false,
          'minimal-ui': false,
          'picture-in-picture': false,
          'window-controls-overlay': false,
        },
        true,
      );
    case '-webkit-transform-3d':
      return keyword({ 1: true, 0: false }, true);
  }
  return (
    numeric('color', 8) ??
    numeric('monochrome', 0) ??
    numeric('color-index', 0) ??
    numeric('grid', 0)
  );
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
  const m = /^\(\s*(-?[a-z][a-z0-9-]*)\s*:([\s\S]*)\)$/i.exec(term);
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
  /** The display's scale, device pixels to the CSS pixel. */
  resolution = 1,
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
        (c.minResolution === undefined || resolution >= c.minResolution) &&
        (c.minAspect === undefined || width >= c.minAspect * height) &&
        (c.maxAspect === undefined || width <= c.maxAspect * height) &&
        (c.maxResolution === undefined || resolution <= c.maxResolution) &&
        (c.scheme === undefined || c.scheme === scheme)
      ) {
        any = true;
      }
    }
    if (!any) return false;
  }
  return true;
}
