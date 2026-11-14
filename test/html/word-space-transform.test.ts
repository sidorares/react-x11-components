// <Html> — `word-space-transform` (CSS Text 4, 2.2): a zero width space and
// a `<wbr>` set as a space or an ideographic space, after the white space
// collapses and before `text-transform`. WPT's
// `css/css-text/word-space-transform/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup } from 'react-x11/test';

import { boxOf, findById, metric, render, view } from './harness.js';

afterEach(cleanup);

test('word-space-transform reads back as written, and is inherited', async () => {
  const { node } = await render(
    '<div id="a" style="word-space-transform:auto-phrase space"><p id="b"></p></div>' +
      '<div id="c" style="word-space-transform:ideographic-space;word-space-transform:auto-phrase"></div>' +
      '<div id="d" style="word-space-transform:space ideographic-space"></div>',
  );
  const el = view(node);
  const read = (id: string) =>
    el.computedStyle(findById(el.document, id)!)!['word-space-transform'];
  assert.equal(read('a'), 'auto-phrase space');
  assert.equal(read('b'), 'auto-phrase space', 'inherited');
  assert.equal(read('c'), 'ideographic-space', 'auto-phrase alone is no value');
  assert.equal(read('d'), 'none', 'two spaces are no value');
});

test('a zero width space and a <wbr> become the separator, but where it is turned off or next to a line feed', async () => {
  const { node } = await render(
    '<style>wbr.off{word-space-transform:none}</style>' +
      '<p style="word-space-transform:ideographic-space">A<wbr>B\u200bC</p>' +
      '<p style="word-space-transform:space">D<wbr>E\u200bF</p>' +
      '<p style="word-space-transform:space">G<wbr class="off">H</p>' +
      '<p style="word-space-transform:space;text-transform:full-width">I\u200bJ</p>' +
      '<p style="word-space-transform:space;white-space:pre">K\u200b\nL</p>',
  );
  const text = view(node).textContent();
  for (const want of [
    'A\u3000B\u3000C',
    'D E F',
    'G\u200bH',
    // the space expanded before full-width, which makes it ideographic
    '\uff29\u3000\uff2a',
    // and a zero width space next to a kept line feed stays as it is
    'K\u200b\nL',
  ]) {
    assert.ok(
      text.includes(want),
      `${JSON.stringify(want)} in ${JSON.stringify(text)}`,
    );
  }
});

metric(
  'a <wbr> is a place a line may break, whatever its display',
  async () => {
    const { node } = await render(
      '<style>body{margin:0} div{font:20px/1 monospace;width:3ch;margin:0}</style>' +
        '<div id="a">AA<wbr>BB</div>' +
        '<div id="b">AA<wbr style="display:block">BB</div>' +
        '<div id="c">AABB</div>',
    );
    const el = view(node);
    const lines = (id: string) =>
      (boxOf(el, id) as unknown as { lines: unknown[] }).lines.length;
    assert.equal(lines('a'), 2);
    assert.equal(lines('b'), 2, 'and no block');
    assert.equal(lines('c'), 1, 'where there is none, the word overflows');
  },
);
