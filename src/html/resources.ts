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
import ntk, { Image } from 'react-x11/ntk';
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
 * What the host hands back. A stylesheet is text; an image is bytes, which
 * this decodes, or an already-decoded ntk `Image` for a host with its own
 * cache.
 */
export type ResourceResult =
  | { kind: 'stylesheet'; text: string }
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'image'; image: unknown; width: number; height: number };

interface Entry {
  state: 'pending' | 'ready' | 'failed';
  text?: string;
  image?: unknown;
  width?: number;
  height?: number;
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
      entry.text = result.text;
      entry.state = 'ready';
      if (!synchronous) this._changed();
      return;
    }
    if ('image' in result) {
      entry.image = result.image;
      entry.width = result.width;
      entry.height = result.height;
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
          entry.width = image.width;
          entry.height = image.height;
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
    entry.width = decoded.width;
    entry.height = decoded.height;
    entry.state = 'ready';
    if (!synchronous) this._changed();
  }

  /** A loaded stylesheet's text, or null while it has not arrived. */
  stylesheetText(url: string): string | null {
    const entry = this._entries.get(url);
    return entry?.state === 'ready' ? (entry.text ?? null) : null;
  }

  /** A loaded image, for the paint pass. */
  image(url: string): unknown | null {
    const entry = this._entries.get(url);
    return entry?.state === 'ready' ? (entry.image ?? null) : null;
  }

  /** A loaded image's intrinsic size, for the box builder. */
  imageSize(url: string): { width: number; height: number } | null {
    const entry = this._entries.get(url);
    if (entry?.state !== 'ready' || entry.width === undefined) return null;
    return { width: entry.width, height: entry.height ?? 0 };
  }

  destroy(): void {
    this._destroyed = true;
    this._entries.clear();
  }
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return typeof (value as Promise<T> | null)?.then === 'function';
}

/**
 * Decode image bytes through ntk.
 *
 * `decodeImage` is ntk's own front door — the one its `HtmlView` used — but
 * it is not on `react-x11/ntk`'s *typed* list, so it is reached through the
 * default export and probed at run time; a version that dropped it falls
 * back to the `Image` constructor shapes. A host that would rather decode
 * images itself hands back `{ image, width, height }` and never reaches
 * this.
 */
function decodeImage(bytes: Uint8Array): ImageLike | Promise<ImageLike> | null {
  try {
    const decode = (ntk as Record<string, unknown>).decodeImage;
    if (typeof decode === 'function') {
      return (decode as (b: Uint8Array) => ImageLike | Promise<ImageLike>)(
        bytes,
      );
    }
    const ctor = Image as unknown as ImageConstructor | undefined;
    if (!ctor) return null;
    if (typeof ctor.fromBuffer === 'function') return ctor.fromBuffer(bytes);
    if (typeof ctor.decode === 'function') return ctor.decode(bytes);
    return new ctor(bytes);
  } catch {
    return null;
  }
}
