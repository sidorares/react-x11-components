// A network for `<Html>`: everything `<Html>` deliberately does not do, for
// a host that wants the web's answers without writing its own fetching.
//
// `<Html>` asks for each resource a document needs through `onResource`,
// and a page's scripts for theirs through `scripts.fetch`, and fetches
// nothing itself (docs/components/html.md, "The seams"). This is one host's
// side of those seams — the example browser's, which it was written for —
// and it is where a policy lives, which an application takes or leaves:
//
//   - **An HTTP cache**, as a browser's is (RFC 9111, `http-cache.ts`): a
//     page's images, stylesheets, fonts and scripts are used again for as
//     long as their server says they are fresh, and a stale one is asked
//     about by its validators, so a 304 costs no body. It is this network's
//     memory, bounded by bytes, and a store the application hands in
//     (`httpCache`) — `HtmlProfile`'s, on disk, which every process of a
//     browser shares. Keyed by the site of the document that asked, as
//     browsers key theirs. A document, a page's own `fetch` and a redirect
//     are not kept.
//   - **A few requests at a time**, six per host, the way browsers pace a
//     page's hundred images, rather than a burst the server throttles.
//   - **`file:` only for `file:` pages.** A page from the web naming
//     `file:///etc/passwd` as an image gets nothing; a local page gets its
//     local images.
//   - **No mixed content.** A secure page's stylesheets, fonts and scripts
//     come over a secure connection or not at all, and its images are
//     asked for over one (`mixedContent`), as a browser has it.
//   - **Cookies only where the application hands in a jar** (`cookies`, a
//     `CookieJar`): then every request carries what RFC 6265bis lets it,
//     and every response's `Set-Cookie` is stored — on each redirect too,
//     which is why such a network follows redirects itself. Without one
//     nothing is stored between requests, as before.
//   - **No downloads.** Anything that is not a document, an image, a
//     stylesheet, a font or a script is not fetched at all — but a script's
//     own `fetch`, of the page's own origin, or of another where CORS lets
//     the page read it (the engine keeps to that; this keeps the host's
//     headers on it).
//   - **A form's POST says where it came from.** Its `Origin` and `Referer`
//     are the page's, as a browser's are, because a server tells a form's
//     POST from a forged one by them.
//
// The transport is the runtime's `fetch` — Node's and Bun's — unless the
// application hands it another, and `file:` is read through `node:fs`,
// reached as `src/embed/host.ts` reaches it. Nothing happens as this module
// is imported: an application that does not make an `HtmlNetwork` pays for
// none of it.
import { useEffect, useMemo } from 'react';
import { useSupports } from 'react-x11';

import type { CookieJar } from './cookies.js';
import {
  cachedResponse,
  conditionalHeaders,
  freshened,
  headerOf,
  isFresh,
  varyMatches,
} from './http-cache.js';
import type { HtmlCachedResponse, HtmlHttpCacheStore } from './http-cache.js';
import type { ResourceRequest, ResourceResult } from './resources.js';
import { NO_WEBRTC, deferredConnection } from './rtc.js';
import type { HtmlWebRTC } from './rtc.js';
import { offeredCapabilities } from './rtc-codecs.js';
import { NO_WEBTRANSPORT, deferredSession } from './transport.js';
import type { HtmlWebTransport } from './transport.js';
import { NO_WEBSOCKET, REFUSED_SOCKET } from './socket.js';
import type {
  HtmlWebSocket,
  WebSocketConnectRequest,
  WebSocketConnectionLike,
  WebSocketEvents,
} from './socket.js';
import type { FetchRequest, FetchResponse } from './scripts/host.js';
import { nodeModule } from './scripts/platform.js';
import type {
  AbortControllerClass,
  AbortSignalLike,
  ClearTimeout,
  SetTimeout,
  UrlClass,
} from './scripts/platform.js';

declare const setTimeout: SetTimeout;
declare const clearTimeout: ClearTimeout;
declare const URL: UrlClass;
declare const AbortController: AbortControllerClass;
declare const AbortSignal: {
  timeout(ms: number): AbortSignalLike & { readonly aborted: boolean };
  any(signals: AbortSignalLike[]): AbortSignalLike;
};
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const ReadableStream: new (source: {
  start(controller: { enqueue(chunk: Uint8Array): void; close(): void }): void;
}) => object;
declare const TextDecoder: new (label?: string) => {
  decode(bytes: Uint8Array): string;
};
declare const atob: (data: string) => string;
declare const DOMException: new (message: string, name: string) => Error;

/** The slice of a `fetch` response read here. */
interface ResponseLike {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly redirected: boolean;
  readonly headers: {
    get(name: string): string | null;
    entries(): IterableIterator<[string, string]>;
    /** Each `Set-Cookie` field apart, which `get` joins with commas a
     *  date's own comma cannot be told from. Node's and Bun's have it. */
    getSetCookie?(): string[];
  };
  readonly body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
}

/** A transport: the runtime's `fetch`, or one that goes somewhere else — a
 *  proxy, a cache on disk, a test's answers. */
export type HtmlTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    /** Whether `body` was a page's stream (`FetchRequest.streamedBody`),
     *  which the request sends once: a transport that would send a request
     *  again — on a 421, or to a redirect but a 303's — does not send this
     *  one. The runtime's `fetch` is handed it as a stream, which it sends
     *  once. */
    streamedBody?: boolean;
    signal: AbortSignalLike;
    /** `manual` where the network follows redirects itself, as it does
     *  with a cookie jar: a redirect is answered as it came, its
     *  `Location` and `Set-Cookie` read. A transport that follows it
     *  anyway loses only the cookies set on the way. */
    redirect: 'follow' | 'manual';
  },
) => Promise<ResponseLike>;

/** What an `HtmlNetwork` is made with. Every field has a default. */
export interface HtmlNetworkOptions {
  /** The `User-Agent` every request carries. Default `HTML_USER_AGENT`. */
  userAgent?: string;
  /** How many bytes the cache keeps in memory before it forgets the
   *  oldest. Default 256 MB. */
  cacheBytes?: number;
  /**
   * Where the HTTP cache keeps responses past this network's memory, for
   * the next network that opens it to find: `HtmlProfile`'s `httpCache`,
   * on disk, which every process of a browser shares. Default none: what
   * the cache keeps is this network's, and goes with it.
   */
  httpCache?: HtmlHttpCacheStore;
  /** What makes the requests. Default the runtime's `fetch`. */
  fetch?: HtmlTransport;
  /** Whether a `file:` page may read its own `file:` resources, and a
   *  `file:` URL be opened as a document. Default true. */
  files?: boolean;
  /**
   * How long Node gives each address family to connect, in milliseconds
   * (`net.setDefaultAutoSelectFamilyAttemptTimeout`), set the first time
   * this network makes a request — a setting of the process, which is why
   * it is an option. Node's own 250 ms is shorter than a long layout holds
   * the event loop, and a connection whose handshake came back meanwhile
   * is counted as timed out: every stylesheet Wikipedia's article asked
   * for failed with ETIMEDOUT while the article was laying itself out.
   * Default 2500; null leaves Node's alone.
   */
  connectTimeout?: number | null;
  /**
   * How long a request waits with nothing arriving, in milliseconds: no
   * answer yet, or no more of a document's or a resource's body. A body
   * that keeps arriving is read to its end however long that takes, as a
   * browser reads it. Default 30 000.
   */
  timeout?: number;
  /** Where each request and what came of it is told: a line of words a
   *  request. Default nowhere. */
  log?: (...parts: unknown[]) => void;
  /**
   * How a page's WebTransport sessions are opened (`webTransport`): over
   * `quico`, an optional peer — pure JavaScript QUIC, HTTP/3 and
   * WebTransport — with the server's certificate verified against `ca`,
   * by default the runtime's own roots and `NODE_EXTRA_CA_CERTS`, the
   * ones its `fetch` trusts. False: no session is opened, as with no
   * network.
   */
  webTransport?: { ca?: string[] } | false;
  /**
   * How a page's peer connections are made (`webRTC`): over `werift`, an
   * optional peer — ICE, DTLS, SCTP and SRTP in TypeScript — loaded the
   * first time a page makes one. False: none is made, as with no network.
   */
  webRTC?: false;
  /**
   * How a page's WebSockets are opened (`webSockets(page)`): over the
   * runtime's own `WebSocket`, Node's from 22 and Bun's. False: none is
   * opened, as with no network.
   */
  webSocket?: false;
  /**
   * The cookie jar every request is sent and answered through, and a
   * page's `document.cookie` reads (`cookies`). Default none: no request
   * carries a cookie, and none is kept.
   */
  cookies?: CookieJar;
}

/** Whose cookies a request carries (Fetch, a request's credentials mode),
 *  and what decides whether they are held back from another site. */
interface CookieRequest {
  credentials: 'omit' | 'same-origin' | 'include';
  /** The origin `same-origin` is reckoned from: the document's. */
  origin: string;
  /** The top-level document, whose site is the site for cookies; for a
   *  top-level navigation, its destination. */
  site: string | null;
  /** Whether the request navigates a top-level document. */
  topLevel: boolean;
  /** The document that started a navigation, or null for the browser —
   *  an address typed, a bookmark — which is same-site with anything. */
  initiator: string | null;
}

/** A redirect's statuses (Fetch, "redirect status"). */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** How many a request follows (Fetch 4.4, "HTTP-redirect fetch"). */
const MAX_REDIRECTS = 20;

/**
 * The User-Agent an `HtmlNetwork` sends, and `<Html scripts>`' pages read
 * as `navigator.userAgent`, unless told another. It says what this is.
 * Sites that sniff for a browser they know send what they send to an
 * unknown one, which is usually the simpler page — and it is why Google
 * Fonts answers with TrueType, one file a weight, which the text engines of
 * every backend read.
 */
export const HTML_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) react-x11-components ' +
  '(+https://github.com/sidorares/react-x11-components)';

