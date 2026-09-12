// The GL map profile: the same tiles, drawn two ways.
//
//   npx tsx scripts/bench/maps-gl.ts                        # every stage
//   npx tsx scripts/bench/maps-gl.ts --stage=tile
//   npx tsx scripts/bench/maps-gl.ts --stage=view --view=tokyo-z10 --frames=240
//   npx tsx scripts/bench/maps-gl.ts --cpu=cocoa,x11        # the CPU side on both
//   npx tsx scripts/bench/maps-gl.ts --aa=off --fill=evenodd --offscreen=on
//   npx tsx scripts/bench/maps-gl.ts --json=out.json        # raw numbers too
//
// Three stages, and what each one answers:
//
//  - **tile** — one tile, the densest and the sparsest at each zoom, drawn
//    at 512 logical pixels on a scale-2 display: the retained renderer's
//    rasterization into a 1024-pixel surface against the GL renderer's
//    one-time bucket build and upload and then its per-frame draw.
//  - **view** — a 1200×800 pane at scale 2 (2400×1600 device pixels),
//    panned in a circle and zoomed across two levels and back, **every frame
//    drawn from geometry**: no bitmap cache, the target a double buffer
//    would be. Each frame ends in `glFinish`, so a number is the whole of it
//    — this thread issuing the frame and the GPU drawing it. The frames run
//    back to back rather than paced, so the number is the frame's cost, not
//    the display's rate; 20 ms is the 50 Hz line.
//  - **cpu-view** — the same frames drawn the retained renderer's way, but
//    uncached: every visible tile rasterized straight into a pane-sized
//    surface, which is what "every state drawn at 50 Hz" would ask of it.
//    A sample of the frames, because each is a few hundred milliseconds.
//
// The GL context is x11-dri's CGL one with an IOSurface render target, so
// this needs macOS and nothing else — no window, no X server. The corpus is
// `scripts/bench/tiles.ts`'s.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { createRoot } from 'react-x11';
import { Surface } from 'react-x11/ntk';

import { parseTile } from '../../src/maps/mvt.js';
import type { VectorTile } from '../../src/maps/mvt.js';
import {
  DrawScratch,
  drawTileLayers,
  isMapCanvas,
  prepareStyle,
} from '../../src/maps/paint.js';
import type { MapCanvas, PreparedStyle } from '../../src/maps/paint.js';
import { shortbreadStyle } from '../../src/maps/styles.js';
import {
  tileCover,
  transformFor,
  unprojectPoint,
} from '../../src/maps/proj.js';
import type { LngLat, MapCamera, TileId } from '../../src/maps/proj.js';
import { buildTileBuckets } from '../../src/maps/gl/buckets.js';
import type { GlTileData } from '../../src/maps/gl/buckets.js';
import { GlMapRenderer } from '../../src/maps/gl/renderer.js';
import type { GlRenderStats } from '../../src/maps/gl/renderer.js';
import { renderCover } from '../../src/maps/gl/cover.js';
import { cachedTiles } from './tiles.js';

type Dri = typeof import('x11-dri');

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

const fmt = (ms: number, width = 6): string =>
  ms.toFixed(ms < 10 ? 2 : 1).padStart(width);
const key = (t: TileId): string => `${t.z}/${t.x}/${t.y}`;

const SCALE = Number(arg('scale', '2'));
const PANE = { width: 1200, height: 800 };
const W = PANE.width * SCALE;
const H = PANE.height * SCALE;
const PYRAMID = { minZoom: 0, maxZoom: 14, tileSize: 512 };
const STYLE = shortbreadStyle();

const PLACES: Record<string, LngLat> = {
  london: { lon: -0.1281, lat: 51.508 },
  manhattan: { lon: -73.9855, lat: 40.758 },
  tokyo: { lon: 139.7004, lat: 35.69 },
  pacific: { lon: -160, lat: 0 },
  world: { lon: 10, lat: 30 },
};

