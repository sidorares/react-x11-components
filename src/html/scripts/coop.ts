// `Cross-Origin-Opener-Policy` (HTML 7.1.3): what a response says of the window
// it comes to, and whether that takes the window out of its browsing context
// group. `./popups.ts` is what acts on it.
//
// Pure, read from the headers alone, and asked by the host alone: a page's
// realm hears that a window has gone, and nothing of why.
import { headerList } from './sandbox.js';

/** What a document asks of the windows around it (HTML, "opener policy
 *  value"). `same-origin-plus-coep` is `same-origin` with a
 *  `Cross-Origin-Embedder-Policy` that isolates, which no header says alone. */
export type OpenerPolicy =
  | 'unsafe-none'
  | 'same-origin-allow-popups'
  | 'same-origin'
  | 'same-origin-plus-coep'
  | 'noopener-allow-popups';

/** A response, or a document, as this asks about it: its policy and its
 *  origin, `null` for an opaque one. */
export interface PolicyOf {
  value: OpenerPolicy;
  origin: string;
}

/** A response on the way to a document, that redirected it. */
export type { HtmlDocumentHop as DocumentHop } from '../network.js';

/** What starts a token (RFC 9651, 4.2.6), and what goes on with one. */
const TOKEN_START = /[A-Za-z*]/;
const TOKEN = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
/** What starts a parameter's key, and what goes on with one. */
const KEY_START = /[a-z*]/;
const KEY = /[a-z0-9_\-.*]/;

/** A cursor over a field (RFC 9651, 4.2). Each `read` answers whether what it
 *  read parsed, and leaves the cursor past it. */
class Field {
  at = 0;
  constructor(readonly text: string) {}

  /** The character under the cursor, or `''` at the end: a method, since a
   *  getter's narrowing outlives the step that moves it. */
  char(): string {
    return this.text[this.at] ?? '';
  }

  spaces(): void {
    while (this.char() === ' ') this.at += 1;
  }

  /** As many characters as `test` takes, and how many that came to. */
  private _run(test: RegExp): number {
    const from = this.at;
    while (this.char() && test.test(this.char())) this.at += 1;
    return this.at - from;
  }

  /** A bare item (4.2.3.1): what it is a token of, or `''` for any other
   *  type, and null where it does not parse. */
  bare(): string | null {
    const c = this.char();
    if (c && TOKEN_START.test(c)) {
      const from = this.at;
      this._run(TOKEN);
      return this.text.slice(from, this.at);
    }
    return this._other(c) ? '' : null;
  }

  /** A bare item of any type but a token. */
  private _other(c: string): boolean {
    if (c === '"') return this._string();
    if (c === ':') return this._bytes();
    if (c === '?') return this._boolean();
    if (c === '%') return this._display();
    if (c === '@') this.at += 1;
    return this._number();
  }

  /** An integer or a decimal (4.2.4). */
  private _number(): boolean {
    if (this.char() === '-') this.at += 1;
    const whole = this._run(/[0-9]/);
    if (!whole) return false;
    if (this.char() !== '.') return whole <= 15;
    this.at += 1;
    const part = this._run(/[0-9]/);
    return whole <= 12 && part >= 1 && part <= 3;
  }

  /** A string (4.2.5): printable ASCII, with `\"` and `\\` its only escapes. */
  private _string(): boolean {
    this.at += 1;
    for (; this.at < this.text.length; this.at += 1) {
      const c = this.char();
      if (c === '"') {
        this.at += 1;
        return true;
      }
      if (c === '\\') {
        this.at += 1;
        if (this.char() !== '"' && this.char() !== '\\') return false;
      } else if (c < ' ' || c > '~') return false;
    }
    return false;
  }

  /** A byte sequence (4.2.7): base64 between colons. */
  private _bytes(): boolean {
    this.at += 1;
    this._run(/[A-Za-z0-9+/=]/);
    if (this.char() !== ':') return false;
    this.at += 1;
    return true;
  }

  /** A boolean (4.2.8). */
  private _boolean(): boolean {
    this.at += 1;
    if (this.char() !== '0' && this.char() !== '1') return false;
    this.at += 1;
    return true;
  }

  /** A display string (RFC 9651, 4.2.10): `%"`, printable ASCII and `%xx` in
   *  lower case, and a `"`. */
  private _display(): boolean {
    this.at += 1;
    if (this.char() !== '"') return false;
    this.at += 1;
    for (; this.at < this.text.length; this.at += 1) {
      const c = this.char();
      if (c === '"') {
        this.at += 1;
        return true;
      }
      if (c === '%') {
        if (!/^[0-9a-f]{2}/.test(this.text.slice(this.at + 1))) return false;
        this.at += 2;
      } else if (c < ' ' || c > '~') return false;
    }
    return false;
  }

