// <Html> — where an absolutely positioned box is set by its self-alignment,
// or by the alignment its flex box or its grid would give it as its one
// item. Every number is Chrome's, Firefox's and Safari's (WPT's
// css-align/abspos, css-grid/alignment and css-flexbox/abspos).
import { afterEach } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import { findById, metric, render, view } from './harness.js';

afterEach(cleanup);

/** Each element's offset from its offset parent, by id. */
async function offsets(source: string, ids: string[]) {
  const { node } = await render(source, 600);
  const el = view(node);
  return Object.fromEntries(
    ids.map((id) => {
      const r = el.offsetRect(findById(el.document, id)!);
      assert.ok(r, `#${id} has a rect`);
      return [id, [r.x, r.y]];
    }),
  );
}

metric(
  "a flex box's positioned child is where its one item would be",
  async () => {
    // CSS Flexbox 1, 4.1: by `justify-content` and its `align-self`, with
    // `flex-start` the lines' side, which `wrap-reverse` turns, and `start`
    // and a baseline the writing mode's, which it does not; `space-around`
    // as `center`; `left` and `right` the start along a column
    const c = (style: string, id: string, own = '') =>
      `<div class="c" style="${style}"><div id="${id}" style="${own}"></div></div>`;
    const at = await offsets(
      '<style>body{margin:0}' +
        '.c{display:flex;position:relative;width:16px;height:10px;' +
        'padding:1px 2px;border:1px solid;float:left;margin-right:5px}' +
        '.c>div{position:absolute;width:8px;height:6px}</style>' +
        c('flex-wrap:wrap-reverse', 'wr') +
        c('flex-wrap:wrap-reverse', 'wrb', 'align-self:baseline') +
        c('flex-wrap:wrap-reverse', 'wrs', 'align-self:start') +
        c('justify-content:space-around', 'sa') +
        c('flex-direction:column;justify-content:right', 'cr') +
        c('flex-direction:row-reverse;justify-content:space-between', 'rr') +
        c('', 'sf', 'align-self:safe center;height:20px') +
        c('', 'uf', 'align-self:center;height:20px') +
        c('flex-direction:row-reverse;justify-content:flow-end', 'fe'),
      ['wr', 'wrb', 'wrs', 'sa', 'cr', 'rr', 'sf', 'uf', 'fe'],
    );
    assert.deepStrictEqual(at.wr, [2, 5], 'flex-start is at the bottom');
    assert.deepStrictEqual(at.wrb, [2, 1], 'a baseline is at the top');
    assert.deepStrictEqual(at.wrs, [2, 1], 'start is at the top');
    assert.deepStrictEqual(at.sa, [6, 1], 'centred');
    assert.deepStrictEqual(at.cr, [2, 1], 'at the start of the column');
    assert.deepStrictEqual(at.rr, [10, 1], 'at the flex start, the right');
    // a `safe` one at the start once it overflows, an unsafe one centred past
    // both edges; `flow-end` is `flex-end`
    assert.deepStrictEqual(at.sf, [2, 1], 'safe: at the start');
    assert.deepStrictEqual(at.uf, [2, -4], 'centred, overflowing');
    assert.deepStrictEqual(at.fe, [2, 1], 'flow-end: the flex end, the left');
  },
);
