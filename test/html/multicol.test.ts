// <Html> — multi-column layout: the columns, where they break, and the
// pieces of what a break falls inside.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { parseColor } from '../../src/html/css/values.js';
import {
  FONTS,
  boxOf,
  fillsOf,
  h,
  linesOf,
  metric,
  render,
  view,
} from './harness.js';
import type { PaintOp } from './harness.js';

afterEach(cleanup);

// Every number here is Chrome's, of the same markup at the same width: the
// spec leaves the height of balanced columns to the user agent (CSS
// Multi-column 1, 7), and this does as Blink does.
const SHEET =
  '<style>body{margin:0;font:16px/20px sans-serif}' +
  '.m{width:600px;column-count:2;column-gap:40px;margin:0 0 30px}' +
  // `.u` is a box that goes whole: one that clips, which no break falls in
  'p{margin:10px 0}.u{height:20px;margin:10px 0;overflow:hidden}</style>';

/** Lines of text, broken where they are written. */
const text = (name: string, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `${name} ${i + 1}`).join('<br>');

const p = (id: string, lines: number, style = ''): string =>
  `<p id="${id}" style="${style}">${text(id, lines)}</p>`;

const at = (el: ReturnType<typeof view>, id: string, from: string) => {
  const box = boxOf(el, id);
  const base = boxOf(el, from);
  return [box.x - base.x, box.y - base.y, box.width, box.height];
};

/** The clip each fill of a colour was drawn under: a broken box's pieces. */
const piecesOf = async (el: ReturnType<typeof view>, color: string) => {
  const ops: PaintOp[] = [];
  await fillsOf(el, ops);
  const ground = parseColor(color);
  const pieces: number[][] = [];
  let clip: number[] | null = null;
  for (const op of ops) {
    if (op.op === 'clip') clip = [op.x, op.y, op.w, op.h];
    else if (op.op === 'fill' && op.style === ground && clip) pieces.push(clip);
  }
  return pieces;
};

/** Which column each of a block's lines is in, and how far down it. */
const placed = (el: ReturnType<typeof view>, id: string, from: string) => {
  const base = boxOf(el, from);
  return linesOf(el, id).map((line) => [
    Math.round((line.x - base.x) / 320),
    line.y - base.y,
  ]);
};

test('the blocks of a multicol container are set in its columns, as tall as balances them', async () => {
  // Five blocks of 20px, 10px of margin about each: 160px of content, its
  // first and last margins in it, over two columns is 80px a column. The
  // margin after the second is dropped at the break, and the first one
  // stays, since the container is a formatting context of its own.
  const { node } = await render(
    SHEET +
      '<div class="m" id="m"><div class="u" id="a"></div>' +
      '<div class="u" id="b"></div><div class="u" id="c"></div>' +
      '<div class="u" id="d"></div><div class="u" id="e"></div></div>' +
      '<div id="after"></div>',
    700,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'm').height, 80, 'the columns balance');
  assert.deepStrictEqual(at(el, 'a', 'm'), [0, 10, 280, 20], 'the first');
  assert.deepStrictEqual(at(el, 'b', 'm'), [0, 40, 280, 20], 'under it');
  assert.deepStrictEqual(at(el, 'c', 'm'), [320, 0, 280, 20], 'a column on');
  assert.deepStrictEqual(at(el, 'd', 'm'), [320, 30, 280, 20], 'the fourth');
  assert.deepStrictEqual(at(el, 'e', 'm'), [320, 60, 280, 20], 'the last');
  assert.strictEqual(at(el, 'after', 'm')[1], 110, 'what follows it');
});

test('column-width, the columns shorthand and the gap say how many columns there are and how wide', async () => {
  const columns = async (style: string) => {
    const { node } = await render(
      SHEET +
        `<div class="m" id="m" style="${style}">` +
        '<div class="u" id="a"></div><div class="u" id="b"></div>' +
        '<div class="u" id="c"></div><div class="u" id="d"></div>' +
        '<div class="u" id="e"></div><div class="u" id="f"></div></div>',
      700,
    );
    const el = view(node);
    const out = new Set<number>();
    for (const id of 'abcdef') out.add(at(el, id, 'm')[0]);
    return { xs: [...out], width: boxOf(el, 'a').width };
  };
  // as many 150px columns as fit, 40px apart: three, of 173⅓px
  let laid = await columns('column-count:auto;column-width:150px');
  assert.strictEqual(laid.xs.length, 3, 'as many as fit');
  assert.ok(Math.abs(laid.width - 520 / 3) < 0.01, `each ${laid.width}`);
  // the fewer of the two: two columns, where four 250px ones do not fit
  laid = await columns('columns:4 250px');
  assert.deepStrictEqual(laid.xs, [0, 320], 'the fewer');
  assert.strictEqual(laid.width, 280, 'as wide as leaves the gap');
  // `normal` is an em between them
  laid = await columns('column-gap:normal');
  assert.deepStrictEqual(laid.xs, [0, 308], 'an em apart');
  assert.strictEqual(laid.width, 292, 'and that much wider');
  // WebKit's names, which Chrome still reads
  laid = await columns(
    'column-count:auto;-webkit-column-count:3;-webkit-column-gap:30px',
  );
  assert.deepStrictEqual(laid.xs, [0, 210, 420], "WebKit's names");
  // one column is the block it was
  laid = await columns('column-count:1');
  assert.deepStrictEqual(laid.xs, [0], 'one column');
  assert.strictEqual(laid.width, 600, 'all the width');
});

