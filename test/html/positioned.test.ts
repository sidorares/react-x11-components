// <Html> — positioned boxes, stacking and translation.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, pixelAt } from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import {
  boxOf,
  clipsAround,
  fillsOf,
  linesOf,
  metric,
  pathsOf,
  render,
  render2x,
  view,
  windingAt,
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
  'an absolute box that was inline-level is on a line of its own among blocks',
  async () => {
    // Among block siblings, a box that was `display: inline` before it was
    // positioned would have been in a line of its own: beside the floats
    // there, where the line's alignment and direction put it (CSS 2.1
    // 10.3.7, as browsers place it). It went at the block's start, under
    // the float, as a block-level one does.
    const row = (dir: string, align: string, side: string, id: string) =>
      `<div id="${id}c" style="position:relative;width:100px;direction:${dir};` +
      `text-align:${align}"><div style="height:10px"></div>` +
      `<div style="float:${side};width:40px;height:10px"></div>` +
      `<div id="${id}" style="display:inline;position:absolute;` +
      'width:10px;height:10px"></div></div>';
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        row('ltr', 'left', 'left', 'a') +
        row('ltr', 'center', 'left', 'b') +
        row('rtl', 'start', 'right', 'c') +
        row('ltr', 'right', 'right', 'd') +
        '<div id="ec" style="position:relative;width:100px"><div style="float:left;' +
        'width:40px;height:10px"></div><div id="e" style="position:absolute;' +
        'width:10px;height:10px"></div></div>',
    );
    const el = view(node);
    const x = (id: string) => boxOf(el, id).x - boxOf(el, `${id}c`).x;
    assert.strictEqual(x('a'), 40, 'after a left float');
    assert.strictEqual(x('b'), 70, 'from the middle of the room');
    // right to left, the box's right edge is at the point
    assert.strictEqual(x('c'), 50, 'before a right float, from the right');
    assert.strictEqual(x('d'), 60, 'the end of the room');
    assert.strictEqual(x('e'), 0, 'a block-level one at the start');
    assert.strictEqual(boxOf(el, 'a').y - boxOf(el, 'ac').y, 10, 'under');
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
  'a stacking context that is not positioned is painted and hit with the positioned boxes',
  async () => {
    // CSS 2.1 Appendix E, step 8, and CSS Color 4, 3.2: a box made a
    // stacking context by anything but a position is painted in the layer
    // of the positioned boxes with a `z-index` of 0, in the document's
    // order among them — a block, a float, a flex item and an inline-block
    // alike, as Chrome, Firefox and Safari paint and hit-test it. Painted
    // whole in its place instead, it went under the text of a block after
    // it that a negative margin drew up over it, and under a relative box
    // before it; and the hit test, which took it for a plain block of the
    // flow, found the box after it under the pointer where it was drawn.
    // Painted by its line, an inline-block went under the text after it.
    const doc = (makes: string) =>
      '<style>body{margin:0}section{height:60px}' +
      `.a{height:40px;background:#ff0000;${makes}}` +
      '.s{background:#00ff00}.r{position:relative;height:40px;' +
      'background:#0000ff}.f{display:flex}.f>div{flex:none;width:100px;' +
      'height:40px}</style>' +
      // the text of a block after it
      '<section><div class="a" id="a1"></div><div style="margin-top:-20px">' +
      '<span class="s" id="s1">xxxx</span></div></section>' +
      // a relative box before it
      '<section><div class="r" id="r2"></div>' +
      '<div class="a" id="a2" style="margin-top:-20px"></div></section>' +
      // a float, over the text beside it
      '<section><div class="a" id="a3" style="float:left;width:100px;' +
      'margin-right:-100px"></div><div><span class="s" id="s3">xxxx</span>' +
      '</div></section>' +
      // a flex item, over the one after it
      '<section class="f"><div class="a" id="a4" style="margin-right:-50px">' +
      '</div><div id="b4" style="background:#0000ff"></div></section>' +
      // an inline-block, over the text after it on its line
      '<section><span class="a" id="a5" style="display:inline-block;' +
      'vertical-align:top;width:100px;margin-right:-100px"></span>' +
      '<span class="s" id="s5">xxxx</span></section>' +
      // and over the text of a block after it
      '<section><div><span class="a" id="a6" style="display:inline-block;' +
      'vertical-align:top;width:100px"></span></div>' +
      '<div style="margin-top:-20px"><span class="s" id="s6">xxxx</span>' +
      '</div></section>';
    const points: [number, number, string, string][] = [
      [10, 30, 'a1', 's1'],
      [50, 90, 'a2', 'r2'],
      [10, 130, 'a3', 's3'],
      [75, 200, 'a4', 'b4'],
      [10, 250, 'a5', 's5'],
      [10, 330, 'a6', 's6'],
    ];
    for (const makes of [
      'opacity:.99',
      'contain:paint',
      'isolation:isolate',
      'clip-path:inset(0)',
      'mask-image:linear-gradient(#000,#000)',
      'transform:translateX(0)',
      '',
    ]) {
      const { node, result } = await render(doc(makes));
      const el = view(node);
      const { abs } = el as unknown as { abs: { x: number; y: number } };
      for (const [x, y, over, under] of points) {
        const want = makes ? over : under;
        const [r, g, b] = await pixelAt(result.ctx, abs.x + x, abs.y + y);
        assert.strictEqual(
          r > 200 && g < 100 && b < 100,
          want === over,
          `${makes || 'none'}: ${over} drawn at ${x},${y}: ${r},${g},${b}`,
        );
        assert.strictEqual(
          el.elementAtPoint(abs.x + x, abs.y + y)?.attribs.id,
          want,
          `${makes || 'none'}: under the pointer at ${x},${y}`,
        );
      }
    }
  },
);

