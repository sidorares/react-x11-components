// The document half of `<Html>`: bytes in, a DOM out, progressively.
//
// The tree is [domhandler]'s, built by [htmlparser2]'s streaming parser, and
// that is a deliberate reuse rather than a shortcut. Three reasons, in the
// order they mattered:
//
//  1. **It is already installed.** ntk depends on `htmlparser2`, `domhandler`,
//     `domutils` and `css-select` for its own (deprecated) `HtmlView`, and ntk
//     is react-x11's dependency — so an app that has this package has all four
//     already, and declaring them here adds no packages to an install. That is
//     the whole of the install-closure argument this repo usually loses (see
//     AGENTS.md, "a heavy parser is an optionalDependency"), inverted.
//  2. **The parser is streaming by construction.** `parser.write(chunk)`
//     appends to the tree in place, which is the "create DOM progressively"
//     requirement rather than an approximation of it — a growing `source`
//     writes its delta, and the nodes already parsed are the same objects.
//  3. **The DOM is the app's API.** `Element`/`Text` are plain mutable
//     objects, so "manipulate the resulting DOM and the control reflects it"
//     is an ordinary object graph plus an invalidation call, not a bespoke
//     mirror the app has to learn.
//
// What is *not* reused is `HtmlView` itself — it renders a document as one
// opaque yoga tree with no selection, which is the thing being replaced.
//
// [domhandler]: https://github.com/fb55/domhandler
// [htmlparser2]: https://github.com/fb55/htmlparser2
import { Parser } from 'htmlparser2';
import { DomHandler, Document as DomDocument, Element, Text } from 'domhandler';
import type { AnyNode, ChildNode, Document, ParentNode } from 'domhandler';
import { sheetConditions } from './css/parse.js';
import type { MediaCondition } from './css/parse.js';

export type { AnyNode, ChildNode, Document, ParentNode } from 'domhandler';
export { Element, Text, Comment } from 'domhandler';

/** Elements whose content is markup-opaque, so the tokenizer stays in raw
 *  text until the matching close tag. htmlparser2 knows these already; the
 *  set is here because the box builder has to skip the same ones. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** Never rendered, whatever the stylesheet says: a `<template>`'s
 *  content is inert, so the box builder makes no box in it and the scan
 *  (`HtmlSource.facts`) does not look inside it. The rest of what has no
 *  box of its own — `<head>` and what is in it, `<script>`, `<style>` — is
 *  `display: none` by the UA sheet, and shown where an author's sheet says
 *  otherwise, as a browser shows it: `head, meta { display: block }` makes
 *  a `<meta>`'s `::before` a line of the page. */
export const NON_RENDERED = new Set(['template']);

/** What the HTML parser puts in `<head>`. Where the markup has no `<head>`
 *  around it, at the top of the document, it is still the head's, which a
 *  browser implies and the UA sheet hides: `* { display: block }` shows no
 *  `<title>` or `<style>` there (`inImpliedHead`). */
const HEAD_CONTENT = new Set([
  'title',
  'meta',
  'link',
  'style',
  'script',
  'base',
  'basefont',
  'bgsound',
  'noframes',
  'noscript',
  'template',
]);

/** What a `<noscript>` in the head keeps of what it holds. With scripting
 *  off HTML's parser takes anything else out of it and into the body
 *  (13.2.6.4.5, "in head noscript"). */
const HEAD_NOSCRIPT = new Set([
  'basefont',
  'bgsound',
  'link',
  'meta',
  'noframes',
  'style',
]);

/** Whether an element is head content with no `<head>` around it: at the
 *  top of the document or right under `<html>`, or in a `<noscript>` there
 *  that keeps it. A `<noscript>` is not, since nothing here runs a script:
 *  the rest of what it holds is what the parser would have put in the
 *  body, and is drawn. */
export function inImpliedHead(el: Element, tag: string): boolean {
  if (!HEAD_CONTENT.has(tag) || tag === 'noscript') return false;
  if (atDocumentTop(el)) return true;
  const parent = el.parent as Element;
  return (
    HEAD_NOSCRIPT.has(tag) &&
    tagOf(parent) === 'noscript' &&
    atDocumentTop(parent)
  );
}

/** Whether an element is at the top of the document or right under
 *  `<html>`: where the head a browser implies would be. Not at the top of
 *  a shadow tree, which has no head. */
function atDocumentTop(el: Element): boolean {
  const parent = el.parent;
  if (parent instanceof ShadowRoot) return false;
  return !parent || !isElement(parent) || tagOf(parent) === 'html';
}

/** An element's tag name, lowercased — htmlparser2 already lowercases in
 *  HTML mode, so this is the assertion rather than the work. An SVG root
 *  under a prefix (`isSvgRoot`) is `svg`, which is what a type selector and
 *  everything else here that asks for the tag sees. */
export function tagOf(node: AnyNode): string {
  if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') {
    return '';
  }
  const name = (node as Element).name.toLowerCase();
  return name.endsWith(':svg') && isSvgRoot(node as Element) ? 'svg' : name;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Whether an element is the root of an SVG drawing. The HTML parser names
 * an inline `<svg>` plainly; XHTML may bind a prefix to the SVG namespace
 * (`<svg:svg xmlns:svg="http://www.w3.org/2000/svg">`), which is the same
 * element to an XML parser, and is honoured where the prefix is declared.
 * Only SVG's: a Word document's `<o:p>` under `xmlns:o` is not a paragraph,
 * to this any more than to a browser reading it as HTML.
 */
