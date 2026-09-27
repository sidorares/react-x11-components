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
import type { Element } from 'domhandler';

/** What the host is asked for. */
export interface ResourceRequest {
  /** The URL exactly as the document wrote it — not resolved against a base,
   *  because this has no base and the host does. */
  url: string;
  kind: 'image' | 'stylesheet';
  /** The element that referred to it, for a host that wants the context. */
  element: Element;
}

/**
 * What the host hands back. A stylesheet is text, or bytes this decodes as
 * CSS says to — with `charset`, the encoding the protocol named, if it named
 * one (`css/decode.ts`); an image is bytes, which this decodes — PNG, JPEG
 * or SVG — or an already-decoded ntk `Image` for a host with its own cache.
 */
export type ResourceResult =
  | { kind: 'stylesheet'; text: string }
  | { kind: 'stylesheet'; bytes: Uint8Array; charset?: string }
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'image'; image: unknown; width: number; height: number };

interface Entry {
  state: 'pending' | 'ready' | 'failed';
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

export class ResourceStore {
  private _entries = new Map<string, Entry>();
  private _ask: (
    request: ResourceRequest,
  ) => Promise<ResourceResult | null> | ResourceResult | null;
  private _changed: () => void;
  private _destroyed = false;

  constructor(
    ask: (
      request: ResourceRequest,
    ) => Promise<ResourceResult | null> | ResourceResult | null,
    changed: () => void,
  ) {
    this._ask = ask;
    this._changed = changed;
  }

  /** Ask for a resource, once per URL. */
  request(request: ResourceRequest): void {
    if (this._destroyed || this._entries.has(request.url)) return;
    const entry: Entry = { state: 'pending' };
    this._entries.set(request.url, entry);
    let answer: Promise<ResourceResult | null> | ResourceResult | null;
    try {
      answer = this._ask(request);
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
        (result) => this._settle(request.url, entry, result),
        () => {
          entry.state = 'failed';
        },
      );
      return;
    }
    this._settle(request.url, entry, answer, true);
  }

  private _settle(
    url: string,
    entry: Entry,
    result: ResourceResult | null,
    synchronous = false,
  ): void {
    if (this._destroyed) return;
    void url;
    if (!result) {
      entry.state = 'failed';
      return;
    }
    if (result.kind === 'stylesheet') {
      if ('bytes' in result) {
        entry.bytes = result.bytes;
        entry.charset = result.charset;
      } else {
        entry.text = result.text;
      }
      entry.state = 'ready';
      if (!synchronous) this._changed();
      return;
    }
    if ('image' in result) {
      entry.image = result.image;
      entry.size = rasterSize(result.width, result.height);
      entry.state = 'ready';
      if (!synchronous) this._changed();
      return;
    }
    const svg = svgFromBytes(result.bytes);
    if (svg) {
      entry.image = svg;
      entry.size = svg.intrinsics;
      entry.state = 'ready';
      if (!synchronous) this._changed();
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
          this._changed();
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
    if (!synchronous) this._changed();
  }

  /** A loaded stylesheet, as text, or null while it has not arrived.
   *  `fallbacks` are the encodings the referrer says, most specific first,
   *  for bytes that name none of their own. */
  stylesheet(
    url: string,
    fallbacks: readonly (string | undefined)[] = [],
  ): DecodedStylesheet | null {
    const entry = this._entries.get(url);
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

  /** A loaded image, for the paint pass. */
  image(url: string): unknown | null {
    const entry = this._entries.get(url);
    return entry?.state === 'ready' ? (entry.image ?? null) : null;
  }

  /** A loaded image's intrinsic size, for the box builder. */
  imageSize(url: string): IntrinsicSize | null {
    const entry = this._entries.get(url);
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
 * Decode image bytes through ntk — PNG and JPEG.
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
