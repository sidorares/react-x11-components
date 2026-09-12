// A tile's features as GPU-ready streams — the GL renderer's whole CPU side.
//
// The retained renderer (`../paint.ts`) turns a tile into *pixels*, once per
// zoom level and style, and composites the pixels; this turns it into
// *geometry*, once per tile, and draws the geometry every frame. That is the
// entire difference, and it is why nothing here knows about a camera, a
// scale or a style colour: a bucket is valid for every zoom, every pan,
// every display scale and every palette, so a style change is a uniform
// write and a fractional zoom is a matrix.
//
// Two streams, both made of 8-byte **records**, and one idea behind both:
// the GPU draws *segment i* from records `i` and `i + 1` of a stream, as one
// instance — so a polyline of `k` points is `k` consecutive records and
// costs nothing to "tessellate". There is no extrusion, no join geometry and
// no triangulation on the CPU at all: the vertex shader widens a segment into
// a quad and the fragment shader rounds its ends, so joins, caps and
// antialiasing come out of one distance function (see `./shaders.ts`).
//
//  - **line** — `x:int16, y:int16, dist:float32`. `dist` is how far along
//    its polyline the point is, in tile units, for dashes.
//  - **fill** — `x:int16, y:int16, ax:int16, ay:int16`. Every ring is closed
//    explicitly and each record carries its ring's first point as `a`, so
//    segment `i` with `a` is a triangle of the ring's fan. Drawn into the
//    stencil buffer, a fan per ring is a polygon with its holes — no
//    triangulator, the same non-zero rule the retained renderer fills with.
//    The same records drawn as segments are the polygon's outline.
//
// Between two polylines (or rings) sits one {@link BREAK} record. The two
// segments that touch it collapse in the vertex shader, which is cheaper
// than the index buffer that would otherwise say where every part ends.
//
// Coordinates are normalised to {@link TILE_EXTENT} because `extent` is a
// per-*layer* field that real tiles vary (Shortbread cuts `streets`, `land`,
// `ocean` and `water_polygons` at 2048 and everything else at 4096), and a
// per-draw extent would be one more uniform on the hottest loop in the
// renderer for no benefit.
import { GeomType, GeometryBuffer } from '../mvt.js';
import type { FeatureCursor, VectorTile } from '../mvt.js';
import type { PreparedLayer, PreparedStyle } from '../paint.js';
import type { MapStyleLayer } from '../style.js';
import { buildTileLabels } from '../anchors.js';
import type { GlLabelData } from '../anchors.js';

/** Tile units across a tile, after normalisation. */
export const TILE_EXTENT = 4096;

/** The int16 that marks the end of a polyline or ring. Real coordinates are
 *  clamped to one above it. */
export const BREAK = -32768;

/** Bytes per record, in either stream. */
export const RECORD_BYTES = 8;

/** A `circle` layer's points are line-stream records too, one per point —
 *  a disc each — with a sentinel after them. */
export type DrawKind = 'fill' | 'line' | 'circle';

/** What one style layer draws from one tile. */
export interface LayerDraw {
  /** Index into {@link PreparedStyle.layers}. */
  layer: number;
  kind: DrawKind;
  /**
   * `[firstRecord, recordCount]` pairs into the kind's stream. A range of
   * `n` records is `n - 1` segment instances; the last record of every
   * range is a {@link BREAK}, so the instance that would join a range to
   * whatever follows it is a degenerate one.
   */
  ranges: number[];
}

/** What building a tile's buckets cost and produced. */
export interface BucketStats {
  features: number;
  /** Records written to the line stream, sentinels included. */
  lineRecords: number;
  /** Records written to the fill stream, closing points and sentinels
   *  included. */
  fillRecords: number;
  /** Membership groups — distinct sets of style layers a feature belongs
   *  to. What decides how many draw ranges a layer needs. */
  groups: number;
  ms: number;
}

/** One tile, ready for upload. Plain typed arrays and a small draw list, so
 *  it can be built on a worker and transferred without a copy. */
