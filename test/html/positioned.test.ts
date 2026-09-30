// <Html> — positioned boxes, stacking and translation.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import {
  boxOf,
  clipsAround,
  fillsOf,
  linesOf,
  metric,
  render,
  view,
} from './harness.js';
import type { LaidBox, PaintOp } from './harness.js';

afterEach(cleanup);

metric(
  'a negative z-index is painted under the flow of its stacking context',
  async () => {
    // CSS 2.1 Appendix E: over the context's background, under all else in
    // it; a parent that is no stacking context does not hold it
    const { node } = await render(
      '<div style="background:#0000ff;height:20px">' +
        '<div style="position:absolute;z-index:-1;width:10px;height:10px;' +
        'background:#ff0000"></div></div>' +
        '<div style="position:relative;z-index:0;background:#00ffff">' +
        '<div style="position:absolute;z-index:-1;width:10px;height:10px;' +
        'background:#ff00ff"></div><div style="height:20px;' +
        'background:#00ff00"></div></div>',
    );
    const order = (await fillsOf(view(node))).map((f) => f.style);
    const at = (color: string) => order.indexOf(parseColor(color));
    assert.ok(
      at('#ff0000') < at('#0000ff'),
      'under a parent that is no context',
    );
    assert.ok(
      at('#00ffff') < at('#ff00ff') && at('#ff00ff') < at('#00ff00'),
      "over its context's background, under its flow",
    );
  },
);

metric(
  'an absolute box between two offsets shares what is left with its auto margins, or fills it',
  async () => {
    // CSS 2.1 10.3.7 and 10.6.4
    const { node } = await render(
      '<div id="c" style="position:relative;width:300px;height:100px">' +
        '<div id="a" style="position:absolute;left:0;right:0;width:100px;' +
        'height:10px;margin:0 auto"></div>' +
        '<div id="b" style="position:absolute;top:10px;bottom:20px;' +
        'left:0;width:10px"></div>' +
        '<div id="m" style="position:absolute;top:0;bottom:0;height:20px;' +
        'left:0;width:10px;margin:auto 0"></div></div>',
    );
    const el = view(node);
    const [c, a, b, m] = ['c', 'a', 'b', 'm'].map((id) => boxOf(el, id));
    assert.strictEqual(a.x - c.x, 100, 'centred between left and right');
    assert.strictEqual(b.height, 70, 'as tall as top and bottom leave it');
    assert.strictEqual(m.y - c.y, 40, 'centred between top and bottom');
  },
);

metric(
  'an absolute box with auto offsets is where the flow put it',
  async () => {
    // CSS 2.1 10.3.7 and 10.6.4: with neither `left` nor `right`, and neither
    // `top` nor `bottom`, the box takes its static position — where it would
    // have been in the flow — not its containing block's corner
    const { node } = await render(
      '<div id="c" style="padding:10px;margin:0 20px">' +
        '<p id="p" style="margin:0;height:30px">x</p>' +
        '<div id="a" style="position:absolute;width:5px;height:5px"></div>' +
        '<div id="b" style="position:absolute;top:0;width:5px;height:5px">' +
        '</div></div>',
    );
    const el = view(node);
    const [c, p, a, b] = ['c', 'p', 'a', 'b'].map((id) => boxOf(el, id));
    assert.deepStrictEqual([a.x, a.y], [c.x + 10, p.y + p.height]);
    assert.strictEqual(b.x, c.x + 10, 'one axis at a time');
    assert.strictEqual(b.y, 0);
  },
);

metric(
  'an absolute box after text is under its line, or after it on the line',
  async () => {
    // The static position among a paragraph's text (CSS 2.1 10.3.7,
    // 10.6.4): a block-level box would have broken the line, so it goes
    // under it, and an inline-level one goes where the text left the pen.
    // Both went at the paragraph's top, over its text. The second is in a
    // padded span, whose paragraph is laid out another way.
    const { node } = await render(
      '<style>body{margin:0} div{line-height:20px}</style>' +
        '<div id="p">Some text<div id="a" style="position:absolute;' +
        'width:5px;height:5px"></div></div>' +
        '<div id="q">Some <span style="padding-left:4px">text<span id="b" ' +
        'style="position:absolute;width:5px;height:5px"></span></span></div>',
    );
    const el = view(node);
    const [p, a, q, b] = ['p', 'a', 'q', 'b'].map((id) => boxOf(el, id));
    assert.deepStrictEqual([a.x, a.y], [p.x, p.y + 20], 'under the line');
    const [line] = linesOf(el, 'q');
    assert.strictEqual(b.y, q.y, 'on the line');
    const end = line.x + line.width;
    assert.ok(Math.abs(b.x - end) < 1, `after the text: ${b.x}, ${end}`);
  },
);

