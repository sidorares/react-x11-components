// <Code> — the static code block. Highlighting itself is the language
// seam's and is tested in code-editor-language.test.ts; the selection
// itself is core's since react-x11#291 and is tested there. What is tested
// here is the composition: runs reach the element coloured, the element
// answers for its own text, the gutter stays out of the selection, and copy
// pastes clean code.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import { renderX11, cleanup, screen, fireEvent, act } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { Code, RichTextNode } from '../src/index.js';
import type { TextRun } from '../src/index.js';
import { codeBlocks } from '../src/internal/codelines.js';

const h = React.createElement;

afterEach(cleanup);

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

const SOURCE = 'const x = 1;\nreturn x + 2;';

function drawn(node: RichTextNode): DrawnNode {
  return node as unknown as DrawnNode;
}

/** The harness `app` is ntk's; its clipboard is real but untyped. */
function clipboardOf(r: { app: unknown }): {
  read(o: { selection: string }): Promise<string | null>;
} {
  return (
    r.app as {
      clipboard: { read(o: { selection: string }): Promise<string | null> };
    }
  ).clipboard;
}

function richNodes(): RichTextNode[] {
  return screen
    .all((n) => n instanceof RichTextNode)
    .map((n) => n as unknown as RichTextNode);
}

/** The `selectable` root — the surface every public selection method is on. */
function surface(): DrawnNode {
  return screen.getByTestName('code');
}

/** What this element has lit, as text. */
function litIn(node: RichTextNode): string {
  const range = node.selectionRange;
  if (!range) return '';
  return [...node.textContent()].slice(range.start, range.end).join('');
}

/**
 * Drag the pointer and let the motion land. ntk coalesces `mousemove` onto
 * its own frame clock, which `act()` does not run — the same wait core's
 * selection tests take.
 */
async function dragTo(node: DrawnNode, options: object): Promise<void> {
  fireEvent.mouseMove(node, options);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act();
}

test('it mounts on the mock backend and the code is one block of text', async () => {
  await renderX11(
    h(Code, { source: SOURCE, lang: 'js', 'data-testname': 'code' }),
    {
      backend: 'mock',
    },
  );
  const nodes = richNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].textContent(), SOURCE);
});

test('the tokenizer coloured the runs', async () => {
  await renderX11(h(Code, { source: SOURCE, lang: 'js' }), { backend: 'mock' });
  const [code] = richNodes();
  const runs = (code.props as { runs: Array<{ text: string; color?: string }> })
    .runs;
  const colors = new Set(runs.map((r) => r.color));
  assert.ok(
    colors.size > 1,
    `expected several token colours, got ${[...colors].join(', ')}`,
  );
  assert.equal(
    runs.map((r) => r.text).join(''),
    SOURCE,
    'runs concatenate to the source',
  );
});

test(
  'line numbers render in a gutter that selection ignores',
  {
    skip: !FONTS,
  },
  async () => {
    const r = await renderX11(
      h(Code, {
        source: SOURCE,
        lang: 'js',
        lineNumbers: true,
        'data-testname': 'code',
      }),
      { fonts: FONTS!, width: 420, height: 200 },
    );
    const nodes = richNodes();
    assert.equal(nodes.length, 2, 'code plus gutter');
    const code = nodes.find((n) => n.textContent().startsWith('const'));
    const gutter = nodes.find((n) => n.textContent().startsWith('1'));
    assert.ok(code && gutter);

    fireEvent.mouseDown(drawn(code), { dx: -code.abs.width / 2 + 1, dy: -4 });
    await dragTo(drawn(code), { dx: code.abs.width / 2 - 1, dy: 8 });
    fireEvent.mouseUp(drawn(code), { dx: code.abs.width / 2 - 1, dy: 8 });
    await act();

    assert.equal(litIn(code), SOURCE, 'the drag selected the whole block');
    assert.equal(litIn(gutter), '', 'the gutter took no selection');
    assert.equal(
      surface().selectedText(),
      SOURCE,
      'and it is absent from what the surface would copy',
    );

    const primary = await clipboardOf(r).read({ selection: 'PRIMARY' });
    assert.equal(primary, SOURCE, 'PRIMARY pastes code, not line numbers');
  },
);

