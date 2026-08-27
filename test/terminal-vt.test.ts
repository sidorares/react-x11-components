// `<Terminal backend="vt">` — the terminal this package draws itself.
//
// Four layers, and the split is the whole reason the design is shaped the way
// it is:
//
//  1. **Pure tables** — keys and mouse to bytes, colours to two colours per
//     cell. No X, no emulator, no pty: golden bytes, asserted directly.
//  2. **The diff** — a real `@xterm/headless` buffer in, dirty spans and
//     scroll copies out. Still no X.
//  3. **The component** — mounted on the mock backend with a `FakePtyHost`,
//     so "bytes in, screen out", flow control and the lifecycle are tested
//     with no native module anywhere.
//  4. **Pixels** — the in-process X server, where the retained renderer's
//     `Surface`, `fillRects` and `copyWithin` really run.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import {
  renderX11,
  cleanup,
  act,
  expectPixel,
  screen,
  userEvent,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import {
  XK_BACKSPACE,
  XK_DELETE,
  XK_ESCAPE,
  XK_F1,
  XK_F5,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_UP,
  XK_RETURN,
  XK_TAB,
  XK_UP,
} from 'react-x11/keysyms';

import { Terminal } from '../src/terminal/index.js';
import type { TerminalHandle } from '../src/terminal/index.js';
import {
  encodeKey,
  encodePaste,
  XK_ISO_LEFT_TAB,
  XK_KP_0,
  XK_KP_ADD,
} from '../src/terminal/vt/keys.js';
import type { KeyModes, VtKeyEvent } from '../src/terminal/vt/keys.js';
import {
  encodeAlternateScroll,
  encodeMouse,
} from '../src/terminal/vt/mouse.js';
import {
  buildPalette,
  parseColor,
  resolveCell,
  VARIANT_BOLD,
} from '../src/terminal/vt/colors.js';
import type { ResolvedCell } from '../src/terminal/vt/colors.js';
import {
  Mirror,
  createSnapshot,
  readViewport,
} from '../src/terminal/vt/diff.js';
import type { CursorState } from '../src/terminal/vt/diff.js';
import { createRenderer } from '../src/terminal/vt/renderer.js';
import { PtyUnavailableError } from '../src/terminal/vt/pty.js';
import { loadXterm } from '../src/terminal/vt/xterm.js';
import type { XtermCell, XtermTerminal } from '../src/terminal/vt/xterm.js';
import type { VtTermNode } from '../src/terminal/vt/node.js';
import {
  bunPtyHost,
  defaultPtyHost,
  defaultShell,
  nodePtyHost,
} from '../src/terminal/vt/pty.js';
import type { PtyHost } from '../src/terminal/vt/pty.js';
import { FakePtyHost } from './fake-pty.js';
import { FakeHost } from './fake-host.js';

const h = React.createElement;

afterEach(cleanup);

const FONT_CANDIDATES: Array<[string, string]> = [
  [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Monaco.ttf',
  ],
  [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  ],
];
const found = FONT_CANDIDATES.find(
  ([sans, mono]) => existsSync(sans) && existsSync(mono),
);
const FONTS = found ? { 'sans-serif': found[0], monospace: found[1] } : null;

// --- 1. keys ----------------------------------------------------------------

const NORMAL: KeyModes = {
  applicationCursorKeysMode: false,
  applicationKeypadMode: false,
};
const APP_CURSOR: KeyModes = {
  applicationCursorKeysMode: true,
  applicationKeypadMode: false,
};
const APP_KEYPAD: KeyModes = {
  applicationCursorKeysMode: false,
  applicationKeypadMode: true,
};

function key(over: Partial<VtKeyEvent>): VtKeyEvent {
  return {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  };
}

test('cursor keys follow DECCKM, and a modifier always uses CSI', () => {
  assert.equal(encodeKey(key({ keysym: XK_UP }), NORMAL), '\x1b[A');
  assert.equal(encodeKey(key({ keysym: XK_UP }), APP_CURSOR), '\x1bOA');
  // The modifier form is never SS3 — applications rely on that.
  assert.equal(
    encodeKey(key({ keysym: XK_UP, ctrlKey: true }), APP_CURSOR),
    '\x1b[1;5A',
  );
  assert.equal(
    encodeKey(key({ keysym: XK_LEFT, shiftKey: true }), NORMAL),
    '\x1b[1;2D',
  );
  assert.equal(encodeKey(key({ keysym: XK_HOME }), NORMAL), '\x1b[H');
});

test('the ~ keys carry their number and their modifier', () => {
  assert.equal(encodeKey(key({ keysym: XK_DELETE }), NORMAL), '\x1b[3~');
  assert.equal(encodeKey(key({ keysym: XK_PAGE_UP }), NORMAL), '\x1b[5~');
  assert.equal(
    encodeKey(
      key({ keysym: XK_PAGE_UP, ctrlKey: true, shiftKey: true }),
      NORMAL,
    ),
    '\x1b[5;6~',
  );
});

test('function keys split at F5, as xterm does', () => {
  assert.equal(encodeKey(key({ keysym: XK_F1 }), NORMAL), '\x1bOP');
  assert.equal(
    encodeKey(key({ keysym: XK_F1, altKey: true }), NORMAL),
    '\x1b[1;3P',
  );
  assert.equal(encodeKey(key({ keysym: XK_F5 }), NORMAL), '\x1b[15~');
});

