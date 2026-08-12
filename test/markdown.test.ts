// <Markdown> — the parser is tested directly (it is exported API, and every
// subtle markdown bug lives there), the widget through the harness: mock
// backend for structure, the in-process X server for the parts that need
// real font metrics — layout, drag selection, clipboard.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import { renderX11, cleanup, screen, fireEvent, act } from 'react-x11/test';
import { drawnKinds, registeredElements } from 'react-x11/host';
import type { DrawnNode } from 'react-x11';

import { Markdown, RichTextNode, parseMarkdown } from '../src/index.js';
import { parseInline } from '../src/markdown/index.js';
import type { BlockNode, InlineNode } from '../src/index.js';

const h = React.createElement;

/** `fireEvent` speaks the ref-facing `DrawnNode`; the queries hand back the
 *  retained node. Same widening as `calendar.test.ts`. */
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

afterEach(cleanup);

// Real font files, so metrics are machine-stable. Both families ship with
// macOS and the Linux paths cover the common distros; a box with neither
// skips the metric-dependent tests rather than failing them.
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

// --- inline helpers over the AST -------------------------------------------

function flat(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return n.text;
        case 'code':
          return `code[${n.text}]`;
        case 'break':
          return '\\n';
        case 'link':
          return `${n.image ? 'img' : 'link'}[${flat(n.children)}](${String(n.href)})`;
        case 'component':
          return `<${n.name}>`;
        default:
          return `${n.type}[${flat(n.children)}]`;
      }
    })
    .join('');
}

function types(blocks: BlockNode[]): string {
  return blocks.map((b) => b.type).join(',');
}

// --- the parser: complete documents ----------------------------------------

test('blocks: headings, setext, rule, quote, code', () => {
  const { blocks } = parseMarkdown(
    '# One\n\nTitle\n===\n\npara\n\n---\n\n> quoted\n\n```js\nlet x;\n```\n\n    indented\n',
    { partial: false },
  );
  assert.equal(types(blocks), 'heading,heading,paragraph,rule,quote,code,code');
  const [h1, setext] = blocks as Array<Extract<BlockNode, { type: 'heading' }>>;
  assert.equal(h1.depth, 1);
  assert.equal(setext.depth, 1);
  const fence = blocks[5] as Extract<BlockNode, { type: 'code' }>;
  assert.equal(fence.lang, 'js');
  assert.equal(fence.text, 'let x;');
  assert.equal(fence.closed, true);
  const indented = blocks[6] as Extract<BlockNode, { type: 'code' }>;
  assert.equal(indented.text, 'indented');
});

test('inline: emphasis, code, links, entities, escapes', () => {
  assert.equal(
    flat(
      parseInline('**b** *i* ~~s~~ `c` [t](u) <https://a.b> \\*lit\\*', false),
    ),
    'strong[b] em[i] del[s] code[c] link[t](u) link[https://a.b](https://a.b) *lit*',
  );
  assert.equal(flat(parseInline('a &amp; b', false)), 'a & b');
  assert.equal(
    flat(parseInline('snake_case 2*3*4', false)),
    'snake_case 2em[3]4',
  );
  assert.equal(flat(parseInline('**foo*bar***', false)), 'strong[fooem[bar]]');
  // single tilde is never strikethrough here, so ranges need no escaping
  assert.equal(flat(parseInline('20~25', false)), '20~25');
});

test('an unclosed construct in a *final* document stays literal', () => {
  assert.equal(flat(parseInline('a **b and `c', false)), 'a **b and `c');
});

test('images become links to their source, alt text as the face', () => {
  assert.equal(
    flat(parseInline('see ![the alt](http://x/p.png)', false)),
    'see img[the alt](http://x/p.png)',
  );
});

test('nested lists, task items, looseness, ordered start', () => {
  const { blocks } = parseMarkdown(
    '3. three\n4. four\n   - [x] done\n   - [ ] todo\n\nafter',
    { partial: false },
  );
  const list = blocks[0] as Extract<BlockNode, { type: 'list' }>;
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 2);
  const sub = list.items[1].children[1] as Extract<BlockNode, { type: 'list' }>;
  assert.equal(sub.items[0].checked, true);
  assert.equal(sub.items[1].checked, false);
});

