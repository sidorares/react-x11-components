// `<Map renderer="gl">` in a real window, animated, with every delivered
// frame counted.
//
//   npx tsx scripts/bench/maps-gl-live.tsx                  # the default backend
//   REACT_X11_BACKEND=x11 npx tsx scripts/bench/maps-gl-live.tsx
//   npx tsx scripts/bench/maps-gl-live.tsx --place=tokyo --seconds=6
//   npx tsx scripts/bench/maps-gl-live.tsx --snapshot=pan.png   # Cocoa only
//
// `maps-gl.ts` prices a frame with `glFinish` and nothing else running; this
// is the other half — what a user gets. Frames here go through `<glarea>`'s
// own clock, pacing gate and swap, on whichever backend the root picked, so
// the frame rate is bounded by the display (8.3 ms at 120 Hz) and anything
// the renderer costs shows up as a *late* frame rather than a slow one.
//
// Four phases, each driving the camera from the frame callback the way an
// animation would: `settle` (a cold map filling in), `pan` (a circle of
// 300 px), `zoom` (two levels and back), and `fly` (zoom 5 to 15 and back —
// ten levels of tiles arriving and being built on this thread as it goes).
// The corpus is served from memory, so a load costs nothing and what is
// left is the renderer and the bucket builds.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createRoot } from 'react-x11';

import { Map as MapView, shortbreadStyle } from '../../src/maps/index.js';
import type {
  MapFrameStats,
  MapGlFrameStats,
  MapHandle,
} from '../../src/maps/index.js';
import { project, unproject, worldSize } from '../../src/maps/proj.js';
import type { LngLat, MapCamera } from '../../src/maps/proj.js';
import type { MapSource } from '../../src/maps/sources.js';
import { cachedTiles } from './tiles.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const PLACES: Record<string, { centre: LngLat; zoom: number }> = {
  london: { centre: { lon: -0.1281, lat: 51.508 }, zoom: 12.3 },
  tokyo: { centre: { lon: 139.7004, lat: 35.69 }, zoom: 12.5 },
  manhattan: { centre: { lon: -73.9855, lat: 40.758 }, zoom: 14.2 },
  pacific: { centre: { lon: -160, lat: 0 }, zoom: 10.5 },
};
const place = PLACES[arg('place', 'london')] ?? PLACES.london;
const seconds = Number(arg('seconds', '6'));
const snapshot = arg('snapshot', '');
// `--zoom=15.5` starts there instead of the place's own zoom — street
// labels begin at 14. `--labels=off` draws the map without any.
const zoom = Number(arg('zoom', String(place.zoom)));
const labels = arg('labels', 'on') !== 'off';

const bytes = new Map<string, Uint8Array>();
for (const { tile, file } of await cachedTiles()) {
  bytes.set(
    `${tile.z}/${tile.x}/${tile.y}`,
    new Uint8Array(await readFile(file)),
  );
}
const source: MapSource = {
  id: 'corpus',
  minZoom: 0,
  maxZoom: 14,
  tileSize: 512,
  load: ({ z, x, y }) => {
    const data = bytes.get(`${z}/${x}/${y}`);
    return data && data.length > 0 ? { kind: 'vector', data } : null;
  },
};
const sources = [source];
const base: MapCamera = { center: place.centre, zoom };

type Phase = 'settle' | 'pan' | 'zoom' | 'fly';

function cameraAt(phase: Phase, t: number): MapCamera {
  if (phase === 'pan') {
    const m = project(base.center);
    const world = worldSize(base.zoom);
    const angle = (2 * Math.PI * t) / 4;
    return {
      center: unproject({
        x: m.x + (300 * Math.cos(angle) - 300) / world,
        y: m.y + (300 * Math.sin(angle)) / world,
      }),
      zoom: base.zoom,
    };
  }
  if (phase === 'zoom') {
    return {
      center: base.center,
      zoom: base.zoom + 1 - Math.cos((2 * Math.PI * t) / 4),
    };
  }
  if (phase === 'fly') {
    return {
      center: base.center,
      zoom: 10 - 5 * Math.cos((2 * Math.PI * t) / seconds),
    };
  }
  return base;
}

