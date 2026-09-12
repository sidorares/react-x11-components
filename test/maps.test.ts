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
import { existsSync } from 'node:fs';
import React from 'react';

import {
  cleanup,
  countPixels,
  renderX11,
  userEvent,
  act,
  waitFor,
} from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import { drawnKinds, knownElements } from 'react-x11/host';
import { isStyleProp } from 'react-x11/style';
import type { DrawnNode } from 'react-x11';

import {
  DEFAULT_TILE_SIZE,
  GeometryBuffer,
  MAPVIEW_ELEMENT,
  MapViewNode,
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
  projectPoint,
  pyramidOf,
  rasterFor,
  resolveZoomed,
  shortbreadStyle,
  sourceZoomFor,
  subTileOf,
  tileBounds,
  tileCover,
  tileOf,
  tileTransform,
  tileCountAt,
  transformFor,
  unprojectPoint,
  zoomOffsetFor,
  visibleBounds,
  wrapLon,
  wrapTileX,
} from '../src/maps/index.js';
import type {
  LngLat,
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
import { dataSquareOf } from '../src/maps/proj.js';
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
interface ScreenRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
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

test('past its depth a raster is drawn over its data tile, where the cover puts that tile', () => {
  // An image has nothing finer in it than its pixels, so a raster cell past
  // the source's depth is drawn as the whole of its data tile — over a
  // square that has to be where the cover at the source's own depth puts
  // that tile, or the picture jumps at the zoom it takes over. Both
  // placement bugs this map has had were a grid and a projection
  // disagreeing about where something is.
  for (const [tileSize, zoom] of [
    [256, 19],
    [256, 20.3],
    [256, 22],
    [512, 20],
    [512, 21.6],
  ] as const) {
    const pyramid = { minZoom: 0, maxZoom: 19, tileSize };
    const t = transformFor(
      { center: LONDON, zoom },
      { width: 700, height: 500 },
    );
    const cells = tileCover(t, { ...pyramid, maxZoom: 19 + 6 }, 256);
    const own = tileCover(t, pyramid, 256);
    const at = `${tileSize}px at zoom ${zoom}`;
    assert.ok(cells[0].tile.z > 19, `${at} is past the cut`);
    for (const cell of cells) {
      const square = dataSquareOf(cell, 19);
      const { z, x, y } = square.tile;
      const tile = own.find(
        (e) =>
          e.worldCopy === square.worldCopy && e.tile.x === x && e.tile.y === y,
      );
      assert.ok(tile, `${at}: ${z}/${x}/${y} is not in the cover at the cut`);
      assert.equal(z, 19);
      for (const k of ['x', 'y', 'size'] as const) {
        assert.ok(
          Math.abs(square[k] - tile[k]) < 1e-6,
          `${at}: ${k} is ${square[k]}, and the cover at the cut says ${tile[k]}`,
        );
      }
    }
  }
  // A tile the source cuts is its own square.
  const t = transformFor(
    { center: LONDON, zoom: 18.5 },
    { width: 700, height: 500 },
  );
  const entry = tileCover(t, { minZoom: 0, maxZoom: 19, tileSize: 256 })[0];
  assert.equal(dataSquareOf(entry, 19), entry);
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
 *  takes three passes to draw — plus any `extra` layers. */
function threeLayerTile(extra: number[][] = []): Uint8Array {
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
  return tileBytes([
    ...['ocean', 'land', 'buildings'].map((name) =>
      layer({
        name,
        keys: [],
        values: [],
        features: [{ type: GeomType.Polygon, tags: [], geometry: square }],
      }),
    ),
    ...extra,
  ]);
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

// Past a raster source's deepest level.
//
// The cover goes deeper than a source cuts, and each tile past the cut is a
// cell of its ancestor's data — rasterized through the cell for vector data,
// which is what makes overzoom sharp. An image has nothing finer in it, and a
// cell of one was drawn by uploading the image: all of it, into every cell.
// So the view was that tile in miniature, 2×2 one level past the source and
// 4×4 two past. A 256px source is read a level deeper than the view, so for
// `osmRasterSource`, which cuts at 19, that was every zoom from 19 up.
//
// The fixture is ground truth rather than a flat colour: a checkerboard laid
// on the ground, so what every pixel should show is a function of where it
// is, and a picture drawn at the wrong place or the wrong size is wrong at
// half of them.

/** The ground's two colours, each the same read as RGBA or as BGRA. */
const GROUND: readonly [Rgb, Rgb] = [
  [0, 140, 0],
  [255, 0, 255],
];

/** The ground's squares are the tiles of this level. */
const GROUND_LEVEL = 22;

/** The ground as `osmRasterSource` serves a map: 256px images, cut at 19. */
const GROUND_SOURCE: MapSource = {
  id: 'ground',
  tileSize: 256,
  minZoom: 0,
  maxZoom: 19,
  load: ({ z, x, y }) => {
    const size = 256;
    const cells = 2 ** (GROUND_LEVEL - z);
    const data = new Uint8Array(size * size * 4);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const gx = Math.floor((x + (i + 0.5) / size) * cells);
        const gy = Math.floor((y + (j + 0.5) / size) * cells);
        data.set([...GROUND[(gx + gy) & 1], 255], (j * size + i) * 4);
      }
    }
    return { kind: 'raster', width: size, height: size, data };
  },
};

/**
 * How many of a grid of samples over the pane show a colour other than the
 * ground's where `unproject` puts them. A sample near a square's edge is
 * skipped, since a scaled image blends the two colours there — by a margin
 * that grows with the scaling, a zoom-19 pixel being 16 logical pixels
 * across at zoom 22.
 */
async function wrongGround(
  result: { ctx: unknown; windowNode: DrawnNode },
  handle: MapHandle,
  pane: ScreenRectLike,
  scale: number,
): Promise<{ checked: number; wrong: number; first: string }> {
  const width = Math.round(result.windowNode.abs.width);
  const height = Math.round(result.windowNode.abs.height);
  const { data } = await (
    result.ctx as {
      getImageData(
        x: number,
        y: number,
        w: number,
        h: number,
      ): Promise<{ data: Uint8ClampedArray }>;
    }
  ).getImageData(0, 0, width, height);
  const zoom = handle.getCamera().zoom;
  const square = DEFAULT_TILE_SIZE * 2 ** (zoom - GROUND_LEVEL);
  const margin = 2 + 1.5 * ((DEFAULT_TILE_SIZE * 2 ** (zoom - 19)) / 256);
  const n = 2 ** GROUND_LEVEL;
  let checked = 0;
  let wrong = 0;
  let first = '';
  for (let y = 2.5; y < pane.height; y += 5) {
    for (let x = 2.5; x < pane.width; x += 5) {
      const at = handle.unproject(x, y);
      const gx = mercatorXFromLon(at.lon) * n;
      const gy = mercatorYFromLat(at.lat) * n;
      const edge =
        Math.min(
          gx - Math.floor(gx),
          Math.ceil(gx) - gx,
          gy - Math.floor(gy),
          Math.ceil(gy) - gy,
        ) * square;
      if (edge < margin) continue;
      checked++;
      const rgb = GROUND[(Math.floor(gx) + Math.floor(gy)) & 1];
      const i =
        (Math.floor((pane.y + y) * scale) * width +
          Math.floor((pane.x + x) * scale)) *
        4;
      if (
        Math.abs(data[i] - rgb[0]) <= 40 &&
        Math.abs(data[i + 1] - rgb[1]) <= 40 &&
        Math.abs(data[i + 2] - rgb[2]) <= 40
      ) {
        continue;
      }
      wrong++;
      first ||=
        `(${x}, ${y}) is rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]}) ` +
        `over ground that is rgb(${rgb.join(', ')})`;
    }
  }
  return { checked, wrong, first };
}

for (const scale of [1, 2]) {
  test(`past a raster source's deepest level each place is drawn once, where it is, at scale ${scale}`, async () => {
    const ref = React.createRef<MapHandle>();
    // 18.5 is the deepest a 256px source cut at 19 is drawn from tiles of
    // its own, the level read being `floor(zoom + 1)`; the rest are one, two
    // and four levels past it.
    const defaultCamera = { center: LONDON, zoom: 18.5 };
    const result = await renderX11(
      React.createElement(MapView, {
        ref,
        sources: [GROUND_SOURCE],
        defaultCamera,
        attribution: '',
        'data-testname': 'map',
      }),
      { backend: 'xserver', width: 240, height: 180, scale },
    );
    const handle = ref.current as MapHandle;
    const abs = result.getByTestName('map').abs;
    const pane = {
      x: abs.x / scale,
      y: abs.y / scale,
      width: abs.width / scale,
      height: abs.height / scale,
    };
    for (const zoom of [18.5, 19, 20.5, 22]) {
      await act(async () => handle.setCamera({ center: LONDON, zoom }));
      await waitFor(async () => {
        const seen = await wrongGround(result, handle, pane, scale);
        assert.ok(
          seen.checked > 200,
          `zoom ${zoom}: only ${seen.checked} samples clear of an edge`,
        );
        assert.ok(
          seen.wrong === 0,
          `zoom ${zoom}: ${seen.wrong} of ${seen.checked} samples show the ` +
            `wrong ground, the first ${seen.first}`,
        );
      });
    }
  });
}

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

test('a tile that leaves the cover mid-load is aborted, and asked for again if it comes back', async () => {
  // `signal` was documented as aborted "when the tile leaves the view" and
  // nothing did that — the only aborts were eviction past the data budget
  // and `destroy()`. A tile panned out of the cover loaded to the end, and
  // landing was an `onChange`: a full-pane repaint for a tile nobody was
  // looking at.
  const loads: {
    tile: string;
    signal: AbortSignal;
    answer: (data: TileData) => void;
  }[] = [];
  const source: MapSource = {
    id: 's',
    // Answers when the test says so — and, like a source that never passes
    // its signal on, whether or not it has been aborted.
    load: ({ z, x, y, signal }) =>
      new Promise<TileData>((answer) => {
        loads.push({
          tile: `${z}/${x}/${y}`,
          signal: signal as AbortSignal,
          answer,
        });
      }),
  };
  const changed: string[] = [];
  const cache = new TileCache({
    onChange: (entry) => changed.push(entry.key),
  });
  const frame = (...tiles: { z: number; x: number; y: number }[]): void => {
    cache.beginFrame();
    for (const tile of tiles) cache.want(source, 's', tile);
    cache.sweep();
  };
  const settled = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));
  const stay = { z: 3, x: 2, y: 2 };
  const away = { z: 3, x: 5, y: 2 };

  frame(stay, away);
  frame(stay); // `away` has left the cover with its load still in flight
  assert.deepEqual(
    loads.map((load) => [load.tile, load.signal.aborted]),
    [
      ['3/2/2', false],
      ['3/5/2', true],
    ],
  );
  // Forgotten, not left behind: an aborted load never settles, so an entry
  // kept would say 'loading' forever and never be asked for again.
  assert.equal(cache.peek(source, away), undefined);

  frame(stay, away);
  assert.deepEqual(
    loads.map((load) => load.tile),
    ['3/2/2', '3/5/2', '3/5/2'],
    'the tile that came back is asked for again, and the one that stayed is not',
  );
  assert.equal(loads[2].signal.aborted, false, 'with a signal of its own');

  // The aborted load answering late must not land in the new one's place…
  loads[1].answer({ kind: 'vector', data: tileBytes([]) });
  await settled();
  assert.equal(cache.peek(source, away)?.status, 'loading');
  assert.deepEqual(changed, [], 'or repaint anything');
  // …and the new one lands as any load does.
  loads[2].answer({ kind: 'vector', data: tileBytes([]) });
  await settled();
  assert.equal(cache.peek(source, away)?.status, 'ready');
  assert.deepEqual(changed, [cache.peek(source, away)?.data.key]);
  cache.destroy();
});