test('tables: alignment, escaped pipes, ragged rows', () => {
  const { blocks } = parseMarkdown(
    '| a | b |\n| :- | -: |\n| 1 \\| x | 2 |\n| only |\n',
    { partial: false },
  );
  const t = blocks[0] as Extract<BlockNode, { type: 'table' }>;
  assert.deepEqual(t.align, ['left', 'right']);
  assert.equal(flat(t.rows[0][0]), '1 | x');
  assert.equal(t.rows[1].length, 2); // padded to the header's width
  assert.equal(flat(t.rows[1][1]), '');
});

test('raws are index-aligned with blocks — the streaming cache contract', () => {
  const doc = parseMarkdown('# a\n\npara\n\n- x\n- y');
  assert.equal(doc.raws.length, doc.blocks.length);
  assert.equal(doc.raws[0], '# a');
  assert.equal(doc.raws[1], 'para');
});

// --- the parser: streaming (partial) documents -----------------------------

test('partial: unclosed emphasis and code close implicitly at the tail', () => {
  assert.equal(flat(parseInline('a **bold and', true)), 'a strong[bold and]');
  assert.equal(flat(parseInline('x ***wow', true)), 'x strong[em[wow]]');
  assert.equal(flat(parseInline('run `npm i', true)), 'run code[npm i]');
  assert.equal(flat(parseInline('gone ~~alrea', true)), 'gone del[alrea]');
});

test('partial: implicit closes stop at the tail block, not mid-document', () => {
  const { blocks } = parseMarkdown('one **two\n\nlast **word', {
    partial: true,
  });
  assert.equal(
    flat((blocks[0] as { children: InlineNode[] }).children),
    'one **two',
  );
  assert.equal(
    flat((blocks[1] as { children: InlineNode[] }).children),
    'last strong[word]',
  );
});

test('partial: half-arrived links keep their text, images vanish', () => {
  assert.equal(
    flat(parseInline('see [docs](https://exa', true)),
    'see link[docs](null)',
  );
  assert.equal(
    flat(parseInline('see [docs are', true)),
    'see link[docs are](null)',
  );
  assert.equal(flat(parseInline('pic ![alt](http://x', true)), 'pic ');
});

test('partial: a bare trailing opener is hidden, not shown raw', () => {
  assert.equal(flat(parseInline('text **', true)), 'text ');
  assert.equal(flat(parseInline('text `', true)), 'text ');
});

test('partial: ambiguous tail lines are held back', () => {
  // "---" could still become a rule, a setext underline, or plain text
  assert.equal(
    types(parseMarkdown('Title\n---', { partial: true }).blocks),
    'paragraph',
  );
  assert.equal(
    types(parseMarkdown('para\n\n---', { partial: true }).blocks),
    'paragraph',
  );
  assert.equal(
    types(parseMarkdown('text\n\n##', { partial: true }).blocks),
    'paragraph',
  );
  // …and commit once the document is final
  assert.equal(
    types(parseMarkdown('Title\n---', { partial: false }).blocks),
    'heading',
  );
  assert.equal(
    types(parseMarkdown('para\n\n---', { partial: false }).blocks),
    'paragraph,rule',
  );
});

test('partial: an open fence renders as an open code block', () => {
  const { blocks } = parseMarkdown('```python\nprint(1)', { partial: true });
  const code = blocks[0] as Extract<BlockNode, { type: 'code' }>;
  assert.equal(code.lang, 'python');
  assert.equal(code.closed, false);
  assert.equal(code.text, 'print(1)');
});

