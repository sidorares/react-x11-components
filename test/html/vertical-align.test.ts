// <Html> — vertical-align, and boxes raised and lowered on their line.
import { afterEach } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import {
  baselinesOf,
  boxOf,
  fillsOf,
  fragmentsOf,
  linesOf,
  metric,
  render,
  view,
} from './harness.js';
import type { PaintOp } from './harness.js';

afterEach(cleanup);

metric(
  'a superscript raised as Tailwind and normalize.css raise it',
  async () => {
    // `sup { position: relative; top: -0.5em; vertical-align: baseline }`:
    // the line keeps its height, and the figure is half its own em higher
    const doc = (raise: string) =>
      '<style>p{margin:0;font-size:16px}' +
      `sup{font-size:75%;line-height:0;vertical-align:baseline;${raise}}` +
      '</style><p id="p">E = mc<sup>2</sup> and more</p>';
    const still = fragmentsOf(
      view((await render(doc('position:relative;top:0'))).node),
      'p',
    );
    cleanup();
    const raised = fragmentsOf(
      view((await render(doc('position:relative;top:-0.5em'))).node),
      'p',
    );
    const two = still.findIndex((f) => f.text === '2');
    assert.ok(two >= 0, 'the figure is laid out apart');
    assert.strictEqual(raised[two].y - still[two].y, -6);
    assert.deepStrictEqual(
      raised.map((f) => f.line),
      still.map((f) => f.line),
    );
  },
);

metric('<sup> and <sub> are raised and lowered off the line', async () => {
  // the UA sheet's `vertical-align: super` and `sub`: a third and a fifth
  // of the parent's font size and a pixel, as browsers set them
  const { node } = await render(
    '<style>p{margin:0;font-size:16px}</style>' +
      '<p id="p">E = mc<sup>2</sup> and H<sub>2</sub>O</p>',
  );
  const all = baselinesOf(view(node), 'p');
  const two = all.filter((f) => f.text === '2');
  assert.strictEqual(two.length, 2, 'both figures laid out apart');
  const [sup, sub] = two;
  const base = all.find((f) => f.text.startsWith('E'))!;
  assert.strictEqual(base.at, base.line, 'the text around them is on it');
  assert.ok(Math.abs(base.line - sup.at - (16 / 3 + 1)) < 0.01, 'super');
  assert.ok(Math.abs(sub.at - base.line - (16 / 5 + 1)) < 0.01, 'sub');
});

metric(
  'a raised box makes its line taller, unless its line height is none',
  async () => {
    const heightWith = async (sup: string) => {
      const { node } = await render(
        `<style>p{margin:0;font-size:16px;line-height:20px}sup{${sup}}</style>` +
          '<p id="p">E = mc<sup>2</sup></p>',
      );
      const lines = linesOf(view(node), 'p');
      cleanup();
      return lines[0].height;
    };
    // the paragraph's own line height, 20px, is the line's with nothing
    // in it taller
    assert.ok((await heightWith('')) > 20, 'the raised figure takes room');
    // Tailwind's preflight and normalize.css give it none
    assert.strictEqual(await heightWith('line-height:0'), 20);
  },
);

metric(
  "a line of smaller text alone is as tall as the block's strut",
  async () => {
    // every line box starts with the strut, the block's font at its line
    // height (CSS 2.1 10.8.1); a paragraph laid out as one text had lines
    // only as tall as the small text on them
    const { node } = await render(
      '<style>p{margin:0;width:120px;font-size:16px;line-height:24px}' +
        'small{font-size:10px;line-height:10px}</style>' +
        '<p id="p"><small>several small words that wrap onto more than ' +
        'one line</small></p>' +
        // and the lines a paragraph made a line at a time end as one text
        '<p id="q" style="text-indent:4px"><small>several small words ' +
        'that wrap onto more than one line</small></p>',
    );
    const el = view(node);
    for (const id of ['p', 'q']) {
      const lines = linesOf(el, id);
      assert.ok(lines.length > 1, `#${id} wraps`);
      for (const line of lines) {
        assert.ok(
          line.height >= 24 - 0.01,
          `#${id}: a line ${line.height} tall`,
        );
      }
      for (let i = 1; i < lines.length; i += 1) {
        const above = lines[i - 1];
        assert.ok(
          lines[i].y >= above.y + above.height - 0.01,
          `#${id} overlaps`,
        );
      }
    }
  },
);

