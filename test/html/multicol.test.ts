// <Html> — multi-column layout: the columns, where they break, and the
// pieces of what a break falls inside.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { parseColor } from '../../src/html/css/values.js';
import { COLUMN_PIECES, columned } from '../../src/html/layout/boxes.js';
import {
  REPEATED,
  gridRowsBroken,
  stripReach,
} from '../../src/html/layout/multicol.js';
import { resolvedInsets } from '../../src/html/layout/block.js';
import {
  FONTS,
  boxOf,
  fillsOf,
  findById,
  h,
  linesOf,
  metric,
  render,
  renderScrolled,
  rulesIn,
  view,
} from './harness.js';
import type { PaintOp } from './harness.js';
import {
  GRID_ROWS_DOCUMENT,
  GRID_ROWS_KNOWN,
  GRID_ROWS_RECTS,
} from './grid-rows.js';

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

test('column-rule is drawn down the gaps between the columns that hold something', async () => {
  // two columns of 80px, 40px apart: the rule on the gap's middle, 300,
  // as tall as the columns
  const blocks = (n: number) => '<div class="u"></div>'.repeat(n);
  assert.deepStrictEqual(
    await rulesIn(
      SHEET +
        `<div class="m" style="column-rule:2px solid #ff0000">${blocks(5)}</div>`,
      '#ff0000',
    ),
    [[299, 0, 2, 80]],
  );
  // three columns of 173⅓px, and only two of them with anything in: one
  // rule, on the first gap's middle at 193⅓
  assert.deepStrictEqual(
    await rulesIn(
      SHEET +
        '<div class="m" style="column-count:3;column-fill:auto;height:80px;' +
        `column-rule:2px solid #ff0000">${blocks(3)}</div>`,
      '#ff0000',
    ),
    [[192, 0, 2, 80]],
  );
  // a box that spans the columns breaks the rule: a piece above it and a
  // piece below, each as tall as its row of columns
  const spanned = await rulesIn(
    SHEET +
      '<div class="m" style="column-rule:4px solid #ff0000">' +
      blocks(4) +
      '<div style="column-span:all;height:30px"></div>' +
      blocks(4) +
      '</div>',
    '#ff0000',
  );
  assert.strictEqual(spanned.length, 2, JSON.stringify(spanned));
  assert.ok(
    spanned[0][1] + spanned[0][3] <= spanned[1][1] - 30,
    `the spanner between them: ${JSON.stringify(spanned)}`,
  );
  // nothing where the style draws nothing
  assert.deepStrictEqual(
    await rulesIn(
      SHEET +
        `<div class="m" style="column-rule:2px #ff0000">${blocks(5)}</div>`,
      '#ff0000',
    ),
    [],
  );
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

test('a box that spans the columns is set across them, between rows of columns', async () => {
  // `column-span: all` (CSS Multi-column 1, 6): what comes before it is
  // balanced in columns of its own, it is set under them the container's
  // width, and what follows in columns under it. Its margins are its own:
  // they collapse with no margin of the columns' content.
  const span = (id: string, style = '') =>
    `<div id="${id}" style="column-span:all;height:30px;margin:10px 0;${style}"></div>`;
  const u = (id: string, height: number) =>
    `<div class="u" id="${id}" style="height:${height}px"></div>`;
  const { node } = await render(
    SHEET +
      `<div class="m" id="m">${u('a', 60)}${u('b', 60)}${span('s')}` +
      `${u('c', 40)}${u('d', 40)}${u('e', 40)}</div>` +
      // first, and last: its margins stay inside the container
      `<div class="m" id="n">${span('t')}${u('f', 60)}${u('g', 60)}</div>` +
      `<div class="m" id="o">${u('h', 60)}${u('i', 60)}${span('v')}</div>` +
      // two of them: the margins between them collapse
      `<div class="m" id="p">${u('j', 40)}${u('k', 40)}` +
      `${span('w', 'margin:20px 0 5px')}${span('x', 'margin:15px 0 25px')}` +
      `${u('l', 40)}</div>`,
    700,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'm').height, 215, 'two rows and the spanner');
  assert.deepStrictEqual(at(el, 'a', 'm'), [0, 10, 280, 60], 'the first row');
  assert.deepStrictEqual(
    at(el, 'b', 'm'),
    [320, 0, 280, 60],
    'its second column',
  );
  assert.deepStrictEqual(
    at(el, 's', 'm'),
    [0, 85, 600, 30],
    'across, under it',
  );
  assert.deepStrictEqual(at(el, 'c', 'm'), [0, 135, 280, 40], 'the second row');
  assert.deepStrictEqual(
    at(el, 'd', 'm'),
    [320, 125, 280, 40],
    'balanced again',
  );
  assert.deepStrictEqual(at(el, 'e', 'm'), [320, 175, 280, 40], 'under it');
  assert.deepStrictEqual(
    at(el, 't', 'n'),
    [0, 10, 600, 30],
    'first: its margin',
  );
  assert.deepStrictEqual(
    at(el, 'f', 'n'),
    [0, 60, 280, 60],
    'and the row under',
  );
  assert.strictEqual(boxOf(el, 'n').height, 125, 'the container');
  assert.deepStrictEqual(at(el, 'v', 'o'), [0, 85, 600, 30], 'last');
  assert.strictEqual(boxOf(el, 'o').height, 125, 'its margin inside');
  assert.deepStrictEqual(
    at(el, 'w', 'p'),
    [0, 75, 600, 30],
    'the first of two',
  );
  assert.deepStrictEqual(
    at(el, 'x', 'p'),
    [0, 120, 600, 30],
    '15px on, not 20',
  );
  assert.deepStrictEqual(
    at(el, 'l', 'p'),
    [0, 185, 280, 40],
    'and what follows',
  );
});

test('column-span does nothing on a box that is not block-level', async () => {
  // an inline-block is on a line, which is in a column
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="m" style="width:400px;column-count:4;column-gap:0">' +
      '<div id="s" style="column-span:all;display:inline-block;width:80px;' +
      'height:50px"></div></div>',
    500,
  );
  const s = boxOf(view(node), 's');
  assert.deepStrictEqual([s.x, s.width], [0, 80], 'in the first column');
});

test('a box that spans the columns from inside a block breaks the block about it, and balances the row before it', async () => {
  // CSS Multi-column 1, 6: a spanner in a block in the container's flow
  // spans the container's columns, the block around it in a row before it
  // and one after it; and the columns before a spanner are balanced
  // whatever `column-fill` says (7.1). Chrome's numbers, from WPT
  // css-anchor-position/anchor-position-multicol-colspan-002: the block's
  // rect takes in its pieces in both rows
  const { node } = await render(
    '<style>body{margin:0}.m{column-count:2;column-fill:auto;' +
      'column-gap:10px;width:210px;height:100px}</style>' +
      '<div class="m" id="m"><div style="height:50px"></div>' +
      '<div id="w"><div id="a" style="margin-left:10px;width:40px">' +
      '<div style="height:10px"></div>' +
      '<div id="s" style="column-span:all;height:20px"></div>' +
      '<div id="b" style="height:30px"></div></div></div></div>' +
      // a spanner the container's child, after content of its own height
      '<div class="m" id="n"><div id="c" style="height:40px"></div>' +
      '<div id="t" style="column-span:all;height:20px"></div></div>',
    300,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 's', 'm'), [0, 30, 210, 20], 'across, at 30');
  assert.deepStrictEqual(
    at(el, 'a', 'm'),
    [10, 20, 150, 60],
    'the block, around its pieces',
  );
  assert.deepStrictEqual(at(el, 'b', 'm'), [10, 50, 40, 30], 'under it');
  assert.strictEqual(
    COLUMN_PIECES.get(boxOf(el, 'a') as never)?.length,
    2,
    'two',
  );
  assert.deepStrictEqual(
    at(el, 't', 'n'),
    [0, 20, 210, 20],
    'under 40px balanced, not under a column of it',
  );
  assert.deepStrictEqual(at(el, 'c', 'n'), [0, 0, 210, 20], 'in both');
});

test('a box its content runs out of is its height across its pieces, the room a break leaves taken out of it', async () => {
  // Chrome's numbers, from WPT's css-break/grid/grid-item-fragmentation-017
  // as a block and as a grid item: lines of 50, 100 and 100 in a box 200
  // tall, the second pushed to the next column. The box is 100 in each of
  // two columns, and the third line runs out of it; the room the push left
  // was added to it, and it went on 50 into a third column
  const { node } = await render(
    '<style>body{margin:0}.m{columns:2;column-gap:0;width:100px;' +
      'height:100px;margin-bottom:10px}.m i{display:inline-block;' +
      'width:50px}</style>' +
      '<div class="m"><div id="b" style="line-height:0;height:200px">' +
      '<i style="height:50px"></i><i style="height:100px"></i>' +
      '<i style="height:100px"></i></div></div>' +
      '<div class="m"><div style="display:grid;grid-template-rows:200px">' +
      '<div id="g" style="line-height:0"><i style="height:50px"></i>' +
      '<i style="height:100px"></i><i style="height:100px"></i></div>' +
      '</div></div>',
    300,
  );
  const el = view(node);
  const heights = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => p.height);
  assert.deepStrictEqual(heights('b'), [100, 100], 'the block');
  assert.deepStrictEqual(heights('g'), [100, 100], 'the grid item');
});