metric(
  'a column break falls between the lines of a block, and leaves two at either side',
  async () => {
    // Three paragraphs of three lines: the second breaks after its second
    // line, where its third is the only one that does not fit, and one line
    // goes to the next column alone: `orphans` is kept before `widows`.
    const source = (style: string) =>
      SHEET +
      `<div class="m" id="m" style="${style}">${p('a', 3)}${p('b', 3)}` +
      `${p('c', 3)}</div>`;
    let { node } = await render(source(''), 700);
    let el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 120, 'the columns');
    assert.deepStrictEqual(
      placed(el, 'b', 'm'),
      [
        [0, 80],
        [0, 100],
        [1, 0],
      ],
      'two lines stay and one goes',
    );
    assert.deepStrictEqual(
      placed(el, 'c', 'm'),
      [
        [1, 30],
        [1, 50],
        [1, 70],
      ],
      'the last paragraph under it, its margin kept',
    );
    // its rect takes in both its pieces, as a browser's bounding rect does
    assert.deepStrictEqual(at(el, 'b', 'm'), [0, 0, 600, 120], 'its rect');
    cleanup();
    // one line may stay alone: the columns are shorter for it
    ({ node } = await render(source('orphans:1;widows:1'), 700));
    el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 110, 'shorter columns');
    assert.deepStrictEqual(
      placed(el, 'b', 'm'),
      [
        [0, 80],
        [1, 0],
        [1, 20],
      ],
      'one line stays',
    );
  },
);

metric(
  'widows take lines to the next column with them, as many as orphans leave',
  async () => {
    // Paragraphs of two, four and four lines. Three lines of the second fit
    // and one would go alone, so one more goes with it; `widows: 3` asks for
    // three, which would leave one, and gets two.
    for (const style of ['', 'widows:3']) {
      const { node } = await render(
        SHEET +
          `<div class="m" id="m" style="${style}">${p('a', 2)}${p('b', 4)}` +
          `${p('c', 4)}</div>`,
        700,
      );
      const el = view(node);
      assert.strictEqual(boxOf(el, 'm').height, 130, `the columns: ${style}`);
      assert.deepStrictEqual(
        placed(el, 'b', 'm'),
        [
          [0, 60],
          [0, 80],
          [1, 0],
          [1, 20],
        ],
        `two and two: ${style}`,
      );
      cleanup();
    }
    // and one may go alone where `widows` says so
    const { node } = await render(
      SHEET +
        `<div class="m" id="m" style="widows:1">${p('a', 2)}${p('b', 4)}` +
        `${p('c', 4)}</div>`,
      700,
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 120, 'shorter columns');
    assert.deepStrictEqual(
      placed(el, 'b', 'm').map(([c]) => c),
      [0, 0, 0, 1],
      'three and one',
    );
  },
);

metric('a box that cannot break goes to the next column whole', async () => {
  // a paragraph that says `break-inside: avoid`, and a box that clips
  for (const whole of [
    p('b', 5, 'break-inside:avoid'),
    p('b', 5, 'page-break-inside:avoid'),
    `<p id="b" style="overflow:hidden">${text('b', 5)}</p>`,
  ]) {
    const { node } = await render(
      SHEET + `<div class="m" id="m">${p('a', 3)}${whole}${p('c', 2)}</div>`,
      700,
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 150, 'the columns');
    assert.deepStrictEqual(at(el, 'b', 'm'), [320, 0, 280, 100], 'whole');
    assert.deepStrictEqual(at(el, 'c', 'm'), [320, 110, 280, 40], 'and next');
    cleanup();
  }
});

