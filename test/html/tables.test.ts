// <Html> — tables.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, expectPixel } from 'react-x11/test';
import type { FontsLike } from '../../src/html/layout/inline.js';
import { parseColor } from '../../src/html/css/values.js';
import {
  RED_PNG,
  boxOf,
  fillsOf,
  linesOf,
  metric,
  render,
  renderWithBytes,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

test('an image told to be a column is drawn, as one told to be a cell is', async () => {
  // a column is not drawn, and an image that is one is an inline image
  const { node } = await render(
    '<div style="display:table"><img id="i" width="20" height="10" ' +
      'style="display:table-column-group" src="x.png"></div>',
  );
  const img = boxOf(view(node), 'i');
  assert.ok(img.width === 20 && img.height === 10, 'laid out at its size');
});

metric('a table sizes its columns from every cell in them', async () => {
  const { node } = await render(
    '<table><tr><td>a</td><td>a much wider cell than the other one</td></tr>' +
      '<tr><td>b</td><td>x</td></tr></table>',
    500,
  );
  const tree = (view(node) as unknown as { _tree: { root: unknown } })._tree;
  const cells: { x: number; width: number }[] = [];
  const walk = (box: {
    kind: string;
    x: number;
    width: number;
    children: unknown[];
  }): void => {
    if (box.kind === 'table-cell') cells.push({ x: box.x, width: box.width });
    for (const child of box.children) walk(child as typeof box);
  };
  walk(tree.root as never);
  assert.strictEqual(cells.length, 4);
  // the second column is wider than the first, and the two rows agree
  assert.ok(cells[1].width > cells[0].width);
  assert.strictEqual(cells[0].width, cells[2].width);
  assert.strictEqual(cells[1].x, cells[3].x);
});

metric("a table column is the table's, not a row of its own", async () => {
  // A <colgroup> was taken for a stray child, wrapped in a row and a cell of
  // its own, and drawn as one — a table of one row had two.
  const { node } = await render(
    '<table id="t" style="border-spacing:0"><colgroup style="border-top:3px ' +
      'solid #00ff00"><col><col></colgroup><tr><td>a</td><td>b</td></tr></table>',
  );
  const el = view(node);
  type T = LaidBox & { kind: string };
  const rows: T[] = [];
  const walk = (b: T): void => {
    if (b.kind === 'table-row') rows.push(b);
    (b.children as T[]).forEach(walk);
  };
  walk(boxOf(el, 't') as T);
  assert.strictEqual(rows.length, 1, 'one row');
  const fills = await fillsOf(el);
  assert.ok(!fills.some((f) => f.style === '#00ff00'), 'and no column drawn');
});

metric(
  'table cells outside a table get one around them, a row a run',
  async () => {
    // CSS 2.1 17.2.1: a run of cells is one anonymous row in one anonymous
    // table — a block one in a block, an inline one in a line — where they
    // used to be blocks one above the other, or inline-blocks a space apart.
    const cell = (id: string, text: string) =>
      `<span id="${id}" style="display:table-cell">${text}</span>`;
    const { node } = await render(
      `<div id="block">${cell('b1', 'b')} ${cell('b2', 'c')}</div>` +
        `<p id="line" style="margin:0"><span>a ${cell('i1', 'b')} ` +
        `${cell('i2', 'c')} d</span></p>`,
    );
    const el = view(node);
    const [b1, b2, i1, i2] = ['b1', 'b2', 'i1', 'i2'].map((id) =>
      boxOf(el, id),
    );
    assert.strictEqual(b1.y, b2.y, 'side by side in one row');
    assert.strictEqual(b2.x, b1.x + b1.width, 'with nothing between them');
    const paragraph = boxOf(el, 'line') as LaidBox & { lines: unknown[] };
    assert.strictEqual(
      paragraph.lines.length,
      1,
      'the inline table is on the line',
    );
    assert.strictEqual(i2.x, i1.x + i1.width, 'its cells as close');
    assert.strictEqual(i1.y, i2.y);
  },
);

metric(
  'collapsed borders are one border an edge, the widest winning',
  async () => {
    // CSS 2.1 17.6.2: cells share the border between them, drawn once and
    // centred on the edge they meet at, where each used to draw its own and
    // the rule between two cells was two borders wide
    const { node } = await render(
      '<table style="border-collapse:collapse;border:1px solid #0000ff">' +
        '<tr><td id="a" style="border:4px solid #ff0000">a</td>' +
        '<td id="b" style="border:2px solid #00ff00">b</td></tr></table>',
    );
    const el = view(node);
    const [a, b] = ['a', 'b'].map((id) => boxOf(el, id));
    const edges = (box: LaidBox) =>
      box as unknown as { borderLeft: number; borderRight: number };
    assert.strictEqual(b.x, a.x + a.width, 'the cells meet');
    assert.deepStrictEqual(
      [edges(a).borderRight, edges(b).borderLeft, edges(b).borderRight],
      [2, 2, 1],
      'each holds half of the border along its edge',
    );
    const fills = await fillsOf(el);
    const of = (color: string) =>
      fills.filter((f) => f.style === parseColor(color));
    assert.deepStrictEqual(of('#0000ff'), [], "the table's border lost");
    const red = of('#ff0000').filter((f) => f.w === 4);
    assert.strictEqual(red.length, 2, "a's left edge, and the one between");
    assert.ok(
      red.some((f) => f.x === Math.round(b.x) - 2),
      'centred on the edge the cells share',
    );
    assert.strictEqual(of('#00ff00').filter((f) => f.w === 2).length, 1);
  },
);

metric(
  'a hidden border hides an edge, and a style outranks another',
  async () => {
    const { node } = await render(
      '<table style="border-collapse:collapse"><tr>' +
        '<td id="a" style="border:3px solid #ff0000;border-right-style:hidden">' +
        'a</td><td id="b" style="border:5px double #00ff00">b</td>' +
        '<td id="c" style="border:2px dotted #0000ff">c</td>' +
        '<td id="d" style="border:2px dashed #ff00ff">d</td></tr></table>',
    );
    const el = view(node);
    const left = (id: string) =>
      (boxOf(el, id) as unknown as { borderLeft: number }).borderLeft;
    assert.strictEqual(left('b'), 0, '`hidden` beats a wider double border');
    const fills = await fillsOf(el);
    const d = boxOf(el, 'd');
    // between c and d the widths are equal, and dashed outranks dotted
    assert.ok(
      fills.some(
        (f) => f.style === parseColor('#ff00ff') && f.x === Math.round(d.x) - 1,
      ),
    );
  },
);

metric("a corner equal borders meet at is the top-left cell's", async () => {
  // CSS 2.1 17.6.2.1: between two borders that win alike, the one further
  // up and further left; painted in the order they were found, the border
  // below the corner in the middle of four cells took it
  const { node } = await render(
    '<table style="border-collapse:collapse"><tr>' +
      '<td id="a" style="border:10px solid #0000ff">a</td>' +
      '<td style="border:10px solid #ff0000">b</td></tr><tr>' +
      '<td style="border:10px solid #ff0000">c</td>' +
      '<td style="border:10px solid #ff0000">d</td></tr></table>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  // the middle of the corner: a's bottom right, half a border in
  const x = Math.round(a.x + a.width);
  const y = Math.round(a.y + a.height);
  const over = (await fillsOf(el)).filter(
    (f) => f.x <= x && x < f.x + f.w && f.y <= y && y < f.y + f.h,
  );
  assert.ok(over.length > 1, 'more than one border meets there');
  assert.strictEqual(over[over.length - 1].style, parseColor('#0000ff'));
});

test("a collapsed table's sides are half its widest outer borders", async () => {
  // CSS Tables 3: along each side, the widest of its rows' borders, where
  // CSS 2.1 took the first row's and let a wider one below spill out of
  // the table, from under its background
  const { node } = await render(
    '<table id="t" style="border-collapse:collapse">' +
      '<tr><td style="padding:0;border-left:150px solid"></td></tr>' +
      '<tr><td style="padding:0;border-right:100px solid"></td></tr></table>',
  );
  assert.strictEqual(boxOf(view(node), 't').width, 75 + 75 + 50);
});

test('empty-cells: hide draws nothing of an empty cell', async () => {
  // CSS 2.1 17.6.1.1: no background of its own or its row's and no
  // borders, where borders are separate; white space collapsed away is
  // nothing, an empty element is something, and collapsed borders are
  // the grid's, which it does not touch
  const { node } = await render(
    '<table style="empty-cells:hide"><tr style="background:#0000ff">' +
      '<td style="background:#ff0000;border:2px solid #ff0000"> </td>' +
      '<td style="background:#00ff00"><span></span></td></tr></table>' +
      '<table style="empty-cells:hide;border-collapse:collapse"><tr>' +
      '<td style="border:2px solid #ff00ff"></td></tr></table>',
  );
  const fills = await fillsOf(view(node));
  const any = (color: string) =>
    fills.some((f) => f.style === parseColor(color));
  assert.ok(!any('#ff0000'), "the empty cell's background and borders");
  assert.ok(any('#00ff00'), 'a cell with an empty element in it is drawn');
  assert.strictEqual(
    fills.filter((f) => f.style === parseColor('#0000ff')).length,
    1,
    "the row's background under the second cell only",
  );
  assert.ok(any('#ff00ff'), 'collapsed borders are drawn');
});

test('a collapsed border on a line between two pixels starts on one', async () => {
  // a grid line at 12.5 carries a 25px border from 0 to 25; rounding the
  // line first and taking a whole half off drew it from 1, and the cell
  // under it showed a pixel wide at the table's edge
  const { node } = await render(
    '<table id="t" style="border-collapse:collapse;table-layout:fixed;' +
      'width:100px"><tr><td style="padding:10px 0"></td>' +
      '<td style="width:50%;padding:10px 0;border-left:25px solid #00ff00;' +
      'border-right:25px solid #00ff00"></td>' +
      '<td style="padding:10px 0"></td></tr></table>',
  );
  const el = view(node);
  const t = boxOf(el, 't');
  const green = (await fillsOf(el)).filter(
    (f) => f.style === parseColor('#00ff00'),
  );
  assert.deepStrictEqual(
    green.map((f) => [f.x - Math.round(t.x), f.w]).sort((a, b) => a[0] - b[0]),
    [
      [0, 25],
      [75, 25],
    ],
  );
});

test('a collapsed border between rows is drawn where the rows part', async () => {
  // a pixel's border is half in each row, and the two halves are what
  // layout leaves them; it was split a whole pixel to the row below, drawn
  // centred on the line all the same, and rounded apart from the table's
  // own place — a pixel over the row above, where a block's line was not
  const { node } = await render(
    '<div style="height:10.4px"></div>' +
      '<table id="t" style="border-collapse:collapse;width:50px"><tr>' +
      '<td style="padding:0;height:18.4px"></td></tr><tr>' +
      '<td style="padding:0;height:18.4px;border-top:1px solid #00ff00">' +
      '</td></tr></table>',
  );
  const el = view(node);
  const t = boxOf(el, 't');
  const green = (await fillsOf(el)).filter(
    (f) => f.style === parseColor('#00ff00'),
  );
  assert.deepStrictEqual(
    green.map((f) => [f.y, f.h]),
    [[Math.round(t.y + 18.4), 1]],
  );
});

test('an image told to be a table cell is inline', async () => {
  // CSS Display 3, 2.4: a table's part is no display a replaced element
  // takes, and it is inline — in a row, wrapped in a cell with what is
  // beside it, and in a block, on the line; they were stacked as blocks
  const { node } = await render(
    '<div style="display:table-row">' +
      '<img id="a" style="display:table-cell;width:15px;height:15px"> ' +
      '<img id="b" style="display:table-cell;width:15px;height:15px"></div>' +
      '<div><img id="c" style="display:table-cell;width:15px;height:15px">' +
      ' <img id="d" style="display:table-row;width:15px;height:15px"></div>',
  );
  const el = view(node);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => boxOf(el, id));
  assert.strictEqual(b.y, a.y, 'side by side in the row');
  assert.ok(b.x > a.x + a.width, 'a space between them');
  assert.strictEqual(d.y, c.y, 'and on one line in a block');
});

metric('a column group draws its borders where they collapse', async () => {
  const { node } = await render(
    '<table style="border-collapse:collapse"><colgroup ' +
      'style="border-top:3px solid #ff0000"><col><col></colgroup>' +
      '<tr><td>a</td><td>b</td></tr></table>',
  );
  const fills = await fillsOf(view(node));
  assert.strictEqual(
    fills.filter((f) => f.style === parseColor('#ff0000') && f.h === 3).length,
    2,
    'along both of its columns',
  );
});

metric(
  "a cell's box fills its row, and its content is aligned in it",
  async () => {
    // `vertical-align: middle` moved the whole cell down, so the row showed
    // the table's background above every cell shorter than the row
    const { node } = await render(
      '<table style="border-spacing:0"><tr><td id="s">a</td>' +
        '<td id="t" style="height:100px">b</td></tr></table>',
    );
    const el = view(node);
    const [s, t] = [boxOf(el, 's'), boxOf(el, 't')];
    assert.deepStrictEqual([s.y, s.height], [t.y, t.height]);
    const [line] = linesOf(el, 's');
    assert.ok(line.y > s.y + 30, 'the text is in the middle of the box');
  },
);

metric(
  'a cell with a height of its own centres its content in it',
  async () => {
    // `vertical-align: middle` moves the content in the box a height makes
    // as well: that height is no content, and taken for it, a cell set to
    // 100px kept its text at the top
    const { node } = await render(
      '<table style="border-spacing:0"><tr>' +
        '<td id="t" style="height:100px;padding:0">b</td></tr></table>',
    );
    const el = view(node);
    const t = boxOf(el, 't');
    const [line] = linesOf(el, 't');
    assert.ok(line.y > t.y + 30, `in the middle of the box: ${line.y - t.y}`);
  },
);

const STATIC_IN_CELL =
  '<style>body{margin:0} td{padding:0;height:80px}' +
  '.a{position:absolute;width:10px;height:10px}' +
  '.i{width:36px;height:36px}</style>';

test("an absolute box's static position moves with its cell's content", async () => {
  // CSS 2.1 10.6.4: a box with neither `top` nor `bottom` is where it
  // "would have been in the normal flow", and `vertical-align` moves the
  // flow of a cell down its box. The position is kept from the cell's
  // corner, which stays where the row is, and was left there: a badge on
  // an icon in a `middle` cell stood at the cell's top, 22px above the
  // icon, where Chrome has the two at one height.
  const { node } = await render(
    STATIC_IN_CELL +
      '<table style="border-spacing:0"><tr>' +
      '<td id="middle" style="vertical-align:middle">' +
      '<div id="middle-a" class="a"></div><div class="i"></div></td>' +
      '<td id="bottom" style="vertical-align:bottom">' +
      '<div id="bottom-a" class="a"></div><div class="i"></div></td>' +
      '<td id="top" style="vertical-align:top">' +
      '<div id="top-a" class="a"></div><div class="i"></div></td>' +
      // under the block before it, as it would have been
      '<td id="after" style="vertical-align:middle">' +
      '<div class="i"></div><div id="after-a" class="a"></div></td>' +
      // from a block in the cell, which moved with the rest
      '<td id="inner" style="vertical-align:middle"><div>' +
      '<div id="inner-a" class="a"></div><div class="i"></div></div></td>' +
      // and where the cell is what it is positioned against
      '<td id="own" style="vertical-align:middle;position:relative">' +
      '<div id="own-a" class="a"></div><div class="i"></div></td>' +
      '</tr></table>',
  );
  const el = view(node);
  const down = (id: string) => boxOf(el, `${id}-a`).y - boxOf(el, id).y;
  // 80px of cell around 36 of content: 22 above it in the middle, 44 at
  // the bottom
  assert.strictEqual(down('middle'), 22, 'in the middle');
  assert.strictEqual(down('bottom'), 44, 'at the bottom');
  assert.strictEqual(down('top'), 0, 'at the top');
  assert.strictEqual(down('after'), 22 + 36, 'after a block');
  assert.strictEqual(down('inner'), 22, 'in a block of the cell');
  assert.strictEqual(down('own'), 22, 'against the cell itself');
});

test('a cell laid out again moves its static positions once', async () => {
  // A table's cells are laid out each time the table is, which a pass
  // does more than once for one that is measured before it is placed: in
  // an inline-block, a float, a flex item, a cell of another table, an
  // absolute box. Each layout of a cell sets its static positions anew,
  // and they go down with its content once, by what the last layout
  // moved it.
  const table = (id: string) =>
    `<table style="border-spacing:0"><tr><td id="${id}" ` +
    'style="vertical-align:bottom">' +
    `<div id="${id}-a" class="a"></div><div class="i"></div></td></tr></table>`;
  const { node } = await render(
    STATIC_IN_CELL +
      `<div style="display:inline-block">${table('inline-block')}</div>` +
      `<div style="float:left">${table('float')}</div>` +
      `<div style="clear:both;display:flex"><div>${table('flex')}</div></div>` +
      `<div style="display:grid">${table('grid')}</div>` +
      '<table style="border-spacing:0"><tr><td style="height:auto">' +
      `<table style="border-spacing:0"><tr><td style="height:auto">` +
      `${table('nested')}</td></tr></table></td></tr></table>` +
      '<div style="position:relative"><div style="position:absolute">' +
      `${table('absolute')}</div></div>`,
  );
  const el = view(node);
  for (const id of [
    'inline-block',
    'float',
    'flex',
    'grid',
    'nested',
    'absolute',
  ]) {
    assert.strictEqual(boxOf(el, id).height, 80, `${id}: the cell`);
    assert.strictEqual(
      boxOf(el, `${id}-a`).y - boxOf(el, id).y,
      44,
      `${id}: at the bottom, and no further`,
    );
  }
});

metric(
  "a static position in a cell's line goes where the line went",
  async () => {
    // In a line it is found from the line (`staticPositions`), and kept
    // from the cell's corner all the same: on the line where the box is
    // inline-level, under it where it would have broken it, in an inline
    // box or not — and on the row's baseline with the line hung from it.
    const { node } = await render(
      STATIC_IN_CELL +
        '<style>td{font:16px/20px sans-serif}</style>' +
        '<table style="border-spacing:0"><tr>' +
        '<td id="on" style="vertical-align:middle">' +
        'text <span id="on-a" class="a"></span> more</td>' +
        '<td id="under" style="vertical-align:middle"><span>in <b>a span ' +
        '<span id="under-a" class="a" style="display:block"></span></b>' +
        '</span> tail</td></tr></table>' +
        '<table style="border-spacing:0"><tr>' +
        '<td style="vertical-align:baseline;font-size:40px;' +
        'line-height:50px">Big</td>' +
        '<td id="hung" style="vertical-align:baseline">' +
        '<div id="hung-a" class="a"></div>small</td></tr></table>',
    );
    const el = view(node);
    const down = (id: string) => boxOf(el, `${id}-a`).y - boxOf(el, id).y;
    // a 20px line in the middle of 80: 30 above it
    assert.strictEqual(down('on'), 30, 'on its line');
    assert.strictEqual(down('under'), 30 + 20, 'under the line it breaks');
    const [line] = linesOf(el, 'hung');
    const lift = line.y - boxOf(el, 'hung').y;
    assert.ok(lift > 10, `the line hangs from the row's baseline: ${lift}`);
    assert.strictEqual(down('hung'), lift, 'and the box at its top');
  },
);

metric("a caption is outside the table's border, above or below", async () => {
  const { node } = await render(
    '<table id="t" style="border:5px solid #0000ff"><caption id="c">' +
      'Title</caption><tr><td>x</td></tr></table>' +
      '<table id="u" style="border:5px solid #00ff00"><caption id="d" ' +
      'style="caption-side:bottom">Note</caption><tr><td>y</td></tr></table>',
  );
  const el = view(node);
  const [t, c, u, d] = ['t', 'c', 'u', 'd'].map((id) => boxOf(el, id));
  const fills = await fillsOf(el);
  const blue = fills.filter((f) => f.style === parseColor('#0000ff'));
  const green = fills.filter((f) => f.style === parseColor('#00ff00'));
  const top = Math.min(...blue.map((f) => f.y));
  assert.ok(
    top >= Math.round(c.y + c.height),
    'the border is below the caption',
  );
  // (a border box is painted from a rounded top at a rounded-up height)
  const bottom = Math.max(...green.map((f) => f.y + f.h));
  assert.ok(bottom <= Math.round(d.y) + 1, 'and above a caption at the bottom');
  // an auto table is at least as wide as its caption's longest word
  assert.strictEqual(c.width, t.width);
  assert.ok(d.y + d.height <= u.y + u.height, 'the box holds its caption');
});

metric("a table's width includes its borders", async () => {
  // HTML's rendering rules give tables `box-sizing: border-box`, so mail's
  // `<table width="600" border="1">` is 600 pixels wide, borders and all
  const { node } = await render(
    '<table id="t" style="width:200px;border:10px solid;border-spacing:0">' +
      '<tr><td>x</td></tr></table>',
  );
  const t = boxOf(view(node), 't');
  assert.strictEqual(t.width, 200);
});

metric(
  'a fixed table takes its columns from its <col>s and its first row',
  async () => {
    // CSS 2.1 17.5.2.1: a column's width sets it; else a first-row cell's
    // border box does; the rest share what is left
    const { node } = await render(
      '<table style="table-layout:fixed;width:400px;border-spacing:0">' +
        '<col style="width:100px"><col><col>' +
        '<tr><td id="a">a</td><td id="b" style="width:80px;padding:0 10px">' +
        'b</td><td id="c">c</td></tr>' +
        '<tr><td>a</td><td style="width:300px">wide, but not the first row' +
        '</td><td>c</td></tr></table>',
    );
    const el = view(node);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
    assert.strictEqual(a.width, 100, 'the column sets the first');
    assert.strictEqual(b.width, 100, "the cell's border box the second");
    assert.strictEqual(c.width, 200, 'and the third takes the rest');
  },
);

metric(
  "a fixed table of `width: auto` is laid out by its content, and a table's min-width widens its columns",
  async () => {
    const { node } = await render(
      '<table id="t" style="table-layout:fixed;border-spacing:0">' +
        '<tr><td id="a" style="padding:0">word</td></tr></table>' +
        '<table style="min-width:300px;border-spacing:0">' +
        '<tr><td id="b" style="padding:0"></td></tr></table>',
    );
    const el = view(node);
    const [t, a, b] = ['t', 'a', 'b'].map((id) => boxOf(el, id));
    assert.ok(t.width < 100, `as wide as its word: ${t.width}`);
    assert.strictEqual(a.width, t.width);
    assert.strictEqual(b.width, 300, 'an empty cell as wide as the table');
  },
);

metric(
  'border-spacing takes a length for the columns and one for the rows',
  async () => {
    const { node } = await render(
      '<table id="t" style="border-spacing:2px 10px;border:none">' +
        '<tr><td id="a" style="padding:0">a</td><td id="b" style="padding:0">' +
        'b</td></tr><tr><td id="c" style="padding:0">c</td></tr></table>',
    );
    const el = view(node);
    const [t, a, b, c] = ['t', 'a', 'b', 'c'].map((id) => boxOf(el, id));
    assert.strictEqual(a.x - t.x, 2, 'the columns 2 apart');
    assert.strictEqual(b.x - (a.x + a.width), 2);
    assert.strictEqual(a.y - t.y, 10, 'the rows 10');
    assert.strictEqual(c.y - (a.y + a.height), 10);
  },
);

metric("a column's background is painted under its cells", async () => {
  // CSS 2.1 17.5.1: a column box is laid out nowhere, and its background
  // covers the cells that start in it, over the table's and under theirs
  const { node } = await render(
    '<table style="border-spacing:0;background:#0000ff">' +
      '<col><col style="background:#ff0000">' +
      '<tr><td>a</td><td id="b">b</td></tr>' +
      '<tr><td>a</td><td id="c" style="background:#00ff00">c</td></tr>' +
      '</table>',
  );
  const el = view(node);
  const fills = await fillsOf(el);
  const red = fills.filter((f) => f.style === parseColor('#ff0000'));
  const b = boxOf(el, 'b');
  const c = boxOf(el, 'c');
  assert.deepStrictEqual(
    red.map((f) => [f.x, f.y, f.w, f.h]),
    [
      [b.x, b.y, b.width, b.height],
      [c.x, c.y, c.width, c.height],
    ].map(([x, y, w, h]) => [
      Math.round(x),
      Math.round(y),
      Math.round(x + w) - Math.round(x),
      Math.round(y + h) - Math.round(y),
    ]),
    "one fill a cell, the cells' own",
  );
  const order = fills.map((f) => f.style);
  assert.ok(
    order.indexOf(parseColor('#0000ff')) <
      order.indexOf(parseColor('#ff0000')) &&
      order.indexOf(parseColor('#ff0000')) <
        order.indexOf(parseColor('#00ff00')),
    "over the table's, under a cell's own",
  );
});

metric('a row spans its columns, not the spacing round them', async () => {
  // CSS 2.1 17.5.1: in the separated borders model a row's edges are its
  // cells', and a group's are its rows' — the spacing is the table's
  const { node } = await render(
    '<table id="t" style="border-spacing:10px;border:none">' +
      '<tbody id="g"><tr id="r"><td id="a">a</td><td id="b">b</td></tr>' +
      '</tbody></table>',
  );
  const el = view(node);
  const [t, g, r, a, b] = ['t', 'g', 'r', 'a', 'b'].map((id) => boxOf(el, id));
  assert.strictEqual(r.x - t.x, 10, 'the spacing before it outside it');
  assert.strictEqual(r.x, a.x);
  assert.strictEqual(r.x + r.width, b.x + b.width, 'and the spacing after');
  assert.deepStrictEqual([g.x, g.width], [r.x, r.width], 'its group the same');
});

metric(
  'visibility: collapse takes a row out of its table, and its spacing',
  async () => {
    // CSS 2.1 17.5.5: the row has sized the columns with the rest, and takes
    // no room; its cells inherit the value, and are not drawn
    const { node } = await render(
      '<table id="t" style="border-spacing:2px 10px;border:none">' +
        '<tr><td id="a" style="padding:0">a</td></tr>' +
        '<tr style="visibility:collapse"><td id="b" ' +
        'style="padding:0;background:#ff0000">a much wider cell</td></tr>' +
        '<tr><td id="c" style="padding:0">c</td></tr></table>',
    );
    const el = view(node);
    const [t, a, b, c] = ['t', 'a', 'b', 'c'].map((id) => boxOf(el, id));
    assert.strictEqual(
      c.y - (a.y + a.height),
      10,
      'one spacing where two were',
    );
    assert.strictEqual(t.height, 10 + a.height + 10 + c.height + 10);
    assert.ok(
      a.width > 50,
      `the column as wide as the row taken out: ${a.width}`,
    );
    assert.strictEqual(a.width, b.width);
    const fills = await fillsOf(el);
    assert.ok(
      !fills.some((f) => f.style === parseColor('#ff0000')),
      'its cell not drawn',
    );
  },
);

metric(
  'visibility: collapse takes a column out, and changes no row',
  async () => {
    // Its cells are laid out at the width they had, so a row is as tall as
    // it was, and are not drawn; the columns after it close up
    const row = (id: string, collapse: string) =>
      `<table id="t${id}" style="border-spacing:0;width:100px">` +
      `<col><col${collapse}><col>` +
      `<tr id="r${id}"><td id="a${id}">a</td>` +
      `<td id="b${id}" style="background:#ff0000">one two three` +
      ` four</td><td id="c${id}">c</td></tr></table>`;
    const { node } = await render(
      row('1', '') + row('2', ' style="visibility:collapse"'),
    );
    const el = view(node);
    const box = (id: string) => boxOf(el, id);
    const lines = (id: string) =>
      (box(id) as LaidBox & { lines: unknown[] | null }).lines?.length ?? 0;
    assert.ok(lines('b1') > 1 && lines('b2') === lines('b1'), 'wrapped alike');
    assert.strictEqual(box('r2').height, box('r1').height, 'as tall as it was');
    assert.strictEqual(box('c2').x, box('a2').x + box('a2').width, 'closed up');
    assert.strictEqual(box('t2').width, box('t1').width - box('b1').width);
    const fills = await fillsOf(el);
    const red = fills.filter((f) => f.style === parseColor('#ff0000'));
    assert.strictEqual(red.length, 1, "the first table's cell only");
  },
);

metric(
  'a cell spanning a column taken out is clipped to the ones left',
  async () => {
    // CSS 2.1 17.5.5: laid out across all its columns, moved left by the one
    // taken out, which cuts out what was in it
    const { node } = await render(
      '<table style="border-spacing:0"><col style="width:50px">' +
        '<col style="visibility:collapse;width:30px"><col style="width:40px">' +
        '<tr><td id="a" style="padding:0">a</td>' +
        '<td id="s" colspan="2" style="padding:0">x</td></tr>' +
        '<tr><td style="padding:0"></td><td style="padding:0"></td>' +
        '<td id="c" style="padding:0">c</td></tr></table>',
    );
    const el = view(node);
    const [a, s, c] = ['a', 's', 'c'].map((id) => boxOf(el, id));
    assert.strictEqual(s.x, a.x + a.width, 'over the column left');
    assert.strictEqual(s.width, c.width);
    const lines = (s as LaidBox & { lines: { texts: { drawX: number }[] }[] })
      .lines;
    assert.strictEqual(lines[0].texts[0].drawX, s.x - 30, 'its text cut');
  },
);

metric("a table's height is shared among its rows", async () => {
  // CSS 2.1 17.5.3: the height is a least height, and what the rows come
  // short of it goes to them; `max-height` holds it back
  const { node } = await render(
    '<table style="height:200px;border-spacing:0"><tr><td id="a">x</td></tr>' +
      '<tr><td id="b">y</td></tr></table>' +
      '<table style="height:300px;max-height:100px;border-spacing:0">' +
      '<tr><td id="c">z</td></tr></table>',
  );
  const el = view(node);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
  assert.ok(
    Math.abs(a.height + b.height - 200) < 0.01,
    `${a.height} ${b.height}`,
  );
  assert.ok(Math.abs(a.height - b.height) < 0.01, 'in proportion');
  assert.ok(Math.abs(c.height - 100) < 0.01, `clamped: ${c.height}`);
});

test('a table set shorter than its rows is as tall as they are', async () => {
  // CSS 2.1 17.5.3: a table's height is a least one. Taken as the table's
  // height it ended its background over its rows, and a float after it
  // went up beside them.
  const { node } = await render(
    '<div id="t" style="display:table;width:50px;height:10px">' +
      '<div style="height:100px"></div></div>',
  );
  assert.strictEqual(boxOf(view(node), 't').height, 100);
});

metric(
  'table cells in an inline box are an inline table, with the spaces either side of it',
  async () => {
    // CSS 2.1 17.2.1: the anonymous table around them is inline-level,
    // and sits in the line as an inline-block would, the white space
    // around it kept
    const { node } = await render(
      '<p id="p" style="margin:0"><span>a<span id="c" style="display:table-cell">' +
        'b</span> c</span></p>',
    );
    const el = view(node);
    assert.strictEqual(el.textContent(), 'ab c', 'the space after it kept');
    const [line] = linesOf(el, 'p');
    assert.strictEqual(line.atomics.length, 1, 'the table is on the line');
  },
);

metric(
  'text beside a block in an anonymous table cell is laid out',
  async () => {
    // the cell the table fix-up makes is a block container like another, and
    // wraps the text in an anonymous block (CSS 2.1 9.2.1.1)
    const { node } = await render(
      '<p>a<span id="t" style="display:inline-table">bcd' +
        '<span style="display:block">x</span></span>e</p>' +
        '<p>a<span id="u" style="display:inline-table">bcd</span>e</p>',
    );
    const el = view(node);
    const [t, u] = [boxOf(el, 't'), boxOf(el, 'u')];
    assert.ok(
      Math.abs(t.width - u.width) < 0.5,
      `${t.width} wide, as ${u.width}`,
    );
    assert.ok(t.height > u.height, 'and a line taller, for the block');
    assert.ok(
      linesOf(el, 't').some((line) => line.texts.length > 0 && line.y === t.y),
      'its text on its first line',
    );
  },
);

metric("a footer group's rows come last wherever it stands", async () => {
  const { node } = await render(
    '<table><thead><tr><td id="h">h</td></tr></thead>' +
      '<tfoot><tr><td id="f">f</td></tr></tfoot>' +
      '<tbody><tr><td id="b">b</td></tr></tbody></table>',
  );
  const el = view(node);
  const [h, f, b] = ['h', 'f', 'b'].map((id) => boxOf(el, id).y);
  assert.ok(h < b && b < f, 'header, body, footer');
});

metric(
  'a table cell is as tall as its content, whatever height it sets',
  async () => {
    // CSS 2.1 17.5.3: a cell's height is a least one
    const { node } = await render(
      '<table style="border-spacing:0"><tr>' +
        '<td id="a" height="4" style="padding:0">text</td>' +
        '<td id="b" style="height:4px;padding:0"></td></tr></table>',
    );
    const el = view(node);
    const [a, b] = [boxOf(el, 'a'), boxOf(el, 'b')];
    assert.ok(a.height > 12, `a line tall: ${a.height}`);
    assert.strictEqual(b.height, a.height, 'and so is its row');
  },
);

metric(
  "a table's parts take no margins, and a cell's width keeps within min and max",
  async () => {
    // CSS 2.1 8.3: margins apply to no part of a table but its caption; and
    // a cell's `min-width` and `max-width` hold it, as in every browser
    const { node } = await render(
      '<style>td{padding:0} table{border-spacing:0}</style>' +
        '<table id="t"><tr><td id="c" style="margin:50px">x</td></tr></table>' +
        '<div style="display:table"><div style="display:table-row">' +
        '<div id="max" style="display:table-cell;width:300px;max-width:100px;height:10px"></div>' +
        '</div></div>' +
        '<div style="display:table"><div style="display:table-row">' +
        '<div id="min" style="display:table-cell;min-width:80px;height:10px"></div>' +
        '</div></div>',
    );
    const el = view(node);
    const [t, c] = [boxOf(el, 't'), boxOf(el, 'c')];
    assert.strictEqual(c.x, t.x, 'at the start of its table');
    assert.strictEqual(c.y, t.y, 'at its top');
    assert.strictEqual(boxOf(el, 'max').width, 100);
    assert.strictEqual(boxOf(el, 'min').width, 80);
  },
);

test("a cell's percentage padding is of its row's width, and a percentage limit is its column's to weigh", async () => {
  // CSS 2.1 8.4 takes a percentage in a padding of the containing block's
  // width; for a cell that is its row's, the columns and the spacing
  // between them. The cell was laid out with its own width standing for
  // it, as a flex item was, so a padding of 10% in a column a third of the
  // table wide was a thirtieth of the table. And while the columns are
  // sized the percentage is of nothing (CSS Sizing 3, 5.2.1): a column is
  // as wide as its cell's content asks.
  //
  // CSS Tables 3, 3.8.2: a percentage `min-width` on a cell is ignored,
  // and a percentage `max-width` holds a percentage `width` only. Each
  // was taken of the table's width where the column was sized, and again
  // of the cell's own where the cell was laid out. Each number here is
  // Chrome's.
  const { node } = await render(
    '<style>body{margin:0} table{border-spacing:0;width:600px}' +
      'td{padding:0} .w{width:100px;height:10px}</style>' +
      // columns 200 and 400 wide, as their content is 100 and 200
      '<table><tr><td id="a" style="padding:0 10%">' +
      '<div class="w" id="a1"></div></td>' +
      '<td id="b"><div class="w" style="width:200px"></div></td></tr></table>' +
      // the row is the table less its border, its padding and the spacing
      // either side: 530
      '<table style="border-spacing:10px;padding:20px;border:5px solid">' +
      '<tr><td id="c" style="padding:0 10%"><div id="c1"></div></td>' +
      '<td></td></tr></table>' +
      // down the cell too
      '<table><tr><td id="d" style="padding:10% 0 5%"><div class="w"></div>' +
      '</td><td><div class="w" style="width:200px"></div></td></tr></table>' +
      // a table as wide as its columns: they are sized first
      '<table id="et" style="width:auto"><tr><td style="padding:0 10%">' +
      '<div class="w" id="e1"></div></td><td><div class="w"></div></td>' +
      '</tr></table>' +
      // a percentage limit beside a length
      '<table><tr><td id="f" style="width:100px;max-width:10%">' +
      '<div id="f1"></div></td><td></td></tr></table>' +
      // a percentage least width
      '<table><tr><td id="g" style="min-width:50%"><div class="w"></div></td>' +
      '<td id="g2"><div class="w" style="width:300px"></div></td></tr></table>' +
      // and the one a percentage limit holds
      '<table><tr><td id="h" style="width:50%;max-width:25%"></td><td></td>' +
      '</tr></table>' +
      // a fixed table's columns, from its first row's cells
      '<table style="table-layout:fixed"><tr><td id="k" style="' +
      'box-sizing:content-box;width:100px;padding:0 5%"><div id="k1"></div>' +
      '</td><td id="k2" style="width:30%;max-width:10%"></td><td></td></tr>' +
      '</table>',
    700,
  );
  const el = view(node);
  const across = (id: string) => [boxOf(el, id).x, boxOf(el, id).width];
  assert.deepStrictEqual(across('a'), [0, 200], 'as its content asks');
  assert.strictEqual(boxOf(el, 'a1').x, 60, 'a tenth of the row in');
  assert.deepStrictEqual(across('b'), [200, 400]);
  assert.deepStrictEqual(across('c'), [35, 260]);
  assert.deepStrictEqual(across('c1'), [88, 154], 'a tenth of 530 each side');
  assert.strictEqual(boxOf(el, 'd').height, 100, '60 over and 30 under');
  assert.strictEqual(boxOf(el, 'et').width, 200, 'its cells, unpadded');
  assert.strictEqual(boxOf(el, 'e1').x, 20, 'and the padding of that');
  assert.deepStrictEqual(across('f'), [0, 100], 'the limit ignored');
  assert.strictEqual(boxOf(el, 'f1').width, 100, 'where it is laid out too');
  assert.deepStrictEqual(across('g'), [0, 150], 'its share by its content');
  assert.deepStrictEqual(across('g2'), [150, 450]);
  assert.strictEqual(boxOf(el, 'h').width, 150, 'the lesser percentage');
  assert.deepStrictEqual(across('k'), [0, 100], 'its width, unpadded');
  assert.deepStrictEqual(across('k1'), [30, 40], 'then padded in it');
  assert.deepStrictEqual(across('k2'), [100, 60]);
});

test("cells aligned on the baseline hang their first lines from the row's", async () => {
  // CSS 2.1 17.5.3: a cell's baseline is its first line's, at any depth,
  // and the row's is the lowest of its cells'. An empty cell has none to
  // give, as in a browser, or a cell given a height would hang the rest
  // from its bottom.
  const { node } = await render(
    '<div id="t" style="display:table">' +
      '<div style="display:table-cell;padding-top:40px"><div id="a">a</div></div>' +
      '<div style="display:table-cell"><div id="b">b</div></div>' +
      '<div style="display:table-cell;height:200px"></div></div>',
  );
  const el = view(node);
  const [t, a, b] = ['t', 'a', 'b'].map((id) => boxOf(el, id));
  assert.strictEqual(a.y, t.y + 40, 'the padded cell sets the baseline');
  assert.strictEqual(b.y, a.y, 'and the other hangs from it');
});

test('a height a cell on the baseline sets is a least one, not room under its lift', async () => {
  // CSS 2.1 17.5.3: a cell's height "does not increase the height of the
  // cell box", and the row is the greatest of the heights its cells set and
  // what the cells hung from its baseline need, the lift and their content,
  // as in Chrome. The lift on top of the height made the row 40px taller
  // than the cell set, and a cell spanning it was centred that much lower.
  const { node } = await render(
    '<style>body{margin:0} table{border-spacing:0}' +
      ' td{padding:0;vertical-align:baseline}</style>' +
      '<table id="t"><tr id="r">' +
      '<td style="padding-top:40px"><div id="a">a</div></td>' +
      '<td style="height:80px"><div id="b">b</div></td>' +
      '<td rowspan="2" style="vertical-align:middle"><div id="m">m</div></td>' +
      '</tr><tr id="r2"><td>x</td><td>y</td></tr></table>' +
      // with no line in it, a cell's baseline is the bottom of what it
      // holds, not of the height it sets
      '<table id="u"><tr><td style="height:80px"><div style="height:30px">' +
      '</div></td><td><div id="c">c</div></td></tr></table>' +
      '<table id="v"><tr><td><div style="height:30px"></div></td>' +
      '<td><div id="d">d</div></td></tr></table>',
  );
  const el = view(node);
  const [t, r, a, b, r2, m, u, c, v, d] = [
    't',
    'r',
    'a',
    'b',
    'r2',
    'm',
    'u',
    'c',
    'v',
    'd',
  ].map((id) => boxOf(el, id));
  assert.strictEqual(r.height, 80, `the height the cell sets: ${r.height}`);
  assert.strictEqual(a.y, t.y + 40, 'the padded cell sets the baseline');
  assert.strictEqual(b.y, a.y, 'and the one with a height hangs from it');
  assert.strictEqual(
    m.y - t.y,
    (r.height + r2.height - m.height) / 2,
    'the spanning cell is centred in the rows',
  );
  assert.strictEqual(u.height, 80, `a height and a block: ${u.height}`);
  assert.strictEqual(
    c.y - u.y,
    d.y - v.y,
    'hung from the bottom of the block, as with no height',
  );
});

test('a cell spanning rows on the baseline asks its first row for its baseline and the rows for its content', async () => {
  // As Chrome sizes it: the ascent of a spanning cell counts in its first
  // row and nothing under it does, and the rows it spans hold its content
  // with no room for the lift, which hangs out of it.
  const { node } = await render(
    '<style>body{margin:0} table{border-spacing:0}' +
      ' td{padding:0;vertical-align:baseline}</style>' +
      // beside a cell that is not on the baseline, the padded spanning cell
      // is what makes the first row as deep as it is
      '<table><tr id="p1"><td style="vertical-align:middle">x</td>' +
      '<td rowspan="2" style="padding-top:40px"><div id="s">s</div></td>' +
      '</tr><tr id="p2"><td><div id="y">y</div></td></tr></table>' +
      // lifted by the padded cell and six lines tall, it is a table as tall
      // as its lines
      '<table id="q"><tr><td style="padding-top:40px">a</td>' +
      '<td rowspan="2"><div id="f">1</div><div>2</div><div>3</div>' +
      '<div>4</div><div>5</div><div id="l">6</div></td></tr>' +
      '<tr><td>b</td></tr></table>',
  );
  const el = view(node);
  const [p1, s, p2, y, q, f, l] = ['p1', 's', 'p2', 'y', 'q', 'f', 'l'].map(
    (id) => boxOf(el, id),
  );
  assert.ok(
    p1.height > 40 && p1.height < 40 + s.height,
    `down to the spanning cell's baseline: ${p1.height}`,
  );
  assert.strictEqual(p2.height, y.height, 'and the row under it its own');
  assert.ok(f.y - q.y >= 40, `lifted by the padded cell: ${f.y - q.y}`);
  assert.strictEqual(
    q.height,
    l.y + l.height - f.y,
    'the rows hold the lines, and not the lift',
  );
});

test("a table cell takes its row's vertical-align", async () => {
  // HTML's rendering rules make the rows middle and the cells inherit, so
  // `<tr valign="top">`, all over mail, sets its cells at the top
  const { node } = await render(
    '<table><tr id="r1" valign="top"><td style="height:60px">a</td>' +
      '<td><div id="t">b</div></td></tr>' +
      '<tr id="r2"><td style="height:60px">a</td><td><div id="m">b</div></td>' +
      '</tr></table>',
  );
  const el = view(node);
  const [r1, t, r2, m] = ['r1', 't', 'r2', 'm'].map((id) => boxOf(el, id));
  assert.ok(t.y - r1.y < 5, `top: ${t.y - r1.y}`);
  assert.ok(m.y - r2.y > 15, `the next row is still middle: ${m.y - r2.y}`);
});

test("a row's background is its cells', and a row group has no borders", async () => {
  // CSS 2.1 17.5.1 and 17.6.1: a row or a row group paints its background
  // in the areas of its cells, so the spacing between them shows the
  // table, and in the separated model it has no borders at all
  const { node } = await render(
    '<table style="border-spacing:10px">' +
      '<tbody style="border:5px solid #00ff00">' +
      '<tr style="background:#ff0000"><td id="a">a</td><td id="b">b</td></tr>' +
      '</tbody></table>',
  );
  const el = view(node);
  const fills = await fillsOf(el);
  const red = fills.filter((f) => f.style === parseColor('#ff0000'));
  const cells = ['a', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual(
    red.map((f) => [f.x, f.y, f.w, f.h]),
    cells.map((c) => [
      Math.round(c.x),
      Math.round(c.y),
      Math.round(c.x + c.width) - Math.round(c.x),
      Math.round(c.y + c.height) - Math.round(c.y),
    ]),
    'one fill a cell, none across the spacing',
  );
  assert.ok(!fills.some((f) => f.style === parseColor('#00ff00')), 'no border');
});

test("white space between a table's parts is no cell, kept or not", async () => {
  // CSS 2.1 17.2.1, rule 1: under `white-space: pre` the line breaks
  // between a table's rows made a cell of their own before each
  const { node } = await render(
    '<div id="t" style="display:table;white-space:pre">\n  ' +
      '<div style="display:table-row">\n    ' +
      '<div id="c" style="display:table-cell">x</div>\n  </div>\n</div>',
  );
  const el = view(node);
  const [t, c] = ['t', 'c'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([c.x, c.y], [t.x, t.y], 'the cell is the first');
});

test("an auto table is as wide as its caption's own width", async () => {
  // CSS 2.1 17.4: the caption's least width is the table's, and one set to
  // a length has that one; measured at no width, an empty caption set to
  // 100px counted nothing, and the table under it was as narrow as its
  // empty cell
  const { node } = await render(
    '<table id="t" style="border-spacing:0"><caption style="width:100px">' +
      '</caption><tr><td style="padding:0"></td></tr></table>',
  );
  assert.strictEqual(boxOf(view(node), 't').width, 100);
});

test('an auto table sized to its content is as wide as its columns and the spacing either side of them', async () => {
  // Chrome's: a flex item, a grid item, a float, an `inline-table` and an
  // absolute box are each 56 wide — two columns of 40 and 10, and three
  // gaps of 2. Measured by its rows, which run from its first column to
  // its last, each was 52, and its first column gave up the 4 pixels: its
  // two floats went one under the other
  const float = '<div style="float:left;width:20px;height:10px"></div>';
  const table = (id: string, style = '') =>
    `<table id="${id}" style="border-spacing:2px;${style}"><tr>` +
    `<td id="${id}-a">${float}${float}</td>` +
    '<td><div style="width:10px;height:10px"></div></td></tr></table>';
  const { node } = await render(
    '<style>td{padding:0}section{align-items:start}</style>' +
      `<section style="display:flex">${table('flex')}</section>` +
      '<section style="display:grid;grid-template-columns:auto 1fr">' +
      `${table('grid')}<div></div></section>` +
      `<section style="display:flow-root">${table('float', 'float:left')}` +
      `</section><section>${table('inline', 'display:inline-table')}` +
      '</section><section style="position:relative">' +
      `${table('absolute', 'position:absolute')}</section>`,
  );
  const el = view(node);
  for (const id of ['flex', 'grid', 'float', 'inline', 'absolute']) {
    assert.deepStrictEqual(
      [boxOf(el, id).width, boxOf(el, `${id}-a`).width, boxOf(el, id).height],
      [56, 40, 14],
      id,
    );
  }
});

metric(
  'white space beside what a table wraps in a cell stays in it',
  async () => {
    // CSS 2.1 17.2.1, rule 1: it goes only between two of a table's parts;
    // between two inline boxes in a row it is the anonymous cell's, as it is
    // between two loose ones in a table, and it was dropped from both
    const { node } = await render(
      '<div style="display:table-row"><span id="a">a</span> <span>b</span></div>' +
        '<div style="display:table"><span id="c">a</span> <span>b</span></div>' +
        '<div style="display:table"><div id="ref" style="display:table-cell">' +
        'a b</div></div>',
    );
    const el = view(node);
    const cellOf = (id: string) =>
      (boxOf(el, id) as LaidBox & { parent: LaidBox }).parent;
    const ref = boxOf(el, 'ref').width;
    // give or take a 64th for each element's text on the line, which a line
    // is measured in, each rounded up (`fit: 'items'`): three spans in a
    // cell are 110.328125 in Chrome where their text as one is 110.3125
    const near = (width: number) => Math.abs(width - ref) <= 2 / 64 + 1e-9;
    assert.ok(near(cellOf('a').width), 'in a row: as wide as "a b"');
    assert.ok(near(cellOf('c').width), 'loose in a table: the same');
  },
);

test("a spanning cell's width is shared by its columns, less the spacing", async () => {
  // CSS 2.1 17.5.2.2, steps 1 and 3: its own width is the least it is,
  // and the spacing between its columns is part of it, so a cell over
  // three columns set to 100px, with 20px between them, has 60 to share
  const { node } = await render(
    '<table style="border-spacing:20px"><tr>' +
      '<td id="s" colspan="3" style="width:100px;padding:0"></td></tr></table>',
  );
  assert.strictEqual(boxOf(view(node), 's').width, 100);
});

test('a spanning cell comes after the cells of one column', async () => {
  // in a first row it was shared out evenly before the cells under it
  // were seen, and a column one of them sets to 5px took half of it
  const { node } = await render(
    '<table style="width:110px;border-spacing:0">' +
      '<tr><td colspan="2" style="width:100px;padding:0"></td>' +
      '<td colspan="2" style="padding:0"></td></tr>' +
      '<tr><td id="a" style="width:5px;padding:0"></td>' +
      '<td id="s" colspan="2" style="padding:0"></td>' +
      '<td id="b" style="width:5px;padding:0"></td></tr></table>',
  );
  const el = view(node);
  const [a, s, b] = ['a', 's', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([a.width, s.width, b.width], [5, 100, 5]);
});

test("a cell's percentage is a share of the table, its borders in it", async () => {
  // added on, a 90% cell and a 10% one came to more than the table,
  // which took it back from both and left them 8.8 to 1
  const { node } = await render(
    '<table style="width:400px;border-collapse:collapse"><tr>' +
      '<td id="a" style="width:90%;border:1px solid;padding:0"></td>' +
      '<td id="b" style="width:10%;border:1px solid;padding:0"></td></tr>' +
      '</table>',
  );
  const el = view(node);
  const [a, b] = ['a', 'b'].map((id) => boxOf(el, id));
  assert.ok(Math.abs(a.width - 9 * b.width) < 0.01, `${a.width} ${b.width}`);
});

metric(
  'a cell set to a narrow percentage is no narrower than its word',
  async () => {
    // a table never goes narrower than its words (CSS 2.1 17.5.2.2): a
    // cell's own width is weighed apart from its content, and the content
    // was measured at the width the probe laid the cell out at, which for
    // one set to a width was its padding, so a 3% column cut its word
    const { node } = await render(
      '<table style="width:320px;border-spacing:0"><tr>' +
        '<td style="width:97%;padding:0">a</td>' +
        '<td id="b" style="width:3%;padding:0">unbreakable</td></tr></table>',
    );
    const el = view(node);
    const b = boxOf(el, 'b') as LaidBox & { lines: { width: number }[] };
    assert.ok(b.width >= b.lines[0].width, `${b.width} ${b.lines[0].width}`);
  },
);

test('a table with a width of its own fills it with its columns', async () => {
  // CSS 2.1 17.5.2.2: the columns not set to a width take what the table
  // has beyond their content, in proportion to it; <table width="600"> drew
  // its cells at their content's width and left the rest empty
  const { node } = await render(
    '<table id="t" width="300" style="border-spacing:0">' +
      '<tr><td id="a" style="padding:0">x</td></tr></table>' +
      '<table width="300" style="border-spacing:0"><tr>' +
      '<td id="b" style="padding:0;width:50px">x</td>' +
      '<td id="c" style="padding:0">x</td></tr></table>' +
      '<table id="u" style="border-spacing:0">' +
      '<tr><td id="d" style="padding:0">x</td></tr></table>',
  );
  const el = view(node);
  const [a, b, c, d, u] = ['a', 'b', 'c', 'd', 'u'].map((id) => boxOf(el, id));
  assert.strictEqual(a.width, 300, 'one column takes it all');
  assert.strictEqual(b.width, 50, 'a column set to a width keeps it');
  assert.strictEqual(c.width, 250, 'and the other takes the rest');
  assert.ok(d.width < 50 && u.width === d.width, 'a table of `auto` shrinks');
});

test("a table gives up its cells' set widths before its words", async () => {
  // CSS 2.1 17.5.2.2: a table is never narrower than what its content asks,
  // and a width a cell was set to gives way first. Clamped to the room, a
  // table beside a float ran under it; held at its cells' widths, it went
  // below floats it could have sat beside.
  const { node } = await render(
    '<div id="w" style="width:250px">' +
      '<div style="float:right;width:200px;height:50px"></div>' +
      '<table id="t" style="border-spacing:0"><tr>' +
      '<td style="width:100px;height:30px;padding:0"></td></tr></table></div>' +
      '<div id="v" style="width:300px;clear:both">' +
      '<div style="float:left;width:100px;height:100px"></div>' +
      '<table id="u" style="border-spacing:0"><tr><td style="padding:0">' +
      '<span style="display:inline-block;width:250px;height:10px"></span>' +
      '</td></tr></table></div>',
  );
  const el = view(node);
  const [w, t, v, u] = ['w', 't', 'v', 'u'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([t.y - w.y, t.width], [0, 50], 'beside the float');
  assert.deepStrictEqual([u.y - v.y, u.width], [100, 250], 'below it');
});

metric(
  'a column set to a width is that wide, and its text wraps in it',
  async () => {
    // browsers take a set width for the column's, which its content widens
    // only where it cannot break narrower; CSS 2.1's step 2 took it for a
    // floor under the text's widest line, and the column was one line wide
    const { node } = await render(
      '<table style="border-spacing:0"><col><col style="width:80px"><tr>' +
        '<td>a</td><td id="c" style="padding:0">Filler Text Filler Text</td>' +
        '</tr></table><table style="border-spacing:0"><tr><td>b</td>' +
        '<td id="d" style="padding:0;width:60px">Filler Text Filler Text</td>' +
        '</tr></table>',
    );
    const el = view(node);
    assert.deepStrictEqual(
      [boxOf(el, 'c').width, boxOf(el, 'd').width],
      [80, 60],
    );
    assert.ok(linesOf(el, 'c').length > 1, 'its text wraps');
  },
);

metric('a table of no cells is as wide as its caption can be', async () => {
  // not as the room on offer, where the caption was centred
  const { node } = await render(
    '<table id="t"><caption id="c">XXXXXXXXXX</caption></table>',
  );
  const el = view(node);
  const [t, c] = ['t', 'c'].map((id) => boxOf(el, id));
  const [line] = linesOf(el, 'c');
  assert.ok(t.width < 200, `${t.width}`);
  assert.ok(Math.abs(line.x - c.x) < 1, 'its text starts at its start');
});

test('a column, or a column group, sets its columns in an auto table (CSS 2.1 17.5.2.2)', async () => {
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0}td{padding:0}</style>' +
      // an empty group is one column, and its width is that column's
      '<table id="g"><colgroup style="width:100px"></colgroup><tr><td></td></tr></table>' +
      // a column within its limits
      '<table id="c"><col style="width:300px;max-width:50px"><tr><td></td></tr></table>' +
      // a limit alone sets one
      '<table id="m"><colgroup style="min-width:80px"></colgroup><tr><td></td></tr></table>' +
      // a group wider than its columns spreads the rest over them
      '<table id="s"><colgroup style="width:100px"><col style="width:20px">' +
      '<col style="width:20px"></colgroup>' +
      '<tr><td id="s1"></td><td id="s2"></td></tr></table>' +
      // A percentage limit is no length: one for a least width is ignored,
      // and one for a greatest holds a percentage width only (CSS Tables
      // 3, 3.8.2), as on a cell. The columns here are Chrome's.
      '<table style="width:300px"><col style="min-width:50%"><col>' +
      '<tr><td id="p1"><div style="width:20px"></div></td>' +
      '<td><div style="width:60px"></div></td></tr></table>' +
      '<table style="width:300px"><col style="width:100px;max-width:10%">' +
      '<col><tr><td id="p2"></td><td></td></tr></table>' +
      '<table style="width:300px"><col style="width:50%;max-width:25%">' +
      '<col><tr><td id="p3"></td><td></td></tr></table>',
    400,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'g').width, 100);
  assert.strictEqual(boxOf(el, 'c').width, 50);
  assert.strictEqual(boxOf(el, 'm').width, 80);
  assert.strictEqual(boxOf(el, 's').width, 100);
  assert.strictEqual(boxOf(el, 's1').width, 50);
  assert.strictEqual(boxOf(el, 's2').width, 50);
  assert.strictEqual(boxOf(el, 'p1').width, 75, 'a quarter, by its content');
  assert.strictEqual(boxOf(el, 'p2').width, 100, 'its width, not a tenth');
  assert.strictEqual(boxOf(el, 'p3').width, 75, 'the lesser percentage');
});

metric(
  "a column group's image is placed in the box its cells make, and a row's against its cells",
  async () => {
    const { result } = await renderWithBytes(
      '<style>body{margin:0}td{padding:0;height:30px;width:30px}' +
        'table{border-spacing:10px}' +
        // the group's two columns: its image at the bottom right of both
        '#g{background:url(r.png) no-repeat 100% 100%}' +
        // the row's at its first cell's corner, not the spacing's
        '#r{background:url(r.png) no-repeat 0 0}</style>' +
        '<table><colgroup id="g"><col><col></colgroup><col>' +
        '<tr><td></td><td></td><td></td></tr></table>' +
        '<table><tr id="r"><td></td><td></td></tr></table>',
      { 'r.png': RED_PNG },
    );
    const ctx = result.ctx;
    // the group runs from x 10 to 80, y 10 to 40: the 10px square ends there
    await expectPixel(ctx, 75, 35, '#ff0000', {
      message: 'group, bottom right',
    });
    await expectPixel(ctx, 15, 15, '#ffffff', { message: 'group, top left' });
    // the second table starts at y 50; its first cell at x 10, y 60
    await expectPixel(ctx, 15, 65, '#ff0000', { message: 'row, at its cell' });
    await expectPixel(ctx, 25, 65, '#ffffff', {
      message: 'row, past the tile',
    });
  },
);

metric(
  'a table that does not let its content overflow clips it to the table box, its caption outside',
  async () => {
    const { result } = await renderWithBytes(
      '<style>body{margin:0}table{overflow:hidden;border-spacing:0}' +
        'caption{height:20px;background:#0000ff}td{padding:0}' +
        'div{width:20px;height:20px;margin-top:-10px;background:#ff0000}</style>' +
        '<table><caption></caption><tr><td><div></div></td></tr></table>',
      {},
    );
    const ctx = result.ctx;
    // the caption is drawn, and the cell's block does not reach up over it
    await expectPixel(ctx, 10, 15, '#0000ff', { message: 'the caption' });
    await expectPixel(ctx, 10, 25, '#ff0000', { message: 'in the table box' });
  },
);

test("a table in an aligned cell keeps its cells' text at their start", async () => {
  // Every mail centres its body in `<td align="center">`, which is
  // `-webkit-center`: the table is centred, and its cells' text is not,
  // since a table resets HTML's alignment as Blink does. An author's own
  // `text-align: center` is inherited into the table as ever.
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0}td{padding:0}</style>' +
      '<table width="400"><tr><td align="center">' +
      '<table id="t1" width="200"><tr><td id="c1">text</td></tr></table>' +
      '</td></tr></table>' +
      '<center><table id="t2" width="200"><tr><td id="c2">text</td></tr>' +
      '</table></center>' +
      '<table width="400"><tr><td style="text-align:center">' +
      '<table width="200"><tr><td id="c3">text</td></tr></table>' +
      '</td></tr></table>',
    400,
  );
  const el = view(node);
  const align = (id: string) =>
    (boxOf(el, id) as unknown as { style: { textAlign: string } }).style
      .textAlign;
  assert.strictEqual(boxOf(el, 't1').x, 100, 'the table centred');
  assert.strictEqual(align('c1'), 'start');
  assert.strictEqual(boxOf(el, 't2').x, 100);
  assert.strictEqual(align('c2'), 'start');
  assert.strictEqual(align('c3'), 'center', "the author's own centring");
});

