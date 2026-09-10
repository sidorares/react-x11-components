// <Terminal>: the argv three different emulators want, and the lifecycle of
// the process behind it.
//
// Two halves, and the split is deliberate. The adapter table is pure
// functions, so every flag is asserted without an emulator installed. The
// component half runs against react-x11's in-process X server — `<foreign>`
// really does create a container window and really does hand its id to
// `onReady` there — with a fake `ProcessHost` standing in for the machine, so
// "xterm would have been spawned with `-into 2097154`" is a test and not a
// hope.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, act, screen, waitFor } from 'react-x11/test';
import type { Node as RetainedNode } from 'react-x11/node';

import {
  Terminal,
  alacritty,
  backendsFor,
  urxvt,
  xterm,
} from '../src/terminal/index.js';
import type { TerminalHandle } from '../src/terminal/index.js';
import {
  EmbedUnsupportedError,
  canHostXEmbed,
  useEmbeddedClient,
} from '../src/embed/index.js';
import type { EmbeddedClient, LaunchPlan } from '../src/embed/index.js';
import { cocoaShapedApp } from './cocoa-shaped.js';
import { FakeHost } from './fake-host.js';
import { FakePtyHost } from './fake-pty.js';

const h = React.createElement;

afterEach(cleanup);

function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

function foreignNode(): RetainedNode | undefined {
  const [node] = screen.all((n) => retained(n).kind === 'foreign');
  return node ? retained(node) : undefined;
}

/** The value of the flag after `name`, e.g. `flag(args, '-into')`. */
function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

// --- the adapter table -----------------------------------------------------

test('xterm gets -into, and -e stays last', () => {
  const args = xterm.args({
    windowId: 42,
    command: ['bash', '-lc', 'npm test'],
    fontFamily: 'Fira Code',
    fontSize: 13,
    scrollback: 5000,
    title: 'build',
    colors: { background: '#101014', foreground: '#eee', cursor: '#f39c12' },
  });

  assert.strictEqual(flag(args, '-into'), '42');
  // `-fa` is what switches xterm to Xft at all, so asking for a size must
  // also pass a family
  assert.strictEqual(flag(args, '-fa'), 'Fira Code');
  assert.strictEqual(flag(args, '-fs'), '13');
  assert.strictEqual(flag(args, '-sl'), '5000');
  assert.strictEqual(flag(args, '-T'), 'build');
  assert.strictEqual(flag(args, '-bg'), '#101014');
  assert.strictEqual(flag(args, '-fg'), '#eee');
  assert.strictEqual(flag(args, '-cr'), '#f39c12');

  // xterm reads everything after -e as the command, so nothing may follow it
  const e = args.indexOf('-e');
  assert.notStrictEqual(e, -1);
  assert.deepStrictEqual(args.slice(e + 1), ['bash', '-lc', 'npm test']);
});

test('xterm takes the ANSI palette as per-invocation X resources', () => {
  const args = xterm.args({
    windowId: 1,
    colors: { palette: ['#000', '#f00', '#0f0'] },
  });
  assert.ok(args.includes('XTerm*color0: #000'));
  assert.ok(args.includes('XTerm*color1: #f00'));
  assert.ok(args.includes('XTerm*color2: #0f0'));
  assert.strictEqual(args.filter((a) => a === '-xrm').length, 3);
});

test('a palette longer than 16 is truncated rather than passed on', () => {
  const args = xterm.args({
    windowId: 1,
    colors: {
      palette: Array.from({ length: 20 }, (_, i) => `#00000${i % 10}`),
    },
  });
  assert.strictEqual(args.filter((a) => a === '-xrm').length, 16);
});

test('urxvt spells the same things differently', () => {
  const args = urxvt.args({
    windowId: 7,
    command: ['zsh'],
    fontFamily: 'monospace',
    fontSize: 11,
    colors: { background: '#000', foreground: '#fff' },
  });
  assert.strictEqual(flag(args, '-embed'), '7');
  assert.strictEqual(flag(args, '-fn'), 'xft:monospace:size=11');
  assert.strictEqual(flag(args, '-bg'), '#000');
  assert.deepStrictEqual(args.slice(args.indexOf('-e') + 1), ['zsh']);
  // urxvt's palette lives in the X resource database, which is the user's
  assert.strictEqual(urxvt.palette, false);
});

