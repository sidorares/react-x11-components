// The JS thread stops for ~1.9s during a fly. Where?
//
// What is already ruled out, by measurement:
//   - not the timers phase — setImmediate stops for the same 1.9s, so the
//     thread is not merely failing to reach its timer callbacks;
//   - not a GL call — every entry point on the GL table was timed and the
//     worst was 2ms (examples/diag-gl-stall.mjs);
//   - not a long JS function — a CPU profile at 100us shows no unbroken run
//     longer than 96ms.
//
// Which leaves the rest of the bridge. This times **every function on the
// native addon**, which is every door out of JS that is not GL, and reports
// any call that blocked. If nothing here blocks either, the block is not a
// call at all and the next suspect is the allocator or the GC.
//
//   node examples/diag-native-stall.mjs [seconds]
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECONDS = Number(process.argv[2] ?? 9);
const SLOW_MS = 80;

function click(x, y) {
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
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

function findText(label) {
  let hit = null;
  const walk = (n) => {
    if (
      n.kind === 'text' &&
      String(n.props?.children ?? '').startsWith(label)
    ) {
      hit = hit ?? n;
    }
    for (const k of n.children ?? []) walk(k);
  };
  walk(wnd._reactX11Node);
  return hit;
}
let area = null;
const findArea = (n) => {
  if (n.gl && typeof n.gl === 'object') area = n;
  for (const k of n.children ?? []) findArea(k);
};
findArea(wnd._reactX11Node);

const press = async (node) => {
  await click(
    Math.round(origin.x + node.abs.x + node.abs.width / 2),
    Math.round(origin.y + node.abs.y + node.abs.height / 2),
  );
  await sleep(500);
};

// `--adaptive` turns on the frame budget the example ships with off: the
// renderer then drops quality rungs rather than spending the whole thread on
// a frame. The question is whether that is what the deep end of the sweep
// needs, or whether the cost is somewhere a budget cannot reach.
if (process.argv.includes('--adaptive')) {
  const budget = findText('Adaptive');
  if (!budget) throw new Error('no Adaptive button found');
  await press(budget);
  console.log('adaptive:', findText('Adaptive')?.props?.children ?? '?');
}

const fly = findText('Fly');
if (!fly) throw new Error('no Fly button found');

const slow = [];
let started = 0;

/** Time every callable on an object, in place. */
function timeAll(obj, tag) {
  let n = 0;
  for (const name of Object.keys(obj)) {
    const fn = obj[name];
    if (typeof fn !== 'function') continue;
    n += 1;
    obj[name] = function timed(...args) {
      const t0 = performance.now();
      try {
        return fn.apply(this, args);
      } finally {
        const ms = performance.now() - t0;
        if (ms > SLOW_MS && started) {
          slow.push({
            what: `${tag}.${name}`,
            ms,
            at: performance.now() - started,
          });
        }
      }
    };
  }
  return n;
}

const nNative = timeAll(app._native, 'native');
const nGl = area ? timeAll(area.gl, 'gl') : 0;
console.log(`timing ${nNative} bridge calls and ${nGl} GL calls`);

// The one thing left that stops a thread without being a call: a collection.
// V8's CPU profile under-reports it, so it is asked directly.
const { PerformanceObserver, constants } = await import('node:perf_hooks');
const gcs = [];
const KIND = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weak-callbacks',
};
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcs.push({
      ms: e.duration,
      at: e.startTime,
      kind: KIND[e.detail?.kind] ?? '?',
    });
  }
}).observe({ entryTypes: ['gc'] });

// …and the JS thread's own heartbeat, so a block with no slow call in it is
// still visible rather than merely implied.
const beats = [];
let last = performance.now();
let on = true;
let lastCpu = process.cpuUsage();
const beat = () => {
  if (!on) return;
  const now = performance.now();
  const cpu = process.cpuUsage();
  // Wall time against CPU time. If a 500ms gap burned 500ms of CPU the
  // thread was busy in something; if it burned none, the process was not
  // running at all — descheduled, or waiting in the kernel — and no amount
  // of looking at our own code will find it.
  beats.push({
    gap: now - last,
    at: now,
    cpuMs: (cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / 1000,
  });
  last = now;
  lastCpu = cpu;
  setImmediate(beat);
};
setImmediate(beat);

await press(fly);
slow.length = 0;
beats.length = 0;
gcs.length = 0;
started = performance.now();
await sleep(SECONDS * 1000);
on = false;

console.log('');
const stops = beats.filter((b) => b.gap > SLOW_MS);
console.log(
  `the thread stopped ${stops.length} time(s) for more than ${SLOW_MS}ms:`,
);
for (const s of stops) {
  const inside = slow.filter(
    (c) => c.at + started > s.at - s.gap && c.at + started <= s.at,
  );
  console.log(
    `  ${s.gap.toFixed(0).padStart(6)}ms wall / ${s.cpuMs.toFixed(0)}ms cpu ` +
      `at +${((s.at - started) / 1000).toFixed(1)}s — ` +
      (inside.length
        ? inside.map((c) => `${c.what} ${c.ms.toFixed(0)}ms`).join(', ')
        : 'no slow call') +
      // performance.now() and an entry's startTime share an origin here, so
      // a collection can be placed inside the gap it explains.
      (() => {
        const g = gcs.filter((x) => x.at > s.at - s.gap && x.at <= s.at);
        const total = g.reduce((a, b) => a + b.ms, 0);
        return g.length
          ? ` — ${g.length} GC(s) totalling ${total.toFixed(0)}ms (${[...new Set(g.map((x) => x.kind))].join('+')})`
          : ' — and no GC either';
      })(),
  );
}
console.log('');
const byKind = new Map();
for (const g of gcs) {
  const at = byKind.get(g.kind) ?? { n: 0, ms: 0, worst: 0 };
  at.n += 1;
  at.ms += g.ms;
  if (g.ms > at.worst) at.worst = g.ms;
  byKind.set(g.kind, at);
}
console.log('collections during the fly:');
for (const [kind, at] of [...byKind].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(
    `  ${at.ms.toFixed(0).padStart(6)}ms total  ${String(at.n).padStart(5)}x  ` +
      `worst ${at.worst.toFixed(0).padStart(5)}ms  ${kind}`,
  );
}
console.log('');
console.log(`calls over ${SLOW_MS}ms anywhere: ${slow.length}`);
for (const c of slow.slice(0, 10)) {
  console.log(
    `  ${c.ms.toFixed(0).padStart(6)}ms  ${c.what}  at +${(c.at / 1000).toFixed(1)}s`,
  );
}
process.exit(0);
