// The resource seam.
//
// **Nothing is fetched by this component.** No network, no filesystem, no
// `data:` decoding unless the host says so. `onResource` is asked for every
// external thing a document refers to, and what it hands back is what gets
// used; absent, a document renders with its images framed and its linked
// stylesheets ignored, which is a perfectly good way to read one.
//
// That is a policy decision rather than an unimplemented feature, and it is
// the same one ntk's `HtmlView` made and the one this repo makes everywhere
// else it touches the outside world: a component that silently fetched the
// URLs in a document handed to it would make "render this HTML" mean "make
// these requests", which an application cannot audit and a user did not ask
// for. The host already knows its proxy, its cache, its offline policy and
// whether this document is trusted; this does not.
import * as ntk from 'react-x11/ntk';
import { decodeStylesheet } from './css/decode.js';
import type { DecodedStylesheet } from './css/decode.js';
import { svgFromBytes } from './svg.js';
import type { IntrinsicSize } from './svg.js';
import { decodeGif } from './gif.js';
import type { UrlResolver } from './url.js';
import type { Element } from 'domhandler';

/** What the host is asked for. */
export interface ResourceRequest {
  /**
   * The URL. As the document wrote it, where the document has no base — no
   * `baseUrl` prop and no `<base href>` — because then this has none and
   * the host does. Absolute where it has one: resolved against the
   * document's base, or, for a `url()` in a stylesheet that came from
   * somewhere, against the stylesheet's own URL, as CSS resolves it.
   */
  url: string;
  /** An `<img>`, an `<object>`, a background or a list marker; a
   *  `<link rel=stylesheet>` or an `@import`; an `@font-face` source. */
  kind: 'image' | 'stylesheet' | 'font';
  /** The element that referred to it, for a host that wants the context:
   *  for a font, the `<style>` or `<link>` whose sheet declared it. */
  element: Element;
}

/**
 * What the host hands back. A stylesheet is text, or bytes this decodes as
 * CSS says to — with `charset`, the encoding the protocol named, if it named
 * one (`css/decode.ts`) — and may say the URL it finally came from, after
 * redirects, which is what the relative URLs in it resolve against. An image
 * is bytes, which this decodes — PNG, JPEG, GIF or SVG — or an
 * already-decoded ntk `Image` for a host with its own cache. A font is the
 * file's bytes: TrueType, OpenType, WOFF or WOFF2 (see `fonts.ts`).
 */
export type ResourceResult =
  | { kind: 'stylesheet'; text: string; url?: string }
  | { kind: 'stylesheet'; bytes: Uint8Array; charset?: string; url?: string }
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'image'; image: unknown; width: number; height: number }
  | { kind: 'font'; bytes: Uint8Array };

interface Entry {
  state: 'pending' | 'ready' | 'failed';
  /** A stylesheet's own URL, after redirects, as the host said it. */
  url?: string;
  text?: string;
  /** A stylesheet handed over as bytes, decoded when it is first read: what
   *  it falls back to is the referrer's, known only then. */
  bytes?: Uint8Array;
  charset?: string;
  decoded?: { fallbacks: string; sheet: DecodedStylesheet };
  /** An ntk `Image`, or an `SvgDrawing`. */
  image?: unknown;
  size?: IntrinsicSize;
}

/** The ntk `Image` slice this uses. Structural, as everywhere else here. */
interface ImageLike {
  width: number;
  height: number;
}

interface ImageConstructor {
  fromBuffer?(bytes: Uint8Array): ImageLike | Promise<ImageLike>;
  decode?(bytes: Uint8Array): ImageLike | Promise<ImageLike>;
  new (...args: unknown[]): ImageLike;
}

/**
 * The resources a document asked for, by URL — resolved against the
 * document's base (`url.ts`) on the way in and on every lookup, so a caller
 * names a resource by what the document wrote and the host is asked for,
 * and caches by, what it resolves to.
 */
