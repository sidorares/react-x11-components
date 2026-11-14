// <Html> — grid lanes (CSS Grid 3): `display: grid-lanes`, the lanes one
// axis's tracks make, and the placement down them.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import { applyDeclaration, initialStyle } from '../../src/html/css/style.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { boxOf, metric, render, view } from './harness.js';

afterEach(cleanup);

/** Each element child of `#g` as its id, left, top, width and height from
 *  the container, which has no border or padding, rounded. */
async function lanes(
  css: string,
  items: string,
  width = 600,
): Promise<{ items: Record<string, number[]>; size: number[] }> {
  const { node } = await render(
    '<style>body{margin:0;font:16px/20px sans-serif}</style>' +
      `<div id="g" style="${css}">${items}</div>`,
    width,
  );
  const g = boxOf(view(node), 'g');
  const out: Record<string, number[]> = {};
  for (const child of g.children) {
    const id = child.el?.attribs.id;
    if (!id) continue;
    out[id] = [child.x - g.x, child.y - g.y, child.width, child.height].map(
      Math.round,
    );
  }
  const size = [g.width, g.height].map(Math.round);
  cleanup();
  return { items: out, size };
}

const item = (id: string, style: string) =>
  `<div id="${id}" style="${style}"></div>`;

metric(
  'an item goes in the lane that leaves it highest, in order',
  async () => {
    // CSS Grid 3, 4.4: the running position of each track, the cursor after
    // the last item placed, and a tie threshold of nothing
    const { items, size } = await lanes(
      'display:grid-lanes;grid-template-columns:repeat(3,100px);gap:10px;' +
        'fit-tolerance:0;width:320px',
      item('a', 'height:50px') +
        item('b', 'height:20px') +
        item('c', 'height:30px') +
        item('d', 'height:20px;grid-column:span 2') +
        item('e', 'height:20px') +
        item('f', 'height:20px;grid-column:3'),
    );
    assert.deepStrictEqual(items, {
      a: [0, 0, 100, 50],
      b: [110, 0, 100, 20],
      c: [220, 0, 100, 30],
      // the start whose two tracks are lowest, under b and c
      d: [110, 40, 210, 20],
      e: [0, 60, 100, 20],
      // its own track, under d
      f: [220, 70, 100, 20],
    });
    assert.strictEqual(size[1], 90, 'as tall as the stacking range');
  },
);

metric(
  'fit-tolerance ties lanes near the highest, and normal is 1em',
  async () => {
    const placed = async (tolerance: string) =>
      (
        await lanes(
          'display:grid-lanes;grid-template-columns:repeat(3,100px);gap:10px;' +
            `width:320px;${tolerance}`,
          item('a', 'height:30px') +
            item('b', 'height:20px') +
            item('c', 'height:40px') +
            item('d', 'height:20px'),
        )
      ).items.d;
    // the second lane is 10px higher than the first, and 16px is a tie: the
    // cursor is past the last lane, so the first of the tied ones
    assert.deepStrictEqual(await placed(''), [0, 40, 100, 20], 'normal');
    assert.deepStrictEqual(
      await placed('fit-tolerance:0'),
      [110, 30, 100, 20],
      'no tolerance',
    );
    assert.deepStrictEqual(
      await placed('fit-tolerance:5px'),
      [110, 30, 100, 20],
      'less than the difference',
    );
    assert.deepStrictEqual(
      await placed('fit-tolerance:infinite'),
      [0, 40, 100, 20],
      'infinite fills in order',
    );
  },
);

metric('an item with no line sizes every lane it could go in', async () => {
  // 3.4: a grid would size the second column by the second item alone
  const auto = await lanes(
    'display:inline-grid-lanes;grid-template-columns:auto auto',
    item('a', 'width:150px;height:10px') + item('b', 'width:50px;height:10px'),
  );
  assert.strictEqual(auto.size[0], 300, 'both columns 150px');
  const placed = await lanes(
    'display:inline-grid-lanes;grid-template-columns:auto auto',
    item('a', 'width:150px;height:10px;grid-column:1') +
      item('b', 'width:50px;height:10px;grid-column:2'),
  );
  assert.strictEqual(placed.size[0], 200, 'each column by its own item');
});

metric(
  'row lanes stack along the inline axis and stretch down their row',
  async () => {
    // 2.3: a row template and no column one makes the lanes rows
    const { items, size } = await lanes(
      'display:grid-lanes;grid-template-rows:40px 40px;gap:10px;width:300px',
      item('a', 'width:50px') +
        item('b', 'width:30px') +
        item('c', 'width:20px'),
    );
    assert.deepStrictEqual(items, {
      a: [0, 0, 50, 40],
      b: [0, 50, 30, 40],
      // the second row ends 20px before the first, more than 1em
      c: [40, 50, 20, 40],
    });
    assert.strictEqual(size[1], 90);
  },
);

