// What the developer tools know, apart from how they are drawn: the DOM as
// a tree reads it, an element's box from its computed style, and the two
// stores the page and the tools share — what is inspected, and what the
// page wrote to its console.
//
// The stores are small subscribe-and-read objects rather than React state
// in the page, so that a pointer moving over the tree re-renders the
// highlight over the document and nothing else: the page component holds
// every document of the tab, and a render of it is a render of each
// `<Html>` in it.
import { useSyncExternalStore } from 'react';
import type {
  AnyNode,
  ConsoleValue,
  Document,
  Element,
  HtmlSheetSource,
} from '../../../src/html/index.js';

/** The panels the tools open on. */
export type DevtoolsPanel =
  'elements' | 'console' | 'sources' | 'network' | 'storage';

/** The side of the page the tools are docked on. */
export type DockSide = 'bottom' | 'right' | 'left';

export const DOCK_SIDES: readonly DockSide[] = ['left', 'bottom', 'right'];

// --- a store ----------------------------------------------------------------

/** One value, and who to tell when it changes. */
export class Store<T> {
  private _value: T;
  private readonly _listeners = new Set<() => void>();

  constructor(value: T) {
    this._value = value;
  }

  get value(): T {
    return this._value;
  }

  set(value: T): void {
    if (Object.is(value, this._value)) return;
    this._value = value;
    for (const listener of [...this._listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };
}

/** A store's value, re-rendering the component as it changes. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(
    store.subscribe,
    () => store.value,
    () => store.value,
  );
}

/** A part of a style sheet to show in the Sources panel: `from` to `to`, in
 *  the sheet's text. */
export interface SourceTarget {
  sheet: HtmlSheetSource;
  from: number;
  to: number;
}

/**
 * What the tools inspect, which the page draws over its document: the
 * element chosen in the Elements panel, the one the pointer is over in the
 * tree (or in the page, while picking), and whether a press in the page
 * picks an element rather than doing what it does.
 */
export class Inspection {
  readonly selected = new Store<DomNode | null>(null);
  readonly hovered = new Store<Element | null>(null);
  readonly picking = new Store(false);
  /** Bumped when something outside asks the tree to show `selected`: an
   *  Inspect from the page's menu, a pick. */
  readonly revealed = new Store(0);
  /** Bumped when the tools changed the document: what reads it reads it
   *  again now, rather than at its next tick. */
  readonly edited = new Store(0);
  /** What the Sources panel was last asked to show, a new object for each
   *  ask; null once the reader chose a file there themselves. */
  readonly source = new Store<SourceTarget | null>(null);

  touch(): void {
    this.edited.set(this.edited.value + 1);
  }

  /** Choose an element from outside the tree, and have the tree show it. */
  reveal(element: DomNode | null): void {
    this.selected.set(element);
    this.revealed.set(this.revealed.value + 1);
  }
}

// --- the console's messages -------------------------------------------------

export type ConsoleLevel =
  | 'log'
  | 'info'
  | 'debug'
  | 'warn'
  | 'error'
  /** What was typed, and what it came to. */
  | 'input'
  | 'result'
  /** The document shown changed. */
  | 'navigation';

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  text: string;
  /** How many times in a row it was written: a console shows a message
   *  written again as one with a count. */
  count: number;
  /** What a result came to, where the page's realm keeps it: an object a
   *  console draws as a tree. */
  value?: ConsoleValue;
}

/** How many messages a tab keeps: the oldest go past it. */
const MOST_MESSAGES = 1000;

let nextEntry = 0;

/**
 * What a tab's pages wrote to their console, and what was typed into it,
 * kept from the time the tab's process started — so the tools, opened
 * after a page logged, still show what it said, as a browser's do.
 */
export class ConsoleLog extends Store<readonly ConsoleEntry[]> {
  constructor() {
    super([]);
  }

  write(level: ConsoleLevel, text: string, value?: ConsoleValue): void {
    const all = this.value;
    const last = all[all.length - 1];
    if (
      last &&
      last.level === level &&
      last.text === text &&
      level !== 'input' &&
      level !== 'result'
    ) {
      this.set([...all.slice(0, -1), { ...last, count: last.count + 1 }]);
      return;
    }
    const entry: ConsoleEntry = {
      id: ++nextEntry,
      level,
      text,
      count: 1,
      ...(value && { value }),
    };
    const kept = all.length >= MOST_MESSAGES ? all.slice(1) : all;
    this.set([...kept, entry]);
  }