export function isSvgRoot(el: Element): boolean {
  const name = el.name.toLowerCase();
  if (name === 'svg') return true;
  if (!name.endsWith(':svg')) return false;
  const declaration = `xmlns:${name.slice(0, -4)}`;
  for (let node: Element | null = el; node;) {
    const bound = node.attribs[declaration];
    if (bound !== undefined) return bound === SVG_NS;
    const parent: ParentNode | null = node.parent;
    node = parent && parent.type === 'tag' ? (parent as Element) : null;
  }
  return false;
}

export function isElement(node: AnyNode | null | undefined): node is Element {
  return (
    !!node &&
    (node.type === 'tag' || node.type === 'script' || node.type === 'style')
  );
}

export function isText(node: AnyNode | null | undefined): node is Text {
  return !!node && node.type === 'text';
}

/** Children of a node, or an empty array for a leaf. Cheaper than domutils'
 *  guard chain on the hot path, and it is the only traversal shape the
 *  styler and the box builder need. */
export function childrenOf(node: AnyNode): ChildNode[] {
  const kids = (node as Partial<ParentNode>).children;
  return kids ?? EMPTY;
}
const EMPTY: ChildNode[] = [];

/** Attribute read, case-insensitively, or `undefined`. */
export function attr(el: Element, name: string): string | undefined {
  return el.attribs?.[name];
}

/** Where an image element's image is: an `<img>`'s `src`, an `<object>`'s
 *  `data` — which is shown as an image when it is one (HTML's "the object
 *  element"), and as the element's fallback content otherwise — an
 *  `<embed>`'s `src` the same, and a `<video>`'s `poster`, the frame it
 *  shows until it plays, which here it does not. An `<img>` that chooses
 *  its source (`choosesSource`) shows what it chose, which this is not. */
export function imageUrlOf(el: Element): string | undefined {
  const tag = tagOf(el);
  return tag === 'object'
    ? attr(el, 'data')
    : tag === 'video'
      ? attr(el, 'poster')
      : attr(el, 'src');
}

/**
 * Whether an `<img>`'s image is chosen rather than named: it has a
 * `srcset`, or a `<picture>` is its parent (HTML's "uses srcset or
 * picture"). One that is neither shows its `src`, at 1x.
 */
export function choosesSource(el: Element): boolean {
  if (tagOf(el) !== 'img') return false;
  if (attr(el, 'srcset') !== undefined) return true;
  const parent = el.parent;
  return !!parent && isElement(parent) && tagOf(parent) === 'picture';
}

/** The text under a node, uncollapsed — what `<style>` hands the CSS parser
 *  and what a `<script>` seam is given. */
export function rawTextOf(node: AnyNode): string {
  if (isText(node)) return node.data;
  let out = '';
  for (const child of childrenOf(node)) out += rawTextOf(child);
  return out;
}

/**
 * Walk elements in document order. The styler, the resource sweep and the
 * script sweep are all one pass over this.
 *
 * An explicit stack, and it has to be: the parser builds a tree of any depth
 * without recursing (htmlparser2 is a state machine), so the first thing to
 * die on a degenerately nested document would otherwise be this walk — and a
 * `yield*` chain is the worst recursion there is, costing a resume per level
 * per element (a walk of 1,000 nested divs measured 16ms as a generator and
 * rounds to zero as a loop).
 *
 * `opaque` names elements the walk yields and does not go into.
 */
export function* elementsIn(
  root: AnyNode,
  opaque?: ReadonlySet<string>,
): Generator<Element> {
  const stack: ChildNode[][] = [childrenOf(root)];
  const at: number[] = [0];
  while (stack.length) {
    const top = stack.length - 1;
    const kids = stack[top];
    const i = at[top];
    if (i >= kids.length) {
      stack.pop();
      at.pop();
      continue;
    }
    at[top] = i + 1;
    const child = kids[i];
    if (!isElement(child)) continue;
    yield child;
    if (opaque?.has(tagOf(child))) continue;
    const grandkids = childrenOf(child);
    if (grandkids.length) {
      stack.push(grandkids);
      at.push(0);
    }
  }
}

/**
 * The element a URL's fragment names in a document, its indicated part
 * (HTML 7.4.6.3, "find a potential indicated element"): the first element
 * in tree order whose id is the fragment, or failing one, the first `<a>`
 * it is the name of — the fragment as written, and then percent-decoded.
 * A shadow tree's ids are its own, and no fragment reaches them. Null for
 * none, and for no fragment.
 */
export function indicatedElement(
  document: AnyNode,
  fragment: string,
): Element | null {
  if (!fragment) return null;
  const find = (name: string): Element | null => {
    let anchor: Element | null = null;
    for (const el of elementsIn(document)) {
      if (attr(el, 'id') === name) return el;
      if (!anchor && tagOf(el) === 'a' && attr(el, 'name') === name) {
        anchor = el;
      }
    }
    return anchor;
  };
  const found = find(fragment);
  if (found) return found;
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return null;
  }
  return decoded === fragment ? null : find(decoded);
}