metric('columns no taller than the container go on past its edge', async () => {
  // a height of its own, and a `max-height`: nine lines in columns that
  // hold three, two of them beyond the container, and no line alone in one
  for (const [style, height, lines] of [
    ['height:60px', 60, [2, 3, 2, 2]],
    ['max-height:70px', 70, [3, 2, 2, 2]],
  ] as const) {
    const { node } = await render(
      SHEET +
        `<div class="m" id="m" style="${style}">${p('a', 5)}${p('b', 4)}` +
        '</div><div id="after"></div>',
      700,
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, height, style);
    const columns = [...placed(el, 'a', 'm'), ...placed(el, 'b', 'm')].map(
      ([c]) => c,
    );
    assert.deepStrictEqual(
      [0, 1, 2, 3].map((c) => columns.filter((at) => at === c).length),
      lines,
      `the lines in each column: ${style}`,
    );
    assert.strictEqual(at(el, 'after', 'm')[1], height + 30, 'what follows');
    cleanup();
  }
  // and a container taller than its content balances it all the same
  const { node } = await render(
    SHEET +
      `<div class="m" id="m" style="height:200px">${p('a', 5)}${p('b', 4)}` +
      '</div>',
    700,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'a', 'm'), [0, 10, 280, 100], 'one column');
  assert.deepStrictEqual(at(el, 'b', 'm'), [320, 0, 280, 80], 'the other');
});

metric(
  'a box a break falls inside is drawn a piece a column, its edges where it ends',
  async () => {
    // a padded, bordered box around two paragraphs: its top edge in the first
    // column, its bottom in the second, and no edge at the break
    const { node } = await render(
      SHEET +
        '<div class="m" id="m"><div id="w" style="padding:10px;' +
        `border:5px solid #999;background:#cde">${p('a', 4)}${p('b', 5)}` +
        `</div>${p('c', 3)}</div>`,
      700,
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 160, 'the columns');
    assert.deepStrictEqual(at(el, 'w', 'm'), [0, 0, 600, 160], 'its rect');
    assert.deepStrictEqual(
      placed(el, 'b', 'm'),
      [
        [0, 115],
        [0, 135],
        [1, 0],
        [1, 20],
        [1, 40],
      ],
      "the second paragraph's lines",
    );
    const ops: PaintOp[] = [];
    await fillsOf(el, ops);
    const ground = parseColor('#cde');
    // each fill of its background, and the clip it was drawn under
    const pieces: number[][] = [];
    let clip: number[] | null = null;
    for (const op of ops) {
      if (op.op === 'clip') clip = [op.x, op.y, op.w, op.h];
      else if (op.op === 'fill' && op.style === ground && clip)
        pieces.push(clip);
    }
    assert.deepStrictEqual(
      pieces,
      [
        [0, 0, 280, 160],
        [320, 0, 280, 85],
      ],
      'its background, cut to each piece',
    );
    // and the paragraph's text is drawn in each column, cut to its lines
    const drawn = ops.filter((op) => op.op === 'text');
    const xs = new Set(drawn.map((op) => (op as { x: number }).x));
    assert.ok(xs.has(15) && xs.has(335), `text in both columns: ${[...xs]}`);
  },
);

metric(
  'a point between the pieces of a broken box is not over it',
  async () => {
    const { node } = await render(
      SHEET +
        `<div class="m" id="m">${p('a', 3)}${p('b', 3)}${p('c', 3)}</div>`,
      700,
    );
    const el = view(node);
    const over = (x: number, y: number) =>
      el.elementAtPoint(x, y)?.attribs.id ?? null;
    // the second paragraph is at the foot of the first column and the head
    // of the second, and its rect takes in both columns whole
    assert.strictEqual(over(100, 90), 'b', 'its first piece');
    assert.strictEqual(over(420, 10), 'b', 'its second');
    assert.strictEqual(over(100, 30), 'a', 'the paragraph above its first');
    assert.strictEqual(over(420, 60), 'c', 'the one under its second');
    assert.strictEqual(over(300, 60), 'm', 'the gap between the columns');
  },
);

test('a multicol container is as wide as its columns where its content sets its width', async () => {
  // floated, so as wide as its content: two columns of it and the gap
  const { node } = await render(
    SHEET +
      '<div class="m" id="m" style="width:auto;float:left">' +
      '<div class="u" style="width:50px"></div>' +
      '<div class="u" style="width:70px"></div></div>',
    700,
  );
  assert.strictEqual(boxOf(view(node), 'm').width, 180, 'two columns, a gap');
});

test('what is out of the flow in columns stands where it would have, in its column', async () => {
  // an absolute box after the first column's last block: under it, where
  // the flow left off, and not at the head of the next column
  const { node } = await render(
    SHEET +
      '<div class="m" id="m" style="position:relative">' +
      '<div class="u" style="height:80px"></div>' +
      '<div id="x" style="position:absolute;width:20px;height:10px"></div>' +
      '<div class="u" style="height:60px" id="b"></div></div>',
    700,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'b', 'm'), [320, 0, 280, 60], 'the column on');
  assert.deepStrictEqual(at(el, 'x', 'm'), [0, 100, 20, 10], 'where it was');
});

