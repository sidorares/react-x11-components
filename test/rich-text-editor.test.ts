// <RichTextEditor>, driven through react-x11's harness: a real in-process X
// server, real key events, real focus and a real clipboard — and, where a
// test measures glyphs, real font files. The model underneath (block keys,
// the inline map, the markdown and HTML codecs, the clipboard's slices) is
// tested with no display in rich-text-editor-model.test.ts; what is under
// test here is the wiring: what a key does, where a press lands, what the app
// hears, and which of ProseMirror's seams a plugin can reach.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React, { useState } from 'react';
import type { ReactElement } from 'react';

import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  screen,
  userEvent,
  waitFor,
  XK_BACKSPACE,
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_HOME,
  XK_LEFT,
  XK_RETURN,
  XK_RIGHT,
  XK_TAB,
  XK_UP,
} from 'react-x11/test';
import type { RenderX11Options, RenderX11Result } from 'react-x11/test';
import { editMenuOpen, screenRect } from 'react-x11';
import type { DrawnNode } from 'react-x11';
import type { A11yTextState } from 'react-x11/node';
import { undo } from 'prosemirror-history';
import { EditorState, Plugin, Selection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import {
  RichTextEditor,
  defaultPlugins,
  docFromMarkdown,
  schema,
  suggestions,
} from '../src/rich-text-editor/index.js';
import type {
  DomKeyEvent,
  NodeViewProps,
  RichTextEditorHandle,
  RichTextEditorProps,
} from '../src/rich-text-editor/index.js';
import type { EditorTextNode } from '../src/rich-text-editor/nodes.js';

const h = React.createElement;

afterEach(() => cleanup());

// Real font files, so metrics are machine-stable — the pair markdown.test.ts
// uses. A box with neither skips the tests that measure glyphs rather than
// failing them.
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

// --- helpers -----------------------------------------------------------------------

/** The harness's `app` is ntk's; its clipboard is real but untyped. */
interface NtkClipboard {
  read(options: {
    selection: string;
    target?: string;
  }): Promise<string | Uint8Array | null>;
  write(
    data: string | Record<string, string>,
    options?: { selection?: string },
  ): Promise<void>;
}

function clipboardOf(r: RenderX11Result): NtkClipboard {
  return (r.app as unknown as { clipboard: NtkClipboard }).clipboard;
}

function asText(value: string | Uint8Array | null): string | null {
  return value === null || typeof value === 'string'
    ? value
    : Buffer.from(value).toString('utf8');
}

/** The editor's root element, as core and an assistive technology see it. */
type EditorRoot = DrawnNode & {
  readonly focused: boolean;
  readonly children: readonly unknown[];
  a11yTextState(): A11yTextState | null;
  a11ySetSelection(start: number, end: number): boolean;
  a11yReplaceText(start: number, end: number, text: string): boolean;
  defaultComposition(ev: { type: string; data?: string }): void;
};

function root(n = 0): EditorRoot {
  const node = screen.all((x) => x.kind === 'richeditor')[n];
  assert.ok(node, `editor ${n} is mounted`);
  return node as EditorRoot;
}

/** Every textblock's element, in document order. */
function blocks(): EditorTextNode[] {
  return screen.all(
    (x) => x.kind === 'richeditortext',
  ) as unknown as EditorTextNode[];
}

/** What each textblock draws. */
function drawnText(): string[] {
  return blocks().map((b) => b.textContent());
}

function runsOf(
  block: EditorTextNode,
): Array<{ text: string } & Record<string, unknown>> {
  return (
    block.props as { runs: Array<{ text: string } & Record<string, unknown>> }
  ).runs;
}

function drawn(node: unknown): DrawnNode {
  return node as DrawnNode;
}

function selectedText(editor: RichTextEditorHandle): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, '\n');
}

async function mount(
  props: RichTextEditorProps,
  options: RenderX11Options = {},
): Promise<{ r: RenderX11Result; editor: RichTextEditorHandle }> {
  const ref = React.createRef<RichTextEditorHandle>();
  const r = await renderX11(h(RichTextEditor, { ...props, ref }), {
    ...WITH_FONTS,
    ...options,
  });
  assert.ok(ref.current, 'the handle is set');
  return { r, editor: ref.current };
}

/** Focus the editor and put the caret at the end of the document. */
async function focusAtEnd(): Promise<void> {
  await userEvent.click(drawn(blocks()[0]));
  await userEvent.key(XK_END, { modifiers: ['Control'] });
}

/** Type into whatever has focus. */
async function type(text: string): Promise<void> {
  await userEvent.type(drawn(blocks()[0]), text, { skipClick: true });
}

/** A Ctrl chord — the primary modifier on the X11 backend. */
function ctrl(keysym: number, ...more: Array<'Shift' | 'Alt'>): Promise<void> {
  return userEvent.key(keysym, { modifiers: ['Control', ...more] });
}

const KEY_A = 0x61;
const KEY_B = 0x62;
const KEY_C = 0x63;
const KEY_K = 0x6b;
const KEY_V = 0x76;
const KEY_Y = 0x79;
const KEY_Z = 0x7a;

/**
 * A pointer offset that lands a quarter of the way into drawn code point
 * `index` — nearer its left edge however narrow the glyph (an `l` in Arial
 * is three pixels) — measured off the element's own layout, in the device
 * pixels a `fireEvent` offset is in.
 */
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

