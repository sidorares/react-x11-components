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

/** The same, where the host runs the document's scripts: a `<noscript>`'s
 *  content is then no part of what is rendered either (HTML 4.12.2), so
 *  the scan asks for none of its images or sheets and hands over none of
 *  its scripts (`HtmlSource.scripting`). */
const NON_RENDERED_SCRIPTING = new Set(['template', 'noscript']);

/** The MIME types a classic script is (HTML 4.12.1.1, "JavaScript MIME
 *  type essence match"), and no type at all. */
const CLASSIC_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

/** Whether a `<script>`'s `type`, lower-cased, its parameters left out,
 *  is a classic script's. */
export function isClassicScriptType(type: string): boolean {
  return CLASSIC_TYPES.has(type.split(';')[0].trim().toLowerCase());
}

/**
 * Whether the parser waits at a `<script>` it has just closed until the
 * script has run (HTML 13.2.6.4.8, "an end tag whose tag name is
 * script"): a classic script, inline or with a `src` that is neither
 * `async` nor `defer` — a parser-blocking script — that a browser with
 * modules runs, so with no `nomodule`, and that is the document's to run,
 * in no `<template>` and, where scripts run, in no `<noscript>`, which
 * the scan hands no script in either (`HtmlSource.facts`). A module, an
 * import map, a deferred or an `async` script is no reason to wait.
 */
export function blocksParser(el: Element, scripting: boolean): boolean {
  if (el.name !== 'script') return false;
  const { attribs } = el;
  if (!isClassicScriptType(attribs.type ?? 'text/javascript')) return false;
  if (attribs.nomodule !== undefined) return false;
  if (
    attribs.src !== undefined &&
    (attribs.async !== undefined || attribs.defer !== undefined)
  ) {
    return false;
  }
  for (let at: AnyNode | null = el.parent; at;) {
    if (at instanceof ShadowRoot) {
      at = at.host;
      continue;
    }
    if (at instanceof Element) {
      if (at.name === 'template' || (scripting && at.name === 'noscript')) {
        return false;
      }
    }
    at = at.parent;
  }
  return true;
}

/** The `<link>`s and `<style>`s a document's parser made, which alone are
 *  style sheets that hold a script back (HTML 4.2.4, "a style sheet that is
 *  blocking scripts", whose element was "created by that Document's
 *  parser") — one written by a parser-blocking script's `document.write`
 *  among them, and none a script put in with the DOM. */
const PARSER_SHEETS = new WeakSet<Element>();

/** Whether a document's parser made a `<link>` or a `<style>`. */
export function madeByParser(el: Element): boolean {
  return PARSER_SHEETS.has(el);
}

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

/** Whether an element is an `<input>` that is a button with a label of its
 *  own: a submit, a reset or a plain button — not an image button, which
 *  is its picture. */
