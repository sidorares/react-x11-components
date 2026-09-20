// Which call blocks the thread for a second and a half during a fly?
//
// Sampling would not settle it: the stall happens in maybe one run in two,
// and a profile that misses it looks perfectly healthy. So this does not
// sample — it times **every GL call the frame makes**, by name, and reports
// the ones that blocked. A call that takes a second is impossible to miss
// and impossible to misattribute.
//
//   node examples/diag-gl-stall.mjs [seconds]
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECONDS = Number(process.argv[2] ?? 14);
/** A call slower than this is news; a frame is ~6ms all-in. */
const SLOW_MS = 60;

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
await sleep(9000);

const { liveApps } = await import('../../react-x11/src/trace-registry.js');
const app = liveApps()[0];
const wnd = [...app._windows.values()][0];
const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };

// The <glarea> node, and the GL table its frames call through.
let area = null;
let fly = null;
const walk = (n) => {
  if (n.gl && typeof n.gl === 'object') area = n;
  if (n.kind === 'text' && String(n.props?.children ?? '') === 'Fly') fly = n;
  for (const k of n.children ?? []) walk(k);
};
walk(wnd._reactX11Node);
if (!area) throw new Error('no <glarea> with a GL table found');
if (!fly) throw new Error('no Fly button found');

// Wrap every callable on the table. The table is the object the frame holds
// a reference to, so it is patched in place rather than replaced.
const totals = new Map();
const slow = [];
let started = 0;
const gl = area.gl;
for (const name of Object.keys(gl)) {
  const fn = gl[name];
  if (typeof fn !== 'function') continue;
  gl[name] = function timed(...args) {
    const t0 = performance.now();
    try {
      return fn.apply(this, args);
    } finally {
      const ms = performance.now() - t0;
      const at = totals.get(name) ?? { calls: 0, ms: 0, worst: 0 };
      at.calls += 1;
      at.ms += ms;
      if (ms > at.worst) at.worst = ms;
      totals.set(name, at);
      if (ms > SLOW_MS && started) {
        slow.push({ name, ms, at: performance.now() - started });
      }
    }
  };
}
// The app's frame ticks are NOT the map's frames. The window can be paced at
// the display rate while the <glarea> draws far less often, and counting the
// wrong one makes a 2fps map look like a 165fps one.
let ticks = 0;
const origTick = app._tickFrames.bind(app);
app._tickFrames = () => {
  ticks += 1;
  origTick();
};
// …and how often the area was *asked* to draw, against how often it did.
let asked = 0;
const origReq = area.requestFrame.bind(area);
area.requestFrame = () => {
  asked += 1;
  return origReq();
};
console.log(`watching ${Object.keys(gl).length} GL entry points`);

await click(
  Math.round(origin.x + fly.abs.x + fly.abs.width / 2),
  Math.round(origin.y + fly.abs.y + fly.abs.height / 2),
);
await sleep(400);
totals.clear();
slow.length = 0;
ticks = 0;
asked = 0;
started = performance.now();
await sleep(SECONDS * 1000);

const swaps = totals.get('SwapBuffers')?.calls ?? 0;
console.log('');
console.log(`flew for ${SECONDS}s`);
console.log(`  app frame ticks : ${ticks} (${(ticks / SECONDS).toFixed(0)}/s)`);
console.log(`  glarea asked    : ${asked} (${(asked / SECONDS).toFixed(0)}/s)`);
console.log(
  `  glarea DREW     : ${swaps} (${(swaps / SECONDS).toFixed(0)}/s)  <- what is on screen`,
);
console.log('');
console.log('calls that blocked longer than ' + SLOW_MS + 'ms:');
if (slow.length === 0) console.log('  (none)');
for (const s of slow) {
  console.log(
    `  ${s.ms.toFixed(0).padStart(6)}ms  gl.${s.name}  at +${(s.at / 1000).toFixed(1)}s`,
  );
}

console.log('\nwhere the frame thread went, by call:');
const rows = [...totals].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12);
for (const [name, at] of rows) {
  console.log(
    `  ${at.ms.toFixed(0).padStart(7)}ms total  ${String(at.calls).padStart(7)} calls  ` +
      `worst ${at.worst.toFixed(0).padStart(5)}ms  gl.${name}`,
  );
}
process.exit(0);
