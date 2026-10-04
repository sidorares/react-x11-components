// <Html> — inline layout: lines, inline boxes and their edges, line height.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, pixelAt } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { HtmlViewNode } from '../../src/html/index.js';
import { faceLineHeight, hungSpaces } from '../../src/html/layout/inline.js';
import type { FontsLike } from '../../src/html/layout/inline.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import {
  MOVED,
  baselinesOf,
  boxOf,
  extentOf,
  fillsOf,
  findById,
  fragmentsOf,
  lineTextsOf,
  linesOf,
  metric,
  render,
  renderWithBytes,
  textRunsOf,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

metric(
  'text wraps to the width it is given, and rewraps when that changes',
  async () => {
    const source = '<p>' + 'word '.repeat(60) + '</p>';
    const narrow = await render(source, 200);
    const narrowLines = lineCount(narrow.node);
    await cleanup();
    const wide = await render(source, 600);
    const wideLines = lineCount(wide.node);
    assert.ok(
      narrowLines > wideLines,
      `${narrowLines} lines at 200px, ${wideLines} at 600px`,
    );
  },
);

function lineCount(node: DrawnNode): number {
  const tree = (
    view(node) as unknown as {
      _tree: { root: { children: { lines: unknown[] | null }[] } };
    }
  )._tree;
  let total = 0;
  const walk = (
    boxes: { lines: unknown[] | null; children?: unknown }[],
  ): void => {
    for (const box of boxes) {
      if (box.lines) total += box.lines.length;
      const kids = (box as { children?: typeof boxes }).children;
      if (kids) walk(kids);
    }
  };
  walk(tree.root.children);
  return total;
}

metric(
  'an inline box laid out again reaches no further than its text',
  async () => {
    // A flex item's subtree is laid out and then moved into place, and the
    // move shifted the inline boxes in it too, whose position is never laid
    // out, so each pass added to it. A page whose first layout was at a
    // width of 1 — a window before its size is known — measured a card grid
    // with a <span> in each card three times its height.
    const { node } = await render(
      '<style>body{margin:0}.grid{display:flex;flex-wrap:wrap}' +
        '.grid a{display:block;width:120px;height:40px}' +
        '.grid b{display:block}</style>' +
        '<div class="grid">' +
        '<a><b>One</b><span>a note</span></a><a><b>Two</b><span>a note</span></a>' +
        '<a><b>Three</b><span>a note</span></a><a><b>Four</b><span>a note</span></a>' +
        '</div>',
      300,
    );
    const el = view(node) as unknown as {
      measureContent(constraints: { width: number }): { height: number };
    };
    const settled = el.measureContent({ width: 300 }).height;
    // two cards a row at 300px, and room for them at every width below
    for (const width of [1, 290, 2, 280, 3, 270]) el.measureContent({ width });
    assert.strictEqual(el.measureContent({ width: 260 }).height, settled);
  },
);

metric('line-height: 0 lays lines on top of each other', async () => {
  // Legal CSS, and what the suite's line-height tests are built on: each
  // line box is 0 high, so two lines share a baseline. A 0.1 floor on the
  // multiplier set them a tenth of a line apart.
  const { node } = await render(
    '<div style="font-size:20px;line-height:0;width:1em">X X</div>',
    300,
  );
  type B = { lines: { y: number; baseline: number }[] | null; children: B[] };
  const tree = (view(node) as unknown as { _tree: { root: B } })._tree;
  const div = tree.root.children[0];
  const lines = div.lines ?? [];
  assert.strictEqual(lines.length, 2, 'the text wraps to two lines');
  assert.ok(
    Math.abs(lines[1].y - lines[0].y) < 0.01,
    `both lines at one height: ${lines[0].y} and ${lines[1].y}`,
  );
});

test('white space collapses across elements, and not at a line start', async () => {
  const text = async (source: string) =>
    (
      view((await render(source, 300)).node) as unknown as {
        _tree: { text: string };
      }
    )._tree.text;
  // CSS 2.1 16.6.1: a space at the start or the end of a line goes, and a
  // space after another collapses into it, whichever element either is in
  assert.strictEqual(await text('<p>\n   Hello world\n</p>'), 'Hello world');
  assert.strictEqual(await text('<p>Hi<b> </b>there</p>'), 'Hi there');
  assert.strictEqual(await text('<p>Hi <b> there</b></p>'), 'Hi there');
  assert.strictEqual(await text('<p>one <br>\n two</p>'), 'one\ntwo');
  // a space beside an image or an inline-block is a space; a float is no
  // part of the line, so the space after it collapses into the one before
  assert.strictEqual(await text('<p>a <img alt="i"> b</p>'), 'a i b');
  assert.strictEqual(
    await text('<p>a <span style="float:left">f</span> b</p>'),
    'a fb',
  );
  // preserved spaces stay, and do not swallow the next one
  assert.strictEqual(
    await text('<p><span style="white-space:pre">a  </span> b</p>'),
    'a   b',
  );
});

test('a first line keeps its first box after the indent, however wide', async () => {
  // there is no break before a line's first content, and a first line's
  // `text-indent` is room, not content: an inline-block that did not fit
  // after it went to a second line, and a float laid out at its least
  // width was as wide as the block without the indent
  const { node } = await render(
    '<div id="f" style="float:left;text-indent:30px">' +
      '<span style="display:inline-block;width:10px;height:10px"></span>' +
      '</div>',
    1,
  );
  const f = boxOf(view(node), 'f') as LaidBox & { lines: unknown[] };
  assert.strictEqual(f.width, 40);
  assert.strictEqual(f.lines.length, 1);
});

metric('font-size: 0 leaves no room between inline-blocks', async () => {
  // the common way to lose the spaces between columns set inline: at no
  // size the space between them takes no room, where it used to be 1px. The
  // row is wider than the body it sits in, which must not narrow its lines.
  const { node } = await render(
    '<div style="font-size:0;width:300px">' +
      '<div id="a" style="display:inline-block;width:100px;height:10px"></div> ' +
      '<div id="b" style="display:inline-block;width:100px;height:10px"></div> ' +
      '<div id="c" style="display:inline-block;width:100px;height:10px"></div></div>',
    300,
  );
  const el = view(node);
  const xs = ['a', 'b', 'c'].map((id) => boxOf(el, id).x);
  assert.deepStrictEqual(
    xs.map((x) => x - xs[0]),
    [0, 100, 200],
  );
  assert.strictEqual(boxOf(el, 'c').y, boxOf(el, 'a').y, 'one line');
});

metric('<br> breaks the line on the one-layout fast path too', async () => {
  const { node } = await render('<style>p{margin:0}</style><p>a<br><br>b</p>');
  const tree = (
    view(node) as unknown as {
      _tree: { root: { children: { lines: unknown[] | null }[] } };
    }
  )._tree;
  // a / blank / b — the blank line is real and takes the font's height.
  assert.strictEqual(tree.root.children[0].lines?.length, 3);
});

metric('an authored space before an inline atomic survives', async () => {
  // ntk strips a line's trailing whitespace; a fragment that ends before an
  // atomic is not a line end, so the stripped advance is measured back. The
  // probe is an <img> because images carry no UA margin — the gap this
  // asserts is the space itself.
  const { node } = await render(
    '<style>p{margin:0}img{margin:0}</style>' +
      '<p>Name <img src="x.png" width="20" height="10"> tail</p>',
  );
  const tree = (
    view(node) as unknown as {
      _tree: {
        root: {
          children: {
            lines:
              | {
                  texts: {
                    drawX: number;
                    layout: { lines: { width: number }[] };
                    layoutLine: number;
                  }[];
                  atomics: { box: { x: number } }[];
                }[]
              | null;
          }[];
        };
      };
    }
  )._tree;
  const line = tree.root.children[0].lines?.[0];
  assert.ok(line && line.atomics.length === 1);
  const label = line.texts[0];
  const inkEnd = label.drawX + label.layout.lines[label.layoutLine].width;
  const gap = line.atomics[0].box.x - inkEnd;
  assert.ok(
    gap > 2,
    `the image sits a space past the label (gap ${gap.toFixed(1)}px)`,
  );
});

// An inline element's padding, border and margin take room on its line — its
// start side before its first fragment, its end side after its last — and its
// background and border are painted a fragment a line, over its face's height
// and its padding, rounded and bordered only where the element starts and
// ends (CSS 2.1 8.6, 10.6.1). A line with anything but text on it is placed
// piece by piece, which is also where it is aligned and, where it reads right
// to left, put in visual order.
metric(
  "an inline element's padding, border and margin take room on its line",
  async () => {
    const { node } = await render(
      '<p id="p" style="margin:0">ab<span style="padding:0 10px;' +
        'border-left:3px solid;margin-right:5px">cd</span>ef</p>',
    );
    const [line] = linesOf(view(node), 'p');
    const runs = textRunsOf(line);
    assert.strictEqual(runs.length, 3, 'before, inside and after it');
    const [ab, cd, ef] = runs;
    assert.ok(
      Math.abs(cd[0] - ab[1] - 13) < 0.5,
      `its left border and padding: ${cd[0] - ab[1]}`,
    );
    assert.ok(
      Math.abs(ef[0] - cd[1] - 15) < 0.5,
      `its right padding and margin: ${ef[0] - cd[1]}`,
    );
  },
);