const ACCEPT = {
  document: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  // no AVIF: under Node nothing here decodes it, and a server that
  // negotiates sends WebP, PNG or JPEG to a client that does not ask
  image:
    'image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.5,*/*;q=0.1',
  stylesheet: 'text/css,*/*;q=0.1',
  font: 'font/woff2,font/woff,font/ttf,font/otf,*/*;q=0.5',
  script: '*/*',
} as const;

/** What a page asks for. A script is asked for only where the page's
 *  scripts run, and is blocked on a secure page over an insecure
 *  connection, as a stylesheet is. */
export type ResourceKind = 'image' | 'stylesheet' | 'font' | 'script';

/** What a request is for, as an observer of a network is told: a
 *  document, what a document asked for, or a page's own fetch. */
export type HtmlRequestKind = 'document' | ResourceKind | 'fetch';

/**
 * What an observer of a network is told (`HtmlNetwork.observe`): each
 * request it makes — a document, a resource a document asked for, a page's
 * own fetch — as it goes, by an `id` the request keeps from its first event
 * to its last, with the time of each in milliseconds since the epoch.
 *
 * - `request`: asked for, with the header fields known then — those the
 *   network adds on the wire, a cookie, are not among them — and a body.
 *   `page` is the document it is for, null for a navigation.
 * - `sent`: on its way, once the network's pacing let it go: a request
 *   that waits for a connection to a busy host is `request` long before.
 *   Absent for one the cache answers.
 * - `response`: its status and header fields, where it was answered from
 *   — `memory` or `disk` where a cache answered with nothing sent — and
 *   whether a redirect led there.
 * - `data`, a chunk of the body as it arrives; then `end`, or `failed`
 *   where it did not come, or the one who asked stopped reading.
 */
export type HtmlNetworkActivity =
  | {
      type: 'request';
      id: number;
      kind: HtmlRequestKind;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | Uint8Array | null;
      page: string | null;
      time: number;
    }
  | { type: 'sent'; id: number; time: number }
  | {
      type: 'response';
      id: number;
      url: string;
      status: number;
      statusText: string;
      headers: [string, string][];
      redirected: boolean;
      cache?: 'memory' | 'disk';
      time: number;
    }
  | { type: 'data'; id: number; chunk: Uint8Array; time: number }
  | { type: 'end'; id: number; time: number }
  | { type: 'failed'; id: number; error: string; time: number };

/** A response's body, and what the server said about it. */
export interface Fetched {
  /** Where it came from in the end, after redirects. */
  url: string;
  status: number;
  /** The media type, lowercased, without its parameters. */
  type: string;
  /** The `charset` parameter, when the server named one. */
  charset: string | null;
  bytes: Uint8Array;
}

/**
 * What came of asking for a resource: its body, or why there is none. A
 * page needs only the body (`resource`); something that keeps what it is
 * given — the Zen Garden bench's cache on disk — has to tell a server that
 * has nothing there from a request that never got an answer, a 200 whose
 * body timed out among them.
 */
export type Loaded =
  /** A 2xx, and its body. */
  | { fetched: Fetched }
  /** Nothing asked for, and nothing to ask again: a URL the page may not
   *  have — a secure page's insecure stylesheet or font, a `file:` URL
   *  from the web, a scheme this does not fetch — or one with nothing in
   *  it to read, a `data:` URL that is not one or a local path that is not
   *  a file. */
  | { refused: true }
  /** The server answered, with a status that is not a 2xx. */
  | { status: number }
  /** No answer: the connection failed, the server took too long, the body
   *  was cut short, or the page went away before the request was made. */
  | { failed: unknown };

/** A document on its way: the head of the response, and the body as it
 *  arrives. */
export interface DocumentResponse {
  url: string;
  /** Whether a redirect brought it — after a POST, the GET that the
   *  redirect made of it. */
  redirected: boolean;
  status: number;
  type: string;
  charset: string | null;
  body: AsyncIterable<Uint8Array>;
}

/** What a form sends with a POST: its body as `<Html>` encoded it, the type
 *  that says how, and the page the form was on — which a server that
 *  checks where a POST came from reads as its `Origin` and `Referer`. */
export interface PostData {
  body: string;
  contentType: string;
  from: string;
}

/** Why a navigation failed, in words a page can show. */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const MAX_DOCUMENT = 32 * 1024 * 1024;
const MAX_RESOURCE = 16 * 1024 * 1024;
const TIMEOUT = 30_000;

/** What the network keeps of a resource in its memory. */
interface Kept {
  /** What came of asking for it, or comes. */
  loaded: Promise<Loaded>;
  /**
   * Once it is here, the response as the HTTP cache keeps it, which says
   * whether it may answer again; null for one that may not. Undefined while
   * it is on its way, and every request for it shares the one.
   */
  response?: HtmlCachedResponse | null;
  /** A body no server sent — a `data:` URL, a local file, a document
   *  seeded — which answers for as long as the memory keeps it. */
  forever?: boolean;
}

/** What asking for a resource came to: its body, and where the HTTP cache
 *  keeps the response, that, and whether it came from the cache
 *  (`cached`) or a server's 304 (`revalidated`) — what the log says. */
interface Obtained {
  fetched: Fetched | null;
  response?: HtmlCachedResponse | null;
  via?: 'cached' | 'revalidated';
}

/** A server's answer to a request for a resource: its body, and what the
 *  HTTP cache reads of it. */
interface Answer {
  fetched: Fetched;
  redirected: boolean;
  headers: [string, string][];
  /** When it was asked for and when its head came (RFC 9111, 4.2.3). */
  requestTime: number;
  responseTime: number;
}

/** What a request past every cache says, to a cache on the way too
 *  (Fetch, cache mode `reload`). */
const RELOAD = { 'cache-control': 'no-cache', pragma: 'no-cache' };

/** A kept response as a page has it. */
function fetchedOf(url: string, response: HtmlCachedResponse): Fetched {
  const { type, charset } = contentType(
    headerOf(response.headers, 'content-type'),
  );
  return { url, status: response.status, type, charset, bytes: response.bytes };
}

interface Queued {
  host: string;
  start: () => void;
}

/**
 * A network for `<Html>`: a cache, a pace, and a browser's rules about what
 * a page may have (see the top). `resources(page)` is an `onResource` for
 * the document at `page`, `fetcher(page)` its scripts' `fetch`, and
 * `useHtmlNetwork` both, for a component. One is enough for an application:
 * every document it shows shares the cache.
 */
export class HtmlNetwork {
  private _cache = new Map<string, Kept>();
  private readonly _store: HtmlHttpCacheStore | null;
  /** When `clear()` was last called: a response asked for before it is
   *  not used again, nor asked about. */
  private _clearedAt = -Infinity;
  private _sizes = new Map<string, number>();
  private _bytes = 0;
  private _limit: number;
  private _running = 0;
  private _perHost = new Map<string, number>();
  private _queue: Queued[] = [];
  private _language: string;
  private _userAgent: string;
  private readonly _transport: HtmlTransport | null;
  private readonly _files: boolean;
  private _connectTimeout: number | null;
  private readonly _timeout: number;
  private readonly _log: (...parts: unknown[]) => void;
  private readonly _webTransport: { ca?: string[] } | false;
  private _sessions: HtmlWebTransport | null = null;
  private readonly _webRTC: boolean;
  private _peers: HtmlWebRTC | null = null;
  private readonly _webSocket: boolean;
  private readonly _cookies: CookieJar | null;
  /** Who is told of each request (`observe`), and the last id handed out. */
  private readonly _observers = new Set<
    (activity: HtmlNetworkActivity) => void
  >();
  private _activities = 0;

  constructor(options: HtmlNetworkOptions = {}) {
    this._limit = options.cacheBytes ?? 256 * 1024 * 1024;
    this._store = options.httpCache ?? null;
    this._language = acceptLanguage();
    this._userAgent = options.userAgent ?? HTML_USER_AGENT;
    this._transport = options.fetch ?? null;
    this._files = options.files ?? true;
    this._connectTimeout =
      options.connectTimeout === undefined ? 2500 : options.connectTimeout;
    this._timeout = options.timeout ?? TIMEOUT;
    this._log = options.log ?? (() => {});
    this._webTransport = options.webTransport ?? {};
    this._webRTC = options.webRTC !== false;
    this._webSocket = options.webSocket !== false;
    this._cookies = options.cookies ?? null;
  }

  /** The cookie jar this network sends and stores cookies through, and a
   *  page's `document.cookie` reads (`<Html scripts={{ cookies }}>`), or
   *  null for none. */
  get cookies(): CookieJar | null {
    return this._cookies;
  }

  /**
   * A page's peer connections (`<Html scripts={{ webRTC }}>`), through
   * `werift` where it is installed — loaded the first time a page makes a
   * connection — and with every operation refused where it is not. What a
   * connection may offer is answered at once, from the codecs it will be
   * configured with, before werift is loaded.
   */
  get webRTC(): HtmlWebRTC {
    if (this._peers) return this._peers;
    if (!this._webRTC) return (this._peers = NO_WEBRTC);
    let made: Promise<HtmlWebRTC> | null = null;
    const log = this._log;
    // the adapter is a chunk of its own, reached once a page asks
    const adapter = (): Promise<HtmlWebRTC> =>
      (made ??= import('./werift.js').then((m) => m.weriftWebRTC()));
    this._peers = {
      connect(request, events) {
        log('webrtc', request.origin);
        return deferredConnection(adapter(), request, events);
      },
      generateCertificate: (keygen, expires) =>
        adapter().then((s) => s.generateCertificate(keygen, expires)),
      capabilities: (kind) => offeredCapabilities(kind),
    };
    return this._peers;
  }

  /**
   * A page's WebTransport sessions (`<Html scripts={{ webTransport }}>`):
   * each over QUIC and HTTP/3 to the server the page names, through
   * `quico` where it is installed — loaded the first time a page opens a
   * session — and failed, as with no network, where it is not.
   */
  get webTransport(): HtmlWebTransport {
    if (this._sessions) return this._sessions;
    const options = this._webTransport;
    if (options === false) return (this._sessions = NO_WEBTRANSPORT);
    let made: Promise<HtmlWebTransport> | null = null;
    const log = this._log;
    // the adapter is a chunk of its own, reached once a page asks
    const adapter = (): Promise<HtmlWebTransport> =>
      (made ??= import('./quico.js').then((m) =>
        m.quicoWebTransport({ ca: options.ca }),
      ));
    this._sessions = {
      connect(request, events) {
        log('webtransport', request.url);
        return deferredSession(adapter(), request, events);
      },
    };
    return this._sessions;
  }

