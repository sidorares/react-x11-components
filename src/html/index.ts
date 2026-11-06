// `<Html>` — a static HTML + CSS renderer with selectable text, a resource
// seam, a script seam, and real widgets for form controls.
//
// The engine is `node.ts` and the files under `css/` and `layout/`; this file
// is the React half: props, the theme, the seams, and the controls mounted
// beside the element. See `docs/prd-html.md` for why the element draws the
// document rather than composing it out of `<box>`es, and `docs/components/
// html.md` for the reference.
//
// **What it is not.** It does not fetch anything, and it never will:
// `onResource` is how an application supplies what a document asks for, and
// a document rendered without it cannot reach the network or the disk. It
// executes nothing either, unless the application says so: `scripts` runs
// a document's scripts in the engine under `scripts/`, loaded only then,
// and what they fetch still goes through the application's seams. Off, which
// is the default, that is the whole security posture, and it is a property
// of the design rather than a setting.
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  useDesktopSettings,
  useSystemAppearance,
  useTheme,
  useWindowState,
} from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent as X11KeyboardEvent,
  MouseEvent as X11MouseEvent,
  Rect,
  WheelEvent as X11WheelEvent,
} from 'react-x11';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RIGHT,
  XK_SPACE,
  XK_UP,
} from 'react-x11/keysyms';
import { tint } from 'react-x11/style';
import type { Style } from 'react-x11/style';

import type {} from 'react-x11/jsx-runtime';

import { useLinkClicks, useSelectionMenu } from '../richtext/index.js';
import { useFontPrewarm } from '../internal/prewarm.js';
import { hx } from './hx.js';
import {
  attr,
  flatParentOf,
  isElement,
  isModal,
  isXmlType,
  tagOf,
} from './dom.js';
import { focusableElement } from './focus.js';
import { documentReferrerPolicy, referrerPolicyOf } from './referrer.js';
import type { Document, Element, HtmlChange } from './dom.js';
import type { AnyNode } from 'domhandler';
import { ELEMENT, HtmlViewNode, registerHtmlView } from './node.js';
import type {
  DocumentInteraction,
  HtmlViewProps,
  IndicatedPart,
  OffsetRect,
  ScriptRequest,
} from './node.js';
import {
  clipboardChord,
  documentPoint,
  domButton,
  domButtons,
  domLocks,
  domKey,
  isModifierKey,
  fireDomEvent,
  modifiersOf,
  modifiersOfKey,
  NO_MODIFIERS,
} from './dom-events.js';
import type {
  DomEventHandler,
  DomEventInit,
  HtmlDomEventType,
} from './dom-events.js';
import { inputType, isDisabled } from './form.js';
import type { RootLook } from './css/style.js';
import type {
  MatchedRule as HtmlMatchedRule,
  ViewportOverflow,
} from './css/cascade.js';
import type { SheetSource as HtmlSheetSource } from './css/parse.js';
import type { ControlRect } from './controls.js';
import type { ElementScroll } from './layout/scroll.js';
import type { FieldSelection, FormSubmission } from './form.js';
import type { HtmlFile, HtmlPickFiles } from './files.js';
import { useForms } from './widgets.js';
import { useVideos } from './videos.js';
import { useSounds } from './sounds.js';
import type { MediaState } from './media.js';
import { useEmbedded } from './embedded.js';
import type { Embedded, RenderEmbedded } from './embedded.js';
import type { HtmlClipboardData } from './clipboard.js';
import { useDocumentDrag } from './drag.js';
import type { HtmlDownloadHandler, HtmlDownloadRequest } from './download.js';
import type { HtmlDrop } from './drag.js';
import { syntheticClick, useFocusStops, useFocusableMarkup } from './stops.js';
import { readyFor } from './encoding.js';
import { useScriptedHtml } from './scripts/scripted.js';
import {
  SB_DOWNLOADS,
  SB_ORIGIN,
  SB_POPUPS,
  SB_PROPAGATES,
  sandboxOfPolicy,
} from './scripts/sandbox.js';
import { linkTarget, navigableFor } from './scripts/target.js';
import { fontAllowed } from './scripts/script-origin.js';
import type {
  ConsoleProperty,
  ConsoleResult,
  HtmlScripts,
  InternalHtmlProps,
} from './scripts/scripted.js';
import type { HandleInternals } from './scripts/host.js';
import type { MarginLength } from './paint.js';
import { useParsedOnceLaidOut } from './parsed.js';
import type { ResourceRequest, ResourceResult } from './resources.js';

export {
  ELEMENT as HTMLVIEW_ELEMENT,
  HtmlViewNode,
  registerHtmlView,
} from './node.js';
export type {
  HtmlViewProps,
  IndicatedPart,
  OffsetRect,
  ScriptRequest,
} from './node.js';
export type { ElementScroll } from './layout/scroll.js';
export type {
  DomEventHandler,
  HtmlDomEvent,
  HtmlDomEventType,
} from './dom-events.js';
export type {
  AudioSource,
  ImageOrigin,
  ResourceRequest,
  ResourceResult,
  VideoSource,
} from './resources.js';
export type { BareField, ControlRect } from './controls.js';
export type {
  EmbeddedKind,
  EmbeddedRect,
  MediaRect,
  MediaState,
} from './media.js';
export type { RenderEmbedded } from './embedded.js';
export type {
  FieldSelection,
  FormEnctype,
  FormMethod,
  FormSubmission,
  SubmitContext,
} from './form.js';
export { formSubmission } from './form.js';
export { downloadSource } from './network.js';
export {
  acceptFilters,
  fileTypeOf,
  readHtmlFiles,
  useHtmlFilePicker,
} from './files.js';
export type { HtmlFile, HtmlFileRequest, HtmlPickFiles } from './files.js';
export type {
  ConsoleProperty,
  ConsoleResult,
  ConsoleValue,
  HtmlScripts,
  ScriptViewport,
} from './scripts/scripted.js';
export type { FetchRequest, FetchResponse } from './scripts/host.js';
export type { AbortSignalLike } from './scripts/platform.js';
export { preloadHtmlScripts } from './scripts/hook.js';
export { HtmlSessionHistory } from './scripts/session.js';
export type {
  HtmlNavigationType,
  HtmlSessionEntry,
  HtmlSessionOptions,
  HtmlSessionRestore,
} from './scripts/session.js';
export { NO_WEBTRANSPORT } from './transport.js';
export type {
  HtmlWebTransport,
  WebTransportConnectRequest,
  WebTransportPriority,
  WebTransportReady,
  WebTransportSessionEvents,
  WebTransportSessionLike,
  WebTransportStats,
  WebTransportStreamEvents,
  WebTransportStreamLike,
  WebTransportStreamStats,
} from './transport.js';
export { NO_WEBSOCKET } from './socket.js';
export { memoryClipboard, useHtmlClipboard } from './clipboard.js';
export type { HtmlClipboard, HtmlClipboardData } from './clipboard.js';
export type { HtmlDragData, HtmlDrop } from './drag.js';
export { dispositionOf, downloadName, safeFilename } from './download.js';
export type {
  HtmlDownloadHandler,
  HtmlDownloadRequest,
  HtmlDownloadSource,
} from './download.js';
export type { HtmlPermissions, HtmlPermissionState } from './permissions.js';
export { memoryNotifications, useHtmlNotifications } from './notifications.js';
export { parseWindowFeatures } from './popups.js';
export type {
  HtmlNavigationSource,
  HtmlPopup,
  HtmlPopupFeatures,
  HtmlPopups,
  WindowFeatures,
} from './popups.js';
export type {
  HtmlNotification,
  HtmlNotificationEvents,
  HtmlNotifications,
  HtmlShownNotification,
} from './notifications.js';
export type {
  HtmlWebSocket,
  WebSocketConnectRequest,
  WebSocketConnectionLike,
  WebSocketEvents,
  WebSocketOpened,
} from './socket.js';
export { NO_WEBRTC, rtcError } from './rtc.js';
export type {
  HtmlWebRTC,
  RTCCandidateLike,
  RTCCapabilitiesLike,
  RTCCertificateLike,
  RTCCodecLike,
  RTCCodecParametersLike,
  RTCConnectRequest,
  RTCConnectionEvents,
  RTCConnectionLike,
  RTCDataChannelEvents,
  RTCDataChannelInitLike,
  RTCDataChannelLike,
  RTCDescriptionsLike,
  RTCDirectionLike,
  RTCEncodingLike,
  RTCErrorDetailLike,
  RTCErrorName,
  RTCHeaderExtensionChoice,
  RTCHeaderExtensionLike,
  RTCIceServerLike,
  RTCKeygenLike,
  RTCPriorityLike,
  RTCRtpParametersLike,
  RTCRtpSourceLike,
  RTCSessionState,
  RTCStatsLike,
  RTCTransceiverInit,
  RTCTransceiverLike,
  RTCTransceiverState,
  RTCTransportStateLike,
} from './rtc.js';
export { NO_MEDIA_DEVICES, idleSource, mediaError } from './media-devices.js';
export type {
  HtmlMediaDevices,
  MediaAudioData,
  MediaDeviceCapabilities,
  MediaDeviceDescription,
  MediaDeviceKind,
  MediaErrorName,
  MediaPermission,
  MediaPermissionRequest,
  MediaRange,
  MediaSettings,
  MediaSourceEvents,
  MediaSourceLike,
  MediaVideoFrame,
} from './media-devices.js';
export { fakeMediaDevices } from './fake-media.js';
export { gpuWebGL } from './webgl.js';
export type {
  HtmlGLCommand,
  HtmlGLContext,
  HtmlGLOptions,
  HtmlWebGL,
} from './webgl.js';
export type { FakeMediaDevices, FakeMediaOptions } from './fake-media.js';
export { linkTarget, navigableFor } from './scripts/target.js';
export type { Navigable } from './scripts/target.js';
export {
  HTML_USER_AGENT,
  HtmlNetwork,
  NetworkError,
  canPlayMedia,
  decodeText,
  defaultHtmlNetwork,
  escapeHtml,
  mixedContent,
  readDataUrl,
  resourceResult,
  schemeOf,
  sniffCharset,
  useHtmlNetwork,
  videoSource,
} from './network.js';
export {
  encodingOf,
  htmlTextDecoder,
  readyFor,
  sniffEncoding,
  sniffXmlEncoding,
} from './encoding.js';
export type { HtmlTextDecoder } from './encoding.js';
export { threadTransport } from './thread-transport.js';
export type { ThreadTransportOptions } from './thread-transport.js';
export type {
  DocumentResponse,
  HtmlDocumentHop,
  Fetched,
  HtmlNetworkActivity,
  HtmlNetworkOptions,
  HtmlNetworkSeams,
  HtmlRequestKind,
  HtmlTransport,
  Loaded,
  PostData,
  ResourceKind,
} from './network.js';
export {
  CookieJar,
  defaultPath,
  domainMatch,
  parseCookieDate,
  parseSetCookie,
  pathMatch,
  publicSuffixList,
} from './cookies.js';
export type {
  CookieContext,
  CookieInit,
  CookieJarOptions,
  CookieListItem,
  CookieSameSite,
  HtmlCookie,
  HtmlCookieStore,
  HtmlDocumentCookies,
  ParsedCookie,
  PublicSuffix,
} from './cookies.js';
export {
  MemoryStorageArea,
  STORAGE_QUOTA,
  defaultStorage,
  memoryStorage,
} from './storage.js';
export type {
  HtmlIdbCommit,
  HtmlIdbSnapshot,
  HtmlIdbStoreSchema,
  HtmlIndexedDB,
  HtmlStorage,
  HtmlStorageArea,
  HtmlStorageChange,
} from './storage.js';
export {
  CACHE_FILE,
  HtmlProfile,
  PROFILE_FILE,
  PROFILE_VERSION,
  WORKERS_FILE,
} from './profile.js';
export type { HtmlProfileHttpCache, HtmlProfileOptions } from './profile.js';
export type {
  HtmlCachedHead,
  HtmlCachedResponse,
  HtmlHttpCacheStore,
} from './http-cache.js';
export { HtmlServiceWorkers, memoryServiceWorkers } from './service-workers.js';
export type {
  HtmlServiceWorkerRecord,
  HtmlServiceWorkerRequest,
  HtmlServiceWorkerScript,
  HtmlServiceWorkerStore,
  HtmlServiceWorkerUpdateViaCache,
  HtmlServiceWorkerVersion,
  HtmlServiceWorkersOptions,
} from './service-workers.js';
export { memoryCaches } from './cache-storage.js';
export type {
  HtmlCacheAddition,
  HtmlCacheEntry,
  HtmlCacheRequest,
  HtmlCacheResponse,
  HtmlCacheStore,
} from './cache-storage.js';
export type { ComputedStyle, RootLook } from './css/style.js';
export type {
  MatchedRule as HtmlMatchedRule,
  RuleSource as HtmlRuleSource,
} from './css/cascade.js';
export type { SheetSource as HtmlSheetSource } from './css/parse.js';
export type { ViewportOverflow } from './css/cascade.js';
export type {
  AnyNode,
  ChildNode,
  Document,
  Element,
  HtmlChange,
  ParentNode,
  ShadowRoot,
  ShadowRootMode,
} from './dom.js';
export {
  isXmlType,
  appendChild,
  attachShadow,
  createElement as createHtmlElement,
  createText,
  parseFragment,
  removeNode,
  replaceNode,
  shadowRootOf,
} from './dom.js';

