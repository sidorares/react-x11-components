// <Html> — `text-autospace` and `text-autospace-size` (CSS Text 4, 6.4):
// room between an ideograph and a letter or a numeral of another script.
// WPT's `css/css-text/text-autospace/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup } from 'react-x11/test';

import { findById, metric, render, view } from './harness.js';

afterEach(cleanup);

test('text-autospace and its size read back as they compute, and are inherited', async () => {
  const { node } = await render(
    '<div id="a" style="text-autospace:insert punctuation ideograph-alpha;text-autospace-size:0.25"><p id="b"></p></div>' +
      '<div id="c" style="text-autospace:no-autospace;text-autospace:normal ideograph-alpha"></div>' +
      '<div id="d" style="text-autospace:auto"></div>',
  );
  const el = view(node);
  const read = (id: string, name: string) =>
    el.computedStyle(findById(el.document, id)!)![name];
  assert.equal(
    read('a', 'text-autospace'),
    'ideograph-alpha punctuation insert',
  );
  assert.equal(read('a', 'text-autospace-size'), '0.25');
  assert.equal(
    read('b', 'text-autospace'),
    'ideograph-alpha punctuation insert',
  );
  assert.equal(read('b', 'text-autospace-size'), '0.25', 'inherited');
  assert.equal(
    read('c', 'text-autospace'),
    'no-autospace',
    'normal and a class is no value',
  );
  assert.equal(read('d', 'text-autospace'), 'auto');
});

metric(
  'an eighth of an em goes between an ideograph and a letter or a numeral, and nowhere else',
  async () => {
    const { node } = await render(
      '<style>body{margin:0} p{font:40px/1 monospace;margin:0}</style>' +
        '<p>国<span id="on">X</span></p>' +
        '<p style="text-autospace:no-autospace">国<span id="off">X</span></p>' +
        '<p>X<span id="after">国</span></p>' +
        '<p style="text-autospace:ideograph-alpha">国<span id="digit">1</span></p>' +
        '<p style="text-autospace:ideograph-numeric">国<span id="num">1</span></p>' +
        '<p style="text-autospace-size:0.5">国<span id="half">X</span></p>' +
        '<p>。<span id="punct">X</span></p>' +
        '<p style="text-autospace:no-autospace">。<span id="punct-off">X</span></p>',
    );
    const el = view(node);
    await act();
    const x = (id: string) => el.elementRect(findById(el.document, id)!)!.x;
    const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
    assert.ok(near(x('on') - x('off'), 5), `${x('on')} - ${x('off')}`);
    // and after a letter, before the ideograph
    const letter = el.elementRect(findById(el.document, 'off')!)!.width;
    assert.ok(near(x('after'), letter + 5), `${x('after')} for ${letter + 5}`);
    // a class not asked for gets none
    assert.ok(near(x('digit'), x('off')), `${x('digit')}`);
    assert.ok(near(x('num'), x('on')), `${x('num')}`);
    assert.ok(near(x('half') - x('off'), 20), `${x('half')}`);
    // punctuation is no ideograph
    assert.ok(near(x('punct'), x('punct-off')), `${x('punct')}`);
  },
);

metric(
  "a ::first-line's text is spaced in the line's ems, not the block's",
  async () => {
    // the room is an eighth of the size of the text before the boundary,
    // which on the first line is the pseudo-element's (WPT's
    // text-autospace-first-line-001)
    const { node } = await render(
      '<style>.t{font-size:40px;text-autospace:normal}' +
        '#a::first-line{font-size:200%}#b{font-size:80px}</style>' +
        '<div id="a" class="t">国国XX国<br>国</div>' +
        '<div id="b" class="t">国国XX国</div>',
      1000,
    );
    const el = view(node);
    const a = el.textCaretRect(4)!.x;
    // the second block starts six characters further into the document
    const b = el.textCaretRect(11)!.x;
    assert.ok(Math.abs(a - b) < 0.5, `${a} where ${b}`);
  },
);