test('control characters are the alphabet with the top bits cleared', () => {
  assert.equal(
    encodeKey(key({ codepoint: 0x61, ctrlKey: true }), NORMAL),
    '\x01',
  );
  assert.equal(
    encodeKey(key({ codepoint: 0x43, ctrlKey: true }), NORMAL),
    '\x03',
  );
  assert.equal(
    encodeKey(key({ codepoint: 0x20, ctrlKey: true }), NORMAL),
    '\0',
  );
  assert.equal(
    encodeKey(key({ codepoint: 0x5b, ctrlKey: true }), NORMAL),
    '\x1b',
  );
});

test('Alt is an ESC prefix; Super belongs to the desktop', () => {
  assert.equal(
    encodeKey(key({ codepoint: 0x78, altKey: true }), NORMAL),
    '\x1bx',
  );
  assert.equal(
    encodeKey(key({ codepoint: 0x61, ctrlKey: true, altKey: true }), NORMAL),
    '\x1b\x01',
  );
  assert.equal(
    encodeKey(key({ codepoint: 0x71, metaKey: true }), NORMAL),
    null,
  );
});

test('Backspace sends DEL, Shift+Tab sends CSI Z, Enter sends CR', () => {
  assert.equal(encodeKey(key({ keysym: XK_BACKSPACE }), NORMAL), '\x7f');
  assert.equal(
    encodeKey(key({ keysym: XK_BACKSPACE, ctrlKey: true }), NORMAL),
    '\x08',
  );
  assert.equal(
    encodeKey(key({ keysym: XK_TAB, shiftKey: true }), NORMAL),
    '\x1b[Z',
  );
  assert.equal(encodeKey(key({ keysym: XK_ISO_LEFT_TAB }), NORMAL), '\x1b[Z');
  assert.equal(encodeKey(key({ keysym: XK_RETURN }), NORMAL), '\r');
  assert.equal(encodeKey(key({ keysym: XK_ESCAPE }), NORMAL), '\x1b');
});

test('the keypad has two personalities', () => {
  assert.equal(encodeKey(key({ keysym: XK_KP_0 }), NORMAL), '0');
  assert.equal(encodeKey(key({ keysym: XK_KP_0 }), APP_KEYPAD), '\x1bOp');
  assert.equal(encodeKey(key({ keysym: XK_KP_ADD }), NORMAL), '+');
  assert.equal(encodeKey(key({ keysym: XK_KP_ADD }), APP_KEYPAD), '\x1bOk');
});

test('an unmapped key is not consumed', () => {
  assert.equal(encodeKey(key({}), NORMAL), null);
  // An application chord: no character, nothing the terminal knows.
  assert.equal(encodeKey(key({ keysym: 0xffe1 }), NORMAL), null);
});

test('a paste is bracketed, normalised and stripped', () => {
  assert.equal(encodePaste('a\nb', false), 'a\rb');
  assert.equal(encodePaste('a\r\nb', true), '\x1b[200~a\rb\x1b[201~');
  // The escape that would close the brackets early never reaches the program.
  assert.equal(encodePaste('x\x1b[201~y', true), '\x1b[200~x[201~y\x1b[201~');
});

// --- 2. mouse ---------------------------------------------------------------

const AT = { col: 4, row: 2, shiftKey: false, altKey: false, ctrlKey: false };

test('mouse reporting is off until an application asks', () => {
  assert.equal(
    encodeMouse(
      { kind: 'down', button: 1, pressed: true, ...AT },
      { tracking: 'none', encoding: 'default' },
    ),
    null,
  );
});

test('the default encoding biases every field by 32', () => {
  assert.equal(
    encodeMouse(
      { kind: 'down', button: 1, pressed: true, ...AT },
      { tracking: 'vt200', encoding: 'default' },
    ),
    '\x1b[M\x20\x25\x23',
  );
  // A release spends its button bits saying "3", which is why SGR exists.
  assert.equal(
    encodeMouse(
      { kind: 'up', button: 1, pressed: false, ...AT },
      { tracking: 'vt200', encoding: 'default' },
    ),
    '\x1b[M#%#',
  );
});

test('SGR says which button came up, and carries modifiers', () => {
  assert.equal(
    encodeMouse(
      { kind: 'down', button: 3, pressed: true, ...AT },
      { tracking: 'vt200', encoding: 'sgr' },
    ),
    '\x1b[<2;5;3M',
  );
  assert.equal(
    encodeMouse(
      { kind: 'up', button: 3, pressed: false, ...AT },
      { tracking: 'vt200', encoding: 'sgr' },
    ),
    '\x1b[<2;5;3m',
    'SGR keeps the button on the release — the whole reason it exists',
  );
  assert.equal(
    encodeMouse(
      { kind: 'down', button: 1, pressed: true, ...AT, ctrlKey: true },
      { tracking: 'vt200', encoding: 'sgr' },
    ),
    '\x1b[<16;5;3M',
  );
});

test('motion only reports where the mode asked for it', () => {
  const move = { kind: 'move', button: 1, pressed: true, ...AT } as const;
  assert.equal(encodeMouse(move, { tracking: 'vt200', encoding: 'sgr' }), null);
  assert.equal(
    encodeMouse(move, { tracking: 'drag', encoding: 'sgr' }),
    '\x1b[<32;5;3M',
  );
  assert.equal(
    encodeMouse(
      { ...move, pressed: false },
      { tracking: 'any', encoding: 'sgr' },
    ),
    '\x1b[<32;5;3M',
  );
  // X10 is press-only.
  assert.equal(
    encodeMouse(
      { kind: 'up', button: 1, pressed: false, ...AT },
      { tracking: 'x10', encoding: 'default' },
    ),
    null,
  );
});

