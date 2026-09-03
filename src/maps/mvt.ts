// Mapbox Vector Tiles, decoded.
//
// MVT 2.1 is the format. Not one format among several: it is what Mapbox,
// MapTiler, Protomaps, Esri, TomTom, Azure Maps and OpenStreetMap's own
// tile server all serve, so a decoder for it is a decoder for the whole
// open half of the industry. (`docs/prd-maps.md` surveys who serves what,
// and which providers are closed.)
//
// Written out rather than taken from `@mapbox/vector-tile` + `pbf`, and the
// reason is not weight — those two are small — but the hot loop. Both
// libraries hand back a fresh array-of-arrays of `{x, y}` objects per
// feature, which for a dense city tile is on the order of 100,000 object
// allocations that exist for one rasterization and are then garbage. The
// decoder here reads geometry into a **caller-owned buffer of typed
// arrays** ({@link readGeometry}), so a tile is rasterized with no
// allocation at all in the per-vertex path, and the convenience shape
// ({@link VectorTileFeature.geometry}) is a wrapper over the same code for
// the callers that want one — hit tests, a GeoJSON export.
//
// Everything else is a straight reading of the specification, and the parts
// that are easy to get subtly wrong carry the spec's own words:
//
//  - a `CommandInteger` is `(id & 0x7) | (count << 3)`;
//  - `MoveTo` is 1 and `LineTo` is 2, each taking two parameters, and
//    `ClosePath` is 7 and takes none;
//  - a `ParameterInteger` is zigzag: `(n >> 1) ^ -(n & 1)`;
//  - coordinates are **deltas from a cursor**, which starts at (0, 0) and
//    persists across commands *and across the parts of one feature*;
//  - a polygon's exterior ring is the one with **positive** area by the
//    surveyor's formula in tile coordinates, where y increases downward —
//    so an exterior ring is clockwise on screen and an interior one is
//    not;
//  - a ring's last point is not repeated before `ClosePath`;
//  - `extent` defaults to 4096, and geometry **may leave** `[0, extent]`,
//    because producers carry a buffer past the edge so a road's join is
//    right where two tiles meet.

/** What a feature's geometry is. The numbers are the specification's. */
export const enum GeomType {
  Unknown = 0,
  Point = 1,
  LineString = 2,
  Polygon = 3,
}

/** A tag value. MVT's seven value types collapse to these three in
 *  JavaScript; which of the four numeric ones it was is not information a
 *  style can use. */
export type FeatureValue = string | number | boolean;

/**
 * Decoded geometry, as flat typed arrays.
 *
 * `coords` is `[x0, y0, x1, y1, …]` in **tile-local integers** — the space
 * `extent` divides, not pixels and not degrees. `starts` indexes it in
 * *points*: part `i` covers `coords[2 * starts[i] .. 2 * starts[i + 1])`,
 * and `starts` has `parts + 1` entries so the last part needs no special
 * case.
 *
 * `areas[i]` is part `i`'s signed area by the surveyor's formula, and is
 * meaningful for {@link GeomType.Polygon} only: positive is an exterior
 * ring, negative an interior one. It is filled during the same pass that
 * reads the vertices, because a second pass over 4,000 points to learn one
 * sign is the sort of thing that turns a 6 ms tile into an 11 ms one.
 */
export interface GeometryData {
  coords: Int32Array;
  starts: Uint32Array;
  areas: Float64Array;
  parts: number;
  points: number;
}

/**
 * A growable {@link GeometryData} a caller keeps between features.
 *
 * The rasterizer allocates one of these per tile — or per element, since it
 * is only scratch — and every feature reads into it. Capacity ratchets up
 * to the largest feature seen and then stops moving, which for a tile means
 * two or three grows in total rather than two per feature.
 */
export class GeometryBuffer implements GeometryData {
  coords: Int32Array;
  starts: Uint32Array;
  areas: Float64Array;
  parts = 0;
  points = 0;

  constructor(points = 1024, parts = 32) {
    this.coords = new Int32Array(points * 2);
    this.starts = new Uint32Array(parts + 1);
    this.areas = new Float64Array(parts);
    this.partBounds = new Float64Array(parts * 4);
  }

