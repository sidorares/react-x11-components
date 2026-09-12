// Drag and drop, through core's own drag: a press on the selection, motion
// past the threshold, a release over the target — the gesture a user makes,
// driven through react-x11's harness. What is under test is the editor's
// half of it: what a drag carries, where a drop goes in, what a move takes
// out, and what the other kinds of drop become.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';
import type { ReactElement } from 'react';

import {
  act,
  cleanup,
  fireEvent,
  MOD,
  renderX11,
  screen,
} from 'react-x11/test';
import type {
  PointerOptions,
  RenderX11Options,
  TestServer,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { TextSelection } from 'prosemirror-state';

import { RichTextEditor } from '../src/rich-text-editor/index.js';
import type {
  RichTextEditorHandle,
  RichTextEditorProps,
} from '../src/rich-text-editor/index.js';
import type { EditorTextNode } from '../src/rich-text-editor/nodes.js';

const h = React.createElement;

afterEach(() => cleanup());

// the font pair the widget suite measures glyphs with; a box without it
// skips these, which aim at characters
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
const WITH_FONTS: RenderX11Options = FONTS ? { fonts: FONTS } : {};

function blocks(): EditorTextNode[] {
  return screen.all(
    (x) => x.kind === 'richeditortext',
  ) as unknown as EditorTextNode[];
}

const drawn = (node: unknown): DrawnNode => node as DrawnNode;

/** A pointer offset a quarter into drawn code point `index` — device
 *  pixels from the node's centre, which is what `fireEvent` takes. */
function at(block: EditorTextNode, index: number): { dx: number; dy: number } {
  const r = block.textCaretRect(index);
  assert.ok(r, 'the block has a layout');
  const next = block.textCaretRect(index + 1);
  const x =
    next && next.y === r.y && next.x > r.x ? r.x + (next.x - r.x) / 4 : r.x + 1;
  const { abs } = drawn(block);
  return {
    dx: x - (abs.x + abs.width / 2),
    dy: r.y + r.height / 2 - (abs.y + abs.height / 2),
  };
}

/** Motion is paced to frames, which `act()` does not run: wait one. */
async function landed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act();
}

/** Press on `from`, move past the drag threshold, then over `to`, and stay
 *  there — so a test can look before `release`. */
async function dragTo(
  from: DrawnNode,
  fromAt: PointerOptions,
  to: DrawnNode,
  toAt: PointerOptions,
): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(from, fromAt);
  });
  await act(async () => {
    fireEvent.mouseMove(from, { ...fromAt, dx: (fromAt.dx ?? 0) + 14 });
  });
  await landed();
  await act(async () => {
    fireEvent.mouseMove(to, toAt);
  });
  await landed();
}

async function release(
  over: DrawnNode,
  options: PointerOptions = {},
): Promise<void> {
  await act(async () => {
    fireEvent.mouseUp(over, options);
  });
  await landed();
}

/** Select `from`–`to` through the handle: no press, so the one a test makes
 *  next is not a double click. */
function selectRange(
  editor: RichTextEditorHandle,
  from: number,
  to: number,
): Promise<void> {
  return act(() => {
    editor.run((state, dispatch) => {
      dispatch?.(
        state.tr.setSelection(TextSelection.create(state.doc, from, to)),
      );
      return true;
    });
  });
}

const selected = (editor: RichTextEditorHandle): string => {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, '\n');
};

/** A plain element that drags `data`: another widget of the app, or what a
 *  file manager would offer. */
function Source({ data }: { data: Record<string, string> }): ReactElement {
  return h(
    'box',
    {
      draggable: true,
      dragData: data,
      dragActions: ['copy'],
      'data-testname': 'source',
      style: { height: 24, width: 140, backgroundColor: '#dddddd' },
    },
    h('text', null, 'drag me'),
  );
}

function source(): DrawnNode {
  const node = screen.all(
    (n) =>
      (n as unknown as { props?: Record<string, unknown> }).props?.[
        'data-testname'
      ] === 'source',
  )[0];
  assert.ok(node, 'the source is mounted');
  return node;
}

