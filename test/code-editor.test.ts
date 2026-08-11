// The editor element itself, driven through react-x11's harness: a real
// in-process X server, real key events, real focus. What is under test is
// the model and the wiring — value flow (controlled and not), editing
// commands, undo, selection — and the completion popup's lifecycle.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  userEvent,
  waitFor,
  XK_BACKSPACE,
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_HOME,
  XK_RETURN,
  XK_RIGHT,
  XK_TAB,
  XK_UP,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { CodeEditor, keywordCompletionSource, sql } from '../src/index.js';
import type { CodeEditorEvent, CodeEditorNode } from '../src/index.js';

const h = React.createElement;

afterEach(() => cleanup());

/** `kind` is on every retained node at runtime; `DrawnNode`'s public type
 * does not carry it, so the probe reads it structurally. */
function kindOf(n: DrawnNode): string {
  return (n as { kind?: string }).kind ?? '';
}

/** The retained editor node, straight off the queries. */
function editorNode(): CodeEditorNode {
  const node = screen.all((n: DrawnNode) => kindOf(n) === 'codeeditor')[0];
  assert.ok(node, 'a <codeeditor> node is mounted');
  return node as unknown as CodeEditorNode;
}

test('typing edits, onChange reports, value reads back', async () => {
  const values: string[] = [];
  await renderX11(
    h(CodeEditor, {
      defaultValue: '',
      language: sql(),
      onChange: (ev: CodeEditorEvent) => values.push(ev.value),
    }),
  );
  const node = editorNode();
  await userEvent.type(node as unknown as DrawnNode, 'select 1');
  assert.equal(node.value, 'select 1');
  assert.equal(values[values.length - 1], 'select 1');
});

test('Enter splits the line and copies the indentation', async () => {
  await renderX11(h(CodeEditor, { defaultValue: '  two spaces' }));
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_END);
  await userEvent.key(XK_RETURN);
  assert.equal(node.value, '  two spaces\n  ');
  assert.deepEqual(node.selection.head, { line: 1, ch: 2 });
});

test('Tab indents to the next stop; Shift+Tab dedents the line', async () => {
  await renderX11(h(CodeEditor, { defaultValue: 'ab', tabSize: 4 }));
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_END);
  await userEvent.key(XK_TAB);
  assert.equal(node.value, 'ab  ', 'two spaces reach the stop at 4');
});

test('Shift+Tab dedents by one unit', async () => {
  await renderX11(h(CodeEditor, { defaultValue: '      x', tabSize: 4 }));
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_TAB, { modifiers: ['Shift'] });
  assert.equal(node.value, '  x');
  await userEvent.key(XK_TAB, { modifiers: ['Shift'] });
  assert.equal(node.value, 'x');
});

test('Escape then Tab leaves the editor', async () => {
  await renderX11(
    h(
      'box',
      { style: { flexDirection: 'column' } },
      h(CodeEditor, { key: 'a', defaultValue: 'first' }),
      h(CodeEditor, { key: 'b', defaultValue: 'second' }),
    ),
    { wrap: true },
  );
  const [first] = screen.all((n: DrawnNode) => kindOf(n) === 'codeeditor');
  await userEvent.click(first);
  await userEvent.key(XK_HOME);
  // Tab is an edit while focused…
  await userEvent.key(XK_TAB);
  const firstNode = first as unknown as CodeEditorNode;
  assert.ok(firstNode.value.startsWith('    '), 'Tab indented');
  // …until Escape arms the way out
  await userEvent.key(XK_ESCAPE);
  await userEvent.tab();
  const second = screen.all(
    (n: DrawnNode) => kindOf(n) === 'codeeditor',
  )[1] as unknown as CodeEditorNode;
  await userEvent.type(second as unknown as DrawnNode, 'x', {
    skipClick: true,
  });
  assert.equal(second.value, 'xsecond', 'focus moved to the second editor');
});

test('undo coalesces a typing run; redo replays it', async () => {
  await renderX11(h(CodeEditor, { defaultValue: 'base ' }));
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_END);
  await userEvent.type(node as unknown as DrawnNode, 'word', {
    skipClick: true,
  });
  assert.equal(node.value, 'base word');
  await userEvent.key(0x7a /* z */, { modifiers: ['Control'] });
  assert.equal(node.value, 'base ', 'one undo takes the whole run back');
  await userEvent.key(0x7a, { modifiers: ['Control', 'Shift'] });
  assert.equal(node.value, 'base word', 'redo brings it back');
});

test('selection: shift+arrows, then typing replaces', async () => {
  await renderX11(h(CodeEditor, { defaultValue: 'abc' }));
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_HOME);
  await userEvent.key(XK_RIGHT, { modifiers: ['Shift'] });
  await userEvent.key(XK_RIGHT, { modifiers: ['Shift'] });
  assert.equal(node.selectedText(), 'ab');
  await userEvent.type(node as unknown as DrawnNode, 'X', { skipClick: true });
  assert.equal(node.value, 'Xc');
});

