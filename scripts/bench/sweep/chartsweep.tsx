// One cell of the charts sweep on whichever backend REACT_X11_BACKEND names.
// Prints one JSON line. Frames are the window's own (`_flushFrame` answering
// that it painted), so every chart on screen is in them.
//   ACTION stream    six live line charts, each fed 60 points a second
//          pan1m     a million-point line, its x domain (100k wide) panned
//                    every 8 ms — a React render and a spec rebuild a step
//          zoom1m    the same, zoomed from the whole series to 1,000 points
//                    and back
//          multiples twelve charts over the million points, panned together
//          scatter   200,000 points, x domain panned
//          scroll    the example's page — streaming, the million, twelve
//                    multiples, the scatter — wheeled down and back while
//                    the stream appends
import { fileURLToPath } from 'node:url';
import React, { useState } from 'react';
import { createRoot } from 'react-x11';
import { WindowNode } from 'react-x11/node';
import { startTrace } from 'react-x11/debug';
process.env.REACT_X11_NO_AUTORUN = '1';
// The tree under test: this checkout by default, or another one's root
// when the probe is copied into that tree's node_modules/.bench (README).
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const ACTION = process.env.ACTION ?? 'stream';
const C: any = await import(`${ROOT}/src/charts/index.js`);
const D: any = await import(`${ROOT}/examples/chart-data.ts`);
const {
  ChartContainer,
  LineChart,
  ScatterChart,
  LineSeries,
  ScatterSeries,
  XAxis,
  YAxis,
  CartesianGrid,
  ChartData,
} = C;
const h = React.createElement;
const W = 1100,
  H = 720;

// frames: the window's flushes that painted, and what each cost this thread
const frames: { t: number; ms: number; y?: number }[] = [];
const sends: { t: number; dir: number }[] = [];
let run = false;
{
  const inner = (WindowNode as any).prototype._flushFrame;
  (WindowNode as any).prototype._flushFrame = function (
    this: any,
    ...a: any[]
  ) {
    const t0 = performance.now();
    const painted = inner.apply(this, a);
    if (run && painted)
      frames.push({
        t: t0,
        ms: performance.now() - t0,
        y: scrollRef.current?.scrollY,
      });
    return painted;
  };
}
const chartCost = { prep: 0, paint: 0, commands: 0, reports: 0 };
const onFrameStats = (s: any) => {
  if (!run) return;
  chartCost.prep += s.prepMs ?? 0;
  chartCost.paint += s.paintMs ?? 0;
  chartCost.commands += s.commands ?? 0;
  chartCost.reports++;
};

// the live stores: 60 points a second each, as the example's telemetry
const stores = Array.from(
  { length: ACTION === 'scroll' ? 1 : 6 },
  () => new ChartData({ maxLength: 3000, maxAge: { key: 't', ms: 60_000 } }),
);
let phase = 0;
if (ACTION === 'stream' || ACTION === 'scroll') {
  setInterval(() => {
    const now = Date.now();
    for (const store of stores) {
      for (let i = 0; i < 3; i++) {
        phase += 0.02;
        store.append({
          t: now,
          cpu: 35 + 25 * Math.sin(phase) + Math.random() * 8,
          mem: 55 + 12 * Math.sin(phase / 3 + 1) + Math.random() * 3,
        });
      }
    }
  }, 50);
}
const streaming = (store: any, height: number) =>
  h(
    ChartContainer,
    {
      config: {
        cpu: { label: 'CPU %', color: '$accent' },
        mem: { label: 'Memory %', color: '#e17055' },
      },
      style: { height, flexGrow: 1 },
    },
    h(
      LineChart,
      { data: store, onFrameStats },
      h(CartesianGrid),
      h(XAxis, { dataKey: 't', type: 'time' }),
      h(YAxis, { width: 38, domain: [0, 100] }),
      h(LineSeries, { dataKey: 'cpu' }),
      h(LineSeries, { dataKey: 'mem' }),
    ),
  );