metric(
  'track-reverse fills from the last lane, fill-reverse from the far edge',
  async () => {
    const reversed = await lanes(
      'display:grid-lanes;grid-lanes-direction:column track-reverse;' +
        'grid-template-columns:repeat(3,100px);width:300px',
      item('a', 'height:20px') + item('b', 'height:20px'),
    );
    assert.deepStrictEqual(reversed.items, {
      a: [200, 0, 100, 20],
      b: [100, 0, 100, 20],
    });
    // the stacking range mirrored in itself, and at the container's far edge
    // where `align-content` is `normal`
    const filled = await lanes(
      'display:grid-lanes;grid-lanes-direction:column fill-reverse;' +
        'grid-template-columns:100px;row-gap:10px;width:100px;height:200px',
      item('a', 'height:20px') + item('b', 'height:30px'),
    );
    assert.deepStrictEqual(filled.items, {
      a: [0, 180, 100, 20],
      b: [0, 140, 100, 30],
    });
    const started = await lanes(
      'display:grid-lanes;grid-lanes-direction:column fill-reverse;' +
        'grid-template-columns:100px;row-gap:10px;width:100px;height:200px;' +
        'align-content:start',
      item('a', 'height:20px') + item('b', 'height:30px'),
    );
    assert.deepStrictEqual(started.items, {
      a: [0, 40, 100, 20],
      b: [0, 0, 100, 30],
    });
  },
);

metric('dense puts an item back in a hole a spanning item left', async () => {
  const placed = async (pack: string) =>
    (
      await lanes(
        'display:grid-lanes;grid-template-columns:repeat(3,100px);' +
          `fit-tolerance:0;width:300px;${pack}`,
        item('a', 'height:20px') +
          item('b', 'height:50px') +
          item('c', 'height:60px') +
          item('d', 'height:20px;grid-column:span 2') +
          item('e', 'height:20px') +
          item('f', 'height:20px'),
      )
    ).items;
  const sparse = await placed('');
  assert.deepStrictEqual(sparse.d, [0, 50, 200, 20]);
  assert.deepStrictEqual(sparse.e, [200, 60, 100, 20]);
  const dense = await placed('grid-lanes-pack:dense');
  assert.deepStrictEqual(dense.e, [0, 20, 100, 20], 'under a, above d');
  // and the running positions are as they were before it
  assert.deepStrictEqual(dense.f, [200, 60, 100, 20]);
});

metric('auto-fit collapses the lanes no item can need', async () => {
  // 3.3.1: two items, two lanes in use, and the rest of the repetition gone
  const { items } = await lanes(
    'display:grid-lanes;grid-template-columns:repeat(auto-fit,100px);' +
      'width:500px;justify-content:center',
    item('a', 'height:20px') + item('b', 'height:20px'),
  );
  assert.deepStrictEqual(items, {
    a: [150, 0, 100, 20],
    b: [250, 0, 100, 20],
  });
});

metric(
  'a subgrid takes the lanes it spans, and its items size them',
  async () => {
    // CSS Grid 3, 3.2: x sizes the second lane and y the third, beside what
    // a, placed by the lanes, makes of all three
    const { node } = await render(
      '<style>body{margin:0;font:16px/20px sans-serif}</style>' +
        '<div id="g" style="display:inline-grid-lanes;' +
        'grid-template-columns:auto auto auto;column-gap:10px">' +
        '<div id="a" style="width:50px;height:10px"></div>' +
        '<div id="s" style="display:grid;grid-template-columns:subgrid;' +
        'grid-column:2/4;column-gap:10px">' +
        '<div id="x" style="width:80px;height:10px"></div>' +
        '<div id="y" style="height:10px"></div></div></div>',
      600,
    );
    const el = view(node);
    const g = boxOf(el, 'g');
    const at = (id: string) => {
      const b = boxOf(el, id);
      return [b.x - g.x, b.width].map(Math.round);
    };
    assert.strictEqual(Math.round(g.width), 200, 'lanes of 50, 80 and 50');
    assert.deepStrictEqual(at('s'), [60, 140]);
    assert.deepStrictEqual(at('x'), [60, 80]);
    assert.deepStrictEqual(at('y'), [150, 50], 'stretched across its lane');
  },
);

/** Each element under `#g` as its id, left, top, width and height from `#g`,
 *  which has no border or padding, rounded; and `#g`'s width and height. */
