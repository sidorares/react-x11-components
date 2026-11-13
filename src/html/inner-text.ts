// `innerText` as HTML has it (3.2.7, "the rendered text collection
// steps"): the text of what an element draws, with a line break where a
// block starts and ends, a blank line around a paragraph, a tab between a
// row's cells, and nothing of what is hidden or not rendered.
//
// What each text node comes to is already worked out: the document's text
// is its text nodes' with their white space collapsed and a `text-transform`
// applied (`BoxTree.text`, `BoxTree.textNodes`), so a text node is its slice
// of it, and only what is around the text is worked out here, from the
// styles the build gave each element (`BoxTree.styles`). A text node that
// came to no text is not rendered; an element the build gave no style is
// not either — under `display: none`, inside a replaced element, in a
// closed `<details>`.
import type { AnyNode, Element, Text } from 'domhandler';
import { isTag, isText } from 'domhandler';
import type { ComputedStyle } from './css/style.js';
import { tagOf } from './dom.js';
import type { BoxTree, TextSource } from './layout/boxes.js';

/** What the steps ask of the document. */
export interface RenderedTextSeams {
  tree: BoxTree;
  /** The style the build gave an element, or null where it gave none. */
  styleOf(element: Element): ComputedStyle | null;
}

/** An item of the list the steps make: a string, a required line break
 *  count, or a mark of where lines start and end with none: a `<br>`'s
 *  (`EDGE`), an inline-block's own lines (`OPEN`, `CLOSE`), and an atom on
 *  a line, which keeps the spaces either side of it (`ATOM`). A string
 *  whose spaces collapse is a `Spaced`. */
type Item = string | number | Spaced | Mark;

const EDGE = 1;
const OPEN = 2;
const CLOSE = 3;
const ATOM = 4;
class Mark {
  constructor(public kind: number) {}
}
const MARKS = [
  null,
  new Mark(EDGE),
  new Mark(OPEN),
  new Mark(CLOSE),
  new Mark(ATOM),
];

/** Text whose white space collapses, which loses a space at the start or
 *  the end of a line. */
class Spaced {
  constructor(public text: string) {}
}

/** What a replaced element holds, which it does not draw. */
const REPLACED = new Set([
  'audio',
  'video',
  'object',
  'iframe',
  'canvas',
  'textarea',
  'embed',
  'img',
  'input',
  'hr',
  'math',
]);

/** What in a drawing is not drawn. */
const UNDRAWN = new Set([
  'defs',
  'symbol',
  'clippath',
  'mask',
  'pattern',
  'marker',
  'lineargradient',
  'radialgradient',
  'filter',
  'title',
  'desc',
  'metadata',
  'style',
  'script',
]);

/** The displays whose white space children are not rendered: what a table
 *  holds between its parts. */
const TABLE_PARTS = new Set([
  'table',
  'inline-table',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-column',
  'table-column-group',
]);

const SOURCES = new WeakMap<BoxTree, Map<Text, TextSource[]>>();

function sourcesOf(tree: BoxTree): Map<Text, TextSource[]> {
  let map = SOURCES.get(tree);
  if (!map) {
    map = new Map();
    for (const s of tree.textNodes ?? []) {
      const list = map.get(s.node);
      if (list) list.push(s);
      else map.set(s.node, [s]);
    }
    SOURCES.set(tree, map);
  }
  return map;
}

/** Whether a style's box is block-level: what a line break goes round
 *  (CSS Display 3, 2.4). A float and a box out of the flow are blockified,
 *  and so are a flex or grid container's items. */
function blockLevel(style: ComputedStyle, inFlex: boolean): boolean {
  const d = style.display;
  if (d === 'none' || d === 'contents') return false;
  if (
    d === 'block' ||
    d === 'list-item' ||
    d === 'flex' ||
    d === 'table' ||
    d === 'table-caption'
  ) {
    return true;
  }
  if (style.float !== 'none') return true;
  if (style.position === 'absolute' || style.position === 'fixed') {
    return true;
  }
  return inFlex && !d.startsWith('table');
}

/** The element children of a node, in tree order. */
function elementsOf(node: Element): Element[] {
  return node.children.filter((c): c is Element => isTag(c));
}

/** HTML's white space for text the document does not draw itself: an
 *  `<option>`'s in a `<select>`, which a widget shows. */
function collapsed(data: string): string {
  return data.replace(/[ \t\n\r\f]+/g, ' ').trim();
}

/**
 * `element.innerText`, or null where the element is not being rendered,
 * whose `innerText` is its text content.
 */