// the controlled x domain, set from outside React
let setDomain: (d: readonly [number, number] | null) => void = () => {};
function Domain(props: {
  children: (d: readonly [number, number] | null) => React.ReactElement;
}) {
  const [d, set] = useState<readonly [number, number] | null>(
    ACTION === 'pan1m' || ACTION === 'multiples'
      ? [0, 100_000]
      : ACTION === 'scatter'
        ? [-3, 1]
        : null,
  );
  setDomain = set;
  return props.children(d);
}
const million = (
  d: readonly [number, number] | null,
  height: number,
  width?: number,
  hide = false,
) =>
  h(
    ChartContainer,
    {
      config: { walk: { label: 'random walk', color: '#00b894' } },
      style: width ? { width, height } : { height, flexGrow: 1 },
    },
    h(
      LineChart,
      { data: D.millionData, onFrameStats },
      hide ? null : h(CartesianGrid),
      h(XAxis, { hide, domain: d ? [d[0], d[1]] : undefined }),
      h(YAxis, { hide, width: 44 }),
      h(LineSeries, { dataKey: 'walk', strokeWidth: 1 }),
    ),
  );
const cloud = D.cloudData();
const scatter = (d: readonly [number, number] | null, height: number) =>
  h(
    ChartContainer,
    {
      config: { y: { label: 'sample', color: '$accent' } },
      style: { height, flexGrow: 1 },
    },
    h(
      ScatterChart,
      { data: cloud, onFrameStats },
      h(CartesianGrid, { vertical: true }),
      h(XAxis, { dataKey: 'x', domain: d ? [d[0], d[1]] : undefined }),
      h(YAxis, { width: 40 }),
      h(ScatterSeries, { dataKey: 'y', size: 2 }),
    ),
  );

