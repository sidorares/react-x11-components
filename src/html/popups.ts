// What a page's `window.open` reaches (`HtmlScripts.popups`), and HTML's
// reading of its features (HTML 7.2.2.1 and 7.2.2.2).
//
// A window with an opener runs in the process of the window that opened it,
// as a realm linked to it: a same-origin page reads `popup.document` as it
// makes the call, which no process boundary could answer. So the seam is
// about where such a window is drawn, and nothing about what it loads: the
// host is handed an `HtmlPopup`, says whether it shows it, and shows it by
// mounting an `<Html>` for each of its documents, with `scripts.popup` set to
// it. docs/prd-popups.md is the design record.
//
// Light on purpose: `<Html>` imports it whether or not a document's scripts
// run, and what it holds is types and pure functions.

/** What `window.open`'s third argument asks of a window's place and size. */
export interface HtmlPopupFeatures {
  /** HTML's "check if a popup window is requested": a small window with no
   *  toolbars rather than a tab. */
  popup: boolean;
  /** The size of its content, in CSS pixels. */
  width?: number;
  height?: number;
  /** Where its top left is on the screen, in CSS pixels. */
  left?: number;
  top?: number;
}

/** A window a page opened, as its host is handed it: what it asked for, and
 *  what the host tells it of what the user did. */
/**
 * Who sent a window somewhere (HTML, a navigation's source document and its
 * user involvement): the origin of the document that did, which the request
 * for the next document is reckoned from (`Sec-Fetch-Site`, a cookie's
 * `SameSite`), and whether a user's press or key is behind it
 * (`Sec-Fetch-User`). A navigation with none is the browser's own: an
 * address typed, a bookmark.
 */
export interface HtmlNavigationSource {
  /** Serialized: `null` for an opaque origin. */
  readonly origin: string;
  readonly user: boolean;
}

export interface HtmlPopup {
  /** A number no other window of this process has: a key to mount it by. */
  readonly id: number;
  /** The address it goes to, absolute: `about:blank` where the page named
   *  none. A page may send its first document elsewhere before the host
   *  loads this, so it is read as the host loads it. */
  readonly url: string;
  /** Its name, which a later `window.open` or a link's `target` finds it
   *  by, or `''`. */
  readonly name: string;
  readonly features: HtmlPopupFeatures;
  /** The address of the document that opened it, which its first document
   *  is asked for from, or null where the page said `noreferrer`. */
  readonly referrer: string | null;
  /** The document that opened it, which its first document is asked for
   *  from: absent from a host's own windows. */
  readonly source?: HtmlNavigationSource;
  /** The form the first document is to be posted from, where a form's
   *  `target` opened it. */
  readonly post: {
    body: string | Uint8Array;
    contentType: string;
  } | null;
  /** Whether it has closed, or is closing. A document whose
   *  `Cross-Origin-Opener-Policy` takes the window from its opener does not
   *  close it: the opener reads it as closed, and it goes on here. */
  readonly closed: boolean;
  /** Its content size in CSS pixels: the features' as opened, until a
   *  script `resizeTo`s it. */
  readonly width: number;
  readonly height: number;
  /** A script asked to resize it (`window.resizeTo`). The host updates the
   *  window it shows. */
  resizeTo(width: number, height: number): void;
  /** The user closed it: its document unloads, and the host stops showing
   *  it. */
  close(): void;
  /** The page closed it. Answers the way to stop listening. */
  onClose(listener: () => void): () => void;
  /** A script asked for it to come to the front. */
  onFocus(listener: () => void): () => void;
  /** A script resized it. Answers the way to stop listening. */
  onResize(
    listener: (size: { width: number; height: number }) => void,
  ): () => void;
}

/**
 * What a page's windows reach (`HtmlScripts.popups`). Default: none, and
 * `window.open` answers null, as a browser whose user blocks every popup
 * does, and hands the address to `navigate` as `'tab'` — but from a sandbox
 * whose windows keep its flags, which a tab cannot carry: such a document's
 * windows are all `open`'s, and with none nothing opens.
 */
export interface HtmlPopups {
  /**
   * A page asks for a window with an opener: `window.open`, or a link or a
   * form whose `target` names none it can find. Answer true to show it,
   * which is to mount `<Html source="" baseUrl="about:blank" scripts={{
   * popup, … }}>` in a window of this process, and an `<Html>` with
   * `scripts.popup` for each document after it. False, and `window.open`
   * answers null.
   */
  open(popup: HtmlPopup): boolean;
  /** Whether a page may open one with no press or key behind it. Default
   *  false: one is refused, as browsers refuse it, and `blocked` is told. */
  unblocked?: boolean;
  /** A window was refused for having no press or key behind it. */
  blocked?(url: string): void;
}

/** What separates a feature from the next, and a name from its value. */
const SEPARATOR = /[\t\n\f\r =,]/;

