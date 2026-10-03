// The pixels of a box a `filter`'s colour functions are run over, kept
// between paints (`paintFiltered`).
//
// No context this draws on has a filter of its own, and none hands a
// surface's pixels over as it is asked: ntk's are the X server's, a round
// trip away, and the native contexts keep the canvas contract and resolve a
// read a tick later. So a filtered box's group is painted on a surface,
// unfiltered, and read back, and the box is drawn from the newest pixels
// read for it: the matrices it has now are run over them at every paint
// that needs other ones — each frame of a transition of the filter, as a
// hover runs one — and the result put on a surface kept for it.
//
// What the box draws changing makes what was read no longer fresh
// (`stale`), as it makes the element forget the surfaces kept for boxes,
// and the next paint asks for another read. It is not forgotten: until the
// new one arrives the box is drawn from it, through the filter it has now.
// So what lags a round trip is the box's content, and never the filter. A
// box whose content changed but not the filter's amount shows the old
// content for that long; one moving under a transform shows where it was
// a fraction of a pixel ago. Dropped instead, every frame of a transition
// on a page whose animations build the document again drew what was
// filtered last, at the amount it was then, between frames drawn at the
// amount they had: the hover flashed between grey and colour.
//
// Kept by element, and a pseudo-element by its name, rather than by box: a
// build makes every box again, and what was read for an element is what is
// drawn for it until a read under its new boxes arrives.

import { applyMatrices } from './css/filter.js';
import type { ColourMatrix } from './css/filter.js';
import { newSurface } from './surfaces.js';
import type { SurfaceLike } from './surfaces.js';

/** Straight RGBA pixels, as `getImageData` hands them over and
 *  `putImageData` takes them. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** What is kept for one element's box. */
export interface Filtered {
  /** The box last painted, which a read arriving repaints. */
  box: object;
  /** What the box draws under now, and at what size (`at`). */
  key: string;
  width: number;
  height: number;
  /** The newest pixels read for it, unfiltered, null until one arrives. */
  raw: Pixels | null;
  /** Bumped each time `raw` changes, which the surface made of it names. */
  rawSerial: number;
  /** Whether `raw` was read under `key`, and nothing the box draws changed
   *  since: no read is asked for while it is. */
  fresh: boolean;
  /** Whether a read is under way. */
  reading: boolean;
  /** Bumped each time the box goes stale: a read asked for before it lands
   *  as pixels, and not as fresh ones. */
  gen: number;
  /** Given up: a read under way lands on nothing. */
  dropped: boolean;
  /** The filtered pixels, on a surface of their own, and the read and the
   *  matrices they came from. */
  out: SurfaceLike | null;
  /** Its context, made once: on ntk each `getContext` is a context of its
   *  own, the caller's to destroy. */
  outCtx: Partial<Writable> | null;
  outWidth: number;
  outHeight: number;
  outFor: string | null;
  scratch: Pixels | null;
}

/** What a surface hands back for its pixels: ntk's context and the native
 *  ones, each a promise. */
interface Readable {
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<Pixels> | Pixels | undefined;
}

interface Writable {
  putImageData(data: Pixels, x: number, y: number): void;
}

/**
 * The element's kept pixels, the least recently drawn given up first once
 * the reads hold more than `budget` pixels.
 */
export class FilterStore {
  private readonly kept = new Map<object, Map<string, Filtered>>();
  private pixels = 0;
  private unavailable = false;

  constructor(
    private readonly app: unknown,
    /** Told a read arrived for `box` that differs from what it was drawn
     *  from, which the element paints again. */
    private readonly arrived: (box: object) => void,
    private readonly budget = 16 * 1024 * 1024,
  ) {}

  /** How many elements keep pixels. */
  get size(): number {
    return this.kept.size;
  }

  /** Whether anything is kept for an element, or its pseudo-element. */
  has(owner: object, pseudo: string): boolean {
    return !!this.kept.get(owner)?.has(pseudo);
  }

  /**
   * What is kept for `box` — its element's, or its pseudo-element's — now
   * drawn at `width` by `height` under `key`. What was read under another
   * key, or at another size, is no longer fresh.
   */
  at(
    owner: object,
    pseudo: string,
    box: object,
    width: number,
    height: number,
    key: string,
  ): Filtered {
    let slots = this.kept.get(owner);
    let hit = slots?.get(pseudo);
    if (!hit) {
      hit = {
        box,
        key,
        width,
        height,
        raw: null,
        rawSerial: 0,
        fresh: false,
        reading: false,
        gen: 0,
        dropped: false,
        out: null,
        outCtx: null,
        outWidth: 0,
        outHeight: 0,
        outFor: null,
        scratch: null,
      };
      if (!slots) this.kept.set(owner, (slots = new Map()));
      slots.set(pseudo, hit);
    } else {
      // re-inserted: a Map iterates in insertion order, oldest first
      this.kept.delete(owner);
      this.kept.set(owner, slots!);
    }
    hit.box = box;
    if (hit.key !== key || hit.width !== width || hit.height !== height) {
      this._stale(hit);
      hit.key = key;
      hit.width = width;
      hit.height = height;
    }
    return hit;
  }

