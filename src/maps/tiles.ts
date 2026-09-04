// The tile cache: what has been loaded, what has been drawn, and what may
// be thrown away.
//
// Two caches in one, because they are invalidated by different things and
// a map that conflated them would redraw far too much:
//
//  - **Data** — the parsed {@link VectorTile}, or a raster tile's pixels.
//    Keyed on `source/z/x/y` and valid forever: a tile's contents do not
//    depend on where the camera is.
//  - **A rendered `Surface`** — the tile's features rasterized once, at a
//    size, in a style. Also independent of the camera's *position*, which
//    is the whole point: panning composites the same surfaces at new
//    offsets and rasterizes nothing, and a fractional zoom composites them
//    scaled. Only an integer zoom change, a style change or a display-scale
//    change invalidates one.
//
// The surface is the expensive half — on the corpus in `scripts/bench/`, a
// dense city tile is 50-140 ms to rasterize and about 0.05 ms to composite
// — so the cache's job is to make sure that cost is paid once per tile per
// zoom level, and never during a gesture.
import type { PreparedStyle } from './paint.js';
import type { VectorTile } from './mvt.js';
import { parseTile } from './mvt.js';
import { tileKey } from './proj.js';
import type { TileId } from './proj.js';
import { pyramidOf } from './sources.js';
import type { MapSource, TileData } from './sources.js';

/** The slice of `react-x11/ntk`'s `Surface` this uses. Structural because
 *  the same object is an X pixmap on one backend and a CoreGraphics bitmap
 *  on the other, and neither name appears here. */
export interface SurfaceLike {
  readonly width: number;
  readonly height: number;
  getContext(name: '2d', ...args: unknown[]): unknown;
  clear(): unknown;
  destroy(): void;
}

/** How a surface is made — handed in rather than imported, so a test can
 *  run the whole cache with no display. */
export type SurfaceFactory = (size: number) => SurfaceLike | null;

/** Where a tile has got to. */
export type TileStatus =
  /** Never asked for. */
  | 'idle'
  /** The source was asked and has not answered. */
  | 'loading'
  /** Data is here. */
  | 'ready'
  /** The source said there is nothing here — an ordinary answer, not a
   *  failure, and the reason a map over an ocean is not full of errors. */
  | 'empty'
  /** The source threw. Retried on the next camera change that wants it. */
  | 'error';

/**
 * One rendering of a tile: a surface, the context that draws into it, and
 * what it was drawn for.
 *
 * A tile has up to two — the one on screen and the one being drawn — which
 * is what stops a re-rasterization blanking the map. See
 * {@link CachedTile.shown}.
 */
export interface TileRender {
  surface: SurfaceLike;
  /** Held for the life of the surface rather than made per frame: a context
   *  is a real resource on X11 (a GC, a Picture and a listener on the
   *  pixmap), and rasterization is resumable, so a tile that fills in over a
   *  dozen frames would otherwise make and destroy a dozen of them. */
  context: unknown;
  /** Edge length in device pixels. */
  size: number;
  /** The zoom its style was resolved at. */
  zoom: number;
  /** The cache generation it was drawn under. */
  generation: number;
  /** The next style run to draw, or `-1` when it is finished. */
  progress: number;
  /** …and how far into that run's active layers, because a run is not a
   *  small enough unit on its own: a road network is one run of fourteen
   *  layers and one of those layers alone measured 90 ms. */
  progressLayer: number;
}

/** One tile in the cache. */
export interface CachedTile {
  readonly key: string;
  readonly sourceId: string;
  readonly tile: TileId;
  status: TileStatus;
  error: unknown;
  vector: VectorTile | null;
  raster: { width: number; height: number; data: Uint8Array } | null;
  /**
   * The rendering that is on screen. **Always finished**, which is the
   * whole point of the pair.
   *
   * A tile is re-rasterized whenever its size, its style zoom or the cache
   * generation moves — and above a source's `maxZoom` that is *every*
   * integer zoom, because the same z14 tile serves 15, 16, 17 and on. Drawn
   * in place, each of those clears the surface and leaves the tile blank
   * for the six or so frames it takes to redraw: a visible flash per zoom
   * step, and many more of them on a backend that paints more frames.
   *
   * So the new rendering goes into {@link drawing} and this one keeps being
   * composited until it is ready to be replaced.
   */
  shown: TileRender | null;
  /** The rendering being drawn, or null when there is nothing to draw. */
  drawing: TileRender | null;
  /** Frame counter of the last frame that wanted it — what eviction sorts
   *  on. */
  lastUsed: number;
  /** Cancels an in-flight load. */
  abort: (() => void) | null;
  /** How many times this tile's load has failed in a row. */
  attempts: number;
  /** `Date.now()` before which a failed tile is not asked for again. */
  retryAt: number;
}

