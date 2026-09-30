// <Html> — floats and clearance, and the boxes and lines beside them.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import {
  MOVED,
  boxOf,
  fillsOf,
  linesOf,
  metric,
  render,
  view,
} from './harness.js';

afterEach(cleanup);

metric(
  "a float sits inside its own containing block, not at the formatting context's edge",
  async () => {
    // Placed in the band the whole formatting context allows, a float in a
    // padded block sat at the root's edge — outside the padding, and outside
    // the body's margin (CSS 2.1 9.5.1, rules 1 and 7).
    const { node } = await render(
      '<style>.wrap{padding:0 30px 0 50px}.l,.r{width:40px;height:20px}' +
        '.l{float:left}.r{float:right}</style>' +
        '<div class="wrap"><div class="l"></div><div class="r"></div></div>',
      300,
    );
    type B = { x: number; width: number; contentX: number; children: B[] };
    const tree = (view(node) as unknown as { _tree: { root: B } })._tree;
    const wrap = tree.root.children[0];
    const [left, right] = wrap.children;
    assert.strictEqual(
      left.x,
      wrap.contentX,
      'the left float at the content edge',
    );
    assert.strictEqual(
      right.x + right.width,
      wrap.x + wrap.width - 30,
      'the right float against the right padding',
    );
  },
);

metric(
  'a float shortens the lines beside it and not the ones below',
  async () => {
    const { node } = await render(
      '<style>.f{float:left;width:100px;height:40px}p{margin:0}</style>' +
        '<div class="f"></div><p>' +
        'word '.repeat(40) +
        '</p>',
      300,
    );
    const tree = (
      view(node) as unknown as {
        _tree: {
          root: {
            children: {
              lines: { x: number; width: number; y: number }[] | null;
            }[];
          };
        };
      }
    )._tree;
    const paragraph = tree.root.children.find(
      (b) => b.lines && b.lines.length > 2,
    );
    assert.ok(paragraph?.lines, 'the paragraph wrapped');
    const beside = paragraph.lines[0];
    const below = paragraph.lines[paragraph.lines.length - 1];
    assert.ok(
      beside.x >= 100,
      `the first line starts beside the float, at ${beside.x}`,
    );
    assert.ok(
      below.x < 100,
      `a line past the float starts at the edge again, at ${below.x}`,
    );
  },
);

metric('a word with no room beside a float goes below it, whole', async () => {
  // CSS 2.1 9.5: a line too short for any of its content moves down until
  // something fits. The word used to be cut to the room the float left.
  // Sized from the word as this machine's face sets it — DejaVu on Linux is
  // a fifth wider than Arial — so the room beside the float is always three
  // quarters of the word and the room below it always half as much again.
  type B = { lines: { y: number; width: number }[] | null; children: B[] };
  const word = 'Antidisestablishment';
  const probe = await render(
    `<p id="w" style="margin:0;font-size:20px">${word}</p>`,
    600,
  );
  const measured = boxOf(view(probe.node), 'w') as unknown as B;
  const wordWidth = measured.lines?.[0]?.width ?? 0;
  assert.ok(wordWidth > 0, 'the word is measured');
  await probe.result.unmount();

  const boxWidth = Math.ceil(wordWidth * 1.5);
  const { node } = await render(
    `<div id="box" style="width:${boxWidth}px;font-size:20px">` +
      `<div style="float:left;width:${Math.ceil(wordWidth * 0.75)}px;height:30px"></div>` +
      `${word}</div>`,
    boxWidth + 100,
  );
  // the text sits in an anonymous block beside the float, so its lines are
  // somewhere under the box rather than on it
  const lines: { y: number }[] = [];
  const walk = (b: B): void => {
    lines.push(...(b.lines ?? []));
    b.children.forEach(walk);
  };
  walk(boxOf(view(node), 'box') as unknown as B);
  assert.strictEqual(lines.length, 1, 'one line, the word whole');
  assert.ok(lines[0].y >= 30, `below the float: ${lines[0].y}`);
});

metric(
  'a float is no narrower than a word across its inline elements',
  async () => {
    // A float's least width is its longest word (CSS 2.1 10.3.5), measured
    // at no width, where every line breaks where it may: at every edge, it
    // was a letter, and the float as wide as its room (WPT bidi-007)
    const { node } = await render(
      '<div style="width:10px"><p id="p" style="float:left;margin:0;' +
        `letter-spacing:4px">a<span style="padding:0 2px;${MOVED}">b</span>c` +
        '</p></div>',
    );
    const el = view(node);
    const lines = linesOf(el, 'p');
    assert.strictEqual(lines.length, 1, 'one line');
    const p = boxOf(el, 'p');
    assert.ok(p.width > 10, `wider than its room: ${p.width}`);
    assert.ok(
      Math.abs(p.width - lines[0].width) < 0.5,
      `as wide as its line: ${p.width} ${lines[0].width}`,
    );
  },
);

