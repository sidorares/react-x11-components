// `<Html scripts>`: what turns a document's scripts on with one prop. The
// engine is the example browser's — a `node:vm` context a document over the
// DOM `<Html>` draws (`./runner.ts`) — and this is the wiring the browser
// did by hand, with a default for every seam it filled in:
//
//   - **What is fetched stays the host's.** A `<script src>` and the modules
//     a script imports are asked for through `onResource`, as `kind:
//     'script'`, beside the document's images and sheets; a page's own
//     `fetch`, `XMLHttpRequest`, a frame's document and a worker's script go
//     through `scripts.fetch`, and with none they fail as a request with no
//     network does. `useHtmlNetwork` is both, from one line.
//   - **Where the page is shown is read from where it is.** The viewport a
//     page measures, scrolls and hears `scroll` from is the scroll pane
//     around the element — the host's — and its zoom is the `scale` between
//     the two, as the browser's was its own pane and its own zoom.
//   - **What leaves the document is handed back.** `location`, `open`,
//     `history.go`, the title and the console go to seams that do nothing
//     by default, since a component navigates nowhere by itself; a link or
//     a form whose target names one of the page's frames loads it there,
//     and every other one still goes to `onLink` and `onSubmit`.
//   - **Frames and workers are on**, each a seam's flag away from off.
//
// Light on purpose: `<Html>` imports it whether or not a document turns
// scripts on, and the engine is loaded only once one does (`./hook.ts`).
import React, { useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';

import type {
  Document,
  Element,
  EmbeddedRect,
  FormSubmission,
  HtmlDomEvent,
  HtmlHandle,
  HtmlProps,
  ResourceRequest,
  ResourceResult,
  ScriptRequest,
} from '../index.js';
import { fireDomEvent } from '../dom-events.js';
import { HTML_USER_AGENT } from '../network.js';
import { NO_MEDIA_DEVICES } from '../media-devices.js';
import type { HtmlMediaDevices } from '../media-devices.js';
import type { HtmlWebGL } from '../webgl.js';
import { NO_WEBRTC } from '../rtc.js';
import type { HtmlWebRTC } from '../rtc.js';
import { NO_WEBTRANSPORT } from '../transport.js';
import type { HtmlWebTransport } from '../transport.js';
import { NO_WEBSOCKET } from '../socket.js';
import type { HtmlWebSocket } from '../socket.js';
import type { HtmlClipboard, HtmlClipboardData } from '../clipboard.js';
import type { HtmlNotifications } from '../notifications.js';
import type { HtmlPermissions } from '../permissions.js';
import type { HtmlDocumentCookies } from '../cookies.js';
import type { HtmlStorage } from '../storage.js';
import type { CssEventInfo } from '../node.js';
import type { MediaEventHandler } from '../media.js';
import { useScripts } from './hook.js';
import type { FetchRequest, FetchResponse } from './host.js';
import type { AbortSignalLike } from './platform.js';
import type { ScriptsOptions } from './runner.js';
import type { FrameContext } from './frames.js';
import type { HtmlSessionHistory } from './session.js';
import { linkTarget, navigableFor } from './target.js';

const h = React.createElement;

/** The pane a document is shown in, as its scripts measure it: its size
 *  and its scroll in CSS pixels, the zoom between those and the window's
 *  logical pixels, the device's pixels to a CSS pixel, and where its top
 *  left is in the window, in logical pixels. */
export interface ScriptViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  zoom: number;
  dpr: number;
  left: number;
  top: number;
}

/**
 * What a document's scripts may reach outside it, for `<Html scripts>`.
 * Every field has a default; the ones left out are the reasonable thing
 * for a component that shows a page, and an application that is a browser
 * fills them in.
 */