test('what is positioned after a spanner in a block it breaks stands where that row of columns starts', async () => {
  // the block is in the strip as its first row has it, and the box out of
  // the flow in its second row stood from where that row had the block:
  // taken from the first, it came out at the container's top, in the row
  // before the spanner. Chrome's numbers
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="column-count:2;column-fill:auto;column-gap:0;' +
      'height:140px;width:100px"><div style="position:relative">' +
      '<div style="height:60px"></div>' +
      '<div style="column-span:all;height:5px"></div>' +
      '<div id="a" style="position:absolute;width:50px;height:200px">' +
      '</div></div></div>',
    300,
  );
  const el = view(node);
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(el, 'a') as never)?.map((p) => [
      p.x,
      p.y,
      p.width,
      p.height,
    ]),
    [
      [0, 35, 50, 105],
      [50, 35, 50, 95],
    ],
    'under the spanner, in its row',
  );
});

test('what comes after a spanner in a block it is in is laid out, in a first layout with nothing broken before it', async () => {
  // a box a spanner is in is laid out once a row of columns, and was kept
  // from the row before where no layout had broken anything yet: the
  // block after the spanner was never laid out, and the container was as
  // tall as the spanner (WPT css-break/out-of-flow-in-multicolumn-006).
  // The flag is the process's, so a test before this one sets it
  columned.any = false;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="m" style="column-count:2;column-gap:0;width:100px">' +
      '<div><div style="column-span:all;height:5px"></div>' +
      '<div id="b" style="height:60px"></div></div></div>',
    300,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'm').height, 35, 'the spanner and 30 under it');
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(el, 'b') as never)?.map((p) => [
      p.x,
      p.y,
      p.width,
      p.height,
    ]),
    [
      [0, 5, 50, 30],
      [50, 5, 50, 30],
    ],
    'the block, balanced in two columns under the spanner',
  );
});

test('a forced break after an item beside another belongs to the row, and goes out to the row around its grid', async () => {
  // Chrome's numbers, from WPT's css-break/grid/grid-item-fragmentation-047:
  // a nested grid in the outer grid's first row holds two items side by
  // side, the first `break-after: column`. That break is after the row,
  // and the nested grid's last row is its last, so it is the outer row's:
  // the second outer row starts the second column. Taken for a break
  // before the item beside it, at the nested grid's top, it was none, and
  // the second row was cut across both columns
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:2;column-gap:0;column-fill:auto;width:100px;' +
      'height:100px"><div style="display:grid;' +
      'grid-template-rows:50px 100px"><div style="display:grid;' +
      'grid-template-columns:auto auto"><div style="break-after:column">' +
      '</div><div></div></div><div id="b"></div></div></div>',
    300,
  );
  const el = view(node);
  const b = boxOf(el, 'b');
  assert.deepStrictEqual(
    [b.x, b.y, b.width, b.height],
    [50, 0, 50, 100],
    'the second row, whole in the second column',
  );
  assert.strictEqual(COLUMN_PIECES.get(b as never), undefined, 'not cut');
});

test('what is positioned in a box that spans the columns, and in nothing in it, is positioned in the container', async () => {
  // CSS Multi-column 1, 6: a spanner's containing block is the multicol
  // container, past the boxes it is laid out through; and its offset
  // parent with it, as Blink has it (WPT css-anchor-position/
  // anchor-position-multicol-colspan-001)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="m" style="position:relative;column-count:2;column-gap:10px;' +
      'width:210px"><div style="height:40px"></div>' +
      '<div style="position:relative"><div style="column-span:all;height:20px">' +
      '<div id="t" style="position:absolute;top:5px;left:0;width:10px;' +
      'height:10px"></div></div></div></div>',
    300,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 't', 'm'), [0, 5, 10, 10], "the container's");
  const offset = el.offsetRect(findById(el.document, 't')!)!;
  assert.strictEqual(offset.parent, findById(el.document, 'm'));
  assert.deepStrictEqual([offset.x, offset.y], [0, 5]);
});

test('what is positioned in a block a spanner breaks is laid out against all of it and cut into the columns of both rows', async () => {
  // Each row's content goes on down the strip from the row before's, as
  // Blink's flow thread goes on past a spanner, so a block a spanner
  // breaks is one block there (WPT css-anchor-position/
  // anchor-position-multicol-015, in horizontal writing): a box
  // positioned in it, `height: 100%`, is as tall as both its pieces, and
  // set beside its anchor wherever the columns took the anchor
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:5;gap:0;width:100px;height:100px">' +
      '<div style="height:90px"></div>' +
      '<div id="w" style="position:relative"><div style="height:90px"></div>' +
      '<div id="a" style="anchor-name:--a;width:10px;height:90px"></div>' +
      '<div style="height:130px"></div>' +
      '<div id="t" style="position:absolute;position-anchor:--a;' +
      'position-area:right center;width:10px;height:100%"></div>' +
      '<div style="column-span:all;height:10px"></div>' +
      '<div style="height:50px"></div></div></div>' +
      // and a box of no size where a row before a spanner ends stays at the
      // end of that row, its offsets from its block's first piece (WPT's
      // anchor-position-multicol-colspan-001, a box with no anchor)
      '<div id="m" style="position:relative;columns:2;column-fill:auto;' +
      'gap:10px;width:210px;height:100px"><div style="height:40px"></div>' +
      '<div id="v" style="position:relative">' +
      '<div style="column-span:all;height:20px"></div>' +
      '<div id="u" style="position:absolute"></div>' +
      '</div></div>',
    300,
  );
  const el = view(node);
  const pieces = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => [
      p.x,
      p.y,
      p.width,
      p.height,
    ]);
  assert.deepStrictEqual(pieces('a'), [
    [40, 20, 10, 60],
    [60, 0, 10, 30],
  ]);
  assert.deepStrictEqual(
    pieces('t'),
    [
      [50, 20, 10, 60],
      [70, 0, 10, 30],
    ],
    'beside each piece',
  );
  const offset = el.offsetRect(findById(el.document, 'u')!)!;
  assert.strictEqual(offset.parent, findById(el.document, 'v'));
  assert.deepStrictEqual([offset.x, offset.y], [0, 0]);
});

test('a container as wide as its content is no narrower than a box that spans its columns', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="m" style="float:left;column-count:2;column-gap:40px">' +
      '<div id="a" style="width:50px;height:20px"></div>' +
      '<div id="s" style="column-span:all;width:300px;height:10px"></div>' +
      '<div style="width:70px;height:20px"></div></div>',
    700,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'm').width, 300, 'as wide as the spanner');
  assert.strictEqual(boxOf(el, 'a').x, 0, 'its columns from its edge');
});

metric(
  'columns that can be no taller break a block where they must, orphans or not',
  async () => {
    // A container 150px tall with a spanner across its middle: the row under
    // it has 30px, which is one line under the paragraph's margin and one
    // line a column after it. `orphans: 2` cannot be had, and is not waited
    // for in a column that overflows.
    const { node } = await render(
      SHEET +
        `<div class="m" id="m" style="height:150px">${p('a', 6)}` +
        '<div style="column-span:all;height:30px;margin:10px 0"></div>' +
        `${p('b', 6)}</div>`,
      700,
    );
    const el = view(node);
    assert.deepStrictEqual(
      placed(el, 'b', 'm'),
      [
        [0, 130],
        [1, 120],
        [2, 120],
        [3, 120],
        [4, 120],
        [5, 120],
      ],
      'a line a column',
    );
  },
);

test('an absolutely positioned box whose containing block is broken across columns is laid out unbroken and cut into them, and sees an anchor in them unbroken', async () => {
  // CSS Fragmentation 3; CSS Anchor Positioning 1, 2: a box inside the
  // fragmentation context sees its anchor as unfragmented, and can be
  // fragmented itself. The columns are 80 wide and 50 tall, 10 apart, so the
  // strip's y 50 is the head of the second column, 90 across.
  const { node } = await render(
    '<style>body{margin:0}.c{columns:2;column-fill:auto;column-gap:10px;width:170px;height:50px}' +
      '.t{position:absolute;left:anchor(--a left);top:anchor(--a top);' +
      'width:anchor-size(--a width);height:anchor-size(--a height)}</style>' +
      '<div class="c"><div style="position:relative;transform:translate(0)">' +
      '<div style="height:30px"></div>' +
      '<div style="anchor-name:--a;width:20px;height:40px;margin-left:5px" id="a"></div>' +
      '<div style="height:30px"></div>' +
      '<div id="cut" style="position:absolute;top:30px;width:10px;height:30px"></div>' +
      '<div class="t" id="t"></div></div></div>',
    400,
  );
  const el = view(node);
  const piecesOf = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => [
      p.x,
      p.y,
      p.width,
      p.height,
    ]);
  // 20 at the foot of the first column, 10 at the head of the second
  assert.deepStrictEqual(piecesOf('cut'), [
    [0, 30, 10, 20],
    [90, 0, 10, 10],
  ]);
  // and anchored to a box broken the same way, its pieces are the anchor's
  assert.deepStrictEqual(piecesOf('a'), [
    [5, 30, 20, 20],
    [95, 0, 20, 20],
  ]);
  assert.deepStrictEqual(piecesOf('t'), piecesOf('a'));
  // and its insets read where the strip had it, not the rectangle around
  // its pieces (WPT anchor-getComputedStyle-002)
  assert.deepStrictEqual(
    resolvedInsets(boxOf(el, 't') as never, 400, 600),
    [30, 55, 30, 5],
  );
});

