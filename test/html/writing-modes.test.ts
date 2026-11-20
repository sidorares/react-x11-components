// <Html> — vertical writing modes (CSS Writing Modes 4): a box whose lines
// run down the page is the root of a flow laid out in a frame turned a
// quarter (`layout/writing.ts`), and sized in the page's axes from what the
// frame came to; its logical properties map by its writing mode; and what
// its text sets upright is drawn upright.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, fireEvent, waitFor } from 'react-x11/test';
import { act, pixelAt } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import type { HtmlViewNode } from '../../src/html/index.js';
import {
  boxOf,
  edgesOf,
  findById,
  linesOf,
  metric,
  pixelsIn,
  pixelsPng,
  rebuilt,
  render,
  render2x,
  renderScrolled,
  renderWithBytes,
  snapshot,
  bytesApart,
  treeOf,
  view,
} from './harness.js';
import type { Region } from './harness.js';
import { FRAMES, uprightCells } from '../../src/html/layout/writing.js';

afterEach(cleanup);

const PAGE =
  '<style>html{background:#ffffff}body{margin:0;font:16px sans-serif;' +
  'color:#000000}</style>';

/** An element's rect, in the document's CSS pixels (`elementRect`). */
function rectOf(el: HtmlViewNode, id: string) {
  const target = findById(el.document, id);
  assert.ok(target, `#${id} is in the document`);
  const rect = el.elementRect(target);
  assert.ok(rect, `#${id} has a box`);
  return rect;
}

/** The element under the middle of another's rect: a logical window
 *  point, where the element's corner is a device one. */
function hitAtMiddleOf(
  el: HtmlViewNode,
  id: string,
  scale = 1,
): string | undefined {
  const r = rectOf(el, id);
  const { abs } = el as unknown as DrawnNode;
  return el.elementAtPoint(
    abs.x / scale + r.x + r.width / 2,
    abs.y / scale + r.y + r.height / 2,
  )?.attribs.id;
}

function computed(el: HtmlViewNode, id: string): Record<string, string> {
  const style = el.computedStyle(findById(el.document, id)!);
  assert.ok(style, `#${id} is styled`);
  return style;
}

/** The rectangle around the pixels of a window region darker than `below`
 *  in every channel, and how many there are. */
async function inkIn(
  ctx: unknown,
  region: Region,
  below = 128,
): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
  rows: number[];
}> {
  const { width, height } = region;
  const data = await pixelsIn(ctx, region);
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  let count = 0;
  const rows = new Array<number>(height).fill(0);
  for (let i = 0; i < width * height; i += 1) {
    if (data[i * 4] >= below || data[i * 4 + 1] >= below) continue;
    if (data[i * 4 + 2] >= below) continue;
    count += 1;
    const x = i % width;
    const y = Math.floor(i / width);
    rows[y] += 1;
    x1 = Math.min(x1, x);
    x2 = Math.max(x2, x);
    y1 = Math.min(y1, y);
    y2 = Math.max(y2, y);
  }
  return count
    ? {
        x: x1 + region.x,
        y: y1 + region.y,
        width: x2 - x1 + 1,
        height: y2 - y1 + 1,
        count,
        rows: rows.slice(y1, y2 + 1),
      }
    : { x: 0, y: 0, width: 0, height: 0, count, rows: [] };
}

test('writing-mode and text-orientation are read, by their old names and values too, and inherited', async () => {
  const { node } = await render(
    '<div id="a" style="writing-mode:vertical-rl"><span id="b">x</span></div>' +
      '<div id="c" style="-ms-writing-mode:tb-rl"></div>' +
      '<div id="d" style="-webkit-writing-mode:vertical-lr;' +
      'text-orientation:sideways-right"></div>' +
      '<div id="e" style="writing-mode:sideways-lr;' +
      '-webkit-text-orientation:upright"><i id="f">x</i></div>' +
      '<div id="g" style="writing-mode:vertical-rl;writing-mode:diagonal">' +
      '</div><div id="h" style="writing-mode:vertical-rl;' +
      'writing-mode:lr-tb"></div>',
  );
  const el = view(node);
  const mode = (id: string) => computed(el, id)['writing-mode'];
  const orientation = (id: string) => computed(el, id)['text-orientation'];
  assert.deepStrictEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(mode), [
    'vertical-rl',
    'vertical-rl',
    'vertical-rl',
    'vertical-lr',
    'sideways-lr',
    'sideways-lr',
    'vertical-rl',
    'horizontal-tb',
  ]);
  assert.deepStrictEqual(['a', 'd', 'e', 'f'].map(orientation), [
    'mixed',
    'sideways',
    'upright',
    'upright',
  ]);
});

test('a ch in a vertical line set upright is an em, the advance a glyph stands in there', async () => {
  // CSS Values 4, 6.1.1: the advance of the "0" along the inline axis
  // (WPT css-writing-modes/ch-units-vrl-*)
  const { node } = await render(
    '<style>div{font-size:20px;height:5ch;width:5ch}</style>' +
      '<div id="up" style="writing-mode:vertical-rl;text-orientation:upright"></div>' +
      '<div id="side" style="writing-mode:vertical-rl"></div>' +
      '<div id="flat"></div>',
  );
  const el = view(node);
  assert.deepStrictEqual(
    [rectOf(el, 'up').width, rectOf(el, 'up').height],
    [100, 100],
  );
  // not where the text is turned, which is the "0"'s width
  assert.notStrictEqual(rectOf(el, 'side').width, 100);
  assert.strictEqual(rectOf(el, 'side').width, rectOf(el, 'flat').width);
});

test('logical properties map by the writing mode, wherever it is declared', async () => {
  // CSS Writing Modes 4, 6.4: the block axis starts at the right of
  // vertical-rl and at the left of vertical-lr and sideways-lr, and the
  // inline axis runs down the page, up it in sideways-lr
  const { node } = await render(
    '<style>body{margin:0}.m{margin-block-start:7px}' +
      '.v{writing-mode:vertical-rl}</style>' +
      '<div id="rl" style="writing-mode:vertical-rl;margin-block-start:10px;' +
      'margin-inline-start:4px;padding-block-end:3px;inline-size:50px;' +
      'block-size:20px;border-start-end-radius:6px"></div>' +
      '<div id="lr" style="writing-mode:vertical-lr;margin-block:1px 2px;' +
      'padding-inline-end:5px"></div>' +
      '<div id="up" style="writing-mode:sideways-lr;margin-inline-start:6px;' +
      'padding-block-start:8px"></div>' +
      '<div id="rtl" dir="rtl" style="writing-mode:vertical-rl;' +
      'margin-inline-start:9px"></div>' +
      '<div id="o" class="m v"></div>',
  );
  const el = view(node);
  const sides = (id: string, what: string) => {
    const s = computed(el, id);
    return ['top', 'right', 'bottom', 'left'].map(
      (side) => s[`${what}-${side}`],
    );
  };
  assert.deepStrictEqual(sides('rl', 'margin'), ['4px', '10px', '0px', '0px']);
  assert.deepStrictEqual(sides('rl', 'padding'), ['0px', '0px', '0px', '3px']);
  const rl = computed(el, 'rl');
  assert.deepStrictEqual(
    [rl.width, rl.height],
    ['20px', '50px'],
    'its inline size is its height',
  );
  assert.deepStrictEqual(
    edgesOf(boxOf(el, 'rl')).style.borderRadius,
    [0, 0, 6, 0],
    'block start and inline end are its bottom right',
  );
  assert.deepStrictEqual(sides('lr', 'margin'), ['0px', '2px', '0px', '1px']);
  assert.deepStrictEqual(sides('lr', 'padding'), ['0px', '0px', '5px', '0px']);
  assert.deepStrictEqual(sides('up', 'margin'), ['0px', '0px', '6px', '0px']);
  assert.deepStrictEqual(sides('up', 'padding'), ['0px', '0px', '0px', '8px']);
  assert.deepStrictEqual(
    sides('rtl', 'margin'),
    ['0px', '0px', '9px', '0px'],
    'right to left, the inline start is the bottom',
  );
  assert.deepStrictEqual(
    sides('o', 'margin'),
    ['0px', '7px', '0px', '0px'],
    'a rule before the one that sets the writing mode maps by it',
  );
});

