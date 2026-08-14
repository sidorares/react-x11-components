// <TerminalOutput> — the static capture renderer. The parsing itself is
// `ansi.test.ts`'s and the selection itself is core's (react-x11#291); what
// is tested here is the composition: spans reach the element coloured, the
// element answers for its own text, the gutter stays out of the copy, and a
// growing capture is parsed by its tail rather than from the top.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import { renderX11, cleanup, screen, fireEvent, act } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { TerminalOutput, RichTextNode } from '../src/index.js';
import type { AnsiDocument, TextRun } from '../src/index.js';

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

const ESC = '\u001b';
const LOG =
  `${ESC}[1;32mPASS${ESC}[0m src/a.test.ts\n` +
  `${ESC}[1;31mFAIL${ESC}[0m src/b.test.ts\n` +
  'done';
const PLAIN = 'PASS src/a.test.ts\nFAIL src/b.test.ts\ndone';

function richNodes(): RichTextNode[] {
  return screen
    .all((n) => n instanceof RichTextNode)
    .map((n) => n as unknown as RichTextNode);
}

function runsOf(node: RichTextNode): TextRun[] {
  return (node.props as unknown as { runs: TextRun[] }).runs;
}

function drawn(node: RichTextNode): DrawnNode {
  return node as unknown as DrawnNode;
}

/** The `selectable` root — the surface every public selection method is on. */
function surface(): DrawnNode {
  return screen.getByTestName('out');
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

/** Drag the pointer and let the motion land. ntk coalesces `mousemove` onto
 *  its own frame clock, which `act()` does not run. */
async function dragTo(node: DrawnNode, options: object): Promise<void> {
  fireEvent.mouseMove(node, options);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act();
}

test('it mounts on the mock backend and the capture is one block of text', async () => {
  await renderX11(h(TerminalOutput, { data: LOG, 'data-testname': 'out' }), {
    backend: 'mock',
  });
  const nodes = richNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.textContent(), PLAIN, 'the escapes are not text');
});

test('the runs carry the capture’s colours and concatenate to its text', async () => {
  await renderX11(h(TerminalOutput, { data: LOG }), { backend: 'mock' });
  const runs = runsOf(richNodes()[0]!);
  assert.equal(runs.map((r) => r.text).join(''), PLAIN);
  const colors = new Set(runs.map((r) => r.color));
  assert.ok(colors.size > 1, `expected several colours, got ${[...colors]}`);
  assert.ok(
    runs.some((r) => r.weight === 'bold'),
    'SGR 1 reached the run as a weight',
  );
});

test('a background run asks for the fill that abuts, not the chip', async () => {
  // `bgFill: 'line'` is the whole reason `src/richtext/` grew the field: two
  // adjacent chip fills overlap by two pixels and paint over each other.
  await renderX11(h(TerminalOutput, { data: `a${ESC}[41mred${ESC}[0mb` }), {
    backend: 'mock',
  });
  const painted = runsOf(richNodes()[0]!).filter((r) => r.bg);
  assert.equal(painted.length, 1);
  assert.equal(painted[0]!.text, 'red');
  assert.equal(painted[0]!.bgFill, 'line');
});

test('text in the default colours paints no background at all', async () => {
  // What lets a log sit inside a page instead of becoming an opaque strip.
  await renderX11(h(TerminalOutput, { data: 'plain output' }), {
    backend: 'mock',
  });
  assert.ok(runsOf(richNodes()[0]!).every((r) => r.bg === undefined));
});

test('an OSC 8 hyperlink reaches the run as an href', async () => {
  const data = `see ${ESC}]8;;https://example.com/docs${ESC}\\the docs${ESC}]8;;${ESC}\\`;
  await renderX11(h(TerminalOutput, { data }), { backend: 'mock' });
  const linked = runsOf(richNodes()[0]!).filter((r) => r.href);
  assert.deepEqual(
    linked.map((r) => [r.text, r.href]),
    [['the docs', 'https://example.com/docs']],
  );
});

test('onDocument reports what a document could not say', async () => {
  const seen: AnsiDocument[] = [];
  await renderX11(
    h(TerminalOutput, {
      data: `${ESC}]0;htop${ESC}\\${ESC}[?1049h${ESC}[2;5Hhi`,
      onDocument: (doc: AnsiDocument) => seen.push(doc),
    }),
    { backend: 'mock' },
  );
  assert.equal(seen.length, 1, 'reported once, off the render');
  const [doc] = seen;
  assert.equal(doc!.needsScreen, true);
  assert.equal(doc!.title, 'htop');
  assert.equal(doc!.dropped['CUP'], 1);
  assert.equal(doc!.dropped['alt-screen'], 1);
});

