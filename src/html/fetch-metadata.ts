/**
 * Fetch Metadata (`Sec-Fetch-Site`, `-Mode`, `-Dest`, `-User`): what a
 * request says of how it was made, for a server to refuse what a page of
 * its own would not have asked for. Worked out afresh at each hop, as Fetch
 * appends them in "HTTP-network-or-cache fetch" to a copy of the request,
 * so a redirect to a URL that is not potentially trustworthy carries none,
 * and one that left the site on its way says so from there on.
 *
 * Pure, and imported by `network.ts`, which every request goes through: no
 * host and no realm.
 */
import type { ReferrerPolicy } from './referrer.js';
import type { UrlClass, UrlLike } from './scripts/platform.js';

declare const URL: UrlClass;

/** A request's mode (Fetch, "request mode"), as Fetch Metadata names it. */
export type FetchMode =
  'navigate' | 'same-origin' | 'no-cors' | 'cors' | 'websocket';

/** What a request says of how it was made. */
export interface FetchMetadata {
  mode: FetchMode;
  /** Its destination (Fetch, "request destination"): '' for a script's
   *  `fetch`, `document`, `iframe`, `image`, `style`, `script`, `worker`… */
  destination: string;
  /** Its origin (Fetch, "request origin"), serialized: 'null' for an
   *  opaque one. Null for a navigation the user made — an address typed, a
   *  bookmark, a reload — which is `Sec-Fetch-Site: none`. */
  origin: string | null;
  /** A navigation the user's activation made (`Sec-Fetch-User: ?1`). */
  user?: boolean;
  /** The URLs it came through before this request was made, where a hop at
   *  a time is made by someone else: a page's request, whose redirects the
   *  host follows (`fetch-hops.ts`). */
  through?: readonly string[];
  /** Where its `Referer` is worked out from at each hop, where the network
   *  follows its redirects itself: the URL it is made from, null for none.
   *  Absent, the `Referer` its header fields carry is sent as it is. */
  referrer?: string | null;
  /** The policy that is worked out under, which a redirect's
   *  `Referrer-Policy` changes from there on. */
  referrerPolicy?: ReferrerPolicy;
}

/** The site of a URL (HTML, "obtain a site"), for whoever has no public
 *  suffix list to ask: the scheme and the last two labels of the host. */
export type SiteOf = (url: string) => string | null;

/**
 * Whether a URL is potentially trustworthy (Secure Contexts, 3.1): an
 * origin that is `https:`, `wss:`, `file:` or this machine, and a `blob:`
 * URL's is the origin it names. A top-level `about:blank` and `data:` URL
 * have an opaque origin and are not, as Chromium and Firefox have them, where
 * 3.2 of the specification would have it otherwise.
 */
export function trustworthy(url: string): boolean {
  try {
    const at = new URL(url);
    if (at.protocol === 'blob:') return trustworthy(at.pathname);
    if (/^(https|wss|file):$/.test(at.protocol)) return true;
    if (at.protocol !== 'http:' && at.protocol !== 'ws:') return false;
    return /^(127(\.\d+){3}|\[::1\]|localhost|.*\.localhost)$/i.test(
      at.hostname,
    );
  } catch {
    return false;
  }
}

/**
 * A site with no public suffix list: the scheme, `ws` and `wss` read as
 * `http` and `https`, and the host's last two labels, an address whole. What
 * a `CookieJar` with no list answers too, so the two agree.
 */
export function plainSite(url: string): string | null {
  let at: UrlLike;
  try {
    at = new URL(url);
  } catch {
    return null;
  }
  const scheme = at.protocol.slice(0, -1).toLowerCase();
  const web = scheme === 'wss' ? 'https' : scheme === 'ws' ? 'http' : scheme;
  if (web !== 'http' && web !== 'https') return null;
  const host = at.hostname.toLowerCase();
  if (!host) return null;
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return `${web}://${host}`;
  }
  const labels = host.split('.');
  return `${web}://${labels.slice(-2).join('.')}`;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

/**
 * The `Sec-Fetch-*` header fields of a request to `url`, which came through
 * `before` on its way (Fetch Metadata, "append the Fetch metadata headers
 * for a request"): none to a URL that is not potentially trustworthy.
 */
export function metadataHeaders(
  url: string,
  metadata: FetchMetadata,
  before: readonly string[],
  siteOf: SiteOf = plainSite,
): Record<string, string> {
  if (!trustworthy(url)) return {};
  const headers: Record<string, string> = {
    'sec-fetch-dest': metadata.destination || 'empty',
    'sec-fetch-mode': metadata.mode,
    'sec-fetch-site': siteFor(url, metadata, before, siteOf),
  };
  if (metadata.mode === 'navigate' && metadata.user) {
    headers['sec-fetch-user'] = '?1';
  }
  return headers;
}

/** `Sec-Fetch-Site`, over every URL on the request's way (Fetch Metadata,
 *  "set the `Sec-Fetch-Site` header"). */
function siteFor(
  url: string,
  metadata: FetchMetadata,
  before: readonly string[],
  siteOf: SiteOf,
): string {
  const origin = metadata.origin;
  if (origin === null) return 'none';
  // an opaque origin is the same as nothing, and same-site with nothing
  const site = origin === 'null' ? null : siteOf(origin);
  let value = 'same-origin';
  for (const at of [...(metadata.through ?? []), ...before, url]) {
    if (origin !== 'null' && originOf(at) === origin) continue;
    value = 'same-site';
    if (site !== null && siteOf(at) === site) continue;
    return 'cross-site';
  }
  return value;
}

/** Whether a header field is one of these, which a request made again takes
 *  afresh. */
export function isMetadataHeader(name: string): boolean {
  return /^sec-fetch-(dest|mode|site|user)$/i.test(name);
}