test("the root element is laid out in its body's writing mode, and hands its own to what it holds", async () => {
  // CSS Writing Modes 4, 8: the principal writing mode is the body's; the
  // root takes it as its used value, and no orthogonal flow is made
  // between the two (WPT css-writing-modes/wm-propagation-body-*)
  const { node } = await render(
    '<html id="root"><style>html{writing-mode:vertical-lr}body{margin:0;' +
      'writing-mode:horizontal-tb}html::after{content:"a b c";display:block}' +
      '</style><div id="d" style="height:20px">x</div>',
  );
  const el = view(node);
  const d = rectOf(el, 'd');
  // the body fills the line, across the page
  assert.strictEqual(d.width, 400);
  assert.strictEqual(computed(el, 'd')['writing-mode'], 'horizontal-tb');
  // and the root's own writing mode is what it computes to
  assert.strictEqual(computed(el, 'root')['writing-mode'], 'vertical-lr');
  cleanup();
  // a vertical body puts its first block where its lines start: the right
  // of the page for vertical-rl
  const turned = await render(
    '<html><style>body{margin:0;writing-mode:vertical-rl}</style>' +
      '<body><div id="d" style="width:20px;height:20px"></div></body></html>',
  );
  const r = rectOf(view(turned.node), 'd');
  assert.strictEqual(r.x + r.width, 400, `at the right: ${r.x}`);
});

test("the user agent's margins and paddings are logical, and an element's own dir maps them", async () => {
  // HTML 15.3.3, 15.3.7, 15.3.8: a paragraph's margins are along its
  // block axis, a list's indent and a quotation's rule before its lines
  // start — on the left and right of a vertical paragraph, and on the
  // right of a list its `dir` makes right to left
  const { node } = await render(
    '<style>body{margin:0;font:10px sans-serif}</style>' +
      '<p id="p">a</p>' +
      '<p id="vp" style="writing-mode:vertical-lr">a</p>' +
      '<p id="rp" style="writing-mode:vertical-rl">a</p>' +
      '<ul id="ul"><li>a</li></ul>' +
      '<ul id="rtl" dir="rtl"><li>a</li></ul>' +
      '<blockquote id="q" dir="rtl">a</blockquote>' +
      '<dl><dd id="dd" style="writing-mode:vertical-rl">a</dd></dl>' +
      '<div dir="rtl"><ol id="in"><li>a</li></ol></div>',
  );
  const el = view(node);
  const sides = (id: string, what: string) => {
    const s = computed(el, id);
    return ['top', 'right', 'bottom', 'left'].map(
      (side) => s[`${what}-${side}${what === 'border' ? '-width' : ''}`],
    );
  };
  assert.deepStrictEqual(sides('p', 'margin'), ['10px', '0px', '10px', '0px']);
  assert.deepStrictEqual(
    sides('vp', 'margin'),
    ['0px', '10px', '0px', '10px'],
    "a vertical paragraph's margins are on its left and right",
  );
  assert.deepStrictEqual(sides('rp', 'margin'), ['0px', '10px', '0px', '10px']);
  assert.deepStrictEqual(sides('ul', 'padding'), ['0px', '0px', '0px', '40px']);
  assert.deepStrictEqual(
    sides('rtl', 'padding'),
    ['0px', '40px', '0px', '0px'],
    "a list's own dir puts its indent on the right",
  );
  assert.deepStrictEqual(sides('q', 'padding'), ['0px', '10px', '0px', '0px']);
  assert.deepStrictEqual(
    sides('q', 'border'),
    ['0px', '3px', '0px', '0px'],
    "and a quotation's rule",
  );
  assert.deepStrictEqual(
    sides('dd', 'margin'),
    ['40px', '0px', '0px', '0px'],
    "a vertical definition's indent is above it",
  );
  assert.deepStrictEqual(
    sides('in', 'padding'),
    ['0px', '40px', '0px', '0px'],
    'as it is for a direction inherited',
  );
});

test('an inline element in another writing mode than its parent is an inline-block', async () => {
  const { node } = await render(
    '<p>a <span id="s" style="writing-mode:vertical-rl">b</span> ' +
      '<span id="t" style="writing-mode:horizontal-tb">c</span></p>' +
      '<div style="writing-mode:vertical-rl"><span id="u">d</span></div>',
  );
  const el = view(node);
  assert.strictEqual(computed(el, 's').display, 'inline-block');
  assert.strictEqual(computed(el, 't').display, 'inline', 'the same mode');
  assert.strictEqual(computed(el, 'u').display, 'inline', 'as its parent');
});

test("an absolute box in a vertical writing mode is no taller than what its insets leave of its containing block's height", async () => {
  // CSS Position 3, 4.1: the room an orthogonal flow fits its content in is
  // its inset-modified containing block's (WPT css-anchor-position/
  // anchor-center-htb-vrl)
  const text = 'a a a a a a a a a a a a a a a a a a a a a a a a';
  const { node } = await render(
    '<style>body{margin:0}.cb{position:relative;width:100px;height:100px}' +
      '.t{position:absolute;writing-mode:vertical-rl;width:20px;left:0;' +
      'line-height:10px}</style>' +
      `<div class="cb"><div class="t" id="none">${text}</div></div>` +
      `<div class="cb"><div class="t" id="top" style="top:20px">${text}</div></div>` +
      `<div class="cb"><div class="t" id="both" style="top:10px;bottom:-20px">${text}</div></div>`,
  );
  const el = view(node);
  assert.deepStrictEqual(
    ['none', 'top', 'both'].map((id) => boxOf(el, id).height),
    [100, 80, 110],
  );
});

test('an absolute box that was inline-level is placed on its line in a vertical flow, where the pen stood, and a block-level one under it', async () => {
  // CSS 2.1 10.3.7 and 10.6.4 in the frame's axes (CSS Writing Modes 4,
  // 7.1; WPT css-writing-modes/abs-pos-non-replaced-vlr-003 and its kin):
  // a box's static position is where the flow would have put it, and an
  // inline one would have been after what the line held
  for (const [mode, line] of [
    ['vertical-lr', 80],
    ['vertical-rl', 220],
  ] as const) {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        `<div style="position:relative;writing-mode:${mode};width:320px;` +
        'height:320px;font:20px/20px sans-serif">' +
        '<div style="width:80px;height:160px"></div>' +
        '<span style="display:inline-block;width:10px;height:24px"></span>' +
        '<span id="inline" style="position:absolute">X</span>' +
        '<div id="block" style="position:absolute;width:10px;height:10px"></div>' +
        '</div>',
    );
    const el = view(node);
    const inline = rectOf(el, 'inline');
    assert.deepStrictEqual(
      [inline.x, inline.y],
      [line, 24],
      `${mode}, on the line`,
    );
    // a block would have broken the line: it goes under it, at its start
    const block = rectOf(el, 'block');
    assert.deepStrictEqual(
      [block.x, block.y],
      [mode === 'vertical-lr' ? line + 20 : line - 10, 0],
      `${mode}, after the line`,
    );
  }
});

metric(
  'an image, a background image and a gradient in a vertical flow are upright, level with the page',
  async () => {
    // they are physical (CSS Writing Modes 4, 7.1): only the lines turn. A
    // frame turns all it draws a quarter, and they were drawn turned with it
    const half = pixelsPng(20, 10, (_x, y) =>
      y < 5 ? [255, 0, 0] : [0, 255, 0],
    );
    const { result } = await renderWithBytes(
      '<style>body{margin:0}div{width:20px;height:10px}</style>' +
        '<div style="writing-mode:vertical-rl;width:100px;height:40px">' +
        '<img src="half.png" width="20" height="10" style="display:block">' +
        '<div style="background:url(half.png) no-repeat"></div>' +
        '<div style="background:linear-gradient(to bottom,#f00 50%,#0f0 50%)"></div>' +
        '</div>',
      { 'half.png': half },
      200,
    );
    // each is 20 wide and 10 tall on the page, from the right, the image's
    // red half at its top and its green half at its bottom
    for (const [what, x] of [
      ['image', 80],
      ['background', 60],
      ['gradient', 40],
    ] as const) {
      const top = await pixelsIn(result.ctx, {
        x: x + 10,
        y: 2,
        width: 1,
        height: 1,
      });
      const bottom = await pixelsIn(result.ctx, {
        x: x + 10,
        y: 7,
        width: 1,
        height: 1,
      });
      assert.deepStrictEqual(
        [[...top.slice(0, 3)], [...bottom.slice(0, 3)]],
        [
          [255, 0, 0],
          [0, 255, 0],
        ],
        what,
      );
    }
  },
);

