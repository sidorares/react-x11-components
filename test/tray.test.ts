// <TrayHost>: the manager selection, the docking handshake, and what the host
// advertises — against a real X server, in process.
//
// These run for real rather than through a seam, because every interesting
// thing about a tray is something the server arbitrates: who owns the
// selection, who hears about losing it, and where a client's window ends up
// when a node unmounts. node-x11's pure-JavaScript server implements
// selections, SendEvent and QueryTree, so all of that is observable with no
// $DISPLAY and no panel installed.
//
// The one thing worth stating up front, because it is what makes the suite
// short: a tray icon is **somebody else's window**, and the assertion that
// matters most is negative — that unmounting, losing the selection and
// reordering the strip all leave those windows alive and reparented to the
// root.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, screen, waitFor } from 'react-x11/test';
import type { Node as RetainedNode } from 'react-x11/node';

import {
  BalloonMessages,
  TrayHost,
  hostVisual,
  sendNotification,
  traySelectionName,
} from '../src/tray/index.js';
import type {
  TrayApp,
  TrayHostHandle,
  TrayMessage,
  TrayX,
  TrayXEvent,
} from '../src/tray/index.js';
import {
  CLIENT_MESSAGE,
  MANAGER,
  STRUCTURE_NOTIFY_MASK,
  SYSTEM_TRAY_BEGIN_MESSAGE,
  SYSTEM_TRAY_CANCEL_MESSAGE,
  SYSTEM_TRAY_REQUEST_DOCK,
  TRAY_MESSAGE_DATA,
  TRAY_OPCODE,
  TRAY_ORIENTATION,
  TRAY_VISUAL,
} from '../src/tray/protocol.js';
import type { MessageBus } from 'react-x11';

const h = React.createElement;

afterEach(cleanup);

// --- the bits of the connection the tests drive ----------------------------

/** `TrayX` plus what only a test needs: a client to dock, and the reads that
 *  say where it ended up. */
interface TestX extends TrayX {
  MapWindow(id: number): void;
  ChangeWindowAttributes(
    wid: number,
    values: Record<string, number>,
    cb: (err: Error | null) => void,
  ): void;
  QueryTree(
    wid: number,
    cb: (
      err: Error | null,
      tree: { root: number; parent: number; children: number[] },
    ) => void,
  ): void;
  GetProperty(
    del: number,
    wid: number,
    name: number,
    type: number,
    longOffset: number,
    longLength: number,
    cb: (err: Error | null, prop: { type: number; data: Buffer }) => void,
  ): void;
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

/** A round trip, which is also the barrier that says every request queued
 *  ahead of it has been processed. */
function sync(X: TestX): Promise<void> {
  return new Promise((resolve) => X.GetInputFocus(() => resolve()));
}

function parentOf(X: TestX, wid: number): Promise<number | null> {
  return new Promise((resolve) =>
    X.QueryTree(wid, (err, tree) => resolve(err ? null : tree.parent)),
  );
}

async function property(
  X: TestX,
  wid: number,
  atom: number,
): Promise<number | null> {
  const prop = await new Promise<{ type: number; data: Buffer } | null>(
    (resolve) =>
      X.GetProperty(0, wid, atom, 0, 0, 0x1fffffff, (err, value) =>
        resolve(err ? null : value),
      ),
  );
  if (!prop || !prop.type || prop.data.length < 4) return null;
  return prop.data.readUInt32LE(0);
}

/** A window standing in for an application's tray icon. */
function makeClient(X: TestX, root: number): number {
  const id = X.AllocID();
  X.CreateWindow(id, root, 0, 0, 22, 22, 0, 0, 1, 0, { eventMask: 0 });
  X.MapWindow(id);
  return id;
}

/** The retained node behind a query result — `props` and `kind` live there,
 *  and the query type is the drawn view of it. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

function foreignNodes(): RetainedNode[] {
  return screen.all((node) => retained(node).kind === 'foreign').map(retained);
}

interface Mounted {
  view: Awaited<ReturnType<typeof renderX11>>;
  X: TestX;
  root: number;
  handle: React.RefObject<TrayHostHandle | null>;
  /**
   * Re-render the tray with new props, or with `null` to unmount it and
   * leave the connection open — which is what a panel closing its tray looks
   * like, and what `view.unmount()` cannot show because it also closes the
   * server the assertions read from.
   */
  render(
    props: Record<string, unknown> | null,
    extra?: React.ReactNode,
  ): Promise<void>;
  atoms: {
    selection: number;
    manager: number;
    opcode: number;
    messageData: number;
    orientation: number;
    visual: number;
  };
  /** Every `MANAGER` broadcast seen on the root window. */
  broadcasts: TrayXEvent[];
}

