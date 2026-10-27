// The HTTP cache's rules, as a private cache keeps them (RFC 9111): which
// responses may be kept, how long one is fresh, what asks a server whether a
// stale one still holds, and what its answer changes. `HtmlNetwork` keeps a
// page's subresources by them, in its own memory and in a store it is
// handed (`HtmlHttpCacheStore`) — `HtmlProfile`'s keeps them on disk, for
// every process of a browser. Pure: no clock is read here but through `now`,
// and nothing happens as this module is imported.
import { parseCookieDate } from './cookies.js';

/** A response as the cache keeps it. */
export interface HtmlCachedResponse {
  /** When the request that brought it was sent, and when its answer came
   *  (RFC 9111, 4.2.3: `request_time` and `response_time`), in
   *  milliseconds since the epoch: what its age is reckoned from. */
  requestTime: number;
  responseTime: number;
  status: number;
  /** Its header fields, names lowercased, without `Set-Cookie` and without
   *  those about the connection or the coding the body came in
   *  (`keptHeaders`). */
  headers: [string, string][];
  /** The request header fields its `Vary` names, each as the request that
   *  brought it sent it, or null where it sent none: a later request is
   *  answered from it only where it would send the same. */
  vary: [string, string | null][];
  bytes: Uint8Array;
}

/** A kept response without its body: what a 304 changes. */
export type HtmlCachedHead = Omit<HtmlCachedResponse, 'bytes'>;

/**
 * Where an `HtmlNetwork` keeps responses past its own memory
 * (`HtmlNetworkOptions.httpCache`): `HtmlProfile`'s `httpCache`, on disk,
 * or an application's own. A key is the site of the document that asked
 * and the URL, so a store compares keys and reads nothing in them. Each
 * method may answer at once or with a promise; one that throws, or
 * rejects, is a store that kept nothing, and the request goes to the
 * network.
 */
export interface HtmlHttpCacheStore {
  get(
    key: string,
  ): HtmlCachedResponse | null | Promise<HtmlCachedResponse | null>;
  put(key: string, response: HtmlCachedResponse): void | Promise<void>;
  /** A 304 said the body still holds: its new header fields and times. */
  refresh(key: string, head: HtmlCachedHead): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  /** Forget every response: what clearing a browser's cache does. */
  clear?(): void | Promise<void>;
}

/** The statuses a response may be kept for here. The network asks for a
 *  subresource's 2xx alone, and of those only these are heuristically
 *  cacheable (RFC 9110, 15.1); a 206 is a range nothing here asks for. */
const KEPT_STATUSES = new Set([200, 203]);

/** Header fields a kept response leaves out (RFC 9111, 3.1): those about
 *  the connection; the coding the body arrived in and its length on the
 *  wire, since what is kept is the body decoded; and a cookie, which was
 *  stored as the response came and is nothing a later use sets again. */
const NOT_KEPT = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authentication-info',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
  'set-cookie2',
]);

/** How long a response with only a `Last-Modified` is taken to be fresh
 *  at the most (RFC 9111, 4.2.2 leaves the bound to the cache). */
const HEURISTIC_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** The value of a header field, its lines joined (RFC 9110, 5.3), or null
 *  for none. */
export function headerOf(
  headers: readonly (readonly [string, string])[],
  name: string,
): string | null {
  let out: string | null = null;
  for (const [n, v] of headers) {
    if (n.toLowerCase() !== name) continue;
    out = out === null ? v : `${out}, ${v}`;
  }
  return out;
}

/**
 * A `Cache-Control` field's directives (RFC 9111, 5.2): each name
 * lowercased, with its value unquoted, or null where it has none. A
 * directive named twice is invalid (4.2.1), and is answered as `INVALID`.
 */