  /** Room for `points` vertices, keeping what is already written. */
  reserveCoords(points: number): void {
    if (this.coords.length >= points * 2) return;
    let size = this.coords.length || 2;
    while (size < points * 2) size *= 2;
    const next = new Int32Array(size);
    next.set(this.coords);
    this.coords = next;
  }

  /**
   * Per-part bounding boxes, four numbers each: `minX, minY, maxX, maxY`.
   *
   * The feature-wide box is not enough, and the case that proves it is the
   * one that dominates a low-zoom frame: OSM's `land` layer at zoom 8 is a
   * **single feature** whose geometry is thousands of separate rings, most
   * of them a fraction of a pixel across. Culled as one feature it is never
   * culled; culled per part, almost all of it goes.
   */
  partBounds: Float64Array;

  /** Room for `parts` parts, keeping what is already written. */
  reserveParts(parts: number): void {
    if (this.areas.length >= parts) return;
    let size = this.areas.length || 1;
    while (size < parts) size *= 2;
    const starts = new Uint32Array(size + 1);
    starts.set(this.starts);
    this.starts = starts;
    const areas = new Float64Array(size);
    areas.set(this.areas);
    this.areas = areas;
    const bounds = new Float64Array(size * 4);
    bounds.set(this.partBounds);
    this.partBounds = bounds;
  }

  /** The bounding box of everything written, in tile-local integers.
   *  Free here — the read already touches every vertex — and what lets a
   *  painter skip a building that is a third of a pixel across, which at a
   *  country-wide zoom is most of what a tile contains. */
  minX = 0;
  minY = 0;
  maxX = 0;
  maxY = 0;

  reset(): void {
    this.parts = 0;
    this.points = 0;
    this.starts[0] = 0;
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }
}

// --- the protobuf wire format ----------------------------------------------
//
// A reader rather than a dependency: MVT uses four of protobuf's features
// (varints, zigzag, length-delimited submessages, packed repeated fields)
// and none of the rest, so the whole of what a `pbf` dependency would bring
// is below, at a size where it can be read in one sitting.

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

/** `TextDecoder` through `globalThis`: `src/` compiles with `types: []` and
 *  no DOM lib, so naming the global directly would make this package depend
 *  on one of them. It exists on every runtime this can run on. */
const decoderOf = (): { decode(input: Uint8Array): string } | null => {
  const g = globalThis as {
    TextDecoder?: new (label?: string) => { decode(input: Uint8Array): string };
  };
  return g.TextDecoder ? new g.TextDecoder('utf-8') : null;
};
let utf8: { decode(input: Uint8Array): string } | null | undefined;

/** A malformed tile. Thrown rather than tolerated: a truncated protobuf is
 *  a transport bug, and silently rendering the half of a tile that parsed
 *  is how a map ends up missing a river nobody can explain. */
export class MvtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MvtError';
  }
}

class Reader {
  buf: Uint8Array;
  pos: number;
  end: number;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  /**
   * A varint, as a JavaScript number.
   *
   * Unrolled to seven bytes — 2^49, which covers every field MVT puts in a
   * varint except a feature `id` that used the full 64 bits. Past that the
   * slow path accumulates in floating point and loses the low bits above
   * 2^53; the alternative is a BigInt per id, which costs every tile
   * something to be exact about a case that does not occur in tiles cut
   * from OSM (whose largest ids are ~2^33).
   */
  varint(): number {
    const b = this.buf;
    let p = this.pos;
    let byte = b[p++];
    let value = byte & 0x7f;
    if (byte < 0x80) {
      this.pos = p;
      return value;
    }
    byte = b[p++];
    value |= (byte & 0x7f) << 7;
    if (byte < 0x80) {
      this.pos = p;
      return value;
    }
    byte = b[p++];
    value |= (byte & 0x7f) << 14;
    if (byte < 0x80) {
      this.pos = p;
      return value;
    }
    byte = b[p++];
    value |= (byte & 0x7f) << 21;
    if (byte < 0x80) {
      this.pos = p;
      return value >>> 0;
    }
    // Four bytes carry bits 0-27, so from here the shift would leave int32
    // and the rest has to be *added* in floating point: `1 << 35` is 8, not
    // 34359738368. Above 2^53 the low bits are gone — see the note above.
    let out = value >>> 0;
    for (let shift = 28; shift < 64; shift += 7) {
      byte = b[p++];
      if (byte === undefined) throw new MvtError('varint ran past the end');
      out += (byte & 0x7f) * Math.pow(2, shift);
      if (byte < 0x80) break;
    }
    this.pos = p;
    return out;
  }

