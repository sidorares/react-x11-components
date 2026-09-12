// The rich text editor's pure parts, asserted with no display: the block
// keys React renders under, the map between drawn text and the document,
// markdown both ways (by example, and over a generated corpus), HTML both
// ways, the clipboard's own format, and the key translation every keymap
// plugin reads.
import { test } from 'node:test';
import assert from 'node:assert';
import { keydownHandler } from 'prosemirror-keymap';
import { Fragment, Schema, Slice } from 'prosemirror-model';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { parse } from '../src/internal/markdown/parse.js';
import { stringify } from '../src/internal/markdown/stringify.js';
import {
  parseFromClipboard,
  serializeForClipboard,
} from '../src/rich-text-editor/clipboard.js';
import type { ClipboardView } from '../src/rich-text-editor/clipboard.js';
import { docFromHTML, htmlFromContent } from '../src/rich-text-editor/html.js';
import { buildInline } from '../src/rich-text-editor/inline.js';
import type { InlineLook } from '../src/rich-text-editor/inline.js';
import { BlockKeys } from '../src/rich-text-editor/keys.js';
import { toDomKeyEvent } from '../src/rich-text-editor/keymap.js';
import {
  docFromMarkdown,
  markdownCodec,
  markdownFromDoc,
} from '../src/rich-text-editor/markdown.js';
import { schema } from '../src/rich-text-editor/schema.js';

const { nodes: N, marks: M } = schema;
const p = (...content: (PMNode | string)[]): PMNode =>
  N.paragraph.create(
    null,
    content.map((c) => (typeof c === 'string' ? schema.text(c) : c)),
  );
const doc = (...blocks: PMNode[]): PMNode => N.doc.create(null, blocks);

// --- block keys ----------------------------------------------------------------

test('block keys survive typing, and shifting, and are fresh for a split-off block', () => {
  let state = EditorState.create({ doc: doc(p('one'), p('two'), p('three')) });
  const keys = new BlockKeys(state.doc);
  const before = [keys.keyAt(0), keys.keyAt(5), keys.keyAt(10)];
  assert.ok(before.every(Boolean));

  // typing in the first paragraph shifts the others' positions
  const typed = state.tr.insertText('!!', 4);
  keys.update(typed.doc, typed.mapping);
  state = state.apply(typed);
  assert.strictEqual(
    keys.keyAt(0),
    before[0],
    'the typed-in block keeps its key',
  );
  assert.strictEqual(
    keys.keyAt(7),
    before[1],
    'the next block moved and kept its key',
  );
  assert.strictEqual(keys.keyAt(12), before[2]);

  // a split: the first half keeps the key, the second half is a new block
  const split = state.tr.split(3);
  keys.update(split.doc, split.mapping);
  state = state.apply(split);
  assert.strictEqual(keys.keyAt(0), before[0]);
  const fresh = keys.keyAt(state.doc.child(0).nodeSize);
  assert.ok(fresh && !before.includes(fresh), 'the split-off half is new');

  // a join: the second half's key goes with it
  const join = state.tr.join(state.doc.child(0).nodeSize);
  keys.update(join.doc, join.mapping);
  assert.strictEqual(keys.keyAt(0), before[0]);
  assert.strictEqual(keys.posOf(fresh!), undefined, 'the joined block is gone');
});

test('block keys carry through a wrap, and by identity when there is no mapping', () => {
  const state = EditorState.create({ doc: doc(p('a'), p('b')) });
  const keys = new BlockKeys(state.doc);
  const second = keys.keyAt(3)!;
  const $b = state.doc.resolve(4);
  const range = $b.blockRange()!;
  const tr = state.tr.wrap(range, [
    { type: N.bullet_list },
    { type: N.list_item },
  ]);
  keys.update(tr.doc, tr.mapping);
  // the paragraph is now two levels down, and still itself
  const paraPos = 3 + 2;
  assert.strictEqual(tr.doc.nodeAt(paraPos)?.textContent, 'b');
  assert.strictEqual(keys.keyAt(paraPos), second);

  // a whole new document with no mapping: unchanged nodes are matched by
  // identity, so the untouched first paragraph keeps its key
  const first = keys.keyAt(0)!;
  const next = doc(tr.doc.child(0), p('c'));
  keys.update(next, null);
  assert.strictEqual(keys.keyAt(0), first);
});

// --- the inline map ------------------------------------------------------------