export function cacheControl(field: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!field) return out;
  // an element at a time, empty ones (`a,,b`) included; a field this cannot
  // read further ends the directives at what it read
  const re =
    /\s*(?:([^\s=,]+)\s*(?:=\s*("(?:[^"\\]|\\.)*"|[^,]*))?)?\s*(?:,|$)/y;
  for (let m = re.exec(field); m && m[0]; m = re.exec(field)) {
    if (m[1] === undefined) continue;
    const name = m[1].toLowerCase();
    let value: string | null = m[2] === undefined ? null : m[2].trim();
    if (value !== null && value.startsWith('"')) {
      value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    out.set(name, out.has(name) ? INVALID : value);
  }
  return out;
}

/** What `cacheControl` answers for a directive given twice. */
export const INVALID = '\u0000invalid';

/** An HTTP-date (RFC 9110, 5.6.7) in milliseconds, read as leniently as a
 *  cookie's date is, or null for none. */
function dateOf(value: string | null): number | null {
  return value === null ? null : parseCookieDate(value);
}

/** A delta-seconds (RFC 9111, 1.2.2) in milliseconds, or null where it is
 *  not one. */
function seconds(value: string | null | undefined): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value), 2 ** 31) * 1000;
}

/**
 * How long a kept response is fresh for, in milliseconds (RFC 9111,
 * 4.2.1): its `max-age`, else its `Expires` less its `Date`, else a tenth
 * of the time since it was last modified, up to a week (4.2.2). A response
 * that says `no-cache` — in `Cache-Control`, or in a `Pragma` where there is
 * no `Cache-Control`, as Chrome reads one — is fresh for none of it, and is
 * asked about at each use; so is one whose freshness is written wrong. A
 * private cache reads no `s-maxage`.
 */
export function freshnessLifetime(head: HtmlCachedHead): number {
  const field = headerOf(head.headers, 'cache-control');
  const directives = cacheControl(field);
  if (directives.has('no-cache')) return 0;
  if (
    field === null &&
    /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(headerOf(head.headers, 'pragma') ?? '')
  ) {
    return 0;
  }
  if (directives.has('max-age')) return seconds(directives.get('max-age')) ?? 0;
  const date = dateOf(headerOf(head.headers, 'date')) ?? head.responseTime;
  const expires = headerOf(head.headers, 'expires');
  if (expires !== null) {
    const at = dateOf(expires);
    return at === null ? 0 : Math.max(0, at - date);
  }
  const modified = dateOf(headerOf(head.headers, 'last-modified'));
  if (modified !== null && modified < date && KEPT_STATUSES.has(head.status)) {
    return Math.min((date - modified) / 10, HEURISTIC_MAX_MS);
  }
  return 0;
}

/** How old a kept response is at `now`, in milliseconds (RFC 9111, 4.2.3):
 *  the age it came with, the time it took to come, and the time since. */
export function currentAge(head: HtmlCachedHead, now: number): number {
  const date = dateOf(headerOf(head.headers, 'date')) ?? head.responseTime;
  const apparent = Math.max(0, head.responseTime - date);
  const age = seconds(headerOf(head.headers, 'age')?.split(',')[0].trim()) ?? 0;
  const corrected = age + (head.responseTime - head.requestTime);
  return Math.max(apparent, corrected) + Math.max(0, now - head.responseTime);
}

/** Whether a kept response may answer a request at `now` without asking
 *  the server (RFC 9111, 4.2). */
export function isFresh(head: HtmlCachedHead, now: number): boolean {
  return freshnessLifetime(head) > currentAge(head, now);
}

/** The request header fields a kept response says the server chose it by
 *  (RFC 9111, 4.1), lowercased: `*` for every one. `Accept-Encoding` is
 *  left out, since the runtime's `fetch` sends the same one every time and
 *  what is kept is the body decoded. */
function varyNames(headers: readonly (readonly [string, string])[]): string[] {
  const field = headerOf(headers, 'vary');
  if (!field) return [];
  return field
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n && n !== 'accept-encoding');
}

