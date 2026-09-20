// Does a drop actually reorder, in every list?
//
// The other reorder diagnostics measure smoothness; this measures the
// **outcome**, which is a different thing and the one that regressed. It
// drags a named row past another named row and reads the order back.
//
// The bug it was written for: a `<popup dragPreview>` follows the pointer, so
// it is the window *under* the pointer for the whole gesture — and on Windows
// that is the window the shell asks when it looks for somewhere to drop. The
// preview answered for itself, is not a drop target, and the list underneath
// never saw the drop. It showed as `drag-leave` with no `drag-drop`, and as
// "drops work if you drag far enough to the right", which is where the
// pointer finally cleared the preview's edge.
//
//   node examples/diag-drop.mjs
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function drag({ hwnd, x0, y0, x1, y1, steps = 26, stepMs = 22, back = false }) {
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static void Drag(IntPtr hwnd, int x0, int y0, int x1, int y1, int steps, int stepMs, int back) {
    // Otherwise the first press is spent activating the window and never
    // reaches the tree, which looks exactly like a drag that did not start.
    SetForegroundWindow(hwnd);
    Thread.Sleep(250);
    SetCursorPos(x0, y0);
    Thread.Sleep(250);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    Thread.Sleep(150);
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
      Thread.Sleep(stepMs);
    }
    // …and optionally back where it started, which is how you release a row
    // in its own slot after a gesture long enough to *be* a drag.
    if (back != 0) {
      for (int i = 1; i <= steps; i++) {
        SetCursorPos(x1 + (x0 - x1) * i / steps, y1 + (y0 - y1) * i / steps);
        Thread.Sleep(stepMs);
      }
    }
    Thread.Sleep(400);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@
[M]::Drag([IntPtr]${hwnd}, ${x0}, ${y0}, ${x1}, ${y1}, ${steps}, ${stepMs}, ${back ? 1 : 0})
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
await sleep(2200);

const { liveApps } = await import('../../react-x11/src/trace-registry.js');
const app = liveApps()[0];
const wnd = [...app._windows.values()][0];
const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };
const hwnd = app._native.windowHandle(wnd.id);

/** Every laid-out text node, with where it is. */
function labels() {
  const out = [];
  const walk = (n) => {
    if (n.kind === 'text' && n.abs?.width > 0) {
      const t = String(n.props?.children ?? '').trim();
      if (t) out.push({ t, abs: { ...n.abs } });
    }
    for (const k of n.children ?? []) walk(k);
  };
  walk(wnd._reactX11Node);
  return out;
}
const find = (label) => labels().find((l) => l.t === label) ?? null;

/** Every small box, for finding a drag grip. */
function smallBoxes() {
  const out = [];
  const walk = (n) => {
    if (n.kind === 'box' && n.abs?.width > 0 && n.abs.width <= 32) {
      out.push({ ...n.abs });
    }
    for (const k of n.children ?? []) walk(k);
  };
  walk(wnd._reactX11Node);
  return out;
}

/**
 * The grip beside a label: the nearest small box to its left, on its row.
 * Taken from the tree rather than guessed as an offset, because a grip is a
 * few pixels tall and "the label's centre minus twenty" missed it by one —
 * which reads as a list that refuses drops when it is a press that missed.
 */
function gripFor(label) {
  const midY = label.abs.y + label.abs.height / 2;
  const near = smallBoxes()
    .filter(
      (b) => b.x < label.abs.x && Math.abs(b.y + b.height / 2 - midY) < 24,
    )
    .sort((a, b) => b.x - a.x);
  return near[0] ?? null;
}

/** The labels of `group`, in the order they are laid out. */
const orderOf = (group) =>
  labels()
    .filter((l) => group.includes(l.t))
    .sort((a, b) => a.abs.y - b.abs.y)
    .map((l) => l.t)
    .join(' | ');