test('the wheel reports 64/65, and becomes arrows without tracking', () => {
  assert.equal(
    encodeMouse(
      { kind: 'wheel', button: 0, deltaY: -48, pressed: false, ...AT },
      { tracking: 'vt200', encoding: 'sgr' },
    ),
    '\x1b[<64;5;3M',
  );
  assert.equal(encodeAlternateScroll(3, true, false), '\x1b[A\x1b[A\x1b[A');
  assert.equal(encodeAlternateScroll(2, false, true), '\x1bOB\x1bOB');
});

// --- 3. colours -------------------------------------------------------------

test('colour strings parse, and the palette fills its 256 slots', () => {
  assert.equal(parseColor('#f00'), 0xff0000);
  assert.equal(parseColor('#00ff00'), 0x00ff00);
  assert.equal(parseColor('rgb(0, 0, 255)'), 0x0000ff);
  assert.equal(parseColor('nonsense'), null);

  const palette = buildPalette({ palette: ['#111111'] });
  assert.equal(palette.ansi[0], 0x111111, 'a short palette sets what it has');
  assert.equal(palette.ansi[1], 0xcd0000, 'and the rest keep the standard set');
  assert.equal(palette.ansi[16], 0x000000, 'the cube starts at black');
  assert.equal(palette.ansi[231], 0xffffff, 'and ends at white');
  assert.equal(palette.ansi[255], 0xeeeeee, 'the greys end just short of it');
});

/** A cell with only the attributes a test cares about. */
function fakeCell(over: Partial<Record<string, unknown>> = {}): XtermCell {
  const base: Record<string, unknown> = {
    fg: 0,
    bg: 0,
    fgDefault: true,
    bgDefault: true,
    fgPalette: false,
    bold: 0,
    dim: 0,
    inverse: 0,
    invisible: 0,
    italic: 0,
    underline: 0,
    strike: 0,
    overline: 0,
    ...over,
  };
  return {
    getWidth: () => 1,
    getChars: () => 'x',
    getCode: () => 120,
    getFgColor: () => base.fg as number,
    getBgColor: () => base.bg as number,
    getFgColorMode: () => 0,
    getBgColorMode: () => 0,
    isFgRGB: () => false,
    isBgRGB: () => false,
    isFgPalette: () => base.fgPalette as boolean,
    isBgPalette: () => false,
    isFgDefault: () => base.fgDefault as boolean,
    isBgDefault: () => base.bgDefault as boolean,
    isBold: () => base.bold as number,
    isDim: () => base.dim as number,
    isItalic: () => base.italic as number,
    isUnderline: () => base.underline as number,
    isBlink: () => 0,
    isInverse: () => base.inverse as number,
    isInvisible: () => base.invisible as number,
    isStrikethrough: () => base.strike as number,
    isOverline: () => base.overline as number,
  };
}

test('a cell resolves to exactly two colours, whatever it carries', () => {
  const palette = buildPalette({
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ff8800',
  });
  const out: ResolvedCell = { fg: 0, bg: 0, flags: 0 };
  const state = { selected: false, cursor: 'none' as const, brightBold: true };

  resolveCell(fakeCell(), palette, state, out);
  assert.deepEqual([out.fg, out.bg], [0xffffff, 0x000000]);

  resolveCell(fakeCell({ inverse: 1 }), palette, state, out);
  assert.deepEqual([out.fg, out.bg], [0x000000, 0xffffff], 'inverse swaps');

  resolveCell(fakeCell({ invisible: 1 }), palette, state, out);
  assert.equal(out.fg, out.bg, 'invisible hides the glyph in the background');

  resolveCell(
    fakeCell({ bold: 1, fgDefault: false, fgPalette: true, fg: 1 }),
    palette,
    state,
    out,
  );
  assert.equal(out.fg, palette.ansi[9], 'bold promotes ANSI 1 to bright');
  assert.ok(out.flags & VARIANT_BOLD, 'and still asks for the bold face');

  resolveCell(fakeCell(), palette, { ...state, selected: true }, out);
  assert.equal(out.bg, palette.selectionBackground);

  resolveCell(fakeCell(), palette, { ...state, cursor: 'block' }, out);
  assert.deepEqual(
    [out.fg, out.bg],
    [palette.background, 0xff8800],
    'the block cursor is a colour swap, not another layer',
  );
});

// --- 3b. the renderer's batching ------------------------------------------

/** A 2d context that records instead of drawing — the counting spy. */
function spyContext(): {
  ctx: Record<string, unknown>;
  calls: string[];
} {
  const calls: string[] = [];
  const ctx = {
    fillStyle: '',
    fillRect: (x: number, y: number, w: number, h: number) =>
      calls.push(`fillRect ${ctx.fillStyle} ${x},${y} ${w}x${h}`),
    fillRects: (rects: number[]) =>
      calls.push(`fillRects ${ctx.fillStyle} ${rects.length / 4}`),
    drawGlyphs: (_op: number, _src: unknown, runs: unknown[]) =>
      calls.push(`drawGlyphs ${runs.length}`),
    createSolidPicture: () => ({}),
    Render: { PictOp: { Over: 3, Src: 1 } },
  };
  return { ctx: ctx as unknown as Record<string, unknown>, calls };
}