test('partial: tables appear as soon as they can be read', () => {
  // delimiter row still arriving: header-only table
  assert.equal(
    types(parseMarkdown('| a | b |\n| :-', { partial: true }).blocks),
    'table',
  );
  // header row itself still arriving: held, not flashed as literal pipes
  assert.equal(types(parseMarkdown('| a | b |', { partial: true }).blocks), '');
  // a ragged final row renders with the cells that exist
  const t = parseMarkdown('| a | b |\n| - | - |\n| 1 | 2', { partial: true })
    .blocks[0] as Extract<BlockNode, { type: 'table' }>;
  assert.equal(flat(t.rows[0][1]), '2');
});

// --- the element -----------------------------------------------------------

test('importing the component is what registers the element', () => {
  assert.ok(registeredElements().includes('richtext'));
  assert.ok(
    drawnKinds().includes('richtext'),
    'richtext must join the paint order',
  );
});

test('it mounts on the mock backend, where there are no font metrics', async () => {
  const md = '# T\n\npara with **bold**\n\n- a\n- b\n\n| x |\n| - |\n| 1 |';
  await renderX11(h(Markdown, { source: md, 'data-testname': 'md' }), {
    backend: 'mock',
  });
  const root = screen.all(
    (n) =>
      (n as { props?: Record<string, unknown> }).props?.['data-testname'] ===
      'md',
  );
  assert.equal(root.length, 1);
  const texts = screen.all((n) => n instanceof RichTextNode);
  assert.ok(texts.length >= 5, `expected blocks, got ${texts.length}`);
});

// --- with real metrics: layout, selection, clipboard -----------------------

const SOURCE = `# Hello

This is **bold** and a [link](https://x.dev) here.

- item one
- item two

\`\`\`js
const x = 1;
\`\`\`
`;

/** The blocks, in document order — which is the order the tree is walked
 *  in, and since react-x11#291 the order the selection reads them in too:
 *  there is no `order` prop to sort by any more. */
function mdNodes(): RichTextNode[] {
  return screen
    .all((n) => n instanceof RichTextNode)
    .map((n) => n as unknown as RichTextNode);
}

/** The `selectable` root — the surface the public selection methods are on. */
function surface(): DrawnNode {
  const [root] = screen.all(
    (n) =>
      (n as { props?: Record<string, unknown> }).props?.selectable === true,
  );
  assert.ok(root, 'the document root is a selection surface');
  return root as DrawnNode;
}

/** What one block has lit, as text. */
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
async function dragTo(node: DrawnNode, options: object = {}): Promise<void> {
  fireEvent.mouseMove(node, options);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act();
}

test(
  'blocks lay out with real heights and wrap to the given width',
  {
    skip: !FONTS,
  },
  async () => {
    await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Markdown, { source: SOURCE }),
      ),
      { fonts: FONTS!, width: 420, height: 400 },
    );
    const nodes = mdNodes();
    assert.equal(nodes.length, 5);
    const [heading, para, itemOne] = nodes;
    assert.ok(
      heading.abs.height > para.abs.height,
      'heading is bigger than body',
    );
    assert.ok(para.abs.height > 0);
    assert.equal(itemOne.textContent(), 'item one');
    assert.ok(itemOne.abs.x > para.abs.x, 'list items are indented');
  },
);

test(
  'drag selects across blocks and mouse-up takes PRIMARY',
  {
    skip: !FONTS,
  },
  async () => {
    const r = await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Markdown, { source: SOURCE }),
      ),
      { fonts: FONTS!, width: 420, height: 400 },
    );
    const nodes = mdNodes();
    const para = nodes[1];
    const itemTwo = nodes[3];

    fireEvent.mouseDown(drawn(para), { dx: -para.abs.width / 2 + 1 });
    await dragTo(drawn(itemTwo));
    fireEvent.mouseUp(drawn(itemTwo), {});
    await act();

    assert.equal(litIn(para), 'This is bold and a link here.');
    assert.equal(litIn(itemTwo), 'item two');
    assert.equal(
      surface().selectedText(),
      'This is bold and a link here.\nitem one\nitem two',
      'the surface assembles what the blocks have lit',
    );

    const primary = await clipboardOf(r).read({ selection: 'PRIMARY' });
    // The separators come from the layout, not the markup: each block starts
    // below the last, so each is a new line. The list markers are
    // `selectable={false}` and are absent from both.
    assert.equal(primary, 'This is bold and a link here.\nitem one\nitem two');
  },
);

