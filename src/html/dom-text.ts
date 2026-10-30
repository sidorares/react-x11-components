// A place in the DOM as a place in the document's text, and the other way
// round: what a page's selection and its ranges are measured by. The text
// a document draws is its text nodes' with white space collapsed and a
// `text-transform` applied (`Builder._textNode`), so a text node's offset
// and the text's are walked side by side, a run of collapsed white space
// being the one space, or none, it came to.
import type { AnyNode, Element, Text } from 'domhandler';
import { isTag, isText } from 'domhandler';
import type { BoxTree, TextSource } from './layout/boxes.js';

const isSpace = (c: number): boolean =>
  c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/**
 * Walk a text node's data and the text it came to side by side, to `offset`
 * in one of them: `inData` where the offset is the node's, else the
 * text's. Answers the offset in the other.
 */
function walk(data: string, text: string, offset: number, inData: boolean) {
  let i = 0;
  let j = 0;
  while (inData ? i < offset : j < offset) {
    if (i >= data.length) break;
    const c = data.charCodeAt(i);
    const d = text.charCodeAt(j);
    if (c === d && !isSpace(c)) {
      i += 1;
      j += 1;
      continue;
    }
    if (isSpace(c)) {
      if (j < text.length && isSpace(d)) {
        // the run's one space: what is left of the run collapsed into it,
        // where the text goes on with something else
        i += 1;
        j += 1;
        while (
          (inData ? i < offset : true) &&
          i < data.length &&
          isSpace(data.charCodeAt(i)) &&
          !(j < text.length && isSpace(text.charCodeAt(j)))
        ) {
          i += 1;
        }
      } else i += 1; // collapsed away
      continue;
    }
    // a letter `text-transform` changed
    i += 1;
    j += 1;
  }
  return inData ? Math.min(j, text.length) : Math.min(i, data.length);
}

function sourceOf(tree: BoxTree, node: Text): TextSource | null {
  let map = BY_NODE.get(tree);
  if (!map) {
    map = new Map();
    for (const s of tree.textNodes ?? []) map.set(s.node, s);
    BY_NODE.set(tree, map);
  }
  return map.get(node) ?? null;
}

const BY_NODE = new WeakMap<BoxTree, Map<Text, TextSource>>();

/** What a source's text is in the document's: `end` may be a unit past
 *  it where the line took back a space it ended on. */
function textOf(tree: BoxTree, s: TextSource): string {
  return tree.text.slice(s.start, Math.min(s.end, tree.text.length));
}

/** The next node after `node` in tree order, past what it holds where
 *  `skip`. */
function following(node: AnyNode, skip: boolean): AnyNode | null {
  const kids = (node as Element).children;
  if (!skip && kids?.length) return kids[0];
  for (let at: AnyNode | null = node; at; at = at.parent) {
    if (at.next) return at.next;
  }
  return null;
}

/**
 * Where a DOM boundary point is in the document's text, in code units: in
 * a text node that came to text, its offset walked into it; anywhere else,
 * the start of the first text after the point, or the end of the text.
 * Where `breakAt` is given, a `<br>` after the point and before that text
 * is where it is instead — the line feed it came to, which `breakAt`
 * answers for the element, or null where it came to none.
 */
export function unitOfPoint(
  tree: BoxTree,
  node: AnyNode,
  offset: number,
  breakAt?: (br: Element) => number | null,
): number {
  if (isText(node)) {
    const s = sourceOf(tree, node);
    if (s) return s.start + walk(node.data, textOf(tree, s), offset, true);
    const after = following(node, true);
    return after ? unitBefore(tree, after, breakAt) : tree.text.length;
  }
  const kids = (node as Element).children ?? [];
  const at: AnyNode | null =
    offset < kids.length ? kids[offset] : following(node, true);
  return at ? unitBefore(tree, at, breakAt) : tree.text.length;
}

/** Where the first text at or after a node, in tree order, starts — or
 *  the first `<br>`, where `breakAt` answers for it. */
function unitBefore(
  tree: BoxTree,
  from: AnyNode,
  breakAt?: (br: Element) => number | null,
): number {
  for (let at: AnyNode | null = from; at; at = following(at, false)) {
    if (isText(at)) {
      const s = sourceOf(tree, at);
      if (s) return s.start;
    } else if (breakAt && isTag(at) && at.name === 'br') {
      const unit = breakAt(at);
      if (unit !== null) return unit;
    }
  }
  return tree.text.length;
}

/**
 * The DOM boundary point a place in the document's text is: in the text
 * node it came from, or null where it came from none — generated content,
 * a control's label.
 */
export function pointOfUnit(
  tree: BoxTree,
  unit: number,
  /** Where the place is a range's end: at the end of the text before it,
   *  where it is one text's end and the next's start. */
  end = false,
): { node: Text; offset: number } | null {
  const list = tree.textNodes ?? [];
  // the last source that starts at or before the unit — before it, for an
  // end past the start of the first
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const start = list[mid].start;
    if (start < unit || (start === unit && !(end && mid > 0))) lo = mid + 1;
    else hi = mid;
  }
  const s = list[lo - 1];
  if (!s) return list[0] ? { node: list[0].node, offset: 0 } : null;
  const text = textOf(tree, s);
  const into = Math.min(unit - s.start, text.length);
  return { node: s.node, offset: walk(s.node.data, text, into, false) };
}
