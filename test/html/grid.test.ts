// <Html> — grid layout.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, waitFor } from 'react-x11/test';
import { sizeTracks } from '../../src/html/layout/tracks.js';
import {
  RED_PNG,
  SVG_NS,
  boxOf,
  linesOf,
  metric,
  render,
  renderWithBytes,
  svgBytes,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

metric('a grid places its items in its column tracks', async () => {
  // CSS Grid 1, the subset documents are written in: Tailwind's
  // `grid-cols-3`, a sidebar in `200px 1fr`, `repeat(auto-fill, …)` and
  // spans; `display: grid` stacked its items as blocks
  const grid = async (css: string, items: string) => {
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
        `<div id="g" style="display:grid;${css}">${items}</div>`,
      700,
    );
    const g = boxOf(view(node), 'g');
    const out = g.children
      .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
      .map((c) => [c.x, c.y, c.width]);
    cleanup();
    return out;
  };
  const rounded = async (css: string, items: string) =>
    (await grid(css, items)).map((cell) => cell.map((v) => Math.round(v)));
  assert.deepStrictEqual(
    await rounded(
      'grid-template-columns:repeat(3,minmax(0,1fr));gap:16px',
      '<div>A</div><div>B</div><div>C</div><div>D</div>',
    ),
    [
      [0, 0, 223],
      [239, 0, 223],
      [477, 0, 223],
      [0, 36, 223],
    ],
    'three equal columns, and a fourth item on the next row',
  );
  assert.deepStrictEqual(
    await rounded(
      'grid-template-columns:200px 1fr;gap:10px',
      '<div>Side</div><div>Main</div>',
    ),
    [
      [0, 0, 200],
      [210, 0, 490],
    ],
  );
  assert.deepStrictEqual(
    (
      await rounded(
        'grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px',
        '<div>1</div><div>2</div><div>3</div><div>4</div><div>5</div>',
      )
    ).map(([x, y]) => [x, y]),
    [
      [0, 0],
      [177, 0],
      [354, 0],
      [531, 0],
      [0, 28],
    ],
    'as many columns as fit',
  );
  assert.deepStrictEqual(
    await rounded(
      'grid-template-columns:repeat(4,1fr);gap:4px',
      '<div style="grid-column:span 2">wide</div><div>x</div><div>y</div>' +
        '<div style="grid-column:1 / -1">full</div>',
    ),
    [
      [0, 0, 348],
      [352, 0, 172],
      [528, 0, 172],
      [0, 24, 700],
    ],
    'spans, and a line counted back from the end',
  );
  // content-sized columns at the sides, and the rest in the middle: each
  // starts a gap after the one before, and the last ends at the edge, what
  // ever the font makes of the words
  const [first, middle, last] = await grid(
    'grid-template-columns:auto 1fr auto;gap:8px',
    '<div>Label</div><div>stretch</div><div>End</div>',
  );
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  assert.ok(
    near(middle[0] - (first[0] + first[2]), 8),
    'a gap after the first',
  );
  assert.ok(
    near(last[0] - (middle[0] + middle[2]), 8),
    'a gap after the middle',
  );
  assert.ok(near(last[0] + last[2], 700), 'the last ends at the edge');
  assert.ok(
    first[2] < 60 && last[2] < 60 && middle[2] > 500,
    `${first[2]} ${middle[2]} ${last[2]}`,
  );
  // an item is stretched to its row, and aligned in it where it says
  const { node } = await render(
    '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
      '<div style="display:grid;grid-template-columns:100px 100px">' +
      '<div>two<br>lines</div><div id="s">one</div>' +
      '<div id="c" style="justify-self:center;align-self:center">c</div></div>',
    700,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 's').height, 40);
  const c = boxOf(el, 'c');
  assert.ok(c.width < 20 && c.x > 40, `${c.x} ${c.width}`);
});

metric('grid-template and grid set the tracks they name', async () => {
  // Neither shorthand was read, so a grid written with one had no tracks
  // and stacked its items in a column; nor was grid-auto-columns
  const cells = async (css: string, items: string) => {
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
        `<div id="g" style="display:grid;${css}">${items}</div>`,
      700,
    );
    const g = boxOf(view(node), 'g');
    const out = g.children
      .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
      .map((c) => [c.x, c.y, c.width, c.height].map((v) => Math.round(v)));
    cleanup();
    return out;
  };
  const four = '<div>a</div><div>b</div><div>c</div><div>d</div>';
  assert.deepStrictEqual(
    await cells('grid-template:30px 40px / 100px 50px', four),
    [
      [0, 0, 100, 30],
      [100, 0, 50, 30],
      [0, 30, 100, 40],
      [100, 30, 50, 40],
    ],
    'rows, a slash and columns',
  );
  assert.deepStrictEqual(
    await cells("grid-template:'a b' 30px 'c d' / 60px 70px", four),
    [
      [0, 0, 60, 30],
      [60, 0, 70, 30],
      [0, 30, 60, 20],
      [60, 30, 70, 20],
    ],
    "each area string's row the size after it, and auto with none",
  );
  assert.deepStrictEqual(
    await cells('grid:auto-flow 25px / 60px 60px', four),
    [
      [0, 0, 60, 25],
      [60, 0, 60, 25],
      [0, 25, 60, 25],
      [60, 25, 60, 25],
    ],
    "auto-flow's rows, and the columns",
  );
  assert.deepStrictEqual(
    await cells(
      'grid-template-columns:50px;grid-auto-columns:30px',
      '<div>a</div><div style="grid-column:2">b</div>',
    ),
    [
      [0, 0, 50, 20],
      [50, 0, 30, 20],
    ],
    'a column past the template is grid-auto-columns wide',
  );
});