  /**
   * A page's WebSockets (`<Html scripts={{ webSocket }}>`), for the document
   * at `page`, over the runtime's own `WebSocket` — Node's from 22, Bun's.
   * Each opening handshake carries the `Origin` of the document or worker
   * that opened it, this network's `User-Agent` and language, and the jar's
   * cookies for the URL, its credentials included and its site for cookies
   * `page`'s (Fetch, "establish a WebSocket connection"). Where the runtime
   * says what the handshake was answered with — Node's, from 24, through
   * undici's `undici:websocket:open` channel — its `Set-Cookie` is stored;
   * Bun says nothing of it. A runtime with no `WebSocket`, Node 20, fails
   * every socket, as with no network.
   */
  webSockets(page: string): HtmlWebSocket {
    if (!this._webSocket) return NO_WEBSOCKET;
    const site = page.split('#')[0];
    return {
      connect: (request, events) => {
        this._log('websocket', request.url);
        return runtimeSocket(request, events, {
          userAgent: this._userAgent,
          language: this._language,
          cookies: this._cookies,
          site,
        });
      },
    };
  }

  /** The User-Agent this network's requests carry. It can be set, so a host
   *  that lets a reader switch agents (a browser's UA override) changes what
   *  the next request sends without rebuilding the network; a page sees the
   *  new one on its next navigation, the way such an override applies on the
   *  next load. */
  get userAgent(): string {
    return this._userAgent;
  }
  set userAgent(value: string) {
    this._userAgent = value || HTML_USER_AGENT;
  }

  /** What makes a request: the transport this was given, or the runtime's
   *  `fetch`, Node's told how long a connection may take first. */
  private async _send(
    url: string,
    init: Parameters<HtmlTransport>[1],
  ): Promise<ResponseLike> {
    if (this._transport) return this._transport(url, init);
    if (this._connectTimeout !== null) {
      const ms = this._connectTimeout;
      this._connectTimeout = null;
      try {
        const net = await nodeModule<{
          setDefaultAutoSelectFamilyAttemptTimeout?(ms: number): void;
        }>('net');
        net.setDefaultAutoSelectFamilyAttemptTimeout?.(ms);
      } catch {
        // a runtime with no `node:net` connects as it does
      }
    }
    const runtimeFetch = (
      globalThis as unknown as {
        fetch?: (url: string, init: object) => Promise<ResponseLike>;
      }
    ).fetch;
    if (!runtimeFetch) {
      throw new NetworkError('This runtime has no fetch.', 'ERR_FAILED');
    }
    const { streamedBody, ...rest } = init;
    if (!streamedBody || rest.body === undefined) {
      return runtimeFetch(url, rest);
    }
    // a page's stream goes as a stream, a body with no source to the
    // runtime as to the page: Node's fetch sends bytes again on a new
    // connection when a 421 answers them, as Fetch lets it, and a stream
    // never. Its length is known, so it goes with it, as its bytes did,
    // rather than chunked.
    const bytes =
      typeof rest.body === 'string'
        ? new TextEncoder().encode(rest.body)
        : rest.body;
    return runtimeFetch(url, {
      ...rest,
      headers: { ...rest.headers, 'content-length': String(bytes.length) },
      body: new ReadableStream({
        start(controller) {
          if (bytes.length) controller.enqueue(bytes);
          controller.close();
        },
      }),
      duplex: 'half',
    });
  }

