// The map profile.
//
//   npx tsx scripts/bench/maps.ts                      # both backends
//   npx tsx scripts/bench/maps.ts --backend=x11
//   npx tsx scripts/bench/maps.ts --stage=raster --iterations=20
//
// Three stages, because they fail for different reasons and a single
// number hides which:
//
//  - **decode** — protobuf plus geometry, no drawing and no display. Pure
//    JavaScript, identical on every backend, and the floor under everything
//    else: a tile that takes 11 ms to decode cannot be rasterized in 8.
//  - **raster** — a tile's features drawn into its own `Surface`, which is
//    what the retained cache stores and what a zoom step costs. This is the
//    number that differs between backends: on X11 a fill is server-side
//    trapezoids over the wire, on the Cocoa backend it is CoreGraphics into
//    a bitmap in this process.
//  - **frame** — a whole `<mapview>` paint, plus a pan (which must blit)
//    and a zoom (which must not re-rasterize), through the real element.
//
// The corpus is real OSM vector tiles; `scripts/bench/tiles.ts` fetches it
// and describes what is in it.
import { readFile } from 'node:fs/promises';

import { createRoot } from 'react-x11';
import { Surface } from 'react-x11/ntk';

import { GeometryBuffer, parseTile } from '../../src/maps/mvt.js';
import type { VectorTile } from '../../src/maps/mvt.js';
import {
  DrawScratch,
  drawTileLayers,
  isMapCanvas,
  prepareStyle,
} from '../../src/maps/paint.js';
import type { DrawStats, PreparedStyle } from '../../src/maps/paint.js';
import { shortbreadStyle } from '../../src/maps/styles.js';
import { DEFAULT_TILE_SIZE, tileBounds } from '../../src/maps/proj.js';
import type { MapHandle, MapSource } from '../../src/maps/types.js';
import { cachedTiles } from './tiles.js';

type Backend = 'x11' | 'cocoa';