export interface HtmlScripts {
  /**
   * A page's `fetch` and `XMLHttpRequest`, a frame's document, a worker's
   * script — a request, any method, and the response whatever its status.
   * The engine keeps a page to what its origin and CORS let it read before
   * it asks. Default: none, and every such request fails as one with no
   * network does. `useHtmlNetwork(url).fetch` is one.
   */
  fetch?: (
    request: FetchRequest,
    signal: AbortSignalLike,
  ) => Promise<FetchResponse>;
  /**
   * A script's source by its URL: a `<script src>`'s, with its element, and
   * a module's an import names. Default: asked of `onResource` as `kind:
   * 'script'`, the text or the bytes it answers decoded.
   */
  load?: (url: string, element: Element | null) => Promise<string | null>;
  /** The page asked to go somewhere: an address assigned to `location`,
   *  `location.replace`, or `window.open` (`'tab'`). Default: nowhere. */
  navigate?: (url: string, how: 'here' | 'replace' | 'tab') => void;
  /** `location.reload()`. Default: nothing. */
  reload?: () => void;
  /** `history.go`, `back` and `forward`, past the page's own
   *  `pushState` steps — or, with a `session`, to an entry of another
   *  document's, `delta` entries from the current one, which the host
   *  shows: `session.go(delta)` answers which. Default: nothing. */
  go?: (delta: number) => void;
  /**
   * The session history the document is shown in, across the documents
   * the host shows here (HTML 7.4.1): one `HtmlSessionHistory` for each
   * place the host shows pages — a tab — handed to every document shown
   * there. With it, each document the host shows is the next of the
   * history — a push, or what the page asked for: a replace, a reload, a
   * step back or forward — and a page's `history.length`,
   * `navigation.entries()`, `back()`, `forward()` and `traverseTo()`
   * reach the documents' entries before and after it; it hears how it was
   * shown (`navigation.activation`), and the document it replaces hears
   * where it goes (`pageswap`). The host draws its address bar and its
   * Back and Forward from it as it changes (`session.onChange`), and shows
   * it the documents it runs no scripts in (`session.show`). Default:
   * none, and each document's history is its own.
   */
  session?: HtmlSessionHistory;
  /**
   * A page being left — a link, a form, `location`, `history`, or the
   * handle's `beforeUnload` — asked to be confirmed first: its
   * `beforeunload` was canceled or given a `returnValue`, after the user
   * pressed or typed in it (HTML 7.4.2.4, "prompt to unload"). Answers
   * whether to leave it. Default: it is left, as a browser with no one to
   * ask leaves it.
   */
  promptToUnload?: () => boolean;
  /** `document.title` was set. Default: nothing. */
  title?: (title: string | null) => void;
  /** What the page writes to its console, and what the engine says went
   *  wrong — an uncaught error, a script that failed to load. Default:
   *  nowhere. */
  log?: (level: string, text: string) => void;
  /** How long a script's own code may run in a task — a script, a
   *  listener, a timer — in milliseconds, the time `<Html>` takes over a
   *  style or a layout it asks for not counted: what it asks after that
   *  throws a `TimeoutError`, and the task is stopped outright at five
   *  times it, whatever it asks. Default 2000. */
  timeout?: number;
  /** A script ran past `timeout` and was stopped. Default: nothing. */
  onTimeout?: () => void;
  /** `navigator.userAgent`. Default `HTML_USER_AGENT`, which
   *  `HtmlNetwork` sends. `navigator.platform` is the one it names, as a
   *  browser's two agree: `MacIntel` for a Mac's, `Win32` for Windows',
   *  and `Linux x86_64` where it names neither. */
  userAgent?: string;
  /** `navigator.language`. Default the runtime's locale. */
  language?: string;
  /** What a media element's `canPlayType` answers for a MIME type: whether
   *  what plays a `<video>` — `onResource`'s `kind: 'video'` — can play
   *  it. Default none, `''` for every type, as the page has no player
   *  until its host gives it one. `canPlayMedia` answers for the
   *  platform's player, where `useSupports('mediaPlayback')` says there is
   *  one. */
  canPlayType?: (type: string) => '' | 'maybe' | 'probably';
  /**
   * Whether a frame's document is loaded, drawn over its box and run in a
   * realm of its own, linked to the page's — `parent`, `contentWindow`,
   * `postMessage`. Default true. Off, a frame is a box `renderEmbedded`
   * fills, as it is with scripts off.
   */
  frames?: boolean;
  /** Whether the page may start dedicated workers, each a thread of its
   *  own. Default true. */
  workers?: boolean;
  /**
   * What a page's `WebTransport` sessions are carried over: a session's
   * QUIC connection and HTTP/3 CONNECT, its datagrams and its streams'
   * bytes (`HtmlWebTransport`). Default: none, and every session fails,
   * as one a browser with no network opens. `useHtmlNetwork(url)` hands
   * one, over the optional peer `quico` where it is installed.
   */
  webTransport?: HtmlWebTransport;
  /**
   * What a page's `WebSocket`s are carried over: a connection's opening
   * handshake, its messages and how it closed (`HtmlWebSocket`). Default:
   * none, and every socket fails, as one a browser with no network opens.
   * `useHtmlNetwork(url)` hands one, over the runtime's own `WebSocket`
   * (Node 22 and later, and Bun). A socket is held to the document's
   * `connect-src`, and a secure page's `ws:` one is refused, before this
   * is asked.
   */
  webSocket?: HtmlWebSocket;
  /**
   * The clipboard a page's `copy`, `cut`, `paste` and `navigator.clipboard`
   * reach (`HtmlClipboard`). Default: none, so a `copy` a page cancels puts
   * nothing anywhere, a `paste` is told empty, and `navigator.clipboard` is
   * not there; the user's own copy and paste, in a field and of a selection,
   * are core's and work either way. `useHtmlClipboard()` is the machine's.
   */
  clipboard?: HtmlClipboard;
  /**
   * What a page's `Notification`s reach (`HtmlNotifications`). Default: none,
   * so `Notification.permission` is `denied` and one a page makes fires
   * `error`. `useHtmlNotifications()` is the desktop's. A host that hands one
   * and no `permissions` has decided, and a page is `granted`.
   */
  notifications?: HtmlNotifications;
  /**
   * What a page has been allowed (`HtmlPermissions`): what
   * `navigator.permissions.query()` and `Notification.permission` answer,
   * and what guards a page's read of the clipboard. Default: nothing has,
   * and asking refuses.
   */
  permissions?: HtmlPermissions;
  /**
   * What a page's `RTCPeerConnection`s are carried over: an offer and an
   * answer made, a description applied, candidates, transports, data
   * channels and the media a receiver receives (`HtmlWebRTC`). Default:
   * none, and every operation that needs a stack rejects. The page's
   * `RTCPeerConnection` is not built yet, so nothing reads it until it is
   * (docs/prd-webrtc.md).
   */
  webRTC?: HtmlWebRTC;
  /**
   * The cameras, microphones and screens a page's `navigator.mediaDevices`
   * lists and opens (`HtmlMediaDevices`). Default: none, as on a machine
   * with no camera and no microphone. `fakeMediaDevices()` is a camera, a
   * microphone and a screen that draw a test pattern and play a tone.
   * Nothing in the page reads it until its `MediaStream` is built
   * (docs/prd-webrtc.md).
   */
  mediaDevices?: HtmlMediaDevices;
  /**
   * What a page's WebGL contexts draw through. Default none: a context keeps
   * the state a page sets and reads back, and draws nothing. `gpuWebGL()` is
   * one, x11-dri's GL with no window behind it. It hands a page's shaders to
   * the driver as they are written, with none of the validation a browser's
   * WebGL has: see `src/html/webgl.ts`.
   */
  webgl?: HtmlWebGL;
  /**
   * Whether a page may register service workers (`navigator.serviceWorker`,
   * Service Workers 1), each a worker thread with its lifecycle and its
   * messages, where the page is a secure context. They intercept none of
   * the page's requests and keep no `caches`, so a site that registers one
   * to work offline or to be pushed to finds less than it expects: off by
   * default, and `navigator.serviceWorker` is then not there at all, which
   * is what such a site checks for. Default false.
   */
  serviceWorkers?: boolean;
  /**
   * What `document.cookie`, `navigator.cookieEnabled` and `cookieStore`
   * read and write: a `CookieJar`, the one a network sends its requests
   * through (`useHtmlNetwork(url).cookies`), so that a cookie a script sets
   * goes on the next request. Default: none, and a document has no cookies,
   * as with no network.
   */
  cookies?: HtmlDocumentCookies;
  /**
   * Where `localStorage`, `sessionStorage` and IndexedDB are kept
   * (`HtmlStorage`). Default: memory — an origin's items for as long as the
   * process, a database for as long as the document. `HtmlProfile`'s
   * `storage` keeps all three on disk, shared by every process that opens
   * the profile.
   */
  storage?: HtmlStorage;
  /** Where the page is shown, as its scripts measure it. Default: the
   *  scroll pane around `<Html>`, or `<Html>` itself where none is. */
  viewport?: () => ScriptViewport;
  /** `window.scrollTo`, in CSS pixels. Default: the scroll pane around
   *  `<Html>`. */
  scrollTo?: (x: number, y: number) => void;
  /** Whether a key the page hears is the host's own chord, which no
   *  listener of the page's may keep from it. Default: none is. */
  reserved?: (event: HtmlDomEvent) => boolean;
}

