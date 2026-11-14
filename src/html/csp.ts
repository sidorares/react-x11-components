// A document's Content Security Policy (CSP 3), the algorithms alone: a
// policy list parsed from what a header or a `<meta
// http-equiv="Content-Security-Policy">` carries, the directive a request,
// an inline script or style, an `eval` or a navigation is held to, and
// whether the source list there lets it through.
//
// Pure, so every case is asserted with no document. What enforces it and
// reports what it refuses is the host's (`scripts/csp-host.ts`): it knows the
// document, hashes what it is asked to hash and fires the
// `securitypolicyviolation` events. A connection's `connect-src` is asked
// through `connectAllowed`, as the host's half of a page's WebTransport and
// WebSocket ask it (`scripts/transports.ts`, `scripts/sockets.ts`).

declare const URL: new (url: string) => {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  origin: string;
  href: string;
  hash: string;
  username: string;
  password: string;
};

/** A policy: each directive's source list, by its name, lower-cased. */
export type CspPolicy = Map<string, string[]>;

const WHITESPACE = /[\t\n\f\r ]+/;

/** A directive's value as the grammar takes it (CSP 3, 2.2): printable
 *  ASCII but `;` and `,`, and ASCII white space between. */
const VALUE = /^[\t\n\f\r\x20-\x2b\x2d-\x3a\x3c-\x7e]*$/;

/** A serialized policy parsed (CSP 3, 2.2.1): directives by `;`, the first
 *  of a name kept, and one whose name or value is not the grammar's left
 *  out. */
export function parseCsp(text: string): CspPolicy {
  const policy: CspPolicy = new Map();
  for (const token of text.split(';')) {
    const trimmed = token.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
    if (!trimmed) continue;
    const at = trimmed.search(WHITESPACE);
    const name = (at < 0 ? trimmed : trimmed.slice(0, at)).toLowerCase();
    const value = at < 0 ? '' : trimmed.slice(at);
    if (!/^[a-z0-9-]+$/.test(name) || policy.has(name)) continue;
    if (!VALUE.test(value)) continue;
    policy.set(name, value.split(WHITESPACE).filter(Boolean));
  }
  return policy;
}

/** Whether a policy is enforced or only reported (CSP 3, 2.2). */
export type CspDisposition = 'enforce' | 'report';

/** A policy as a document holds it: its directives, whether it is enforced,
 *  where it came from and its text, which a report quotes. */
export interface CspPolicyEntry {
  directives: CspPolicy;
  disposition: CspDisposition;
  source: 'header' | 'meta';
  text: string;
}

/** What a meta element's policy may not say (CSP 3, 3.3): it is no
 *  report's and nothing about the document's framing or sandbox. */
const NOT_IN_META = ['report-uri', 'frame-ancestors', 'sandbox'];

/** A header's or a `<meta>`'s value as the policies it holds (CSP 3, 2.2.2,
 *  "parse a response's Content Security Policies"): one a comma, and none
 *  that says nothing. */
export function parsePolicyList(
  text: string,
  disposition: CspDisposition,
  source: 'header' | 'meta',
): CspPolicyEntry[] {
  const out: CspPolicyEntry[] = [];
  for (const piece of text.split(',')) {
    const directives = parseCsp(piece);
    if (source === 'meta')
      for (const name of NOT_IN_META) directives.delete(name);
    if (!directives.size) continue;
    out.push({ directives, disposition, source, text: piece.trim() });
  }
  return out;
}

/** The policies a response's headers carry: `Content-Security-Policy`,
 *  enforced, and `Content-Security-Policy-Report-Only`, reported. */
export function policiesOfHeaders(
  headers: readonly (readonly [string, string])[],
): CspPolicyEntry[] {
  const out: CspPolicyEntry[] = [];
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (key === 'content-security-policy') {
      out.push(...parsePolicyList(value, 'enforce', 'header'));
    } else if (key === 'content-security-policy-report-only') {
      out.push(...parsePolicyList(value, 'report', 'header'));
    }
  }
  return out;
}

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
};

interface Parsed {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  origin: string;
}

