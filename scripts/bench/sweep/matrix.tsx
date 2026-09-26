// One cell of the Flow matrix: SCENE × ACTION × renderer, on whichever
// backend REACT_X11_BACKEND names. The stress example's pane: controlled
// nodes, the widget types, minimap, controls, dots, budget 8, a rounded
// bordered pane. Prints one JSON line.
//   SCENE  lattice | lattice2000 | fanout | widgets | charts
//   ACTION pan (a step per frame) | zoom (×1.02 per frame about the centre,
//          bouncing between ZOOM/2.5 and ZOOM×1.25, set programmatically —
//          an animation's path) | wheel (a mouse wheel at the pane's centre,
//          30 notches a second, turning back every 15 — a user's zoom, which
//          Flow treats as a gesture) | drag (a node in the middle of the view
//          dragged by the pointer at 125 Hz)
//   ZOOM, GL=1, MAP=0, W/H, VX/VY, NODES (the lattice's size, default 200)
import { fileURLToPath } from 'node:url';
import React, { useCallback } from 'react';
import { createRoot } from 'react-x11';
import { startTrace } from 'react-x11/debug';
process.env.REACT_X11_NO_AUTORUN = '1';
// The tree under test: this checkout by default, or another one's root
// when the probe is copied into that tree's node_modules/.bench (README).
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const { Flow, useNodesState, useEdgesState } = await import(
  `${ROOT}/src/flow/index.js`
);
const S: any = await import(`${ROOT}/examples/flow-stress.tsx`);
const SC = process.env.SCENE ?? 'widgets';
const scene =
  SC === 'lattice'
    ? S.lattice(Number(process.env.NODES ?? 200))
    : SC === 'lattice2000'
      ? S.lattice(2000)
      : SC === 'fanout'
        ? S.fanOut()
        : SC === 'charts'
          ? S.chartWidgets()
          : S.widgets();
const ACTION = process.env.ACTION ?? 'pan';
const env = (k: string, d = '1') => (process.env[k] ?? d) === '1';
const zoom = Number(process.env.ZOOM ?? 0.5);
const W = Number(process.env.W ?? 1100),
  H = Number(process.env.H ?? 720);
const PAD = 10,
  BORDER = 1;
const paneW = W - 2 * (PAD + BORDER),
  paneH = H - 2 * (PAD + BORDER);
// the dragged node: the middle one, centred in the pane
const mid = scene.nodes[Math.floor(scene.nodes.length / 2)];
const mw = mid.width ?? 150,
  mh = mid.height ?? 40;
let vp = { x: -200 * zoom, y: -200 * zoom, zoom };
if (ACTION === 'drag')
  vp = {
    x: paneW / 2 - (mid.position.x + mw / 2) * zoom,
    y: paneH / 2 - (mid.position.y + mh / 2) * zoom,
    zoom,
  };
if (process.env.VX)
  vp = { x: Number(process.env.VX), y: Number(process.env.VY), zoom };
const frames: any[] = [],
  at: number[] = [],
  lat: number[] = [];
let run = false,
  changes = 0,
  renders = 0;
const handle: { current: any } = { current: null };
const wref: { current: any } = { current: null };
function App() {
  renders++;
  const [nodes, setNodes, onNodesChange] = useNodesState(scene.nodes);
  const [edges, , onEdgesChange] = useEdgesState(scene.edges);
  const patch = useCallback(
    (id: string, p: object) =>
      setNodes((c: any[]) =>
        c.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...p } } : n)),
      ),
    [setNodes],
  );
  return React.createElement(
    S.PatchWidget.Provider,
    { value: patch },
    React.createElement(Flow, {
      ref: handle,
      nodes,
      edges,
      onEdgesChange,
      onNodesChange: (c: any) => {
        if (run) changes++;
        onNodesChange(c);
      },
      nodeTypes: S.WIDGET_TYPES,
      renderer: env('GL', '0') ? 'gl' : 'retained',
      minimap: env('MAP'),
      controls: true,
      background: { variant: 'dots', gap: 24 },
      adaptive: { budgetMs: 8 },
      defaultViewport: vp,
      onFrame: (s: any) => {
        if (!run) return;
        frames.push(s);
        at.push(performance.now());
        lat.push(wref.current?.frameLatency ?? NaN);
        if (ACTION !== 'drag') setImmediate(step);
      },
      // SQUARE=1: the same pane without its rounded corners
      style: {
        flexGrow: 1,
        borderWidth: BORDER,
        borderColor: '$border',
        borderRadius: process.env.SQUARE === '1' ? 0 : 6,
      },
    }),
  );
}
let dx = 2,
  dyv = 1,
  k = 1.02;
