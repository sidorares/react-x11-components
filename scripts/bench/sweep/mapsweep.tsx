// One cell of the maps sweep: RENDERER (gl | retained) × ACTION on whichever
// backend REACT_X11_BACKEND names, London at zoom 15 with labels. Prints one
// JSON line. Tiles come from a disk cache (BENCH_TILES, default under the OS
// temp directory); a tile it does not have is fetched from OpenStreetMap once
// and kept, so the first run on a machine is a network run and not a number.
//   ACTION pan   camera animated along x, 1200 px out and back, on an 8 ms
//                wall-clock timer (an app animating the camera)
//          drag  the pointer dragging the map at 125 Hz (a user's pan)
//          wheel a wheel at the centre, 30 notches a second, turning back
//                every 15 (a user's zoom)
//          fly   camera animated through zoom 15 → 11 → 15 while panning
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createRoot } from 'react-x11';
import { startTrace } from 'react-x11/debug';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.REACT_X11_NO_AUTORUN = '1';
// The tree under test: this checkout by default, or another one's root
// when the probe is copied into that tree's node_modules/.bench (README).
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const CACHE =
  process.env.BENCH_TILES ?? path.join(os.tmpdir(), 'react-x11-sweep-tiles');
const ACTION = process.env.ACTION ?? 'pan';
const RENDERER = process.env.RENDERER ?? 'gl';
const { Map, shortbreadStyle } = await import(`${ROOT}/src/maps/index.js`);
const { osmVector } = await import(`${ROOT}/examples/map-sources.js`);
let misses = 0;
const source = {
  id: 'osm-vector',
  minZoom: 0,
  maxZoom: 14,
  tileSize: 512,
  attribution: osmVector.attribution,
  load: async (r: any) => {
    const file = path.join(CACHE, `${r.z}-${r.x}-${r.y}.pbf`);
    if (fs.existsSync(file))
      return { kind: 'vector', data: new Uint8Array(fs.readFileSync(file)) };
    misses++;
    const got = await osmVector.load(r);
    if (got?.data) {
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, got.data);
    }
    return got;
  },
};
const W = 1100,
  H = 720;
const HOME = { center: { lon: -0.1281, lat: 51.508 }, zoom: 15 };
const frames: any[] = [],
  at: number[] = [];
let run = false,
  lastStats: any = null;