// --- shadow trees ------------------------------------------------------------
//
// A declarative shadow root (HTML 13.2.6.4.4, "a start tag whose tag name is
// template"; DOM 4.2.2): a `<template shadowrootmode>` that the parser meets
// as the first such child of an element that can host one is no element at
// all — what it holds becomes the element's shadow tree, a tree of its own,
// and the template is in neither. So the DOM here is the one a browser
// builds: the host's `children` are its light children alone, and the
// shadow tree hangs off it (`shadowRootOf`), as `host.shadowRoot` does.
// Everything that walks the document by `children` — the scan, the forms,
// `getElementById`, `:first-child` — stays in the tree it started in, as
// the DOM's own walks do, and what is drawn is the flat tree
// (`flatChildrenOf`): the host's shadow tree in its place, and in each
// `<slot>` the light children assigned to it.

/** Each host's shadow root. */
const SHADOW_ROOTS = new WeakMap<Element, ShadowRoot>();

/** Bumped whenever a tree may have changed: what slot assignment keeps is
 *  good while it holds still (`ShadowRoot._assign`). */
let generation = 0;

/** A tree changed: the parser wrote to it, an application mutated it and
 *  said so, or a shadow root was attached. */
export function treesChanged(): void {
  generation += 1;
}

/** Where `treesChanged` has got to: what was worked out from a tree as it
 *  stood holds while this does (`compileSelector`'s kept answers). */
export function treeGeneration(): number {
  return generation;
}

/** Bumped when an application says it changed a tree (`HtmlSource.touch`),
 *  and not as the parser writes: a stream's next chunk adds to what an
 *  element holds, where a cache of it can see (an inline drawing's own
 *  check), and sets no attribute of an element it made before but a
 *  second `<body>`'s, on the first — where an application may have
 *  changed anything, an attribute or the middle of a drawing. Kept apart
 *  from `generation` so that a cache only an application can make stale
 *  is not thrown away at every chunk. */
let mutations = 0;

/** Where `touch` has got to: what was worked out from an element's
 *  attributes, or from what is under it, holds while this does — the
 *  `var()`s in a shape's presentation attributes, an inline drawing. */
export function mutationGeneration(): number {
  return mutations;
}

/** `shadowrootmode`'s states (HTML 4.12.3), `open` and `closed` — any other
 *  value, or none, is no shadow root, and the template an ordinary one. */
export type ShadowRootMode = 'open' | 'closed';

/**
 * The root of a shadow tree (DOM 4.8): a document of its own, so a walk by
 * `parent` from inside it stops at it, as a selector's does — and its
 * `host`, the element whose boxes it is drawn as.
 *
 * `mode` is kept and changes nothing here: closed keeps a page's scripts
 * out, and this runs none. The application, which is not a script on the
 * page, reaches a closed one as it does an open one (`shadowRootOf`).
 */
export class ShadowRoot extends DomDocument {
  readonly host: Element;
  readonly mode: ShadowRootMode;
  /** `shadowrootdelegatesfocus`. */
  readonly delegatesFocus: boolean;
  private _assignedAt = -1;
  /** The nodes assigned to each slot, in tree order. */
  private _assigned = new Map<Element, ChildNode[]>();
  /** The slot each assigned node is in. */
  private _slots = new Map<ChildNode, Element>();

  constructor(host: Element, mode: ShadowRootMode, delegatesFocus = false) {
    super([]);
    this.host = host;
    this.mode = mode;
    this.delegatesFocus = delegatesFocus;
  }

  /** The nodes assigned to `slot`, in tree order: none where it is no slot
   *  of this tree, or where no light child of the host names it. */
  assignedTo(slot: Element): readonly ChildNode[] {
    this._assign();
    return this._assigned.get(slot) ?? EMPTY;
  }

  /** The slot a light child of the host is assigned to, or null where it
   *  is in none, and so in no box. */
  slotOf(node: ChildNode): Element | null {
    this._assign();
    return this._slots.get(node) ?? null;
  }

  /**
   * Slot assignment (DOM 4.2.2.3, "find slottables"), in "named" mode: each
   * element and text child of the host goes to the first `<slot>` in this
   * tree, in tree order, whose `name` is its `slot` — `''` for a text node
   * and for an element without one, which is the slot with no name. Not a
   * slot in a `<template>`'s content, or in a shadow tree inside this one,
   * which are other trees. Kept until a tree changes (`treesChanged`).
   */
  private _assign(): void {
    if (this._assignedAt === generation) return;
    this._assignedAt = generation;
    this._assigned.clear();
    this._slots.clear();
    let named: Map<string, Element> | null = null;
    for (const el of elementsIn(this, NON_RENDERED)) {
      if (tagOf(el) !== 'slot') continue;
      const name = attr(el, 'name') ?? '';
      named ??= new Map();
      if (!named.has(name)) named.set(name, el);
    }
    if (!named) return;
    for (const child of this.host.children) {
      const name = isElement(child)
        ? (attr(child, 'slot') ?? '')
        : isText(child)
          ? ''
          : null;
      if (name === null) continue;
      const slot = named.get(name);
      if (!slot) continue;
      this._slots.set(child, slot);
      let nodes = this._assigned.get(slot);
      if (!nodes) this._assigned.set(slot, (nodes = []));
      nodes.push(child);
    }
  }
}