/** Dense and sparse, at the zooms the corpus has data for. */
const VIEWS: {
  id: string;
  place: string;
  zoom: number;
  kind: 'dense' | 'sparse';
}[] = [
  { id: 'london-z12', place: 'london', zoom: 12.3, kind: 'dense' },
  { id: 'london-z14', place: 'london', zoom: 14.4, kind: 'dense' },
  { id: 'manhattan-z14', place: 'manhattan', zoom: 14.2, kind: 'dense' },
  { id: 'tokyo-z12', place: 'tokyo', zoom: 12.5, kind: 'dense' },
  { id: 'tokyo-z10', place: 'tokyo', zoom: 10.5, kind: 'dense' },
  { id: 'london-z8', place: 'london', zoom: 8.6, kind: 'dense' },
  { id: 'pacific-z10', place: 'pacific', zoom: 10.5, kind: 'sparse' },
  { id: 'world-z2', place: 'world', zoom: 2.3, kind: 'sparse' },
];

interface Corpus {
  parsed: Map<string, VectorTile>;
  buckets: Map<string, GlTileData>;
  bytes: Map<string, number>;
  buildMs: Map<string, number>;
}

async function loadCorpus(prepared: PreparedStyle): Promise<Corpus> {
  const corpus: Corpus = {
    parsed: new Map(),
    buckets: new Map(),
    bytes: new Map(),
    buildMs: new Map(),
  };
  for (const { tile, file, bytes } of await cachedTiles()) {
    const data = new Uint8Array(await readFile(file));
    const k = key(tile);
    corpus.bytes.set(k, bytes);
    const parsed = parseTile(data);
    corpus.parsed.set(k, parsed);
    const runs: number[] = [];
    let built: GlTileData | null = null;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      built = buildTileBuckets(parseTile(data), prepared);
      runs.push(performance.now() - started);
    }
    corpus.buckets.set(k, built!);
    corpus.buildMs.set(k, median(runs));
  }
  return corpus;
}

/** The corpus as the cover sees it: a tile outside it has no data, so its
 *  ancestor stands in — which is also what a source with odd levels missing
 *  looks like, and the corpus cuts only even ones. */
function lookupOf(corpus: Corpus): { get(t: TileId): GlTileData | null } {
  return { get: (t) => corpus.buckets.get(key(t)) ?? null };
}

interface HeadlessGl {
  gl: ReturnType<typeof glOf>;
  bind(): void;
  destroy(): void;
}

function glOf(dri: Dri): Dri['gl'] {
  return dri.gl;
}

function headlessGl(dri: Dri, width: number, height: number): HeadlessGl {
  if (process.platform !== 'darwin') {
    throw new Error('the GL stages use a CGL context and need macOS');
  }
  const ctx = new dri.apple.Context({
    alphaSize: 8,
    depthSize: 24,
    stencilSize: 8,
    doubleBuffer: false,
    profile: 'core',
  });
  ctx.makeCurrent();
  const target = ctx.createTarget(width, height, { depth: true });
  ctx.bindTarget(target);
  return {
    gl: dri.gl,
    // Every GL stage rebinds before it draws: a Cocoa 2d surface drawn in
    // between leaves another context current.
    bind: () => {
      ctx.makeCurrent();
      ctx.bindTarget(target);
    },
    destroy: () => {
      target.destroy();
      ctx.destroy();
    },
  };
}

// --- tile ---------------------------------------------------------------------

function pickTiles(
  corpus: Corpus,
): { k: string; z: number; kind: 'dense' | 'sparse' }[] {
  const byZoom = new Map<number, string[]>();
  for (const k of corpus.buckets.keys()) {
    const z = Number(k.split('/')[0]);
    byZoom.set(z, [...(byZoom.get(z) ?? []), k]);
  }
  const out: { k: string; z: number; kind: 'dense' | 'sparse' }[] = [];
  for (const z of [...byZoom.keys()].sort((a, b) => a - b)) {
    const list = byZoom
      .get(z)!
      .sort((a, b) => corpus.bytes.get(b)! - corpus.bytes.get(a)!);
    out.push({ k: list[0], z, kind: 'dense' });
    if (list.length > 1)
      out.push({ k: list[list.length - 1], z, kind: 'sparse' });
  }
  return out;
}

