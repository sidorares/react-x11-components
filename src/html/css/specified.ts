// A declaration's value as `el.style` keeps it (CSSOM 6.7, "set a CSS
// declaration"): parsed against the property's grammar, and kept in its
// canonical form, or not kept at all where it is no value of the property.
// Only the properties this engine reads a grammar for answer; any other is
// kept as it was written, as it always was here, so a value a page sets and
// reads back is never lost to a grammar this has not got.

import { positionAreaText } from './anchor.js';
import { serializeMath } from './calc-tree.js';
import { animationItemText, animationLonghandsOf } from './animation.js';
import { parseShapeFunction } from './shape-function.js';
import { specifiedColorText } from './color.js';
import { parseZoom, splitValue } from './values.js';
import { closingParen } from './vars.js';
import type { UnitContext } from './values.js';

/** What a value is read against where it is only checked: its lengths
 *  are any lengths. */
const CHECK: UnitContext = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };

/** What every property takes. */
const CSS_WIDE = /^(inherit|initial|unset|revert|revert-layer)$/;

const GEOMETRY_BOXES =
  /^(margin-box|border-box|padding-box|content-box|fill-box|stroke-box|view-box)$/i;

/**
 * `prop`'s value `value` as a declaration keeps it: its canonical text, or
 * null for a value the property does not take — which leaves the
 * declaration as it was — and undefined where this has no grammar for it.
 */