test('a horizontal block in a vertical flow is a frame of its own, which turns back what the flow turned', async () => {
  // CSS Writing Modes 4, 7.3: an orthogonal flow inside an orthogonal flow
  // (WPT css-anchor-position/anchor-center-vrl-htb). Its width is the room
  // the page has across it, fit to its content, its text runs across the
  // page, and a page reads it as it is drawn
  const text = 'a a a a a a a a a a a a a a a a a a a a a a a a';
  const { node } = await render(
    '<style>body{margin:0}.cb{position:relative;writing-mode:vertical-rl;' +
      'width:100px;height:100px}.t{writing-mode:horizontal-tb;line-height:10px}' +
      '.abs{position:absolute;top:0}</style>' +
      `<div class="cb"><div class="t" id="flow">${text}</div></div>` +
      `<div class="cb"><div class="t abs" id="abs" style="left:20px">${text}</div></div>` +
      `<div class="cb"><div class="t abs" id="short" style="right:0">a a</div></div>`,
  );
  const el = view(node);
  const flow = rectOf(el, 'flow');
  // as wide as the vertical box across, and its lines stacked down the page
  assert.strictEqual(flow.width, 100);
  assert.ok(flow.height > 10, `its lines run across: ${flow.height}`);
  assert.strictEqual(flow.y, 0);
  // what its insets leave across the page
  const abs = rectOf(el, 'abs');
  assert.deepStrictEqual([abs.x - 0, abs.width], [20, 80]);
  // and no wider than what it holds, against its right
  const short = rectOf(el, 'short');
  assert.ok(short.width < 50, `fit to its content: ${short.width}`);
  assert.strictEqual(short.x + short.width, 100);
  assert.strictEqual(short.height, 10, 'one line, across the page');
});

test('a horizontal block in a vertical-lr flow is a frame of its own too, and holds its lines', async () => {
  // the flow is put back across after it is laid out (`reflectFrame`),
  // which moves the horizontal block whole and nothing in its own frame
  // (WPT css-writing-modes/sizing-orthog-htb-in-vlr-*)
  const { node } = await render(
    '<style>body{margin:0}.t{writing-mode:horizontal-tb;' +
      'border:3px solid blue}</style>' +
      '<div style="writing-mode:vertical-lr;height:100px">' +
      '<p style="margin:0" id="before">ab</p>' +
      '<div class="t" id="flow"><span id="text">a a a a</span></div>' +
      '<p style="margin:0" id="after">cd</p></div>',
  );
  const el = view(node);
  const flow = rectOf(el, 'flow');
  const text = rectOf(el, 'text');
  const before = rectOf(el, 'before');
  const after = rectOf(el, 'after');
  // left to right: the paragraph, the block, the paragraph
  assert.ok(before.x + before.width <= flow.x, 'the block is after the first');
  assert.ok(flow.x + flow.width <= after.x, 'and before the second');
  // its text across the page, inside its border
  assert.ok(text.width > text.height, `written across: ${text.width}`);
  assert.ok(
    text.x >= flow.x + 2.5 &&
      text.x + text.width <= flow.x + flow.width - 2.5 &&
      text.y >= flow.y &&
      text.y + text.height <= flow.y + flow.height,
    `its line is in its content box: ${JSON.stringify([text, flow])}`,
  );
});

test('a document in no vertical writing mode makes no frame', async () => {
  const flat = await render(
    '<div style="writing-mode:horizontal-tb">a</div><p>b</p>',
  );
  assert.strictEqual(
    (treeOf(view(flat.node)) as { vertical: boolean }).vertical,
    false,
  );
  cleanup();
  const turned = await render('<div style="writing-mode:vertical-rl">a</div>');
  assert.strictEqual(
    (treeOf(view(turned.node)) as { vertical: boolean }).vertical,
    true,
  );
});

metric(
  'a vertical block is as wide as its line, not its container, and as tall as the line that runs down it',
  async () => {
    const { node } = await render(
      PAGE +
        '<div style="width:300px"><div id="v" style="writing-mode:vertical-rl">' +
        '<span id="t">Hello world</span></div></div>' +
        '<span id="h">Hello world</span>',
    );
    const el = view(node);
    const v = rectOf(el, 'v');
    const t = rectOf(el, 't');
    const h = rectOf(el, 'h');
    // its width is its block size, which is its content's (CSS Writing
    // Modes 4, 7.3.2): 18 in all three engines, a line of 16px text
    assert.ok(Math.abs(v.width - h.height) < 1, `${v.width} vs ${h.height}`);
    assert.ok(Math.abs(v.height - h.width) < 1, `${v.height} vs ${h.width}`);
    // its text is turned: as tall as the horizontal text is wide, as wide
    // as it is tall, and at the right, where vertical-rl's lines start
    assert.ok(Math.abs(t.height - h.width) < 1, `${t.height}`);
    assert.ok(Math.abs(t.width - h.height) < 1, `${t.width}`);
    assert.ok(
      Math.abs(t.x + t.width - (v.x + v.width)) < 1,
      `ends at ${t.x + t.width}`,
    );
    assert.strictEqual(hitAtMiddleOf(el, 't'), 't');
  },
);

metric(
  'a vertical block in a horizontal page is as wide as its lines and its edges, with every margin of its blocks, at 1x and 2x',
  async () => {
    // what Chromium, Firefox and WebKit make of it at both scales: 26, a
    // line and two borders; 73, its padding, its lines and its blocks'
    // margins, the last one's too, where it was 3 short of them; and 20,
    // the auto margins sharing what is left as Chromium and WebKit share
    // it, where Firefox leaves the block at the left
    const source =
      '<style>body{margin:0;font:16px/20px sans-serif}' +
      'p{margin:0;margin-block:10px 3px}</style>' +
      '<div id="a" style="writing-mode:vertical-lr;border:3px solid blue">' +
      '01 02 03 04 05 06 07 08 09 10</div>' +
      '<div id="b" style="writing-mode:vertical-rl;padding:0 5px">' +
      '<p>one</p><p>two</p></div>' +
      '<div id="c" style="writing-mode:vertical-rl;margin:0 auto">abc</div>';
    for (const scale of [1, 2]) {
      const { node } = await (scale === 1
        ? render(source, 400)
        : render2x(source, 400));
      const el = view(node);
      const a = rectOf(el, 'a');
      const b = rectOf(el, 'b');
      const c = rectOf(el, 'c');
      assert.ok(Math.abs(a.width - 26) < 0.01, `${scale}x: ${a.width}`);
      assert.ok(Math.abs(b.width - 73) < 0.01, `${scale}x: ${b.width}`);
      assert.ok(Math.abs(c.width - 20) < 0.01, `${scale}x: ${c.width}`);
      assert.ok(Math.abs(c.x - 190) < 0.01, `${scale}x: at ${c.x}`);
      cleanup();
    }
  },
);

metric(
  'a vertical body or root element starts its lines at the right of the viewport, as the engines do',
  async () => {
    // Its writing mode is the document's principal one, which a browser
    // lays the root element out in (CSS Writing Modes 4, 8): its lines
    // start at the right, the first 20 across from 392 in a viewport 400
    // wide with an 8px margin, its text from 373 to 391 in all three
    // engines, written or implied `<html>` alike: inside that line,
    // wherever a face's ascent and descent put it there
    const sheet = '<style>html{font:16px/20px sans-serif}</style>';
    for (const source of [
      `${sheet}<body style="writing-mode:vertical-rl"><span id="t">aaa bbb</span></body>`,
      `<html>${sheet}<body style="writing-mode:vertical-rl"><span id="t">aaa bbb</span></body></html>`,
      `<html style="writing-mode:vertical-rl">${sheet}<body><span id="t">aaa bbb</span></body></html>`,
    ]) {
      const { node } = await render(source, 400);
      const t = rectOf(view(node), 't');
      assert.ok(t.x >= 372 && t.x + t.width <= 392, `${source}: ${t.x}`);
      cleanup();
    }
    // and containment on the root keeps the body's to the body, which is
    // then a flow like any other, as wide as its line at the left: 20 at 8
    const { node } = await render(
      '<style>html{contain:paint;font:16px/20px sans-serif}</style>' +
        '<body id="b" style="writing-mode:vertical-rl"><span id="t">aaa bbb' +
        '</span></body>',
      400,
    );
    const b = rectOf(view(node), 'b');
    assert.ok(Math.abs(b.x - 8) < 0.01 && Math.abs(b.width - 20) < 0.01);
  },
);