test('a box in a box broken across columns is cut where it ends, and holds nothing of a column past it', async () => {
  const { node } = await render(
    '<!doctype html><html><head><style>body{margin:0}' +
      '#c{columns:3;column-fill:auto;gap:10px;width:230px;height:100px}' +
      '</style></head><body><div id="c"><div style="height:30px"></div>' +
      '<div id="rel" style="width:100px;height:200px">' +
      '<div style="height:20px"></div>' +
      '<div id="an" style="width:20px;height:70px"></div></div></div>' +
      '</body></html>',
    400,
  );
  const el = view(node);
  // 20 of its 70 are in the second column, and none in the third, which
  // what holds it reaches
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(el, 'an') as never)?.map((p) => [
      p.x,
      p.y,
      p.height,
    ]),
    [
      [0, 50, 50],
      [80, 0, 20],
    ],
  );
});

test('a multicol container in a vertical writing mode sets its columns down the page, as tall as its block size', async () => {
  const { node } = await render(
    '<!doctype html><html><head><style>body{margin:0}' +
      '#c{columns:3;column-fill:auto;gap:10px;inline-size:230px;block-size:100px;' +
      'writing-mode:vertical-rl}</style></head><body><div id="c">' +
      '<div id="a" style="block-size:150px"></div>' +
      '<div id="b" style="block-size:100px"></div></div></body></html>',
    400,
  );
  const el = view(node);
  const rect = (id: string) => {
    const r = el.elementRect(findById(el.document, id) as never)!;
    return [r.x, r.y, r.width, r.height];
  };
  assert.deepStrictEqual(rect('c'), [0, 0, 100, 230]);
  // the first block fills the first column, from the right, and half the
  // second; the second block the rest of that and half the third
  assert.deepStrictEqual(rect('a'), [0, 0, 100, 150]);
  assert.deepStrictEqual(rect('b'), [0, 80, 100, 150]);
});

test("a box positioned in the columns of a vertical writing mode is cut where they are, past the container's borders", async () => {
  const { node } = await render(
    '<!doctype html><html><head><style>body{margin:0}' +
      '#c{border:solid transparent;border-width:3px 5px 7px 9px;columns:3;' +
      'column-fill:auto;gap:10px;inline-size:230px;block-size:100px;' +
      'writing-mode:vertical-rl}' +
      '#an{anchor-name:--a;inline-size:20px;block-size:70px}' +
      '#t{position:absolute;position-anchor:--a;inset:anchor(inside)}' +
      '</style></head><body><div id="c"><div style="block-size:30px"></div>' +
      '<div style="position:relative;inline-size:100px;block-size:200px">' +
      '<div style="block-size:20px"></div><div id="an"></div><div id="t"></div>' +
      '</div></div></body></html>',
    400,
  );
  const el = view(node);
  const pieces = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => [
      p.x,
      p.y,
      p.width,
      p.height,
    ]);
  // over its anchor's pieces, each in the column its anchor's is in
  assert.deepStrictEqual(pieces('t'), pieces('an'));
});

test('a box positioned in a block the columns of a vertical writing mode break is as wide as the block in its column', async () => {
  // A frame lays its positioned boxes out twice in a pass, and the second
  // kept the first's layout (`layoutOwn`), with the rect around the pieces
  // the columns cut it into for its own: `inline-size: 100%` came out three
  // columns wide (WPT css-anchor-position/
  // anchor-position-multicol-colspan-003's anchor)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="writing-mode:vertical-rl;position:relative">' +
      '<div style="columns:5;gap:0;inline-size:100px;block-size:20px;' +
      'column-fill:auto"><div style="position:relative;block-size:70px">' +
      '<div style="block-size:30px"></div>' +
      '<div id="a" style="position:absolute;inline-size:100%;' +
      'block-size:40px"></div></div></div></div>',
    300,
  );
  const el = view(node);
  const pieces = COLUMN_PIECES.get(boxOf(el, 'a') as never) ?? [];
  assert.deepStrictEqual(
    pieces.map((p) => [p.width, p.height]),
    [
      [20, 10],
      [20, 20],
      [20, 10],
    ],
    'a column wide in each, in the frame',
  );
});

test('an anchor a transform scales is broken across the columns as any block is, and is the rectangle around its pieces each scaled about its own origin', async () => {
  // WPT css-anchor-position/transform-006: a block with a height and no
  // content is cut where the columns break it, transform or not (CSS
  // Fragmentation 3, 4.1), and each piece is transformed as it is drawn
  const { el } = await renderScrolled(
    '<style>body{margin:0}.a{position:absolute;position-anchor:--a}</style>' +
      '<div style="position:relative;display:flow-root;width:100px;height:100px">' +
      '<div style="columns:5;column-gap:20px;margin-top:25px;column-fill:auto;height:40px">' +
      '<div style="height:70px"></div>' +
      '<div style="height:20px;transform:scale(2);anchor-name:--a"></div></div>' +
      '<div id="c" class="a" style="position-area:center;width:32px;height:50px"></div>' +
      '<div id="l" class="a" style="position-area:left span-all;width:100%;height:100%"></div></div>',
    400,
    400,
  );
  const at = (id: string) => {
    const box = boxOf(el, id);
    return [box.x, box.y, box.width, box.height];
  };
  // pieces 4 by 10 at 24, 55 and 48, 25, each twice its size about its
  // centre: 22 to 30 and 46 to 54 across, 50 to 70 and 20 to 40 down
  assert.deepStrictEqual(at('c'), [22, 20, 32, 50]);
  assert.deepStrictEqual(at('l').slice(0, 3), [0, 0, 22]);
});

test('what a block is taller than its content is room a column break falls in, and a box that goes whole before it stays in its column', async () => {
  // WPT css-anchor-position/anchor-scroll-003: a scroll container 80 tall
  // ten pixels into the second column fits there, and the 110 its block
  // has under it is cut across the columns as a box with nothing in it is
  const { el } = await renderScrolled(
    '<style>body{margin:0}</style><div style="column-count:3;column-gap:10px;' +
      'width:300px;height:100px"><div style="height:300px"><div style="height:110px">' +
      '</div><div id="s" style="overflow-y:scroll;height:80px"></div></div></div>',
    400,
    400,
  );
  const s = boxOf(el, 's');
  assert.deepStrictEqual([Math.round(s.x), s.y, s.height], [103, 10, 80]);
});

// Flex containers and grids break between their lines and rows and inside
// their items (CSS Flexbox 1, 10; CSS Grid 1, 12), where they went to a
// column whole. Each case is one of WPT's css-break green squares, and the
// numbers are where Chrome draws it.
const COLS =
  '<style>body{margin:0}.m{columns:4;column-fill:auto;gap:0;width:100px;' +
  'height:100px}</style>';

const piecesAt = (el: ReturnType<typeof view>, id: string, from: string) => {
  const base = boxOf(el, from);
  return (COLUMN_PIECES.get(boxOf(el, id) as never) ?? []).map(
    (p: { x: number; y: number; width: number; height: number }) => [
      p.x - base.x,
      p.y - base.y,
      p.width,
      p.height,
    ],
  );
};

test('a column flex box breaks between its items, and inside one', async () => {
  // single-line-column-flex-fragmentation-001
  const { node } = await render(
    COLS +
      '<div class="m" id="m"><div style="display:flex;flex-direction:column;' +
      'height:400px;width:25px" id="f"><div id="a" style="height:50px"></div>' +
      '<div id="b" style="height:350px"></div></div></div>',
    200,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'a', 'm'), [0, 0, 25, 50], 'whole, first');
  assert.deepStrictEqual(
    piecesAt(el, 'b', 'm'),
    [
      [0, 50, 25, 50],
      [25, 0, 25, 100],
      [50, 0, 25, 100],
      [75, 0, 25, 100],
    ],
    'the second item down the rest of the columns',
  );
  assert.strictEqual(piecesAt(el, 'f', 'm').length, 4, 'and the box with it');
});

test('the items of a flex row are each cut where the columns end', async () => {
  // single-line-row-flex-fragmentation: two items side by side, one taller
  const { node } = await render(
    COLS +
      '<div class="m" id="m"><div style="display:flex;align-items:start;' +
      'width:25px"><div id="a" style="width:10px;height:150px"></div>' +
      '<div id="b" style="width:15px;height:250px"></div></div></div>',
    200,
  );
  const el = view(node);
  assert.deepStrictEqual(piecesAt(el, 'a', 'm'), [
    [0, 0, 10, 100],
    [25, 0, 10, 50],
  ]);
  assert.deepStrictEqual(piecesAt(el, 'b', 'm'), [
    [10, 0, 15, 100],
    [35, 0, 15, 100],
    [60, 0, 15, 50],
  ]);
});