export function specifiedValue(
  prop: string,
  value: string,
): string | null | undefined {
  // a value that is only known once it is substituted, or a keyword
  // every property takes, is kept as written
  if (/\b(?:var|env|attr)\(/i.test(value)) return undefined;
  const name = prop.toLowerCase();
  // one keyword (CSS UI 4, 6.1)
  if (name === 'user-select' || name === '-webkit-user-select') {
    const word = value.trim().toLowerCase();
    if (CSS_WIDE.test(word)) return undefined;
    return /^(auto|text|none|contain|all)$/.test(word) ? word : null;
  }
  // a transition's name and its classes (CSS View Transitions 1, 3.1 and
  // 2, 3.2)
  if (name === 'view-transition-name' || name === 'view-transition-class') {
    const word = value.trim();
    if (CSS_WIDE.test(word.toLowerCase())) return undefined;
    const out =
      name === 'view-transition-name'
        ? viewTransitionName(word)
        : viewTransitionClass(word);
    return out;
  }
  // what anchor positioning names and takes (CSS Anchor Positioning 1)
  const anchor = ANCHOR_GRAMMARS[name];
  if (anchor) {
    const word = value.trim();
    if (CSS_WIDE.test(word.toLowerCase())) return undefined;
    return anchor(word);
  }
  // `anchor()` and `anchor-size()`, where each may be, their arguments
  // in canonical order
  if (/(?<![\w-])anchor(?:-size)?\(/i.test(value)) {
    return rewriteAnchors(value.trim(), name);
  }
  // what scroll-driven animations name and take (Scroll Animations 1)
  const timeline = TIMELINE_GRAMMARS[name];
  if (timeline) {
    const word = value.trim();
    if (CSS_WIDE.test(word.toLowerCase())) return undefined;
    return timeline(word);
  }
  // the `animation` shorthand, which takes no timeline and no range (CSS
  // Animations 2, 4)
  if (name === 'animation') {
    const word = value.trim();
    if (CSS_WIDE.test(word.toLowerCase())) return undefined;
    return animationLonghandsOf(word) ? word : null;
  }
  // a number or a percentage, neither below nought, or `normal` (CSS
  // Viewport 1, 5)
  if (name === 'zoom') {
    const word = value.trim().toLowerCase();
    if (CSS_WIDE.test(word)) return undefined;
    return parseZoom(word) === null ? null : word;
  }
  // `contrast-color()` takes one colour and nothing else (CSS Color 5,
  // 6.1): a value holding one of anything else is none, in any property
  if (/contrast-color\(/i.test(value)) {
    if (!contrastColorsValid(value)) return null;
    // and its colour is kept as the colour would be, its calculations
    // simplified
    const canonical = contrastColorsText(value);
    if (canonical !== value) return canonical;
  }
  if (name === 'clip-path' || name === '-webkit-clip-path') {
    if (!/\bshape\(/i.test(value)) return undefined;
    // a shape, and a box beside it or none, in either order
    const parts = splitValue(value.trim());
    let shape: string | null = null;
    let box: string | null = null;
    for (const part of parts) {
      if (GEOMETRY_BOXES.test(part)) {
        if (box) return null;
        box = part.toLowerCase();
      } else {
        if (shape) return null;
        shape = parseShapeFunction(part, CHECK)?.text ?? null;
        if (!shape) return null;
      }
    }
    if (!shape) return null;
    return box ? `${shape} ${box}` : shape;
  }
  return undefined;
}

/** Whether every `contrast-color()` in a value holds one component that
 *  could be a colour: not none, not two, not a number, and not the `max`
 *  and `min` an earlier draft of it took. Whether it is a colour is the
 *  cascade's to say, which knows the system colours and the scheme. */
function contrastColorsValid(value: string): boolean {
  const re = /contrast-color\(/gi;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const open = m.index + m[0].length;
    let depth = 1;
    let end = open;
    for (; end < value.length && depth > 0; end += 1) {
      if (value[end] === '(') depth += 1;
      else if (value[end] === ')') depth -= 1;
    }
    const inner = value.slice(open, depth === 0 ? end - 1 : end).trim();
    const parts = splitValue(inner);
    if (parts.length !== 1) return false;
    if (/^[+-]?[\d.]/.test(inner) || /^(?:max|min)$/i.test(inner)) return false;
  }
  return true;
}

/** A value with the colour function each `contrast-color()` holds as a
 *  declaration keeps it (`specifiedColorText`): `contrast-color(color(srgb
 *  calc(0.5) 0 0 / .5))` as `contrast-color(color(srgb calc(0.5) 0 0 /
 *  0.5))`. Any other colour in one, and the rest of the value, as written. */
function contrastColorsText(value: string): string {
  let out = '';
  let from = 0;
  const re = /contrast-color\(/gi;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const open = m.index + m[0].length;
    const close = closingParen(value, open);
    if (close < 0) break;
    const inner = value.slice(open, close).trim();
    const canonical = specifiedColorText(inner);
    if (canonical !== null && canonical !== inner) {
      out += `${value.slice(from, open)}${canonical})`;
      from = close + 1;
      re.lastIndex = close + 1;
    }
  }
  return from === 0 ? value : out + value.slice(from);
}

/** A `<custom-ident>` (CSS Values 4, 4.2): an identifier that is none of
 *  the CSS-wide keywords nor `default`. */
const CUSTOM_IDENT =
  /^(?:--|-?(?:[_a-zA-Z\u0080-\uffff]|\\.))(?:[\w\u0080-\uffff-]|\\.)*$/;
function customIdent(word: string): boolean {
  return (
    CUSTOM_IDENT.test(word) &&
    !/^(?:inherit|initial|unset|revert|revert-layer|default)$/i.test(word)
  );
}

/** `view-transition-name`: `none`, `match-element`, `auto`, or a name,
 *  canonical: a keyword lowercased, a name as written. Null for no value
 *  of it. */
export function viewTransitionName(value: string): string | null {
  const word = value.trim();
  if (/^(?:none|match-element|auto)$/i.test(word)) return word.toLowerCase();
  return customIdent(word) ? word : null;
}

/** `view-transition-class`: `none`, or names, none of them `none`. */
export function viewTransitionClass(value: string): string | null {
  const words = value.trim().split(/\s+/);
  if (words.length === 1 && /^none$/i.test(words[0])) return 'none';
  for (const word of words) {
    if (!customIdent(word) || /^none$/i.test(word)) return null;
  }
  return words.join(' ');
}

/** A view transition's pseudo-element in a selector (CSS View
 *  Transitions 1, 3.2): the tree's root, or one of the four that take a
 *  name. */
const TRANSITION_PSEUDO =
  /::view-transition(?:-(group|image-pair|old|new))?(?![\w-])/gi;
const SELECTOR_IDENT =
  /^(?:--|-?(?:[_a-zA-Z\u0080-￿]|\\[^\n]))(?:[\w\u0080-￿-]|\\[^\n])*$/;

/**
 * Whether a selector list's view transition pseudo-elements are written as
 * selectors take them: last in their complex selector, outside any
 * function, the root one with nothing after it, and each of the others
 * with its argument — `*` or a name, and classes after it, `.a.b` — and
 * at most `:only-child` after it. Null where it has none, which leaves
 * the selector to whatever else reads it. No element is one of them: a
 * valid one matches nothing (`querySelector`), and an invalid one is a
 * syntax error.
 */
export function transitionSelectorValid(selector: string): boolean | null {
  if (!/::view-transition/i.test(selector)) return null;
  for (const complex of splitTopLevel(selector)) {
    TRANSITION_PSEUDO.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TRANSITION_PSEUDO.exec(complex))) {
      if (depthAt(complex, m.index) !== 0) return false;
      let rest = complex.slice(m.index + m[0].length);
      if (m[1]) {
        if (!rest.startsWith('(')) return false;
        const close = rest.indexOf(')');
        if (close < 0 || !transitionArgument(rest.slice(1, close))) {
          return false;
        }
        rest = rest.slice(close + 1).trim();
        if (rest && !/^:only-child$/i.test(rest)) return false;
      } else if (rest.trim()) return false;
    }
  }
  return true;
}

/** A named transition pseudo-element's argument: `*` or a name, and a
 *  class after a `.` for each, with no space anywhere in it. */
function transitionArgument(text: string): boolean {
  const arg = text.trim();
  if (!arg || /\s/.test(arg)) return false;
  const parts = arg.split(/(?<!\\)\./);
  const [first, ...classes] = parts;
  if (first !== '*' && !customIdentOrEscape(first)) return false;
  return classes.every((c) => SELECTOR_IDENT.test(c));
}

function customIdentOrEscape(word: string): boolean {
  return (
    SELECTOR_IDENT.test(word) &&
    !/^(?:inherit|initial|unset|revert|revert-layer|default)$/i.test(word)
  );
}

/** A selector list's selectors, split at its commas outside brackets. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') i += 1;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out;
}

/** A custom highlight's pseudo-element in a selector (CSS Highlight API
 *  1, 4.1). */
const HIGHLIGHT_PSEUDO = /::highlight(?![\w-])/gi;
/** A CSS identifier, its escapes in it: a hex escape and the one white
 *  space that may end it, or any other character escaped. */
const IDENT_ESCAPED =
  /^(?:--|-?(?:[_a-zA-Z\u0080-\uffff]|\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^\n\r\f0-9a-fA-F]))(?:[-_a-zA-Z0-9\u0080-\uffff]|\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^\n\r\f0-9a-fA-F])*$/;