const handle: { current: MapHandle | null } = { current: null };
const state = { phase: 'settle' as Phase, started: 0 };
/** A frame's GL figures, with the two the renderers share alongside. */
type Frame = MapGlFrameStats & {
  tiles: number;
  labels: number;
  phase: Phase;
  at: number;
};
const frames: Frame[] = [];
/** `--labels=off`: the default style with no label layers in it. */
const NO_LABELS = shortbreadStyle({ labels: false });

/** Ask for a frame on a map that is otherwise still: a camera step there
 *  and back, which the frame after them draws once, at the camera it had. */
function nudge(): void {
  handle.current?.panBy(1, 0);
  handle.current?.panBy(-1, 0);
}

// `--readback=frame.png`: one settled frame, read back from GL inside the
// frame — the only capture that sees a GL surface (a window snapshot from
// outside reads the window's own backing, which the GL layer is not in).
const readback = arg('readback', '');
const capture: {
  wanted: boolean;
  pixels: Uint8Array | null;
  width: number;
  height: number;
} = {
  wanted: false,
  pixels: null,
  width: 0,
  height: 0,
};
interface ReadbackGl {
  readPixels(
    x: number,
    y: number,
    w: number,
    h: number,
    format: number,
    type: number,
    out: Uint8Array,
  ): void;
  RGBA: number;
  UNSIGNED_BYTE: number;
}
function onAfterDraw(
  gl: unknown,
  info: { width: number; height: number },
): void {
  if (!capture.wanted || capture.pixels) return;
  const g = gl as ReadbackGl;
  const pixels = new Uint8Array(info.width * info.height * 4);
  g.readPixels(0, 0, info.width, info.height, g.RGBA, g.UNSIGNED_BYTE, pixels);
  capture.pixels = pixels;
  capture.width = info.width;
  capture.height = info.height;
}

async function writeCapture(path: string): Promise<void> {
  const { PNG } = createRequire(import.meta.url)('pngjs') as {
    PNG: {
      new (options: { width: number; height: number }): { data: Uint8Array };
      sync: { write(png: unknown): Uint8Array };
    };
  };
  const { pixels, width, height } = capture;
  if (!pixels) {
    process.stdout.write('readback: no frame was captured\n');
    return;
  }
  const png = new PNG({ width, height });
  // GL rows run bottom-up.
  for (let y = 0; y < height; y++) {
    png.data.set(
      pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4),
      y * width * 4,
    );
  }
  await writeFile(path, PNG.sync.write(png));
}

function onFrame(stats: MapFrameStats): void {
  const at = performance.now();
  if (!stats.gl) return;
  frames.push({
    ...stats.gl,
    tiles: stats.tiles,
    labels: stats.labels,
    phase: state.phase,
    at,
  });
  if (state.phase !== 'settle') {
    handle.current?.setCamera(
      cameraAt(state.phase, (at - state.started) / 1000),
    );
  }
}

const root = await createRoot({ glPolicy: 'auto', desktop: false } as never);
const app = (
  root as unknown as {
    app: {
      _windows?: Map<
        unknown,
        { snapshot?(path: string): void; _visible?(): boolean }
      >;
    };
  }
).app;

