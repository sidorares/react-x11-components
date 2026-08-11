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
import { screenRect } from 'react-x11';
import type { DrawnNode } from 'react-x11';

import {
  CODE_EDITOR_ELEMENT,
  CodeEditor,
  keywordCompletionSource,
  sql,
} from '../src/index.js';
import type {
  CodeEditorEvent,
  CodeEditorNode,
  CompletionSource,
} from '../src/index.js';

const h = React.createElement;

afterEach(() => cleanup());

/** The retained editor node, straight off the queries. */
function editorNode(): CodeEditorNode {
  const node = screen.all((n: DrawnNode) => n.kind === 'codeeditor')[0];
  assert.ok(node, 'a <codeeditor> node is mounted');
  return node as unknown as CodeEditorNode;
}

/**
 * The completion popup's geometry: the one `<window>` in the tree that is not
 * the harness's own root. A `<popup>` is its own X window, so where it *is*
 * comes off the window (screen coordinates) and how big it is off the node's
 * layout — which is the size it measured itself to. Throws until it has an X
 * window, so it is meant to be called through `waitFor`.
 */
function completionPopup(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const windows = screen.all((n: DrawnNode) => n.kind === 'window');
  const popup = windows[1] as unknown as
    | { abs: DrawnNode['abs']; window: { x: number; y: number } | null }
    | undefined;
  assert.ok(popup, 'the completion popup is a window of its own');
  assert.ok(popup.window, 'the popup has reached the server');
  return {
    x: popup.window.x,
    y: popup.window.y,
    width: popup.abs.width,
    height: popup.abs.height,
  };
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
  const [first] = screen.all((n: DrawnNode) => n.kind === 'codeeditor');
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
    (n: DrawnNode) => n.kind === 'codeeditor',
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
    (n: DrawnNode) => n.kind === 'codeeditor',
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

// --- where the completion popup lands --------------------------------------
//
// The component computes no geometry at all now: it hands the popup the caret
// in the editor's own coordinates and react-x11#280 does the rest. Both halves
// were inexpressible before — the caret is not the editor, and a list as wide
// as its labels has no size at the moment a rect would have had to be passed
// in — so what is under test is that the seam is actually carrying them.

test('completion: the popup opens at the caret, and follows it down a line', async () => {
  await renderX11(
    h(CodeEditor, {
      defaultValue: '',
      language: sql(),
      completionSources: [keywordCompletionSource()],
      rows: 8,
    }),
  );
  const node = editorNode();
  await userEvent.type(node as unknown as DrawnNode, 'sel');
  await waitFor(() => screen.getByText('select'));

  const editor = screenRect(node as unknown as DrawnNode);
  assert.ok(editor, 'the editor is laid out');
  const caret = node.caretRect();
  const first = await waitFor(completionPopup);
  assert.deepEqual(
    [first.x, first.y],
    [
      Math.round(editor.x + caret.x),
      Math.round(editor.y + caret.y + caret.height + 2),
    ],
    'at the caret with the default two-pixel gap, not under the editor',
  );
  assert.ok(
    first.y < editor.y + editor.height,
    'the caret is on the first line, so the list opens well inside the editor',
  );
  // the height is the rows it is showing, which is the popup measuring its
  // own content: nothing here ever computed one
  const rowHeight = Math.ceil(node.metrics().lineHeight) + 6;
  const rows = first.height - 2; // the 1px border, top and bottom
  assert.equal(rows % rowHeight, 0, `${rows} is whole rows of ${rowHeight}`);
  assert.ok(rows > 0 && rows <= rowHeight * 8, 'at most the visible window');

  // three lines down, and the list is three lines down with it — the whole
  // point of anchoring to a rect inside the node rather than to the node
  await userEvent.key(XK_ESCAPE);
  await waitFor(() => {
    assert.equal(screen.queryByText('select', { selector: 'text' }), null);
  });
  for (let i = 0; i < 3; i++) await userEvent.key(XK_RETURN);
  assert.equal(node.selection.head.line, 3, 'three lines further down');
  await userEvent.type(node as unknown as DrawnNode, 'sel', {
    skipClick: true,
  });
  await waitFor(() => screen.getByText('select'));
  const moved = await waitFor(completionPopup);
  const dropped = moved.y - first.y;
  const lines = node.metrics().lineHeight * 3;
  assert.ok(
    Math.abs(dropped - lines) <= 1,
    `the list dropped ${dropped}px for three lines of ${lines}px`,
  );
});

test('completion: the list is as wide as its labels, floored and capped', async () => {
  const only =
    (label: string): CompletionSource =>
    () => ({
      items: [{ label }],
    });
  const widthOf = async (label: string): Promise<number> => {
    await renderX11(
      h(CodeEditor, {
        defaultValue: '',
        completionSources: [only(label)],
        rows: 8,
      }),
    );
    const node = editorNode();
    await userEvent.type(node as unknown as DrawnNode, 'a');
    await waitFor(() => screen.getByText(label));
    const { width } = await waitFor(completionPopup);
    cleanup();
    return width;
  };

  // 180 and 480 are the component's own bounds; between them the width is
  // the label's, which used to be a loop over `node.measureText`. Every
  // label starts with the `a` that is typed, or the ranking drops it.
  assert.equal(await widthOf('acos'), 180, 'a short label sits on the floor');
  const middling = await widthOf('a_column_name_long_enough_to_pass_the_floor');
  assert.ok(
    middling > 180 && middling < 480,
    `a longer one is measured, not guessed (got ${middling})`,
  );
  assert.equal(
    await widthOf('a_column_name'.repeat(8)),
    480,
    'and one nothing could show in full stops at the cap',
  );
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

test('size: rows decides the height, and changing it re-measures', async () => {
  // The editor sizes itself through `measureContent` (react-x11#265). Its
  // width answer is capped by what is offered and its height is `rows` text
  // lines, so an editor in an unstyled parent still arrives at a usable box.
  const { rerender } = await renderX11(
    h(CodeEditor, { defaultValue: 'x', rows: 2 }),
  );
  const short = editorNode().abs.height;
  await rerender(h(CodeEditor, { defaultValue: 'x', rows: 8 }));
  const tall = editorNode().abs.height;
  assert.ok(short > 0, `rows=2 measured a real height (got ${short})`);
  assert.ok(
    tall > short * 2,
    `rows=8 (${tall}) is far taller than rows=2 (${short})`,
  );
});

// --- the bare element ------------------------------------------------------
//
// The point of moving onto react-x11#266's default-action seam: a
// `<codeeditor>` written directly in JSX behaves, with no <CodeEditor>
// wrapper installing handlers for it.

test('bare element: edits and indents with Tab, with no wrapper', async () => {
  await renderX11(h(CODE_EDITOR_ELEMENT, { defaultValue: '' }));
  const node = editorNode();
  await userEvent.type(node as unknown as DrawnNode, 'ab');
  assert.equal(node.value, 'ab', 'the element edits itself');
  await userEvent.key(XK_TAB);
  assert.equal(node.value, 'ab  ', 'Tab indents rather than moving focus');
});

test('bare element: Escape arms one Tab out, the next indents again', async () => {
  await renderX11(h(CODE_EDITOR_ELEMENT, { defaultValue: 'a' }));
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_END);

  await userEvent.key(XK_ESCAPE);
  await userEvent.key(XK_TAB);
  assert.equal(node.value, 'a', 'the armed Tab left the editor alone');

  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_END);
  await userEvent.key(XK_TAB);
  assert.equal(node.value, 'a   ', 'the one after that indents again');
});

test('an app handler vetoes the default action', async () => {
  const seen: string[] = [];
  await renderX11(
    h(CODE_EDITOR_ELEMENT, {
      defaultValue: '',
      onKeyDown: (ev: { key?: string; preventDefault(): void }) => {
        seen.push(ev.key ?? '');
        ev.preventDefault();
      },
    }),
  );
  const node = editorNode();
  await userEvent.type(node as unknown as DrawnNode, 'zz');
  assert.ok(seen.length > 0, 'the handler ran, so the keys did arrive');
  assert.equal(node.value, '', 'preventDefault stopped the editing');
});

test('bare element: a press places the caret and takes focus', async () => {
  await renderX11(h(CODE_EDITOR_ELEMENT, { defaultValue: 'abc\ndef' }));
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  assert.ok(node.focused, 'the press focused the element');
  // wherever the pointer landed, the caret is a real position in the text
  // and Home/End move from it — the press ran the editor's own behaviour
  await userEvent.key(XK_END);
  const { line } = node.selection.head;
  assert.equal(
    node.selection.head.ch,
    node.lines[line].length,
    'End went to the end of the clicked line',
  );
});