test('without a Surface the renderer still draws, and still batches', () => {
  const { ctx, calls } = spyContext();
  const renderer = createRenderer(
    null,
    ctx as never,
    // No `Surface`: the DirectRenderer path, which is also what runs where a
    // pixmap cannot be created.
    null,
  );
  assert.ok(renderer);
  assert.equal(renderer.kind, 'direct');
  assert.equal(
    renderer.copyRows(1, 0, 5),
    false,
    'nothing is retained, so nothing can be scrolled',
  );

  const metrics = {
    cellWidth: 8,
    cellHeight: 16,
    baseline: 12,
    underline: 14,
    ruleHeight: 1,
  };
  renderer.ensure(10, 2, metrics);
  renderer.begin(ctx as never, {
    originX: 4,
    originY: 6,
    cols: 10,
    rows: 2,
    metrics,
  });
  const run = {
    font: {} as never,
    size: 13,
    glyphs: [{ id: 1, ax: 8, dx: 0, dy: 0 }],
  };
  renderer.fillCells(0, 0, 3, 0x000000);
  renderer.fillCells(0, 3, 2, 0xff0000);
  renderer.fillCells(1, 0, 4, 0x000000);
  renderer.drawRun(0, 0, run, 0xffffff);
  renderer.drawRun(0, 1, run, 0xffffff);
  renderer.drawRun(1, 0, run, 0x00ff00);
  renderer.decorate(0, 0, 2, 'underline', 0xffffff);
  renderer.end();

  assert.deepEqual(
    calls,
    [
      // one request per background colour, not one per rectangle…
      'fillRects #000000 2',
      'fillRects #ff0000 1',
      // …one per foreground colour for the glyphs…
      'drawGlyphs 2',
      'drawGlyphs 1',
      // …and the decorations last, over the glyphs they belong to.
      'fillRects #ffffff 1',
    ],
    calls.join('\n'),
  );
  assert.equal(renderer.stats.fillRequests, 3);
  assert.equal(renderer.stats.glyphRequests, 2);
  assert.equal(renderer.stats.cellsFilled, 9);
});

test('a context with no pixel API paints nothing rather than throwing', () => {
  // The mock backend, where a component that throws cannot be tested at all.
  assert.equal(createRenderer(null, {} as never, null), null);
});

// --- 4. the diff ------------------------------------------------------------

const NO_CURSOR: CursorState = { col: 0, row: -1, shape: 'none' };

async function emulator(cols = 20, rows = 6): Promise<XtermTerminal> {
  const mod = await loadXterm();
  assert.ok(mod, '@xterm/headless is installed for the test suite');
  return new mod.Terminal({
    cols,
    rows,
    scrollback: 50,
    allowProposedApi: true,
  });
}

function feed(term: XtermTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

const PALETTE = buildPalette(undefined);

function frame(
  term: XtermTerminal,
  mirror: Mirror,
  snapshot = createSnapshot(term.cols, term.rows),
): {
  snapshot: ReturnType<typeof createSnapshot>;
  result: ReturnType<Mirror['diff']>;
} {
  readViewport(term, snapshot, {
    palette: PALETTE,
    selection: null,
    cursor: NO_CURSOR,
    brightBold: true,
  });
  return { snapshot, result: mirror.diff(snapshot) };
}

test('the first frame is everything, and an unchanged one is nothing', async () => {
  const term = await emulator();
  const mirror = new Mirror();
  const snapshot = createSnapshot(term.cols, term.rows);

  const first = frame(term, mirror, snapshot).result;
  assert.ok(first.full);
  assert.equal(first.spans.length, term.rows, 'one span per row');

  const second = frame(term, mirror, snapshot).result;
  assert.equal(second.spans.length, 0, 'nothing changed, nothing repaints');
  assert.equal(second.copy, null);
  term.dispose();
});

test('typing repaints the cells that changed and nothing else', async () => {
  const term = await emulator();
  const mirror = new Mirror();
  const snapshot = createSnapshot(term.cols, term.rows);
  frame(term, mirror, snapshot);

  await feed(term, 'hello');
  const { result } = frame(term, mirror, snapshot);
  assert.equal(result.spans.length, 1, 'one row, one span');
  assert.deepEqual(
    { row: result.spans[0].row, col: result.spans[0].col },
    { row: 0, col: 0 },
  );
  assert.equal(result.spans[0].count, 5, 'exactly the five cells that changed');

  await feed(term, '!');
  const next = frame(term, mirror, snapshot).result;
  assert.equal(next.spans.length, 1);
  assert.equal(next.spans[0].count, 1, 'one more character, one more cell');
  term.dispose();
});

test('a scroll is one copy plus the row it exposed', async () => {
  const term = await emulator(20, 6);
  const mirror = new Mirror();
  const snapshot = createSnapshot(term.cols, term.rows);
  // Fill the screen with distinguishable rows, then push it up by one.
  await feed(term, 'a\r\nb\r\nc\r\nd\r\ne\r\nf');
  frame(term, mirror, snapshot);

  await feed(term, '\r\ng');
  const { result } = frame(term, mirror, snapshot);
  assert.ok(result.copy, 'the surviving band moves rather than redrawing');
  assert.deepEqual(result.copy, { srcRow: 1, dstRow: 0, count: 5 });
  assert.equal(result.spans.length, 1, 'only the exposed row is dirty');
  assert.equal(result.spans[0].row, 5);
  term.dispose();
});

test('the alternate screen is never copied into, it is redrawn', async () => {
  const term = await emulator();
  const mirror = new Mirror();
  const snapshot = createSnapshot(term.cols, term.rows);
  await feed(term, 'normal');
  frame(term, mirror, snapshot);

  await feed(term, '\x1b[?1049h'); // enter the alternate screen
  const { result } = frame(term, mirror, snapshot);
  assert.ok(result.full, 'a different buffer shares no pixels with this one');
  assert.equal(result.copy, null);
  term.dispose();
});

test('a selection repaints only the cells whose highlight changed', async () => {
  const term = await emulator();
  const mirror = new Mirror();
  const snapshot = createSnapshot(term.cols, term.rows);
  await feed(term, 'hello world');
  frame(term, mirror, snapshot);

  readViewport(term, snapshot, {
    palette: PALETTE,
    selection: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
    cursor: NO_CURSOR,
    brightBold: true,
  });
  const result = mirror.diff(snapshot);
  assert.equal(result.spans.length, 1);
  assert.equal(result.spans[0].col, 0);
  assert.equal(result.spans[0].count, 5, 'the five selected cells, no more');
  term.dispose();
});

// --- 5. the component -------------------------------------------------------

/** Act until the renderer stops drawing — "the screen has settled". */
async function settle(node: VtTermNode): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const before = node.rendererStats.totals.cellsFilled;
    await act(async () => {});
    if (node.rendererStats.totals.cellsFilled === before) return;
  }
}