metric(
  'a line with an inline-block on it is aligned in the room beside the floats over its height',
  async () => {
    // The second line is 50px tall; the wider float starts 25px into it.
    const block =
      '<span style="display:inline-block;width:200px;height:50px"></span>';
    const { node } = await render(
      '<style>body{margin:0}</style><div id="d" style="width:400px;text-align:right">' +
        '<div style="float:right;width:50px;height:75px"></div>' +
        '<div style="float:right;clear:right;width:100px;height:75px"></div>' +
        `${block} ${block}</div>`,
      500,
    );
    const lines = linesOf(view(node), 'd');
    assert.strictEqual(lines.length, 2);
    const [first] = lines[0].atomics;
    const [second] = lines[1].atomics;
    assert.strictEqual(
      first.x + first.box.width,
      350,
      'beside the narrow float',
    );
    assert.strictEqual(second.x + second.box.width, 300, 'beside the wide one');
  },
);

test('a new formatting context separates from floats it cannot sit beside', async () => {
  // A float in an empty block is placed where the margin collapsing through
  // the block ends, so it moves with the margin, and a box with a formatting
  // context of its own after it must not overlap it (CSS 2.1 9.5). Where the
  // box fits beside the float, the margins collapse and both move; where it
  // does not, it separates from the float as clearance would, and sits under
  // the float rather than pushing it down.
  const { node } = await render(
    '<div id="o" style="overflow:hidden;width:200px"><div><div>' +
      '<div id="f1" style="float:left;width:200px;height:50px"></div></div>' +
      '<div id="c1" style="overflow:hidden;width:200px;height:10px;' +
      'margin-top:80px"></div></div></div>' +
      '<div id="w" style="overflow:hidden;width:300px"><div><div>' +
      '<div id="f2" style="float:left;width:200px;height:50px"></div></div>' +
      '<div id="c2" style="overflow:hidden;width:100px;height:10px;' +
      'margin-top:80px"></div></div></div>',
  );
  const el = view(node);
  const [o, f1, c1, w, f2, c2] = ['o', 'f1', 'c1', 'w', 'f2', 'c2'].map((id) =>
    boxOf(el, id),
  );
  assert.strictEqual(f1.y, o.y, 'the float stays at the top');
  assert.strictEqual(c1.y, f1.y + 50, 'and the box goes under it');
  assert.strictEqual(f2.y, w.y + 80, 'the float moves with the margin');
  assert.strictEqual(c2.y, f2.y, 'and the box sits beside it');
  assert.strictEqual(c2.x, f2.x + 200);
});

