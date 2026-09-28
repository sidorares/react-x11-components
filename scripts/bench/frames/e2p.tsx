// Event to pixel on Cocoa: how long after a pointer move the screen shows a
// <Flow> node where the move put it.
//
// The stress example's pane and its widgets scene, either renderer (GL=1),
// at a zoom (ZOOM). The node in the middle of the view is filled #ff00ff,
// pressed, and moved in jumps of JUMP logical pixels, GAP ms apart — each
// jump handed to the app (`CocoaApp._route`) and timed on
// process.hrtime.bigint(). Beside the app, ./cocoa-capture.swift streams the
// window through ScreenCaptureKit and says, for every frame whose content
// changed, when the display showed it and where the magenta was. A jump's
// latency is its event to the display time of the first frame that moved
// the node, and to the first from which every frame shows it at rest; a
// frame on the way that shows it wider than at rest is two layers drawing
// it at two places.
//
// The window is raised for the run and the real pointer held back from it
// meanwhile — a real move with no button down would end the drag.
//
// STAGES=1 times the way there too, in the process and on the same clock:
// the drag's change, the window's flush, the GL frame's swap, the GL
// overlay's paint and each IOSurface flip — and, per jump, how long after
// the swap and after the flush the pixel came.
//
// Cocoa only, and the window must stay uncovered: an occluded Cocoa window
// gets no frames. Needs Screen Recording for the terminal that runs it.
// Prints one RESULT line.
//   GL=1  ZOOM (0.95)  STEPS (30)  GAP (250)  JUMP (24)  STAGES=1
//   OUT=file  the capture's frames; CAPTURE=path  where the capture is built
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { useCallback } from 'react';
import { createRoot } from 'react-x11';
import { GlAreaNode, WindowNode } from 'react-x11/node';

process.env.REACT_X11_NO_AUTORUN = '1';
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const { Flow, useNodesState, useEdgesState } = await import(
  `${ROOT}/src/flow/index.js`
);
const S: any = await import(`${ROOT}/examples/flow-stress.tsx`);
const GL = (process.env.GL ?? '1') === '1';
const zoom = Number(process.env.ZOOM ?? 0.95);
const STEPS = Number(process.env.STEPS ?? 30);
const GAP = Number(process.env.GAP ?? 250);
const JUMP = Number(process.env.JUMP ?? 24);
const STAGES = process.env.STAGES === '1';
const OUT =
  process.env.OUT ?? join(tmpdir(), `react-x11-e2p-${process.pid}.txt`);

// the capture, built on first use and again when its source changes
const source = fileURLToPath(new URL('./cocoa-capture.swift', import.meta.url));
const capture =
  process.env.CAPTURE ?? join(tmpdir(), 'react-x11-cocoa-capture');
if (
  !existsSync(capture) ||
  statSync(capture).mtimeMs < statSync(source).mtimeMs
) {
  const built = spawnSync('swiftc', ['-O', source, '-o', capture], {
    stdio: 'inherit',
  });
  if (built.status !== 0) throw new Error('swiftc could not build the capture');
}

const scene = S.widgets();
const midIndex = Math.floor(scene.nodes.length / 2);
const mid = scene.nodes[midIndex];
// the dragged node in a colour nothing else on screen has
scene.nodes[midIndex] = {
  ...mid,
  style: { ...(mid.style ?? {}), background: '#ff00ff' },
};
const W = 1100,
  H = 720,
  PAD = 10,
  BORDER = 1;
const paneW = W - 2 * (PAD + BORDER),
  paneH = H - 2 * (PAD + BORDER);
const mw = mid.width ?? 150,
  mh = mid.height ?? 40;
const vp = {
  x: paneW / 2 - (mid.position.x + mw / 2) * zoom,
  y: paneH / 2 - (mid.position.y + mh / 2) * zoom,
  zoom,
};