metric(
  'vertical padding on an inline element leaves its line as tall',
  async () => {
    const plain = await render(
      '<p id="p" style="margin:0">ab <span>cd</span> ef</p>',
    );
    const [before] = linesOf(view(plain.node), 'p');
    await plain.result.unmount();
    const padded = await render(
      '<p id="p" style="margin:0">ab <span style="padding:12px 4px;' +
        'border:2px solid">cd</span> ef</p>',
    );
    const [after] = linesOf(view(padded.node), 'p');
    assert.strictEqual(after.height, before.height);
  },
);

metric(
  "an inline element's opening edge goes to the next line with its first word",
  async () => {
    // wide enough for both words, and not for the padding as well
    const probe = await render('<p id="p" style="margin:0">aaaa bbbb</p>', 600);
    const width = Math.ceil(linesOf(view(probe.node), 'p')[0].width) + 2;
    await probe.result.unmount();
    const { node } = await render(
      `<p id="p" style="margin:0;width:${width}px">aaaa ` +
        '<span style="padding-left:30px">bbbb</span></p>',
      600,
    );
    const lines = linesOf(view(node), 'p');
    assert.strictEqual(lines.length, 2, 'the padding does not fit');
    assert.ok(!lines[0].edges?.length, 'nothing is left at the first line end');
    const [edge] = lines[1].edges ?? [];
    assert.ok(edge?.side === 'start', 'the edge opens the second line');
    const [word] = textRunsOf(lines[1]);
    assert.ok(Math.abs(word[0] - edge.x - 30) < 0.5, 'and the word follows it');
  },
);

metric(
  "an inline element's opening edge is no place to break a word",
  async () => {
    // UAX #14 and CSS Text 3, 5.1: no break between two letters because an
    // element's edge is between them, so a line too narrow for the word
    // runs past its end — and breaks at the edge where the letters would
    // break without it: after a hyphen, after a space
    const pad = `padding:0 4px;${MOVED}`;
    const { node } = await render(
      '<div style="width:0">' +
        `<p id="word" style="margin:0">ab<span style="${pad}">cd</span></p>` +
        `<p id="hyphen" style="margin:0">ab-<span style="${pad}">cd</span></p>` +
        `<p id="space" style="margin:0">ab <span style="${pad}">cd</span></p>` +
        `<p id="inside" style="margin:0">ab<span style="${pad}">cd ef</span>gh</p>` +
        '</div>',
    );
    const el = view(node);
    assert.deepStrictEqual(lineTextsOf(el, 'word'), ['abcd'], 'one word');
    assert.deepStrictEqual(lineTextsOf(el, 'hyphen'), ['ab-', 'cd']);
    assert.deepStrictEqual(lineTextsOf(el, 'space'), ['ab ', 'cd']);
    assert.deepStrictEqual(
      lineTextsOf(el, 'inside'),
      ['abcd ', 'efgh'],
      'a word each side of the space in the element',
    );
  },
);

metric(
  'a word goes to the next line with the inline element edges it holds on to',
  async () => {
    // Laid out a pixel narrower than the line it makes where it has room:
    // the line breaks at the space, the last place it may, and the word
    // goes on whole with the element's edges. Across an opening edge, `xx
    // ab` was left on the first line and the element went to the next; a
    // closing edge ran past the line's end, as a space hangs there, where
    // a browser keeps it on the line with the word it closes.
    const lines = async (inner: string): Promise<string[]> => {
      const source = (width: string) =>
        `<p id="p" style="margin:0;width:${width}">${inner}</p>`;
      const probe = await render(source('auto'), 600);
      const [whole] = linesOf(view(probe.node), 'p');
      await probe.result.unmount();
      const { node, result } = await render(
        source(`${Math.floor(whole.width) - 1}px`),
        600,
      );
      const texts = lineTextsOf(view(node), 'p');
      await result.unmount();
      return texts;
    };
    assert.deepStrictEqual(
      await lines(`xx ab<span style="padding-left:4px;${MOVED}">cd</span>`),
      ['xx ', 'abcd'],
      'the word runs on into an element',
    );
    assert.deepStrictEqual(
      await lines(`xx <span style="padding-right:20px;${MOVED}">abcd</span>`),
      ['xx ', 'abcd'],
      'an element closes after the word',
    );
  },
);

metric(
  'an inline background covers its face and padding, not the line',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0}</style>' +
        '<p id="p" style="margin:0;font-size:16px;line-height:48px">' +
        '<span style="background:#ff0000;color:#ff0000;padding:2px 6px">XX</span></p>',
    );
    const [line] = linesOf(view(node), 'p');
    const [text] = line.texts;
    const [[left, right]] = textRunsOf(line);
    const baseline = text.drawY + text.layout.lines[text.layoutLine].baseline;
    const red = async (x: number, y: number): Promise<boolean> => {
      const [r, g, b] = await pixelAt(result.ctx, Math.round(x), Math.round(y));
      return r > 200 && g < 60 && b < 60;
    };
    assert.ok(await red(left - 3, baseline - 4), 'the left padding');
    assert.ok(await red(right + 3, baseline - 4), 'the right padding');
    assert.ok(!(await red(right + 9, baseline - 4)), 'and nothing past it');
    assert.ok(
      !(await red(left + 2, line.y + 3)),
      "the leading above the face is the line's, not the element's",
    );
  },
);

metric(
  'a highlight is one background under a nested element, and first',
  async () => {
    const { node } = await render(
      '<p id="p" style="margin:0"><mark style="background:#ffff00">one ' +
        '<b style="background:#ff8800">two</b> three</mark></p>',
    );
    const fills = await fillsOf(view(node));
    const outer = fills.filter((f) => f.style === '#ffff00');
    const inner = fills.filter((f) => f.style === '#ff8800');
    assert.strictEqual(outer.length, 1, 'one fragment on the one line');
    assert.strictEqual(inner.length, 1);
    assert.ok(fills.indexOf(outer[0]) < fills.indexOf(inner[0]), 'under it');
    assert.ok(
      outer[0].x < inner[0].x &&
        outer[0].x + outer[0].w > inner[0].x + inner[0].w,
      'and around it',
    );
  },
);

metric(
  'a rounded inline background is rounded only where it starts and ends',
  async () => {
    const { node } = await render(
      '<p id="p" style="margin:0;width:90px"><span style="background:#0000ff;' +
        'border-radius:6px">several words that wrap across lines</span></p>',
    );
    const fills = (await fillsOf(view(node))).filter(
      (f) => f.style === '#0000ff',
    );
    assert.ok(fills.length >= 3, `a fragment a line: ${fills.length}`);
    assert.deepStrictEqual(fills[0].radii, [6, 0, 0, 6], 'the first: its left');
    assert.deepStrictEqual(
      fills.at(-1)!.radii,
      [0, 6, 6, 0],
      'the last: its right',
    );
    for (const middle of fills.slice(1, -1)) {
      assert.strictEqual(middle.radii, null, 'the ones between are square');
    }
  },
);

metric(
  'a centred line with an inline-block on it is centred whole',
  async () => {
    // Each piece of a line with an atomic on it used to be centred alone, and
    // the pieces after the first were placed as though it had not been.
    const { node } = await render(
      '<style>body{margin:0}</style><p id="p" style="margin:0;width:300px;' +
        'text-align:center">left <span style="display:inline-block;width:30px;' +
        'height:10px"></span> right</p>',
    );
    const [line] = linesOf(view(node), 'p');
    const [a, b] = line.texts.map(extentOf);
    const box = line.atomics[0];
    assert.ok(
      a[1] <= box.x && box.x + box.box.width <= b[0],
      `in order: ${a}, ${box.x}, ${b}`,
    );
    assert.ok(Math.abs(a[0] - (300 - b[1])) < 2, `centred: ${a[0]}, ${b[1]}`);
  },
);

metric(
  "a block's background is not painted again behind its text",
  async () => {
    // The run took the text's style, which was the block's, and filled its
    // background behind every run: a block of no height showed it anyway.
    const { node } = await render(
      '<div style="background:#ff0000;height:0">Filler text</div>',
    );
    const fills = await fillsOf(view(node));
    assert.ok(
      !fills.some((f) => f.style === '#ff0000' && f.w > 0 && f.h > 0),
      'nothing red: the block is 0px tall',
    );
  },
);