const h = React.createElement;

// The one side effect, at this component's own module scope — the rule the
// whole tree-shaking contract rests on (AGENTS.md).
registerHtmlView();

// --- props -----------------------------------------------------------------

/** What the document may do to the outside world. Nothing, by default. */
export interface HtmlProps {
  /** The HTML. Append to it as chunks stream in. */
  source: string;
  /**
   * A document to draw in place of parsing `source`, which is then not
   * read: one a host holds and changes, as a browser holds a frame's
   * document a page writes into. Its changes are told through the handle's
   * `refresh`, as a script's are. A browser draws an `<iframe>` with it
   * (`renderEmbedded`).
   */
  document?: Document;
  /**
   * What `source` was served as, a MIME type (default `text/html`). An XML
   * type — `application/xhtml+xml`, `image/svg+xml`, `text/xml`, anything
   * `+xml` — reads it by XML's rules and not HTML's: no element is implied,
   * moved or dropped, names keep their case, and a document that is not
   * well-formed is an error and nothing of it. An XML document is read once
   * all of it is here, so for one `partial` defaults to false.
   */
  contentType?: string;
  /**
   * Whether more source may still arrive (default true, matching
   * `<Markdown partial>`). While true the parser is left open and a `source`
   * that extends the last one is written as a delta, so the nodes already
   * parsed keep their identity and their layout. Set false when the stream
   * ends.
   *
   * False ends the parse, and that is final: a later `source` re-parses even
   * when it extends the last one. An editor handing over the whole document
   * on every keystroke wants the default.
   */
  partial?: boolean;
  /** Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true. */
  selectable?: boolean;
  /**
   * Whether the document's CSS animations and animated images run. Default
   * true. False draws each animation as it stands once it has run one
   * iteration at no length — the frame it ends on where it fills forwards
   * — and each animated GIF or WebP at its first frame, which is what a capture
   * that has to come out the same every time wants. It does not answer
   * `(prefers-reduced-motion: reduce)`: the page held at rest is the one
   * that animates, under `no-preference`, and `reducedMotion` says which
   * page that is.
   */
  animate?: boolean;
  /**
   * Whether the desktop has asked for less motion, which
   * `@media (prefers-reduced-motion)` is answered from: true takes the
   * page's `reduce` branch, false its `no-preference` one. Default: the
   * desktop's own setting, `useSystemAppearance().reducedMotion` — macOS's
   * Reduce motion, GNOME's animations switch — followed as it changes, as
   * a browser follows it. Set it where the application decides instead: a
   * preference of its own, or a capture that has to come out the same on
   * every machine.
   */
  reducedMotion?: boolean;
  /**
   * The colour scheme a document that does not say which it is drawn in —
   * `color-scheme: normal`, the initial value — is drawn in: the user
   * agent's default (CSS Color Adjust 1, 2.1). Default: the palette's, since
   * the palette is this renderer's look, so a document dropped into a dark
   * application is drawn dark. A host that shows the web as a browser does
   * sets `'light'`: every browser draws a page that says nothing about its
   * scheme light, on white, whatever the reader prefers — and its form
   * controls light, in a browser's colours rather than a dark palette's
   * widgets. The palette still
   * answers `@media (prefers-color-scheme)` and the scheme `light dark`
   * takes, which are the reader's preference.
   */
  defaultColorScheme?: 'light' | 'dark';
  /** Extra author stylesheets, applied after the document's own. */
  stylesheet?: string | string[];
  /**
   * The encoding the host decoded `source` from, as a label (`'shift_jis'`,
   * `'windows-1251'`). A stylesheet `onResource` hands over as bytes, with no
   * byte order mark, charset or `@charset` of its own, is decoded with it, as
   * CSS says a sheet is in its document's encoding. It is what a page reads
   * in `document.characterSet`, what a form with no `accept-charset` is sent
   * in, and what a URL's query is written in where a page's script resolves
   * one. Default UTF-8.
   */
  charset?: string;
  /**
   * The URL the document came from. Given one — or a document with an
   * absolute `<base href>` — every URL the document names reaches
   * `onResource` and `onLink` absolute: resolved against its `<base href>`
   * or this, and a `url()` in a linked stylesheet against the stylesheet's
   * own URL, as a browser resolves it. Absent, URLs are handed over as the
   * document wrote them.
   *
   * Nothing is fetched because of it: it says where relative URLs point,
   * and `onResource` still decides whether anything goes there.
   *
   * Its fragment names the document's `:target`: the element whose id it
   * is, or the `<a>` it is the name of. A host that follows a link to
   * `#section` passes the same URL with that fragment, which resolves
   * nothing differently and restyles only where a rule tests `:target`;
   * a document with no URL can be given a fragment alone, `'#section'`.
   */
  baseUrl?: string | null;
  /**
   * An external resource is wanted — an `<img src>`, a `<link rel=stylesheet>`
   * or an `@import`, or a font an `@font-face` declares and the document
   * uses. Return the bytes or the text, or a promise of them, or `null` to
   * decline. A stylesheet's bytes are decoded as CSS says, from the
   * `charset` the protocol named, if the host passes it on, and its `url`,
   * if the host passes that, is where it came from after redirects.
   *
   * A `<video>`'s source is asked for as `kind: 'video'` — its `src`, or
   * each `<source>` whose `media` holds — with the `type` its `<source>`
   * gives: answer `{ kind: 'video', src }` for core's
   * `<video>` to play with the platform's player — where
   * `useSupports('mediaPlayback')` says there is one — or `{ kind: 'video',
   * frames }` with a `VideoFrames` sink the host decodes it into. Declined,
   * the next `<source>` is asked for, and with none left the video is its
   * poster.
   *
   * **Absent, nothing loads.** This component has no network and no
   * filesystem of its own; images render as a frame, linked stylesheets are
   * skipped, videos show their posters and text is set in the fonts the
   * system has. The host is the one that knows its cache, its proxy and
   * whether this document is trusted.
   */
  onResource?: (
    request: ResourceRequest,
  ) => Promise<ResourceResult | null> | ResourceResult | null;
  /**
   * A `<script>` was found. Handed over **unparsed and unevaluated** — the
   * type, the `src`, the text, the element — for an application that brings
   * its own engine. Nothing here reads it. Called while the element is
   * reading its props, so a host queues the script and runs it later —
   * after `onParsed`, once the handle's `scriptsUnblocked` says the sheets
   * before it are in — rather than in the callback.
   */
  onScript?: (script: ScriptRequest) => void;
  /**
   * Run the document's scripts, in an engine of this package's — a
   * `node:vm` context a document, with a DOM over the one drawn here,
   * frames, workers, a canvas and `fetch` — loaded the first time a
   * document turns it on. `true` takes a default for every seam; an object
   * overrides any of them (`HtmlScripts`). **Default off**, and nothing runs.
   *
   * What the scripts load still goes through the application: a `<script
   * src>` and the modules it imports through `onResource`, as `kind:
   * 'script'`; a page's own requests through `scripts.fetch`, and nowhere
   * without one. `useHtmlNetwork(url)` supplies both.
   *
   * It runs where a page's `import()` stays in its context: Bun, and Node
   * 20, or 24 and later, started with `--experimental-vm-modules`.
   * Elsewhere the document is drawn as with JavaScript off, and a warning
   * says why (`preloadHtmlScripts`). **Not a sandbox against a hostile
   * page** — see "Scripts" in the docs. Turning it on or off makes a new
   * document, as a browser reloads a page for its switch.
   */
  scripts?: boolean | HtmlScripts;
  /**
   * The headers of the response the document came in, for what it says of
   * itself whether or not its scripts run: a `Content-Security-Policy`'s
   * `sandbox`, which takes from it what its tokens do not give back — a form
   * sent (`allow-forms`), a link that opens a window (`allow-popups`), a
   * download (`allow-downloads`), `autofocus` (`allow-scripts`) — and makes
   * what it loads a document of no origin's (`allow-same-origin`). Where its
   * scripts run, `scripts.headers` says the same, and is read first.
   */
  headers?: [string, string][];
  /**
   * Whether the host runs the document's scripts: an application that
   * brings an engine says so, and the document is drawn as a browser draws
   * one that runs JavaScript — a `<noscript>` is drawn as nothing, nothing
   * in it is asked for through `onResource` or handed to `onScript`, and
   * `@media (scripting: enabled)` holds. **This component runs nothing
   * either way.** Default false: a `<noscript>` is drawn, as it is with
   * JavaScript off.
   */
  scripting?: boolean;
  /**
   * Something happened to the document, before this component does what it
   * does about it: a `click` before a link is followed, a button pressed or
   * a box ticked; a `keydown` before a field types it; a `submit` before
   * the entries are built and `onSubmit` is called; `input`, `change`,
   * `focusin`, `focusout`, `toggle` as they happen. Synchronous, and
   * returning `false` from it cancels an event that can be — the page's
   * `preventDefault()`. "Events before their defaults" in the docs has
   * the order.
   */
  onDomEvent?: DomEventHandler;
  /** The parse has ended: every element is in the tree. Once a document,
   *  a microtask after the source that ended it, or after core first lays
   *  the element out where that is later — when a host runs the scripts it
   *  was handed, each once the sheets before it are in
   *  (`scriptsUnblocked`), and then tells `DOMContentLoaded`. Held for the
   *  layout because a script measures the document, and a browser lays a
   *  page out at its viewport's width before one does. */
  onParsed?: () => void;
  /** Everything the document asked for has arrived or failed — counted
   *  from its first complete layout, since a background, a font or a
   *  chosen image source is asked for only as one finds it — but for a
   *  lazy image, which holds no `load`. Once a document: `load`'s moment. */
  onLoaded?: () => void;
  /**
   * A link was activated. Absent means clicks do nothing: this component
   * never navigates by itself. The `href` is resolved against the
   * document's base where it has one (`baseUrl`), and as written where not.
   */
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
  /** The parsed document, each time it is re-parsed — the DOM handle. */
  onDocument?: (document: Document) => void;
  /**
   * A form control changed, or a `<button>` was pressed — reported with its
   * `value`. The element is the one in the DOM, so a handler that wants to
   * keep the value writes it back with `setAttribute`-shaped mutation and
   * calls the handle's `refresh()`.
   */
  onControlChange?: (element: Element, value: string | boolean) => void;
  /**
   * A form was submitted — a submit button pressed, or Enter in one of its
   * text fields. Handed over as the request it makes: the method, the URL
   * (resolved as `onLink`'s `href` is, and for a GET with the form's entries
   * as its query), a POST's encoded body and its content type, and the
   * entries themselves. Absent means submitting does nothing: this
   * component never sends anything by itself, any more than it navigates.
   */
  onSubmit?: (submission: FormSubmission) => void;
  /**
   * Ask the user for files: a press on an `<input type=file>`, its label or,
   * under a gesture, a script's `click()`. Default: none, and a file input
   * opens nothing. `useHtmlFilePicker()` is core's file dialog.
   */
  onPickFiles?: HtmlPickFiles;
  /**
   * A page asked to have something saved: an `<a download>` of its own
   * origin, or of a `blob:` or `data:` URL it made. Default: none, and such a
   * link is a link like any other, since a component that shows a page writes
   * nothing to a disk for it. `HtmlNetwork.download` reads what it names.
   */
  onDownload?: HtmlDownloadHandler;
  /**
   * Read what another application dropped on the document, for a page's
   * `drop`: `readHtmlFiles` is one. Default: none, and nothing from outside
   * the process lands on it. A drag from one element of a document to another
   * needs none of this.
   */
  onDropFiles?: (paths: string[]) => Promise<readonly HtmlFile[]>;
  /**
   * How the document asks to be scrolled: the `overflow` its root element
   * gives the viewport, or its `<body>` where the root's is `visible` (CSS
   * Overflow 3, 3.3), as a viewport uses it — `visible` is `auto` there and
   * `clip` is `hidden`. Reported once the document is first laid out, and
   * again when a build changes it.
   *
   * The viewport is the host's: whatever box scrolls this component. The
   * element lays the root and the body out as `visible` either way, and
   * does nothing with the answer itself. A host that shows the web as a
   * browser does hides the scrollbar of an axis that is `hidden` and lets
   * the reader scroll it with neither the wheel nor the keys, though a
   * link to a fragment still scrolls there — what Acid2's `html { overflow:
   * hidden }` asks of it.
   */
  onViewportOverflow?: (overflow: ViewportOverflow) => void;
  /**
   * A scroll container in the document scrolled — under the wheel, or by
   * the handle's `scrollElementTo` — told once it is drawn where it went:
   * what a page hears as the element's `scroll`. See [Scroll
   * containers](docs/components/html.md#scroll-containers).
   */
  onElementScroll?: (element: Element) => void;
  /**
   * What a `<canvas>` shows, drawn in its content box as an `<img>` is, in
   * its place in the paint order: an image the context's `drawImage`
   * takes — an ntk `Image` of the canvas's pixels — or null for nothing.
   * Nothing runs a page's script here, so the pixels are the host's; the
   * handle's `canvasChanged` says when they change. See [Embedded
   * content](docs/components/html.md#embedded-content).
   */
  canvasImage?: (element: Element) => unknown | null;
  /**
   * Whether `canvasImage`'s picture lets nothing behind it show: a WebGL
   * context with no alpha. A player under one that covers it is hidden, and
   * nothing is painted over it again.
   */
  canvasOpaque?: (element: Element) => boolean;
  /**
   * What to show in an `<iframe>`, a `<canvas>`, or an `<embed>` or an
   * `<object>` that shows no image: called with where the element's content
   * box is, in this component's space, and what it returns is mounted
   * there, filling it, beside the document as a `<video>`'s player is —
   * cut by what clips the element, faded as it is
   * faded, and kept mounted, the same node, while the element moves.
   * Nothing is loaded or drawn for one by this component: absent, or
   * answering null, the box is the empty one the document lays out. A
   * browser mounts another `<Html>` with the frame's document in it.
   */
  renderEmbedded?: RenderEmbedded;
  /** Base text style. Defaults: theme `fontSize` (14), `sans-serif`. */
  fontSize?: number;
  fontFamily?: string;
  /** Code font: the face the UA sheet sets code in, which stands for the
   *  generic `monospace` there as a browser's fixed-width font does, at
   *  that generic's smaller size. Default `'monospace'` — there is no theme
   *  token for it. */
  monoFamily?: string;
  /** Selection band fill. Default: theme accent at 35% opacity. */
  selectionColor?: string;
  /** The root `<box>`'s style. */
  style?: Style | Style[];
  /**
   * A handle on the element — what `useHtmlHandle()` supplies. React 19
   * takes `ref` as an ordinary prop on a function component, so it is
   * declared here rather than needing `forwardRef`; it is forwarded to
   * `<htmlview>`, so what lands in it is the node that owns the document.
   */
  ref?: React.Ref<unknown>;
  'data-testname'?: string;
}