// STAGES: the first of each after a jump, on the same clock
const stamps: Record<string, bigint[]> = {
  change: [],
  gl: [],
  overlay: [],
  flush: [],
};
let stamping = false;
const stamp = (k: string): void => {
  if (stamping) stamps[k].push(process.hrtime.bigint());
};
if (STAGES) {
  const glProto = GlAreaNode.prototype as any;
  const draw = glProto._drawFrameNow;
  glProto._drawFrameNow = function (this: unknown, now: number) {
    const drawn = draw.call(this, now);
    if (drawn) stamp('gl');
    return drawn;
  };
  const winProto = WindowNode.prototype as any;
  const flush = winProto._flushFrame;
  winProto._flushFrame = function (this: unknown, ...a: unknown[]) {
    const painted = flush.apply(this, a);
    if (painted) stamp('flush');
    return painted;
  };
  // core's GL overlay is off its exports map: by the file, beside its index
  const core = import.meta.resolve('react-x11');
  const { GlOverlay } = await import(new URL('gloverlay.js', core).href);
  const paint = GlOverlay.prototype.paint;
  GlOverlay.prototype.paint = function (this: unknown, damage: unknown) {
    const r = paint.call(this, damage);
    stamp('overlay');
    return r;
  };
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
      onNodesChange: (c: unknown) => {
        stamp('change');
        onNodesChange(c);
      },
      nodeTypes: S.WIDGET_TYPES,
      renderer: GL ? 'gl' : 'retained',
      minimap: true,
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
    { ref: wref, width: W, height: H, x: 20, y: 40, title: 'e2p' },
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
if (typeof wnd?.app?._route !== 'function') {
  throw new Error('e2p is Cocoa only: REACT_X11_BACKEND=cocoa');
}
wnd.app.raiseWindow(wnd);
await wait(800);

// every IOSurface flip after a jump, by the layer it is for
const flips: { t: bigint; layer: unknown }[] = [];
const nat = wnd.app._native;
if (STAGES && typeof nat?.setLayerContentsIOSurface === 'function') {
  const flip = nat.setLayerContentsIOSurface.bind(nat);
  nat.setLayerContentsIOSurface = (layer: unknown, id: number) => {
    if (stamping) flips.push({ t: process.hrtime.bigint(), layer });
    return flip(layer, id);
  };
}

const seconds = (STEPS * GAP + 2000) / 1000;
const cap = spawn(capture, [String(process.pid), String(seconds), OUT], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise<void>((resolve, reject) => {
  cap.stdout.on('data', (d) => {
    if (String(d).includes('ready')) resolve();
  });
  cap.on('exit', (code) => reject(new Error(`the capture exited ${code}`)));
});
const done = new Promise<void>((resolve) => cap.on('exit', () => resolve()));

// the real pointer is held back while the probe drives its own
const route = wnd.app._route.bind(wnd.app);
const OURS = Symbol('ours');
wnd.app._route = (ev: any) => {
  if (ev?.[OURS]) return route(ev);
  if (typeof ev?.type === 'string' && /^(mouse|wheel|drag)/.test(ev.type)) {
    return;
  }
  return route(ev);
};
const t32 = () => Date.now() & 0x7fffffff;
const emit = (type: string, x: number, y: number, button = 0) =>
  wnd.app._route({
    type,
    handle: wnd._key,
    x,
    y,
    gx: x,
    gy: y,
    button,
    time: t32(),
    [OURS]: true,
  });

let px = PAD + BORDER + vp.x + (mid.position.x + mw / 3) * zoom;
const py = PAD + BORDER + vp.y + (mid.position.y + 8) * zoom;
await wait(300);
emit('mousemove', px, py);
await wait(150);
emit('mousedown', px, py, 1);
await wait(150);
// a first move past the drag threshold, left out of the timings
px += 8;
emit('mousemove', px, py);
await wait(GAP * 2);
const events: bigint[] = [];
stamping = true;
let dir = 1;
for (let i = 0; i < STEPS; i++) {
  if (i % 10 === 0 && i > 0) dir = -dir;
  px += JUMP * dir;
  const at = process.hrtime.bigint();
  emit('mousemove', px, py);
  events.push(at);
  await wait(GAP);
}
stamping = false;
emit('mouseup', px, py, 1);
await done;

type Frame = { t: bigint; minX: number; maxX: number; n: number };
const frames: Frame[] = readFileSync(OUT, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [t, minX, maxX, n] = l.split(' ');
    return {
      t: BigInt(t),
      minX: Number(minX),
      maxX: Number(maxX),
      n: Number(n),
    };
  });
const ms = (a: bigint, b: bigint) => Number(a - b) / 1e6;
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length
    ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1)
    : null;
};
const first: number[] = [];
const settled: number[] = [];
const afterSwap: number[] = [];
const afterFlush: number[] = [];
let doubled = 0;
let jumpsDoubled = 0;
for (let i = 0; i < events.length; i++) {
  const T = events[i];
  const next = i + 1 < events.length ? events[i + 1] : T + BigInt(GAP * 1e6);
  const before = [...frames].reverse().find((f) => f.t < T);
  const rested = [...frames].reverse().find((f) => f.t < next);
  if (!before || !rested || rested.minX < 0) continue;
  const moved = frames.find(
    (f) =>
      f.t > T &&
      f.t < next &&
      (f.minX !== before.minX || f.maxX !== before.maxX),
  );
  if (moved) {
    first.push(ms(moved.t, T));
    const gl = stamps.gl.find((t) => t > T && t < next);
    const fl = stamps.flush.find((t) => t > T && t < next);
    if (gl !== undefined) afterSwap.push(ms(moved.t, gl));
    if (fl !== undefined) afterFlush.push(ms(moved.t, fl));
  }
  // the first frame from which every frame is the jump's rest
  let rest: Frame | undefined;
  for (const f of frames) {
    if (f.t <= T || f.t >= next) continue;
    if (f.minX === rested.minX && f.maxX === rested.maxX) rest ??= f;
    else rest = undefined;
  }
  if (rest) settled.push(ms(rest.t, T));
  const width = rested.maxX - rested.minX;
  const wide = frames.filter(
    (f) => f.t > T && f.t < next && f.minX >= 0 && f.maxX - f.minX > width + 2,
  ).length;
  doubled += wide;
  if (wide) jumpsDoubled++;
}

