// <Html> — flex layout.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, waitFor } from 'react-x11/test';
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