export interface GlTileData {
  /** The line stream: `lineRecords` records over one buffer. */
  line: ArrayBuffer;
  lineRecords: number;
  /** The fill stream: `fillRecords` records. */
  fill: ArrayBuffer;
  fillRecords: number;
  /** Indexed by style layer; a hole where this tile has nothing to draw. */
  draws: (LayerDraw | undefined)[];
  /** Where the tile's labels could go — see `../anchors.ts`. */
  labels?: GlLabelData;
  /** A raster tile's image — RGBA, not premultiplied, as a source decodes
   *  it — in place of streams: its own texture, and no style. */
  raster?: { width: number; height: number; pixels: Uint8Array };
  stats: BucketStats;
}

/** A raster tile as the store keeps it: its image, and nothing to build. */
export function rasterTileData(
  width: number,
  height: number,
  pixels: Uint8Array,
): GlTileData {
  return {
    line: new ArrayBuffer(0),
    lineRecords: 0,
    fill: new ArrayBuffer(0),
    fillRecords: 0,
    draws: [],
    raster: { width, height, pixels },
    stats: { features: 0, lineRecords: 0, fillRecords: 0, groups: 0, ms: 0 },
  };
}

/** Whether a style layer is one this renderer draws from a tile at all. */
function drawable(
  layer: MapStyleLayer,
): layer is Extract<MapStyleLayer, { type: DrawKind }> {
  // Symbol layers are labels, which are placed per frame and not bucketed.
  return (
    (layer.type === 'fill' ||
      layer.type === 'line' ||
      layer.type === 'circle') &&
    layer.visible !== false
  );
}

/** `paint.ts`'s rule: a `line` layer takes polygons too — stroking a ring is
 *  what a style asking for an outline means — a `fill` only polygons, and a
 *  `circle` only points. */
function takes(type: DrawKind, geometry: GeomType): boolean {
  if (type === 'circle') return geometry === GeomType.Point;
  return type === 'fill'
    ? geometry === GeomType.Polygon
    : geometry === GeomType.LineString || geometry === GeomType.Polygon;
}

/** Points, a record each, for a circle layer's discs. */
function emitPoints(
  line: Stream,
  coords: Int32Array,
  from: number,
  to: number,
  k: number,
): void {
  line.reserve(to - from);
  for (let i = from; i < to; i++) {
    const at = line.count;
    line.i16[at * 4] = coord(coords[i * 2], k);
    line.i16[at * 4 + 1] = coord(coords[i * 2 + 1], k);
    line.f32[at * 2 + 1] = 0;
    line.count++;
  }
}

const globals = globalThis as { performance?: { now(): number } };
const now = (): number => globals.performance?.now() ?? Date.now();

/** A growable stream of 8-byte records, viewed both ways. */
export class Stream {
  bytes: ArrayBuffer;
  i16: Int16Array;
  f32: Float32Array;
  count = 0;

  constructor(records: number) {
    this.bytes = new ArrayBuffer(records * RECORD_BYTES);
    this.i16 = new Int16Array(this.bytes);
    this.f32 = new Float32Array(this.bytes);
  }

  reserve(more: number): void {
    const want = (this.count + more) * RECORD_BYTES;
    if (want <= this.bytes.byteLength) return;
    let size = this.bytes.byteLength || RECORD_BYTES * 64;
    while (size < want) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(
      new Uint8Array(this.bytes, 0, this.count * RECORD_BYTES),
    );
    this.bytes = next;
    this.i16 = new Int16Array(next);
    this.f32 = new Float32Array(next);
  }

  /** The records written, trimmed to size — what is kept and uploaded. */
  take(): ArrayBuffer {
    return this.bytes.slice(0, this.count * RECORD_BYTES);
  }
}

/** A tile coordinate, normalised and kept clear of the sentinel. */
function coord(v: number, k: number): number {
  const s = Math.round(v * k);
  return s < -32767 ? -32767 : s > 32767 ? 32767 : s;
}

