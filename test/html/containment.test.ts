// <Html> — overflow, clipping and containment.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, expectPixel, waitFor } from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import {
  RED_PNG,
  boxOf,
  clipsAround,
  documentText,
  fillsIn,
  fillsOf,
  findById,
  metric,
  render,
  renderWithBytes,
  view,
} from './harness.js';
import type { PaintOp, ReplacedBox } from './harness.js';

afterEach(cleanup);

metric(
  'a positioned box a clipping box holds makes the document no taller',
  async () => {
    // The document scrolls its scrollable overflow, and that takes in a
    // positioned box only where no box on the way to it clips it (CSS
    // Overflow 3, 2.2): one inside a box that clips it is that box's to
    // scroll. One whose containing block is outside the clipping box is not
    // clipped by it and still counts. Every positioned box counted, and a
    // page a browser shows no taller than its window scrolled on into blank
    const { node } = await render(
      '<style>body{margin:0}.clip{position:absolute;top:50px;width:100px;' +
        'height:150px;overflow:hidden}.deep{position:absolute;top:900px;' +
        'width:50px;height:50px}.flow{overflow:hidden;height:20px}' +
        '.out{position:absolute;top:400px;left:200px;width:10px;height:10px}' +
        '</style><div class="clip"><div class="deep"></div></div>' +
        '<div class="flow"><div class="out"></div></div>',
    );
    const el = view(node);
    await act();
    assert.strictEqual(
      el.abs.height,
      410,
      'as tall as the box that escapes its clip, not the one clipped',
    );
  },
);

metric(
  'what a positioned box holds past its end makes the document taller',
  async () => {
    // A positioned box's scrollable overflow is its border box and what it
    // holds, where it does not clip it (CSS Overflow 3, 2.2), and the
    // document's takes it in. It took the border box alone: design 094 sets
    // its page in an absolute wrapper 497px tall, and its text ran on
    // below the document's end, where no scroll could reach it
    const { node } = await render(
      '<style>body{margin:0}.w{position:absolute;top:0;width:300px;' +
        'height:200px}.t{height:900px}.c{overflow:hidden}</style>' +
        '<div class="w"><div class="t"></div></div>' +
        '<div class="w c"><div class="t" style="height:1500px"></div></div>',
    );
    const el = view(node);
    await act();
    assert.strictEqual(
      el.abs.height,
      900,
      'as tall as what runs past the wrapper, not what a clip cuts',
    );
  },
);

metric(
  'an empty block past the end of the content makes the document no taller',
  async () => {
    // A box of no area adds nothing to the scrollable overflow it is in, as
    // a browser has it: Blink's ScrollableOverflowCalculator unites no
    // empty rect. Design 068 sets html and body a window tall and ends on
    // a block with a 30px bottom margin and five empty ones after it, set
    // below the margin, and the page ran 30px past Chrome's
    const { node } = await render(
      '<style>html,body{height:100%;margin:0}.last{height:900px;' +
        'margin-bottom:30px}</style>' +
        '<div class="last"></div><div></div>' +
        '<div style="width:0;height:5px"></div>',
    );
    const el = view(node);
    await act();
    assert.strictEqual(
      el.abs.height,
      900,
      'as tall as the last block, not the empty ones after its margin',
    );
  },
);

metric('overflow clips what a box holds to its padding box', async () => {
  // HTML mail hides its preheader with `max-height: 0; overflow: hidden`,
  // and a box that did not clip drew it over the message
  const { node } = await render(
    '<div id="o" style="overflow:hidden;width:50px;height:20px;' +
      'padding:2px;border:3px solid #0000ff">' +
      '<div style="width:200px;height:200px;background:#ff0000"></div>' +
      '<div style="position:absolute;width:5px;height:5px;' +
      'background:#00ff00"></div></div>',
  );
  const el = view(node);
  const o = boxOf(el, 'o');
  const ops: PaintOp[] = [];
  await fillsOf(el, ops);
  const [red] = clipsAround(ops, '#ff0000');
  assert.deepStrictEqual(
    red.map((c) => c.op === 'clip' && [c.x, c.y, c.w, c.h]),
    [[Math.round(o.x) + 3, Math.round(o.y) + 3, 54, 24]],
    'the content, clipped to the padding box',
  );
  const [blue] = clipsAround(ops, '#0000ff');
  assert.deepStrictEqual(blue, [], 'and the box itself, not');
  const [green] = clipsAround(ops, '#00ff00');
  assert.deepStrictEqual(
    green,
    [],
    'nor a positioned box whose containing block is outside it',
  );
});