  /**
   * Read `surface`, the group painted unfiltered under the key `kept` has
   * now through `ctx`, its context. What arrives is the newest pixels for
   * the box, and fresh where nothing it draws changed while the read was
   * under way; where they differ from what it was drawn from, the box is
   * painted again. A read answered at once is used by the paint that asked
   * for it. The surface is the store's to destroy. False where it cannot be
   * read.
   */
  read(kept: Filtered, surface: SurfaceLike, from: unknown): boolean {
    const ctx = from as Partial<Readable> | null;
    if (this.unavailable || typeof ctx?.getImageData !== 'function') {
      this.unavailable = true;
      surface.destroy?.();
      return false;
    }
    const gen = kept.gen;
    const width = kept.width;
    const height = kept.height;
    kept.reading = true;
    let later = false;
    const land = (pixels: Pixels | undefined): void => {
      surface.destroy?.();
      kept.reading = false;
      if (kept.dropped) return;
      if (
        !pixels?.data ||
        pixels.width !== width ||
        pixels.height !== height ||
        kept.width !== width ||
        kept.height !== height
      ) {
        return;
      }
      kept.fresh = kept.gen === gen;
      const was = kept.raw;
      if (was && samePixels(was, pixels)) return;
      if (was) this.pixels -= was.width * was.height;
      kept.raw = pixels;
      kept.rawSerial += 1;
      this.pixels += width * height;
      this._trim(kept);
      if (later) this.arrived(kept.box);
    };
    let answer: Promise<Pixels> | Pixels | undefined;
    try {
      answer = ctx.getImageData(0, 0, width, height);
    } catch {
      kept.reading = false;
      surface.destroy?.();
      return false;
    } finally {
      // the read is asked for as the call is made — on ntk the request is
      // on its way — and the context is the caller's to destroy, a frame
      // of motion at a time; the native one's `destroy` does nothing
      (ctx as { destroy?(): void }).destroy?.();
    }
    if (answer && typeof (answer as Promise<Pixels>).then === 'function') {
      later = true;
      (answer as Promise<Pixels>).then(land, () => land(undefined));
    } else {
      land(answer as Pixels | undefined);
    }
    return true;
  }

  /**
   * The surface the matrices make of the pixels read for `kept`, made again
   * only where they or the pixels are other ones than it holds: null where
   * none can be made, or nothing read is the box's size.
   */
  filtered(
    kept: Filtered,
    matrices: readonly ColourMatrix[],
    matricesKey: string,
  ): SurfaceLike | null {
    const raw = kept.raw;
    if (!raw || raw.width !== kept.width || raw.height !== kept.height) {
      return null;
    }
    const { width, height } = raw;
    const want = `${kept.rawSerial} ${matricesKey}`;
    if (kept.out && kept.outFor === want) return kept.out;
    if (!kept.out || kept.outWidth !== width || kept.outHeight !== height) {
      dropOut(kept);
      kept.out = newSurface(this.app, width, height);
      kept.outCtx = kept.out?.getContext('2d') as Partial<Writable> | null;
      kept.outWidth = width;
      kept.outHeight = height;
      if (!kept.out) return null;
    }
    let scratch = kept.scratch;
    if (!scratch || scratch.width !== width || scratch.height !== height) {
      scratch = kept.scratch = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      };
    }
    const ctx = kept.outCtx;
    if (typeof ctx?.putImageData !== 'function') return null;
    applyMatrices(raw.data, scratch.data, matrices);
    ctx.putImageData(scratch, 0, 0);
    kept.outFor = want;
    return kept.out;
  }

  /** Whether what was read for an element, or its pseudo-element, is no
   *  longer what its box draws: the next paint asks for another read, and
   *  is drawn from this one until it arrives. */
  stale(owner: object, pseudo: string): void {
    const hit = this.kept.get(owner)?.get(pseudo);
    if (hit) this._stale(hit);
  }

  /** `stale` for every element. */
  staleAll(): void {
    for (const slots of this.kept.values()) {
      for (const hit of slots.values()) this._stale(hit);
    }
  }

  clear(): void {
    for (const slots of this.kept.values()) {
      for (const hit of slots.values()) this._drop(hit);
    }
    this.kept.clear();
    this.pixels = 0;
  }

  private _stale(hit: Filtered): void {
    hit.fresh = false;
    hit.gen += 1;
  }

  private _drop(hit: Filtered): void {
    if (hit.raw) this.pixels -= hit.raw.width * hit.raw.height;
    hit.raw = null;
    hit.dropped = true;
    dropOut(hit);
  }

  /** Give up the least recently drawn past the budget, but `keep`. */
  private _trim(keep: Filtered): void {
    for (const [owner, slots] of this.kept) {
      if (this.pixels <= this.budget) return;
      let kept = false;
      for (const [pseudo, hit] of slots) {
        if (hit === keep) {
          kept = true;
          continue;
        }
        this._drop(hit);
        slots.delete(pseudo);
      }
      if (!kept) this.kept.delete(owner);
    }
  }
}

/** Give up the surface the filtered pixels are on, and its context. */
function dropOut(kept: Filtered): void {
  (kept.outCtx as { destroy?(): void } | null)?.destroy?.();
  kept.out?.destroy?.();
  kept.out = null;
  kept.outCtx = null;
  kept.outFor = null;
}

/** Whether two reads hold the same pixels: a read that brings nothing new
 *  repaints nothing. */
function samePixels(a: Pixels, b: Pixels): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const x = a.data;
  const y = b.data;
  if (x.length !== y.length) return false;
  if (x.byteOffset % 4 === 0 && y.byteOffset % 4 === 0) {
    const p = new Uint32Array(x.buffer, x.byteOffset, x.length >> 2);
    const q = new Uint32Array(y.buffer, y.byteOffset, y.length >> 2);
    for (let i = 0; i < p.length; i += 1) if (p[i] !== q[i]) return false;
    return true;
  }
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}