async function press(
  block: EditorTextNode,
  index: number,
  modifiers?: 'Shift'[],
): Promise<void> {
  const point = { ...at(block, index), ...(modifiers ? { modifiers } : null) };
  fireEvent.mouseDown(drawn(block), point);
  fireEvent.mouseUp(drawn(block), point);
  await act();
}

/** Motion while pressed. Core paces motion to frames, so it is given one. */
async function dragTo(
  node: DrawnNode,
  offset: { dx: number; dy: number },
): Promise<void> {
  fireEvent.mouseMove(node, offset);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act();
}

// --- rendering -----------------------------------------------------------------------

test('markdown in: a text element per textblock, lists and quotes drawn around them', async () => {
  const source = '# Title\n\nSome **bold** text\n\n- one\n- two\n\n> quoted';
  const { editor } = await mount({ defaultValue: source });
  assert.deepStrictEqual(drawnText(), [
    'Title',
    'Some bold text',
    'one',
    'two',
    'quoted',
  ]);
  const runs = runsOf(blocks()[1]);
  assert.deepStrictEqual(
    runs.map((r) => r.text),
    ['Some ', 'bold', ' text'],
    'the mark is a run of its own, and only it',
  );
  assert.notStrictEqual(runs[1].weight, runs[0].weight);
  assert.strictEqual(
    editor.getValue(),
    source,
    'and the same markdown comes back out',
  );
});

// --- typing --------------------------------------------------------------------------

test('typing edits the document, and onChange reports markdown once per change', async () => {
  const values: string[] = [];
  const { editor } = await mount({
    defaultValue: 'Hello',
    onChange: (ev) => values.push(ev.value),
  });
  await focusAtEnd();
  await type(' world');
  assert.strictEqual(editor.getValue(), 'Hello world');
  assert.strictEqual(values.length, 6, 'one change per key');
  assert.strictEqual(values[values.length - 1], 'Hello world');
});

test('Enter splits a paragraph and Backspace joins it again; the block above keeps its element', async () => {
  const { editor } = await mount({ defaultValue: 'first\n\nsecond' });
  const [first] = blocks();
  await userEvent.click(drawn(blocks()[1]));
  await userEvent.key(XK_END);
  for (let i = 0; i < 3; i++) await userEvent.key(XK_LEFT);
  await userEvent.key(XK_RETURN);
  assert.deepStrictEqual(drawnText(), ['first', 'sec', 'ond']);
  assert.strictEqual(blocks()[0], first, 'an edit below did not re-create it');
  await userEvent.key(XK_BACKSPACE);
  assert.deepStrictEqual(drawnText(), ['first', 'second']);
  assert.strictEqual(
    editor.state.selection.head,
    11,
    'the caret is where the join is',
  );
  assert.strictEqual(blocks()[0], first);
});

test('Ctrl+B belongs to the keymap plugin: it bolds the selection, and unbolds it', async () => {
  const { editor } = await mount({ defaultValue: 'make this bold' });
  await focusAtEnd();
  await userEvent.key(XK_LEFT, { modifiers: ['Shift', 'Control'] });
  assert.strictEqual(selectedText(editor), 'bold');
  await ctrl(KEY_B);
  assert.strictEqual(editor.getValue(), 'make this **bold**');
  assert.ok(editor.isActive('strong'));
  await ctrl(KEY_B);
  assert.strictEqual(editor.getValue(), 'make this bold');
});

test('markdown shortcuts turn into structure as they are typed', async () => {
  const { editor } = await mount({});
  await focusAtEnd();
  await type('# Title');
  await userEvent.key(XK_RETURN);
  await type('- item **strong**');
  await userEvent.key(XK_RETURN);
  await type('[ ] task');
  assert.strictEqual(
    editor.getValue(),
    '# Title\n\n- item **strong**\n- [ ] task',
  );
});

test('undo takes a typing run back in one step; redo, and Ctrl+Y, replay it', async () => {
  const { editor } = await mount({ defaultValue: 'base' });
  await focusAtEnd();
  await type(' word');
  assert.strictEqual(editor.getValue(), 'base word');
  await ctrl(KEY_Z);
  assert.strictEqual(editor.getValue(), 'base');
  await ctrl(KEY_Z, 'Shift');
  assert.strictEqual(editor.getValue(), 'base word');
  await ctrl(KEY_Z);
  await ctrl(KEY_Y);
  assert.strictEqual(editor.getValue(), 'base word');
});

// --- lists ---------------------------------------------------------------------------

test('lists: Enter makes an item, Tab nests it, Shift+Tab takes it out, Enter on an empty item ends the list', async () => {
  const { editor } = await mount({ defaultValue: '- one' });
  await focusAtEnd();
  await userEvent.key(XK_RETURN);
  await type('two');
  assert.strictEqual(editor.getValue(), '- one\n- two');
  await userEvent.key(XK_TAB);
  assert.strictEqual(editor.getValue(), '- one\n  - two');
  await userEvent.key(XK_TAB, { modifiers: ['Shift'] });
  assert.strictEqual(editor.getValue(), '- one\n- two');
  await userEvent.key(XK_RETURN);
  await userEvent.key(XK_RETURN);
  await type('after');
  assert.strictEqual(editor.getValue(), '- one\n- two\n\nafter');
});

test('a task box toggles its item, and the press leaves the caret where it was', async () => {
  const { editor } = await mount({ defaultValue: '- [ ] todo\n- [x] done' });
  await focusAtEnd();
  const caret = editor.state.selection.head;
  const boxes = screen.getAllByRole('checkbox');
  assert.strictEqual(boxes.length, 2);
  await userEvent.click(boxes[0]);
  assert.strictEqual(editor.getValue(), '- [x] todo\n- [x] done');
  await userEvent.click(screen.getAllByRole('checkbox')[1]);
  assert.strictEqual(editor.getValue(), '- [x] todo\n- [ ] done');
  assert.strictEqual(editor.state.selection.head, caret);
});