metric(
  "an overflow clip covers the pixels its box's background does",
  async () => {
    // A background at a fractional position rounds to the nearest pixel. A
    // clip rounded out to whole pixels let a row of what it clips show
    // beyond the background's edge, which a 2x display turns up.
    const { node } = await render(
      '<div style="height:10.5px"></div>' +
        '<div style="overflow:hidden;width:50px;height:20px;background:#0000ff">' +
        '<div style="height:200px;background:#ff0000"></div></div>',
    );
    const ops: PaintOp[] = [];
    const fills = await fillsOf(view(node), ops);
    const blue = fills.find((f) => f.style === parseColor('#0000ff'))!;
    const [[clip]] = clipsAround(ops, '#ff0000');
    assert.deepStrictEqual(
      clip.op === 'clip' && [clip.x, clip.y, clip.w, clip.h],
      [blue.x, blue.y, blue.w, blue.h],
    );
  },
);

metric('what a box clipped to no area holds is not painted', async () => {
  // A menu at `max-height: 0`: clipped to an empty rectangle, what it held
  // was painted through a mask the size of the window, which is what an
  // empty rectangle is to the context, and a nest of them made one at
  // every level. An absolute box whose containing block is outside it
  // still shows.
  const { node } = await render(
    '<div style="max-height:0;overflow:hidden">' +
      '<div style="height:20px;background:#ff0000"></div></div>' +
      '<div style="height:0;overflow:hidden">' +
      '<div style="position:absolute;top:50px;width:20px;height:20px;' +
      'background:#0000ff"></div></div>',
  );
  const fills = await fillsOf(view(node));
  const painted = (color: string) =>
    fills.some((f) => f.style === parseColor(color));
  assert.ok(!painted('#ff0000'), 'what it holds');
  assert.ok(painted('#0000ff'), 'an absolute box outside its clip');
});

metric(
  'a rounded box clips rounded only where its padding leaves a corner to cut',
  async () => {
    const { node } = await render(
      '<div style="overflow:hidden;border-radius:6px;padding:8px">' +
        '<div style="height:10px;background:#ff0000"></div></div>' +
        '<div style="overflow:hidden;border-radius:6px;padding:8px 4px">' +
        '<div style="height:10px;background:#0000ff"></div></div>',
    );
    const ops: PaintOp[] = [];
    await fillsOf(view(node), ops);
    const [[red]] = clipsAround(ops, '#ff0000');
    assert.strictEqual(
      red.op === 'clip' && red.radii,
      null,
      'padding past every corner both ways: a rectangle clips the same',
    );
    const [[blue]] = clipsAround(ops, '#0000ff');
    assert.deepStrictEqual(
      blue.op === 'clip' && blue.radii,
      [6, 6, 6, 6],
      'a side thinner than its corner: rounded',
    );
  },
);

