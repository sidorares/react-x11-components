// Which image an `<img>` shows: HTML's "selecting an image source"
// (4.8.4.3) — its `srcset` and `sizes`, and the `<source>` elements of a
// `<picture>` around it.
//
// An `<img src>` alone is one URL, asked for as the markup is read
// (`HtmlViewNode._sweep`). An `<img srcset>`, or one in a `<picture>`, is a
// choice: the first `<source>` whose `media` holds, whose `type` decodes here
// and whose `srcset` has a candidate, else the `<img>`'s own; of its
// candidates, the one dense enough for the display. That turns on the
// viewport, the display's scale and the colour scheme, so it is made where
// those are known — before the boxes are built, for the width they are built
// at — and made again when one of them moves, as a browser makes it again
// when its window does.
//
// The choice is a URL and a pixel density, and the density is the image's
// size: a candidate drawn at 2x is half its pixels across, and a `w`
// candidate is as wide as `sizes` says, whatever its file is. So a choice
// that keeps its URL and changes its density still changes the box.
//
// Two things a choice decides besides the image. The `<source>` it took is
// the `<img>`'s dimension attribute source where it has a `width` or a
// `height`, whose attributes size the image in place of its own
// (`dimensionSource`), so the cascade asks it. And an image whose `sizes`
// is `auto` is as wide as it is laid out, so its candidate is picked once
// layout has said (`chooseLaidOut`), from a set chosen with the rest.
//
// Asking for the chosen URL is still the host's (`onResource`), and a
// declined one is an ordinary state: the image is framed as any declined
// image is.
import type { AnyNode, Element } from 'domhandler';
import { attr, childrenOf, isElement, tagOf } from './dom.js';
import { mediaMatches, parseMediaQuery, splitSelectors } from './css/parse.js';
import type { MediaCondition } from './css/parse.js';
import { parseLength } from './css/values.js';

/** An image candidate as a `srcset` writes it: a URL and its `w` or `x`
 *  descriptor, or neither, which is `1x`. */
export interface Candidate {
  url: string;
  width?: number;
  density?: number;
}

/** A candidate with its pixel density: device pixels of the image to the
 *  CSS pixel it is drawn at. */
export interface ImageSource {
  url: string;
  density: number;
}

/** What a choice turns on. */
export interface SourceEnv {
  /** The viewport, in CSS pixels: what a `media` query asks about, and
   *  what a `vw` or a `vh` in `sizes` is a hundredth of. */
  width: number;
  height: number;
  /** Device pixels to the CSS pixel: the density a candidate is chosen
   *  for. */
  scale: number;
  scheme: 'light' | 'dark';
  /** Whether an image of this MIME type decodes here: a `<source type>`'s
   *  question (`decodesImageType`). */
  decodes(type: string): boolean;
}

/** One entry of a `sizes` list: a media condition, or none, and a length
 *  as written, evaluated against the viewport each time it is asked — or
 *  `auto`, the image's laid-out width. */
export interface SizeEntry {
  media: MediaCondition[] | null;
  length: string;
}

/** What a `<source>` with no `sizes` before an image that allows `auto`
 *  says (HTML 4.8.2, "the source element"). */
const AUTO_SIZES: SizeEntry[] = [{ media: null, length: 'auto' }];

/** HTML's "ASCII whitespace". */
function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

/** A valid floating-point number (HTML 2.3.4.3): `1`, `1.5`, `.5`, `1e1`,
 *  signed with a minus and never a plus; `1.` is none. */
const FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const INTEGER = /^\d+$/;

/**
 * A `srcset` attribute's candidates (HTML 4.8.4.3, "parse a srcset
 * attribute"). A URL runs to white space, not to a comma, so a `data:` URL
 * and a URL with a comma in its query are one candidate each; commas after
 * a URL end it. A candidate whose descriptors are not one `w`, one `x`, or
 * a `w` with an `h`, is dropped and the rest are kept — `1X`, `1.x`, `+1x`
 * and `0w` are each a candidate nobody chooses, in every browser.
 */