metric(
  'vertical-align takes a length, a percentage of the line height, and the edges of the font',
  async () => {
    const { node } = await render(
      '<style>p{margin:0;font-size:16px;line-height:20px}' +
        '#a{vertical-align:6px}#b{vertical-align:-50%}' +
        '#c{vertical-align:text-top;font-size:8px;line-height:8px}' +
        '#d{vertical-align:text-bottom;font-size:8px;line-height:8px}' +
        '</style>' +
        '<p id="p">x <span id="a">a</span> <span id="b">b</span> ' +
        '<span id="c">c</span> <span id="d">d</span></p>',
    );
    const all = baselinesOf(view(node), 'p');
    const at = (t: string) => all.find((f) => f.text === t)!;
    const line = at('a').line;
    assert.ok(Math.abs(line - at('a').at - 6) < 0.01, 'a length raises');
    assert.ok(Math.abs(at('b').at - line - 10) < 0.01, 'half the line lowers');
    // an eight-pixel box's top at the sixteen-pixel font's top, and its
    // bottom at that font's bottom
    assert.ok(at('c').at < line - 4, 'text-top is high');
    assert.ok(at('d').at > line, 'text-bottom is low');
  },
);

metric(
  "an image set middle is centred on its parent's x-height, not on its line",
  async () => {
    // CSS 2.1 10.8.1: its middle half the parent's x-height above the
    // baseline, wherever a taller image beside it puts the line's middle
    const { node } = await render(
      '<style>p{margin:0;font-size:16px;line-height:20px}</style>' +
        '<p id="a">x<img id="m" width="10" height="30" src="x.png" ' +
        'style="vertical-align:middle"></p>' +
        '<p id="b">x<img width="10" height="60" src="x.png">' +
        '<img id="n" width="10" height="30" src="x.png" ' +
        'style="vertical-align:middle"></p>',
    );
    const el = view(node);
    const above = (img: string, p: string) => {
      const box = boxOf(el, img);
      const [line] = linesOf(el, p);
      const { baseline } = line as unknown as { baseline: number };
      return line.y + baseline - (box.y + box.height / 2);
    };
    const alone = above('m', 'a');
    assert.ok(alone > 0 && alone < 8, `half an x-height up: ${alone}`);
    assert.ok(
      Math.abs(above('n', 'b') - alone) < 0.01,
      `and there beside a taller image: ${above('n', 'b')}`,
    );
  },
);

metric(
  "a raised box's background is drawn around its raised text",
  async () => {
    const fills = async (align: string) => {
      const { node } = await render(
        '<style>p{margin:0;font-size:16px;line-height:30px}</style>' +
          // no line height of its own, so that the line stays where it is
          '<p id="p">x <span style="background:#00ff00;line-height:0;' +
          `vertical-align:${align}">y</span></p>`,
      );
      const out = (await fillsOf(view(node))).filter(
        (f) => f.style === '#00ff00',
      );
      cleanup();
      return out;
    };
    const [flat] = await fills('baseline');
    const [raised] = await fills('8px');
    assert.deepStrictEqual(
      [raised.x, raised.y, raised.w, raised.h],
      [flat.x, flat.y - 8, flat.w, flat.h],
    );
  },
);

metric(
  "a top-aligned box's background is drawn around its own text",
  async () => {
    // its baseline is where the line's top puts it, not the line's: in a line
    // made tall by its paragraph, the background stayed on the paragraph's
    // baseline while the text went up
    const around = async (align: string) => {
      const { node } = await render(
        '<style>p{margin:0;font-size:16px;line-height:40px}</style>' +
          '<p id="p">a <span id="s" style="background:#00ff00;line-height:1;' +
          `vertical-align:${align}">x</span></p>`,
      );
      const el = view(node);
      const [fill] = (await fillsOf(el)).filter((f) => f.style === '#00ff00');
      // on the baseline it is laid out with the text before it
      const x = baselinesOf(el, 'p').find((f) => f.text.includes('x'))!;
      cleanup();
      return x.at - fill.y;
    };
    assert.ok(
      Math.abs((await around('top')) - (await around('baseline'))) < 0.01,
      'as far above its baseline as on the baseline',
    );
  },
);

metric(
  'a box whose padding reaches up over the line before is drawn over its text',
  async () => {
    // CSS 2.1 Appendix E paints a block a line at a time, backgrounds first:
    // the second line's padding covers the first line's text
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<p style="margin:0;font-size:16px;line-height:20px">first line<br>' +
        '<span style="background:#00ff00;padding-top:20px">second</span></p>',
    );
    const ops: PaintOp[] = [];
    await fillsOf(view(node), ops);
    const text = ops.findIndex((op) => op.op === 'text');
    const again = ops.findIndex(
      (op, i) => i > text && op.op === 'fill' && op.style === '#00ff00',
    );
    assert.ok(text >= 0 && again > text, 'filled again after the text');
    const clip = ops
      .slice(text, again)
      .reverse()
      .find((op): op is Extract<PaintOp, { op: 'clip' }> => op.op === 'clip');
    assert.ok(
      clip && clip.y + clip.h <= 21,
      `only above its own line: ${JSON.stringify(clip)}`,
    );
  },
);

