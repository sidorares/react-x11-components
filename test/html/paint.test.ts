// <Html> — painting: order, opacity, masks, the pixel grid, and documents too
// long to draw whole.
import { afterEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { PNG } from 'pngjs';
import {
  act,
  cleanup,
  expectPixel,
  isNear,
  pixelAt,
  renderX11,
  screen,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import type { Context2D } from 'react-x11/node';
import { Html } from '../../src/index.js';
import { HtmlViewNode, restoreAfter, restoreTo } from '../../src/html/node.js';
import { parseColor } from '../../src/html/css/values.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { SpriteStore } from '../../src/html/surfaces.js';
import {
  FONTS,
  SVG_NS,
  atScale2,
  boxOf,
  bytesApart,
  fillsOf,
  h,
  metric,
  pixelsIn,
  pointIn,
  rebuilt,
  render,
  render2x,
  renderScrolled,
  renderWithBytes,
  snapshot,
  svgBytes,
  treeOf,
  view,
} from './harness.js';
import type { LaidBox, PaintOp } from './harness.js';

afterEach(cleanup);

test('an inline-block on a line is painted once', async () => {
  // the line paints what is placed on it, and the paragraph's own walk
  // over its children must not paint it again: a translucent fill drawn
  // twice is twice as opaque, and text twice as heavy
  const { node } = await render(
    '<p>a <span style="display:inline-block;width:13px;height:11px;' +
      'background:rgba(0,0,255,0.5)"></span> <img width="7" height="5"> b</p>',
  );
  const fills = await fillsOf(view(node));
  assert.strictEqual(fills.filter((f) => f.w === 13 && f.h === 11).length, 1);
});

metric(
  'an inline-block is painted in its turn among the text of its lines',
  async () => {
    // CSS 2.1 Appendix E, 7.2.1: a line's atomics are painted in the
    // document's order among its text, as one line is before the next —
    // as Chrome, Firefox and Safari paint them. Painted after all of the
    // block's text, an inline-block a negative margin had a word after it
    // drawn over went over the word, and over the next line it hung into.
    const css =
      '<style>body{margin:0;font:20px/20px monospace}section{height:60px}' +
      '.a{display:inline-block;vertical-align:top;width:100px;height:20px;' +
      'background:#ff0000}.s{background:#0000ff;color:transparent}</style>';
    const { node, result } = await render(
      css +
        // a span after it on its line, its background and all
        '<section><span class="a" style="margin-right:-100px"></span>' +
        '<span class="s">xxxx</span></section>' +
        // the next line, which it hangs into
        '<section><span class="a" style="height:40px;margin-bottom:-20px">' +
        '</span><br><span class="s">xxxx</span></section>' +
        // and the text before it, under it
        '<section><span class="s">xxxx</span>' +
        '<span class="a" style="margin-left:-40px"></span></section>',
    );
    const el = view(node);
    const { abs } = el as unknown as { abs: { x: number; y: number } };
    for (const [x, y, red] of [
      [10, 10, false],
      [10, 90, false],
      [20, 130, true],
    ] as const) {
      const [r, g, b] = await pixelAt(result.ctx, abs.x + x, abs.y + y);
      assert.strictEqual(
        r > 200 && g < 100 && b < 100,
        red,
        `the inline-block at ${x},${y}: ${r},${g},${b}`,
      );
    }

    // Two of them on a line, each between the texts around it: the text
    // after the first is drawn over it and under the second, and each
    // layout is drawn once.
    const ops: PaintOp[] = [];
    const { node: two } = await render(
      css +
        '<div><span class="a" style="margin-right:-100px"></span>xxxx' +
        '<span class="a" style="margin-left:-20px;margin-right:-80px;' +
        'background:#ffff00"></span>yyyy</div>',
    );
    await fillsOf(view(two), ops);
    const order = ops.flatMap((op) =>
      op.op === 'text'
        ? [`text ${Math.round(op.x)}`]
        : op.op === 'fill' && op.style === parseColor('#ff0000')
          ? ['red']
          : op.op === 'fill' && op.style === parseColor('#ffff00')
            ? ['yellow']
            : [],
    );
    assert.deepStrictEqual(order, ['red', 'text 0', 'yellow', 'text 48']);

    // and where none is over anything after it, the lines are painted in
    // one part, their text and then their atomics, as they always were
    const plain: PaintOp[] = [];
    const { node: one } = await render(
      css + '<div><span class="a"></span>xxxx<span class="a"></span></div>',
    );
    await fillsOf(view(one), plain);
    assert.deepStrictEqual(
      plain.flatMap((op) =>
        op.op === 'text'
          ? ['text']
          : op.op === 'fill' && op.style === parseColor('#ff0000')
            ? ['red']
            : [],
      ),
      ['text', 'red', 'red'],
    );
  },
);

metric(
  'run backgrounds paint under the ink on every line, not just the first',
  async () => {
    // ntk draws a whole layout in one glyph batch, so a highlight reaching a
    // second line must be filled before the batch — filled after, it covers
    // the glyphs. The recorder replaces the layouts' `draw` and asserts every
    // highlight fill lands before any ink.
    const { node } = await render(
      '<style>p{margin:0}.hl{background:#ffee55}</style>' +
        '<p>before <span class="hl">a highlighted stretch of text long enough ' +
        'that it certainly wraps onto the following line</span> after</p>',
      240,
    );
    const el = view(node);
    const tree = (el as unknown as { _tree: unknown })._tree as {
      root: {
        children: unknown[];
        lines: { texts: { layout: { draw(): void } }[] }[] | null;
      };
    };
    const events: string[] = [];
    const patched = new Set<unknown>();
    const patch = (box: {
      children: unknown[];
      lines: { texts: { layout: { draw(): void } }[] }[] | null;
    }): void => {
      for (const line of box.lines ?? []) {
        for (const text of line.texts) {
          if (patched.has(text.layout)) continue;
          patched.add(text.layout);
          text.layout.draw = () => events.push('ink');
        }
      }
      for (const child of box.children) patch(child as typeof box);
    };
    patch(tree.root);

    const { paintDocument } = await import('../../src/html/paint.js');
    let fillStyle: unknown = null;
    paintDocument(
      {
        set fillStyle(v: unknown) {
          fillStyle = v;
        },
        get fillStyle() {
          return fillStyle;
        },
        save() {},
        restore() {},
        fillRect() {
          events.push(fillStyle === '#ffee55' ? 'highlight' : 'fill');
        },
      } as never,
      (el as unknown as { _tree: never })._tree,
      {
        originX: 0,
        originY: 0,
        damage: null,
        selection: null,
        selectionColor: null,
        imageFor: () => null,
      },
    );
    const highlights = events.filter((e) => e === 'highlight').length;
    assert.ok(
      highlights >= 2,
      `the highlight spans lines (${highlights} fills)`,
    );
    const firstInk = events.indexOf('ink');
    const lastHighlight = events.lastIndexOf('highlight');
    assert.ok(firstInk >= 0, 'the ink was drawn');
    assert.ok(
      lastHighlight < firstInk,
      `every highlight fill precedes the ink (last highlight at ${lastHighlight}, first ink at ${firstInk})`,
    );
  },
);

metric('a tall document renders at any scroll depth', async () => {
  // The whole promise: viewport-bounded painting, whatever the height. The
  // background fill, the borders and every glyph batch have to survive X's
  // Int16 coordinates while the element sits hundreds of thousands of
  // pixels tall — scrolled to the middle, there must be ink on screen.
  const para =
    '<p>The quick brown fox jumps over the lazy dog and keeps going for a while longer.</p>';
  const result = await renderX11(
    h(
      'box',
      {
        style: { width: 500, height: 400, overflow: 'scroll' },
        'data-testname': 'scroller',
      },
      h(
        'box',
        { style: { flexDirection: 'column' } },
        h(Html, {
          source: '<style>body{background:#f4f6f8}</style>' + para.repeat(2500),
          partial: false,
          'data-testname': 'doc',
        }),
      ),
    ),
    { width: 540, height: 440, fonts: FONTS! },
  );
  const scroller = screen.getByTestName('scroller') as DrawnNode & {
    scrollTo(to: { y: number }): void;
  };
  const doc = view(screen.getByTestName('doc') as DrawnNode);
  const height = (doc as unknown as { abs: { height: number } }).abs.height;
  assert.ok(height > 60000, `the document is genuinely tall (${height}px)`);
  await act(async () => {
    scroller.scrollTo({ y: Math.round(height / 2) });
  });
  const { countPixels, settle } = await import('react-x11/test');
  await settle(result.app, 3);
  const ink = await countPixels(
    result.ctx,
    { x: 0, y: 0, width: 500, height: 400 },
    '#2d3436',
    60,
  );
  assert.ok(ink > 1000, `text is on screen at half-scroll (${ink} ink pixels)`);
});

metric('a huge <pre> is chunked, renders deep, and still selects', async () => {
  // One box, thousands of hard-broken lines: a single TextLayout would be
  // one glyph batch taller than X can address, so it is laid out in chunks
  // split at newlines — invisible seams, drawable pieces. The selection
  // accessors must agree across the chunk boundaries.
  const LINES = 5000;
  const log = Array.from(
    { length: LINES },
    (_, i) => `line ${i} of the log`,
  ).join('\n');
  const { node } = await render(`<pre>${log}</pre>`, 500);
  const el = view(node);
  const text = el.textContent();
  assert.ok(text.includes('line 4999'), 'every line is in the document text');

  const tree = (
    el as unknown as {
      _tree: { root: { children: { lines: { texts: unknown[] }[] | null }[] } };
    }
  )._tree;
  const pre = tree.root.children.find((b) => b.lines && b.lines.length > 1000);
  assert.ok(pre?.lines, 'the pre laid out');
  const layouts = new Set<unknown>();
  for (const line of pre.lines) {
    for (const t of line.texts) layouts.add((t as { layout: unknown }).layout);
  }
  assert.ok(
    layouts.size > 10,
    `the text is many layouts, not one (${layouts.size})`,
  );

  // A caret deep in the pre round-trips through a chunk that is not the first.
  const at = text.indexOf('line 3000');
  const caret = el.textCaretRect(at);
  assert.ok(caret, 'a deep caret resolves');
  const back = el.textIndexAt(caret.x + 1, caret.y + caret.height / 2);
  assert.ok(Math.abs(back - at) <= 1, `round-tripped to ${back}, wanted ${at}`);

  // A range crossing a chunk boundary yields bands on both sides.
  const boundary = text.indexOf('line 63'); // chunks are 64 hard lines
  const bands = el.textRangeRects(boundary, text.indexOf('line 65'));
  assert.ok(bands.length >= 2, `bands across the seam (${bands.length})`);
});

test("an inline box's background is painted over the text before it that it reaches, and under its own", async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // CSS 2.1 Appendix E, 7.2.1.4: each inline box's background, then what
  // it holds, a line at a time. A paragraph's text was drawn in one batch
  // after every background, so a span a negative margin pulls back over
  // the words before it, and one a small line-height hangs up over the
  // line before (css1/c5504-imrgn-l-005, linebox/line-height-125), was
  // drawn under the text it covers.
  const redIn = async (
    source: string,
    region: [number, number, number, number],
  ) => {
    const result = await renderX11(
      h(
        'box',
        { style: { width: 200, flexDirection: 'column' } },
        h(Html, {
          source:
            '<body style="margin:0;background:#ffffff">' + source + '</body>',
          partial: false,
        }),
      ),
      { width: 240, height: 120, fonts: FONTS! },
    );
    await act();
    const [x, y, width, height] = region;
    const data = await pixelsIn(result.ctx, { x, y, width, height });
    let red = 0;
    let green = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 60) red += 1;
      if (data[i + 1] > 200 && data[i] < 60) green += 1;
    }
    return { red, green };
  };
  const pulled = await redIn(
    '<div style="font:20px/30px monospace;color:#ff0000">MM<span ' +
      'style="margin-left:-24px;background:#00ff00;color:#00ff00">..</span></div>',
    [0, 0, 24, 30],
  );
  assert.ok(
    pulled.green > 100,
    `the span's background is there: ${pulled.green}`,
  );
  assert.strictEqual(
    pulled.red,
    0,
    'and over the words it was pulled back over',
  );
  const hung = await redIn(
    '<div style="font:40px/4px monospace;width:60px;padding-top:40px;' +
      'color:#ff0000">MM <span style="background:#00ff00;color:#00ff00;' +
      'padding-top:30px">MM</span></div>',
    [0, 30, 48, 20],
  );
  assert.ok(hung.green > 100, `the span's background is there: ${hung.green}`);
  assert.strictEqual(hung.red, 0, 'and over the line before it hangs over');
});

