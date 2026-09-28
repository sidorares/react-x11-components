// A node dragged through a <Flow> graph, watched for what should not move.
//
// The stress example's pane, a scene of it (SCENE), a zoom (ZOOM), either
// renderer (GL=1). A node in the middle of the view is dragged by the
// pointer at 125 Hz, ±200 px, for MS milliseconds, while a second X client
// (./watch.mjs) reads the window back to back and compares every other card
// with how it looked before the drag — each inset past its rounded corners,
// where an edge under a corner legitimately changes, and less the band the
// dragged card sweeps. A frame that shows any of those pixels changed is a
// frame the user saw something wrong in: a card shaking, drawn twice, or
// blanked for a vblank.
//
// Beside the watcher's count, two things from inside:
// - `drawsInFlight`: draws into the window's backing store while a Present
//   of it has not completed. The server copies at the vblank, and what was
//   drawn meanwhile goes out with it — half a frame (ntk issue #223).
// - `churn`: the X11 panes over a GL surface made, dropped, moved and
//   resized, when the renderer is GL and core's overlay can be reached.
//
// X11 only: the watcher is an X client. Prints one RESULT line.
//   SCENE widgets|charts|lattice|fanout  GL=1  ZOOM  MS  EVERY (ms a step)
//   MAP=1  the minimap on (it changes with the drag: watch the cards clear of it)
//   OUT=dir  keep the watcher's first frame and its first bad ones as PNGs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import React, { useCallback } from 'react';
import { createRoot } from 'react-x11';

process.env.REACT_X11_NO_AUTORUN = '1';
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
    : SC === 'fanout'
      ? S.fanOut()
      : SC === 'charts'
        ? S.chartWidgets()
        : S.widgets();
const GL = process.env.GL === '1';
const zoom = Number(process.env.ZOOM ?? 1);
const MS = Number(process.env.MS ?? 3000);
const EVERY = Number(process.env.EVERY ?? 8);
const W = 1100,
  H = 720,
  PAD = 10,
  BORDER = 1;
const paneW = W - 2 * (PAD + BORDER),
  paneH = H - 2 * (PAD + BORDER);
const sizeOf = (n: any) => ({
  w: n.width ?? S.WIDGET_TYPES[n.type]?.size.width ?? 150,
  h: n.height ?? S.WIDGET_TYPES[n.type]?.size.height ?? 40,
});
// the dragged node: one near the middle, centred in the pane
const mid = scene.nodes[Math.floor(scene.nodes.length / 2) + 2];
const ms = sizeOf(mid);
const vp = {
  x: paneW / 2 - (mid.position.x + ms.w / 2) * zoom,
  y: paneH / 2 - (mid.position.y + ms.h / 2) * zoom,
  zoom,
};

// Core's overlay, for the pane counts: not on react-x11's exports map, so
// reached by file, and skipped where that file is not there.
const churn = {
  syncs: 0,
  made: 0,
  destroyed: 0,
  placed: 0,
  resized: 0,
  most: 0,
};
let counting = false;
try {
  const { GlOverlay } = await import(
    `${ROOT}/node_modules/react-x11/src/gloverlay.js`
  );
  const sync = GlOverlay.prototype.sync;
  GlOverlay.prototype.sync = function (this: any) {
    const before = new Map(this.panes.map((p: any) => [p, { ...p.rect }]));
    const changed = sync.call(this);
    if (counting) {
      churn.syncs++;
      const after = new Set(this.panes);
      for (const [pane, rect] of before as Map<any, any>) {
        if (!after.has(pane)) churn.destroyed++;
        else if (
          pane.rect.x !== rect.x ||
          pane.rect.y !== rect.y ||
          pane.rect.width !== rect.width ||
          pane.rect.height !== rect.height
        ) {
          churn.placed++;
          if (
            pane.rect.width !== rect.width ||
            pane.rect.height !== rect.height
          )
            churn.resized++;
        }
      }
      for (const pane of this.panes) if (!before.has(pane)) churn.made++;
      churn.most = Math.max(churn.most, this.panes.length);
    }
    return changed;
  };
} catch {
  // a core laid out otherwise: no pane counts
}