  /** A zigzag-encoded signed varint. */
  svarint(): number {
    const n = this.varint();
    return (n >>> 1) ^ -(n & 1);
  }

  skip(wire: number): void {
    if (wire === WIRE_VARINT) {
      while (this.buf[this.pos++] >= 0x80) {
        if (this.pos > this.end) throw new MvtError('varint ran past the end');
      }
    } else if (wire === WIRE_BYTES) {
      this.pos += this.varint();
    } else if (wire === WIRE_FIXED32) {
      this.pos += 4;
    } else if (wire === WIRE_FIXED64) {
      this.pos += 8;
    } else {
      throw new MvtError(`unknown wire type ${wire}`);
    }
    if (this.pos > this.end) throw new MvtError('field ran past the end');
  }

  /** One view over the whole buffer rather than one per read: only a
   *  layer's `values` use these, but a dense tile has thousands of them. */
  private _view: DataView | null = null;
  private view(): DataView {
    if (!this._view) {
      this._view = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength,
      );
    }
    return this._view;
  }

  float(): number {
    const at = this.pos;
    this.pos += 4;
    return this.view().getFloat32(at, true);
  }

  double(): number {
    const at = this.pos;
    this.pos += 8;
    return this.view().getFloat64(at, true);
  }

  string(): string {
    const length = this.varint();
    const start = this.pos;
    this.pos += length;
    if (this.pos > this.end) throw new MvtError('string ran past the end');
    const buf = this.buf;
    // Tag keys and most tag values are ASCII, and building those directly
    // is several times quicker than a `TextDecoder` call whose fixed cost
    // dominates a nine-byte string. Anything with a high bit set — a place
    // name, which is most of them outside the anglosphere — goes the
    // correct way.
    let ascii = true;
    for (let i = start; i < this.pos; i++) {
      if (buf[i] >= 0x80) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      let out = '';
      for (let i = start; i < this.pos; i += 1024) {
        out += String.fromCharCode.apply(
          null,
          buf.subarray(i, Math.min(i + 1024, this.pos)) as unknown as number[],
        );
      }
      return out;
    }
    if (utf8 === undefined) utf8 = decoderOf();
    if (utf8) return utf8.decode(buf.subarray(start, this.pos));
    return decodeUtf8(buf, start, this.pos);
  }
}

/** The fallback for a runtime with no `TextDecoder`. Correct, not quick —
 *  and never reached on Node, Bun or a browser. */