/** A field's value as `Vary` compares it: its white space collapsed. */
const normal = (value: string): string => value.trim().replace(/\s+/g, ' ');

/**
 * A response as the cache keeps it, or null for one it does not (RFC 9111,
 * 3): a status this keeps; no `no-store`; a `Vary` this can answer — not
 * `*`, and not `Cookie`, which the network adds to a request after this is
 * asked; and something to keep it for — a time it is fresh for, or a
 * validator a stale one is asked about by. One with neither could answer
 * nothing later.
 *
 * `request` is the request's header fields as the network built them,
 * names lowercased: what `Vary` is read against.
 */
export function cachedResponse(
  answer: {
    status: number;
    headers: readonly (readonly [string, string])[];
    bytes: Uint8Array;
    requestTime: number;
    responseTime: number;
  },
  request: Readonly<Record<string, string>>,
): HtmlCachedResponse | null {
  if (!KEPT_STATUSES.has(answer.status)) return null;
  if (cacheControl(headerOf(answer.headers, 'cache-control')).has('no-store')) {
    return null;
  }
  const names = varyNames(answer.headers);
  if (names.includes('*') || names.includes('cookie')) return null;
  const head: HtmlCachedHead = {
    requestTime: answer.requestTime,
    responseTime: answer.responseTime,
    status: answer.status,
    headers: keptHeaders(answer.headers),
    vary: names.map((n) => [n, n in request ? normal(request[n]) : null]),
  };
  if (freshnessLifetime(head) <= 0 && !validates(head)) return null;
  return { ...head, bytes: answer.bytes };
}

/** A response's header fields as the cache keeps them: names lowercased,
 *  and those in `NOT_KEPT` left out. */
export function keptHeaders(
  headers: readonly (readonly [string, string])[],
): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of headers) {
    const n = name.toLowerCase();
    if (!NOT_KEPT.has(n)) out.push([n, value]);
  }
  return out;
}

/** Whether a kept response answers a request with these header fields
 *  (RFC 9111, 4.1): every field its `Vary` names, sent as it was sent. */
export function varyMatches(
  head: HtmlCachedHead,
  request: Readonly<Record<string, string>>,
): boolean {
  return head.vary.every(([name, value]) => {
    const now = name in request ? normal(request[name]) : null;
    return now === value;
  });
}

/** Whether a kept response has a validator to be asked about by. */
function validates(head: HtmlCachedHead): boolean {
  return (
    headerOf(head.headers, 'etag') !== null ||
    headerOf(head.headers, 'last-modified') !== null
  );
}

/** The header fields that ask a server whether a stale response still
 *  holds (RFC 9111, 4.3.1): its entity tag, and the time it was last
 *  modified. Null for a response with neither, which is asked for again
 *  whole. */
export function conditionalHeaders(
  head: HtmlCachedHead,
): Record<string, string> | null {
  const etag = headerOf(head.headers, 'etag');
  const modified = headerOf(head.headers, 'last-modified');
  if (etag === null && modified === null) return null;
  const out: Record<string, string> = {};
  if (etag !== null) out['if-none-match'] = etag;
  if (modified !== null) out['if-modified-since'] = modified;
  return out;
}

/**
 * A kept response as a 304 leaves it (RFC 9111, 4.3.4 and 3.2): each field
 * the 304 has in place of the kept one, and the times of the request that
 * asked. A `Date` or an `Age` the 304 does not have goes, rather than stay
 * to age the response by the time it was kept.
 */
export function freshened(
  head: HtmlCachedHead,
  notModified: readonly (readonly [string, string])[],
  requestTime: number,
  responseTime: number,
): HtmlCachedHead {
  const fresh = keptHeaders(notModified);
  const replaced = new Set(fresh.map(([n]) => n));
  replaced.add('date');
  replaced.add('age');
  return {
    ...head,
    requestTime,
    responseTime,
    headers: [...head.headers.filter(([n]) => !replaced.has(n)), ...fresh],
  };
}