test('alacritty gets TOML on the command line, quoted as TOML wants', () => {
  const args = alacritty.args({
    windowId: 9,
    command: ['bash'],
    fontFamily: 'Fira Code',
    fontSize: 12,
    scrollback: 1000,
    colors: { background: '#101014', palette: ['#000', '#f00'] },
  });
  assert.strictEqual(flag(args, '--embed'), '9');
  assert.ok(args.includes('font.normal.family="Fira Code"'));
  assert.ok(args.includes('font.size=12'));
  assert.ok(args.includes('scrolling.history=1000'));
  assert.ok(args.includes('colors.primary.background="#101014"'));
  assert.ok(args.includes('colors.normal.black="#000"'));
  assert.ok(args.includes('colors.normal.red="#f00"'));
});

test('a font family with a quote in it stays one TOML string', () => {
  const args = alacritty.args({ windowId: 1, fontFamily: 'He said "hi"' });
  assert.ok(args.includes('font.normal.family="He said \\"hi\\""'));
});

test('a pinned backend is the only candidate; auto is all of them in order', () => {
  assert.deepStrictEqual(
    backendsFor('auto').map((b) => b.name),
    ['xterm', 'urxvt', 'alacritty'],
  );
  assert.deepStrictEqual(
    backendsFor('alacritty').map((b) => b.name),
    ['alacritty'],
  );
});

// --- the component ---------------------------------------------------------

test('the container id <foreign> offers is what the emulator is given', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  await renderX11(
    h(Terminal, {
      processes: host,
      command: ['bash'],
      cwd: '/tmp',
      env: { TERM: 'xterm-256color' },
      style: { flexGrow: 1 },
    }),
    { backend: 'xserver' },
  );

  await waitFor(() => assert.strictEqual(host.spawns.length, 1));

  const node = foreignNode();
  assert.ok(node, 'the surface is a <foreign>');

  const spawn = host.last;
  assert.ok(spawn);
  assert.strictEqual(spawn.command, '/usr/bin/xterm');
  // the id in the argv is the container window, not something invented
  const into = Number(flag(spawn.args, '-into'));
  assert.ok(Number.isInteger(into) && into > 0);
  assert.strictEqual(spawn.options.cwd, '/tmp');
  assert.deepStrictEqual(spawn.options.env, { TERM: 'xterm-256color' });
});

test('auto-detection skips what is not installed', async () => {
  const host = new FakeHost({ installed: ['alacritty'] });
  await renderX11(h(Terminal, { processes: host }), { backend: 'xserver' });
  await waitFor(() => assert.strictEqual(host.spawns.length, 1));
  assert.strictEqual(host.last?.command, '/usr/bin/alacritty');
});

test('no emulator installed falls through to the vt backend', async () => {
  // The ladder ends at `vt` rather than at the `fallback`: this package's own
  // terminal needs nothing installed, so a machine with no xterm still gets a
  // terminal. What the fallback is for is the case below — nothing at all.
  const host = new FakeHost({ installed: [] });
  const pty = new FakePtyHost();
  const ref = React.createRef<TerminalHandle>();

  await renderX11(
    h(Terminal, {
      processes: host,
      pty,
      ref,
      fallback: h('text', { 'data-testname': 'no-terminal' }, 'install xterm'),
    }),
    { backend: 'xserver' },
  );

  await waitFor(() => assert.ok(pty.last, 'a pty was opened instead'));
  assert.strictEqual(ref.current?.backend, 'vt');
  assert.strictEqual(host.spawns.length, 0, 'and nothing was spawned');
});