function decodeUtf8(buf: Uint8Array, start: number, end: number): string {
  let out = '';
  let i = start;
  while (i < end) {
    const b0 = buf[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (buf[i++] & 0x3f));
    } else if (b0 < 0xf0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((buf[i++] & 0x3f) << 6) | (buf[i++] & 0x3f),
      );
    } else {
      const cp =
        ((b0 & 0x07) << 18) |
        ((buf[i++] & 0x3f) << 12) |
        ((buf[i++] & 0x3f) << 6) |
        (buf[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

// --- the schema ------------------------------------------------------------

/** A decoded tile: its layers, by name. Layers are ordered as the tile
 *  ordered them, which is the order a producer means them to be drawn in
 *  when a style says nothing. */
export interface VectorTile {
  layers: Map<string, VectorTileLayer>;
  /** Layer names in tile order. */
  order: string[];
}

/**
 * One layer of a tile.
 *
 * `keys` and `values` are decoded eagerly because MVT **deduplicates**
 * them — a tile with 12,000 features has perhaps 40 keys and 2,000 distinct
 * values, so decoding them once is cheaper than decoding a feature's tags
 * lazily would be. Features are the other way round: their byte ranges are
 * collected on construction and nothing inside one is touched until it is
 * asked for.
 */
export class VectorTileLayer {
  readonly name: string;
  readonly version: number;
  /** Tile-local coordinate units across the tile's square. 4096 unless the
   *  producer said otherwise. */
  readonly extent: number;
  readonly keys: string[];
  readonly values: FeatureValue[];
  /** How many features. */
  readonly length: number;

  private readonly _buf: Uint8Array;
  /** Byte offset of feature `i`, with a sentinel: `[starts[i], starts[i+1])`
   *  is not a valid span (features are not contiguous), so both ends are
   *  stored. */
  private readonly _at: Uint32Array;
  private readonly _to: Uint32Array;
  private _keyIndex: Map<string, number> | null = null;

  constructor(reader: Reader, end: number) {
    this._buf = reader.buf;
    let name = '';
    let version = 1;
    let extent = 4096;
    const keys: string[] = [];
    const values: FeatureValue[] = [];
    const at: number[] = [];
    const to: number[] = [];
    while (reader.pos < end) {
      const tag = reader.varint();
      const field = tag >> 3;
      const wire = tag & 0x7;
      if (field === 1 && wire === WIRE_BYTES) {
        name = reader.string();
      } else if (field === 15 && wire === WIRE_VARINT) {
        version = reader.varint();
      } else if (field === 5 && wire === WIRE_VARINT) {
        extent = reader.varint();
      } else if (field === 3 && wire === WIRE_BYTES) {
        keys.push(reader.string());
      } else if (field === 4 && wire === WIRE_BYTES) {
        const length = reader.varint();
        // `readValue` leaves `pos` at the value's end, so nothing here has
        // to move it.
        values.push(readValue(reader, reader.pos + length));
      } else if (field === 2 && wire === WIRE_BYTES) {
        const length = reader.varint();
        at.push(reader.pos);
        reader.pos += length;
        to.push(reader.pos);
      } else {
        reader.skip(wire);
      }
      if (reader.pos > end) throw new MvtError(`layer "${name}" overran`);
    }
    if (extent <= 0) throw new MvtError(`layer "${name}" has extent ${extent}`);
    this.name = name;
    this.version = version;
    this.extent = extent;
    this.keys = keys;
    this.values = values;
    this._at = new Uint32Array(at);
    this._to = new Uint32Array(to);
    this.length = at.length;
  }

  /** Which tag index a key name has, or -1. Built on first use, because a
   *  style usually reads two or three of a layer's forty keys. */
  keyIndex(key: string): number {
    if (!this._keyIndex) {
      this._keyIndex = new Map();
      for (let i = 0; i < this.keys.length; i++) {
        this._keyIndex.set(this.keys[i], i);
      }
    }
    return this._keyIndex.get(key) ?? -1;
  }

  /** Feature `i`, as a fresh cursor. */
  feature(i: number): FeatureCursor {
    const cursor = new FeatureCursor();
    this.seek(i, cursor);
    return cursor;
  }

  /**
   * Point an existing cursor at feature `i`.
   *
   * The whole reason the cursor is a separate object: a rasterizer walks
   * twelve thousand features and wants none of them to be an allocation.
   */
  seek(i: number, cursor: FeatureCursor): FeatureCursor {
    if (i < 0 || i >= this.length) {
      throw new MvtError(`feature ${i} of ${this.length}`);
    }
    cursor._bind(this, this._buf, this._at[i], this._to[i]);
    return cursor;
  }

  /** Every feature, as fresh cursors. Convenience — the allocation-free
   *  path is {@link seek}. */
  *features(): Generator<FeatureCursor> {
    const cursor = new FeatureCursor();
    for (let i = 0; i < this.length; i++) yield this.seek(i, cursor);
  }
}

function readValue(reader: Reader, end: number): FeatureValue {
  let out: FeatureValue = '';
  while (reader.pos < end) {
    const tag = reader.varint();
    const field = tag >> 3;
    const wire = tag & 0x7;
    if (field === 1 && wire === WIRE_BYTES) out = reader.string();
    else if (field === 2 && wire === WIRE_FIXED32) out = reader.float();
    else if (field === 3 && wire === WIRE_FIXED64) out = reader.double();
    else if (field === 4 && wire === WIRE_VARINT) out = reader.varint();
    else if (field === 5 && wire === WIRE_VARINT) out = reader.varint();
    else if (field === 6 && wire === WIRE_VARINT) out = reader.svarint();
    else if (field === 7 && wire === WIRE_VARINT) out = reader.varint() !== 0;
    else reader.skip(wire);
  }
  reader.pos = end;
  return out;
}

/** A position on a cursor's feature. */
export interface TilePoint {
  x: number;
  y: number;
}

/**
 * One feature, as a movable cursor over the tile's bytes.
 *
 * Nothing inside the feature is decoded until it is asked for, and a
 * cursor's own state is four numbers, so `layer.seek(i, cursor)` in a loop
 * allocates nothing.
 */
export class FeatureCursor {
  /** The feature's `id`, or undefined when it carries none. Ids above 2^53
   *  lose their low bits — see {@link Reader.varint}. */
  id: number | undefined = undefined;
  type: GeomType = GeomType.Unknown;
  layer: VectorTileLayer | null = null;

  private _buf: Uint8Array = EMPTY;
  private _tagAt = 0;
  private _tagTo = 0;
  private _geomAt = 0;
  private _geomTo = 0;

  /**
   * The feature's tags as key/value **indices**, decoded on the first
   * {@link get} and reused for every one after it.
   *
   * The reason this exists rather than a scan of the bytes per call: a
   * style asks the same feature about the same two or three keys once per
   * style layer over that source layer, and a road network is fourteen
   * such layers (seven classes, a casing pass and a fill pass). Re-decoding
   * a feature's varints fourteen times over is, on the corpus, most of the
   * cost of a zoom-12 tile. Decoded once, a lookup is a scan over a dozen
   * integers.
   */
  private _tagKeys = EMPTY_INTS;
  private _tagValues = EMPTY_INTS;
  private _tagCount = -1;

  /** @internal */
  _bind(layer: VectorTileLayer, buf: Uint8Array, at: number, to: number): void {
    this.layer = layer;
    this._buf = buf;
    this.id = undefined;
    this.type = GeomType.Unknown;
    this._tagAt = 0;
    this._tagTo = 0;
    this._geomAt = 0;
    this._geomTo = 0;
    this._tagCount = -1;
    const reader = new Reader(buf, at, to);
    while (reader.pos < to) {
      const tag = reader.varint();
      const field = tag >> 3;
      const wire = tag & 0x7;
      if (field === 1 && wire === WIRE_VARINT) {
        this.id = reader.varint();
      } else if (field === 3 && wire === WIRE_VARINT) {
        this.type = reader.varint() as GeomType;
      } else if (field === 2 && wire === WIRE_BYTES) {
        const length = reader.varint();
        this._tagAt = reader.pos;
        this._tagTo = reader.pos + length;
        reader.pos = this._tagTo;
      } else if (field === 4 && wire === WIRE_BYTES) {
        const length = reader.varint();
        this._geomAt = reader.pos;
        this._geomTo = reader.pos + length;
        reader.pos = this._geomTo;
      } else {
        reader.skip(wire);
      }
      if (reader.pos > to) throw new MvtError('feature overran');
    }
  }

  /** Tile-local units across this feature's tile. */
  get extent(): number {
    return this.layer?.extent ?? 4096;
  }

  /**
   * One tag, by key name.
   *
   * A linear scan of the tag pairs rather than a materialized object: a
   * feature has five to fifteen tags and a style filter reads one or two of
   * them, so the scan is quicker than the object it would have built and
   * costs nothing to throw away.
   */
  get(key: string): FeatureValue | undefined {
    const layer = this.layer;
    if (!layer || this._tagTo === this._tagAt) return undefined;
    const wanted = layer.keyIndex(key);
    if (wanted < 0) return undefined;
    if (this._tagCount < 0) this._loadTags();
    const keys = this._tagKeys;
    for (let i = 0; i < this._tagCount; i++) {
      if (keys[i] === wanted) return layer.values[this._tagValues[i]];
    }
    return undefined;
  }

  /** Decode the tag pairs into the cursor's own arrays. Grown, never
   *  shrunk, so a cursor walking a layer settles on one allocation. */
  private _loadTags(): void {
    const reader = new Reader(this._buf, this._tagAt, this._tagTo);
    let count = 0;
    let keys = this._tagKeys;
    let values = this._tagValues;
    while (reader.pos < this._tagTo) {
      const k = reader.varint();
      if (reader.pos >= this._tagTo) break; // a key with no value: malformed
      const v = reader.varint();
      if (count >= keys.length) {
        const size = Math.max(8, keys.length * 2);
        const nextKeys = new Int32Array(size);
        nextKeys.set(keys);
        keys = nextKeys;
        const nextValues = new Int32Array(size);
        nextValues.set(values);
        values = nextValues;
      }
      keys[count] = k;
      values[count] = v;
      count++;
    }
    this._tagKeys = keys;
    this._tagValues = values;
    this._tagCount = count;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Every tag, as an object. For a hover readout or a click payload — not
   *  for a filter, which should use {@link get}. */
  properties(): Record<string, FeatureValue> {
    const layer = this.layer;
    const out: Record<string, FeatureValue> = {};
    if (!layer || this._tagTo === this._tagAt) return out;
    if (this._tagCount < 0) this._loadTags();
    for (let i = 0; i < this._tagCount; i++) {
      const key = layer.keys[this._tagKeys[i]];
      const index = this._tagValues[i];
      if (key !== undefined && index < layer.values.length) {
        out[key] = layer.values[index];
      }
    }
    return out;
  }

  /**
   * Read this feature's geometry into `into`, in tile-local integers.
   *
   * The one hot loop in the decoder. Everything about its shape is about
   * not allocating: the cursor deltas accumulate in two locals, the
   * vertices go into a typed array the caller owns, and a polygon's ring
   * areas and the whole feature's bounding box are accumulated in the same
   * pass rather than in two more over the same points.
   */
  readGeometry(into: GeometryBuffer): GeometryData {
    into.reset();
    if (this._geomTo === this._geomAt) {
      into.starts[0] = 0;
      return into;
    }
    const reader = new Reader(this._buf, this._geomAt, this._geomTo);
    const end = this._geomTo;
    const isPolygon = this.type === GeomType.Polygon;
    const isPoint = this.type === GeomType.Point;
    let x = 0;
    let y = 0;
    let cmd = 0;
    let left = 0;
    let points = 0;
    let parts = 0;
    // The open part's first vertex and its running shoelace sum.
    let firstX = 0;
    let firstY = 0;
    let prevX = 0;
    let prevY = 0;
    let sum = 0;
    let open = false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    // The open part's own box, closed out into `partBounds` beside its
    // area. Tracked per part rather than per feature because the feature
    // box cannot cull a multipolygon — see `GeometryBuffer.partBounds`.
    let pMinX = Infinity;
    let pMinY = Infinity;
    let pMaxX = -Infinity;
    let pMaxY = -Infinity;

    const closePart = (): void => {
      if (!open) return;
      into.reserveParts(parts + 1);
      // A ring's last point is not repeated before `ClosePath`, so the
      // closing edge — last back to first — is added here and nowhere else.
      into.areas[parts] = isPolygon
        ? (sum + (prevX * firstY - firstX * prevY)) / 2
        : 0;
      const at = parts * 4;
      into.partBounds[at] = pMinX;
      into.partBounds[at + 1] = pMinY;
      into.partBounds[at + 2] = pMaxX;
      into.partBounds[at + 3] = pMaxY;
      if (pMinX < minX) minX = pMinX;
      if (pMinY < minY) minY = pMinY;
      if (pMaxX > maxX) maxX = pMaxX;
      if (pMaxY > maxY) maxY = pMaxY;
      pMinX = Infinity;
      pMinY = Infinity;
      pMaxX = -Infinity;
      pMaxY = -Infinity;
      parts++;
      into.starts[parts] = points;
      open = false;
    };

    while (reader.pos < end) {
      if (left <= 0) {
        const command = reader.varint();
        cmd = command & 0x7;
        left = command >> 3;
        if (left <= 0) continue; // a zero-count command: nothing to do
      }
      left--;
      if (cmd === 1) {
        // MoveTo. For a line or a polygon it begins a part; for a point
        // feature every step of one MoveTo is another point of the *same*
        // multipoint, and giving each its own part would make a 500-point
        // cluster 500 parts for no reader's benefit.
        if (!isPoint) closePart();
        x += reader.svarint();
        y += reader.svarint();
        if (!open) {
          firstX = x;
          firstY = y;
          sum = 0;
          open = true;
          into.starts[parts] = points;
        }
        into.reserveCoords(points + 1);
        into.coords[points * 2] = x;
        into.coords[points * 2 + 1] = y;
        points++;
        prevX = x;
        prevY = y;
      } else if (cmd === 2) {
        x += reader.svarint();
        y += reader.svarint();
        if (!open) {
          // A LineTo with no MoveTo before it. Malformed, and tolerated as
          // the start of a part rather than dropped: the vertex is real
          // data and the alternative is a road with a gap in it.
          firstX = x;
          firstY = y;
          sum = 0;
          open = true;
          into.starts[parts] = points;
        } else if (isPolygon) {
          sum += prevX * y - x * prevY;
        }
        into.reserveCoords(points + 1);
        into.coords[points * 2] = x;
        into.coords[points * 2 + 1] = y;
        points++;
        prevX = x;
        prevY = y;
      } else if (cmd === 7) {
        closePart();
      } else {
        throw new MvtError(`unknown geometry command ${cmd}`);
      }
      if (x < pMinX) pMinX = x;
      if (x > pMaxX) pMaxX = x;
      if (y < pMinY) pMinY = y;
      if (y > pMaxY) pMaxY = y;
    }
    closePart();
    into.points = points;
    into.parts = parts;
    into.minX = minX;
    into.minY = minY;
    into.maxX = maxX;
    into.maxY = maxY;
    return into;
  }

  /** Geometry as arrays of its own — the convenience form. */
  geometry(): GeometryData {
    const buffer = new GeometryBuffer(64, 4);
    this.readGeometry(buffer);
    // Trimmed, since this shape is the one that gets kept.
    return {
      coords: buffer.coords.slice(0, buffer.points * 2),
      starts: buffer.starts.slice(0, buffer.parts + 1),
      areas: buffer.areas.slice(0, buffer.parts),
      parts: buffer.parts,
      points: buffer.points,
    };
  }
}

const EMPTY = new Uint8Array(0);
const EMPTY_INTS = new Int32Array(0);

/**
 * Decode a tile.
 *
 * Cheap: it walks the tile's top-level fields and each layer's, which is
 * the layer names, their key and value tables, and one byte range per
 * feature. No geometry is touched, so a style that draws four of a tile's
 * fourteen layers pays for four.
 *
 * The bytes must be the raw protobuf. Tiles are almost always served
 * `Content-Encoding: gzip` and sometimes gzipped *inside* that, which is a
 * transport concern and deliberately not this function's — a source adapter
 * un-gzips (`src/maps/sources.ts` does).
 */
export function parseTile(bytes: Uint8Array): VectorTile {
  const layers = new Map<string, VectorTileLayer>();
  const order: string[] = [];
  const reader = new Reader(bytes);
  while (reader.pos < reader.end) {
    const tag = reader.varint();
    const field = tag >> 3;
    const wire = tag & 0x7;
    if (field === 3 && wire === WIRE_BYTES) {
      const length = reader.varint();
      const end = reader.pos + length;
      if (end > reader.end) throw new MvtError('layer ran past the end');
      const layer = new VectorTileLayer(reader, end);
      reader.pos = end;
      // A tile with two layers of one name is malformed; the first wins,
      // which is what every other decoder does.
      if (!layers.has(layer.name)) {
        layers.set(layer.name, layer);
        order.push(layer.name);
      }
    } else {
      reader.skip(wire);
    }
  }
  return { layers, order };
}