metric('a line that ends at a <br> ends, whatever follows it', async () => {
  const { node } = await render(
    '<p id="p" style="margin:0">one<br><span style="display:inline-block;' +
      'width:10px;height:10px"></span> two</p>',
  );
  const lines = linesOf(view(node), 'p');
  assert.strictEqual(lines.length, 2, 'the inline-block starts the second');
  assert.strictEqual(lines[0].atomics.length, 0);
  assert.strictEqual(lines[1].atomics.length, 1);
});

metric(
  "a percentage line height is of the element's own font size, whichever rule sets it",
  async () => {
    // CSS 2.1 10.8.1: the percentage times the element's computed font
    // size. It was read from the size as its declaration came up in the
    // cascade, which a `font` earlier in the same rule had just set to its
    // own: the Zen Garden's 099 sets `p { font: 12px …; line-height: 100% }`
    // and its first paragraph at 16px, and Chrome's 16px lines were 12px.
    // The `font` shorthand's own line height is the same
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;font:12px sans-serif;' +
        'line-height:100%}p.big{font-size:16px}p.s{font:12px/150% sans-serif}' +
        'p.s.big{font-size:16px}</style>' +
        '<p id="a" class="big">one</p><p id="b">one</p>' +
        '<p id="c" class="s big">one</p><p id="d" class="s">one</p>',
    );
    const el = view(node);
    await act();
    const height = (id: string) => boxOf(el, id).height;
    assert.deepStrictEqual(
      [height('a'), height('b'), height('c'), height('d')],
      [16, 12, 24, 18],
      "Chrome's line heights for each: 100% of 16 and of 12, 150% of 16 and of 12",
    );
  },
);

metric(
  'an anonymous block after a block in an inline takes no text-indent',
  async () => {
    // its first line is no element's first formatted line (CSS 2.1 16.1):
    // the text after the <div> started indented as the text before it did
    const { node } = await render(
      '<style>body{margin:0}</style><section id="s" style="text-indent:50px">' +
        '<span>one <div>two</div> three</span></section>',
    );
    const el = view(node);
    const s = boxOf(el, 's');
    assert.deepStrictEqual(
      linesOf(el, 's').map((l) => Math.round(extentOf(l.texts[0])[0] - s.x)),
      [50, 50, 0],
    );
  },
);

test('a no-break space before an image is added back only where the engine strips it', () => {
  // ntk to 8.12.9 and CoreText through appkit 0.15.0 strip a trailing
  // U+00A0, which CSS measures; the line adds back what the engine took, so
  // after an engine that keeps it, it would count twice.
  const engine = (stripsNoBreak: boolean): FontsLike =>
    ({
      layout: (runs: { text: string }[]) => {
        const text = runs.map((r) => r.text).join('');
        const kept = text.replace(
          stripsNoBreak ? /[ \t\u00A0]+$/ : /[ \t]+$/,
          '',
        );
        return { lines: [{ width: kept.length * 10 }] };
      },
    }) as unknown as FontsLike;
  const run = { text: 'a\u00A0', family: 'sans-serif', size: 16 };
  assert.ok(
    hungSpaces(engine(true), run).test('a\u00A0'),
    'stripped: added back',
  );
  assert.ok(
    !hungSpaces(engine(false), run).test('a\u00A0'),
    'kept: left alone',
  );
  assert.ok(hungSpaces(engine(false), run).test('a '), 'a space always is');
});

metric(
  'an anonymous block takes only what inherits from its parent',
  async () => {
    // `text` beside a block is wrapped in an anonymous block, which took the
    // div's own style: its height, padding and border a second time, so the
    // paragraph after it sat the height of the div further down.
    const { node } = await render(
      '<div id="d" style="margin:0;height:100px;padding:10px;border:2px solid;' +
        'background:#ff0000">text<p id="p" style="margin:0">para</p></div>',
    );
    const el = view(node);
    const d = boxOf(el, 'd') as LaidBox & { padTop: number };
    const [anonymous, p] = d.children as (LaidBox & { padTop: number })[];
    assert.strictEqual(anonymous.el, null, 'the text is in an anonymous block');
    assert.strictEqual(anonymous.padTop, 0, 'with no padding of its own');
    assert.strictEqual(
      anonymous.y,
      d.y + 12,
      "inside the div's border and padding",
    );
    assert.strictEqual(
      p.y,
      anonymous.y + anonymous.height,
      'and the paragraph after it',
    );
    const fills = await fillsOf(el);
    assert.strictEqual(
      fills.filter((f) => f.style === '#ff0000').length,
      1,
      'the background is painted once',
    );
  },
);

metric(
  "a line starts with its block's strut: an image alone is a line-height tall",
  async () => {
    // CSS 2.1 10.8.1; and a list item with no line holds its marker's, and
    // an inline table of empty rows stands on its first
    const { node } = await render(
      '<div id="a" style="line-height:96px"><img width="15" height="15" ' +
        'style="vertical-align:bottom" src="x.png"></div>' +
        '<ul style="margin:0"><li id="b"></li></ul>' +
        '<div id="c"><table style="display:inline-table;border-spacing:0">' +
        '<tr><td style="height:20px;padding:0"></td></tr>' +
        '<tr><td style="height:20px;padding:0"></td></tr></table></div>' +
        '<div id="z" style="font-size:0"><img width="15" height="15" src="x.png"></div>',
    );
    const el = view(node);
    const [a, b, c, z] = ['a', 'b', 'c', 'z'].map((id) => boxOf(el, id));
    assert.strictEqual(a.height, 96, 'the image on a line of the height');
    assert.ok(b.height > 10, `an empty item a line tall: ${b.height}`);
    assert.ok(
      c.height - 40 < 1,
      `the table on its first row, its second hanging below: ${c.height}`,
    );
    assert.strictEqual(z.height, 15, 'no strut at no size');
  },
);

metric(
  'a shrink-to-fit box that does not wrap is as wide as its line',
  async () => {
    // min(max(min-content, room), max-content) (CSS 2.1 10.3.5), and a line
    // that does not wrap is its own min-content: a `nowrap` tooltip in a
    // link narrower than it was cut to the link's width, its words taken
    // for places it could break
    const { node } = await render(
      '<div style="width:40px"><div id="f" style="float:left;' +
        'white-space:nowrap">one two three</div></div>',
    );
    const el = view(node);
    const [line] = linesOf(el, 'f');
    const f = boxOf(el, 'f');
    assert.ok(f.width > 40, `past its room: ${f.width}`);
    assert.ok(Math.abs(f.width - line.width) < 1, 'as wide as its line');
  },
);

metric("an inline-block's text sits on the line's baseline", async () => {
  // CSS 2.1 10.8.1: an inline-block's baseline is its last line box's. Set
  // bottom-on-baseline, a button's label sat its descent above the text
  // beside it.
  const { node } = await render(
    '<p id="p" style="margin:0">x <span id="ib" style="display:inline-block;' +
      'padding:4px;border:1px solid">Label</span> y</p>',
  );
  const el = view(node);
  const [line] = linesOf(el, 'p');
  const [outside] = line.texts;
  const outsideBaseline =
    outside.drawY + outside.layout.lines[outside.layoutLine].baseline;
  const [inner] = linesOf(el, 'ib');
  const [label] = inner.texts;
  const labelBaseline =
    label.drawY + label.layout.lines[label.layoutLine].baseline;
  assert.ok(
    Math.abs(labelBaseline - outsideBaseline) < 0.5,
    `on one baseline: ${labelBaseline} and ${outsideBaseline}`,
  );
});

