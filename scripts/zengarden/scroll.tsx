// Scroll frames on a Zen Garden page: the page in <Html>, hosted as the
// browser example hosts it — a scale box in an `overflow: scroll` pane,
// `fontSize` 16 — in one process, on whichever backend REACT_X11_BACKEND
// names, its resources through the same disk cache the comparison uses.
// The pane is scrolled a step every 16 ms within each region in turn, and
// one line is printed a region:
//
//   RESULT {"region":"header","fps":…,"frame50":…,"frame95":…,"paint50":…,…}
//
// `frame` is the window's flush, `paint` the document's share of it,
// `damageH50` the height it repainted, in device pixels.
//
//   URL      the page, https://www.csszengarden.com/ by default
//   REGIONS  name:from:to,… in logical pixels of scroll, default the top,
//            the middle and the bottom 300 of the page
//   HOVER    x,y — a pointer parked there in logical window pixels, as a
//            user's is while they scroll: over a card on /pages/alldesigns/
//            its hover shadow is in every frame. Cocoa only.
//   STEP     pixels a step, default 20; DUR ms a region, default 3000
//
//   REACT_X11_BACKEND=cocoa npx tsx scripts/zengarden/scroll.tsx
//
// What it found first: Zen Garden's header and footer carry
// `box-shadow: inset 0 0 100px`, and a card on the all-designs page a 200px
// hover shadow. On a 2x display each strip a scroll exposed across one
// blurred it again: 11 to 18 frames a second. See react-x11's shadow tiles.
import { fileURLToPath } from 'node:url';

import React from 'react';
import { createRoot } from 'react-x11';
import { WindowNode } from 'react-x11/node';

import { Html } from '../../src/html/index.js';
import type { ResourceRequest } from '../../src/html/index.js';
import { resourceResult } from '../../examples/browser/network.js';
import { CachedNetwork } from './ours.js';

const h = React.createElement;
const W = Number(process.env.W ?? 1180);
const H = Number(process.env.H ?? 790);
const STEP = Number(process.env.STEP ?? 20);
const DUR = Number(process.env.DUR ?? 3000);
const URL_ = process.env.URL ?? 'https://www.csszengarden.com/';
const cache = fileURLToPath(
  new URL('../../zengarden-results/cache', import.meta.url),
);
const network = new CachedNetwork(cache);

const page = await network.document(URL_);
if (!page) throw new Error(`no document at ${URL_}`);
let pending = 0;
let settled = Date.now();
const onResource = (request: ResourceRequest) => {
  pending += 1;
  return network
    .resource(request.url, request.kind, page.url)
    .then((fetched) => (fetched ? resourceResult(fetched, request.kind) : null))
    .finally(() => {
      pending -= 1;
      settled = Date.now();
    });
};

interface Frame {
  ms: number;
  paint: number;
}
const frames: Frame[] = [];
let windowNode: { children: unknown[] } | null = null;
let paintMs = 0;
{
  const proto = WindowNode.prototype as unknown as {
    _flushFrame: (...a: unknown[]) => boolean;
  };
  const flush = proto._flushFrame;
  proto._flushFrame = function (this: never, ...a: unknown[]) {
    windowNode ??= this;
    paintMs = 0;
    const t0 = performance.now();
    const painted = flush.apply(this, a);
    if (painted) frames.push({ ms: performance.now() - t0, paint: paintMs });
    return painted;
  };
}

interface Pane {
  abs: { height: number };
  scrollTo(to: { x?: number; y?: number }): void;
}
const pane: { current: Pane | null } = { current: null };
const wref: { current: { app?: unknown; scale?: number } | null } = {
  current: null,
};
const root = await createRoot({});
root.render(
  h(
    'window',
    { ref: wref, width: W, height: H, x: 20, y: 40, title: 'zen scroll' },
    h(
      'box',
      {
        ref: pane,
        style: { overflow: 'scroll', flexGrow: 1, flexShrink: 1, minHeight: 0 },
      },
      h(
        'box',
        { scale: 1, style: { flexDirection: 'column', flexGrow: 1 } },
        h(Html, {
          fontSize: 16,
          source: page.source,
          partial: false,
          charset: page.charset,
          baseUrl: page.url,
          onResource,
          style: { flexGrow: 1 },
        }),
      ),
    ),
  ),
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
  await wait(100);
  if (pending === 0 && Date.now() - settled > 800 && wref.current) break;
}
await wait(1500);