test(
  'Ctrl+A selects everything, Ctrl+C copies it',
  { skip: !FONTS },
  async () => {
    const r = await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Markdown, { source: 'first para\n\nsecond para' }),
      ),
      { fonts: FONTS!, width: 420, height: 300 },
    );
    const [first] = mdNodes();

    // focus lands on the markdown root via mousedown, like any focusable
    await act(async () => {
      fireEvent.mouseDown(drawn(first), {});
      fireEvent.mouseUp(drawn(first), {});
    });
    await act(async () => {
      fireEvent.key(0x61 /* a */, { modifiers: ['Control'] });
    });
    for (const n of mdNodes()) {
      assert.equal(
        litIn(n),
        n.textContent(),
        'Ctrl+A selects every block fully',
      );
    }

    await act(async () => {
      fireEvent.key(0x63 /* c */, { modifiers: ['Control'] });
    });
    const copied = await clipboardOf(r).read({ selection: 'CLIPBOARD' });
    // One paragraph per line: core assembles a copy from the boxes on screen,
    // where a paragraph is a row and the blank line between two of them is
    // a gap rather than text. (It used to be `\n\n`, from a separator this
    // renderer threaded through every block itself.)
    assert.equal(copied, 'first para\nsecond para');
  },
);

test(
  'double-click selects the word under the pointer',
  { skip: !FONTS },
  async () => {
    await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Markdown, { source: 'alpha beta gamma' }),
      ),
      { fonts: FONTS!, width: 420, height: 200 },
    );
    const [para] = mdNodes();
    await act(async () => {
      fireEvent.doubleClick(drawn(para), { dx: -para.abs.width / 2 + 4 });
    });
    assert.equal(litIn(para), 'alpha');
  },
);

test(
  'a click follows a link; a drag is a selection, not a click',
  {
    skip: !FONTS,
  },
  async () => {
    const seen: string[] = [];
    await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Markdown, {
          source: '[go somewhere](https://dest.example) trailing text',
          onLink: (href: string) => seen.push(href),
        }),
      ),
      { fonts: FONTS!, width: 420, height: 200 },
    );
    const [para] = mdNodes();
    const linkDx = -para.abs.width / 2 + 8; // inside "go somewhere"

    await act(async () => {
      fireEvent.mouseDown(drawn(para), { dx: linkDx });
      fireEvent.mouseUp(drawn(para), { dx: linkDx });
    });
    assert.deepEqual(seen, ['https://dest.example']);

    // drag off the link: selection, no navigation
    fireEvent.mouseDown(drawn(para), { dx: linkDx });
    await dragTo(drawn(para), { dx: linkDx + 120 });
    fireEvent.mouseUp(drawn(para), { dx: linkDx + 120 });
    await act();
    assert.deepEqual(
      seen,
      ['https://dest.example'],
      'the drag did not navigate',
    );
    assert.ok(litIn(para).length > 0, 'the drag selected instead');
  },
);

test(
  'streaming keeps settled blocks: same retained node, growing tail',
  {
    skip: !FONTS,
  },
  async () => {
    const r = await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Markdown, { source: 'stable paragraph\n\nstreaming **bo' }),
      ),
      { fonts: FONTS!, width: 420, height: 300 },
    );
    const before = mdNodes();
    assert.equal(
      before[1].textContent(),
      'streaming bo',
      'implicit close, markers hidden',
    );

    await r.rerender(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Markdown, { source: 'stable paragraph\n\nstreaming **bold** done' }),
      ),
    );
    const after = mdNodes();
    assert.equal(after[1].textContent(), 'streaming bold done');
    assert.equal(
      after[0],
      before[0],
      'the settled block kept its retained node across the append',
    );
  },
);