const LOOK: InlineLook = {
  base: { family: 'sans-serif', size: 14, color: '#000' },
  mark: (mark) =>
    mark.type === M.strong
      ? { weight: 700 }
      : mark.type === M.em
        ? { style: 'italic' }
        : {},
  atom: (node) =>
    node.type === N.hard_break
      ? { text: '\n' }
      : { text: String(node.attrs.alt ?? 'img') },
};

test('the inline map is the identity over plain text, in code points', () => {
  const block = p('a😀b');
  const { runs, map } = buildInline(block, LOOK);
  assert.strictEqual(runs.map((r) => r.text).join(''), 'a😀b');
  // four UTF-16 units, three code points
  assert.strictEqual(block.content.size, 4);
  assert.strictEqual(map.length, 3);
  assert.deepStrictEqual(
    [0, 1, 3, 4].map((o) => map.toDisplay(o)),
    [0, 1, 2, 3],
  );
  assert.deepStrictEqual(
    [0, 1, 2, 3].map((cp) => map.toDoc(cp)),
    [0, 1, 3, 4],
  );
});

test('an empty block draws a space to hold a caret, and every point of it is offset 0', () => {
  const { runs, map } = buildInline(p(), LOOK);
  assert.deepStrictEqual(
    runs.map((r) => r.text),
    [' '],
  );
  assert.strictEqual(map.toDisplay(0), 0);
  assert.strictEqual(map.toDoc(0), 0);
  assert.strictEqual(map.toDoc(1), 0);
});

test('a trailing hard break opens a line, and the caret after it is on that line', () => {
  const block = p('ab', N.hard_break.create());
  const { runs, map } = buildInline(block, LOOK);
  assert.strictEqual(runs.map((r) => r.text).join(''), 'ab\n ');
  assert.strictEqual(
    map.toDisplay(3),
    3,
    'after the break: the start of the new line',
  );
  assert.strictEqual(map.toDoc(4), 3, 'the filler maps back to the end');
});

test('an atom is one position drawn as its label; a press inside it snaps to the nearer edge', () => {
  const img = N.image.create({ src: 'x.png', alt: 'photo' });
  const block = p('a', img, 'b');
  const { runs, map } = buildInline(block, LOOK);
  assert.strictEqual(runs.map((r) => r.text).join(''), 'aphotob');
  assert.strictEqual(map.toDisplay(1), 1);
  assert.strictEqual(
    map.toDisplay(2),
    6,
    'after the atom: past its whole label',
  );
  assert.strictEqual(map.toDoc(2), 1, 'early in the label: before the atom');
  assert.strictEqual(map.toDoc(5), 2, 'late in the label: after it');
});

test('widgets take no document width; their side decides which side of them a caret is', () => {
  const block = p('hi');
  const after = buildInline(
    block,
    LOOK,
    [],
    [{ pos: 0, side: 0, text: 'Type…' }],
  );
  assert.strictEqual(after.map.text, 'Type…hi');
  assert.strictEqual(
    after.map.toDisplay(0),
    0,
    'side 0: the caret is before the widget',
  );
  const before = buildInline(
    block,
    LOOK,
    [],
    [{ pos: 1, side: -1, text: '´' }],
  );
  assert.strictEqual(before.map.text, 'h´i');
  assert.strictEqual(
    before.map.toDisplay(1),
    2,
    'side -1: the caret is after it',
  );
  assert.strictEqual(before.map.toDoc(2), 1);
});

test('decorations split runs where they start and end, and equal runs merge again', () => {
  const block = p(schema.text('bold', [M.strong.create()]), ' plain');
  const { runs } = buildInline(block, LOOK, [
    { from: 2, to: 7, style: { bg: 'yellow' } },
  ]);
  assert.deepStrictEqual(
    runs.map((r) => [r.text, r.weight ?? null, r.bg ?? null]),
    [
      ['bo', 700, null],
      ['ld', 700, 'yellow'],
      [' pl', null, 'yellow'],
      ['ain', null, null],
    ],
  );
  assert.strictEqual(buildInline(p('a', 'b'), LOOK).runs.length, 1);
});

// --- markdown --------------------------------------------------------------------