metric(
  'an image on a vertical line is set by its middle on the central baseline, and by its edge where the text is set sideways',
  async () => {
    // A box with no baseline of its own has its central one made up at its
    // middle (CSS Inline 3), so an image 50 across is a line 50 across and
    // the block 150 of borders and 50, where it was the strut's descent
    // more; and one 30 across beside text a line 30 across, the strut in
    // the middle of it, in every face: so in all three engines in sans,
    // serif and monospace alike. Set sideways, the dominant baseline is
    // the alphabetic one, and it sits on it by its edge, the line wider by
    // the strut's descent: 55, 55.5 and 54.67 in Chromium, Firefox and
    // WebKit
    const edges = 'border-left:100px solid;border-right:50px solid';
    const { node } = await render(
      '<style>body{margin:0;font:16px/20px sans-serif}</style>' +
        `<div id="rl" style="writing-mode:vertical-rl;${edges}">` +
        '<img id="ri" width="50" height="50"></div>' +
        `<div id="lr" style="writing-mode:vertical-lr;${edges}">` +
        '<img id="li" width="50" height="50"></div>' +
        '<div id="s" style="writing-mode:vertical-rl">ab' +
        '<img id="si" width="30" height="30">cd</div>' +
        '<div id="w" style="writing-mode:vertical-rl;text-orientation:sideways">' +
        'ab<img width="50" height="50">cd</div>',
      400,
    );
    const el = view(node);
    for (const id of ['rl', 'lr']) {
      const box = rectOf(el, id);
      const img = rectOf(el, id[0] + 'i');
      assert.ok(Math.abs(box.width - 200) < 0.01, `${id}: ${box.width}`);
      assert.ok(Math.abs(img.x - box.x - 100) < 0.01, `${id}: ${img.x}`);
    }
    const s = rectOf(el, 's');
    assert.ok(Math.abs(s.width - 30) < 0.01, `${s.width}`);
    assert.ok(Math.abs(rectOf(el, 'si').x - s.x) < 0.01);
    const w = rectOf(el, 'w').width;
    assert.ok(w > 51, `sideways: ${w}`);
  },
);

metric(
  'a vertical flow wraps at the height it is given, its lines right to left in vertical-rl and left to right in vertical-lr',
  async () => {
    const words =
      '<span id="#a">aaaa</span> <span id="#b">bbbb</span> ' +
      '<span id="#c">cccc</span>';
    const { node } = await render(
      PAGE +
        '<style>div{height:60px;display:inline-block;margin:0 10px}</style>' +
        `<div id="rl" style="writing-mode:vertical-rl">${words.replace(/#/g, 'r')}</div>` +
        `<div id="lr" style="writing-mode:vertical-lr">${words.replace(/#/g, 'l')}</div>`,
    );
    const el = view(node);
    const rl = rectOf(el, 'rl');
    const lr = rectOf(el, 'lr');
    assert.strictEqual(rl.height, 60, 'as tall as it says');
    const lines = linesOf(el, 'rl');
    assert.strictEqual(lines.length, 3, 'a word to a line');
    // each is as wide as its lines side by side
    assert.ok(
      Math.abs(rl.width - lines.reduce((n, l) => n + l.height, 0)) < 1,
      `${rl.width}`,
    );
    const [ra, rb, rc] = ['ra', 'rb', 'rc'].map((id) => rectOf(el, id));
    assert.ok(ra.x > rb.x && rb.x > rc.x, 'right to left');
    assert.ok(Math.abs(ra.x + ra.width - (rl.x + rl.width)) < 1);
    for (const r of [ra, rb, rc]) {
      assert.ok(Math.abs(r.y - rl.y) < 1, 'each line starts at the top');
    }
    const [la, lb, lc] = ['la', 'lb', 'lc'].map((id) => rectOf(el, id));
    assert.ok(la.x < lb.x && lb.x < lc.x, 'left to right');
    assert.ok(Math.abs(la.x - lr.x) < 1, `${la.x} vs ${lr.x}`);
    for (const id of ['ra', 'rb', 'rc', 'la', 'lb', 'lc']) {
      assert.strictEqual(hitAtMiddleOf(el, id), id);
    }
  },
);

metric('sideways-lr runs up the page, its lines left to right', async () => {
  const { node } = await render(
    PAGE +
      '<div id="s" style="writing-mode:sideways-lr;height:60px;' +
      'display:inline-block"><span id="a">aaaa</span> ' +
      '<span id="b">bbbb</span></div>',
  );
  const el = view(node);
  const s = rectOf(el, 's');
  const a = rectOf(el, 'a');
  const b = rectOf(el, 'b');
  assert.ok(Math.abs(a.y + a.height - (s.y + s.height)) < 1, 'from the bottom');
  assert.ok(a.x < b.x, 'its second line to the right of its first');
  assert.strictEqual(hitAtMiddleOf(el, 'b'), 'b');
});

metric(
  'a vertical inline-block is as wide as its line and stands on the baseline by its bottom margin edge',
  async () => {
    const { node } = await render(
      PAGE +
        '<p id="p">before <span id="l" style="writing-mode:vertical-rl;' +
        'margin-bottom:4px">Label</span> after</p><span id="h">Label</span>',
    );
    const el = view(node);
    const l = rectOf(el, 'l');
    const h = rectOf(el, 'h');
    assert.ok(Math.abs(l.width - h.height) < 1, `${l.width} vs ${h.height}`);
    assert.ok(Math.abs(l.height - h.width) < 1, `${l.height} vs ${h.width}`);
    const [line] = linesOf(el, 'p');
    const p = rectOf(el, 'p');
    assert.ok(
      Math.abs(
        p.y + line.y - boxOf(el, 'p').y + line.baseline - (l.y + l.height + 4),
      ) < 1,
      'its bottom margin edge on the baseline',
    );
  },
);

metric(
  'a table header cell set vertically is a line wide and as tall as its text, and turned half round reads up the page',
  async () => {
    const { node } = await render(
      PAGE +
        '<style>td,th{padding:0}th{writing-mode:vertical-rl}' +
        '.turned{transform:rotate(180deg)}</style>' +
        '<table cellspacing="0"><tr><th id="q"><span id="q1">Quantity</span>' +
        '</th><th id="n" class="turned"><span id="n1">Name</span> ' +
        '<span id="n2">x</span></th></tr>' +
        '<tr><td id="d">1</td><td>2</td></tr></table>' +
        '<span id="h">Quantity</span>' +
        // a row group's writing mode is no row's (CSS Writing Modes 4, 3.1):
        // its cells are each a flow of their own in the table's
        '<table cellspacing="0"><thead style="writing-mode:vertical-rl">' +
        '<tr><td id="g">Quantity</td></tr></thead></table>',
    );
    const el = view(node);
    const q = rectOf(el, 'q');
    const h = rectOf(el, 'h');
    assert.ok(Math.abs(q.width - h.height) < 1, `${q.width} vs ${h.height}`);
    assert.ok(q.height >= h.width - 1, `${q.height} vs ${h.width}`);
    assert.strictEqual(rectOf(el, 'd').width, q.width, 'and so is its column');
    const g = rectOf(el, 'g');
    assert.ok(Math.abs(g.width - h.height) < 1, `${g.width} vs ${h.height}`);
    // turned half round, its text runs from the bottom up
    const n1 = rectOf(el, 'n1');
    const n2 = rectOf(el, 'n2');
    assert.ok(n1.y > n2.y, `${n1.y} below ${n2.y}`);
    assert.strictEqual(hitAtMiddleOf(el, 'n1'), 'n1');
  },
);