  /**
   * A request sent with its cookies, where this network has a jar and the
   * request's credentials mode lets it carry them: each redirect followed
   * here, the `Set-Cookie` of every response on the way stored and the
   * cookies of every URL on the way sent (Fetch 4.4, 4.5). Without a jar,
   * the transport follows redirects, as it always did.
   */
  private async _exchange(
    url: string,
    init: Omit<Parameters<HtmlTransport>[1], 'redirect'>,
    cookies: CookieRequest | null,
  ): Promise<ResponseLike> {
    const jar = this._cookies;
    if (!jar || !cookies || cookies.credentials === 'omit') {
      return this._send(url, { ...init, redirect: 'follow' });
    }
    let at = url;
    let method = init.method;
    let body = init.body;
    let headers = { ...init.headers };
    /** The URLs before this one, which a request that left the site on
     *  its way is held to as not same-site (6265bis 5.2). */
    const before: string[] = [];
    for (let hop = 0; ; hop += 1) {
      const include =
        cookies.credentials === 'include' || originOf(at) === cookies.origin;
      const sameSite = this._sameSite(at, cookies, before);
      const context = {
        http: true,
        sameSite,
        topLevel: cookies.topLevel,
        method,
      };
      delete headers.cookie;
      if (include) {
        const header = jar.header(at, context);
        if (header) headers.cookie = header;
      }
      const response = await this._send(at, {
        ...init,
        method,
        body,
        headers,
        ...(body !== undefined && init.streamedBody
          ? { streamedBody: true }
          : { streamedBody: undefined }),
        redirect: 'manual',
      });
      if (include) jar.store(at, setCookies(response.headers), context);
      const location = response.headers.get('location');
      if (!REDIRECTS.has(response.status) || location === null) {
        return answered(
          response,
          response.url || at,
          hop > 0 || response.redirected,
        );
      }
      response.body
        ?.getReader()
        .cancel()
        .catch(() => {});
      if (hop >= MAX_REDIRECTS) {
        throw new TypeError('Failed to fetch: too many redirects.');
      }
      let next: string;
      try {
        next = new URL(location, at).href;
      } catch {
        throw new TypeError('Failed to fetch: a redirect to no URL.');
      }
      const scheme = schemeOf(next);
      if (scheme !== 'http' && scheme !== 'https') {
        throw new TypeError(`Failed to fetch: a redirect to ${scheme}:.`);
      }
      // a page's stream is sent once, and a redirect but a 303's sends it
      // again (Fetch 4.4, step 11)
      if (init.streamedBody && body !== undefined && response.status !== 303) {
        throw new TypeError('Failed to fetch: a redirect of a streamed body.');
      }
      if (
        ((response.status === 301 || response.status === 302) &&
          method === 'POST') ||
        (response.status === 303 && method !== 'GET' && method !== 'HEAD')
      ) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(
          Object.entries(headers).filter(
            ([name]) =>
              !/^content-(type|length|encoding|language|location)$/i.test(name),
          ),
        );
      }
      if (originOf(next) !== originOf(at)) delete headers.authorization;
      before.push(at);
      at = next;
    }
  }

  /** Whether a request to `url` is same-site for its cookies (6265bis
   *  5.2): with its top-level document, or for a navigation with the
   *  document that started it, every URL on its way included. */
  private _sameSite(
    url: string,
    cookies: CookieRequest,
    before: readonly string[],
  ): boolean {
    const jar = this._cookies!;
    const against = cookies.topLevel ? cookies.initiator : cookies.site;
    if (cookies.topLevel && against === null) {
      return before.every((b) => jar.sameSite(b, url));
    }
    if (!jar.sameSite(url, against)) return false;
    return before.every((b) => jar.sameSite(b, against));
  }

  /** How many requests are waiting or running. */
  get busy(): number {
    return this._running + this._queue.length;
  }

  /**
   * Be told of each request this network makes from now on, as it goes
   * (`HtmlNetworkActivity`): what a developer's tools draw a network log
   * from. Answers what stops it. With no observer, nothing is told and
   * nothing is kept; a body is handed over a chunk at a time as it
   * arrives, and kept by none of this.
   */
  observe(listener: (activity: HtmlNetworkActivity) => void): () => void {
    this._observers.add(listener);
    return () => {
      this._observers.delete(listener);
    };
  }

  /** Tell every observer: one that throws is its own trouble. */
  private _tell(activity: HtmlNetworkActivity): void {
    for (const listener of this._observers) {
      try {
        listener(activity);
      } catch {
        // nothing of the request's depends on it
      }
    }
  }

  /** A request begun, told to the observers: its id, or 0 where nothing
   *  observes, which every later event of it then skips. */
  private _begin(
    kind: HtmlRequestKind,
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | Uint8Array | null,
    page: string | null,
  ): number {
    if (!this._observers.size) return 0;
    const id = ++this._activities;
    this._tell({
      type: 'request',
      id,
      kind,
      url,
      method,
      headers: { ...headers },
      body,
      page,
      time: Date.now(),
    });
    return id;
  }

  private _sent(id: number): void {
    if (id) this._tell({ type: 'sent', id, time: Date.now() });
  }

  private _responded(
    id: number,
    response: ResponseLike,
    url: string,
    redirected = response.redirected,
  ): void {
    if (!id) return;
    this._tell({
      type: 'response',
      id,
      url: response.url || url,
      status: response.status,
      statusText: response.statusText ?? '',
      headers: [...response.headers.entries()],
      redirected,
      time: Date.now(),
    });
  }

  private _failed(id: number, error: unknown): void {
    if (!id) return;
    this._tell({
      type: 'failed',
      id,
      error: String((error as Error)?.message ?? error),
      time: Date.now(),
    });
  }

  /** A whole answer known at once — one a cache had, a `data:` URL, a
   *  local file — told as a response, its body and its end. */
  private _whole(
    id: number,
    fetched: Fetched,
    headers: [string, string][],
    cache?: 'memory' | 'disk',
  ): void {
    if (!id) return;
    const time = Date.now();
    this._tell({
      type: 'response',
      id,
      url: fetched.url,
      status: fetched.status,
      statusText: '',
      headers,
      redirected: false,
      ...(cache && { cache }),
      time,
    });
    if (fetched.bytes.length) {
      this._tell({ type: 'data', id, chunk: fetched.bytes, time });
    }
    this._tell({ type: 'end', id, time });
  }

  /**
   * A body handed on as it arrives, each chunk told to the observers and
   * its end, or why it stopped. Its `return()` is the body's own, called as
   * soon as it is: a body a caller lets go unread still lets its
   * connection go (`bodyChunks`).
   */
  private _observed(
    id: number,
    body: AsyncIterable<Uint8Array>,
  ): AsyncIterable<Uint8Array> {
    if (!id) return body;
    const network = this;
    let over = false;
    const finish = (error?: unknown): void => {
      if (over) return;
      over = true;
      if (error === undefined)
        network._tell({ type: 'end', id, time: Date.now() });
      else network._failed(id, error);
    };
    return {
      [Symbol.asyncIterator]() {
        const inner = body[Symbol.asyncIterator]();
        return {
          async next() {
            try {
              const read = await inner.next();
              if (read.done) finish();
              else {
                network._tell({
                  type: 'data',
                  id,
                  chunk: read.value,
                  time: Date.now(),
                });
              }
              return read;
            } catch (error) {
              finish(error);
              throw error;
            }
          },
          async return(value?: unknown) {
            finish('canceled');
            return (
              (await inner.return?.(value)) ?? {
                done: true as const,
                value: undefined,
              }
            );
          },
        };
      },
    };
  }

  /**
   * Forget everything cached: a hard reload. What the store kept from
   * before is not used by this network again: the next time a page asks
   * for one it goes past every cache (Fetch's cache mode `reload`), and
   * what comes back is kept in its place.
   */
  clear(): void {
    this._cache.clear();
    this._sizes.clear();
    this._bytes = 0;
    this._clearedAt = Date.now();
  }

  /**
   * A page's image, stylesheet or font. Cached by URL, so every page asking
   * for it shares one request; null for anything that did not come back as
   * a 200 with a body, or that the page may not have.
   */
  resource(
    url: string,
    kind: ResourceKind,
    page: string,
    signal?: AbortSignalLike,
  ): Promise<Fetched | null> {
    return this.load(url, kind, page, signal).then((loaded) =>
      'fetched' in loaded ? loaded.fetched : null,
    );
  }

  /** A resource as `resource` has it, and when there is none, why. */
  load(
    url: string,
    kind: ResourceKind,
    page: string,
    signal?: AbortSignalLike,
  ): Promise<Loaded> {
    const refused = Promise.resolve<Loaded>({ refused: true });
    const allowed = mixedContent(url, kind, page);
    if (allowed === null) return refused;
    if (allowed !== url) return this.load(allowed, kind, page, signal);
    const scheme = schemeOf(url);
    if (scheme === 'file' && (!this._files || schemeOf(page) !== 'file')) {
      return refused;
    }
    if (!['http', 'https', 'data', 'file'].includes(scheme)) return refused;
    const http = scheme === 'http' || scheme === 'https';
    const key = this._cacheKey(url, page);
    // only what goes to a server is sent with header fields, and a
    // `data:` URL of megabytes is not parsed again to make them
    const headers = http ? this._headers(kind, url, page) : null;
    const id = this._begin(kind, url, 'GET', headers ?? {}, null, page);
    const kept = this._cache.get(key);
    if (kept && this._answers(kept, headers)) {
      // most recently used goes to the end, oldest is evicted first
      this._cache.delete(key);
      this._cache.set(key, kept);
      if (id) {
        void kept.loaded.then((loaded) => {
          if ('fetched' in loaded) {
            this._whole(
              id,
              loaded.fetched,
              kept.response?.headers ?? [],
              'memory',
            );
          } else
            this._failed(id, 'status' in loaded ? loaded.status : 'refused');
        });
      }
      return kept.loaded;
    }
    // a `data:` URL is its own body, read here rather than asked of a
    // network it never goes to (`readDataUrl`)
    const made: Promise<Obtained> =
      scheme === 'data'
        ? Promise.resolve({ fetched: readDataUrl(url) })
        : scheme === 'file'
          ? this._paced(url, signal, () => readLocal(url, MAX_RESOURCE)).then(
              (fetched) => ({ fetched }),
            )
          : this._http(
              key,
              url,
              page,
              headers!,
              signal,
              kept?.response ?? null,
              id,
            );
    // what the memory holds of it until it is here, and after if it is
    // kept: what a later answer is checked against, so that one made after
    // a `clear()`, or after it was asked for again, is not forgotten for it
    const mine = {} as Kept;
    mine.loaded = made.then(
      ({ fetched, response = null, via }): Loaded => {
        // what went to no server is told here, whole; what did, as it went
        if (!http) {
          if (fetched) {
            this._whole(id, fetched, [['content-type', fetched.type]]);
          } else this._failed(id, 'nothing to read');
        }
        if (!fetched || fetched.status < 200 || fetched.status >= 300) {
          this._log(kind, fetched ? fetched.status : 'nothing to read', url);
          this._forget(key, mine);
          return fetched ? { status: fetched.status } : { refused: true };
        }
        this._log(
          kind,
          via ?? fetched.status,
          fetched.type,
          fetched.bytes.length,
          url,
        );
        mine.response = response;
        mine.forever = !http;
        // a response the cache may not use again is not kept to be
        if (http && !response) this._forget(key, mine);
        else if (this._cache.get(key) === mine) {
          this._remember(key, fetched.bytes.length);
        }
        return { fetched };
      },
      (error): Loaded => {
        this._failed(id, error);
        this._log(
          kind,
          'failed',
          url,
          (error as Error)?.message,
          (error as { cause?: unknown })?.cause,
        );
        this._forget(key, mine);
        return { failed: error };
      },
    );
    this._cache.set(key, mine);
    return mine.loaded;
  }

  /** Put a body in the cache that arrived some other way — a document that
   *  turned out to be an image, which its page then asks for. */
  seed(fetched: Fetched): void {
    const key = this._cacheKey(fetched.url, fetched.url);
    this._cache.set(key, {
      loaded: Promise.resolve({ fetched }),
      forever: true,
    });
    this._remember(key, fetched.bytes.length);
  }

  /** Where a resource is kept: a URL not on the web by itself, one on the
   *  web without its fragment and under the site of the document that
   *  asked — the HTTP cache keyed by site, as browsers key theirs, so a
   *  page cannot tell by how soon a resource came what another site's
   *  pages loaded. */
  private _cacheKey(url: string, page: string): string {
    const scheme = schemeOf(url);
    if (scheme !== 'http' && scheme !== 'https') return url;
    const site = this._cookies?.site(page) ?? originOf(page);
    return `${site} ${url.split('#')[0]}`;
  }

  /** The header fields a page's request for a resource carries, before
   *  the cookies `_exchange` adds: what a kept response's `Vary` is
   *  compared with. */
  private _headers(
    kind: ResourceKind,
    url: string,
    page: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': this._userAgent,
      accept: ACCEPT[kind],
      'accept-language': this._language,
    };
    const referrer = referrerFor(page, url);
    if (referrer) headers.referer = referrer;
    return headers;
  }

  /** Whether what the memory keeps answers a request: one on its way, a
   *  body that is no server's, or a response still fresh for it. */
  private _answers(
    kept: Kept,
    headers: Record<string, string> | null,
  ): boolean {
    if (kept.response === undefined || kept.forever) return true;
    const response = kept.response;
    return (
      !!response &&
      !!headers &&
      response.requestTime >= this._clearedAt &&
      varyMatches(response, headers) &&
      isFresh(response, Date.now())
    );
  }

  /** Let a resource go from the memory, unless something newer took its
   *  place there. */
  private _forget(key: string, kept: Kept): void {
    if (this._cache.get(key) !== kept) return;
    this._cache.delete(key);
    this._bytes -= this._sizes.get(key) ?? 0;
    this._sizes.delete(key);
  }

  /**
   * A resource over HTTP, through the cache (RFC 9111, 4): a response kept
   * — `candidate`, from the memory, or the store's — that is still fresh
   * answers at once; a stale one with a validator is asked about, and a
   * 304 answers with its body; anything else is asked for whole, and kept
   * where it may be.
   */
  private async _http(
    key: string,
    url: string,
    page: string,
    headers: Record<string, string>,
    signal: AbortSignalLike | undefined,
    candidate: HtmlCachedResponse | null,
    /** Its observers' id for it (`observe`), 0 for none. */
    id = 0,
  ): Promise<Obtained> {
    const had = candidate ?? (await this._stored(key));
    // asked for before a hard reload: neither used nor asked about, and
    // the request goes past every cache on its way too
    const reload = !!had && had.requestTime < this._clearedAt;
    const stored = had && !reload && varyMatches(had, headers) ? had : null;
    if (stored && isFresh(stored, Date.now())) {
      const fetched = fetchedOf(url, stored);
      this._whole(id, fetched, stored.headers, 'disk');
      return { fetched, response: stored, via: 'cached' };
    }
    const validators = stored && conditionalHeaders(stored);
    const answer = await this._paced(url, signal, () =>
      this._fetch(url, {
        headers: { ...headers, ...validators, ...(reload ? RELOAD : null) },
        limit: MAX_RESOURCE,
        page,
        id,
      }),
    );
    if (answer.fetched.status === 304 && stored && validators) {
      const head = freshened(
        stored,
        answer.headers,
        answer.requestTime,
        answer.responseTime,
      );
      const response = { ...head, bytes: stored.bytes };
      await this._keep((store) => store.refresh(key, head));
      return {
        fetched: fetchedOf(url, response),
        response,
        via: 'revalidated',
      };
    }
    const { fetched } = answer;
    if (fetched.status < 200 || fetched.status >= 300) return { fetched };
    const response = cachedResponse(
      {
        status: fetched.status,
        headers: answer.headers,
        bytes: fetched.bytes,
        requestTime: answer.requestTime,
        responseTime: answer.responseTime,
      },
      headers,
    );
    if (answer.redirected) {
      // a redirect is asked for each time; where it led is kept under the
      // URL it led to, which a page may name too
      if (response && /^https?:/i.test(fetched.url)) {
        const there = this._cacheKey(fetched.url, page);
        await this._keep((store) => store.put(there, response));
      }
      return { fetched };
    }
    if (response) await this._keep((store) => store.put(key, response));
    else if (had) await this._keep((store) => store.delete(key));
    return { fetched, response };
  }

  /** What the store kept for `key`, or null — for a store that answers
   *  nothing, or fails to. */
  private async _stored(key: string): Promise<HtmlCachedResponse | null> {
    if (!this._store) return null;
    try {
      return (await this._store.get(key)) ?? null;
    } catch (error) {
      this._log('cache', 'unread', key, (error as Error)?.message);
      return null;
    }
  }

  /** A write to the store, whose failure is a response not kept: the page
   *  has it all the same. */
  private async _keep(
    write: (store: HtmlHttpCacheStore) => void | Promise<void>,
  ): Promise<void> {
    if (!this._store) return;
    try {
      await write(this._store);
    } catch (error) {
      this._log('cache', 'not kept', (error as Error)?.message);
    }
  }

  /**
   * Open a document for a navigation: the response's head as soon as it is
   * here, and its body as it arrives. Throws a `NetworkError` when there is
   * no response at all — no such host, a refused connection, a certificate
   * that does not verify; an HTTP error status is a response, and its page
   * is shown the way a browser shows it.
   *
   * With `post`, a form's POST: its body, its type, and the `Origin` and
   * `Referer` of the page it was on, which is how a server tells a form's
   * POST from one made up elsewhere. Only over HTTP — anything else has no
   * method to send it by. A redirect after it is followed as a GET, as
   * `fetch` does for a 303, and for a 301 or 302 after a POST.
   */
  async document(
    url: string,
    signal: AbortSignalLike,
    post: PostData | null = null,
    options: {
      /** The document that started the navigation — a link's, a
       *  script's — or null for the browser, whose own navigations are
       *  same-site with anything (6265bis 5.2.2). A form's POST is started
       *  by its `from`. */
      initiator?: string | null;
    } = {},
  ): Promise<DocumentResponse> {
    const scheme = schemeOf(url);
    if (scheme === 'file') {
      if (!this._files) {
        throw new NetworkError(
          'This network opens no file: URLs.',
          'ERR_ACCESS_DENIED',
        );
      }
      return localDocument(url);
    }
    if (scheme === 'data') {
      const read = readDataUrl(url);
      if (!read) {
        throw new NetworkError(
          'That data: URL has nothing in it a browser can read.',
          'ERR_INVALID_URL',
        );
      }
      return { ...read, redirected: false, body: once(read.bytes) };
    }
    if (scheme !== 'http' && scheme !== 'https') {
      throw new NetworkError(
        `The ${scheme}: scheme is not something this browser opens.`,
        'ERR_UNKNOWN_URL_SCHEME',
      );
    }
    const stall = stallTimer(this._timeout);
    const headers: Record<string, string> = {
      'user-agent': this._userAgent,
      accept: ACCEPT.document,
      'accept-language': this._language,
    };
    const posting = post && (scheme === 'http' || scheme === 'https');
    if (posting) {
      headers['content-type'] = post.contentType;
      headers.origin = originOf(post.from);
      const referrer = referrerFor(post.from, url);
      if (referrer) headers.referer = referrer;
      this._log('POST', url, post.contentType, post.body.length);
    }
    const id = this._begin(
      'document',
      url,
      posting ? 'POST' : 'GET',
      headers,
      posting ? post.body : null,
      null,
    );
    this._sent(id);
    let response: ResponseLike;
    try {
      response = await this._exchange(
        url,
        {
          method: posting ? 'POST' : 'GET',
          body: posting ? post.body : undefined,
          signal: AbortSignal.any([signal, stall.signal]),
          headers,
        },
        {
          credentials: 'include',
          origin: originOf(url),
          site: url,
          topLevel: true,
          initiator:
            options.initiator !== undefined
              ? options.initiator
              : posting
                ? post.from
                : null,
        },
      );
    } catch (error) {
      stall.stop();
      this._failed(id, error);
      if (signal.aborted) throw error;
      throw networkError(error, stall.signal.aborted);
    }
    this._responded(id, response, url);
    stall.progress();
    const { type, charset } = contentType(response.headers.get('content-type'));
    return {
      url: response.url || url,
      redirected: response.redirected,
      status: response.status,
      type,
      charset,
      body: this._observed(id, arriving(bodyOf(response, MAX_DOCUMENT), stall)),
    };
  }

  /**
   * A page's `fetch`: any method, its headers and body, and the response's
   * status, headers and body, whatever the status — a 404 is an answer. Not
   * cached, and over HTTP alone. The caller has kept it to the page's
   * origin; this keeps the browser's own headers on it.
   */
  async request(
    request: {
      url: string;
      method: string;
      headers: [string, string][];
      body: string | null;
      bytes?: Uint8Array;
      stream?: boolean;
      streamedBody?: boolean;
      /** Whose cookies it carries (Fetch, credentials mode). Default
       *  `same-origin`, a page's `fetch`'s. */
      credentials?: 'omit' | 'same-origin' | 'include';
      /** The document it is made from, where that is not `page`: a
       *  frame's (`FetchRequest.client`). */
      client?: string;
    },
    page: string,
    signal: AbortSignalLike,
  ): Promise<{
    url: string;
    status: number;
    statusText: string;
    redirected: boolean;
    headers: [string, string][];
    charset: string | null;
    bytes: Uint8Array;
    /** The body as it arrives, where the request asked for it so; `bytes`
     *  is then empty. */
    chunks?: AsyncIterable<Uint8Array>;
  }> {
    const scheme = schemeOf(request.url);
    if (scheme !== 'http' && scheme !== 'https') {
      throw new NetworkError(
        `A script cannot fetch ${scheme}: URLs.`,
        'ERR_FAILED',
      );
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers) {
      // what a browser sets itself, and a page may not (Fetch 2.2.2)
      if (
        /^(host|origin|referer|cookie|user-agent|content-length|connection)$/i.test(
          name,
        )
      ) {
        continue;
      }
      headers[name.toLowerCase()] = value;
    }
    headers['user-agent'] = this._userAgent;
    headers['accept-language'] ??= this._language;
    headers.accept ??= '*/*';
    // a frame's request is the frame's, and its site for cookies the page's
    const client = request.client ?? page;
    headers.origin = originOf(client);
    const referrer = referrerFor(client, request.url);
    if (referrer) headers.referer = referrer;
    const method = request.method.toUpperCase();
    // the wait for an answer is bounded, and its body is not: a page reads
    // a stream of events, or a model's reply, for as long as it goes on
    const timer = new AbortController();
    const timeout = setTimeout(
      () =>
        timer.abort(
          new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          ),
        ),
      this._timeout,
    );
    this._log('fetch', method, request.url);
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : (request.bytes ?? request.body ?? undefined);
    const id = this._begin(
      'fetch',
      request.url,
      method,
      headers,
      body ?? null,
      client,
    );
    let response: ResponseLike;
    try {
      response = await this._paced(request.url, signal, () => {
        this._sent(id);
        return this._exchange(
          request.url,
          {
            method,
            headers,
            body,
            // a page's stream, which nothing sends again
            ...(body !== undefined && request.streamedBody
              ? { streamedBody: true }
              : {}),
            signal: AbortSignal.any([signal, timer.signal]),
          },
          {
            credentials: request.credentials ?? 'same-origin',
            origin: originOf(client),
            site: page,
            topLevel: false,
            initiator: null,
          },
        );
      });
    } catch (error) {
      this._failed(id, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    this._responded(id, response, request.url);
    const { charset } = contentType(response.headers.get('content-type'));
    const answer = {
      url: response.url || request.url,
      status: response.status,
      statusText: response.statusText,
      redirected: response.redirected,
      headers: [...response.headers.entries()],
      charset,
    };
    if (request.stream) {
      return {
        ...answer,
        bytes: new Uint8Array(0),
        chunks: this._observed(id, bodyChunks(response, MAX_RESOURCE)),
      };
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of this._observed(
      id,
      bodyOf(response, MAX_RESOURCE),
    )) {
      chunks.push(chunk);
    }
    return { ...answer, bytes: concat(chunks) };
  }

  /**
   * An `onResource` for the document at `page`: each image, stylesheet,
   * font and script it asks for through this network, under the rules at
   * the top, and handed back as `<Html>` takes it (`resourceResult`). A
   * `<video>`'s source, and an `<audio>`'s, is handed to the platform's
   * player where `video` says there is one (`videoSource`), and declined
   * where not. `signal` stops what the document asked for, for a host that
   * lets it go.
   */
  resources(
    page: string,
    options: { signal?: AbortSignalLike; video?: boolean } = {},
  ): (request: ResourceRequest) => Promise<ResourceResult | null> | null {
    return (request) => {
      if (request.kind === 'video' || request.kind === 'audio') {
        const src = options.video
          ? videoSource(request.url, request.type, page)
          : null;
        if (!src) return null;
        return Promise.resolve(
          request.kind === 'audio'
            ? { kind: 'audio', src }
            : { kind: 'video', src },
        );
      }
      const kind = request.kind;
      return this.resource(request.url, kind, page, options.signal).then(
        (fetched) => (fetched ? resourceResult(fetched, kind) : null),
      );
    };
  }

  /**
   * The `fetch` a page's scripts make their requests through, for the
   * document at `page` (`<Html scripts={{ fetch }}>`): a page's `fetch` and
   * `XMLHttpRequest`, a frame's document, a worker's script. The engine
   * keeps a page to what its origin and CORS let it read; this sends the
   * request as the page's, with its `Origin` and `Referer`.
   */
  fetcher(
    page: string,
  ): (
    request: FetchRequest,
    signal: AbortSignalLike,
  ) => Promise<FetchResponse> {
    return async (request, signal) => {
      const { charset, ...answer } = await this.request(request, page, signal);
      if (answer.chunks) {
        const { bytes: _none, ...streamed } = answer;
        return { ...streamed, body: '' };
      }
      return { ...answer, body: decodeText(answer.bytes, charset) };
    };
  }

  /**
   * A document, all of it, as text: where the address ended up after
   * redirects, its status, its type and the encoding it was decoded from —
   * the response's, a `<meta>`'s in its first kilobyte, or UTF-8. What a
   * host that shows one page hands `<Html source baseUrl>`; one that wants
   * a page to appear as it arrives streams it from `document`. Throws a
   * `NetworkError` where there is no response at all; an HTTP error is a
   * response, and its page is answered.
   */
  async html(
    url: string,
    options: { signal?: AbortSignalLike; post?: PostData | null } = {},
  ): Promise<{
    url: string;
    status: number;
    type: string;
    charset: string;
    source: string;
  }> {
    const signal = options.signal ?? new AbortController().signal;
    const response = await this.document(url, signal, options.post ?? null);
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) chunks.push(chunk);
    const bytes = concat(chunks);
    const charset = response.charset ?? sniffCharset(bytes) ?? 'utf-8';
    return {
      url: response.url,
      status: response.status,
      type: response.type,
      charset,
      source: decodeText(bytes, charset),
    };
  }

  private _remember(kept: string, size: number): void {
    const before = this._sizes.get(kept) ?? 0;
    this._sizes.set(kept, size);
    this._bytes += size - before;
    for (const key of this._cache.keys()) {
      if (this._bytes <= this._limit) break;
      // one still on its way has no size yet, and is not what fills this
      if (key === kept || !this._sizes.has(key)) continue;
      this._bytes -= this._sizes.get(key) ?? 0;
      this._sizes.delete(key);
      this._cache.delete(key);
    }
  }

  /** Run a request when its host has a slot: six at a time a host, twenty
   *  four in all. A request whose page went away before it started is not
   *  made, and fails with the page's reason. */
  private _paced<T>(
    url: string,
    signal: AbortSignalLike | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const host = hostOf(url);
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        if (signal?.aborted) {
          reject(signal.reason);
          this._next();
          return;
        }
        this._running += 1;
        this._perHost.set(host, (this._perHost.get(host) ?? 0) + 1);
        run()
          .then(resolve, reject)
          .finally(() => {
            this._running -= 1;
            this._perHost.set(host, (this._perHost.get(host) ?? 1) - 1);
            this._next();
          });
      };
      this._queue.push({ host, start });
      this._next();
    });
  }

  private _next(): void {
    for (let i = 0; i < this._queue.length && this._running < 24;) {
      const item = this._queue[i];
      if ((this._perHost.get(item.host) ?? 0) >= 6) {
        i += 1;
        continue;
      }
      this._queue.splice(i, 1);
      item.start();
    }
  }

  /** A resource, asked for again once when the connection failed rather
   *  than the server: a reset, a timeout, a refused socket. */
  private async _fetch(
    url: string,
    options: {
      headers: Record<string, string>;
      limit: number;
      page: string;
      id: number;
    },
  ): Promise<Answer> {
    try {
      return await this._fetchOnce(url, options);
    } catch (error) {
      if (!transient(error)) throw error;
      this._log('retrying', url);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return this._fetchOnce(url, options);
    }
  }

  private async _fetchOnce(
    url: string,
    options: {
      headers: Record<string, string>;
      limit: number;
      page: string;
      id: number;
    },
  ): Promise<Answer> {
    const stall = stallTimer(this._timeout);
    const id = options.id;
    try {
      const requestTime = Date.now();
      this._sent(id);
      // a page's subresource carries its cookies, as a browser's `no-cors`
      // request does (credentials mode `include`)
      const response = await this._exchange(
        url,
        { method: 'GET', headers: options.headers, signal: stall.signal },
        {
          credentials: 'include',
          origin: originOf(options.page),
          site: options.page,
          topLevel: false,
          initiator: null,
        },
      );
      const responseTime = Date.now();
      this._responded(id, response, url);
      stall.progress();
      const { type, charset } = contentType(
        response.headers.get('content-type'),
      );
      const chunks: Uint8Array[] = [];
      for await (const chunk of bodyOf(response, options.limit)) {
        stall.progress();
        chunks.push(chunk);
        if (id) this._tell({ type: 'data', id, chunk, time: Date.now() });
      }
      if (id) this._tell({ type: 'end', id, time: Date.now() });
      return {
        fetched: {
          url: response.url || url,
          status: response.status,
          type,
          charset,
          bytes: concat(chunks),
        },
        redirected: response.redirected,
        headers: [...response.headers.entries()],
        requestTime,
        responseTime,
      };
    } finally {
      stall.stop();
    }
  }
}

