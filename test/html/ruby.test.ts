// <Html> — ruby (CSS Ruby 1) and the emphasis marks set as ruby is
// (CSS Text Decoration 3, 3).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup } from 'react-x11/test';
import { EMPHASIS_MARKS } from '../../src/html/layout/inline.js';
import { RUBY_COLUMNS } from '../../src/html/layout/boxes.js';
import type { Box, LineBox } from '../../src/html/layout/boxes.js';
import { boxOf, findById, metric, render, view } from './harness.js';

type LaidBox = Box;

afterEach(cleanup);

/** The box an element was laid out in, as the engine has it. */
function boxIn(...args: Parameters<typeof boxOf>): Box {
  return boxOf(...args) as unknown as Box;
}

/** The ruby columns under a box, in tree order. */
function columnsIn(box: LaidBox): LaidBox[] {
  const out: LaidBox[] = [];
  const walk = (at: LaidBox): void => {
    if (RUBY_COLUMNS.has(at)) out.push(at);
    for (const child of at.children) walk(child);
  };
  walk(box);
  return out;
}

/** The text a box holds, its descendants' in tree order. */
function textIn(box: LaidBox): string {
  if (box.kind === 'text') return box.text;
  return box.children.map(textIn).join('');
}

function parts(column: LaidBox): { base: LaidBox; annotations: LaidBox[] } {
  return RUBY_COLUMNS.get(column)!;
}

metric('an annotation is over its base, and a column of its own', async () => {
  const { node } = await render(
    '<p id=p style="font: 20px/1 sans-serif">x<ruby>漢<rt>kan</rt>字<rt>ji</rt></ruby>y</p>',
  );
  const columns = columnsIn(boxIn(view(node), 'p'));
  assert.equal(columns.length, 2);
  const [first, second] = columns.map(parts);
  assert.equal(textIn(first.base), '漢');
  assert.equal(textIn(first.annotations[0]), 'kan');
  assert.equal(textIn(second.base), '字');
  assert.equal(textIn(second.annotations[0]), 'ji');
  for (const { base, annotations } of [first, second]) {
    // directly over the base, and no wider than the column
    assert.ok(annotations[0].y + annotations[0].height <= base.y + 1e-6);
    assert.equal(annotations[0].width, base.width);
  }
  // the second column is after the first on the line
  assert.ok(columns[1].x >= columns[0].x + columns[0].width - 1e-6);
});

metric(
  'a line grows only where its leading has no room for the annotation',
  async () => {
    const tight = await render(
      '<p id=a style="font: 20px/1 sans-serif">a<ruby>b<rt>c</rt></ruby></p>' +
        '<p id=b style="font: 20px/1 sans-serif">ab</p>',
    );
    const el = view(tight.node);
    const grown = boxIn(el, 'a').lines![0] as LineBox;
    const plain = boxIn(el, 'b').lines![0] as LineBox;
    assert.ok(grown.height > plain.height + 5, 'a tight line makes room');
    cleanup();
    const loose = await render(
      '<p id=a style="font: 20px/4 sans-serif">a<ruby>b<rt>c</rt></ruby></p>' +
        '<p id=b style="font: 20px/4 sans-serif">ab</p>',
    );
    const el2 = view(loose.node);
    const roomy = boxIn(el2, 'a').lines![0] as LineBox;
    const plain2 = boxIn(el2, 'b').lines![0] as LineBox;
    assert.ok(Math.abs(roomy.height - plain2.height) < 0.5, 'leading has room');
    assert.ok(Math.abs(roomy.baseline - plain2.baseline) < 0.5);
  },
);

metric('ruby-position: under puts the annotation below its base', async () => {
  const { node } = await render(
    '<p id=p style="font: 20px/1 sans-serif"><ruby style="ruby-position: under">b<rt>c</rt></ruby></p>',
  );
  const [column] = columnsIn(boxIn(view(node), 'p'));
  const { base, annotations } = parts(column);
  assert.ok(annotations[0].y >= base.y);
});