export function isInputButton(el: Element): boolean {
  if (el.name !== 'input' && tagOf(el) !== 'input') return false;
  const type = (attr(el, 'type') ?? '').trim().toLowerCase();
  return type === 'submit' || type === 'reset' || type === 'button';
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
 * Whether a `<link>` preloads a sheet (`rel=preload as=style`, HTML
 * 4.6.7.12): asked for as a sheet is, and told a `load` or an `error` as
 * that settles. A page waits on these: React's commit of a `precedence`
 * sheet waits for the sheet's preload, and loadCSS turns a preload into a
 * sheet from its `onload`. A preload of anything else is asked for nothing,
 * as before: what nothing waits on is not worth fetching ahead of whatever
 * the page asks for it.
 */
export function isStylePreload(el: Element): boolean {
  if (tagOf(el) !== 'link' || !attr(el, 'href')) return false;
  const rel = (attr(el, 'rel') ?? '').toLowerCase().split(/\s+/);
  if (!rel.includes('preload') || rel.includes('stylesheet')) return false;
  if (sheetConditions(attr(el, 'media') ?? '') === false) return false;
  return (attr(el, 'as') ?? '').trim().toLowerCase() === 'style';
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

/**
 * A change an application made to the tree, shaped as a `MutationObserver`
 * reports one (DOM 4.3.3), so a host that keeps records for one hands the
 * same list to `refresh` (`HtmlHandle.refresh`):
 *
 *  - `attributes`: an attribute of `target` was set or removed. `oldValue`
 *    is what it was, `null` for none; left out, a change of `class` or
 *    `id` is taken for one of every class or id a selector tests.
 *  - `childList`: nodes were added to `target`, or taken out of it — every
 *    one of them, which is how a `<style>` or a `<link>` coming or going
 *    is found. `previousSibling` and `nextSibling` are the nodes either
 *    side of where they were, as a record has them; left out, the change
 *    is taken for one anywhere among `target`'s children.
 *  - `characterData`: a text's or a comment's data changed.
 */
export type HtmlChange =
  | {
      type: 'attributes';
      target: Element;
      attributeName: string;
      oldValue?: string | null;
    }
  | {
      type: 'childList';
      target: ParentNode;
      addedNodes: readonly AnyNode[];
      removedNodes: readonly AnyNode[];
      previousSibling?: AnyNode | null;
      nextSibling?: AnyNode | null;
    }
  | { type: 'characterData'; target: AnyNode };

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
  /** `shadowrootcustomelementregistry`: a declarative root whose custom
   *  element registry is null until a page's script initializes one
   *  (HTML 4.13.4, scoped registries), where any other is the document's. */
  registryNull = false;
  /** `clonable` and `serializable` (DOM 4.2.2.4, 4.9): whether a clone of
   *  the host takes a copy of this tree, and whether `getHTML()` writes
   *  it. A declarative root is clonable where its template said so. */
  clonable = false;
  serializable = false;
  /** Made by the parser and not yet taken by a script's `attachShadow()`,
   *  which hands such a root back emptied rather than refusing the host
   *  (DOM 4.9, "attach a shadow root", step 4). */
  declarative = false;
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

/** The elements the parser made with a `customelementregistry` attribute,
 *  whose custom element registry is null, as is what the parser makes in
 *  them (HTML's scoped registries, "create an element for a token"). The
 *  attribute set later changes nothing, so the mark is the parser's. */
const NULL_REGISTRY = new WeakSet<Element>();

/** Whether the parser made an element with `customelementregistry`. */
export function parsedWithNullRegistry(el: Element): boolean {
  return NULL_REGISTRY.has(el);
}

/** An element another parser made — the XML parser a frame's XHTML is
 *  read with (HTML 14.2, which creates each element as this one's tree
 *  builder does) — marked as this one marks it, where its markup wrote
 *  `customelementregistry`. */
export function markParsedRegistry(el: Element): void {
  if (el.attribs.customelementregistry === undefined) return;
  NULL_REGISTRY.add(el);
  nullRegistriesParsed = true;
}

/** Whether the parser has made anything whose registry is null — an
 *  element with `customelementregistry` or a root with
 *  `shadowrootcustomelementregistry` — in any document. */
let nullRegistriesParsed = false;
export function parsedNullRegistries(): boolean {
  return nullRegistriesParsed;
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

/** Whether an element can host a shadow root: one of `SHADOW_HOSTS`, or an
 *  autonomous custom element's. */
export function canHostShadow(el: Element): boolean {
  return SHADOW_HOSTS.has(el.name) || isCustomElementName(el.name);
}

/** Whether a name is a valid custom element name — a lower-case ASCII
 *  letter first, a hyphen somewhere, and no ASCII upper case, white space
 *  or colon — and none HTML keeps for itself (4.13.2; the parser has
 *  lowered the case already). */
export function isCustomElementName(name: string): boolean {
  return (
    name.includes('-') &&
    CUSTOM_ELEMENT_NAME.test(name) &&
    !RESERVED_NAMES.has(name)
  );
}
const CUSTOM_ELEMENT_NAME = /^[a-z][^\s\0/>:A-Z]*$/;

// --- custom elements ------------------------------------------------------------
//
// A page's custom elements are its scripts' (HTML 4.13): the registry, an
// element's state and its reactions are the script engine's
// (`scripts/dom.ts`). What a stylesheet reads of them is `:defined`, and that
// is this: the elements the engine upgraded or made from a definition, and
// every element that was never to be a custom element.

/** The elements a page's scripts made custom elements of. */
const CUSTOMIZED = new WeakSet<Element>();

/** An element made a custom element: its definition's constructor ran. */
export function markCustomized(el: Element): void {
  CUSTOMIZED.add(el);
}

/** Whether an element is a custom element: `markCustomized`. */
export function isCustomized(el: Element): boolean {
  return CUSTOMIZED.has(el);
}

// --- the top layer --------------------------------------------------------------
//
// A dialog a page's scripts opened with `showModal()` is modal (HTML
// 4.11.4.2) and in its document's top layer (CSS Position 4, 3.1): drawn
// over every stacking context, with a `::backdrop` under it, and the rest of
// the document inert. A popover its scripts showed (HTML 6.12) is in the
// top layer too, and blocks nothing. Which elements those are is the script
// engine's to say (`scripts/dom.ts`, the `modal` and `popoverOpen` ops);
// what reads it is `:modal` and `:popover-open`, the cascade's top-layer
// style (`overlay`), the box tree's order and the focus. A document with no
// scripts opens no dialog or popover that way.

/** Each document's top layer, in the order its elements went in: by the
 *  node at the top of the document, which a shadow tree's host leads up
 *  to. */
const TOP_LAYERS = new WeakMap<AnyNode, Element[]>();
/** What an element is in a top layer as: a modal dialog, a popover, or
 *  the document's fullscreen element. */
type TopLayerKind = 'modal' | 'popover' | 'fullscreen';
/** Each element in a top layer: when it went in, counted across
 *  documents, the top of the document whose layer it is in, and what it
 *  is there as. */
const IN_TOP_LAYER = new WeakMap<
  Element,
  { order: number; top: AnyNode; kind: TopLayerKind }
>();
let topLayerCount = 0;
const NO_ELEMENTS: readonly Element[] = [];

/** The node at the top of the tree a node is in, through the hosts of the
 *  shadow trees it is in: the document, or a subtree taken out of it. */
function topOf(node: AnyNode): AnyNode {
  let at = node;
  for (;;) {
    const parent: AnyNode | null =
      at.parent ?? (at instanceof ShadowRoot ? at.host : null);
    if (!parent) return at;
    at = parent;
  }
}

/** Make an element modal and the last of its document's top layer, or
 *  neither (`HTMLDialogElement`'s `showModal()` and `close()`, and its
 *  removal from the document). False where nothing changed. */
export function setModal(el: Element, modal: boolean): boolean {
  const was = IN_TOP_LAYER.get(el);
  if (modal) return !was && enterTopLayer(el, 'modal');
  return was?.kind === 'modal' && leaveTopLayer(el);
}

/** Each showing popover's implicit anchor element (HTML 6.12, "show
 *  popover"): the element that showed it — its `popovertarget` button, or
 *  `showPopover()`'s `source` — which a `position-anchor: auto` anchors it
 *  to (CSS Anchor Positioning 1, 2.2). */
const IMPLICIT_ANCHORS = new WeakMap<Element, Element>();

/** Show an element as a popover, last of its document's top layer, with
 *  `source` its implicit anchor element, or hide one, which leaves it none
 *  (HTML 6.12, "show popover" and "hide popover", and its removal from the
 *  document). False where nothing changed. */
export function setPopoverOpen(
  el: Element,
  open: boolean,
  source: Element | null = null,
): boolean {
  const was = IN_TOP_LAYER.get(el);
  if (open) {
    if (was) return false;
    if (source) IMPLICIT_ANCHORS.set(el, source);
    return enterTopLayer(el, 'popover');
  }
  if (was?.kind !== 'popover') return false;
  IMPLICIT_ANCHORS.delete(el);
  return leaveTopLayer(el);
}

/** A popover's implicit anchor element (`setPopoverOpen`), or null: one
 *  shown with no source, or not showing. */
export function implicitAnchorOf(el: Element): Element | null {
  return IMPLICIT_ANCHORS.get(el) ?? null;
}

/** Make an element its document's fullscreen element, last of its top
 *  layer, or take it out (Fullscreen 2, `requestFullscreen()` and
 *  `exitFullscreen()`, and its removal from the document). False where
 *  nothing changed. */
export function setFullscreen(el: Element, on: boolean): boolean {
  const was = IN_TOP_LAYER.get(el);
  if (on) return !was && enterTopLayer(el, 'fullscreen');
  return was?.kind === 'fullscreen' && leaveTopLayer(el);
}

/** Whether `:fullscreen` matches an element (Fullscreen 2, 4). */
export function isFullscreen(el: Element): boolean {
  return IN_TOP_LAYER.get(el)?.kind === 'fullscreen';
}

function enterTopLayer(el: Element, kind: TopLayerKind): boolean {
  const top = topOf(el);
  let layer = TOP_LAYERS.get(top);
  if (!layer) TOP_LAYERS.set(top, (layer = []));
  layer.push(el);
  IN_TOP_LAYER.set(el, { order: (topLayerCount += 1), top, kind });
  return true;
}

function leaveTopLayer(el: Element): boolean {
  const was = IN_TOP_LAYER.get(el)!;
  IN_TOP_LAYER.delete(el);
  // the document's layer, wherever the element is now
  const layer = TOP_LAYERS.get(was.top);
  const i = layer ? layer.indexOf(el) : -1;
  if (i >= 0) layer!.splice(i, 1);
  if (layer && !layer.length) TOP_LAYERS.delete(was.top);
  return true;
}

/** Whether `:modal` matches an element: a dialog `showModal()` opened and
 *  nothing has closed or taken out of the document since. */
export function isModal(el: Element): boolean {
  return IN_TOP_LAYER.get(el)?.kind === 'modal';
}

/** Each document's active view transition, by its types (CSS View
 *  Transitions 1, 3.3): what `:active-view-transition` and
 *  `:active-view-transition-type()` match its root element by. */
const ACTIVE_TRANSITIONS = new WeakMap<AnyNode, ReadonlySet<string>>();

/** A document's active view transition begun, its types changed — or, for
 *  null, it ended. Whether that changed what its root matches. */
export function setActiveTransition(
  doc: AnyNode,
  types: readonly string[] | null,
): boolean {
  const was = ACTIVE_TRANSITIONS.get(doc);
  if (!types) {
    ACTIVE_TRANSITIONS.delete(doc);
    return !!was;
  }
  const next = new Set(types);
  ACTIVE_TRANSITIONS.set(doc, next);
  return !was || was.size !== next.size || [...next].some((t) => !was.has(t));
}

/** Whether `:active-view-transition` matches an element — its document's
 *  root, while a view transition is active — and, given types, whether
 *  `:active-view-transition-type()` does: the transition has one of them. */
export function inActiveTransition(
  el: Element,
  types: readonly string[] | null = null,
): boolean {
  const doc = el.parent;
  if (!doc || doc.parent || doc.type !== 'root') return false;
  if (doc instanceof ShadowRoot) return false;
  const active = ACTIVE_TRANSITIONS.get(doc);
  if (!active) return false;
  return !types || types.some((t) => active.has(t));
}

/** Whether `:popover-open` matches an element: one shown as a popover and
 *  not hidden or taken out of the document since. */
export function isPopoverOpen(el: Element): boolean {
  return IN_TOP_LAYER.get(el)?.kind === 'popover';
}

/** The controls whose picker is open: a `<select>`'s menu, down. */
const PICKER_OPEN = new WeakSet<Element>();

/** A control's picker opened or shut, as its widget says (`useForms`):
 *  whether that changed what `:open` answers for it. */
export function setPickerOpen(el: Element, open: boolean): boolean {
  if (PICKER_OPEN.has(el) === open) return false;
  if (open) PICKER_OPEN.add(el);
  else PICKER_OPEN.delete(el);
  return true;
}

/** Whether a control's picker is open (HTML's `:open`, 16.6.1): a
 *  `<select>` whose drop-down box is down. */
export function isPickerOpen(el: Element): boolean {
  return PICKER_OPEN.has(el);
}

/** Whether a `<select>` is a drop-down box, which has a picker to open, and
 *  not a list box (HTML 4.10.7: no `multiple`, and a display size of 1). */
export function isDropDown(el: Element): boolean {
  if (el.name !== 'select' || el.attribs.multiple !== undefined) return false;
  const size = el.attribs.size;
  return size === undefined || !(parseInt(size, 10) > 1);
}

/** What a page's scripts set a media element's `muted` to, from the first
 *  time they do; the `muted` attribute only starts it (HTML 4.8.11.12). */
const MUTED = new WeakMap<Element, boolean>();

/** A media element's `muted`, as a page's script set it: whether it
 *  changed. */
export function setMuted(el: Element, muted: boolean): boolean {
  const was = isMuted(el);
  MUTED.set(el, muted);
  return was !== muted;
}

/** Whether an `<audio>` or a `<video>` is muted (`:muted`, Selectors 4,
 *  12.3): what a script set, or its `muted` attribute. */
export function isMuted(el: Element): boolean {
  if (el.name !== 'video' && el.name !== 'audio') return false;
  return MUTED.get(el) ?? el.attribs.muted !== undefined;
}

/** What a page's scripts made a media element's `paused`: `play()`,
 *  `pause()` and `load()` (HTML 4.8.11.8). */
const PAUSED = new WeakMap<Element, boolean>();

/** A media element's `paused`, as a page's script set it: whether it
 *  changed. */
export function setPaused(el: Element, paused: boolean): boolean {
  const was = isPaused(el);
  PAUSED.set(el, paused);
  return was !== paused;
}

/** Whether an `<audio>` or a `<video>` is paused (`:paused`, Selectors 4,
 *  12.2): what a script made it, or paused but for one with `autoplay`,
 *  which the player plays from the start. Not a media element: neither
 *  `:paused` nor `:playing`. */
export function isPaused(el: Element): boolean | null {
  if (el.name !== 'video' && el.name !== 'audio') return null;
  return PAUSED.get(el) ?? el.attribs.autoplay === undefined;
}

/** What a page's media element is doing as it loads and plays (HTML
 *  4.8.11.6, 4.8.11.9): seeking, buffering — playing with too little to
 *  go on — and stalled, buffering with nothing arriving. */
export type MediaFlag = 'seeking' | 'buffering' | 'stalled';
const MEDIA_FLAGS = new WeakMap<Element, Set<MediaFlag>>();

/** One of a media element's flags, as its page's script engine worked it
 *  out: whether it changed. */
export function setMediaFlag(
  el: Element,
  flag: MediaFlag,
  on: boolean,
): boolean {
  let flags = MEDIA_FLAGS.get(el);
  if (!flags) {
    if (!on) return false;
    flags = new Set();
    MEDIA_FLAGS.set(el, flags);
  }
  if (flags.has(flag) === on) return false;
  if (on) flags.add(flag);
  else flags.delete(flag);
  return true;
}

/** Whether a media element is seeking, buffering or stalled
 *  (`:seeking`, `:buffering`, `:stalled`, Selectors 4, 12.2): none of
 *  them where nothing loads it. */
export function hasMediaFlag(el: Element, flag: MediaFlag): boolean {
  return MEDIA_FLAGS.get(el)?.has(flag) ?? false;
}

/** Whether an element is in its document's top layer, as either. */
export function inTopLayer(el: Element): boolean {
  return IN_TOP_LAYER.has(el);
}

/** Where an element went into its document's top layer: a later one is
 *  drawn over an earlier one. 0 for one that is in none. */
export function topLayerOrder(el: Element): number {
  return IN_TOP_LAYER.get(el)?.order ?? 0;
}

/** The elements of a document's top layer, first in first, by any node of
 *  the document — none for one with an empty layer. */
export function topLayerOf(node: AnyNode): readonly Element[] {
  return TOP_LAYERS.get(topOf(node)) ?? NO_ELEMENTS;
}

/**
 * Whether a modal dialog blocks an element (HTML 6.3, "blocked by a modal
 * dialog"): its document has one in its top layer, and the element is not
 * in the last of them, in the flat tree. Such an element is inert — no
 * focusable area, and nothing a press reaches.
 */
export function blockedByModal(el: Element): boolean {
  const layer = topLayerOf(el);
  if (!layer.length) return false;
  // the last modal dialog: a popover in the layer blocks nothing
  let blocker: Element | null = null;
  for (let i = layer.length - 1; i >= 0 && !blocker; i -= 1) {
    if (isModal(layer[i])) blocker = layer[i];
  }
  if (!blocker) return false;
  for (let at: Element | null = el; at; at = flatParentOf(at)) {
    if (at === blocker) return false;
  }
  return true;
}

/** The elements in a top layer that are `node` or in it, which its
 *  removal from the document takes out of the layer (HTML 4.11.4, the
 *  dialog's removing steps): the layer of the document `node` is in, or
 *  the one it was taken out of. */
export function topLayerIn(
  node: AnyNode,
  layer: readonly Element[] = topLayerOf(node),
): Element[] {
  if (!layer.length) return [];
  return layer.filter((el) => {
    for (let at: AnyNode | null = el as AnyNode; at;) {
      if (at === node) return true;
      at = at.parent ?? (at instanceof ShadowRoot ? at.host : null);
    }
    return false;
  });
}

/**
 * Whether `:defined` matches an element (HTML 4.16.3): an element whose
 * custom element state is "uncustomized" or "custom". One whose name is a
 * custom element's, or that was given an `is`, is "undefined" until a
 * definition upgrades it, and with no scripts, which define nothing, it
 * stays so, as a browser with scripting off has it.
 */
export function isDefinedElement(el: Element): boolean {
  if (CUSTOMIZED.has(el)) return true;
  // made in another namespace, or none (`''`): never a custom element
  if (el.namespace !== undefined && el.namespace !== HTML_NAMESPACE) {
    return true;
  }
  return !(isCustomElementName(el.name) || el.attribs.is !== undefined);
}
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * Attach a shadow root to `host` (DOM 4.9, `attachShadow()`), for an
 * application building one itself: fill it with `appendChild` and call
 * `refresh()`. Null where the element cannot host one or already does —
 * where a browser would throw.
 */
export function attachShadow(
  host: Element,
  init: {
    mode: ShadowRootMode;
    delegatesFocus?: boolean;
    clonable?: boolean;
    serializable?: boolean;
  },
): ShadowRoot | null {
  if (SHADOW_ROOTS.has(host) || !canHostShadow(host)) return null;
  const root = new ShadowRoot(host, init.mode, init.delegatesFocus ?? false);
  root.clonable = !!init.clonable;
  root.serializable = !!init.serializable;
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
  /** Elements with a resource to fetch — `<img>`, and `<link>` above, a
   *  sheet's preload among them (`isStylePreload`) — in shadow trees as
   *  well as in the document. */
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
  /** Every inline drawing, an `<svg>` in no other, in the document's tree:
   *  what one names by an id — a sprite's symbol, a gradient — may come in
   *  a stream's later chunk (`HtmlViewNode._parsedChanges`). */
  drawings: Element[];
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
 *
 * Where it `yields`, the parse stops after the end tag of each script that
 * blocks the parser (`blocksParser`) and waits there — `held` — until the
 * host has run it and says to go on (`resume`), as HTML's parser waits for
 * a parser-blocking script (13.2.6.4.8). What the script writes with
 * `document.write` meanwhile goes into the input stream at the insertion
 * point, straight after the script and after what it wrote before, and is
 * parsed there and then (`write`). The source is handed to the parser a
 * piece at a time, each ending with the `>` of a `</script` (`pieceEnd`),
 * so the parser has read no further than the script it stops at: the rest
 * is not in the tree yet, which is what a script that runs there sees.
 */
export class HtmlSource {
  /** The tree, live: it grows as chunks are written. */
  document: Document;
  /** Bumped whenever the tree changed — the styler's cache key. */
  revision = 0;
  /** True once `end()` has been called and the tree is final. */
  complete = false;
  /** Whether the host runs the document's scripts: the scan then skips
   *  what a `<noscript>` holds. Set with `setScripting`, which scans again. */
  scripting = false;
  /** Whether the parse waits at each script that blocks the parser until
   *  the host has run it (see the class). Set with `setYields`. */
  yields = false;
  /** The script the parse waits at: closed, and not yet run. */
  held: Element | null = null;

  private _parser: Parser;
  private _handler: Handler;
  private _written = '';
  private _facts: ScannedFacts = freshFacts();
  /** Whether `document` is a tree handed over (`adopt`), which nothing is
   *  written to here. */
  private _adopted = false;
  /** Where the parse yields: the source as the input stream has it, how far
   *  into it the parser has read, and whether the source given has ended
   *  (`complete`), which the parse does once it has read all of it. */
  private _input = '';
  private _inputAt = 0;
  private _ending = false;
  /** What `document.write` put in the input stream that the parser has
   *  not read yet, ahead of the rest of `_input`, and the insertion point
   *  in it: where what the script writes next goes (HTML 13.2.4.3). */
  private _ahead = '';
  private _insertion = 0;
  /** A script that blocks the parser, which what the held one wrote closed:
   *  it is held next, before the parse goes on (HTML's "pending
   *  parsing-blocking script"). */
  private _pending: Element | null = null;
  /** The script that blocks the parser the last `_feed` stopped after. */
  private _stopped: Element | null = null;
  /** What the parser made since `takeMade` was last asked, from the first
   *  script it waited at on: null before it. */
  private _made: ChildNode[] | null = null;
  /** What the chunks written since `takeAppended` was last asked did to the
   *  tree (`ParseRecord`), or null where that cannot be said: a source that
   *  was not an extension of the one before, a tree handed over, a parse
   *  that yields to its scripts — and the first chunk, which is the whole
   *  document, not worth recording node by node. */
  private _record: ParseRecord | null = null;
  /** The scan of the tree as it was where the record's `factsAt` says, which
   *  a scan of what was put in since extends (`_extendFacts`). */
  private _factsBefore: ScannedFacts | null = null;
  /** The record `takeAppended` last took, which the scan after it still
   *  extends its scan by (`_extendFacts`): null once anything else is
   *  written. */
  private _taken: ParseRecord | null = null;

  constructor() {
    const { parser, handler } = createParser();
    handler.marksSheets = true;
    this._parser = parser;
    this._handler = handler;
    this.document = handler.root;
  }

  /** Wait at the scripts that block the parser, or not. Turned off while
   *  the parse waits, it reads on to the end of what it has without
   *  stopping. True where the tree changed. */
  setYields(on: boolean): boolean {
    if (on === this.yields) return false;
    this.yields = on;
    if (on || this._adopted) return false;
    this._record = null;
    this._taken = null;
    // what is left of the input stream, read as one
    this.held = null;
    this._pending = null;
    this._made = null;
    this._handler.inserted = null;
    let read = false;
    if (this._ahead) {
      this._parser.write(this._ahead);
      this._ahead = '';
      read = true;
    }
    if (this._inputAt < this._input.length) {
      this._parser.write(this._input.slice(this._inputAt));
      read = true;
    }
    this._input = '';
    this._inputAt = 0;
    if (this._ending && !this.complete) {
      this._parser.end();
      this.complete = true;
      read = true;
    }
    if (read) this._changed();
    return read;
  }

  /** Set the whole source. Appends when it can — an extension of what was
   *  written, into a parser that has not been ended — and re-parses when it
   *  cannot. */
  setSource(source: string, complete: boolean): boolean {
    if (this.yields) {
      this._record = null;
      this._taken = null;
      return this._setYielding(source, complete);
    }
    let changed = false;
    if (this._adopted) {
      // a source after a tree handed over is a document of its own
      this._adopted = false;
      this.reset();
      this._parser.write(source);
      this._written = source;
      changed = true;
    } else if (source === this._written) {
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
      //
      // What the chunk does to the tree is recorded where there is a tree
      // to say it of (`takeAppended`): a stream's chunk is told as the
      // nodes it put in and the texts it wrote on to, and restyles and
      // builds what those reach.
      if (this._written) this._recordInto();
      else {
        this._record = null;
        this._taken = null;
      }
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
    this._handler.recording = null;
    if (changed) this._changed();
    return changed;
  }

  /** Record what the parser does to the tree from here on, into the record
   *  `takeAppended` has yet to take, or a new one. */
  private _recordInto(): void {
    if (!this._record) {
      this._taken = null;
      this._record = {
        added: [],
        addedSet: new Set(),
        grown: [],
        grownSet: new Set(),
        attributes: [],
        unknown: false,
        factsAt: 0,
        grownAt: 0,
      };
      // the scan of the tree the record begins on, where it is current
      this._factsBefore =
        this._facts.scanned === this.revision ? this._facts : null;
    }
    this._handler.recording = this._record;
  }

  /**
   * What the chunks written since this was last asked did to the tree, as
   * the change records an application's `refresh` is told (`HtmlChange`):
   * a `childList` for each node already in the tree that the parser put
   * nodes in — at its end, which is the only place the parser puts them —
   * a `characterData` for each text it wrote on to, and an `attributes`
   * for what a second `<html>` or `<body>` set on the first. Null where it
   * cannot be said: the source was not an extension of the one before, the
   * parse yields to its scripts, or a chunk did something no record says —
   * a `<body>` taking in what went before it, a shadow root attached.
   */
  takeAppended(): HtmlChange[] | null {
    const record = this._record;
    this._record = null;
    // and the scan of the tree takes it in, until the next chunk
    this._taken = record;
    if (!record || record.unknown) return null;
    const changes: HtmlChange[] = [];
    for (const { target, name, old } of record.attributes) {
      changes.push({
        type: 'attributes',
        target,
        attributeName: name,
        oldValue: old,
      });
    }
    for (const text of record.grown) {
      changes.push({ type: 'characterData', target: text });
    }
    // by the node that holds them, where that was there before: what is in
    // a node put in is in its record
    const byParent = new Map<ParentNode, ChildNode[]>();
    for (const node of record.added) {
      const parent = node.parent;
      if (!parent) return null;
      if (record.addedSet.has(parent as ChildNode)) continue;
      const nodes = byParent.get(parent);
      if (nodes) nodes.push(node);
      else byParent.set(parent, [node]);
    }
    for (const [parent, nodes] of byParent) {
      // each the run at its holder's end, in order, as the parser put it
      const kids = parent.children;
      const at = kids.length - nodes.length;
      if (at < 0 || nodes.some((node, i) => kids[at + i] !== node)) return null;
      changes.push({
        type: 'childList',
        target: parent,
        addedNodes: nodes,
        removedNodes: [],
      });
    }
    return changes;
  }

  /** `setSource` where the parse yields: the source is the input stream's,
   *  read on from where the parser is to the next script it waits at. */
  private _setYielding(source: string, complete: boolean): boolean {
    let changed = false;
    if (this._adopted) {
      this._adopted = false;
      this.reset();
      this._input = source;
      changed = true;
    } else if (source === this._written) {
      // the same source, which may have ended since
    } else if (!this.complete && source.startsWith(this._written)) {
      // more of a stream, after whatever the parser has yet to read
      this._input += source.slice(this._written.length);
    } else {
      this.reset();
      this._input = source;
      changed = true;
    }
    this._written = source;
    if (complete) this._ending = true;
    if (!this.held && !this.complete && this._readOn()) changed = true;
    if (changed) this._changed();
    return changed;
  }

  /**
   * Read on from where the parser is: what was written ahead of the source,
   * then the source, a piece at a time, stopping after the end tag of a
   * script that blocks the parser — which is then `held` — and ending the
   * parse where the source has ended and all of it is read. True where it
   * read anything.
   */
  private _readOn(): boolean {
    let read = false;
    if (this._ahead) {
      const at = this._feed(this._ahead, 0, this._ahead.length, true);
      if (at > 0) read = true;
      this._ahead = this._ahead.slice(at);
      if (this._hold()) return true;
      // a tail that may start a `</script` the source goes on with: put in
      // front of the source, where the two can be read as one
      if (this._ahead) {
        this._input = this._ahead + this._input.slice(this._inputAt);
        this._inputAt = 0;
        this._ahead = '';
      }
    }
    const from = this._inputAt;
    this._inputAt = this._feed(
      this._input,
      from,
      this._input.length,
      !this._ending,
    );
    if (this._inputAt > from) read = true;
    if (this._hold()) return true;
    if (this._ending && this._inputAt === this._input.length) {
      this._parser.end();
      this.complete = true;
      this._input = '';
      this._inputAt = 0;
      read = true;
    }
    return read;
  }

  /** Hold the script the last `_feed` stopped after, where it did: what
   *  it writes goes in before anything the parser has yet to read. */
  private _hold(): boolean {
    const stopped = this._stopped;
    if (!stopped) return false;
    this._stopped = null;
    this.held = stopped;
    this._insertion = 0;
    if (!this._made) {
      this._made = [];
      this._handler.inserted = this._made;
    }
    return true;
  }

  /**
   * Hand `text` from `from` up to `to` to the parser, a piece at a time
   * (`pieceEnd`), stopping after a piece whose `</script>` closed a script
   * that blocks the parser (`_stopped`). `more` where the input goes on
   * past `to`, so that a `</script` cut at `to` waits for the rest of it.
   * Answers how far it read.
   */
  private _feed(text: string, from: number, to: number, more: boolean): number {
    let at = from;
    while (at < to) {
      const end = pieceEnd(text, at, to, more);
      if (end <= at) break;
      this._handler.closedScript = null;
      this._parser.write(text.slice(at, end));
      at = end;
      const closed = this._handler.closedScript;
      if (closed && blocksParser(closed, this.scripting)) {
        this._stopped = closed;
        break;
      }
    }
    return at;
  }

  /**
   * `document.write` from the script the parse waits at: `markup` goes
   * into the input stream at the insertion point and is parsed up to it
   * (HTML 8.4.3, "document write steps"), unless a script that blocks the
   * parser was written before it — and that stops the parse here too,
   * held next (`_pending`), before what was written after it, which waits.
   * False where the parse does not wait at `script`, and the caller writes
   * another way.
   */
  write(script: Element, markup: string): boolean {
    if (!this.yields || this.held !== script || this.complete) return false;
    this._record = null;
    this._taken = null;
    const ahead = this._ahead;
    this._ahead =
      ahead.slice(0, this._insertion) + markup + ahead.slice(this._insertion);
    this._insertion += markup.length;
    if (this._pending) return true;
    const at = this._feed(this._ahead, 0, this._insertion, true);
    if (this._stopped) {
      this._pending = this._stopped;
      this._stopped = null;
    }
    if (at > 0) {
      this._ahead = this._ahead.slice(at);
      this._insertion -= at;
      this._changed();
    }
    return true;
  }

  /**
   * The script the parse waits at has run: the parse goes on, to the next
   * script it waits at — one the script wrote first — or to the end of the
   * source. True where it read anything.
   */
  resume(script: Element): boolean {
    if (this.held !== script) return false;
    this._record = null;
    this._taken = null;
    this.held = null;
    if (this._pending) {
      this.held = this._pending;
      this._pending = null;
      this._insertion = 0;
      return false;
    }
    const read = this._readOn();
    if (read) this._changed();
    return read;
  }

  /** The nodes the parser has put in the tree since this was last asked,
   *  in the order it put them there, from the first script it waited at
   *  on: what the page's mutation observers and custom elements hear of,
   *  since its scripts have run. */
  takeMade(): readonly ChildNode[] {
    const made = this._made;
    if (!made?.length) return NO_NODES;
    this._made = [];
    this._handler.inserted = this._made;
    return made;
  }

  /** The tree grew: anything kept by the revision is stale. */
  private _changed(): void {
    this.revision += 1;
    this._facts = freshFacts();
    treesChanged();
  }

  /**
   * Draw a tree that is not parsed here: a frame's document, which the host
   * that runs the page holds and changes, telling of each change as a
   * script's is told (`touch`). Complete as it is handed over, since
   * nothing is written to it here. True where it is another tree than the
   * one drawn.
   */
  adopt(document: Document): boolean {
    if (this._adopted && this.document === document) return false;
    this._record = null;
    this._taken = null;
    this._parser.reset();
    this._adopted = true;
    this.document = document;
    this._written = '';
    this._unhold();
    this.complete = true;
    this.revision += 1;
    this._facts = freshFacts();
    treesChanged();
    return true;
  }

  /** Start over — a source that is not an extension of what was written. */
  reset(): void {
    this._record = null;
    this._taken = null;
    this._parser.reset();
    const { parser, handler } = createParser();
    handler.marksSheets = true;
    this._parser = parser;
    this._handler = handler;
    this.document = handler.root;
    this._written = '';
    this._unhold();
    this.complete = false;
    this._facts = freshFacts();
    treesChanged();
  }

  /** Nothing waited at, and no input stream of a parse that yields. */
  private _unhold(): void {
    this.held = null;
    this._pending = null;
    this._stopped = null;
    this._input = '';
    this._inputAt = 0;
    this._ending = false;
    this._ahead = '';
    this._insertion = 0;
    this._made = null;
    this._handler.inserted = null;
  }

  /** The DOM changed under us — an app mutated it, or a stylesheet arrived
   *  and was spliced in. Anything cached on the old revision is stale. */
  touch(): void {
    this._record = null;
    this._taken = null;
    this.revision += 1;
    this._facts = freshFacts();
    treesChanged();
    mutations += 1;
  }

  /** Run scripts or not: what the scan finds changes with it. True when
   *  it changed. */
  setScripting(on: boolean): boolean {
    if (on === this.scripting) return false;
    this.scripting = on;
    this.revision += 1;
    this._facts = freshFacts();
    // a scan that walks into other elements than the one before
    this._factsBefore = null;
    return true;
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
    const extended = this._extendFacts();
    if (extended) {
      this._facts = extended;
      return extended;
    }
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
      // `<base>` are not the document's. Nor into a `<noscript>` where the
      // host runs scripts, which is drawn as nothing then.
      scanElements(
        facts,
        elementsIn(
          root,
          this.scripting ? NON_RENDERED_SCRIPTING : NON_RENDERED,
        ),
        sheets,
        shadow,
        trees,
      );
    }
    this._facts = facts;
    // and a chunk recorded after it extends it
    const record = this._record ?? this._taken;
    if (record) {
      record.factsAt = record.added.length;
      record.grownAt = record.grown.length;
      this._factsBefore = facts;
    }
    return facts;
  }

  /**
   * The scan of the tree after what a stream's chunks put in, from the
   * scan before them (`_factsBefore`) and a scan of what they put in
   * alone: the parser puts each element in after every element already in
   * the tree, so what each list gains comes at its end. Null where the
   * whole tree is to be scanned: there is no scan before, a sheet or the
   * title was written on to, or something went into a shadow tree. Every
   * chunk of a long stream scanned the document whole for its sheets, its
   * scripts and its images.
   */
  private _extendFacts(): ScannedFacts | null {
    const record = this._record ?? this._taken;
    const was = this._factsBefore;
    if (!record || record.unknown || !was) return null;
    for (let i = record.grownAt; i < record.grown.length; i += 1) {
      const holder = record.grown[i].parent;
      if (holder && isElement(holder) && FACT_TEXT.has(tagOf(holder))) {
        return null;
      }
    }
    const facts: ScannedFacts = {
      ...was,
      sheets: was.sheets.slice(),
      shadows: was.shadows,
      scripts: was.scripts.slice(),
      resources: was.resources.slice(),
      pictures: was.pictures.slice(),
      drawings: was.drawings.slice(),
      scanned: this.revision,
    };
    const opaque = this.scripting ? NON_RENDERED_SCRIPTING : NON_RENDERED;
    const added = record.added;
    const since = new Set(added.slice(record.factsAt));
    for (let i = record.factsAt; i < added.length; i += 1) {
      const node = added[i];
      const parent = node.parent;
      // a sheet's text, or the title's, put in after its element
      if (!isElement(node)) {
        if (parent && isElement(parent) && FACT_TEXT.has(tagOf(parent))) {
          return null;
        }
        continue;
      }
      if (parent && since.has(parent as ChildNode)) continue;
      // in what is not rendered nothing is the document's, and what is in
      // a shadow tree is its tree's
      let inert = false;
      for (let at = parent; at; at = at.parent) {
        if (at instanceof ShadowRoot) return null;
        if (isElement(at) && opaque.has(tagOf(at))) inert = true;
      }
      if (inert) continue;
      if (!scanElements(facts, [node], facts.sheets, false, null)) return null;
      if (opaque.has(tagOf(node))) continue;
      if (
        !scanElements(
          facts,
          elementsIn(node, opaque),
          facts.sheets,
          false,
          null,
        )
      ) {
        return null;
      }
    }
    record.factsAt = added.length;
    record.grownAt = record.grown.length;
    this._factsBefore = facts;
    return facts;
  }

  /** Release the parser. The tree stays readable — an app may still hold it. */
  destroy(): void {
    this._parser.reset();
    this._handler.onreset?.();
  }
}

/**
 * What `elements` tell `HtmlSource.facts` of the document, into `facts` and
 * their tree's `sheets` (`shadow` where that is a shadow tree's). The shadow
 * trees their hosts hold go on `trees`, for the walk to take in turn; with
 * none, false at the first host, which only the whole scan walks into
 * (`_extendFacts`). One loop with all of it in it, as the whole scan has it:
 * a call for each element was a twentieth of the scan.
 */
function scanElements(
  facts: ScannedFacts,
  elements: Iterable<Element>,
  sheets: SheetRef[],
  shadow: boolean,
  trees: { root: ParentNode; sheets: SheetRef[] }[] | null,
): boolean {
  for (const el of elements) {
    const hosted = SHADOW_ROOTS.get(el);
    if (hosted) {
      if (!trees) return false;
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
      } else if (isStylePreload(el)) facts.resources.push(el);
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
    } else if (tag === 'svg') {
      if (!inDrawing(el)) facts.drawings.push(el);
    } else if (tag === 'title' && facts.title === null) {
      facts.title = rawTextOf(el).trim();
    } else if (tag === 'base' && facts.base === null) {
      const href = attr(el, 'href');
      if (href !== undefined) facts.base = href;
    }
  }
  return true;
}

/** Whether an element is inside an `<svg>`. */
function inDrawing(el: Element): boolean {
  for (let at = el.parent; at && isElement(at); at = at.parent) {
    if (tagOf(at) === 'svg') return true;
  }
  return false;
}

/** The elements whose text the scan reads (`facts`): a chunk that writes
 *  on to one scans the tree whole. */
const FACT_TEXT = new Set(['style', 'title']);

/** Nothing made (`HtmlSource.takeMade`). */
const NO_NODES: readonly ChildNode[] = [];

/** A `</script`, wherever it is: the end tags a parse that yields cuts
 *  the input after (`pieceEnd`). */
const SCRIPT_END = /<\/script/gi;
const SCRIPT_END_TEXT = '</script';

/**
 * Where the piece of `text` from `from` ends that the parser is handed
 * next where the parse yields (`HtmlSource._feed`): right after the `>`
 * of the first `</script` in it, or at `to`. A script's end tag is the
 * only place the parser stops at, and it closes the script at that `>`,
 * so a script that a piece closed was closed at its end, and nothing of
 * the input after it has been read. Where the input goes on past `to`
 * (`more`), a `</script` with no `>` before `to`, and a tail that may be
 * the start of one, wait for the rest of it, so that no end tag is read
 * across two pieces.
 */
function pieceEnd(text: string, from: number, to: number, more: boolean) {
  SCRIPT_END.lastIndex = from;
  const found = SCRIPT_END.exec(text);
  if (found && found.index < to) {
    const close = text.indexOf('>', found.index + SCRIPT_END_TEXT.length);
    if (close >= 0 && close < to) return close + 1;
    return more ? found.index : to;
  }
  if (more) {
    for (let k = Math.min(SCRIPT_END_TEXT.length - 1, to - from); k > 0; k--) {
      if (SCRIPT_END_TEXT.startsWith(text.slice(to - k, to).toLowerCase())) {
        return to - k;
      }
    }
  }
  return to;
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
    drawings: [],
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
  /** The `<head>` HTML's parser implies in a written `<html>` that has
   *  none, while it is open: htmlparser2 never saw it open, so it is closed
   *  here, before whatever comes that is not head content. */
  private _impliedHead: Element | null = null;
  private _headSeen = false;
  /** Whether the source declares itself a document, with a doctype at its
   *  start: one is parsed as HTML's parser parses every document, into an
   *  `<html>` with its head and its body, written or implied (13.2.6.4.1,
   *  "initial", and "before html"). A source with none is a fragment. */
  private _document = false;
  /** Whether a `<template shadowrootmode>` attaches a shadow root, as it
   *  does in a document a browser's parser builds, and not in a fragment
   *  parsed for `innerHTML` (HTML 13.2.6.4.4). */
  declarative = true;
  /** Whether the `<link>`s and `<style>`s made here are a document's
   *  parser's (`madeByParser`): a fragment's are not. */
  marksSheets = false;
  /** The last `<script>` an end tag closed, for `HtmlSource` to ask
   *  whether the parse waits at it. */
  closedScript: Element | null = null;
  /** The nodes put in the tree while it is set, in the order they were
   *  put there: what a step of a parse that waits for scripts made,
   *  which the page's mutation observers and custom elements hear of. */
  inserted: ChildNode[] | null = null;

  /** What the parser does to the tree while it is set (`HtmlSource.
   *  takeAppended`). */
  recording: ParseRecord | null = null;

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
    this.inserted?.push(node);
    const record = this.recording;
    if (record) {
      record.added.push(node);
      record.addedSet.add(node);
    }
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
    if (name !== 'html') this._impliedHtml();
    if (this._ignored(name, attribs)) return;
    this._closeImpliedHead(name);
    this._openImpliedHead(name);
    if (name === 'body' && this._body) {
      // a second body is its attributes, on the first; the parser will end
      // it, so what it ends is the body outside one, or else what is open
      this._mergeAttributes(this._body, attribs);
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
    if (this.marksSheets && (name === 'link' || name === 'style')) {
      PARSER_SHEETS.add(opened);
    }
    if (attribs.customelementregistry !== undefined) {
      NULL_REGISTRY.add(opened);
      nullRegistriesParsed = true;
    }
    if (name === 'head') this._headSeen = true;
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
   * A start tag HTML's parser makes no element of (13.2.6.4.7, "in body"):
   * an `<html>` once the document has one, or past where it would start,
   * whose attributes go on the `<html>` there is where it has none of its
   * own; and a `<head>` once the head is behind it. WordPress saves a post
   * through PHP's DOM, which writes a whole document, `<!DOCTYPE>`,
   * `<html>` and `<body>`, round the post: on github.blog the article's
   * blocks were the children of an `<html>` inside the content column, and
   * `.is-layout-constrained > *`, which takes a figure's side margins away,
   * reached none of them. True where it is ignored, and stood in for on the
   * stack by what is open, which the parser then closes at its end tag, or
   * with what holds it, as it would close the element.
   */
  private _ignored(name: string, attribs: Record<string, string>): boolean {
    const stack = this.tagStack;
    const top = stack[stack.length - 1];
    if (name === 'html') {
      if (top === this.root && !this._html && !this._body) return false;
      if (this._html) this._mergeAttributes(this._html, attribs);
    } else if (name === 'head') {
      if (
        !this._headSeen &&
        !this._body &&
        (top === this.root || top === this._html)
      ) {
        return false;
      }
    } else {
      return false;
    }
    stack.push(top);
    this._afterPre = false;
    return true;
  }

  /** The attributes of a second `<html>` or `<body>` that the first has
   *  none of, set on it — and told, where a chunk is recorded. */
  private _mergeAttributes(el: Element, attribs: Record<string, string>): void {
    for (const key in attribs) {
      if (el.attribs[key] !== undefined) continue;
      el.attribs[key] = attribs[key];
      this.recording?.attributes.push({ target: el, name: key, old: null });
    }
  }

  /** A doctype past the start of the document, which HTML's parser leaves
   *  out (13.2.6.4.7, "a DOCTYPE token"): it is the document's only where
   *  no element has been opened before it, and makes the source one. */
  override onprocessinginstruction(name: string, data: string): void {
    if (
      name === '!doctype' &&
      (this.tagStack.length > 1 || this.root.children.some(isElement))
    ) {
      return;
    }
    if (name === '!doctype') this._document = true;
    super.onprocessinginstruction(name, data);
  }

  /**
   * The `<html>` HTML's parser implies in a document that does not write
   * one, before its first element or text (13.2.6.4.2, "before html"),
   * which the head and the body are then implied in as in a written one.
   * Without it a WPT test that starts `<!doctype html><title>` had no
   * `<head>` for `document.head` to answer, no `<body>`, and a `:root`
   * that was the `<title>`.
   */
  private _impliedHtml(): void {
    if (!this._document || this._html || this._body) return;
    if (this.tagStack[this.tagStack.length - 1] !== this.root) return;
    super.onopentag('html', {});
    this._html = this.tagStack[this.tagStack.length - 1] as Element;
  }

  /** A document ends with its `<html>`, head and body, however little it
   *  wrote of them: an empty one has all three. */
  override onend(): void {
    if (this._document) {
      this._impliedHtml();
      this._openImpliedHead(null);
      this._closeImpliedHead(null);
      if (this._html && !this._body) this._reopen();
    }
    super.onend();
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
    // a tree for the host to be drawn as, which no record of a chunk says
    if (this.recording) this.recording.unknown = true;
    const root = new ShadowRoot(host, mode, delegates);
    root.registryNull = attribs.shadowrootcustomelementregistry !== undefined;
    if (root.registryNull) nullRegistriesParsed = true;
    root.clonable = attribs.shadowrootclonable !== undefined;
    root.serializable = attribs.shadowrootserializable !== undefined;
    root.declarative = true;
    SHADOW_ROOTS.set(host, root);
    treesChanged();
    stack.push(root);
    this.lastNode = null;
    this._afterPre = false;
    return true;
  }

  /**
   * A `<head>` round the head content a written `<html>` starts with, as
   * HTML's parser implies one (13.2.6.4.3, "before head"): without it the
   * document's tree was not a browser's, `:first-child + *` was the
   * `<title>`'s sibling and not the body, and Acid3's coloured boxes,
   * styled through that selector, were never inline blocks. Implied
   * once, before the first thing in the `<html>`, and empty where that is
   * not head content — a `<noscript>` neither, whose content `<Html>` draws
   * where the parser would have taken it into the body.
   */
  private _openImpliedHead(name: string | null): void {
    if (
      this._headSeen ||
      this._body ||
      !this._html ||
      this.tagStack[this.tagStack.length - 1] !== this._html ||
      name === 'head' ||
      name === 'html'
    ) {
      return;
    }
    this._headSeen = true;
    super.onopentag('head', {});
    this._impliedHead = this.tagStack[this.tagStack.length - 1] as Element;
    this._closeImpliedHead(name);
  }

  /** The implied head closed, where what comes next is not head content
   *  (`name`, an element's, or null for text, a close or the end). */
  private _closeImpliedHead(name: string | null): void {
    const head = this._impliedHead;
    if (!head) return;
    const stack = this.tagStack;
    if (stack[stack.length - 1] !== head) return;
    if (name && HEAD_CONTENT.has(name) && name !== 'noscript') return;
    // and the stand-ins for it an ignored `<html>` or `<head>` in it left
    // (`_ignored`) stand for what holds it, so that each one's end tag
    // still closes one: left standing for the head, the one a `<meta>`
    // before `<html class>` leaves kept it open, and the body's content
    // went into the head
    let standIns = 0;
    while (stack[stack.length - 1] === head) {
      stack.pop();
      standIns += 1;
    }
    const holder = stack[stack.length - 1];
    for (let i = 1; i < standIns; i += 1) stack.push(holder);
    this._impliedHead = null;
    this.lastNode = null;
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
    // nodes moved, which no record of a chunk says
    if (this.recording) this.recording.unknown = true;
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
    // a close htmlparser2 makes is of what it opened, which the implied
    // head is not: it closes with it
    this._closeImpliedHead(null);
    const closing = this.tagStack[this.tagStack.length - 1];
    super.onclosetag();
    if (closing instanceof Element && closing.name === 'script') {
      this.closedScript = closing;
    }
  }

  override oncomment(data: string): void {
    this._afterPre = false;
    super.oncomment(data);
  }

  override ontext(data: string): void {
    if (NOT_SPACE.test(data)) {
      this._impliedHtml();
      this._openImpliedHead(null);
      this._closeImpliedHead(null);
    }
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
    // a text written on to that a chunk before this one put in
    const record = this.recording;
    const last = this.lastNode;
    if (
      record &&
      last instanceof Text &&
      !record.addedSet.has(last) &&
      !record.grownSet.has(last)
    ) {
      record.grown.push(last);
      record.grownSet.add(last);
    }
    super.ontext(data);
  }
}

/**
 * What a chunk of a source did to its tree (`HtmlSource.takeAppended`):
 * the nodes the parser put in, in order — each at the end of what holds it,
 * the one place the parser puts anything — the texts it wrote on to that
 * were there before, and the attributes a second `<html>` or `<body>` set
 * on the first; and whether it did anything none of those say.
 */
interface ParseRecord {
  added: ChildNode[];
  addedSet: Set<ChildNode>;
  grown: Text[];
  grownSet: Set<Text>;
  attributes: { target: Element; name: string; old: null }[];
  unknown: boolean;
  /** How much of `added` and `grown` the scan the record began after, or
   *  its last one, has taken in (`HtmlSource._extendFacts`). */
  factsAt: number;
  grownAt: number;
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

/** What `DocumentParser` reads of htmlparser2's parser beyond its typed
 *  surface: the stack of open tag names, top first, and the two steps an
 *  open tag is made in. Held to htmlparser2 12 by `test/html/document.test.ts`. */
interface ParserInternals {
  readonly stack: string[];
  readTagName(start: number, endIndex: number): string;
  emitOpenTag(name: string): void;
  endOpenTag(isImplied: boolean): void;
  popElement(implied: boolean): void;
}

/** A table's row groups, where a cell opens a row; and what may be open
 *  where a table's rows imply something. */
const SECTIONS = new Set(['tbody', 'thead', 'tfoot']);
const IN_TABLE = new Set(['table', 'colgroup', ...SECTIONS]);

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
    if (!this._foreignTag) this._impliedBy(start, endIndex);
    super.onopentagname(start, endIndex);
  }

  /**
   * The elements HTML's parser opens in a table before a row or a cell
   * that has none to go in (HTML 13.2.6.4.9, "in table": a `<tr>`, a `<td>`
   * or a `<th>` opens a `<tbody>`, and a cell in a section a `<tr>`; a
   * `<col>` a `<colgroup>`). htmlparser2 opens none, so a table's rows
   * were its children, and `table.tBodies`, `tbody > tr` and a walk of the
   * tree all found another tree than a browser's. They are opened on the
   * parser's own stack, as it opens what it implies, so that its end tags
   * close them: `</tbody>` in a cell closes the cell and the row, as
   * Acid3's table has it.
   */
  private _impliedBy(start: number, endIndex: number): void {
    const self = this as unknown as ParserInternals;
    // asked only where a table is open, since every tag comes through here
    if (!IN_TABLE.has(self.stack[0])) return;
    const name = self.readTagName(start, endIndex);
    // a column group holds columns and nothing else
    if (self.stack[0] === 'colgroup' && name !== 'col') self.popElement(true);
    if (name !== 'tr' && name !== 'td' && name !== 'th' && name !== 'col') {
      return;
    }
    const open = (tag: string): void => {
      self.emitOpenTag(tag);
      self.endOpenTag(true);
    };
    if (name === 'col') {
      if (self.stack[0] === 'table') open('colgroup');
      return;
    }
    if (self.stack[0] === 'table') open('tbody');
    if (name !== 'tr' && SECTIONS.has(self.stack[0])) open('tr');
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
export function parseFragment(html: string, declarative = false): ChildNode[] {
  const { parser, handler } = createParser(declarative);
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