/** Whether a failed fetch failed on the way to the server, and may go
 *  through a second time. */
function transient(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; errors?: unknown[] } })
    ?.cause;
  const code = cause?.code ?? '';
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    Array.isArray(cause?.errors)
  );
}

/** A response's `Set-Cookie` fields, each apart. */
function setCookies(headers: ResponseLike['headers']): string[] {
  if (headers.getSetCookie) return headers.getSetCookie();
  return splitSetCookie(headers.get('set-cookie'));
}

/** `Set-Cookie` fields joined with commas, apart: an `Expires` date has a
 *  comma of its own, so a comma followed by what starts a cookie's name
 *  and its `=` is what starts another. */
function splitSetCookie(joined: string | null | undefined): string[] {
  return joined ? joined.split(/,(?=\s*[^;,=\s]+=)/) : [];
}

// --- WebSockets --------------------------------------------------------------

/** The slice of the runtime's `WebSocket` read here: the WHATWG API, and
 *  the `{ protocols, headers }` its constructor takes in Node's undici and
 *  in Bun, which a browser's does not. */
interface RuntimeWebSocket {
  binaryType: string;
  readonly protocol: string;
  readonly extensions: string;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: unknown; error?: unknown }) => void) | null;
  onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}
type RuntimeWebSocketClass = new (
  url: string,
  init: { protocols: string[]; headers: Record<string, string> },
) => RuntimeWebSocket;