test('a grid breaks between its rows', async () => {
  // grid-item-fragmentation: the second row does not fit after the first
  const { node } = await render(
    COLS +
      '<div class="m" id="m"><div style="display:grid;width:25px;' +
      'grid-template-columns:10px 15px"><div id="a" style="height:60px">' +
      '<div style="height:60px;overflow:hidden"></div></div>' +
      '<div style="height:60px;overflow:hidden"></div>' +
      '<div id="c" style="height:60px;overflow:hidden"></div></div></div>',
    200,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'a', 'm'), [0, 0, 10, 60], 'the first row');
  assert.deepStrictEqual(at(el, 'c', 'm'), [25, 0, 10, 60], 'the next column');
});

test('a forced break goes before the box it is on, and keeps its margin', async () => {
  // single-line-row-flex-fragmentation-015: the first item's break before
  // is the flex box's
  const { node } = await render(
    COLS +
      '<div class="m" id="m"><div style="height:50px"></div>' +
      '<div style="display:flex" id="f"><div><div id="a" ' +
      'style="height:100px;width:25px;break-before:column"></div></div>' +
      '</div><div id="b" style="margin-top:10px;height:20px;' +
      'break-before:column"></div></div>',
    200,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'a', 'm'), [25, 0, 25, 100], 'a column on');
  assert.deepStrictEqual(at(el, 'b', 'm'), [50, 10, 25, 20], 'margin kept');
});

test('a box of a height of its own that a break falls inside uses up the rest of its column', async () => {
  // as Chrome breaks it (single-line-row-flex-fragmentation-010's item):
  // 180px in columns 100px tall, its content broken at 80px, is 100px and
  // 80px, not 100px and 100px, and what follows it starts under it
  for (const outer of ['', 'display:flex;flex-direction:column;']) {
    const { node } = await render(
      COLS +
        `<div class="m" id="m"><div style="${outer}">` +
        '<div id="o" style="height:180px;width:25px">' +
        '<div style="contain:size;height:80px;width:25px"></div>' +
        '<div id="b" style="contain:size;height:30px;width:25px"></div>' +
        '</div><div id="n" style="height:10px;width:25px"></div></div></div>',
      200,
    );
    const el = view(node);
    const label = outer || 'block';
    assert.deepStrictEqual(
      piecesAt(el, 'o', 'm').map((p) => p.slice(1)),
      [
        [0, 25, 100],
        [0, 25, 80],
      ],
      label,
    );
    assert.deepStrictEqual(at(el, 'b', 'm'), [25, 0, 25, 30], label);
    assert.deepStrictEqual(at(el, 'n', 'm'), [25, 80, 25, 10], label);
  }
});

test('a break avoided before a box goes before the box before it, where something stands before that in its column', async () => {
  // single-line-column-flex-fragmentation-016 and -017, and the same in
  // blocks: the break before the tall third box is avoided, so the second
  // goes on to the next column with it
  for (const [second, third] of [
    ['', 'break-before:avoid'],
    ['break-after:avoid', ''],
  ]) {
    for (const flex of ['display:flex;flex-direction:column', '']) {
      const { node } = await render(
        COLS +
          `<div class="m" id="m"><div style="${flex};width:25px">` +
          '<div id="a" style="height:50px"></div>' +
          `<div id="b" style="height:50px;${second}"></div>` +
          `<div id="c" style="height:300px;${third}"></div></div></div>`,
        200,
      );
      const el = view(node);
      const label = `${flex || 'block'} ${second || third}`;
      assert.deepStrictEqual(at(el, 'a', 'm'), [0, 0, 25, 50], label);
      assert.deepStrictEqual(at(el, 'b', 'm'), [25, 0, 25, 50], label);
      assert.deepStrictEqual(
        piecesAt(el, 'c', 'm')[0],
        [25, 50, 25, 50],
        label,
      );
    }
  }
  // where nothing with a height comes before it in the column, the break
  // falls before it after all
  const { node } = await render(
    COLS +
      '<div class="m" id="m"><div id="a" style="height:100px"></div>' +
      '<div id="c" style="height:300px;break-before:avoid"></div></div>',
    200,
  );
  assert.deepStrictEqual(piecesAt(view(node), 'c', 'm')[0], [25, 0, 25, 100]);
});

test('a forced break inside a box size containment makes monolithic is none', async () => {
  // monolithic-content-with-forced-break-001
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="m" style="columns:2;gap:0;width:100px">' +
      '<div style="contain:size;height:50px;width:50px">' +
      '<div style="height:50px;break-after:column"></div></div>' +
      '<div id="b" style="width:50px;height:150px"></div></div>',
    200,
  );
  const el = view(node);
  assert.deepStrictEqual(piecesAt(el, 'b', 'm'), [
    [0, 50, 50, 50],
    [50, 0, 50, 100],
  ]);
});

test('what overflows a flex item takes no part in where the columns break', async () => {
  // single-line-row-flex-fragmentation-008: the item is 100px tall, its
  // lines 150px, and what follows the flex box starts the next column
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="m" style="columns:2;gap:0;width:100px;height:100px">' +
      '<div style="display:flex;height:100px"><div id="i" ' +
      'style="line-height:0"><div style="display:inline-block;width:50px;' +
      'height:50px"></div><div style="display:inline-block;width:50px;' +
      'height:100px"></div></div></div>' +
      '<div id="b" style="width:50px;height:100px"></div></div>',
    200,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'i', 'm'), [0, 0, 50, 100], 'whole');
  assert.deepStrictEqual(at(el, 'b', 'm'), [50, 0, 50, 100], 'the next column');
});

test('an item margin that makes a flex box taller is dropped at a break', async () => {
  // single-line-row-flex-fragmentation-040
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="m" style="columns:2;column-fill:auto;gap:0;width:100px;' +
      'height:100px"><div style="display:flex"><div style="margin-bottom:' +
      '150px"><div style="height:50px;width:50px"></div></div></div>' +
      '<div id="b" style="height:100px;width:50px"></div></div>',
    200,
  );
  assert.deepStrictEqual(at(view(node), 'b', 'm'), [50, 0, 50, 100]);
});

test('an out-of-flow box short enough for its column is cut where what it holds runs on past it', async () => {
  // CSS Fragmentation 3: the box fits its column and its child does not;
  // moved whole, the child hung down past the container where Blink cuts it
  // into the columns after (WPT's out-of-flow-in-multicolumn-002)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:2;column-fill:auto;gap:0;width:100px;height:100px">' +
      '<div style="position:relative"><div style="position:absolute;height:10px;width:20px">' +
      '<div id="c" style="height:250px;width:20px"></div></div></div></div>',
  );
  const pieces = COLUMN_PIECES.get(boxOf(view(node), 'c') as never)?.map(
    (p) => [p.x, p.y, p.height],
  );
  assert.deepStrictEqual(pieces, [
    [0, 0, 100],
    [50, 0, 100],
    [100, 0, 50],
  ]);
});

test("a flex box's row gap that a column break falls in has no rule, however narrow the rule", async () => {
  // multi-line-row-flex-fragmentation-094: three lines 50px tall spread
  // over 180px, so 15px between them, in columns 60px tall. The second
  // gap runs from 50px to 65px down the second column, and the break at
  // 60px takes it away, though the 5px rule at its middle, 55px to 60px,
  // is wholly in the column
  const items = '<div style="width:70px;height:50px"></div>'.repeat(6);
  const doc = (rule: string) =>
    '<div style="columns:2;height:60px;width:290px;gap:10px">' +
    '<div style="display:flex;flex-wrap:wrap;width:140px;height:180px;' +
    `align-content:space-between;${rule}">${items}</div></div>`;
  assert.deepStrictEqual(
    await rulesIn(doc('row-rule:5px solid #ffd700'), '#ffd700'),
    [],
  );
  // and a gap no break reaches keeps it
  assert.deepStrictEqual(
    await rulesIn(
      '<div style="columns:2;column-fill:auto;height:100px;width:290px;' +
        'gap:10px"><div style="display:flex;flex-wrap:wrap;width:140px;' +
        'height:80px;row-gap:20px;row-rule:4px solid #ffd700">' +
        '<div style="width:140px;height:30px"></div>'.repeat(2) +
        '</div></div>',
      '#ffd700',
    ),
    [[0, 38, 140, 4]],
  );
});

