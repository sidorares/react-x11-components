// <Html> — flex layout.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, waitFor } from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import {
  RED_PNG,
  SVG_NS,
  boxOf,
  fillsOf,
  linesOf,
  metric,
  render,
  renderWithBytes,
  svgBytes,
  view,
} from './harness.js';
import type { LaidBox, PlacedLine } from './harness.js';

afterEach(cleanup);

metric('display:flex lays out through yoga', async () => {
  const { node } = await render(
    '<style>.row{display:flex}.row>div{flex:1}</style>' +
      '<div class="row"><div>a</div><div>b</div><div>c</div></div>',
    300,
  );
  const tree = (view(node) as unknown as { _tree: { root: unknown } })._tree;
  const items: { x: number; width: number }[] = [];
  const walk = (box: {
    kind: string;
    style: { display: string };
    x: number;
    width: number;
    children: unknown[];
  }): void => {
    if (box.kind === 'flex') {
      for (const child of box.children) {
        const c = child as typeof box;
        items.push({ x: c.x, width: c.width });
      }
    }
    for (const child of box.children) walk(child as typeof box);
  };
  walk(tree.root as never);
  assert.strictEqual(items.length, 3, 'three flex items');
  assert.ok(
    items[0].x < items[1].x && items[1].x < items[2].x,
    'laid out in a row',
  );
  assert.ok(
    Math.abs(items[0].width - items[1].width) < 2,
    'flex: 1 shares the line evenly',
  );
});

metric(
  'a flex container whose children are bare text still renders them',
  async () => {
    // Flex has no inline formatting context: a run of inline content becomes
    // an anonymous item. Dropping it renders an empty row.
    const { node } = await render('<div style="display:flex">just text</div>');
    const el = view(node);
    assert.ok(el.textContent().includes('just text'));
    const tree = (
      view(node) as unknown as {
        _tree: { root: { children: { height: number }[] } };
      }
    )._tree;
    assert.ok(tree.root.children[0].height > 10, 'the row has the text height');
  },
);

test('a flex item as wide as its content keeps it on one line', async () => {
  // An item exactly as wide as its content — `width: fit-content` in a
  // column, an item its content sizes in a row, a flex box sized to what it
  // holds — has that width held by Yoga as a float32, and a width rounded
  // down under the content laid it out a hair too narrow: meetup.com's
  // "About us" and "Related topics" headings wrapped their last word. Two
  // boxes whose widths sum to 116.728px, which a float32 holds as
  // 116.72799682…, stand in for a line of text.
  const line = (n: number) =>
    `<div style="line-height:10px">` +
    `<span id="a${n}" style="display:inline-block;width:106.728px;height:10px"></span>` +
    `<span id="b${n}" style="display:inline-block;width:10px;height:10px"></span>` +
    `</div>`;
  const shapes = [
    (n: number) =>
      `<div style="display:flex;flex-direction:column">` +
      `<div id="fit${n}" style="width:fit-content">${line(n)}</div></div>`,
    (n: number) =>
      `<div style="display:flex;align-items:baseline;justify-content:space-between">` +
      `<div style="display:flex;gap:8px">${line(n)}</div></div>`,
    (n: number) =>
      `<div style="display:flex">` +
      `<div style="display:flex;flex-direction:column">${line(n)}</div></div>`,
    (n: number) =>
      `<div style="display:flex;flex-direction:column;width:fit-content">` +
      `<div style="display:flex">${line(n)}</div></div>`,
  ];
  const { node } = await render(shapes.map((shape, n) => shape(n)).join(''));
  const el = view(node);
  assert.strictEqual(boxOf(el, 'fit0').width, 116.728);
  shapes.forEach((_, n) =>
    assert.strictEqual(
      boxOf(el, `b${n}`).y,
      boxOf(el, `a${n}`).y,
      `shape ${n}: the second box beside the first, not under it`,
    ),
  );
});

test('a replaced flex item is as wide as the flex layout made it', async () => {
  // Laid out alone a replaced box takes its own `width` or its intrinsic
  // one: two fields `width: 0; flex: 1` were no width at all, and so never
  // mounted, and images `flex: 1` overlapped at their own widths.
  const { node } = await render(
    '<div style="display:flex;width:300px">' +
      '<input id="a" style="width:0;flex:1;margin:0">' +
      '<input id="b" style="width:0;flex:1;margin:0">' +
      '<img id="c" width="50" height="20" style="flex:1">' +
      '</div>',
  );
  const el = view(node);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
  assert.deepStrictEqual(
    [a.width, b.width, c.width],
    [100, 100, 100],
    'each takes a third',
  );
  assert.deepStrictEqual([a.x, b.x, c.x], [a.x, a.x + 100, a.x + 200]);
});

test('a flex and a grid property is inherited, and set back to its initial value', async () => {
  // `inherit`, `initial` and `unset` reached none of them: `align-self:
  // inherit` in the suite's flex boxes was `auto`
  const { node } = await render(
    '<div style="display:flex;flex-flow:column wrap;justify-content:center;' +
      'align-items:flex-end;align-self:center;align-content:space-between;' +
      'flex:2 3 40px;order:4;gap:6px 8px;grid-template-columns:10px 20px;' +
      'justify-items:center;grid-column:2 / 3">' +
      '<div id="a" style="flex-flow:inherit;justify-content:inherit;' +
      'align-items:inherit;align-self:inherit;align-content:inherit;' +
      'flex:inherit;order:inherit;gap:inherit;' +
      'grid-template-columns:inherit;justify-items:inherit;' +
      'grid-column:inherit"></div>' +
      '<div id="b" style="flex-direction:row-reverse;order:3;flex-grow:2;' +
      'order:initial;flex-grow:initial;flex-direction:unset"></div></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
  const a = style('a');
  assert.strictEqual(a.flexDirection, 'column');
  assert.strictEqual(a.flexWrap, 'wrap');
  assert.strictEqual(a.justifyContent, 'center');
  assert.strictEqual(a.alignItems, 'flex-end');
  assert.strictEqual(a.alignSelf, 'center');
  assert.strictEqual(a.alignContent, 'space-between');
  assert.deepStrictEqual([a.flexGrow, a.flexShrink, a.flexBasis], [2, 3, 40]);
  assert.strictEqual(a.order, 4);
  assert.deepStrictEqual([a.rowGap, a.columnGap], [6, 8]);
  assert.ok(a.gridColumns !== null, 'the template');
  assert.strictEqual(a.justifyItems, 'center');
  const b = style('b');
  assert.strictEqual(b.order, 0);
  assert.strictEqual(b.flexGrow, 0);
  assert.strictEqual(b.flexDirection, 'row');
});

metric(
  'flex items are painted in `order`, and by a `z-index` of their own',
  async () => {
    // CSS Flexbox 5.4: an item paints as an inline block does, in `order`,
    // and a `z-index` makes it a stacking context unpositioned
    const { node } = await render(
      '<style>body{margin:0} .r{display:flex} .r>div{width:40px;' +
        'height:20px;margin-right:-20px}</style>' +
        '<div class="r"><div style="order:2;background:#ff0000"></div>' +
        '<div style="order:1;background:#00ff00"></div></div>' +
        '<div class="r"><div style="z-index:2;background:#0000ff"></div>' +
        '<div style="z-index:1;background:#ffff00"></div></div>',
    );
    const fills = await fillsOf(view(node));
    const at = (color: string) =>
      fills.findIndex((f) => f.style === parseColor(color));
    assert.ok(at('#00ff00') < at('#ff0000'), 'the second in `order` over');
    assert.ok(at('#ffff00') < at('#0000ff'), 'the higher `z-index` over');
  },
);

metric(
  "a flex box's background goes with the flow's, and its items with its lines",
  async () => {
    // CSS 2.1 Appendix E: a block-level flex box's background and borders
    // are painted with the other blocks', in the document's order, and its
    // items as inline blocks are, over all of them — painted whole in its
    // place, it covered the block after it that a negative margin drew up
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="display:flex;height:40px;background:#ff0000">' +
        '<div style="width:20px;background:#0000ff"></div></div>' +
        '<div style="height:40px;margin-top:-40px;background:#00ff00"></div>',
    );
    const fills = await fillsOf(view(node));
    const at = (color: string) =>
      fills.findIndex((f) => f.style === parseColor(color));
    assert.ok(at('#ff0000') < at('#00ff00'), 'the next block over the box');
    assert.ok(at('#00ff00') < at('#0000ff'), 'and the item over both');
  },
);

metric(
  "justify-content's start, end, left and right follow the flex box's direction",
  async () => {
    // CSS Box Alignment 3, 6.1: `start` and `end` are the writing mode's,
    // so a reversed row turns them round; `left` and `right` are the
    // page's along a row, and `start` along a column. Read as the main
    // axis's own ends, `right` put a column's items at its bottom
    const place = async (css: string) => {
      const { node } = await render(
        '<style>body{margin:0} .f{display:flex;width:100px;height:100px}' +
          '.f>div{width:20px;height:20px}</style>' +
          `<div class="f" style="${css}"><div id="i"></div></div>`,
      );
      const box = boxOf(view(node), 'i');
      cleanup();
      return [box.x, box.y];
    };
    assert.deepStrictEqual(
      await place('flex-direction:column;justify-content:right'),
      [0, 0],
    );
    assert.deepStrictEqual(
      await place('flex-direction:row-reverse;justify-content:start'),
      [0, 0],
    );
    assert.deepStrictEqual(
      await place('flex-direction:row-reverse;justify-content:right'),
      [80, 0],
    );
    assert.deepStrictEqual(
      await place('direction:rtl;justify-content:left'),
      [0, 0],
    );
    assert.deepStrictEqual(
      await place('flex-direction:column-reverse;justify-content:end'),
      [0, 80],
    );
    assert.deepStrictEqual(
      await place('justify-content:unsafe center'),
      [40, 0],
    );
  },
);

metric(
  'a replaced flex item is the size the flex layout makes it',
  async () => {
    // An image was measured as nothing wide — its content's width, of which
    // it has none — and then laid out at its natural size whatever the
    // flex layout said: it did not grow, stretch or shrink. It grows, as
    // tall as its ratio makes the width it grew to (CSS Flexbox 9.4, step
    // 7), and stretches; it shrinks no further than its natural width; a
    // line of a definite height that stretches it gives it the width its
    // ratio makes of that height; and `flex-basis: content` is its
    // content's width whatever width it has
    const { node } = await render(
      '<style>body{margin:0} .r{display:flex;width:200px}</style>' +
        '<div class="r"><canvas id="a" width="20" height="10" ' +
        'style="flex-grow:1"></canvas></div>' +
        '<div class="r" style="width:10px"><canvas id="b" width="60" ' +
        'height="60"></canvas></div>' +
        '<div class="r" style="height:50px"><canvas id="c" width="20" ' +
        'height="150"></canvas></div>' +
        '<div class="r"><div id="d" style="flex-basis:content;width:0">' +
        '<span style="display:inline-block;width:30px"></span></div></div>',
    );
    const el = view(node);
    const size = (id: string) => {
      const box = boxOf(el, id);
      return [box.width, box.height];
    };
    assert.deepStrictEqual(size('a'), [200, 100], 'grown along its row');
    assert.deepStrictEqual(size('b'), [60, 60], 'not shrunk under its width');
    const [width, height] = size('c');
    assert.strictEqual(height, 50, 'stretched across its line');
    assert.ok(Math.abs(width - (50 * 20) / 150) < 0.01, `${width}`);
    assert.strictEqual(size('d')[0], 30, "its content's width, not its own");
  },
);

metric('flex items are laid out in `order`', async () => {
  // CSS Flexbox 5.4: `order` first, the document's where it is the same;
  // an `order` that is no integer is no value
  const { node } = await render(
    '<style>body{margin:0} .r{display:flex} .r>div{width:20px;height:10px}' +
      '</style><div class="r"><div id="a" style="order:2"></div>' +
      '<div id="b"></div><div id="c" style="order:-1"></div>' +
      '<div id="d" style="order:1.5"></div></div>',
  );
  const el = view(node);
  const x = (id: string) => boxOf(el, id).x;
  assert.deepStrictEqual(
    ['a', 'b', 'c', 'd'].map(x),
    [60, 20, 0, 40],
    'c, then b and d as they come, then a',
  );
});

metric(
  'flex items aligned by their baselines line up their first lines',
  async () => {
    // Yoga has no baseline for an item it measures, and lined them up by
    // their bottoms; a line of them is as tall as their baselines make it,
    // and a box that wraps sets one at its line's start below its margin
    const { node } = await render(
      '<style>body{margin:0} .r{display:flex;align-items:baseline;width:300px}' +
        '.r>div{width:60px}</style>' +
        '<div class="r" id="row"><div id="a" style="font-size:40px;' +
        'line-height:40px">A</div><div id="b" style="font-size:10px;' +
        'line-height:10px;padding-bottom:40px">b</div></div>' +
        '<div class="r" id="wrap" style="flex-wrap:wrap;align-items:flex-start;' +
        'width:120px"><div id="c" style="margin-top:10px;height:8px"></div>' +
        '<div style="height:30px"></div><div style="height:16px"></div></div>',
    );
    const el = view(node);
    const baseline = (id: string) => {
      const [line] = linesOf(el, id);
      return line.y + line.baseline;
    };
    assert.ok(
      Math.abs(baseline('a') - baseline('b')) < 0.01,
      `${baseline('a')} and ${baseline('b')}`,
    );
    const row = boxOf(el, 'row');
    const b = boxOf(el, 'b');
    assert.ok(b.y > row.y, 'the small one lower');
    assert.ok(
      Math.abs(row.y + row.height - (b.y + b.height)) < 0.01,
      'and the line as tall as it reaches',
    );
    assert.strictEqual(
      boxOf(el, 'c').y - boxOf(el, 'wrap').y,
      10,
      'its margin above it',
    );
  },
);

metric(
  "a flex item's first line is its baseline past its border box, unless it scrolls",
  async () => {
    // CSS Box Alignment 3, 9.1: a baseline is clamped to the border edge of
    // a scroll container alone — at either side, and wherever that is in
    // the item. An item shorter than its text, or whose padding puts the
    // text under it, was clamped to its height, and stood below the items
    // beside it by as much as its line hung out of it
    const row = (id: string, item: string) =>
      `<div class="r"><div id="${id}" ${item}</div>` +
      `<div id="${id}-by">x</div></div>`;
    const { node } = await render(
      '<style>body{margin:0;font:16px/20px sans-serif}' +
        '.r{display:flex;align-items:baseline;width:300px}</style>' +
        row('short', 'style="height:4px">x') +
        row('max', 'style="max-height:4px">x') +
        row('padded', 'style="padding-top:30px;height:0">x') +
        row('clip', 'style="overflow:clip;height:4px">x') +
        row('hidden', 'style="overflow:hidden;height:4px">x') +
        row(
          'above',
          'style="overflow:hidden;height:30px"><div style="margin-top:-20px">' +
            'x</div>',
        ) +
        row('nested', '><div style="overflow:auto;height:4px">x</div>x'),
    );
    const el = view(node);
    const baseline = (id: string) => {
      const [line] = linesOf(el, id);
      return line.y + line.baseline;
    };
    const near = (a: number, b: number, what: string) =>
      assert.ok(Math.abs(a - b) < 0.01, `${what}: ${a}, ${b}`);
    for (const id of ['short', 'max', 'padded', 'clip']) {
      near(baseline(id), baseline(`${id}-by`), `${id} on its line`);
    }
    const hidden = boxOf(el, 'hidden');
    near(hidden.y + hidden.height, baseline('hidden-by'), 'on its bottom');
    near(boxOf(el, 'above').y, baseline('above-by'), 'on its top');
    near(
      boxOf(el, 'nested').y + 4,
      baseline('nested-by'),
      'on the bottom of the box inside it that scrolls',
    );
  },
);

