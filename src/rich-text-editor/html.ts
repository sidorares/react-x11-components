// HTML in and out of a document, through ProseMirror's own DOMParser and
// DOMSerializer — with no DOM.
//
// Both classes are written against the browser's DOM, and both are still the
// right thing to use: every schema in the ecosystem already says how it reads
// HTML (`parseDOM` rules) and how it writes it (`toDOM`), so going through
// them makes a paste from a browser, `format="html"` and a copy another
// application can read work for *any* schema — the default one here,
// prosemirror-schema-basic's, a TipTap extension's — with nothing written per
// node. Reimplementing either would mean a second reading of every schema's
// rules, and the first one to disagree with ProseMirror's would be a bug.
//
// So this module supplies the smallest DOM each of them touches.
//
// **Reading.** htmlparser2 builds the tree — already installed, for the
// reason `src/html/dom.ts` gives — and it is re-dressed in nodes that answer
// what `DOMParser` asks: `nodeType`/`nodeName`, the sibling links, the
// attributes, `style` as a declaration block, `matches`/`querySelector`
// through css-select, `appendChild` (its list normalization moves nodes), and
// an `ownerDocument` that can make a text node. Selector matching runs on the
// parser's own tree, so a structural selector sees the markup as written,
// not after that normalization; the rules schemas actually write are a tag
// and an attribute, which do not care.
//
// **Writing.** `DOMSerializer` takes a `document` option, and a four-method
// one that builds plain objects is all it calls; they are then printed.
import { Parser } from 'htmlparser2';
import { DomHandler } from 'domhandler';
import type { ChildNode, Element as DhElement } from 'domhandler';
import { is, selectAll, selectOne } from 'css-select';
import { DOMParser, DOMSerializer, Fragment } from 'prosemirror-model';
import type {
  Node as PMNode,
  ParseOptions,
  Schema,
  Slice,
} from 'prosemirror-model';

/** What `DOMParser` is typed to take, which the shim stands in for. */
type DomArg = Parameters<DOMParser['parse']>[0];

const HTML_NS = 'http://www.w3.org/1999/xhtml';

// --- reading ---------------------------------------------------------------

/** `font-weight` → `fontWeight`, the name a `getAttrs` reads off `style`. */
function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Split a declaration block on the semicolons that end declarations — not
 *  the ones inside a `url(…)` or a quoted string. */
function declarations(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote && css[i - 1] !== '\\') quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      out.push(css.slice(start, i));
      start = i + 1;
    }
  }
  out.push(css.slice(start));
  return out;
}

const STYLE_MEMBERS = new Set([
  'length',
  'item',
  'getPropertyValue',
  'cssText',
]);

/** A `style` attribute, as the declaration object `DOMParser`'s style rules
 *  and a schema's `getAttrs` read: `getPropertyValue` for the former,
 *  camelCase properties for the latter. */
export class ShimStyle {
  [property: string]: unknown;
  private readonly _names: string[] = [];
  private readonly _values = new Map<string, string>();

  constructor(css: string) {
    for (const decl of declarations(css)) {
      const colon = decl.indexOf(':');
      if (colon <= 0) continue;
      const name = decl.slice(0, colon).trim().toLowerCase();
      const value = decl
        .slice(colon + 1)
        .replace(/!\s*important\s*$/i, '')
        .trim();
      if (!name || !value) continue;
      this._set(name, value);
      // a browser reports the shorthand's longhand too, and rules are
      // written against either
      if (name === 'text-decoration') this._set('text-decoration-line', value);
    }
  }

  private _set(name: string, value: string): void {
    if (!this._values.has(name)) this._names.push(name);
    this._values.set(name, value);
    const prop = camel(name);
    if (!STYLE_MEMBERS.has(prop)) this[prop] = value;
  }

  get length(): number {
    return this._names.length;
  }

  item(index: number): string {
    return this._names[index] ?? '';
  }

  getPropertyValue(name: string): string {
    return this._values.get(name.toLowerCase()) ?? '';
  }

  get cssText(): string {
    return this._names.map((n) => `${n}: ${this._values.get(n)}`).join('; ');
  }
}