metric(
  'a flex box in an inline-block gives it its first baseline, and a table none',
  async () => {
    // An inline-block sits on its last line box's baseline, or its last
    // block's with one (CSS 2.1 10.8.1) — and where that block is a flex
    // box or a grid, on the baseline the box has on a line of its own, its
    // first: Blink asks only a block container for its last, and Gecko a
    // child for its default one. A table in one gives none, in both. Asked
    // for its last, a wrapping row of chips in a card sat the card on its
    // last row.
    const { node } = await render(
      '<style>body{margin:0;font:16px/20px sans-serif}' +
        '.b{display:inline-block;width:120px}</style>' +
        // two lines of items: the first line's
        '<div id="a">x<span id="ab" class="b"><div style="display:flex;' +
        'flex-wrap:wrap"><div id="a1" style="width:100px">a</div>' +
        '<div style="width:100px">b</div></div></span></div>' +
        // a column's first item
        '<div id="c">x<span class="b"><div style="display:flex;' +
        'flex-direction:column"><div id="c1">a</div><div>b</div></div>' +
        '</span></div>' +
        // the last block is the flex box: its first line, under the text
        '<div id="d">x<span class="b"><div>top</div><div style="display:' +
        'flex"><div id="d1">a<br>b</div></div></span></div>' +
        // text after it is the last line box, and wins
        '<div id="e">x<span class="b"><div style="display:flex">' +
        '<div>a<br>b</div></div><div id="e1">bottom</div></span></div>' +
        // and a table gives none: the bottom margin edge
        '<div id="f">x<span id="fb" class="b"><table><tr><td>a</td></tr>' +
        '<tr><td>b</td></tr></table></span></div>',
      300,
    );
    const el = view(node);
    const baselineOf = (id: string, last = false) => {
      const lines = linesOf(el, id);
      const line = lines[last ? lines.length - 1 : 0];
      return line.y + line.baseline;
    };
    const near = (a: number, b: number, what: string) =>
      assert.ok(Math.abs(a - b) < 0.01, `${what}: ${a} and ${b}`);
    near(baselineOf('a'), baselineOf('a1'), 'the first line of items');
    near(baselineOf('c'), baselineOf('c1'), "a column's first item");
    near(baselineOf('d'), baselineOf('d1'), "the flex box's first line");
    near(baselineOf('e'), baselineOf('e1'), 'a line box after it');
    const table = boxOf(el, 'fb');
    near(baselineOf('f'), table.y + table.height, 'a table, none');
  },
);

metric(
  'a button with no line in it sits on the bottom of its content box',
  async () => {
    // An inline-block with no line box in it sits on the bottom of its
    // margin box (CSS 2.1 10.8.1), and a `<button>` on the bottom of its
    // content box, where its label would be: every browser's rule, which
    // Blink writes as the edge a button's baseline is synthesized from. Nor
    // does a button that clips leave its label's baseline for its bottom
    // edge. A menu toggle of three bars stood its padding under the
    // baseline, and its line was that much taller.
    const bars = '<span class="bar"></span>'.repeat(3);
    const { node } = await render(
      '<style>body{margin:0;font:16px/24px sans-serif}' +
        'button{margin:0;border:0;padding:4px;font:inherit}' +
        '.bar{display:block;width:22px;height:2px;margin:4px auto}</style>' +
        `<div id="a">x<button id="b">${bars}</button></div>` +
        // above its padding and its border, whatever its margin
        '<div id="c">x<button id="d" style="width:40px;height:40px;' +
        'padding:4px 4px 10px;border:3px solid;margin-bottom:7px"></button>' +
        '</div>' +
        '<div id="e">x<button id="f" style="overflow:hidden">Label</button>' +
        '</div>' +
        // and a box that is no button keeps its margin box's
        '<div id="g">x<span id="h" style="display:inline-block;width:22px;' +
        'height:22px;padding:4px;margin-bottom:7px"></span></div>',
    );
    const el = view(node);
    const baselineOf = (id: string) => {
      const [line] = linesOf(el, id);
      return line.y + line.baseline;
    };
    const bottom = (id: string) => boxOf(el, id).y + boxOf(el, id).height;
    const near = (a: number, b: number, what: string) =>
      assert.ok(Math.abs(a - b) < 0.01, `${what}: ${a} and ${b}`);
    near(bottom('b') - 4, baselineOf('a'), 'the bars, over the padding');
    assert.strictEqual(boxOf(el, 'b').height, 30);
    near(bottom('d') - 13, baselineOf('c'), 'over its padding and border');
    const [label] = linesOf(el, 'f');
    near(label.y + label.baseline, baselineOf('e'), 'a label that clips');
    near(bottom('h') + 7, baselineOf('g'), 'an inline-block, its margin box');
  },
);

metric(
  'a button that clips keeps its label under an inline-block, and one under layout containment its content box',
  async () => {
    // Blink has a button ignore `overflow` for its baseline wherever the
    // baseline is asked for (`ShouldIgnoreOverflowPropertyForInlineBlock
    // Baseline`): as the last block of an inline-block too, which sat on
    // the button's bottom margin edge, its label a descent and a padding
    // above the text beside it. And the bottom of the content box is where
    // a button sits whenever it has no baseline to give, one that layout
    // containment keeps in among them.
    const { node } = await render(
      '<style>body{margin:0;font:16px/20px sans-serif}' +
        'button{box-sizing:border-box;margin:0;padding:8px;border:1px solid;' +
        'font:16px/20px sans-serif}</style>' +
        '<div id="a">x<span style="display:inline-block">' +
        '<button id="b" style="display:block;overflow:hidden">Label</button>' +
        '</span></div>' +
        '<div id="c">x<button id="d" style="height:60px;contain:layout">' +
        'Label</button></div>' +
        // two 60px buttons as wide as their block are two lines of 60px,
        // what is in them centred or not: nextjs.org's sidebar pickers
        '<div id="e"><button id="f" style="width:100%;height:60px">' +
        '<span><div style="height:36px"></div></span></button>' +
        '<button id="g" style="width:100%;height:60px">' +
        '<span><div style="height:36px"></div></span></button></div>',
      300,
    );
    const el = view(node);
    const baselineOf = (id: string) => {
      const [line] = linesOf(el, id);
      return line.y + line.baseline;
    };
    const near = (a: number, b: number, what: string) =>
      assert.ok(Math.abs(a - b) < 0.01, `${what}: ${a} and ${b}`);
    const [label] = linesOf(el, 'b');
    near(label.y + label.baseline, baselineOf('a'), 'a label that clips');
    const d = boxOf(el, 'd');
    near(d.y + d.height - 9, baselineOf('c'), 'over its padding and border');
    assert.strictEqual(boxOf(el, 'g').y, boxOf(el, 'f').y + 60, 'a line each');
    assert.strictEqual(boxOf(el, 'e').height, 120, 'and no taller');
  },
);

