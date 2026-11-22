// <Html> — where an absolutely positioned box is set by its self-alignment,
// or by the alignment its flex box or its grid would give it as its one
// item. Every number is Chrome's, Firefox's and Safari's (WPT's
// css-align/abspos, css-grid/alignment and css-flexbox/abspos).
import { afterEach } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import { boxOf, findById, metric, render, view } from './harness.js';

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
  "a grid's positioned item is aligned in its area by the page's left and right, and by its own start",
  async () => {
    // `left` and `right` are no start and end (CSS Box Alignment 3, 4.2), so
    // a right-to-left grid reads them from the page; `self-start` is the
    // item's own start, which its direction may put at the grid's end (4.3).
    // Both had been read as the grid's start and end.
    const at = await offsets(
      '<style>body{margin:0}' +
        '.g{position:relative;display:inline-grid;' +
        'grid-template-columns:100px 150px;grid-template-rows:50px;' +
        'vertical-align:top}' +
        '.g>div{position:absolute;width:20px;height:10px;' +
        'margin:0 10px 0 20px;grid-row:1/2}</style>' +
        '<div class="g" style="direction:rtl">' +
        '<div id="r" style="grid-column:1/2;justify-self:right"></div>' +
        '<div id="l" style="grid-column:2/3;justify-self:left"></div></div>' +
        '<br><div class="g">' +
        '<div id="s" style="grid-column:1/2;direction:rtl;' +
        'justify-self:self-start"></div>' +
        '<div id="e" style="grid-column:2/3;direction:rtl;' +
        'justify-self:self-end"></div></div>',
      ['r', 'l', 's', 'e'],
    );
    // the first column is the right one: 150 to 250
    assert.deepStrictEqual(at.r, [220, 0], 'right, against its right margin');
    assert.deepStrictEqual(at.l, [20, 0], 'left, after its left margin');
    // self-start is the right of its area, self-end its left
    assert.deepStrictEqual(at.s, [70, 0]);
    assert.deepStrictEqual(at.e, [120, 0]);
  },
);

metric(
  "a vertical-lr grid's positioned item has its margins on the sides they are written on",
  async () => {
    // (A line an item leaves `auto` is the grid's padding edge, CSS Grid 1,
    // 9.1, so each names both of its own.) The frame a `vertical-lr` grid is laid out in is put back across before
    // its positioned items are placed, and they are not put back: the
    // margins it handed them were the other way round across the page.
    const at = await offsets(
      '<style>body{margin:0}' +
        '.g{position:relative;display:inline-grid;writing-mode:vertical-lr;' +
        'grid-template-columns:100px;grid-template-rows:150px 100px}' +
        '.g>div{position:absolute;width:10px;height:60px;grid-column:1/2;' +
        'margin:5px 10px 15px 20px}</style>' +
        '<div class="g">' +
        '<div id="a" style="grid-row:1/2;align-self:start"></div>' +
        '<div id="b" style="grid-row:1/2;align-self:end"></div></div>',
      ['a', 'b'],
    );
    assert.deepStrictEqual(at.a, [20, 5], 'after its left margin');
    assert.deepStrictEqual(at.b, [130, 5], 'before its right margin');
  },
);

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

metric(
  'a box aligned between its insets reads a baseline as the start, and self-start as its own',
  async () => {
    // CSS Box Alignment 3, 4.2 and 4.3: a baseline had been taken for
    // `normal`, which stretched the box, and `self-start` for `start`
    const c = (id: string, own: string, outer = '') =>
      `<div class="c" style="${outer}"><div id="${id}" style="${own}"></div></div>`;
    const { node } = await render(
      '<style>body{margin:0}' +
        '.c{display:inline-block;position:relative;width:40px;height:40px;' +
        'margin-right:4px}' +
        '.c>div{position:absolute;inset:0}' +
        '.c>div::before{content:"";display:block;width:20px;height:20px}' +
        '</style>' +
        c('b', 'align-self:baseline') +
        c('s', 'direction:rtl;justify-self:self-start') +
        c('v', 'justify-self:start', 'writing-mode:vertical-lr') +
        c('w', 'align-self:start', 'writing-mode:vertical-lr'),
      600,
    );
    const el = view(node);
    const rect = (id: string) => el.offsetRect(findById(el.document, id)!)!;
    assert.deepStrictEqual(
      [rect('b').y, rect('b').height],
      [0, 20],
      'at the top, as tall as its content',
    );
    assert.strictEqual(rect('s').x, 20, 'at its own start, the right');
    assert.strictEqual(rect('v').y, 0, 'its inline start is the top');
    assert.strictEqual(rect('w').x, 0, 'its block start is the left');
  },
);

metric(
  "a grid's positioned item swaps its lines before it drops one the grid has not",
  async () => {
    // CSS Grid 1, 8.3 and 9.1: a name no line has is a line past the grid's
    // end, so `foo / 1` is line 1 to past the end, and that one, which the
    // grid has not, is then `auto`: the padding edge. Taken for `auto` before
    // the two were put in order, it ended the area where it should start it.
    const { node } = await render(
      '<style>body{margin:0}' +
        '.g{display:grid;position:relative;width:500px;height:300px;' +
        'padding:15px;grid-template-columns:100px 200px;' +
        'grid-template-rows:50px 150px}' +
        '.a{position:absolute;inset:0;width:auto;height:auto}</style>' +
        '<div class="g">' +
        '<div id="f" class="a" style="grid-column:foo / 1;grid-row:foo / 1"></div>' +
        '<div id="e" class="a" style="grid-column:3 / foo;grid-row:2 / 3"></div>' +
        '</div>',
      600,
    );
    const el = view(node);
    const rect = (id: string) => {
      const r = el.offsetRect(findById(el.document, id)!)!;
      return [r.x, r.y, r.width, r.height];
    };
    assert.deepStrictEqual(rect('f'), [15, 15, 515, 315]);
    assert.deepStrictEqual(rect('e'), [315, 65, 215, 150]);
  },
);

metric(
  'a `safe` absolute box too big for what it is aligned in is at its start',
  async () => {
    // where the default holds it in its containing block (CSS Box Alignment 3,
    // 4.4); every place is Chromium's
    const { node } = await render(
      '<style>body{margin:0}.c{position:relative;width:60px;height:40px;' +
        'margin-bottom:60px}.c>*{position:absolute;inset:4px 6px 2px 8px;' +
        'width:50px;height:70px}</style>' +
        '<div class="c"><i id="a" style="place-self:end"></i></div>' +
        '<div class="c"><i id="b" style="place-self:safe end"></i></div>' +
        '<div class="c"><i id="c" style="place-self:unsafe end"></i></div>' +
        '<div class="c" style="direction:rtl">' +
        '<i id="d" style="place-self:safe center"></i></div>' +
        // and one at its static position in a grid's area
        '<div class="c" style="display:grid"><i id="e" style="inset:auto;' +
        'width:80px;place-self:safe end"></i></div>',
      400,
    );
    const el = view(node);
    const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
    assert.deepStrictEqual(at('a'), [4, 0]);
    assert.deepStrictEqual(at('b'), [8, 104]);
    assert.deepStrictEqual(at('c'), [4, 168]);
    assert.deepStrictEqual(at('d'), [4, 304]);
    assert.deepStrictEqual(at('e'), [0, 400]);
  },
);
