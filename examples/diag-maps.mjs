// Why is Fly less smooth than panning by hand?
//
// Fly drives the camera from the frame callback, so it is paced entirely by
// the frame clock; a hand-driven pan is paced by the pointer, which is a
// different clock altogether — and that alone would make the two feel
// different even if the renderer were doing identical work. Fly also crosses
// ten zoom levels and pulls in new tiles the whole way, which is real load.
//
// So this separates them: it measures the **interval between frames** (the
// clock) apart from the **cost of a frame** (the load), and runs the whole
// thing twice — once on the compositor clock and once on the timer it
// replaced.
//
//   node examples/diag-maps.mjs [--timer]
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function click(x, y) {
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    Thread.Sleep(200);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@
[M]::Click(${x}, ${y})
`;
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { stdio: 'ignore' },
  );
  return new Promise((res) => child.on('exit', res));
}

const { createRoot } = await import('react-x11');
const React = (await import('react')).default;
const App = (await import('./maps-gl.tsx')).default;

const root = await createRoot();
root.render(React.createElement(App));
await sleep(9000); // tiles

const { liveApps } = await import('../../react-x11/src/trace-registry.js');
const app = liveApps()[0];
const wnd = [...app._windows.values()][0];
const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };

if (process.argv.includes('--timer')) {
  app._native.frameClockRequest = undefined;
  console.log('clock: the timer it replaced');
} else {
  console.log('clock: the compositor');
}

// Where the frames are asked for, whatever asks — the GL area's own rAF goes
// through the window's, and the window's goes through the app's.
const ticks = [];
const frameCost = [];
const origTick = app._tickFrames.bind(app);
app._tickFrames = () => {
  const t0 = performance.now();
  ticks.push(t0);
  origTick();
  frameCost.push(performance.now() - t0);
};

// Who asked, and when. The camera only advances from the map's own frame
// callback, so frames drive the animation and the animation drives frames:
// whichever end of that stops, the other stops with it, and only the order
// of the timestamps says which end it was.
const asked = [];
const origAsk = app._requestFrame.bind(app);
app._requestFrame = (cb, w) => {
  asked.push(performance.now());
  return origAsk(cb, w);
};

// A stall inside a frame and a stall beside one look the same from the gap
// between frames, so the loop is watched separately: if the lag matches the
// gap but the frame was cheap, the time went somewhere that is not a frame.
const lags = [];
const lagAt = [];
let lagLast = performance.now();
const beat = setInterval(() => {
  const now = performance.now();
  lags.push(now - lagLast - 8);
  lagAt.push(now);
  lagLast = now;
}, 8);

// Find the Fly button by its label and press it.
let fly = null;
const walk = (n) => {
  if (n.kind === 'text' && String(n.props?.children ?? '') === 'Fly') fly = n;
  for (const k of n.children ?? []) walk(k);
};
walk(wnd._reactX11Node);
if (!fly) throw new Error('no Fly button found');

await click(
  Math.round(origin.x + fly.abs.x + fly.abs.width / 2),
  Math.round(origin.y + fly.abs.y + fly.abs.height / 2),
);
await sleep(600);
// Everything from before the fly is startup — the corpus, the first tiles,
// the first build — and none of it is what is being measured here.
ticks.length = 0;
asked.length = 0;
lags.length = 0;
lagAt.length = 0;
zooms.length = 0;
frameCost.length = 0;
await sleep(Number(process.argv[3] ?? 6000));

const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
const s = [...gaps].sort((a, b) => a - b);
const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1);
const hist = new Map();
for (const g of gaps) {
  const b = Math.round(g);
  hist.set(b, (hist.get(b) ?? 0) + 1);
}
console.log(
  `flying: ${ticks.length} frames in 6s — ${(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)).toFixed(1)} fps`,
);
console.log(`gap ms: p50 ${p(0.5)}  p95 ${p(0.95)}  max ${p(1)}`);
console.log(
  'distribution:',
  [...hist]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ms, c]) => `${ms}ms x${c}`)
    .join('  '),
);
clearInterval(beat);
const fs = [...frameCost].sort((a, b) => a - b);
const fp = (q) =>
  fs[Math.min(fs.length - 1, Math.floor(fs.length * q))].toFixed(1);
const ls = [...lags].sort((a, b) => a - b);
const lp = (q) =>
  ls[Math.min(ls.length - 1, Math.floor(ls.length * q))].toFixed(1);
console.log(
  `cost of a frame ms: p50 ${fp(0.5)}  p95 ${fp(0.95)}  max ${fp(1)}`,
);
console.log(
  `event-loop lag ms : p50 ${lp(0.5)}  p95 ${lp(0.95)}  max ${lp(1)}`,
);
const stalls = lags.filter((v) => v > 100).length;
console.log(`loop stalls >100ms: ${stalls}`);
// Where in the fly, and at what zoom — a stall that always lands at the same
// zoom is a level being built, not a random hiccup.
let clock0 = lagAt[0] ?? 0;
for (let i = 0; i < lags.length; i++) {
  if (lags[i] > 100) {
    console.log(
      `  stall ${Math.round(lags[i])}ms at +${Math.round(lagAt[i] - clock0)}ms into the fly`,
    );
  }
}

// For each long gap between frames, was a frame *asked for* during it?
const askGaps = asked.slice(1).map((t, i) => t - asked[i]);
const as = [...askGaps].sort((a, b) => a - b);
const ap = (q) =>
  as[Math.min(as.length - 1, Math.floor(as.length * q))].toFixed(1);
console.log(`
frames asked for  : ${asked.length}`);
console.log(
  `gap between asks  : p50 ${ap(0.5)}  p95 ${ap(0.95)}  max ${ap(1)}`,
);
const longGaps = [];
for (let i = 1; i < ticks.length; i++) {
  if (ticks[i] - ticks[i - 1] > 150) {
    const inside = asked.filter((t) => t > ticks[i - 1] && t < ticks[i]).length;
    // *When* inside matters more than how many: a request at the very end
    // of the gap means nobody asked for a frame until then (the map stopped
    // driving), while one at the start means a frame was asked for and not
    // delivered (the backend stopped answering). Opposite bugs.
    const offsets = asked
      .filter((t) => t > ticks[i - 1] && t < ticks[i])
      .map((t) => `+${Math.round(t - ticks[i - 1])}`);
    longGaps.push(
      `${Math.round(ticks[i] - ticks[i - 1])}ms, asked at ${offsets.join(',') || 'never'}`,
    );
  }
}
console.log('long gaps         :', longGaps.join('  |  ') || '(none)');
process.exit(0);