  clear(): void {
    this.set([]);
  }
}

/** A level the page's `log` seam names, as the console keeps it. */
export function levelOf(level: string): ConsoleLevel {
  switch (level) {
    case 'info':
    case 'debug':
    case 'warn':
    case 'error':
      return level;
    case 'warning':
      return 'warn';
    default:
      return 'log';
  }
}

// --- the DOM, as a tree reads it -------------------------------------------

/** A node of the document, as a row of the Elements tree. */
export type DomNode = AnyNode;

const ids = new WeakMap<object, number>();
let nextId = 0;

/** A node's id in the tree: the same for its life, whatever moves it. */
export function nodeId(node: DomNode): number {
  let id = ids.get(node);
  if (id === undefined) {
    id = ++nextId;
    ids.set(node, id);
  }
  return id;
}

/** How much of an element's one line of text a row shows beside its tags
 *  rather than as a row of its own, as a browser's tree does `<title>`. */
const INLINE_TEXT = 80;

const isElement = (node: DomNode): node is Element =>
  node.type === 'tag' || node.type === 'script' || node.type === 'style';

/** Text that is only white space, which a tree leaves out. */
const blank = (node: DomNode): boolean =>
  node.type === 'text' && !/\S/.test((node as { data: string }).data);

/** The text an element is shown with on its own row, where all it holds is
 *  one short line of it. */
export function inlineTextOf(node: DomNode): string | null {
  if (!isElement(node)) return null;
  const kids = node.children.filter((child) => !blank(child));
  if (kids.length !== 1 || kids[0].type !== 'text') return null;
  const text = (kids[0] as { data: string }).data.trim();
  return text.length <= INLINE_TEXT && !text.includes('\n') ? text : null;
}

/** What a row's twisty opens: the elements, comments and text in a node,
 *  white space left out; none for an element shown with its text. */
export function childrenOf(node: DomNode): readonly DomNode[] | undefined {
  if (node.type !== 'root' && !isElement(node)) return undefined;
  if (inlineTextOf(node) !== null) return undefined;
  const kids = (node as Document | Element).children.filter(
    (child) => !blank(child),
  );
  return kids.length ? kids : undefined;
}

export const isBranch = (node: DomNode): boolean => !!childrenOf(node);

/** The elements from the document's root down to `element`, its own id
 *  last: what the tree opens to show it. */
export function pathTo(element: DomNode): number[] {
  const out: number[] = [];
  for (let n: DomNode | null = element; n; n = n.parent as DomNode | null) {
    if (n.type === 'root') break;
    out.unshift(nodeId(n));
  }
  return out;
}

/** The tree opens on the document's `<html>` and `<body>`, as a browser's
 *  does. */
export function initialExpanded(doc: Document | null): number[] {
  if (!doc) return [];
  const html = doc.children.find(
    (n): n is Element => isElement(n) && n.name === 'html',
  );
  if (!html) return [];
  const body = html.children.find(
    (n): n is Element => isElement(n) && n.name === 'body',
  );
  return body ? [nodeId(html), nodeId(body)] : [nodeId(html)];
}

/** One coloured piece of a row's label. */
export interface LabelPart {
  text: string;
  kind: 'punct' | 'tag' | 'attr' | 'value' | 'text' | 'comment';
}

/** How long an attribute's value, or a run of text, a row shows. */
const MOST_SHOWN = 120;

const clip = (text: string): string =>
  text.length > MOST_SHOWN ? `${text.slice(0, MOST_SHOWN)}…` : text;

/** A row's label: `<div class="x">`, `"text"`, `<!-- comment -->`. An
 *  element closed is shown with `…</div>`, and one shown with its text
 *  with it and its end tag. */
export function labelOf(node: DomNode, open: boolean): LabelPart[] {
  if (node.type === 'text') {
    const text = (node as { data: string }).data.replace(/\s+/g, ' ').trim();
    return [{ text: `"${clip(text)}"`, kind: 'text' }];
  }
  if (node.type === 'comment') {
    const text = (node as { data: string }).data.trim();
    return [{ text: `<!-- ${clip(text)} -->`, kind: 'comment' }];
  }
  if (node.type === 'directive') {
    const data = (node as { data: string }).data;
    return [
      { text: `<${data.replace(/^!doctype/i, '!DOCTYPE')}>`, kind: 'comment' },
    ];
  }
  if (!isElement(node)) return [{ text: node.type, kind: 'comment' }];
  const parts: LabelPart[] = [
    { text: '<', kind: 'punct' },
    { text: node.name, kind: 'tag' },
  ];
  for (const [name, value] of Object.entries(node.attribs)) {
    parts.push({ text: ` ${name}`, kind: 'attr' });
    if (value !== '') {
      parts.push({ text: '="', kind: 'punct' });
      parts.push({ text: clip(value), kind: 'value' });
      parts.push({ text: '"', kind: 'punct' });
    }
  }
  parts.push({ text: '>', kind: 'punct' });
  const inline = inlineTextOf(node);
  const empty = !childrenOf(node) && inline === null;
  if (inline !== null) parts.push({ text: inline, kind: 'text' });
  else if (!open && !empty) parts.push({ text: '…', kind: 'punct' });
  if (!VOID.has(node.name) && (inline !== null || empty || !open)) {
    parts.push({ text: '</', kind: 'punct' });
    parts.push({ text: node.name, kind: 'tag' });
    parts.push({ text: '>', kind: 'punct' });
  }
  return parts;
}

/** What type-ahead in the tree matches: the tag, or the text. */
export function textOf(node: DomNode): string {
  if (isElement(node)) return node.name;
  if (node.type === 'text') return (node as { data: string }).data.trim();
  return '';
}

/** The elements HTML gives no end tag. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** `tag#id.class.class`, as a highlight's caption and a breadcrumb name an
 *  element. */
export function selectorOf(element: Element): string {
  let out = element.name;
  const id = element.attribs.id;
  if (id) out += `#${id}`;
  const classes = (element.attribs.class ?? '').trim().split(/\s+/);
  for (const name of classes.slice(0, 3)) if (name) out += `.${name}`;
  return out;
}

// --- an element's box -------------------------------------------------------

export interface Sides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** An element's box as CSS draws it, from its computed style: its margins,
 *  borders and padding, and its content's size. */
export interface BoxModel {
  margin: Sides;
  border: Sides;
  padding: Sides;
  /** The content box's size, in CSS pixels. */
  width: number;
  height: number;
}

const px = (value: string | undefined): number => {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
};

const sides = (
  style: Record<string, string>,
  name: (side: keyof Sides) => string,
): Sides => ({
  top: px(style[name('top')]),
  right: px(style[name('right')]),
  bottom: px(style[name('bottom')]),
  left: px(style[name('left')]),
});

/**
 * The box from a computed style and the border box `elementRect` measured:
 * the content's size is what is left of the border box, since a computed
 * `width` is `auto` for an inline element and `getComputedStyle` answers
 * it as `auto`.
 */
export function boxModelOf(
  style: Record<string, string>,
  border: { width: number; height: number },
): BoxModel {
  const margin = sides(style, (side) => `margin-${side}`);
  const borders = sides(style, (side) => `border-${side}-width`);
  const padding = sides(style, (side) => `padding-${side}`);
  return {
    margin,
    border: borders,
    padding,
    width: Math.max(
      0,
      border.width -
        borders.left -
        borders.right -
        padding.left -
        padding.right,
    ),
    height: Math.max(
      0,
      border.height -
        borders.top -
        borders.bottom -
        padding.top -
        padding.bottom,
    ),
  };
}

/** The four boxes' colours: the ones a browser's tools draw them in, which
 *  the highlight over the page draws them in too. */
export const BOX_COLOURS = {
  margin: '#f9cc9d',
  border: '#fddd9b',
  padding: '#c3d08b',
  content: '#8cb6c0',
};

/** A length as the tools print one: whole where it is, else to two
 *  places. */
export function printPx(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}