metric('a cell whose width adds a percentage to a length is auto', async () => {
  const { el } = await renderWithBytes(
    '<html><head><style>table { table-layout: fixed; width: 500px; ' +
      'border-spacing: 0 } td { padding: 0 }</style></head><body><table><tr>' +
      '<td id="a" style="width: calc(50% + 1px)">x</td>' +
      '<td style="width: 100px">y</td></tr></table>' +
      '<table><tr><td id="b" style="width: calc(50%)">x</td>' +
      '<td>y</td></tr></table></body></html>',
    {},
  );
  assert.strictEqual(boxOf(el, 'a').width, 400);
  assert.strictEqual(boxOf(el, 'b').width, 250);
});

metric(
  "a table cell's min-content is its widest word, read or probed",
  async () => {
    // squeezed to nothing, each column is its min-content wide: read from
    // the words where they break only at spaces, and probed where they may
    // break elsewhere — a hyphen here
    const { node } = await render(
      '<style>body{margin:0}td{padding:0 3px}.f{float:left;clear:left;' +
        'padding:0 3px}</style>' +
        '<table style="width:1px;border-spacing:0"><tr>' +
        '<td id="a">alpha betalong gamma</td>' +
        '<td id="b">foo<b>barbaz</b> qux</td>' +
        '<td id="c"><div style="padding:0 7px">word longerword</div></td>' +
        '<td id="d">well-known</td>' +
        '<td id="e">café crème brûlée</td>' +
        '</tr></table>' +
        '<div style="width:1000px"><div class="f" id="ra">betalong</div>' +
        '<div class="f" id="rb">foo<b>barbaz</b></div>' +
        '<div class="f" id="rc" style="padding:0 10px">longerword</div>' +
        '<div class="f" id="rd1">well-</div><div class="f" id="rd2">known</div>' +
        '<div class="f" id="re">crème brûlée</div></div>',
    );
    const el = view(node);
    const width = (id: string) => boxOf(el, id).width;
    assert.strictEqual(width('a'), width('ra'));
    assert.strictEqual(width('b'), width('rb'), 'a word across two runs');
    assert.strictEqual(width('c'), width('rc'), "a block's padding counted");
    assert.strictEqual(
      width('d'),
      Math.max(width('rd1'), width('rd2')),
      'the hyphen is a break, which the probe finds',
    );
    assert.strictEqual(width('e'), width('re'), 'a no-break space joins');
  },
);

