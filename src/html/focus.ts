// Which of a document's elements take the keyboard's focus, and the order
// Tab reaches them in — the pure half, which needs no display.
//
// A document's focusable areas are of two kinds here, and the difference is
// who holds the focus. A form control has a real widget mounted beside the
// element, and the widget takes it (`widgets.ts`). Everything else — a link,
// a `<button>`, a `<summary>`, an element a `tabindex` makes focusable — is
// drawn by the document, and is reached through a **stop**: a box with no
// paint and no hit area, mounted over the element the way a widget is, that
// takes the focus in the window's focus order and tells the document it has
// it (`stops.ts`). So Tab goes from a link to a field to a button in the
// order the markup has them, into and out of the document as it goes through
// the rest of the window, and nothing of core's focus model is rebuilt here.
import { attr, flatChildrenOf, flatParentOf, isElement, tagOf } from './dom.js';
import type { ChildNode, Element, ParentNode } from './dom.js';
import { isDisabled } from './form.js';

/** One of a document's focusable areas, in the order Tab reaches them. */
export interface FocusStop {
  element: Element;
  /**
   * Whether Tab reaches it: not where a negative `tabindex` keeps it to a
   * press, its label, `autofocus` or a script (HTML 6.6.3).
   */
  tabbable: boolean;
  /**
   * Whether a widget is mounted for it, which takes the focus itself: a form
   * control's. Otherwise the document draws it, and a stop takes the focus
   * for it.
   */
  widget: boolean;
}

/**
 * Whether an element's markup makes it a focusable area (HTML 6.6.3, and
 * what Chrome adds to it): a link, a control that is not disabled, a
 * details' summary, and anything with a `tabindex`. Whether it is rendered
 * — has a box, and is visible — is the caller's to ask.
 */
export function focusableElement(
  el: Element,
  tag: string = tagOf(el),
): boolean {
  switch (tag) {
    case 'a':
    case 'area':
      if (attr(el, 'href') !== undefined) return true;
      break;
    case 'input':
      if ((attr(el, 'type') ?? '').trim().toLowerCase() === 'hidden') {
        return false;
      }
    // fallthrough
    case 'button':
    case 'select':
    case 'textarea':
      // a disabled control is no focusable area, whatever its `tabindex`
      return !isDisabled(el);
    case 'summary':
      if (isSummaryOf(el)) return true;
      break;
  }
  // asked of every element a document builds a box for, so the attribute
  // is looked for before it is parsed
  return attr(el, 'tabindex') !== undefined && tabIndexOf(el) !== null;
}

/**
 * An element's `tabindex`, by the rules for parsing integers (HTML
 * 2.3.4.1): white space, a sign, digits, and whatever follows them ignored.
 * Null where it has none, or one that is not a number.
 */
export function tabIndexOf(el: Element): number | null {
  const m = /^[ \t\n\f\r]*([+-]?\d+)/.exec(attr(el, 'tabindex') ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Whether Tab reaches a focusable element: a negative `tabindex` takes it
 * out of the order and leaves it focusable. A positive one is read as zero
 * — where the element is — as a control's widget reads it (`tabOrder`,
 * widgets.ts): it would order a page's elements ahead of the application's
 * own, and the order between a document and the window around it is not the
 * document's to set.
 */
export function isTabbable(el: Element): boolean {
  const index = tabIndexOf(el);
  return index === null || index >= 0;
}

/** Whether a `<summary>` is its `<details>`' own: the first one in it,
 *  which shows while the details are closed and opens them. */
export function isSummaryOf(el: Element): boolean {
  const details = el.parent;
  if (!isElement(details) || tagOf(details) !== 'details') return false;
  for (const child of details.children) {
    if (isElement(child) && tagOf(child) === 'summary') return child === el;
  }
  return false;
}

/** Whether an element is `inert`, or inside one that is in the flat tree:
 *  none of it is a focusable area (HTML 6.3). */
export function isInert(el: Element): boolean {
  for (let at: Element | null = el; at; at = flatParentOf(at)) {
    if (attr(at, 'inert') !== undefined) return true;
  }
  return false;
}

/**
 * The stop Tab goes to from `from`, forwards or back, or null where it runs
 * off the end of the document — which is where the window's own order takes
 * over.
 *
 * `from` need not be a stop. One a negative `tabindex` keeps out of the
 * order goes on from where it is, as a browser's does; and so does a place
 * that is no focusable area at all — where a press last landed, HTML's
 * sequential focus navigation starting point (6.6.4) — or the start or the
 * end of the document, given null. A place inside a stop, the text of a
 * link, goes on from that stop.
 */
export function stepFrom(
  stops: readonly FocusStop[],
  from: Element | null,
  backwards: boolean,
): FocusStop | null {
  if (!from) return walk(stops, backwards ? stops.length : -1, backwards);
  // the nearest stop around the place, itself included
  const index = new Map<Element, number>();
  stops.forEach((s, i) => index.set(s.element, i));
  for (let at: Element | null = from; at; at = flatParentOf(at)) {
    const i = index.get(at);
    if (i !== undefined) return walk(stops, i, backwards);
  }
  // and else the first stop after it, by a binary search over the stops,
  // which are in the document's order
  let lo = 0;
  let hi = stops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (precedes(stops[mid].element, from)) lo = mid + 1;
    else hi = mid;
  }
  return walk(stops, backwards ? lo : lo - 1, backwards);
}

/** The next tabbable stop after index `at`, or before it. */
function walk(
  stops: readonly FocusStop[],
  at: number,
  backwards: boolean,
): FocusStop | null {
  const step = backwards ? -1 : 1;
  for (let i = at + step; i >= 0 && i < stops.length; i += step) {
    if (stops[i].tabbable) return stops[i];
  }
  return null;
}

/** Whether `a` comes before `b` in the flat tree's order, which is the
 *  stops' — around it, or ahead of it. */
function precedes(a: Element, b: Element): boolean {
  if (a === b) return false;
  const chain = (el: Element): ParentNode[] => {
    const out: ParentNode[] = [];
    let at: ParentNode | null = el;
    for (let up = flatParentOf(el); up; up = flatParentOf(up)) {
      out.push(at!);
      at = up;
    }
    // and from the top of the flat tree, the document's
    for (; at; at = at.parent) out.push(at);
    return out.reverse();
  };
  const above = chain(a);
  const below = chain(b);
  let i = 0;
  while (i < above.length && i < below.length && above[i] === below[i]) i += 1;
  // one around the other
  if (i === above.length) return true;
  if (i === below.length || i === 0) return false;
  const siblings = flatChildrenOf(above[i - 1]);
  return (
    siblings.indexOf(above[i] as ChildNode) <
    siblings.indexOf(below[i] as ChildNode)
  );
}
