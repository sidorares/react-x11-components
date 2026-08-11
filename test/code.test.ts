// <Code> — the static code block. Highlighting itself is the language
// seam's and is tested in code-editor-language.test.ts; what is tested
// here is the composition: runs reach the element coloured, the gutter
// stays out of the selection, and copy pastes clean code.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import { renderX11, cleanup, screen, fireEvent, act } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { Code, RichTextNode } from '../src/index.js';

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

test('it mounts on the mock backend and the code is one selectable block', async () => {
  await renderX11(
    h(Code, { source: SOURCE, lang: 'js', 'data-testname': 'code' }),
    {
      backend: 'mock',
    },
  );
  const nodes = richNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text(), SOURCE);
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
      h(Code, { source: SOURCE, lang: 'js', lineNumbers: true }),
      { fonts: FONTS!, width: 420, height: 200 },
    );
    const nodes = richNodes();
    assert.equal(nodes.length, 2, 'code plus gutter');
    const code = nodes.find((n) => n.text().startsWith('const'));
    const gutter = nodes.find((n) => n.text().startsWith('1'));
    assert.ok(code && gutter);

    await act(async () => {
      fireEvent.mouseDown(drawn(code), { dx: -code.abs.width / 2 + 1, dy: -4 });
    });
    await act(async () => {
      fireEvent.mouseMove(drawn(code), { dx: code.abs.width / 2 - 1, dy: 8 });
    });
    await act(async () => {
      fireEvent.mouseUp(drawn(code), { dx: code.abs.width / 2 - 1, dy: 8 });
    });

    const [a, b] = code.selection;
    assert.equal(code.text(a, b), SOURCE, 'the drag selected the whole block');
    const [ga, gb] = gutter.selection;
    assert.equal(gb - ga, 0, 'the gutter took no selection');

    const primary = await clipboardOf(r).read({ selection: 'PRIMARY' });
    assert.equal(primary, SOURCE, 'PRIMARY pastes code, not line numbers');
  },
);

test('Ctrl+A / Ctrl+C copy only the code', { skip: !FONTS }, async () => {
  const r = await renderX11(
    h(Code, { source: SOURCE, lang: 'js', lineNumbers: true }),
    { fonts: FONTS!, width: 420, height: 200 },
  );
  const code = richNodes().find((n) => n.text().startsWith('const'));
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