metric('a no-break space beside a block is a line of its own', async () => {
  // CSS's white space is the space, the tab and the line breaks (CSS Text
  // 3, 4.1); `trim` and `\s` take the no-break space in too, so the
  // `&nbsp;` a mail layout holds a gap open with was dropped beside a
  // block as if it held nothing
  const { node } = await render(
    '<style>body{margin:0} div{line-height:20px}</style>' +
      '<div id="d">&nbsp;<div>x</div></div>' +
      '<div id="e"> <div>x</div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'd').height, 40, 'its line, then the block');
  assert.strictEqual(boxOf(el, 'e').height, 20, 'a space is white space');
});

test('a word with too little room left on its line goes to the next, whole', async () => {
  // Text laid out after something else on its line — an inline-block, or a
  // float it was cut at — has the room that is left, and a word wider than
  // that room was broken inside itself to fit it: its first letter at the
  // line's end, the rest on the next.
  // Room for a letter, where the engine cuts the word after it, and for
  // none, where it runs the whole word past the line's end: both ways.
  for (const filled of [290, 298]) {
    for (const between of [
      '',
      '<span style="float:left;width:50px;height:30px"></span>',
    ]) {
      const { node } = await render(
        '<div id="w" style="width:300px;font:16px/20px sans-serif">' +
          `<span style="display:inline-block;width:${filled}px;height:10px">` +
          `</span>${between}goes on</div>`,
      );
      const lines = linesOf(view(node), 'w');
      const which = `${300 - filled}px left, after ${between ? 'a float' : 'an inline-block'}`;
      assert.strictEqual(lines.length, 2, which);
      assert.strictEqual(lines[0].texts.length, 0, `${which}: none of it`);
      cleanup();
    }
  }
  // and where the block does not wrap, nothing goes to another line
  const { node } = await render(
    '<div id="w" style="width:300px;white-space:nowrap">' +
      '<span style="display:inline-block;width:290px;height:10px"></span>' +
      '<span style="float:left;width:50px;height:30px"></span> goes on</div>',
  );
  assert.strictEqual(linesOf(view(node), 'w').length, 1, 'nowrap');
});

test('an inline box is broken around a block in it, and its pieces lose their edges there (CSS 2.1 9.2.1.1)', async () => {
  const { node } = await render(
    '<style>body{margin:0}p{margin:0}</style>' +
      // old mail: paragraphs in a <font>
      '<div><font face="serif"><p id="one">One</p><p id="two">Two</p></font></div>' +
      // a link around a card's blocks
      '<div><a href="#">x<div id="card">Card</div>y</a></div>' +
      // an image set display: block in a link has no line around it
      '<div id="banner"><a href="#"><img id="img" width="40" height="20" style="display:block"></a></div>' +
      '<div><span id="s" style="border:2px solid">a<div>b</div>c</span></div>',
    400,
  );
  const el = view(node);
  const one = boxOf(el, 'one');
  const two = boxOf(el, 'two');
  assert.ok(two.y >= one.y + one.height, 'stacked, not side by side');
  assert.strictEqual(one.width, 400, 'as wide as a block');
  assert.strictEqual(boxOf(el, 'card').width, 400);
  assert.strictEqual(
    boxOf(el, 'img').y,
    boxOf(el, 'banner').y,
    'no line above it',
  );
  // the span's pieces: the first keeps its start edge, the last its end
  const pieces: (LaidBox & { borderLeft: number; borderRight: number })[] = [];
  const walk = (box: LaidBox): void => {
    const kind = (box as unknown as { kind: string }).kind;
    if (box.el?.attribs.id === 's' && kind === 'inline') {
      pieces.push(box as (typeof pieces)[number]);
    }
    box.children.forEach(walk);
  };
  walk((el as unknown as { _tree: { root: LaidBox } })._tree.root);
  assert.strictEqual(pieces.length, 2);
  assert.deepStrictEqual(
    pieces.map((p) => [p.borderLeft, p.borderRight]),
    [
      [2, 0],
      [0, 2],
    ],
  );
});

metric(
  'a relatively positioned inline box moves its text, and nothing around it',
  async () => {
    // CSS 2.1 9.4.3: the box is moved after the line is laid out, so the
    // line and the text either side of it stay where they were
    const doc = (offset: string) =>
      '<style>p{margin:0}</style><p id="p">one <span ' +
      `style="position:relative;${offset}">two</span> three</p>`;
    const still = fragmentsOf(
      view((await render(doc('top:0;left:0'))).node),
      'p',
    );
    cleanup();
    const moved = fragmentsOf(
      view((await render(doc('top:10px;left:5px'))).node),
      'p',
    );
    assert.deepStrictEqual(
      moved.map((f) => f.text),
      still.map((f) => f.text),
    );
    const two = still.findIndex((f) => f.text.includes('two'));
    assert.ok(two >= 0 && still[two].text.trim() === 'two', 'laid out apart');
    for (let i = 0; i < still.length; i += 1) {
      const [dx, dy] = i === two ? [5, 10] : [0, 0];
      assert.deepStrictEqual(
        [moved[i].x - still[i].x, moved[i].y - still[i].y, moved[i].line],
        [dx, dy, still[i].line],
        `"${still[i].text}"`,
      );
    }
  },
);

metric(
  "text moved off its line is inside its paragraph's paint bounds",
  async () => {
    // a repaint of where the text went has to find the paragraph there
    const { node } = await render(
      '<style>p{margin:0}</style><p id="p">one <span ' +
        'style="position:relative;top:120px">two</span></p>',
    );
    const el = view(node);
    const p = boxOf(el, 'p') as LaidBox & {
      boundsY: number;
      boundsHeight: number;
    };
    const two = fragmentsOf(el, 'p').find((f) => f.text === 'two')!;
    assert.ok(two.y >= p.y + 100, 'moved down');
    assert.ok(
      p.boundsY + p.boundsHeight >= two.y + 10,
      `bounds to ${p.boundsY + p.boundsHeight}, text at ${two.y}`,
    );
  },
);

metric(
  "a relatively positioned inline box's background goes with it",
  async () => {
    const doc = (offset: string) =>
      '<style>p{margin:0}</style><p id="p">one <span ' +
      `style="position:relative;background:#00ff00;${offset}">two</span> ` +
      '<b style="background:#0000ff">three</b></p>';
    const fills = async (offset: string) =>
      (await fillsOf(view((await render(doc(offset))).node))).filter(
        (f) => f.style === '#00ff00' || f.style === '#0000ff',
      );
    const still = await fills('top:0;left:0');
    cleanup();
    const moved = await fills('top:-6px;left:4px');
    assert.strictEqual(still.length, 2);
    assert.deepStrictEqual(
      moved.map((f) => [f.style, f.x, f.y, f.w, f.h]),
      [
        ['#00ff00', still[0].x + 4, still[0].y - 6, still[0].w, still[0].h],
        ['#0000ff', still[1].x, still[1].y, still[1].w, still[1].h],
      ],
    );
  },
);

metric(
  'a block in a relatively positioned inline box moves with it',
  async () => {
    // it stands outside the pieces of the box it broke in two, and the
    // box's offset moves it all the same (CSS 2.1 9.2.1.1)
    const doc = (offset: string) =>
      '<style>body{margin:0}</style><div><span ' +
      `style="position:relative;${offset}">a<div id="b">block</div>c</span>` +
      '</div>';
    const at = async (offset: string) => {
      const b = boxOf(view((await render(doc(offset))).node), 'b');
      return [b.x, b.y, b.width];
    };
    const still = await at('top:0;left:0');
    cleanup();
    const moved = await at('top:5px;left:30px');
    assert.deepStrictEqual(moved, [still[0] + 30, still[1] + 5, still[2]]);
  },
);

metric(
  'what position: relative moves off a line past the window is drawn where it goes',
  async () => {
    // A block's lines are drawn where the damage meets them, and the window
    // bounds every paint: an inline-block, or a relative span's text, moved
    // up off a line below the window went undrawn with its line, wherever
    // it landed. A reftest's reference builds its picture that way.
    const inkIn = async (
      result: { ctx: unknown },
      rgb: (r: number, g: number, b: number) => boolean,
    ) => {
      const data: Uint8ClampedArray = await new Promise((ok, fail) =>
        (
          result.ctx as {
            getImageData(
              x: number,
              y: number,
              w: number,
              h: number,
              cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
            ): void;
          }
        ).getImageData(0, 0, 400, 400, (e, d) => (e ? fail(e) : ok(d.data))),
      );
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (rgb(data[i], data[i + 1], data[i + 2])) n += 1;
      }
      return n;
    };
    const tall =
      '<style>body{margin:0}.tall{display:inline-block;width:10px;' +
      'height:600px}</style><div><span class="tall"></span><br>';
    const block = await renderWithBytes(
      tall +
        '<span style="display:inline-block;position:relative;top:-590px;' +
        'width:100px;height:30px;background:#0000ff"></span></div>',
      {},
    );
    assert.strictEqual(
      await inkIn(block.result, (r, g, b) => b > 200 && r < 60 && g < 60),
      3000,
      'the inline-block',
    );
    cleanup();
    const text = await renderWithBytes(
      tall +
        '<span style="position:relative;top:-590px;color:#00ff00;' +
        'font:bold 40px/1 sans-serif">MMMM</span></div>',
      {},
    );
    assert.ok(
      (await inkIn(text.result, (r, g, b) => g > 200 && r < 60 && b < 60)) >
        500,
      'the text',
    );
  },
);

/** How many pixels of each of three colours a laid-out element covers. */
async function inkIn(
  result: { ctx: unknown },
  el: HtmlViewNode,
  id: string,
): Promise<{ red: number; green: number; blue: number }> {
  const box = boxOf(el, id);
  const abs = (el as unknown as { abs: { x: number; y: number } }).abs;
  const data: Uint8ClampedArray = await new Promise((ok, fail) =>
    (
      result.ctx as {
        getImageData(
          x: number,
          y: number,
          w: number,
          h: number,
          cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
        ): void;
      }
    ).getImageData(
      Math.round(abs.x + box.x),
      Math.round(abs.y + box.y),
      Math.ceil(box.width),
      Math.ceil(box.height),
      (e, d) => (e ? fail(e) : ok(d.data)),
    ),
  );
  const seen = { red: 0, green: 0, blue: 0 };
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 200 && g < 60 && b < 60) seen.red += 1;
    if (g > 200 && r < 60 && b < 60) seen.green += 1;
    if (b > 200 && r < 60 && g < 60) seen.blue += 1;
  }
  return seen;
}

metric(
  'hidden inline text is not drawn, and visible text inside it is',
  async () => {
    // `visibility: hidden` leaves the text its room and draws none of it,
    // and a descendant can be visible again (CSS 2.1 11.2)
    const style =
      '<style>body{margin:0}p,div{margin:0 0 10px;font:bold 30px/40px ' +
      'sans-serif;color:#ff0000}</style>';
    const width = (el: HtmlViewNode, id: string) =>
      linesOf(el, id).reduce((w, line) => Math.max(w, line.width), 0);
    const bare = await renderWithBytes(style + '<p id="a">III</p>', {});
    const alone = await inkIn(bare.result, bare.el, 'a');
    const aloneWidth = width(bare.el, 'a');
    cleanup();

    const { result, el } = await renderWithBytes(
      style +
        '<p id="a">III<span style="visibility:hidden"> IIII</span></p>' +
        '<p id="b"><span style="visibility:hidden">III <b ' +
        'style="visibility:visible;color:#00ff00">III</b></span></p>' +
        '<div id="c" style="visibility:hidden">III <span ' +
        'style="visibility:visible;color:#0000ff">III</span></div>',
      {},
    );
    const [a, b, c] = await Promise.all(
      ['a', 'b', 'c'].map((id) => inkIn(result, el, id)),
    );
    assert.ok(a.red > 0, 'the visible text is drawn');
    assert.ok(
      width(el, 'a') > aloneWidth * 2,
      'the hidden text keeps its room',
    );
    assert.strictEqual(a.red, alone.red, 'and none of the hidden text is');
    assert.deepStrictEqual([b.red > 0, b.green > 0], [false, true]);
    assert.deepStrictEqual([c.red > 0, c.blue > 0], [false, true]);
  },
);