test('vertical moves keep a goal column across a short line', async () => {
  await renderX11(
    h(CodeEditor, { defaultValue: 'a long first line\nx\nanother long line' }),
  );
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  // caret to the end of line 0 (17 columns) — Ctrl+Home first, because the
  // click above landed wherever the pointer was
  await userEvent.key(XK_HOME, { modifiers: ['Control'] });
  await userEvent.key(XK_END);
  await userEvent.key(XK_DOWN);
  assert.deepEqual(node.selection.head, { line: 1, ch: 1 }, 'clamped to x');
  await userEvent.key(XK_DOWN);
  assert.equal(node.selection.head.line, 2);
  assert.ok(
    node.selection.head.ch > 10,
    `goal column survives the short line (got ch ${node.selection.head.ch})`,
  );
});

test('controlled: parent accepts edits; parent silence reverts them', async () => {
  function Accepting(): React.ReactElement {
    const [value, setValue] = React.useState('a');
    return h(CodeEditor, {
      value,
      onChange: (ev: CodeEditorEvent) => setValue(ev.value),
    });
  }
  const first = await renderX11(h(Accepting));
  const node = editorNode();
  await userEvent.type(node as unknown as DrawnNode, 'b');
  assert.equal(node.value, 'ab');
  await first.unmount();

  const rejected: string[] = [];
  await renderX11(
    h(CodeEditor, {
      value: 'fixed',
      onChange: (ev: CodeEditorEvent) => rejected.push(ev.value),
    }),
  );
  const locked = screen.all(
    (n: DrawnNode) => kindOf(n) === 'codeeditor',
  )[0] as unknown as CodeEditorNode;
  await userEvent.type(locked as unknown as DrawnNode, 'x');
  assert.equal(locked.value, 'fixed', 'a silent parent wins');
  assert.ok(rejected.length > 0, 'the edit was still reported');
});

test('readOnly: navigation works, editing does not', async () => {
  await renderX11(h(CodeEditor, { defaultValue: 'stay', readOnly: true }));
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_END);
  await userEvent.type(node as unknown as DrawnNode, 'nope', {
    skipClick: true,
  });
  await userEvent.key(XK_BACKSPACE);
  assert.equal(node.value, 'stay');
  assert.equal(node.selection.head.ch, 4, 'End still moved the caret');
});

test('Ctrl+/ toggles the line comment the language declares', async () => {
  await renderX11(h(CodeEditor, { defaultValue: 'select 1', language: sql() }));
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(0x2f /* / */, { modifiers: ['Control'] });
  assert.equal(node.value, '-- select 1');
  await userEvent.key(0x2f, { modifiers: ['Control'] });
  assert.equal(node.value, 'select 1');
});

test('completion: opens while typing, Enter accepts, popup closes', async () => {
  await renderX11(
    h(CodeEditor, {
      defaultValue: '',
      language: sql(),
      completionSources: [keywordCompletionSource()],
    }),
  );
  const node = editorNode();
  await userEvent.type(node as unknown as DrawnNode, 'sel');
  const option = await waitFor(() => screen.getByText('select'));
  assert.ok(option, 'the popup offers the keyword');
  await userEvent.key(XK_RETURN);
  assert.equal(node.value, 'select');
  await waitFor(() => {
    assert.equal(screen.queryByText('select', { selector: 'text' }), null);
  });
});

test('completion: arrows move the highlight, Escape dismisses', async () => {
  await renderX11(
    h(CodeEditor, {
      defaultValue: '',
      language: sql(),
      completionSources: [keywordCompletionSource()],
    }),
  );
  const node = editorNode();
  await userEvent.type(node as unknown as DrawnNode, 'se');
  await waitFor(() => screen.getByText('select'));
  const before = node.value;
  await userEvent.key(XK_DOWN);
  await userEvent.key(XK_UP);
  assert.equal(node.value, before, 'popup navigation does not move the caret');
  await userEvent.key(XK_ESCAPE);
  await waitFor(() => {
    assert.equal(screen.queryByText('select', { selector: 'text' }), null);
  });
  assert.equal(node.value, 'se');
});

test('Enter: syntax-aware indentation, and opening a bracket pair', async () => {
  const { javascript } = await import('../src/index.js');
  await renderX11(
    h(CodeEditor, {
      defaultValue: 'function f() {}',
      language: javascript(),
      tabSize: 2,
    }),
  );
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_END);
  // caret between { and }: Enter opens the pair, indented one unit
  await userEvent.key(0xff51 /* XK_LEFT */);
  await userEvent.key(XK_RETURN);
  assert.equal(node.value, 'function f() {\n  \n}');
  assert.deepEqual(node.selection.head, { line: 1, ch: 2 });
  // and a plain Enter after an opener indents without the closer dance
  await userEvent.type(node as unknown as DrawnNode, 'if (x) {', {
    skipClick: true,
  });
  await userEvent.key(XK_RETURN);
  assert.equal(node.selection.head.ch, 4, 'one level deeper than the if line');
});

test('Enter: shell indents after do', async () => {
  const { shell } = await import('../src/index.js');
  await renderX11(
    h(CodeEditor, {
      defaultValue: 'for f in x; do',
      language: shell(),
      tabSize: 2,
    }),
  );
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_END);
  await userEvent.key(XK_RETURN);
  assert.equal(node.value, 'for f in x; do\n  ');
});
