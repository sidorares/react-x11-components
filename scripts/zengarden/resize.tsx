// Resize frames on Zen Garden designs: each page in <Html>, hosted as the
// browser example hosts it — a scale box in an `overflow: scroll` pane,
// `fontSize` 16 — on whichever backend REACT_X11_BACKEND names, its
// resources through the comparison's disk cache. Once the page has
// settled, the window is narrowed STEP logical pixels every EVERY ms, as
// the edge of a window moves under a drag, then widened back the same way,
// and one line is printed a design:
//
//   RESULT {"design":"001","frames":…,"laid":…,"flush50":…,"flushMax":…,…}
//
// `flush` is the window's frame, `update` the document's `_update` in it
// (`build` the styles and boxes, `layout` the rest), `paint` its paint;
// `laid` the frames that laid the document out at a new width, `partial`
// those that laid out only what can be seen, `builds` those that styled
// and built the boxes again — a breakpoint crossed — and `settle` the
// layout of the whole once the width rests. `resize` is the wall time from
// the first step until the last width is laid out whole, and `late` how
// much of it the steps ran past their clock, a frame holding the thread.
//
// The load comes first: `first` is the wall time from the render that
// mounts the page until the end of the first frame that paints the
// document — parsing, the stylesheets' wait, the cascade, the build, the
// layout and the paint — `firstFrame` that frame's own cost, and `load`
// the frames' cost until the last resource has arrived (`loadFrames` of
// them, `loadBuilds` building the boxes, `loadMax` the longest).
//
//   DESIGNS  001,002 or 001-050, default 001-221
//   W, H     the window, default 1180x790; STEP px a step, default 4;
//   STEPS    steps each way, default 40; EVERY ms a step, default 16
//   TO       narrowed to this instead, and not widened back (BACK=1 widens
//            it back the same steps): a width, or a
//            fraction of W — 0.25 is a quarter of it — in steps of STEP
//   TRACE    a design's per-frame rows as well
//   CACHE    the disk cache, default zengarden-results/cache
//   PROFILE  a file to write a CPU profile of the drags to, one design's
//   PROFILE_DIR  a directory to write two CPU profiles a design to:
//            <design>-load.cpuprofile and <design>-resize.cpuprofile, which
//            scripts/bench/sweep/cpuprofile.ts reads (ALL=1 for them all)
//   SNAP     a path prefix: the window as the page settled, before the drag,
//            written to <SNAP>-<design>.png where the backend snapshots
//
//   REACT_X11_BACKEND=cocoa npx tsx scripts/zengarden/resize.tsx
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { createRoot } from 'react-x11';
import { WindowNode } from 'react-x11/node';

import { Html, HtmlViewNode } from '../../src/html/index.js';
import type { ResourceRequest } from '../../src/html/index.js';
import { resourceResult } from '../../examples/browser/network.js';
import { CachedNetwork } from './ours.js';

const h = React.createElement;
const W = Number(process.env.W ?? 1180);
const H = Number(process.env.H ?? 790);
const STEP = Number(process.env.STEP ?? 4);
const STEPS = Number(process.env.STEPS ?? 40);
const EVERY = Number(process.env.EVERY ?? 16);
const TO = process.env.TO ? Number(process.env.TO) : null;
/** The widths the window is given, a step at a time. */
const widths = (): number[] => {
  if (TO !== null) {
    const to = Math.round(TO <= 1 ? W * TO : TO);
    const out: number[] = [];
    for (let w = W - STEP; w > to; w -= STEP) out.push(w);
    out.push(to);
    // BACK=1: and widened back to where it started, the same steps
    if (process.env.BACK === '1') {
      for (let i = out.length - 2; i >= 0; i -= 1) out.push(out[i]);
      out.push(W);
    }
    return out;
  }
  return Array.from({ length: 2 * STEPS }, (_, i) =>
    i < STEPS ? W - (i + 1) * STEP : W - (2 * STEPS - i - 1) * STEP,
  );
};
const cache =
  process.env.CACHE ??
  fileURLToPath(new URL('../../zengarden-results/cache', import.meta.url));
const network = new CachedNetwork(cache);

const designs = (process.env.DESIGNS ?? '001-221').split(',').flatMap((s) => {
  const [a, b] = s.split('-').map(Number);
  const to = b ?? a;
  return Array.from({ length: to - a + 1 }, (_, i) =>
    String(a + i).padStart(3, '0'),
  );
});

