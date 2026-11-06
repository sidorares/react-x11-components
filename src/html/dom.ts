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
import { isXmlType, readProlog } from './xml-prolog.js';
import { corsKeyed } from './url.js';
import type { CorsMode } from './url.js';

export { isXmlType };
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
  if (tagOf(el) !== 'script' || !isStyleOrScript(el)) return false;
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
      const tag = tagOf(at);
      if (tag === 'template' || (scripting && tag === 'noscript')) return false;
    }
    at = at.parent;
  }
  return true;
}

/** Where a `<script>` says its source is: a drawing's in `href` or
 *  `xlink:href` (SVG 2, 15.3), which an XML parser says it is (HTML's says
 *  nothing of a `<script>` in a drawing). */
export function scriptUrlOf(el: Element): string | null {
  const { attribs } = el;
  if (el.namespace === SVG_NS) {
    return attribs.href ?? attribs['xlink:href'] ?? null;
  }
  return attribs.src ?? null;
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
  const { namespace } = node as Element;
  if (namespace !== undefined) return namedTag(node as Element, namespace);
  const name = (node as Element).name.toLowerCase();
  return name.endsWith(':svg') && isSvgRoot(node as Element) ? 'svg' : name;
}

/**
 * The tag of an element that says what namespace it is in: its local name,
 * whatever prefix it is under, in the three languages this draws, and none
 * in any other, whose `<div>` is no `<div>` and whose `<svg>` draws nothing
 * (DOM 4.9). An XML document's HTML keeps its case, so its `<DIV>` is no
 * `<div>` either; a drawing's and a formula's are lower-cased as the HTML
 * parser's are, which is the name the code here asks for.
 */
function namedTag(el: Element, namespace: string): string {
  const name = el.name;
  const local = name.slice(name.indexOf(':') + 1);
  if (namespace === HTML_NAMESPACE) return local;
  if (namespace === SVG_NS || namespace === MATHML_NS) {
    return local.toLowerCase();
  }
  return '';
}

/** An element's local name, as a type selector in an XML document reads it:
 *  a name in XML has its case and a prefix is no part of it. */
export function localNameOf(el: Element): string {
  const { name } = el;
  return name.slice(name.indexOf(':') + 1);
}

/** An element's name as a type selector in an HTML document reads it, which
 *  has lost its case: an element that says its namespace has a prefix that is
 *  no part of it, and the parser keeps SVG's capitals, all in names of six
 *  letters or more. */