metric(
  'an absolute box in a grid takes its grid area for its containing block',
  async () => {
    // CSS Grid 1, 9.1: the area between the lines it names, the grid's
    // padding edge where a line is auto — which `grid-column: 2` leaves its
    // end line. Its offsets, its percentages and
    // its alignment were the grid's padding box's; a box deeper in the grid
    // is where its own flow put it
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}' +
        '.a{position:absolute}</style>' +
        '<div style="display:grid;position:relative;padding:10px;' +
        'grid-template-columns:50px 100px;grid-template-rows:30px 40px">' +
        '<div>a</div><div>b</div><div>c</div>' +
        '<div><div id="d" class="a" style="width:50%;height:5px"></div></div>' +
        '<div id="p" class="a" style="grid-column:2 / 3;grid-row:2 / 3;' +
        'width:100%;height:100%"></div>' +
        '<div id="r" class="a" style="grid-column:2;grid-row:2;' +
        'width:100%;height:100%"></div>' +
        '<div id="q" class="a" style="grid-column:2 / 3;inset:5px"></div>' +
        '<div id="s" class="a" style="width:20px;height:20px;' +
        'justify-self:center;align-self:end"></div></div>',
      700,
    );
    const el = view(node);
    const rect = (id: string) => {
      const b = boxOf(el, id);
      return [b.x, b.y, b.width, b.height];
    };
    // the grid's padding box is 700 by 90
    assert.deepStrictEqual(rect('p'), [60, 40, 100, 40], 'its area');
    assert.deepStrictEqual(rect('r'), [60, 40, 640, 50], 'auto: the edge');
    assert.deepStrictEqual(rect('q'), [65, 5, 90, 80], 'a column, all rows');
    assert.deepStrictEqual(rect('s'), [340, 70, 20, 20], 'aligned in it');
    assert.deepStrictEqual(rect('d'), [60, 40, 350, 5], 'in the flow, deeper');
  },
);

metric(
  'auto rows share a grid height, and an item that does not stretch fits its content',
  async () => {
    // CSS Grid 1, 11.8: with align-content normal, the auto rows stretch to
    // fill a grid of a definite height; and an item that is not stretched is
    // as wide as its content fits, which is its longest word where that is
    // wider than its area — it was cut to the area
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
        '<div style="display:grid;height:100px;grid-template-rows:20px auto auto">' +
        '<div>a</div><div id="b">b</div><div id="c">c</div></div>' +
        '<div style="display:grid;height:100px;align-content:start;' +
        'grid-template-rows:20px auto"><div>a</div><div id="e">e</div></div>' +
        '<div style="display:grid;grid-template-columns:10px;justify-items:start">' +
        '<div id="w">Supercalifragilistic</div></div>',
      700,
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'b').height, 40, 'half of what is left');
    assert.strictEqual(boxOf(el, 'c').y, 60);
    assert.strictEqual(boxOf(el, 'e').height, 20, 'align-content: start');
    const w = boxOf(el, 'w');
    assert.ok(w.width > 50, `as wide as its word: ${w.width}`);
  },
);

test('grid tracks are sized as CSS Grid 11.5 to 11.8 has it', () => {
  const item = (
    start: number,
    span: number,
    min: number,
    max: number,
    minimum = min,
  ) => ({
    start,
    span,
    minContent: () => min,
    maxContent: () => max,
    minimum: () => minimum,
  });
  const space = (available: number, least = 0) => ({
    available,
    least,
    gap: 0,
    stretch: true,
  });
  const auto = { min: 'auto', max: 'auto' } as const;
  const fr = (n: number) => ({ min: 'auto' as const, max: { fr: n } });
  // An item spanning a length and a content-sized track grows the second
  // alone — the last spanned track grew, a length or not — and two
  // content-sized ones by what each maximum lets it take: the tracks of
  // `grid-intrinsic-maximums`, with an item 40 at its narrowest and 90 at
  // its widest
  assert.deepStrictEqual(
    sizeTracks(
      [
        { min: 0, max: 'min-content' },
        { min: 5, max: 5 },
      ],
      [item(0, 2, 40, 90, 15)],
      space(100),
    ),
    [35, 5],
  );
  assert.deepStrictEqual(
    sizeTracks(
      [
        { min: 0, max: 'min-content' },
        { min: 5, max: 5 },
        { min: 0, max: 'max-content' },
      ],
      [item(0, 3, 40, 90, 15)],
      space(100),
    ),
    [17.5, 5, 67.5],
  );
  // the free space grows the tracks equally, each as far as its limit —
  // it grew them in proportion to what each wanted
  assert.deepStrictEqual(
    sizeTracks(
      [auto, auto],
      [item(0, 1, 10, 30), item(1, 1, 50, 300)],
      space(200),
    ),
    [30, 170],
  );
  // an `fr` track whose content is more than its share keeps its content's
  assert.deepStrictEqual(
    sizeTracks([fr(1), fr(1)], [item(0, 1, 250, 250)], space(300)),
    [250, 50],
  );
  // with no size of its own, an axis's `fr` rows fill its least size
  assert.deepStrictEqual(
    sizeTracks(
      [auto, fr(1), auto],
      [item(0, 1, 50, 50), item(1, 1, 100, 100), item(2, 1, 50, 50)],
      space(Infinity, 600),
    ),
    [50, 500, 50],
  );
});

metric(
  "a grid's fr rows fill its height, and an item stretched into a row is its height",
  async () => {
    // `auto 1fr auto`, the page with a footer at the bottom: the `fr` row was
    // as tall as what was in it. And a main area that scrolls, in a grid of
    // a height, is the row's height — it was as tall as what it held
    const { node } = await render(
      '<style>body{margin:0} .g{display:grid;grid-template-rows:auto 1fr auto}' +
        '</style>' +
        '<div class="g" style="min-height:300px"><div style="height:40px"></div>' +
        '<div id="m"><div style="height:50px"></div></div>' +
        '<div id="f" style="height:30px"></div></div>' +
        '<div class="g" style="height:200px"><div style="height:40px"></div>' +
        '<div id="s" style="overflow:auto"><div style="height:1000px"></div>' +
        '</div><div style="height:30px"></div></div>',
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 230, 'what min-height leaves');
    assert.strictEqual(boxOf(el, 'f').y, 270, 'the footer at the bottom');
    assert.strictEqual(boxOf(el, 's').height, 130, 'the row, not its content');
  },
);

