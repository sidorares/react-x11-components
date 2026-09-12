// Collaboration, verified: y-prosemirror's sync, undo and cursor plugins —
// what a Yjs-backed ProseMirror editor runs, unchanged — over two editors
// whose Y.Docs and awareness are relayed in-process, which is what a
// provider (y-websocket, y-webrtc) does over a network. The one piece of
// the wiring that is this editor's is `remoteCaret`, the cursor builder.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  cleanup,
  renderX11,
  screen,
  userEvent,
  waitFor,
  XK_END,
  XK_HOME,
  XK_RIGHT,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { keymap } from 'prosemirror-keymap';
import type { Command, Plugin } from 'prosemirror-state';

import { RichTextEditor, remoteCaret } from '../src/rich-text-editor/index.js';
import type { RichTextEditorHandle } from '../src/rich-text-editor/index.js';
import type { EditorTextNode } from '../src/rich-text-editor/nodes.js';

// yjs, y-prosemirror and y-protocols are loaded by name, and the little of
// them used here is typed by hand. Their own declarations do not compile in
// this repository's program — `nodenext` resolution with `skipLibCheck` off:
// y-prosemirror's relative imports carry no file extension, and yjs's name
// the worker global `self` — and they are this test's dependencies, not the
// package's, so a name the compiler cannot follow keeps them out of it.
interface YDoc {
  on(
    event: 'update',
    listener: (update: Uint8Array, origin: unknown) => void,
  ): void;
  getXmlFragment(name: string): unknown;
  /** And its awareness with it, whose check timer would keep the test
   *  process alive. */
  destroy(): void;
}