export function parseSrcset(input: string): Candidate[] {
  const out: Candidate[] = [];
  const n = input.length;
  let i = 0;
  for (;;) {
    while (i < n && (isSpace(input[i]) || input[i] === ',')) i += 1;
    if (i >= n) return out;
    const start = i;
    while (i < n && !isSpace(input[i])) i += 1;
    let url = input.slice(start, i);
    const descriptors: string[] = [];
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      while (i < n && isSpace(input[i])) i += 1;
      // the descriptor tokenizer: white space parts descriptors, a comma
      // ends the candidate, and a comma inside parentheses does not
      let current = '';
      let state: 'in' | 'parens' | 'after' = 'in';
      for (; ; i += 1) {
        const c = i < n ? input[i] : null;
        if (state === 'in') {
          if (c === null) {
            if (current) descriptors.push(current);
            break;
          }
          if (isSpace(c)) {
            if (current) {
              descriptors.push(current);
              current = '';
              state = 'after';
            }
          } else if (c === ',') {
            i += 1;
            if (current) descriptors.push(current);
            break;
          } else {
            current += c;
            if (c === '(') state = 'parens';
          }
        } else if (state === 'parens') {
          if (c === null) {
            descriptors.push(current);
            break;
          }
          current += c;
          if (c === ')') state = 'in';
        } else {
          if (c === null) break;
          if (!isSpace(c)) {
            // read again, in a descriptor
            state = 'in';
            i -= 1;
          }
        }
      }
    }
    const candidate = candidateOf(url, descriptors);
    if (candidate) out.push(candidate);
  }
}

/** A URL and its descriptors as one candidate, or null where they are not
 *  one (the "descriptor parser"). Case matters: `400W` is no width. */
function candidateOf(url: string, descriptors: string[]): Candidate | null {
  let width: number | undefined;
  let density: number | undefined;
  let height: number | undefined;
  for (const d of descriptors) {
    const kind = d[d.length - 1];
    const value = d.slice(0, -1);
    if (kind === 'w' && INTEGER.test(value)) {
      if (width !== undefined || density !== undefined) return null;
      width = Number(value);
      if (width === 0) return null;
    } else if (kind === 'x' && FLOAT.test(value)) {
      if (width !== undefined || density !== undefined) return null;
      if (height !== undefined) return null;
      density = Number(value);
      if (density < 0) return null;
    } else if (kind === 'h' && INTEGER.test(value)) {
      // kept for a future that sizes by height; a candidate with one and
      // no width is none
      if (height !== undefined || density !== undefined) return null;
      height = Number(value);
      if (height === 0) return null;
    } else {
      return null;
    }
  }
  if (height !== undefined && width === undefined) return null;
  return width !== undefined
    ? { url, width }
    : density !== undefined
      ? { url, density }
      : { url };
}

/**
 * A `sizes` attribute's entries (HTML's "parse a sizes attribute"), each a
 * media condition, or none, before a length or `auto`: the first whose
 * condition holds is the size, and with none, `100vw`. An entry whose
 * length is no non-negative length — a percentage, a number, `-10px` — or
 * whose condition is no condition — `screen` — is passed over. `auto` is
 * kept, for `sourceSize` to pass over where it has no width for it.
 */
export function parseSizes(input: string): SizeEntry[] {
  const out: SizeEntry[] = [];
  for (const entry of splitSelectors(input)) {
    const at = lastComponent(entry);
    if (at < 0) continue;
    let length = entry.slice(at).trim();
    const auto = /^auto$/i.test(length);
    if (auto) length = 'auto';
    else if (!isSourceSize(length)) continue;
    const condition = entry.slice(0, at).trim();
    if (!condition) {
      out.push({ media: null, length });
      // a size with no condition is the size; what follows it is never
      // reached — but past an `auto` it is, where there is no width
      if (!auto) break;
      continue;
    }
    // a `<media-condition>`, which has no media type: `(…)` or `not (…)`
    if (!/^(?:not\s+)?\(/i.test(condition)) continue;
    out.push({ media: parseMediaQuery(condition), length });
  }
  return out;
}

/** Where the last component value of an entry starts: a function with its
 *  name, a block, or a token — `calc(100vw - 2rem)`, or `100vw` after
 *  `(max-width: 600px)` with no space between. -1 where its parentheses do
 *  not balance. */
function lastComponent(text: string): number {
  if (text.endsWith(')')) {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i -= 1) {
      if (text[i] === ')') depth += 1;
      else if (text[i] === '(' && --depth === 0) {
        let start = i;
        while (start > 0 && /[\w-]/.test(text[start - 1])) start -= 1;
        return start;
      }
    }
    return -1;
  }
  let start = text.length;
  while (start > 0 && !/[\s()]/.test(text[start - 1])) start -= 1;
  return start;
}