metric('rp is hidden, and bases pair with annotations one by one', async () => {
  const { node } = await render(
    '<p id=p style="font: 20px/1 sans-serif"><ruby><rb>A</rb><rb>B</rb><rp>(</rp><rt>a</rt><rt>b</rt><rp>)</rp></ruby></p>',
  );
  const columns = columnsIn(boxIn(view(node), 'p')).map(parts);
  assert.deepEqual(
    columns.map((c) => [textIn(c.base), textIn(c.annotations[0])]),
    [
      ['A', 'a'],
      ['B', 'b'],
    ],
  );
  assert.ok(!textIn(boxIn(view(node), 'p')).includes('('));
});

metric('one annotation over several bases spans them', async () => {
  const { node } = await render(
    '<p id=p style="font: 20px/1 sans-serif"><ruby><rb>A</rb><rb>B</rb><rt>ab</rt></ruby></p>',
  );
  const columns = columnsIn(boxIn(view(node), 'p')).map(parts);
  assert.equal(columns.length, 1);
  assert.equal(textIn(columns[0].base), 'AB');
});

metric('an annotation outside a ruby is in a ruby of its own', async () => {
  const { node } = await render(
    '<p id=p style="font: 20px/1 sans-serif">a<rt>b</rt></p>',
  );
  const columns = columnsIn(boxIn(view(node), 'p')).map(parts);
  assert.equal(columns.length, 1);
  assert.equal(textIn(columns[0].base), '');
  assert.equal(textIn(columns[0].annotations[0]), 'b');
});

metric('display reads back what was set', async () => {
  const { node } = await render(
    '<ruby id=r>a<rt id=t>b</rt></ruby><span id=s style="display: block ruby">c</span>',
  );
  const el = view(node);
  const read = (id: string): string =>
    el.computedStyle(findById(el.document, id)!)!.display;
  assert.equal(read('r'), 'ruby');
  assert.equal(read('t'), 'ruby-text');
  assert.equal(read('s'), 'block ruby');
});

/** The marks on a paragraph's lines, from their text's draw origin. */
function marksOf(box: LaidBox) {
  return (box.lines ?? []).flatMap((line) =>
    line.texts.flatMap((text) =>
      (EMPHASIS_MARKS.get(text) ?? []).map((mark) => ({
        x: text.drawX + mark.x,
        y: text.drawY + mark.y,
        baseline:
          text.drawY +
          mark.y +
          mark.layout.lines[0].y +
          mark.layout.lines[0].baseline,
      })),
    ),
  );
}

metric('a mark is over each character but spaces and punctuation', async () => {
  const { node } = await render(
    '<p id=p style="font: 20px/1 sans-serif; text-emphasis: dot">ab, c</p>',
  );
  assert.equal(marksOf(boxIn(view(node), 'p')).length, 3);
});

metric('a mark is where a ruby annotation of it would be', async () => {
  const { node } = await render(
    '<div id=a style="font: 20px/5 sans-serif"><ruby>試<rt>&#x25CF;</rt>験<rt>&#x25CF;</rt></ruby></div>' +
      '<div id=b style="font: 20px/5 sans-serif; text-emphasis: circle">試験</div>',
  );
  const el = view(node);
  const a = boxIn(el, 'a');
  const b = boxIn(el, 'b');
  // the annotation's baseline, from the line's top
  const annotation = columnsIn(a).map((c) => {
    const line = parts(c).annotations[0].lines![0] as LineBox;
    const text = line.texts[0];
    const laid = text.layout.lines[text.layoutLine];
    return text.drawY + laid.y + laid.baseline - (a.lines![0] as LineBox).y;
  });
  const marks = marksOf(b).map((m) => m.baseline - (b.lines![0] as LineBox).y);
  assert.equal(marks.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.ok(
      Math.abs(marks[i] - annotation[i]) < 0.01,
      `${marks[i]} ${annotation[i]}`,
    );
  }
});

metric(
  'marks under the text, and a tight line made taller for them',
  async () => {
    const { node } = await render(
      '<p id=a style="font: 20px/1 sans-serif; text-emphasis: dot; text-emphasis-position: under">ab</p>' +
        '<p id=b style="font: 20px/1 sans-serif">ab</p>',
    );
    const el = view(node);
    const marked = boxIn(el, 'a').lines![0] as LineBox;
    const plain = boxIn(el, 'b').lines![0] as LineBox;
    assert.ok(marked.height > plain.height + 5);
    // the baseline stays where it was: the room is below it
    assert.ok(Math.abs(marked.baseline - plain.baseline) < 0.5);
    const [mark] = marksOf(boxIn(el, 'a'));
    assert.ok(mark.y > marked.y + marked.baseline);
  },
);