/** A legacy pseudo-element a selector may spell with one colon. */
const LEGACY_PSEUDO =
  /(?<!:):(?:before|after|first-line|first-letter)(?![\w-])/i;

/**
 * The `::highlight()`s of one complex selector, each with where its
 * argument is: or null where one is not written as a selector takes it —
 * outside any function, after no pseudo-element but a `::part()`, with an
 * identifier for its argument, and nothing after it (CSS Highlight API 1,
 * 4.1; Selectors 4, 3.6.1). An empty list where it has none.
 */
function highlightsIn(
  complex: string,
): { from: number; to: number; name: string }[] | null {
  const out: { from: number; to: number; name: string }[] = [];
  HIGHLIGHT_PSEUDO.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HIGHLIGHT_PSEUDO.exec(complex))) {
    if (depthAt(complex, m.index) !== 0) return null;
    // what comes before it in the selector: no other pseudo-element
    const before = complex.slice(0, m.index).replace(/::part\([^()]*\)/gi, '');
    if (/::/.test(before) || LEGACY_PSEUDO.test(before)) return null;
    const open = m.index + m[0].length;
    if (complex[open] !== '(') return null;
    let close = open + 1;
    while (close < complex.length && complex[close] !== ')') {
      close += complex[close] === '\\' ? 2 : 1;
    }
    if (close >= complex.length) return null;
    const arg = complex.slice(open + 1, close).trim();
    if (!IDENT_ESCAPED.test(arg)) return null;
    if (complex.slice(close + 1).trim()) return null;
    out.push({ from: open + 1, to: close, name: unescapeIdent(arg) });
  }
  return out;
}

