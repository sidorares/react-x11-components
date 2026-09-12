// Labels, the tile's half: where in a tile a label *could* go, worked out
// once per tile — on the worker, with the buckets — and never per frame.
//
// A point label's place is its point. A line label's place is the hard
// part, and the answer here is the one that makes a street name easy to
// read and hard to notice: **on the street, along its centre line, on a
// stretch that is straight** — the name set as one straight run of type,
// never bent around a corner, sitting on the road it names rather than
// beside it. Three steps get there:
//
//  1. **Merge.** A street is one feature per segment in every schema there
//     is — `street_labels` offers "Westminster Bridge Road" 24 times in one
//     London tile — so the pieces of each name are joined end to end into
//     the polylines they were cut from. Without this, a straight avenue cut
//     at every cross street has no stretch longer than a block.
//  2. **Straighten.** Each polyline is walked into its maximal straight
//     *runs*: stretches whose every vertex stays within {@link STRAIGHT} of
//     the chord between the run's ends. A gentle curve is a run; a corner
//     ends one.
//  3. **Anchor.** Each run offers a few anchors on its chord — its middle,
//     the middle of every block between two intersections, and every
//     {@link SPACING} along a long one — each carrying how much straight run
//     lies either side of it and how far it is from the nearest
//     intersection. Whether a label *fits* there is a question of its width
//     in pixels and so of the zoom, and is left to placement; what is
//     computed here is the geometry that answers it at any zoom.
//
// Intersections are found from the label layer itself: a vertex two
// differently named streets share is a junction. A name set across a junction
// hides the street that crosses there, so placement prefers an anchor whose
// label clears one — the middle of a block — to one that does not.
//
// Everything leaves as one Float32Array and a string table, so a worker can
// hand it over with the buckets (see `./store.ts`).
import { GeomType, GeometryBuffer } from '../mvt.js';
import type { FeatureCursor, VectorTile } from '../mvt.js';
import type { PreparedStyle } from '../paint.js';
import type { SymbolLayer } from '../style.js';

/** Floats per anchor record. */
export const LABEL_STRIDE = 10;

/** Field offsets within an anchor record. */
export const LabelField = {
  /** The anchor, in tile units. */
  x: 0,
  y: 1,
  /** The baseline's direction, radians, y down — always upright (see
   *  {@link upright}), so no name is ever read upside down. */
  angle: 2,
  /** Tile units of straight run either side of the anchor — how long a
   *  label it can carry. `-1` for a point label, which carries any. */
  avail: 3,
  /** Tile units either side of the anchor before an intersection. */
  clear: 4,
  /** The straight run's whole length, tile units; `0` for a point. */
  length: 5,
  /** The run's greatest departure from its chord, tile units. */
  dev: 6,
  /** Index into {@link GlLabelData.texts}. */
  text: 7,
  /** Index into the prepared style's layers. */
  layer: 8,
  /** Importance within the layer: a road's class, a place's population. */
  priority: 9,
} as const;

/** A tile's label anchors. */
export interface GlLabelData {
  texts: string[];
  /** {@link LABEL_STRIDE} floats per anchor; see {@link LabelField}. */
  anchors: Float32Array;
  count: number;
  ms: number;
}

/** How far a run may depart from straight, in tile units: one pixel at
 *  the tile's own zoom (a 512-pixel tile is 4096 units), two at the next. */
export const STRAIGHT = 8;
/** The sharpest turn a run takes at one vertex, however small the
 *  departure — a kink reads as a corner under a line of text. */
const MAX_TURN = Math.cos((25 * Math.PI) / 180);
/** Anchors along a long run with no junction on it, in tile units — 256
 *  pixels at the tile's own zoom. */
export const SPACING = 2048;
/** The shortest run worth an anchor: 16 pixels at the tile's own zoom,
 *  which is a label only four levels of overzoom later. */
const MIN_RUN = 128;
/** "No junction within reach", in tile units. */
const FAR = 1e9;

