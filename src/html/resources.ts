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
import type { VideoFrames } from 'react-x11';
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
   * somewhere, against the stylesheet's own URL, as CSS resolves it. For an
   * `<img srcset>`, or an `<img>` in a `<picture>`, the candidate it chose
   * (`srcset.ts`), and the `<img>` is the element.
   */
  url: string;
  /** An `<img>`, an `<object>`, a background or a list marker; a
   *  `<link rel=stylesheet>` or an `@import`; an `@font-face` source; a
   *  `<video>`'s `src`, or one of its `<source>`s. */
  kind: 'image' | 'stylesheet' | 'font' | 'video';
  /**
   * A video's: the type its `<source>` says it is (`video/mp4`, and maybe
   * its `codecs`), for a host that knows what its player plays. Absent
   * where the markup says none, and for every other kind.
   */
  type?: string;
  /** The element that referred to it, for a host that wants the context:
   *  for a font, the `<style>` or `<link>` whose sheet declared it. */
  element: Element;
}

/**
 * What the host hands back. A stylesheet is text, or bytes this decodes as
 * CSS says to — with `charset`, the encoding the protocol named, if it named
 * one (`css/decode.ts`) — and may say the URL it finally came from, after
 * redirects, which is what the relative URLs in it resolve against. An image
 * is bytes, which this decodes — PNG, JPEG, WebP, GIF or SVG, and under Bun
 * whatever else `Bun.Image` reads — or an already-decoded ntk `Image` for a
 * host with its own cache. A font is the
 * file's bytes: TrueType, OpenType, WOFF or WOFF2 (see `fonts.ts`).
 *
 * A video is nothing this decodes. It is what core's `<video>` plays: a
 * `src`, a path or URL the platform's player opens itself — where
 * `useSupports('mediaPlayback')` says this display has one — or `frames`,
 * a `VideoFrames` sink the host decodes the video into, which shows on
 * every backend. Handing over a `src` is the host letting the player make
 * the request, since the player, not this component, is what fetches it.
 */
export type ResourceResult =
  | { kind: 'stylesheet'; text: string; url?: string }
  | { kind: 'stylesheet'; bytes: Uint8Array; charset?: string; url?: string }
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'image'; image: unknown; width: number; height: number }
  | { kind: 'font'; bytes: Uint8Array }
  | VideoSource;

/** What a `<video>` plays: a host's answer to `kind: 'video'`. */
export type VideoSource =
  { kind: 'video'; src: string } | { kind: 'video'; frames: VideoFrames };

/** What `ResourceStore` tells its owner arrived late: a stylesheet, an
 *  image or a video, or a stylesheet that was declined or failed. */
export type ResourceChange = 'stylesheet' | 'image' | 'video' | 'declined';

/** Where a video request is: answered with what plays, still being
 *  answered, or declined — by the host, or by the player it was handed to. */
export type VideoAnswer = VideoSource | 'pending' | 'failed';

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
  /** Whether something its size lays out asked for the image — an `<img>`,
   *  a list's marker, generated content — where a background, a border
   *  image or a mask only paints it (`request`'s `paintOnly`). */
  layout?: boolean;
}

/** The ntk `Image` slice this uses. Structural, as everywhere else here. */
interface ImageLike {
  width: number;
  height: number;
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
  private _changed: (what: ResourceChange, layout: boolean) => void;
  private _urls: UrlResolver | null;
  private _destroyed = false;
  /** What each video URL plays, kept apart from the other resources: a
   *  `src` that is also some image's is two questions for the host. */
  private _videos = new Map<string, VideoAnswer>();