export class ResourceStore {
  private _entries = new Map<string, Entry>();
  private _ask: (
    request: ResourceRequest,
  ) => Promise<ResourceResult | null> | ResourceResult | null;
  private _changed: (what: 'stylesheet' | 'image') => void;
  private _urls: UrlResolver | null;
  private _destroyed = false;

  /**
   * `changed` is told when a resource arrives after the request that asked
   * for it returned, and which kind: a stylesheet changes the cascade and an
   * image the boxes, and a host answering over a network answers every one
   * of them later.
   */
  constructor(
    ask: (
      request: ResourceRequest,
    ) => Promise<ResourceResult | null> | ResourceResult | null,
    changed: (what: 'stylesheet' | 'image') => void,
    urls: UrlResolver | null = null,
  ) {
    this._ask = ask;
    this._changed = changed;
    this._urls = urls;
  }

  /** A URL as the document wrote it, as the store keys it. */
  private _key(url: string): string {
    return this._urls ? this._urls.resolve(url) : url;
  }

  /** Ask for a resource, once per URL. */
  request(request: ResourceRequest): void {
    if (this._destroyed || !request.url) return;
    const url = this._key(request.url);
    if (this._entries.has(url)) return;
    const entry: Entry = { state: 'pending' };
    this._entries.set(url, entry);
    let answer: Promise<ResourceResult | null> | ResourceResult | null;
    try {
      answer = this._ask(url === request.url ? request : { ...request, url });
    } catch {
      entry.state = 'failed';
      return;
    }
    if (!answer) {
      entry.state = 'failed';
      return;
    }
    if (isPromise(answer)) {
      answer.then(
        (result) => this._settle(url, entry, result),
        () => {
          entry.state = 'failed';
        },
      );
      return;
    }
    this._settle(url, entry, answer, true);
  }

  private _settle(
    url: string,
    entry: Entry,
    result: ResourceResult | null,
    synchronous = false,
  ): void {
    if (this._destroyed) return;
    // a font is `fonts.ts`'s to ask for, and never comes through here
    if (!result || result.kind === 'font') {
      entry.state = 'failed';
      return;
    }
    if (result.kind === 'stylesheet') {
      entry.url = result.url || url;
      if ('bytes' in result) {
        entry.bytes = result.bytes;
        entry.charset = result.charset;
      } else {
        entry.text = result.text;
      }
      entry.state = 'ready';
      if (!synchronous) this._changed('stylesheet');
      return;
    }
    if ('image' in result) {
      entry.image = result.image;
      entry.size = rasterSize(result.width, result.height);
      entry.state = 'ready';
      if (!synchronous) this._changed('image');
      return;
    }
    const svg = svgFromBytes(result.bytes, fragmentOf(url));
    if (svg) {
      entry.image = svg;
      entry.size = svg.intrinsics;
      entry.state = 'ready';
      if (!synchronous) this._changed('image');
      return;
    }
    const decoded = decodeImage(result.bytes);
    if (isPromise(decoded)) {
      decoded.then(
        (image) => {
          if (this._destroyed) return;
          entry.image = image;
          entry.size = rasterSize(image.width, image.height);
          entry.state = 'ready';
          this._changed('image');
        },
        () => {
          entry.state = 'failed';
        },
      );
      return;
    }
    if (!decoded) {
      entry.state = 'failed';
      return;
    }
    entry.image = decoded;
    entry.size = rasterSize(decoded.width, decoded.height);
    entry.state = 'ready';
    if (!synchronous) this._changed('image');
  }

