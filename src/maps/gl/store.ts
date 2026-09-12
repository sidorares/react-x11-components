// Tiles for the GL renderer: loaded, parsed, bucketed, and let go.
//
// The retained renderer's cache has three layers (data, surfaces, labels);
// this one has one, because a tile's buckets are valid for every camera and
// every palette. What it keeps per tile is the bucket arrays — a few hundred
// kilobytes where the retained cache keeps two 4 MB surfaces — and the only
// thing that invalidates them is a style whose *filters* changed, since the
// filters are what decide which features a layer draws. Colours, widths and
// zoom ranges are uniforms and gates, read every frame; a light-to-dark
// switch rebuilds nothing.
//
// Building is the one cost a tile has, and there are two places to pay it.
// On this thread, `pump` builds until the frame's deadline — always at
// least one tile, the retained renderer's budget rule — and a dense city
// tile is 5–20 ms of it, which is most of a 50 Hz frame. On **worker
// threads** (`workers > 0`) this thread only dispatches: the bytes go over
// by copy, the buckets come back by transfer, and the main thread's whole
// cost for a tile is its upload. The bucket format is what makes the second
// one free to have — two ArrayBuffers and a small draw list, nothing that
// needs a serializer.
import { parseVectorTile } from '../sources.js';
import type { MapSource, TileData } from '../sources.js';
import type { TileId } from '../proj.js';
import type { PreparedStyle } from '../paint.js';
import type { MapStyleLayer } from '../style.js';
import { buildTileBuckets } from './buckets.js';
import type { GlTileData } from './buckets.js';
import type { BuildRequest } from './build-worker.js';
import type { TileLookup } from './cover.js';

type State = 'loading' | 'loaded' | 'building' | 'ready' | 'empty' | 'failed';

interface Entry {
  tile: TileId;
  state: State;
  /** The tile's bytes, kept so a style change can rebuild without a fetch. */
  bytes: Uint8Array | null;
  data: GlTileData | null;
  /** The frame the cover last asked for this tile — the eviction order. */
  used: number;
  retryAt: number;
  failures: number;
  /** The worker job whose answer this entry is waiting for. */
  job: number;
  /** Cancels the load in flight, while there is one. */
  abort: (() => void) | null;
}

export interface GlTileStoreOptions {
  source: MapSource;
  /** What the source is called in its requests and its errors —
   *  `source-<index>` when it has no `id`. */
  sourceId?: string;
  prepared: PreparedStyle;
  /**
   * Called once per failed load, with whatever the source threw — what
   * `<Map onTileError>` hears. A load aborted because the map stopped
   * wanting the tile is not a failure, whatever it answers after that.
   */
  onError?: (error: unknown, tile: TileId & { sourceId: string }) => void;
  /** A load landed or a build finished: a frame is worth drawing. */
  onChange: () => void;
  /** Loads in flight at once. 8 by default. */
  concurrency?: number;
  /** Tiles kept, bytes and buckets both. 256 by default. */
  capacity?: number;
  /**
   * Build buckets on this many worker threads. `0` (the default) builds on
   * this thread under `pump`'s budget. Falls back to that when the runtime
   * has no `worker_threads`.
   */
  workers?: number;
}

const globals = globalThis as {
  performance?: { now(): number };
  AbortController?: new () => { signal: { aborted: boolean }; abort(): void };
};
const now = (): number => globals.performance?.now() ?? Date.now();
const key = (t: TileId): string => `${t.z}/${t.x}/${t.y}`;

export class GlTileStore implements TileLookup {
  private readonly _source: MapSource;
  private readonly _sourceId: string;
  private readonly _onError:
    ((error: unknown, tile: TileId & { sourceId: string }) => void) | undefined;
  private _prepared: PreparedStyle;
  private _style: { id: number; layers: MapStyleLayer[] };
  private readonly _onChange: () => void;
  private readonly _concurrency: number;
  private readonly _capacity: number;
  private readonly _entries = new Map<string, Entry>();
  /** Loaded tiles waiting for a build, oldest first. */
  private _queue: Entry[] = [];
  private _waiting: Entry[] = [];
  private _inFlight = 0;
  private _frame = 0;
  private _disposed = false;
  private readonly _pool: BuildPool | null;
  /** Bucket builds and their cost on this thread, for a HUD. */
  built = 0;
  buildMs = 0;