test('a box over nothing before it keeps its place under the box it holds and the text', async () => {
  // CSS2 linebox/inline-formatting-context-002: a black inline box with
  // nothing drawn before it holds a white one pushed in by a margin. Taken
  // for one over the text before it, by an empty text at the line's start,
  // the black box was put off past all the text and over the white box
  const ops: PaintOp[] = [];
  const { node } = await render(
    '<style>div { display: inline; background: #000000 }' +
      ' div div { background: #ffffff; margin-left: 100px }</style>' +
      '<div>\n <div>Filler Text</div>\n</div>',
  );
  await fillsOf(view(node), ops);
  const at = (color: string) =>
    ops.findIndex((o) => o.op === 'fill' && o.style === parseColor(color));
  // the text the line ends with, "Filler Text"
  const text = ops.map((o) => o.op).lastIndexOf('text');
  assert.ok(
    at('#000000') >= 0 && at('#ffffff') > at('#000000'),
    'white over black',
  );
  assert.ok(text > at('#ffffff'), 'and the text over both');
});

test('on a layout that cannot be drawn in pieces, a background over the text before it is painted as before', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // CoreText's layouts on macOS, as any engine's but ntk's, cannot be cut
  // a line at a time (`onlyOf`), so the interleave leaves them: the
  // block's backgrounds are painted first and its text drawn whole, once,
  // as before. Here ntk's layouts are stood in for by copies that are no
  // ntk layouts.
  for (const source of [
    '<div style="font:20px/30px monospace;color:#ff0000">MM<span ' +
      'style="margin-left:-24px;background:#00ff00">..</span></div>',
    '<div style="font:40px/4px monospace;width:60px;padding-top:40px">' +
      'MM <span style="background:#00ff00;padding-top:30px">MM</span></div>',
  ]) {
    const { node } = await render(source);
    const el = view(node);
    type T = {
      lines: { texts: { layout: object }[] }[] | null;
      children: T[];
    };
    const copies = new Map<object, object>();
    const foreign = (b: T): void => {
      for (const line of b.lines ?? []) {
        for (const text of line.texts) {
          let copy = copies.get(text.layout);
          if (!copy) {
            copy = Object.assign({}, text.layout);
            copies.set(text.layout, copy);
          }
          text.layout = copy;
        }
      }
      b.children.forEach(foreign);
    };
    const tree = (el as unknown as { _tree: { root: T } })._tree;
    foreign(tree.root);
    const ops: PaintOp[] = [];
    await fillsOf(el, ops);
    const green = ops.findIndex(
      (o) => o.op === 'fill' && o.style === parseColor('#00ff00'),
    );
    const texts = ops.filter((o) => o.op === 'text');
    assert.ok(green >= 0, "the span's background is painted");
    assert.strictEqual(texts.length, copies.size, 'each layout drawn once');
    assert.ok(ops.indexOf(texts[0]) > green, 'after the background, as before');
    // where ntk's own are drawn in pieces, with the background among them
    const own: PaintOp[] = [];
    await fillsOf(view((await render(source)).node), own);
    const ownGreen = own.findIndex(
      (o) => o.op === 'fill' && o.style === parseColor('#00ff00'),
    );
    assert.ok(
      own.slice(0, ownGreen).some((o) => o.op === 'text') &&
        own.slice(ownGreen).some((o) => o.op === 'text'),
      'text before the background and after it',
    );
  }
});

test('an element at no opacity is not drawn, and at half is drawn faded', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // `opacity` was read and never painted, so the control a page keeps at
  // `opacity: 0` until its row is hovered — meetup.com's "Homepage" behind
  // its logo, the share button on each event card — was drawn over what it
  // hides. At 0 nothing in the element is drawn, a positioned child
  // included; between, each thing drawn is multiplied by it.
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<body style="margin:0;background:#ffffff">' +
          '<div style="opacity:0;height:20px;background:#ff0000">' +
          '<div style="position:absolute;left:40px;top:0;width:20px;' +
          'height:20px;background:#0000ff"></div></div>' +
          '<div style="opacity:0.5;height:20px;background:#ff0000"></div>' +
          '</body>',
        partial: false,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  await expectPixel(result.ctx, 10, 10, '#ffffff', {
    message: 'the transparent block is not drawn',
  });
  await expectPixel(result.ctx, 50, 10, '#ffffff', {
    message: 'nor its positioned child',
  });
  await expectPixel(result.ctx, 10, 30, '#ff8080', {
    tolerance: 3,
    message: 'the half-opaque block is its colour at half over the page',
  });
});

test('plus-lighter adds what a box draws to what is under it, inside the box that isolates it', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // CSS Compositing 2: a view transition's old and new images cross-fade so,
  // and at any two opacities that come to 1 they are the element itself;
  // drawn over each other, two halves came to three quarters of it
  const pair = (blend: string) =>
    '<div style="position:relative;isolation:isolate;height:20px">' +
    ['0.25', '0.75']
      .map(
        (o) =>
          `<div style="position:absolute;inset:0;opacity:${o};` +
          `mix-blend-mode:${blend};background:#00ff00"></div>`,
      )
      .join('') +
    '</div>';
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<body style="margin:0;background:#ffffff">' +
          pair('plus-lighter') +
          pair('normal') +
          '</body>',
        partial: false,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  await expectPixel(result.ctx, 10, 10, '#00ff00', {
    tolerance: 3,
    message: 'the two add up to the colour, over the page',
  });
  await expectPixel(result.ctx, 10, 30, '#30ff30', {
    tolerance: 3,
    message: 'drawn over each other, they let the page through',
  });
});

test('on X11, multiply and screen blend a box with what is under it', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // vercel.com's "New" badges: a pill painted after the word it marks,
  // `multiply` in the light theme and `screen` in the dark. ntk's context
  // takes canvas's blend modes where the server has RENDER 0.11, which
  // node-x11's in-process one composites; before, the pill was drawn as
  // `normal` here and hid the word
  const pill = (blend: string, page: string, word: string, ink: string) =>
    `<div style="position:relative;height:20px;background:${page}">` +
    `<div style="position:absolute;left:10px;top:5px;width:20px;height:10px;background:${word}"></div>` +
    `<div style="position:absolute;left:5px;top:0;width:40px;height:20px;` +
    `mix-blend-mode:${blend};background:${ink}"></div>` +
    '</div>';
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<body style="margin:0">' +
          pill('multiply', '#ffffff', '#000000', '#eaeaea') +
          pill('screen', '#000000', '#ffffff', '#333333') +
          '</body>',
        partial: false,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  const at = (x: number, y: number, want: string, message: string) =>
    expectPixel(result.ctx, x, y, want, { tolerance: 1, message });
  await at(20, 10, '#000000', 'black multiplied by the pill is black');
  await at(7, 10, '#eaeaea', 'white multiplied by it is the pill');
  await at(60, 10, '#ffffff', 'and the page beside it is white');
  await at(20, 30, '#ffffff', 'white screened by the pill is white');
  await at(7, 30, '#333333', 'black screened by it is the pill');
  await at(60, 30, '#000000', 'and the page beside it is black');
});

/** Surfaces whose contexts record the colour of each fill made on them. */
function fillingSurfaces(made: { fills: string[] }[]) {
  return () => {
    const rec = { fills: [] as string[] };
    made.push(rec);
    const ctx = {
      fillStyle: '' as unknown,
      globalAlpha: 1,
      shadowColor: 'rgba(0, 0, 0, 0)',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      bezierCurveTo() {},
      closePath() {},
      rect() {},
      roundRect() {},
      clip() {},
      transform() {},
      translate() {},
      drawImage() {},
      fillRect() {
        rec.fills.push(String(ctx.fillStyle));
      },
      fill() {
        rec.fills.push(String(ctx.fillStyle));
      },
    };
    return { getContext: () => ctx };
  };
}