// A Cocoa window entirely behind another application's gets no frames at
// all — core holds its frame callbacks until it is back on glass — so a
// phase in which it was covered measured the desktop, not the map. Three
// runs of this script stalled that way while they were being read; the
// summary now says so rather than reporting the frames it did get.
const COVER_SAMPLE_MS = 50;
const covered = new Map<Phase, number>();
const coverTimer = setInterval(() => {
  const wnd = [...(app._windows?.values() ?? [])][0];
  if (wnd?._visible && !wnd._visible()) {
    covered.set(state.phase, (covered.get(state.phase) ?? 0) + COVER_SAMPLE_MS);
  }
}, COVER_SAMPLE_MS);
coverTimer.unref?.();
root.render(
  <window width={1200} height={800} title="maps-gl live">
    <MapView
      renderer="gl"
      ref={handle}
      sources={sources}
      mapStyle={labels ? undefined : NO_LABELS}
      defaultCamera={base}
      onFrame={onFrame}
      onAfterDraw={onAfterDraw}
      onError={(error) => {
        process.stdout.write(`GL failed: ${error.message}\n`);
        process.exit(1);
      }}
      buildWorkers={Number(arg('workers', '0'))}
      // `--fade=300` cross-fades pyramid levels; `--adaptive=6` holds moving
      // frames to a 6 ms budget.
      levelFade={Number(arg('fade', '0'))}
      adaptive={
        Number(arg('adaptive', '0')) > 0
          ? { budgetMs: Number(arg('adaptive', '0')) }
          : false
      }
      style={{ flexGrow: 1 }}
    />
  </window>,
);

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// settle: until nothing is loading or waiting for a build, or 8 s
const settleStart = performance.now();
for (let i = 0; i < 400; i++) {
  await wait(20);
  const last = frames[frames.length - 1];
  if (last && last.tiles > 0 && last.loading === 0 && last.building === 0)
    break;
}
const settledMs = performance.now() - settleStart;

if (readback) {
  // Labels land a readback after they are placed and fade in after that.
  for (let i = 0; i < 100; i++) {
    const last = frames[frames.length - 1];
    if (last && !last.textPending) break;
    await wait(20);
  }
  await wait(400);
  capture.wanted = true;
  nudge();
  await wait(250);
  await writeCapture(readback);
}

// Outside every measured phase: a window snapshot is a synchronous
// CGWindowListCreateImage and PNG encode, and it stalls this thread for a
// second — which the first run of this script counted as a frame.
if (snapshot) {
  await wait(300);
  const window = [...(app._windows?.values() ?? [])][0];
  try {
    window?.snapshot?.(snapshot);
  } catch (error) {
    process.stdout.write(`snapshot failed: ${String(error)}\n`);
  }
}

// `--gate=0.75` shortens the Cocoa `<glarea>` swap gate to that fraction of
// a display period. An experiment, not a setting: the gate is core's, and
// what this measures is whether it is the thing holding frames back.
const gate = Number(arg('gate', '1'));
const cocoaGL = (app as unknown as { _cocoaGL?: { frameInterval: number } })
  ._cocoaGL;
if (gate !== 1 && cocoaGL) cocoaGL.frameInterval *= gate;

for (const phase of ['pan', 'zoom', 'fly'] as const) {
  state.phase = phase;
  state.started = performance.now();
  // The first step: its frame's callback takes the next one, and so on.
  nudge();
  await wait(seconds * 1000);
}
state.phase = 'settle';

const backend =
  process.env.REACT_X11_BACKEND ??
  (process.platform === 'darwin' ? 'cocoa' : 'x11');
