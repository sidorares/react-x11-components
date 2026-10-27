// A cookie jar for `<Html>`'s hosts: RFC 6265bis's storage model and its
// retrieval, with nothing of a network in it. `HtmlNetwork` takes one
// (`cookies`) and sends and stores cookies through it; `<Html scripts>`
// reaches it for `document.cookie` and `cookieStore` through the seam a
// network hands it (`HtmlDocumentCookies`). Neither has a jar unless an
// application makes one: `<Html>` stores nothing by construction.
//
// Where its cookies live is a seam too (`HtmlCookieStore`): memory by
// default, gone with the jar, or a profile on disk (`./profile.ts`) that
// every process of a browser shares — which is why the jar reads the store
// again whenever the store says another writer changed it.
//
// What the jar is told about a request is what 6265bis asks: whether it is
// the HTTP API or a script's, whether it is same-site with the site for
// cookies, and whether it is a top-level navigation and by which method.
// The network and the host work those out; the jar knows no documents.
//
// Pure, and light: nothing here touches a runtime's modules, and nothing
// happens as it is imported.
import type { UrlClass, UrlLike } from './scripts/platform.js';

declare const URL: UrlClass;

/** How a cookie is held back from another site's requests (6265bis
 *  5.6.7). `default` is a cookie that named none, which this jar treats
 *  as `none`, as Firefox and Safari do (no "Lax by default"). */
export type CookieSameSite = 'strict' | 'lax' | 'none' | 'default';

/** A cookie as a jar keeps it (6265bis 5.7). */
export interface HtmlCookie {
  name: string;
  value: string;
  /** The host it is for, lower-cased, with no leading dot. */
  domain: string;
  /** Whether it is for `domain` alone, or for its subdomains as well. */
  hostOnly: boolean;
  path: string;
  /** When it expires, in milliseconds since the epoch; null for a session
   *  cookie, which lives as long as the browser's session. */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
  /** When it was first set, in milliseconds since the epoch, kept when it
   *  is replaced: what orders two cookies of one path length. */
  created: number;
  /** When a request last carried it. */
  lastAccess: number;
}

/**
 * Where a jar keeps its cookies: memory by default, or something a browser's
 * processes share. Every method is synchronous, because `document.cookie`
 * is. A store several processes write tells the jar so through `changed`,
 * and the jar reads it all again — a browser holds a few thousand cookies at
 * most.
 */
export interface HtmlCookieStore {
  /** Every cookie kept. */
  load(): HtmlCookie[];
  /** Whether someone other than this jar changed what `load` reads since it
   *  last ran. Absent, nobody does. */
  changed?(): boolean;
  /** A cookie set, in place of one with its name, domain, `hostOnly` and
   *  path. */
  put(cookie: HtmlCookie): void;
  /** A cookie gone: the one with its name, domain, `hostOnly` and path. */
  delete(cookie: HtmlCookie): void;
}

/** What a request is, to the jar (6265bis 5.2, 5.8.3). */
export interface CookieContext {
  /** Whether it is the HTTP API — a request's headers — rather than a
   *  script's (`document.cookie`, `cookieStore`), which never sees an
   *  `HttpOnly` cookie and cannot set one. */
  http: boolean;
  /** Whether the request is same-site with its site for cookies, the
   *  top-level document's: a cookie held back from another site's requests
   *  is not sent on one that is not, nor set from one. */
  sameSite: boolean;
  /** Whether it navigates a top-level document — the address typed, a link
   *  followed — which a `Lax` cookie goes with from another site where the
   *  method is a safe one. */
  topLevel?: boolean;
  /** Its method. Default `GET`. */
  method?: string;
}

/** A cookie as `cookieStore` hands it to a page (Cookie Store API,
 *  `CookieListItem`). */
export interface CookieListItem {
  name: string;
  value: string;
  /** The domain it was set for, or null where it is the host's alone. */
  domain: string | null;
  path: string;
  expires: number | null;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  partitioned: boolean;
}

