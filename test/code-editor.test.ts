// The editor element itself, driven through react-x11's harness: a real
// in-process X server, real key events, real focus. What is under test is
// the model and the wiring — value flow (controlled and not), editing
// commands, undo, selection — and the completion popup's lifecycle.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import type { ReactElement } from 'react';

import {
  act,
  fireEvent,
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
import type { RenderX11Options } from 'react-x11/test';
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
  Language,
  Position,
  Selection,
  Token,
  Tokenizer,
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

/** A language that hands back the tokenizer the editor is actually using, so
 * a test can ask it what it thinks each line looks like. */
function spyLanguage(base: Language): {
  language: Language;
  lineTokens(line: number): readonly Token[];
} {
  let tok: Tokenizer | null = null;
  return {
    language: {
      ...base,
      createTokenizer: (host) => (tok = base.createTokenizer(host)),
    },
    lineTokens: (line) => tok?.lineTokens(line) ?? [],
  };
}

test('Enter: the highlighting follows the text across the split', async () => {
  // Regression: an edit replaced the editor's line array instead of mutating
  // it, so the tokenizer — which holds that array by reference — kept
  // tokenizing the *pre-edit* text at the new line numbers. Splitting a line
  // painted the moved code with its neighbour's colours and left the token
  // runs of the old line behind on the new empty one.
  const spy = spyLanguage(sql());
  await renderX11(
    h(CodeEditor, { defaultValue: 'select 1\nfrom t', language: spy.language }),
  );
  const node = editorNode();
  await userEvent.click(node as unknown as DrawnNode);
  await userEvent.key(XK_DOWN);
  await userEvent.key(XK_HOME);
  await userEvent.key(XK_RETURN);
  assert.equal(node.value, 'select 1\n\nfrom t');

  assert.deepEqual(
    [...spy.lineTokens(1)],
    [],
    'the new empty line keeps none of the runs that were on it',
  );
  assert.deepEqual(
    [...spy.lineTokens(2)],
    [{ from: 0, to: 4, type: 'keyword' }],
    '`from` is still a keyword on the line it moved to',
  );
});

test('typing: the highlighting is current, not one keystroke behind', async () => {
  // The same stale-array bug on the same-line path: what was painted was the
  // text as of the previous edit.
  const spy = spyLanguage(sql());
  await renderX11(h(CodeEditor, { defaultValue: '', language: spy.language }));
  const node = editorNode();
  await userEvent.type(node as unknown as DrawnNode, 'where');
  assert.deepEqual(
    [...spy.lineTokens(0)],
    [{ from: 0, to: 5, type: 'keyword' }],
    'the keyword lights up on the character that completes it',
  );
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

// --- the display scale -------------------------------------------------------
//
// react-x11 hands a registered element two units (its docs/scale.md): `abs`,
// `this.style`, the paint context and the layouts `app.fonts` shapes are
// device pixels, while a synthetic event's `x`/`y`, a style length and a
// `<popup anchor>`'s rect are logical ones. At 1x — every other test in this
// file — the two coincide, which is how an editor that handed `ev.x` to a hit
// test measured in glyph metrics passed all of it, and then put the caret at
// half the pointer's distance on a retina panel. These run at 2x, and check
// every number against the one honest reference a 2x render has — `abs`, and
// a `<text>` core shaped in the same face — never against another answer of
// the editor's, which could be wrong by the same factor twice over.

/** A 400×300 logical window on a 2x panel: 800×600 device pixels, and
 *  every `abs` in those. */
const AT_2X: RenderX11Options = {
  scale: 2,
  width: 400,
  height: 300,
  screen: { width: 1000, height: 800 },
};

/** Ten columns of the editor's face, as a `<text>` beside it: the honest
 *  ruler for what a column is on the panel. */
const RULER = '0123456789';

/** The editor beside the ruler, left-aligned so the editor keeps the width
 *  it measured rather than the window's. */
function editorWithRuler(
  props: Parameters<typeof CodeEditor>[0],
): ReactElement {
  return h(
    'box',
    { style: { flexDirection: 'column', alignItems: 'flex-start' } },
    h(CodeEditor, props),
    h('text', { style: { fontFamily: 'monospace', fontSize: 13 } }, RULER),
  );
}

/** A logical window point as the offset `fireEvent` and `userEvent` take:
 *  device pixels from the centre of the editor's device `abs`. */
function offsetTo(
  node: CodeEditorNode,
  x: number,
  y: number,
  scale: number,
): { dx: number; dy: number } {
  const { abs } = node as unknown as DrawnNode;
  return {
    dx: x * scale - (abs.x + abs.width / 2),
    dy: y * scale - (abs.y + abs.height / 2),
  };
}

/** The harness's window on the screen — what the editor's device `abs` is
 *  measured from, and the unit a popup window's position is in. */
function rootWindow(): { x: number; y: number } {
  const [root] = screen.all(
    (n: DrawnNode) => n.kind === 'window',
  ) as unknown as Array<{ window: { x: number; y: number } | null }>;
  assert.ok(root?.window, 'the root window has reached the server');
  return { x: root.window.x, y: root.window.y };
}

function near(
  actual: number,
  expected: number,
  what: string,
  tolerance = 1,
): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual}, expected about ${expected}`,
  );
}

test('at a display scale of 2 a press and a drag land on the characters under the pointer', async () => {
  // Twenty columns a line in a monospace face, behind a 12-logical-pixel
  // inset (padding 10, border 2). The targets are chosen from the 1x
  // editor's own metrics — a quarter of a column and half a line inside a
  // cell, clear of every boundary — and kept as logical window points. At 2x
  // the same points are twice as many device pixels from the window's origin
  // and must land on the same characters; on the previous node they landed
  // at half the distance, which is line 0 and a column or two in.
  const value = Array.from({ length: 6 }, () => '0123456789abcdefghij').join(
    '\n',
  );
  const props = {
    defaultValue: value,
    style: { padding: 10, borderWidth: 2 },
  };
  await renderX11(editorWithRuler(props), { width: 400, height: 300 });
  const origin = (editorNode() as unknown as DrawnNode).abs; // 1x: logical
  const { lineHeight, charWidth } = editorNode().metrics();
  const point = (column: number, line: number): { x: number; y: number } => ({
    x: origin.x + 12 + charWidth * (column + 0.25),
    y: origin.y + 12 + lineHeight * (line + 0.5),
  });
  const press = point(8, 2);
  const from = point(3, 1);
  const to = point(12, 3);

  const gestures = async (
    scale: number,
  ): Promise<{ pressed: Position; dragged: Selection }> => {
    const node = editorNode();
    const drawn = node as unknown as DrawnNode;
    await userEvent.click(drawn, offsetTo(node, press.x, press.y, scale));
    const pressed = { ...node.selection.head };
    await act(() => {
      fireEvent.mouseDown(drawn, offsetTo(node, from.x, from.y, scale));
      fireEvent.mouseMove(drawn, offsetTo(node, to.x, to.y, scale));
      fireEvent.mouseUp(drawn, offsetTo(node, to.x, to.y, scale));
    });
    return { pressed, dragged: node.selection };
  };

  const at1x = await gestures(1);
  assert.deepStrictEqual(
    at1x,
    {
      pressed: { line: 2, ch: 8 },
      dragged: { anchor: { line: 1, ch: 3 }, head: { line: 3, ch: 12 } },
    },
    'the targets, read at 1x',
  );

  await cleanup();
  await renderX11(editorWithRuler(props), AT_2X);
  const { abs } = editorNode() as unknown as DrawnNode;
  assert.deepStrictEqual(
    { x: abs.x, y: abs.y },
    { x: origin.x * 2, y: origin.y * 2 },
    'the editor sits at the same logical origin, so its device `abs` is at twice it',
  );
  assert.deepStrictEqual(
    await gestures(2),
    at1x,
    'the same logical points land on the same characters',
  );
});

test('at a display scale of 2 the handle answers in logical pixels', async () => {
  const value = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  await renderX11(
    editorWithRuler({
      defaultValue: value,
      rows: 4,
      style: { padding: 10, borderWidth: 2 },
    }),
    AT_2X,
  );
  const node = editorNode();
  const { abs } = node as unknown as DrawnNode;
  // `abs` is device: the 12-logical inset is 24 a side, and the four rows
  // are what is left. This and the ruler are what every answer is held to.
  const lineHeight = (abs.height - 48) / 2 / 4;
  const ruler = (screen.getByText(RULER) as unknown as DrawnNode).abs.width / 2;
  assert.strictEqual(
    abs.width,
    768,
    'the preferred 360 logical width plus the inset, in device pixels',
  );

  const m = node.metrics();
  near(m.lineHeight, lineHeight, 'metrics().lineHeight');
  near(m.charWidth * RULER.length, ruler, 'ten of metrics().charWidth');
  assert.strictEqual(m.size, 13, 'metrics().size is the size the app wrote');
  near(node.measureText(RULER), ruler, 'measureText() of the ruler');

  node.moveCaret({ line: 2, ch: 0 }, false);
  const caret = node.caretRect();
  near(caret.x, 12, 'caretRect().x, at the inset');
  near(caret.y, 12 + 2 * lineHeight, 'caretRect().y, two lines down');
  near(caret.height, lineHeight, 'caretRect().height');

  assert.ok(node.scrollBy(0, 3), 'twenty lines in four rows scroll');
  near(
    node.caretRect().y,
    12 + 2 * lineHeight - 3,
    'scrollBy(0, 3) moved the caret rect by three logical pixels',
  );
});

test('at a display scale of 2 the completion popup opens at the caret', async () => {
  await renderX11(
    editorWithRuler({
      defaultValue: '',
      language: sql(),
      completionSources: [keywordCompletionSource()],
      rows: 8,
    }),
    AT_2X,
  );
  const node = editorNode();
  await userEvent.type(node as unknown as DrawnNode, 'sel');
  await waitFor(() => screen.getByText('select'));
  const first = await waitFor(completionPopup);

  // The editor's device position on the panel is the root window's plus its
  // `abs`; the caret is three columns past the default 9-logical inset
  // (padding 8, border 1), and the ruler says what a column is on the panel.
  // A `caretRect()` handed over in device pixels put the list a caret's
  // distance to the right of the caret.
  const win = rootWindow();
  const { abs } = node as unknown as DrawnNode;
  const column =
    (screen.getByText(RULER) as unknown as DrawnNode).abs.width / RULER.length;
  near(
    first.x,
    win.x + abs.x + 18 + 3 * column,
    'the list opens at the caret, on the panel',
    2,
  );
  const lineHeight = (abs.height - 36) / 8; // device: eight rows inside the inset
  const lineBottom = win.y + abs.y + 18 + lineHeight;
  assert.ok(
    first.y >= lineBottom - 1 && first.y <= lineBottom + 6,
    `the list opens just under the first line, which ends at ${lineBottom}: ${first.y}`,
  );

  // three lines down, and the list is three device line heights down with it
  await userEvent.key(XK_ESCAPE);
  await waitFor(() => {
    assert.equal(screen.queryByText('select', { selector: 'text' }), null);
  });
  for (let i = 0; i < 3; i++) await userEvent.key(XK_RETURN);
  await userEvent.type(node as unknown as DrawnNode, 'sel', {
    skipClick: true,
  });
  await waitFor(() => screen.getByText('select'));
  const moved = await waitFor(completionPopup);
  near(moved.y - first.y, 3 * lineHeight, 'the list dropped three lines', 2);
});