test('columns run from the right in a right-to-left container', async () => {
  const { node } = await render(
    SHEET +
      '<div class="m" id="m" dir="rtl"><div class="u" id="a" ' +
      'style="height:80px"></div><div class="u" id="b" style="height:60px">' +
      '</div></div>',
    700,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'a', 'm'), [320, 10, 280, 80], 'the first');
  assert.deepStrictEqual(at(el, 'b', 'm'), [0, 0, 280, 60], 'to its left');
});

metric('a point in a column is over the text of the line there', async () => {
  // the paragraph's one text layout is set in two columns, and a point at
  // the second column's line is in that line, not in the one the layout
  // has at that height
  const { node } = await render(
    SHEET +
      '<div style="height:50px"></div>' +
      `<div class="m" id="m">${p('a', 3)}${p('b', 3)}${p('c', 3)}</div>`,
    700,
  );
  const el = view(node);
  const all = el.textContent();
  const word = (x: number, y: number) => {
    const at = el.textIndexAt(x, y);
    return all.slice(at, at + 3);
  };
  // `b`'s third line is at the head of the second column
  assert.strictEqual(word(321, 60), 'b 3', 'the head of the second column');
  assert.strictEqual(word(1, 140), 'b 1', 'the foot of the first');
  assert.strictEqual(word(321, 90), 'c 1', 'the paragraph under it');
  // and a point just under the first column is nearest its last line
  // still, where the layout has the paragraph's third line at that height
  assert.strictEqual(word(1, 173), 'b 2', 'under the first column');
});

metric(
  'a float that cannot be cut goes to a column with the lines beside it',
  async () => {
    // A float three lines tall that clips, at the head of a paragraph of
    // five, where two of its lines fit the column: no break falls beside the
    // float, so the columns are as tall as holds all three. A browser takes
    // the float to the next column and sets the two lines without it; this
    // moves what was laid out, and a line is as wide as the float left it.
    const { node } = await render(
      SHEET +
        `<div class="m" id="m">${p('a', 2)}<p id="b"><span id="f" ` +
        'style="float:left;width:50px;height:60px;overflow:hidden"></span>' +
        `${text('b', 5)}</p>${p('c', 1)}</div>`,
      700,
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 120, 'the columns');
    assert.deepStrictEqual(
      placed(el, 'b', 'm').map(([c]) => c),
      [0, 0, 0, 1, 1],
      'the lines beside it stay with it',
    );
    assert.deepStrictEqual(at(el, 'f', 'm'), [0, 60, 50, 60], 'the float');
  },
);

metric(
  'a float with nothing in it is cut where the column ends, and the lines break as they would',
  async () => {
    // the same float, not clipping: two of the paragraph's lines stay and
    // three go, as without it, and the float is 40px at the foot of the first
    // column and its last 20px at the head of the second
    const { node } = await render(
      SHEET +
        `<div class="m" id="m">${p('a', 2)}<p id="b"><span id="f" ` +
        'style="float:left;width:50px;height:60px;background:#cde;' +
        'box-sizing:border-box;border-bottom:5px solid #010203"></span>' +
        `${text('b', 5)}</p>${p('c', 1)}</div>`,
      700,
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 100, 'the columns');
    assert.deepStrictEqual(
      placed(el, 'b', 'm').map(([c]) => c),
      [0, 0, 1, 1, 1],
      'two lines and three',
    );
    assert.deepStrictEqual(at(el, 'f', 'm'), [0, 0, 370, 100], 'its rect');
    assert.deepStrictEqual(
      await piecesOf(el, '#cde'),
      [
        [0, 60, 50, 40],
        [320, 0, 50, 20],
      ],
      'its two pieces',
    );
    // each the whole float standing in its column, cut: its bottom border
    // is below the first piece, and at the foot of the second
    const border = (await fillsOf(el)).filter(
      (f) => f.style === parseColor('#010203'),
    );
    assert.deepStrictEqual(
      border.map((f) => [f.x, f.y, f.h]),
      [
        [0, 115, 5],
        [320, 15, 5],
      ],
      'its border, where the whole float has it',
    );
  },
);