/** A road's importance among roads: the order a map names them in. */
const ROAD_CLASS: Record<string, number> = {
  motorway: 9,
  trunk: 8,
  primary: 7,
  secondary: 6,
  tertiary: 5,
  unclassified: 4,
  residential: 4,
  living_street: 3,
  pedestrian: 3,
  service: 2,
  track: 1,
  footway: 1,
  cycleway: 1,
  path: 1,
  bridleway: 1,
  steps: 0,
};

const globals = globalThis as { performance?: { now(): number } };
const now = (): number => globals.performance?.now() ?? Date.now();

/** `collectLabels`' rule: the style's field, or the local `name` where a
 *  translation is missing — which is most features. */
function textOf(cursor: FeatureCursor, field: string): string {
  const raw = cursor.get(field);
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (field === 'name') return '';
  const local = cursor.get('name');
  return typeof local === 'string' ? local : '';
}

function priorityOf(cursor: FeatureCursor): number {
  const population = cursor.get('population');
  if (typeof population === 'number' && population > 0) {
    return Math.log10(population + 1);
  }
  const kind = cursor.get('kind');
  return typeof kind === 'string' ? (ROAD_CLASS[kind] ?? 0) : 0;
}

/** A vertex as one number: tile coordinates are integers after scaling,
 *  and within ±32768 with the buffer included. */
const vertexKey = (x: number, y: number): number =>
  (Math.round(x) + 32768) * 65536 + (Math.round(y) + 32768);

/** A growable array of anchor records. */
class AnchorWriter {
  data = new Float32Array(LABEL_STRIDE * 256);
  count = 0;

