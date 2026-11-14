// <Html> — `text-transform` beyond its case keywords (CSS Text 3, 2.1):
// `full-width` and `full-size-kana`, alone or with a case, in the one order
// the value computes to, and a case transform tailored for the language
// its text is in. WPT's `css/css-text/text-transform/` and
// `css/css-text/parsing/text-transform-*` hold the rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup } from 'react-x11/test';

import { findById, render, view } from './harness.js';

afterEach(cleanup);

test('text-transform reads back with its keywords in one order, and refuses one twice', async () => {
  const { node } = await render(
    '<p id="a" style="text-transform:full-size-kana lowercase full-width"></p>' +
      '<p id="b" style="text-transform:full-width"></p>' +
      '<p id="c" style="text-transform:math-auto"></p>' +
      '<p id="d" style="text-transform:uppercase;text-transform:uppercase full-width uppercase"></p>' +
      '<p id="e" style="text-transform:capitalize;text-transform:none math-auto"></p>',
  );
  const el = view(node);
  const read = (id: string) =>
    el.computedStyle(findById(el.document, id)!)!['text-transform'];
  assert.equal(read('a'), 'lowercase full-width full-size-kana');
  assert.equal(read('b'), 'full-width');
  assert.equal(read('c'), 'math-auto');
  assert.equal(read('d'), 'uppercase', 'a case twice is no value');
  assert.equal(read('e'), 'capitalize', 'none with another is no value');
});

test('full-width and full-size-kana set the text as their forms, after its case', async () => {
  const { node } = await render(
    '<p style="text-transform:uppercase full-width">Hi, you</p>' +
      '<p style="text-transform:full-size-kana">ァィゥ ㇰㇱ ｧｨ</p>' +
      '<p style="text-transform:full-width">ｶﾞ ¢</p>' +
      '<p style="text-transform:lowercase full-width full-size-kana">AB ぁっ</p>',
  );
  const text = view(node).textContent();
  for (const want of [
    // a space is an ideographic space
    'ＨＩ，\u3000ＹＯＵ',
    // a small kana the full-size one, and a half-width small kana a
    // half-width full-size one
    'アイウ クシ ｱｲ',
    // a half-width voiced mark is the combining one
    'カ\u3099\u3000￠',
    'ａｂ\u3000あつ',
  ]) {
    assert.ok(text.includes(want), `${want} in ${JSON.stringify(text)}`);
  }
});

test('a case transform is the language’s: Dutch ij, Turkish i, Greek tonos, and none in another script', async () => {
  const { node } = await render(
    '<p lang="nl" style="text-transform:capitalize">ijsland Ijmuiden</p>' +
      '<p lang="en" style="text-transform:capitalize">ijsland</p>' +
      '<p lang="tr" style="text-transform:uppercase">istanbul</p>' +
      '<div lang="tr"><p style="text-transform:capitalize">izmir</p></div>' +
      '<p lang="el" style="text-transform:uppercase">καλημέρα ή εσύ</p>' +
      '<p lang="tr-Cyrl" style="text-transform:lowercase">IСТАН</p>',
  );
  const text = view(node).textContent();
  for (const want of [
    'IJsland IJmuiden',
    'Ijsland',
    'İSTANBUL',
    'İzmir',
    // capitals with no tonos, but for a disjunctive eta
    'ΚΑΛΗΜΕΡΑ Ή ΕΣΥ',
    // Turkish in Cyrillic is cased as nobody's: its I is a dotted i
    'iстан',
  ]) {
    assert.ok(text.includes(want), `${want} in ${JSON.stringify(text)}`);
  }
});