// --- motion --------------------------------------------------------------------------

test('arrow keys and Backspace step over a whole grapheme', async () => {
  const { editor } = await mount({ defaultValue: 'a👍🏽b' });
  const head = (): number => editor.state.selection.head;
  await userEvent.click(drawn(blocks()[0]));
  await userEvent.key(XK_HOME);
  assert.strictEqual(head(), 1);
  await userEvent.key(XK_RIGHT);
  assert.strictEqual(head(), 2);
  await userEvent.key(XK_RIGHT);
  assert.strictEqual(head(), 6, 'the thumb and its skin tone are one step');
  await userEvent.key(XK_LEFT, { modifiers: ['Shift'] });
  assert.strictEqual(selectedText(editor), '👍🏽');
  await userEvent.key(XK_RIGHT);
  assert.strictEqual(head(), 6, 'an arrow collapses a selection to its side');
  await userEvent.key(XK_BACKSPACE);
  assert.strictEqual(editor.getValue(), 'ab');
});

test('Down and Up keep the column from line to line; Ctrl+Home and Ctrl+End go to the ends', async () => {
  const { editor } = await mount({
    defaultValue: 'abcdef\n\nabcdef\n\nabcdef',
  });
  const head = (): number => editor.state.selection.head;
  await userEvent.click(drawn(blocks()[0]));
  await userEvent.key(XK_HOME);
  for (let i = 0; i < 3; i++) await userEvent.key(XK_RIGHT);
  assert.strictEqual(head(), 4);
  await userEvent.key(XK_DOWN);
  assert.strictEqual(head(), 12);
  await userEvent.key(XK_DOWN);
  assert.strictEqual(head(), 20);
  await userEvent.key(XK_UP);
  assert.strictEqual(head(), 12);
  await userEvent.key(XK_HOME, { modifiers: ['Control'] });
  assert.strictEqual(head(), 1);
  await userEvent.key(XK_END, { modifiers: ['Control'] });
  assert.strictEqual(head(), 23);
});

test(
  'End stops where a wrapped line does, not where the paragraph does',
  { skip: !FONTS },
  async () => {
    const words =
      'the quick brown fox jumps over the lazy dog and keeps on running far away';
    const { editor } = await mount({
      defaultValue: words,
      style: { width: 220 },
    });
    const [block] = blocks();
    const top = block.textCaretRect(0)!.y;
    assert.ok(
      block.textCaretRect(words.length)!.y > top,
      'the paragraph wraps',
    );
    await userEvent.click(drawn(block));
    await userEvent.key(XK_HOME, { modifiers: ['Control'] });
    await userEvent.key(XK_END);
    const end = editor.state.selection.head;
    assert.ok(
      end > 1 && end < 1 + words.length,
      `End went to ${end}, inside the paragraph`,
    );
    assert.strictEqual(
      block.textCaretRect(end - 1)!.y,
      top,
      'and it is on the first line',
    );
    await userEvent.key(XK_HOME);
    assert.strictEqual(editor.state.selection.head, 1);
  },
);

// --- the pointer ---------------------------------------------------------------------

test(
  'a press puts the caret before the character under it; Shift+press extends',
  { skip: !FONTS },
  async () => {
    const { editor } = await mount({ defaultValue: 'alpha beta gamma' });
    const [block] = blocks();
    await press(block, 6);
    assert.strictEqual(editor.state.selection.head, 7);
    assert.ok(root().focused, 'and the press focused the editor');
    await press(block, 10, ['Shift']);
    assert.strictEqual(selectedText(editor), 'beta');
  },
);

test(
  'a double click selects a word, a triple click the whole block',
  { skip: !FONTS },
  async () => {
    const { editor } = await mount({ defaultValue: 'alpha beta gamma' });
    const [block] = blocks();
    await userEvent.doubleClick(drawn(block), at(block, 8));
    assert.strictEqual(selectedText(editor), 'beta');
    await act(() => fireEvent.click(drawn(block), at(block, 8)));
    assert.strictEqual(selectedText(editor), 'alpha beta gamma');
  },
);

test(
  'a drag selects from the press to the pointer, across blocks, and offers it as PRIMARY',
  { skip: !FONTS },
  async () => {
    const { r, editor } = await mount({
      defaultValue: 'first line\n\nsecond line',
    });
    const [one, two] = blocks();
    fireEvent.mouseDown(drawn(one), at(one, 6));
    await dragTo(drawn(two), at(two, 6));
    fireEvent.mouseUp(drawn(two), at(two, 6));
    await act();
    assert.strictEqual(selectedText(editor), 'line\nsecond');
    await waitFor(async () =>
      assert.strictEqual(
        asText(await clipboardOf(r).read({ selection: 'PRIMARY' })),
        'line\n\nsecond',
      ),
    );
  },
);

test('a right click opens the edit menu', async () => {
  await mount({ defaultValue: 'menu' });
  await act(() => fireEvent.contextMenu(drawn(blocks()[0])));
  assert.ok(editMenuOpen(root()));
});

// --- the clipboard -------------------------------------------------------------------