abstract class ShimNode {
  abstract readonly nodeType: number;
  abstract readonly nodeName: string;
  ownerDocument!: ShimDocument;
  parentNode: ShimParent | null = null;
  nextSibling: ShimNode | null = null;
  previousSibling: ShimNode | null = null;

  abstract get textContent(): string;

  contains(other: ShimNode | null): boolean {
    for (let n: ShimNode | null = other; n; n = n.parentNode) {
      if (n === this) return true;
    }
    return false;
  }
}

abstract class ShimParent extends ShimNode {
  readonly childNodes: ShimNode[] = [];

  get firstChild(): ShimNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): ShimNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get textContent(): string {
    let out = '';
    for (const child of this.childNodes) out += child.textContent;
    return out;
  }

  appendChild<T extends ShimNode>(child: T): T {
    child.parentNode?.removeChild(child);
    const last = this.lastChild;
    child.parentNode = this;
    child.previousSibling = last;
    child.nextSibling = null;
    if (last) last.nextSibling = child;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends ShimNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at < 0) return child;
    this.childNodes.splice(at, 1);
    if (child.previousSibling)
      child.previousSibling.nextSibling = child.nextSibling;
    if (child.nextSibling)
      child.nextSibling.previousSibling = child.previousSibling;
    child.parentNode = null;
    child.previousSibling = null;
    child.nextSibling = null;
    return child;
  }
}

export class ShimText extends ShimNode {
  readonly nodeType = 3;
  readonly nodeName = '#text';

  constructor(
    doc: ShimDocument,
    public nodeValue: string,
  ) {
    super();
    this.ownerDocument = doc;
  }

  get textContent(): string {
    return this.nodeValue;
  }
}

export class ShimElement extends ShimParent {
  readonly nodeType = 1;
  readonly nodeName: string;
  readonly tagName: string;
  readonly localName: string;
  readonly namespaceURI = HTML_NS;
  readonly style: ShimStyle;
  private readonly _attrs: Map<string, string>;