metric(
  "an inline box's border before an absolute box is its line's content",
  async () => {
    // CSS 2.1 9.4.2: a line with nothing on it but white space is no line,
    // and one with an inline box's margin or border on it is one, even
    // where the two add up to no width; a block-level absolute box after
    // the first goes at its top, and after the second under it
    const { node } = await render(
      '<style>body{margin:0} div{line-height:20px}</style>' +
        '<div id="p"><span> <div id="a" style="position:absolute;' +
        'width:5px;height:5px"></div></span></div>' +
        '<div id="q"><span style="border-left:10px solid;margin-left:-10px">' +
        '<div id="b" style="position:absolute;width:5px;height:5px"></div>' +
        '</span></div>',
    );
    const el = view(node);
    const [p, a, q, b] = ['p', 'a', 'q', 'b'].map((id) => boxOf(el, id));
    assert.strictEqual(a.y, p.y, 'at the top');
    assert.strictEqual(b.y, q.y + 20, 'under the line');
  },
);

metric(
  'an absolute box in a positioned inline box is placed against it',
  async () => {
    // CSS 2.1 10.1, item 4: a `position: relative` inline box is the
    // containing block of what is absolute in it, from the padding edge its
    // first fragment starts at. Read as a box that lays itself out, it was
    // a rectangle of no size at the page's corner, and a tooltip under its
    // link came up there.
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<p id="p" style="margin:0 0 0 30px;line-height:20px">Hover ' +
        '<a id="l" style="position:relative;padding-left:4px">here<span ' +
        'id="t" style="position:absolute;left:0;top:100%;width:10px;' +
        'height:10px"></span></a></p>',
    );
    const el = view(node);
    const [p, t] = ['p', 't'].map((id) => boxOf(el, id));
    const [line] = linesOf(el, 'p');
    // the link's, the one inline box on the line
    const start = line.edges!.find((e) => e.side === 'start')!;
    assert.strictEqual(t.x, start.x, "at the link's padding edge");
    assert.ok(t.x > p.x, 'not at the corner');
    assert.ok(t.y > p.y && t.y <= p.y + 20, `under its text: ${t.y}`);
  },
);

metric('a relative box after an absolute one is painted over it', async () => {
  // both are positioned, and CSS paints positioned boxes in document order
  // after the flow (CSS 2.1 Appendix E); the relative one was painted with
  // the flow, under the absolute one
  const { node } = await render(
    '<div style="position:absolute;width:30px;height:30px;' +
      'background:#ff0000"></div>' +
      '<div style="position:relative;width:30px;height:30px;' +
      'background:#00ff00"></div><div style="height:10px;' +
      'background:#0000ff"></div>',
  );
  const fills = await fillsOf(view(node));
  const order = (color: string) =>
    fills.findIndex((f) => f.style === parseColor(color));
  assert.ok(order('#0000ff') < order('#ff0000'), 'the flow first');
  assert.ok(order('#ff0000') < order('#00ff00'), 'then in document order');
});

metric(
  'a positioned box in a box painted whole is painted with the others',
  async () => {
    // CSS 2.1 Appendix E: a stacking context paints every positioned box
    // in it after its flow, in document order, then by `z-index`, whatever
    // box it is in. One in an `overflow: hidden` box was painted with that
    // box, among the flow, and so under a positioned box before it; and a
    // menu with a `z-index` in a positioned header went under positioned
    // content after the header.
    const { node } = await render(
      '<div style="position:absolute;width:30px;height:30px;' +
        'background:#ff0000"></div>' +
        '<div style="overflow:hidden;width:30px;height:30px">' +
        '<div style="position:absolute;width:30px;height:30px;' +
        'background:#00ff00"></div></div>' +
        '<div style="position:relative;height:20px">' +
        '<div style="position:absolute;z-index:1;top:10px;width:30px;' +
        'height:40px;background:#0000ff"></div></div>' +
        '<div style="position:relative;height:40px;background:#ffff00"></div>',
    );
    const fills = await fillsOf(view(node));
    const order = (color: string) =>
      fills.findIndex((f) => f.style === parseColor(color));
    assert.ok(order('#ff0000') < order('#00ff00'), 'in document order');
    assert.ok(order('#ffff00') < order('#0000ff'), 'the z-index over it');
  },
);