  /** An item's parameters (4.2.3.2). */
  parameters(): boolean {
    while (this.char() === ';') {
      this.at += 1;
      this.spaces();
      if (!this.char() || !KEY_START.test(this.char())) return false;
      this._run(KEY);
      if (this.char() === '=') {
        this.at += 1;
        if (this.bare() === null) return false;
      }
    }
    return true;
  }
}

/**
 * A field read as a structured item, RFC 9651's rules: what it is a token of,
 * or null where it is no such thing, which is the same news here as a field
 * that does not parse (HTML: "parsedItem is not null and parsedItem[0] is a
 * token"). Case counts, and two values of one header are a list and so no
 * item: `same-origin, same-origin` is nothing.
 */
export function itemToken(value: string): string | null {
  // HTTP's whitespace around a field is no part of it; what parsing a field
  // takes off is its spaces, and a tab inside is an error
  const text = value.replace(/^[\t ]+|[\t ]+$/g, '');
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(text)) return null;
  const field = new Field(text);
  const bare = field.bare();
  if (!bare || !field.parameters()) return null;
  field.spaces();
  return field.at === text.length ? bare : null;
}

/** Whether a response's `Cross-Origin-Embedder-Policy` is one a document can
 *  be cross-origin isolated under (HTML, "compatible with cross-origin
 *  isolation"). */
function embedderIsolates(headers: [string, string][]): boolean {
  const raw = headerList(headers, 'cross-origin-embedder-policy');
  const token = raw === null ? null : itemToken(raw);
  return token === 'require-corp' || token === 'credentialless';
}

/**
 * What a response asks of the windows around it (HTML, "obtain an opener
 * policy"). `secure` is whether its address is a secure context, which COOP
 * says nothing outside of. `Cross-Origin-Opener-Policy-Report-Only` changes
 * nothing a page sees, and there is no reporting here to tell.
 */
export function openerPolicyOf(
  headers: [string, string][],
  secure: boolean,
): OpenerPolicy {
  if (!secure) return 'unsafe-none';
  const raw = headerList(headers, 'cross-origin-opener-policy');
  switch (raw === null ? null : itemToken(raw)) {
    case 'same-origin':
      return embedderIsolates(headers)
        ? 'same-origin-plus-coep'
        : 'same-origin';
    case 'same-origin-allow-popups':
      return 'same-origin-allow-popups';
    case 'noopener-allow-popups':
      return 'noopener-allow-popups';
    default:
      return 'unsafe-none';
  }
}

/** Whether two origins are one: an opaque origin is no other's. */
const sameOrigin = (a: string, b: string): boolean => a === b && a !== 'null';

/** HTML, "match opener policy values". */
export function policiesMatch(a: PolicyOf, b: PolicyOf): boolean {
  if (a.value === 'unsafe-none' && b.value === 'unsafe-none') return true;
  if (a.value === 'unsafe-none' || b.value === 'unsafe-none') return false;
  return a.value === b.value && sameOrigin(a.origin, b.origin);
}

/**
 * HTML, "check if COOP values require a browsing context group switch", with
 * "check if popup COOP values require" for `initial`: the window still shows
 * the `about:blank` it opened with, which a `same-origin-allow-popups` opener
 * lets go anywhere with no policy of its own. That is the rule a popup login
 * stands on: the opener keeps its window through a provider's pages.
 */
export function requiresGroupSwitch(
  initial: boolean,
  active: PolicyOf,
  response: PolicyOf,
): boolean {
  if (initial) {
    if (response.value === 'noopener-allow-popups') return true;
    if (
      (active.value === 'same-origin-allow-popups' ||
        active.value === 'noopener-allow-popups') &&
      response.value === 'unsafe-none'
    ) {
      return false;
    }
  }
  return !policiesMatch(active, response);
}

/**
 * Whether a navigation's responses take a window out of its group: each is
 * held to the one before it (HTML, "enforce a response's opener policy"), the
 * first to the document the window shows, and once one has, none puts it back.
 * So a redirect's own policy counts, whatever the last response says.
 */
export function leavesGroup(
  initial: boolean,
  active: PolicyOf,
  responses: readonly PolicyOf[],
): boolean {
  let leaves = false;
  let current = active;
  for (const response of responses) {
    if (requiresGroupSwitch(initial, current, response)) leaves = true;
    current = response;
  }
  return leaves;
}

/**
 * Which of a navigation's responses a window's sandboxing flags turn down, or
 * null: a response with a policy is a network error there, since a document
 * cannot be given a clean slate and sandboxed at once (HTML, "create navigation
 * params by fetching"), and what comes after it is never read. Those are the
 * window's flags, and not a response's own `sandbox`: HTML's text counts both,
 * and Chrome and Safari load such a document with an opaque origin, which is
 * what WPT holds to (`coop-navigate-same-origin-csp-sandbox.html`).
 */
export function refusedAt(
  flags: number,
  responses: readonly PolicyOf[],
): number | null {
  if (!flags) return null;
  const at = responses.findIndex((r) => r.value !== 'unsafe-none');
  return at < 0 ? null : at;
}