/**
 * What a document's `document.cookie` and `cookieStore` are read and written
 * through (`HtmlScripts.cookies`): a `CookieJar` is one. Each call names the
 * document's address and its top-level document's, whose site decides what
 * is held back from another site's frame (6265bis 5.2).
 */
export interface HtmlDocumentCookies {
  documentCookie(url: string, top: string | null): string;
  setDocumentCookie(url: string, text: string, top: string | null): void;
  list(url: string, top: string | null, name?: string): CookieListItem[];
  setFromInit(url: string, init: CookieInit, top: string | null): boolean;
}

/** What `cookieStore.set` asks for (Cookie Store API, `CookieInit`). */
export interface CookieInit {
  name: string;
  value: string;
  expires?: number | null;
  domain?: string | null;
  path?: string;
  sameSite?: 'strict' | 'lax' | 'none';
}

/** The public suffix of a host — `co.uk` of `www.example.co.uk` — or null
 *  where none is known. The Public Suffix List's answer, for the jar that
 *  is handed one. */
export type PublicSuffix = (host: string) => string | null;

/** What a `CookieJar` is made with. Every field has a default. */
export interface CookieJarOptions {
  /** Where its cookies are kept. Default memory. */
  store?: HtmlCookieStore;
  /**
   * The Public Suffix List, which keeps a site from setting a cookie for
   * all of `co.uk` and tells `example.co.uk` and `other.co.uk` apart as
   * sites. Default a list of none but the last label — `com`, `uk` — which
   * is right for most hosts and too lax for a suffix of two labels.
   * `publicSuffixList()` loads the real one from the optional peer
   * `tldts`, where it is installed.
   */
  publicSuffix?: PublicSuffix;
  /** Whether a request that is not same-site with its top-level document —
   *  another site's image, a frame, a `fetch` — sends and sets cookies. As
   *  6265bis has it, and Chrome by default: true. */
  thirdParty?: boolean;
  /** The clock. Default `Date.now`. */
  now?: () => number;
}

/** What 6265bis lets a browser cap, at Chrome's numbers. */
const MAX_PER_DOMAIN = 180;
const MAX_COOKIES = 3000;
/** How far ahead a cookie may expire (6265bis 5.6.1, 5.6.2): 400 days. */
const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_NAME_VALUE = 4096;
const MAX_ATTRIBUTE = 1024;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** The default `PublicSuffix`: the last label of a name, and nothing for an
 *  address. */
const lastLabel: PublicSuffix = (host) => {
  if (isAddress(host)) return null;
  const dot = host.lastIndexOf('.');
  return dot < 0 ? host : host.slice(dot + 1);
};

/** A store in memory: the default, gone with its jar. */
class MemoryCookies implements HtmlCookieStore {
  private _all = new Map<string, HtmlCookie>();
  load(): HtmlCookie[] {
    return [...this._all.values()];
  }
  put(cookie: HtmlCookie): void {
    this._all.set(cookieKey(cookie), cookie);
  }
  delete(cookie: HtmlCookie): void {
    this._all.delete(cookieKey(cookie));
  }
}

/** What identifies a cookie in a store: a second with the same replaces
 *  it (6265bis 5.7, step 22). */
export function cookieKey(cookie: {
  name: string;
  domain: string;
  hostOnly: boolean;
  path: string;
}): string {
  return `${cookie.domain}\u0000${cookie.hostOnly ? 1 : 0}\u0000${cookie.path}\u0000${cookie.name}`;
}

/** A URL as the jar reads it, or null for one it does not. */
interface Target {
  scheme: string;
  host: string;
  path: string;
  /** Whether a `Secure` cookie may be sent to it and set by it: `https:`,
   *  or a loopback host (Secure Contexts, "potentially trustworthy"). */
  secure: boolean;
}

function targetOf(url: string): Target | null {
  let parsed: UrlLike;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (
    scheme !== 'http' &&
    scheme !== 'https' &&
    scheme !== 'ws' &&
    scheme !== 'wss'
  ) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) return null;
  return {
    scheme,
    host,
    path: parsed.pathname || '/',
    secure: scheme === 'https' || scheme === 'wss' || loopback(host),
  };
}

function loopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

function isAddress(host: string): boolean {
  return host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

/** 6265bis 5.1.3, "domain-match". */
export function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true;
  return (
    !isAddress(host) &&
    host.length > domain.length &&
    host.endsWith(domain) &&
    host[host.length - domain.length - 1] === '.'
  );
}

/** 6265bis 5.1.4, "default-path". */
export function defaultPath(path: string): string {
  if (!path.startsWith('/')) return '/';
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

/** 6265bis 5.1.4, "path-match". */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/** A cookie-date (6265bis 5.1.1), in milliseconds since the epoch, or null
 *  where it is none. */
export function parseCookieDate(text: string): number | null {
  // delimiter = %x09 / %x20-2F / %x3B-40 / %x5B-60 / %x7B-7E
  const tokens = text.split(/[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/);
  let time: [number, number, number] | null = null;
  let day: number | null = null;
  let month: number | null = null;
  let year: number | null = null;
  for (const token of tokens) {
    if (!token) continue;
    if (time === null) {
      const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[^\d].*)?$/.exec(token);
      if (m) {
        time = [Number(m[1]), Number(m[2]), Number(m[3])];
        continue;
      }
    }
    if (day === null) {
      const m = /^(\d{1,2})(?:[^\d].*)?$/.exec(token);
      if (m) {
        day = Number(m[1]);
        continue;
      }
    }
    if (month === null) {
      const at = MONTHS.indexOf(token.slice(0, 3).toLowerCase());
      if (at >= 0) {
        month = at;
        continue;
      }
    }
    if (year === null) {
      const m = /^(\d{2,4})(?:[^\d].*)?$/.exec(token);
      if (m) {
        year = Number(m[1]);
        continue;
      }
    }
  }
  if (year !== null) {
    if (year >= 70 && year <= 99) year += 1900;
    else if (year >= 0 && year <= 69) year += 2000;
  }
  if (time === null || day === null || month === null || year === null) {
    return null;
  }
  if (day < 1 || day > 31 || year < 1601) return null;
  if (time[0] > 23 || time[1] > 59 || time[2] > 59) return null;
  const ms = Date.UTC(year, month, day, time[0], time[1], time[2]);
  // a day the month does not have — the 31st of April — is no date
  if (new Date(ms).getUTCDate() !== day) return null;
  return ms;
}

/** A `Set-Cookie` as 6265bis 5.6 parses it, before the storage model
 *  decides anything about it. */
export interface ParsedCookie {
  name: string;
  value: string;
  /** From `Max-Age`, which wins, or `Expires`; null where neither said. */
  expires: number | null;
  /** The `Domain` attribute, lower-cased with no leading dot, or null. */
  domain: string | null;
  path: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
}

/** One `Set-Cookie` string parsed (6265bis 5.6), or null where it is to be
 *  ignored whole. */
export function parseSetCookie(
  text: string,
  now: number = Date.now(),
): ParsedCookie | null {
  // a control character but a tab ignores the whole string
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(text)) return null;
  const semicolon = text.indexOf(';');
  const pair = semicolon < 0 ? text : text.slice(0, semicolon);
  const rest = semicolon < 0 ? '' : text.slice(semicolon + 1);
  const equals = pair.indexOf('=');
  const trim = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, '');
  const name = equals < 0 ? '' : trim(pair.slice(0, equals));
  const value = trim(equals < 0 ? pair : pair.slice(equals + 1));
  if (name.length + value.length > MAX_NAME_VALUE) return null;
  if (!name && !value) return null;
  const cookie: ParsedCookie = {
    name,
    value,
    expires: null,
    domain: null,
    path: null,
    secure: false,
    httpOnly: false,
    sameSite: 'default',
  };
  let maxAge: number | null = null;
  let expires: number | null = null;
  for (const av of rest ? rest.split(';') : []) {
    const eq = av.indexOf('=');
    const key = trim(eq < 0 ? av : av.slice(0, eq)).toLowerCase();
    const raw = eq < 0 ? '' : trim(av.slice(eq + 1));
    if (raw.length > MAX_ATTRIBUTE) continue;
    switch (key) {
      case 'expires': {
        const at = parseCookieDate(raw);
        if (at !== null) expires = Math.min(at, now + MAX_AGE_MS);
        break;
      }
      case 'max-age': {
        if (!/^-?\d+$/.test(raw)) break;
        const seconds = Number(raw);
        maxAge =
          seconds <= 0 ? -Infinity : now + Math.min(seconds * 1000, MAX_AGE_MS);
        break;
      }
      case 'domain':
        // an empty one is ignored, as 6265bis asks a user agent to
        if (raw) cookie.domain = raw.replace(/^\./, '').toLowerCase();
        break;
      case 'path':
        cookie.path = raw.startsWith('/') ? raw : null;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite': {
        const v = raw.toLowerCase();
        cookie.sameSite =
          v === 'strict' || v === 'lax' || v === 'none' ? v : 'default';
        break;
      }
    }
  }
  cookie.expires = maxAge !== null ? maxAge : expires;
  return cookie;
}