test('Ctrl+C offers HTML and text; Ctrl+V puts it back with its marks', async () => {
  const { r, editor } = await mount({ defaultValue: 'copy **me** here' });
  await userEvent.click(drawn(blocks()[0]));
  await userEvent.key(XK_HOME);
  for (let i = 0; i < 5; i++) await userEvent.key(XK_RIGHT);
  await userEvent.key(XK_RIGHT, { modifiers: ['Shift', 'Control'] });
  assert.strictEqual(selectedText(editor), 'me');
  await ctrl(KEY_C);
  const clipboard = clipboardOf(r);
  await waitFor(async () =>
    assert.strictEqual(
      asText(await clipboard.read({ selection: 'CLIPBOARD' })),
      'me',
    ),
  );
  const html =
    asText(
      await clipboard.read({ selection: 'CLIPBOARD', target: 'text/html' }),
    ) ?? '';
  assert.match(html, /<strong>me<\/strong>/);
  assert.match(
    html,
    /data-pm-slice/,
    'and says where it was cut, for a paste back',
  );
  await userEvent.key(XK_END);
  await type(' ');
  await ctrl(KEY_V);
  await waitFor(() =>
    assert.strictEqual(editor.getValue(), 'copy **me** here **me**'),
  );
});

test('a paste from another application is read by the schema; Ctrl+Shift+V pastes it plain', async () => {
  const { r, editor } = await mount({});
  await clipboardOf(r).write({
    'text/html':
      '<h2>From the web</h2><p>with <b>bold</b> and <a href="https://x.y">a link</a></p>',
    UTF8_STRING: 'From the web\nwith bold and a link',
  });
  await focusAtEnd();
  await ctrl(KEY_V);
  await waitFor(() =>
    assert.strictEqual(
      editor.getValue(),
      '## From the web\n\nwith **bold** and [a link](https://x.y)',
    ),
  );
  await act(() => editor.setValue(''));
  await ctrl(KEY_V, 'Shift');
  await waitFor(() =>
    assert.strictEqual(
      editor.getValue(),
      'From the web\n\nwith bold and a link',
    ),
  );
});

// --- the value -----------------------------------------------------------------------

test('controlled: handing back what onChange said changes nothing; another value resets', async () => {
  let value = 'one';
  const ref = React.createRef<RichTextEditorHandle>();
  const element = (v: string): ReactElement =>
    h(RichTextEditor, {
      ref,
      value: v,
      onChange: (ev) => {
        value = ev.value;
      },
    });
  const r = await renderX11(element(value), WITH_FONTS);
  await focusAtEnd();
  await type('!');
  assert.strictEqual(value, 'one!');
  await r.rerender(element(value));
  assert.strictEqual(
    ref.current?.state.selection.head,
    5,
    'the caret stayed where typing left it',
  );
  assert.ok(ref.current?.can(undo), 'and so did the history');
  await r.rerender(element('two'));
  assert.strictEqual(ref.current?.getValue(), 'two');
  assert.deepStrictEqual(drawnText(), ['two']);
});

test('readOnly: keys that would edit do nothing; selecting and copying still work', async () => {
  const { r, editor } = await mount({
    defaultValue: 'look, no hands',
    readOnly: true,
  });
  await focusAtEnd();
  await type('x');
  await userEvent.key(XK_BACKSPACE);
  await userEvent.key(XK_RETURN);
  assert.strictEqual(editor.getValue(), 'look, no hands');
  await ctrl(KEY_A);
  await ctrl(KEY_C);
  await waitFor(async () =>
    assert.strictEqual(
      asText(await clipboardOf(r).read({ selection: 'CLIPBOARD' })),
      'look, no hands',
    ),
  );
  assert.strictEqual(root().a11yTextState()?.editable, false);
});

test('disabled: a press neither focuses nor edits', async () => {
  const { editor } = await mount({ defaultValue: 'inert', disabled: true });
  await userEvent.click(drawn(blocks()[0]));
  await type('x');
  assert.strictEqual(editor.getValue(), 'inert');
  assert.strictEqual(root().focused, false);
});

test('an empty document shows its placeholder, with the caret before it; typing replaces it', async () => {
  const { editor } = await mount({ placeholder: 'Write something…' });
  assert.deepStrictEqual(drawnText(), ['Write something…']);
  assert.strictEqual(editor.getValue(), '');
  await userEvent.click(drawn(blocks()[0]));
  assert.strictEqual(editor.state.selection.head, 1);
  await type('hi');
  assert.deepStrictEqual(drawnText(), ['hi']);
  assert.strictEqual(
    root().a11yTextState()?.value,
    'hi',
    'the placeholder was never text',
  );
});

// --- submitting ----------------------------------------------------------------------

test('submitOnEnter: Enter submits, Shift+Enter breaks the line, and in a list Enter still makes items', async () => {
  const submitted: string[] = [];
  const { editor } = await mount({
    submitOnEnter: true,
    onSubmit: (ev) => submitted.push(ev.value),
  });
  await focusAtEnd();
  await type('hello');
  await userEvent.key(XK_RETURN, { modifiers: ['Shift'] });
  await type('there');
  await userEvent.key(XK_RETURN);
  assert.strictEqual(submitted.length, 1);
  assert.match(submitted[0], /^hello(\\| {2})\nthere$/);
  assert.strictEqual(
    editor.state.doc.childCount,
    1,
    'Enter did not split the paragraph',
  );
  await act(() => editor.setValue('- item'));
  await userEvent.key(XK_END, { modifiers: ['Control'] });
  await userEvent.key(XK_RETURN);
  assert.strictEqual(submitted.length, 1, 'Enter in a list is an edit');
  assert.strictEqual(editor.state.doc.firstChild?.childCount, 2);
});