metric(
  'a positioned inline-block is painted and hit with the positioned boxes',
  async () => {
    // CSS 2.1 Appendix E, step 8: a positioned box is painted after the
    // flow, by its stacking context, in `z-index` order and then the
    // document's — an inline-block as much as a block, as Chrome, Firefox
    // and Safari paint and hit-test it. Painted by its line, it went under
    // the text after it, under a relative box before it, and the hit test
    // found one set below its block's background over it.
    const { node, result } = await render(
      '<style>body{margin:0;font:20px/20px monospace}section{height:60px}' +
        '.a{display:inline-block;vertical-align:top;width:100px;' +
        'height:20px;position:relative;background:#ff0000}' +
        '.s{background:#00ff00;color:transparent}' +
        '.b{background:#0000ff;height:20px}</style>' +
        // the text after it on its line
        '<section><span class="a" id="a1" style="margin-right:-100px">' +
        '</span><span class="s" id="s1">xxxx</span></section>' +
        // a relative box before it
        '<section><div class="b" id="r2" style="position:relative"></div>' +
        '<div><span class="a" id="a2" style="margin-top:-10px"></span>' +
        '</div></section>' +
        // its block's background, which one set below the flow is under
        '<section><div class="b" id="b3" style="height:40px">' +
        '<span class="a" id="a3" style="z-index:-1"></span></div></section>' +
        // a z-index of 2, over a box after it with 1
        '<section><div><span class="a" id="a4" style="z-index:2;' +
        'height:40px"></span></div><div class="b" id="b4" style="' +
        'position:relative;z-index:1;margin-top:-20px"></div></section>' +
        // in a float, over the text beside the float
        '<section><div style="float:left;width:100px;margin-right:-100px">' +
        '<span class="a" id="a5"></span></div><div>' +
        '<span class="s" id="s5">xxxx</span></div></section>' +
        // in an inline box with a z-index, which paints it, over the text
        // after it there
        '<section><span style="position:relative;z-index:1">' +
        '<span class="a" id="a6" style="margin-right:-100px"></span>' +
        '<span class="s" id="s6">xxxx</span></span></section>',
    );
    const el = view(node);
    const { abs } = el as unknown as { abs: { x: number; y: number } };
    for (const [x, y, want] of [
      [10, 10, 'a1'],
      [10, 75, 'a2'],
      [10, 130, 'b3'],
      [10, 210, 'a4'],
      [10, 250, 'a5'],
      [10, 310, 'a6'],
    ] as const) {
      const [r, g, b] = await pixelAt(result.ctx, abs.x + x, abs.y + y);
      assert.strictEqual(
        r > 200 && g < 100 && b < 100,
        want.startsWith('a'),
        `drawn at ${x},${y}: ${r},${g},${b}`,
      );
      assert.strictEqual(
        el.elementAtPoint(abs.x + x, abs.y + y)?.attribs.id,
        want,
        `under the pointer at ${x},${y}`,
      );
    }
  },
);

metric(
  'a box painted with the positioned ones is hit among its stacking context’s, in their order',
  async () => {
    // What is under a point is what was painted there last, and a box
    // painted with the positioned ones is painted by its stacking context,
    // ordered by `z-index` and then the document, however deep it is in a
    // box that is no stacking context (`gatherLayers`) — each of these
    // found the other box, where paint drew this one over it. And a
    // stacking context's own box is under what it paints below its flow.
    const { node } = await render(
      // a whole document, whose root element is a box of its own
      '<html><head><style>html{height:400px}body{margin:0}' +
        'section{height:60px}' +
        '.r{position:relative;height:40px;background:#ff0000}' +
        '.q{position:relative;height:40px;width:60px;background:#ffff00}' +
        '.m{position:relative;height:40px;margin-top:-20px;' +
        'background:#0000ff}</style></head><body>' +
        // a z-index of 5 in a relative box with none, over a 3 after it
        '<section><div class="r"><div class="q" id="q1" style="z-index:5">' +
        '</div></div><div class="m" id="m1" style="z-index:3"></div>' +
        '</section>' +
        // and with none, under a relative box after it
        '<section><div class="r"><div class="q" id="q2"></div></div>' +
        '<div class="m" id="m2"></div></section>' +
        // a relative box in a float, over the text beside the float
        '<section><div style="float:left;width:100px;margin-right:-100px">' +
        '<div class="q" id="q3"></div></div><div>' +
        '<span style="background:#00ff00">xxxx</span></div></section>' +
        // in a translucent box: its box set below its flow over it, and
        // under the block in its flow
        '<section><div id="a4" style="opacity:.99;height:40px;' +
        'background:#ff0000"><div id="n4" style="position:relative;' +
        'z-index:-1;width:80px;height:40px;margin-bottom:-40px;' +
        'background:#00ff00"></div><div id="c4" style="width:40px;' +
        'height:20px;background:#0000ff"></div></div></section>' +
        // a float over the text of the float before it
        '<section><div style="float:left;width:100px;height:40px">' +
        '<span style="background:#00ff00">xxxx</span></div>' +
        '<div id="f5" style="float:left;width:100px;height:40px;' +
        'margin-left:-90px;background:#0000ff"></div></section>' +
        // below the body, a box set below the root's flow over the root
        '<div id="n6" style="position:absolute;top:320px;left:0;' +
        'z-index:-1;width:50px;height:30px;background:#00ff00"></div>' +
        '</body></html>',
    );
    const el = view(node);
    const { abs } = el as unknown as { abs: { x: number; y: number } };
    const at = (x: number, y: number) =>
      el.elementAtPoint(abs.x + x, abs.y + y)?.attribs.id;
    assert.strictEqual(at(30, 30), 'q1', 'its z-index is the page’s');
    assert.strictEqual(at(30, 90), 'm2', 'and the document’s order');
    assert.strictEqual(at(10, 130), 'q3', 'over the text');
    assert.strictEqual(at(60, 190), 'n4', 'over its stacking context');
    assert.strictEqual(at(20, 190), 'c4', 'under the flow');
    assert.strictEqual(at(20, 250), 'f5', 'the later float');
    assert.strictEqual(at(10, 330), 'n6', 'over the root element');
  },
);