/** The names CSSOM View reads under the ones it gives them. */
const FEATURE_NAMES: Record<string, string> = {
  screenx: 'left',
  screeny: 'top',
  innerwidth: 'width',
  innerheight: 'height',
};

/**
 * HTML's "tokenize the features argument": each `name=value` pair, its name
 * lower-cased, and a name's value `''` where it has none. Whatever separates
 * them is a separator, so `"noopener, width=10"` and `"noopener width=10"`
 * read alike.
 */
export function tokenizeFeatures(features: string): Map<string, string> {
  const tokens = new Map<string, string>();
  let at = 0;
  const separator = (): boolean => SEPARATOR.test(features[at] ?? '');
  const word = (): string => {
    const from = at;
    while (at < features.length && !separator()) at += 1;
    return features.slice(from, at);
  };
  while (at < features.length) {
    while (at < features.length && separator()) at += 1;
    const written = word().toLowerCase();
    const name = FEATURE_NAMES[written] ?? written;
    while (at < features.length && features[at] !== '=') {
      if (features[at] === ',' || !separator()) break;
      at += 1;
    }
    let value = '';
    if (at < features.length && separator()) {
      while (at < features.length && separator()) {
        if (features[at] === ',') break;
        at += 1;
      }
      value = word();
    }
    if (name) tokens.set(name, value);
  }
  return tokens;
}

/** A feature's value as a boolean (HTML, "parse a boolean feature"): `''`,
 *  `yes` and `true` are, and otherwise a number that is not 0. */
export function featureBoolean(value: string): boolean {
  if (value === '') return true;
  const low = value.toLowerCase();
  if (low === 'yes' || low === 'true') return true;
  const n = featureInteger(value);
  return n !== undefined && n !== 0;
}

/** A feature's value as an integer, HTML's rules for parsing one: what it
 *  starts with, and nothing where it starts with no digit. */
function featureInteger(value: string): number | undefined {
  const match = /^[\t\n\f\r ]*([-+]?)(\d+)/.exec(value);
  if (!match) return undefined;
  const n = Number(match[2]);
  return match[1] === '-' ? -n : n;
}

/** Whether a window feature is set (HTML, "check if a window feature is
 *  set"): `fallback` where it is not named. */
function featureSet(
  tokens: Map<string, string>,
  name: string,
  fallback: boolean,
): boolean {
  const value = tokens.get(name);
  return value === undefined ? fallback : featureBoolean(value);
}

/** HTML's "check if a popup window is requested": any feature asks for a
 *  popup, unless `popup` says otherwise or every bar a window has is on. */
export function popupRequested(tokens: Map<string, string>): boolean {
  if (tokens.size === 0) return false;
  const popup = tokens.get('popup');
  if (popup !== undefined) return featureBoolean(popup);
  if (
    !featureSet(tokens, 'location', false) &&
    !featureSet(tokens, 'toolbar', false)
  ) {
    return true;
  }
  return (
    !featureSet(tokens, 'menubar', false) ||
    !featureSet(tokens, 'resizable', true) ||
    !featureSet(tokens, 'scrollbars', false) ||
    !featureSet(tokens, 'status', false)
  );
}

/** A feature's value in pixels, no less than `least`: 100 for a size and 0
 *  for a place, as browsers keep a window usable. */
function pixels(
  tokens: Map<string, string>,
  name: string,
  least = -Infinity,
): number | undefined {
  const value = tokens.get(name);
  const n = value === undefined ? undefined : featureInteger(value);
  return n === undefined ? undefined : Math.max(n, least);
}

/** `window.open`'s third argument, read. */
export interface WindowFeatures extends HtmlPopupFeatures {
  noopener: boolean;
  noreferrer: boolean;
}

/** `window.open`'s third argument, as what opens a window reads it. */
export function parseWindowFeatures(features: string): WindowFeatures {
  const tokens = tokenizeFeatures(features);
  const noreferrer =
    tokens.has('noreferrer') && featureBoolean(tokens.get('noreferrer')!);
  const noopener =
    noreferrer ||
    (tokens.has('noopener') && featureBoolean(tokens.get('noopener')!));
  // what it asks of the window it opens, which those two leave out of it
  tokens.delete('noopener');
  tokens.delete('noreferrer');
  const read: WindowFeatures = {
    noopener,
    noreferrer,
    popup: popupRequested(tokens),
  };
  const width = pixels(tokens, 'width', 100);
  const height = pixels(tokens, 'height', 100);
  const left = pixels(tokens, 'left', 0);
  const top = pixels(tokens, 'top', 0);
  if (width !== undefined) read.width = width;
  if (height !== undefined) read.height = height;
  if (left !== undefined) read.left = left;
  if (top !== undefined) read.top = top;
  return read;
}
