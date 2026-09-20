// Where does the drop gap open, as the pointer moves down the list?
//
// The gap is a real box in the column, so opening it **moves the rows**: from
// the slot onward everything slides down by a row. The slot is computed from
// the pointer against the rows, and the rows have just moved because of the
// slot. That loop is where an off-by-one lives, and the only way to see it is
// to walk the pointer down a pixel at a time and write down both halves —
// where the pointer is, and where the list says the drop would land.
//
// The pointer is stepped by a helper process that holds the button down for
// the whole walk; this side samples between steps, after the 130ms height
// transition has settled, so every reading is of a laid-out tree.
//
//   node examples/diag-dropslot.mjs [stepPx]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEP = Number(process.argv[2] ?? 6);
/** Longer than the gap's 130ms transition, so a sample is of a settled tree. */
const SETTLE_MS = 230;

const { createRoot } = await import('react-x11');
const React = (await import('react')).default;
const App = (await import('./reorder.tsx')).default;

const root = await createRoot();
root.render(React.createElement(App));
await sleep(2200);

const { liveApps } = await import('../../react-x11/src/trace-registry.js');
const app = liveApps()[0];
const wnd = [...app._windows.values()][0];
const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };
const hwnd = app._native.windowHandle(wnd.id);

const TODOS = [
  'Buy milk',
  'Write the release notes',
  'Book the dentist',
  'Water the plants',
  'Call the bank',
];

function texts() {
  const out = [];
  const walk = (n) => {
    if (n.kind === 'text' && n.abs?.width > 0) {
      out.push({
        t: String(n.props?.children ?? '').trim(),
        abs: { ...n.abs },
      });
    }
    for (const k of n.children ?? []) walk(k);
  };
  walk(wnd._reactX11Node);
  return out;
}

/** The todo rows as laid out right now, top to bottom. */
function rows() {
  return texts()
    .filter((l) => TODOS.includes(l.t))
    .sort((a, b) => a.abs.y - b.abs.y);
}

/** What the list says: `would land at N` is one-based, so index = N - 1. */
function reportedSlot() {
  const line = texts().find((l) => l.t.startsWith('would land at'));
  if (!line) {
    return texts().some((l) => l.t === 'not over the list') ? 'off-list' : null;
  }
  return Number(line.t.slice('would land at '.length)) - 1;
}

/**
 * The open gap, and a row to compare it with. The gap is the box in the
 * list's column with no text in it; a row is the same column's box that has
 * some. Both are found from the tree rather than assumed, because the whole
 * question is whether the gap is the size of the row it stands for.
 */
function boxesInColumn(columnLeft, columnRight) {
  const out = [];
  const hasText = (m) => m.kind === 'text' || (m.children ?? []).some(hasText);
  const walk = (n) => {
    if (
      n.kind === 'box' &&
      n.abs?.height > 6 &&
      n.abs.x >= columnLeft &&
      n.abs.x <= columnRight &&
      n.abs.width > 100
    ) {
      out.push({ ...n.abs, text: hasText(n) });
    }
    for (const k of n.children ?? []) walk(k);
  };
  walk(wnd._reactX11Node);
  return out.sort((a, b) => a.y - b.y);
}

const before = rows().filter((r) => r.abs.y > 20); // the preview popup is not a row
if (before.length < 5) throw new Error('not enough rows');
const columnX = before[0].abs.x;
const colL = columnX - 40;
const colR = columnX + 4;
// What a row actually is, laid out: the box that draws it, not a sum of
// parts. Everything below is compared against this.
const rowBox = boxesInColumn(colL, colR).find(
  (b) => b.text && Math.abs(b.y - before[0].abs.y) < 20,
);
console.log(
  `a row box is ${rowBox ? Math.round(rowBox.height) : '?'}px tall; ` +
    `the list's pitch is ${Math.round(before[1].abs.y - before[0].abs.y)}px`,
);
const rowH = before[1].abs.y - before[0].abs.y; // pitch: row + LIST_GAP
console.log(
  `rows at y=${before.map((r) => Math.round(r.abs.y)).join(',')} (pitch ${Math.round(rowH)})`,
);

// Hold the button and walk down, one step per file the helper writes, so this
// side controls the cadence and can sample a settled tree between steps.
const flag = path.join(process.env.TEMP ?? '.', 'dropslot-step.txt');
try {
  fs.unlinkSync(flag);
} catch {
  // first run
}
// `--last` grabs the bottom row and walks *up*, which is the mirror of the
// same question: the slot below the last row, like the slot above the first,
// is where that row already is.
const fromLast = process.argv.includes('--last');
// `--row=N` grabs a middle row, where the two no-op slots either side of it
// are easiest to tell apart: at the ends one of them is off the list.
const pick = process.argv.find((a) => a.startsWith('--row='));
const grab = pick
  ? before[Number(pick.slice('--row='.length))]
  : fromLast
    ? before[before.length - 1]
    : before[0];
