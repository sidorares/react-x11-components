// One cell of the documents sweep, on whichever backend REACT_X11_BACKEND
// names: a generated document (./docgen.ts) in <Markdown> or <Html>, in a
// scroll pane the way the examples host them. Prints one JSON line.
//   COMP     md | html
//   SIZE     sections, default 300 (~100k words)
//   ACTION   mount   render it; time to the first painted frame and to idle
//            reflow  the window's width swept 1000 <-> 640, a step a frame
//            edit    one paragraph mid-document rewritten every 100 ms
//            append  a section appended every 50 ms, `partial`
//            scroll  the pane wheeled, 60 notches a second
// Frames are the window's own flushes that painted; `lat` is from a change
// to the end of the flush that first painted after it.
import * as gen from './docgen.js';
import { fileURLToPath } from 'node:url';
import React, { useState } from 'react';
import { createRoot } from 'react-x11';
import { WindowNode } from 'react-x11/node';
process.env.REACT_X11_NO_AUTORUN = '1';
// The tree under test: this checkout by default, or another one's root
// when the probe is copied into that tree's node_modules/.bench (README).
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const COMP = process.env.COMP ?? 'md';
const ACTION = process.env.ACTION ?? 'mount';
const SIZE = Number(process.env.SIZE ?? 300);
const { Markdown } = await import(`${ROOT}/src/markdown/index.js`);
const { Html } = await import(`${ROOT}/src/html/index.js`);

const h = React.createElement;
const W = 1000,
  H = 760;

const secs = gen.sections(SIZE + (ACTION === 'append' ? 200 : 0));
const base = secs.slice(0, SIZE);
const docOf = (list: typeof secs, open = false): string => {
  if (COMP === 'md') return gen.markdownDoc(list);
  const full = gen.htmlDoc(list);
  return open ? full.replace(/\n<\/body><\/html>$/, '\n') : full;
};

const frames: { t: number; end: number; ms: number }[] = [];
let windowNode: any = null;
{
  const inner = (WindowNode as any).prototype._flushFrame;
  (WindowNode as any).prototype._flushFrame = function (
    this: any,
    ...a: any[]
  ) {
    windowNode ??= this;
    const t0 = performance.now();
    const painted = inner.apply(this, a);
    const end = performance.now();
    if (painted) frames.push({ t: t0, end, ms: end - t0 });
    return painted;
  };
}

