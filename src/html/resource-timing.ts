/**
 * Resource Timing 2: what a fetch the document made says of itself, as the
 * `PerformanceResourceTiming` entry its page reads. Pure, and of no realm:
 * the network stamps a `ResourceClock` as a request goes (`HtmlNetwork`, a
 * hop at a time), the host times a page's own `fetch` the same way, and
 * `resourceEntry` makes the clock the entry's attributes, under the rules
 * that decide what another origin lets a page see of them.
 *
 * Two rules decide that, and they are not one. Whether the page may see
 * how long each part of the fetch took is the timing allow check (Fetch
 * 4.3.4, `Timing-Allow-Origin`), of every response on the way; what it may
 * see of the response itself — its status, its type, its sizes — is the
 * response's tainting: an opaque response says nothing of itself.
 */

/** One request on the way: the redirects first, then the one answered. */
export interface ResourceHop {
  url: string;
  /** When it was sent, on the clock a page reads (`performance.now()`). */
  sent: number;
  /** When its response's headers came, and what they were. */
  answered?: number;
  status?: number;
  headers?: [string, string][];
  /** A CORS preflight, which is in the fetch's time and no hop of it. */
  preflight?: boolean;
}

/**
 * What a host stamps as it fetches a resource, on the clock a page reads.
 * A host that knows no more leaves `hops` empty, and the entry says only
 * when the fetch began and ended.
 */
export interface ResourceClock {
  start: number;
  hops: ResourceHop[];
  /** When the last of the body came, or the fetch failed. */
  end?: number;
  /** How many bytes of body came, decoded. */
  bytes?: number;
  /** Where it was answered from without a request: a cache's. */
  cache?: 'memory' | 'disk';
  /** Asked about and answered `304`, a cached body used again. */
  revalidated?: boolean;
  /** No response came: a network error, or what a policy refused. */
  failed?: boolean;
}

/** What the request was, which the entry is read under. */
export interface ResourceContext {
  /** The URL it was asked for at, before any redirect. */
  name: string;
  initiatorType: string;
  /** The document's origin, serialized; `null` for an opaque one. */
  origin: string;
  /** Its request mode: `no-cors` for an element's, `cors` where it asks
   *  by CORS, `navigate` for a frame's document. */
  mode: 'cors' | 'no-cors' | 'same-origin' | 'navigate';
  renderBlocking?: boolean;
}

/** The attributes of a `PerformanceResourceTiming`, as they cross into a
 *  page's realm. */
export interface ResourceEntryRecord {
  name: string;
  startTime: number;
  duration: number;
  initiatorType: string;
  deliveryType: string;
  nextHopProtocol: string;
  workerStart: number;
  redirectStart: number;
  redirectEnd: number;
  fetchStart: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  connectEnd: number;
  secureConnectionStart: number;
  requestStart: number;
  firstInterimResponseStart: number;
  finalResponseHeadersStart: number;
  responseStart: number;
  responseEnd: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  responseStatus: number;
  renderBlockingStatus: string;
  contentType: string;
  contentEncoding: string;
  serverTiming: { name: string; duration: number; description: string }[];
}

/** What a response's head adds to its body on the wire, which a browser
 *  counts in `transferSize`: Chrome's figure. */
const HEADER_BYTES = 300;

const originOf = (url: string): string => {
  try {
    const { origin } = new URL(url);
    return origin;
  } catch {
    return 'null';
  }
};

declare const URL: new (url: string) => { origin: string; protocol: string };

const field = (
  headers: [string, string][] | undefined,
  name: string,
): string | null => {
  if (!headers) return null;
  const values = headers
    .filter(([k]) => k.toLowerCase() === name)
    .map(([, v]) => v);
  return values.length ? values.join(', ') : null;
};

/** Whether a response lets `origin` see its timing (Fetch 4.3.4, the TAO
 *  check, without what a flag carries from the hops before). */
const timingAllowed = (
  hop: ResourceHop,
  origin: string,
  tainted: boolean,
  basic: boolean,
  navigate: boolean,
): boolean => {
  const values = (field(hop.headers, 'timing-allow-origin') ?? '')
    .split(',')
    .map((v) => v.trim());
  if (values.includes('*')) return true;
  if (values.includes(tainted ? 'null' : origin)) return true;
  if (navigate && originOf(hop.url) !== origin) return false;
  return basic;
};

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A MIME type's essence, or null where it parses as none (MIME Sniffing
 *  4.4, "parse a MIME type", as far as the essence). */