metric(
  'a fixed box is a stacking context, and a box below its flow is not drawn over it',
  async () => {
    // CSS Positioned Layout 3: a fixed box is a stacking context with no
    // `z-index`, so a box in it set to `-1` goes over its background, not
    // behind the page. And a box set below the flow on a line, an
    // inline-block's canvas, is its stacking context's to draw there, and
    // was drawn by its line as well, over the box it was under.
    const { node } = await render(
      '<div style="position:fixed;left:0;top:0;width:30px;height:30px;' +
        'background:#ff0000"><div style="position:absolute;z-index:-1;' +
        'width:30px;height:30px;background:#00ff00"></div></div>' +
        '<div style="display:inline-block;width:40px;height:40px;' +
        'background:#0000ff"><canvas width="4" height="4" style="height:100%;' +
        'position:relative;z-index:-1;background:#ffff00"></canvas></div>',
    );
    const fills = await fillsOf(view(node));
    const at = (color: string) =>
      fills.findIndex((f) => f.style === parseColor(color));
    assert.ok(at('#ff0000') < at('#00ff00'), 'over the fixed box');
    const yellow = fills.filter((f) => f.style === parseColor('#ffff00'));
    assert.strictEqual(yellow.length, 1, 'drawn once');
    assert.ok(at('#ffff00') < at('#0000ff'), 'under the inline-block');
  },
);

metric(
  'a positioned box its stacking context paints is clipped where it is',
  async () => {
    // painted after the flow, apart from the boxes around it, an absolute
    // box is still under the clip of a box its containing block is in, and
    // a relative one under every one it is in
    const { node } = await render(
      '<div id="o" style="position:relative;overflow:hidden;width:20px;' +
        'height:20px"><div style="position:absolute;left:10px;width:40px;' +
        'height:40px;background:#00ff00"></div></div>' +
        '<div id="p" style="overflow:hidden;width:20px;height:20px">' +
        '<div style="position:relative;left:10px;width:40px;height:40px;' +
        'background:#0000ff"></div></div>',
    );
    const el = view(node);
    const [o, p] = ['o', 'p'].map((id) => boxOf(el, id));
    const ops: PaintOp[] = [];
    await fillsOf(el, ops);
    const rect = (c: PaintOp) => c.op === 'clip' && [c.x, c.y, c.w, c.h];
    const [green] = clipsAround(ops, '#00ff00');
    assert.deepStrictEqual(green.map(rect), [
      [Math.round(o.x), Math.round(o.y), 20, 20],
    ]);
    const [blue] = clipsAround(ops, '#0000ff');
    assert.deepStrictEqual(blue.map(rect), [
      [Math.round(p.x), Math.round(p.y), 20, 20],
    ]);
  },
);