metric('a table of plain text is laid out at no pixel width', async () => {
  // its cells' min-content widths are read from their words: the probe a
  // pixel wide was four fifths of a table's first layout on X11
  const words = 'Some words in a cell that wraps. ';
  const { node } = await render(
    `<table style="width:300px"><tr><td>${words}</td><td>${words.repeat(2)}` +
      '</td><td>42.00</td></tr></table>',
  );
  const el = view(node) as unknown as {
    app: { fonts: FontsLike };
    _source: { document: unknown };
    _cascade: unknown;
  };
  const engine = el.app.fonts;
  const widths: number[] = [];
  const spy: FontsLike = {
    layout: (content, style, options) => {
      if (options?.maxWidth !== undefined) widths.push(options.maxWidth);
      return engine.layout(content, style, options);
    },
    match: (family, style) => engine.match(family, style),
  };
  const { buildBoxes } = await import('../../src/html/layout/boxes.js');
  const { layoutDocument } = await import('../../src/html/layout/block.js');
  const tree = buildBoxes(el._source.document as never, {
    cascade: el._cascade as never,
    scale: 1,
    imageSize: () => null,
    urlSize: () => null,
    controlSize: () => ({ width: 0, height: 0 }) as never,
  });
  layoutDocument(tree, spy, 400, 600);
  assert.ok(widths.length > 0);
  assert.ok(!widths.some((w) => w <= 1), `widths: ${widths.join(', ')}`);
});