/** What undici said each socket's opening handshake was answered with
 *  (`undici:websocket:open`, from Node 24), by the socket. */
let handshakes: WeakMap<object, Record<string, unknown>> | null = null;
let watchingHandshakes: Promise<void> | null = null;
function watchHandshakes(): Promise<void> {
  return (watchingHandshakes ??= nodeModule<{
    subscribe?(name: string, fn: (message: unknown) => void): void;
  }>('diagnostics_channel').then(
    (channels) => {
      const kept = (handshakes = new WeakMap());
      channels.subscribe?.('undici:websocket:open', (message) => {
        const m = message as {
          websocket?: object;
          handshakeResponse?: { headers?: Record<string, unknown> };
        };
        const headers = m?.handshakeResponse?.headers;
        if (m?.websocket && headers) kept.set(m.websocket, headers);
      });
    },
    () => {},
  ));
}

/** A connection over the runtime's `WebSocket`, its events told in the
 *  order they came. */
function runtimeSocket(
  request: WebSocketConnectRequest,
  events: WebSocketEvents,
  options: {
    userAgent: string;
    language: string;
    cookies: CookieJar | null;
    site: string;
  },
): WebSocketConnectionLike {
  const Native = (globalThis as { WebSocket?: RuntimeWebSocketClass })
    .WebSocket;
  if (typeof Native !== 'function') {
    setTimeout(
      () =>
        events.failed(
          `${request.url} was not opened: this runtime has no WebSocket.`,
        ),
      0,
    );
    return REFUSED_SOCKET;
  }
  const jar = options.cookies;
  const context = {
    http: true,
    sameSite: jar ? jar.sameSite(request.url, options.site) : false,
    method: 'GET',
  };
  const headers: Record<string, string> = {
    origin: request.origin,
    'user-agent': options.userAgent,
    'accept-language': options.language,
  };
  const cookie = jar?.header(request.url, context);
  if (cookie) headers.cookie = cookie;

  let ws: RuntimeWebSocket | null = null;
  /** Abandoned before the runtime's socket was made. */
  let abandoned = false;
  let done = false;
  /** What came after `open` and before it was told, which waits for it. */
  let held: (() => void)[] | null = null;
  const inOrder = (fn: () => void): void => {
    if (done) return;
    if (held) held.push(fn);
    else fn();
  };
  const make = (): void => {
    if (abandoned) return;
    let socket: RuntimeWebSocket;
    try {
      socket = new Native(request.url, {
        protocols: request.protocols,
        headers,
      });
    } catch (error) {
      done = true;
      events.failed(String((error as Error)?.message ?? error));
      return;
    }
    ws = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      // undici publishes the handshake's answer just after `open`
      held = [];
      void Promise.resolve().then(() => {
        const answered = handshakes?.get(socket)?.['set-cookie'];
        if (jar && answered) {
          const fields = Array.isArray(answered)
            ? answered.map(String)
            : splitSetCookie(String(answered));
          jar.store(request.url, fields, context);
        }
        const waiting = held ?? [];
        held = null;
        if (done) return;
        events.open({
          protocol: String(socket.protocol ?? ''),
          extensions: String(socket.extensions ?? ''),
        });
        for (const fn of waiting) {
          if (done) break;
          fn();
        }
      });
    };
    socket.onmessage = (event) =>
      inOrder(() => {
        const data = event.data;
        if (typeof data === 'string') events.message(data);
        else if (data instanceof ArrayBuffer) {
          events.message(new Uint8Array(data));
        } else if (ArrayBuffer.isView(data)) {
          events.message(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          );
        }
      });
    // an error is a failed connection, which is all the page hears of it
    // and whatever `close` follows it: Node 22's undici fires none after a
    // refused handshake, and leaves the socket CONNECTING
    socket.onerror = (event) =>
      inOrder(() => {
        done = true;
        const message = event?.message ?? (event?.error as Error)?.message;
        events.failed(message ? String(message) : 'the connection failed.');
      });
    socket.onclose = (event) =>
      inOrder(() => {
        done = true;
        events.closed(
          Number(event?.code ?? 1006),
          String(event?.reason ?? ''),
          event?.wasClean === true,
        );
      });
  };
  // the handshake's answer is watched for where there is a jar to keep its
  // cookies in, before the first socket is made
  if (jar) void watchHandshakes().then(make);
  else make();
  return {
    send(data) {
      ws?.send(data);
    },
    bufferedAmount: () => ws?.bufferedAmount ?? 0,
    close(code, reason) {
      if (!ws) {
        abandoned = true;
        return;
      }
      try {
        if (code === null) ws.close();
        else ws.close(code, reason);
      } catch {
        // a code the API does not take, 1001 as a document goes: the
        // closing handshake with no status
        ws.close();
      }
    },
  };
}

