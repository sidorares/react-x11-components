// A network for `<Html>`: everything `<Html>` deliberately does not do, for
// a host that wants the web's answers without writing its own fetching.
//
// `<Html>` asks for each resource a document needs through `onResource`,
// and a page's scripts for theirs through `scripts.fetch`, and fetches
// nothing itself (docs/components/html.md, "The seams"). This is one host's
// side of those seams — the example browser's, which it was written for —
// and it is where a policy lives, which an application takes or leaves:
//
//   - **One cache**, keyed by absolute URL. Back, or a second page from the
//     same site, costs no request for anything already here. It is bounded
//     by bytes and forgets the oldest first.
//   - **A few requests at a time**, six per host, the way browsers pace a
//     page's hundred images, rather than a burst the server throttles.
//   - **`file:` only for `file:` pages.** A page from the web naming
//     `file:///etc/passwd` as an image gets nothing; a local page gets its
//     local images.
//   - **No mixed content.** A secure page's stylesheets, fonts and scripts
//     come over a secure connection or not at all, and its images are
//     asked for over one (`mixedContent`), as a browser has it.
//   - **No cookies, no downloads.** Nothing is stored between requests.
//     Anything that is not a document, an image, a stylesheet, a font or a
//     script is not fetched at all — but a script's own `fetch`, of the
//     page's own origin, or of another where CORS lets the page read it
//     (the engine keeps to that; this keeps the host's headers on it).
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

import type { ResourceRequest, ResourceResult } from './resources.js';
import type { FetchRequest, FetchResponse } from './scripts/host.js';
import { nodeModule } from './scripts/platform.js';
import type {
  AbortControllerClass,
  AbortSignalLike,
  SetTimeout,
  UrlClass,
} from './scripts/platform.js';

declare const setTimeout: SetTimeout;
declare const URL: UrlClass;
declare const AbortController: AbortControllerClass;
declare const AbortSignal: {
  timeout(ms: number): AbortSignalLike & { readonly aborted: boolean };
  any(signals: AbortSignalLike[]): AbortSignalLike;
};
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new (label?: string) => {
  decode(bytes: Uint8Array): string;
};
declare const atob: (data: string) => string;

/** The slice of a `fetch` response read here. */
interface ResponseLike {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly redirected: boolean;
  readonly headers: {
    get(name: string): string | null;
    entries(): IterableIterator<[string, string]>;
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
    signal: AbortSignalLike;
    redirect: 'follow';
  },
) => Promise<ResponseLike>;