/** The shadow root an element hosts, or null — open or closed. */
export function shadowRootOf(el: Element): ShadowRoot | null {
  return SHADOW_ROOTS.get(el) ?? null;
}

/** The elements that may host a shadow root (DOM 4.9, `attachShadow()`):
 *  these, and an autonomous custom element. */
const SHADOW_HOSTS = new Set([
  'article',
  'aside',
  'blockquote',
  'body',
  'div',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'main',
  'nav',
  'p',
  'section',
  'span',
]);

/** The names HTML keeps from custom elements (4.13.2). */
const RESERVED_NAMES = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-src',
  'font-face-uri',
  'font-face-format',
  'font-face-name',
  'missing-glyph',
]);

/** Whether an element can host a shadow root: one of `SHADOW_HOSTS`, or a
 *  name that is a valid custom element name — a lower-case ASCII letter
 *  first, a hyphen somewhere, and no ASCII upper case, white space or
 *  colon (HTML 4.13.2; the parser has lowered the case already). */
export function canHostShadow(el: Element): boolean {
  const name = el.name;
  if (SHADOW_HOSTS.has(name)) return true;
  return (
    name.includes('-') &&
    CUSTOM_ELEMENT_NAME.test(name) &&
    !RESERVED_NAMES.has(name)
  );
}
const CUSTOM_ELEMENT_NAME = /^[a-z][^\s\0/>:A-Z]*$/;

/**
 * Attach a shadow root to `host` (DOM 4.9, `attachShadow()`), for an
 * application building one itself: fill it with `appendChild` and call
 * `refresh()`. Null where the element cannot host one or already does —
 * where a browser would throw.
 */
export function attachShadow(
  host: Element,
  init: { mode: ShadowRootMode; delegatesFocus?: boolean },
): ShadowRoot | null {
  if (SHADOW_ROOTS.has(host) || !canHostShadow(host)) return null;
  const root = new ShadowRoot(host, init.mode, init.delegatesFocus ?? false);
  SHADOW_ROOTS.set(host, root);
  treesChanged();
  return root;
}

/** A `shadowrootmode` attribute's state: its keyword, ASCII
 *  case-insensitively, or null for none. */
function shadowRootMode(value: string | undefined): ShadowRootMode | null {
  if (value === undefined) return null;
  const mode = value.toLowerCase();
  return mode === 'open' || mode === 'closed' ? mode : null;
}

/** The slot a light child of a host is assigned to, or null: where its
 *  parent hosts no shadow tree, or no slot of it takes the child. */
export function assignedSlot(node: ChildNode): Element | null {
  const parent = node.parent;
  if (!isElement(parent)) return null;
  const shadow = SHADOW_ROOTS.get(parent);
  return shadow ? shadow.slotOf(node) : null;
}

/** The shadow root whose tree `node` is in, or null for the document's. */
export function shadowRootAround(node: AnyNode): ShadowRoot | null {
  for (let at = node.parent; at; at = at.parent) {
    if (at instanceof ShadowRoot) return at;
  }
  return null;
}

/**
 * What a node's boxes are made of — its children in the flat tree (CSS
 * Scoping 1, 2.2): a host's shadow tree, in place of its own children; in
 * a `<slot>` of a shadow tree, the light children assigned to it, or its
 * own where none is, its fallback; everywhere else the node's children.
 */
export function flatChildrenOf(node: AnyNode): readonly ChildNode[] {
  if (!isElement(node)) return childrenOf(node);
  const shadow = SHADOW_ROOTS.get(node);
  if (shadow) return shadow.children;
  if (node.name === 'slot') {
    const root = shadowRootAround(node);
    if (root) {
      const assigned = root.assignedTo(node);
      if (assigned.length) return assigned;
    }
  }
  return node.children;
}

/**
 * A node's parent in the flat tree: the host for the top of a shadow
 * tree, the slot a light child of a host is assigned to, and else its
 * parent element. Null at the top of the document, and for a light child
 * no slot takes, which is in no box — and so what a style inherits from,
 * where a pointer's hover reaches and where the focus is within.
 */
export function flatParentOf(node: ChildNode): Element | null {
  const parent = node.parent;
  if (!parent) return null;
  if (parent instanceof ShadowRoot) return parent.host;
  if (!isElement(parent)) return null;
  const shadow = SHADOW_ROOTS.get(parent);
  return shadow ? shadow.slotOf(node) : parent;
}

// --- the streaming source --------------------------------------------------

/** What the document told the host about itself while parsing — none of
 *  it from inside a `<template>`, whose content is inert. */
export interface DocumentFacts {
  /** `<style>` text and `<link rel=stylesheet>` hrefs, in document order —
   *  order is the cascade's tie-breaker, so it is data, not a detail. The
   *  document's alone: a shadow tree's style it and nothing else
   *  (`shadows`). */
  sheets: SheetRef[];
  /** Every shadow tree, in the order the scan meets them, a host's before
   *  those in its own, with its sheets in its order: what each styles is
   *  in it (CSS Scoping 1, 3.2). */
  shadows: { root: ShadowRoot; sheets: SheetRef[] }[];
  /** Every `<script>`, for the seam. Never parsed and never evaluated. */
  scripts: Element[];
  /** Elements with a resource to fetch — `<img>`, and `<link>` above —
   *  in shadow trees as well as in the document. */
  resources: Element[];
  /** The `<img>`s whose image is chosen rather than named — a `srcset`, or
   *  a `<picture>` around them — which are asked for once the viewport
   *  they are chosen for is known (`srcset.ts`), and not with `resources`. */
  pictures: Element[];
  /** `<title>`, when the document had one. */
  title: string | null;
  /** The first `<base>` with an `href`, as written: the document's base URL
   *  wherever in the document it stands (HTML 2.5.3). */
  base: string | null;
}