const BADGE =
  '<style>body{margin:0;font:14px sans-serif;background:#fafafa}' +
  '.badge{position:relative;display:inline-flex;padding:0 8px;' +
  'line-height:20px;border-radius:9999px;color:#171717}' +
  '.badge::before{content:"";position:absolute;inset:0;' +
  'border-radius:9999px;pointer-events:none;mix-blend-mode:multiply;' +
  'background:#e0e0e0}</style>' +
  '<a>Connect <span class="badge">New</span></a>';

test('a box that blends is painted as a group, and drawn over what is under it with the operation for its blend mode', async () => {
  // CSS Compositing 1, 3.2: vercel.com's footer marks its links "New" with
  // a pill drawn by a `::before` over the word, absolutely positioned and so
  // painted after it, and multiplied with what is under it, the word among
  // it. Every mode but `plus-lighter` was drawn as `normal`, and the pill
  // hid the word. On a context that takes `multiply` — react-x11's macOS
  // one, CoreGraphics' own — the pill is painted on a surface of its own
  // and that is drawn with the operation, after the text
  const { node } = await render(BADGE);
  const pill = String(parseColor('#e0e0e0'));
  const ops: PaintOp[] = [];
  const made: { fills: string[] }[] = [];
  await fillsOf(view(node), ops, {
    surface: fillingSurfaces(made),
    composites: ['multiply', 'screen', 'lighter'],
  });
  const blended = ops.findIndex(
    (o) => o.op === 'image' && o.composite === 'multiply',
  );
  assert.ok(blended >= 0, 'the pill is drawn with `multiply`');
  const texts = ops.flatMap((o, i) => (o.op === 'text' ? [i] : []));
  assert.ok(texts.length >= 2, 'both words are drawn');
  assert.ok(
    texts.every((i) => i < blended),
    'over the text, which it blends with',
  );
  assert.ok(
    !ops.some((o) => o.op === 'fill' && o.style === pill),
    'and not on the window',
  );
  assert.deepStrictEqual(
    made.map((s) => s.fills.filter((f) => f === pill).length),
    [1],
    'but on its own surface',
  );
  // where the context has no such operation — ntk's on an X server below
  // RENDER 0.11 — it is drawn as `normal`, as it was
  const flat: PaintOp[] = [];
  await fillsOf(view(node), flat, {
    surface: fillingSurfaces([]),
    composites: ['lighter'],
  });
  assert.ok(
    !flat.some((o) => o.op === 'image'),
    'no group where it cannot be blended',
  );
  assert.ok(
    flat.some((o) => o.op === 'fill' && o.style === pill),
    'the pill is drawn on the window',
  );
});

test('on X11, the word under a multiplied badge shows through it', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // the badge's own markup, the word alone in the window: drawn as
  // `normal`, the pill's #e0e0e0 covers all of it, and nothing is darker
  const result = await renderX11(
    h(
      'box',
      { style: { width: 120, flexDirection: 'column' } },
      h(Html, {
        source: BADGE.replace('<a>Connect <span', '<a><span'),
        partial: false,
      }),
    ),
    { width: 140, height: 40, fonts: FONTS },
  );
  const pixels = await pixelsIn(result.ctx, {
    x: 0,
    y: 0,
    width: 120,
    height: 20,
  });
  let darkest = 255;
  for (let i = 0; i < pixels.length; i += 4)
    darkest = Math.min(darkest, pixels[i], pixels[i + 1], pixels[i + 2]);
  assert.ok(
    darkest < 0x60,
    `the word shows through the pill: its darkest is ${darkest}`,
  );
});

test('a block in the flow with a blend mode is a stacking context, painted after the blocks in the flow around it', async () => {
  // CSS Compositing 1, 3.2: it is painted as a layer, as one under full
  // opacity is, after the backgrounds of the blocks that follow it; and as
  // one, so that its group, not each thing in it, is what is blended
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="mix-blend-mode:screen;height:20px;margin-bottom:-10px;' +
      'background:#ff0000"></div>' +
      '<div style="height:20px;background:#0000ff"></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    surface: fillingSurfaces([]),
    composites: ['screen'],
  });
  const blue = String(parseColor('#0000ff'));
  const under = ops.findIndex((o) => o.op === 'fill' && o.style === blue);
  const blended = ops.findIndex(
    (o) => o.op === 'image' && o.composite === 'screen',
  );
  assert.ok(under >= 0, 'the block after it is drawn');
  assert.ok(blended > under, 'and the one that blends over it');
});

test('a block inside an inline element is faded with it', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // CSS 2.1 9.2.1.1: the block breaks the inline box in pieces and stands
  // outside it, and is still its content, which the inline box's opacity
  // fades as a group (WPT's stacking-context/opacity-affects-block-in-inline).
  // Around two inline boxes, it takes both.
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<body style="margin:0;background:#ffffff">' +
          '<span style="opacity:0.5"><div style="height:20px;' +
          'background:#ff0000"></div></span>' +
          '<span style="opacity:0.5"><b style="opacity:0.5">' +
          '<div style="height:20px;background:#ff0000"></div></b></span>' +
          '</body>',
        partial: false,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  await expectPixel(result.ctx, 10, 10, '#ff8080', {
    tolerance: 3,
    message: 'the block is its colour at half over the page',
  });
  await expectPixel(result.ctx, 10, 30, '#ffc0c0', {
    tolerance: 3,
    message: 'and at a quarter inside two such boxes',
  });
});

test("a block inside a positioned inline element is painted at the element's z-index", async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // CSS 2.1 9.2.1.1: the block the inline box is broken around is still its
  // content, painted in its layer, over a layer of a lower `z-index` it was
  // painted under in the flow (WPT's stacking-context/
  // zindex-affects-block-in-inline); and one of a higher `z-index` is over
  // it still
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<body style="margin:0;background:#ffffff">' +
          '<div style="position:relative;z-index:1;height:20px;' +
          'background:#ff0000"></div>' +
          '<span style="position:relative;z-index:2;top:-20px">' +
          '<div style="height:20px;background:#00ff00"></div></span>' +
          '<div style="position:relative;z-index:3;top:-40px;height:20px;' +
          'width:100px;background:#0000ff"></div></body>',
        partial: false,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  await expectPixel(result.ctx, 150, 10, '#00ff00', {
    message: 'over the layer under its z-index',
  });
  await expectPixel(result.ctx, 50, 10, '#0000ff', {
    message: 'and under the one over it',
  });
});

/** How tall each row of a `ROWS` document is, a case a row. */
const ROW = 30;

const ROWS =
  '<style>body{margin:0;font:20px sans-serif;background:#ffffff}' +
  `div,p{margin:0;height:${ROW}px;line-height:${ROW}px}</style>`;

/** The least of each channel over a row of a `ROWS` document: where text
 *  or a rule is drawn there, the colour a pixel its ink covers whole is. */
async function expectLeast(
  ctx: unknown,
  row: number,
  want: string,
  message: string,
): Promise<void> {
  const data = await pixelsIn(ctx, {
    x: 0,
    y: row * ROW,
    width: 200,
    height: ROW,
  });
  const least: [number, number, number] = [255, 255, 255];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) least[c] = Math.min(least[c], data[i + c]);
  }
  assert.ok(
    isNear(least, want, 3),
    `${message}: ${want}, where it is ${least.join(', ')}`,
  );
}

metric(
  "an inline element's own text, background and rules are faded with it",
  async () => {
    // CSS Color 4, 3.2: an inline box under full opacity is a group, and
    // what its block's lines draw of it is its content. Only a block inside
    // one was faded: its text, its background and the rules through its
    // text were drawn at full strength. In two such boxes, by both.
    const { result } = await render(
      ROWS +
        '<div><span style="opacity:.5;color:#ff0000">HHHH</span></div>' +
        '<div><span style="opacity:.5;background:#ff0000;padding:0 20px">' +
        '&nbsp;</span></div>' +
        '<div><span style="opacity:.5;color:transparent;' +
        'text-decoration:underline;text-decoration-color:#0000ff;' +
        'text-decoration-thickness:4px">HHHH</span></div>' +
        '<div><span style="opacity:.5"><b style="opacity:.5;color:#ff0000">' +
        'HHHH</b></span></div>' +
        '<div style="height:60px;line-height:20px">&nbsp;<br><span ' +
        'style="opacity:.5;background:#ff0000;padding-top:16px">x</span></div>' +
        '<div style="height:60px;line-height:20px">&nbsp;<br><span ' +
        'style="background:rgba(255,0,0,.5);padding-top:16px">x</span></div>' +
        '<div><span style="opacity:.5;background:#0000ff;' +
        'background-clip:text;color:transparent">HHHH</span></div>' +
        '<div><span style="opacity:.5;background:linear-gradient(#0000ff,' +
        '#0000ff);background-clip:text;color:transparent">HHHH</span></div>',
    );
    await expectLeast(result.ctx, 0, '#ff8080', 'the text, half over the page');
    await expectLeast(result.ctx, 1, '#ff8080', 'the background');
    await expectLeast(result.ctx, 2, '#8080ff', 'the underline');
    await expectLeast(result.ctx, 3, '#ffc0c0', 'a quarter in two of them');
    // its background drawn through its text, a colour and a gradient
    await expectLeast(result.ctx, 8, '#8080ff', 'the background in the text');
    await expectLeast(result.ctx, 9, '#8080ff', 'and a gradient');
    // its padding over the line above, drawn again over that line's text
    // (`paintBleeds`), as a background of its colour at half is
    const bled = await pixelAt(result.ctx, 3, 4 * ROW + 10);
    assert.ok(
      isNear(bled, await pixelAt(result.ctx, 3, 6 * ROW + 10), 2),
      `the padding over the line above: ${bled.join(', ')}`,
    );
  },
);

