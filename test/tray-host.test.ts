// <TrayHost>: the manager selection, docking, and what the host advertises.
//
// Two halves, the same split `terminal.test.ts` uses. The protocol half is
// pure functions — the balloon reassembler, the UTF-8 decode, the visual
// decision — so every byte of the spec is asserted without a display. The
// component half runs against react-x11's in-process X server, where the
// selection is really taken, the `MANAGER` broadcast really lands on the
// root, and a `SYSTEM_TRAY_REQUEST_DOCK` really reparents a window: the test
// creates ordinary X windows and docks them the way an application would.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, act, screen, waitFor } from 'react-x11/test';
import type { Node as RetainedNode } from 'react-x11/node';

import {
  BalloonAssembler,
  TrayManager,
  ORIENTATION_HORIZONTAL,
  ORIENTATION_VERTICAL,
  SYSTEM_TRAY_BEGIN_MESSAGE,
  SYSTEM_TRAY_CANCEL_MESSAGE,
  SYSTEM_TRAY_REQUEST_DOCK,
  TrayHost,
  argbVisualOf,
  decodeUtf8,
  orientationValue,
  selectionNameFor,
} from '../src/tray-host/index.js';
import type {
  TrayApp,
  TrayHostHandle,
  TrayIcon,
} from '../src/tray-host/index.js';

const h = React.createElement;

afterEach(cleanup);

// --- the protocol, without a display ---------------------------------------

test('the selection is per screen and the orientation is the spec value', () => {
  assert.strictEqual(selectionNameFor(0), '_NET_SYSTEM_TRAY_S0');
  assert.strictEqual(selectionNameFor(2), '_NET_SYSTEM_TRAY_S2');
  assert.strictEqual(orientationValue('horizontal'), ORIENTATION_HORIZONTAL);
  assert.strictEqual(orientationValue('vertical'), ORIENTATION_VERTICAL);
});

test('a visual is only advertised when the window genuinely has it', () => {
  const screenInfo = {
    depths: {
      24: { '32': { class: 4 } },
      32: { '80': { class: 4 }, '81': { class: 3 } },
    },
  };
  // the 32-bit TrueColor visual: the whole point of the property
  assert.strictEqual(argbVisualOf(screenInfo, 80), 80);
  // depth 32 but not TrueColor — the channels are looked up, not direct
  assert.strictEqual(argbVisualOf(screenInfo, 81), 0);
  // a 24-bit visual that happens to be numbered 32 is not an ARGB visual
  assert.strictEqual(argbVisualOf(screenInfo, 32), 0);
  assert.strictEqual(argbVisualOf(screenInfo, 0), 0);
  assert.strictEqual(argbVisualOf(undefined, 80), 0);
  assert.strictEqual(argbVisualOf({}, 80), 0);
});

test('balloon messages reassemble across 20-byte chunks', () => {
  const balloons = new BalloonAssembler();
  const text = 'Backing up your home directory';
  const bytes = [...text].map((c) => c.charCodeAt(0));

  assert.strictEqual(
    balloons.begin(7, { id: 4, timeout: 5000, length: bytes.length }),
    null,
  );
  assert.strictEqual(balloons.data(7, bytes.slice(0, 20)), null);

  // the last chunk is padded to 20 bytes, and the padding is not the message
  const tail = bytes.slice(20);
  while (tail.length < 20) tail.push(0);
  const message = balloons.data(7, tail);

  assert.deepStrictEqual(message, {
    windowId: 7,
    id: 4,
    timeout: 5000,
    text,
  });
  assert.strictEqual(balloons.pendingCount, 0);
});

test('a zero-length message is complete the moment it is announced', () => {
  const balloons = new BalloonAssembler();
  const message = balloons.begin(9, { id: 1, timeout: 0, length: 0 });
  assert.deepStrictEqual(message, {
    windowId: 9,
    id: 1,
    timeout: 0,
    text: '',
  });
  // …and nothing is left waiting for a chunk that will never come
  assert.strictEqual(balloons.pendingCount, 0);
});

