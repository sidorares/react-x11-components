// `<Map>`, and the arithmetic under it.
//
// Most of this file needs no display, which is deliberate and is where the
// interesting assertions are: a map is a pile of coordinate conversions
// with a renderer attached, and the conversions are where a bug is silent.
// The projection is checked against an **independently written** form of
// the same formula (the OpenStreetMap wiki's `asinh` spelling against this
// package's `log(tan(...))` one), because a round-trip through one
// implementation of a projection proves only that it is self-consistent.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { cleanup, renderX11, userEvent, act, waitFor } from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import { drawnKinds, knownElements } from 'react-x11/host';
import { isStyleProp } from 'react-x11/style';
import type { DrawnNode } from 'react-x11';

import {
  DEFAULT_TILE_SIZE,
  GeometryBuffer,
  MAPVIEW_ELEMENT,
  Map as MapView,
  MvtError,
  cameraForBounds,
  compileFilter,
  dataTileFor,
  decodePolyline,
  distanceMetres,
  geoJsonOverlays,
  googleTileSource,
  latFromMercatorY,
  lonFromMercatorX,
  mercatorXFromLon,
  mercatorYFromLat,
  metresPerPixel,
  openMapTilesStyle,
  osmVectorSource,
  parseTile,
  parseVectorTile,
  rasterFor,
  resolveZoomed,
  shortbreadStyle,
  sourceZoomFor,
  subTileOf,
  tileBounds,
  tileCover,
  tileOf,
  tileTransform,
  transformFor,
  unprojectPoint,
  visibleBounds,
  wrapLon,
  wrapTileX,
} from '../src/maps/index.js';
import type {
  MapFrameStats,
  MapHandle,
  MapMarker,
  MapOverlay,
  MapSource,
  MapStyle,
  TileData,
} from '../src/maps/index.js';
import { GeomType } from '../src/maps/mvt.js';
import { drawOverlays } from '../src/maps/overlay.js';
import { prepareStyle } from '../src/maps/paint.js';
import { TileCache } from '../src/maps/tiles.js';

test.afterEach(async () => {
  await cleanup();
});

/** For everything that is arithmetic: no server, no pixels, fastest. */
const HEADLESS: RenderX11Options = { backend: 'mock', width: 640, height: 480 };
/** For anything that injects input. `fireEvent` goes through a real X
 *  server so that grabs, focus and crossing events happen for real, and the
 *  mock backend has no server to inject into. */
const DRIVEN: RenderX11Options = {
  backend: 'xserver',
  width: 640,
  height: 480,
};
const LONDON = { lon: -0.1281, lat: 51.508 };
const TOKYO = { lon: 139.7004, lat: 35.69 };

// --- the projection --------------------------------------------------------

/**
 * The OpenStreetMap wiki's slippy-map formula, written out here so the
 * assertions below compare two implementations rather than one against
 * itself. `asinh(tan(φ))` and `ln(tan(π/4 + φ/2))` are the same function
 * and are not the same code.
 */
function wikiTile(
  lon: number,
  lat: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n),
  };
}

test('the projection agrees with an independently written form of it', () => {
  for (const z of [0, 1, 5, 10, 14, 18]) {
    for (const place of [
      LONDON,
      TOKYO,
      { lon: -73.9855, lat: 40.758 },
      { lon: 0, lat: 0 },
    ]) {
      const mine = tileOf(place, z);
      const theirs = wikiTile(place.lon, place.lat, z);
      assert.equal(mine.x, theirs.x, `x at z${z} for ${JSON.stringify(place)}`);
      assert.equal(mine.y, theirs.y, `y at z${z} for ${JSON.stringify(place)}`);
    }
  }
});

test('projecting and unprojecting round-trips to a fraction of a metre', () => {
  for (const lat of [-85, -60, -23.5, 0, 23.5, 51.508, 60, 85]) {
    for (const lon of [-180, -73.98, -0.1281, 0, 139.7, 179.99]) {
      const x = mercatorXFromLon(lon);
      const y = mercatorYFromLat(lat);
      assert.ok(x >= 0 && x <= 1, `x in range for ${lon}`);
      assert.ok(y >= 0 && y <= 1, `y in range for ${lat}`);
      const back = { lon: lonFromMercatorX(x), lat: latFromMercatorY(y) };
      // A degree of latitude is ~111 km, so 1e-9 degrees is ~0.1 mm.
      assert.ok(Math.abs(back.lon - lon) < 1e-9, `lon ${lon} -> ${back.lon}`);
      assert.ok(Math.abs(back.lat - lat) < 1e-9, `lat ${lat} -> ${back.lat}`);
    }
  }
});

test('latitude is clamped to what Web Mercator can represent', () => {
  // Not a rounding of 85: past the limit `y` would leave the unit square
  // and address a tile row that does not exist.
  assert.equal(mercatorYFromLat(90), mercatorYFromLat(85.0511287798066));
  assert.ok(mercatorYFromLat(90) <= 1);
  assert.ok(mercatorYFromLat(-90) >= 0);
  assert.equal(tileOf({ lon: 0, lat: 90 }, 4).y, 0);
  assert.equal(tileOf({ lon: 0, lat: -90 }, 4).y, 15);
});

test('longitude wraps and latitude does not', () => {
  assert.equal(wrapLon(190), -170);
  assert.equal(wrapLon(-190), 170);
  assert.equal(wrapLon(180), -180);
  assert.equal(wrapTileX(-1, 4), 15);
  assert.equal(wrapTileX(16, 4), 0);
});

test('a tile’s bounds contain the position it was found for', () => {
  for (const z of [2, 8, 14]) {
    const tile = tileOf(LONDON, z);
    const bounds = tileBounds(tile);
    assert.ok(bounds.west <= LONDON.lon && LONDON.lon < bounds.east);
    assert.ok(bounds.south < LONDON.lat && LONDON.lat <= bounds.north);
  }
});

test('metres per pixel matches the known equator value', () => {
  // The number every slippy-map reference quotes: at zoom 0 with 256-pixel
  // tiles, one pixel is 156,543 m at the equator.
  assert.ok(Math.abs(metresPerPixel(0, 0, 256) - 156_543.03) < 0.05);
  // And it halves per zoom level.
  assert.ok(
    Math.abs(metresPerPixel(0, 5, 256) * 32 - metresPerPixel(0, 0, 256)) < 1e-6,
  );
  // Mercator stretches with latitude, so a pixel covers less ground.
  assert.ok(metresPerPixel(60, 10) < metresPerPixel(0, 10));
});

test('haversine distance matches a published pair', () => {
  // London to Paris, commonly quoted as ~343 km great-circle.
  const paris = { lon: 2.3522, lat: 48.8566 };
  const km = distanceMetres(LONDON, paris) / 1000;
  assert.ok(km > 340 && km < 346, `${km} km`);
  assert.equal(distanceMetres(LONDON, LONDON), 0);
});

// --- the tile cover --------------------------------------------------------

test('the cover fills the pane and no more', () => {
  const transform = transformFor(
    { center: LONDON, zoom: 12 },
    { width: 800, height: 600 },
  );
  const pyramid = { minZoom: 0, maxZoom: 14, tileSize: DEFAULT_TILE_SIZE };
  const cover = tileCover(transform, pyramid, 0);
  assert.ok(cover.length >= 4, `covered by ${cover.length} tiles`);
  for (const entry of cover) {
    assert.equal(entry.tile.z, 12);
    assert.ok(entry.x + entry.size > 0 && entry.x < 800, 'overlaps across');
    assert.ok(entry.y + entry.size > 0 && entry.y < 600, 'overlaps down');
  }
  // Centre-out, so the tile the user is looking at loads first.
  for (let i = 1; i < cover.length; i++) {
    assert.ok(cover[i].distance >= cover[i - 1].distance);
  }
  // Every pane pixel is inside some tile.
  for (const [px, py] of [
    [1, 1],
    [400, 300],
    [799, 599],
  ]) {
    const hit = cover.some(
      (e) => px >= e.x && px < e.x + e.size && py >= e.y && py < e.y + e.size,
    );
    assert.ok(hit, `(${px}, ${py}) is covered`);
  }
});

test('the cover overzooms rather than asking for a level the source lacks', () => {
  const transform = transformFor(
    { center: LONDON, zoom: 17 },
    { width: 512, height: 512 },
  );
  const pyramid = { minZoom: 0, maxZoom: 14, tileSize: DEFAULT_TILE_SIZE };
  assert.equal(sourceZoomFor(17, pyramid), 14);
  for (const entry of tileCover(transform, pyramid, 0)) {
    assert.equal(entry.tile.z, 14);
    // Drawn eight times its own size: 2^(17-14).
    assert.ok(Math.abs(entry.size - DEFAULT_TILE_SIZE * 8) < 1e-6);
  }
});

test('the cover wraps across the antimeridian', () => {
  const transform = transformFor(
    { center: { lon: 179.9, lat: 0 }, zoom: 3 },
    { width: 800, height: 400 },
  );
  const cover = tileCover(
    transform,
    { minZoom: 0, maxZoom: 14, tileSize: DEFAULT_TILE_SIZE },
    0,
  );
  const copies = new Set(cover.map((e) => e.worldCopy));
  assert.ok(copies.size > 1, 'the view spans two copies of the world');
  for (const entry of cover) {
    assert.ok(
      entry.tile.x >= 0 && entry.tile.x < 8,
      'x is wrapped for the cache',
    );
  }
});

test('a tile transform lands the tile exactly where the cover put it', () => {
  const transform = transformFor(
    { center: TOKYO, zoom: 11.4 },
    { width: 700, height: 500 },
  );
  const cover = tileCover(
    transform,
    { minZoom: 0, maxZoom: 14, tileSize: DEFAULT_TILE_SIZE },
    0,
  );
  const entry = cover[0];
  const t = tileTransform(entry, 4096);
  // Local 0 is the tile's top-left, local `extent` is its bottom-right.
  assert.ok(Math.abs(t.ox - entry.x) < 1e-9);
  assert.ok(Math.abs(t.ox + 4096 * t.k - (entry.x + entry.size)) < 1e-6);
});

