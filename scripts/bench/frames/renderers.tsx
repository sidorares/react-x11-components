// 2D against GL: one <Flow> scene, viewport and state drawn by both
// renderers, in two windows of one process, read back and compared as ink.
//
// The two renderers draw the same graph through different rasterizers —
// XRender trapezoids and glyphs against GL triangles and distance-field
// text — so they are never pixel-equal, and nothing here asks them to be.
// A pixel is *ink* where it differs from the pane's background by more than
// INK_T in any channel, and ink is matched within R pixels: `missing` is 2D
// ink with no GL ink that close, `extra` the other way round. Antialiasing
// moves ink by a pixel; a band of ground over the frame, an edge that stops
// short, an arrowhead or a card that is not drawn do not hide in R.
//
// This is what found X11 panes covering 16 px of the GL frame round every
// card with mounted bodies (react-x11 #717), 9% of the 2D ink missing.
//
// X11 only: it reads the windows back with GetImage. Prints one RESULT line.
//   SCENE widgets|charts|lattice|fanout  ZOOM  BG dots|lines|none
//   INK_T (default 40)  R (default 2)  SETTLE (ms before reading)
//   OUT=dir  write both captures and the diff (red missing, blue extra)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createRoot } from 'react-x11';

// pngjs comes with the dependencies and without declarations; a specifier
// the compiler does not resolve keeps it out of the type check
const pngjs = 'pngjs';
const { PNG } = (await import(pngjs)) as {
  PNG: {
    new (o: { width: number; height: number }): { data: Buffer };
    sync: { write(png: unknown): Buffer };
  };
};

process.env.REACT_X11_NO_AUTORUN = '1';
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const { Flow } = await import(`${ROOT}/src/flow/index.js`);
const S: any = await import(`${ROOT}/examples/flow-stress.tsx`);
const SC = process.env.SCENE ?? 'widgets';
const scene =
  SC === 'lattice'
    ? S.lattice(Number(process.env.NODES ?? 60))
    : SC === 'fanout'
      ? S.fanOut()
      : SC === 'charts'
        ? S.chartWidgets()
        : S.widgets();
const zoom = Number(process.env.ZOOM ?? 1);
const W = Number(process.env.W ?? 900),
  H = Number(process.env.H ?? 600);
const INK_T = Number(process.env.INK_T ?? 40);
const R = Number(process.env.R ?? 2);
const OUT = process.env.OUT;
const mid = scene.nodes[Math.floor(scene.nodes.length / 2)];
const vp = {
  x: W / 2 - (mid.position.x + 100) * zoom,
  y: H / 2 - (mid.position.y + 60) * zoom,
  zoom,
};
const windows: Record<string, any> = {};
const frames: Record<string, number> = { retained: 0, gl: 0 };
const pane = (renderer: string) =>
  React.createElement(
    'window',
    {
      key: renderer,
      ref: (w: any) => (windows[renderer] = w),
      width: W,
      height: H,
      x: renderer === 'gl' ? W + 40 : 20,
      y: 40,
      title: `frames: ${renderer}`,
    },
    React.createElement(Flow, {
      defaultNodes: scene.nodes,
      defaultEdges: scene.edges,
      nodeTypes: S.WIDGET_TYPES,
      renderer,
      defaultViewport: vp,
      background:
        process.env.BG === 'none'
          ? undefined
          : { variant: process.env.BG ?? 'dots', gap: 24 },
      minimap: false,
      controls: false,
      onFrame: () => frames[renderer]++,
      style: { flexGrow: 1 },
    }),
  );
const root = await createRoot({ glPolicy: 'auto' });
root.render(
  React.createElement(React.Fragment, null, pane('retained'), pane('gl')),
);
await new Promise((r) => setTimeout(r, Number(process.env.SETTLE ?? 3500)));

const grab = (w: any): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    w.X.GetImage(2, w.id, 0, 0, W, H, 0xffffffff, (e: any, img: any) =>
      e ? reject(e) : resolve(Buffer.from(img.data)),
    ),
  );
const a = await grab(windows.retained);
const b = await grab(windows.gl);
// ZPixmap from a little-endian server with the standard visual: BGRx
const rgb = (buf: Buffer, i: number): [number, number, number] => [
  buf[i * 4 + 2],
  buf[i * 4 + 1],
  buf[i * 4],
];
// the background: the commonest colour of the 2D capture
const counts = new Map<number, number>();
for (let i = 0; i < W * H; i++) {
  const [r, g, bl] = rgb(a, i);
  const key = (r << 16) | (g << 8) | bl;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const bg = [...counts.entries()].sort((p, q) => q[1] - p[1])[0][0];
const ground = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255];
const inkOf = (buf: Buffer) => {
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const c = rgb(buf, i);
    if (c.some((v, k) => Math.abs(v - ground[k]) > INK_T)) m[i] = 1;
  }
  return m;
};
const inkA = inkOf(a),
  inkB = inkOf(b);
const near = (m: Uint8Array, x: number, y: number) => {
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx,
        yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && m[yy * W + xx]) return true;
    }
  }
  return false;
};
// the window's own edge is no renderer's
const E = 3;
let missing = 0,
  extra = 0,
  totalA = 0,
  totalB = 0;
const marks = new Uint8Array(W * H);
for (let y = E; y < H - E; y++) {
  for (let x = E; x < W - E; x++) {
    const i = y * W + x;
    if (inkA[i]) totalA++;
    if (inkB[i]) totalB++;
    if (inkA[i] && !near(inkB, x, y)) {
      missing++;
      marks[i] = 1;
    } else if (inkB[i] && !near(inkA, x, y)) {
      extra++;
      marks[i] = 2;
    }
  }
}
if (OUT) {
  mkdirSync(OUT, { recursive: true });
  const save = (name: string, px: (i: number) => number[]) => {
    const png = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H; i++) {
      const [r, g, bl] = px(i);
      png.data.set([r, g, bl, 255], i * 4);
    }
    writeFileSync(`${OUT}/${name}.png`, PNG.sync.write(png));
  };
  save('2d', (i) => rgb(a, i));
  save('gl', (i) => rgb(b, i));
  save('diff', (i) => {
    if (marks[i] === 1) return [255, 0, 0];
    if (marks[i] === 2) return [0, 80, 255];
    const l = rgb(a, i).reduce((s, v) => s + v, 0) / 3;
    const faded = Math.round(255 - (255 - l) * 0.3);
    return [faded, faded, faded];
  });
}
console.log(
  'RESULT ' +
    JSON.stringify({
      suite: 'frames',
      probe: 'renderers',
      backend: 'x11',
      scene: SC,
      zoom,
      background: `rgb(${ground})`,
      frames,
      inkA: totalA,
      inkB: totalB,
      missing,
      extra,
      missingPct: +((100 * missing) / Math.max(1, totalA)).toFixed(2),
      extraPct: +((100 * extra) / Math.max(1, totalB)).toFixed(2),
    }),
);
process.exit(0);