test("a table's height goes to its rows as a browser gives it", async () => {
  // It went to every row in proportion to its height, so the rows whose
  // cells set one grew, and an empty row between them stayed empty. CSS
  // 2.1 leaves it open (17.5.3); browsers give it to the rows a percentage
  // sets, up to it, then to the rows nothing sets, and to the empty ones
  // where every other row is set
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0;height:300px}td{padding:0}' +
      '</style>' +
      '<table><tr id="a"><td style="height:50px"></td></tr>' +
      '<tr id="b"><td></td></tr>' +
      '<tr id="c"><td style="height:50px"></td></tr></table>' +
      '<table><tr id="d"><td>x</td></tr>' +
      '<tr id="e"><td style="height:50px">y</td></tr></table>' +
      '<table><tr id="f" style="height:50%"><td></td></tr>' +
      '<tr id="g"><td>x</td></tr></table>',
  );
  const el = view(node);
  const height = (id: string) => boxOf(el, id).height;
  assert.deepStrictEqual(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(height),
    [50, 200, 50, 250, 50, 150, 150],
  );
});

test('a table a flex box or a grid stretches gives the height to its rows, and a grid stretches it across', async () => {
  // A flex or grid layout gave a table item its height by setting the box's,
  // and a table shares out only the height it sets: the table was 120 tall
  // around a row as tall as its content, and a cell's `vertical-align` had
  // nothing to centre in. The height given is a least one, as the table's
  // own is (CSS 2.1 17.5.3), and its captions take their part of it (CSS
  // Flexbox 1, 4). And `normal` stretches a table grid item across its area
  // as it does any box that is not replaced (CSS Grid 1, 6.2): as wide as
  // its columns, as in a block's flow, it stopped at them, as Chrome's does
  // not. Measured against Chrome: 116 of 120 to the row, 396 of 400 across.
  const table = (id: string, attributes = '', caption = '') =>
    `<table id="${id}t"${attributes}>${caption}<tbody><tr>` +
    `<td id="${id}" style="vertical-align:middle">` +
    `<div id="${id}x" style="width:10px;height:20px"></div></td></tr></tbody>` +
    '</table>';
  const { node } = await render(
    '<style>body{margin:0}td{padding:0}table{border-spacing:2px}</style>' +
      `<div style="display:flex;height:120px">${table('f')}</div>` +
      // stretched to a line no height of its own made
      '<div style="display:flex"><div style="height:80px;width:10px"></div>' +
      `${table('l')}</div>` +
      '<div style="display:flex;flex-direction:column;height:200px">' +
      `<div style="height:80px"></div>${table('c', ' style="flex:1"')}</div>` +
      `<div style="display:grid;grid-template-rows:120px">${table('g')}</div>` +
      '<div style="display:grid;grid-template-rows:120px">' +
      `${table('p', '', '<caption style="height:20px"></caption>')}</div>` +
      // and no shorter than its rows, however short its line or its area
      `<div style="display:flex;height:10px">${table('s')}</div>` +
      `<div style="display:grid;grid-template-rows:10px">${table('r')}</div>` +
      // and `start` sizes it to fit, as in a block's flow
      `<div style="display:grid;justify-items:start">${table('j')}</div>`,
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  const rect = (id: string) => {
    const b = box(id);
    return [b.width, b.height];
  };
  // the content in the middle of the cell, which is the row's height
  const centred = (id: string) => box(`${id}x`).y - box(id).y;
  assert.deepStrictEqual(rect('ft'), [14, 120], 'stretched down its line');
  assert.deepStrictEqual(rect('f'), [10, 116], 'and its row with it');
  assert.strictEqual(centred('f'), 48, 'its content centred in the row');
  assert.deepStrictEqual(rect('l'), [10, 76], "to a line's height");
  assert.strictEqual(box('ct').height, 120, 'flexed down a column');
  assert.strictEqual(box('c').height, 116);
  assert.deepStrictEqual(rect('gt'), [400, 120], 'stretched across its area');
  assert.deepStrictEqual(rect('g'), [396, 116], 'and down it');
  assert.strictEqual(centred('g'), 48);
  assert.deepStrictEqual(rect('p'), [396, 96], 'its caption given its part');
  assert.deepStrictEqual(rect('st'), [14, 24], 'no shorter than its row');
  assert.deepStrictEqual(rect('rt'), [400, 24], 'in an area shorter than it');
  assert.deepStrictEqual(rect('jt'), [14, 24], 'fit to its content at start');
});