metric(
  'a grid places its tracks by justify-content and align-content, and an item by its auto margins',
  async () => {
    // CSS Box Alignment 3, 5.1, and CSS Grid 1, 10.2: the space the tracks
    // leave was all after them, and an auto margin was none
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="display:grid;width:300px;height:100px;' +
        'grid-template:20px / 50px 50px;justify-content:space-between;' +
        'align-content:center"><div></div><div id="b"></div></div>' +
        '<div style="display:grid;grid-template:100px / 100px">' +
        '<div id="c" style="margin:auto;width:20px;height:20px"></div></div>' +
        '<div style="display:grid;grid-template:100px / 100px">' +
        '<div id="d" style="margin-left:auto;height:20px">' +
        '<span style="display:inline-block;width:20px"></span></div></div>',
    );
    const el = view(node);
    const at = (id: string) => {
      const b = boxOf(el, id);
      return [b.x, b.y, b.width, b.height];
    };
    assert.deepStrictEqual(at('b'), [250, 40, 50, 20], 'spread, and centred');
    assert.deepStrictEqual(at('c'), [40, 140, 20, 20], 'centred in its area');
    assert.deepStrictEqual(
      at('d'),
      [80, 200, 20, 20],
      'at the end, unstretched',
    );
  },
);

metric(
  'grid placement moves its cursor past an item with a column, and places an item locked to a row first',
  async () => {
    // CSS Grid 1, 8.5: an item whose column is before the cursor goes to the
    // next row — it went in beside the last one — and an item that names
    // its row is placed before the ones that name neither
    const place = async (items: string) => {
      const { node } = await render(
        '<style>body{margin:0} div div{height:10px}</style>' +
          `<div id="g" style="display:grid;grid-template-columns:repeat(3,50px)">${items}</div>`,
      );
      const g = boxOf(view(node), 'g');
      const out = g.children
        .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
        .map((c) => [c.x, c.y]);
      cleanup();
      return out;
    };
    assert.deepStrictEqual(
      await place(
        '<div></div><div style="grid-column:3"></div>' +
          '<div style="grid-column:2"></div>',
      ),
      [
        [0, 0],
        [100, 0],
        [50, 10],
      ],
    );
    assert.deepStrictEqual(
      await place('<div></div><div style="grid-row:1"></div>'),
      [
        [50, 0],
        [0, 0],
      ],
    );
  },
);

metric(
  'a grid item of a content width is that width, and fit-content() stops at its argument',
  async () => {
    // A grid item's `width: min-content` was stretched across its area, and
    // `height: max-content` down it; and `fit-content(100px)` was a
    // max-content track with no limit
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
        '<div style="display:grid;grid-template:100px / 300px">' +
        '<div id="a" style="width:min-content;height:max-content">aa bb</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:fit-content(100px) 1fr">' +
        '<div id="b">words enough to be wider than the argument</div><div></div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:fit-content(100px) 1fr">' +
        '<div id="c">ab</div><div></div></div>',
      400,
    );
    const el = view(node);
    const a = boxOf(el, 'a');
    assert.ok(a.width < 30, `its narrowest: ${a.width}`);
    assert.strictEqual(a.height, 40, 'its two lines, not its row');
    assert.strictEqual(boxOf(el, 'b').width, 100, 'no wider than the argument');
    const c = boxOf(el, 'c');
    assert.ok(c.width < 30, `no wider than its content: ${c.width}`);
  },
);

metric(
  'a grid places its items by the names of its areas and its lines',
  async () => {
    // CSS Grid 1, 7.3 and 8.3: `grid-template-areas`, the names in a track
    // list and the `-start` and `-end` lines an area's name makes were not
    // read, so every named item was placed in order — and a list with two
    // names in one bracket was no list at all
    const cells = async (css: string, items: string) => {
      const { node } = await render(
        '<style>body{margin:0} #g>div{height:10px}</style>' +
          `<div id="g" style="display:grid;${css}">${items}</div>`,
      );
      const g = boxOf(view(node), 'g');
      const out = g.children
        .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
        .map((c) => [c.x, c.y, c.width, c.height]);
      cleanup();
      return out;
    };
    assert.deepStrictEqual(
      await cells(
        "grid-template-areas:'head head' 'nav main' 'foot foot';" +
          'grid-template-columns:100px 200px;grid-template-rows:30px 60px 20px',
        '<div style="grid-area:foot"></div><div style="grid-area:main"></div>' +
          '<div style="grid-area:head"></div><div style="grid-area:nav"></div>',
      ),
      [
        [0, 90, 300, 10],
        [100, 30, 200, 10],
        [0, 0, 300, 10],
        [0, 30, 100, 10],
      ],
      'each in its area, in any order',
    );
    assert.deepStrictEqual(
      (
        await cells(
          'grid-template-columns:[full-start] 50px [content-start a b] 100px ' +
            '[content-end] 50px [full-end]',
          '<div style="grid-column:content"></div>' +
            '<div style="grid-column:full"></div>' +
            '<div style="grid-column:b / span full-end"></div>',
        )
      ).map(([x, , w]) => [x, w]),
      [
        [50, 100],
        [0, 200],
        [50, 150],
      ],
      "an area's lines, two names in a bracket, and a span to a name",
    );
    assert.deepStrictEqual(
      (
        await cells(
          "grid-template:[top] 'a b' 30px [mid] / [l] 40px [m] 60px;" +
            'grid-template-columns:repeat(2, [col] 50px)',
          '<div style="grid-area:b"></div><div style="grid-column:col 2;' +
            'grid-row:mid"></div>',
        )
      ).map(([x, y, w]) => [x, y, w]),
      [
        [50, 0, 50],
        [50, 30, 50],
      ],
      "the shorthand's areas, and a repeated name counted",
    );
  },
);