async function stageTile(
  dri: Dri,
  corpus: Corpus,
  prepared: PreparedStyle,
  cpuBackends: string[],
  results: Record<string, unknown>,
): Promise<void> {
  const size = 512 * SCALE;
  const tiles = pickTiles(corpus);
  const head = headlessGl(dri, size, size);
  const renderer = new GlMapRenderer(head.gl, options());
  const rows: Record<string, unknown>[] = [];

  // The GL side first, all tiles, so the CPU backends can take their time.
  const glRows = new Map<
    string,
    { upload: number; draw: number; stats: GlRenderStats }
  >();
  // A frame thrown away first: the first draw with each program pays for
  // the driver building its pipeline, and that belongs to no tile.
  {
    head.bind();
    const warm = corpus.buckets.get(tiles[0].k)!;
    const whole = { x: 0, y: 0, width: size, height: size };
    renderer.render({
      width: size,
      height: size,
      zoom: tiles[0].z,
      scale: SCALE,
      style: prepared,
      background: STYLE.background,
      sources: [[{ data: warm, x: 0, y: 0, size, clip: whole }]],
    });
    head.gl.finish();
    renderer.release(warm);
  }
  for (const { k, z } of tiles) {
    head.bind();
    const data = corpus.buckets.get(k)!;
    const frame = {
      width: size,
      height: size,
      zoom: z,
      scale: SCALE,
      style: prepared,
      background: STYLE.background,
      sources: [
        [
          {
            data,
            x: 0,
            y: 0,
            size,
            clip: { x: 0, y: 0, width: size, height: size },
          },
        ],
      ],
    };
    renderer.release(data);
    head.gl.finish();
    let started = performance.now();
    renderer.render(frame);
    head.gl.finish();
    const firstFrame = performance.now() - started;
    const runs: number[] = [];
    let stats: GlRenderStats | null = null;
    for (let i = 0; i < 30; i++) {
      started = performance.now();
      stats = renderer.render(frame);
      head.gl.finish();
      runs.push(performance.now() - started);
    }
    const draw = median(runs);
    glRows.set(k, {
      upload: Math.max(0, firstFrame - draw),
      draw,
      stats: stats!,
    });
  }
  renderer.dispose();
  head.destroy();

  const cpu = new Map<string, Map<string, number>>();
  for (const backend of cpuBackends) {
    const perTile = new Map<string, number>();
    try {
      const root = await createRoot({ backend, desktop: false } as never);
      const app = (root as unknown as { app: unknown }).app;
      const scratch = new DrawScratch();
      for (const { k, z } of tiles) {
        const surface = new Surface(app as never, {
          width: size,
          height: size,
        }) as unknown as {
          getContext(kind: '2d'): unknown;
          clear(): void;
          destroy(): void;
        };
        const ctx = surface.getContext('2d');
        if (!isMapCanvas(ctx)) throw new Error('no path API');
        const runs: number[] = [];
        for (let i = 0; i < 7; i++) {
          surface.clear();
          scratch.resetStats();
          const started = performance.now();
          drawTileLayers(
            ctx,
            corpus.parsed.get(k)!,
            prepared,
            {
              ox: 0,
              oy: 0,
              span: size,
              pixelsPerLogical: SCALE,
              zoom: z,
              tolerance: 0.65 * SCALE,
              minFeature: 1.5 * SCALE,
            },
            scratch,
          );
          await settle(ctx, backend);
          runs.push(performance.now() - started);
        }
        perTile.set(k, median(runs));
        surface.destroy();
      }
      await (root as unknown as { unmount?(): Promise<void> }).unmount?.();
    } catch (error) {
      process.stdout.write(
        `  cpu on ${backend} unavailable: ${String(error)}\n`,
      );
    }
    cpu.set(backend, perTile);
  }

  process.stdout.write(
    `\ntile — one ${512}px tile at scale ${SCALE} (${size}px), median ms\n` +
      `  ${'tile'.padEnd(15)} ${'kind'.padEnd(6)} ${'KB'.padStart(5)}  ` +
      cpuBackends.map((b) => `${`cpu ${b}`.padStart(10)}`).join('') +
      `  ${'gl build'.padStart(9)} ${'upload'.padStart(7)} ${'gl draw'.padStart(8)}  ${'instances'.padStart(9)}  speedup\n`,
  );
  for (const { k, kind } of tiles) {
    const gl = glRows.get(k)!;
    const cpuMs = cpuBackends.map((b) => cpu.get(b)?.get(k) ?? NaN);
    const best = Math.min(...cpuMs.filter((v) => Number.isFinite(v)));
    process.stdout.write(
      `  ${k.padEnd(15)} ${kind.padEnd(6)} ${(corpus.bytes.get(k)! / 1024).toFixed(0).padStart(5)}  ` +
        cpuMs.map((v) => fmt(v, 10)).join('') +
        `  ${fmt(corpus.buildMs.get(k)!, 9)} ${fmt(gl.upload, 7)} ${fmt(gl.draw, 8)}  ${String(gl.stats.instances).padStart(9)}  ${Number.isFinite(best) ? `${(best / gl.draw).toFixed(0)}×` : '-'}\n`,
    );
    rows.push({
      tile: k,
      kind,
      kb: corpus.bytes.get(k)! / 1024,
      cpu: Object.fromEntries(cpuBackends.map((b, i) => [b, cpuMs[i]])),
      glBuild: corpus.buildMs.get(k),
      glUpload: gl.upload,
      glDraw: gl.draw,
      instances: gl.stats.instances,
      drawCalls: gl.stats.drawCalls,
    });
  }
  results.tile = rows;
}