  constructor(options: GlTileStoreOptions) {
    this._source = options.source;
    this._sourceId = options.sourceId ?? options.source.id ?? 'source-0';
    this._onError = options.onError;
    this._prepared = options.prepared;
    this._style = {
      id: 1,
      layers: options.prepared.layers.map((l) => l.layer),
    };
    this._onChange = options.onChange;
    this._concurrency = options.concurrency ?? 8;
    this._capacity = options.capacity ?? 256;
    const workers = options.workers ?? 0;
    this._pool =
      workers > 0 ? new BuildPool(workers, () => this._onChange()) : null;
  }

  get source(): MapSource {
    return this._source;
  }

  /** Tiles loaded and waiting for (or in) a build. */
  get building(): number {
    let n = this._queue.length;
    for (const entry of this._entries.values())
      if (entry.state === 'building') n++;
    return n;
  }

  /** Tiles asked for and not yet answered. */
  get loading(): number {
    return this._inFlight + this._waiting.length;
  }

  /** Whether builds happen off this thread. */
  get threaded(): boolean {
    return this._pool?.ready === true;
  }

  get(tile: TileId): GlTileData | null | undefined {
    const entry = this._entries.get(key(tile));
    if (!entry) return undefined;
    entry.used = this._frame;
    if (entry.state === 'ready') return entry.data;
    if (entry.state === 'empty') return null;
    // A tile being rebuilt for a new style keeps drawing its old buckets
    // until the new ones exist, so a restyle never opens a hole.
    return entry.data ?? undefined;
  }

  /** A new frame: what the cover asks for from here on is this frame's. */
  tick(): void {
    this._frame++;
  }

  /** Ask for tiles, centre-out. Already-known tiles cost a lookup. */
  want(tiles: readonly TileId[]): void {
    const at = now();
    for (const tile of tiles) {
      const k = key(tile);
      let entry = this._entries.get(k);
      if (entry && !(entry.state === 'failed' && at >= entry.retryAt)) continue;
      if (!entry) {
        entry = {
          tile,
          state: 'loading',
          bytes: null,
          data: null,
          used: this._frame,
          retryAt: 0,
          failures: 0,
          job: 0,
          abort: null,
        };
        this._entries.set(k, entry);
      }
      entry.state = 'loading';
      this._waiting.push(entry);
    }
    this._drain();
  }

  private _drain(): void {
    while (this._inFlight < this._concurrency && this._waiting.length > 0) {
      const entry = this._waiting.shift()!;
      // Asked for, then scrolled away from before a slot came free.
      if (entry.used < this._frame - 2) {
        this._entries.delete(key(entry.tile));
        continue;
      }
      this._load(entry);
    }
  }

  private _load(entry: Entry): void {
    this._inFlight++;
    // A real `AbortController` where the runtime has one: `fetch` rejects a
    // signal that is not an instance of `AbortSignal`, so a look-alike would
    // fail every load a source makes the documented way (`../tiles.ts`).
    const controller = globals.AbortController
      ? new globals.AbortController()
      : null;
    let aborted = false;
    entry.abort = () => {
      aborted = true;
      controller?.abort();
    };
    const { z, x, y } = entry.tile;
    const sourceId = this._sourceId;
    Promise.resolve()
      .then(() =>
        this._source.load({ z, x, y, sourceId, signal: controller?.signal }),
      )
      .then(
        (data: TileData) => {
          if (this._disposed || aborted) return;
          entry.failures = 0;
          if (data && data.kind === 'vector' && data.data.length > 0) {
            entry.bytes = data.data;
            entry.state = 'loaded';
            this._queue.push(entry);
          } else {
            // No data, or a raster tile, which this renderer does not draw.
            entry.state = 'empty';
          }
        },
        (error: unknown) => {
          // Whatever an aborted load answers — its `AbortError` included —
          // is not news: the map stopped wanting the tile.
          if (this._disposed || aborted) return;
          entry.failures++;
          entry.state = 'failed';
          // 0.5 s, 1, 2, 4 … up to 30 s: the retained cache's backoff, so a
          // source that is down costs nothing and a blip repairs itself.
          entry.retryAt =
            now() + Math.min(30_000, 500 * 2 ** (entry.failures - 1));
          // A failed tile draws nothing, so a map whose tiles all fail looks
          // exactly like a map that is still loading: somebody has to be
          // told, once per failure, as the retained cache tells them.
          this._onError?.(error, { z, x, y, sourceId });
        },
      )
      .finally(() => {
        this._inFlight--;
        entry.abort = null;
        if (this._disposed) return;
        this._drain();
        if (!aborted) this._onChange();
      });
  }

  /**
   * How many of `tiles` failed to load and are waiting on a retry — the
   * frame's `errors`.
   */
  failedAmong(tiles: readonly TileId[]): number {
    let n = 0;
    for (const tile of tiles) {
      if (this._entries.get(key(tile))?.state === 'failed') n++;
    }
    return n;
  }