  /**
   * `changed` is told when a resource arrives after the request that asked
   * for it returned, and which kind: a stylesheet changes the cascade, an
   * image the boxes — or, where nothing its size lays out asked for it
   * (`layout`), only what is painted — and a video what is mounted over
   * them; a host answering over a network answers every one of them later.
   * It is told too where a stylesheet is declined or fails that late
   * (`'declined'`): that changes no style, but what waited for the sheet
   * goes on without it.
   */
  constructor(
    ask: (
      request: ResourceRequest,
    ) => Promise<ResourceResult | null> | ResourceResult | null,
    changed: (what: ResourceChange, layout: boolean) => void,
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

  /** Ask for a resource, once per URL: for what only paints it where
   *  `paintOnly` — a background, a border image, a mask — and its arrival
   *  changes no box. Asked for again by what lays it out, it does. */
  request(request: ResourceRequest, paintOnly = false): void {
    if (this._destroyed || !request.url) return;
    const url = this._key(request.url);
    const known = this._entries.get(url);
    if (known) {
      if (!paintOnly) known.layout = true;
      return;
    }
    const entry: Entry = { state: 'pending', layout: !paintOnly };
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
        (result) => this._settle(url, entry, result, false, request.kind),
        () => this._settle(url, entry, null, false, request.kind),
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
    asked: ResourceRequest['kind'] | null = null,
  ): void {
    if (this._destroyed) return;
    // a font is `fonts.ts`'s to ask for, and never comes through here; a
    // video is `requestVideo`'s, and no answer for anything else
    if (!result || result.kind === 'font' || result.kind === 'video') {
      entry.state = 'failed';
      // A sheet that will not come holds nothing back, and what was held
      // for it has to hear so: a first rendering waits on the sheets the
      // head links to and the ones they import (`_renderBlocked`), and
      // nothing else was going to ask again. Zen Garden 215 imports two
      // `http:` sheets, which a secure page's host refuses.
      if (!synchronous && asked === 'stylesheet') {
        this._changed('declined', false);
      }
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
      if (!synchronous) this._changed('stylesheet', true);
      return;
    }
    if ('image' in result) {
      entry.image = result.image;
      entry.size = rasterSize(result.width, result.height);
      entry.state = 'ready';
      if (!synchronous) this._changed('image', entry.layout !== false);
      return;
    }
    const svg = svgFromBytes(result.bytes, fragmentOf(url));
    if (svg) {
      entry.image = svg;
      entry.size = svg.intrinsics;
      entry.state = 'ready';
      if (!synchronous) this._changed('image', entry.layout !== false);
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
          this._changed('image', entry.layout !== false);
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
    if (!synchronous) this._changed('image', entry.layout !== false);
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

  /** Where a resource is: asked for and on its way, arrived, failed — a
   *  host's decline among them — or never asked for, null. */
  state(url: string): 'pending' | 'ready' | 'failed' | null {
    if (!url) return null;
    return this._entries.get(this._key(url))?.state ?? null;
  }

  /**
   * Ask what a `<video>`'s source plays, once per URL: what `video`
   * answers from then on. An answer that is not a video, a throw and a
   * rejection are each the host declining.
   */
  requestVideo(url: string, type: string | undefined, element: Element): void {
    if (this._destroyed || !url) return;
    const key = this._key(url);
    if (this._videos.has(key)) return;
    this._videos.set(key, 'pending');
    const settle = (result: ResourceResult | null, late: boolean) => {
      if (this._destroyed || this._videos.get(key) !== 'pending') return;
      this._videos.set(key, playable(result) ? result : 'failed');
      if (late) this._changed('video', false);
    };
    let answer: Promise<ResourceResult | null> | ResourceResult | null;
    try {
      answer = this._ask({
        url: key,
        kind: 'video',
        ...(type && { type }),
        element,
      });
    } catch {
      settle(null, false);
      return;
    }
    if (isPromise(answer)) {
      answer.then(
        (result) => settle(result, true),
        () => settle(null, true),
      );
      return;
    }
    settle(answer, false);
  }

  /** What a video URL plays, where it was asked about: what the host
   *  answered, `'pending'` until it has, `'failed'` where it declined or
   *  the player it was handed to could not play it. */
  video(url: string): VideoAnswer | undefined {
    if (!url) return undefined;
    return this._videos.get(this._key(url));
  }

  /** A video the player could not play — a format it has no decoder for,
   *  a URL that did not answer: the element goes on to its next source. */
  failVideo(url: string): void {
    const key = this._key(url);
    if (this._videos.has(key)) this._videos.set(key, 'failed');
  }

  destroy(): void {
    this._destroyed = true;
    this._entries.clear();
    this._videos.clear();
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

/** Whether a host's answer is something a `<video>` plays. */
function playable(result: ResourceResult | null): result is VideoSource {
  if (result?.kind !== 'video') return false;
  if ('frames' in result) return result.frames != null;
  return typeof result.src === 'string' && result.src !== '';
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return typeof (value as Promise<T> | null)?.then === 'function';
}

/**
 * Decode image bytes: a GIF here, its first frame (`gif.ts`) handed to
 * ntk's `Image` as the RGBA it takes; anything else through
 * `decodeImageBytes`, core's decoder ladder, the one `<image>` reads bytes
 * with. So an image shows in a document exactly when it would show in an
 * `<image>`: PNG and JPEG, WebP, and under Bun every format `Bun.Image`
 * reads, decoded off the JavaScript thread. A WebP, and under Bun
 * everything, lands a moment later as a promise, which `_settle` waits for
 * as it waits for a host's. Bytes no decoder here reads throw, or reject,
 * and the image is a failed one, framed as a declined image is.
 *
 * ntk's own `decodeImage`, which this used before core had the ladder, is
 * PNG and JPEG alone. A host that would rather decode images itself hands
 * back `{ image, width, height }` and never reaches this.
 */
function decodeImage(bytes: Uint8Array): ImageLike | Promise<ImageLike> | null {
  try {
    const gif = decodeGif(bytes);
    if (gif) {
      const Image = ntk.Image as unknown as new (rgba: unknown) => ImageLike;
      return new Image(gif);
    }
    return ntk.decodeImageBytes(bytes);
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