test('Ctrl+A / Ctrl+C copy only the code', { skip: !FONTS }, async () => {
  const r = await renderX11(
    h(Code, {
      source: SOURCE,
      lang: 'js',
      lineNumbers: true,
      'data-testname': 'code',
    }),
    { fonts: FONTS!, width: 420, height: 200 },
  );
  const code = richNodes().find((n) => n.textContent().startsWith('const'));
  assert.ok(code);
  await act(async () => {
    fireEvent.mouseDown(drawn(code), {});
    fireEvent.mouseUp(drawn(code), {});
  });
  await act(async () => {
    fireEvent.key(0x61, { modifiers: ['Control'] });
  });
  await act(async () => {
    fireEvent.key(0x63, { modifiers: ['Control'] });
  });
  const copied = await clipboardOf(r).read({ selection: 'CLIPBOARD' });
  assert.equal(copied, SOURCE);
});

test(
  'selectable={false} leaves the block inert',
  { skip: !FONTS },
  async () => {
    await renderX11(
      h(Code, {
        source: SOURCE,
        lang: 'js',
        selectable: false,
        'data-testname': 'code',
      }),
      { fonts: FONTS!, width: 420, height: 200 },
    );
    const [code] = richNodes();
    fireEvent.mouseDown(drawn(code), { dx: -code.abs.width / 2 + 1, dy: -4 });
    await dragTo(drawn(code), { dx: code.abs.width / 2 - 1, dy: 8 });
    fireEvent.mouseUp(drawn(code), { dx: code.abs.width / 2 - 1, dy: 8 });
    await act();
    assert.equal(litIn(code), '', 'nothing was lit');
    assert.equal(surface().selectedText(), '', 'and nothing would be copied');
  },
);

test(
  'a tab goes to its stop, every eight spaces',
  { skip: !FONTS },
  async () => {
    // Neither engine sets a tab: ntk draws a box for it and CoreText stops
    // every 28 points, so a Go file indented with tabs came out boxed or
    // ragged. A stop is every eight spaces from the line's start, and one
    // less than half a "0" on is passed over (CSS Text 3, 4.2).
    const source = '\tA\n\t\tB\nab\tC\nabcdefghij\tD\nabcdefg\tE';
    await renderX11(h(Code, { source, 'data-testname': 'code' }), {
      fonts: FONTS!,
      width: 600,
      height: 240,
    });
    const code = richNodes().find((n) =>
      n.textContent().includes('abcdefghij'),
    );
    assert.ok(code);
    const node = drawn(code) as DrawnNode & {
      textCaretRect(index: number): { x: number } | null;
    };
    const text = code.textContent();
    assert.ok(text.includes('\t\tB'), 'the text keeps its tabs');
    const x = (letter: string, line: string) =>
      node.textCaretRect([...text.slice(0, text.indexOf(letter))].length)!.x -
      node.textCaretRect([...text.slice(0, text.indexOf(line))].length)!.x;
    // a "0" across, in the monospace face every character here is
    const ch = x('D', 'abcdefghij') / 16;
    const near = (a: number, b: number, what: string) =>
      assert.ok(Math.abs(a - b) < 0.5, `${what}: ${a} against ${b}`);
    near(x('A', '\tA'), 8 * ch, 'one tab');
    near(x('B', '\t\tB'), 16 * ch, 'two tabs');
    near(x('C', 'ab\tC'), 8 * ch, 'a tab after two letters');
    // seven letters leave a space to the stop, more than half a "0", so the
    // tab takes it rather than the next
    near(x('E', 'abcdefg\tE'), 8 * ch, 'a tab after seven letters');
  },
);

/** A line of code longer than any viewport these tests give it. */
const LONG_LINE =
  'const answer = someFunctionWithAVeryLongName(argumentNumberOne, ' +
  'argumentNumberTwo, argumentNumberThree);';

/** The one box that scrolls — the code's viewport. */
function viewportBox(): {
  scrollTo(to: { x: number; y: number }): void;
  scrollX: number;
} {
  const [box] = screen.all(
    (n) =>
      (n as unknown as { kind: string }).kind === 'box' &&
      (n as unknown as { style?: { overflow?: string } }).style?.overflow ===
        'scroll',
  );
  assert.ok(box, 'a viewport');
  return box as unknown as {
    scrollTo(to: { x: number; y: number }): void;
    scrollX: number;
  };
}