metric('the pieces of a broken box move with its container', async () => {
  // a container a relative offset moves after it is laid out: the pieces
  // kept beside each broken box go with it
  const { node } = await render(
    SHEET +
      '<div class="m" id="m" style="position:relative;left:30px;top:50px">' +
      `${p('a', 3)}<p id="b" style="background:#cde">${text('b', 3)}</p>` +
      `${p('c', 3)}</div>`,
    700,
  );
  const el = view(node);
  const ops: PaintOp[] = [];
  await fillsOf(el, ops);
  const ground = parseColor('#cde');
  const pieces: number[][] = [];
  let clip: number[] | null = null;
  for (const op of ops) {
    if (op.op === 'clip') clip = [op.x, op.y, op.w, op.h];
    else if (op.op === 'fill' && op.style === ground && clip) pieces.push(clip);
  }
  assert.deepStrictEqual(
    pieces,
    [
      [30, 130, 280, 40],
      [350, 50, 280, 20],
    ],
    'each piece, where the offset put it',
  );
  assert.strictEqual(
    el.elementAtPoint(360, 60)?.attribs.id,
    'b',
    'and under the pointer there',
  );
});

metric(
  'a box that is broken at one width and not at another has no piece left over',
  async () => {
    // columns by `column-width`: two at 600px, and one at 250px, where the
    // paragraph that was in two pieces is whole again — in the same boxes,
    // which a resize lays out again and does not rebuild
    const source =
      '<style>body{margin:0;font:16px/20px sans-serif}p{margin:10px 0}' +
      '.m{column-width:200px;column-gap:40px}</style>' +
      `<div class="m" id="m">${p('a', 3)}<p id="b" style="background:#cde">` +
      `${text('b', 3)}</p>${p('c', 3)}</div>`;
    const doc = (width: number) =>
      h(
        'box',
        { style: { width, flexDirection: 'column' } },
        h(Html, { source, partial: false, 'data-testname': 'doc' }),
      );
    const result = await renderX11(doc(600), {
      width: 700,
      height: 600,
      fonts: FONTS!,
    });
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const ground = parseColor('#cde');
    const grounds = async () =>
      (await fillsOf(el))
        .filter((f) => f.style === ground)
        .map((f) => [f.x, f.y, f.w, f.h]);
    assert.strictEqual((await grounds()).length, 2, 'two pieces');
    const box = boxOf(el, 'b');
    await act(() => result.rerender(doc(250)));
    await act();
    assert.strictEqual(boxOf(el, 'b') === box, true, 'the same box');
    assert.deepStrictEqual(
      await grounds(),
      [[0, 80, 250, 60]],
      'one box, in one column',
    );
    assert.strictEqual(
      el.elementAtPoint(200, 30)?.attribs.id,
      'a',
      'and no piece of it under the pointer where one was',
    );
  },
);

metric(
  'text set straight in a multicol container goes to its columns a line at a time',
  async () => {
    const { node } = await render(
      SHEET + `<div class="m" id="m">${text('m', 7)}</div>`,
      700,
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 80, 'the columns');
    assert.deepStrictEqual(
      placed(el, 'm', 'm').map(([c, y]) => `${c}:${y}`),
      ['0:0', '0:20', '0:40', '0:60', '1:0', '1:20', '1:40'],
      'four lines and three',
    );
  },
);

metric(
  'a repaint of part of a column draws the lines that are there',
  async () => {
    // the lines of a paragraph in two columns are not one under another: the
    // one at the head of the second column comes after two lower down
    const { node } = await render(
      SHEET +
        `<div class="m" id="m">${p('a', 3)}<p id="b" style="` +
        `text-shadow:1px 1px 2px red">${text('b', 3)}</p>${p('c', 3)}</div>`,
      700,
    );
    const el = view(node);
    const ops: PaintOp[] = [];
    await fillsOf(el, ops, { damage: { x: 0, y: 0, width: 700, height: 20 } });
    const drawn = ops.filter((op) => op.op === 'text') as {
      x: number;
      shadow?: unknown;
    }[];
    assert.ok(
      drawn.some((op) => op.x === 320 && !op.shadow),
      `the line at the head of the second column: ${JSON.stringify(drawn)}`,
    );
    // and its shadow is cast in each column the paragraph is in
    ops.length = 0;
    await fillsOf(el, ops);
    // the layout's origin in each: the two lines of the first column are
    // 80px down it, and the third is at the head of the second, 40px down
    // the layout — 120px apart, wherever a face's leading puts the origin
    const shadows = [
      ...new Set(
        ops
          .filter((op) => op.op === 'text' && op.shadow)
          .map((op) => Math.round((op as { y: number }).y)),
      ),
    ].sort((a, b) => a - b);
    assert.strictEqual(
      shadows.length,
      2,
      `a shadow in each column: ${shadows}`,
    );
    assert.strictEqual(
      shadows[1] - shadows[0],
      120,
      'each where its lines are',
    );
  },
);