test('the raster plan keeps the composite between 1x and 2x', () => {
  const pyramid = { minZoom: 0, maxZoom: 14, tileSize: 512 };
  for (const zoom of [10, 10.25, 10.5, 10.9]) {
    const z = sourceZoomFor(zoom, pyramid);
    const raster = rasterFor(zoom, z, pyramid, 2, 2048);
    const screen = 512 * 2 ** (zoom - z) * 2; // device pixels on screen
    const factor = screen / raster.size;
    assert.ok(factor >= 1 - 1e-9 && factor < 2, `factor ${factor} at ${zoom}`);
  }
});

test('the raster plan honours the memory cap', () => {
  const pyramid = { minZoom: 0, maxZoom: 14, tileSize: 512 };
  // Overzoomed by three levels at scale 2 would want 8192 pixels of edge,
  // which is 256 MB for one tile.
  const raster = rasterFor(17, 14, pyramid, 2, 2048);
  assert.ok(raster.size <= 2048);
});

test('past its own depth a source is sub-tiled, not stretched', () => {
  const pyramid = { minZoom: 0, maxZoom: 14, tileSize: DEFAULT_TILE_SIZE };
  // Without an overzoom allowance the cover stops at the source's depth,
  // which is what leaves one tile stretched sixty-four times at zoom 20.
  assert.equal(sourceZoomFor(20, pyramid), 14);
  // With one, the cover follows the camera and the data comes from the
  // ancestor: 4,096 renderings of one fetch, each at its own natural size.
  assert.equal(sourceZoomFor(20, pyramid, 6), 20);
  const tile = tileOf(LONDON, 20);
  const data = dataTileFor(tile, 14);
  assert.equal(data.z, 14);
  assert.deepEqual(data, tileOf(LONDON, 14));
  const sub = subTileOf(tile, 14);
  assert.equal(sub.span, 64, 'a zoom-20 tile is one cell of a 64×64 grid');
  assert.ok(sub.x >= 0 && sub.x < 64 && sub.y >= 0 && sub.y < 64);
  // The cell's own address round-trips: it is the cell of the data tile
  // that contains it.
  assert.equal((data.x << 6) + sub.x, tile.x);
  assert.equal((data.y << 6) + sub.y, tile.y);
  // A tile at or above the source's depth is its own data.
  assert.deepEqual(dataTileFor(tileOf(LONDON, 12), 14), tileOf(LONDON, 12));
  assert.equal(subTileOf(tileOf(LONDON, 12), 14).span, 1);
  // And each of those cells rasterizes at its natural size rather than a
  // fraction of a stretched one.
  const deep = { ...pyramid, maxZoom: pyramid.maxZoom + 6 };
  for (const zoom of [15, 18, 20]) {
    const z = sourceZoomFor(zoom, deep);
    const raster = rasterFor(zoom, z, deep, 2, 2048);
    const screen = DEFAULT_TILE_SIZE * 2 ** (zoom - z) * 2;
    assert.equal(raster.size, screen, `1:1 at zoom ${zoom}`);
  }
});

test('fitBounds frames a box, and a point does not become an infinite zoom', () => {
  const camera = cameraForBounds(
    { west: -0.5, south: 51.3, east: 0.3, north: 51.7 },
    { width: 800, height: 600 },
    { padding: 20, maxZoom: 20 },
  );
  const transform = transformFor(camera, { width: 800, height: 600 });
  const visible = visibleBounds(transform);
  assert.ok(visible.west <= -0.5 && visible.east >= 0.3, 'the box fits across');
  assert.ok(visible.south <= 51.3 && visible.north >= 51.7, 'and down');

  const point = cameraForBounds(
    { west: 0, south: 0, east: 0, north: 0 },
    { width: 400, height: 400 },
    { maxZoom: 16 },
  );
  assert.equal(point.zoom, 16);
});

// --- the vector tile decoder -----------------------------------------------
//
// Tiles are built byte by byte here rather than loaded from a fixture, so
// the assertions are about the *specification* rather than about whatever a
// particular producer happened to emit. (`scripts/bench/tiles.ts --stats`
// is the other half of this: it runs the decoder over half a million real
// features and reports anomalies.)

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function zigzag(value: number): number {
  return value < 0 ? -value * 2 - 1 : value * 2;
}

function field(number: number, wire: number): number[] {
  return varint((number << 3) | wire);
}

function bytes(number: number, payload: number[]): number[] {
  return [...field(number, 2), ...varint(payload.length), ...payload];
}

function stringField(number: number, text: string): number[] {
  const encoded = [...Buffer.from(text, 'utf8')];
  return bytes(number, encoded);
}

function command(id: number, count: number): number[] {
  return varint((id & 0x7) | (count << 3));
}

interface TestFeature {
  id?: number;
  type: GeomType;
  tags: number[];
  geometry: number[];
}

function feature(f: TestFeature): number[] {
  const out: number[] = [];
  if (f.id !== undefined) out.push(...field(1, 0), ...varint(f.id));
  if (f.tags.length > 0) {
    const packed = f.tags.flatMap(varint);
    out.push(...bytes(2, packed));
  }
  out.push(...field(3, 0), ...varint(f.type));
  out.push(
    ...bytes(
      4,
      f.geometry.flatMap((n) => varint(n)),
    ),
  );
  return bytes(2, out);
}

function layer(options: {
  name: string;
  extent?: number;
  keys: string[];
  values: (string | number | boolean)[];
  features: TestFeature[];
}): number[] {
  const out: number[] = [];
  out.push(...stringField(1, options.name));
  for (const f of options.features) out.push(...feature(f));
  for (const key of options.keys) out.push(...stringField(3, key));
  for (const value of options.values) {
    if (typeof value === 'string') out.push(...bytes(4, stringField(1, value)));
    else if (typeof value === 'boolean') {
      out.push(...bytes(4, [...field(7, 0), ...varint(value ? 1 : 0)]));
    } else out.push(...bytes(4, [...field(4, 0), ...varint(value)]));
  }
  if (options.extent !== undefined) {
    out.push(...field(5, 0), ...varint(options.extent));
  }
  out.push(...field(15, 0), ...varint(2));
  return bytes(3, out);
}

function tileBytes(layers: number[][]): Uint8Array {
  return new Uint8Array(layers.flat());
}

test('a point feature decodes to its position and its tags', () => {
  const bytesIn = tileBytes([
    layer({
      name: 'places',
      keys: ['name', 'rank'],
      values: ['Soho', 3],
      features: [
        {
          id: 7,
          type: GeomType.Point,
          tags: [0, 0, 1, 1],
          // MoveTo(1), then the zigzag deltas from the cursor at (0, 0).
          geometry: [...command(1, 1), zigzag(25), zigzag(17)],
        },
      ],
    }),
  ]);
  const tile = parseTile(bytesIn);
  const places = tile.layers.get('places');
  assert.ok(places);
  assert.equal(places.extent, 4096, 'the default extent when none is written');
  assert.equal(places.length, 1);
  const cursor = places.feature(0);
  assert.equal(cursor.id, 7);
  assert.equal(cursor.type, GeomType.Point);
  assert.equal(cursor.get('name'), 'Soho');
  assert.equal(cursor.get('rank'), 3);
  assert.equal(cursor.get('missing'), undefined);
  assert.deepEqual(cursor.properties(), { name: 'Soho', rank: 3 });
  const buffer = new GeometryBuffer();
  const geometry = cursor.readGeometry(buffer);
  assert.equal(geometry.points, 1);
  assert.equal(geometry.coords[0], 25);
  assert.equal(geometry.coords[1], 17);
});

test('geometry deltas accumulate across commands and across parts', () => {
  const bytesIn = tileBytes([
    layer({
      name: 'roads',
      keys: [],
      values: [],
      features: [
        {
          type: GeomType.LineString,
          tags: [],
          geometry: [
            ...command(1, 1),
            zigzag(2),
            zigzag(2),
            ...command(2, 2),
            zigzag(10),
            zigzag(0),
            zigzag(0),
            zigzag(10),
            // A second part: the cursor keeps its position across the
            // MoveTo, which is the rule a decoder gets wrong by resetting.
            ...command(1, 1),
            zigzag(-3),
            zigzag(-3),
            ...command(2, 1),
            zigzag(1),
            zigzag(1),
          ],
        },
      ],
    }),
  ]);
  const tile = parseTile(bytesIn);
  const buffer = new GeometryBuffer();
  const geometry = tile.layers.get('roads')!.feature(0).readGeometry(buffer);
  assert.equal(geometry.parts, 2);
  assert.deepEqual(
    Array.from(geometry.coords.slice(0, geometry.points * 2)),
    [2, 2, 12, 2, 12, 12, 9, 9, 10, 10],
  );
  assert.deepEqual(Array.from(geometry.starts.slice(0, 3)), [0, 3, 5]);
});

test('an exterior ring has positive area and an interior ring negative', () => {
  // A 10x10 square with a 4x4 hole, in tile coordinates (y down), wound as
  // the specification requires: exterior clockwise on screen.
  const bytesIn = tileBytes([
    layer({
      name: 'water',
      keys: [],
      values: [],
      features: [
        {
          type: GeomType.Polygon,
          tags: [],
          geometry: [
            ...command(1, 1),
            zigzag(0),
            zigzag(0),
            ...command(2, 3),
            zigzag(10),
            zigzag(0),
            zigzag(0),
            zigzag(10),
            zigzag(-10),
            zigzag(0),
            ...command(7, 0),
            // The hole, wound the other way. The cursor is back at (0, 0)
            // after ClosePath — which does *not* move it.
            ...command(1, 1),
            zigzag(3),
            zigzag(3),
            ...command(2, 3),
            zigzag(0),
            zigzag(4),
            zigzag(4),
            zigzag(0),
            zigzag(0),
            zigzag(-4),
            ...command(7, 0),
          ],
        },
      ],
    }),
  ]);
  const tile = parseTile(bytesIn);
  const buffer = new GeometryBuffer();
  const geometry = tile.layers.get('water')!.feature(0).readGeometry(buffer);
  assert.equal(geometry.parts, 2);
  assert.equal(geometry.areas[0], 100, 'the exterior ring is +area');
  assert.equal(geometry.areas[1], -16, 'and the hole is -area');
  // The closing edge is added by the decoder; the last point is not
  // repeated in the encoding.
  assert.equal(geometry.starts[1] - geometry.starts[0], 4);
});