const stages: Record<string, unknown> = {};
if (STAGES) {
  for (const k of Object.keys(stamps)) {
    const after: number[] = [];
    for (let i = 0; i < events.length; i++) {
      const T = events[i];
      const next =
        i + 1 < events.length ? events[i + 1] : T + BigInt(GAP * 1e6);
      const hit = stamps[k].find((t) => t > T && t < next);
      if (hit !== undefined) after.push(ms(hit, T));
    }
    stages[k] = q(after, 0.5);
  }
  const ids = new Map<unknown, number>();
  const byLayer = new Map<number, number[]>();
  for (let i = 0; i < events.length; i++) {
    const T = events[i];
    const next = i + 1 < events.length ? events[i + 1] : T + BigInt(GAP * 1e6);
    const seen = new Set<unknown>();
    for (const f of flips) {
      if (f.t <= T || f.t >= next || seen.has(f.layer)) continue;
      seen.add(f.layer);
      if (!ids.has(f.layer)) ids.set(f.layer, ids.size);
      const id = ids.get(f.layer)!;
      if (!byLayer.has(id)) byLayer.set(id, []);
      byLayer.get(id)!.push(ms(f.t, T));
    }
  }
  stages.flips = Object.fromEntries(
    [...byLayer].map(([id, v]) => [`layer${id}`, q(v, 0.5)]),
  );
  stages.afterSwap = q(afterSwap, 0.5);
  stages.afterFlush = q(afterFlush, 0.5);
}

console.log(
  'RESULT ' +
    JSON.stringify({
      suite: 'frames',
      probe: 'e2p',
      backend: 'cocoa',
      scene: 'widgets',
      renderer: GL ? 'gl' : '2d',
      zoom,
      jumps: events.length,
      frames: frames.length,
      first50: q(first, 0.5),
      first90: q(first, 0.9),
      settled50: q(settled, 0.5),
      settled90: q(settled, 0.9),
      doubledFrames: doubled,
      jumpsDoubled,
      ...(STAGES ? { stages } : {}),
    }),
);
process.exit(0);