  private _next(): number {
    const at = this.count * LABEL_STRIDE;
    if (at + LABEL_STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.count++;
    return at;
  }

  point(x: number, y: number, text: number, layer: number, priority: number) {
    const at = this._next();
    const d = this.data;
    d[at + LabelField.x] = x;
    d[at + LabelField.y] = y;
    d[at + LabelField.angle] = 0;
    d[at + LabelField.avail] = -1;
    d[at + LabelField.clear] = FAR;
    d[at + LabelField.length] = 0;
    d[at + LabelField.dev] = 0;
    d[at + LabelField.text] = text;
    d[at + LabelField.layer] = layer;
    d[at + LabelField.priority] = priority;
  }

  line(
    x: number,
    y: number,
    angle: number,
    avail: number,
    clear: number,
    length: number,
    dev: number,
    text: number,
    layer: number,
    priority: number,
  ) {
    const at = this._next();
    const d = this.data;
    d[at + LabelField.x] = x;
    d[at + LabelField.y] = y;
    d[at + LabelField.angle] = angle;
    d[at + LabelField.avail] = avail;
    d[at + LabelField.clear] = clear;
    d[at + LabelField.length] = length;
    d[at + LabelField.dev] = dev;
    d[at + LabelField.text] = text;
    d[at + LabelField.layer] = layer;
    d[at + LabelField.priority] = priority;
  }

  take(): Float32Array {
    return this.data.slice(0, this.count * LABEL_STRIDE);
  }
}

/** One name's pieces in one tile, before merging. */
interface LineGroup {
  text: number;
  priority: number;
  parts: number[][];
}

/**
 * A tile's label anchors, for every symbol layer of the style.
 *
 * `extent` is the tile-unit square the anchors are expressed in — the
 * buckets' {@link import('./buckets.js').TILE_EXTENT}, passed in rather than
 * imported so this module does not import the one that calls it. Anchors
 * are kept only inside the tile's own square: the buffer past its edge is
 * the neighbour's, and a label in it would be offered twice.
 */
export function buildTileLabels(
  tile: VectorTile,
  prepared: PreparedStyle,
  extent: number,
): GlLabelData {
  const started = now();
  const texts: string[] = [];
  const index = new Map<string, number>();
  const out = new AnchorWriter();
  const buffer = new GeometryBuffer();

  for (let i = 0; i < prepared.layers.length; i++) {
    const { layer, filter } = prepared.layers[i];
    if (layer.type !== 'symbol' || layer.visible === false) continue;
    const source = tile.layers.get(layer.sourceLayer);
    if (!source || source.length === 0) continue;
    const symbol = layer as SymbolLayer;
    const k = extent / source.extent;
    const cursor = source.feature(0);
    const groups = new Map<number, LineGroup>();
    // Which name first touched each vertex, or -1 once a second did.
    const touched = new Map<number, number>();

    for (let f = 0; f < source.length; f++) {
      source.seek(f, cursor);
      if (!filter(cursor)) continue;
      const text = textOf(cursor, symbol.textField);
      if (text.length === 0) continue;
      let t = index.get(text);
      if (t === undefined) {
        t = texts.length;
        texts.push(text);
        index.set(text, t);
      }
      const priority = priorityOf(cursor);
      cursor.readGeometry(buffer);
      if (buffer.points === 0) continue;

      if (cursor.type === GeomType.LineString) {
        let group = groups.get(t);
        if (!group) {
          group = { text: t, priority, parts: [] };
          groups.set(t, group);
        }
        if (priority > group.priority) group.priority = priority;
        for (let part = 0; part < buffer.parts; part++) {
          const from = buffer.starts[part];
          const to = buffer.starts[part + 1];
          if (to - from < 2) continue;
          const points: number[] = [];
          for (let p = from; p < to; p++) {
            const x = buffer.coords[p * 2] * k;
            const y = buffer.coords[p * 2 + 1] * k;
            // Consecutive duplicates would make zero-length segments, whose
            // direction is undefined.
            const n = points.length;
            if (n > 0 && points[n - 2] === x && points[n - 1] === y) continue;
            points.push(x, y);
            const key = vertexKey(x, y);
            const seen = touched.get(key);
            if (seen === undefined) touched.set(key, t);
            else if (seen !== t) touched.set(key, -1);
          }
          if (points.length >= 4) group.parts.push(points);
        }
        continue;
      }

      const anchor = pointAnchor(buffer, cursor.type);
      if (!anchor) continue;
      const x = anchor.x * k;
      const y = anchor.y * k;
      if (x < 0 || y < 0 || x >= extent || y >= extent) continue;
      out.point(x, y, t, i, priority);
    }

    for (const group of groups.values()) {
      for (const chain of mergeParts(group.parts)) {
        anchorChain(chain, touched, extent, group, i, out);
      }
    }
  }

  return { texts, anchors: out.take(), count: out.count, ms: now() - started };
}

/**
 * Where a point-like feature's label goes: the point, or for a polygon the
 * middle of its largest ring's box — a cheap stand-in for the pole of
 * inaccessibility that lands inside every convex shape.
 */
function pointAnchor(
  buffer: GeometryBuffer,
  type: GeomType,
): { x: number; y: number } | null {
  if (buffer.points === 0) return null;
  if (type === GeomType.Point) {
    return { x: buffer.coords[0], y: buffer.coords[1] };
  }
  let best = 0;
  let bestArea = -1;
  for (let part = 0; part < buffer.parts; part++) {
    const area = Math.abs(buffer.areas[part]);
    if (area > bestArea) {
      bestArea = area;
      best = part;
    }
  }
  const b = best * 4;
  return {
    x: (buffer.partBounds[b] + buffer.partBounds[b + 2]) / 2,
    y: (buffer.partBounds[b + 1] + buffer.partBounds[b + 3]) / 2,
  };
}

/**
 * Join one name's pieces into the polylines they were cut from.
 *
 * Pieces meet at shared end points, in either direction. Where more than one
 * piece continues from a point — a fork, or a dual carriageway's two halves
 * — the one that turns least is taken, so a chain follows the street the way
 * a reader's eye does. Every piece is used exactly once.
 */
export function mergeParts(parts: readonly number[][]): number[][] {
  const ends = new Map<number, number[]>();
  const add = (key: number, end: number): void => {
    const list = ends.get(key);
    if (list) list.push(end);
    else ends.set(key, [end]);
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    add(vertexKey(p[0], p[1]), i * 2);
    add(vertexKey(p[p.length - 2], p[p.length - 1]), i * 2 + 1);
  }
  const used = new Uint8Array(parts.length);

  /** The unused piece that continues from `(x, y)` heading `(dx, dy)` with
   *  the least turn, oriented to start there; or null. */
  const next = (
    x: number,
    y: number,
    dx: number,
    dy: number,
  ): number[] | null => {
    const list = ends.get(vertexKey(x, y));
    if (!list) return null;
    let best: number[] | null = null;
    let bestIndex = -1;
    let bestDot = -Infinity;
    for (const end of list) {
      const i = end >> 1;
      if (used[i]) continue;
      const p = parts[i];
      const oriented = end & 1 ? reversed(p) : p;
      const ux = oriented[2] - oriented[0];
      const uy = oriented[3] - oriented[1];
      const len = Math.hypot(ux, uy) || 1;
      const dot = (ux * dx + uy * dy) / len;
      if (dot > bestDot) {
        bestDot = dot;
        best = oriented;
        bestIndex = i;
      }
    }
    if (best) used[bestIndex] = 1;
    return best;
  };

  const chains: number[][] = [];
  for (let i = 0; i < parts.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = parts[i].slice();
    // Forward from the end, then forward from the start of the reversed
    // chain — which is backward from the original start.
    for (let pass = 0; pass < 2; pass++) {
      for (;;) {
        const n = chain.length;
        const dx = chain[n - 2] - chain[n - 4];
        const dy = chain[n - 1] - chain[n - 3];
        const len = Math.hypot(dx, dy) || 1;
        const more = next(chain[n - 2], chain[n - 1], dx / len, dy / len);
        if (!more) break;
        for (let j = 2; j < more.length; j++) chain.push(more[j]);
      }
      chain = reversed(chain);
    }
    chains.push(chain);
  }
  return chains;
}

function reversed(points: readonly number[]): number[] {
  const out = new Array<number>(points.length);
  for (let i = 0, j = points.length - 2; j >= 0; i += 2, j -= 2) {
    out[i] = points[j];
    out[i + 1] = points[j + 1];
  }
  return out;
}

/** A maximal straight stretch of a chain: vertices `[from, to]`. */
export interface StraightRun {
  from: number;
  to: number;
  /** The chord's length, and the furthest vertex from it. */
  length: number;
  dev: number;
}

/**
 * A chain's maximal straight runs, greedily from its start: a run grows a
 * vertex at a time while every vertex inside it stays within `tolerance`
 * of the chord and no vertex turns sharper than {@link MAX_TURN}. A run
 * ends at the last vertex that kept it straight, and the next one starts
 * there, so runs share their end points and cover the whole chain.
 */
export function straightRuns(
  chain: readonly number[],
  tolerance = STRAIGHT,
): StraightRun[] {
  const n = chain.length / 2;
  const runs: StraightRun[] = [];
  let from = 0;
  while (from < n - 1) {
    let to = from + 1;
    let dev = 0;
    while (to + 1 < n) {
      const d = deviation(chain, from, to + 1);
      if (d > tolerance || !gentle(chain, to)) break;
      dev = d;
      to++;
    }
    const length = Math.hypot(
      chain[to * 2] - chain[from * 2],
      chain[to * 2 + 1] - chain[from * 2 + 1],
    );
    runs.push({ from, to, length, dev });
    from = to;
  }
  return runs;
}

/** The greatest distance of vertices strictly inside `(from, to)` from the
 *  chord between them. */
function deviation(chain: readonly number[], from: number, to: number): number {
  const ax = chain[from * 2];
  const ay = chain[from * 2 + 1];
  const dx = chain[to * 2] - ax;
  const dy = chain[to * 2 + 1] - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Infinity;
  let worst = 0;
  for (let m = from + 1; m < to; m++) {
    const px = chain[m * 2] - ax;
    const py = chain[m * 2 + 1] - ay;
    // Off the chord's ends counts as off the chord: a run that doubles back
    // is not straight however close its points stay to the line.
    const along = (px * dx + py * dy) / len;
    const off =
      along < 0
        ? Math.hypot(px, py)
        : along > len
          ? Math.hypot(px - dx, py - dy)
          : Math.abs(px * dy - py * dx) / len;
    if (off > worst) worst = off;
  }
  return worst;
}

/** Whether the turn at vertex `m` is gentle enough to stay in a run. */
function gentle(chain: readonly number[], m: number): boolean {
  const ax = chain[m * 2] - chain[m * 2 - 2];
  const ay = chain[m * 2 + 1] - chain[m * 2 - 1];
  const bx = chain[m * 2 + 2] - chain[m * 2];
  const by = chain[m * 2 + 3] - chain[m * 2 + 1];
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return true;
  return (ax * bx + ay * by) / (la * lb) >= MAX_TURN;
}

/** How far past vertical a name still reads bottom to top. */
const VERTICAL_BIAS = (10 * Math.PI) / 180;

/**
 * A direction, turned to read left to right — and, near vertical, bottom
 * to top: within [-π/2 - 10°, π/2 - 10°), y down, so -π/2 points up the
 * screen. Without the bias, two streets a few degrees either side of
 * vertical read in opposite directions side by side; with it, every
 * near-vertical name reads the way maps set them, upward.
 */
export function upright(angle: number): number {
  let a = angle;
  while (a >= Math.PI / 2 - VERTICAL_BIAS) a -= Math.PI;
  while (a < -Math.PI / 2 - VERTICAL_BIAS) a += Math.PI;
  return a;
}

/** Every anchor one merged chain offers. */
function anchorChain(
  chain: readonly number[],
  touched: Map<number, number>,
  extent: number,
  group: LineGroup,
  layer: number,
  out: AnchorWriter,
): void {
  for (const run of straightRuns(chain)) {
    const L = run.length;
    if (L < MIN_RUN) continue;
    const ax = chain[run.from * 2];
    const ay = chain[run.from * 2 + 1];
    const ux = (chain[run.to * 2] - ax) / L;
    const uy = (chain[run.to * 2 + 1] - ay) / L;
    // Where along the chord the run's junctions are.
    const junctions: number[] = [];
    for (let m = run.from; m <= run.to; m++) {
      const x = chain[m * 2];
      const y = chain[m * 2 + 1];
      if (touched.get(vertexKey(x, y)) !== -1) continue;
      junctions.push((x - ax) * ux + (y - ay) * uy);
    }
    junctions.sort((a, b) => a - b);

    // The run's middle, the middle of every block, and — on a run with no
    // junction at all — every SPACING either side of the middle.
    const at: number[] = [L / 2];
    const bounds = [0, ...junctions, L];
    for (let b = 0; b + 1 < bounds.length; b++) {
      if (bounds[b + 1] - bounds[b] >= MIN_RUN) {
        at.push((bounds[b] + bounds[b + 1]) / 2);
      }
    }
    if (junctions.length === 0) {
      for (let s = SPACING; L / 2 + s <= L - SPACING / 2; s += SPACING) {
        at.push(L / 2 + s, L / 2 - s);
      }
    }
    at.sort((a, b) => a - b);

    const angle = upright(Math.atan2(uy, ux));
    let last = -Infinity;
    for (const s of at) {
      // Two anchors closer than a few pixels are one anchor twice.
      if (s - last < 32) continue;
      last = s;
      const x = ax + ux * s;
      const y = ay + uy * s;
      if (x < 0 || y < 0 || x >= extent || y >= extent) continue;
      let clear = FAR;
      for (const j of junctions) clear = Math.min(clear, Math.abs(j - s));
      out.line(
        x,
        y,
        angle,
        Math.min(s, L - s),
        clear,
        L,
        run.dev,
        group.text,
        layer,
        group.priority,
      );
    }
  }
}
