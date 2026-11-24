// An OGC 3D Tiles 1.0 tileset, walked for a camera and fetched a tile at a time.
//
// Pure of GL and of React: the fetch is a seam (`TilesetOptions.fetch`) so a test drives it with a fake tree.
// What it knows is the tileset's rules — a box and a geometric error per node, REPLACE refinement, external
// `.json` tilesets standing in for a node's children, and a session id the first content URI carries that every
// later request must send back — and what it hands out is the set of tiles to draw this frame.
// `src/` is built with no DOM or Node types, so the fetch globals are named structurally.
interface Res {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
declare const fetch: (url: string, init: { signal: unknown }) => Promise<Res>; // eslint-disable-line
declare const URL: new (
  u: string,
  base?: string,
) => {
  searchParams: {
    get(k: string): string | null;
    set(k: string, v: string): void;
  };
  toString(): string;
};
declare const AbortController: new () => { signal: unknown; abort(): void };
declare const AbortSignal: {
  any(s: unknown[]): unknown;
  timeout(ms: number): unknown;
};
import { boxDistance, boxSphere, sphereVisible } from './geo.js';
import type { Orbit, V3 } from './geo.js';

export interface TileNode {
  boundingVolume: { box?: number[] };
  geometricError: number;
  content?: { uri?: string; url?: string };
  children?: TileNode[];
}

export interface TilesetOptions {
  /** The root tileset's URL. */
  url: string;
  /** Appended to every request (`key=…`). */
  query?: Record<string, string>;
  /** Replaces `fetch`; given the full URL. */
  fetch?: (url: string, signal: unknown) => Promise<Res>;
  /** Most requests in flight at once. 8 by default. */
  concurrency?: number;
  onChange?: () => void;
  onError?: (message: string) => void;
}

/** What the traversal decided for one frame. */
export interface Selection {
  /** Content URIs to draw, every one of them loaded. */
  draw: string[];
  /** Whether everything wanted is loaded, which is when the view is as sharp as it will get. */
  complete: boolean;
  /** Nodes visited, for the stats. */
  visited: number;
}

export interface SelectOptions {
  orbit: Orbit;
  /** viewport height and aspect */
  height: number;
  aspect: number;
  /** a node is refined while its error would span more than this many pixels. 16 by default. */
  maxError?: number;
  /** stop visiting past this many nodes, a safety net */
  maxNodes?: number;
  /** the far plane, metres: nothing past it is wanted */
  far?: number;
  /** the camera's eye and axes in Earth-centred metres */
  eye: V3;
  axes: { forward: V3; right: V3; up: V3 };
}

const isJson = (uri: string) => /\.json(\?|$)/.test(uri);
const contentOf = (n: TileNode) => n.content?.uri ?? n.content?.url;

export class Tileset<T> {
  private _root: TileNode | null = null;
  private _json = new Map<string, TileNode | 'pending' | 'failed'>();
  private _tiles = new Map<string, T>();
  private _state = new Map<string, 'pending' | 'failed'>();
  private _queue: string[] = [];
  private _inflight = 0;
  private _session = '';
  private _abort = new AbortController();
  private _tick = 0;
  private _used = new Map<string, number>();
  /** Decodes a downloaded tile; the caller owns what comes back. */
  decode: ((uri: string, bytes: Uint8Array) => Promise<T>) | null = null;
  /** Called with a tile the cache let go of. */
  onEvict: ((uri: string, tile: T) => void) | null = null;

  constructor(private _o: TilesetOptions) {}

  get loaded(): number {
    return this._tiles.size;
  }
  get pending(): number {
    return this._queue.length + this._inflight;
  }
  tile(uri: string): T | undefined {
    this._used.set(uri, this._tick);
    return this._tiles.get(uri);
  }

  /** A request's URL: resolved, with the key and the session the tileset handed out. */
  urlOf(uri: string): string {
    const u = new URL(uri, this._o.url);
    const own = u.searchParams.get('session');
    if (own) this._session = own;
    else if (this._session) u.searchParams.set('session', this._session);
    for (const [k, v] of Object.entries(this._o.query ?? {}))
      u.searchParams.set(k, v);
    return u.toString();
  }

  private async _get(uri: string): Promise<Res> {
    const url = this.urlOf(uri);
    const signal = AbortSignal.any([
      this._abort.signal,
      AbortSignal.timeout(60000),
    ]);
    const res = await (
      this._o.fetch ?? ((u, sig) => fetch(u, { signal: sig }))
    )(url, signal);
    if (!res.ok)
      throw new Error(
        `${res.status} ${(await res.text()).slice(0, 100)}`.replace(
          this._o.query?.key ?? '\0',
          '<key>',
        ),
      );
    return res;
  }

  /** Starts the root request; `select` answers nothing until it lands. */
  open(): void {
    if (this._root || this._json.has('')) return;
    this._json.set('', 'pending');
    this._get(this._o.url)
      .then((r) => r.json() as Promise<{ root: TileNode }>)
      .then((j) => {
        this._root = j.root;
        this._json.set('', j.root);
        this._o.onChange?.();
      })
      .catch((e: Error) => {
        this._json.set('', 'failed');
        this._o.onError?.(`tileset: ${e.message}`);
      });
  }

