// The host's half of the bridge: `<Html>`'s DOM, by node id, for the facade
// in the page's context (`dom.ts`). Every op takes primitives and answers
// one; an error is a string the facade throws as a `DOMException`, never a
// host object, whose `constructor.constructor` would be the host's
// `Function` (docs/prd-html-scripts.md, "the five leaks").
//
// The tree is the one `<Html>` draws, so a mutation here is a mutation of
// the page: the ops change domhandler's nodes and record each change, and
// `flush` hands the records to the handle's `refresh(changes)` — once a
// task, after the script that made the changes is done (`ScriptEngine`),
// and before anything asks the layout a question (`rect`, `computed`,
// `at`), which has to answer from the change. The same records are what a
// page's `MutationObserver` is handed.
//
// What the page cannot do here is anything the browser does not let it: a
// `fetch` is its own origin's, or another's that lets it by CORS, through
// the browser's network; storage is memory, per origin, gone with the
// process; a navigation is a link the browser follows.
import * as DomUtils from 'domutils';
import { Parser } from 'htmlparser2';
import { is, selectAll, selectOne } from 'css-select';
import {
  Comment,
  Document,
  DomHandler,
  Element,
  ProcessingInstruction,
  Text,
} from 'domhandler';
import type { AnyNode, ChildNode, ParentNode } from 'domhandler';
import type { Rect } from 'react-x11';

import type { HtmlChange, HtmlDomEvent, HtmlHandle } from '../index.js';
import { attachShadow, parseFragment, shadowRootOf } from '../index.js';
import {
  HtmlSource,
  ShadowRoot,
  indicatedElement,
  isCustomized,
  isDefinedElement,
  isModal,
  isPopoverOpen,
  isMuted,
  setMuted,
  markCustomized,
  setModal,
  setPopoverOpen,
  topLayerIn,
  topLayerOf,
  treeGeneration,
  treesChanged,
} from '../dom.js';
import { specifiedValue } from '../css/specified.js';
import { Cascade } from '../css/cascade.js';
import { uaStylesheet } from '../css/ua.js';
import { cssomStyle } from '../computed.js';
import type { ComputedStyle, RootLook } from '../css/style.js';
import type { Stylesheet } from '../css/parse.js';
import {
  parseDeclarations,
  parseStylesheet,
  supportsCondition,
} from '../css/parse.js';
import { closeBrackets, hasVar } from '../css/vars.js';
import { matchesSyntax, validSyntax } from '../css/syntax.js';
import { focusableElement } from '../focus.js';
import { isDisabled, validationMessage } from '../form.js';
import type { Bridge, Primitive } from './dom.js';
import {
  LiveRange,
  NodeIterators,
  Ranges,
  indexOf,
  isDoctype,
} from './ranges.js';
import type { CharacterData } from './ranges.js';
import { navigableFor } from './target.js';
import * as ntk from 'react-x11/ntk';
import type {
  AbortControllerClass,
  AbortSignalLike,
  BufferClass,
  ClearTimeout,
  SetTimeout,
  UrlClass,
} from './platform.js';

declare const setTimeout: SetTimeout;
declare const clearTimeout: ClearTimeout;
declare const setInterval: SetTimeout;
declare const clearInterval: ClearTimeout;
declare const URL: UrlClass;
declare const AbortController: AbortControllerClass;
declare const Buffer: BufferClass;
/** The runtime's Web Crypto and its clock, which Node and Bun both have. */
declare const crypto: {
  getRandomValues(array: Uint8Array): Uint8Array;
  randomUUID(): string;
};
declare const performance: { now(): number };

/** ntk's CSS colour parser, straight RGBA from 0 to 1: on the module, and
 *  not in `ntk.d.ts`'s named list (AGENTS.md, "Affordance glyphs"). */
const cssColorStraight = (
  ntk as unknown as {
    cssColorStraight?: (
      color: string,
    ) => [number, number, number, number] | null;
  }
).cssColorStraight;

/** A `<canvas>`'s pixels as the page's script drew them (`canvasPut`):
 *  straight RGBA, and a count of the changes, which a view that draws them
 *  re-renders on. */
export interface CanvasPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  version: number;
}

/** A request a page's `fetch` makes, and what it came to. */
export interface FetchRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
  /** The body's bytes, where it is not text — a stream read to its end, a
   *  `Blob`, an `ArrayBuffer`, a multipart form — sent as they are. */
  bytes?: Uint8Array;
  /** Whether the caller takes the response's body as it arrives
   *  (`FetchResponse.chunks`), as a page's `fetch` does. A host may answer
   *  it whole all the same. */
  stream?: boolean;
}
/** A dedicated worker the page asked for (`new Worker`), as the host
 *  starts it: its script's address, its kind and its name, the script
 *  itself where it is a blob URL's, and the origin it is of. */
export interface WorkerInit {
  url: string;
  type: 'classic' | 'module';
  name: string;
  source: string | null;
  origin: string;
}

/** Where a page's workers run (`workers.ts`): each started, posted to and
 *  ended by the number `start` answered. */
export interface PageWorkersLike {
  start(init: WorkerInit): number;
  post(id: number, data: string): void;
  end(id: number): void;
}

/** What a realm that is a worker's reaches its page by
 *  (`worker-thread.ts`). */
export interface WorkerScope {
  post(data: string): void;
  close(): void;
  /** A script's source, fetched before this returns, or null. */
  importScript(url: string): string | null;
  error(message: string, filename: string, line: number, column: number): void;
}

/** A frame a browser that draws frames mounts a view for (`frames`). */
export interface FrameShown {
  frame: Element;
  document: Document;
  url: string;
  /** Whether its document runs in a realm of its own (`DomShared.realms`),
   *  or is the page realm's, drawn and nothing more. */
  realm: boolean;
}

/** A form's POST into a frame its target names (`navigateFrame`). */
export interface FramePost {
  body: string;
  contentType: string;
}
export interface FetchResponse {
  url: string;
  status: number;
  statusText: string;
  redirected: boolean;
  headers: [string, string][];
  /** The body, decoded as the response says. */
  body: string;
  /** Its bytes, where the network has them: what a page's `fetch` is
   *  handed, so a binary body — a `.wasm`, an image, a font — reaches it as
   *  it came, and `text()` decodes it as Fetch says, as UTF-8. */
  bytes?: Uint8Array;
  /** The body as it arrives, where the request asked for it so and the
   *  host has it so: `body` and `bytes` are then empty. A page's `fetch`
   *  resolves at the headers and reads its body from these, as a browser's
   *  does — a model's reply, a stream of events, a download that trickles. */
  chunks?: AsyncIterable<Uint8Array>;
  /** What the page may read of it (Fetch 2.2.6): `basic` its own
   *  origin's, `cors` another's that let it, `opaque` none of it. */
  type?: 'basic' | 'cors' | 'opaque';
}

/** A page's request as the facade hands it over, with what decides
 *  whether another origin's answer is the page's to read. */
interface PageRequest extends FetchRequest {
  mode: 'cors' | 'no-cors' | 'same-origin';
  credentials: 'omit' | 'same-origin' | 'include';
}

/** What CORS remembers of a preflight (Fetch 4.9, the CORS-preflight
 *  cache): what the server allowed, until when. */
interface PreflightEntry {
  until: number;
  methods: Set<string>;
  headers: Set<string>;
  anyMethod: boolean;
  anyHeader: boolean;
}

/**
 * What the host asks of the handle `useHtmlHandle` makes beside its public
 * members, which no other handle owes: the runner's handles forward it,
 * and one without it — a worker's, which draws nothing — answers as an
 * element that scrolls with the document and with every scroll container
 * around it.
 */
export interface HandleInternals {
  /** Whether an element is drawn where the viewport is — fixed to it, or
   *  in a box that is — so that no scroll of the pane around the document
   *  moves it (`HtmlViewNode.atViewport`). */
  drawnAtViewport(element: Element): boolean;
  /** Whether a scroll container's scroll moves an element: not where the
   *  element, or a box between them, is positioned against something
   *  outside it (`HtmlViewNode.scrollMoves`). */
  scrollMoves(scroller: Element, element: Element): boolean;
  /** The DOM boundary point nearest a logical window point, as
   *  `caretPositionFromPoint` answers (`HtmlViewNode.textPointAt`). */
  textPointAt(x: number, y: number): { node: AnyNode; offset: number } | null;
  /** Where the text between two DOM boundary points is drawn, in
   *  `elementRect`'s coordinates (`HtmlViewNode.textRects`). */
  textRects(
    start: AnyNode,
    startOffset: number,
    end: AnyNode,
    endOffset: number,
  ): Rect[] | null;
  /** The custom highlights a page's `CSS.highlights` holds, to draw
   *  (`HtmlViewNode.setHighlights`). */
  setHighlights(highlights: readonly HighlightRanges[]): void;
  /** What the page's `CSS.registerProperty` registered, as `@property`
   *  rules (`HtmlViewNode.setRegisteredProperties`). */
  setRegisteredProperties(rules: string): void;
  /** The reader's selection in the document as DOM boundary points, and
   *  a page's drawn as one (`HtmlViewNode.selectionPoints`,
   *  `selectPoints`). */
  selectionPoints(): {
    sc: AnyNode;
    so: number;
    ec: AnyNode;
    eo: number;
    key: string;
  } | null;
  selectPoints(
    points: { sc: AnyNode; so: number; ec: AnyNode; eo: number } | null,
  ): void;
}

/** A custom highlight as a page's `CSS.highlights` holds it: a live
 *  range by its id, a static one by its two points' node ids and offsets. */
interface HighlightSpec {
  name: string;
  priority: number;
  ranges: (number | [number, number, number, number])[];
}

/** A custom highlight as the document draws it (CSS Highlight API 1): its
 *  name, its priority, and its ranges' boundary points as they are now. */
export interface HighlightRanges {
  name: string;
  priority: number;
  ranges: { sc: AnyNode; so: number; ec: AnyNode; eo: number }[];
}

/** What the page around the document gives the host: where it is shown,
 *  where it goes, and what it may fetch. */
export interface HostSeams {
  handle: HtmlHandle & Partial<HandleInternals>;
  /** The pane the document is shown in, in CSS pixels — its size and its
   *  scroll — with the page's zoom and the device's scale, and where its
   *  top left is in the window, in logical pixels. */
  viewport(): {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    zoom: number;
    dpr: number;
    left: number;
    top: number;
  };
  scrollTo(x: number, y: number): void;
  /** A navigation the page asked for: an address assigned, `open`. */
  navigate(url: string, how: 'here' | 'replace' | 'tab'): void;
  reload(): void;
  go(delta: number): void;
  /** What the page writes to its console. */
  log(level: string, text: string): void;
  /** The document's title changed. */
  title(title: string | null): void;
  fetch(request: FetchRequest, signal: AbortSignalLike): Promise<FetchResponse>;
  userAgent: string;
  language: string;
  /** The sheets the document adopted (`document.adoptedStyleSheets`),
   *  each its text, for `<Html>` to apply after the document's own. */
  adopt?(sheets: string[]): void;
  /**
   * Whether the browser draws the page's frames and runs each one's scripts
   * in a realm of its own (`ScriptRunner`'s frames): a frame's document is
   * still loaded here, and its scripts are not run here, nor its `load`
   * told, which its own runner does. Absent, a frame is a document nothing
   * draws, its inline scripts run in the page's realm (`__frameScript`).
   */
  drawsFrames?: boolean;
}

/** Bytes as lowercase hex, two digits a byte. */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** An error the facade throws by name: `DOMException`'s. */
class DomError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}
const hierarchy = (what: string) => new DomError('HierarchyRequestError', what);

/** The look a frame's document is styled in, which nothing draws here: a
 *  browser's defaults, in its light scheme. */
const FRAME_LOOK: RootLook = {
  color: '#000000',
  fontFamily: 'serif',
  fontSize: 16,
  monoFamily: 'monospace',
  linkColor: '#0000ee',
  borderColor: '#000000',
  mutedColor: '#808080',
  background: '#ffffff',
  colorScheme: 'light',
  surface: '#ffffff',
  controlPadY: 1,
  controlBorder: 2,
  controlRadius: 0,
};

/** A frame's viewport where it says nothing of its own: HTML's 300 by 150. */
const FRAME_SIZE = { width: 300, height: 150 };

/** The elements that hold a document of their own: a frame's. */
const FRAME_TAGS = new Set(['iframe', 'frame', 'object']);

/** The elements a window is reached by the `name` of, as well as by their
 *  `id` (HTML 7.2.2.3): those four, and a frame, whose name is its child
 *  navigable's target name. */
const NAMED_BY_NAME = new Set([
  'embed',
  'form',
  'img',
  'object',
  'iframe',
  'frame',
]);

/** Bumped at every change a script makes to any tree's children, or to
 *  an `id` or a `name` (`_tell`), with `treeGeneration` for what the
 *  parser writes: a window's names hold while neither moves (`_namesOf`).
 *  One count for every host, since a frame's realm can change its
 *  parent's tree. */
let edits = 0;

/** The document an XML parser that met a fatal error makes: Gecko's. */
function parserError(): Element {
  const error = new Element('parsererror', {
    xmlns: 'http://www.mozilla.org/newlayout/xml/parsererror.xml',
  });
  error.namespace = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';
  DomUtils.appendChild(error, new Text('XML Parsing Error: not well-formed'));
  return error;
}

/** The content types a frame reads as XML (XML Media Types, 3). */
const XML_TYPES = /^(?:text\/xml|application\/xml|[\w.+-]+\/[\w.-]+\+xml)$/;
/** A script element's types that are JavaScript, the empty one among them
 *  (HTML 4.12.1). */
const JS_TYPES =
  /^(?:|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|application\/x-javascript|text\/jscript)$/i;
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** Whether an HTML document has a script that runs: a classic one or a
 *  module, inline or not. */
function hasScripts(doc: Document): boolean {
  return !!DomUtils.findOne(
    (el) =>
      el.name === 'script' &&
      !el.namespace &&
      (JS_TYPES.test((el.attribs.type ?? '').trim()) ||
        (el.attribs.type ?? '').trim().toLowerCase() === 'module'),
    doc.children,
  );
}

/** What `_xmlTree` reads of htmlparser2's parser beyond its typed surface:
 *  the names open, top first, and a tag's name. */
interface XmlParserInternals {
  readonly stack: string[];
  getSlice(start: number, end: number): string;
}

/** The elements HTML's parser keeps in the head while no body content has
 *  come (HTML 13.2.6.4.4). */
const HEAD_CONTENT = new Set([
  'base',
  'basefont',
  'bgsound',
  'link',
  'meta',
  'noframes',
  'noscript',
  'script',
  'style',
  'template',
  'title',
]);

/**
 * A document's top as HTML's parser makes it (HTML 13.2.6.4.1–7): its
 * doctype and the comments before it, then an `<html>` holding a head and
 * a body, what goes in each sorted as the parser sorts it — where markup
 * left any of them out, as `document.write`'s and a frame's often do, and
 * as `<Html>`'s parser leaves a fragment. Acid3's test 71 writes a title, a
 * span and a script, and counts what the document came to.
 */
function documentTree(kids: ChildNode[]): ChildNode[] {
  const out: ChildNode[] = [];
  let html: Element | null = null;
  const content: ChildNode[] = [];
  for (const kid of kids) {
    if (kid instanceof Element && kid.name === 'html' && !html) {
      html = kid;
      content.push(...kid.children);
      for (const inner of kid.children.slice()) DomUtils.removeElement(inner);
    } else if (
      !html &&
      !content.length &&
      (isDoctype(kid) || kid instanceof Comment)
    ) {
      out.push(kid);
    } else if (
      kid instanceof Text &&
      !/[^ \t\n\f\r]/.test(kid.data) &&
      !content.length
    ) {
      // white space before the document's content is no part of it
    } else content.push(kid);
  }
  html ??= new Element('html', {}, []);
  let head: Element | null = null;
  let body: Element | null = null;
  const headOf = (): Element => {
    if (!head) {
      head = new Element('head', {}, []);
      DomUtils.appendChild(html!, head);
    }
    return head;
  };
  for (const node of content) {
    if (node instanceof Element && node.name === 'head' && !head && !body) {
      head = node;
      DomUtils.appendChild(html, node);
    } else if (
      node instanceof Element &&
      (node.name === 'body' || node.name === 'frameset')
    ) {
      if (!body) {
        headOf();
        body = node;
        DomUtils.appendChild(html, node);
      } else {
        for (const key in node.attribs) body.attribs[key] ??= node.attribs[key];
        for (const inner of node.children.slice()) {
          DomUtils.appendChild(body, inner);
        }
      }
    } else if (
      !body &&
      ((node instanceof Element && HEAD_CONTENT.has(node.name)) ||
        node instanceof Comment ||
        (node instanceof Text && !/[^ \t\n\f\r]/.test(node.data)))
    ) {
      DomUtils.appendChild(headOf(), node);
    } else {
      if (!body) {
        headOf();
        body = new Element('body', {}, []);
        DomUtils.appendChild(html, body);
      }
      DomUtils.appendChild(body, node);
    }
  }
  headOf();
  if (!body) DomUtils.appendChild(html, new Element('body', {}, []));
  out.push(html);
  return out;
}

/** Text as it goes in markup, and an attribute's value. */
const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escapeAttribute = (text: string): string =>
  escapeText(text).replace(/"/g, '&quot;');

/** A request CORS refused, which the page sees as a failed fetch and the
 *  console tells why. */
class CorsError extends Error {}

/** A response's body, where it arrives a chunk at a time, let go unread: a
 *  `no-cors` answer's, one CORS refused, one the page no longer wants. */
function release(response: FetchResponse): void {
  void response.chunks?.[Symbol.asyncIterator]().return?.();
}

/** Bytes as base64, which is how they cross to the page. */
function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}

/** The methods a request may have and be a simple one (Fetch 2.2.1). */
const SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST']);

/** The response headers a page may read of another origin's answer
 *  without its say (Fetch 2.2.2, "CORS-safelisted response-header name"). */
const SAFELISTED_RESPONSE = new Set([
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'expires',
  'last-modified',
  'pragma',
]);

/**
 * A request header a page may not set (Fetch 2.2.2, "forbidden request-
 * header"): the browser's own to set, or none at all. And `User-Agent`,
 * which Fetch took off that list and Chrome still drops: a page that sets
 * one sends Chrome's, and its preflight names no `user-agent`. The AI SDK
 * sets one on its requests, and api.ekazinich.com, which allows only
 * `Content-Type` and `Authorization`, refused the preflight that named it.
 */