/** A line stream's sentinel. The caller has reserved the record. */
export function pushBreak(line: Stream): void {
  const at = line.count * 4;
  line.i16[at] = BREAK;
  line.i16[at + 1] = BREAK;
  line.f32[line.count * 2 + 1] = 0;
  line.count++;
}

/** A fill stream's sentinel. The caller has reserved the record. */
export function pushFillBreak(fill: Stream): void {
  const at = fill.count * 4;
  fill.i16[at] = BREAK;
  fill.i16[at + 1] = BREAK;
  fill.i16[at + 2] = BREAK;
  fill.i16[at + 3] = BREAK;
  fill.count++;
}

/** One part as a polyline: its points, then (for a ring) its first point
 *  again, then a sentinel. */
function emitLine(
  line: Stream,
  coords: Int32Array,
  from: number,
  to: number,
  k: number,
  closed: boolean,
): void {
  const count = to - from;
  if (count < 2) return;
  line.reserve(count + 2);
  const i16 = line.i16;
  const f32 = line.f32;
  let dist = 0;
  let px = coord(coords[from * 2], k);
  let py = coord(coords[from * 2 + 1], k);
  const firstX = px;
  const firstY = py;
  let at = line.count;
  i16[at * 4] = px;
  i16[at * 4 + 1] = py;
  f32[at * 2 + 1] = 0;
  at++;
  for (let i = from + 1; i < to; i++) {
    const x = coord(coords[i * 2], k);
    const y = coord(coords[i * 2 + 1], k);
    dist += Math.hypot(x - px, y - py);
    i16[at * 4] = x;
    i16[at * 4 + 1] = y;
    f32[at * 2 + 1] = dist;
    at++;
    px = x;
    py = y;
  }
  if (closed && (px !== firstX || py !== firstY)) {
    dist += Math.hypot(firstX - px, firstY - py);
    i16[at * 4] = firstX;
    i16[at * 4 + 1] = firstY;
    f32[at * 2 + 1] = dist;
    at++;
  }
  line.count = at;
  pushBreak(line);
}

/** One ring as a fan: its points, closed, each carrying the ring's first
 *  point as the fan's apex, then a sentinel. */
function emitRing(
  fill: Stream,
  coords: Int32Array,
  from: number,
  to: number,
  k: number,
): void {
  const count = to - from;
  if (count < 3) return;
  fill.reserve(count + 2);
  const i16 = fill.i16;
  const ax = coord(coords[from * 2], k);
  const ay = coord(coords[from * 2 + 1], k);
  let at = fill.count * 4;
  for (let i = from; i < to; i++) {
    i16[at] = coord(coords[i * 2], k);
    i16[at + 1] = coord(coords[i * 2 + 1], k);
    i16[at + 2] = ax;
    i16[at + 3] = ay;
    at += 4;
  }
  i16[at] = ax;
  i16[at + 1] = ay;
  i16[at + 2] = ax;
  i16[at + 3] = ay;
  fill.count += count + 1;
  pushFillBreak(fill);
}

interface Group {
  mask: number;
  features: number[];
  fill: [number, number];
  line: [number, number];
}

/**
 * Build a tile's buckets for a style.
 *
 * The style is walked in the same **runs** the retained painter uses —
 * consecutive style layers over one source layer — and each run's features
 * are read once. The new part is what happens to a feature's answer: every
 * feature gets a *membership mask*, the set of the run's layers that select
 * it, and features are written grouped by mask. A road network is fourteen
 * style layers over `streets` whose casing and fill select exactly the same
 * roads, so `motorway-casing` and `motorway` share one group and one copy of
 * the geometry: two draws over the same records, with a different width and
 * colour. Without the grouping every feature would be copied once per layer
 * that draws it — twice for every road — and without it being contiguous
 * a layer would be one draw per feature.
 */