test('a box that clones its edges at a break has them in every column, and they take room', async () => {
  const { node } = await render(
    '<style>body{margin:0}.m{columns:2;column-fill:auto;gap:0;' +
      'width:200px;height:100px}</style>' +
      // a box with content, 15px of edge at either end: the first column
      // holds 70px of the child and keeps 15px at its foot for the
      // cloned end edge, and the second starts below a cloned start edge
      // (WPT's css-break/box-decoration-break-clone-001)
      '<div class="m"><div id="a" style="box-decoration-break:clone;' +
      'padding:5px 0;border-block:10px solid green">' +
      '<div id="ac" style="height:140px"></div></div></div>' +
      // a box with nothing in it: cut 15px short of the foot, and what
      // follows it goes on below its second piece (clone-004)
      '<div class="m"><div id="b" style="box-decoration-break:clone;' +
      'padding:5px 0;border-block:10px solid green;height:80px"></div>' +
      '<div id="n" style="height:60px"></div></div>' +
      // nested: each piece holds the edges of the boxes in it (clone-033's
      // shape), and a box sliced as the default keeps none at the break
      '<div class="m"><div id="o" style="box-decoration-break:clone;' +
      'border-block:5px solid">' +
      '<div id="i" style="border-block:10px solid">' +
      '<div style="height:150px"></div></div></div></div>' +
      // a break that falls where the box ends breaks nothing in it
      // (clone-003)
      '<div class="m"><div id="e" style="box-decoration-break:clone;' +
      'border-block:15px solid;height:70px">' +
      '<div style="height:185px"></div></div></div>' +
      // a sliced box around a cloned one: its pieces reach over the edges
      // cloned in it, to the column's top and foot (clone-008)
      '<div class="m"><div id="s"><div style="box-decoration-break:clone;' +
      'padding:10px 0"><div style="height:160px"></div></div></div></div>',
    300,
  );
  const el = view(node);
  const pieces = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => [
      p.x,
      p.y - boxOf(el, id).y,
      p.width,
      p.height,
      p.cloned ?? false,
    ]);
  assert.deepStrictEqual(pieces('a'), [
    [0, 0, 100, 100, true],
    [100, 0, 100, 100, true],
  ]);
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(el, 'ac') as never)?.map((p) => [p.y, p.height]),
    [
      [boxOf(el, 'a').y + 15, 70],
      [boxOf(el, 'a').y + 15, 70],
    ],
    'the content between the edges',
  );
  assert.deepStrictEqual(pieces('b'), [
    [0, 0, 100, 100, true],
    [100, 0, 100, 40, true],
  ]);
  const n = boxOf(el, 'n');
  assert.deepStrictEqual(
    [n.x, n.y - boxOf(el, 'b').y],
    [100, 40],
    'after the second piece',
  );
  assert.deepStrictEqual(pieces('o'), [
    [0, 0, 100, 100, true],
    [100, 0, 100, 90, true],
  ]);
  // the inner box slices: no edge at the break, and the outer box's
  // start edge above where it goes on
  const inner = COLUMN_PIECES.get(boxOf(el, 'i') as never)!;
  assert.deepStrictEqual(
    inner.map((p) => [p.y - boxOf(el, 'o').y, p.height, p.cloned ?? false]),
    [
      [5, 90, false],
      [5, 80, false],
    ],
  );
  assert.deepStrictEqual(
    pieces('e'),
    [[0, 0, 100, 100, true]],
    'all of it in the first column, its child going on alone',
  );
  assert.deepStrictEqual(pieces('s'), [
    [0, 0, 100, 100, false],
    [100, 0, 100, 100, false],
  ]);
});

test('a block that is a formatting context of its own breaks across columns, unless it scrolls or clips', async () => {
  const { node } = await render(
    '<style>body{margin:0}.m{columns:2;column-fill:auto;gap:0;' +
      'width:200px;height:100px}</style>' +
      // a `flow-root` is broken as any block is (CSS Fragmentation 3, 4.1)
      '<div class="m"><div id="f" style="display:flow-root">' +
      '<div style="height:60px"></div><div style="height:60px"></div>' +
      '</div></div>' +
      // one that scrolls goes whole, overflowing its column
      '<div class="m"><div id="o" style="overflow:hidden;height:150px">' +
      '<div style="height:60px"></div><div style="height:60px"></div>' +
      '</div></div>' +
      // one that holds a float that cannot be cut goes with it
      '<div class="m"><div style="height:30px"></div>' +
      '<div id="u" style="display:flow-root">' +
      '<div style="float:left;width:50px;height:100px;overflow:hidden">' +
      '</div></div></div>' +
      // and one that holds a float with nothing in it is cut with it
      '<div class="m"><div id="c" style="display:flow-root">' +
      '<div style="float:left;width:50px;height:150px"></div></div></div>',
    300,
  );
  const el = view(node);
  const pieces = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => [
      p.x,
      p.y - boxOf(el, id).y,
      p.height,
    ]);
  assert.deepStrictEqual(pieces('f'), [
    [0, 0, 100],
    [100, 0, 20],
  ]);
  assert.strictEqual(pieces('o'), undefined, 'goes whole');
  const u = boxOf(el, 'u');
  assert.deepStrictEqual(
    [pieces('u'), u.x, u.height],
    [undefined, 100, 100],
    'in the next column, whole',
  );
  assert.deepStrictEqual(pieces('c'), [
    [0, 0, 100],
    [100, 0, 50],
  ]);
});

test('a relative offset in a box columns broke is a percentage of the column it was laid out in', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:4;column-fill:auto;gap:0;width:200px;height:100px">' +
      '<div id="i" style="width:20px">' +
      '<div id="r" style="position:relative;left:100%;height:300px"></div>' +
      '</div></div>',
    300,
  );
  const el = view(node);
  const at = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => p.x);
  // past the 20px it was laid out in, in each column, and not past the
  // rectangle around all the pieces (WPT's
  // css-break/box-decoration-break-clone-030)
  assert.deepStrictEqual(at('i'), [0, 50, 100]);
  assert.deepStrictEqual(at('r'), [20, 70, 120]);
});

test('a float in a box that clones its edges steers clear of those a break clones', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      // two columns of a box 40px at either edge: the float has 20px of the
      // first, between the edges, and in the second goes on under the start
      // edge and over the box's own end edge, which is no cloned one
      // (WPT's css-break/box-decoration-break-clone-006)
      '<div style="columns:4;column-fill:auto;gap:0;width:100px;height:100px">' +
      '<div id="c" style="box-decoration-break:clone;border:solid;' +
      'border-width:40px 0;height:40px">' +
      '<div id="f" style="float:left;width:100%;height:280px"></div>' +
      '</div></div>',
    300,
  );
  const el = view(node);
  const top = boxOf(el, 'c').y;
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(el, 'f') as never)?.map((p) => [
      p.x,
      p.y - top,
      p.height,
    ]),
    [
      [0, 40, 20],
      [25, 40, 60],
      [50, 0, 100],
      [75, 0, 100],
    ],
  );
});

test('a piece of a box that clones its edges fills the column a break ends it in', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      // a forced break after 20px of content: the first piece runs on to
      // the column's foot, its cloned end edge there, as Blink fills a
      // fragment a break ends (WPT's css-break/box-decoration-break-clone-020)
      '<div style="columns:2;column-fill:auto;gap:0;width:100px;height:100px">' +
      '<div id="c" style="box-decoration-break:clone;border:solid;' +
      'border-width:20px 0 10px">' +
      '<div style="height:20px"></div>' +
      '<div style="break-before:column;height:70px"></div>' +
      '</div></div>',
    300,
  );
  const el = view(node);
  const top = boxOf(el, 'c').y;
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(el, 'c') as never)?.map((p) => [
      p.x,
      p.y - top,
      p.height,
    ]),
    [
      [0, 0, 100],
      [50, 0, 100],
    ],
  );
});

test('a row rule is drawn in the row gaps between rows of columns, and a column rule stops at them', async () => {
  // WPT's multicol-gap-decorations-001 and
  // multicol-column-rule-final-row-overflow: two rows of three columns 60px
  // tall, a 10px gap between them, with a row rule across it and the
  // column rules broken at it
  const doc =
    '<div style="width:200px;height:130px;column-count:3;' +
    'column-width:60px;column-height:60px;gap:10px;column-wrap:wrap;' +
    'column-rule:10px solid #0000ff;row-rule:10px solid #ffd700">' +
    '<p style="height:60px;margin:0"></p>'.repeat(6) +
    '</div>';
  assert.deepStrictEqual(await rulesIn(doc, '#ffd700'), [[0, 60, 200, 10]]);
  assert.deepStrictEqual(await rulesIn(doc, '#0000ff'), [
    [60, 0, 10, 60],
    [60, 70, 10, 60],
    [130, 0, 10, 60],
    [130, 70, 10, 60],
  ]);
});

test('a column rule in a row of columns a spanner ends stops at the spanner, unless it runs on through it', async () => {
  // WPT's multicol-gap-decorations-002 and -012: two boxes 60px tall
  // balanced into three columns 40px tall before a spanner, in rows of
  // columns 60px tall. The rules of that row are as tall as its columns,
  // and not as the row, which the spanner is in; under
  // `column-rule-break: none` each gap's rule runs on from the top to the
  // last row's foot
  const doc = (more: string) =>
    '<div style="width:200px;height:200px;column-count:3;' +
    'column-width:60px;column-height:60px;gap:10px;column-wrap:wrap;' +
    `column-fill:auto;column-rule:10px solid #0000ff;${more}">` +
    '<p style="height:60px;margin:0"></p>'.repeat(2) +
    '<h2 style="column-span:all;margin:0;height:18px"></h2>' +
    '<p style="height:60px;margin:0"></p>'.repeat(3) +
    '</div>';
  const rules = await rulesIn(doc(''), '#0000ff');
  assert.deepStrictEqual(rules.slice(0, 2), [
    [60, 0, 10, 40],
    [130, 0, 10, 40],
  ]);
  assert.deepStrictEqual(
    await rulesIn(doc('column-rule-break:none'), '#0000ff'),
    [
      [60, 0, 10, 130],
      [130, 0, 10, 130],
    ],
  );
});