/** What an `HtmlNetwork` is made with. Every field has a default. */
export interface HtmlNetworkOptions {
  /** The `User-Agent` every request carries. Default `HTML_USER_AGENT`. */
  userAgent?: string;
  /** How many bytes the cache keeps before it forgets the oldest. Default
   *  256 MB. */
  cacheBytes?: number;
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
  /** Where each request and what came of it is told: a line of words a
   *  request. Default nowhere. */
  log?: (...parts: unknown[]) => void;
}

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
  private _cache = new Map<string, Promise<Loaded>>();
  private _sizes = new Map<string, number>();
  private _bytes = 0;
  private _limit: number;
  private _running = 0;
  private _perHost = new Map<string, number>();
  private _queue: Queued[] = [];
  private _language: string;
  private readonly _userAgent: string;
  private readonly _transport: HtmlTransport | null;
  private readonly _files: boolean;
  private _connectTimeout: number | null;
  private readonly _log: (...parts: unknown[]) => void;

  constructor(options: HtmlNetworkOptions = {}) {
    this._limit = options.cacheBytes ?? 256 * 1024 * 1024;
    this._language = acceptLanguage();
    this._userAgent = options.userAgent ?? HTML_USER_AGENT;
    this._transport = options.fetch ?? null;
    this._files = options.files ?? true;
    this._connectTimeout =
      options.connectTimeout === undefined ? 2500 : options.connectTimeout;
    this._log = options.log ?? (() => {});
  }

  /** The User-Agent this network's requests carry. */
  get userAgent(): string {
    return this._userAgent;
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
    const runtimeFetch = (globalThis as unknown as { fetch?: HtmlTransport })
      .fetch;
    if (!runtimeFetch) {
      throw new NetworkError('This runtime has no fetch.', 'ERR_FAILED');
    }
    return runtimeFetch(url, init);
  }

  /** How many requests are waiting or running. */
  get busy(): number {
    return this._running + this._queue.length;
  }

  /** Forget everything cached: a hard reload. */
  clear(): void {
    this._cache.clear();
    this._sizes.clear();
    this._bytes = 0;
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
    const hit = this._cache.get(url);
    if (hit) {
      // most recently used goes to the end, oldest is evicted first
      this._cache.delete(url);
      this._cache.set(url, hit);
      return hit;
    }
    // a `data:` URL is its own body, read here rather than asked of a
    // network it never goes to (`readDataUrl`)
    const made =
      scheme === 'data'
        ? Promise.resolve(readDataUrl(url))
        : this._paced(url, signal, () =>
            scheme === 'file'
              ? readLocal(url, MAX_RESOURCE)
              : this._fetch(url, {
                  accept: ACCEPT[kind],
                  referrer: referrerFor(page, url),
                  limit: MAX_RESOURCE,
                }),
          );
    const promise = made.then(
      (fetched): Loaded => {
        if (!fetched || fetched.status < 200 || fetched.status >= 300) {
          this._log(kind, fetched ? fetched.status : 'nothing to read', url);
          this._cache.delete(url);
          return fetched ? { status: fetched.status } : { refused: true };
        }
        this._log(
          kind,
          fetched.status,
          fetched.type,
          fetched.bytes.length,
          url,
        );
        this._remember(url, fetched.bytes.length);
        return { fetched };
      },
      (error): Loaded => {
        this._log(
          kind,
          'failed',
          url,
          (error as Error)?.message,
          (error as { cause?: unknown })?.cause,
        );
        this._cache.delete(url);
        return { failed: error };
      },
    );
    this._cache.set(url, promise);
    return promise;
  }

  /** Put a body in the cache that arrived some other way — a document that
   *  turned out to be an image, which its page then asks for. */
  seed(fetched: Fetched): void {
    this._cache.set(fetched.url, Promise.resolve({ fetched }));
    this._remember(fetched.url, fetched.bytes.length);
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
    const timer = AbortSignal.timeout(TIMEOUT);
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
    let response: ResponseLike;
    try {
      response = await this._send(url, {
        method: posting ? 'POST' : 'GET',
        body: posting ? post.body : undefined,
        signal: AbortSignal.any([signal, timer]),
        headers,
        redirect: 'follow',
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw networkError(error, timer.aborted);
    }
    const { type, charset } = contentType(response.headers.get('content-type'));
    return {
      url: response.url || url,
      redirected: response.redirected,
      status: response.status,
      type,
      charset,
      body: bodyOf(response, MAX_DOCUMENT),
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
    // a range of bytes is a range of the bytes as stored (Fetch 4.6)
    if ('range' in headers) headers['accept-encoding'] = 'identity';
    headers.origin = originOf(page);
    const referrer = referrerFor(page, request.url);
    if (referrer) headers.referer = referrer;
    const method = request.method.toUpperCase();
    const timer = AbortSignal.timeout(TIMEOUT);
    this._log('fetch', method, request.url);
    const response = await this._paced(request.url, signal, () =>
      this._send(request.url, {
        method,
        headers,
        body:
          method === 'GET' || method === 'HEAD'
            ? undefined
            : (request.bytes ?? request.body ?? undefined),
        signal: AbortSignal.any([signal, timer]),
        redirect: 'follow',
      }),
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of bodyOf(response, MAX_RESOURCE))
      chunks.push(chunk);
    const { charset } = contentType(response.headers.get('content-type'));
    return {
      url: response.url || request.url,
      status: response.status,
      statusText: response.statusText,
      redirected: response.redirected,
      headers: [...response.headers.entries()],
      charset,
      bytes: concat(chunks),
    };
  }

  /**
   * An `onResource` for the document at `page`: each image, stylesheet,
   * font and script it asks for through this network, under the rules at
   * the top, and handed back as `<Html>` takes it (`resourceResult`). A
   * `<video>`'s source is handed to the platform's player where `video` says
   * there is one (`videoSource`), and declined where not. `signal` stops
   * what the document asked for, for a host that lets it go.
   */
  resources(
    page: string,
    options: { signal?: AbortSignalLike; video?: boolean } = {},
  ): (request: ResourceRequest) => Promise<ResourceResult | null> | null {
    return (request) => {
      if (request.kind === 'video') {
        const src = options.video
          ? videoSource(request.url, request.type, page)
          : null;
        return src ? Promise.resolve({ kind: 'video', src }) : null;
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

  private _remember(url: string, size: number): void {
    const before = this._sizes.get(url) ?? 0;
    this._sizes.set(url, size);
    this._bytes += size - before;
    for (const key of this._cache.keys()) {
      if (this._bytes <= this._limit) break;
      // one still on its way has no size yet, and is not what fills this
      if (key === url || !this._sizes.has(key)) continue;
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
    options: { accept: string; referrer: string | null; limit: number },
  ): Promise<Fetched> {
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
    options: { accept: string; referrer: string | null; limit: number },
  ): Promise<Fetched> {
    const headers: Record<string, string> = {
      'user-agent': this._userAgent,
      accept: options.accept,
      'accept-language': this._language,
    };
    if (options.referrer) headers.referer = options.referrer;
    const response = await this._send(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'follow',
    });
    const { type, charset } = contentType(response.headers.get('content-type'));
    const chunks: Uint8Array[] = [];
    for await (const chunk of bodyOf(response, options.limit)) {
      chunks.push(chunk);
    }
    return {
      url: response.url || url,
      status: response.status,
      type,
      charset,
      bytes: concat(chunks),
    };
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
const UNPLAYABLE = new Set(['video/webm', 'video/ogg', 'application/ogg']);

/**
 * What a page's `<video>` plays, where the platform has a player (core's
 * `useSupports('mediaPlayback')`): the URL itself, for the player to open —
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
 *  `<Html scripts={{ fetch }}>`. */
export interface HtmlNetworkSeams {
  onResource: (
    request: ResourceRequest,
  ) => Promise<ResourceResult | null> | null;
  fetch: (
    request: FetchRequest,
    signal: AbortSignalLike,
  ) => Promise<FetchResponse>;
}

/**
 * A document's network, for a component: `onResource` and a scripts'
 * `fetch` for the document at `page`, through `network` or the process's
 * (`defaultHtmlNetwork`). What the document asked for is let go when
 * `page` changes or the component unmounts. A `<video>` is played by the
 * platform's player where it has one (`useSupports('mediaPlayback')`).
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
    }),
    [net, address, plays, controller],
  );
}