test('an item with an auto margin across a row aligned by baselines takes the room its line has past it', async () => {
  // An item with an `auto` margin across the line takes no part in
  // aligning it by baselines (CSS Flexbox 8.3, 9.4 step 8): the margin
  // takes the room past it (8.1). Yoga takes the pass that sets the items
  // of a row that wraps across their lines for any row an item of is
  // aligned by its baseline, and that pass reads the alignment and not the
  // margins: it set each of these by its baseline, as tall as the items
  // and not the row, and the items beside it by its baseline too.
  const row = (style: string, items: string) =>
    `<div style="display:flex;width:200px;${style}">${items}</div>`;
  const item = (id: string, style: string) =>
    `<div${id ? ` id="${id}"` : ''} style="width:20px;${style}"></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      row(
        'align-items:baseline;height:60px',
        item('a', 'height:18px;margin-top:auto') + item('', 'height:18px'),
      ) +
      row(
        'height:60px',
        item('b', 'height:10px;margin:auto 0 3px;align-self:baseline') +
          item('', 'height:18px;align-self:baseline'),
      ) +
      // beside two items that are aligned by their baselines
      row(
        'height:60px',
        item('c', 'height:10px;margin-top:auto;align-self:baseline') +
          item('d', 'height:10px;margin-top:4px;align-self:baseline') +
          item('', 'height:30px;align-self:baseline'),
      ) +
      // beside one, which is at the line's start whatever it is beside
      row(
        'align-items:baseline',
        item('e', 'height:50px;margin-top:auto') + item('f', 'height:18px'),
      ) +
      row(
        'align-items:baseline',
        item('g', 'height:10px;margin:auto 0') +
          item('h', 'height:18px;margin-top:7px'),
      ) +
      row(
        'align-items:baseline',
        item('i', 'height:18px;margin:5px 0 auto') + item('j', 'height:18px'),
      ) +
      // not stretched, and the line is the row's for the others in it
      row(
        'align-items:baseline;height:60px',
        '<div id="k" style="align-self:stretch;margin-bottom:auto">' +
          item('', 'height:12px') +
          '</div>' +
          item('l', 'height:10px;align-self:center') +
          item('m', 'height:10px;margin-top:auto;align-self:flex-start') +
          item('', 'height:18px'),
      ),
  );
  const el = view(node);
  const at = (id: string) => {
    const box = boxOf(el, id) as LaidBox & { parent: LaidBox };
    return [box.y - box.parent.y, box.height];
  };
  assert.deepStrictEqual(at('a'), [42, 18], 'at the end of the row');
  assert.deepStrictEqual(at('b'), [47, 10], 'within its bottom margin');
  assert.deepStrictEqual(at('c'), [50, 10], 'at the end, beside two');
  assert.deepStrictEqual(at('d'), [20, 10], 'the two by their baselines');
  assert.deepStrictEqual(at('e'), [0, 50], 'as tall as the row');
  assert.deepStrictEqual(at('f'), [0, 18], 'the other at its start');
  assert.deepStrictEqual(at('g'), [7.5, 10], 'centred');
  assert.deepStrictEqual(at('h'), [7, 18], 'the other within its margin');
  assert.deepStrictEqual(at('i'), [5, 18], 'at the start');
  assert.deepStrictEqual(at('j'), [0, 18], 'the other not below it');
  assert.deepStrictEqual(at('k'), [0, 12], 'not stretched');
  assert.deepStrictEqual(at('l'), [25, 10], 'centred in the row');
  assert.deepStrictEqual(at('m'), [50, 10], 'the margin over its alignment');
});

metric("an inline flex box sits on its first item's baseline", async () => {
  // CSS Flexbox 8.5: its first line's items aligned by their baselines, or
  // its first item — not its last line box, as an inline block does
  const { node } = await render(
    '<style>body{margin:0}</style><div id="p">x<span id="f" ' +
      'style="display:inline-flex"><span style="font-size:10px;' +
      'line-height:10px">b</span><span style="font-size:30px;' +
      'line-height:30px">C</span></span></div>',
  );
  const el = view(node);
  const [line] = linesOf(el, 'p');
  const flex = boxOf(el, 'f');
  const small = flex.children[0] as unknown as { lines: PlacedLine[] };
  const [first] = small.lines;
  assert.ok(
    Math.abs(first.y + first.baseline - (line.y + line.baseline)) < 0.01,
    'the small item on the line',
  );
});

metric(
  "a flex item takes its padding once, and its content's width",
  async () => {
    // Yoga holds an item's padding and adds it itself, so the measure answers
    // inside it; an item of `width: auto` is as wide as its content (CSS
    // Flexbox 9.2), not a share of the row
    const place = async (items: string, width = 700) => {
      const { node } = await render(
        '<style>body{margin:0;font:14px/20px sans-serif}.r{display:flex;' +
          'gap:12px}.r>div{padding:12px}</style>' +
          `<div class="r">${items}</div>`,
        width,
      );
      const el = view(node);
      const out = ['a', 'b'].map((id) => {
        const b = boxOf(el, id);
        return { x: b.x, width: b.width, height: b.height };
      });
      cleanup();
      return out;
    };
    const [a, b] = await place(
      '<div id="a">Install</div><div id="b">Run</div>',
    );
    assert.strictEqual(a.height, 44, '12 + 20 + 12, not the padding twice');
    assert.ok(a.width < 100, `as wide as its word and padding: ${a.width}`);
    assert.ok(
      Math.abs(b.x - (a.x + a.width + 12)) < 1e-6,
      'and the next after it',
    );
    // `flex: 1` shares the row, padding and all
    const [c, d] = await place(
      '<div id="a" style="flex:1">Install</div><div id="b" style="flex:1">Run</div>',
    );
    assert.deepStrictEqual([c.width, d.width, c.height], [344, 344, 44]);
    // a width of its own is its content box's, 100 + 24 + 4
    const [e] = await place(
      '<div id="a" style="width:100px;border:2px solid">W</div><div id="b"></div>',
    );
    assert.strictEqual(e.width, 128);
    // and a row inside a row is as wide as its items side by side
    const [f] = await place(
      '<div id="a" style="display:flex;gap:4px;padding:0"><span>One</span>' +
        '<span>Two</span></div><div id="b">x</div>',
    );
    const [one] = await place(
      '<div id="a" style="padding:0">One</div><div id="b"></div>',
    );
    assert.ok(f.width > one.width * 2, `${f.width} holds both words`);
    // and an auto margin takes the free space on its side
    const [, end] = await place(
      '<div id="a">A</div><div id="b" style="margin-left:auto">B</div>',
    );
    assert.ok(Math.abs(end.x + end.width - 700) < 1e-6, `${end.x + end.width}`);
  },
);

metric(
  'an absolute box in a flex box is where it would be as its one item',
  async () => {
    // CSS Flexbox 4.1: its static position is in the flex box's content box,
    // aligned by justify-content and align-self; it was at the box's corner.
    // And its containing block is its own: one in a flex box that is not
    // positioned was placed against the flex box
    const place = async (css: string, child = 'width:20px;height:10px') => {
      const { node } = await render(
        '<style>body{margin:0}</style>' +
          '<div style="position:relative;padding:7px">' +
          `<div style="display:flex;width:100px;height:60px;padding:5px;${css}">` +
          `<div id="a" style="position:absolute;${child}"></div></div></div>`,
      );
      const b = boxOf(view(node), 'a');
      cleanup();
      return [b.x, b.y];
    };
    assert.deepStrictEqual(
      await place('justify-content:center;align-items:flex-end'),
      [52, 62],
      'centred along the row, at the end across it',
    );
    assert.deepStrictEqual(
      await place(
        'flex-direction:column;justify-content:flex-end;align-items:center',
      ),
      [52, 62],
      'and the same down a column',
    );
    assert.deepStrictEqual(
      await place('flex-direction:row-reverse'),
      [92, 12],
      'a reversed row starts at its end',
    );
    assert.deepStrictEqual(
      await place('', 'top:0;left:0;width:20px;height:10px'),
      [0, 0],
      "its offsets are from its containing block's padding edge",
    );
  },
);

metric(
  "an intrinsic size is a flex item's width, stretched or not",
  async () => {
    const { node } = await render(
      '<style>body{margin:0}span{padding:0 4px}</style>' +
        '<div style="display:flex;flex-direction:column;width:300px">' +
        '<div id="badge" style="width:fit-content">New</div>' +
        '<div id="stretched">New</div></div>' +
        '<div style="display:flex;width:200px">' +
        '<div id="whole" style="min-width:max-content">stays whole here</div>' +
        '<div id="wraps">this one shrinks and wraps instead</div></div>' +
        '<div style="width:1000px"><div style="float:left" id="ref">' +
        'stays whole here</div></div>',
    );
    const el = view(node);
    const width = (id: string) => boxOf(el, id).width;
    assert.strictEqual(width('stretched'), 300);
    assert.ok(width('badge') < 100, `${width('badge')}: not stretched`);
    assert.strictEqual(
      width('whole'),
      width('ref'),
      'min-w-max keeps a row item from shrinking below its content',
    );
  },
);

test('a flex container lays its items out in its content box', async () => {
  // a border-box height holds the padding: `h-16 py-2 items-center` put
  // its items eight pixels low, centred in 64px from the top of 48
  const { node } = await render(
    '<style>body{margin:0} *{box-sizing:border-box}</style>' +
      '<div style="display:flex;align-items:center;height:64px;padding:8px 0">' +
      '<div id="a" style="height:20px;width:50px"></div></div>' +
      // and a column with a minimum height gives its flex-1 the rest
      '<div style="display:flex;flex-direction:column;min-height:300px">' +
      '<div style="height:30px"></div><div id="b" style="flex:1"></div>' +
      '<div id="c" style="height:30px"></div></div>' +
      // an aspect-ratio box centres in the height its ratio gives it
      '<div style="width:320px;aspect-ratio:16/9;display:flex;' +
      'align-items:center;justify-content:center">' +
      '<div id="d" style="width:40px;height:40px"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').y, 22);
  assert.strictEqual(boxOf(el, 'b').height, 240);
  assert.strictEqual(boxOf(el, 'c').y, 334);
  const d = boxOf(el, 'd');
  assert.deepStrictEqual([d.x, d.y - 364], [140, 70]);
});

test("a flex item's negative margin takes its container's end back in", async () => {
  // A flex box with no height is as tall as its items' margin boxes (CSS
  // Flexbox 9.4, 9.8). Codex hangs Wikipedia's search field a pixel over
  // its form's border with `margin: -1px`, and the form came out a pixel
  // taller than Chrome's: a rule under the field. The bottom of each item
  // was taken at its border box, which a negative margin ends inside of.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="a" style="display:flex;border:1px solid">' +
      '<div style="flex:1;margin:-1px;height:32px"></div></div>' +
      '<div id="b" style="display:flex">' +
      '<div style="flex:1;margin-bottom:-5px;height:32px"></div></div>' +
      '<div id="c" style="display:flex;flex-direction:column">' +
      '<div style="margin-bottom:-5px;height:32px"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 32, 'its border and the field');
  assert.strictEqual(boxOf(el, 'b').height, 27, 'across a row');
  assert.strictEqual(boxOf(el, 'c').height, 27, 'down a column');
});

test('a flex item is no smaller than its content, unless its minimum says', async () => {
  // `min-width: auto` in a row and `min-height: auto` in a column are the
  // least an item's content comes to (CSS Flexbox 4.5). Yoga has no such
  // minimum: it shrank a row's items under what they held, and a column's
  // first item under its content, which the next one was drawn over.
  const { node } = await render(
    '<style>body{margin:0} .i{display:inline-block;width:150px;' +
      'height:10px}</style>' +
      '<div style="display:flex;width:200px">' +
      '<div id="a" style="flex:1"><span class="i"></span></div>' +
      '<div id="b" style="flex:1"><span class="i"></span></div></div>' +
      // `min-w-0` lets it go, and so does a box that clips
      '<div style="display:flex;width:200px">' +
      '<div id="c" style="flex:1;min-width:0"><span class="i"></span></div>' +
      '<div id="d" style="flex:1;overflow:hidden"><span class="i"></span>' +
      '</div></div>' +
      '<div style="display:flex;flex-direction:column;height:30px">' +
      '<div id="e"><div style="height:60px"></div></div>' +
      '<div id="f" style="height:20px"></div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.deepStrictEqual(
    [box('a').width, box('b').width],
    [150, 150],
    'a row overflows before an item shrinks under its content',
  );
  assert.ok(box('c').width < 150, 'min-width: 0');
  assert.ok(box('d').width < 150, 'overflow: hidden');
  assert.strictEqual(box('e').height, 60, 'a column item');
  assert.strictEqual(box('f').y, box('e').y + 60, 'and the one after it');
});

test('a flex item with a width is held to the lesser of it and its content', async () => {
  // CSS Flexbox 4.5: its automatic minimum is the lesser of its specified
  // size suggestion and its content size suggestion. It was given none: a
  // `width: 250px; flex-basis: 0` sidebar beside `flex: 1 1 0` content was
  // no width at all, and drawn over the content (iana.org's root zone)
  const { node } = await render(
    '<style>body{margin:0} .i{display:inline-block;height:10px}</style>' +
      '<div style="display:flex;flex-direction:row-reverse;width:600px">' +
      '<main id="m" style="flex-grow:1;flex-basis:0"></main>' +
      '<nav id="n" style="flex-basis:0;width:250px">' +
      '<div style="width:230px;margin-right:20px;height:10px"></div></nav>' +
      '</div>' +
      // content wider than the width: the width
      '<div style="display:flex;width:100px"><div id="w" style="width:250px">' +
      '<span class="i" style="width:300px"></span></div></div>' +
      // content narrower than it: the content
      '<div style="display:flex;width:300px">' +
      '<div id="a" style="width:50%;flex-basis:0">' +
      '<span class="i" style="width:10px"></span></div>' +
      '<div id="b" style="width:50%;flex-basis:0">' +
      '<div style="width:200px;height:10px"></div></div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.deepStrictEqual(
    [box('n').x, box('n').width, box('m').x, box('m').width],
    [0, 250, 250, 350],
    'the sidebar is its width, the content the rest',
  );
  assert.strictEqual(box('w').width, 250, 'no wider than its width');
  assert.deepStrictEqual(
    [box('a').width, box('b').width],
    [10, 150],
    'no narrower than the lesser',
  );
});

metric(
  'a flex item is as tall as its content at the width its minimum gives it',
  async () => {
    // Yoga measures an item at no more than the room it offers it, and only
    // then holds it to its minimum: an answer is kept for the width Yoga
    // makes of it, so the item was that minimum wide and as tall as its
    // content wrapped at the room. `min-w-max` in a row of 50px was its
    // words' width with its words on one line, and the height of two
    const { node } = await render(
      '<style>body{margin:0} .r{display:flex;width:50px;line-height:20px}' +
        '.c{display:flex;flex-direction:column;width:50px;line-height:20px}' +
        '.w{width:max-content}</style>' +
        '<div class="w" id="w">Documentation pages</div>' +
        '<div class="r" id="ra"><div id="a" style="min-width:max-content">' +
        'Documentation pages</div></div>' +
        // with padding and a border, which Yoga holds and the measure does not
        '<div class="r"><div id="b" style="min-width:max-content;' +
        'padding:0 5px;border:2px solid">Documentation pages</div></div>' +
        // and across a column, stretched or not
        '<div class="c"><div id="c" style="min-width:max-content">' +
        'Documentation pages</div></div>' +
        '<div class="c" style="align-items:flex-start"><div id="d" ' +
        'style="min-width:max-content">Documentation pages</div></div>' +
        // and held to its content at its narrowest, in a row that wraps
        '<div style="width:min-content;line-height:20px" id="n">' +
        'Learn more Documentation</div>' +
        '<div class="r" style="flex-wrap:wrap"><div id="e">' +
        'Learn more Documentation</div></div>',
    );
    const el = view(node);
    const box = (id: string) => boxOf(el, id);
    const words = box('w').width;
    const near = (actual: number, expected: number, message: string) =>
      assert.ok(
        Math.abs(actual - expected) < 0.01,
        `${message}: ${actual}, not ${expected}`,
      );
    assert.ok(words > 50, 'the words are wider than the row');
    near(box('a').width, words, 'as wide as its words');
    assert.strictEqual(box('a').height, 20, 'and one line tall');
    assert.strictEqual(box('ra').height, 20, 'and so is its row');
    near(box('b').width, words + 14, 'its padding and border outside them');
    assert.strictEqual(box('b').height, 24, 'one line, and its border');
    for (const id of ['c', 'd']) {
      near(box(id).width, words, `a column item (${id}) is as wide`);
      assert.strictEqual(box(id).height, 20, `and one line tall (${id})`);
    }
    near(box('e').width, box('n').width, 'as wide as its longest word');
    assert.strictEqual(
      box('e').height,
      box('n').height,
      'and as many lines as that makes it',
    );
  },
);

metric(
  'a flex item that may not shrink is its content at its widest along a row, whatever the room',
  async () => {
    // An item's flex base size is its size with its content at its widest
    // (CSS Flexbox 9.2.3 E: `content`, which `auto` is, as `max-content`),
    // and one that may not shrink is that (9.7). It was measured at no more
    // than the room the row offered, which Yoga asks, and so was held to
    // its content at its narrowest instead: `shrink-0` beside `shrink-0`
    // in a row too narrow for them wrapped, where they overflow it
    const { node } = await render(
      '<style>body{margin:0} .r{display:flex;width:50px;line-height:20px}' +
        '.w{width:max-content}</style>' +
        '<div class="w" id="w1">Documentation pages</div>' +
        '<div class="w" id="w2">Pricing</div>' +
        '<div class="r"><div id="a" style="flex-shrink:0">Documentation ' +
        'pages</div><div id="b" style="flex-shrink:0">Pricing</div></div>' +
        '<div class="r"><div id="c" style="flex:none;padding:0 5px">' +
        'Documentation pages</div></div>' +
        // a flex box in one, sized by what it holds
        '<div class="r"><div id="d" style="flex:none"><div style="display:flex">' +
        '<div>Documentation pages</div></div></div></div>' +
        // wider than a minimum that is wider than the row
        '<div class="r" style="width:80px"><div id="e" ' +
        'style="flex-shrink:0;min-width:106.64px">' +
        '<div style="width:161px;height:10px"></div></div></div>' +
        // and one that may shrink is shrunk to the room, and no further than
        // its words at their narrowest
        '<div class="r"><div id="f">Documentation pages</div></div>' +
        // A flex box's own content at its narrowest is its items' at
        // theirs, whatever they may shrink by, as Chrome has it: this is
        // 30 + 20 + 10 wide, and the item in it 60, running out of it
        '<div id="g" style="display:flex;width:min-content;column-gap:20px">' +
        '<div id="h" style="flex:0 0 auto">' +
        '<div style="float:left;width:30px;height:10px"></div>' +
        '<div style="float:left;width:30px;height:10px"></div></div>' +
        '<div style="width:10px"></div></div>',
    );
    const el = view(node);
    const box = (id: string) => boxOf(el, id);
    const near = (actual: number, expected: number, message: string) =>
      assert.ok(
        Math.abs(actual - expected) < 0.01,
        `${message}: ${actual}, not ${expected}`,
      );
    const words = box('w1').width;
    near(box('a').width, words, 'as wide as its words');
    assert.strictEqual(box('a').height, 20, 'on one line');
    near(box('b').x, box('a').x + words, 'the next beside it');
    near(box('b').width, box('w2').width, 'as wide as its word');
    near(box('c').width, words + 10, 'with its padding outside them');
    assert.strictEqual(box('c').height, 20, 'on one line');
    near(box('d').width, words, 'a flex box in one');
    assert.strictEqual(box('d').height, 20, 'on one line');
    assert.strictEqual(box('e').width, 161, 'as wide as what it holds');
    assert.ok(
      box('f').width < words && box('f').height === 40,
      'one that may shrink wraps',
    );
    assert.deepStrictEqual(
      [box('g').width, box('h').width],
      [60, 60],
      'a flex box at its narrowest, and an item that may not shrink in it',
    );
  },
);

metric(
  'flex items that may shrink give up room in proportion to their content at its widest',
  async () => {
    // A line too narrow for its items takes the room it lacks from each in
    // proportion to its flex shrink factor times its flex base size (CSS
    // Flexbox 9.7, step 4c), and an item's base size is its content at its
    // widest, whatever the room (9.2.3 E). Yoga asks for it as at most the
    // row's width, and an item that may shrink was fitted to that: one
    // wider than the row was weighed as no wider, and gave up too little
    // beside a narrower one. Eight floats of 50 beside two in a row of 300
    // were 225 and 75, where Chrome has 240 and 60
    const floats = (n: number) => '<div class="f"></div>'.repeat(n);
    const long = 'Documentation pages and more words here to wrap them';
    const { node } = await render(
      '<style>body{margin:0} .r{display:flex;width:300px;line-height:20px}' +
        '.f{float:left;width:50px;height:10px}' +
        '.w{width:max-content} .n{width:min-content}</style>' +
        `<div class="r"><div id="a">${floats(8)}</div>` +
        `<div id="b">${floats(2)}</div></div>` +
        // with a shrink factor of its own
        `<div class="r"><div id="c" style="flex-shrink:2">${floats(8)}</div>` +
        `<div id="d">${floats(2)}</div></div>` +
        // words, which wrap at the width that leaves them
        `<div class="w" id="w1">${long}</div>` +
        '<div class="w" id="w2">Pricing plans</div>' +
        '<div class="n" id="n2">Pricing plans</div>' +
        `<div class="r"><div id="e">${long}</div>` +
        '<div id="f">Pricing plans</div></div>' +
        // and the narrower held at its longest word, which the rest of the
        // line then comes out of
        `<div class="r" style="width:200px"><div id="g">${long}</div>` +
        '<div id="h">Pricing plans</div></div>' +
        // A flex box's content at its narrowest is still its items' at
        // theirs, 50 and 50, and each of them is that in it
        '<div id="i" style="display:flex;width:min-content">' +
        `<div id="j">${floats(8)}</div><div id="k">${floats(2)}</div></div>`,
    );
    const el = view(node);
    const box = (id: string) => boxOf(el, id);
    const near = (actual: number, expected: number, message: string) =>
      assert.ok(
        Math.abs(actual - expected) < 0.01,
        `${message}: ${actual}, not ${expected}`,
      );
    near(box('a').width, 240, 'the wider gives up four fifths');
    near(box('b').width, 60, 'and the narrower one fifth');
    near(box('b').x, box('a').x + 240, 'beside it');
    // 200 short, weighed 2 × 400 to 1 × 100
    near(box('c').width, 400 - (200 * 800) / 900, 'by twice its base');
    near(box('d').width, 100 - (200 * 100) / 900, 'and the other once');
    // as Chrome has the paragraph and the two words, 245 and 55 in Arial
    const long1 = box('w1').width;
    const short = box('w2').width;
    assert.ok(long1 > 300, `the words are wider than the row: ${long1}`);
    const lacks = long1 + short - 300;
    near(box('e').width, long1 - (lacks * long1) / (long1 + short), 'words');
    near(box('f').width, short - (lacks * short) / (long1 + short), 'two');
    assert.strictEqual(box('f').height, 40, 'which wrap');
    // in 200, the two words' share would leave them narrower than
    // "Pricing", so they are held there, and the paragraph has the rest
    const word = box('n2').width;
    assert.ok(
      short - ((long1 + short - 200) * short) / (long1 + short) < word,
      'their share is narrower than their longest word',
    );
    near(box('h').width, word, 'held at their longest word');
    near(box('g').width, 200 - word, 'and the paragraph the rest');
    assert.deepStrictEqual(
      [box('i').width, box('j').width, box('k').width],
      [100, 50, 50],
      'a flex box at its narrowest, and its items in it',
    );
  },
);

test("a flex item's percentages are of the flex box's width, not of its own", async () => {
  // CSS 2.1 8.3, 8.4 and 10.4: a percentage in a margin, a padding or a
  // width limit is of the containing block's width, and a flex item's
  // containing block is its flex box's content box (CSS Flexbox 4). The
  // flex layout resolved them so; the item was then laid out with its own
  // width standing for its containing block's, and resolved them again.
  // Infima's columns are `flex: 1 0 50%; max-width: 50%`: each was given
  // half its row and drawn in a quarter of it.
  const { node } = await render(
    '<style>body{margin:0} *{box-sizing:border-box}' +
      '.row{display:flex;flex-wrap:wrap;width:600px}' +
      '.col{flex:1 0 50%;max-width:50%;width:100%;padding:0 16px}</style>' +
      '<div class="row"><div class="col" id="a"><div id="a1"></div></div>' +
      '<div class="col" id="b"><div id="b1"></div></div></div>' +
      // a padding, as wide as a tenth of the row
      '<div style="display:flex;width:600px">' +
      '<div id="c" style="flex:1;padding:0 10%"><div id="c1"></div></div>' +
      '<div style="flex:1"></div></div>' +
      // down a column, and a limit on a content box
      '<div style="display:flex;flex-direction:column;width:600px">' +
      '<div id="d" style="max-width:50%;padding-left:10%">' +
      '<div id="d1"></div></div>' +
      '<div id="e" style="box-sizing:content-box;width:80%;max-width:50%;' +
      'padding:0 5%"><div id="e1"></div></div></div>',
    700,
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  const across = (id: string) => [box(id).x, box(id).width];
  assert.deepStrictEqual(across('a'), [0, 300], 'half the row');
  assert.deepStrictEqual(across('a1'), [16, 268], 'and what is in it');
  assert.deepStrictEqual(across('b'), [300, 300], 'the other half');
  assert.deepStrictEqual(across('b1'), [316, 268]);
  assert.deepStrictEqual(across('c'), [0, 360], 'its share and its padding');
  assert.deepStrictEqual(across('c1'), [60, 240], 'a tenth of the row in');
  assert.deepStrictEqual(across('d'), [0, 300], 'half the column');
  assert.deepStrictEqual(across('d1'), [60, 240]);
  assert.deepStrictEqual(across('e'), [0, 360], 'half, and its padding');
  assert.deepStrictEqual(across('e1'), [30, 300]);
});

test('a flex item its content holds is frozen at that size, and the rest share what is left', async () => {
  // CSS Flexbox 9.7, step 4: an item its minimum stops is frozen at it, and
  // the line's free space is shared out again among the others. Handed the
  // minimum as a `min-width`, Yoga made it the item's base size: where
  // every item of a line was held it divided what the line was short of by
  // the rounding of their shrink factors' sum less each of them, and two
  // items of these widths in a row too narrow for them were billions of
  // pixels wide — nextjs.org's search button, in the font the page loads,
  // which put the rest of its header's row under its words
  const { node } = await render(
    '<style>body{margin:0} .b{height:10px}</style>' +
      '<div style="display:flex;width:50px">' +
      '<div id="a"><div class="b" style="width:110.992px"></div></div>' +
      '<div id="b"><div class="b" style="width:62.705625px"></div></div>' +
      '</div>' +
      // down a column, of a height of its own and of one it may not pass
      '<div style="display:flex;flex-direction:column;height:20px">' +
      '<div id="c"><div style="height:110.992px"></div></div>' +
      '<div id="d"><div style="height:62.705625px"></div></div></div>' +
      '<div style="height:160px"></div>' +
      '<div style="display:flex;flex-direction:column;max-height:20px">' +
      '<div id="e"><div style="height:110.992px"></div></div>' +
      '<div id="f"><div style="height:62.705625px"></div></div></div>' +
      '<div style="height:160px"></div>' +
      // and where the line has room to share out, the item held takes none
      // of it on top of its minimum: it was 233 wide, and the others 33
      '<div style="display:flex;width:300px">' +
      '<div id="g" style="flex:1"><div class="b" style="width:200px"></div>' +
      '</div><div id="h" style="flex:1"></div>' +
      '<div id="i" style="flex:1"></div></div>' +
      '<div style="display:flex;flex-direction:column;height:300px">' +
      '<div id="j" style="flex:1"><div style="height:220px"></div></div>' +
      '<div id="k" style="flex:1"></div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  const near = (actual: number, expected: number, message: string) =>
    assert.ok(
      Math.abs(actual - expected) < 0.01,
      `${message}: ${actual}, not ${expected}`,
    );
  near(box('a').width, 110.992, 'a row item, as wide as what it holds');
  near(box('b').width, 62.705625, 'and the one after it');
  near(box('b').x, 110.992, 'which starts where it ends');
  for (const [first, second] of [
    ['c', 'd'],
    ['e', 'f'],
  ]) {
    near(box(first).height, 110.992, 'a column item, as tall');
    near(box(second).height, 62.705625, 'and the one after it');
    near(box(second).y, box(first).y + 110.992, 'which starts where it ends');
  }
  assert.deepStrictEqual(
    [box('g').width, box('h').width, box('i').width],
    [200, 50, 50],
    'a row with room: the held item its minimum, the others the rest',
  );
  assert.deepStrictEqual(
    [box('j').height, box('k').height],
    [220, 80],
    'and a column',
  );
});

test('a flex line every item of which its own minimum stops is laid out at those minimums', async () => {
  // CSS Flexbox 9.7: a line short of room with every item at its minimum
  // leaves each of them at that. Yoga takes each item a minimum stops out
  // of the sum of the scaled shrink factors and divides what the line is
  // still short of by what is left: `(a + b) - a - b` in float32s, which
  // is 0 for some sizes and a rounding for others. A positive one made
  // every item of the line billions of pixels wide — 3599091712 and
  // 2033329408 for these two. An automatic minimum is held by freezing the
  // item (the test above); a minimum of the item's own is Yoga's to hold
  // it to, and so are an item's padding and its borders
  const A = 110.992;
  const B = 62.705625;
  const row = (a: string, b: string, before = '') =>
    `<div style="display:flex;width:50px">${before}` +
    `<div ${a}></div><div ${b}></div></div>`;
  const column = (box: string, a: string, b: string) =>
    `<div style="display:flex;flex-direction:column;${box}">` +
    `<div ${a}></div><div ${b}></div></div><div style="height:200px"></div>`;
  const { node } = await render(
    '<style>body{margin:0} .i{height:6px}</style>' +
      row(
        `id="a1" class="i" style="width:${A}px;min-width:${A}px"`,
        `id="b1" class="i" style="width:${B}px;min-width:${B}px"`,
      ) +
      row(
        `id="a2" class="i" style="flex-basis:${A}px;min-width:${A}px"`,
        `id="b2" class="i" style="flex-basis:${B}px;min-width:${B}px"`,
      ) +
      // a minimum under the item's size, a percentage of the row's width
      row(
        `id="a3" class="i" style="width:150.5px;min-width:${A * 2}%"`,
        `id="b3" class="i" style="width:99.9px;min-width:${B * 2}%"`,
      ) +
      // its content's width, asked for by keyword
      '<div style="display:flex;width:50px">' +
      '<div id="a4" style="min-width:max-content">' +
      `<div class="i" style="width:${A}px"></div></div>` +
      '<div id="b4" style="min-width:max-content">' +
      `<div class="i" style="width:${B}px"></div></div></div>` +
      // no minimum but its padding, which no item is narrower than
      row(
        `id="a5" class="i" style="padding:0 ${A / 2}px"`,
        `id="b5" class="i" style="padding:0 ${B / 2}px"`,
      ) +
      // and none at all, beside an item that is wider than the row alone
      row(
        `id="a6" class="i" style="width:${A}px;min-width:0"`,
        `id="b6" class="i" style="width:${B}px;min-width:0"`,
        '<div id="n6" class="i" style="flex:none;width:80px"></div>',
      ) +
      // down a column, of a height of its own and of one it may not pass
      column(
        'height:50px',
        `id="c1" style="height:${A}px;min-height:${A}px"`,
        `id="d1" style="height:${B}px;min-height:${B}px"`,
      ) +
      column(
        'max-height:50px',
        `id="c2" style="flex-basis:${A}px;min-height:${A}px"`,
        `id="d2" style="flex-basis:${B}px;min-height:${B}px"`,
      ) +
      // lines that are not short of room at their minimums are shared out
      // as they were: one with room for them, and one with room to grow
      '<div style="display:flex;width:150px">' +
      '<div id="e1" class="i" style="width:100.5px;min-width:60.1px"></div>' +
      '<div id="e2" class="i" style="width:100.5px;min-width:0"></div></div>' +
      '<div style="display:flex;width:300px">' +
      `<div id="g1" class="i" style="flex:1 1 ${A}px;min-width:${A}px">` +
      `</div><div id="g2" class="i" style="flex:1 1 ${B}px;min-width:${B}px">` +
      '</div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  const near = (actual: number, expected: number, message: string) =>
    assert.ok(
      Math.abs(actual - expected) < 0.01,
      `${message}: ${actual}, not ${expected}`,
    );
  for (const [n, what] of [
    [1, 'a width'],
    [2, 'a flex-basis'],
    [3, 'a percentage under its width'],
    [4, 'max-content'],
    [5, 'padding'],
  ] as const) {
    near(box(`a${n}`).width, A, `a row item held by ${what}`);
    near(box(`b${n}`).width, B, `and the one after it, by ${what}`);
    near(box(`b${n}`).x, A, `which starts where it ends, by ${what}`);
  }
  assert.deepStrictEqual(
    [box('n6').width, box('a6').width, box('b6').width, box('b6').x],
    [80, 0, 0, 80],
    'items that may be nothing wide are, beside one wider than the row',
  );
  for (const n of [1, 2]) {
    near(box(`c${n}`).height, A, 'a column item, as tall as its minimum');
    near(box(`d${n}`).height, B, 'and the one after it');
    near(box(`d${n}`).y, box(`c${n}`).y + A, 'which starts where it ends');
  }
  near(box('e1').width, 75, 'a line with room for its minimums is shared out');
  near(box('e2').width, 75, 'to each item by its size');
  const spare = (300 - A - B) / 2;
  near(box('g1').width, A + spare, 'and one with room to grow in is');
  near(box('g2').width, B + spare, 'grown into');
});

test('a flex line every item of which its own maximum stops is laid out at those maximums', async () => {
  // CSS Flexbox 9.7: a line with room left over with every item that may
  // grow at its maximum leaves each of them at that. Yoga takes each item
  // a maximum stops out of the sum of the grow factors and divides the
  // room still left by what is left: `(a + b + c) - a - b - c` in
  // float32s, which is 0 for some factors and a rounding either side of
  // it for others. A negative one made every item of the line as small as
  // it goes — nothing wide, for these three, and nothing tall down a
  // column. Whole numbers of factors add up exactly
  const [A, B, C] = [3.361, 2.417, 1.988];
  const item = (id: string, grow: number, style = 'max-width:10px') =>
    `<div id="${id}" class="i" style="flex-grow:${grow};${style}"></div>`;
  const row = (width: number, ...items: string[]) =>
    `<div style="display:flex;width:${width}px">${items.join('')}</div>`;
  const column = (box: string, n: number) =>
    `<div style="display:flex;flex-direction:column;${box}">` +
    item(`c${n}a`, A, 'max-height:10px') +
    item(`c${n}b`, B, 'max-height:10px') +
    item(`c${n}c`, C, 'max-height:10px') +
    '</div>';
  const { node } = await render(
    '<style>body{margin:0} .i{height:6px} [style*=column] .i{height:auto}' +
      '</style>' +
      row(100, item('a1', A), item('b1', B), item('c1', C)) +
      // down a column, of a height of its own and of a least one
      column('height:100px', 1) +
      column('min-height:100px', 2) +
      // and a line of a box that wraps, between two with no room left
      '<div style="display:flex;flex-wrap:wrap;width:100px">' +
      '<div id="w0" class="i" style="flex:none;width:100px"></div>' +
      item('a3', A, 'max-width:10px;flex-basis:1px') +
      item('b3', B, 'max-width:10px;flex-basis:1px') +
      item('c3', C, 'max-width:10px;flex-basis:1px') +
      '<div id="w4" class="i" style="flex:none;width:98px"></div></div>' +
      // lines that are not stopped at their maximums are shared out as
      // they were: one with no room for them, one with an item that has
      // none, and one of whole numbers of factors
      row(25, item('a5', A, 'max-width:20px'), item('b5', B), item('c5', C)) +
      row(100, item('a6', A), item('b6', B), item('c6', C, '')) +
      row(100, item('a7', 3), item('b7', 2.5), item('c7', 2)),
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  const near = (actual: number, expected: number, message: string) =>
    assert.ok(
      Math.abs(actual - expected) < 0.01,
      `${message}: ${actual}, not ${expected}`,
    );
  for (const n of [1, 3, 7]) {
    near(box(`a${n}`).width, 10, `a row item at its maximum, line ${n}`);
    near(box(`b${n}`).width, 10, `and the one after it, line ${n}`);
    near(box(`c${n}`).width, 10, `and the last, line ${n}`);
    near(box(`c${n}`).x, 20, `which starts where they end, line ${n}`);
  }
  for (const n of [1, 2]) {
    near(box(`c${n}a`).height, 10, 'a column item, as tall as its maximum');
    near(box(`c${n}b`).height, 10, 'and the one after it');
    near(box(`c${n}c`).y, box(`c${n}a`).y + 20, 'and the last, after them');
  }
  const lines = ['w0', 'a3', 'w4'].map((id) => box(id).y);
  assert.deepStrictEqual(
    [box('b3').y, box('c3').y, lines[1] - lines[0], lines[2] - lines[1]],
    [lines[1], lines[1], 6, 6],
    'the wrapped line keeps its items, and the lines around it theirs',
  );
  const factors = A + B + C;
  near(box('a5').width, (25 * A) / factors, 'a line with no room for them');
  near(box('b5').width, (25 * B) / factors, 'all is shared out by their');
  near(box('c5').width, (25 * C) / factors, 'factors');
  near(box('c6').width, 80, 'and one with an item of no maximum grows it');
});

test('a flex line is shared out as CSS Flexbox 9.7 has it where Yoga comes out elsewhere', async () => {
  // Yoga 3.2.1 shares a line out in two passes where 9.7 goes round until
  // no item's limit stops it. Its first divides by the sum of the flex
  // factors as it takes stopped items out of it, and takes their sizes off
  // what the line is short of only after (react/yoga#2006); it weighs an
  // item by its size within its limits; it shares out the whole of what a
  // line is short of whatever the factors come to; and it starts the one
  // item that may grow and shrink from nothing. Each line here is laid
  // out as Chrome lays it out
  const row = (box: string, ...items: string[]) =>
    `<div style="display:flex;${box}">` +
    items.map((s) => `<div ${s}></div>`).join('') +
    '</div>';
  const column = (box: string, ...items: string[]) =>
    `<div style="display:flex;flex-direction:column;width:30px;${box}">` +
    items.map((s) => `<div ${s}></div>`).join('') +
    '</div><div style="height:200px"></div>';
  const content = (width: number) =>
    `><div style="width:${width}px;height:6px"></div`;
  const { node } = await render(
    '<style>body{margin:0} .r>div>div{height:6px} .c>div>div{width:6px}</style>' +
      '<div class="r">' +
      // each item after the first one a minimum stops was shrunk too far,
      // and stopped too, and with all of them stopped the line was left as
      // wide as it started: 100, 100 and 100
      row(
        'width:150px',
        'id="a1" style="width:100px;min-width:95px"',
        'id="a2" style="width:100px;min-width:45px"',
        'id="a3" style="width:100px;min-width:0"',
      ) +
      // shrunk from 200, each, to its minimum: Yoga shrank them from their
      // maximums, weighed by 200, to 76.67 and 43.31
      row(
        'width:50px',
        'id="b1" style="width:200px;max-width:110.992px;min-width:40.1px"',
        'id="b2" style="width:200px;max-width:62.705625px;min-width:30.3px"',
      ) +
      // grown from 0, each, to a half: Yoga grew the first from its
      // minimum, to 400 and 200
      row(
        'width:600px',
        'id="c1" style="flex:1;min-width:200px"',
        'id="c2" style="flex:1"',
      ) +
      row(
        'width:300px',
        'id="d1" style="flex:1 1 0;min-width:120px"',
        'id="d2" style="flex:1 1 0;min-width:130px"',
        'id="d3" style="flex:1 1 0"',
      ) +
      // a shrink factor of a half shares out half of what the line is
      // short of, and a grow factor of 0.085 that much of its room: Yoga
      // shared out all of the one, and grew the other from nothing
      row('width:100px', 'id="e1" style="width:200px;flex-shrink:0.5"') +
      row(
        'width:364px',
        `id="f1" style="flex-basis:248px;flex-grow:0.085;margin-right:15px"${content(29)}`,
      ) +
      row(
        'width:400px',
        'id="g1" style="flex:0.3 1 0;max-width:50px"',
        'id="g2" style="flex:0.3 1 0"',
      ) +
      // its content's width is its flex base size, more than its maximum,
      // and it shrinks from that
      row(
        'width:200px',
        `id="h1" style="max-width:150px;min-width:0"${content(300)}`,
        'id="h2" style="width:150px"',
      ) +
      // as wide as the row, and each item short of its limits: and still
      // not what 9.7 makes of it
      row(
        'width:145px',
        `id="i1" style="width:22px;flex-grow:1.811;flex-shrink:0"${content(145.765)}`,
        'id="i2" style="width:222px;min-width:0;flex-shrink:3.259"',
        `id="i3" style="min-width:0;flex-grow:3.236"${content(214)}`,
      ) +
      // a flex base size as small as the item's padding, as near as Yoga's
      // float32s come to it, is not under it
      row(
        'width:48px',
        `id="j1" style="min-width:13px;max-width:51px;flex-shrink:0.238;padding:0 9px 0 0.698px;margin-right:6.471px"${content(192.371)}`,
        `id="j2" style="width:63.276%;padding:0 26.991px 0 24px;border-left:6px solid;box-sizing:border-box"${content(20)}`,
      ) +
      '</div><div class="c">' +
      // and down a column
      column(
        'height:150px',
        'id="k1" style="height:100px;min-height:95px"',
        'id="k2" style="height:100px;min-height:45px"',
        'id="k3" style="height:100px;min-height:0"',
      ) +
      column(
        'max-height:50px',
        'id="l1" style="height:51.605px;min-height:46.602px"',
        'id="l2" style="height:111.78px;min-height:12.148px;flex-shrink:0.5;flex-grow:1"',
      ) +
      '</div>',
    700,
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  const near = (id: string, expected: number, message: string) => {
    const b = box(id);
    // `k` and `l` are down a column
    const actual = /^[kl]/.test(id) ? b.height : b.width;
    assert.ok(
      Math.abs(actual - expected) < 0.01,
      `${message} (#${id}): ${actual}, not ${expected}`,
    );
  };
  near('a1', 95, 'stopped by its minimum');
  near('a2', 45, 'and the next, by its own');
  near('a3', 10, 'and the last has what is left');
  near('b1', 40.1, 'shrunk from a flex base size over its maximum');
  near('b2', 30.3, 'and the other');
  near('c1', 300, 'grown from 0, past its minimum');
  near('c2', 300, 'beside one grown as far');
  near('d1', 120, 'a third of the row is under its minimum');
  near('d2', 130, 'and so is the next');
  near('d3', 50, 'and the last has what is left');
  near('e1', 150, 'shrunk by half of what the row is short of');
  near('f1', 256.585, 'grown by 0.085 of the room left');
  near('g1', 50, 'grown to its maximum');
  near('g2', 120, 'and 0.3 of what was free');
  near('h1', 133.333, 'shrunk from its content, past its maximum');
  near('h2', 66.667, 'beside one that shrinks by a third as much');
  near('i1', 22, 'an item that does not shrink');
  near('i2', 0, 'one shrunk to nothing');
  near('i3', 123, 'and one with the rest');
  near('j1', 22.698, 'at its minimum');
  near('j2', 56.991, 'beside one as wide as its padding');
  near('k1', 95, 'down a column, stopped by its minimum');
  near('k2', 45, 'and the next, by its own');
  near('k3', 10, 'and the last has what is left');
  near('l1', 46.602, 'at its minimum, in a column with a maximum');
  near('l2', 55.088, 'and one shrunk by half of what is left');
});