  /** A loaded stylesheet, as text, or null while it has not arrived.
   *  `fallbacks` are the encodings the referrer says, most specific first,
   *  for bytes that name none of their own. */
  stylesheet(
    url: string,
    fallbacks: readonly (string | undefined)[] = [],
  ): DecodedStylesheet | null {
    const entry = this._entries.get(this._key(url));
    if (entry?.state !== 'ready') return null;
    if (!entry.bytes) {
      if (entry.text === undefined) return null;
      // decoded by the host, from an encoding it did not say: what it
      // imports falls back to the referrer's
      return { text: entry.text, encoding: fallbacks.find(Boolean) ?? 'utf-8' };
    }
    const key = fallbacks.join('\u0001');
    if (entry.decoded?.fallbacks !== key) {
      entry.decoded = {
        fallbacks: key,
        sheet: decodeStylesheet(entry.bytes, entry.charset, fallbacks),
      };
    }
    return entry.decoded.sheet;
  }

  /**
   * The URL a loaded stylesheet's own relative URLs resolve against: where
   * the host said it came from, or where it was asked for. Null while it
   * has not arrived, or where that is not an absolute URL — a sheet asked
   * for by a relative one, from a document with no base, whose URLs are
   * left as they are written.
   */
  sheetBase(url: string): string | null {
    const entry = this._entries.get(this._key(url));
    const base = entry?.state === 'ready' ? entry.url : undefined;
    return base && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(base) ? base : null;
  }

  /** A loaded image, for the paint pass. */
  image(url: string): unknown | null {
    if (!url) return null;
    const entry = this._entries.get(this._key(url));
    return entry?.state === 'ready' ? (entry.image ?? null) : null;
  }

  /** A loaded image's intrinsic size, for the box builder. */
  imageSize(url: string): IntrinsicSize | null {
    if (!url) return null;
    const entry = this._entries.get(this._key(url));
    return entry?.state === 'ready' ? (entry.size ?? null) : null;
  }

  destroy(): void {
    this._destroyed = true;
    this._entries.clear();
  }
}

/** A raster image's size: both dimensions, and their ratio. */
function rasterSize(width: number, height: number): IntrinsicSize {
  return {
    width,
    height,
    ratio: width > 0 && height > 0 ? width / height : 0,
  };
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return typeof (value as Promise<T> | null)?.then === 'function';
}

/**
 * Decode image bytes through ntk — PNG and JPEG — or, for a GIF, here: its
 * first frame (`gif.ts`), handed to ntk's `Image` as the RGBA it takes.
 *
 * `decodeImage` is ntk's own front door — the one its `HtmlView` used. It is
 * a **named** export of `react-x11/ntk`, which re-exports ntk with
 * `export *`, and it is not in that subpath's declarations, so it is read off
 * the module namespace and probed at run time; a version that dropped it
 * falls back to the `Image` constructor shapes. It is not a property of the
 * default export: this read it there, found nothing, and every image a host
 * handed over as bytes drew as an empty frame. A host that would rather
 * decode images itself hands back `{ image, width, height }` and never
 * reaches this.
 */
function decodeImage(bytes: Uint8Array): ImageLike | Promise<ImageLike> | null {
  try {
    const gif = decodeGif(bytes);
    if (gif) {
      const ctor = ntk.Image as unknown as ImageConstructor | undefined;
      return ctor ? new ctor(gif) : null;
    }
    const decode = (ntk as unknown as Record<string, unknown>).decodeImage;
    if (typeof decode === 'function') {
      return (decode as (b: Uint8Array) => ImageLike | Promise<ImageLike>)(
        bytes,
      );
    }
    const ctor = ntk.Image as unknown as ImageConstructor | undefined;
    if (!ctor) return null;
    if (typeof ctor.fromBuffer === 'function') return ctor.fromBuffer(bytes);
    if (typeof ctor.decode === 'function') return ctor.decode(bytes);
    return new ctor(bytes);
  } catch {
    return null;
  }
}

/** A URL's fragment, decoded, or '' where it has none. */
function fragmentOf(url: string): string {
  const hash = url.indexOf('#');
  if (hash < 0) return '';
  const fragment = url.slice(hash + 1);
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
