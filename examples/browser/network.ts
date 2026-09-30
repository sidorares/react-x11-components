// The browser's network: everything `<Html>` deliberately does not do.
//
// `<Html>` asks for each resource a page needs through `onResource` and
// fetches nothing itself (docs/components/html.md, "The seams"). This is the
// other side of that seam — the host — and it is where the policy lives:
//
//   - **One cache for the process**, keyed by absolute URL: a tab's own,
//     where each tab's page is a process of its own (page.tsx), and every
//     tab's where the pages run inline. Back, or a second page from the
//     same site, costs no request for anything already here. It is bounded
//     by bytes and forgets the oldest first.
//   - **A few requests at a time**, six per host, the way browsers pace a
//     page's hundred images, rather than a burst the server throttles.
//   - **`file:` only for `file:` pages.** A page from the web naming
//     `file:///etc/passwd` as an image gets nothing; a local page gets its
//     local images.
//   - **No mixed content.** A secure page's stylesheets and fonts come over
//     a secure connection or not at all, and its images are asked for over
//     one (`mixedContent`), as a browser has it.
//   - **No cookies, no scripts, no downloads.** Nothing is stored between
//     requests, and anything that is not a document, an image, a stylesheet
//     or a font is not fetched at all.
//   - **A form's POST says where it came from.** Its `Origin` and `Referer`
//     are the page's, as a browser's are, because a server tells a form's
//     POST from a forged one by them. What it cannot send is a session: with
//     no cookies, a form that needs one — a sign-in, most that carry a CSRF
//     token — is refused by its site. A search form, DuckDuckGo Lite's
//     among them, needs none.
//
// The User-Agent says what this is. Sites that sniff for a browser they
// know send what they send to an unknown one, which is usually the simpler
// page — and it is why Google Fonts answers with TrueType, one file a
// weight, which the text engines of both backends read.
import { readdir, readFile, stat } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ResourceResult } from '../../src/html/index.js';

// Happy Eyeballs (RFC 8305) gives each address family 250 ms in Node. A page
// being laid out holds the event loop longer than that, and a connection
// whose handshake came back meanwhile is counted as timed out when the loop
// gets to it: every stylesheet Wikipedia's article asked for failed with
// ETIMEDOUT while the article was laying itself out. A browser allows a
// connection seconds, and this one is an application that may say so.
setDefaultAutoSelectFamilyAttemptTimeout(2500);

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) react-x11-components/0.9 ' +
  '(example browser; +https://github.com/sidorares/react-x11-components)';

const ACCEPT = {
  document: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  // no WebP or AVIF: nothing here decodes them, and a server that
  // negotiates sends PNG or JPEG to a client that does not ask
  image: 'image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.5,*/*;q=0.1',
  stylesheet: 'text/css,*/*;q=0.1',
  font: 'font/woff2,font/woff,font/ttf,font/otf,*/*;q=0.5',
} as const;

export type ResourceKind = 'image' | 'stylesheet' | 'font';

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

/** `BROWSER_DEBUG=1` logs every request and what came of it. */
const DEBUG = !!process.env.BROWSER_DEBUG;
const log = (...parts: unknown[]): void => {
  if (DEBUG) console.error('[browser]', ...parts);
};

const MAX_DOCUMENT = 32 * 1024 * 1024;
const MAX_RESOURCE = 16 * 1024 * 1024;
const TIMEOUT = 30_000;

interface Queued {
  host: string;
  start: () => void;
}

export class Network {
  private _cache = new Map<string, Promise<Fetched | null>>();
  private _sizes = new Map<string, number>();
  private _bytes = 0;
  private _limit: number;
  private _running = 0;
  private _perHost = new Map<string, number>();
  private _queue: Queued[] = [];
  private _language: string;