  private _children(n: TileNode): TileNode[] | null {
    const uri = contentOf(n);
    if (uri && isJson(uri)) {
      const hit = this._json.get(uri);
      if (hit === undefined) {
        this._json.set(uri, 'pending');
        this._get(uri)
          .then((r) => r.json() as Promise<{ root: TileNode }>)
          .then((j) => {
            this._json.set(uri, j.root);
            this._o.onChange?.();
          })
          .catch((e: Error) => {
            this._json.set(uri, 'failed');
            this._o.onError?.(`tileset ${uri}: ${e.message}`);
          });
        return null;
      }
      return typeof hit === 'string' ? null : [hit];
    }
    return n.children ?? [];
  }

  private _want(uri: string): boolean {
    if (this._tiles.has(uri)) return true;
    if (!this._state.has(uri)) {
      this._state.set(uri, 'pending');
      this._queue.push(uri);
      this._pump();
    }
    return false;
  }

  private _pump(): void {
    while (this._inflight < (this._o.concurrency ?? 8) && this._queue.length) {
      // newest first: what the camera wants now matters more than what it wanted a moment ago
      const uri = this._queue.pop()!;
      this._inflight++;
      this._get(uri)
        .then(async (r) =>
          this.decode!(uri, new Uint8Array(await r.arrayBuffer())),
        )
        .then((t) => {
          this._tiles.set(uri, t);
          this._state.delete(uri);
          this._used.set(uri, this._tick);
          this._o.onChange?.();
        })
        .catch((e: Error) => {
          this._state.set(uri, 'failed');
          this._o.onError?.(`tile: ${e.message}`);
        })
        .finally(() => {
          this._inflight--;
          this._pump();
        });
    }
  }

  /**
   * The tiles to draw for a camera. A node is refined while its geometric error, projected, is bigger than
   * `maxError` pixels; refinement is taken only when every part of it is loaded, and until then the node's own
   * (coarser) tile stays on screen, so the picture never has a hole in it.
   */
  select(o: SelectOptions): Selection {
    this._tick++;
    this.open();
    const out: Selection = { draw: [], complete: true, visited: 0 };
    if (!this._root) return { ...out, complete: false };
    const maxError = o.maxError ?? 16;
    const maxNodes = o.maxNodes ?? 4000;
    const { forward, right, up } = o.axes;
    const far = o.far ?? 3e7;
    const k = o.height / (2 * Math.tan((o.orbit.fov * Math.PI) / 360));
    const visit = (n: TileNode): { draw: string[]; ready: boolean } => {
      const none = { draw: [], ready: true };
      out.visited++;
      if (out.visited > maxNodes) return none;
      const box = n.boundingVolume.box;
      if (!box) return none;
      const s = boxSphere(box);
      if (
        !sphereVisible(
          s.c,
          s.r,
          o.eye,
          forward,
          right,
          up,
          o.orbit.fov,
          o.aspect,
          far,
        )
      )
        return none;
      const dist = Math.max(boxDistance(box, o.eye), 1);
      const sse = (n.geometricError * k) / dist;
      const uri = contentOf(n);
      const glb = uri && !isJson(uri) ? uri : undefined;
      const refine = sse > maxError;
      if (!refine) {
        if (glb) {
          const ok = this._want(glb);
          return { draw: ok ? [glb] : [], ready: ok };
        }
        // a node with no content of its own: its children stand in for it
      }
      const kids = this._children(n);
      if (!kids) {
        // the external tileset is on its way; whatever this node holds stays up until then
        if (glb && this._tiles.has(glb)) return { draw: [glb], ready: false };
        return { draw: [], ready: false };
      }
      if (!kids.length) {
        if (glb) {
          const ok = this._want(glb);
          return { draw: ok ? [glb] : [], ready: ok };
        }
        return none;
      }
      const parts = kids.map(visit);
      if (parts.every((p) => p.ready))
        return { draw: parts.flatMap((p) => p.draw), ready: true };
      // some child is not here yet: hold this node's own tile, which they would replace, in front. It is asked
      // for after the children, and the queue takes the newest first, so the coarse tile lands before the fine.
      if (glb && this._want(glb)) return { draw: [glb], ready: false };
      return { draw: parts.flatMap((p) => p.draw), ready: false };
    };
    const r = visit(this._root);
    out.draw = r.draw.filter((u) => this._tiles.has(u));
    out.complete = r.ready;
    this._evict(new Set(out.draw));
    return out;
  }

  private _evict(keep: Set<string>, limit = 600): void {
    if (this._tiles.size <= limit) return;
    const old = [...this._tiles.keys()]
      .filter((u) => !keep.has(u))
      .sort((a, b) => (this._used.get(a) ?? 0) - (this._used.get(b) ?? 0));
    for (const u of old) {
      if (this._tiles.size <= limit) break;
      this.onEvict?.(u, this._tiles.get(u)!);
      this._tiles.delete(u);
      this._used.delete(u);
      this._state.delete(u);
    }
  }

  dispose(): void {
    this._abort.abort();
    for (const [u, t] of this._tiles) this.onEvict?.(u, t);
    this._tiles.clear();
    this._queue = [];
  }
}