test('extent is per layer, which real tiles use', () => {
  // OSM's Shortbread cuts `streets` at 2048 and its label layers at 4096; a
  // decoder that reads extent once per tile draws half of them at twice
  // their size.
  const bytesIn = tileBytes([
    layer({
      name: 'streets',
      extent: 2048,
      keys: [],
      values: [],
      features: [
        { type: GeomType.Point, tags: [], geometry: [...command(1, 1), 0, 0] },
      ],
    }),
    layer({
      name: 'street_labels',
      keys: [],
      values: [],
      features: [
        { type: GeomType.Point, tags: [], geometry: [...command(1, 1), 0, 0] },
      ],
    }),
  ]);
  const tile = parseTile(bytesIn);
  assert.equal(tile.layers.get('streets')!.extent, 2048);
  assert.equal(tile.layers.get('street_labels')!.extent, 4096);
  assert.deepEqual(tile.order, ['streets', 'street_labels']);
});

test('a truncated tile is an error rather than half a map', () => {
  const good = tileBytes([
    layer({
      name: 'x',
      keys: [],
      values: [],
      features: [
        { type: GeomType.Point, tags: [], geometry: [...command(1, 1), 4, 4] },
      ],
    }),
  ]);
  assert.throws(() => parseTile(good.slice(0, good.length - 3)), MvtError);
});

test('gzipped tile bytes are unwrapped before parsing', async () => {
  const { gzipSync } = await import('node:zlib');
  const raw = tileBytes([
    layer({
      name: 'x',
      keys: [],
      values: [],
      features: [
        { type: GeomType.Point, tags: [], geometry: [...command(1, 1), 4, 4] },
      ],
    }),
  ]);
  const tile = parseVectorTile(new Uint8Array(gzipSync(raw)));
  assert.equal(tile.layers.get('x')!.length, 1);
});

test('a cursor reused across a layer reads every feature', () => {
  const features: TestFeature[] = [];
  for (let i = 0; i < 50; i++) {
    features.push({
      id: i,
      type: GeomType.Point,
      tags: [0, i % 2],
      geometry: [...command(1, 1), zigzag(i), zigzag(i * 2)],
    });
  }
  const tile = parseTile(
    tileBytes([
      layer({ name: 'p', keys: ['kind'], values: ['a', 'b'], features }),
    ]),
  );
  const source = tile.layers.get('p')!;
  const cursor = source.feature(0);
  const buffer = new GeometryBuffer();
  let sum = 0;
  const kinds: string[] = [];
  for (let i = 0; i < source.length; i++) {
    source.seek(i, cursor);
    assert.equal(cursor.id, i);
    kinds.push(String(cursor.get('kind')));
    sum += cursor.readGeometry(buffer).coords[0];
  }
  assert.equal(sum, (49 * 50) / 2);
  assert.equal(kinds[0], 'a');
  assert.equal(kinds[1], 'b');
  // The tag cache is per seek: moving the cursor must not leave the
  // previous feature's tags behind it.
  source.seek(0, cursor);
  assert.equal(cursor.get('kind'), 'a');
});

// --- the style -------------------------------------------------------------

test('a zoom ramp interpolates numbers and steps everything else', () => {
  const width = { stops: [[10, 1] as const, [14, 5] as const] };
  assert.equal(resolveZoomed(width, 8), 1, 'below the first stop it holds');
  assert.equal(resolveZoomed(width, 10), 1);
  assert.equal(resolveZoomed(width, 12), 3);
  assert.equal(resolveZoomed(width, 14), 5);
  assert.equal(resolveZoomed(width, 20), 5, 'above the last stop it holds');
  const colour = { stops: [[0, '#aaa'] as const, [10, '#bbb'] as const] };
  assert.equal(resolveZoomed(colour, 5), '#aaa', 'a colour steps');
  assert.equal(resolveZoomed(7, 5), 7, 'a bare value is constant');
});

test('filters compile to the legacy semantics', () => {
  const tile = parseTile(
    tileBytes([
      layer({
        name: 'streets',
        keys: ['kind', 'rail', 'lanes'],
        values: ['motorway', 'path', true, 4],
        features: [
          {
            type: GeomType.LineString,
            tags: [0, 0, 1, 2, 2, 3],
            geometry: [...command(1, 1), 0, 0, ...command(2, 1), 4, 4],
          },
          {
            type: GeomType.Point,
            tags: [0, 1],
            geometry: [...command(1, 1), 2, 2],
          },
        ],
      }),
    ]),
  );
  const source = tile.layers.get('streets')!;
  const motorway = source.feature(0);
  const path = source.feature(1);

  assert.ok(compileFilter(['==', 'kind', 'motorway'])(motorway));
  assert.ok(!compileFilter(['==', 'kind', 'motorway'])(path));
  assert.ok(compileFilter(['!=', 'kind', 'motorway'])(path));
  assert.ok(compileFilter(['in', 'kind', 'motorway', 'trunk'])(motorway));
  assert.ok(compileFilter(['!in', 'kind', 'motorway'])(path));
  assert.ok(compileFilter(['has', 'rail'])(motorway));
  assert.ok(compileFilter(['!has', 'rail'])(path));
  assert.ok(compileFilter(['>', 'lanes', 2])(motorway));
  assert.ok(!compileFilter(['>', 'lanes', 8])(motorway));
  // A missing numeric tag compares false rather than as zero, which is what
  // stops `['>', 'lanes', 0]` selecting everything without lanes.
  assert.ok(!compileFilter(['>', 'lanes', 0])(path));
  assert.ok(compileFilter(['geometry', 'line'])(motorway));
  assert.ok(compileFilter(['geometry', 'point'])(path));
  assert.ok(
    compileFilter(['all', ['==', 'kind', 'motorway'], ['has', 'rail']])(
      motorway,
    ),
  );
  assert.ok(
    compileFilter(['any', ['==', 'kind', 'nothing'], ['has', 'rail']])(
      motorway,
    ),
  );
  assert.ok(compileFilter(['none', ['==', 'kind', 'motorway']])(path));
  assert.ok(compileFilter(undefined)(path), 'no filter selects everything');
  // An unknown operator draws nothing rather than everything: a typo that
  // quietly selected a whole layer would look like the style working.
  assert.throws(() => compileFilter(['~=' as unknown as '==', 'kind', 'x']));
});

test('the default style is written against the schema it names', () => {
  const style = shortbreadStyle();
  const ids = style.layers.map((l) => l.id);
  assert.ok(ids.includes('ocean'));
  assert.ok(ids.includes('buildings'));
  assert.ok(ids.includes('motorway'));
  assert.ok(ids.includes('motorway-casing'));
  // Casings before fills, all of them, which is what makes a junction look
  // like a junction rather than two roads crossing.
  assert.ok(
    ids.indexOf('motorway-casing') < ids.indexOf('motorway'),
    'every casing precedes its fill',
  );
  assert.ok(
    ids.indexOf('service-casing') < ids.indexOf('motorway'),
    'and all the casings precede all the fills',
  );
  // Every source layer named is one Shortbread actually has.
  const schema = new Set([
    'ocean',
    'land',
    'sites',
    'water_polygons',
    'water_lines',
    'dam_polygons',
    'pier_polygons',
    'buildings',
    'streets',
    'ferries',
    'boundaries',
    'place_labels',
    'water_polygons_labels',
    'street_labels',
    'public_transport',
  ]);
  for (const layer of style.layers) {
    assert.ok(
      schema.has(layer.sourceLayer),
      `unknown source layer ${layer.sourceLayer}`,
    );
  }
  assert.notEqual(shortbreadStyle({ dark: true }).background, style.background);
  assert.equal(
    shortbreadStyle({ buildings: false }).layers.some(
      (l) => l.id === 'buildings',
    ),
    false,
  );
  assert.equal(
    shortbreadStyle({ labels: false }).layers.some((l) => l.type === 'symbol'),
    false,
  );
});

test('the OpenMapTiles style names that schema, not Shortbread', () => {
  const style = openMapTilesStyle();
  const ids = style.layers.map((l) => l.id);
  // Same cartography, same layer ids where they mean the same thing, so
  // switching a source between the two schemas changes which style is
  // passed and nothing else about how the map looks.
  for (const id of ['ocean', 'buildings', 'motorway', 'motorway-casing']) {
    assert.ok(ids.includes(id), `${id} is in both styles`);
  }
  assert.ok(
    ids.indexOf('motorway-casing') < ids.indexOf('motorway'),
    'casings still precede fills',
  );
  // …but every source layer is OpenMapTiles', and none of them is one
  // Shortbread has. Pointing the wrong style at a source is the one failure
  // to expect, and it draws an empty map rather than erroring.
  const openMapTiles = new Set([
    'water',
    'waterway',
    'landcover',
    'landuse',
    'park',
    'building',
    'transportation',
    'transportation_name',
    'place',
    'water_name',
    'boundary',
  ]);
  const shortbread = new Set(
    shortbreadStyle().layers.map((l) => l.sourceLayer),
  );
  for (const layer of style.layers) {
    assert.ok(
      openMapTiles.has(layer.sourceLayer),
      `unknown OpenMapTiles layer ${layer.sourceLayer}`,
    );
    assert.ok(
      !shortbread.has(layer.sourceLayer),
      `${layer.sourceLayer} is in both schemas — check the filters too`,
    );
  }
  assert.notEqual(
    openMapTilesStyle({ dark: true }).background,
    style.background,
  );
  assert.equal(
    openMapTilesStyle({ buildings: false }).layers.some(
      (l) => l.id === 'buildings',
    ),
    false,
  );
});