test('onSubmit alone: Enter is a new paragraph and Ctrl+Enter submits', async () => {
  const submitted: string[] = [];
  const { editor } = await mount({
    defaultValue: 'draft',
    onSubmit: (ev) => submitted.push(ev.value),
  });
  await focusAtEnd();
  await userEvent.key(XK_RETURN);
  assert.strictEqual(editor.state.doc.childCount, 2);
  await ctrl(XK_RETURN);
  assert.strictEqual(submitted.length, 1);
  assert.ok(submitted[0].startsWith('draft'));
  assert.strictEqual(
    editor.state.doc.childCount,
    2,
    'the chord was not also a line break',
  );
});

// --- focus ---------------------------------------------------------------------------

test('Tab is the editor’s inside a list; Escape, then Tab, leaves it', async () => {
  const first = React.createRef<RichTextEditorHandle>();
  const second = React.createRef<RichTextEditorHandle>();
  await renderX11(
    h(
      'box',
      { style: { flexDirection: 'column', gap: 8 } },
      h(RichTextEditor, { key: 'a', ref: first, defaultValue: '- one\n- two' }),
      h(RichTextEditor, { key: 'b', ref: second, defaultValue: 'second' }),
    ),
    WITH_FONTS,
  );
  await userEvent.click(drawn(blocks()[1]));
  await userEvent.key(XK_TAB);
  assert.strictEqual(first.current?.getValue(), '- one\n  - two');
  assert.ok(root(0).focused, 'Tab nested the item and kept focus');
  await userEvent.key(XK_ESCAPE);
  await userEvent.tab();
  assert.ok(root(1).focused, 'Escape armed a Tab that leaves');
  await type('x');
  assert.strictEqual(second.current?.getValue(), 'xsecond');
});

test('Ctrl+K asks for a link target and links the selection', async () => {
  const { editor } = await mount({ defaultValue: 'see the docs' });
  await focusAtEnd();
  await userEvent.key(XK_LEFT, { modifiers: ['Shift', 'Control'] });
  await ctrl(KEY_K);
  const input = await screen.findByPlaceholder('https://');
  await userEvent.type(input, 'https://example.com', { skipClick: true });
  await userEvent.key(XK_RETURN);
  await waitFor(() =>
    assert.strictEqual(
      editor.getValue(),
      'see the [docs](https://example.com)',
    ),
  );
  assert.ok(!screen.queryByPlaceholder('https://'), 'the popup closed');
  assert.ok(root().focused, 'and focus came back to the editor');
});

test('the caret is kept in view: Ctrl+End scrolls a tall document to its end', async () => {
  const source = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join(
    '\n\n',
  );
  await mount({ defaultValue: source, style: { height: 160 } });
  const scroller = root().children[0] as unknown as { scrollY: number };
  assert.strictEqual(scroller.scrollY, 0);
  await userEvent.click(drawn(blocks()[0]));
  await userEvent.key(XK_END, { modifiers: ['Control'] });
  await waitFor(() =>
    assert.ok(scroller.scrollY > 0, `scrollY is ${scroller.scrollY}`),
  );
});

// --- composition ---------------------------------------------------------------------

test('a composition draws its preedit at the caret, inside the word, and commits as typing', async () => {
  const { editor } = await mount({ defaultValue: 'ab' });
  await userEvent.click(drawn(blocks()[0]));
  await userEvent.key(XK_HOME);
  await userEvent.key(XK_RIGHT);
  const node = root();
  await act(() =>
    node.defaultComposition({ type: 'compositionUpdate', data: 'か' }),
  );
  assert.deepStrictEqual(drawnText(), ['aかb']);
  assert.ok(
    runsOf(blocks()[0]).find((run) => run.text === 'か')?.underline,
    'the preedit is underlined, a run of its own',
  );
  assert.strictEqual(editor.getValue(), 'ab', 'and it is not in the document');
  await act(() =>
    node.defaultComposition({ type: 'compositionEnd', data: '火' }),
  );
  assert.strictEqual(editor.getValue(), 'a火b');
  assert.deepStrictEqual(drawnText(), ['a火b']);
});

// --- the seams -----------------------------------------------------------------------

test('a plugin comes first: its handleKeyDown beats the keymap, and its decorations are drawn', async () => {
  let claimed = 0;
  const plugins = [
    new Plugin({
      props: {
        handleKeyDown(_view, event) {
          const key = event as unknown as DomKeyEvent;
          if (key.key !== 'b' || !(key.ctrlKey || key.metaKey)) return false;
          claimed += 1;
          return true;
        },
        decorations(state) {
          return DecorationSet.create(state.doc, [
            Decoration.inline(1, 6, { class: 'hot' }),
            Decoration.widget(
              8,
              () => {
                throw new Error(
                  'a widget with spec.text is drawn by the editor',
                );
              },
              { text: '@', side: -1 },
            ),
          ]);
        },
      },
    }),
  ];
  const { editor } = await mount({
    defaultValue: 'hello world',
    plugins,
    decorationClasses: { hot: { bg: '#ff0000' } },
  });
  assert.deepStrictEqual(
    drawnText(),
    ['hello w@orld'],
    'the widget is drawn inside the word',
  );
  const [hot] = runsOf(blocks()[0]);
  assert.deepStrictEqual(
    [hot.text, hot.bg],
    ['hello', '#ff0000'],
    'the class became a look',
  );
  assert.strictEqual(
    editor.getValue(),
    'hello world',
    'and neither is in the document',
  );
  await focusAtEnd();
  await ctrl(KEY_B);
  assert.strictEqual(claimed, 1);
  assert.strictEqual(
    editor.getValue(),
    'hello world',
    'the keymap never saw the chord',
  );
});