metric(
  'what is on the lines of a faded inline element is faded with it: an inline-block, a text shadow, a selection',
  async () => {
    // The text and an opacity of 0 selected under a `::selection` that
    // colours it: the highlight is drawn as a part of what the element
    // holds, and none of it shows.
    const { result, node } = await render(
      ROWS +
        '<style>.hid::selection{background:#0000ff;color:#ff0000}' +
        '.band::selection{background:#0000ff}</style>' +
        '<div><span style="opacity:.5"><span style="display:inline-block;' +
        'width:40px;height:20px;background:#ff0000"></span></span></div>' +
        '<div><span style="opacity:.5;color:transparent;' +
        'text-shadow:0 0 0 #0000ff">HHHH</span></div>' +
        '<div><span class="hid" style="opacity:0">HHHH</span></div>' +
        '<div><span class="band" style="opacity:.5;color:transparent">' +
        'HHHH</span></div>',
    );
    await expectLeast(result.ctx, 0, '#ff8080', 'the inline-block');
    await expectLeast(result.ctx, 1, '#8080ff', 'the shadow');
    await act(async () => {
      (node as unknown as { selectAll(): void }).selectAll();
    });
    await expectLeast(result.ctx, 2, '#ffffff', 'nothing of the hidden text');
    await expectLeast(result.ctx, 3, '#8080ff', 'the selection’s band');
  },
);

metric('a faded inline element on a first line is faded there', async () => {
  // In the `::first-line`'s colour alone, and in fonts of its own, where
  // the line's runs are made again in the styles their boxes have on it
  const { result } = await render(
    ROWS +
      '<style>.c::first-line{color:#0000ff}' +
      '.f::first-line{color:#0000ff;font-size:22px}</style>' +
      '<p class="c"><span style="opacity:.5">HHHH</span></p>' +
      '<p class="f"><span style="opacity:.5">HHHH</span></p>',
  );
  await expectLeast(result.ctx, 0, '#8080ff', 'in the colour of the line');
  await expectLeast(result.ctx, 1, '#8080ff', 'and in its fonts');
});

metric(
  "a hover that changes an inline element's opacity is restyled in place, to the pixels a build draws",
  async () => {
    // Its text is laid out again in faded ink, as a colour's change is:
    // its own (#s), the text of an element in it no rule restyled (#o's
    // `<b>`), and a link in a faded element whose colour changes (#l) —
    // and its shadow, its background and an inline-block on its line. A
    // paragraph all of whose text casts one shadow keeps what it casts
    // (#t), and is asked again, and its shadow falls below its line, which
    // the repaint reaches.
    const { result, node } = await render(
      '<style>body{margin:0;font:20px sans-serif;background:#ffffff}' +
        '#s{opacity:.5;color:#ff0000;background:#ffff00;' +
        'text-shadow:2px 2px 0 #00ffff}#s:hover{opacity:.25}' +
        '#o{opacity:.8}#o:hover{opacity:.4}' +
        '#q{opacity:.5}#l{color:#0000ee}#l:hover{color:#00aa00}' +
        '#t{opacity:.5;text-shadow:0 16px 0 #00ffff}' +
        '#t:hover{opacity:.25}</style>' +
        '<p>text with <span id="s">a span <span style="display:' +
        'inline-block;width:20px;height:10px;background:#0000ff"></span>' +
        '</span> in it</p>' +
        '<p><span id="o">an <b>outer</b> one</span></p>' +
        '<p><span id="q">a <a id="l">link</a> in it</span></p>' +
        '<p><span id="t">a shadow</span></p>' +
        '<p id="away">away from them</p>',
      300,
    );
    const el = view(node);
    for (const id of ['s', 'o', 'l', 't']) {
      el.setHover(...pointIn(el, 'away'));
      const quiet = await snapshot(result, el);
      const tree = treeOf(el);
      el.setHover(...pointIn(el, id));
      const hovered = await snapshot(result, el);
      assert.ok(treeOf(el) === tree, `#${id}: the document was built again`);
      assert.ok(
        bytesApart(hovered, quiet) > 0,
        `#${id}: the hover drew nothing`,
      );
      assert.strictEqual(
        bytesApart(hovered, await rebuilt(result, el)),
        0,
        `#${id}: not the pixels a build draws`,
      );
    }
  },
);

metric(
  'a hover that changes the opacity of an inline element a block broke apart builds the document again',
  async () => {
    // The block took the opacity when the boxes were built
    // (`FADED_BLOCKS`), and is no child of the pieces the element became:
    // restyled in place, it kept the half it was drawn at
    const { result, node } = await render(
      '<style>body{margin:0;background:#ffffff}' +
        '#s{opacity:.5}#s:hover{opacity:.25}</style>' +
        '<span id="s">a<div id="d" style="height:20px;background:#ff0000">' +
        '</div>b</span>',
    );
    const el = view(node);
    const [x, y] = pointIn(el, 'd');
    el.setHover(x, y);
    const hovered = await snapshot(result, el);
    assert.strictEqual(
      bytesApart(hovered, await rebuilt(result, el)),
      0,
      'not the pixels a build draws',
    );
    await expectPixel(result.ctx, x, y, '#ffc0c0', {
      tolerance: 3,
      message: 'the block, at a quarter',
    });
  },
);

/** The surfaces a document draws on for a paint of all of it: the ones it
 *  keeps, and the ones it makes for that paint alone. */
async function surfacesOfRepaint(
  t: TestContext,
  node: DrawnNode,
): Promise<number> {
  const el = view(node) as unknown as {
    _surface(width: number, height: number): unknown;
    _invalidate(stale: number): void;
    _sprites: { size: number } | null;
  };
  const surface = t.mock.method(el, '_surface');
  el._invalidate(0);
  await act();
  return surface.mock.callCount() + (el._sprites?.size ?? 0);
}

metric(
  'an element under full opacity is faded as the group it is',
  async (t) => {
    // CSS Color 4, 3.2: what it holds is drawn whole and faded as one, so
    // the red over its blue background shows no blue through it, where
    // each thing faded on its own did — and two such elements, one in the
    // other, are a group in a group
    const { result, node } = await render(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<div style="opacity:.5;width:60px;height:40px;padding:10px;' +
        'background:#0000ff"><div style="height:40px;background:#ff0000">' +
        '</div></div>' +
        '<div style="opacity:.5;width:60px;height:40px;padding:10px;' +
        'background:#0000ff"><div style="opacity:.5;height:40px;' +
        'padding:10px;box-sizing:border-box;background:#ff0000">' +
        '<div style="height:20px;background:#00ff00"></div></div></div>' +
        '<div style="opacity:.5;width:40px;height:20px;' +
        'border:10px solid #ff0000;background:#0000ff"></div>',
    );
    await expectPixel(result.ctx, 40, 30, '#ff8080', {
      tolerance: 3,
      message: 'the red, half over the page',
    });
    await expectPixel(result.ctx, 5, 5, '#8080ff', {
      tolerance: 3,
      message: 'the blue around it, half over the page',
    });
    // the green over the red, half over the blue, and all of it half over
    // the page
    await expectPixel(result.ctx, 40, 90, '#80bfbf', {
      tolerance: 3,
      message: 'a group in a group',
    });
    // a border over its own background
    await expectPixel(result.ctx, 5, 125, '#ff8080', {
      tolerance: 3,
      message: 'the border, half over the page',
    });
    assert.ok((await surfacesOfRepaint(t, node)) > 0, 'drawn on surfaces');
  },
);

metric(
  'a faded box a context turns itself keeps the surface its group is drawn through while its matrix holds, to the pixels a surface made for the paint draws',
  async (t) => {
    // A context that turns a box itself — macOS's — draws a faded one's
    // group through its matrix on a surface, which was made at every
    // paint: Zen Garden 214's enso, an image an animation scales and
    // fades, was set from its paths at every frame of a resize that only
    // moved it
    const { result, node } = await render(
      '<style>body{margin:0}html{background:#ffffff}' +
        '#t{width:60px;height:40px;margin:30px;background:#c00000;' +
        'border:4px solid #0000c0;transform:rotate(12deg) scale(1.1);' +
        'opacity:.6}#t div{height:16px;margin:6px;background:#00a000}' +
        '</style><div id="t"><div></div></div>',
    );
    const el = view(node);
    const own = el as unknown as {
      root: { _ctx: object };
      invalidate(all: boolean, by: unknown, why: string): void;
    };
    // and fades a surface as cheaply as it draws one
    for (const name of ['scalesText', 'fadesSurfacesCheaply']) {
      Object.defineProperty(own.root._ctx, name, {
        value: true,
        configurable: true,
      });
    }
    try {
      const repaint = () => {
        own.invalidate(false, el, 'props');
        return snapshot(result, el);
      };
      const store = () =>
        (el as unknown as { _sprites: { clear(): void } | null })._sprites;
      const make = t.mock.method(SpriteStore.prototype, 'make');
      store()?.clear();
      const kept = await repaint();
      assert.strictEqual(make.mock.callCount(), 1, 'made once');
      const again = await repaint();
      assert.strictEqual(make.mock.callCount(), 1, 'and drawn again from');
      assert.strictEqual(bytesApart(kept, again), 0);
      // a surface made for the paint alone, as every one was
      make.mock.mockImplementation(() => null);
      store()?.clear();
      const alone = await repaint();
      assert.strictEqual(bytesApart(kept, alone), 0, 'the pixels it draws');
    } finally {
      const ctx = own.root._ctx as {
        scalesText?: boolean;
        fadesSurfacesCheaply?: boolean;
      };
      delete ctx.scalesText;
      delete ctx.fadesSurfacesCheaply;
    }
  },
);