test('overflow: clip cuts what overflows, and is no scroll container', async () => {
  // It was read as `hidden`: a formatting context of its own, and no
  // automatic minimum for a flex item (CSS Overflow 3, 3.1)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;flex-direction:column;height:10px">' +
      '<div id="a" style="overflow:clip"><div style="height:50px"></div>' +
      '</div></div>' +
      '<div id="b" style="overflow:clip"><p id="c" style="margin:20px 0">x' +
      '</p></div>' +
      '<div id="d" style="overflow-x:hidden"></div>' +
      '<div id="e" style="overflow-x:clip"></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 50, 'its content is its least');
  assert.strictEqual(
    boxOf(el, 'c').y,
    boxOf(el, 'b').y,
    'a margin in it collapses through its top',
  );
  const overflow = (id: string) => {
    const style = (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
    return [style.overflowX, style.overflowY];
  };
  // beside a value that scrolls, `visible` is `auto`; beside `clip`, it
  // stays
  assert.deepStrictEqual(overflow('d'), ['hidden', 'auto']);
  assert.deepStrictEqual(overflow('e'), ['clip', 'visible']);
});

test('contain: size lays a box out as though it held nothing', async () => {
  // `contain` was dropped whole (CSS Containment 2): a size-contained box
  // is its `contain-intrinsic-size`, or nothing, whatever it holds
  const { el } = await renderWithBytes(
    '<style>body{margin:0} .w{width:120px;height:30px}</style>' +
      '<div id="a" style="float:left;contain:size"><div class="w"></div>' +
      '</div>' +
      '<div id="b" style="float:left;contain:size;' +
      'contain-intrinsic-size:70px 40px;padding:5px"><div class="w"></div>' +
      '</div>' +
      // `inline-size` holds its width and leaves its height its content's
      '<div id="c" style="float:left;contain:inline-size;' +
      'contain-intrinsic-width:25px"><div class="w"></div></div>' +
      '<div id="d" style="contain:strict;contain-intrinsic-height:15px">' +
      '<div class="w"></div></div>' +
      // an image is as though it had no size or ratio of its own
      '<img id="e" src="r.png" style="contain:size;display:block;' +
      'width:80px">' +
      // but the one its width and height attributes give it
      '<img id="f" src="r.png" width="4" height="2" style="contain:size;' +
      'display:block;width:80px;height:auto">',
    { 'r.png': RED_PNG },
  );
  await waitFor(() =>
    assert.strictEqual((boxOf(el, 'e') as ReplacedBox).replaced, 'image'),
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('a'), [0, 0]);
  assert.deepStrictEqual(size('b'), [80, 50]);
  assert.deepStrictEqual(size('c'), [25, 30]);
  assert.strictEqual(boxOf(el, 'd').height, 15);
  assert.strictEqual(boxOf(el, 'e').height, 0);
  assert.deepStrictEqual(size('f'), [80, 40]);
});

test('layout and paint containment make a formatting context, a containing block and a clip', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      // an absolute box is placed against the box with layout containment
      '<div style="height:20px"></div>' +
      '<div id="a" style="contain:layout;margin-left:30px;height:40px">' +
      '<div id="b" style="position:absolute;left:0;top:0;width:5px;' +
      'height:5px"></div></div>' +
      // which holds its floats, and parts its child's margin from its own
      '<div id="c" style="contain:paint"><div style="float:left;width:5px;' +
      'height:25px"></div></div>' +
      '<div id="d" style="contain:layout"><p id="e" style="margin:10px 0">' +
      'x</p></div>' +
      // and keeps its baseline in: an inline-block with it sits on its
      // bottom, where one without sits on its first line
      '<div style="line-height:20px"><span id="f" style="display:inline-block;' +
      'contain:layout;height:40px">x</span><span id="g" ' +
      'style="display:inline-block;height:40px">x</span></div>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('b'), at('a'));
  assert.strictEqual(boxOf(el, 'c').height, 25, 'its float held in');
  assert.strictEqual(boxOf(el, 'e').y - boxOf(el, 'd').y, 10);
  assert.ok(boxOf(el, 'f').y < boxOf(el, 'g').y, 'sat on its bottom');
});

metric('paint containment clips what overflows', async () => {
  const { result } = await renderWithBytes(
    '<style>body{margin:0;background:#ff0000;' +
      'width:50px;height:100px}</style>' +
      '<div style="contain:paint;width:20px;height:20px">' +
      '<div style="width:60px;height:20px;background:#0000ff"></div></div>',
    {},
  );
  const ctx = result.ctx;
  await expectPixel(ctx, 10, 10, '#0000ff', { message: 'inside the clip' });
  await expectPixel(ctx, 40, 10, '#ff0000', { message: 'clipped' });
});

test("containment keeps the body's background to the body", async () => {
  // it was the canvas's: the whole document red around a 50px body
  const fills = await fillsIn(
    '<html style="contain:layout"><body style="background:#fe0000;' +
      'width:50px;height:40px"></body></html>',
    '#fe0000',
  );
  assert.deepStrictEqual(
    fills.map((f) => [f.w, f.h]),
    [[50, 40]],
  );
});

test('overflow-clip-margin moves the edge overflow: clip cuts at', async () => {
  // it was not read: `overflow: clip` cut at the padding box however far
  // out the margin let what overflows show; a scroller keeps its padding
  // box, and an axis let overflow is not cut (CSS Overflow 4, 3.2)
  const box = (id: string, extra: string) =>
    `<div id="${id}" style="width:100px;height:50px;padding:10px;` +
    `border:5px solid #0000fe;${extra}">` +
    '<div style="height:200px;background:#fe0000"></div></div>';
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      box('a', 'overflow:clip;overflow-clip-margin:20px') +
      box('b', 'overflow:clip;overflow-clip-margin:content-box -2px') +
      box('c', 'overflow:hidden;contain:paint;overflow-clip-margin:20px') +
      box('d', 'overflow-x:clip;overflow-clip-margin:border-box'),
  );
  const el = view(node);
  const ops: PaintOp[] = [];
  await fillsOf(el, ops);
  const top = (id: string) => Math.round(boxOf(el, id).y);
  assert.deepStrictEqual(
    clipsAround(ops, '#fe0000').map(
      ([c]) => c.op === 'clip' && [c.x, c.y, c.w, c.h],
    ),
    [
      [-15, top('a') - 15, 160, 110],
      [17, top('b') + 17, 96, 46],
      [5, top('c') + 5, 120, 70],
      [0, -30000, 130, 60000],
    ],
  );
});