test("a flex line short of room shrinks each item by its content box's share of it, and not its padding's", async () => {
  // CSS Flexbox 9.7, step 4c: an item's share of what its line is short of
  // is its flex shrink factor times its inner flex base size, its content
  // box's. Yoga 3.2.1 weighs it by the border box's, so a padded item gave
  // up more than its share — on a line with no limits anywhere, which is
  // the one Yoga is otherwise trusted with. Each line here is Chrome's
  const line = (box: string, ...items: string[]) =>
    `<div style="display:flex;${box}">` +
    items.map((s) => `<div ${s}></div>`).join('') +
    '</div>';
  const { node } = await render(
    '<style>body{margin:0} .r>div>div{height:6px} .c>div>div{width:6px}</style>' +
      '<div class="r">' +
      // a hundred each of content, shrunk by fifty each: Yoga took sixty
      // from the first for its padding, and forty from the other
      line(
        'width:150px',
        'id="a1" style="width:100px;padding-left:50px"',
        'id="a2" style="width:100px"',
      ) +
      // fifty of content beside a hundred, short of seventy: a third of it
      // and two thirds, where Yoga weighed 100 against 120
      line(
        'width:150px',
        'id="b1" style="width:100px;padding-left:50px;box-sizing:border-box"',
        'id="b2" style="width:100px;padding-left:20px"',
      ) +
      // by the shrink factor times the content, the factors not the same
      line(
        'width:250px',
        'id="c1" style="width:100px;padding:0 30px;flex-shrink:2"',
        'id="c2" style="width:100px;border-left:10px solid"',
        'id="c3" style="width:40px;flex-shrink:0"',
      ) +
      '</div><div class="c">' +
      // and down a column of a height
      line(
        'flex-direction:column;width:30px;height:150px',
        'id="d1" style="height:100px;padding-top:50px"',
        'id="d2" style="height:100px"',
      ) +
      '</div>',
    700,
  );
  const el = view(node);
  const near = (id: string, expected: number, message: string) => {
    const b = boxOf(el, id);
    const actual = id.startsWith('d') ? b.height : b.width;
    assert.ok(
      Math.abs(actual - expected) < 0.01,
      `${message} (#${id}): ${actual}, not ${expected}`,
    );
  };
  near('a1', 100, 'its padding and fifty of content');
  near('a2', 50, 'beside one shrunk by as much');
  near('b1', 76.667, 'shrunk by a third of seventy');
  near('b2', 73.333, 'and the other by two thirds');
  near('c1', 120, 'shrunk by twice its content against the other');
  near('c2', 90, 'shrunk by its content alone');
  near('c3', 40, 'beside one that does not shrink');
  near('d1', 100, 'down a column, its padding and fifty of content');
  near('d2', 50, 'beside one shrunk by as much');
});