const CORPUS = [
  '# Title\n\nSome *em* and **strong** and ~~del~~ and `code`.',
  'Setext\n======\n\nSub\n---',
  '# Ends with # hash #',
  'a **b *c* d** e',
  '***both*** and **_mixed_**',
  'snake_case and _em_ and __strong__',
  'Code with `` a`b `` and ``` `` ``` spans',
  'A [link](https://example.com "Title") and [paren](https://x.y/a_(b)) and [sp](<a b c>)',
  'Auto <https://example.com/x?y=1> and <me@example.com>',
  '![alt *text*](img.png "t") inline',
  'line one  \nline two\\\nline three',
  '\\# not a heading\n\n1\\. not a list\n\n\\- not a bullet\n\n\\> not a quote',
  'Escapes: \\* \\_ \\` \\[x\\] \\\\ &amp; &copy; <div> 5 < 6 a|b',
  '- a\n- b\n  - c\n  - d\n- e',
  '1. one\n2. two\n\n   para in two\n3. three',
  '- [ ] todo\n- [x] done\n- plain',
  '- a\n- b\n\n* c\n* d',
  '```js title="x"\nconst a = 1;\n\nconst b = `x`;\n```',
  '````\n```\nnested fence\n```\n````',
  '- step:\n\n  ```sh\n  npm i\n\n\n  npm test\n  ```\n- next',
  '> quote\n> > nested\n>\n> - list in quote',
  '| a | b | c |\n| :-- | :-: | --: |\n| 1 | **2** | `3` |\n| x \\| y | | z |',
  'Para\n\n---\n\nAfter rule',
  'Emoji 🎉 and CJK 漢字 and RTL שלום',
  'a*b*c and a**b**c',
];

test('markdown: every AST the parser gives back reads back as itself', () => {
  for (const source of CORPUS) {
    const ast = parse(source, { partial: false });
    const out = stringify(ast);
    assert.deepStrictEqual(
      parse(out, { partial: false }).blocks,
      ast.blocks,
      source,
    );
    assert.strictEqual(
      stringify(parse(out, { partial: false })),
      out,
      `idempotent: ${source}`,
    );
  }
});

test('markdown: the parser fixes the serializer leaned on', () => {
  // an escaped ampersand is not the start of a reference
  const amp = parse('\\&amp;', { partial: false }).blocks[0];
  assert.deepStrictEqual(amp, {
    type: 'paragraph',
    children: [{ type: 'text', text: '&amp;' }],
  });
  // a delimiter run beside an emoji sees the whole emoji, not half of it
  const emoji = parse('🎉**x**', { partial: false }).blocks[0];
  assert.deepStrictEqual(emoji, {
    type: 'paragraph',
    children: [
      { type: 'text', text: '🎉' },
      { type: 'strong', children: [{ type: 'text', text: 'x' }] },
    ],
  });
  // blank lines inside a fence in a list item are the code's
  const list = parse('- step\n\n  ```\n  a\n\n\n  b\n  ```\n- next', {
    partial: false,
  }).blocks[0] as Extract<
    ReturnType<typeof parse>['blocks'][number],
    { type: 'list' }
  >;
  assert.strictEqual(list.items.length, 2);
  assert.deepStrictEqual(list.items[0].children[1], {
    type: 'code',
    lang: '',
    text: 'a\n\n\nb',
    closed: true,
  });
  // a task item may open a fence
  const task = parse('- [ ] ```\n  x\n\n  y\n  ```', { partial: false })
    .blocks[0] as Extract<
    ReturnType<typeof parse>['blocks'][number],
    { type: 'list' }
  >;
  assert.strictEqual(task.items[0].checked, false);
  assert.strictEqual(task.items.length, 1);
  // a link's title is kept
  const link = parse('[a](b "t")', { partial: false }).blocks[0];
  assert.deepStrictEqual(link, {
    type: 'paragraph',
    children: [
      {
        type: 'link',
        href: 'b',
        image: false,
        title: 't',
        children: [{ type: 'text', text: 'a' }],
      },
    ],
  });
});

