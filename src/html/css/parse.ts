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

/**
 * Parse a stylesheet. `order` continues across sheets, so the caller passes
 * a running counter and the cascade's document-order tie-break holds across
 * the whole document rather than restarting per `<style>`.
 */
export function parseStylesheet(text: string, startOrder = 0): Stylesheet {
  const sheet: Stylesheet = { rules: [], imports: [], breakpoints: [] };
  let order = startOrder;
  const breakpoints = new Set<number>();

  const walk = (source: string, media: MediaCondition[][] | null): void => {
    let i = 0;
    const n = source.length;
    while (i < n) {
      i = skipTrivia(source, i);
      if (i >= n) break;

      if (source[i] === '@') {
        const at = readAtRule(source, i);
        i = at.end;
        const name = at.name.toLowerCase();
        if (name === 'import') {
          const url = importUrl(at.prelude);
          if (url) sheet.imports.push(url);
        } else if (name === 'media' && at.block !== null) {
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
        // @font-face, @keyframes, @page, @charset: nothing to do, and the
        // block was already consumed.
        continue;
      }

      const braceAt = findBrace(source, i);
      if (braceAt < 0) break;
      const prelude = source.slice(i, braceAt).trim();
      const block = readBlock(source, braceAt);
      i = block.end;
      if (!prelude) continue;
      const declarations = parseDeclarations(block.body);
      if (!declarations.length) continue;
      for (const selector of splitSelectors(prelude)) {
        if (!selector) continue;
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
 * Parse a declaration block — also the parser for a `style=""` attribute,
 * which is the same grammar with no braces around it.
 */
export function parseDeclarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    i = skipTrivia(text, i);
    if (i >= n) break;
    // A nested block inside a declaration list is something this does not
    // understand (a nested rule, an `@media` inside a rule); skip it whole
    // rather than reading its declarations as if they were the parent's.
    const colon = findChar(text, i, ':', ';{');
    if (colon < 0) {
      const semi = findChar(text, i, ';', '');
      if (semi < 0) break;
      i = semi + 1;
      continue;
    }
    const prop = text.slice(i, colon).trim().toLowerCase();
    const valueEnd = findChar(text, colon + 1, ';', '');
    const end = valueEnd < 0 ? n : valueEnd;
    let value = text.slice(colon + 1, end).trim();
    i = end + 1;
    if (!prop || !value) continue;
    const important = IMPORTANT_RE.test(value);
    if (important)
      value = value
        .replace(IMPORTANT_RE, '')
        .replace(/\s*!\s*$/, '')
        .trim();
    if (!value) continue;
    out.push({ prop, value, important });
  }
  return out;
}

/** Split `a, b > c, d` on top-level commas. */
export function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < prelude.length; i += 1) {
    const c = prelude[i];
    if (quote) {
      if (c === quote && prelude[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(prelude.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(prelude.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * Specificity, packed. Counted from the selector text rather than from a
 * parse: `#a` is an id, `.a`/`[a]`/`:a` is a class, a bare name is a type,
 * and a pseudo-*element* (`::before`) counts as a type. Functional
 * pseudo-classes are counted as one class each, which is right for
 * `:hover`/`:nth-child()` and approximate for `:is()`/`:not()` — whose
 * specificity is their argument's. The approximation costs an author who
 * writes `:is(#id)` and expects it to beat a class; nothing else.
 */
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
      i = skipIdent(selector, i + 1);
    } else if (c === '.') {
      classes += 1;
      i = skipIdent(selector, i + 1);
    } else if (c === '[') {
      classes += 1;
      i = skipBalanced(selector, i, '[', ']');
    } else if (c === ':') {
      if (selector[i + 1] === ':') {
        types += 1;
        i = skipIdent(selector, i + 2);
      } else {
        classes += 1;
        i = skipIdent(selector, i + 1);
        if (selector[i] === '(') i = skipBalanced(selector, i, '(', ')');
      }
    } else if (isIdentStart(c)) {
      types += 1;
      i = skipIdent(selector, i);
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

function isIdentStart(c: string): boolean {
  return /[a-zA-Z_\-*|\\]/.test(c);
}

function skipIdent(text: string, from: number): number {
  let i = from;
  while (i < text.length && /[a-zA-Z0-9_\-\\]/.test(text[i])) i += 1;
  return i;
}

function skipBalanced(
  text: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** The next `{` that is not inside a string, comment or bracket. */
function findBrace(text: string, from: number): number {
  let quote = '';
  let bracket = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 1;
    } else if (c === '(' || c === '[') bracket += 1;
    else if (c === ')' || c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === '{' && bracket === 0) return i;
    else if (c === ';' && bracket === 0) return -1; // a stray declaration
  }
  return -1;
}

/** Find `target` at depth zero, stopping at any of `stopAt`. */
function findChar(
  text: string,
  from: number,
  target: string,
  stopAt: string,
): number {
  let quote = '';
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 1;
    } else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0 && stopAt.includes(c)) return -1;
      depth -= 1;
    } else if (depth === 0) {
      if (c === target) return i;
      if (stopAt.includes(c)) return -1;
    }
  }
  return -1;
}

function readBlock(
  text: string,
  braceAt: number,
): { body: string; end: number } {
  const end = skipBalanced(text, braceAt, '{', '}');
  return { body: text.slice(braceAt + 1, Math.max(braceAt + 1, end - 1)), end };
}

interface AtRule {
  name: string;
  prelude: string;
  block: string | null;
  end: number;
}

function readAtRule(text: string, at: number): AtRule {
  const nameEnd = skipIdent(text, at + 1);
  const name = text.slice(at + 1, nameEnd);
  let i = nameEnd;
  let quote = '';
  let depth = 0;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || c === '{')) break;
  }
  const prelude = text.slice(nameEnd, i).trim();
  if (text[i] === '{') {
    const block = readBlock(text, i);
    return { name, prelude, block: block.body, end: block.end };
  }
  return { name, prelude, block: null, end: Math.min(text.length, i + 1) };
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
