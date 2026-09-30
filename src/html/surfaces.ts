// Drawings kept on offscreen surfaces of their own, made once for a key and
// composited after: how a blurred shadow is drawn a second time without its
// blur. ntk bakes a shadow's blur on every fill of a path — a path has no
// short name to cache it by — which put 500ms on each repaint of a grid of
// thirty cards; the name is the shadow's geometry and colour, which only
// the painter knows, so the cache is here.

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