test('nothing installed at all renders the fallback', async () => {
  // No emulator *and* no pty module. `pty` is pinned to a host that reports
  // neither, because the suite must never depend on what is installed on the
  // machine running it — and because a real `nodePtyHost()` here would open a
  // login shell that outlives the test.
  const host = new FakeHost({ installed: [] });
  const errors: Error[] = [];

  await renderX11(
    h(Terminal, {
      processes: host,
      pty: new FakePtyHost({ installed: false }),
      onError: (err) => errors.push(err),
      fallback: h('text', { 'data-testname': 'no-terminal' }, 'install xterm'),
    }),
    { backend: 'xserver' },
  );

  await waitFor(() => assert.ok(screen.getByTestName('no-terminal')));
  assert.strictEqual(foreignNode(), undefined, 'no surface to embed into');
  assert.strictEqual(host.spawns.length, 0);
  // Two now: the emulator probe found nothing, and so did the pty probe. The
  // second names what it looked for, so the app can print the install line.
  assert.ok(errors.length >= 1);
  assert.match(
    errors.map((err) => err.message).join('\n'),
    /no terminal backend is installed/,
  );
  assert.match(
    errors.map((err) => err.message).join('\n'),
    /no pty module is installed/,
  );
});

test('unmounting hands the emulator a signal, not a leak', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  await renderX11(h(Terminal, { processes: host }), { backend: 'xserver' });
  await waitFor(() => assert.strictEqual(host.spawns.length, 1));

  const child = host.last!.process;
  await cleanup();
  assert.deepStrictEqual(child.signals, ['SIGTERM']);
});

test('stopSignal is what gets sent', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  await renderX11(h(Terminal, { processes: host, stopSignal: 'SIGKILL' }), {
    backend: 'xserver',
  });
  await waitFor(() => assert.strictEqual(host.spawns.length, 1));

  const child = host.last!.process;
  await cleanup();
  assert.deepStrictEqual(child.signals, ['SIGKILL']);
});

test('exiting is reported, and the surface stays for the restart', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  const exits: unknown[] = [];
  const ref = React.createRef<TerminalHandle>();

  await renderX11(
    h(Terminal, { processes: host, ref, onExit: (info) => exits.push(info) }),
    { backend: 'xserver' },
  );
  await waitFor(() => assert.strictEqual(host.spawns.length, 1));

  await act(() => host.last!.process.exit({ code: 3, signal: null }));
  assert.deepStrictEqual(exits, [{ code: 3, signal: null }]);
  assert.strictEqual(ref.current?.status, 'exited');
  assert.ok(foreignNode(), 'the pane is still there to restart into');

  await act(() => ref.current?.restart());
  await waitFor(() => assert.strictEqual(host.spawns.length, 2));
  // the same container is reused: the restart is a new process, not a new pane
  assert.strictEqual(
    flag(host.spawns[0]!.args, '-into'),
    flag(host.spawns[1]!.args, '-into'),
  );
});

test('a re-render with an equal command does not restart the emulator', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  const { rerender } = await renderX11(
    h(Terminal, { processes: host, command: ['bash', '-l'] }),
    { backend: 'xserver' },
  );
  await waitFor(() => assert.strictEqual(host.spawns.length, 1));

  // A fresh array with the same contents — which is what an inline literal is
  // on every paint. Keying on identity here would respawn a terminal per
  // frame.
  await rerender(h(Terminal, { processes: host, command: ['bash', '-l'] }));
  await act();
  assert.strictEqual(host.spawns.length, 1);

  // …and a genuinely different command is a new emulator, because none of
  // them can be handed a new one.
  await rerender(h(Terminal, { processes: host, command: ['zsh'] }));
  await waitFor(() => assert.strictEqual(host.spawns.length, 2));
  assert.deepStrictEqual(host.spawns[1]!.args.slice(-1), ['zsh']);
  assert.deepStrictEqual(host.spawns[0]!.process.signals, ['SIGTERM']);
});

test('an inline onExit handler does not count as a change', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  const { rerender } = await renderX11(
    h(Terminal, { processes: host, onExit: () => {} }),
    { backend: 'xserver' },
  );
  await waitFor(() => assert.strictEqual(host.spawns.length, 1));

  await rerender(h(Terminal, { processes: host, onExit: () => {} }));
  await act();
  assert.strictEqual(host.spawns.length, 1);
});