/** A response as the network answers it after following its redirects:
 *  the last one's, with where it ended and whether it was redirected. */
function answered(
  response: ResponseLike,
  url: string,
  redirected: boolean,
): ResponseLike {
  return {
    url,
    redirected,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
  };
}

/** What an `<object>` shows as a document of its own. */
const DOCUMENT_TYPES =
  /^(?:text\/html|text\/plain|text\/xml|application\/xml|application\/xhtml\+xml)$/;

/**
 * A fetched subresource as `<Html>` takes it back from `onResource`: a
 * stylesheet's bytes with the charset the server named, a font's bytes, an
 * image's, whatever its format — `<Html>` decodes what core's `<image>`
 * does, and an image it cannot read keeps its box as a declined one does.
 * The page's and the Zen Garden bench's (`scripts/zengarden/`) one
 * conversion.
 */
export function resourceResult(
  fetched: Fetched,
  kind: ResourceKind,
): ResourceResult | null {
  if (kind === 'stylesheet') {
    // a sheet served as anything but CSS is no sheet (HTML 4.2.4, "process
    // the linked resource"; Chrome holds to it outside quirks mode): Acid3
    // links a page served as text/html, and its heading went red
    if (fetched.type && fetched.type !== 'text/css') return null;
    return {
      kind: 'stylesheet',
      bytes: fetched.bytes,
      charset: fetched.charset ?? undefined,
      url: fetched.url,
    };
  }
  if (kind === 'font') return { kind: 'font', bytes: fetched.bytes };
  if (kind === 'script') {
    return {
      kind: 'script',
      bytes: fetched.bytes,
      charset: fetched.charset ?? undefined,
    };
  }
  // a page or text where an image was asked for is a document, which an
  // `<object>` shows as a frame and not its fallback: Acid3's second object
  // holds a page, and its third a picture it must not show
  if (DOCUMENT_TYPES.test(fetched.type)) return { kind: 'document' };
  return { kind: 'image', bytes: fetched.bytes };
}

/**
 * What a secure page may ask an insecure origin for (W3C Mixed Content,
 * Level 2): the URL to ask for, or null for nothing. An image or a video is
 * upgradeable, asked for over `https:` instead, as Chrome does; a
 * stylesheet or a font is blockable, and not asked for at all. So a page
 * served over `https:` that imports Google Fonts over `http:`, as the Zen
 * Garden's older designs do, is drawn in its fallback faces, as it is in a
 * browser. A loopback host is potentially trustworthy (Secure Contexts,
 * 3.2), and an insecure page asks for what it names.
 */
export function mixedContent(
  url: string,
  kind: ResourceKind | 'video',
  page: string,
): string | null {
  if (schemeOf(page) !== 'https' || schemeOf(url) !== 'http') return url;
  try {
    const host = new URL(url).hostname;
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '[::1]' ||
      /^127\./.test(host)
    ) {
      return url;
    }
  } catch {
    return null;
  }
  return kind === 'image' || kind === 'video'
    ? `https:${url.slice('http:'.length)}`
    : null;
}

/**
 * Containers the platform's player has no reader for — AVFoundation opens
 * MP4 and QuickTime, and neither WebM nor Ogg — so a `<source>` of one is
 * declined and the next asked for, rather than handed to a player that
 * fails on it.
 */
const UNPLAYABLE = new Set([
  'video/webm',
  'video/ogg',
  'audio/webm',
  'audio/ogg',
  'application/ogg',
]);

/** What the platform's player opens, by MIME type: AVFoundation's MP4 and
 *  QuickTime readers, its audio, and HTTP Live Streaming's playlists, which
 *  it plays from their URL as Safari does. */
const PLAYABLE = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/3gpp',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);

/**
 * What a media element's `canPlayType` answers where the platform's player
 * plays what the page's `<video>` asks for (`videoSource`): `'maybe'` for a
 * type it has a reader for — none of a type's codecs is checked, so never
 * `'probably'` — and `''` for the rest. A page asks before it loads a
 * stream: an HLS player with no `MediaSource` to feed sets the playlist as
 * the `src` only where this is not `''`.
 */
export function canPlayMedia(type: string): '' | 'maybe' {
  const media = type.split(';')[0].trim().toLowerCase();
  return PLAYABLE.has(media) ? 'maybe' : '';
}

/**
 * What a page's `<video>` plays, where the platform has a player (core's
 * `useSupports('mediaPlayback')`), and its `<audio>` the same: the URL
 * itself, for the player to open —
 * nothing here fetches it — under the rules a subresource is: upgraded on a
 * secure page, `file:` only for a `file:` page, and no other scheme. Null
 * where none of that holds, or its `<source type>` is a container the
 * player does not read, which leaves the video to its next source or its
 * poster.
 */
export function videoSource(
  url: string,
  type: string | undefined,
  page: string,
): string | null {
  const media = (type ?? '').split(';')[0].trim().toLowerCase();
  if (UNPLAYABLE.has(media)) return null;
  const allowed = mixedContent(url, 'video', page);
  if (allowed === null) return null;
  const scheme = schemeOf(allowed);
  if (scheme === 'file') return schemeOf(page) === 'file' ? allowed : null;
  return scheme === 'http' || scheme === 'https' ? allowed : null;
}

/**
 * Referrer-Policy's default, `strict-origin-when-cross-origin`: the whole
 * URL to the same origin, the origin alone to another, and nothing from a
 * secure page to an insecure one, or from anything but the web.
 */
function referrerFor(page: string, target: string): string | null {
  try {
    const from = new URL(page);
    const to = new URL(target);
    if (from.protocol !== 'http:' && from.protocol !== 'https:') return null;
    if (from.protocol === 'https:' && to.protocol === 'http:') return null;
    if (from.origin === to.origin) {
      from.hash = '';
      return from.href;
    }
    return `${from.origin}/`;
  } catch {
    return null;
  }
}

/** A page's origin as an `Origin` header says it: `null` for one that is
 *  not on the web, a `file:` page's among them. */
function originOf(page: string): string {
  try {
    const { protocol, origin } = new URL(page);
    return protocol === 'http:' || protocol === 'https:' ? origin : 'null';
  } catch {
    return 'null';
  }
}

function acceptLanguage(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  const language = locale.split('-')[0];
  return language === locale
    ? `${locale},*;q=0.5`
    : `${locale},${language};q=0.9,*;q=0.5`;
}

export function schemeOf(url: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  return m ? m[1].toLowerCase() : '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || schemeOf(url);
  } catch {
    return '';
  }
}

/**
 * A `data:` URL's body and type, as Fetch's data: URL processor reads them
 * (Fetch, 4.6 "data: URLs"): the type before the comma, the body after it
 * percent-decoded, and decoded again from base64 where the type ends in
 * `;base64` — forgiving-base64, which drops ASCII white space first. Null
 * for no data: URL, or a base64 body that is not base64.
 *
 * Read here rather than handed to `fetch`, which reads one too, because
 * Bun's does not read it as a browser does: it refuses a base64 body with
 * white space in it and names no type. Zen Garden 215 writes its robot and
 * the starburst behind it as `data:image/svg+xml;base64, PD94…`, a space
 * after the comma, and under Bun neither was drawn.
 */
export function readDataUrl(url: string): Fetched | null {
  let input: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'data:') return null;
    // the URL serialized without its fragment: a `#` ends the body
    parsed.hash = '';
    input = parsed.href.slice('data:'.length);
  } catch {
    return null;
  }
  const comma = input.indexOf(',');
  if (comma < 0) return null;
  let mime = input.slice(0, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  let bytes = percentDecode(input.slice(comma + 1));
  const base64 = /; *base64$/i.exec(mime);
  if (base64) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    try {
      binary = atob(binary);
    } catch {
      return null;
    }
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    mime = mime.slice(0, base64.index);
  }
  if (mime.startsWith(';')) mime = `text/plain${mime}`;
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const essence = new RegExp(
    `^[\\t\\n\\r ]*${token}/${token}[\\t\\n\\r ]*(;|$)`,
  );
  const { type, charset } = contentType(
    essence.test(mime) ? mime : 'text/plain;charset=US-ASCII',
  );
  return { url, status: 200, type, charset, bytes };
}

/** A string's UTF-8 bytes with each `%` and two hex digits the byte they
 *  name (URL, "percent-decode"). */
function percentDecode(input: string): Uint8Array {
  const bytes = new TextEncoder().encode(input);
  const out = new Uint8Array(bytes.length);
  const hex = (b: number) =>
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x46) ||
    (b >= 0x61 && b <= 0x66);
  let n = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x25 && hex(bytes[i + 1]) && hex(bytes[i + 2])) {
      out[n++] = parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16);
      i += 2;
    } else {
      out[n++] = bytes[i];
    }
  }
  return out.subarray(0, n);
}

/** `text/html; charset=UTF-8` → `text/html` and `utf-8`. */
export function contentType(header: string | null): {
  type: string;
  charset: string | null;
} {
  if (!header) return { type: '', charset: null };
  const [type, ...params] = header.split(';');
  let charset: string | null = null;
  for (const param of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(param);
    if (m) charset = m[1].toLowerCase();
  }
  return { type: type.trim().toLowerCase(), charset };
}