function emptyEntry(sourceId: string, tile: TileId, key: string): CachedTile {
  return {
    key,
    sourceId,
    tile,
    status: 'idle',
    error: null,
    vector: null,
    raster: null,
    shown: null,
    drawing: null,
    lastUsed: 0,
    abort: null,
    attempts: 0,
    retryAt: 0,
  };
}

export interface TileCacheOptions {
  /**
   * How many bytes of rendered surfaces to keep. An argb32 surface is
   * `4 × size²`, so a 1024-pixel tile is 4 MB and a retina screenful is
   * about ten of them; the default keeps roughly three screenfuls, which is
   * what makes zooming out and back in free.
   */
  surfaceBudget?: number;
  /** How many tiles' worth of parsed data to keep. Cheap next to the
   *  surfaces (a dense tile is a few hundred KB) and worth keeping longer,
   *  because re-parsing is 5-12 ms. */
  dataBudget?: number;
  /** Called when a load finishes, so the element can ask for a repaint. */
  onChange?: (entry: CachedTile) => void;
  /** Called once per failed load. A map whose tiles all fail looks exactly
   *  like a map that is still loading, so somebody has to be told. */
  onError?: (entry: CachedTile) => void;
}

const DEFAULT_SURFACE_BUDGET = 128 * 1024 * 1024;
const DEFAULT_DATA_BUDGET = 192;

/**
 * The cache.
 *
 * One per element. Nothing in it knows about the camera: it is asked for
 * tiles by name, and told once a frame which ones are still wanted.
 */
export class TileCache {
  private readonly _entries = new Map<string, CachedTile>();
  private readonly _options: TileCacheOptions;
  private _frame = 0;
  private _surfaceBytes = 0;
  /** Bumped by a style change, which retires every surface without
   *  touching the data behind it. */
  private _generation = 0;

  constructor(options: TileCacheOptions = {}) {
    this._options = options;
  }

  /** Bumped once per paint; `lastUsed` is stamped from it. */
  beginFrame(): number {
    return ++this._frame;
  }

  get generation(): number {
    return this._generation;
  }

  /** Every rendered surface is stale — a new style, a new display scale. */
  invalidateStyle(): void {
    this._generation++;
  }

  /** How much the rendered surfaces are holding, in bytes. */
  get surfaceBytes(): number {
    return this._surfaceBytes;
  }

  get size(): number {
    return this._entries.size;
  }

  key(sourceId: string, tile: TileId): string {
    return `${sourceId}:${tileKey(tile)}`;
  }

  peek(sourceId: string, tile: TileId): CachedTile | undefined {
    return this._entries.get(this.key(sourceId, tile));
  }

  /**
   * The entry for a tile, asking the source for it if nothing has yet.
   *
   * Marks it used by the current frame, which is what keeps it out of the
   * next eviction.
   */
  want(source: MapSource, sourceId: string, tile: TileId): CachedTile {
    const key = this.key(sourceId, tile);
    let entry = this._entries.get(key);
    if (!entry) {
      entry = emptyEntry(sourceId, tile, key);
      this._entries.set(key, entry);
    }
    entry.lastUsed = this._frame;
    if (entry.status === 'idle') {
      this._load(source, entry);
    } else if (entry.status === 'error' && Date.now() >= entry.retryAt) {
      // A failed tile is retried, but on a backoff rather than on every
      // frame. Without it a source that is down — or an application whose
      // `load` throws on the first call, which is how this was found — is
      // asked for every visible tile sixty times a second, which is a
      // retry storm pointed at somebody else's servers.
      this._load(source, entry);
    }
    return entry;
  }