test("a multicol container another's columns break has its rules in each piece, and none in a row gap a break ends", async () => {
  // WPT's multicol-gap-decorations-fragmentation-001: rows of one column
  // 40px tall, 20px apart, in outer columns 120px tall. The first and the
  // third row gap are in a column each; the second ends where the first
  // outer column does, and a break follows it, so it has no rule
  const doc =
    '<div style="columns:2;column-fill:auto;column-gap:40px;width:240px;' +
    'height:120px"><div style="column-count:1;column-width:100px;' +
    'column-height:40px;column-wrap:wrap;row-gap:20px;' +
    'row-rule:10px solid #ffd700">' +
    '<div style="height:40px"></div>'.repeat(4) +
    '</div></div>';
  assert.deepStrictEqual(await rulesIn(doc, '#ffd700'), [
    [0, 45, 100, 10],
    [140, 45, 100, 10],
  ]);
});

test('a vertical multicol container has its rows of columns and their row rules, a vertical-lr one from its left', async () => {
  // WPT's multicol-gap-decorations-writing-mode and -multi-value-writing-mode:
  // rows of two columns 50px tall, three of them, the row rules orange then
  // purple. The frame turns the container, and the rules are drawn in it:
  // a vertical-rl container's first row gap is at the frame's top, which
  // is the page's right, and a vertical-lr one's at its foot, the page's
  // left, as its rows are put back across
  const doc = (mode: string) =>
    `<div style="writing-mode:${mode};column-count:2;column-width:50px;` +
    'column-height:50px;gap:10px;column-wrap:wrap;width:170px;' +
    'height:110px;row-rule-color:#ffa500,#800080;row-rule-style:solid;' +
    'row-rule-width:10px">' +
    '<div style="width:50px;height:50px"></div>'.repeat(6) +
    '</div>';
  const at = async (mode: string, color: string) =>
    (await rulesIn(doc(mode), color)).map((r) => r.map(Math.round));
  assert.deepStrictEqual(await at('vertical-rl', '#ffa500'), [
    [170, 50, 110, 10],
  ]);
  assert.deepStrictEqual(await at('vertical-rl', '#800080'), [
    [170, 110, 110, 10],
  ]);
  assert.deepStrictEqual(await at('vertical-lr', '#ffa500'), [
    [170, 110, 110, 10],
  ]);
  assert.deepStrictEqual(await at('vertical-lr', '#800080'), [
    [170, 50, 110, 10],
  ]);
});

test("a right-to-left multicol container's rule lists go from its right", async () => {
  // WPT's multicol-gap-decorations-multi-value-direction: four columns,
  // red, green and blue rules, the first gap at the start of the line,
  // which is its right, in rows of columns and in one row
  const doc = (wrap: boolean) =>
    '<div style="direction:rtl;width:230px;height:170px;column-count:4;' +
    'column-width:50px;gap:10px;' +
    (wrap ? 'column-height:50px;column-wrap:wrap;' : 'column-fill:auto;') +
    'column-rule-color:#ff0000,#00ff00,#0000ff;column-rule-style:solid;' +
    'column-rule-width:10px">' +
    `<div style="height:${wrap ? 50 : 170}px;contain:size"></div>`.repeat(
      wrap ? 8 : 4,
    ) +
    '</div>';
  assert.deepStrictEqual(await rulesIn(doc(true), '#ff0000'), [
    [170, 0, 10, 50],
    [170, 60, 10, 50],
  ]);
  assert.deepStrictEqual(await rulesIn(doc(true), '#0000ff'), [
    [50, 0, 10, 50],
    [50, 60, 10, 50],
  ]);
  assert.deepStrictEqual(await rulesIn(doc(false), '#ff0000'), [
    [170, 0, 10, 170],
  ]);
  assert.deepStrictEqual(await rulesIn(doc(false), '#0000ff'), [
    [50, 0, 10, 170],
  ]);
});

test('a rule shown between every column is drawn between the columns there are, as tall as the content box', async () => {
  // WPT's multicol-gap-decorations-visibility-all-empty-columns: three
  // columns filled to a height of their own, only the first holding
  // something; the rules are between all three, as tall as the container
  assert.deepStrictEqual(
    await rulesIn(
      '<div style="width:320px;height:100px;columns:3;column-fill:auto;' +
        'column-gap:20px;column-rule:6px solid #0000ff;' +
        'column-rule-visibility-items:all"><div style="height:80px"></div>' +
        '</div>',
      '#0000ff',
    ),
    [
      [100, 0, 6, 100],
      [214, 0, 6, 100],
    ],
  );
  // and -026: balanced columns are only those that hold something, three
  // past a spanner, and the rules between them run on through every row
  // to the content box's foot
  assert.deepStrictEqual(
    await rulesIn(
      '<div style="width:400px;height:100px;column-width:50px;gap:5px;' +
        'column-rule:5px solid #ffd700;rule-visibility-items:all;' +
        'rule-break:none"><div style="height:20px;contain:size"></div>' +
        '<div style="column-span:all;height:20px"></div>' +
        '<div style="height:20px;contain:size"></div>'.repeat(3) +
        '</div>',
      '#ffd700',
    ),
    [
      [53, 0, 5, 100],
      [111, 0, 5, 100],
    ],
  );
});

test('a multicol container its content sizes is balanced over what is positioned in it', async () => {
  // WPT's css-break/out-of-flow-in-multicolumn-069: four columns with no
  // height and nothing in their flow but a box positioned 400px tall. It
  // is laid out after the columns are set, so the container is laid out
  // once more with how far it reached: 100px tall, the box cut into each
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="m" style="column-count:4;column-gap:0;width:100px">' +
      '<div style="position:relative"><div id="a" style="position:absolute;' +
      'height:400px;width:25px"></div></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'm').height, 100);
  assert.deepStrictEqual(piecesAt(el, 'a', 'm'), [
    [0, 0, 25, 100],
    [25, 0, 25, 100],
    [50, 0, 25, 100],
    [75, 0, 25, 100],
  ]);
});

test('a multicol container is laid out once more for what is positioned in it, and no more', async () => {
  // where what it is balanced over moved every time, the document would be
  // laid out again for good: it is laid out twice, and no more
  const settle = stripReach.settle;
  let passes = 0;
  stripReach.settle = function (this: typeof stripReach) {
    passes += 1;
    const decided = this.decided.map((d) => d.box);
    settle.call(this);
    return decided;
  };
  try {
    passes = 0;
    await render(
      '<style>body{margin:0}</style>' +
        '<div style="column-count:4;column-gap:0;width:100px">' +
        '<div style="position:relative"><div style="position:absolute;' +
        'height:400px;width:25px"></div></div></div>',
    );
  } finally {
    stripReach.settle = settle;
  }
  // a layout that ends at all, which took both passes
  assert.ok(passes >= 2, `${passes} passes`);
});

test("a multicol container another's columns break, its edges cloned, has its rules in each piece inside them", async () => {
  // WPT's multicol-gap-decorations-006: a container of two columns, 10px
  // of cloned padding at each break, in outer columns 100px tall. Its rule
  // is drawn in both pieces, where what it holds stands in each: 80px of
  // its content in the first, the 45px its second row of columns comes to
  // in the second, and in neither piece's padding
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:3;column-fill:auto;height:100px;width:620px;' +
      'gap:10px"><div style="columns:2;box-decoration-break:clone;' +
      'padding:10px;column-rule:1px solid #008000;gap:10px">' +
      '<div style="height:250px"></div></div></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops);
  const ink = parseColor('#008000');
  const shown: number[][] = [];
  let clip: number[] | null = null;
  for (const op of ops) {
    if (op.op === 'clip') clip = [op.x, op.y, op.x + op.w, op.y + op.h];
    else if (op.op === 'fill' && op.style === ink && clip) {
      const top = Math.max(op.y, clip[1]);
      const bottom = Math.min(op.y + op.h, clip[3]);
      if (bottom <= top) continue;
      // one rule, where two pieces of it meet
      const last = shown[shown.length - 1];
      if (last && last[0] === op.x && last[1] + last[2] === top) {
        last[2] += bottom - top;
      } else shown.push([op.x, top, bottom - top]);
    }
  }
  assert.deepStrictEqual(shown, [
    [100, 10, 80],
    [310, 10, 45],
  ]);
});

test('what is positioned in a row of columns nothing balances is no part of the row before', async () => {
  // the last row under `column-fill: auto` is filled, not balanced, and
  // what is positioned in it was taken for the row before's, the last one
  // balanced: that row grew to hold it, and pushed the spanner and the
  // box down to the container's foot, in columns 5px tall. Chrome's numbers
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="column-count:2;column-fill:auto;column-gap:0;' +
      'height:140px;width:100px"><div id="b" style="height:60px"></div>' +
      '<div style="column-span:all;height:5px"></div>' +
      '<div style="position:relative"><div id="a" style="position:absolute;' +
      'width:50px;height:200px"></div></div></div>',
    300,
  );
  const el = view(node);
  const pieces = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => [
      p.x,
      p.y,
      p.width,
      p.height,
    ]);
  assert.deepStrictEqual(
    pieces('b'),
    [
      [0, 0, 50, 30],
      [50, 0, 50, 30],
    ],
    'balanced over itself alone',
  );
  assert.deepStrictEqual(
    pieces('a'),
    [
      [0, 35, 50, 105],
      [50, 35, 50, 95],
    ],
    'in the row under the spanner',
  );
});