test("a flex item's limits and flex basis are the ones its style says", async () => {
  // what reaches the line is what CSS says each of these is, where Yoga was
  // told otherwise
  const column = (box: string, ...items: string[]) =>
    `<div style="display:flex;flex-direction:column;width:30px;${box}">` +
    items.map((s) => `<div ${s}></div>`).join('') +
    '</div><div style="height:250px"></div>';
  const { node } = await render(
    '<style>body{margin:0} .c>div>div{width:6px}</style><div class="c">' +
      // a minimum more than a maximum is the minimum (CSS 2.1 10.7): Yoga
      // held the item at its maximum
      column(
        'height:100px',
        'id="a1" style="min-height:12px;max-height:5px"',
        'id="a2" style="height:20px"',
      ) +
      // a percentage of a column's definite height, which was not one
      column(
        'height:200px',
        'id="b1" style="flex-basis:90px;min-height:75%;flex-shrink:2"',
        'id="b2" style="height:100px"',
      ) +
      // a percentage flex basis of a column of no definite height is
      // `content`, whatever height the item has (CSS Flexbox 7.2.3, 9.2.3):
      // Yoga took 81% of the column's maximum
      column(
        'max-height:54px',
        'id="c1" style="height:198px;flex-basis:81%;flex-shrink:0;padding-top:29px;box-sizing:border-box"',
      ) +
      '</div>' +
      // and a percentage of a row's width is a content box's, which the
      // item's padding goes on top of
      '<div style="display:flex;width:300px">' +
      '<div id="d1" style="height:6px;flex:0 0 50%;padding-left:20px"></div>' +
      '<div id="d2" style="height:6px;flex:1"></div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.deepStrictEqual(
    [box('a1').height, box('a2').height],
    [12, 20],
    'a minimum over a maximum',
  );
  assert.deepStrictEqual(
    [box('b1').height, box('b2').height],
    [150, 50],
    'a percentage minimum of a definite height',
  );
  assert.strictEqual(box('c1').height, 29, 'its content, and its padding');
  assert.deepStrictEqual(
    [box('d1').width, box('d2').width],
    [170, 130],
    'half the row and its padding',
  );
});