  private _load(source: MapSource, entry: CachedTile): void {
    entry.status = 'loading';
    entry.error = null;
    // A **real** `AbortController` where the runtime has one. A look-alike
    // is not good enough: `fetch` checks `instanceof AbortSignal` and
    // throws `TypeError` on anything else, so handing a source a plain
    // object with an `aborted` getter fails every load a source makes the
    // documented way — which is exactly what it did.
    const Controller = (
      globalThis as {
        AbortController?: new () => {
          abort(): void;
          signal: { readonly aborted: boolean };
        };
      }
    ).AbortController;
    let aborted = false;
    const controller = Controller ? new Controller() : null;
    const signal = controller
      ? controller.signal
      : {
          get aborted(): boolean {
            return aborted;
          },
        };
    entry.abort = (): void => {
      aborted = true;
      controller?.abort();
    };
    const fail = (error: unknown): void => {
      entry.status = 'error';
      entry.error = error;
      entry.attempts++;
      // 0.5s, 1, 2, 4, 8, 16, then 30s — long enough that a dead source
      // costs nothing, short enough that a blip repairs itself.
      entry.retryAt =
        Date.now() + Math.min(30_000, 500 * 2 ** (entry.attempts - 1));
    };
    const settle = (fn: () => void): void => {
      // A load that finished after its tile was evicted must not resurrect
      // it: the entry is gone from the map, so writing to it would leak a
      // surface nothing composites.
      if (aborted || this._entries.get(entry.key) !== entry) return;
      entry.abort = null;
      fn();
      if (entry.status === 'error') this._options.onError?.(entry);
      this._options.onChange?.(entry);
    };
    let result: TileData | Promise<TileData>;
    try {
      result = source.load({ ...entry.tile, sourceId: entry.sourceId, signal });
    } catch (error) {
      settle(() => fail(error));
      return;
    }
    const accept = (data: TileData): void =>
      settle(() => {
        entry.attempts = 0;
        entry.retryAt = 0;
        if (data === null) {
          entry.status = 'empty';
          return;
        }
        if (data.kind === 'vector') {
          try {
            entry.vector = parseTile(data.data);
            entry.status = 'ready';
          } catch (error) {
            fail(error);
          }
          return;
        }
        entry.raster = data;
        entry.status = 'ready';
      });
    if (result && typeof (result as Promise<TileData>).then === 'function') {
      (result as Promise<TileData>).then(accept, (error: unknown) =>
        settle(() => fail(error)),
      );
    } else {
      accept(result as TileData);
    }
  }

  /**
   * The nearest ancestor of `tile` that already has a drawn surface, or
   * null.
   *
   * What covers a hole. A zoom in has the previous level's tiles in hand
   * and the new level's on the way, so the coarse picture is scaled up
   * under the fine one until it arrives — which is the difference between a
   * map that fills in and a map that flashes empty. Bounded, because
   * scaling one tile over sixteen screenfuls is worse than the hole.
   */
  ancestorWithSurface(
    sourceId: string,
    tile: TileId,
    levels = 5,
  ): CachedTile | null {
    let z = tile.z - 1;
    let x = tile.x >> 1;
    let y = tile.y >> 1;
    for (let up = 0; up < levels && z >= 0; up++, z--, x >>= 1, y >>= 1) {
      const entry = this._entries.get(this.key(sourceId, { z, x, y }));
      // `shown` is finished by construction, so an ancestor is never a
      // half-drawn picture.
      if (entry?.shown) return entry;
    }
    return null;
  }

  /**
   * The rendering this tile should be drawn into, or null when what is on
   * screen is already right.
   *
   * The size, the zoom and the cache generation are all part of what makes
   * a rendering valid: one drawn at the wrong size composites blurry, and
   * one drawn at another zoom carries the wrong road widths and the wrong
   * layers.
   *
   * When something is already on screen and a *new* rendering is needed,
   * this hands back a second surface and leaves the first one composited
   * until {@link promote} swaps them. That is the whole of the
   * double-buffering: without it a re-rasterization clears the surface and
   * the tile is blank for the several frames it takes to redraw, which
   * above a source's `maxZoom` happens at every integer zoom — the same
   * z14 tile serves 15, 16, 17 and on.
   */
  beginRender(
    entry: CachedTile,
    size: number,
    zoom: number,
    make: SurfaceFactory,
  ): TileRender | null {
    if (this._matches(entry.shown, size, zoom)) return null;
    if (this._matches(entry.drawing, size, zoom)) return entry.drawing;
    // A draft for something else — an intermediate zoom the camera swept
    // past — is thrown away rather than finished.
    if (entry.drawing) this._release(entry.drawing);
    entry.drawing = null;
    const surface = make(size);
    if (!surface) return null;
    this._surfaceBytes += size * size * 4;
    entry.drawing = {
      surface,
      context: surface.getContext('2d'),
      size,
      zoom,
      generation: this._generation,
      progress: 0,
      progressLayer: 0,
    };
    return entry.drawing;
  }