  /**
   * Stop loading: every load in flight is aborted and forgotten, and nothing
   * waiting is started. For a source taken off the map, whose tiles that
   * have arrived stay, so switching back to it is free — the retained
   * cache's rule.
   */
  abortLoads(): void {
    for (const [k, entry] of this._entries) {
      if (entry.state !== 'loading') continue;
      entry.abort?.();
      this._entries.delete(k);
    }
    this._waiting = [];
  }

  /** Build every tile again from its bytes — `refresh()`, after a style
   *  the application edited in place. The old buckets draw until then. */
  rebuild(): void {
    this._style = { ...this._style, id: this._style.id + 1 };
    this._requeue();
  }

  /**
   * Work through the loaded tiles. Answers whether more are waiting on this
   * thread, which is the caller's cue for another frame.
   *
   * With workers, everything waiting is dispatched and nothing is built
   * here: a finished build calls `onChange` like a finished load does. On
   * this thread, tiles are built until `deadline` — always at least one, or
   * a budget smaller than one tile would build nothing forever.
   */
  pump(deadline: number): boolean {
    const pool = this._pool;
    if (pool && !pool.failed) {
      if (!pool.ready) return this._queue.length > 0;
      while (this._queue.length > 0 && pool.hasRoom()) {
        const entry = this._queue.shift()!;
        if (!entry.bytes) continue;
        entry.state = 'building';
        const style = this._style.id;
        entry.job = pool.build(entry.bytes, this._style, (result) => {
          if (this._disposed || entry.job === 0) return;
          entry.job = 0;
          if (!this._entries.has(key(entry.tile))) return;
          if (result.data && style === this._style.id) {
            entry.data = result.data;
            entry.state = 'ready';
          } else if (result.data) {
            // Built for a style that has since been replaced: build again.
            entry.state = 'loaded';
            this._queue.push(entry);
          } else {
            entry.state = 'empty';
          }
          this._onChange();
        });
      }
      return false;
    }
    let first = true;
    while (this._queue.length > 0 && (first || now() < deadline)) {
      first = false;
      const entry = this._queue.shift()!;
      if (!entry.bytes) continue;
      const started = now();
      try {
        entry.data = buildTileBuckets(
          parseVectorTile(entry.bytes),
          this._prepared,
        );
        entry.state = 'ready';
      } catch {
        entry.state = 'empty';
      }
      this.buildMs += now() - started;
      this.built++;
    }
    return this._queue.length > 0;
  }

  /**
   * A new style. Buckets are rebuilt only if the new one would select
   * different features — a different layer list or different filters —
   * and until a tile is rebuilt its old buckets keep drawing.
   */
  setStyle(prepared: PreparedStyle): void {
    const same = structureOf(prepared) === structureOf(this._prepared);
    this._prepared = prepared;
    if (same) return;
    this._style = {
      id: this._style.id + 1,
      layers: prepared.layers.map((l) => l.layer),
    };
    this._requeue();
  }

  /** Every tile with bytes back on the build queue, most recently drawn
   *  first; each keeps drawing its old buckets until its new ones exist. */
  private _requeue(): void {
    this._queue = [];
    for (const entry of this._entries.values()) {
      if (
        entry.bytes &&
        (entry.state === 'ready' ||
          entry.state === 'loaded' ||
          entry.state === 'building')
      ) {
        entry.state = 'loaded';
        entry.job = 0;
        this._queue.push(entry);
      }
    }
    this._queue.sort((a, b) => b.used - a.used);
  }

  /**
   * The end of a frame: cancel every load it did not want, and let go of the
   * least recently drawn tiles past capacity.
   *
   * A tile panned or zoomed out of the cover — and the ring around it the
   * cover keeps warm — would otherwise load to the end: a request nobody is
   * waiting for, pointed at somebody else's servers. That is the contract
   * the docs make for `request.signal`, on either renderer. A tile that
   * comes back is asked for again, with a new signal.
   */
  evict(release: (data: GlTileData) => void): void {
    for (const [k, entry] of this._entries) {
      if (entry.abort && entry.used < this._frame) {
        entry.abort();
        this._entries.delete(k);
      }
    }
    if (this._entries.size <= this._capacity) return;
    const candidates = [...this._entries.entries()]
      .filter(
        ([, e]) =>
          e.state !== 'loading' &&
          e.state !== 'building' &&
          e.used < this._frame,
      )
      .sort((a, b) => a[1].used - b[1].used);
    let excess = this._entries.size - this._capacity;
    for (const [k, entry] of candidates) {
      if (excess <= 0) break;
      if (entry.data) release(entry.data);
      this._entries.delete(k);
      excess--;
    }
    this._queue = this._queue.filter((e) => this._entries.has(key(e.tile)));
  }