test('an unwrapped line wider than the viewport is scrolled to, not cut off', async () => {
  // The code stretched to its viewport, as a column stretches what it holds,
  // so its box held none of a line past the viewport's edge: the viewport
  // had nothing to scroll, and the end of every long line was out of reach.
  await renderX11(
    h(
      'box',
      { style: { width: 240 } },
      h(Code, { source: LONG_LINE, lang: 'js' }),
    ),
    { backend: 'xserver', width: 400, height: 120 },
  );
  await act();
  const viewport = viewportBox();
  await act(() => viewport.scrollTo({ x: 200, y: 0 }));
  assert.strictEqual(viewport.scrollX, 200);
});

/** `count` lines of a script, numbered. */
function script(count: number): string {
  return Array.from({ length: count }, (_, i) => `let v${i} = ${i};`).join(
    '\n',
  );
}

function runsOf(node: RichTextNode): TextRun[] {
  return (node.props as unknown as { runs: TextRun[] }).runs;
}

test('codeBlocks cuts runs into blocks of whole lines that stack back into the text', () => {
  const runs: TextRun[] = [
    { text: 'a\nb', color: '#1' },
    { text: '\nc\nd\n', color: '#2' },
    { text: 'e', color: '#3' },
  ];
  const blocks = codeBlocks(runs, 2);
  const texts = blocks.map((block) => block.map((r) => r.text).join(''));
  assert.deepStrictEqual(texts, ['a\nb', 'c\nd', 'e'], 'two lines a block');
  assert.equal(texts.join('\n'), 'a\nb\nc\nd\ne', 'and stacked, the text');
  assert.equal(blocks[1]![0]!.color, '#2', 'a run cut in two keeps its style');
  // a newline that ends the text stays in its block, which draws the empty
  // last line it always drew rather than a block of nothing after it
  const ending = codeBlocks([{ text: 'a\nb\n' }], 2);
  assert.deepStrictEqual(
    ending.map((block) => block.map((r) => r.text).join('')),
    ['a\nb\n'],
  );
});

test('a long source is drawn in blocks, and an edit to its end rebuilds only the last', async () => {
  // One `<richtext>` for the whole source was laid out, and repainted, whole
  // for every line a stream appended: 0.4 s at 5,000 lines.
  const source = script(600);
  const r = await renderX11(
    h(Code, { source, lang: 'js', lineNumbers: true }),
    {
      backend: 'mock',
    },
  );
  const blocks = () => richNodes().filter((n) => !/^\d/.test(n.textContent()));
  const gutter = () => richNodes().filter((n) => /^\d/.test(n.textContent()));
  const before = blocks().map(runsOf);
  assert.equal(before.length, 3, 'three blocks of 256 lines');
  assert.equal(
    blocks()
      .map((n) => n.textContent())
      .join('\n'),
    source,
    'the blocks stacked are the source',
  );
  assert.deepStrictEqual(
    gutter().map((n) => n.textContent().split('\n').filter(Boolean).length),
    [256, 256, 88],
    'a block of numbers beside each block of code',
  );
  await act(() =>
    r.rerender(
      h(Code, {
        source: `${source}\nlet tail = 1;`,
        lang: 'js',
        lineNumbers: true,
      }),
    ),
  );
  const after = blocks().map(runsOf);
  assert.strictEqual(after[0], before[0], 'the first block was not rebuilt');
  assert.strictEqual(after[1], before[1], 'nor the second');
  assert.notStrictEqual(after[2], before[2], 'the last took the line');
});

test(
  'Ctrl+A / Ctrl+C copy a source of several blocks as one text',
  { skip: !FONTS },
  async () => {
    const source = script(600);
    const r = await renderX11(
      h(Code, {
        source,
        lang: 'js',
        lineNumbers: true,
        'data-testname': 'code',
      }),
      { fonts: FONTS!, width: 520, height: 200 },
    );
    const first = richNodes().find((n) => n.textContent().startsWith('let'));
    assert.ok(first);
    // near the top: a block is taller than the window, and its centre is
    // off it
    const top = { dx: 0, dy: -first.abs.height / 2 + 5 };
    await act(async () => {
      fireEvent.mouseDown(drawn(first), top);
      fireEvent.mouseUp(drawn(first), top);
    });
    await act(async () => {
      fireEvent.key(0x61, { modifiers: ['Control'] });
    });
    await act(async () => {
      fireEvent.key(0x63, { modifiers: ['Control'] });
    });
    assert.equal(
      await clipboardOf(r).read({ selection: 'CLIPBOARD' }),
      source,
      'one newline between lines across a block boundary, and no numbers',
    );
  },
);