/** A response's body, a chunk at a time, cut off at `limit` bytes. */
async function* bodyOf(
  response: ResponseLike,
  limit: number,
): AsyncIterable<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) return;
      total += value.length;
      if (total > limit) {
        yield value.subarray(0, value.length - (total - limit));
        return;
      }
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * A signal that aborts once `ms` go by with nothing arriving: no answer
 * yet, or no chunk of its body since the last one (`progress`). A body that
 * keeps coming is never cut off, as a browser cuts none off: bounded whole,
 * a webmail's 575 KB script, read a chunk at a time by a process kept busy
 * by the page, was still arriving at the bound and failed, and the frame it
 * was for never ran.
 */
function stallTimer(ms: number): {
  signal: InstanceType<typeof AbortController>['signal'];
  progress(): void;
  stop(): void;
} {
  const controller = new AbortController();
  let timer: unknown = null;
  const arm = (): void => {
    timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          ),
        ),
      ms,
    );
    // as `AbortSignal.timeout`'s, it keeps no process alive
    (timer as { unref?(): void }).unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    progress() {
      if (timer === null) return;
      clearTimeout(timer as number);
      arm();
    },
    stop() {
      if (timer !== null) clearTimeout(timer as number);
      timer = null;
    },
  };
}

/** A body, each chunk of it telling `stall` that something arrived, and
 *  its end that nothing more will. */
async function* arriving(
  body: AsyncIterable<Uint8Array>,
  stall: ReturnType<typeof stallTimer>,
): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of body) {
      stall.progress();
      yield chunk;
    }
  } finally {
    stall.stop();
  }
}

/**
 * A response's body as it arrives, for a caller that hands it on a chunk at
 * a time: `bodyOf`, but with its reader taken at once, so `return()` lets
 * the connection go whether or not a chunk was ever asked for — a no-cors
 * answer and one CORS refuses are dropped unread.
 */
function bodyChunks(
  response: ResponseLike,
  limit: number,
): AsyncIterable<Uint8Array> {
  const reader = response.body?.getReader() ?? null;
  let total = 0;
  let done = !reader;
  const finish = (): void => {
    if (done) return;
    done = true;
    reader?.cancel().catch(() => {});
  };
  const iterator: AsyncIterator<Uint8Array> = {
    async next() {
      if (done || !reader) return { done: true, value: undefined };
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        finish();
        throw error;
      }
      if (read.done || !read.value) {
        done = true;
        return { done: true, value: undefined };
      }
      total += read.value.length;
      if (total > limit) {
        finish();
        return {
          done: false,
          value: read.value.subarray(0, read.value.length - (total - limit)),
        };
      }
      return { done: false, value: read.value };
    },
    async return() {
      finish();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** What `fetch` threw, as something to tell the person who typed the URL. */
function networkError(error: unknown, timedOut: boolean): NetworkError {
  if (timedOut) {
    return new NetworkError(
      'The server took too long to answer.',
      'ERR_TIMED_OUT',
    );
  }
  const cause = (error as { cause?: { code?: string; message?: string } })
    ?.cause;
  const code = cause?.code ?? 'ERR_FAILED';
  const messages: Record<string, string> = {
    ENOTFOUND: 'The server’s address could not be found.',
    EAI_AGAIN: 'The server’s address could not be looked up just now.',
    ECONNREFUSED: 'The server refused the connection.',
    ECONNRESET: 'The connection was reset.',
    ETIMEDOUT: 'The connection timed out.',
    EHOSTUNREACH: 'There is no route to the server.',
    ENETUNREACH: 'The network is unreachable.',
    CERT_HAS_EXPIRED: 'The server’s certificate has expired.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The server’s certificate is self-signed.',
    ERR_TLS_CERT_ALTNAME_INVALID:
      'The server’s certificate is for another name.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE:
      'The server’s certificate could not be verified.',
  };
  return new NetworkError(
    messages[code] ??
      cause?.message ??
      (error as Error)?.message ??
      'The page could not be loaded.',
    code,
  );
}

// --- file: -------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const TEXT = new Set([
  '.txt',
  '.md',
  '.js',
  '.mjs',
  '.ts',
  '.tsx',
  '.json',
  '.xml',
  '.yml',
  '.yaml',
  '.sh',
  '.c',
  '.h',
  '.py',
]);

/** The slice of `node:fs/promises` and `node:url` read here. */
interface FileSystem {
  stat(path: string): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
  }>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<{ name: string; isDirectory(): boolean }[]>;
}
interface UrlModule {
  fileURLToPath(url: string): string;
  pathToFileURL(path: string): { href: string };
}

const fileSystem = (): Promise<FileSystem> =>
  nodeModule<FileSystem>('fs/promises');
const urlModule = (): Promise<UrlModule> => nodeModule<UrlModule>('url');

function localType(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : '';
  return (
    TYPES[ext] ?? (TEXT.has(ext) ? 'text/plain' : 'application/octet-stream')
  );
}

async function readLocal(url: string, limit: number): Promise<Fetched | null> {
  const [fs, { fileURLToPath }] = await Promise.all([
    fileSystem(),
    urlModule(),
  ]);
  const path = fileURLToPath(url);
  const info = await fs.stat(path);
  if (!info.isFile() || info.size > limit) return null;
  return {
    url,
    status: 200,
    type: localType(path),
    charset: null,
    bytes: new Uint8Array(await fs.readFile(path)),
  };
}

async function localDocument(url: string): Promise<DocumentResponse> {
  const [fs, { fileURLToPath }] = await Promise.all([
    fileSystem(),
    urlModule(),
  ]);
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    throw new NetworkError('That is not a path on this machine.', 'ERR_FILE');
  }
  let info;
  try {
    info = await fs.stat(path);
  } catch {
    throw new NetworkError(
      `There is no file at ${path}.`,
      'ERR_FILE_NOT_FOUND',
    );
  }
  if (info.isDirectory()) {
    const listing = await directoryPage(path);
    return {
      url: url.endsWith('/') ? url : `${url}/`,
      redirected: false,
      status: 200,
      type: 'text/html',
      charset: 'utf-8',
      body: once(new TextEncoder().encode(listing)),
    };
  }
  const fetched = await readLocal(url, MAX_DOCUMENT);
  if (!fetched) {
    throw new NetworkError(`${path} is too large to open.`, 'ERR_FILE_TOO_BIG');
  }
  return { ...fetched, redirected: false, body: once(fetched.bytes) };
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/** A directory, as the page a browser makes of one. */
async function directoryPage(path: string): Promise<string> {
  const [fs, { pathToFileURL }] = await Promise.all([
    fileSystem(),
    urlModule(),
  ]);
  const entries = await fs.readdir(path, { withFileTypes: true });
  entries.sort(
    (a, b) =>
      Number(b.isDirectory()) - Number(a.isDirectory()) ||
      a.name.localeCompare(b.name),
  );
  const base = pathToFileURL(path.endsWith('/') ? path : `${path}/`).href;
  const rows = entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const name = e.isDirectory() ? `${e.name}/` : e.name;
      const href = new URL(encodeURIComponent(e.name), base).href;
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(name)}</a></li>`;
    })
    .join('\n');
  const up = new URL('..', base).href;
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Index of ${escapeHtml(path)}</title>
<style>
  body { font: 14px sans-serif; margin: 24px 32px; }
  h1 { font-size: 20px; font-weight: normal; }
  ul { list-style: none; padding: 0; columns: 2; }
  li { padding: 3px 0; }
</style></head><body>
<h1>Index of ${escapeHtml(path)}</h1>
<p><a href="${escapeHtml(up)}">Parent directory</a></p>
<ul>${rows}</ul>
</body></html>`;
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}

/** The encoding a document names in its first kilobyte: a byte order mark,
 *  or a `<meta charset>` or its `http-equiv` spelling (HTML 13.2.3.2). */
export function sniffCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : null;
}

/** Bytes as text in an encoding by its label, or UTF-8 where it names none
 *  the runtime knows. */
export function decodeText(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// --- for a component -----------------------------------------------------------

let shared: HtmlNetwork | null = null;

/** The network `useHtmlNetwork` uses where it is handed none: one a
 *  process, made the first time it is asked for. */
export function defaultHtmlNetwork(): HtmlNetwork {
  return (shared ??= new HtmlNetwork());
}

/** What `useHtmlNetwork` hands a component: `<Html onResource>`, and
 *  `<Html scripts={{ fetch, webTransport, webSocket }}>`. */
export interface HtmlNetworkSeams {
  onResource: (
    request: ResourceRequest,
  ) => Promise<ResourceResult | null> | null;
  fetch: (
    request: FetchRequest,
    signal: AbortSignalLike,
  ) => Promise<FetchResponse>;
  webTransport: HtmlWebTransport;
  webSocket: HtmlWebSocket;
  webRTC: HtmlWebRTC;
  /** The network's cookie jar, for `<Html scripts={{ cookies }}>`, where it
   *  has one. */
  cookies?: CookieJar;
}

/**
 * A document's network, for a component: `onResource` and a scripts'
 * `fetch` for the document at `page`, through `network` or the process's
 * (`defaultHtmlNetwork`). What the document asked for is let go when
 * `page` changes or the component unmounts. A `<video>`, and an
 * `<audio>`, is played by the platform's player where it has one
 * (`useSupports('mediaPlayback')`).
 *
 * ```tsx
 * const net = useHtmlNetwork(url);
 * <Html source={source} baseUrl={url} onResource={net.onResource}
 *   scripts={{ fetch: net.fetch }} />
 * ```
 */
export function useHtmlNetwork(
  page: string | null | undefined,
  network?: HtmlNetwork,
): HtmlNetworkSeams {
  const net = network ?? defaultHtmlNetwork();
  const plays = useSupports('mediaPlayback');
  const address = (page ?? '').split('#')[0];
  const controller = useMemo(() => new AbortController(), [net, address]);
  useEffect(() => () => controller.abort(), [controller]);
  return useMemo(
    () => ({
      onResource: net.resources(address, {
        signal: controller.signal,
        video: plays,
      }),
      fetch: net.fetcher(address),
      webTransport: net.webTransport,
      webSocket: net.webSockets(address),
      webRTC: net.webRTC,
      ...(net.cookies ? { cookies: net.cookies } : {}),
    }),
    [net, address, plays, controller],
  );
}