metric('auto marks Chinese under its text, and Japanese over it', async () => {
  const { node } = await render(
    '<p id=zh lang=zh style="font: 20px/5 sans-serif; text-emphasis: dot; text-emphasis-position: auto">你好</p>' +
      '<p id=ja lang=ja style="font: 20px/5 sans-serif; text-emphasis: dot; text-emphasis-position: auto">今日</p>',
  );
  const el = view(node);
  const below = (id: string): boolean => {
    const line = boxIn(el, id).lines![0] as LineBox;
    return marksOf(boxIn(el, id))[0].y > line.y + line.baseline;
  };
  assert.equal(below('zh'), true);
  assert.equal(below('ja'), false);
});

test('text-emphasis sets its style and its colour, in either order', async () => {
  const { node } = await render(
    '<p id=a style="text-emphasis: red open triangle">x</p><p id=b style="text-emphasis: none">y</p>',
  );
  const el = view(node);
  const read = (id: string, prop: string): string =>
    el.computedStyle(findById(el.document, id)!)![prop];
  assert.equal(read('a', 'text-emphasis-style'), 'open triangle');
  assert.equal(read('b', 'text-emphasis-style'), 'none');
});

metric(
  'ruby-overhang: spaces hangs a wide annotation over the spaces beside its ruby',
  async () => {
    const { node } = await render(
      '<style>body{margin:0;font:20px serif}rt{font-size:10px}' +
        '.s{ruby-overhang:spaces;ruby-align:center}</style>' +
        // the annotation is wider than the base, so its column overlaps a
        // space at either side by as much as the annotation passes the base
        // there, no more than the space is wide (CSS Ruby 1, 4.2)
        '<div id="a">x <ruby class="s">x<rt>xxxxxxxxxx</ruby> x</div>' +
        '<div id="b">x <ruby>x<rt>xxxxxxxxxx</ruby> x</div>' +
        // nor beside anything but a space
        '<div id="c">xx<ruby class="s">x<rt>xxxxxxxxxx</ruby>xx</div>',
      300,
    );
    const el = view(node);
    const [a] = columnsIn(boxIn(el, 'a'));
    const [b] = columnsIn(boxIn(el, 'b'));
    const [c] = columnsIn(boxIn(el, 'c'));
    assert.ok(a.marginLeft < 0 && a.marginRight < 0, 'hangs over both');
    assert.strictEqual(a.marginLeft, a.marginRight, 'centred');
    assert.deepStrictEqual([b.marginLeft, b.marginRight], [0, 0], 'auto: none');
    assert.deepStrictEqual([c.marginLeft, c.marginRight], [0, 0], 'no space');
    // as wide as a space at most, where the annotation passes the base by
    // more: a space at 20px is a few pixels
    assert.ok(-a.marginLeft < 10, `${-a.marginLeft} is a space's width`);
  },
);

metric(
  'a mark is centred on its character, not on its letter spacing',
  async () => {
    // the room `letter-spacing` adds after a character is no part of it
    // (WPT's letter-spacing-211): marks over spaced text stand where they
    // stand over the same text set apart with spaces
    const { node } = await render(
      '<p id=a style="font: 20px/1 monospace; text-emphasis: dot;' +
        ' letter-spacing: 20px; margin: 0">abc</p>' +
        '<p id=b style="font: 20px/1 monospace; text-emphasis: dot;' +
        ' white-space: pre; margin: 0; letter-spacing: 0">a\u2003b\u2003c</p>',
    );
    const el = view(node);
    const spaced = marksOf(boxIn(el, 'a')).map((m) => m.x);
    const plain = marksOf(boxIn(el, 'b')).map((m) => m.x);
    // the first marks at the same place: the first character starts both
    assert.equal(spaced.length, 3);
    assert.ok(Math.abs(spaced[0] - plain[0]) < 0.5, `${spaced} ${plain}`);
  },
);