/**
 * Whether a selector list's `::highlight()`s are written as selectors take
 * them (`highlightsIn`); null where it has none, which leaves the selector
 * to whatever else reads it. No element is a highlight: a query a valid
 * one is in matches nothing by it (`withoutHighlights`), and an invalid one
 * is a syntax error.
 */
export function highlightSelectorValid(selector: string): boolean | null {
  if (!/::highlight/i.test(selector)) return null;
  for (const complex of splitTopLevel(selector)) {
    if (!highlightsIn(complex)) return false;
  }
  return true;
}

/** A selector list's complex selectors that name no highlight, which are
 *  what a query of it can match. */
export function withoutHighlights(selector: string): string[] {
  return splitTopLevel(selector)
    .map((complex) => complex.trim())
    .filter((complex) => complex && !highlightsIn(complex)?.length);
}

/** A valid selector list with each `::highlight()`'s name written as CSSOM
 *  serializes an identifier (`CSS.escape`): `::highlight(\31\32\33)` is
 *  `::highlight(\31 23)`, as `selectorText` reads it. */
export function canonicalHighlights(selector: string): string {
  return splitTopLevel(selector)
    .map((complex) => {
      const found = highlightsIn(complex) ?? [];
      let out = complex;
      for (let i = found.length - 1; i >= 0; i -= 1) {
        const { from, to, name } = found[i];
        out = out.slice(0, from) + serializeIdent(name) + out.slice(to);
      }
      return out.trim();
    })
    .join(', ');
}

/** An identifier's escapes made the characters they stand for (CSS
 *  Syntax 3, 4.3.7). */
export function unescapeIdent(ident: string): string {
  return ident.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/g,
    (_m, hex: string | undefined, ch: string | undefined) => {
      if (hex === undefined) return ch!;
      const code = parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? '�'
        : String.fromCodePoint(code);
    },
  );
}

/** An identifier as CSSOM serializes one (CSSOM 2.1, "serialize an
 *  identifier"), which `CSS.escape` is. */
export function serializeIdent(value: string): string {
  let out = '';
  const first = value.charCodeAt(0);
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c === 0) out += '�';
    else if (
      (c >= 1 && c <= 0x1f) ||
      c === 0x7f ||
      (i === 0 && c >= 0x30 && c <= 0x39) ||
      (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2d)
    ) {
      out += `\\${c.toString(16)} `;
    } else if (i === 0 && c === 0x2d && value.length === 1) {
      out += `\\${value[i]}`;
    } else if (
      c >= 0x80 ||
      c === 0x2d ||
      c === 0x5f ||
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a)
    ) {
      out += value[i];
    } else {
      out += `\\${value[i]}`;
    }
  }
  return out;
}

/** How many brackets are open at `at`. */
function depthAt(text: string, at: number): number {
  let depth = 0;
  for (let i = 0; i < at; i += 1) {
    const c = text[i];
    if (c === '\\') i += 1;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
  }
  return depth;
}

// --- scroll-driven animations (Scroll Animations 1) -------------------------

/** A `<dashed-ident>`, kept as written. */
const DASHED_IDENT = /^--(?:[\w\u0080-\uffff-]|\\.)+$/;
const SCROLL_AXIS = /^(?:block|inline|x|y)$/i;

/** A comma-separated list, each item read by `item`; null where one is
 *  empty or no value of it. */
function listOf(
  value: string,
  item: (part: string) => string | null,
): string | null {
  const out: string[] = [];
  for (const part of splitTopLevel(value)) {
    const text = part.trim();
    if (!text) return null;
    const read = item(text);
    if (read === null) return null;
    out.push(read);
  }
  return out.join(', ');
}

/** A timeline's name: `none` or a `<dashed-ident>`. */
function timelineName(word: string): string | null {
  if (/^none$/i.test(word)) return 'none';
  return DASHED_IDENT.test(word) ? word : null;
}