metric(
  'upright text sets each character in an em of its own, and mixed text turns Latin and keeps CJK upright',
  async () => {
    const { node } = await render(
      PAGE +
        '<style>span{display:inline-block;writing-mode:vertical-rl}</style>' +
        '<span id="u" style="text-orientation:upright">iii</span>' +
        '<span id="m">iii</span><span id="c">日本</span>' +
        '<span id="s" style="text-orientation:sideways">日本</span>' +
        '<i id="h">iii</i>',
    );
    const el = view(node);
    // each run's part of its line rounded up to a 64th of a pixel, as Blink
    // rounds it (`PARAGRAPH_FIT`)
    assert.ok(Math.abs(rectOf(el, 'u').height - 48) < 0.2, 'three ems');
    const m = rectOf(el, 'm').height;
    assert.ok(Math.abs(m - rectOf(el, 'h').width) < 1, `${m}`);
    assert.ok(Math.abs(rectOf(el, 'c').height - 32) < 0.2, 'two ems, upright');
  },
);

/** The ink a document of one vertical element draws, about the box. */
async function inkOf(
  source: string,
): Promise<Awaited<ReturnType<typeof inkIn>>> {
  const { result, node } = await render(PAGE + source, 200);
  const el = view(node);
  await act();
  const { abs } = el as unknown as DrawnNode;
  return inkIn(result.ctx, { x: abs.x, y: abs.y, width: 200, height: 200 });
}

metric(
  "a vertical line's glyphs are drawn turned a quarter clockwise, and sideways-lr's the other way",
  async () => {
    // an em dash is a bar across; turned on its side it is a bar down
    const across = await inkOf('<div style="font-size:60px">—</div>');
    assert.ok(across.width > 4 * across.height, JSON.stringify(across));
    const down = await inkOf(
      '<div style="writing-mode:vertical-rl;font-size:60px">—</div>',
    );
    assert.ok(down.height > 4 * down.width, JSON.stringify(down));
    // an L's stem turned clockwise is a bar along its top, and turned the
    // other way along its bottom
    const top = (ink: { rows: number[] }) => ink.rows[0] + ink.rows[1];
    const bottom = (ink: { rows: number[] }) =>
      ink.rows[ink.rows.length - 1] + ink.rows[ink.rows.length - 2];
    const cw = await inkOf(
      '<div style="writing-mode:vertical-rl;font-size:60px">L</div>',
    );
    assert.ok(top(cw) > 2 * bottom(cw), JSON.stringify(cw.rows));
    const ccw = await inkOf(
      '<div style="writing-mode:sideways-lr;font-size:60px">L</div>',
    );
    assert.ok(bottom(ccw) > 2 * top(ccw), JSON.stringify(ccw.rows));
  },
);

metric(
  'what a vertical line sets upright is drawn upright, where its cell is',
  async () => {
    const upright = await inkOf(
      '<div style="writing-mode:vertical-rl;text-orientation:upright;' +
        'font-size:60px">—</div>',
    );
    assert.ok(upright.width > 4 * upright.height, JSON.stringify(upright));
    // in the middle of the column the line makes, in the em it takes
    assert.ok(upright.y < 60, `${upright.y}`);
    // a character with no glyph in the face is a box taller than it is
    // wide, set upright where it is CJK and turned where it is told to be
    const cjk = await inkOf(
      '<div style="writing-mode:vertical-rl;font-size:60px">日</div>',
    );
    assert.ok(cjk.height > cjk.width, JSON.stringify(cjk));
    const turned = await inkOf(
      '<div style="writing-mode:vertical-rl;text-orientation:sideways;' +
        'font-size:60px">日</div>',
    );
    assert.ok(turned.width > turned.height, JSON.stringify(turned));
  },
);

metric(
  'getComputedStyle reads a box laid out in a vertical flow by the sides of the page',
  async () => {
    const { node } = await render(
      PAGE +
        '<div style="writing-mode:vertical-rl;height:100px">' +
        '<p id="q" style="margin:0;padding-right:5px;border-top:2px solid">' +
        'text</p></div>',
    );
    const el = view(node);
    const q = computed(el, 'q');
    assert.strictEqual(q['padding-right'], '5px');
    assert.strictEqual(q['padding-top'], '0px');
    assert.strictEqual(q['border-top-width'], '2px');
    assert.strictEqual(q['border-left-width'], '0px');
    assert.strictEqual(q.height, '98px', 'its inline size down the page');
  },
);

metric(
  'a vertical flow at a display scale of 2 is where it is at 1',
  async () => {
    const source =
      PAGE +
      '<p>x <span id="l" style="writing-mode:vertical-rl">Label</span></p>' +
      '<div id="v" style="writing-mode:vertical-lr;height:50px">' +
      '<span id="a">aaaa</span> <span id="b">bbbb</span></div>';
    const one = await render(source, 300);
    const at1 = ['l', 'v', 'a', 'b'].map((id) => rectOf(view(one.node), id));
    cleanup();
    const two = await render2x(source, 300);
    const el = view(two.node);
    const at2 = ['l', 'v', 'a', 'b'].map((id) => rectOf(el, id));
    assert.strictEqual(hitAtMiddleOf(el, 'b', 2), 'b');
    for (const [l, , a, b] of [at1, at2]) {
      assert.ok(l.height > 2 * l.width, 'the label runs down the page');
      assert.ok(b.x >= a.x + a.width - 1, 'its lines left to right');
    }
    for (let i = 0; i < at1.length; i += 1) {
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        assert.ok(
          Math.abs(at1[i][k] - at2[i][k]) < 1,
          `${k} ${at1[i][k]} at 1x and ${at2[i][k]} at 2x`,
        );
      }
    }
  },
);

metric(
  'a link in a vertical line is under the pointer where it is drawn, and its hover draws what a build draws',
  async () => {
    const clicks: string[] = [];
    const { result, node } = await render(
      PAGE +
        '<style>a{color:#000000;text-decoration:none}' +
        'a:hover{color:#ff0000}</style>' +
        '<div style="writing-mode:vertical-rl;height:150px;font-size:24px">' +
        'go <a id="a" href="https://example.test/v">there</a> now</div>',
      300,
      { onLink: (href: string) => clicks.push(href) },
    );
    const el = view(node);
    const target = el as unknown as DrawnNode;
    const a = rectOf(el, 'a');
    assert.ok(a.height > 2 * a.width, 'the link runs down the page');
    const { abs } = target;
    assert.strictEqual(
      el.hrefAtPoint(abs.x + a.x + a.width / 2, abs.y + a.y + a.height / 2),
      'https://example.test/v',
    );
    const dx = a.x + a.width / 2 - abs.width / 2;
    const dy = a.y + a.height / 2 - abs.height / 2;
    fireEvent.mouseMove(target, { dx, dy });
    // the glyphs of the link, which turn red under the pointer
    await waitFor(async () => {
      const ink = await pixelsIn(result.ctx, {
        x: Math.round(abs.x + a.x),
        y: Math.round(abs.y + a.y),
        width: Math.round(a.width),
        height: Math.round(a.height),
      });
      let red = 0;
      for (let i = 0; i < ink.length; i += 4) {
        if (ink[i] > 200 && ink[i + 1] < 80 && ink[i + 2] < 80) red += 1;
      }
      assert.ok(red > 20, `${red} red pixels`);
    });
    const hovered = await snapshot(result, el);
    assert.strictEqual(bytesApart(hovered, await rebuilt(result, el)), 0);
    await act(async () => {
      fireEvent.mouseDown(target, { dx, dy });
      fireEvent.mouseUp(target, { dx, dy });
    });
    assert.deepStrictEqual(clicks, ['https://example.test/v']);
  },
);

metric(
  "an orthogonal flow with no height of its own wraps at the viewport's, and follows it and the width as they change",
  async () => {
    // CSS Writing Modes 4, 7.3.1: the room down the page is its containing
    // block's height where that is definite, and the initial containing
    // block's where it is not
    const words = Array.from({ length: 12 }, (_, i) => `word${i}`).join(' ');
    const { el, resize } = await renderScrolled(
      PAGE +
        `<div id="v" style="writing-mode:vertical-rl"><span id="t">${words}` +
        '</span></div>',
      120,
      300,
    );
    const short = rectOf(el, 'v');
    assert.ok(short.height <= 120, `${short.height} in a viewport 120 tall`);
    assert.ok(linesOf(el, 'v').length > 2, 'its words in columns');
    const t = rectOf(el, 't');
    assert.ok(Math.abs(t.x + t.width - short.width) < 1, 'from the right');
    // as wide as its columns side by side, which is its content's block
    // size: 108 in the three engines, with their 18px lines
    const across = () =>
      linesOf(el, 'v').reduce((n, line) => n + line.height, 0);
    assert.ok(Math.abs(short.width - across()) < 0.01, `${short.width}`);
    await resize(240, 250);
    const tall = rectOf(el, 'v');
    assert.ok(Math.abs(tall.width - across()) < 0.01, `${tall.width}`);
    assert.ok(tall.width < short.width, 'narrower in fewer columns');
    assert.ok(tall.height > short.height, `${tall.height}`);
    assert.ok(linesOf(el, 'v').length < 6, 'in fewer columns');
    const moved = rectOf(el, 't');
    assert.ok(
      Math.abs(moved.x + moved.width - tall.width) < 1,
      'still from the right',
    );
  },
);