test('cancel drops the right message, and only that one', () => {
  const balloons = new BalloonAssembler();
  balloons.begin(7, { id: 4, timeout: 0, length: 30 });
  balloons.begin(8, { id: 4, timeout: 0, length: 30 });

  assert.strictEqual(balloons.cancel(7, 99), false, 'a different message id');
  assert.strictEqual(balloons.cancel(7, 4), true);
  assert.strictEqual(balloons.pendingCount, 1);

  // data for a cancelled message has nothing to attach to and is dropped
  assert.strictEqual(balloons.data(7, [65]), null);
  balloons.forget(8);
  assert.strictEqual(balloons.pendingCount, 0);
});

test('message text is UTF-8, and malformed bytes do not throw', () => {
  assert.strictEqual(decodeUtf8([0xc3, 0xa9]), 'é');
  assert.strictEqual(decodeUtf8([0xe2, 0x9c, 0x93]), '✓');
  assert.strictEqual(decodeUtf8([0xf0, 0x9f, 0x92, 0xbe]), '💾');
  assert.strictEqual(decodeUtf8([0x68, 0x69]), 'hi');
  // a continuation byte with no lead, and a lead with no continuation
  assert.strictEqual(decodeUtf8([0x80]), '�');
  assert.strictEqual(decodeUtf8([0xe2, 0x9c]), '�');
});

// --- the component, against a real X server --------------------------------

/** The bits of node-x11 these tests drive. It is `any` in core's own
 *  declarations — `useApp()` is the escape hatch — so it is written out
 *  here the way the component writes out the slice it uses. */
interface TestX {
  AllocID(): number;
  CreateWindow(
    id: number,
    parent: number,
    x: number,
    y: number,
    width: number,
    height: number,
    borderWidth: number,
    depth: number,
    klass: number,
    visual: number,
    values: Record<string, unknown>,
  ): void;
  MapWindow(id: number): void;
  DestroyWindow(id: number): void;
  ChangeWindowAttributes(
    id: number,
    values: Record<string, unknown>,
    cb: (err: Error | null) => void,
  ): void;
  InternAtom(
    onlyIfExists: boolean,
    name: string,
    cb: (err: Error | null, atom: number) => void,
  ): void;
  GetSelectionOwner(
    atom: number,
    cb: (err: Error | null, owner: number) => void,
  ): void;
  SetSelectionOwner(owner: number, atom: number, time: number): void;
  GetProperty(
    del: number,
    wid: number,
    atom: number,
    type: number,
    offset: number,
    length: number,
    cb: (err: Error | null, prop: { type: number; data: Buffer }) => void,
  ): void;
  QueryTree(
    wid: number,
    cb: (err: Error | null, tree: { root: number; parent: number }) => void,
  ): void;
  SendEvent(
    destination: number,
    propagate: number,
    eventMask: number,
    event: Record<string, unknown>,
  ): void;
  on(name: 'event', fn: (ev: Record<string, number>) => void): void;
}

const STRUCTURE_NOTIFY = 131072;

function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

/** Every embedded icon, in paint order. */
function foreignNodes(): RetainedNode[] {
  return screen.all((n) => retained(n).kind === 'foreign').map(retained);
}

function iconIds(): number[] {
  return foreignNodes().map((n) => n.props.windowId as number);
}

function intern(X: TestX, name: string): Promise<number> {
  return new Promise((resolve, reject) =>
    X.InternAtom(false, name, (err, atom) =>
      err ? reject(err) : resolve(atom),
    ),
  );
}

function selectionOwner(X: TestX, atom: number): Promise<number> {
  return new Promise((resolve, reject) =>
    X.GetSelectionOwner(atom, (err, owner) =>
      err ? reject(err) : resolve(owner),
    ),
  );
}

/** The property's 32-bit values, or `null` when it is not set at all. */
function cardinals(
  X: TestX,
  wid: number,
  atom: number,
): Promise<number[] | null> {
  return new Promise((resolve) =>
    X.GetProperty(0, wid, atom, 0, 0, 64, (err, prop) => {
      if (err || !prop?.type || !prop.data?.length) return resolve(null);
      const out: number[] = [];
      for (let i = 0; i + 4 <= prop.data.length; i += 4) {
        out.push(prop.data.readUInt32LE(i));
      }
      resolve(out);
    }),
  );
}