metric(
  'grid-auto-flow fills the columns, or goes back for the holes',
  async () => {
    // `grid-auto-flow: column` and `dense` were not read: the items went
    // along the rows, and a hole a wide item left stayed a hole. And the
    // gaps' old names, `grid-gap` and its longhands, were not read either
    const place = async (css: string, items: string) => {
      const { node } = await render(
        '<style>body{margin:0} #g>div{height:10px}</style>' +
          `<div id="g" style="display:grid;${css}">${items}</div>`,
      );
      const g = boxOf(view(node), 'g');
      const out = g.children
        .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
        .map((c) => [c.x, c.y]);
      cleanup();
      return out;
    };
    assert.deepStrictEqual(
      await place(
        'grid-auto-flow:column;grid-template-rows:10px 10px;' +
          'grid-auto-columns:50px',
        '<div></div><div></div><div></div>',
      ),
      [
        [0, 0],
        [0, 10],
        [50, 0],
      ],
      'down the columns',
    );
    const holes =
      '<div style="grid-column:span 2"></div>'.repeat(2) + '<div></div>';
    assert.deepStrictEqual(
      await place('grid-template-columns:repeat(3,50px)', holes),
      [
        [0, 0],
        [0, 10],
        [100, 10],
      ],
      'sparse: on from the last',
    );
    assert.deepStrictEqual(
      await place(
        'grid-template-columns:repeat(3,50px);grid-auto-flow:dense',
        holes,
      ),
      [
        [0, 0],
        [0, 10],
        [100, 0],
      ],
      'dense: back into the hole',
    );
    assert.deepStrictEqual(
      await place(
        'grid-template-columns:repeat(2,50px);grid-gap:5px 10px',
        '<div></div><div></div><div></div>',
      ),
      [
        [0, 0],
        [60, 0],
        [0, 15],
      ],
      'grid-gap',
    );
  },
);

metric(
  'a percentage row of a grid with no height is of the height its rows come to',
  async () => {
    // CSS Grid 1, 7.2.1: sized as `auto` to find the grid's height, and then
    // a percentage of it — a grid with no height kept it `auto`; and an
    // `auto-fill` of rows counted against the grid's height, which only the
    // columns' width did
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="display:grid;grid-template-rows:auto 20% auto">' +
        '<div style="height:40px"></div><div id="p" style="height:60px"></div>' +
        '<div id="q" style="height:40px"></div></div>' +
        '<div style="display:grid;height:100px;' +
        'grid-template-rows:repeat(auto-fill,30px);grid-auto-rows:5px">' +
        '<div id="r" style="grid-row:-2"></div></div>',
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'p').y, 56, 'after an auto row stretched');
    assert.strictEqual(boxOf(el, 'q').y, 84, '20% of 140 before it');
    assert.strictEqual(boxOf(el, 'r').y, 140 + 60, 'the last of three rows');
  },
);

test('a grid item with a ratio is sized by it, and justify-items: normal starts an image', async () => {
  // An item with an aspect-ratio and a height was as wide as its column,
  // and `normal` stretched an image across it, where CSS Grid 1, 6.2 sizes
  // either as a block would be: an image at its own width, a box with a
  // ratio from a height it has, and else filling the column
  const { el } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      '<div style="display:grid;grid-template-columns:300px">' +
      '<div id="a" style="height:100px;aspect-ratio:1"></div>' +
      '<div id="b" style="aspect-ratio:3"></div>' +
      '<img id="c" src="r.png"></div>' +
      // stretched down a row, as wide as its ratio makes that height
      '<div style="display:grid;grid-template:100px/300px">' +
      '<canvas id="d" width="10" height="10" style="align-self:stretch">' +
      '</canvas></div>' +
      // and stretched across, as tall as its ratio makes that width
      '<div style="display:grid;grid-template-columns:60px">' +
      '<img id="e" src="r.png" style="justify-self:stretch"></div>' +
      // its percentage height is of a row that has a length, and its
      // column as wide as that makes it
      '<div id="fg" style="display:inline-grid;grid-template-rows:80px">' +
      '<div id="f" style="height:100%;aspect-ratio:1/2"></div></div>' +
      // stretched down a row another item sizes
      '<div style="display:grid;grid-template-columns:300px 50px">' +
      '<canvas id="h" width="10" height="10" style="align-self:stretch">' +
      '</canvas><div style="height:80px"></div></div>' +
      // and what is in an item takes its percentages of that item's height
      '<div id="ig" style="display:inline-grid;grid-template-rows:50px">' +
      '<div style="height:100%"><canvas width="20" height="10" ' +
      'style="height:100%;display:block"></canvas></div></div>' +
      // but a scroll container's sizes are not its ratio's
      '<div style="float:left"><div id="g" style="display:grid">' +
      '<div style="height:100px;aspect-ratio:2;overflow:auto"></div>' +
      '</div></div>',
    { 'r.png': RED_PNG },
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  await waitFor(() => assert.deepStrictEqual(size('c'), [10, 10]));
  assert.deepStrictEqual(size('a'), [100, 100]);
  assert.deepStrictEqual(size('b'), [300, 100], 'no height: the column');
  assert.deepStrictEqual(size('d'), [100, 100]);
  assert.deepStrictEqual(size('e'), [60, 60]);
  assert.deepStrictEqual(size('f'), [40, 80]);
  assert.strictEqual(boxOf(el, 'fg').width, 40, 'its column too');
  assert.deepStrictEqual(size('h'), [80, 80]);
  assert.strictEqual(boxOf(el, 'ig').width, 100);
  assert.strictEqual(boxOf(el, 'g').width, 0);
});