let setSource: (s: string) => void = () => {};
let setWidth: (w: number) => void = () => {};
const wref: { current: any } = { current: null };
const pane: { current: any } = { current: null };
function Doc(props: { initial: string }) {
  const [source, set] = useState(props.initial);
  const [width, setW] = useState(W);
  setSource = set;
  setWidth = setW;
  return h(
    'window',
    { ref: wref, width, height: H, x: 20, y: 40, title: 'docsweep' },
    h(
      'box',
      { ref: pane, style: { flexGrow: 1, overflow: 'scroll' } },
      COMP === 'md'
        ? h(Markdown, {
            source,
            partial: ACTION === 'append',
            style: { padding: 16 },
          })
        : h(Html, { source, partial: ACTION === 'append' }),
    ),
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = async (gap: number, max: number) => {
  const start = performance.now();
  for (;;) {
    await wait(50);
    const last = frames.length ? frames[frames.length - 1].end : start;
    if (performance.now() - last > gap || performance.now() - start > max)
      return;
  }
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const q = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const countTree = () => {
  let nodes = 0;
  const walk = (n: any) => {
    if (n.yoga) nodes++;
    for (const c of n.children ?? []) walk(c);
  };
  if (windowNode) walk(windowNode);
  return nodes;
};

const initial = docOf(base, ACTION === 'append');
const root = await createRoot({ glPolicy: 'auto' });
const c0 = process.cpuUsage();
const tMount = performance.now();
root.render(h(Doc, { initial }));
await quiet(1000, 30000);
const mountCpu = process.cpuUsage(c0);
const mountFrames = frames.filter((f) => f.t >= tMount);
const out: any = {
  suite: 'docs',
  comp: COMP,
  size: SIZE,
  chars: initial.length,
  action: ACTION,
  backend: typeof wref.current?.app?._route === 'function' ? 'cocoa' : 'x11',
  firstPaint: r2(mountFrames.length ? mountFrames[0].end - tMount : NaN),
  firstFlush: r2(mountFrames.length ? mountFrames[0].ms : NaN),
  idle: r2(
    mountFrames.length ? mountFrames[mountFrames.length - 1].end - tMount : NaN,
  ),
  mountFrames: mountFrames.length,
  mountCpu: Math.round((mountCpu.user + mountCpu.system) / 1000),
  nodes: countTree(),
  layoutPasses: windowNode?._layoutPasses,
};

if (ACTION !== 'mount') {
  const wnd = wref.current;
  const cocoa = typeof wnd.app?._route === 'function';
  const s = wnd.scale ?? 1;
  const tm = () => Date.now() & 0x7fffffff;
  const DUR = 4000;
  const lats: number[] = [];
  const marks: number[] = [];
  const f0 = frames.length;
  const lp0 = windowNode._layoutPasses ?? 0;
  const phases: Record<string, number> = {};
  if (process.env.NO_FLOORS === '1') {
    // ceiling experiment: the frame without the measuring passes
    windowNode._applyContentFloors = function (
      this: any,
      width: number,
      height: number,
    ) {
      this._layoutRoot(width, height);
      this._floorsDirty = false;
      this._floorsContentDirty = false;
      this._floorsSwept = true;
      this._floorsWidth = width;
      this._floorsSources.clear();
      this._floorsUnscoped = false;
      this._floorsScopeNow = null;
    };
  }
  if (process.env.PHASES === '1') {
    for (const name of [
      '_collectFloorStale',
      '_refit',
      '_measureWidthFloors',
      '_measureHeightFloors',
      '_probeHeightFloors',
      '_layoutRoot',
      '_absolutizeChildren',
      '_placeNodes',
      '_paintRegion',
      '_applyContentFloors',
      '_layoutStep',
    ]) {
      const inner = windowNode[name];
      if (typeof inner !== 'function') continue;
      windowNode[name] = function (this: any, ...a: any[]) {
        const t = performance.now();
        try {
          return inner.apply(this, a);
        } finally {
          phases[name] = (phases[name] ?? 0) + performance.now() - t;
        }
      };
    }
  }
  const c1 = process.cpuUsage();
  const t0 = performance.now();
  const every = (ms: number, fn: (i: number) => void) =>
    new Promise<void>((done) => {
      let i = 0;
      const timer = setInterval(() => {
        if (performance.now() - t0 >= DUR) {
          clearInterval(timer);
          done();
          return;
        }
        marks.push(performance.now());
        fn(i++);
      }, ms);
    });
  if (ACTION === 'reflow') {
    let w = W,
      dir = -1;
    await every(16, () => {
      w += dir * 24;
      if (w <= 640 || w >= W) dir = -dir;
      setWidth(w);
    });
  } else if (ACTION === 'edit') {
    const mid = Math.floor(SIZE / 2);
    await every(100, (i) => {
      const edited = base.slice();
      const sec = edited[mid];
      edited[mid] = {
        ...sec,
        paras: [
          { ...sec.paras[0], text: sec.paras[0].text + ` edit ${i}` },
          ...sec.paras.slice(1),
        ],
      };
      setSource(docOf(edited));
    });
  } else if (ACTION === 'append') {
    await every(50, (i) => setSource(docOf(secs.slice(0, SIZE + i + 1), true)));
  } else if (ACTION === 'scroll') {
    const b = pane.current.abs;
    const cx = (b.x + b.width / 2) / s,
      cy = (b.y + b.height / 2) / s;
    let dir = 1;
    await every(16, (i) => {
      if (i > 0 && i % 90 === 0) dir = -dir;
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
    });
  }
  await quiet(300, 5000);
  const cu = process.cpuUsage(c1);
  const dt = (performance.now() - t0) / 1000;
  const run = frames.slice(f0);
  for (const m of marks) {
    const f = run.find((x) => x.end > m);
    if (f) lats.push(f.end - m);
  }
  const iv = run.slice(1).map((f, i) => f.t - run[i].t);
  Object.assign(out, {
    fps: r2(run.length / dt),
    p50: r2(q(iv, 0.5)),
    p95: r2(q(iv, 0.95)),
    frame50: r2(
      q(
        run.map((f) => f.ms),
        0.5,
      ),
    ),
    frame95: r2(
      q(
        run.map((f) => f.ms),
        0.95,
      ),
    ),
    frameMax: r2(Math.max(...run.map((f) => f.ms))),
    lat50: r2(q(lats, 0.5)),
    lat95: r2(q(lats, 0.95)),
    cpu: Math.round((cu.user + cu.system) / 1e4 / dt),
    passesPerFrame: r2(
      ((windowNode._layoutPasses ?? 0) - lp0) / Math.max(1, run.length),
    ),
    nodesAfter: countTree(),
  });
  if (process.env.PHASES === '1')
    out.phasesPerFrame = Object.fromEntries(
      Object.entries(phases).map(([k, v]) => [
        k,
        r2(v / Math.max(1, run.length)),
      ]),
    );
}
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
