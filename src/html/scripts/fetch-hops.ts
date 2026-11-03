// What a page's request does at each hop of its way (Fetch 4.1, 4.3 and
// 4.4), which the host works through a hop at a time (`DomHost._fetchFor`):
// a redirect is a hop, and CORS, a preflight, a page's cookies and what its
// `Origin` says are all asked again at it. Followed out of sight by the
// network, a page's `DELETE` that another origin's preflight let through went
// on to wherever that origin sent it, with no preflight of its own.
//
// Pure, so that every rule here is asserted with no document, and the origin
// it answers for is the host's own: nothing here reads anything of a page's.

declare const URL: new (
  url: string,
  base?: string,
) => {
  href: string;
  origin: string;
  protocol: string;
  username: string;
  password: string;
};

/** An address's origin, serialized: `null` for one that has none. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

/** A request CORS refused, which the page sees as a failed fetch and the
 *  console tells why. */
export class CorsError extends Error {}

/** A header's value, its last where there are several. */
export function headerOf(
  headers: [string, string][],
  name: string,
): string | null {
  let value: string | null = null;
  for (const [k, v] of headers) if (k.toLowerCase() === name) value = v;
  return value;
}

/** The CORS check (Fetch 4.10): whether an answer lets `origin` read it.
 *  Throws why it does not. */
export function corsCheck(
  headers: [string, string][],
  credentials: string,
  origin: string,
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
  if (allow !== origin) {
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

/** Whether a CORS check passes, for what only wants to know. */
export function corsAllows(
  headers: [string, string][],
  credentials: string,
  origin: string,
): boolean {
  try {
    corsCheck(headers, credentials, origin);
    return true;
  } catch {
    return false;
  }
}

/** The methods no page may send (Fetch 2.2.1, "forbidden method"). */
export function forbiddenMethod(method: string): boolean {
  return /^(?:connect|trace|track)$/i.test(method);
}

/**
 * The headers of a page's request CORS asks nothing of, where the user agent
 * set them for an `EventSource` (HTML 9.2.3): those two names on a `GET`, and
 * none of what a page set itself. What the facade says of this is a page's to
 * change, so it says no more than which of them to ask about.
 */
export function agentHeaders(
  named: unknown,
  method: string,
  headers: [string, string][],
): string[] | undefined {
  if (!Array.isArray(named) || method !== 'GET') return undefined;
  const out = named.filter(
    (name): name is string =>
      name === 'last-event-id' ||
      (name === 'cache-control' &&
        headerOf(headers, 'cache-control') === 'no-cache'),
  );
  return out.length ? out : undefined;
}

/**
 * Whether a request's way has left its origin and come through another that
 * is not its own (Fetch 3.1.5, "redirect-tainted origin"): what it asks of
 * the next is asked in nobody's name, as `Origin: null`, since a server
 * trusting the page's origin would otherwise be trusting whoever sent it on.
 */
export function redirectTainted(urls: string[], origin: string): boolean {
  for (let i = 1; i < urls.length; i += 1) {
    const from = originOf(urls[i - 1]);
    if (originOf(urls[i]) !== from && origin !== from) return true;
  }
  return false;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 20;

/** Whether a status is a redirect's (Fetch 2.2.6, "redirect status"). */
export function isRedirectStatus(status: number): boolean {
  return REDIRECTS.has(status);
}

/** The address a response sends a request on to, as it says it: null where it
 *  sends it nowhere. */
export function redirectOf(
  status: number,
  headers: [string, string][],
): string | null {
  return REDIRECTS.has(status) ? headerOf(headers, 'location') : null;
}

/** A request as it stands at a hop. */
export interface Hop {
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
  bytes?: Uint8Array;
  /** Whether nothing could send its body again (`FetchRequest.streamedBody`). */
  streamedBody?: boolean;
}

/**
 * The next hop of a request a redirect sent on (Fetch 4.4, "HTTP-redirect
 * fetch"), or a `TypeError` where it may not go: `hops` is how many there have
 * been, and `cors` whether another origin's answer is being read.
 */
export function nextHop(
  hop: Hop,
  location: string,
  status: number,
  hops: number,
  cors: { origin: string; tainting: boolean } | null,
): Hop {
  let next: InstanceType<typeof URL>;
  try {
    next = new URL(location, hop.url);
  } catch {
    throw new TypeError('Failed to fetch');
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new TypeError('Failed to fetch');
  }
  if (hops >= MAX_HOPS) throw new TypeError('Failed to fetch');
  // a page's reading another origin's answer, by way of a URL with a name in
  // it, is that name sent where the page could not otherwise have sent it
  const named = !!(next.username || next.password);
  if (named && cors && (cors.tainting || next.origin !== cors.origin)) {
    throw new TypeError('Failed to fetch');
  }
  if (hop.streamedBody && status !== 303) {
    throw new TypeError('Failed to fetch');
  }
  const out: Hop = { ...hop, url: next.href };
  if (
    ((status === 301 || status === 302) && hop.method === 'POST') ||
    (status === 303 && hop.method !== 'GET' && hop.method !== 'HEAD')
  ) {
    out.method = 'GET';
    out.body = null;
    delete out.bytes;
    delete out.streamedBody;
    out.headers = hop.headers.filter(
      ([k]) => !/^content-(?:encoding|language|location|type)$/i.test(k),
    );
  }
  if (originOf(hop.url) !== next.origin) {
    out.headers = out.headers.filter(
      ([k]) => k.toLowerCase() !== 'authorization',
    );
  }
  return out;
}