/** A backend's drawing is done when it says so: X11 queues requests, so a
 *  one-pixel read is the round trip that makes the timing honest. */
async function settle(ctx: unknown, backend: string): Promise<void> {
  if (backend !== 'x11') return;
  await (
    ctx as {
      getImageData(
        x: number,
        y: number,
        w: number,
        h: number,
      ): Promise<unknown>;
    }
  ).getImageData(0, 0, 1, 1);
}

// --- view ---------------------------------------------------------------------

interface PathFrame {
  camera: MapCamera;
}

/** A pan in a circle of `radius` logical pixels around the view's centre,
 *  and a zoom from one level below it to one above and back. */
function paths(
  view: (typeof VIEWS)[number],
  frames: number,
): Record<'pan' | 'zoom', PathFrame[]> {
  const centre = PLACES[view.place];
  const t = transformFor({ center: centre, zoom: view.zoom }, PANE);
  const radius = 256;
  const pan: PathFrame[] = [];
  const zoom: PathFrame[] = [];
  for (let f = 0; f < frames; f++) {
    const angle = (2 * Math.PI * f) / frames;
    pan.push({
      camera: {
        center: unprojectPoint(
          t,
          PANE.width / 2 + radius * Math.cos(angle),
          PANE.height / 2 + radius * Math.sin(angle),
        ),
        zoom: view.zoom,
      },
    });
    zoom.push({
      camera: {
        center: centre,
        zoom: Math.max(0, view.zoom - 1 + (1 - Math.cos(angle))),
      },
    });
  }
  return { pan, zoom };
}

interface PhaseResult {
  view: string;
  kind: string;
  phase: string;
  frames: number;
  median: number;
  p95: number;
  max: number;
  cpuMedian: number;
  instances: number;
  drawCalls: number;
  tiles: number;
  /** Every frame's milliseconds, in path order — what a frame-time chart
   *  is drawn from. */
  samples?: number[];
}

function options(): {
  antialias: boolean;
  fillRule: 'nonzero' | 'evenodd';
  offscreen: 'auto' | boolean;
} {
  return {
    antialias: arg('aa', 'on') !== 'off',
    fillRule: arg('fill', 'nonzero') === 'evenodd' ? 'evenodd' : 'nonzero',
    offscreen: arg('offscreen', 'auto') === 'on' ? true : 'auto',
  };
}