test('a flex box measured for its min-content width counts each item at its own', async () => {
  // A box's min-content width is measured by laying it out in no room, and
  // what a flex item gives it there is its min-content width (CSS Flexbox
  // 9.9.1), not a share of a line: an item that does not shrink, its flex
  // base size its content's widest, two floats side by side, made this box
  // 90 wide where Chrome has 60 — the floats one above the other, the gap
  // and the 10 beside them
  const { node } = await render(
    '<style>body{margin:0} .f{float:left;width:30px;height:10px}</style>' +
      '<div id="g" style="display:flex;width:min-content;column-gap:20px">' +
      '<div id="h" style="flex:0 0 auto"><div class="f"></div>' +
      '<div class="f"></div></div><div style="width:10px"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'g').width, 60, 'its min-content width');
  assert.strictEqual(boxOf(el, 'h').width, 60, 'and the item its widest in it');
});

test('a flex box that wraps is as narrow as its widest item at its min-content width', async () => {
  // A row that may wrap may put each item on a line of its own, so its
  // min-content width is the largest of its items' min-content
  // contributions, and not their sum, which is a row that does not wrap's
  // (CSS Flexbox 9.9.1). Summed, a `width: min-content` box around three
  // 30px items was 90 wide with them side by side, where Chrome has 30,
  // one under another; its max-content width is still their sum
  const { node } = await render(
    '<style>body{margin:0} .i{width:30px;height:6px}' +
      '.w{display:flex;flex-wrap:wrap}</style>' +
      '<div id="a" style="width:min-content"><div class="w">' +
      '<div id="a1" class="i"></div><div id="a2" class="i"></div>' +
      '<div class="i"></div></div></div>' +
      // the gaps between items on a line are none, and the widest decides
      '<div id="b" style="width:min-content"><div class="w" ' +
      'style="column-gap:20px"><div class="i"></div><div class="i"></div>' +
      '<div class="i" style="width:40px"></div></div></div>' +
      // `wrap-reverse` wraps too
      '<div id="c" style="width:min-content"><div class="w" ' +
      'style="flex-wrap:wrap-reverse"><div class="i"></div>' +
      '<div class="i"></div><div class="i"></div></div></div>' +
      // a least width of its own holds two items to a line
      '<div id="d" style="width:min-content"><div class="w" ' +
      'style="min-width:70px"><div class="i"></div><div class="i"></div>' +
      '<div class="i"></div></div></div>' +
      // an item's `min-width: min-content` around one, in a row too narrow
      // for it: its padding and the widest item
      '<div style="display:flex;width:40px"><div id="e" ' +
      'style="min-width:min-content;padding-left:22px"><div class="w">' +
      '<div class="i"></div><div class="i"></div><div class="i"></div>' +
      '</div></div></div>' +
      // as an item of a row that does not wrap, which sums it with the rest
      '<div id="f" style="width:min-content"><div style="display:flex">' +
      '<div class="w"><div class="i"></div><div class="i"></div>' +
      '<div class="i"></div></div><div class="i"></div></div></div>' +
      // and a row that does not wrap sums its items and its gaps
      '<div id="g" style="width:min-content"><div style="display:flex;' +
      'column-gap:20px"><div class="i"></div><div class="i"></div>' +
      '<div class="i"></div></div></div>' +
      // at its widest, side by side, and within a greatest width there
      '<div id="h" style="width:max-content"><div class="w" ' +
      'style="column-gap:20px"><div class="i"></div><div class="i"></div>' +
      '<div class="i"></div></div></div>' +
      '<div id="k" style="width:max-content"><div class="w" ' +
      'style="max-width:70px"><div class="i"></div><div class="i"></div>' +
      '<div class="i"></div></div></div>',
  );
  const el = view(node);
  const size = (id: string): [number, number] => {
    const box = boxOf(el, id);
    return [box.width, box.height];
  };
  assert.deepStrictEqual(size('a'), [30, 18], 'one item to a line');
  const [a1, a2] = [boxOf(el, 'a1'), boxOf(el, 'a2')];
  assert.deepStrictEqual(
    [a2.x - a1.x, a2.y - a1.y],
    [0, 6],
    'the next under the first',
  );
  assert.deepStrictEqual(size('b'), [40, 18], 'the widest, and no gap');
  assert.deepStrictEqual(size('c'), [30, 18], 'wrap-reverse');
  assert.deepStrictEqual(size('d'), [70, 12], 'its least width');
  assert.deepStrictEqual(size('e'), [52, 18], 'an item held to it');
  assert.deepStrictEqual(size('f'), [60, 18], 'beside an item');
  assert.deepStrictEqual(size('g'), [130, 6], 'a row that does not wrap');
  assert.deepStrictEqual(size('h'), [130, 6], 'its max-content width');
  assert.deepStrictEqual(size('k'), [70, 12], 'within its greatest width');
});

test("a flex box is no narrower than its items' widths make it", async () => {
  // What an item with a width of its own gives the size of its flex box is
  // that width (CSS Flexbox 9.9.3), and a percentage `max-width` on a box
  // takes nothing from what it gives the size of what holds it: it is a
  // percentage of the size being worked out, and none to that (CSS Sizing
  // 3, 5.2.1). Measured as the items were laid out in no width at all —
  // shrunk by the row, cut to 100% of nothing — a row of buttons with
  // widths came to less than its buttons, and the item beside it that
  // takes the rest pushed them out of their box: nextjs.org's header,
  // whose Deploy button is `width: 98px; max-width: 100%`
  const { node } = await render(
    '<style>body{margin:0} .row{display:flex;width:300px}' +
      '.rest{width:100%} .b{height:10px}</style>' +
      '<div class="row"><div class="rest"></div>' +
      '<div id="a" style="display:flex">' +
      '<div id="b" class="b" style="width:98px;max-width:100%"></div>' +
      '<div id="c" class="b" style="width:40px"></div></div></div>' +
      // a block in an item, as a flex item in one
      '<div class="row"><div class="rest"></div><div id="d">' +
      '<div class="b" style="width:98px;max-width:100%"></div></div></div>' +
      // within a `max-width` that is a length, and no less than a minimum
      '<div class="row"><div class="rest"></div>' +
      '<div id="e" style="display:flex">' +
      '<div class="b" style="width:98px;max-width:60px"></div>' +
      '<div class="b" style="width:10px;min-width:30px"></div></div></div>' +
      // a replaced box's percentage limit is of nothing at its least (CSS
      // Sizing 3, 5.2.1), which is what lets an image shrink
      '<div class="row"><div class="rest"></div><div id="f">' +
      '<svg style="display:block;width:98px;max-width:100%;height:10px">' +
      '</svg></div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.deepStrictEqual(
    [box('a').width, box('b').width, box('c').width],
    [138, 98, 40],
    'a row of items with widths is as wide as they are',
  );
  assert.strictEqual(box('a').x, 162, 'and the item beside it has the rest');
  assert.strictEqual(box('d').width, 98, 'a block with a width in an item');
  assert.strictEqual(box('e').width, 90, 'within its limits in pixels');
  assert.ok(box('f').width < 98, 'and a replaced box gives way');
});

test('what is in a stretched or flexed item takes its percentages of its height', async () => {
  // CSS Flexbox 9.8: an item stretched across its line, or flexed in a
  // column of a height of its own, has a definite height, and `h-full` in
  // it fills it — a sidebar's scrolling list, a column's panel. They had
  // nothing to take a percentage of, and were as tall as their content.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;height:200px">' +
      '<aside style="width:100px"><div id="a" style="height:100%"></div>' +
      '</aside><main style="flex:1"></main></div>' +
      '<div style="display:flex;flex-direction:column;height:200px">' +
      '<div style="height:40px"></div>' +
      '<div style="flex:1"><div id="b" style="height:50%"></div></div>' +
      '</div>' +
      // and a column item is as tall as the column makes it, shrunk too,
      // to the lesser of its height and its content's
      '<div style="display:flex;flex-direction:column;height:100px">' +
      '<div id="c" style="height:150px"><div style="height:120px"></div>' +
      '</div><div id="d" style="height:150px;min-height:0"></div></div>' +
      // and one with a ratio no shorter than its width through the ratio
      '<div style="display:flex;flex-direction:column;width:100px;height:0">' +
      '<div id="e" style="aspect-ratio:1"></div>' +
      '<div id="f" style="aspect-ratio:2;height:100px"></div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.strictEqual(box('a').height, 200, 'h-full in a stretched item');
  assert.strictEqual(box('b').height, 80, 'half of the flexed item');
  assert.strictEqual(box('c').height, 120, 'no shorter than its content');
  assert.strictEqual(box('d').height, 0, 'min-height: 0 lets it go');
  assert.strictEqual(box('e').height, 100, 'a square stays square');
  assert.strictEqual(box('f').height, 50, 'shrunk to its ratio');
});

test('a flex item that is a flex or grid container lays its items out in the height it was given', async () => {
  // CSS Flexbox 9.4, step 11: a stretched item's contents are laid out
  // again with its used cross size for a definite one, and 9.8 has an
  // item's flexed size along a column of a definite height definite too.
  // A row of cards, each a column ending in a `margin-top: auto` button —
  // Bootstrap's `.card` with `.mt-auto`, Tailwind's `flex flex-col` — had
  // its cards stretched and what was in them left at the top, laid out at
  // their content's own height: a `flex: 1` in one was no height at all.
  const card = 'display:flex;flex-direction:column;width:100px';
  const tall = '<div style="height:120px;width:100px"></div>';
  const { node } = await render(
    '<style>body{margin:0}.s{height:20px}.m{height:30px}</style>' +
      '<div style="display:flex">' +
      `<div id="a" style="${card}"><div id="a1" style="flex:1"></div>` +
      '<div id="a2" class="m"></div></div>' +
      `<div style="${card}"><div class="s"></div>` +
      '<div id="b2" class="m" style="margin-top:auto"></div></div>' +
      // a row in a row: its line is as tall as the item
      '<div style="display:flex;align-items:center;width:100px">' +
      '<div id="c1" class="s" style="width:10px"></div></div>' +
      // and a grid, whose `fr` row fills it
      '<div style="display:grid;grid-template-rows:1fr auto;width:100px">' +
      '<div id="d1"></div><div class="m"></div></div>' +
      // the one the line is as tall as is laid out as it was
      `<div style="${card}"><div style="height:90px"></div>` +
      `<div id="t2" class="m" style="margin-top:auto"></div></div>${tall}` +
      '</div>' +
      // each line of a row that wraps is as tall as its own tallest
      '<div style="display:flex;flex-wrap:wrap;width:200px">' +
      `<div style="${card}"><div class="s"></div>` +
      `<div id="e2" class="m" style="margin-top:auto"></div></div>${tall}` +
      `<div style="${card}"><div class="s"></div>` +
      '<div id="f2" class="m" style="margin-top:auto"></div></div>' +
      '<div style="height:80px;width:100px"></div></div>' +
      // and down a column of a height of its own, the item that flexes
      '<div style="display:flex;flex-direction:column;height:120px">' +
      '<div class="s"></div>' +
      `<div id="g" style="${card};flex:1"><div class="s"></div>` +
      '<div id="g2" class="m" style="margin-top:auto"></div></div></div>',
  );
  const el = view(node);
  /** How far down its card an item is, and how tall. */
  const at = (id: string) => {
    const item = boxOf(el, id) as LaidBox & { parent: LaidBox };
    return [item.y - item.parent.y, item.height];
  };
  assert.strictEqual(boxOf(el, 'a').height, 120, 'stretched across the row');
  assert.deepStrictEqual(at('a1'), [0, 90], 'flex: 1 takes the rest');
  assert.deepStrictEqual(at('a2'), [90, 30]);
  assert.deepStrictEqual(at('b2'), [90, 30], 'margin-top: auto');
  assert.deepStrictEqual(at('c1'), [50, 20], 'centred in the line');
  assert.deepStrictEqual(at('d1'), [0, 90], 'the fr row');
  assert.deepStrictEqual(at('t2'), [90, 30], 'the tallest card');
  assert.deepStrictEqual(at('e2'), [90, 30], 'the first line');
  assert.deepStrictEqual(at('f2'), [50, 30], 'the second, 80 tall');
  assert.strictEqual(boxOf(el, 'g').height, 100, 'what the column leaves');
  assert.deepStrictEqual(at('g2'), [70, 30]);
});

test('a row that wraps stretches its items to a line as tall as its tallest item, past the box', async () => {
  // The lines of a row that wraps are as tall as their tallest items, each
  // as tall as its content (CSS Flexbox 9.4, steps 7 and 8), and one taller
  // than the box runs past it; a stretched item is as tall as its line
  // (step 11). Yoga measured them at the box's height wherever the row had
  // room along it for them all, and squashed the 13px block's item, and
  // the item beside it, to 10. Its margins are the line's too, and its
  // `max-height` holds it; an image is as tall as its ratio makes its
  // width; a row a column flexed to a height is the same. Where the lines
  // run bottom to top, the line starts at the box's bottom and runs past
  // its top. A percentage height is of the box still: Yoga takes one of a
  // box it does not hold to a size for none.
  const block = '<div style="width:30px;height:13px"></div>';
  const short = '<div style="width:30px;height:5px"></div>';
  const row = (style: string, items: string) =>
    '<div style="display:flex;flex-wrap:wrap;width:100px;height:10px;' +
    `${style}">${items}</div>`;
  const { el } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      row('', `<div id="a">${block}</div><div id="b">${short}</div>`) +
      row(
        'flex-wrap:wrap-reverse',
        `<div id="c">${block}</div><div id="d">${short}</div>`,
      ) +
      row(
        '',
        `<div id="e" style="margin:2px 0 3px">${block}</div>` +
          `<div id="f">${short}</div>`,
      ) +
      row('', `<div id="g" style="max-height:11px">${block}</div>`) +
      row('', `<img id="h" src="r.png" style="width:20px">`) +
      row(
        '',
        `<div id="i">${block}</div>` +
          `<div id="j" style="height:50%">${block}</div>`,
      ) +
      '<div style="display:flex;flex-direction:column;height:30px">' +
      '<div style="display:flex;flex-wrap:wrap;flex:1 1 0;min-height:0">' +
      '<div id="k"><div style="width:30px;height:40px"></div></div>' +
      `<div id="l">${short}</div></div></div>`,
    { 'r.png': RED_PNG },
  );
  /** How far down its flex box an item is, and how tall. */
  const at = (id: string) => {
    const item = boxOf(el, id) as LaidBox & { parent: LaidBox };
    return [item.y - item.parent.y, item.height];
  };
  await waitFor(() => assert.deepStrictEqual(at('h'), [0, 20], 'the image'));
  assert.deepStrictEqual(at('a'), [0, 13], 'as tall as its block');
  assert.deepStrictEqual(at('b'), [0, 13], 'stretched to the line');
  assert.deepStrictEqual(at('c'), [-3, 13], 'from the bottom, in reverse');
  assert.deepStrictEqual(at('d'), [-3, 13]);
  assert.deepStrictEqual(at('e'), [2, 13], 'within its margins');
  assert.deepStrictEqual(at('f'), [0, 18], 'which are the line’s');
  assert.deepStrictEqual(at('g'), [0, 11], 'within its max-height');
  assert.deepStrictEqual(at('i'), [0, 13]);
  assert.deepStrictEqual(at('j'), [0, 5], 'half the box');
  assert.deepStrictEqual(at('k'), [0, 40], 'in a row a column flexed');
  assert.deepStrictEqual(at('l'), [0, 40]);
});