test("a grid's align-items: stretch stretches an image, and normal does not", async () => {
  // CSS Grid 1, 6.2 and CSS Box Alignment 3, 6.1: `normal` stretches an
  // item that has neither a natural size nor a ratio, and `stretch` every
  // item. `normal` was dropped where it was written and the initial value
  // was `stretch`, so the grid could not tell the two apart, and read both
  // as `normal`: an image under the grid's `stretch` kept its own height.
  // Each number here is Chrome's.
  const img = (w: number, h: number) =>
    svgBytes(`<svg ${SVG_NS} width="${w}" height="${h}"></svg>`);
  const { el } = await renderWithBytes(
    '<style>body{margin:0} .g{display:grid;width:300px;' +
      'grid-template:80px/300px} .s{align-items:stretch}' +
      '.s.n{align-items:normal}</style>' +
      // stretched down its row, and as wide as its ratio makes that
      '<div class="g s"><img id="a" src="sq.svg"></div>' +
      // `normal`, unset or written over a `stretch`, leaves it be
      '<div class="g"><img id="b" src="sq.svg"></div>' +
      '<div class="g s n"><img id="c" src="sq.svg"></div>' +
      // stretched across as well, within a greatest width of its area's
      '<div style="display:grid;grid-template-columns:1fr 1fr;' +
      'align-items:stretch;height:80px;width:600px"><div></div>' +
      '<img id="d" src="wide.svg" style="padding:0 10%;max-width:50%;' +
      'justify-self:stretch"></div>' +
      // a box with a ratio, and the `auto` column the stretched height of
      // one makes, before the rows are sized
      '<div class="g s"><div id="e" style="aspect-ratio:2"></div></div>' +
      '<div class="g s" style="grid-template-columns:auto 1fr">' +
      '<img id="f" src="tall.svg"><div></div></div>' +
      // an item's own `align-self: normal` is the same `normal`
      '<div class="g s"><img id="g" src="sq.svg" style="align-self:normal">' +
      '</div>' +
      // and in a flex box `normal` is `stretch`, where it was dropped
      '<div style="display:flex;height:40px;align-items:center;' +
      'align-items:normal"><div id="h" style="width:10px"></div></div>',
    { 'sq.svg': img(10, 10), 'wide.svg': img(40, 4), 'tall.svg': img(10, 20) },
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  await waitFor(() => assert.deepStrictEqual(size('b'), [10, 10]));
  assert.deepStrictEqual(size('a'), [80, 80], 'the row down, its ratio across');
  assert.deepStrictEqual(size('c'), [10, 10]);
  assert.deepStrictEqual(
    size('d'),
    [210, 80],
    "half its area and a tenth's padding",
  );
  assert.deepStrictEqual(size('e'), [160, 80], 'a box with a ratio too');
  assert.deepStrictEqual(size('f'), [40, 80]);
  assert.deepStrictEqual(size('g'), [10, 10]);
  assert.deepStrictEqual(size('h'), [10, 40]);
});

test('place-content sets align-content then justify-content, the second the first again', async () => {
  // melbcss.com centres its page with `body { display: grid; place-content:
  // center }`: unread, the column stretched across the body and the page
  // sat at its left edge. Each grid is 200 wide and 100 tall, around one
  // 50 by 20 item.
  const grid = (id: string, place: string) =>
    `<div style="display:grid;width:200px;height:100px;place-content:${place}">` +
    `<div id="${id}" style="width:50px;height:20px"></div></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      grid('a', 'center') +
      grid('b', 'end start') +
      grid('c', 'unsafe center end') +
      // a baseline is no justify-content: `start` stands in
      grid('d', 'first baseline') +
      // a half that is not one drops the declaration whole
      grid('e', 'center bogus'),
    400,
  );
  const el = view(node);
  const at = (id: string) => {
    const box = boxOf(el, id);
    const grid = boxOf(el, id) as unknown as { parent: LaidBox };
    return [box.x - grid.parent.x, box.y - grid.parent.y];
  };
  assert.deepStrictEqual(at('a'), [75, 40]);
  assert.deepStrictEqual(at('b'), [0, 80]);
  assert.deepStrictEqual(at('c'), [150, 40]);
  assert.deepStrictEqual(at('d'), [0, 0]);
  assert.deepStrictEqual(at('e'), [0, 0]);
});

test("a grid item's percentages are of its area's width, not of its own", async () => {
  // CSS Grid 1, 3.3 and 6.4: an item's grid area is its containing block,
  // and CSS 2.1 8.3, 8.4 and 10.4 take a percentage in a margin, a padding
  // or a width limit of the containing block's width. The item was laid
  // out with the width it came to standing for its area's, so each was
  // taken of the item: `width: 50%; max-width: 80%` was four tenths of its
  // column, and an item aligned to the start with `min-width: 50%` was as
  // wide as what it held. Each number here is Chrome's.
  const { node } = await render(
    '<style>body{margin:0} *{box-sizing:border-box}' +
      '.g{display:grid;width:600px;grid-template-columns:1fr 1fr}' +
      '.w{width:40px;height:10px}</style>' +
      // a width and its limit, and a padding inside a width
      '<div class="g"><div id="a" style="width:50%;max-width:80%"></div>' +
      '<div id="b" style="width:50%;padding:0 10%"><div id="b1"></div></div>' +
      '</div>' +
      // as wide as its content and its padding; stretched between margins
      '<div class="g"><div id="c" style="justify-self:start;padding:0 10%">' +
      '<div class="w" id="c1"></div></div>' +
      '<div id="d" style="margin:0 10%"></div></div>' +
      // a least width, and margins an item is aligned within
      '<div class="g"><div id="e" style="justify-self:start;min-width:50%">' +
      '</div><div id="f" style="justify-self:end;margin:0 10%;width:50%">' +
      '</div></div>' +
      // While the columns are sized there is no area for a percentage to
      // be of, and it is of nothing (CSS Sizing 3, 5.2.1): a column is as
      // wide as what is in its item, and the margins and the padding come
      // out of that. Of the grid's width, they made the columns 340 wide.
      '<div class="g" style="grid-template-columns:auto auto;' +
      'justify-content:start"><div id="g" style="margin:0 25%">' +
      '<div class="w"></div></div><div id="h" style="padding:0 25%">' +
      '<div class="w" id="h1"></div></div></div>' +
      // down the item too, and in an item that is a flex box
      '<div class="g" style="grid-template-columns:200px 1fr">' +
      '<div id="i" style="margin-top:10%;padding-top:5%">' +
      '<div class="w"></div></div><div id="j" style="display:flex;' +
      'height:100px;padding:0 10%;max-width:90%">' +
      '<div id="j1" style="flex:1"></div></div></div>' +
      // and in one laid out again in the height it is stretched to
      '<div class="g" style="height:80px"><div id="k" style="display:flex;' +
      'padding:0 10%;max-width:90%"><div id="k1" style="flex:1"></div>' +
      '</div></div>',
    700,
  );
  const el = view(node);
  const across = (id: string) => [boxOf(el, id).x, boxOf(el, id).width];
  assert.deepStrictEqual(across('a'), [0, 150], 'half its column');
  assert.deepStrictEqual(across('b'), [300, 150]);
  assert.deepStrictEqual(across('b1'), [330, 90], 'a tenth of the column in');
  assert.deepStrictEqual(across('c'), [0, 100], 'its content and its padding');
  assert.deepStrictEqual(across('c1'), [30, 40]);
  assert.deepStrictEqual(across('d'), [330, 240], 'between its margins');
  assert.deepStrictEqual(across('e'), [0, 150], 'half its column at the least');
  assert.deepStrictEqual(across('f'), [420, 150], 'a margin from the end');
  assert.deepStrictEqual(across('g'), [10, 20], 'in a column of its content');
  assert.deepStrictEqual(across('h'), [40, 40]);
  assert.deepStrictEqual(across('h1'), [50, 40], 'a quarter of 40 in');
  const i = boxOf(el, 'i');
  const j = boxOf(el, 'j');
  assert.strictEqual(i.y - j.y, 20, 'a margin a tenth of its column down');
  assert.strictEqual(i.height, 80, 'stretched, under that margin');
  assert.deepStrictEqual(across('j'), [200, 360], 'nine tenths of 400');
  assert.deepStrictEqual(across('j1'), [240, 280]);
  assert.deepStrictEqual(across('k'), [0, 270]);
  assert.deepStrictEqual(across('k1'), [30, 210], 'the padding kept');
});

test("a grid item's percentage width is auto for what it makes its columns", async () => {
  // CSS Sizing 3, 5.2.1: a percentage `width` or `max-width` of an area the
  // columns are still being sized for is cyclic, and an item that is not
  // replaced contributes to them as though it were `auto`. The item was
  // measured at the width its percentage made of the probe's, nothing, so
  // an `auto` column's least size was none and `width: 100%` was as wide
  // as whatever else the column came to. Each number here is Chrome's.
  const { node } = await render(
    '<style>body{margin:0} .w{width:100px;height:10px}' +
      '.g{display:grid;width:300px}' +
      '.t{display:grid;width:10px;grid-template-columns:3px auto 4px;' +
      'place-items:start} .t>div{grid-column:2}</style>' +
      // WPT grid-item-percentage-sizes-001: the column is as wide as the
      // item's content, and 100% of that is the item; a least width that
      // is a percentage is of nothing, and leaves the column the room the
      // grid has left
      '<div class="t"><div id="a" style="width:100%"><div class="w"></div>' +
      '</div></div><div class="t"><div id="b" style="width:100%;' +
      'max-width:100%"><div class="w"></div></div></div>' +
      '<div class="t"><div id="c" style="width:100%;min-width:100%">' +
      '<div class="w"></div></div></div>' +
      // an `fr` column's least is its item's content too, and so is a
      // `min-content` column and a `fit-content()` one
      '<div class="g" style="grid-template-columns:1fr">' +
      '<div id="d" style="width:100%"><div class="w" style="width:500px">' +
      '</div></div></div>' +
      '<div class="g" style="grid-template-columns:1fr 1fr">' +
      '<div id="e" style="width:100%"><div class="w" style="width:200px">' +
      '</div></div><div id="f"></div></div>' +
      '<div class="g" style="grid-template-columns:min-content 1fr">' +
      '<div id="g" style="width:50%"><div class="w"></div></div></div>' +
      '<div class="g" style="grid-template-columns:fit-content(50px) 1fr">' +
      '<div id="h" style="width:100%"><div class="w"></div></div></div>',
    700,
  );
  const el = view(node);
  const across = (id: string) => [boxOf(el, id).x, boxOf(el, id).width];
  assert.deepStrictEqual(across('a'), [3, 100], 'its content, not 3');
  assert.deepStrictEqual(across('b'), [3, 100], 'nor its greatest width');
  assert.deepStrictEqual(across('c'), [3, 3], 'the room the grid left');
  assert.deepStrictEqual(across('d'), [0, 500], 'wider than the grid');
  assert.deepStrictEqual(across('e'), [0, 200]);
  assert.deepStrictEqual(across('f'), [200, 100], 'the rest');
  assert.deepStrictEqual(across('g'), [0, 50], 'half its content');
  assert.deepStrictEqual(across('h'), [0, 100], 'past fit-content(50px)');
});

metric(
  "an inline grid sits on its first item's baseline, its bottom edge where it has none",
  async () => {
    // CSS Grid 1, 10.6: a grid's first baseline is that of its first item
    // in row-major order, and "if the grid item has no alignment baseline
    // in the grid's inline axis, then one is first synthesized from its
    // border edges". A grid took none from an item with no line in it and
    // had none of its own, so a grid of icons stood its whole height on
    // the line, and a button around one sat on its content box's bottom:
    // nextjs.org's 60px sidebar pickers made lines of 60.4px where the
    // strut reached 8.4px under a baseline 8px from the button's bottom.
    const mark =
      '<span class="m" style="display:inline-block;width:10px;height:10px">' +
      '</span>';
    const { node } = await render(
      '<style>body{margin:0;font:16px/20px sans-serif}' +
        '.g{display:inline-grid;width:100px} .i{width:36px;height:36px}' +
        '.s{width:36px;height:20px}</style>' +
        // an item with no line, in a grid taller than it
        `<div id="a"><div id="ag" class="g" style="height:60px">` +
        `<div class="i"></div></div>${mark}</div>` +
        // the first item where it is placed, not where it is written
        `<div id="b"><div id="bg" class="g"><div class="s" style="grid-row:2">` +
        `</div><div class="i" style="grid-row:1"></div></div>${mark}</div>` +
        // an item with no line before one with text: its edge, not the text
        `<div id="c"><div id="cg" class="g" style="height:60px;` +
        `grid-template-columns:auto auto"><div class="i"></div><div>text</div>` +
        `</div>${mark}</div>` +
        // an item with a line gives its own
        `<div id="d"><div id="dg" class="g" style="height:60px;` +
        `grid-template-columns:auto auto"><div id="dt">text</div>` +
        `<div class="i"></div></div>${mark}</div>` +
        // and a grid with no item has none: its bottom margin edge
        `<div id="e"><div id="eg" class="g" style="height:60px"></div>` +
        `${mark}</div>` +
        // a grid in an inline-block gives it the baseline it has on a line
        // of its own, its first, as Blink and Gecko both have it
        '<div id="g"><span id="gb" style="display:inline-block;width:100px">' +
        '<div style="display:grid"><div class="s" style="grid-row:2"></div>' +
        '<div class="i" style="grid-row:1"></div></div>' +
        `<div style="height:10px"></div></span>${mark}</div>` +
        // a button around a grid of icons sits on the first of them
        '<div id="f"><button id="fb" style="box-sizing:border-box;margin:0;' +
        'border:0;padding:4px;width:100%;height:60px"><div style="display:' +
        'grid;grid-template-columns:auto auto"><div class="i"></div>' +
        '<div class="s"></div></div></button></div>',
      300,
    );
    const el = view(node);
    const baselineOf = (id: string) => {
      const [line] = linesOf(el, id);
      return line.y + line.baseline;
    };
    const near = (a: number, b: number, what: string) =>
      assert.ok(Math.abs(a - b) < 0.01, `${what}: ${a} and ${b}`);
    near(baselineOf('a'), boxOf(el, 'ag').y + 36, "the item's bottom edge");
    assert.strictEqual(boxOf(el, 'a').height, 60, 'and a line no taller');
    near(baselineOf('b'), boxOf(el, 'bg').y + 36, 'the first row');
    near(baselineOf('c'), boxOf(el, 'cg').y + 36, 'the first item');
    const [text] = linesOf(el, 'dt');
    near(baselineOf('d'), text.y + text.baseline, "an item's own");
    near(baselineOf('e'), boxOf(el, 'eg').y + 60, 'no item');
    near(baselineOf('g'), boxOf(el, 'gb').y + 36, 'in a block, its first');
    assert.strictEqual(boxOf(el, 'f').height, 60, 'a button of a grid');
  },
);

