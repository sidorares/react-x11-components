// A declaration's value as `el.style` keeps it (CSSOM 6.7, "set a CSS
// declaration"): parsed against the property's grammar, and kept in its
// canonical form, or not kept at all where it is no value of the property.
// Only the properties this engine reads a grammar for answer; any other is
// kept as it was written, as it always was here, so a value a page sets and
// reads back is never lost to a grammar this has not got.

import { parseShapeFunction } from './shape-function.js';
import { parseZoom, splitValue } from './values.js';
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
  // a number or a percentage, neither below nought, or `normal` (CSS
  // Viewport 1, 5)
  if (name === 'zoom') {
    const word = value.trim().toLowerCase();
    if (CSS_WIDE.test(word)) return undefined;
    return parseZoom(word) === null ? null : word;
  }
  // `contrast-color()` takes one colour and nothing else (CSS Color 5,
  // 6.1): a value holding one of anything else is none, in any property
  if (/contrast-color\(/i.test(value) && !contrastColorsValid(value)) {
    return null;
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