metric(
  'a top-aligned box sits at the top of its line, as tall as all it holds',
  async () => {
    // its baseline is its tallest content's ascent below the line's top,
    // the big letter in it included (CSS 2.1 10.8.1)
    const { node } = await render(
      '<style>p{margin:0;font-size:16px;line-height:40px}' +
        '#t{vertical-align:top;font-size:10px;line-height:10px}' +
        '#big{font-size:30px;line-height:30px}</style>' +
        '<p id="p">x <span id="t">t<span id="big">B</span></span></p>',
    );
    const el = view(node);
    const all = baselinesOf(el, 'p');
    const [line] = linesOf(el, 'p');
    // the box's text on one baseline, whether the big letter is a fragment
    // of its own (its box has a line height of its own) or not
    const t = all.find((f) => f.text.startsWith('t'))!;
    const big = all.find((f) => f.text.includes('B'))!;
    assert.ok(Math.abs(t.at - big.at) < 0.01, `${t.at} and ${big.at}`);
    // the big letter's ascent, not the box's own small font's, from the top
    assert.ok(t.at - line.y > 20, `${t.at - line.y} below the line's top`);
    assert.ok(t.at < all.find((f) => f.text.startsWith('x'))!.at);
  },
);

metric(
  'an image set top beside text leaves the text at the top of the line',
  async () => {
    // where the baseline goes in a line a `top` or `bottom` box made taller
    // than the rest is left open (CSS 2.1 10.8.1). Browsers keep it where
    // the rest of the line puts it, under its top, unless a `bottom` box is
    // the taller; the text was centred in what the image left
    const { node } = await render(
      '<style>p{margin:0;font-size:16px}' +
        'img{width:96px;height:96px}</style>' +
        '<p id="t"><img style="vertical-align:top">Filler</p>' +
        '<p id="b"><img style="vertical-align:bottom">Filler</p>',
    );
    const el = view(node);
    const [top] = linesOf(el, 't');
    const [bottom] = linesOf(el, 'b');
    assert.strictEqual(top.height, 96);
    assert.ok(top.baseline < 20, `under the line's top: ${top.baseline}`);
    assert.ok(bottom.baseline > 80, `at its foot: ${bottom.baseline}`);
  },
);

metric(
  "a raised text's underline from outside it stays on the line's baseline",
  async () => {
    // `vertical-align` moves the text, not the lines an element outside it
    // draws through it; an underline the raised box sets itself goes with
    // it (CSS Text Decoration 3, 2.1)
    const rules = async (inner: string) => {
      const { node } = await render(
        '<style>p{margin:0;font-size:16px;line-height:40px;' +
          'text-decoration:underline;text-decoration-color:#ff00ff}' +
          'span{text-decoration-color:#00ffff}</style>' +
          `<p id="p">aaa <span style="vertical-align:10px;${inner}">bbb</span> ccc</p>`,
      );
      const fills = await fillsOf(view(node));
      cleanup();
      return fills;
    };
    const outside = (await rules('')).filter((f) => f.style === '#ff00ff');
    assert.ok(outside.length >= 2, 'the underline is drawn');
    assert.strictEqual(
      new Set(outside.map((f) => f.y)).size,
      1,
      'all of it on one line',
    );
    // the longhand: `text-decoration: underline` would reset the colour
    // the sheet gave the span, as a shorthand does
    const own = await rules('text-decoration-line:underline');
    const a = own.find((f) => f.style === '#ff00ff')!;
    const b = own.find((f) => f.style === '#00ffff')!;
    assert.ok(Math.abs(a.y - b.y - 10) <= 1, 'the raised one goes with it');
  },
);

metric(
  'a raised box is as tall on its line as its own face makes it',
  async () => {
    // a `<sup>` holding a smaller `<a>` — every footnote mark — made its
    // line no taller than the `<a>` did, and an empty raised box none; each
    // inline box is on the line with its own line height (CSS 2.1 10.8)
    const { node } = await render(
      '<style>body{margin:0;font:16px/1.6 serif}p{margin:0}</style>' +
        '<p id="plain">text</p>' +
        '<p id="mark">text<sup><a style="font-size:11px">1</a></sup></p>' +
        '<p id="sup">text<sup>1</sup></p>' +
        '<p id="empty">text<span style="vertical-align:super"></span></p>' +
        '<p id="full">text<span style="vertical-align:super">x</span></p>',
    );
    const el = view(node);
    const height = (id: string) => boxOf(el, id).height;
    assert.ok(height('sup') > height('plain') + 0.5, 'a raised mark');
    assert.ok(
      Math.abs(height('mark') - height('sup')) < 0.01,
      `the sup's own: ${height('mark')} against ${height('sup')}`,
    );
    assert.ok(
      Math.abs(height('empty') - height('full')) < 0.01,
      `an empty one's: ${height('empty')} against ${height('full')}`,
    );
  },
);
