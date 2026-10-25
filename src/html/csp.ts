// A document's Content Security Policy, as far as a connection asks it
// (CSP 3): a policy's directives parsed from what a `<meta
// http-equiv="Content-Security-Policy">` carries, and whether a URL is one
// its `connect-src` — or its `default-src` where it has none — lets the
// document connect to (6.7.2, "Does url match source list in origin with
// redirect count?").
//
// Pure, so every case is asserted with no document. What consults it is
// the host's half of a page's WebTransport (`scripts/transports.ts`), which
// a browser holds to `connect-src` as it holds `fetch`.

declare const URL: new (url: string) => {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  origin: string;
};

/** A policy: each directive's source list, by its name, lower-cased. */
export type CspPolicy = Map<string, string[]>;

const WHITESPACE = /[\t\n\f\r ]+/;

/** A serialized policy parsed (CSP 3, 2.2.1): directives by `;`, the first
 *  of a name kept. */
export function parseCsp(text: string): CspPolicy {
  const policy: CspPolicy = new Map();
  for (const token of text.split(';')) {
    const parts = token.trim().split(WHITESPACE).filter(Boolean);
    if (!parts.length) continue;
    const name = parts[0].toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name) || policy.has(name)) continue;
    policy.set(name, parts.slice(1));
  }
  return policy;
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
  if (port === url.port) return true;
  return url.port === '' && port === DEFAULT_PORTS[url.protocol];
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
