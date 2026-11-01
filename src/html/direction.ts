// An element's directionality (HTML 3.2.6.4), which `:dir()` reads: what its
// `dir` says, or its text's first strong letter's where that says `auto` or
// it is a `<bdi>`, or else its parent's. Laid out text has a direction of
// its own (`layout/inline.ts`), which this does not set: `dir` is a
// presentational hint, and `auto` an isolate the bidi algorithm resolves.
import bidiModule from 'bidi-js';
import type { Bidi } from 'bidi-js';
import type { AnyNode, Element } from 'domhandler';

import {
  ShadowRoot,
  attr,
  childrenOf,
  flatChildrenOf,
  isElement,
  tagOf,
} from './dom.js';
import { controlValue, inputType, typedText } from './form.js';

let BIDI: Bidi | null = null;

/** bidi-js, made the first time a paragraph needs it. Its declarations
 *  give a CommonJS module a default export, which NodeNext reads as the
 *  module object; Node and a bundler both hand over its factory. */
export function bidiJs(): Bidi {
  if (!BIDI) {
    const factory = bidiModule as unknown as
      (() => Bidi) | { default: () => Bidi };
    BIDI = (typeof factory === 'function' ? factory : factory.default)();
  }
  return BIDI;
}

type Direction = 'ltr' | 'rtl';

/** What a text's first strong letter makes of a direction, null for none. */
function firstStrong(text: string): Direction | null {
  const { getBidiCharTypeName } = bidiJs();
  for (const letter of text) {
    const type = getBidiCharTypeName(letter);
    if (type === 'L') return 'ltr';
    if (type === 'R' || type === 'AL') return 'rtl';
  }
  return null;
}

/** What says a direction of its own, which a walk of what holds it for a
 *  first strong letter passes over. */
const PASSED_OVER = new Set(['bdi', 'script', 'style', 'textarea']);

function saysDirection(el: Element): boolean {
  const dir = attr(el, 'dir')?.toLowerCase();
  return dir === 'ltr' || dir === 'rtl' || dir === 'auto';
}

/** The first strong letter in what an element holds (HTML's "contained text
 *  auto directionality"), in tree order, and what a slot was given for what
 *  it holds. A walk with a stack of its own: nothing bounds a document's
 *  depth, and a direction is asked of what the parser just gave it. */
function heldDirection(el: Element): Direction | null {
  const stack: AnyNode[] = [el];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'text') {
      const found = firstStrong(node.data);
      if (found) return found;
      continue;
    }
    if (!isElement(node)) continue;
    if (node !== el && (PASSED_OVER.has(tagOf(node)) || saysDirection(node))) {
      continue;
    }
    const kids =
      tagOf(node) === 'slot' ? flatChildrenOf(node) : childrenOf(node);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return null;
}

/** What an element with `auto` takes: a field's text, or what it holds. With
 *  no strong letter, left to right, as Blink has it: a parent's right to
 *  left is not asked. */
function autoDirection(el: Element): Direction {
  const tag = tagOf(el);
  const found =
    tag === 'input' || tag === 'textarea'
      ? firstStrong(controlValue(el, typedText))
      : heldDirection(el);
  return found ?? 'ltr';
}

/** An element's directionality. A telephone number reads left to right
 *  whatever is around it. The top of a shadow tree takes its host's. */
export function directionOf(el: Element): Direction {
  let at: Element | null = el;
  while (at) {
    const dir = attr(at, 'dir')?.toLowerCase();
    if (dir === 'ltr' || dir === 'rtl') return dir;
    if (dir === 'auto' || tagOf(at) === 'bdi') return autoDirection(at);
    if (tagOf(at) === 'input' && inputType(at) === 'tel') return 'ltr';
    const parent: AnyNode | null = at.parent;
    at =
      parent instanceof ShadowRoot
        ? parent.host
        : parent && isElement(parent)
          ? parent
          : null;
  }
  return 'ltr';
}

/** The element a change to text at `node` can turn the direction of: the
 *  nearest around it that says one, where that is one read from its text. */
export function directionHolder(node: AnyNode): Element | null {
  for (let at: AnyNode | null = node; at && isElement(at); at = at.parent) {
    if (saysDirection(at) || tagOf(at) === 'bdi') {
      const dir = attr(at, 'dir')?.toLowerCase();
      return dir === 'ltr' || dir === 'rtl' ? null : at;
    }
  }
  return null;
}