/**
 * Mount a `<TrayHost>` on a connection that already exists.
 *
 * The empty first render is what makes the broadcast observable: `MANAGER`
 * goes out during the tray's mount, so a test that selected StructureNotify on
 * the root afterwards would be racing it.
 */
async function mountTray(
  props: Record<string, unknown> = {},
  prepare?: (app: TrayApp) => void,
): Promise<Mounted> {
  const view = await renderX11(h('box', null), { backend: 'xserver' });
  const X = (view.app as unknown as { X: TestX }).X;
  const root = X.display.screen[0]!.root;
  prepare?.(view.app as unknown as TrayApp);

  const [selection, manager, opcode, messageData, orientation, visual] =
    await Promise.all(
      [
        traySelectionName(0),
        MANAGER,
        TRAY_OPCODE,
        TRAY_MESSAGE_DATA,
        TRAY_ORIENTATION,
        TRAY_VISUAL,
      ].map((name) => intern(X, name)),
    );
  const atoms = {
    selection: selection!,
    manager: manager!,
    opcode: opcode!,
    messageData: messageData!,
    orientation: orientation!,
    visual: visual!,
  };

  const broadcasts: TrayXEvent[] = [];
  X.ChangeWindowAttributes(
    root,
    { eventMask: STRUCTURE_NOTIFY_MASK },
    () => {},
  );
  await sync(X);
  X.on('event', (ev) => {
    if (ev.type === CLIENT_MESSAGE && ev.message_type === atoms.manager) {
      broadcasts.push(ev);
    }
  });

  const handle = React.createRef<TrayHostHandle>();
  // Inside a `<box>` so the tray keeps its place in the tree when a test adds
  // a second host beside it: swapping the root element's type would unmount
  // the first tray and hand the selection to whichever of the two new ones
  // won the race.
  const render = (
    next: Record<string, unknown> | null,
    extra?: React.ReactNode,
  ): Promise<void> =>
    view.rerender(
      h(
        'box',
        null,
        next && h(TrayHost, { ref: handle, ...next }),
        extra ?? null,
      ),
    );
  await render(props);
  return { view, X, root, handle, atoms, broadcasts, render };
}

/** Wait for the tray to be the tray, and answer its manager window. */
async function hosting(m: Mounted): Promise<number> {
  await waitFor(() => assert.strictEqual(m.handle.current?.status, 'hosting'));
  const window = m.handle.current?.windowId;
  assert.ok(window, 'hosting without a manager window');
  return window;
}

function requestDock(m: Mounted, manager: number, clientId: number): void {
  m.X.SendClientMessage(
    manager,
    manager,
    m.atoms.opcode,
    32,
    [0, SYSTEM_TRAY_REQUEST_DOCK, clientId, 0, 0],
    0,
  );
}

/** Dock a fresh client and wait for its `<foreign>` to hold it. */
async function dock(m: Mounted, manager: number): Promise<number> {
  const before = foreignNodes().length;
  const client = makeClient(m.X, m.root);
  requestDock(m, manager, client);
  await waitFor(() => assert.strictEqual(foreignNodes().length, before + 1));
  await waitFor(async () =>
    assert.notStrictEqual(
      await parentOf(m.X, client),
      m.root,
      'the client is still at the root, so nothing embedded it',
    ),
  );
  return client;
}

// --- the manager selection -------------------------------------------------

test('mounting takes the selection and broadcasts MANAGER', async () => {
  const m = await mountTray();
  const manager = await hosting(m);

  assert.strictEqual(
    await selectionOwner(m.X, m.atoms.selection),
    manager,
    'the manager window owns _NET_SYSTEM_TRAY_S0',
  );

  const [announced] = m.broadcasts;
  assert.ok(announced, 'no MANAGER broadcast reached the root window');
  assert.deepStrictEqual(announced.data?.slice(1, 3), [
    m.atoms.selection,
    manager,
  ]);
  assert.ok(
    (announced.data?.[0] ?? 0) > 0,
    'the acquisition timestamp is a real one, not CurrentTime (ICCCM 2.1)',
  );
});

test('unmounting gives the selection back', async () => {
  const m = await mountTray();
  await hosting(m);

  await m.render(null);
  await sync(m.X);
  assert.strictEqual(await selectionOwner(m.X, m.atoms.selection), 0);
});