/** A highlight pseudo-element as `HtmlHandle.computedStyle` names it,
 *  without its colons: a custom highlight's by its name, unescaped. */
export type HighlightPseudo =
  | 'selection'
  | 'target-text'
  | 'spelling-error'
  | 'grammar-error'
  | `highlight(${string})`;

/** What an application holds to read or change the document it rendered. */
export interface HtmlHandle {
  /** The live DOM. Mutable: this is domhandler's tree, and `domutils` speaks
   *  it, as do the helpers this module re-exports. */
  readonly document: Document | null;
  /**
   * The DOM changed — restyle, re-lay-out and repaint.
   *
   * Explicit rather than observed, and that is the trade the component makes
   * on purpose: watching a plain object graph for mutations costs a proxy per
   * node, which would tax the static render that this is built to make fast
   * in order to speed up the path it is not.
   *
   * Told what changed — every change since the last `refresh`, shaped as a
   * `MutationObserver` reports them (`HtmlChange`) — it restyles only the
   * elements a selector that tests what changed can reach: a class
   * toggled on a menu restyles the menu and what is in it, and an inline
   * style moving a box positioned out of the flow repaints where it was
   * and is. Without them, every element is styled again, which is always
   * right and costs what a first rendering does.
   */
  refresh(changes?: readonly HtmlChange[]): void;
  /** The element under a point, in the window's coordinates — of the
   *  document as it is now: one changed and `refresh()`ed is laid out
   *  first, as `elementRect` lays it out, and one the pane around the
   *  element has scrolled is read where the scroll has it, before the
   *  frame that draws it there. */
  elementAt(x: number, y: number): Element | null;
  /** The link under a point, in the window's coordinates — resolved, as
   *  `onLink` is handed one — for a status bar, or a menu on a link. */
  hrefAt(x: number, y: number): string | null;
  /**
   * Where an element is, in logical pixels from the document's top left:
   * the space the offset of a box scrolling the document is in, so a link
   * to `#section` is `scroller.scrollTo({ y: handle.elementRect(el).y })`.
   * A block's border box; an inline element's across its fragments, padding
   * and border included, as `getBoundingClientRect` measures it, and as
   * tall as its lines. A box fixed to the viewport, and what is in it, is
   * where the scroll of the pane around the element draws it — where the
   * pane is scrolled now, before the frame that draws it there. Null for an
   * element with no box.
   */
  elementRect(element: Element): Rect | null;
  /**
   * Where the fragment of `baseUrl` points, laid out first, for the host to
   * scroll there as a browser scrolls to a URL's fragment: the text its
   * text directives name (`#:~:text=…`), around all its lines, which a
   * browser scrolls to the middle of the viewport, or else the element it
   * names, whose top goes to the top — `scroller.scrollTo({ y: rect.y })`,
   * in `elementRect`'s coordinates. Null where it points at neither. See
   * [Text fragments](docs/components/html.md#text-fragments).
   */
  indicatedPart(): IndicatedPart | null;
  /**
   * Where an element is as `offsetParent`, `offsetLeft`, `offsetTop`,
   * `offsetWidth` and `offsetHeight` measure it (CSSOM View 7), laid out
   * first: its offset parent — the nearest positioned or transformed
   * element around it, or a `<td>`, a `<th>` or a `<table>` around one
   * that is not positioned, or the `<body>` — and its border edge from that
   * one's padding edge, in logical pixels, where layout put it before any
   * transform or scroll moved it. Null for an element with no box.
   */
  offsetRect(element: Element): OffsetRect | null;
  /**
   * Where a scroll container in the document is scrolled to, how far it can
   * be and its scrollport, in CSS pixels, laid out first — `scrollTop`,
   * `scrollHeight`, `clientHeight` and their kin. Null for an element that
   * is no scroll container: one whose `overflow` is `visible` or `clip`,
   * or that has no box.
   */
  scrollState(element: Element): ElementScroll | null;
  /** A `<canvas>`'s picture changed (`canvasImage`): repaint it. */
  canvasChanged(element: Element): void;
  /**
   * Tell a `<video>`'s player what a script asked of it: `paused` for
   * `play()` and `pause()`, `muted`, `volume`, `playbackRate`, and
   * `currentTime` to seek. Kept for the element, so a player mounted later
   * is told it too; a field never set is what the markup says — `autoplay`
   * plays it from the start, and the `muted` attribute mutes it.
   */
  setMediaState(element: Element, state: MediaState): void;
  /**
   * Draw an animation a page's script made (`Element.animate()`): its
   * effect, as the JSON `<Html scripts>`' realm describes it, and where its
   * time is (`css/scripted.ts`), by an id that is its composite order; or,
   * with either null, take it off the element.
   */
  setScriptAnimation(
    element: Element,
    id: number,
    effect: string | null,
    play: string | null,
  ): void;
  /**
   * What an animation's `commitStyles()` writes: the values `properties`
   * come to on the element now, those animations made after `id` left out,
   * as `prop\u0000value` pairs joined by `\u0001`; null where the element
   * is not rendered.
   */
  scriptAnimationValues(
    element: Element,
    id: number,
    properties: readonly string[],
  ): string | null;
  /**
   * Scroll a scroll container to an offset in CSS pixels, either axis left
   * where it is where it is left out, kept within how far it can be — as a
   * script sets `scrollTop` or calls `scrollTo`. Answers where it came to,
   * or null for an element that is no scroll container. `onElementScroll`
   * is told where it moved.
   */
  scrollElementTo(
    element: Element,
    to: { x?: number; y?: number },
    /** A relative scroll, `scrollBy()`'s, which a snap container snaps
     *  in the direction it went. */
    relative?: boolean,
    /** The element the scroll brings into view — `scrollIntoView()`'s,
     *  a fragment's — lined up as its `scroll-snap-align` says where it
     *  is one of the container's snap areas. */
    target?: Element | null,
  ): { x: number; y: number } | null;
  /** The document's `<title>`, if it had one. */
  readonly title: string | null;
  /** The URL the document's relative URLs resolve against — its
   *  `<base href>`, or `baseUrl` — or null where it has none. */
  readonly base: string | null;
  /**
   * An element's style as `getComputedStyle` reads it, laid out first:
   * the properties a script reads, by name, lengths in CSS pixels and
   * colours as `rgb()`. `pseudo` asks for a `::before` or an `::after`, and
   * is null where no rule gives the element one; for a highlight
   * pseudo-element — `selection`, `target-text`, `spelling-error`,
   * `grammar-error` or `highlight(name)`, the name unescaped — as though
   * that highlight were the one active (CSS Pseudo 4, 7.3); or, for the
   * root element, for one of a view transition's pseudo-elements, written
   * without its colons — `view-transition-group(name)`. A file input's
   * `file-selector-button` is its button's, and any other element's its own.
   */
  computedStyle(
    element: Element,
    pseudo?:
      | 'before'
      | 'after'
      | 'file-selector-button'
      | HighlightPseudo
      | `view-transition${string}`
      | null,
  ): Record<string, string> | null;
  /**
   * A custom property's computed value, as `getComputedStyle` reads it by
   * its name, case and all: every `var()` in it replaced, and the empty
   * string where nothing sets it. Asked by its name because a theme sets
   * hundreds of them on the root, which every element inherits. Null for
   * an element the document has not styled.
   */
  customProperty(
    element: Element,
    name: string,
    pseudo?: 'before' | 'after' | HighlightPseudo | null,
  ): string | null;
  /**
   * Whether a media query holds for the document, as `matchMedia` answers:
   * from the same width, viewport height, scale, colour scheme, preference
   * for motion and scripting its own `@media` rules are matched against.
   * False with no document.
   */
  matchMedia(query: string): boolean;
  /**
   * Settled once no style sheet holds back a script the parser met (HTML,
   * "has a style sheet that is blocking scripts"): of the sheets the parse
   * made, those before `script` in the document — or all of them, for a
   * deferred script or a module — each while its `media` holds, a
   * `<link rel=stylesheet>` until its `load` or `error` is told and a
   * `<style>` until what it imports is in. A host runs such a script once
   * this settles, so it reads the document as those sheets style it.
   * Settled at once with no document.
   */
  scriptsUnblocked(script?: Element | null): Promise<void>;
  /**
   * Ask the document whether it may be left, before the host goes to
   * another — a typed address, Reload, a tab closed — as a browser asks
   * (HTML 7.4.2.4): with `scripts` on, its `beforeunload` is told, and it
   * stays only where it asks to be confirmed, the user has pressed or typed
   * in it, and `scripts.promptToUnload` says to stay. True to leave it, and
   * true with no scripts. A navigation the page starts itself is asked as
   * it starts, and a document left without asking hears its
   * `beforeunload` as it goes, with nothing it can keep.
   */
  beforeUnload(): boolean;
  /**
   * Run what a console typed in the document's realm, as the page's own
   * code at its global scope — `var`s and functions it declares are the
   * window's — and answer what it came to, or threw, written out as the
   * page's `console.log` writes a value. Only the string crosses: nothing
   * of the page's is handed to the host. Null where the document runs no
   * scripts (`scripts` off, or its engine not loaded yet).
   */
  evaluate(code: string): ConsoleResult | null;
  /**
   * A level of an object `evaluate` came to (`ConsoleValue.id`): its own
   * properties, each described as a result is — a getter left unread, as
   * an `accessor` — a map's and a set's entries as `[[Entries]]`, and its
   * prototype as `[[Prototype]]`, each an object of its own to read a
   * level of. The page's realm keeps the newest five hundred such objects;
   * null for one it no longer keeps, or with no scripts.
   */
  inspectValue(id: number): ConsoleProperty[] | null;
  /** Let go of every object the page's realm kept for `inspectValue`: a
   *  console cleared. */
  releaseValues(): void;
  /**
   * The classes, or the ids, that would bring one more of the document's
   * rules onto an element were it to carry them, besides those it has: a
   * name a rule's subject asks for, where the rule's whole selector matches
   * the element with it — under the media as they hold now, and with the
   * pointer and the focus wherever the rule wants them. What a developer's
   * tools offer as a class or an id is typed. The element is not changed,
   * and nothing the document keeps is. Sorted; empty with no document.
   */
  namesThatStyle(element: Element, attribute: 'class' | 'id'): string[];
  /**
   * The rules that match an element, as a developer's tools list them: its
   * own `style` first, then its tree's rules in the order they win — the
   * author's before the user agent's, a later layer before an earlier, the
   * more specific first and of two alike the later — and HTML's
   * presentational hints, each with its declarations as written and the
   * media it is under. Under the media as they hold, the pointer and the
   * focus where they are. Which declaration wins a property is the
   * reader's to work out from the order, `!important` turning it round.
   * A rule from a sheet says where it was written (`source`).
   */
  matchedRules(element: Element): HtmlMatchedRule[];
  /**
   * The sheets the document is styled by, a `@import`ed one and a shadow
   * tree's among them, each with the text it was parsed from: what a
   * rule's `source.sheet` is, for as long as the sheets read the same.
   */
  styleSheets(): HtmlSheetSource[];
  /**
   * What a form control holds, as a script reads it: what was typed into a
   * field or its markup's value where nothing was, the option a `<select>`
   * shows, whether a checkbox or a radio is checked. Null for what is no
   * control. The `value` attribute is the field's default, and stays as the
   * markup wrote it.
   */
  controlValue(element: Element): string | boolean | null;
  /** Set what a control holds, as a script sets `value` or `checked`: no
   *  event, and a field's widget shows it where it is, its focus kept. A
   *  boolean is a checkbox's or a radio's checkedness. False for what is no
   *  control, and for a boolean handed any other. */
  setControlValue(element: Element, value: string | boolean): boolean;
  /**
   * A text field's selection, as a script reads `selectionStart`,
   * `selectionEnd` and `selectionDirection` (HTML 4.10.5.2.10): offsets
   * into what it holds in UTF-16 code units, and the end the caret's but
   * for `'backward'`. Its widget's, where core's field says (react-x11
   * with `setSelectionRange` on a `<textinput>`), and else the last set —
   * a caret at the end of its text where none was. Null for what is no
   * text field.
   */
  controlSelection(element: Element): FieldSelection | null;
  /**
   * Select in a text field, as a script's `setSelectionRange` does: the
   * offsets clamped to what it holds, the start to the end, and no event.
   * Its widget shows it while it has the focus, where core's field takes
   * a selection; and it is kept for the widget mounted next. False for
   * what is no text field.
   */
  setControlSelection(
    element: Element,
    start: number,
    end: number,
    direction?: FieldSelection['direction'],
  ): boolean;
  /** What another application is dragging over the document, for a host
   *  that takes drops for it, as one of a `<Frame>` pane does: whether what
   *  is under it takes the drop. A drag from another application reaches the
   *  document by itself where it has a window of its own. */
  dragOver(drop: HtmlDrop): boolean;
  /** It left. */
  dragLeave(): void;
  /** It was dropped, with its `paths` and its `text`, which the document
   *  reads through `onDropFiles`: whether a page took it. */
  dropHere(drop: HtmlDrop): Promise<boolean>;
  /**
   * Drop a control's picker, as a script's `showPicker()` does once it is
   * allowed to: a drop-down `<select>`'s menu, which its widget drops
   * where core's `<Select>` takes `open` (react-x11 with the select's open
   * state), and which `:open` matches while it is down. No focus moves.
   * False where nothing drops: a list box, a disabled select, an `<input>`,
   * none of whose pickers is a widget here, or an older core's select.
   */
  showPicker(element: Element): boolean;
  /** Give an element the focus, as Tab gives it: a control's widget, a
   *  link, a button, an element with a `tabindex`. False where it takes
   *  none. */
  focus(element: Element): boolean;
  /** Take the focus off whatever of the document's has it. */
  blur(): void;
  /** The document's element whose widget or stop has the focus, or null. */
  readonly activeElement: Element | null;
  /**
   * Run what a click on an element does, with no click told of: follow a
   * link through `onLink`, press a button — a submit button submits, its
   * `submit` asked about first — open or close a `<details>`. A host's
   * `el.click()` calls it once its own click was not cancelled. False
   * where a click does nothing. A checkbox's and a radio's state are
   * `setControlValue`'s.
   */
  activate(element: Element): boolean;
  /** Send a form as `form.submit()` does: no validation, no `submit`. */
  submitForm(form: Element, submitter?: Element | null): void;
  /** HTML's interactive validation of a form: true where it may go, and
   *  else false, with the reason shown at its first wrong control. */
  reportValidity(
    form: Element,
    submitter?: Element | null,
    /** Whether this is an attempt to send it, which shows the user what is
     *  wrong (`:user-invalid`), as `requestSubmit()` is. */
    attempt?: boolean,
  ): boolean;
  /** Put a form's controls back as their markup has them, as
   *  `form.reset()` does after its `reset`. */
  resetForm(form: Element): void;
}