export type SheetRef = (
  | { kind: 'inline'; text: string; element: Element }
  | { kind: 'link'; href: string; element: Element }
) & {
  /** The conditions its `media` attribute puts the whole sheet under, as
   *  an `@import`'s media queries do: null where it has none, or one that
   *  always holds. */
  media: MediaCondition[] | null;
};

/**
 * A document being parsed. Feed it source; read `document` at any time.
 *
 * `write` is append-only by design: handed a `source` that starts with what
 * was already written, it writes the delta and the existing nodes keep their
 * identity — which is what lets the box tree, the computed styles and the
 * laid-out lines above it survive a streaming append. A `source` that is not
 * an extension resets the parser, because a mid-document edit can change the
 * tree arbitrarily and pretending otherwise is how a streaming renderer
 * shows a document nobody wrote.
 *
 * That delta is available only until the source says it is `complete`: an
 * ended parse cannot be extended, so every later change re-parses. A caller
 * that wants the append path — a stream, a `<Markdown partial>` — keeps
 * `complete` false until the last chunk, which is what the flag is for.
 */
export class HtmlSource {
  /** The tree, live: it grows as chunks are written. */
  document: Document;
  /** Bumped whenever the tree changed — the styler's cache key. */
  revision = 0;
  /** True once `end()` has been called and the tree is final. */
  complete = false;

  private _parser: Parser;
  private _handler: Handler;
  private _written = '';
  private _facts: ScannedFacts = freshFacts();

  constructor() {
    const { parser, handler } = createParser();
    this._parser = parser;
    this._handler = handler;
    this.document = handler.root;
  }

  /** Set the whole source. Appends when it can — an extension of what was
   *  written, into a parser that has not been ended — and re-parses when it
   *  cannot. */
  setSource(source: string, complete: boolean): boolean {
    let changed = false;
    if (source === this._written) {
      changed = false;
    } else if (!this.complete && source.startsWith(this._written)) {
      // The append path is open only while the parser is. `end()` runs the
      // tokenizer's EOF, and htmlparser2 answers any later chunk with
      // `.write() after done!`, so a completed parse re-parses like any other
      // edit. Without the guard the failure landed far from its cause: `<Html
      // partial={false}>` passes `complete` on *every* render, so whether an
      // edit crashed depended on the caret — one in the middle of the document
      // is not a prefix and took the reset path, one at the end was a prefix,
      // took this branch, and threw inside the reconciler's commit.
      this._parser.write(source.slice(this._written.length));
      this._written = source;
      changed = true;
    } else {
      this.reset();
      this._parser.write(source);
      this._written = source;
      changed = true;
    }
    if (complete && !this.complete) {
      this._parser.end();
      this.complete = true;
      changed = true;
    }
    if (changed) {
      this.revision += 1;
      this._facts = freshFacts();
      treesChanged();
    }
    return changed;
  }

  /** Start over — a source that is not an extension of what was written. */
  reset(): void {
    this._parser.reset();
    const { parser, handler } = createParser();
    this._parser = parser;
    this._handler = handler;
    this.document = handler.root;
    this._written = '';
    this.complete = false;
    this._facts = freshFacts();
    treesChanged();
  }

  /** The DOM changed under us — an app mutated it, or a stylesheet arrived
   *  and was spliced in. Anything cached on the old revision is stale. */
  touch(): void {
    this.revision += 1;
    this._facts = freshFacts();
    treesChanged();
    mutations += 1;
  }

  /** Whether the parser has yet to meet an element's end tag. A chunk of a
   *  stream that ends inside a `<script>` leaves it in the tree holding the
   *  text written so far, which is not the script. */
  isOpen(el: Element): boolean {
    return !this.complete && this._handler.isOpen(el);
  }