test('editorProps are ProseMirror view props, without a plugin to hold them', async () => {
  const { editor } = await mount({
    editorProps: {
      handleTextInput(view, from, to, text) {
        view.dispatch(view.state.tr.insertText(text.toUpperCase(), from, to));
        return true;
      },
    },
  });
  await focusAtEnd();
  await type('shout');
  assert.strictEqual(editor.getValue(), 'SHOUT');
});

test('a node view draws a node type as a component, and updateAttributes edits the node', async () => {
  function Fence({
    node,
    children,
    updateAttributes,
  }: NodeViewProps): ReactElement {
    return h(
      'box',
      { style: { flexDirection: 'column' } },
      h(
        'box',
        {
          onMouseDown: (ev: {
            preventDefault(): void;
            stopPropagation(): void;
          }) => {
            ev.preventDefault();
            ev.stopPropagation();
            updateAttributes({ params: 'py' });
          },
        },
        h('text', null, `language: ${String(node.attrs.params || 'none')}`),
      ),
      children,
    );
  }
  const nodeViews = { code_block: Fence };
  const { editor } = await mount({
    defaultValue: '```js\nlet x\n```',
    nodeViews,
  });
  assert.deepStrictEqual(
    drawnText(),
    ['let x'],
    'the text inside is still the editor’s',
  );
  await userEvent.click(screen.getByText('language: js'));
  assert.strictEqual(editor.getValue(), '```py\nlet x\n```');
  assert.ok(screen.queryByText('language: py'));
});

test('the toolbar runs its command on the selection and leaves focus in the editor', async () => {
  const { editor } = await mount({
    defaultValue: 'make this bold',
    toolbar: true,
  });
  const button = (
    label: string,
  ): DrawnNode & { props: Record<string, unknown> } => {
    const [node] = screen.all(
      (n) =>
        (n as unknown as { props?: Record<string, unknown> }).props?.[
          'aria-label'
        ] === label,
    );
    assert.ok(node, `a ${label} button`);
    return node as DrawnNode & { props: Record<string, unknown> };
  };
  await focusAtEnd();
  await userEvent.key(XK_LEFT, { modifiers: ['Shift', 'Control'] });
  await userEvent.click(button('Bold'));
  assert.strictEqual(editor.getValue(), 'make this **bold**');
  assert.ok(root().focused, 'the editor kept focus');
  assert.strictEqual(selectedText(editor), 'bold', 'and its selection');
  assert.strictEqual(button('Bold').props['aria-pressed'], true);
  await userEvent.click(button('Undo'));
  assert.strictEqual(editor.getValue(), 'make this bold');
});

test('the top rung: an app that owns the EditorState gets every transaction', async () => {
  const seen: { state: EditorState | null } = { state: null };
  function Owner(): ReactElement {
    const [state, setState] = useState(() =>
      EditorState.create({
        doc: docFromMarkdown(schema, 'owned'),
        plugins: defaultPlugins(schema),
      }),
    );
    seen.state = state;
    return h(RichTextEditor, {
      state,
      dispatchTransaction: (tr: Transaction) => setState((s) => s.apply(tr)),
    });
  }
  await renderX11(h(Owner), WITH_FONTS);
  await focusAtEnd();
  await type('!');
  assert.strictEqual(seen.state?.doc.textContent, 'owned!');
  assert.deepStrictEqual(drawnText(), ['owned!']);
  await ctrl(KEY_Z);
  assert.strictEqual(
    seen.state?.doc.textContent,
    'owned',
    'undo is the app’s own history plugin',
  );
});

test('format="html": HTML in and HTML out', async () => {
  const values: string[] = [];
  const { editor } = await mount({
    format: 'html',
    defaultValue: '<p>Hello <strong>there</strong></p>',
    onChange: (ev) => values.push(ev.value),
  });
  assert.deepStrictEqual(drawnText(), ['Hello there']);
  await focusAtEnd();
  await type('!');
  assert.strictEqual(
    values[values.length - 1],
    '<p>Hello <strong>there!</strong></p>',
  );
  assert.strictEqual(editor.getValue('markdown'), 'Hello **there!**');
});

test('the handle: setValue is a reset, insertContent goes in at the caret, isActive reads the selection', async () => {
  const { editor } = await mount({ defaultValue: 'one' });
  await act(() => editor.setValue('# two'));
  assert.deepStrictEqual(drawnText(), ['two']);
  assert.ok(editor.isActive('heading', { level: 1 }));
  assert.ok(!editor.can(undo), 'a reset is not undoable');
  await act(() => {
    editor.run((state, dispatch) => {
      dispatch?.(state.tr.setSelection(Selection.atEnd(state.doc)));
      return true;
    });
  });
  await act(() => editor.insertContent(' three', 'text'));
  assert.strictEqual(editor.getValue(), '# two three');
});

// --- suggestions ---------------------------------------------------------------------

const PEOPLE = [
  { label: 'Ada Lovelace', detail: '@ada', insert: '@ada' },
  { label: 'Grace Hopper', detail: '@grace', insert: '@grace' },
  { label: 'Alan Turing', detail: '@alan', insert: '@alan' },
];
const MENTIONS = [{ char: '@', items: PEOPLE }];