test('a second host reports the conflict and embeds nothing', async () => {
  const m = await mountTray();
  const manager = await hosting(m);

  const second = React.createRef<TrayHostHandle>();
  let conflict: { owner: number } | null = null;
  await m.render(
    {},
    h(TrayHost, {
      ref: second,
      onConflict: (info: { owner: number }) => {
        conflict = info;
      },
    }),
  );

  await waitFor(() => assert.strictEqual(second.current?.status, 'conflict'));
  assert.deepStrictEqual(conflict, { owner: manager });
  assert.strictEqual(second.current?.windowId, null, 'it owns no window');

  // and the first host is untouched: one dock request, one icon, and it is
  // the tray that still holds the selection that drew it
  await dock(m, manager);
  assert.strictEqual(foreignNodes().length, 1);
  assert.deepStrictEqual(second.current?.icons, []);
  assert.strictEqual(await selectionOwner(m.X, m.atoms.selection), manager);
});

// --- docking ---------------------------------------------------------------

test('a dock request produces one <foreign>, for the id in the message', async () => {
  const docked: number[] = [];
  const m = await mountTray({
    onDock: (icon: { windowId: number }) => docked.push(icon.windowId),
  });
  const manager = await hosting(m);

  const client = await dock(m, manager);
  const [node] = foreignNodes();
  assert.strictEqual(foreignNodes().length, 1);
  assert.strictEqual(
    (node?.props as { windowId?: number }).windowId,
    client,
    'the id embedded is the one data[2] carried',
  );
  assert.strictEqual(
    (node?.props as { focusable?: boolean }).focusable,
    false,
    'a tray icon is a click target, not a tab stop',
  );
  assert.deepStrictEqual(docked, [client]);
  assert.deepStrictEqual(m.handle.current?.icons, [client]);

  // A client that asks twice — the ordinary answer to a MANAGER broadcast it
  // was already docked with — is still one icon.
  requestDock(m, manager, client);
  await sync(m.X);
  assert.strictEqual(foreignNodes().length, 1);
  assert.deepStrictEqual(docked, [client]);
});

test('a client destroyed by its own process takes only its own icon', async () => {
  const undocked: number[] = [];
  const m = await mountTray({
    onUndock: (icon: { windowId: number }) => undocked.push(icon.windowId),
  });
  const manager = await hosting(m);

  const first = await dock(m, manager);
  const second = await dock(m, manager);
  assert.strictEqual(foreignNodes().length, 2);

  m.X.DestroyWindow(first);
  await waitFor(() => assert.strictEqual(foreignNodes().length, 1));
  assert.deepStrictEqual(undocked, [first]);
  assert.deepStrictEqual(m.handle.current?.icons, [second]);
  assert.strictEqual(
    (foreignNodes()[0]?.props as { windowId?: number }).windowId,
    second,
  );
});

test('unmounting hands every icon back to the root, alive', async () => {
  const m = await mountTray();
  const manager = await hosting(m);
  const client = await dock(m, manager);

  await m.render(null);
  await sync(m.X);

  assert.strictEqual(
    await parentOf(m.X, client),
    m.root,
    'the client was reparented back rather than destroyed',
  );
});

// --- losing the selection --------------------------------------------------

test('SelectionClear releases every icon, and none of them is destroyed', async () => {
  let replaced = 0;
  const m = await mountTray({
    onReplaced: () => {
      replaced += 1;
    },
  });
  const manager = await hosting(m);
  const first = await dock(m, manager);
  const second = await dock(m, manager);

  // Another tray on this display takes the selection. A window of our own
  // stands in for its manager window: what the server cares about is that the
  // owner changed, and the SelectionClear it sends is the same either way.
  const usurper = m.X.AllocID();
  m.X.CreateWindow(usurper, m.root, -1, -1, 1, 1, 0, 0, 1, 0, {});
  m.X.SetSelectionOwner(usurper, m.atoms.selection, 0);

  await waitFor(() => assert.strictEqual(m.handle.current?.status, 'replaced'));
  assert.strictEqual(replaced, 1);
  await waitFor(() => assert.strictEqual(foreignNodes().length, 0));
  await sync(m.X);

  for (const client of [first, second]) {
    assert.strictEqual(
      await parentOf(m.X, client),
      m.root,
      'an icon released by a lost selection goes back to the root',
    );
  }
});

// --- what the host advertises ----------------------------------------------

test('the orientation property follows the prop', async () => {
  const m = await mountTray();
  const manager = await hosting(m);

  assert.strictEqual(await property(m.X, manager, m.atoms.orientation), 0);

  await m.render({ orientation: 'vertical' });
  await waitFor(async () =>
    assert.strictEqual(await property(m.X, manager, m.atoms.orientation), 1),
  );
  // republished rather than restarted: an icon does not get reparented
  // because a panel changed shape
  assert.strictEqual(m.handle.current?.windowId, manager);
});