metric(
  'a faded box that draws nothing over itself, turned by a context that turns it itself, is drawn from a group kept for it, a level or two of the edges apart from fading each thing',
  async (t) => {
    // Zen Garden 214's enso: one image an animation scales and fades, which
    // was faded and set from its paths at every paint. A group of it kept
    // is the same but for how an edge pixel rounds.
    const { result, node } = await render(
      '<style>body{margin:0}html{background:#ffffff}' +
        '#t{width:60px;height:40px;margin:30px;background:#c00000;' +
        'transform:rotate(12deg) scale(1.1);opacity:.6}</style>' +
        '<div id="t"></div>',
    );
    const el = view(node);
    const own = el as unknown as {
      root: { _ctx: object };
      invalidate(all: boolean, by: unknown, why: string): void;
      _sprites: { clear(): void } | null;
    };
    for (const name of ['scalesText', 'fadesSurfacesCheaply']) {
      Object.defineProperty(own.root._ctx, name, {
        value: true,
        configurable: true,
      });
    }
    try {
      const repaint = () => {
        own.invalidate(false, el, 'props');
        return snapshot(result, el);
      };
      const make = t.mock.method(SpriteStore.prototype, 'make');
      own._sprites?.clear();
      const kept = await repaint();
      assert.strictEqual(make.mock.callCount(), 1, 'kept');
      make.mock.mockImplementation(() => null);
      own._sprites?.clear();
      const each = await repaint();
      let most = 0;
      for (let i = 0; i < kept.length; i += 1) {
        most = Math.max(most, Math.abs(kept[i] - each[i]));
      }
      assert.ok(most <= 2, `${most} levels apart`);
    } finally {
      const ctx = own.root._ctx as {
        scalesText?: boolean;
        fadesSurfacesCheaply?: boolean;
      };
      delete ctx.scalesText;
      delete ctx.fadesSurfacesCheaply;
    }
  },
);

metric(
  'a faded box a context turns itself keeps its group across a resize that moves it a fraction of a pixel',
  async (t) => {
    // a drag moved Zen Garden 214's header a fraction of a pixel at each
    // step, and what is inside it was laid out again in other last bits
    const { el, resize } = await renderScrolled(
      '<style>body{margin:0}html{background:#ffffff}' +
        '#t{width:60px;height:40px;margin:30px auto;background:#c00000;' +
        'transform:rotate(12deg);opacity:.6}#t div{height:16px;margin:6px;' +
        'background:#00a000}</style><div id="t"><div></div></div>',
      300,
    );
    const own = el as unknown as { root: { _ctx: object } };
    for (const name of ['scalesText', 'fadesSurfacesCheaply']) {
      Object.defineProperty(own.root._ctx, name, {
        value: true,
        configurable: true,
      });
    }
    try {
      await resize(300, 401);
      const make = t.mock.method(SpriteStore.prototype, 'make');
      for (const width of [399, 397, 396]) await resize(300, width);
      assert.strictEqual(make.mock.callCount(), 0, 'not drawn again');
    } finally {
      const ctx = own.root._ctx as {
        scalesText?: boolean;
        fadesSurfacesCheaply?: boolean;
      };
      delete ctx.scalesText;
      delete ctx.fadesSurfacesCheaply;
    }
  },
);

metric(
  'a faded card a resize only moves keeps the surface it was drawn on',
  async (t) => {
    // A layout at another width threw every kept surface away, so a group
    // was drawn again at each width of a drag. A card of a fixed width that
    // a narrower column only moves is laid out as it was, line for line,
    // relative to its corner, and its surface draws what it drew (`relaid`).
    const { el, resize, result } = await renderScrolled(
      '<style>body{margin:0}html{background:#ffffff}' +
        '#c{opacity:.5;width:120px;margin:0 auto;padding:8px;' +
        'background:#0000ff;color:#ffffff}</style>' +
        '<div id="c"><div style="height:20px;background:#ff0000"></div>' +
        '<p style="margin:0">a card</p></div>',
      300,
    );
    const kept = () =>
      (el as unknown as { _sprites: { size: number } | null })._sprites?.size ??
      0;
    assert.ok(kept() > 0, 'drawn on a kept surface');
    const make = t.mock.method(SpriteStore.prototype, 'make');
    await resize(300, 360);
    assert.strictEqual(make.mock.callCount(), 0, 'and not drawn again');
    assert.ok(kept() > 0, 'which it still has');
    const moved = await snapshot(result, el);
    assert.strictEqual(
      bytesApart(moved, await rebuilt(result, el)),
      0,
      'where a build draws it',
    );
  },
);

metric(
  'a faded box whose text a resize wraps again is drawn again',
  async (t) => {
    const { el, resize, result } = await renderScrolled(
      '<style>body{margin:0}html{background:#ffffff}' +
        '#c{opacity:.5;width:50%;background:#0000ff;color:#ffffff}</style>' +
        '<div id="c">a line of words that wraps at one width and not at ' +
        'the other</div>',
      300,
    );
    const make = t.mock.method(SpriteStore.prototype, 'make');
    await resize(300, 300);
    assert.ok(make.mock.callCount() > 0, 'drawn again');
    assert.strictEqual(
      bytesApart(await snapshot(result, el), await rebuilt(result, el)),
      0,
      'as a build draws it',
    );
  },
);

metric(
  'a surface given up is drawn on again at its size, transparent',
  async () => {
    // what a layout or a restyle gives up is kept until the paint ends, for
    // a box asking for a surface the size it had to be drawn on again
    // rather than one made (`release`, `reuse`), and destroyed then (`trim`)
    const { result } = await render('<p>x</p>');
    const store = new SpriteStore((result as unknown as { app: unknown }).app);
    const first = store.make({}, 16, 16, 'k')!;
    const ctx = first.getContext('2d') as {
      fillStyle: string;
      fillRect(x: number, y: number, w: number, h: number): void;
      getImageData(
        x: number,
        y: number,
        w: number,
        h: number,
        cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
      ): void;
    };
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 16, 16);
    store.clear();
    const again = store.make({}, 16, 16, 'k');
    assert.strictEqual(again, first, 'the surface given up');
    const pixels = await new Promise<Uint8ClampedArray>((ok, fail) =>
      ctx.getImageData(0, 0, 16, 16, (e, d) => (e ? fail(e) : ok(d.data))),
    );
    assert.ok(
      pixels.every((v) => v === 0),
      'transparent again',
    );
    assert.strictEqual(
      store.make({}, 8, 8, 'k') === first,
      false,
      'not at another size',
    );
    store.clear();
    store.trim();
    assert.notStrictEqual(
      store.make({}, 16, 16, 'k'),
      first,
      'and what no paint took is gone once one ends',
    );
    store.destroy();
  },
);

metric(
  'an element under full opacity that draws one thing is faded without a surface, but for text on X11',
  async (t) => {
    // a background alone — the backdrop a dialog dims a page with — or an
    // image alone is the same faded either way
    const backdrop = await render(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<div style="opacity:.5;height:40px;background:#ff0000"></div>',
    );
    await expectPixel(backdrop.result.ctx, 10, 20, '#ff8080', {
      tolerance: 3,
      message: 'the backdrop, half over the page',
    });
    assert.strictEqual(
      await surfacesOfRepaint(t, backdrop.node),
      0,
      'and no surface',
    );
    // ntk's glyphs take no alpha of the context's, and drew a paragraph at
    // `opacity: .5` at full strength: text there is a group, which the
    // composite fades
    const text = await render(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<p style="margin:0;font:bold 48px sans-serif;opacity:.5;color:#000000">MWM</p>',
    );
    const pixels = await pixelsIn(text.result.ctx, {
      x: 0,
      y: 0,
      width: 120,
      height: 50,
    });
    let darkest = 255;
    for (let i = 0; i < pixels.length; i += 4) {
      darkest = Math.min(darkest, pixels[i]);
    }
    assert.ok(
      darkest >= 120 && darkest <= 136,
      `black text at half over white: ${darkest}`,
    );
    assert.ok(
      (await surfacesOfRepaint(t, text.node)) > 0,
      'faded on a surface',
    );
  },
);

metric(
  'a faded inline element is a group of the positioned boxes in it, and of nothing on its lines',
  async (t) => {
    // Its text, its background and the inline-block on its line are drawn
    // by its block's lines, each faded there, and none of them in its own
    // paint: a surface for them was a surface with nothing on it. What its
    // paint draws is the badge it holds, background and text.
    const lines = await render(
      '<style>body{margin:0}</style>' +
        '<p><a style="opacity:.5;background:#ffff00;padding:2px">a link ' +
        '<span style="display:inline-block;width:16px;height:16px;' +
        'background:#0000ff"></span></a></p>',
    );
    assert.strictEqual(
      await surfacesOfRepaint(t, lines.node),
      0,
      'a surface for what its lines draw',
    );
    cleanup();
    const badge = await render(
      '<style>body{margin:0}</style>' +
        '<p style="position:relative"><a style="opacity:.5">a link ' +
        '<span style="position:absolute;left:0;top:30px;padding:4px;' +
        'background:#0000ff;color:#ffffff">a badge</span></a></p>',
    );
    assert.ok(
      (await surfacesOfRepaint(t, badge.node)) > 0,
      'no group for the badge',
    );
  },
);

test('a native context fades each thing a faded element draws, but where a faded surface is cheap', async () => {
  // react-x11's macOS and Windows contexts drew a surface under an alpha
  // through CoreGraphics' own, which cost a faded card more than drawing it
  // again: no group is asked for there, but of one that says a faded
  // surface costs what an opaque one does (`fadesSurfacesCheaply`,
  // react-x11#810)
  const { node } = await render(
    '<div style="opacity:.5;padding:4px;background:#ff0000"><b>text</b></div>',
  );
  let asked = 0;
  const surface = () => {
    asked += 1;
    return null;
  };
  await fillsOf(view(node), [], { surface });
  assert.ok(asked > 0, 'a group asked for of ntk’s context');
  asked = 0;
  await fillsOf(view(node), [], { surface, scalesText: true });
  assert.strictEqual(asked, 0, 'and none of a native one');
  await fillsOf(view(node), [], {
    surface,
    scalesText: true,
    fadesSurfacesCheaply: true,
  });
  assert.ok(asked > 0, 'but of one whose faded surfaces are cheap');
});

metric(
  'a positioned box that escapes a clip around a faded element is still drawn',
  async () => {
    // painted where the clip ends, outside the group, as it was: a group
    // drawn whole inside the clip would have cut it off
    const { result } = await render(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<div style="position:relative;height:80px">' +
        '<div style="overflow:hidden;height:20px">' +
        '<div style="opacity:.5;height:20px;background:#0000ff">' +
        '<span style="background:#00ff00">x</span>' +
        '<div style="position:absolute;top:40px;left:0;width:20px;' +
        'height:20px;background:#ff0000"></div></div></div></div>',
    );
    const [r, g, b] = await pixelAt(result.ctx, 10, 50);
    assert.ok(
      r > 200 && g < 200 && b < 200,
      `drawn below the clip: ${r},${g},${b}`,
    );
  },
);