/** Units against a viewport nobody has, to tell whether a length is one. */
const PROBE = { em: 16, rem: 16, vw: 1000, vh: 1000, scale: 1 };

/** A math function's name, which may come out below zero and is held at
 *  zero where it does, where a length written below zero is none. */
const MATH = /^(?:-webkit-)?(?:calc|min|max|clamp)\(/i;

/** Whether a `sizes` length is a non-negative `<length>`, or a math
 *  function of lengths. */
function isSourceSize(length: string): boolean {
  const px = parseLength(length, PROBE);
  return typeof px === 'number' && (px >= 0 || MATH.test(length));
}

/**
 * The size, in CSS pixels, a `sizes` list comes to: the length of its first
 * entry whose condition holds, and the viewport's width where none does.
 * Its units are a media query's (Media Queries 4, 1.3): an `em` is the
 * initial font size, 16px, whatever the document sets.
 *
 * `auto` is `width`, the image's laid-out width, and is passed over where
 * that is null: where the image does not allow `auto` (`allowsAutoSizes`),
 * or has not been laid out — as Firefox and WebKit pass it over, and HTML
 * does. Chrome 154 takes `100vw` for the whole list in an image that does
 * not load lazily.
 */
export function sourceSize(
  entries: SizeEntry[],
  env: SourceEnv,
  width: number | null = null,
): number {
  for (const { media, length } of entries) {
    const auto = length === 'auto';
    if (auto && width === null) continue;
    if (
      media &&
      !mediaMatches([media], env.width, env.scheme, env.height, env.scale)
    ) {
      continue;
    }
    if (auto) return width ?? env.width;
    const px = parseLength(length, {
      em: 16,
      rem: 16,
      vw: env.width,
      vh: env.height,
      scale: 1,
    });
    if (typeof px === 'number') return Math.max(0, px);
  }
  return env.width;
}

/**
 * Each candidate's pixel density (HTML's "normalize the source densities"):
 * an `x` as written, a `w` over the source size, and `1x` for neither. A
 * size of 0 makes every `w` candidate infinitely dense, and its image no
 * size at all, as in every browser.
 */
export function normalize(set: Candidate[], size: number): ImageSource[] {
  return set.map((c) => ({
    url: c.url,
    density: c.density ?? (c.width !== undefined ? c.width / size : 1),
  }));
}

/**
 * The candidate a display of `scale` device pixels to the CSS pixel shows:
 * the least dense at or above it, else the densest; of equal densities, the
 * first written. Chrome, Firefox and Safari all choose this way — Chrome
 * once took a candidate below the scale where the scale fell short of the
 * geometric mean of the two around it, and no longer does (Chrome 154: `1x,
 * 5x` at 1.5 is `5x`). An `image-set()` chooses among its options the
 * same way (`style.ts`), and its `T` carries what each option draws.
 *
 * `held` names a URL this document has already asked for, and a denser
 * candidate held is taken over a lighter one asked for anew: Chrome's
 * `AvoidDownloadIfHigherDensityResourceIsInCache`, which is why a window
 * that narrows keeps the image it has, at the new density, where Firefox
 * fetches the lighter one.
 */
export function pick<T extends ImageSource>(
  sources: readonly T[],
  scale: number,
  held?: (url: string) => boolean,
): T | null {
  if (!sources.length) return null;
  const sorted = sources
    .map((source, order) => ({ source, order }))
    .sort((a, b) => a.source.density - b.source.density || a.order - b.order);
  const unique: T[] = [];
  for (const { source } of sorted) {
    const last = unique[unique.length - 1];
    if (!last || last.density !== source.density) unique.push(source);
  }
  let winner = unique.findIndex((s) => s.density >= scale);
  if (winner < 0) winner = unique.length - 1;
  if (held) {
    for (let i = unique.length - 1; i > winner; i -= 1) {
      if (held(unique[i].url)) return unique[i];
    }
  }
  return unique[winner];
}

/** The elements an `<img>`'s choice reads: its `<picture>`'s children, the
 *  `<source>`s before it among them, or only itself. */
function sourcesOf(img: Element): readonly AnyNode[] {
  const parent = img.parent;
  return parent && isElement(parent) && tagOf(parent) === 'picture'
    ? childrenOf(parent)
    : [img];
}

/**
 * Whether an `<img>` allows `auto` in its `sizes`, and its `<source>`s' (HTML
 * 4.8.3, "allows auto-sizes"): it loads lazily, and its own `sizes` is
 * `auto` or starts with `auto,` — as written, so a space before it, or an
 * `auto` after another entry, is none, as Firefox and WebKit read it.
 * Chrome 154 takes either, and `100vw` for the whole list in an image that
 * does not load lazily.
 */
export function allowsAutoSizes(img: Element): boolean {
  if (attr(img, 'loading')?.toLowerCase() !== 'lazy') return false;
  const sizes = attr(img, 'sizes')?.toLowerCase();
  return sizes === 'auto' || sizes?.startsWith('auto,') === true;
}

/**
 * An `<img>`'s dimension attribute source, given the `<source>` its
 * candidates came from: that source where it has a `width` or a `height`,
 * and the `<img>` otherwise (HTML's "update the source set").
 */
function dimensionsOf(img: Element, source: Element | null): Element {
  return source &&
    (attr(source, 'width') !== undefined ||
      attr(source, 'height') !== undefined)
    ? source
    : img;
}

/** The store a choice asks for its URLs through, and asks the state of. */
export interface SourceStore {
  request(url: string, element: Element): void;
  state(url: string): 'pending' | 'ready' | 'failed' | null;
}

/** What a round of choices changed (`ImageSources.choose`). */
export interface SourceChanges {
  /** Whether what any image shows changed: its URL, or its density. */
  shown: boolean;
  /** The images whose dimension attribute source is another element now,
   *  whose styles the attributes it has make (`dimensionSource`). */
  restyle: Element[];
}

interface Choice {
  /** The attributes it was made from (`signatureOf`). */
  signature: string;
  /** The environment it was made in (`envKey`). */
  env: string;
  /** The `<source>` its candidates came from, or null for the `<img>`'s
   *  own. */
  source: Element | null;
  /** Those candidates, and the `sizes` they are measured against. */
  set: Candidate[];
  sizes: SizeEntry[];
  /** Whether the size may be the image's laid-out width: `auto` in
   *  `sizes`, in an image that allows it. Its candidate is picked once
   *  the image is laid out (`chooseLaidOut`). */
  auto: boolean;
  /** The laid-out width it was picked at, in CSS pixels, where `auto`:
   *  null where it had none, and undefined until it is picked. */
  width: number | null | undefined;
  chosen: ImageSource | null;
  /** What the element showed when this was chosen, which it goes on
   *  showing while `chosen` is on its way: HTML's current request, beside
   *  the pending one. Null where it showed nothing that had arrived. */
  previous: ImageSource | null;
}

/** Parses kept between choices, by the text parsed; a bound keeps a
 *  long-lived element fed one document after another from keeping them
 *  all. */
const KEPT = 512;

/**
 * The choices a document's `<img srcset>`s and `<picture>`s have made.
 *
 * A choice is made again when the environment it was made in moves, or the
 * attributes it was made from change — not when an image arrives, nor when
 * the document is merely read again (a streamed append): `held` makes a
 * choice depend on what has been asked for, and a choice made again on any
 * of those would trade an image for a denser one some other element asked
 * for, which no browser does once an image has its source.
 *
 * An image whose `sizes` is `auto` is chosen in two halves: its source with
 * the rest, before the boxes are built, since that turns on the viewport
 * and its attributes size the box; and its candidate once it is laid out,
 * again when its width moves. HTML gives such an image `contain: size`
 * (the UA sheet), so its width is no candidate's to change, and the second
 * half cannot change what it was made from.
 */
export class ImageSources {
  private _store: SourceStore;
  private _choices = new WeakMap<Element, Choice>();
  /** HTML's "last auto-sizes width": what an image was last laid out at,
   *  which `auto` is while it is not laid out at all. */
  private _widths = new WeakMap<Element, number>();
  /** The environment of the last round (`choose`), which the candidates
   *  picked after layout are picked in. */
  private _env: SourceEnv | null = null;
  private _srcsets = new Map<string, Candidate[]>();
  private _sizes = new Map<string, SizeEntry[]>();
  private _media = new Map<string, MediaCondition[]>();
  /** Whether some choice read the viewport's height: a `media` on it, an
   *  orientation or an aspect ratio, or a `vh` in `sizes`. */
  readsHeight = false;

  constructor(store: SourceStore) {
    this._store = store;
  }

  /**
   * Choose each element's source in `env`, and ask for each one chosen —
   * but an image whose `sizes` waits on its layout, whose candidate
   * `chooseLaidOut` picks, and which shows what it showed until then. What
   * changed: whether what any of them shows, and which are sized by
   * another element now.
   */
  choose(elements: readonly Element[], env: SourceEnv): SourceChanges {
    this._env = env;
    const key = envKey(env);
    const changes: SourceChanges = { shown: false, restyle: [] };
    for (const el of elements) {
      const signature = signatureOf(el);
      const kept = this._choices.get(el);
      if (kept && kept.signature === signature && kept.env === key) continue;
      const before = this.shown(el);
      const { source, set, sizes } = this._select(el, env);
      const choice: Choice = {
        signature,
        env: key,
        source,
        set,
        sizes,
        auto: allowsAutoSizes(el) && sizes.some((s) => s.length === 'auto'),
        width: undefined,
        chosen: kept?.chosen ?? null,
        previous: kept?.previous ?? null,
      };
      this._choices.set(el, choice);
      if (!choice.auto) this._pick(el, choice, null, env);
      if (dimensionsOf(el, source) !== dimensionsOf(el, kept?.source ?? null)) {
        changes.restyle.push(el);
      }
      const after = this.shown(el);
      if (before?.url !== after?.url || before?.density !== after?.density) {
        changes.shown = true;
      }
    }
    return changes;
  }

  /**
   * Pick the candidate of each image whose `sizes` is `auto`, for the width
   * it was laid out at — `widthOf`, its content box's, in CSS pixels, or
   * null where it is not laid out, which is the width it last had or none
   * — and ask for it. Picked again only where that width moved. Whether
   * what any of them draws changed: an image that has arrived, or its
   * density.
   */
  chooseLaidOut(
    elements: readonly Element[],
    widthOf: (el: Element) => number | null,
  ): boolean {
    const env = this._env;
    if (!env) return false;
    let changed = false;
    for (const el of elements) {
      const choice = this._choices.get(el);
      if (!choice?.auto) continue;
      let width = widthOf(el);
      if (width === null) width = this._widths.get(el) ?? null;
      else this._widths.set(el, width);
      if (choice.width === width) continue;
      const before = this._drawn(el);
      this._pick(el, choice, width, env);
      const after = this._drawn(el);
      if (before?.url !== after?.url || before?.density !== after?.density) {
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The source an element shows: its choice, once that has arrived or
   * failed, and until then what it showed before, where that had arrived.
   * Null for an element that chose nothing: no candidate anywhere, which
   * is an `<img>` with no image at all, or one whose `sizes` waits on a
   * layout it has not had.
   */
  shown(el: Element): ImageSource | null {
    const choice = this._choices.get(el);
    if (!choice?.chosen) return null;
    if (
      choice.previous &&
      this._store.state(choice.chosen.url) === 'pending' &&
      this._store.state(choice.previous.url) === 'ready'
    ) {
      return choice.previous;
    }
    return choice.chosen;
  }

  /**
   * The element whose `width` and `height` size an `<img>` (HTML 15.4.3):
   * the `<source>` it chose, where that has either, and the `<img>`
   * otherwise — one that chooses nothing among them too.
   */
  dimensionSource(el: Element): Element {
    return dimensionsOf(el, this._choices.get(el)?.source ?? null);
  }

  /** What an element shows of an image that has arrived. */
  private _drawn(el: Element): ImageSource | null {
    const shown = this.shown(el);
    return shown && this._store.state(shown.url) === 'ready' ? shown : null;
  }

  /** Pick a choice's candidate, for `width` where its size is `auto`, and
   *  ask for it. */
  private _pick(
    el: Element,
    choice: Choice,
    width: number | null,
    env: SourceEnv,
  ): void {
    const before = this.shown(el);
    const sources = normalize(
      choice.set,
      sourceSize(choice.sizes, env, choice.auto ? width : null),
    );
    const chosen = pick(sources, env.scale, (url) => {
      const state = this._store.state(url);
      return state === 'ready' || state === 'pending';
    });
    // what is on screen stays there while its successor is asked for — at
    // the density the new choice gives its URL, where it is among the
    // candidates still, so that an image whose size follows `sizes` goes on
    // following it
    let previous: ImageSource | null = null;
    if (
      before &&
      chosen &&
      before.url !== chosen.url &&
      this._store.state(before.url) === 'ready'
    ) {
      previous = sources.find((s) => s.url === before.url) ?? before;
    }
    choice.chosen = chosen;
    choice.previous = previous;
    choice.width = width;
    if (chosen) this._store.request(chosen.url, el);
  }

  /** What an `<img>` chooses between (HTML's "update the source set"): the
   *  first `<source>` that offers a set, or its own, with the `sizes`
   *  that measures it. */
  private _select(
    img: Element,
    env: SourceEnv,
  ): { source: Element | null; set: Candidate[]; sizes: SizeEntry[] } {
    for (const child of sourcesOf(img)) {
      if (child === img) {
        const own = this._srcset(attr(img, 'srcset') ?? '');
        const src = attr(img, 'src');
        // `src` is a `1x` candidate where the set has none, and is no
        // candidate where the set sizes by width
        const set =
          src &&
          !own.some((c) => c.width !== undefined || (c.density ?? 1) === 1)
            ? [...own, { url: src }]
            : own;
        return { source: null, set, sizes: this._sizesOf(attr(img, 'sizes')) };
      }
      if (!isElement(child) || tagOf(child) !== 'source') continue;
      const srcset = attr(child, 'srcset');
      if (srcset === undefined) continue;
      const set = this._srcset(srcset);
      if (!set.length) continue;
      const media = attr(child, 'media');
      if (media !== undefined && !this._matches(media, env)) continue;
      const type = attr(child, 'type');
      if (type !== undefined && !env.decodes(type)) continue;
      // a source's `sizes` left out before an image that allows `auto` is
      // `auto` (HTML 4.8.2), as Chrome, Firefox and WebKit all read it
      const sizes = attr(child, 'sizes');
      return {
        source: child,
        set,
        sizes:
          sizes === undefined && allowsAutoSizes(img)
            ? AUTO_SIZES
            : this._sizesOf(sizes),
      };
    }
    return { source: null, set: [], sizes: [] };
  }

  private _srcset(text: string): Candidate[] {
    let set = this._srcsets.get(text);
    if (!set) {
      if (this._srcsets.size >= KEPT) this._srcsets.clear();
      this._srcsets.set(text, (set = parseSrcset(text)));
    }
    return set;
  }

  private _sizesOf(text: string | undefined): SizeEntry[] {
    if (!text) return [];
    let entries = this._sizes.get(text);
    if (!entries) {
      if (this._sizes.size >= KEPT) this._sizes.clear();
      this._sizes.set(text, (entries = parseSizes(text)));
    }
    for (const entry of entries) {
      if (/v(?:h|b|min|max)\b/i.test(entry.length)) this.readsHeight = true;
      if (entry.media && readsHeight(entry.media)) this.readsHeight = true;
    }
    return entries;
  }

  private _matches(text: string, env: SourceEnv): boolean {
    let media = this._media.get(text);
    if (!media) {
      if (this._media.size >= KEPT) this._media.clear();
      this._media.set(text, (media = parseMediaQuery(text)));
    }
    if (readsHeight(media)) this.readsHeight = true;
    return mediaMatches([media], env.width, env.scheme, env.height, env.scale);
  }
}

/** Whether a media query asks about the viewport's height. */
function readsHeight(media: MediaCondition[]): boolean {
  return media.some(
    (c) =>
      c.minHeight !== undefined ||
      c.maxHeight !== undefined ||
      c.minAspect !== undefined ||
      c.maxAspect !== undefined,
  );
}

function envKey(env: SourceEnv): string {
  return `${env.width}|${env.height}|${env.scale}|${env.scheme}`;
}

/** What an `<img>`'s choice reads, as one string: a choice is made again
 *  when it changes. */
function signatureOf(img: Element): string {
  let out = '';
  for (const el of sourcesOf(img)) {
    if (el === img) {
      return `${out}\u0000${attr(img, 'srcset')}\u0001${attr(img, 'sizes')}\u0001${attr(img, 'src')}`;
    }
    if (!isElement(el) || tagOf(el) !== 'source') continue;
    out += `\u0000${attr(el, 'srcset')}\u0001${attr(el, 'sizes')}\u0001${attr(el, 'media')}\u0001${attr(el, 'type')}`;
  }
  return out;
}
