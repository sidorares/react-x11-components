// <Html> — segment breaks (CSS Text 3, 4.1.2): a line break in collapsible
// white space is a space, but for one beside a zero width space, or between
// two characters that are both East Asian full-width, wide or half-width
// and not Hangul, which goes. WPT's
// `css/css-text/line-breaking/segment-break-transformation-*` hold the rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup } from 'react-x11/test';

import { render, view } from './harness.js';

afterEach(cleanup);

test('a segment break between Chinese or Japanese characters is no space', async () => {
  const { node } = await render(
    '<p>一些\n中文</p>' +
      '<p>一些 \n  中文</p>' +
      '<p>ＡＢ\nﾃｽﾄ</p>' +
      '<p>abc\n中文</p>' +
      '<p>테스트\n테스트</p>' +
      '<p>中文\n테스트</p>' +
      '<p>一些\u200b\n中文</p>' +
      '<p>ab\n\u200bcd</p>' +
      '<p style="white-space:pre-line">一些\n中文</p>',
  );
  const text = view(node).textContent();
  for (const want of [
    '一些中文',
    'ＡＢﾃｽﾄ',
    'abc 中文',
    '테스트 테스트',
    '中文 테스트',
    '一些\u200b中文',
    'ab\u200bcd',
    '一些\n中文',
  ]) {
    assert.ok(
      text.includes(want),
      `${JSON.stringify(want)} in ${JSON.stringify(text)}`,
    );
  }
  // the first two paragraphs both lose theirs
  assert.equal(text.split('一些中文').length - 1, 2, JSON.stringify(text));
});
