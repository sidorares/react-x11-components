// The components that set text in a mono family warm it while they render
// (src/internal/prewarm.ts), so that their first layout takes the system
// font matcher's answer instead of stalling on it. The method is ntk's
// `FontManager#prewarm`; stubbed here on whatever app the tree renders into,
// so each test says which family a component asks for, and when.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useApp } from 'react-x11';
import { renderX11, cleanup, act } from 'react-x11/test';

import { Code } from '../src/code/index.js';
import { CodeEditor } from '../src/code-editor/index.js';
import { Markdown } from '../src/markdown/index.js';
import { TerminalOutput } from '../src/terminal-output/index.js';
import { Terminal } from '../src/terminal/index.js';
import { FakePtyHost } from './fake-pty.js';
import { RichTextEditor } from '../src/rich-text-editor/index.js';
import { schema } from '../src/rich-text-editor/schema.js';
import { styleFamily } from '../src/internal/prewarm.js';

const h = React.createElement;

afterEach(cleanup);

/** What mounting `element`, and rendering it again unchanged, asked the
 *  app's fonts to warm, in order. */
async function asked(element: ReactElement): Promise<string[]> {
  const families: string[] = [];
  let stubbed = false;
  function Probe(props: { children?: ReactNode }): ReactNode {
    const app = useApp() as { fonts?: { prewarm?: (f: string) => void } };
    if (!stubbed && app.fonts) {
      stubbed = true;
      app.fonts.prewarm = (family: string) => void families.push(family);
    }
    return props.children ?? null;
  }
  const { rerender } = await renderX11(h(Probe));
  assert.ok(stubbed, 'the probe reached the app');
  await act(() => rerender(h(Probe, null, element)));
  // rendered again with the same props, it asks nothing new
  await act(() => rerender(h(Probe, null, React.cloneElement(element))));
  return families;
}

test('a code editor warms its family, the one its style names', async () => {
  assert.deepStrictEqual(await asked(h(CodeEditor, { value: 'let x = 1;' })), [
    'monospace',
  ]);
  assert.deepStrictEqual(
    await asked(
      h(CodeEditor, {
        value: 'let x = 1;',
        style: [{ padding: 2 }, { fontFamily: 'Iosevka' }],
      }),
    ),
    ['Iosevka'],
  );
});

test('a code block and a captured session warm the mono family', async () => {
  assert.deepStrictEqual(await asked(h(Code, { source: 'x = 1' })), [
    'monospace',
  ]);
  assert.deepStrictEqual(
    await asked(h(TerminalOutput, { data: 'ok\n', monoFamily: 'Fira Code' })),
    ['Fira Code'],
  );
});

test('a document warms the mono family only when it has code', async () => {
  assert.deepStrictEqual(
    await asked(h(Markdown, { source: 'a line with `code` in it' })),
    ['monospace'],
  );
  assert.deepStrictEqual(
    await asked(h(Markdown, { source: '~~~\nfenced\n~~~', monoFamily: 'M' })),
    ['M'],
  );
  assert.deepStrictEqual(
    await asked(h(Markdown, { source: '# a heading\n\nprose, no code' })),
    [],
  );
});

test('a terminal warms its family when it draws the grid itself', async () => {
  // the vt backend draws in `fontFamily`; a pty is pinned, as every test
  // that renders <Terminal> has to (AGENTS.md)
  assert.deepStrictEqual(
    await asked(
      h(Terminal, { backend: 'vt', pty: new FakePtyHost(), fontFamily: 'T' }),
    ),
    ['T'],
  );
});

test('an editor warms its mono family when it mounts with code', async () => {
  assert.deepStrictEqual(
    await asked(h(RichTextEditor, { defaultValue: 'some `code` here' })),
    ['monospace'],
  );
  assert.deepStrictEqual(
    await asked(h(RichTextEditor, { defaultValue: 'prose alone' })),
    [],
  );
  assert.deepStrictEqual(
    await asked(
      h(RichTextEditor, {
        format: 'html',
        defaultValue: '<pre>x = 1</pre>',
        monoFamily: 'H',
      }),
    ),
    ['H'],
  );
  // a node: the code is a mark, as the schema says
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('see '),
      schema.text('x', [schema.marks.code.create()]),
    ]),
  ]);
  assert.deepStrictEqual(
    await asked(h(RichTextEditor, { defaultValue: doc })),
    ['monospace'],
  );
});

test('styleFamily reads a style the way core flattens one', () => {
  assert.strictEqual(styleFamily(undefined, 'monospace'), 'monospace');
  assert.strictEqual(styleFamily({ fontFamily: 'A' }, 'monospace'), 'A');
  assert.strictEqual(
    styleFamily([{ fontFamily: 'A' }, null, [{ fontFamily: 'B' }]], 'x'),
    'B',
  );
  assert.strictEqual(styleFamily([{ padding: 1 }, false], 'x'), 'x');
});