/** The X server of the latest `mount`: a test that holds a key reaches it. */
let server: TestServer | null = null;

async function mount(
  props: RichTextEditorProps,
  beside?: ReactElement,
): Promise<RichTextEditorHandle> {
  const ref = React.createRef<RichTextEditorHandle>();
  const mounted = await renderX11(
    h(
      'box',
      { style: { flexDirection: 'column', gap: 12, padding: 8 } },
      beside ?? null,
      h(RichTextEditor, { ...props, ref }),
    ),
    WITH_FONTS,
  );
  server = mounted.server;
  assert.ok(ref.current, 'the handle is set');
  return ref.current;
}

/** Hold Control down until the function handed back is called — the way
 *  a hand holds it through a drag. `fireEvent` presses a modifier only
 *  around a press, a click or a wheel: a motion or a release carries none. */
function holdControl(): () => void {
  const s = server;
  assert.ok(s, 'an X server to press the key on');
  const keycode = s.keymap.modifiers[Math.log2(MOD.Control)]?.find(Boolean);
  assert.ok(keycode, 'the server maps a Control key');
  s.injectKey(keycode, true);
  return () => s.injectKey(keycode, false);
}

test(
  'a drag of the selection moves it to where it is dropped',
  { skip: !FONTS },
  async () => {
    const editor = await mount({ defaultValue: 'one two three' });
    await selectRange(editor, 5, 8);
    assert.strictEqual(selected(editor), 'two');
    const [block] = blocks();
    await dragTo(drawn(block), at(block, 5), drawn(block), at(block, 13));
    assert.strictEqual(
      blocks()[0].dropCaret,
      13,
      'a caret where it would go in',
    );
    await release(drawn(block), at(block, 13));
    assert.strictEqual(editor.state.doc.textContent, 'one  threetwo');
    assert.strictEqual(selected(editor), 'two', 'what went in is selected');
    assert.strictEqual(blocks()[0].dropCaret, null, 'and the caret is gone');
  },
);

test(
  'a press on the selection that does not drag is a click: the caret goes there',
  { skip: !FONTS },
  async () => {
    const editor = await mount({ defaultValue: 'one two three' });
    await selectRange(editor, 5, 8);
    const [block] = blocks();
    await act(async () => {
      fireEvent.mouseDown(drawn(block), at(block, 5));
    });
    await release(drawn(block), at(block, 5));
    assert.ok(editor.state.selection.empty, 'the selection went');
    assert.strictEqual(editor.state.selection.head, 6);
  },
);

test(
  'the copy modifier held at the drop copies instead of moving',
  { skip: !FONTS },
  async () => {
    const editor = await mount({ defaultValue: 'one two three' });
    await selectRange(editor, 5, 8);
    const [block] = blocks();
    await dragTo(drawn(block), at(block, 5), drawn(block), at(block, 13));
    // pressed before the last motion and let go after the release; the
    // motion goes a little further on, past the end of the line, so that
    // there is one
    const letGo = holdControl();
    const end = at(block, 13);
    await act(async () => {
      fireEvent.mouseMove(drawn(block), { ...end, dx: end.dx + 2 });
    });
    await landed();
    await release(drawn(block), { ...end, dx: end.dx + 2 });
    letGo();
    await act();
    assert.strictEqual(editor.state.doc.textContent, 'one two threetwo');
    assert.strictEqual(selected(editor), 'two', 'the copy is selected');
  },
);

test(
  'a drop from another element is read the way a paste is, where it lands',
  { skip: !FONTS },
  async () => {
    const editor = await mount(
      { defaultValue: 'one two' },
      h(Source, { data: { 'text/plain': 'dropped ' } }),
    );
    const [block] = blocks();
    await dragTo(source(), {}, drawn(block), at(block, 4));
    await release(drawn(block), at(block, 4));
    assert.strictEqual(editor.state.doc.textContent, 'one dropped two');
  },
);