function stageView(
  dri: Dri,
  corpus: Corpus,
  prepared: PreparedStyle,
  results: Record<string, unknown>,
): void {
  const frames = Number(arg('frames', '120'));
  const only = arg('view', '');
  const head = headlessGl(dri, W, H);
  const renderer = new GlMapRenderer(head.gl, options());
  const lookup = lookupOf(corpus);
  const out: PhaseResult[] = [];
  process.stdout.write(
    `\nview — ${PANE.width}×${PANE.height} at scale ${SCALE} (${W}×${H}), ${frames} frames per phase, every frame drawn\n` +
      `  ${'view'.padEnd(14)} ${'kind'.padEnd(6)} ${'phase'.padEnd(5)} ${'median'.padStart(7)} ${'p95'.padStart(7)} ${'max'.padStart(7)}  ${'cpu'.padStart(5)}  ${'fps@p95'.padStart(7)}  ${'tiles'.padStart(5)} ${'draws'.padStart(5)} ${'instances'.padStart(9)}  50Hz\n`,
  );
  for (const view of VIEWS) {
    if (only && !only.split(',').includes(view.id)) continue;
    const phases = paths(view, frames);
    for (const phase of ['pan', 'zoom'] as const) {
      head.bind();
      // One unmeasured pass over the path: every tile's upload and vertex
      // arrays happen here, which is where they happen in a real map too —
      // once, when the tile arrives.
      for (const step of phases[phase]) {
        const cover = renderCover(step.camera, PANE, SCALE, PYRAMID, lookup);
        renderer.render(frameOf(step.camera, cover.tiles, prepared));
      }
      head.gl.finish();
      const totals: number[] = [];
      const cpus: number[] = [];
      let instances = 0;
      let drawCalls = 0;
      let tiles = 0;
      for (const step of phases[phase]) {
        const started = performance.now();
        const cover = renderCover(step.camera, PANE, SCALE, PYRAMID, lookup);
        const stats = renderer.render(
          frameOf(step.camera, cover.tiles, prepared),
        );
        const issued = performance.now();
        head.gl.finish();
        totals.push(performance.now() - started);
        cpus.push(issued - started);
        instances = Math.max(instances, stats.instances);
        drawCalls = Math.max(drawCalls, stats.drawCalls);
        tiles = Math.max(tiles, stats.tiles);
      }
      const row: PhaseResult = {
        view: view.id,
        kind: view.kind,
        phase,
        frames,
        median: median(totals),
        p95: p95(totals),
        max: Math.max(...totals),
        cpuMedian: median(cpus),
        instances,
        drawCalls,
        tiles,
        samples: totals.map((ms) => Math.round(ms * 1000) / 1000),
      };
      out.push(row);
      process.stdout.write(
        `  ${view.id.padEnd(14)} ${view.kind.padEnd(6)} ${phase.padEnd(5)} ${fmt(row.median, 7)} ${fmt(row.p95, 7)} ${fmt(row.max, 7)}  ${fmt(row.cpuMedian, 5)}  ${String(Math.floor(1000 / row.p95)).padStart(7)}  ${String(tiles).padStart(5)} ${String(drawCalls).padStart(5)} ${String(instances).padStart(9)}  ${row.p95 <= 20 ? 'yes' : 'NO'}\n`,
      );
    }
  }
  renderer.dispose();
  head.destroy();
  results.view = out;
}

function frameOf(
  camera: MapCamera,
  tiles: ReturnType<typeof renderCover>['tiles'],
  prepared: PreparedStyle,
) {
  return {
    width: W,
    height: H,
    zoom: camera.zoom,
    scale: SCALE,
    style: prepared,
    background: STYLE.background,
    sources: [tiles],
  };
}

// --- cpu-view -------------------------------------------------------------------

async function stageCpuView(
  corpus: Corpus,
  prepared: PreparedStyle,
  backends: string[],
  results: Record<string, unknown>,
): Promise<void> {
  const frames = Number(arg('frames', '120'));
  const sample = Number(arg('cpu-sample', '8'));
  const only = arg('view', '');
  const out: Record<string, unknown>[] = [];
  for (const backend of backends) {
    process.stdout.write(
      `\ncpu-view on ${backend} — the same frames rasterized uncached into a ${W}×${H} surface, ${sample} sampled per phase\n` +
        `  ${'view'.padEnd(14)} ${'phase'.padEnd(5)} ${'median'.padStart(8)} ${'max'.padStart(8)}  ${'fps'.padStart(5)}\n`,
    );
    let root: unknown;
    try {
      root = await createRoot({ backend, desktop: false } as never);
    } catch (error) {
      process.stdout.write(`  unavailable: ${String(error)}\n`);
      continue;
    }
    const app = (root as { app: unknown }).app;
    const scratch = new DrawScratch();
    const surface = new Surface(app as never, {
      width: W,
      height: H,
    }) as unknown as {
      getContext(kind: '2d'): unknown;
      clear(): void;
      destroy(): void;
    };
    const ctx = surface.getContext('2d') as MapCanvas;
    for (const view of VIEWS) {
      if (only && !only.split(',').includes(view.id)) continue;
      const phases = paths(view, frames);
      for (const phase of ['pan', 'zoom'] as const) {
        const runs: number[] = [];
        const list = phases[phase];
        for (let i = 0; i < sample; i++) {
          const step = list[Math.floor((i * list.length) / sample)];
          const started = performance.now();
          drawCpuFrame(ctx, corpus, prepared, step.camera, scratch);
          await settle(ctx, backend);
          runs.push(performance.now() - started);
        }
        const row = {
          backend,
          view: view.id,
          kind: view.kind,
          phase,
          median: median(runs),
          max: Math.max(...runs),
        };
        out.push(row);
        process.stdout.write(
          `  ${view.id.padEnd(14)} ${phase.padEnd(5)} ${fmt(row.median, 8)} ${fmt(row.max, 8)}  ${(1000 / row.median).toFixed(1).padStart(5)}\n`,
        );
      }
    }
    surface.destroy();
    await (root as { unmount?(): Promise<void> }).unmount?.();
  }
  results.cpuView = out;
}