metric(
  'a box fixed to the viewport in a faded element is drawn where the viewport is',
  async () => {
    // laid out against the viewport at the document's top and drawn where
    // the viewport is now, past the ink its faded element was laid out
    // with once the document scrolls: a group the size of that ink cut it
    // off, so the element fades each thing it draws
    const pane = React.createRef<DrawnNode & { scrollTo(y: number): void }>();
    const result = await renderX11(
      h(
        'box',
        { ref: pane, style: { width: 200, height: 200, overflow: 'scroll' } },
        h(Html, {
          source:
            '<style>body{margin:0}html{background:#ffffff}</style>' +
            '<div style="opacity:.5;height:50px;background:#0000ff">a' +
            '<div style="position:fixed;bottom:0;left:0;width:100px;' +
            'height:20px;background:#ff0000"></div></div>' +
            '<div style="height:2000px"></div>',
          partial: false,
          'data-testname': 'doc',
        }),
      ),
      { width: 240, height: 240, fonts: FONTS! },
    );
    await act();
    await act(async () => pane.current!.scrollTo(100));
    const el = view(screen.getByTestName('doc') as DrawnNode) as unknown as {
      _invalidate(stale: number): void;
    };
    el._invalidate(0);
    await act();
    await expectPixel(result.ctx, 50, 190, '#ff8080', {
      tolerance: 3,
      message: 'the bar at the viewport’s foot, half over the page',
    });
  },
);

metric(
  'an element under full opacity at a display scale of 2 is faded as a group on the device grid',
  async () => {
    const { result } = await render2x(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<div style="opacity:.5;width:30px;height:20px;padding:5px;' +
        'background:#0000ff"><div style="height:20px;background:#ff0000">' +
        '</div></div>',
    );
    // the document at 40 device pixels in; the red box 5 logical pixels
    // further, 60 by 40 device pixels
    await expectPixel(result.ctx, 80, 70, '#ff8080', {
      tolerance: 3,
      message: 'the red, half over the page',
    });
    await expectPixel(result.ctx, 43, 43, '#8080ff', {
      tolerance: 3,
      message: 'the blue around it',
    });
  },
);

metric(
  'at a display scale of 2 the document lays out in CSS pixels, on the device grid',
  async () => {
    const { result, node } = await render2x(
      '<style>body{margin:0}div{width:100px;height:50px;margin:0}' +
        '#a{background:#ff0000}#b{background:#0000ff}</style>' +
        '<div id="a"></div><div id="b"></div>',
    );
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    assert.strictEqual(
      abs.x,
      40,
      'a 20-logical-pixel padding is 40 device pixels, and `abs` is device',
    );
    const a = boxOf(el, 'a');
    const b = boxOf(el, 'b');
    assert.deepStrictEqual(
      { width: a.width, height: a.height, by: b.y },
      { width: 200, height: 100, by: 100 },
      'a 100×50 CSS box is 200×100 device pixels, and the next block starts below it',
    );
    assert.strictEqual(
      abs.height,
      200,
      'the element measures to the device document',
    );
    await waitFor(() =>
      expectPixel(result.ctx, abs.x + 190, abs.y + 90, '#ff0000', {
        message: 'the box is painted at its device size',
      }),
    );
    await expectPixel(result.ctx, abs.x + 190, abs.y + 110, '#0000ff', {
      message: 'and the next one where it ends',
    });
    assert.ok(
      !isNear(await pixelAt(result.ctx, abs.x + 210, abs.y + 90), '#ff0000'),
      'nothing of it past 100 CSS pixels',
    );

    // The point queries take the logical point a mouse event carries.
    const centre = (box: LaidBox): [number, number] => [
      (abs.x + box.x + box.width / 2) / 2,
      (abs.y + box.y + box.height / 2) / 2,
    ];
    assert.strictEqual(el.elementAtPoint(...centre(b))?.attribs.id, 'b');
    assert.strictEqual(el.elementAtPoint(...centre(a))?.attribs.id, 'a');
  },
);

metric(
  'a block with a link or a column in it is found where it is, not from the top',
  async () => {
    // An inline box is drawn on its block's lines and a column in its
    // cells, and neither has a rectangle of its own. Taken for one at
    // (0, 0), each stretched the paint bounds of the block it was in up to
    // the top of the document, and a paint low in a long document went
    // through every block above the viewport.
    const paras = Array.from(
      { length: 80 },
      (_, i) =>
        `<p id="p${i}">paragraph ${i} with <a href="#">a <b>link</b></a></p>`,
    ).join('');
    const { node } = await render(
      `<style>p{margin:0 0 20px}</style>${paras}` +
        '<table id="t"><colgroup><col><col></colgroup>' +
        '<tr><td>a</td><td>b</td></tr></table>',
    );
    const el = view(node);
    type Bounded = LaidBox & { boundsY: number; boundsHeight: number };
    for (const id of ['p40', 'p79', 't']) {
      const box = boxOf(el, id) as Bounded;
      assert.ok(
        box.boundsY >= box.y - 1 && box.boundsHeight < box.height + 20,
        `#${id}'s ink is where it is: ${box.boundsY}+${box.boundsHeight} ` +
          `for a box at ${box.y}+${box.height}`,
      );
    }
    const { queryChildIndex } = await import('../../src/html/paint.js');
    const root = (
      el as unknown as {
        _tree: { root: { paintIndex: Parameters<typeof queryChildIndex>[0] } };
      }
    )._tree.root;
    assert.ok(root.paintIndex, 'eighty paragraphs are indexed');
    const at = boxOf(el, 'p60');
    const hits = queryChildIndex(root.paintIndex, at.y, at.y + at.height);
    assert.ok(
      hits.length <= 2,
      `a strip one paragraph tall meets ${hits.length} of them`,
    );
  },
);

test('a box is painted with each edge on the pixel it falls nearest', async () => {
  // as browsers snap a box: a rule 1pt wide is one pixel, not two, and two
  // boxes that meet at a fraction of one share the column their edge is
  // in, rather than both painting it
  const { node } = await render(
    '<style>body{margin:0}div{float:left;height:10px}</style>' +
      '<div style="width:1pt;background:#ff0000"></div>' +
      '<div style="width:10.4px;background:#00ff00"></div>' +
      '<div style="width:10.4px;background:#0000ff"></div>',
  );
  const fills = await fillsOf(view(node));
  const [red, green, blue] = ['#ff0000', '#00ff00', '#0000ff'].map((c) => {
    const found = fills.find((f) => f.style === parseColor(c));
    assert.ok(found, `a fill in ${c}`);
    return found;
  });
  assert.deepStrictEqual(
    [red.w, green.x - red.x, green.w, blue.x - green.x],
    [1, 1, 11, 11],
  );
});

metric(
  'a mask shows its element where its image is opaque, and nothing before it arrives',
  async () => {
    // CSS Masking 1: the element drawn as a group, and cut by the alpha of
    // its mask layers, placed as a background's are. Wikipedia draws every
    // icon as a `background-color` masked by an SVG, and each was a solid
    // square. A layer whose image has not arrived is transparent black:
    // the element is not drawn at all until it does.
    const half =
      `<svg ${SVG_NS} width="20" height="20">` +
      '<rect width="10" height="20" fill="#000000"/></svg>';
    const { result } = await renderWithBytes(
      '<style>body{margin:0;background:#ffffff}div{width:40px;height:20px;' +
        'background:#ff0000}#m{mask:url(m.svg) no-repeat}' +
        '#w{-webkit-mask-image:url(m.svg);-webkit-mask-repeat:no-repeat;' +
        '-webkit-mask-position:right;-webkit-mask-size:20px}' +
        '#late{mask-image:url(late.svg)}' +
        '#g{mask-image:linear-gradient(#000000,#000000 50%,' +
        'transparent 50%)}#a{background:none}#a::after{content:"";' +
        'display:block;width:20px;height:20px;background:#0000ff;' +
        'mask:url(m.svg)}#f{mask-image:url(#svg-mask)}</style>' +
        '<div id="m"></div><div id="w"></div><div id="late"></div>' +
        '<div id="g"></div><div id="a"></div><div id="f"></div>',
      { 'm.svg': svgBytes(half) },
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 5, 10, '#ff0000', { message: 'under the image' });
    await expectPixel(ctx, 15, 10, '#ffffff', {
      message: 'where it is transparent',
    });
    await expectPixel(ctx, 30, 10, '#ffffff', { message: 'past it' });
    await expectPixel(ctx, 25, 30, '#ff0000', {
      message: 'placed and sized, under its -webkit- names',
    });
    await expectPixel(ctx, 5, 30, '#ffffff', { message: 'and not repeated' });
    await expectPixel(ctx, 5, 50, '#ffffff', {
      message: 'an image that has not arrived shows nothing',
    });
    await expectPixel(ctx, 5, 65, '#ff0000', { message: 'a gradient mask' });
    await expectPixel(ctx, 5, 75, '#ffffff', { message: 'its clear half' });
    await expectPixel(ctx, 5, 90, '#0000ff', { message: 'a pseudo-element' });
    await expectPixel(ctx, 15, 90, '#ffffff', {
      message: "the pseudo-element's mask",
    });
    await expectPixel(ctx, 35, 110, '#ffffff', {
      message: 'a url(#id) that names no <mask> is a transparent layer',
    });
  },
);