/** `<Html>`'s props as the element takes them: the public ones, and what
 *  `useScriptedHtml` adds that no application passes. */
/**
 * What a host's console got back for what it typed (`HtmlHandle.evaluate`):
 * the value it came to, or what it threw, written out in the page's realm
 * as its `console.log` writes a value — a string is quoted, an element is
 * its tag.
 */
export interface ConsoleResult {
  text: string;
  /** It threw, and `text` is the error. */
  threw: boolean;
  /** What it came to, where it did not throw: a description a console can
   *  draw an object as a tree from (`HtmlHandle.inspectValue`). */
  value?: ConsoleValue;
}

/**
 * A value of the page's as a console is handed it: its type —
 * `string`, `number`, `boolean`, `undefined`, `null`, `bigint`, `symbol`,
 * `function`, `object`, `array`, `node`, `error`, and for a property
 * `accessor` — and a line of text, written as `console.log` writes it. An
 * object, an array or a function also has the `id` the page's realm keeps
 * it by, which `inspectValue` reads a level of.
 */
export interface ConsoleValue {
  type: string;
  text: string;
  id?: number;
}

/** One of an object's properties, as `inspectValue` hands them: a getter
 *  is not read, and is an `accessor`. */
export interface ConsoleProperty {
  name: string;
  value: ConsoleValue;
  enumerable: boolean;
}