test('switching sources aborts what the old one had in flight, and keeps what it delivered', async () => {
  // A provider switch is every tile of one source leaving at once. What it
  // had in flight is cancelled; what already arrived stays, which is what
  // makes switching back free.
  const asked: string[] = [];
  const signals: AbortSignal[] = [];
  const failed: unknown[] = [];
  const arrived = { z: 3, x: 2, y: 2 };
  const inFlight = { z: 3, x: 5, y: 2 };
  const old: MapSource = {
    id: 'old',
    load: ({ z, x, y, signal }) => {
      asked.push(`${z}/${x}/${y}`);
      if (x === arrived.x) return { kind: 'vector', data: tileBytes([]) };
      // Honours its signal the way `fetch` does: aborted, it rejects with
      // the signal's reason, which is an `AbortError`.
      const abortable = signal as AbortSignal;
      signals.push(abortable);
      return new Promise<TileData>((_, reject) => {
        abortable.addEventListener('abort', () => reject(abortable.reason));
      });
    },
  };
  const next: MapSource = {
    id: 'next',
    load: () => new Promise<TileData>(() => {}),
  };
  const cache = new TileCache({
    onError: (entry) => failed.push(entry.error),
  });
  const frame = (source: MapSource, id: string): void => {
    cache.beginFrame();
    cache.want(source, id, arrived);
    cache.want(source, id, inFlight);
    cache.sweep();
  };

  frame(old, 'old');
  assert.equal(cache.peek(old, arrived)?.status, 'ready');
  frame(next, 'next');
  assert.equal(signals[0].aborted, true, 'the switch aborts the old load');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(failed, [], 'and its AbortError is not a tile error');
  assert.equal(
    cache.peek(old, arrived)?.status,
    'ready',
    'what arrived is kept',
  );

  frame(old, 'old');
  assert.deepEqual(
    asked,
    ['3/2/2', '3/5/2', '3/5/2'],
    'switching back asks again for the aborted tile, and only that one',
  );
  cache.destroy();
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
  const entry = cache.peek(source, { z: 1, x: 0, y: 0 });
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

test('a source object is its own cache: another under the same id shares nothing', async () => {
  // What a provider switch showed: the old provider's tiles wherever it had
  // them, the new one's everywhere else. Tiles were filed under the
  // source's id, and an id is a name rather than a provider — `source-0`
  // for every source without one, `osm-raster` for `osmRasterSource`
  // whatever its `url` — so a different source under the same name was
  // handed tiles it never loaded.
  const asked: string[] = [];
  const provider = (name: string): MapSource => ({
    id: 'basemap',
    load: () => {
      asked.push(name);
      return { kind: 'vector', data: tileBytes([]) };
    },
  });
  const a = provider('a');
  const b = provider('b');
  const tile = { z: 2, x: 1, y: 1 };
  const cache = new TileCache();
  cache.beginFrame();
  const fromA = cache.want(a, 'basemap', tile);
  const fromB = cache.want(b, 'basemap', tile);
  await Promise.resolve();
  assert.deepEqual(asked, ['a', 'b'], 'each provider is asked for its own');
  assert.notEqual(fromB.data, fromA.data);
  assert.equal(fromB.sourceId, 'basemap', 'and is still called by its id');
  cache.want(a, 'basemap', tile);
  assert.deepEqual(asked, ['a', 'b'], 'one object is still one cache');
  cache.destroy();
});

/** One colour, edge to edge: which provider drew a pixel is then something
 *  the pixel says. */
function solidRaster(rgb: [number, number, number]): TileData {
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data.set([...rgb, 255], i);
  }
  return { kind: 'raster', width: size, height: size, data };
}

async function settleFrames(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const WHOLE = { width: 200, height: 200 };

for (const [label, id] of [
  ['sources with no id', undefined],
  ['sources sharing an id', 'basemap'],
] as const) {
  test(`switching provider never shows the old one's tiles — ${label}`, async () => {
    // The user-visible half. No id makes both `source-0`; a shared id is
    // what two `osmRasterSource`s pointed at two servers amount to.
    let askedRed = 0;
    const red: MapSource = {
      ...(id ? { id } : {}),
      tileSize: 512,
      load: () => {
        askedRed++;
        return solidRaster(RED);
      },
    };
    // Held until the test lets go, so the frames between the switch and
    // the new provider's first answer can be looked at on their own.
    const held: (() => void)[] = [];
    const blue: MapSource = {
      ...(id ? { id } : {}),
      tileSize: 512,
      load: () =>
        new Promise<TileData>((resolve) => {
          held.push(() => resolve(solidRaster(BLUE)));
        }),
    };
    let frames: MapFrameStats[] = [];
    const render = (sources: MapSource[]): React.ReactElement =>
      React.createElement(MapView, {
        sources,
        defaultCamera: { center: ONE_TILE_CENTRE, zoom: 3 },
        onFrame: (stats) => frames.push({ ...stats }),
        'data-testname': 'map',
      });
    const result = await renderX11(render([red]), {
      backend: 'xserver',
      ...WHOLE,
    });
    await settleFrames();
    assert.ok(
      (await countPixels(result.ctx, WHOLE, RED, 8)) > 0,
      'the first provider drew',
    );

    frames = [];
    await result.rerender(render([blue]));
    await settleFrames();
    assert.ok(held.length > 0, 'the new provider was asked for its tiles');
    assert.ok(frames.length > 0, 'the switch painted');
    for (const frame of frames) {
      assert.equal(
        frame.ready + frame.fromAncestor + frame.fromDescendant,
        0,
        `a tile was drawn before its provider answered: ${JSON.stringify(frame)}`,
      );
    }
    assert.equal(
      await countPixels(result.ctx, WHOLE, RED, 8),
      0,
      'none of the old provider is left on screen',
    );

    for (const release of held.splice(0)) release();
    await settleFrames();
    assert.ok((await countPixels(result.ctx, WHOLE, BLUE, 8)) > 0);
    assert.equal(await countPixels(result.ctx, WHOLE, RED, 8), 0);

    // Keyed by provider cuts both ways: switching back finds the first
    // provider's tiles still cached, and asks it for nothing.
    const before = askedRed;
    await result.rerender(render([red]));
    await settleFrames();
    assert.equal(askedRed, before, 'the first provider was not asked again');
    assert.ok((await countPixels(result.ctx, WHOLE, RED, 8)) > 0);
    assert.equal(await countPixels(result.ctx, WHOLE, BLUE, 8), 0);
  });
}

// Real font files: without `app.fonts` the map shapes no labels at all. The
// pair `test/markdown.test.ts` looks for; a box with neither skips the test.
const FONT_FILES = [
  [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Monaco.ttf',
  ],
  [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  ],
].find(([sans, mono]) => existsSync(sans) && existsSync(mono));
const FONTS = FONT_FILES
  ? { 'sans-serif': FONT_FILES[0], monospace: FONT_FILES[1] }
  : null;

test(
  'labels come only from the sources on the map',
  { skip: !FONTS },
  async () => {
    // The same leak one layer up. Labels are collected from the tile data the
    // cache holds, and it keeps a provider's tiles after the provider is
    // switched away — which is what makes switching back free — so a map
    // switched off a vector source kept drawing that source's place names
    // over the new one's tiles, until eviction reached them.
    const named: MapSource = {
      id: 'named',
      tileSize: 512,
      load: () => ({
        kind: 'vector',
        data: tileBytes([
          layer({
            name: 'places',
            keys: ['name'],
            values: ['Soho'],
            features: [
              {
                type: GeomType.Point,
                tags: [0, 0],
                // The middle of the tile, which is the middle of the pane.
                geometry: [...command(1, 1), zigzag(2048), zigzag(2048)],
              },
            ],
          }),
        ]),
      }),
    };
    const plain: MapSource = {
      id: 'plain',
      tileSize: 512,
      load: () => ({ kind: 'vector', data: threeLayerTile() }),
    };
    const style: MapStyle = {
      ...THREE_RUN_STYLE,
      layers: [
        ...THREE_RUN_STYLE.layers,
        {
          id: 'places',
          type: 'symbol',
          sourceLayer: 'places',
          textField: 'name',
        },
      ],
    };
    let frames: MapFrameStats[] = [];
    const render = (sources: MapSource[]): React.ReactElement =>
      React.createElement(MapView, {
        sources,
        mapStyle: style,
        defaultCamera: { center: ONE_TILE_CENTRE, zoom: 3 },
        onFrame: (stats) => frames.push({ ...stats }),
        'data-testname': 'map',
      });
    const result = await renderX11(render([named]), {
      backend: 'xserver',
      ...WHOLE,
      fonts: FONTS!,
    });
    await settleFrames();
    // A frame that only continues a rasterization clips to one pixel and
    // draws no labels whatever the cache holds, so only repaints count.
    const repainted = (f: MapFrameStats): boolean =>
      f.damage === null || f.damage.width * f.damage.height > 4096;
    assert.ok(
      frames.some((f) => repainted(f) && f.labels > 0),
      'the place name was drawn',
    );

    frames = [];
    await result.rerender(render([plain]));
    await settleFrames();
    const full = frames.filter(repainted);
    assert.ok(full.length > 0, 'the switch repainted');
    for (const frame of full) {
      assert.equal(
        frame.labels,
        0,
        `the old source's label is still drawn: ${JSON.stringify(frame)}`,
      );
    }
  },
);

test('the map aborts the loads its camera leaves behind, and none it still wants', async () => {
  // The cache cancels whatever a frame did not ask for, so the element has
  // to ask for everything it still wants on every frame — the padding
  // around the pane, a frame clipped to a marker's box, a frame painted
  // mid-gesture. A tile it forgot once would be aborted and fetched again.
  const requests = new Map<string, AbortSignal[]>();
  const held = (id: string): MapSource => ({
    id,
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    // Never answers, so a tile is in flight for as long as it is wanted.
    load: ({ z, x, y, signal }) => {
      const key = `${id} ${z}/${x}/${y}`;
      const signals = requests.get(key) ?? [];
      requests.set(key, [...signals, signal as AbortSignal]);
      return new Promise<TileData>(() => {});
    },
  });
  // On a tile corner, so the pane shows whole tiles and the padding reaches
  // tiles it does not show. Centred on London itself the padded cover
  // happens to be exactly the six tiles on screen, and would test nothing.
  const home = {
    lon: lonFromMercatorX(2046 / 4096),
    lat: latFromMercatorY(1362 / 4096),
  };
  let painted = 0;
  const { handle, rerender } = await mountMap({
    sources: [held('a')],
    defaultCamera: { center: home, zoom: 12 },
    onFrame: () => painted++,
  });
  const step = async (action: () => unknown): Promise<void> => {
    const before = painted;
    await action();
    await act(async () => {});
    await act(async () => {});
    assert.ok(painted > before, 'a frame was painted');
  };
  const aborted = (key: string): boolean[] =>
    (requests.get(key) ?? []).map((signal) => signal.aborted);

  await act(async () => {});
  const wanted = [...requests.keys()];
  const onScreen = handle.stats()?.tiles ?? 0;
  assert.ok(
    onScreen > 0 && wanted.length > onScreen,
    `${wanted.length} tiles loading for ${onScreen} on screen: the padding loads too`,
  );

  // The same view again: a whole frame, then one clipped to a marker.
  await step(() => handle.refresh());
  await step(() => rerender({ markers: [{ id: 'm', position: home }] }));
  assert.ok((handle.stats()?.damage?.width ?? 640) < 640, 'a clipped frame');
  for (const key of wanted) {
    assert.deepEqual(aborted(key), [false], `${key}, with nothing moved`);
  }

  // A camera move is a gesture to the map — nothing is rasterized for a
  // moment after it — and the cover is still asked for. Across the world,
  // nothing of home is wanted; back again, each tile is asked for anew.
  await step(() => handle.setCamera({ center: TOKYO }));
  for (const key of wanted) assert.deepEqual(aborted(key), [true], key);
  const tokyo = [...requests.keys()].filter((key) => !wanted.includes(key));
  assert.ok(tokyo.length > 0, 'Tokyo is asked for');
  await step(() => handle.setCamera({ center: home }));
  for (const key of wanted) assert.deepEqual(aborted(key), [true, false], key);
  for (const key of tokyo) assert.deepEqual(aborted(key), [true], key);

  // A provider switch: every tile of the old one at once.
  await step(() => rerender({ sources: [held('b')] }));
  for (const key of wanted) assert.deepEqual(aborted(key), [true, true], key);
  assert.ok(
    [...requests.keys()].some((key) => key.startsWith('b ')),
    'and the new one is asked instead',
  );
});

// --- a style switch ----------------------------------------------------------
//
// Switching `mapStyle` over the same source redraws every tile, and the
// redraw is budgeted — a dense tile is 50-140 ms against 8 ms a frame — so it
// spans a second or more. These are about what is on screen for that second:
// one style or the other, whole, and never both. The per-tile double buffer
// kept each old tile up until its own replacement was finished, while the new
// background and the new labels went up on the first frame — so the map was
// a patchwork of both styles until the last tile landed.

type Rgb = readonly [number, number, number];

/** The three places a style shows: its tiles, its background and its
 *  labels. Two looks that share no colour make every pixel say which style
 *  drew it. */
interface Look {
  fill: Rgb;
  background: Rgb;
  text: Rgb;
}

const OLD_LOOK: Look = {
  fill: [255, 0, 0],
  background: [255, 255, 0],
  text: [255, 0, 255],
};
const NEW_LOOK: Look = {
  fill: [0, 0, 255],
  background: [0, 255, 255],
  text: [0, 255, 0],
};

function hexOf(rgb: Rgb): string {
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** A look as a style: every fill layer in one colour, so a half-drawn tile
 *  — which only `progressive` shows — is already the colour of the style
 *  drawing it. */
function lookStyle(look: Look): MapStyle {
  const fill = hexOf(look.fill);
  return {
    background: hexOf(look.background),
    layers: [
      { id: 'ocean', type: 'fill', sourceLayer: 'ocean', color: fill },
      { id: 'land', type: 'fill', sourceLayer: 'land', color: fill },
      { id: 'buildings', type: 'fill', sourceLayer: 'buildings', color: fill },
      {
        id: 'places',
        type: 'symbol',
        sourceLayer: 'places',
        textField: 'name',
        textColor: hexOf(look.text),
        textSize: 28,
      },
    ],
  };
}

/** The same look drawn in `passes` fill layers, so that at a layer a frame
 *  a tile takes that many frames to redraw. */
function slowLookStyle(look: Look, passes: number): MapStyle {
  const base = lookStyle(look);
  const sourceLayers = ['ocean', 'land', 'buildings'];
  return {
    ...base,
    layers: [
      ...Array.from({ length: passes }, (_, i) => ({
        id: `pass-${i}`,
        type: 'fill' as const,
        sourceLayer: sourceLayers[i % sourceLayers.length],
        color: hexOf(look.fill),
      })),
      ...base.layers.filter((layer) => layer.type === 'symbol'),
    ],
  };
}

/** Where four zoom-3 tiles meet, so the pane is one quadrant per tile. */
const FOUR_TILES = { lon: 0, lat: 0 };

/**
 * The fixture tile with a place name on it — or nothing, for the south-east
 * quarter of the world, so the pane's bottom-right quadrant is background at
 * every zoom.
 *
 * The name sits 50 pixels in from the tile's corner at the middle of the
 * world. A tile is 512 pixels and the pane 200, so the pane sees a 100-pixel
 * corner of each of its four tiles, and a name in the middle of a tile would
 * never be on screen.
 */
function quadrantTile({
  z,
  x,
  y,
}: {
  z: number;
  x: number;
  y: number;
}): TileData {
  const half = 2 ** (z - 1);
  if (x >= half && y >= half) return null;
  // 50 of a tile's 512 pixels, in its 4096-unit grid.
  const inset = 400;
  return {
    kind: 'vector',
    data: threeLayerTile([
      layer({
        name: 'places',
        keys: ['name'],
        values: [`M${x}${y}`],
        features: [
          {
            type: GeomType.Point,
            tags: [0, 0],
            geometry: [
              ...command(1, 1),
              zigzag(x < half ? 4096 - inset : inset),
              zigzag(y < half ? 4096 - inset : inset),
            ],
          },
        ],
      }),
    ]),
  };
}

const PANE = 200;

interface Tally {
  fill: number;
  background: number;
  text: number;
}

/** How many pixels of the window are each colour of a look. */
function tally(data: Uint8ClampedArray, look: Look): Tally {
  const near = (i: number, rgb: Rgb): boolean =>
    Math.abs(data[i] - rgb[0]) <= 8 &&
    Math.abs(data[i + 1] - rgb[1]) <= 8 &&
    Math.abs(data[i + 2] - rgb[2]) <= 8;
  const out = { fill: 0, background: 0, text: 0 };
  for (let i = 0; i < data.length; i += 4) {
    if (near(i, look.fill)) out.fill++;
    else if (near(i, look.background)) out.background++;
    else if (near(i, look.text)) out.text++;
  }
  return out;
}

function shows(t: Tally): boolean {
  return t.fill + t.background + t.text > 0;
}

/** What a frame put on screen, in both looks. */
interface Looks {
  old: Tally;
  new: Tally;
}

function describeLooks(s: Looks): string {
  return `old ${JSON.stringify(s.old)}, new ${JSON.stringify(s.new)}`;
}

function readWindow(ctx: unknown): Promise<Uint8ClampedArray> {
  return (
    ctx as {
      getImageData(
        x: number,
        y: number,
        w: number,
        h: number,
      ): Promise<{ data: Uint8ClampedArray }>;
    }
  )
    .getImageData(0, 0, PANE, PANE)
    .then((image) => image.data);
}

/**
 * A map over {@link quadrantTile}s in the old look, settled, with a
 * `restyle` that switches it and a record of every frame after that.
 *
 * Each frame is read back from `onFrame`, which runs at the end of the map's
 * paint: the read is a request on the same connection as the frame's
 * drawing, so no frame between the switch and the end goes unseen.
 *
 * The props are stable across renders — one `sources` array, one `onFrame`
 * — so a switch changes `mapStyle` and nothing else, and every claim a frame
 * makes is the map's own.
 */
async function mountLooks(
  options: {
    progressive?: boolean;
    surfaceBudget?: number;
    /** An answer of its own for a tile; `undefined` is the fixture's. */
    load?: (tile: {
      z: number;
      x: number;
      y: number;
    }) => TileData | Promise<TileData> | undefined;
    mapStyle?: MapStyle;
    /** A camera to control, which `moveTo` moves; the element owns it
     *  otherwise. */
    camera?: { center: LngLat; zoom: number };
  } = {},
) {
  const frames: MapFrameStats[] = [];
  const watched: {
    stats: MapFrameStats;
    pixels: Promise<Uint8ClampedArray>;
  }[] = [];
  let ctx: unknown = null;
  let watching = false;
  const onFrame = (stats: MapFrameStats): void => {
    frames.push({ ...stats });
    if (watching && ctx) {
      watched.push({ stats: { ...stats }, pixels: readWindow(ctx) });
    }
  };
  const sources: MapSource[] = [
    {
      id: 'looks',
      minZoom: 0,
      maxZoom: 14,
      tileSize: 512,
      load: (request) => {
        const own = options.load?.(request);
        return own === undefined ? quadrantTile(request) : own;
      },
    },
  ];
  const ref = React.createRef<MapHandle>();
  let mapStyle = options.mapStyle ?? lookStyle(OLD_LOOK);
  let camera = options.camera;
  // One object for the life of the mount: `defaultCamera` is not a
  // self-damaged prop, so a new one would make every commit claim the pane.
  const defaultCamera = { center: FOUR_TILES, zoom: 3 };
  const render = (): React.ReactElement =>
    React.createElement(MapView, {
      ref,
      sources,
      mapStyle,
      ...(camera ? { camera } : { defaultCamera }),
      // A layer a frame, so the redraw of three tiles spans a dozen frames.
      rasterBudgetMs: 0.0001,
      progressive: options.progressive,
      surfaceBudget: options.surfaceBudget,
      onFrame,
      'data-testname': 'map',
    });
  const result = await renderX11(render(), {
    backend: 'xserver',
    width: PANE,
    height: PANE,
    ...(FONTS ? { fonts: FONTS } : {}),
  });
  ctx = result.ctx;
  await settleFrames(40);
  return {
    result,
    ref,
    frames,
    async read(): Promise<Looks> {
      const data = await readWindow(ctx);
      return { old: tally(data, OLD_LOOK), new: tally(data, NEW_LOOK) };
    },
    /** From here on, every frame is recorded, and none before it. */
    watch(): void {
      watching = true;
      frames.length = 0;
      watched.length = 0;
    },
    /** Switch to `next`, and record every frame from here on. */
    async restyle(next: MapStyle = lookStyle(NEW_LOOK)): Promise<void> {
      this.watch();
      mapStyle = next;
      await result.rerender(render());
    },
    /** Move the controlled camera. */
    async moveTo(next: { center: LngLat; zoom: number }): Promise<void> {
      camera = next;
      await result.rerender(render());
    },
    /** Every recorded frame, as it was on screen. */
    async seen(): Promise<(Looks & { stats: MapFrameStats })[]> {
      const out: (Looks & { stats: MapFrameStats })[] = [];
      for (const { stats, pixels } of watched) {
        const data = await pixels;
        out.push({
          stats,
          old: tally(data, OLD_LOOK),
          new: tally(data, NEW_LOOK),
        });
      }
      return out;
    },
  };
}

/** No frame shows both looks. */
function assertOneLook(frames: Looks[]): void {
  frames.forEach((frame, i) => {
    assert.ok(
      !(shows(frame.old) && shows(frame.new)),
      `frame ${i} of ${frames.length} showed both styles: ${describeLooks(frame)}`,
    );
  });
}

/** What is on screen is the new look — tiles, background and, when there
 *  is a font to shape them with, labels — and nothing of the old one. */
function assertNewLook(now: Looks, { labels = true } = {}): void {
  assert.ok(
    now.new.fill > 0 && now.new.background > 0,
    `the new style is up: ${describeLooks(now)}`,
  );
  if (FONTS && labels) {
    assert.ok(now.new.text > 0, `with its labels: ${describeLooks(now)}`);
  }
  assert.ok(
    !shows(now.old),
    `and nothing of the old one: ${describeLooks(now)}`,
  );
}

/** Whether a frame repainted anything more than the one pixel a frame
 *  that only continues a redraw claims. */
function repainted(stats: MapFrameStats): boolean {
  return stats.damage === null || stats.damage.width * stats.damage.height > 1;
}

test('a style switch never shows two styles at once', async () => {
  const map = await mountLooks();
  const before = await map.read();
  assert.ok(
    before.old.fill > 0 && before.old.background > 0,
    `the old style is up: ${describeLooks(before)}`,
  );
  if (FONTS) assert.ok(before.old.text > 0, 'with its labels');

  await map.restyle();
  await settleFrames(40);
  const frames = await map.seen();
  const redrawing = frames.filter((f) => f.stats.pending > 0);
  assert.ok(
    redrawing.length >= 6,
    `the redraw took ${redrawing.length} frames, which is too few to say anything`,
  );
  assertOneLook(frames);
  assertNewLook(await map.read());

  // Held, nothing on screen changes until the swap: every frame before it
  // claims a pixel, and the swap is the one frame that repaints the pane.
  const swap = frames.findIndex((f) => !f.stats.restyling);
  assert.ok(swap > 0, 'the old style was held for a while');
  assert.deepEqual(
    frames.map((f) => repainted(f.stats)),
    frames.map((_, i) => i === swap),
    `the claims were ${frames
      .map((f) =>
        f.stats.damage
          ? `${f.stats.damage.width}x${f.stats.damage.height}`
          : 'full',
      )
      .join(' ')}, with the swap at frame ${swap}`,
  );
});

test('a style switch under progressive is shown as it is redrawn', async () => {
  // The opt-in's whole point, so it keeps it: nothing is held, the new
  // background and labels go up with the switch, and each tile is on
  // screen as soon as it is redrawn rather than all of them at the end.
  const map = await mountLooks({ progressive: true });
  await map.restyle();
  await settleFrames(40);
  const frames = await map.seen();
  assert.ok(
    frames.every((f) => !f.stats.restyling),
    'nothing was held',
  );
  assert.ok(
    frames.length > 0 && frames[0].new.background > 0,
    `the new background went up at once: ${frames[0] && describeLooks(frames[0])}`,
  );
  assert.ok(
    frames.some((f) => f.stats.pending > 0 && f.new.fill > 0),
    'a redrawn tile was on screen while others were still being drawn',
  );
  assertNewLook(await map.read());
});

test('refresh() after an edit in place swaps the whole map, as a new style does', async () => {
  // The other thing that retires every tile, down the same path. The style
  // object is the same one, edited: by the time `refresh()` is called the
  // old background and label colours are gone from it, so what stays up
  // has to be what was painted rather than what the object now says. The
  // labels have to be collected again, too — each carries the colour it
  // was collected in — which `refresh()` did not do, so an edited label
  // colour never showed.
  const edited = lookStyle(OLD_LOOK);
  const map = await mountLooks({ mapStyle: edited });
  map.watch();
  edited.background = hexOf(NEW_LOOK.background);
  for (const layer of edited.layers) {
    if (layer.type === 'fill') layer.color = hexOf(NEW_LOOK.fill);
    if (layer.type === 'symbol') layer.textColor = hexOf(NEW_LOOK.text);
  }
  (map.ref.current as MapHandle).refresh();
  await settleFrames(40);
  const frames = await map.seen();
  assertOneLook(frames);
  assertNewLook(await map.read());
  assert.ok(
    frames.some((f) => f.stats.restyling),
    'the old picture was held while the edit was drawn',
  );
});

test('a tile panned into view during a style switch joins the same swap', async () => {
  // It has no picture in either style, so while the old one is held it
  // shows the old background — and it is drawn in the new style before
  // the swap, like every tile that was already in view.
  const map = await mountLooks();
  await map.restyle();
  // Past the east edge of the four tiles, so a fifth comes into view.
  (map.ref.current as MapHandle).panBy(450, 0);
  await settleFrames(60);
  const frames = await map.seen();
  assertOneLook(frames);
  const after = frames.filter((f) => f.stats.tiles > 0 && repainted(f.stats));
  assert.ok(
    after.some((f) => f.stats.restyling),
    'the old style was still up after the pan',
  );
  // The names were left behind by the pan; the tiles and the background
  // are what is in view.
  assertNewLook(await map.read(), { labels: false });
});

test('crossing a zoom level during a style switch holds the old style from the level before', async () => {
  // The new level's tiles have no picture in either style yet. The old
  // style's tiles a level up cover them, as on any zoom — scaled, and in
  // the old style — and the new level is drawn in the new style before
  // the swap.
  const map = await mountLooks();
  await map.restyle();
  (map.ref.current as MapHandle).zoomTo(4);
  await settleFrames(60);
  const frames = await map.seen();
  assertOneLook(frames);
  assert.ok(
    frames.some(
      (f) =>
        f.stats.restyling &&
        repainted(f.stats) &&
        f.stats.fromAncestor > 0 &&
        f.old.fill > 0,
    ),
    'the level before covered the new one, in the old style',
  );
  assertNewLook(await map.read());
});

test('a view that keeps moving cannot hold the old style up for ever', async () => {
  // Only a gesture stops rasterization, so an application animating a
  // controlled camera keeps the map drawing while it brings tiles into
  // view — here a new one every step, in a style that takes four hundred
  // frames a tile, far more than a tile gets in the step or two it is in
  // view. The view is never all redrawn, so without a bound the old style
  // would stay up for as long as the camera kept moving.
  //
  // At zoom 10, where the world is a thousand tiles wide. Round a smaller
  // one, the camera comes back to tiles it has been drawing all along, and
  // can find a view that is finished just as the bound runs out.
  const map = await mountLooks({ camera: { center: FOUR_TILES, zoom: 10 } });
  // Timed from before the switch: the frames the switch's own commit runs
  // are the first the map counts.
  const began = Date.now();
  await map.restyle(slowLookStyle(NEW_LOOK, 400));
  let swappedAt = 0;
  for (let lon = 0; Date.now() - began < 8000;) {
    // A tile's width a step, east.
    lon += 360 / 1024;
    await map.moveTo({ center: { lon, lat: 0 }, zoom: 10 });
    await settleFrames(1);
    if (!swappedAt && map.frames.some((f) => !f.restyling)) {
      swappedAt = Date.now();
    }
    // …and it keeps moving for a while after the swap, which must not
    // bring the old style back.
    if (swappedAt && Date.now() - swappedAt > 300) break;
  }
  const waited = swappedAt - began;
  assert.ok(swappedAt > 0, 'the swap came while the camera was moving');
  assert.ok(waited >= 1450, `and not before the bound: ${waited} ms`);
  assert.ok(waited < 4000, `nor long after it: ${waited} ms`);
  const frames = await map.seen();
  const swap = frames.findIndex((f) => !f.stats.restyling);
  assert.ok(
    frames[swap].stats.pending > 0,
    'it swapped with tiles still to draw, which only the bound does',
  );
  assertOneLook(frames);
  const now = await map.read();
  assert.ok(!shows(now.old), `none of the old style: ${describeLooks(now)}`);
});

test('a tile still loading does not hold a style switch', async () => {
  // It has nothing to draw in either style, so waiting for it would hold
  // the old style up for as long as a network takes. It shows the
  // background of whichever style is up, and is drawn when it lands.
  const held: (() => void)[] = [];
  const map = await mountLooks({
    load: ({ z, x, y }) =>
      z === 3 && x === 4 && y === 3
        ? new Promise<TileData>((resolve) => {
            held.push(() => resolve(quadrantTile({ z, x, y })));
          })
        : undefined,
  });
  await map.restyle();
  await settleFrames(40);
  assert.ok(held.length > 0, 'the tile is still loading');
  const frames = await map.seen();
  assert.ok(
    frames.some((f) => !f.stats.restyling),
    'and the switch swapped without it',
  );
  assertOneLook(frames);
  const swapped = await map.read();
  assertNewLook(swapped);

  for (const release of held.splice(0)) release();
  await settleFrames(40);
  const landed = await map.read();
  assert.ok(
    landed.new.fill > swapped.new.fill,
    `and it is drawn in the new style when it lands: ${describeLooks(landed)}`,
  );
  assert.ok(!shows(landed.old));
});

/** A raster source's pixels, in a colour neither look uses: a provider's
 *  image belongs to no style. */
const IMAGERY: Rgb = [255, 128, 0];

/** One raster answer for every tile: a tile's worth of {@link IMAGERY} at
 *  512 pixels, drawn 1:1 at an integer zoom. A smaller image scaled up to
 *  a tile fades at its edges, which makes a pixel count say nothing. */
const IMAGERY_TILE: TileData = (() => {
  const size = 512;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data.set([...IMAGERY, 255], i);
  }
  return { kind: 'raster', width: size, height: size, data };
})();

test('a style switch leaves raster tiles, and what they cover, as they are', async () => {
  // A raster tile is the provider's picture and the same in every style, so
  // a restyle has nothing to redraw in it. Retiring it all the same uploaded
  // every raster tile in view again for nothing — and a tile the provider
  // has no image for, which shows its parent scaled up, lost the parent at
  // the swap and fell to the background, because the parent had been drawn
  // under the old generation.
  const map = await mountLooks({
    // Zoom 4's north-east tile has no image, as a depth a provider has not
    // photographed has none.
    load: ({ z, x, y }) =>
      z === 4 && x === 8 && y === 7 ? null : IMAGERY_TILE,
  });
  (map.ref.current as MapHandle).zoomTo(4);
  await settleFrames(40);
  const imagery = (): Promise<number> =>
    countPixels(map.result.ctx, WHOLE, [...IMAGERY], 8);
  // All of it but a pixel's seam where the parent, scaled, meets the pane.
  const whole = PANE * PANE * 0.99;
  const before = await imagery();
  assert.ok(
    before >= whole,
    `the parent covers the tile with no image: ${before} of ${PANE * PANE}`,
  );
  const bytes = map.frames[map.frames.length - 1].surfaceBytes;

  await map.restyle();
  await settleFrames(40);
  const after = await imagery();
  assert.ok(
    after >= whole,
    `the parent still covers it after the swap: ${after} of ${PANE * PANE}`,
  );
  // …and no raster tile was drawn again on the way: a second surface for
  // any of them would have shown in what the surfaces hold.
  const frames = await map.seen();
  assert.ok(frames.length > 0, 'the switch painted');
  for (const frame of frames) {
    assert.ok(
      frame.stats.surfaceBytes <= bytes,
      `a raster tile was drawn again: ${frame.stats.surfaceBytes} bytes of surfaces, against ${bytes}`,
    );
  }
});

test('a raster tile that lands while a style switch is held goes up at once', async () => {
  // It belongs to neither style, so it cannot make a patchwork of them, and
  // nothing is gained by keeping it back for a swap that is waiting on
  // other tiles — here the vector tiles around it, in a style that takes
  // four hundred frames a tile, so the switch is held for as long as this
  // takes to look.
  let land: (() => void) | null = null;
  const map = await mountLooks({
    load: ({ z, x, y }) =>
      z === 3 && x === 4 && y === 3
        ? new Promise<TileData>((resolve) => {
            land = () => resolve(IMAGERY_TILE);
          })
        : undefined,
  });
  await map.restyle(slowLookStyle(NEW_LOOK, 400));
  await settleFrames(2);
  assert.ok(land, 'the raster tile is still loading');
  (land as () => void)();
  await settleFrames(2);
  assert.ok(
    map.frames[map.frames.length - 1].restyling,
    'the switch is still held',
  );
  assert.ok(
    (await countPixels(map.result.ctx, WHOLE, [...IMAGERY], 8)) > 0,
    'and the raster tile is on screen already',
  );

  for (let i = 0; i < 600; i++) {
    await settleFrames(1);
    if (!map.frames[map.frames.length - 1].restyling) break;
  }
  await settleFrames(4);
  assertOneLook(await map.seen());
  assertNewLook(await map.read());
  assert.ok(
    (await countPixels(map.result.ctx, WHOLE, [...IMAGERY], 8)) > 0,
    'and still there after the swap',
  );
});

test('eviction never takes the picture a style switch is holding up', async () => {
  // A restyle doubles what the view holds — the old picture and the new
  // one of every tile in it — so it is when a budget is most likely to be
  // exceeded. Eviction skips a tile the frame used, and every frame uses
  // every tile in view, the one-pixel frames of the redraw included.
  const map = await mountLooks({ surfaceBudget: 1 });
  const before = await map.read();
  await map.restyle();
  await settleFrames(40);
  const frames = await map.seen();
  const held = frames.filter((f) => f.stats.restyling);
  assert.ok(held.length > 0, 'the old style was held');
  for (const frame of held) {
    assert.deepEqual(frame.old, before.old, 'the old picture stayed whole');
  }
  assertNewLook(await map.read());
});

test('eviction never takes a piece covering a hole while a style switch holds it up', async () => {
  // After a zoom the old style is on screen as the level before, scaled:
  // pieces of other tiles, covering this level's holes. They are as much
  // in use as a tile's own picture, but a piece was only marked used by a
  // frame that drew it — and the redraw's one-pixel frames drew the one
  // under that pixel, so a tight budget evicted the rest, and the next
  // frame to repaint the pane showed holes.
  let land: (() => void) | null = null;
  const map = await mountLooks({
    surfaceBudget: 1,
    load: ({ z, x, y }) =>
      z === 4 && x === 8 && y === 8
        ? new Promise<TileData>((resolve) => {
            land = () => resolve(null);
          })
        : undefined,
  });
  await map.restyle();
  (map.ref.current as MapHandle).zoomTo(4);
  // Into the redraw's one-pixel frames, past the zoom's own repaint.
  for (let i = 0; i < 100; i++) {
    await settleFrames(1);
    const last = map.frames[map.frames.length - 1];
    if (last && last.restyling && last.rasterMs > 0 && !repainted(last)) break;
  }
  assert.ok(land, 'the last tile is still loading');
  // Its landing repaints the pane while the old style is still held.
  (land as () => void)();
  await settleFrames(40);
  const frames = await map.seen();
  const landing = frames.filter(
    (f) => f.stats.restyling && repainted(f.stats) && f.stats.tiles === 4,
  );
  assert.ok(
    landing.length > 0,
    'a frame repainted the pane while the old style was held',
  );
  for (const frame of landing) {
    assert.ok(
      frame.stats.fromAncestor === 3 &&
        frame.old.background <= (PANE * PANE) / 4,
      `every hole was still covered: ${describeLooks(frame)}, ${JSON.stringify(frame.stats)}`,
    );
  }
  assertOneLook(frames);
  assertNewLook(await map.read());
});

test('a level drawn before a style switch is not shown in the old style after it', async () => {
  // The swap replaces what is in view. A level visited before the switch
  // still held its pictures in the old style, and zooming back to it
  // showed them among tiles and a background already in the new one until
  // each was redrawn.
  const map = await mountLooks();
  (map.ref.current as MapHandle).zoomTo(4);
  await settleFrames(40);
  (map.ref.current as MapHandle).zoomTo(3);
  await settleFrames(40);
  await map.restyle();
  await settleFrames(40);
  assertNewLook(await map.read());

  map.watch();
  (map.ref.current as MapHandle).zoomTo(4);
  await settleFrames(40);
  assertOneLook(await map.seen());
  assertNewLook(await map.read());
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
    cache.ancestorWithSurface(source, { z: 12, x: 21, y: 29 }),
    null,
    'a rendering still being drawn is not a cover',
  );
  drawing.progress = -1;
  cache.promote(parent);
  assert.equal(
    cache.ancestorWithSurface(source, { z: 12, x: 21, y: 29 }),
    parent,
    'and a finished one is',
  );
  assert.equal(
    cache.ancestorWithSurface(source, { z: 12, x: 0, y: 0 }),
    null,
    'a tile that is not a descendant is not covered',
  );
  cache.destroy();
});

// A provider switch between sources with no `id`. The element names each
// `source-<index>`, so the one put in the first one's place is `source-0`
// too — and a cache that files tiles under that name hands it every tile
// the first had loaded, and every answer the first still had in flight
// when that lands.

test('a source in another’s place is handed none of its tiles, loaded or in flight', async () => {
  const loaded = { z: 3, x: 4, y: 4 };
  const inFlight = { z: 3, x: 5, y: 4 };
  const held: ((data: TileData) => void)[] = [];
  const first: MapSource = {
    load: ({ x }) =>
      x === loaded.x
        ? { kind: 'vector', data: tileBytes([]) }
        : new Promise<TileData>((resolve) => held.push(resolve)),
  };
  const asked: string[] = [];
  const second: MapSource = {
    load: ({ z, x, y }) => {
      asked.push(`${z}/${x}/${y}`);
      return {
        kind: 'raster',
        width: 1,
        height: 1,
        data: new Uint8Array([0, 0, 255, 255]),
      };
    },
  };
  const cache = new TileCache();
  cache.beginFrame();
  cache.want(first, 'source-0', loaded);
  cache.want(first, 'source-0', inFlight);
  // The switch: the element hands the cache the same name for the new one.
  cache.beginFrame();
  const tiles = [
    cache.want(second, 'source-0', loaded),
    cache.want(second, 'source-0', inFlight),
  ];
  // …and the first source's answer lands after it.
  for (const release of held) release({ kind: 'vector', data: tileBytes([]) });
  await Promise.resolve();
  assert.deepEqual(asked, ['3/4/4', '3/5/4'], 'the new source is asked');
  for (const tile of tiles) {
    assert.equal(tile.vector, null, 'no vector data under a raster source');
    assert.deepEqual([...(tile.raster?.data ?? [])], [0, 0, 255, 255]);
  }
  cache.destroy();
});

for (const [label, answer] of [
  ['loaded', (): TileData => ({ kind: 'vector', data: tileBytes([]) })],
  // Never settles: the switch lands while every tile is still in flight.
  ['in flight', (): Promise<TileData> => new Promise<TileData>(() => {})],
] as const) {
  test(`a map switched to another source with no id asks it for every tile — ${label}`, async () => {
    const recording = (
      asked: string[],
      load: () => TileData | Promise<TileData>,
    ): MapSource => ({
      tileSize: 512,
      load: ({ z, x, y }) => {
        asked.push(`${z}/${x}/${y}`);
        return load();
      },
    });
    const frames = async (): Promise<void> => {
      await act(async () => {});
      await act(async () => {});
    };
    const first: string[] = [];
    const second: string[] = [];
    const { rerender } = await mountMap({
      sources: [recording(first, answer)],
    });
    await frames();
    assert.ok(first.length > 0, 'the first source was asked for the view');

    const next = recording(second, () => ({
      kind: 'vector',
      data: tileBytes([]),
    }));
    await rerender({ sources: [next] });
    await frames();
    assert.deepEqual(
      [...second].sort(),
      [...first].sort(),
      'the new source is asked for the same view',
    );

    // What the cache keeps is the source, not the array around it: a
    // render that hands over the same object in a new array asks nothing.
    const before = second.length;
    await rerender({ sources: [next] });
    await frames();
    assert.equal(second.length, before);
  });
}

/** Every `console.warn` made while `run` runs. */
async function warningsDuring(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('a source made anew on every render is named in a warning, once', async () => {
  // The price of a cache per source object, said out loud. Each render's
  // source is an empty cache, so this map fetches its whole view on every
  // render and is blank until the tiles land — and nothing else would tell
  // the application why.
  const make = (): MapSource => ({
    tileSize: 512,
    load: () => ({ kind: 'vector', data: tileBytes([]) }),
  });
  const warnings = await warningsDuring(async () => {
    const { rerender } = await mountMap({ sources: [make()] });
    for (let i = 0; i < 6; i++) await rerender({ sources: [make()] });
  });
  assert.equal(warnings.length, 1, warnings.join(' | '));
  assert.match(warnings[0], /sources\[0\]/);
  assert.match(warnings[0], /useMemo/);
});

test('switching between sources the map has had is not taken for remaking one', async () => {
  // A layer switcher: three providers that look alike — no id, one
  // pyramid — made once and switched between. Only a source the map has
  // never had counts, so going back and forth never adds up to a warning.
  const providers = [0, 1, 2].map((): MapSource => ({
    tileSize: 256,
    load: () => null,
  }));
  const warnings = await warningsDuring(async () => {
    const { rerender } = await mountMap({ sources: [providers[0]] });
    for (const i of [1, 2, 0, 1, 2, 0]) {
      await rerender({ sources: [providers[i]] });
    }
    // …and a new array around the same object is no new source.
    await rerender({ sources: [providers[0]] });
  });
  assert.deepEqual(warnings, []);
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

test('a wheel notch is eased over the frames after it, not applied in one', async () => {
  const seen: number[] = [];
  const { handle, node } = await mountMap(
    { onCameraChange: (camera) => seen.push(camera.zoom) },
    DRIVEN,
  );
  // One notch is 0.384 of a level — six of the sixteenth the zoom is
  // quantized to — and applying it where it lands is the jump this eases.
  await userEvent.wheel(node, { deltaY: -1 });
  const first = handle.getCamera().zoom;
  // It moves under the notch that asked, because a wheel that waits for
  // the next frame to do anything reads as lag…
  assert.ok(first > 12, `the notch moved the map at once: ${first}`);
  // …and not all the way, because that is the jump.
  assert.ok(first < 12.375, `but not all of it at once: ${first}`);

  await settleFrames(20);
  const zoom = handle.getCamera().zoom;
  assert.ok(
    Math.abs(zoom - 12.375) < 1e-9,
    `the frames after it delivered the rest: ${zoom}`,
  );
  assert.ok(
    seen.length >= 4,
    `and took more than a step to do it: ${seen.join(' ')}`,
  );
});

test("a touchpad's fractions of a notch accumulate rather than round away", async () => {
  const { handle, node } = await mountMap({}, DRIVEN);
  // A twenty-fourth of a notch is 0.016 of a level, a quarter of the
  // sixteenth the camera is quantized to. Rounded against the camera as it
  // arrives it is nothing at all — and a slow two-finger scroll is a
  // stream of exactly this, so the map used to sit still through the whole
  // gesture. Kept in a target of its own, four of them are a step.
  await userEvent.wheel(node, { deltaY: -1 / 24, smooth: true });
  assert.equal(
    handle.getCamera().zoom,
    12,
    'one fraction is too small to show',
  );
  for (let i = 0; i < 7; i++) {
    await userEvent.wheel(node, { deltaY: -1 / 24, smooth: true });
  }
  // No frames in between: a measured scroll is already as smooth as the
  // hand that made it, so it is applied as it arrives rather than eased.
  const zoom = handle.getCamera().zoom;
  assert.ok(
    Math.abs(zoom - 12.125) < 1e-9,
    `but eight of them are two: ${zoom}`,
  );
});

test('a second notch lengthens the glide instead of restarting it', async () => {
  const { handle, node } = await mountMap({}, DRIVEN);
  await userEvent.wheel(node, { deltaY: -1 });
  await userEvent.wheel(node, { deltaY: -1 });
  await settleFrames(20);
  // Two notches are two notches, wherever the first had got to when the
  // second arrived: 12 + 2 × 0.384, on the grid.
  const zoom = handle.getCamera().zoom;
  assert.ok(Math.abs(zoom - 12.75) < 1e-9, `both notches landed: ${zoom}`);
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

// A tile grid and a projection are two ways of saying where the world is,
// and they have to agree — react-x11-components#65, where they did not.
//
// `tileCover` places tiles at `paneX + (ix - centerX * n) * size`, so the
// world its grid is laid out on is `n * size`. Everything else in the pane —
// markers, overlays, labels, `project()`, and the pixel shift a pan asks the
// blit for — is placed with `transform.world`. When a source's tiles were
// 256 px those two were a factor of two apart, and the visible result was a
// raster map whose tiles panned half as far as the pointer while the markers
// on top of them kept up.
test('the tile grid is laid out on the same world as the projection', () => {
  const transform = transformFor(
    { center: LONDON, zoom: 12.4 },
    { width: 800, height: 600 },
  );
  for (const tileSize of [256, 512]) {
    for (const zoom of [0, 3, 12.4, 14, 18.7]) {
      const t = transformFor(
        { center: LONDON, zoom },
        { width: 800, height: 600 },
      );
      const pyramid = pyramidOf({
        id: 's',
        tileSize,
        minZoom: 0,
        maxZoom: 22,
        load: () => null,
      });
      const cover = tileCover(t, pyramid);
      assert.ok(cover.length > 0, `${tileSize}px at z${zoom} covers nothing`);
      const n = tileCountAt(cover[0].tile.z);
      const gridWorld = n * cover[0].size;
      assert.ok(
        Math.abs(gridWorld - t.world) < 1e-6,
        `${tileSize}px tiles at zoom ${zoom}: the grid spans ${gridWorld} ` +
          `pixels of world where the projection spans ${t.world}`,
      );
    }
  }
  // …and concretely: a tile's own corner lands where projecting that
  // corner's mercator position puts it.
  for (const tileSize of [256, 512]) {
    const pyramid = pyramidOf({
      id: 's',
      tileSize,
      minZoom: 0,
      maxZoom: 22,
      load: () => null,
    });
    const entry = tileCover(transform, pyramid)[0];
    const n = tileCountAt(entry.tile.z);
    const corner = projectPoint(transform, {
      x: entry.tile.x / n,
      y: entry.tile.y / n,
    });
    assert.ok(
      Math.abs(corner.x - entry.x) < 1e-6 &&
        Math.abs(corner.y - entry.y) < 1e-6,
      `${tileSize}px: the cover puts the tile at (${entry.x}, ${entry.y}) ` +
        `and the projection at (${corner.x}, ${corner.y})`,
    );
  }
});

test('a 256px source is read one level deeper, at its natural size', () => {
  const t = transformFor(
    { center: LONDON, zoom: 12 },
    { width: 800, height: 600 },
  );
  const raster = pyramidOf({
    id: 'r',
    tileSize: 256,
    minZoom: 0,
    maxZoom: 19,
    load: () => null,
  });
  const vector = pyramidOf({
    id: 'v',
    tileSize: 512,
    minZoom: 0,
    maxZoom: 14,
    load: () => null,
  });
  assert.equal(zoomOffsetFor(t, raster), 1);
  assert.equal(zoomOffsetFor(t, vector), 0);
  const r = tileCover(t, raster)[0];
  const v = tileCover(t, vector)[0];
  // The same ground, a finer grid: a 256px source answers zoom 12 with its
  // level 13, and each image is drawn at 256 rather than stretched to 512.
  assert.equal(r.tile.z, 13);
  assert.equal(v.tile.z, 12);
  assert.equal(r.size, 256);
  assert.equal(v.size, 512);
});

// The tiles and everything drawn over them have to agree about where the
// *pane* is, as well as about where the world is.
//
// A tile's box is built in the window's logical pixels, `pane.x + entry.x`,
// and the composite used to add the pane's origin to it a second time — so
// every tile landed that far right of and below where the markers, labels
// and overlays put the same place. A constant offset on screen is a
// different distance on the ground at every zoom, so it was reported as a
// marker drifting across the map as it zoomed and staying attached as it
// panned, where the blit carries both together. Every other test here
// mounts the map at the window's origin, where the offset is zero; this one
// puts it under a header and beside a sidebar, the way an application does.

const DISC: Rgb = [255, 0, 255];

/** 256-pixel raster tiles, grey everywhere but a magenta disc on `place`. */
function discSource(place: LngLat): MapSource {
  const size = 256;
  return {
    id: 'disc',
    tileSize: size,
    minZoom: 0,
    maxZoom: 19,
    load: ({ z, x, y }) => {
      const data = new Uint8Array(size * size * 4);
      for (let i = 0; i < data.length; i += 4) {
        data.set([200, 200, 200, 255], i);
      }
      const n = 2 ** z;
      const px = (mercatorXFromLon(place.lon) * n - x) * size;
      const py = (mercatorYFromLat(place.lat) * n - y) * size;
      for (let j = Math.floor(py - 3); j <= Math.ceil(py + 3); j++) {
        for (let i = Math.floor(px - 3); i <= Math.ceil(px + 3); i++) {
          if (i < 0 || j < 0 || i >= size || j >= size) continue;
          if ((i + 0.5 - px) ** 2 + (j + 0.5 - py) ** 2 <= 9) {
            data.set([...DISC, 255], (j * size + i) * 4);
          }
        }
      }
      return { kind: 'raster', width: size, height: size, data };
    },
  };
}

/** The centroid of the window's pixels near `rgb`, in logical pixels. */
async function centroidOf(
  result: { ctx: unknown; windowNode: DrawnNode },
  rgb: Rgb,
  scale: number,
): Promise<{ x: number; y: number } | null> {
  const width = Math.round(result.windowNode.abs.width);
  const height = Math.round(result.windowNode.abs.height);
  const { data } = await (
    result.ctx as {
      getImageData(
        x: number,
        y: number,
        w: number,
        h: number,
      ): Promise<{ data: Uint8ClampedArray }>;
    }
  ).getImageData(0, 0, width, height);
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        Math.abs(data[i] - rgb[0]) <= 60 &&
        Math.abs(data[i + 1] - rgb[1]) <= 60 &&
        Math.abs(data[i + 2] - rgb[2]) <= 60
      ) {
        sx += x + 0.5;
        sy += y + 0.5;
        count++;
      }
    }
  }
  return count ? { x: sx / count / scale, y: sy / count / scale } : null;
}

for (const scale of [1, 2]) {
  test(`tiles land where markers do when the pane is not at the window's origin, at scale ${scale}`, async () => {
    const header = 37;
    const sidebar = 23;
    // Off the place, so the disc is not at the middle of the pane.
    const centre = { lon: LONDON.lon + 0.0006, lat: LONDON.lat - 0.0004 };
    const sources = [discSource(LONDON)];
    const defaultCamera = { center: centre, zoom: 12 };
    const ref = React.createRef<MapHandle>();
    const result = await renderX11(
      React.createElement(
        'window',
        { width: 480, height: 360 },
        React.createElement(
          'box',
          { style: { flexDirection: 'column', flexGrow: 1 } },
          React.createElement('box', { style: { height: header } }),
          React.createElement(
            'box',
            { style: { flexDirection: 'row', flexGrow: 1 } },
            React.createElement('box', { style: { width: sidebar } }),
            React.createElement(MapView, {
              ref,
              sources,
              defaultCamera,
              attribution: '',
              'data-testname': 'map',
            }),
          ),
        ),
      ),
      { backend: 'xserver', width: 480, height: 360, scale, wrap: false },
    );
    const handle = ref.current as MapHandle;
    // Device pixels, and the pane itself: the element has no padding or
    // border, so its box is its content box.
    const box = result.getByTestName('map').abs;
    const pane = { x: box.x / scale, y: box.y / scale };
    assert.deepEqual(
      pane,
      { x: sidebar, y: header },
      'the pane is where the fixture put it',
    );
    for (const zoom of [12, 13.5, 16]) {
      await act(async () => handle.setCamera({ center: centre, zoom }));
      // Eventually rather than at once: the frame that shows this zoom's
      // tiles comes after the one that moved the camera. Every frame of the
      // old code missed by the pane's origin, so none of them can pass.
      await waitFor(
        async () => {
          const disc = await centroidOf(result, DISC, scale);
          assert.ok(disc, `zoom ${zoom}: no disc on screen`);
          const at = handle.project(LONDON);
          const dx = disc.x - (pane.x + at.x);
          const dy = disc.y - (pane.y + at.y);
          assert.ok(
            Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5,
            `zoom ${zoom}: the tiles draw the place (${dx.toFixed(1)}, ` +
              `${dy.toFixed(1)}) logical pixels from where a marker on it ` +
              'is drawn',
          );
        },
        { timeout: 3000 },
      );
    }
  });
}

// A frame must not draw outside the rect it claimed.
//
// Everything in `paint` works in pane coordinates — a tile at its own box,
// the whole label layer, every overlay and marker, the attribution — so a
// partial frame that clips only to the pane puts most of that outside its
// claim. Core presents the claimed region, so those pixels reach the
// backing store without reaching the screen and the two disagree until
// something repaints the lot. The visible form is a stale strip that
// survives a theme switch and clears on an app switch, which is a long way
// from the code that causes it; this asserts the invariant instead.
test('a partial frame clips its drawing to what it claimed', async () => {
  const clips: ScreenRectLike[] = [];
  const damages: (ScreenRectLike | null)[] = [];
  const markers: MapMarker[] = [
    { id: 'a', position: LONDON, shape: 'circle', size: 12 },
  ];
  const ref = React.createRef<MapHandle>();
  // Referentially stable: a new function identity every render is itself a
  // prop change, and this test is about the smallest claim there is.
  const onFrame = (stats: MapFrameStats): void => {
    damages.push(stats.damage ? { ...stats.damage } : null);
  };
  // Stable identities throughout: only `markers` may differ between the two
  // renders, or a prop that is not self-damaged makes the commit claim the
  // whole node and there is no partial frame to test.
  const camera = { center: LONDON, zoom: 12 };
  const render = (at: LngLat) =>
    React.createElement(MapView, {
      ref,
      defaultCamera: camera,
      'data-testname': 'map',
      markers: [{ ...markers[0], position: at }],
      onFrame,
    });
  const result = await renderX11(render(LONDON), {
    backend: 'xserver',
    width: 400,
    height: 300,
  });
  await act(async () => {});

  // Record the clip each frame installs. `rect` is the call `paint` makes
  // immediately before `clip()`, so the last one before a clip is the
  // frame's own.
  // Recorded only while the map's own `paint` is running, and only the
  // first clip of each frame — the outermost one, which is the frame's.
  // Other nodes clip too (the window clips to itself) and so do the marker
  // and label passes inside, so neither the instance nor a bare prototype
  // patch says anything on its own.
  const proto = Object.getPrototypeOf(result.ctx as object) as {
    rect(x: number, y: number, w: number, h: number): void;
    clip(...args: unknown[]): void;
  };
  const realRect = proto.rect;
  const realClip = proto.clip;
  const nodeProto = MapViewNode.prototype as unknown as {
    paint(ctx: unknown): void;
  };
  const realPaint = nodeProto.paint;
  let painting = false;
  let first = true;
  let last: ScreenRectLike | null = null;
  nodeProto.paint = function patched(this: unknown, ctx: unknown) {
    painting = true;
    first = true;
    try {
      return realPaint.call(this, ctx);
    } finally {
      painting = false;
    }
  };
  proto.rect = function patched(this: unknown, x, y, w, h) {
    if (painting) last = { x, y, width: w, height: h };
    return realRect.call(this, x, y, w, h);
  };
  proto.clip = function patched(this: unknown, ...args) {
    if (painting && first && last) {
      clips.push(last);
      first = false;
    }
    last = null;
    return realClip.apply(this, args);
  };

  // Moving one marker claims only the marker's own rects — the smallest
  // real claim this component makes.
  damages.length = 0;
  clips.length = 0;
  await act(async () => {
    await result.rerender(render({ lon: LONDON.lon + 0.004, lat: LONDON.lat }));
  });
  await act(async () => {});

  proto.rect = realRect;
  proto.clip = realClip;
  nodeProto.paint = realPaint;

  const partial = damages.filter(
    (d): d is ScreenRectLike => d !== null && d.width < 400 && d.height < 300,
  );
  assert.ok(partial.length > 0, 'the marker move claimed a partial rect');
  // The map must install a clip that *is* its claim. Other nodes clip too —
  // the window clips to itself — so this looks for the map's own, and its
  // absence is the bug: before this, `paint` clipped to the whole pane and
  // drew the label layer, the overlays, the markers and the attribution
  // across all of it on a frame that had claimed a marker.
  for (const damage of partial) {
    const match = clips.find(
      (c) =>
        Math.abs(c.x - damage.x) <= 1 &&
        Math.abs(c.y - damage.y) <= 1 &&
        Math.abs(c.width - damage.width) <= 2 &&
        Math.abs(c.height - damage.height) <= 2,
    );
    assert.ok(
      match,
      `no clip matched the ${damage.width}x${damage.height} claim at ` +
        `${damage.x},${damage.y}; clips were ` +
        clips.map((c) => `${c.x},${c.y} ${c.width}x${c.height}`).join(' | '),
    );
  }
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