test('the style compiles into runs of one source layer', () => {
  const prepared = prepareStyle(shortbreadStyle());
  assert.equal(prepared.layers.length, shortbreadStyle().layers.length);
  // A run covers a contiguous stretch, and the runs cover everything once.
  let at = 0;
  for (const run of prepared.runs) {
    assert.equal(run.from, at);
    assert.ok(run.to > run.from);
    for (let i = run.from; i < run.to; i++) {
      assert.equal(prepared.layers[i].layer.sourceLayer, run.sourceLayer);
    }
    at = run.to;
  }
  assert.equal(at, prepared.layers.length);
  // The road network is one run, which is the whole reason runs exist: a
  // zoom-12 tile is one pass over its streets rather than fourteen.
  const streets = prepared.runs.find((r) => r.sourceLayer === 'streets');
  assert.ok(
    streets && streets.to - streets.from > 10,
    'the streets run is one',
  );
});

// --- overlays --------------------------------------------------------------

test('encoded polylines decode at both precisions', () => {
  // The example from Google's own specification.
  const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(points.length, 3);
  assert.ok(Math.abs(points[0].lat - 38.5) < 1e-6);
  assert.ok(Math.abs(points[0].lon - -120.2) < 1e-6);
  assert.ok(Math.abs(points[2].lat - 43.252) < 1e-6);
  assert.ok(Math.abs(points[2].lon - -126.453) < 1e-6);
  // Precision 6 is what Valhalla and OSRM's polyline6 answer with; reading
  // it as 5 puts the route ten degrees away, which is how everyone finds
  // out about this parameter.
  const six = decodePolyline('_p~iF~ps|U', 6);
  assert.ok(Math.abs(six[0].lat - 3.85) < 1e-6);
});

test('GeoJSON becomes markers and overlays', () => {
  const { markers, overlays } = geoJsonOverlays({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'stop-1',
        properties: { name: 'Bond Street' },
        geometry: { type: 'Point', coordinates: [-0.1489, 51.5142] },
      },
      {
        type: 'Feature',
        id: 'route-1',
        properties: { colour: '#d00' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [-0.15, 51.51],
            [-0.14, 51.52],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'zone-1',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-0.16, 51.5],
              [-0.13, 51.5],
              [-0.13, 51.53],
              [-0.16, 51.53],
            ],
          ],
        },
      },
    ],
  });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].id, 'stop-1');
  // GeoJSON is [lon, lat], which is the opposite of how everyone says it.
  assert.ok(Math.abs(markers[0].position.lat - 51.5142) < 1e-9);
  assert.equal(overlays.length, 2);
  assert.equal(overlays[0].kind, 'line');
  assert.equal(overlays[1].kind, 'polygon');
});

test('a GeoJSON style callback colours by property', () => {
  const { overlays } = geoJsonOverlays(
    {
      type: 'Feature',
      id: 'a',
      properties: { congestion: 'heavy' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    },
    (feature) => ({
      color: feature.properties?.congestion === 'heavy' ? '#d00' : '#0a0',
      width: 5,
    }),
  );
  assert.equal(overlays.length, 1);
  assert.equal((overlays[0] as { color?: string }).color, '#d00');
});

// --- clipping --------------------------------------------------------------
//
// An overlay is geography, so its far end stays where it is when the camera
// zooms in on one corner of it — and world pixels are `512 · 2^zoom`, which
// at zoom 20 is 134 million. ntk hands a stroke's geometry to XRender as
// 16.16 fixed point, which overflows a signed 32-bit word at 32,768, so an
// unclipped overlay is a `RangeError` from inside `paint` a few zoom steps
// in. These are the tests for not doing that.

/** A canvas that records every coordinate it is asked to draw at. */
function recordingCanvas(): {
  ctx: Record<string, unknown>;
  xs: number[];
  ys: number[];
  strokes: number;
  fills: number;
} {
  const xs: number[] = [];
  const ys: number[] = [];
  const state = { strokes: 0, fills: 0 };
  const at = (x: number, y: number): void => {
    xs.push(x);
    ys.push(y);
  };
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: at,
    lineTo: at,
    rect: (x: number, y: number, w: number, h: number) => {
      at(x, y);
      at(x + w, y + h);
    },
    arc: (x: number, y: number, r: number) => {
      at(x - r, y - r);
      at(x + r, y + r);
    },
    fill: () => {
      state.fills++;
    },
    stroke: () => {
      state.strokes++;
    },
    clip: () => undefined,
    fillRect: () => undefined,
    setLineDash: () => undefined,
  };
  return {
    ctx: ctx as unknown as Record<string, unknown>,
    xs,
    ys,
    get strokes() {
      return state.strokes;
    },
    get fills() {
      return state.fills;
    },
  };
}

/** What XRender's 16.16 fixed point can hold. */
const FIXED_LIMIT = 32_768;

test('an overlay far outside the view is clipped, not handed to the renderer', () => {
  const pane = { x: 0, y: 0, width: 800, height: 600 };
  // Zoom 20 over London, with a route running to Tokyo and a zone and a
  // geofence around the planet: every one of these is millions of pixels
  // across at this zoom.
  const transform = transformFor({ center: LONDON, zoom: 20 }, pane);
  const overlays: MapOverlay[] = [
    {
      kind: 'line',
      id: 'route',
      path: [LONDON, TOKYO, { lon: -73.98, lat: 40.75 }],
    },
    {
      kind: 'polygon',
      id: 'zone',
      rings: [
        [
          { lon: -170, lat: -80 },
          { lon: 170, lat: -80 },
          { lon: 170, lat: 80 },
          { lon: -170, lat: 80 },
        ],
      ],
      outline: '#000',
    },
    {
      kind: 'circle',
      id: 'fence',
      center: LONDON,
      radiusMetres: 500_000,
      outline: '#000',
    },
  ];
  const recorder = recordingCanvas();
  drawOverlays(recorder.ctx as never, overlays, transform, pane, 2, {
    accent: '#00f',
    background: '#fff',
    text: '#000',
  });
  assert.ok(recorder.xs.length > 0, 'something was drawn');
  for (let i = 0; i < recorder.xs.length; i++) {
    assert.ok(
      Math.abs(recorder.xs[i]) < FIXED_LIMIT &&
        Math.abs(recorder.ys[i]) < FIXED_LIMIT,
      `(${recorder.xs[i]}, ${recorder.ys[i]}) would overflow 16.16 fixed point`,
    );
  }
});

test('clipping keeps the part of an overlay that is visible', () => {
  const pane = { x: 0, y: 0, width: 400, height: 300 };
  const transform = transformFor({ center: LONDON, zoom: 14 }, pane);
  const east = unprojectPoint(transform, 5_000, 150);
  const west = unprojectPoint(transform, -5_000, 150);
  const recorder = recordingCanvas();
  drawOverlays(
    recorder.ctx as never,
    // A line straight across the pane whose ends are far outside it.
    [{ kind: 'line', id: 'across', path: [west, east] }],
    transform,
    pane,
    1,
    { accent: '#00f', background: '#fff', text: '#000' },
  );
  assert.equal(recorder.strokes, 1, 'the visible part was stroked');
  // It really does cross the pane rather than being culled with its ends.
  assert.ok(Math.min(...recorder.xs) < 0, 'it starts left of the pane');
  assert.ok(Math.max(...recorder.xs) > 400, 'and ends right of it');
  for (const x of recorder.xs) assert.ok(Math.abs(x) < FIXED_LIMIT);
});

test('an overlay entirely off screen draws nothing at all', () => {
  const pane = { x: 0, y: 0, width: 400, height: 300 };
  const transform = transformFor({ center: LONDON, zoom: 14 }, pane);
  const recorder = recordingCanvas();
  drawOverlays(
    recorder.ctx as never,
    [
      { kind: 'line', id: 'far', path: [TOKYO, { lon: 139.8, lat: 35.7 }] },
      { kind: 'circle', id: 'far-fence', center: TOKYO, radiusMetres: 100 },
    ],
    transform,
    pane,
    1,
    { accent: '#00f', background: '#fff', text: '#000' },
  );
  assert.equal(recorder.strokes, 0);
  assert.equal(recorder.fills, 0);
});

/** A tile with data in three source layers, so a style with three runs
 *  takes three passes to draw. */
function threeLayerTile(): Uint8Array {
  const square = [
    ...command(1, 1),
    zigzag(0),
    zigzag(0),
    ...command(2, 3),
    zigzag(4096),
    zigzag(0),
    zigzag(0),
    zigzag(4096),
    zigzag(-4096),
    zigzag(0),
    ...command(7, 0),
  ];
  return tileBytes(
    ['ocean', 'land', 'buildings'].map((name) =>
      layer({
        name,
        keys: [],
        values: [],
        features: [{ type: GeomType.Polygon, tags: [], geometry: square }],
      }),
    ),
  );
}

const THREE_RUN_STYLE: MapStyle = {
  background: '#eee',
  layers: [
    { id: 'ocean', type: 'fill', sourceLayer: 'ocean', color: '#aad' },
    { id: 'land', type: 'fill', sourceLayer: 'land', color: '#cec' },
    { id: 'buildings', type: 'fill', sourceLayer: 'buildings', color: '#ddd' },
  ],
};

/** The middle of tile `3/4/4`, so a small pane sees that tile and no
 *  other. */
const ONE_TILE_CENTRE = { lon: 22.5, lat: latFromMercatorY(0.5625) };

/** The middle of tile `14/8192/8192`. The one above is a tile *corner* at
 *  zoom 14 — 0.5625 · 2^14 is a whole number — so a pane centred there sees
 *  four tiles, not one, which is exactly the sort of thing that makes a
 *  test about counting frames say something it did not mean. */
const ONE_TILE_CENTRE_14 = {
  lon: lonFromMercatorX(8192.5 / 16384),
  lat: latFromMercatorY(8192.5 / 16384),
};

/** Frames from a map whose budget is small enough that only the
 *  forward-progress guarantee gets any work done, so a tile takes a frame
 *  of its own. */