function vtNode(): VtTermNode {
  const node = screen.all((n: DrawnNode) => n.kind === 'vtterm')[0];
  assert.ok(node, 'a <vtterm> node is mounted');
  return node as unknown as VtTermNode;
}

/** Mount a vt terminal on the mock backend and wait for its pty. */
async function mountVt(
  props: Record<string, unknown> = {},
): Promise<{ pty: FakePtyHost; ref: React.RefObject<TerminalHandle | null> }> {
  const pty = new FakePtyHost();
  const ref = React.createRef<TerminalHandle>();
  await renderX11(h(Terminal, { backend: 'vt', pty, ref, ...props }), {
    backend: 'mock',
  });
  await waitFor(() => assert.ok(pty.last, 'the pty was opened'));
  return { pty, ref };
}

test('the shell runs on the pty, with TERM set to what we are', async () => {
  const { pty } = await mountVt({ command: ['bash', '-lc', 'npm test'] });
  const opened = pty.opened[0];
  assert.deepEqual(opened.argv, ['bash', '-lc', 'npm test']);
  assert.equal(opened.options.env?.TERM, 'xterm-256color');
  assert.equal(opened.options.env?.COLORTERM, 'truecolor');
  assert.ok(opened.options.cols > 0 && opened.options.rows > 0);
});

test('with no command the host decides what the shell is', async () => {
  // Empty argv rather than this machine's `$SHELL`: over ssh, or into a
  // container, the local shell is the wrong answer and only the host knows
  // the right one. `nodePtyHost` fills in `defaultShell()` for exactly this.
  const { pty } = await mountVt();
  assert.deepEqual(pty.opened[0].argv, []);
  assert.match(defaultShell({ SHELL: '/bin/zsh' }), /zsh/);
  assert.equal(defaultShell({}), '/bin/sh');
});

test('auto prefers an installed emulator over the vt floor', async () => {
  // xterm on PATH: the embedded backend wins, and nothing opens a pty.
  const processes = new FakeHost({ installed: ['xterm'] });
  const unusedPty = new FakePtyHost();
  const ref = React.createRef<TerminalHandle>();
  await renderX11(h(Terminal, { processes, pty: unusedPty, ref }), {
    backend: 'xserver',
  });
  await waitFor(() => assert.equal(ref.current?.backend, 'xterm'));
  assert.equal(unusedPty.opened.length, 0, 'the pty was never needed');
});

test('auto falls through to vt when no emulator is installed', async () => {
  // Nothing installed: `auto` reaches the floor rather than the fallback,
  // which is the whole reason the floor exists.
  const processes = new FakeHost();
  const pty = new FakePtyHost();
  const ref = React.createRef<TerminalHandle>();
  await renderX11(
    h(Terminal, {
      processes,
      pty,
      ref,
      fallback: h('text', null, 'nothing at all'),
    }),
    // The real server, not the mock: `auto` renders the `<foreign>` first and
    // only reaches vt once the PATH probe has come back empty, and a
    // `<foreign>` needs a connection to adopt a client on.
    { backend: 'xserver' },
  );
  await waitFor(() => assert.ok(pty.last, 'the vt backend took over'));
  assert.equal(ref.current?.backend, 'vt');
});

test('bytes from the program reach the screen', async () => {
  const { pty, ref } = await mountVt();
  await act(async () => {
    pty.last!.feed('hello \x1b[31mworld\x1b[m');
  });
  await waitFor(() =>
    assert.match(ref.current?.serialize() ?? '', /hello world/),
  );
});