/**
 * The suggestion list's geometry: the one `<window>` that is not the
 * harness's root — a `<popup>` is an X window of its own. Throws until it
 * has reached the server, so it is called through `waitFor`.
 */
function listWindow(): { x: number; y: number; width: number; height: number } {
  const windows = screen.all((n) => n.kind === 'window');
  const popup = windows[1] as unknown as
    | { abs: DrawnNode['abs']; window: { x: number; y: number } | null }
    | undefined;
  assert.ok(popup, 'the list is a window of its own');
  assert.ok(popup.window, 'and it has reached the server');
  return {
    x: popup.window.x,
    y: popup.window.y,
    width: popup.abs.width,
    height: popup.abs.height,
  };
}

test('@ opens a list as it is typed; Down moves the highlight and Enter takes the row', async () => {
  const { editor } = await mount({ defaultValue: 'hi', suggestions: MENTIONS });
  await focusAtEnd();
  await type(' @');
  await waitFor(() => screen.getByText('Grace Hopper'));
  assert.ok(screen.queryByText('@grace'), 'a row’s detail is drawn beside it');
  const runs = runsOf(blocks()[0]);
  const trigger = runs.find((run) => run.text === '@');
  const plain = runs.find((run) => run.text.startsWith('hi'));
  assert.ok(
    trigger && plain && trigger.color !== plain.color,
    'the trigger being typed is drawn in the accent colour',
  );
  await userEvent.key(XK_DOWN);
  await userEvent.key(XK_RETURN);
  assert.strictEqual(editor.state.doc.textContent, 'hi @grace ');
  assert.strictEqual(editor.state.doc.childCount, 1, 'Enter made no new line');
  await waitFor(() =>
    assert.ok(!screen.queryByText('Grace Hopper'), 'the list is gone'),
  );
});

test('with submitOnEnter, Enter takes a row rather than sending; the next Enter sends', async () => {
  const sent: string[] = [];
  const { editor } = await mount({
    submitOnEnter: true,
    onSubmit: (ev) => sent.push(ev.value),
    suggestions: MENTIONS,
  });
  await focusAtEnd();
  await type('ping @ad');
  await waitFor(() => screen.getByText('Ada Lovelace'));
  await userEvent.key(XK_RETURN);
  assert.deepStrictEqual(sent, [], 'the row, not the message');
  assert.strictEqual(editor.state.doc.textContent, 'ping @ada ');
  await userEvent.key(XK_RETURN);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^ping @ada\s*$/);
});

test('Escape closes the list, and is not the Escape that lets Tab leave', async () => {
  const { editor } = await mount({
    defaultValue: '- one\n- two',
    suggestions: MENTIONS,
  });
  await focusAtEnd();
  await type(' @');
  await waitFor(() => screen.getByText('Ada Lovelace'));
  await userEvent.key(XK_ESCAPE);
  await waitFor(() =>
    assert.ok(!screen.queryByText('Ada Lovelace'), 'the list closed'),
  );
  await userEvent.key(XK_TAB);
  assert.strictEqual(
    editor.getValue(),
    '- one\n  - two @',
    'the list spent that Escape: Tab still nests the item',
  );
  assert.ok(root().focused);
});

test('a press on a row takes it, and the caret stays in the editor', async () => {
  const { editor } = await mount({ suggestions: MENTIONS });
  await focusAtEnd();
  await type('@');
  const row = await waitFor(() => screen.getByText('Alan Turing'));
  await userEvent.click(row);
  assert.strictEqual(editor.state.doc.textContent, '@alan ');
  assert.ok(root().focused, 'the editor kept focus');
  await type('x');
  assert.strictEqual(editor.state.doc.textContent, '@alan x');
});

test(
  'the list hangs below the trigger, where the word being typed starts',
  { skip: !FONTS },
  async () => {
    await mount({ defaultValue: 'some text', suggestions: MENTIONS });
    await focusAtEnd();
    await type(' @gr');
    await waitFor(() => screen.getByText('Grace Hopper'));
    const [block] = blocks();
    const trigger = block.textCaretRect(10);
    assert.ok(trigger, 'the trigger is laid out');
    const { abs } = drawn(block);
    const origin = screenRect(drawn(block));
    assert.ok(origin, 'the block is on screen');
    const list = await waitFor(listWindow);
    assert.deepStrictEqual(
      [list.x, list.y],
      [
        Math.round(origin.x + trigger.x - abs.x),
        Math.round(origin.y + trigger.y - abs.y + trigger.height + 2),
      ],
      'at the trigger with the default two-pixel gap, not at the caret',
    );
  },
);

test('an app that owns the EditorState gets the list from the plugin in its state', async () => {
  function Owner(): ReactElement {
    const [state, setState] = useState(() =>
      EditorState.create({
        doc: docFromMarkdown(schema, 'owned'),
        plugins: [suggestions(MENTIONS), ...defaultPlugins(schema)],
      }),
    );
    return h(RichTextEditor, {
      state,
      dispatchTransaction: (tr: Transaction) => setState((s) => s.apply(tr)),
    });
  }
  await renderX11(h(Owner), WITH_FONTS);
  await focusAtEnd();
  await type(' @');
  await waitFor(() => screen.getByText('Ada Lovelace'));
  await userEvent.key(XK_RETURN);
  assert.deepStrictEqual(drawnText(), ['owned @ada ']);
});