test('a row of columns a spanner ends is balanced over what is positioned in it', async () => {
  // WPT's css-break/out-of-flow-in-multicolumn-015: a block 100px tall
  // before a spanner, a box positioned in it 160px tall. The row is
  // balanced over the box, two columns of 80px, and the spanner comes
  // under them
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="m" style="columns:2;width:100px;height:100px;' +
      'column-fill:auto;column-gap:0"><div style="height:100px;' +
      'position:relative"><div id="a" style="position:absolute;top:0;' +
      'height:160px;width:50px"></div></div>' +
      '<div id="s" style="column-span:all;height:20px"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 's').y, 80);
  assert.deepStrictEqual(piecesAt(el, 'a', 'm'), [
    [0, 0, 50, 80],
    [50, 0, 50, 80],
  ]);
});

test('column-height and column-wrap set the columns in rows, a row gap apart', async () => {
  // Rows of two columns 30px tall, 10px apart: six boxes of 20px that go
  // whole take a column each, three rows, and the last row is as tall as
  // the others whatever its content comes to (CSS Multi-column 2, 3.7;
  // WPT's column-height-014).
  const u = (id: string) =>
    `<div id="${id}" style="height:20px;contain:size"></div>`;
  const { node } = await render(
    SHEET +
      '<div class="m" id="m" style="column-height:30px;gap:10px 40px">' +
      ['a', 'b', 'c', 'd', 'e', 'f'].map(u).join('') +
      '</div>' +
      // a spanner that does not fit in what is left of its row goes to the
      // next, and what comes after one that ends in a gap to the row after
      '<div class="m" id="n" style="column-height:30px;gap:10px 40px">' +
      u('g') +
      '<div id="s" style="column-span:all;height:30px"></div>' +
      u('h') +
      '</div>',
    700,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'b', 'm'), [320, 0, 280, 20], 'beside');
  assert.deepStrictEqual(at(el, 'c', 'm'), [0, 40, 280, 20], 'a row down');
  assert.deepStrictEqual(at(el, 'f', 'm'), [320, 80, 280, 20], 'the last');
  assert.strictEqual(boxOf(el, 'm').height, 110, 'three rows and the gaps');
  assert.strictEqual(at(el, 's', 'n')[1], 40, 'the spanner, a row down');
  assert.deepStrictEqual(at(el, 'h', 'n'), [0, 80, 280, 20], 'past the gap');
  assert.strictEqual(boxOf(el, 'n').height, 110, 'to the last row');
});

test('the columns shorthand takes a column-height after a slash', async () => {
  const { node } = await render(
    SHEET +
      '<div id="m" style="width:600px;columns:2 / 30px;gap:10px 40px">' +
      '<div id="a" style="height:20px;contain:size"></div>' +
      '<div style="height:20px;contain:size"></div>' +
      '<div id="c" style="height:20px;contain:size"></div></div>',
    700,
  );
  const el = view(node);
  assert.deepStrictEqual(at(el, 'c', 'm'), [0, 40, 280, 20], 'a row down');
});

test('a multicol container in another’s columns starts a row of its columns at each one it reaches', async () => {
  // The inner container starts 40px down a column 100px tall: a row 60px
  // tall there holds 120px of its 300px, and the rest goes to a row at
  // the next column's top, balanced at 90px, with what follows under it
  // (CSS Multi-column 1, 8.1; WPT's multicol-nested-013 and
  // column-height-027).
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:2;gap:0;column-fill:auto;width:200px;height:100px">' +
      '<div style="height:40px"></div>' +
      '<div id="i" style="columns:2;gap:0"><div id="c" style="height:300px">' +
      '</div></div><div id="a" style="height:10px"></div></div>',
    300,
  );
  const el = view(node);
  const pieces = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => [
      p.x,
      p.y,
      p.width,
      p.height,
    ]);
  assert.deepStrictEqual(pieces('c'), [
    [0, 40, 50, 60],
    [50, 40, 50, 60],
    [100, 0, 50, 90],
    [150, 0, 50, 90],
  ]);
  assert.deepStrictEqual(pieces('i'), [
    [0, 40, 100, 60],
    [100, 0, 100, 90],
  ]);
  const a = boxOf(el, 'a');
  assert.deepStrictEqual([a.x, a.y], [100, 90], 'what follows');
});

test('lines orphans keeps together go to the next row where a row is cut short', async () => {
  // The inner container has 90px left of the outer column: two lines of
  // 50px under `orphans: 2` do not fit, and go together to the row at the
  // next column's top (WPT's multicol-nested-018).
  const { node } = await render(
    '<style>body{margin:0}.mc{columns:2;column-gap:0;column-fill:auto}' +
      '.ib{display:inline-block;vertical-align:top;width:200%;height:50px}' +
      '</style><div style="width:100px">' +
      '<div class="mc" style="height:190px;line-height:50px;orphans:2;widows:2">' +
      '<div style="height:100px"></div><div class="mc">' +
      '<div class="ib" id="a"></div><br><div class="ib" id="b"></div><br>' +
      '</div></div></div>',
    300,
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([a.x, a.y, b.x, b.y], [50, 0, 50, 50]);
});

test('a box break-inside: avoid keeps whole is broken where it is taller than a column', async () => {
  // Columns 100px tall: a box of 200px under `break-inside: avoid` cannot
  // go whole, so it starts the next column, past the 15px left of this one,
  // and is broken there as a last resort (CSS Fragmentation 3, 4.4; WPT's
  // multicol-nested-028). One that fits goes whole.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:4;gap:0;column-fill:auto;width:100px;height:100px">' +
      '<div style="height:110px"></div>' +
      '<div id="a" style="break-inside:avoid;height:75px"></div>' +
      '<div id="b" style="break-inside:avoid;height:200px"></div></div>',
    300,
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  assert.deepStrictEqual([a.x, a.y, a.height], [25, 10, 75], 'whole');
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(el, 'b') as never)?.map((p) => [
      p.x,
      p.y,
      p.height,
    ]),
    [
      [50, 0, 100],
      [75, 0, 100],
    ],
  );
});

test('a forced break before the first child of a box with layout containment is none', async () => {
  // the break is the box's own, which layout containment keeps from it,
  // so the child stays under the box's top border (CSS Containment 2,
  // 3.2; WPT's css-contain/contain-layout-breaks-002)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:2;column-fill:auto;gap:0;width:200px;height:400px">' +
      '<div style="border-top:100px solid"></div>' +
      '<div style="border-top:100px solid;contain:layout">' +
      '<div id="c" style="border-top:100px solid;break-before:column">' +
      '</div></div></div>',
    300,
  );
  const c = boxOf(view(node), 'c');
  assert.deepStrictEqual([c.x, c.y], [0, 200]);
});

test('a table in columns breaks between its rows and inside its cells', async () => {
  // a table taller than a column is broken as a grid is, its rows' cells
  // side by side down the strip and cut where the column ends (CSS
  // Fragmentation 3, 4; WPT's css-break/table/break-inside-cell-000), where
  // it went whole and hung past the column's foot
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:2;column-fill:auto;gap:0;width:100px;height:100px">' +
      '<div style="display:table;width:100%"><div style="display:table-row">' +
      '<div style="display:table-cell"><div id="c" style="height:150px">' +
      '</div></div></div></div></div>',
    300,
  );
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(view(node), 'c') as never)?.map((p) => [
      p.x,
      p.y,
      p.height,
    ]),
    [
      [0, 0, 100],
      [50, 0, 50],
    ],
  );
});

test('a table repeats its header group at the head of each column it breaks into, and its footer group at the foot', async () => {
  // header and footer groups that say `break-inside: avoid` are drawn
  // again where a break falls inside the table, and the body takes the
  // room that leaves (CSS Tables 3, 9.4; WPT's css-break/table/
  // repeated-section/header-footer)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:4;column-fill:auto;gap:0;width:100px;height:100px">' +
      '<div id="t" style="display:table">' +
      '<div style="display:table-header-group;break-inside:avoid">' +
      '<div style="height:20px"></div></div>' +
      '<div id="c" style="width:25px;height:240px"></div>' +
      '<div style="display:table-footer-group;break-inside:avoid">' +
      '<div style="height:20px"></div></div></div></div>',
    300,
  );
  const el = view(node);
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(el, 'c') as never)?.map((p) => [
      p.x,
      p.y,
      p.height,
    ]),
    [
      [0, 20, 60],
      [25, 20, 60],
      [50, 20, 60],
      [75, 20, 60],
    ],
    'the body between the header and the footer in each column',
  );
  assert.strictEqual(
    REPEATED.get(boxOf(el, 't') as never)?.length,
    6,
    'three headers and three footers drawn again',
  );
});

test('a box positioned in an inline box columns break is placed against the strip and cut into the columns', async () => {
  // the inline box's fragments are where the strip had them, before the
  // columns moved its lines, and the box laid out against them is cut into
  // the columns after, as one in a block is (CSS Position 3, 4.2; WPT's
  // css-break/out-of-flow-in-multicolumn-056), where it hung out of them
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:2;column-fill:auto;gap:0;width:100px;height:100px">' +
      '<div style="height:200px;width:50px"></div>' +
      '<span style="position:relative"><div id="a" style="position:absolute;' +
      'width:50px;height:200px;top:-200px"></div></span></div>',
    300,
  );
  assert.deepStrictEqual(
    COLUMN_PIECES.get(boxOf(view(node), 'a') as never)?.map((p) => [
      p.x,
      p.y,
      p.height,
    ]),
    [
      [0, 0, 100],
      [50, 0, 100],
    ],
  );
});