test('enabled=false holds off spawning anything', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  const { rerender } = await renderX11(
    h(Terminal, { processes: host, enabled: false }),
    { backend: 'xserver' },
  );
  await act();
  assert.strictEqual(host.spawns.length, 0);
  assert.ok(foreignNode(), 'the pane exists, it is just empty');

  await rerender(h(Terminal, { processes: host, enabled: true }));
  await waitFor(() => assert.strictEqual(host.spawns.length, 1));
});

test('the handle signals the live process', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  const ref = React.createRef<TerminalHandle>();
  await renderX11(h(Terminal, { processes: host, ref }), {
    backend: 'xserver',
  });
  await waitFor(() => assert.strictEqual(host.spawns.length, 1));

  assert.strictEqual(ref.current?.backend, 'xterm');
  assert.strictEqual(ref.current?.pid, host.last!.process.pid);
  assert.strictEqual(ref.current?.signal('SIGINT'), true);
  assert.deepStrictEqual(host.last!.process.signals, ['SIGINT']);
});

test('a spawn that fails is reported and does not leave a phantom process', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  host.spawnError = new Error('EACCES');
  const errors: Error[] = [];
  const ref = React.createRef<TerminalHandle>();

  await renderX11(
    h(Terminal, { processes: host, ref, onError: (err) => errors.push(err) }),
    { backend: 'xserver' },
  );

  await waitFor(() => assert.strictEqual(errors.length, 1));
  assert.strictEqual(errors[0]!.message, 'EACCES');
  assert.strictEqual(ref.current?.pid, null);
  assert.strictEqual(ref.current?.status, 'exited');
});

test('the pane is focusable by default and opts out by prop', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  await renderX11(h(Terminal, { processes: host }), { backend: 'xserver' });
  assert.strictEqual(foreignNode()?.props.focusable, true);

  await cleanup();
  await renderX11(h(Terminal, { processes: host, focusable: false }), {
    backend: 'xserver',
  });
  assert.strictEqual(foreignNode()?.props.focusable, false);
});

// --- on a react-x11 backend with no XEmbed ---------------------------------
//
// The native macOS backend has no cross-process window embedding, so an
// emulator on `PATH` — XQuartz's xterm, on a Mac — is not a terminal the app
// can show. These render into an app whose `X` is that backend's stub
// (`./cocoa-shaped.ts`), and every one pins `pty`: `'auto'` lands on vt there
// whatever is installed, and an unpinned vt terminal opens a real shell that
// keeps the suite alive.

/**
 * Run `fn` with the vt-only prop warning swallowed. A test below pins `pty`
 * on a named emulator on purpose, and the component is right to say the prop
 * does nothing there — it is just not what that test is about.
 */
async function withoutVtOnlyWarning<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { console: { warn: (...args: unknown[]) => void } };
  const original = g.console.warn;
  g.console.warn = (...args: unknown[]) => {
    if (!String(args[0]).includes('only honoured by')) {
      original.apply(g.console, args);
    }
  };
  try {
    return await fn();
  } finally {
    g.console.warn = original;
  }
}

test('canHostXEmbed asks the connection, not PATH', async () => {
  const { app } = await renderX11(h('box'), { backend: 'xserver' });
  assert.strictEqual(canHostXEmbed(app), true, 'a real X connection can');
  assert.strictEqual(canHostXEmbed(cocoaShapedApp()), false);
  assert.strictEqual(canHostXEmbed(null), false);
  assert.strictEqual(canHostXEmbed({}), false);
  // a selection owner with no reparent is still not an embedder
  assert.strictEqual(canHostXEmbed({ X: { SetSelectionOwner() {} } }), false);
});