export interface InternalHtmlProps extends HtmlProps {
  /** Mounted inside `<Html>`'s root, after the document: the frames the
   *  page lays out no box for (`FrameHolder`). */
  _frames?: ReactNode;
  /** What is on the clipboard, read for a `paste` where the host handed a
   *  clipboard: the paste is then the page's, and the widget's stopped. */
  _readClipboard?: () => Promise<HtmlClipboardData>;
  /** The pane around the element scrolled (`HtmlViewProps`). */
  _onViewportScroll?: () => void;
  /** The element painted (`HtmlViewProps`). */
  _onPaint?: () => void;
  /** The CSS transition events the document owes (`HtmlViewProps`). */
  _onCssEvents?: (events: CssEventInfo[]) => void;
  /** What an `<img>` came to (`HtmlViewProps`). */
  _onImage?: (element: Element, outcome: 'load' | 'error') => void;
  /** What a player with no picture said, for the page that played it
   *  (`HtmlViewProps.onMediaEvent`). */
  _onMediaEvent?: MediaEventHandler;
  /** Whether the document may be left, as its scripts answer: what the
   *  handle's `beforeUnload` asks. */
  _unloadCheck?: () => boolean;
  /** What a host's console typed, run in the document's realm: what the
   *  handle's `evaluate` asks. */
  _evaluate?: (code: string) => ConsoleResult | null;
  /** A level of a value it kept, and every value let go: the handle's
   *  `inspectValue` and `releaseValues`. */
  _inspectValue?: (id: number) => ConsoleProperty[] | null;
  _releaseValues?: () => void;
  /** The parse waits at a script that blocks it, which the engine runs
   *  (`HtmlViewProps.onParserBlocked`): given, the parse yields to the
   *  page's scripts. */
  _onParserBlocked?: (script: Element) => void;
}

/** What the element `<Html>` draws with is, for the defaults: a node of
 *  core's, read through the members every node has. */
interface PaneNode {
  parent: PaneNode | null;
  scale: number;
  scrollX?: number;
  scrollY?: number;
  isScroller?: () => boolean;
  scrollTo?: (to: { x?: number; y?: number }) => void;
  getClientRects(): { x: number; y: number; width: number; height: number }[];
}

/** The scroll pane around a node, and the window it is in. */
function surroundings(node: PaneNode | null): {
  pane: PaneNode | null;
  top: PaneNode | null;
} {
  let pane: PaneNode | null = null;
  let top: PaneNode | null = node;
  for (let at = node?.parent ?? null; at; at = at.parent) {
    if (!pane && at.isScroller?.()) pane = at;
    top = at;
  }
  return { pane, top };
}