metric('a negative inline margin takes room back on its line', async () => {
  // `margin-right: -30px` pulls what follows the span back over it, so the
  // last word fits beside it (CSS 2.1 8.3); taken for no margin, it wrapped
  const lines = async (margin: string) => {
    const { node } = await render(
      '<style>p{margin:0;font:10px monospace;width:60px}</style>' +
        '<p id="p">aaaa <span style="margin-right:' +
        margin +
        '">bbbb</span> cccc</p>',
    );
    const found = linesOf(view(node), 'p');
    cleanup();
    return found;
  };
  assert.strictEqual((await lines('0')).length, 2);
  const [pulled, ...rest] = await lines('-30px');
  assert.strictEqual(rest.length, 0, 'one line');
  // and laid out a piece at a time, where a positive margin is a spacer in
  // one layout: CoreText's typesetter breaks before a space whose letter
  // spacing is negative, and only this suite's engine does not
  assert.ok(pulled.texts.length > 1, 'in pieces');
});

metric("an empty inline box's line height makes its line taller", async () => {
  // every inline box is on its line as tall as its own line height, text
  // or none (CSS 2.1 10.8): an empty span of 100px lines before the text
  // was on a line of its own after it, and the text's line was 20px. A
  // line of nothing but empty boxes is no line (9.4.2), unless one of them
  // has a border or a margin, whatever the two add up to
  const { node } = await render(
    '<style>body{margin:0} div{line-height:1;font-size:20px}</style>' +
      '<div id="t"><span style="line-height:5"></span>X</div>' +
      '<div id="e"><span style="line-height:5"></span></div>' +
      '<div id="m"><span style="line-height:5;border-left:10px solid;' +
      'margin-left:-10px"></span></div>',
  );
  const el = view(node);
  const lines = linesOf(el, 't');
  assert.strictEqual(lines.length, 1, 'one line');
  assert.strictEqual(lines[0].height, 100);
  assert.strictEqual(boxOf(el, 'e').height, 0, 'no line');
  assert.strictEqual(boxOf(el, 'm').height, 100, 'a line');
});