export function buildTileBuckets(
  tile: VectorTile,
  prepared: PreparedStyle,
): GlTileData {
  const started = now();
  const line = new Stream(1024);
  const fill = new Stream(1024);
  const buffer = new GeometryBuffer();
  const draws: (LayerDraw | undefined)[] = new Array(prepared.layers.length);
  let features = 0;
  let groupCount = 0;
  let cursor: FeatureCursor | null = null;

  for (const run of prepared.runs) {
    const source = tile.layers.get(run.sourceLayer);
    if (!source || source.length === 0) continue;
    const active: { index: number; prepared: PreparedLayer; type: DrawKind }[] =
      [];
    for (let i = run.from; i < run.to; i++) {
      const layer = prepared.layers[i].layer;
      if (drawable(layer)) {
        active.push({
          index: i,
          prepared: prepared.layers[i],
          type: layer.type,
        });
      }
    }
    // A mask is a 32-bit integer. A run longer than that is not one any
    // style has been written with; its tail draws nothing rather than
    // aliasing onto the head.
    if (active.length > 31) active.length = 31;
    if (active.length === 0) continue;
    const k = TILE_EXTENT / source.extent;

    cursor = source.feature(0);
    const byMask = new Map<number, Group>();
    const order: Group[] = [];
    for (let f = 0; f < source.length; f++) {
      source.seek(f, cursor);
      let mask = 0;
      for (let j = 0; j < active.length; j++) {
        if (!takes(active[j].type, cursor.type)) continue;
        if (!active[j].prepared.filter(cursor)) continue;
        mask |= 1 << j;
      }
      if (mask === 0) continue;
      let group = byMask.get(mask);
      if (!group) {
        group = { mask, features: [], fill: [0, 0], line: [0, 0] };
        byMask.set(mask, group);
        order.push(group);
      }
      group.features.push(f);
    }

    for (const group of order) {
      let needFill = false;
      let needLine = false;
      let needPoints = false;
      for (let j = 0; j < active.length; j++) {
        if (!(group.mask & (1 << j))) continue;
        if (active[j].type === 'fill') needFill = true;
        else if (active[j].type === 'circle') needPoints = true;
        else needLine = true;
      }
      const fillFrom = fill.count;
      const lineFrom = line.count;
      for (const f of group.features) {
        source.seek(f, cursor);
        cursor.readGeometry(buffer);
        if (buffer.parts === 0) continue;
        features++;
        const polygon = cursor.type === GeomType.Polygon;
        const points = cursor.type === GeomType.Point;
        for (let part = 0; part < buffer.parts; part++) {
          const from = buffer.starts[part];
          const to = buffer.starts[part + 1];
          if (points) {
            if (needPoints) emitPoints(line, buffer.coords, from, to, k);
            continue;
          }
          if (needFill && polygon) emitRing(fill, buffer.coords, from, to, k);
          if (needLine) emitLine(line, buffer.coords, from, to, k, polygon);
        }
      }
      // A group's points end in a sentinel like a polyline does, so the
      // instance count of their range is the number of points.
      if (needPoints && line.count > lineFrom) {
        line.reserve(1);
        pushBreak(line);
      }
      group.fill = [fillFrom, fill.count - fillFrom];
      group.line = [lineFrom, line.count - lineFrom];
    }
    groupCount += order.length;

    for (let j = 0; j < active.length; j++) {
      const { index, type } = active[j];
      const ranges: number[] = [];
      for (const group of order) {
        if (!(group.mask & (1 << j))) continue;
        const [first, count] = type === 'fill' ? group.fill : group.line;
        if (count < 2) continue;
        const last = ranges.length - 2;
        // Adjacent groups coalesce into one range, so a layer is one draw
        // whenever the groups it spans were written next to each other.
        if (last >= 0 && ranges[last] + ranges[last + 1] === first) {
          ranges[last + 1] += count;
        } else {
          ranges.push(first, count);
        }
      }
      if (ranges.length > 0)
        draws[index] = { layer: index, kind: type, ranges };
    }
  }

  return {
    line: line.take(),
    lineRecords: line.count,
    fill: fill.take(),
    fillRecords: fill.count,
    draws,
    labels: buildTileLabels(tile, prepared, TILE_EXTENT),
    stats: {
      features,
      lineRecords: line.count,
      fillRecords: fill.count,
      groups: groupCount,
      ms: now() - started,
    },
  };
}