test('a box with nothing in it is cut at the foot of a column and goes on in the next', async () => {
  // no line and no box for a break to fall inside, so it falls anywhere:
  // 200px of box in two columns is 100px in each
  const { node } = await render(
    SHEET +
      '<div class="m" id="m"><div id="a" style="height:200px;' +
      'background:#cde"></div></div>' +
      // and boxes of 50, 130 and 20: the second is cut after 50px
      '<div class="m" id="n"><div style="height:50px"></div>' +
      '<div id="b" style="height:130px;background:#edc"></div>' +
      '<div id="c" style="height:20px"></div></div>' +
      // a bordered one keeps its edges at its ends, and none at the cut
      '<div class="m" id="o"><div style="height:60px"></div><div id="d" ' +
      'style="height:60px;padding:10px;border:5px solid #333;' +
      'background:#dce"></div></div>',
    700,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'm').height, 100, 'two columns of it');
  assert.deepStrictEqual(at(el, 'a', 'm'), [0, 0, 600, 100], 'its rect');
  assert.deepStrictEqual(
    await piecesOf(el, '#cde'),
    [
      [0, 0, 280, 100],
      [320, 0, 280, 100],
    ],
    'a piece a column',
  );
  assert.strictEqual(boxOf(el, 'n').height, 100, 'the second container');
  const top = boxOf(el, 'n').y;
  assert.deepStrictEqual(
    await piecesOf(el, '#edc'),
    [
      [0, top + 50, 280, 50],
      [320, top, 280, 80],
    ],
    'cut where the column ends',
  );
  assert.deepStrictEqual(at(el, 'c', 'n'), [320, 80, 280, 20], 'what follows');
  const third = boxOf(el, 'o').y;
  assert.strictEqual(boxOf(el, 'o').height, 75, 'the third');
  assert.deepStrictEqual(
    await piecesOf(el, '#dce'),
    [
      [0, third + 60, 280, 15],
      [320, third, 280, 75],
    ],
    'its padding and border, cut with it',
  );
});

metric('column-fill: auto fills each column before the next', async () => {
  // in a container with a height, a column that tall: the second
  // paragraph, one line of which fits, goes to the next whole
  let { node } = await render(
    SHEET +
      '<div class="m" id="m" style="height:100px;column-fill:auto">' +
      `${p('a', 3)}${p('b', 3)}</div>`,
    700,
  );
  let el = view(node);
  assert.deepStrictEqual(at(el, 'a', 'm'), [0, 10, 280, 60], 'the first');
  assert.deepStrictEqual(at(el, 'b', 'm'), [320, 0, 280, 60], 'the next');
  cleanup();
  // with no height there is nothing to fill a column to: one holds it all
  ({ node } = await render(
    SHEET +
      `<div class="m" id="m" style="column-fill:auto">${p('a', 3)}` +
      `${p('b', 3)}</div>`,
    700,
  ));
  el = view(node);
  assert.strictEqual(boxOf(el, 'm').height, 150, 'as tall as its content');
  assert.deepStrictEqual(at(el, 'b', 'm'), [0, 80, 280, 60], 'in one column');
  cleanup();
  // and under a `max-height` it does not reach, it is as tall as it is
  ({ node } = await render(
    SHEET +
      '<div class="m" id="m" style="max-height:100px;column-fill:auto">' +
      `${p('a', 2)}</div>`,
    700,
  ));
  assert.strictEqual(boxOf(view(node), 'm').height, 60, 'its content');
});

metric(
  'a column is no shorter than the lines orphans and widows keep together',
  async () => {
    // Two paragraphs of two lines in four columns: a quarter of the content
    // is a line and a half, and a column is the two lines `widows` keeps
    // together (as Blink balances: the tallest thing that cannot break).
    // The first paragraph, under its margin, still breaks after a line —
    // `orphans: 1` lets it — and the second is whole in the third column.
    const { node } = await render(
      SHEET +
        '<div class="m" id="m" style="column-count:4;orphans:1">' +
        `${p('a', 2)}${p('b', 2)}</div>`,
      700,
    );
    const el = view(node);
    const columns = (id: string) =>
      linesOf(el, id).map((line) =>
        Math.round((line.x - boxOf(el, 'm').x) / 160),
      );
    assert.strictEqual(boxOf(el, 'm').height, 40, 'two lines tall');
    assert.deepStrictEqual(columns('a'), [0, 1], 'a line and a line');
    assert.deepStrictEqual(columns('b'), [2, 2], 'the second, whole');
  },
);

