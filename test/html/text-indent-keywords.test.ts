// <Html> — `text-indent`'s `hanging` and `each-line` (CSS Text 3, 7.1):
// every line but those that would be indented, and a line after a forced
// break or a block-level box indented as the first is. WPT's
// `css/css-text/text-indent/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup } from 'react-x11/test';

import { findById, metric, render, view } from './harness.js';

afterEach(cleanup);

test('text-indent reads back with its keywords after its length, and refuses one twice', async () => {
  const { node } = await render(
    '<div id="a" style="text-indent:each-line hanging 10px"><p id="b"></p></div>' +
      '<div id="c" style="text-indent:20px;text-indent:hanging 5px hanging"></div>' +
      '<div id="d" style="text-indent:each-line"></div>',
  );
  const el = view(node);
  const read = (id: string) =>
    el.computedStyle(findById(el.document, id)!)!['text-indent'];
  assert.equal(read('a'), '10px hanging each-line');
  assert.equal(read('b'), '10px hanging each-line', 'inherited');
  assert.equal(read('c'), '20px', 'hanging twice is no value');
  assert.equal(read('d'), '0px', 'nor a keyword alone');
});

metric(
  'hanging indents every line but the first, and each-line those after a forced break',
  async () => {
    const words = (id: string) =>
      `<span id="${id}a">aaaa</span> <span id="${id}b">bbbb</span><br><span id="${id}c">cccc</span>`;
    const { node } = await render(
      '<style>body{margin:0} div{font:10px/1 monospace;width:8ch}</style>' +
        '<div style="text-indent:4ch">' +
        words('n') +
        '</div>' +
        '<div style="text-indent:4ch each-line">' +
        words('e') +
        '</div>' +
        '<div style="text-indent:4ch hanging">' +
        words('h') +
        '</div>' +
        '<div style="text-indent:4ch hanging each-line">' +
        words('x') +
        '</div>' +
        '<span id="ch" style="font:10px monospace">a</span>',
    );
    const el = view(node);
    const ch = el.elementRect(findById(el.document, 'ch')!)!.width;
    // where each of the three lines starts, in characters: aaaa, then bbbb
    // soft-wrapped, then cccc after the <br>
    const starts = (id: string) =>
      ['a', 'b', 'c'].map((w) =>
        Math.round(el.elementRect(findById(el.document, id + w)!)!.x / ch),
      );
    assert.deepEqual(starts('n'), [4, 0, 0]);
    assert.deepEqual(starts('e'), [4, 0, 4]);
    assert.deepEqual(starts('h'), [0, 4, 4]);
    assert.deepEqual(starts('x'), [0, 4, 0]);
  },
);
