// Screenshots of the todo list's drop gap, at the states worth looking at.
//
// A drag on Windows is OLE's `DoDragDrop`, a modal loop on the bridge's UI
// thread, so it cannot be synthesised from JS the way a click can — the loop
// reads the real mouse. So this drives the real pointer with SendInput, and
// snapshots the window between moves. JS keeps running throughout, which is
// the whole point of that thread split, and is what makes the capture
// possible at all.
//
//   node examples/shot-reorder.mjs [outputDirectory]
//
// It moves the pointer for a few seconds and always releases the button,
// even on the way out.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OUT = path.resolve(process.argv[2] ?? 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Move the real pointer, and press or release its left button. */
function input(action, x = 0, y = 0) {
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(
    uint flags, uint dx, uint dy, uint data, IntPtr extra);
  public const uint DOWN = 0x0002, UP = 0x0004;
}
'@
${
  action === 'move'
    ? `[M]::SetCursorPos(${x}, ${y})`
    : action === 'down'
      ? '[M]::mouse_event([M]::DOWN, 0, 0, 0, [IntPtr]::Zero)'
      : '[M]::mouse_event([M]::UP, 0, 0, 0, [IntPtr]::Zero)'
}
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'ignore',
    timeout: 20000,
  });
}

/** One PNG of the window as it is right now. */
async function shot(wnd, name) {
  const { data, width, height } = await wnd.snapshot();
  const { PNG } = require('../../react-x11/node_modules/pngjs');
  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.length);
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, PNG.sync.write(png));
  console.log('wrote', file);
}

const { createRoot } = await import('react-x11');
const React = (await import('react')).default;
const App = (await import('./reorder.tsx')).default;

const root = await createRoot();
root.render(React.createElement(App));
await sleep(1800);

const { liveApps } = await import(
  '../../react-x11/src/trace-registry.js'
);
const app = liveApps()[0] ?? null;
if (!app) throw new Error('no app to shoot');
const wnd = [...app._windows.values()][0];
const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };
console.log('window at', origin, `${wnd.width}x${wnd.height}`);

// The first list's rows, found by their text, so the coordinates come from
// the layout rather than from a guess.
const node = wnd._reactX11Node;
const rows = [];
const walk = (n) => {
  if (n.kind === 'text' && /Buy milk|Write the release|Book the dentist/.test(String(n.props?.children ?? ''))) {
    rows.push({ label: String(n.props.children), abs: { ...n.abs } });
  }
  for (const kid of n.children ?? []) walk(kid);
};
walk(node);
rows.sort((a, b) => a.abs.y - b.abs.y);
console.log('rows:', rows.map((r) => `${r.label}@${Math.round(r.abs.y)}`).join(' '));
if (rows.length < 3) throw new Error('could not find the rows to drag');

const at = (row, dy = 0) => ({
  x: Math.round(origin.x + row.abs.x + 20),
  y: Math.round(origin.y + row.abs.y + row.abs.height / 2 + dy),
});

/** Pick a row's selection dot, so a multi-row drag has something to carry. */
async function pick(row) {
  const p = { x: Math.round(origin.x + row.abs.x - 10), y: Math.round(origin.y + row.abs.y + row.abs.height / 2) };
  input('move', p.x, p.y);
  await sleep(90);
  input('down');
  await sleep(60);
  input('up');
  await sleep(120);
}

try {
  await shot(wnd, '1-idle');

  // Press the first row and drag it down past the third.
  const from = at(rows[0]);
  input('move', from.x, from.y);
  await sleep(200);
  input('down');
  await sleep(120);
  for (let i = 1; i <= 6; i++) {
    const p = at(rows[0], ((rows[2].abs.y - rows[0].abs.y) * i) / 6);
    input('move', p.x, p.y);
    await sleep(60);
  }
  await sleep(420); // let the height transition settle
  await shot(wnd, '2-gap-open-midlist');

  // Then to the very end, which is the slot no item's edge stands for.
  const end = at(rows[2], rows[2].abs.height * 2);
  input('move', end.x, end.y);
  await sleep(500);
  await shot(wnd, '3-gap-at-end');
  input('up');
  await sleep(800);
  await shot(wnd, '4-after-drop');

  // Two rows travelling: the gap is two rows tall, because the list said how
  // many were coming and the gap is sized from that.
  await pick(rows[0]);
  await pick(rows[1]);
  await sleep(200);
  const two = at(rows[0]);
  input('move', two.x, two.y);
  await sleep(200);
  input('down');
  await sleep(150);
  for (let i = 1; i <= 8; i++) {
    const p = at(rows[0], ((rows[2].abs.y - rows[0].abs.y) * i) / 8);
    input('move', p.x, p.y);
    await sleep(70);
  }
  await sleep(500);
  await shot(wnd, '5-two-rows-travelling');
} finally {
  input('up');
}
process.exit(0);