test('a colors prop puts the capture on its own background', async () => {
  await renderX11(
    h(TerminalOutput, {
      data: 'x',
      colors: { background: '#101014', foreground: '#e6e6e6' },
      'data-testname': 'out',
    }),
    { backend: 'mock' },
  );
  assert.equal(runsOf(richNodes()[0]!)[0]!.color, '#e6e6e6');
  // `style` is on every node at runtime and only on some of react-x11's
  // declarations — the narrower-declaration-than-runtime case AGENTS.md
  // describes, worked around here rather than patched globally.
  const root = surface() as unknown as { style: { backgroundColor?: string } };
  assert.equal(root.style.backgroundColor, '#101014');
});

test('an already-parsed document is taken as it is', async () => {
  const { parseAnsi } = await import('../src/index.js');
  const doc = parseAnsi(`${ESC}[36mcyan${ESC}[0m`);
  await renderX11(h(TerminalOutput, { data: doc }), { backend: 'mock' });
  assert.equal(richNodes()[0]!.textContent(), 'cyan');
});

test('a growing array of chunks is parsed by its tail', async () => {
  // The incremental path: the earlier chunks keep their identity, so only the
  // new one is read — and a sequence split across the boundary still lands.
  const first = [`${ESC}[32mo`];
  const r = await renderX11(h(TerminalOutput, { data: first }), {
    backend: 'mock',
  });
  assert.equal(richNodes()[0]!.textContent(), 'o');

  await act(async () => {
    r.rerender(h(TerminalOutput, { data: [...first, `k${ESC}[0m\nnext`] }));
  });
  assert.equal(richNodes()[0]!.textContent(), 'ok\nnext');
  const runs = runsOf(richNodes()[0]!);
  assert.deepEqual(
    runs.filter((run) => run.text === 'ok' || run.text === 'o').length > 0,
    true,
    'the appended chunk continued the coloured run',
  );
});

test(
  'line numbers render in a gutter that selection ignores',
  { skip: !FONTS },
  async () => {
    const r = await renderX11(
      h(TerminalOutput, {
        data: LOG,
        lineNumbers: true,
        'data-testname': 'out',
      }),
      { fonts: FONTS!, width: 520, height: 200 },
    );
    const nodes = richNodes();
    assert.equal(nodes.length, 2, 'output plus gutter');
    const output = nodes.find((n) => n.textContent().startsWith('PASS'));
    const gutter = nodes.find((n) => n.textContent().startsWith('1'));
    assert.ok(output && gutter);
    assert.equal(gutter.textContent(), '1\n2\n3', 'one number per line');

    // Corner to corner: `dx`/`dy` are offsets from the node's centre, so a
    // three-line block needs its own height rather than `<Code>`'s two-line
    // constants.
    const from = {
      dx: -output.abs.width / 2 + 1,
      dy: -output.abs.height / 2 + 1,
    };
    const to = { dx: output.abs.width / 2 - 1, dy: output.abs.height / 2 - 1 };
    fireEvent.mouseDown(drawn(output), from);
    await dragTo(drawn(output), to);
    fireEvent.mouseUp(drawn(output), to);
    await act();

    assert.equal(
      surface().selectedText(),
      PLAIN,
      'the drag copied the log, and none of the numbering',
    );
    const primary = await clipboardOf(r).read({ selection: 'PRIMARY' });
    assert.equal(primary, PLAIN);
  },
);

test(
  'Ctrl+A / Ctrl+C copy the capture as plain text',
  { skip: !FONTS },
  async () => {
    const r = await renderX11(
      h(TerminalOutput, {
        data: LOG,
        lineNumbers: true,
        'data-testname': 'out',
      }),
      { fonts: FONTS!, width: 520, height: 200 },
    );
    const output = richNodes().find((n) => n.textContent().startsWith('PASS'));
    assert.ok(output);
    await act(async () => {
      fireEvent.mouseDown(drawn(output), {});
      fireEvent.mouseUp(drawn(output), {});
    });
    await act(async () => {
      fireEvent.key(0x61, { modifiers: ['Control'] });
    });
    await act(async () => {
      fireEvent.key(0x63, { modifiers: ['Control'] });
    });
    assert.equal(await clipboardOf(r).read({ selection: 'CLIPBOARD' }), PLAIN);
  },
);

test('wrap turns the gutter off, for the reason <Code> does', async () => {
  await renderX11(
    h(TerminalOutput, { data: LOG, lineNumbers: true, wrap: true }),
    { backend: 'mock' },
  );
  assert.equal(
    richNodes().length,
    1,
    'a wrapped line puts numbering out of register',
  );
});

test('maxLines keeps the tail', async () => {
  await renderX11(h(TerminalOutput, { data: 'a\nb\nc\nd', maxLines: 2 }), {
    backend: 'mock',
  });
  assert.equal(richNodes()[0]!.textContent(), 'c\nd');
});