/** The default viewport: the scroll pane around the element, in the zoom
 *  the element is drawn at — core's `scale` between the two. A pane's
 *  offsets are device pixels, as core keeps them, where its client rect is
 *  logical, so they are the element's device pixels too and `dpr` of them
 *  are a CSS pixel: divided by the zoom alone, a page at 2x read a
 *  `scrollY` twice the pane's, and every `getBoundingClientRect` on a
 *  scrolled page was off by the scroll. */
function viewportOf(node: PaneNode | null): ScriptViewport {
  const { pane, top } = surroundings(node);
  const dpr = node?.scale || 1;
  const zoom = dpr / ((pane ?? top)?.scale || dpr);
  const box = (pane ?? node)?.getClientRects()[0];
  return {
    width: (box?.width ?? 0) / zoom,
    height: (box?.height ?? 0) / zoom,
    scrollX: (pane?.scrollX ?? 0) / dpr,
    scrollY: (pane?.scrollY ?? 0) / dpr,
    zoom,
    dpr,
    left: box?.x ?? 0,
    top: box?.y ?? 0,
  };
}

/** The runtime's locale, as a language tag. */
function runtimeLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}

/** A script's text from what `onResource` answered. */
function scriptText(result: unknown): string | null {
  const r = result as
    | { kind?: string; text?: string; bytes?: Uint8Array; charset?: string }
    | null
    | undefined;
  if (!r || r.kind !== 'script') return null;
  if (typeof r.text === 'string') return r.text;
  if (!r.bytes) return null;
  const Decoder = (
    globalThis as {
      TextDecoder?: new (label?: string) => {
        decode(bytes: Uint8Array): string;
      };
    }
  ).TextDecoder;
  if (!Decoder) return null;
  try {
    return new Decoder(r.charset ?? 'utf-8').decode(r.bytes);
  } catch {
    return new Decoder('utf-8').decode(r.bytes);
  }
}

/** A request no network answers: the default `fetch`. */
const NO_NETWORK = (request: FetchRequest): Promise<FetchResponse> =>
  Promise.reject(
    new Error(
      `${request.url} was not fetched: this <Html> has no scripts.fetch.`,
    ),
  );

const nothing = (): void => {};

/**
 * `<Html>`'s props with its document's scripts running: the engine's
 * seams, with the application's own callbacks still called beside them,
 * and the frames to mount after the document.
 */