const x = Math.round(origin.x + grab.abs.x + 20);
const y0 = Math.round(origin.y + grab.abs.y + grab.abs.height / 2);
const steps = Math.ceil((rowH * 5.5) / STEP);
const dir = fromLast ? -1 : 1;

const ps = `
Add-Type -TypeDefinition @'
using System; using System.IO; using System.Threading; using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint a,uint b,uint c,IntPtr d);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static void Walk(IntPtr h,int x,int y,int steps,int step,string flag){
    SetForegroundWindow(h); Thread.Sleep(300);
    SetCursorPos(x,y); Thread.Sleep(250);
    mouse_event(0x0002,0,0,0,IntPtr.Zero); Thread.Sleep(200);
    for(int i=1;i<=steps;i++){
      SetCursorPos(x, y + i*step);
      File.WriteAllText(flag, i.ToString());
      // The sampler on the other side needs the tree to settle; it reads the
      // file to know which step it is looking at.
      Thread.Sleep(${SETTLE_MS + 60});
    }
    mouse_event(0x0004,0,0,0,IntPtr.Zero);
  }
}
'@
[M]::Walk([IntPtr]${hwnd}, ${x}, ${y0}, ${steps}, ${STEP * dir}, "${flag.split('\\').join('\\\\')}")
`;
const child = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', ps],
  { stdio: 'ignore' },
);
const done = new Promise((res) => child.on('exit', res));

const samples = [];
let lastStep = -1;
const poll = setInterval(() => {
  let step;
  try {
    step = Number(fs.readFileSync(flag, 'utf8'));
  } catch {
    return;
  }
  if (!Number.isFinite(step) || step === lastStep) return;
  lastStep = step;
  // Sample a little after the step, once the transition has run.
  setTimeout(() => {
    const live = rows().filter((r) => r.abs.y > 20);
    const gap = boxesInColumn(colL, colR)
      .filter((b) => !b.text)
      .sort((a, b) => b.height - a.height)[0];
    samples.push({
      step,
      pointerY: grab.abs.y + grab.abs.height / 2 + step * STEP * dir,
      slot: reportedSlot(),
      gapY: gap ? Math.round(gap.y) : null,
      gapH: gap ? Math.round(gap.height) : null,
      rowYs: live.map((r) => Math.round(r.abs.y)),
      labels: live.map((r) => r.t),
    });
  }, SETTLE_MS);
}, 20);

await done;
clearInterval(poll);
await sleep(400);

console.log('');
console.log('step  pointerY   slot  gap(y,h)      rows now');
for (const s of samples) {
  console.log(
    `${String(s.step).padStart(4)}  ${String(Math.round(s.pointerY)).padStart(8)}  ` +
      `${String(s.slot).padStart(5)}  ${String(s.gapY ?? '-').padStart(4)},${String(s.gapH ?? '-').padStart(3)}   ` +
      s.rowYs.join(','),
  );
}

// --- what it should have been ----------------------------------------------
//
// With the gap open at slot k the rows have moved, so "which slot is the
// pointer in" has to be asked of the tree as it is *now*: the pointer is in
// slot k when it is between the centre of the row above and the centre of
// the row below, counting the gap as the slot it stands for.
console.log('');
console.log('step  pointerY   slot  expected(from the live rows)  verdict');
for (const s of samples) {
  if (typeof s.slot !== 'number') continue;
  // The live rows, minus the one being dragged (it stays in place in this
  // list), give the boundaries. A pointer above row i's centre belongs
  // before it.
  let expected = s.rowYs.length;
  for (let i = 0; i < s.rowYs.length; i++) {
    const centre = s.rowYs[i] + (before[0].abs.height ?? 20) / 2;
    if (s.pointerY < centre) {
      expected = i;
      break;
    }
  }
  const off = s.slot - expected;
  console.log(
    `${String(s.step).padStart(4)}  ${String(Math.round(s.pointerY)).padStart(8)}  ` +
      `${String(s.slot).padStart(5)}  ${String(expected).padStart(28)}  ` +
      (off === 0 ? 'ok' : `off by ${off > 0 ? '+' : ''}${off}`),
  );
}
process.exit(0);
