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

/** Never rendered, whatever the stylesheet says. `<script>` and `<style>`
 *  are consumed by the seams instead; the rest have no visual box in the
 *  subset this renders. */
export const NON_RENDERED = new Set([
  'script',
  'style',
  'head',
  'meta',
  'link',
  'title',
  'base',
  'template',
  'noscript',
]);

/** An element's tag name, lowercased — htmlparser2 already lowercases in
 *  HTML mode, so this is the assertion rather than the work. */
export function tagOf(node: AnyNode): string {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style'
    ? (node as Element).name.toLowerCase()
    : '';
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

  /** Set the whole source. Appends when it can; re-parses when it cannot. */
  setSource(source: string, complete: boolean): boolean {
    let changed = false;
    if (source === this._written) {
      changed = false;
    } else if (source.startsWith(this._written)) {
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
      } else if (tag === 'img' || tag === 'image') {
        if (attr(el, 'src')) facts.resources.push(el);
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

function createParser(): { parser: Parser; handler: DomHandler } {
  const handler = new DomHandler(null, {
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