async function slowTileFrames(
  progressive: boolean,
  rasterBudgetMs = 0.0001,
): Promise<MapFrameStats[]> {
  const frames: MapFrameStats[] = [];
  const source: MapSource = {
    id: 'slow',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    load: () => ({ kind: 'vector', data: threeLayerTile() }),
  };
  await renderX11(
    React.createElement(MapView, {
      sources: [source],
      mapStyle: THREE_RUN_STYLE,
      // Deliberately a viewport that sees **one** tile: at zoom 3 a tile is
      // 512 logical pixels on screen, so a 200-pixel pane centred in one
      // covers nothing else, and `pending` and `ready` are then facts about
      // that tile rather than sums over four of them. (Off-screen tiles the
      // cover keeps warm are loaded but never rasterized, so they do not
      // reach the counters either.)
      defaultCamera: { center: ONE_TILE_CENTRE, zoom: 3 },
      progressive,
      rasterBudgetMs,
      onFrame: (stats) => frames.push({ ...stats }),
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 200, height: 200 },
  );
  for (let i = 0; i < 30; i++) await act(async () => {});
  return frames;
}

test('a budget too small for one tile still finishes the map', async () => {
  // A budget smaller than one unit of work is not "do less", it is "do
  // nothing" — and a frame with tiles still pending asks for another one,
  // so the map would spin at the refresh rate forever. The first tile of a
  // frame ignores the deadline for exactly this reason.
  const frames = await slowTileFrames(false, 0.0001);
  assert.ok(
    frames.some((f) => f.pending === 0 && f.ready > 0),
    'the map finished despite a budget of a ten-thousandth of a millisecond',
  );
});

test('a tile is not shown until it is finished', async () => {
  const frames = await slowTileFrames(false);
  const building = frames.filter((f) => f.pending > 0);
  assert.ok(building.length > 1, `the tile took ${building.length} frames`);
  // One tile in view, so `pending > 0` means *this* tile is unfinished —
  // and nothing of it is composited while that is true. There is no
  // ancestor on a cold map either, so the map shows its background rather
  // than a half-drawn tile.
  for (const frame of building) {
    assert.equal(
      frame.ready,
      0,
      `a half-drawn tile was composited: ${JSON.stringify(frame)}`,
    );
  }
  assert.ok(
    frames.some((f) => f.pending === 0 && f.ready > 0),
    'and it is composited once it is done',
  );
});

test('a tile being redrawn keeps showing the old picture', async () => {
  // The flash this pins. A tile is re-rasterized whenever its style zoom
  // moves, and above a source's `maxZoom` that is *every* integer zoom —
  // the same z14 tile serves 15, 16, 17 and on. Redrawn in place it goes
  // blank for the several frames a redraw takes; with two renderings the
  // old one stays composited until the new one is finished.
  const source: MapSource = {
    id: 'over',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    load: () => ({ kind: 'vector', data: threeLayerTile() }),
  };
  const ref = React.createRef<MapHandle>();
  let frames: MapFrameStats[] = [];
  await renderX11(
    React.createElement(MapView, {
      ref,
      sources: [source],
      mapStyle: THREE_RUN_STYLE,
      defaultCamera: { center: ONE_TILE_CENTRE, zoom: 14 },
      rasterBudgetMs: 0.0001,
      onFrame: (stats) => frames.push({ ...stats }),
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 200, height: 200 },
  );
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await act(async () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await settle();
  assert.ok(
    frames.some((f) => f.ready > 0),
    'the tile was drawn at all',
  );
  // Now the levels past the source's own depth. Each is a fresh set of
  // synthesized tiles rather than a redraw of one — that is what makes an
  // overzoomed map sharp — so what has to hold across them is that
  // *something* is always on screen: a tile's own finished rendering, or
  // the ancestor covering it while the finer ones draw.
  for (const zoom of [15, 16, 17]) {
    frames = [];
    (ref.current as MapHandle).zoomTo(zoom);
    await settle();
    const working = frames.filter((f) => f.pending > 0);
    assert.ok(working.length > 0, `zoom ${zoom} drew something new`);
    for (const frame of working) {
      assert.ok(
        frame.ready + frame.fromAncestor + frame.fromDescendant > 0,
        `the map went blank at zoom ${zoom}: ${JSON.stringify(frame)}`,
      );
    }
  }
});

test('zooming out covers the gap with the tiles already in hand', async () => {
  // The mirror of the ancestor fallback, and the half that was missing.
  // Zooming *in*, the tile in hand is the target's ancestor — one
  // composite, scaled up. Zooming *out*, the tiles in hand are its
  // descendants, and walking up the pyramid finds nothing: the map showed
  // its background, with the labels and markers still drawn over it, until
  // the coarser tile had been fetched, rasterized and composited.
  const source: MapSource = {
    id: 'every',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    // Slow, as a network is — which is what makes the gap last long enough
    // to matter.
    load: () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ kind: 'vector', data: threeLayerTile() }),
          60,
        ),
      ),
  };
  const ref = React.createRef<MapHandle>();
  let frames: MapFrameStats[] = [];
  await renderX11(
    React.createElement(MapView, {
      ref,
      sources: [source],
      mapStyle: THREE_RUN_STYLE,
      defaultCamera: { center: ONE_TILE_CENTRE_14, zoom: 14 },
      onFrame: (stats) => frames.push({ ...stats }),
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 200, height: 200 },
  );
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 24; i++) {
      await act(async () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await settle();
  assert.ok(
    frames.some((f) => f.ready > 0),
    'the zoom-14 tile was drawn',
  );

  frames = [];
  (ref.current as MapHandle).zoomTo(13);
  await settle();
  assert.ok(
    frames.some((f) => f.fromDescendant > 0),
    'the finer tiles covered the coarser one while it loaded',
  );
  // And every frame that actually repainted showed something: no frame
  // draws the background where a picture was available.
  for (const frame of frames) {
    const repainted =
      frame.damage === null || frame.damage.width * frame.damage.height > 4096;
    if (!repainted || frame.tiles === 0) continue;
    assert.ok(
      frame.ready + frame.fromAncestor + frame.fromDescendant > 0,
      `a repaint showed nothing: ${JSON.stringify(frame)}`,
    );
  }
});

test('a frame that only continues a redraw claims a pixel, not the pane', async () => {
  // What a burst of flashes at the end of a zoom actually was. A tile being
  // redrawn is a second surface nobody is looking at, so nothing on screen
  // changes until it lands — but every one of those frames used to claim
  // the whole pane, so the renderer repainted the whole map at the refresh
  // rate for the several frames a redraw takes. Invisible on X11, a visible
  // burst on the Cocoa backend, which paints many more frames a second.
  const source: MapSource = {
    id: 'wake',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    load: () => ({ kind: 'vector', data: threeLayerTile() }),
  };
  const ref = React.createRef<MapHandle>();
  let frames: MapFrameStats[] = [];
  await renderX11(
    React.createElement(MapView, {
      ref,
      sources: [source],
      mapStyle: THREE_RUN_STYLE,
      defaultCamera: { center: ONE_TILE_CENTRE_14, zoom: 14 },
      rasterBudgetMs: 0.0001,
      onFrame: (stats) => frames.push({ ...stats }),
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 200, height: 200 },
  );
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await act(async () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await settle();
  assert.equal(frames[frames.length - 1].tiles, 1, 'one tile in view');

  frames = [];
  (ref.current as MapHandle).zoomTo(15);
  await settle();
  const redrawing = frames.filter((f) => f.pending > 0);
  assert.ok(
    redrawing.length >= 3,
    `the redraw took ${redrawing.length} frames`,
  );
  // Only two kinds of frame repaint anything: the zoom's own, because the
  // view really did change, and one per tile as it lands. Everything
  // between them is a wake-up that draws nothing. Zoom 15 against a
  // zoom-14 source is four synthesized tiles, so the bound is theirs.
  const tiles = Math.max(...frames.map((f) => f.tiles));
  const large = frames.filter(
    (f) => f.damage === null || f.damage.width * f.damage.height > 4096,
  );
  assert.ok(
    large.length <= 1 + tiles,
    `${large.length} frames repainted, for ${tiles} tiles: ` +
      frames
        .map((f) =>
          f.damage ? `${f.damage.width}x${f.damage.height}` : 'FULL',
        )
        .join(' '),
  );
  assert.ok(
    frames.length - large.length >= 3,
    'and most frames drew nothing at all',
  );
});

test('progressive shows a tile as it is drawn', async () => {
  const frames = await slowTileFrames(true);
  assert.ok(
    frames.some((f) => f.pending > 0 && f.ready > 0),
    'the opt-in composites a tile that is still being drawn',
  );
});

test('tiles composite without overflowing at extreme overzoom', async () => {
  // The second overflow, and a different limit from the overlay one:
  // XRender takes *composite* coordinates as int16, and an overzoomed tile
  // dwarfs the pane — at zoom 22 against a pyramid that stops at 14 a tile
  // is 512·2^8 = 131,072 logical pixels across, so a tile that overlaps the
  // pane can start 73,000 pixels outside it. Real pixels, because the
  // check that matters lives in the X client's request encoder.
  const source: MapSource = {
    id: 'deep',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    load: () => ({
      kind: 'vector',
      data: tileBytes([
        layer({
          name: 'ocean',
          keys: [],
          values: [],
          features: [
            {
              type: GeomType.Polygon,
              tags: [],
              geometry: [
                ...command(1, 1),
                zigzag(0),
                zigzag(0),
                ...command(2, 3),
                zigzag(4096),
                zigzag(0),
                zigzag(0),
                zigzag(4096),
                zigzag(-4096),
                zigzag(0),
                ...command(7, 0),
              ],
            },
          ],
        }),
      ]),
    }),
  };
  const ref = React.createRef<MapHandle>();
  await renderX11(
    React.createElement(MapView, {
      ref,
      sources: [source],
      defaultCamera: { center: LONDON, zoom: 14 },
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 500, height: 380 },
  );
  const handle = ref.current as MapHandle;
  for (let step = 0; step < 10; step++) {
    handle.zoomIn(1);
    for (let i = 0; i < 6; i++) await act(async () => {});
  }
  assert.ok(
    handle.getCamera().zoom >= 22,
    `reached ${handle.getCamera().zoom}`,
  );
  // Past the settle window: a camera move suspends rasterization for 140 ms
  // so that a gesture is composites only, and the whole zoom loop above runs
  // well inside one. Without this wait the map is still mid-gesture and has
  // deliberately drawn nothing yet.
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (let i = 0; i < 12; i++) await act(async () => {});
  const stats = handle.stats();
  assert.ok(
    stats && stats.ready + stats.fromAncestor > 0,
    `nothing composited at zoom 22: ${JSON.stringify(stats)}`,
  );
});

test('a map paints without throwing at the zoom where coordinates overflow', async () => {
  // The integration form of the above, and the one that reproduces the
  // original report: a few zoom steps in, `paint` threw a `RangeError` out
  // of x11's render extension and there was no way for an application to
  // catch it.
  const ref = React.createRef<MapHandle>();
  await renderX11(
    React.createElement(MapView, {
      ref,
      defaultCamera: { center: LONDON, zoom: 14 },
      markers: [{ id: 'a', position: LONDON }],
      overlays: [
        { kind: 'line', id: 'route', path: [LONDON, TOKYO], casing: '#fff' },
        {
          kind: 'polygon',
          id: 'zone',
          rings: [
            [
              { lon: -1, lat: 51 },
              { lon: 1, lat: 51 },
              { lon: 1, lat: 52 },
              { lon: -1, lat: 52 },
            ],
          ],
        },
        {
          kind: 'circle',
          id: 'fence',
          center: LONDON,
          radiusMetres: 2_000_000,
        },
      ],
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 500, height: 380 },
  );
  const handle = ref.current as MapHandle;
  for (let step = 0; step < 8; step++) {
    handle.zoomIn(1);
    await act(async () => {});
  }
  assert.ok(
    handle.getCamera().zoom >= 20,
    `reached ${handle.getCamera().zoom}`,
  );
});

// --- the tile cache --------------------------------------------------------

function fakeSource(
  answer: (z: number, x: number, y: number) => TileData,
): MapSource {
  return {
    id: 'fake',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    load: (request) => answer(request.z, request.x, request.y),
  };
}

test('the cache loads once, remembers, and treats no data as an answer', async () => {
  let asked = 0;
  const source = fakeSource((z) => {
    asked++;
    return z === 3 ? null : { kind: 'vector', data: tileBytes([]) };
  });
  const cache = new TileCache();
  cache.beginFrame();
  const first = cache.want(source, 'fake', { z: 2, x: 1, y: 1 });
  await Promise.resolve();
  assert.equal(first.status, 'ready');
  cache.want(source, 'fake', { z: 2, x: 1, y: 1 });
  assert.equal(asked, 1, 'a tile is asked for once');

  const missing = cache.want(source, 'fake', { z: 3, x: 1, y: 1 });
  await Promise.resolve();
  assert.equal(missing.status, 'empty', 'no data is not an error');
  cache.destroy();
});

test('the signal a source is handed is a real AbortSignal', async () => {
  // The bug this pins, and it broke every documented use of the component:
  // `fetch` checks `instanceof AbortSignal` and throws `TypeError` on
  // anything else, so handing a source a look-alike with an `aborted`
  // getter made every `fetch(url, { signal })` fail before it left the
  // process — which looks exactly like a map that is still loading.
  let seen: unknown;
  const source: MapSource = {
    id: 's',
    // Never settles, so the load is still in flight when the cache is
    // destroyed below.
    load: (request) => {
      seen = request.signal;
      return new Promise<TileData>(() => {});
    },
  };
  const cache = new TileCache();
  cache.beginFrame();
  cache.want(source, 's', { z: 1, x: 0, y: 0 });
  assert.ok(seen instanceof AbortSignal, `signal was ${typeof seen}`);
  assert.equal((seen as AbortSignal).aborted, false);
  cache.destroy();
  assert.equal(
    (seen as AbortSignal).aborted,
    true,
    'dropping a tile aborts the request it has in flight',
  );
});

test('a failed load is reported, and retried on a backoff rather than per frame', async () => {
  let attempts = 0;
  const source: MapSource = {
    id: 'down',
    load: () => {
      attempts++;
      throw new Error('502');
    },
  };
  const failures: string[] = [];
  const cache = new TileCache({
    onError: (entry) => failures.push(String(entry.error)),
  });
  for (let frame = 0; frame < 20; frame++) {
    cache.beginFrame();
    cache.want(source, 'down', { z: 1, x: 0, y: 0 });
  }
  // Twenty frames, one attempt: without the backoff a source that is down
  // is asked for every visible tile sixty times a second, which is a retry
  // storm pointed at somebody else's servers.
  assert.equal(attempts, 1, `asked ${attempts} times in 20 frames`);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /502/);
  const entry = cache.peek('down', { z: 1, x: 0, y: 0 });
  assert.equal(entry?.status, 'error');
  assert.ok((entry?.data.retryAt ?? 0) > Date.now(), 'a retry is scheduled');
  cache.destroy();
});

test('a load that succeeds after failing clears the backoff', async () => {
  let attempts = 0;
  const source: MapSource = {
    id: 'flappy',
    load: () => {
      attempts++;
      if (attempts === 1) throw new Error('nope');
      return { kind: 'vector', data: tileBytes([]) };
    },
  };
  const cache = new TileCache();
  cache.beginFrame();
  const entry = cache.want(source, 'flappy', { z: 1, x: 0, y: 0 });
  assert.equal(entry.data.attempts, 1);
  // Past the backoff.
  entry.data.retryAt = 0;
  cache.beginFrame();
  cache.want(source, 'flappy', { z: 1, x: 0, y: 0 });
  await Promise.resolve();
  assert.equal(entry.status, 'ready');
  assert.equal(
    entry.data.attempts,
    0,
    'the counter resets so the next blip is quick',
  );
  cache.destroy();
});

test('a tile that fails reaches onTileError and the frame stats', async () => {
  const seen: string[] = [];
  const source: MapSource = {
    id: 'bad',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    load: () => {
      throw new Error('unauthorized');
    },
  };
  const ref = React.createRef<MapHandle>();
  await renderX11(
    React.createElement(MapView, {
      ref,
      sources: [source],
      defaultCamera: { center: LONDON, zoom: 4 },
      onTileError: (error, tile) =>
        seen.push(
          `${tile.sourceId} ${tile.z}/${tile.x}/${tile.y} ${String(error)}`,
        ),
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 400, height: 300 },
  );
  await act(async () => {});
  assert.ok(seen.length > 0, 'the failure was reported');
  assert.match(seen[0], /bad 4\/\d+\/\d+ Error: unauthorized/);
  const stats = (ref.current as MapHandle).stats();
  assert.ok(stats && stats.errors > 0, 'and counted in the frame stats');
});

test('an ancestor with a surface is what covers a hole', () => {
  const cache = new TileCache();
  cache.beginFrame();
  const source = fakeSource(() => ({ kind: 'vector', data: tileBytes([]) }));
  const parent = cache.want(source, 'fake', { z: 10, x: 5, y: 7 });
  // A surface made of nothing, since this test has no display: what matters
  // is that a finished one is found and an unfinished one is not.
  const fake = {
    width: 256,
    height: 256,
    getContext: () => null,
    clear: () => undefined,
    destroy: () => undefined,
  };
  const drawing = cache.beginRender(parent, 256, 10, () => fake);
  assert.ok(drawing, 'a rendering was started');
  assert.equal(
    cache.ancestorWithSurface('fake', { z: 12, x: 21, y: 29 }),
    null,
    'a rendering still being drawn is not a cover',
  );
  drawing.progress = -1;
  cache.promote(parent);
  assert.equal(
    cache.ancestorWithSurface('fake', { z: 12, x: 21, y: 29 }),
    parent,
    'and a finished one is',
  );
  assert.equal(
    cache.ancestorWithSurface('fake', { z: 12, x: 0, y: 0 }),
    null,
    'a tile that is not a descendant is not covered',
  );
  cache.destroy();
});

// --- the element -----------------------------------------------------------

test('the element registers, is drawn, and its kind is its name', () => {
  assert.ok(knownElements().includes(MAPVIEW_ELEMENT));
  // `drawn` decides whether the element paints at all: a kind missing from
  // this set lays out correctly, reports a sensible rect, and never appears
  // on screen, with no error anywhere.
  assert.ok(drawnKinds().includes(MAPVIEW_ELEMENT));
});

test('no prop name of this element is also a style name', () => {
  // `semanticNames` is the difference between DEV and production: an
  // element whose vocabulary overlaps the style vocabulary throws in
  // development on its own props and works in production. This element
  // declares none, so this is what keeps that honest — and it is why the
  // map style prop is `mapStyle` rather than `style`.
  for (const name of [
    'sources',
    'mapStyle',
    'camera',
    'minZoom',
    'maxZoom',
    'markers',
    'overlays',
    'interactive',
    'attribution',
    'rasterBudgetMs',
    'rasterScale',
    'surfaceBudget',
    'batchVertices',
  ]) {
    assert.equal(isStyleProp(name), false, `${name} is a style prop`);
  }
});

async function mountMap(
  props: Partial<React.ComponentProps<typeof MapView>> = {},
  options: RenderX11Options = HEADLESS,
): Promise<{
  handle: MapHandle;
  node: DrawnNode;
  rerender: (
    next: Partial<React.ComponentProps<typeof MapView>>,
  ) => Promise<void>;
}> {
  const ref = React.createRef<MapHandle>();
  const render = (extra: Partial<React.ComponentProps<typeof MapView>>) =>
    React.createElement(MapView, {
      ref,
      defaultCamera: { center: LONDON, zoom: 12 },
      'data-testname': 'map',
      ...props,
      ...extra,
    });
  const result = await renderX11(render({}), options);
  const node = result.getByTestName('map');
  return {
    handle: ref.current as MapHandle,
    node,
    rerender: async (next) => {
      await result.rerender(render(next));
    },
  };
}

test('a map with no sources still draws, and reports its camera', async () => {
  const { handle } = await mountMap();
  assert.ok(handle, 'the handle attaches');
  const camera = handle.getCamera();
  assert.equal(camera.zoom, 12);
  assert.ok(Math.abs(camera.center.lat - LONDON.lat) < 1e-9);
});

test('the handle projects and unprojects around its own camera', async () => {
  const { handle } = await mountMap();
  const centre = handle.project(handle.getCamera().center);
  // The camera's own centre lands at the middle of the pane.
  assert.ok(Math.abs(centre.x - 320) < 1, `x ${centre.x}`);
  assert.ok(Math.abs(centre.y - 240) < 1, `y ${centre.y}`);
  const back = handle.unproject(centre.x, centre.y);
  assert.ok(Math.abs(back.lat - LONDON.lat) < 1e-6);
  assert.ok(Math.abs(back.lon - LONDON.lon) < 1e-6);
});

test('zoomIn is about the centre, which is what stays put', async () => {
  const { handle } = await mountMap();
  const pane = { x: 320, y: 240 };
  const before = handle.unproject(pane.x, pane.y);
  handle.zoomIn(1);
  const after = handle.unproject(pane.x, pane.y);
  assert.ok(
    Math.abs(after.lat - before.lat) < 1e-9,
    `${before.lat} -> ${after.lat}`,
  );
  assert.ok(
    Math.abs(after.lon - before.lon) < 1e-9,
    `${before.lon} -> ${after.lon}`,
  );
  assert.ok(handle.getCamera().zoom > 12);
});

test('a wheel zooms about the pointer, which is what stays put', async () => {
  const { handle, node } = await mountMap({}, DRIVEN);
  // `dx`/`dy` are device pixels from the node's centre — `screenPointOf`
  // adds them to `abs`, which is device — and this test runs at scale 1, so
  // they are also the logical offset the handle projects in.
  const point = { x: 320 - 140, y: 240 + 90 };
  const before = handle.unproject(point.x, point.y);
  await userEvent.wheel(node, { dx: -140, dy: 90, deltaY: -4 });
  assert.ok(handle.getCamera().zoom > 12, 'it zoomed in');
  const after = handle.unproject(point.x, point.y);
  // The place under the pointer is the one thing a zoom must not move. Not
  // exact to the last bit: the zoom is quantized to a sixteenth of a level,
  // deliberately, because every distinct zoom is a distinct set of font
  // sizes to shape (react-x11's docs/scale.md). A metre is 1e-5 degrees.
  assert.ok(
    Math.abs(after.lat - before.lat) < 1e-6,
    `${before.lat} -> ${after.lat}`,
  );
  assert.ok(
    Math.abs(after.lon - before.lon) < 1e-6,
    `${before.lon} -> ${after.lon}`,
  );
});

test('panning moves the camera the opposite way to the pointer', async () => {
  const { handle } = await mountMap();
  const before = handle.getCamera();
  handle.panBy(100, 0);
  const after = handle.getCamera();
  // Dragging the map left moves the camera east.
  assert.ok(after.center.lon > before.center.lon);
  assert.equal(after.zoom, before.zoom);
});

test('the camera is clamped to the zoom range', async () => {
  const { handle } = await mountMap({ minZoom: 4, maxZoom: 10 });
  handle.zoomTo(20);
  assert.equal(handle.getCamera().zoom, 10);
  handle.zoomTo(0);
  assert.equal(handle.getCamera().zoom, 4);
});

test('fitMarkers frames every marker', async () => {
  const markers: MapMarker[] = [
    { id: 'a', position: { lon: -0.2, lat: 51.45 } },
    { id: 'b', position: { lon: 0.0, lat: 51.55 } },
  ];
  const { handle } = await mountMap({ markers });
  handle.fitMarkers();
  const bounds = handle.getBounds();
  assert.ok(bounds.west <= -0.2 && bounds.east >= 0.0);
  assert.ok(bounds.south <= 51.45 && bounds.north >= 51.55);
});

test('a click reports where it landed, and on which marker', async () => {
  const clicks: { lat: number; lon: number; marker: string | null }[] = [];
  const markerClicks: string[] = [];
  const markers: MapMarker[] = [{ id: 'home', position: LONDON }];
  const { node } = await mountMap(
    {
      markers,
      onMapClick: (event) =>
        clicks.push({
          lat: event.lngLat.lat,
          lon: event.lngLat.lon,
          marker: event.marker?.id ?? null,
        }),
      onMarkerClick: (marker) => markerClicks.push(marker.id),
    },
    DRIVEN,
  );
  // The centre of the pane is the camera's centre, which is where the
  // marker is — and a pin *stands on* its position, so its ink is above it.
  await userEvent.click(node, { dy: -6 });
  assert.deepEqual(markerClicks, ['home']);
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].marker, 'home');

  // Well away from the marker: a map click with no marker on it.
  await userEvent.click(node, { dx: -200, dy: 150 });
  assert.equal(markerClicks.length, 1, 'no second marker click');
  assert.equal(clicks.length, 2);
  assert.equal(clicks[1].marker, null);
  assert.ok(clicks[1].lat < clicks[0].lat, 'clicking below is further south');
  assert.ok(clicks[1].lon < clicks[0].lon, 'and to the left is further west');
});

test('hovering a marker reports it, and leaving the map reports null', async () => {
  const seen: (string | null)[] = [];
  const events: (string | null)[] = [];
  const { node } = await mountMap(
    {
      markers: [{ id: 'home', position: LONDON }],
      onMarkerHover: (marker, event) => {
        seen.push(marker?.id ?? null);
        events.push(event ? 'event' : null);
      },
    },
    DRIVEN,
  );
  await userEvent.hover(node, { dy: -6 });
  // `waitFor` rather than a bare assertion: pointer motion is dispatched at
  // continuous priority and arrives over the wire, so on a loaded machine
  // it can land after the `act()` inside `hover` has already returned.
  // `waitFor` flushes between attempts, which is the difference between
  // this passing everywhere and passing on a fast one.
  await waitFor(() => {
    assert.deepEqual(seen, ['home']);
  });
  assert.deepEqual(events, ['event']);
  // The pointer leaving the map is the other way a hover ends, and it is
  // the one that carries no position — there is no place on the map to
  // report, so the event is null rather than invented.
  //
  // Called directly rather than driven through the harness: the in-process
  // server delivers one motion per mount (a plain `<box onMouseMove>`
  // behaves the same way), so `unhover`, which is a move to screen (0, 0),
  // does not produce a crossing here. This is the method core calls.
  (node as unknown as { defaultMouseLeave(): void }).defaultMouseLeave();
  assert.deepEqual(seen, ['home', null]);
  assert.deepEqual(events, ['event', null]);
});

test('a controlled camera is the application’s, and a gesture only asks', async () => {
  const asked: number[] = [];
  const camera = { center: LONDON, zoom: 12 };
  const ref = React.createRef<MapHandle>();
  const result = await renderX11(
    React.createElement(MapView, {
      ref,
      camera,
      onCameraChange: (next) => asked.push(next.zoom),
      'data-testname': 'map',
    }),
    HEADLESS,
  );
  const handle = ref.current as MapHandle;
  handle.zoomIn(1);
  assert.ok(asked.length > 0, 'the element asked');
  assert.equal(handle.getCamera().zoom, 12, 'and did not move itself');
  void result;
});

test('a wheel over the map zooms it, and does not scroll what is behind', async () => {
  const { handle, node } = await mountMap({}, DRIVEN);
  const before = handle.getCamera().zoom;
  await userEvent.wheel(node, { deltaY: -3 });
  assert.ok(handle.getCamera().zoom > before, 'the wheel zoomed in');
  await userEvent.wheel(node, { deltaY: 6 });
  assert.ok(handle.getCamera().zoom < before, 'and back out');
});

test('interactive={false} freezes the camera and still reports clicks', async () => {
  const clicks: number[] = [];
  const { handle, node } = await mountMap(
    { interactive: false, onMapClick: () => clicks.push(1) },
    DRIVEN,
  );
  const before = handle.getCamera().zoom;
  await userEvent.wheel(node, { deltaY: -3 });
  assert.equal(handle.getCamera().zoom, before, 'the wheel did nothing');
  await userEvent.click(node);
  assert.equal(clicks.length, 1, 'the click still arrived');
});

test('markers reach the accessibility scene as buttons', async () => {
  const result = await renderX11(
    React.createElement(MapView, {
      defaultCamera: { center: LONDON, zoom: 12 },
      markers: [
        { id: 'a', position: LONDON, title: 'Trafalgar Square' },
        { id: 'b', position: TOKYO },
      ],
      'data-testname': 'map',
    }),
    { ...HEADLESS, a11y: true },
  );
  const node = result.getByTestName('map') as unknown as {
    a11yScene(): { id: string; role?: string; name?: string }[];
  };
  const scene = node.a11yScene();
  // Only the one on screen: Tokyo is not in a London view.
  assert.equal(scene.length, 1);
  assert.equal(scene[0].id, 'marker:a');
  assert.equal(scene[0].role, 'button');
  assert.equal(scene[0].name, 'Trafalgar Square');
});

test('a marker with no title is announced by its position', async () => {
  const result = await renderX11(
    React.createElement(MapView, {
      defaultCamera: { center: LONDON, zoom: 12 },
      markers: [{ id: 'a', position: LONDON }],
      'data-testname': 'map',
    }),
    HEADLESS,
  );
  const node = result.getByTestName('map') as unknown as {
    a11yScene(): { name?: string }[];
  };
  assert.match(node.a11yScene()[0].name ?? '', /51\.5080, -0\.1281/);
});

test('a map that cannot rasterize stops asking for frames', async () => {
  // The spin this pins: `paint` asks for another frame while any tile is
  // still pending, and a backend with no offscreen `Surface` — the mock one
  // the headless suite runs on — can never make a tile drawable. Counted as
  // pending, that is a repaint at the refresh rate, forever, of a map that
  // cannot change.
  const frames: number[] = [];
  const source: MapSource = {
    id: 'x',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    load: () => ({ kind: 'vector', data: tileBytes([]) }),
  };
  await renderX11(
    React.createElement(MapView, {
      sources: [source],
      defaultCamera: { center: LONDON, zoom: 6 },
      onFrame: (stats) => frames.push(stats.pending),
      'data-testname': 'map',
    }),
    HEADLESS,
  );
  await act(async () => {});
  await act(async () => {});
  assert.ok(frames.length > 0, 'it painted');
  assert.ok(
    frames.every((pending) => pending === 0),
    `nothing may be left pending on a backend with no surfaces: ${frames}`,
  );
});

// --- the display scale -----------------------------------------------------
//
// The trap react-x11's docs/scale.md describes and this repo has been
// caught by five times: an element that compares a logical event coordinate
// with its device `abs` passes every test at 1x and then hovers at half the
// distance, pans at half speed and frames at half size on a retina panel.

test('a click lands in the same place at scale 2', async () => {
  const at1: { lat: number; lon: number }[] = [];
  const at2: { lat: number; lon: number }[] = [];
  const mount = async (scale: number, into: { lat: number; lon: number }[]) => {
    const result = await renderX11(
      React.createElement(MapView, {
        defaultCamera: { center: LONDON, zoom: 12 },
        onMapClick: (event) => into.push(event.lngLat),
        'data-testname': 'map',
      }),
      { ...DRIVEN, scale },
    );
    // `dx`/`dy` are **device** pixels: `screenPointOf` adds them to `abs`,
    // which core hands over in device pixels. Scaling them here is what
    // makes both runs click the same *logical* offset from the centre —
    // which is the whole point of the assertion, and what catches an
    // element that compared a logical event coordinate with a device rect.
    await userEvent.click(result.getByTestName('map'), {
      dx: -120 * scale,
      dy: 90 * scale,
    });
    await cleanup();
  };
  await mount(1, at1);
  await mount(2, at2);
  assert.equal(at1.length, 1);
  assert.equal(at2.length, 1);
  // The same logical offset from the centre is the same place on the map,
  // whatever the panel's density.
  assert.ok(
    Math.abs(at1[0].lat - at2[0].lat) < 1e-9,
    `${at1[0].lat} vs ${at2[0].lat}`,
  );
  assert.ok(
    Math.abs(at1[0].lon - at2[0].lon) < 1e-9,
    `${at1[0].lon} vs ${at2[0].lon}`,
  );
});

test('a marker is hit at the same offset at scale 2', async () => {
  const hits: string[] = [];
  const result = await renderX11(
    React.createElement(MapView, {
      defaultCamera: { center: LONDON, zoom: 12 },
      markers: [{ id: 'home', position: LONDON }],
      onMarkerClick: (marker) => hits.push(marker.id),
      'data-testname': 'map',
    }),
    { ...DRIVEN, scale: 2 },
  );
  // Device pixels from the centre, so at scale 2 this is 3 logical pixels
  // above the pin's tip — inside its head either way.
  await userEvent.click(result.getByTestName('map'), { dy: -6 });
  assert.deepEqual(hits, ['home']);
});

test('panning by a distance moves the same way at scale 2', async () => {
  const move = async (scale: number): Promise<number> => {
    const ref = React.createRef<MapHandle>();
    await renderX11(
      React.createElement(MapView, {
        ref,
        defaultCamera: { center: LONDON, zoom: 12 },
        'data-testname': 'map',
      }),
      { ...HEADLESS, scale },
    );
    const handle = ref.current as MapHandle;
    const before = handle.getCamera().center.lon;
    handle.panBy(160, 0);
    const after = handle.getCamera().center.lon;
    await cleanup();
    return after - before;
  };
  const one = await move(1);
  const two = await move(2);
  assert.ok(one > 0);
  assert.ok(Math.abs(one - two) < 1e-9, `${one} vs ${two}`);
});

// --- sources ---------------------------------------------------------------

test('the OSM adapter builds the URL and never fetches by itself', async () => {
  const urls: string[] = [];
  const source = osmVectorSource({
    fetch: (url) => {
      urls.push(url);
      return tileBytes([
        layer({
          name: 'ocean',
          keys: [],
          values: [],
          features: [
            {
              type: GeomType.Point,
              tags: [],
              geometry: [...command(1, 1), 0, 0],
            },
          ],
        }),
      ]);
    },
  });
  assert.equal(source.tileSize, 512);
  assert.equal(source.maxZoom, 14);
  assert.match(source.attribution ?? '', /OpenStreetMap/);
  const data = await source.load({
    z: 14,
    x: 8186,
    y: 5447,
    sourceId: 'osm',
    signal: undefined,
  });
  assert.deepEqual(urls, [
    'https://vector.openstreetmap.org/shortbread_v1/14/8186/5447.mvt',
  ]);
  assert.equal(data?.kind, 'vector');
});

test('a source that answers nothing is an ordinary state', async () => {
  const source = osmVectorSource({ fetch: () => null });
  assert.equal(
    await source.load({ z: 0, x: 0, y: 0, sourceId: 'osm', signal: undefined }),
    null,
  );
});

// Google's is the only source here that has to talk to its server before it
// can ask for a tile, so the session is what these check: created once,
// shared by concurrent callers, and replaced when it goes stale. None of it
// needs a key, which is the point of keeping the key in the callbacks.
const googleFake = (): {
  source: MapSource;
  urls: string[];
  bodies: Record<string, unknown>[];
  expiry: { at: number };
} => {
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const expiry = { at: 0 };
  let n = 0;
  const source = googleTileSource({
    createSession: async (body) => {
      bodies.push(body);
      n += 1;
      return {
        session: `tok-${n}`,
        tileWidth: 256,
        tileHeight: 256,
        expiry: expiry.at ? String(expiry.at) : undefined,
      };
    },
    fetch: (url) => {
      urls.push(url);
      return new Uint8Array([1]);
    },
    decode: () => ({ width: 256, height: 256, data: new Uint8Array(4) }),
  });
  return { source, urls, bodies, expiry };
};

const googleTile = (source: MapSource, z: number, x: number, y: number) =>
  source.load({ z, x, y, sourceId: 'google', signal: undefined });

test('the Google adapter creates one session and spends it on every tile', async () => {
  const { source, urls, bodies } = googleFake();
  await googleTile(source, 4, 3, 5);
  await googleTile(source, 4, 4, 5);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], {
    mapType: 'roadmap',
    language: 'en-US',
    region: 'US',
  });
  assert.deepEqual(urls, [
    'https://tile.googleapis.com/v1/2dtiles/4/3/5?session=tok-1',
    'https://tile.googleapis.com/v1/2dtiles/4/4/5?session=tok-1',
  ]);
  // The key is the application's and stays in its callbacks: this
  // component never sees one and so cannot put one in a URL.
  assert.ok(!urls.some((url) => url.includes('key=')));
  assert.equal(source.tileSize, 256);
  assert.equal(source.maxZoom, 22);
  assert.match(source.attribution ?? '', /Google/);
});

test('concurrent first tiles share one session request', async () => {
  const { source, bodies } = googleFake();
  await Promise.all([
    googleTile(source, 4, 3, 5),
    googleTile(source, 4, 4, 5),
    googleTile(source, 4, 5, 5),
  ]);
  assert.equal(bodies.length, 1);
});

test('an expired Google session is replaced', async () => {
  const { source, urls, expiry } = googleFake();
  // Inside the minute of slack, so this one counts as already stale.
  expiry.at = Math.floor(Date.now() / 1000) + 30;
  await googleTile(source, 4, 3, 5);
  await googleTile(source, 4, 4, 5);
  assert.deepEqual(
    urls.map((url) => url.slice(url.indexOf('session='))),
    ['session=tok-1', 'session=tok-2'],
  );
});

test('Google satellite is a mapType, not a style', async () => {
  const bodies: Record<string, unknown>[] = [];
  const source = googleTileSource({
    mapType: 'satellite',
    layerTypes: ['layerRoadmap'],
    language: 'fr-FR',
    region: 'FR',
    createSession: async (body) => {
      bodies.push(body);
      return { session: 'tok' };
    },
    fetch: () => new Uint8Array([1]),
    decode: () => ({ width: 256, height: 256, data: new Uint8Array(4) }),
  });
  await googleTile(source, 1, 0, 0);
  assert.deepEqual(bodies[0], {
    mapType: 'satellite',
    language: 'fr-FR',
    region: 'FR',
    layerTypes: ['layerRoadmap'],
  });
  assert.equal(source.id, 'google-satellite');
});

// --- a real frame ----------------------------------------------------------

test('a map with a real source paints its tiles', async () => {
  // Two features, drawn through the whole pipeline on a real in-process X
  // server: the cover, the cache, the surface, the rasterizer and the
  // composite. What is asserted is that a frame happened and the tiles were
  // asked for — the pixels themselves are the bench's business.
  const asked: string[] = [];
  const source: MapSource = {
    id: 'test',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    attribution: 'test data',
    load: (request) => {
      asked.push(`${request.z}/${request.x}/${request.y}`);
      return {
        kind: 'vector',
        data: tileBytes([
          layer({
            name: 'ocean',
            keys: [],
            values: [],
            features: [
              {
                type: GeomType.Polygon,
                tags: [],
                geometry: [
                  ...command(1, 1),
                  zigzag(0),
                  zigzag(0),
                  ...command(2, 3),
                  zigzag(4096),
                  zigzag(0),
                  zigzag(0),
                  zigzag(4096),
                  zigzag(-4096),
                  zigzag(0),
                  ...command(7, 0),
                ],
              },
            ],
          }),
        ]),
      };
    },
  };
  const frames: number[] = [];
  const ref = React.createRef<MapHandle>();
  await renderX11(
    React.createElement(MapView, {
      ref,
      sources: [source],
      defaultCamera: { center: LONDON, zoom: 6 },
      onFrame: (stats) => frames.push(stats.tiles),
      'data-testname': 'map',
    }),
    { backend: 'xserver', width: 512, height: 384 },
  );
  await act(async () => {});
  assert.ok(asked.length > 0, 'tiles were asked for');
  assert.ok(frames.length > 0, 'a frame was painted');
  assert.ok(frames[frames.length - 1] > 0, 'and it had tiles in it');
  const stats = (ref.current as MapHandle).stats();
  assert.ok(stats);
  assert.ok(stats.tiles > 0);
});