/**
 * A cookie jar: RFC 6265bis's storage model (5.7) and retrieval (5.8),
 * over a store that may be shared (see the top). One is enough for a
 * browser; every document it shows sends its cookies through it.
 */
export class CookieJar implements HtmlDocumentCookies {
  private readonly _store: HtmlCookieStore;
  private _publicSuffix: PublicSuffix;
  private readonly _thirdParty: boolean;
  private readonly _now: () => number;
  /** The cookies, by domain. */
  private _byDomain = new Map<string, HtmlCookie[]>();
  private _count = 0;
  private _lastCreated = 0;
  private _listeners = new Set<(changed: HtmlCookie[]) => void>();
  /** Whether the store was read: at the first request, not as the jar is
   *  made, so a browser can tidy its profile between the two. */
  private _loaded = false;

  constructor(options: CookieJarOptions = {}) {
    this._store = options.store ?? new MemoryCookies();
    this._publicSuffix = options.publicSuffix ?? lastLabel;
    this._thirdParty = options.thirdParty ?? true;
    this._now = options.now ?? (() => Date.now());
  }

  /** Hand the jar the Public Suffix List once it is loaded. */
  set publicSuffix(list: PublicSuffix) {
    this._publicSuffix = list;
  }

  /** Every cookie the jar holds that has not expired. */
  all(): HtmlCookie[] {
    this._fresh();
    const now = this._now();
    const out: HtmlCookie[] = [];
    for (const list of this._byDomain.values()) {
      for (const c of list) if (!expired(c, now)) out.push({ ...c });
    }
    return out;
  }

  /** Forget every cookie, or every one whose domain is `host` or under
   *  it. */
  clear(host?: string): void {
    this._fresh();
    const gone: HtmlCookie[] = [];
    for (const [domain, list] of this._byDomain) {
      if (host && !domainMatch(domain, host)) continue;
      for (const c of list) {
        this._store.delete(c);
        gone.push(c);
      }
      this._byDomain.delete(domain);
      this._count -= list.length;
    }
    if (gone.length) this._tell(gone);
  }