const essenceOf = (value: string): string | null => {
  const s = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  const slash = s.indexOf('/');
  if (slash <= 0) return null;
  const type = s.slice(0, slash);
  const semi = s.indexOf(';', slash);
  const subtype = s
    .slice(slash + 1, semi < 0 ? undefined : semi)
    .replace(/[\t\n\r ]+$/, '');
  if (!TOKEN.test(type) || !subtype || !TOKEN.test(subtype)) return null;
  return `${type}/${subtype}`.toLowerCase();
};

/** A header's values, split at the commas outside quotes (Fetch 2.2.2,
 *  "get, decode, and split"). */
const splitValues = (value: string): string[] => {
  const out: string[] = [];
  let at = '';
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quoted) {
      at += c;
      if (c === '\\' && i + 1 < value.length) at += value[++i];
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      at += c;
    } else if (c === ',') {
      out.push(at.replace(/^[\t ]+|[\t ]+$/g, ''));
      at = '';
    } else at += c;
  }
  out.push(at.replace(/^[\t ]+|[\t ]+$/g, ''));
  return out;
};

/** A response's MIME type's essence (Fetch 3.4.1, "extract a MIME type"):
 *  the last of its `Content-Type` values that parses, and is not `*\/*`. */
const extractEssence = (headers: [string, string][] | undefined): string => {
  const value = field(headers, 'content-type');
  if (value === null) return '';
  let essence = '';
  for (const one of splitValues(value)) {
    const parsed = essenceOf(one);
    if (parsed === null || parsed === '*/*') continue;
    essence = parsed;
  }
  return essence;
};

const JAVASCRIPT = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

/** The types this user agent does something with, which an entry names as
 *  they are (Fetch, "minimize a supported MIME type"). */
const SUPPORTED = new Set([
  'text/html',
  'text/plain',
  'text/css',
  'text/vtt',
  'text/event-stream',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'font/woff',
  'font/woff2',
  'font/ttf',
  'font/otf',
  'font/sfnt',
  'application/font-woff',
  'application/wasm',
  'application/pdf',
  'application/octet-stream',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'multipart/form-data',
  'application/x-www-form-urlencoded',
]);

/** Fetch's "minimize a supported MIME type". */
export function minimizedMimeType(
  headers: [string, string][] | undefined,
): string {
  const essence = extractEssence(headers);
  if (!essence) return '';
  if (JAVASCRIPT.has(essence)) return 'text/javascript';
  const [type, subtype] = essence.split('/');
  if (
    essence === 'application/json' ||
    essence === 'text/json' ||
    subtype.endsWith('+json')
  ) {
    return 'application/json';
  }
  if (essence === 'image/svg+xml') return essence;
  if (
    essence === 'text/xml' ||
    essence === 'application/xml' ||
    subtype.endsWith('+xml')
  ) {
    return 'application/xml';
  }
  void type;
  return SUPPORTED.has(essence) ? essence : '';
}

/** The content codings this user agent knows (Resource Timing's
 *  `contentEncoding`). */
const CODINGS = new Set(['gzip', 'deflate', 'br', 'zstd', 'dcb', 'dcz']);

/** What `contentEncoding` says of a response's `Content-Encoding`: the one
 *  coding it names, `multiple` for more, `@unknown` for one not known, and
 *  nothing for none. */
export function contentEncodingOf(
  headers: [string, string][] | undefined,
): string {
  const value = field(headers, 'content-encoding');
  if (value === null) return '';
  const codings = value.split(',').map((v) => v.trim().toLowerCase());
  if (codings.length === 1 && codings[0] === '') return '';
  if (codings.length > 1) return 'multiple';
  return CODINGS.has(codings[0]) ? codings[0] : '@unknown';
}

/** A `Server-Timing` field's metrics (Server Timing, 3). */
const serverTimingOf = (
  headers: [string, string][] | undefined,
): ResourceEntryRecord['serverTiming'] => {
  const value = field(headers, 'server-timing');
  if (!value) return [];
  const out: ResourceEntryRecord['serverTiming'] = [];
  for (const metric of splitValues(value)) {
    const [head, ...params] = metric.split(';').map((p) => p.trim());
    if (!head || !TOKEN.test(head)) continue;
    let duration = 0;
    let description = '';
    let sawDur = false;
    let sawDesc = false;
    for (const param of params) {
      const eq = param.indexOf('=');
      const key = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase();
      let v = eq < 0 ? '' : param.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length > 1) {
        v = v.slice(1, -1).replace(/\\(.)/g, '$1');
      }
      if (key === 'dur' && !sawDur) {
        sawDur = true;
        const n = Number(v);
        duration = Number.isFinite(n) ? n : 0;
      } else if (key === 'desc' && !sawDesc) {
        sawDesc = true;
        description = v;
      }
    }
    out.push({ name: head, duration, description });
  }
  return out;
};