test('markdown ↔ document: GFM constructs map to the reference schema', () => {
  const d = docFromMarkdown(
    schema,
    '# H\n\n- [x] done\n- [ ] todo\n\n3. three\n\n> q\n\n```ts title="a"\nx\n```\n\n| a | b |\n| :-: | --: |\n| 1 | 2 |\n\n---\n\n![alt](i.png) and **b** *i* ~~s~~ `c` [l](u "t")',
  );
  d.check();
  const types = [] as string[];
  d.forEach((node) => types.push(node.type.name));
  assert.deepStrictEqual(types, [
    'heading',
    'bullet_list',
    'ordered_list',
    'blockquote',
    'code_block',
    'table',
    'horizontal_rule',
    'paragraph',
  ]);
  assert.deepStrictEqual(
    [d.child(1).child(0).attrs.checked, d.child(1).child(1).attrs.checked],
    [true, false],
  );
  assert.strictEqual(d.child(2).attrs.order, 3);
  assert.strictEqual(d.child(4).attrs.params, 'ts title="a"');
  assert.deepStrictEqual(
    [
      d.child(5).child(0).child(0).attrs.align,
      d.child(5).child(0).child(1).attrs.align,
    ],
    ['center', 'right'],
  );
  assert.strictEqual(d.child(5).child(0).child(0).type, N.table_header);
  const last = d.child(7);
  assert.strictEqual(last.child(0).type, N.image);
  const link = last.lastChild!.marks.find((m) => m.type === M.link);
  assert.deepStrictEqual({ ...link?.attrs }, { href: 'u', title: 't' });
  // and back, with nothing lost
  assert.ok(docFromMarkdown(schema, markdownFromDoc(d)).eq(d));
});

test('markdown ↔ document: a generated corpus keeps its text, and settles after one trip', () => {
  let seed = 0x5eed;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const ALPHABET = [
    'a',
    'word',
    ' ',
    '  ',
    '*',
    '_',
    '`',
    '~',
    '#',
    '>',
    '-',
    '1.',
    '[',
    ']',
    '(',
    ')',
    '\\',
    '&amp;',
    '<x',
    '|',
    '!',
    'é',
    '🎉',
    'snake_case',
    '**',
    '~~',
    '+',
  ];
  const text = (): string =>
    Array.from({ length: 1 + Math.floor(rnd() * 5) }, () =>
      pick(ALPHABET),
    ).join('');
  const markSet = () => {
    const out = [];
    if (rnd() < 0.3) out.push(M.strong.create());
    if (rnd() < 0.3) out.push(M.em.create());
    if (rnd() < 0.15) out.push(M.strike.create());
    if (rnd() < 0.15) out.push(M.code.create());
    if (rnd() < 0.1)
      out.push(
        M.link.create({
          href: pick(['https://x.y', 'a b', 'p(q)']),
          title: rnd() < 0.3 ? 't"x' : null,
        }),
      );
    return out;
  };
  const inline = (): PMNode[] =>
    Array.from({ length: Math.floor(rnd() * 5) }, () =>
      rnd() < 0.08
        ? N.hard_break.create()
        : rnd() < 0.05
          ? N.image.create({ src: 'i.png', alt: rnd() < 0.5 ? 'alt' : null })
          : schema.text(text(), markSet()),
    );
  const block = (depth: number): PMNode => {
    const r = rnd();
    if (depth > 2 || r < 0.45) return N.paragraph.create(null, inline());
    if (r < 0.55)
      return N.heading.create({ level: 1 + Math.floor(rnd() * 6) }, inline());
    if (r < 0.63) {
      return N.code_block.create(
        { params: pick(['', 'js', 'ts title="x"']) },
        rnd() < 0.8
          ? schema.text(pick(['a\nb', 'x```y', '\n\nz', '  indented', '~~~']))
          : null,
      );
    }
    if (r < 0.7) return N.blockquote.create(null, [block(depth + 1)]);
    if (r < 0.85) {
      const task = rnd() < 0.3;
      const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
        N.list_item.create({ checked: task ? rnd() < 0.5 : null }, [
          N.paragraph.create(null, inline()),
          ...(rnd() < 0.3 ? [block(depth + 1)] : []),
        ]),
      );
      return !task && rnd() < 0.4
        ? N.ordered_list.create(
            { order: pick([1, 3, 10]), tight: rnd() < 0.7 },
            items,
          )
        : N.bullet_list.create({ tight: rnd() < 0.7 }, items);
    }
    if (r < 0.92) return N.horizontal_rule.create();
    const row = (header: boolean): PMNode =>
      N.table_row.create(
        null,
        [0, 1].map((c) =>
          (header ? N.table_header : N.table_cell).create(
            { align: [null, 'left'][c] },
            inline().filter((n) => n.type !== N.hard_break),
          ),
        ),
      );
    return N.table.create(null, [row(true), row(false)]);
  };
  for (let i = 0; i < 400; i++) {
    const d = doc(
      ...Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => block(0)),
    );
    const md1 = markdownFromDoc(d);
    const d1 = docFromMarkdown(schema, md1);
    d1.check();
    const md2 = markdownFromDoc(d1);
    const d2 = docFromMarkdown(schema, md2);
    assert.strictEqual(
      d1.textContent.replace(/\s+/g, ''),
      d.textContent.replace(/\s+/g, ''),
      `text lost: ${JSON.stringify(md1)}`,
    );
    assert.ok(
      d2.eq(d1),
      `did not settle: ${JSON.stringify(md1)} → ${JSON.stringify(md2)}`,
    );
    assert.strictEqual(markdownFromDoc(d2), md2);
  }
});