// Each case grabs a row and drops it past another. `dx` shifts the press
// point for a list whose only drag handle is a grip beside the label.
const CASES = [
  {
    name: 'todos (plain rows)',
    group: ['Buy milk', 'Write the release notes', 'Book the dentist'],
    grab: 'Buy milk',
    past: 'Book the dentist',
  },
  {
    name: 'cards (grip only)',
    group: ['Mail', 'Calendar', 'Weather'],
    grab: 'Mail',
    past: 'Weather',
    grip: true,
  },
  {
    name: 'board: To do',
    group: ['Design review', 'Write tests', 'Update docs'],
    grab: 'Design review',
    past: 'Update docs',
  },
  // The other half of the contract: a drop is not always a move. Released
  // where it started, the row stays put — and that has to be a *drop* that
  // decided nothing changed, not a drop nobody took.
  {
    name: 'todos: dropped home',
    group: ['Buy milk', 'Write the release notes', 'Book the dentist'],
    grab: 'Buy milk',
    past: 'Book the dentist',
    back: true,
    expect: 'same',
  },
  // …and all the way down: the last slot is the one no row's edge stands for.
  {
    name: 'todos: to the end',
    group: [
      'Buy milk',
      'Write the release notes',
      'Book the dentist',
      'Water the plants',
      'Call the bank',
    ],
    grab: 'Buy milk',
    past: 'Call the bank',
    below: 30,
  },
];

let failures = 0;
for (const c of CASES) {
  const before = orderOf(c.group);
  const from = find(c.grab);
  const to = find(c.past);
  if (!from || !to) {
    console.log(`${c.name.padEnd(22)} SKIP — rows not found`);
    continue;
  }
  const routed = new Map();
  const origRoute = app._route.bind(app);
  app._route = (e) => {
    routed.set(e.type, (routed.get(e.type) ?? 0) + 1);
    return origRoute(e);
  };
  const grip = c.grip ? gripFor(from) : null;
  if (c.grip && !grip) {
    console.log(`${c.name.padEnd(22)} SKIP — no grip found beside ${c.grab}`);
    app._route = origRoute;
    continue;
  }
  const x0 = Math.round(
    origin.x + (grip ? grip.x + grip.width / 2 : from.abs.x + 20),
  );
  const y0 = Math.round(
    origin.y +
      (grip ? grip.y + grip.height / 2 : from.abs.y + from.abs.height / 2),
  );
  const y1 = Math.round(
    origin.y + to.abs.y + to.abs.height / 2 + 8 + (c.below ?? 0),
  );
  await drag({ hwnd, x0, y0, x1: x0, y1, back: c.back === true });
  await sleep(1000);
  app._route = origRoute;

  const after = orderOf(c.group);
  const changed = before !== after;
  const wantSame = c.expect === 'same';
  const took = (routed.get('drag-drop') ?? 0) > 0;
  // A row that did not move is only right if the drop was *taken* and the
  // list decided it belonged where it was. A drop nobody took looks the same
  // from the order alone, which is exactly how this bug hid.
  const ok = wantSame ? !changed && took : changed;
  if (!ok) failures += 1;
  const verdict = wantSame
    ? ok
      ? 'STAYED PUT'
      : changed
        ? 'MOVED (should not)'
        : 'NO DROP TAKEN'
    : changed
      ? 'REORDERED '
      : 'IGNORED   ';
  console.log(`${c.name.padEnd(22)} ${verdict}  ${before}  ->  ${after}`);
  console.log(
    `${''.padEnd(22)} drag-enter=${routed.get('drag-enter') ?? 0} ` +
      `drag-over=${routed.get('drag-over') ?? 0} ` +
      `drag-leave=${routed.get('drag-leave') ?? 0} ` +
      `drag-drop=${routed.get('drag-drop') ?? 0}`,
  );
}

console.log(
  failures === 0
    ? '\nok — every list took its drop'
    : `\n${failures} list(s) ignored the drop`,
);
process.exit(failures === 0 ? 0 : 1);
