// The Markdown parser resuming from a previous parse (`ParseOptions.previous`):
// whatever the edit, the answer is the one a parse from scratch gives. The
// random edits below lean on the lines where a block's extent is decided —
// blank lines, list markers, fences, setext underlines, quotes, tables —
// since those are what a resumed parse could get wrong.
import { test } from 'node:test';
import assert from 'node:assert';

import { parseMarkdown } from '../src/index.js';
import type { MarkdownDocument } from '../src/index.js';

/** A small seeded generator, so a failure names a case that can be rerun. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

const PIECES = [
  '\n',
  '\n\n',
  '\n\n\n',
  '```\n',
  '```js\n',
  '~~~\n',
  '- ',
  '* ',
  '1. ',
  '2) ',
  '> ',
  '# ',
  '## ',
  '===\n',
  '---\n',
  '***\n',
  '    ',
  '\t',
  '| a | b |\n| - | - |\n',
  '| c | d |\n',
  '**',
  '`',
  '[x](y)',
  '- [ ] ',
  'word ',
  'more words here ',
  '  ',
  '\r\n',
];

const SEED_DOC = [
  '# Title',
  '',
  'A paragraph with *emphasis*, `code` and a [link](http://x).',
  'It goes on for a second line.',
  '',
  '- one',
  '- two',
  '',
  '  still two',
  '- three',
  '',
  '1. first',
  '2. second',
  '',
  '> a quote',
  'lazy line',
  '',
  '```js',
  'const x = 1;',
  '',
  'const y = 2;',
  '```',
  '',
  '| a | b |',
  '| - | :-: |',
  '| 1 | 2 |',
  '',
  'Setext heading',
  '---',
  '',
  '    indented code',
  '',
  '***',
  '',
  'Last paragraph.',
].join('\n');

function edit(src: string, rand: () => number): string {
  const at = Math.floor(rand() * (src.length + 1));
  const kind = rand();
  if (kind < 0.45) {
    const piece = PIECES[Math.floor(rand() * PIECES.length)];
    return src.slice(0, at) + piece + src.slice(at);
  }
  if (kind < 0.8) {
    const len = 1 + Math.floor(rand() * 12);
    return src.slice(0, at) + src.slice(at + len);
  }
  const len = 1 + Math.floor(rand() * 8);
  const piece = PIECES[Math.floor(rand() * PIECES.length)];
  return src.slice(0, at) + piece + src.slice(at + len);
}

const plain = (doc: MarkdownDocument) => ({
  blocks: doc.blocks,
  raws: doc.raws,
});

for (const partial of [false, true]) {
  test(`a resumed parse is a parse from scratch (partial: ${partial})`, () => {
    let failures = 0;
    for (let run = 0; run < 60; run += 1) {
      const rand = rng(1000 * (partial ? 2 : 1) + run);
      let src = SEED_DOC;
      let doc = parseMarkdown(src, { partial });
      for (let step = 0; step < 60; step += 1) {
        const next = edit(src, rand);
        const resumed = parseMarkdown(next, { partial, previous: doc });
        const fresh = parseMarkdown(next, { partial });
        try {
          assert.deepStrictEqual(plain(resumed), plain(fresh));
        } catch (error) {
          failures += 1;
          if (failures === 1) {
            assert.fail(
              `run ${run} step ${step}: resumed differs from scratch\n` +
                `before: ${JSON.stringify(src)}\nafter: ${JSON.stringify(next)}\n` +
                String(error),
            );
          }
        }
        src = next;
        doc = resumed;
      }
    }
  });
}

test('a streamed document resumes chunk by chunk', () => {
  for (let run = 0; run < 40; run += 1) {
    const rand = rng(7000 + run);
    const whole = SEED_DOC + '\n\n' + SEED_DOC;
    let upto = 0;
    let doc = parseMarkdown('', { partial: true });
    while (upto < whole.length) {
      upto = Math.min(whole.length, upto + 1 + Math.floor(rand() * 40));
      const src = whole.slice(0, upto);
      const resumed = parseMarkdown(src, { partial: true, previous: doc });
      assert.deepStrictEqual(
        plain(resumed),
        plain(parseMarkdown(src, { partial: true })),
        `run ${run} at ${upto}`,
      );
      doc = resumed;
    }
    // …and the stream ending is an edit like any other
    const done = parseMarkdown(whole, { partial: false, previous: doc });
    assert.deepStrictEqual(
      plain(done),
      plain(parseMarkdown(whole, { partial: false })),
    );
  }
});

test('an edit to one paragraph parses that paragraph and keeps the rest', () => {
  const paras = Array.from(
    { length: 200 },
    (_, i) => `Paragraph ${i} with *some* words.`,
  );
  const before = parseMarkdown(paras.join('\n\n'), { partial: false });
  const edited = paras.slice();
  edited[100] = 'Paragraph 100, edited.';
  const after = parseMarkdown(edited.join('\n\n'), {
    partial: false,
    previous: before,
  });
  assert.strictEqual(after.blocks.length, 200);
  let same = 0;
  for (let i = 0; i < 200; i += 1) {
    if (after.blocks[i] === before.blocks[i]) same += 1;
  }
  // the edited paragraph and the one before it are parsed again
  assert.ok(same >= 197, `kept ${same} of 200 blocks as they were`);
  assert.notStrictEqual(after.blocks[100], before.blocks[100]);
  assert.strictEqual(after.raws[100], 'Paragraph 100, edited.');
  // the same source again is the same document
  assert.strictEqual(
    parseMarkdown(edited.join('\n\n'), { partial: false, previous: after }),
    after,
  );
});

test('a fence opened mid-document swallows the rest, resumed or not', () => {
  const src = 'a\n\nb\n\nc\n\nd';
  const doc = parseMarkdown(src, { partial: false });
  const next = 'a\n\n```\nb\n\nc\n\nd';
  const resumed = parseMarkdown(next, { partial: false, previous: doc });
  assert.deepStrictEqual(
    plain(resumed),
    plain(parseMarkdown(next, { partial: false })),
  );
  assert.strictEqual(resumed.blocks.length, 2);
  assert.strictEqual(resumed.blocks[1].type, 'code');
});

test('a previous parse under other options is not resumed from', () => {
  const doc = parseMarkdown('**a', { partial: true });
  const next = parseMarkdown('**a', { partial: false, previous: doc });
  assert.deepStrictEqual(
    plain(next),
    plain(parseMarkdown('**a', { partial: false })),
  );
  assert.notStrictEqual(next, doc);
});

test('with components the whole document is parsed again', () => {
  // An open tag looks for its close as far as the end of the document, so a
  // close added far below changes a block well before the edit.
  const isComponent = (name: string) => name === 'Card';
  const top = '<Card>\n\nInside.\n\n';
  const filler = Array.from({ length: 20 }, (_, i) => `Filler ${i}.`).join(
    '\n\n',
  );
  const before = parseMarkdown(top + filler, { partial: false, isComponent });
  assert.notStrictEqual(before.blocks[0].type, 'component');
  const next = top + filler + '\n\n</Card>';
  const after = parseMarkdown(next, {
    partial: false,
    isComponent,
    previous: before,
  });
  assert.deepStrictEqual(
    plain(after),
    plain(parseMarkdown(next, { partial: false, isComponent })),
  );
  assert.strictEqual(after.blocks[0].type, 'component');
});
