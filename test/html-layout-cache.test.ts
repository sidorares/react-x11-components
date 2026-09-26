// `<Html>`'s text layout cache (`TextLayoutCache`) against an engine that
// counts what it is asked. A layout is filed under its width and text and
// found by comparing everything else it was made from, so what matters is
// that equal inputs find it — as new objects, the way a re-parse hands them
// over — and that any difference at all does not.
import { test } from 'node:test';
import assert from 'node:assert';

import type { TextRun } from '../src/richtext/index.js';
import { TextLayoutCache } from '../src/html/layout/cache.js';
import type { TextLayoutLike } from '../src/html/layout/boxes.js';
import type { FontsLike } from '../src/html/layout/inline.js';

type Options = Parameters<FontsLike['layout']>[2];

/** An engine whose every layout is a new object, and which counts them. */
function countingEngine(): FontsLike & { made: number } {
  const engine = {
    made: 0,
    layout(): TextLayoutLike {
      engine.made += 1;
      return { made: engine.made } as unknown as TextLayoutLike;
    },
    match(): ReturnType<FontsLike['match']> {
      return {
        metrics: () => ({ ascent: 10, descent: 3, lineHeight: 16 }),
      };
    },
  };
  return engine;
}

const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({
  text,
  family: 'sans-serif',
  size: 14,
  weight: 400,
  style: 'normal',
  color: '#1d1d1f',
  ...extra,
});
const base = (): Record<string, unknown> => ({
  family: 'sans-serif',
  size: 14,
  color: '#1d1d1f',
});
const options = (extra: Partial<Options> = {}): Options => ({
  maxWidth: 400,
  lineHeight: 1.4,
  align: 'start',
  direction: 'ltr',
  ...extra,
});

test('equal inputs, as new objects, find the layout the pass before made', () => {
  const engine = countingEngine();
  const cache = new TextLayoutCache(engine);
  cache.begin();
  const first = cache.fonts.layout(
    [run('A paragraph, '), run('with a bold word', { weight: 700 })],
    base(),
    options(),
  );
  cache.begin();
  const again = cache.fonts.layout(
    [run('A paragraph, '), run('with a bold word', { weight: 700 })],
    base(),
    options(),
  );
  assert.strictEqual(again, first);
  assert.strictEqual(engine.made, 1);
});

test('a field that differs anywhere is a different layout', () => {
  const engine = countingEngine();
  const cache = new TextLayoutCache(engine);
  cache.begin();
  const layout = (content: TextRun[], style = base(), opts = options()) =>
    cache.fonts.layout(content, style, opts);
  const plain = layout([run('Some text')]);
  const variants: [string, () => TextLayoutLike][] = [
    ['a run field', () => layout([run('Some text', { weight: 700 })])],
    [
      'a run field added',
      () => layout([run('Some text', { underline: '#f00' })]),
    ],
    [
      'a run field present but undefined',
      () => layout([run('Some text', { underline: undefined })]),
    ],
    [
      'one undefined field for another',
      () => layout([run('Some text', { strike: undefined })]),
    ],
    ['the same text in two runs', () => layout([run('Some '), run('text')])],
    [
      'the block style',
      () => layout([run('Some text')], { ...base(), size: 15 }),
    ],
    [
      'a block style field added',
      () => layout([run('Some text')], { ...base(), weight: 700 }),
    ],
    [
      'the width',
      () => layout([run('Some text')], base(), options({ maxWidth: 401 })),
    ],
    [
      'the line height',
      () => layout([run('Some text')], base(), options({ lineHeight: 1.5 })),
    ],
    [
      'an option added',
      () => layout([run('Some text')], base(), options({ maxLines: 1 })),
    ],
  ];
  const seen = new Set([plain]);
  for (const [what, ask] of variants) {
    const got = ask();
    assert.ok(!seen.has(got), `${what} found another layout`);
    seen.add(got);
  }
  assert.strictEqual(engine.made, 1 + variants.length);
  // and every one of them is found again, beside the others
  cache.begin();
  const made = engine.made;
  assert.strictEqual(layout([run('Some text')]), plain);
  for (const [, ask] of variants) ask();
  assert.strictEqual(engine.made, made, 'all of them kept');
});

test('a field order is not a difference', () => {
  const engine = countingEngine();
  const cache = new TextLayoutCache(engine);
  cache.begin();
  const first = cache.fonts.layout([run('Text')], base(), options());
  const { text, ...paint } = run('Text');
  const reordered = { ...paint, text } as TextRun;
  assert.strictEqual(cache.fonts.layout([reordered], base(), options()), first);
});

test('what is done to the inputs afterwards does not change what finds a layout', () => {
  const engine = countingEngine();
  const cache = new TextLayoutCache(engine);
  cache.begin();
  const content = [run('Mutable')];
  const style = base();
  const opts = options();
  const first = cache.fonts.layout(content, style, opts);
  content[0].weight = 700;
  style.size = 20;
  opts.maxWidth = 10;
  content.push(run(' and more'));
  cache.begin();
  assert.strictEqual(
    cache.fonts.layout([run('Mutable')], base(), options()),
    first,
    'the inputs as they were asked',
  );
  assert.strictEqual(engine.made, 1);
});

test('two passes without it, and a layout is gone', () => {
  const engine = countingEngine();
  const cache = new TextLayoutCache(engine);
  cache.begin();
  const first = cache.fonts.layout([run('Once')], base(), options());
  cache.begin();
  cache.begin();
  assert.notStrictEqual(
    cache.fonts.layout([run('Once')], base(), options()),
    first,
  );
  assert.strictEqual(engine.made, 2);
});
