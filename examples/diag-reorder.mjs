// Why does a reorder drag feel janky on Windows?
//
// Four things make a drag stutter and they are told apart by different
// numbers, so this measures all four while driving a real one:
//
//   1. the host's **event loop** is blocked — lag on a fixed-period timer;
//   2. **frames cost too much** — how long presentFrame takes, and how much
//      of the window it repaints;
//   3. **frames are not asked for** — news of the gesture in, frames out;
//   4. the **news arrives unevenly** — the gap between the events the shell
//      feeds us, which during a drag is an OLE modal loop on another thread.
//
// The pointer is driven by ONE PowerShell process for the whole gesture.
// Spawning one per move costs about half a second each, which lands in this
// process's event loop and ruins the very number (1) is trying to measure —
// the first version of this file measured its own instrument.
//
//   node examples/diag-reorder.mjs
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Press, sweep, release — the loop inside compiled C#, so the step rate is
 *  the machine's rather than PowerShell's (its script loop costs ~30ms an
 *  iteration, which silently becomes the thing being measured). */
function dragOnce({ x0, y0, x1, y1, steps, stepMs }) {
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  // The step delay is spun, not slept: Thread.Sleep(1) is 15.6ms unless
  // something raised the timer resolution, which would quietly make every
  // run a 64Hz one however many steps were asked for.
  static void Spin(long us) {
    var sw = System.Diagnostics.Stopwatch.StartNew();
    long ticks = us * System.Diagnostics.Stopwatch.Frequency / 1000000;
    while (sw.ElapsedTicks < ticks) Thread.SpinWait(20);
  }
  public static void Drag(int x0, int y0, int x1, int y1, int steps, int stepUs) {
    SetCursorPos(x0, y0);
    Thread.Sleep(250);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    Thread.Sleep(120);
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
      if (stepUs > 0) Spin(stepUs);
    }
    Thread.Sleep(300);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@
[M]::Drag(${x0}, ${y0}, ${x1}, ${y1}, ${steps}, ${stepMs})
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
const App = (await import('./reorder.tsx')).default;

const root = await createRoot();
root.render(React.createElement(App));
await sleep(1800);

const { liveApps } = await import('../../react-x11/src/trace-registry.js');
const app = liveApps()[0];
const wnd = [...app._windows.values()][0];
const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };

// --- the instruments --------------------------------------------------------

const frames = [];
const origPresent = wnd.presentFrame.bind(wnd);
wnd.presentFrame = (node, damage) => {
  const t0 = performance.now();
  origPresent(node, damage);
  frames.push({
    at: t0,
    ms: performance.now() - t0,
    rects: damage ? damage.length : 0,
    area: damage
      ? damage.reduce((n, r) => n + r.width * r.height, 0)
      : wnd.width * wnd.height,
  });
};

/** Every native event the bridge routed, by type — the news of the gesture. */
const routed = new Map();
const routedAt = [];
const origRoute = app._route.bind(app);
app._route = (event) => {
  routed.set(event.type, (routed.get(event.type) ?? 0) + 1);
  if (/drag|mouse|motion|pointer/.test(String(event.type))) {
    routedAt.push(performance.now());
  }
  return origRoute(event);
};

const lags = [];
let last = performance.now();
const beat = setInterval(() => {
  const now = performance.now();
  lags.push(now - last - 16);
  last = now;
}, 16);

// --- find a row and drag it -------------------------------------------------

const rows = [];
const walk = (n) => {
  if (
    n.kind === 'text' &&
    /Buy milk|Write the release|Book the dentist/.test(
      String(n.props?.children ?? ''),
    )
  ) {
    rows.push({ label: String(n.props.children), abs: { ...n.abs } });
  }
  for (const kid of n.children ?? []) walk(kid);
};
walk(wnd._reactX11Node);
rows.sort((a, b) => a.abs.y - b.abs.y);
if (rows.length < 3) throw new Error('could not find rows to drag');

const STEPS = Number(process.argv[2] ?? 60);
const STEP_MS = Number(process.argv[3] ?? 16000); // microseconds
const x0 = Math.round(origin.x + rows[0].abs.x + 20);
const y0 = Math.round(origin.y + rows[0].abs.y + rows[0].abs.height / 2);
const y1 = Math.round(y0 + (rows[2].abs.y - rows[0].abs.y));

const t0 = performance.now();
// A diagonal, so (with enough steps) every step is a *distinct* pixel —
// the worst case for a per-position report, which a vertical sweep down a
// list is not: there most steps land on the pixel before.
const SPREAD = Number(process.argv[4] ?? 0);
await dragOnce({ x0, y0, x1: x0 + SPREAD, y1, steps: STEPS, stepMs: STEP_MS });
await sleep(400);
clearInterval(beat);
const elapsed = performance.now() - t0;

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return (
    Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10
  );
};
const gaps = routedAt.slice(1).map((t, i) => t - routedAt[i]);
const frameGaps = frames.slice(1).map((f, i) => f.at - frames[i].at);
const full = frames.filter((f) => f.rects === 0).length;
const winArea = wnd.width * wnd.height;

console.log(
  `\nwindow ${wnd.width}x${wnd.height}, drag ${Math.round(elapsed)}ms, ` +
    `${STEPS} moves asked for at ${STEP_MS}ms\n`,
);
console.log(
  'what the bridge routed :',
  [...routed].map(([k, n]) => `${k}=${n}`).join('  ') || '(nothing)',
);
console.log(
  `gesture news gaps ms   : p50 ${pct(gaps, 0.5)}  p95 ${pct(gaps, 0.95)}  max ${pct(gaps, 1)}`,
);
console.log(
  `\nframes painted         : ${frames.length}  (${Math.round((frames.length / elapsed) * 1000)}/s)`,
);
console.log(`  full-window repaints : ${full} of ${frames.length}`);
console.log(
  `  mean coverage        : ${frames.length ? Math.round((frames.reduce((n, f) => n + f.area, 0) / frames.length / winArea) * 100) : 0}% of the window`,
);
console.log(
  `  presentFrame ms      : p50 ${pct(
    frames.map((f) => f.ms),
    0.5,
  )}  p95 ${pct(
    frames.map((f) => f.ms),
    0.95,
  )}  max ${pct(
    frames.map((f) => f.ms),
    1,
  )}`,
);
console.log(
  `  gap between frames   : p50 ${pct(frameGaps, 0.5)}  p95 ${pct(frameGaps, 0.95)}  max ${pct(frameGaps, 1)}`,
);
console.log(
  `\nevent-loop lag ms      : p50 ${pct(lags, 0.5)}  p95 ${pct(lags, 0.95)}  max ${pct(lags, 1)}`,
);
process.exit(0);
