// The bench corpus: real vector tiles, cached on this machine.
//
// The profiles in `maps.ts` are only worth reading if the tiles under them
// are real. A synthetic tile can be given any feature count, but not the
// *shape* of real data — the 4,000-vertex coastline beside the 6-vertex
// building, the label density of a city centre, the fact that half of a
// dense tile is one `landuse` layer nobody looks at — and those are what
// the rasterizer's cost is actually made of.
//
// So the corpus is downloaded once and kept outside the repository. The
// source is OpenStreetMap's own vector tiles (the Shortbread schema, on
// `vector.openstreetmap.org`): open data, open licence, no API key, and the
// schema this component ships a default style for. Nothing here runs in CI
// and nothing here is imported by `src/`.
//
//   npx tsx scripts/bench/tiles.ts            # fetch what is missing
//   npx tsx scripts/bench/tiles.ts --list     # what is cached, and how big
//
// The cache lives under the OS temp directory so it can never be committed
// by accident; `REACT_X11_MAPS_TILE_CACHE` moves it somewhere durable.
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GeomType, GeometryBuffer, parseTile } from '../../src/maps/mvt.js';
import { tileOf, wrapTileX } from '../../src/maps/proj.js';
import type { TileId } from '../../src/maps/proj.js';

/** Where OSM serves the Shortbread pyramid. z14 is the deepest level it
 *  cuts; everything past that is overzoom, which is the renderer's job. */
export const OSM_VECTOR_URL =
  'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt';
export const OSM_MAX_ZOOM = 14;

/** Identifying the client is the first line of OSM's tile usage policy, and
 *  a shared default user-agent is what gets a whole runtime blocked. */
const USER_AGENT =
  'react-x11-components-maps-bench/0.1 (+https://github.com/sidorares/react-x11-components)';

export function cacheDir(): string {
  return (
    process.env.REACT_X11_MAPS_TILE_CACHE ??
    path.join(os.tmpdir(), 'react-x11-maps-tiles', 'shortbread_v1')
  );
}

export function cachePath(tile: TileId): string {
  return path.join(cacheDir(), String(tile.z), String(tile.x), `${tile.y}.mvt`);
}

/**
 * Where the corpus is sampled.
 *
 * Three of the densest city centres on the planet and one control. The
 * control matters as much as the cities: a renderer whose empty-ocean frame
 * is not almost free has a fixed cost hiding in it, and that cost is what
 * dominates a whole-country view where most tiles look like this one.
 */
export const PLACES = [
  {
    id: 'manhattan',
    name: 'Manhattan (Times Square)',
    lon: -73.9855,
    lat: 40.758,
  },
  {
    id: 'london',
    name: 'Central London (Trafalgar Sq)',
    lon: -0.1281,
    lat: 51.508,
  },
  { id: 'tokyo', name: 'Tokyo (Shinjuku Station)', lon: 139.7004, lat: 35.69 },
  { id: 'pacific', name: 'Mid-Pacific (control)', lon: -160, lat: 0 },
] as const;

/**
 * How wide a block to take at each zoom, in tiles.
 *
 * A single tile answers "how expensive is this data"; a block answers "how
 * expensive is a frame", which needs everything a real pane covers plus the
 * ring the cover keeps warm. The deep levels get the block because that is
 * where a pane sees several tiles at once; z0-z8 get one tile because at
 * those zooms one tile is most of the world.
 */
export const ZOOM_BLOCKS: Record<number, number> = {
  0: 1,
  2: 1,
  4: 1,
  6: 1,
  8: 1,
  10: 2,
  12: 3,
  14: 3,
};