function parentOf(X: TestX, wid: number): Promise<number | null> {
  return new Promise((resolve) =>
    X.QueryTree(wid, (err, tree) => resolve(err ? null : tree.parent)),
  );
}

/** A window standing in for an application that wants to be in the tray. */
function createClient(X: TestX, root: number): number {
  const id = X.AllocID();
  X.CreateWindow(id, root, 0, 0, 22, 22, 0, 0, 1, 0, { eventMask: 0 });
  X.MapWindow(id);
  return id;
}

/** What an application sends to ask for a place in the tray. */
function requestDock(
  X: TestX,
  manager: number,
  opcode: number,
  client: number,
): void {
  X.SendEvent(manager, 0, 0, {
    name: 'ClientMessage',
    format: 32,
    wid: manager,
    message_type: opcode,
    data: [0, SYSTEM_TRAY_REQUEST_DOCK, client, 0, 0],
  });
}

interface Harness {
  X: TestX;
  app: TrayApp;
  root: number;
  atoms: {
    selection: number;
    opcode: number;
    orientation: number;
    visual: number;
    messageData: number;
    manager: number;
  };
  rerender(element: React.ReactNode): Promise<void>;
}

/**
 * A connection with the atoms already interned, before any `<TrayHost>` has
 * mounted — so a test can watch the root for the `MANAGER` broadcast that
 * mounting one produces. The tray is rendered with `rerender`.
 */
async function harness(): Promise<Harness> {
  const result = await renderX11(h('box'), { backend: 'xserver' });
  const app = result.app as unknown as {
    X: TestX;
    display: { screen: { root: number }[] };
  };
  const X = app.X;
  const [selection, opcode, orientation, visual, messageData, manager] =
    await Promise.all([
      intern(X, selectionNameFor(0)),
      intern(X, '_NET_SYSTEM_TRAY_OPCODE'),
      intern(X, '_NET_SYSTEM_TRAY_ORIENTATION'),
      intern(X, '_NET_SYSTEM_TRAY_VISUAL'),
      intern(X, '_NET_SYSTEM_TRAY_MESSAGE_DATA'),
      intern(X, 'MANAGER'),
    ]);
  return {
    X,
    app: result.app as unknown as TrayApp,
    root: app.display.screen[0]!.root,
    atoms: {
      selection: selection!,
      opcode: opcode!,
      orientation: orientation!,
      visual: visual!,
      messageData: messageData!,
      manager: manager!,
    },
    rerender: result.rerender,
  };
}

/**
 * One `<TrayHost>` per entry, keyed by position — so a test that adds a
 * second panel adds it *beside* the first rather than replacing the tree and
 * remounting both. Two hosts racing for one selection is a real thing, but it
 * is not what the conflict tests are about.
 */
function trays(...specs: Record<string, unknown>[]): React.ReactElement {
  return h(
    React.Fragment,
    null,
    specs.map((spec, i) => h(TrayHost, { key: String(i), ...spec })),
  );
}

/** Mount a tray and wait until it owns the selection. */
async function mountTray(
  env: Harness,
  props: Record<string, unknown> = {},
): Promise<React.RefObject<TrayHostHandle | null>> {
  const ref = React.createRef<TrayHostHandle>();
  await env.rerender(trays({ ...props, ref }));
  await waitFor(() => assert.strictEqual(ref.current?.status, 'owned'));
  return ref;
}