metric('clip shows the part of an absolute box it names', async () => {
  const { node } = await render(
    '<div id="a" style="position:absolute;top:0;left:0;width:40px;' +
      'height:40px;background:#ff0000;clip:rect(5px, 25px, auto, 5px)"></div>' +
      '<div style="position:absolute;width:40px;height:40px;' +
      'background:#00ff00;clip:rect(0, 0, 0, 0)"></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  const ops: PaintOp[] = [];
  const fills = await fillsOf(el, ops);
  const [red] = clipsAround(ops, '#ff0000');
  assert.deepStrictEqual(
    red.map((c) => c.op === 'clip' && [c.x, c.y, c.w, c.h]),
    [[a.x + 5, a.y + 5, 20, 35]],
    "its background too, and `auto` is the border box's edge",
  );
  assert.ok(
    !fills.some((f) => f.style === parseColor('#00ff00')),
    'an empty clip shows nothing',
  );
});

test('an absolute box a max-width or max-height holds is centred by its auto margins', async () => {
  // CSS 2.1 10.4 and 10.7: with both offsets and an auto size, the box
  // fills what they leave — but a `max-width` or `max-height` that holds
  // it back makes a size like one set, and the rules run again with it,
  // where auto margins share what is left; it stayed at its start edge,
  // and at first did not take the `max-width` at all
  const { node } = await render(
    '<div style="position:relative;width:300px;height:200px">' +
      '<div id="a" style="position:absolute;left:0;right:0;top:0;bottom:0;' +
      'margin:auto;max-width:100px;max-height:50px"></div></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  const parent = (a as LaidBox & { parent: LaidBox }).parent;
  assert.deepStrictEqual(
    [a.width, a.height, a.x - parent.x, a.y - parent.y],
    [100, 50, 100, 75],
  );
});

test('an absolute form control with both offsets on an axis fills what they leave', async () => {
  // A form control is an inline block to CSS, whatever draws it (HTML's
  // rendering section), and Chrome sizes one positioned with both offsets
  // as it sizes any box (CSS 2.1 10.3.7, 10.6.4): to what they leave. It
  // was sized as a replaced element here, at its intrinsic size — so the
  // invisible `<select class="absolute inset-0 opacity-0">` a page lays
  // over a picker it draws, to take the press, covered only a corner of
  // it: nextjs.org's language switchers.
  const { node } = await render(
    '<style>body{margin:0}.w{position:relative;width:200px;height:40px}' +
      '.w>*{position:absolute;inset:0;margin:0}</style>' +
      '<div class="w"><select id="select"><option>One</option></select></div>' +
      '<div class="w"><input id="text"></div>' +
      '<div class="w"><textarea id="area"></textarea></div>' +
      '<div class="w"><input id="submit" type="submit" value="Go"></div>' +
      '<div class="w"><input id="check" type="checkbox" style="margin:3px">' +
      '</div>' +
      // a limit makes it a size like one set, and auto margins share the
      // rest (10.4)
      '<div class="w"><input id="held" style="max-width:100px;' +
      'box-sizing:border-box;margin:auto"></div>' +
      // one offset is no pair of them: the control's own size across
      '<div class="w"><input id="start" style="right:auto"></div>' +
      '<div><input id="plain" style="margin:0"></div>' +
      // and a replaced element keeps its own size (10.3.8, 10.6.5)
      '<div class="w"><img id="img" width="10" height="10"></div>',
  );
  const el = view(node);
  const rect = (id: string) => {
    const box = boxOf(el, id);
    const parent = (box as LaidBox & { parent: LaidBox }).parent;
    return [box.x - parent.x, box.y - parent.y, box.width, box.height];
  };
  for (const id of ['select', 'text', 'area', 'submit']) {
    assert.deepStrictEqual(rect(id), [0, 0, 200, 40], id);
  }
  assert.deepStrictEqual(rect('check'), [3, 3, 194, 34], 'inside its margins');
  assert.deepStrictEqual(rect('held'), [50, 0, 100, 40], 'held and centred');
  assert.deepStrictEqual(
    rect('start'),
    [0, 0, boxOf(el, 'plain').width, 40],
    'its own width, and the height its offsets leave',
  );
  assert.deepStrictEqual(rect('img'), [0, 0, 10, 10], 'an image is its size');
});

test('translate and the translation in a transform are read', async () => {
  const { node } = await render(
    '<div id="a" style="translate:10px 20%"></div>' +
      '<div id="b" style="translate:5px"></div>' +
      '<div id="c" style="translate:5px;translate:none"></div>' +
      '<div id="d" style="translate:1px 2px 3px"></div>' +
      '<div id="e" style="translate:4px;translate:1px 2px 3%"></div>' +
      '<div id="f" style="transform:translate(-50%, -50%)"></div>' +
      '<div id="g" style="transform:translateX(10px) translateY(5px) ' +
      'rotate(45deg) translate(1px, 1px)"></div>' +
      '<div id="h" style="transform:rotate(0) scale(1.5)"></div>' +
      '<div id="i" style="transform:matrix(1, 0, 0, 1, 10, 20)"></div>' +
      '<div id="j" style="transform:none"></div>' +
      '<div id="k" style="transform:translateX(3px);transform:wobble(1px)"></div>' +
      '<div id="l" style="--x:calc(calc(1/2 * 100%) * -1);' +
      'translate:var(--x) 0"></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { translate: unknown; transformTranslate: unknown };
      }
    ).style;
  assert.deepStrictEqual(style('a').translate, [10, { pct: 20 }]);
  assert.deepStrictEqual(style('b').translate, [5, 0]);
  assert.strictEqual(style('c').translate, null);
  assert.deepStrictEqual(style('d').translate, [1, 2], 'a depth is dropped');
  assert.deepStrictEqual(style('e').translate, [4, 0], 'a depth is a length');
  assert.deepStrictEqual(style('f').transformTranslate, [
    { pct: -50 },
    { pct: -50 },
  ]);
  assert.deepStrictEqual(style('g').transformTranslate, [11, 6]);
  assert.deepStrictEqual(
    style('h').transformTranslate,
    [0, 0],
    'rotating and scaling are read and not drawn',
  );
  assert.deepStrictEqual(style('i').transformTranslate, [10, 20]);
  assert.strictEqual(style('j').transformTranslate, null);
  assert.deepStrictEqual(style('k').transformTranslate, [3, 0]);
  assert.deepStrictEqual(style('l').translate, [{ pct: -50, px: 0 }, 0]);
});

test('a translated box is moved by a share of its own size', async () => {
  // `absolute left-1/2 -translate-x-1/2` and `translate(-50%, -50%)` were
  // dropped, and what they centre hung off to the right by half its width
  const { node } = await render(
    '<style>body{margin:0}.f{position:relative;width:300px;height:100px}' +
      '.c{position:absolute;width:80px;height:20px}</style>' +
      '<div class="f"><div id="a" class="c" style="top:50%;left:50%;' +
      'transform:translate(-50%, -50%)"></div>' +
      '<div id="b" class="c" style="top:0;left:50%;' +
      'translate:calc(calc(1/2 * 100%) * -1) 0"></div></div>' +
      '<div id="n" style="translate:10px 5px;height:10px"></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  assert.deepStrictEqual([a.x, a.y], [110, 40], 'centred');
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([b.x, b.y], [110, 0]);
  const n = boxOf(el, 'n');
  assert.deepStrictEqual([n.x, n.y], [10, 105], 'after where it was laid out');
});

test('a transformed box holds the absolute boxes inside it', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div style="height:50px"></div>' +
      '<div style="transform:translate(0, 0);height:40px">' +
      '<div id="a" style="position:absolute;top:0;left:10px;width:5px;' +
      'height:5px"></div></div>',
  );
  const a = boxOf(view(node), 'a');
  assert.deepStrictEqual([a.x, a.y], [10, 50], 'against it, not the page');
});