metric('floats that add up to their room exactly fit in it', async () => {
  // ten of 0.87em in 8.7em came to more than it by a rounding error, and
  // the tenth went under the other nine
  const { node } = await render(
    '<div style="width:8.7em;font-size:16px">' +
      '<span id="f0" style="float:left;width:0.87em;height:5px"></span>'.repeat(
        9,
      ) +
      '<span id="last" style="float:left;width:0.87em;height:5px"></span></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'last').y, boxOf(el, 'f0').y, 'one row');
});

metric(
  'a block with a formatting context of its own sits beside a float',
  async () => {
    // CSS 2.1 9.5: an `overflow: hidden` block beside a floated image is a
    // rectangle in the room the float leaves, where it ran under the image;
    // a table too wide for the room goes below the floats
    const { node } = await render(
      '<div id="c" style="width:400px">' +
        '<div id="f" style="float:left;width:100px;height:50px"></div>' +
        '<div id="b" style="overflow:hidden;height:20px">beside</div>' +
        '<div id="g" style="float:left;width:300px;height:40px"></div>' +
        '<table id="t" style="width:200px;border-spacing:0"><tr><td>x</td>' +
        '</tr></table></div>',
      500,
    );
    const el = view(node);
    const [c, f, b, g, t] = ['c', 'f', 'b', 'g', 't'].map((id) =>
      boxOf(el, id),
    );
    assert.deepStrictEqual([b.x, b.width], [f.x + f.width, c.width - 100]);
    assert.strictEqual(g.x, f.x + f.width, 'the second float fits beside');
    assert.ok(t.y >= g.y + g.height, `the table goes below both: ${t.y}`);
  },
);

test('a float is painted over the backgrounds of the blocks after it', async () => {
  // CSS 2.1 Appendix E: every in-flow block's background, then the floats,
  // then the lines. Painted a block at a time, the shaded paragraph beside
  // a floated image hid the image under its background.
  const { node } = await render(
    '<div style="float:left;width:50px;height:50px;background:#00ff00"></div>' +
      '<p style="margin:0;background:#ff0000">text</p>' +
      '<div style="float:left;width:50px;height:50px;background:#0000ff"></div>',
  );
  const fills = await fillsOf(view(node));
  const at = (colour: string) =>
    fills.findIndex((f) => f.style === parseColor(colour));
  assert.ok(at('#ff0000') >= 0, 'the paragraph has its background');
  assert.ok(at('#00ff00') > at('#ff0000'), 'the float before it goes over it');
  assert.ok(at('#0000ff') > at('#00ff00'), 'and the floats keep their order');
});

test('a box with a formatting context of its own clears every float along its height', async () => {
  // CSS 2.1 9.5: it must not overlap the margin box of any float beside it,
  // which is every float over its height, not only the one at its top. A
  // wider float starting halfway down it was run over.
  const { node } = await render(
    '<div id="f" style="float:left;clear:left;width:50px;height:75px"></div>' +
      '<div style="float:left;clear:left;width:100px;height:75px"></div>' +
      '<div id="a" style="overflow:hidden;width:200px;height:50px"></div>' +
      '<div id="b" style="overflow:hidden;width:200px;height:50px"></div>',
  );
  const el = view(node);
  const [f, a, b] = ['f', 'a', 'b'].map((id) => boxOf(el, id));
  assert.strictEqual(a.x, f.x + 50, 'beside the first float');
  assert.strictEqual(b.x, f.x + 100, 'and beside the second, lower down');
  assert.strictEqual(b.y, a.y + 50);
});

test('a line of an inline-block clears the floats beside all of its height', async () => {
  // CSS 2.1 9.5: a line box must not run into a float, and an inline-block
  // makes its line as tall as itself. The room was taken for a line of
  // text, so the block ran into a float that started beside its lower part.
  const { node } = await render(
    '<div id="w" style="width:400px">' +
      '<div style="float:left;width:150px;height:75px"></div>' +
      '<div style="float:right;width:300px;height:75px"></div>' +
      '<span id="a" style="display:inline-block;vertical-align:top;' +
      'width:200px;height:50px"></span>' +
      '<span id="b" style="display:inline-block;vertical-align:top;' +
      'width:200px;height:50px"></span></div>',
  );
  const el = view(node);
  const [w, a, b] = ['w', 'a', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([a.x - w.x, a.y - w.y], [150, 0]);
  assert.deepStrictEqual([b.x - w.x, b.y - w.y], [0, 150], 'below both');
});

test('a line takes its room beside the floats over its own height', async () => {
  // the room was taken over a line of text's, 1.4em, whatever the line
  // held: a 20px inline-block on a line of no height went below floats
  // that start 20px down, rather than beside the one at its top
  const { node } = await render(
    '<div id="w" style="width:100px;font-size:20px;line-height:0">' +
      '<div style="float:right;width:40px;height:20px"></div>' +
      '<div style="float:right;clear:right;width:50px;height:50px"></div>' +
      '<div style="float:left;width:50px;height:50px"></div>' +
      '<span id="s" style="display:inline-block;width:40px;height:20px">' +
      '</span></div>',
  );
  const el = view(node);
  const [w, s] = ['w', 's'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([s.x - w.x, s.y - w.y], [0, 0]);
});

test('a float after one that waits for the next line waits too', async () => {
  // none goes higher than a float before it (CSS 2.1 9.5.1, rule 5): the
  // two after a float too wide for the line went beside the line's text,
  // above it
  const { node } = await render(
    '<div style="width:100px;font-size:5px">H' +
      '<div id="a" style="width:100px;height:100px;float:left"></div>' +
      '<div id="b" style="width:30px;height:30px;float:left"></div>' +
      '<div id="c" style="width:30px;height:30px;float:right"></div></div>',
  );
  const el = view(node);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
  assert.ok(b.y >= a.y + 100 && c.y >= b.y, `${a.y} ${b.y} ${c.y}`);
});

metric(
  'a float met inside text that may not break keeps that text on one line',
  async () => {
    // no break at the float, so the word before it goes to the next line
    // with the word after it: the line ran past its width, the float below
    const { node } = await render(
      '<style>body{margin:0}#d{font-size:10px;width:12ch;line-height:1}' +
        '#f{float:left;width:12ch;height:1em}</style>' +
        '<div id="d">1111 <nobr>2222 <div id="f"></div> 3333</nobr></div>',
    );
    const el = view(node);
    assert.strictEqual(linesOf(el, 'd').length, 2);
    assert.strictEqual(boxOf(el, 'f').y - boxOf(el, 'd').y, 20);
  },
);

test('a margin after an empty block with clearance stays in the parent', async () => {
  // CSS 2.1 8.3.1, 10.6.3: an empty block cleared past a float spends its
  // own margins on its clearance, and the margins that collapse with it
  // after it do not collapse through the parent's bottom
  const { node } = await render(
    '<div id="a"><div style="float:left;height:1px"></div>' +
      '<div style="clear:left"></div><div style="margin-top:99px"></div></div>' +
      '<div id="b" style="margin-bottom:40px">' +
      '<div style="height:20px;margin-bottom:20px"></div>' +
      '<div style="float:left;height:20px"></div>' +
      '<div style="clear:both;margin:30px 0 20px"></div></div>' +
      '<div id="c"></div>',
  );
  const el = view(node);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
  assert.strictEqual(a.height, 100, 'the 99px after the cleared block');
  assert.strictEqual(b.height, 60, 'but none of its own');
  assert.strictEqual(c.y, b.y + 60 + 40);
});

test('a cleared block the margin above would take past its float goes under it, up if need be', async () => {
  // where it would be with `clear: none`, its margin collapsed up through
  // its parent's top, is above the float, so it has clearance, and its
  // border edge goes under the float: its own margin, held apart, stood it
  // 48px lower, and its parent as short as nothing (CSS 2.1 9.5.2)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="float:left;width:50px;height:100px"></div>' +
      '<div style="padding-top:1px"><div id="p">' +
      '<div style="margin-bottom:49px"></div>' +
      '<div id="c" style="clear:left;margin-top:98px"></div></div></div>',
  );
  const el = view(node);
  const [p, c] = ['p', 'c'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([p.y, c.y, p.height], [50, 100, 50]);
});

test("a cleared block's place without clearance counts the margins in it", async () => {
  // a margin deep inside it collapses up through its top and takes it
  // past the floats, so it has no clearance: it was cleared from its own
  // margin alone, and drew itself under the floats (CSS 2.1 9.5.2)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="float:left;width:50px;height:50px"></div>' +
      '<div style="float:right;width:50px;height:100px"></div>' +
      '<div style="width:100px;height:100px">' +
      '<div style="height:15px;margin-bottom:20px"></div>' +
      '<div id="a"><div id="l" style="clear:left"><div style="clear:right">' +
      '<div style="margin-top:185px"></div></div></div></div></div>',
  );
  const el = view(node);
  assert.deepStrictEqual([boxOf(el, 'a').y, boxOf(el, 'l').y], [200, 200]);
});

test("a block after an empty one cleared past a float starts at the cleared one's edge", async () => {
  // their margins collapse together, the cleared one's top margin among
  // them, which is above its edge: the block after starts at the edge
  // where they come to no more than that margin. It started the cleared
  // one's bottom margin lower (CSS 2.1 8.3.1)
  const { node } = await render(
    '<style>body{margin:0}</style><div id="w">' +
      '<div style="float:left;width:10px;height:64px"></div>' +
      '<div style="clear:left;margin:32px 0"></div>' +
      '<div id="b" style="margin-top:16px;border-top:32px solid"></div></div>',
  );
  const el = view(node);
  assert.deepStrictEqual([boxOf(el, 'b').y, boxOf(el, 'w').height], [64, 96]);
});

test('a float or an absolute box inside an inline box is laid out', async () => {
  // An inline box lays out nothing of its own, and the block's walk met
  // only its own children: a float in a padded <span>, or a badge set
  // absolute inside a link, stood at the page's corner with no size.
  const { node } = await render(
    '<p id="p">text <span style="padding:30px;margin:40px">' +
      '<span id="f" style="float:left;width:40px;height:40px"></span>' +
      '<b id="a" style="position:absolute;width:20px;height:20px"></b>' +
      '</span></p>',
  );
  const el = view(node);
  const [p, f, a] = ['p', 'f', 'a'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([f.x, f.y, f.width, f.height], [p.x, p.y, 40, 40]);
  assert.deepStrictEqual([a.width, a.height], [20, 20]);
  assert.strictEqual(a.y, p.y, 'at its static position');
});

/** Blocks of set widths, run together, so a line holds what the widths
 *  say whatever the font: `[200, 'f', 40]` is two inline-blocks and the
 *  float `#f` between them. */
function floatLine(float: string, parts: (number | 'f')[]): string {
  let n = 0;
  return parts
    .map((part) =>
      part === 'f'
        ? `<span id="f" style="${float}"></span>`
        : `<span id="i${n++}" style="display:inline-block;` +
          `width:${part}px;height:10px"></span>`,
    )
    .join('');
}

test('a float met in a line goes at the top of that line', async () => {
  // CSS 2.1 9.5.1: a float goes no higher than the top of the line its
  // anchor is on, and where it fits beside what the line holds it goes at
  // that top, the line's content moving over for it. Every float in a
  // paragraph went at the paragraph's top, before its first line.
  for (const side of ['left', 'right']) {
    const { node } = await render(
      `<div id="w" style="width:300px">` +
        floatLine(`float:${side};width:50px;height:30px`, [200, 200, 'f', 40]) +
        '</div>',
    );
    const el = view(node);
    const [w, f, i1, i2] = ['w', 'f', 'i1', 'i2'].map((id) => boxOf(el, id));
    const lines = linesOf(el, 'w');
    assert.strictEqual(lines.length, 2, side);
    assert.strictEqual(f.y, lines[1].y, `${side}: at the second line's top`);
    assert.ok(f.y > w.y, side);
    const moved = side === 'left' ? 50 : 0;
    assert.strictEqual(f.x - w.x, side === 'left' ? 0 : 250, side);
    assert.strictEqual(i1.x - w.x, moved, `${side}: the line moves over`);
    assert.strictEqual(i2.x - w.x, moved + 200, `${side}: and goes on`);
    assert.strictEqual(i2.y, i1.y, side);
    cleanup();
  }
});

test('a float too wide for what is left of its line goes under it', async () => {
  // the rest of the line's content stays on the line, and the float is
  // placed as the line closes, at the top of the next
  const { node } = await render(
    `<div id="w" style="width:300px">` +
      floatLine('float:left;width:150px;height:30px', [200, 200, 'f', 40, 90]) +
      '</div>',
  );
  const el = view(node);
  const [w, f, i1, i2, i3] = ['w', 'f', 'i1', 'i2', 'i3'].map((id) =>
    boxOf(el, id),
  );
  const lines = linesOf(el, 'w');
  assert.strictEqual(f.y, lines[1].y + lines[1].height, 'under the line');
  assert.strictEqual(f.x, w.x);
  assert.deepStrictEqual([i1.x - w.x, i2.x - w.x], [0, 200], 'unmoved');
  assert.strictEqual(i2.y, i1.y, 'what follows it stays on the line');
  assert.strictEqual(i3.x - w.x, 150, 'and the next line is beside it');
});

test('a float the line cannot break at fits with what follows it', async () => {
  // float-nowrap: in text that does not wrap, what follows the float is on
  // its line whatever the room, so the float goes beside the line only
  // where that fits too, and under it where it does not — as browsers
  // place it. It went at the top where it fitted beside the text before it,
  // under the text that ran on past it.
  const para = (wrap: string) =>
    `<p id="p${wrap}" style="margin:0;width:300px;white-space:${wrap};` +
    'clear:both">' +
    'Some <span id="f' +
    wrap +
    '" style="float:right;width:150px;height:20px"></span>' +
    'text that runs on past the end of its box</p>';
  const { node } = await render(para('nowrap') + para('normal'));
  const el = view(node);
  const lines = linesOf(el, 'pnowrap');
  assert.strictEqual(lines.length, 1);
  const f = boxOf(el, 'fnowrap');
  assert.strictEqual(f.y, lines[0].y + lines[0].height, 'under the line');
  // where the line may break after "Some", the float goes at its top
  assert.strictEqual(boxOf(el, 'fnormal').y, linesOf(el, 'pnormal')[0].y);
});

test('a float goes no higher than the float before it', async () => {
  // CSS 2.1 9.5.1, rule 5: the third float fits in the room beside the
  // first, which the second went under, and still goes no higher than the
  // second's top
  const { node } = await render(
    '<div id="w" style="width:300px">' +
      '<div id="a" style="float:left;width:200px;height:50px"></div>' +
      '<div id="b" style="float:left;width:150px;height:20px"></div>' +
      '<div id="c" style="float:left;width:50px;height:20px"></div></div>',
  );
  const el = view(node);
  const [w, b, c] = ['w', 'b', 'c'].map((id) => boxOf(el, id));
  assert.strictEqual(b.y - w.y, 50, 'under the first');
  assert.strictEqual(c.y, b.y, 'no higher than the second');
  assert.strictEqual(c.x - w.x, 150, 'beside it');
});

test('a float wider than its block stands beside a float on the other side', async () => {
  // CSS 2.1 9.5.1: a left float may not reach past a right float beside it
  // (rule 3), and past its containing block only where a left float stands
  // beside it too (rule 7). Held to its block always, a float wider than
  // its block went below every float beside it.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="float:left;width:500px;height:200px">' +
      '<div style="float:right;width:50px;height:100px"></div>' +
      '<div style="margin-right:100px"><div id="a" style="float:left;' +
      'width:425px;height:10px"></div></div></div>' +
      '<div style="clear:both;width:200px">' +
      '<div style="float:left;width:50px;height:30px"></div>' +
      '<div id="b" style="float:left;width:175px;height:10px"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').y, 0, 'beside the right float');
  const b = boxOf(el, 'b');
  assert.ok(b.y >= 230, `below the left float, in its block: ${b.y}`);
});

test('a new formatting context beside a float takes no negative margin past its block', async () => {
  // where a float narrows the room, as every engine has it; with none
  // there, a negative margin still takes the box out
  const { node } = await render(
    '<style>body{margin:0 0 0 50px}</style><div style="width:125px">' +
      '<div style="float:left;width:0;height:50px"></div>' +
      '<div style="float:right;clear:left;width:25px;height:50px"></div>' +
      '<div id="a" style="overflow:hidden;margin-left:-50px;height:100px">' +
      '</div></div><div style="width:100px">' +
      '<div id="b" style="overflow:hidden;margin-left:-50px;height:10px">' +
      '</div></div>',
  );
  const el = view(node);
  const [a, b] = ['a', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([a.x, a.width, b.x, b.width], [50, 100, 0, 150]);
});

test('a new formatting context a negative margin takes up meets the float below its top', async () => {
  // its border box is what may not overlap a float, from its top down:
  // taken as tall as its margins, less the one taking it up, it missed
  // the float it overlapped
  const { node } = await render(
    '<style>body{margin:0}.w{display:flow-root;width:100px;margin-top:75px}' +
      '.f{float:left;width:50px;height:50px}' +
      '.b{overflow:hidden;height:50px;margin-top:-25px}</style>' +
      '<div class="w" id="w1"><div class="f"></div>' +
      '<div class="b" id="a" style="width:50px"></div></div>' +
      '<div class="w" id="w2"><div class="f"></div>' +
      '<div class="b" id="b" style="width:75px"></div></div>',
  );
  const el = view(node);
  const [w1, a, w2, b] = ['w1', 'a', 'w2', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([a.x - w1.x, a.y - w1.y], [50, -25], 'beside it');
  assert.deepStrictEqual([b.x - w2.x, b.y - w2.y], [0, 50], 'under it');
});

test('a box as wide as its content measures its floats side by side', async () => {
  // A float, an inline-block and a table cell are as wide as their content
  // at its widest, and floats stand side by side there, beside the line
  // they are met on. Taken for the widest of them, a floated menu's items
  // went one under another, text beside a floated image wrapped, and a
  // float holding a linked, floated logo was no width at all.
  const { node } = await render(
    '<div id="menu" style="float:left">' +
      '<div id="m1" style="float:left;width:60px;height:20px"></div>' +
      '<div id="m2" style="float:left;width:80px;height:20px"></div>' +
      '<div id="m3" style="float:right;width:40px;height:20px"></div>' +
      '</div>' +
      '<div id="card" style="clear:both;display:inline-block">' +
      '<span style="float:left;width:50px;height:20px"></span>' +
      '<span id="t" style="display:inline-block;width:90px;height:10px">' +
      '</span></div>' +
      '<div id="logo" style="float:left"><a href="#">' +
      '<span style="float:left;width:70px;height:20px"></span></a></div>' +
      '<div id="cleared" style="clear:both;float:left">' +
      '<div style="float:left;width:60px;height:20px"></div>' +
      '<div style="float:left;clear:left;width:80px;height:20px"></div></div>',
    600,
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.strictEqual(box('menu').width, 180, 'a menu holds its items');
  assert.strictEqual(box('m2').y, box('m1').y, 'side by side');
  assert.strictEqual(box('m3').y, box('m1').y, 'on both sides');
  assert.strictEqual(box('card').width, 140, 'the text beside its image');
  assert.strictEqual(box('logo').width, 70, 'a logo in a link');
  assert.strictEqual(box('cleared').width, 80, 'one under the other');
});

test('a box as narrow as its content is no narrower than a float in it', async () => {
  // and no wider than its widest float or word: the float's line breaks
  // under it where the two do not fit side by side
  const { node } = await render(
    '<table style="width:300px;border-spacing:0"><tr>' +
      '<td id="c" style="padding:0">' +
      '<span style="float:left;width:30px;height:20px"></span>' +
      '<span style="display:inline-block;width:70px;height:10px"></span>' +
      '</td><td style="width:100%;padding:0"></td></tr></table>',
  );
  assert.strictEqual(boxOf(view(node), 'c').width, 70);
});

test('a float in a line is placed once where ::first-line lays the lines out twice', async () => {
  const html = (sheet: string) =>
    `<style>${sheet}</style><div id="w" style="width:300px">` +
    floatLine('float:left;width:50px;height:30px', [200, 200, 'f', 40]) +
    '</div>';
  const place = async (sheet: string) => {
    const { node } = await render(html(sheet));
    const el = view(node);
    const out = ['f', 'i1', 'i2'].map((id) => {
      const b = boxOf(el, id);
      return [b.x, b.y];
    });
    cleanup();
    return out;
  };
  assert.deepStrictEqual(
    await place('#w::first-line { color: red }'),
    await place(''),
  );
});

test('a floated image, ::before or first letter in an inline box is laid out', async () => {
  // Found by the same walk into inline boxes, which a document with no
  // float or positioned box in one does not take — so each is alone in its
  // document here
  const image = view(
    (
      await render(
        '<p id="p">text <span>' +
          '<img id="i" style="float:left;width:40px;height:40px"></span></p>',
      )
    ).node,
  );
  const [p, i] = ['p', 'i'].map((id) => boxOf(image, id));
  assert.deepStrictEqual([i.x, i.y, i.width, i.height], [p.x, p.y, 40, 40]);
  cleanup();

  const pseudo = view(
    (
      await render(
        '<style>#g::before{content:"";float:left;width:30px;height:30px}' +
          '</style><p id="p">text <span id="g">g</span></p>',
      )
    ).node,
  );
  const [p2, g] = ['p', 'g'].map((id) => boxOf(pseudo, id));
  const before = g.children.find(
    (c) => (c as unknown as { pseudo?: string }).pseudo === 'before',
  );
  assert.ok(before, 'the ::before has a box');
  assert.deepStrictEqual(
    [before.x, before.y, before.width, before.height],
    [p2.x, p2.y, 30, 30],
  );
  cleanup();

  const letters = view(
    (
      await render(
        '<style>#q::first-letter{float:left;font-size:40px}</style>' +
          '<p id="q"><span>Letter</span></p>',
      )
    ).node,
  );
  const q = boxOf(letters, 'q');
  const letter = q.children[0].children.find(
    (c) => (c as unknown as { pseudo?: string }).pseudo === 'first-letter',
  );
  assert.ok(letter, 'the first letter has a box');
  assert.deepStrictEqual([letter.x, letter.y], [q.x, q.y]);
  assert.ok(letter.width > 0, 'and a size');
});

metric(
  'a word too long for the room beside a float goes below it whole',
  async () => {
    // CSS 2.1 9.5: a line with too little room beside the floats for its
    // first word moves down past them. A word kept whole ran past the room,
    // over the float's side of the paragraph, and stayed beside it.
    const { node } = await render(
      '<style>body{margin:0}</style><div style="width:200px">' +
        '<div style="float:left;width:150px;height:30px"></div>' +
        '<p id="p" style="margin:0">Supercalifragilistic words</p></div>',
    );
    const [line] = linesOf(view(node), 'p');
    assert.ok(line.y >= 30, `below the float: ${line.y}`);
    assert.strictEqual(line.x, 0);
  },
);

test('an empty cleared block ends its parent where its collapsed margin ends', async () => {
  // its margins collapse to one, 140px, and its top border edge is its top
  // margin's 40px inside it, where clearance puts it: below the float
  // (CSS 2.1 8.3.1, 10.6.3). The parent is the float and the other 100px:
  // the margin is not spent in the clearance
  const { node } = await render(
    '<style>body{margin:0}#p{border-top:1px solid}' +
      '#f{float:left;width:10px;height:100px}' +
      '#c{clear:left;margin:40px 0 140px}' +
      '#s{margin-bottom:140px}</style>' +
      '<div id="p"><div id="f"></div><div id="c"></div></div>' +
      '<div id="q" style="border-top:1px solid"><div id="f2" ' +
      'style="float:left;width:10px;height:100px"></div>' +
      '<div style="clear:left;margin:40px 0 80px"></div><div id="s"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'p').height, 201, 'the border and 200px');
  // and one that following empty blocks' margins collapse with
  assert.strictEqual(boxOf(el, 'q').height, 201);
});

test('a block that clears a float placed before any content is under it', async () => {
  // A float placed before anything fixed where its parent's content is
  // would go down with a margin collapsing up through the parent's top,
  // were `clear` none, so a block that clears it always has clearance:
  // its border edge goes under the float whatever its margin, and the
  // parent is the two of them (CSS 2.1 9.5.2, as the browsers read it).
  // The margin put it 400px below the float, the parent's background
  // showing between.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="p" style="width:100px"><div><div id="f" style="float:left;' +
      'width:100px;height:50px"></div></div><div id="c" style="clear:left;' +
      'margin-top:400px;height:50px"></div></div>',
  );
  const el = view(node);
  const [p, f, c] = ['p', 'f', 'c'].map((id) => boxOf(el, id));
  assert.strictEqual(c.y, f.y + 50, 'under the float');
  assert.strictEqual(p.height, 100);
});

test('a margin that takes a cleared block past the floats is any margin', async () => {
  // with no clearance, nothing parts the block's margin from its parent's,
  // and it goes on up through the parent's top: stopped at the block, it
  // left the parent where it was, and its background showed above it
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="float:left;width:100px;height:100px"></div>' +
      '<div style="padding-top:1px"><div id="r"><div id="c" style="clear:left;' +
      'margin-top:150px;height:10px"></div></div></div>',
  );
  const el = view(node);
  const [r, c] = ['r', 'c'].map((id) => boxOf(el, id));
  assert.strictEqual(c.y, 151, 'its margin below the padding');
  assert.strictEqual(r.y, c.y, 'and the parent moved with it');
});

test("a formatting context's margins are its containing block's, beside a float", async () => {
  // CSS 2.1 9.5 keeps the border box off the floats, and the margins are
  // the containing block's: one on the float's side overlaps the float
  // (the WPT suite's floats-wrap-bfc-with-margin tests)
  const placed = async (float: string, box: string) => {
    const { node } = await render(
      '<style>body{margin:0}</style><div style="width:600px">' +
        `<div style="float:${float};width:200px;height:50px"></div>` +
        `<div id="b" style="overflow:hidden;height:20px;${box}"></div></div>`,
      700,
    );
    const b = boxOf(view(node), 'b');
    const out = [b.x, b.y, b.width];
    cleanup();
    return out;
  };
  // a column beside a sidebar, its margin the sidebar's width and a gap
  assert.deepStrictEqual(
    await placed('left', 'margin-left:220px'),
    [220, 0, 380],
  );
  // and one narrower than the float starts at the float
  assert.deepStrictEqual(
    await placed('left', 'margin-left:20px'),
    [200, 0, 400],
  );
  assert.deepStrictEqual(
    await placed('right', 'margin-right:220px'),
    [0, 0, 380],
  );
  // a margin at the end runs past the room; one at the start that pushes
  // the box into the float puts it below the float
  assert.deepStrictEqual(
    await placed('left', 'width:400px;margin-right:10px'),
    [200, 0, 400],
  );
  assert.deepStrictEqual(
    await placed('right', 'margin-left:401px'),
    [401, 50, 199],
  );
});

test('a negative margin that reaches a float outside its containing block', async () => {
  // the float is beside the containing block, and the margin takes the
  // box over it: it goes below the float rather than under it
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px">' +
      '<div style="float:left;width:50px;height:50px"></div>' +
      '<div style="margin-left:50px"><div id="b" style="overflow:hidden;' +
      'width:100px;height:50px;margin-left:-50px"></div></div></div>',
  );
  const b = boxOf(view(node), 'b');
  assert.deepStrictEqual([b.x, b.y], [0, 50]);
  cleanup();
  // a float of no width has nothing to overlap, and is passed over
  const { node: zero } = await render(
    '<style>body{margin:0}</style><div style="width:100px;margin-left:50px">' +
      '<div style="float:left;width:0;height:50px"></div>' +
      '<div id="b" style="overflow:hidden;height:50px;margin-left:-50px">' +
      '</div></div>',
  );
  const z = boxOf(view(zero), 'b');
  assert.deepStrictEqual([z.x, z.y, z.width], [0, 0, 150]);
});

test('a box that clips its overflow, too wide for a column no float narrows, stays at its top beside the float', async () => {
  // Where no float narrows the room on either side, a box with a
  // formatting context of its own is where it would be were there none, and
  // one too wide for its containing block overflows it; below the floats it
  // would be the same box in the same room. Blink tests the fit only against
  // a side a float is on. Design 209's 247px heading in a 240px column,
  // beside a float that ends left of the column, went under the float
  const { node, result } = await render(
    '<style>body{margin:0}.w{width:520px;display:flow-root}' +
      '.f{float:left;width:250px;height:300px}.c{margin-left:265px;' +
      'width:240px}.h{overflow:hidden;height:37px;width:247px}</style>' +
      '<div class="w"><div class="f"></div><div class="c">' +
      '<div class="h" id="free"></div></div></div>' +
      // and one a float does narrow still goes under it
      '<div class="w"><div class="f" style="width:280px"></div>' +
      '<div class="c" id="col"><div class="h" id="narrowed"></div></div></div>',
  );
  const el = view(node);
  assert.strictEqual(
    boxOf(el, 'free').y,
    0,
    'the heading stays at the column top, overflowing it',
  );
  assert.strictEqual(
    boxOf(el, 'narrowed').y - boxOf(el, 'col').y,
    300,
    'where a float narrows the column, it waits below the float',
  );
  await result.unmount();
});
