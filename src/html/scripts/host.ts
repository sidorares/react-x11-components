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
import { trustworthy } from '../fetch-metadata.js';
import type { FetchMode } from '../fetch-metadata.js';
import {
  determineReferrer,
  referrerPolicyOf,
  referrerPolicyOfHeaders,
  referrerPolicyOfMeta,
} from '../referrer.js';
import type { ReferrerPolicy } from '../referrer.js';
import * as encodingCodecs from '../encoding-codecs.js';
import type { LegacyDecoder } from '../encoding-codecs.js';
import {
  adoptEncodings,
  decodeInEncoding,
  encodingOf,
  outputEncoding,
  sniffEncoding,
  sniffXmlEncoding,
} from '../encoding.js';
import * as DomUtils from 'domutils';
import { compile, selectAll, selectOne } from 'css-select';
import {
  Comment,
  Document,
  Element,
  ProcessingInstruction,
  Text,
} from 'domhandler';
import { isTag } from 'domhandler';
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
import type { ImageResponse } from '../resources.js';
import type { MediaEventKind } from '../media.js';
import { attachShadow, parseFragment, shadowRootOf } from '../index.js';
import type { AdoptedSheet } from '../dom.js';
import {
  HtmlSource,
  ShadowRoot,
  parsedForm,
  indicatedElement,
  isCustomized,
  assignedSlot,
  isDefinedElement,
  isForeign,
  isStyleOrScript,
  isStylePreload,
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
  setCustomStates,
  parsedNullRegistries,
  parsedWithNullRegistry,
  setModal,
  setPopoverOpen,
  shadowRootAround,
  flatParentOf,
  topLayerIn,
  topLayerOf,
  treeGeneration,
  treesChanged,
  isClassicScriptType,
  namespaceFor,
  namespaceIn,
  namespaceOf,
  ATTRIBUTE_SPACES,
  CDATA_SECTIONS,
  MADE_AS_HTML,
  XML_DOCUMENTS,
  anyXmlDocuments,
  instructionSheets,
  isXmlType,
  localNameOf,
  markXmlDocument,
  parserError,
  tagOf,
  typeNameOf,
  setSheetDisabled,
  xmlTree,
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
import { eventPath, retarget, shadowIncludingHolds } from './event-path.js';
import { NO_MODIFIERS } from '../dom-events.js';
import {
  Cascade,
  NAMESPACE_PSEUDOS,
  compileHoisted,
  highlightKey,
} from '../css/cascade.js';
import type { HighlightPseudoStyle } from '../css/cascade.js';
import { uaStylesheet } from '../css/ua.js';
import {
  SHORTHAND_NAMES,
  comesFromBox,
  cssomShorthands,
  cssomStyle,
} from '../computed.js';
import { declaredProperties, fontQuery } from '../css/style.js';
import type { ComputedStyle, FontQuery, RootLook } from '../css/style.js';
import type { CanvasText } from '../canvas-text.js';
import type { DocumentFontFace, FontMatch, WebFonts } from '../fonts.js';
import type { FontFaceInit, Stylesheet } from '../css/parse.js';
import {
  mediaMatches,
  parseDeclarations,
  parseMediaQuery,
  parseStylesheet,
  qualifiedSelector,
  scriptFontFace,
  selectorList,
  supportsCondition,
} from '../css/parse.js';
import { closeBrackets, hasVar } from '../css/vars.js';
import {
  PageZlib,
  closeChannel,
  openChannel,
  postChannel,
  queryLocks,
  releaseClient,
  releaseLock,
  requestLock,
} from './page-channels.js';
import type { ChannelEnd } from './page-channels.js';
import { drawnWithin, svgAnswer, unitSize } from './svg-geometry.js';
import { SVG_PROPERTIES } from '../css/svg-properties.js';
import type { SvgMeasure } from './svg-geometry.js';
import { matchesSyntax, validSyntax } from '../css/syntax.js';
import { focusableElement } from '../focus.js';
import { CONTROL_PSEUDOS } from '../control-state.js';
import { serializeXml } from './xml.js';
import { XAttr, compileXPath, evaluateXPath, prefixesIn } from './xpath.js';
import type { CompiledXPath, XNode } from './xpath.js';
import {
  checkedDefault,
  controlChange,
  controlsMoved,
  indeterminateSet,
  isDisabled,
  markFormAssociated,
  setCheckedDefault,
  setCustomError,
  setIndeterminate,
  validated,
  validityError,
} from '../form.js';
import type { Bridge, Primitive } from './dom.js';
import { PageCrypto, keySecrets } from './subtle.js';
import {
  LiveRange,
  NodeIterators,
  Ranges,
  indexOf,
  isDoctype,
} from './ranges.js';
import type { CharacterData } from './ranges.js';
import { linkOpener, navigableFor } from './target.js';
import { parseWindowFeatures } from '../popups.js';
import type { HtmlNavigationSource, HtmlPopup, HtmlPopups } from '../popups.js';
import type { PopupAsk, WindowGroup, windowOps } from './popups.js';
import {
  CorsError,
  agentHeaders,
  corsCheck,
  forbiddenMethod,
  headerOf,
  nextHop,
  isRedirectStatus,
  redirectOf,
  redirectTainted,
} from './fetch-hops.js';
import type { Hop } from './fetch-hops.js';
import { readDataUrl } from '../network.js';
import {
  SB_DOWNLOADS,
  SB_FORMS,
  SB_ORIGIN,
  SB_POPUPS,
  SB_PROPAGATES,
  SB_SCRIPTS,
  SB_TOP,
  SB_TOP_GESTURE,
  parseSandbox,
  sandboxOfPolicy,
} from './sandbox.js';
import { framingRefused } from './framing.js';
import { planSession, sessionView, writeSession } from './session.js';
import type { SessionArrival, SessionRecord } from './session.js';
import { withoutFragmentDirective } from '../text-fragments.js';
import {
  isPlaylist,
  MEDIA_ENOUGH,
  MEDIA_MOST,
  MediaReader,
  readPlaylist,
} from './media.js';
import type { Playlist } from './media.js';
import { removeClip, VideoClips, writeClip } from './clips.js';
import { Feeds, feedTakes } from './feeds.js';
import type { AppendParams } from './feeds.js';
import { serve, unserve } from './loopback.js';
import { PageContexts } from './gl.js';
import { PageSources } from './media-sources.js';
import type { HtmlGLOptions, HtmlWebGL } from '../webgl.js';
import { PagePeers } from './peers.js';
import type { ChannelRelay } from './peers.js';
import { PageTransports } from './transports.js';
import { PageSockets } from './sockets.js';
import { connectAllowed, parseCsp } from '../csp.js';
import type { CspPolicy } from '../csp.js';
import type { HtmlDocumentCookies } from '../cookies.js';
import { defaultStorage } from '../storage.js';
import { askCaches } from '../cache-storage.js';
import type {
  HtmlCacheAnswer,
  HtmlCacheAsk,
  HtmlCacheStore,
} from '../cache-storage.js';
import type {
  HtmlServiceWorkerRequest,
  HtmlServiceWorkers,
} from '../service-workers.js';
import type { ServiceClient } from './sw-registry.js';
import type { HtmlStorage, HtmlStorageChange } from '../storage.js';
import type { HtmlMediaDevices } from '../media-devices.js';
import type { HtmlWebRTC } from '../rtc.js';
import type { HtmlWebTransport } from '../transport.js';
import type { HtmlWebSocket } from '../socket.js';
import { chosenFiles, formEncoding, urlencoded } from '../form.js';
import type { HtmlSyncNetwork } from '../network.js';
import { fetchSync } from './sync-fetch.js';
import type { HtmlDownloadRequest } from '../download.js';
import type { HtmlFile } from '../files.js';
import { clipboardOfWire, clipboardWire } from '../clipboard.js';
import type { HtmlClipboard } from '../clipboard.js';
import type { HtmlPermissions, HtmlPermissionState } from '../permissions.js';
import { PERMISSION_NAMES, POLICY_FEATURES } from '../permissions.js';
import type {
  HtmlNotification,
  HtmlNotifications,
  HtmlShownNotification,
} from '../notifications.js';
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
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

/** A context's setting of its text as it crosses: its direction, its
 *  spacings in CSS pixels, its kerning and its capitals. */
const textSetting = ([direction, letter, word, kerning, caps]: string[]) => ({
  direction: direction === 'rtl' ? ('rtl' as const) : ('ltr' as const),
  letterSpacing: Number(letter) || 0,
  wordSpacing: Number(word) || 0,
  kerning: kerning ?? 'auto',
  caps: caps || null,
});

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
  /**
   * Whether a redirect is followed, or answered as it is so that the host
   * can take the next hop itself (`fetch-hops.ts`), which is how a page's
   * request gets the CORS, the preflight and the credentials each hop owes.
   * Absent, `follow`. A network that follows all the same says `redirected`,
   * and what it answers is held to where it landed. The host asks for
   * `manual` alone: `error` is a page's, kept for a worker's `fetch` event.
   */
  redirect?: 'follow' | 'error' | 'manual';
  /** Whether its `Origin` is `null`, whatever its client's is: a sandboxed
   *  document's, whose address says nothing of who it is, or one a redirect
   *  through another origin tainted (`redirectTainted`). */
  opaqueOrigin?: boolean;
  /** Its request mode (Fetch): `navigate` for a frame's document. Absent,
   *  `cors`, a script's `fetch`'s. What `Sec-Fetch-Mode` says. */
  mode?: FetchMode;
  /** Its destination (Fetch): `iframe`, `worker`, `script`… Absent, none,
   *  a script's `fetch`'s. What `Sec-Fetch-Dest` says. */
  destination?: string;
  /** The URLs before this one on its way, where the host follows its
   *  redirects a hop at a time: what `Sec-Fetch-Site` is reckoned over. */
  through?: string[];
  /** A navigation the user's activation made (`Sec-Fetch-User`). */
  user?: boolean;
  /** Its origin (Fetch, a request's origin), where `opaqueOrigin` says
   *  `null` only because a redirect through another origin tainted it:
   *  `Sec-Fetch-Site` is reckoned from the origin, which a redirect does not
   *  change. Absent, its client's, or none where `opaqueOrigin`. */
  origin?: string;
  /** Its cache mode (Fetch, `RequestCache`): what the HTTP cache may answer
   *  it with and keep of it. Absent, `default`. */
  cache?: string;
  /**
   * What its `Referer` says, worked out already (Referrer Policy, 8.3): the
   * host works it out a hop at a time, from what the hop before came to and
   * the policy a redirect may have changed. Null for none. Absent, the
   * client's address under the default policy.
   */
  referrer?: string | null;
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
  /** Whether its owner is a secure context, which a worker is if that is
   *  (HTML 8.1.3.5). */
  secure: boolean;
  /** What opens the keys its owner makes (`subtle.ts`). */
  keySecrets: Uint8Array[];
  /** Its owner's referrer policy, which a worker whose script is a blob
   *  URL's has, as it has no response to say one (HTML 10.2.5.1). */
  referrerPolicy?: string;
  /** A shared worker's (HTML 10.2.6.4), whose global takes connections
   *  rather than messages of its own. */
  shared?: boolean;
  /** A service worker's (Service Workers 1): the scope it was registered
   *  for, and how its registry knows it and its registration. */
  service?: { scope: string; worker: unknown; registration: unknown };
}

/** Where a page's workers run (`workers.ts`): each started, posted to and
 *  ended by the number `start` answered. */
export interface PageWorkersLike {
  start(init: WorkerInit): number;
  post(id: number, data: string): void;
  end(id: number): void;
  /** Tells a worker's thread of a data channel the page handed it. */
  rtc?(id: number, message: ChannelRelay): void;
  /** A permission moved: a worker's copy of where each stands follows. */
  permissionMoved?(name: string, state: string): void;
  /** Whether a worker has a connection open (`DomHost.connected`). */
  readonly connected?: boolean;
  /** How many threads have stopped for the back-forward cache. */
  readonly stopped?: number;
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
  /** What a service worker's realm says to its registry. */
  service?(text: string, bytes?: Uint8Array): void;
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
  /** Bytes where a file is in it. */
  body: string | Uint8Array;
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
   *  origin's, `cors` another's that let it, `opaque` none of it, and
   *  `default` what a service worker made of nothing. */
  type?: 'basic' | 'cors' | 'opaque' | 'opaqueredirect' | 'default';
  /** The number an opaque response's body is held by here, which a realm
   *  hands back to keep it or to answer with it. */
  held?: number;
  /** Where the redirect an `opaqueredirect` stands for goes, as its
   *  `Location` said, and its status: the host's alone, which no realm is
   *  told, and what a navigation a worker answers with one follows (Fetch
   *  4.4, a navigation's manual redirect). */
  location?: string | null;
  redirectStatus?: number;
}

/** A page's request as the facade hands it over, with what decides
 *  whether another origin's answer is the page's to read. */
interface PageRequest extends FetchRequest {
  mode: 'cors' | 'no-cors' | 'same-origin';
  credentials: 'omit' | 'same-origin' | 'include';
  /** The headers the user agent set, of which CORS asks nothing. */
  uaHeaders?: string[];
  /** What a worker's `fetch` event reads of it. */
  cache?: string;
  redirect?: 'follow' | 'error' | 'manual';
  integrity?: string;
  referrerPolicy?: string;
  /** Its referrer as the page's `Request` has it: `client`, `no-referrer`
   *  or a URL of the page's origin (Fetch 2.2.5). Absent, `client`. */
  referrerSource?: string;
  destination?: string;
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
  /** How far the viewport's scrollable overflow reaches, across and down,
   *  in CSS pixels (`HtmlViewNode.documentSize`): the root's
   *  `scrollWidth` and `scrollHeight`, laid out first. */
  documentSize(): { width: number; height: number };
  /** What is under the pointer now, where it is over the document. */
  pointerElement(): Element | null;
  /** What was under the pointer as the document was last laid out. */
  pointerDrawn(): Element | null;
  /** Whether an `<embed>` may hold a document, by what the document renders
   *  of it (`HtmlViewNode.embedRendered`). Null until it has styles. */
  embedRendered(element: Element): boolean | null;
  /** Whether the document has something mounted over an embedded element,
   *  as it last reported them (`HtmlViewNode.mountsEmbedded`). Null where it
   *  owes a layout. */
  mountsEmbedded(element: Element): boolean | null;
  /** What the reader's selection is, to compare. */
  selectionKey(): string;
  /** What is under a pointer that did not move is `:hover` now. */
  hoverAgain(): void;
  /** `:hover` is on what has the pointer's capture, whatever it is over. */
  hoverOn(element: Element | null): void;
  /** A point of the page in an element's own coordinates
   *  (`HtmlViewNode.pointIn`). */
  pointIn(
    how: 'offset' | 'layer',
    element: Element,
    x: number,
    y: number,
  ): [number, number] | null;
  /** Hand the host what a page asked to have saved: whether it takes it. */
  download(request: HtmlDownloadRequest): boolean;
  /** A file input's dialog (`HtmlProps.onPickFiles`). */
  pickFiles(element: Element): void;
  /** Set what a file input holds, as a script's `files` does. */
  setFiles(element: Element, files: readonly HtmlFile[]): void;
  /** The document told an element has the focus before anything is there
   *  to take core's (`DocumentInteraction.told`). */
  toldFocus(element: Element): void;
  /** What is selected in the document, as it is drawn: what a copy of it
   *  puts on the clipboard. */
  selectedText(): string;
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
  /** `computedStyle` leaving what is owed waiting, whose boxes may yet move
   *  where `layoutOwed` says so (`HtmlViewNode.computedStyle`). */
  styleWhileOwed(
    element: Element,
    pseudo: string | null,
  ): Record<string, string> | null;
  layoutOwed(): boolean;
  /** The document's `medium` font size, in CSS pixels
   *  (`HtmlViewNode.fontMedium`). */
  fontMedium?(): number;
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
  /** The document's fonts, where a page's `new FontFace` goes. */
  scriptFonts(): WebFonts | null;
  /** A face a page's script made joined the document's, or left. */
  scriptFontsChanged(id: number, added: boolean): void;
  /** What `svg-geometry.ts` asks of the document. */
  svgMeasure(): SvgMeasure | null;
  /** SVG's properties of an element as `getComputedStyle` reads them. */
  svgComputed(element: Element): Record<string, string> | null;
  /** What a canvas's context asks of the fonts. */
  canvasText(): CanvasText | null;
  /** Where what a `<foreignObject>` holds was laid out in it. */
  foreignRect(element: Element): { object: Element; rect: Rect } | null;
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
  /** And its timing, as a page's `updateTiming()` set it on its effect: a
   *  JSON object of what it set (`HtmlViewNode.timeAnimation`). */
  timeAnimation(key: number, timing: string): void;
  /** And one on a scroll's timeline, held, run from a start time or
   *  aligned to its range (`HtmlViewNode.seekScrolled`). */
  seekScrolled(
    key: number,
    mode: 'align' | 'start' | 'hold',
    time: number | null,
    rate: number,
  ): void;
  /** How far from where the scroll is now, in CSS pixels, each edge of a
   *  view timeline's subject crosses each edge of its scrollport, less the
   *  insets given — null for `auto`, the `scroll-padding` there — as
   *  layout placed it and as the sticky boxes it is in move it: its start
   *  entering, its end leaving, its start at the near edge and its end at
   *  the far one (`HtmlViewNode.viewAdjustOf`). */
  viewAdjust(
    element: Element,
    vertical: boolean,
    insets: [number | null, number | null],
  ): { enters: number; leaves: number; start: number; end: number } | null;
  /** The physical axis a page's scroll or view timeline's axis is for the
   *  scroller it measures, `x` or `y`, and `r` after it where the scroll
   *  origin is at its end (`HtmlViewNode.timelineAxisOf`). */
  timelineAxis(element: Element, axis: string): string;
  /** The source an anonymous timeline on an element measures, null for
   *  the viewport, and the physical axis it does along; undefined for one
   *  with no box (`HtmlViewNode.timelineSourceOf`). */
  timelineSource(
    element: Element,
    axis: string,
  ): { source: Element | null; axis: 'x' | 'y' } | undefined;
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
  /** Text of a stylesheet `@import` fetched, for `CSSImportRule.styleSheet`
   *  (`HtmlViewNode.importedCss`). */
  importedCss(href: string): string | null;
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
    /** Where what it shows came from (`ResourceStore.response`). */
    response?: ImageResponse | null;
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
  /** A snap container's snap targets, the viewport's for null, where they
   *  are other than its `kind` of snap event last told
   *  (`HtmlViewNode.snapChanged`). */
  snapChanged?(
    element: Element | null,
    kind: 'change' | 'changing',
  ): { block: Element | null; inline: Element | null } | null;
  /** What a page's `MediaSource` came to, for its element's player to
   *  play, or null for none any more: a file of a clip (`clips.ts`), or the
   *  URL of a feed (`feeds.ts`), whose player says what it does
   *  (`reports`). */
  showClip(element: Element, file: string | null, reports?: boolean): void;
  /** What the boxes were laid out and scrolled as, as a key that moves
   *  wherever a measurement of them may (`HtmlViewNode.geometryKey`). */
  geometryKey(): string;
  /** Whether the page waits to hear of its viewport, given how long its
   *  tasks have taken so far (`HtmlViewNode.viewportHeld`). */
  viewportHeld(busy: number): boolean;
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
  /** Whether this is a secure context, where it is not for the document's
   *  address to say: a worker's. */
  secureContext?: boolean;
  /** The pane the document is shown in, in CSS pixels — its size and its
   *  scroll — with the page's zoom and the device's scale, and where its
   *  top left is in the window, in logical pixels. */
  viewport(): {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    /** Where `scrollX` counts from for a page (`ScriptViewport.originX`). */
    originX?: number;
    zoom: number;
    dpr: number;
    left: number;
    top: number;
  };
  scrollTo(x: number, y: number): void;
  /** A navigation the page asked for: an address assigned, `open`. `post`
   *  is the form a link's or a form's target sends it with, into a window
   *  of the group; `name` what a tab is opened with. */
  navigate(
    url: string,
    how: 'here' | 'replace' | 'tab',
    post?: FramePost | null,
    name?: string,
    /** The document that sent it (`HtmlNavigationSource`). */
    source?: HtmlNavigationSource,
  ): void;
  /** What a page's `window.open` reaches (`HtmlPopups`). */
  popups?: HtmlPopups;
  /** The window this document is shown in, where a page opened it. */
  popup?: HtmlPopup | null;
  /** What the window this document is shown in goes by, where a host opened
   *  it under a name. */
  windowName?: string;
  /** A page closed the window it is in, a tab of its host's: `alone` where
   *  its history has one entry, which is what lets a page close a window no
   *  script opened. Answers whether it closes. */
  close?(alone: boolean): boolean | void;
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
  /** What a page's synchronous requests are made through, on a thread that
   *  stays awake while this one sleeps (`sync-fetch.ts`). Absent, a page
   *  has only asynchronous ones. */
  syncNetwork?: HtmlSyncNetwork | null;
  /** A synchronous request where this realm makes them its own way: a web
   *  worker's, whose page has a network to answer it with. Throws what it
   *  came to, a `TimeoutError` by name where `timeout` ms ran out. */
  fetchSync?(request: FetchRequest, timeout: number): FetchResponse;
  userAgent: string;
  language: string;
  /** The label of the encoding the host decoded the document from. */
  charset?: string;
  /** What a media element's `canPlayType` answers: whether what plays the
   *  page's media can play the type. None, `''` for every type. */
  canPlayType?(type: string): string;
  /** Whether `fetch` is a network the host was given: a media element
   *  fetches its source through it to know its duration and when it can
   *  play, and with none is ready as soon as it is asked. */
  network?: boolean;
  /** What keeps a page's service workers (`HtmlScripts`' `serviceWorkers`).
   *  Absent, a page has none. */
  serviceWorkers?: HtmlServiceWorkers | null;
  /** What a worker's `caches` ask, where its store is across a thread.
   *  Absent, the store is `storage`'s. */
  caches?(origin: string, ask: HtmlCacheAsk): Promise<HtmlCacheAnswer>;
  /** What a page's `WebTransport` sessions are carried over (`HtmlScripts`'
   *  `webTransport`). Absent, every session fails, as with no network. */
  webTransport?: HtmlWebTransport;
  /** What a page's `WebSocket`s are carried over (`HtmlScripts`'
   *  `webSocket`). Absent, every socket fails, as with no network. */
  webSocket?: HtmlWebSocket;
  /** The clipboard a page's `copy`, `paste` and `navigator.clipboard` reach
   *  (`HtmlScripts`' `clipboard`). Absent, they reach none. */
  clipboard?: HtmlClipboard;
  /** What a page's notifications reach (`HtmlScripts`' `notifications`).
   *  Absent, a page's `Notification` is refused. */
  notifications?: HtmlNotifications;
  /** What a page has been allowed (`HtmlScripts`' `permissions`). Absent,
   *  nothing has, and asking refuses. */
  permissions?: HtmlPermissions;
  /** What a page's `RTCPeerConnection`s are carried over (`HtmlScripts`'
   *  `webRTC`). Absent, no stack: an operation that needs one rejects. */
  webRTC?: HtmlWebRTC;
  /** The page's cameras, microphones and screens (`HtmlScripts`'
   *  `mediaDevices`). Absent, there are none. */
  mediaDevices?: HtmlMediaDevices;
  /** What a page's WebGL contexts draw through (`HtmlScripts`' `webgl`).
   *  Absent, they keep their state and draw nothing. */
  webgl?: HtmlWebGL;
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
  /**
   * Whether what the page mounts over a frame is the engine's own view of
   * its document (`FramePage`), which tells when that document has all it
   * asked for in (`followFrame`). Absent where a host mounts its own over
   * embedded elements (`renderEmbedded`): a frame's `load` then waits for
   * nothing its document asked for.
   */
  framesFollowed?: boolean;
}