/** One frame the retained renderer's way, minus the cache: each visible
 *  tile (or the ancestor standing in for it) drawn through its own square. */
function drawCpuFrame(
  ctx: MapCanvas,
  corpus: Corpus,
  prepared: PreparedStyle,
  camera: MapCamera,
  scratch: DrawScratch,
): void {
  ctx.fillStyle = STYLE.background;
  ctx.fillRect(0, 0, W, H);
  const t = transformFor(camera, PANE);
  for (const entry of tileCover(t, PYRAMID)) {
    let tile = corpus.parsed.get(key(entry.tile));
    let x = entry.x;
    let y = entry.y;
    let size = entry.size;
    for (let up = 1; !tile && up <= 8 && entry.tile.z - up >= 0; up++) {
      const a = {
        z: entry.tile.z - up,
        x: entry.tile.x >> up,
        y: entry.tile.y >> up,
      };
      tile = corpus.parsed.get(key(a));
      if (tile) {
        size = entry.size * (1 << up);
        x = entry.x - (entry.tile.x - (a.x << up)) * entry.size;
        y = entry.y - (entry.tile.y - (a.y << up)) * entry.size;
      }
    }
    if (!tile) continue;
    const cell = {
      x: entry.x * SCALE,
      y: entry.y * SCALE,
      width: entry.size * SCALE,
      height: entry.size * SCALE,
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x, cell.y, cell.width, cell.height);
    ctx.clip();
    drawTileLayers(
      ctx,
      tile,
      prepared,
      {
        ox: x * SCALE,
        oy: y * SCALE,
        span: size * SCALE,
        pixelsPerLogical: SCALE,
        zoom: camera.zoom,
        tolerance: 0.65 * SCALE,
        minFeature: 1.5 * SCALE,
        // An ancestor standing in is drawn several times its size, and its
        // tile-wide polygons then overflow XRender's 16.16 fixed point on
        // X11 — AGENTS.md's "clip everything". The retained renderer clips
        // on that path, so this does too; it also culls what misses.
        clip: size > entry.size ? cell : null,
      },
      scratch,
    );
    ctx.restore();
  }
}

// --- main -------------------------------------------------------------------------

async function main(): Promise<void> {
  const stages = arg('stage', 'tile,view,cpu-view').split(',');
  const cpuBackends = arg(
    'cpu',
    process.platform === 'darwin' ? 'cocoa' : 'x11',
  )
    .split(',')
    .filter(Boolean);
  const dri = createRequire(import.meta.url)('x11-dri') as Dri;
  const prepared = prepareStyle(STYLE);
  const results: Record<string, unknown> = {
    when: new Date().toISOString(),
    options: options(),
    scale: SCALE,
    pane: PANE,
  };
  process.stdout.write(
    "loading the corpus and building every tile's buckets...\n",
  );
  const corpus = await loadCorpus(prepared);
  if (corpus.buckets.size === 0) {
    process.stdout.write('no corpus — run scripts/bench/tiles.ts first\n');
    return;
  }
  const builds = [...corpus.buildMs.values()];
  process.stdout.write(
    `  ${corpus.buckets.size} tiles; bucket build median ${fmt(median(builds))} ms, p95 ${fmt(p95(builds))} ms, max ${fmt(Math.max(...builds))} ms\n`,
  );
  results.build = Object.fromEntries(corpus.buildMs);
  if (stages.includes('tile'))
    await stageTile(dri, corpus, prepared, cpuBackends, results);
  if (stages.includes('view')) stageView(dri, corpus, prepared, results);
  if (stages.includes('cpu-view'))
    await stageCpuView(corpus, prepared, cpuBackends, results);
  const json = arg('json', '');
  if (json) await writeFile(json, JSON.stringify(results, null, 2));
  process.exit(0);
}

await main();