export function useScriptedHtml(
  props: HtmlProps,
  handle: HtmlHandle & { ref: React.Ref<unknown> },
): InternalHtmlProps {
  const config: HtmlScripts =
    typeof props.scripts === 'object' && props.scripts ? props.scripts : {};
  const latest = useRef({ props, config });
  latest.current = { props, config };
  const node = (): PaneNode | null =>
    (handle.ref as React.RefObject<PaneNode | null>).current;

  const frames = config.frames ?? true;
  const options: ScriptsOptions = {
    userAgent: config.userAgent ?? HTML_USER_AGENT,
    language: config.language ?? runtimeLanguage(),
    canPlayType: config.canPlayType,
    viewport: config.viewport ?? (() => viewportOf(node())),
    scrollTo:
      config.scrollTo ??
      ((x, y) => {
        const { zoom } = viewportOf(node());
        surroundings(node()).pane?.scrollTo?.({ x: x * zoom, y: y * zoom });
      }),
    navigate: config.navigate ?? nothing,
    reload: config.reload ?? nothing,
    go: config.go ?? nothing,
    promptToUnload: config.promptToUnload,
    session: config.session ?? null,
    log: config.log ?? nothing,
    title: config.title ?? nothing,
    fetch: config.fetch ?? NO_NETWORK,
    network: config.fetch !== undefined,
    load:
      config.load ??
      (async (url, element) => {
        const ask = latest.current.props.onResource;
        const owner = element ?? rootElement(handle.document);
        if (!ask || !owner) return null;
        return scriptText(await ask({ url, kind: 'script', element: owner }));
      }),
    onTimeout: config.onTimeout ?? nothing,
    reserved: config.reserved,
    timeout: config.timeout,
    workers: config.workers ?? true,
    serviceWorkers: config.serviceWorkers ?? false,
    webTransport: config.webTransport ?? NO_WEBTRANSPORT,
    webSocket: config.webSocket ?? NO_WEBSOCKET,
    clipboard: config.clipboard,
    notifications: config.notifications,
    permissions: config.permissions,
    webRTC: config.webRTC ?? NO_WEBRTC,
    mediaDevices: config.mediaDevices ?? NO_MEDIA_DEVICES,
    webgl: config.webgl,
    cookies: config.cookies,
    storage: config.storage,
    drawsFrames: frames,
  };
  const url = props.baseUrl ?? 'about:blank';
  const scripts = useScripts(true, handle, url, options);

  // What a frame of the page is drawn with: the page's look, and its
  // resources. Asked as each is mounted (`embeddedMounts`).
  const frameContext = (): FrameContext | null => {
    const runner = scripts.runner?.();
    if (!runner || !frames) return null;
    const p = latest.current.props;
    return {
      parent: runner,
      seams: options,
      look: {
        onResource: p.onResource,
        fontSize: p.fontSize,
        fontFamily: p.fontFamily,
        monoFamily: p.monoFamily,
        defaultColorScheme: p.defaultColorScheme,
        animate: p.animate,
        reducedMotion: p.reducedMotion,
        selectionColor: p.selectionColor,
        onPickFiles: p.onPickFiles,
      },
    };
  };
  const contextNow = useRef(frameContext);
  contextNow.current = frameContext;
  const engine = scripts.runtime ?? null;
  const holderContext = engine ? frameContext() : null;
  const mounts = useMemo(
    () => engine?.embeddedMounts(() => contextNow.current()) ?? null,
    [engine],
  );
  const renderEmbedded = useCallback(
    (rect: EmbeddedRect) =>
      latest.current.props.renderEmbedded?.(rect) ?? mounts?.(rect) ?? null,
    [mounts],
  );

  // whether the document may be left, which its runner asks it
  const unloadCheck = useCallback(
    () => scripts.runner?.()?.beforeUnload() ?? true,
    [scripts.runner],
  );
  // and what a host's console typed, run there
  const evaluate = useCallback(
    (code: string) => scripts.runner?.()?.evaluate(code) ?? null,
    [scripts.runner],
  );
  const inspectValue = useCallback(
    (id: number) => scripts.runner?.()?.inspectValue(id) ?? null,
    [scripts.runner],
  );
  const releaseValues = useCallback(
    () => scripts.runner?.()?.releaseValues(),
    [scripts.runner],
  );

  // a link or a form whose target names one of the page's frames loads it
  // there; anything else is the application's, as it is with scripts off
  const onLink = useCallback(
    (href: string, ev: X11MouseEvent<DrawnNode>) => {
      const document = handle.document;
      let link = handle.elementAt(ev.x, ev.y);
      while (link && link.name !== 'a' && link.name !== 'area') {
        link = link.parent?.type === 'tag' ? (link.parent as Element) : null;
      }
      const to = navigableFor(document, linkTarget(link, document));
      if (typeof to !== 'string' && scripts.navigateFrame) {
        scripts.navigateFrame(to, href, null);
        return;
      }
      latest.current.props.onLink?.(href, ev);
    },
    [scripts.navigateFrame],
  );
  const onSubmit = useCallback(
    (submission: FormSubmission) => {
      const to = navigableFor(handle.document, submission.target);
      if (typeof to !== 'string' && scripts.navigateFrame) {
        scripts.navigateFrame(
          to,
          submission.url,
          submission.method === 'post'
            ? {
                body: submission.body ?? '',
                contentType: submission.contentType ?? '',
              }
            : null,
        );
        return;
      }
      latest.current.props.onSubmit?.(submission);
    },
    [scripts.navigateFrame],
  );

  // A blob URL is the page's own, and no host could fetch it: what a page
  // draws of a `File` it was given, before it uploads it, is answered here.
  const onResource = useCallback(
    async (request: ResourceRequest) => {
      if (!request.url.startsWith('blob:')) {
        return latest.current.props.onResource?.(request) ?? null;
      }
      // a turn on, since this is asked from inside the page's own ops
      await Promise.resolve();
      const bytes = scripts.runner?.()?.blobBytes(request.url);
      if (!bytes) throw new Error(`${request.url} holds nothing.`);
      const { kind } = request;
      return kind === 'image' || kind === 'font' || kind === 'stylesheet'
        ? ({ kind, bytes } as ResourceResult)
        : null;
    },
    [scripts.runner],
  );

  // the application's own callbacks, called beside the engine's
  const onDocument = useCallback(
    (document: Document) => {
      scripts.onDocument?.(document);
      latest.current.props.onDocument?.(document);
    },
    [scripts.onDocument],
  );
  const onScript = useCallback(
    (request: ScriptRequest) => {
      scripts.onScript?.(request);
      latest.current.props.onScript?.(request);
    },
    [scripts.onScript],
  );
  // told once the element has been laid out, as a browser lays a page out
  // before its scripts read it (`../parsed.ts`)
  const onParsed = useCallback(() => {
    scripts.onParsed?.();
    latest.current.props.onParsed?.();
  }, [scripts.onParsed]);
  const onLoaded = useCallback(() => {
    scripts.onLoaded?.();
    latest.current.props.onLoaded?.();
  }, [scripts.onLoaded]);
  const onDomEvent = useCallback(
    (event: HtmlDomEvent) => {
      const page = scripts.onDomEvent?.(event);
      const own = latest.current.props.onDomEvent?.(event);
      return page === false || own === false ? false : undefined;
    },
    [scripts.onDomEvent],
  );
  const onElementScroll = useCallback(
    (element: Element) => {
      scripts.onElementScroll?.(element);
      latest.current.props.onElementScroll?.(element);
    },
    [scripts.onElementScroll],
  );
  const onImage = useCallback(
    (element: Element, outcome: 'load' | 'error') => {
      scripts.imageSettled?.(element, outcome);
      void fireDomEvent(latest.current.props.onDomEvent, outcome, element);
    },
    [scripts.imageSettled],
  );
  const canvasImage = useCallback(
    (element: Element) =>
      scripts.canvasImage?.(element) ??
      latest.current.props.canvasImage?.(element) ??
      null,
    [scripts.canvasImage],
  );

  // The application's sheets and the ones the page adopted, as one array
  // for as long as they read the same. The element restyles the whole
  // document when its `stylesheet` is another array, and every refresh the
  // page's scripts make renders `<Html>` again: merged afresh at each, a
  // page that adopted a sheet was styled whole at every change it made.
  // Every GitHub page adopts one — the popover polyfill's, since the
  // facade has no popover of its own — and on an article whose contents
  // list marks the section scrolled to, each section crossed cost 400 ms.
  const own = props.stylesheet;
  const merged = scripts.stylesheet
    ? [
        ...(own === undefined ? [] : Array.isArray(own) ? own : [own]),
        ...scripts.stylesheet,
      ]
    : own;
  const kept = useRef(merged);
  if (!sameSheets(kept.current, merged)) kept.current = merged;
  const stylesheet = kept.current;

  return {
    ...props,
    scripting: scripts.scripting,
    onResource,
    onDocument,
    onScript,
    onParsed,
    onLoaded,
    onDomEvent,
    onElementScroll,
    canvasImage,
    canvasOpaque: scripts.canvasOpaque,
    onLink,
    onSubmit,
    stylesheet,
    renderEmbedded:
      frames && scripts.scripting ? renderEmbedded : props.renderEmbedded,
    _onViewportScroll: scripts.scrolled,
    _onPaint: scripts.painted,
    _onCssEvents: scripts.cssEvents,
    ...(scripts.imageSettled && { _onImage: onImage }),
    _onMediaEvent: scripts.mediaEvent,
    _unloadCheck: unloadCheck,
    _evaluate: evaluate,
    _inspectValue: inspectValue,
    _releaseValues: releaseValues,
    _onParserBlocked: scripts._onParserBlocked,
    ...(config.clipboard && {
      _readClipboard: () => latest.current.config.clipboard!.read(),
    }),
    _frames:
      holderContext && engine
        ? h(engine.FrameHolder, { context: holderContext })
        : null,
  };
}

/** Whether two `stylesheet` props hold the same sheets in the same order. */
function sameSheets(
  a: string | string[] | undefined,
  b: string | string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((sheet, i) => sheet === b[i]);
}

/** A document's root element, which a module's request names. */
function rootElement(document: Document | null): Element | null {
  for (const child of document?.children ?? []) {
    if (child.type === 'tag') return child as Element;
  }
  return null;
}
