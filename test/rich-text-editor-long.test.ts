// Long documents: only the top-level blocks near the viewport are drawn,
// and what the caret and the keys need is drawn when they need it — through
// react-x11's harness, the way a reader scrolls and presses keys.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  screen,
  XK_DOWN,
  XK_END,
} from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import type { DrawnNode, ScrollableNode } from 'react-x11';

import { RichTextEditor } from '../src/rich-text-editor/index.js';
import type {
  RichTextEditorHandle,
  RichTextEditorProps,
} from '../src/rich-text-editor/index.js';
import type { EditorTextNode } from '../src/rich-text-editor/nodes.js';

const h = React.createElement;

afterEach(() => cleanup());

// a font pair of the box's own, for layout that does not ask fc-match
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
const FONTS: RenderX11Options = found
  ? { fonts: { 'sans-serif': found[0], monospace: found[1] } }
  : {};

/** `count` paragraphs: `line 0` to `line <count - 1>`. */
function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i}`).join('\n\n');
}

function blocks(): EditorTextNode[] {
  return screen.all(
    (x) => x.kind === 'richeditortext',
  ) as unknown as EditorTextNode[];
}

/** What a drawn block says. */
function says(block: EditorTextNode): string {
  const node = (
    block as unknown as { props: { node?: { textContent: string } } }
  ).props.node;
  return node?.textContent ?? '';
}

function drawnBlock(text: string): DrawnNode | undefined {
  return blocks().find((b) => says(b) === text) as unknown as
    DrawnNode | undefined;
}

/** The box the document scrolls in. */
function pane(): ScrollableNode & DrawnNode {
  const [node] = screen.all((n) => {
    const style = (n as unknown as { props?: { style?: unknown } }).props
      ?.style as { overflow?: string } | undefined;
    return !!style && !Array.isArray(style) && style.overflow === 'scroll';
  });
  assert.ok(node, 'the editor scrolls in a pane');
  return node as unknown as ScrollableNode & DrawnNode;
}

/** Whether a node is wholly inside the pane's viewport — device pixels on
 *  both sides. */
function inView(node: DrawnNode): boolean {
  const box = pane().abs;
  return (
    node.abs.y >= box.y - 1 &&
    node.abs.y + node.abs.height <= box.y + box.height + 1
  );
}

/** The drawn blocks' boxes, top to bottom. */
function drawnRects(): Array<{ y: number; height: number }> {
  return blocks()
    .map((b) => (b as unknown as DrawnNode).abs)
    .filter((r) => r.height > 0)
    .sort((a, b) => a.y - b.y);
}

/** Whether the drawn blocks cover the viewport, top to bottom. */
function covered(): boolean {
  const box = pane().abs;
  const drawn = drawnRects();
  if (drawn.length === 0) return false;
  const last = drawn[drawn.length - 1];
  return (
    drawn[0].y <= box.y + 30 && last.y + last.height >= box.y + box.height - 30
  );
}

/** How far a drawn block starts below the one before it, device pixels.
 *  Every block of `lines` is one shape, so a document of them is about this
 *  times their count tall. */
function pitch(): number {
  const drawn = drawnRects();
  assert.ok(drawn.length >= 2, 'two drawn blocks to measure between');
  return drawn[1].y - drawn[0].y;
}

/** A few frames: layout, the pass after it, and what that re-renders. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((res) => setTimeout(res, 20));
    await act();
  }
}

/** Long enough for the idle band and the measurements to catch up. */
async function idle(ms: number): Promise<void> {
  for (let waited = 0; waited < ms; waited += 40) {
    await new Promise((res) => setTimeout(res, 40));
    await act();
  }
}

async function mount(
  props: RichTextEditorProps,
  options: RenderX11Options = {},
): Promise<RichTextEditorHandle> {
  const ref = React.createRef<RichTextEditorHandle>();
  await renderX11(
    h(RichTextEditor, {
      style: { width: 400, height: 300 },
      ...props,
      ref,
    }),
    { ...FONTS, ...options },
  );
  assert.ok(ref.current, 'the handle is set');
  await settle();
  return ref.current;
}

/** The scrollbar measures the whole document: a thousand blocks of the
 *  drawn ones' pitch, give or take the estimate's rounding. */
function assertWholeDocument(count: number): void {
  const expected = count * pitch();
  const content = pane().contentHeight;
  assert.ok(
    Math.abs(content - expected) < expected * 0.06,
    `content ${content} for ${count} blocks of ${pitch()}`,
  );
}

test('a long document draws only the blocks near the viewport', async () => {
  await mount({ defaultValue: lines(1000) });
  await idle(300);
  const drawn = blocks().length;
  assert.ok(drawn > 0 && drawn < 150, `drew ${drawn} of 1000`);
  assert.ok(covered(), 'and the viewport is covered');
  assertWholeDocument(1000);
});

test('a scroll brings in the blocks it lands on', async () => {
  await mount({ defaultValue: lines(1000) });
  pane().scrollTo({ y: 12000 });
  await settle();
  await idle(300);
  assert.ok(covered(), 'blocks cover the viewport after the jump');
  assert.ok(!drawnBlock('line 0'), 'the first block has gone');
  assert.ok(blocks().length < 150, `drew ${blocks().length} of 1000`);
});

test('Ctrl+End goes to the last block, draws it and brings it into view', async () => {
  const editor = await mount({ defaultValue: lines(1000), autoFocus: true });
  await act(async () => {
    fireEvent.key(XK_END, { modifiers: ['Control'] });
  });
  await settle();
  await idle(300);
  const { $head } = editor.state.selection;
  assert.strictEqual($head.parent.textContent, 'line 999');
  const last = drawnBlock('line 999');
  assert.ok(last, 'the last block is drawn');
  assert.ok(inView(last), 'and in view');

  // typing goes in there, and the view stays with it
  await act(async () => {
    fireEvent.key(0x78 /* x */);
  });
  await settle();
  assert.strictEqual(editor.state.doc.lastChild?.textContent, 'line 999x');
  const typed = drawnBlock('line 999x');
  assert.ok(typed && inView(typed), 'the typed-in block is in view');
});

test('scrolled away from the caret, Down moves from the caret and brings it back', async () => {
  const editor = await mount({ defaultValue: lines(1000), autoFocus: true });
  assert.strictEqual(editor.state.selection.$head.parent.textContent, 'line 0');
  pane().scrollTo({ y: 15000 });
  await settle();
  await idle(300);
  assert.ok(!drawnBlock('line 0'), "the caret's block is scrolled out");
  await act(async () => {
    fireEvent.key(XK_DOWN);
  });
  await settle();
  await idle(300);
  assert.strictEqual(
    editor.state.selection.$head.parent.textContent,
    'line 1',
    'one line down from the caret, not from the viewport',
  );
  const now = drawnBlock('line 1');
  assert.ok(now && inView(now), 'and the caret is back in view');
});

test('at scale 2 the window is where the viewport is', async () => {
  // `abs` and the raw scroll offset are device pixels, the height index
  // logical: mixed, the scrollbar claims a document twice as tall and the
  // window lands off the viewport — only a scaled mount can tell
  await mount({ defaultValue: lines(1000) }, { scale: 2 });
  await idle(300);
  assert.ok(covered(), 'covered at the top');
  assertWholeDocument(1000);
  pane().scrollTo({ y: 12000 });
  await settle();
  await idle(300);
  assert.ok(covered(), 'covered after the jump');
  assert.ok(blocks().length < 150, `drew ${blocks().length} of 1000`);
});

test('a short document is drawn whole, and virtual={false} draws a long one whole', async () => {
  await mount({ defaultValue: lines(40) });
  assert.strictEqual(blocks().length, 40);
  cleanup();
  await mount({ defaultValue: lines(250), virtual: false });
  assert.strictEqual(blocks().length, 250);
});

test('virtual={true} windows even a short document', async () => {
  await mount({ defaultValue: lines(120), virtual: true });
  await idle(300);
  assert.ok(blocks().length < 120, `drew ${blocks().length} of 120`);
  assert.ok(covered(), 'and covers the viewport');
});