function forbiddenRequestHeader(name: string): boolean {
  const n = name.toLowerCase();
  return (
    /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|user-agent|via)$/.test(
      n,
    ) || /^(proxy-|sec-)/.test(n)
  );
}

/** A response's headers less what no page reads, its cookies. */
function readable(headers: [string, string][]): [string, string][] {
  return headers.filter(([k]) => !/^set-cookie2?$/i.test(k));
}

/** The bytes no CORS-safelisted header value may hold (Fetch 2.2.2). */
const UNSAFE_BYTES = /[\u0000-\u0008\u000a-\u001f"():<>?@[\\\]{}\u007f]/;

/** Whether a request header is one a simple request may have (Fetch
 *  2.2.2, "CORS-safelisted request-header"). */
function corsSafelisted(name: string, value: string): boolean {
  if (value.length > 128) return false;
  switch (name.toLowerCase()) {
    case 'accept':
      return !UNSAFE_BYTES.test(value);
    case 'accept-language':
    case 'content-language':
      return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
    case 'content-type': {
      if (UNSAFE_BYTES.test(value)) return false;
      const essence = value.split(';')[0].trim().toLowerCase();
      return (
        essence === 'application/x-www-form-urlencoded' ||
        essence === 'multipart/form-data' ||
        essence === 'text/plain'
      );
    }
    case 'range': {
      // a simple range, one whose start is no later than its end
      const range = /^bytes=(\d+)-(\d*)$/.exec(value);
      return (
        !!range && (range[2] === '' || BigInt(range[1]) <= BigInt(range[2]))
      );
    }
    default:
      return false;
  }
}

/** Whether a `no-cors` request may have a header (Fetch 2.2.2). */
function noCorsSafelisted(name: string, value: string): boolean {
  return (
    /^(accept|accept-language|content-language|content-type)$/i.test(name) &&
    corsSafelisted(name, value)
  );
}

/** The names of a request's headers that make it no simple one, as the
 *  preflight names them: lower case, sorted, once each. */
function unsafeRequestHeaders(headers: [string, string][]): string[] {
  const names = new Set<string>();
  let safelisted = 0;
  for (const [name, value] of headers) {
    if (corsSafelisted(name, value)) safelisted += value.length;
    else names.add(name.toLowerCase());
  }
  // past 1024 bytes of them, every safelisted one is unsafe as well
  if (safelisted > 1024) {
    for (const [name] of headers) names.add(name.toLowerCase());
  }
  return [...names].sort();
}

/** A header's value, its last where there are several. */
function headerOf(headers: [string, string][], name: string): string | null {
  let value: string | null = null;
  for (const [k, v] of headers) if (k.toLowerCase() === name) value = v;
  return value;
}

/** A comma-separated list of tokens, lower-cased unless `fold` is false. */
function listOf(value: string | null, fold = true): Set<string> {
  const out = new Set<string>();
  for (const part of (value ?? '').split(',')) {
    const token = part.trim();
    if (token) out.add(fold ? token.toLowerCase() : token);
  }
  return out;
}

/** The CORS check (Fetch 4.10): whether an answer lets `page` read it.
 *  Throws why it does not. */
function corsCheck(
  headers: [string, string][],
  credentials: string,
  page: string,
): void {
  const allow = headerOf(headers, 'access-control-allow-origin');
  if (allow === null) {
    throw new CorsError(
      "No 'Access-Control-Allow-Origin' header is present on the requested resource.",
    );
  }
  if (allow.includes(',')) {
    throw new CorsError(
      `The 'Access-Control-Allow-Origin' header contains multiple values '${allow}', but only one is allowed.`,
    );
  }
  const include = credentials === 'include';
  if (allow === '*' && !include) return;
  if (allow === '*') {
    throw new CorsError(
      "The value of the 'Access-Control-Allow-Origin' header in the response must not be the wildcard '*' when the request's credentials mode is 'include'.",
    );
  }
  if (allow !== page) {
    throw new CorsError(
      `The 'Access-Control-Allow-Origin' header has a value '${allow}' that is not equal to the supplied origin.`,
    );
  }
  if (include) {
    const credentialed = headerOf(headers, 'access-control-allow-credentials');
    if (credentialed !== 'true') {
      throw new CorsError(
        `The value of the 'Access-Control-Allow-Credentials' header in the response is '${credentialed ?? ''}' which must be 'true' when the request's credentials mode is 'include'.`,
      );
    }
  }
}

/** A declaration block as CSSOM serializes one (6.7.2), which is what a
 *  browser writes into a `style` attribute it changes: each declaration
 *  ended with a `;`, so that text appended to it is a declaration of its
 *  own. */
function serializeDeclarations(
  declarations: readonly { prop: string; value: string; important: boolean }[],
): string {
  return declarations
    .map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''};`)
    .join(' ');
}

/** A node's shadow-including root (DOM 4.2.2): the root of its tree, and
 *  of its shadow host's tree where that is a shadow root. */
function shadowIncludingRoot(node: AnyNode): AnyNode {
  let at = node;
  for (;;) {
    while (at.parent) at = at.parent;
    if (!(at instanceof ShadowRoot)) return at;
    at = at.host;
  }
}

/** A URL's origin, or '' where it is none. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** The elements whose content HTML's parser reads as text, whatever it
 *  holds (HTML 13.4, the fragment case): `<noscript>` among them where
 *  scripts run, as they do in a document this host serves. */
const RAW_TEXT = new Set([
  'script',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
]);

/**
 * A sheet's text as CSSOM's list of rules, each its text (CSS Syntax 3,
 * "consume a list of rules", as far as where each ends): at the `}` that
 * closes a block at the top level, or the `;` that ends an at-rule with
 * none, past comments, strings and escapes. A rule is trimmed and the
 * comments before it left out; `<!--` and `-->` are not rules, and
 * neither is what a `;` ends that is no at-rule, which CSS drops.
 */
export function cssRulesOf(css: string): string[] {
  const out: string[] = [];
  const n = css.length;
  let depth = 0;
  let start = 0;
  const end = (at: number, statement: boolean): void => {
    const rule = css.slice(start, at).trim();
    start = at;
    if (!rule || rule === '<!--' || rule === '-->') return;
    if (statement && !rule.startsWith('@')) return;
    out.push(rule);
  };
  for (let i = 0; i < n; i++) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const after = close < 0 ? n : close + 2;
      // a comment before a rule is not the rule's
      if (!css.slice(start, i).trim()) start = after;
      i = after - 1;
    } else if (ch === '"' || ch === "'") {
      for (i += 1; i < n && css[i] !== ch && css[i] !== '\n'; i++) {
        if (css[i] === '\\') i += 1;
      }
    } else if (ch === '\\') {
      i += 1;
    } else if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ')' || ch === ']') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && ch === '}') end(i + 1, false);
    } else if (ch === ';' && depth === 0) {
      end(i + 1, true);
    }
  }
  // an unclosed block is closed where the text ends
  end(n, false);
  return out;
}

/** A `<style>`'s rules as CSSOM has them (`sheetRules`), and which edit of
 *  them this is, so the page asks for them again only when they change. */
interface SheetState {
  rules: string[];
  version: number;
}

/** The page's storage: memory, by origin, for as long as the process. */
const STORAGE = {
  local: new Map<string, Map<string, string>>(),
  session: new Map<string, Map<string, string>>(),
};

/** A change as an observer is handed it (DOM 4.3.4), by node. */
interface Mutation {
  type: 'attributes' | 'childList' | 'characterData';
  target: AnyNode;
  added: readonly AnyNode[];
  removed: readonly AnyNode[];
  previous: AnyNode | null;
  next: AnyNode | null;
  attributeName: string | null;
  oldValue: string | null;
}

/** What `observe()` asked to see (DOM 4.3.1), its defaults filled in. */
interface ObserveOptions {
  childList: boolean;
  attributes: boolean;
  characterData: boolean;
  subtree: boolean;
  attributeOldValue: boolean;
  characterDataOldValue: boolean;
  attributeFilter: string[] | null;
}

/** A page's `MutationObserver`, as the host keeps it. */
interface Observer {
  on: Map<AnyNode, ObserveOptions>;
  queue: Mutation[];
}

/** How many changes a task may make before `<Html>` is told to restyle
 *  everything rather than what they reach. */
const CHANGES_TOLD = 4000;

/** What an entry into the page answers: the engine's `call`. */
export interface Entries {
  call(entry: string, input: unknown): Primitive;
  /** Whether an entry has timed out since last asked (`ScriptEngine`): the
   *  host repairs the tree then, as termination can leave it half-moved. */
  timedOutSince?(): boolean;
  /** A worker's imported script, run in the page from inside its call
   *  (`ScriptEngine.runNested`): whether it ran, or threw what is now at
   *  `__thrown`. */
  runNested?(code: string, url: string): 'ran' | 'threw' | null;
}

/**
 * What the hosts of one page's documents share: the page's and each of its
 * frames', a realm and a host each (`ScriptRunner`), over one tree of
 * nodes. Everything kept by a node is here — a frame's script and the
 * page's reach the same nodes, the page through `contentDocument` — and
 * so are the changes waiting to be told, by document, since what one
 * realm changes may be drawn by another's `<Html>`. What is a realm's own
 * — its ids, its timers, its observers, its address — stays its host's.
 */
export class DomShared {
  readonly inert = new WeakSet<Element>();
  readonly frames = new WeakMap<Element, Document>();
  readonly frameOf = new WeakMap<Document, Element>();
  readonly frameStyles = new WeakMap<
    Document,
    { key: string; cascade: Cascade }
  >();
  readonly checkedDefaults = new WeakMap<Element, string | null>();
  readonly frameLoads = new WeakMap<Element, number>();
  readonly frameAt = new WeakMap<Element, string>();
  readonly frameSent = new WeakMap<Element, string | null>();
  readonly written = new WeakMap<Element, ChildNode>();
  readonly sheets = new WeakMap<Element, SheetState>();
  readonly sheetsChanged = new Set<Element>();
  sheetVersion = 0;
  readonly documents = new WeakSet<Document>();
  readonly xml = new WeakMap<Document, string>();
  readonly owners = new WeakMap<AnyNode, Document>();
  readonly doctypes = new WeakMap<AnyNode, [string, string, string]>();
  /** Changes made to documents nothing draws, counted (`_frameStyle`). */
  foreignChanges = 0;
  /** The `<Html>` each frame's document is drawn by, where one is: what a
   *  change to it is told to, whichever realm made it. */
  readonly drawn = new WeakMap<Document, HtmlHandle>();
  /** The changes made to each drawn frame's document since its `<Html>`
   *  was last told. */
  readonly changes = new Map<Document, HtmlChange[]>();
  /** The frames that have a document, which a browser that draws frames
   *  mounts one for each of (`frames`), and who is told as that changes. */
  readonly frameList = new Set<Element>();
  readonly frameListeners = new Set<() => void>();
  /** The frames' documents that run in a realm of their own: those loaded
   *  as HTML, with a script in them, where the browser draws frames. A
   *  frame's first `about:blank`, what a script writes into one and a
   *  document with no script are the page realm's, since a page reaches
   *  into them at once, before a realm could be made. */
  readonly realms = new WeakSet<Document>();

  /** Each `<canvas>`'s pixels, whichever realm's script drew them, and who
   *  is told as they change. */
  readonly canvases = new WeakMap<Element, CanvasPixels>();
  readonly canvasListeners = new Set<(canvas: Element) => void>();

  /** The frames' documents changed: one came, or went on to another. */
  framesChanged(): void {
    for (const listener of [...this.frameListeners]) listener();
  }
}

export class DomHost {
  private _ids = new WeakMap<AnyNode, number>();
  private _nodes = new Map<number, AnyNode>();
  private _next = 2;
  private _timers = new Map<number, ReturnType<typeof setTimeout>>();
  private _fetches = new Map<number, InstanceType<AbortControllerClass>>();
  /** The bodies being handed to the page a chunk at a time (`_pump`). */
  private _bodies = new Map<number, AsyncIterator<Uint8Array>>();
  private _contents = new Map<number, number>();
  /** The changes since `<Html>` was last told, as `refresh` takes them. */
  private _changes: HtmlChange[] = [];
  /** The page's `MutationObserver`s, by id in the order they were made: the
   *  nodes each watches and how, and the records queued for it. */
  private _observers = new Map<number, Observer>();
  /** The names the page's custom elements were defined under, and what has
   *  happened since the facade last asked to the elements that may be
   *  theirs (`_custom…`): null until the first definition, so a page that
   *  makes none pays nothing for it. */
  private _custom: { names: Set<string>; log: Primitive[][] } | null = null;
  /** The `<template>`s' contents (`content`), whose node document is an
   *  inert one in a browser: nothing in them is a custom element, and a
   *  copy of them none either, until it is put in the document. */
  private _templateContents = new WeakSet<AnyNode>();
  /** The address the document is at, which `history.pushState` moves. */
  url: string;
  /** Scripts that are never run: what `innerHTML` and
   *  `insertAdjacentHTML` put in, which HTML does not run either. */
  readonly inert: WeakSet<Element>;
  /** A frame's document — an `<iframe>`'s, an `<object>`'s — and the frame
   *  each document is, and the cascade its styles were last worked out
   *  with, by its sheets' texts (`_frameStyle`). */
  private readonly _frames: WeakMap<Element, Document>;
  private readonly _frameOf: WeakMap<Document, Element>;
  private readonly _frameStyles: WeakMap<
    Document,
    { key: string; cascade: Cascade }
  >;
  /** The script the parser met that is running, whose `document.write`
   *  goes in after it (`write`), and the last node each wrote. */
  writing: Element | null = null;
  /** The boxes whose checkedness a script set (HTML's "dirty checkedness"),
   *  each with the `checked` attribute the page has given it since: its
   *  default, which is what a reset puts back and what the page reads as
   *  the attribute, where `<Html>` keeps the box's state in the attribute
   *  itself. Acid3's test 43 sets the attribute of a radio a click checked
   *  and a script unchecked, and looks to see it stay unchecked. */
  private readonly _checkedDefaults: WeakMap<Element, string | null>;
  /** Each frame's navigations, counted: a load answers only the last. */
  private readonly _frameLoads: WeakMap<Element, number>;
  /** Where each frame's document is from, which its window's `location`
   *  reads and whose origin says whether the page may read the document:
   *  `about:blank` until a load is in, and another origin's address at
   *  once, since nothing of one is loaded (`_frameDocument`). */
  private readonly _frameAt: WeakMap<Element, string>;
  /** Where a frame's window was sent (`location.replace`, `href = …`),
   *  which its `src` does not say, until its `src` changes: null for
   *  `about:blank`. */
  private readonly _frameSent: WeakMap<Element, string | null>;
  private readonly _written: WeakMap<Element, ChildNode>;
  /** The rules of each `<style>` a page asked the sheet of, and those a
   *  page changed since the last `flush` (`_writeSheets`). */
  private readonly _sheets: WeakMap<Element, SheetState>;
  private readonly _sheetsChanged: Set<Element>;
  /** A change no list says the reach of — a shadow tree attached — so
   *  the next flush refreshes the whole document. */
  private _refreshAll = false;
  /** The documents a page made of its own (`_documentOf`), which are
   *  documents and not fragments, though the tree has one kind of root. */
  private readonly _documents: WeakSet<Document>;
  /** The XML documents a page made (`createDocument`), by their content
   *  type: an element's name keeps its case in one. */
  private readonly _xml: WeakMap<Document, string>;
  /** A node's document where its tree does not say (DOM 4.4, "node
   *  document"): one a page made in another document, or took out of one.
   *  A node in a tree is its root's, where the root is a document; the
   *  entry nearest it up the tree says otherwise. */
  private readonly _owners: WeakMap<AnyNode, Document>;
  /** A doctype's name and its two ids. */
  private readonly _doctypes: WeakMap<AnyNode, [string, string, string]>;
  /** The live ranges (`ranges.ts`), which every change below moves. */
  private _ranges = new Ranges({
    error: (kind, message) => new DomError(kind, message),
    insert: (parent, node, before) => this._insert(parent, node, before),
    check: (parent, node, before) =>
      this._validInsert(parent, node, before, false),
    remove: (node) => this._take(node),
    replaceData: (node, offset, count, data) =>
      this._replaceData(node, offset, count, data),
    split: (node, offset) => this._splitText(node, offset),
    clone: (node, deep) => this._clone(node, deep),
    fragment: (node) => {
      const fragment = new Document([]);
      this._owners.set(fragment, this._ownerOf(node));
      return fragment;
    },
    isFragment: (node) => this._isFragment(node),
    isDocument: (node) => this._isDocument(node),
  });
  /** The page's node iterators, which a removal moves as it moves the
   *  ranges. */
  private _iterators = new NodeIterators();
  /** Changes made to a page's own documents, counted, and the count a
   *  frame's styles were last worked out at: a selector's kept answers
   *  are good only while its tree holds still (`_frameStyle`). */
  private _foreignSeen = -1;
  /** Where timers and fetches call back into the page. */
  entries: Entries | null = null;
  /** Where this page's workers run, where it may start them. */
  workers: PageWorkersLike | null = null;
  /** The page this realm is the worker of, where it is one. */
  workerScope: WorkerScope | null = null;
  private _disposed = false;
  /** An element the page focused that could not take the focus yet, which
   *  is asked again a frame on (`focus`). */
  private _focusing: Element | null = null;

  /** What every realm's host over one page's documents shares
   *  (`DomShared`). */
  private readonly _s: DomShared;

  constructor(
    readonly document: Document,
    private readonly _seams: HostSeams,
    url: string,
    shared: DomShared = new DomShared(),
  ) {
    this.url = url;
    this._ids.set(document, 1);
    this._nodes.set(1, document);
    this._s = shared;
    this.inert = shared.inert;
    this._frames = shared.frames;
    this._frameOf = shared.frameOf;
    this._frameStyles = shared.frameStyles;
    this._checkedDefaults = shared.checkedDefaults;
    this._frameLoads = shared.frameLoads;
    this._frameAt = shared.frameAt;
    this._frameSent = shared.frameSent;
    this._written = shared.written;
    this._sheets = shared.sheets;
    this._sheetsChanged = shared.sheetsChanged;
    this._documents = shared.documents;
    this._xml = shared.xml;
    this._owners = shared.owners;
    this._doctypes = shared.doctypes;
    shared.drawn.set(document, _seams.handle);
  }

  /** The bridge the facade is handed: never throws, never answers an
   *  object. */
  readonly bridge: Bridge = (op, a, b, c, d) => {
    try {
      const out = this._op(op, a, b, c, d);
      // Only a primitive crosses. An object is the obvious leak and was
      // always nulled; a function is not `typeof 'object'`, so the old
      // guard let one through, and a host function in a page's hands is an
      // escape (`e.constructor.constructor('return process')()`). No op
      // returns one today — this keeps it that way.
      const kind = typeof out;
      return out === null ||
        kind === 'string' ||
        kind === 'number' ||
        kind === 'boolean' ||
        kind === 'undefined'
        ? out
        : null;
    } catch (error) {
      const kind = error instanceof DomError ? error.kind : 'Error';
      const message = String((error as Error)?.message ?? error);
      return `\u0001${kind}\u0001${message}`;
    }
  };

  /** A node's id, made the first time it is asked for. */
  idOf(node: AnyNode | null | undefined): number {
    if (!node) return 0;
    let id = this._ids.get(node);
    if (id === undefined) {
      id = this._next++;
      this._ids.set(node, id);
      this._nodes.set(id, node);
    }
    return id;
  }

  /** Hand the tree's changes to `<Html>`: a restyle, a layout and a paint
   *  of the document as the page left it. */
  flush(): void {
    // A timed-out entry may have been terminated inside a tree-moving op,
    // between the parent's `children` update and the siblings' `prev`/`next`
    // — which `nextSibling`/`previousSibling` read straight off the node.
    // Rebuild the links from the children arrays, the op's first write, so
    // the tree is whole before it is drawn or read again. Only on a
    // timeout, which is rare, so the walk costs nothing in the common case.
    if (this.entries?.timedOutSince?.()) this._repairTree();
    if (this._sheetsChanged.size) this._writeSheets();
    this._syncHighlights();
    if (this._s.changes.size && !this._disposed) {
      // what this realm, or another, changed in another realm's document
      const pending = [...this._s.changes];
      this._s.changes.clear();
      for (const [doc, changes] of pending) {
        this._s.drawn
          .get(doc)
          ?.refresh(changes.length > CHANGES_TOLD ? undefined : changes);
      }
    }
    if (this._refreshAll && !this._disposed) {
      // a shadow tree came: every element is styled again
      this._refreshAll = false;
      this._changes = [];
      this._seams.handle.refresh();
      return;
    }
    if (!this._changes.length || this._disposed) return;
    const changes = this._changes;
    this._changes = [];
    // past a few thousand, working out what they reach costs what styling
    // everything does
    this._seams.handle.refresh(
      changes.length > CHANGES_TOLD ? undefined : changes,
    );
  }

  /** Make the tree whole again from the `children` arrays — the first
   *  write of a mutation op, and the source of truth — for this host's
   *  document and any shadow trees in it. Run after a timeout (`flush`),
   *  where termination may have left a node's `prev`/`next` out of step
   *  with its parent's children, or — a half-finished move — a node in two
   *  parents' children at once. A node is kept under the first parent the
   *  walk reaches it through, in document order, and dropped from any
   *  other, so the result is a tree: every node has one parent, and a
   *  cycle a corrupt move might have made cannot loop the walk. One tree,
   *  so the walk is the document's size, and only on a rare timeout. */
  private _repairTree(): void {
    this._relink(this.document, new Set());
  }

  private _relink(node: AnyNode, seen: Set<AnyNode>): void {
    const kids = (node as { children?: AnyNode[] }).children;
    if (!kids) return;
    // drop any child already reached under another parent (or earlier in
    // this same array): a tree holds each node once
    let cleaned: AnyNode[] | null = null;
    for (let i = 0; i < kids.length; i += 1) {
      if (seen.has(kids[i])) {
        cleaned ??= kids.slice(0, i);
        continue;
      }
      seen.add(kids[i]);
      cleaned?.push(kids[i]);
    }
    const list = cleaned ?? kids;
    if (cleaned) (node as { children: AnyNode[] }).children = cleaned;
    for (let i = 0; i < list.length; i += 1) {
      const kid = list[i] as {
        parent: AnyNode | null;
        prev: AnyNode | null;
        next: AnyNode | null;
      };
      kid.parent = node;
      kid.prev = list[i - 1] ?? null;
      kid.next = list[i + 1] ?? null;
      // a shadow tree hangs off its host, not off `children`
      if (list[i] instanceof Element) {
        const root = shadowRootOf(list[i] as Element);
        if (root) this._relink(root, seen);
      }
      this._relink(list[i], seen);
    }
  }

  /** An event `<Html>` told of, dispatched in the page; whether its default
   *  goes on. */
  dispatch(event: HtmlDomEvent): boolean {
    const answer = this.entries?.call('__event', {
      type: event.type,
      target: this.idOf(event.target),
      x: event.x,
      y: event.y,
      button: event.button,
      buttons: event.buttons,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      detail: event.detail,
      key: event.key,
      code: event.code,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      submitter: event.submitter ? this.idOf(event.submitter) : 0,
      relatedTarget: event.relatedTarget ? this.idOf(event.relatedTarget) : 0,
    });
    return answer !== false;
  }

  /** What the realms of this page share, for a frame's host to be made
   *  over (`ScriptRunner`'s frames). */
  get shared(): DomShared {
    return this._s;
  }

  /**
   * The frames in this realm's document that have an HTML document of their
   * own to show, each with it, its address and whether it runs in a realm
   * of its own (`DomShared.realms`): what a browser that draws frames mounts
   * a frame for (`drawsFrames`), another origin's among them, which runs
   * at its own origin; an XML one, which `<Html>` does not draw, is left
   * out.
   */
  frames(): FrameShown[] {
    const out: FrameShown[] = [];
    for (const frame of this._s.frameList) {
      if (!this._inDocument(frame)) continue;
      const document = this._frames.get(frame);
      const url = this._frameAt.get(frame) ?? 'about:blank';
      if (!document || this._xml.has(document)) continue;
      out.push({ frame, document, url, realm: this._s.realms.has(document) });
    }
    return out;
  }

  /** Load the frames the document has, as a browser loads a frame as the
   *  parser meets it: those its markup has, where the browser draws frames
   *  and nothing has asked for them yet. */
  loadFrames(): void {
    if (this._disposed) return;
    this._framesIn(this.document.children);
  }

  /** A `<canvas>`'s pixels, where a script drew any. */
  canvas(element: Element): CanvasPixels | null {
    return this._s.canvases.get(element) ?? null;
  }

  /** Be told when a canvas's pixels change; answers the way to stop. */
  onCanvas(listener: (canvas: Element) => void): () => void {
    this._s.canvasListeners.add(listener);
    return () => this._s.canvasListeners.delete(listener);
  }

  /** Be told when a frame's document comes or goes; answers the way to
   *  stop. */
  onFrames(listener: () => void): () => void {
    this._s.frameListeners.add(listener);
    return () => this._s.frameListeners.delete(listener);
  }

  /** A frame's document has come to the end of its load in its own realm
   *  (`drawsFrames`): the frame's `load`, in this one. */
  frameLoaded(frame: Element): void {
    if (this._disposed || !this.entries) return;
    this.entries.call('__fire', [this.idOf(frame), 'load']);
    this._frameDone(frame);
  }

  /** The frames whose document is on its way, which hold the page's own
   *  `load` until theirs (HTML 7.4.5, "delay the load event"). */
  private _framesLoading = new Set<Element>();
  /** Told once no frame in the document is loading. */
  onFramesLoaded: (() => void) | null = null;
  /** Whether a frame in the document is still loading its document. */
  get framesLoading(): boolean {
    for (const frame of this._framesLoading) {
      if (!this._inDocument(frame)) this._framesLoading.delete(frame);
    }
    return this._framesLoading.size > 0;
  }
  private _frameDone(frame: Element): void {
    if (!this._framesLoading.delete(frame)) return;
    if (!this.framesLoading) this.onFramesLoaded?.();
  }

  /** Scroll containers in the document scrolled: each one's `scroll`,
   *  which does not bubble (CSSOM View, "run the scroll steps"). */
  elementsScrolled(elements: Iterable<Element>): void {
    if (this._disposed || !this.entries) return;
    for (const el of elements) {
      this.entries.call('__fire', [this.idOf(el), 'scroll']);
    }
  }

  dispose(): void {
    this._disposed = true;
    if (this._s.drawn.get(this.document) === this._seams.handle) {
      this._s.drawn.delete(this.document);
    }
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    for (const fetch of this._fetches.values()) fetch.abort();
    this._fetches.clear();
    for (const body of this._bodies.values()) void body.return?.();
    this._bodies.clear();
    this._observers.clear();
    this.entries = null;
  }

  private _node(id: Primitive): AnyNode {
    const node = typeof id === 'number' ? this._nodes.get(id) : undefined;
    if (!node) throw new DomError('NotFoundError', 'No such node.');
    return node;
  }
  private _element(id: Primitive): Element {
    const node = this._node(id);
    if (!(node instanceof Element)) {
      throw new DomError('InvalidNodeTypeError', 'Not an element.');
    }
    return node;
  }
  private _parent(id: Primitive): ParentNode {
    const node = this._node(id);
    if (!(node instanceof Element || node instanceof Document)) {
      throw hierarchy('This node has no children.');
    }
    return node;
  }
  /** A fragment: a `Document` node that is not the document. */
  private _isFragment(node: AnyNode): boolean {
    return (
      node instanceof Document &&
      node !== this.document &&
      !this._documents.has(node)
    );
  }
  /** A document: the drawn one, or one a page made. */
  private _isDocument(node: AnyNode): boolean {
    return node === this.document || this._documents.has(node as Document);
  }

  /** The document a node is in (DOM 4.4, "node document"). */
  private _ownerOf(node: AnyNode): Document {
    for (let at: AnyNode | null = node; at; at = at.parent) {
      if (this._isDocument(at)) return at as Document;
      const owner = this._owners.get(at);
      if (owner) return owner;
    }
    return this.document;
  }

  /** A node, and all it holds, made `doc`'s (DOM 4.5, "adopt"). */
  private _adopt(node: AnyNode, doc: Document): void {
    if (this._custom) {
      const old = this._ownerOf(node);
      if (old !== doc) {
        this._customLog('a', node, [this.idOf(old), this.idOf(doc)]);
      }
    }
    const forget = (at: AnyNode): void => {
      for (const kid of (at as ParentNode).children ?? []) {
        this._owners.delete(kid);
        forget(kid);
      }
    };
    forget(node);
    if (doc === this.document && !node.parent) this._owners.delete(node);
    else this._owners.set(node, doc);
  }

  /** A copy of a node, its document's (DOM 4.5, "clone"). */
  private _clone(node: AnyNode, deep: boolean): ChildNode {
    const clone = node.cloneNode(deep) as ChildNode;
    const owner = this._ownerOf(node);
    if (owner !== this.document) this._owners.set(clone, owner);
    if (isDoctype(node)) this._doctypes.set(clone, this._doctypeOf(node));
    const type = this._xml.get(node as Document);
    if (this._isDocument(node)) {
      this._documents.add(clone as unknown as Document);
      if (type) this._xml.set(clone as unknown as Document, type);
    }
    return clone;
  }

  /** A dirty box's `checked` attribute set or taken away: its default
   *  changed, its state not, and the page's observers told. */
  private _defaultChecked(el: Element, value: string | null): void {
    const oldValue = this._checkedDefaults.get(el) ?? null;
    this._checkedDefaults.set(el, value);
    if (this._observers.size) {
      this._queue(el, {
        type: 'attributes',
        target: el,
        added: [],
        removed: [],
        previous: null,
        next: null,
        attributeName: 'checked',
        oldValue,
      });
    }
  }

  /** A doctype's name, public id and system id: those it was made with,
   *  or what the markup it was parsed from says. */
  private _doctypeOf(node: AnyNode): [string, string, string] {
    const kept = this._doctypes.get(node);
    if (kept) return kept;
    const data = (node as ProcessingInstruction).data ?? '';
    const m =
      /^!doctype\s+([^\s>]+)(?:\s+public\s+(?:"([^"]*)"|'([^']*)'))?(?:\s+(?:system\s+)?(?:"([^"]*)"|'([^']*)'))?/i.exec(
        data,
      );
    const out: [string, string, string] = m
      ? [m[1].toLowerCase(), m[2] ?? m[3] ?? '', m[4] ?? m[5] ?? '']
      : ['html', '', ''];
    this._doctypes.set(node, out);
    return out;
  }

  /** A node's data, from `offset`, `count` code units of it replaced by
   *  `data` (DOM 4.10, "replace data"), the ranges in it moved. */
  private _replaceData(
    node: CharacterData,
    offset: number,
    count: number,
    data: string,
  ): void {
    const length = node.data.length;
    if (!(offset >= 0 && offset <= length)) {
      throw new DomError(
        'IndexSizeError',
        `The offset ${offset} is greater than the node's length (${length}).`,
      );
    }
    const taken = Math.max(0, Math.min(count, length - offset));
    const oldValue = node.data;
    node.data =
      oldValue.slice(0, offset) + data + oldValue.slice(offset + taken);
    this._ranges.replacedData(node, offset, taken, data.length);
    this._changed(node, 'characterData', null, oldValue);
  }

  /** A text split at `offset`, its rest a text after it (DOM 4.11). */
  private _splitText(node: Text, offset: number): Text {
    const length = node.data.length;
    if (!(offset >= 0 && offset <= length)) {
      throw new DomError(
        'IndexSizeError',
        `The offset ${offset} is larger than the Text node's length.`,
      );
    }
    const added = new Text(node.data.slice(offset));
    const owner = this._ownerOf(node);
    if (owner !== this.document) this._owners.set(added, owner);
    const parent = node.parent;
    if (parent) {
      this._put(parent, [added], node.next);
      this._ranges.split(node, offset, added);
    }
    this._replaceData(node, offset, length - offset, '');
    return added;
  }

  private _op(
    op: string,
    a: Primitive,
    b: Primitive,
    c: Primitive,
    d: Primitive,
  ): Primitive {
    const text = (v: Primitive): string => (typeof v === 'string' ? v : '');
    switch (op) {
      // --- the tree
      case 'info': {
        const node = this._node(a);
        if (node instanceof Element) {
          // a namespace the element was made in, where it says one: `~`
          // for none
          const ns = node.namespace;
          return ns === undefined
            ? `1|${node.name}`
            : `1|${node.name}\u0000${ns || '~'}`;
        }
        if (node instanceof Text) return '3|#text';
        if (node instanceof ShadowRoot) return '11|#shadow-root';
        if (node instanceof Comment) return '8|#comment';
        if (this._isDocument(node)) {
          const type = this._xml.get(node as Document);
          return type ? `9|#document\u0000${type}` : '9|#document';
        }
        if (node instanceof Document) return '11|#document-fragment';
        if (isDoctype(node)) return `10|${this._doctypeOf(node)[0]}`;
        return '3|#text';
      }
      case 'parent': {
        const node = this._node(a);
        return this._isDocument(node) ? 0 : this.idOf(node.parent);
      }
      // the document a node is in, and none for a document
      case 'owner': {
        const node = this._node(a);
        return this._isDocument(node) ? 0 : this.idOf(this._ownerOf(node));
      }
      case 'doctype':
        return this._doctypeOf(this._node(a)).join('\u0000');
      case 'kids': {
        const node = this._node(a);
        if (!('children' in node)) return '';
        const kids =
          b === 'elements'
            ? node.children.filter((k) => k instanceof Element)
            : node.children;
        return kids.map((k) => this.idOf(k)).join(',');
      }
      case 'first':
      case 'last': {
        const node = this._node(a);
        if (!('children' in node) || !node.children.length) return 0;
        return this.idOf(
          op === 'first' ? node.children[0] : node.children.at(-1),
        );
      }
      case 'next':
      case 'prev': {
        let at: AnyNode | null = this._node(a);
        do {
          at = op === 'next' ? at.next : at.prev;
        } while (at && b === 'element' && !(at instanceof Element));
        return this.idOf(at);
      }
      // whether its shadow-including root is a document (DOM 4.4): a frame's
      // and one a page made are documents as much as the one drawn is
      case 'connected':
        return this._isDocument(shadowIncludingRoot(this._node(a)));
      case 'contains': {
        const outer = this._node(a);
        for (let at: AnyNode | null = this._node(b); at; at = at.parent) {
          if (at === outer) return true;
        }
        return false;
      }
      case 'equal':
        return (
          DomUtils.getOuterHTML(this._node(a)) ===
          DomUtils.getOuterHTML(this._node(b))
        );
      case 'position':
        return this._position(this._node(a), this._node(b));
      case 'text': {
        const node = this._node(a);
        if (node instanceof Text || node instanceof Comment) return node.data;
        if (node === this.document) return null;
        return DomUtils.textContent(node);
      }
      case 'setText': {
        const node = this._node(a);
        if (node instanceof Text || node instanceof Comment) {
          this._replaceData(node, 0, node.data.length, text(b));
          return null;
        }
        const parent = this._parent(a);
        this._replaceAll(parent, text(b) ? [new Text(text(b))] : []);
        return null;
      }
      // a node made in a document — the drawn one where none is named —
      // and an element in a namespace where one is: `~` for none
      case 'create': {
        let node: AnyNode;
        if (a === 'element') {
          const el = new Element(text(b), {}, []);
          if (typeof d === 'string' && d) el.namespace = d === '~' ? '' : d;
          node = el;
        } else if (a === 'text') node = new Text(text(b));
        else if (a === 'comment') node = new Comment(text(b));
        else node = new Document([]);
        const doc = c ? this._node(c) : this.document;
        if (doc !== this.document && this._isDocument(doc)) {
          this._owners.set(node, doc as Document);
        }
        return this.idOf(node);
      }
      case 'createDoctype': {
        const name = text(a);
        const publicId = text(b);
        const systemId = text(c);
        const node = new ProcessingInstruction(
          '!doctype',
          `!DOCTYPE ${name}${publicId ? ` PUBLIC "${publicId}"` : ''}${
            systemId ? `${publicId ? '' : ' SYSTEM'} "${systemId}"` : ''
          }`,
        );
        this._doctypes.set(node, [name, publicId, systemId]);
        const doc = d ? this._node(d) : this.document;
        if (doc !== this.document) this._owners.set(node, doc as Document);
        return this.idOf(node);
      }
      // an XML document, empty: what `createDocument` fills
      case 'newXml': {
        const doc = new Document([]);
        this._documents.add(doc);
        this._xml.set(doc, text(a) || 'application/xml');
        return this.idOf(doc);
      }
      case 'insert':
        this._insert(this._parent(a), this._node(b), c ? this._node(c) : null);
        return null;
      case 'replace':
        this._replace(this._parent(a), this._node(b), this._node(c));
        return null;
      // a node's data changed in place, and a text split in two, as the
      // standard has them move the ranges in them
      case 'replaceData': {
        const node = this._node(a);
        if (!(node instanceof Text || node instanceof Comment)) {
          throw new DomError('InvalidNodeTypeError', 'Not character data.');
        }
        this._replaceData(node, Number(b), Number(c), text(d));
        return null;
      }
      case 'splitText': {
        const node = this._node(a);
        if (!(node instanceof Text)) {
          throw new DomError('InvalidNodeTypeError', 'Not a text.');
        }
        return this.idOf(this._splitText(node, Number(b)));
      }
      // a node taken into another document, out of wherever it was
      // (`adoptNode`), and a copy of one made in it (`importNode`)
      case 'adoptNode': {
        const node = this._node(a);
        if (this._isDocument(node)) {
          throw new DomError(
            'NotSupportedError',
            'A document cannot be adopted.',
          );
        }
        if (node instanceof ShadowRoot) {
          throw hierarchy('A shadow root cannot be adopted.');
        }
        if (node.parent) this._take(node as ChildNode);
        this._adopt(node, this._node(b) as Document);
        return null;
      }
      case 'import': {
        const node = this._node(a);
        if (this._isDocument(node) || node instanceof ShadowRoot) {
          throw new DomError(
            'NotSupportedError',
            'That node cannot be imported.',
          );
        }
        const clone = this._clone(node, !!b);
        this._adopt(clone, this._node(c) as Document);
        if (this._custom) this._customMade(clone);
        return this.idOf(clone);
      }

      // --- node iterators, by id: the facade's runs the filter, and the
      // host keeps where it is, which a removal moves
      case 'iterNew':
        return this._iterators.make(this._node(a));
      case 'iterDrop':
        this._iterators.drop(Number(a));
        return null;
      case 'iterGet': {
        const it = this._iterators.get(Number(a));
        return it
          ? `${this.idOf(it.reference.node)},${it.reference.before}`
          : '';
      }
      case 'iterStep': {
        const it = this._iterators.get(Number(a));
        return it ? this.idOf(this._iterators.step(it, b === true)) : 0;
      }
      case 'iterEnd': {
        // the step the filter took, kept where it was accepted
        const it = this._iterators.get(Number(a));
        if (it && it.candidate && b === true) it.reference = it.candidate;
        if (it) it.candidate = null;
        return null;
      }

      // --- ranges (`ranges.ts`), by id: the facade's `Range` holds one
      case 'rangeNew':
        return this._ranges.make(a ? this._node(a) : this.document);
      case 'rangeDrop':
        this._ranges.drop(Number(a));
        return null;
      case 'rangeClone': {
        const r = this._ranges.get(Number(a));
        return this._ranges.add(new LiveRange(r.sc, r.so, r.ec, r.eo));
      }
      // where the text of a range is drawn: x, y, width and height in the
      // document's CSS pixels a rectangle, flat, or '' where the document
      // draws no text there (`Range.getClientRects`)
      case 'rangeRects': {
        this.flush();
        const r = this._ranges.get(Number(a));
        const rects = this._inDocument(r.sc)
          ? this._seams.handle.textRects?.(r.sc, r.so, r.ec, r.eo)
          : null;
        return rects
          ? rects.map((q) => `${q.x},${q.y},${q.width},${q.height}`).join(',')
          : '';
      }
      // the boundary point nearest a point of the viewport's, in CSS
      // pixels: a node's id and an offset, or '' (`caretPositionFromPoint`)
      case 'textAt': {
        this.flush();
        const v = this._seams.viewport();
        const x = Number(a);
        const y = Number(b);
        if (!(x >= 0 && y >= 0 && x < v.width && y < v.height)) return '';
        const at = this._seams.handle.textPointAt?.(
          v.left + x * v.zoom,
          v.top + y * v.zoom,
        );
        return at ? `${this.idOf(at.node)},${at.offset}` : '';
      }
      // the page's custom highlights (`CSS.highlights`), as JSON: each one's
      // name, priority and ranges — a live range by its id, a static one by
      // its two points — drawn at the next flush
      case 'highlights':
        this._highlightSpec = JSON.parse(text(a)) as HighlightSpec[];
        return null;
      case 'rangeGet': {
        const r = this._ranges.get(Number(a));
        return `${this.idOf(r.sc)},${r.so},${this.idOf(r.ec)},${r.eo}`;
      }
      case 'rangeSet':
        this._ranges.set(
          this._ranges.get(Number(a)),
          this._node(b),
          Number(c),
          d === true,
        );
        return null;
      case 'rangeBeside': {
        const how = text(c);
        this._ranges.setBeside(
          this._ranges.get(Number(a)),
          this._node(b),
          how.startsWith('start'),
          how.endsWith('After'),
        );
        return null;
      }
      case 'rangeSelect': {
        const r = this._ranges.get(Number(a));
        if (c === true) this._ranges.selectNodeContents(r, this._node(b));
        else this._ranges.selectNode(r, this._node(b));
        return null;
      }
      case 'rangeCollapse':
        this._ranges.collapse(this._ranges.get(Number(a)), b === true);
        return null;
      case 'rangeCompare':
        return this._ranges.compare(
          this._ranges.get(Number(a)),
          Number(b),
          this._ranges.get(Number(c)),
        );
      case 'rangeCommon':
        return this.idOf(
          this._ranges.commonAncestor(this._ranges.get(Number(a))),
        );
      case 'rangeDelete':
        this._ranges.deleteContents(this._ranges.get(Number(a)));
        return null;
      case 'rangeContents':
        return this.idOf(
          this._ranges.contents(this._ranges.get(Number(a)), b === true),
        );
      case 'rangeInsert':
        this._ranges.insertNode(
          this._ranges.get(Number(a)),
          this._node(b) as ChildNode,
        );
        return null;
      case 'rangeSurround':
        this._ranges.surround(
          this._ranges.get(Number(a)),
          this._node(b) as ChildNode,
        );
        return null;
      case 'rangeText':
        return this._ranges.text(this._ranges.get(Number(a)));
      case 'rangePoint':
        return this._ranges.point(
          this._ranges.get(Number(a)),
          this._node(b),
          Number(c),
          d === true,
        );
      case 'rangeIntersects':
        return this._ranges.intersects(
          this._ranges.get(Number(a)),
          this._node(b),
        );
      case 'remove': {
        const node = this._node(a) as ChildNode;
        if (node.parent) this._take(node);
        return null;
      }
      case 'clone': {
        const node = this._node(a);
        const clone = this._clone(node, !!b);
        if (this._custom && !this._inTemplate(node)) this._customMade(clone);
        return this.idOf(clone);
      }

      // --- attributes
      case 'attr': {
        const el = this._element(a);
        const name = text(b);
        if (name === 'checked' && this._checkedDefaults.has(el)) {
          return this._checkedDefaults.get(el)!;
        }
        return el.attribs[name] ?? null;
      }
      case 'attrs': {
        const el = this._element(a);
        const names = Object.keys(el.attribs);
        if (!this._checkedDefaults.has(el)) return names.join('\u0000');
        // the default a dirty box's `checked` is, and not its state
        const listed = names.filter((n) => n !== 'checked');
        if (this._checkedDefaults.get(el) !== null) listed.push('checked');
        return listed.join('\u0000');
      }
      case 'setAttr': {
        const el = this._element(a);
        const name = text(b);
        if (name === 'checked' && this._checkedDefaults.has(el)) {
          this._defaultChecked(el, text(c));
          return null;
        }
        const oldValue = el.attribs[name] ?? null;
        el.attribs[name] = text(c);
        this._changed(el, 'attributes', name, oldValue);
        // a frame given another address goes there
        if (
          this._frames.has(el) &&
          name === (el.name === 'object' ? 'data' : 'src') &&
          this._inDocument(el)
        ) {
          this._frameSent.delete(el);
          this._loadFrame(el, true);
        }
        return null;
      }
      case 'delAttr': {
        const el = this._element(a);
        const name = text(b);
        if (name === 'checked' && this._checkedDefaults.has(el)) {
          this._defaultChecked(el, null);
          return null;
        }
        if (name in el.attribs) {
          const oldValue = el.attribs[name];
          delete el.attribs[name];
          this._changed(el, 'attributes', name, oldValue);
        }
        return null;
      }
      case 'style':
      case 'stylePriority': {
        const found = this._declarations(this._element(a))
          .filter((d) => d.prop === text(b))
          .at(-1);
        if (op === 'stylePriority') return found?.important ? 'important' : '';
        return found?.value ?? '';
      }
      case 'styleNames':
        return this._declarations(this._element(a))
          .map((d) => d.prop)
          .join(',');
      // `style.cssText`, serialized as CSSOM serializes a block, each
      // declaration ended: CodeMirror appends `visibility: hidden` to it
      case 'styleText':
        return serializeDeclarations(this._declarations(this._element(a)));
      case 'setStyle': {
        const el = this._element(a);
        const name = text(b);
        // a value the property does not take leaves the declaration as it
        // was; one it does is kept in its canonical form (CSSOM 6.7)
        const raw = closeBrackets(text(c));
        const value = raw && specifiedValue(name, raw);
        if (value === null) return null;
        const kept = this._declarations(el).filter((d) => d.prop !== name);
        if (raw) {
          kept.push({
            prop: name,
            value: value || raw,
            important: d === 'important',
          });
        }
        const written = serializeDeclarations(kept);
        const oldValue = el.attribs.style ?? null;
        if (written) el.attribs.style = written;
        else delete el.attribs.style;
        this._changed(el, 'attributes', 'style', oldValue);
        return null;
      }

      // --- shadow trees, which `<Html>` draws: one attached builds the
      // document again at the next flush, as a new tree to draw
      case 'attachShadow': {
        const host = this._element(a);
        if (shadowRootOf(host)) {
          throw new DomError(
            'NotSupportedError',
            "Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.",
          );
        }
        const root = attachShadow(host, {
          mode: b === 'closed' ? 'closed' : 'open',
          delegatesFocus: c === true,
        });
        if (!root) {
          throw new DomError(
            'NotSupportedError',
            "Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow",
          );
        }
        this._refreshAll = true;
        return this.idOf(root);
      }
      case 'shadowRoot': {
        const root = shadowRootOf(this._element(a));
        return root && root.mode === 'open' ? this.idOf(root) : 0;
      }
      case 'shadowHost':
        return this.idOf((this._node(a) as ShadowRoot).host);
      case 'shadowMode':
        return (this._node(a) as ShadowRoot).mode;
      case 'shadowDelegates':
        return (this._node(a) as ShadowRoot).delegatesFocus;
      // a declarative root whose registry is null, which the page's
      // registries are kept by
      case 'shadowRegistryNull':
        return (this._node(a) as ShadowRoot).registryNull;

      // --- custom elements (`_custom…`)
      // a name defined, local name `b` (its own, or the element an `is`
      // extends), and the elements in the document it upgrades, in
      // shadow-including tree order (HTML 4.13.4, `define()`)
      case 'ceDefine': {
        const name = text(a);
        const local = text(b);
        (this._custom ??= { names: new Set(), log: [] }).names.add(name);
        const found: number[] = [];
        this._customWalk(this.document, (el) => {
          if (
            el.name !== local ||
            (el.namespace && el.namespace !== HTML_NAMESPACE)
          ) {
            return;
          }
          if (local === name || el.attribs.is === name)
            found.push(this.idOf(el));
        });
        return found.join(',');
      }
      // the elements in a node that may be custom elements, for
      // `customElements.upgrade()`
      case 'ceCandidates': {
        const found: number[] = [];
        if (!this._custom) return '';
        this._customWalk(this._node(a), (el) => {
          if (this._customCandidate(el)) found.push(this.idOf(el));
        });
        return found.join(',');
      }
      // what happened to them since the last time, as JSON
      case 'ceTake': {
        const custom = this._custom;
        if (!custom?.log.length) return '';
        const log = custom.log;
        custom.log = [];
        return JSON.stringify(log);
      }
      // an element a definition made a custom element: `:defined` from now
      case 'ceDefined': {
        const el = this._element(a);
        markCustomized(el);
        if (this._inDocument(el)) {
          this._tell(el, {
            type: 'attributes',
            target: el,
            attributeName: '-rx-defined',
          });
        }
        return null;
      }

      // a dialog `showModal()` opened (true), or `close()` closed (false):
      // `:modal` and the top layer from now, told as a change of an
      // attribute nothing has, which only `:modal` reads. Whether it is
      // modal, given neither — taken out of the document, it is not.
      case 'modal': {
        const el = this._element(a);
        if (
          typeof b === 'boolean' &&
          (!b || this._inDocument(el)) &&
          setModal(el, b) &&
          this._inDocument(el)
        ) {
          this._tell(el, {
            type: 'attributes',
            target: el,
            attributeName: '-rx-modal',
          });
        }
        return isModal(el);
      }
      // a popover shown or hidden (HTML 6.12), told as a change of an
      // attribute nothing has, which only `:popover-open` reads; given no
      // `b`, whether it is showing — taken out of the document, it is not
      case 'popoverOpen': {
        const el = this._element(a);
        if (
          typeof b === 'boolean' &&
          (!b || this._inDocument(el)) &&
          setPopoverOpen(el, b) &&
          this._inDocument(el)
        ) {
          this._tell(el, {
            type: 'attributes',
            target: el,
            attributeName: '-rx-popover-open',
          });
        }
        return isPopoverOpen(el);
      }

      // `document.write` from a script the parser met: the markup goes into
      // the document after the script and after what it wrote before, as
      // the parser would have read it there (HTML 8.4.3). Its scripts run,
      // as a parser's do. False where no such script is running.
      case 'write': {
        const script = this.writing;
        if (!script?.parent) return false;
        const kids = parseFragment(text(a));
        if (!kids.length) return true;
        const after = this._written.get(script) ?? script;
        const parent = after.parent ?? script.parent;
        this._put(parent, kids, after.next);
        this._written.set(script, kids[kids.length - 1]);
        return true;
      }

      // --- markup
      case 'html': {
        const node = this._node(a);
        return b ? DomUtils.getOuterHTML(node) : DomUtils.getInnerHTML(node);
      }
      case 'setHtml': {
        const parent = this._parent(a);
        // `setHTMLUnsafe` takes declarative shadow roots, as the document's
        // parser does (HTML 8.5.1)
        this._replaceAll(parent, this._parseIn(parent, text(b), c === true));
        return null;
      }
      case 'adjacent': {
        const node = this._node(a) as ChildNode;
        const where = text(b);
        const inside = where === 'afterbegin' || where === 'beforeend';
        const kids = this._parseIn(inside ? node : node.parent, text(c));
        if (where === 'beforebegin' || where === 'afterend') {
          if (!node.parent) throw hierarchy('The element has no parent.');
          const before = where === 'beforebegin' ? node : node.next;
          this._put(node.parent, kids, before);
        } else if (where === 'afterbegin' || where === 'beforeend') {
          const parent = this._parent(a);
          const first = where === 'afterbegin' ? parent.children[0] : null;
          this._put(parent, kids, first ?? null);
        } else {
          throw new DomError('SyntaxError', `'${where}' is not a position.`);
        }
        return null;
      }
      case 'content': {
        // a `<template>`'s content: a fragment of what it holds, made once
        const id = Number(a);
        let fragment = this._contents.get(id);
        if (fragment === undefined) {
          const template = this._element(a);
          const holder = new Document(
            template.children.map((k) => k.cloneNode(true) as ChildNode),
          );
          for (const kid of holder.children) kid.parent = holder;
          this._templateContents.add(holder);
          fragment = this.idOf(holder);
          this._contents.set(id, fragment);
        }
        return fragment;
      }

      // --- selectors
      case 'query': {
        const root = this._node(a);
        const options = this._selectOptions();
        try {
          if (c) {
            return selectAll(text(b), root as Element, options)
              .map((el) => this.idOf(el))
              .join(',');
          }
          return this.idOf(selectOne(text(b), root as Element, options));
        } catch (error) {
          throw new DomError(
            'SyntaxError',
            `'${text(b)}' is not a valid selector: ${(error as Error).message}`,
          );
        }
      }
      case 'matches':
        try {
          return is(this._element(a), text(b), this._selectOptions());
        } catch {
          throw new DomError(
            'SyntaxError',
            `'${text(b)}' is not a valid selector.`,
          );
        }
      case 'closest': {
        const options = this._selectOptions();
        try {
          for (let at: AnyNode | null = this._element(a); at; at = at.parent) {
            if (at instanceof Element && is(at, text(b), options)) {
              return this.idOf(at);
            }
          }
        } catch {
          throw new DomError(
            'SyntaxError',
            `'${text(b)}' is not a valid selector.`,
          );
        }
        return 0;
      }
      case 'named':
        return (
          this._namesOf((b ? this._node(b) : this.document) as Document).get(
            text(a),
          ) ?? []
        )
          .map((el) => this.idOf(el))
          .join(',');
      case 'byId':
        return this.idOf(
          DomUtils.findOne(
            (el) => el.attribs.id === text(a),
            (b ? (this._node(b) as ParentNode) : this.document).children,
            true,
          ),
        );
      case 'byTag': {
        const tag = text(b).toLowerCase();
        const root = this._node(a) as ParentNode;
        return DomUtils.findAll(
          (el) => tag === '*' || el.name === tag,
          root.children,
        )
          .map((el) => this.idOf(el))
          .join(',');
      }
      case 'byClass': {
        const wanted = text(b)
          .split(/[\t\n\f\r ]+/)
          .filter(Boolean);
        const root = this._node(a) as ParentNode;
        if (!wanted.length) return '';
        return DomUtils.findAll((el) => {
          const has = (el.attribs.class ?? '').split(/[\t\n\f\r ]+/);
          return wanted.every((w) => has.includes(w));
        }, root.children)
          .map((el) => this.idOf(el))
          .join(',');
      }

      // --- the sheets
      // a `<style>`'s rules, where they are not the edit the page has
      case 'sheetRules': {
        const state = this._sheetOf(this._element(a));
        return state.version === b
          ? ''
          : `${state.version}\u0000${JSON.stringify(state.rules)}`;
      }
      case 'sheetInsert': {
        const el = this._element(a);
        const state = this._sheetOf(el);
        const rules = cssRulesOf(text(b));
        if (rules.length !== 1) {
          throw new DomError(
            'SyntaxError',
            `Failed to parse the rule '${text(b)}'.`,
          );
        }
        const index = Number(c);
        if (!(index >= 0 && index <= state.rules.length)) {
          throw new DomError(
            'IndexSizeError',
            `The index provided (${index}) is larger than the maximum index (${state.rules.length}).`,
          );
        }
        const was = state.version;
        state.rules.splice(index, 0, rules[0]);
        state.version = this._s.sheetVersion += 1;
        this._sheetsChanged.add(el);
        return `${was}\u0000${state.version}\u0000${rules[0]}`;
      }
      case 'sheetDelete': {
        const el = this._element(a);
        const state = this._sheetOf(el);
        const index = Number(b);
        if (!(index >= 0 && index < state.rules.length)) {
          throw new DomError(
            'IndexSizeError',
            `The index provided (${index}) is outside the range [0, ${state.rules.length}).`,
          );
        }
        const was = state.version;
        state.rules.splice(index, 1);
        state.version = this._s.sheetVersion += 1;
        this._sheetsChanged.add(el);
        return `${was}\u0000${state.version}`;
      }
      // `CSS.supports`: as `<Html>` answers an `@supports`, a condition as
      // it is written or, where it is no condition, in parentheses
      // a dedicated worker, started, posted to and ended: the page's side
      case 'workerStart': {
        if (!this.workers) {
          throw new DomError(
            'NotSupportedError',
            "Failed to construct 'Worker': workers are not supported here.",
          );
        }
        const init = JSON.parse(text(a)) as Omit<
          WorkerInit,
          'source' | 'origin'
        >;
        return this.workers.start({
          ...init,
          source: typeof b === 'string' ? b : null,
          origin: this._origin(),
        });
      }
      case 'workerPost':
        this.workers?.post(Number(a), text(b));
        return null;
      case 'workerEnd':
        this.workers?.end(Number(a));
        return null;
      // and the worker's
      case 'workerPostOut':
        this.workerScope?.post(text(a));
        return null;
      case 'workerClose':
        this.workerScope?.close();
        return null;
      case 'importScript': {
        // fetched before this returns, and run as a script of its own
        const code = this.workerScope?.importScript(text(a)) ?? null;
        if (code === null) return null;
        return this.entries?.runNested?.(code, text(a)) ?? null;
      }
      case 'workerErrorOut': {
        const [message, filename, line, column] = JSON.parse(text(a));
        this.workerScope?.error(message, filename, line, column);
        return null;
      }

      // a canvas's pixels, the rectangle a task changed: its bitmap's
      // size, where the rectangle is in it, and its rows as base64
      case 'canvasPut': {
        const canvas = this._element(a);
        const [width, height, x, y, w, h] = text(b).split(',').map(Number);
        if (![width, height, x, y, w, h].every(Number.isInteger)) return null;
        let pixels = this._s.canvases.get(canvas);
        if (!pixels || pixels.width !== width || pixels.height !== height) {
          pixels = {
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4),
            version: 0,
          };
          this._s.canvases.set(canvas, pixels);
        }
        const rows = Buffer.from(text(c), 'base64');
        for (let row = 0; row < h && y + row < height; row += 1) {
          const line = rows.subarray(row * w * 4, (row + 1) * w * 4);
          pixels.data.set(
            line.subarray(0, Math.max(0, Math.min(w, width - x)) * 4),
            ((y + row) * width + x) * 4,
          );
        }
        pixels.version += 1;
        for (const listener of [...this._s.canvasListeners]) listener(canvas);
        return null;
      }
      // a colour a page names, as straight RGBA bytes
      case 'color': {
        const rgba = cssColorStraight?.(text(a).trim());
        return rgba ? rgba.map((v) => Math.round(v * 255)).join(',') : '';
      }

      case 'supports': {
        const condition = text(a);
        const answer = supportsCondition(condition);
        if (answer !== null || /^\s*\(/.test(condition))
          return answer !== false;
        return supportsCondition(`(${condition})`) !== false;
      }
      // what is wrong with a property a page registers, CSS Properties
      // and Values 1, 4.1's checks of its syntax and initial value: '' for
      // nothing
      case 'propertyRegistration': {
        const syntax = text(a);
        const initial = text(b);
        if (!validSyntax(syntax)) {
          return 'The syntax provided is not a valid custom property syntax.';
        }
        if (c !== true) {
          return syntax.trim() === '*'
            ? ''
            : "An initial value must be provided if the syntax is not '*'";
        }
        if (syntax.trim() !== '*' && !matchesSyntax(initial, syntax)) {
          return 'The initial value provided does not parse for the given syntax.';
        }
        if (hasVar(initial) || RELATIVE_LENGTH.test(initial)) {
          return 'The initial value provided is not computationally independent.';
        }
        return '';
      }
      // the reader's selection where it changed since the page last heard
      // of it or set it: its two points as ids and offsets, '' for none,
      // and null for no change
      case 'documentSelection': {
        const points = this._seams.handle.selectionPoints?.() ?? null;
        const key = points?.key ?? '';
        if (key === this._selectionTold) return null;
        this._selectionTold = key;
        return points
          ? JSON.stringify([
              this.idOf(points.sc),
              points.so,
              this.idOf(points.ec),
              points.eo,
            ])
          : '';
      }
      // the page's selection, drawn as the reader's is
      case 'setDocumentSelection': {
        const points = text(a)
          ? (JSON.parse(text(a)) as [number, number, number, number])
          : null;
        this._seams.handle.selectPoints?.(
          points
            ? {
                sc: this._node(points[0]),
                so: points[1],
                ec: this._node(points[2]),
                eo: points[3],
              }
            : null,
        );
        // what the page set is what it has heard of
        this._selectionTold = this._seams.handle.selectionPoints?.()?.key ?? '';
        return null;
      }
      // what the page registered, as `@property` rules, told at once
      case 'registeredProperties':
        this._seams.handle.setRegisteredProperties?.(text(a));
        return null;
      // the sheets the document adopted, each its text, in order
      case 'adopt': {
        const sheets: unknown = JSON.parse(text(a) || '[]');
        if (Array.isArray(sheets)) {
          this._seams.adopt?.(sheets.map((sheet) => String(sheet)));
        }
        return null;
      }
      // a sheet's text as rules, for a sheet of the page's own and what a
      // grouping rule holds
      case 'cssRules':
        return JSON.stringify(cssRulesOf(text(a)));
      // the document's sheets, in tree order: its `<style>`s and the
      // `<link>`s that are a stylesheet
      case 'sheets':
        return (
          DomUtils.findAll(
            (el) =>
              el.name === 'style' ||
              (el.name === 'link' &&
                /(?:^|\s)stylesheet(?:\s|$)/i.test(el.attribs.rel ?? '') &&
                !/(?:^|\s)alternate(?:\s|$)/i.test(el.attribs.rel ?? '')),
            (a ? (this._node(a) as ParentNode) : this.document).children,
          )
            // what a `<template>` holds is no part of the document
            .filter((el) => {
              for (let at = el.parent; at; at = at.parent) {
                if (at instanceof Element && at.name === 'template')
                  return false;
              }
              return true;
            })
            .map((el) => this.idOf(el))
            .join(',')
        );

      // --- frames
      case 'frameDocument': {
        const doc = this._frameDocument(this._element(a));
        return doc ? this.idOf(doc) : 0;
      }
      case 'frameElement': {
        const frame = this._frameOf.get(this._node(a) as Document);
        return frame ? this.idOf(frame) : 0;
      }
      // where a frame's document is from, another origin's as well: its
      // window's `location`, which the page may set whoever's it is
      case 'frameLocation': {
        const frame = this._element(a);
        this._frameDocument(frame);
        return this._frameAt.get(frame) ?? 'about:blank';
      }
      case 'frameNavigate':
        this.navigateFrame(this._element(a), text(b), null);
        return null;
      // a frame's address changed by its own history, with no navigation
      case 'setFrameLocation':
        this._frameAt.set(this._element(a), text(b));
        return null;
      // a frame document's viewport, its window's `innerWidth`
      case 'frameSize': {
        const size = this._frameSize(this._node(a) as Document);
        return `${size.width} ${size.height}`;
      }

      // --- the document
      case 'root': {
        // the document asked of: this one, or one a page made of its own
        const doc = a ? (this._node(a) as ParentNode) : this.document;
        return this.idOf(
          doc.children.find((k) => k instanceof Element) ?? null,
        );
      }
      // a document of a page's own, out of the one drawn
      case 'newDocument': {
        // its `<title>` the text given, where one was
        const title =
          a === null || a === undefined
            ? ''
            : `<title>${DomUtils.getOuterHTML(new Text(text(a)))}</title>`;
        return this.idOf(
          this._documentOf(`<html><head>${title}</head><body></body></html>`),
        );
      }
      case 'parseDocument':
        return this.idOf(this._documentOf(text(a)));
      // a page's own document made again of what it wrote between `open`
      // and `close`
      case 'fillDocument': {
        const doc = this._node(a);
        if (!this._documents.has(doc as Document)) {
          throw new DomError('InvalidStateError', 'Not a document of its own.');
        }
        this._fill(doc as Document, text(b));
        return null;
      }
      case 'title': {
        const title = DomUtils.findOne(
          (el) => el.name === 'title',
          (a ? (this._node(a) as ParentNode) : this.document).children,
        );
        return title
          ? DomUtils.textContent(title).replace(/\s+/g, ' ').trim()
          : '';
      }
      case 'setTitle': {
        const doc = b ? (this._node(b) as ParentNode) : this.document;
        let title = DomUtils.findOne((el) => el.name === 'title', doc.children);
        if (!title) {
          const head =
            DomUtils.findOne((el) => el.name === 'head', doc.children) ??
            (doc.children.find((k) => k instanceof Element) as
              Element | undefined);
          if (!head) return null;
          title = new Element('title', {}, []);
          this._put(head, [title], null);
        }
        this._replaceAll(title, [new Text(text(a))]);
        if (doc === this.document) this._seams.title(text(a) || null);
        return null;
      }
      case 'disabled':
        return isDisabled(this._element(a));

      // --- layout, which answers from the tree as the page left it
      // an element's padding and border widths, top, right, bottom, left
      // each, in CSS pixels: what its content box is less than its border
      // box (`ResizeObserver`)
      case 'edges': {
        this.flush();
        const style = this._seams.handle.computedStyle(this._element(a), null);
        if (!style) return '';
        const n = (name: string) => parseFloat(style[name] ?? '0') || 0;
        return [
          n('padding-top'),
          n('padding-right'),
          n('padding-bottom'),
          n('padding-left'),
          n('border-top-width'),
          n('border-right-width'),
          n('border-bottom-width'),
          n('border-left-width'),
        ].join(',');
      }
      case 'rect': {
        this.flush();
        const rect = this._seams.handle.elementRect(this._element(a));
        return rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : '';
      }
      // whether no scroll of the viewport moves an element: one fixed to
      // it, or in one that is (`scrollIntoView`)
      case 'atViewport':
        this.flush();
        return this._seams.handle.drawnAtViewport?.(this._element(a)) === true;
      // whether a scroll container's scroll moves an element, which it
      // does not for one positioned against something outside it
      // (`scrollIntoView`)
      case 'scrollMoves':
        this.flush();
        return (
          this._seams.handle.scrollMoves?.(
            this._element(a),
            this._element(b),
          ) !== false
        );
      // `offsetParent` and the offsets from it, in one walk up the boxes:
      // the parent's id, then x, y, width and height in CSS pixels, or ''
      // for an element with no box (`HtmlHandle.offsetRect`)
      case 'offset': {
        this.flush();
        const r = this._seams.handle.offsetRect(this._element(a));
        return r
          ? `${this.idOf(r.parent)},${r.x},${r.y},${r.width},${r.height}`
          : '';
      }
      case 'computed': {
        this.flush();
        const pseudo = b === 'before' || b === 'after' ? b : null;
        // a frame's document's, which nothing draws
        if (!this._inDocument(this._element(a))) {
          const style = this._frameStyle(this._element(a), pseudo);
          return style ? JSON.stringify(style) : '';
        }
        const style = this._seams.handle.computedStyle(
          this._element(a),
          pseudo,
        );
        return style ? JSON.stringify(style) : '';
      }
      // one custom property's, by its name: a theme's hundreds are no part
      // of what `computed` sends
      case 'customProperty': {
        this.flush();
        const el = this._element(a);
        const pseudo = b === 'before' || b === 'after' ? b : null;
        if (!this._inDocument(el)) {
          return this._frameComputed(el, pseudo)?.custom?.get(text(c)) ?? '';
        }
        return this._seams.handle.customProperty(el, text(c), pseudo) ?? '';
      }
      case 'at': {
        this.flush();
        const v = this._seams.viewport();
        const x = Number(a);
        const y = Number(b);
        if (!(x >= 0 && y >= 0 && x < v.width && y < v.height)) return 0;
        return this.idOf(
          this._seams.handle.elementAt(v.left + x * v.zoom, v.top + y * v.zoom),
        );
      }
      case 'viewport': {
        const v = this._seams.viewport();
        return `${v.width},${v.height},${v.scrollX},${v.scrollY},${v.dpr}`;
      }
      // a scroll container in the document: where it is scrolled to, how
      // far it can be and its scrollport, in CSS pixels, or '' for an
      // element that is none (`HtmlHandle.scrollState`)
      case 'scrollState': {
        this.flush();
        const s = this._seams.handle.scrollState(this._element(a));
        return s
          ? [
              s.x,
              s.y,
              s.width,
              s.height,
              s.clientWidth,
              s.clientHeight,
              s.clientTop,
              s.clientLeft,
            ].join(',')
          : '';
      }
      // and scrolled, an axis left where it is where it is not a number
      case 'scrollElement': {
        this.flush();
        const x = typeof b === 'number' && Number.isFinite(b) ? b : undefined;
        const y = typeof c === 'number' && Number.isFinite(c) ? c : undefined;
        const to = this._seams.handle.scrollElementTo(this._element(a), {
          x,
          y,
        });
        return to ? `${to.x},${to.y}` : '';
      }
      case 'scrollTo':
        this._seams.scrollTo(
          Math.max(0, Number(a) || 0),
          Math.max(0, Number(b) || 0),
        );
        return null;
      // as the document's own `@media` rules are matched: its width, its
      // scheme, its preference for motion
      case 'media':
        try {
          return this._seams.handle.matchMedia(text(a));
        } catch {
          return false;
        }

      // what a page asked of a media element's player — `paused`, `muted`,
      // `volume`, `playbackRate`, or `currentTime` for a seek — kept by
      // `<Html>` for the player it mounts over the element
      case 'mediaState': {
        const el = this._element(a);
        const name = text(b);
        if (name === 'paused' || name === 'muted') {
          this._seams.handle.setMediaState(el, { [name]: c === true });
          // `:muted` reads it, told as an attribute nothing has
          if (name === 'muted' && setMuted(el, c === true)) {
            this._tell(el, {
              type: 'attributes',
              target: el,
              attributeName: '-rx-muted',
            });
          }
        } else if (
          (name === 'volume' ||
            name === 'playbackRate' ||
            name === 'currentTime') &&
          typeof c === 'number' &&
          Number.isFinite(c)
        ) {
          this._seams.handle.setMediaState(el, { [name]: c });
        }
        return null;
      }

      // what a page's script says of one of its animations: its effect, as
      // a JSON string the host reads (`css/scripted.ts`), and where its
      // time is — or, with either null, that the element has it no longer
      // — told to the `<Html>` that draws the element's document
      case 'animation': {
        const el = this._element(a);
        this._drawing(el)?.setScriptAnimation(
          el,
          Number(b),
          typeof c === 'string' ? c : null,
          typeof d === 'string' ? d : null,
        );
        return null;
      }
      // what `commitStyles` writes: the values of the properties named,
      // with the animation at the top of the element's effect stack, or
      // null where the element is not rendered
      case 'animationValues': {
        const el = this._element(a);
        const handle = this._drawing(el);
        if (!handle) return null;
        return handle.scriptAnimationValues(
          el,
          Number(b),
          text(c).split('\u0000').filter(Boolean),
        );
      }

      // --- controls and the focus, which are `<Html>`'s
      case 'value':
        return this._seams.handle.controlValue(this._element(a));
      case 'setValue': {
        const el = this._element(a);
        // checkedness a script set is the box's from then on, and its
        // attribute only its default (HTML 4.10.5.4, "dirty checkedness")
        if (
          typeof b === 'boolean' &&
          el.name === 'input' &&
          /^(checkbox|radio)$/i.test(el.attribs.type ?? '') &&
          !this._checkedDefaults.has(el)
        ) {
          this._checkedDefaults.set(el, el.attribs.checked ?? null);
        }
        return this._seams.handle.setControlValue(
          el,
          typeof b === 'boolean' ? b : text(b),
        );
      }
      case 'focus': {
        this.flush();
        const el = this._element(a);
        // A control just put in has no widget until the render that the
        // flush asked for, nor a link shown a stop: asked again once it
        // has, and until then the element the page has the focus on, as a
        // browser focuses it at once — a dialog `showModal()` opened
        // focuses what is in it, and one opened over it gives the focus
        // back to that as it closes. Not one that can take no focus at
        // all, which a page focuses to find out whether it can.
        this._focusing = null;
        if (!this._seams.handle.focus(el)) {
          const pending = focusableElement(el);
          if (pending) this._focusing = el;
          setTimeout(() => {
            if (this._disposed) return;
            // focused elsewhere since
            if (pending && this._focusing !== el) return;
            if (pending) this._focusing = null;
            this._seams.handle.focus(el);
          }, 16);
        }
        return null;
      }
      case 'blur':
        this._focusing = null;
        this._seams.handle.blur();
        return null;
      case 'active':
        return this.idOf(
          this._focusing?.parent
            ? this._focusing
            : this._seams.handle.activeElement,
        );
      case 'activate': {
        const node = this._node(a);
        return node instanceof Element && this._seams.handle.activate(node);
      }
      case 'submit':
        this.flush();
        this._seams.handle.submitForm(
          this._element(a),
          b ? this._element(b) : null,
        );
        return null;
      case 'validate':
        return this._seams.handle.reportValidity(
          this._element(a),
          b ? this._element(b) : null,
        );
      case 'reset': {
        const form = this._element(a);
        this._seams.handle.resetForm(form);
        // and a reset puts a dirty box back to its default, clean again
        for (const el of DomUtils.findAll(
          (e) => this._checkedDefaults.has(e),
          form.children,
        )) {
          const value = this._checkedDefaults.get(el)!;
          this._checkedDefaults.delete(el);
          const oldValue = el.attribs.checked ?? null;
          if (value === null) delete el.attribs.checked;
          else el.attribs.checked = value;
          this._changed(el, 'attributes', 'checked', oldValue);
        }
        return null;
      }

      // --- the window
      case 'log':
        this._seams.log(text(a), text(b));
        return null;
      case 'now':
        return performance.now();
      case 'navigator':
        return `${this._seams.userAgent}\u0000${this._seams.language}`;
      case 'base':
        return this._seams.handle.base ?? this.url;
      case 'location':
        return this.url;
      case 'setLocation':
        this.url = text(a);
        return null;
      case 'resolve':
        return this._resolve(text(a));
      case 'url':
        return urlJson(text(a), text(b));
      case 'setUrl': {
        try {
          const url = new URL(text(a));
          (url as unknown as Record<string, string>)[text(b)] = text(c);
          return urlJson(url.href, '');
        } catch {
          return '';
        }
      }
      case 'navigate':
        this._seams.navigate(text(a), b ? 'replace' : 'here');
        return null;
      // `window.open`, to where its name says (`navigableFor`): a frame of
      // the page's, the page's own tab, or a new one
      case 'open': {
        const to = navigableFor(this.document, text(b));
        if (to === 'here') this._seams.navigate(text(a), 'here');
        else if (to === 'tab') this._seams.navigate(text(a), 'tab');
        else this.navigateFrame(to, text(a), null);
        return null;
      }
      case 'reload':
        this._seams.reload();
        return null;
      case 'go':
        this._seams.go(Number(a) || 0);
        return null;
      case 'storage':
        return this._storage(text(a), text(b), text(c), text(d));
      case 'timer': {
        const id = Number(a);
        const repeat = !!c;
        const ms = Math.max(repeat ? 4 : 0, Number(b) || 0);
        const fire = () => {
          if (!repeat) this._timers.delete(id);
          this.entries?.call('__timer', [id]);
        };
        this._timers.set(
          id,
          repeat ? setInterval(fire, ms) : setTimeout(fire, ms),
        );
        return null;
      }
      case 'clearTimer': {
        const timer = this._timers.get(Number(a));
        if (timer !== undefined) {
          clearTimeout(timer);
          clearInterval(timer);
          this._timers.delete(Number(a));
        }
        return null;
      }
      // --- observers
      case 'observe': {
        let observer = this._observers.get(Number(a));
        if (!observer) {
          observer = { on: new Map(), queue: [] };
          this._observers.set(Number(a), observer);
        }
        const raw = JSON.parse(text(c)) as Partial<ObserveOptions>;
        observer.on.set(this._node(b), {
          childList: !!raw.childList,
          attributes: !!raw.attributes,
          characterData: !!raw.characterData,
          subtree: !!raw.subtree,
          attributeOldValue: !!raw.attributeOldValue,
          characterDataOldValue: !!raw.characterDataOldValue,
          attributeFilter: Array.isArray(raw.attributeFilter)
            ? raw.attributeFilter.map(String)
            : null,
        });
        return null;
      }
      case 'disconnect':
        this._observers.delete(Number(a));
        return null;
      case 'observed':
        // the observers with records, in the order they were made
        return [...this._observers]
          .filter(([, o]) => o.queue.length)
          .map(([id]) => id)
          .join(',');
      case 'takeRecords': {
        const observer = this._observers.get(Number(a));
        if (!observer?.queue.length) return '[]';
        const queue = observer.queue;
        observer.queue = [];
        const ids = (nodes: readonly AnyNode[]) =>
          nodes.map((n) => this.idOf(n));
        return JSON.stringify(
          queue.map((r) => [
            r.type,
            this.idOf(r.target),
            ids(r.added),
            ids(r.removed),
            this.idOf(r.previous),
            this.idOf(r.next),
            r.attributeName,
            r.oldValue,
          ]),
        );
      }

      // a page's randomness, `crypto`'s: hex, a primitive
      case 'random':
        return hex(
          crypto.getRandomValues(
            new Uint8Array(Math.min(65536, Math.max(0, Number(a) || 0))),
          ),
        );
      case 'uuid':
        return crypto.randomUUID();
      case 'fetch':
        this._fetch(Number(a), text(b));
        return null;
      case 'abortFetch':
        this._fetches.get(Number(a))?.abort();
        this._fetches.delete(Number(a));
        void this._bodies.get(Number(a))?.return?.();
        this._bodies.delete(Number(a));
        return null;
      default:
        throw new DomError('NotSupportedError', `No op '${op}'.`);
    }
  }

  /** Put a node, or what a fragment holds, into `parent` before `before`
   *  (DOM 4.2.3, "pre-insert"): never into itself or what it holds. */
  private _insert(
    parent: ParentNode,
    node: AnyNode,
    before: AnyNode | null,
  ): void {
    this._validInsert(parent, node, before, false);
    if (before === node) return;
    const moving = this._isFragment(node)
      ? (node as Document).children.slice()
      : [node as ChildNode];
    this._put(parent, moving, before as ChildNode | null);
  }

  /** `child` replaced by `node` (DOM 4.2.3, "replace"). */
  private _replace(parent: ParentNode, node: AnyNode, child: AnyNode): void {
    this._validInsert(parent, node, child, true);
    let reference = child.next;
    if (reference === node) reference = node.next;
    const moving = this._isFragment(node)
      ? (node as Document).children.slice()
      : [node as ChildNode];
    if (child.parent && child !== node) this._take(child as ChildNode);
    this._put(parent, moving, reference);
  }

  /**
   * Whether `node` may go into `parent` before `child`, or in its place
   * (DOM 4.2.3, "ensure pre-insert validity" and "replace", steps 1–6):
   * never into itself, and into a document only what a document holds —
   * one element, one doctype before it, no text.
   */
  private _validInsert(
    parent: ParentNode,
    node: AnyNode,
    child: AnyNode | null,
    replacing: boolean,
  ): void {
    if (this._isDocument(node)) throw hierarchy('A document cannot be moved.');
    for (let at: AnyNode | null = parent; at; at = at.parent) {
      if (at === node) {
        throw hierarchy('The new child element contains the parent.');
      }
    }
    if (child && child.parent !== parent) {
      throw new DomError(
        'NotFoundError',
        replacing
          ? 'The node to be replaced is not a child of this node.'
          : 'The node before which the new node is to be inserted is not a child of this node.',
      );
    }
    const fragment = this._isFragment(node);
    const doctype = isDoctype(node);
    if (
      !fragment &&
      !doctype &&
      !(node instanceof Element) &&
      !(node instanceof Text) &&
      !(node instanceof Comment)
    ) {
      throw hierarchy('That node cannot be inserted.');
    }
    const intoDocument = this._isDocument(parent);
    if (node instanceof Text && intoDocument) {
      throw hierarchy('A document cannot hold text.');
    }
    if (doctype && !intoDocument) {
      throw hierarchy('Only a document holds a doctype.');
    }
    if (!intoDocument) return;
    const kids = parent.children;
    const at = child ? kids.indexOf(child as ChildNode) : kids.length;
    const others = replacing ? kids.filter((k) => k !== child) : kids;
    const hasElement = others.some((k) => k instanceof Element);
    // a doctype at the child or after it, where a new element would go
    // before it: a replaced child's place is its own
    const doctypeAfter = kids
      .slice(replacing ? at + 1 : at)
      .some((k) => isDoctype(k));
    const refused = (): never => {
      throw hierarchy('A document holds one element, after its doctype.');
    };
    if (fragment) {
      const held = (node as Document).children;
      const elements = held.filter((k) => k instanceof Element).length;
      if (elements > 1 || held.some((k) => k instanceof Text)) refused();
      if (elements === 1 && (hasElement || doctypeAfter)) refused();
    } else if (node instanceof Element) {
      if (hasElement || doctypeAfter) refused();
    } else if (doctype) {
      const elementBefore = kids
        .slice(0, at)
        .some((k) => k instanceof Element && k !== child);
      if (others.some((k) => isDoctype(k)) || elementBefore) refused();
      if (!child && hasElement) refused();
    }
  }

  // --- what changed -----------------------------------------------------------
  //
  // Every change the ops make goes through these, as one record each: told
  // `<Html>` at the next `flush`, which restyles what it reaches
  // (`refresh(changes)`), and queued for the observers that watch it, as
  // DOM 4.3.2's "queue a mutation record" has them.

  /** An attribute's or a text's change, recorded. */
  private _changed(
    target: AnyNode,
    type: 'attributes' | 'characterData',
    name: string | null,
    oldValue: string | null,
  ): void {
    if (type === 'attributes') {
      this._tell(target, {
        type,
        target: target as Element,
        attributeName: name!,
        oldValue,
      });
      if (this._custom && this._customCandidate(target)) {
        this._custom.log.push([
          't',
          this.idOf(target),
          name,
          oldValue,
          target.attribs[name!] ?? null,
        ]);
      }
    } else {
      this._tell(target, { type, target });
      if (target.parent) this._sheetText(target.parent);
    }
    if (this._observers.size) {
      this._queue(target, {
        type,
        target,
        added: [],
        removed: [],
        previous: null,
        next: null,
        attributeName: name,
        oldValue,
      });
    }
  }

  /** Nodes put into `parent` before `before`, or at its end, each taken
   *  from wherever it was first: a record of each taking, and one of the
   *  putting. */
  private _put(
    parent: ParentNode,
    nodes: readonly ChildNode[],
    before: ChildNode | null,
  ): void {
    for (const node of nodes) if (node.parent) this._take(node);
    if (!nodes.length) return;
    const previous = before ? before.prev : (parent.children.at(-1) ?? null);
    const index = before ? indexOf(before) : parent.children.length;
    const owner = this._ownerOf(parent);
    for (const node of nodes) {
      if (this._ownerOf(node) !== owner) this._adopt(node, owner);
      if (before) DomUtils.prepend(before, node);
      else DomUtils.appendChild(parent, node);
    }
    this._ranges.inserted(parent, index, nodes.length);
    this._childList(parent, nodes, [], previous, before);
    this._framesIn(nodes);
  }

  /** A node taken out of its parent, recorded. */
  private _take(node: ChildNode): void {
    const parent = node.parent!;
    const previous = node.prev;
    const next = node.next;
    // out of its tree, it is still its document's
    if (!this._owners.has(node)) {
      const owner = this._ownerOf(node);
      if (owner !== this.document) this._owners.set(node, owner);
    }
    this._ranges.removing(node);
    this._iterators.removing(node);
    DomUtils.removeElement(node);
    this._childList(parent, [], [node], previous, next);
  }

  /** What `parent` holds replaced by `nodes`, as one record (DOM 4.2.3,
   *  "replace all"). */
  private _replaceAll(parent: ParentNode, nodes: readonly ChildNode[]): void {
    for (const node of nodes) if (node.parent) this._take(node);
    const removed = parent.children.slice();
    const owner = this._ownerOf(parent);
    for (const kid of removed) {
      if (owner !== this.document) this._owners.set(kid, owner);
      this._ranges.removing(kid);
      this._iterators.removing(kid);
      DomUtils.removeElement(kid);
    }
    for (const node of nodes) {
      if (this._ownerOf(node) !== owner) this._adopt(node, owner);
      DomUtils.appendChild(parent, node);
    }
    this._ranges.inserted(parent, 0, nodes.length);
    if (removed.length || nodes.length) {
      this._childList(parent, nodes, removed, null, null);
    }
  }

  private _childList(
    parent: ParentNode,
    added: readonly AnyNode[],
    removed: readonly AnyNode[],
    previous: AnyNode | null,
    next: AnyNode | null,
  ): void {
    this._tell(parent, {
      type: 'childList',
      target: parent,
      addedNodes: added,
      removedNodes: removed,
    });
    // a modal dialog taken out of the document is no longer modal, nor in
    // the top layer (HTML 4.11.4, the dialog's removing steps)
    if (removed.length) {
      const layer = topLayerOf(parent);
      if (layer.length) {
        for (const node of removed) {
          // and a popover taken out is hidden (HTML 6.12, the popover
          // removing steps)
          for (const el of topLayerIn(node, layer)) {
            setModal(el, false);
            setPopoverOpen(el, false);
          }
        }
      }
    }
    this._sheetText(parent);
    if (this._custom && this._inDocument(parent)) {
      for (const node of removed) this._customLog('d', node);
      for (const node of added) this._customLog('c', node);
    }
    if (this._observers.size) {
      this._queue(parent, {
        type: 'childList',
        target: parent,
        added,
        removed,
        previous,
        next,
        attributeName: null,
        oldValue: null,
      });
    }
  }

  // --- custom elements --------------------------------------------------------
  //
  // The page's registry is the facade's (`customElements`), and so are an
  // element's custom element state and its reactions (HTML 4.13.6). What
  // the host does is say what happened to the elements that may be custom
  // elements — those named, or `is`-given, a name the page defined, and
  // those a definition made — as the changes that happen to them: put into
  // the document, taken out of it, moved to another document, an attribute
  // changed, or copied into the document (`ceTake`). The facade runs their
  // callbacks, and upgrades the ones it has a definition for, after the op
  // that made the change, as `[CEReactions]` runs them before a DOM method
  // returns.

  /** Whether an element may be a custom element, or become one. */
  private _customCandidate(node: AnyNode): node is Element {
    if (!(node instanceof Element)) return false;
    const names = this._custom!.names;
    if (names.has(node.name)) return true;
    const is = node.attribs.is;
    return (is !== undefined && names.has(is)) || isCustomized(node);
  }

  /** Each element in `node`, itself first, in shadow-including tree order
   *  (DOM 4.2.2): a shadow tree straight after its host, before the host's
   *  children. A `<template>`'s content is no part of it. */
  private _customWalk(node: AnyNode, each: (el: Element) => void): void {
    const stack: AnyNode[] = [node];
    while (stack.length) {
      const at = stack.pop()!;
      if (!(at instanceof Element)) {
        if (at instanceof Document) {
          for (let i = at.children.length - 1; i >= 0; i -= 1) {
            stack.push(at.children[i]);
          }
        }
        continue;
      }
      each(at);
      if (at.name === 'template') continue;
      for (let i = at.children.length - 1; i >= 0; i -= 1) {
        stack.push(at.children[i]);
      }
      const root = shadowRootOf(at);
      if (root) stack.push(root);
    }
  }

  /** What happened to each element in `node` that may be a custom
   *  element, noted for the facade, as `kind` and its id and `more`. */
  private _customLog(
    kind: 'c' | 'd' | 'a' | 'u',
    node: AnyNode,
    more: Primitive[] = [],
  ): void {
    const log = this._custom!.log;
    this._customWalk(node, (el) => {
      if (this._customCandidate(el)) log.push([kind, this.idOf(el), ...more]);
    });
  }

  /** A copy made in the document, whose custom elements a definition the
   *  page has upgrades, connected or not (DOM 4.5, "clone", which creates
   *  each element as `createElement` does). */
  private _customMade(node: AnyNode): void {
    if (this._ownerOf(node) === this.document) this._customLog('u', node);
  }

  /**
   * What `querySelector`, `matches` and `closest` are asked with: the
   * pseudo-classes css-select has no answer of its own for, answered as
   * the document stands. It threw on each, where a browser answers, and a
   * page's script that asked one stopped there: GitHub's ask `:target` as
   * they load. One answered from something no script can see here — the
   * pointer's history, a popover, a full screen — matches nothing.
   */
  private _selectOptions(): {
    pseudos: Record<string, (el: Element, arg?: string | null) => boolean>;
  } {
    if (this._pseudos) return this._pseudos;
    const handle = () => this._seams.handle;
    const focused = (el: Element): boolean => handle().activeElement === el;
    const nothing = (_el: Element): boolean => false;
    const live = (el: Element): string | undefined => {
      const value = handle().controlValue(el);
      return typeof value === 'string' ? value : undefined;
    };
    const invalid = (el: Element): boolean =>
      validationMessage(el, live) !== null;
    const pseudos: Record<
      string,
      (el: Element, arg?: string | null) => boolean
    > = {
      defined: (el) => isDefinedElement(el),
      target: (el) => {
        let fragment = '';
        try {
          fragment = new URL(this.url).hash.slice(1);
        } catch {}
        return indicatedElement(this.document, fragment) === el;
      },
      focus: focused,
      'focus-visible': focused,
      'focus-within': (el) => {
        let at: AnyNode | null = handle().activeElement as AnyNode | null;
        while (at) {
          if (at === el) return true;
          at = at instanceof ShadowRoot ? at.host : at.parent;
        }
        return false;
      },
      open: (el) =>
        (el.name === 'details' || el.name === 'dialog') &&
        el.attribs.open !== undefined,
      valid: (el) => !invalid(el),
      invalid,
      'placeholder-shown': (el) =>
        (el.name === 'input' || el.name === 'textarea') &&
        el.attribs.placeholder !== undefined &&
        !(live(el) ?? el.attribs.value ?? ''),
      // one that takes an argument has a second parameter, as css-select
      // counts them
      state: (_el, _name) => false,
      modal: (el) => isModal(el),
      'popover-open': (el) => isPopoverOpen(el),
      muted: (el) => isMuted(el),
      // a page cannot lock a volume, and nothing here does
      'volume-locked': nothing,
      fullscreen: nothing,
      autofill: nothing,
      '-webkit-autofill': nothing,
      'user-valid': nothing,
      'user-invalid': nothing,
      indeterminate: nothing,
      playing: nothing,
      paused: nothing,
      host: nothing,
    };
    return (this._pseudos = { pseudos });
  }
  private _pseudos: ReturnType<DomHost['_selectOptions']> | null = null;

  /** Whether a node is in a `<template>`'s content. */
  private _inTemplate(node: AnyNode): boolean {
    let at = node;
    while (at.parent) at = at.parent;
    return this._templateContents.has(at);
  }

  /**
   * A change, for the `<Html>` that draws the node's document: this realm's
   * own, at the next flush; another realm's — a frame's document the page
   * wrote into, or the page's a frame's script did — through what the
   * realms share, which any realm's flush tells. A node in no document is
   * this realm's, and one in a document a page made that nothing draws is
   * counted instead, for the styles a frame works out (`_frameStyle`).
   */
  /** The `<Html>` that draws a node's document: this realm's, or the one
   *  a frame's document is drawn by; null where nothing draws it. */
  private _drawing(node: AnyNode): HtmlHandle | null {
    let at: AnyNode = node;
    for (;;) {
      if (at.parent) at = at.parent;
      else if (at instanceof ShadowRoot) at = at.host;
      else break;
    }
    if (at === this.document) return this._seams.handle;
    return this._s.drawn.get(at as Document) ?? null;
  }

  /** The reader's selection as the page last heard of it or set it, as
   *  core's range (`documentSelection`). */
  private _selectionTold = '';

  /** The page's custom highlights, as `highlights` was last told them. */
  private _highlightSpec: HighlightSpec[] = [];
  /** What the document was last told of them, as a key: their names,
   *  priorities and ranges' boundary points. */
  private _highlightsTold = '';

  /** Tell the document its custom highlights where they changed: their
   *  live ranges move with the tree, so they are read again at each flush,
   *  and told only where a boundary, a name or a priority moved. */
  private _syncHighlights(): void {
    if (!this._highlightSpec.length && !this._highlightsTold) return;
    const resolved: HighlightRanges[] = [];
    const key: string[] = [];
    for (const h of this._highlightSpec) {
      const ranges: HighlightRanges['ranges'] = [];
      for (const r of h.ranges) {
        let point: { sc: AnyNode; so: number; ec: AnyNode; eo: number };
        try {
          if (typeof r === 'number') {
            const live = this._ranges.get(r);
            point = { sc: live.sc, so: live.so, ec: live.ec, eo: live.eo };
          } else {
            point = {
              sc: this._node(r[0]),
              so: r[1],
              ec: this._node(r[2]),
              eo: r[3],
            };
          }
        } catch {
          continue;
        }
        if (!this._inDocument(point.sc) || !this._inDocument(point.ec)) {
          continue;
        }
        ranges.push(point);
        key.push(
          `${this.idOf(point.sc)},${point.so},${this.idOf(point.ec)},${point.eo}`,
        );
      }
      resolved.push({ name: h.name, priority: h.priority, ranges });
      key.push(`|${h.name}:${h.priority}`);
    }
    const told = key.join(';');
    if (told === this._highlightsTold) return;
    this._highlightsTold = told;
    this._seams.handle.setHighlights?.(resolved);
  }

  /** Each document's names, with where `edits` and the parser were when
   *  they were found. */
  private readonly _names = new WeakMap<
    Document,
    { at: string; names: Map<string, Element[]> }
  >();

  /**
   * What a document's window is reached by the name of (HTML 7.2.2.3), in
   * tree order: every element by its `id`, and an `embed`, a `form`, an
   * `img`, an `object` and a frame by its `name`. Asked at every global
   * name a page reads that is no global — every `typeof require` of a
   * bundle — so it is found in one walk, and walked again only once a tree
   * has changed since.
   */
  private _namesOf(doc: Document): Map<string, Element[]> {
    const at = `${edits}:${treeGeneration()}`;
    const kept = this._names.get(doc);
    if (kept?.at === at) return kept.names;
    const names = new Map<string, Element[]>();
    const add = (key: string | undefined, el: Element): void => {
      if (!key) return;
      const list = names.get(key);
      if (!list) names.set(key, [el]);
      else if (list[list.length - 1] !== el) list.push(el);
    };
    for (const el of DomUtils.findAll(() => true, doc.children)) {
      add(el.attribs.id, el);
      if (NAMED_BY_NAME.has(el.name)) add(el.attribs.name, el);
    }
    this._names.set(doc, { at, names });
    return names;
  }

  private _tell(node: AnyNode, change: HtmlChange): void {
    // what can change a window's names; a text's change cannot
    if (
      change.type === 'childList' ||
      (change.type === 'attributes' &&
        (change.attributeName === 'id' || change.attributeName === 'name'))
    ) {
      edits += 1;
    }
    let at: AnyNode = node;
    while (at.parent) at = at.parent;
    const doc = at as Document;
    if (doc === this.document) {
      this._changes.push(change);
      return;
    }
    if (this._s.drawn.has(doc)) {
      let list = this._s.changes.get(doc);
      if (!list) this._s.changes.set(doc, (list = []));
      list.push(change);
      // and a frame's style worked out here for the page realm reads it
      // (`_frameStyle`) as it reads one nothing draws
      this._s.foreignChanges += 1;
      return;
    }
    if (!this._documents.has(doc)) {
      this._changes.push(change);
      return;
    }
    this._s.foreignChanges += 1;
  }

  /** A record queued for each observer interested in it: one watching the
   *  target, or an ancestor with `subtree`, for what it asked to see — with
   *  the old value only where it asked for that (DOM 4.3.2). */
  private _queue(target: AnyNode, record: Mutation): void {
    const interested = new Map<Observer, string | null>();
    for (let at: AnyNode | null = target; at; at = at.parent) {
      for (const observer of this._observers.values()) {
        const options = observer.on.get(at);
        if (!options || (at !== target && !options.subtree)) continue;
        if (record.type === 'attributes') {
          if (!options.attributes) continue;
          const filter = options.attributeFilter;
          if (filter && !filter.includes(record.attributeName!)) continue;
        } else if (record.type === 'characterData') {
          if (!options.characterData) continue;
        } else if (!options.childList) continue;
        const old =
          (record.type === 'attributes' && options.attributeOldValue) ||
          (record.type === 'characterData' && options.characterDataOldValue);
        if (old) interested.set(observer, record.oldValue);
        else if (!interested.has(observer)) interested.set(observer, null);
      }
    }
    for (const [observer, oldValue] of interested) {
      observer.queue.push({ ...record, oldValue });
    }
  }

  /** A `<style>`'s rules as CSSOM has them: read from its text the first
   *  time they are asked for, and kept as the page edits them. */
  private _sheetOf(el: Element): SheetState {
    let state = this._sheets.get(el);
    if (!state) {
      state = {
        rules: cssRulesOf(DomUtils.textContent(el)),
        version: (this._s.sheetVersion += 1),
      };
      this._sheets.set(el, state);
    }
    return state;
  }

  /** A page set a `<style>`'s text: its sheet is that text's now, and the
   *  rules it inserted before are gone, as CSSOM has them. */
  private _sheetText(node: AnyNode): void {
    if (!(node instanceof Element) || !this._sheets.has(node)) return;
    this._sheets.delete(node);
    this._sheetsChanged.delete(node);
  }

  /**
   * The rules a page inserted into a `<style>` or deleted from it, written
   * as the element's text, so that `<Html>`, which reads a sheet from its
   * text, draws them. A browser leaves the text as it was; here a page
   * that reads it back after an edit reads the rules, which is what keeps
   * the edit, and no observer is told, since a sheet's edit is no change
   * to the tree. Once a flush, so a library that inserts a rule at a time
   * — styled-components, emotion — writes the text once a task.
   */
  private _writeSheets(): void {
    for (const el of this._sheetsChanged) {
      const state = this._sheets.get(el);
      if (!state) continue;
      const removed = el.children.slice();
      for (const kid of removed) DomUtils.removeElement(kid);
      const written = new Text(state.rules.join('\n'));
      DomUtils.appendChild(el, written);
      this._tell(el, {
        type: 'childList',
        target: el,
        addedNodes: [written],
        removedNodes: removed,
      });
    }
    this._sheetsChanged.clear();
  }

  // --- frames ---------------------------------------------------------------
  //
  // An `<iframe>` holds a document of its own, which a page reads and
  // writes and asks styles of, and which nothing here draws: it starts as
  // `about:blank`'s, and where its `src` is the page's own origin it is
  // loaded through the browser's network as it goes into the document —
  // HTML parsed, text in a `<pre>`, an image in an `<img>`, as a browser
  // shows them — and the frame hears `load`. Another origin's is never
  // read: its frame has no `contentDocument`, as a browser keeps it from
  // the page, and hears `load` all the same. Acid3's tests make their
  // documents in its `selectors` frame.

  /**
   * A frame sent to an address, which its `src` does not say until it
   * changes: by its window's `location`, or by a link or a form whose
   * target names it (`navigableFor`), with the form's POST where it posts.
   * A frame of another origin is sent there and nothing of it is loaded, as
   * no frame of another origin's is here, so a tracking pixel's POST into a
   * hidden frame is never sent.
   */
  navigateFrame(frame: Element, url: string, post: FramePost | null): void {
    if (!this._inDocument(frame)) return;
    this._frameDocument(frame);
    this._frameSent.set(frame, url === 'about:blank' ? null : url);
    this._loadFrame(frame, true, post);
  }

  /** A frame's document, made where it has none: null where it is another
   *  origin's, which the page may not read. */
  private _frameDocument(frame: Element): Document | null {
    let doc = this._frames.get(frame);
    if (!doc) {
      // `about:blank`'s, until what it loads is in
      doc = this._blankFrame(frame);
      this._loadFrame(frame);
    }
    return this._sameOrigin(this._frameAt.get(frame)!) ? doc : null;
  }

  /** A frame given a new `about:blank` document: its first, or where it
   *  is sent to that address. */
  private _blankFrame(frame: Element): Document {
    const doc = this._documentOf('');
    this._frames.set(frame, doc);
    this._frameOf.set(doc, frame);
    this._frameAt.set(frame, 'about:blank');
    this._s.frameList.add(frame);
    this._s.framesChanged();
    return doc;
  }

  /** Whether an address is the page's own origin's: `about:blank` is the
   *  origin of the document that made it (HTML 7.1.1). */
  private _sameOrigin(url: string): boolean {
    return url === 'about:blank' || originOf(url) === this._origin();
  }

  /** The address a frame loads — where its window sent it, else its `src`
   *  — or null for `about:blank`. A `javascript:` one is `about:blank`
   *  too, whose script is not run: core-js's and Tealium's frames are
   *  `javascript:` ones, for a blank document of the page's origin. */
  private _frameSrc(frame: Element): string | null {
    if (this._frameSent.has(frame)) return this._frameSent.get(frame)!;
    const raw = (
      (frame.name === 'object' ? frame.attribs.data : frame.attribs.src) ?? ''
    ).trim();
    if (!raw || raw === 'about:blank' || /^javascript:/i.test(raw)) {
      return null;
    }
    return this._resolve(raw);
  }

  /**
   * A frame navigated to what its `src` names: fetched, made a document of
   * its own — HTML parsed, XML parsed as XML (an SVG drawing, XHTML), an
   * image in an `<img>`, text in a `<pre>`, as a browser shows each — its
   * scripts run, and its `load` told. A navigation is a new document, put
   * in the frame once it is in; one the frame has gone on from by then is
   * dropped. One to `about:blank` is a new blank document, where it is a
   * navigation and not the frame's first document (`navigated`), and one
   * to another origin is there at once, since nothing of it is loaded.
   */
  private _loadFrame(
    frame: Element,
    navigated = false,
    post: FramePost | null = null,
  ): void {
    const serial = (this._frameLoads.get(frame) ?? 0) + 1;
    this._frameLoads.set(frame, serial);
    this._framesLoading.add(frame);
    const loaded = (): void => {
      if (this._disposed || !this.entries) return;
      if (this._frameLoads.get(frame) !== serial) return;
      this.entries.call('__fire', [this.idOf(frame), 'load']);
      this._frameDone(frame);
    };
    let src = this._frameSrc(frame);
    // a frame is never its own document's address again, which would hold
    // the page in itself without end (HTML 7.8.1, the iframe's "process the
    // iframe attributes", an ancestor's URL)
    if (src && src.split('#')[0] === this.url.split('#')[0]) src = null;
    // another origin's frame is loaded where the browser draws frames, to
    // run in a realm of its own, at its own origin, which reaches this one
    // as one window of another origin reaches another; elsewhere nothing of
    // it is
    const foreign = !!src && !this._sameOrigin(src);
    if (
      !src ||
      (foreign && !(this._seams.drawsFrames && /^https?:/i.test(src)))
    ) {
      if (src) this._frameAt.set(frame, src);
      else if (navigated) this._blankFrame(frame);
      setTimeout(loaded, 0);
      return;
    }
    this._seams
      .fetch(
        post
          ? {
              url: src,
              method: 'POST',
              headers: [['content-type', post.contentType]],
              body: post.body,
            }
          : { url: src, method: 'GET', headers: [], body: null },
        new AbortController().signal,
      )
      .then((response) => {
        if (this._disposed || this._frameLoads.get(frame) !== serial) return;
        const type = (headerOf(response.headers, 'content-type') ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        let doc: Document;
        let scripts = true;
        if (type === 'text/html') {
          doc = this._documentOf(
            response.body,
            true,
            !!this._seams.drawsFrames,
          );
        } else if (XML_TYPES.test(type)) {
          const xml = this._xmlTree(response.body);
          // one that is not well-formed is the error and nothing of it, as
          // Firefox shows it: Acid3's test 70 looks for what came after a
          // byte UTF-8 has no character for
          const kids = xml.wellFormed ? xml.kids : [parserError()];
          doc = new Document(kids);
          for (const kid of kids) kid.parent = doc;
          this._documents.add(doc);
          this._xml.set(doc, type);
          // a document that is not well-formed runs none of its scripts
          scripts = xml.wellFormed;
        } else {
          doc = this._documentOf(
            type.startsWith('image/')
              ? `<img src="${escapeAttribute(response.url || src)}">`
              : `<pre>${escapeText(response.body)}</pre>`,
            true,
          );
          scripts = false;
        }
        // another origin's scripts never run in this realm
        if (foreign) scripts = false;
        // a frame the browser draws runs its own scripts, and tells its own
        // `load` once they have, in a realm of its own — where it has any:
        // a document with none has no code to want globals of its own, and
        // the page's realm reaches into it at once, as Acid3's do into
        // theirs, where a realm would answer once React had mounted it
        const realm =
          !!this._seams.drawsFrames && type === 'text/html' && hasScripts(doc);
        if (realm) this._s.realms.add(doc);
        this._frames.set(frame, doc);
        this._frameOf.set(doc, frame);
        this._frameAt.set(frame, response.url || src);
        this._s.frameList.add(frame);
        this._s.framesChanged();
        if (realm) return;
        if (scripts) this._frameScripts(doc, response.url || src);
        loaded();
      })
      .catch((error: unknown) => {
        // a frame whose document could not be had still hears `load`, as
        // a browser's showing its error page does
        this._seams.log(
          'error',
          `The frame's ${src} could not be loaded: ${String((error as Error)?.message ?? error)}`,
        );
        loaded();
      });
  }

  /**
   * A frame's scripts, in tree order: the inline ones of HTML's (or of
   * XHTML's, in an XML document), run in the page's realm with the frame's
   * window and document for their globals (`__frameScript`). A frame here
   * has no realm of its own, so what one declares is its function's and not
   * a window's — enough for a frame that tells its parent it loaded, which
   * is what Acid3's XHTML frames do, and short of a page that builds an
   * application in one.
   */
  private _frameScripts(doc: Document, url: string): void {
    const xml = this._xml.has(doc);
    const scripts = DomUtils.findAll(
      (el) =>
        el.name === 'script' &&
        (xml ? el.namespace === HTML_NAMESPACE : !el.namespace) &&
        !el.attribs.src &&
        JS_TYPES.test(el.attribs.type ?? ''),
      doc.children,
    );
    for (const script of scripts) {
      if (this._disposed || !this.entries) return;
      this.entries.call('__frameScript', [
        this.idOf(doc),
        DomUtils.textContent(script),
        url,
      ]);
    }
  }

  /**
   * XML parsed into nodes, each element in the namespace its `xmlns`
   * attributes put it in (Namespaces in XML 1.0, 6), and whether it was
   * well-formed: every end tag the one open, every element closed, one
   * root, no character a decoder had to replace. htmlparser2 reads XML
   * leniently, and a document that is not well-formed must run nothing —
   * Acid3's second XHTML frame has a stray `</strong>`.
   */
  private _xmlTree(text: string): { kids: ChildNode[]; wellFormed: boolean } {
    const handler = new DomHandler(null, {
      withStartIndices: false,
      withEndIndices: false,
    });
    let wellFormed = !text.includes('\ufffd');
    const parser = new (class extends Parser {
      override onclosetag(start: number, endIndex: number): void {
        const self = this as unknown as XmlParserInternals;
        if (self.stack[0] !== self.getSlice(start, endIndex)) {
          wellFormed = false;
        }
        super.onclosetag(start, endIndex);
      }
    })(handler, { xmlMode: true, decodeEntities: true });
    parser.write(text);
    if ((parser as unknown as XmlParserInternals).stack.length) {
      wellFormed = false;
    }
    parser.end();
    const kids = handler.root.children.slice();
    for (const kid of kids) kid.parent = null;
    const roots = kids.filter((k) => k instanceof Element);
    if (
      roots.length !== 1 ||
      kids.some((k) => k instanceof Text && /[^ \t\n\r]/.test(k.data))
    ) {
      wellFormed = false;
    }
    const resolve = (el: Element, scope: Map<string, string>): void => {
      let own = scope;
      for (const [name, value] of Object.entries(el.attribs)) {
        if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
        if (own === scope) own = new Map(scope);
        own.set(name === 'xmlns' ? '' : name.slice(6), value);
      }
      const colon = el.name.indexOf(':');
      el.namespace = own.get(colon < 0 ? '' : el.name.slice(0, colon)) ?? '';
      for (const kid of el.children) {
        if (kid instanceof Element) resolve(kid, own);
      }
    };
    for (const root of roots) resolve(root as Element, new Map());
    return { kids, wellFormed };
  }

  /** A document's content made again of markup, by the parser `<Html>`
   *  reads a document with, the document itself kept: `document.open`,
   *  `write` and `close`'s. */
  private _fill(doc: Document, markup: string): void {
    this._replaceAll(doc, this._htmlTree(markup));
  }

  /** Markup read as a document is, by the parser `<Html>` reads one with,
   *  and made a document's tree; its scripts never run where it goes. */
  private _htmlTree(markup: string, live = false): ChildNode[] {
    const source = new HtmlSource();
    source.setSource(markup, true);
    const kids = source.document.children.slice();
    for (const kid of kids) DomUtils.removeElement(kid);
    // a frame's document the browser runs keeps its scripts, which its own
    // realm runs as its parser met them
    if (!live) {
      for (const el of DomUtils.findAll((e) => e.name === 'script', kids)) {
        this.inert.add(el);
      }
    }
    return documentTree(kids);
  }

  /** The frames in what went into the document, each given its document
   *  — and so loaded — as a browser loads a frame as it is put in. */
  private _framesIn(nodes: readonly AnyNode[]): void {
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      const frames = DomUtils.findAll((el) => FRAME_TAGS.has(el.name), [node]);
      if (FRAME_TAGS.has(node.name)) frames.unshift(node);
      for (const frame of frames) {
        if (frame.name === 'object' && !frame.attribs.data) continue;
        if (!this._frames.has(frame) && this._inDocument(frame)) {
          this._frameDocument(frame);
        }
      }
    }
  }

  /** Whether a node is in the document drawn, or in a shadow tree that is:
   *  Contentsquare keeps its frame in a closed one. */
  private _inDocument(node: AnyNode): boolean {
    return shadowIncludingRoot(node) === this.document;
  }

  /**
   * An element's computed style in a frame's document, which nothing here
   * draws: worked out by `<Html>`'s cascade from the user agent's sheet and
   * the document's own `<style>`s, at the frame's size, and read as
   * `getComputedStyle` reads the document's. The cascade is kept while
   * the sheets read the same — Acid3's selector tests add a rule and ask
   * at once. Null for a node in no frame's document.
   */
  private _frameStyle(
    el: Element,
    pseudo: 'before' | 'after' | null,
  ): Record<string, string> | null {
    const style = this._frameComputed(el, pseudo);
    return style ? cssomStyle(style, 1, null) : null;
  }

  /** `_frameStyle`, as the cascade computed it. */
  private _frameComputed(
    el: Element,
    pseudo: 'before' | 'after' | null,
  ): ComputedStyle | null {
    let top: AnyNode = el;
    while (top.parent) top = top.parent;
    const doc = top as Document;
    if (!this._frameOf.has(doc)) return null;
    const styles = DomUtils.findAll((e) => e.name === 'style', doc.children);
    const texts = styles.map((s) => DomUtils.textContent(s));
    // its viewport is the frame's content box, where the frame is drawn:
    // Acid3's media queries ask a frame of 0 by 0, then of 100 by 100
    const size = this._frameSize(doc);
    const key = `${size.width}x${size.height}\u0000${texts.join('\u0000')}`;
    let kept = this._frameStyles.get(doc);
    if (!kept || kept.key !== key) {
      const sheets: Stylesheet[] = [uaStylesheet(FRAME_LOOK)];
      const layers = new Map<string, number>();
      let order = 0;
      for (const text of texts) {
        const sheet = parseStylesheet(text, 0, layers);
        for (const rule of sheet.rules) rule.order = order++;
        order += 1;
        sheets.push(sheet);
      }
      const cascade = new Cascade(sheets, FRAME_LOOK, size.width, size.height);
      kept = { key, cascade };
      this._frameStyles.set(doc, kept);
    }
    const { cascade } = kept;
    // what css-select kept of a tree is good while no tree changed
    if (this._foreignSeen !== this._s.foreignChanges) {
      this._foreignSeen = this._s.foreignChanges;
      treesChanged();
    }
    const styleOf = (e: Element): ComputedStyle =>
      cascade.styleFor(
        e,
        e.parent instanceof Element ? styleOf(e.parent) : cascade.initial,
        false,
      );
    const style = styleOf(el);
    return pseudo ? cascade.pseudoStyleFor(el, pseudo, style) : style;
  }

  /** The size of a frame's viewport: its element's content box in the
   *  document drawn, and HTML's default where it is in none. */
  private _frameSize(doc: Document): { width: number; height: number } {
    const frame = this._frameOf.get(doc);
    if (!frame || !this._inDocument(frame)) return FRAME_SIZE;
    this.flush();
    const rect = this._seams.handle.elementRect(frame);
    const style = this._seams.handle.computedStyle(frame, null);
    if (!rect || !style) return FRAME_SIZE;
    const px = (...names: string[]): number =>
      names.reduce(
        (sum, name) => sum + (parseFloat(style[name] ?? '') || 0),
        0,
      );
    return {
      width: Math.max(
        0,
        rect.width -
          px(
            'border-left-width',
            'border-right-width',
            'padding-left',
            'padding-right',
          ),
      ),
      height: Math.max(
        0,
        rect.height -
          px(
            'border-top-width',
            'border-bottom-width',
            'padding-top',
            'padding-bottom',
          ),
      ),
    };
  }

  /** A document of its own made of markup, as `DOMParser` and
   *  `createHTMLDocument` make one: with an `<html>`, a `<head>` and a
   *  `<body>` where the markup has none, as HTML's parser makes them, and
   *  none of its scripts ever run — but a frame's the browser runs in a
   *  realm of its own (`live`). */
  private _documentOf(
    markup: string,
    document = false,
    live = false,
  ): Document {
    // what a frame loads is a document's markup, and `DOMParser`'s is read
    // as a fragment is, attaching no shadow root a template declares
    const tree = document
      ? this._htmlTree(markup, live)
      : documentTree(this._parse(markup));
    const doc = new Document([]);
    for (const kid of tree) DomUtils.appendChild(doc, kid);
    this._documents.add(doc);
    return doc;
  }

  /**
   * Markup parsed as HTML's fragment parsing parses it in `context` (HTML
   * 13.4): inside a `<script>`, a `<style>` and the other raw text elements
   * it is their text, whatever it holds, and inside a `<textarea>` or a
   * `<title>` their text with its character references read; anywhere
   * else, nodes. `next/script` sets an inline script's source as its
   * `innerHTML`, and yahoo.com's had `s<e` in it, which parsed as markup
   * cut the script off at a tag.
   */
  private _parseIn(
    context: AnyNode | null,
    markup: string,
    declarative = false,
  ): ChildNode[] {
    const name = context instanceof Element ? context.name : '';
    if (RAW_TEXT.has(name)) return markup ? [new Text(markup)] : [];
    if (name === 'textarea' || name === 'title') {
      const held = parseFragment(`<${name}>${markup}</${name}>`).find(
        (k) => k instanceof Element && k.name === name,
      );
      const data = held ? DomUtils.textContent(held) : '';
      return data ? [new Text(data)] : [];
    }
    return this._parse(markup, declarative);
  }

  /** Markup as `innerHTML` reads it, or `setHTMLUnsafe` with its
   *  declarative shadow roots; its scripts never run. */
  private _parse(html: string, declarative = false): ChildNode[] {
    const kids = parseFragment(html, declarative);
    for (const el of DomUtils.findAll((e) => e.name === 'script', kids)) {
      this.inert.add(el);
    }
    for (const kid of kids) {
      if (kid instanceof Element && kid.name === 'script') this.inert.add(kid);
    }
    return kids;
  }

  private _declarations(el: Element) {
    const style = el.attribs.style;
    return style ? parseDeclarations(style) : [];
  }

  private _resolve(url: string): string {
    try {
      return new URL(url, this._seams.handle.base ?? this.url).href;
    } catch {
      return url;
    }
  }

  private _origin(): string {
    try {
      return new URL(this.url).origin;
    } catch {
      return 'null';
    }
  }

  private _storage(
    kind: string,
    op: string,
    key: string,
    value: string,
  ): Primitive {
    const all = kind === 'session' ? STORAGE.session : STORAGE.local;
    const origin = this._origin();
    let store = all.get(origin);
    if (!store) all.set(origin, (store = new Map()));
    switch (op) {
      case 'get':
        return store.get(key) ?? null;
      case 'set':
        store.set(key, value);
        return null;
      case 'remove':
        store.delete(key);
        return null;
      case 'clear':
        store.clear();
        return null;
      case 'keys':
        return [...store.keys()].join('\u0000');
      default:
        return null;
    }
  }

  /** A page's `fetch`: its own origin's, or another's where CORS lets it
   *  (`_fetchFor`), and its answer handed back through `__fetched`. */
  private _fetch(id: number, json: string): void {
    const answer = (value: FetchResponse | string) => {
      if (!this._fetches.has(id) || this._disposed) {
        if (typeof value !== 'string') release(value);
        return;
      }
      // a body that arrives a chunk at a time is handed on so, after the
      // headers: the page's promise is settled by them, as a browser's is
      if (typeof value !== 'string' && value.chunks) {
        const { bytes: _none, chunks, ...rest } = value;
        // kept before the page hears of it, which may abort it at once
        const iterator = chunks[Symbol.asyncIterator]();
        this._bodies.set(id, iterator);
        this.entries?.call('__fetched', [
          id,
          { ...rest, body: '', streaming: true },
        ]);
        void this._pump(id, iterator);
        return;
      }
      this._fetches.delete(id);
      // what crosses is primitives: the bytes as base64, where there are
      // bytes, and the decoded text where there are none
      let crossing: unknown = value;
      if (typeof value !== 'string') {
        const { bytes, ...rest } = value;
        crossing = bytes
          ? { ...rest, body: '', base64: base64Of(bytes) }
          : rest;
      }
      this.entries?.call('__fetched', [id, crossing]);
    };
    let request: PageRequest;
    try {
      const raw = JSON.parse(json) as Partial<PageRequest>;
      request = {
        url: this._resolve(String(raw.url ?? '')),
        method: String(raw.method ?? 'GET').toUpperCase(),
        // what a page may not set, which a browser drops (Fetch 2.2.2)
        headers: Array.isArray(raw.headers)
          ? raw.headers
              .map(([k, v]) => [String(k), String(v)] as [string, string])
              .filter(([k]) => !forbiddenRequestHeader(k))
          : [],
        body: typeof raw.body === 'string' ? raw.body : null,
        ...(raw.stream === true ? { stream: true } : {}),
        ...(typeof (raw as { base64?: unknown }).base64 === 'string'
          ? {
              bytes: new Uint8Array(
                Buffer.from((raw as { base64: string }).base64, 'base64'),
              ),
            }
          : {}),
        mode:
          raw.mode === 'no-cors' || raw.mode === 'same-origin'
            ? raw.mode
            : 'cors',
        credentials:
          raw.credentials === 'omit' || raw.credentials === 'include'
            ? raw.credentials
            : 'same-origin',
      };
    } catch {
      return;
    }
    const controller = new AbortController();
    this._fetches.set(id, controller);
    this._fetchFor(request, controller.signal).then(answer, (error) => {
      if (error instanceof CorsError) {
        this._seams.log(
          'error',
          `Access to fetch at '${request.url}' from origin '${this._origin()}' has been blocked by CORS policy: ${error.message}`,
        );
      }
      answer(
        error instanceof CorsError || !(error instanceof TypeError)
          ? 'Failed to fetch'
          : error.message,
      );
    });
  }

  /** A body handed on a chunk at a time (`__fetchChunk`) until it ends
   *  (`__fetchEnd`), or until the page lets it go (`abortFetch`). */
  private async _pump(
    id: number,
    iterator: AsyncIterator<Uint8Array>,
  ): Promise<void> {
    if (!this._fetches.has(id) || this._disposed) return;
    let failed: string | null = null;
    try {
      for (;;) {
        const { done, value } = await iterator.next();
        if (done) break;
        if (!this._fetches.has(id) || this._disposed) return;
        if (value.length) {
          this.entries?.call('__fetchChunk', [id, base64Of(value)]);
        }
      }
    } catch {
      failed = 'network error';
    } finally {
      if (this._bodies.get(id) === iterator) this._bodies.delete(id);
    }
    if (!this._fetches.delete(id) || this._disposed) return;
    this.entries?.call('__fetchEnd', [id, failed]);
  }

  /** What CORS remembers of the preflights this page made. */
  private _preflights = new Map<string, PreflightEntry>();

  /**
   * A page's request through the browser's network, under the same-origin
   * policy and CORS (Fetch 4.1, "main fetch"). The page's own origin is
   * answered whole, and so is another that says the page may read it —
   * `Access-Control-Allow-Origin` — where a request that is not a simple
   * one has asked it first with a preflight. ekazinich.com's chat posts
   * JSON to api.ekazinich.com, which is such a request. A `no-cors`
   * request is sent and its answer is opaque; a `same-origin` one goes
   * nowhere else. What is refused is a `CorsError`, reported in the page
   * as a browser reports it.
   */
  private async _fetchFor(
    request: PageRequest,
    signal: AbortSignalLike,
  ): Promise<FetchResponse> {
    const page = this._origin();
    let target: string;
    try {
      target = new URL(request.url).origin;
    } catch {
      throw new TypeError('Failed to fetch');
    }
    const own = target === page && page !== 'null';
    const plain: FetchRequest = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(request.bytes ? { bytes: request.bytes } : {}),
      ...(request.stream ? { stream: true } : {}),
    };
    if (own) {
      const response = await this._seams.fetch(plain, signal);
      // a redirect to another origin is that origin's to let the page read
      if (originOf(response.url) === page) {
        return {
          ...response,
          headers: readable(response.headers),
          type: 'basic',
        };
      }
      if (request.mode === 'same-origin') {
        release(response);
        throw new CorsError('The request was redirected to another origin.');
      }
      return this._shared(response, request, page);
    }
    if (request.mode === 'same-origin') {
      throw new TypeError(
        `Fetch API cannot load ${request.url}. Request mode is "same-origin" but the URL's origin is not same as the request origin ${page}.`,
      );
    }
    if (request.mode === 'no-cors') {
      if (
        !SIMPLE_METHODS.has(request.method) ||
        !request.headers.every(([k, v]) => noCorsSafelisted(k, v))
      ) {
        throw new TypeError(
          `'${request.method}' or a header is not allowed in 'no-cors' mode.`,
        );
      }
      release(await this._seams.fetch(plain, signal));
      return {
        url: '',
        status: 0,
        statusText: '',
        redirected: false,
        headers: [],
        body: '',
        type: 'opaque',
      };
    }
    const unsafe = unsafeRequestHeaders(request.headers);
    if (!SIMPLE_METHODS.has(request.method) || unsafe.length) {
      await this._preflight(request, unsafe, page, signal);
    }
    return this._shared(await this._seams.fetch(plain, signal), request, page);
  }

  /** Another origin's answer, where it lets the page read it (Fetch 4.10,
   *  "CORS check"): with only the headers it lets the page read. */
  private _shared(
    response: FetchResponse,
    request: PageRequest,
    page: string,
  ): FetchResponse {
    try {
      corsCheck(response.headers, request.credentials, page);
    } catch (error) {
      release(response);
      throw error;
    }
    const include = request.credentials === 'include';
    const exposed = listOf(
      headerOf(response.headers, 'access-control-expose-headers'),
    );
    const all = exposed.has('*') && !include;
    return {
      ...response,
      headers: readable(response.headers).filter(
        ([k]) =>
          all ||
          SAFELISTED_RESPONSE.has(k.toLowerCase()) ||
          exposed.has(k.toLowerCase()),
      ),
      type: 'cors',
    };
  }

  /** Ask another origin whether a request that is not a simple one may be
   *  made (Fetch 4.9, "CORS-preflight fetch"), unless it said so lately. */
  private async _preflight(
    request: PageRequest,
    unsafe: string[],
    page: string,
    signal: AbortSignalLike,
  ): Promise<void> {
    const include = request.credentials === 'include';
    const key = `${request.url}\u0000${include}`;
    const kept = this._preflights.get(key);
    const allows = (entry: PreflightEntry): string | null => {
      if (
        !SIMPLE_METHODS.has(request.method) &&
        !entry.methods.has(request.method) &&
        !(entry.anyMethod && !include)
      ) {
        return `Method ${request.method} is not allowed by Access-Control-Allow-Methods in preflight response.`;
      }
      for (const name of unsafe) {
        if (entry.headers.has(name)) continue;
        if (entry.anyHeader && !include && name !== 'authorization') continue;
        return `Request header field ${name} is not allowed by Access-Control-Allow-Headers in preflight response.`;
      }
      return null;
    };
    if (kept && kept.until > Date.now() && allows(kept) === null) return;
    const headers: [string, string][] = [
      ['access-control-request-method', request.method],
    ];
    if (unsafe.length) {
      headers.push(['access-control-request-headers', unsafe.join(',')]);
    }
    const response = await this._seams.fetch(
      { url: request.url, method: 'OPTIONS', headers, body: null },
      signal,
    );
    const failed = (why: string) =>
      new CorsError(
        `Response to preflight request doesn't pass access control check: ${why}`,
      );
    if (response.redirected)
      throw failed('Redirect is not allowed for a preflight request.');
    try {
      corsCheck(response.headers, request.credentials, page);
    } catch (error) {
      throw failed((error as Error).message);
    }
    if (response.status < 200 || response.status > 299) {
      throw failed('It does not have HTTP ok status.');
    }
    const methods = listOf(
      headerOf(response.headers, 'access-control-allow-methods'),
      false,
    );
    const allowed = listOf(
      headerOf(response.headers, 'access-control-allow-headers'),
    );
    const age = Number(
      headerOf(response.headers, 'access-control-max-age') ?? 5,
    );
    const entry: PreflightEntry = {
      until:
        Date.now() +
        Math.min(Number.isFinite(age) ? Math.max(0, age) : 5, 7200) * 1000,
      methods,
      headers: allowed,
      anyMethod: methods.has('*'),
      anyHeader: allowed.has('*'),
    };
    const refused = allows(entry);
    if (refused) throw new CorsError(refused);
    this._preflights.set(key, entry);
  }

  /** `compareDocumentPosition` (DOM 4.4), by the two nodes' paths. */
  private _position(a: AnyNode, b: AnyNode): number {
    if (a === b) return 0;
    const path = (n: AnyNode): AnyNode[] => {
      const out: AnyNode[] = [];
      for (let at: AnyNode | null = n; at; at = at.parent) out.unshift(at);
      return out;
    };
    const pa = path(a);
    const pb = path(b);
    if (pa[0] !== pb[0]) return 1 | 32 | 2;
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i += 1;
    if (i === pa.length) return 16 | 4; // b is inside a
    if (i === pb.length) return 8 | 2; // a is inside b
    const parent = pa[i - 1] as ParentNode;
    return parent.children.indexOf(pb[i] as ChildNode) >
      parent.children.indexOf(pa[i] as ChildNode)
      ? 4
      : 2;
  }
}

/** A URL's parts, as JSON, or '' where it is none. */
function urlJson(href: string, base: string): string {
  try {
    const u = base ? new URL(href, base) : new URL(href);
    return JSON.stringify({
      href: u.href,
      protocol: u.protocol,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      origin: u.origin,
      username: u.username,
      password: u.password,
    });
  } catch {
    return '';
  }
}

/** A length in a unit that reads an element — its font, its line, the
 *  viewport, its container — which no initial value may hold, since it is
 *  every element's alike (CSS Properties and Values 1, 2.5). */
const RELATIVE_LENGTH =
  /\d(?:em|rem|ex|rex|cap|rcap|ch|rch|ic|ric|lh|rlh|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))\b/i;