  constructor(
    doc: ShimDocument,
    /** The parser's node, which selectors are matched against. */
    readonly source: DhElement,
  ) {
    super();
    this.ownerDocument = doc;
    this.localName = source.name.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.nodeName = this.tagName;
    this._attrs = new Map(
      Object.entries(source.attribs ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    this.style = new ShimStyle(this._attrs.get('style') ?? '');
  }

  getAttribute(name: string): string | null {
    return this._attrs.get(name.toLowerCase()) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this._attrs.has(name.toLowerCase());
  }

  get attributes(): { name: string; value: string }[] {
    return [...this._attrs].map(([name, value]) => ({ name, value }));
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  get className(): string {
    return this.getAttribute('class') ?? '';
  }

  get classList(): { contains(name: string): boolean; length: number } {
    const list = this.className.split(/\s+/).filter(Boolean);
    return { contains: (name) => list.includes(name), length: list.length };
  }

  matches(selector: string): boolean {
    try {
      return is(this.source, selector);
    } catch {
      return false; // a selector css-select cannot read matches nothing
    }
  }

  querySelector(selector: string): ShimElement | null {
    try {
      const found = selectOne<ChildNode, DhElement>(
        selector,
        this.source.children,
      );
      return found ? this.ownerDocument.shimOf(found) : null;
    } catch {
      return null;
    }
  }

  querySelectorAll(selector: string): ShimElement[] {
    try {
      return selectAll<ChildNode, DhElement>(selector, this.source.children)
        .map((found) => this.ownerDocument.shimOf(found))
        .filter((e): e is ShimElement => e !== null);
    } catch {
      return [];
    }
  }
}

export class ShimDocument extends ShimParent {
  readonly nodeType = 9;
  readonly nodeName = '#document';
  private readonly _shims = new WeakMap<DhElement, ShimElement>();

  constructor() {
    super();
    this.ownerDocument = this;
  }

  createTextNode(text: string): ShimText {
    return new ShimText(this, text);
  }

  /** @internal — the shim a parser element became. */
  shimOf(node: DhElement): ShimElement | null {
    return this._shims.get(node) ?? null;
  }

  /** @internal */
  adopt(node: DhElement): ShimElement {
    const shim = new ShimElement(this, node);
    this._shims.set(node, shim);
    return shim;
  }
}

function isElementNode(node: ChildNode): node is DhElement {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

/**
 * The shim tree for a parsed fragment, under `into`. An explicit stack
 * rather than recursion: a pasted document is somebody else's markup, and a
 * degenerately nested one should not be the thing that finds the call-stack
 * limit (`src/html/dom.ts` measured the same walk).
 */
function build(doc: ShimDocument, into: ShimParent, nodes: ChildNode[]): void {
  const stack: [ShimParent, ChildNode[]][] = [[into, nodes]];
  while (stack.length > 0) {
    const [parent, kids] = stack.pop()!;
    for (const kid of kids) {
      if (kid.type === 'text') {
        parent.appendChild(new ShimText(doc, kid.data));
      } else if (isElementNode(kid)) {
        const shim = parent.appendChild(doc.adopt(kid));
        if (kid.children.length > 0) stack.push([shim, kid.children]);
      }
      // comments, directives and CDATA: DOMParser skips them anyway
    }
  }
}

/** Elements that only parse inside a table — ProseMirror's (and jQuery's)
 *  list, so a copied cell pastes as a cell. */
const WRAP_MAP: Record<string, string[]> = {
  thead: ['table'],
  tbody: ['table'],
  tfoot: ['table'],
  caption: ['table'],
  colgroup: ['table'],
  col: ['table', 'colgroup'],
  tr: ['table', 'tbody'],
  td: ['table', 'tbody', 'tr'],
  th: ['table', 'tbody', 'tr'],
};

/**
 * HTML → the element DOMParser reads — the counterpart of prosemirror-view's
 * `readHTML`: leading `<meta>`s dropped (a browser's clipboard starts with
 * one), and a fragment that begins inside a table given its table back.
 */
export function readHTML(html: string): ShimElement {
  const metas = /^(\s*<meta [^>]*>)*/i.exec(html);
  if (metas) html = html.slice(metas[0].length);
  const first = /<([a-z][^>\s]+)/i.exec(html);
  const wrap = first ? WRAP_MAP[first[1].toLowerCase()] : undefined;
  if (wrap) {
    html =
      wrap.map((n) => `<${n}>`).join('') +
      html +
      wrap
        .map((n) => `</${n}>`)
        .reverse()
        .join('');
  }
  const handler = new DomHandler();
  const parser = new Parser(handler);
  parser.write(`<body>${html}</body>`);
  parser.end();
  const doc = new ShimDocument();
  build(doc, doc, handler.root.children);
  let body = doc.childNodes.find(
    (n): n is ShimElement => n instanceof ShimElement && n.localName === 'body',
  );
  if (!body) throw new Error('readHTML: the parser lost its <body>');
  if (wrap) {
    for (const name of wrap) body = body.querySelector(name) ?? body;
  }
  return body;
}

/** A whole document of `schema`, from HTML. */
export function docFromHTML(
  schema: Schema,
  html: string,
  options?: ParseOptions,
): PMNode {
  return DOMParser.fromSchema(schema).parse(
    readHTML(html) as unknown as DomArg,
    options,
  );
}

/** A slice of `schema`, from HTML — open at the sides, the shape
 *  `replaceSelection` wants. */
export function sliceFromHTML(
  schema: Schema,
  html: string,
  options?: ParseOptions,
): Slice {
  return DOMParser.fromSchema(schema).parseSlice(
    readHTML(html) as unknown as DomArg,
    options,
  );
}

/** Parse an element already read with {@link readHTML}. */
export function sliceFromElement(
  parser: DOMParser,
  dom: ShimElement,
  options?: ParseOptions,
): Slice {
  return parser.parseSlice(dom as unknown as DomArg, options);
}

// --- writing ---------------------------------------------------------------

type OutNode = OutElement | OutText | OutFragment;

class OutText {
  readonly nodeType = 3;
  constructor(public nodeValue: string) {}
}

class OutFragment {
  readonly nodeType = 11;
  readonly childNodes: OutNode[] = [];

  appendChild<T extends OutNode>(child: T): T {
    append(this.childNodes, child);
    return child;
  }

  get firstChild(): OutNode | null {
    return this.childNodes[0] ?? null;
  }
}

class OutElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly nodeName: string;
  readonly attrs = new Map<string, string>();
  readonly childNodes: OutNode[] = [];
  /** DOMSerializer writes a `style` attribute as `style.cssText`. */
  readonly style = { cssText: '' };

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
    this.nodeName = this.tagName.toUpperCase();
  }

  setAttribute(name: string, value: unknown): void {
    this.attrs.set(name, String(value));
  }

  setAttributeNS(_ns: string, name: string, value: unknown): void {
    this.setAttribute(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  appendChild<T extends OutNode>(child: T): T {
    append(this.childNodes, child);
    return child;
  }

  get firstChild(): OutNode | null {
    return this.childNodes[0] ?? null;
  }
}

function append(list: OutNode[], child: OutNode): void {
  if (child instanceof OutFragment) {
    list.push(...child.childNodes);
    child.childNodes.length = 0;
  } else list.push(child);
}

/** The whole of the `document` DOMSerializer calls. */
const OUT_DOCUMENT = {
  createElement: (tag: string) => new OutElement(tag),
  createElementNS: (_ns: string, tag: string) => new OutElement(tag),
  createTextNode: (text: string) => new OutText(text),
  createDocumentFragment: () => new OutFragment(),
};

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

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/ /g, '&nbsp;');
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

function print(node: OutNode): string {
  if (node instanceof OutText) return escapeText(node.nodeValue);
  if (node instanceof OutFragment) return node.childNodes.map(print).join('');
  let attrs = '';
  for (const [name, value] of node.attrs) {
    attrs += ` ${name}="${escapeAttr(value)}"`;
  }
  if (node.style.cssText && !node.attrs.has('style')) {
    attrs += ` style="${escapeAttr(node.style.cssText)}"`;
  }
  if (VOID.has(node.tagName)) return `<${node.tagName}${attrs}>`;
  return `<${node.tagName}${attrs}>${node.childNodes.map(print).join('')}</${node.tagName}>`;
}

/** Serialize content through the schema's `toDOM`, as a fragment of the
 *  printed tree — the clipboard adds its own attribute before printing. */
export function renderFragment(
  schema: Schema,
  content: Fragment,
): { html(): string; firstElement(): OutElement | null } {
  const out = DOMSerializer.fromSchema(schema).serializeFragment(content, {
    document: OUT_DOCUMENT as unknown as Parameters<
      DOMSerializer['serializeFragment']
    >[1] extends infer O
      ? O extends { document?: infer D }
        ? D
        : never
      : never,
  }) as unknown as OutFragment;
  return {
    html: () => print(out),
    firstElement: () =>
      (out.childNodes.find((n) => n instanceof OutElement) as OutElement) ??
      null,
  };
}

/**
 * The HTML a copy offers other applications — prosemirror-view's
 * `serializeForClipboard`, printed rather than put in a DOM: the content
 * through `serializer`, wrapped in a table when it starts with a table's
 * parts (a cell alone is not HTML any reader keeps), and ProseMirror's
 * `data-pm-slice` marker on the first element, so a ProseMirror editor
 * anywhere — this one, or one in a browser — pastes it back with its open
 * sides and its context intact.
 */
export function clipboardHTML(
  serializer: DOMSerializer,
  content: Fragment,
  openStart: number,
  openEnd: number,
  context: unknown[],
): string {
  const out = serializer.serializeFragment(content, {
    document: OUT_DOCUMENT as never,
  }) as unknown as OutFragment;
  let top: OutNode[] = out.childNodes;
  let wrappers = 0;
  let first = top[0];
  let needs: string[] | undefined;
  if (first instanceof OutElement && (needs = WRAP_MAP[first.tagName])) {
    for (let i = needs.length - 1; i >= 0; i--) {
      const wrapper = new OutElement(needs[i]);
      wrapper.childNodes.push(...top);
      top = [wrapper];
      wrappers++;
    }
    first = top[0];
  }
  if (first instanceof OutElement) {
    first.setAttribute(
      'data-pm-slice',
      `${openStart} ${openEnd}${wrappers ? ` -${wrappers}` : ''} ${JSON.stringify(context)}`,
    );
  }
  return top.map(print).join('');
}

/** A document or a fragment as HTML, through the schema's `toDOM`. */
export function htmlFromContent(
  schema: Schema,
  content: Fragment | PMNode,
): string {
  const fragment = content instanceof Fragment ? content : content.content;
  return renderFragment(schema, fragment).html();
}