// --- the look ---------------------------------------------------------------

function deriveLook(
  theme: Record<string, unknown>,
  props: HtmlProps,
): RootLook {
  const text = String(theme.text ?? '#2d3436');
  return {
    color: text,
    fontFamily: props.fontFamily ?? 'sans-serif',
    fontSize: props.fontSize ?? Number(theme.fontSize ?? 14),
    monoFamily: props.monoFamily ?? 'monospace',
    linkColor: String(theme.accent ?? '#2980b9'),
    borderColor: String(theme.border ?? '#b2bec3'),
    mutedColor: String(theme.textMuted ?? '#7f8c8d'),
    background: String(theme.background ?? 'white'),
    colorScheme: theme.scheme === 'dark' ? 'dark' : 'light',
    ...(props.defaultColorScheme && { normalScheme: props.defaultColorScheme }),
    surface: String(theme.surface ?? theme.background ?? 'white'),
    controlPadY: Number(theme.paddingY ?? 6),
    controlBorder: Number(theme.borderWidth ?? 1),
    controlRadius: Number(theme.radius ?? 4),
    // not `fontSize` and `fontFamily`, which a host sets to the web's
    // `medium` and the face it reads pages in
    controlFontSize: Number(theme.fontSize ?? 14),
    controlFontFamily: String(theme.fontFamily ?? 'sans-serif'),
    ...(typeof theme.focusRing === 'string' && { focusRing: theme.focusRing }),
    ...(typeof theme.focusRingWidth === 'number' && {
      focusRingWidth: theme.focusRingWidth,
    }),
    ...(typeof theme.focusRingOffset === 'number' && {
      focusRingOffset: theme.focusRingOffset,
    }),
  };
}

/** What a document sets in the code face: the elements the UA sheet puts in
 *  it, and a style sheet that names `monospace`, in either case. */
const CODE_MARKUP = /<(?:code|pre|kbd|samp|tt|listing|xmp)\b|monospace/i;

/**
 * The code face, once the source holds code, and null before. A source that
 * grows is read once, from a little before where it was last read to find a
 * name a chunk split, so a document streamed in thousands of pieces is not
 * read again at each one; a source that does not start with the last is
 * read whole. Once found, found: warming a face twice warms nothing.
 */
function useCodeFamily(source: string, family: string): string | null {
  const read = React.useRef({ source: '', found: false });
  const seen = read.current;
  if (!seen.found && source !== seen.source) {
    const from = source.startsWith(seen.source)
      ? Math.max(0, seen.source.length - 'monospace'.length)
      : 0;
    seen.found = CODE_MARKUP.test(from ? source.slice(from) : source);
    seen.source = source;
  }
  return seen.found ? family : null;
}

// --- the component ----------------------------------------------------------

/** The elements a `referrerpolicy` attribute says the referrer of what
 *  they load for (HTML 2.5.5): an image's, a script's and a link's. */
const REFERRING = new Set(['img', 'script', 'link']);

/**
 * A rendered HTML document. Text selects across the whole of it — mouse
 * (double/triple click for word and block), Ctrl+A, Ctrl+C, and X11 PRIMARY
 * on release.
 *
 * ```jsx
 * <box style={{ overflow: 'scroll', flexGrow: 1 }}>
 *   <Html source={html}
 *         onLink={(href) => openInBrowser(href)}
 *         onResource={(r) => r.kind === 'image' ? loadImage(r.url) : null} />
 * </box>
 * ```
 */
export function Html(props: HtmlProps): ReactElement {
  if (props.scripts) return h(ScriptedHtml, props);
  // what a document's own policy takes from it, whether or not anything runs
  const sandbox = props.headers ? sandboxOfPolicy(props.headers) : 0;
  return h(
    HtmlDocument,
    (sandbox
      ? { ...props, _sandbox: sandbox, _linksAlone: true }
      : props) as InternalHtmlProps,
  );
}

/** `<Html scripts>`: the document with its scripts' seams filled in
 *  (`scripts/scripted.ts`), and the engine's own handle on it. */
function ScriptedHtml(props: HtmlProps): ReactElement {
  const handle = useHtmlHandle();
  const outer = props.ref;
  const ref = React.useCallback(
    (node: unknown) => {
      (handle.ref as React.RefObject<unknown>).current = node;
      if (typeof outer === 'function') outer(node);
      else if (outer) (outer as React.RefObject<unknown>).current = node;
    },
    [outer, handle],
  );
  return h(HtmlDocument, { ...useScriptedHtml(props, handle), ref });
}