metric(
  'a line of upright characters beside a line turned on its side is drawn upright alone',
  async () => {
    // the layout of both lines is drawn once, cut to the runs it turns:
    // cut to more than a line's height, the second line's cut took in the
    // first's characters, and drew them on their sides under the upright
    const column = async (source: string) => {
      const { result, node } = await render(PAGE + source, 200);
      const el = view(node);
      await act();
      const { abs } = el as unknown as DrawnNode;
      const r = rectOf(el, 'v');
      // the first line's column, at the right
      return pixelsIn(result.ctx, {
        x: Math.round(abs.x + r.x + r.width - 24),
        y: Math.round(abs.y + r.y),
        width: 24,
        height: 60,
      });
    };
    const style =
      'writing-mode:vertical-rl;height:60px;font-size:20px;line-height:24px;' +
      'display:inline-block';
    const both = await column(`<div id="v" style="${style}">日日日 ——</div>`);
    cleanup();
    const alone = await column(`<div id="v" style="${style}">日日日</div>`);
    assert.strictEqual(bytesApart(both, alone), 0);
  },
);

metric(
  'blocks in a vertical flow stack from its block start, their block margins collapsing between them',
  async () => {
    for (const mode of ['vertical-rl', 'vertical-lr']) {
      const { node } = await render(
        PAGE +
          '<style>p{margin:0;margin-block:10px 3px}</style>' +
          `<div id="r" style="writing-mode:${mode};height:80px;width:200px;` +
          'padding:0 5px"><p id="a">one</p><p id="b">two</p></div>',
        300,
      );
      const el = view(node);
      const a = rectOf(el, 'a');
      const b = rectOf(el, 'b');
      if (mode === 'vertical-rl') {
        assert.ok(Math.abs(a.x + a.width - 195) < 0.01, `${mode}: ${a.x}`);
        assert.ok(Math.abs(a.x - (b.x + b.width) - 10) < 0.01, mode);
      } else {
        assert.ok(Math.abs(a.x - 15) < 0.01, `${mode}: ${a.x}`);
        assert.ok(Math.abs(b.x - (a.x + a.width) - 10) < 0.01, mode);
      }
      cleanup();
    }
  },
);

metric(
  'a box in a vertical writing mode that no frame holds is laid out as though the document had no frame',
  async () => {
    // A flex container makes no frame, so its text is level whatever else
    // is on the page. With a frame elsewhere it was made a line at a time
    // and set upright for a paint that only a frame's root does
    const sheet =
      // a vertical paragraph's margins are on its left and right, so
      // neither has any, and the two are as tall as each other
      '<style>body{margin:0}p{margin:0}' +
      '.r{writing-mode:vertical-rl;height:40px}' +
      '.g{display:flex;width:30px;writing-mode:vertical-lr;' +
      'text-orientation:upright}</style>';
    const laid = async (before: string) => {
      const { node, result } = await render(
        `${sheet}<body>${before}<div class="g" id="g">one two three</div></body>`,
      );
      const el = view(node);
      await act();
      const box = boxOf(el, 'g') as unknown as {
        x: number;
        y: number;
        width: number;
        height: number;
        children: {
          lines: {
            y: number;
            texts: { drawY: number; layout: never }[];
          }[];
        }[];
      };
      const block = box.children[0];
      assert.ok(block.lines.length > 1, 'the text wraps');
      for (const line of block.lines) {
        for (const text of line.texts) {
          assert.ok(
            uprightCells(text.layout) === null,
            'set upright, for a paint no frame does',
          );
        }
      }
      const data = await pixelsIn(result.ctx, {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 128) ink += 1;
      assert.ok(ink > 0, 'the text is drawn');
      return { ink, at: block.lines.map((l) => l.texts.map((t) => t.drawY)) };
    };
    assert.deepStrictEqual(
      await laid('<p class="r">x</p>'),
      await laid('<p style="height:40px">x</p>'),
    );
  },
);

test('a vertical grid is laid out in its frame: its columns run down the page, and its rows across from where its lines start', async () => {
  // CSS Writing Modes 4, 7.3, and CSS Grid 1, 7.1: a grid's columns are
  // its inline axis's tracks and its rows its block axis's
  const grid = (mode: string) =>
    `<div style="display:grid;writing-mode:${mode};` +
    'grid-template-columns:20px 30px;grid-template-rows:40px 50px">' +
    `<div id="${mode}-a" style="grid-area:1/1"></div>` +
    `<div id="${mode}-b" style="grid-area:1/2"></div>` +
    `<div id="${mode}-c" style="grid-area:2/1"></div></div>`;
  const { node } = await render(
    '<style>body{margin:0}</style>' + grid('vertical-rl') + grid('vertical-lr'),
  );
  const el = view(node);
  const at = (id: string) => {
    const r = rectOf(el, id);
    return [r.x, r.y, r.width, r.height];
  };
  // as wide as its rows and as tall as its columns, the first row at its
  // right in vertical-rl
  assert.deepStrictEqual(at('vertical-rl-a'), [50, 0, 40, 20]);
  assert.deepStrictEqual(at('vertical-rl-b'), [50, 20, 40, 30]);
  assert.deepStrictEqual(at('vertical-rl-c'), [0, 0, 50, 20]);
  // and at its left in vertical-lr
  assert.deepStrictEqual(at('vertical-lr-a'), [0, 50, 40, 20]);
  assert.deepStrictEqual(at('vertical-lr-b'), [0, 70, 40, 30]);
  assert.deepStrictEqual(at('vertical-lr-c'), [40, 50, 50, 20]);
});

test("an absolutely positioned item of a vertical-lr grid has its lines left to right, as the grid's own items do", async () => {
  // a positioned box is laid out after its frame is put back across
  // (`reflectFrame`), and was left in vertical-rl's order
  const { node } = await render(
    '<style>body{margin:0}.g{display:grid;writing-mode:vertical-lr;' +
      'position:relative;grid-template:100px/100px;font:10px/10px monospace}' +
      '.g>div{grid-area:1/1}.abs{position:absolute}</style>' +
      '<div class="g"><div><span id="f1">a</span><br><span id="f2">b</span></div>' +
      '<div class="abs"><span id="a1">a</span><br><span id="a2">b</span></div></div>',
  );
  const el = view(node);
  const x = (id: string) => rectOf(el, id).x;
  assert.ok(x('f1') < x('f2'), `the flow's lines: ${x('f1')}, ${x('f2')}`);
  assert.ok(x('a1') < x('a2'), `the positioned box's: ${x('a1')}, ${x('a2')}`);
  assert.strictEqual(x('a1'), x('f1'));
});

test("a subgrid has no frame, and what is in it is orthogonal to its grid's writing mode or not", async () => {
  // A subgrid is laid out in its grid's axes, whatever its own writing
  // mode (CSS Grid 2, 9), so an item of a vertical subgrid of a horizontal
  // grid is an orthogonal flow, and a horizontal item of a horizontal
  // subgrid of a vertical grid is turned back
  const { node } = await render(
    '<style>body{margin:0;font:10px/10px monospace}' +
      '.g{display:grid;justify-items:start;align-items:start}' +
      '.s{display:grid;grid-template:subgrid/subgrid}' +
      '.v{writing-mode:vertical-rl}.h{writing-mode:horizontal-tb}</style>' +
      '<div class="g h"><div class="g s v"><div class="v" id="down">abcdef</div></div></div>' +
      '<div class="g v"><div class="g s h"><div class="h" id="across">abcdef</div></div></div>',
  );
  const el = view(node);
  const down = rectOf(el, 'down');
  assert.ok(
    down.height > down.width,
    `runs down: ${down.width}x${down.height}`,
  );
  const across = rectOf(el, 'across');
  assert.ok(
    across.width > across.height,
    `runs across: ${across.width}x${across.height}`,
  );
});

test('a horizontal grid in a vertical flow is a frame of its own, which turns back what the flow turned', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div style="writing-mode:vertical-rl">' +
      '<div style="display:grid;writing-mode:horizontal-tb;' +
      'grid-template-columns:30px 40px;grid-template-rows:10px">' +
      '<div id="a"></div><div id="b"></div></div></div>',
  );
  const el = view(node);
  const a = rectOf(el, 'a');
  const b = rectOf(el, 'b');
  // its columns across the page, side by side
  assert.deepStrictEqual(
    [a.width, a.height, b.width, b.height],
    [30, 10, 40, 10],
  );
  assert.deepStrictEqual([b.x - a.x, b.y - a.y], [30, 0]);
});