  /**
   * What the document says about its own resources, scripts and stylesheets.
   * One pass, memoized against `revision`, because all three consumers ask
   * on the same tick and a document of any size is not worth walking thrice.
   */
  facts(): DocumentFacts {
    if (this._facts.scanned === this.revision) return this._facts;
    const facts = freshFacts();
    facts.scanned = this.revision;
    // The document's tree, then each shadow tree as the walk meets its
    // host: a sheet is its own tree's, and a `<title>` or a `<base>` in a
    // shadow tree is not the document's, which a browser looks for in the
    // document's tree alone.
    const trees: { root: ParentNode; sheets: SheetRef[] }[] = [
      { root: this.document, sheets: facts.sheets },
    ];
    for (let i = 0; i < trees.length; i += 1) {
      const { root, sheets } = trees[i];
      const shadow = root instanceof ShadowRoot;
      // Not into a `<template>`: its content is an inert fragment (HTML
      // 4.12.3), out of the document until a script stamps it in, which
      // here none does. A sheet in it styles nothing, an image in it loads
      // nothing, a script in it runs nothing, and its `<title>` and
      // `<base>` are not the document's.
      for (const el of elementsIn(root, NON_RENDERED)) {
        const hosted = SHADOW_ROOTS.get(el);
        if (hosted) {
          const tree = { root: hosted, sheets: [] };
          facts.shadows.push(tree);
          trees.push(tree);
        }
        const tag = tagOf(el);
        if (tag === 'style') {
          // A sheet whose `media` can hold nowhere here, `print`, is left
          // out; any other is under it, as though an `@media` block of it
          // were around all of it (HTML 4.2.6, 4.2.4).
          const media = sheetConditions(attr(el, 'media') ?? '');
          if (media !== false) {
            sheets.push({
              kind: 'inline',
              text: rawTextOf(el),
              element: el,
              media,
            });
          }
        } else if (tag === 'link') {
          const rel = (attr(el, 'rel') ?? '').toLowerCase();
          const href = attr(el, 'href');
          if (href && rel.split(/\s+/).includes('stylesheet')) {
            // One left out is not asked for either. One under a width,
            // `(max-width: 600px)`, is, whatever the width: as a browser
            // asks for it, and as an `@import` under one is asked for.
            const media = sheetConditions(attr(el, 'media') ?? '');
            if (media !== false) {
              sheets.push({ kind: 'link', href, element: el, media });
              facts.resources.push(el);
            }
          }
        } else if (tag === 'script') {
          facts.scripts.push(el);
        } else if (tag === 'img' && choosesSource(el)) {
          facts.pictures.push(el);
        } else if (
          tag === 'img' ||
          tag === 'image' ||
          tag === 'object' ||
          tag === 'embed' ||
          tag === 'video' ||
          (tag === 'input' &&
            (attr(el, 'type') ?? '').trim().toLowerCase() === 'image')
        ) {
          if (imageUrlOf(el)) facts.resources.push(el);
        } else if (shadow) {
          continue;
        } else if (tag === 'title' && facts.title === null) {
          facts.title = rawTextOf(el).trim();
        } else if (tag === 'base' && facts.base === null) {
          const href = attr(el, 'href');
          if (href !== undefined) facts.base = href;
        }
      }
    }
    this._facts = facts;
    return facts;
  }

  /** Release the parser. The tree stays readable — an app may still hold it. */
  destroy(): void {
    this._parser.reset();
    this._handler.onreset?.();
  }
}

interface ScannedFacts extends DocumentFacts {
  /** The revision `facts()` was computed for; -1 until it has been. */
  scanned: number;
}

function freshFacts(): ScannedFacts {
  return {
    sheets: [],
    shadows: [],
    scripts: [],
    resources: [],
    pictures: [],
    title: null,
    base: null,
    scanned: -1,
  };
}

/**
 * domhandler's handler, with the one rule of HTML's tree construction about
 * text that htmlparser2 leaves out: a newline straight after the start tag
 * of a `<pre>`, a `<listing>` or a `<textarea>` is not content (HTML
 * 13.2.6.4.7, "newlines at the start of pre blocks are ignored as an
 * authoring convenience"). Without it every code block written `<pre>` and
 * a line break began with an empty line. A chunk of a stream that ends
 * between the tag and the newline keeps the rule, since the handler does.
 */
class Handler extends DomHandler {
  private _afterPre = false;
  /** A written `<html>` at the top of the document, and the document's
   *  body, written or implied: where HTML's parser puts content the markup
   *  leaves outside them. */
  private _html: Element | null = null;
  private _body: Element | null = null;
  /** Whether a `<template shadowrootmode>` attaches a shadow root, as it
   *  does in a document a browser's parser builds, and not in a fragment
   *  parsed for `innerHTML` (HTML 13.2.6.4.4). */
  declarative = true;

  /** Whether an element is open: its end tag not met yet. */
  isOpen(el: Element): boolean {
    return this.tagStack.includes(el);
  }

  /**
   * Past `MAX_DEPTH` open elements, what is opened goes into the element at
   * that depth rather than into the one open, still open itself so its end
   * tag closes it: Chrome's parser does the same past 512. Everything that
   * walks a document here — the cascade, the box builder, layout, paint —
   * goes a call deeper for each level, and a page of a few hundred unclosed
   * `<div>`s, which a broken generator writes, ran the stack out.
   */
  protected override addNode(node: ChildNode): void {
    const stack = this.tagStack;
    if (stack.length <= MAX_DEPTH) {
      super.addNode(node);
      return;
    }
    const parent = stack[MAX_DEPTH - 1];
    const previous = parent.children[parent.children.length - 1];
    parent.children.push(node);
    if (previous) {
      node.prev = previous;
      previous.next = node;
    }
    node.parent = parent;
    this.lastNode = null;
  }