function HtmlDocument(props: InternalHtmlProps): ReactElement {
  const {
    source,
    contentType,
    partial = !(contentType && isXmlType(contentType)),
    selectable = true,
    animate = true,
    stylesheet,
    charset,
    baseUrl,
    onLink,
    onScript,
    onDocument,
    onControlChange,
    onSubmit,
    onViewportOverflow,
    onDomEvent,
    style,
  } = props;

  const theme = useTheme() as unknown as Record<string, unknown>;
  // read whether or not the prop decides, since a hook is called every
  // render or never
  const desktop = useSystemAppearance();
  const reducedMotion = props.reducedMotion ?? desktop.reducedMotion;
  // an editing host's caret blinks as the desktop says, or not at all, and
  // is drawn while the window has the keyboard
  const { caretBlink, caretBlinkMs } = useDesktopSettings();
  const windowFocused = useWindowState().focused;
  // what the document's sandbox takes from it, which its host knows
  const sandbox = props._sandbox ?? 0;
  const headers = props.headers;
  // a link that says to save what it names, with no script to read it: the
  // realm answers for one where a document's scripts run (`downloadLink`)
  const onDownload = sandbox & SB_DOWNLOADS ? undefined : props.onDownload;
  // what a sandbox loads is asked for as of no origin, and another origin's
  // font by CORS, which its answer is held to (`fontAllowed`)
  const onResource = React.useMemo(() => {
    const given = props.onResource;
    if (!given) return given;
    const opaque = !!(sandbox & SB_ORIGIN);
    const origin = opaque ? 'null' : baseUrl ? originOfUrl(baseUrl) : null;
    return (resource: ResourceRequest) => {
      // under its element's referrer policy, or its document's
      const policy =
        referrerPolicyOf(
          REFERRING.has(tagOf(resource.element))
            ? attr(resource.element, 'referrerpolicy')
            : null,
        ) || documentReferrerPolicy(resource.element, headers);
      const request = policy
        ? { ...resource, referrerPolicy: policy }
        : resource;
      const asked = opaque ? { ...request, opaqueOrigin: true } : request;
      if (
        request.kind !== 'font' ||
        origin === null ||
        ownFont(request.url, origin, baseUrl)
      ) {
        return given(asked);
      }
      const cors = { origin, mode: 'anonymous' as const };
      return Promise.resolve(given({ ...asked, cors })).then((result) =>
        result?.kind === 'font' && !fontAllowed(result, request.url, origin)
          ? null
          : result,
      );
    };
  }, [props.onResource, sandbox, baseUrl, headers]);
  const followed = React.useMemo(() => {
    const refuses = props._linksAlone
      ? sandbox & (SB_POPUPS | SB_PROPAGATES | SB_DOWNLOADS)
      : 0;
    if (!onLink || props.scripts || (!onDownload && !refuses)) return onLink;
    return (href: string, ev: X11MouseEvent<DrawnNode>) => {
      const anchor = linkAround(viewNode.current?.elementAtPoint(ev.x, ev.y));
      const document = viewNode.current?.document ?? null;
      // with no script to open a window for it, a sandbox's link to a new
      // one goes nowhere: no tab carries its flags
      if (
        refuses & (SB_POPUPS | SB_PROPAGATES) &&
        navigableFor(document, linkTarget(anchor, document)) === 'tab'
      ) {
        return;
      }
      const name = anchor && attr(anchor, 'download');
      if (name === undefined || name === null || !sameOriginAs(href, baseUrl)) {
        onLink(href, ev);
        return;
      }
      // nor does what it would save (HTML 4.6.5, "allowed to download")
      if (refuses & SB_DOWNLOADS) return;
      if (onDownload) onDownload({ url: href, filename: name });
      else onLink(href, ev);
    };
  }, [onLink, onDownload, props.scripts, props._linksAlone, baseUrl, sandbox]);
  const links = useLinkClicks(followed);
  const menu = useSelectionMenu(selectable);

  // The element, for the document's base when a form is submitted, as well
  // as wherever the application's `ref` wants it — and the handle's way to
  // what this component holds, the widgets and the focus (`interactive`).
  const viewNode = React.useRef<HtmlViewNode | null>(null);
  const rootNode = React.useRef<DrawnNode | null>(null);
  const live = React.useRef<Live | null>(null);
  const interactive = React.useMemo(
    () => documentInteraction(viewNode, rootNode, live),
    [],
  );
  const outerRef = props.ref;
  // what the handle's `beforeUnload` asks: the document's scripts, where
  // they run (`_unloadCheck`)
  const unloadCheck = React.useRef(props._unloadCheck);
  unloadCheck.current = props._unloadCheck;
  // and what its `evaluate` runs them with (`_evaluate`)
  const evaluate = React.useRef(props._evaluate);
  evaluate.current = props._evaluate;
  const inspectValue = React.useRef(props._inspectValue);
  inspectValue.current = props._inspectValue;
  const releaseValues = React.useRef(props._releaseValues);
  releaseValues.current = props._releaseValues;
  const viewRef = React.useCallback(
    (node: HtmlViewNode | null) => {
      viewNode.current = node;
      if (node) {
        node.interactive = interactive;
        node.unloadCheck = () => unloadCheck.current?.() ?? true;
        node.evaluate = (code) => evaluate.current?.(code) ?? null;
        node.inspectValue = (id) => inspectValue.current?.(id) ?? null;
        node.releaseValues = () => releaseValues.current?.();
      }
      if (typeof outerRef === 'function') outerRef(node);
      else if (outerRef) (outerRef as React.RefObject<unknown>).current = node;
    },
    [outerRef, interactive],
  );

  const look = React.useMemo(
    () => deriveLook(theme, props),
    [
      theme,
      props.fontSize,
      props.fontFamily,
      props.monoFamily,
      props.defaultColorScheme,
    ],
  );
  // a document with code in it sets that code in the mono family, and its
  // render is the head start its first layout would otherwise wait on the
  // system's font matcher for (`useFontPrewarm`)
  useFontPrewarm(useCodeFamily(source, look.monoFamily));

  const documentRef = React.useRef<Document | null>(null);
  const [controls, setControls] = React.useState<ControlRect[]>([]);
  const [domRevision, setDomRevision] = React.useState(0);
  // how far across the viewport's scrollable overflow reaches past the
  // element's width, which a box of no size marks for the pane around it
  const [scrollReach, setScrollReach] = React.useState(0);
  const forms = useForms({
    view: viewNode,
    baseUrl,
    charset,
    onControlChange,
    onSubmit,
    onPickFiles: props.onPickFiles,
    onDomEvent,
    sandbox,
    touch: (changes) => {
      if (changes) viewNode.current?.touchDocument(changes);
      else setDomRevision((n) => n + 1);
    },
  });

  // The keyboard's way through what the document draws: a box that takes
  // the focus for each link, button and summary Tab reaches (`stops.ts`).
  const stops = useFocusStops({
    view: viewNode,
    root: rootNode,
    forms,
    selectable,
    onLink: followed,
    onDomEvent,
  });
  const mayHaveStops = useFocusableMarkup(source);
  // core's `<video>` over each video the document can show one over
  // (`videos.ts`)
  const videos = useVideos(viewNode);
  // core's `<audio>` for each that a page's script plays (`sounds.ts`)
  const sounds = useSounds(viewNode);
  // what the host shows in the iframes, canvases and embeds (`embedded.ts`)
  const embedded = useEmbedded(props.renderEmbedded, viewNode);
  const events = useDocumentEvents(
    onDomEvent,
    viewNode,
    forms,
    stops,
    embedded,
    props._readClipboard,
    props._movesHeard,
  );
  const drag = useDocumentDrag({
    view: viewNode,
    baseUrl,
    onDomEvent,
    embedded,
    pressed: events.pressedElement,
    pressPoint: events.pressPoint,
    controlOf: forms.controlOf,
    onDropFiles: props.onDropFiles,
  });
  live.current = {
    forms,
    stops,
    onLink: followed,
    onDownload,
    drag: drag.external,
  };
  // what a script focused before anything could take it takes it from the
  // render that mounts a widget or a stop for it, however long that is: no
  // count of turns is long enough on a page still loading
  React.useEffect(() => interactive.settleFocus());
  // what its forms and its links are written in, where that is no UTF-8
  React.useEffect(() => {
    void readyFor(charset);
  }, [charset]);
  // the parse's end, and the load behind it, told once core has laid the
  // element out: a host runs the page's scripts from them, and they measure
  // the document (`parsed.ts`)
  const lifecycle = useParsedOnceLaidOut(props, viewNode);

  const handleDocument = React.useCallback(
    (doc: Document) => {
      documentRef.current = doc;
      onDocument?.(doc);
    },
    [onDocument],
  );

  // The controls the element reports are held as state because they are React
  // elements: the element decides *where* a widget goes, React decides what it
  // is. Same split as `<Flow onNodeBodies>`, and for the same reason — a
  // painted control is a picture of a control.
  const handleControls = React.useCallback((rects: ControlRect[]) => {
    setControls(rects);
  }, []);

  // a `<link>`'s sheet applied, or not to be had, and what an `<img>` came
  // to: told as the page's `load` or `error` at the element, after the fact
  const handleSheet = React.useCallback(
    (element: Element, outcome: 'load' | 'error') =>
      void fireDomEvent(onDomEvent, outcome, element),
    [onDomEvent],
  );

  const selectionColor =
    props.selectionColor ?? tint(String(theme.accent ?? '#2980b9'), 0.35);

  const viewProps: HtmlViewProps & {
    ref?: React.Ref<unknown>;
    onLayout?: () => void;
  } = {
    source,
    ...(props.document && { document: props.document }),
    ...(contentType && { contentType }),
    complete: !partial,
    stylesheet,
    charset,
    baseUrl,
    look,
    selectionColor,
    onResource,
    onScript,
    onDocument: handleDocument,
    onControls: handleControls,
    onMedia: videos.onMedia,
    onSounds: sounds.onSounds,
    onMediaEvent: props._onMediaEvent,
    onEmbedded: props.renderEmbedded ? embedded.onEmbedded : undefined,
    onFocusStops: stops.onFocusStops,
    watchStops: stops.watch,
    onViewportOverflow,
    onScrollReach: setScrollReach,
    onElementScroll: props.onElementScroll,
    onViewportScroll: props._onViewportScroll,
    onPaint: props._onPaint,
    embedderScheme: props._embedderScheme,
    frameElement: props._frameElement,
    onCssEvents: props._onCssEvents,
    onImage: props._onImage ?? (onDomEvent ? handleSheet : undefined),
    canvasImage: props.canvasImage,
    canvasOpaque: props.canvasOpaque,
    framed: props._framed,
    domRevision,
    animate,
    reducedMotion,
    caretBlink,
    caretBlinkMs,
    windowFocused,
    scripting: props.scripting ?? false,
    onParsed: lifecycle.onParsed,
    onLoaded: lifecycle.onLoaded,
    onParserBlocked: lifecycle.onParserBlocked,
    onLayout: lifecycle.onLayout,
    onSheet: onDomEvent ? handleSheet : undefined,
    ref: viewRef as React.Ref<unknown>,
    // grown with the component, where an application grows it: the root's
    // background covers the whole of it, as a page's covers the window
    style: { alignSelf: 'stretch', flexGrow: 1 },
  };

  const children: ReactNode[] = [
    h(ELEMENT, { key: 'view', ...viewProps } as Record<string, unknown>),
    // what keeps a key in the document while a focus a script asked for
    // has nothing to take it, which only a page that hears keys needs
    ...(onDomEvent ? [stops.keyHolder()] : []),
    // over the document and under its widgets: a video a control is drawn
    // over is no video a player is mounted for
    ...videos.render(),
    ...embedded.render(),
    // no room, and nothing drawn: where they are among the children is
    // nothing anyone sees
    ...sounds.render(),
    // The viewport's scrollable overflow, past the element's own width,
    // which the element stays: core's pane scrolls as far as a box under it
    // reaches, so a box of no size where it ends lets the pane scroll the
    // document across (CSS Overflow 3, 2.2), where a page wider than its
    // window was cut at its right edge
    ...(scrollReach > 0
      ? [
          hx('box', {
            key: 'reach',
            style: {
              position: 'absolute',
              left: scrollReach,
              top: 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            },
          }),
        ]
      : []),
  ];
  // The widgets and the stops in the document's order, which is the order
  // core's Tab goes through a subtree in where the document hands it on:
  // into the document at its first, and out of it after its last.
  const { widgets, message } = forms.render(controls, look);
  const boxes = stops.render();
  let next = 0;
  controls.forEach((rect, i) => {
    const order = stops.orderOf(rect.element) ?? -1;
    while (
      next < boxes.length &&
      (stops.orderOf(boxes[next].element) ?? 0) < order
    ) {
      children.push(boxes[next++].node);
    }
    children.push(widgets[i]);
  });
  while (next < boxes.length) children.push(boxes[next++].node);
  children.push(message);
  if (props._frames)
    children.push(h(React.Fragment, { key: 'frames' }, props._frames));

  const rootStyle: Style = { flexDirection: 'column', position: 'relative' };
  return hx(
    'box',
    {
      style: style
        ? [rootStyle, ...(Array.isArray(style) ? style : [style])]
        : rootStyle,
      // The whole selection: a drag across the document, word and block
      // granularity, Ctrl+A, Ctrl+C, PRIMARY on release, and one visible
      // selection per application. One element answers for every paragraph,
      // so there is nothing per-block to thread through.
      selectable,
      // a document whose host hears what happens to it drags as a page does:
      // core's drag, of what the press was on (`useDocumentDrag`)
      ...(onDomEvent && drag.rootProps),
      // Where the document has stops of its own, Tab goes to them and not
      // to the surface they are on, which a press still focuses for the
      // selection's keys — and Tab from there goes on from the press.
      ...(selectable && (stops.hasStops ?? mayHaveStops) && { tabIndex: -1 }),
      ref: rootNode,
      selectionColor: props.selectionColor,
      ...links,
      // what the page hears first, before anything in the document — a
      // widget included — does what it does (`useDocumentEvents`)
      onMouseDownCapture: events.onMouseDownCapture,
      onMouseUpCapture: events.onMouseUpCapture,
      onContextMenuCapture: events.onContextMenuCapture,
      onKeyDownCapture: events.onKeyDownCapture,
      onKeyUpCapture: events.onKeyUpCapture,
      onCompositionStartCapture: events.onCompositionStartCapture,
      onCompositionUpdateCapture: events.onCompositionUpdateCapture,
      onCompositionEndCapture: events.onCompositionEndCapture,
      onMouseMoveCapture: events.onMouseMoveCapture,
      onMouseLeave: events.onMouseLeave,
      onWheelCapture: events.onWheelCapture,
      onMouseDown: (ev: X11MouseEvent<DrawnNode>) => {
        // a press in an `<iframe>`'s document is that document's, as a key
        // typed there is: it bubbles out of the frame's own `<Html>`, whose
        // node answers `elementAtPoint` and `hrefAtPoint` too, and this one
        // took it a second time — a details toggled back, and a link
        // followed or a form sent by the page
        if (embedded.contains(ev.target as DrawnNode)) return;
        if (events.onBar()) return;
        viewNode.current?.pressedAt(ev.x, ev.y);
        links.onMouseDown(ev);
        forms.onMouseDown(ev);
        stops.onMouseDown(ev);
      },
      onKeyDown: (ev: X11KeyboardEvent<DrawnNode>) => {
        stops.onKeyDown(ev);
        if (ev.defaultPrevented) return;
        // the scroll keys, where the focus is on the document or a link of
        // it — a field's widget keeps its arrows
        const view = viewNode.current;
        const key =
          ev.keysym === undefined ? undefined : SCROLL_KEYS[ev.keysym];
        if (!view || !key || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const target = ev.target as DrawnNode;
        const on = stops.elementOf(target);
        const held = stops.holds(target);
        // and not where a focus is owed: what will take it may keep its
        // arrows, as a field's widget does
        if (held && on) return;
        if (
          !on &&
          !held &&
          target !== rootNode.current &&
          target !== (view as unknown)
        )
          return;
        const [axis, how, sign] = key;
        const back = ev.keysym === XK_SPACE && ev.shiftKey;
        if (view.scrollForKey(axis, how, back ? -1 : sign, on ?? null)) {
          ev.preventDefault();
        }
      },
      onMouseUp: (ev: X11MouseEvent<DrawnNode>) => {
        if (embedded.contains(ev.target as DrawnNode)) return;
        if (events.onBar()) return;
        // the click the press and the release made, which the page may
        // cancel: then no link is followed and no button pressed
        if (!events.clicked(ev)) return;
        links.onMouseUp(ev);
        forms.onMouseUp(ev);
      },
      ...menu,
      'data-testname': props['data-testname'],
    } as Record<string, unknown>,
    ...children,
  );
}

/**
 * A handle on a rendered document, for reading or changing it.
 *
 * ```jsx
 * const handle = useHtmlHandle();
 * <Html source={html} ref={handle.ref} />
 * // later
 * handle.document?.children …           // domhandler's tree
 * handle.refresh();                      // and the view catches up
 * ```
 */
export function useHtmlHandle(): HtmlHandle & { ref: React.Ref<unknown> } {
  const nodeRef = React.useRef<HtmlViewNode | null>(null);
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  return React.useMemo(() => makeHtmlHandle(nodeRef, force), []);
}

/** A handle on the node `nodeRef` comes to hold, which answers nothing until
 *  it holds one. */
export function makeHtmlHandle(
  nodeRef: React.RefObject<HtmlViewNode | null>,
  force: () => void,
): HtmlHandle & HandleInternals & { ref: React.Ref<unknown> } {
  return {
    ref: nodeRef as unknown as React.Ref<unknown>,
    get document() {
      return nodeRef.current?.document ?? null;
    },
    get title() {
      return nodeRef.current?.title ?? null;
    },
    get base() {
      return nodeRef.current?.documentBase ?? null;
    },
    refresh: (changes?: readonly HtmlChange[]) => {
      nodeRef.current?.touchDocument(changes ?? null);
      force();
    },
    elementAt: (x: number, y: number) =>
      (nodeRef.current?.settle(), nodeRef.current?.elementAtPoint(x, y)) ??
      null,
    hrefAt: (x: number, y: number) =>
      nodeRef.current?.hrefAtPoint(x, y) ?? null,
    elementRect: (element: Element) =>
      nodeRef.current?.elementRect(element) ?? null,
    indicatedPart: () => nodeRef.current?.indicatedPart() ?? null,
    offsetRect: (element: Element) =>
      nodeRef.current?.offsetRect(element) ?? null,
    askImage: (element) => nodeRef.current?.askImage(element),
    imageState: (element) =>
      nodeRef.current?.imageState(element) ?? {
        complete: true,
        available: false,
        width: 0,
        height: 0,
        src: '',
      },
    clientBox: (element: Element) =>
      nodeRef.current?.clientBoxOf(element) ?? null,
    checkVisibility: (element, asks) =>
      nodeRef.current?.checkVisibility(element, asks) ?? false,
    drawnAtViewport: (element: Element) =>
      nodeRef.current?.atViewport(element) ?? false,
    scrollMoves: (scroller: Element, element: Element) =>
      nodeRef.current?.scrollMoves(scroller, element) ?? false,
    showClip: (element: Element, file: string | null, reports?: boolean) =>
      nodeRef.current?.showClip(element, file, reports),
    geometryKey: () => nodeRef.current?.geometryKey() ?? '',
    pointerElement: () => nodeRef.current?.pointerElement() ?? null,
    pointerDrawn: () => nodeRef.current?.pointerDrawn() ?? null,
    embedRendered: (element) => nodeRef.current?.embedRendered(element) ?? null,
    mountsEmbedded: (element) =>
      nodeRef.current?.mountsEmbedded(element) ?? null,
    selectionKey: () => nodeRef.current?.selectionKey() ?? '',
    hoverAgain: () => nodeRef.current?.hoverAgain(),
    hoverOn: (element) => nodeRef.current?.hoverOn(element),
    pointIn: (how, element, x, y) =>
      nodeRef.current?.pointIn(how, element, x, y) ?? null,
    viewportHeld: (busy: number) =>
      nodeRef.current?.viewportHeld(busy) ?? false,
    intersectionsOf: (
      elements: readonly (Element | null)[],
      root: Element | null,
      margin: readonly MarginLength[] | null,
    ) => nodeRef.current?.intersectionsOf(elements, root, margin) ?? null,
    textPointAt: (x: number, y: number) =>
      nodeRef.current?.textPointAt(x, y) ?? null,
    textRects: (
      start: AnyNode,
      startOffset: number,
      end: AnyNode,
      endOffset: number,
    ) => nodeRef.current?.textRects(start, startOffset, end, endOffset) ?? null,
    setHighlights: (highlights) => nodeRef.current?.setHighlights(highlights),
    setRegisteredProperties: (rules) =>
      nodeRef.current?.setRegisteredProperties(rules),
    snapViewport: (x, y, target, relative) =>
      nodeRef.current?.snapViewport(x, y, target, relative) ?? { x, y },
    layoutNow: () => nodeRef.current?.layoutNow(),
    documentSize: () =>
      nodeRef.current?.documentSize() ?? { width: 0, height: 0 },
    interrupted: () => nodeRef.current?.interrupted(),
    cssAnimations: (element, subtree) =>
      nodeRef.current?.cssAnimationsOf(element, subtree) ?? [],
    cssTransitions: (element, subtree) =>
      nodeRef.current?.cssTransitionsOf(element, subtree) ?? [],
    seekTransition: (key, currentTime) =>
      nodeRef.current?.seekTransition(key, currentTime),
    seekAnimation: (key, currentTime, paused) =>
      nodeRef.current?.seekAnimation(key, currentTime, paused),
    seekScrolled: (key, mode, time, rate) =>
      nodeRef.current?.seekScrolled(key, mode, time, rate),
    viewAdjust: (element, vertical) =>
      nodeRef.current?.viewAdjustOf(element, vertical) ?? null,
    cancelCss: (kind, key) => nodeRef.current?.cancelCss(kind, key),
    cssKeyframes: (element, pseudo, name) =>
      nodeRef.current?.cssKeyframesOf(element, pseudo, name) ?? null,
    transitionCaptureOld: () => nodeRef.current?.transitionCaptureOld() ?? '',
    transitionCaptureNew: () => nodeRef.current?.transitionCaptureNew() ?? '',
    transitionRemaining: () => nodeRef.current?.transitionRemaining() ?? 0,
    transitionEnd: () => nodeRef.current?.transitionEnd(),
    selectionPoints: () => nodeRef.current?.selectionPoints() ?? null,
    selectedText: () => nodeRef.current?.parent?.selectedText?.() ?? '',
    selectPoints: (points) => nodeRef.current?.selectPoints(points),
    setCaret: (point) => nodeRef.current?.setCaret(point),
    movedPoint: (node, offset, granularity, back) =>
      nodeRef.current?.movedPoint(node, offset, granularity, back) ?? null,
    scrollState: (element: Element) =>
      nodeRef.current?.scrollStateOf(element) ?? null,
    canvasChanged: (element: Element) =>
      nodeRef.current?.canvasChanged(element),
    setMediaState: (element: Element, state: MediaState) =>
      nodeRef.current?.setMediaState(element, state),
    setScriptAnimation: (
      element: Element,
      id: number,
      effect: string | null,
      play: string | null,
    ) => nodeRef.current?.setScriptAnimation(element, id, effect, play),
    scriptAnimationValues: (
      element: Element,
      id: number,
      properties: readonly string[],
    ) =>
      nodeRef.current?.scriptAnimationValues(element, id, properties) ?? null,
    scrollElementTo: (
      element: Element,
      to: { x?: number; y?: number },
      relative?: boolean,
      target?: Element | null,
    ) =>
      nodeRef.current?.scrollElementTo(element, to, relative, target) ?? null,
    styleWhileOwed: (element, pseudo) =>
      nodeRef.current?.computedStyle(element, pseudo, true) ?? null,
    layoutOwed: () => nodeRef.current?.layoutOwed() ?? false,
    fontMedium: () => nodeRef.current?.fontMedium() ?? 16,
    computedStyle: (
      element: Element,
      pseudo?: 'before' | 'after' | HighlightPseudo | null,
    ) => nodeRef.current?.computedStyle(element, pseudo ?? null) ?? null,
    customProperty: (
      element: Element,
      name: string,
      pseudo?: 'before' | 'after' | HighlightPseudo | null,
    ) => nodeRef.current?.customProperty(element, name, pseudo ?? null) ?? null,
    matchMedia: (query: string) => nodeRef.current?.matchMedia(query) ?? false,
    fontFaces: () => nodeRef.current?.fontFaces() ?? [],
    matchFonts: (query, text) =>
      nodeRef.current?.matchFonts(query, text) ?? { keys: [], found: false },
    loadFonts: (keys) =>
      nodeRef.current?.loadFonts(keys) ??
      Promise.resolve(keys.map(() => false)),
    fontsSettled: () => nodeRef.current?.fontsSettled() ?? Promise.resolve(),
    scriptFonts: () => nodeRef.current?.scriptFonts() ?? null,
    scriptFontsChanged: (id: number, added: boolean) =>
      nodeRef.current?.scriptFontsChanged(id, added),
    svgMeasure: () => nodeRef.current?.svgMeasure() ?? null,
    svgComputed: (el: Element) => nodeRef.current?.svgComputed(el) ?? null,
    canvasText: () => nodeRef.current?.canvasText() ?? null,
    foreignRect: (element) => nodeRef.current?.foreignRect(element) ?? null,
    mediaEnvironment: () => nodeRef.current?.mediaEnvironment() ?? '',
    scriptsUnblocked: (script?: Element | null) =>
      nodeRef.current?.scriptsUnblocked(script ?? null) ?? Promise.resolve(),
    beforeUnload: () => nodeRef.current?.unloadCheck?.() ?? true,
    evaluate: (code: string) => nodeRef.current?.evaluate?.(code) ?? null,
    inspectValue: (id: number) => nodeRef.current?.inspectValue?.(id) ?? null,
    releaseValues: () => nodeRef.current?.releaseValues?.(),
    namesThatStyle: (element: Element, attribute: 'class' | 'id') =>
      nodeRef.current?.namesThatStyle(element, attribute) ?? [],
    matchedRules: (element: Element) =>
      nodeRef.current?.matchedRules(element) ?? [],
    styleSheets: () => nodeRef.current?.styleSheets() ?? [],
    parserWrite: (script: Element, markup: string) =>
      nodeRef.current?.parserWrite(script, markup) ?? false,
    parserResume: (script: Element) => nodeRef.current?.parserResume(script),
    parserMade: () => nodeRef.current?.parserMade() ?? [],
    controlValue: (element: Element) =>
      nodeRef.current?.interactive?.controlValue(element) ?? null,
    setControlValue: (element: Element, value: string | boolean) =>
      nodeRef.current?.interactive?.setControlValue(element, value) ?? false,
    controlSelection: (element: Element) =>
      nodeRef.current?.interactive?.controlSelection(element) ?? null,
    setControlSelection: (
      element: Element,
      start: number,
      end: number,
      direction?: FieldSelection['direction'],
    ) =>
      nodeRef.current?.interactive?.setControlSelection(element, {
        start,
        end,
        direction:
          direction === 'forward' || direction === 'backward'
            ? direction
            : 'none',
      }) ?? false,
    showPicker: (element: Element) =>
      nodeRef.current?.interactive?.showPicker(element) ?? false,
    pickFiles: (element: Element) =>
      nodeRef.current?.interactive?.pickFiles(element),
    download: (request: HtmlDownloadRequest) =>
      nodeRef.current?.interactive?.download(request) ?? false,
    dragOver: (drop: HtmlDrop) =>
      nodeRef.current?.interactive?.dragOver(drop) ?? false,
    dragLeave: () => nodeRef.current?.interactive?.dragLeave(),
    dropHere: (drop: HtmlDrop) =>
      nodeRef.current?.interactive?.dropHere(drop) ?? Promise.resolve(false),
    setFiles: (element: Element, files: readonly HtmlFile[]) =>
      nodeRef.current?.interactive?.setFiles(element, files),
    focus: (element: Element) =>
      nodeRef.current?.interactive?.focus(element) ?? false,
    toldFocus: (element: Element) =>
      nodeRef.current?.interactive?.told(element),
    blur: () => nodeRef.current?.interactive?.blur(),
    get activeElement() {
      return nodeRef.current?.interactive?.activeElement() ?? null;
    },
    activate: (element: Element) =>
      nodeRef.current?.interactive?.activate(element) ?? false,
    submitForm: (form: Element, submitter?: Element | null) =>
      nodeRef.current?.interactive?.submit(form, submitter ?? null),
    reportValidity: (
      form: Element,
      submitter?: Element | null,
      attempt?: boolean,
    ) =>
      nodeRef.current?.interactive?.reportValidity(
        form,
        submitter ?? null,
        attempt,
      ) ?? true,
    resetForm: (form: Element) => nodeRef.current?.interactive?.reset(form),
  };
}

// --- what happens to the document --------------------------------------------

/** The keys that scroll a document's scroll containers, and how: the
 *  axis, a line, a page or to the end, and which way (`scrollForKey`). */
const SCROLL_KEYS: Record<
  number,
  ['x' | 'y', 'line' | 'page' | 'end', 1 | -1]
> = {
  [XK_DOWN]: ['y', 'line', 1],
  [XK_UP]: ['y', 'line', -1],
  [XK_RIGHT]: ['x', 'line', 1],
  [XK_LEFT]: ['x', 'line', -1],
  [XK_PAGE_DOWN]: ['y', 'page', 1],
  [XK_PAGE_UP]: ['y', 'page', -1],
  [XK_SPACE]: ['y', 'page', 1],
  [XK_HOME]: ['y', 'end', -1],
  [XK_END]: ['y', 'end', 1],
};

/** What the handle reaches through `interactive`, as this render has it. */
interface Live {
  forms: ReturnType<typeof useForms>;
  stops: ReturnType<typeof useFocusStops>;
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
  onDownload?: HtmlDownloadHandler;
  drag: ReturnType<typeof useDocumentDrag>['external'];
}

/** The node core's window has focused, where the element is in a window. */
function focusedNode(view: HtmlViewNode | null): DrawnNode | null {
  // core's node has its window's event manager on its `root`, which its
  // declarations leave out
  const root = (view as unknown as { root?: unknown } | null)?.root as
    { events?: { focused?: DrawnNode | null } } | null | undefined;
  return root?.events?.focused ?? null;
}

/**
 * The element's `interactive`: what the handle asks of the widgets and the
 * focus, through `live`, which every render sets — so one object, made
 * once, answers from the render the handle is called after.
 */
function documentInteraction(
  view: React.RefObject<HtmlViewNode | null>,
  root: React.RefObject<DrawnNode | null>,
  live: React.RefObject<Live | null>,
): DocumentInteraction {
  /** The document's element a node takes the focus for. */
  const owner = (node: DrawnNode | null): Element | null => {
    const now = live.current;
    if (!node || !now) return null;
    return now.forms.controlOf(node) ?? now.stops.elementOf(node);
  };
  return {
    // Core's press goes to the nearest node that takes the focus, and what the
    // document draws has none under it but the surface. A browser leaves the
    // focus where it is when the nearest area that takes it around the press
    // has it, which a page's `mousedown` may just have done: a button that
    // focuses itself there lost the focus again as the handler returned. Told
    // a microtask later, a blur put right here is one the page never hears.
    pressLanded(at) {
      const now = live.current;
      const held = view.current?.focusedElement;
      if (!now || !held) return;
      for (let el = at; el; el = flatParentOf(el)) {
        if (el === held) {
          this.focus(el);
          return;
        }
        if (focusableElement(el)) break;
      }
      // and a focus owed to something else is not what the press wanted
      if (now.forms.owed()) now.forms.letGo();
    },
    controlValue: (el) => live.current?.forms.value(el) ?? null,
    setControlValue: (el, value) =>
      live.current?.forms.setValue(el, value) ?? false,
    controlSelection: (el) => live.current?.forms.selection(el) ?? null,
    setControlSelection: (el, selection) =>
      live.current?.forms.setSelection(el, selection) ?? false,
    showPicker: (el) => live.current?.forms.showPicker(el) ?? false,
    download: (request) => {
      const save = live.current?.onDownload;
      save?.(request);
      return !!save;
    },
    dragOver: (drop) => live.current?.drag.over(drop) ?? false,
    dragLeave: () => live.current?.drag.leave(),
    dropHere: (drop) => live.current?.drag.drop(drop) ?? Promise.resolve(false),
    pickFiles: (el) => live.current?.forms.pickFiles(el),
    setFiles: (el, files) => live.current?.forms.setFiles(el, files),
    focus: (el) => {
      const now = live.current;
      if (!now) return false;
      now.forms.scriptFocus(el);
      const took = now.forms.focusControl(el) || now.stops.focus(el);
      if (!took) now.forms.scriptFocus(null);
      // A modal dialog with nothing in it that takes the focus takes it
      // itself (HTML 4.11.4.2, the dialog focusing steps), where nothing of
      // the page around it may keep it: the document does, so the keys —
      // Escape, which closes the dialog — still reach it.
      if (!took && isModal(el) && root.current) {
        root.current.focus();
        // and what had it hears it go now, so that its getting it back
        // when the dialog closes, in the same task, is news to it
        now.forms.letGo();
        return true;
      }
      return took;
    },
    told: (el) => {
      const now = live.current;
      now?.forms.focused(el, true);
      now?.forms.owe(el);
      now?.stops.hold();
    },
    settleFocus: () => {
      const now = live.current;
      const el = now?.forms.owed();
      if (el) void (now!.forms.focusControl(el) || now!.stops.focus(el));
    },
    blur: () => {
      const forms = live.current?.forms;
      if (forms?.owed()) {
        forms.letGo();
        return;
      }
      const node = focusedNode(view.current);
      if (node && owner(node)) node.blur();
      // and the page hears it before `blur()` returns (HTML 6.6.4, the
      // unfocusing steps), where core's blur is told a microtask later for a
      // move between two fields: a `focus()` straight after it found the
      // element still holding the focus, and told nothing
      forms?.letGo();
    },
    activeElement: () =>
      live.current?.forms.owed() ?? owner(focusedNode(view.current)),
    activate: (el) => {
      const node = view.current;
      const now = live.current;
      if (!node || !now) return false;
      const href = node.hrefOf(el);
      if (href !== null) {
        now.onLink?.(
          href,
          syntheticClick(NO_MODIFIERS, node, root.current, el),
        );
        return true;
      }
      return now.forms.activate(el);
    },
    submit: (form, submitter) => live.current?.forms.submitNow(form, submitter),
    reportValidity: (form, submitter, attempt) =>
      live.current?.forms.validate(form, submitter, attempt) ?? true,
    reset: (form) => live.current?.forms.resetNow(form),
  };
}

/** The form controls a disabled one hears nothing at: no press reaches
 *  it, as none reaches one in a browser. */
const CONTROLS = new Set(['button', 'input', 'select', 'textarea']);

/** What a press on a control's widget ticks or presses: its click is the
 *  widget's to tell, after the box changes (`widgets.ts`). */
const CLICKS_ITSELF = new Set([
  'file',
  'checkbox',
  'radio',
  'submit',
  'reset',
  'button',
]);

/**
 * The document's pointer and key events, told to the host before anything
 * else does anything about them: the root's capture phase, which runs
 * before a widget's own handlers. A press's `mousedown`, cancelled, keeps
 * the press from focusing or selecting, as `preventDefault()` keeps it in
 * a browser, and a `keydown` keeps the key from the field it was typed in.
 * The `click` is the press and the release together, on the nearest
 * element both were on (UI Events 3.5), and `clicked` answers whether its
 * default — a link followed, a button pressed — goes on.
 */
function useDocumentEvents(
  onDomEvent: DomEventHandler | undefined,
  view: React.RefObject<HtmlViewNode | null>,
  forms: ReturnType<typeof useForms>,
  stops: ReturnType<typeof useFocusStops>,
  embedded: Embedded,
  readClipboard?: () => Promise<HtmlClipboardData>,
  movesHeard?: () => boolean,
) {
  const pressed = React.useRef<Element | null>(null);
  /** Where that press was, on what the document draws. */
  const pressPoint = React.useRef<{ x: number; y: number } | null>(null);
  const released = React.useRef<Element | null>(null);
  /** The element each button held was pressed on: a click needs its own
   *  press, whatever was pressed since. */
  const pressedBy = React.useRef(new Map<number, Element>());
  /** What core's count of a press has to be taken back by: it counts
   *  presses close together whichever button made them, and a click's count
   *  starts again with a button (UI Events 3.5). */
  const countFrom = React.useRef(0);
  const lastButton = React.useRef(0);
  /** The keys down, which a press of one again is the repeat of. */
  const keysDown = React.useRef(new Set<number>());
  /** Whether the press was on a scroll container's bar: no click, no
   *  link, no event of the page's comes of it. */
  const barPress = React.useRef(false);
  const fire = (
    type: HtmlDomEventType,
    target: Element,
    init?: DomEventInit,
  ): boolean => fireDomEvent(onDomEvent, type, target, init);

  /** The element a pointer event is on: the control whose widget it is in,
   *  or what the document draws under it. A disabled control hears none. */
  const pointedAt = (ev: X11MouseEvent<DrawnNode>): Element | null => {
    const node = view.current;
    const control = forms.controlOf(ev.target as DrawnNode);
    return (
      control ??
      (node && ev.target === (node as unknown)
        ? node.elementAtPoint(ev.x, ev.y)
        : null)
    );
  };
  const mouse = (ev: X11MouseEvent<DrawnNode>): DomEventInit => ({
    ...documentPoint(ev, view.current?.getClientRects()[0]),
    screenX: ev.screenX,
    screenY: ev.screenY,
    button: domButton(ev.button),
    detail: ev.detail === undefined ? undefined : ev.detail - countFrom.current,
    locks: domLocks(ev.nativeEvent?.buttons ?? 0),
    ...modifiersOf(ev),
  });
  /** What a move is told as: its point, and what ntk gathered since the last
   *  one it handed on. Its samples are device pixels from the window's
   *  corner, and the event's logical pixels. */
  const moved = (ev: X11MouseEvent<DrawnNode>): DomEventInit => {
    const init: DomEventInit = {
      ...mouse(ev),
      button: 0,
      detail: 0,
      buttons: domButtons(ev.nativeEvent?.buttons ?? 0),
    };
    const native = ev.nativeEvent as
      | {
          x?: number;
          y?: number;
          time?: number;
          coalesced?: { x: number; y: number; time?: number }[];
        }
      | undefined;
    const list = native?.coalesced;
    if (list && list.length > 1) {
      const scale = (ev.target as DrawnNode | null)?.scale ?? 1;
      const by = {
        x: (init.x ?? 0) - ev.x,
        y: (init.y ?? 0) - ev.y,
      };
      const now = native.time ?? 0;
      init.samples = list.map((sample) => [
        sample.x / scale + by.x,
        sample.y / scale + by.y,
        Math.max(0, now - (sample.time ?? now)),
      ]);
    }
    return init;
  };
  /** The element a pointer's event that hit nothing goes to: a button held
   *  past the document's edge goes on being told, at the root, where a
   *  browser's does. */
  const offDocument = (): Element | null => {
    const doc = view.current?.document;
    return doc ? rootElementOf(doc) : null;
  };
  /** What a key is typed at: a control's widget, a stop's element, the
   *  element a focus is owed to (`stops.ts`), or the document's body where
   *  the document itself has the focus. */
  const keyedAt = (target: DrawnNode): Element | null => {
    const node = view.current;
    if (!node) return null;
    const owner = forms.controlOf(target) ?? stops.elementOf(target);
    if (owner) return owner;
    return node.document ? bodyOf(node.document) : null;
  };
  const key =
    (type: 'keydown' | 'keyup') => (ev: X11KeyboardEvent<DrawnNode>) => {
      // a key a composition takes is the composition's, which types its text
      if (!onDomEvent || ev.composing) return;
      // a key typed in an `<iframe>`'s document is that document's: the
      // embedding page neither hears it nor can cancel it
      if (embedded.contains(ev.target as DrawnNode)) return;
      const target = keyedAt(ev.target as DrawnNode);
      if (!target) return;
      const names = domKey(ev);
      const native = ev.nativeEvent as
        { keycode?: number; buttons?: number; repeat?: boolean } | undefined;
      const keycode = native?.keycode ?? ev.keysym ?? 0;
      const repeat =
        type === 'keydown' && (native?.repeat ?? keysDown.current.has(keycode));
      if (type === 'keydown') keysDown.current.add(keycode);
      else keysDown.current.delete(keycode);
      const go = fire(type, target, {
        key: names.key,
        code: names.code,
        repeat,
        locks: domLocks(native?.buttons ?? 0),
        ...modifiersOfKey(modifiersOf(ev), names.key, type === 'keydown'),
      });
      if (!go) ev.preventDefault();
    };
  const keyDown = key('keydown');
  /** What a composition is at, told as a key is: where the focus is. */
  const composition =
    (type: 'compositionstart' | 'compositionupdate' | 'compositionend') =>
    (ev: X11KeyboardEvent<DrawnNode> & { data?: string }) => {
      if (!onDomEvent || embedded.contains(ev.target as DrawnNode)) return;
      const target = keyedAt(ev.target as DrawnNode);
      if (target) fire(type, target, { data: ev.data });
    };
  /** The key just told, where it is the clipboard's chord and the page let
   *  it be: told as what it is, before core's own copy, cut or paste. An
   *  event is told at once and a read of the clipboard is not, so with a
   *  clipboard to read, a paste stops core's and is the page's to make. */
  const clipboardKey = (ev: X11KeyboardEvent<DrawnNode>) => {
    if (!onDomEvent || ev.defaultPrevented || ev.composing) return;
    if (embedded.contains(ev.target as DrawnNode)) return;
    const type = clipboardChord(ev, view.current?.app);
    const target = type && keyedAt(ev.target as DrawnNode);
    if (!type || !target) return;
    if (type === 'paste' && readClipboard) {
      ev.preventDefault();
      const told = (clipboard: HtmlClipboardData) => {
        if (view.current) fire('paste', target, { clipboard });
      };
      readClipboard().then(told, () => told({}));
      return;
    }
    if (!fire(type, target, modifiersOf(ev))) ev.preventDefault();
  };
  return {
    onMouseDownCapture: (ev: X11MouseEvent<DrawnNode>) => {
      forms.userInput('pointer');
      pressed.current = null;
      // a press on a scroll container's bar is the bar's (`defaultMouseDown`)
      const node = view.current;
      if (
        node &&
        ev.target === (node as unknown) &&
        node.scrollBarAt(ev.x, ev.y)
      ) {
        barPress.current = true;
        return;
      }
      barPress.current = false;
      if (!onDomEvent) return;
      const target = pointedAt(ev);
      if (!target) return;
      pressed.current = target;
      pressPoint.current =
        ev.target === (node as unknown) ? { x: ev.x, y: ev.y } : null;
      pressedBy.current.set(ev.button, target);
      if (ev.button !== lastButton.current) countFrom.current = ev.detail - 1;
      else if (ev.detail === 1) countFrom.current = 0;
      lastButton.current = ev.button;
      // a press on what the document draws holds the pointer until its
      // release, wherever that is: a stroke dragged off the window ends
      if (ev.target === (node as unknown)) ev.capturePointer?.();
      if (!fire('mousedown', target, mouse(ev))) {
        ev.preventDefault();
        return;
      }
      // the press's selection starts here (Chromium's
      // `DispatchSelectStart`), and a page that says no has its press go on
      // as a press and its text stay as it was
      if (
        ev.button === 1 &&
        ev.target === (node as unknown) &&
        node?.startsSelectionAt(ev.x, ev.y) &&
        !fire('selectstart', target, modifiersOf(ev))
      ) {
        node.selectsNothing();
      }
    },
    // the menu a secondary press asks for, which X11 and macOS ask on the
    // press: an event of its own in core, after it, and the page's to keep
    // from opening
    onContextMenuCapture: (ev: X11MouseEvent<DrawnNode>) => {
      if (!onDomEvent) return;
      const target = pressed.current ?? pointedAt(ev);
      if (target && !fire('contextmenu', target, mouse(ev))) {
        ev.preventDefault();
      }
    },
    onMouseUpCapture: (ev: X11MouseEvent<DrawnNode>) => {
      released.current = null;
      if (barPress.current) return;
      if (!onDomEvent) return;
      const target = pointedAt(ev) ?? (pressed.current && offDocument());
      if (!target) return;
      released.current = target;
      // nothing to keep from happening: a cancelled release still clicks
      fire('mouseup', target, mouse(ev));
    },
    onKeyDownCapture: (ev: X11KeyboardEvent<DrawnNode>) => {
      view.current?.noteInput();
      if (embedded.contains(ev.target as DrawnNode)) return;
      // a modifier alone, or a chord, is no move through the document:
      // Ctrl+C after a click leaves a script's focus without its ring
      if (!(ev.ctrlKey || ev.altKey || ev.metaKey || isModifierKey(ev))) {
        forms.userInput('keyboard');
      }
      keyDown(ev);
      clipboardKey(ev);
    },
    onKeyUpCapture: key('keyup'),
    onCompositionStartCapture: composition('compositionstart'),
    onCompositionUpdateCapture: composition('compositionupdate'),
    onCompositionEndCapture: composition('compositionend'),
    onMouseMoveCapture: (ev: X11MouseEvent<DrawnNode>) => {
      const node = view.current;
      node?.notePointer(ev.x, ev.y);
      // over a control's widget, or a frame's mount, the pointer is over its
      // element, which the document hovers with all around it: the node
      // hears only the moves over what it draws (`pointerBeside`)
      if (node && ev.target !== (node as unknown)) {
        const target = ev.target as DrawnNode;
        node.pointerBeside(
          ev.x,
          ev.y,
          forms.controlOf(target) ?? embedded.elementOf(target),
        );
      }
      // a move nothing listens for costs the hit test nothing, and lays
      // nothing out: `elementAtPoint` settles what is owed
      if (!onDomEvent || movesHeard?.() === false) return;
      // the pointer over a frame is over the frame's element, to the page
      // that holds it, and its moves are the frame's own
      const frame = embedded.elementOf(ev.target as DrawnNode);
      if (frame) {
        fire('mouseover', frame, mouse(ev));
        return;
      }
      const target = pointedAt(ev) ?? (pressed.current && offDocument());
      if (!target) return;
      fire('mousemove', target, moved(ev));
    },
    onMouseLeave: (ev: X11MouseEvent<DrawnNode>) => {
      view.current?.notePointer(null);
      view.current?.pointerLeft();
      if (!onDomEvent || movesHeard?.() === false) return;
      const at = offDocument();
      if (at) fire('mouseleave', at, mouse(ev));
    },
    onWheelCapture: (ev: X11WheelEvent<DrawnNode>) => {
      // where it turned, for the scroll container under it to take it
      // (`canScroll`), where it turned over what the document draws
      view.current?.wheelAt(
        ev.target === (view.current as unknown) ? { x: ev.x, y: ev.y } : null,
      );
      if (!onDomEvent) return;
      const target = pointedAt(ev as unknown as X11MouseEvent<DrawnNode>);
      if (!target) return;
      // a page that takes the wheel for itself keeps the pane from
      // scrolling with it, as a canvas does
      const go = fire('wheel', target, {
        ...documentPoint(ev, view.current?.getClientRects()[0]),
        ...modifiersOf(ev as unknown as Partial<X11MouseEvent<DrawnNode>>),
        deltaX: ev.deltaX,
        deltaY: ev.deltaY,
      });
      if (!go) ev.preventDefault();
    },
    /** Whether the press now under way is a scroll bar's. */
    onBar: () => barPress.current,
    /** The element the press now under way was on. */
    pressedElement: () => pressed.current,
    pressPoint: () => (pressed.current ? pressPoint.current : null),
    clicked: (ev: X11MouseEvent<DrawnNode>): boolean => {
      const down = pressedBy.current.get(ev.button);
      const up = released.current;
      pressedBy.current.delete(ev.button);
      if (pressed.current === down) pressed.current = null;
      released.current = null;
      if (!onDomEvent || !down || !up) return true;
      const target = sharedAncestor(down, up);
      if (!target) return true;
      // a disabled control hears no click (HTML 4.10.18.5)
      if (CONTROLS.has(tagOf(target)) && isDisabled(target)) return true;
      // the others' click is a click of no default (UI Events 3.5)
      if (ev.button !== 1) {
        fire('auxclick', target, mouse(ev));
        return true;
      }
      // a checkbox's, a radio's and a button's widget tell their own click
      // as they tick or press (`widgets.ts`)
      if (
        tagOf(target) === 'input' &&
        CLICKS_ITSELF.has(inputType(target)) &&
        forms.controlOf(ev.target as DrawnNode)
      ) {
        return true;
      }
      const init = mouse(ev);
      const go = fire('click', target, init);
      if (init.detail === 2) fire('dblclick', target, init);
      return go;
    },
  };
}

/** The link an element is in, or null. */
/** An address's origin, `null` for one that has none. */
function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

/** Whether a font is the document's own to have with no CORS: what no network
 *  answers, one of its own origin, and a `file:` page's own files, as before. */
function ownFont(url: string, origin: string, base?: string | null): boolean {
  if (/^(?:data|blob):/i.test(url)) return true;
  if (origin !== 'null') return originOfUrl(url) === origin;
  return /^file:/i.test(url) && /^file:/i.test(base ?? '');
}

function linkAround(el: Element | null | undefined): Element | null {
  for (let at = el ?? null; at; at = flatParentOf(at)) {
    if (tagOf(at) === 'a' || tagOf(at) === 'area') return at;
  }
  return null;
}

declare const URL: new (url: string) => { origin: string };

/** Whether an address is of a document's origin, or is one a page made: what
 *  a link's `download` counts on (HTML 4.6.5). */
function sameOriginAs(href: string, base: string | null | undefined): boolean {
  if (/^(?:blob|data):/i.test(href)) return true;
  try {
    return new URL(href).origin === new URL(base ?? '').origin;
  } catch {
    return false;
  }
}

/** The nearest element two are both in, themselves included. */
function sharedAncestor(a: Element, b: Element): Element | null {
  const around = new Set<Element>();
  for (let at: Element | null = a; at; at = flatParentOf(at)) around.add(at);
  for (let at: Element | null = b; at; at = flatParentOf(at)) {
    if (around.has(at)) return at;
  }
  return null;
}

/** The document's first element. */
function rootElementOf(doc: Document): Element | null {
  for (const child of doc.children) if (isElement(child)) return child;
  return null;
}

/** The document's `<body>`, or its first element where it has none: what a
 *  key typed with the document itself focused is typed at, as
 *  `document.activeElement` is the body then. */
function bodyOf(doc: Document): Element | null {
  let first: Element | null = null;
  for (const child of doc.children) {
    if (!isElement(child)) continue;
    first ??= child;
    if (tagOf(child) !== 'html') continue;
    for (const inner of child.children) {
      if (isElement(inner) && tagOf(inner) === 'body') return inner;
    }
    return child;
  }
  return first;
}

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      htmlview: HtmlViewProps & {
        key?: string | number;
        ref?: React.Ref<unknown>;
      };
    }
  }
}