function parse(url: string): Parsed | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** A scheme matched as CSP matches one (6.7.2.9, "scheme-part match"):
 *  the same, or one a secure scheme upgrades to. */
function schemeMatches(expression: string, scheme: string): boolean {
  const e = expression.toLowerCase();
  return (
    e === scheme ||
    (e === 'http:' && scheme === 'https:') ||
    (e === 'ws:' &&
      (scheme === 'wss:' || scheme === 'http:' || scheme === 'https:')) ||
    (e === 'wss:' && scheme === 'https:')
  );
}

const unbracketed = (host: string): string =>
  host.toLowerCase().replace(/^\[|\]$/g, '');

/** A host-source's host part matched (6.7.2.10, "host-part match"). */
function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = unbracketed(host);
  if (p.startsWith('*')) return h.endsWith(p.slice(1));
  return unbracketed(p) === h;
}

/** A host-source's port part matched (6.7.2.11): a URL's port is '' where
 *  it is its scheme's default. */
function portMatches(port: string | undefined, url: Parsed): boolean {
  if (port === '*') return true;
  if (port === undefined || port === '') return url.port === '';
  // as a number, so `:080` is `:80`
  const want = String(Number(port));
  if (want === url.port) return true;
  return url.port === '' && want === DEFAULT_PORTS[url.protocol];
}

/** A host-source's path part matched (6.7.2.12). */
function pathMatches(path: string | undefined, url: Parsed): boolean {
  if (!path) return true;
  if (path === '/' && url.pathname === '') return true;
  const exact = !path.endsWith('/');
  const want = path.split('/');
  const have = url.pathname.split('/');
  if (want.length > have.length) return false;
  if (exact && want.length !== have.length) return false;
  if (!exact) want.pop();
  const decode = (piece: string): string => {
    try {
      return decodeURIComponent(piece);
    } catch {
      return piece;
    }
  };
  return want.every((piece, i) => decode(piece) === decode(have[i]));
}

