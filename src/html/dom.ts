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
import { DomHandler, Element, Text } from 'domhandler';
import type { AnyNode, ChildNode, Document, ParentNode } from 'domhandler';

export type { AnyNode, ChildNode, Document, ParentNode } from 'domhandler';
export { Element, Text, Comment } from 'domhandler';

/** Elements whose content is markup-opaque, so the tokenizer stays in raw
 *  text until the matching close tag. htmlparser2 knows these already; the
 *  set is here because the box builder has to skip the same ones. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** Never rendered, whatever the stylesheet says: a `<template>`'s
 *  content is inert. The rest of what has no box of its own — `<head>` and
 *  what is in it, `<script>`, `<style>` — is `display: none` by the UA
 *  sheet, and shown where an author's sheet says otherwise, as a browser
 *  shows it: `head, meta { display: block }` makes a `<meta>`'s `::before`
 *  a line of the page. */
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

/** Whether an element is head content with no `<head>` around it: at the
 *  top of the document or right under `<html>`. */
export function inImpliedHead(el: Element, tag: string): boolean {
  if (!HEAD_CONTENT.has(tag)) return false;
  const parent = el.parent;
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
 *  shows until it plays, which here it does not. */
export function imageUrlOf(el: Element): string | undefined {
  const tag = tagOf(el);
  return tag === 'object'
    ? attr(el, 'data')
    : tag === 'video'
      ? attr(el, 'poster')
      : attr(el, 'src');
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
 */
export function* elementsIn(root: AnyNode): Generator<Element> {
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
    const grandkids = childrenOf(child);
    if (grandkids.length) {
      stack.push(grandkids);
      at.push(0);
    }
  }
}

// --- the streaming source --------------------------------------------------

/** What the document told the host about itself while parsing. */
export interface DocumentFacts {
  /** `<style>` text and `<link rel=stylesheet>` hrefs, in document order —
   *  order is the cascade's tie-breaker, so it is data, not a detail. */
  sheets: SheetRef[];
  /** Every `<script>`, for the seam. Never parsed and never evaluated. */
  scripts: Element[];
  /** Elements with a resource to fetch — `<img>`, and `<link>` above. */
  resources: Element[];
  /** `<title>`, when the document had one. */
  title: string | null;
}

export type SheetRef =
  | { kind: 'inline'; text: string; element: Element }
  | { kind: 'link'; href: string; element: Element };

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
  private _handler: DomHandler;
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
  }

  /** The DOM changed under us — an app mutated it, or a stylesheet arrived
   *  and was spliced in. Anything cached on the old revision is stale. */
  touch(): void {
    this.revision += 1;
    this._facts = freshFacts();
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
    for (const el of elementsIn(this.document)) {
      const tag = tagOf(el);
      if (tag === 'style') {
        const media = attr(el, 'media');
        // A media query this renderer cannot evaluate is not a licence to
        // apply the sheet anyway: `media="print"` is meant not to show.
        if (!media || appliesToScreen(media)) {
          facts.sheets.push({
            kind: 'inline',
            text: rawTextOf(el),
            element: el,
          });
        }
      } else if (tag === 'link') {
        const rel = (attr(el, 'rel') ?? '').toLowerCase();
        const href = attr(el, 'href');
        if (href && rel.split(/\s+/).includes('stylesheet')) {
          const media = attr(el, 'media');
          if (!media || appliesToScreen(media)) {
            facts.sheets.push({ kind: 'link', href, element: el });
            facts.resources.push(el);
          }
        }
      } else if (tag === 'script') {
        facts.scripts.push(el);
      } else if (
        tag === 'img' ||
        tag === 'image' ||
        tag === 'object' ||
        tag === 'embed' ||
        tag === 'video'
      ) {
        if (imageUrlOf(el)) facts.resources.push(el);
      } else if (tag === 'title' && facts.title === null) {
        facts.title = rawTextOf(el).trim();
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
  return { sheets: [], scripts: [], resources: [], title: null, scanned: -1 };
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

function createParser(): { parser: Parser; handler: DomHandler } {
  const handler = new Handler(null, {
    // Positions cost time and memory per node and nothing here reads them.
    withStartIndices: false,
    withEndIndices: false,
  });
  const parser = new Parser(handler, {
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    recognizeSelfClosing: true,
    decodeEntities: true,
  });
  return { parser, handler };
}

/**
 * Whether a `media` attribute is one a screen honours. Deliberately not a
 * media-query engine: `screen`, `all` and an empty list apply, `print` and
 * anything else with a type this is not does not, and a query with features
 * in it (`(min-width: …)`) applies — a responsive sheet written for a real
 * browser is closer to right applied than dropped.
 */
function appliesToScreen(media: string): boolean {
  for (const query of media.split(',')) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (q === 'all' || q === 'screen') return true;
    if (q.startsWith('screen ') || q.startsWith('(')) return true;
    if (q.startsWith('only screen')) return true;
  }
  return false;
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
 *  the element to hang it off. Not streaming: a fragment is small by
 *  definition, and an app calling this already has the whole string. */
export function parseFragment(html: string): ChildNode[] {
  const { parser, handler } = createParser();
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