/**
 * The entry a fetch makes (Resource Timing 2, "mark resource timing", over
 * Fetch's timing info), or null for one that makes none: only a fetch over
 * HTTP(S) reports its timing.
 */
export function resourceEntry(
  clock: ResourceClock,
  context: ResourceContext,
): ResourceEntryRecord | null {
  if (!/^https?:/i.test(context.name)) return null;
  const { origin } = context;
  const navigate = context.mode === 'navigate';
  const hops = clock.hops.filter((h) => !h.preflight);
  const last = hops.at(-1);
  const end = Math.max(clock.end ?? clock.start, clock.start);
  // the timing allow check of every response on the way, and the tainting
  // of the last: an origin the request left makes it `null` for the rest
  let allowed = !clock.failed;
  let tainted = false;
  let basic = origin !== 'null';
  for (const hop of hops) {
    const own = originOf(hop.url) === origin && origin !== 'null';
    if (!own) basic = false;
    if (allowed && hop.headers) {
      allowed = timingAllowed(hop, origin, tainted, basic, navigate);
    }
    if (!own) tainted = true;
  }
  const finalUrl = last?.url ?? context.name;
  const sameOrigin = basic && originOf(finalUrl) === origin;
  // what the response says of itself: nothing where it is opaque, which
  // an element's request of another origin, and a frame's document of one,
  // is answered with
  const opaque =
    !!clock.failed || (!sameOrigin && (context.mode === 'no-cors' || navigate));
  const headers = last?.headers;
  const cached = !!clock.cache;
  const status = opaque ? 0 : (last?.status ?? (cached ? 200 : 0));
  const decoded = opaque ? 0 : (clock.bytes ?? 0);
  const encoding = opaque ? '' : contentEncodingOf(headers);
  const length = Number(field(headers, 'content-length'));
  const encoded = opaque
    ? 0
    : encoding && Number.isFinite(length) && length >= 0
      ? length
      : decoded;
  const base: ResourceEntryRecord = {
    name: context.name,
    startTime: clock.start,
    duration: end - clock.start,
    initiatorType: context.initiatorType,
    deliveryType: cached ? 'cache' : '',
    nextHopProtocol: '',
    workerStart: 0,
    redirectStart: 0,
    redirectEnd: 0,
    fetchStart: clock.start,
    domainLookupStart: 0,
    domainLookupEnd: 0,
    connectStart: 0,
    connectEnd: 0,
    secureConnectionStart: 0,
    requestStart: 0,
    firstInterimResponseStart: 0,
    finalResponseHeadersStart: 0,
    responseStart: 0,
    responseEnd: end,
    transferSize: 0,
    encodedBodySize: encoded,
    decodedBodySize: decoded,
    responseStatus: status,
    renderBlockingStatus: context.renderBlocking ? 'blocking' : 'non-blocking',
    contentType: opaque ? '' : minimizedMimeType(headers),
    contentEncoding: encoding,
    serverTiming: [],
  };
  if (!allowed) return base;
  // a redirect's time is the page's only where every hop let it see it;
  // the fetch proper starts with the request that was answered
  const redirected = hops.length > 1;
  const fetchStart = redirected ? last!.sent : clock.start;
  const requestStart = Math.max(last?.sent ?? fetchStart, fetchStart);
  const responseStart = Math.min(
    Math.max(last?.answered ?? end, requestStart),
    end,
  );
  const secure = /^https:/i.test(finalUrl) && !cached;
  return {
    ...base,
    nextHopProtocol: cached ? '' : 'http/1.1',
    redirectStart: redirected ? clock.start : 0,
    redirectEnd: redirected
      ? Math.max(hops.at(-2)!.answered ?? fetchStart, clock.start)
      : 0,
    fetchStart,
    // a connection the runtime keeps and reuses: no lookup and no connect
    // of this fetch's own, as a browser reports one it reused
    domainLookupStart: fetchStart,
    domainLookupEnd: fetchStart,
    connectStart: fetchStart,
    connectEnd: fetchStart,
    secureConnectionStart: secure ? fetchStart : 0,
    requestStart: cached ? fetchStart : requestStart,
    finalResponseHeadersStart: cached ? fetchStart : responseStart,
    responseStart: cached ? fetchStart : responseStart,
    transferSize: cached
      ? 0
      : clock.revalidated
        ? HEADER_BYTES
        : encoded + HEADER_BYTES,
    serverTiming: serverTimingOf(headers),
  };
}