test('an overflow clip edge rounds out as a spread shadow does', async () => {
  // The corners grow with the margin, by less where the radius is small
  // beside it — but an ellipse stays an ellipse (CSS Backgrounds 3, 4.2) —
  // from the padding box's, as browsers draw them
  const clip = async (radius: string, border = '') => {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="width:100px;height:100px;overflow:clip;' +
        `overflow-clip-margin:20px;border-radius:${radius};${border}">` +
        '<div style="height:200px;background:#fe0000"></div></div>',
    );
    const ops: PaintOp[] = [];
    await fillsOf(view(node), ops);
    const [[c]] = clipsAround(ops, '#fe0000');
    const radii = c.op === 'clip' ? c.radii : null;
    return radii?.map((r) => Math.round(r * 100) / 100);
  };
  assert.deepStrictEqual(await clip('50%'), [70, 70, 70, 70]);
  // 5 + 20 × (1 − (1 − 5/20)³ × (1 − 0.1³))
  assert.deepStrictEqual(await clip('5px'), [16.57, 16.57, 16.57, 16.57]);
  // the padding box's 10px, 20px and 30px, moved out by 20px
  assert.deepStrictEqual(
    await clip('0 15px 25px 35px', 'border:5px solid'),
    [0, 27.52, 40, 50],
  );
});

metric('layout containment makes a stacking context', async () => {
  // what is in it is stacked in it, however high its `z-index`: under a
  // positioned box after it
  const { result } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      '<div style="contain:layout;height:20px"><div style="position:absolute;' +
      'z-index:10;width:20px;height:20px;background:#ff0000"></div></div>' +
      '<div style="position:relative;z-index:1;top:-20px;width:20px;' +
      'height:20px;background:#00ff00"></div>',
    {},
  );
  await expectPixel(result.ctx, 10, 10, '#00ff00', { message: 'on top' });
});

test('style containment keeps counters and quotes in its subtree', async () => {
  // a counter made outside is not counted on inside: a new one is made,
  // for the element that counts and its later siblings; and the quotes
  // are as deep after it as they were before it
  const counters = await documentText(
    '<style>div{contain:style;counter-increment:c 123}' +
      'span{counter-increment:c}span::before{content:counter(c)}</style>' +
      '<div><span></span> <span></span></div>',
  );
  assert.ok(counters.includes('1 2'), JSON.stringify(counters));
  const quotes = await documentText(
    '<style>div{quotes:"A" "Z" "1" "9"}div::before,span::before' +
      '{content:open-quote}div::after{content:close-quote}' +
      'span{contain:style}</style><div><span></span></div>',
  );
  assert.ok(quotes.includes('A1Z'), JSON.stringify(quotes));
});

metric(
  "an inline box's padding below its line makes the document taller, where nothing clips it",
  async () => {
    // An inline box's fragments count in the scrollable overflow of the
    // block they are in, their padding and border with them (CSS Overflow
    // 3, 2.2; Blink adds each inline box fragment's border box). Design
    // 150's footer links, 50px of padding under their text, made Chrome's
    // page 19px taller than the box they end
    const page = (wrap: string) =>
      '<style>html,body{margin:0}body{font:16px/20px sans-serif}</style>' +
      `<div style="height:900px"></div><div${wrap}><p style="margin:0">` +
      'text <a id="a" style="padding-bottom:100px">link</a></p></div>';
    const open = await render(page(''));
    const el = view(open.node);
    await act();
    const link = el.elementRect(findById(el.document, 'a')!)!;
    const reach = link.y + link.height;
    assert.ok(reach > 1000, `the link's padding reaches ${reach}`);
    assert.ok(
      Math.abs(el.abs.height - reach) <= 1,
      `and the document with it: ${el.abs.height}`,
    );
    await open.result.unmount();
    // a box that clips what it holds is where the overflow ends
    const clipped = await render(page(' style="overflow:hidden"'));
    const inside = view(clipped.node);
    await act();
    assert.strictEqual(inside.abs.height, 920, 'clipped, the page ends at 920');
    await clipped.result.unmount();
  },
);