  constructor(options: { cacheBytes?: number } = {}) {
    this._limit = options.cacheBytes ?? 256 * 1024 * 1024;
    this._language = acceptLanguage();
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
    signal?: AbortSignal,
  ): Promise<Fetched | null> {
    const allowed = mixedContent(url, kind, page);
    if (allowed === null) return Promise.resolve(null);
    if (allowed !== url) return this.resource(allowed, kind, page, signal);
    const scheme = schemeOf(url);
    if (scheme === 'file' && schemeOf(page) !== 'file') {
      return Promise.resolve(null);
    }
    if (!['http', 'https', 'data', 'file'].includes(scheme)) {
      return Promise.resolve(null);
    }
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
      (fetched) => {
        if (!fetched || fetched.status < 200 || fetched.status >= 300) {
          log(kind, fetched ? fetched.status : 'not made', url);
          this._cache.delete(url);
          return null;
        }
        log(kind, fetched.status, fetched.type, fetched.bytes.length, url);
        this._remember(url, fetched.bytes.length);
        return fetched;
      },
      (error) => {
        log(
          kind,
          'failed',
          url,
          (error as Error)?.message,
          (error as { cause?: unknown })?.cause,
        );
        this._cache.delete(url);
        return null;
      },
    );
    this._cache.set(url, promise);
    return promise;
  }

  /** Put a body in the cache that arrived some other way — a document that
   *  turned out to be an image, which its page then asks for. */
  seed(fetched: Fetched): void {
    this._cache.set(fetched.url, Promise.resolve(fetched));
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
    signal: AbortSignal,
    post: PostData | null = null,
  ): Promise<DocumentResponse> {
    const scheme = schemeOf(url);
    if (scheme === 'file') return localDocument(url);
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
      'user-agent': USER_AGENT,
      accept: ACCEPT.document,
      'accept-language': this._language,
    };
    const posting = post && (scheme === 'http' || scheme === 'https');
    if (posting) {
      headers['content-type'] = post.contentType;
      headers.origin = originOf(post.from);
      const referrer = referrerFor(post.from, url);
      if (referrer) headers.referer = referrer;
      log('POST', url, post.contentType, post.body.length);
    }
    let response: Response;
    try {
      response = await fetch(url, {
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
   *  made. */
  private _paced<T>(
    url: string,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T | null> {
    const host = hostOf(url);
    return new Promise<T | null>((resolve, reject) => {
      const start = (): void => {
        if (signal?.aborted) {
          resolve(null);
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
  ): Promise<Fetched | null> {
    try {
      return await this._fetchOnce(url, options);
    } catch (error) {
      if (!transient(error)) throw error;
      log('retrying', url);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return this._fetchOnce(url, options);
    }
  }

  private async _fetchOnce(
    url: string,
    options: { accept: string; referrer: string | null; limit: number },
  ): Promise<Fetched | null> {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: options.accept,
      'accept-language': this._language,
    };
    if (options.referrer) headers.referer = options.referrer;
    const response = await fetch(url, {
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

/**
 * A fetched subresource as `<Html>` takes it back from `onResource`: a
 * stylesheet's bytes with the charset the server named, a font's bytes, an
 * image's. WebP and AVIF are declined — nothing here decodes them, and a
 * declined image keeps its box. The page's and the Zen Garden bench's
 * (`scripts/zengarden/`) one conversion.
 */
export function resourceResult(
  fetched: Fetched,
  kind: ResourceKind,
): ResourceResult | null {
  if (kind === 'stylesheet') {
    return {
      kind: 'stylesheet',
      bytes: fetched.bytes,
      charset: fetched.charset ?? undefined,
      url: fetched.url,
    };
  }
  if (kind === 'font') return { kind: 'font', bytes: fetched.bytes };
  const b = fetched.bytes;
  const webp =
    b.length > 12 &&
    String.fromCharCode(b[0], b[1], b[2], b[3], b[8], b[9], b[10], b[11]) ===
      'RIFFWEBP';
  if (webp || fetched.type === 'image/avif') return null;
  return { kind: 'image', bytes: b };
}

/**
 * What a secure page may ask an insecure origin for (W3C Mixed Content,
 * Level 2): the URL to ask for, or null for nothing. An image is
 * upgradeable, asked for over `https:` instead, as Chrome does; a
 * stylesheet or a font is blockable, and not asked for at all. So a page
 * served over `https:` that imports Google Fonts over `http:`, as the Zen
 * Garden's older designs do, is drawn in its fallback faces, as it is in a
 * browser. A loopback host is potentially trustworthy (Secure Contexts,
 * 3.2), and an insecure page asks for what it names.
 */
export function mixedContent(
  url: string,
  kind: ResourceKind,
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
  return kind === 'image' ? `https:${url.slice('http:'.length)}` : null;
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
  response: Response,
  limit: number,
): AsyncIterable<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
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

function localType(path: string): string {
  const ext = extname(path).toLowerCase();
  return (
    TYPES[ext] ?? (TEXT.has(ext) ? 'text/plain' : 'application/octet-stream')
  );
}

async function readLocal(url: string, limit: number): Promise<Fetched | null> {
  const path = fileURLToPath(url);
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) return null;
  return {
    url,
    status: 200,
    type: localType(path),
    charset: null,
    bytes: new Uint8Array(await readFile(path)),
  };
}

async function localDocument(url: string): Promise<DocumentResponse> {
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    throw new NetworkError('That is not a path on this machine.', 'ERR_FILE');
  }
  let info;
  try {
    info = await stat(path);
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
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort(
    (a, b) =>
      Number(b.isDirectory()) - Number(a.isDirectory()) ||
      a.name.localeCompare(b.name),
  );
  const base = pathToFileURL(path.endsWith('/') ? path : `${path}/`);
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