interface ViewNode {
  kind: string;
  abs: { height: number };
  paintDamage?(): { height: number } | null;
  paint(ctx: unknown): void;
  children?: ViewNode[];
}
const find = (n: ViewNode | undefined): ViewNode | undefined =>
  n?.kind === 'htmlview' ? n : (n?.children ?? []).map(find).find(Boolean);
const view = find(windowNode as unknown as ViewNode);
if (!view) throw new Error('no <Html> in the window');
const damages: number[] = [];
{
  const proto = Object.getPrototypeOf(view) as ViewNode;
  const paint = proto.paint;
  proto.paint = function (this: ViewNode, ctx: unknown) {
    const t = performance.now();
    const damage = this.paintDamage?.();
    if (damage) damages.push(damage.height);
    try {
      return paint.call(this, ctx);
    } finally {
      paintMs += performance.now() - t;
    }
  };
}

const scale = wref.current?.scale ?? 1;
const bottom = Math.max(
  0,
  (view.abs.height - pane.current!.abs.height) / scale,
);
const regions: [string, number, number][] = process.env.REGIONS
  ? process.env.REGIONS.split(',').map((spec) => {
      const [name, from, to] = spec.split(':');
      return [name, Number(from), Number(to)];
    })
  : [
      ['header', 0, 300],
      ['middle', Math.round(bottom * 0.45), Math.round(bottom * 0.45) + 300],
      ['footer', Math.max(0, bottom - 300), bottom],
    ];

// a pointer parked over the page, through the Cocoa bridge's own entry for
// an NSEvent — X11 has no such thing to call without a server's input
const hover = process.env.HOVER?.split(',').map(Number);
const park = () => {
  const app = wref.current?.app as {
    _route?: (ev: unknown) => void;
    _windows?: Map<unknown, { _key: unknown }>;
  };
  if (!hover || typeof app?._route !== 'function') return;
  const win = [...app._windows!.values()][0];
  for (const dx of [0, 1]) {
    app._route({
      type: 'mousemove',
      handle: win._key,
      x: hover[0] + dx,
      y: hover[1],
      gx: hover[0] + dx,
      gy: hover[1],
      time: Date.now() & 0x7fffffff,
    });
  }
};

const q = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
for (const [name, from, to] of regions) {
  pane.current!.scrollTo({ x: 0, y: from });
  await wait(300);
  park();
  await wait(600);
  const f0 = frames.length;
  const d0 = damages.length;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let y = from;
  let dir = 1;
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      if (performance.now() - t0 >= DUR) {
        clearInterval(timer);
        done();
        return;
      }
      y += dir * STEP;
      if (y >= to) ((y = to), (dir = -1));
      if (y <= from) ((y = from), (dir = 1));
      pane.current!.scrollTo({ x: 0, y });
    }, 16);
  });
  await wait(300);
  const cpu = process.cpuUsage(cpu0);
  const seconds = (performance.now() - t0) / 1000;
  const run = frames.slice(f0);
  console.log(
    'RESULT ' +
      JSON.stringify({
        region: name,
        range: [from, to],
        fps: r2(run.length / seconds),
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
        paint50: r2(
          q(
            run.map((f) => f.paint),
            0.5,
          ),
        ),
        paint95: r2(
          q(
            run.map((f) => f.paint),
            0.95,
          ),
        ),
        damageH50: r2(q(damages.slice(d0), 0.5)),
        cpu: Math.round((cpu.user + cpu.system) / 1e4 / seconds),
      }),
  );
}
process.exit(0);