const handle: { current: any } = { current: null };
const wref: { current: any } = { current: null };
const root = await createRoot({ glPolicy: 'auto' });
root.render(
  React.createElement(
    'window',
    { ref: wref, width: W, height: H, x: 20, y: 40, title: 'mapsweep' },
    React.createElement(Map, {
      ref: handle,
      renderer: RENDERER,
      sources: [source],
      mapStyle: shortbreadStyle({ dark: false, labels: true }),
      defaultCamera: HOME,
      style: { flexGrow: 1 },
      // A frame can report more than once — a pass per damage rect — so
      // reports inside 2 ms of each other are one frame, their costs summed.
      onFrame: (s: any) => {
        lastStats = s;
        if (!run) return;
        const tm = performance.now();
        if (at.length && tm - at[at.length - 1] < 2) {
          const f = frames[frames.length - 1];
          f.drawMs = (f.drawMs ?? 0) + (s.drawMs ?? 0);
          f.passes++;
          at[at.length - 1] = tm;
          return;
        }
        frames.push({ drawMs: s.drawMs, passes: 1 });
        at.push(tm);
      },
    }),
  ),
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(Number(process.env.BENCH_WARM ?? 6000));
const wnd = wref.current;
const cocoa = typeof wnd.app?._route === 'function';
const s = wnd.scale ?? 1;
const t = () => Date.now() & 0x7fffffff;
const emit = (type: string, x: number, y: number, extra: any = {}) =>
  cocoa
    ? wnd.app._route({
        type,
        handle: wnd._key,
        x,
        y,
        gx: x,
        gy: y,
        button: extra.keycode ?? 0,
        time: t(),
        ...extra.cocoa,
      })
    : wnd.emit(type, {
        x: Math.round(x * s),
        y: Math.round(y * s),
        rootx: 0,
        rooty: 0,
        buttons: 256,
        time: t(),
        ...extra,
      });
const lonPerPx = (zoom: number) => 360 / (512 * 2 ** zoom);
const { execSync } = await import('node:child_process');
const server = !cocoa
  ? (() => {
      try {
        return execSync('pgrep -x X11.bin').toString().trim().split('\n')[0];
      } catch {
        return '';
      }
    })()
  : '';
const cpuOf = (pid: string) => {
  if (!pid) return NaN;
  const tt = execSync(`ps -o cputime= -p ${pid}`).toString().trim();
  const [m, sec] = tt.split(':');
  return Number(m) * 60 + Number(sec);
};
const x0 = cpuOf(server);
const c0 = process.cpuUsage();
const trace = !cocoa ? startTrace({ sink: 'summary' }) : null;
const missesBefore = misses;
const t0 = performance.now();
const shapes = {
  calls: 0,
  ms: 0,
  shapeCalls: 0,
  clears: 0,
  keys: new Set<string>(),
  sizes: new globalThis.Map<number, number>(),
};
if (process.env.DIAG === '1') {
  const { LabelShaper } = await import(`${ROOT}/src/maps/labels.js`);
  const inner = LabelShaper.prototype.shape;
  LabelShaper.prototype.shape = function (
    this: any,
    text: string,
    size: number,
    color: string,
  ) {
    if (run) {
      shapes.shapeCalls++;
      const r = inner.call(this, text, size, color);
      shapes.keys.add(size + '|' + color + '|' + text);
      shapes.sizes.set(size, (shapes.sizes.get(size) ?? 0) + 1);
      return r;
    }
    return inner.call(this, text, size, color);
  };
}
if (process.env.DIAG === '1') {
  const fonts = wnd.app.fonts;
  const inner = fonts.layout.bind(fonts);
  fonts.layout = (...a: any[]) => {
    const t = performance.now();
    const r = inner(...a);
    if (run) {
      shapes.calls++;
      shapes.ms += performance.now() - t;
    }
    return r;
  };
}
run = true;
let steps = 0;
const DUR = 4000;
async function animate(fn: (u: number) => any) {
  const start = performance.now();
  for (;;) {
    const u = (performance.now() - start) / DUR;
    if (u >= 1) break;
    handle.current.setCamera(fn(u));
    steps++;
    await wait(8);
  }
}
if (ACTION === 'pan') {
  await animate((u) => ({
    center: {
      lon: HOME.center.lon + lonPerPx(15) * 1200 * Math.sin(Math.PI * u),
      lat: HOME.center.lat,
    },
    zoom: 15,
  }));
} else if (ACTION === 'fly') {
  await animate((u) => ({
    center: {
      lon: HOME.center.lon + 0.05 * Math.sin(Math.PI * u),
      lat: HOME.center.lat + 0.02 * Math.sin(Math.PI * u),
    },
    zoom: 15 - 4 * Math.sin(Math.PI * u),
  }));
} else if (ACTION === 'drag') {
  const cx = W / 2,
    cy = H / 2;
  emit('mousemove', cx, cy, { buttons: 0 });
  await wait(50);
  emit('mousedown', cx, cy, { keycode: 1, buttons: 0 });
  await wait(30);
  let x = cx,
    dir = -1;
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      x += 3 * dir;
      steps++;
      if (Math.abs(x - cx) > 300) dir = -dir;
      emit('mousemove', x, cy + (steps % 40) / 4);
      if (performance.now() - t0 > DUR) {
        clearInterval(timer);
        done();
      }
    }, 8);
  });
  emit('mouseup', x, cy, { keycode: 1 });
} else if (ACTION === 'wheel') {
  const cx = W / 2,
    cy = H / 2;
  emit('mousemove', cx, cy, { buttons: 0 });
  await wait(50);
  let dir = 1;
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      if (cocoa)
        wnd.app._route({
          type: 'wheel',
          handle: wnd._key,
          x: cx,
          y: cy,
          gx: cx,
          gy: cy,
          dx: 0,
          dy: -dir,
          precise: false,
          time: t(),
        });
      else
        wnd.emit('wheel', {
          name: 'wheel',
          x: Math.round(cx * s),
          y: Math.round(cy * s),
          rootx: 0,
          rooty: 0,
          buttons: 0,
          deltaX: 0,
          deltaY: dir,
          deltaMode: 'line',
          smooth: false,
          source: 'button',
          time: t(),
        });
      steps++;
      if (steps % 15 === 0) dir = -dir;
      if (performance.now() - t0 > DUR) {
        clearInterval(timer);
        done();
      }
    }, 33);
  });
}
run = false;
const dt = (performance.now() - t0) / 1000;
const cu = process.cpuUsage(c0);
const x1 = cpuOf(server);
const wire = trace?.stop();
const q = (xs: number[], p: number) => {
  const v = [...xs].filter((x) => x != null && !isNaN(x)).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const iv = at.slice(1).map((v, i) => v - at[i]);
const n = frames.length;
const out = {
  suite: 'maps',
  backend: cocoa ? 'cocoa' : 'x11',
  scene: 'london-z15',
  action: ACTION,
  asked: RENDERER,
  renderer: lastStats?.renderer ?? (lastStats?.gl ? 'gl' : 'retained'),
  fps: r2(n / dt),
  p50: r2(q(iv, 0.5)),
  p95: r2(q(iv, 0.95)),
  draw50: r2(
    q(
      frames.map((f) => f.drawMs),
      0.5,
    ),
  ),
  draw95: r2(
    q(
      frames.map((f) => f.drawMs),
      0.95,
    ),
  ),
  cpu: Math.round((cu.user + cu.system) / 1e4 / dt),
  xcpu: server ? Math.round(((x1 - x0) / dt) * 100) : null,
  req: wire && n ? Math.round(wire.requests / n) : null,
  kb: wire && n ? r2(wire.bytesOut / n / 1024) : null,
  misses: misses - missesBefore,
  steps: Math.round(steps / dt),
  passes: r2(frames.reduce((a, f) => a + f.passes, 0) / Math.max(1, n)),
};
console.log('RESULT ' + JSON.stringify(out));
if (process.env.DIAG === '1')
  console.log(
    'SHAPES ' +
      JSON.stringify({
        layouts: shapes.calls,
        ms: Math.round(shapes.ms),
        shapeCalls: shapes.shapeCalls,
        clears: shapes.clears,
        distinctKeys: shapes.keys.size,
        sizes: [...shapes.sizes].sort((a, b) => b[1] - a[1]).slice(0, 12),
      }),
  );
process.exit(0);