test("a grid item's percentage height is of its area", async () => {
  // It was of the grid's height, so `height: 100%` in one of two rows was
  // as tall as both; and what is in a stretched item takes its percentages
  // of the item's height, as in a stretched flex item
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:grid;height:100px;grid-template-rows:50px 50px">' +
      '<div id="a" style="height:100%"><div id="b" style="height:50%">' +
      '</div></div><div id="c" style="height:100%"></div></div>' +
      '<div style="display:grid;height:200px;grid-template-rows:auto 60px">' +
      '<div><div id="d" style="height:50%"></div></div><div></div></div>' +
      // and of a row whose size is known only once the rows are sized
      '<div style="display:grid;height:200px;grid-template-rows:auto 60px">' +
      '<div id="e" style="height:50%"></div><div></div></div>',
  );
  const el = view(node);
  const height = (id: string) => boxOf(el, id).height;
  assert.deepStrictEqual([height('a'), height('b'), height('c')], [50, 25, 50]);
  assert.strictEqual(height('d'), 70, 'half the 140 its auto row is');
  assert.strictEqual(height('e'), 70);
});

test('a grid item that is a flex or grid container lays its items out in its stretched height', async () => {
  // CSS Grid 1, 11.1: an item is laid out in its area, whose height is
  // definite for it, and one stretched down it (6.2) is that tall — so a
  // card that is a column flex box has a height to share out: its
  // `margin-top: auto` takes what is free (CSS Flexbox 8.1), its `flex: 1`
  // grows (9.7). nextjs.org/blog is a grid of such cards, each ending in a
  // "Read more" that belongs at the card's bottom; the card was stretched
  // and what was in it left where its content's own height put it, the
  // button under the text and the rest of the card empty.
  const card = 'display:flex;flex-direction:column';
  const tall = '<div style="height:120px"></div>';
  const grid = (items: string, rows = '') =>
    `<div style="display:grid;grid-template-columns:repeat(3,100px);${rows}">` +
    `${items}</div>`;
  const { node } = await render(
    '<style>body{margin:0}.s{height:20px}.m{height:30px}</style>' +
      grid(
        `<div id="a" style="${card}"><div class="s"></div>` +
          '<div id="a2" class="m" style="margin-top:auto"></div></div>' +
          // the one its row is as tall as is laid out as it was
          `<div id="t" style="${card}"><div style="height:90px"></div>` +
          '<div id="t2" class="m" style="margin-top:auto"></div></div>' +
          tall,
      ) +
      grid(
        `<div id="b" style="${card}"><div id="b1" style="flex:1"></div>` +
          '<div id="b2" class="m"></div></div>' +
          `<div id="c" style="${card};justify-content:space-between">` +
          '<div class="s"></div><div id="c2" class="m"></div></div>' +
          tall,
      ) +
      grid(
        // a row's line is as tall as the item, and a grid's `fr` row fills it
        '<div id="d" style="display:flex;align-items:center">' +
          '<div id="d1" class="s" style="width:10px"></div>' +
          '<div id="d2" style="width:10px;align-self:stretch"></div></div>' +
          '<div id="e" style="display:grid;grid-template-rows:1fr auto">' +
          '<div id="e1"></div><div id="e2" class="m"></div></div>' +
          tall,
      ) +
      // and shorter than what it holds, where its row is, it shrinks them
      grid(
        `<div id="f" style="${card};overflow:hidden">` +
          '<div class="s" style="flex:none"></div>' +
          '<div id="f2" style="height:60px"></div></div>',
        'grid-template-rows:40px',
      ),
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  /** How far down its card an item is, and how tall. */
  const at = (id: string) => {
    const item = box(id);
    const top = (item as LaidBox & { parent: LaidBox }).parent.y;
    return [item.y - top, item.height];
  };
  assert.strictEqual(box('a').height, 120, 'stretched down its row');
  assert.deepStrictEqual(at('a2'), [90, 30], 'margin-top: auto');
  assert.deepStrictEqual(at('t2'), [90, 30], 'the tallest card');
  assert.deepStrictEqual(at('b1'), [0, 90], 'flex: 1 takes the rest');
  assert.deepStrictEqual(at('b2'), [90, 30]);
  assert.deepStrictEqual(at('c2'), [90, 30], 'space-between');
  assert.deepStrictEqual(at('d1'), [50, 20], 'centred in the line');
  assert.deepStrictEqual(at('d2'), [0, 120], 'stretched across it');
  assert.deepStrictEqual(at('e1'), [0, 90], 'the fr row');
  assert.deepStrictEqual(at('e2'), [90, 30]);
  assert.strictEqual(box('f').height, 40, 'as tall as its row');
  assert.deepStrictEqual(at('f2'), [20, 20], 'shrunk into it');
});

test('auto-fit tracks no item is in collapse, gaps and all', async () => {
  // `repeat(auto-fit, …)` was `auto-fill`: every repetition stayed, empty,
  // and took its share of the space `justify-content` distributes
  const { node } = await render(
    '<style>body{margin:0} .g{display:grid;width:200px;height:200px;' +
      'grid-template-columns:repeat(auto-fit,25px);' +
      'grid-template-rows:repeat(auto-fit,25px);' +
      'justify-content:space-evenly;align-content:space-evenly}' +
      '.g>div{width:25px;height:25px}</style>' +
      '<div class="g"><div id="a" style="grid-area:2/3"></div>' +
      '<div id="b" style="grid-area:3/4"></div></div>' +
      // a collapsed track's gaps collapse with it
      '<div style="display:grid;width:500px;gap:100px;' +
      'grid-template-columns:repeat(auto-fit,200px);justify-content:center">' +
      '<div id="c"></div></div>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('a'), [50, 50], 'two tracks, spaced evenly');
  assert.deepStrictEqual(at('b'), [125, 125]);
  assert.strictEqual(boxOf(el, 'c').x, 150, 'one track centred, no gap');
});

test('gaps may be percentages, and a grid is as wide as its tracks', async () => {
  // A percentage gap was dropped whole: it is of the content box's size
  // along it, and where that is not known, of the size the tracks come to
  // without it (CSS Box Alignment 3, 8.3)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:grid;width:200px;height:200px;gap:10%;' +
      'grid-template:90px 90px/90px 90px">' +
      '<div></div><div id="a"></div><div id="b"></div></div>' +
      '<div style="display:flex;width:200px;column-gap:25%">' +
      '<div style="width:20px"></div><div id="c" style="width:20px"></div>' +
      '</div>' +
      // a grid's own size is its tracks', not where an item past its
      // column ends
      '<div style="float:left"><div id="d" style="display:grid;' +
      'grid-template-columns:50px"><div style="width:200px"></div></div>' +
      '</div>' +
      // and an item whose width is its content's widest counts it so
      '<div style="float:left"><div id="e" style="display:grid;' +
      'grid-template-columns:min-content"><div style="width:max-content">' +
      '<span style="display:inline-block;width:60px"></span> ' +
      '<span style="display:inline-block;width:60px"></span></div></div>' +
      '</div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').x, 110, 'a column gap of 10% of 200');
  assert.strictEqual(boxOf(el, 'b').y, 110, 'a row gap of 10% of 200');
  assert.strictEqual(boxOf(el, 'c').x, 70);
  assert.strictEqual(boxOf(el, 'd').width, 50);
  assert.ok(boxOf(el, 'e').width >= 120, `${boxOf(el, 'e').width}`);
});

test("a grid item's intrinsic minimum wins over a smaller maximum", async () => {
  // Stretched across its area within its limits, the minimum the strongest
  // of them (CSS Sizing 3, 3.1): the grid's layout made it as wide as its
  // content, and laying it out at that width cut it to the maximum again
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:grid;grid-template-columns:300px">' +
      '<div id="a" style="height:6px;min-width:max-content;max-width:20px;' +
      'padding-left:22px"><div style="width:119px;height:6px"></div>' +
      '</div></div>',
  );
  assert.strictEqual(boxOf(view(node), 'a').width, 141);
});
