// What `<Pdf>` costs on a real window: time to a whole first view, and what
// a frame comes to through a read, a flick and a zoom.
//
//   npx tsx scripts/bench/pdf.tsx <file.pdf> [--scale=<n>]
//
// Run it on the native backend, or on X11 with `REACT_X11_BACKEND=x11` and a
// `$DISPLAY`. The in-process server the suite runs on says nothing about an
// upload, so this is the only number here worth quoting.
import { readFileSync } from 'node:fs';
import { createRef } from 'react';
import { createRoot } from 'react-x11';

import { Pdf } from '../../src/pdf/index.js';
import type { PdfHandle, PdfViewStats } from '../../src/pdf/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: scripts/bench/pdf.tsx <file.pdf>');
  process.exit(2);
}
const data = new Uint8Array(readFileSync(file));
const ref = createRef<PdfHandle>();
const WIDTH = 1000;
const HEIGHT = 800;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const delta = (a: PdfViewStats, b: PdfViewStats) => ({
  paints: b.paints - a.paints,
  paintMs: +(
    (b.paintMs - a.paintMs) /
    Math.max(1, b.paints - a.paints)
  ).toFixed(2),
  tiles: b.tilesDrawn - a.tilesDrawn,
  uploadMs: +(
    (b.uploadMs - a.uploadMs) /
    Math.max(1, b.tilesDrawn - a.tilesDrawn)
  ).toFixed(2),
  composited: b.tilesComposited - a.tilesComposited,
  stale: b.staleComposited - a.staleComposited,
  incomplete: b.incomplete - a.incomplete,
});

const started = performance.now();
let loaded = 0;
const root = await createRoot();
root.render(
  <window title="pdf bench" width={WIDTH} height={HEIGHT}>
    <Pdf
      ref={ref}
      data={data}
      onLoad={() => (loaded = performance.now())}
      onError={(e) => console.error(e)}
    />
  </window>,
);
const app = (
  root as unknown as {
    app: { raiseWindow?(w: unknown): void; _windows?: Map<unknown, unknown> };
  }
).app;

while (!ref.current?.node?.stats.wholeAt) {
  await wait(4);
  if (performance.now() - started > 15000) break;
}
const node = ref.current!.node!;
const whole = node.stats.wholeAt;
await wait(200);
console.log(
  `load ${(loaded - started).toFixed(0)} ms, whole first view ${(whole - started).toFixed(0)} ms, ${(whole - loaded).toFixed(0)} ms after load`,
);
console.log(
  `pages ${ref.current!.pageCount}, zoom ${node.zoom.toFixed(3)}, scale ${node.scale}`,
);

async function drive(name: string, ms: number, step: () => void, every = 8) {
  const before = { ...node.stats };
  const until = performance.now() + ms;
  let longest = 0;
  let last = performance.now();
  while (performance.now() < until) {
    step();
    await wait(every);
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }
  await wait(250);
  console.log(
    name.padEnd(16),
    JSON.stringify(delta(before, node.stats)),
    `longest tick ${longest.toFixed(1)} ms`,
  );
}

await drive('read', 2000, () => node.scrollBy({ y: 3 }));
await drive('steady 2400px/s', 2000, () => node.scrollBy({ y: 16 }));
await drive('flick 24000px/s', 1500, () => node.scrollBy({ y: 160 }));
await drive('page down', 1500, () => node.scrollBy({ y: 700 }), 120);
await wait(300);
let zooming = 1.02;
let n = 0;
await drive(
  'zoom',
  1500,
  () => {
    node.zoomTo(node.zoom * zooming);
    if (++n % 30 === 0) zooming = 1 / zooming;
  },
  16,
);
await wait(400);
await drive('zoomed read', 1500, () => node.scrollBy({ y: 3, x: 2 }));
console.log('total', JSON.stringify(node.stats));
void app;
process.exit(0);