interface Sample {
  tile: string;
  z: number;
  kb: number;
  decodeMs: number;
  rasterMs: number;
  stats: DrawStats;
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** Median rather than mean: one GC pause in twenty iterations moves a mean
 *  and does not move a median, and the question being asked is what a
 *  frame usually costs. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/** The densest tile at each zoom the corpus has — the worst case, which is
 *  the only case worth a budget. */
async function worstPerZoom(): Promise<
  { z: number; tile: string; file: string; bytes: number }[]
> {
  const tiles = await cachedTiles();
  const best = new Map<
    number,
    { z: number; tile: string; file: string; bytes: number }
  >();
  for (const { tile, file, bytes } of tiles) {
    const current = best.get(tile.z);
    if (!current || bytes > current.bytes) {
      best.set(tile.z, {
        z: tile.z,
        tile: `${tile.z}/${tile.x}/${tile.y}`,
        file,
        bytes,
      });
    }
  }
  const only = arg('zoom', '');
  const wanted = only ? new Set(only.split(',').map(Number)) : null;
  return [...best.values()]
    .filter((entry) => !wanted || wanted.has(entry.z))
    .sort((a, b) => a.z - b.z);
}

function prepare(): PreparedStyle {
  // `--caps=butt` is an A/B probe, not a setting: round caps and joins make
  // a road network look like one, and the question is what they cost.
  const butt = arg('caps', 'round') === 'butt';
  const style = shortbreadStyle();
  return prepareStyle({
    layers: style.layers.map((layer) =>
      butt && layer.type === 'line'
        ? { ...layer, cap: 'butt' as const, join: 'miter' as const }
        : layer,
    ),
  });
}

async function stageDecode(iterations: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const buffer = new GeometryBuffer();
  for (const entry of await worstPerZoom()) {
    const bytes = new Uint8Array(await readFile(entry.file));
    const runs: number[] = [];
    for (let n = 0; n < iterations; n++) {
      const started = performance.now();
      const tile = parseTile(bytes);
      for (const name of tile.order) {
        const layer = tile.layers.get(name)!;
        if (layer.length === 0) continue;
        const cursor = layer.feature(0);
        for (let i = 0; i < layer.length; i++) {
          layer.seek(i, cursor);
          cursor.readGeometry(buffer);
        }
      }
      runs.push(performance.now() - started);
    }
    out.set(entry.z, median(runs));
  }
  return out;
}

async function stageRaster(
  backend: Backend,
  iterations: number,
  scale: number,
): Promise<Sample[]> {
  // `desktop: false` so nothing dials D-Bus: a bench should not be waiting
  // on a session bus, and appearance following would change the palette
  // mid-run on a machine that switches to dark at sunset.
  const root = await createRoot({ backend, desktop: false });
  const app = (root as unknown as { app: unknown }).app;
  // A probe, not a shipped setting: ntk decides per drawing whether to
  // rasterize coverage in JavaScript and upload it, or hand the server
  // trapezoids, and the heuristic is tuned for widget-sized shapes. A
  // tile-sized one with 200,000 edges lands on the local side of it, which
  // is a megabyte of coverage per batch. `--policy=server` forces the other
  // branch so the two can be compared.
  if (arg('policy', 'default') === 'server') {
    (app as { rasterPolicy?: unknown }).rasterPolicy = {
      maxArea: 0,
      bytesPerEdge: 0,
      maxBytes: 0,
    };
  }
  const prepared = prepare();
  const decode = await stageDecode(3);
  const size = Math.round(DEFAULT_TILE_SIZE * scale);
  const samples: Sample[] = [];
  const scratch = new DrawScratch();

  for (const entry of await worstPerZoom()) {
    const bytes = new Uint8Array(await readFile(entry.file));
    const tile: VectorTile = parseTile(bytes);
    const surface = new Surface(app, { width: size, height: size });
    const ctx = surface.getContext('2d');
    if (!isMapCanvas(ctx)) {
      throw new Error(`${backend}: the surface context has no path API`);
    }
    let stats: DrawStats = scratch.resetStats();
    const runs: number[] = [];
    for (let n = 0; n < iterations; n++) {
      surface.clear();
      stats = scratch.resetStats();
      const started = performance.now();
      drawTileLayers(
        ctx,
        tile,
        prepared,
        {
          ox: 0,
          oy: 0,
          span: size,
          pixelsPerLogical: scale,
          zoom: entry.z,
          tolerance: 0.65 * scale,
          minFeature: 1.5 * scale,
          batchVertices: Number(arg('batch', '12000')),
        },
        scratch,
      );
      runs.push(performance.now() - started);
    }
    (ctx as { destroy?(): void }).destroy?.();
    surface.destroy();
    samples.push({
      tile: entry.tile,
      z: entry.z,
      kb: entry.bytes / 1024,
      decodeMs: decode.get(entry.z) ?? 0,
      rasterMs: median(runs),
      stats,
    });
    process.stdout.write(
      `  ${entry.tile.padEnd(14)} decode ${(decode.get(entry.z) ?? 0)
        .toFixed(1)
        .padStart(6)} ms   raster ${median(runs).toFixed(1).padStart(6)} ms` +
        `  p95 ${p95(runs).toFixed(1).padStart(6)} ms` +
        `  ${String(stats.features).padStart(6)} feat` +
        `  ${String(stats.vertices).padStart(7)} vtx` +
        `  ${String(stats.decimated).padStart(7)} cut` +
        `  ${String(stats.culled).padStart(5)} cull` +
        `  ${String(stats.batches).padStart(4)} batch\n`,
    );
  }
  await (root as unknown as { unmount?(): Promise<void> }).unmount?.();
  return samples;
}

/**
 * Every style layer, timed alone.
 *
 * The stage that answers "which layer is the frame" rather than "how
 * expensive is the frame", which is the only question worth asking once a
 * total looks wrong. Each layer is drawn on its own into the same surface,
 * so the numbers add up to roughly the whole-tile figure and the outlier is
 * visible rather than inferred.
 */
async function stagePerLayer(
  backend: Backend,
  iterations: number,
  scale: number,
  batchVertices: number,
): Promise<void> {
  const root = await createRoot({ backend, desktop: false });
  const app = (root as unknown as { app: unknown }).app;
  const prepared = prepare();
  const size = Math.round(DEFAULT_TILE_SIZE * scale);
  const scratch = new DrawScratch();
  for (const entry of await worstPerZoom()) {
    const tile = parseTile(new Uint8Array(await readFile(entry.file)));
    const surface = new Surface(app, { width: size, height: size });
    const ctx = surface.getContext('2d');
    if (!isMapCanvas(ctx)) throw new Error('no path API');
    process.stdout.write(`  ${entry.tile}:\n`);
    const rows: { id: string; ms: number; stats: DrawStats }[] = [];
    for (const one of prepared.layers) {
      const runs: number[] = [];
      let stats = scratch.resetStats();
      for (let n = 0; n < iterations; n++) {
        surface.clear();
        stats = scratch.resetStats();
        const started = performance.now();
        drawTileLayers(
          ctx,
          tile,
          {
            layers: [one],
            runs: [{ sourceLayer: one.layer.sourceLayer, from: 0, to: 1 }],
          },
          {
            ox: 0,
            oy: 0,
            span: size,
            pixelsPerLogical: scale,
            zoom: entry.z,
            tolerance: 0.65 * scale,
            minFeature: 1.5 * scale,
            batchVertices,
          },
          scratch,
        );
        runs.push(performance.now() - started);
      }
      if (stats.features > 0 || median(runs) > 0.5) {
        rows.push({ id: one.layer.id, ms: median(runs), stats });
      }
    }
    rows.sort((a, b) => b.ms - a.ms);
    for (const row of rows.slice(0, 8)) {
      process.stdout.write(
        `    ${row.id.padEnd(20)} ${row.ms.toFixed(1).padStart(7)} ms` +
          `  ${String(row.stats.features).padStart(6)} feat` +
          `  ${String(row.stats.vertices).padStart(7)} vtx` +
          `  ${String(row.stats.batches).padStart(4)} batch\n`,
      );
    }
    (ctx as { destroy?(): void }).destroy?.();
    surface.destroy();
  }
  await (root as unknown as { unmount?(): Promise<void> }).unmount?.();
}

/**
 * A whole frame, through the real element.
 *
 * The stage the other two exist to justify. `raster` says what a tile costs
 * to draw; this says what that costs a *frame*, which is a different
 * question because the architecture is built so that almost no frame draws
 * a tile: a pan blits and composites, a fractional zoom composites, and
 * rasterization is budgeted and resumable.
 *
 * Three phases, and the numbers to look at are different in each:
 *
 *  - **settle** — a cold map filling in. `rasterMs` should be near the
 *    budget and `pending` should fall to zero.
 *  - **pan** — sixty drag steps. `rasterMs` must be **zero**: a pan that
 *    rasterizes is the bug this whole design exists to avoid.
 *  - **zoom** — eight quantized steps within one level. Also zero, until a
 *    step crosses an integer zoom.
 */
async function stageFrame(
  backend: Backend,
  scale: number,
  batchVertices: number,
): Promise<void> {
  const React = await import('react');
  const { createRoot } = await import('react-x11');
  // Renamed on the way in: this function also wants the built-in `Map`,
  // which is the one real cost of the component being called that.
  const { Map: MapComponent } = await import('../../src/maps/index.js');
  const { shortbreadStyle: styleOf } = await import('../../src/maps/styles.js');
  const cached = await cachedTiles();
  if (cached.length === 0) {
    process.stdout.write('  no corpus — run scripts/bench/tiles.ts first\n');
    return;
  }
  // Serve the corpus from memory, so the profile measures drawing rather
  // than a disk or a network.
  const bytes = new Map<string, Uint8Array>();
  for (const { tile, file } of cached) {
    bytes.set(
      `${tile.z}/${tile.x}/${tile.y}`,
      new Uint8Array(await readFile(file)),
    );
  }
  // The densest place the corpus has a z12 block for: a real city viewport.
  const dense = cached
    .filter((t) => t.tile.z === 12)
    .sort((a, b) => b.bytes - a.bytes)[0];
  const centre = tileBoundsCentre(dense.tile);

  const frames: {
    rasterMs: number;
    drawMs: number;
    pending: number;
    ready: number;
  }[] = [];
  const handle: { current: MapHandle | null } = { current: null };
  const source: MapSource = {
    id: 'corpus',
    minZoom: 0,
    maxZoom: 14,
    tileSize: 512,
    load: ({ z, x, y }) => {
      const found = bytes.get(`${z}/${x}/${y}`);
      return found ? { kind: 'vector', data: found } : null;
    },
  };
  const root = await createRoot({ backend, desktop: false, scale });
  root.render(
    React.createElement(
      'window',
      { width: 1200, height: 800, title: 'maps bench' },
      React.createElement(MapComponent, {
        ref: handle,
        sources: [source],
        mapStyle: styleOf(),
        defaultCamera: { center: centre, zoom: 12 },
        batchVertices,
        onFrame: (stats) =>
          frames.push({
            rasterMs: stats.rasterMs,
            drawMs: stats.drawMs,
            pending: stats.pending,
            ready: stats.ready,
          }),
        style: { flexGrow: 1 },
      }),
    ),
  );

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Phase 1: let it settle.
  const settleStart = performance.now();
  for (let i = 0; i < 200; i++) {
    await wait(16);
    if (frames.length > 2 && frames[frames.length - 1].pending === 0) break;
  }
  const settleMs = performance.now() - settleStart;
  const settleFrames = frames.splice(0, frames.length);

  // Phase 2: sixty pan steps, as a drag delivers them.
  await wait(400); // past the gesture settle window
  frames.length = 0;
  for (let i = 0; i < 60; i++) {
    handle.current?.panBy(7, 3);
    await wait(8);
  }
  await wait(50);
  const panFrames = frames.splice(0, frames.length);

  // Phase 3: eight zoom steps inside one level.
  await wait(400);
  frames.length = 0;
  for (let i = 0; i < 8; i++) {
    handle.current?.zoomIn(0.1);
    await wait(16);
  }
  await wait(50);
  const zoomFrames = frames.splice(0, frames.length);

  const report = (name: string, list: typeof frames): void => {
    if (list.length === 0) {
      process.stdout.write(`  ${name.padEnd(8)} no frames\n`);
      return;
    }
    const draw = list.map((f) => f.drawMs);
    const raster = list.map((f) => f.rasterMs);
    process.stdout.write(
      `  ${name.padEnd(8)} ${String(list.length).padStart(3)} frames` +
        `   draw ${median(draw).toFixed(1).padStart(5)} / p95 ${p95(draw).toFixed(1).padStart(5)} ms` +
        `   raster ${median(raster).toFixed(1).padStart(6)} / max ${Math.max(
          ...raster,
        )
          .toFixed(1)
          .padStart(6)} ms\n`,
    );
  };
  process.stdout.write(
    `  settled in ${settleMs.toFixed(0)} ms over ${settleFrames.length} frames\n`,
  );
  report('settle', settleFrames);
  report('pan', panFrames);
  report('zoom', zoomFrames);
  await (root as unknown as { unmount?(): Promise<void> }).unmount?.();
}

/** The middle of a tile, as a camera centre. */
function tileBoundsCentre(tile: { z: number; x: number; y: number }): {
  lon: number;
  lat: number;
} {
  const bounds = tileBounds(tile);
  return {
    lon: (bounds.west + bounds.east) / 2,
    lat: (bounds.north + bounds.south) / 2,
  };
}

async function main(): Promise<void> {
  const which = arg('backend', process.platform === 'darwin' ? 'both' : 'x11');
  const iterations = Number(arg('iterations', '9'));
  const scale = Number(arg('scale', '2'));
  const stages = arg('stage', 'decode,raster').split(',');
  const backends: Backend[] =
    which === 'both' ? ['x11', 'cocoa'] : [which as Backend];

  if (stages.includes('decode')) {
    process.stdout.write(`decode (no display), median of 3:\n`);
    const decode = await stageDecode(3);
    for (const [z, ms] of [...decode].sort((a, b) => a[0] - b[0])) {
      process.stdout.write(
        `  z${String(z).padStart(2)}  ${ms.toFixed(1).padStart(6)} ms\n`,
      );
    }
  }

  if (stages.includes('frame')) {
    for (const backend of backends) {
      process.stdout.write(
        `\nframes on ${backend}, 1200x800 at scale ${scale}:\n`,
      );
      try {
        await stageFrame(
          backend,
          scale,
          Number(arg('batch', backend === 'cocoa' ? '512' : '12000')),
        );
      } catch (error) {
        process.stdout.write(`  unavailable: ${String(error)}\n`);
      }
    }
  }

  if (stages.includes('perlayer')) {
    for (const backend of backends) {
      process.stdout.write(`\nper layer on ${backend}:\n`);
      try {
        await stagePerLayer(
          backend,
          iterations,
          scale,
          Number(arg('batch', '12000')),
        );
      } catch (error) {
        process.stdout.write(`  unavailable: ${String(error)}\n`);
      }
    }
  }

  if (stages.includes('raster')) {
    for (const backend of backends) {
      process.stdout.write(
        `\nraster on ${backend}, ${DEFAULT_TILE_SIZE}px tile at scale ${scale} ` +
          `(${Math.round(DEFAULT_TILE_SIZE * scale)}px surface), median of ${iterations}:\n`,
      );
      try {
        await stageRaster(backend, iterations, scale);
      } catch (error) {
        process.stdout.write(`  unavailable: ${String(error)}\n`);
      }
    }
  }
}

await main();