test('vertical grid lanes run their lanes down the page and stack across it', async () => {
  const { node } = await render(
    '<style>body{margin:0}.l{display:grid-lanes;writing-mode:vertical-rl;' +
      'grid-template-columns:20px 30px}.l>div{inline-size:auto;block-size:10px}</style>' +
      '<div class="l"><div id="a"></div><div id="b"></div><div id="c"></div></div>',
  );
  const el = view(node);
  const at = (id: string) => {
    const r = rectOf(el, id);
    return [r.x, r.y, r.width, r.height];
  };
  // the first item of each lane at the lanes' right, where vertical-rl's
  // lines start, and the third under the shorter, the first
  assert.deepStrictEqual(at('a'), [10, 0, 10, 20]);
  assert.deepStrictEqual(at('b'), [10, 20, 10, 30]);
  assert.deepStrictEqual(at('c'), [0, 0, 10, 20]);
});

test("a vertical-lr grid's items aligned by their baselines meet at them, though its rows are put back across", async () => {
  // Laid out as vertical-rl's and moved whole to the other side, an item's
  // baseline is as far from its far edge as it was from its near one. A
  // glyph's baseline divides its box across the line in one ratio at every
  // size, so where items of three sizes meet gives the ratio, which is the
  // ratio down a horizontal line's, from the other side: sideways text has
  // its descent at its left. Aligned on their baselines' mirror, the items
  // meet too, at the mirror's ratio
  const grid = (mode: string, id: string) =>
    `<div class="g" style="writing-mode:${mode}">` +
    `<div style="font-size:10px"><span id="${id}s">a</span></div>` +
    `<div style="font-size:20px"><span id="${id}m">a</span></div>` +
    `<div style="font-size:40px"><span id="${id}l">a</span></div></div>`;
  const { node } = await render(
    '<style>body{margin:0}.g{display:grid;text-orientation:sideways;' +
      'grid-auto-flow:column;align-items:baseline;font-family:monospace;' +
      'line-height:1;margin-bottom:10px}</style>' +
      grid('vertical-lr', 'v') +
      grid('horizontal-tb', 'h'),
  );
  const el = view(node);
  const ratio = (id: string, at: 'x' | 'y', size: 'width' | 'height') => {
    const [s, m, l] = ['s', 'm', 'l'].map((n) => rectOf(el, id + n));
    // baseline = at + size × r, the same r for each: r from two pairs
    const r1 = (m[at] - s[at]) / (s[size] - m[size]);
    const r2 = (l[at] - s[at]) / (s[size] - l[size]);
    assert.ok(Math.abs(r1 - r2) < 0.02, `${id}: they meet: ${r1} ${r2}`);
    return r1;
  };
  const down = ratio('h', 'y', 'height');
  assert.ok(down > 0.5 && down < 1, `a baseline below the middle: ${down}`);
  const across = ratio('v', 'x', 'width');
  assert.ok(Math.abs(across - (1 - down)) < 0.02, `${across} vs ${1 - down}`);
});

test("self-start and self-end are an item's own start and end in its grid, by its direction and its writing mode", async () => {
  // CSS Box Alignment 3, 4.1; WPT's css-grid/alignment/grid-self-alignment
  const cell = (grid: string, item: string, id: string) =>
    `<div class="g" style="${grid}"><div id="${id}" style="${item};` +
    'justify-self:self-start;align-self:self-start"></div></div>';
  const { node } = await render(
    '<style>body{margin:0}.g{display:grid;grid-template:20px/20px;' +
      'width:20px;height:20px}.g>div{width:10px;height:10px}</style>' +
      // an rtl item starts at the right of an ltr grid's columns
      cell('', 'direction:rtl', 'rtl') +
      // a vertical-rl item's block axis starts at the right, and its
      // lines at the top
      cell('', 'writing-mode:vertical-rl', 'orthogonal') +
      // and in a vertical-lr grid, whose rows start at the left, an rtl
      // horizontal item starts at its right, and at the top of its column
      cell(
        'writing-mode:vertical-lr',
        'writing-mode:horizontal-tb;direction:rtl',
        'across',
      ),
  );
  const el = view(node);
  const at = (id: string, top: number) => {
    const r = rectOf(el, id);
    return [r.x, r.y - top];
  };
  assert.deepStrictEqual(at('rtl', 0), [10, 0]);
  assert.deepStrictEqual(at('orthogonal', 20), [10, 0]);
  assert.deepStrictEqual(at('across', 40), [10, 0]);
});

test("a grid's items aligned by their baselines across a column meet at them, and size the column", async () => {
  // CSS Box Alignment 3, 9.3, and WPT's baseline-alignment-affects-
  // intrinsic-size: a vertical item's baseline across the column is its
  // first line's, and a horizontal item has none there and synthesizes it
  // from its left edge. A glyph's baseline divides its box across the line
  // in one ratio at every size, so three sizes that meet give it
  const { node } = await render(
    '<style>body{margin:0}.g{display:grid;justify-items:baseline;' +
      'justify-content:start;font-family:monospace;line-height:1;' +
      'text-orientation:sideways;float:left}' +
      '.v{writing-mode:vertical-lr}</style>' +
      '<div class="g" id="g">' +
      '<div class="v" style="font-size:10px"><span id="s">a</span></div>' +
      '<div class="v" style="font-size:20px"><span id="m">a</span></div>' +
      '<div class="v" style="font-size:40px"><span id="l">a</span></div>' +
      '<div id="h" style="width:5px;height:5px"></div></div>',
  );
  const el = view(node);
  const [s, m, l] = ['s', 'm', 'l'].map((id) => rectOf(el, id));
  const r1 = (m.x - s.x) / (s.width - m.width);
  const r2 = (l.x - s.x) / (s.width - l.width);
  assert.ok(r1 > 0 && r1 < 1, `they meet past their starts: ${r1}`);
  assert.ok(Math.abs(r1 - r2) < 0.02, `all three: ${r1} ${r2}`);
  // the horizontal item's left edge on it, and the grid wide enough for
  // the furthest moved
  const baseline = s.x + s.width * r1;
  assert.ok(Math.abs(rectOf(el, 'h').x - baseline) < 1, 'at its edge');
  const g = rectOf(el, 'g');
  assert.ok(
    g.x + g.width >= rectOf(el, 's').x + rectOf(el, 's').width - 1,
    'as wide as what moved',
  );
});

metric(
  'a horizontal item in a vertical-lr grid is laid out across the page, as one in vertical-rl is',
  async () => {
    // Its frame turns back what the grid's turned (`makeFrame`'s `back`),
    // and the grid's frame, put back across after its layout
    // (`reflectFrame`), moves it whole and leaves what is in it alone. A
    // `vertical-lr` flow had made no such frame, and an item was laid out in
    // the grid's axes: as wide as its text was tall, and as tall as its line
    // was long. Chrome's, Firefox's and Safari's numbers, the item and an
    // absolutely positioned one alike (WPT's
    // grid-self-alignment-stretch-vertical-lr-*).
    const { node } = await render(
      '<style>body{margin:0}' +
        '.g{position:relative;display:inline-grid;writing-mode:vertical-lr;' +
        'grid-template-columns:100px 150px;grid-template-rows:150px 100px}' +
        '.g>div{writing-mode:horizontal-tb;line-height:0}' +
        '.c{display:inline-block;width:15px;height:10px;vertical-align:top}</style>' +
        '<div class="g">' +
        '<div id="a" style="grid-row:1;grid-column:1;justify-self:stretch;' +
        'align-self:start"><span class="c"></span><span class="c"></span></div>' +
        '<div id="b" style="grid-row:2;grid-column:2;justify-self:start;' +
        'align-self:stretch"><span class="c"></span><span class="c"></span></div>' +
        '<div id="p" style="position:absolute;grid-row:2/3;grid-column:1/2;' +
        'justify-self:end;align-self:end"><span class="c"></span><span class="c"></span></div>' +
        '</div>',
      600,
    );
    const el = view(node);
    const rect = (id: string) => {
      const r = el.offsetRect(findById(el.document, id)!)!;
      return [r.x, r.y, r.width, r.height];
    };
    // a row is across the page and a column down it
    assert.deepStrictEqual(rect('a'), [0, 0, 30, 100], 'stretched down');
    assert.deepStrictEqual(rect('b'), [150, 100, 100, 10], 'stretched across');
    assert.deepStrictEqual(rect('p'), [220, 90, 30, 10], 'at the far corner');
  },
);

