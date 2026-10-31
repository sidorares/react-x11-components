// <Html> — vertical writing modes (CSS Writing Modes 4): a box whose lines
// run down the page is the root of a flow laid out in a frame turned a
// quarter (`layout/writing.ts`), and sized in the page's axes from what the
// frame came to; its logical properties map by its writing mode; and what
// its text sets upright is drawn upright.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, fireEvent, waitFor } from 'react-x11/test';
import { act } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import type { HtmlViewNode } from '../../src/html/index.js';
import {
  boxOf,
  edgesOf,
  findById,
  linesOf,
  metric,
  pixelsIn,
  rebuilt,
  render,
  render2x,
  renderScrolled,
  snapshot,
  bytesApart,
  treeOf,
  view,
} from './harness.js';
import type { Region } from './harness.js';
import { uprightCells } from '../../src/html/layout/writing.js';

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
  'a vertical block fills its container across, and is as tall as the line that runs down it',
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
    assert.strictEqual(v.width, 300, 'stretched across, as a block is');
    assert.ok(Math.abs(v.height - h.width) < 1, `${v.height} vs ${h.width}`);
    // its text is turned: as tall as the horizontal text is wide, as wide
    // as it is tall, and at the right, where vertical-rl's lines start
    assert.ok(Math.abs(t.height - h.width) < 1, `${t.height}`);
    assert.ok(Math.abs(t.width - h.height) < 1, `${t.width}`);
    assert.ok(Math.abs(t.x + t.width - 300) < 1, `ends at ${t.x + t.width}`);
    assert.strictEqual(hitAtMiddleOf(el, 't'), 't');
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
    await resize(240, 250);
    const tall = rectOf(el, 'v');
    assert.strictEqual(tall.width, 250, 'as wide as its container');
    assert.ok(tall.height > short.height, `${tall.height}`);
    assert.ok(linesOf(el, 'v').length < 6, 'in fewer columns');
    const moved = rectOf(el, 't');
    assert.ok(
      Math.abs(moved.x + moved.width - 250) < 1,
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
    // A grid makes no frame, so its text is level whatever else is on the
    // page. With a frame elsewhere it was made a line at a time and set
    // upright for a paint that only a frame's root does
    const sheet =
      '<style>body{margin:0}.r{writing-mode:vertical-rl;height:40px}' +
      '.g{display:grid;width:30px;writing-mode:vertical-lr;' +
      'text-orientation:upright}</style>';
    const laid = async (before: string) => {
      const { node } = await render(
        `${sheet}<body>${before}<div class="g" id="g">one two three</div></body>`,
      );
      const el = view(node);
      await act();
      const block = (
        boxOf(el, 'g') as unknown as {
          children: {
            lines: {
              y: number;
              texts: { drawY: number; layout: never }[];
            }[];
          }[];
        }
      ).children[0];
      assert.ok(block.lines.length > 1, 'the text wraps');
      for (const line of block.lines) {
        for (const text of line.texts) {
          assert.ok(
            uprightCells(text.layout) === null,
            'set upright, for a paint no frame does',
          );
        }
      }
      return block.lines.map((line) => line.texts.map((t) => t.drawY));
    };
    assert.deepStrictEqual(
      await laid('<p class="r">x</p>'),
      await laid('<p style="height:40px">x</p>'),
    );
  },
);