  /**
   * HTML's parser puts a document's content in a `<body>` whether or not
   * the markup wrote one, and htmlparser2's puts it where it stands. So
   * with a written `<html>`, the first thing that is not head content opens
   * the body it goes in (HTML 13.2.6.4.6, "after head"); without one, a
   * `<body>` written after content takes that content in, which HTML's
   * parser had put in the body it implied; and what comes after the body
   * has ended goes back into it ("after body"), as does a second
   * `<body>`'s attributes. Without it the root box stood in for a body
   * around the `<html>`, and a first paragraph's margin stood below the
   * body's rather than collapsing with it. A fragment — no `<html>`, no
   * `<body>` — is left as it was written, and the root box stands in.
   */
  override onopentag(name: string, attribs: Record<string, string>): void {
    if (name === 'body' && this._body) {
      // a second body is its attributes, on the first; the parser will end
      // it, so what it ends is the body outside one, or else what is open
      for (const key in attribs) this._body.attribs[key] ??= attribs[key];
      const stack = this.tagStack;
      if (this._outsideBody()) this._reopen();
      else stack.push(stack[stack.length - 1]);
      this._afterPre = false;
      return;
    }
    if (this._outsideBody()) {
      if (this._body) {
        if (name !== 'html') this._reopen();
      } else if (this._html && inBody(name)) this._reopen();
    }
    if (name === 'template' && this._shadowRoot(attribs)) return;
    super.onopentag(name, attribs);
    const opened = this.tagStack[this.tagStack.length - 1] as Element;
    if (name === 'html' && !this._html && opened.parent === this.root) {
      this._html = opened;
    } else if (name === 'body' && !this._body) {
      if (opened.parent === this._html) this._body = opened;
      else if (!this._html && opened.parent === this.root) {
        this._body = opened;
        this._adopt(opened);
      }
    }
    this._afterPre =
      name === 'pre' || name === 'listing' || name === 'textarea';
  }

  /**
   * A `<template shadowrootmode>` that the element open can host a shadow
   * root from, where it hosts none yet: the shadow root takes the
   * template's place on the stack, so what the template holds goes into it
   * and its end tag closes it, and the template is in no tree (HTML
   * 13.2.6.4.4). True where it did. Any other template is one, inert: a
   * second one, one under an element that hosts none — an `<img>`, the
   * `<html>` — and one in a fragment.
   */
  private _shadowRoot(attribs: Record<string, string>): boolean {
    if (!this.declarative) return false;
    const mode = shadowRootMode(attribs.shadowrootmode);
    if (!mode) return false;
    const stack = this.tagStack;
    const host = stack[stack.length - 1];
    if (
      stack.length > MAX_DEPTH ||
      !isElement(host) ||
      SHADOW_ROOTS.has(host) ||
      !canHostShadow(host)
    ) {
      return false;
    }
    const delegates = attribs.shadowrootdelegatesfocus !== undefined;
    const root = new ShadowRoot(host, mode, delegates);
    SHADOW_ROOTS.set(host, root);
    treesChanged();
    stack.push(root);
    this.lastNode = null;
    this._afterPre = false;
    return true;
  }

  /** Whether what is open is the top of the document, or the written
   *  `<html>`: where content is outside any body. */
  private _outsideBody(): boolean {
    const top = this.tagStack[this.tagStack.length - 1];
    return top === this.root || (top === this._html && top !== null);
  }

  /** Open the `<html>` and its body again, or the body for the first time.
   *  The parser never saw them open, so it closes them in the place of what
   *  it did open — which is where they would end anyway. */
  private _reopen(): void {
    const stack = this.tagStack;
    if (stack[stack.length - 1] === this.root && this._html) {
      stack.push(this._html);
    }
    if (this._body) stack.push(this._body);
    else {
      super.onopentag('body', {});
      this._body = stack[stack.length - 1] as Element;
    }
    this.lastNode = null;
  }

  /** Move into a `<body>` written at the top of the document what went
   *  before it there from the first thing that is not head content on. */
  private _adopt(body: Element): void {
    const kids = this.root.children;
    const end = kids.length - 1;
    let start = 0;
    while (start < end && !startsBody(kids[start])) start += 1;
    if (start === end) return;
    const moved = kids.splice(start, end - start);
    const before = kids[start - 1] ?? null;
    body.prev = before;
    if (before) before.next = body;
    moved[0].prev = null;
    moved[moved.length - 1].next = null;
    for (const node of moved) node.parent = body;
    body.children.unshift(...moved);
    if (body.children.length > moved.length) {
      const first = body.children[moved.length];
      first.prev = moved[moved.length - 1];
      moved[moved.length - 1].next = first;
    }
  }

  override onclosetag(): void {
    this._afterPre = false;
    super.onclosetag();
  }

  override oncomment(data: string): void {
    this._afterPre = false;
    super.oncomment(data);
  }

  override ontext(data: string): void {
    if (
      (this._html || this._body) &&
      NOT_SPACE.test(data) &&
      this._outsideBody()
    ) {
      this._reopen();
    }
    if (this._afterPre) {
      this._afterPre = false;
      const skip = data.startsWith('\r\n') ? 2 : data.startsWith('\n') ? 1 : 0;
      if (skip) {
        if (data.length === skip) return;
        data = data.slice(skip);
      }
    }
    super.ontext(data);
  }
}

/** How deep a document's elements nest (`Handler.addNode`). */
const MAX_DEPTH = 256;

/** Text that is not all the white space HTML's parser leaves in the head. */
const NOT_SPACE = /[^ \t\n\f\r]/;

/** Whether an element opened before the body goes in the body HTML's
 *  parser implies, rather than in the head or the `<html>` itself. */