// DIAG=1: the pan goes diagonally, as a pointer drag does — y by half of x
const DIAG = process.env.DIAG === '1';
const step = () => {
  const h = handle.current;
  const v = h?.getViewport();
  if (!v) return;
  if (ACTION === 'pan') {
    if (v.x < vp.x - 1200 || v.x > vp.x) dx = -dx;
    if (DIAG && (v.y < vp.y - 600 || v.y > vp.y)) dyv = -dyv;
    h.setViewport(DIAG ? { x: v.x + dx, y: v.y + dyv } : { x: v.x + dx });
  } else {
    if (v.zoom < zoom / 2.5) k = 1.02;
    else if (v.zoom > zoom * 1.25) k = 1 / 1.02;
    const cx = paneW / 2,
      cy = paneH / 2;
    h.setViewport({
      x: cx - (cx - v.x) * k,
      y: cy - (cy - v.y) * k,
      zoom: v.zoom * k,
    });
  }
};
const root = await createRoot({ glPolicy: 'auto' });
root.render(
  React.createElement(
    'window',
    { ref: wref, width: W, height: H, x: 20, y: 40, title: 'matrix' },
    React.createElement(
      'box',
      { style: { flexGrow: 1, padding: PAD } },
      React.createElement(App),
    ),
  ),
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(4000);
const wnd = wref.current;
const cocoa = typeof wnd.app?._route === 'function';
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
let px = 0,
  py = 0;
if (ACTION === 'drag') {
  // the header strip, a third of the way in
  px = PAD + BORDER + vp.x + (mid.position.x + mw / 3) * zoom;
  py = PAD + BORDER + vp.y + (mid.position.y + 8) * zoom;
  emit('mousemove', px, py, { buttons: 0 });
  await wait(100);
  emit('mousedown', px, py, { keycode: 1, buttons: 0 });
  await wait(30);
}
const x0 = cpuOf(server);
const c0 = process.cpuUsage();
const trace = !cocoa ? startTrace({ sink: 'summary' }) : null;
renders = 0;
const t0 = performance.now();
run = true;
let steps = 0;
if (ACTION === 'wheel') {
  const cx = PAD + BORDER + paneW / 2,
    cy = PAD + BORDER + paneH / 2;
  const notch = (dir: number) =>
    cocoa
      ? wnd.app._route({
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
        })
      : wnd.emit('wheel', {
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
  let dir = 1;
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      notch(dir);
      steps++;
      if (steps % 15 === 0) dir = -dir;
      if (performance.now() - t0 > 4000) {
        clearInterval(timer);
        done();
      }
    }, 33);
  });
  run = false;
} else if (ACTION === 'drag') {
  let x = px,
    dir = 1;
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      x += 2 * dir;
      steps++;
      if (Math.abs(x - px) > 200) dir = -dir;
      emit('mousemove', x, py + (steps % 40) / 4);
      if (performance.now() - t0 > 4000) {
        clearInterval(timer);
        done();
      }
    }, 8);
  });
  run = false;
  emit('mouseup', x, py, { keycode: 1 });
} else {
  step();
  await wait(4000);
  run = false;
}
const dt = (performance.now() - t0) / 1000;
const cu = process.cpuUsage(c0);
const x1 = cpuOf(server);
const wire = trace?.stop();
const q = (xs: number[], p: number) => {
  const v = [...xs].filter((x) => !isNaN(x)).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const iv = at.slice(1).map((v, i) => v - at[i]);
const n = frames.length;
const out = {
  suite: 'flow',
  backend: cocoa ? 'cocoa' : 'x11',
  scene: SC,
  action: ACTION + (DIAG ? '-diag' : ''),
  zoom,
  asked: env('GL', '0') ? 'gl' : '2d',
  map: env('MAP'),
  W,
  H,
  renderer: frames.at(-1)?.renderer,
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
  scene50: r2(
    q(
      frames.map((f) => f.sceneMs),
      0.5,
    ),
  ),
  bodies: frames.at(-1)?.bodies?.count ?? 0,
  cpu: Math.round((cu.user + cu.system) / 1e4 / dt),
  xcpu: server ? Math.round(((x1 - x0) / dt) * 100) : null,
  req: wire && n ? Math.round(wire.requests / n) : null,
  kb: wire && n ? r2(wire.bytesOut / n / 1024) : null,
  fence: r2(q(lat, 0.5)),
  renders: Math.round(renders / dt),
  changes: Math.round(changes / dt),
  moves: Math.round(steps / dt),
};
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