test('a translated block is painted over the flow after it', async () => {
  const { node } = await render(
    '<style>body{margin:0}div{height:20px}</style>' +
      '<div style="translate:0 10px;background:#ff0000"></div>' +
      '<div style="background:#0000ff"></div>',
  );
  const fills = await fillsOf(view(node));
  const order = fills
    .map((f) => f.style)
    .filter((c) => c === '#ff0000' || c === '#0000ff');
  assert.deepStrictEqual(order, ['#0000ff', '#ff0000']);
});

metric(
  'an absolute box with both offsets and an intrinsic width is centred by its margins',
  async () => {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="position:relative;width:400px;height:40px">' +
        '<div id="pop" style="position:absolute;left:0;right:0;margin:0 auto;' +
        'width:fit-content">A tooltip</div></div>',
    );
    const pop = boxOf(view(node), 'pop');
    assert.ok(pop.width < 200, `${pop.width}: not stretched`);
    assert.strictEqual(pop.x, (400 - pop.width) / 2);
  },
);

test('a sticky box is where a browser starts it, not moved by its insets', async () => {
  // Taken as `position: relative`, a sticky box was moved by its `top`
  // wherever it started: Wikipedia's contents, `top: 24px` well below the
  // top of the page, stood 24px lower than a browser draws it. At rest —
  // nothing here scrolls a box in the document, and the viewport starts at
  // the top — a box moves only as far as keeps it inside its scroll
  // container's scrollport less its insets, and inside its containing block
  const { node } = await render(
    '<style>body{margin:0}div{height:20px}.s{position:sticky}' +
      '.port{overflow:auto;height:50px}</style>' +
      '<div id="first" class="s" style="top:10px"></div>' +
      '<div style="height:100px"></div>' +
      '<div id="below" class="s" style="top:24px"></div>' +
      '<div class="port" style="border:3px solid"><div style="height:200px">' +
      '</div><div id="foot" class="s" style="bottom:0"></div></div>' +
      '<div class="port" style="height:40px"><div style="height:25px">' +
      '<div id="lim" class="s" style="top:30px;height:10px"></div></div>' +
      '<div style="height:200px"></div></div>',
  );
  const el = view(node);
  // within 10px of the top: moved down to it
  assert.strictEqual(boxOf(el, 'first').y, 10);
  // past it: where the flow put it
  assert.strictEqual(boxOf(el, 'below').y, 120);
  // at the foot of a scroller's content, up to the foot of its scrollport,
  // inside the border: 140 + 3 + 50 - 20
  assert.strictEqual(boxOf(el, 'foot').y, 173);
  // no further down than its containing block lets it: 196 + 25 - 10,
  // short of the 196 + 30 its `top` asks for
  assert.strictEqual(boxOf(el, 'lim').y, 211);
});