test("'auto' skips the emulators on an app that cannot host one, and lands on vt", async () => {
  // xterm is "installed": a PATH probe would find it, which was the bug — on
  // a Mac with XQuartz, 'auto' chose that xterm, and since the Cocoa
  // backend's <foreign> hands `onReady` a window id of undefined, it was
  // spawned `-into undefined`.
  const host = new FakeHost({ installed: ['xterm'] });
  const pty = new FakePtyHost();
  const ref = React.createRef<TerminalHandle>();
  const errors: Error[] = [];

  await renderX11(
    h(Terminal, {
      processes: host,
      pty,
      ref,
      onError: (err) => errors.push(err),
    }),
    { app: cocoaShapedApp(), backend: 'mock' },
  );

  await waitFor(() => assert.ok(pty.last, 'a pty was opened instead'));
  assert.strictEqual(ref.current?.backend, 'vt');
  assert.strictEqual(foreignNode(), undefined, 'no <foreign> was mounted');
  // Skipped, not tried: nothing was looked for, nothing was spawned, and
  // nothing went wrong.
  assert.deepStrictEqual(host.probed, []);
  assert.strictEqual(host.spawns.length, 0);
  assert.deepStrictEqual(errors, []);
});

test('an emulator named outright on such an app says it cannot embed, and spawns nothing', async () => {
  const host = new FakeHost({ installed: ['xterm'] });
  const pty = new FakePtyHost();
  const ref = React.createRef<TerminalHandle>();
  const errors: Error[] = [];
  const props = {
    backend: 'xterm' as const,
    processes: host,
    // Pinned though `xterm` never reaches vt: if it ever did, this is what
    // makes that regression a failed assertion rather than a hung suite.
    pty,
    ref,
    onError: (err: Error) => errors.push(err),
    fallback: h('text', { 'data-testname': 'no-embed' }, 'try backend="vt"'),
  };

  const { rerender } = await withoutVtOnlyWarning(() =>
    renderX11(h(Terminal, props), { app: cocoaShapedApp(), backend: 'mock' }),
  );

  await waitFor(() => assert.ok(screen.getByTestName('no-embed')));
  assert.strictEqual(ref.current?.status, 'unavailable');
  assert.strictEqual(ref.current?.backend, null);
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0] instanceof EmbedUnsupportedError);
  assert.match(errors[0]!.message, /cannot embed another program's window/);
  // Named means that one: no quiet swap to vt, and nothing spawned.
  assert.strictEqual(pty.last, null);
  assert.deepStrictEqual(host.probed, []);
  assert.strictEqual(host.spawns.length, 0);

  // A new command is a new plan, not new news.
  await rerender(h(Terminal, { ...props, command: ['zsh'] }));
  await act();
  assert.strictEqual(errors.length, 1, 'reported once');

  // With no fallback the pane keeps its place — still with no <foreign>.
  await rerender(h(Terminal, { ...props, fallback: undefined }));
  await act();
  assert.strictEqual(ref.current?.status, 'unavailable');
  assert.strictEqual(foreignNode(), undefined);
});

test('the hook spawns nothing on such an app, whatever onReady hands over', async () => {
  // Not hypothetical: the Cocoa backend's <foreign> does call onReady, with
  // `{ windowId: undefined }`, which slipped past a `windowId === null` guard
  // and ran the plan. The app decides, not the event — and this is the
  // wrapper that renders a <foreign> there anyway.
  const host = new FakeHost({ installed: ['xterm'] });
  let planned = 0;
  const plan = async (): Promise<LaunchPlan> => {
    planned += 1;
    return { command: 'xterm', args: [] };
  };
  const seen: { client: EmbeddedClient | null } = { client: null };
  function Probe(): React.ReactElement {
    seen.client = useEmbeddedClient({ plan, host });
    return h('box');
  }

  await renderX11(h(Probe), { app: cocoaShapedApp(), backend: 'mock' });
  await act(() =>
    seen.client!.handleReady({ windowId: undefined as unknown as number }),
  );
  await act(() => seen.client!.handleReady({ windowId: 42 }));
  await act();

  assert.strictEqual(planned, 0, 'the plan never ran');
  assert.strictEqual(host.spawns.length, 0);
  assert.strictEqual(seen.client!.status, 'unavailable');
});