metric(
  'a mask-image url(#id) is the <mask> it names in the document',
  async () => {
    // CSS Masking 1, 7.1: the mask's content drawn over the box, in its
    // units, by its mask-type or the layer's mask-mode. It was no layer at
    // all, and the box was drawn whole (WPT mask-image-url-local-mask,
    // mask-composite-1c, mask-opacity-1d)
    const { result } = await renderWithBytes(
      '<style>body{margin:0;background:#ffffff}div{width:40px;height:20px;' +
        'background:#ff0000}#u{mask-image:url(#user)}' +
        '#b{mask-image:url(#box)}#a{mask-image:url(#box);mask-mode:alpha}' +
        '</style><div id="u"></div><div id="b"></div><div id="a"></div>' +
        `<svg ${SVG_NS} width="0" height="0">` +
        '<mask id="user"><rect width="10" height="20" fill="#ffffff"/></mask>' +
        '<mask id="box" maskContentUnits="objectBoundingBox">' +
        '<rect width="0.5" height="1" fill="#ffffff"/>' +
        '<rect x="0.5" width="0.5" height="1" fill="#000000"/></mask></svg>',
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 5, 10, '#ff0000', { message: 'in its rect' });
    await expectPixel(ctx, 15, 10, '#ffffff', { message: 'past it' });
    await expectPixel(ctx, 15, 30, '#ff0000', {
      message: "in a fraction of the box's",
    });
    await expectPixel(ctx, 35, 30, '#ffffff', {
      message: 'black, by its luminance',
    });
    await expectPixel(ctx, 35, 50, '#ff0000', {
      message: 'black and opaque, by the alpha the layer asks for',
    });
  },
);

metric(
  'a <mask> takes the mask-type a rule gives it, as it takes the attribute',
  async () => {
    // CSS Masking 1, 7.3.1: under `mask-mode: match-source` a layer is the
    // mask's `mask-type`, which a style sheet may set as well as the
    // attribute; read from the attribute alone, a black and opaque mask
    // was its luminance, and hid the box (WPT mask-mode-to-mask-type), and
    // so it did for a shape in a drawing that names the mask
    const { result } = await renderWithBytes(
      '<style>body{margin:0;background:#ffffff}div{width:40px;height:20px;' +
        'background:#ff0000;mask-image:url(#m)}#m{mask-type:alpha}' +
        `</style><div></div><svg ${SVG_NS} width="40" height="20">` +
        '<mask id="m"><rect width="40" height="20" fill="#000000"/></mask>' +
        '<rect width="40" height="20" fill="#ff0000" mask="url(#m)"/></svg>',
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 20, 10, '#ff0000', {
      message: 'a box masked by alpha',
    });
    await expectPixel(ctx, 20, 30, '#ff0000', {
      message: 'a shape masked by alpha',
    });
  },
);

metric(
  "a mask layer of mask-mode luminance is its image's luminance",
  async () => {
    // CSS Masking 1, 7.3: luminance times alpha, where every layer was taken
    // by its alpha, so a white and a black half both showed the element
    // (WPT mask-mode-a to d). A gradient's stops, a decoded image's pixels
    // and an SVG image's drawing are each made so.
    const halves =
      `<svg ${SVG_NS} width="20" height="20">` +
      '<rect width="10" height="20" fill="#ffffff"/>' +
      '<rect x="10" width="10" height="20" fill="#000000"/></svg>';
    const png = new PNG({ width: 20, height: 20 });
    for (let i = 0; i < 400; i++) {
      const white = i % 20 < 10 ? 255 : 0;
      png.data.set([white, white, white, 255], i * 4);
    }
    const { result } = await renderWithBytes(
      '<style>body{margin:0;background:#ffffff}div{width:20px;height:20px;' +
        'background:#ff0000;mask-size:100% 100%;mask-mode:luminance}' +
        '#g{mask-image:linear-gradient(to right,#ffffff 50%,#000000 50%)}' +
        '#s{mask-image:url(h.svg)}#p{mask-image:url(h.png)}' +
        '#a{mask-image:url(h.svg);mask-mode:alpha}</style>' +
        '<div id="g"></div><div id="s"></div><div id="p"></div>' +
        '<div id="a"></div>',
      {
        'h.svg': svgBytes(halves),
        'h.png': new Uint8Array(PNG.sync.write(png)),
      },
    );
    const ctx = result.ctx;
    for (const [i, what] of ['a gradient', 'an SVG', 'a PNG'].entries()) {
      await expectPixel(ctx, 5, 20 * i + 10, '#ff0000', {
        message: `${what}'s white half`,
      });
      await expectPixel(ctx, 15, 20 * i + 10, '#ffffff', {
        message: `${what}'s black half`,
      });
    }
    await expectPixel(ctx, 15, 70, '#ff0000', {
      message: 'black and opaque, as alpha',
    });
  },
);

metric(
  'a url(#id) mask under mask-mode luminance is that mask with mask-type luminance',
  async () => {
    // The layer's mode is the `<mask>`'s type (CSS Masking 1, 7.3): an
    // alpha mask of grey under `luminance` is the grey's luminance, half,
    // where under its own type it would show the box whole
    const { result } = await renderWithBytes(
      '<style>body{margin:0;background:#ffffff}div{width:40px;height:20px;' +
        'background:#ff0000}#l{mask-image:url(#alpha);mask-mode:luminance}' +
        '#m{mask-image:url(#lum)}</style><div id="l"></div><div id="m"></div>' +
        `<svg ${SVG_NS} width="0" height="0">` +
        '<mask id="alpha" mask-type="alpha"><rect width="40" height="20" fill="#808080"/></mask>' +
        '<mask id="lum" mask-type="luminance"><rect width="40" height="20" fill="#808080"/></mask>' +
        '</svg>',
      {},
    );
    await act();
    const [a, b] = [
      await pixelsIn(result.ctx, { x: 0, y: 0, width: 40, height: 20 }),
      await pixelsIn(result.ctx, { x: 0, y: 20, width: 40, height: 20 }),
    ];
    let most = 0;
    for (let i = 0; i < a.length; i++)
      most = Math.max(most, Math.abs(a[i] - b[i]));
    assert.strictEqual(most, 0);
    // and half there
    const [r, g] = a;
    assert.ok(r === 255 && g > 100 && g < 160, `half there: ${r},${g}`);
  },
);

metric(
  "an inline box's mask is laid down across its fragments end to end",
  async () => {
    // CSS Masking 1, 7, and box-decoration-break: slice: the mask is laid
    // down in the box its fragments make side by side, each fragment its
    // part of it. An inline box's mask was not applied at all, and its
    // second line showed with its first (WPT mask-image-inline-sliced-1,
    // mask-image-6)
    const { result } = await render(
      '<style>body{margin:0;background:#ffffff}div{width:35px;' +
        'font:10px/20px sans-serif}i{display:inline-block;width:30px;' +
        'height:10px;background:#ff0000}span{mask-image:linear-gradient(' +
        'to right,#000 50%,transparent 50%)}</style>' +
        '<div><span><i></i> <i></i></span></div>',
    );
    await act();
    const px = await pixelsIn(result.ctx, {
      x: 15,
      y: 0,
      width: 1,
      height: 40,
    });
    const red = (from: number, to: number) => {
      for (let y = from; y < to; y++) {
        if (px[y * 4] > 200 && px[y * 4 + 1] < 60) return true;
      }
      return false;
    };
    assert.ok(red(0, 20), 'the first fragment, in the half that shows');
    assert.ok(!red(20, 40), 'the second, in the half that does not');
  },
);

metric('a radial gradient is a mask, as a linear one is', async () => {
  // a vignette: `mask-image: radial-gradient(…)` shows its element where
  // the gradient is opaque. It was drawn as nothing, so as no mask, and
  // the element was not drawn at all
  const { result, node } = await render(
    '<style>body{margin:0;background:#ffffff}div{width:200px;height:100px;' +
      'background:#ff0000;mask-image:radial-gradient(closest-side,' +
      '#000000 50%,transparent 50%)}</style><div></div>',
  );
  const at = (node as unknown as { abs: { x: number; y: number } }).abs;
  await waitFor(async () => {
    for (const [x, y, shown] of [
      [100, 50, true],
      [140, 50, true],
      [160, 50, false],
      [100, 70, true],
      [100, 80, false],
      [10, 10, false],
    ] as [number, number, boolean][]) {
      const [r, g] = await pixelAt(result.ctx, at.x + x, at.y + y);
      assert.ok(
        shown ? r > 200 && g < 60 : g > 200,
        `${shown ? 'shown' : 'masked'} at ${x},${y}: ${r},${g}`,
      );
    }
  });
});

metric('mask layers are composited as mask-composite says', async () => {
  // Each layer is composited with the layers below it (CSS Masking 1,
  // 7.8). A card outlined by a ring, `linear-gradient(#000 0 0) content-box
  // exclude, linear-gradient(#000 0 0)` — the border box less the content
  // box — was tinted all over, every layer added
  const ring = 'linear-gradient(#000 0 0)';
  const { result, node } = await render(
    '<style>body{margin:0;background:#ffffff}div{width:40px;height:40px;' +
      'padding:10px;margin-bottom:10px;background:#ff0000}' +
      `#x{mask:${ring} content-box exclude,${ring}}` +
      `#s{mask:${ring} subtract,${ring} content-box}` +
      `#w{-webkit-mask:${ring} content-box,${ring};-webkit-mask-composite:xor}` +
      `#n{mask:${ring} content-box intersect,${ring}}` +
      '</style><div id="x"></div><div id="s"></div><div id="w"></div>' +
      '<div id="n"></div>',
  );
  const at = (node as unknown as { abs: { x: number; y: number } }).abs;
  await waitFor(async () => {
    for (const [i, edge, middle] of [
      [0, true, false],
      [1, true, false],
      [2, true, false],
      [3, false, true],
    ] as [number, boolean, boolean][]) {
      const top = i * 70;
      for (const [x, y, shown] of [
        [5, top + 5, edge],
        [30, top + 30, middle],
      ] as [number, number, boolean][]) {
        const [r, g] = await pixelAt(result.ctx, at.x + x, at.y + y);
        assert.ok(
          shown ? r > 200 && g < 60 : g > 200,
          `#${'xswn'[i]} ${shown ? 'shown' : 'masked'} at ${x},${y}: ${r},${g}`,
        );
      }
    }
  });
});