test('the room clearance leaves is room the columns take, not a margin a break drops', async () => {
  // A float 250px tall in columns of 100px is 100px, 100px and 50px of
  // them, and a box that clears it comes under its end, half way down the
  // third: the clearance is no margin, which a break would drop and set
  // the box at the head of the second.
  const columns =
    '<style>body{margin:0}.m{width:300px;column-count:3;column-gap:0}' +
    '.f{float:left;width:15px;background:#cde}</style>';
  let { node } = await render(
    columns +
      '<div class="m" id="m" style="height:100px;column-fill:auto">' +
      '<div><div class="f" id="f" style="height:250px"></div></div>' +
      '<div id="c" style="clear:left;height:5px"></div></div>',
    400,
  );
  let el = view(node);
  assert.deepStrictEqual(
    await piecesOf(el, '#cde'),
    [
      [0, 0, 15, 100],
      [100, 0, 15, 100],
      [200, 0, 15, 50],
    ],
    'the float, a piece a column',
  );
  assert.deepStrictEqual(at(el, 'c', 'm'), [200, 50, 100, 5], 'under it');
  cleanup();
  // balanced, the columns share out all the content reaches: past a box of
  // no height, what stands out of it
  ({ node } = await render(
    columns +
      '<div class="m" id="m"><div style="height:10px"></div>' +
      '<div><div class="f" style="height:240px"></div></div>' +
      '<div style="clear:left;height:0"><div id="c" ' +
      'style="border-bottom:5px solid"></div></div></div>',
    400,
  ));
  el = view(node);
  assert.strictEqual(boxOf(el, 'm').height, 85, 'a third of 255px');
  assert.deepStrictEqual(at(el, 'c', 'm'), [200, 80, 100, 5], 'at its foot');
});

test('a box under size containment goes whole', async () => {
  // it is monolithic (CSS Containment 2, 3.1): a float of 100px in two
  // columns is not 50px in each
  const { node } = await render(
    '<style>body{margin:0}</style><div id="m" style="width:300px;' +
      'column-count:2;column-gap:0"><div id="f" style="float:left;' +
      'width:100%;height:100px;contain:size"></div></div>',
    400,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'm').height, 100, 'as tall as the float');
  assert.deepStrictEqual(at(el, 'f', 'm'), [0, 0, 150, 100], 'in one column');
});

test('a float that outlasts the flow beside it is cut where the column ends', async () => {
  // A float 150px tall, two blocks deep, beside 50px of flow that one
  // column holds: the columns share out the float's height, and it is cut
  // at the foot of the first.
  const sheet =
    '<style>body{margin:0}.m{width:200px;column-count:2;column-gap:0}' +
    '.f{float:left;width:20px;background:#cde}.w{overflow:hidden}</style>';
  let { node } = await render(
    sheet +
      '<div class="m" id="m"><div><div><div class="f" ' +
      'style="height:150px"></div></div></div>' +
      '<div class="w" style="height:50px"></div></div>',
    300,
  );
  let el = view(node);
  assert.strictEqual(boxOf(el, 'm').height, 75, 'half the float');
  assert.deepStrictEqual(
    await piecesOf(el, '#cde'),
    [
      [0, 0, 20, 75],
      [100, 0, 20, 75],
    ],
    'a piece a column',
  );
  cleanup();
  // and one that starts where a break dropped a margin starts at the head
  // of the next column, with the box the margin was before
  ({ node } = await render(
    sheet +
      '<div class="m" id="m" style="height:60px;column-fill:auto">' +
      '<div class="w" style="height:60px;margin-bottom:20px"></div>' +
      '<div class="f" id="f" style="height:30px"></div>' +
      '<div class="w" id="b" style="height:40px"></div></div>',
    300,
  ));
  el = view(node);
  assert.deepStrictEqual(at(el, 'f', 'm'), [100, 0, 20, 30], 'the float');
  assert.deepStrictEqual(at(el, 'b', 'm'), [120, 0, 80, 40], 'beside it');
  cleanup();
  // the margin the next box's, and the float set before it: past the foot
  // of its column, which is the head of the next
  ({ node } = await render(
    sheet +
      '<div class="m" id="m" style="height:60px;column-fill:auto">' +
      '<div class="w" style="height:60px"></div>' +
      '<div class="f" id="f" style="height:30px"></div>' +
      '<div class="w" id="b" style="height:40px;margin-top:20px"></div>' +
      '</div>',
    300,
  ));
  el = view(node);
  assert.deepStrictEqual(at(el, 'f', 'm'), [100, 0, 20, 30], 'at the head');
  assert.deepStrictEqual(at(el, 'b', 'm'), [120, 0, 80, 40], 'and the box');
});