metric(
  'the root element paints the boxes below its flow, over its own background',
  async () => {
    // CSS 2.1 Appendix E: the root element makes the root stacking
    // context, and a box with a negative `z-index` in it is painted over
    // its background and borders. It paints them itself (`hoistNegative`),
    // so it is painted whole and never as a plain block of the flow above
    // it, whose background and lines go with that flow's: taken for one,
    // the body set below the flow was never painted at all.
    const { node } = await render(
      '<html style="width:0;height:0;border:20px solid #ff0000">' +
        '<body style="border:20px solid #00ff00;margin:-20px;' +
        'position:relative;z-index:-1"></body></html>',
    );
    const fills = await fillsOf(view(node));
    const at = (color: string) =>
      fills.findIndex((f) => f.style === parseColor(color));
    assert.ok(at('#ff0000') >= 0, 'the root element’s border');
    assert.ok(at('#ff0000') < at('#00ff00'), 'and the body over it');
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
  'isolation makes a stacking context, and a box below its flow goes over its background',
  async () => {
    // CSS Compositing 1, 3.2: `isolation: isolate` makes one, positioned or
    // not, so a box in it set to -1 is over its background and under its
    // text — bun.sh fills the inside of an outline button's frame so — where
    // it went behind the page and the button was its frame's colour
    // throughout. `auto` makes none.
    const { node } = await render(
      '<a style="position:relative;isolation:isolate;display:inline-block;' +
        'padding:4px;background:#ff0000">x<span style="position:absolute;' +
        'inset:2px;z-index:-1;background:#00ff00"></span></a>' +
        '<div style="isolation:isolate;height:20px;background:#0000ff">' +
        '<div style="position:absolute;z-index:-1;width:10px;height:10px;' +
        'background:#ffff00"></div></div>' +
        '<div style="isolation:auto;height:20px;background:#00ffff">' +
        '<div style="position:absolute;z-index:-1;width:10px;height:10px;' +
        'background:#ff00ff"></div></div>',
    );
    const ops: PaintOp[] = [];
    await fillsOf(view(node), ops);
    const at = (color: string) =>
      ops.findIndex((op) => op.op === 'fill' && op.style === parseColor(color));
    const text = ops.findIndex((op) => op.op === 'text');
    assert.ok(
      at('#ff0000') < at('#00ff00') && at('#00ff00') < text,
      'over the positioned box, under its text',
    );
    assert.ok(at('#0000ff') < at('#ffff00'), 'over the block in the flow');
    assert.ok(at('#ff00ff') < at('#00ffff'), 'auto: under the block');
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

metric(
  'what a clip cuts away is not under the pointer, and what paint draws past it is',
  async () => {
    // Nothing `clip` cuts away is drawn (CSS 2.1 11.1.2), so nothing of it
    // is hit: a label hidden for a screen reader alone, the older
    // `.sr-only`'s `clip: rect(0, 0, 0, 0)`, took the hover and the press
    // of the link drawn where it lay. What is cut is what paint cuts — the
    // box, and all it holds but a fixed box where it is no stacking
    // context, which paints that one itself — so each answer here is held
    // to the clip its fill was drawn under.
    const { node } = await render(
      '<style>body{margin:0}div,i,b{position:absolute;left:0;width:200px;' +
        'height:100px}b{position:fixed;left:40px;width:100px}</style>' +
        '<a id="under" href="#u" style="display:block;width:200px;' +
        'height:400px"></a>' +
        '<div id="hidden" style="top:0;clip:rect(0,0,0,0)">' +
        '<a id="in" href="#i" style="display:block;height:50px">label</a>' +
        '</div>' +
        '<div id="part" style="top:100px;clip:rect(0,60px,auto,0)">' +
        '<i id="abs" style="top:50px;height:50px;background:#0000ff"></i>' +
        '<b id="far" style="top:100px;height:40px;background:#ff0000"></b>' +
        '</div>' +
        '<div id="layer" style="top:200px;z-index:1;' +
        'clip:rect(0,60px,auto,0)">' +
        '<b id="kept" style="top:200px;background:#00ff00"></b></div>' +
        // one that clips its overflow as well, the point outside both
        '<div id="both" style="top:300px;width:50px;overflow:hidden;' +
        'clip:rect(0,20px,auto,0)">' +
        '<b id="out" style="top:300px;background:#ffff00"></b></div>',
    );
    const el = view(node);
    const { abs } = el as unknown as { abs: { x: number; y: number } };
    const at = (x: number, y: number) =>
      el.elementAtPoint(abs.x + x, abs.y + y)?.attribs.id;
    assert.strictEqual(at(50, 25), 'under', 'past an empty clip');
    assert.strictEqual(at(50, 75), 'under', 'and past the box it cuts');
    const ops: PaintOp[] = [];
    await fillsOf(el, ops);
    const clips = (color: string) =>
      clipsAround(ops, color).map((under) =>
        under.map((c) => c.op === 'clip' && [c.x, c.y, c.w, c.h]),
      );
    const shown = [0, 100, 60, 100];
    assert.strictEqual(at(30, 120), 'part', 'in the clip, the box');
    assert.deepStrictEqual(clips('#0000ff'), [[shown]]);
    assert.strictEqual(at(30, 170), 'abs', 'and what it holds');
    assert.strictEqual(at(180, 170), 'under', 'which the clip cuts with it');
    assert.strictEqual(at(180, 120), 'under', 'as it cuts the box');
    assert.deepStrictEqual(clips('#ff0000'), [[]], 'a fixed box is let out');
    assert.strictEqual(at(120, 120), 'far', 'and is hit where it is drawn');
    assert.deepStrictEqual(
      clips('#00ff00'),
      [[[0, 200, 60, 100]]],
      'a stacking context cuts the fixed box it paints',
    );
    assert.strictEqual(at(50, 250), 'kept', 'hit in the clip');
    assert.strictEqual(at(120, 250), 'under', 'and not past it');
    assert.deepStrictEqual(clips('#ffff00'), [[]]);
    assert.strictEqual(at(120, 350), 'out', 'past a clip and an edge at once');
    assert.strictEqual(at(30, 350), 'under', 'in the edge, past the clip');
  },
);

metric(
  'a clip is measured in CSS pixels, and hit in them, at a display scale of 2',
  async () => {
    // The clip's lengths are the cascade's, device pixels, and so is the
    // box they are measured from; a pointer's point is logical. With the
    // document offset in its window, a device origin and a logical one
    // differ.
    const { node } = await render2x(
      '<style>body{margin:0}</style>' +
        '<div id="a" style="position:absolute;top:0;left:0;width:100px;' +
        'height:40px;background:#ff0000;clip:rect(0,auto,30px,50px)"></div>',
    );
    const el = view(node);
    const a = boxOf(el, 'a');
    const ops: PaintOp[] = [];
    await fillsOf(el, ops);
    const [red] = clipsAround(ops, '#ff0000');
    assert.deepStrictEqual(
      red.map((c) => c.op === 'clip' && [c.x, c.y, c.w, c.h]),
      [[a.x + 100, a.y, 100, 60]],
      'two device pixels to each of its own',
    );
    const { abs } = el as unknown as { abs: { x: number; y: number } };
    const at = (x: number, y: number) =>
      el.elementAtPoint(abs.x / 2 + x, abs.y / 2 + y)?.attribs.id;
    assert.strictEqual(at(60, 20), 'a', 'inside the clip');
    assert.notStrictEqual(at(40, 20), 'a', 'left of it');
    assert.notStrictEqual(at(60, 35), 'a', 'and under it');
  },
);

test('clip-path is read: a rectangle in a box, a box alone, and a shape not drawn', async () => {
  // CSS Masking 1, 5.1: a basic shape, a `<geometry-box>`, or both in
  // either order. The rectangles of CSS Shapes 1, 3.1 are read as they are
  // written, a percentage among their lengths having no pixels yet; a
  // shape that is neither a rectangle nor a polygon is a value, which sets
  // the property, and clips nothing; and anything else leaves the value
  // before it standing.
  const { node } = await render(
    '<style>p { clip-path: inset(1px) } #kept { clip-path: inset(1px 2px 3px 4px 5px) }' +
      ' #none { clip-path: none } #circle { -webkit-clip-path: circle(40%) }</style>' +
      '<p id="one" style="clip-path:inset(50%)"></p>' +
      '<p id="two" style="clip-path:inset(1px -2px)"></p>' +
      '<p id="round" style="clip-path:inset(0 round 4px 8px / 50%) padding-box"></p>' +
      '<p id="rect" style="clip-path:content-box rect(auto 10px 50% 0)"></p>' +
      '<p id="xywh" style="clip-path:xywh(1px 2px 30% 4px round 5px)"></p>' +
      '<p id="box" style="clip-path:fill-box"></p>' +
      '<p id="kept"></p><p id="none"></p><p id="circle"></p>' +
      '<p id="auto" style="clip-path:inset(auto)"></p>' +
      '<p id="wide" style="clip-path:xywh(0 0 -1px 0)"></p>' +
      '<p id="twice" style="clip-path:border-box inset(0) padding-box"></p>',
  );
  const el = view(node);
  const path = (id: string) =>
    (boxOf(el, id) as unknown as { style: { clipPath: unknown } }).style
      .clipPath;
  const square = {
    radii: null,
    radiiY: null,
    points: null,
    fillRule: 'nonzero',
  };
  assert.deepStrictEqual(path('one'), {
    box: 'border-box',
    shape: 'inset',
    lengths: [{ pct: 50 }, { pct: 50 }, { pct: 50 }, { pct: 50 }],
    ...square,
  });
  assert.deepStrictEqual(
    path('two'),
    { box: 'border-box', shape: 'inset', lengths: [1, -2, 1, -2], ...square },
    'one to four insets, as a margin is written, and a negative one',
  );
  assert.deepStrictEqual(
    path('round'),
    {
      box: 'padding-box',
      shape: 'inset',
      lengths: [0, 0, 0, 0],
      radii: [4, 8, 4, 8],
      radiiY: [{ pct: 50 }, { pct: 50 }, { pct: 50 }, { pct: 50 }],
      points: null,
      fillRule: 'nonzero',
    },
    'round takes what border-radius takes',
  );
  assert.deepStrictEqual(path('rect'), {
    box: 'content-box',
    shape: 'rect',
    lengths: ['auto', 10, { pct: 50 }, 0],
    ...square,
  });
  assert.deepStrictEqual(path('xywh'), {
    box: 'border-box',
    shape: 'xywh',
    lengths: [1, 2, { pct: 30 }, 4],
    radii: [5, 5, 5, 5],
    radiiY: null,
    points: null,
    fillRule: 'nonzero',
  });
  assert.deepStrictEqual(
    path('box'),
    { box: 'content-box', shape: null, lengths: [0, 0, 0, 0], ...square },
    'a box alone, an SVG one the CSS box it stands for: the box is the shape',
  );
  const inherited = {
    box: 'border-box',
    shape: 'inset',
    lengths: [1, 1, 1, 1],
    ...square,
  };
  assert.deepStrictEqual(path('kept'), inherited, 'five insets are no value');
  assert.deepStrictEqual(path('auto'), inherited, 'nor is an auto inset');
  assert.deepStrictEqual(path('wide'), inherited, 'nor a negative width');
  assert.deepStrictEqual(path('twice'), inherited, 'nor two boxes');
  assert.strictEqual(path('none'), null);
  assert.strictEqual(path('circle'), null, 'a circle is a value, not drawn');
});

test('clip-path: polygon() is read as its fill rule and its vertices', async () => {
  // CSS Shapes 1, 3.1: a fill rule and a comma, or neither, then one
  // vertex or more, each two lengths or percentages. What Firefox and
  // Safari read no polygon in leaves the value before it — `round`, which
  // Chrome alone reads, among it.
  const { node } = await render(
    '<style>p { clip-path: inset(1px) }</style>' +
      '<p id="cut" style="clip-path:polygon(0 0, 100% 0, 50% 4px)"></p>' +
      '<p id="odd" style="clip-path:polygon(evenodd, 1px 2px) content-box"></p>' +
      '<p id="first" style="clip-path:margin-box polygon(nonzero,0 0,1px 1px)">' +
      '</p>' +
      '<p id="empty" style="clip-path:polygon()"></p>' +
      '<p id="half" style="clip-path:polygon(0 0, 1px)"></p>' +
      '<p id="three" style="clip-path:polygon(0 0 0, 1px 1px)"></p>' +
      '<p id="trailing" style="clip-path:polygon(0 0, 1px 1px,)"></p>' +
      '<p id="joined" style="clip-path:polygon(evenodd 0 0, 1px 1px)"></p>' +
      '<p id="auto" style="clip-path:polygon(auto 0, 1px 1px)"></p>' +
      '<p id="round" style="clip-path:polygon(round 2px, 0 0, 1px 1px)"></p>',
  );
  const el = view(node);
  const path = (id: string) =>
    (boxOf(el, id) as unknown as { style: { clipPath: unknown } }).style
      .clipPath;
  const polygon = {
    shape: 'polygon',
    lengths: [0, 0, 0, 0],
    radii: null,
    radiiY: null,
  };
  assert.deepStrictEqual(path('cut'), {
    box: 'border-box',
    ...polygon,
    points: [0, 0, { pct: 100 }, 0, { pct: 50 }, 4],
    fillRule: 'nonzero',
  });
  assert.deepStrictEqual(
    path('odd'),
    { box: 'content-box', ...polygon, points: [1, 2], fillRule: 'evenodd' },
    'one vertex is a polygon, of no area',
  );
  assert.deepStrictEqual(path('first'), {
    box: 'margin-box',
    ...polygon,
    points: [0, 0, 1, 1],
    fillRule: 'nonzero',
  });
  const inherited = {
    box: 'border-box',
    shape: 'inset',
    lengths: [1, 1, 1, 1],
    radii: null,
    radiiY: null,
    points: null,
    fillRule: 'nonzero',
  };
  for (const id of [
    'empty',
    'half',
    'three',
    'trailing',
    'joined',
    'auto',
    'round',
  ]) {
    assert.deepStrictEqual(path(id), inherited, `#${id} is no polygon`);
  }
});

metric(
  'clip-path: polygon() cuts a box and all it holds to its vertices, in the box it names',
  async () => {
    // CSS Masking 1, 5.1, CSS Shapes 1, 3.1: bun.sh's buttons cut a corner
    // off with `polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 0
    // 100%)`, and a percentage is of the reference box's width across and
    // its height down. It cut nothing, and every button was square.
    const { node } = await render(
      '<style>body{margin:0}div{width:100px;height:60px}</style>' +
        '<div id="a" style="background:#ff0000;clip-path:polygon(0 0, ' +
        'calc(100% - 20px) 0, 100% 20px, 100% 100%, 0 100%)">' +
        '<div style="position:absolute;top:0;left:0;width:300px;' +
        'height:300px;background:#0000ff"></div></div>' +
        '<div id="b" style="padding:10px;border:5px solid;background:#00ff00;' +
        'clip-path:polygon(0 0, 100% 0, 0 100%) content-box"></div>' +
        '<div style="background:#800000;clip-path:polygon(10px 10px)"></div>' +
        '<div style="background:#008000;clip-path:polygon(0 0, 100% 100%)">' +
        '</div>',
    );
    const el = view(node);
    const [a, b] = ['a', 'b'].map((id) => boxOf(el, id));
    const { fills } = await pathsOf(el, {
      x: 0,
      y: 0,
      width: 400,
      height: 600,
    });
    const clipOf = (color: string) => {
      const fill = fills.find((f) => f.style === parseColor(color));
      assert.ok(fill, `${color} is drawn`);
      return fill.clips[fill.clips.length - 1];
    };
    const inside = (color: string, x: number, y: number) =>
      windingAt(clipOf(color), x, y) !== 0;
    assert.ok(inside('#ff0000', a.x + 50, a.y + 30), 'inside the polygon');
    assert.ok(inside('#ff0000', a.x + 75, a.y + 2), 'left of the cut');
    assert.ok(!inside('#ff0000', a.x + 97, a.y + 3), 'the corner cut off');
    assert.ok(inside('#ff0000', a.x + 97, a.y + 30), 'below the cut');
    assert.ok(
      !inside('#0000ff', a.x + 97, a.y + 3) &&
        !inside('#0000ff', a.x + 150, a.y + 30),
      'and what it holds with it, positioned from outside or not',
    );
    // the content box is 100 by 60, 15px in from the border box
    assert.ok(inside('#00ff00', b.x + 20, b.y + 20), 'in the content box');
    assert.ok(!inside('#00ff00', b.x + 10, b.y + 20), 'not in its padding');
    assert.ok(!inside('#00ff00', b.x + 100, b.y + 60), 'past the diagonal');
    assert.ok(inside('#00ff00', b.x + 60, b.y + 40), 'before it');
    for (const [color, why] of [
      ['#800000', 'one vertex leaves nothing'],
      ['#008000', 'nor do two'],
    ]) {
      assert.ok(!fills.some((f) => f.style === parseColor(color)), why);
    }
  },
);

metric('a polygon is placed on the pixels its box is drawn on', async () => {
  // A box laid out a fraction of a pixel down draws its background from
  // the row it falls nearest; a polygon along its edges is measured from
  // there too, or it cut a row of half coverage off the top and the
  // bottom of what it was meant to leave whole (WPT clip-path-polygon-001
  // to 013).
  const { node } = await render(
    '<style>body{margin:0}</style><div style="height:10.4px"></div>' +
      '<div id="a" style="width:100.6px;height:50px;background:#ff0000;' +
      'clip-path:polygon(0 0, 100% 0, 100% 100%, 0 100%)"></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  assert.ok(a.y % 1 !== 0, `laid out a fraction down: ${a.y}`);
  const { fills } = await pathsOf(el, {
    x: 0,
    y: 0,
    width: 400,
    height: 600,
  });
  const red = fills.find((f) => f.style === parseColor('#ff0000'))!;
  const edges = (outline: [number, number][]) => [
    Math.min(...outline.map(([x]) => x)),
    Math.min(...outline.map(([, y]) => y)),
    Math.max(...outline.map(([x]) => x)),
    Math.max(...outline.map(([, y]) => y)),
  ];
  const clip = red.clips[red.clips.length - 1][0];
  assert.deepStrictEqual(edges(clip), edges(red.outlines[0]));
  assert.ok(
    edges(clip).every((v) => Number.isInteger(v)),
    `${edges(clip)}`,
  );
});

metric(
  'what a polygon cuts away is not under the pointer, and its fill rule says what is inside',
  async () => {
    // a star, its five points joined every second one: its middle is
    // wound round twice, inside by `nonzero` and outside by `evenodd`
    const star = '50px 0, 79px 90px, 2px 34px, 98px 34px, 21px 90px';
    const { result, node } = await render(
      '<style>body{margin:0} b{position:absolute;top:0;width:100px;' +
        'height:100px;display:block}</style>' +
        '<a id="under" href="#u" style="display:block;width:300px;' +
        'height:100px;background:#0000ff"></a>' +
        `<b id="cut" style="left:0;background:#ff0000;clip-path:polygon(0 0, ` +
        'calc(100% - 20px) 0, 100% 20px, 100% 100%, 0 100%)"></b>' +
        `<b id="nonzero" style="left:100px;background:#00ff00;` +
        `clip-path:polygon(${star})"></b>` +
        `<b id="evenodd" style="left:200px;background:#00ff00;` +
        `clip-path:polygon(evenodd, ${star})"></b>`,
    );
    const el = view(node);
    const { abs } = el as unknown as { abs: { x: number; y: number } };
    const at = (x: number, y: number) =>
      el.elementAtPoint(abs.x + x, abs.y + y)?.attribs.id;
    assert.strictEqual(at(50, 50), 'cut');
    assert.strictEqual(at(97, 3), 'under', 'the corner cut off');
    assert.strictEqual(at(150, 50), 'nonzero', 'nonzero: the middle is in');
    assert.strictEqual(at(250, 50), 'under', 'evenodd: the middle is out');
    assert.strictEqual(at(250, 20), 'evenodd', 'and a point of the star in');
    // and drawn so: the fill rule reaches the context
    const pixel = async (x: number, y: number) => {
      const [r, g, b] = await pixelAt(
        result.ctx,
        Math.round(abs.x + x),
        Math.round(abs.y + y),
      );
      return r > 200 ? 'red' : g > 200 ? 'green' : b > 200 ? 'blue' : 'other';
    };
    assert.strictEqual(await pixel(97, 3), 'blue', 'the corner shows the link');
    assert.strictEqual(await pixel(50, 50), 'red');
    assert.strictEqual(await pixel(150, 50), 'green');
    assert.strictEqual(await pixel(250, 50), 'blue');
    assert.strictEqual(await pixel(250, 20), 'green');
  },
);

metric(
  'clip-path shows the part of a box its shape names, and of all the box holds',
  async () => {
    // CSS Masking 1, 5.1: the element shows through the shape, and so does
    // everything in it — an absolute box whose containing block is outside
    // too, which a box that clips its overflow lets out. It was not read:
    // Tailwind 4's `.sr-only`, `clip-path: inset(50%)` on a pixel square
    // that also clips its overflow, showed the one pixel, and a box hidden
    // by the path alone was drawn whole.
    const { node } = await render(
      '<style>body{margin:0}div{width:100px;height:60px}</style>' +
        '<div id="a" style="background:#ff0000;' +
        'clip-path:inset(10px 20px 30px 40px)">' +
        '<div style="position:absolute;top:0;left:0;width:300px;' +
        'height:300px;background:#0000ff"></div></div>' +
        '<div id="b" style="padding:10px;border:5px solid;' +
        'background:#00ff00;clip-path:inset(10% 25% round 8px) content-box">' +
        '</div>' +
        '<div id="c" style="background:#ffff00;' +
        'clip-path:rect(5px 50px auto 10px)"></div>' +
        '<div id="d" style="background:#00ffff;' +
        'clip-path:xywh(10px 50% 30% 20px)"></div>' +
        '<div id="e" style="border-radius:20px;padding:5px;' +
        'background:#ff00ff;clip-path:padding-box"></div>' +
        '<div style="background:#800000;clip-path:inset(50%)">hidden' +
        '<div style="position:fixed;top:0;left:0;background:#808000"></div>' +
        '</div>' +
        '<div style="background:#008000;clip-path:inset(75% 0)"></div>' +
        '<div style="background:#000080;clip-path:rect(40px 10px 20px 30px)">' +
        '</div>',
    );
    const el = view(node);
    const ops: PaintOp[] = [];
    const fills = await fillsOf(el, ops);
    const clip = (color: string, nth = 0) =>
      clipsAround(ops, color)[nth].map(
        (c) => c.op === 'clip' && [c.x, c.y, c.w, c.h, c.radii],
      );
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      boxOf(el, id),
    );
    const inA = [[a.x + 40, a.y + 10, 40, 20, null]];
    assert.deepStrictEqual(clip('#ff0000'), inA, 'in from each edge');
    assert.deepStrictEqual(
      clip('#0000ff'),
      inA,
      'and what it holds with it, positioned from outside or not',
    );
    // the content box is 100 by 60, 15px in from the border box: 10% of
    // its height down, 25% of its width across
    assert.deepStrictEqual(
      clip('#00ff00'),
      [[b.x + 15 + 25, b.y + 15 + 6, 50, 48, [8, 8, 8, 8]]],
      'in the box it names, rounded',
    );
    assert.deepStrictEqual(
      clip('#ffff00'),
      [[c.x + 10, c.y + 5, 40, 55, null]],
      "rect()'s edges are from the top and the left, auto the box's own",
    );
    assert.deepStrictEqual(
      clip('#00ffff'),
      [[d.x + 10, d.y + 30, 30, 20, null]],
      'xywh() is a corner and a size',
    );
    assert.deepStrictEqual(
      clip('#ff00ff'),
      [[e.x, e.y, 110, 70, [20, 20, 20, 20]]],
      "a box alone is the shape, with the element's corners",
    );
    for (const [color, why] of [
      ['#800000', 'insets that meet leave nothing'],
      ['#808000', 'of what the box holds either, fixed or not'],
      ['#008000', 'nor do insets that pass each other'],
      ['#000080', 'nor a rect() whose edges cross'],
    ]) {
      assert.ok(!fills.some((f) => f.style === parseColor(color)), why);
    }
    assert.ok(!ops.some((op) => op.op === 'text'), 'and its text is not drawn');
  },
);

metric(
  'what a clip-path cuts away is not under the pointer, nor in the ink a repaint looks for',
  async () => {
    // Nothing the path cuts away is drawn, so nothing of it is hit: a
    // label hidden for a screen reader alone took the hover and the press
    // of the link drawn where it lay. And the box's ink ends at the path,
    // which is what a paint culls by.
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<a id="under" href="#u" style="display:block;width:200px;' +
        'height:100px"></a>' +
        '<div id="hidden" style="position:absolute;top:0;left:0;width:200px;' +
        'height:100px;clip-path:inset(50%)"><a id="in" href="#i" ' +
        'style="display:block;height:50px">label</a></div>' +
        '<div id="part" style="position:absolute;top:0;left:0;width:200px;' +
        'height:100px;clip-path:inset(0 0 50px 100px round 40px)">' +
        '<b id="far" style="position:fixed;top:0;left:0;width:300px;' +
        'height:300px"></b></div>',
    );
    const el = view(node);
    const { abs } = el as unknown as { abs: { x: number; y: number } };
    const at = (x: number, y: number) =>
      el.elementAtPoint(abs.x + x, abs.y + y)?.attribs.id;
    assert.strictEqual(at(50, 25), 'under', 'past every path');
    assert.strictEqual(at(50, 75), 'under', 'and past what one holds');
    assert.strictEqual(at(150, 25), 'far', 'in the path, what it holds');
    assert.strictEqual(at(102, 2), 'under', 'outside its rounded corner');
    assert.strictEqual(at(112, 12), 'far', 'and inside it');
    const bounds = (id: string) => {
      const box = boxOf(el, id) as unknown as Record<string, number>;
      return [box.boundsX, box.boundsY, box.boundsWidth, box.boundsHeight];
    };
    assert.deepStrictEqual(bounds('hidden'), [Infinity, Infinity, 0, 0]);
    assert.deepStrictEqual(bounds('part'), [100, 0, 100, 50]);
  },
);

metric(
  'a clip-path is measured in CSS pixels, and hit in them, at a display scale of 2',
  async () => {
    // The path's lengths are the cascade's, device pixels; a pointer's
    // point is logical. With the document offset in its window, a device
    // origin and a logical one differ.
    const { node } = await render2x(
      '<style>body{margin:0}</style>' +
        '<div id="a" style="width:100px;height:40px;background:#ff0000;' +
        'clip-path:inset(0 0 10px 50px)"></div>' +
        '<div id="p" style="width:100px;height:40px;background:#00ff00;' +
        'clip-path:polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, ' +
        '0 100%)"></div>',
    );
    const el = view(node);
    const a = boxOf(el, 'a');
    const ops: PaintOp[] = [];
    await fillsOf(el, ops);
    const [red] = clipsAround(ops, '#ff0000');
    assert.deepStrictEqual(
      red.map((c) => c.op === 'clip' && [c.x, c.y, c.w, c.h]),
      [[a.x + 100, a.y, 100, 60]],
      'two device pixels to each of its own',
    );
    const { abs } = el as unknown as { abs: { x: number; y: number } };
    const at = (x: number, y: number) =>
      el.elementAtPoint(abs.x / 2 + x, abs.y / 2 + y)?.attribs.id;
    assert.strictEqual(at(60, 20), 'a', 'inside the path');
    assert.notStrictEqual(at(40, 20), 'a', 'left of it');
    assert.notStrictEqual(at(60, 35), 'a', 'and under it');
    // a polygon's vertices are lengths too: its cut is 20 of its own
    // pixels from the corner, forty device ones
    assert.strictEqual(at(75, 42), 'p', 'left of the cut');
    assert.notStrictEqual(at(85, 43), 'p', 'the corner cut off');
    assert.strictEqual(at(97, 70), 'p', 'below the cut');
  },
);

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

test('translate is read, with the depth nothing here has dropped', async () => {
  const { node } = await render(
    '<div id="a" style="translate:10px 20%"></div>' +
      '<div id="b" style="translate:5px"></div>' +
      '<div id="c" style="translate:5px;translate:none"></div>' +
      '<div id="d" style="translate:1px 2px 3px"></div>' +
      '<div id="e" style="translate:4px;translate:1px 2px 3%"></div>' +
      '<div id="l" style="--x:calc(calc(1/2 * 100%) * -1);' +
      'translate:var(--x) 0"></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: { translate: unknown } }).style;
  assert.deepStrictEqual(style('a').translate, [10, { pct: 20 }]);
  assert.deepStrictEqual(style('b').translate, [5, 0]);
  assert.strictEqual(style('c').translate, null);
  assert.deepStrictEqual(style('d').translate, [1, 2], 'a depth is dropped');
  assert.deepStrictEqual(style('e').translate, [4, 0], 'a depth is a length');
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

test('a z-index does not order a transformed box that is not positioned', async () => {
  // a transformed box is painted with the positioned ones, in the
  // document's order: `z-index` applies to a positioned box, and the one
  // written on a box that is only transformed put it over the box after it
  const { node } = await render(
    '<style>body{margin:0}div{width:20px;height:20px}</style>' +
      '<div style="z-index:2;transform:translateX(0);background:#ff0000">' +
      '</div>' +
      '<div style="z-index:1;transform:translateY(-20px);' +
      'background:#0000ff"></div>',
  );
  const order = (await fillsOf(view(node)))
    .map((f) => f.style)
    .filter((c) => c === '#ff0000' || c === '#0000ff');
  assert.deepStrictEqual(order, ['#ff0000', '#0000ff']);
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