  /** Told of each change a script or a response made, by this jar. */
  watch(listener: (changed: HtmlCookie[]) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * The site of a URL (HTML, "obtain a site"): its scheme and registrable
   * domain — `https://example.co.uk` for `https://www.example.co.uk/a` —
   * or null for an opaque origin. Two URLs are same-site when they have
   * the same site.
   */
  site(url: string): string | null {
    const target = targetOf(url);
    if (!target) return null;
    const scheme =
      target.scheme === 'wss'
        ? 'https'
        : target.scheme === 'ws'
          ? 'http'
          : target.scheme;
    return `${scheme}://${this._registrable(target.host)}`;
  }

  /** Whether two URLs are same-site (schemeful). */
  sameSite(a: string, b: string | null): boolean {
    if (b === null) return false;
    const site = this.site(a);
    return site !== null && site === this.site(b);
  }

  /** The `Cookie` header for a request to `url`, or '' for none (6265bis
   *  5.8.3). */
  header(url: string, context: CookieContext): string {
    return this._retrieve(url, context)
      .map((c) => (c.name ? `${c.name}=${c.value}` : c.value))
      .join('; ');
  }

  /** The `Set-Cookie` fields of a response from `url`, stored (6265bis
   *  5.7). */
  store(url: string, fields: readonly string[], context: CookieContext): void {
    if (!fields.length) return;
    this._fresh();
    const changed: HtmlCookie[] = [];
    for (const field of fields) {
      const made = this._set(url, field, context);
      if (made) changed.push(made);
    }
    this._evict();
    if (changed.length) this._tell(changed);
  }

  /** `document.cookie` read by a document at `url`, under the top-level
   *  document at `top`: its cookies but the `HttpOnly` ones (HTML 3.1.3). */
  documentCookie(url: string, top: string | null): string {
    return this.header(url, { http: false, sameSite: this.sameSite(url, top) });
  }

  /** `document.cookie` written by a document at `url`. */
  setDocumentCookie(url: string, text: string, top: string | null): void {
    this.store(url, [text], { http: false, sameSite: this.sameSite(url, top) });
  }

  /** The cookies `cookieStore` lists for a document or worker at `url`,
   *  all of them or those named `name`. */
  list(url: string, top: string | null, name?: string): CookieListItem[] {
    const sameSite = this.sameSite(url, top);
    return this._retrieve(url, { http: false, sameSite })
      .filter((c) => name === undefined || c.name === name)
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.hostOnly ? null : c.domain,
        path: c.path,
        expires: c.expires,
        secure: c.secure,
        sameSite: c.sameSite === 'default' ? 'none' : c.sameSite,
        partitioned: false,
      }));
  }

  /** `cookieStore.set`, by its `CookieInit` (Cookie Store API, "set a
   *  cookie"): whether it was stored. */
  setFromInit(url: string, init: CookieInit, top: string | null): boolean {
    const sameSite = this.sameSite(url, top);
    const target = targetOf(url);
    if (!target) return false;
    let text = `${init.name}=${init.value}`;
    if (init.domain) text += `; Domain=${init.domain}`;
    text += `; Path=${init.path ?? '/'}`;
    if (init.expires !== null && init.expires !== undefined) {
      text += `; Expires=${new Date(init.expires).toUTCString()}`;
    }
    text += `; SameSite=${init.sameSite ?? 'strict'}`;
    if (target.secure) text += '; Secure';
    this._fresh();
    const made = this._set(url, text, { http: false, sameSite });
    this._evict();
    if (made) this._tell([made]);
    return made !== null;
  }

  /** The domain a `Domain` attribute leaves a cookie: the host's own
   *  registrable domain at the widest. */
  private _registrable(host: string): string {
    if (isAddress(host)) return host;
    const suffix = this._publicSuffix(host);
    if (!suffix || suffix === host) return host;
    if (!host.endsWith(`.${suffix}`)) return host;
    const above = host.slice(0, host.length - suffix.length - 1);
    const label = above.slice(above.lastIndexOf('.') + 1);
    return `${label}.${suffix}`;
  }

  private _isPublicSuffix(domain: string): boolean {
    if (isAddress(domain)) return false;
    return this._publicSuffix(domain) === domain;
  }

  /** The storage model for one `Set-Cookie` (6265bis 5.7): the cookie
   *  stored, or null where it was ignored. A cookie that expired is stored
   *  as a deletion, and answered. */
  private _set(
    url: string,
    text: string,
    context: CookieContext,
  ): HtmlCookie | null {
    const target = targetOf(url);
    if (!target) return null;
    if (!context.sameSite && !context.topLevel && !this._thirdParty) {
      return null;
    }
    const now = this._now();
    const parsed = parseSetCookie(text, now);
    if (!parsed) return null;
    let domain = parsed.domain ?? '';
    if (domain && this._isPublicSuffix(domain)) {
      // a public suffix is a host-only cookie where it is the host, and no
      // cookie where it is not
      if (domain !== target.host) return null;
      domain = '';
    }
    let hostOnly: boolean;
    if (domain) {
      if (!domainMatch(target.host, domain)) return null;
      hostOnly = false;
    } else {
      hostOnly = true;
      domain = target.host;
    }
    const cookie: HtmlCookie = {
      name: parsed.name,
      value: parsed.value,
      domain,
      hostOnly,
      path: parsed.path ?? defaultPath(target.path),
      expires: parsed.expires,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      sameSite: parsed.sameSite,
      created: 0,
      lastAccess: now,
    };
    if (cookie.secure && !target.secure) return null;
    if (cookie.httpOnly && !context.http) return null;
    // "leave secure cookies alone": an insecure origin overwrites none
    if (!cookie.secure && !target.secure && this._shadowsSecure(cookie)) {
      return null;
    }
    // a cookie held back from other sites is not set by one, but by a
    // top-level navigation (a `default` one is `none`'s here)
    const restricted =
      cookie.sameSite === 'strict' || cookie.sameSite === 'lax';
    if (
      restricted &&
      !context.sameSite &&
      (!context.http || !context.topLevel)
    ) {
      return null;
    }
    if (cookie.sameSite === 'none' && !cookie.secure) return null;
    // the prefixes (6265bis 4.1.3), case-insensitively, and a nameless
    // cookie that would read as one
    const prefixed = (cookie.name || cookie.value).toLowerCase();
    if (!cookie.name && /^__(secure|host)-/.test(prefixed)) return null;
    if (prefixed.startsWith('__secure-') && !cookie.secure) return null;
    if (
      prefixed.startsWith('__host-') &&
      (!cookie.secure || !cookie.hostOnly || cookie.path !== '/')
    ) {
      return null;
    }
    const list = this._byDomain.get(domain) ?? [];
    const key = cookieKey(cookie);
    const at = list.findIndex((c) => cookieKey(c) === key);
    if (at >= 0) {
      const old = list[at];
      if (old.httpOnly && !context.http) return null;
      cookie.created = old.created;
      list.splice(at, 1);
      this._count -= 1;
    } else {
      cookie.created = this._stamp(now);
    }
    if (expired(cookie, now)) {
      if (at >= 0) this._store.delete(cookie);
      if (!list.length) this._byDomain.delete(domain);
      return at >= 0 ? cookie : null;
    }
    list.push(cookie);
    this._byDomain.set(domain, list);
    this._count += 1;
    this._store.put(cookie);
    return cookie;
  }

  /** Whether a cookie an insecure origin sets would overwrite a secure
   *  one (6265bis 5.7, step 16). */
  private _shadowsSecure(cookie: HtmlCookie): boolean {
    for (const list of this._byDomain.values()) {
      for (const c of list) {
        if (
          c.secure &&
          c.name === cookie.name &&
          (domainMatch(c.domain, cookie.domain) ||
            domainMatch(cookie.domain, c.domain)) &&
          pathMatch(c.path, cookie.path)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** The cookies a request carries, in 6265bis 5.8.3's order: longer paths
   *  first, then earlier creation. */
  private _retrieve(url: string, context: CookieContext): HtmlCookie[] {
    const target = targetOf(url);
    if (!target) return [];
    if (!context.sameSite && !context.topLevel && !this._thirdParty) return [];
    this._fresh();
    const now = this._now();
    const method = (context.method ?? 'GET').toUpperCase();
    const out: HtmlCookie[] = [];
    // the host and every domain above it
    let domain = target.host;
    for (;;) {
      for (const c of this._byDomain.get(domain) ?? []) {
        if (expired(c, now)) continue;
        if (
          c.hostOnly
            ? c.domain !== target.host
            : !domainMatch(target.host, c.domain)
        ) {
          continue;
        }
        if (!pathMatch(target.path, c.path)) continue;
        if (c.secure && !target.secure) continue;
        if (c.httpOnly && !context.http) continue;
        if (!context.sameSite) {
          if (c.sameSite === 'strict') continue;
          if (
            c.sameSite === 'lax' &&
            !(context.http && context.topLevel && SAFE_METHODS.has(method))
          ) {
            continue;
          }
        }
        out.push(c);
      }
      if (isAddress(domain)) break;
      const dot = domain.indexOf('.');
      if (dot < 0) break;
      domain = domain.slice(dot + 1);
    }
    out.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    for (const c of out) c.lastAccess = now;
    return out;
  }

  /** A creation time later than every other this jar gave, so that two
   *  cookies set in one millisecond keep the order they were set in. */
  private _stamp(now: number): number {
    this._lastCreated = Math.max(now, this._lastCreated + 0.001);
    return this._lastCreated;
  }

  /** Expired cookies dropped, then the least recently used past the caps
   *  (6265bis 5.7.3). */
  private _evict(): void {
    const now = this._now();
    for (const [domain, list] of this._byDomain) {
      const kept = list.filter((c) => {
        if (!expired(c, now)) return true;
        this._store.delete(c);
        this._count -= 1;
        return false;
      });
      if (kept.length > MAX_PER_DOMAIN) {
        kept.sort((a, b) => a.lastAccess - b.lastAccess);
        for (const c of kept.splice(0, kept.length - MAX_PER_DOMAIN)) {
          this._store.delete(c);
          this._count -= 1;
        }
      }
      if (kept.length) this._byDomain.set(domain, kept);
      else this._byDomain.delete(domain);
    }
    if (this._count <= MAX_COOKIES) return;
    const every = [...this._byDomain.values()].flat();
    every.sort((a, b) => a.lastAccess - b.lastAccess);
    for (const c of every.slice(0, this._count - MAX_COOKIES)) {
      const list = this._byDomain.get(c.domain)!;
      list.splice(list.indexOf(c), 1);
      if (!list.length) this._byDomain.delete(c.domain);
      this._store.delete(c);
      this._count -= 1;
    }
  }

  /** The store read again, where someone else wrote it. */
  private _fresh(): void {
    if (!this._loaded || this._store.changed?.()) this._reload();
  }

  private _reload(): void {
    this._loaded = true;
    this._byDomain.clear();
    this._count = 0;
    for (const c of this._store.load()) {
      const list = this._byDomain.get(c.domain);
      if (list) list.push(c);
      else this._byDomain.set(c.domain, [c]);
      this._count += 1;
      this._lastCreated = Math.max(this._lastCreated, c.created);
    }
  }

  private _tell(changed: HtmlCookie[]): void {
    for (const listener of this._listeners) {
      try {
        listener(changed.map((c) => ({ ...c })));
      } catch {
        // a listener's throw is its own
      }
    }
  }
}

function expired(cookie: HtmlCookie, now: number): boolean {
  return cookie.expires !== null && cookie.expires <= now;
}

/** The slice of `tldts` read here: an optional peer. */
interface TldtsModule {
  getPublicSuffix(
    host: string,
    options?: { allowPrivateDomains?: boolean },
  ): string | null;
}

let tldts: Promise<PublicSuffix | null> | null = null;

/**
 * The Public Suffix List, private domains and all, from the optional peer
 * `tldts` — loaded once, the first time it is asked for — or null where it
 * is not installed, and a jar keeps its default.
 */
export function publicSuffixList(): Promise<PublicSuffix | null> {
  if (tldts) return tldts;
  const specifier = 'tldts';
  tldts = (import(/* @vite-ignore */ specifier) as Promise<TldtsModule>).then(
    (m) => {
      const getPublicSuffix =
        m.getPublicSuffix ??
        (m as unknown as { default: TldtsModule }).default.getPublicSuffix;
      return (host: string) =>
        getPublicSuffix(host, { allowPrivateDomains: true });
    },
    () => null,
  );
  return tldts;
}