test('mounting takes the selection and broadcasts MANAGER; unmounting releases it', async () => {
  const env = await harness();

  // Watch the root the way a client waiting for a tray does.
  const announcements: number[][] = [];
  await new Promise<void>((resolve) =>
    env.X.ChangeWindowAttributes(
      env.root,
      { eventMask: STRUCTURE_NOTIFY },
      () => resolve(),
    ),
  );
  env.X.on('event', (ev) => {
    if (ev.type === 33 && ev.message_type === env.atoms.manager) {
      announcements.push((ev as unknown as { data: number[] }).data);
    }
  });

  const ref = await mountTray(env);
  const manager = ref.current!.windowId!;
  assert.ok(manager > 0, 'the selection is held on a window of its own');
  assert.strictEqual(await selectionOwner(env.X, env.atoms.selection), manager);

  await waitFor(() => assert.strictEqual(announcements.length, 1));
  const [broadcast] = announcements;
  assert.strictEqual(broadcast![1], env.atoms.selection);
  assert.strictEqual(broadcast![2], manager, 'the manager window to talk to');
  assert.notStrictEqual(broadcast![0], 0, 'a real timestamp, not CurrentTime');

  // Unmounted through the tree rather than through `cleanup()`, which closes
  // the connection this then has to ask.
  await env.rerender(h('box'));
  await waitFor(async () =>
    assert.strictEqual(
      await selectionOwner(env.X, env.atoms.selection),
      0,
      'unmounting stops claiming to be the tray',
    ),
  );
});

test('a second host on the same screen reports the conflict and embeds nothing', async () => {
  const env = await harness();
  const first = React.createRef<TrayHostHandle>();
  const second = React.createRef<TrayHostHandle>();
  const conflicts: { owner: number }[] = [];

  await env.rerender(trays({ ref: first }));
  await waitFor(() => assert.strictEqual(first.current?.status, 'owned'));
  const owner = first.current!.windowId!;

  await env.rerender(
    trays(
      { ref: first },
      {
        ref: second,
        onConflict: (info: { owner: number }) => conflicts.push(info),
      },
    ),
  );

  await waitFor(() => assert.strictEqual(second.current?.status, 'conflict'));
  assert.strictEqual(first.current?.status, 'owned', 'the first one still is');
  assert.deepStrictEqual(conflicts, [{ owner, screen: 0 }]);
  assert.strictEqual(second.current?.windowId, null, 'it took no window');
  assert.strictEqual(await selectionOwner(env.X, env.atoms.selection), owner);

  // …and a client that docks reaches the tray that exists, not the one that
  // gave up
  const client = createClient(env.X, env.root);
  requestDock(env.X, owner, env.atoms.opcode, client);
  await waitFor(() => assert.deepStrictEqual(iconIds(), [client]));
  assert.deepStrictEqual(second.current?.icons, []);
});

test('SYSTEM_TRAY_REQUEST_DOCK produces exactly one <foreign>, for the id in the message', async () => {
  const env = await harness();
  const docked: TrayIcon[] = [];
  const ref = await mountTray(env, {
    onDock: (icon: TrayIcon) => docked.push(icon),
  });
  const manager = ref.current!.windowId!;

  const client = createClient(env.X, env.root);
  requestDock(env.X, manager, env.atoms.opcode, client);

  await waitFor(() => assert.strictEqual(foreignNodes().length, 1));
  assert.deepStrictEqual(iconIds(), [client]);
  assert.deepStrictEqual(
    docked.map((icon) => icon.id),
    [client],
  );

  // a tray icon is a click target, not a tab stop
  assert.strictEqual(foreignNodes()[0]!.props.focusable, false);

  // the same window asking twice is still one icon
  requestDock(env.X, manager, env.atoms.opcode, client);
  await act();
  assert.strictEqual(foreignNodes().length, 1);
  assert.strictEqual(docked.length, 1);

  // and the client really is inside the container now, not still at the root
  await waitFor(async () =>
    assert.notStrictEqual(await parentOf(env.X, client), env.root),
  );
});

