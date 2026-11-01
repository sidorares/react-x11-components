// <Html> — positioned boxes, stacking and translation.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, pixelAt, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { setModal } from '../../src/html/dom.js';
import { parseColor } from '../../src/html/css/values.js';
import { CLAMPED } from '../../src/html/layout/boxes.js';
import type { Box } from '../../src/html/layout/boxes.js';
import { layered } from '../../src/html/paint.js';
import {
  areaTracks,
  parsePositionArea,
  parseTryFallbacks,
} from '../../src/html/css/anchor.js';
import type { WritingAxes } from '../../src/html/css/anchor.js';
import {
  anchoredHolds,
  parseContainerPrelude,
} from '../../src/html/css/containers.js';
import {
  FONTS,
  boxOf,
  bytesApart,
  clipsAround,
  fillsOf,
  findById,
  h,
  linesOf,
  metric,
  pathsOf,
  pixelsIn,
  pointIn,
  rebuilt,
  render,
  render2x,
  renderScrolled,
  snapshot,
  treeOf,
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

metric(
  'a positioned inline box with nothing in it is as high as a fragment on a line, and of no size on none',
  async () => {
    // Chrome 156 has each box here as high as the text beside it, whatever
    // the line and the font, and one on no line 0 tall. It stood at the top
    // of its line, as tall as its font, on a line or not.
    const { node } = await render(
      '<!doctype html><style>' +
        'body { margin: 0; font: 16px/20px serif }' +
        '.r { position: relative }' +
        '.t { position: absolute; left: 0; top: 0; width: 10px; height: 100% }' +
        '.big { font-size: 32px }' +
        '</style>' +
        '<div>text <span class="r"><i class="t" id="t1"></i></span><span id="e1">x</span></div>' +
        '<div><span class="r"><i class="t" id="t2"></i></span><span id="e2">x</span></div>' +
        '<div><span class="r big"><i class="t" id="t3"></i></span><span class="big" id="e3">x</span></div>' +
        '<div>one<br /><span class="r"><i class="t" id="t4"></i></span><span id="e4">x</span></div>' +
        '<div><span class="r"><i class="t" id="none"></i></span></div>',
    );
    const el = view(node);
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    for (const n of [1, 2, 3, 4]) {
      const [t, text] = [rect(`t${n}`), rect(`e${n}`)];
      assert.strictEqual(t.y, text.y, `${n}: the top of the fragment`);
      assert.strictEqual(t.height, text.height, `${n}: its height`);
    }
    assert.strictEqual(rect('none').height, 0);
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

test('clip-path is read: a rectangle in a box, a box alone, and another shape', async () => {
  // CSS Masking 1, 5.1: a basic shape, a `<geometry-box>`, or both in
  // either order. The rectangles of CSS Shapes 1, 3.1 are read as they are
  // written, a percentage among their lengths having no pixels yet; a
  // shape that is neither a rectangle nor a polygon is read as a basic
  // shape, laid down as polygons in the box; and anything else leaves the
  // value before it standing.
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
  assert.deepStrictEqual(
    path('circle'),
    {
      box: 'border-box',
      lengths: [0, 0, 0, 0],
      ...square,
      shape: 'basic',
      basic: { kind: 'circle', r: { pct: 40 }, at: [{ pct: 50 }, { pct: 50 }] },
    },
    'a circle is a basic shape',
  );
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

metric(
  'clip-path: shape(), circle(), path() and a url() to a <clipPath> cut a box to their outlines',
  async () => {
    // CSS Shapes 2, 4.2 and CSS Masking 1, 5.1 and 6: each is laid down as
    // polygons in the border box, a shape's subpaths filled together by
    // its rule, and a `<clipPath>`'s shapes in CSS pixels from the box's
    // corner. A url() to no `<clipPath>` clips nothing. Every one of these
    // clipped nothing before, and WPT's shape tests drew whole squares.
    const { node } = await render(
      '<style>body{margin:0}div{width:100px;height:100px}</style>' +
        '<div id="s" style="background:#ff0000;clip-path:shape(evenodd from 10px 10px, ' +
        'hline by 80px, vline by 80px, hline by -80%, close, ' +
        'move to 30px 30px, hline by 40px, vline by 40px, hline by -40px, close)"></div>' +
        '<div id="c" style="background:#00ff00;clip-path:circle(50%)"></div>' +
        '<div id="p" style="background:#0000ff;clip-path:path(&quot;M0 0 L100 0 L0 100 Z&quot;)"></div>' +
        '<div id="u" style="background:#800000;clip-path:url(#half)"></div>' +
        '<div id="none" style="background:#008000;clip-path:url(#nothing)"></div>' +
        '<svg width="0" height="0"><clipPath id="half">' +
        '<rect x="0" y="0" width="50" height="100"/></clipPath></svg>',
    );
    const el = view(node);
    const [s, c, p, u, none] = ['s', 'c', 'p', 'u', 'none'].map((id) =>
      boxOf(el, id),
    );
    const { fills } = await pathsOf(el, {
      x: 0,
      y: 0,
      width: 400,
      height: 600,
    });
    const winding = (color: string, x: number, y: number) => {
      const fill = fills.find((f) => f.style === parseColor(color));
      assert.ok(fill, `${color} is drawn`);
      return windingAt(fill.clips[fill.clips.length - 1], x, y);
    };
    const odd = (color: string, x: number, y: number) =>
      winding(color, x, y) % 2 !== 0;
    assert.ok(odd('#ff0000', s.x + 20, s.y + 20), 'in the outer square');
    assert.ok(!odd('#ff0000', s.x + 50, s.y + 50), 'not in the hole');
    assert.ok(!odd('#ff0000', s.x + 5, s.y + 5), 'nor outside');
    assert.ok(winding('#00ff00', c.x + 50, c.y + 50), 'in the circle');
    assert.ok(!winding('#00ff00', c.x + 4, c.y + 4), 'not its corner');
    assert.ok(winding('#0000ff', p.x + 10, p.y + 10), 'in the triangle');
    assert.ok(!winding('#0000ff', p.x + 90, p.y + 90), 'not past it');
    assert.ok(winding('#800000', u.x + 25, u.y + 50), 'in the clipPath');
    assert.ok(!winding('#800000', u.x + 75, u.y + 50), 'not past its rect');
    assert.ok(
      winding('#008000', none.x + 95, none.y + 95),
      'a url() to nothing clips nothing',
    );
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

test('what is in an absolute box between two offsets takes its percentage heights of the height they leave', async () => {
  // CSS 2.1 10.6.4 makes the box as tall as `top` and `bottom` leave, and
  // CSS Sizing 3, 2.1 has that stretch-fit height definite, so `height:
  // 100%` in an `inset: 0` overlay fills it, as in Chrome, Firefox and
  // Safari. The box was stretched only after its content was laid out,
  // with no height to take a percentage of.
  const { node } = await render(
    '<style>body{margin:0}.w{position:relative;width:60px;height:60px}' +
      '.a{position:absolute;inset:4px}</style>' +
      '<div class="w"><div class="a"><div id="a" style="height:50%"></div>' +
      '</div></div>' +
      // of its content box
      '<div class="w"><div class="a" style="padding:5px 0;' +
      'box-sizing:border-box"><div id="b" style="height:100%"></div></div>' +
      '</div>' +
      // and of the height a limit holds it to
      '<div class="w"><div class="a" style="min-height:80px">' +
      '<div id="c" style="height:50%"></div></div></div>' +
      // with one offset, its height is its content's, and none to take
      '<div class="w"><div class="a" style="top:auto">' +
      '<div id="d" style="height:50%"></div></div></div>',
  );
  const el = view(node);
  const height = (id: string) => boxOf(el, id).height;
  assert.strictEqual(height('a'), 26, 'half of the 52 the offsets leave');
  assert.strictEqual(height('b'), 42, 'all of it inside the padding');
  assert.strictEqual(height('c'), 40, 'half of its min-height');
  assert.strictEqual(height('d'), 0, 'a percentage of nothing is auto');
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

test('translate is read, with its depth', async () => {
  const { node } = await render(
    '<div id="a" style="translate:10px 20%"></div>' +
      '<div id="b" style="translate:5px"></div>' +
      '<div id="c" style="translate:5px;translate:none"></div>' +
      '<div id="d" style="translate:1px 2px 3px"></div>' +
      '<div id="e" style="translate:4px;translate:1px 2px 3%"></div>' +
      '<div id="f" style="font-size:10px;translate:0 0 -2em"></div>' +
      '<div id="l" style="--x:calc(calc(1/2 * 100%) * -1);' +
      'translate:var(--x) 0"></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: { translate: unknown } }).style;
  // across, down and toward the viewer, by nothing where it is not written
  assert.deepStrictEqual(style('a').translate, [10, { pct: 20 }, 0]);
  assert.deepStrictEqual(style('b').translate, [5, 0, 0]);
  assert.strictEqual(style('c').translate, null);
  assert.deepStrictEqual(style('d').translate, [1, 2, 3], 'in depth');
  assert.deepStrictEqual(
    style('e').translate,
    [4, 0, 0],
    'a depth is a length',
  );
  assert.deepStrictEqual(style('f').translate, [0, 0, -20], 'away from it');
  assert.deepStrictEqual(style('l').translate, [{ pct: -50, px: 0 }, 0, 0]);
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

test('a box that names a property in will-change holds what the property would hold: a transform the fixed boxes in it, a position the absolute ones, a filter even on an inline box, and a transform nothing on one', async () => {
  // CSS Will Change 1, 2: what a value of the property other than its
  // initial one would make of the element, on the boxes it applies to — a
  // transform not to an inline box, a filter to any
  const { node } = await render(
    '<style>body{margin:0}i{display:block;width:5px;height:5px}' +
      'section{height:40px}</style>' +
      '<div style="height:50px"></div>' +
      '<section style="will-change:transform">' +
      '<i id="f" style="position:fixed;top:0;left:10px"></i></section>' +
      '<section style="will-change:position">' +
      '<i id="a" style="position:absolute;top:0;left:10px"></i></section>' +
      '<section style="will-change:height">' +
      '<i id="n" style="position:absolute;top:0;left:10px"></i></section>' +
      '<span style="will-change:transform">' +
      '<i id="t" style="position:fixed;top:0;left:20px"></i></span>' +
      '<span style="will-change:filter;margin-left:30px">x' +
      '<i id="g" style="position:fixed;top:0;left:0"></i></span>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('f'), [10, 50], 'against the transform');
  assert.deepStrictEqual(at('a'), [10, 90], 'against the position');
  assert.deepStrictEqual(at('n'), [10, 0], 'a height holds nothing');
  assert.deepStrictEqual(at('t'), [20, 0], 'an inline box takes no transform');
  const [x, y] = at('g');
  assert.ok(x >= 30 && y > 0, `${x}, ${y}: against the inline box's filter`);
});

test('a box that names a property in will-change is the stacking context it would make: an opacity on any box, a z-index only where one applies', async () => {
  // what has a negative `z-index` in a stacking context is painted over its
  // background, and in one that is not, under the flow it is in
  const { node } = await render(
    '<style>body{margin:0}div{width:20px;height:20px}</style>' +
      '<div style="will-change:opacity;background:#ff0000">' +
      '<div style="position:absolute;top:0;z-index:-1;' +
      'background:#00ff00"></div></div>' +
      '<div style="will-change:z-index;background:#0000ff">' +
      '<div style="position:absolute;top:20px;z-index:-1;' +
      'background:#ffff00"></div></div>',
  );
  const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
  const order = (await fillsOf(view(node)))
    .map((f) => f.style)
    .filter((c) => colours.includes(c as string));
  // yellow below the flow, blue in it, and red — a stacking context, so
  // with the positioned boxes — over both, with green in it over its red
  assert.deepStrictEqual(order, ['#ffff00', '#0000ff', '#ff0000', '#00ff00']);
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

for (const [label, mount] of [
  ['', render],
  [', at 2x', render2x],
] as const) {
  metric(
    `a sticky inline box is where its lines have it, however many layouts ran${label}`,
    async () => {
      // No layout sets an inline box's rect, and a move adds up on it, so
      // read for where the box is, it was at the page's corner: moved by the
      // whole of its `top` at the first layout wherever it stood, which
      // stayed on the box as the place it was at, and by nothing at the
      // layout after
      const { node } = await mount(
        '<style>body{margin:0;font:16px/20px sans-serif}p{margin:0}' +
          '.s{position:sticky;top:10px}</style>' +
          '<p style="height:80px">word <span id="top" class="s">held</span></p>' +
          '<p>word <span id="far" class="s">here</span> ' +
          '<b id="beside">here</b></p><p>word <span id="rel" ' +
          'style="position:relative;top:4px">here</span></p>' +
          '<div style="height:300px"></div>',
      );
      const el = view(node);
      const stale = el as unknown as { _invalidate(stale: number): void };
      const at = (id: string) => el.elementRect(findById(el.document, id)!)!;
      const places = () =>
        ['top', 'far', 'rel'].flatMap((id) => [at(id).x, at(id).y]);
      const first = places();
      // as far down as its `top` asks, from the top of the viewport
      assert.strictEqual(first[1], 10, 'held down to its top');
      // and past it, where the text beside it is, moved by nothing
      assert.strictEqual(first[3], at('beside').y, 'where the flow has it');
      for (let layouts = 2; layouts <= 4; layouts += 1) {
        await act(async () => stale._invalidate(1));
        await act();
        assert.deepStrictEqual(places(), first, `after ${layouts} layouts`);
      }
    },
  );

  metric(
    `a sticky box nothing scrolls sticks where the flow has it, and its transform moves it from there${label}`,
    async () => {
      // No scroll places it again, so where a layout puts it at rest is
      // where it stays: all three engines' `r` is 10 less its own height,
      // and `q`, turned, 30 less that and what a turn adds to its rect
      const { node } = await mount(
        '<style>body{margin:0}.h{width:20px;height:20px;position:sticky}' +
          '</style><div style="height:400px">' +
          '<div class="h" id="r" style="top:10px;' +
          'transform:translateY(-100%)"></div>' +
          '<div class="h" id="q" style="top:30px;' +
          'transform:translateY(-100%) rotate(45deg)"></div>' +
          '<div class="h" id="x" style="left:10px;' +
          'transform:translateX(-100%)"></div></div>',
      );
      const el = view(node);
      const top = (id: string) =>
        Math.round(el.elementRect(findById(el.document, id)!)!.y * 10) / 10;
      assert.strictEqual(top('r'), -10);
      assert.strictEqual(top('q'), 5.9);
      assert.strictEqual(el.elementRect(findById(el.document, 'x')!)!.x, -10);
    },
  );
}

metric(
  'a sticky inline box stuck nowhere is drawn as the same box unpositioned is, its text over its background',
  async () => {
    // Given a size, it was painted as a rectangle after its lines were, and
    // its background covered its text, in a repaint of it as much as in the
    // first paint: only the same box not sticky says what should be there
    const drawn = async (position: string) => {
      const { result } = await render(
        '<style>body{margin:0;font:16px/20px sans-serif}p{margin:0}' +
          `span{position:${position};top:-100px;background:#ffcc00;` +
          'padding:2px 8px;border-radius:4px}</style>' +
          '<p>word <span>here</span> word</p>',
      );
      const pixels = await pixelsIn(result.ctx, {
        x: 0,
        y: 0,
        width: 200,
        height: 40,
      });
      await result.unmount();
      return pixels;
    };
    const want = await drawn('static');
    const got = await drawn('sticky');
    assert.ok(
      want.some((_, i) => i % 4 === 0 && want[i] < 100),
      'the text is drawn',
    );
    assert.strictEqual(bytesApart(got, want), 0, 'its pixels');
  },
);

/** A box `.s`, whose text and background are one red, so that it is that
 *  red edge to edge, and text `.b` that shows where it comes over the box. */
const POSITIONED_INLINE =
  '<style>body{margin:0;font:16px/20px sans-serif}p{margin:0}' +
  '.s{background:#ff0000;color:#ff0000}.b{color:#0000ff}</style>';

/** How many of a window region's pixels are not a colour, and how many are
 *  another, where the region is an element's box less a pixel all round:
 *  what is under a box painted over it has no way to show. */
async function pixelsOver(
  result: Awaited<ReturnType<typeof render>>['result'],
  el: ReturnType<typeof view>,
  id: string,
  scale = 1,
): Promise<{ other: number; all: number }> {
  const { abs } = el as unknown as DrawnNode;
  const r = el.elementRect(findById(el.document, id)!)!;
  const x = Math.ceil(abs.x + r.x * scale) + 1;
  const y = Math.ceil(abs.y + r.y * scale) + 1;
  const width = Math.floor(r.width * scale) - 2;
  const height = Math.floor(r.height * scale) - 2;
  const px = await pixelsIn(result.ctx, { x, y, width, height });
  let other = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] !== 255 || px[i + 1] !== 0 || px[i + 2] !== 0) other += 1;
  }
  return { other, all: px.length / 4 };
}

for (const [label, mount, scale] of [
  ['', render, 1],
  [', at 2x', render2x, 2],
] as const) {
  metric(
    `an inline box an inset moves goes over what is after it in the flow, in pixels and to the pointer, as Chrome, WebKit and Firefox have it${label}`,
    async () => {
      // A positioned box paints after the flow (CSS 2.1 Appendix E, step
      // 8). Its text is on its block's lines, and painted by them it went
      // under the text of every line after it, of its own block or another
      const { result, node } = await mount(
        POSITIONED_INLINE +
          '<p><span id="s" class="s" style="position:relative;top:20px">' +
          'XXXXXXXX</span> <span id="n" class="b">XX</span></p>' +
          '<p id="b" class="b">XXXXXXXXXXXXXXXXXXXXXXXXXXXX</p>',
      );
      const el = view(node);
      await act();
      const { other, all } = await pixelsOver(result, el, 's', scale);
      assert.ok(all > 100, 'it has pixels to look at');
      assert.strictEqual(other, 0, 'nothing of the text under it shows');
      const { abs } = el as unknown as DrawnNode;
      const hit = (id: string, x: number) => {
        const r = el.elementRect(findById(el.document, id)!)!;
        return el.elementAtPoint(
          abs.x / scale + r.x + x,
          abs.y / scale + r.y + r.height / 2,
        )?.attribs.id;
      };
      assert.strictEqual(hit('s', 10), 's', 'over the text under it');
      // and what it does not cover is what it was, the rest of that line
      const past = el.elementRect(findById(el.document, 's')!)!;
      assert.strictEqual(hit('b', past.width + 10), 'b', 'past its end');
    },
  );

  metric(
    `a sticky inline box held over what scrolls under it is drawn on it, and takes the pointer there${label}`,
    async () => {
      // #1160 made a span stick, which put this in plain view: a span at
      // the top of a list had the paragraphs under it drawn over it
      const { result, node } = await mount(
        POSITIONED_INLINE +
          '<div id="list" style="height:100px;width:200px;overflow:auto">' +
          '<span id="s" class="s" style="position:sticky;top:0">XXXXXXXX' +
          '</span>' +
          '<p>x</p>'.repeat(5) +
          '<p id="b" class="b">XXXXXXXXXXXX</p>' +
          '<p>x</p>'.repeat(20) +
          '</div>',
      );
      const el = view(node);
      await act();
      el.scrollElementTo(findById(el.document, 'list')!, { y: 120 });
      await act();
      const { other, all } = await pixelsOver(result, el, 's', scale);
      assert.ok(all > 100, 'it has pixels to look at');
      assert.strictEqual(other, 0, 'nothing of the text under it shows');
      const s = el.elementRect(findById(el.document, 's')!)!;
      const b = el.elementRect(findById(el.document, 'b')!)!;
      assert.ok(Math.abs(s.y - b.y) < s.height, 'it is over the paragraph');
      const { abs } = el as unknown as DrawnNode;
      const at = el.elementAtPoint(
        abs.x / scale + s.x + 10,
        abs.y / scale + s.y + s.height / 2,
      );
      assert.strictEqual(at?.attribs.id, 's');
    },
  );
}

metric(
  'an inline box an inset moves takes its turn among the layers, as Chrome, WebKit and Firefox have it',
  async () => {
    // Over an absolute box before it, under one after it, by its `z-index`
    // over one after it, and below its context's flow with a negative one.
    // Every other way round was what painting it by its lines made of it
    const stage = '<div style="position:relative;width:200px;height:60px">';
    const span = (more: string) =>
      `<span id="s" class="s" style="position:relative;top:1px;${more}">` +
      'XXXXXXXX</span>';
    const abs = (more: string) =>
      `<div id="abs" style="position:absolute;inset:0;background:#00ff00;${more}"></div>`;
    for (const [source, want, label] of [
      [stage + abs('') + span(''), 's', 'over a box before it'],
      [stage + span('') + abs(''), 'abs', 'under a box after it'],
      [stage + span('z-index:2') + abs('z-index:1'), 's', 'by its z-index'],
      [
        '<div style="position:relative;z-index:0;width:200px;height:60px">' +
          span('z-index:-1') +
          '<p id="abs" style="margin-top:-20px;background:#00ff00;height:40px">' +
          '</p>',
        'abs',
        'under the flow, with a negative z-index',
      ],
    ] as const) {
      const { result, node } = await render(POSITIONED_INLINE + source);
      const el = view(node);
      await act();
      const { abs: at } = el as unknown as DrawnNode;
      const r = el.elementRect(findById(el.document, 's')!)!;
      const x = at.x + r.x + r.width / 2;
      const y = at.y + r.y + r.height / 2;
      assert.strictEqual(el.elementAtPoint(x, y)?.attribs.id, want, label);
      const { other } = await pixelsOver(result, el, 's');
      assert.strictEqual(other === 0, want === 's', `${label}: its pixels`);
      await result.unmount();
    }
  },
);

metric(
  'what an inline box an inset moves holds goes with it: another inside it, and an inline-block',
  async () => {
    const { result, node } = await render(
      POSITIONED_INLINE +
        '<p><span id="o" class="s" style="position:relative;top:20px">XX' +
        '<span id="i" style="position:relative;left:0;background:#00ff00;' +
        'color:#00ff00">XX</span>XX<i id="ib" style="display:inline-block;' +
        'width:40px;height:16px;background:#ff0000"></i></span></p>' +
        '<p id="b" class="b">XXXXXXXXXXXXXXXXXXXXXXXXXXXX</p>',
    );
    const el = view(node);
    await act();
    const { abs } = el as unknown as DrawnNode;
    for (const id of ['i', 'ib']) {
      const r = el.elementRect(findById(el.document, id)!)!;
      const at = el.elementAtPoint(
        abs.x + r.x + r.width / 2,
        abs.y + r.y + r.height / 2,
      );
      assert.strictEqual(at?.attribs.id, id);
    }
    assert.strictEqual((await pixelsOver(result, el, 'ib')).other, 0);
  },
);

metric(
  'an inline box an inset moves is cut by a box around it that clips, and a repaint of it alone draws it',
  async () => {
    // One culled by what it draws, which is not where its block is: a
    // repaint of a strip of it is none of its block's business
    const { result, node } = await render(
      POSITIONED_INLINE +
        '<div style="overflow:hidden;height:30px;width:300px">' +
        '<span id="s" class="s" style="position:relative;top:20px">XXXXXXXX' +
        '</span></div><p id="b" class="b">XXXXXXXXXXXXXXXXXXXXXXXX</p>' +
        '<p id="c" style="position:relative;top:-40px;color:#0000ff;' +
        'height:20px"></p>' +
        '<div style="height:40px"></div><p style="margin-top:0">' +
        '<span id="t" class="s" style="position:relative;top:40px">XXXXXXXX' +
        '</span></p><p class="b">XXXXXXXXXXXXXXXXXXXXXXXX</p>' +
        '<p class="b">XXXXXXXXXXXXXXXXXXXXXXXX</p>',
    );
    const el = view(node);
    await act();
    const { abs } = el as unknown as DrawnNode;
    const s = el.elementRect(findById(el.document, 's')!)!;
    const past = await pixelsIn(result.ctx, {
      x: abs.x + s.x + 2,
      y: abs.y + 31,
      width: 20,
      height: 8,
    });
    assert.ok(
      past.every((_, i) => i % 4 !== 0 || past[i] !== 255 || past[i + 2] > 0),
      'the box that clips it cut it',
    );
    const t = el.elementRect(findById(el.document, 't')!)!;
    const own = el as unknown as {
      invalidate(all: boolean, by: unknown, why: string): void;
    };
    own.invalidate(
      false,
      {
        x: abs.x + t.x + 4,
        y: abs.y + t.y + 4,
        width: t.width - 8,
        height: t.height - 8,
      },
      'props',
    );
    await act();
    assert.strictEqual((await pixelsOver(result, el, 't')).other, 0);
  },
);

metric(
  'an inline box painted among the layers is drawn as the same box on its lines is, once',
  async () => {
    // Text over its own background and under its rule, through two lines,
    // an atomic a word after it is drawn over and a selection: the same
    // layouts either way (`vertical-align: 0` lays a box's text apart and
    // moves nothing, and is on its lines), and anything of it drawn twice
    // is darker at every edge of a glyph
    const drawn = async (place: string, select: boolean) => {
      const { result, node } = await render(
        '<style>body{margin:0;font:16px/20px sans-serif}p{margin:0;width:150px}' +
          `.m{${place};background:#ffcc00;color:#203040;padding:1px 4px;` +
          'border:1px solid #806000;border-radius:4px;' +
          'text-shadow:1px 1px 0 #ff000080;text-decoration:underline}' +
          '.f{opacity:.5}' +
          'i{display:inline-block;width:30px;height:14px;background:#00a0a0;' +
          'margin-right:-20px}</style>' +
          '<p>word <span class="m">some words on <b>two</b> lines <i></i>over' +
          '</span> word</p><p>word <span class="m f">faded here</span> word' +
          '</p><p><span class="f">word <span class="m">in one</span></span></p>',
      );
      const el = view(node);
      await act();
      if (select) el.selectAll();
      const pixels = await snapshot(result, el);
      await result.unmount();
      return pixels;
    };
    for (const select of [false, true]) {
      const want = await drawn('vertical-align:0', select);
      const got = await drawn('position:relative;top:0', select);
      assert.ok(
        want.some((_, i) => i % 4 === 0 && want[i] < 100),
        'the text is drawn',
      );
      assert.strictEqual(bytesApart(got, want), 0, `selected: ${select}`);
    }
  },
);

for (const [label, named] of [
  ['', ''],
  [', where the fade is named in will-change', '#o{will-change:opacity}'],
] as const) {
  metric(
    `an inline box that stops being a layer in place keeps its text, drawn by its lines again${label}`,
    async () => {
      // A box in a faded inline box stays on its lines (`paintsApart`), and
      // a hover that fades the one around it says so with no build. Named
      // in `will-change` it says so with no gathering of the layers, which
      // one in transition or animated does at every frame: left to a layer
      // that was none now, its text was drawn by nothing
      const { result, node } = await render(
        '<style>body{margin:0;font:16px/20px sans-serif}p{margin:0}' +
          `${named}#o:hover{opacity:.5}` +
          '.m{position:relative;top:0;color:#000080}</style>' +
          '<p>word <span id="o">some <span id="m" class="m">words</span>' +
          '</span></p>',
      );
      const el = view(node);
      await act();
      const quiet = await snapshot(result, el);
      const tree = treeOf(el);
      el.setHover(...pointIn(el, 'm'));
      const hovered = await snapshot(result, el);
      assert.strictEqual(treeOf(el), tree, 'taken in place');
      assert.ok(bytesApart(hovered, quiet) > 0, 'the hover drew nothing');
      assert.strictEqual(
        bytesApart(hovered, await rebuilt(result, el)),
        0,
        'not the pixels a build draws',
      );
      el.setHover(-1, -1);
      assert.strictEqual(
        bytesApart(await snapshot(result, el), quiet),
        0,
        'and back',
      );
    },
  );
}

metric(
  'an inline box with no inset is no layer, and leaves its paragraph its one layout',
  async () => {
    // joshwcomeau.com has hundreds, to hold an absolute box each: they move
    // nowhere, and each would cost its paragraph a line at a time
    const { node } = await render(
      '<p id="a">word <span id="s" style="position:relative">word</span> word' +
        '</p>',
    );
    const el = view(node);
    await act();
    const lines = linesOf(el, 'a');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].texts.length, 1, 'one layout');
    const a = boxOf(el, 'a') as unknown as Box;
    assert.ok(
      a.children.every((child) => !layered(a, child)),
      'no layer',
    );
  },
);

metric(
  'an inline box a relative offset moves is moved by it once, at each width it is laid out at',
  async () => {
    // Its text comes off new lines at another width, with nothing on them,
    // and what the offset came to has to start from nothing with them: it
    // adds up as a sticky box is moved, and read on, the box was moved twice
    const { el, resize } = await renderScrolled(
      '<style>body{margin:0;font:16px/20px sans-serif}p{margin:0}</style>' +
        '<p><b id="beside">word</b> <span id="rel" style="position:relative;' +
        'top:4px">word</span></p>',
      200,
    );
    const at = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const apart = () => at('rel').y - at('beside').y;
    assert.strictEqual(apart(), 4, 'at the width it started at');
    await resize(200, 300);
    assert.strictEqual(apart(), 4, 'narrower');
    await resize(200, 400);
    assert.strictEqual(apart(), 4, 'and back');
  },
);

/** A box 300 by 200 positioned relative, with an anchor `--b` 60 by 30 at
 *  100, `top` down it, and what `css` and `more` say. */
function anchored(css: string, more: string, top = 20): string {
  return (
    '<style>body{margin:0}#wrap{position:relative;width:300px;height:200px}' +
    `#btn{position:absolute;left:100px;top:${top}px;width:60px;height:30px;` +
    `anchor-name:--b}${css}</style>` +
    `<div id="wrap"><div id="btn"></div>${more}</div>`
  );
}

test('anchor() and anchor-size() place a box against its anchor', async () => {
  const { node } = await render(
    anchored(
      '.t{position:absolute;width:20px;height:10px}' +
        '#below{top:anchor(--b bottom);left:anchor(--b left)}' +
        '#right{position-anchor:--b;left:anchor(right);top:anchor(center)}' +
        '#above{position-anchor:--b;bottom:anchor(top);right:anchor(right)}' +
        '#mid{position-anchor:--b;left:anchor(50%);top:anchor(outside)}' +
        '#sized{position-anchor:--b;width:anchor-size(width);' +
        'height:anchor-size(height);top:0;left:0}' +
        // no anchor of the name: the fallback, or `auto`
        '#lost{top:anchor(--nobody bottom, 7px);left:anchor(--nobody left)}',
      '<div class="t" id="below"></div><div class="t" id="right"></div>' +
        '<div class="t" id="above"></div><div class="t" id="mid"></div>' +
        '<div id="sized" style="position:absolute"></div>' +
        '<div class="t" id="lost"></div>',
    ),
  );
  const el = view(node);
  const at = (id: string) => {
    const b = boxOf(el, id);
    return [b.x, b.y, b.width, b.height];
  };
  assert.deepStrictEqual(at('below'), [100, 50, 20, 10]);
  assert.deepStrictEqual(at('right'), [160, 35, 20, 10]);
  // `bottom` and `right` from the containing block's far edges
  assert.deepStrictEqual(at('above'), [140, 10, 20, 10]);
  // a percentage across the anchor, and `outside` the side opposite
  assert.deepStrictEqual(at('mid'), [130, 50, 20, 10]);
  assert.deepStrictEqual(at('sized'), [0, 0, 60, 30]);
  assert.deepStrictEqual(at('lost'), [0, 7, 20, 10]);
});

test('an anchor a positioned box holds is laid out before a box anchored to it that comes first, as a browser lays them out', async () => {
  // CSS Anchor Positioning 1, 2.3: the anchor is acceptable, being in a
  // positioned box that is before the target among their containing
  // block's boxes; it is laid out with that box, as that box's
  // containing block ends its layout, before the target's does
  const { node } = await render(
    '<style>body{margin:0}.t{position:absolute;height:10px;' +
      'width:anchor-size(--a1 width)}.rel{position:relative}' +
      '#a{anchor-name:--a1;position:absolute;width:30px;height:10px}</style>' +
      '<div class="rel"><div class="t" id="first"></div><div>' +
      '<div class="rel"><div style="position:absolute"><div class="rel">' +
      '<div id="a"></div></div></div></div>' +
      '<div class="t" id="after"></div></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'first').width, 30);
  assert.strictEqual(boxOf(el, 'after').width, 30);
});

test("anchor-size() is a length in a box's least and greatest sizes, its insets and its margins, and an anchor() of the other axis is its fallback", async () => {
  // CSS Anchor Positioning 1, 5.1: anchor-size() is allowed in the sizing
  // properties, the insets and the margins, the axis it reads the
  // property's where it names none; one with no anchor is its fallback,
  // or the property's initial value, as getComputedStyle reads it; and
  // 3.2.1: an anchor() of a side of the other axis is invalid
  const { node } = await render(
    '<style>body{margin:0}#cb{position:relative;width:200px;height:200px}' +
      '#a{anchor-name:--a1;width:5px;height:7px}' +
      '.t{position:absolute;position-anchor:--a1}' +
      '#mn{min-width:anchor-size(width);height:1px}' +
      '#mx{max-height:anchor-size(width)}' +
      '#ins{left:anchor-size(height);top:anchor-size();width:1px;height:1px}' +
      '#mar{margin-left:anchor-size(width);margin-top:anchor-size();' +
      'left:0;top:0;width:1px;height:1px}' +
      '#cross{left:anchor(--a1 top, 13px);top:0;width:1px;height:1px}' +
      '#flow{width:100px;max-width:anchor-size(width, 28%);' +
      'margin-left:anchor-size(width, 6px)}' +
      '</style><div id="cb"><div id="a"></div>' +
      '<div class="t" id="mn"></div>' +
      '<div class="t" id="mx"><div style="height:100px"></div></div>' +
      '<div class="t" id="ins"></div><div class="t" id="mar"></div>' +
      '<div class="t" id="cross"></div><div id="flow"></div></div>',
  );
  const el = view(node);
  const at = (id: string) => {
    const b = boxOf(el, id);
    return [b.x, b.y, b.width, b.height];
  };
  const cs = (id: string) => el.computedStyle(findById(el.document, id)!)!;
  assert.strictEqual(boxOf(el, 'mn').width, 5);
  assert.strictEqual(boxOf(el, 'mx').height, 5);
  assert.deepStrictEqual(at('ins'), [7, 7, 1, 1]);
  assert.deepStrictEqual(at('mar'), [5, 7, 1, 1]);
  assert.deepStrictEqual(
    [cs('mar')['margin-left'], cs('mar')['margin-top']],
    ['5px', '7px'],
  );
  assert.strictEqual(boxOf(el, 'cross').x, 13);
  // in the flow: the fallbacks
  assert.deepStrictEqual(
    [cs('flow')['max-width'], cs('flow')['margin-left']],
    ['28%', '6px'],
  );
});

test('an anchor in the top layer is no anchor of a box laid out before it', async () => {
  // 2.3: what is in the top layer is laid out after everything that is
  // not, in the order it went in
  const { node } = await render(
    '<style>body{margin:0}dialog{margin:0;border:0;padding:0;inset:auto}' +
      '#d{position:absolute;left:200px;top:300px;width:100px;height:100px;' +
      'anchor-name:--a}' +
      '#t{position:fixed;position-anchor:--a;top:anchor(bottom, 20px);' +
      'left:anchor(left, 30px);width:10px;height:10px}' +
      '</style><dialog id="d" open></dialog><div id="t"></div>',
  );
  const el = view(node);
  // open in the page, an anchor like any
  assert.deepStrictEqual([boxOf(el, 't').x, boxOf(el, 't').y], [200, 400]);
  const d = findById(el.document, 'd')!;
  setModal(d, true);
  el.touchDocument([
    { type: 'attributes', target: d, attributeName: '-rx-modal' },
    { type: 'attributes', target: d, attributeName: 'open' },
  ] as never);
  await act();
  assert.deepStrictEqual(
    [boxOf(el, 't').x, boxOf(el, 't').y],
    [30, 20],
    'the fallbacks',
  );
});

test('a ::before or an ::after is an anchor, as its element is', async () => {
  // CSS Anchor Positioning 1, 2.1: anchor-name applies to every element,
  // and to the tree-abiding pseudo-elements
  const { node } = await render(
    '<style>body{margin:0}.cb{position:relative;width:200px;height:200px}' +
      '#one::before,#two::after{display:block;width:100px;height:50px;content:""}' +
      '#one::before{anchor-name:--a}#two::after{anchor-name:--b}' +
      '.t{position:absolute;width:10px;height:10px;left:anchor(right);top:anchor(bottom)}' +
      '#ta{position-anchor:--a}#tb{position-anchor:--b}</style>' +
      '<div class="cb"><div id="one"></div><div class="t" id="ta"></div></div>' +
      '<div class="cb"><div id="two">x</div><div class="t" id="tb"></div></div>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('ta'), [100, 50]);
  // the ::after after the line of text the element holds
  const text = boxOf(el, 'two');
  assert.deepStrictEqual(at('tb'), [100, text.y + text.height]);
});

test('a ::before or an ::after is anchored to its element, its implicit anchor, for auto, and for normal in a position-area', async () => {
  // CSS Anchor Positioning 1, 2.2 and `position-anchor`: `normal` is
  // `auto` in a `position-area` and `none` without; and no name is needed,
  // in a document with no `anchor-name` anywhere
  const { node } = await render(
    '<style>body{margin:0}' +
      '.a{margin:20px 0 0 50px;width:100px;height:40px}' +
      '.a::before,.a::after{content:"";position:absolute;width:10px;height:10px}' +
      '#auto::before{position-anchor:auto;left:anchor(right);top:anchor(bottom)}' +
      '#auto::after{position-anchor:auto;position-area:top left}' +
      '#normal::before{position-area:bottom center}' +
      // no default anchor: the fallback
      '#normal::after{left:anchor(right, 7px);top:anchor(top, 9px)}' +
      '#none::before{position-anchor:none;position-area:top left;left:3px;top:4px}' +
      '</style><div class="a" id="auto"></div><div class="a" id="normal"></div>' +
      '<div class="a" id="none"></div>',
  );
  const el = view(node);
  const pseudo = (id: string, which: string) => {
    const b = boxOf(el, id).children.find(
      (box) => (box as LaidBox & { pseudo?: string }).pseudo === which,
    )!;
    return [b.x, b.y];
  };
  assert.deepStrictEqual(pseudo('auto', 'before'), [150, 60]);
  assert.deepStrictEqual(pseudo('auto', 'after'), [40, 10]);
  assert.deepStrictEqual(pseudo('normal', 'before'), [95, 120]);
  assert.deepStrictEqual(pseudo('normal', 'after'), [7, 9]);
  assert.deepStrictEqual(pseudo('none', 'before'), [3, 4]);
});

test("a box is placed against where its anchor's relative offset moved it", async () => {
  // CSS Anchor Positioning 1, 2: an anchor's box is where layout put it,
  // relative positioning included, which is applied after the boxes
  // positioned against it are laid out; the anchor's and the boxes'
  // around it below the containing block, which move only the anchor
  const { node } = await render(
    '<style>body{margin:0}#cb{position:relative;width:400px;height:400px}' +
      '#wrap{position:relative;left:10px}' +
      '#a{position:relative;top:100px;left:100px;width:100px;height:100px;anchor-name:--a}' +
      '.t{position:absolute;position-anchor:--a;width:100px;height:200px}' +
      '#by{top:anchor(bottom);left:anchor(right)}' +
      // a fallback tried against the anchor where it is: above, it would
      // leave the containing block, and below it fits
      '#area{position-area:top center;position-try-fallbacks:flip-block}</style>' +
      '<div id="cb"><div id="wrap"><div id="a"></div></div>' +
      '<div class="t" id="by"></div><div class="t" id="area"></div></div>',
    500,
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('by'), [210, 200]);
  assert.deepStrictEqual(at('area'), [110, 200]);
});

test('an anchor name, a position option name and anchor-scope are of the tree their rule was written in', async () => {
  // CSS Anchor Positioning 1, 2.1 and 2.4, CSS Shadow 1, 3.5: two shadow
  // trees' `--a` are two names; a shadow tree's reference does not find
  // the page's name on its host; a `@position-try` is looked for in the
  // tree whose rule named it and the trees around it; and an
  // `anchor-scope` set through `::part()` scopes the page's names in the
  // part, slotted ones included
  const tree = (n: number) =>
    `<div class="host" id="h${n}"><template shadowrootmode="open"><style>` +
    'div{width:100px;height:100px}.a{anchor-name:--a}' +
    '.t{position:fixed;left:anchor(--a left);top:anchor(--a bottom)}' +
    `</style><div class="a"></div><div class="t" id="t${n}"></div>` +
    '</template></div>';
  const { node } = await render(
    '<style>body{margin:0}.host{width:100px;height:100px}#h2{margin-left:200px}' +
      '@position-try --doc{left:100px}' +
      '.abs{position:absolute;width:10px;height:10px;left:999999px}' +
      '#doc-own{position-try-fallbacks:--own}' +
      '#scoped::part(scope){anchor-scope:--s}' +
      '#s{anchor-name:--s;width:10px;height:10px}' +
      '#under{position:absolute;top:anchor(--s bottom, 1px);width:5px;height:5px}' +
      '</style>' +
      tree(1) +
      tree(2) +
      '<div id="named" style="anchor-name:--h"><template shadowrootmode="open">' +
      '<style>div{position:absolute;left:anchor(--h left, 37px)}</style>' +
      '<div id="in"></div></template></div>' +
      '<div id="tries"><template shadowrootmode="open"><style>' +
      '@position-try --own{left:200px}' +
      '.abs{position:absolute;width:10px;height:10px;left:999999px}' +
      '#own{position-try-fallbacks:--own}#doc{position-try-fallbacks:--doc}' +
      '</style><div class="abs" id="own"></div><div class="abs" id="doc"></div>' +
      '</template></div><div class="abs" id="doc-own"></div>' +
      '<div id="s"></div><div id="scoped" style="position:relative">' +
      '<template shadowrootmode="open"><div part="scope"><slot></slot></div>' +
      '</template><div id="under"></div></div>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('t1'), [0, 100]);
  assert.deepStrictEqual(at('t2'), [200, 200]);
  assert.strictEqual(boxOf(el, 'in').x, 37, 'the fallback');
  assert.strictEqual(boxOf(el, 'own').x, 200);
  assert.strictEqual(boxOf(el, 'doc').x, 100, 'from the tree around it');
  assert.strictEqual(boxOf(el, 'doc-own').x, 999999, "not a shadow tree's");
  const under = boxOf(el, 'under');
  const scoped = boxOf(el, 'scoped');
  assert.strictEqual(under.y - scoped.y, 1, 'scoped away: the fallback');
});

test('anchor-scope keeps an anchor name to the boxes inside the element that scopes it', async () => {
  // CSS Anchor Positioning 1, 2.4: the nearest element around the anchor,
  // itself included, that scopes its name, by the name or by `all`, has
  // to hold the box that looks for it as well
  const scoped = (body: string) =>
    '<style>body{margin:0}main{position:relative;width:100px;height:100px;border-top:1px solid}' +
    '.all{anchor-scope:all}.sa{anchor-scope:--a}.sb{anchor-scope:--b}' +
    '.anchor{anchor-name:--a;height:10px;margin-top:20px}' +
    '#t{position:absolute;position-anchor:--a;top:anchor(bottom);width:5px;height:5px}</style>' +
    `<main>${body}</main>`;
  const top = async (body: string) =>
    boxOf(view((await render(scoped(body), 300)).node), 't').y;
  const t = '<div id="t"></div>';
  // the element that names the anchor scopes it as well
  assert.strictEqual(
    await top(`<div class="sa anchor">${t}</div>`),
    31,
    'scoped by itself',
  );
  // outside, the box finds none, and stays where the flow had it
  assert.strictEqual(
    await top(`${t}<div class="sa"><div class="anchor"></div></div>`),
    1,
  );
  assert.strictEqual(
    await top(`${t}<div class="all"><div class="anchor"></div></div>`),
    1,
  );
  // another name's scope is no matter
  assert.strictEqual(
    await top(`${t}<div class="sb"><div class="anchor"></div></div>`),
    31,
  );
  assert.strictEqual(
    await top(`<div class="all"><div class="anchor"></div>${t}</div>`),
    31,
  );
});

test('a box anchored to something a scroller scrolls moves with it, on the axes its anchors share that scroller, and only an anchor laid out before it is one', async () => {
  const { node } = await render(
    '<style>body{margin:0}#cb{position:relative;width:400px;height:400px}' +
      '#s{width:100px;height:100px;overflow:scroll;position:relative}' +
      '#space{width:300px;height:300px}' +
      '.a{position:absolute;width:20px;height:20px}' +
      '#a1{anchor-name:--a1;left:10px;top:50px}' +
      '.t{position:absolute;width:10px;height:10px}' +
      // both axes against the default anchor
      '#t1{position-anchor:--a1;left:anchor(right);top:anchor(top)}' +
      // across against it, down against the scroller itself
      '#t2{position-anchor:--a1;left:anchor(right);top:anchor(--s bottom)}' +
      '#s{anchor-name:--s}' +
      // a later absolute box of the same name is laid out after it
      '#late{anchor-name:--a1;position:absolute;left:300px;top:300px;width:5px;height:5px}' +
      '</style><div id="cb"><div id="s"><div id="space"></div>' +
      '<div class="a" id="a1"></div></div>' +
      '<div class="t" id="t1"></div><div class="t" id="t2"></div>' +
      '<div id="late"></div></div>',
  );
  const el = view(node);
  const at = (id: string) => {
    const b = boxOf(el, id);
    return [b.x, b.y];
  };
  assert.deepStrictEqual(at('t1'), [30, 50], 'against #a1, not #late');
  assert.deepStrictEqual(at('t2'), [30, 100]);
  el.scrollElementTo(findById(el.document, 's')!, { x: 5, y: 20 });
  assert.deepStrictEqual(at('a1'), [5, 30]);
  assert.deepStrictEqual(at('t1'), [25, 30], 'with its anchor');
  assert.deepStrictEqual(at('t2'), [25, 100], 'across only');
});

test('position-visibility hides a box whose anchor a scroll cuts away, or that overflows its containing block, with what it holds', async () => {
  const { node } = await render(
    '<style>body{margin:0}#s{width:300px;height:100px;overflow:hidden scroll}' +
      '#a{anchor-name:--a;height:100px}#space{height:100px}' +
      '.t{position:absolute;position-anchor:--a;position-area:bottom;width:50px;height:50px}' +
      '#always{position-visibility:always}' +
      '#cb{position:relative;width:200px;height:120px}' +
      '#b{anchor-name:--b;width:50px;height:100px}' +
      '#over{position:absolute;position-anchor:--b;position-area:bottom;' +
      'width:50px;height:50px;position-visibility:no-overflow}' +
      '</style><div id="s"><div id="a"></div><div id="space"></div>' +
      '<div class="t" id="seen"><div id="inner" style="position:absolute;z-index:1"></div></div>' +
      '<div class="t" id="always"></div></div>' +
      '<div id="cb"><div id="b"></div><div id="over"></div></div>',
  );
  const el = view(node);
  const hidden = (id: string) => CLAMPED.has(boxOf(el, id) as never);
  assert.strictEqual(hidden('seen'), false);
  // the anchor is 100 tall, and 70 of the 100 its containing block has
  // under it are what the box needs: it overflows
  assert.strictEqual(hidden('over'), true, 'no-overflow');
  el.scrollElementTo(findById(el.document, 's')!, { y: 100 });
  assert.strictEqual(hidden('seen'), true, 'its anchor scrolled away');
  assert.strictEqual(hidden('always'), false, 'always is always');
  el.scrollElementTo(findById(el.document, 's')!, { y: 50 });
  assert.strictEqual(hidden('seen'), false, 'and back');
});

test('a box anchored to an anchored box a scroll moves moves with it, and one anchored to a sticky box with where it sticks', async () => {
  // CSS Anchor Positioning 1, 3.3: a default anchor's remembered scroll
  // offset takes in what moves it with a scroll — a default scroll shift
  // of its own, where it is anchored itself (a chain), and `position:
  // sticky` — and a box anchored to it moves with it
  const { node } = await render(
    '<style>body{margin:0}div{width:100px;height:100px}' +
      '#s{overflow:scroll}#a{anchor-name:--a1;height:20px}' +
      '#one{position:absolute;position-anchor:--a1;left:anchor(left);' +
      'top:anchor(bottom);anchor-name:--a2}' +
      '#two{position:absolute;position-anchor:--a2;left:anchor(left);' +
      'top:anchor(bottom)}' +
      '#k{overflow:scroll;position:absolute;left:200px;top:0}' +
      '#stuck{anchor-name:--s;position:sticky;top:0;height:20px}' +
      '#under{position:absolute;position-anchor:--s;left:anchor(left);' +
      'top:anchor(bottom);height:10px}' +
      '</style><div id="s"><div style="height:230px"></div><div id="a"></div>' +
      '<div style="height:230px"></div></div>' +
      '<div id="one"></div><div id="two"></div>' +
      '<div id="k"><div style="height:50px"></div><div id="stuck"></div>' +
      '<div style="height:300px"></div></div><div id="under"></div>',
  );
  const el = view(node);
  const top = (id: string) => boxOf(el, id).y;
  assert.deepStrictEqual([top('one'), top('two')], [250, 350]);
  el.scrollElementTo(findById(el.document, 's')!, { y: 200 });
  assert.deepStrictEqual([top('one'), top('two')], [50, 150], 'the chain');
  assert.strictEqual(top('under'), 70);
  // scrolled past where it sticks: held at the scroller's top, and the
  // box below it with it
  el.scrollElementTo(findById(el.document, 'k')!, { y: 200 });
  assert.deepStrictEqual([top('stuck'), top('under')], [0, 20]);
});

test('position-visibility hides a box whose anchor is not seen: hidden by visibility, or in a box it hides', async () => {
  // 5.4: `anchors-visible` asks whether the default anchor is visible, so
  // a box anchored inside one `position-visibility` hid goes with it, and
  // `visibility` hiding the anchor hides it, and showing it shows it
  const { node } = await render(
    '<style>body{margin:0}#s{overflow:hidden scroll;width:300px;height:100px}' +
      '#a1{anchor-name:--a1;width:100px;height:100px}.space{height:100px}' +
      '.t{position:absolute;top:0;left:0;position-area:bottom;width:100px;' +
      'height:50px}#chained{position-anchor:--a1}' +
      '#a2{anchor-name:--a2;height:50px}#target{position-anchor:--a2}' +
      '#hid{visibility:hidden}#h{anchor-name:--h;height:20px}' +
      '#shy{position:absolute;position-anchor:--h;position-area:bottom;' +
      'width:20px;height:20px}' +
      '</style><div id="s"><div id="a1"></div><div class="space"></div>' +
      '<div class="t" id="chained"><div id="a2"></div></div>' +
      '<div class="t" id="target"></div></div>' +
      '<div id="hid"><div id="h"></div></div><div id="shy"></div>',
  );
  const el = view(node);
  const hidden = (id: string) => CLAMPED.has(boxOf(el, id) as never);
  assert.deepStrictEqual([hidden('chained'), hidden('target')], [false, false]);
  el.scrollElementTo(findById(el.document, 's')!, { y: 100 });
  assert.deepStrictEqual(
    [hidden('chained'), hidden('target')],
    [true, true],
    'its anchor in a box hidden with its own anchor',
  );
  assert.strictEqual(hidden('shy'), true, 'visibility: hidden');
  // and shown by a restyle that shows its anchor
  const hid = findById(el.document, 'hid') as unknown as {
    attribs: Record<string, string>;
  };
  hid.attribs.style = 'visibility:visible';
  await act(() =>
    el.touchDocument([
      { type: 'attributes', target: hid as never, attributeName: 'style' },
    ]),
  );
  await act();
  assert.strictEqual(hidden('shy'), false, 'shown');
});

test('a box anchored to something a scroller scrolls tries its position options again where a scroll leaves it overflowing, and keeps the one it has while it fits', async () => {
  // WPT anchor-scroll-position-try-001: the box keeps the option it was
  // last placed by while that fits, shifted by the scroll (CSS Anchor
  // Positioning 1, 6.5.1.1), and where it does not, each other option is
  // tried where the anchor is now (6.5) — its own first
  const { node } = await render(
    '<style>body{margin:0}#cb{position:relative;width:400px;height:399px;transform:scale(1)}' +
      '#s{width:400px;height:400px;overflow:scroll}' +
      '#a{width:100px;height:100px;anchor-name:--a;margin:300px 275px 300px 150px}' +
      '#t{position:absolute;width:100px;height:100px;position-anchor:--a;' +
      'position-try-fallbacks:--left, --right;left:anchor(left);bottom:anchor(top)}' +
      '@position-try --left { right: anchor(left); top: anchor(top); bottom: auto; left: auto }' +
      '@position-try --right { left: anchor(right); top: anchor(top); bottom: auto }' +
      '</style><div id="cb"><div id="s"><div id="a"></div></div><div id="t"></div></div>',
    600,
  );
  const el = view(node);
  const side = () => {
    const a = boxOf(el, 'a');
    const t = boxOf(el, 't');
    if (t.y + t.height === a.y && t.x === a.x) return 'top';
    if (t.x + t.width === a.x && t.y === a.y) return 'left';
    if (t.x === a.x + a.width && t.y === a.y) return 'right';
    return `nowhere: ${t.x},${t.y} by ${a.x},${a.y}`;
  };
  const scroller = findById(el.document, 's')!;
  const scrolled = async (x: number, y: number) => {
    el.scrollElementTo(scroller, { x, y });
    // the layout that tries them is the next frame's
    await act();
    return side();
  };
  assert.strictEqual(side(), 'top');
  assert.strictEqual(await scrolled(0, 200), 'top', 'touching the top');
  assert.strictEqual(await scrolled(0, 201), 'left', 'over it by a pixel');
  assert.strictEqual(await scrolled(0, 1), 'left', 'which still fits');
  assert.strictEqual(await scrolled(0, 0), 'top', 'which no longer does');
  assert.strictEqual(await scrolled(51, 249), 'right');
});

/** A document in a pane 400 by 200 that scrolls it. */
async function paned(source: string) {
  await renderX11(
    h(
      'box',
      {
        'data-testname': 'pane',
        style: { width: 400, height: 200, overflow: 'scroll' },
      },
      h(Html, { source, partial: false, 'data-testname': 'doc' }),
    ),
    { width: 440, height: 300, fonts: FONTS! },
  );
  await act();
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const pane = screen.getByTestName('pane') as DrawnNode & {
    scrollTo(y: number): void;
  };
  const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
  const scrolled = async (y: number) => {
    await act(async () => pane.scrollTo(y));
    await act();
  };
  return { el, rect, scrolled };
}

metric(
  'a box fixed to the viewport follows an anchor the pane scrolls, and a box in the document a fixed anchor',
  async () => {
    // CSS Anchor Positioning 1, 3.3: the default scroll shift, which a
    // scroll of the pane makes as a scroll container's does, laying nothing
    // out; and the options tried again where it leaves the box overflowing
    // what it is placed in — at an edge of the viewport's, since the edges
    // that are the anchor's move with it
    const { rect, scrolled } = await paned(
      '<style>body{margin:0}#a{anchor-name:--a;margin:160px 0 0 50px;width:60px;height:20px}' +
        '#tip{position:fixed;position-anchor:--a;top:anchor(bottom);left:anchor(left);' +
        'width:40px;height:30px;position-try-fallbacks:flip-block}' +
        '#bar{position:fixed;top:20px;left:300px;width:10px;height:10px;anchor-name:--f}' +
        '#under{position:absolute;position-anchor:--f;top:anchor(bottom);left:anchor(left);' +
        'width:10px;height:10px}</style><div id="a"></div><div id="tip"></div>' +
        '<div id="bar"></div><div id="under"></div><div style="height:2000px"></div>',
    );
    const at = (id: string) => [rect(id).x, rect(id).y];
    // below the anchor is past the viewport's foot: above it
    assert.deepStrictEqual(at('tip'), [50, 130]);
    assert.deepStrictEqual(at('under'), [300, 30]);
    await scrolled(20);
    assert.deepStrictEqual(at('a'), [50, 160]);
    assert.deepStrictEqual(
      at('tip'),
      [50, 130],
      'with its anchor, still above',
    );
    assert.deepStrictEqual(at('under'), [300, 50], 'with the fixed one');
    // above it is over the viewport's top: below it
    await scrolled(140);
    assert.deepStrictEqual(at('tip'), [50, 180]);
    assert.deepStrictEqual(at('under'), [300, 170]);
    await scrolled(0);
    assert.deepStrictEqual(at('tip'), [50, 130], 'and back');
  },
);

metric(
  'position-visibility hides a box fixed to the viewport whose anchor the pane scrolls out of it, or over its edge',
  async () => {
    const { el, scrolled } = await paned(
      '<style>body{margin:0}.a{height:20px;width:20px}#a{anchor-name:--a;margin-top:100px}' +
        '#b{anchor-name:--b;margin-top:20px}' +
        '.t{position:fixed;width:20px;height:20px;left:0}' +
        '#seen{position-anchor:--a;top:anchor(bottom)}' +
        '#fits{position-anchor:--b;bottom:anchor(top);position-visibility:no-overflow}' +
        '</style><div class="a" id="a"></div><div class="a" id="b"></div>' +
        '<div class="t" id="seen"></div><div class="t" id="fits"></div>' +
        '<div style="height:2000px"></div>',
    );
    const hidden = (id: string) => CLAMPED.has(boxOf(el, id) as never);
    assert.strictEqual(hidden('seen'), false);
    assert.strictEqual(hidden('fits'), false);
    // its anchor half out of the viewport's top
    await scrolled(110);
    assert.strictEqual(hidden('seen'), false);
    // and all of it out: anchors-visible, the initial value
    await scrolled(130);
    assert.strictEqual(hidden('seen'), true, 'its anchor scrolled away');
    await scrolled(120);
    assert.strictEqual(hidden('fits'), false, 'at the top of the viewport');
    await scrolled(121);
    assert.strictEqual(hidden('fits'), true, 'no-overflow: over it');
    await scrolled(0);
    assert.strictEqual(hidden('seen'), false, 'and back');
    assert.strictEqual(hidden('fits'), false);
  },
);

test("an anchor is its element's own box, not the label inside it", async () => {
  const { node } = await render(
    '<style>body{margin:0}#wrap{position:relative;width:300px;height:200px}' +
      'button{position:absolute;left:100px;top:40px;width:80px;height:30px;' +
      'anchor-name:--b}' +
      '#tip{position:absolute;position-anchor:--b;position-area:bottom;' +
      'width:20px;height:10px}</style>' +
      '<div id="wrap"><button>Go</button><div id="tip"></div></div>',
  );
  const tip = boxOf(view(node), 'tip');
  // below the button's border box, centred on it
  assert.deepStrictEqual([tip.x, tip.y], [130, 70]);
});

test('position-area places a box in the cells around its anchor, aligned towards it', async () => {
  const { node } = await render(
    anchored(
      '.t{position:absolute;position-anchor:--b;width:20px;height:10px}' +
        '#top{position-area:top}' +
        '#br{position-area:bottom right}' +
        '#sl{position-area:span-left top}' +
        '#center{position-area:center}' +
        '#end{position-area:end}' +
        '#fit{position:absolute;position-anchor:--b;position-area:right}',
      '<div class="t" id="top"></div><div class="t" id="br"></div>' +
        '<div class="t" id="sl"></div><div class="t" id="center"></div>' +
        '<div class="t" id="end"></div>' +
        '<div id="fit"><span style="display:inline-block;width:30px;height:5px">' +
        '</span></div>',
    ),
  );
  const el = view(node);
  const at = (id: string) => {
    const b = boxOf(el, id);
    return [b.x, b.y];
  };
  // above the anchor, centred on it: the end of the row before it
  assert.deepStrictEqual(at('top'), [120, 10]);
  // below and right of it: the start of the cells after it
  assert.deepStrictEqual(at('br'), [160, 50]);
  // the left and the anchor's columns, at their end: the anchor's right
  assert.deepStrictEqual(at('sl'), [140, 10]);
  assert.deepStrictEqual(at('center'), [120, 30]);
  // `end` both ways, a block axis first: below and right
  assert.deepStrictEqual(at('end'), [160, 50]);
  // sized to its content in its cells, centred down the anchor's row
  const fit = boxOf(el, 'fit');
  assert.deepStrictEqual(
    [fit.x, fit.width, fit.y + fit.height / 2],
    [160, 30, 35],
  );
});

test('position-area aligns a box in its cells less its insets, towards the anchor or centred on it', async () => {
  // WPT position-area-align-justify: the cells are the containing block
  // the insets are against, and `normal` aligns the box in what they
  // leave — towards the anchor, or on its centre where the cells are all
  // three tracks of the axis (CSS Anchor Positioning 1, 4.1)
  const areas = [
    ['span-all', 145, 145],
    ['top left', 75, 70],
    ['top center', 150, 70],
    ['top right', 225, 70],
    ['center left', 75, 140],
    ['bottom right', 225, 210],
    ['top span-left', 175, 70],
    ['top span-right', 125, 70],
    ['span-top left', 75, 170],
    ['span-bottom left', 75, 110],
  ] as const;
  const { node } = await render(
    '<style>body{margin:0}#c{position:relative;width:300px;height:300px}' +
      '#a{position:absolute;left:100px;top:100px;width:100px;height:100px;anchor-name:--a}' +
      '.t{position:absolute;position-anchor:--a;width:10px;height:10px;' +
      'top:10px;right:15px;bottom:20px;left:25px}</style><div id="c"><div id="a"></div>' +
      areas
        .map(
          ([area], i) =>
            `<div class="t" id="t${i}" style="position-area:${area}"></div>`,
        )
        .join('') +
      '</div>',
    400,
  );
  const el = view(node);
  areas.forEach(([area, x, y], i) => {
    const b = boxOf(el, `t${i}`);
    assert.deepStrictEqual([b.x, b.y], [x, y], area);
  });
});

test("the position-area grid reaches an anchor past its containing block's edge", async () => {
  // WPT position-area-anchor-partially-outside: the grid's outer lines are
  // the containing block's, or the anchor's where it is further out
  // (3.1.1), so a box stretched in the cells reaches the anchor's far edge
  const areas = [
    ['span-all', 0, -50, 450, 450],
    ['left span-all', 0, -50, 350, 450],
    ['right span-all', 450, -50, 0, 450],
    ['top span-all', 0, -50, 450, 0],
    ['bottom span-all', 0, 50, 450, 350],
  ] as const;
  const { node } = await render(
    '<style>body{margin:0}#c{position:relative;width:400px;height:400px;margin:100px}' +
      '#a{position:absolute;right:-50px;top:-50px;width:100px;height:100px;anchor-name:--a}' +
      '.t{position:absolute;position-anchor:--a;place-self:stretch}</style>' +
      '<div id="c"><div id="a"></div>' +
      areas
        .map(
          ([area], i) =>
            `<div class="t" id="t${i}" style="position-area:${area}"></div>`,
        )
        .join('') +
      '</div>',
    700,
  );
  const el = view(node);
  areas.forEach(([area, x, y, w, h], i) => {
    const b = boxOf(el, `t${i}`);
    assert.deepStrictEqual(
      [b.x - 100, b.y - 100, b.width, b.height],
      [x, y, w, h],
      area,
    );
  });
});

test('anchor-center centres a box on its anchor in what its insets leave, as wide as its content there', async () => {
  // WPT anchor-center-htb-htb: an `auto` inset is nought, the box is as
  // wide as its content in the rectangle its insets leave, and it is
  // centred on the anchor as far as it can be inside that rectangle
  // (CSS Anchor Positioning 1, 4.2; CSS Box Alignment 3, 4.4.1.2)
  const cases = [
    ['', 100, 0],
    ['max-width:60px', 60, 35],
    ['left:20px', 80, 20],
    ['right:20px', 80, 0],
    ['right:-20px', 120, 0],
    ['max-width:100px;right:-20px', 100, 15],
    ['left:10px;right:20px', 70, 10],
    ['left:-10px;right:-50px', 160, -10],
  ] as const;
  // content 180px wide at most, which wraps to any width
  const content =
    '<div style="display:flex;flex-wrap:wrap">' +
    '<i style="display:block;flex:none;width:10px;height:5px"></i>'.repeat(18) +
    '</div>';
  const { node } = await render(
    '<style>body{margin:0}#c{width:100px;height:100px;border:3px solid;position:relative}' +
      '#a{anchor-name:--a;position:relative;width:50px;height:50px;left:40px;top:40px}' +
      '.t{position:absolute;position-anchor:--a;justify-self:anchor-center;' +
      'top:anchor(bottom);height:20px}</style><div id="c"><div id="a"></div>' +
      cases
        .map(
          ([css], i) =>
            `<div class="t" id="t${i}" style="${css}">${content}</div>`,
        )
        .join('') +
      '</div>',
    400,
  );
  const el = view(node);
  cases.forEach(([css, width, x], i) => {
    const b = boxOf(el, `t${i}`);
    assert.deepStrictEqual([b.width, b.x - 3, b.y - 3], [width, x, 90], css);
  });
});

test('anchor-center makes auto margins nought, and is center for a box with no default anchor', async () => {
  // WPT anchor-center-004 and no-anchor-anchor-center
  const { node } = await render(
    '<style>body{margin:0}#c{position:relative;width:200px;height:200px}' +
      '#a{anchor-name:--a;position:relative;width:50px;height:50px;left:30px;top:20px}' +
      '.t{position:absolute;width:24px;height:24px}' +
      '#justify{position-anchor:--a;justify-self:anchor-center;top:anchor(bottom);margin-inline:auto}' +
      '#align{position-anchor:--a;align-self:anchor-center;right:anchor(left);margin-block:auto}' +
      '#none{place-self:anchor-center;inset:0}' +
      '#both{position-anchor:--a;place-self:anchor-center}</style>' +
      '<div id="c"><div id="a"></div><div class="t" id="justify"></div>' +
      '<div class="t" id="align"></div><div class="t" id="none"></div>' +
      '<div class="t" id="both"></div></div>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  // the anchor's centre is at 55, 45
  assert.strictEqual(at('justify')[0], 43);
  assert.strictEqual(at('align')[1], 33);
  assert.deepStrictEqual(at('none'), [88, 88], 'centred in its insets');
  assert.deepStrictEqual(at('both'), [43, 33]);
});

test('justify-self and align-self align an absolute box between two insets, as wide as its content', async () => {
  // CSS Position 3, 4.3: aligned in its inset-modified containing block
  // where neither inset is `auto`, and sized to its content there; `auto`
  // margins and one `auto` inset place it as they always did
  const { node } = await render(
    '<style>body{margin:0}#c{position:relative;width:300px;height:200px}' +
      '.t{position:absolute;inset:10px}i{display:block;width:40px;height:20px}' +
      '#centre{place-self:center}' +
      '#end{justify-self:end;align-self:end}' +
      '#margins{place-self:center;margin:auto 0 0 auto}' +
      '#one{place-self:center;inset:10px auto auto 10px}' +
      '#fill{place-self:stretch}</style><div id="c">' +
      '<div class="t" id="centre"><i></i></div><div class="t" id="end"><i></i></div>' +
      '<div class="t" id="margins"><i></i></div><div class="t" id="one"><i></i></div>' +
      '<div class="t" id="fill"><i></i></div></div>',
  );
  const el = view(node);
  const at = (id: string) => {
    const b = boxOf(el, id);
    return [b.x, b.y, b.width, b.height];
  };
  assert.deepStrictEqual(at('centre'), [130, 90, 40, 20]);
  assert.deepStrictEqual(at('end'), [250, 170, 40, 20]);
  // the margins take what is left, and the box fills it
  assert.deepStrictEqual(at('margins'), [10, 10, 280, 180]);
  assert.deepStrictEqual(at('one'), [10, 10, 40, 20], 'at its one inset');
  assert.deepStrictEqual(at('fill'), [10, 10, 280, 180]);
});

test('an anchor() in a math function is the edge it reads, and its fallback where there is no anchor', async () => {
  const { node } = await render(
    anchored(
      '.t{position:absolute;position-anchor:--b;width:20px;height:10px}' +
        '#gap{top:calc(anchor(bottom) + 8px);left:calc(anchor(left) - 1em);font-size:10px}' +
        '#mid{left:calc((anchor(left) + anchor(right)) / 2)}' +
        '#cap{top:max(anchor(top), 40px)}' +
        // no anchor of the name: the fallback in its place, or `auto`
        '#lost{top:calc(anchor(--nobody bottom, 7px) + 3px);left:calc(anchor(--nobody left) + 5px)}' +
        // and the calls flipped with the rest of the box
        '#flip{bottom:calc(anchor(top) + 5px);height:40px;position-try-fallbacks:flip-block}',
      '<div class="t" id="gap"></div><div class="t" id="mid"></div>' +
        '<div class="t" id="cap"></div><div class="t" id="lost"></div>' +
        '<div class="t" id="flip"></div>',
    ),
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('gap'), [90, 58]);
  assert.strictEqual(at('mid')[0], 130);
  assert.strictEqual(at('cap')[1], 40);
  assert.deepStrictEqual(at('lost'), [0, 10]);
  // above the anchor is 15 - 40, over the top: below it, 5px past it
  assert.strictEqual(at('flip')[1], 55);
});

test('a box too big for its cells is held in its containing block, which is no position that fits', async () => {
  // CSS Anchor Positioning 1, 4.1 and 6.5: a box overflowing its cells
  // shifts to stay inside its containing block (CSS Box Alignment 3,
  // 4.4.1.2), and still overflows its inset-modified containing block,
  // which is what a position option has to fit — as are insets that go
  // past each other, which leave nought of it
  const { node } = await render(
    anchored(
      '.t{position:absolute;position-anchor:--b;width:40px;height:30px}' +
        '#held{position-area:top}' +
        '#cells{position-area:top;position-try-fallbacks:flip-block}' +
        '#past{top:anchor(bottom);bottom:anchor(top);position-try-fallbacks:--right}' +
        '@position-try --right { top: anchor(top); bottom: auto; left: anchor(right) }',
      '<div class="t" id="held"></div><div class="t" id="cells"></div>' +
        '<div class="t" id="past"></div>',
      10,
    ),
  );
  const el = view(node);
  // the 10px above the anchor's top are too few: at the top of the
  // containing block, over the anchor
  assert.strictEqual(boxOf(el, 'held').y, 0);
  // and with somewhere else to go, below it
  assert.strictEqual(boxOf(el, 'cells').y, 40);
  assert.deepStrictEqual([boxOf(el, 'past').x, boxOf(el, 'past').y], [160, 10]);
});

test('position-try-fallbacks places a box that overflows by the first option that fits, which anchored() asks', async () => {
  const blue = parseColor('#0000ff');
  const doc = (top: number, fallbacks: string) =>
    render(
      anchored(
        '#tip{position:absolute;position-anchor:--b;position-area:top;' +
          `width:80px;height:20px;position-try-fallbacks:${fallbacks};` +
          'container-type:anchored}' +
          '#arrow{color:#000000}' +
          '@container anchored(fallback: flip-block) { #arrow{color:#0000ff} }' +
          '@container anchored(fallback) { #any{color:#0000ff} }' +
          '@container anchored(fallback: none) { #none{color:#0000ff} }',
        '<div id="tip"><span id="arrow">v</span><span id="any">a</span>' +
          '<span id="none">n</span></div>',
        top,
      ),
    );
  const colour = (node: Parameters<typeof view>[0], id: string) =>
    (boxOf(view(node), id) as unknown as { style: { color: string } }).style
      .color;
  // room above the anchor: its own position
  const fits = await doc(30, 'flip-block');
  assert.deepStrictEqual(
    [boxOf(view(fits.node), 'tip').x, boxOf(view(fits.node), 'tip').y],
    [90, 10],
  );
  assert.notStrictEqual(colour(fits.node, 'arrow'), blue);
  assert.notStrictEqual(colour(fits.node, 'any'), blue);
  assert.strictEqual(colour(fits.node, 'none'), blue);
  // 10px above it: over the top of the containing block, so flipped below
  const flipped = await doc(10, 'flip-block');
  assert.deepStrictEqual(
    [boxOf(view(flipped.node), 'tip').x, boxOf(view(flipped.node), 'tip').y],
    [90, 40],
  );
  assert.strictEqual(colour(flipped.node, 'arrow'), blue);
  assert.strictEqual(colour(flipped.node, 'any'), blue);
  assert.notStrictEqual(colour(flipped.node, 'none'), blue);
  // the first option that fits: a position area to the right, after one
  // that does not fit either
  const area = await doc(10, 'flip-inline, right');
  assert.deepStrictEqual(
    [boxOf(view(area.node), 'tip').x, boxOf(view(area.node), 'tip').y],
    [160, 15],
  );
  assert.notStrictEqual(colour(area.node, 'arrow'), blue);
  assert.strictEqual(colour(area.node, 'any'), blue);
});

test('a @position-try rule is an option of its own', async () => {
  const { node } = await render(
    anchored(
      // the rule's insets in place of the box's own, `bottom` among them:
      // left as it was, it and `top` would leave the box no room at all,
      // which is no option that fits (CSS Anchor Positioning 1, 6.5)
      '@position-try --under { top: anchor(bottom); left: anchor(left);' +
        ' bottom: auto; position-area: none; color: red }' +
        '#tip{position:absolute;position-anchor:--b;bottom:anchor(top);' +
        'left:anchor(left);width:40px;height:20px;' +
        'position-try-fallbacks:--missing, --under}',
      '<div id="tip"></div>',
      10,
    ),
  );
  const tip = boxOf(view(node), 'tip');
  // above would be at -10: the rule's position under the anchor instead,
  // past one naming no rule
  assert.deepStrictEqual([tip.x, tip.y], [100, 40]);
});

/** Where each of a document's elements is drawn, in CSS pixels, by id. */
function drawnAt(node: Parameters<typeof view>[0]) {
  const el = view(node);
  return (id: string) => {
    const r = el.elementRect(findById(el.document, id)!)!;
    return [r.x, r.y, r.width, r.height];
  };
}

test("a box anchored in a vertical writing mode is placed in the page's axes, its logical sides its containing block's", async () => {
  // CSS Anchor Positioning 1, 3.2: an inset's physical side is the page's,
  // `start` and `end` the containing block's writing mode's and `self-start`
  // its own's; `anchor-size(inline)` the containing block's inline size.
  // The boxes are laid out in the frame the vertical flow turns
  // (`layout/writing.ts`), and placed where the page has them.
  const { node } = await render(
    '<style>body{margin:0}.cb{position:relative;width:600px;height:400px}' +
      '#a,#b{width:100px;height:50px}' +
      '#a{anchor-name:--a;margin:100px 200px 0 0}' +
      '#b{anchor-name:--b;margin:100px 0 0 200px}' +
      '.t{position:absolute;width:10px;height:10px}' +
      '#plain{left:30px;top:40px}' +
      '#phys{left:anchor(--a right);top:anchor(--a bottom)}' +
      '#logical{left:anchor(--a start);top:anchor(--a end)}' +
      '#self{writing-mode:horizontal-tb;left:anchor(--a self-start)}' +
      '#sized{width:anchor-size(--a inline);top:0;left:0}' +
      '#lr{left:anchor(--b start);top:anchor(--b start)}' +
      '</style>' +
      '<div class="cb" style="writing-mode:vertical-rl"><div id="a"></div>' +
      '<div class="t" id="plain"></div><div class="t" id="phys"></div>' +
      '<div class="t" id="logical"></div><div class="t" id="self"></div>' +
      '<div class="t" id="sized"></div></div>' +
      '<div class="cb" style="writing-mode:vertical-lr;direction:rtl">' +
      '<div id="b"></div><div class="t" id="lr"></div></div>',
  );
  const at = drawnAt(node);
  // the anchor 200px in from the right, where `vertical-rl` starts
  assert.deepStrictEqual(at('a'), [300, 100, 100, 50]);
  assert.deepStrictEqual(at('plain'), [30, 40, 10, 10]);
  assert.deepStrictEqual(at('phys'), [400, 150, 10, 10]);
  // across the block axis starts at the right, down the inline at the top
  assert.deepStrictEqual(at('logical'), [400, 150, 10, 10]);
  // its own writing mode is horizontal, and starts across at the left
  assert.deepStrictEqual(at('self').slice(0, 1), [300]);
  // its containing block's inline axis is down the page
  assert.deepStrictEqual(at('sized'), [0, 0, 50, 10]);
  // `vertical-lr` starts across at the left, and a right-to-left one down
  // at the bottom
  assert.deepStrictEqual(at('b'), [200, 750, 100, 50]);
  assert.deepStrictEqual(at('lr'), [200, 800, 10, 10]);
});

test("a position-area and the tactics read the containing block's writing mode, in the page's axes", async () => {
  // 3.1.1 and 4.1: `block-start` is the right in `vertical-rl`, and
  // `inline-end` the bottom; `flip-block` mirrors the box across, which is
  // its block axis
  const { node } = await render(
    '<style>body{margin:0}.cb{position:relative;width:400px;height:300px;' +
      'writing-mode:vertical-rl}' +
      '#a{anchor-name:--a;width:100px;height:100px;margin:100px 280px 0 0}' +
      '#area{position:absolute;position-anchor:--a;' +
      'position-area:block-start inline-end;width:10px;height:10px}' +
      '#flip{position:absolute;position-anchor:--a;right:anchor(left);' +
      'top:anchor(top);width:50px;height:10px;' +
      'position-try-fallbacks:flip-block}' +
      '</style>' +
      '<div class="cb"><div id="a"></div><div id="area"></div>' +
      '<div id="flip"></div></div>',
  );
  const at = drawnAt(node);
  assert.deepStrictEqual(at('a'), [20, 100, 100, 100]);
  // after the anchor across and down, towards it
  assert.deepStrictEqual(at('area'), [120, 200, 10, 10]);
  // left of the anchor it would be 30px past the containing block's edge:
  // mirrored to its right
  assert.deepStrictEqual(at('flip'), [120, 100, 50, 10]);
});

test("an element laid out in a vertical writing mode's frame is offset as the page has it", async () => {
  // CSSOM View 7: the offset attributes are in the page's axes, which the
  // frame's turn is no transform of the page's (`onPage`)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="cb" style="position:relative;writing-mode:vertical-rl;' +
      'width:300px;height:200px"><div id="a" style="width:30px;height:40px;' +
      'margin:5px 10px"></div></div>',
  );
  const el = view(node);
  const a = el.offsetRect(findById(el.document, 'a')!)!;
  assert.deepStrictEqual([a.x, a.y, a.width, a.height], [260, 5, 30, 40]);
});

test('a box placed by a position option has its style, which getComputedStyle reads, a ::before too', async () => {
  // CSS Anchor Positioning 1, 6.2: the option's styles are the box's
  // computed style, its tactics applied
  const { node } = await render(
    '<style>body{margin:0}#cb{position:relative;width:400px;height:400px}' +
      '@position-try --pf{left:50px;top:50px;min-width:1px;max-height:200px}' +
      '.t{position:absolute;left:99999px;width:30px;height:40px}' +
      '#plain{position-try-fallbacks:--pf}' +
      '#turned{position-try-fallbacks:--pf flip-start}' +
      '#g::before{content:"";position:absolute;left:99999px;width:10px;' +
      'height:10px;position-try-fallbacks:--pf}' +
      '</style><div id="cb"><div class="t" id="plain"></div>' +
      '<div class="t" id="turned"></div><div id="g"></div></div>',
  );
  const el = view(node);
  const cs = (id: string, pseudo: string | null = null) =>
    el.computedStyle(findById(el.document, id)!, pseudo)!;
  const plain = cs('plain');
  assert.deepStrictEqual(
    [plain.left, plain['min-width'], plain['max-height']],
    ['50px', '1px', '200px'],
  );
  const turned = cs('turned');
  assert.deepStrictEqual(
    [turned.width, turned.height, turned['min-height'], turned['max-width']],
    ['40px', '30px', '1px', '200px'],
  );
  const before = cs('g', 'before');
  assert.deepStrictEqual([before.left, before.top], ['50px', '50px']);
});

test('position-try-order tries the options that leave the most room first', async () => {
  // 6.3: sorted by the size of the inset-modified containing block each
  // leaves on the axis it names, `auto` insets nought, ties as written
  const doc = (order: string) =>
    render(
      '<style>body{margin:0}#cb{position:absolute;width:400px;height:400px}' +
        '#a{position:absolute;left:150px;top:200px;width:150px;height:150px;' +
        'anchor-name:--a}' +
        '@position-try --right{inset:unset;left:anchor(right)}' +
        '@position-try --left{inset:unset;right:anchor(left)}' +
        '@position-try --top{inset:unset;bottom:anchor(top)}' +
        `#t{position:absolute;left:450px;width:40px;height:40px;position-anchor:--a;position-try:${order}}` +
        '</style><div id="cb"><div id="a"></div><div id="t"></div></div>',
    );
  const at = async (order: string) => {
    const { node } = await doc(order);
    const b = boxOf(view(node), 't');
    return [b.x, b.y];
  };
  // the first that fits
  assert.deepStrictEqual(await at('--right, --left'), [300, 0]);
  // more room across to the anchor's left
  assert.deepStrictEqual(await at('most-width --right, --left'), [110, 0]);
  // the same room down: as written
  assert.deepStrictEqual(await at('most-height --right, --left'), [300, 0]);
  // more room across above the anchor than to its right
  assert.deepStrictEqual(await at('most-width --right, --top'), [0, 160]);
});

test('the option a layout places a box by is its last successful one only once it is rendered', async () => {
  // 6.5.1.1: HTML keeps the last successful position option as it gathers
  // the resize observations, once a rendering; a layout a script forces
  // before then tries what the last rendering had
  const { node } = await render(
    '<style>#cb{position:relative;width:400px;height:400px}' +
      '#a{position:relative;top:100px;left:100px;width:100px;height:100px;' +
      'anchor-name:--a}' +
      '#t{position:absolute;position-anchor:--a;position-area:top center;' +
      'position-try-fallbacks:flip-block;width:100px;height:200px}' +
      '</style><div id="cb"><div id="a"></div><div id="t"></div></div>',
  );
  const el = view(node);
  const a = findById(el.document, 'a') as unknown as {
    attribs: Record<string, string>;
  };
  const t = findById(el.document, 't')!;
  const top = () => el.offsetRect(t)!.y;
  // no room above the anchor: below it
  assert.strictEqual(top(), 200);
  const move = (y: number) => {
    a.attribs.style = `top:${y}px`;
    el.touchDocument([
      { type: 'attributes', target: a as never, attributeName: 'style' },
    ]);
  };
  // room above it now, and no rendering since
  move(200);
  assert.strictEqual(top(), 0);
  // room on neither side: the one rendered last, not the one forced,
  // held in the containing block
  move(150);
  assert.strictEqual(top(), 200);
});

test('position-area, position-try-fallbacks and anchored() are read', () => {
  const ltr = { mode: 'horizontal-tb', rtl: false } as const;
  const tracks = (
    value: string,
    cb: WritingAxes = ltr,
    own: WritingAxes = ltr,
  ) => {
    const area = parsePositionArea(value)!;
    return [area.text, areaTracks(area, cb, own)];
  };
  assert.deepStrictEqual(tracks('top'), [
    'top',
    { cols: [0, 2], rows: [0, 0] },
  ]);
  // either order, its text the canonical one
  assert.deepStrictEqual(tracks('bottom span-right'), [
    'span-right bottom',
    { cols: [1, 2], rows: [2, 2] },
  ]);
  // a logical keyword read against the containing block's writing mode,
  // and a `self-` one against the box's own: the inline axis down the page
  // where its lines are vertical, and the block axis from the right
  const rtl = { mode: 'horizontal-tb', rtl: true } as const;
  const vrl = { mode: 'vertical-rl', rtl: false } as const;
  const vlrRtl = { mode: 'vertical-lr', rtl: true } as const;
  assert.deepStrictEqual(tracks('block-end inline-start')[1], {
    cols: [0, 0],
    rows: [2, 2],
  });
  assert.deepStrictEqual(tracks('block-end inline-start', rtl)[1], {
    cols: [2, 2],
    rows: [2, 2],
  });
  assert.deepStrictEqual(tracks('block-end inline-start', vrl)[1], {
    cols: [0, 0],
    rows: [0, 0],
  });
  assert.deepStrictEqual(tracks('start start', vlrRtl)[1], {
    cols: [0, 0],
    rows: [2, 2],
  });
  assert.deepStrictEqual(tracks('x-start y-start', vrl)[1], {
    cols: [2, 2],
    rows: [0, 0],
  });
  assert.deepStrictEqual(tracks('self-start self-start', vrl, ltr)[1], {
    cols: [0, 0],
    rows: [0, 0],
  });
  assert.deepStrictEqual(tracks('self-x-start self-y-start', ltr, vrl)[1], {
    cols: [2, 2],
    rows: [0, 0],
  });
  assert.strictEqual(parsePositionArea('none'), null);
  assert.strictEqual(parsePositionArea('top bottom'), undefined);
  assert.strictEqual(parsePositionArea('left nowhere'), undefined);
  assert.deepStrictEqual(
    parseTryFallbacks(
      'flip-block, --a flip-inline, flip-start flip-block, top left',
    )!.map((o) => [o.name, o.tactics, o.area !== null, o.text]),
    [
      [null, ['flip-block'], false, 'flip-block'],
      ['--a', ['flip-inline'], false, '--a flip-inline'],
      [null, ['flip-start', 'flip-block'], false, 'flip-start flip-block'],
      [null, [], true, 'top left'],
    ],
  );
  assert.strictEqual(parseTryFallbacks('none'), null);
  assert.strictEqual(parseTryFallbacks('flip-block flip-block'), undefined);
  assert.deepStrictEqual(
    parseContainerPrelude('anchored(fallback: flip-block)'),
    [
      {
        name: null,
        condition: 'anchored(fallback: flip-block)',
        axes: 0,
        anchored: true,
      },
    ],
  );
  // what each answers, for an option applied and for none
  assert.strictEqual(anchoredHolds('fallback: flip-block', 'flip-block'), true);
  assert.strictEqual(
    anchoredHolds('fallback: flip-inline', 'flip-block'),
    false,
  );
  assert.strictEqual(anchoredHolds('fallback', 'flip-block'), true);
  assert.strictEqual(anchoredHolds('fallback: none', null), true);
  assert.strictEqual(anchoredHolds('not (fallback)', null), true);
  // order counts, and an area matches the cells it takes
  assert.strictEqual(
    anchoredHolds('fallback: flip-block flip-start', 'flip-start flip-block'),
    false,
  );
  assert.strictEqual(anchoredHolds('fallback: left top', 'top left'), true);
  assert.strictEqual(anchoredHolds('fallback: sideways', null), null);
});
