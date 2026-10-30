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
// the browser's network; storage is its origin's, where the host's
// `storage` keeps it — memory, gone with the process, unless the host keeps
// a profile; a cookie is what the host's jar lets the document's address
// have; a navigation is a link the browser follows.
import * as DomUtils from 'domutils';
import { Parser } from 'htmlparser2';
import { compile, selectAll, selectOne } from 'css-select';
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

import type {
  HighlightPseudo,
  HtmlChange,
  HtmlDomEvent,
  HtmlHandle,
} from '../index.js';
import type {
  CssAnimationInfo,
  CssTransitionInfo,
  CssEventInfo,
  ElementIntersections,
  ScriptRequest,
} from '../node.js';
import type { MarginLength } from '../paint.js';
import type { MediaEventKind } from '../media.js';
import { attachShadow, parseFragment, shadowRootOf } from '../index.js';
import {
  HtmlSource,
  ShadowRoot,
  indicatedElement,
  isCustomized,
  assignedSlot,
  isDefinedElement,
  inActiveTransition,
  isModal,
  setActiveTransition,
  isDropDown,
  isPickerOpen,
  isPopoverOpen,
  isMuted,
  hasMediaFlag,
  isPaused,
  setMuted,
  setFullscreen,
  isFullscreen,
  setMediaFlag,
  setPaused,
  markCustomized,
  markParsedRegistry,
  parsedNullRegistries,
  parsedWithNullRegistry,
  setModal,
  setPopoverOpen,
  shadowRootAround,
  topLayerIn,
  topLayerOf,
  treeGeneration,
  treesChanged,
  isClassicScriptType,
} from '../dom.js';
import {
  canonicalHighlights,
  composeShorthand,
  expandShorthand,
  highlightSelectorValid,
  specifiedValue,
  transitionSelectorValid,
  withoutHighlights,
} from '../css/specified.js';
import { Cascade, highlightKey } from '../css/cascade.js';
import type { HighlightPseudoStyle } from '../css/cascade.js';
import { uaStylesheet } from '../css/ua.js';
import { cssomStyle } from '../computed.js';
import { fontQuery } from '../css/style.js';
import type { ComputedStyle, FontQuery, RootLook } from '../css/style.js';
import type { DocumentFontFace, FontMatch } from '../fonts.js';
import type { Stylesheet } from '../css/parse.js';
import {
  mediaMatches,
  parseDeclarations,
  parseMediaQuery,
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
import { planSession, sessionView, writeSession } from './session.js';
import type { SessionArrival, SessionRecord } from './session.js';
import { withoutFragmentDirective } from '../text-fragments.js';
import { MEDIA_ENOUGH, MediaReader } from './media.js';
import { PageSources } from './media-sources.js';
import { PagePeers } from './peers.js';
import type { ChannelRelay } from './peers.js';
import { PageTransports } from './transports.js';
import { PageSockets } from './sockets.js';
import { parseCsp } from '../csp.js';
import type { CspPolicy } from '../csp.js';
import type { HtmlDocumentCookies } from '../cookies.js';
import { defaultStorage } from '../storage.js';
import type { HtmlStorage, HtmlStorageChange } from '../storage.js';
import type { HtmlMediaDevices } from '../media-devices.js';
import type { HtmlWebRTC } from '../rtc.js';
import type { HtmlWebTransport } from '../transport.js';
import type { HtmlWebSocket } from '../socket.js';
import * as ntk from 'react-x11/ntk';
import { decodeGif } from '../gif.js';
import { encodePng } from './png.js';
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
  /**
   * Whether the body was a page's `ReadableStream`, read to its end before
   * it was handed over: a body whose source is null (Fetch 2.2.5), which
   * a request sends once. A network that would send the request again does
   * not: a 421, which HTTP/2 retries on a new connection, is the page's
   * answer (Fetch, HTTP-network-or-cache fetch), and a redirect but a 303
   * is a network error (HTTP-redirect fetch). `HtmlNetwork` hands the
   * runtime's `fetch` such a body as a stream, which it sends once.
   */
  streamedBody?: boolean;
  /** Whether the caller takes the response's body as it arrives
   *  (`FetchResponse.chunks`), as a page's `fetch` does. A host may answer
   *  it whole all the same. */
  stream?: boolean;
  /** Whose cookies it carries (Fetch, a request's credentials mode): none,
   *  the page's own origin's alone, or any. Absent, `same-origin`, a
   *  page's `fetch`'s default. A host with no cookie jar sends none. */
  credentials?: 'omit' | 'same-origin' | 'include';
  /**
   * The document the request is made from, where it is not the one the
   * host's `fetch` serves: a frame's that runs its own scripts (Fetch, a
   * request's client). Its origin is the request's `Origin`, what
   * `same-origin` credentials are reckoned from and what a CORS answer is
   * held to, and its address the `Referer`. Absent, the page's.
   */
  client?: string;
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
  /** A shared worker's (HTML 10.2.6.4), whose global takes connections
   *  rather than messages of its own. */
  shared?: boolean;
  /** A service worker's (Service Workers 1), with the scope it was
   *  registered for and the address of the page that registered it, the
   *  one client it has. */
  service?: { scope: string; client: string };
}

/** Where a page's workers run (`workers.ts`): each started, posted to and
 *  ended by the number `start` answered. */
export interface PageWorkersLike {
  start(init: WorkerInit): number;
  post(id: number, data: string): void;
  end(id: number): void;
  /** Tells a worker's thread of a data channel the page handed it. */
  rtc?(id: number, message: ChannelRelay): void;
  /** Whether a worker has a connection open (`DomHost.connected`). */
  readonly connected?: boolean;
}

/** What a realm that is a worker's reaches its page by
 *  (`worker-thread.ts`). */