export function renderedText(
  element: Element,
  seams: RenderedTextSeams,
): string | null {
  const { tree } = seams;
  const own = seams.styleOf(element);
  if (!own || own.display === 'none') return null;
  const sources = sourcesOf(tree);
  const flexOf = (el: Element): boolean => tree.styles.get(el)?.inFlex ?? false;

  /** A table cell's or row's next of its kind, which decides whether it
   *  ends with a tab or a line feed. */
  const nextRendered = (
    el: Element,
    kind: 'table-cell' | 'table-row',
  ): boolean => {
    for (let at = el.next; at; at = at.next) {
      if (!isTag(at)) continue;
      const style = seams.styleOf(at);
      if (style && style.display === kind) return true;
    }
    return false;
  };
  /** Whether a row is followed by another of the nearest table around it,
   *  in tree order, past the row groups it is in. */
  const laterRow = (row: Element): boolean => {
    if (nextRendered(row, 'table-row')) return true;
    for (let at = row.parent; at && isTag(at); at = at.parent) {
      const style = seams.styleOf(at);
      if (!style) return false;
      if (style.display === 'table' || style.display === 'inline-table') {
        return false;
      }
      for (let sib = at.next; sib; sib = sib.next) {
        if (isTag(sib) && hasRow(sib)) return true;
      }
    }
    return false;
  };
  const hasRow = (el: Element): boolean => {
    const style = seams.styleOf(el);
    if (!style || style.display === 'none') return false;
    if (style.display === 'table-row') return true;
    if (style.display === 'table' || style.display === 'inline-table') {
      return false;
    }
    return elementsOf(el).some(hasRow);
  };

  /** A `<select>` draws a widget, so what its options say comes to no
   *  text of the document's: their text is worked out here. */
  const inSelect = (node: Text | Element): boolean => {
    for (let at = node.parent; at && isTag(at); at = at.parent) {
      if (tagOf(at) === 'select') return true;
      if (at === element) return false;
    }
    return false;
  };
  /** Text in an `<option>` of a `<select>`. */
  const inOption = (node: Text): boolean => {
    let option = false;
    for (let at = node.parent; at && isTag(at); at = at.parent) {
      const tag = tagOf(at);
      if (tag === 'select') return option;
      if (tag === 'option') option = true;
      if (at === element) return false;
    }
    return false;
  };
  /** Text a drawing draws: in a `<text>`, and in nothing it only refers
   *  to. */
  const drawnInSvg = (node: Text): boolean => {
    let inText = false;
    for (let at = node.parent; at && isTag(at); at = at.parent) {
      const name = at.name.toLowerCase();
      if (name === 'svg') return inText;
      if (UNDRAWN.has(name)) return false;
      if (name === 'text') inText = true;
    }
    return false;
  };
  /** Whether an element is inside an `<svg>` the document draws. */
  const inDrawing = (node: Element): boolean => {
    for (let at = node.parent; at && isTag(at); at = at.parent) {
      if (at.name.toLowerCase() === 'svg') return !!seams.styleOf(at);
    }
    return false;
  };
  /** Whether a text node is inside what a replaced element holds. */
  const replacedAround = (node: Text): boolean => {
    for (let at = node.parent; at && isTag(at); at = at.parent) {
      if (REPLACED.has(tagOf(at))) return true;
      if (at === element) return false;
    }
    return false;
  };

  const collect = (node: AnyNode, items: Item[]): void => {
    if (isText(node)) {
      const parent = node.parent;
      const style = parent && isTag(parent) ? seams.styleOf(parent) : null;
      if (style && style.visibility !== 'visible') return;
      // what a table holds between its parts is no text of it
      if (style && TABLE_PARTS.has(style.display) && !node.data.trim()) {
        return;
      }
      const list = sources.get(node);
      if (list && !replacedAround(node)) {
        const collapses =
          !style ||
          style.whiteSpace === 'normal' ||
          style.whiteSpace === 'nowrap' ||
          style.whiteSpace === 'pre-line';
        let text = '';
        for (const s of list) {
          text += tree.text.slice(s.start, Math.min(s.end, tree.text.length));
        }
        // a space the line took back at its end leaves the node's range a
        // unit into what follows it (`TextSource`)
        if (
          collapses &&
          text &&
          (style?.whiteSpace === 'pre-line'
            ? /[ \t\r\f]$/
            : /[ \t\n\r\f]$/
          ).test(node.data) &&
          text[text.length - 1] !== ' ' &&
          text.length > node.data.replace(/[ \t\n\r\f]+/g, ' ').trim().length
        ) {
          text = text.slice(0, -1);
        }
        if (text) items.push(collapses ? new Spaced(text) : text);
      } else if (parent && isTag(parent) && inOption(node)) {
        const text = collapsed(node.data);
        if (text) items.push(text);
      } else if (drawnInSvg(node)) {
        const text = collapsed(node.data);
        if (text) items.push(text);
      }
      return;
    }
    if (!isTag(node)) return;
    const tag = tagOf(node);
    // a template's content is in a document of its own, and what a
    // replaced element holds is none of what it draws
    if (tag === 'template') return;
    const style = seams.styleOf(node);
    // a `<select>`'s options are blocks of the widget's (3.2.7, step 3),
    // and what is in them is laid out as it would be anywhere
    const selected = !style && inSelect(node);
    const option = (tag === 'option' || tag === 'optgroup') && inSelect(node);
    if (selected && tag !== 'option' && tag !== 'optgroup') {
      const start = items.length;
      for (const child of node.children) collect(child, items);
      if (tag === 'div' || tag === 'p') {
        items.splice(start, 0, 1);
        items.push(1);
      }
      return;
    }
    if (!style && !option && inDrawing(node)) {
      // a drawing's text is drawn from its elements, which have no boxes
      for (const child of node.children) collect(child, items);
      return;
    }
    if (!style && !option) {
      // not rendered: what is in it may be all the same where it is shown
      // apart from it, as a `display: none` child of a `display: contents`
      // one is not
      return;
    }
    if (style && style.display === 'none') return;
    const start = items.length;
    for (const child of node.children) collect(child, items);
    if (style && style.visibility !== 'visible') return;
    if (tag === 'br') items.push(MARKS[EDGE]!, '\n', MARKS[EDGE]!);
    if (style?.display === 'table-cell' && nextRendered(node, 'table-cell')) {
      items.push('\t');
    }
    if (style?.display === 'table-row' && laterRow(node)) items.push('\n');
    let around = 0;
    if (tag === 'p' && style?.display !== 'contents') around = 2;
    else if (option || tag === 'option' || tag === 'optgroup') around = 1;
    else if (style && blockLevel(style, flexOf(node))) around = 1;
    if (around) {
      items.splice(start, 0, around);
      items.push(around);
    } else if (
      style &&
      (style.display === 'inline-block' ||
        style.display === 'inline-flex' ||
        style.display === 'inline-table')
    ) {
      // the lines of an inline-block are its own, and it is an atom on
      // the line it is on
      items.splice(start, 0, MARKS[ATOM]!, MARKS[OPEN]!);
      items.push(MARKS[CLOSE]!, MARKS[ATOM]!);
    } else if (REPLACED.has(tag) || tag === 'select' || tag === 'svg') {
      items.push(MARKS[ATOM]!);
    }
  };

  const items: Item[] = [];
  for (const child of element.children) collect(child, items);
  // a collapsible space at the start or the end of a line is not rendered,
  // nor one after another: what a count, a `<br>` or an inline-block's
  // edge is beside, and the start and the end
  const strings: (string | number)[] = [];
  /** Whether the last string is spaced text nothing has come after. */
  let adjacent = false;
  let trimNext = true;
  const trimLast = () => {
    if (!adjacent) return;
    const at = strings.length - 1;
    strings[at] = (strings[at] as string).replace(/ +$/, '');
  };
  for (const item of items) {
    if (typeof item === 'number') {
      trimLast();
      strings.push(item);
      adjacent = false;
      trimNext = true;
      continue;
    }
    if (item instanceof Mark) {
      if (item.kind === EDGE || item.kind === CLOSE) trimLast();
      adjacent = false;
      trimNext = item.kind === EDGE || item.kind === OPEN;
      continue;
    }
    if (item instanceof Spaced) {
      let text = item.text;
      const last = strings[strings.length - 1];
      if (trimNext || (adjacent && (last as string).endsWith(' '))) {
        text = text.replace(/^ +/, '');
      }
      if (!text) continue;
      strings.push(text);
      adjacent = true;
      trimNext = false;
      continue;
    }
    if (!item) continue;
    strings.push(item);
    adjacent = false;
    trimNext = false;
  }
  trimLast();
  // the empty strings out, the counts at either end out, and each run of
  // counts the most of them in line feeds
  let out = '';
  let pending = 0;
  let started = false;
  for (const item of strings) {
    if (typeof item === 'number') {
      if (started) pending = Math.max(pending, item);
      continue;
    }
    if (!item) continue;
    if (pending) out += '\n'.repeat(pending);
    pending = 0;
    started = true;
    out += item;
  }
  return out;
}