metric(
  'a mask is placed and sized in CSS pixels at a display scale of 2',
  async () => {
    // its size and position are lengths, device pixels by the time they are
    // stored, and its image's own size is CSS pixels until it is drawn
    const half =
      `<svg ${SVG_NS} width="20" height="20">` +
      '<rect width="10" height="20" fill="#000000"/></svg>';
    const result = await renderX11(
      h(
        'box',
        { style: { width: 200, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0;background:#ffffff}div{width:40px;' +
            'height:20px;background:#ff0000;mask:url(m.svg) right / 20px ' +
            'no-repeat}</style><div></div>',
          partial: false,
          onResource: (r: { url: string; kind: string }) =>
            r.kind === 'image' && r.url === 'm.svg'
              ? { kind: 'image' as const, bytes: svgBytes(half) }
              : null,
        }),
      ),
      atScale2({ width: 240, height: 100, fonts: FONTS! }),
    );
    // in device pixels: the image covers 40 to 80, opaque from 40 to 60
    await expectPixel(result.ctx, 50, 20, '#ff0000', { message: 'opaque' });
    await expectPixel(result.ctx, 70, 20, '#ffffff', { message: 'clear' });
    await expectPixel(result.ctx, 30, 20, '#ffffff', { message: 'outside' });
  },
);

test('a mask longhand with a var() in it resets its own list, not the others', async () => {
  // A declaration with a `var()` is set back to its initial value first, in
  // case what it substitutes is no value. The mask's lists are one field,
  // and that put back the whole of it: Wikipedia's `mask-size:
  // calc(var(--x) - 4px)` undid the `mask-repeat: no-repeat` before it,
  // and its chevron repeated
  const { node } = await render(
    '<style>#m{--x:24px;mask-repeat:no-repeat;mask-position:center;' +
      'mask-size:calc(var(--x) - 4px);mask-image:url(m.svg)}' +
      '#i{mask-repeat:no-repeat;mask-size:var(--missing)}</style>' +
      '<p id="m">x</p><p id="i">x</p>',
  );
  const el = view(node);
  const mask = (id: string) =>
    (boxOf(el, id) as unknown as { style: ComputedStyle }).style.mask;
  assert.deepStrictEqual(mask('m').repeats, [['no-repeat', 'no-repeat']]);
  assert.deepStrictEqual(mask('m').positions, [[{ pct: 50 }, { pct: 50 }]]);
  assert.deepStrictEqual(mask('m').sizes, [[20, 'auto']]);
  // a var() that substitutes nothing leaves its own list at the start
  assert.deepStrictEqual(mask('i').sizes, ['auto']);
  assert.deepStrictEqual(mask('i').repeats, [['no-repeat', 'no-repeat']]);
});

metric('a paint that throws leaves the context as it was lent', async (t) => {
  // The window's context outlives the frame, and a paint that threw left
  // its saves open on it: a document whose font the engine could not draw
  // left its clip there, and the page shown after it was drawn inside that.
  const proto = Object.getPrototypeOf(
    (await renderX11(h('box'), { width: 200, height: 100, fonts: FONTS! })).ctx,
  ) as { drawGlyphs(...args: unknown[]): void };
  await cleanup();
  const page = (source: string, key: string) =>
    h(
      'box',
      { style: { width: 200, height: 100, backgroundColor: '#ffffff' } },
      h(Html, {
        key,
        source,
        selectable: false,
        'data-testname': 'doc',
        style: { flexGrow: 1 },
      } as never),
    );
  let threw = 0;
  t.mock.method(console, 'error', () => {});
  const thrower = t.mock.method(proto, 'drawGlyphs', () => {
    threw += 1;
    throw new Error('no such glyph');
  });
  const result = await renderX11(
    page(
      '<div style="overflow:hidden;width:20px;height:20px;border-radius:4px;' +
        'transform:translate(3px,0)"><p style="opacity:.5">text</p></div>',
      'a',
    ),
    { width: 200, height: 100, fonts: FONTS! },
  );
  await act();
  assert.ok(threw > 0, 'the paint did not throw');
  thrower.mock.restore();
  // the same document painted again, in the same window: blank, and the
  // window's ground all over it
  view(screen.getByTestName('doc') as DrawnNode).invalidate();
  await act();
  await expectPixel(result.ctx, 150, 80, '#ffffff');
  const blue =
    '<body style="margin:0"><div style="height:100px;background:#00f">';
  // the element again, with something else to draw
  await result.rerender(page(blue, 'a'));
  await act();
  await expectPixel(result.ctx, 150, 80, '#0000ff');
  await expectPixel(result.ctx, 5, 5, '#0000ff');
  // and the next one in the same window
  await result.rerender(page(blue.replace('#00f', '#0f0'), 'b'));
  await act();
  await expectPixel(result.ctx, 150, 80, '#00ff00');
  await expectPixel(result.ctx, 5, 5, '#00ff00');
});

/** A context of nothing but saved line widths, kept as `kept` makes of them,
 *  and how many saves are open on it. */
function widthsOnly(kept: (width: number) => number, saved = true) {
  const stack: number[] = [];
  let width = 1;
  return {
    get open() {
      return stack.length;
    },
    get lineWidth() {
      return width;
    },
    set lineWidth(to: number) {
      width = kept(to);
    },
    save() {
      stack.push(width);
    },
    restore() {
      const to = stack.pop();
      if (to !== undefined && saved) width = to;
    },
  };
}

/** The saves of whoever lent the context, the two under a paint, and those
 *  it left open. */
function painted(ctx: ReturnType<typeof widthsOnly>, left: number): void {
  for (let i = 0; i < 5; i++) ctx.save();
  ctx.save();
  ctx.lineWidth = MARK;
  ctx.save();
  ctx.lineWidth = 1;
  for (let i = 0; i < left; i++) ctx.save();
  if (left) ctx.lineWidth = 3;
}
const MARK = 2 ** 20 + 0.5;

test('a context is restored to what it was lent as, and no further', () => {
  // A restore too many takes a save of whoever lent it, and its clip with it.
  for (const [name, kept, left, after] of [
    ['as set', (w: number) => w, 4, 5],
    ['in single floats', Math.fround, 4, 5],
    // these cannot say which state is which, so nothing is restored
    ['cut at a thousand', (w: number) => Math.min(w, 1000), 4, 11],
    ['never set', () => 1, 4, 11],
  ] as const) {
    const ctx = widthsOnly(kept);
    painted(ctx, left);
    restoreTo(ctx as never, MARK);
    assert.strictEqual(ctx.open, after, `${name}, after a throw`);
  }
  const apart = widthsOnly((w) => w, false);
  painted(apart, 4);
  restoreTo(apart as never, MARK);
  assert.strictEqual(apart.open, 11, 'kept apart from its state');
});

test('a paint that left a save open, or none, leaves the context as it was lent', () => {
  for (const kept of [
    (w: number) => w,
    Math.fround,
    (w: number) => Math.min(w, 1000),
    () => 1,
  ]) {
    const ctx = widthsOnly(kept);
    painted(ctx, 0);
    restoreAfter(ctx as never, MARK);
    assert.strictEqual(ctx.open, 5, 'balanced');
    assert.strictEqual(ctx.lineWidth, 1);
  }
  const apart = widthsOnly((w) => w, false);
  painted(apart, 0);
  restoreAfter(apart as never, MARK);
  assert.strictEqual(apart.open, 5, 'balanced, its width kept apart');
  assert.strictEqual(apart.lineWidth, 1);
  for (const kept of [(w: number) => w, Math.fround]) {
    const ctx = widthsOnly(kept);
    painted(ctx, 3);
    restoreAfter(ctx as never, MARK);
    assert.strictEqual(ctx.open, 5, 'three left open');
    assert.strictEqual(ctx.lineWidth, 1);
  }
});

metric(
  'a paint that leaves saves open has the next document drawn whole',
  async (t) => {
    const page = (color: string, key: string) =>
      h(
        'box',
        { style: { width: 200, height: 100, backgroundColor: '#ffffff' } },
        h(Html, {
          key,
          source: `<body style="margin:0"><div style="height:100px;background:${color}">`,
          selectable: false,
          'data-testname': 'doc',
          style: { flexGrow: 1 },
        } as never),
      );
    const proto = HtmlViewNode.prototype as unknown as {
      _paint(ctx: Context2D, ...more: unknown[]): void;
    };
    const inner = proto._paint;
    const open = t.mock.method(proto, '_paint', function (this: unknown, ...a) {
      const [ctx] = a;
      inner.apply(this, a as never);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, 20, 20);
      ctx.clip();
      ctx.save();
      ctx.save();
      ctx.lineWidth = 7;
    } as typeof inner);
    const result = await renderX11(page('#00f', 'a'), {
      width: 200,
      height: 100,
      fonts: FONTS!,
    });
    await act();
    open.mock.restore();
    await result.rerender(page('#0f0', 'b'));
    await act();
    await expectPixel(result.ctx, 150, 80, '#00ff00');
    await expectPixel(result.ctx, 5, 5, '#00ff00');
  },
);

metric(
  'a box that clips cuts the descendants it paints under its flow',
  async () => {
    // a `z-index` under 0 in a stacking context that clips: painted over its
    // background and under what it holds (CSS 2.1 Appendix E), and cut as
    // the rest is, where it was painted before the clip was pushed
    const { node, result } = await render(
      '<style>body{margin:0;background:#ffffff}div{position:relative;' +
        'z-index:0;overflow:hidden;width:50px;height:50px;margin:0 50px 50px}' +
        'i{display:block;position:absolute;z-index:-1;left:-20px;top:0;' +
        'width:60px;height:80px;background:#ff0000}</style>' +
        '<div><i></i></div><div style="border-radius:1px"><i></i></div>' +
        '<div><i style="position:relative"></i></div>' +
        // one placed by something outside the clip is not cut by it
        '<div style="position:static;opacity:0.99"><i style="left:30px;' +
        'top:300px"></i></div>',
    );
    const { abs } = view(node) as unknown as { abs: { x: number; y: number } };
    const drawn = async (x: number, y: number) =>
      (
        await pixelsIn(result.ctx, {
          x: abs.x + x,
          y: abs.y + y,
          width: 1,
          height: 1,
        })
      )[1] < 10;
    for (const top of [0, 100, 200]) {
      assert.ok(await drawn(60, top + 25), `inside, at ${top}`);
      assert.ok(!(await drawn(40, top + 25)), `past the side, at ${top}`);
      assert.ok(!(await drawn(60, top + 65)), `past the foot, at ${top}`);
    }
    assert.ok(await drawn(40, 375), 'placed by what is around the clip');
  },
);