test('SelectionClear releases every icon — each reparented back, none destroyed', async () => {
  const env = await harness();
  const undocked: number[] = [];
  const ref = await mountTray(env, {
    onUndock: (icon: TrayIcon) => undocked.push(icon.id),
  });
  const manager = ref.current!.windowId!;

  const first = createClient(env.X, env.root);
  const second = createClient(env.X, env.root);
  requestDock(env.X, manager, env.atoms.opcode, first);
  requestDock(env.X, manager, env.atoms.opcode, second);
  await waitFor(() => assert.deepStrictEqual(iconIds(), [first, second]));

  // Another tray takes the selection. This is the failure users report as
  // "my tray is empty": a panel that keeps drawing icons it no longer holds.
  const rival = env.X.AllocID();
  env.X.CreateWindow(rival, env.root, -1, -1, 1, 1, 0, 0, 2, 0, {
    eventMask: 0,
  });
  env.X.SetSelectionOwner(rival, env.atoms.selection, 0);

  await waitFor(() => assert.strictEqual(ref.current?.status, 'released'));
  await waitFor(() => assert.strictEqual(foreignNodes().length, 0));
  assert.deepStrictEqual(undocked.sort(), [first, second].sort());

  // Both clients are alive and back on the root. Destroying somebody else's
  // window because a React tree changed is the one thing this must not do.
  await waitFor(async () => {
    assert.strictEqual(await parentOf(env.X, first), env.root);
    assert.strictEqual(await parentOf(env.X, second), env.root);
  });
});

test('a client destroyed by its own process removes its icon and nothing else', async () => {
  const env = await harness();
  const undocked: number[] = [];
  const ref = await mountTray(env, {
    onUndock: (icon: TrayIcon) => undocked.push(icon.id),
  });
  const manager = ref.current!.windowId!;

  const first = createClient(env.X, env.root);
  const second = createClient(env.X, env.root);
  requestDock(env.X, manager, env.atoms.opcode, first);
  requestDock(env.X, manager, env.atoms.opcode, second);
  await waitFor(() => assert.deepStrictEqual(iconIds(), [first, second]));

  env.X.DestroyWindow(first);

  await waitFor(() => assert.deepStrictEqual(iconIds(), [second]));
  assert.deepStrictEqual(undocked, [first]);
  assert.strictEqual(ref.current?.status, 'owned', 'still the tray');
});

test('orientation follows the prop, and no visual is advertised on a plain window', async () => {
  const env = await harness();
  const ref = await mountTray(env, { orientation: 'vertical' });
  const manager = ref.current!.windowId!;

  assert.deepStrictEqual(
    await cardinals(env.X, manager, env.atoms.orientation),
    [ORIENTATION_VERTICAL],
  );
  // The test server's window is not ARGB, so saying it was would give every
  // icon that believed us a black box.
  assert.strictEqual(await cardinals(env.X, manager, env.atoms.visual), null);

  await env.rerender(trays({ orientation: 'horizontal', ref }));
  await waitFor(async () =>
    assert.deepStrictEqual(
      await cardinals(env.X, manager, env.atoms.orientation),
      [ORIENTATION_HORIZONTAL],
    ),
  );
  // …and republishing a property is not a reason to give the selection up
  assert.strictEqual(ref.current?.status, 'owned');
  assert.strictEqual(ref.current?.windowId, manager);
});

test('reordering icons does not release and re-embed any of them', async () => {
  const env = await harness();
  const undocked: number[] = [];
  const ref = await mountTray(env, {
    onUndock: (icon: TrayIcon) => undocked.push(icon.id),
  });
  const manager = ref.current!.windowId!;

  const first = createClient(env.X, env.root);
  const second = createClient(env.X, env.root);
  requestDock(env.X, manager, env.atoms.opcode, first);
  requestDock(env.X, manager, env.atoms.opcode, second);
  await waitFor(() => assert.deepStrictEqual(iconIds(), [first, second]));

  const before = new Map(foreignNodes().map((n) => [n.props.windowId, n]));

  await env.rerender(
    trays({ ref, sort: (a: TrayIcon, b: TrayIcon) => b.id - a.id }),
  );
  await waitFor(() => assert.deepStrictEqual(iconIds(), [second, first]));

  // The nodes moved; they were not rebuilt. Unmounting one `<foreign>` and
  // mounting another with the same id parks the client at the root long
  // enough for a window manager to frame it, and the new node then reports
  // `onClientGone` for a live window.
  for (const node of foreignNodes()) {
    assert.strictEqual(
      node,
      before.get(node.props.windowId),
      'the icon kept its node, and so its socket',
    );
  }
  assert.deepStrictEqual(undocked, [], 'nothing was handed back');
});