test('a row that wraps centres or ends its line by its items’ height', async () => {
  // `align-content` puts the room left beside the lines of a row that
  // wraps before them, or around them (CSS Flexbox 9.4, step 9), and where
  // the lines are taller than the box, takes it from there, past its
  // edges. Yoga measured each stretched item at the box's height where the
  // row had room along it for them all, and its one line had nothing to
  // move by: it stayed at the box's top. And `start` and `end` were read
  // as `flex-start` and `flex-end`, which a row that wraps in reverse has
  // at its bottom and its top.
  const block = '<div style="width:30px;height:13px"></div>';
  const short = '<div style="width:30px;height:5px"></div>';
  const row = (id: string, style: string) =>
    '<div style="display:flex;flex-wrap:wrap;width:100px;' +
    `${style}"><div id="${id}">${block}</div><div>${short}</div></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      row('a', 'height:60px;align-content:center') +
      row('b', 'height:60px;align-content:flex-end') +
      row('c', 'height:10px;align-content:center') +
      row('d', 'height:10px;align-content:flex-end') +
      row('e', 'height:60px;align-content:center;flex-wrap:wrap-reverse') +
      row('f', 'height:60px;align-content:flex-start') +
      // `start` and `end` are the box's top and bottom, where its lines
      // start and end are the other way round
      row('g', 'height:60px;align-content:end;flex-wrap:wrap-reverse') +
      row('h', 'height:60px;align-content:start;flex-wrap:wrap-reverse') +
      row('i', 'height:10px;align-content:end;flex-wrap:wrap-reverse'),
  );
  const el = view(node);
  const at = (id: string) => {
    const item = boxOf(el, id) as LaidBox & { parent: LaidBox };
    return [item.y - item.parent.y, item.height];
  };
  assert.deepStrictEqual(at('a'), [23.5, 13], 'centred');
  assert.deepStrictEqual(at('b'), [47, 13], 'at the end');
  assert.deepStrictEqual(at('c'), [-1.5, 13], 'past both edges');
  assert.deepStrictEqual(at('d'), [-3, 13], 'past the top');
  assert.deepStrictEqual(at('e'), [23.5, 13], 'centred, in reverse');
  assert.deepStrictEqual(at('f'), [0, 13], 'at the start, as it was');
  assert.deepStrictEqual(at('g'), [47, 13], 'the end, at the bottom');
  assert.deepStrictEqual(at('h'), [0, 13], 'the start, at the top');
  assert.deepStrictEqual(at('i'), [-3, 13], 'the end, past the top');
});

test('an item with an auto margin across a row that wraps takes the room its line has past it', async () => {
  // An `auto` margin across the line takes what the line has past the
  // item, which is not stretched (CSS Flexbox 8.1, 9.4 step 11). Yoga sets
  // the items of a row that wraps across their lines in a pass of its own
  // that reads their alignment and not their margins, and stretched each of
  // these to its line, or set it at its line's start.
  const tall = '<div style="width:30px;height:13px"></div>';
  const short = '<div style="width:30px;height:5px"></div>';
  const fixed = 'width:20px;height:10px';
  const row = (style: string, items: string) =>
    '<div style="display:flex;flex-wrap:wrap;width:100px;' +
    `${style}">${items}</div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      row(
        'height:10px',
        `<div id="a" style="margin-top:auto">${short}</div><div>${tall}</div>`,
      ) +
      row(
        'height:80px;align-content:flex-end',
        '<div id="b" style="width:20px;height:46px;margin:5px 0 2px;' +
          'margin-top:auto"></div>' +
          '<div style="width:30px;height:60px"></div>',
      ) +
      row(
        'height:80px;align-content:center',
        `<div id="c" style="${fixed};margin:auto 0"></div>` +
          `<div id="d" style="margin-bottom:auto;margin-top:4px">${short}` +
          '</div><div style="width:30px;height:60px"></div>',
      ) +
      // where the lines run bottom to top, the margins are where they are
      row(
        'height:75px;flex-wrap:wrap-reverse',
        `<div id="e" style="${fixed};margin-top:auto;margin-bottom:3px">` +
          `</div><div id="f" style="${fixed};margin-bottom:auto;` +
          `margin-top:4px"></div><div id="g" style="${fixed};margin:auto 0">` +
          '</div><div style="width:20px;height:40px"></div>',
      ),
  );
  const el = view(node);
  const at = (id: string) => {
    const item = boxOf(el, id) as LaidBox & { parent: LaidBox };
    return [item.y - item.parent.y, item.height];
  };
  assert.deepStrictEqual(at('a'), [8, 5], 'at the end of its line');
  assert.deepStrictEqual(at('b'), [32, 46], 'within its bottom margin');
  assert.deepStrictEqual(at('c'), [35, 10], 'centred');
  assert.deepStrictEqual(at('d'), [14, 5], 'at the start, not stretched');
  assert.deepStrictEqual(at('e'), [62, 10], 'at the bottom, in reverse');
  assert.deepStrictEqual(at('f'), [4, 10], 'at the top, in reverse');
  assert.deepStrictEqual(at('g'), [32.5, 10], 'centred, in reverse');
});

test('an item across a row that wraps in reverse is within its own margins', async () => {
  // Where the lines run bottom to top, an item's cross-start margin is its
  // bottom one (CSS Flexbox 9.4, step 11; 9.6). Yoga lays the lines out
  // top to bottom and turns every item over across the box, so that each
  // stood its bottom margin from where its top one should have been: a
  // stretched item 2px high, one at its line's end 3px low.
  const fixed = 'width:20px;height:10px';
  const row = (style: string, items: string) =>
    '<div style="display:flex;flex-wrap:wrap-reverse;width:120px;' +
    `${style}">${items}<div style="width:20px;height:40px"></div></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      row(
        'height:75px;align-content:center;row-gap:2px',
        '<div id="a" style="margin:5px 2px 3px">' +
          '<div style="width:30px;height:32px"></div></div>',
      ) +
      row(
        'height:75px',
        `<div id="b" style="${fixed};align-self:flex-end;margin:0 4px 3px">` +
          `</div><div id="c" style="${fixed};align-self:flex-start;` +
          `margin:4px 4px 3px"></div><div id="d" style="${fixed};` +
          'align-self:center;margin:6px 4px 1px"></div>',
      ),
  );
  const el = view(node);
  const at = (id: string) => {
    const item = boxOf(el, id) as LaidBox & { parent: LaidBox };
    return [item.y - item.parent.y, item.height];
  };
  assert.deepStrictEqual(at('a'), [22.5, 32], 'stretched, within them');
  assert.deepStrictEqual(at('b'), [0, 10], 'its end at the top');
  assert.deepStrictEqual(at('c'), [62, 10], 'its start at the bottom');
  assert.deepStrictEqual(at('d'), [35, 10], 'centred within them');
});

test('a row that wraps spaces its lines out, each as tall as its tallest item', async () => {
  // `space-between`, `space-around` and `space-evenly` put the room left
  // beside the lines of a row that wraps between them (CSS Flexbox 9.4,
  // step 9; CSS Box Alignment 3, 5.1), and a stretched item is as tall as
  // its line (step 11). Yoga laid a stretched item out again as tall as its
  // line and the room after it, so on two lines `space-between` made the
  // 10px item 80 tall, and the row as tall as that; `space-evenly` was not
  // handed to it, and the lines were stretched. A row with one line
  // centres it for `space-around` and `space-evenly`, where Yoga had it at
  // the row's top.
  const block = (height: number) =>
    `<div style="width:60px;height:${height}px"></div>`;
  const row = (id: string, style: string) =>
    '<div style="display:flex;flex-wrap:wrap;width:100px;' +
    `${style}"><div id="${id}a">${block(10)}</div>` +
    `<div id="${id}b">${block(20)}</div></div>`;
  const line = (id: string, style: string) =>
    '<div style="display:flex;flex-wrap:wrap;width:200px;height:60px;' +
    `${style}"><div id="${id}a">${block(13)}</div>` +
    `<div id="${id}b">${block(5)}</div></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      row('s', 'height:100px;align-content:space-between') +
      row('a', 'height:100px;align-content:space-around') +
      row('v', 'height:90px;align-content:space-evenly') +
      row(
        'r',
        'height:100px;align-content:space-around;flex-wrap:wrap-reverse',
      ) +
      row('m', 'min-height:100px;align-content:space-between') +
      row('c', 'height:100px;align-content:space-between;align-items:center') +
      line('o', 'align-content:space-around') +
      line('e', 'align-content:space-evenly') +
      line('b', 'align-content:space-between'),
  );
  const el = view(node);
  const at = (id: string) => {
    const item = boxOf(el, id) as LaidBox & { parent: LaidBox };
    return [item.y - item.parent.y, item.height];
  };
  assert.deepStrictEqual(at('sa'), [0, 10], 'space between');
  assert.deepStrictEqual(at('sb'), [80, 20]);
  assert.deepStrictEqual(at('aa'), [17.5, 10], 'space around');
  assert.deepStrictEqual(at('ab'), [62.5, 20]);
  assert.deepStrictEqual(at('va'), [20, 10], 'space evenly');
  assert.deepStrictEqual(at('vb'), [50, 20]);
  assert.deepStrictEqual(at('ra'), [72.5, 10], 'from the bottom, in reverse');
  assert.deepStrictEqual(at('rb'), [17.5, 20]);
  assert.deepStrictEqual(at('ma'), [0, 10], 'in a row of a min-height');
  assert.deepStrictEqual(at('mb'), [80, 20]);
  assert.strictEqual(
    (boxOf(el, 'ma') as LaidBox & { parent: LaidBox }).parent.height,
    100,
    'which is as tall as its min-height',
  );
  assert.deepStrictEqual(at('ca'), [0, 10], 'centred in their lines');
  assert.deepStrictEqual(at('cb'), [80, 20]);
  assert.deepStrictEqual(at('oa'), [23.5, 13], 'one line, space around');
  assert.deepStrictEqual(at('ob'), [23.5, 13], 'stretched to the line');
  assert.deepStrictEqual(at('ea'), [23.5, 13], 'one line, space evenly');
  assert.deepStrictEqual(at('eb'), [23.5, 13]);
  assert.deepStrictEqual(at('ba'), [0, 13], 'one line, space between');
  assert.deepStrictEqual(at('bb'), [0, 13]);
});

test('last baseline is its fallback alignment, the end', async () => {
  // CSS Box Alignment 3, 4.2: where a box cannot be aligned by its last
  // baseline it is aligned to the end, and nothing here aligns by one. The
  // declaration was dropped, which left the row's items stretched: a flex
  // box that wraps, stretched so, has its lines spread down the row.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;align-items:last baseline;height:100px">' +
      '<div id="a" style="display:flex;flex-wrap:wrap;width:60px">' +
      '<div style="width:60px;height:20px"></div>' +
      '<div id="a2" style="width:60px;height:30px"></div></div>' +
      '<div id="b" style="height:40px;align-self:last baseline"></div></div>',
  );
  const el = view(node);
  const ends = (id: string) => boxOf(el, id).y + boxOf(el, id).height;
  assert.strictEqual(boxOf(el, 'a').height, 50, 'as tall as its two lines');
  assert.deepStrictEqual([ends('a'), ends('a2'), ends('b')], [100, 100, 100]);
});

test('a flex box flexed along a column of no definite height lays its items out in the height it came to', async () => {
  // `min-h-screen flex flex-col` around a `flex-1 flex items-center
  // justify-center`: the column's height is its least one, which is no
  // definite height (CSS Flexbox 9.8), and the item that takes the rest of
  // it is that tall all the same — its used size (9.7) — and centres what
  // is in it there. It centred it in its content's own height, at the top.
  // Nothing takes a percentage of such a height, in a browser either.
  const column = 'display:flex;flex-direction:column';
  const { node } = await render(
    '<style>body{margin:0}.s{height:20px}.m{height:30px}</style>' +
      `<div style="${column};min-height:200px"><div class="s"></div>` +
      '<div id="a" style="flex:1;display:flex;align-items:center;' +
      'justify-content:center"><div id="a1" class="m" style="width:80px">' +
      '</div></div><div class="s"></div></div>' +
      // a column in it, and a column in that
      `<div style="${column};min-height:120px"><div class="s"></div>` +
      `<div style="${column};flex:1"><div id="b" style="${column};flex:1">` +
      '<div id="b1" class="m" style="margin-top:auto"></div></div></div>' +
      '</div>' +
      // a row's items are stretched across it, a grid's `fr` row fills it
      `<div style="${column};min-height:120px"><div class="s"></div>` +
      '<div style="flex:1;display:flex"><div id="c1" style="width:50px">' +
      '<div id="c2" style="height:100%"></div></div></div></div>' +
      `<div style="${column};min-height:120px"><div class="s"></div>` +
      '<div style="flex:1;display:grid;grid-template-rows:1fr auto">' +
      '<div id="d1"></div><div class="m"></div></div></div>' +
      // but no percentage is of it: `auto`, as in a column with no height
      `<div style="${column};min-height:120px"><div class="s"></div>` +
      `<div style="${column};flex:1"><div id="e1" style="height:50%">` +
      '</div></div></div>' +
      // and shrunk, where the column's greatest height is under its content
      `<div style="${column};max-height:60px">` +
      '<div class="s" style="flex:none"></div>' +
      `<div id="f" style="${column};min-height:0">` +
      '<div class="s" style="flex:none"></div>' +
      '<div id="f2" style="height:60px"></div></div></div>',
    300,
  );
  const el = view(node);
  /** How far down and along its flex box an item is, and how tall. */
  const at = (id: string) => {
    const item = boxOf(el, id) as LaidBox & { parent: LaidBox };
    return [item.x - item.parent.x, item.y - item.parent.y, item.height];
  };
  assert.strictEqual(boxOf(el, 'a').height, 160, 'what the column leaves');
  assert.deepStrictEqual(at('a1'), [110, 65, 30], 'centred in it');
  assert.strictEqual(boxOf(el, 'b').height, 100);
  assert.deepStrictEqual(at('b1'), [0, 70, 30], 'margin-top: auto, twice in');
  assert.deepStrictEqual(at('c1'), [0, 0, 100], 'stretched across the row');
  assert.strictEqual(boxOf(el, 'c2').height, 100, 'which is definite');
  assert.deepStrictEqual(at('d1'), [0, 0, 70], 'the fr row');
  assert.strictEqual(boxOf(el, 'e1').height, 0, 'a percentage of nothing');
  assert.strictEqual(boxOf(el, 'f').height, 40);
  assert.deepStrictEqual(at('f2'), [0, 20, 20], 'shrunk into it');
});