async function nested(
  html: string,
): Promise<{ at: Record<string, number[]>; size: number[] }> {
  const { node } = await render(
    '<style>body{margin:0;font:16px/20px sans-serif}</style>' + html,
    600,
  );
  const el = view(node);
  const g = boxOf(el, 'g');
  const at: Record<string, number[]> = {};
  const walk = (box: typeof g) => {
    for (const child of box.children) {
      const id = child.el?.attribs.id;
      if (id) {
        at[id] = [child.x - g.x, child.y - g.y, child.width, child.height].map(
          Math.round,
        );
      }
      walk(child);
    }
  };
  walk(g);
  const size = [g.width, g.height].map(Math.round);
  cleanup();
  return { at, size };
}

/** A grid lanes subgrid of a parent's columns 2 and 3: `w` placed in its
 *  first lane, and `x` and `y` placed by it. */
const LANES_SUBGRID =
  '<div id="s" style="display:grid-lanes;grid-template-columns:subgrid;' +
  'grid-column:2/4;fit-tolerance:0">' +
  '<div id="w" style="grid-column:1;width:100px;height:10px"></div>' +
  '<div id="x" style="width:80px;height:30px"></div>' +
  '<div id="y" style="height:10px"></div></div>';

/** Where `LANES_SUBGRID`'s items go, from a parent whose first column is
 *  50px and whose gap is 10px: w sizes the parent's second column alone,
 *  and x, which could go in either lane, both; x goes in the lower lane,
 *  and y under w. */
const IN_LANES_SUBGRID = {
  s: [60, 0, 190, 30],
  w: [60, 0, 100, 10],
  x: [170, 0, 80, 30],
  y: [60, 10, 100, 10],
};

metric(
  "grid lanes subgrid a grid's columns, and their items size them",
  async () => {
    // CSS Grid 3, 3.2 and CSS Grid 2, 9: its lanes are the grid's columns
    // over its span, and their gap the grid's, its own being `normal`
    const { at, size } = await nested(
      '<div id="g" style="display:inline-grid;' +
        'grid-template-columns:50px auto auto;column-gap:10px">' +
        '<div id="a" style="height:10px"></div>' +
        LANES_SUBGRID +
        '</div>',
    );
    assert.deepStrictEqual(size, [250, 30]);
    const { a, ...rest } = at;
    assert.deepStrictEqual(a, [0, 0, 50, 10]);
    assert.deepStrictEqual(rest, IN_LANES_SUBGRID);
  },
);

metric(
  'grid lanes subgrid the lanes of grid lanes, and their items size them',
  async () => {
    const { at, size } = await nested(
      '<div id="g" style="display:inline-grid-lanes;' +
        'grid-template-columns:50px auto auto;column-gap:10px;' +
        'fit-tolerance:0">' +
        '<div id="a" style="height:10px"></div>' +
        LANES_SUBGRID +
        '<div id="b" style="height:10px"></div></div>',
    );
    assert.deepStrictEqual(size, [250, 30]);
    const { a, b, ...rest } = at;
    assert.deepStrictEqual(a, [0, 0, 50, 10]);
    assert.deepStrictEqual(rest, IN_LANES_SUBGRID);
    assert.deepStrictEqual(b, [0, 10, 50, 10], 'under a, the lowest lane');
  },
);

metric(
  "grid lanes subgrid a grid's rows where their lanes are rows",
  async () => {
    // w sizes the second row alone and x both; x goes in the lane that is
    // shorter across, and y beside w, stretched down its lane
    const { at, size } = await nested(
      '<div id="g" style="display:inline-grid;' +
        'grid-template-rows:20px auto auto;row-gap:10px">' +
        '<div id="a"></div>' +
        '<div id="s" style="display:grid-lanes;grid-template-rows:subgrid;' +
        'grid-row:2/4;fit-tolerance:0">' +
        '<div id="w" style="grid-row:1;width:10px;height:40px"></div>' +
        '<div id="x" style="width:20px;height:30px"></div>' +
        '<div id="y" style="width:10px"></div></div></div>',
    );
    assert.deepStrictEqual(size, [20, 110]);
    const { a, ...rest } = at;
    assert.deepStrictEqual(a, [0, 0, 20, 20]);
    assert.deepStrictEqual(rest, {
      s: [0, 30, 20, 80],
      w: [0, 30, 10, 40],
      x: [0, 80, 20, 30],
      y: [10, 30, 10, 40],
    });
  },
);

const LOOK = {
  color: '#000000',
  fontFamily: 'sans-serif',
  fontSize: 16,
  monoFamily: 'monospace',
  linkColor: '#0000ee',
  borderColor: '#000000',
  mutedColor: '#666666',
  background: '#ffffff',
  colorScheme: 'light' as const,
  surface: '#ffffff',
  controlPadY: 4,
  controlBorder: 1,
  controlRadius: 4,
};

/** A style with each declaration applied in turn. */
function styled(...declarations: [string, string][]): ComputedStyle {
  const initial = initialStyle(LOOK, 1);
  const style = { ...initial };
  const ctx = { em: 40, rem: 16, vw: 0, vh: 0, scale: 1, initial };
  for (const [name, value] of declarations) {
    applyDeclaration(style, initial, name, value, ctx);
  }
  return style;
}