/** A `<length-percentage>` as far as a check of it goes. */
function lengthPercentage(word: string): boolean {
  if (/^(?:calc|min|max|clamp)\(/i.test(word)) return /\)$/.test(word);
  const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(%|[a-z]+)?$/i.exec(word);
  if (!m) return false;
  if (!m[1]) return /^[+-]?0*\.?0*$/.test(word);
  return m[1] === '%' || LENGTH_UNIT.test(m[1]);
}
const LENGTH_UNIT =
  /^(?:px|cm|mm|q|in|pt|pc|r?em|r?ex|r?ch|r?ic|r?lh|r?cap|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/i;

/** One or two of `auto` or a `<length-percentage>`, the second left out
 *  where it is the first (Scroll Animations 1, 3.4.3): a list of none, or
 *  the words. */
function insetWords(words: string[]): string[] | null {
  if (words.length < 1 || words.length > 2) return null;
  const read = words.map((w) =>
    /^auto$/i.test(w) ? 'auto' : lengthPercentage(w) ? w : null,
  );
  if (read.some((w) => w === null)) return null;
  if (read.length === 2 && read[0] === read[1]) read.pop();
  return read as string[];
}

/** `scroll(<scroller>? <axis>?)`, defaults left out: `nearest`, `block`. */
function scrollFunction(args: string): string | null {
  const words = splitValue(args.trim()).filter(Boolean);
  let scroller: string | null = null;
  let axis: string | null = null;
  for (const w of words) {
    const lower = w.toLowerCase();
    if (/^(?:root|nearest|self)$/.test(lower) && scroller === null) {
      scroller = lower;
    } else if (SCROLL_AXIS.test(lower) && axis === null) axis = lower;
    else return null;
  }
  const parts: string[] = [];
  if (scroller && scroller !== 'nearest') parts.push(scroller);
  if (axis && axis !== 'block') parts.push(axis);
  return `scroll(${parts.join(' ')})`;
}

/** `view(<axis>? <inset>?)`, either order, defaults left out. */
function viewFunction(args: string): string | null {
  const words = splitValue(args.trim()).filter(Boolean);
  let axis: string | null = null;
  if (words.length && SCROLL_AXIS.test(words[0])) {
    axis = words.shift()!.toLowerCase();
  } else if (words.length && SCROLL_AXIS.test(words[words.length - 1])) {
    axis = words.pop()!.toLowerCase();
  }
  let inset: string[] = [];
  if (words.length) {
    const read = insetWords(words);
    if (!read) return null;
    inset = read.length === 1 && read[0] === 'auto' ? [] : read;
  }
  const parts: string[] = [];
  if (axis && axis !== 'block') parts.push(axis);
  parts.push(...inset);
  return `view(${parts.join(' ')})`;
}

/** `scroll-timeline`'s or `view-timeline`'s item: a name, then an axis
 *  and, for a view timeline, an inset, in either order — each left out
 *  where it is its initial value. */
function timelineItem(text: string, view: boolean): string | null {
  const words = splitValue(text).filter(Boolean);
  const name = words.length ? timelineName(words.shift()!) : null;
  if (name === null) return null;
  let axis: string | null = null;
  if (words.length && SCROLL_AXIS.test(words[0])) {
    axis = words.shift()!.toLowerCase();
  } else if (words.length && SCROLL_AXIS.test(words[words.length - 1])) {
    axis = words.pop()!.toLowerCase();
  }
  let inset: string[] = [];
  if (words.length) {
    if (!view) return null;
    const read = insetWords(words);
    if (!read) return null;
    inset = read.length === 1 && read[0] === 'auto' ? [] : read;
  }
  return [name, axis && axis !== 'block' ? axis : '', ...inset]
    .filter(Boolean)
    .join(' ');
}

const TIMELINE_GRAMMARS: Record<string, (value: string) => string | null> = {
  'animation-timeline': (value) =>
    listOf(value, (item) => {
      const lower = item.toLowerCase();
      if (lower === 'auto' || lower === 'none') return lower;
      if (DASHED_IDENT.test(item)) return item;
      const fn = /^(scroll|view)\(([\s\S]*)\)$/i.exec(item);
      if (!fn) return null;
      return fn[1].toLowerCase() === 'scroll'
        ? scrollFunction(fn[2])
        : viewFunction(fn[2]);
    }),
  'scroll-timeline-name': (value) => listOf(value, timelineName),
  'view-timeline-name': (value) => listOf(value, timelineName),
  'scroll-timeline-axis': (value) =>
    listOf(value, (item) =>
      SCROLL_AXIS.test(item) ? item.toLowerCase() : null,
    ),
  'view-timeline-axis': (value) =>
    listOf(value, (item) =>
      SCROLL_AXIS.test(item) ? item.toLowerCase() : null,
    ),
  'view-timeline-inset': (value) =>
    listOf(
      value,
      (item) => insetWords(splitValue(item).filter(Boolean))?.join(' ') ?? null,
    ),
  'timeline-scope': (value) => {
    const lower = value.toLowerCase();
    if (lower === 'none' || lower === 'all') return lower;
    return listOf(value, (item) => (DASHED_IDENT.test(item) ? item : null));
  },
  'scroll-timeline': (value) =>
    listOf(value, (item) => timelineItem(item, false)),
  'view-timeline': (value) => listOf(value, (item) => timelineItem(item, true)),
};

/** What `el.style` keeps for a shorthand it expands (CSSOM 6.7, "set a
 *  CSS declaration" of a shorthand): each longhand and its value, from
 *  the shorthand's canonical value; null for one this does not expand. */
export function expandShorthand(
  prop: string,
  value: string,
): [string, string][] | null {
  const name = prop.toLowerCase();
  if (name === 'animation') return animationLonghandsOf(value);
  if (name === 'position-try') {
    const order =
      /^(most-width|most-height|most-block-size|most-inline-size)\s+/.exec(
        value,
      );
    return [
      ['position-try-order', order ? order[1] : 'normal'],
      ['position-try-fallbacks', order ? value.slice(order[0].length) : value],
    ];
  }
  if (name !== 'scroll-timeline' && name !== 'view-timeline') return null;
  const view = name === 'view-timeline';
  const names: string[] = [];
  const axes: string[] = [];
  const insets: string[] = [];
  for (const part of splitTopLevel(value)) {
    const words = splitValue(part.trim()).filter(Boolean);
    names.push(words.shift() ?? 'none');
    let axis = 'block';
    if (words.length && SCROLL_AXIS.test(words[0])) {
      axis = words.shift()!.toLowerCase();
    }
    axes.push(axis);
    insets.push(words.length ? words.join(' ') : 'auto');
  }
  const out: [string, string][] = [
    [`${name}-name`, names.join(', ')],
    [`${name}-axis`, axes.join(', ')],
  ];
  if (view) out.push([`${name}-inset`, insets.join(', ')]);
  return out;
}

/** The longhands an `animation` is read back from, in the order its
 *  items are written. */
const ANIMATION_PARTS = [
  'animation-duration',
  'animation-timing-function',
  'animation-delay',
  'animation-iteration-count',
  'animation-direction',
  'animation-fill-mode',
  'animation-play-state',
  'animation-name',
];

/** A shorthand `el.style` expanded, read back from its longhands, or ''
 *  where they do not make one (CSSOM 6.7, "serialize a CSS value" of a
 *  shorthand): their lists the same length. */
export function composeShorthand(
  prop: string,
  longhand: (name: string) => string | null,
): string | null {
  const name = prop.toLowerCase();
  if (name === 'position-try') {
    const order = longhand('position-try-order');
    const fallbacks = longhand('position-try-fallbacks');
    if (order === null || fallbacks === null) return '';
    return order === 'normal' ? fallbacks : `${order} ${fallbacks}`;
  }
  if (name === 'animation') {
    if (
      longhand('animation-timeline') !== 'auto' ||
      longhand('animation-range-start') !== 'normal' ||
      longhand('animation-range-end') !== 'normal'
    ) {
      return '';
    }
    const lists: string[][] = [];
    for (const part of ANIMATION_PARTS) {
      const v = longhand(part);
      if (v === null) return '';
      lists.push(splitTopLevel(v).map((x) => x.trim()));
    }
    const count = lists[0].length;
    if (lists.some((l) => l.length !== count)) return '';
    return lists[0]
      .map((_, i) => animationItemText(lists.map((l) => l[i])))
      .join(', ');
  }
  if (name !== 'scroll-timeline' && name !== 'view-timeline') return null;
  const view = name === 'view-timeline';
  const names = longhand(`${name}-name`);
  const axes = longhand(`${name}-axis`);
  const insets = view ? longhand(`${name}-inset`) : 'auto';
  if (names === null || axes === null || insets === null) return '';
  const a = splitTopLevel(names).map((v) => v.trim());
  const b = splitTopLevel(axes).map((v) => v.trim());
  const c = splitTopLevel(insets).map((v) => v.trim());
  if (b.length !== a.length || (view && c.length !== a.length)) return '';
  return a
    .map((n, i) => {
      const inset = view ? c[i] : 'auto';
      return [n, b[i] === 'block' ? '' : b[i], inset === 'auto' ? '' : inset]
        .filter(Boolean)
        .join(' ');
    })
    .join(', ');
}

// --- anchor positioning (CSS Anchor Positioning 1) ---------------------------

const INSET_PROPERTY =
  /^(?:top|left|right|bottom|inset|inset-(?:block|inline)(?:-start|-end)?)$/;
const SIZE_PROPERTY = /^(?:min-|max-)?(?:width|height|inline-size|block-size)$/;
const MARGIN_PROPERTY =
  /^margin(?:-(?:top|left|right|bottom|block|inline)(?:-start|-end)?)?$/;
const ANCHOR_SIDE =
  /^(?:inside|outside|top|left|right|bottom|start|end|self-start|self-end|center)$/i;
const ANCHOR_SIZE = /^(?:width|height|block|inline|self-block|self-inline)$/i;
const MATH = /^(?:calc|min|max|clamp)\(/i;

/**
 * A value with `anchor()` or `anchor-size()` in it, each call's name put
 * before its side or size (CSS Anchor Positioning 1, 4.1 and 5.1) and a
 * zero fallback given its unit; null where one is no call of its grammar,
 * or where the property takes none — `anchor()` an inset alone, and
 * `anchor-size()` an inset, a size or a margin.
 */
function rewriteAnchors(value: string, prop: string): string | null {
  const re = /(?<![\w-])(anchor-size|anchor)\(/gi;
  let out = '';
  let from = 0;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    if (m.index < from) continue;
    const open = m.index + m[0].length;
    let depth = 1;
    let end = open;
    for (; end < value.length && depth > 0; end += 1) {
      if (value[end] === '(') depth += 1;
      else if (value[end] === ')') depth -= 1;
    }
    if (depth !== 0) return null;
    const call = anchorCall(
      m[1].toLowerCase(),
      value.slice(open, end - 1),
      prop,
    );
    if (call === null) return null;
    out += value.slice(from, m.index) + call;
    from = end;
    re.lastIndex = end;
  }
  // and a math function around them simplified, as one serializes
  const whole = out + value.slice(from);
  return MATH.test(whole) ? (serializeMath(whole) ?? whole) : whole;
}

function anchorCall(fn: string, inner: string, prop: string): string | null {
  const size = fn === 'anchor-size';
  if (
    size
      ? !INSET_PROPERTY.test(prop) &&
        !SIZE_PROPERTY.test(prop) &&
        !MARGIN_PROPERTY.test(prop)
      : !INSET_PROPERTY.test(prop)
  ) {
    return null;
  }
  const parts = splitTopLevel(inner);
  if (parts.length > 2) return null;
  const head = parts[0].trim();
  const given = parts.length === 2 ? parts[1].trim() : null;
  if (given === '' || (given !== null && !head)) return null;
  // `anchor-size()` with a fallback alone writes no comma
  if (
    size &&
    given === null &&
    head &&
    splitValue(head).filter(Boolean).length === 1 &&
    (lengthPercentage(head) || MATH.test(head))
  ) {
    return `${fn}(${/^[+-]?0*\.?0*$/.test(head) ? '0px' : head})`;
  }
  let name: string | null = null;
  let word: string | null = null;
  for (const w of head ? splitValue(head).filter(Boolean) : []) {
    if (w.startsWith('--')) {
      if (name !== null || !DASHED_IDENT.test(w)) return null;
      name = w;
    } else if (
      word === null &&
      (size
        ? ANCHOR_SIZE.test(w)
        : ANCHOR_SIDE.test(w) || /^[+-]?[\d.]+%$/.test(w) || MATH.test(w))
    ) {
      word = MATH.test(w)
        ? (serializeMath(w) ?? w)
        : /%$/.test(w)
          ? w
          : w.toLowerCase();
    } else return null;
  }
  if (!size && word === null) return null;
  let fallback = '';
  if (given !== null) {
    const read = rewriteAnchors(given, prop);
    if (read === null || splitValue(read).length !== 1) return null;
    if (
      !lengthPercentage(read) &&
      !MATH.test(read) &&
      !/^anchor(?:-size)?\(/i.test(read)
    ) {
      return null;
    }
    fallback = `, ${/^[+-]?0*\.?0*$/.test(read) ? '0px' : read}`;
  }
  return `${fn}(${[name, word].filter(Boolean).join(' ')}${fallback})`;
}

const TRY_ORDER =
  /^(?:normal|most-width|most-height|most-block-size|most-inline-size)$/i;
const TRY_TACTIC = /^(?:flip-block|flip-inline|flip-start|flip-x|flip-y)$/i;

/** One `position-try-fallbacks` option: a `position-area`, or a name and
 *  tactics, the name first, none of them twice. */
function tryOption(item: string): string | null {
  const words = splitValue(item).filter(Boolean);
  if (!words.length) return null;
  const kinds = words
    .map((w) => (w.startsWith('--') ? 'n' : TRY_TACTIC.test(w) ? 't' : 'x'))
    .join('');
  if (!/[nt]/.test(kinds)) {
    const text = positionAreaText(item);
    return text === 'none' ? null : text;
  }
  // a name, and tactics run together before it or after it
  if (!/^(?:n?t*|t+n)$/.test(kinds)) return null;
  const name = words.find((w) => w.startsWith('--')) ?? null;
  if (name !== null && !DASHED_IDENT.test(name)) return null;
  const tactics = words
    .filter((w) => TRY_TACTIC.test(w))
    .map((w) => w.toLowerCase());
  if (new Set(tactics).size !== tactics.length) return null;
  return [name, ...tactics].filter(Boolean).join(' ');
}

function tryFallbacks(value: string): string | null {
  if (/^none$/i.test(value)) return 'none';
  return listOf(value, tryOption);
}

const ANCHOR_GRAMMARS: Record<string, (value: string) => string | null> = {
  'anchor-name': (value) =>
    /^none$/i.test(value)
      ? 'none'
      : listOf(value, (item) => (DASHED_IDENT.test(item) ? item : null)),
  'anchor-scope': (value) => {
    if (/^(?:none|all)$/i.test(value)) return value.toLowerCase();
    return listOf(value, (item) => (DASHED_IDENT.test(item) ? item : null));
  },
  'position-anchor': (value) =>
    /^(?:normal|none|auto)$/i.test(value)
      ? value.toLowerCase()
      : DASHED_IDENT.test(value)
        ? value
        : null,
  'position-area': (value) => positionAreaText(value),
  'position-try-order': (value) =>
    TRY_ORDER.test(value) ? value.toLowerCase() : null,
  'position-visibility': (value) => {
    const words = value.toLowerCase().split(/\s+/);
    if (words.length === 1 && words[0] === 'always') return 'always';
    const order = ['anchors-valid', 'anchors-visible', 'no-overflow'];
    if (!words.every((w) => order.includes(w))) return null;
    if (new Set(words).size !== words.length) return null;
    return order.filter((w) => words.includes(w)).join(' ');
  },
  'position-try-fallbacks': tryFallbacks,
  'position-try': (value) => {
    const words = splitValue(value).filter(Boolean);
    let order = 'normal';
    if (words.length && TRY_ORDER.test(words[0])) {
      order = words[0].toLowerCase();
      value = value.trim().slice(words[0].length).trim();
      if (!value) return null;
    }
    const fallbacks = tryFallbacks(value);
    if (fallbacks === null) return null;
    return order === 'normal' ? fallbacks : `${order} ${fallbacks}`;
  },
};