/** Every tile the corpus wants, deduplicated. */
export function corpus(): TileId[] {
  const seen = new Set<string>();
  const out: TileId[] = [];
  for (const place of PLACES) {
    for (const [zStr, block] of Object.entries(ZOOM_BLOCKS)) {
      const z = Number(zStr);
      const centre = tileOf({ lon: place.lon, lat: place.lat }, z);
      const half = Math.floor(block / 2);
      for (let dx = -half; dx < block - half; dx++) {
        for (let dy = -half; dy < block - half; dy++) {
          const n = 2 ** z;
          const y = centre.y + dy;
          if (y < 0 || y >= n) continue;
          const tile = { z, x: wrapTileX(centre.x + dx, z), y };
          const key = `${tile.z}/${tile.x}/${tile.y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(tile);
        }
      }
    }
  }
  return out;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * One tile, from the cache or from the network.
 *
 * Stored **ungzipped**: the endpoint serves `Content-Encoding: gzip` and
 * some paths hand back a body that is gzip again inside, so the magic is
 * checked and stripped here rather than in the decoder — a cache whose
 * entries are all ready-to-parse protobuf is one the bench can read with no
 * branch in the hot loop.
 */
export async function fetchTile(
  tile: TileId,
  options?: { retries?: number; timeoutMs?: number },
): Promise<Uint8Array> {
  const file = cachePath(tile);
  if (await exists(file)) return new Uint8Array(await readFile(file));

  const url = OSM_VECTOR_URL.replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
  const retries = options?.retries ?? 3;
  const timeoutMs = options?.timeoutMs ?? 60_000;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // The endpoint answers a cold cache miss with a Varnish "first byte
      // timeout" rather than a 5xx that means anything; the second ask
      // usually hits the tile the first one warmed.
      await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
    }
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/x-protobuf' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return new Uint8Array(0); // no data here
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        bytes = new Uint8Array(gunzipSync(bytes));
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${tile.z}/${tile.x}/${tile.y}: ${String(lastError)}`);
}

/** The corpus, fetched with a bounded number of requests in flight. */
export async function fetchCorpus(concurrency = 4): Promise<void> {
  const wanted = corpus();
  let done = 0;
  let bytes = 0;
  let failed = 0;
  const queue = [...wanted];
  const worker = async (): Promise<void> => {
    for (;;) {
      const tile = queue.shift();
      if (!tile) return;
      try {
        const data = await fetchTile(tile);
        bytes += data.length;
      } catch (error) {
        failed++;
        process.stderr.write(`  ! ${String(error)}\n`);
      }
      done++;
      if (done % 10 === 0 || done === wanted.length) {
        process.stdout.write(
          `  ${done}/${wanted.length} tiles, ${(bytes / 1e6).toFixed(1)} MB\n`,
        );
      }
    }
  };
  process.stdout.write(`corpus: ${wanted.length} tiles -> ${cacheDir()}\n`);
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write(
    `done: ${done - failed} cached, ${failed} failed, ${(bytes / 1e6).toFixed(1)} MB\n`,
  );
}

/** Every cached tile, for a bench that wants to run offline. */
export async function cachedTiles(): Promise<
  { tile: TileId; file: string; bytes: number }[]
> {
  const root = cacheDir();
  const out: { tile: TileId; file: string; bytes: number }[] = [];
  let zs: string[];
  try {
    zs = await readdir(root);
  } catch {
    return out;
  }
  for (const z of zs) {
    for (const x of await readdir(path.join(root, z))) {
      for (const name of await readdir(path.join(root, z, x))) {
        if (!name.endsWith('.mvt')) continue;
        const file = path.join(root, z, x, name);
        out.push({
          tile: { z: Number(z), x: Number(x), y: Number(name.slice(0, -4)) },
          file,
          bytes: (await stat(file)).size,
        });
      }
    }
  }
  out.sort(
    (a, b) => a.tile.z - b.tile.z || a.tile.x - b.tile.x || a.tile.y - b.tile.y,
  );
  return out;
}

/**
 * What the corpus is made of, and how fast it decodes.
 *
 * The table this prints is the input to every judgement about the
 * rasterizer: "12,000 features and 180,000 vertices in a z14 city tile" is
 * what makes a 20 ms rasterization either fine or a bug. It also
 * double-checks the decoder against real data on the way past — a polygon
 * with no exterior ring, an empty geometry, an extent that is not 4096 —
 * because those are the shapes a hand-written fixture never has.
 */
export async function corpusStats(): Promise<void> {
  const tiles = await cachedTiles();
  if (tiles.length === 0) {
    process.stdout.write(`no tiles in ${cacheDir()} — run without --stats\n`);
    return;
  }
  const buffer = new GeometryBuffer();
  const byZoom = new Map<
    number,
    {
      tiles: number;
      features: number;
      vertices: number;
      bytes: number;
      layers: Set<string>;
    }
  >();
  let features = 0;
  let vertices = 0;
  /** Extent is per **layer**, not per tile, and real tiles use that: OSM's
   *  Shortbread cuts `streets`, `land` and `water_polygons` at 2048 and the
   *  rest at 4096. A renderer that reads it once per tile draws half the
   *  layers at twice their size. */
  const extents = new Map<number, Set<string>>();
  const emptyGeometry: string[] = [];
  const noExterior: string[] = [];
  const started = performance.now();
  for (const { tile, file, bytes } of tiles) {
    const data = new Uint8Array(await readFile(file));
    const parsed = parseTile(data);
    let tileFeatures = 0;
    let tileVertices = 0;
    const layers = new Set<string>();
    for (const name of parsed.order) {
      const layer = parsed.layers.get(name)!;
      layers.add(name);
      const seen = extents.get(layer.extent) ?? new Set<string>();
      seen.add(name);
      extents.set(layer.extent, seen);
      if (layer.length === 0) continue;
      const cursor = layer.feature(0);
      for (let i = 0; i < layer.length; i++) {
        layer.seek(i, cursor);
        const geometry = cursor.readGeometry(buffer);
        tileFeatures++;
        tileVertices += geometry.points;
        if (geometry.points === 0) {
          if (emptyGeometry.length < 5)
            emptyGeometry.push(`${name} in ${tile.z}/${tile.x}/${tile.y}`);
        } else if (cursor.type === GeomType.Polygon) {
          let exterior = 0;
          for (let k = 0; k < geometry.parts; k++) {
            if (geometry.areas[k] > 0) exterior++;
          }
          if (exterior === 0 && noExterior.length < 5) {
            noExterior.push(`${name} in ${tile.z}/${tile.x}/${tile.y}`);
          }
        }
      }
    }
    features += tileFeatures;
    vertices += tileVertices;
    const row = byZoom.get(tile.z) ?? {
      tiles: 0,
      features: 0,
      vertices: 0,
      bytes: 0,
      layers: new Set<string>(),
    };
    row.tiles++;
    row.features += tileFeatures;
    row.vertices += tileVertices;
    row.bytes += bytes;
    for (const name of layers) row.layers.add(name);
    byZoom.set(tile.z, row);
  }
  const ms = performance.now() - started;
  process.stdout.write(
    `${tiles.length} tiles, ${features} features, ${vertices} vertices\n` +
      `decode + geometry: ${ms.toFixed(0)} ms, ` +
      `${(vertices / (ms / 1000) / 1e6).toFixed(2)} M vertices/s\n`,
  );
  for (const extent of [...extents.keys()].sort((a, b) => a - b)) {
    const names = [...extents.get(extent)!].sort();
    process.stdout.write(`extent ${extent}: ${names.join(', ')}\n`);
  }
  if (emptyGeometry.length > 0) {
    process.stdout.write(`empty geometry: ${emptyGeometry.join('; ')}\n`);
  }
  if (noExterior.length > 0) {
    process.stdout.write(
      `polygon with no exterior ring: ${noExterior.join('; ')}\n`,
    );
  }
  process.stdout.write(
    '\n z  tiles  features/tile  vertices/tile  KB/tile  layers\n',
  );
  for (const z of [...byZoom.keys()].sort((a, b) => a - b)) {
    const row = byZoom.get(z)!;
    process.stdout.write(
      `${String(z).padStart(2)}  ${String(row.tiles).padStart(5)}  ` +
        `${(row.features / row.tiles).toFixed(0).padStart(13)}  ` +
        `${(row.vertices / row.tiles).toFixed(0).padStart(13)}  ` +
        `${(row.bytes / row.tiles / 1024).toFixed(0).padStart(7)}  ` +
        `${row.layers.size}\n`,
    );
  }
  // The heaviest tile, by layer: which layers a style is actually paying
  // for, and the answer is usually not the ones anybody looks at.
  const heaviest = [...tiles].sort((a, b) => b.bytes - a.bytes)[0];
  const parsed = parseTile(new Uint8Array(await readFile(heaviest.file)));
  const rows: { name: string; features: number; vertices: number }[] = [];
  for (const name of parsed.order) {
    const layer = parsed.layers.get(name)!;
    let points = 0;
    if (layer.length > 0) {
      const cursor = layer.feature(0);
      for (let i = 0; i < layer.length; i++) {
        layer.seek(i, cursor);
        points += cursor.readGeometry(buffer).points;
      }
    }
    rows.push({ name, features: layer.length, vertices: points });
  }
  rows.sort((a, b) => b.vertices - a.vertices);
  const t = heaviest.tile;
  process.stdout.write(
    `\nheaviest tile ${t.z}/${t.x}/${t.y}, ${(heaviest.bytes / 1024).toFixed(0)} KB:\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `  ${row.name.padEnd(26)}${String(row.features).padStart(6)} features` +
        `${String(row.vertices).padStart(8)} vertices\n`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  if (process.argv.includes('--stats')) {
    await corpusStats();
  } else if (process.argv.includes('--list')) {
    const tiles = await cachedTiles();
    let total = 0;
    for (const { tile, bytes } of tiles) {
      total += bytes;
      process.stdout.write(
        `  ${tile.z}/${tile.x}/${tile.y}  ${(bytes / 1024).toFixed(0)} KB\n`,
      );
    }
    process.stdout.write(
      `${tiles.length} tiles, ${(total / 1e6).toFixed(1)} MB in ${cacheDir()}\n`,
    );
  } else {
    await fetchCorpus();
  }
}