test('no visual is advertised by a window that cannot composite icons', async () => {
  const m = await mountTray();
  const manager = await hosting(m);
  assert.strictEqual(
    await property(m.X, manager, m.atoms.visual),
    null,
    'an absent _NET_SYSTEM_TRAY_VISUAL is what tells an icon to draw itself opaque',
  );
});

test('a host window on the ARGB visual advertises it', async () => {
  // The in-process server publishes one depth-24 visual, so there is no real
  // ARGB one to find. What the component actually asks is "is the window these
  // icons will live in drawn on the visual this display calls ARGB", and that
  // is answerable by making the answer the visual the window really has — which
  // also proves the strip resolved to a window at all.
  let advertised = 0;
  const m = await mountTray({}, (app) => {
    const screenInfo = app.X.display.screen[0] as unknown as {
      root_visual: number;
    };
    advertised = screenInfo.root_visual;
    app.findArgbVisual = () => ({ visual: advertised, depth: 32 });
  });
  const manager = await hosting(m);

  assert.ok(advertised > 0, 'the display has no root visual to stand in');
  await waitFor(async () =>
    assert.strictEqual(
      await property(m.X, manager, m.atoms.visual),
      advertised,
    ),
  );
});

test('the visual advertised is the one the host window really has', async () => {
  const argb = { visual: 0x77, depth: 32 };
  const fake = (windowVisual: number): TrayApp =>
    ({
      findArgbVisual: () => argb,
      X: {
        GetWindowAttributes: (
          _wid: number,
          cb: (err: Error | null, attrs: { visual: number }) => void,
        ) => cb(null, { visual: windowVisual }),
      },
    }) as unknown as TrayApp;

  assert.strictEqual(await hostVisual(fake(0x77), 0, 42), 0x77);
  // the window is on the root visual: saying otherwise is what puts a black
  // box behind every icon that believed it
  assert.strictEqual(await hostVisual(fake(0x21), 0, 42), 0);
  // and there is nothing to advertise before the window exists
  assert.strictEqual(await hostVisual(fake(0x77), 0, null), 0);
});

// --- ordering --------------------------------------------------------------

test('reordering the strip does not release or re-embed anything', async () => {
  const m = await mountTray();
  const manager = await hosting(m);
  const first = await dock(m, manager);
  const second = await dock(m, manager);

  const nodesBefore = foreignNodes();
  const containers = {
    first: await parentOf(m.X, first),
    second: await parentOf(m.X, second),
  };

  await m.render({ order: (icons: readonly number[]) => [...icons].reverse() });
  await waitFor(() =>
    assert.deepStrictEqual(m.handle.current?.icons, [second, first]),
  );
  await sync(m.X);

  const nodesAfter = foreignNodes();
  assert.strictEqual(nodesAfter.length, 2);
  assert.deepStrictEqual(
    [nodesAfter[0], nodesAfter[1]],
    [nodesBefore[1], nodesBefore[0]],
    'the same two nodes, in the other order',
  );
  // The real assertion: a re-embed would have built a new container window,
  // so an unchanged parent is proof that neither client was handed back and
  // taken again — the race docs/embedding.md describes.
  assert.strictEqual(await parentOf(m.X, first), containers.first);
  assert.strictEqual(await parentOf(m.X, second), containers.second);
});

test('an order that invents or forgets an icon cannot embed the wrong window', async () => {
  const m = await mountTray();
  const manager = await hosting(m);
  const first = await dock(m, manager);
  const second = await dock(m, manager);

  // a window that never docked, a repeat, and one real icon left out
  await m.render({ order: () => [999, first, first] });
  await waitFor(() =>
    assert.deepStrictEqual(m.handle.current?.icons, [first, second]),
  );
  assert.deepStrictEqual(
    foreignNodes().map(
      (node) => (node.props as { windowId?: number }).windowId,
    ),
    [first, second],
  );
});

// --- balloon messages ------------------------------------------------------

