// What blocks the thread for ~1.9s during a fly?
//
// `diag-maps.mjs` says *that* it happens and where — one stall, about five
// seconds in, at the deep end of the zoom sweep, with the event loop blocked
// for it. That is synchronous JS, so a CPU profile names it.
//
// The profiler is started around the fly and not around the process: startup
// loads a tile corpus and builds the first levels, which would otherwise be
// most of the samples and none of the question.
//
//   node examples/prof-maps.mjs [seconds]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECONDS = Number(process.argv[2] ?? 9);

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
await sleep(400);

const session = new Session();
session.connect();
await session.post('Profiler.enable');
// 100us: the stall is one long run, and a coarse interval would put it in a
// handful of samples with no shape inside it.
await session.post('Profiler.setSamplingInterval', { interval: 100 });
await session.post('Profiler.start');
await sleep(SECONDS * 1000);
const { profile } = await session.post('Profiler.stop');
session.disconnect();

const out = path.resolve(process.env.TEMP ?? '.', 'maps-fly.cpuprofile');
fs.writeFileSync(out, JSON.stringify(profile));
console.log('wrote', out);

// --- read it back ----------------------------------------------------------

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map(); // node id → microseconds
const { samples, timeDeltas } = profile;
for (let i = 0; i < samples.length; i++) {
  const id = samples[i];
  self.set(id, (self.get(id) ?? 0) + (timeDeltas[i] ?? 0));
}

const label = (n) => {
  const f = n.callFrame;
  const where = f.url
    ? `${f.url.replace(/^.*[\\/]/, '')}:${(f.lineNumber ?? 0) + 1}`
    : '(native)';
  return `${f.functionName || '(anonymous)'}  ${where}`;
};

const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`\nprofiled ${(total / 1e6).toFixed(1)}s of thread time\n`);
console.log('where the thread actually was (self time):');
for (const [id, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  const n = byId.get(id);
  if (!n) continue;
  const pct = ((us / total) * 100).toFixed(1);
  console.log(
    `  ${(us / 1000).toFixed(0).padStart(6)}ms  ${pct.padStart(5)}%  ${label(n)}`,
  );
}

// Total time in a function says nothing about *shape*: 2.5s spread over
// sixteen hundred frames and 2.5s in one go look identical in the table
// above, and only one of them is a stall. So: the longest unbroken run of
// samples in a single frame, and the biggest gap between samples.
{
  let bestRun = { us: 0, id: null };
  let runId = null;
  let runUs = 0;
  let maxGap = { us: 0, at: 0, id: null };
  let clock = 0;
  for (let i = 0; i < samples.length; i++) {
    const d = timeDeltas[i] ?? 0;
    clock += d;
    if (d > maxGap.us) maxGap = { us: d, at: clock, id: samples[i] };
    if (samples[i] === runId) {
      runUs += d;
    } else {
      if (runUs > bestRun.us) bestRun = { us: runUs, id: runId };
      runId = samples[i];
      runUs = d;
    }
  }
  if (runUs > bestRun.us) bestRun = { us: runUs, id: runId };
  console.log('');
  console.log('shape:');
  const runNode = bestRun.id != null ? byId.get(bestRun.id) : null;
  console.log(
    `  longest unbroken run : ${(bestRun.us / 1000).toFixed(0)}ms in ` +
      (runNode ? label(runNode) : '(unknown)'),
  );
  const gapNode = maxGap.id != null ? byId.get(maxGap.id) : null;
  console.log(
    `  biggest sample gap   : ${(maxGap.us / 1000).toFixed(0)}ms at ` +
      `+${(maxGap.at / 1e6).toFixed(1)}s, charged to ` +
      (gapNode ? label(gapNode) : '(unknown)'),
  );
}

// A native leaf has no name of its own, so the only thing that identifies it
// is who called it. For the heaviest few, walk back up to the nearest frame
// that has a file.
const parentOf = new Map();
for (const n of profile.nodes)
  for (const c of n.children ?? []) parentOf.set(c, n.id);
console.log('');
console.log('the heaviest leaves, and who called them:');
for (const [id, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  const n = byId.get(id);
  if (!n || us < 50000) continue;
  if (n.callFrame.functionName === '(idle)') continue;
  const stack = [];
  for (
    let at = id;
    at !== undefined && stack.length < 7;
    at = parentOf.get(at)
  ) {
    const node = byId.get(at);
    if (node) stack.push(label(node));
  }
  console.log('');
  console.log(`  ${(us / 1000).toFixed(0)}ms in ${stack[0]}`);
  for (const frame of stack.slice(1)) console.log(`      called from ${frame}`);
}

// …and the same rolled up the call tree, which is what names a *phase*
// rather than the leaf it happened to be in.
const parent = new Map();
for (const n of profile.nodes)
  for (const c of n.children ?? []) parent.set(c, n.id);
const totalOf = new Map();
for (const [id, us] of self) {
  for (let at = id; at !== undefined; at = parent.get(at)) {
    totalOf.set(at, (totalOf.get(at) ?? 0) + us);
  }
}
console.log('\nrolled up the call tree (total time under each):');
const interesting = [...totalOf]
  .filter(([id]) => {
    const n = byId.get(id);
    return n && n.callFrame.url && /maps|react-x11/.test(n.callFrame.url);
  })
  .sort((a, b) => b[1] - a[1])
  .slice(0, 16);
for (const [id, us] of interesting) {
  const pct = ((us / total) * 100).toFixed(1);
  console.log(
    `  ${(us / 1000).toFixed(0).padStart(6)}ms  ${pct.padStart(5)}%  ${label(byId.get(id))}`,
  );
}
process.exit(0);