metric(
  'a flex row measured for its content does not grow its flex: 1 items',
  async () => {
    // Tailwind UI's list item: a row of an avatar and a column that takes
    // `flex-1`, beside a column of a role and a badge. Measuring the row's
    // max-content laid it out at an infinite width, which Yoga took for a
    // width and grew the column to fill; the row came back vast, and the
    // role beside it was squeezed until "Designer" broke inside itself.
    const { node } = await render(
      '<style>body{margin:0} *{box-sizing:border-box;margin:0}</style>' +
        '<div style="display:flex;align-items:center;' +
        'justify-content:space-between;gap:24px;width:600px">' +
        '<div id="left" style="display:flex;min-width:0;gap:16px">' +
        '<div style="width:48px;height:48px"></div>' +
        '<div id="col" style="min-width:0;flex:1"><p>Leslie Alexander</p>' +
        '<p>leslie.alexander@example.com</p></div></div>' +
        '<div id="right" style="display:flex;flex-direction:column;' +
        'align-items:center"><p id="role">Co-Founder / CEO</p>' +
        '<span>Active</span></div></div>',
    );
    const el = view(node);
    const left = boxOf(el, 'left');
    const col = boxOf(el, 'col');
    // the left side is as wide as its content: the avatar, the gap, the text
    assert.ok(
      Math.abs(left.width - (48 + 16 + col.width)) < 0.5,
      `${left.width} is the avatar, the gap and ${col.width}`,
    );
    assert.ok(left.width < 400, `the left side is ${left.width}, not the row`);
    // and the role is on one line
    assert.strictEqual(linesOf(el, 'role').length, 1);
  },
);

test('a flex item with a ratio sizes across its line from its size along it', async () => {
  const { el } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      // down a column, as wide as the height it was flexed to
      '<div style="display:inline-flex;flex-direction:column;' +
      'flex-wrap:wrap;height:100px">' +
      '<div id="a" style="aspect-ratio:1;min-height:0;height:50px;flex:1">' +
      '</div></div>' +
      // along a row, as wide as the height it is stretched to, and no
      // narrower than that however little room there is
      '<div style="display:flex;width:0;height:100px">' +
      '<div id="b" style="aspect-ratio:1"></div></div>' +
      '<div style="display:flex;width:0;height:100px">' +
      '<div id="c" style="aspect-ratio:1/2"><div style="width:100px">' +
      '</div></div></div>' +
      // a column's content basis is its width through its ratio
      '<div style="display:flex;flex-direction:column">' +
      '<div id="d" style="flex-basis:content;width:100px;aspect-ratio:1;' +
      'height:20px;min-height:0"></div></div>' +
      // and an image grown along a row is as tall as that makes it
      '<div style="display:flex;width:100px">' +
      '<img id="e" src="r.png" style="width:50px;aspect-ratio:1;flex:1;' +
      'min-height:0"></div>',
    { 'r.png': RED_PNG },
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  await waitFor(() => assert.deepStrictEqual(size('e'), [100, 100]));
  assert.deepStrictEqual(size('a'), [100, 100]);
  assert.deepStrictEqual(size('b'), [100, 100]);
  assert.deepStrictEqual(size('c'), [100, 100], 'its content is wider');
  assert.deepStrictEqual(size('d'), [100, 100]);
});

test("a column with no height keeps its items' flex-basis", async () => {
  // Yoga takes a basis only where the flex box's main size is definite, and
  // read `flex: 0 0 50px` down such a column as the item's own height, or
  // as its content's
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;flex-direction:column">' +
      '<div id="a" style="flex:0 0 50px">x</div>' +
      '<div id="b" style="flex-basis:30px;height:80px;padding:5px"></div>' +
      '</div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 50);
  assert.strictEqual(boxOf(el, 'b').height, 40, 'its content box, padded');
});

test('an item across a column is no narrower than its content at its narrowest', async () => {
  // Where it is not stretched, an item is `fit-content` across a column
  // (CSS Flexbox 9.4, step 7): fitted to the column, and past it where its
  // content at its narrowest is wider — past both sides, centred. It was
  // fitted to the column whatever it held. Its `min-width` has no say in
  // that: an automatic minimum is the main axis's (4.5), and Chrome's `b`
  // is 201 wide with `min-width: 0` as without it.
  const block = '<div style="width:201px;height:13px"></div>';
  const column = 'display:flex;flex-direction:column;width:50px';
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      `<div style="${column};align-items:flex-start">` +
      `<div id="a">${block}</div></div>` +
      `<div style="${column};align-items:center;margin-left:100px">` +
      `<div id="b" style="min-width:0">${block}</div>` +
      `<div id="c" style="max-width:100px">${block}</div>` +
      `<div id="d" style="align-self:stretch">${block}</div>` +
      // no wider at its narrowest than the column: fitted to it
      '<div id="e"><div style="float:left;width:30px;height:5px"></div>' +
      '<div style="float:left;width:30px;height:5px"></div></div></div>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).width];
  assert.deepStrictEqual(at('a'), [0, 201], 'from the start, past the end');
  assert.deepStrictEqual(at('b'), [24.5, 201], 'centred, past both sides');
  assert.deepStrictEqual(at('c'), [75, 100], 'within its maximum');
  assert.deepStrictEqual(at('d'), [100, 50], "stretched, the column's");
  assert.deepStrictEqual(at('e'), [100, 50], 'fitted to the column');
});

test('an item a column that wraps stretches across its line is as tall as the line made it, whatever its margins', async () => {
  // Stretching an item across its line does not change its size down it
  // (CSS Flexbox 9.4, step 11). Yoga lays each such item out again as it
  // aligns the lines of a column that wraps, at its height plus its side
  // margins less its top and bottom ones: `margin: 0 5px` was 28 tall
  // where Chrome's is 18, `margin: 4px 0 2px` on two lines 12, and a
  // `flex-grow` item 10 taller than the room it grew into, on a line as
  // wide as the column or wider. The item after each was where the right
  // height puts it, and the column's height was the wrong one's.
  const block = '<i style="display:block;height:18px"></i>';
  const column = (style: string, items: string) =>
    '<div style="display:flex;flex-direction:column;flex-wrap:wrap;' +
    `width:300px;${style}">${items}</div>`;
  const item = (id: string, style: string) =>
    `<div id="${id}" style="${style}">${block}</div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      column(
        '',
        item('a', 'margin:0 5px') +
          item('b', 'margin:4px 5px 2px') +
          item('c', 'margin:0 9px;padding:3px;min-height:30px'),
      ) +
      // two lines, and nothing to hold an item to its content
      column(
        'height:60px',
        item('d', 'margin:4px 0 2px;min-height:0') +
          item('e', 'margin:4px 0 2px;min-height:0') +
          item('f', 'margin:4px 0 2px;min-height:0'),
      ) +
      column(
        'height:100px',
        item('g', 'margin:0 5px;flex-grow:1') + item('h', 'margin:4px 5px 2px'),
      ) +
      // on a line wider than the column, as wide as its widest item
      column(
        'width:50px',
        '<div><div style="width:201px;height:13px"></div></div>' +
          item('i', 'margin:0 5px'),
      ),
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).y, boxOf(el, id).height];
  assert.deepStrictEqual(at('a'), [0, 18], 'side margins');
  assert.deepStrictEqual(at('b'), [22, 18], 'side, top and bottom margins');
  assert.deepStrictEqual(at('c'), [42, 36], 'at its minimum, padded');
  assert.deepStrictEqual(at('d'), [82, 18], 'top and bottom margins, wrapped');
  assert.deepStrictEqual(at('e'), [106, 18]);
  assert.deepStrictEqual(at('f'), [82, 18], 'on the second line');
  assert.deepStrictEqual(at('g'), [138, 76], 'grown into the room');
  assert.deepStrictEqual(at('h'), [218, 18]);
  assert.deepStrictEqual(at('i'), [251, 18], 'on a line wider than the box');
  assert.strictEqual(boxOf(el, 'i').width, 191);
});

test("a replaced item across a column is its natural width, and the column's where it has none", async () => {
  // its content at its narrowest is its natural width; one with only a
  // ratio has none, and is fitted to the column (css-flexbox
  // `align-items-007`); and held to a `max-width: 100%`, it is as tall as
  // that width makes it, where Yoga held the width it was measured at
  // and kept the height
  const column = 'display:flex;flex-direction:column;align-items:center';
  const { el } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      `<div style="${column};width:4px;margin-left:20px">` +
      '<img id="a" src="r.png"><img id="b" src="r.png" style="max-width:100%">' +
      '</div>' +
      `<div style="${column};width:50px">` +
      '<svg id="c" viewBox="0 0 200 100"></svg></div>' +
      // a percentage of a height in it, which the flex layout makes
      // definite only after it is measured, leaves it fitted to the column
      // (css-sizing `intrinsic-percent-replaced-017`)
      `<div style="${column};width:100px;height:100px">` +
      '<div id="d" style="max-height:100%">' +
      '<img src="big.svg" style="max-height:100%"></div></div>',
    {
      'r.png': RED_PNG,
      'big.svg': svgBytes(`<svg ${SVG_NS} width="200" height="200"/>`),
    },
  );
  const at = (id: string) => {
    const box = boxOf(el, id);
    return [box.x, box.width, box.height];
  };
  await waitFor(() => assert.deepStrictEqual(at('a'), [17, 10, 10]));
  assert.deepStrictEqual(at('b'), [20, 4, 4]);
  assert.deepStrictEqual(at('c'), [0, 50, 25]);
  await waitFor(() => assert.deepStrictEqual(at('d'), [0, 100, 100]));
});

metric(
  "a flex row across a column is as wide as its items' narrowest side by side",
  async () => {
    // a flex box's content at its narrowest is its items' side by side, and
    // read as its widest word (`exactMinContent`), the item was as wide as
    // the first, and the second ran out of it
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-start;' +
        'width:20px"><div id="r" style="display:flex">' +
        '<div id="a">Documentation</div><div id="b">pages</div></div></div>',
    );
    const el = view(node);
    const [r, a, b] = ['r', 'a', 'b'].map((id) => boxOf(el, id));
    assert.strictEqual(b.x, a.x + a.width, 'side by side');
    assert.ok(
      Math.abs(r.width - (a.width + b.width)) < 0.01,
      `${r.width} is as wide as ${a.width} and ${b.width}`,
    );
  },
);

test('a column that wraps stretches its items to its line, as wide as its widest item at its narrowest', async () => {
  // The lines of a column that wraps are as wide as their widest items,
  // each `fit-content` across (CSS Flexbox 9.4, steps 7 and 8), and one
  // wider than the box runs past it; a stretched item is as wide as its
  // line (step 11). Yoga stretched them to the box, wherever the column
  // had room for them all down it — with no height, always — and the 201px
  // block ran out of its item. Where the lines run right to left, the line
  // starts at the box's right edge and runs past its left one. A
  // percentage width is of the box still: Yoga takes one of a box it does
  // not hold to a size for none, and measured `p` as wide as its content.
  const block = '<div style="width:201px;height:13px"></div>';
  const column = (id: string, style: string) =>
    '<div style="display:flex;flex-direction:column;flex-wrap:wrap;' +
    `width:50px;${style}"><div id="${id}a">${block}</div>` +
    `<div id="${id}b" style="height:5px"></div></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      column('n', '') +
      column('h', 'height:60px') +
      column('r', 'flex-wrap:wrap-reverse') +
      column('l', 'direction:rtl') +
      '<div style="display:flex;flex-direction:column;flex-wrap:wrap;' +
      `width:50px"><div id="p" style="width:50%;height:5px"></div>` +
      `<div id="q">${block}</div></div>`,
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).width];
  assert.deepStrictEqual(at('na'), [0, 201], 'as wide as its block');
  assert.deepStrictEqual(at('nb'), [0, 201], 'stretched to the line');
  assert.deepStrictEqual(at('ha'), [0, 201], 'with room down the column');
  assert.deepStrictEqual(at('hb'), [0, 201]);
  assert.deepStrictEqual(at('ra'), [-151, 201], 'from the right, in reverse');
  assert.deepStrictEqual(at('rb'), [-151, 201]);
  assert.deepStrictEqual(at('la'), [-151, 201], 'from the right, rtl');
  assert.deepStrictEqual(at('lb'), [-151, 201]);
  assert.deepStrictEqual(at('p'), [0, 25], 'half the box');
  assert.deepStrictEqual(at('q'), [0, 201]);
});