test('a balloon message is reassembled from its 20-byte chunks', async () => {
  const messages: TrayMessage[] = [];
  const m = await mountTray({
    onMessage: (message: TrayMessage) => messages.push(message),
  });
  const manager = await hosting(m);
  const client = await dock(m, manager);

  const text = 'Backup finished — 41 files, 2.3 GB, no errors at all';
  const bytes = [...Buffer.from(text, 'utf8')];

  m.X.SendClientMessage(
    manager,
    client,
    m.atoms.opcode,
    32,
    [0, SYSTEM_TRAY_BEGIN_MESSAGE, 5000, bytes.length, 42],
    0,
  );
  for (let at = 0; at < bytes.length; at += 20) {
    m.X.SendClientMessage(
      manager,
      client,
      m.atoms.messageData,
      8,
      bytes.slice(at, at + 20),
      0,
    );
  }

  await waitFor(() => assert.strictEqual(messages.length, 1));
  assert.deepStrictEqual(messages[0], {
    windowId: client,
    id: 42,
    timeout: 5000,
    text,
  });
});

test('a cancelled message is reported so a balloon can be taken down', async () => {
  const cancels: { windowId: number; id: number }[] = [];
  const m = await mountTray({
    onMessage: () => {},
    onMessageCancel: (info: { windowId: number; id: number }) =>
      cancels.push(info),
  });
  const manager = await hosting(m);
  const client = await dock(m, manager);

  m.X.SendClientMessage(
    manager,
    client,
    m.atoms.opcode,
    32,
    [0, SYSTEM_TRAY_CANCEL_MESSAGE, 42, 0, 0],
    0,
  );
  await waitFor(() =>
    assert.deepStrictEqual(cancels, [{ windowId: client, id: 42 }]),
  );
});

test('the assembler pads, replaces and forgets', () => {
  const balloons = new BalloonMessages();

  // The last chunk is 20 bytes whatever the message length, so the tail is
  // whatever was in the event — only `length` bytes of it are the message.
  assert.strictEqual(balloons.begin(7, 1, 0, 5), null);
  const padded = [...Buffer.from('hello', 'utf8'), ...new Array(15).fill(0)];
  assert.deepStrictEqual(balloons.data(7, padded), {
    windowId: 7,
    id: 1,
    timeout: 0,
    text: 'hello',
  });

  // Nothing outstanding: data with no BEGIN is a client that was mid-message
  // when this host took the selection.
  assert.strictEqual(balloons.data(7, [65]), null);

  // A second BEGIN replaces the first — the data messages carry only the
  // sending window, so a continuation and a new message are the same event.
  balloons.begin(7, 1, 0, 4);
  balloons.data(7, [...Buffer.from('ab', 'utf8')]);
  balloons.begin(7, 2, 0, 2);
  assert.deepStrictEqual(balloons.data(7, [...Buffer.from('hi', 'utf8')]), {
    windowId: 7,
    id: 2,
    timeout: 0,
    text: 'hi',
  });

  // Zero bytes is a complete message, not a wait.
  assert.deepStrictEqual(balloons.begin(7, 3, 100, 0), {
    windowId: 7,
    id: 3,
    timeout: 100,
    text: '',
  });

  // Cancelled and forgotten messages both stop being assembled.
  balloons.begin(7, 4, 0, 2);
  balloons.cancel(7, 4);
  assert.strictEqual(balloons.data(7, [65, 66]), null);
  balloons.begin(7, 5, 0, 2);
  balloons.forget(7);
  assert.strictEqual(balloons.data(7, [65, 66]), null);
});

test('the default sink hands a message to the notification service', async () => {
  const calls: unknown[][] = [];
  const bus = {
    getService: () => ({
      getInterface: async () => ({
        Notify: async (...args: unknown[]) => {
          calls.push(args);
          return 7;
        },
      }),
    }),
  } as unknown as MessageBus;

  const id = await sendNotification(
    bus,
    { windowId: 3, id: 1, timeout: 4000, text: 'Sync failed\nCheck the log' },
    'Panel',
  );

  assert.strictEqual(id, 7);
  assert.deepStrictEqual(calls[0], [
    'Panel',
    0,
    '',
    // one string, two fields: the first line titles it and the rest is body
    'Sync failed',
    'Check the log',
    [],
    [],
    4000,
  ]);
});

// --- a connection that cannot host one -------------------------------------

test('a display with no selections to own is unavailable, not an error', async () => {
  const handle = React.createRef<TrayHostHandle>();
  const errors: Error[] = [];
  await renderX11(
    h(TrayHost, {
      ref: handle,
      onError: (err: Error) => errors.push(err),
      fallback: h('text', null, 'No tray here.'),
    }),
    { backend: 'mock' },
  );

  await waitFor(() =>
    assert.strictEqual(handle.current?.status, 'unavailable'),
  );
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(foreignNodes().length, 0);
  assert.ok(screen.queryByText('No tray here.'), 'the fallback renders');
});