const HOST_SOURCE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::(\*|\d+))?(\/[^?#]*)?$/i;

/** A host-source matched against a URL (6.7.2.8). */
function hostSourceMatches(
  source: string,
  url: Parsed,
  self: Parsed | null,
): boolean {
  const m = HOST_SOURCE.exec(source);
  if (!m) return false;
  const [, scheme, host, port, path] = m;
  if (scheme) {
    if (!schemeMatches(`${scheme}:`, url.protocol)) return false;
  } else if (self && !schemeMatches(self.protocol, url.protocol)) {
    // with no scheme, the document's own, or what it upgrades to
    return false;
  }
  if (host !== '*' && !hostMatches(host, url.hostname)) return false;
  return portMatches(port, url) && pathMatches(path, url);
}

/** `'self'` matched (6.7.2.7): the document's origin, or its host on the
 *  same or a default port over a scheme that is secure, or plain where the
 *  document's is. */
function selfMatches(url: Parsed, self: Parsed): boolean {
  // a URL of a local scheme carries the origin it was made in, and is still
  // none of its document's (CSP 3, 6.7.2.7; WPT's `blob/`)
  if (/^(blob|data|filesystem):$/.test(url.protocol)) return false;
  if (url.origin === self.origin) return true;
  const port = (p: Parsed): string => p.port || DEFAULT_PORTS[p.protocol] || '';
  const sameHost = url.hostname === self.hostname;
  const samePort = port(url) === port(self) || (!url.port && !self.port);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const plain =
    self.protocol === 'http:' &&
    (url.protocol === 'http:' || url.protocol === 'ws:');
  return sameHost && samePort && (secure || plain);
}

/** Whether a URL matches a source list, the document being of `self`'s
 *  origin (6.7.2.5, "Does url match expression in origin with redirect
 *  count?"). An empty list and `'none'` match nothing. */
export function matchesSourceList(
  list: readonly string[],
  url: string,
  self: string,
): boolean {
  const u = parse(url);
  if (!u) return false;
  const s = parse(self);
  for (const source of list) {
    const e = source.toLowerCase();
    if (e === "'none'") continue;
    if (e === '*') {
      // the network's schemes, or the document's own
      if (/^(https?|wss?):$/.test(u.protocol) || u.protocol === s?.protocol) {
        return true;
      }
      continue;
    }
    if (e === "'self'") {
      if (s && selfMatches(u, s)) return true;
      continue;
    }
    // a keyword, a nonce or a hash names no URL
    if (e.startsWith("'")) continue;
    if (/^[a-z][a-z0-9+.-]*:$/.test(e)) {
      if (schemeMatches(e, u.protocol)) return true;
      continue;
    }
    if (hostSourceMatches(source, u, s)) return true;
  }
  return false;
}

/**
 * Whether every policy lets the document connect to `url`: each one's
 * `connect-src`, or its `default-src` where it names none (CSP 3, 6.8.3,
 * "Get the effective directive"), or nothing where it has neither.
 */
export function connectAllowed(
  policies: readonly CspPolicy[],
  url: string,
  self: string,
): boolean {
  for (const policy of policies) {
    const list = policy.get('connect-src') ?? policy.get('default-src');
    if (list && !matchesSourceList(list, url, self)) return false;
  }
  return true;
}

// --- what a request, an inline script or style and an `eval` are held to

/** A directive's fallbacks, the first a policy has standing for it (CSP 3,
 *  6.8.3, "Get the effective directive", and 6.8.4's list). */
const FALLBACKS: Record<string, readonly string[]> = {
  'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
  'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
  'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
  'style-src-attr': ['style-src-attr', 'style-src', 'default-src'],
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'child-src': ['child-src', 'default-src'],
  'script-src': ['script-src', 'default-src'],
  'style-src': ['style-src', 'default-src'],
};

/** The source list a policy holds what `effective` names to: its own, or the
 *  first of its fallbacks the policy has, or none. */
export function directiveFor(
  policy: CspPolicy,
  effective: string,
): string[] | undefined {
  const fallbacks = FALLBACKS[effective] ?? [effective, 'default-src'];
  for (const name of fallbacks) {
    const list = policy.get(name);
    if (list) return list;
  }
  return undefined;
}

/** The directive a request is held to, by its destination (CSP 3, 6.8.1,
 *  "Get the effective directive for request"), or null for one no directive
 *  names. */
export function effectiveDirective(destination: string): string | null {
  switch (destination) {
    case '':
    case 'json':
    case 'text':
    case 'webidentity':
      return 'connect-src';
    case 'manifest':
      return 'manifest-src';
    case 'object':
    case 'embed':
      return 'object-src';
    case 'frame':
    case 'iframe':
    case 'fencedframe':
      return 'frame-src';
    case 'audio':
    case 'track':
    case 'video':
      return 'media-src';
    case 'font':
      return 'font-src';
    case 'image':
      return 'img-src';
    case 'style':
      return 'style-src-elem';
    case 'script':
    case 'xslt':
    case 'audioworklet':
    case 'paintworklet':
      return 'script-src-elem';
    case 'serviceworker':
    case 'sharedworker':
    case 'worker':
      return 'worker-src';
    default:
      return null;
  }
}

const NONCE = /^'nonce-([A-Za-z0-9+/_=-]+)'$/i;
const HASH = /^'(sha256|sha384|sha512)-([A-Za-z0-9+/_=-]+)'$/i;

const has = (list: readonly string[], keyword: string): boolean =>
  list.some((e) => e.toLowerCase() === keyword);

/** A base64 value with its URL-safe letters made standard, and no padding,
 *  as CSP compares a hash (6.7.2.4). */
const normalB64 = (value: string): string =>
  value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');

/** The hash-sources of a list, by their algorithm. */
export function hashesOf(
  list: readonly string[],
): { algorithm: 'sha256' | 'sha384' | 'sha512'; value: string }[] {
  const out: { algorithm: 'sha256' | 'sha384' | 'sha512'; value: string }[] =
    [];
  for (const e of list) {
    const m = HASH.exec(e);
    if (m) {
      out.push({
        algorithm: m[1].toLowerCase() as 'sha256' | 'sha384' | 'sha512',
        value: normalB64(m[2]),
      });
    }
  }
  return out;
}

/** Whether a nonce is one the list names. */
export function nonceMatches(list: readonly string[], nonce: string): boolean {
  if (!nonce) return false;
  return list.some((e) => NONCE.exec(e)?.[1] === nonce);
}

const SCRIPT_LIKE = new Set([
  'script',
  'xslt',
  'audioworklet',
  'paintworklet',
  'serviceworker',
  'sharedworker',
  'worker',
]);

/** What a request says of itself to a policy: its destination, the nonce
 *  and the integrity metadata its element gave it, and whether the parser
 *  made that element. */
export interface CspRequest {
  url: string;
  destination: string;
  nonce?: string;
  /** SRI metadata, as `integrity` writes it. */
  integrity?: string;
  parserInserted?: boolean;
}

/**
 * Whether a source list lets a request through (CSP 3, 6.7.1.1, "script
 * directives pre-request check", and 6.7.2.5): a script by its nonce, by
 * integrity metadata all of whose hashes the list has, or, under
 * `'strict-dynamic'`, by not being the parser's; anything by its URL.
 */
export function requestMatches(
  list: readonly string[],
  request: CspRequest,
  url: string,
  self: string,
  /** A digest as base64, for a URL's hash (`'url-sha256-…'`). */
  hash?: (algorithm: 'sha256' | 'sha384' | 'sha512', text: string) => string,
): boolean {
  // a sheet by its nonce too (CSP 3, 6.7.1.2, "style directives
  // pre-request check")
  if (
    request.destination === 'style' &&
    nonceMatches(list, request.nonce ?? '')
  ) {
    return true;
  }
  if (SCRIPT_LIKE.has(request.destination)) {
    if (nonceMatches(list, request.nonce ?? '')) return true;
    // the hash of the URL it was asked for, a source CSP is still to take
    // (WebAppSec's URL hashes, tentative in WPT)
    if (hash && prefixedHashMatches(list, 'url', request.url, hash)) {
      return true;
    }
    const sri = parseIntegrity(request.integrity ?? '');
    if (sri.length) {
      const hashes = hashesOf(list);
      if (
        sri.every((m) =>
          hashes.some(
            (h) => h.algorithm === m.algorithm && h.value === m.value,
          ),
        )
      ) {
        return true;
      }
    }
    if (has(list, "'strict-dynamic'")) return !request.parserInserted;
    // a list that names a URL's hash has no say by host (tentative)
    if (list.some((e) => /^'url-/i.test(e))) return false;
  }
  return matchesSourceList(list, url, self);
}

/** SRI's "parse metadata": the hashes an `integrity` names, in algorithms it
 *  knows. */
export function parseIntegrity(
  text: string,
): { algorithm: string; value: string }[] {
  const out: { algorithm: string; value: string }[] = [];
  for (const token of text.split(WHITESPACE)) {
    const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/_=-]+)(\?.*)?$/i.exec(
      token,
    );
    if (m) out.push({ algorithm: m[1].toLowerCase(), value: normalB64(m[2]) });
  }
  return out;
}

/** What an inline check is about (CSP 3, 6.7.3.3): a `<script>`'s or a
 *  `<style>`'s text, an `on…` attribute's or a `style` attribute's, or a
 *  `javascript:` URL. */
export type InlineType =
  'script' | 'script attribute' | 'style' | 'style attribute' | 'navigation';

/** The directive an inline check is held to (CSP 3, 6.8.2). */
export function inlineDirective(type: InlineType): string {
  return type === 'script' || type === 'navigation'
    ? 'script-src-elem'
    : type === 'script attribute'
      ? 'script-src-attr'
      : type === 'style'
        ? 'style-src-elem'
        : 'style-src-attr';
}

/**
 * Whether a list lets inline content through (CSP 3, 6.7.3.3, "Does element
 * match source list for type and source?"): all of it, under
 * `'unsafe-inline'` where the list names no nonce, no hash and, for a
 * script, no `'strict-dynamic'`; an element by its nonce; its text by a
 * hash, an attribute's or a URL's only under `'unsafe-hashes'`. `hash` works
 * a digest out, as base64, for an algorithm.
 */
export function inlineMatches(
  list: readonly string[],
  type: InlineType,
  source: string,
  nonce: string,
  hash: (algorithm: 'sha256' | 'sha384' | 'sha512', text: string) => string,
  /** A script a script put in, no parser's: what `'strict-dynamic'` trusts
   *  as it trusts one of its `src` (as the engines have it). */
  dynamic = false,
): boolean {
  if (type === 'script' && dynamic && has(list, "'strict-dynamic'")) {
    return true;
  }
  const hashes = hashesOf(list);
  const nonced = list.some((e) => NONCE.test(e));
  const scripty =
    type === 'script' || type === 'script attribute' || type === 'navigation';
  if (
    has(list, "'unsafe-inline'") &&
    !nonced &&
    !hashes.length &&
    !(scripty && has(list, "'strict-dynamic'"))
  ) {
    return true;
  }
  if ((type === 'script' || type === 'style') && nonceMatches(list, nonce)) {
    return true;
  }
  if (type === 'script' || type === 'style' || has(list, "'unsafe-hashes'")) {
    for (const h of hashes) {
      if (normalB64(hash(h.algorithm, source)) === h.value) return true;
    }
  }
  return false;
}

/** Whether a list lets a string be compiled as script (CSP 3, 4.4,
 *  "EnsureCSPDoesNotBlockStringCompilation"), and WebAssembly be compiled
 *  (`'wasm-unsafe-eval'`): a string also by its hash, `'eval-sha256-…'`,
 *  where `hash` is given (tentative in WPT). */
export function evalMatches(
  list: readonly string[],
  wasm: boolean,
  source?: string,
  hash?: (algorithm: 'sha256' | 'sha384' | 'sha512', text: string) => string,
): boolean {
  return (
    has(list, "'unsafe-eval'") ||
    (wasm && has(list, "'wasm-unsafe-eval'")) ||
    (!wasm &&
      source !== undefined &&
      !!hash &&
      prefixedHashMatches(list, 'eval', source, hash))
  );
}

const PREFIXED_HASH =
  /^'(url|eval)-(sha256|sha384|sha512)-([A-Za-z0-9+/_=-]+)'$/i;

/** Whether a list names the hash of `text` under a prefix: `'url-…'` or
 *  `'eval-…'`. */
function prefixedHashMatches(
  list: readonly string[],
  prefix: 'url' | 'eval',
  text: string,
  hash: (algorithm: 'sha256' | 'sha384' | 'sha512', text: string) => string,
): boolean {
  for (const e of list) {
    const m = PREFIXED_HASH.exec(e);
    if (!m || m[1].toLowerCase() !== prefix) continue;
    const algorithm = m[2].toLowerCase() as 'sha256' | 'sha384' | 'sha512';
    if (normalB64(hash(algorithm, text)) === normalB64(m[3])) return true;
  }
  return false;
}

/** Whether a list asks for a sample of what it refuses (`'report-sample'`). */
export const wantsSample = (list: readonly string[]): boolean =>
  has(list, "'report-sample'");

/** The URL an insecure request is sent to under `upgrade-insecure-requests`
 *  (Upgrade Insecure Requests, 4.1, "Upgrade request to a potentially
 *  trustworthy URL"): an `http:` one as `https:` and a `ws:` one as `wss:`,
 *  port 80 as 443, any other port as it was. Any other URL is as it was. */
export function upgradedUrl(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'ws') return url;
  let u: InstanceType<typeof URL>;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  // a default port is none in a URL, so port 80 comes to https's own
  u.protocol = scheme === 'http' ? 'https:' : 'wss:';
  return u.href;
}

/** A URL as a report may carry it (CSP 3, 5.4, "Strip URL for use in
 *  reports"): of a scheme the network has no say over, the scheme alone; of
 *  any other, with no fragment and no credentials. */
export function reportedUrl(url: string): string {
  let u: InstanceType<typeof URL>;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return u.protocol.slice(0, -1);
  u.hash = '';
  u.username = '';
  u.password = '';
  return u.href;
}
