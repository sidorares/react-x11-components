// <Html> — `text-box-trim`, `text-box-edge` and `text-box` (CSS Inline 3,
// 5): a block container's first and last formatted lines trimmed to their
// text, a capital or an x, or the baseline. WPT's
// `css/css-inline/text-box-trim/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup } from 'react-x11/test';

import { findById, metric, render, view } from './harness.js';

afterEach(cleanup);

test('text-box-trim, text-box-edge and text-box read back as they compute', async () => {
  const { node } = await render(
    '<div id="a" style="text-box:trim-start cap alphabetic"><p id="b"></p></div>' +
      '<div id="c" style="text-box:ex"></div>' +
      '<div id="d" style="text-box:normal"></div>' +
      '<div id="e" style="text-box-trim:trim-end;text-box-edge:text text"></div>' +
      '<div id="f" style="text-box:trim-both;text-box:cap trim-end trim-end"></div>',
  );
  const el = view(node);
  const read = (id: string, name: string) =>
    el.computedStyle(findById(el.document, id)!)![name];
  assert.equal(read('a', 'text-box-trim'), 'trim-start');
  assert.equal(read('a', 'text-box-edge'), 'cap alphabetic');
  assert.equal(read('a', 'text-box'), 'trim-start cap alphabetic');
  assert.equal(read('b', 'text-box-trim'), 'none', 'no trim inherited');
  assert.equal(read('b', 'text-box-edge'), 'cap alphabetic', 'an edge is');
  assert.equal(read('c', 'text-box'), 'ex', 'trim-both, left out');
  assert.equal(read('c', 'text-box-trim'), 'trim-both');
  assert.equal(read('d', 'text-box'), 'normal');
  assert.equal(read('e', 'text-box-edge'), 'text', 'one where one says both');
  assert.equal(read('e', 'text-box'), 'trim-end text', 'text is no auto');
  assert.equal(read('f', 'text-box'), 'trim-both', 'a trim twice is no value');
});

metric(
  'a block is trimmed to its text at the sides it names, and what follows it moves up',
  async () => {
    const { node } = await render(
      '<style>body{margin:0} div,p{font:20px/2 monospace;margin:0}</style>' +
        '<div id="plain">x</div>' +
        '<div id="both" style="text-box-trim:trim-both">x</div>' +
        '<div id="start" style="text-box-trim:trim-start">x</div>' +
        '<div id="end" style="text-box-trim:trim-end">x</div>' +
        '<div id="nested" style="text-box-trim:trim-both"><p>x</p></div>' +
        '<div id="held" style="text-box-trim:trim-both"><p style="padding:1px 0">x</p></div>' +
        '<div id="spaced" style="text-box-trim:trim-both">\n  <p>x</p>\n</div>' +
        '<div id="blocked" style="text-box-trim:trim-both"><div></div><p>x</p></div>' +
        '<div id="after">x</div>',
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const line = rect('plain').height;
    assert.ok(Math.abs(line - 40) < 0.5, `a 40px line: ${line}`);
    const both = rect('both').height;
    // the half leading off each side, so the face's ascent and descent
    assert.ok(both > 18 && both < 30, `both sides trimmed: ${both}`);
    const half = (line - both) / 2;
    const start = rect('start').height;
    const end = rect('end').height;
    assert.ok(start < line && end < line, `${start}, ${end} under ${line}`);
    assert.ok(
      Math.abs(start + end - (line + both)) < 1,
      `each side alone: ${start} + ${end} = ${line} + ${both}`,
    );
    assert.ok(half > 0, `${half}`);
    // a line in a block in it is its first and last formatted line
    assert.ok(
      Math.abs(rect('nested').height - both) < 0.5,
      `nested: ${rect('nested').height}`,
    );
    // and so is one with white space around it, which makes no box
    assert.ok(
      Math.abs(rect('spaced').height - both) < 0.5,
      `spaced: ${rect('spaced').height}`,
    );
    // padding between the box and its line holds both sides
    assert.ok(
      Math.abs(rect('held').height - (line + 2)) < 0.5,
      `held: ${rect('held').height}`,
    );
    // an empty block first is where the first line would be, and holds
    // the top: only the last line is trimmed
    assert.ok(
      Math.abs(rect('blocked').height - end) < 0.5,
      `blocked: ${rect('blocked').height} for ${end}`,
    );
    // and what comes after is where the trimmed boxes end
    const after = rect('after');
    const blocked = rect('blocked');
    assert.ok(Math.abs(after.y - (blocked.y + blocked.height)) < 0.5);
  },
);

metric(
  'cap and alphabetic trim a line to its capitals and its baseline',
  async () => {
    const { node } = await render(
      '<style>body{margin:0} div{font:20px/2 monospace;margin:0}</style>' +
        '<div id="text" style="text-box:trim-both text">X</div>' +
        '<div id="cap" style="text-box:trim-both cap alphabetic">X</div>',
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const text = rect('text').height;
    const cap = rect('cap').height;
    // a capital is shorter than the face's ascent, and nothing goes below
    // the baseline
    assert.ok(cap > 8 && cap < 20, `a capital's height: ${cap}`);
    assert.ok(cap < text, `${cap} under ${text}`);
  },
);