const wref: { current: any } = { current: null };
function App() {
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
      nodes,
      edges,
      onEdgesChange,
      onNodesChange,
      nodeTypes: S.WIDGET_TYPES,
      renderer: GL ? 'gl' : 'retained',
      // off unless asked for: it summarises every node, so a drag redraws
      // it, rightly, and it lies over the cards in the corner it is in
      minimap: process.env.MAP === '1',
      controls: true,
      background: { variant: 'dots', gap: 24 },
      adaptive: { budgetMs: 8 },
      defaultViewport: vp,
      style: {
        flexGrow: 1,
        borderWidth: BORDER,
        borderColor: '$border',
        borderRadius: 6,
      },
    }),
  );
}
const root = await createRoot({ glPolicy: 'auto' });
root.render(
  React.createElement(
    'window',
    { ref: wref, width: W, height: H, x: 20, y: 40, title: 'frames: drag' },
    React.createElement(
      'box',
      { style: { flexGrow: 1, padding: PAD } },
      React.createElement(App),
    ),
  ),
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(3000);
const wnd = wref.current;

// every other card in view, inset past its rounded corners, less the band
// the dragged card sweeps and the ink round a card
const cardRect = (n: any) => {
  const { w, h } = sizeOf(n);
  return {
    x: Math.round(PAD + BORDER + vp.x + n.position.x * zoom),
    y: Math.round(PAD + BORDER + vp.y + n.position.y * zoom),
    w: Math.round(w * zoom),
    h: Math.round(h * zoom),
  };
};
const INSET = 6;
const inView = (r: any) =>
  r.x >= PAD + BORDER + 2 &&
  r.y >= PAD + BORDER + 2 &&
  r.x + r.w <= W - PAD - BORDER - 2 &&
  r.y + r.h <= H - PAD - BORDER - 2;
const dragged = cardRect(mid);
const swept = {
  x: dragged.x - 200 - 16,
  y: dragged.y - 16,
  w: dragged.w + 400 + 32,
  h: dragged.h + 12 + 32,
};
const cards = scene.nodes
  .filter((n: any) => n !== mid)
  .map(cardRect)
  .map((r: any) => ({
    x: r.x + INSET,
    y: r.y + INSET,
    w: r.w - 2 * INSET,
    h: r.h - 2 * INSET,
  }))
  .filter((r: any) => r.w > 0 && r.h > 0 && inView(r));
let x0 = Infinity,
  y0 = Infinity,
  x1 = -Infinity,
  y1 = -Infinity;
for (const r of cards) {
  x0 = Math.min(x0, r.x);
  y0 = Math.min(y0, r.y);
  x1 = Math.max(x1, r.x + r.w);
  y1 = Math.max(y1, r.y + r.h);
}
const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

// the #223 hazard, counted where every draw into the backing store reports
let draws = 0,
  drawsInFlight = 0,
  run = false;
if (typeof wnd._markDirty === 'function') {
  const mark = wnd._markDirty.bind(wnd);
  wnd._markDirty = (bounds: unknown) => {
    if (run) {
      draws++;
      if (wnd._frame?.presentInFlight) drawsInFlight++;
    }
    return mark(bounds);
  };
}

const watcher = spawn(process.execPath, [
  fileURLToPath(new URL('./watch.mjs', import.meta.url)),
  JSON.stringify({
    wid: wnd.id,
    box,
    cards,
    exclude: [swept],
    ms: MS + 400,
    out: process.env.OUT,
  }),
]);
let watched = '';
watcher.stdout.on('data', (d) => (watched += d));
watcher.stderr.on('data', (d) => process.stderr.write(d));
const done = new Promise<string>((resolve) =>
  watcher.on('exit', () => resolve(watched.trim())),
);
await wait(150);

const s = wnd.scale ?? 1;
const t = () => Date.now() & 0x7fffffff;
const emit = (type: string, x: number, y: number, extra: any = {}) =>
  wnd.emit(type, {
    x: Math.round(x * s),
    y: Math.round(y * s),
    rootx: 0,
    rooty: 0,
    buttons: 256,
    time: t(),
    ...extra,
  });
// the header strip, a third of the way in
const px = PAD + BORDER + vp.x + (mid.position.x + ms.w / 3) * zoom;
const py = PAD + BORDER + vp.y + (mid.position.y + 8) * zoom;
emit('mousemove', px, py, { buttons: 0 });
await wait(100);
emit('mousedown', px, py, { keycode: 1, buttons: 0 });
await wait(30);
counting = true;
run = true;
const t0 = performance.now();
let steps = 0;
let x = px,
  dir = 1;
await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    x += 2 * dir;
    steps++;
    if (Math.abs(x - px) > 200) dir = -dir;
    emit('mousemove', x, py + (steps % 40) / 4);
    if (performance.now() - t0 > MS) {
      clearInterval(timer);
      resolve();
    }
  }, EVERY);
});
emit('mouseup', x, py, { keycode: 1 });
await wait(300);
run = false;
counting = false;
const seen = JSON.parse((await done) || '{}');
console.log(
  'RESULT ' +
    JSON.stringify({
      suite: 'frames',
      probe: 'drag',
      backend: 'x11',
      scene: SC,
      gl: GL,
      zoom,
      steps,
      cards: cards.length,
      samples: seen.samples ?? null,
      bad: seen.bad ?? null,
      runs: seen.runs ?? null,
      first: seen.events?.[0] ?? null,
      draws,
      drawsInFlight,
      churn: churn.syncs ? churn : null,
    }),
);
process.exit(0);