metric(
  'a line set below a float is a line of its block still, and the room above it is cut',
  async () => {
    // Three lines with a float as wide as the column after the first: the
    // second is set below it. `orphans: 3` keeps the three together, and
    // they go to the second column with the float between them.
    let { node } = await render(
      '<style>body{margin:0;font:16px/25px sans-serif}</style>' +
        '<div id="m" style="width:200px;columns:2;column-gap:0;' +
        'column-fill:auto;height:100px;orphans:3;widows:1">' +
        '<div><div style="height:25px"></div><br><div id="f" ' +
        'style="float:left;width:100%;height:25px"></div>&nbsp;<br><br>' +
        '</div></div>',
      300,
    );
    let el = view(node);
    assert.deepStrictEqual(at(el, 'f', 'm'), [100, 25, 100, 25], 'the float');
    assert.deepStrictEqual(
      linesOf(el, 'm').map((line) => [line.x, line.y]),
      [
        [100, 0],
        [100, 50],
        [100, 75],
      ],
      'its lines about it',
    );
    cleanup();
    // and a line set below a float taller than the columns: the room above
    // it is the float's two columns and a half, which a break cuts and
    // does not drop, so the line comes under the float's end
    ({ node } = await render(
      '<style>body{margin:0;font:16px/25px sans-serif}</style>' +
        '<div id="m" style="width:300px;columns:3;column-gap:0;' +
        'column-fill:auto;height:100px"><div id="c">a<br><span ' +
        'style="float:left;width:100%;height:250px"></span>b</div></div>',
      400,
    ));
    el = view(node);
    assert.deepStrictEqual(
      linesOf(el, 'c').map((line) => [line.x, line.y]),
      [
        [0, 0],
        [200, 75],
      ],
      'the second line, under the float in the third column',
    );
  },
);

metric(
  'a block that goes on from a column before keeps its widows from the lines it has left',
  async () => {
    // Seven lines, three to a column. Each column counts the lines set from
    // it on: where not even all of those are as many as `widows`, it breaks
    // where it would, and where some are, as many go as leave `orphans`.
    const columns = async (style: string) => {
      const { node } = await render(
        '<style>body{margin:0;font:16px/20px sans-serif}p{margin:0}</style>' +
          '<div id="m" style="width:900px;columns:3;column-gap:0;' +
          `column-fill:auto;height:60px;${style}"><p id="p">${text('p', 7)}` +
          '</p></div>',
        1000,
      );
      const out = linesOf(view(node), 'p')
        .map((line) => line.x / 300)
        .join('');
      cleanup();
      return out;
    };
    assert.strictEqual(await columns('widows:2'), '0001122', 'two go');
    assert.strictEqual(await columns('widows:3'), '0001122', 'two stay');
    assert.strictEqual(
      await columns('widows:5'),
      '0011122',
      'five from the first column, and then as it falls',
    );
    assert.strictEqual(
      await columns('widows:4;orphans:1'),
      '0001112',
      'four cannot be had of the four left',
    );
  },
);

test('a break comes before a box only where it would gain the box room', async () => {
  const sheet =
    '<style>body{margin:0}.m{columns:2;column-gap:0;column-fill:auto;' +
    'width:200px;height:100px;margin-bottom:60px}' +
    '.c{height:120px;overflow:hidden}</style>';
  const { node } = await render(
    sheet +
      // after a border and an empty box: the next column is 10px more
      '<div class="m" id="m1"><div style="border-top:10px solid">' +
      '<div id="e1"></div><div class="c" id="c1"></div></div></div>' +
      // after an empty box and nothing else: it is at the column's head
      // already, and stays there, hanging out
      '<div class="m" id="m2"><div><div></div>' +
      '<div class="c" id="c2"></div></div></div>' +
      // all of it fits but the padding under it, of the box it ends, and
      // there is nothing in the column to break before: the padding hangs
      // out, and the box is not taken from under its border for it
      '<div class="m" id="m3" style="columns:1;width:100px">' +
      '<div style="border-top:10px solid"><div></div>' +
      '<div style="padding-bottom:50px"><div class="c" id="c3" ' +
      'style="height:90px"></div></div></div></div>' +
      // and nothing at all takes no room: the empty end of an inline box
      // broken about a block, after the block has hung out of its column,
      // is where the block ends and starts no column of its own
      '<div class="m" id="m4"><div id="o4" style="border-top:10px solid">' +
      '<span><div class="c" id="c4"></div></span></div></div>',
    300,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'e1', 'm1'), [0, 10, 100, 0], 'the empty box');
  assert.deepStrictEqual(at(el, 'c1', 'm1'), [100, 0, 100, 120], 'a column on');
  assert.deepStrictEqual(at(el, 'c2', 'm2'), [0, 0, 100, 120], 'where it was');
  assert.deepStrictEqual(
    at(el, 'c3', 'm3'),
    [0, 10, 100, 90],
    'under its border',
  );
  assert.deepStrictEqual(at(el, 'c4', 'm4'), [100, 0, 100, 120], 'a column on');
  assert.deepStrictEqual(at(el, 'o4', 'm4'), [0, 0, 200, 120], 'two columns');
});