test('a suggester can draw its own rows; the highlight and the press stay the editor’s', async () => {
  const drawnRows: string[] = [];
  const { editor } = await mount({
    suggestions: [
      {
        char: '@',
        items: PEOPLE,
        renderItem: (item, row) => {
          drawnRows.push(`${item.label}:${row.selected}:${row.query}`);
          return h('text', null, `* ${item.label}`);
        },
      },
    ],
  });
  await focusAtEnd();
  await type('@gr');
  const row = await waitFor(() => screen.getByText('* Grace Hopper'));
  assert.ok(!screen.queryByText('@grace'), 'the default detail is not drawn');
  assert.ok(
    drawnRows.includes('Grace Hopper:true:gr'),
    'handed the item, whether it is highlighted, and the query',
  );
  await userEvent.click(row);
  assert.strictEqual(editor.state.doc.textContent, '@grace ');
  assert.ok(root().focused, 'a press still takes the row, focus stays');
});

// --- tables ----------------------------------------------------------------------------

/** A toolbar button by its accessible name, or undefined when it is not in
 *  the bar. */
function toolbarButton(label: string): DrawnNode | undefined {
  return screen.all(
    (n) =>
      (n as unknown as { props?: Record<string, unknown> }).props?.[
        'aria-label'
      ] === label,
  )[0];
}

/** The first table's rows and columns. */
function tableShape(editor: RichTextEditorHandle): [number, number] {
  let shape: [number, number] = [0, 0];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'table') return true;
    shape = [node.childCount, node.firstChild?.childCount ?? 0];
    return false;
  });
  return shape;
}

test('the toolbar puts in a table, and the table’s own buttons are there only with the caret in one', async () => {
  const { editor } = await mount({ defaultValue: 'notes', toolbar: true });
  await focusAtEnd();
  assert.ok(!toolbarButton('Row below'), 'no table, no row buttons');
  await userEvent.click(toolbarButton('Table')!);
  assert.deepStrictEqual(tableShape(editor), [3, 3]);
  assert.ok(editor.isActive('table_header'), 'the caret in its first cell');
  await waitFor(() => assert.ok(toolbarButton('Row below'), 'row buttons'));
  await type('Name');
  await userEvent.click(toolbarButton('Column after')!);
  await userEvent.click(toolbarButton('Row below')!);
  assert.deepStrictEqual(tableShape(editor), [4, 4]);
  assert.ok(root().focused, 'and the caret stayed in the editor');
  await userEvent.key(XK_END, { modifiers: ['Control'] });
  await waitFor(() =>
    assert.ok(!toolbarButton('Row below'), 'out of the table, they go'),
  );
  await userEvent.key(XK_UP);
  await waitFor(() => assert.ok(toolbarButton('Delete table')));
  await userEvent.click(toolbarButton('Delete table')!);
  assert.deepStrictEqual(tableShape(editor), [0, 0]);
  assert.match(editor.getValue(), /^notes/);
});

test(
  'a table’s columns are as wide as their content, line up row to row, and widen as a cell is typed in',
  { skip: !FONTS },
  async () => {
    await mount({
      defaultValue: '| Key | Does |\n| - | - |\n| Z | undo the last change |',
      style: { width: 640 },
    });
    const box = (i: number): DrawnNode['abs'] => drawn(blocks()[i]).abs;
    const [key, does, z, undoText] = [box(0), box(1), box(2), box(3)];
    assert.deepStrictEqual(
      [key.x, key.width],
      [z.x, z.width],
      'a column is one width from row to row',
    );
    assert.deepStrictEqual([does.x, does.width], [undoText.x, undoText.width]);
    assert.ok(
      does.width > key.width * 2,
      `the long column is the wide one (${does.width} vs ${key.width})`,
    );
    await press(blocks()[2], 1);
    await type(' then redo it all');
    await waitFor(() =>
      assert.ok(
        box(0).width > key.width,
        `typing in a cell widened its column (${box(0).width})`,
      ),
    );
    assert.strictEqual(box(0).width, box(2).width, 'and it still lines up');
  },
);

// --- accessibility -------------------------------------------------------------------

test('a screen reader reads one text, a line per block, and can select and edit it', async () => {
  const { r, editor } = await mount(
    { defaultValue: '# Title\n\nBody text' },
    { a11y: true },
  );
  const node = root();
  assert.strictEqual(node.a11yTextState()?.value, 'Title\nBody text');
  await act(() => node.a11ySetSelection(6, 10));
  assert.strictEqual(selectedText(editor), 'Body');
  await act(() => node.a11yReplaceText(0, 5, 'Heading'));
  assert.strictEqual(editor.getValue(), '# Heading\n\nBody text');
  assert.ok(
    r.at
      ?.events()
      .some((e) => e.type === 'text-insert' || e.type === 'text-delete'),
    'and the edit was announced',
  );
});

// --- the display scale ---------------------------------------------------------------
//
// Event coordinates are logical and a text element's accessors are device
// pixels (react-x11 docs/scale.md). At 1x the two coincide, so only a 2x
// render can catch a hit test fed the wrong one.

test(
  'at 2x, a press lands on the character under the pointer',
  { skip: !FONTS },
  async () => {
    const { editor } = await mount(
      { defaultValue: 'abcdefghij' },
      {
        scale: 2,
        width: 400,
        height: 300,
        screen: { width: 1000, height: 800 },
      },
    );
    const [block] = blocks();
    for (const index of [0, 3, 7, 10]) {
      await press(block, index);
      assert.strictEqual(
        editor.state.selection.head,
        1 + index,
        `a press before character ${index}`,
      );
    }
  },
);