test('a balloon message arrives assembled, and a cancel withdraws it', async () => {
  const env = await harness();
  const messages: { text: string; id: number; timeout: number }[] = [];
  const cancelled: { windowId: number; id: number }[] = [];
  const ref = await mountTray(env, {
    onMessage: (m: { text: string; id: number; timeout: number }) =>
      messages.push(m),
    onCancelMessage: (info: { windowId: number; id: number }) =>
      cancelled.push(info),
  });
  const manager = ref.current!.windowId!;

  const client = createClient(env.X, env.root);
  requestDock(env.X, manager, env.atoms.opcode, client);
  await waitFor(() => assert.deepStrictEqual(iconIds(), [client]));

  const text = 'Sync finished';
  const bytes = [...text].map((c) => c.charCodeAt(0));
  // The begin names the icon it is about and is sent to the manager window,
  // which is how one message is told from another icon's.
  env.X.SendEvent(manager, 0, 0, {
    name: 'ClientMessage',
    format: 32,
    wid: client,
    message_type: env.atoms.opcode,
    data: [0, SYSTEM_TRAY_BEGIN_MESSAGE, 4000, bytes.length, 17],
  });
  const chunk = [...bytes];
  while (chunk.length < 20) chunk.push(0);
  env.X.SendEvent(manager, 0, 0, {
    name: 'ClientMessage',
    format: 8,
    wid: client,
    message_type: env.atoms.messageData,
    data: chunk,
  });

  await waitFor(() => assert.strictEqual(messages.length, 1));
  assert.deepStrictEqual(messages[0], {
    windowId: client,
    id: 17,
    timeout: 4000,
    text,
  });

  // A message withdrawn before its data arrives is never delivered.
  env.X.SendEvent(manager, 0, 0, {
    name: 'ClientMessage',
    format: 32,
    wid: client,
    message_type: env.atoms.opcode,
    data: [0, SYSTEM_TRAY_BEGIN_MESSAGE, 0, 12, 18],
  });
  env.X.SendEvent(manager, 0, 0, {
    name: 'ClientMessage',
    format: 32,
    wid: client,
    message_type: env.atoms.opcode,
    data: [0, SYSTEM_TRAY_CANCEL_MESSAGE, 18, 0, 0],
  });
  await waitFor(() =>
    assert.deepStrictEqual(cancelled, [{ windowId: client, id: 18 }]),
  );
  assert.strictEqual(messages.length, 1);
});

test('a manager that was stopped takes the selection again when restarted', async () => {
  // React remounts an effect on the same instance in development, so a
  // one-shot manager comes back dead: it reports `'released'` forever and
  // the panel is a tray that is not the tray.
  const env = await harness();
  const manager = new TrayManager(env.app, 0);

  await manager.start({ orientation: 'horizontal', hostWindowId: null });
  assert.strictEqual(manager.status, 'owned');
  const firstWindow = manager.windowId;

  manager.stop();
  assert.strictEqual(manager.status, 'released');
  await waitFor(async () =>
    assert.strictEqual(await selectionOwner(env.X, env.atoms.selection), 0),
  );

  await manager.start({ orientation: 'vertical', hostWindowId: null });
  assert.strictEqual(manager.status, 'owned');
  assert.notStrictEqual(manager.windowId, firstWindow, 'a fresh window');
  assert.strictEqual(
    await selectionOwner(env.X, env.atoms.selection),
    manager.windowId,
  );
  assert.deepStrictEqual(
    await cardinals(env.X, manager.windowId, env.atoms.orientation),
    [ORIENTATION_VERTICAL],
  );

  manager.stop();
});

test('the fallback renders instead of an empty row when another host owns it', async () => {
  const env = await harness();
  const first = await mountTray(env);
  const second = React.createRef<TrayHostHandle>();

  await env.rerender(
    trays(
      { ref: first },
      {
        ref: second,
        fallback: h('text', { 'data-testname': 'no-tray' }, 'tray taken'),
      },
    ),
  );

  await waitFor(() => assert.ok(screen.getByTestName('no-tray')));
  assert.strictEqual(second.current?.status, 'conflict');
});