  private _matches(
    render: TileRender | null,
    size: number,
    zoom: number,
  ): boolean {
    return (
      render !== null &&
      render.size === size &&
      render.zoom === zoom &&
      render.generation === this._generation
    );
  }

  /** The finished draft becomes what is on screen, and the old one goes.
   *  True when that happened, which is the one moment a tile's pixels
   *  change and therefore the one moment worth claiming damage for. */
  promote(entry: CachedTile): boolean {
    if (!entry.drawing || entry.drawing.progress !== -1) return false;
    if (entry.shown) this._release(entry.shown);
    entry.shown = entry.drawing;
    entry.drawing = null;
    return true;
  }

  /** Note where a tile's rasterization stopped: at run `run`, having
   *  finished `layer` of its active layers (`-1` for all of them). */
  advance(
    render: TileRender,
    run: number,
    layer: number,
    style: PreparedStyle,
  ): void {
    render.progress = run >= style.runs.length ? -1 : run;
    render.progressLayer = layer < 0 ? 0 : layer;
  }

  /**
   * Drop what is no longer worth keeping.
   *
   * Surfaces go first and by least-recently-wanted, because they are two
   * orders of magnitude larger than the data behind them and much cheaper
   * to lose: a dropped surface is one re-rasterization, a dropped tile is a
   * network request.
   */
  sweep(): void {
    if (
      this._surfaceBytes >
      (this._options.surfaceBudget ?? DEFAULT_SURFACE_BUDGET)
    ) {
      const withSurfaces = [...this._entries.values()]
        .filter((entry) => entry.shown !== null || entry.drawing !== null)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      const budget = this._options.surfaceBudget ?? DEFAULT_SURFACE_BUDGET;
      for (const entry of withSurfaces) {
        if (this._surfaceBytes <= budget) break;
        // Never the frame being drawn: a surface evicted this frame is one
        // that will be rebuilt this frame.
        if (entry.lastUsed >= this._frame) continue;
        this._dropSurface(entry);
      }
    }
    const dataBudget = this._options.dataBudget ?? DEFAULT_DATA_BUDGET;
    if (this._entries.size > dataBudget) {
      const all = [...this._entries.values()].sort(
        (a, b) => a.lastUsed - b.lastUsed,
      );
      for (const entry of all) {
        if (this._entries.size <= dataBudget) break;
        if (entry.lastUsed >= this._frame) continue;
        this._drop(entry);
      }
    }
  }

  private _dropSurface(entry: CachedTile): void {
    if (entry.shown) this._release(entry.shown);
    if (entry.drawing) this._release(entry.drawing);
    entry.shown = null;
    entry.drawing = null;
  }

  private _release(render: TileRender): void {
    this._surfaceBytes -= render.size * render.size * 4;
    (render.context as { destroy?(): void } | null)?.destroy?.();
    render.surface.destroy();
  }

  private _drop(entry: CachedTile): void {
    entry.abort?.();
    this._dropSurface(entry);
    this._entries.delete(entry.key);
  }

  /** Release everything. Called from the element's `destroySubtree`. */
  destroy(): void {
    for (const entry of [...this._entries.values()]) this._drop(entry);
    this._entries.clear();
    this._surfaceBytes = 0;
  }

  /** Every entry — for a test, and for the `onTiles` diagnostic. */
  entries(): IterableIterator<CachedTile> {
    return this._entries.values();
  }
}

/** A source's pyramid, memoized per source object so the defaults are not
 *  refilled per frame. */
const pyramids = new WeakMap<
  MapSource,
  { minZoom: number; maxZoom: number; tileSize: number }
>();

export function pyramid(source: MapSource): {
  minZoom: number;
  maxZoom: number;
  tileSize: number;
} {
  let found = pyramids.get(source);
  if (!found) {
    found = pyramidOf(source);
    pyramids.set(source, found);
  }
  return found;
}