let content: React.ReactElement;
const scrollRef: { current: any } = { current: null };
if (ACTION === 'stream') {
  content = h(
    'box',
    {
      style: {
        flexGrow: 1,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        padding: 8,
      },
    },
    stores.map((store, i) =>
      h(
        'box',
        { key: i, style: { width: 530, height: 225 } },
        streaming(store, 225),
      ),
    ),
  );
} else if (ACTION === 'pan1m' || ACTION === 'zoom1m') {
  content = h(
    'box',
    { style: { flexGrow: 1, padding: 12 } },
    h(Domain, { children: (d) => million(d, 600) }),
  );
} else if (ACTION === 'multiples') {
  content = h(
    'box',
    {
      style: {
        flexGrow: 1,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        padding: 8,
      },
    },
    h(Domain, {
      children: (d) =>
        h(
          React.Fragment,
          null,
          Array.from({ length: 12 }, (_, i) =>
            h('box', { key: i }, million(d, 150, 255, true)),
          ),
        ),
    }),
  );
} else if (ACTION === 'scatter') {
  content = h(
    'box',
    { style: { flexGrow: 1, padding: 12 } },
    h(Domain, { children: (d) => scatter(d, 600) }),
  );
} else {
  content = h(
    'box',
    {
      ref: scrollRef,
      style: {
        flexGrow: 1,
        flexDirection: 'column',
        overflow: 'scroll',
        padding: 16,
        gap: 24,
      },
    },
    streaming(stores[0], 220),
    million(null, 220),
    h(
      'box',
      { style: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } },
      Array.from({ length: 12 }, (_, i) =>
        h('box', { key: i }, million(null, 44, 90, true)),
      ),
    ),
    scatter(null, 240),
    streaming(stores[0], 220),
    million(null, 220),
  );
}
const wref: { current: any } = { current: null };
const root = await createRoot({ glPolicy: 'auto' });
root.render(
  h(
    'window',
    { ref: wref, width: W, height: H, x: 20, y: 40, title: 'chartsweep' },
    content,
  ),
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(3000);
const wnd = wref.current;
const cocoa = typeof wnd.app?._route === 'function';
const s = wnd.scale ?? 1;
const tm = () => Date.now() & 0x7fffffff;
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
const t0 = performance.now();
const DUR = 4000;
run = true;
let steps = 0;
const every8 = (fn: (u: number) => void) =>
  new Promise<void>((done) => {
    const timer = setInterval(() => {
      const u = (performance.now() - t0) / DUR;
      if (u >= 1) {
        clearInterval(timer);
        done();
        return;
      }
      fn(u);
      steps++;
    }, 8);
  });
if (ACTION === 'pan1m' || ACTION === 'multiples') {
  await every8((u) => {
    const lo = 450_000 * (1 - Math.cos(2 * Math.PI * u));
    setDomain([lo, lo + 100_000]);
  });
} else if (ACTION === 'zoom1m') {
  await every8((u) => {
    const half = 500_000 * Math.pow(0.002, Math.sin(Math.PI * u));
    setDomain([500_000 - half, 500_000 + half]);
  });
} else if (ACTION === 'scatter') {
  await every8((u) => {
    const lo = -3 + 2 * Math.sin(Math.PI * u);
    setDomain([lo, lo + 4]);
  });
} else if (ACTION === 'scroll') {
  const cx = W / 2,
    cy = H / 2;
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
          time: tm(),
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
          time: tm(),
        });
      sends.push({ t: performance.now(), dir });
      steps++;
      // 12 notches of 96px each way: the page scrolls 1296px, and a wheel
      // past its end scrolls nothing, so a longer leg measured the stream
      if (steps % 12 === 0) dir = -dir;
      if (performance.now() - t0 > DUR) {
        clearInterval(timer);
        done();
      }
    }, 16);
  });
} else {
  await wait(DUR);
}
run = false;
const dt = (performance.now() - t0) / 1000;
const cu = process.cpuUsage(c0);
const x1 = cpuOf(server);
const wire = trace?.stop();
const q = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const iv = frames.slice(1).map((f, i) => f.t - frames[i].t);
const n = frames.length;
const out = {
  suite: 'charts',
  backend: cocoa ? 'cocoa' : 'x11',
  scene: ACTION,
  action: ACTION,
  asked: '2d',
  renderer: 'retained',
  fps: r2(n / dt),
  p50: r2(q(iv, 0.5)),
  p95: r2(q(iv, 0.95)),
  frame50: r2(
    q(
      frames.map((f) => f.ms),
      0.5,
    ),
  ),
  frame95: r2(
    q(
      frames.map((f) => f.ms),
      0.95,
    ),
  ),
  chartMs: r2((chartCost.prep + chartCost.paint) / Math.max(1, n)),
  commands: Math.round(chartCost.commands / Math.max(1, n)),
  cpu: Math.round((cu.user + cu.system) / 1e4 / dt),
  xcpu: server ? Math.round(((x1 - x0) / dt) * 100) : null,
  req: wire && n ? Math.round(wire.requests / n) : null,
  kb: wire && n ? r2(wire.bytesOut / n / 1024) : null,
  steps: Math.round(steps / dt),
};
console.log('RESULT ' + JSON.stringify(out));
if (process.env.DIAG === '1') {
  const gaps: any[] = [];
  for (let i = 1; i < frames.length; i++) {
    const g = frames[i].t - frames[i - 1].t;
    if (g > 30) {
      const during = sends.filter(
        (e) => e.t > frames[i - 1].t && e.t <= frames[i].t,
      );
      gaps.push({
        at: Math.round(frames[i - 1].t - t0),
        gap: Math.round(g),
        yBefore: frames[i - 1].y,
        yAfter: frames[i].y,
        sends: during.length,
        dirs: [...new Set(during.map((e) => e.dir))],
      });
    }
  }
  console.log('GAPS ' + gaps.length + ' ' + JSON.stringify(gaps.slice(0, 14)));
  console.log('YS ' + JSON.stringify(frames.slice(0, 60).map((f) => f.y)));
}
process.exit(0);