interface Frame {
  t: number;
  flush: number;
  update: number;
  build: number;
  paint: number;
  laid: boolean;
  partial: boolean;
  width: number;
  /** Whether the frame painted a document laid out. */
  drew: boolean;
  /** Whether it laid out whole a document laid out in part before. */
  settled: boolean;
}
const frames: Frame[] = [];
let windowNode: ViewNode | null = null;
let current: Omit<Frame, 't' | 'flush'> | null = null;
const fresh = () => ({
  update: 0,
  build: 0,
  paint: 0,
  laid: false,
  partial: false,
  width: 0,
  drew: false,
  settled: false,
});
{
  const proto = WindowNode.prototype as unknown as {
    _flushFrame: (...a: unknown[]) => boolean;
  };
  const flush = proto._flushFrame;
  proto._flushFrame = function (this: never, ...a: unknown[]) {
    windowNode ??= this;
    current = fresh();
    const t0 = performance.now();
    const painted = flush.apply(this, a);
    if (painted)
      frames.push({ t: t0, flush: performance.now() - t0, ...current });
    current = null;
    return painted;
  };
}

interface ViewNode {
  kind: string;
  abs: { height: number };
  children?: ViewNode[];
  _laidOutWidth: number;
  _partial: unknown;
  _tree?: { styles: Map<unknown, unknown> } | null;
  _update(...a: unknown[]): unknown;
  _requestBackgrounds(...a: unknown[]): unknown;
  paint(ctx: unknown): void;
}
// on the class, before the first page mounts, so that its load is counted
{
  const proto = HtmlViewNode.prototype as unknown as ViewNode;
  const update = proto._update;
  let started = 0;
  proto._update = function (this: ViewNode, ...a: unknown[]) {
    started = performance.now();
    const width = this._laidOutWidth;
    const partial = !!this._partial;
    try {
      return update.apply(this, a);
    } finally {
      if (current) {
        current.update += performance.now() - started;
        // the layout of the whole once the width rests, at the width the
        // part was laid out at
        if (partial && !this._partial && this._laidOutWidth === width) {
          current.settled = true;
        }
        if (this._laidOutWidth !== width) {
          current.laid = true;
          current.width = this._laidOutWidth;
          current.partial ||= !!this._partial;
        }
      }
    }
  };
  // the styles and boxes are built by the time the backgrounds are asked
  // for, and laid out after
  const backgrounds = proto._requestBackgrounds;
  proto._requestBackgrounds = function (this: ViewNode, ...a: unknown[]) {
    if (current) current.build += performance.now() - started;
    return backgrounds.apply(this, a);
  };
  const paint = proto.paint;
  proto.paint = function (this: ViewNode, ctx: unknown) {
    const t = performance.now();
    try {
      return paint.call(this, ctx);
    } finally {
      if (current) {
        current.paint += performance.now() - t;
        current.drew ||= this._laidOutWidth > 0;
      }
    }
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0;
};
const r1 = (v: number) => Math.round(v * 10) / 10;
const sum = (xs: Frame[], f: (x: Frame) => number) =>
  xs.reduce((s, x) => s + f(x), 0);

const root = await createRoot({});
const find = (n: ViewNode | null | undefined): ViewNode | undefined =>
  n?.kind === 'htmlview' ? n : (n?.children ?? []).map(find).find(Boolean);

for (const design of designs) {
  const url = `https://www.csszengarden.com/${design}/`;
  const page = await network.document(url).catch(() => null);
  if (!page) {
    console.log('RESULT ' + JSON.stringify({ design, error: 'no document' }));
    continue;
  }
  let pending = 0;
  let settled = performance.now();
  let arrived = 0;
  const onResource = (request: ResourceRequest) => {
    if (request.kind === 'video') return null;
    const kind = request.kind;
    pending += 1;
    return network
      .resource(request.url, kind, page.url)
      .then((fetched) => (fetched ? resourceResult(fetched, kind) : null))
      .finally(() => {
        pending -= 1;
        settled = arrived = performance.now();
      });
  };
  const render = (width: number) =>
    root.render(
      h(
        'window',
        { width, height: H, x: 20, y: 40, title: `zen ${design}` },
        h(
          'box',
          {
            style: {
              overflow: 'scroll',
              flexGrow: 1,
              flexShrink: 1,
              minHeight: 0,
            },
          },
          h(
            'box',
            { scale: 1, style: { flexDirection: 'column', flexGrow: 1 } },
            h(Html, {
              key: design,
              fontSize: 16,
              source: page.source,
              partial: false,
              charset: page.charset,
              baseUrl: page.url,
              reducedMotion: false,
              onResource,
              style: { flexGrow: 1 },
            }),
          ),
        ),
      ),
    );
  // what the design before left behind is not this one's to collect
  (globalThis as { gc?: () => void }).gc?.();
  const profiles = process.env.PROFILE_DIR;
  if (profiles) mkdirSync(profiles, { recursive: true });
  const profiler = async () => {
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
    return async (name: string) => {
      const { profile } = await session.post('Profiler.stop');
      writeFileSync(
        join(profiles!, `${design}-${name}.cpuprofile`),
        JSON.stringify(profile),
      );
      session.disconnect();
    };
  };
  const loadProfile = profiles ? await profiler() : null;
  let width = W;
  const fLoad = frames.length;
  const loadStart = performance.now();
  render(width);
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    await wait(100);
    if (pending === 0 && performance.now() - settled > 800 && windowNode) {
      break;
    }
  }
  await wait(1200);
  await loadProfile?.('load');
  const view = find(windowNode);
  if (!view) {
    console.log('RESULT ' + JSON.stringify({ design, error: 'no view' }));
    continue;
  }
  // the frames until the last resource arrived, and the one that took it
  const loading = frames
    .slice(fLoad)
    .filter((f, i) => i === 0 || f.t <= Math.max(arrived, loadStart) + 50);
  const firstDrawn = frames.slice(fLoad).find((f) => f.drew);
  if (process.env.SNAP) {
    const app = (windowNode as unknown as { app?: unknown }).app as {
      _windows?: Map<unknown, { snapshot?(file: string): unknown }>;
    };
    for (const win of app?._windows?.values() ?? []) {
      win.snapshot?.(`${process.env.SNAP}-${design}.png`);
    }
  }
  const session = process.env.PROFILE ? new Session() : null;
  if (session) {
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
  }
  const resizeProfile = profiles ? await profiler() : null;
  const steps = widths();
  const f0 = frames.length;
  const t0 = performance.now();
  for (const next of steps) {
    width = next;
    render(width);
    await wait(EVERY);
  }
  const dragEnd = performance.now();
  if (session) {
    const { profile } = await session.post('Profiler.stop');
    writeFileSync(process.env.PROFILE!, JSON.stringify(profile));
    session.disconnect();
  }
  await wait(700);
  await resizeProfile?.('resize');
  const all = frames.slice(f0);
  const drag = all.filter((f) => f.t < dragEnd);
  const laid = drag.filter((f) => f.laid);
  const builds = drag.filter((f) => f.build > 0);
  const after = all.filter((f) => f.t >= dragEnd && (f.laid || f.settled));
  const seconds = (dragEnd - t0) / 1000;
  const flushes = drag.map((f) => f.flush);
  const lastLaid = Math.max(
    dragEnd,
    ...all.filter((f) => f.laid || f.settled).map((f) => f.t + f.flush),
  );
  console.log(
    'RESULT ' +
      JSON.stringify({
        design,
        height: Math.round(view.abs.height),
        elements: view._tree?.styles.size ?? 0,
        first: firstDrawn
          ? r1(firstDrawn.t + firstDrawn.flush - loadStart)
          : null,
        firstFrame: firstDrawn ? r1(firstDrawn.flush) : null,
        firstBuild: firstDrawn ? r1(firstDrawn.build) : null,
        firstLayout: firstDrawn
          ? r1(firstDrawn.update - firstDrawn.build)
          : null,
        firstPaint: firstDrawn ? r1(firstDrawn.paint) : null,
        load: r1(loading.reduce((s, f) => s + f.flush, 0)),
        loadFrames: loading.length,
        loadBuilds: loading.filter((f) => f.build > 0).length,
        loadMax: r1(Math.max(0, ...loading.map((f) => f.flush))),
        resize: r1(lastLaid - t0),
        late: r1(dragEnd - t0 - steps.length * EVERY),
        // the frames' own cost over the drag and the settle, and its parts:
        // the rest of a frame is core's layout and the window's own paint
        cpu: r1(sum(all, (f) => f.flush)),
        cpuBuild: r1(sum(all, (f) => f.build)),
        cpuLayout: r1(sum(all, (f) => f.update - f.build)),
        cpuPaint: r1(sum(all, (f) => f.paint)),
        steps: steps.length,
        frames: drag.length,
        laid: laid.length,
        laidPerS: r1(laid.length / seconds),
        partial: laid.filter((f) => f.partial).length,
        builds: builds.length,
        flush50: r1(q(flushes, 0.5)),
        flush95: r1(q(flushes, 0.95)),
        flushMax: r1(Math.max(0, ...flushes)),
        update50: r1(
          q(
            laid.map((f) => f.update),
            0.5,
          ),
        ),
        buildMax: r1(Math.max(0, ...builds.map((f) => f.build))),
        paint50: r1(
          q(
            drag.map((f) => f.paint),
            0.5,
          ),
        ),
        paintMax: r1(Math.max(0, ...drag.map((f) => f.paint))),
        settle: after.map((f) => r1(f.flush)),
        // the slowest frames, with the width each laid out at
        worst: [...drag]
          .sort((a, b) => b.flush - a.flush)
          .slice(0, 3)
          .map((f) => [
            f.width,
            r1(f.flush),
            r1(f.update),
            r1(f.build),
            r1(f.paint),
          ]),
      }),
  );
  if (process.env.TRACE)
    for (const f of all)
      console.log(
        'TRACE ' +
          JSON.stringify({
            t: r1(f.t - t0),
            flush: r1(f.flush),
            update: r1(f.update),
            build: r1(f.build),
            paint: r1(f.paint),
            laid: f.laid,
            partial: f.partial,
            width: f.width,
          }),
      );
}
root.unmount?.();
process.exit(0);