test('an orthogonal flow in a block of no height but a max-height is as long as the max-height lets it be', async () => {
  // CSS Writing Modes 4, 7.3.1: the available inline size of an orthogonal
  // flow is its containing block's height where definite, else its
  // definite `max-height`, else the viewport's (WPT's
  // css-writing-modes/available-size-001)
  const { node } = await render(
    '<style>body{margin:0}#p{max-height:100px;overflow:hidden}' +
      '#v{writing-mode:vertical-rl}</style>' +
      '<div id="p"><div id="v">' +
      'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm ' +
      'nnnn oooo pppp qqqq rrrr</div></div>',
  );
  const v = boxOf(view(node), 'v');
  assert.ok(v.height <= 100, `${v.height} no taller than the max-height`);
  assert.ok(v.height > 50, `${v.height} as tall as it lets it be`);
});

metric(
  "a frame's second line is drawn on the columns the page would snap it to",
  async () => {
    // a frame of a writing mode is a quarter turn: drawn at a translation
    // with a fraction in it, or moved by a corner snapped before the turn,
    // a line a fraction across the frame lost a column the same edge on the
    // page keeps (WPT's css-writing-modes/available-size-008)
    const { result, node } = await render(
      '<style>body{margin:0;font:20px/1.13 monospace}' +
        '#v{writing-mode:vertical-rl;height:20px}' +
        'span{display:inline-block;color:transparent}</style>' +
        '<div><div id="v"><span style="height:20px"></span> ' +
        '<span id="g" style="background:#00ff00">0</span></div></div>',
    );
    await act();
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    const g = el.elementRect(findById(el.document, 'g')!)!;
    const y = Math.round(g.y + g.height / 2);
    const green = async (x: number) =>
      (await pixelAt(result.ctx, abs.x + x, abs.y + y))[1] === 255 &&
      (await pixelAt(result.ctx, abs.x + x, abs.y + y))[0] === 0;
    const left = Math.round(g.x);
    const right = Math.round(g.x + g.width);
    assert.ok(await green(left), `column ${left}, the first of ${g.x}`);
    assert.ok(
      await green(right - 1),
      `column ${right - 1}, the last of ${g.x + g.width}`,
    );
    assert.ok(!(await green(right)), `no column ${right} past it`);
  },
);

test('a frame turned up stands where its root ends, to the fraction', async () => {
  // a frame turned up — `sideways-lr`, or a horizontal block turned back in
  // a vertical flow — was placed on a whole pixel down the page, which set
  // a line of text in it at another fraction of a pixel from the same line
  // on the page, and drew some of its glyphs otherwise (WPT's
  // css-writing-modes/sizing-orthog-vrl-in-htb-008, its reference); its
  // pixels are snapped where the page would snap them as it is drawn
  const { node } = await render(
    '<style>body{margin:0;font:20px/1.13 monospace}</style>' +
      '<div style="height:0.4px"></div>' +
      '<div id="s" style="writing-mode:sideways-lr">ab</div>',
  );
  const root = boxOf(view(node), 's') as unknown as {
    contentY: number;
    contentHeight: number;
  };
  const frame = FRAMES.get(root as never) as unknown as { y: number };
  assert.ok(frame, 'the root has a frame');
  assert.strictEqual(frame.y, root.contentY + root.contentHeight);
});

test("an orthogonal flow's line is no longer than the viewport, and its containing block's min-height raises its max-height", async () => {
  // 7.3.1, step 2: the greater of a definite `max-height` and the
  // `min-height` that wins over it, held to the initial containing
  // block's size (WPT's css-writing-modes/available-size-015: a
  // `max-height: 40vh` under `min-height: 120vh` is the viewport)
  const { node } = await render(
    '<style>body{margin:0}#p{max-height:20px;min-height:100000px;' +
      'overflow:hidden}#v{writing-mode:vertical-rl}</style>' +
      '<div id="p"><div id="v">' +
      'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm ' +
      'nnnn oooo pppp qqqq rrrr ssss tttt uuuu vvvv wwww xxxx yyyy zzzz ' +
      'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm ' +
      'nnnn oooo pppp qqqq rrrr ssss tttt uuuu vvvv wwww xxxx yyyy zzzz' +
      '</div></div>',
  );
  const v = boxOf(view(node), 'v');
  // the harness's window is 600 tall
  assert.ok(v.height <= 600, `${v.height} no taller than the viewport`);
  assert.ok(v.height > 100, `${v.height} past the max-height`);
});

test('an orthogonal flow in a block of no height is as long as the scroll container above it is tall', async () => {
  // failing a definite height or max-height on its containing block, the
  // nearest scroll container's above it, held to the viewport's, and not
  // what is left of it after what comes before (WPT's
  // css-writing-modes/available-size-003 and -005)
  const { node } = await render(
    '<style>body{margin:0}#s{height:100px;overflow:hidden}' +
      '#v{writing-mode:vertical-rl}</style>' +
      '<div id="s"><div style="padding-bottom:30px">' +
      '<div style="height:20px"></div><div id="v">' +
      'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm ' +
      'nnnn oooo pppp qqqq rrrr</div></div></div>',
  );
  const v = boxOf(view(node), 'v');
  assert.ok(v.height <= 100, `${v.height} no taller than the scroller`);
  assert.ok(v.height > 80, `${v.height} as tall as it lets it be`);
});

test('a vertical-rl block in a vertical-lr flow keeps its own lines right to left', async () => {
  // a vertical-lr flow is laid out as vertical-rl's and put back across;
  // a block in it that runs right to left was laid out as it reads, and
  // putting its lines back too set its first line at its left (WPT's
  // css-writing-modes/available-size-020, its reference)
  const { node } = await render(
    '<div style="writing-mode:vertical-lr;font:15px/1 sans-serif">' +
      '<article id="m"><aside style="writing-mode:vertical-rl;width:2em;' +
      'height:60px"><span id="a">aaaa</span> <span id="b">bbbb</span>' +
      '</aside></article><article id="n">x</article></div>',
  );
  const el = view(node);
  const at = (id: string) => el.elementRect(findById(el.document, id)!)!.x;
  assert.ok(
    at('a') > at('b'),
    `its first line, ${at('a')}, right of ${at('b')}`,
  );
  assert.ok(at('m') < at('n'), 'and the flow still runs left to right');
});

test('an edge on half a pixel across a vertical-rl frame is drawn on the column the page draws it on', async () => {
  // the frame's turn runs its block axis backwards across the page, so a
  // half it rounds up the page rounds down, and the box came out a column
  // to the left of the same box laid out across (WPT's css-grid
  // grid-self-baseline-vertical-rl-004)
  const { result, node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="writing-mode:vertical-rl;width:100px;height:20px">' +
      '<div style="width:10.5px"></div>' +
      '<div style="width:10px;background:#0f0"></div></div>' +
      '<div style="position:absolute;top:30px;left:79.5px;width:10px;' +
      'height:20px;background:#0f0"></div>',
  );
  await act();
  const { abs } = view(node) as unknown as DrawnNode;
  const row = async (y: number) => {
    let columns = '';
    for (let x = 76; x < 94; x += 1) {
      const p = await pixelAt(result.ctx, abs.x + x, abs.y + y);
      columns += p[1] === 255 && p[0] === 0 ? '#' : '.';
    }
    return columns;
  };
  assert.strictEqual(await row(10), await row(40));
});