export function typeNameOf(el: Element): string {
  const name = el.namespace === undefined ? el.name : localNameOf(el);
  return name.length < 6 || !/[A-Z]/.test(name) ? name : name.toLowerCase();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/**
 * Whether an element is the root of an SVG drawing. The HTML parser names
 * an inline `<svg>` plainly; XHTML may bind a prefix to the SVG namespace
 * (`<svg:svg xmlns:svg="http://www.w3.org/2000/svg">`), which is the same
 * element to an XML parser, and is honoured where the prefix is declared.
 * Only SVG's: a Word document's `<o:p>` under `xmlns:o` is not a paragraph,
 * to this any more than to a browser reading it as HTML.
 */
export function isSvgRoot(el: Element): boolean {
  if (el.namespace !== undefined) return tagOf(el) === 'svg';
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

/**
 * Whether an element says it is no HTML element, which only an element whose
 * name means something in HTML has to. A `<path>` is told by its name and says
 * nothing; what `MARKED` names, that HTML's parser made in a drawing or a
 * `<math>`, says so (`namespaceIn`), as whatever a script makes with
 * `createElementNS` does. It stays with the element wherever it is put and in
 * every copy, so this is no question of where an element stands: a `<link>` a
 * script puts in a drawing is a sheet, and one the parser made there, moved to
 * the `<head>`, is not.
 */
export function isForeign(el: Element): boolean {
  const { namespace } = el;
  return namespace !== undefined && namespace !== HTML_NAMESPACE;
}

/**
 * Whether a `<style>` or a `<script>` is one. SVG has both, so one the parser
 * made in a drawing says nothing and is one wherever it goes, and one in
 * MathML or anywhere else is only a name, in all three engines.
 */
export function isStyleOrScript(el: Element): boolean {
  return !isForeign(el) || el.namespace === SVG_NS;
}

/** What HTML's parser reads as HTML in SVG and in MathML, each in its own
 *  language, and an `<annotation-xml>` only where it says it holds HTML
 *  (13.2.6.5): htmlparser2 has one list for both, and any `annotation-xml`. */
const SVG_POINTS = new Set(['foreignobject', 'desc', 'title']);
const MATHML_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);
const HTML_ENCODINGS = new Set(['text/html', 'application/xhtml+xml']);

/**
 * The namespace HTML's parser makes an element in that goes in `parent`, or
 * undefined for HTML's (13.2.6.5): that of the nearest `<svg>`, `<math>` or
 * element that says, unless an integration point of its language stands
 * between. A walk up, which a name `MARKED` holds or an `innerHTML` pays for
 * as it is parsed, and a scan of the document never does.
 */
export function namespaceIn(parent: AnyNode | null): string | undefined {
  let svgPoint = false;
  let mathPoint = false;
  for (let at = parent; at; at = at.parent) {
    if (!isElement(at)) continue;
    const name = at.name.toLowerCase();
    svgPoint ||= SVG_POINTS.has(name);
    mathPoint ||=
      MATHML_POINTS.has(name) ||
      (name === 'annotation-xml' &&
        HTML_ENCODINGS.has((at.attribs.encoding ?? '').toLowerCase()));
    const namespace =
      at.namespace ??
      (name === 'svg' || name === 'math' ? rootNamespace(at, name) : undefined);
    if (namespace === SVG_NS) return svgPoint ? undefined : namespace;
    if (namespace === MATHML_NS) return mathPoint ? undefined : namespace;
    if (namespace !== undefined) {
      return namespace === HTML_NAMESPACE ? undefined : namespace;
    }
    // what broke out of a fragment's context still stands in it
    if (BREAKS_OUT.has(name)) return undefined;
  }
  return undefined;
}

/** What a page's `createElement` made, and each copy of it: HTML's, wherever
 *  it goes, where nothing around it says so (`namespaceOf`). */
export const MADE_AS_HTML = new WeakSet<Element>();

/**
 * An element's namespace (DOM 4.9): what it says, or where it stands, as the
 * HTML parser keeps none for all but what `MARKED` names. '' for none, which
 * only an element that says so is in.
 */
export function namespaceOf(el: Element): string {
  if (el.namespace !== undefined) return el.namespace;
  if (MADE_AS_HTML.has(el)) return HTML_NAMESPACE;
  const name = el.name.toLowerCase();
  if (name === 'svg' || name === 'math') return rootNamespace(el, name);
  return namespaceIn(el.parent) ?? HTML_NAMESPACE;
}

/** The namespace a prefix reaches at a node, by the declarations around it;
 *  null for none. */
export function namespaceFor(el: AnyNode, prefix: string): string | null {
  if (prefix === 'xml') return XML_NS;
  if (prefix === 'xmlns') return XMLNS_NS;
  for (let at: AnyNode | null = el; at; at = at.parent) {
    if (!isElement(at)) continue;
    const value = at.attribs[prefix ? `xmlns:${prefix}` : 'xmlns'];
    if (value !== undefined) return value;
    if (prefix && at.name.startsWith(`${prefix}:`)) {
      return at.namespace ?? null;
    }
  }
  return null;
}

/** The prefixes of the attributes HTML's parser adjusts on what is not HTML. */
const ADJUSTED_PREFIXES = new Map([
  ['xlink', XLINK_NS],
  ['xml', XML_NS],
  ['xmlns', XMLNS_NS],
]);

/** The namespaces `setAttributeNS` gave attributes, by the name each is kept
 *  under: no prefix around such an attribute need say. */
export const ATTRIBUTE_SPACES = new WeakMap<Element, Map<string, string>>();

/**
 * The local name and the namespace of the attribute an element keeps under
 * `key`, as a selector reads them (Selectors 4, 6.1): the tree keeps a name
 * as it was written. HTML's parser reads a colon as any character of a name on
 * an HTML element, and on another as a prefix only in the names it adjusts
 * (13.2.6.5), which no declaration need bind; anywhere else a prefix means
 * what is declared around the attribute.
 */
export function attributeName(
  el: Element,
  key: string,
): { local: string; namespace: string } {
  const colon = key.indexOf(':');
  const local = key.slice(colon + 1);
  const said = ATTRIBUTE_SPACES.get(el)?.get(key);
  if (said !== undefined) return { local, namespace: said };
  if (colon < 0) return { local, namespace: '' };
  if (el.namespace === undefined && namespaceOf(el) === HTML_NAMESPACE) {
    return { local: key, namespace: '' };
  }
  const prefix = key.slice(0, colon);
  const namespace =
    (el.namespace === undefined ? null : namespaceFor(el, prefix)) ??
    ADJUSTED_PREFIXES.get(prefix);
  return namespace === undefined
    ? { local: key, namespace: '' }
    : { local, namespace };
}

/**
 * The namespace of an `<svg>` or a `<math>` the parser made, which starts its
 * language only outside the other's: `<math><svg>` is a MathML element and all
 * it holds is MathML's, a `<script>` that does not run among it, and
 * `<svg><math>` the same way round. An `<annotation-xml>` takes an `<svg>` as
 * one (13.2.6.5).
 */
function rootNamespace(el: Element, name: string): string {
  const around = namespaceIn(el.parent);
  const own = name === 'svg' ? SVG_NS : MATHML_NS;
  if (around === undefined) return own;
  const parent = el.parent;
  return own === SVG_NS &&
    isElement(parent) &&
    parent.name.toLowerCase() === 'annotation-xml'
    ? own
    : around;
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

/** Whether an element is a checkbox or a radio button: an `<input>` whose
 *  look is a mark to tick, and none of whose edges its native look keeps. */
export function isCheckable(el: Element): boolean {
  if (el.name !== 'input' && tagOf(el) !== 'input') return false;
  const type = (attr(el, 'type') ?? '').trim().toLowerCase();
  return type === 'checkbox' || type === 'radio';
}

/** Where an image element's image is: an `<img>`'s `src`, an `<object>`'s
 *  `data` — which is shown as an image when it is one (HTML's "the object
 *  element"), and as the element's fallback content otherwise — an
 *  `<embed>`'s `src` the same, and a `<video>`'s `poster`, the frame it
 *  shows until it plays, which here it does not. An `<img>` that chooses
 *  its source (`choosesSource`) shows what it chose, which this is not. An
 *  `<img>` asked for by CORS is kept by the mode it asks in as well
 *  (`corsKeyed`), which the store asks the host for it in. */
export function imageUrlOf(el: Element): string | undefined {
  const tag = tagOf(el);
  if (tag === 'object') return attr(el, 'data');
  if (tag === 'video') return attr(el, 'poster');
  const src = attr(el, 'src');
  return src && tag === 'img' ? corsKeyed(src, imageCors(el)) : src;
}

/** The CORS mode an `<img>` asks for its image in, by its `crossorigin`
 *  attribute (HTML 2.5.4): null where it has none, and `anonymous` for any
 *  value but `use-credentials`. */
export function imageCors(el: Element): CorsMode | null {
  if (tagOf(el) !== 'img') return null;
  const raw = attr(el, 'crossorigin');
  if (raw === undefined) return null;
  return raw.toLowerCase() === 'use-credentials'
    ? 'use-credentials'
    : 'anonymous';
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

/** Whether an `<img>`'s `loading` attribute is in its Lazy state (HTML
 *  2.5.7): the keyword in any case, and anything else, or none, is Eager. */
export function loadsLazily(el: Element): boolean {
  return tagOf(el) === 'img' && attr(el, 'loading')?.toLowerCase() === 'lazy';
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
 *  said so, or a shadow root was attached. Or what a selector reads moved
 *  where no tree says: the element a fragment names (`Cascade.setTarget`). */
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
 *  `var()`s in a shape's presentation attributes, and an inline drawing
 *  that read outside its root (`inlineDrawing`). */
export function mutationGeneration(): number {
  return mutations;
}

/** Bumped where nothing says what changed: a `touch` with no list of it. A
 *  cache a list can speak for is dropped by the list (`forgetDrawings`), and
 *  by this at any other touch. */
let untold = 0;

/** Where the changes nothing tells of have got to. */
export function untoldGeneration(): number {
  return untold;
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
 *  - `shadowRoot`: `target` took a shadow tree, or the sheets its tree
 *    adopted changed (`ShadowRoot.adopted`). No selector outside it can
 *    tell, so what can differ is the host and all it holds.
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
  | { type: 'characterData'; target: AnyNode }
  | { type: 'shadowRoot'; target: Element };

/**
 * A sheet a page's script constructed, as the shadow trees that adopted it
 * have it: one object for all of them, so an edit is one string whichever
 * trees read it, and trees that read alike hash that string once
 * (`HtmlViewNode._sheetsKey`).
 */
export interface AdoptedSheet {
  text: string;
  /** The trees that hold it, which an edit is told of. */
  roots: Set<ShadowRoot>;
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
  /** What a page's script adopted (`adoptedStyleSheets`): this tree's last
   *  sheets, after its own, as CSSOM orders them. */
  adopted: readonly AdoptedSheet[] = [];
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
  if (isForeign(el)) return true;
  return !(isCustomElementName(el.name) || el.attribs.is !== undefined);
}
export const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** Each custom element's states, as its `ElementInternals.states` has them
 *  in the page's realm: what `:state()` reads. */
const CUSTOM_STATES = new WeakMap<Element, ReadonlySet<string>>();

/** A custom element's states now: whether they changed. */
export function setCustomStates(
  el: Element,
  names: readonly string[],
): boolean {
  const was = CUSTOM_STATES.get(el);
  if (was?.size === names.length && names.every((name) => was.has(name))) {
    return false;
  }
  if (!was && !names.length) return false;
  CUSTOM_STATES.set(el, new Set(names));
  return true;
}

/** Whether `:state(name)` matches an element. */
export function hasCustomState(el: Element, name: string): boolean {
  return CUSTOM_STATES.get(el)?.has(name) ?? false;
}

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
   *  those in its own, with its sheets in its order and what it adopted
   *  after them: what each styles is in it (CSS Scoping 1, 3.2). */
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
  /** A sheet its tree adopted, which no element is: `element` is the
   *  tree's host. */
  constructed?: boolean;
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
  private _handler: TreeHandler;
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
  /** The source and the type `setXml` last read, where the document is XML:
   *  what a render that changed neither is told by. */
  private _xml: { source: string; type: string } | null = null;
  /** The scan of the tree as it was where the record's `factsAt` says, which
   *  a scan of what was put in since extends (`_extendFacts`). */
  private _factsBefore: ScannedFacts | null = null;
  /** The record `takeAppended` last took, which the scan after it still
   *  extends its scan by (`_extendFacts`): null once anything else is
   *  written. */
  private _taken: ParseRecord | null = null;

  /** Whether a source is parsed as a document whatever it starts with
   *  (`setDocument`), and whether its declarative shadow roots attach. */
  private _asDocument = false;
  private _declarative = true;

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
    if (this._xml) (this._handler as unknown as XmlHandler).stops = null;
    let read = false;
    if (this._xml && !this.complete) {
      this._parser.resume();
      read = true;
    }
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
    if (this._xml) {
      this._xml = null;
      this.reset();
    }
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

  /**
   * Set the whole source of a document served as XML (`isXmlType`), read by
   * XML's rules (XML 1.0, HTML 13.4) rather than HTML's. Nothing of it is read
   * until it has all come: what is wrong with a document decides what it is,
   * and that may be its last byte. A document that is not well-formed is the
   * error and nothing of it, as Firefox shows it, and runs nothing. Read
   * once to know that, it is the tree where the parse waits for nothing, and
   * where a host runs its scripts and one of them blocks the parser it is
   * read again as `yields` has it, each one running where the parser met it
   * and seeing what came before it and no more.
   */
  setXml(source: string, type: string, complete: boolean): boolean {
    if (this._xml?.source === source && this._xml.type === type) return false;
    if (!complete) {
      const was = !!this._xml;
      return this.setSource('', false) || was;
    }
    const read = xmlTree(source);
    const blocks =
      read.wellFormed &&
      this.yields &&
      read.kids.some((kid) => holdsBlockingScript(kid, this.scripting));
    if (blocks) {
      this.reset(true);
      this._xml = { source, type };
      markXmlDocument(this.document, type);
      this._input = read.text;
      this._ending = true;
      this._readOn();
      this._changed();
      return true;
    }
    const kids = read.wellFormed ? read.kids : [parserError()];
    const document = new DomDocument(kids);
    for (const kid of kids) kid.parent = document;
    markXmlDocument(document, type);
    this.adopt(document);
    this._xml = { source, type };
    return true;
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
    if (this._xml) return this._readOnXml();
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

  /** `_readOn` in an XML document, which has no `document.write` to read
   *  around: the parser pauses itself at the script (`XmlHandler.stops`),
   *  self-closed or not, so nothing cuts the input up to stop at one. */
  private _readOnXml(): boolean {
    this._stopped = null;
    (this._handler as unknown as XmlHandler).stops = (el) => {
      if (!blocksParser(el, this.scripting)) return false;
      this._stopped = el;
      return true;
    };
    if (this._input) {
      const text = this._input;
      this._input = '';
      this._parser.write(text);
    } else this._parser.resume();
    if (this._hold()) return true;
    this._parser.end();
    this.complete = true;
    return true;
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
    const at = this._recorded(() =>
      this._feed(this._ahead, 0, this._insertion, true),
    );
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
    const read = this._recorded(() => this._readOn());
    if (read) this._changed();
    return read;
  }

  /** What the parse puts in the tree while `read` runs, recorded as a
   *  stream's chunk is (`takeAppended`): a parse that waits at a script
   *  goes on after it at the ends of what is open, and what it reads on
   *  to restyles and builds what it reaches. Apple's product pages wait
   *  at six scripts, and each styled the whole page again. */
  private _recorded<T>(read: () => T): T {
    this._recordInto();
    try {
      return read();
    } finally {
      this._handler.recording = null;
    }
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
   * one drawn: what changed while nothing drew it was told to nobody.
   */
  adopt(document: Document): boolean {
    if (this._adopted && this.document === document) return false;
    this._xml = null;
    this._record = null;
    this._taken = null;
    this._parser.reset();
    this._adopted = true;
    this.document = document;
    this._written = '';
    this._unhold();
    this.complete = true;
    this.touch();
    return true;
  }

  /** Start over — a source that is not an extension of what was written,
   *  read as `xml` says. */
  reset(xml = false): void {
    this._record = null;
    this._taken = null;
    this._parser.reset();
    const { parser, handler } = xml
      ? createXmlParser()
      : createParser(this._declarative, this._asDocument);
    if (parser instanceof DocumentParser) parser.setScripting(this.scripting);
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
   *  and was spliced in. Anything cached on the old revision is stale.
   *  `told` where a list of what changed goes with it, and `changes` that
   *  list, which keeps the scan where none of them is a change to what it
   *  reads (`changesFacts`): a page that writes a `style` at every frame
   *  scanned YouTube's 10,000 elements at every frame. */
  touch(told = false, changes?: readonly HtmlChange[]): void {
    this._record = null;
    this._taken = null;
    const kept =
      changes && this._facts.scanned === this.revision && !changesFacts(changes)
        ? this._facts
        : null;
    this.revision += 1;
    this._facts = kept ?? freshFacts();
    if (kept) kept.scanned = this.revision;
    treesChanged();
    mutations += 1;
    if (!told) untold += 1;
  }

  /**
   * Parse a source as a document, as HTML's parser parses one, into an
   * `<html>` with its head and its body whatever it starts with, the head
   * there from the first script on: a page whose scripts run is one, as a
   * frame's and a written one are. Off, a source with no doctype and no
   * `<html>` at its start is a fragment, which the root stands in a body
   * for. Taken at the next parse from nothing, and at once where nothing has
   * been parsed. `declarative` off attaches no shadow root a template
   * declares, as `DOMParser` attaches none.
   */
  setDocument(on: boolean, declarative = true): void {
    if (on === this._asDocument && declarative === this._declarative) return;
    this._asDocument = on;
    this._declarative = declarative;
    if (!this._written && !this._input && !this._adopted && !this._xml) {
      this.reset();
    }
  }

  /** Run scripts or not: what the scan finds changes with it. True when
   *  it changed. */
  setScripting(on: boolean): boolean {
    if (on === this.scripting) return false;
    this.scripting = on;
    // and the parse, where it has yet to read anything: a `<noscript>`
    // holds text where scripts run
    if (
      this._parser instanceof DocumentParser &&
      !this._written &&
      !this._input &&
      !this._adopted
    ) {
      this._parser.setScripting(on);
    }
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
    // what an XML document's prolog links, ahead of all it holds
    if (XML_DOCUMENTS.has(this.document)) {
      scanElements(
        facts,
        instructionSheets(this.document),
        facts.sheets,
        false,
        null,
      );
    }
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
      if (root instanceof ShadowRoot) {
        for (const { text } of root.adopted) {
          sheets.push({
            kind: 'inline',
            text,
            element: root.host,
            media: null,
            constructed: true,
          });
        }
      }
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
/** The `<style>` and `<link>` elements a page's script disabled the sheet
 *  of (`sheet.disabled`), which the cascade reads none of. */
const DISABLED_SHEETS = new WeakSet<Element>();

/** Disable an element's sheet, or let it be: whether that changed it. */
export function setSheetDisabled(el: Element, disabled: boolean): boolean {
  if (DISABLED_SHEETS.has(el) === disabled) return false;
  if (disabled) DISABLED_SHEETS.add(el);
  else DISABLED_SHEETS.delete(el);
  return true;
}

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
    if (tag === 'style' && isStyleOrScript(el)) {
      // A sheet whose `media` can hold nowhere here, `print`, is left
      // out; any other is under it, as though an `@media` block of it
      // were around all of it (HTML 4.2.6, 4.2.4).
      const media = sheetConditions(attr(el, 'media') ?? '');
      if (media !== false && !DISABLED_SHEETS.has(el)) {
        sheets.push({
          kind: 'inline',
          text: rawTextOf(el),
          element: el,
          media,
        });
      }
    } else if (tag === 'link' && !isForeign(el)) {
      const rel = (attr(el, 'rel') ?? '').toLowerCase();
      const href = attr(el, 'href');
      if (href && rel.split(/\s+/).includes('stylesheet')) {
        // One left out is not asked for either. One under a width,
        // `(max-width: 600px)`, is, whatever the width: as a browser
        // asks for it, and as an `@import` under one is asked for.
        const media = sheetConditions(attr(el, 'media') ?? '');
        if (media !== false) {
          if (!DISABLED_SHEETS.has(el)) {
            sheets.push({ kind: 'link', href, element: el, media });
          }
          facts.resources.push(el);
        }
      } else if (isStylePreload(el)) facts.resources.push(el);
    } else if (tag === 'script' && isStyleOrScript(el)) {
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
      if (imageUrlOf(el) && !isForeign(el)) facts.resources.push(el);
    } else if (tag === 'svg') {
      if (!inDrawing(el)) facts.drawings.push(el);
    } else if (shadow) {
      continue;
    } else if (tag === 'title' && facts.title === null && !isForeign(el)) {
      facts.title = rawTextOf(el).trim();
    } else if (tag === 'base' && facts.base === null && !isForeign(el)) {
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

/** The elements whose attributes the scan reads (`scanElements`), by the
 *  name `tagOf` has for them: a change to another's says nothing to it. A
 *  `<picture>`'s `<img>` is one by where it stands, which no attribute
 *  changes. */
const FACT_TAGS = new Set([
  'style',
  'link',
  'script',
  'img',
  'image',
  'object',
  'embed',
  'video',
  'input',
  'svg',
  'title',
  'base',
]);

/**
 * Whether a change can change what `HtmlSource.facts` finds: one to the
 * tree's shape, a shadow tree attached, the text of a sheet or a title,
 * and an attribute of an element the scan reads one of. Anything new
 * `scanElements` reads joins `FACT_TAGS`, or what reads it here, or a
 * script's change to it leaves the document's sheets, scripts or images
 * as they were.
 */
function changesFacts(changes: readonly HtmlChange[]): boolean {
  for (const change of changes) {
    if (change.type === 'attributes') {
      if (FACT_TAGS.has(tagOf(change.target))) return true;
      continue;
    }
    if (change.type === 'characterData') {
      const parent = change.target.parent;
      if (!parent || !isElement(parent) || FACT_TEXT.has(tagOf(parent))) {
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
}

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

/** What both of a document's parsers do to a tree, for `HtmlSource`: the HTML
 *  parser's handler, and the XML parser's. */
class TreeHandler extends DomHandler {
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

  /** Where the next node goes where that is not the end of the current
   *  node: in front of a table, for what is foster parented, at the end of
   *  the `<html>` or the document, for a comment after the body (HTML
   *  13.2.6.1, "the appropriate place for inserting a node"). */
  place: { parent: ParentNode; before: ChildNode | null } | null = null;

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
    const place = this.place;
    if (place) {
      putNode(place.parent, node, place.before);
      // foster parented, which no record of a chunk says
      if (record && place.before) record.unknown = true;
      this.lastNode = null;
      return;
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

  override ontext(data: string): void {
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
 * domhandler's handler, building what `DocumentParser` decides: an element
 * for each start tag it inserts, text and comments where it says, and the
 * one rule of HTML's tree construction about text that the parser leaves to
 * it: a newline straight after the start tag of a `<pre>`, a `<listing>` or
 * a `<textarea>` is not content (HTML 13.2.6.4.7, "newlines at the start of
 * pre blocks are ignored as an authoring convenience"). Without it every
 * code block written `<pre>` and a line break began with an empty line. A
 * chunk of a stream that ends between the tag and the newline keeps the
 * rule, since the handler does.
 */
class Handler extends TreeHandler {
  private _afterPre = false;
  /** Whether a `<template shadowrootmode>` attaches a shadow root, as it
   *  does in a document a browser's parser builds, and not in a fragment
   *  parsed for `innerHTML` (HTML 13.2.6.4.4). */
  declarative = true;

  /** How many `<p>`s are open, which saves every block's start tag a walk
   *  of the stack to find there is none to close. */
  paragraphs = 0;

  /** HTML's form element pointer (13.2.4.4): the `<form>` the parser met
   *  last, which outlives its end on the stack, and until its own end tag
   *  turns another away and owns the controls that come. */
  form: Element | null = null;

  /** The formatting elements of the parser's list that are open, which
   *  saves the list's every reconstruction a walk of the stack. */
  readonly openFormatting = new Set<Element>();

  /** The stack of open nodes, bottom first, the document's root under all
   *  of them, as the parser reads and rearranges it. */
  get openNodes(): ParentNode[] {
    return this.tagStack;
  }

  /** No text is written on to from here: what comes next is a node of its
   *  own. */
  breakText(): void {
    this.lastNode = null;
  }

  /**
   * An element for a start tag the parser inserts, at the end of what is
   * open or at `place`. A `<template shadowrootmode>` that the element open
   * can host a shadow root from is that root instead (`_shadowRoot`).
   */
  override onopentag(name: string, attribs: Record<string, string>): void {
    if (name === 'p') this.paragraphs += 1;
    if (name === 'template' && this._shadowRoot(attribs)) return;
    super.onopentag(name, attribs);
    const opened = this.tagStack[this.tagStack.length - 1] as Element;
    if (this.marksSheets && (name === 'link' || name === 'style')) {
      PARSER_SHEETS.add(opened);
    }
    if (MARKED.has(name)) {
      const namespace = namespaceIn(opened.parent);
      if (
        namespace !== undefined &&
        !(namespace === SVG_NS && (name === 'style' || name === 'script'))
      ) {
        opened.namespace = namespace;
      }
    }
    if (attribs.customelementregistry !== undefined) {
      NULL_REGISTRY.add(opened);
      nullRegistriesParsed = true;
    }
    if (
      this.form &&
      FORM_CONTROLS.has(name) &&
      !isForeign(opened) &&
      !this.tagStack.includes(this.form)
    ) {
      PARSED_FORMS.set(opened, this.form);
    }
    this._afterPre =
      name === 'pre' || name === 'listing' || name === 'textarea';
  }

  /** An element made for what the adoption agency or a reconstruction of
   *  the formatting elements makes again, which the parser puts in place. */
  made(name: string, attribs: Record<string, string>): Element {
    const el = new Element(name, attribs);
    this.inserted?.push(el);
    if (this.recording) this.recording.unknown = true;
    return el;
  }

  /** What the adoption agency moves: taken from where it is, which no
   *  record of a chunk says. */
  moved(): void {
    if (this.recording) this.recording.unknown = true;
    this.lastNode = null;
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

  /** The attributes of a second `<html>` or `<body>` that the first has
   *  none of, set on it — and told, where a chunk is recorded. */
  mergeAttributes(el: Element, attribs: Record<string, string>): void {
    for (const key in attribs) {
      if (el.attribs[key] !== undefined) continue;
      el.attribs[key] = attribs[key];
      this.recording?.attributes.push({ target: el, name: key, old: null });
    }
  }

  /** Move into a `<body>` written at the top of a fragment what went
   *  before it there from the first thing that is not head content on. */
  adopt(body: Element): void {
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

  /** Take what stands `fromTop` under what is open off the stack and leave
   *  all it holds open, which is the tree staying as it is. */
  removeOpen(fromTop: number): void {
    const [gone] = this.tagStack.splice(this.tagStack.length - 1 - fromTop, 1);
    if (gone instanceof Element && gone.name === 'p') this.paragraphs -= 1;
    this.openFormatting.delete(gone as Element);
  }

  override onclosetag(name?: string): void {
    if (name === 'p') this.paragraphs -= 1;
    this._afterPre = false;
    const closing = this.tagStack[this.tagStack.length - 1];
    super.onclosetag();
    if (this.openFormatting.size) {
      this.openFormatting.delete(closing as Element);
    }
    if (closing instanceof Element && closing.name === 'script') {
      this.closedScript = closing;
    }
  }

  override oncomment(data: string): void {
    this._afterPre = false;
    super.oncomment(data.includes('\0') ? data.replace(/\0/g, '\ufffd') : data);
  }

  override onprocessinginstruction(name: string, data: string): void {
    this._afterPre = false;
    super.onprocessinginstruction(name, data);
  }

  override ontext(data: string): void {
    if (this._afterPre) {
      this._afterPre = false;
      const skip = data.startsWith('\r\n') ? 2 : data.startsWith('\n') ? 1 : 0;
      if (skip) {
        if (data.length === skip) return;
        data = data.slice(skip);
      }
    }
    const place = this.place;
    if (place) {
      this._textAt(place, data);
      return;
    }
    super.ontext(data);
  }

  /** Text where `place` says, on the end of a text just before it, where
   *  there is one, as HTML's parser puts it (13.2.6.1, "insert a
   *  character"). */
  private _textAt(
    place: { parent: ParentNode; before: ChildNode | null },
    data: string,
  ): void {
    const { parent, before } = place;
    const prev = before
      ? before.prev
      : (parent.children[parent.children.length - 1] ?? null);
    if (prev instanceof Text) {
      prev.data += data;
      if (this.recording) this.recording.unknown = true;
    } else {
      const node = new Text(data);
      this.addNode(node);
    }
    this.lastNode = null;
  }
}

/** The documents XML's parser made or a script's API did, each by its
 *  content type: an XML document is one of these, whatever is in it. */
export const XML_DOCUMENTS = new WeakMap<Document, string>();

/** Whether any has been made in this process, which most never see. */
let xmlDocumentsMade = false;
export function anyXmlDocuments(): boolean {
  return xmlDocumentsMade;
}

/** A document made an XML document of a content type. */
export function markXmlDocument(document: Document, type: string): void {
  XML_DOCUMENTS.set(document, type);
  xmlDocumentsMade = true;
}

/** Whether a document is an XML document, which any element at its top is
 *  the root element of, where only an `<html>` is in HTML's. */
export function isXmlDocument(document: AnyNode | null): boolean {
  return !!document && XML_DOCUMENTS.has(document as Document);
}

/** Whether an element is the document's root, as `:root` has it: an `<html>`
 *  whose parent is the document, or which has none, as the one the cascade
 *  supplies where the markup has none — and not a shadow tree's, whose top is
 *  under its host. Taken for the root, the top of every tree was what a `rem`
 *  styled after it measured from, and GitHub's, sized in `rem`s, measured each
 *  build from the last. So were a fragment's elements and a `<body>` written
 *  alone, each of them the document's child: a `rem` came to the font size of
 *  the one styled before it, and in a restyle in place of the last there is. */
export function isRootElement(el: Element): boolean {
  const parent = el.parent;
  if (el.name !== 'html')
    return parent?.type === 'root' && isXmlDocument(parent);
  return !parent || (parent.type === 'root' && !(parent instanceof ShadowRoot));
}

/** The `<link>` a style sheet's processing instruction stands for, by the
 *  instruction: what everything that reads sheets reads has an element. */
const INSTRUCTION_SHEETS = new WeakMap<AnyNode, Element>();

/**
 * The style sheets an XML document's prolog links (CSSOM's "xml-stylesheet"
 * rules): an `<?xml-stylesheet?>` before the root element, of no type or of
 * CSS's, that is no alternate. Each is a `<link>` of the document's that is
 * in no element, so everything that holds a page or a script back for a sheet
 * of its parser's holds them for this one, and takes it to come first
 * (`compareDocumentPosition` finds it among no children).
 */
export function instructionSheets(document: Document): Element[] {
  const out: Element[] = [];
  for (const kid of document.children) {
    if (isElement(kid)) break;
    if (kid.type !== 'directive' || kid.name !== '?xml-stylesheet') continue;
    let link = INSTRUCTION_SHEETS.get(kid);
    if (!link) {
      const said = pseudoAttributes(kid.data);
      const type = said.type?.trim().toLowerCase();
      const css =
        said.href &&
        (!type || type === 'text/css') &&
        said.alternate?.trim() !== 'yes';
      if (!css) continue;
      link = new Element('link', { ...said, rel: 'stylesheet' });
      link.namespace = HTML_NAMESPACE;
      link.parent = document;
      PARSER_SHEETS.add(link);
      INSTRUCTION_SHEETS.set(kid, link);
    }
    out.push(link);
  }
  return out;
}

/** What an instruction says in the form of attributes (XML Stylesheet 1.0),
 *  its references read: nothing, where any of it is not in that form. */
function pseudoAttributes(data: string): Record<string, string> {
  const said: Record<string, string> = {};
  const rest = data.replace(
    /\s*([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/g,
    (_, name: string, double?: string, single?: string) => {
      said[name] = decodeXmlText(double ?? single ?? '');
      return '';
    },
  );
  return rest ? {} : said;
}

/** Character references, and XML's five, read. */
function decodeXmlText(text: string): string {
  return text.replace(
    /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([\da-fA-F]+));/g,
    (whole, name?: string, dec?: string, hex?: string) => {
      if (name) return XML_NAMED[name];
      const code = dec ? Number(dec) : parseInt(hex!, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

const XML_NAMED: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** The texts a CDATA section made: a text to everything but a serializer. */
export const CDATA_SECTIONS = new WeakSet<AnyNode>();

/** What stands in for a document that is not well-formed. */
export function parserError(): Element {
  const namespace = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';
  const error = new Element('parsererror', { xmlns: namespace });
  error.namespace = namespace;
  const text = new Text('XML Parsing Error: not well-formed');
  text.parent = error;
  error.children.push(text);
  return error;
}

/** XML read: what is in the document, and whether it was well-formed. */
export interface XmlRead {
  kids: ChildNode[];
  wellFormed: boolean;
  /** The markup as `readProlog` left it, which a second reading starts
   *  from (`HtmlSource.setXml`). */
  text: string;
}

/**
 * XML parsed into nodes, each element in the namespace its `xmlns`
 * attributes put it in (Namespaces in XML 1.0, 6), and whether it was
 * well-formed: every end tag the one open, every element closed, one
 * root, no character a decoder had to replace. htmlparser2 reads XML
 * leniently, and a document that is not well-formed must run nothing —
 * Acid3's second XHTML frame has a stray `</strong>`.
 */
export function xmlTree(raw: string): XmlRead {
  const prolog = readProlog(raw);
  const { text } = prolog;
  const { parser, handler } = createXmlParser(prolog.defaults);
  handler.wellFormed = prolog.wellFormed && !text.includes('\ufffd');
  parser.write(text);
  if (parser.opened > 0) handler.wellFormed = false;
  parser.end();
  const kids = handler.root.children;
  if (
    kids.filter(isElement).length !== 1 ||
    kids.some((k) => k instanceof Text && /[^ \t\n\r]/.test(k.data))
  ) {
    handler.wellFormed = false;
  }
  for (const kid of kids) kid.parent = null;
  return { kids, wellFormed: handler.wellFormed, text };
}

/**
 * What XML's parser does to a tree: names and attributes as they were
 * written, each element in the namespace in scope for it, a CDATA section a
 * text that remembers it was one, and a prefix nothing bound the end of being
 * well-formed. None of what HTML's parser does for a document, so there is
 * no `<head>` a document did not write and no `<tbody>` either.
 */
class XmlHandler extends TreeHandler {
  /** The prefixes in scope, an entry for each element open and the
   *  document's under them, and the default namespace's under `''`. */
  private _scopes: Map<string, string>[] = [new Map()];
  /** Whether nothing has been read yet that a well-formed document has not. */
  wellFormed = true;
  /** The attributes an `<!ATTLIST>` gives what does not say them. */
  defaults: ReadonlyMap<string, ReadonlyMap<string, string>> | null = null;
  /** Asked of each `<script>` the parser closes: true pauses the parser
   *  behind it, for `HtmlSource` to hold it (`_readOnXml`). */
  stops: ((script: Element) => boolean) | null = null;
  /** Pauses the parser, for what `stops` said. */
  pause: (() => void) | null = null;

  override onopentag(name: string, attribs: Record<string, string>): void {
    const scopes = this._scopes;
    const outer = scopes[scopes.length - 1];
    let own = outer;
    for (const key in attribs) {
      if (key !== 'xmlns' && !key.startsWith('xmlns:')) continue;
      if (own === outer) own = new Map(outer);
      own.set(key === 'xmlns' ? '' : key.slice(6), attribs[key]);
    }
    const defaults = this.defaults?.get(name);
    if (defaults) {
      for (const [key, value] of defaults) attribs[key] ??= value;
    }
    const colon = name.indexOf(':');
    const prefix = colon < 0 ? '' : name.slice(0, colon);
    if (prefix && !own.has(prefix)) this.wellFormed = false;
    for (const key in attribs) {
      const at = key.indexOf(':');
      const of = at < 0 ? '' : key.slice(0, at);
      if (of && of !== 'xml' && of !== 'xmlns' && !own.has(of)) {
        this.wellFormed = false;
      }
    }
    super.onopentag(name, attribs);
    const opened = this.tagStack[this.tagStack.length - 1] as Element;
    opened.namespace = own.get(prefix) ?? '';
    // made, as the HTML parser makes one, of no registry where it says so,
    // and so what it holds (HTML's scoped registries)
    markParsedRegistry(opened);
    if (this.marksSheets) {
      const tag = tagOf(opened);
      if (tag === 'link' || tag === 'style') PARSER_SHEETS.add(opened);
    }
    scopes.push(own);
  }

  override onclosetag(): void {
    this._scopes.pop();
    const closing = this.tagStack[this.tagStack.length - 1];
    super.onclosetag();
    if (
      closing instanceof Element &&
      tagOf(closing) === 'script' &&
      this.stops?.(closing)
    ) {
      this.pause?.();
    }
  }

  override oncdatastart(): void {
    this.lastNode = null;
  }

  override oncdataend(): void {
    if (this.lastNode) CDATA_SECTIONS.add(this.lastNode as Text);
    this.lastNode = null;
  }

  override onprocessinginstruction(name: string, data: string): void {
    // the prolog's declaration is no node (XML 1.0, 2.8)
    if (/^\?xml$/i.test(name)) return;
    super.onprocessinginstruction(
      name,
      name.startsWith('!')
        ? data
        : data.slice(name.length).replace(/\?$/, '').replace(/^\s+/, ''),
    );
  }
}

/** What `XmlParser` reads of htmlparser2's parser beyond its typed surface:
 *  the names open, top first, and a tag's name. */
interface XmlParserInternals {
  readonly stack: string[];
  getSlice(start: number, end: number): string;
}

/** htmlparser2's parser in XML's mode, with what it does not say kept: an
 *  end tag that is not the one open ends being well-formed. */
class XmlParser extends Parser {
  override onclosetag(start: number, endIndex: number): void {
    const self = this as unknown as XmlParserInternals;
    if (self.stack[0] !== self.getSlice(start, endIndex)) {
      (this.handler as XmlHandler).wellFormed = false;
    }
    super.onclosetag(start, endIndex);
  }

  readonly handler: XmlHandler;

  constructor(handler: XmlHandler) {
    super(handler, { xmlMode: true, decodeEntities: true });
    this.handler = handler;
  }

  /** How many elements are open. */
  get opened(): number {
    return (this as unknown as XmlParserInternals).stack.length;
  }
}

function createXmlParser(defaults: XmlHandler['defaults'] = null): {
  parser: XmlParser;
  handler: XmlHandler;
} {
  const handler = new XmlHandler(null, {
    withStartIndices: false,
    withEndIndices: false,
  });
  handler.defaults = defaults;
  const parser = new XmlParser(handler);
  handler.pause = () => parser.pause();
  return { parser, handler };
}

/** Whether a node is or holds a script that blocks the parser. */
function holdsBlockingScript(node: AnyNode, scripting: boolean): boolean {
  if (!isElement(node)) return false;
  if (blocksParser(node, scripting)) return true;
  return node.children.some((kid) => holdsBlockingScript(kid, scripting));
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

/** What is neither white space nor a NULL. */
const NOT_SPACE_OR_NULL = /[^ \t\n\f\r\0]/;

/** White space at the start of a text, and what is not white space. */
const LEADING_SPACE = /^[\t\n\f\r ]+/;
const NOT_SPACES = /[^\t\n\f\r ]/g;

/** What the tokenizer is set to where the tree builder makes no element of
 *  a tag that would have started raw text. */
const NO_SEQUENCE = new Uint8Array(0);

/** What ends a `<noscript>` read as raw text, `</noscript`, as htmlparser2's
 *  tokenizer spells the end of the elements it reads so. */
const NOSCRIPT_END = new Uint8Array(
  [...'</noscript'].map((c) => c.charCodeAt(0)),
);

/** The end tags of the current node that "in body" has more to do for than
 *  closing it. */
const SPECIAL_END = new Set([
  'applet',
  'body',
  'form',
  'html',
  'marquee',
  'object',
  'template',
]);

/** The end tags each of a table's modes ignores. */
const IGNORED_IN_TABLE = new Set([
  'body',
  'caption',
  'col',
  'colgroup',
  'html',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
]);
const IGNORED_IN_CAPTION = new Set([
  'body',
  'col',
  'colgroup',
  'html',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
]);
const IGNORED_IN_BODY_OF_TABLE = new Set([
  'body',
  'caption',
  'col',
  'colgroup',
  'html',
  'td',
  'th',
  'tr',
]);
const IGNORED_IN_ROW = new Set([
  'body',
  'caption',
  'col',
  'colgroup',
  'html',
  'td',
  'th',
]);
const IGNORED_IN_CELL = new Set(['body', 'caption', 'col', 'colgroup', 'html']);

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

function createParser(
  declarative = true,
  document = false,
): {
  parser: DocumentParser;
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
  if (document) parser.asDocument();
  return { parser, handler };
}

/** What `DocumentParser` reads of htmlparser2's parser beyond its typed
 *  surface: the stack of open tag names, top first, its frames of what those
 *  hold, the tag being read and its tokenizer. Held to htmlparser2 12 by
 *  `test/html/document.test.ts`. */
interface ParserInternals {
  readonly stack: string[];
  readonly foreignContext: number[];
  readonly cbs: Handler;
  readonly tokenizer: TokenizerInternals;
  attribs: Record<string, string> | null;
  tagname: string;
  openTagStart: number;
  startIndex: number;
  endIndex: number;
  readTagName(start: number, endIndex: number): string;
  getSlice(start: number, end: number): string;
  popElement(implied: boolean): void;
}

/** What the parser reads of htmlparser2's tokenizer: whether the tag it
 *  has just read starts raw text, which the tree builder may say it does
 *  not (13.2.6.2). */
interface TokenizerInternals {
  isSpecial: boolean;
  currentSequence: Uint8Array;
}

/** HTML's insertion modes (13.2.4.1). "text" is the tokenizer's here, and
 *  "in select" and "in select in table" are gone from HTML. */
const INITIAL = 0;
const BEFORE_HTML = 1;
const BEFORE_HEAD = 2;
const IN_HEAD = 3;
const IN_HEAD_NOSCRIPT = 4;
const AFTER_HEAD = 5;
const IN_BODY = 6;
const IN_TABLE = 7;
const IN_TABLE_TEXT = 8;
const IN_CAPTION = 9;
const IN_COLUMN_GROUP = 10;
const IN_TABLE_BODY = 11;
const IN_ROW = 12;
const IN_CELL = 13;
const IN_TEMPLATE = 14;
const AFTER_BODY = 15;
const IN_FRAMESET = 16;
const AFTER_FRAMESET = 17;
const AFTER_AFTER_BODY = 18;
const AFTER_AFTER_FRAMESET = 19;

/** A table's row groups, and the end tags HTML takes by table scope. */
const SECTIONS = new Set(['tbody', 'thead', 'tfoot']);
const TABLE_END_TAGS = new Set([
  ...SECTIONS,
  'caption',
  'table',
  'td',
  'th',
  'tr',
]);

/** Where foster parenting takes what is out of place: what is inserted while
 *  one of these is the current node (13.2.6.1). */
const FOSTERING = new Set(['table', ...SECTIONS, 'tr']);

/** Where the stack is cleared back to, for a table, its body and a row. */
const TABLE_CONTEXT = new Set(['table', 'template', 'html']);
const TABLE_BODY_CONTEXT = new Set([...SECTIONS, 'template', 'html']);
const ROW_CONTEXT = new Set(['tr', 'template', 'html']);

/** The start tags a cell, a caption, a row or a row group closes for. */
const CELL_ENDERS = new Set([
  'caption',
  'col',
  'colgroup',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
]);

/** The start tags that close a `<p>` in button scope and are inserted. */
const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'header',
  'hgroup',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'search',
  'section',
  'summary',
  'ul',
]);

/** The end tags that pop to their element where it is in scope. */
const BLOCK_ENDS = new Set([...BLOCKS, 'button', 'listing', 'pre', 'select']);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** The elements a list keeps for what comes after them, and brings back
 *  where one is closed from under it (13.2.4.3). */
const FORMATTING = new Set([
  'a',
  'b',
  'big',
  'code',
  'em',
  'font',
  'i',
  'nobr',
  's',
  'small',
  'strike',
  'strong',
  'tt',
  'u',
]);

/** What "in head" takes wherever it is asked to (13.2.6.4.4). */
const HEAD_TAGS = new Set([
  'base',
  'basefont',
  'bgsound',
  'link',
  'meta',
  'noframes',
  'script',
  'style',
  'template',
  'title',
]);

/** The start tags "in body" has a rule of its own for, other than a block's
 *  and a formatting element's (13.2.6.4.7). */
const BODY_RULES = new Set([
  ...HEAD_TAGS,
  ...HEADINGS,
  ...TABLE_END_TAGS,
  'a',
  'applet',
  'area',
  'body',
  'br',
  'button',
  'col',
  'colgroup',
  'dd',
  'dt',
  'embed',
  'form',
  'frame',
  'frameset',
  'head',
  'hr',
  'html',
  'iframe',
  'image',
  'img',
  'input',
  'keygen',
  'li',
  'listing',
  'marquee',
  'math',
  'nobr',
  'noembed',
  'noscript',
  'object',
  'optgroup',
  'option',
  'param',
  'plaintext',
  'pre',
  'rb',
  'rp',
  'rt',
  'rtc',
  'select',
  'source',
  'svg',
  'textarea',
  'track',
  'wbr',
  'xmp',
]);

/** HTML's scopes (13.2.4.2), but for `html`: there is one, under everything. */
const SCOPE = new Set([
  'applet',
  'caption',
  'marquee',
  'object',
  'select',
  'table',
  'td',
  'template',
  'th',
]);
const LIST_SCOPE = new Set([...SCOPE, 'ol', 'ul']);
const BUTTON_SCOPE = new Set([...SCOPE, 'button']);
const TABLE_SCOPE = new Set(['table', 'template']);
const NO_SCOPE = new Set<string>();

/** HTML's special category (13.2.4.2), which "any other end tag" stops at
 *  and the adoption agency's furthest block is one of. */
const SPECIAL = new Set([
  ...BLOCKS,
  ...HEADINGS,
  ...TABLE_END_TAGS,
  ...HEAD_TAGS,
  'applet',
  'area',
  'body',
  'br',
  'button',
  'col',
  'colgroup',
  'dd',
  'dt',
  'embed',
  'form',
  'frame',
  'frameset',
  'head',
  'hr',
  'html',
  'iframe',
  'img',
  'input',
  'keygen',
  'li',
  'listing',
  'marquee',
  'noembed',
  'noscript',
  'object',
  'param',
  'plaintext',
  'pre',
  'select',
  'source',
  'textarea',
  'track',
  'wbr',
  'xmp',
]);
/** The same in SVG and MathML: their integration points. */
const SPECIAL_FOREIGN = new Set([
  'mi',
  'mo',
  'mn',
  'ms',
  'mtext',
  'annotation-xml',
  'foreignObject',
  'desc',
  'title',
]);

/** What an `<li>`, a `<dd>` and a `<dt>` look past for one to close. */
const SPECIAL_TO_AN_ITEM = new Set(
  [...SPECIAL].filter(
    (name) => name !== 'address' && name !== 'div' && name !== 'p',
  ),
);

/** What "generate implied end tags" pops, and what it pops "thoroughly". */
const ENDS_IMPLIED = new Set([
  'dd',
  'dt',
  'li',
  'optgroup',
  'option',
  'p',
  'rb',
  'rp',
  'rt',
  'rtc',
]);
const ENDS_THOROUGHLY = new Set([
  ...ENDS_IMPLIED,
  'caption',
  'colgroup',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
]);

/** The elements whose text the tokenizer reads raw, so that what comes in
 *  them is text whatever the mode (13.2.6.4.8, "text"). A `<plaintext>` is
 *  not one: its text is the body's, which the formatting elements open
 *  again around. */
const RAW_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

/** The elements a form owns (HTML 4.10.18.1, "listed"). */
const FORM_CONTROLS = new Set([
  'button',
  'fieldset',
  'input',
  'object',
  'output',
  'select',
  'textarea',
]);

/** The controls HTML's parser gave the `<form>` it met last, which they are
 *  not in: `<table><form><tr><td><input>` closes the form as it opens. */
const PARSED_FORMS = new WeakMap<Element, Element>();

/** The form the parser gave a control that is in none. */
export function parsedForm(el: Element): Element | null {
  return PARSED_FORMS.get(el) ?? null;
}

/** A formatting element on the parser's list, with the attributes of the
 *  token it was made for, which what is made again for it takes. Null is a
 *  marker. */
type Formatting = {
  el: Element;
  name: string;
  attribs: Record<string, string>;
} | null;

/** The attributes of a formatting element's token that had none, shared. */
const NO_ATTRIBUTES: Record<string, string> = Object.freeze({}) as Record<
  string,
  string
>;

/** The public identifiers that put a document in quirks mode, by what each
 *  starts with (13.2.6.4.1), lower-cased. */
const QUIRKS_PREFIXES = [
  '+//silmaril//dtd html pro v0r11 19970101//',
  '-//as//dtd html 3.0 aswedit + extensions//',
  '-//advasoft ltd//dtd html 3.0 aswedit + extensions//',
  '-//ietf//dtd html 2.0 level 1//',
  '-//ietf//dtd html 2.0 level 2//',
  '-//ietf//dtd html 2.0 strict level 1//',
  '-//ietf//dtd html 2.0 strict level 2//',
  '-//ietf//dtd html 2.0 strict//',
  '-//ietf//dtd html 2.0//',
  '-//ietf//dtd html 2.1e//',
  '-//ietf//dtd html 3.0//',
  '-//ietf//dtd html 3.2 final//',
  '-//ietf//dtd html 3.2//',
  '-//ietf//dtd html 3//',
  '-//ietf//dtd html level 0//',
  '-//ietf//dtd html level 1//',
  '-//ietf//dtd html level 2//',
  '-//ietf//dtd html level 3//',
  '-//ietf//dtd html strict level 0//',
  '-//ietf//dtd html strict level 1//',
  '-//ietf//dtd html strict level 2//',
  '-//ietf//dtd html strict level 3//',
  '-//ietf//dtd html strict//',
  '-//ietf//dtd html//',
  '-//metrius//dtd metrius presentational//',
  '-//microsoft//dtd internet explorer 2.0 html strict//',
  '-//microsoft//dtd internet explorer 2.0 html//',
  '-//microsoft//dtd internet explorer 2.0 tables//',
  '-//microsoft//dtd internet explorer 3.0 html strict//',
  '-//microsoft//dtd internet explorer 3.0 html//',
  '-//microsoft//dtd internet explorer 3.0 tables//',
  '-//netscape comm. corp.//dtd html//',
  '-//netscape comm. corp.//dtd strict html//',
  "-//o'reilly and associates//dtd html 2.0//",
  "-//o'reilly and associates//dtd html extended 1.0//",
  "-//o'reilly and associates//dtd html extended relaxed 1.0//",
  '-//sq//dtd html 2.0 hotmetal + extensions//',
  '-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//',
  '-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//',
  '-//spyglass//dtd html 2.0 extended//',
  '-//sun microsystems corp.//dtd hotjava html//',
  '-//sun microsystems corp.//dtd hotjava strict html//',
  '-//w3c//dtd html 3 1995-03-24//',
  '-//w3c//dtd html 3.2 draft//',
  '-//w3c//dtd html 3.2 final//',
  '-//w3c//dtd html 3.2//',
  '-//w3c//dtd html 3.2s draft//',
  '-//w3c//dtd html 4.0 frameset//',
  '-//w3c//dtd html 4.0 transitional//',
  '-//w3c//dtd html experimental 19960712//',
  '-//w3c//dtd html experimental 970421//',
  '-//w3c//dtd w3 html//',
  '-//w3o//dtd w3 html 3.0//',
  '-//webtechs//dtd mozilla html 2.0//',
  '-//webtechs//dtd mozilla html//',
];
const QUIRKS_EXACT = new Set([
  '-//w3o//dtd w3 html strict 3.0//en//',
  '-/w3c/dtd html 4.0 transitional/en',
  'html',
]);

/**
 * Whether a doctype, as htmlparser2 hands it over (`!DOCTYPE …`), puts the
 * document in quirks mode (13.2.6.4.1). Only `<p><table>` asks, and only
 * of a document with no doctype or an old one.
 */
function quirksDoctype(value: string): boolean {
  const m =
    /^!doctype(?:\s+([^\s>]+))?(?:\s+public\s*(?:"([^"]*)"?|'([^']*)'?))?(?:\s+(?:system\s*)?(?:"([^"]*)"?|'([^']*)'?))?/i.exec(
      value,
    );
  if (!m || !m[1] || m[1].toLowerCase() !== 'html') return true;
  const pub = (m[2] ?? m[3])?.toLowerCase();
  const sys = (m[4] ?? m[5])?.toLowerCase();
  if (sys === 'http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd') {
    return true;
  }
  if (pub === undefined) return false;
  if (QUIRKS_EXACT.has(pub)) return true;
  if (QUIRKS_PREFIXES.some((prefix) => pub.startsWith(prefix))) return true;
  return (
    sys === undefined &&
    (pub.startsWith('-//w3c//dtd html 4.01 frameset//') ||
      pub.startsWith('-//w3c//dtd html 4.01 transitional//'))
  );
}

/**
 * What an SVG or MathML element made in `around`, under `holder`, holds
 * (13.2.6.5): a name is an integration point in its own language only, so
 * in SVG an `<mi>` and a `<math>` are SVG's, and in MathML a `<title>` and
 * an `<svg>` MathML's, but for an `<svg>` an `<annotation-xml>` opens, and
 * an `<annotation-xml>` that says it holds HTML is a point. From HTML, an
 * `<svg>` and a `<math>` start their languages.
 */
function frameOf(
  name: string,
  around: number,
  holder: string | undefined,
  attribs: Record<string, string>,
): number {
  if (around === NOT_FOREIGN) {
    return name === 'svg' ? IN_SVG : name === 'math' ? IN_MATHML : NOT_FOREIGN;
  }
  if (around === IN_SVG) {
    return SVG_POINTS.has(name.toLowerCase()) ? NOT_FOREIGN : IN_SVG;
  }
  if (name === 'svg' && holder === 'annotation-xml') return IN_SVG;
  return MATHML_POINTS.has(name) ||
    (name === 'annotation-xml' &&
      HTML_ENCODINGS.has((attribs.encoding ?? '').toLowerCase()))
    ? NOT_FOREIGN
    : IN_MATHML;
}

/** Whether attributes are the same, for the list's three of a kind. */
function sameAttributes(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  let count = 0;
  for (const key in a) {
    if (b[key] !== a[key]) return false;
    count += 1;
  }
  for (const _ in b) count -= 1;
  return count === 0;
}

/** A node put in `parent` before `before`, or at its end, taken from
 *  wherever it was. Nothing is told: the parser is building the tree. */
function putNode(
  parent: ParentNode,
  node: ChildNode,
  before: ChildNode | null = null,
): void {
  takeNode(node);
  const kids = parent.children;
  const at = before ? kids.indexOf(before) : -1;
  const prev =
    at >= 0 ? (kids[at - 1] ?? null) : (kids[kids.length - 1] ?? null);
  if (at >= 0) kids.splice(at, 0, node);
  else kids.push(node);
  node.parent = parent;
  node.prev = prev;
  node.next = at >= 0 ? before : null;
  if (prev) prev.next = node;
  if (at >= 0 && before) before.prev = node;
}

/** A node taken out of its parent, if it has one. */
function takeNode(node: ChildNode): void {
  const parent = node.parent;
  if (!parent) return;
  const kids = parent.children;
  const at = kids.indexOf(node);
  if (at >= 0) kids.splice(at, 1);
  if (node.prev) node.prev.next = node.next;
  if (node.next) node.next.prev = node.prev;
  node.prev = null;
  node.next = null;
  node.parent = null;
}

/** htmlparser2's foreign contexts, which it does not export. */
const NOT_FOREIGN = 0;
const IN_SVG = 1;
const IN_MATHML = 2;

/** The names htmlparser2 keeps a frame of `foreignContext` for, which go by
 *  the name and not the language: `popElement` drops one for each. */
const FRAMED = new Set([
  'annotation-xml',
  'desc',
  'foreignObject',
  'math',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'svg',
  'title',
]);

/**
 * What the parser says of an element it made in a drawing or a `<math>`
 * (`isForeign`): the names the scan and a page's reads take as HTML's, each of
 * which HTML's parser makes something else there. An `<img>` and an `<embed>`
 * end foreign content instead (`BREAKS_OUT`). SVG has a `<style>` and a
 * `<script>` of its own, so those say so in MathML alone (`isStyleOrScript`).
 */
const MARKED = new Set([
  'base',
  'image',
  'input',
  'link',
  'object',
  'script',
  'style',
  'title',
  'video',
]);

/**
 * The start tags that end foreign content, as all three engines have them
 * (HTML 13.2.6.5). A `<font>` with a `color`, a `face` or a `size` is one too,
 * which `_startTag` asks once its attributes are read.
 */
const BREAKS_OUT = new Set([
  'b',
  'big',
  'blockquote',
  'body',
  'br',
  'center',
  'code',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'hr',
  'i',
  'img',
  'li',
  'listing',
  'menu',
  'meta',
  'nobr',
  'ol',
  'p',
  'pre',
  'ruby',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tt',
  'u',
  'ul',
  'var',
]);

/**
 * htmlparser2's tokenizer, with HTML's tree construction in place of
 * htmlparser2's (13.2.6): the insertion modes, the list of active formatting
 * elements and the adoption agency, foster parenting, and the stack of open
 * elements its scopes are read from. htmlparser2 keeps a table of what each
 * start tag closes and asks the top of the stack alone, and closes the
 * nearest element of an end tag's name whatever stands between.
 *
 * A start tag is acted on once its attributes are read (`_tag`), since what
 * an `<input>` in a table, a `<font>` in a drawing or an `<annotation-xml>`
 * does turns on them. What is open is two stacks kept in step: htmlparser2's
 * of names, top first, with its frames of the language each holds, and the
 * handler's of nodes, the document's root under all of them. The tokenizer
 * decides raw text as it reads a tag's name, and is told so where the tree
 * builder makes no element of the tag (`_tag`).
 *
 * A source is a document or a fragment. A document is parsed as HTML's
 * parser parses one, into an `<html>` with its head and its body, and a
 * source becomes one with a doctype, an `<html>` or a `<head>` at its start,
 * or where `HtmlSource` says so (`asDocument`). A fragment is read as the
 * content of its context (`readIn`), or of a body the root stands in for:
 * no `<html>`, no `<head>`, and a `<body>` written in it takes in what came
 * before it.
 */
class DocumentParser extends Parser {
  private _mode = IN_BODY;
  /** The mode "in table text" goes back to. */
  private _original = IN_BODY;
  private _templateModes: number[] = [];
  /** The list of active formatting elements (13.2.4.3). */
  private _formatting: Formatting[] = [];
  private _framesetOk = true;
  /** Whether what is inserted goes in front of the table, where the current
   *  node is one of a table's parts (13.2.6.1). */
  private _foster = false;
  /** "In table text"'s pending characters, and whether all of them are
   *  white space. */
  private _pending: string[] = [];
  private _pendingSpace = true;
  private _head: Element | null = null;
  private _body: Element | null = null;
  private _quirks = false;
  /** Whether the source is a fragment, which no `<html>` holds. */
  private _fragment = true;
  /** Whether the fragment is read as an element's content (`readIn`), which
   *  nothing in it makes a document. */
  private _contextual = false;
  /** What a fragment is read in (`readIn`). */
  private _context = NOT_FOREIGN;
  /** What it is read as the content of, where that is HTML's: the part of a
   *  table a row is read in, a `<select>`, or a `<template>`, which holds
   *  any; '' for a body. */
  private _holder = '';
  /** The name of the element `_insert` made last, which a raw text element's
   *  start tag checks it made. */
  private _made = '';
  /** Whether a carriage return ended the last chunk, whose line feed a next
   *  one may start with. */
  private _carriage = false;
  /** Whether the document runs scripts, which reads a `<noscript>`'s
   *  content as text (13.2.6.4.4). */
  private _scripting = false;
  /** Whether a `<plaintext>` has started, after which the tokenizer reads
   *  everything as text, a NULL as U+FFFD among it. */
  private _plaintext = false;

  override isInForeignContext(): boolean {
    return (
      (this as unknown as ParserInternals).foreignContext[0] !== NOT_FOREIGN
    );
  }

  /** Parse as a document whose scripts run, where a `<noscript>` holds its
   *  content as text, or as one with scripting off, where it holds markup. */
  setScripting(on: boolean): void {
    this._scripting = on;
  }

  /** A document from its first token, as `HtmlSource` asks for one. */
  asDocument(): void {
    this._fragment = false;
    this._mode = INITIAL;
  }

  /** Read what comes as what an element of `namespace` holds, as `innerHTML`
   *  reads it (HTML 13.4): in SVG a `<path/>` closes itself and a `clipPath`
   *  keeps its capital, and read as HTML `<path/><path/>` nested. `holder` is
   *  the element's name where it is HTML's, and `form` the form around it. */
  readIn(
    namespace: string | undefined,
    holder: string,
    form: Element | null,
  ): void {
    const self = this as unknown as ParserInternals;
    this._context =
      namespace === SVG_NS
        ? IN_SVG
        : namespace === MATHML_NS
          ? IN_MATHML
          : NOT_FOREIGN;
    self.foreignContext[0] = this._context;
    this._holder = holder;
    this._contextual = true;
    self.cbs.form = form;
    if (holder === 'template') this._templateModes.push(IN_TEMPLATE);
    this._resetMode();
  }

  override reset(): void {
    super.reset();
    this._mode = this._fragment ? IN_BODY : INITIAL;
    this._original = IN_BODY;
    this._templateModes = [];
    this._formatting = [];
    this._framesetOk = true;
    this._foster = false;
    this._pending = [];
    this._head = null;
    this._body = null;
    this._quirks = false;
    this._carriage = false;
    this._plaintext = false;
  }

  /** A chunk with its line breaks as HTML's input stream has them (13.2.3.5):
   *  a carriage return and a line feed one line feed, and a carriage return
   *  alone too, across chunks as within one. */
  override write(chunk: string): void {
    if (this._carriage && chunk.charCodeAt(0) === 10) chunk = chunk.slice(1);
    this._carriage = chunk.charCodeAt(chunk.length - 1) === 13;
    if (chunk.includes('\r')) chunk = chunk.replace(/\r\n?/g, '\n');
    super.write(chunk);
  }

  // --- tokens -----------------------------------------------------------------

  override onopentagname(start: number, endIndex: number): void {
    const self = this as unknown as ParserInternals;
    // what broke out of a fragment's context left it until it closed
    if (!self.stack.length) self.foreignContext[0] = this._context;
    let name = self.readTagName(start, endIndex);
    const { foreignContext } = self;
    // SVG's casing, which it finds for an element open anywhere, as an end
    // tag wants, is only in SVG for a start tag
    if (foreignContext.length > 1 && foreignContext[0] !== IN_SVG) {
      name = name.toLowerCase();
    }
    self.endIndex = endIndex;
    self.openTagStart = self.startIndex;
    self.tagname = name;
    self.attribs = {};
  }

  override onopentagend(endIndex: number): void {
    const self = this as unknown as ParserInternals;
    self.endIndex = endIndex;
    this._tag(false);
    self.startIndex = endIndex + 1;
  }

  override onselfclosingtag(endIndex: number): void {
    const self = this as unknown as ParserInternals;
    self.endIndex = endIndex;
    this._tag(true);
    self.startIndex = endIndex + 1;
  }

  /** A start tag whose attributes are read. Where it started raw text in the
   *  tokenizer and the tree builder made no element of it, as it makes none
   *  of a `<textarea>` in a frameset, the text is HTML's after all. */
  private _tag(selfClosing: boolean): void {
    const self = this as unknown as ParserInternals;
    const name = self.tagname;
    const attribs = self.attribs ?? {};
    self.attribs = null;
    self.tagname = '';
    if (this._mode === IN_TABLE_TEXT) this._flushTableText();
    this._made = '';
    this._startTag(name, attribs, selfClosing);
    const tokenizer = self.tokenizer;
    if (
      tokenizer.isSpecial &&
      (this._made !== name || self.stack[0] !== name)
    ) {
      tokenizer.isSpecial = false;
      tokenizer.currentSequence = NO_SEQUENCE;
    } else if (
      name === 'noscript' &&
      this._scripting &&
      this._made === name &&
      self.stack[0] === name &&
      self.foreignContext[0] === NOT_FOREIGN
    ) {
      // where scripts run, what it holds is text, which the tokenizer reads
      // to its end tag as it reads a `<noembed>`'s
      tokenizer.isSpecial = true;
      tokenizer.currentSequence = NOSCRIPT_END;
    }
  }

  /** Whether the current node is one whose text the tokenizer reads raw. */
  private _inRawText(): boolean {
    const { stack, foreignContext } = this as unknown as ParserInternals;
    const top = stack[0];
    return (
      (RAW_ELEMENTS.has(top) || (top === 'noscript' && this._scripting)) &&
      (foreignContext.length === 1 || this._isHtml(0))
    );
  }

  override onclosetag(start: number, endIndex: number): void {
    const self = this as unknown as ParserInternals;
    const name = self.readTagName(start, endIndex);
    self.endIndex = endIndex;
    if (this._mode === IN_TABLE_TEXT) this._flushTableText();
    // what nearly every end tag is: the current node's, in a mode with
    // nothing to say of it, or the end of raw text, which HTML's "text"
    // mode closes whatever the mode it came from (13.2.6.4.8); and a
    // formatting element's, where it is the current node and the last on
    // the list, which is all the adoption agency would do for it
    const list = this._formatting;
    if (
      list.length &&
      self.stack[0] === name &&
      this._mode === IN_BODY &&
      self.foreignContext[0] === NOT_FOREIGN &&
      list[list.length - 1]?.el === this._current()
    ) {
      list.pop();
      self.popElement(false);
    } else if (
      self.stack[0] === name &&
      (RAW_ELEMENTS.has(name) || (name === 'noscript' && this._scripting)
        ? this._inRawText()
        : this._mode === IN_BODY &&
          !FORMATTING.has(name) &&
          !SPECIAL_END.has(name) &&
          self.foreignContext[0] === NOT_FOREIGN)
    ) {
      self.popElement(false);
    } else {
      this._endTag(name);
    }
    self.startIndex = endIndex + 1;
  }

  override ontext(start: number, endIndex: number): void {
    const self = this as unknown as ParserInternals;
    const data = self.getSlice(start, endIndex);
    self.endIndex = endIndex - 1;
    this._characters(data);
    self.startIndex = endIndex;
  }

  override ontextentity(cp: number, endIndex: number): void {
    const self = this as unknown as ParserInternals;
    self.endIndex = endIndex - 1;
    this._characters(String.fromCodePoint(cp));
    self.startIndex = endIndex;
  }

  override oncomment(start: number, endIndex: number, offset: number): void {
    this._comment(() => super.oncomment(start, endIndex, offset));
  }

  override oncdata(start: number, endIndex: number, offset: number): void {
    // in HTML it is a comment, and in SVG or MathML text
    if (this.isInForeignContext()) super.oncdata(start, endIndex, offset);
    else this._comment(() => super.oncdata(start, endIndex, offset));
  }

  override onprocessinginstruction(start: number, endIndex: number): void {
    this._comment(() => super.onprocessinginstruction(start, endIndex));
  }

  /** A comment, where the mode puts one: in the document before the
   *  `<html>` and after it, in the `<html>` after the body, and anywhere
   *  else at the current node. */
  private _comment(insert: () => void): void {
    const self = this as unknown as ParserInternals;
    if (this._mode === IN_TABLE_TEXT) this._flushTableText();
    const cbs = self.cbs;
    const mode = this._mode;
    if (
      mode === INITIAL ||
      mode === BEFORE_HTML ||
      mode === AFTER_AFTER_BODY ||
      mode === AFTER_AFTER_FRAMESET
    ) {
      cbs.place = { parent: cbs.root, before: null };
    } else if (mode === AFTER_BODY) {
      // the `<html>`, which the root stands in for in a fragment
      const html = this._fragment ? cbs.root : (cbs.openNodes[1] ?? cbs.root);
      cbs.place = { parent: html, before: null };
    }
    insert();
    cbs.place = null;
  }

  override ondeclaration(start: number, endIndex: number): void {
    const self = this as unknown as ParserInternals;
    if (this._mode === IN_TABLE_TEXT) this._flushTableText();
    // a fragment with nothing in it yet is a document from its doctype on
    if (this._fragment && this._mode === IN_BODY && this._atStart()) {
      this._fragment = false;
      this._mode = INITIAL;
      this._dropLeadingSpace();
    }
    if (this._mode !== INITIAL) {
      self.startIndex = endIndex + 1;
      return;
    }
    this._quirks = quirksDoctype('!' + self.getSlice(start, endIndex));
    super.ondeclaration(start, endIndex);
    this._mode = BEFORE_HTML;
  }

  /** The end of the input (13.2.6.4.7, "an end-of-file token"): what a
   *  document has yet to have, and the templates left open closed. */
  override onend(): void {
    if (this._mode === IN_TABLE_TEXT) this._flushTableText();
    // raw text ends with the input, and its element with it (13.2.6.4.8)
    if (this._inRawText()) this._pop();
    for (let guard = 0; guard < 16; guard++) {
      const mode = this._mode;
      if (mode === INITIAL) this._initialElse();
      else if (mode === BEFORE_HTML) this._insertHtml({});
      else if (mode === BEFORE_HEAD) this._insertHead({});
      else if (mode === IN_HEAD || mode === IN_HEAD_NOSCRIPT) {
        this._pop();
        this._mode = mode === IN_HEAD ? AFTER_HEAD : IN_HEAD;
      } else if (mode === AFTER_HEAD) this._insertBody({}, true);
      else if (this._templateModes.length && this._templateOpen() >= 0) {
        if (!this._endOfTemplate()) break;
      } else break;
    }
    super.onend();
  }

  // --- text -------------------------------------------------------------------

  /** Characters, as each mode takes them. */
  private _characters(data: string): void {
    const self = this as unknown as ParserInternals;
    const { stack, cbs } = self;
    // raw text is the element's whatever the mode, as HTML's "text" has it
    if (this._inRawText()) {
      cbs.ontext(data.includes('\0') ? data.replace(/\0/g, '\ufffd') : data);
      return;
    }
    if (self.foreignContext[0] !== NOT_FOREIGN) {
      // a NULL is U+FFFD there, and no reason a frameset cannot come
      if (this._framesetOk && NOT_SPACE_OR_NULL.test(data)) {
        this._framesetOk = false;
      }
      if (data.includes('\0')) data = data.replace(/\0/g, '\ufffd');
      cbs.ontext(data);
      return;
    }
    if (this._plaintext && data.includes('\0')) {
      data = data.replace(/\0/g, '\ufffd');
    }
    for (let guard = 0; data && guard < 16; guard++) {
      switch (this._mode) {
        case IN_BODY:
        case IN_CAPTION:
        case IN_CELL:
        case IN_TEMPLATE:
          this._bodyText(data);
          return;
        case IN_TABLE:
        case IN_TABLE_BODY:
        case IN_ROW:
          if (FOSTERING.has(stack[0]) || stack[0] === 'template') {
            this._original = this._mode;
            this._mode = IN_TABLE_TEXT;
            this._pending = [];
            this._pendingSpace = true;
            continue;
          }
          this._foster = true;
          this._bodyText(data);
          this._foster = false;
          return;
        case IN_TABLE_TEXT:
          this._pending.push(data);
          if (this._pendingSpace && NOT_SPACE.test(data)) {
            this._pendingSpace = false;
          }
          return;
        case AFTER_AFTER_FRAMESET: {
          // the white space in it, wherever it is, as the body takes it
          const space = data.replace(NOT_SPACES, '');
          if (space) this._bodyText(space);
          return;
        }
        case INITIAL:
        case BEFORE_HTML:
        case BEFORE_HEAD:
        case AFTER_AFTER_BODY: {
          const rest = data.replace(LEADING_SPACE, '');
          if (this._mode === AFTER_AFTER_BODY && rest.length < data.length) {
            this._bodyText(data.slice(0, data.length - rest.length));
          }
          data = rest;
          if (!data) return;
          if (this._mode === INITIAL) this._initialElse();
          else if (this._mode === BEFORE_HTML) this._insertHtml({});
          else if (this._mode === BEFORE_HEAD) this._insertHead({});
          else this._mode = IN_BODY;
          continue;
        }
        case IN_HEAD:
        case IN_HEAD_NOSCRIPT:
        case AFTER_HEAD:
        case IN_COLUMN_GROUP: {
          const rest = data.replace(LEADING_SPACE, '');
          if (rest.length < data.length) {
            cbs.ontext(data.slice(0, data.length - rest.length));
          }
          data = rest;
          if (!data) return;
          if (this._mode === IN_HEAD) {
            this._pop();
            this._mode = AFTER_HEAD;
          } else if (this._mode === IN_HEAD_NOSCRIPT) {
            this._pop();
            this._mode = IN_HEAD;
          } else if (this._mode === AFTER_HEAD) {
            this._insertBody({}, true);
          } else {
            if (stack[0] !== 'colgroup') {
              // each character that is not white space ignored, and the white
              // space among them put in
              const space = data.replace(NOT_SPACES, '');
              if (space) cbs.ontext(space);
              return;
            }
            this._pop();
            this._mode = IN_TABLE;
          }
          continue;
        }
        case AFTER_BODY: {
          const rest = data.replace(LEADING_SPACE, '');
          if (rest.length < data.length) {
            this._bodyText(data.slice(0, data.length - rest.length));
          }
          data = rest;
          if (!data) return;
          this._mode = IN_BODY;
          continue;
        }
        case IN_FRAMESET:
        case AFTER_FRAMESET: {
          // the white space in it, wherever it is, and nothing else
          const space = data.replace(NOT_SPACES, '');
          if (space) cbs.ontext(space);
          return;
        }
        default:
          return;
      }
    }
  }

  /** Characters in a body (13.2.6.4.7): no NULL, the formatting elements
   *  open again around them, and no frameset after them. */
  private _bodyText(data: string): void {
    const self = this as unknown as ParserInternals;
    if (data.includes('\0')) {
      data = data.replace(/\0/g, '');
      if (!data) return;
    }
    if (this._formatting.length) this._reconstruct();
    if (this._framesetOk && NOT_SPACE.test(data)) this._framesetOk = false;
    const cbs = self.cbs;
    if (this._foster && FOSTERING.has(self.stack[0])) {
      cbs.place = this._fosterPlace();
      cbs.ontext(data);
      cbs.place = null;
    } else cbs.ontext(data);
  }

  /** "In table text" ends: its characters go in the table where all are
   *  white space, and in front of it otherwise (13.2.6.4.10). */
  private _flushTableText(): void {
    const pending = this._pending.join('').replace(/\0/g, '');
    this._mode = this._original;
    this._pending = [];
    if (!pending) return;
    if (this._pendingSpace) {
      (this as unknown as ParserInternals).cbs.ontext(pending);
      return;
    }
    this._foster = true;
    this._bodyText(pending);
    this._foster = false;
  }

  // --- start tags ---------------------------------------------------------------

  /** The tree construction dispatcher (13.2.6): a start tag in SVG or MathML
   *  is foreign content's, but for what ends it, and anywhere else the
   *  mode's. */
  private _startTag(
    name: string,
    attribs: Record<string, string>,
    selfClosing: boolean,
  ): void {
    const self = this as unknown as ParserInternals;
    const { foreignContext, stack } = self;
    if (foreignContext[0] !== NOT_FOREIGN) {
      if (
        BREAKS_OUT.has(name) ||
        (name === 'font' &&
          (attribs.color !== undefined ||
            attribs.face !== undefined ||
            attribs.size !== undefined))
      ) {
        this._breakOut();
      } else {
        this._foreign(name, attribs, selfClosing, foreignContext[0]);
        return;
      }
    } else if (
      foreignContext.length > 1 &&
      (name === 'mglyph' || name === 'malignmark') &&
      MATHML_POINTS.has(stack[0]) &&
      foreignContext[1] === IN_MATHML
    ) {
      // a MathML text point takes these two as MathML's, and `/>` ends them
      this._foreign(name, attribs, selfClosing, IN_MATHML);
      return;
    }
    this._htmlStart(name, attribs, selfClosing);
  }

  /** A start tag in HTML content, in the mode the parser is in, and again
   *  in the mode it goes on to where the mode says to reprocess it. */
  private _htmlStart(
    name: string,
    attribs: Record<string, string>,
    selfClosing: boolean,
  ): void {
    const self = this as unknown as ParserInternals;
    for (let guard = 0; guard < 16; guard++) {
      const { stack } = self;
      switch (this._mode) {
        case INITIAL:
          this._initialElse();
          continue;
        case BEFORE_HTML:
          if (name === 'html') {
            this._insertHtml(attribs);
            return;
          }
          this._insertHtml({});
          continue;
        case BEFORE_HEAD:
          if (name === 'html') return this._mergeIntoHtml(attribs);
          if (name === 'head') {
            this._insertHead(attribs);
            return;
          }
          this._insertHead({});
          continue;
        case IN_HEAD:
          if (this._inHead(name, attribs)) return;
          if (name === 'head') return;
          this._pop();
          this._mode = AFTER_HEAD;
          continue;
        case IN_HEAD_NOSCRIPT:
          if (name === 'html') return this._mergeIntoHtml(attribs);
          if (
            name === 'basefont' ||
            name === 'bgsound' ||
            name === 'link' ||
            name === 'meta' ||
            name === 'noframes' ||
            name === 'style'
          ) {
            this._inHead(name, attribs);
            return;
          }
          if (name === 'head' || name === 'noscript') return;
          this._pop();
          this._mode = IN_HEAD;
          continue;
        case AFTER_HEAD:
          if (name === 'html') return this._mergeIntoHtml(attribs);
          if (name === 'body') {
            this._insertBody(attribs, false);
            return;
          }
          if (name === 'frameset') {
            this._insert(name, attribs);
            this._mode = IN_FRAMESET;
            return;
          }
          if (HEAD_TAGS.has(name)) {
            this._inHeadAfterIt(name, attribs);
            return;
          }
          if (name === 'head') return;
          this._insertBody({}, true);
          continue;
        case IN_BODY:
          this._inBody(name, attribs, selfClosing);
          return;
        case IN_TABLE:
          if (this._inTable(name, attribs, selfClosing)) return;
          continue;
        case IN_TABLE_TEXT:
          this._flushTableText();
          continue;
        case IN_CAPTION:
          if (CELL_ENDERS.has(name)) {
            if (!this._endCaption()) return;
            continue;
          }
          this._inBody(name, attribs, selfClosing);
          return;
        case IN_COLUMN_GROUP:
          if (name === 'html') return this._mergeIntoHtml(attribs);
          if (name === 'col') {
            this._insert(name, attribs);
            this._pop();
            return;
          }
          if (name === 'template') {
            this._inHead(name, attribs);
            return;
          }
          if (stack[0] !== 'colgroup') return;
          this._pop();
          this._mode = IN_TABLE;
          continue;
        case IN_TABLE_BODY:
          if (name === 'tr') {
            this._clearTo(TABLE_BODY_CONTEXT);
            this._insert(name, attribs);
            this._mode = IN_ROW;
            return;
          }
          if (name === 'th' || name === 'td') {
            this._clearTo(TABLE_BODY_CONTEXT);
            this._insert('tr', {});
            this._mode = IN_ROW;
            continue;
          }
          if (
            name === 'caption' ||
            name === 'col' ||
            name === 'colgroup' ||
            SECTIONS.has(name)
          ) {
            if (!this._endSection()) return;
            continue;
          }
          if (this._inTable(name, attribs, selfClosing)) return;
          continue;
        case IN_ROW:
          if (name === 'th' || name === 'td') {
            this._clearTo(ROW_CONTEXT);
            this._insert(name, attribs);
            this._mode = IN_CELL;
            this._formatting.push(null);
            return;
          }
          if (CELL_ENDERS.has(name)) {
            if (!this._endRow()) return;
            continue;
          }
          if (this._inTable(name, attribs, selfClosing)) return;
          continue;
        case IN_CELL:
          if (CELL_ENDERS.has(name)) {
            if (!this._closeCell()) return;
            continue;
          }
          this._inBody(name, attribs, selfClosing);
          return;
        case IN_TEMPLATE: {
          if (HEAD_TAGS.has(name)) {
            this._inHead(name, attribs);
            return;
          }
          const next =
            name === 'caption' || name === 'colgroup' || SECTIONS.has(name)
              ? IN_TABLE
              : name === 'col'
                ? IN_COLUMN_GROUP
                : name === 'tr'
                  ? IN_TABLE_BODY
                  : name === 'td' || name === 'th'
                    ? IN_ROW
                    : IN_BODY;
          this._templateModes[this._templateModes.length - 1] = next;
          this._mode = next;
          continue;
        }
        case AFTER_BODY:
          if (name === 'html') return this._mergeIntoHtml(attribs);
          this._mode = IN_BODY;
          continue;
        case IN_FRAMESET:
          if (name === 'html') return this._mergeIntoHtml(attribs);
          if (name === 'frameset') this._insert(name, attribs);
          else if (name === 'frame') {
            this._insert(name, attribs);
            this._pop();
          } else if (name === 'noframes') this._inHead(name, attribs);
          return;
        case AFTER_FRAMESET:
        case AFTER_AFTER_FRAMESET:
          if (name === 'html') return this._mergeIntoHtml(attribs);
          if (name === 'noframes') this._inHead(name, attribs);
          return;
        case AFTER_AFTER_BODY:
          if (name === 'html') return this._mergeIntoHtml(attribs);
          this._mode = IN_BODY;
          continue;
        default:
          return;
      }
    }
  }

  /** "In head" (13.2.6.4.4), for what it takes; false for anything else. */
  private _inHead(name: string, attribs: Record<string, string>): boolean {
    switch (name) {
      case 'html':
        this._mergeIntoHtml(attribs);
        return true;
      case 'base':
      case 'basefont':
      case 'bgsound':
      case 'link':
      case 'meta':
        this._insert(name, attribs);
        this._pop();
        return true;
      case 'title':
      case 'noframes':
      case 'style':
      case 'script':
        this._insert(name, attribs);
        return true;
      case 'noscript':
        // where scripts run its content is text (`_tag`), and where they do
        // not, markup, of which the head keeps what is head content
        // (13.2.6.4.5)
        this._insert(name, attribs);
        if (!this._scripting) this._mode = IN_HEAD_NOSCRIPT;
        return true;
      case 'template':
        this._insert(name, attribs);
        this._formatting.push(null);
        this._framesetOk = false;
        this._mode = IN_TEMPLATE;
        this._templateModes.push(IN_TEMPLATE);
        return true;
      default:
        return false;
    }
  }

  /** Head content after the head: in the head after all (13.2.6.4.6). */
  private _inHeadAfterIt(name: string, attribs: Record<string, string>): void {
    const self = this as unknown as ParserInternals;
    const head = this._head;
    if (!head) {
      this._inHead(name, attribs);
      return;
    }
    // back on the stack, and out of it again from wherever it is then
    self.stack.unshift('head');
    self.cbs.openNodes.push(head);
    this._inHead(name, attribs);
    const at = this._stackIndex(head);
    if (at >= 0) this._dropFromStack(at);
  }

  /** "In body" (13.2.6.4.7). */
  private _inBody(
    name: string,
    attribs: Record<string, string>,
    selfClosing: boolean,
  ): void {
    const self = this as unknown as ParserInternals;
    const { stack, cbs } = self;
    // the tags with no rule of their own, which nearly all are, ask no more
    if (!BODY_RULES.has(name)) {
      if (BLOCKS.has(name)) {
        this._closeParagraph();
        this._insert(name, attribs);
        return;
      }
      this._reconstruct();
      this._insert(name, attribs);
      if (FORMATTING.has(name)) this._remember(name, attribs);
      return;
    }
    switch (name) {
      case 'html':
        this._mergeIntoHtml(attribs);
        return;
      case 'base':
      case 'basefont':
      case 'bgsound':
      case 'link':
      case 'meta':
      case 'noframes':
      case 'script':
      case 'style':
      case 'template':
      case 'title':
        this._inHead(name, attribs);
        return;
      case 'body':
        this._bodyAgain(attribs);
        return;
      case 'frameset':
        this._framesetInBody(attribs);
        return;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        this._closeParagraph();
        if (HEADINGS.has(stack[0]) && this._isHtml(0)) this._pop();
        this._insert(name, attribs);
        return;
      case 'pre':
      case 'listing':
        this._closeParagraph();
        this._insert(name, attribs);
        this._framesetOk = false;
        return;
      case 'form':
        if (cbs.form && !this._inTemplate()) return;
        this._closeParagraph();
        this._insert(name, attribs);
        if (!this._inTemplate()) cbs.form = this._current();
        return;
      case 'li':
      case 'dd':
      case 'dt':
        this._item(name);
        this._closeParagraph();
        this._insert(name, attribs);
        return;
      case 'plaintext':
        this._closeParagraph();
        this._insert(name, attribs);
        this._plaintext = true;
        return;
      case 'button':
        if (this._inScope('button') >= 0) {
          this._impliedEnds();
          this._popTo('button');
        }
        this._reconstruct();
        this._insert(name, attribs);
        this._framesetOk = false;
        return;
      case 'a': {
        const open = this._formattingNamed('a');
        if (open) {
          this._adoption('a');
          this._forget(open);
        }
        this._reconstruct();
        this._insert(name, attribs);
        this._remember(name, attribs);
        return;
      }
      case 'nobr':
        this._reconstruct();
        if (this._inScope('nobr') >= 0) {
          this._adoption('nobr');
          this._reconstruct();
        }
        this._insert(name, attribs);
        this._remember(name, attribs);
        return;
      case 'applet':
      case 'marquee':
      case 'object':
        this._reconstruct();
        this._insert(name, attribs);
        this._formatting.push(null);
        this._framesetOk = false;
        return;
      case 'table':
        if (!this._quirks) this._closeParagraph();
        this._insert(name, attribs);
        this._framesetOk = false;
        this._mode = IN_TABLE;
        return;
      case 'area':
      case 'br':
      case 'embed':
      case 'img':
      case 'keygen':
      case 'wbr':
        this._reconstruct();
        this._insert(name, attribs);
        this._pop();
        this._framesetOk = false;
        return;
      case 'input':
        if (this._holder === 'select') return;
        if (this._inScope('select') >= 0) this._popTo('select');
        this._reconstruct();
        this._insert(name, attribs);
        this._pop();
        if ((attribs.type ?? '').toLowerCase() !== 'hidden') {
          this._framesetOk = false;
        }
        return;
      case 'param':
      case 'source':
      case 'track':
        this._insert(name, attribs);
        this._pop();
        return;
      case 'hr':
        this._closeParagraph();
        if (this._inScope('select') >= 0) this._impliedEnds();
        this._insert(name, attribs);
        this._pop();
        this._framesetOk = false;
        return;
      case 'image':
        this._inBody('img', attribs, selfClosing);
        return;
      case 'textarea':
        this._insert(name, attribs);
        this._framesetOk = false;
        return;
      case 'xmp':
        this._closeParagraph();
        this._reconstruct();
        this._framesetOk = false;
        this._insert(name, attribs);
        return;
      case 'iframe':
        this._framesetOk = false;
        this._insert(name, attribs);
        return;
      case 'noembed':
        this._insert(name, attribs);
        return;
      case 'noscript':
        // raw text where scripts run, and an element like any where not
        if (!this._scripting) this._reconstruct();
        this._insert(name, attribs);
        return;
      case 'select':
        if (this._holder === 'select') return;
        if (this._inScope('select') >= 0) {
          this._popTo('select');
          return;
        }
        this._reconstruct();
        this._insert(name, attribs);
        this._framesetOk = false;
        return;
      case 'option':
        if (this._inScope('select') >= 0) this._impliedEnds('optgroup');
        else if (stack[0] === 'option') this._pop();
        this._reconstruct();
        this._insert(name, attribs);
        return;
      case 'optgroup':
        if (this._inScope('select') >= 0) this._impliedEnds();
        else if (stack[0] === 'option') this._pop();
        this._reconstruct();
        this._insert(name, attribs);
        return;
      case 'rb':
      case 'rtc':
        if (this._inScope('ruby') >= 0) this._impliedEnds();
        this._insert(name, attribs);
        return;
      case 'rp':
      case 'rt':
        if (this._inScope('ruby') >= 0) this._impliedEnds('rtc');
        this._insert(name, attribs);
        return;
      case 'math':
      case 'svg':
        this._reconstruct();
        this._foreign(name, attribs, selfClosing, NOT_FOREIGN);
        return;
      case 'head':
        // a fragment that starts as a document is one
        if (this._fragment && this._atStart()) {
          this._fragment = false;
          this._dropLeadingSpace();
          this._mode = BEFORE_HTML;
          this._htmlStart(name, attribs, selfClosing);
        }
        return;
      case 'caption':
      case 'col':
      case 'colgroup':
      case 'frame':
      case 'tbody':
      case 'td':
      case 'tfoot':
      case 'th':
      case 'thead':
      case 'tr':
        return;
    }
  }

  /** A second `<body>`: its attributes on the first, where there is one to
   *  take them. In a fragment the first one written takes in what came
   *  before it. */
  private _bodyAgain(attribs: Record<string, string>): void {
    const self = this as unknown as ParserInternals;
    const { stack, cbs } = self;
    if (this._templateOpen() >= 0) return;
    if (this._fragment) {
      if (this._body) {
        cbs.mergeAttributes(this._body, attribs);
      } else if (!stack.length && !this._contextual) {
        this._insert('body', attribs);
        this._body = this._current();
        cbs.adopt(this._body);
      }
      this._framesetOk = false;
      return;
    }
    const second = stack.length >= 2 ? stack[stack.length - 2] : '';
    if (second !== 'body') return;
    this._framesetOk = false;
    cbs.mergeAttributes(cbs.openNodes[2] as Element, attribs);
  }

  /** A `<frameset>` in a body that holds nothing yet takes its place
   *  (13.2.6.4.7). */
  private _framesetInBody(attribs: Record<string, string>): void {
    const self = this as unknown as ParserInternals;
    const { stack, cbs } = self;
    if (this._fragment || stack.length < 2) return;
    if (stack[stack.length - 2] !== 'body' || !this._framesetOk) return;
    const body = cbs.openNodes[2];
    if (body.parent) {
      takeNode(body);
      cbs.moved();
    }
    while (stack.length > 1) this._pop();
    this._insert('frameset', attribs);
    this._mode = IN_FRAMESET;
  }

  /** What an `<li>`, a `<dd>` or a `<dt>` closes before it opens. */
  private _item(name: string): void {
    const self = this as unknown as ParserInternals;
    const { stack } = self;
    this._framesetOk = false;
    const end = Math.min(stack.length, MAX_DEPTH);
    for (let at = 0; at < end; at++) {
      const el = stack[at];
      const same = name === 'li' ? el === 'li' : el === 'dd' || el === 'dt';
      if (same && this._isHtml(at)) {
        this._impliedEnds(el);
        this._popTo(el);
        return;
      }
      if (SPECIAL_TO_AN_ITEM.has(el) && this._isHtml(at)) return;
      if (!this._isHtml(at) && SPECIAL_FOREIGN.has(el)) return;
    }
  }

  /** "In table" (13.2.6.4.9), and for the modes that fall back on it; false
   *  where the token is reprocessed in the mode it switched to. */
  private _inTable(
    name: string,
    attribs: Record<string, string>,
    selfClosing: boolean,
  ): boolean {
    const self = this as unknown as ParserInternals;
    const { cbs } = self;
    switch (name) {
      case 'caption':
        this._clearTo(TABLE_CONTEXT);
        this._formatting.push(null);
        this._insert(name, attribs);
        this._mode = IN_CAPTION;
        return true;
      case 'colgroup':
        this._clearTo(TABLE_CONTEXT);
        this._insert(name, attribs);
        this._mode = IN_COLUMN_GROUP;
        return true;
      case 'col':
        this._clearTo(TABLE_CONTEXT);
        this._insert('colgroup', {});
        this._mode = IN_COLUMN_GROUP;
        return false;
      case 'tbody':
      case 'tfoot':
      case 'thead':
        this._clearTo(TABLE_CONTEXT);
        this._insert(name, attribs);
        this._mode = IN_TABLE_BODY;
        return true;
      case 'td':
      case 'th':
      case 'tr':
        this._clearTo(TABLE_CONTEXT);
        this._insert('tbody', {});
        this._mode = IN_TABLE_BODY;
        return false;
      case 'table':
        if (this._inScope('table', TABLE_SCOPE) < 0) return true;
        this._popTo('table');
        this._resetMode();
        return false;
      case 'style':
      case 'script':
      case 'template':
        this._inHead(name, attribs);
        return true;
      case 'input':
        if ((attribs.type ?? '').toLowerCase() !== 'hidden') break;
        this._insert(name, attribs);
        this._pop();
        return true;
      case 'form': {
        const template = this._inTemplate();
        if (cbs.form && !template) return true;
        this._insert(name, attribs);
        if (!template) cbs.form = this._current();
        this._pop();
        return true;
      }
    }
    this._foster = true;
    this._inBody(name, attribs, selfClosing);
    this._foster = false;
    return true;
  }

  /** A caption closed for what cannot go in it; false where none is open
   *  to close. */
  private _endCaption(): boolean {
    if (this._inScope('caption', TABLE_SCOPE) < 0) return false;
    this._impliedEnds();
    this._popTo('caption');
    this._clearFormatting();
    this._mode = IN_TABLE;
    return true;
  }

  /** A row group closed for what cannot go in it. */
  private _endSection(): boolean {
    if (
      this._inScope('tbody', TABLE_SCOPE) < 0 &&
      this._inScope('thead', TABLE_SCOPE) < 0 &&
      this._inScope('tfoot', TABLE_SCOPE) < 0
    ) {
      return false;
    }
    this._clearTo(TABLE_BODY_CONTEXT);
    this._pop();
    this._mode = IN_TABLE;
    return true;
  }

  /** A row closed for what cannot go in it. */
  private _endRow(): boolean {
    if (this._inScope('tr', TABLE_SCOPE) < 0) return false;
    this._clearTo(ROW_CONTEXT);
    this._pop();
    this._mode = IN_TABLE_BODY;
    return true;
  }

  /** "Close the cell" (13.2.6.4.15). */
  private _closeCell(): boolean {
    const self = this as unknown as ParserInternals;
    const td = this._inScope('td', TABLE_SCOPE);
    const th = td < 0 ? this._inScope('th', TABLE_SCOPE) : -1;
    if (td < 0 && th < 0) return false;
    this._impliedEnds();
    const { stack } = self;
    while (stack.length) {
      const name = stack[0];
      this._pop();
      if (name === 'td' || name === 'th') break;
    }
    this._clearFormatting();
    this._mode = IN_ROW;
    return true;
  }

  /** "Anything else" in "initial": a document with no doctype is in quirks
   *  mode. */
  private _initialElse(): void {
    this._quirks = true;
    this._mode = BEFORE_HTML;
  }

  private _insertHtml(attribs: Record<string, string>): void {
    this._insert('html', attribs);
    this._mode = BEFORE_HEAD;
  }

  private _insertHead(attribs: Record<string, string>): void {
    this._insert('head', attribs);
    this._head = this._current();
    this._mode = IN_HEAD;
  }

  private _insertBody(attribs: Record<string, string>, implied: boolean): void {
    this._insert('body', attribs);
    this._body = this._current();
    this._framesetOk = implied;
    this._mode = IN_BODY;
  }

  /** A second `<html>`'s attributes, on the first, where it has none of
   *  them. A fragment written as a document, its `<html>` the first thing
   *  in it, is one. */
  private _mergeIntoHtml(attribs: Record<string, string>): void {
    const self = this as unknown as ParserInternals;
    const { cbs, stack } = self;
    // not from a template's content, wherever its mode sends it
    if (this._templateOpen() >= 0) return;
    if (this._fragment) {
      if (!stack.length && !this._contextual && !this._body) {
        this._fragment = false;
        this._dropLeadingSpace();
        this._insertHtml(attribs);
      }
      return;
    }
    const html = cbs.openNodes[1];
    if (html instanceof Element) cbs.mergeAttributes(html, attribs);
  }

  // --- end tags -----------------------------------------------------------------

  /**
   * An end tag (13.2.6). Where the current node is SVG's or MathML's, it
   * closes the nearest element of its name up to the first HTML one, and a
   * `</p>` and a `</br>` end foreign content; from an HTML element it is the
   * mode's.
   */
  private _endTag(name: string): void {
    const self = this as unknown as ParserInternals;
    const { stack } = self;
    if (stack.length && !this._isHtml(0)) {
      if (name === 'p' || name === 'br') this._breakOut();
      else {
        const lower = name.toLowerCase();
        for (let at = 0; at < stack.length; at++) {
          if (at > 0 && this._isHtml(at)) break;
          if (stack[at].toLowerCase() === lower) {
            this._closeTo(at);
            return;
          }
          if (at === stack.length - 1) return;
        }
      }
    }
    this._htmlEnd(name);
  }

  /** An end tag in the mode the parser is in. */
  private _htmlEnd(name: string): void {
    const self = this as unknown as ParserInternals;
    for (let guard = 0; guard < 16; guard++) {
      const { stack } = self;
      switch (this._mode) {
        case INITIAL:
          this._initialElse();
          continue;
        case BEFORE_HTML:
          if (
            name !== 'head' &&
            name !== 'body' &&
            name !== 'html' &&
            name !== 'br'
          ) {
            return;
          }
          this._insertHtml({});
          continue;
        case BEFORE_HEAD:
          if (
            name !== 'head' &&
            name !== 'body' &&
            name !== 'html' &&
            name !== 'br'
          ) {
            return;
          }
          this._insertHead({});
          continue;
        case IN_HEAD:
          if (name === 'head') {
            this._pop();
            this._mode = AFTER_HEAD;
            return;
          }
          if (name === 'template') {
            this._endTemplate();
            return;
          }
          if (name !== 'body' && name !== 'html' && name !== 'br') return;
          this._pop();
          this._mode = AFTER_HEAD;
          continue;
        case IN_HEAD_NOSCRIPT:
          if (name === 'noscript') {
            this._pop();
            this._mode = IN_HEAD;
            return;
          }
          if (name !== 'br') return;
          this._pop();
          this._mode = IN_HEAD;
          continue;
        case AFTER_HEAD:
          if (name === 'template') {
            this._endTemplate();
            return;
          }
          if (name !== 'body' && name !== 'html' && name !== 'br') return;
          this._insertBody({}, true);
          continue;
        case IN_BODY:
          if (this._inBodyEnd(name)) return;
          continue;
        case IN_TABLE:
          if (this._inTableEnd(name)) return;
          continue;
        case IN_TABLE_TEXT:
          this._flushTableText();
          continue;
        case IN_CAPTION:
          if (name === 'caption') {
            this._endCaption();
            return;
          }
          if (name === 'table') {
            if (!this._endCaption()) return;
            continue;
          }
          if (IGNORED_IN_CAPTION.has(name)) return;
          if (this._inBodyEnd(name)) return;
          continue;
        case IN_COLUMN_GROUP:
          if (name === 'colgroup') {
            if (stack[0] !== 'colgroup') return;
            this._pop();
            this._mode = IN_TABLE;
            return;
          }
          if (name === 'col') return;
          if (name === 'template') {
            this._endTemplate();
            return;
          }
          if (stack[0] !== 'colgroup') return;
          this._pop();
          this._mode = IN_TABLE;
          continue;
        case IN_TABLE_BODY:
          if (SECTIONS.has(name)) {
            if (this._inScope(name, TABLE_SCOPE) < 0) return;
            this._clearTo(TABLE_BODY_CONTEXT);
            this._pop();
            this._mode = IN_TABLE;
            return;
          }
          if (name === 'table') {
            if (!this._endSection()) return;
            continue;
          }
          if (IGNORED_IN_BODY_OF_TABLE.has(name)) return;
          if (this._inTableEnd(name)) return;
          continue;
        case IN_ROW:
          if (name === 'tr') {
            this._endRow();
            return;
          }
          if (name === 'table') {
            if (!this._endRow()) return;
            continue;
          }
          if (SECTIONS.has(name)) {
            if (this._inScope(name, TABLE_SCOPE) < 0) return;
            if (!this._endRow()) return;
            continue;
          }
          if (IGNORED_IN_ROW.has(name)) return;
          if (this._inTableEnd(name)) return;
          continue;
        case IN_CELL:
          if (name === 'td' || name === 'th') {
            if (this._inScope(name, TABLE_SCOPE) < 0) return;
            this._impliedEnds();
            this._popTo(name);
            this._clearFormatting();
            this._mode = IN_ROW;
            return;
          }
          if (IGNORED_IN_CELL.has(name)) return;
          if (name === 'table' || SECTIONS.has(name) || name === 'tr') {
            if (this._inScope(name, TABLE_SCOPE) < 0) return;
            this._closeCell();
            continue;
          }
          if (this._inBodyEnd(name)) return;
          continue;
        case IN_TEMPLATE:
          if (name === 'template') this._endTemplate();
          return;
        case AFTER_BODY:
          if (name === 'html') {
            if (!this._contextual) this._mode = AFTER_AFTER_BODY;
            return;
          }
          this._mode = IN_BODY;
          continue;
        case IN_FRAMESET:
          if (name !== 'frameset') return;
          if (stack.length <= 1 && !this._fragment) return;
          if (!stack.length) return;
          this._pop();
          if (!this._contextual && stack[0] !== 'frameset') {
            this._mode = AFTER_FRAMESET;
          }
          return;
        case AFTER_FRAMESET:
          if (name === 'html') this._mode = AFTER_AFTER_FRAMESET;
          return;
        case AFTER_AFTER_BODY:
          this._mode = IN_BODY;
          continue;
        default:
          return;
      }
    }
  }

  /** "In body"'s end tags; false where the token is reprocessed. */
  private _inBodyEnd(name: string): boolean {
    const self = this as unknown as ParserInternals;
    const { cbs } = self;
    switch (name) {
      case 'template':
        this._endTemplate();
        return true;
      case 'body':
      case 'html':
        if (this._fragment && !this._body) return true;
        if (this._inScope('body') < 0) return true;
        this._mode = AFTER_BODY;
        return name === 'body';
      case 'form': {
        if (this._inTemplate()) {
          if (this._inScope('form') < 0) return true;
          this._impliedEnds();
          this._popTo('form');
          return true;
        }
        const form = cbs.form;
        cbs.form = null;
        const at = form ? this._stackIndex(form) : -1;
        if (at < 0 || !this._elementInScope(at)) return true;
        this._impliedEnds();
        this._leaveOpen(this._stackIndex(form!));
        return true;
      }
      case 'p':
        if (this._inScope('p', BUTTON_SCOPE) < 0) {
          this._insert('p', {});
        }
        this._closeParagraph();
        return true;
      case 'li':
        if (this._inScope('li', LIST_SCOPE) < 0) return true;
        this._impliedEnds('li');
        this._popTo('li');
        return true;
      case 'dd':
      case 'dt':
        if (this._inScope(name) < 0) return true;
        this._impliedEnds(name);
        this._popTo(name);
        return true;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const at = this._closedBy(name, SCOPE, HEADINGS, true);
        if (at < 0) return true;
        this._impliedEnds();
        const { stack } = self;
        while (stack.length) {
          const top = stack[0];
          this._pop();
          if (HEADINGS.has(top)) break;
        }
        return true;
      }
      case 'applet':
      case 'marquee':
      case 'object':
        if (this._inScope(name) < 0) return true;
        this._impliedEnds();
        this._popTo(name);
        this._clearFormatting();
        return true;
      case 'br':
        this._inBody('br', {}, false);
        return true;
    }
    if (FORMATTING.has(name)) {
      this._adoption(name);
      return true;
    }
    if (BLOCK_ENDS.has(name)) {
      if (this._inScope(name) < 0) return true;
      this._impliedEnds();
      this._popTo(name);
      return true;
    }
    this._anyOtherEnd(name);
    return true;
  }

  /** "In table"'s end tags; false where the token is reprocessed. */
  private _inTableEnd(name: string): boolean {
    if (name === 'table') {
      if (this._inScope('table', TABLE_SCOPE) < 0) return true;
      this._popTo('table');
      this._resetMode();
      return true;
    }
    if (IGNORED_IN_TABLE.has(name)) return true;
    if (name === 'template') {
      this._endTemplate();
      return true;
    }
    this._foster = true;
    const done = this._inBodyEnd(name);
    this._foster = false;
    return done;
  }

  /** "Any other end tag" (13.2.6.4.7): what is open of its name before
   *  anything special, closed. */
  private _anyOtherEnd(name: string): void {
    const self = this as unknown as ParserInternals;
    const at = this._closedBy(name, SPECIAL, null, true);
    if (at < 0) return;
    const el = self.cbs.openNodes[self.cbs.openNodes.length - 1 - at];
    this._impliedEnds(name);
    const now = this._stackIndex(el);
    if (now >= 0) this._closeTo(now);
  }

  /** A `</template>` (13.2.6.4.4). */
  private _endTemplate(): void {
    if (this._templateOpen() < 0) return;
    this._impliedEnds(undefined, ENDS_THOROUGHLY);
    this._popTo('template');
    this._clearFormatting();
    this._templateModes.pop();
    this._resetMode();
  }

  /** The end of the input in a `<template>`; false where nothing is left to
   *  close. */
  private _endOfTemplate(): boolean {
    if (this._templateOpen() < 0) return false;
    this._popTo('template');
    this._clearFormatting();
    this._templateModes.pop();
    this._resetMode();
    return true;
  }

  // --- the adoption agency --------------------------------------------------------

  /**
   * The adoption agency algorithm (13.2.6.4.7): a formatting element's end
   * tag closes it from under what it holds, and the elements it held are
   * made again inside what is left open, so that a `<b>` closed in a `<p>`
   * it opened outside of is a `<b>` in the `<p>` as well as one before it.
   */
  private _adoption(subject: string): void {
    const self = this as unknown as ParserInternals;
    const { stack, cbs } = self;
    const T = cbs.openNodes;
    const list = this._formatting;
    if (
      stack[0] === subject &&
      this._isHtml(0) &&
      !this._listed(T[T.length - 1] as Element)
    ) {
      this._pop();
      return;
    }
    for (let outer = 0; outer < 8; outer++) {
      let fi = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        if (entry === null) break;
        if (entry.name === subject) {
          fi = i;
          break;
        }
      }
      if (fi < 0) {
        this._anyOtherEnd(subject);
        return;
      }
      const feEntry = list[fi]!;
      const fe = feEntry.el;
      const fk = this._stackIndex(fe);
      if (fk < 0) {
        list.splice(fi, 1);
        return;
      }
      if (!this._elementInScope(fk)) return;
      let bk = -1;
      for (let k = fk - 1; k >= 0; k--) {
        if (this._specialAt(k)) {
          bk = k;
          break;
        }
      }
      if (bk < 0) {
        this._closeTo(fk);
        list.splice(list.indexOf(feEntry), 1);
        return;
      }
      const fb = T[T.length - 1 - bk] as Element;
      const common = T[T.length - 1 - (fk + 1)] as ParentNode;
      let bookmark: Formatting = null;
      let lastNode: Element = fb;
      let nk = bk;
      let removed = false;
      for (let inner = 1; ; inner++) {
        if (!removed) nk += 1;
        removed = false;
        const node = T[T.length - 1 - nk] as Element;
        if (node === fe) break;
        let ni = this._listIndex(node);
        if (inner > 3 && ni >= 0) {
          list.splice(ni, 1);
          ni = -1;
        }
        if (ni < 0) {
          this._dropFromStack(nk);
          removed = true;
          continue;
        }
        const entry = list[ni]!;
        const clone = cbs.made(entry.name, { ...entry.attribs });
        const replaced = {
          el: clone,
          name: entry.name,
          attribs: entry.attribs,
        };
        list[ni] = replaced;
        T[T.length - 1 - nk] = clone;
        cbs.openFormatting.delete(node);
        cbs.openFormatting.add(clone);
        bookmark ??= replaced;
        putNode(clone, lastNode);
        cbs.moved();
        lastNode = clone;
      }
      // what is left goes where the common ancestor would take it
      if (this._foster && FOSTERING.has(isElement(common) ? common.name : '')) {
        const place = this._fosterPlace();
        putNode(place.parent, lastNode, place.before);
      } else putNode(common, lastNode);
      cbs.moved();
      // and the formatting element is made again in the furthest block
      const made = cbs.made(feEntry.name, { ...feEntry.attribs });
      const kids = fb.children.slice();
      for (const kid of kids) putNode(made, kid);
      putNode(fb, made);
      const entry = { el: made, name: feEntry.name, attribs: feEntry.attribs };
      list.splice(list.indexOf(feEntry), 1);
      if (bookmark) list.splice(list.indexOf(bookmark) + 1, 0, entry);
      else list.splice(fi, 0, entry);
      this._dropFromStack(this._stackIndex(fe));
      const at = this._stackIndex(fb);
      stack.splice(at, 0, feEntry.name);
      T.splice(T.length - at, 0, made);
      cbs.openFormatting.add(made);
      cbs.breakText();
    }
  }

  /** Whether an element is on the list of active formatting elements. */
  private _listed(el: Element): boolean {
    return this._listIndex(el) >= 0;
  }

  private _listIndex(el: Element): number {
    const list = this._formatting;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.el === el) return i;
    }
    return -1;
  }

  /** The `<a>` on the list after its last marker, or null. */
  private _formattingNamed(name: string): Element | null {
    const list = this._formatting;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry === null) return null;
      if (entry.name === name) return entry.el;
    }
    return null;
  }

  /** An element taken off the list and the stack, where the adoption agency
   *  left it on them. */
  private _forget(el: Element): void {
    const at = this._listIndex(el);
    if (at >= 0) this._formatting.splice(at, 1);
    const k = this._stackIndex(el);
    if (k >= 0) this._dropFromStack(k);
  }

  /** The current node pushed on the list, the earliest of three like it
   *  after the last marker taken off it first (13.2.4.3, Noah's Ark). */
  private _remember(name: string, attribs: Record<string, string>): void {
    const el = this._current();
    const list = this._formatting;
    let alike = 0;
    let earliest = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry === null) break;
      if (entry.name === name && sameAttributes(entry.attribs, attribs)) {
        alike += 1;
        earliest = i;
      }
    }
    if (alike >= 3) list.splice(earliest, 1);
    // the token's, which a script may change on the element
    let copy = NO_ATTRIBUTES;
    for (const _ in attribs) {
      copy = { ...attribs };
      break;
    }
    list.push({ el, name, attribs: copy });
    (this as unknown as ParserInternals).cbs.openFormatting.add(el);
  }

  /** "Reconstruct the active formatting elements" (13.2.4.3): the ones
   *  closed from under what is open made again around what comes next. */
  private _reconstruct(): void {
    const list = this._formatting;
    if (!list.length) return;
    const cbs = (this as unknown as ParserInternals).cbs;
    const open = cbs.openFormatting;
    const last = list[list.length - 1];
    if (last === null || open.has(last.el)) return;
    let i = list.length - 1;
    while (i > 0) {
      const before = list[i - 1];
      if (before === null || open.has(before.el)) break;
      i -= 1;
    }
    for (; i < list.length; i++) {
      const entry = list[i]!;
      this._insert(entry.name, { ...entry.attribs });
      const el = this._current();
      list[i] = { el, name: entry.name, attribs: entry.attribs };
      open.add(el);
    }
  }

  /** "Clear the list of active formatting elements up to the last
   *  marker". */
  private _clearFormatting(): void {
    const list = this._formatting;
    while (list.length) if (list.pop() === null) break;
  }

  // --- inserting --------------------------------------------------------------------

  /** An HTML element for a start tag, where foster parenting says or at the
   *  current node, and on the stack. */
  private _insert(name: string, attribs: Record<string, string>): void {
    const self = this as unknown as ParserInternals;
    const { stack, foreignContext, cbs } = self;
    if (this._foster && FOSTERING.has(stack[0]))
      cbs.place = this._fosterPlace();
    stack.unshift(name);
    if (FRAMED.has(name)) {
      foreignContext.unshift(
        name === 'svg' ? IN_SVG : name === 'math' ? IN_MATHML : NOT_FOREIGN,
      );
    }
    this._made = name;
    cbs.onopentag(name, attribs);
    cbs.place = null;
    // at the top of a fragment read in SVG or MathML, which says nothing
    // of an element the parser made HTML's there
    if (stack.length === 1 && this._context !== NOT_FOREIGN) {
      this._current().namespace = HTML_NAMESPACE;
    }
  }

  /**
   * An element in SVG or MathML (13.2.6.5). The frame htmlparser2 keeps
   * goes by the name alone, in one list for both languages, where a name is
   * an integration point in its own language only: in SVG an `<mi>` and a
   * `<math>` are SVG's, and in MathML a `<title>` and an `<svg>` MathML's,
   * but for an `<svg>` an `<annotation-xml>` opens, and an
   * `<annotation-xml>` that says it holds HTML is a point.
   */
  private _foreign(
    name: string,
    attribs: Record<string, string>,
    selfClosing: boolean,
    around: number,
  ): void {
    const self = this as unknown as ParserInternals;
    const { stack, foreignContext, cbs } = self;
    if (this._foster && FOSTERING.has(stack[0]))
      cbs.place = this._fosterPlace();
    if (FRAMED.has(name)) {
      foreignContext.unshift(frameOf(name, around, stack[0], attribs));
    }
    stack.unshift(name);
    this._made = name;
    cbs.onopentag(name, attribs);
    cbs.place = null;
    if (selfClosing) this._pop();
  }

  /**
   * Where foster parenting puts a node (13.2.6.1): in front of the last
   * table open, or at the end of the last template if that is nearer, or
   * of what holds the table on the stack where the table is in no tree.
   */
  private _fosterPlace(): { parent: ParentNode; before: ChildNode | null } {
    const self = this as unknown as ParserInternals;
    const { stack, cbs } = self;
    const T = cbs.openNodes;
    for (let k = 0; k < stack.length; k++) {
      const name = stack[k];
      if ((name !== 'table' && name !== 'template') || !this._isHtml(k)) {
        continue;
      }
      const el = T[T.length - 1 - k];
      if (name === 'template') return { parent: el, before: null };
      if (el.parent) return { parent: el.parent, before: el as ChildNode };
      return { parent: T[T.length - 2 - k], before: null };
    }
    return { parent: T[1] ?? cbs.root, before: null };
  }

  // --- the stack ----------------------------------------------------------------------

  /** The current node. */
  private _current(): Element {
    const T = (this as unknown as ParserInternals).cbs.openNodes;
    return T[T.length - 1] as Element;
  }

  private _pop(): void {
    (this as unknown as ParserInternals).popElement(true);
  }

  /** The element at `at` in the stack closed, and what stands above it. */
  private _closeTo(at: number): void {
    const self = this as unknown as ParserInternals;
    for (let k = 0; k <= at; k++) self.popElement(true);
  }

  /** Pop until an HTML element of `name` has been popped. */
  private _popTo(name: string): void {
    const at = this._htmlIndex(name);
    if (at >= 0) this._closeTo(at);
  }

  /** Where an element is in the stack, top first, or -1. */
  private _stackIndex(el: ParentNode): number {
    const T = (this as unknown as ParserInternals).cbs.openNodes;
    for (let i = T.length - 1; i > 0; i--) {
      if (T[i] === el) return T.length - 1 - i;
    }
    return -1;
  }

  /** Where the nearest HTML element of `name` is in the stack, or -1. */
  private _htmlIndex(name: string): number {
    const { stack, foreignContext } = this as unknown as ParserInternals;
    if (foreignContext.length === 1) return stack.indexOf(name);
    for (let k = 0; k < stack.length; k++) {
      if (stack[k] === name && this._isHtml(k)) return k;
    }
    return -1;
  }

  /** The element at `at` taken off the stack, wherever it is in it, and
   *  what it holds left as it is. */
  private _dropFromStack(at: number): void {
    const self = this as unknown as ParserInternals;
    const { stack, foreignContext } = self;
    const name = stack[at];
    stack.splice(at, 1);
    self.cbs.removeOpen(at);
    if (FRAMED.has(name) || foreignContext.length > 1) this._reframe();
  }

  /** The element at `at` in the stack off it, and what it holds still open:
   *  the end of a form, by the form pointer (13.2.6.4.7). */
  private _leaveOpen(at: number): void {
    const self = this as unknown as ParserInternals;
    if (at === 0) {
      self.popElement(false);
      return;
    }
    this._dropFromStack(at);
  }

  /**
   * htmlparser2's frames worked out again from the stack, bottom up, as
   * each element's start tag made its own: where the stack is taken apart
   * in the middle (`_dropFromStack`), what is left of it has to say what it
   * holds.
   */
  private _reframe(): void {
    const self = this as unknown as ParserInternals;
    const { stack, foreignContext, cbs } = self;
    const T = cbs.openNodes;
    const frames = [this._context];
    for (let k = stack.length - 1; k >= 0; k--) {
      const name = stack[k];
      if (!FRAMED.has(name)) continue;
      const el = T[T.length - 1 - k] as Element;
      frames.push(
        frameOf(
          name,
          frames[frames.length - 1],
          stack[k + 1],
          el.attribs ?? {},
        ),
      );
    }
    foreignContext.length = 0;
    for (let i = frames.length - 1; i >= 0; i--) foreignContext.push(frames[i]);
  }

  /** Pop until the current node is one of `context`, or nothing is open. */
  private _clearTo(context: ReadonlySet<string>): void {
    const { stack } = this as unknown as ParserInternals;
    while (stack.length && !context.has(stack[0])) this._pop();
  }

  /** "Close a p element", where one is in button scope. */
  private _closeParagraph(): void {
    const self = this as unknown as ParserInternals;
    if (self.cbs.paragraphs <= 0) return;
    if (this._inScope('p', BUTTON_SCOPE) < 0) return;
    this._impliedEnds('p');
    this._popTo('p');
  }

  /** "Generate implied end tags", but for `except`. */
  private _impliedEnds(except?: string, ends = ENDS_IMPLIED): void {
    const { stack } = this as unknown as ParserInternals;
    while (
      stack.length &&
      ends.has(stack[0]) &&
      stack[0] !== except &&
      this._isHtml(0)
    ) {
      this._pop();
    }
  }

  /** Where the nearest HTML element of `name` stands in a scope, or -1,
   *  which most documents answer without a walk. */
  private _inScope(name: string, stops: ReadonlySet<string> = SCOPE): number {
    const { stack } = this as unknown as ParserInternals;
    return stack.includes(name) ? this._closedBy(name, stops, null, true) : -1;
  }

  /** Whether the element at `at` in the stack is in scope: no element that
   *  bounds a scope is above it. */
  private _elementInScope(at: number): boolean {
    for (let k = 0; k < at; k++) {
      if (this._boundsScope(k)) return false;
    }
    return true;
  }

  private _boundsScope(k: number): boolean {
    const { stack } = this as unknown as ParserInternals;
    const name = stack[k];
    if (this._isHtml(k)) return SCOPE.has(name);
    return SPECIAL_FOREIGN.has(name);
  }

  /** Whether the element at `k` is in the special category. */
  private _specialAt(k: number): boolean {
    const { stack } = this as unknown as ParserInternals;
    const name = stack[k];
    if (this._isHtml(k)) return SPECIAL.has(name);
    return SPECIAL_FOREIGN.has(name);
  }

  /** Where the nearest `<template>` is in the stack, or -1. */
  private _templateOpen(): number {
    return this._htmlIndex('template');
  }

  /** Whether the parser is "parsing template contents" (13.2.4.4). */
  private _inTemplate(): boolean {
    return this._holder === 'template' || this._templateOpen() >= 0;
  }

  /** Whether nothing that is not white space or a comment has been put in
   *  the document yet, so that a doctype or an `<html>` makes it one. */
  private _atStart(): boolean {
    const { stack, cbs } = this as unknown as ParserInternals;
    if (stack.length || this._contextual) return false;
    return !cbs.root.children.some(
      (kid) =>
        isElement(kid) || (kid instanceof Text && NOT_SPACE.test(kid.data)),
    );
  }

  /** White space a fragment began with, which a document has none of before
   *  its `<html>`. */
  private _dropLeadingSpace(): void {
    const { cbs } = this as unknown as ParserInternals;
    for (const kid of cbs.root.children.slice()) {
      if (kid instanceof Text && !NOT_SPACE.test(kid.data)) {
        takeNode(kid);
        cbs.moved();
      }
    }
    cbs.breakText();
  }

  /** "Reset the insertion mode appropriately" (13.2.4.1). */
  private _resetMode(): void {
    const { stack } = this as unknown as ParserInternals;
    const n = this._fragment ? stack.length + 1 : stack.length;
    for (let k = 0; k < n; k++) {
      const last = k === n - 1;
      const name = k < stack.length ? stack[k] : this._holder || 'body';
      if (k < stack.length && !this._isHtml(k)) continue;
      switch (name) {
        case 'td':
        case 'th':
          if (last) break;
          this._mode = IN_CELL;
          return;
        case 'tr':
          this._mode = IN_ROW;
          return;
        case 'tbody':
        case 'thead':
        case 'tfoot':
          this._mode = IN_TABLE_BODY;
          return;
        case 'caption':
          this._mode = IN_CAPTION;
          return;
        case 'colgroup':
          this._mode = IN_COLUMN_GROUP;
          return;
        case 'table':
          this._mode = IN_TABLE;
          return;
        case 'template':
          this._mode =
            this._templateModes[this._templateModes.length - 1] ?? IN_TEMPLATE;
          return;
        case 'head':
          if (last) break;
          this._mode = IN_HEAD;
          return;
        case 'body':
          this._mode = IN_BODY;
          return;
        case 'frameset':
          this._mode = IN_FRAMESET;
          return;
        case 'html':
          this._mode = this._head ? AFTER_HEAD : BEFORE_HEAD;
          return;
      }
      if (last) {
        this._mode = IN_BODY;
        return;
      }
    }
    this._mode = IN_BODY;
  }

  // --- scopes, as #1254 and #1261 read them --------------------------------------------

  /** Whether the element at `at` in the stack is HTML's: it stands in the
   *  frame under its own, if it has one, and an `<svg>` or a `<math>` in any
   *  frame is not. */
  private _isHtml(at: number): boolean {
    const { stack, foreignContext } = this as unknown as ParserInternals;
    if (foreignContext.length === 1 && foreignContext[0] === NOT_FOREIGN) {
      return true;
    }
    let frame = 0;
    for (let k = 0; k <= at; k++) if (FRAMED.has(stack[k])) frame++;
    const el = stack[at];
    return (
      foreignContext[frame] === NOT_FOREIGN && el !== 'svg' && el !== 'math'
    );
  }

  /**
   * Where in the stack `name`, or one of `kin`, is found for what a tag closes,
   * or -1 where HTML's rules ignore it. From a foreign element it closes the
   * nearest element of the name up to the first HTML one. From an HTML one, or
   * from that first one, it is HTML's, which closes HTML elements alone and
   * reaches nothing past `stops` or a foreign element its scopes stop at, an
   * `<annotation-xml>` whatever that holds, but for what goes by a table's scope
   * or by none, which have none of them. An entry stands in the frame under its
   * own, if it has one, and an `<svg>` or a `<math>` in any frame is no HTML
   * element. `html` is for a start tag (`_inScope`), since one read in an
   * integration point is HTML, where an end tag read there is still foreign
   * content's.
   */
  private _closedBy(
    name: string,
    stops: ReadonlySet<string>,
    kin: ReadonlySet<string> | null = null,
    html = false,
  ): number {
    const { stack, foreignContext } = this as unknown as ParserInternals;
    if (stack[0] === name) return 0;
    if (foreignContext.length === 1 && foreignContext[0] === NOT_FOREIGN) {
      return this._walked(name, stops, kin);
    }
    const lower = name.toLowerCase();
    const scoped = stops !== TABLE_SCOPE && stops !== NO_SCOPE;
    let frame = 0;
    let stopped = false;
    for (let at = 0; at < stack.length; at++) {
      const el = stack[at].toLowerCase();
      if (FRAMED.has(stack[at])) frame++;
      const language = foreignContext[frame];
      if (language === NOT_FOREIGN && el !== 'svg' && el !== 'math') {
        if (stopped) return -1;
        html = true;
        if (el === lower || kin?.has(el)) return at;
        if (stops.has(el)) return -1;
        continue;
      }
      if (!html && el === lower) return at;
      if (
        scoped &&
        (language === IN_SVG
          ? SVG_POINTS.has(el)
          : MATHML_POINTS.has(el) || el === 'annotation-xml')
      ) {
        stopped = true;
      }
    }
    return -1;
  } /**
   * `_closedBy` with nothing foreign open, which is nearly every walk there is.
   * It looks as far as a document's tree goes (`MAX_DEPTH`), and past that takes
   * the name for what it finds, as htmlparser2 did: a walk costs what is open, so
   * thousands of unclosed elements and a tag for each that closes nothing would
   * cost the square of them, and a parse that long holds the page up.
   */
  private _walked(
    name: string,
    stops: ReadonlySet<string>,
    kin: ReadonlySet<string> | null,
  ): number {
    const { stack } = this as unknown as ParserInternals;
    const end = Math.min(stack.length, MAX_DEPTH);
    for (let at = 0; at < end; at++) {
      const el = stack[at];
      if (el === name || kin?.has(el)) return at;
      if (stops.has(el)) return -1;
    }
    return kin ? -1 : stack.indexOf(name, end);
  } /**
   * A start tag that ends foreign content closes it, as far as the nearest
   * HTML element or integration point, and what it opens, and all that comes
   * after, stands there (HTML 13.2.6.5). htmlparser2 keeps it in the drawing,
   * so an `<svg><p>x</p><link>` held a link that all three engines have as
   * HTML's, in the body. A fragment keeps its context, which nothing closes.
   */
  private _breakOut(): void {
    const self = this as unknown as ParserInternals;
    while (this.isInForeignContext() && self.stack.length) {
      self.popElement(true);
    }
    self.foreignContext[0] = NOT_FOREIGN;
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
 *  this already has the whole string. `context` is the element it is read
 *  as the content of, which says what it is in a drawing. */
export function parseFragment(
  html: string,
  declarative = false,
  context: Element | null = null,
): ChildNode[] {
  const { parser, handler } = createParser(declarative);
  if (context) {
    // hung off it while it is read, for `namespaceIn` to go on up
    handler.root.parent = context;
    const namespace = namespaceIn(context);
    parser.readIn(
      namespace,
      namespace === undefined ? context.name : '',
      formAround(context),
    );
  } else {
    // nothing says what it is the content of, so it is a `<template>`'s
    parser.readIn(undefined, 'template', null);
  }
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

/** The nearest `<form>` at or around an element, which `innerHTML` reads with
 *  the form pointer on (HTML 13.4). */
function formAround(context: Element): Element | null {
  for (let at: ParentNode | null = context; at; at = at.parent) {
    if (at instanceof Element && at.name === 'form') return at;
  }
  return null;
}

/** Whether a tag's content is raw text — the box builder skips these, and
 *  `<textarea>`'s value comes from it rather than from a child box. */
export function isRawText(tag: string): boolean {
  return RAW_TEXT.has(tag);
}