export interface WorkerScope {
  post(data: string): void;
  close(): void;
  /** A script's source, fetched before this returns, or null. */
  importScript(url: string): string | null;
  error(message: string, filename: string, line: number, column: number): void;
  /** Asks the page process of a data channel the page handed over. */
  rtc?(message: ChannelRelay): void;
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
  /** The document told an element has the focus before anything is there
   *  to take core's (`DocumentInteraction.told`). */
  toldFocus(element: Element): void;
  /** `document.write` from the script the parse waits at, into the input
   *  stream after it (`HtmlViewNode.parserWrite`): false where the parse
   *  waits at no such script. */
  parserWrite(script: Element, markup: string): boolean;
  /** The script the parse waits at has run, and the parse goes on
   *  (`HtmlViewNode.parserResume`). */
  parserResume(script: Element): void;
  /** What the parser put in the tree since this was last asked, once the
   *  page's scripts have begun to run (`HtmlViewNode.parserMade`). */
  parserMade(): readonly ChildNode[];
  /** The document styled and laid out as it stands now, and what that
   *  moves — a snap container re-snapped — done, for a page that reads
   *  where the viewport is scrolled (`HtmlViewNode.layoutNow`). */
  layoutNow(): void;
  /** A page's script was stopped inside an op, and what the document was
   *  in the middle of is made again (`HtmlViewNode.interrupted`). */
  interrupted(): void;
  /** The document's `@font-face` faces, as `document.fonts` lists them
   *  (`HtmlViewNode.fontFaces`). */
  fontFaces(): DocumentFontFace[];
  /** The faces a `font` matches, by key, as `document.fonts.load()` and
   *  `check()` find them (`HtmlViewNode.matchFonts`). */
  matchFonts(query: FontQuery, text: string): FontMatch;
  /** Load faces by key, settled with whether each loaded
   *  (`HtmlViewNode.loadFonts`). */
  loadFonts(keys: readonly string[]): Promise<boolean[]>;
  /** Settles once no face is on its way (`HtmlViewNode.fontsSettled`). */
  fontsSettled(): Promise<void>;
  /** The CSS animations under way on an element, or on what it holds as
   *  well, or in the whole document for null, as a page's
   *  `getAnimations()` lists them (`HtmlViewNode.cssAnimationsOf`). */
  cssAnimations(element: Element | null, subtree: boolean): CssAnimationInfo[];
  /** The CSS transitions under way, the same way
   *  (`HtmlViewNode.cssTransitionsOf`). */
  cssTransitions(
    element: Element | null,
    subtree: boolean,
  ): CssTransitionInfo[];
  /** A page set where a CSS transition is (`HtmlViewNode.seekTransition`). */
  seekTransition(key: number, currentTime: number): void;
  /** And a CSS animation, held there where the page paused it
   *  (`HtmlViewNode.seekAnimation`). */
  seekAnimation(key: number, currentTime: number, paused: boolean): void;
  /** And one on a scroll's timeline, held, run from a start time or
   *  aligned to its range (`HtmlViewNode.seekScrolled`). */
  seekScrolled(
    key: number,
    mode: 'align' | 'start' | 'hold',
    time: number | null,
    rate: number,
  ): void;
  /** What a view timeline's subject is along an axis, in CSS pixels: its
   *  scroll container's `scroll-padding` there, which an `auto` inset is,
   *  and how far sticky positioning has moved it and can each way
   *  (`HtmlViewNode.viewAdjustOf`). */
  viewAdjust(
    element: Element,
    vertical: boolean,
  ): {
    padStart: number;
    padEnd: number;
    shift: number;
    up: number;
    down: number;
  } | null;
  /** And one a page cancelled (`HtmlViewNode.cancelCss`). */
  cancelCss(kind: 'animation' | 'transition', key: number): void;
  /** A view transition's steps, as the page's realm runs them: its old
   *  state captured, its new captured and its tree drawn — each answering
   *  the name two elements share, which skips it, or '' — how long until
   *  its animations are over, and its end
   *  (`HtmlViewNode.transitionCaptureOld` and the rest). */
  /** A CSS animation's keyframes, as `getKeyframes()` lists them
   *  (`HtmlViewNode.cssKeyframesOf`). */
  cssKeyframes(
    element: Element,
    pseudo: string,
    name: string,
  ):
    | {
        offset: number;
        easing: string;
        composite: 'auto' | 'replace';
        values: Record<string, string>;
      }[]
    | null;
  transitionCaptureOld(): string;
  transitionCaptureNew(): string;
  transitionRemaining(): number | null;
  transitionEnd(): void;
  /** What a page's script changed of an `<img>`, or the one it made, is
   *  asked for and watched (`HtmlViewNode.askImage`). */
  askImage(element: Element): void;
  /** What a page reads of an `<img>`: `complete` and its kin
   *  (`HtmlViewNode.imageState`). */
  imageState(element: Element): {
    complete: boolean;
    available: boolean;
    width: number;
    height: number;
    src: string;
  };
  /** What the document's media queries are answered from, as a key that
   *  moves where an answer may (`HtmlViewNode.mediaEnvironment`). */
  mediaEnvironment(): string;
  /** Whether an element is drawn where the viewport is — fixed to it, or
   *  in a box that is — so that no scroll of the pane around the document
   *  moves it (`HtmlViewNode.atViewport`). */
  drawnAtViewport(element: Element): boolean;
  /** An element's padding box and its top and left borders, in CSS
   *  pixels, where it is no scroll container, as `clientWidth` and its
   *  kin read it; null where its box is none or inline
   *  (`HtmlViewNode.clientBoxOf`). */
  clientBox(
    element: Element,
  ): { width: number; height: number; top: number; left: number } | null;
  /** Whether an element is drawn, as `checkVisibility` asks, faded to
   *  nothing or invisible where `asks` says to look
   *  (`HtmlViewNode.checkVisibility`). */
  checkVisibility(
    element: Element,
    asks: { opacity: boolean; visibility: boolean },
  ): boolean;
  /** Whether a scroll container's scroll moves an element: not where the
   *  element, or a box between them, is positioned against something
   *  outside it (`HtmlViewNode.scrollMoves`). */
  scrollMoves(scroller: Element, element: Element): boolean;
  /** What the boxes were laid out and scrolled as, as a key that moves
   *  wherever a measurement of them may (`HtmlViewNode.geometryKey`). */
  geometryKey(): string;
  /** What an `IntersectionObserver` measures of its targets against its
   *  root, the viewport for null (`HtmlViewNode.intersectionsOf`). */
  intersectionsOf(
    elements: readonly (Element | null)[],
    root: Element | null,
    margin: readonly MarginLength[] | null,
  ): ElementIntersections | null;
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
  /** Where a script's scroll of the viewport comes to rest, where the
   *  root makes it a snap container, or with the element it brings into
   *  view lined up (`HtmlViewNode.snapViewport`). */
  snapViewport(
    x: number,
    y: number,
    target?: Element | null,
    relative?: boolean,
  ): { x: number; y: number };
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
  /** Where the page's selection is collapsed, the caret an edit is made
   *  at, which the document draws in an editing host that has the focus;
   *  null for none (`HtmlViewNode.setCaret`). */
  setCaret(point: { node: AnyNode; offset: number } | null): void;
  /** A boundary point moved by a character or a word through the text
   *  the document draws (`HtmlViewNode.movedPoint`). */
  movedPoint(
    node: AnyNode,
    offset: number,
    granularity: 'character' | 'word',
    back: boolean,
  ): { node: AnyNode; offset: number } | null;
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
  /** A page that is being left asked to be confirmed first (HTML 7.4.2.4,
   *  "prompt to unload"): whether to leave it. Absent, it is left. */
  promptToUnload?(): boolean;
  /** What the page writes to its console. */
  log(level: string, text: string): void;
  /** The document's title changed. */
  title(title: string | null): void;
  fetch(request: FetchRequest, signal: AbortSignalLike): Promise<FetchResponse>;
  userAgent: string;
  language: string;
  /** What a media element's `canPlayType` answers: whether what plays the
   *  page's media can play the type. None, `''` for every type. */
  canPlayType?(type: string): string;
  /** Whether `fetch` is a network the host was given: a media element
   *  fetches its source through it to know its duration and when it can
   *  play, and with none is ready as soon as it is asked. */
  network?: boolean;
  /** Whether a page may register service workers (`HtmlScripts`'
   *  `serviceWorkers`). */
  serviceWorkers?: boolean;
  /** What a page's `WebTransport` sessions are carried over (`HtmlScripts`'
   *  `webTransport`). Absent, every session fails, as with no network. */
  webTransport?: HtmlWebTransport;
  /** What a page's `WebSocket`s are carried over (`HtmlScripts`'
   *  `webSocket`). Absent, every socket fails, as with no network. */
  webSocket?: HtmlWebSocket;
  /** What a page's `RTCPeerConnection`s are carried over (`HtmlScripts`'
   *  `webRTC`). Absent, no stack: an operation that needs one rejects. */
  webRTC?: HtmlWebRTC;
  /** The page's cameras, microphones and screens (`HtmlScripts`'
   *  `mediaDevices`). Absent, there are none. */
  mediaDevices?: HtmlMediaDevices;
  /** The sheets the document adopted (`document.adoptedStyleSheets`),
   *  each its text, for `<Html>` to apply after the document's own. */
  adopt?(sheets: string[]): void;
  /** What `document.cookie` and `cookieStore` read and write (`HtmlScripts`'
   *  `cookies`). Absent, a document has no cookies. */
  cookies?: HtmlDocumentCookies;
  /** Where `localStorage`, `sessionStorage` and IndexedDB are kept
   *  (`HtmlScripts`' `storage`). Absent, the process's memory. */
  storage?: HtmlStorage;
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

/** The pseudo-elements the host answers a computed style for: a `::before`
 *  or an `::after`, and the highlights (`highlightKey`). */
type ComputedPseudo = 'before' | 'after' | HighlightPseudo | null;

/** What `computed` and `customProperty` are asked of, as the facade names
 *  it (`getComputedStyle`): any other name is the element's own. */
function computedPseudo(b: Primitive): ComputedPseudo {
  if (b === 'before' || b === 'after') return b;
  return typeof b === 'string' && highlightKey(b) !== null
    ? (b as HighlightPseudo)
    : null;
}

/** A selector that names the node a query is asked from (`_query`). */
const QUERY_SCOPED = /:scope(?![\w-])/i;

/** A selector whose matcher keeps answers for as long as it lives
 *  (css-select's `cacheResults`): a `:has()`, a `:contains()`. */
const KEEPS_ANSWERS = /:(?:has|i?contains)\(/i;

/** How many compiled queries a page keeps (`_query`). */
const KEPT_QUERIES = 1000;

/** The elements that hold a document of their own: a frame's. */
const FRAME_TAGS = new Set(['iframe', 'frame', 'object']);

/** What says which image an `<img>` shows, or how it is fetched (HTML
 *  4.8.4.3.8, "relevant mutations"): changing one loads its image again. */
const IMAGE_ATTRIBUTES = new Set([
  'src',
  'srcset',
  'sizes',
  'crossorigin',
  'referrerpolicy',
]);

/** Whether a node is an HTML `<img>`. */
function isImage(node: AnyNode): node is Element {
  return node instanceof Element && node.name === 'img' && !node.namespace;
}

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

/** Whether a node is a `<template>`, whose children are its content's
 *  and no part of the tree a page walks (HTML 4.12.3). */
function isTemplate(node: AnyNode): boolean {
  return node instanceof Element && node.name === 'template';
}

/**
 * The elements under `root` that pass `test`, in tree order — or the
 * first, for `one` — leaving out what a `<template>` holds, which is its
 * content's: `getElementById`, `getElementsByTagName` and a window's names
 * find none of it, as a browser's walk of the tree finds none.
 */
function elementsIn(
  root: ParentNode,
  test: (el: Element) => boolean,
  one = false,
): Element[] {
  const out: Element[] = [];
  if (isTemplate(root)) return out;
  const stack: AnyNode[] = [];
  for (let i = root.children.length - 1; i >= 0; i -= 1) {
    stack.push(root.children[i]);
  }
  while (stack.length) {
    const at = stack.pop()!;
    if (!(at instanceof Element)) continue;
    if (test(at)) {
      out.push(at);
      if (one) break;
    }
    if (at.name === 'template') continue;
    for (let i = at.children.length - 1; i >= 0; i -= 1) {
      stack.push(at.children[i]);
    }
  }
  return out;
}

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

/** A declaration block's declarations, from its text: an element's
 *  `style` attribute, or what a rule's braces hold. */
function declarationsIn(block: string | null | undefined) {
  return block ? parseDeclarations(block) : [];
}

/** What a block declares a property as, as `getPropertyValue` reads it: a
 *  shorthand it keeps as its longhands composed from them. */
function declarationValue(
  block: string | null | undefined,
  name: string,
): string {
  const decls = declarationsIn(block);
  const found = decls.filter((d) => d.prop === name).at(-1);
  if (found) return found.value;
  const composed = composeShorthand(
    name,
    (longhand) =>
      decls.filter((d) => d.prop === longhand).at(-1)?.value ?? null,
  );
  return composed ?? '';
}

/** `getPropertyPriority`: 'important' where the block's last declaration
 *  of the property is, '' otherwise. */
function declarationPriority(
  block: string | null | undefined,
  name: string,
): string {
  const found = declarationsIn(block)
    .filter((d) => d.prop === name)
    .at(-1);
  return found?.important ? 'important' : '';
}

/** The properties a block declares, in order, joined by commas. */
function declarationNames(block: string | null | undefined): string {
  return declarationsIn(block)
    .map((d) => d.prop)
    .join(',');
}

/** A block as CSSOM serializes it (`serializeDeclarations`). */
function declarationText(block: string | null | undefined): string {
  return serializeDeclarations(declarationsIn(block));
}

/**
 * A block with a property set as `setProperty` sets it (CSSOM 6.7), and
 * serialized: a value the property does not take leaves the block as it
 * was, which is null; one it does is kept in its canonical form, and a
 * shorthand it expands as its longhands. What the block declared of it is
 * replaced where it stood, as CSSOM's "set a CSS declaration" has it, and
 * a property it did not declare goes at the end. An empty value removes
 * the property.
 */
function withDeclaration(
  block: string | null | undefined,
  name: string,
  value: string,
  priority: Primitive,
): string | null {
  const raw = closeBrackets(value);
  const specified = raw && specifiedValue(name, raw);
  if (specified === null) return null;
  const longhands = raw && specified ? expandShorthand(name, specified) : null;
  const names = new Set([
    name,
    ...(expandShorthand(name, 'none') ?? []).map(([n]) => n),
  ]);
  const decls = declarationsIn(block);
  const at = decls.findIndex((x) => names.has(x.prop));
  const kept = decls.filter((x) => !names.has(x.prop));
  const important = priority === 'important';
  const set = longhands
    ? longhands.map(([prop, v]) => ({ prop, value: v, important }))
    : raw
      ? [{ prop: name, value: specified || raw, important }]
      : [];
  kept.splice(at < 0 ? kept.length : at, 0, ...set);
  return serializeDeclarations(kept);
}

/** An observer's margin as it serializes — four lengths, `px` or `%`,
 *  which the facade checked — or null where it grows nothing. */
function marginLengths(text: string): MarginLength[] | null {
  const lengths = text
    .split(' ')
    .filter(Boolean)
    .map((part) => ({
      value: parseFloat(part) || 0,
      percent: part.endsWith('%'),
    }));
  return lengths.length === 4 && lengths.some((m) => m.value !== 0)
    ? lengths
    : null;
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

/** How a fragment is serialized (HTML 8.5.2): an empty attribute's value
 *  written, `disabled=""`, as a browser writes it. */
const SERIALIZE = { emptyAttrs: true } as const;

/**
 * A copy of what a node holds, each shadow tree in it that `getHTML()`
 * writes put first in its host as the `<template shadowrootmode>` that
 * would make it again (HTML 8.5.2, "serializing HTML fragments"): one that
 * is serializable where `serializable`, and one `listed` either way.
 */
function withShadowTemplates(
  node: ParentNode,
  serializable: boolean,
  listed: ReadonlySet<AnyNode>,
  /** The shadow roots whose custom element registry is not their host
   *  document's, which the page's realm knows: written with
   *  `shadowrootcustomelementregistry`. */
  ownRegistry: ReadonlySet<AnyNode>,
): ParentNode {
  const shadowOf = (el: Element): ChildNode | null => {
    const root = shadowRootOf(el);
    if (!root || !((serializable && root.serializable) || listed.has(root))) {
      return null;
    }
    const attribs: Record<string, string> = { shadowrootmode: root.mode };
    if (root.delegatesFocus) attribs.shadowrootdelegatesfocus = '';
    if (root.serializable) attribs.shadowrootserializable = '';
    if (root.clonable) attribs.shadowrootclonable = '';
    if (ownRegistry.has(root)) attribs.shadowrootcustomelementregistry = '';
    return new Element('template', attribs, root.children.map(copy));
  };
  const copy = (child: ChildNode): ChildNode => {
    if (!(child instanceof Element)) return child.cloneNode(false) as ChildNode;
    const kids = child.children.map(copy);
    const shadow = shadowOf(child);
    return new Element(
      child.name,
      { ...child.attribs },
      shadow ? [shadow, ...kids] : kids,
    );
  };
  const kids = node.children.map(copy);
  const shadow = node instanceof Element ? shadowOf(node) : null;
  return new Document(shadow ? [shadow, ...kids] : kids);
}

/** A `<style>`'s rules as CSSOM has them (`sheetRules`), and which edit of
 *  them this is, so the page asks for them again only when they change. */
interface SheetState {
  rules: string[];
  version: number;
}

/** Counts the hosts made, each a token its storage changes carry, so
 *  that the document that made one does not hear it. */
let hostTokens = 0;

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
  /** And whether one was stopped inside an op, where `<Html>` may have
   *  been half way through styling or laying out the document
   *  (`ScriptEngine.interruptedSince`). */
  interruptedSince?(): boolean;
  /** A worker's imported script, run in the page from inside its call
   *  (`ScriptEngine.runNested`): whether it ran, or threw what is now at
   *  `__thrown`. */
  runNested?(code: string, url: string): 'ran' | 'threw' | null;
  /** A page's classic script, run as a script of its own with the element
   *  of `script`'s id its `currentScript` (`ScriptEngine.exec`): whether
   *  it ran to its end. */
  exec?(code: string, url: string, script: number): boolean;
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
  /** The `<script>`s a page's script made, and whether each still has its
   *  `async` forced on (HTML 4.12.1, "force async"): true until a script
   *  sets `async` or adds the attribute. A script the parser made has
   *  none. */
  readonly forceAsync = new WeakMap<Element, boolean>();
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
  /** The top-level document's address: the page's, whose site is the site
   *  for cookies of every frame in it. */
  top: string | null = null;

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
  /** What each media element's source is being read for (`_mediaFetch`). */
  private _mediaFetches = new Map<
    Element,
    InstanceType<AbortControllerClass>
  >();
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
  /** Each node put where it is connected since the facade last asked, and
   *  its document (`'s'`): what a scoped registry's elements and roots in
   *  it associate the registry with (HTML 4.13.4, its scoped document
   *  set). Null until the page gives a node a scoped registry
   *  (`ceScoped`), so a page that never does pays nothing for it. */
  private _scoped: Primitive[][] | null = null;
  /** The `<template>`s' contents (`content`), whose node document is an
   *  inert one in a browser: nothing in them is a custom element, and a
   *  copy of them none either, until it is put in the document. */
  private _templateContents = new WeakSet<AnyNode>();
  /** The address the document is at, which `history.pushState` moves. */
  url: string;
  /** Scripts that are never run: what `innerHTML` and
   *  `insertAdjacentHTML` put in, which HTML does not run either. */
  readonly inert: WeakSet<Element>;
  /** Whether a script a page's script made has `async` forced on
   *  (`DomShared.forceAsync`). */
  private readonly _forceAsync: WeakMap<Element, boolean>;
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
  /** Where a script with a source, or a module, that a page's script put
   *  in is handed as it goes in (`ScriptRunner.add`), so the scripts that
   *  run in order run in the order they went in (`_prepareScript`). */
  scriptConnected: ((request: ScriptRequest) => void) | null = null;
  /** Where this page's workers run, where it may start them. */
  workers: PageWorkersLike | null = null;
  /** The page this realm is the worker of, where it is one. */
  workerScope: WorkerScope | null = null;
  /** Where the document is in the host's session across documents, where
   *  the host keeps one (`HtmlSessionHistory`): set before the page's
   *  realm is made, which reads it as it starts. */
  arrival: SessionArrival | null = null;
  private _disposed = false;
  /** The document is being left: nothing its scripts change now is drawn
   *  (`leaving`). */
  private _leaving = false;
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
    // a fragment directive is the user agent's, and no part of the URL a
    // page reads (HTML, "remove the fragment directive"): `#:~:text=…` is
    // `location.hash` ''
    this.url = withoutFragmentDirective(url);
    this._ids.set(document, 1);
    this._nodes.set(1, document);
    this._s = shared;
    this.inert = shared.inert;
    this._forceAsync = shared.forceAsync;
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
    shared.top ??= this.url;
    // what another document of the origin does to its storage, which this
    // one hears as a `storage` event
    this._unwatchStorage =
      this._storageOf().watch?.((change) => this._storageChanged(change)) ??
      null;
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

  /** A task of the page's ended: the documents of the frames it took out
   *  of the document unload (`_framesLeft`), and what it changed is drawn. */
  settled(): void {
    if (this._framesGone) this._framesLeft();
    this.flush();
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
    // and one stopped inside an op ran none of the `finally`s of what the op
    // was in the middle of: `<Html>` makes the document's styles, boxes and
    // layout again rather than go on from what was left
    if (this.entries?.interruptedSince?.()) this._seams.handle.interrupted?.();
    // a document being left changes nothing anyone sees
    if (this._leaving) {
      this._changes = [];
      this._refreshAll = false;
      return;
    }
    if (this._sheetsChanged.size) this._writeSheets();
    this._syncHighlights();
    this._tellChanges();
    // and where the page's caret is, in the tree as it was just told
    this._syncCaret();
  }

  /** The tree's changes, told to the `<Html>` that draws each document
   *  they were made in (`flush`). */
  private _tellChanges(): void {
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
      let url = this._frameAt.get(frame) ?? 'about:blank';
      // a `srcdoc` document's base is the page's (HTML 4.8.5)
      if (url === 'about:srcdoc') url = this.url;
      if (!document || this._xml.has(document)) continue;
      out.push({ frame, document, url, realm: this._s.realms.has(document) });
    }
    return out;
  }

  /**
   * What the parser put in the document since the page's scripts began to
   * run (`HandleInternals.parserMade`), told as the DOM tells an insertion
   * (HTML 13.2.6.1, "insert an element at the adjusted insertion
   * location"): a record of each node, which the parser appended to a
   * parent already in the tree, for the page's mutation observers, and
   * each custom element connected, with what it holds, once. Not to
   * `<Html>`, whose parser made it. Null where there was nothing; where
   * there was, what the facade is told of it (`__mutated`) — but for what
   * the op that wrote it made, which the op's own return tells: whether the
   * document's `<body>` was among it, whose `on…` attributes the window's
   * handlers come to be as the parser sets them, after a head's scripts
   * listened (HTML 8.1.8.1).
   */
  parserInserted(): { body: boolean } | null {
    const made = this._seams.handle.parserMade?.();
    if (!made?.length || this._disposed) return null;
    const fresh = this._custom || this._scoped ? new Set<AnyNode>(made) : null;
    let body = false;
    for (const node of made) {
      const parent = node.parent;
      if (!parent) continue;
      if (
        node instanceof Element &&
        node.name === 'body' &&
        parent instanceof Element &&
        parent.parent === this.document
      ) {
        body = true;
      }
      if (this._observers.size) {
        this._queue(parent, {
          type: 'childList',
          target: parent,
          added: [node],
          removed: [],
          previous: node.prev,
          next: null,
          attributeName: null,
          oldValue: null,
        });
      }
      if (fresh && this._inDocument(parent)) {
        let above: AnyNode = parent;
        while (above instanceof ShadowRoot) above = above.host;
        if (!fresh.has(above)) {
          if (this._custom) this._customLog('c', node);
          this._scoped?.push(['s', this.idOf(node), this.idOf(this.document)]);
        }
      }
    }
    return { body };
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

  /**
   * The viewports the facade watches (`rendering`), by the id of the
   * document each is of — this one's, 1, and those of the page realm's
   * frames it made windows for — each with what it was last answered, and
   * whether the facade was woken since it last asked.
   */
  private _viewports = new Map<number, string>([[1, '']]);
  private _viewportsWoken = false;

  /** `<Html>` painted (`ScriptRunner.painted`): the facade is woken for a
   *  frame where a viewport it watches is another size, or answers a media
   *  query from anything else, than it was last told — a pane resized, an
   *  `<iframe>`'s box the page laid out again — so that the frame runs its
   *  resize steps and reports its media queries (HTML's "update the
   *  rendering") whether or not anything else asked for one. */
  renderingMoved(): void {
    if (this._disposed || !this.entries || this._viewportsWoken) return;
    for (const [id, was] of this._viewports) {
      if (this._viewportKey(id) === was) continue;
      this._viewportsWoken = true;
      this.entries.call('__rendering', null);
      return;
    }
    const seen = this._intersecting;
    if (seen && this._intersections(seen.query) !== seen.answer) {
      this._viewportsWoken = true;
      this.entries.call('__rendering', null);
    }
  }

  /**
   * What the page's intersection observers asked at their last frame, and
   * what it was answered: after each paint it is asked again
   * (`renderingMoved`), and the facade woken for a frame where the answer
   * moved — a layout that moved a target, a scroll inside the document, an
   * image come in — as nothing else would wake it for one.
   */
  private _intersecting: { query: string; answer: string } | null = null;

  /**
   * Each observer's targets measured against its root (`intersectionsOf`):
   * `query` is a JSON list, an observer an entry, of its root's id (0 for
   * the viewport), its `scrollMargin` as it serializes and its targets'
   * ids. An observer a line: its root's rectangle, or '' for the viewport,
   * then each target's, `;` before each — its bounding box and the part
   * of it shown, in CSS pixels in the document's coordinates, or the box
   * alone where none of it is, or '' where it has no box or is not in the
   * root.
   */
  private _intersections(query: string): string {
    const handle = this._seams.handle;
    const observers = JSON.parse(query) as [number, string, number[]][];
    const rect = (r: Rect) => `${r.x},${r.y},${r.width},${r.height}`;
    return observers
      .map(([rootId, margin, ids]) => {
        // the viewport for 0; a root no longer here measures nothing
        const root = rootId ? this._nodes.get(rootId) : null;
        const elements = ids.map((id) => {
          const el = this._nodes.get(id);
          return el instanceof Element ? el : null;
        });
        const found =
          root === null || root instanceof Element
            ? handle.intersectionsOf?.(elements, root, marginLengths(margin))
            : null;
        if (!found) return ';'.repeat(ids.length);
        const parts = found.targets.map((t) =>
          !t ? '' : t.shown ? `${rect(t.rect)},${rect(t.shown)}` : rect(t.rect),
        );
        return [found.root ? rect(found.root) : '', ...parts].join(';');
      })
      .join('\n');
  }

  /** What a document's viewport is now, as `rendering` answers it: its
   *  width and height in CSS pixels, then what its media queries are
   *  answered from. */
  private _viewportKey(id: number): string {
    const v = this._seams.viewport();
    if (id === 1) {
      const media = this._seams.handle.mediaEnvironment?.() ?? '';
      return `${v.width} ${v.height} ${v.dpr} ${media}`;
    }
    const doc = this._nodes.get(id);
    if (!(doc instanceof Document) || !this._frameOf.has(doc)) return '0 0';
    const size = this._frameSize(doc);
    return `${size.width} ${size.height} ${v.dpr}`;
  }

  /** Whether a media query holds for a frame's document that runs in this
   *  realm: at its viewport, its frame's content box, as its styles are
   *  worked out (`_frameComputed`), in the look a frame is styled in. */
  private _frameMedia(doc: Document, query: string): boolean {
    const size = this._frameSize(doc);
    return mediaMatches(
      [parseMediaQuery(query)],
      size.width,
      FRAME_LOOK.colorScheme,
      size.height,
      this._seams.viewport().dpr,
      false,
      true,
    );
  }

  /** Scroll containers in the document scrolled: each one's `scroll`,
   *  which does not bubble (CSSOM View, "run the scroll steps"). */
  elementsScrolled(elements: Iterable<Element>): void {
    if (this._disposed || !this.entries) return;
    for (const el of elements) {
      this.entries.call('__fire', [this.idOf(el), 'scroll']);
    }
  }

  /** The document's CSS transitions owe these events: `transitionrun`,
   *  `transitionstart`, `transitionend` and `transitioncancel`, which
   *  bubble (CSS Transitions 2, 6.1). */
  cssEvents(events: CssEventInfo[]): void {
    if (this._disposed || !this.entries) return;
    this.entries.call('__cssEvents', [
      JSON.stringify(
        events.map((e) => ({ ...e, element: this.idOf(e.element) })),
      ),
    ]);
  }

  /** What the player of one of the page's media elements said: the page
   *  hears it on the element whose source it is, and nowhere else
   *  (`mediaPlayed`, in `dom.ts`). As strings, as `__media` is told, since
   *  a live stream's length is `Infinity`, which JSON has no word for. */
  mediaEvent(
    el: Element,
    src: string,
    kind: MediaEventKind,
    value: string,
  ): void {
    if (this._disposed || !this.entries) return;
    this.entries.call('__player', [this.idOf(el), src, kind, value]);
  }

  /** And each one's `scrollend`, a frame after its last `scroll`. */
  elementsScrolledEnd(elements: Iterable<Element>): void {
    if (this._disposed || !this.entries) return;
    for (const el of elements) {
      this.entries.call('__fire', [this.idOf(el), 'scrollend']);
    }
  }

  /** The document is being left (`ScriptRunner.dispose`): what its
   *  `pagehide` and `unload` listeners change is drawn nowhere. */
  leaving(): void {
    this._leaving = true;
  }

  /** Whether the document has a WebTransport session, a WebSocket or a
   *  peer connection open (`ScriptRunner.salvageable`). */
  get connected(): boolean {
    return (
      !!this._transportsMade?.open ||
      !!this._socketsMade?.open ||
      !!this._peersMade?.open ||
      !!this.workers?.connected
    );
  }

  dispose(): void {
    this._disposed = true;
    this._unwatchStorage?.();
    this._unwatchStorage = null;
    this._transportsMade?.dispose();
    this._transportsMade = null;
    this._socketsMade?.dispose();
    this._socketsMade = null;
    this._peersMade?.dispose();
    this._peersMade = null;
    this._sourcesMade?.dispose();
    this._sourcesMade = null;
    if (this._s.drawn.get(this.document) === this._seams.handle) {
      this._s.drawn.delete(this.document);
    }
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    for (const fetch of this._fetches.values()) fetch.abort();
    this._fetches.clear();
    for (const fetch of this._mediaFetches.values()) fetch.abort();
    this._mediaFetches.clear();
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

  /** The document a node is in (DOM 4.4, "node document"): a shadow
   *  root's is its host's. */
  private _ownerOf(node: AnyNode): Document {
    for (
      let at: AnyNode | null = node;
      at;
      at = at.parent ?? (at instanceof ShadowRoot ? at.host : null)
    ) {
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
    // what it holds follows it, shadow trees and all (shadow-including)
    const forget = (at: AnyNode): void => {
      for (const kid of (at as ParentNode).children ?? []) {
        this._owners.delete(kid);
        forget(kid);
      }
      const root = at instanceof Element ? shadowRootOf(at) : null;
      if (root) {
        this._owners.delete(root);
        forget(root);
      }
    };
    forget(node);
    if (doc === this.document && !node.parent) this._owners.delete(node);
    else this._owners.set(node, doc);
  }

  /** A copy of a node, its document's (DOM 4.5, "clone"). */
  private _clone(node: AnyNode, deep: boolean): ChildNode {
    const clone = node.cloneNode(deep) as ChildNode;
    this._cloneShadows(node, clone, deep);
    this._copiedScripts(node, clone, deep);
    const owner = this._ownerOf(node);
    if (owner !== this.document) this._owners.set(clone, owner);
    this._imagesMade([clone]);
    if (isDoctype(node)) this._doctypes.set(clone, this._doctypeOf(node));
    const type = this._xml.get(node as Document);
    if (this._isDocument(node)) {
      this._documents.add(clone as unknown as Document);
      if (type) this._xml.set(clone as unknown as Document, type);
    }
    return clone;
  }

  /** A deep copy of a child: a clone's, or a template content's with
   *  every shadow root in it (`_cloneShadows`'s `every`). */
  private _copyOf(child: ChildNode, every: boolean): ChildNode {
    if (!every) return this._clone(child, true);
    const copy = child.cloneNode(true) as ChildNode;
    this._cloneShadows(child, copy, true, true);
    this._copiedScripts(child, copy, true);
    return copy;
  }

  /** A copy's scripts, which a script made, so `async` is forced on in
   *  each (`forceAsync`), and which have started where the scripts they
   *  copy have (HTML 4.12.1, the script element's cloning steps): a script
   *  `innerHTML` made, copied into the document, runs no more than it would
   *  have (`_prepareScript`). The two trees are alike, so their scripts are
   *  found in the same order. */
  private _copiedScripts(node: AnyNode, copy: AnyNode, deep: boolean): void {
    const isScript = (el: Element): boolean => el.name === 'script';
    const from = deep
      ? DomUtils.findAll(isScript, [node])
      : node instanceof Element && isScript(node)
        ? [node]
        : [];
    if (!from.length) return;
    const to = deep ? DomUtils.findAll(isScript, [copy]) : [copy as Element];
    for (let i = 0; i < from.length && i < to.length; i++) {
      this._forceAsync.set(to[i], true);
      if (this.inert.has(from[i])) this.inert.add(to[i]);
    }
  }

  /** Whether a script a page's script put in runs in the order it went in
   *  (HTML 4.12.1.1, "the list of scripts that will execute in order as
   *  soon as possible"): one a script made and set `async` false on, with
   *  no `async` attribute. Google's module loader sets it on every module
   *  it puts in, since a module needs the ones put in before it to have
   *  run. */
  inOrder(el: Element): boolean {
    return this._forceAsync.get(el) === false && el.attribs.async === undefined;
  }

  /** The shadow trees a clone takes (DOM 4.4, "clone a node"): a host
   *  whose shadow root is clonable gives its copy a root of the same kind
   *  and a copy of the tree in it, whether or not the clone is deep, and
   *  a deep clone does so for every host in what it copies. `every` is a
   *  template's content, which stands for what the template's children
   *  are and so takes every root as it is, clonable or not. */
  private _cloneShadows(
    node: AnyNode,
    copy: AnyNode,
    deep: boolean,
    every = false,
  ): void {
    if (node instanceof Element && copy instanceof Element) {
      const root = shadowRootOf(node);
      if (root && (every || root.clonable) && !shadowRootOf(copy)) {
        const made = attachShadow(copy, {
          mode: root.mode,
          delegatesFocus: root.delegatesFocus,
          clonable: root.clonable,
          serializable: root.serializable,
        });
        if (made) {
          made.registryNull = root.registryNull;
          if (every) made.declarative = root.declarative;
          for (const child of root.children) {
            DomUtils.appendChild(made, this._copyOf(child, every));
          }
        }
      }
    }
    if (!deep) return;
    const from = (node as { children?: AnyNode[] }).children ?? [];
    const to = (copy as { children?: AnyNode[] }).children ?? [];
    for (let i = 0; i < from.length && i < to.length; i += 1) {
      this._cloneShadows(from[i], to[i], true, every);
    }
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

  /** How many looks a handle with no `geometryKey` was asked for. */
  private _looks = 0;

  private _op(
    op: string,
    a: Primitive,
    b: Primitive,
    c: Primitive,
    d: Primitive,
  ): Primitive {
    const text = (v: Primitive): string => (typeof v === 'string' ? v : '');
    // a WebTransport session's or stream's (`transports.ts`)
    if (op.charCodeAt(0) === 119 && op.charCodeAt(1) === 116) {
      return this._transports().op(op, a, b, c);
    }
    // a WebSocket's (`sockets.ts`)
    if (op.charCodeAt(0) === 119 && op.charCodeAt(1) === 115) {
      return this._sockets().op(op, a, b, c, d);
    }
    // a peer connection's (`peers.ts`)
    if (
      op.charCodeAt(0) === 114 &&
      op.charCodeAt(1) === 116 &&
      op.charCodeAt(2) === 99
    ) {
      return this._peers().op(op, a, b, c, d);
    }
    // a media source's (`media-sources.ts`)
    if (op.charCodeAt(0) === 109 && op.charCodeAt(1) === 100) {
      return this._sources().op(op, a, b);
    }
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
        if (!('children' in node) || isTemplate(node)) return '';
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
        if (isTemplate(node)) return 0;
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
          if (el.name === 'script') this._forceAsync.set(el, true);
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
      // what a parent holds replaced, as one record (DOM 4.2.6,
      // `replaceChildren`, "replace all"): a removal and an insertion
      // were two, which an observer told the children went and came back
      case 'replaceChildren': {
        const parent = this._parent(a);
        const node = b ? this._node(b) : null;
        if (node) this._validInsert(parent, node, null, false);
        this._replaceAll(
          parent,
          !node
            ? []
            : this._isFragment(node)
              ? ((node as Document).children.slice() as ChildNode[])
              : [node as ChildNode],
        );
        return null;
      }
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
      // its two points — drawn at the next flush; or, with a document's
      // id, a frame's window's, drawn in the frame
      case 'highlights': {
        const doc = b ? (this._node(b) as Document) : this.document;
        const spec = JSON.parse(text(a)) as HighlightSpec[];
        if (spec.length) this._highlightSpecs.set(doc, spec);
        else if (this._highlightsTold.has(doc)) {
          this._highlightSpecs.set(doc, []);
        } else this._highlightSpecs.delete(doc);
        return null;
      }
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
      // `script.async`: forced on in a script a script made, until it is
      // set (HTML 4.12.1)
      case 'scriptForceAsync':
        return this._forceAsync.get(this._element(a)) === true;
      case 'scriptAsyncSet': {
        const el = this._element(a);
        if (this._forceAsync.has(el)) this._forceAsync.set(el, false);
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
        if (name === 'async' && this._forceAsync.has(el)) {
          this._forceAsync.set(el, false);
        }
        this._changed(el, 'attributes', name, oldValue);
        // a frame given another address, or another `srcdoc`, goes there
        if (this._sendsFrame(el, name, true)) {
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
          // a frame that loses its `srcdoc` goes to its `src`, and one that
          // loses its `src` to `about:blank`
          if (this._sendsFrame(el, name, false)) {
            this._frameSent.delete(el);
            this._loadFrame(el, true);
          }
        }
        return null;
      }
      case 'style':
        return declarationValue(this._element(a).attribs.style, text(b));
      case 'stylePriority':
        return declarationPriority(this._element(a).attribs.style, text(b));
      case 'styleNames':
        return declarationNames(this._element(a).attribs.style);
      // `style.cssText`, serialized as CSSOM serializes a block, each
      // declaration ended: CodeMirror appends `visibility: hidden` to it
      case 'styleText':
        return declarationText(this._element(a).attribs.style);
      case 'setStyle': {
        const el = this._element(a);
        const oldValue = el.attribs.style ?? null;
        const written = withDeclaration(oldValue, text(b), text(c), d);
        if (written === null) return null;
        if (written) el.attribs.style = written;
        else delete el.attribs.style;
        this._changed(el, 'attributes', 'style', oldValue);
        return null;
      }
      // the same of a rule's block, handed over as its text, which the
      // facade writes back to the rule itself (`replaceRule`)
      case 'blockValue':
        return declarationValue(text(a), text(b));
      case 'blockPriority':
        return declarationPriority(text(a), text(b));
      case 'blockNames':
        return declarationNames(text(a));
      case 'blockText':
        return declarationText(text(a));
      case 'blockSet':
        return withDeclaration(text(a), text(b), text(c), d);

      // --- shadow trees, which `<Html>` draws: one attached builds the
      // document again at the next flush, as a new tree to draw
      case 'attachShadow': {
        const host = this._element(a);
        const mode = b === 'closed' ? 'closed' : 'open';
        const current = shadowRootOf(host);
        // a declarative root is the script's to take, emptied, where it
        // asks for its mode (DOM 4.9, "attach a shadow root", step 4)
        if (current?.declarative && current.mode === mode) {
          this._replaceAll(current, []);
          current.declarative = false;
          return this.idOf(current);
        }
        if (current) {
          throw new DomError(
            'NotSupportedError',
            "Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.",
          );
        }
        const [clonable, serializable] = text(d).split(',');
        const root = attachShadow(host, {
          mode,
          delegatesFocus: c === true,
          clonable: clonable === '1',
          serializable: serializable === '1',
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
      // an open root, or a closed one where the element's own internals ask
      case 'shadowRoot': {
        const root = shadowRootOf(this._element(a));
        return root && (root.mode === 'open' || b === true)
          ? this.idOf(root)
          : 0;
      }
      case 'shadowHost':
        return this.idOf((this._node(a) as ShadowRoot).host);
      // a shadow root's `clonable` and `serializable`
      case 'shadowFlags': {
        const root = this._node(a) as ShadowRoot;
        return `${root.clonable ? 1 : 0}${root.serializable ? 1 : 0}`;
      }
      // the slot a node is assigned to (DOM 4.2.2.3), where its tree is
      // open, or whatever its tree where the flat tree is asked for
      case 'assignedSlot': {
        const slot = assignedSlot(this._node(a) as ChildNode);
        if (!slot) return 0;
        if (b !== true && shadowRootAround(slot)?.mode !== 'open') return 0;
        return this.idOf(slot);
      }
      // what a slot is assigned, its own children for a fallback where it
      // is asked to flatten, and the slots in that, theirs
      case 'assignedNodes': {
        const out: ChildNode[] = [];
        const add = (slot: Element, flatten: boolean): void => {
          const root = shadowRootAround(slot);
          const assigned = root ? root.assignedTo(slot) : [];
          const nodes = assigned.length || !flatten ? assigned : slot.children;
          for (const node of nodes) {
            if (
              flatten &&
              node instanceof Element &&
              node.name === 'slot' &&
              shadowRootAround(node)
            ) {
              add(node, true);
            } else out.push(node);
          }
        };
        add(this._element(a), b === true);
        return out.map((n) => this.idOf(n)).join(',');
      }
      case 'shadowMode':
        return (this._node(a) as ShadowRoot).mode;
      case 'shadowDelegates':
        return (this._node(a) as ShadowRoot).delegatesFocus;
      // a declarative root whose registry is null, which the page's
      // registries are kept by
      case 'shadowRegistryNull':
        return (this._node(a) as ShadowRoot).registryNull;
      // whether the parser has made an element or a root of no registry
      case 'registriesParsedNull':
        return parsedNullRegistries();
      // whether an element has no registry where its parent would give it
      // one: the parser wrote it with `customelementregistry` (true), or
      // it is a top element of a template's contents, whose document has
      // none (HTML 4.12.3) until it is adopted ('template')
      case 'elementRegistryNull': {
        const el = this._element(a);
        if (parsedWithNullRegistry(el)) return true;
        const parent = el.parent;
        return (parent instanceof Element && parent.name === 'template') ||
          (parent !== null && this._templateContents.has(parent))
          ? 'template'
          : false;
      }

      // --- custom elements (`_custom…`)
      // a name defined, local name `b` (its own, or the element an `is`
      // extends), and the elements in document `c`, where one is named, it
      // upgrades, in shadow-including tree order (HTML 4.13.4, `define()`,
      // "upgrade particular elements within a document")
      case 'ceDefine': {
        const name = text(a);
        const local = text(b);
        (this._custom ??= { names: new Set(), log: [] }).names.add(name);
        if (!c) return '';
        const found: number[] = [];
        this._customWalk(this._node(c), (el) => {
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
      // what was connected from now on, for the scoped registries the page
      // gives nodes (`_scoped`)
      case 'ceScoped':
        this._scoped ??= [];
        return null;
      // the elements and the shadow roots in a node, itself first, in
      // shadow-including tree order: what a scoped registry's may be among
      case 'ceTree': {
        const found: number[] = [];
        this._customWalk(this._node(a), (el) => {
          found.push(this.idOf(el));
          const root = shadowRootOf(el);
          if (root) found.push(this.idOf(root));
        });
        return found.join(',');
      }
      // what happened to them since the last time, as JSON: what was
      // connected first, then what happened to the custom elements
      case 'ceTake': {
        const custom = this._custom;
        const scoped = this._scoped;
        if (!custom?.log.length && !scoped?.length) return '';
        const log = [...(scoped ?? []), ...(custom?.log ?? [])];
        if (custom) custom.log = [];
        if (scoped) this._scoped = [];
        return JSON.stringify(log);
      }
      // an element a definition made a custom element: `:defined` from now
      case 'ceDefined': {
        const el = this._element(a);
        markCustomized(el);
        if (this._isDocument(shadowIncludingRoot(el))) {
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
      // an element made the fullscreen element or taken out (Fullscreen
      // 2), told as a change of an attribute nothing has, which
      // `:fullscreen` reads; given no `b`, whether it is fullscreen
      case 'fullscreen': {
        const el = this._element(a);
        if (
          typeof b === 'boolean' &&
          (!b || this._inDocument(el)) &&
          setFullscreen(el, b) &&
          this._inDocument(el)
        ) {
          this._tell(el, {
            type: 'attributes',
            target: el,
            attributeName: '-rx-fullscreen',
          });
        }
        return isFullscreen(el);
      }
      // a popover shown or hidden (HTML 6.12), told as a change of an
      // attribute nothing has, which only `:popover-open` reads; given no
      // `b`, whether it is showing — taken out of the document, it is not.
      // Shown, `c` is what showed it, its implicit anchor element, if
      // anything did
      case 'popoverOpen': {
        const el = this._element(a);
        if (
          typeof b === 'boolean' &&
          (!b || this._inDocument(el)) &&
          setPopoverOpen(
            el,
            b,
            b && typeof c === 'number' ? this._element(c) : null,
          ) &&
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
        // where the parse waits at the script, into the input stream at the
        // insertion point, which the parser reads on from, as HTML's does
        if (this._seams.handle.parserWrite?.(script, text(a))) {
          this.parserInserted();
          return true;
        }
        // a document parsed whole before its scripts ran — a frame's, which
        // the page's realm made — takes it as a fragment after the script
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
        // an attribute with no value written `=""`, as HTML's fragment
        // serialization writes every one (HTML 8.5.2)
        return b
          ? DomUtils.getOuterHTML(node, SERIALIZE)
          : DomUtils.getInnerHTML(node, SERIALIZE);
      }
      // `getHTML()` (HTML 8.5.2): what a node holds, with the shadow trees
      // it asks for written as the declarative templates that make them —
      // the serializable ones where `b`, and those `c` lists
      case 'getHTML': {
        const node = this._node(a) as ParentNode;
        const nodes = (list: string) =>
          new Set<AnyNode>(
            list
              .split(',')
              .filter(Boolean)
              .map((id) => this._node(Number(id))),
          );
        return DomUtils.getInnerHTML(
          withShadowTemplates(node, b === true, nodes(text(c)), nodes(text(d))),
          SERIALIZE,
        );
      }
      case 'setHtml': {
        const parent = this._parent(a);
        // `setHTMLUnsafe` takes declarative shadow roots, as the document's
        // parser does (HTML 8.5.1)
        this._replaceAll(parent, this._parseIn(parent, text(b), c === true));
        if (!this._inDocument(parent)) this._imagesMade(parent.children);
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
          const kids = template.children.map((kid) => this._copyOf(kid, true));
          const holder = new Document(kids);
          // a copy is linked to no sibling, and `nextSibling` reads the
          // links: Polymer walks a template's content by them, and found
          // only its first child
          kids.forEach((kid, i) => {
            kid.parent = holder;
            kid.prev = kids[i - 1] ?? null;
            kid.next = kids[i + 1] ?? null;
          });
          this._templateContents.add(holder);
          fragment = this.idOf(holder);
          this._contents.set(id, fragment);
        }
        return fragment;
      }

      // --- selectors
      case 'query': {
        const root = this._node(a);
        const options = this._queryOptions();
        // a view transition's pseudo-element is no element, and nor is a
        // highlight's
        if (this._transitionSelector(text(b))) return c ? '' : 0;
        const selector = this._withoutHighlights(text(b));
        if (selector === null) return c ? '' : 0;
        try {
          const query = this._query(selector, root);
          if (c) {
            return selectAll(query, root as Element, options)
              .map((el) => this.idOf(el))
              .join(',');
          }
          return this.idOf(selectOne(query, root as Element, options));
        } catch (error) {
          throw new DomError(
            'SyntaxError',
            `'${text(b)}' is not a valid selector: ${(error as Error).message}`,
          );
        }
      }
      case 'matches': {
        if (this._transitionSelector(text(b))) return false;
        const selector = this._withoutHighlights(text(b));
        if (selector === null) return false;
        try {
          const el = this._element(a);
          return this._query(selector, el)(el);
        } catch {
          throw new DomError(
            'SyntaxError',
            `'${text(b)}' is not a valid selector.`,
          );
        }
      }
      case 'closest': {
        if (this._transitionSelector(text(b))) return 0;
        const selector = this._withoutHighlights(text(b));
        if (selector === null) return 0;
        try {
          const from = this._element(a);
          const query = this._query(selector, from);
          for (let at: AnyNode | null = from; at; at = at.parent) {
            if (at instanceof Element && query(at)) return this.idOf(at);
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
          elementsIn(
            b ? (this._node(b) as ParentNode) : this.document,
            (el) => el.attribs.id === text(a),
            true,
          )[0],
        );
      case 'byTag': {
        const tag = text(b).toLowerCase();
        const root = this._node(a) as ParentNode;
        return elementsIn(root, (el) => tag === '*' || el.name === tag)
          .map((el) => this.idOf(el))
          .join(',');
      }
      case 'byClass': {
        const wanted = text(b)
          .split(/[\t\n\f\r ]+/)
          .filter(Boolean);
        const root = this._node(a) as ParentNode;
        if (!wanted.length) return '';
        return elementsIn(root, (el) => {
          const has = (el.attribs.class ?? '').split(/[\t\n\f\r ]+/);
          return wanted.every((w) => has.includes(w));
        })
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
        const brace = rules.length === 1 ? rules[0].indexOf('{') : -1;
        const prelude =
          brace > 0 && !rules[0].startsWith('@')
            ? rules[0].slice(0, brace)
            : null;
        const highlights =
          prelude === null ? null : highlightSelectorValid(prelude);
        if (
          rules.length !== 1 ||
          (prelude !== null &&
            (transitionSelectorValid(prelude) === false ||
              highlights === false))
        ) {
          throw new DomError(
            'SyntaxError',
            `Failed to parse the rule '${text(b)}'.`,
          );
        }
        // a highlight's name as `selectorText` serializes it
        if (highlights) {
          rules[0] = `${canonicalHighlights(prelude!)} ${rules[0].slice(brace)}`;
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
      // a bitmap as a file (`toDataURL`, `toBlob`, `convertToBlob`): its
      // size and its straight RGBA as base64, and the PNG as base64, the
      // one type every bitmap is had as
      case 'encodeImage': {
        const [width, height] = text(a).split(',').map(Number);
        if (!(width > 0 && height > 0)) return '';
        const rgba = Buffer.from(text(b), 'base64');
        if (rgba.length !== width * height * 4) return '';
        const png = encodePng(width, height, rgba);
        return Buffer.from(png.buffer, png.byteOffset, png.length).toString(
          'base64',
        );
      }
      // a blob's image decoded for `createImageBitmap`, through the ladder
      // a document's images are, and the page told its size and its
      // straight RGBA, or '' where it is no image (`__imageDecoded`)
      case 'imageDecode': {
        const id = Number(a);
        const bytes = Buffer.from(text(b), 'base64');
        const tell = (size: string, data: string) => {
          if (!this._disposed) {
            this.entries?.call('__imageDecoded', [id, size, data]);
          }
        };
        void Promise.resolve()
          .then(
            () =>
              decodeGif(bytes) ??
              ntk.decodeImageBytes(bytes, { offThread: true }),
          )
          .then(
            (image) =>
              tell(
                `${image.width},${image.height}`,
                Buffer.from(
                  image.data.buffer,
                  image.data.byteOffset,
                  image.data.length,
                ).toString('base64'),
              ),
            () => tell('', ''),
          );
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
      // the page's selection as its live range, by its id, or 0 for none:
      // drawn as a caret where it is collapsed, at each flush
      case 'documentCaret':
        this._caret = Number(a) || 0;
        return null;
      // a boundary point moved through the drawn text, as `modify` moves
      // the selection's focus
      case 'movePoint': {
        const moved = this._seams.handle.movedPoint?.(
          this._node(a),
          Number(b) || 0,
          text(c) === 'word' ? 'word' : 'character',
          !!d,
        );
        return moved
          ? JSON.stringify([this.idOf(moved.node), moved.offset])
          : null;
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
      // whether a frame's document is its initial `about:blank`: one a
      // `javascript:` URL made is a new one, as HTML makes it
      case 'frameInitialBlank': {
        const frame = this._element(a);
        const doc = this._frames.get(frame);
        const src = (frame.attribs.src ?? '').trim();
        return (
          !!doc &&
          this._initialBlank.has(doc) &&
          !this._frameSent.has(frame) &&
          !/^javascript:/i.test(src)
        );
      }
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
      // a media query, as a frame's document in this realm answers it: at
      // its own viewport, and not the page's
      case 'frameMedia':
        try {
          return this._frameMedia(this._node(a) as Document, text(b));
        } catch {
          return false;
        }
      // the viewports the facade's rendering steps run for, by the ids of
      // their documents — this one's, 1, and frames' in this realm — a line
      // each: the width, the height and what its media queries are
      // answered from (`renderingMoved`)
      case 'rendering': {
        this.flush();
        const ids = text(a).split(' ').map(Number).filter(Boolean);
        const keys = ids.map((id) => this._viewportKey(id));
        this._viewports = new Map(ids.map((id, i) => [id, keys[i]]));
        this._viewportsWoken = false;
        return keys.join('\n');
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

      // a view transition's steps, which the element draws (CSS View
      // Transitions 1, 7.4 to 7.9): what is captured, by the layout what a
      // script changed comes to; the time until its animations are over,
      // -1 for never
      case 'vtOld':
      case 'vtNew':
      case 'vtRemaining':
      case 'vtEnd': {
        this.flush();
        // the view that draws the document the transition is of — the
        // page's, or a frame's — or none, which answers as none would
        const handle = (
          a ? this._drawing(this._node(a)) : this._seams.handle
        ) as Partial<HandleInternals> | null;
        if (op === 'vtEnd') {
          handle?.transitionEnd?.();
          return null;
        }
        if (op === 'vtRemaining') {
          const left = handle?.transitionRemaining
            ? handle.transitionRemaining()
            : 0;
          return left === null ? -2 : left === Infinity ? -1 : left;
        }
        const capture =
          op === 'vtOld'
            ? handle?.transitionCaptureOld
            : handle?.transitionCaptureNew;
        return capture
          ? capture.call(handle)
          : this._op('transitionNames', null, null, null, null);
      }
      // a view transition active with its types, `\u0000`-joined — or,
      // given null, none: what `:active-view-transition` matches the root
      // by, told as a change of an attribute nothing has
      case 'vtActive': {
        const doc = (a ? this._node(a) : this.document) as Document;
        const root = DomUtils.findOne(() => true, doc.children, false);
        const types =
          typeof b === 'string' ? (b ? b.split('\u0000') : []) : null;
        if (setActiveTransition(doc, types) && root) {
          this._tell(root, {
            type: 'attributes',
            target: root,
            attributeName: '-rx-view-transition',
          });
        }
        return null;
      }
      // the names a view transition would capture elements by, where two
      // elements have one: what skips it (CSS View Transitions 1, 7.3)
      case 'transitionNames': {
        this.flush();
        const seen = new Set<string>();
        for (const el of DomUtils.findAll(() => true, this.document.children)) {
          const name =
            this._seams.handle.computedStyle(el, null)?.[
              'view-transition-name'
            ] ?? 'none';
          if (name === 'none' || name === 'auto' || name === 'match-element') {
            continue;
          }
          if (seen.has(name)) return name;
          seen.add(name);
        }
        return '';
      }

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
      // what the boxes were laid out and scrolled as: a look of the page's
      // observers that finds the same skips what it would find again, and
      // one with no such key asks for it each time
      case 'geometry': {
        this.flush();
        return this._seams.handle.geometryKey?.() || `new ${++this._looks}`;
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
      // what the page's `IntersectionObserver`s measure, all of them at
      // once, at a frame (`_intersections`); '' for none, which stops the
      // look after each paint
      case 'intersections': {
        this.flush();
        const query = text(a);
        if (!query) {
          this._intersecting = null;
          return '';
        }
        const answer = this._intersections(query);
        this._intersecting = { query, answer };
        return answer;
      }
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
        const pseudo = computedPseudo(b);
        // a view transition's, which the element answers for its root
        if (typeof b === 'string' && b.startsWith('view-transition')) {
          const style = this._seams.handle.computedStyle(
            this._element(a),
            b as `view-transition${string}`,
          );
          return style ? JSON.stringify(style) : '';
        }
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
        const pseudo = computedPseudo(b);
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
        // where it is scrolled, read after what the page changed is laid
        // out, which can scroll it: a root that became a snap container
        if (a === true) {
          this.flush();
          this._seams.handle.layoutNow?.();
        }
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
      case 'clientBox': {
        this.flush();
        const r = this._seams.handle.clientBox?.(this._element(a));
        return r ? `${r.width},${r.height},${r.top},${r.left}` : '';
      }
      // `checkVisibility`, by whether to ask the opacity and the visibility
      // (`HtmlViewNode.checkVisibility`); a handle without it answers by
      // whether the element has a box
      case 'visible': {
        this.flush();
        const el = this._element(a);
        const asks = { opacity: b === true, visibility: c === true };
        return (
          this._seams.handle.checkVisibility?.(el, asks) ??
          !!this._seams.handle.elementRect(el)
        );
      }
      // and scrolled, an axis left where it is where it is not a number:
      // by `true` for a relative scroll, or for the element a scroll into
      // view brings into view by its id, which a snap lines up
      case 'scrollElement': {
        this.flush();
        const x = typeof b === 'number' && Number.isFinite(b) ? b : undefined;
        const y = typeof c === 'number' && Number.isFinite(c) ? c : undefined;
        const to = this._seams.handle.scrollElementTo(
          this._element(a),
          { x, y },
          d === true,
          typeof d === 'number' ? this._element(d) : null,
        );
        return to ? `${to.x},${to.y}` : '';
      }
      case 'scrollTo': {
        // where the root makes the viewport a snap container, where the
        // scroll comes to rest (`HtmlViewNode.snapViewport`): with the
        // element a scroll into view brings into view by its id, and
        // `scrollBy()`'s the way it went
        const x = Math.max(0, Number(a) || 0);
        const y = Math.max(0, Number(b) || 0);
        const target = typeof c === 'number' ? this._element(c) : null;
        // against the style the page has now, as a scroll is (CSSOM View
        // 4, "perform a scroll" runs after the style is up to date)
        this.flush();
        const to = this._seams.handle.snapViewport?.(
          x,
          y,
          target,
          d === true,
        ) ?? { x, y };
        this._seams.scrollTo(to.x, to.y);
        return null;
      }
      // as the document's own `@media` rules are matched: its width, its
      // scheme, its preference for motion
      case 'media':
        try {
          return this._seams.handle.matchMedia(text(a));
        } catch {
          return false;
        }

      // a document's `@font-face` faces, `document.fonts`'s (CSS Font
      // Loading 3), asked of the view that draws it: the page's, or a
      // frame's
      case 'fontFaces': {
        this.flush();
        return JSON.stringify(this._fontsOf(a)?.fontFaces?.() ?? []);
      }
      // the faces a `font` matches, by key, and whether any matched before
      // their ranges were asked; '' for a `font` that is none
      case 'fontMatch': {
        const query = fontQuery(text(b));
        if (!query) return '';
        this.flush();
        const match = this._fontsOf(a)?.matchFonts?.(query, text(c));
        return JSON.stringify(match ?? { keys: [], found: false });
      }
      // faces loaded by key, and the page told whether each did
      // (`__fontsLoaded`)
      case 'fontLoad': {
        const id = Number(b);
        let keys: string[] = [];
        try {
          const raw: unknown = JSON.parse(text(c));
          if (Array.isArray(raw)) {
            keys = raw.filter((k): k is string => typeof k === 'string');
          }
        } catch {
          // no keys, and nothing loads
        }
        const loading = this._fontsOf(a)?.loadFonts?.(keys);
        const tell = (loaded: boolean[]) => {
          if (!this._disposed)
            this.entries?.call('__fontsLoaded', [id, loaded]);
        };
        if (loading) loading.then(tell, () => tell(keys.map(() => false)));
        else tell(keys.map(() => false));
        return null;
      }
      // the page told once none of the document's faces is on its way
      // (`__fontsSettled`), which `document.fonts.ready` waits for
      case 'fontsSettled': {
        const id = Number(b);
        const tell = () => {
          if (!this._disposed) this.entries?.call('__fontsSettled', [id]);
        };
        const settling = this._fontsOf(a)?.fontsSettled?.();
        if (settling) settling.then(tell, tell);
        else tell();
        return null;
      }

      // the CSS animations under way on an element, or on what it holds,
      // or in the whole document for 0: each with its element by its id
      // a CSS animation's keyframes, by its element, its pseudo-element's
      // key ('' for its own) and its name
      case 'cssKeyframes': {
        this.flush();
        const el = this._element(a);
        const handle = this._drawing(el) as Partial<HandleInternals> | null;
        const frames = handle?.cssKeyframes?.(el, text(b), text(c)) ?? null;
        return frames ? JSON.stringify(frames) : '';
      }
      case 'cssAnimations': {
        // what a script changed is styled before it is asked of
        this.flush();
        const el = a ? this._element(a) : null;
        const list = this._seams.handle.cssAnimations?.(el, b === true) ?? [];
        const id = (e: Element | null) => (e ? this.idOf(e) : 0);
        return JSON.stringify(
          list.map((x) => ({
            ...x,
            element: id(x.element),
            timeline:
              x.timeline.kind === 'scroll'
                ? { ...x.timeline, source: id(x.timeline.source) }
                : x.timeline.kind === 'view'
                  ? { ...x.timeline, subject: id(x.timeline.subject) }
                  : x.timeline,
          })),
        );
      }
      case 'seekTransition':
        this._seams.handle.seekTransition?.(Number(a), Number(b));
        return null;
      case 'cancelCss':
        this._seams.handle.cancelCss?.(
          a === 'animation' ? 'animation' : 'transition',
          Number(b),
        );
        return null;
      case 'seekAnimation':
        this._seams.handle.seekAnimation?.(Number(a), Number(b), c === true);
        return null;
      // a view timeline's subject: its scroller's `scroll-padding` along
      // the axis, and how far sticky positioning moved it and can each way
      case 'viewAdjust': {
        this.flush();
        const el = this._element(a);
        const handle = this._drawing(el) as Partial<HandleInternals> | null;
        const v = handle?.viewAdjust?.(el, b === true);
        return v
          ? `${v.padStart},${v.padEnd},${v.shift},${v.up},${v.down}`
          : '';
      }
      // one on a scroll's timeline: `align`, `start` or `hold`, the time
      // (null to hold it where its timeline has it) and its rate
      case 'seekScrolled':
        this._seams.handle.seekScrolled?.(
          Number(a),
          b === 'start' || b === 'hold' ? b : 'align',
          typeof c === 'number' && Number.isFinite(c) ? c : null,
          Number(d),
        );
        return null;
      case 'cssTransitions': {
        this.flush();
        const el = a ? this._element(a) : null;
        const list = this._seams.handle.cssTransitions?.(el, b === true) ?? [];
        return JSON.stringify(
          list.map((x) => ({ ...x, element: this.idOf(x.element) })),
        );
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
          // and `:playing` and `:paused` read the other
          if (name === 'paused' && setPaused(el, c === true)) {
            this._tell(el, {
              type: 'attributes',
              target: el,
              attributeName: '-rx-paused',
            });
          }
        } else if (
          name === 'seeking' ||
          name === 'buffering' ||
          name === 'stalled'
        ) {
          // `:seeking`, `:buffering` and `:stalled` read them
          if (setMediaFlag(el, name, c === true)) {
            this._tell(el, {
              type: 'attributes',
              target: el,
              attributeName: `-rx-${name}`,
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
      // a text field's selection, as `start end direction`, or '' for
      // what has none; and set, from offsets the page's realm clamped
      case 'selection': {
        const s = this._seams.handle.controlSelection(this._element(a));
        return s ? `${s.start} ${s.end} ${s.direction}` : '';
      }
      case 'setSelection':
        return this._seams.handle.setControlSelection(
          this._element(a),
          Number(b),
          Number(c),
          d === 'forward' || d === 'backward' ? d : 'none',
        );
      // a control's picker shown, `showPicker()`'s last steps (HTML
      // 4.10.5.4): 'unrendered' for a `<select>` with no box to drop a menu
      // from, which the page is refused, and else whether one is down
      case 'showPicker': {
        this.flush();
        const el = this._element(a);
        if (el.name === 'select' && !this._seams.handle.elementRect(el)) {
          return 'unrendered';
        }
        return this._seams.handle.showPicker(el) ? 'shown' : 'none';
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
        if (this._seams.handle.focus(el)) {
          // a stop the render to come mounts the box of, which core's focus
          // follows only then: the element has the focus now, as `focus()`
          // gives it before it returns, and brings it into view — a slide
          // of a carousel was focused a frame late and never scrolled to
          if (this._seams.handle.activeElement !== el && focusableElement(el)) {
            this._focusing = el;
            setTimeout(() => {
              if (!this._disposed && this._focusing === el) {
                this._focusing = null;
              }
            }, 16);
          }
        } else {
          const pending = focusableElement(el);
          if (pending) {
            this._focusing = el;
            // and its focus events now, as a browser's are
            this._seams.handle.toldFocus?.(el);
          }
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
      // whether the page's requests reach a network, which a media element
      // loads its source through
      case 'hasNetwork':
        return this._seams.network === true;
      case 'serviceWorkers':
        return this._seams.serviceWorkers === true;
      case 'image': {
        const el = this._node(a) as Element;
        const state = this._imageDrawn(el)?.imageState?.(el);
        // nothing draws it: as it would be with no image to wait for
        if (!state) return b === 'complete' ? true : b === 'src' ? '' : 0;
        return state[text(b) as keyof typeof state];
      }
      case 'canPlayType': {
        // the three answers HTML has, and none other (4.8.11.3)
        const answer = this._seams.canPlayType?.(text(a)) ?? '';
        return answer === 'probably' || answer === 'maybe' ? answer : '';
      }
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
      case 'promptToUnload':
        return this._seams.promptToUnload?.() !== false;
      // the host's session across documents, where it keeps one: what the
      // page reads as it starts, what its own navigations make of it, and
      // the navigation to another document it starts (`./session.ts`)
      case 'session':
        return this.arrival ? JSON.stringify(sessionView(this.arrival)) : null;
      case 'sessionWrite': {
        if (!this.arrival) return null;
        const written = JSON.parse(text(a)) as {
          entries?: unknown;
          index?: unknown;
        } | null;
        if (!written || !Array.isArray(written.entries)) return null;
        writeSession(
          this.arrival,
          written.entries.filter(
            (e): e is SessionRecord & { mine: boolean } =>
              !!e && typeof e === 'object',
          ),
          Number(written.index) || 0,
        );
        return null;
      }
      case 'sessionPlan': {
        if (!this.arrival) return null;
        const plan = JSON.parse(text(a)) as Record<string, unknown> | null;
        const type = plan?.type;
        if (
          type !== 'push' &&
          type !== 'replace' &&
          type !== 'reload' &&
          type !== 'traverse'
        ) {
          return null;
        }
        planSession(this.arrival, {
          type,
          key: typeof plan?.key === 'string' ? plan.key : undefined,
          navState:
            typeof plan?.navState === 'string' ? plan.navState : undefined,
        });
        return null;
      }
      case 'go':
        this._seams.go(Number(a) || 0);
        return null;
      case 'storage':
        return this._storage(text(a), text(b), text(c), text(d));
      case 'cookie':
        return this._cookie(text(a), text(b), text(c));
      case 'idb':
        return this._idb(text(a), text(b), text(c));
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
      case 'mediaFetch':
        this._mediaFetch(this._element(a), Number(b), text(c));
        return null;
      case 'mediaAbort': {
        const el = this._element(a);
        this._mediaFetches.get(el)?.abort();
        this._mediaFetches.delete(el);
        return null;
      }
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
      if (isImage(target) && IMAGE_ATTRIBUTES.has(name!)) {
        this._imageDrawn(target)?.askImage?.(target);
      }
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
    this._connected(nodes);
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
    // With no range or iterator live, which the removing steps move a
    // child at a time, the children go at once: one at a time, each a
    // search of the list and a splice of it, a page that cleared a table
    // of 10,000 rows spent 66 ms in it.
    const quiet = !this._ranges.watching && !this._iterators.watching;
    for (const kid of removed) {
      if (owner !== this.document) this._owners.set(kid, owner);
      if (quiet) {
        kid.prev = null;
        kid.next = null;
        kid.parent = null;
        continue;
      }
      this._ranges.removing(kid);
      this._iterators.removing(kid);
      DomUtils.removeElement(kid);
    }
    if (quiet) parent.children.length = 0;
    for (const node of nodes) {
      if (this._ownerOf(node) !== owner) this._adopt(node, owner);
      DomUtils.appendChild(parent, node);
    }
    this._ranges.inserted(parent, 0, nodes.length);
    if (removed.length || nodes.length) {
      this._childList(parent, nodes, removed, null, null);
    }
    this._connected(nodes, false);
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
      previousSibling: previous,
      nextSibling: next,
    });
    // a policy a `<meta>` brings is the document's once the element is in
    // its head, and stays when it goes (HTML, the `http-equiv` "Content
    // security policy" state)
    if (added.length && parent instanceof Element && parent.name === 'head') {
      for (const node of added) this._noteCsp(node);
    }
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
            // and a fullscreen element is fullscreen no longer
            // (Fullscreen 2, the removing steps)
            setFullscreen(el, false);
          }
        }
      }
    }
    this._sheetText(parent);
    // a frame taken out unloads its document as the task ends
    if (removed.length && this._framesShown.size) this._framesGone = true;
    // a custom element is connected, and disconnected, in any document
    // (DOM 4.2.3, "insert", and 4.2.3, "remove"): a frame's, or one a page
    // made, as much as this one
    if (this._custom || this._scoped) {
      const root = shadowIncludingRoot(parent);
      if (this._isDocument(root)) {
        if (this._custom) {
          for (const node of removed) this._customLog('d', node);
          for (const node of added) this._customLog('c', node);
        }
        if (this._scoped) {
          for (const node of added) {
            this._scoped.push(['s', this.idOf(node), this.idOf(root)]);
          }
        }
      }
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

  /** A copy, whose custom elements a definition the page has upgrades,
   *  connected or not (DOM 4.5, "clone", which creates each element as
   *  `createElement` does): in any document, since what decides is the
   *  registry each element has, which the facade looks a definition up
   *  in, and a document of no browsing context's has none. */
  private _customMade(node: AnyNode): void {
    this._customLog('u', node);
  }

  /**
   * What `querySelector`, `matches` and `closest` are asked with: the
   * pseudo-classes css-select has no answer of its own for, answered as
   * the document stands. It threw on each, where a browser answers, and a
   * page's script that asked one stopped there: GitHub's ask `:target` as
   * they load. One answered from something no script can see here — the
   * pointer's history, a popover, a full screen — matches nothing.
   */
  /** Whether a selector is one of a view transition's pseudo-elements,
   *  which match nothing; one written as no selector takes it is a
   *  syntax error (`transitionSelectorValid`). */
  private _transitionSelector(selector: string): boolean {
    const valid = transitionSelectorValid(selector);
    if (valid === false) {
      throw new DomError(
        'SyntaxError',
        `'${selector}' is not a valid selector.`,
      );
    }
    return valid === true;
  }

  /** A page's selector less the complex selectors in it that name a
   *  custom highlight, which match no element; null where nothing is
   *  left, and one written as no selector takes it is a syntax error
   *  (`highlightSelectorValid`). */
  private _withoutHighlights(selector: string): string | null {
    const valid = highlightSelectorValid(selector);
    if (valid === null) return selector;
    if (!valid) {
      throw new DomError(
        'SyntaxError',
        `'${selector}' is not a valid selector.`,
      );
    }
    const rest = withoutHighlights(selector);
    return rest.length ? rest.join(', ') : null;
  }

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
      // a details or a dialog by its attribute, and a select by its widget's
      // menu, as the cascade answers them
      open: (el) =>
        el.name === 'details' || el.name === 'dialog'
          ? el.attribs.open !== undefined
          : isPickerOpen(el),
      closed: (el) =>
        el.name === 'details' || el.name === 'dialog'
          ? el.attribs.open === undefined
          : isDropDown(el) && !isPickerOpen(el),
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
      'active-view-transition': (el) => inActiveTransition(el),
      'active-view-transition-type': (el, types) =>
        !!types &&
        inActiveTransition(
          el,
          String(types)
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      muted: (el) => isMuted(el),
      playing: (el) => isPaused(el) === false,
      paused: (el) => isPaused(el) === true,
      seeking: (el) => hasMediaFlag(el, 'seeking'),
      buffering: (el) => hasMediaFlag(el, 'buffering'),
      stalled: (el) => hasMediaFlag(el, 'stalled'),
      // a page cannot lock a volume, and nothing here does
      'volume-locked': nothing,
      fullscreen: (el) => isFullscreen(el),
      autofill: nothing,
      '-webkit-autofill': nothing,
      'user-valid': nothing,
      'user-invalid': nothing,
      indeterminate: nothing,
      host: nothing,
    };
    return (this._pseudos = { pseudos });
  }
  private _pseudos: ReturnType<DomHost['_selectOptions']> | null = null;

  /** The options a page's own query is compiled with (`_query`). */
  private _queryOptions(): ReturnType<DomHost['_selectOptions']> & {
    relativeSelector: false;
  } {
    return (this._queryOpts ??= {
      ...this._selectOptions(),
      relativeSelector: false,
    });
  }
  private _queryOpts: ReturnType<DomHost['_queryOptions']> | null = null;

  /**
   * A selector of the page's own — `querySelector`, `matches`, `closest` —
   * compiled as the DOM matches one (DOM 4.2.6): against the whole
   * document, with `:scope` the node it is asked from, and no relative
   * selector, which throws. css-select reads a query from an element as
   * jQuery does, `:scope .a .b`, and `el.querySelectorAll('.a .b')` found
   * none whose `.a` was above `el`. One that names no `:scope` and keeps
   * no answers (a `:has()` or a `:contains()` does, `KEEPS_ANSWERS` in the
   * cascade) is compiled once: GitHub's scripts ask the same few hundred
   * selectors thousands of times a load.
   */
  private _query(selector: string, scope: AnyNode): (el: Element) => boolean {
    const keeps = !QUERY_SCOPED.test(selector) && !KEEPS_ANSWERS.test(selector);
    const kept = keeps ? this._queries.get(selector) : undefined;
    if (kept) return kept;
    const query = compile(
      selector,
      this._queryOptions() as Parameters<typeof compile>[1],
      keeps ? undefined : (scope as Element),
    ) as unknown as (el: Element) => boolean;
    if (keeps) {
      if (this._queries.size >= KEPT_QUERIES) this._queries.clear();
      this._queries.set(selector, query);
    }
    return query;
  }
  private readonly _queries = new Map<string, (el: Element) => boolean>();

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
  /** The view that draws the document a page's `document.fonts` is of,
   *  by the document's id. */
  private _fontsOf(id: Primitive): Partial<HandleInternals> | null {
    return this._drawing(this._node(id)) as Partial<HandleInternals> | null;
  }

  /** The `<Html>` that draws the document an `<img>` is its node
   *  document's, in the document or out of it: an image a page made is
   *  loaded wherever it is. None for what is in a `<template>`, whose
   *  images load nothing until they are used, nor for a document nothing
   *  draws, which HTML has no reason to load for. */
  private _imageDrawn(el: Element): Partial<HandleInternals> | null {
    if (this._inTemplate(el)) return null;
    const owner = this._ownerOf(el);
    return (
      ((owner === this.document
        ? this._seams.handle
        : this._s.drawn.get(owner)) as Partial<HandleInternals> | undefined) ??
      null
    );
  }

  /** The `<img>`s in what a page's script made out of the document, which
   *  `<Html>` meets in no tree it reads: `innerHTML` on an element of its
   *  own, and a copy. */
  private _imagesMade(nodes: readonly AnyNode[]): void {
    for (const el of DomUtils.findAll(isImage, nodes as AnyNode[])) {
      if (el.attribs.src === undefined && el.attribs.srcset === undefined) {
        continue;
      }
      this._imageDrawn(el)?.askImage?.(el);
    }
  }

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

  /** The page's selection, the live range by its id (`documentCaret`). */
  private _caret = 0;
  /** Where `<Html>` was last told its caret is, as a key: the node's id
   *  and the offset, or '' for none. */
  private _caretTold = '';

  /** Tell the document where the page's selection is collapsed, where that
   *  moved: the range is live, so an edit before it moves it with no word
   *  from the page, and it is read again at each flush, as the highlights
   *  are. A caret in another document than this realm's is none. */
  private _syncCaret(): void {
    let point: { node: AnyNode; offset: number } | null = null;
    if (this._caret) {
      try {
        const r = this._ranges.get(this._caret);
        if (r.sc === r.ec && r.so === r.eo && this._inDocument(r.sc)) {
          point = { node: r.sc, offset: r.so };
        }
      } catch {
        // a range the page has let go of
      }
    }
    const key = point ? `${this.idOf(point.node)},${point.offset}` : '';
    if (key === this._caretTold) return;
    this._caretTold = key;
    this._seams.handle.setCaret?.(point);
  }

  /** The custom highlights of each document's registry, as `highlights`
   *  was last told them: the page's, and a frame's window's. */
  private readonly _highlightSpecs = new Map<Document, HighlightSpec[]>();
  /** What each document's `<Html>` was last told of them, as a key: their
   *  names, priorities and ranges' boundary points. */
  private readonly _highlightsTold = new Map<Document, string>();

  /** Tell each document its custom highlights where they changed: their
   *  live ranges move with the tree, so they are read again at each flush,
   *  and told only where a boundary, a name or a priority moved. A range
   *  in another document than its registry's is drawn in neither (CSS
   *  Highlight API 1, 3.2). A frame's that no `<Html>` draws yet is told
   *  once one does. */
  private _syncHighlights(): void {
    if (!this._highlightSpecs.size) return;
    for (const [doc, spec] of this._highlightSpecs) {
      const handle: (HtmlHandle & Partial<HandleInternals>) | undefined =
        doc === this.document ? this._seams.handle : this._s.drawn.get(doc);
      if (!handle) continue;
      const resolved: HighlightRanges[] = [];
      const key: string[] = [];
      for (const h of spec) {
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
          if (
            shadowIncludingRoot(point.sc) !== doc ||
            shadowIncludingRoot(point.ec) !== doc
          ) {
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
      if (told === (this._highlightsTold.get(doc) ?? '')) {
        if (!spec.length) {
          this._highlightSpecs.delete(doc);
          this._highlightsTold.delete(doc);
        }
        continue;
      }
      this._highlightsTold.set(doc, told);
      handle.setHighlights?.(resolved);
    }
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
    for (const el of elementsIn(doc, () => true)) {
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
    // up to the document it is in, through the host of a shadow tree
    let at: AnyNode = node;
    for (;;) {
      while (at.parent) at = at.parent;
      if (!(at instanceof ShadowRoot) || !at.host) break;
      at = at.host;
    }
    // A node in no document — what a script builds before it puts it in —
    // changes nothing drawn, and the change that puts it in is told with
    // all it holds. Told, they were most of a change: a webmail page's
    // list builds thirty messages, a thousand elements, apart and puts
    // them in, and the records of the building passed what a change is
    // told as (`CHANGES_TOLD`), so the whole page was styled and built
    // again, three seconds, at every page of messages a scroll loaded.
    if (!this._isDocument(at)) return;
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
      this._initialBlank.add(doc);
      this._loadFrame(frame);
    }
    return this._sameOrigin(this._frameAt.get(frame)!) ? doc : null;
  }

  /** Each frame's first `about:blank` document, its initial one (HTML
   *  7.3.1), whose navigations a page's `navigation` tells nothing of. */
  private _initialBlank = new WeakSet<Document>();

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
    return (
      url === 'about:blank' ||
      url === 'about:srcdoc' ||
      originOf(url) === this._origin()
    );
  }

  /**
   * Whether an attribute set (`set`) or removed sends a frame that has a
   * document to the one its attributes now name (HTML 4.8.5, "process the
   * iframe attributes"): an iframe's `srcdoc` set, changed or removed, and
   * a frame's `src` where it has no `srcdoc`, which shows the document it
   * holds whatever the `src`; an `<object>`'s `data` set. A playground's
   * React gives an `<iframe>` the server rendered its `srcdoc` after the
   * frame had its first `about:blank`, and the frame stayed blank.
   */
  private _sendsFrame(el: Element, name: string, set: boolean): boolean {
    if (!this._frames.has(el) || !this._inDocument(el)) return false;
    if (el.name === 'object') return set && name === 'data';
    if (name === 'srcdoc') return el.name === 'iframe';
    return name === 'src' && !(el.name === 'iframe' && 'srcdoc' in el.attribs);
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
    // an `<iframe srcdoc>` shows the document its attribute holds, before
    // any `src` (HTML 4.8.5), until something sends it elsewhere
    const srcdoc =
      frame.name === 'iframe' && !this._frameSent.has(frame)
        ? frame.attribs.srcdoc
        : undefined;
    if (srcdoc !== undefined) {
      setTimeout(() => {
        if (this._disposed || this._frameLoads.get(frame) !== serial) return;
        this._frameLoaded(
          frame,
          this._documentOf(srcdoc, true, !!this._seams.drawsFrames),
          'about:srcdoc',
          'text/html',
          true,
          loaded,
        );
      }, 0);
      return;
    }
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
      if (!navigated) {
        if (src) this._frameAt.set(frame, src);
        setTimeout(loaded, 0);
        return;
      }
      // a navigation from the document the frame shows, which goes in a
      // task of its own once that one is unloaded, as one fetched does
      setTimeout(() => {
        if (this._disposed || this._frameLoads.get(frame) !== serial) return;
        this._unloadFrameDocument(frame);
        if (src) this._frameAt.set(frame, src);
        else this._blankFrame(frame);
        loaded();
      }, 0);
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
        this._frameLoaded(
          frame,
          doc,
          response.url || src,
          type,
          scripts,
          loaded,
        );
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
   * A frame's document is going — another goes in its place, or the frame
   * left the document — and unloads in this realm (HTML 7.4.2.4) while the
   * frame still shows it, where it is one of this realm's that the page has
   * reached: one with a realm of its own unloads as its runner goes, and a
   * frame's initial `about:blank` is never shown.
   */
  private _unloadFrameDocument(frame: Element): void {
    const old = this._frames.get(frame);
    if (!old || !this.entries || this._disposed || !this._ids.has(old)) return;
    if (this._initialBlank.has(old) || this._s.realms.has(old)) return;
    this._framesShown.delete(frame);
    this.entries.call('__unloadDocument', [this.idOf(old)]);
  }

  /** The frames in the document showing one of this realm's documents,
   *  whose leaving the document unloads it (`_framesLeft`), and whether
   *  one may have since the last task. */
  private _framesShown = new Set<Element>();
  private _framesGone = false;

  /** The frames that left the document since the last task: their
   *  documents unload, at the end of the task that took them out. */
  private _framesLeft(): void {
    this._framesGone = false;
    for (const frame of [...this._framesShown]) {
      if (!this._inDocument(frame)) this._unloadFrameDocument(frame);
    }
  }

  /** A frame's new document, from `address`, put in the frame: its
   *  scripts run, where it may run any, and its `load` told. */
  private _frameLoaded(
    frame: Element,
    doc: Document,
    address: string,
    type: string,
    scripts: boolean,
    loaded: () => void,
  ): void {
    // a frame the browser draws runs its own scripts, and tells its own
    // `load` once they have, in a realm of its own — where it has any: a
    // document with none has no code to want globals of its own, and the
    // page's realm reaches into it at once, as Acid3's do into theirs,
    // where a realm would answer once React had mounted it
    const realm =
      !!this._seams.drawsFrames && type === 'text/html' && hasScripts(doc);
    if (realm) this._s.realms.add(doc);
    // the one it shows unloads first, while it is still the frame's
    this._unloadFrameDocument(frame);
    if (this._disposed) return;
    this._frames.set(frame, doc);
    this._frameOf.set(doc, frame);
    this._frameAt.set(frame, address);
    this._s.frameList.add(frame);
    this._s.framesChanged();
    if (realm) return;
    if (this._inDocument(frame)) this._framesShown.add(frame);
    if (scripts) {
      this._frameScripts(doc, address === 'about:srcdoc' ? this.url : address);
    }
    loaded();
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
      // made, as the HTML parser makes one, of no registry where it says
      // so, and so what it holds (HTML's scoped registries)
      markParsedRegistry(el);
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
    for (const frame of DomUtils.findAll(
      (el) => FRAME_TAGS.has(el.name),
      nodes as AnyNode[],
    )) {
      this._frameIn(frame);
    }
  }

  /** A frame put in, loaded where it is in the document and has no
   *  document yet. */
  private _frameIn(frame: Element): void {
    if (frame.name === 'object' && !frame.attribs.data) return;
    if (!this._frames.has(frame) && this._inDocument(frame)) {
      this._frameDocument(frame);
    }
  }

  /** What a page's script put into its tree, as HTML's post-connection
   *  steps take it (DOM 4.2.3, "insert"), in tree order once all of it is
   *  in: a frame loaded, a script prepared. What replaces all a parent
   *  holds loads no frame here (`frames`), as it never has. */
  private _connected(nodes: readonly AnyNode[], frames = true): void {
    const found = DomUtils.findAll(
      (el) => el.name === 'script' || (frames && FRAME_TAGS.has(el.name)),
      nodes as AnyNode[],
    );
    for (const el of found) {
      if (this._disposed) return;
      if (el.name === 'script') this._prepareScript(el);
      else this._frameIn(el);
    }
  }

  /**
   * A script a page's script put into its document, prepared as HTML
   * prepares one that becomes connected (4.12.1.1): an inline classic one
   * runs now, inside the insertion, as a script of its own
   * (`ScriptEngine.exec`), and is started for good (`inert`). Google's
   * sign-in page puts its BotGuard program in a `<script>`, takes it out
   * again at once and reads the global the program made, as jQuery's
   * `globalEval` does; met as `<Html>` next read the tree, it ran a task
   * late, or, taken out by then, never, and the page threw. On Node the
   * context runs the microtasks queued so far as the script ends
   * (`microtaskMode: 'afterEvaluate'`), where HTML leaves them for the end
   * of the outer script, as it does for a worker's `importScripts`
   * (`ScriptEngine.runNested`).
   *
   * One with a `src`, and a module, is handed to the runner now
   * (`scriptConnected`), which fetches it and runs it when HTML would.
   * Met as `<Html>` next read the tree, they were met in the document's
   * order, and Google's module loader puts each module it loads at the top
   * of the `<head>`, so the modules it needs run in the order it put them
   * in (`inOrder`) were met backwards: on Google Photos' shared albums a
   * module ran before the one defining a class it needs. An empty one is
   * still met as `<Html>` reads the tree.
   */
  private _prepareScript(el: Element): void {
    const exec = this.entries?.exec;
    if (!exec || this.inert.has(el) || el.namespace) return;
    if (!this._inDocument(el)) return;
    const { attribs } = el;
    const type = attribs.type ?? '';
    const classic = isClassicScriptType(type);
    const module = type.split(';')[0].trim().toLowerCase() === 'module';
    if (!classic && !module) return;
    // its child text content: the text of its children, and not of what
    // they hold
    let code = '';
    for (const kid of el.children) if (kid instanceof Text) code += kid.data;
    if (attribs.src !== undefined || module) {
      const src = attribs.src;
      this.scriptConnected?.({
        type: (type || 'text/javascript').toLowerCase(),
        src: src === undefined ? null : src && this._resolve(src),
        text: code,
        element: el,
      });
      return;
    }
    if (attribs.nomodule !== undefined || !code) return;
    this.inert.add(el);
    exec.call(this.entries, code, this.url, this.idOf(el));
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
    pseudo: ComputedPseudo,
  ): Record<string, string> | null {
    const style = this._frameComputed(el, pseudo);
    return style ? cssomStyle(style, 1, null) : null;
  }

  /** `_frameStyle`, as the cascade computed it. */
  private _frameComputed(
    el: Element,
    pseudo: ComputedPseudo,
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
    if (pseudo === 'before' || pseudo === 'after') {
      return cascade.pseudoComputedStyle(el, pseudo, style);
    }
    const name = pseudo ? highlightKey(pseudo) : null;
    if (name === null) return style;
    // a highlight's, each over its parent's (`Cascade.highlightPseudoStyle`)
    const chain: Element[] = [];
    for (let at: AnyNode | null = el; at instanceof Element; at = at.parent) {
      chain.push(at);
    }
    let found: HighlightPseudoStyle | null = null;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      found = cascade.highlightPseudoStyle(
        chain[i],
        styleOf(chain[i]),
        name,
        found,
      );
    }
    return found?.style ?? null;
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

  /** The page's peer connections, made the first time it makes one. */
  private _peersMade: PagePeers | null = null;
  private _peers(): PagePeers {
    if (!this._peersMade) {
      this._peersMade = new PagePeers({
        webRTC: () => this._seams.webRTC,
        origin: () => this._origin(),
        sources: () => this._sources(),
        tell: (name, input) => {
          if (!this._disposed) this.entries?.call(name, input);
        },
        toWorker: (worker, message) => this.workers?.rtc?.(worker, message),
        toPage: (message) => this.workerScope?.rtc?.(message),
      });
    }
    return this._peersMade;
  }

  /** A worker asked of a data channel this page handed it. */
  rtcFromWorker(worker: number, message: ChannelRelay): void {
    this._peers().fromWorker(worker, message);
  }

  /** In a worker: what became of a data channel the page handed it. */
  rtcHeard(message: ChannelRelay): void {
    this._peers().heard(message);
  }

  /** The page's media sources, made the first time it asks for one. */
  private _sourcesMade: PageSources | null = null;
  private _sources(): PageSources {
    if (!this._sourcesMade) {
      this._sourcesMade = new PageSources({
        devices: () => this._seams.mediaDevices,
        origin: () => this._origin(),
        tell: (name, input) => {
          if (!this._disposed) this.entries?.call(name, input);
        },
        canvas: (id) => {
          const node = this._nodes.get(id);
          if (!(node instanceof Element) || node.name !== 'canvas') return null;
          return {
            pixels: () => this.canvas(node),
            watch: (changed) =>
              this.onCanvas((canvas) => {
                if (canvas === node) changed();
              }),
          };
        },
      });
    }
    return this._sourcesMade;
  }

  /** The page's WebTransport sessions, made the first time it opens one. */
  private _transportsMade: PageTransports | null = null;
  private _transports(): PageTransports {
    if (!this._transportsMade) {
      this._transportsMade = new PageTransports({
        connector: () => this._seams.webTransport,
        origin: () => this._origin(),
        policies: () => this._cspPolicies(),
        log: (level, text) => this._seams.log(level, text),
        tell: (name, input) => {
          if (!this._disposed) this.entries?.call(name, input);
        },
      });
    }
    return this._transportsMade;
  }

  /** The page's WebSockets, made the first time it opens one. */
  private _socketsMade: PageSockets | null = null;
  private _sockets(): PageSockets {
    if (!this._socketsMade) {
      this._socketsMade = new PageSockets({
        connector: () => this._seams.webSocket,
        origin: () => this._origin(),
        policies: () => this._cspPolicies(),
        log: (level, text) => this._seams.log(level, text),
        tell: (name, input) => {
          if (!this._disposed) this.entries?.call(name, input);
        },
      });
    }
    return this._socketsMade;
  }

  /** The document's Content Security Policies, by their text, in the
   *  order they were met: a policy stays once a `<meta>` brought it, as a
   *  browser keeps it after the element goes (HTML, the `http-equiv`
   *  "Content security policy" state). */
  private _csp = new Map<string, CspPolicy>();
  /** The policy a `<meta http-equiv="Content-Security-Policy">` brings,
   *  kept. */
  private _noteCsp(node: AnyNode): void {
    if (
      node instanceof Element &&
      node.name === 'meta' &&
      (node.attribs['http-equiv'] ?? '').trim().toLowerCase() ===
        'content-security-policy'
    ) {
      const text = node.attribs.content ?? '';
      if (!this._csp.has(text)) this._csp.set(text, parseCsp(text));
    }
  }
  /** The document's policies: those a script's `<meta>`s brought as they
   *  were put in its head, and those the parser's are in it now. */
  private _cspPolicies(): CspPolicy[] {
    const head = DomUtils.findOne(
      (e) => e.name === 'head',
      this.document.children,
      true,
    );
    for (const child of head?.children ?? []) this._noteCsp(child);
    return [...this._csp.values()];
  }

  /** This host's token, which its storage changes carry. */
  private readonly _token = `h${++hostTokens}`;
  private _unwatchStorage: (() => void) | null = null;

  /** Where the page's storage is kept: the host's, or the process's
   *  memory. */
  private _storageOf(): HtmlStorage {
    return this._seams.storage ?? defaultStorage();
  }

  /**
   * `localStorage` and `sessionStorage` (HTML 12.2), the origin's area in
   * the host's storage. A change that changed something is told to the
   * other documents of the origin (12.2.4): a key set to what it holds, one
   * removed that was not there and an area cleared that was empty are none.
   */
  private _storage(
    kind: string,
    op: string,
    key: string,
    value: string,
  ): Primitive {
    const storage = this._storageOf();
    const origin = this._origin();
    const area =
      kind === 'session' ? storage.session(origin) : storage.local(origin);
    const tell = (
      changed: string | null,
      oldValue: string | null,
      newValue: string | null,
    ) =>
      storage.tell?.({
        kind: kind === 'session' ? 'session' : 'local',
        origin,
        key: changed,
        oldValue,
        newValue,
        url: this.url,
        source: this._token,
      });
    switch (op) {
      case 'get':
        return area.get(key);
      case 'set': {
        const old = area.get(key);
        if (!area.set(key, value)) {
          throw new DomError(
            'QuotaExceededError',
            `Setting the value of '${key}' exceeded the quota.`,
          );
        }
        if (old !== value) tell(key, old, value);
        return null;
      }
      case 'remove': {
        const old = area.get(key);
        if (old === null) return null;
        area.remove(key);
        tell(key, old, null);
        return null;
      }
      case 'clear':
        if (!area.keys().length) return null;
        area.clear();
        tell(null, null, null);
        return null;
      case 'keys':
        return area.keys().join('\u0000');
      default:
        return null;
    }
  }

  /** Another document's change to the storage of this one's origin, told
   *  to the page as a `storage` event — its tab's, for `sessionStorage`,
   *  which only this process's documents share. */
  private _storageChanged(change: HtmlStorageChange): void {
    if (this._disposed || change.source === this._token) return;
    if (change.origin !== this._origin()) return;
    this.entries?.call('__storage', [
      change.kind,
      change.key,
      change.oldValue,
      change.newValue,
      change.url,
    ]);
  }

  /**
   * `document.cookie` and `cookieStore` (HTML 3.1.3; Cookie Store API),
   * through the host's jar, for the document at `url` — which must be of
   * this realm's origin, whatever the page claims, and on the web: any
   * other document is cookie-averse, and reads ''.
   */
  private _cookie(op: string, url: string, arg: string): Primitive {
    const jar = this._seams.cookies;
    if (op === 'enabled') return !!jar;
    const averse =
      !jar || !/^https?:/i.test(url) || originOf(url) !== this._origin();
    const top = this._s.top;
    switch (op) {
      case 'get':
        return averse ? '' : jar.documentCookie(url, top);
      case 'set':
        if (!averse) jar.setDocumentCookie(url, arg, top);
        return null;
      case 'list': {
        if (averse) return '[]';
        const name = arg ? (JSON.parse(arg) as string) : undefined;
        return JSON.stringify(jar.list(url, top, name));
      }
      case 'store':
        return averse ? false : jar.setFromInit(url, JSON.parse(arg), top);
      default:
        return null;
    }
  }

  /**
   * IndexedDB past the document (`HtmlStorage.indexedDB`): what the page's
   * realm reads a database from as it opens it, and writes each committed
   * transaction to, as text it encoded. `on` answers whether there is such
   * a store; with none, a database is the realm's alone, as it always was.
   */
  private _idb(op: string, name: string, json: string): Primitive {
    const idb = this._storageOf().indexedDB;
    const origin = this._origin();
    if (op === 'on') return !!idb && origin !== 'null';
    if (!idb || origin === 'null') return null;
    switch (op) {
      case 'list':
        return JSON.stringify(idb.list(origin));
      case 'load': {
        const snapshot = idb.load(origin, name);
        return snapshot ? JSON.stringify(snapshot) : null;
      }
      case 'stamp':
        return idb.stamp(origin, name);
      case 'commit':
        return idb.commit(origin, name, JSON.parse(json));
      case 'delete':
        idb.delete(origin, name);
        return null;
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
        ...(raw.streamedBody === true ? { streamedBody: true } : {}),
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
   * A media element's source, fetched through the page's network as a
   * browser fetches one — `no-cors`, read by the browser and never by the
   * page — until its container's head says how long it is and a little
   * past that (`MediaReader`), and let go: the rest is the player's to
   * fetch. The page is told what it came to (`__media`): how much has
   * arrived, the duration and the size, that there is data past the
   * head, that there is enough, or that it failed.
   */
  private _mediaFetch(el: Element, load: number, url: string): void {
    this._mediaFetches.get(el)?.abort();
    const controller = new AbortController();
    this._mediaFetches.set(el, controller);
    const id = this.idOf(el);
    const tell = (kind: string, ...args: string[]): void => {
      if (controller.signal.aborted || this._disposed) return;
      this.entries?.call('__media', [id, load, kind, ...args]);
    };
    const run = async (): Promise<void> => {
      let response: FetchResponse;
      try {
        // from its start, as a browser asks for a media resource, so the
        // server answers a range it can go on with (HTML 4.8.11.5)
        response = await this._seams.fetch(
          {
            url,
            method: 'GET',
            headers: [['range', 'bytes=0-']],
            body: null,
            stream: true,
            // a media element's request is `no-cors`, with its cookies
            credentials: 'include',
          },
          controller.signal,
        );
      } catch {
        tell('failed');
        return;
      }
      if (controller.signal.aborted) {
        release(response);
        return;
      }
      if (response.status && (response.status < 200 || response.status > 299)) {
        release(response);
        tell('failed');
        return;
      }
      const length = Number(
        response.headers.find(
          ([k]) => k.toLowerCase() === 'content-length',
        )?.[1],
      );
      const reader = new MediaReader(length > 0 ? length : null);
      let told = 0;
      /** What has arrived told, as far as it goes: true where it is all
       *  that is wanted. */
      const step = (complete: boolean): boolean => {
        const head = reader.read(complete);
        if (head === null) {
          tell('failed');
          return true;
        }
        if (head === 'more') return false;
        if (told < 1) {
          told = 1;
          tell(
            'info',
            String(head.duration),
            String(head.width),
            String(head.height),
          );
        }
        if (told < 2 && (reader.received > head.end || complete)) {
          told = 2;
          tell('data');
        }
        if (complete || reader.received >= head.end + MEDIA_ENOUGH) {
          tell('enough');
          return true;
        }
        return false;
      };
      const chunks = response.chunks ?? [
        response.bytes ?? Buffer.from(response.body ?? '', 'latin1'),
      ];
      try {
        for await (const chunk of chunks) {
          if (controller.signal.aborted) return;
          reader.add(chunk);
          tell('progress', String(reader.received));
          if (step(false)) return;
        }
      } catch {
        tell('failed');
        return;
      }
      step(true);
    };
    void run().finally(() => {
      controller.abort();
      if (this._mediaFetches.get(el) === controller) {
        this._mediaFetches.delete(el);
      }
    });
  }

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
      ...(request.streamedBody ? { streamedBody: true } : {}),
      credentials: request.credentials,
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
    // a preflight carries no cookies (Fetch 4.9)
    const response = await this._seams.fetch(
      {
        url: request.url,
        method: 'OPTIONS',
        headers,
        body: null,
        credentials: 'omit',
      },
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