process.stdout.write(
  `\nlive on ${backend}: 1200×800 window, ${seconds} s per phase; settled in ${settledMs.toFixed(0)} ms\n` +
    `  phase   frames   fps   interval med    p95    max   >20ms   issue med   build total/max   tiles   segments\n`,
);
const summary: Record<string, unknown>[] = [];
for (const phase of ['settle', 'pan', 'zoom', 'fly'] as const) {
  const list = frames.filter((f) => f.phase === phase);
  if (list.length < 2) {
    const hidden = covered.get(phase);
    process.stdout.write(
      `  ${phase.padEnd(7)} ${String(list.length).padStart(6)} frames — too few to say` +
        (hidden ? ` (the window was covered for ~${hidden} ms)` : '') +
        '\n',
    );
    continue;
  }
  const span = (list[list.length - 1].at - list[0].at) / 1000;
  const intervals = list
    .slice(1)
    .map((f) => f.interval)
    .sort((a, b) => a - b);
  const late = intervals.filter((v) => v > 20).length;
  const issue = list.map((f) => f.cpuMs).sort((a, b) => a - b);
  const build = list.map((f) => f.buildMs);
  const row = {
    phase,
    frames: list.length,
    fps: (list.length - 1) / span,
    median: intervals[intervals.length >> 1],
    p95: intervals[Math.floor(intervals.length * 0.95)],
    max: intervals[intervals.length - 1],
    late,
    issue: issue[issue.length >> 1],
    buildTotal: build.reduce((a, b) => a + b, 0),
    buildMax: Math.max(...build),
    tiles: Math.max(...list.map((f) => f.tiles)),
    segments: Math.max(...list.map((f) => f.instances)),
    // What adaptive quality and the fade did in this phase.
    degraded: list.filter((f) => f.quality > 0).length,
    rungMax: Math.max(...list.map((f) => f.quality)),
    // Moving frames are priced, not timed; settled ones are timed.
    predictedMax: Math.max(...list.map((f) => f.predictedMs)),
    timed: list.filter((f) => f.measuredMs > 0).map((f) => f.measuredMs),
    faded: list.filter((f) => f.fade > 0).length,
    // Labels: this thread's time on them per frame, and how many.
    labelMs: list.map((f) => f.labelMs).sort((a, b) => a - b),
    labelsPlaced: Math.max(...list.map((f) => f.labelsPlaced)),
    labelsDrawn: Math.max(...list.map((f) => f.labels)),
    labelCandidates: Math.max(...list.map((f) => f.labelCandidates)),
  };
  summary.push(row);
  const rungs = new Map<number, number>();
  for (const f of list) rungs.set(f.quality, (rungs.get(f.quality) ?? 0) + 1);
  const spread = [...rungs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, n]) => `${r}:${n}`)
    .join(' ');
  const extra =
    (row.predictedMax > 0 || row.timed.length > 0
      ? `   adaptive: rungs ${spread}, predicted ≤${row.predictedMax.toFixed(1)} ms` +
        (row.timed.length
          ? `, timed at rest ${Math.max(...row.timed).toFixed(1)} ms`
          : '')
      : '') +
    (row.faded ? `   fading on ${row.faded} frames` : '') +
    (covered.get(phase)
      ? `   COVERED for ~${covered.get(phase)} ms: not a measurement`
      : '') +
    (labels
      ? `   labels: ${row.labelMs[row.labelMs.length >> 1].toFixed(2)} ms med, ` +
        `${row.labelMs[Math.floor(row.labelMs.length * 0.95)].toFixed(2)} p95, ` +
        `${row.labelMs[row.labelMs.length - 1].toFixed(1)} max; ` +
        `≤${row.labelsPlaced} placed of ≤${row.labelCandidates}, ≤${row.labelsDrawn} drawn`
      : '');
  process.stdout.write(
    `  ${phase.padEnd(7)} ${String(row.frames).padStart(6)} ${row.fps.toFixed(0).padStart(5)}   ${row.median.toFixed(1).padStart(10)} ${row.p95.toFixed(1).padStart(6)} ${row.max.toFixed(1).padStart(6)}   ${String(late).padStart(5)}   ${row.issue.toFixed(2).padStart(9)}   ${row.buildTotal.toFixed(0).padStart(7)} / ${row.buildMax.toFixed(1).padStart(5)}   ${String(row.tiles).padStart(5)}   ${String(row.segments).padStart(8)}${extra}\n`,
  );
}
const json = arg('json', '');
if (json) {
  await writeFile(
    json,
    JSON.stringify(
      {
        backend,
        seconds,
        summary,
        frames: frames.map((f) => ({
          phase: f.phase,
          at: f.at,
          interval: f.interval,
          cpuMs: f.cpuMs,
          buildMs: f.buildMs,
          labelMs: f.labelMs,
          labels: f.labels,
          textPending: f.textPending,
        })),
      },
      null,
      2,
    ),
  );
}
process.exit(0);
