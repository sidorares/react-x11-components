// Drawings kept on offscreen surfaces of their own, made once for a key and
// composited after: how a blurred shadow is drawn a second time without its
// blur. ntk bakes a shadow's blur on every fill of a path — a path has no
// short name to cache it by — which put 500ms on each repaint of a grid of
// thirty cards; the name is the shadow's geometry and colour, which only
// the painter knows, so the cache is here.
//
// And a box whose transform is animating, drawn on a surface once and
// composited through the matrix each frame has (`SpriteStore`): what turned
// a card on X11 drew the card and everything in it again sixty times a
// second, for pixels that had not changed.

import { Surface } from 'react-x11/ntk';

/** ntk's `Surface`, as this uses it. */
export interface SurfaceLike {
  getContext(kind: '2d'): unknown;
  destroy?(): void;
}

interface Kept {
  surface: SurfaceLike;
  pixels: number;
}

/**
 * A transparent surface of its own, the caller's to destroy once drawn: a
 * masked element is drawn on one and composited. Null where the backend
 * has no offscreen surface — the headless mock.
 */
export function newSurface(
  app: unknown,
  width: number,
  height: number,
): SurfaceLike | null {
  try {
    return new Surface(app as never, {
      width,
      height,
    }) as unknown as SurfaceLike;
  } catch {
    return null;
  }
}

/**
 * Surfaces by key, the least recently drawn given up first once they hold
 * more than `budget` pixels. One too large for a quarter of the budget is
 * not made, and the caller draws the thing itself; so does one on a backend
 * with no offscreen surface — the headless mock — after the first attempt.
 */
export class SurfaceCache {
  private readonly kept = new Map<string, Kept>();
  private pixels = 0;
  private unavailable = false;

  constructor(
    private readonly app: unknown,
    private readonly budget = 8 * 1024 * 1024,
  ) {}

  /** Whether a surface is kept under `key`. */
  has(key: string): boolean {
    return this.kept.has(key);
  }

  get(
    key: string,
    width: number,
    height: number,
    draw: (ctx: unknown) => void,
  ): SurfaceLike | null {
    const hit = this.kept.get(key);
    if (hit) {
      // re-inserted: a Map iterates in insertion order, oldest first
      this.kept.delete(key);
      this.kept.set(key, hit);
      return hit.surface;
    }
    const pixels = width * height;
    if (this.unavailable || !(width > 0 && height > 0)) return null;
    if (pixels > this.budget / 4) return null;
    let surface: SurfaceLike;
    try {
      surface = new Surface(this.app as never, {
        width,
        height,
      }) as unknown as SurfaceLike;
    } catch {
      this.unavailable = true;
      return null;
    }
    // a new surface is transparent: ntk clears its pixmap as it makes it
    draw(surface.getContext('2d'));
    this.kept.set(key, { surface, pixels });
    this.pixels += pixels;
    for (const [oldest, entry] of this.kept) {
      if (this.pixels <= this.budget || entry.surface === surface) break;
      this.kept.delete(oldest);
      this.pixels -= entry.pixels;
      entry.surface.destroy?.();
    }
    return surface;
  }

  destroy(): void {
    for (const entry of this.kept.values()) entry.surface.destroy?.();
    this.kept.clear();
    this.pixels = 0;
  }
}

interface Sprite {
  surface: SurfaceLike;
  width: number;
  height: number;
  key: string;
  /** Kept while its box animates, and given up once it does not. */
  animated: boolean;
}

/**
 * Surfaces kept for boxes from one paint to the next: a box drawn on a
 * surface of its own — one that turns, or a group an opacity fades — is
 * drawn on one once, and each paint after composites it, through the matrix
 * and at the opacity it has then (`paintSprite`). A surface answers for the
 * size it was made at and for its key — what the painter knows the drawing
 * depends on — and for nothing else, so the element forgets the ones a
 * change reaches (`drop`, `clear`), and the ones kept for an animation once
 * it is over (`sweep`). At most `budget` pixels are kept, the least recently
 * drawn given up first, and none is made larger than a quarter of it: that
 * box is drawn on a surface for each paint, as before.
 */
export class SpriteStore {
  private readonly kept = new Map<object, Sprite>();
  private pixels = 0;
  private unavailable = false;

  constructor(
    private readonly app: unknown,
    private readonly budget = 8 * 1024 * 1024,
  ) {}

  /** How many surfaces are kept. */
  get size(): number {
    return this.kept.size;
  }

  /** Whether a surface is kept for `box`. */
  has(box: object): boolean {
    return this.kept.has(box);
  }

  /** The surface kept for `box`, drawn at this size under `key`; null where
   *  none is, and one kept under another is given up. */
  get(
    box: object,
    width: number,
    height: number,
    key: string,
  ): SurfaceLike | null {
    const hit = this.kept.get(box);
    if (!hit) return null;
    if (hit.width !== width || hit.height !== height || hit.key !== key) {
      this.drop(box);
      return null;
    }
    // re-inserted: a Map iterates in insertion order, oldest first
    this.kept.delete(box);
    this.kept.set(box, hit);
    return hit.surface;
  }

  /** A transparent surface kept for `box` from now on — while it animates,
   *  where `animated` — for the caller to draw under `key`; null where none
   *  is made: too large, or no surface to be had. */
  make(
    box: object,
    width: number,
    height: number,
    key: string,
    animated = false,
  ): SurfaceLike | null {
    this.drop(box);
    const pixels = width * height;
    if (this.unavailable || !(width > 0 && height > 0)) return null;
    if (pixels > this.budget / 4) return null;
    // a new surface is transparent: ntk clears its pixmap as it makes it
    const surface = newSurface(this.app, width, height);
    if (!surface) {
      this.unavailable = true;
      return null;
    }
    this.kept.set(box, { surface, width, height, key, animated });
    this.pixels += width * height;
    for (const oldest of this.kept.keys()) {
      if (this.pixels <= this.budget || oldest === box) break;
      this.drop(oldest);
    }
    return surface;
  }

  /** Give up the surface kept for `box`, where one is. */
  drop(box: object): void {
    const sprite = this.kept.get(box);
    if (!sprite) return;
    this.kept.delete(box);
    this.pixels -= sprite.width * sprite.height;
    sprite.surface.destroy?.();
  }

  /** Give up each surface kept for an animation whose box `animates` says
   *  no longer does. */
  sweep(animates: (box: object) => boolean): void {
    for (const [box, sprite] of [...this.kept]) {
      if (sprite.animated && !animates(box)) this.drop(box);
    }
  }

  clear(): void {
    for (const sprite of this.kept.values()) sprite.surface.destroy?.();
    this.kept.clear();
    this.pixels = 0;
  }
}