/** All a page is told of an opaque response. */
const OPAQUE_HEAD = {
  status: 0,
  statusText: '',
  headers: [] as [string, string][],
  type: 'opaque',
  url: '',
  redirected: false,
};

/** How many opaque responses a document holds at once (`_opaques`). */
const OPAQUE_HELD = 64;

/** A response's body, all of it, read here. */
export async function wholeBytes(response: FetchResponse): Promise<Uint8Array> {
  if (!response.chunks) {
    return response.bytes ?? new TextEncoder().encode(response.body ?? '');
  }
  const pieces: Uint8Array[] = [];
  for await (const piece of response.chunks) pieces.push(piece);
  return joinBytes(pieces);
}

/** Bytes as one piece. */
function joinBytes(pieces: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const piece of pieces) size += piece.length;
  const whole = new Uint8Array(size);
  let at = 0;
  for (const piece of pieces) {
    whole.set(piece, at);
    at += piece.length;
  }
  return whole;
}

/** Bytes as lowercase hex, two digits a byte. */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** An error the facade throws by name: `DOMException`'s. */
/** A frame's navigation that came to a download its sandbox may not save. */
class DownloadRefused extends Error {}

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

/** How deep frames in documents with no realm of their own are followed
 *  (`_loadsFrame`): a document that frames itself is refused before this, and a
 *  chain of others' stops here. */
const MAX_FRAME_DEPTH = 32;

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

/** A selector that needs a matcher keeping answers for as long as it lives
 *  (css-select's `cacheResults`): a `:has()`, a `:contains()`. */
const KEEPS_ANSWERS = /:(?:has|i?contains)\(/i;

/** How many compiled queries a page keeps (`_query`). */
const KEPT_QUERIES = 1000;

/** The elements that hold a document of their own: a frame's. */
const FRAME_TAGS = new Set(['iframe', 'frame', 'object', 'embed']);

/** What says which image an `<img>` shows, or how it is fetched (HTML
 *  4.8.4.3.8, "relevant mutations"): changing one loads its image again. */
const IMAGE_ATTRIBUTES = new Set([
  'src',
  'srcset',
  'sizes',
  'crossorigin',
  'referrerpolicy',
]);

/** Whether an `<img>`'s attribute changing from `was` to `now` is one of
 *  its relevant mutations: its `src`, `srcset` and `sizes` whatever they
 *  are set to, and its `crossorigin` and `referrerpolicy` only where the
 *  state they are in moved, which a value of another case, or another
 *  invalid one, does not. */
function imageStateMoved(
  name: string,
  was: string | null,
  now: string | null,
): boolean {
  if (name === 'crossorigin') return corsState(was) !== corsState(now);
  if (name === 'referrerpolicy') {
    return referrerState(was) !== referrerState(now);
  }
  return true;
}
/** A CORS settings attribute's state (HTML 2.5.4). */
function corsState(value: string | null): string {
  if (value === null) return 'none';
  return asciiLower(value) === 'use-credentials'
    ? 'use-credentials'
    : 'anonymous';
}
/** A referrer policy attribute's state (HTML 2.5.5), "" for any value that
 *  is none of its keywords. */
function referrerState(value: string | null): string {
  const policy = value === null ? '' : asciiLower(value);
  return REFERRER_POLICIES.has(policy) ? policy : '';
}
const REFERRER_POLICIES = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'same-origin',
  'origin',
  'strict-origin',
  'origin-when-cross-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);
/** ASCII lower case, as an enumerated attribute is matched. */
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => c.toLowerCase());

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

/** Each `<template>`'s content, once a page has asked for it, and the
 *  fragments that are one. Kept by the node rather than a realm's number
 *  for it: the realms over one document share its templates. */
const TEMPLATE_CONTENTS = new WeakMap<Element, Document>();
const CONTENT_FRAGMENTS = new WeakSet<AnyNode>();

/**
 * A `<template>`'s content (HTML 4.12.3): a fragment over the template's own
 * list of children, so there is one list. What the parser and `innerHTML`
 * put in a template and what a page puts in its content are the same
 * nodes, and whatever reads the template — its `innerHTML`, the serializing
 * of what it is in, a clone — reads what is there now. As a copy made once,
 * it was what the template held the first time a page asked: Vue keeps one
 * `<template>` for its static trees, sets its `innerHTML` and moves its
 * `content` out each time, and from the second on it moved out nothing,
 * which took JSFiddle's editors with it.
 */
function templateContent(template: Element): Document {
  let content = TEMPLATE_CONTENTS.get(template);
  if (!content) {
    content = new Document(template.children);
    for (const kid of template.children) kid.parent = content;
    TEMPLATE_CONTENTS.set(template, content);
    CONTENT_FRAGMENTS.add(content);
  }
  return content;
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

/** css-select's view of a tree for a page's own query. A selector's type is
 *  lowercased and the parser keeps SVG's capitals, so without this
 *  `querySelector('foreignObject')` and d3's `select` found nothing. */
const QUERY_ADAPTER = {
  ...DomUtils,
  isTag,
  getName: typeNameOf,
};

/** What a query in an XML document differs by: names have their case, and
 *  a type selector is of a local name, under any prefix. */
const XML_QUERY = {
  xmlMode: true,
  adapter: { ...QUERY_ADAPTER, getName: localNameOf },
};

/** Whether an element the parser made stands in a drawing: the parser keeps
 *  a namespace only for what an HTML document reads otherwise, so what is
 *  around it says whose it is. A `<script>` is HTML's here, which is where
 *  a page's scripts are run from. */
const SVG_NS = 'http://www.w3.org/2000/svg';
const inDrawing = (el: Element): boolean =>
  el.name !== 'script' &&
  !MADE_AS_HTML.has(el) &&
  namespaceIn(el.parent) === SVG_NS;

/** What a copy keeps of what was made of what it copies, which is a tree
 *  alike to it: that it was made as HTML, which in a drawing nothing else
 *  says, as a copy first heard of there is no wrapper that already knows, and
 *  the namespaces `setAttributeNS` gave its attributes. */
const copyMadeAsHtml = (from: AnyNode, to: AnyNode): void => {
  if (from instanceof Element && MADE_AS_HTML.has(from)) {
    MADE_AS_HTML.add(to as Element);
  }
  if (from instanceof Element) {
    const spaces = ATTRIBUTE_SPACES.get(from);
    if (spaces) ATTRIBUTE_SPACES.set(to as Element, new Map(spaces));
  }
  const kids = (from as ParentNode).children;
  const copies = (to as ParentNode).children;
  if (!kids || !copies) return;
  for (let i = 0; i < copies.length; i += 1) {
    copyMadeAsHtml(kids[i], copies[i]);
  }
};

/** A document's element where it is a drawing: a document of SVG's own, as
 *  no document HTML's parser makes is. */
function drawingRootOf(doc: ParentNode): Element | null {
  const root = doc.children.find((k) => k instanceof Element) as
    Element | undefined;
  return root?.name === 'svg' && root.namespace === SVG_NS ? root : null;
}

/** The element a document's title is read from (HTML 3.1.3): the first
 *  `<title>` of HTML's, wherever it stands, and in a drawing that is a
 *  document, the first `<title>` of the drawing's own. */
function titleOf(doc: ParentNode): Element | null {
  const root = drawingRootOf(doc);
  if (root) {
    return (root.children.find(
      (k) =>
        k instanceof Element && k.name === 'title' && k.namespace === SVG_NS,
    ) ?? null) as Element | null;
  }
  return DomUtils.findOne(
    (el) => el.name === 'title' && !isForeign(el),
    doc.children,
  );
}

/** The document an XML parser that met a fatal error makes: Gecko's. */
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
      tagOf(el) === 'script' &&
      isStyleOrScript(el) &&
      (JS_TYPES.test((el.attribs.type ?? '').trim()) ||
        (el.attribs.type ?? '').trim().toLowerCase() === 'module'),
    doc.children,
  );
}

/** How long a user's press or key lets a page do what takes one: the realm's
 *  window, as Chrome's (`dom.ts`). */
const TRANSIENT_ACTIVATION_MS = 5000;

/** A document of nothing, `about:blank`'s, for a window's first: an `<html>`
 *  holding a head and a body, as HTML's parser makes one of no markup. */
export function blankDocument(): Document {
  const html = new Element('html', {}, []);
  DomUtils.appendChild(html, new Element('head', {}, []));
  DomUtils.appendChild(html, new Element('body', {}, []));
  const doc = new Document([]);
  DomUtils.appendChild(doc, html);
  return doc;
}