interface Awareness {
  on(
    event: 'update',
    listener: (
      changed: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => void,
  ): void;
  setLocalStateField(field: string, value: unknown): void;
}

const load = (name: string): Promise<unknown> => import(name);

const Y = (await load('yjs')) as {
  Doc: new () => YDoc;
  applyUpdate(doc: YDoc, update: Uint8Array, origin: unknown): void;
};
const yProsemirror = (await load('y-prosemirror')) as {
  ySyncPlugin(fragment: unknown): Plugin;
  yCursorPlugin(
    awareness: Awareness,
    options: { cursorBuilder: typeof remoteCaret },
  ): Plugin;
  yUndoPlugin(): Plugin;
  undo: Command;
  redo: Command;
};
const awareness = (await load('y-protocols/awareness')) as {
  Awareness: new (doc: YDoc) => Awareness;
  applyAwarenessUpdate(
    to: Awareness,
    update: Uint8Array,
    origin: unknown,
  ): void;
  encodeAwarenessUpdate(from: Awareness, clients: number[]): Uint8Array;
};

const h = React.createElement;

/** The Y.Docs a test made: destroyed after it, editors first. */
const live: YDoc[] = [];

afterEach(() => {
  cleanup();
  for (const doc of live.splice(0)) doc.destroy();
});

/** Every update on one side applied on the other: a provider, in process. */
function relay(a: YDoc, b: YDoc): void {
  const pipe = (from: YDoc, to: YDoc): void => {
    from.on('update', (update, origin) => {
      if (origin !== 'relay') Y.applyUpdate(to, update, 'relay');
    });
  };
  pipe(a, b);
  pipe(b, a);
}

function relayAwareness(a: Awareness, b: Awareness): void {
  const pipe = (from: Awareness, to: Awareness): void => {
    from.on('update', (changed, origin) => {
      if (origin === 'relay') return;
      const clients = [
        ...changed.added,
        ...changed.updated,
        ...changed.removed,
      ];
      awareness.applyAwarenessUpdate(
        to,
        awareness.encodeAwarenessUpdate(from, clients),
        'relay',
      );
    });
  };
  pipe(a, b);
  pipe(b, a);
}

/** One collaborator: a Y.Doc, its awareness, and the plugins an editor
 *  bound to them runs — prosemirror-history out, yUndoPlugin in. */
function collaborator(
  name: string,
  color: string,
): { doc: YDoc; present: Awareness; plugins: Plugin[] } {
  const doc = new Y.Doc();
  live.push(doc);
  const present = new awareness.Awareness(doc);
  present.setLocalStateField('user', { name, color });
  return {
    doc,
    present,
    plugins: [
      yProsemirror.ySyncPlugin(doc.getXmlFragment('prosemirror')),
      yProsemirror.yCursorPlugin(present, { cursorBuilder: remoteCaret }),
      yProsemirror.yUndoPlugin(),
      keymap({
        'Mod-z': yProsemirror.undo,
        'Mod-y': yProsemirror.redo,
        'Shift-Mod-z': yProsemirror.redo,
      }),
    ],
  };
}

async function mountPair(): Promise<{
  ada: RichTextEditorHandle;
  bob: RichTextEditorHandle;
}> {
  const a = collaborator('Ada', '#d0021b');
  const b = collaborator('Bob', '#0a7d33');
  relay(a.doc, b.doc);
  relayAwareness(a.present, b.present);
  const ada = React.createRef<RichTextEditorHandle>();
  const bob = React.createRef<RichTextEditorHandle>();
  await renderX11(
    h(
      'box',
      { style: { flexDirection: 'column', gap: 8 } },
      h(RichTextEditor, {
        key: 'ada',
        ref: ada,
        plugins: a.plugins,
        history: false,
      }),
      h(RichTextEditor, {
        key: 'bob',
        ref: bob,
        plugins: b.plugins,
        history: false,
      }),
    ),
  );
  assert.ok(ada.current && bob.current, 'both handles are set');
  return { ada: ada.current, bob: bob.current };
}

/** Every textblock's element, in document order: Ada's, then Bob's. */
function texts(): EditorTextNode[] {
  return screen.all(
    (x) => x.kind === 'richeditortext',
  ) as unknown as EditorTextNode[];
}

const drawn = (node: EditorTextNode): DrawnNode => node as unknown as DrawnNode;

function runsOf(
  block: EditorTextNode,
): Array<{ text: string } & Record<string, unknown>> {
  return (
    block.props as { runs: Array<{ text: string } & Record<string, unknown>> }
  ).runs;
}

const KEY_Z = 0x7a;

test('typing in one editor appears in the other, and undo takes back only the typist’s own', async () => {
  const { ada, bob } = await mountPair();
  await userEvent.click(drawn(texts()[0]));
  await userEvent.type(drawn(texts()[0]), 'hello', { skipClick: true });
  await waitFor(() => assert.strictEqual(bob.state.doc.textContent, 'hello'));

  await userEvent.click(drawn(texts()[1]));
  await userEvent.key(XK_END, { modifiers: ['Control'] });
  await userEvent.type(drawn(texts()[1]), ' world', { skipClick: true });
  await waitFor(() =>
    assert.strictEqual(ada.state.doc.textContent, 'hello world'),
  );

  // Ada's undo is yUndoPlugin's: it takes back what she typed, and leaves
  // what Bob typed after it
  await userEvent.click(drawn(texts()[0]));
  await userEvent.key(KEY_Z, { modifiers: ['Control'] });
  await waitFor(() => assert.strictEqual(ada.state.doc.textContent, ' world'));
  assert.strictEqual(bob.state.doc.textContent, ' world');
});

test('a collaborator’s caret is drawn where it is, their selection is lit, and both go when they leave', async () => {
  await mountPair();
  await userEvent.click(drawn(texts()[0]));
  await userEvent.type(drawn(texts()[0]), 'hello', { skipClick: true });
  await waitFor(() =>
    assert.deepStrictEqual(texts()[1].collaboratorCarets, [
      { index: 5, color: '#d0021b' },
    ]),
  );

  // Ada selects "ell"
  await userEvent.key(XK_HOME);
  await userEvent.key(XK_RIGHT);
  for (let i = 0; i < 3; i++)
    await userEvent.key(XK_RIGHT, { modifiers: ['Shift'] });
  await waitFor(() => {
    const lit = runsOf(texts()[1]).find((run) => run.text === 'ell');
    assert.strictEqual(lit?.bg, '#d0021b70', 'her selection, in her colour');
  });
  assert.deepStrictEqual(
    texts()[1].collaboratorCarets.map((c) => c.index),
    [4],
    'the caret at the selection’s head',
  );
  assert.deepStrictEqual(
    texts()[0].collaboratorCarets,
    [],
    'Bob has not been in: no caret of his in Ada’s editor',
  );

  // Bob comes in: Ada's caret leaves his editor, and his appears in hers
  await userEvent.click(drawn(texts()[1]));
  await waitFor(() =>
    assert.deepStrictEqual(texts()[1].collaboratorCarets, []),
  );
  await waitFor(() =>
    assert.deepStrictEqual(
      texts()[0].collaboratorCarets.map((c) => c.color),
      ['#0a7d33'],
    ),
  );
});
