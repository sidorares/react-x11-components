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
//    stencil buffer, a fan per ring is a polygon with its holes — the same
//    non-zero rule the retained renderer fills with — and the same records
//    drawn as segments are the polygon's outline.
//
// Between two polylines (or rings) sits one {@link BREAK} record. The two
// segments that touch it collapse in the vertex shader, which is cheaper
// than the index buffer that would otherwise say where every part ends.
//
// And one index buffer, the polygons' **triangles**: each polygon — an
// exterior ring and the holes after it — cut by earstrip, its indices naming
// fill records, so the triangles cost four bytes an index and no vertex of
// their own (`docs/components/maps.md` has what it costs and saves). The fan
// is exact for any ring and pays for it twice on the GPU: a fan covers a
// concave ring's hull, a pixel once for every time the ring winds past it,
// and a cover pass over the whole layer then reads the count back. The
// triangles cover each pixel of the polygon once and nothing else, so an
// opaque fill is one draw with no stencil at all. The fan stays: it is what
// the renderer falls back to on a table without `drawElements`, and an
// overlay, built each time the view moves, is not worth cutting.
//
// Coordinates are normalised to {@link TILE_EXTENT} because `extent` is a
// per-*layer* field that real tiles vary (Shortbread cuts `streets`, `land`,
// `ocean` and `water_polygons` at 2048 and everything else at 4096), and a
// per-draw extent would be one more uniform on the hottest loop in the
// renderer for no benefit.
import { batch as triangulate } from '#earstrip';

import { GeomType, GeometryBuffer } from '../mvt.js';
import type { FeatureCursor, VectorTile } from '../mvt.js';
import type { PreparedLayer, PreparedStyle } from '../paint.js';
import type { MapStyleLayer } from '../style.js';
import type { TileId } from '../proj.js';
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
  /**
   * A fill layer's `[firstIndex, indexCount]` pairs into the tile's
   * triangle indices, three to a triangle. Absent for a line or a circle
   * layer, and for an overlay's fills, which only have the fan.
   */
  triangles?: number[];
}

/** What building a tile's buckets cost and produced. */
export interface BucketStats {
  features: number;
  /** Records written to the line stream, sentinels included. */
  lineRecords: number;
  /** Records written to the fill stream, closing points and sentinels
   *  included. */
  fillRecords: number;
  /** Triangles the polygons were cut into. */
  triangles: number;
  /** Of {@link ms}, what cutting them took. */
  triangulateMs: number;
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
  /** The polygons' triangles: `triangleIndices` uint32 indices of fill
   *  records, three to a triangle. */
  triangles: ArrayBuffer;
  triangleIndices: number;
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
    triangles: new ArrayBuffer(0),
    triangleIndices: 0,
    draws: [],
    raster: { width, height, pixels },
    stats: {
      features: 0,
      lineRecords: 0,
      fillRecords: 0,
      triangles: 0,
      triangulateMs: 0,
      groups: 0,
      ms: 0,
    },
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
 *  point as the fan's apex, then a sentinel. Answers the record its first
 *  point went to, or -1 for a ring too short to fill. */
function emitRing(
  fill: Stream,
  coords: Int32Array,
  from: number,
  to: number,
  k: number,
): number {
  const count = to - from;
  if (count < 3) return -1;
  const first = fill.count;
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
  return first;
}

/**
 * A tile's polygons, gathered as their rings go into the fill stream and cut
 * into triangles in one earstrip call at the end: one crossing into
 * WebAssembly a tile, where a call a polygon would be twenty thousand on a
 * city tile. The coordinates are the records' own, normalised and rounded,
 * so a triangle's corners are exactly the points the fan and the edge draw.
 */
class Polygons {
  coords = new Float64Array(2048);
  /** The fill record each vertex is. */
  records = new Uint32Array(1024);
  vertices = 0;
  /** Polygon `p`'s first vertex. */
  starts: number[] = [];
  /** Each hole's first vertex, counted from its polygon's. */
  holes: number[] = [];
  /** Polygon `p`'s first entry in {@link holes}. */
  holeStarts: number[] = [];
  private _open = false;

  get count(): number {
    return this.starts.length;
  }

  /**
   * A ring written at fill record `record`. An exterior ring — positive
   * area, MVT 4.3.4.4 — opens a polygon and an interior one is a hole in the
   * open one; an interior ring with no polygon open is filled as one, which
   * is what the non-zero fan does with it too.
   */
  ring(
    record: number,
    coords: Int32Array,
    from: number,
    to: number,
    k: number,
    area: number,
  ): void {
    // No area is nothing to fill, and a hole of none would cut nothing.
    if (record < 0 || area === 0) return;
    if (area > 0 || !this._open) {
      this.starts.push(this.vertices);
      this.holeStarts.push(this.holes.length);
      this._open = true;
    } else {
      this.holes.push(this.vertices - this.starts[this.starts.length - 1]);
    }
    const count = to - from;
    this._reserve(this.vertices + count);
    const xy = this.coords;
    const records = this.records;
    let v = this.vertices;
    for (let i = from; i < to; i++) {
      xy[v * 2] = coord(coords[i * 2], k);
      xy[v * 2 + 1] = coord(coords[i * 2 + 1], k);
      records[v] = record + (i - from);
      v++;
    }
    this.vertices = v;
  }