test('display takes grid-lanes, and a grid lanes container is a grid', () => {
  for (const [value, display] of [
    ['grid-lanes', 'flex'],
    ['inline-grid-lanes', 'inline-flex'],
    ['inline grid-lanes', 'inline-flex'],
    ['block grid-lanes', 'flex'],
  ] as const) {
    const style = styled(['display', value]);
    assert.strictEqual(style.display, display, value);
    assert.ok(style.grid && style.gridLanes, value);
  }
  const grid = styled(['display', 'grid']);
  assert.ok(grid.grid && !grid.gridLanes);
});

test('grid-lanes-direction, grid-lanes-pack and fit-tolerance parse as WPT has them', () => {
  // css/css-grid/grid-lanes/tentative/parsing
  const direction = (value: string) =>
    styled(['grid-lanes-direction', value]).gridLanesDirection;
  assert.strictEqual(direction('row'), 'row');
  assert.strictEqual(
    direction('column track-reverse fill-reverse'),
    'column fill-reverse track-reverse',
  );
  for (const bad of [
    'auto',
    'normal track-reverse',
    'row-reverse',
    'row fill-reverse fill-reverse',
    'track-reverse row',
  ]) {
    assert.strictEqual(direction(bad), 'normal', bad);
  }
  assert.strictEqual(
    styled(['grid-lanes-pack', 'dense']).gridLanesPack,
    'dense',
  );
  assert.strictEqual(
    styled(['grid-lanes-pack', 'normal dense']).gridLanesPack,
    'normal',
  );
  const tolerance = (value: string) =>
    styled(['fit-tolerance', value]).fitTolerance;
  assert.strictEqual(tolerance('infinite'), 'infinite');
  assert.strictEqual(tolerance('10px'), 10);
  assert.deepStrictEqual(tolerance('20%'), { pct: 20 });
  // a calculation below nought is nought, and a length written below it is
  // refused
  assert.strictEqual(tolerance('calc(-0.5em + 10px)'), 0);
  assert.strictEqual(tolerance('calc(0.5em + 10px)'), 30);
  for (const bad of ['-1px', '-10%', '10', 'auto', '10px 20px', '1fr']) {
    assert.strictEqual(tolerance(bad), 'normal', bad);
  }
});

test('the grid-lanes shorthand sets the lanes axis template and the direction', () => {
  const lanes = (value: string) => {
    const style = styled(['grid-lanes', value]);
    return {
      columns: style.gridColumns?.tracks.length ?? null,
      rows: style.gridRows?.tracks.length ?? null,
      areas: style.gridAreas
        ? [style.gridAreas.rows, style.gridAreas.columns]
        : null,
      direction: style.gridLanesDirection,
    };
  };
  assert.deepStrictEqual(lanes('100px 200px'), {
    columns: 2,
    rows: null,
    areas: null,
    direction: 'column',
  });
  assert.deepStrictEqual(lanes('"b b a" 1fr 2fr 3fr row'), {
    columns: null,
    rows: 3,
    areas: [3, 1],
    direction: 'row',
  });
  assert.deepStrictEqual(lanes('row fill-reverse 20% 40% "b a"'), {
    columns: null,
    rows: 2,
    areas: [2, 1],
    direction: 'row fill-reverse',
  });
  assert.deepStrictEqual(lanes('none'), {
    columns: null,
    rows: null,
    areas: null,
    direction: 'column',
  });
  for (const bad of [
    'row normal "a a" 1fr',
    '10px 20px "a a" "b b" row',
    '"a" "b" track-reverse fill-reverse row',
    '[one] 10px [two] [three]',
    '100px 100px column-reverse',
  ]) {
    assert.strictEqual(
      styled(['grid-lanes-direction', 'row'], ['grid-lanes', bad])
        .gridLanesDirection,
      'row',
      bad,
    );
  }
});

test('an auto repetition takes tracks its content sizes, and fixed ones beside it', () => {
  // CSS Grid 3, 3.1.1 relaxes the repetition; CSS Grid 2, 7.2's
  // `<auto-track-list>` still holds the tracks around it to fixed sizes
  const columns = (value: string) =>
    styled(['grid-template-columns', value]).gridColumns;
  assert.ok(columns('repeat(auto-fill, auto)')?.repeat, 'intrinsic repetition');
  assert.ok(columns('100px repeat(auto-fill, auto) minmax(20px, 1fr)')?.repeat);
  assert.strictEqual(
    columns('max-content repeat(auto-fill, max-content) max-content'),
    null,
    'an intrinsic track beside it',
  );
  assert.strictEqual(columns('1fr repeat(auto-fill, 100px)'), null, 'an fr');
});