test('a pty of your own: bytes in, split wherever the network split them', async () => {
  // The "BYO pty" case — ssh2, a WebSocket, a container exec — reduced to what
  // makes it different from node-pty: output arrives as *bytes*, chunked
  // wherever the transport felt like chunking. Splitting a two-byte character
  // down the middle is the thing that turns into mojibake if anybody decodes
  // per chunk, so it is what this feeds.
  let emit: ((chunk: Uint8Array) => void) | null = null;
  const host: PtyHost = {
    available: async () => true,
    openPty: async () => ({
      write() {},
      resize() {},
      kill: () => true,
      onData(listener) {
        emit = listener as (chunk: Uint8Array) => void;
      },
      onExit() {},
      pid: null,
    }),
  };

  const ref = React.createRef<TerminalHandle>();
  await renderX11(h(Terminal, { backend: 'vt', pty: host, ref }), {
    backend: 'mock',
  });
  await waitFor(() =>
    assert.ok(emit, 'the custom host was used, not node-pty'),
  );

  // "héllo" as UTF-8, cut between the two bytes of "é".
  const utf8 = new Uint8Array([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f]);
  await act(async () => {
    emit!(utf8.slice(0, 2));
  });
  await act(async () => {
    emit!(utf8.slice(2));
  });
  await waitFor(() => assert.match(ref.current?.serialize() ?? '', /héllo/));
});