test('an inline box that starts at the end of a line with a box out of the flow has its first fragment there', async () => {
  // its text all goes on the next line, and the box placed against it is
  // placed from the empty fragment the line ends with, as Blink places it
  // (CSS 2.1 10.1, item 4; WPT's css-break/out-of-flow-in-multicolumn-057)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:2;column-fill:auto;gap:0;width:100px;height:100px;font:20px/1 sans-serif">' +
      '<div style="height:200px;width:50px"><div style="height:60px"></div>B ' +
      '<span style="position:relative"><div id="a" style="position:absolute;' +
      'width:25px;height:200px;top:-60px"></div>WWWW WW</span></div></div>',
    300,
  );
  // the next line, which the box was placed from before, is a line
  // further down, and the box ran on into a third column
  const pieces = COLUMN_PIECES.get(boxOf(view(node), 'a') as never) ?? [];
  assert.deepStrictEqual(
    pieces.map((p) => [p.x, p.y]),
    [
      [0, 0],
      [50, 0],
    ],
  );
});

test('an inline box that starts with a box out of the flow after a forced break has its first fragment on the line after it', async () => {
  // the newline ends the line before, which holds nothing of the box, so the
  // box placed against it is placed from the line its text is on (WPT's
  // css-overflow/line-clamp/line-clamp-with-abspos-016's reference)
  const { node } = await render(
    '<style>body{margin:0}div{font:16px/32px serif;white-space:pre}' +
      'span{position:relative}i{position:absolute;top:0;left:0;width:20px;' +
      'height:20px}</style><div>Line 1\n<span><i id="a"></i>Line 2</span></div>',
  );
  const a = boxOf(view(node), 'a');
  assert.ok(a.y >= 32, `on the second line, at ${a.y}`);
});

test('a grid row the columns end inside is broken an item at a time, where Chromium breaks it', async () => {
  // every rectangle Chromium's, from `scripts/conformance/grid-rows.ts`:
  // each item goes on at the head of the next column from its own break,
  // the row as tall there as its longest item, a stretched item as tall as
  // the row and an aligned one as what it holds, and the rows after it
  // under that
  const { node } = await render(GRID_ROWS_DOCUMENT, 800);
  const el = view(node);
  const wrong: string[] = [];
  for (const [id, want] of Object.entries(GRID_ROWS_RECTS)) {
    // the cases the script knows differ, an item aligned in its row
    const at = id.replace(/[gi]\d*$/, '');
    if (GRID_ROWS_KNOWN.includes(at)) continue;
    const box = boxOf(el, id);
    const root = boxOf(el, at);
    const pieces = COLUMN_PIECES.get(box as never) ?? [box];
    const got = pieces
      .filter((p) => p.width > 0 && p.height > 0)
      .map((p) => [p.x - root.x, p.y - root.y, p.width, p.height]);
    const same =
      got.length === want.length &&
      got.every((r, k) => r.every((v, j) => Math.abs(v - want[k][j]) < 0.05));
    if (!same) {
      wrong.push(
        `${id}: ${JSON.stringify(got)}, where Chromium has ${JSON.stringify(want)}`,
      );
    }
  }
  assert.deepStrictEqual(wrong, []);
});

test('a grid row that fits whole in its column is broken no item at a time', async () => {
  // what a row its column holds whole does is what it did: no item of it
  // is a flow of its own (`gridRowsBroken` counts the rows that are)
  const grid = (h: number) =>
    '<div style="display:grid;grid-template-columns:20px 20px;line-height:0">' +
    `<div><i style="display:inline-block;width:20px;height:${h}px"></i></div>` +
    '<div><i style="display:inline-block;width:20px;height:30px"></i>' +
    '<i style="display:inline-block;width:20px;height:30px"></i></div></div>';
  const before = gridRowsBroken();
  await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:2;column-gap:0;column-fill:auto;width:100px;' +
      `height:100px">${grid(40)}<div style="height:40px"></div>${grid(20)}</div>`,
    300,
  );
  assert.strictEqual(gridRowsBroken(), before, 'none, where each row fits');
  await render(
    '<style>body{margin:0}</style>' +
      '<div style="columns:2;column-gap:0;column-fill:auto;width:100px;' +
      `height:100px"><div style="height:50px"></div>${grid(40)}</div>`,
    300,
  );
  assert.ok(gridRowsBroken() > before, 'one, where the column ends inside');
});

metric(
  'a multicol container of continue: discard keeps what fits in its columns',
  async () => {
    // CSS Overflow 4, 5.2: what does not fit in its columns makes no
    // overflow column and is discarded (WPT's
    // line-clamp/discard/discard-multicol-001), the last line kept ending
    // in an ellipsis where block-ellipsis asks for one (-002)
    const lines = Array.from({ length: 7 }, (_, i) => `Line ${i + 1}`).join(
      '<br>',
    );
    const { node } = await render(
      '<style>body{margin:0} div{font:16px/20px monospace;width:300px;' +
        'columns:3;gap:0;height:40px}</style>' +
        `<div id="a" style="continue:discard">${lines}</div>` +
        `<div id="b" style="continue:discard;block-ellipsis:auto">${lines}</div>`,
    );
    const el = view(node);
    assert.strictEqual(linesOf(el, 'a').length, 6, 'three columns of two');
    const b = linesOf(el, 'b');
    assert.strictEqual(b.length, 6);
    const last = b[5].texts[b[5].texts.length - 1];
    const runs = (
      last.layout as unknown as {
        lines: { runs: { span?: { text: string } }[] }[];
      }
    ).lines[last.layoutLine].runs;
    assert.strictEqual(runs[runs.length - 1]?.span?.text, '\u2026');
  },
);

metric(
  'what overflows a box that clips it stays in the column the box ends in',
  async () => {
    // CSS Overflow 3, 3: what runs past an `overflow: clip` box of a height
    // of its own is clipped where the box ends, and a break in it, forced
    // or not, makes no column of its own (WPT's css-break/overflow-clip-005)
    const rules = await rulesIn(
      '<style>body{margin:0}</style>' +
        '<div style="columns:5;column-gap:20px;column-rule:20px solid ' +
        '#00aa00;column-fill:auto;width:180px;height:100px">' +
        '<div style="overflow:clip;height:300px">' +
        '<div style="height:300px"></div><div style="height:200px"></div>' +
        '<div style="break-before:column;height:10px"></div>' +
        '</div></div>',
      '#00aa00',
    );
    // three columns, and a rule between each two of them
    assert.strictEqual(rules.length, 2, JSON.stringify(rules));
  },
);

metric(
  'what is positioned in a box that clips it stays in the column the box ends in',
  async () => {
    // an absolutely positioned box in an `overflow: clip` box is cut into
    // the columns as far as the clip box reaches, and what reaches past it
    // stays in the column the clip box ends in, clipped there, where it
    // went on into columns of its own past the container (WPT's
    // css-break/overflow-clip-014)
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="columns:2;gap:0;width:100px;height:100px;' +
        'column-fill:auto"><div style="position:relative;overflow-y:clip;' +
        'height:200px"><div style="position:absolute;width:100%;' +
        'height:300px"><div style="height:200px"></div>' +
        '<div id="past" style="height:200px"></div></div>' +
        '<div style="height:1000px"></div></div></div>',
    );
    const past = boxOf(view(node), 'past');
    assert.deepStrictEqual([past.x, past.y], [50, 100], 'in the second');
  },
);

test('a fixed box in a relative box in a transformed one in columns is cut where the offset puts it', async () => {
  // Chrome's numbers: the relative offsets between a fixed box's static
  // position and the transformed box it is positioned against move where
  // it is cut, and the transformed box's own offset moves it after the
  // cut, with all the transformed box holds (WPT's css-break/
  // out-of-flow-in-multicolumn-073)
  const { node } = await render(
    '<style>body{margin:0}.m{columns:2;column-fill:auto;height:100px;' +
      'width:100px;column-gap:0;margin-bottom:20px}</style>' +
      '<div class="m"><div style="transform:translateX(0)">' +
      '<div style="position:relative;top:100px;left:50px">' +
      '<div style="position:absolute"><div id="a" style="position:fixed;' +
      'width:50px;height:200px"></div></div></div></div></div>' +
      '<div class="m"><div style="position:relative;top:30px;' +
      'transform:translateX(0)"><div style="height:30px"></div>' +
      '<div style="position:absolute"><div id="b" style="position:fixed;' +
      'width:50px;height:120px"></div></div></div></div>',
    300,
  );
  const el = view(node);
  const pieces = (id: string) =>
    COLUMN_PIECES.get(boxOf(el, id) as never)?.map((p) => [
      p.x,
      p.y,
      p.width,
      p.height,
    ]);
  assert.deepStrictEqual(
    pieces('a'),
    [
      [100, 0, 50, 100],
      [150, 0, 50, 100],
    ],
    'the offset between it and the transformed box, before the cut',
  );
  assert.deepStrictEqual(
    pieces('b'),
    [
      [0, 180, 50, 70],
      [50, 150, 50, 50],
    ],
    "the transformed box's own offset, after it",
  );
});