function inBody(name: string): boolean {
  return (
    name !== 'body' &&
    name !== 'frameset' &&
    name !== 'head' &&
    name !== 'html' &&
    !HEAD_CONTENT.has(name)
  );
}

/** Whether a node at the top of a document is where HTML's parser would
 *  have opened the body: an element that goes in one, or text. */
function startsBody(node: ChildNode): boolean {
  if (node instanceof Element) return inBody(node.name);
  return node instanceof Text && NOT_SPACE.test(node.data);
}

function createParser(declarative = true): {
  parser: Parser;
  handler: Handler;
} {
  const handler = new Handler(null, {
    // Positions cost time and memory per node and nothing here reads them.
    withStartIndices: false,
    withEndIndices: false,
  });
  handler.declarative = declarative;
  const parser = new DocumentParser(handler, {
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    // HTML closes an element written `<x/>` only where it is void, and so
    // closed anyway, or in SVG or MathML (HTML 13.2.6.5, "acknowledge the
    // self-closing flag"). A `<div/>` or an `<a href="" /*target="_blank"*/>`
    // — melbcss.com's, a comment that is no comment in a tag — opens an
    // element like any other, and closing it left the link's text outside
    // the link.
    recognizeSelfClosing: false,
    decodeEntities: true,
  });
  return { parser, handler };
}

/**
 * htmlparser2's parser, deciding a `/>` from the context its tag was read
 * in, as HTML's does. htmlparser2 decides from the context the tag opens,
 * and an integration point — SVG's `<title>`, `<desc>` and
 * `<foreignObject>`, MathML's `<mi>` and its kin — opens an HTML one, so
 * an `<svg><title/><path/>` took its path into the title.
 */
class DocumentParser extends Parser {
  private _foreignTag = false;
  private _acknowledging = false;

  override isInForeignContext(): boolean {
    return this._acknowledging || super.isInForeignContext();
  }

  override onopentagname(start: number, endIndex: number): void {
    this._foreignTag = this.isInForeignContext();
    super.onopentagname(start, endIndex);
  }

  override onselfclosingtag(endIndex: number): void {
    this._acknowledging = this._foreignTag;
    try {
      super.onselfclosingtag(endIndex);
    } finally {
      this._acknowledging = false;
    }
  }
}

// --- mutation ---------------------------------------------------------------
//
// domhandler's nodes carry `parent`/`prev`/`next` as well as `children`, so a
// splice has four links to keep straight and getting one wrong corrupts the
// traversal rather than throwing. These are the three operations the renderer
// itself performs (splicing a fetched stylesheet in, replacing an `<img>`'s
// box, dropping a subtree) and the ones an app most often wants; anything
// else is `domutils`, which speaks this same tree.

/** Append `child` to `parent`, unlinking it from wherever it was. */
export function appendChild(parent: ParentNode, child: ChildNode): void {
  removeNode(child);
  treesChanged();
  const kids = parent.children;
  const last = kids[kids.length - 1] ?? null;
  if (last) last.next = child;
  child.prev = last;
  child.next = null;
  child.parent = parent;
  kids.push(child);
}

/** Unlink a node from its parent. Safe on a node that has none. */
export function removeNode(node: ChildNode): void {
  treesChanged();
  const parent = node.parent;
  if (parent) {
    const kids = parent.children;
    const at = kids.indexOf(node);
    if (at >= 0) kids.splice(at, 1);
  }
  if (node.prev) node.prev.next = node.next;
  if (node.next) node.next.prev = node.prev;
  node.prev = null;
  node.next = null;
  node.parent = null;
}

/** Replace `node` with `next`, in place. */
export function replaceNode(node: ChildNode, next: ChildNode): void {
  const parent = node.parent;
  if (!parent) return;
  treesChanged();
  const kids = parent.children;
  const at = kids.indexOf(node);
  removeNode(next);
  next.parent = parent;
  next.prev = node.prev;
  next.next = node.next;
  if (node.prev) node.prev.next = next;
  if (node.next) node.next.prev = next;
  if (at >= 0) kids[at] = next;
  node.prev = null;
  node.next = null;
  node.parent = null;
}

/** Build an element, for an app writing into the document. */
export function createElement(
  name: string,
  attribs: Record<string, string> = {},
  children: ChildNode[] = [],
): Element {
  const el = new Element(name.toLowerCase(), attribs, []);
  for (const child of children) appendChild(el, child);
  return el;
}

/** Build a text node. */
export function createText(data: string): Text {
  return new Text(data);
}

/** Parse a fragment into nodes an app can splice in — `innerHTML`, without
 *  the element to hang it off, and like it, with a `<template
 *  shadowrootmode>` left a template: `attachShadow` makes a shadow root.
 *  Not streaming: a fragment is small by definition, and an app calling
 *  this already has the whole string. */
export function parseFragment(html: string): ChildNode[] {
  const { parser, handler } = createParser(false);
  parser.write(html);
  parser.end();
  const kids = handler.root.children.slice();
  for (const kid of kids) {
    kid.parent = null;
    kid.prev = null;
    kid.next = null;
  }
  return kids;
}

/** Whether a tag's content is raw text — the box builder skips these, and
 *  `<textarea>`'s value comes from it rather than from a child box. */
export function isRawText(tag: string): boolean {
  return RAW_TEXT.has(tag);
}
