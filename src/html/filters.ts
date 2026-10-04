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
  /** Where within a pixel the box's corner fell on the surface `raw` — or
   *  the group, where a context runs the filter — was painted on, across
   *  and down; and where it falls in the paint drawing it now (`placed`).
   *  Where the two differ the box is drawn with that corner where the box's
   *  is, resampled, until it has been still a while (`SETTLE_MS`). */
  rawX: number;
  rawY: number;
  phaseX: number;
  phaseY: number;
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
  /** Where a context runs the filter itself (`through`): the box's group,
   *  painted unfiltered as it draws under `key` while `fresh`, kept to be
   *  filtered again as the filter changes, and bumped as it is painted. */
  group: SurfaceLike | null;
  groupCtx: unknown;
  groupWidth: number;
  groupHeight: number;
  groupSerial: number;
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

/** A context that runs a filter: canvas's own `filter`, a CSS list. */
interface Filtering {
  filter: string;
  save(): void;
  restore(): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: unknown, x: number, y: number): void;
}

/** A timer, as the element's animation clock arms one: what a test holds. */
export interface SettleClock {
  arm(step: () => void, ms: number): unknown;
  disarm(handle: unknown): void;
}

const TIMERS = globalThis as unknown as {
  setTimeout(step: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const SYSTEM_CLOCK: SettleClock = {
  arm: (step, ms) => TIMERS.setTimeout(step, ms),
  disarm: (handle) => TIMERS.clearTimeout(handle),
};

/**
 * How long a box drawn from pixels at another fraction of a pixel than its
 * corner falls on now waits, still, before they are painted again where it
 * is. A box moving under a transition or an animation moves a fraction a
 * frame: asked for at each, the reads landed between frames and each drew
 * the box crisp, at its place, between frames that drew it resampled, and
 * ekazinich.com's turning phones shimmered. So it is resampled all the way,
 * and sharpened once it stops, as a map is (`<Map>`'s settle).
 */
const SETTLE_MS = 120;

/**
 * The element's kept pixels, the least recently drawn given up first once
 * the reads hold more than `budget` pixels.
 */
export class FilterStore {
  private readonly kept = new Map<object, Map<string, Filtered>>();
  private pixels = 0;
  private unavailable = false;
  /** The boxes drawn from pixels at another fraction than theirs since the
   *  settle was last armed, and its timer. */
  private readonly moving = new Set<Filtered>();
  private settling: unknown = null;

  constructor(
    app: unknown,
    /** Told a read arrived for `box` that differs from what it was drawn
     *  from, which the element paints again. */
    private readonly arrived: (box: object) => void,
    private readonly budget = 16 * 1024 * 1024,
    /** Where a surface the filtered pixels go on comes from: the app's. */
    private readonly make: (
      width: number,
      height: number,
    ) => SurfaceLike | null = (width, height) => newSurface(app, width, height),
    private readonly clock: SettleClock = SYSTEM_CLOCK,
  ) {}

  /**
   * Where the box's corner falls within a pixel in the paint drawing it
   * now. Where the pixels it is drawn from were painted with it elsewhere,
   * it is moving: the settle is armed again, and once nothing has moved for
   * `SETTLE_MS` each box still drawn from pixels at another fraction is
   * made stale and painted again, to be drawn from pixels at its own.
   */
  placed(kept: Filtered, fx: number, fy: number): void {
    kept.phaseX = fx;
    kept.phaseY = fy;
    if (kept.rawX === fx && kept.rawY === fy) return;
    this.moving.add(kept);
    if (this.settling !== null) this.clock.disarm(this.settling);
    this.settling = this.clock.arm(() => this._settle(), SETTLE_MS);
  }

  private _settle(): void {
    this.settling = null;
    const moved = [...this.moving];
    this.moving.clear();
    for (const kept of moved) {
      if (kept.dropped) continue;
      if (kept.rawX === kept.phaseX && kept.rawY === kept.phaseY) continue;
      this._stale(kept);
      this.arrived(kept.box);
    }
  }

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
        rawX: 0,
        rawY: 0,
        phaseX: 0,
        phaseY: 0,
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
        group: null,
        groupCtx: null,
        groupWidth: 0,
        groupHeight: 0,
        groupSerial: 0,
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
  read(
    kept: Filtered,
    surface: SurfaceLike,
    from: unknown,
    /** Where within a pixel the box's corner falls on `surface`. */
    fx = 0,
    fy = 0,
  ): boolean {
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
      if (
        was &&
        kept.rawX === fx &&
        kept.rawY === fy &&
        samePixels(was, pixels)
      ) {
        return;
      }
      if (was) this.pixels -= was.width * was.height;
      kept.raw = pixels;
      kept.rawX = fx;
      kept.rawY = fy;
      kept.rawSerial += 1;
      this.pixels += width * height;
      this._trim(kept);
      // a box that is moving takes it up at its next frame, and is painted
      // again once it is still (`placed`): painted now, between frames, it
      // was drawn crisp between frames drawn resampled
      if (later && !this.moving.has(kept)) this.arrived(kept.box);
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
   * The surface the box's group is kept on for `kept`, cleared, and its
   * context, for the caller to paint the box on unfiltered as it draws now,
   * where a context runs the filter itself (`through`). It is fresh until
   * what the box draws changes, and the caller paints it only where it is
   * not: a transition of the filter is the group drawn through each frame's
   * filter, and painted once. Null where no surface can be had.
   */
  group(
    kept: Filtered,
    /** Where within a pixel the box's corner falls on it. */
    fx = 0,
    fy = 0,
  ): { surface: SurfaceLike; ctx: unknown } | null {
    const { width, height } = kept;
    if (
      !kept.group ||
      kept.groupWidth !== width ||
      kept.groupHeight !== height
    ) {
      dropGroup(kept);
      kept.group = this.make(width, height);
      kept.groupCtx = kept.group?.getContext('2d') ?? null;
      kept.groupWidth = width;
      kept.groupHeight = height;
      if (!kept.group) return null;
    } else {
      (kept.groupCtx as Partial<Filtering>).clearRect?.(0, 0, width, height);
    }
    kept.groupSerial += 1;
    kept.fresh = true;
    kept.rawX = fx;
    kept.rawY = fy;
    return { surface: kept.group, ctx: kept.groupCtx };
  }

  /**
   * The group kept for `kept` drawn onto the surface the filtered pixels go
   * on through `filter`, by a context that runs one itself: canvas's
   * `filter`, which react-x11's native context takes for the colour
   * functions (its `src/backend/filter.js`). That is the whole of it, in the
   * paint that asks, with no read and nothing to lag, and drawn again only
   * where the group or the filter is other than it was. Null where the
   * surface's context has no `filter`, or the list does not stick on it,
   * which is remembered: every box is drawn from a read from then on.
   */
  through(kept: Filtered, filter: string): SurfaceLike | null {
    if (this.unfiltered || !kept.group) return null;
    const { width, height } = kept;
    const want = `css ${kept.groupSerial} ${filter}`;
    if (kept.out && kept.outFor === want) return kept.out;
    if (!kept.out || kept.outWidth !== width || kept.outHeight !== height) {
      dropOut(kept);
      kept.out = this.make(width, height);
      kept.outCtx = kept.out?.getContext('2d') as Partial<Writable> | null;
      kept.outWidth = width;
      kept.outHeight = height;
      if (!kept.out) return null;
    }
    const ctx = kept.outCtx as Partial<Filtering> | null;
    let took = !!ctx && 'filter' in ctx && typeof ctx.drawImage === 'function';
    if (took) {
      ctx!.save!();
      try {
        ctx!.filter = filter;
        took = ctx!.filter === filter;
        if (took) {
          ctx!.clearRect!(0, 0, width, height);
          ctx!.drawImage!(kept.group, 0, 0);
        }
      } finally {
        ctx!.restore!();
      }
    }
    if (!took) {
      this.unfiltered = true;
      // what is fresh is a group painted, and no read: one is asked for
      kept.fresh = false;
      return null;
    }
    kept.outFor = want;
    return kept.out;
  }

  /** Whether a context was found that runs no filter of its own, and every
   *  box is drawn from a read. */
  unfiltered = false;

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
      kept.out = this.make(width, height);
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
    if (this.settling !== null) this.clock.disarm(this.settling);
    this.settling = null;
    this.moving.clear();
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
    dropGroup(hit);
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

/** Give up the surface the group is kept on, and its context. */
function dropGroup(kept: Filtered): void {
  (kept.groupCtx as { destroy?(): void } | null)?.destroy?.();
  kept.group?.destroy?.();
  kept.group = null;
  kept.groupCtx = null;
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