test('a column that wraps keeps the height of an item it stretches', async () => {
  // Stretching a line short of the box to it, Yoga lays each stretched
  // item out again at its height less its top and bottom margins, and with
  // nothing to hold it to its content, the item was shorter by them; so
  // the box is handed to Yoga as a size where the line is the box's
  const block = '<div style="width:201px;height:13px"></div>';
  const column = (width: number, items: string) =>
    '<div style="display:flex;flex-direction:column;flex-wrap:wrap;' +
    `width:${width}px">${items}</div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      column(
        300,
        '<div id="a" style="margin:5px 0;min-height:0">' +
          '<div style="width:100px;height:13px"></div></div>' +
          '<div id="b" style="height:5px;margin:2px 0;overflow:hidden"></div>',
      ) +
      column(
        50,
        `<div id="c" style="margin:5px 0;min-height:0">${block}</div>` +
          '<div id="d" style="height:5px;margin:2px 0;overflow:hidden"></div>',
      ),
  );
  const el = view(node);
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('a'), [300, 13], "the box's line");
  assert.deepStrictEqual(size('b'), [300, 5]);
  assert.deepStrictEqual(size('c'), [201, 13], 'a line wider than the box');
  assert.deepStrictEqual(size('d'), [201, 5]);
});

test('a column that wraps sets its lines where align-content says, each as wide as its widest item', async () => {
  // A line is as wide as its widest item, `fit-content` across the box
  // (CSS Flexbox 9.4, steps 7 and 8), and `align-content` sets the lines
  // in what the box has past them (9.6, step 16). Yoga stretched the
  // items to the box wherever the column had room for all of them down
  // it, so the line was the box and had no room to be centred or ended in.
  const column = (id: string, style: string) =>
    '<div style="display:flex;flex-direction:column;flex-wrap:wrap;' +
    `width:300px;${style}"><div id="${id}a">` +
    '<div style="width:150px;height:10px"></div></div>' +
    `<div id="${id}b" style="height:5px"></div></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      column('c', 'align-content:center') +
      column('e', 'align-content:flex-end') +
      column('a', 'align-content:space-around') +
      column('v', 'align-content:space-evenly') +
      column('s', 'align-content:space-between') +
      column('l', 'align-content:flex-start;direction:rtl') +
      // `start` and `end` are the box's left and right, where the lines of
      // one that wraps in reverse start and end at the other sides
      column('n', 'align-content:end') +
      column('r', 'align-content:start;flex-wrap:wrap-reverse'),
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).width];
  assert.deepStrictEqual(at('ca'), [75, 150], 'centred');
  assert.deepStrictEqual(at('cb'), [75, 150], 'stretched to its line');
  assert.deepStrictEqual(at('ea'), [150, 150], 'at the end');
  assert.deepStrictEqual(at('eb'), [150, 150]);
  assert.deepStrictEqual(at('aa'), [75, 150], 'space around one line');
  assert.deepStrictEqual(at('va'), [75, 150], 'space evenly');
  assert.deepStrictEqual(at('sa'), [0, 150], 'space between one line');
  assert.deepStrictEqual(at('la'), [150, 150], 'from the right, rtl');
  assert.deepStrictEqual(at('lb'), [150, 150]);
  assert.deepStrictEqual(at('na'), [150, 150], 'the end, at the right');
  assert.deepStrictEqual(at('ra'), [0, 150], 'the start, in reverse');
});

test('a column that wraps is as wide as its items at their narrowest where they are wider, whatever align-content says', async () => {
  // Each item is `fit-content` across the box, no narrower than its
  // content at its narrowest (9.4, step 7). Where `align-content` does not
  // stretch the lines, Yoga lays a stretched item out again as wide as its
  // content at its widest. A line wider than the box is centred on it, or
  // ended at its start; the spacing values set it at the start.
  const words =
    '<span style="display:inline-block;width:100px;height:10px"></span> ' +
    '<span style="display:inline-block;width:60px;height:10px"></span>';
  const column = (id: string, style: string) =>
    '<div style="display:flex;flex-direction:column;flex-wrap:wrap;' +
    `width:50px;${style}"><div id="${id}a">${words}</div>` +
    `<div id="${id}b" style="height:5px"></div></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      column('s', 'align-content:flex-start') +
      column('c', 'align-content:center') +
      column('e', 'align-content:flex-end') +
      column('a', 'align-content:space-around') +
      column('r', 'align-content:flex-start;flex-wrap:wrap-reverse'),
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).width];
  assert.deepStrictEqual(at('sa'), [0, 100], 'at its narrowest');
  assert.deepStrictEqual(at('sb'), [0, 100], 'stretched to its line');
  assert.deepStrictEqual(at('ca'), [-25, 100], 'centred past both sides');
  assert.deepStrictEqual(at('ea'), [-50, 100], 'ended past the start');
  assert.deepStrictEqual(at('aa'), [0, 100], 'no room to space');
  assert.deepStrictEqual(at('ra'), [-50, 100], 'from the right, in reverse');
});

test('a column that wraps into lines spaces them, and keeps the sizes of the items it stretches', async () => {
  // The room past the lines goes between them, or to each of them alike
  // for `stretch` (9.4, step 9), and a stretched item is as wide as its
  // line less its margins (step 11) and as tall as the column made it.
  // Yoga added what `space-between` puts between two lines to the width of
  // each stretched item, and laid each out again at its height less its
  // top and bottom margins and plus its side ones.
  const column = (prefix: string, style: string) =>
    '<div style="display:flex;flex-direction:column;flex-wrap:wrap;' +
    `width:300px;height:40px;${style}">` +
    `<div id="${prefix}a" style="margin:0 7px">` +
    '<div style="width:150px;height:18px"></div></div>' +
    `<div id="${prefix}b" style="height:18px"></div>` +
    `<div id="${prefix}c" style="margin:3px 5px">` +
    '<div style="width:30px;height:18px"></div></div></div>';
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      column('s', 'align-content:space-between') +
      column('t', 'align-content:stretch;column-gap:10px'),
  );
  const el = view(node);
  const box = (id: string) => {
    const b = boxOf(el, id);
    return [b.x, b.width, b.height];
  };
  // lines 164 and 40 wide, the second at the end of the box
  assert.deepStrictEqual(box('sa'), [7, 150, 18]);
  assert.deepStrictEqual(box('sb'), [0, 164, 18]);
  assert.deepStrictEqual(box('sc'), [265, 30, 18]);
  // and 43 more each, 10 apart
  assert.deepStrictEqual(box('ta'), [7, 193, 18]);
  assert.deepStrictEqual(box('tb'), [0, 207, 18]);
  assert.deepStrictEqual(box('tc'), [222, 73, 18]);
});

test('an item across a line of a column that wraps is where its margins and its alignment put it', async () => {
  // An `auto` margin takes the room the line has past the item on its side
  // (CSS Flexbox 8.1), a stretched item is held to its limits, and the
  // rest are set as `align-self` says, in the line and not in the box: Yoga
  // set an item at the line's start whatever its `auto` margins said.
  const block = (width: number) =>
    `<div style="width:${width}px;height:10px"></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;flex-direction:column;flex-wrap:wrap;' +
      'width:300px;align-content:center">' +
      `<div id="a" style="margin-left:auto">${block(40)}</div>` +
      `<div id="b">${block(150)}</div>` +
      `<div id="c" style="margin:0 auto">${block(20)}</div>` +
      '<div id="d" style="max-width:80px;height:5px"></div>' +
      '<div id="e" style="min-width:200px;height:5px"></div>' +
      `<div id="f" style="align-self:flex-end">${block(30)}</div>` +
      `<div id="g" style="align-self:center">${block(30)}</div></div>`,
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).width];
  // a line as wide as `e`'s minimum, centred
  assert.deepStrictEqual(at('a'), [210, 40], "to the line's end");
  assert.deepStrictEqual(at('b'), [50, 200], 'stretched');
  assert.deepStrictEqual(at('c'), [140, 20], 'centred in the line');
  assert.deepStrictEqual(at('d'), [50, 80], 'held to its maximum');
  assert.deepStrictEqual(at('e'), [50, 200]);
  assert.deepStrictEqual(at('f'), [220, 30], "at the line's end");
  assert.deepStrictEqual(at('g'), [135, 30], 'centred in the line');
});

test('a column that wraps measures each item down it at its width before it is stretched', async () => {
  // A stretched item is as wide as its line only where the column does not
  // wrap (CSS Flexbox 9.8): in one that does, its height is its content's
  // at its `fit-content` width, and stretched, its content runs past it.
  // Yoga measured it at the box's width, as Chrome does not.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="box" style="display:flex;flex-direction:column;' +
      'flex-wrap:wrap;width:300px"><div style="height:18px"></div>' +
      '<div id="a"><div id="r" style="width:100%;aspect-ratio:2"></div>' +
      '</div></div>',
  );
  const el = view(node);
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('a'), [300, 0], 'none wide, so none tall');
  assert.deepStrictEqual(size('r'), [300, 150], 'running past it');
  assert.deepStrictEqual(size('box'), [300, 18]);
});

test('a flex item stretched across a column is as tall as its ratio makes it', async () => {
  // a replaced item was measured at the width it was given and answered
  // its natural height, along a column as it did along a row before
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;flex-direction:column;width:200px">' +
      '<canvas id="a" width="100" height="50" style="width:stretch;' +
      'align-self:start;min-height:0"></canvas>' +
      '<canvas id="b" width="100" height="50" style="width:50%;' +
      'align-self:start;min-height:0"></canvas></div>',
  );
  const box = (id: string) => boxOf(view(node), id);
  assert.deepStrictEqual([box('a').width, box('a').height], [200, 100]);
  assert.deepStrictEqual([box('b').width, box('b').height], [100, 50]);
});

test("the margins of what a flex item holds stay inside it, and a grid's", async () => {
  // Each is an independent formatting context (CSS Flexbox 1, 4; CSS Grid
  // 1, 6.1), so the margin at the bottom of its last block ends inside it
  // and makes it taller. It went out through the item's bottom edge, as
  // through a plain block's, and was lost to the item's height: a column of
  // sections stood closer than a browser's by the margin at each one's end
  const { node } = await render(
    '<style>body{margin:0}.flex{display:flex;width:400px}' +
      '.column{flex-direction:column}.grid{display:grid;width:400px}' +
      '.c{margin:10px 0 20px;height:20px}</style>' +
      '<div class="flex column" id="column"><section id="a">' +
      '<div class="c"></div></section><section id="b"><div class="c">' +
      '</div></section></div>' +
      '<div class="flex" id="row"><section id="c"><div class="c"></div>' +
      '</section></div>' +
      '<div class="grid" id="grid"><section id="d"><div class="c"></div>' +
      '</section></div>',
  );
  const box = (id: string) => boxOf(view(node), id);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.strictEqual(box(id).height, 50, `item ${id}, its margins in it`);
  }
  assert.strictEqual(box('b').y - box('a').y, 50, 'one item under another');
  assert.strictEqual(box('column').height, 100, 'the column');
  assert.strictEqual(box('row').height, 50, 'the row');
  assert.strictEqual(box('grid').height, 50, 'the grid');
});

metric(
  "an inline flex box that clips sits on its first item's baseline, as it does unclipped",
  async () => {
    // A block container that clips sits on its bottom margin edge, for
    // legacy reasons that stop at block containers (CSS Box Alignment 3,
    // 9.2). A MediaWiki button is an `overflow: hidden` inline flex box of
    // one icon, and it stood its whole height on the baseline, every line
    // holding one the strut's descent taller than a browser's: 32px was 35
    const { node } = await render(
      '<style>body{margin:0;font:14px sans-serif}div{width:300px}' +
        '.button{display:inline-flex;overflow:hidden;align-items:center;' +
        'min-height:32px}.icon{display:block;width:20px;height:20px}' +
        '.clip{display:block;overflow:hidden;height:32px}</style>' +
        '<div id="flex"><span class="button"><span class="icon"></span>' +
        '</span></div>' +
        // an inline block that clips keeps the legacy rule
        '<div id="block"><span class="clip" style="display:inline-block">' +
        'text</span></div>' +
        // and a block that clips has its first line's baseline still: only
        // its last is its margin edge
        '<div id="first"><span class="button" style="flex-direction:column">' +
        '<span class="clip">clip</span></span></div>',
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'flex').height, 32, 'the button line');
    assert.ok(
      boxOf(el, 'block').height > 32,
      `an inline block's line: ${boxOf(el, 'block').height}`,
    );
    assert.strictEqual(boxOf(el, 'first').height, 32, 'a first baseline');
  },
);

metric(
  'an inline flex box that clips sits on its border edge where its first line is past it',
  async () => {
    // A scroll container's baseline is clamped to its border edge (CSS Box
    // Alignment 3, 9.1), on a line as in a flex line, and where it is
    // inside an inline block too: each sat on its item's line, under it
    const { node } = await render(
      '<style>body{margin:0;font:16px/20px sans-serif}' +
        '.clip{display:inline-flex;overflow:hidden;height:6px}</style>' +
        '<div id="flex">x<span id="f" class="clip"><span>y</span></span></div>' +
        '<div id="inside">x<span id="i" style="display:inline-block">' +
        '<span class="clip" style="display:flex">y</span></span></div>',
    );
    const el = view(node);
    for (const [p, id] of [
      ['flex', 'f'],
      ['inside', 'i'],
    ]) {
      const [line] = linesOf(el, p);
      const box = boxOf(el, id);
      assert.ok(
        Math.abs(box.y + box.height - (line.y + line.baseline)) < 0.01,
        `${id}: ${box.y + box.height}, ${line.y + line.baseline}`,
      );
    }
  },
);

test("a flex item's intrinsic minimum wins over a smaller maximum", async () => {
  // `min-width: max-content` beside a `max-width` under it: the minimum is
  // the strongest limit (CSS Sizing 3, 3.1), and the item is as wide as
  // its content. The flex layout made it so, and laying it out at that
  // width cut it to the maximum again, where a minimum that is a length
  // would have held: a random line against Chrome found 37 lines in 1,500
  const block = '<div style="width:119px;height:6px"></div>';
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;width:313.822px">' +
      '<div id="row" style="height:6px;min-width:max-content;' +
      'max-width:23.356%;flex-grow:1.361;flex-shrink:0.465;' +
      `padding-left:22px;margin-left:auto">${block}</div></div>` +
      // across a column, stretched
      '<div style="display:flex;flex-direction:column;width:300px">' +
      '<div id="column" style="height:6px;min-width:max-content;' +
      `max-width:20px;padding-left:22px">${block}</div></div>` +
      // and in a flex box as wide as its items, whose layout measures the
      // item for its content's width after it has laid it out at its
      // minimum: measured, it was left laid out at no width at all
      '<div style="display:inline-flex"><div id="inline" ' +
      'style="min-width:min-content;max-width:20px;padding-left:22px">' +
      '<div style="width:30px;height:6px"></div></div></div>',
    400,
  );
  const el = view(node);
  const row = boxOf(el, 'row');
  assert.ok(Math.abs(row.width - 141) < 0.01, `along a row: ${row.width}`);
  assert.ok(
    Math.abs(row.x - (313.822 - 141)) < 0.01,
    `at the end of it, its auto margin taking what is left: ${row.x}`,
  );
  assert.strictEqual(boxOf(el, 'column').width, 141, 'across a column');
  assert.strictEqual(boxOf(el, 'inline').width, 52, 'in an inline flex box');
});

test("a flex item's border-box limits under its padding and borders leave it as wide as them", async () => {
  // A `border-box` length less than the padding and borders leaves the
  // content box none wide, and not less (CSS Sizing 3, 3.3): Yoga made
  // each of these as wide as its padding and borders, and laying the item
  // out within its limits cut it narrower than them. And sharing out the
  // line, Yoga took the first for as wide as its maximum, and the `auto`
  // margins after it took the 2.33px between — a line from the random
  // differential against Chrome, whole
  const { node } = await render(
    '<style>body{margin:0}.row{display:flex;width:300px}' +
      '.row>div{height:6px;box-sizing:border-box}' +
      '.line{display:flex;width:227px}.line>div{height:6px}</style>' +
      '<div class="line"><div id="a" style="width:138px;' +
      'max-width:20.668px;flex-grow:1;padding-right:19px;' +
      'border-left:4px solid;box-sizing:border-box"></div>' +
      '<div id="a1" style="width:103.812px;flex-basis:203.65px;' +
      'min-width:58.736px;padding-right:1.72px;margin-left:auto;' +
      'margin-right:5.31px"></div>' +
      '<div style="width:238px;flex-basis:58px;min-width:0;' +
      'max-width:154.247px;margin-left:auto">' +
      '<div style="width:228px;height:6px"></div></div>' +
      '<div id="a3" style="width:134px;flex-basis:content;' +
      'max-width:29.528%;box-sizing:border-box">' +
      '<div style="width:81px;height:6px"></div></div></div>' +
      // the rest of the line is what is left of it
      '<div class="row"><div id="b" style="flex:1;min-width:0;' +
      'max-width:10px;padding-left:22px;border-right:3px solid"></div>' +
      '<div id="c" style="flex:1"></div></div>' +
      // and a minimum over the maximum is under them too
      '<div class="row"><div id="d" style="min-width:20px;max-width:10px;' +
      'padding-left:22px"></div></div>',
    400,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').width, 23, 'its padding and border');
  assert.strictEqual(boxOf(el, 'a1').x, 23, 'the line over-full after it');
  const last = boxOf(el, 'a3');
  assert.ok(
    Math.abs(last.x + last.width - 227) < 0.01,
    `and its end at the line's: ${last.x + last.width}`,
  );
  assert.strictEqual(
    boxOf(el, 'b').width,
    25,
    'flexed, its padding and border',
  );
  assert.strictEqual(boxOf(el, 'c').x, 25, 'the next after them');
  assert.strictEqual(boxOf(el, 'c').width, 275, 'with the rest of the line');
  assert.strictEqual(boxOf(el, 'd').width, 22, 'over its minimum');
});

test('a flex item measured for its content after it was laid out is laid out again', async () => {
  // Measuring an item's max-content width lays it out with no limit on
  // its width. Where Yoga had already asked for the item at the width the
  // flex layout then gave it, the item kept the measurement's layout: a
  // `min-width` holding it wider than a line too short for it, which 9.7
  // shares out (`resolveLine`), left it infinitely wide
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;width:100px">' +
      '<div style="flex-shrink:0;width:80px;height:6px"></div>' +
      '<div id="a" style="flex-shrink:2;flex-grow:1;min-width:121px">' +
      '<div style="width:48px;height:6px"></div></div></div>',
  );
  const a = boxOf(view(node), 'a');
  assert.strictEqual(a.width, 121, 'its minimum');
  assert.strictEqual(a.x, 80, 'after the first');
});