/** Text as it goes in markup, and an attribute's value. */
const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escapeAttribute = (text: string): string =>
  escapeText(text).replace(/"/g, '&quot;');

/** A response's body, where it arrives a chunk at a time, let go unread: a
 *  `no-cors` answer's, one CORS refused, one the page no longer wants. */
function release(response: FetchResponse): void {
  void response.chunks?.[Symbol.asyncIterator]().return?.();
}

/** The types an HLS playlist is served as (RFC 8216, 4, and the two older
 *  names players still meet). */
const HLS_TYPE =
  /^\s*(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/(?:x-)?mpegurl)\b/i;

/** Bytes as base64, which is how they cross to the page. */
/** Take a notification down, whatever the host's hook makes of it. */
function closeShown(shown: HtmlShownNotification | null | undefined): void {
  try {
    void Promise.resolve(shown?.close()).catch(() => {});
  } catch {
    // a page that has gone cannot hear it did not close
  }
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}

/** How much of a file crosses to a page at once. */
const FILE_CHUNK = 6 * 2 ** 20;

/** Bytes from what crossed as base64. */
function bytesOf(text: string): Uint8Array {
  return Buffer.from(text, 'base64');
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

/** A comma-separated list of tokens, lower-cased unless `fold` is false. */
function listOf(value: string | null, fold = true): Set<string> {
  const out = new Set<string>();
  for (const part of (value ?? '').split(',')) {
    const token = part.trim();
    if (token) out.add(fold ? token.toLowerCase() : token);
  }
  return out;
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

export { trustworthy };

/** What a frame's document is to Fetch (Fetch, "request destination"): the
 *  element that holds it. */
function frameDestination(frame: Element): string {
  const tag = tagOf(frame);
  return tag === 'frame' || tag === 'object' || tag === 'embed'
    ? tag
    : 'iframe';
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
export function cssRulesOf(
  css: string,
  /** Told of what was no rule and dropped, which `insertRule`, handed one
   *  rule and nothing else, refuses (CSSOM 1, "parse a CSS rule"). */
  dropped?: { any: boolean },
): string[] {
  const out: string[] = [];
  const n = css.length;
  // the closing bracket of each block open, innermost last
  const open: string[] = [];
  // what the text ends inside, past its brackets: a string or a comment
  let inside = '';
  let start = 0;
  const end = (at: number, statement: boolean): void => {
    const rule = css.slice(start, at).trim();
    start = at;
    if (!rule || rule === '<!--' || rule === '-->') return;
    if (statement && !rule.startsWith('@')) {
      if (dropped) dropped.any = true;
      return;
    }
    out.push(rule);
  };
  for (let i = 0; i < n; i++) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close < 0) inside = '*/';
      const after = close < 0 ? n : close + 2;
      // a comment before a rule is not the rule's
      if (!css.slice(start, i).trim()) start = after;
      i = after - 1;
    } else if (ch === '"' || ch === "'") {
      // a newline ends a string that has not ended, and a form feed is one
      i += 1;
      while (
        i < n &&
        css[i] !== ch &&
        css[i] !== '\n' &&
        css[i] !== '\r' &&
        css[i] !== '\f'
      ) {
        i += css[i] === '\\' ? 2 : 1;
      }
      if (i >= n) inside = ch;
    } else if (ch === '\\') {
      i += 1;
    } else if (ch === '{' || ch === '(' || ch === '[') {
      open.push(ch === '{' ? '}' : ch === '(' ? ')' : ']');
    } else if (ch === '}' || ch === ')' || ch === ']') {
      // a closing bracket of another kind inside is only a token
      if (open[open.length - 1] === ch) open.pop();
      if (!open.length && ch === '}') end(i + 1, false);
    } else if (ch === ';' && !open.length) {
      end(i + 1, true);
    }
  }
  // What the text ends inside is closed there, as CSS's tokenizer closes it
  // (CSS Syntax 3, 5.4.9), and the rule says so in its text: rules are
  // written back beside each other (`_writeSheets`), where what one left
  // open would hold the rest. Grafana's global styles set `content: "\f0d7"`
  // in a JavaScript string, a form feed and so a broken string, one rule of
  // 578 that each go in by `insertRule`: the 246 after it were lost in it,
  // `.grafana-app` among them, and no dashboard had a height.
  const before = out.length;
  end(n, false);
  if (out.length > before) {
    let rule = out.pop() as string;
    const atRule = rule[0] === '@';
    // what has no block by then is no rule, but for an at-rule
    if (!atRule && !open.includes('}')) {
      if (dropped) dropped.any = true;
      return out;
    }
    if (inside && inside !== '*/' && /(?<!\\)(?:\\\\)*\\$/.test(rule)) {
      rule = rule.slice(0, -1);
    }
    rule += inside + open.reverse().join('');
    out.push(atRule && !rule.endsWith('}') ? `${rule};` : rule);
  }
  return out;
}

/** How a fragment is serialized (HTML 8.5.2): an empty attribute's value
 *  written, `disabled=""`, as a browser writes it. */
/** HTML's fragment serialization (8.5.2): every attribute with its `=""`,
 *  and of the characters only `&`, U+00A0, and `<` and `>` in text or `"`
 *  in an attribute escaped, the rest written as they are, where the default
 *  wrote every letter past ASCII as a numeric reference. */
const SERIALIZE = { emptyAttrs: true, encodeEntities: 'utf8' } as const;

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

/** The pseudo-classes that take one identifier. */
const TAKES_AN_IDENT = /:(?:state|dir)\(/i;

/** What a page's own selector can ask, beyond css-select: a function, or
 *  a string for one of css-select's aliases to take over
 *  (`CONTROL_PSEUDOS`). */
type Pseudos = Record<
  string,
  string | ((el: Element, arg?: string | null) => boolean)
>;

/** What an entry into the page answers: the engine's `call`. */
export interface Entries {
  call(entry: string, input: unknown): Primitive;
  /** How long the task under way may still wait on an op, in ms
   *  (`ScriptEngine.waitLeft`). */
  readonly waitLeft?: number;
  /** How long the page's tasks have taken, in ms (`ScriptEngine.busy`). */
  readonly busy?: number;
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
  runNested?(
    code: string,
    url: string,
    muted?: boolean,
  ): 'ran' | 'threw' | null;
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
/** How long a synchronous request may hold a page, at most: the task's own
 *  limit comes first, and only a host that raised it gets this far. */
const SYNC_REQUEST_MS = 30_000;

/** The document an element is in, if any. */
function documentHolding(element: Element): Document | null {
  let node: AnyNode = element;
  while (node.parent) node = node.parent;
  return node instanceof Document ? node : null;
}

export class DomShared {
  readonly inert = new WeakSet<Element>();
  /** Each document's encoding where its bytes came through here, by its
   *  name. One a host handed over is the host's to say (`charset`). */
  readonly encodings = new WeakMap<Document, string>();
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
  readonly xml = XML_DOCUMENTS;
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
   *  as HTML or XML, with a script in them, where the browser draws frames.
   *  A frame's first `about:blank`, what a script writes into one and a
   *  document with no script are the page realm's, since a page reaches
   *  into them at once, before a realm could be made. */
  readonly realms = new WeakSet<Document>();
  /** The documents of `<object>`s and `<embed>`s that are shown as they
   *  stand, in a view of their own, where a drawing is otherwise shown as
   *  the picture of it (`DomHost.framed`). */
  readonly live = new WeakSet<Document>();
  /** Each document's sandboxing flags, where it has any (`./sandbox.ts`):
   *  kept here, by the document, where no realm can reach them. */
  readonly sandboxes = new WeakMap<Document, number>();
  /** The windows that can reach each other over this tree, once one has
   *  opened another (`./popups.ts`). */
  windows: WindowGroup | null = null;
  /** A node one realm hands another (`handOver`), and that realm's origin:
   *  another origin's takes nothing. */
  handed: { node: AnyNode; origin: string } | null = null;

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
  /** The sheets this realm's shadow roots adopted, by their numbers
   *  (`adoptedSheet`). */
  private _adoptedSheets = new Map<number, AdoptedSheet>();
  private _timers = new Map<number, ReturnType<typeof setTimeout>>();
  private _fetches = new Map<number, InstanceType<AbortControllerClass>>();
  /** What a page's `MediaSource`s were appended (`clips.ts`), and the files
   *  the player is handed them in. */
  private readonly _clips = new VideoClips({
    plays: (type) => !!this._seams.canPlayType?.(type),
    write: writeClip,
    remove: removeClip,
    show: (element, file) => this._seams.handle.showClip?.(element, file),
  });
  /** What a page's `MediaSource`s of fragmented MP4 were appended, handed
   *  to the player as HLS over loopback (`feeds.ts`). */
  private readonly _feeds = new Feeds({
    show: (element, url, at) => {
      this._seams.handle.showClip?.(element, url, url !== null);
      // past the key frame the stream starts at, where the page is
      if (url && at)
        this._seams.handle.setMediaState(element, { currentTime: at });
    },
    serve,
    unserve,
  });
  /** A `SourceBuffer`'s id, as the page's realm knows it, to the clip or
   *  the feed that holds it. */
  private readonly _mse = new Map<number, { feed: boolean; id: number }>();
  private _mseNext = 1;
  /** A page's WebGL contexts, where the host has a GL (`gl.ts`). */
  private readonly _contexts = new PageContexts({
    webgl: () => this._seams.webgl,
    pixels: (element, width, height) => {
      let pixels = this._s.canvases.get(element);
      if (!pixels || pixels.width !== width || pixels.height !== height) {
        pixels = {
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
          version: 0,
        };
        this._s.canvases.set(element, pixels);
      }
      return pixels.data;
    },
    drawn: (element) => {
      const pixels = this._s.canvases.get(element);
      if (pixels) pixels.version += 1;
      else this._contexts.settle(element);
      for (const listener of [...this._s.canvasListeners]) listener(element);
    },
  });
  /** What each media element's source is being read for (`_mediaFetch`). */
  private _mediaFetches = new Map<
    Element,
    InstanceType<AbortControllerClass>
  >();
  /** The bodies being handed to the page a chunk at a time (`_pump`). */
  private _bodies = new Map<number, AsyncIterator<Uint8Array>>();
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
  /** This document as a service worker's client, where the host keeps
   *  service workers (`ScriptRunner`). */
  serviceClient: ServiceClient | null = null;
  /** The frame a script last focused, which is a `WindowClient.focused`. */
  focusedFrame: Element | null = null;
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
    /** The top-level document's address: the page's, whose site is the site
     *  for cookies of every frame in it. Its own, for a page. */
    top: string | null = null,
  ) {
    // a fragment directive is the user agent's, and no part of the URL a
    // page reads (HTML, "remove the fragment directive"): `#:~:text=…` is
    // `location.hash` ''
    this.url = withoutFragmentDirective(url);
    adoptEncodings(encodingCodecs);
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
    this._unwatchPermissions =
      _seams.permissions?.watch?.((name) => this._permissionMoved(name)) ??
      null;
    this.top = top ?? this.url;
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
    if (event.type.startsWith('mouse')) this._under = event.target;
    // a user's press or key has used the page (HTML 6.4.1, "activation
    // triggering input event"): what the realm notes of it is the page's to
    // say, so what a gesture lets through asks this
    if (
      event.type === 'mousedown' ||
      (event.type === 'keydown' && event.key !== 'Escape')
    ) {
      this._activatedAt = Date.now();
    }
    const answer = this.entries?.call('__event', {
      type: event.type,
      target: this.idOf(event.target),
      x: event.x,
      y: event.y,
      screenX: event.screenX,
      screenY: event.screenY,
      samples: event.samples,
      locks: event.locks,
      button: event.button,
      buttons: event.buttons,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      detail: event.detail,
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      data: event.data,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      submitter: event.submitter ? this.idOf(event.submitter) : 0,
      relatedTarget: event.relatedTarget ? this.idOf(event.relatedTarget) : 0,
      clipboard: event.clipboard && clipboardWire(event.clipboard, base64Of),
      drag: event.drag && {
        entries: event.drag.entries,
        hasFiles: event.drag.hasFiles,
        files: event.drag.files?.map((file) => this._toldFile(file)),
        effectAllowed: event.drag.effectAllowed,
        dropEffect: event.drag.dropEffect,
      },
    });
    // what a page left in the drag's store, for what the drag does next
    if (event.drag && this._dragOut) {
      Object.assign(event.drag, JSON.parse(this._dragOut));
      this._dragOut = null;
    }
    return answer !== false;
  }

  /** The address of the document this one's window is at the top of. */
  readonly top: string;
  /** A page's windows, where the host may open any (`./popups.ts`). */
  windows: ReturnType<typeof windowOps> | null = null;
  /** What made this document, where it is `about:blank`: its origin and its
   *  base are that document's (HTML 7.1.1). */
  creator: string | null = null;
  /** The opaque origin that made it, where one did: an address says nothing
   *  of that, and a sandbox's address is a real origin's. */
  creatorOrigin: object | null = null;
  /** This document's opaque origin, where it has one: `'null'` is what it
   *  serializes to, and this is which it is. */
  private readonly _opaqueOwn = {};
  /** What `document.referrer` reads. */
  referrer = '';
  /**
   * The policy its requests' referrers are made under where a request names
   * none (HTML, a policy container's referrer policy): the one its response
   * said in `Referrer-Policy`, a worker's from its script's, set by whoever
   * makes the host. A `<meta name="referrer">` changes it from there on
   * (`_noteReferrer`).
   */
  referrerPolicy: ReferrerPolicy = '';
  /** Whether the document around this one's frame is of another origin:
   *  what the frame's element is, and all it reaches, is refused it. */
  foreignParent = false;

  /** This document's origin. */
  get origin(): string {
    return this._origin();
  }

  /**
   * Whether this document has nothing to keep anything under: an opaque
   * origin's, which serializes to the one `null` every sandbox and `data:`
   * document would share, and so has no store, no lock, no permission and no
   * channel of its own. A `file:` page is the exception, as in browsers: it
   * serializes the same and keeps a `localStorage`.
   */
  get originless(): boolean {
    if (this.sandbox & SB_ORIGIN) return true;
    return this._origin() === 'null' && !/^file:/i.test(this.url);
  }

  /** Which opaque origin this document has, or null for one of a scheme, a
   *  host and a port: what two documents of no address's origin compare. */
  get opaqueOrigin(): object | null {
    if (this._origin() !== 'null') return null;
    return this.creatorOrigin ?? this._opaqueOwn;
  }

  /** What this document's sandbox takes from it (`./sandbox.ts`). */
  get sandbox(): number {
    return this._s.sandboxes.get(this.document) ?? 0;
  }

  /** The document around this one's frame, where that is a realm's. */
  frameParent: DomHost | null = null;

  /** The flags a window this document opens starts with: its own, unless it
   *  lets its windows out of its sandbox. */
  get popupSandbox(): number {
    return this.sandbox & SB_PROPAGATES ? this.sandbox : 0;
  }

  /** A window with no opener. That is a tab, the host's, unless this document
   *  may open none, or has flags to hand on, which a tab cannot carry: a host
   *  is told of no document that keeps them (`openApart`). */
  private _openTab(url: string, target: string, noreferrer: boolean): void {
    if (this.sandbox & SB_POPUPS) return;
    const name = /^_blank$/i.test(target) ? '' : target;
    if (this.popupSandbox) {
      const features = { popup: false, noreferrer };
      this.windows?.apart({ url, name, features, post: null });
    } else this._seams.navigate(url, 'tab', null, name);
  }

  /** When a user last pressed or keyed in this document, as the host saw it
   *  (`dispatch`). */
  private _activatedAt = -Infinity;

  /** Whether a user's press or key is behind what a page does now (HTML
   *  6.4.1, "transient activation"), by the host's clock: as long as the
   *  realm's `TRANSIENT_ACTIVATION_MS`. */
  private _transientlyActive(): boolean {
    return Date.now() - this._activatedAt < TRANSIENT_ACTIVATION_MS;
  }

  /** This document as what sends a window somewhere: its origin, and
   *  whether a user's press or key is behind it now. */
  navigationSource(): HtmlNavigationSource {
    return { origin: this._origin(), user: this._transientlyActive() };
  }

  /** Whether this document may send the window at the top of it somewhere
   *  (HTML 7.4.2.3, "allowed by sandboxing to navigate"), a gesture behind it
   *  or not. */
  mayNavigateTop(gesture: boolean): boolean {
    return !(this.sandbox & (gesture ? SB_TOP_GESTURE : SB_TOP));
  }
  /** The document a frame of this document shows, by the frame's id. */
  frameDocumentAt(id: number): Document | null {
    const frame = this._nodes.get(id);
    return (frame && this._frames.get(frame as Element)) ?? null;
  }

  /** What the realms of this page share, for a frame's host to be made
   *  over (`ScriptRunner`'s frames). */
  get shared(): DomShared {
    return this._s;
  }

  /**
   * The frames in this realm's document that have a document of their own
   * to show, HTML's or XML's, each with it, its address and whether it runs
   * in a realm of its own (`DomShared.realms`): what a browser that draws
   * frames mounts a frame for (`drawsFrames`), another origin's among them,
   * which runs at its own origin.
   */
  frames(): FrameShown[] {
    const out: FrameShown[] = [];
    for (const frame of this._s.frameList) {
      if (!this._loadsFrame(frame)) continue;
      const document = this._frames.get(frame);
      let url = this._frameAt.get(frame) ?? 'about:blank';
      // a `srcdoc` document's base is the page's (HTML 4.8.5)
      if (url === 'about:srcdoc') url = this.url;
      if (!document) continue;
      // an `<embed>` that loaded nothing has nothing to draw, and nothing a
      // page could write in: it has no `contentDocument`
      if (frame.name === 'embed' && url === 'about:blank') continue;
      out.push({ frame, document, url, realm: this._s.realms.has(document) });
    }
    return out;
  }

  /**
   * Whether an `<object>` or an `<embed>` shows its document as it stands,
   * in a view of its own, rather than the picture an image of it would be
   * (`DomShared.live`). A drawing with nothing to change it stays a picture,
   * which `object-fit` reaches and a mount over the box would not: one with
   * a script is live from the start, and one a page's script writes into is
   * from then on.
   */
  framed(element: Element): boolean {
    const document = this._frames.get(element);
    return !!document && this._s.live.has(document);
  }

  /** An `<object>`'s or an `<embed>`'s document has come to need showing as
   *  it stands: told as a change of an attribute nothing has, which builds
   *  the element's box, a frame now where it was an image. */
  private _goLive(doc: Document): void {
    const frame = this._frameOf.get(doc);
    if (!frame || (frame.name !== 'object' && frame.name !== 'embed')) return;
    if (!this._seams.drawsFrames || this._s.live.has(doc)) return;
    this._s.live.add(doc);
    if (this._loadsFrame(frame)) {
      this._tell(frame, {
        type: 'attributes',
        target: frame,
        attributeName: '-rx-framed',
      });
    }
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
    this._framesLoaded = true;
    this._framesIn(this.document.children);
  }
  /** Whether the frames the markup has have been asked to load. */
  private _framesLoaded = false;

  /** A `<canvas>`'s pixels, where a script drew any. */
  canvas(element: Element): CanvasPixels | null {
    this._contexts.settle(element);
    return this._s.canvases.get(element) ?? null;
  }

  /** Whether a canvas's picture has nothing behind it show through. */
  canvasOpaque(element: Element): boolean {
    return this._contexts.opaque(element);
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
      if (!this._loadsFrame(frame)) this._framesLoading.delete(frame);
    }
    return this._framesLoading.size > 0;
  }
  private _frameDone(frame: Element): void {
    if (!this._framesLoading.delete(frame)) return;
    if (!this.framesLoading) this.onFramesLoaded?.();
  }

  /** The frames a view of the page follows (`FramePage`), each with how
   *  many do. */
  private _frameViews = new Map<Element, number>();
  /** The `load` each document of this realm's in an `<iframe>` owes the
   *  frame, until the view that draws it says it is loaded
   *  (`frameViewLoaded`). */
  private _loadsOwed = new WeakMap<Document, () => void>();
  /** The frames whose document owes its `load` and that no view follows
   *  yet, asked again after a paint whether the page mounts one
   *  (`_awaitView`). */
  private _viewsAwaited = new Set<Element>();

  /**
   * A view of the page follows a frame for as long as the page mounts one
   * over it, and draws whatever document the frame shows: one of this
   * realm's has its `load` wait for that view to have all it asked for in,
   * since only a view asks for its images and its sheets. Answers the way to
   * stop following.
   */
  followFrame(frame: Element): () => void {
    this._frameViews.set(frame, (this._frameViews.get(frame) ?? 0) + 1);
    this._viewsAwaited.delete(frame);
    return () => {
      const left = (this._frameViews.get(frame) ?? 1) - 1;
      if (left > 0) {
        this._frameViews.set(frame, left);
        return;
      }
      this._frameViews.delete(frame);
      // a view goes as React commits, where no page code runs
      void Promise.resolve().then(() => this._awaitView(frame));
    };
  }

  /** The view of a frame's document of this realm's has it loaded, all it
   *  asked for in: the frame's `load`, where it waited for it. */
  frameViewLoaded(doc: Document): void {
    const owed = this._loadsOwed.get(doc);
    if (!owed) return;
    this._loadsOwed.delete(doc);
    owed();
  }

  /**
   * Whether an `<iframe>`'s document of this realm's has its `load` wait
   * for a view (HTML 13.2.7, "the end"): one follows the frame, or the page
   * mounts one over it, or may once it has laid out what changed
   * (`HtmlViewNode.mountsEmbedded`). One the page mounts nothing over — not
   * rendered, or refused a mount — has nothing on its way, and a host that
   * mounts its own views over frames (`framesFollowed`) says nothing of
   * what they asked for.
   */
  private _waitsForView(frame: Element): boolean {
    if (frame.name !== 'iframe' || !this._seams.framesFollowed) return false;
    if (this._frameViews.has(frame)) return true;
    const mounts = this._seams.handle.mountsEmbedded?.(frame);
    if (!mounts && mounts !== null) return false;
    this._viewsAwaited.add(frame);
    return true;
  }

  /** A frame whose document waits for a view no one follows it with yet:
   *  still awaited where the page mounts one, or may, and loaded now where
   *  it mounts none. A frame out of the document hears nothing. */
  private _awaitView(frame: Element): void {
    this._viewsAwaited.delete(frame);
    const doc = this._frames.get(frame);
    if (!doc || !this._loadsOwed.has(doc) || this._frameViews.has(frame)) {
      return;
    }
    if (!this._inDocument(frame)) {
      this._loadsOwed.delete(doc);
      return;
    }
    const mounts = this._seams.handle.mountsEmbedded?.(frame) ?? false;
    if (mounts === false) this.frameViewLoaded(doc);
    else this._viewsAwaited.add(frame);
  }

  /**
   * The viewports the facade watches (`rendering`), by the id of the
   * document each is of — this one's, 1, and those of the page realm's
   * frames it made windows for — each with what it was last answered, and
   * whether the facade was woken since it last asked.
   */
  private _viewports = new Map<number, string>([[1, '']]);
  /** Whether a page listens for what a pointer's moves make: until one
   *  does `<Html>` tells it nothing of them (`noteHeard`). */
  movesHeard = false;
  /** The element the last of the pointer's events was told at. */
  private _under: Element | null = null;
  /** What the pointer is over and around it, once a kind (`pointers.ts`),
   *  and how far up that a removal has moved it, or -1. */
  private _pointerChains: (Element[] | null)[] = [null, null];
  private _pointerCut = [-1, -1];
  private _viewportsWoken = false;

  /** `<Html>` painted (`ScriptRunner.painted`): the facade is woken for a
   *  frame where a viewport it watches is another size, or answers a media
   *  query from anything else, than it was last told — a pane resized, an
   *  `<iframe>`'s box the page laid out again — so that the frame runs its
   *  resize steps and reports its media queries (HTML's "update the
   *  rendering") whether or not anything else asked for one. */
  /** The pointer did not move and what is under it may have: told as the
   *  boundary events it comes to, as a browser's fake move is
   *  (`MouseEventManager`'s), and only where a page listens for them. */
  askUnder(): void {
    if (this._disposed || !this.entries || !this.movesHeard) return;
    const el = this._seams.handle.pointerElement?.() ?? null;
    if (!el || el === this._under) return;
    this.dispatch({
      ...NO_MODIFIERS,
      type: 'mouseover',
      target: el,
      cancelable: false,
    });
    this._seams.handle.hoverAgain?.();
  }

  /** The reader's selection moved, which a page that listens hears as it
   *  moves and not only as it next reads it. */
  askSelection(): void {
    if (this._disposed || !this.entries || !this._selectionHeard) return;
    const key = this._seams.handle.selectionKey?.() ?? '';
    if (key === this._selectionSeen) return;
    this._selectionSeen = key;
    this.entries.call('__selectionMoved', null);
  }
  private _selectionHeard = false;
  private _selectionSeen = '';

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

  /** Whether what the page hears of its viewport waits: its `resize`, its
   *  media query lists' `change` and its `ResizeObserver`s, each of which
   *  finds what it last found (`HtmlViewNode.viewportHeld`). The frame
   *  still comes, for what its intersection observers measure against, and
   *  what the page reads stays what is there. */
  private _viewportHeld(): boolean {
    return this._seams.handle.viewportHeld?.(this.entries?.busy ?? 0) ?? false;
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
      this.snapEvent(el, 'changing');
      this.entries.call('__fire', [this.idOf(el), 'scroll']);
    }
  }

  /**
   * A snap container's `scrollsnapchanging`, as it scrolls, or its
   * `scrollsnapchange`, before its `scrollend` (CSS Scroll Snap 2, 6.1),
   * where its snap targets are other than that event last told: at the
   * element, and the viewport's, for null, at the document.
   */
  snapEvent(el: Element | null, kind: 'change' | 'changing'): void {
    if (this._disposed || !this.entries) return;
    const told = this._seams.handle.snapChanged?.(el, kind);
    if (!told) return;
    // a target in a shadow tree the container is not in is told as the
    // host it is in, as an event's target is retargeted (DOM 4.2.2.2)
    const at = el ?? this.document;
    const idOf = (t: Element | null) => {
      const node = t && retarget(t, at);
      return node ? this.idOf(node) : 0;
    };
    this.entries.call('__snapEvent', [
      el ? this.idOf(el) : 0,
      kind === 'change' ? 'scrollsnapchange' : 'scrollsnapchanging',
      idOf(told.block),
      idOf(told.inline),
    ]);
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
    const feed = this._feeds.of(el);
    if (feed) {
      // a feed's player, in its session's seconds, as the page hears it
      const said = feed.playerSaid(src, kind, value);
      if (!said) return;
      this.entries.call('__player', [
        this.idOf(el),
        feed.pageSrc,
        said.kind,
        said.value,
      ]);
      return;
    }
    this.entries.call('__player', [this.idOf(el), src, kind, value]);
  }

  /** Whether what plays the page's media plays a feed: HLS of fragmented
   *  MP4. */
  private _feedsPlay(): boolean {
    const plays = this._seams.canPlayType;
    return !!plays?.('application/vnd.apple.mpegurl') && !!plays('video/mp4');
  }

  /** And each one's `scrollend`, a frame after its last `scroll`. */
  elementsScrolledEnd(elements: Iterable<Element>): void {
    if (this._disposed || !this.entries) return;
    for (const el of elements) {
      this.snapEvent(el, 'change');
      this.entries.call('__fire', [this.idOf(el), 'scrollend']);
    }
  }

  /** The document is being left (`ScriptRunner.dispose`): what its
   *  `pagehide` and `unload` listeners change is drawn nowhere. */
  leaving(): void {
    this._leaving = true;
  }

  /** The document is frozen for the back-forward cache, and its WebTransport
   *  sessions go (`PageTransports.contextCleanup`). */
  contextCleanup(): void {
    this._transportsMade?.contextCleanup();
  }

  /** Whether the document has a WebSocket or a peer connection open
   *  (`ScriptRunner.salvageable`). */
  get connected(): boolean {
    return (
      !!this._socketsMade?.open ||
      !!this._peersMade?.open ||
      !!this.workers?.connected
    );
  }

  dispose(): void {
    this._disposed = true;
    // a page's own notifications go with it (Notifications API, 2.4)
    for (const shown of this._shown.values()) closeShown(shown);
    this._shown.clear();
    this._unwatchPermissions?.();
    this._unwatchPermissions = null;
    for (const { key, end } of this._channels.values()) {
      closeChannel(key, end);
    }
    this._channels.clear();
    for (const zlib of this._zlibs.values()) zlib.dispose();
    this._zlibs.clear();
    releaseClient(this._origin(), this._lockClient);
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
    this._clips.dispose();
    this._feeds.dispose();
    this._mse.clear();
    this._contexts.dispose();
    for (const body of this._bodies.values()) void body.return?.();
    this._bodies.clear();
    this._observers.clear();
    for (const response of this._opaques.values()) release(response);
    this._opaques.clear();
    this.serviceClient?.detach();
    this.serviceClient = null;
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
    copyMadeAsHtml(node, clone);
    this._cloneShadows(node, clone, deep);
    this._copiedScripts(node, clone, deep);
    const owner = this._ownerOf(node);
    if (owner !== this.document) this._owners.set(clone, owner);
    this._imagesMade([clone]);
    if (isDoctype(node)) this._doctypes.set(clone, this._doctypeOf(node));
    const type = this._xml.get(node as Document);
    if (this._isDocument(node)) {
      this._documents.add(clone as unknown as Document);
      if (type) markXmlDocument(clone as unknown as Document, type);
    }
    return clone;
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
   *  a deep clone does so for every host in what it copies. */
  private _cloneShadows(node: AnyNode, copy: AnyNode, deep: boolean): void {
    if (node instanceof Element && copy instanceof Element) {
      const root = shadowRootOf(node);
      if (root && root.clonable && !shadowRootOf(copy)) {
        const made = attachShadow(copy, {
          mode: root.mode,
          delegatesFocus: root.delegatesFocus,
          clonable: root.clonable,
          serializable: root.serializable,
        });
        if (made) {
          made.registryNull = root.registryNull;
          for (const child of root.children) {
            DomUtils.appendChild(made, this._clone(child, true));
          }
        }
      }
    }
    if (!deep) return;
    const from = (node as { children?: AnyNode[] }).children ?? [];
    const to = (copy as { children?: AnyNode[] }).children ?? [];
    for (let i = 0; i < from.length && i < to.length; i += 1) {
      this._cloneShadows(from[i], to[i], true);
    }
  }

  /** Whether a box's `checked` attribute holds its state and its default
   *  is kept apart (HTML 4.10.5.4, "dirty checkedness"): a script set it, or
   *  the user ticked it. */
  private _isDirtyBox(el: Element): boolean {
    if (this._checkedDefaults.has(el)) return true;
    if (!/^(?:checkbox|radio)$/i.test(el.attribs.type ?? '')) return false;
    const kept = checkedDefault(el);
    if (kept === undefined) return false;
    this._checkedDefaults.set(el, kept);
    return true;
  }

  /** A dirty box's `checked` attribute set or taken away: its default
   *  changed, its state not, and the page's observers told. */
  private _defaultChecked(el: Element, value: string | null): void {
    const oldValue = this._checkedDefaults.get(el) ?? null;
    this._checkedDefaults.set(el, value);
    setCheckedDefault(el, value);
    this._tell(el, controlChange(el));
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

  /** An expression, compiled, or its `SyntaxError`. What is compiled is
   *  kept, since a page runs one a great many times. */
  private _xpaths = new Map<string, CompiledXPath>();
  private _xpath(text: string): CompiledXPath {
    let compiled = this._xpaths.get(text);
    if (!compiled) {
      try {
        compiled = compileXPath(text);
      } catch (error) {
        throw new DomError(
          'SyntaxError',
          `The string '${text}' is not a valid XPath expression.`,
        );
      }
      this._xpaths.set(text, compiled);
    }
    return compiled;
  }

  /** A doctype's name, public id and system id: those it was made with,
   *  or what the markup it was parsed from says. */
  private _doctypeOf(node: AnyNode): [string, string, string] {
    const kept = this._doctypes.get(node);
    if (kept) return kept;
    const data = (node as ProcessingInstruction).data ?? '';
    const m =
      /^!doctype\s+([^\s>]+)(?:\s+public\s*(?:"([^"]*)"|'([^']*)'))?(?:\s*(?:system\s*)?(?:"([^"]*)"|'([^']*)'))?/i.exec(
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

  /** What the page's last look at its observers was answered (`geometry`). */
  private _looked = '';
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
          const ns = node.namespace ?? (inDrawing(node) ? SVG_NS : undefined);
          return ns === undefined
            ? `1|${node.name}`
            : `1|${node.name}\u0000${ns || '~'}`;
        }
        if (node instanceof Text) {
          return CDATA_SECTIONS.has(node) ? '4|#cdata-section' : '3|#text';
        }
        if (node instanceof ProcessingInstruction && !isDoctype(node)) {
          return `7|${node.name.slice(1)}`;
        }
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
      // an event's whole path, in one answer (`event-path.ts`)
      case 'eventPath':
        return eventPath(
          this._node(a),
          b === true,
          c ? this._node(c) : null,
          (node) => this.idOf(node),
        );
      // what a pointer is over and around it (`pointers.ts`), and how far
      // up that a removal has moved it since it was last asked
      case 'pointerChain': {
        const chain: Element[] = [];
        let at: Element | null = b ? this._element(b) : null;
        for (; at; at = flatParentOf(at)) chain.push(at);
        this._pointerChains[a as number] = chain;
        this._pointerCut[a as number] = -1;
        return chain.map((el) => this.idOf(el)).join(',');
      }
      // a pointer's capture has `:hover` go with it
      case 'pointerHover':
        this._seams.handle.hoverOn?.(a ? this._element(a) : null);
        return null;
      case 'pointerOver': {
        const cut = this._pointerCut.join(',');
        this._pointerCut = [-1, -1];
        return cut;
      }
      // a page came to listen for its selection's changes
      case 'selectionHeard':
        this._selectionHeard = true;
        this._selectionSeen = this._seams.handle.selectionKey?.() ?? '';
        return null;
      // a page came to listen for what a pointer's moves make
      case 'movesHeard': {
        this.movesHeard = true;
        const el = this._seams.handle.pointerDrawn?.() ?? null;
        this._under = el;
        return el ? this.idOf(el) : 0;
      }
      case 'pointIn': {
        const v = this._seams.viewport();
        const at = this._seams.handle.pointIn?.(
          a as 'offset' | 'layer',
          this._element(b),
          (c as number) + v.scrollX,
          (d as number) + v.scrollY,
        );
        return at ? `${at[0]},${at[1]}` : '';
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
        if (node instanceof ProcessingInstruction) return node.data;
        if (node === this.document) return null;
        return DomUtils.textContent(node);
      }
      case 'setText': {
        const node = this._node(a);
        if (node instanceof ProcessingInstruction) {
          node.data = text(b);
          return null;
        }
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
          else MADE_AS_HTML.add(el);
          if (el.name === 'script') this._forceAsync.set(el, true);
          node = el;
        } else if (a === 'text') node = new Text(text(b));
        else if (a === 'cdata') {
          node = new Text(text(b));
          CDATA_SECTIONS.add(node);
        } else if (a === 'pi') {
          const data = text(b);
          const space = data.indexOf(' ');
          node = new ProcessingInstruction(
            `?${data.slice(0, space)}`,
            data.slice(space + 1),
          );
        } else if (a === 'comment') node = new Comment(text(b));
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
        markXmlDocument(doc, text(a) || 'application/xml');
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
        if (name === 'checked' && this._isDirtyBox(el)) {
          return this._checkedDefaults.get(el)!;
        }
        return el.attribs[name] ?? null;
      }
      case 'attrs': {
        const el = this._element(a);
        const names = Object.keys(el.attribs);
        if (!this._isDirtyBox(el)) return names.join('\u0000');
        // the default a dirty box's `checked` is, and not its state
        const listed = names.filter((n) => n !== 'checked');
        if (this._checkedDefaults.get(el) !== null) listed.push('checked');
        return listed.join('\u0000');
      }
      case 'setAttr': {
        const el = this._element(a);
        const name = text(b);
        if (name === 'checked' && this._isDirtyBox(el)) {
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
        } else if (
          this._framesLoaded &&
          ((el.name === 'object' && name === 'data') ||
            (el.name === 'embed' && name === 'src'))
        ) {
          // and one put in with nothing to show has something now; while
          // the parse goes on it is one of those `loadFrames` will find
          this._frameIn(el);
        }
        return null;
      }
      // the namespace `setAttributeNS` gives an attribute, which no prefix
      // around it need say, for what a selector reads of it
      case 'attrSpace': {
        const el = this._element(a);
        let spaces = ATTRIBUTE_SPACES.get(el);
        if (!spaces) ATTRIBUTE_SPACES.set(el, (spaces = new Map()));
        spaces.set(text(b), text(c));
        return null;
      }
      case 'delAttr': {
        const el = this._element(a);
        const name = text(b);
        if (name === 'checked' && this._isDirtyBox(el)) {
          this._defaultChecked(el, null);
          return null;
        }
        if (name in el.attribs) {
          const oldValue = el.attribs[name];
          delete el.attribs[name];
          ATTRIBUTE_SPACES.get(el)?.delete(name);
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
        this._tell(host, { type: 'shadowRoot', target: host });
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
          (parent !== null && CONTENT_FRAGMENTS.has(parent))
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
        if (b === true) markFormAssociated(el);
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
        // in an XML document it is XML (DOM Parsing 2.2)
        if (anyXmlDocuments() && this._xml.has(this._ownerOf(node))) {
          const writer = {
            doctype: (n: AnyNode) => this._doctypeOf(n),
            cdata: (n: Text) => CDATA_SECTIONS.has(n),
          };
          return b
            ? serializeXml(node, writer)
            : (node as ParentNode).children
                .map((kid) => serializeXml(kid, writer))
                .join('');
        }
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
        const kids = this._parseIn(parent, text(b), c === true);
        // and what a template is handed is its content's, one that has one
        // keeping it (HTML 8.4, the `innerHTML` setter)
        this._replaceAll(
          (parent instanceof Element && TEMPLATE_CONTENTS.get(parent)) ||
            parent,
          kids,
        );
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
      case 'content':
        return this.idOf(templateContent(this._element(a)));

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
      case 'parsedForm': {
        const from = this._element(a);
        const form = parsedForm(from);
        return form && this._ownerOf(form) === this._ownerOf(from)
          ? this.idOf(form)
          : 0;
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
        const root = this._node(a) as ParentNode;
        const xml = this._xml.has(this._ownerOf(root) as Document);
        const tag = xml ? text(b) : text(b).toLowerCase();
        return elementsIn(root, (el) => tag === '*' || el.name === tag)
          .map((el) => this.idOf(el))
          .join(',');
      }
      case 'byTagNS': {
        const root = this._node(a) as ParentNode;
        const ns = text(b);
        const name = text(c);
        return elementsIn(
          root,
          (el) =>
            (ns === '*' || namespaceOf(el) === ns) &&
            (name === '*' || el.name.slice(el.name.indexOf(':') + 1) === name),
        )
          .map((el) => this.idOf(el))
          .join(',');
      }
      // the namespace a prefix reaches at a node
      case 'lookupNamespace':
        return namespaceFor(this._node(a), text(b));
      // XML, parsed and serialized, and XPath over the tree
      case 'parseXml': {
        const xml = xmlTree(text(a));
        const kids = xml.wellFormed ? xml.kids : [parserError()];
        const doc = new Document(kids);
        for (const kid of kids) kid.parent = doc;
        this._documents.add(doc);
        markXmlDocument(doc, text(b));
        return this.idOf(doc);
      }
      case 'serializeXml':
        return serializeXml(this._node(a), {
          doctype: (node) => this._doctypeOf(node),
          cdata: (node) => CDATA_SECTIONS.has(node),
        });
      case 'xpathPrefixes':
        return JSON.stringify(prefixesIn(this._xpath(text(a))));
      case 'xpath': {
        const { node, attr, namespaces } = JSON.parse(text(b)) as {
          node: number;
          attr: string | null;
          namespaces: Record<string, string>;
        };
        const context =
          attr === null
            ? this._node(node)
            : new XAttr(this._element(node), attr);
        const root = attr === null ? context : this._node(node);
        const owner = this._isDocument(root as AnyNode)
          ? (root as Document)
          : this._ownerOf(root as AnyNode);
        const value = evaluateXPath(this._xpath(text(a)), context as XNode, {
          namespaces,
          html: !this._xml.has(owner as Document),
        });
        return JSON.stringify(
          Array.isArray(value)
            ? value.map((n) =>
                n instanceof XAttr ? [this.idOf(n.el), n.name] : this.idOf(n),
              )
            : value,
        );
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
        // one rule, and what follows it as much a syntax error as nothing
        const dropped = { any: false };
        const rules = cssRulesOf(text(b), dropped);
        const brace = rules.length === 1 ? rules[0].indexOf('{') : -1;
        const prelude =
          brace > 0 && !rules[0].startsWith('@')
            ? rules[0].slice(0, brace)
            : null;
        const highlights =
          prelude === null ? null : highlightSelectorValid(prelude);
        if (
          rules.length !== 1 ||
          dropped.any ||
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
      // a `<style>`'s or a `<link>`'s sheet disabled, or let be (CSSOM
      // 6.1.1, `disabled`): out of the cascade while it is, told as a
      // change of an attribute nothing has, which the cascade reads
      case 'sheetDisabled': {
        const el = this._element(a);
        if (setSheetDisabled(el, b === true)) {
          this._tell(el, {
            type: 'attributes',
            target: el,
            attributeName: '-rx-sheet-disabled',
          });
        }
        return null;
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
        // the facade asks first, for the error a page should see, and what
        // it hands over is a page's to change
        if (!this._workerAllowed(String(init.url), typeof b === 'string')) {
          throw new DomError(
            'SecurityError',
            "A worker's script is its own origin's.",
          );
        }
        return this.workers.start({
          ...init,
          source: typeof b === 'string' ? b : null,
          origin: this._origin(),
          secure: this._secureContext(),
          keySecrets: keySecrets(this._keySecret()),
          referrerPolicy: this.documentReferrerPolicy(),
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
        const url = text(a);
        const code = this.workerScope?.importScript(url) ?? null;
        if (code === null) return null;
        const own = /^(?:data|blob):/i.test(url);
        return (
          this.entries?.runNested?.(
            code,
            url,
            !own && originOf(url) !== this._origin(),
          ) ?? null
        );
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
      // and as a computed style serializes it (`cssomColor`), for the
      // editing commands, which compare colours by it
      case 'colorText': {
        const rgba = cssColorStraight?.(text(a).trim());
        if (!rgba) return '';
        const [r, g, b] = rgba.slice(0, 3).map((v) => Math.round(v * 255));
        const alpha = Math.round(rgba[3] * 1000) / 1000;
        return alpha >= 1
          ? `rgb(${r}, ${g}, ${b})`
          : `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
      case 'selectedText':
        return this._seams.handle.selectedText?.() ?? null;
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
      // a sheet a shadow root adopted, by the number the realm gave it:
      // the text every root that holds it reads, each told it changed
      case 'adoptedSheet': {
        const sheet = this._adoptedSheets.get(Number(a));
        if (!sheet) {
          this._adoptedSheets.set(Number(a), {
            text: text(b),
            roots: new Set(),
          });
          return null;
        }
        sheet.text = text(b);
        for (const root of sheet.roots) {
          this._tell(root.host, { type: 'shadowRoot', target: root.host });
        }
        return null;
      }
      // the sheets a shadow root adopted, by those numbers, in order
      case 'adoptShadow': {
        const root = this._node(a) as ShadowRoot;
        for (const sheet of root.adopted) sheet.roots.delete(root);
        root.adopted = text(b)
          ? text(b)
              .split(',')
              .map((id) => this._adoptedSheets.get(Number(id))!)
          : [];
        for (const sheet of root.adopted) sheet.roots.add(root);
        this._tell(root.host, { type: 'shadowRoot', target: root.host });
        return null;
      }
      // a sheet's text as rules, for a sheet of the page's own and what a
      // grouping rule holds
      case 'cssRules': {
        // with `b`, one rule and nothing after it, as `insertRule` takes it
        const dropped = { any: false };
        const rules = cssRulesOf(text(a), b === true ? dropped : undefined);
        return JSON.stringify(dropped.any ? [] : rules);
      }
      // the document's sheets, in tree order: its `<style>`s and the
      // `<link>`s that are a stylesheet
      case 'sheets': {
        const root = a ? (this._node(a) as ParentNode) : this.document;
        return [
          ...(this._xml.has(root as Document)
            ? instructionSheets(root as Document)
            : []),
          ...DomUtils.findAll(
            (el) =>
              (tagOf(el) === 'style' && isStyleOrScript(el)) ||
              (tagOf(el) === 'link' &&
                !isForeign(el) &&
                /(?:^|\s)stylesheet(?:\s|$)/i.test(el.attribs.rel ?? '') &&
                !/(?:^|\s)alternate(?:\s|$)/i.test(el.attribs.rel ?? '')),
            root.children,
          )
            // what a `<template>` holds is no part of the document
            .filter((el) => {
              for (let at = el.parent; at; at = at.parent) {
                if (at instanceof Element && at.name === 'template')
                  return false;
              }
              return true;
            }),
        ]
          .map((el) => this.idOf(el))
          .join(',');
      }

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
        const doc = this._node(a) as Document;
        const frame = this._frameOf.get(doc);
        // of the document around this one, which is not this one's to reach
        // where it is another origin's
        if (!frame || (doc === this.document && this.foreignParent)) return 0;
        return this.idOf(frame);
      }
      // where a frame's document is from, read only of this one's origin: the
      // page may set another origin's window's `location`, and not read it
      case 'frameLocation': {
        const frame = this._element(a);
        this._frameDocument(frame);
        const at = this._frameAt.get(frame) ?? 'about:blank';
        if (!this._reaches(frame)) {
          throw new DomError(
            'SecurityError',
            "A frame of another origin's address is none of this document's.",
          );
        }
        return at;
      }
      case 'frameNavigate': {
        const frame = this._element(a);
        // only its own origin may send it a `javascript:` URL (`maySend`)
        if (
          /^javascript:/i.test(this._resolve(text(b))) &&
          !this._sameOrigin(this._frameAt.get(frame) ?? 'about:blank')
        ) {
          return null;
        }
        this.navigateFrame(frame, text(b), null, text(c));
        return null;
      }
      // a frame's address changed by its own history, with no navigation:
      // never to or from another origin, since what the address says is what
      // `frameDocument` hands a page a document by
      case 'setFrameLocation': {
        const frame = this._element(a);
        const at = this._frameAt.get(frame) ?? 'about:blank';
        const to = text(b);
        if (
          !this._reaches(frame) ||
          !(this._sameOrigin(to) || originOf(to) === originOf(at))
        ) {
          throw new DomError(
            'SecurityError',
            "A frame's history stays in its origin.",
          );
        }
        this._frameAt.set(frame, to);
        return null;
      }
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
        const held = this._viewportHeld();
        const keys = ids.map(
          (id) => (held && this._viewports.get(id)) || this._viewportKey(id),
        );
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
          this._documentOf(
            `<!doctype html><html><head>${title}</head><body></body></html>`,
          ),
        );
      }
      case 'parseDocument':
        return this.idOf(this._documentOf(text(a)));
      // a frame's document opened for writing: what the frame was loading
      // goes no further, and holds no `load` of the page's
      case 'openDocument': {
        const frame = this._frameOf.get(this._node(a) as Document);
        if (frame) {
          this._frameLoads.set(frame, (this._frameLoads.get(frame) ?? 0) + 1);
          this._frameDone(frame);
        }
        return null;
      }
      // a page's own document made again of what it wrote between `open`
      // and `close`
      case 'fillDocument': {
        const doc = this._node(a);
        if (!this._documents.has(doc as Document)) {
          throw new DomError('InvalidStateError', 'Not a document of its own.');
        }
        this._fill(doc as Document, text(b));
        this._wroteFrame(doc as Document);
        return null;
      }
      case 'title': {
        const title = titleOf(
          a ? (this._node(a) as ParentNode) : this.document,
        );
        return title
          ? DomUtils.textContent(title).replace(/\s+/g, ' ').trim()
          : '';
      }
      case 'setTitle': {
        const doc = b ? (this._node(b) as ParentNode) : this.document;
        let title = titleOf(doc);
        if (!title) {
          const root = drawingRootOf(doc);
          const head =
            root ??
            DomUtils.findOne((el) => el.name === 'head', doc.children) ??
            (doc.children.find((k) => k instanceof Element) as
              Element | undefined);
          if (!head) return null;
          title = new Element('title', {}, []);
          if (root) title.namespace = SVG_NS;
          this._put(head, [title], root ? (root.children[0] ?? null) : null);
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
      // a fetched `@import`'s text, for `CSSImportRule.styleSheet`
      case 'importedCss': {
        const handle = this._seams.handle as Partial<HandleInternals> | null;
        return handle?.importedCss?.(text(a)) ?? null;
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
        if (this._looked && this._viewportHeld()) return this._looked;
        this.flush();
        this._looked =
          this._seams.handle.geometryKey?.() || `new ${++this._looks}`;
        return this._looked;
      }
      case 'rect': {
        this.flush();
        const element = this._element(a);
        const rect =
          this._seams.handle.elementRect(element) ?? this._foreignRect(element);
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
      // every name a style has an attribute for, a computed style's list
      // with what it leaves out
      case 'styleProperties': {
        const style = this._seams.handle.computedStyle(this._element(a), null);
        if (!style) return '';
        return [
          ...Object.keys(style),
          ...SHORTHAND_NAMES,
          ...declaredProperties(),
          ...Object.keys(SVG_PROPERTIES),
          'marker',
        ].join(',');
      }
      case 'computed': {
        this.flush();
        const pseudo = computedPseudo(b);
        // and a file input's button, which only a document draws, for its
        // widget (`Cascade.partStyle`)
        const part = b === 'file-selector-button' ? b : pseudo;
        // a page's realm asks for the shorthands (`d`) only where it reads
        // one: they are no part of what a read of a longhand sends
        const send = (style: Record<string, string> | null): string =>
          style ? JSON.stringify(d ? cssomShorthands(style) : style) : '';
        // SVG's properties, asked for apart as a page reads one
        // (`svg-properties.ts`)
        if (d === 'svg') {
          const el = this._element(a);
          if (!this._inDocument(el)) return '';
          const handle = this._drawing(el) as Partial<HandleInternals> | null;
          const svg = handle?.svgComputed?.(el);
          return svg ? JSON.stringify(svg) : '';
        }
        // a view transition's, which the element answers for its root
        if (typeof b === 'string' && b.startsWith('view-transition')) {
          return send(
            this._seams.handle.computedStyle(
              this._element(a),
              b as `view-transition${string}`,
            ),
          );
        }
        // a frame's document's, which nothing draws
        if (!this._inDocument(this._element(a))) {
          return send(this._frameStyle(this._element(a), pseudo));
        }
        // a style can be read with text waiting to be set again, which only
        // moves its boxes: marked so with a `~`, and asked for again with
        // the property (`c`) where a page reads one a box decides
        const { handle } = this._seams;
        if (typeof c === 'string') {
          if (!comesFromBox(c)) return '';
        } else if (handle.styleWhileOwed) {
          const json = send(handle.styleWhileOwed(this._element(a), part));
          return json && !d && handle.layoutOwed?.() ? `~${json}` : json;
        }
        return send(handle.computedStyle(this._element(a), part));
      }
      case 'computedShorthands':
        return JSON.stringify(SHORTHAND_NAMES);
      case 'computedSvg':
        return JSON.stringify(Object.keys(SVG_PROPERTIES));
      // the document's `medium` in CSS pixels, which its keyword sizes are
      // worked out from
      case 'fontMedium':
        return this._seams.handle.fontMedium?.() ?? 16;
      // the few values of an element's computed style the editing commands
      // read (`editing.ts`), by camel-case name: a command asks them of
      // every node it walks, and a whole style is most of a read
      case 'editingStyle': {
        this.flush();
        const el = this._element(a);
        const { handle } = this._seams;
        const style = !this._inDocument(el)
          ? this._frameStyle(el, null)
          : handle.styleWhileOwed
            ? handle.styleWhileOwed(el, null)
            : handle.computedStyle(el, null);
        if (!style) return '';
        return JSON.stringify({
          display: style.display,
          whiteSpace: style['white-space'],
          backgroundColor: style['background-color'],
          color: style.color,
          fontFamily: style['font-family'],
          fontSize: style['font-size'],
          fontStyle: style['font-style'],
          fontWeight: style['font-weight'],
          textAlign: style['text-align'],
          textDecoration: style['text-decoration-line'],
          verticalAlign: style['vertical-align'],
        });
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
        return `${v.width},${v.height},${v.scrollX},${v.scrollY},${v.dpr},${v.originX ?? 0}`;
      }
      // how far the viewport's scrollable overflow reaches: the root's
      // `scrollWidth` and `scrollHeight`, or '' where nothing answers
      case 'documentSize': {
        this.flush();
        const size = this._seams.handle.documentSize?.();
        return size ? `${size.width},${size.height}` : '';
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
        // from the viewport's scroll origin, as a page writes `scrollX`:
        // negative from one at the right
        const origin = this._seams.viewport().originX ?? 0;
        const x = Math.max(0, (Number(a) || 0) + origin);
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
      // a head stylesheet still on its way holds the page's first paint
      // (`HtmlViewNode.renderBlocked`), which the animation-frame loop
      // asks so rAF waits as it does for `blocking=render`
      case 'renderBlocked':
        return this._seams.handle.renderBlocked() === true;

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
      // a face `new FontFace` made, from what a script handed over: whether
      // its family, its descriptors and its source can be read
      case 'fontFaceNew': {
        const fonts = this._fontsOf(a)?.scriptFonts?.();
        const doc = this._node(a) as Document;
        const root = doc.children?.find((k) => k instanceof Element);
        if (!fonts || !root) return true;
        const id = Number(b);
        const { family, src, init } = JSON.parse(text(c)) as {
          family: string;
          src: string | null;
          init: FontFaceInit;
        };
        const rule = scriptFontFace(
          family,
          src,
          typeof d === 'string' ? Buffer.from(d, 'base64') : null,
          init,
          this._seams.handle.base ?? this.url,
        );
        if (!rule) return false;
        fonts.makeFace(id, rule, root as Element, (ok) =>
          this._faceDone(id, ok),
        );
        return true;
      }
      case 'fontFaceSet':
        this._fontsOf(a)
          ?.scriptFonts?.()
          ?.setFace(Number(b), JSON.parse(text(c)) as FontFaceInit);
        return null;
      case 'fontFaceLoad': {
        const id = Number(b);
        const fonts = this._fontsOf(a)?.scriptFonts?.();
        if (!fonts) {
          this._faceDone(id, false);
          return null;
        }
        void fonts.loadFace(id).then(
          (ok) => this._faceDone(id, ok),
          () => this._faceDone(id, false),
        );
        return null;
      }
      case 'fontFaceAdd':
        this._fontsOf(a)?.scriptFontsChanged?.(Number(b), c === true);
        return null;
      // what a canvas's context asks of the fonts (`canvas-text.ts`): each
      // is null where there is no text engine, and the context makes do
      case 'canvasFont': {
        this.flush();
        const fonts = this._canvasFonts(a);
        if (!fonts) return null;
        const font = fonts.font(text(b), this._canvasOf(a));
        return font ? JSON.stringify(font) : '';
      }
      case 'canvasTextNow': {
        const fonts = this._canvasFonts(a);
        if (!fonts) return null;
        return `${fonts.generation},${fonts.direction(this._canvasOf(a))}`;
      }
      case 'canvasMeasure': {
        const answer = this._canvasFonts(a)?.measure(
          text(b),
          text(c),
          textSetting(text(d).split(',')),
        );
        return answer ? JSON.stringify(answer) : null;
      }
      // the bytes as a string of one byte a character, which crosses
      // uncopied, where base64 would be a third more to decode
      case 'canvasRaster': {
        const [size, stroke, ...setting] = text(d).split(',');
        const raster = this._canvasFonts(a)?.raster(
          text(b),
          text(c),
          Number(size),
          textSetting(setting),
          Number(stroke),
        );
        if (!raster) return null;
        const { data, ...head } = raster;
        const bytes = Buffer.from(data.buffer, data.byteOffset, data.length);
        return `${JSON.stringify(head)}\n${bytes.toString('latin1')}`;
      }
      // where what an inline drawing holds is (`svg-geometry.ts`)
      case 'svg': {
        this.flush();
        const el = this._element(a);
        const handle = this._drawing(el) as Partial<HandleInternals> | null;
        const measure = handle?.svgMeasure?.();
        if (!measure) return '';
        const answer = svgAnswer(text(b), el, measure, Number(c), Number(d));
        return answer ? answer.join(',') : '';
      }
      // what one of a relative unit comes to for an element's length, in
      // user units, or for no element's (`svg-dom.ts`)
      case 'svgLength': {
        this.flush();
        const el = a ? this._element(a) : null;
        const handle = (
          el ? this._drawing(el) : this._seams.handle
        ) as Partial<HandleInternals> | null;
        const measure = handle?.svgMeasure?.();
        if (!measure) return '';
        return unitSize(el, text(b), text(c), measure) ?? '';
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
                ? {
                    ...x.timeline,
                    source: id(x.timeline.source),
                    from: x.timeline.from ? id(x.timeline.from) : undefined,
                  }
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
      // a page's `updateTiming()` on a CSS animation's effect
      case 'timeAnimation':
        this._seams.handle.timeAnimation?.(Number(a), String(b));
        return null;
      case 'seekAnimation':
        this._seams.handle.seekAnimation?.(Number(a), Number(b), c === true);
        return null;
      // a view timeline's subject: how far from the scroll now each of its
      // edges crosses each of its scrollport's, less the insets given
      case 'viewAdjust': {
        this.flush();
        const el = this._element(a);
        const handle = this._drawing(el) as Partial<HandleInternals> | null;
        const inset = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? v : null;
        const v = handle?.viewAdjust?.(el, b === true, [inset(c), inset(d)]);
        return v ? `${v.enters},${v.leaves},${v.start},${v.end}` : '';
      }
      // a page's timeline's axis against its scroller: `x` or `y`, and `r`
      // where its scroll origin is at that axis's end
      case 'timelineAxis': {
        this.flush();
        const el = this._element(a);
        const handle = this._drawing(el) as Partial<HandleInternals> | null;
        return handle?.timelineAxis?.(el, String(b)) ?? '';
      }
      // where an anonymous timeline on an element looks for its source:
      // its id, or none for the viewport, and the physical axis, `x` or `y`;
      // '' for a subject with no box
      case 'timelineSource': {
        this.flush();
        const el = this._element(a);
        const handle = this._drawing(el) as Partial<HandleInternals> | null;
        const found = handle?.timelineSource?.(el, String(b));
        if (!found) return '';
        const source = found.source ? this.idOf(found.source) : '';
        return `${source},${found.axis}`;
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
          name === 'currentTime' &&
          typeof c === 'number' &&
          Number.isFinite(c) &&
          this._feeds.of(el)
        ) {
          // a feed's player is sought in its session's seconds, or handed a
          // session of its own (`Feed.seek`)
          const t = this._feeds.of(el)!.seek(c);
          if (t !== null)
            this._seams.handle.setMediaState(el, { currentTime: t });
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
      // what is wrong with a control, as `flag NUL message`, or '' for
      // nothing; whether it is validated at all; and a script's own reason,
      // from `setCustomValidity()`, '' taking it back
      case 'validity': {
        const wrong = validityError(this._element(a));
        return wrong ? `${wrong.flag}\u0000${wrong.message}` : '';
      }
      case 'willValidate':
        return validated(this._element(a));
      case 'customValidity': {
        const el = this._element(a);
        if (setCustomError(el, text(b))) this._tell(el, controlChange(el));
        return null;
      }
      // a box's `indeterminate`, which is in no attribute; given no `b`,
      // what it is
      case 'indeterminate': {
        const el = this._element(a);
        if (typeof b === 'boolean' && setIndeterminate(el, b)) {
          this._tell(el, controlChange(el));
        }
        return indeterminateSet(el);
      }
      // a custom element's states, `:state()` from now, told as a change of
      // an attribute nothing has, which only it reads
      case 'customStates': {
        const el = this._element(a);
        const names = text(b).split('\u0000').filter(Boolean);
        if (setCustomStates(el, names)) {
          this._tell(el, {
            type: 'attributes',
            target: el,
            attributeName: '-rx-state',
          });
        }
        return null;
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
        this.focusedFrame = el.name === 'iframe' ? el : null;
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
            // or taken back, as a press elsewhere takes a focus still owed
            if (pending && this._seams.handle.activeElement !== el) return;
            this._seams.handle.focus(el);
          }, 16);
        }
        return null;
      }
      case 'blur':
        this._focusing = null;
        this._seams.handle.blur();
        return null;
      case 'active': {
        const active = this._focusing?.parent
          ? this._focusing
          : this._seams.handle.activeElement;
        // an element taken out of the document has lost the focus as it went
        // (HTML, "focus fixup steps"), though `<Html>` hears of it only at
        // its next render
        return active && !this._inDocument(active) ? 0 : this.idOf(active);
      }
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
        // a sandbox's form is no form to send, before its `submit` is asked
        // about (HTML 4.10.21.3, step 3)
        if (c === true && this.sandbox & SB_FORMS) return false;
        return this._seams.handle.reportValidity(
          this._element(a),
          b ? this._element(b) : null,
          c === true,
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
        return !!this._seams.serviceWorkers;
      // what a page's service worker objects ask of the registry, and what a
      // worker's own realm says to it
      case 'sw':
        if (this.serviceClient) return this.serviceClient.heard(text(a));
        this._serviceSaid(text(a));
        return null;
      case 'cache':
        this._cacheOp(Number(a), text(b));
        return null;
      case 'image': {
        const el = this._node(a) as Element;
        if (b === 'clean') return this._imageClean(el);
        const state = this._imageDrawn(el)?.imageState?.(el);
        // nothing draws it: as it would be with no image to wait for
        if (!state) return b === 'complete' ? true : b === 'src' ? '' : 0;
        const read = state[text(b) as keyof typeof state];
        return typeof read === 'object' ? null : read;
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
      // the document's address changed by its own history. Never to another
      // origin: this is what every check of a document's origin reads
      case 'setLocation': {
        const to = text(a);
        if (originOf(to) !== originOf(this.url)) {
          throw new DomError(
            'SecurityError',
            "A document's history stays in its origin.",
          );
        }
        this.url = to;
        return null;
      }
      case 'resolve':
        return this._resolve(text(a));
      case 'characterSet':
        return this._encodingOf(
          a ? (this._node(a) as Document) : this.document,
        );
      case 'encodingLabel':
        return encodingOf(text(a)) ?? '';
      case 'textDecode':
        return this._textDecode(Number(a), text(b), text(c), Number(d));
      case 'decodeResponse':
        // marked, as `_textDecode`'s is
        return `=${decodeInEncoding(
          new Uint8Array(Buffer.from(text(a), 'base64')),
          text(b),
        )}`;
      case 'formEncoding':
        return formEncoding(this._element(a), this._encodingOf(this.document));
      case 'formQuery':
        return urlencoded(JSON.parse(text(a)) as [string, string][], text(b));
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
        this._seams.navigate(
          text(a),
          b ? 'replace' : 'here',
          null,
          undefined,
          this.navigationSource(),
        );
        return null;
      // this frame sends the window it is in somewhere, which it has no
      // address of and may not read: a frame of another origin only behind a
      // gesture, as Chromium keeps a frame from taking a page away, and a
      // sandboxed one as its flags say (HTML 7.4.2.3)
      case 'navigateTop': {
        const to = this._resolve(text(a));
        const parent = this.frameParent;
        if (!parent || parent.frameParent || /^javascript:/i.test(to)) {
          return null;
        }
        const gesture = this.entries?.call('__windowActivation', null) === true;
        if (!this.mayNavigateTop(gesture) || (!this.sandbox && !gesture)) {
          throw new DomError(
            'SecurityError',
            `Blocked a frame from navigating the top window to '${to}'.`,
          );
        }
        this.windows?.initiates(0);
        parent._seams.navigate(to, 'here', null, undefined, {
          origin: this._origin(),
          user: gesture,
        });
        return null;
      }
      // `window.open` and what it reads (`./windows.ts`, `./popups.ts`)
      case 'windowFeatures':
        return JSON.stringify(parseWindowFeatures(text(a)));
      case 'windowBase':
        return this._seams.handle.base ?? this.creator ?? this.url;
      case 'windowPopups':
        if (this.sandbox & SB_POPUPS) return 'sandboxed';
        return !this._seams.popups
          ? 'none'
          : this._seams.popups.unblocked
            ? 'any'
            : 'gesture';
      case 'windowBlocked':
        this._seams.popups?.blocked?.(text(a));
        return null;
      case 'windowOpen':
        if (this.sandbox & SB_POPUPS) return 0;
        return this.windows?.open(JSON.parse(text(a)) as PopupAsk) ?? 0;
      case 'windowTab':
        this._openTab(text(a), text(c), !!b);
        return null;
      case 'windowFind':
        return this.windows?.find(text(a)) ?? 0;
      case 'windowInitiates':
        this.windows?.initiates(Number(a));
        return null;
      case 'windowClose':
        this.windows?.close(Number(a));
        return null;
      case 'windowFocus':
        this.windows?.focus(Number(a));
        return null;
      case 'windowResizeTo': {
        // a script's `resizeTo` in this window: a popup's host updates the
        // window it shows; a top-level tab has no popup and keeps the size
        // the realm already set (`windowSize`)
        this._seams.popup?.resizeTo(Number(a) || 0, Number(b) || 0);
        return null;
      }
      case 'windowNavigate':
        // nothing runs a script in another window's document here, and HTML
        // has it do nothing for another origin's
        if (!/^javascript:/i.test(text(b))) {
          this.windows?.navigate(Number(a), this._resolve(text(b)), !!c);
        }
        return null;
      case 'windowName':
        this.windows?.named(text(a));
        return null;
      case 'windowDisown':
        this.windows?.disown();
        return null;
      case 'windowReached':
        this.windows?.reached(Number(a));
        return null;
      case 'windowOpener':
        return this.windows?.openerOf(Number(a)) ?? 0;
      case 'windowLength':
        return this.windows?.lengthOf(Number(a)) ?? 0;
      case 'windowFollow': {
        if (this.sandbox & SB_POPUPS) return true;
        const { noopener, noreferrer } = linkOpener(text(b), text(c));
        const made = this.windows?.follow(
          text(a),
          text(b),
          noopener,
          noreferrer,
          null,
        );
        return made ?? false;
      }
      // what a page writes into the `about:blank` a window opened with: read
      // back as it is written, and the scripts in it run at the end
      case 'writeWindow': {
        const markup = text(a);
        this.windows?.wrote();
        if (!b) this._fill(this.document, markup);
        else if (/<script/i.test(markup)) {
          this._replaceAll(this.document, this._htmlTree(markup, true));
        }
        return null;
      }
      case 'documentOrigin':
        return this._origin();
      // whether the document is a top-level traversable's, which only a
      // traversal there can be canceled in (HTML 7.2.6.10)
      case 'topLevel':
        return this.frameParent === null;
      case 'opaqueSrcdoc': {
        const frame = this._frameOf.get(this.document);
        return (
          !!frame &&
          this._frameAt.get(frame) === 'about:srcdoc' &&
          !!(this.sandbox & SB_ORIGIN)
        );
      }
      case 'referrer':
        return this.referrer;
      // any sandbox, whatever its tokens: none lifts `document.domain`'s flag
      // (HTML 7.1.?, "sandboxed document.domain browsing context flag")
      case 'sandboxed':
        return this.sandbox !== 0;
      case 'frameNamed': {
        const frame = navigableFor(this.document, text(a));
        return typeof frame === 'string' ? 0 : this.idOf(frame);
      }
      case 'handOver':
        this._s.handed = { node: this._node(a), origin: this._origin() };
        return null;
      case 'takeNode': {
        const handed = this._s.handed;
        this._s.handed = null;
        if (!handed) return 0;
        if (handed.origin !== this._origin() || handed.origin === 'null') {
          throw new DomError(
            'SecurityError',
            "A node of another origin's is none of this document's.",
          );
        }
        return this.idOf(handed.node);
      }
      // what crosses to a realm of another origin, which this one holds
      // nothing of (`ScriptEngine.link`)
      case 'realmPost':
        this.windows?.post(Number(a), text(b), text(c));
        return null;
      case 'realmWire':
        this.windows?.wire(Number(a), text(b));
        return null;
      // `window.open`, to where its name says (`navigableFor`): a frame of
      // the page's, the page's own tab, or a new one
      case 'open': {
        const to = navigableFor(this.document, text(b));
        if (to === 'here') {
          this._seams.navigate(
            text(a),
            'here',
            null,
            undefined,
            this.navigationSource(),
          );
        } else if (to === 'tab') this._openTab(text(a), text(b), false);
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
      // a page's `BroadcastChannel`s, by origin and name
      case 'bcOpen': {
        // an opaque origin talks to itself, whatever else is opaque
        const key = `${this.originless ? this._token : this._origin()} ${text(b)}`;
        const end = { id: Number(a), tell: this._channelTold };
        this._channels.set(Number(a), { key, end });
        openChannel(key, end);
        return null;
      }
      case 'bcPost': {
        const channel = this._channels.get(Number(a));
        if (channel) {
          postChannel(channel.key, channel.end, text(b), (fn) =>
            setTimeout(fn, 0),
          );
        }
        return null;
      }
      case 'bcClose': {
        const channel = this._channels.get(Number(a));
        if (channel) closeChannel(channel.key, channel.end);
        this._channels.delete(Number(a));
        return null;
      }
      // a page's `navigator.locks` (`page-channels.ts`)
      case 'lockRequest':
        this._holdsLocks();
        return requestLock(
          this._origin(),
          {
            id: Number(a),
            name: text(b),
            exclusive: c === true,
            client: this._lockClient,
            granted: this._lockGranted,
            stolen: this._lockStolen,
          },
          text(d).includes('i'),
          text(d).includes('s'),
        );
      case 'lockRelease':
        if (!this.originless) {
          releaseLock(this._origin(), Number(a), this._lockClient);
        }
        return null;
      case 'lockQuery':
        this._holdsLocks();
        return queryLocks(this._origin());
      case 'lockClient':
        return this._lockClient;
      // a page's compression streams, on node's zlib
      case 'zlibNew': {
        const id = Number(a);
        const tell = (kind: string, value: unknown): void => {
          if (!this._disposed) this.entries?.call('__zlib', [id, kind, value]);
        };
        this._zlibs.set(
          id,
          new PageZlib(text(b), {
            output: (chunks) => {
              for (const chunk of chunks) tell('data', base64Of(chunk));
            },
            end: (ok) => {
              this._zlibs.delete(id);
              tell('end', ok);
            },
          }),
        );
        return null;
      }
      case 'zlibWrite': {
        const id = Number(a);
        this._zlibs.get(id)?.write(Buffer.from(text(b), 'base64'), () => {
          if (!this._disposed) {
            this.entries?.call('__zlib', [id, 'written', true]);
          }
        });
        return null;
      }
      case 'zlibEnd':
        this._zlibs.get(Number(a))?.end();
        return null;
      case 'zlibDrop':
        this._zlibs.get(Number(a))?.dispose();
        this._zlibs.delete(Number(a));
        return null;
      // where what an inline drawing holds is (`svg-geometry.ts`)
      case 'svg': {
        this.flush();
        const el = this._element(a);
        const handle = this._drawing(el) as Partial<HandleInternals> | null;
        const measure = handle?.svgMeasure?.();
        if (!measure) return '';
        const answer = svgAnswer(text(b), el, measure, Number(c), Number(d));
        return answer ? answer.join(',') : '';
      }
      // what one of a relative unit comes to for an element's length, in
      // user units, or for no element's (`svg-dom.ts`)
      case 'svgLength': {
        this.flush();
        const el = a ? this._element(a) : null;
        const handle = (
          el ? this._drawing(el) : this._seams.handle
        ) as Partial<HandleInternals> | null;
        const measure = handle?.svgMeasure?.();
        if (!measure) return '';
        return unitSize(el, text(b), text(c), measure) ?? '';
      }
      case 'uuid':
        return crypto.randomUUID();
      case 'secureContext':
        return this._secureContext();
      // a file input: which selection it holds, what is in it, a piece of
      // one file's bytes, its picker, and what a script set
      case 'fileList':
        return this._fileList(this._element(a));
      case 'fileChunk':
        return this._fileChunk(Number(a), Number(b));
      case 'download':
        if (this.sandbox & SB_DOWNLOADS) return false;
        return (
          this._seams.handle.download?.({
            url: text(a),
            filename: text(b),
            ...(text(c) && { bytes: bytesOf(text(c)) }),
            ...(text(d) && { type: text(d) }),
          }) ?? false
        );
      case 'dragOut':
        this._dragOut = text(a);
        return null;
      case 'pickFiles':
        this._seams.handle.pickFiles?.(this._element(a));
        return null;
      case 'setFiles':
        this._setFiles(this._element(a), text(b));
        return null;
      case 'clipboard':
        return this._clipboardOp(text(a), b, text(c));
      case 'permission':
        return this._permissionState(text(a));
      case 'permissionNames':
        return JSON.stringify(PERMISSION_NAMES);
      case 'permissionAsk':
        this._permissionAsk(Number(a), text(b));
        return null;
      case 'notification':
        this._notificationOp(text(a), Number(b), text(c));
        return null;
      case 'featureAllowed':
        return this._featureAllowed(text(a));
      case 'fullyActive':
        return this._fullyActive();
      // a page's `crypto.subtle` (`subtle.ts`): what it asks the runtime,
      // whose errors are told, and what opens a key
      case 'crypto':
        try {
          return this._subtle().op(text(a), b, c);
        } catch (error) {
          const e = error as Error;
          throw new DomError(e.name, e.message);
        }
      case 'fetch':
        this._fetch(Number(a), text(b));
        return null;
      case 'syncRequests':
        return this._seams.fetchSync
          ? 'worker'
          : this._seams.syncNetwork
            ? 'page'
            : '';
      case 'fetchSync':
        return this._syncRequest(text(a), Number(b));
      // a page's WebGL contexts, where the host has a GL (`gl.ts`)
      case 'glOpen':
        return this._contexts.open(JSON.parse(text(a)) as HtmlGLOptions);
      case 'glRun':
        this._contexts.run(Number(a), text(b));
        return null;
      case 'glAsk':
        return this._contexts.ask(Number(a), text(b));
      case 'glResize':
        this._contexts.resize(Number(a), Number(b), Number(c));
        return null;
      case 'glPresent':
        this._contexts.present(Number(a), this._element(b));
        return null;
      // a page's `MediaSource` (`mse.ts`), its bytes kept here: a clip of
      // VP9 to be played whole (`clips.ts`), or fragmented MP4 played as
      // it is appended (`feeds.ts`)
      case 'mseSupports':
        return this._feedsPlay() && feedTakes(text(a));
      case 'mseOpen': {
        const type = text(a);
        const el = this._element(b);
        const id = this._mseNext;
        if (this._feedsPlay() && feedTakes(type)) {
          this._mseNext += 1;
          this._feeds.open(id, el, text(c), Number(d) || 0);
          this._mse.set(id, { feed: true, id });
          return JSON.stringify({ id, stream: true });
        }
        const clip = this._clips.open(type, el);
        if (!clip) return JSON.stringify({ id: 0 });
        this._mseNext += 1;
        this._mse.set(id, { feed: false, id: clip });
        return JSON.stringify({ id });
      }
      case 'mseAppend': {
        const held = this._mse.get(Number(a));
        const bytes = Buffer.from(text(b), 'base64');
        if (!held) return JSON.stringify({ failed: true, ranges: [] });
        if (!held.feed) {
          return JSON.stringify(this._clips.append(held.id, bytes));
        }
        const asked = JSON.parse(text(c) || '{}') as Partial<AppendParams>;
        return JSON.stringify(
          this._feeds.append(held.id, bytes, {
            offset: Number(asked.offset) || 0,
            mode: asked.mode === 'sequence' ? 'sequence' : 'segments',
            windowStart: Number(asked.windowStart) || 0,
            windowEnd:
              asked.windowEnd === null || asked.windowEnd === undefined
                ? Infinity
                : Number(asked.windowEnd),
            time: Number(asked.time) || 0,
          }),
        );
      }
      case 'mseRemove': {
        const held = this._mse.get(Number(a));
        if (!held) return JSON.stringify({ ranges: [] });
        return JSON.stringify(
          held.feed
            ? this._feeds.remove(held.id, Number(b), Number(c))
            : this._clips.remove(held.id, Number(b), Number(c)),
        );
      }
      case 'mseAbort': {
        const held = this._mse.get(Number(a));
        if (held?.feed) this._feeds.reset(held.id);
        return null;
      }
      case 'mseChangeType': {
        // a feed takes another type it takes, as a reset of its parser
        const held = this._mse.get(Number(a));
        if (!held?.feed || !this._feedsPlay() || !feedTakes(text(b))) {
          return false;
        }
        this._feeds.reset(held.id);
        return true;
      }
      case 'mseEnd': {
        const held = this._mse.get(Number(a));
        if (held?.feed) this._feeds.end(held.id);
        else if (held) this._clips.end(held.id);
        return null;
      }
      case 'mseClose': {
        const held = this._mse.get(Number(a));
        this._mse.delete(Number(a));
        if (held?.feed) this._feeds.close(held.id);
        else if (held) this._clips.close(held.id);
        return null;
      }
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
      !(node instanceof Comment) &&
      !(node instanceof ProcessingInstruction)
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
      if (
        isImage(target) &&
        IMAGE_ATTRIBUTES.has(name!) &&
        imageStateMoved(name!, oldValue, target.attribs[name!] ?? null)
      ) {
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
    this._connected(nodes);
  }

  /** What a pointer is over moves to what held what was taken out, as
   *  Chromium's `BoundaryEventDispatchTracksNodeRemoval` has it, whether or
   *  not it comes back in the same task. */
  private _pointerLost(parent: AnyNode, removed: readonly AnyNode[]): void {
    for (let kind = 0; kind < 2; kind += 1) {
      const chain = this._pointerChains[kind];
      if (!chain?.length) continue;
      if (
        !(parent instanceof ShadowRoot) &&
        !chain.includes(parent as Element)
      ) {
        continue;
      }
      // what is out is what was around it as the tree has it: a light child
      // whose slot went is where it was, in no box
      for (const node of removed) {
        const at = chain.indexOf(node as Element);
        if (at < 0 || at + 1 <= this._pointerCut[kind]) continue;
        if (shadowIncludingHolds(node, chain[0])) {
          this._pointerCut[kind] = at + 1;
        }
      }
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
      previousSibling: previous,
      nextSibling: next,
    });
    if (removed.length) this._pointerLost(parent, removed);
    // a policy a `<meta>` brings is the document's once the element is in
    // its head, and stays when it goes (HTML, the `http-equiv` "Content
    // security policy" state)
    if (added.length && parent instanceof Element && parent.name === 'head') {
      for (const node of added) {
        this._noteCsp(node);
        this._noteReferrer(node);
      }
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

  private _selectOptions(): { pseudos: Pseudos } {
    if (this._pseudos) return this._pseudos;
    const handle = () => this._seams.handle;
    const focused = (el: Element): boolean => handle().activeElement === el;
    const nothing = (_el: Element): boolean => false;
    const pseudos: Pseudos = {
      ...CONTROL_PSEUDOS,
      ...NAMESPACE_PSEUDOS,
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
      // one that takes an argument has a second parameter, as css-select
      // counts them
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
      host: nothing,
    };
    return (this._pseudos = { pseudos });
  }
  private _pseudos: ReturnType<DomHost['_selectOptions']> | null = null;

  /** The options a page's own query is compiled with (`_query`). */
  private _queryOptions(): ReturnType<DomHost['_selectOptions']> & {
    relativeSelector: false;
    adapter: typeof QUERY_ADAPTER;
  } {
    return (this._queryOpts ??= {
      ...this._selectOptions(),
      relativeSelector: false,
      adapter: QUERY_ADAPTER,
    });
  }
  private _queryOpts: ReturnType<DomHost['_queryOptions']> | null = null;

  /**
   * A selector of the page's own — `querySelector`, `matches`, `closest` —
   * compiled as the DOM matches one (DOM 4.2.6): against the whole
   * document, with `:scope` the node it is asked from, and no relative
   * selector, which throws. css-select reads a query from an element as
   * jQuery does, `:scope .a .b`, and `el.querySelectorAll('.a .b')` found
   * none whose `.a` was above `el`. One that names no `:scope` and needs
   * no kept answers (a `:has()` or a `:contains()` does, `KEEPS_ANSWERS`
   * in the cascade) is compiled once: GitHub's scripts ask the same few
   * hundred selectors thousands of times a load. So it is told to keep
   * none, or `:is(.x .a) .y` answers what it did before the `.x` came
   * (fb55/css-select#1929); one compiled for this query keeps what it
   * found until the query ends.
   */
  private _query(selector: string, scope: AnyNode): (el: Element) => boolean {
    const keeps = !QUERY_SCOPED.test(selector) && !KEEPS_ANSWERS.test(selector);
    const xml = anyXmlDocuments() && this._xml.has(this._ownerOf(scope));
    const queries = xml ? this._xmlQueries : this._queries;
    const kept = keeps ? queries.get(selector) : undefined;
    if (kept) return kept;
    // an argument css-select takes as any text is the parser's to refuse, as
    // a sheet's is
    if (TAKES_AN_IDENT.test(selector) && !selectorList(selector)) {
      throw new Error('a pseudo-class given what it does not take');
    }
    // no namespace is declared for a query, so a prefix makes it none
    const qualified = qualifiedSelector(selector);
    if (qualified === null) throw new Error('an undeclared namespace prefix');
    const options = {
      ...this._queryOptions(),
      ...(xml && XML_QUERY),
      cacheResults: !keeps,
    };
    const query = compileHoisted(
      qualified,
      options.pseudos,
      (one, pseudos) =>
        compile(
          one,
          { ...options, pseudos } as Parameters<typeof compile>[1],
          keeps ? undefined : (scope as Element),
        ) as unknown as (el: Element) => boolean,
    );
    if (keeps) {
      if (queries.size >= KEPT_QUERIES) queries.clear();
      queries.set(selector, query);
    }
    return query;
  }
  private readonly _queries = new Map<string, (el: Element) => boolean>();
  private readonly _xmlQueries = new Map<string, (el: Element) => boolean>();

  /** Whether a node is in a `<template>`'s content. */
  private _inTemplate(node: AnyNode): boolean {
    let at = node;
    while (at.parent) at = at.parent;
    return CONTENT_FRAGMENTS.has(at);
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
  /** What came of a load of a face a page's script made, told a microtask
   *  later: a source already here settles inside the op that asked. */
  private _faceDone(id: number, ok: boolean): void {
    void Promise.resolve().then(() => {
      if (!this._disposed) this.entries?.call('__fontFaceDone', [id, ok]);
    });
  }

  /** The fonts a canvas draws with: its document's, or the page's for one
   *  in no document yet, which is where a chart measures its labels. */
  private _canvasFonts(id: Primitive): CanvasText | null {
    return (this._fontsOf(id) ?? this._seams.handle)?.canvasText?.() ?? null;
  }

  /** The canvas a context's id is, where it is one: an `OffscreenCanvas`'s
   *  context goes by the document. */
  private _canvasOf(id: Primitive): Element | null {
    const node = this._node(id) as Element;
    return node.attribs ? node : null;
  }

  /** Where what a `<foreignObject>` holds is drawn, through what the drawing
   *  does to the object: mermaid and d3 size their labels from this. */
  private _foreignRect(element: Element): Rect | null {
    const handle = this._drawing(element) as Partial<HandleInternals> | null;
    const measure = handle?.svgMeasure?.();
    const inside = handle?.foreignRect?.(element);
    if (!measure || !inside) return null;
    return drawnWithin(inside.object, inside.rect, measure);
  }

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

  /** This realm's `BroadcastChannel`s, compression streams and what it
   *  goes by among those holding locks. */
  private _channels = new Map<number, { key: string; end: ChannelEnd }>();
  private _zlibs = new Map<number, PageZlib>();
  private _lockClient = crypto.randomUUID();
  private _channelTold = (id: number, message: string): void => {
    if (!this._disposed) this.entries?.call('__bcMessage', [id, message]);
  };
  /** Told in a task of its own: a lock held by a page that took its
   *  request back in the same task is none. */
  private _lockGranted = (id: number): void => {
    setTimeout(() => {
      if (!this._disposed) this.entries?.call('__lockGranted', [id]);
    }, 0);
  };
  private _lockStolen = (id: number): void => {
    if (!this._disposed) this.entries?.call('__lockStolen', [id]);
  };

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
      if (NAMED_BY_NAME.has(el.name) && !isForeign(el)) {
        add(el.attribs.name, el);
      }
    }
    this._names.set(doc, { at, names });
    return names;
  }

  private _tell(node: AnyNode, change: HtmlChange): void {
    // a query after it asks of the tree as it is now, ahead of the flush
    controlsMoved();
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
    // no view draws it: where that is because it is shown as a picture, the
    // picture no longer says what the document does
    if (this._xml.has(doc)) this._goLive(doc);
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
  navigateFrame(
    frame: Element,
    url: string,
    post: FramePost | null,
    /** The referrer policy of the link that sent it there, where one did:
     *  the navigation is made under it rather than the frame's own. */
    referrerPolicy = '',
  ): void {
    if (!this._loadsFrame(frame)) return;
    this._frameNavigated.set(frame, referrerPolicyOf(referrerPolicy));
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
    return this._reaches(frame) ? doc : null;
  }

  /** Whether a frame's document is of this document's origin: where it was
   *  loaded from, unless its sandbox gave it an origin of its own. */
  private _reaches(frame: Element): boolean {
    const doc = this._frames.get(frame);
    if (doc && (this._s.sandboxes.get(doc) ?? 0) & SB_ORIGIN) return false;
    return this._sameOrigin(this._frameAt.get(frame) ?? 'about:blank');
  }

  /** The flags a document loaded in a frame now has: what the document the
   *  frame is in has, and what its `sandbox` says. An attribute changed after
   *  a load is read at the next (HTML 4.8.5). */
  private _frameSandbox(frame: Element): number {
    const around = this._s.sandboxes.get(this._ownerOf(frame)) ?? 0;
    return frame.name === 'iframe' && frame.attribs.sandbox !== undefined
      ? around | parseSandbox(frame.attribs.sandbox)
      : around;
  }

  /** The origin of each document around a frame of this realm's, nearest
   *  first, for what a document asks of what frames it (`./framing.ts`). */
  private _ancestorOrigins(frame: Element): string[] {
    const out: string[] = [];
    let doc: Document | undefined = this._ownerOf(frame);
    // a document of this realm's that has no realm of its own
    while (doc && doc !== this.document) {
      const holder = this._frameOf.get(doc);
      if (!holder) break;
      const flags = this._s.sandboxes.get(doc) ?? 0;
      const at = this._frameAt.get(holder) ?? 'about:blank';
      const blank = at === 'about:blank' || at === 'about:srcdoc';
      out.push(
        flags & SB_ORIGIN
          ? 'null'
          : blank
            ? this.origin
            : originOf(at) || 'null',
      );
      doc = this._ownerOf(holder);
    }
    for (let host: DomHost | null = this; host; host = host.frameParent) {
      out.push(host.origin);
    }
    return out;
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
    this._s.sandboxes.set(doc, this._frameSandbox(frame));
    this._frameAt.set(frame, 'about:blank');
    this._s.frameList.add(frame);
    this._s.framesChanged();
    return doc;
  }

  /** Whether an address is the page's own origin's: `about:blank` is the
   *  origin of the document that made it (HTML 7.1.1). */
  private _sameOrigin(url: string): boolean {
    if (url === 'about:blank' || url === 'about:srcdoc') return true;
    // an opaque origin is no other, a `file:` page's frame included, as
    // Chromium and Firefox have them
    const origin = this._origin();
    return origin !== 'null' && originOf(url) === origin;
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
    if (!this._frames.has(el) || !this._loadsFrame(el)) return false;
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
        const sandbox = this._frameSandbox(frame);
        this._frameLoaded(
          frame,
          this._documentOf(srcdoc, true, !!this._seams.drawsFrames),
          'about:srcdoc',
          'text/html',
          !(sandbox & (SB_SCRIPTS | SB_ORIGIN)),
          loaded,
          sandbox,
        );
      }, 0);
      return;
    }
    let src = this._frameSrc(frame);
    // a frame is never its own document's address again, which would hold
    // the page in itself without end (HTML 7.8.1, the iframe's "process the
    // iframe attributes", an ancestor's URL)
    if (src && src.split('#')[0] === this.url.split('#')[0]) src = null;
    // read as the address is set, since a page may revoke it as soon as it
    // has (URL's "blob URL entry", which a parsed URL keeps)
    const blob = src && /^blob:/i.test(src) ? this._blobResponse(src) : null;
    // another origin's frame is loaded where the browser draws frames, to
    // run in a realm of its own, at its own origin, which reaches this one
    // as one window of another origin reaches another; elsewhere nothing of
    // it is
    const foreign = !!src && !blob && !this._sameOrigin(src);
    if (!src || (foreign && !(this._seams.drawsFrames && this._framed(src)))) {
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
    const landed = /^blob:/i.test(src)
      ? blob
        ? Promise.resolve(blob)
        : Promise.reject(new TypeError('A blob: URL that holds nothing.'))
      : /^data:/i.test(src)
        ? Promise.resolve(this._dataResponse(src))
        : this._navigationFetch(
            {
              ...(post
                ? {
                    url: src,
                    method: 'POST',
                    headers: [['content-type', post.contentType]],
                    ...(typeof post.body === 'string'
                      ? { body: post.body }
                      : { body: null, bytes: post.body }),
                  }
                : { url: src, method: 'GET', headers: [], body: null }),
              // a nested navigation, which says what holds it
              mode: 'navigate',
              destination: frameDestination(frame),
              // and where it was made from, under the frame's referrer
              // policy or its document's (HTML 2.5.5)
              referrer: this._frameReferrer(frame, src),
            },
            new AbortController().signal,
            this._frameSandbox(frame),
          );
    landed
      .then((response) => {
        if (this._disposed || this._frameLoads.get(frame) !== serial) return;
        // no content is no navigation (HTML 7.4.2.3.3): the frame goes on
        // showing what it was, and hears no `load`
        if (response.status === 204 || response.status === 205) {
          release(response);
          this._frameDone(frame);
          return;
        }
        const sandbox =
          this._frameSandbox(frame) | sandboxOfPolicy(response.headers);
        const refused = this._refusedFraming(
          frame,
          response,
          response.url || src!,
          sandbox,
        );
        if (refused) {
          release(response);
          this._frameRefused(frame, response.url || src!, refused, loaded);
          return;
        }
        const type = (headerOf(response.headers, 'content-type') ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        // an `<object>` that could not be had shows its fallback (HTML
        // 4.8.7), and an `<embed>` holds a document where it is answered
        // one: an image is its picture, and anything else a plugin's, which
        // nothing here is
        const failed = frame.name === 'object' && response.status >= 400;
        if (
          failed ||
          (frame.name === 'embed' &&
            type !== 'text/html' &&
            type !== 'text/plain' &&
            !isXmlType(type))
        ) {
          release(response);
          if (!failed) loaded();
          else if (this.entries) {
            this.entries.call('__fire', [this.idOf(frame), 'error']);
            this._frameDone(frame);
          }
          return;
        }
        let doc: Document;
        let scripts = true;
        const { text, encoding } = this._frameText(response, type, frame);
        if (type === 'text/html') {
          doc = this._documentOf(text, true, !!this._seams.drawsFrames);
        } else if (isXmlType(type)) {
          const xml = xmlTree(text);
          // one that is not well-formed is the error and nothing of it, as
          // Firefox shows it: Acid3's test 70 looks for what came after a
          // byte UTF-8 has no character for
          const kids = xml.wellFormed ? xml.kids : [parserError()];
          doc = new Document(kids);
          for (const kid of kids) kid.parent = doc;
          this._documents.add(doc);
          markXmlDocument(doc, type);
          // a document that is not well-formed runs none of its scripts
          scripts = xml.wellFormed;
        } else {
          doc = this._documentOf(
            type.startsWith('image/')
              ? `<img src="${escapeAttribute(response.url || src)}">`
              : `<pre>${escapeText(text)}</pre>`,
            true,
          );
          scripts = false;
        }
        this._s.encodings.set(doc, encoding);
        // another origin's scripts never run in this realm, where it was
        // asked for or where it sent the frame, and a sandbox's, of an origin
        // of their own or none to run, no more than they
        if (
          foreign ||
          sandbox & (SB_SCRIPTS | SB_ORIGIN) ||
          !this._sameOrigin(response.url || src)
        ) {
          scripts = false;
        }
        this._frameLoaded(
          frame,
          doc,
          response.url || src!,
          type,
          scripts,
          loaded,
          sandbox,
        );
      })
      .catch((error: unknown) => {
        // a download a sandbox may not save goes nowhere: the frame keeps
        // what it shows, and hears nothing
        if (error instanceof DownloadRefused) {
          this._seams.log(
            'warn',
            `A sandbox saves no file: ${error.message} was not downloaded.`,
          );
          this._frameDone(frame);
          return;
        }
        // a frame whose document could not be had still hears `load`, as
        // a browser's showing its error page does
        this._seams.log(
          'error',
          `The frame's ${src} could not be loaded: ${String((error as Error)?.message ?? error)}`,
        );
        loaded();
      });
  }

  /** Whether a document that is not this one's to read is loaded for a frame:
   *  one of the network's, a `data:` URL, which is its own body, and a `file:`
   *  one for a `file:` page, which the host's network has the say over. */
  private _framed(src: string): boolean {
    return (
      /^(?:https?|data):/i.test(src) ||
      (/^file:/i.test(src) && /^file:/i.test(this.url))
    );
  }

  /**
   * A `blob:` URL as a frame's document is read, from the realm that made it
   * or one of its own origin around this one, since no network has one: every
   * preview written to a blob came out an empty document, with its `load`.
   * Null for one none of them holds, which is a failed load, and a blob of
   * another origin is none of this document's to read.
   */
  private _blobResponse(src: string): FetchResponse | null {
    const url = src.split('#')[0];
    for (let host: DomHost | null = this; host; host = host.frameParent) {
      if (host !== this && !this._sameOrigin(src)) break;
      const bytes = host.entries?.call('__blobBytes', [url]);
      if (typeof bytes !== 'string') continue;
      const type = host.entries?.call('__blobType', [url]);
      return {
        url: src,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: [['content-type', typeof type === 'string' ? type : '']],
        body: '',
        bytes: Buffer.from(bytes, 'base64'),
      };
    }
    return null;
  }

  /** A `data:` URL as a frame's document is read: no network has one. */
  private _dataResponse(url: string): FetchResponse {
    const read = readDataUrl(url);
    if (!read) throw new TypeError('A data: URL with nothing in it.');
    return {
      url,
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: [['content-type', read.type]],
      body: new TextDecoder().decode(read.bytes),
    };
  }

  /** Why a response may not be shown in a frame, or null: read from its
   *  headers, of every document around the frame, before any of it is. */
  private _refusedFraming(
    frame: Element,
    response: FetchResponse,
    url: string,
    sandbox: number,
  ): 'frame-ancestors' | 'x-frame-options' | null {
    return framingRefused(
      response.headers,
      url,
      sandbox & SB_ORIGIN ? 'null' : originOf(url) || 'null',
      this._ancestorOrigins(frame),
    );
  }

  /**
   * A frame whose document refused it shows what a browser shows, a page of
   * its own that says so and none of the document, of no origin but its own,
   * and hears `load` as it would for any failure to show one.
   */
  private _frameRefused(
    frame: Element,
    url: string,
    why: string,
    loaded: () => void,
  ): void {
    this._seams.log(
      'error',
      `Refused to display '${url}' in a frame: its ${why} forbids it.`,
    );
    const host = /^[a-z]+:\/\/([^/]*)/i.exec(url)?.[1] ?? url;
    this._frameLoaded(
      frame,
      this._documentOf(
        `<!doctype html><body style="font:14px sans-serif;color:#666;margin:16px">${escapeText(host)} refused to connect.`,
        true,
      ),
      'about:blank',
      'text/html',
      false,
      loaded,
      SB_ORIGIN | SB_SCRIPTS,
    );
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
      if (!this._loadsFrame(frame)) this._unloadFrameDocument(frame);
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
    sandbox = 0,
  ): void {
    // a frame the browser draws runs its own scripts, and tells its own
    // `load` once they have, in a realm of its own — where it has any,
    // HTML's or XML's, which `_frameScripts` cannot run as a browser does:
    // a drawing's it does not run at all. A document with none has no code
    // to want globals of its own, and the page's realm reaches into it at
    // once, as Acid3's do into theirs, where a realm would answer once
    // React had mounted it
    // — and where a service worker can have it for a client, which a secure
    // page's frame of its own origin is, whether or not a scope holds it yet:
    // its `navigator` has to answer for it, and it can be claimed
    this._s.sandboxes.set(doc, sandbox);
    const scripted =
      (type === 'text/html' || isXmlType(type)) && hasScripts(doc);
    const realm =
      !!this._seams.drawsFrames &&
      !(sandbox & SB_SCRIPTS) &&
      (scripted ||
        (!!this._seams.serviceWorkers &&
          this._secureContext() &&
          !(sandbox & SB_ORIGIN) &&
          this._sameOrigin(address)));
    if (realm) this._s.realms.add(doc);
    // the one it shows unloads first, while it is still the frame's
    this._unloadFrameDocument(frame);
    if (this._disposed) return;
    // HTML has a frame's `load` wait for its document to be completely
    // loaded (13.2.7, "the end"), images and all, which only the view the
    // page mounts over the frame asks for (`_waitsForView`). Owed before
    // anything hears of the document, so no view can say it is loaded first.
    const owed = !realm && this._waitsForView(frame);
    if (owed) this._loadsOwed.set(doc, loaded);
    this._frames.set(frame, doc);
    this._frameOf.set(doc, frame);
    this._frameAt.set(frame, address);
    this._s.frameList.add(frame);
    this._s.framesChanged();
    if (realm) {
      // told as the realm is linked to this one, an entry of the page's
      if (scripted) this._goLive(doc);
      return;
    }
    if (this._loadsFrame(frame)) this._framesShown.add(frame);
    if (scripts) {
      this._frameScripts(doc, address === 'about:srcdoc' ? this.url : address);
    }
    // its own frames, which no realm of its own loads, are loaded here, as
    // the page's are as they are met
    if (this._seams.drawsFrames && this._holdsFrames(doc)) {
      this._framesIn(doc.children);
    }
    if (!owed) loaded();
  }

  /**
   * A frame's scripts, in tree order: the inline ones of HTML's (or of
   * XHTML's, in an XML document), run in the page's realm with the frame's
   * window and document for their globals (`__frameScript`), where the
   * browser draws no frames: one that does runs them in a realm of the
   * frame's (`_frameLoaded`). A frame here has no realm of its own, so what
   * one declares is its function's and not a window's — enough for a frame
   * that tells its parent it loaded, and short of a page that builds an
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

  /** A document's content made again of markup, by the parser `<Html>`
   *  reads a document with, the document itself kept: `document.open`,
   *  `write` and `close`'s. */
  private _fill(doc: Document, markup: string): void {
    this._replaceAll(doc, this._htmlTree(markup));
  }

  /**
   * A frame's document a script wrote has come to its end, and the frame
   * hears `load` in a task of its own, as for a document it loaded (HTML
   * 13.2.7, "the end"). A preview written with `open`, `write` and `close`
   * and a page waiting on the frame's `onload` waited for good. A document
   * that is no frame's has no `load` to tell, and one the frame has gone on
   * from by then none either.
   */
  private _wroteFrame(doc: Document): void {
    const frame = this._frameOf.get(doc);
    if (!frame || this._frames.get(frame) !== doc) return;
    const serial = (this._frameLoads.get(frame) ?? 0) + 1;
    this._frameLoads.set(frame, serial);
    setTimeout(() => {
      if (this._disposed || !this.entries) return;
      if (this._frameLoads.get(frame) !== serial) return;
      this.entries.call('__fire', [this.idOf(frame), 'load']);
    }, 0);
  }

  /** Markup read as a document is, by the parser `<Html>` reads one with,
   *  and made a document's tree; its scripts never run where it goes. */
  private _htmlTree(
    markup: string,
    live = false,
    declarative = true,
  ): ChildNode[] {
    const source = new HtmlSource();
    // a document scripts run in reads a `<noscript>`'s content as text, and
    // `DOMParser`'s, the one that attaches no shadow root, runs none
    source.setScripting(declarative);
    source.setDocument(true, declarative);
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
    return kids;
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
    if (isForeign(frame) || (frame.name === 'object' && !frame.attribs.data)) {
      return;
    }
    if (frame.name === 'embed' && !this._embedLoads(frame)) return;
    if (!this._frames.has(frame) && this._loadsFrame(frame)) {
      this._frameDocument(frame);
    }
  }

  /** The `<embed>`s with an address that are not rendered yet, each looked
   *  at again after a paint (`embedsPainted`). */
  private _embedsWaiting = new Set<Element>();

  /**
   * Whether an `<embed>` loads what it names now, which it does only while
   * it is rendered (HTML 4.8.6): one that is not waits, and loads if that
   * changes. It holds nothing a page reaches at once, as an `<iframe>`'s
   * first `about:blank` is, so nothing is lost by waiting, and a `javascript:`
   * address is a network error to it, and no `load`.
   */
  private _embedLoads(embed: Element): boolean {
    this._embedsWaiting.delete(embed);
    const src = (embed.attribs.src ?? '').trim();
    if (!src || !this._seams.drawsFrames || /^javascript:/i.test(src)) {
      return false;
    }
    // a handle that cannot say has no document to hold it back
    const rendered = this._seams.handle.embedRendered?.(embed);
    if (rendered === undefined || rendered) return true;
    this._embedsWaiting.add(embed);
    return false;
  }

  /** A paint: an `<embed>` that was not rendered may be now, its sheets in
   *  or a script having shown it; and a frame's view may be mounted, or
   *  known never to be (`_awaitView`). */
  embedsPainted(): void {
    for (const embed of [...this._embedsWaiting]) {
      this._embedsWaiting.delete(embed);
      if (this._loadsFrame(embed)) this._frameIn(embed);
    }
    for (const frame of [...this._viewsAwaited]) this._awaitView(frame);
  }

  /** What a page's script put into its tree, as HTML's post-connection
   *  steps take it (DOM 4.2.3, "insert"), in tree order once all of it is
   *  in: a frame loaded, a script prepared. `innerHTML` and
   *  `replaceChildren` insert as `appendChild` does: a video site's player
   *  written in on a click, an `<iframe>` of YouTube's embed, loaded only
   *  once a page read its `contentWindow`, and was an empty box. */
  private _connected(nodes: readonly AnyNode[]): void {
    const found = DomUtils.findAll(
      (el) =>
        el.name === 'script' || el.name === 'link' || FRAME_TAGS.has(el.name),
      nodes as AnyNode[],
    );
    for (const el of found) {
      if (this._disposed) return;
      if (el.name === 'script') this._prepareScript(el);
      else if (el.name === 'link') this._preloadLink(el);
      else this._frameIn(el);
    }
  }

  /**
   * A `<link rel=preload>` or `modulepreload` a page's script put in, of
   * anything but a sheet, whose `<Html>` holds to its own: asked for, so
   * that it hears `load` or `error` (HTML 4.2.4), which is all it is for
   * here. A page's loader can wait on it before it puts the script in, as
   * Squoosh's does: with neither told, its editor never loaded.
   */
  private _preloadLink(el: Element): void {
    const { rel, href } = el.attribs;
    if (!rel || !href || isForeign(el) || isStylePreload(el)) return;
    if (!/(?:^|\s)(?:preload|modulepreload)(?:\s|$)/i.test(rel)) return;
    const id = this.idOf(el);
    const tell = (type: string) => {
      if (!this._disposed) this.entries?.call('__fire', [id, type]);
    };
    this._seams
      .fetch(
        { url: this._resolve(href), method: 'GET', headers: [], body: null },
        new AbortController().signal,
      )
      .then(
        (response) => {
          release(response);
          tell(
            response.status >= 200 && response.status < 300 ? 'load' : 'error',
          );
        },
        () => tell('error'),
      );
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
    if (!exec || this.inert.has(el) || !isStyleOrScript(el)) return;
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
   * Whether a frame is one this realm loads: in this document, or in the
   * document of one of its frames that has no realm of its own and is shown,
   * which nothing else would load it from (`_holdsFrames`).
   */
  private _loadsFrame(frame: Element): boolean {
    let at: AnyNode = frame;
    for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
      const doc = shadowIncludingRoot(at);
      if (doc === this.document) return true;
      if (!(doc instanceof Document) || !this._holdsFrames(doc)) return false;
      const holder = this._frameOf.get(doc);
      if (!holder || this._frames.get(holder) !== doc) return false;
      at = holder;
    }
    return false;
  }

  /**
   * Whether a frame's document of this realm's loads the frames in it here:
   * one with no realm of its own, of this realm's origin, or a sandbox's,
   * whose every frame is of an origin of none (`_frameSandbox`). Another
   * origin's holds frames whose `about:blank` and `srcdoc` would be its own,
   * which this realm has no way to give them, so it holds none, as before.
   */
  private _holdsFrames(doc: Document): boolean {
    if (this._s.realms.has(doc) || this._xml.has(doc)) return false;
    const holder = this._frameOf.get(doc);
    if (!holder) return false;
    return (
      ((this._s.sandboxes.get(doc) ?? 0) & SB_ORIGIN) !== 0 ||
      this._reaches(holder)
    );
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
    const styles = DomUtils.findAll(
      (e) => e.name === 'style' && isStyleOrScript(e),
      doc.children,
    );
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
      const cascade = new Cascade(
        sheets,
        FRAME_LOOK,
        size.width,
        size.height,
        1,
        null,
        null,
        null,
        null,
        null,
        null,
        [],
        null,
        this._xml.has(doc),
      );
      cascade.frameElement = this._frameOf.get(doc) ?? null;
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
    // what a frame loads is a document's markup, and so is `DOMParser`'s,
    // which attaches no shadow root a template declares
    const tree = this._htmlTree(markup, document && live, document);
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
    if (context && anyXmlDocuments() && this._xml.has(this._ownerOf(context))) {
      return this._parseXml(context, markup);
    }
    const name =
      context instanceof Element && !isForeign(context) ? context.name : '';
    if (RAW_TEXT.has(name)) return markup ? [new Text(markup)] : [];
    if (name === 'textarea' || name === 'title') {
      const held = parseFragment(`<${name}>${markup}</${name}>`).find(
        (k) => k instanceof Element && k.name === name,
      );
      const data = held ? DomUtils.textContent(held) : '';
      return data ? [new Text(data)] : [];
    }
    return this._parse(
      markup,
      declarative,
      context instanceof Element ? context : null,
    );
  }

  /**
   * Markup as `innerHTML` reads it in an XML document (HTML 13.5.2): in an
   * element that declares what is in scope around `context`, and a
   * `SyntaxError` where that is not well-formed. Its scripts never run.
   */
  private _parseXml(context: AnyNode, markup: string): ChildNode[] {
    const scope = new Map<string, string>();
    for (let at: AnyNode | null = context; at; at = at.parent) {
      if (!(at instanceof Element)) continue;
      for (const name in at.attribs) {
        if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
        if (!scope.has(name)) scope.set(name, at.attribs[name]);
      }
    }
    if (context instanceof Element && context.namespace !== undefined) {
      scope.set('xmlns', namespaceOf(context));
    }
    const declared = [...scope]
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join('');
    const read = xmlTree(`<fragment${declared}>${markup}</fragment>`);
    const held = read.kids.find((k): k is Element => k instanceof Element);
    if (!read.wellFormed || !held) {
      throw new DomError('SyntaxError', 'The markup is not well-formed XML.');
    }
    const kids = held.children.slice();
    for (const kid of kids) DomUtils.removeElement(kid);
    for (const el of DomUtils.findAll((e) => tagOf(e) === 'script', kids)) {
      this.inert.add(el);
    }
    for (const kid of kids) {
      if (kid instanceof Element && tagOf(kid) === 'script') {
        this.inert.add(kid);
      }
    }
    return kids;
  }

  /** Markup as `innerHTML` reads it in `context`, or `setHTMLUnsafe` with
   *  its declarative shadow roots; its scripts never run. */
  private _parse(
    html: string,
    declarative = false,
    context: Element | null = null,
  ): ChildNode[] {
    const kids = parseFragment(html, declarative, context);
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
      const base = this._seams.handle.base ?? this.creator ?? this.url;
      // a query is in the document's encoding (URL's "encoding-parse")
      const encoding = outputEncoding(this._encodingOf(this.document));
      return encoding === 'UTF-8'
        ? new URL(url, base).href
        : encodingCodecs.urlInEncoding(encoding, url, base);
    } catch {
      return url;
    }
  }

  /** The label `charset` last was and what it names, which `_resolve` asks
   *  for every URL a page's script reads. */
  private _charset: [string | undefined, string] = [undefined, 'UTF-8'];

  /** A document's encoding (DOM's, by its name): what its bytes were decoded
   *  with, what the host says of the one it handed over, and for a frame's
   *  first `about:blank` what made it. UTF-8 for anything else, a page's
   *  own `createHTMLDocument` among them. */
  private _encodingOf(doc: Document): string {
    const known = this._s.encodings.get(doc);
    if (known) return known;
    if (doc === this.document) {
      const label = this._seams.charset;
      if (this._charset[0] !== label) {
        this._charset = [label, (label && encodingOf(label)) || 'UTF-8'];
      }
      return this._charset[1];
    }
    const frame = this._initialBlank.has(doc) ? this._frameOf.get(doc) : null;
    const holder = frame ? documentHolding(frame) : null;
    return holder ? this._encodingOf(holder) : 'UTF-8';
  }

  /** A `TextDecoder`'s bytes, in any encoding but UTF-8, which the realm
   *  decodes itself. A decoder lasts while a stream is going through it. */
  private _textDecoders = new Map<number, LegacyDecoder>();
  private _textDecode(
    id: number,
    name: string,
    base64: string,
    flags: number,
  ): string | null {
    const stream = (flags & 1) !== 0;
    const decoder =
      this._textDecoders.get(id) ?? encodingCodecs.decoderFor(name);
    if (!decoder) return null;
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    const text = decoder.decode(bytes, stream, (flags & 2) !== 0);
    if (stream) this._textDecoders.set(id, decoder);
    else this._textDecoders.delete(id);
    // marked, since an answer that starts with U+0001 is a host error
    return text === null ? null : `=${text}`;
  }

  /**
   * A frame's response as text, and the encoding it comes to, kept with the
   * document it makes (`_encodedAs`): a frame with no label of its own is in
   * its parent's encoding (HTML's "encoding sniffing algorithm", step 8), and
   * XML has no parent to go by, its own declaration or UTF-8 instead. A
   * response with no bytes was text before it got here.
   */
  private _frameText(
    response: FetchResponse,
    type: string,
    frame: Element,
  ): { text: string; encoding: string } {
    const transport = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(
      headerOf(response.headers, 'content-type') ?? '',
    )?.[1];
    const named = transport ? encodingOf(transport) : null;
    if (!response.bytes) {
      return { text: response.body, encoding: named ?? 'UTF-8' };
    }
    const bytes = response.bytes;
    // JSON is UTF-8 whatever anything says (RFC 8259, 8.1)
    if (/[/+]json$/.test(type)) {
      return { text: decodeInEncoding(bytes, 'utf-8'), encoding: 'UTF-8' };
    }
    const holder = documentHolding(frame);
    const encoding = isXmlType(type)
      ? sniffXmlEncoding(bytes, named)
      : sniffEncoding(bytes, named, holder && this._encodingOf(holder));
    return { text: decodeInEncoding(bytes, encoding), encoding };
  }

  private _origin(): string {
    if (this.sandbox & SB_ORIGIN || this.creatorOrigin) return 'null';
    try {
      const origin = new URL(this.url).origin;
      // `about:blank` alone is of what made it: `data:` has no origin to share
      return this.creator && this.url.startsWith('about:')
        ? new URL(this.creator).origin
        : origin;
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
        originless: () => this.originless,
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
        address: () => this.url,
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

  /** The policy the last `<meta name="referrer">` that said one brought,
   *  and the elements already heard (HTML 4.2.5.3, the `referrer` name):
   *  one that goes leaves its policy behind. */
  private _metaReferrer: ReferrerPolicy = '';
  private _referrerMetas = new WeakSet<AnyNode>();
  private _noteReferrer(node: AnyNode): void {
    if (
      !(node instanceof Element) ||
      node.name !== 'meta' ||
      (node.attribs.name ?? '').trim().toLowerCase() !== 'referrer' ||
      this._referrerMetas.has(node)
    ) {
      return;
    }
    this._referrerMetas.add(node);
    const policy = referrerPolicyOfMeta(node.attribs.content ?? '');
    if (policy) this._metaReferrer = policy;
  }
  /** The document's referrer policy: what its response said, unless a
   *  `<meta>` in its head said otherwise since. */
  documentReferrerPolicy(): ReferrerPolicy {
    const head = DomUtils.findOne(
      (e) => e.name === 'head',
      this.document.children,
      true,
    );
    for (const child of head?.children ?? []) this._noteReferrer(child);
    return this._metaReferrer || this.referrerPolicy;
  }
  /** The policy a frame's next navigation is made under, where something
   *  sent it there (`navigateFrame`): the link's, '' for the document's. */
  private _frameNavigated = new WeakMap<Element, ReferrerPolicy>();
  /** What a frame's document request says in its `Referer`: under the
   *  `<iframe>`'s `referrerpolicy` for what its `src` loads, the link's for
   *  where a link sent it, and the document's otherwise. */
  private _frameReferrer(frame: Element, url: string): string | null {
    const sent = this._frameNavigated.get(frame);
    this._frameNavigated.delete(frame);
    const source = this._referrerSource(undefined);
    if (source === null) return null;
    const own =
      sent ??
      (frame.name === 'iframe'
        ? referrerPolicyOf(frame.attribs.referrerpolicy)
        : '');
    return determineReferrer(source, url, own || this.documentReferrerPolicy());
  }
  /** The URL a request's referrer is made from (Referrer Policy, 8.3,
   *  steps 2 and 3): its client's for `client`, a document with an opaque
   *  origin having none, and nothing for `no-referrer`. */
  private _referrerSource(source: string | undefined): string | null {
    if (source === 'no-referrer') return null;
    if (source !== undefined && source !== 'client') return source;
    if (!this.workerScope && this._origin() === 'null') return null;
    return this.url;
  }

  /** This host's token, which its storage changes carry. */
  private readonly _token = `h${++hostTokens}`;
  private _unwatchStorage: (() => void) | null = null;

  /** Where the page's storage is kept: the host's, or the process's
   *  memory. */
  private _storageOf(): HtmlStorage {
    return this._seams.storage ?? defaultStorage();
  }

  /** Whether this is a secure context (HTML 8.1.3.5): by the document at
   *  the top of its frames, and by its own where that came over a network
   *  that is not one. A frame of no address of its own is its parent's. A
   *  worker's is its owner's. */
  /** Whether this is a secure context, which a service worker's clients
   *  are. */
  get secure(): boolean {
    return this._secureContext();
  }

  /** What opens the keys this document makes, for a worker it starts. */
  keySecretsOf(): Uint8Array[] {
    return keySecrets(this._keySecret());
  }

  private _secureContext(): boolean {
    if (this._seams.secureContext !== undefined) {
      return this._seams.secureContext;
    }
    return (
      trustworthy(this.creator ?? this.top) &&
      (!/^(http|ws):/i.test(this.url) || trustworthy(this.url))
    );
  }

  /** The files a page has been told of, by the number it reads them by. */
  private _files: (HtmlFile | undefined)[] = [undefined];
  private _fileIds = new Map<HtmlFile, number>();
  private _fileId(file: HtmlFile): number {
    let id = this._fileIds.get(file);
    if (id === undefined) {
      id = this._files.length;
      this._files.push(file);
      this._fileIds.set(file, id);
    }
    return id;
  }
  /** What a file input holds, as a page's realm makes `File`s of. Nothing
   *  of a file's bytes crosses until the page reads them (`_fileChunk`). */
  private _fileList(el: Element): string {
    return JSON.stringify(chosenFiles(el).map((f) => this._toldFile(f)));
  }
  private _toldFile(file: HtmlFile) {
    return {
      id: this._fileId(file),
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      size: file.bytes.length,
    };
  }
  /** What a page's `dataTransfer` came to at the event just told. */
  private _dragOut: string | null = null;
  /** A piece of a file, from an offset: a string has a limit, and a file
   *  has none. */
  private _fileChunk(id: number, at: number): string {
    const file = this._files[id];
    return file ? base64Of(file.bytes.subarray(at, at + FILE_CHUNK)) : '';
  }
  /** What a page's `files` setter gave an input: files of the host's, by
   *  their numbers, or of the page's, with their bytes. */
  private _setFiles(el: Element, list: string): void {
    const given = JSON.parse(list) as {
      id?: number;
      name?: string;
      type?: string;
      lastModified?: number;
      b?: string;
    }[];
    const files: HtmlFile[] = [];
    for (const file of given) {
      const held = file.id ? this._files[file.id] : undefined;
      files.push(
        held ?? {
          name: file.name ?? '',
          type: file.type ?? '',
          lastModified: file.lastModified ?? 0,
          bytes: bytesOf(file.b ?? ''),
        },
      );
    }
    this._seams.handle.setFiles?.(el, files);
  }

  /**
   * A page's clipboard: whether the host handed one, a read and a write of
   * it, and a request for what guards the read. The answer comes as
   * `__clipboard`, under the number the page asked with: a write told as 0
   * is a `copy`'s, whose page has nothing waiting on it.
   */
  /** Whether the user said yes to a read just now, where a host answers that
   *  without its `state` saying so after. */
  private _clipboardGranted = false;
  private _clipboardOp(
    what: string,
    id: Primitive,
    payload: string,
  ): Primitive {
    const seam = this._seams.clipboard;
    if (what === 'on') return seam !== undefined;
    const tell = (ok: boolean, value?: string): void => {
      if (!this._disposed && id) {
        this.entries?.call('__clipboard', [id, ok, value ?? null]);
      }
    };
    if (what === 'request') {
      const asked = this.originless
        ? undefined
        : this._seams.permissions?.request(payload, this._origin());
      if (!asked) tell(true, 'denied');
      else {
        asked.then(
          (state) => {
            if (payload === 'clipboard-read') {
              this._clipboardGranted = state === 'granted';
            }
            this._permissionMoved(payload);
            tell(true, state);
          },
          () => tell(true, 'denied'),
        );
      }
      return null;
    }
    if (!seam) {
      tell(false, 'There is no clipboard.');
      return null;
    }
    // the realm's gate is a gesture's, and a page can talk it round: what the
    // clipboard holds is a user's, so whether it is read is decided here, and
    // whether it is written over, which without a grant takes a press or a
    // key the host saw
    const writes =
      what === 'read' ? null : this._permissionState('clipboard-write');
    const refused =
      writes === null
        ? !this._clipboardGranted &&
          this._permissionState('clipboard-read') !== 'granted'
        : writes === 'denied' ||
          (writes !== 'granted' && !this._transientlyActive());
    if (refused) {
      tell(
        false,
        what === 'read'
          ? 'Read permission denied.'
          : 'Write permission denied.',
      );
      return null;
    }
    const done =
      what === 'read'
        ? seam
            .read()
            .then((data) => JSON.stringify(clipboardWire(data, base64Of)))
        : seam
            .write(clipboardOfWire(JSON.parse(payload), bytesOf))
            .then(() => undefined);
    done.then(
      (value) => tell(true, value),
      () =>
        tell(
          false,
          what === 'read'
            ? 'Read permission denied.'
            : 'Write permission denied.',
        ),
    );
    return null;
  }

  /**
   * Where a permission really stands for this document: what asking would
   * come to, not what a host has said so far. A powerful feature is a secure
   * context's (Permissions 5.1), and what a frame's `allow` leaves out is
   * refused whatever the host says (Permissions Policy 8.8). A host with no
   * `permissions` has nobody to ask, so what it handed a seam for has that
   * seam's answer, and anything else has been refused.
   */
  private _permissionState(name: string): HtmlPermissionState {
    const seams = this._seams;
    const origin = this._origin();
    // what a user grants is by origin, and `null` is no one's: a grant to it
    // would be a grant to every sandbox
    if (this.originless) return 'denied';
    // a worker's is its page's, kept up to date from there
    if (this.workerScope) {
      return seams.permissions?.state(name, origin) ?? 'denied';
    }
    if (!this._secureContext()) return 'denied';
    if (POLICY_FEATURES.has(name) && !this._featureAllowed(name)) {
      return 'denied';
    }
    const media = name === 'camera' || name === 'microphone';
    const device = media && seams.mediaDevices;
    if (media && !device) return 'denied';
    const asked =
      (device ? device.permission?.(name, origin) : undefined) ??
      seams.permissions?.state(name, origin);
    if (asked) return asked;
    if (device) return 'prompt';
    if (name === 'notifications') {
      return seams.notifications ? 'granted' : 'denied';
    }
    // a user's press is all a write needs (`clipboard.ts`)
    if (name === 'clipboard-write' && seams.clipboard) return 'prompt';
    return 'denied';
  }

  /** Ask the user, where there is one to ask and it is still a question. */
  private _permissionAsk(id: number, name: string): void {
    const tell = (): void => {
      if (this._disposed) return;
      this._permissionMoved(name);
      this.entries?.call('__permissionAsked', [
        id,
        this._permissionState(name),
      ]);
    };
    const asked =
      this._permissionState(name) === 'prompt'
        ? this._seams.permissions?.request(name, this._origin())
        : undefined;
    void (asked ?? Promise.resolve()).then(tell, tell);
  }

  /** Where each permission stands, for a worker to keep a copy of: a page's
   *  answer is at once, and across a thread none is. */
  permissionStates(): Record<string, string> {
    return Object.fromEntries(
      PERMISSION_NAMES.map((name) => [name, this._permissionState(name)]),
    );
  }

  /** A permission moved: what listens to it hears, here and in workers. */
  private _permissionMoved(name: string): void {
    if (this._disposed) return;
    this.entries?.call('__permission', name);
    this.workers?.permissionMoved?.(name, this._permissionState(name));
  }

  private _unwatchPermissions: (() => void) | null = null;
  /** The page's notifications showing, by the number it goes by. */
  private _shown = new Map<number, HtmlShownNotification | null>();
  /**
   * What a page asks of a notification. Its text crosses as JSON, and the
   * origin is added here: it is the one thing of it that is not the page's
   * to say.
   */
  private _notificationOp(what: string, id: number, payload: string): void {
    const seam = this._seams.notifications;
    const tell = (told: string): void => {
      if (!this._disposed) this.entries?.call('__notification', [id, told]);
    };
    if (what === 'focus') {
      seam?.focus?.();
    } else if (what === 'close') {
      const shown = this._shown.get(id);
      this._shown.delete(id);
      closeShown(shown);
    } else if (!seam || this._permissionState('notifications') !== 'granted') {
      // the realm asks first, and a page can talk it round
      tell('error');
    } else {
      this._shown.set(id, null);
      const notification = {
        ...(JSON.parse(payload) as Omit<HtmlNotification, 'origin'>),
        origin: this._origin(),
      };
      void seam
        .show(notification, {
          click: () => {
            if (this._shown.has(id)) tell('click');
          },
          close: () => {
            if (this._shown.delete(id)) tell('close');
          },
        })
        .then(
          (shown) => {
            if (!this._shown.has(id)) {
              closeShown(shown);
              return;
            }
            this._shown.set(id, shown);
            tell('show');
          },
          () => {
            if (this._shown.delete(id)) tell('error');
          },
        );
    }
  }

  /** Whether a feature whose default allowlist is the document's own origin
   *  reaches this document (Permissions Policy 8.8): every document of the
   *  top's origin, and any other whose frame names it in `allow`. */
  private _featureAllowed(feature: string): boolean {
    const frame = this._frameOf.get(this.document);
    if (!frame) return true;
    if (!this.originless && originOf(this.top) === this._origin()) return true;
    return (frame.attribs.allow ?? '')
      .split(';')
      .some((entry) => entry.trim().split(/\s+/)[0] === feature);
  }

  /** Whether the document is still where a user can see it: not one whose
   *  frame has gone. */
  private _fullyActive(): boolean {
    const frame = this._frameOf.get(this.document);
    return !frame || shadowIncludingRoot(frame) instanceof Document;
  }

  private _crypto: PageCrypto | null = null;
  /** The host's half of `crypto.subtle`, made as it is first asked for: what
   *  it tells is held with everything else of a frozen document's. */
  private _subtle(): PageCrypto {
    return (this._crypto ??= new PageCrypto(
      this._keySecret(),
      (id, ok, value) => {
        if (!this._disposed) this.entries?.call('__crypto', [id, ok, value]);
      },
    ));
  }
  /** What this host's keys are sealed with: what the store a page's
   *  databases are kept in has, so they open in the next process. */
  private _keySecret(): Uint8Array | undefined {
    return this._storageOf().indexedDB?.keySecret?.();
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
    if (op === 'allowed') return !this.originless;
    const storage = this._storageOf();
    const origin = this._origin();
    // sharing `null` would be every sandbox's store in one (HTML 12.2.3)
    if (this.originless) {
      throw new DomError(
        'SecurityError',
        "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.",
      );
    }
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
    if (this.sandbox & SB_ORIGIN && op !== 'list' && op !== 'store') {
      throw new DomError(
        'SecurityError',
        "The document is sandboxed and lacks the 'allow-same-origin' flag.",
      );
    }
    const averse =
      !jar || !/^https?:/i.test(url) || originOf(url) !== this._origin();
    const { top } = this;
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

  /** Locks are by origin, and every sandbox's would be the one table of `null`
   *  (Web Locks 3.2): a sandbox could read another's names and hold it up. */
  private _holdsLocks(): void {
    if (this.originless) {
      throw new DomError(
        'SecurityError',
        "Access to the Locks API is denied in this context: the document's origin is opaque.",
      );
    }
  }

  /**
   * Whether a page may read a canvas back once an image or a video was drawn
   * on it (HTML's "CORS-same-origin"): by the response an image was drawn
   * from, whose type is believed where the store knows it — a service
   * worker's answer, or a CORS request's — and by where it came from in the
   * end where not. A video has its pixels in no case (`drawnPixels`), so one
   * that says it asked by CORS is taken at its word.
   */
  private _imageClean(el: Element): boolean {
    if (el.name !== 'video') {
      const response = this._imageDrawn(el)?.imageState?.(el)?.response;
      if (!response) return true;
      if (response.type) return response.type !== 'opaque';
      return this._ownImage(response.url);
    }
    if (el.attribs.crossorigin !== undefined) return true;
    return this._ownImage(this._resolve(el.attribs.src ?? ''));
  }

  /** Whether what came from `url` is this document's own to read: its
   *  origin's, or what no network answered. */
  private _ownImage(url: string): boolean {
    if (!url || /^(?:data|blob):/i.test(url)) return true;
    return originOf(url) === this._origin();
  }

  /**
   * Whether a worker may run from an address: of this document's origin,
   * which a blob this realm made is. An opaque origin is no address's, and
   * `null` is every such origin's serialization, so where this document's is
   * one a worker runs only from what it made itself — a blob of no origin,
   * whose text the realm hands over (`given`), or a `data:` URL — and, for a
   * `file:` page, from a `file:` address as before: never from one a sandbox
   * names, whose `null` a `file:` address's matched.
   */
  private _workerAllowed(url: string, given: boolean): boolean {
    const origin = this._origin();
    if (origin !== 'null') return originOf(url) === origin;
    // a blob it made is `blob:null`, whatever a page's own `String` wrote
    if (/^blob:/i.test(url)) return given && originOf(url) === 'null';
    if (/^data:/i.test(url)) return true;
    return !this.originless && /^file:/i.test(url) && /^file:/i.test(this.url);
  }

  /** A page's `fetch`: its own origin's, or another's where CORS lets it
   *  (`_fetchFor`), and its answer handed back through `__fetched`. */
  private _fetch(id: number, json: string): void {
    const answer = (value: FetchResponse | string, refused = false) => {
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
      this.entries?.call(
        '__fetched',
        refused ? [id, crossing, true] : [id, crossing],
      );
    };
    let request: PageRequest;
    try {
      request = this._pageRequest(json);
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
        error instanceof CorsError,
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

  /** A request as the facade sends it. */
  private _pageRequest(json: string): PageRequest {
    const raw = JSON.parse(json) as Partial<PageRequest>;
    const method = String(raw.method ?? 'GET').toUpperCase();
    // what a page may not set, which a browser drops (Fetch 2.2.2)
    const headers = Array.isArray(raw.headers)
      ? raw.headers
          .map(([k, v]) => [String(k), String(v)] as [string, string])
          .filter(([k]) => !forbiddenRequestHeader(k))
      : [];
    const agent = agentHeaders(raw.uaHeaders, method, headers);
    return {
      url: this._resolve(String(raw.url ?? '')),
      method,
      headers,
      body: typeof raw.body === 'string' ? raw.body : null,
      ...(raw.stream === true ? { stream: true } : {}),
      ...(agent ? { uaHeaders: agent } : {}),
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
      cache: raw.cache,
      redirect:
        raw.redirect === 'error' || raw.redirect === 'manual'
          ? raw.redirect
          : 'follow',
      integrity: raw.integrity,
      referrerPolicy: raw.referrerPolicy,
      ...(typeof raw.referrer === 'string'
        ? { referrerSource: raw.referrer }
        : {}),
      destination: raw.destination,
    };
  }

  /**
   * A synchronous `XMLHttpRequest`: what `_fetchFor` does, with the thread
   * asleep where that awaits. What comes back is JSON, the bytes as base64,
   * and what fails is the `NetworkError` the page's `send()` throws, or a
   * `TimeoutError`. It waits for no longer than `limit` ms, a worker's
   * `timeout`, nor than the task may wait: the runtime's watchdog counts this
   * and cannot be paused, and past it the whole task goes. So a request that
   * takes too long is one failed request, and the page goes on.
   */
  private _syncRequest(json: string, limit: number): string {
    const timeout = Math.min(
      limit > 0 ? limit : SYNC_REQUEST_MS,
      SYNC_REQUEST_MS,
      this.entries?.waitLeft ?? SYNC_REQUEST_MS,
    );
    try {
      const request = this._pageRequest(json);
      const {
        bytes,
        chunks: _chunks,
        ...rest
      } = this._fetchNow(request, timeout);
      return JSON.stringify({
        ...rest,
        body: bytes ? '' : rest.body,
        ...(bytes && { base64: base64Of(bytes) }),
      });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      // the page's exception says nothing of why, as a browser's does not
      this._seams.log('error', message);
      throw new DomError(
        (error as Error)?.name === 'TimeoutError'
          ? 'TimeoutError'
          : 'NetworkError',
        message,
      );
    }
  }

  /** `_fetchFor`, for `_syncRequest`: the same hops, with this thread asleep
   *  where that awaits. A service worker hears nothing of it: its registry is
   *  on this thread. */
  private _fetchNow(request: PageRequest, timeout: number): FetchResponse {
    this._checkRequest(request);
    const until = performance.now() + timeout;
    const send = (plain: FetchRequest): FetchResponse => {
      if (!connectAllowed(this._cspPolicies(), plain.url, this._origin())) {
        throw new TypeError(
          `${plain.url} is refused by the document's Content Security Policy.`,
        );
      }
      const left = until - performance.now();
      if (this._seams.fetchSync) return this._seams.fetchSync(plain, left);
      const network = this._seams.syncNetwork;
      if (!network) throw new TypeError('Failed to fetch');
      // a frame's request is the frame's, and its site for cookies the page's
      const client = { ...plain, client: this.url };
      return fetchSync(network, client, this.top ?? this.url, left);
    };
    const hops = this._hops(request);
    let step = hops.next();
    while (!step.done) step = hops.next(send(step.value));
    return step.value;
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
            mode: 'no-cors',
            destination: tagOf(el) === 'audio' ? 'audio' : 'video',
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
      // an HLS playlist, said by its type or its first line, is read whole
      // and as text (`readPlaylist`), and is no container
      let playlist: Uint8Array[] | null = HLS_TYPE.test(
        response.headers.find(
          ([k]) => k.toLowerCase() === 'content-type',
        )?.[1] ?? '',
      )
        ? []
        : null;
      let size = 0;
      try {
        for await (const chunk of chunks) {
          if (controller.signal.aborted) return;
          if (!playlist && !reader.received && isPlaylist(chunk)) playlist = [];
          if (playlist) {
            playlist.push(chunk);
            size += chunk.length;
            if (size > MEDIA_MOST) {
              release(response);
              tell('failed');
              return;
            }
            continue;
          }
          reader.add(chunk);
          tell('progress', String(reader.received));
          if (step(false)) return;
        }
      } catch {
        tell('failed');
        return;
      }
      if (playlist) {
        await this._mediaPlaylist(
          joinBytes(playlist),
          response.url || url,
          controller.signal,
          tell,
        );
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
   * What an HLS playlist a media element's source is comes to, told as a
   * container's head is (`_mediaFetch`): a media playlist's length, or a
   * multivariant one's first variant's size and, read from that variant's
   * own playlist, its length — the variant a player starts with (RFC 8216,
   * 6.3.1, the first listed). Nothing past the playlists is read: the
   * segments are the player's.
   */
  private async _mediaPlaylist(
    bytes: Uint8Array,
    url: string,
    signal: AbortSignalLike,
    tell: (kind: string, ...args: string[]) => void,
  ): Promise<void> {
    const read = readPlaylist(new TextDecoder().decode(bytes));
    if (!read) {
      tell('failed');
      return;
    }
    let { duration } = read;
    let width = 0;
    let height = 0;
    let received = bytes.length;
    const first = read.variants[0];
    if (first) {
      ({ width, height } = first);
      let variant: Playlist | null = null;
      try {
        const response = await this._seams.fetch(
          {
            url: new URL(first.uri, url).href,
            method: 'GET',
            headers: [],
            body: null,
            credentials: 'include',
          },
          signal,
        );
        if (signal.aborted) return;
        if (
          !response.status ||
          (response.status >= 200 && response.status <= 299)
        ) {
          const text = response.bytes
            ? new TextDecoder().decode(response.bytes)
            : (response.body ?? '');
          received += text.length;
          variant = readPlaylist(text);
        }
      } catch {
        variant = null;
      }
      if (!variant || variant.variants.length) {
        tell('failed');
        return;
      }
      duration = variant.duration;
    }
    tell('progress', String(received));
    tell('info', String(duration), String(width), String(height));
    tell('data');
    tell('enough');
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
    this._checkRequest(request);
    // a controlled client's request goes to its worker before CORS asks
    // anything of it (Fetch 4.3, "HTTP fetch")
    if (this.serviceClient?.controlled && /^https?:/i.test(request.url)) {
      const answered = await this.serviceClient.fetch(
        this._forWorker(request),
        signal,
      );
      if (answered) return this._fromWorker(answered, request);
    }
    const hops = this._hops(request);
    let step = hops.next();
    while (!step.done) {
      step = hops.next(await this._seams.fetch(step.value, signal));
    }
    return step.value;
  }

  /** What no page's request may be, whichever way it is waited for. */
  private _checkRequest(request: PageRequest): void {
    try {
      new URL(request.url);
    } catch {
      throw new TypeError('Failed to fetch');
    }
    if (forbiddenMethod(request.method)) {
      throw new TypeError('Failed to fetch');
    }
  }

  /**
   * A page's request a hop at a time, as one body for both ways of waiting
   * for it: this yields each request the network has to make and is resumed
   * with what it answered. So a synchronous request (`_fetchNow`) is held to
   * every rule an asynchronous one (`_fetchFor`) is, at every hop, and the
   * two differ only in how they wait.
   */
  private *_hops(
    request: PageRequest,
  ): Generator<FetchRequest, FetchResponse, FetchResponse> {
    const page = this._origin();
    const urls: string[] = [];
    let hop: Hop = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(request.bytes ? { bytes: request.bytes } : {}),
      ...(request.streamedBody ? { streamedBody: true } : {}),
    };
    let tainting: 'basic' | 'cors' | 'opaque' | null = null;
    // the request's referrer, which each hop works out again from what the
    // one before came to, and its policy, which a redirect may change
    // (Fetch 4.1, "main fetch", step 8; 4.4, "HTTP-redirect fetch")
    let referrer = this._referrerSource(request.referrerSource);
    let policy =
      referrerPolicyOf(request.referrerPolicy) || this.documentReferrerPolicy();
    for (;;) {
      const own = page !== 'null' && originOf(hop.url) === page;
      if (own && (tainting === null || tainting === 'basic')) {
        tainting = 'basic';
      } else if (request.mode === 'same-origin') {
        if (tainting) {
          throw new CorsError('The request was redirected to another origin.');
        }
        throw new TypeError(
          `Fetch API cannot load ${request.url}. Request mode is "same-origin" but the URL's origin is not same as the request origin ${page}.`,
        );
      } else if (request.mode === 'no-cors') {
        if (request.redirect !== 'follow') {
          throw new TypeError('Failed to fetch');
        }
        if (
          !tainting &&
          (!SIMPLE_METHODS.has(hop.method) ||
            !hop.headers.every(([k, v]) => noCorsSafelisted(k, v)))
        ) {
          throw new TypeError(
            `'${hop.method}' or a header is not allowed in 'no-cors' mode.`,
          );
        }
        tainting = 'opaque';
      } else tainting = 'cors';
      // asked of this hop, in whoever's name is left to it: a sandbox has
      // none from the start, wherever its address is
      const opaqueOrigin =
        page === 'null' || redirectTainted([...urls, hop.url], page);
      const origin = opaqueOrigin ? 'null' : page;
      const sent =
        referrer === null ? null : determineReferrer(referrer, hop.url, policy);
      referrer = sent;
      if (tainting === 'cors') {
        const unsafe = unsafeRequestHeaders(
          hop.headers.filter(([k]) => !request.uaHeaders?.includes(k)),
        );
        if (!SIMPLE_METHODS.has(hop.method) || unsafe.length) {
          yield* this._preflight(hop, request, unsafe, origin, sent);
        }
      }
      const response: FetchResponse = yield {
        url: hop.url,
        method: hop.method,
        headers: hop.headers,
        body: hop.body,
        ...(hop.bytes ? { bytes: hop.bytes } : {}),
        ...(request.stream ? { stream: true } : {}),
        ...(hop.streamedBody ? { streamedBody: true } : {}),
        // `same-origin`'s are a request's while it has not left its origin
        // (Fetch 4.5): one that came back from another carries none
        credentials:
          request.credentials === 'include' ||
          (request.credentials === 'same-origin' && tainting === 'basic')
            ? 'include'
            : 'omit',
        redirect: 'manual',
        ...(opaqueOrigin ? { opaqueOrigin: true } : {}),
        // what `Sec-Fetch-*` says, the site over every URL on its way
        mode: request.mode,
        ...(request.destination ? { destination: request.destination } : {}),
        ...(urls.length ? { through: [...urls] } : {}),
        ...(opaqueOrigin && page !== 'null' ? { origin: page } : {}),
        ...(request.cache && request.cache !== 'default'
          ? { cache: request.cache }
          : {}),
        referrer: sent,
      };
      if (response.redirected && request.redirect === 'error') {
        release(response);
        throw new TypeError('Failed to fetch');
      }
      const location = redirectOf(response.status, response.headers);
      // one that asks to see a redirect, or to be refused one, is so whether
      // or not it says where it goes (Fetch 4.4, "HTTP fetch", step 8)
      const redirect =
        location !== null ||
        (request.redirect !== 'follow' && isRedirectStatus(response.status));
      if (!redirect) {
        const answer = {
          ...response,
          url: response.url || hop.url,
          redirected: urls.length > 0 || response.redirected,
        };
        if (tainting === 'opaque') return this._opaque(answer);
        // a network that followed the redirect itself: where it landed says
        // whether the page's own origin answered
        if (tainting === 'basic' && originOf(answer.url) === page) {
          return {
            ...answer,
            headers: readable(answer.headers),
            type: 'basic',
          };
        }
        if (tainting === 'basic' && request.mode === 'same-origin') {
          release(response);
          throw new CorsError('The request was redirected to another origin.');
        }
        return this._shared(answer, request, origin);
      }
      // a redirect is a response, and another origin's has to let the page
      // know of it (Fetch 4.3, "HTTP fetch")
      if (tainting === 'cors') {
        try {
          corsCheck(response.headers, request.credentials, origin);
        } catch (error) {
          release(response);
          throw error;
        }
      }
      release(response);
      if (request.redirect === 'error') throw new TypeError('Failed to fetch');
      // a redirect may say what the rest of the way is made under (Fetch
      // 4.4, "HTTP-redirect fetch", step 15)
      policy = referrerPolicyOfHeaders(response.headers) || policy;
      if (request.redirect === 'manual') {
        return this._opaqueRedirect(
          hop.url,
          headerOf(response.headers, 'location'),
          response.status,
        );
      }
      const next = nextHop(
        hop,
        location!,
        response.status,
        urls.length,
        tainting === 'opaque'
          ? null
          : { origin: page, tainting: tainting === 'cors' },
      );
      urls.push(hop.url);
      hop = next;
    }
  }

  /**
   * A frame's document, which the worker whose scope holds its address hears
   * of before the network does, whatever controls this document. Its body is
   * read here, as the network's is for a frame.
   */
  private async _navigationFetch(
    request: FetchRequest,
    signal: AbortSignalLike,
    sandbox = 0,
    /** How many redirects a worker answered with brought it here. */
    hops = 0,
  ): Promise<FetchResponse> {
    const keeper = this._seams.serviceWorkers;
    // no origin of its own to be a client of any scope in
    if (!(sandbox & SB_ORIGIN) && keeper?.controls(request.url)) {
      const answered = await keeper.navigation(
        {
          ...request,
          mode: 'navigate',
          destination: request.destination ?? 'iframe',
          credentials: 'include',
          referrer: this.url,
          clientId: this.serviceClient?.id,
        },
        signal,
      );
      if (answered) {
        // a redirect it answered with, an opaque one its own `fetch` saw
        // among them, is one the navigation follows from where that redirect
        // was (Fetch 4.4, a navigation's manual redirect), and asks again
        const opaque = answered.type === 'opaqueredirect';
        const status = opaque
          ? (answered.redirectStatus ?? 0)
          : answered.status;
        const location = opaque
          ? (answered.location ?? null)
          : redirectOf(answered.status, answered.headers);
        if (location !== null && isRedirectStatus(status)) {
          release(answered);
          const next = nextHop(
            {
              url: answered.url || request.url,
              method: request.method,
              headers: request.headers,
              body: request.body,
              ...(request.bytes ? { bytes: request.bytes } : {}),
            },
            location,
            status,
            hops,
            null,
          );
          return this._navigationFetch(
            { ...request, ...next },
            signal,
            sandbox,
            hops + 1,
          );
        }
        const bytes = await wholeBytes(answered);
        return {
          ...answered,
          url: answered.redirected ? answered.url : request.url,
          chunks: undefined,
          bytes,
          body: new TextDecoder().decode(bytes),
        };
      }
    }
    // a sandbox that saves no file cuts a response that would be one off as
    // its head arrives (HTML 7.4.2.3, "allowed to download"): read whole, the
    // server has sent it all, which is what a download is
    const cuts = !!(sandbox & SB_DOWNLOADS);
    const stop = new AbortController();
    let fetched = await this._seams.fetch(
      cuts ? { ...request, stream: true } : request,
      cuts ? stop.signal : signal,
    );
    if (cuts) {
      const disposition = headerOf(fetched.headers, 'content-disposition');
      if (/^\s*attachment/i.test(disposition ?? '')) {
        stop.abort();
        throw new DownloadRefused(request.url);
      }
      if (fetched.chunks) {
        const bytes = await wholeBytes(fetched);
        fetched = {
          ...fetched,
          chunks: undefined,
          bytes,
          body: new TextDecoder().decode(bytes),
        };
      }
    }
    // the document is at the fragment it was asked for, which a response's
    // address drops
    const hash = request.url.indexOf('#');
    return hash >= 0 && fetched.url && !fetched.url.includes('#')
      ? { ...fetched, url: fetched.url + request.url.slice(hash) }
      : fetched;
  }

  /** A request as a worker's `fetch` event reads it. */
  private _forWorker(request: PageRequest): HtmlServiceWorkerRequest {
    return {
      ...request,
      referrer: this._referrerSource(request.referrerSource) ?? '',
      destination: request.destination ?? '',
    };
  }

  /**
   * What a worker answered with, held to what the request may take (Fetch
   * 4.3, "HTTP fetch", the checks on a service worker's response): an opaque
   * answer is no answer to a request that reads it, and a redirect's trail no
   * answer to one that does not follow.
   */
  private _fromWorker(
    response: FetchResponse,
    request: PageRequest,
  ): FetchResponse {
    const type = response.type ?? 'default';
    if (
      (type === 'opaque' && request.mode !== 'no-cors') ||
      // a redirect is a request's to see only where it asked to see one
      (type === 'opaqueredirect' && request.redirect !== 'manual') ||
      (type === 'cors' && request.mode === 'same-origin') ||
      (response.redirected && request.redirect && request.redirect !== 'follow')
    ) {
      release(response);
      throw new TypeError('Failed to fetch');
    }
    if (type === 'opaque') return this._opaque(response);
    if (type === 'opaqueredirect') {
      release(response);
      return this._opaqueRedirect(
        response.url || request.url,
        response.location ?? null,
        response.redirectStatus ?? 0,
      );
    }
    return {
      ...response,
      url: response.url || request.url.split('#')[0],
      type:
        type !== 'default'
          ? type
          : originOf(request.url) === this._origin()
            ? 'basic'
            : 'cors',
    };
  }

  /** The responses a page has been told of as opaque, by the number it hands
   *  back to keep one or to answer with it. The oldest goes past
   *  `OPAQUE_HELD`: a page that fetches and drops holds no more than that. */
  private _opaques = new Map<number, FetchResponse>();
  private _opaqueSeq = 0;

  /** What a page sees of a `no-cors` response another origin answered:
   *  nothing, and a number, in a realm that can do something with it. */
  private _opaque(response: FetchResponse): FetchResponse {
    const hidden: FetchResponse = {
      url: '',
      status: 0,
      statusText: '',
      redirected: false,
      headers: [],
      body: '',
      type: 'opaque',
    };
    if (!this._secureContext()) {
      release(response);
      return hidden;
    }
    return { ...hidden, held: this._hold(response) };
  }

  /** What a page is told of a redirect it asked to see (Fetch 2.2.6, "an
   *  opaque-redirect filtered response"): that there was one, at the address
   *  it asked for, and a number that holds where it goes, which a worker that
   *  answers a navigation with it has the navigation follow. */
  private _opaqueRedirect(
    url: string,
    location: string | null,
    status: number,
  ): FetchResponse {
    const told: FetchResponse = {
      url: url.split('#')[0],
      status: 0,
      statusText: '',
      redirected: false,
      headers: [],
      body: '',
      type: 'opaqueredirect',
    };
    if (!this._secureContext()) return told;
    return {
      ...told,
      held: this._hold({ ...told, location, redirectStatus: status }),
    };
  }

  /** A response kept here by a number a realm holds, the oldest let go past
   *  `OPAQUE_HELD`. */
  private _hold(response: FetchResponse): number {
    const held = ++this._opaqueSeq;
    this._opaques.set(held, response);
    for (const [key, oldest] of this._opaques) {
      if (this._opaques.size <= OPAQUE_HELD) break;
      this._opaques.delete(key);
      release(oldest);
    }
    return held;
  }

  /** The head of what a number holds, as the host made it: `_held` is a
   *  field a page can write, so nothing that came with it is believed. */
  private _heldHead(held: number): typeof OPAQUE_HEAD & {
    location?: string | null;
    redirectStatus?: number;
  } {
    const kept = this._opaques.get(held);
    if (kept?.type !== 'opaqueredirect') return OPAQUE_HEAD;
    return {
      ...OPAQUE_HEAD,
      type: 'opaqueredirect',
      url: kept.url,
      location: kept.location ?? null,
      redirectStatus: kept.redirectStatus ?? 0,
    };
  }

  /** An opaque response's bytes, read the first time they are asked for and
   *  kept for a clone's: null where it has gone. */
  private async _opaqueBytes(held: number): Promise<Uint8Array | null> {
    const response = this._opaques.get(held);
    if (!response) return null;
    if (response.chunks) {
      const pieces: Uint8Array[] = [];
      for await (const piece of response.chunks) pieces.push(piece);
      response.chunks = undefined;
      response.bytes = joinBytes(pieces);
    }
    return (
      response.bytes ?? new Uint8Array(Buffer.from(response.body, 'latin1'))
    );
  }

  /** What a service worker's realm said to its registry: a body held here
   *  goes as bytes, which no script has read. */
  private _serviceSaid(said: string): void {
    const scope = this.workerScope;
    if (!scope?.service) return;
    const m = JSON.parse(said) as {
      op: string;
      held?: number;
      f?: number;
      head?: { location?: unknown; redirectStatus?: unknown };
    };
    if (m.op !== 'respond' || m.held === undefined) {
      // where a redirect goes is the host's to say, never a realm's
      if (m.head && ('location' in m.head || 'redirectStatus' in m.head)) {
        delete m.head.location;
        delete m.head.redirectStatus;
        scope.service(JSON.stringify(m));
      } else scope.service(said);
      return;
    }
    const { held, ...rest } = m;
    const head = this._heldHead(held);
    void this._opaqueBytes(held).then((bytes) =>
      scope.service!(
        JSON.stringify({ ...rest, head }),
        bytes ?? new Uint8Array(0),
      ),
    );
  }

  /** The store a page's `caches` are kept in. */
  private _cacheStore(): HtmlCacheStore {
    return (
      this._storageOf().caches ?? (defaultStorage().caches as HtmlCacheStore)
    );
  }

  /** What a worker's `caches` ask, in this page's store. */
  askCaches(origin: string, ask: HtmlCacheAsk): HtmlCacheAnswer {
    return askCaches(this._cacheStore(), origin, ask);
  }

  /** A page's `caches`: bytes made of what crossed, the store asked, and what
   *  it answers told back through `__cache`. An opaque response's body stays
   *  here, as it did on the way in. */
  private _cacheOp(n: number, json: string): void {
    const run = async (): Promise<unknown> => {
      const origin = this._origin();
      if (origin === 'null') return { error: 'SecurityError' };
      const ask = JSON.parse(json) as HtmlCacheAsk;
      if (ask.op === 'batch') {
        for (const step of ask.operations as unknown as {
          bytes: Uint8Array;
          base64?: string;
          held?: number;
          response?: unknown;
        }[]) {
          if ('held' in step && step.held !== undefined) {
            // what the number holds stays opaque whatever came with it:
            // `_held` is a field a page can write, and a body it put under
            // its own URL and a type of its own it could read back
            step.response = this._heldHead(step.held);
            step.bytes =
              (await this._opaqueBytes(step.held)) ?? new Uint8Array(0);
            delete step.held;
          } else if (typeof step.base64 === 'string') {
            step.bytes = new Uint8Array(Buffer.from(step.base64, 'base64'));
            delete step.base64;
          }
        }
      }
      const answer = this._seams.caches
        ? await this._seams.caches(origin, ask)
        : this.askCaches(origin, ask);
      if (!answer.responses) return answer;
      return {
        ...answer,
        responses: answer.responses.map(({ bytes, ...head }) => {
          if (head.type !== 'opaque' && head.type !== 'opaqueredirect') {
            return { ...head, base64: base64Of(bytes) };
          }
          // and where a redirect goes stays here
          const { location, redirectStatus, ...told } = head as typeof head & {
            location?: string | null;
            redirectStatus?: number;
          };
          const redirect = head.type === 'opaqueredirect';
          const held = this._hold({
            url: redirect ? head.url : '',
            status: 0,
            statusText: '',
            redirected: false,
            headers: [],
            body: '',
            bytes,
            ...(redirect
              ? {
                  type: 'opaqueredirect' as const,
                  location: location ?? null,
                  redirectStatus: redirectStatus ?? 0,
                }
              : {}),
          });
          return { ...told, held };
        }),
      };
    };
    const told = (answer: unknown): void => {
      if (!this._disposed) {
        this.entries?.call('__cache', [n, JSON.stringify(answer)]);
      }
    };
    run().then(told, (error: unknown) =>
      told({ error: 'UnknownError', message: String(error) }),
    );
  }

  /** Another origin's answer, where it lets the page read it (Fetch 4.10,
   *  "CORS check"): with only the headers it lets the page read. */
  private _shared(
    response: FetchResponse,
    request: PageRequest,
    origin: string,
  ): FetchResponse {
    try {
      corsCheck(response.headers, request.credentials, origin);
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
  private *_preflight(
    hop: Hop,
    request: PageRequest,
    unsafe: string[],
    origin: string,
    referrer: string | null,
  ): Generator<FetchRequest, void, FetchResponse> {
    const include = request.credentials === 'include';
    const key = `${origin}\u0000${hop.url}\u0000${include}`;
    const kept = this._preflights.get(key);
    const allows = (entry: PreflightEntry): string | null => {
      if (
        !SIMPLE_METHODS.has(hop.method) &&
        !entry.methods.has(hop.method) &&
        !(entry.anyMethod && !include)
      ) {
        return `Method ${hop.method} is not allowed by Access-Control-Allow-Methods in preflight response.`;
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
      ['access-control-request-method', hop.method],
    ];
    if (unsafe.length) {
      headers.push(['access-control-request-headers', unsafe.join(',')]);
    }
    // a preflight carries no cookies (Fetch 4.9)
    const response: FetchResponse = yield {
      url: hop.url,
      method: 'OPTIONS',
      headers,
      body: null,
      credentials: 'omit',
      redirect: 'manual',
      ...(origin === 'null' ? { opaqueOrigin: true } : {}),
      // a request of its own, which says what it is for (Fetch 4.9), and
      // from where, as the request it asks for does
      mode: 'cors',
      ...(request.destination ? { destination: request.destination } : {}),
      referrer,
    };
    const failed = (why: string) =>
      new CorsError(
        `Response to preflight request doesn't pass access control check: ${why}`,
      );
    if (response.redirected)
      throw failed('Redirect is not allowed for a preflight request.');
    try {
      corsCheck(response.headers, request.credentials, origin);
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