test('markdown out: what cannot be said is dropped, not mangled', () => {
  // an empty paragraph has no markdown
  assert.strictEqual(markdownFromDoc(doc(p('a'), p(), p('b'))), 'a\n\nb');
  // a trailing hard break would read back as a backslash
  assert.strictEqual(markdownFromDoc(doc(p('a', N.hard_break.create()))), 'a');
  // bold that ends in punctuation, glued to a letter, has no spelling: the
  // text survives and the emphasis does not
  const glued = doc(p(schema.text('"q"', [M.strong.create()]), 's'));
  assert.strictEqual(markdownFromDoc(glued), '"q"s');
});

// --- HTML --------------------------------------------------------------------------

test('HTML in: a browser clipboard, read by the schema’s own rules', () => {
  const d = docFromHTML(
    schema,
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-x">' +
      '<h2>Title</h2><p>plain <span style="font-weight:700">bold</span> ' +
      '<a href="https://x.y" title="t">link</a></p>' +
      '<ul><li><p>one</p></li><li class="task-list-item"><input type="checkbox" checked> two</li></ul>' +
      '<pre><code class="language-js">let a = 1;</code></pre></b>',
  );
  d.check();
  assert.strictEqual(d.child(0).type, N.heading);
  assert.strictEqual(d.child(0).attrs.level, 2);
  const para = d.child(1);
  const bold = para.child(1);
  assert.strictEqual(bold.text, 'bold');
  assert.ok(M.strong.isInSet(bold.marks), 'a bold span is strong');
  assert.ok(
    !M.strong.isInSet(para.child(0).marks),
    'the Google Docs wrapper is not',
  );
  assert.deepStrictEqual(
    { ...para.lastChild!.marks[0].attrs },
    { href: 'https://x.y', title: 't' },
  );
  const list = d.child(2);
  assert.strictEqual(list.type, N.bullet_list);
  assert.strictEqual(list.child(1).attrs.checked, true);
  assert.strictEqual(d.child(3).attrs.params, 'js');
});

test('HTML out, and back: the document survives its own toDOM', () => {
  const d = docFromMarkdown(
    schema,
    '# H\n\n- [x] a\n- b\n\n```js\nx\n```\n\n| a |\n| --- |\n| 1 |',
  );
  const html = htmlFromContent(schema, d);
  assert.match(html, /<h1>H<\/h1>/);
  assert.match(
    html,
    /<pre data-params="js"><code class="language-js">x<\/code><\/pre>/,
  );
  assert.match(html, /<input type="checkbox" disabled="" checked="">/);
  assert.ok(docFromHTML(schema, html).eq(d), html);
});

test('markdown ↔ document: a schema in TipTap’s names reads and writes the same markdown', () => {
  // the names (and attribute names) TipTap's StarterKit gives its specs
  const tiptap = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*' },
      heading: {
        group: 'block',
        content: 'inline*',
        attrs: { level: { default: 1 } },
      },
      blockquote: { group: 'block', content: 'block+' },
      bulletList: { group: 'block', content: 'listItem+' },
      orderedList: {
        group: 'block',
        content: 'listItem+',
        attrs: { start: { default: 1 } },
      },
      listItem: { content: 'paragraph block*' },
      codeBlock: {
        group: 'block',
        content: 'text*',
        marks: '',
        code: true,
        attrs: { language: { default: null } },
      },
      horizontalRule: { group: 'block' },
      hardBreak: { group: 'inline', inline: true },
      text: { group: 'inline' },
    },
    marks: {
      link: { attrs: { href: {} }, inclusive: false },
      italic: {},
      bold: {},
      strike: {},
      code: {},
    },
  });
  const source =
    '# Title\n\n- **bold** and *italic*\n- ~~gone~~ `code`\n\n3. [a link](https://x.y)\n\n' +
    '```js\nlet x\n```\n\n> quoted\n\n---';
  const codec = markdownCodec(tiptap);
  const d = codec.parse(source);
  d.check();
  assert.deepStrictEqual(
    [d.child(1).type.name, d.child(2).attrs.start, d.child(3).attrs.language],
    ['bulletList', 3, 'js'],
  );
  assert.ok(
    tiptap.marks.bold.isInSet(
      d.child(1).firstChild!.firstChild!.firstChild!.marks,
    ),
  );
  assert.strictEqual(codec.serialize(d), source);
});