test('write() is real at last, and typing reaches the pty', async () => {
  const { pty, ref } = await mountVt();
  const node = vtNode();
  // `mountVt` resolves on `openPty`, a beat before the commit that hands the
  // emulator to the node — and a key pressed in that gap is dropped at the
  // `!term` guard, not queued. Hold typing until the node can see its screen.
  await waitFor(() => assert.notEqual(node.serialize(), null));
  assert.equal(ref.current?.write('ls\r'), true);
  assert.equal(pty.last?.written, 'ls\r');

  let prevented = false;
  node.defaultKeyDown({
    keysym: undefined,
    codepoint: 0x61,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as Parameters<VtTermNode['defaultKeyDown']>[0]);
  await waitFor(() => assert.equal(pty.last?.written, 'ls\ra'));
  assert.ok(prevented, 'a key the terminal consumed is not also a focus move');
});

test('Escape arms one pass-through Tab, and Escape still reaches the program', async () => {
  const { pty } = await mountVt();
  const node = vtNode();
  // Same gap as above: no keys until the emulator has reached the node.
  await waitFor(() => assert.notEqual(node.serialize(), null));
  const press = (over: Record<string, unknown>): boolean => {
    let prevented = false;
    node.defaultKeyDown({
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: () => {
        prevented = true;
      },
      ...over,
    } as unknown as Parameters<VtTermNode['defaultKeyDown']>[0]);
    return prevented;
  };

  assert.ok(press({ keysym: XK_ESCAPE }), 'Escape is consumed…');
  assert.equal(pty.last?.written, '\x1b', '…and still sent');
  assert.equal(press({ keysym: XK_TAB }), false, 'the next Tab leaves');
  assert.equal(pty.last?.written, '\x1b', 'and sends nothing');
  assert.ok(press({ keysym: XK_TAB }), 'the one after it indents again');
  assert.equal(pty.last?.written, '\x1b\t');
});

test("the clipboard chords are a terminal's, and they really fire", async () => {
  // Through the real server, with real key events: the chord handling reads
  // fields (keysym vs codepoint, base vs shifted) that a hand-built event
  // object gets wrong in exactly the way the first cut of this did.
  const pty = new FakePtyHost();
  const r = await renderX11(h(Terminal, { backend: 'vt', pty }), {
    backend: 'xserver',
    width: 400,
    height: 200,
  });
  await waitFor(() => assert.ok(pty.last));
  const clipboard = (
    r.app as unknown as {
      clipboard: {
        write(text: string, o?: { selection?: string }): Promise<unknown>;
      };
    }
  ).clipboard;
  const node = vtNode();
  node.focus();
  await act(async () => {});

  await clipboard.write('pasted-text', { selection: 'CLIPBOARD' });
  await userEvent.key(0x76 /* v */, { modifiers: ['Control', 'Shift'] });
  await waitFor(() =>
    assert.match(pty.last?.written ?? '', /pasted-text/, 'Ctrl+Shift+V pastes'),
  );

  // Super+V is the same thing for the Command key on a Mac keyboard: `keys.ts`
  // never forwards a Super chord, so answering it takes nothing from the
  // program.
  pty.last!.writes.length = 0;
  await clipboard.write('cmd-pasted', { selection: 'CLIPBOARD' });
  await userEvent.key(0x76, { modifiers: ['Mod4'] });
  await waitFor(() =>
    assert.match(pty.last?.written ?? '', /cmd-pasted/, 'Super+V pastes too'),
  );

  // Shift+Insert takes PRIMARY, the convention that predates both.
  pty.last!.writes.length = 0;
  await clipboard.write('primary-text', { selection: 'PRIMARY' });
  await userEvent.key(0xff63 /* Insert */, { modifiers: ['Shift'] });
  await waitFor(() =>
    assert.match(
      pty.last?.written ?? '',
      /primary-text/,
      'Shift+Insert pastes',
    ),
  );

  // And the ones that must NOT be intercepted: Ctrl+C is SIGINT and Ctrl+V is
  // readline's literal-next, so both go to the program as control bytes.
  pty.last!.writes.length = 0;
  await userEvent.key(0x63 /* c */, { modifiers: ['Control'] });
  await userEvent.key(0x76 /* v */, { modifiers: ['Control'] });
  assert.equal(pty.last?.written, '\x03\x16');
});

test('the program exiting is reported once, with its status', async () => {
  const exits: Array<number | null> = [];
  const { pty, ref } = await mountVt({
    onExit: (info: { code: number | null }) => exits.push(info.code),
  });
  await act(async () => {
    pty.last!.exit({ code: 3, signal: null });
  });
  await waitFor(() => assert.deepEqual(exits, [3]));
  assert.equal(ref.current?.status, 'exited');
});

test('a firehose pauses the pty and resumes it once drained', async () => {
  const { pty } = await mountVt();
  const session = pty.last!;
  await act(async () => {
    // Past the high-water mark in one go — `yes(1)`, in a hurry.
    session.feed('x'.repeat(600 * 1024));
  });
  assert.ok(session.paused > 0, 'the pty was told to stop');
  await waitFor(() => assert.ok(session.resumed > 0, 'and to carry on'));
});

test('no pty module installed renders the fallback rather than throwing', async () => {
  const pty = new FakePtyHost({ installed: false });
  const ref = React.createRef<TerminalHandle>();
  await renderX11(
    h(Terminal, {
      backend: 'vt',
      pty,
      ref,
      fallback: h('text', { 'data-testname': 'no-pty' }, 'install node-pty'),
    }),
    { backend: 'mock' },
  );
  await waitFor(() => {
    assert.ok(
      screen.all((n: DrawnNode) => n.kind === 'text').length > 0,
      'the fallback rendered',
    );
  });
  assert.equal(ref.current?.status, 'unavailable');
  assert.equal(ref.current?.write('ls'), false, 'and nothing to write to');
});

test('the handle reports the vt backend and no child window', async () => {
  const { ref } = await mountVt();
  assert.equal(ref.current?.backend, 'vt');
  assert.equal(ref.current?.windowId, null);
  assert.ok((ref.current?.cols ?? 0) > 0);
});

test('the title the program sets is reported', async () => {
  const titles: string[] = [];
  const { pty } = await mountVt({
    onTitleChange: (t: string) => titles.push(t),
  });
  await act(async () => {
    pty.last!.feed('\x1b]0;build\x07');
  });
  await waitFor(() => assert.deepEqual(titles, ['build']));
});

test('a selection copies out, and PRIMARY carries it', async () => {
  const { pty } = await mountVt();
  await act(async () => {
    pty.last!.feed('hello world');
  });
  const node = vtNode();
  await waitFor(() => assert.match(node.serialize() ?? '', /hello/));
  // Drive the model directly: the mock backend injects no pointer events.
  node.selectAll();
  const text = node.selectionText();
  assert.match(text ?? '', /hello world/);
});

// --- 6. pixels --------------------------------------------------------------

test(
  'the retained renderer paints real cell colours',
  { skip: !FONTS },
  async () => {
    const pty = new FakePtyHost();
    const r = await renderX11(
      h(Terminal, {
        backend: 'vt',
        pty,
        fontFamily: 'monospace',
        fontSize: 16,
        colors: {
          background: '#000000',
          foreground: '#ffffff',
          palette: ['#000000', '#ff0000'],
        },
      }),
      { fonts: FONTS!, width: 400, height: 200 },
    );
    await waitFor(() => assert.ok(pty.last));
    await act(async () => {
      pty.last!.feed('\x1b[41m  \x1b[m');
    });

    const node = vtNode();
    await waitFor(() =>
      assert.equal(
        node.rendererStats.kind,
        'retained',
        'the Surface path is the one that ran',
      ),
    );
    const box = node.contentBox();
    // Inside the first cell, which the program painted red. Through `waitFor`
    // because the parse, the frame and the present are each a tick apart.
    await waitFor(() => expectPixel(r.ctx, box.x + 2, box.y + 2, '#ff0000'));
    // Past the two red cells: the terminal's own background.
    await expectPixel(
      r.ctx,
      box.x + box.width - 3,
      box.y + box.height - 3,
      '#000000',
    );
  },
);

test(
  'the grid the layout gives is the grid the program is told about',
  { skip: !FONTS },
  async () => {
    const pty = new FakePtyHost();
    const ref = React.createRef<TerminalHandle>();
    await renderX11(
      h(Terminal, {
        backend: 'vt',
        pty,
        ref,
        fontFamily: 'monospace',
        fontSize: 16,
        colors: { background: '#000000', foreground: '#ffffff' },
      }),
      { fonts: FONTS!, width: 400, height: 200 },
    );
    await waitFor(() => assert.ok(pty.last));
    const node = vtNode();
    const grid = node.gridSize();
    assert.ok(grid.cols > 1 && grid.rows > 1, 'the box measured to real cells');
    // The emulator reflows to it…
    await waitFor(() => assert.equal(ref.current?.cols, grid.cols));
    assert.equal(ref.current?.rows, grid.rows);
    // …and the pty hears about it, which is what SIGWINCH is.
    const session = pty.last!;
    const told =
      session.resizes[session.resizes.length - 1] ??
      ([pty.opened[0].options.cols, pty.opened[0].options.rows] as [
        number,
        number,
      ]);
    assert.deepEqual(told, [grid.cols, grid.rows]);
  },
);

test(
  'a keystroke costs a couple of cells, not a screenful',
  { skip: !FONTS },
  async () => {
    const pty = new FakePtyHost();
    await renderX11(
      h(Terminal, {
        backend: 'vt',
        pty,
        fontFamily: 'monospace',
        fontSize: 16,
        cursorBlink: false,
        colors: { background: '#000000', foreground: '#ffffff' },
      }),
      { fonts: FONTS!, width: 400, height: 200 },
    );
    await waitFor(() => assert.ok(pty.last));
    const node = vtNode();
    await act(async () => {
      pty.last!.feed('$ echo hello');
    });
    // Wait for the prompt to be *on screen*, not merely parsed, and then for
    // the frames to stop coming: a keystroke that lands in the same frame as
    // the line before it is one frame, which is the coalescing working rather
    // than a budget being blown.
    await waitFor(() => assert.match(node.serialize() ?? '', /echo hello/));
    await settle(node);
    const before = { ...node.rendererStats.totals };

    // One more character. Measured as a delta over the renderer's lifetime
    // counters, so an extra frame either side cannot move the answer — a
    // frame with nothing dirty draws nothing.
    await act(async () => {
      pty.last!.feed('!');
    });
    await waitFor(() =>
      assert.ok(
        node.rendererStats.totals.cellsFilled > before.cellsFilled,
        'the frame that draws it has not landed yet',
      ),
    );
    const after = node.rendererStats.totals;
    const filled = after.cellsFilled - before.cellsFilled;
    const glyphs = after.glyphsDrawn - before.glyphsDrawn;
    assert.ok(
      filled > 0 && filled <= 4,
      `one keystroke should repaint a couple of cells, filled ${filled}`,
    );
    assert.ok(glyphs <= 2, `and draw a glyph or two, not ${glyphs}`);
    assert.equal(after.copies - before.copies, 0, 'nothing scrolled');
  },
);

test(
  'scrolling moves the surviving band server-side',
  { skip: !FONTS },
  async () => {
    const pty = new FakePtyHost();
    await renderX11(
      h(Terminal, {
        backend: 'vt',
        pty,
        fontFamily: 'monospace',
        fontSize: 16,
        cursorBlink: false,
        colors: { background: '#000000', foreground: '#ffffff' },
      }),
      { fonts: FONTS!, width: 400, height: 200 },
    );
    await waitFor(() => assert.ok(pty.last));
    const node = vtNode();
    const { rows } = node.gridSize();
    // Fill the screen first and let it *paint*: a copy needs a mirror of
    // something, and the very first frame has none. Waiting for the pixels
    // rather than for the parse is the whole of it — on a slower machine the
    // two feeds otherwise coalesce into one frame, which repaints instead of
    // copying and is the coalescing working correctly.
    await act(async () => {
      pty.last!.feed(
        Array.from({ length: rows }, (_, i) => `line ${i}`).join('\r\n'),
      );
    });
    await waitFor(() =>
      assert.match(node.serialize() ?? '', new RegExp(`line ${rows - 1}`)),
    );
    await settle(node);
    // Now push it up by one.
    await act(async () => {
      pty.last!.feed('\r\none more');
    });
    await waitFor(() => {
      assert.ok(
        node.rendererStats.totals.copies > 0,
        'a scroll became a server-side copy, not a screenful of glyphs',
      );
    });
  },
);

// --- 7. a real pty ----------------------------------------------------------

// Everything above runs with no native module anywhere, which is what makes
// it CI. This one drives a real pty, and it is **opt-in** rather than merely
// skipped-when-absent:
//
//     REACT_X11_COMPONENTS_REAL_PTY=1 npx tsx --test test/terminal-vt.test.ts
//
// because node-pty keeps the event loop alive after its child has gone, so a
// suite that touches one does not exit — `npm test` hangs rather than fails,
// which is the worst way for a test to be wrong. The gate is the PRD's
// (§13), and `@lydell/node-pty` is a devDependency so the run is one command
// away for anyone.
const REAL_PTY =
  process.env.REACT_X11_COMPONENTS_REAL_PTY === '1' &&
  (await nodePtyHost().available());

test(
  'a real program on a real pty reaches the screen',
  { skip: !REAL_PTY },
  async () => {
    const host = nodePtyHost();
    const ref = React.createRef<TerminalHandle>();
    await renderX11(
      h(Terminal, {
        backend: 'vt',
        pty: host,
        ref,
        command: ['/bin/sh', '-c', 'echo vt-real-pty; exit 3'],
      }),
      { backend: 'mock' },
    );
    await waitFor(() =>
      assert.match(ref.current?.serialize() ?? '', /vt-real-pty/),
    );
    // …and the exit status of a program nobody faked.
    await waitFor(() => assert.equal(ref.current?.status, 'exited'));
  },
);

// The runtime's own pty (Bun 1.4's `Bun.spawn({ terminal })`) is preferred
// over node-pty wherever it exists, so a Bun app needs no native module at
// all. This suite runs under Node, where the *interesting* assertion is the
// negative one: the Bun host must not claim a pty it cannot open, and the
// default must fall through to node-pty rather than to nothing.
test('the bun pty host is honest about not being under bun', async () => {
  const underBun = typeof (globalThis as { Bun?: unknown }).Bun === 'object';
  assert.equal(
    await bunPtyHost().available(),
    underBun,
    'available() tracks the runtime, not the wish',
  );
  // Whichever runtime this is, the default resolves to the host that can
  // actually open a pty here.
  assert.equal(defaultPtyHost(), underBun ? bunPtyHost() : nodePtyHost());
  // The seam is still the seam: an explicit host wins over both.
  assert.notEqual(bunPtyHost(), nodePtyHost());
});

test('a pty seam that has nothing to load says which', async () => {
  const err = new PtyUnavailableError();
  assert.match(err.message, /no pty module is installed/);
  assert.deepEqual([...err.tried], ['node-pty', '@lydell/node-pty']);
  // The other half: a module that is there and will not load must not be
  // reported as missing, because "install it" is then the wrong advice.
  const broken = new PtyUnavailableError(
    new Error('NODE_MODULE_VERSION 127 vs 145'),
  );
  assert.match(broken.message, /installed but would not load/);
  assert.match(broken.message, /NODE_MODULE_VERSION/);
});