test(
  'dropped files: an image goes in as an image, anything else as its name, linked',
  { skip: !FONTS },
  async () => {
    const editor = await mount(
      { defaultValue: 'see' },
      h(Source, {
        data: {
          'text/uri-list': 'file:///tmp/cat.png\r\nfile:///tmp/notes%20v2.pdf',
        },
      }),
    );
    const [block] = blocks();
    await dragTo(source(), {}, drawn(block), at(block, 3));
    await release(drawn(block), at(block, 3));
    const value = editor.getValue();
    assert.match(value, /!\[cat\.png\]\(file:\/\/\/tmp\/cat\.png\)/);
    assert.match(value, /\[notes v2\.pdf\]\(file:\/\/\/tmp\/notes%20v2\.pdf\)/);
  },
);

test(
  'handleDrop comes first, handed what was dropped',
  { skip: !FONTS },
  async () => {
    const heard: string[] = [];
    const editor = await mount(
      {
        defaultValue: 'one',
        editorProps: {
          handleDrop(_view, event) {
            const transfer = (
              event as unknown as {
                dataTransfer: { getData(type: string): string };
              }
            ).dataTransfer;
            heard.push(transfer.getData('text/plain'));
            return true;
          },
        },
      },
      h(Source, { data: { 'text/plain': 'hello' } }),
    );
    const [block] = blocks();
    await dragTo(source(), {}, drawn(block), at(block, 3));
    await release(drawn(block), at(block, 3));
    assert.deepStrictEqual(heard, ['hello']);
    assert.strictEqual(editor.state.doc.textContent, 'one', 'and it kept it');
  },
);

test(
  'the drop caret follows the drag, and leaves with it',
  { skip: !FONTS },
  async () => {
    await mount(
      { defaultValue: 'one two' },
      h(Source, { data: { 'text/plain': 'x' } }),
    );
    const [block] = blocks();
    await dragTo(source(), {}, drawn(block), at(block, 4));
    assert.strictEqual(blocks()[0].dropCaret, 4);
    await act(async () => {
      fireEvent.mouseMove(drawn(block), at(block, 1));
    });
    await landed();
    assert.strictEqual(blocks()[0].dropCaret, 1);
    await act(async () => {
      fireEvent.mouseMove(source(), {});
    });
    await landed();
    assert.strictEqual(blocks()[0].dropCaret, null, 'off the editor, gone');
    await release(source());
  },
);

test('a read-only editor takes no drop', { skip: !FONTS }, async () => {
  const editor = await mount(
    { defaultValue: 'fixed', readOnly: true },
    h(Source, { data: { 'text/plain': 'x' } }),
  );
  const [block] = blocks();
  await dragTo(source(), {}, drawn(block), at(block, 2));
  await release(drawn(block), at(block, 2));
  assert.strictEqual(editor.state.doc.textContent, 'fixed');
});

test(
  'a drag from one editor to another moves the selection across',
  { skip: !FONTS },
  async () => {
    const a = React.createRef<RichTextEditorHandle>();
    const b = React.createRef<RichTextEditorHandle>();
    await renderX11(
      h(
        'box',
        { style: { flexDirection: 'column', gap: 12, padding: 8 } },
        h(RichTextEditor, { key: 'a', ref: a, defaultValue: 'alpha beta' }),
        h(RichTextEditor, { key: 'b', ref: b, defaultValue: 'gamma' }),
      ),
      WITH_FONTS,
    );
    assert.ok(a.current && b.current);
    await selectRange(a.current, 7, 11);
    assert.strictEqual(selected(a.current), 'beta');
    const [first, second] = blocks();
    await dragTo(drawn(first), at(first, 8), drawn(second), at(second, 5));
    await release(drawn(second), at(second, 5));
    assert.strictEqual(b.current.state.doc.textContent, 'gammabeta');
    assert.strictEqual(
      a.current.state.doc.textContent,
      'alpha ',
      'a move: the source let it go',
    );
  },
);