  /** The feature is over: its next ring, whatever it is, opens a polygon. */
  close(): void {
    this._open = false;
  }

  /** Every polygon's triangles, as fill-record indices, and where polygon
   *  `p`'s start in them: `offsets[p]`. */
  cut(): {
    indices: Uint32Array<ArrayBuffer>;
    offsets: Uint32Array<ArrayBuffer>;
  } {
    const count = this.count;
    this.starts.push(this.vertices);
    this.holeStarts.push(this.holes.length);
    const { indices, offsets } = triangulate(
      this.coords.subarray(0, this.vertices * 2),
      this.starts,
      this.holes,
      this.holeStarts,
    );
    this.starts.length = count;
    this.holeStarts.length = count;
    const records = this.records;
    for (let i = 0; i < indices.length; i++) indices[i] = records[indices[i]];
    return { indices, offsets };
  }

  private _reserve(vertices: number): void {
    if (this.records.length >= vertices) return;
    let size = this.records.length;
    while (size < vertices) size *= 2;
    const coords = new Float64Array(size * 2);
    coords.set(this.coords.subarray(0, this.vertices * 2));
    this.coords = coords;
    const records = new Uint32Array(size);
    records.set(this.records.subarray(0, this.vertices));
    this.records = records;
  }
}

interface Group {
  mask: number;
  features: number[];
  fill: [number, number];
  line: [number, number];
  /** `[firstPolygon, polygonCount]` in the tile's {@link Polygons}. */
  polygons: [number, number];
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
  /** Which tile — what a label layer's `snapInto` distance is measured
   *  against (`../anchors.ts`). */
  id?: TileId,
): GlTileData {
  const started = now();
  const line = new Stream(1024);
  const fill = new Stream(1024);
  const polygons = new Polygons();
  /** Each fill layer's draw, with its `[firstPolygon, polygonCount]` pairs
   *  — its triangles once the tile's polygons are cut. */
  const fills: { draw: LayerDraw; polygons: number[] }[] = [];
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
        group = {
          mask,
          features: [],
          fill: [0, 0],
          line: [0, 0],
          polygons: [0, 0],
        };
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
      const polygonsFrom = polygons.count;
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
          if (needFill && polygon) {
            const record = emitRing(fill, buffer.coords, from, to, k);
            polygons.ring(
              record,
              buffer.coords,
              from,
              to,
              k,
              buffer.areas[part],
            );
          }
          if (needLine) emitLine(line, buffer.coords, from, to, k, polygon);
        }
        polygons.close();
      }
      // A group's points end in a sentinel like a polyline does, so the
      // instance count of their range is the number of points.
      if (needPoints && line.count > lineFrom) {
        line.reserve(1);
        pushBreak(line);
      }
      group.fill = [fillFrom, fill.count - fillFrom];
      group.line = [lineFrom, line.count - lineFrom];
      group.polygons = [polygonsFrom, polygons.count - polygonsFrom];
    }
    groupCount += order.length;

    for (let j = 0; j < active.length; j++) {
      const { index, type } = active[j];
      const ranges: number[] = [];
      const cut: number[] = [];
      for (const group of order) {
        if (!(group.mask & (1 << j))) continue;
        const [first, count] = type === 'fill' ? group.fill : group.line;
        if (count < 2) continue;
        coalesce(ranges, first, count);
        if (type === 'fill' && group.polygons[1] > 0) {
          coalesce(cut, group.polygons[0], group.polygons[1]);
        }
      }
      if (ranges.length === 0) continue;
      const draw: LayerDraw = { layer: index, kind: type, ranges };
      draws[index] = draw;
      if (type === 'fill') fills.push({ draw, polygons: cut });
    }
  }

  let triangles = new Uint32Array(0);
  const cutStarted = now();
  if (polygons.count > 0) {
    const { indices, offsets } = polygons.cut();
    triangles = indices;
    for (const { draw, polygons: cut } of fills) {
      const ranges: number[] = [];
      for (let r = 0; r < cut.length; r += 2) {
        const first = offsets[cut[r]];
        const count = offsets[cut[r] + cut[r + 1]] - first;
        if (count > 0) coalesce(ranges, first, count);
      }
      draw.triangles = ranges;
    }
  } else {
    for (const { draw } of fills) draw.triangles = [];
  }
  const triangulateMs = now() - cutStarted;

  return {
    line: line.take(),
    lineRecords: line.count,
    fill: fill.take(),
    fillRecords: fill.count,
    triangles: triangles.buffer,
    triangleIndices: triangles.length,
    draws,
    labels: buildTileLabels(tile, prepared, TILE_EXTENT, id),
    stats: {
      features,
      lineRecords: line.count,
      fillRecords: fill.count,
      triangles: triangles.length / 3,
      triangulateMs,
      groups: groupCount,
      ms: now() - started,
    },
  };
}

/** `[first, count]` onto a list of pairs. Adjacent groups coalesce into one
 *  range, so a layer is one draw whenever the groups it spans were written
 *  next to each other. */
function coalesce(ranges: number[], first: number, count: number): void {
  const last = ranges.length - 2;
  if (last >= 0 && ranges[last] + ranges[last + 1] === first) {
    ranges[last + 1] += count;
  } else {
    ranges.push(first, count);
  }
}