metric("an inline box's own line height makes its line taller", async () => {
  // CSS gives every inline box its own line height, and the line box holds
  // them all (CSS 2.1 10.8.1): a span of 60px lines in a paragraph of 20px
  // ones makes the line a paragraph of 60px lines has
  const lineWith = async (p: string, markup: string) => {
    const { node } = await render(
      `<style>p{margin:0;font-size:16px;${p}}</style><p id="p">${markup}</p>`,
    );
    const el = view(node);
    const [line] = linesOf(el, 'p');
    const texts = baselinesOf(el, 'p');
    cleanup();
    return {
      height: line.height,
      baseline: texts[0].line - line.y,
      apart: texts.filter((t) => Math.abs(t.at - t.line) > 0.01).length,
    };
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const tall = await lineWith('line-height:60px', 'a b c');
  const held = await lineWith(
    'line-height:20px',
    'a <span style="line-height:60px">b</span> c',
  );
  assert.ok(near(held.height, 60), `${held.height}`);
  assert.ok(near(held.baseline, tall.baseline), 'the text in its middle');
  assert.strictEqual(held.apart, 0, 'every text on the one baseline');
  // the box is on the line whatever is in it: text in a box of 20px lines
  // inside it is set in its 60px
  const nested = await lineWith(
    'line-height:20px',
    'a <span style="line-height:60px"><em style="line-height:20px">b</em></span> c',
  );
  assert.ok(near(nested.height, 60), `${nested.height}`);
  assert.ok(near(nested.baseline, tall.baseline));
  // and one with less than its paragraph's is inside the paragraph's
  const less = await lineWith(
    'line-height:20px',
    'a <span style="line-height:10px">b</span> c',
  );
  assert.ok(near(less.height, 20), `${less.height}`);
});

metric(
  "the text of an inline box with an edge is shaped apart from its neighbours'",
  async () => {
    // CSS Text 3, 7.3: shaping is broken across an inline box's margin,
    // border or padding, where the engine shapes a word that runs across
    // spans shaped alike as one — kerned, and joined in Arabic
    const { node } = await render(
      '<p id="a">Wa<span style="padding-left:4px">ve</span> Wa<b>ve</b> ' +
        'Wa<i style="margin-right:2px">ve</i></p>',
    );
    const el = view(node);
    const apart: string[] = [];
    for (const line of linesOf(el, 'a')) {
      for (const text of line.texts) {
        const layout = text.layout as unknown as {
          lines: {
            runs: { span?: { text: string; shapeApart?: boolean } }[];
          }[];
        };
        for (const run of layout.lines[text.layoutLine].runs) {
          if (run.span?.shapeApart) apart.push(run.span.text);
        }
      }
    }
    assert.deepStrictEqual(apart, ['ve', 've']);
  },
);

metric(
  "an inline box of a larger face has its own line height, not a multiple of the block's",
  async () => {
    // A `line-height` length is inherited as that length, and a box that
    // sets its own keeps it (CSS 2.1 10.8.1). The one layout set every run
    // at the block's line height as a multiple of the run's face: a 14px
    // box under `font: 11px/15px` came out 15 × 14/11, 19px, on a line
    // CSS makes its own 16px and the strut's 15. The Zen Garden's third
    // design runs a heading inline under its body's `11px/15px`
    const { node } = await render(
      '<style>body{margin:0}div{font:11px/15px serif}' +
        'span{font:14px/16px serif}</style>' +
        '<div id="d"><span>Archives</span></div>',
      400,
    );
    const el = view(node);
    await act();
    const [line] = linesOf(el, 'd');
    assert.ok(
      line.height >= 16 - 0.01 && line.height < 18,
      `as tall as its boxes, not 19: ${line.height}`,
    );
  },
);

metric(
  "a paragraph's lines are fitted as a browser fits them, each element's text rounded up to a 64th",
  async () => {
    // A browser rounds each element's text on a line up to a 64th of a
    // pixel before it adds it, and fits the sum with a 64th to spare
    // (Blink's `SnappedWidth`, `CanFitOnLine`): the Zen Garden's 024 has a
    // line of Verdana 0.002px past its 529px, three elements' text on it,
    // that Chrome breaks and the sum of its advances fitted. The engine does
    // that for a layout made with `fit: 'items'`, and reports a line as wide
    // as it fitted it, so a box sized to its text still holds it
    const { result, node } = await render(
      '<style>body{margin:0}p{margin:0;width:300px}.f{float:left}</style>' +
        '<p>alpha <b>beta</b> gamma, and a line long enough to wrap</p>' +
        '<p><span class="f" id="f">one <i>two</i> three <b>four</b></span></p>',
    );
    const el = view(node);
    await act();
    assert.strictEqual(linesOf(el, 'f').length, 1, 'a float holds its text');
    const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
    const made: { fit?: string; maxWidth?: number }[] = [];
    const recording: FontsLike = {
      layout: (runs, style, options) => {
        made.push(options);
        return fonts.layout(runs, style, options);
      },
      match: (...args) => fonts.match(...args),
    };
    const { layoutDocument } = await import('../../src/html/layout/block.js');
    const tree = (el as unknown as { _tree: unknown })._tree;
    layoutDocument(tree as never, recording, 400, 600);
    const wrapping = made.filter((options) => options.maxWidth !== undefined);
    assert.ok(wrapping.length > 0, 'a paragraph was laid out to a width');
    assert.ok(
      wrapping.every((options) => options.fit === 'items'),
      `every one fitted as a browser fits it: ${JSON.stringify(wrapping)}`,
    );
  },
);

metric(
  "a word after an element's text fits the line as a browser fits it, with a 64th to spare",
  async () => {
    // A line of text in two sizes is composed a piece at a time, and a piece
    // that may start a line goes to the next one where it does not fit the
    // room left: past it by a 64th of a pixel, as a browser fits a line
    // (Blink's `AddEpsilon`), where it was half a pixel. The Zen Garden's
    // 074 ran "Andrew" a third of a pixel past its 120px column after
    // "Modern by", where Chrome breaks before it
    const source = (width: string) =>
      `<style>body{margin:0}p{margin:0;width:${width};font:9px/20px ` +
      'sans-serif}b{font-size:12px}</style>' +
      '<p id="p"><b>Modern</b> by <b>Andrew</b></p>';
    const wide = await render(source('400px'));
    const [line] = linesOf(view(wide.node), 'p');
    const last = line.texts[line.texts.length - 1];
    const end = extentOf(last)[1];
    await wide.result.unmount();
    const linesAt = async (width: number) => {
      const { node, result } = await render(source(`${width}px`));
      const n = linesOf(view(node), 'p').length;
      await result.unmount();
      return n;
    };
    assert.strictEqual(
      await linesAt(end - 0.25),
      2,
      `a quarter of a pixel short of ${end}, the word goes to the next line`,
    );
    assert.strictEqual(
      await linesAt(end - 0.005),
      1,
      'a two-hundredth short, it fits',
    );
  },
);

test("a box's leading is split as a browser splits it: the half above rounded down to a whole pixel", async () => {
  // CSS gives each side of a box's text half its leading; which side of the
  // pixel grid a half that is not whole goes to is the user agent's, and
  // Blink rounds the half above down (`CalculateLeadingSpace`). On a
  // browser's whole-pixel metrics a 13px Arial on an 18px line has 1px of
  // leading over its 15 and 2px under; split evenly, it reached half a pixel
  // above the 12px strut beside it, and the line came out 18.5px tall —
  // every design in the Zen Garden's 040 list, eight of them to a column
  const { strutOf } = await import('../../src/html/layout/inline.js');
  const faces: Record<number, { ascent: number; descent: number }> = {
    12: { ascent: 11, descent: 3 },
    13: { ascent: 12, descent: 3 },
  };
  const fonts = {
    layout: () => {
      throw new Error('not laid out');
    },
    match: (_family: string, { size }: { size: number }) => ({
      metrics: () => ({ ...faces[size], lineGap: 0, lineHeight: 15 }),
    }),
  } as unknown as FontsLike;
  // what the strut reads of a style
  const style = (fontSize: number, lineHeight: number): ComputedStyle =>
    ({
      fontFamily: 'Blink',
      fontSize,
      fontWeight: 400,
      fontStyle: 'normal',
      lineHeight,
      lineHeightIsLength: true,
    }) as unknown as ComputedStyle;
  assert.deepStrictEqual(
    strutOf(fonts, style(12, 18)),
    { ascent: 13, descent: 5 },
    'four pixels of leading, two above and two below',
  );
  assert.deepStrictEqual(
    strutOf(fonts, style(13, 18)),
    { ascent: 13, descent: 5 },
    'three, one above and two below: level with the 12px strut',
  );
  assert.deepStrictEqual(
    strutOf(fonts, style(13, 12)),
    { ascent: 10, descent: 2 },
    'and less than none, rounded down all the same',
  );
});

metric(
  "a paragraph's baseline is where a browser puts it, and its glyphs are drawn on it",
  async () => {
    // A paragraph laid out whole takes its baselines from the text engine,
    // which splits the leading evenly; its lines are placed as the strut's
    // are, and the layout drawn that much higher, so its glyphs, its
    // decorations and an inline box beside it agree
    const { result, node } = await render(
      '<style>body{margin:0}p{margin:0;font:13px/18px sans-serif}</style>' +
        '<p id="plain">plain text</p>',
    );
    const el = view(node);
    await act();
    const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
    const face = fonts
      .match('sans-serif', { size: 13, weight: 400, style: 'normal' })
      .metrics(13);
    const [plain] = linesOf(el, 'plain');
    const want =
      face.ascent + Math.floor((18 - face.ascent - face.descent) / 2 + 1e-6);
    assert.ok(
      Math.abs(plain.baseline - want) < 0.01,
      `the leading's half above rounded down: ${plain.baseline}, not ${want}`,
    );
    const [text] = plain.texts;
    const natural = text.layout.lines[text.layoutLine];
    assert.ok(
      Math.abs(text.drawY + natural.baseline - (plain.y + plain.baseline)) <
        1e-6,
      'and its glyphs are drawn on it',
    );
  },
);

test("an inline box that a line breaks inside ends that line's fragment at its text, not after the space the line ends on", async () => {
  // A space a line ends on is removed (CSS Text 3, 4.1.2) and takes no
  // room on it, and a browser's fragment of the box ends at its last
  // letter. The band that measured it went on past the line into the
  // space, where a caret after it goes: design 209's link, broken after
  // "CSS", was a space wider than Chrome's
  const measured = await render(
    '<style>body{margin:0;font:16px/20px sans-serif}</style>' +
      '<span id="m">word CSS</span>',
  );
  const wide = view(measured.node);
  const room = Math.ceil(
    wide.elementRect(findById(wide.document, 'm')!)!.width + 1,
  );
  await measured.result.unmount();
  const { node, result } = await render(
    '<style>body{margin:0;font:16px/20px sans-serif}</style>' +
      `<p style="margin:0;width:${room}px">word <a id="a">` +
      // in a smaller face, as 209's <abbr> is, which lays the line out a
      // piece at a time
      '<span id="s" style="font-size:85%">CSS</span> Re</a></p>',
  );
  const el = view(node);
  const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
  assert.ok(
    rect('a').height > 30,
    `the link is on two lines: ${rect('a').height}`,
  );
  assert.ok(
    Math.abs(rect('a').x + rect('a').width - (rect('s').x + rect('s').width)) <
      0.01,
    `its first line's fragment ends where "CSS" does: ` +
      `${rect('a').x + rect('a').width} ${rect('s').x + rect('s').width}`,
  );
  await result.unmount();
  // and text a line ends with is measured where it is, off the line or
  // not: a heading's words set 500px out by `text-indent`, as an image
  // replacement sets them, are as wide as ever
  const indented = await render(
    '<style>body{margin:0;font:16px/20px sans-serif}</style>' +
      '<h2 style="margin:0;width:300px;text-indent:-500px;overflow:hidden">The ' +
      '<abbr id="t">CSS</abbr> Garden</h2>',
  );
  const out = view(indented.node);
  const word = out.elementRect(findById(out.document, 't')!)!;
  assert.ok(
    word.width > 10,
    `the indented word keeps its width: ${word.width}`,
  );
  assert.ok(word.x < -400, `where the indent put it: ${word.x}`);
  await indented.result.unmount();
});

metric(
  'a piece of a line goes on after the white space it ends on as far as the engine says it takes',
  async () => {
    // A line composed a piece at a time — here an indented one with an
    // inline-block in it — lays out the text before the inline-block alone,
    // and its engine strips the space it ends on. The space is on the line,
    // and it takes what the engine says the line takes with it, `advance`:
    // with each element's text rounded up to a 64th with its spaces, once,
    // as Blink rounds it, the text rounded and a space added after it came
    // to more, and the Zen Garden's 166 broke a line Chrome fits. A spy
    // engine says every line's space takes 40px, and the inline-block is
    // there
    const source =
      '<p style="margin:0;text-indent:1px">one ' +
      '<span id="ib" style="display:inline-block;width:10px;height:10px">' +
      '</span> two</p>';
    const { node } = await render(source);
    const el = view(node) as unknown as {
      app: { fonts: FontsLike };
      _source: { document: unknown };
      _cascade: unknown;
    };
    const engine = el.app.fonts;
    const { buildBoxes } = await import('../../src/html/layout/boxes.js');
    const { layoutDocument } = await import('../../src/html/layout/block.js');
    const atomicX = (fonts: FontsLike) => {
      const tree = buildBoxes(el._source.document as never, {
        cascade: el._cascade as never,
        scale: 1,
        imageSize: () => null,
        urlSize: () => null,
        controlSize: () => ({ width: 0, height: 0 }) as never,
      });
      layoutDocument(tree, fonts, 400, 600);
      const find = (box: LaidBox): LaidBox | null => {
        if (box.el?.attribs.id === 'ib') return box;
        for (const child of box.children) {
          const hit = find(child);
          if (hit) return hit;
        }
        return null;
      };
      return find(tree.root as unknown as LaidBox)!.x;
    };
    // what the engine itself says the space after "one" takes, before the
    // spy says 40px instead
    let gap = NaN;
    const spaced: FontsLike = {
      layout: (content, style, options) => {
        const layout = engine.layout(content, style, options);
        const text = content.map((run) => run.text).join('');
        for (const line of layout.lines) {
          if (text.endsWith('one ') && line.advance !== undefined) {
            gap = line.advance - line.width;
          }
          line.advance = line.width + 40;
        }
        return layout;
      },
      match: (family, style) => engine.match(family, style),
    };
    const own = atomicX(engine);
    const told = atomicX(spaced);
    assert.ok(gap > 1 && gap < 10, `the engine's space after "one": ${gap}`);
    assert.ok(
      Math.abs(told - own - (40 - gap)) < 0.01,
      `the inline-block is as far past "one" as the spy says: ${told} ` +
        `against ${own} with a ${gap}px space`,
    );
  },
);

metric(
  'a line with no text on it keeps the lines in text order, so the text before it is found',
  async () => {
    // A line holding only an atomic that wrapped — here an inline-block,
    // in #435 a submit button — recorded its text as [0, 0), after a line
    // that ended at 4. Lines are found by their text with a binary search
    // over those ranges as sorted, which that one broke: the span on the
    // first line measured as no box, and the caret into it had nowhere
    // to go.
    const { node } = await render(
      '<div style="width:200px"><span id="s">text</span>' +
        '<span style="display:inline-block;width:190px;height:10px"></span>' +
        '</div>',
    );
    const el = view(node);
    const lines = (
      el as unknown as {
        _tree: { root: { children: { lines?: { y: number }[] }[] } };
      }
    )._tree.root.children[0].lines!;
    assert.strictEqual(lines.length, 2, 'the inline-block wrapped alone');
    const s = el.elementRect(findById(el.document, 's')!);
    assert.ok(s && s.width > 0, `the span has its box: ${JSON.stringify(s)}`);
    assert.strictEqual(s.y, lines[0].y, 'on the first line');
    assert.ok(el.textCaretRect(2), 'and a caret inside it');
  },
);

metric(
  "a bold word whose face reaches higher than its family's regular makes its line taller, as CSS stacks the boxes",
  async () => {
    // Each inline box has the paragraph's line height with its own
    // half-leading, and the line box holds them all (CSS 2.1 10.8.1): a
    // bold face that reaches higher than the regular one makes the line
    // taller than its line height. A bold box was let past as keeping its
    // family's line metrics, and its paragraph laid out in one call, whose
    // lines are the line height times the tallest face. Helvetica Neue Bold
    // is such a face, and the Zen Garden's 166 ran 3.2px long. A spy engine
    // says the bold face reaches 3px higher than the engine's does
    const { node } = await render(
      '<p id="p" style="margin:0;font:16px/20px sans-serif">plain ' +
        '<b>bold</b> plain</p>',
    );
    const el = view(node) as unknown as {
      app: { fonts: FontsLike };
      _source: { document: unknown };
      _cascade: unknown;
    };
    const engine = el.app.fonts;
    const higher: FontsLike = {
      layout: (content, style, options) =>
        engine.layout(content, style, options),
      match: (family, style) => {
        const face = engine.match(family, style);
        const weight = (style as { weight?: unknown }).weight;
        if (weight !== 700 && weight !== 'bold') return face;
        const tall = Object.create(face) as typeof face;
        tall.metrics = (size: number) => {
          const m = face.metrics(size);
          return {
            ...m,
            ascent: m.ascent + 3,
            lineHeight: faceLineHeight(m) + 3,
          };
        };
        return tall;
      },
    };
    const { buildBoxes } = await import('../../src/html/layout/boxes.js');
    const { layoutDocument } = await import('../../src/html/layout/block.js');
    const tree = buildBoxes(el._source.document as never, {
      cascade: el._cascade as never,
      scale: 1,
      imageSize: () => null,
      urlSize: () => null,
      controlSize: () => ({ width: 0, height: 0 }) as never,
    });
    layoutDocument(tree, higher, 400, 600);
    const find = (box: LaidBox): LaidBox | null => {
      if (box.el?.attribs.id === 'p') return box;
      for (const child of box.children) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    const p = find(tree.root as unknown as LaidBox)!;
    assert.ok(
      p.height > 20.5,
      `the bold box's leading stacks over the strut's: ${p.height}`,
    );
  },
);

metric(
  "an inline box's edges are as wide as they are where the engine's layout of a no-break space measures nothing, as react-x11's Windows engine measured one",
  async () => {
    // An edge is a no-break space letter-spaced to the edge's width, the
    // spacing worked out from the space's own advance. DirectWrite leaves a
    // no-break space at the end of a line out of the text's width, so a
    // lone one measured nothing, and every edge came out a space too wide:
    // each link with a margin in a Zen Garden footer was 2.6px wider than
    // Chrome's. The line's advance has it.
    const source =
      '<p id="p" style="margin:0;font:16px sans-serif">x ' +
      '<a id="a" style="margin:0 10px;padding:0 3px">link</a> y</p>';
    const { node } = await render(source, 400);
    const el = view(node) as unknown as {
      app: { fonts: FontsLike };
      _source: { document: unknown };
      _cascade: unknown;
    };
    const engine = el.app.fonts;
    const blind: FontsLike = {
      layout: (content, style, options) => {
        const laid = engine.layout(content, style, options);
        const lone =
          content.length === 1 &&
          content[0].text === '\u00a0' &&
          Object.keys(options ?? {}).length === 0;
        return lone ? Object.assign(Object.create(laid), { width: 0 }) : laid;
      },
      match: (family, style) => engine.match(family, style),
    };
    const { buildBoxes } = await import('../../src/html/layout/boxes.js');
    const { layoutDocument } = await import('../../src/html/layout/block.js');
    const lineWidth = (fonts: FontsLike): number => {
      const tree = buildBoxes(el._source.document as never, {
        cascade: el._cascade as never,
        scale: 1,
        imageSize: () => null,
        urlSize: () => null,
        controlSize: () => ({ width: 0, height: 0 }) as never,
      });
      layoutDocument(tree, fonts, 400, 600);
      const find = (box: LaidBox): LaidBox | null => {
        if (box.el?.attribs.id === 'p') return box;
        for (const child of box.children) {
          const hit = find(child);
          if (hit) return hit;
        }
        return null;
      };
      const p = find(tree.root as unknown as LaidBox) as unknown as {
        lines: { width: number }[];
      };
      return p.lines[0].width;
    };
    assert.ok(
      Math.abs(lineWidth(blind) - lineWidth(engine)) < 0.01,
      `the same line: ${lineWidth(blind)} and ${lineWidth(engine)}`,
    );
  },
);

metric(
  "a face that states no lineHeight sets `line-height: normal` from its ascent, descent and gap, as react-x11's Windows engine states them",
  async () => {
    // DirectWrite's face metrics are an ascent, a descent and a line gap,
    // and react-x11's Windows engine handed them on with no `lineHeight`:
    // read off the field, every `line-height: normal` was NaN, a NaN in a
    // block's height culled the whole document from the paint, and every
    // Zen Garden design came up blank on Windows
    const source =
      '<div id="d" style="margin:0;font:16px sans-serif">' +
      '<p style="margin:0">one <span style="border:1px solid">boxed</span> ' +
      '<span style="display:inline-block;width:20px;height:20px"></span>' +
      ' line</p><p style="margin:0">' +
      'word '.repeat(40) +
      '</p></div>';
    const { node } = await render(source, 300);
    const el = view(node) as unknown as {
      app: { fonts: FontsLike };
      _source: { document: unknown };
      _cascade: unknown;
    };
    const engine = el.app.fonts;
    const named = (gap: 'lineGap' | 'leading' | null): FontsLike => ({
      layout: (content, style, options) =>
        engine.layout(content, style, options),
      match: (family, style) => {
        const face = engine.match(family, style);
        const bare = Object.create(face) as typeof face;
        bare.metrics = (size: number) => {
          const { lineHeight, lineGap, ...rest } = face.metrics(size);
          void lineHeight;
          return gap ? { ...rest, [gap]: lineGap } : rest;
        };
        return bare;
      },
    });
    const { buildBoxes } = await import('../../src/html/layout/boxes.js');
    const { layoutDocument } = await import('../../src/html/layout/block.js');
    const heightWith = (fonts: FontsLike): number => {
      const tree = buildBoxes(el._source.document as never, {
        cascade: el._cascade as never,
        scale: 1,
        imageSize: () => null,
        urlSize: () => null,
        controlSize: () => ({ width: 0, height: 0 }) as never,
      });
      layoutDocument(tree, fonts, 300, 600);
      const find = (box: LaidBox): LaidBox | null => {
        if (box.el?.attribs.id === 'd') return box;
        for (const child of box.children) {
          const hit = find(child);
          if (hit) return hit;
        }
        return null;
      };
      return find(tree.root as unknown as LaidBox)!.height;
    };
    const stated = heightWith(engine);
    for (const gap of ['lineGap', 'leading', null] as const) {
      const height = heightWith(named(gap));
      assert.ok(Number.isFinite(height), `${gap}: a height, not ${height}`);
      if (gap) assert.strictEqual(height, stated, `${gap}: the same lines`);
      else assert.ok(height > 0, `no gap: still lines, ${height}`);
    }
  },
);