// --- the clipboard -----------------------------------------------------------------

function clipboardView(state: EditorState): ClipboardView {
  return {
    state,
    someProp: () => undefined,
    asEditorView: {} as EditorView,
  };
}

test('the clipboard: a copy says where it was cut, and a paste puts it back whole', () => {
  const d = docFromMarkdown(schema, '- one\n- two\n\npara');
  const state = EditorState.create({ doc: d });
  // from after the "o" of "one" to before the last "a" of "para": open at
  // both ends
  const from = 4;
  const to = d.content.size - 2;
  const slice = d.slice(from, to);
  const out = serializeForClipboard(clipboardView(state), slice);
  assert.match(out.html, /data-pm-slice="\d+ \d+ /);
  assert.strictEqual(out.text, 'ne\n\ntwo\n\npar');

  const target = EditorState.create({ doc: doc(p('x')) });
  const back = parseFromClipboard(
    clipboardView(target),
    out.text,
    out.html,
    false,
    target.doc.resolve(1),
  )!;
  assert.strictEqual(back.openStart, slice.openStart);
  assert.strictEqual(back.openEnd, slice.openEnd);
  assert.ok(back.content.eq(slice.content));
});

test('the clipboard: plain text is a paragraph per line, and verbatim in code', () => {
  const state = EditorState.create({
    doc: doc(p('x'), N.code_block.create(null, schema.text('c'))),
  });
  const text = parseFromClipboard(
    clipboardView(state),
    'a\nb',
    null,
    true,
    state.doc.resolve(1),
  )!;
  assert.deepStrictEqual(
    (text.content.toJSON() as { content: { text: string }[] }[]).map(
      (b) => b.content[0].text,
    ),
    ['a', 'b'],
  );
  const inCode = parseFromClipboard(
    clipboardView(state),
    'a\n  b',
    '<p>ignored</p>',
    false,
    state.doc.resolve(5),
  )!;
  assert.ok(inCode.content.eq(Fragment.from(schema.text('a\n  b'))));
  assert.ok(inCode instanceof Slice);
});

// --- keys ----------------------------------------------------------------------------

test('keys: a chord is named by its Latin key, whatever the layout typed', () => {
  // Ctrl+B under a Russian layout: the key produced и, the keysym is still b
  const ev = toDomKeyEvent(
    {
      keysym: 0x62,
      key: 'и',
      codepoint: 0x438,
      shiftKey: false,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
    },
    'ctrl',
  );
  assert.strictEqual(ev.key, 'b');
  assert.strictEqual(ev.keyCode, 66);
  const typed = toDomKeyEvent(
    {
      keysym: 0x62,
      key: 'и',
      codepoint: 0x438,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    },
    'ctrl',
  );
  assert.strictEqual(
    typed.key,
    'и',
    'with no modifier, the key is what was typed',
  );
  const tab = toDomKeyEvent(
    {
      keysym: 0xfe20,
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    },
    'ctrl',
  );
  assert.deepStrictEqual([tab.key, tab.shiftKey], ['Tab', true]);
});

test("keys: the backend's primary modifier is prosemirror-keymap's Mod, on any host", () => {
  let fired = 0;
  const handler = keydownHandler({ 'Mod-b': () => ((fired += 1), true) });
  const view = {
    state: EditorState.create({ schema }),
    dispatch: () => {},
  } as unknown as EditorView;
  const press = (
    mods: { ctrlKey?: boolean; metaKey?: boolean },
    primary: 'ctrl' | 'meta',
  ) =>
    handler(
      view,
      toDomKeyEvent(
        {
          keysym: 0x62,
          key: 'b',
          shiftKey: false,
          altKey: false,
          ctrlKey: !!mods.ctrlKey,
          metaKey: !!mods.metaKey,
        },
        primary,
      ) as unknown as KeyboardEvent,
    );
  assert.ok(press({ ctrlKey: true }, 'ctrl'), 'X11: Ctrl+B');
  assert.ok(press({ metaKey: true }, 'meta'), 'macOS: Cmd+B');
  assert.ok(!press({ metaKey: true }, 'ctrl'), 'X11: Super+B is not Mod-b');
  assert.strictEqual(fired, 2);
  void TextSelection;
});