  dispose(release: (data: GlTileData) => void): void {
    this._disposed = true;
    for (const entry of this._entries.values()) {
      if (entry.data) release(entry.data);
    }
    this._entries.clear();
    this._queue = [];
    this._waiting = [];
    this._pool?.terminate();
  }
}

// --- the worker pool ---------------------------------------------------------

interface WorkerLike {
  on(event: 'message' | 'error', listener: (value: unknown) => void): void;
  postMessage(message: BuildRequest, transfer?: ArrayBuffer[]): void;
  terminate(): unknown;
  unref?(): void;
}

interface BuildResult {
  job: number;
  data?: GlTileData;
  error?: string;
}

/** Jobs a worker may hold at once: enough to never sit idle between two
 *  messages, few enough that the store's queue — which is centre-out and
 *  reorders every frame — still decides what is built next. */
const PER_WORKER = 2;
const WORKER_THREADS = 'node:worker_threads';

class BuildPool {
  ready = false;
  failed = false;
  private readonly _slots: {
    worker: WorkerLike;
    busy: number;
    style: number;
  }[] = [];
  private readonly _jobs = new Map<number, (result: BuildResult) => void>();
  private _next = 1;

  constructor(count: number, onReady: () => void) {
    void this._spawn(count).then(onReady);
  }

  private async _spawn(count: number): Promise<void> {
    try {
      // `URL` and `import.meta.url` reached structurally, like everything
      // else runtime-only here: `src/` compiles with `types: []` and no DOM
      // lib, so neither is declared. The entry has to be a URL object, not a
      // string — Node reads a string as a path.
      const here = (import.meta as { url?: string }).url;
      const Url = (
        globalThis as { URL?: new (input: string, base?: string) => object }
      ).URL;
      if (!here || !Url) throw new Error('no module URL to find the worker by');
      const { Worker } = (await import(WORKER_THREADS)) as {
        Worker: new (url: object) => WorkerLike;
      };
      for (let i = 0; i < count; i++) {
        const worker = new Worker(new Url('./build-worker.js', here));
        // An idle pool must not keep the process alive.
        worker.unref?.();
        const slot = { worker, busy: 0, style: 0 };
        worker.on('message', (value) => {
          const result = value as BuildResult;
          slot.busy--;
          const done = this._jobs.get(result.job);
          this._jobs.delete(result.job);
          done?.(result);
        });
        worker.on('error', () => {
          this.failed = true;
        });
        this._slots.push(slot);
      }
      this.ready = true;
    } catch {
      this.failed = true;
    }
  }

  hasRoom(): boolean {
    return this._slots.some((s) => s.busy < PER_WORKER);
  }

  build(
    bytes: Uint8Array,
    style: { id: number; layers: MapStyleLayer[] },
    done: (result: BuildResult) => void,
  ): number {
    let slot = this._slots[0];
    for (const s of this._slots) if (s.busy < slot.busy) slot = s;
    if (slot.style !== style.id) {
      slot.worker.postMessage({
        type: 'style',
        id: style.id,
        layers: style.layers,
      });
      slot.style = style.id;
    }
    const job = this._next++;
    this._jobs.set(job, done);
    // A copy of just this tile's bytes, transferred: the store keeps its own
    // for a restyle, and a view into a larger buffer would clone all of it.
    const copy = bytes.slice();
    slot.busy++;
    slot.worker.postMessage(
      { type: 'build', job, style: style.id, bytes: copy },
      [copy.buffer as ArrayBuffer],
    );
    return job;
  }

  terminate(): void {
    for (const slot of this._slots) void slot.worker.terminate();
    this._slots.length = 0;
    this._jobs.clear();
  }
}

const structures = new WeakMap<PreparedStyle, string>();

/** What in a style decides a tile's buckets: which layers, over which
 *  source layers, with which filters — and for a label layer, which field
 *  its text is read from. Everything else is per frame. */
function structureOf(prepared: PreparedStyle): string {
  let structure = structures.get(prepared);
  if (structure === undefined) {
    structure = JSON.stringify(
      prepared.layers.map(({ layer }) => [
        layer.type,
        layer.sourceLayer,
        layer.visible === false,
        'filter' in layer ? (layer.filter ?? null) : null,
        layer.type === 'symbol' ? layer.textField : null,
      ]),
    );
    structures.set(prepared, structure);
  }
  return structure;
}
