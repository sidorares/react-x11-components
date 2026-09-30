// <Html> — text: white space, wrapping, alignment, decoration, shadows,
// clamping.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, pixelAt, waitFor } from 'react-x11/test';
import type { FontsLike } from '../../src/html/layout/inline.js';
import type { TextRun } from '../../src/richtext/index.js';
import { parseColor } from '../../src/html/css/values.js';
import {
  boxOf,
  extentOf,
  fillsOf,
  findById,
  lineTextsOf,
  linesOf,
  metric,
  render,
  textRunsOf,
  view,
} from './harness.js';
import type { PaintOp, PlacedLine } from './harness.js';

afterEach(cleanup);

metric('letter-spacing and word-spacing reach the text', async () => {
  const widthOf = async (style: string): Promise<number> => {
    const probe = await render(
      `<p id="p" style="margin:0;${style}">ab cd</p>`,
      600,
    );
    const [line] = linesOf(view(probe.node), 'p');
    await probe.result.unmount();
    return line.width;
  };
  const plain = await widthOf('');
  const letters = await widthOf('letter-spacing:10px');
  const words = await widthOf('word-spacing:20px');
  // five characters take ten each, the last included, as browsers set it
  assert.ok(Math.abs(letters - plain - 50) < 1, `letters: ${letters - plain}`);
  assert.ok(
    Math.abs(words - plain - 20) < 1,
    `the one space: ${words - plain}`,
  );
});

metric('a justified paragraph fills every line but its last', async () => {
  // `justify` was set as `start`. Each line is widened at its spaces to
  // fill the box, but not the paragraph's last, nor one a forced break
  // ends (CSS Text 3, 7.4); the ragged copies say what those are unwidened
  const words = 'the quick brown fox jumps over the lazy dog and back again ';
  const { node } = await render(
    '<style>body{margin:0}p{margin:0;width:200px}.j{text-align:justify}' +
      '</style>' +
      `<p id="p" class="j">${words.repeat(3)}</p>` +
      `<p id="ragged">${words.repeat(3)}</p>` +
      `<p id="br" class="j">a b<br>${words}</p>` +
      `<p id="rtl" class="j" dir="rtl">${words.repeat(2)}</p>` +
      `<p id="rtl-ragged" dir="rtl">${words.repeat(2)}</p>`,
  );
  const el = view(node);
  const extents = (id: string) =>
    linesOf(el, id).map((line) => extentOf(line.texts[0]));
  const width = ([from, to]: [number, number]) => to - from;
  const last = <T>(list: T[]) => list[list.length - 1];
  const lines = extents('p');
  const ragged = extents('ragged');
  assert.ok(lines.length > 2, `${lines.length} lines`);
  assert.strictEqual(lines.length, ragged.length, 'broken where it was');
  for (const [from, to] of lines.slice(0, -1)) {
    assert.ok(from < 0.5 && to > 199.5, `a full line: ${from}..${to}`);
  }
  assert.ok(
    Math.abs(width(last(lines)) - width(last(ragged))) < 0.5,
    'not the last',
  );
  const [[, first]] = extents('br');
  assert.ok(first < 50, `not one a break ends: ${first}`);
  const rtl = extents('rtl');
  const rtlRagged = extents('rtl-ragged');
  assert.strictEqual(rtl.length, rtlRagged.length);
  for (const [from, to] of rtl.slice(0, -1)) {
    assert.ok(from < 0.5 && to > 199.5, `right to left: ${from}..${to}`);
  }
  assert.ok(last(rtl)[1] > 199.5, 'whose last line starts at the right');
  assert.ok(Math.abs(width(last(rtl)) - width(last(rtlRagged))) < 0.5);
});

metric('a justified line fills its room however it was made', async () => {
  // Only a paragraph laid out as one text layout was justified (CSS Text 3,
  // 7.4 justifies every line but the last): a line beside a float, the
  // lines past the float's bottom, a line with an inline-block on it and
  // one between an inline box's padding were all set at their start. The
  // Zen Garden's first design has its text beside a float
  const words = 'the quick brown fox jumps over the lazy dog and back again ';
  const { node } = await render(
    '<style>body{margin:0}p{margin:0;width:200px;text-align:justify}' +
      '.f{float:left;width:60px;height:40px}</style>' +
      `<div><div class="f"></div><p id="float">${words.repeat(3)}</p></div>` +
      `<p id="atomic">${words}<span style="display:inline-block;` +
      `width:20px;height:8px"></span> ${words.repeat(2)}</p>` +
      `<p id="padded">${words}<span style="padding:0 6px;` +
      `border-left:2px solid">quick brown</span> ${words.repeat(2)}</p>`,
    400,
  );
  const el = view(node);
  const extentsOf = (id: string) =>
    linesOf(el, id).map((line) => {
      let from = Infinity;
      let to = -Infinity;
      for (const text of line.texts) {
        const [a, b] = extentOf(text);
        from = Math.min(from, a);
        to = Math.max(to, b);
      }
      for (const placed of line.atomics) {
        from = Math.min(from, placed.x);
        to = Math.max(to, placed.x + placed.box.width);
      }
      return [from, to] as [number, number];
    });
  const beside = extentsOf('float');
  assert.ok(beside.length > 3, `${beside.length} lines`);
  for (const [from, to] of beside.slice(0, -1)) {
    // beside the float from its right edge, past it from the box's
    const left = from < 30 ? 0 : 60;
    assert.ok(
      Math.abs(from - left) < 0.5 && to > 199.5,
      `a full line: ${from}..${to}`,
    );
  }
  assert.ok(
    beside.slice(0, -1).some(([from]) => from > 59.5) &&
      beside.slice(0, -1).some(([from]) => from < 0.5),
    'lines beside the float and past it',
  );
  for (const id of ['atomic', 'padded']) {
    const lines = extentsOf(id);
    assert.ok(lines.length > 2, `${id}: ${lines.length} lines`);
    for (const [from, to] of lines.slice(0, -1)) {
      assert.ok(from < 0.5 && to > 199.5, `${id}, a full line: ${from}..${to}`);
    }
  }
  // and an edge is no space: the text after the padding starts at its end
  const edged = linesOf(el, 'padded').find((line) =>
    line.edges?.some((edge) => edge.side === 'start'),
  )!;
  const edge = edged.edges!.find((e) => e.side === 'start')!;
  const next = textRunsOf(edged).find(([from]) => from >= edge.x);
  assert.ok(
    next && Math.abs(next[0] - (edge.x + edge.width)) < 0.5,
    `the text after the edge at ${next?.[0]}, the edge ending at ${edge.x + edge.width}`,
  );
});

metric(
  'text-align-last sets the last line, and each a forced break ends, apart',
  async () => {
    // CSS Text 3, 7.2; it was not read, and every line was set as
    // `text-align` has it. `justify-all` justifies the last line too, and
    // `text-justify: none` justifies nothing
    const words = 'the quick brown fox jumps over the lazy dog and back again ';
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;width:200px}</style>' +
        '<p id="one" style="text-align-last:center">short</p>' +
        `<p id="many" style="text-align-last:right">${words.repeat(2)}</p>` +
        `<p id="br" style="text-align-last:right">a b<br>${words}</p>` +
        `<p id="all" style="text-align:justify-all">${words.repeat(2)}</p>` +
        '<p id="j" style="text-align:justify;text-align-last:center">' +
        `${words.repeat(2)}</p>` +
        '<p id="none" style="text-align:justify;text-justify:none">' +
        `${words.repeat(2)}</p>`,
    );
    const el = view(node);
    const extents = (id: string) =>
      linesOf(el, id).map((line) => extentOf(line.texts[0]));
    const last = <T>(list: T[]) => list[list.length - 1];
    const [[from, to]] = extents('one');
    assert.ok(Math.abs(from - (200 - to)) < 1, `centred: ${from}..${to}`);
    const many = extents('many');
    assert.ok(
      many[0][0] < 0.5 && last(many)[1] > 199.5,
      'the last at the right',
    );
    assert.ok(extents('br')[0][1] > 199.5, 'and one a break ends');
    for (const [a, b] of extents('all')) {
      assert.ok(a < 0.5 && b > 199.5, `justified, the last too: ${a}..${b}`);
    }
    const j = extents('j');
    for (const [a, b] of j.slice(0, -1)) {
      assert.ok(a < 0.5 && b > 199.5, `${a}..${b}`);
    }
    const [ja, jb] = last(j);
    assert.ok(Math.abs(ja - (200 - jb)) < 1, `the last centred: ${ja}..${jb}`);
    assert.ok(
      extents('none').some(([, b]) => b < 199),
      'text-justify: none spaces nothing',
    );
  },
);

metric(
  'a justified line keeps its breaks where a spaced space is wider',
  async () => {
    // an engine measures a space that is a spaced run of its own wider
    // than the same space inside its run — ntk loses the kerning pair it
    // made, CoreText drops the font's pairs for its kerning attribute — so
    // a line justified from a measure of its spaces as they were no longer
    // fit, and broke a word early, short of the edge
    const words = 'The quick brown fox jumps over the lazy dog, and back. ';
    const { result, node } = await render(
      '<style>body{margin:0}p{margin:0;width:200px;text-align:justify}</style>' +
        `<p id="p">${words.repeat(3)}</p>`,
    );
    const el = view(node);
    const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
    const kerning: FontsLike = {
      layout: (runs, style, options) =>
        fonts.layout(
          runs.map((run) =>
            run.letterSpacing && (run.text === ' ' || run.text === '\u00a0')
              ? { ...run, letterSpacing: run.letterSpacing + 0.4 }
              : run,
          ),
          style,
          options,
        ),
      match: (...args) => fonts.match(...args),
    };
    const { layoutDocument } = await import('../../src/html/layout/block.js');
    const tree = (el as unknown as { _tree: unknown })._tree;
    layoutDocument(tree as never, kerning, 400, 600);
    const lines = linesOf(el, 'p').map((line) => extentOf(line.texts[0]));
    assert.ok(lines.length > 2, `${lines.length} lines`);
    for (const [from, to] of lines.slice(0, -1)) {
      assert.ok(from < 0.5 && to > 199.5, `a full line: ${from}..${to}`);
    }
  },
);

metric('text that does not wrap is aligned in its box', async () => {
  // the engine aligns lines it is given no width for within the widest of
  // them, which for one line is no alignment at all: a centred `<td
  // nowrap>` or `white-space: nowrap` label was set flush left
  const long = 'a line too long for its box';
  const { node } = await render(
    '<style>body{margin:0}div{width:300px}td{padding:0}</style>' +
      '<div id="c" style="white-space:nowrap;text-align:center">centred</div>' +
      '<div id="r" style="white-space:nowrap;text-align:right">right</div>' +
      '<div id="rtl" dir="rtl" style="white-space:nowrap">start</div>' +
      '<div id="pre" style="white-space:pre;text-align:center">one\n' +
      'a longer line</div>' +
      '<table width="300" style="border-spacing:0"><tr>' +
      '<td id="td" nowrap align="center">cell</td></tr></table>' +
      '<div id="sp" style="white-space:nowrap;text-align:center">' +
      '<span style="padding:0 10px;background:#eee">boxed</span></div>' +
      `<div id="over" dir="rtl" style="white-space:nowrap;width:50px">${long}</div>` +
      '<div id="wide" style="white-space:nowrap;width:50px;text-align:center">' +
      `${long}</div>`,
  );
  const el = view(node);
  const extents = (id: string) =>
    linesOf(el, id).map((line) => extentOf(line.texts[0]));
  const centred = ([from, to]: [number, number], label: string) =>
    assert.ok(Math.abs(from + to - 300) < 0.5, `${label}: ${from}..${to}`);
  centred(extents('c')[0], 'centred');
  assert.ok(Math.abs(extents('r')[0][1] - 300) < 0.5, 'right');
  assert.ok(Math.abs(extents('rtl')[0][1] - 300) < 0.5, 'right-to-left');
  const pre = extents('pre');
  assert.strictEqual(pre.length, 2);
  pre.forEach((extent, i) => centred(extent, `pre line ${i}`));
  centred(extents('td')[0], 'a centred cell');
  // an inline box's edges go with the line they are on
  const [boxed] = linesOf(el, 'sp');
  assert.ok(Math.abs(2 * boxed.x + boxed.width - 300) < 0.5, 'with edges');
  assert.ok(
    Math.abs(boxed.edges![0].x - boxed.x) < 0.5,
    `the start edge at the line's start: ${boxed.edges![0].x}`,
  );
  // a line too long for its box is set at its start, overflowing its end
  const [[overFrom, overTo]] = extents('over');
  assert.ok(Math.abs(overTo - 50) < 0.5 && overFrom < 0, 'left, in rtl');
  assert.ok(Math.abs(extents('wide')[0][0]) < 0.5, 'right, centred');
});

test('an underline reaches the text of what is inside, in its own colour', async () => {
  // CSS 2.1 16.3.1: a decoration is propagated to an element's in-flow
  // descendants, drawn in the colour of the element that set it, so an
  // underlined link's <strong> is underlined; not to a float, an absolute
  // box or the inside of an inline block; and `none` takes none away
  const { node } = await render(
    '<a href="#" style="color:#0000ff"><strong id="s">x</strong></a>' +
      '<div style="text-decoration:underline;color:#ff0000">' +
      '<p id="p" style="color:#0000ff">y<span id="f" style="float:left">z</span>' +
      '<span id="i" style="display:inline-block">w</span>' +
      '<span id="n" style="text-decoration:none">v</span></p></div>' +
      '<u><s id="both">u</s></u>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { underline: string | null; lineThrough: string | null };
      }
    ).style;
  assert.strictEqual(style('s').underline, '#0000ff', "the link's colour");
  assert.strictEqual(style('p').underline, '#ff0000', "the div's colour");
  assert.strictEqual(style('n').underline, '#ff0000', '`none` removes none');
  assert.strictEqual(style('f').underline, null, 'not a float');
  assert.strictEqual(style('i').underline, null, 'nor an inline block');
  assert.ok(style('both').underline && style('both').lineThrough, 'both');
});

metric(
  "a link's underline goes on under the space it ends on, and not where its line ends there",
  async () => {
    // the space white space collapses to is the first, in the element it
    // was written in (CSS Text 3, 4.1.1), and a decoration is drawn under
    // all of an element's text: a link written `text </a>` before another
    // is underlined to the next one. The text engine lays a piece of a line
    // out as a line and strips the space, and the underline stopped at the
    // last letter — the Zen Garden's 066, its resource links a space apart
    // and underlined to their letters. A space a line ends on is removed
    // (4.1.2), and is nobody's to underline
    const { node } = await render(
      '<style>body{margin:0;font-size:16px}p{margin:0;width:300px}' +
        'a{padding-left:10px}#a1{color:#ff0000}#a2{color:#0000ff}' +
        '#a3{color:#00ff00}#a5{color:#ff00ff}</style>' +
        '<p><a id="a1" href="#">one </a><a id="a2" href="#">two</a> ' +
        '<a id="a3" href="#">three </a> ' +
        '<a href="#">awordtoolongtofitwhatisleftofthefirstline</a> ' +
        '<a id="a5" href="#">three</a></p>',
      320,
    );
    const el = view(node);
    await act();
    const fills = await fillsOf(el);
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    /** Where the underline drawn in a colour ends. */
    const ruled = (color: string): number => {
      const ink = parseColor(color);
      const rules = fills.filter((f) => f.style === ink && f.h <= 2);
      assert.ok(rules.length > 0, `an underline in ${color}`);
      return Math.max(...rules.map((f) => f.x + f.w));
    };
    const two = rect('a2');
    assert.ok(
      Math.abs(ruled('#ff0000') - two.x) < 1.5,
      `under its space, to the next link: ${ruled('#ff0000')} of ${two.x}`,
    );
    const three = rect('a3');
    assert.ok(rect('a5').y > three.y, 'the third link ends the first line');
    assert.ok(
      Math.abs(ruled('#00ff00') - (three.x + three.width)) < 1.5,
      `to its letters where its line ends: ${ruled('#00ff00')} of ${three.x + three.width}`,
    );
    assert.ok(
      Math.abs(three.width - rect('a5').width) < 0.01,
      'which are as wide as the word alone',
    );
  },
);

test('text-decoration with a word it does not know is ignored, and draws every line it names', async () => {
  // CSS 2.1 4.2: the whole declaration goes, not the words after it
  const { node } = await render(
    '<p id="a" style="text-decoration: underline line-through diagonal">a</p>' +
      '<p id="b" style="text-decoration: underline line-through">b</p>',
  );
  const el = view(node);
  const styleOf = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { underline: string | null; lineThrough: string | null };
      }
    ).style;
  assert.strictEqual(styleOf('a').underline, null);
  assert.strictEqual(styleOf('a').lineThrough, null);
  assert.ok(styleOf('b').underline && styleOf('b').lineThrough, 'both lines');
});
metric(
  'an underline sits at its offset, as thick as its thickness',
  async () => {
    // `text-underline-offset` and `text-decoration-thickness` were dropped:
    // every underline sat two pixels under the baseline, a pixel thick —
    // shadcn's links set theirs four pixels down
    const { node } = await render(
      '<style>body{margin:0;font:20px sans-serif}p{margin:0}' +
        'a{text-decoration:underline #ff0000}</style>' +
        '<p id="a"><a>plain</a></p>' +
        '<p id="b"><a style="text-underline-offset:6px;' +
        'text-decoration-thickness:3px">offset</a></p>' +
        '<p id="c"><a style="text-decoration:underline #00ff00 4px">short</a>' +
        '</p>',
    );
    const el = view(node);
    const fills = await fillsOf(el);
    const baseline = (id: string) => {
      const [line] = linesOf(el, id) as unknown as {
        y: number;
        baseline: number;
      }[];
      return line.y + line.baseline;
    };
    const rule = (color: string, id: string) => {
      const b = baseline(id);
      return fills.find(
        (f) => f.style === color && f.y > b - 1 && f.y < b + 12,
      );
    };
    const plain = rule('#ff0000', 'a')!;
    assert.deepStrictEqual(
      [Math.round(plain.y - baseline('a')), plain.h],
      [1, 2],
      'the 20px text its own: two thick, one below',
    );
    const offset = rule('#ff0000', 'b')!;
    assert.deepStrictEqual(
      [Math.round(offset.y - baseline('b')), offset.h],
      [6, 3],
    );
    assert.strictEqual(rule('#00ff00', 'c')!.h, 4, 'the shorthand thickness');
  },
);

metric(
  "an underline is as thick as its box's font size makes it, and as clear of the baseline",
  async () => {
    // `text-decoration-thickness: auto` and `text-underline-offset: auto`
    // are the user agent's to choose (CSS Text Decoration 4, 2.4 and 2.8),
    // and every underline was a pixel thick two pixels down, a caption's
    // and a title's alike: the dots under the `<abbr>` of Zen Garden 217's
    // 140px title were a hairline of them. A tenth of the font size, half
    // of that under the baseline — and the size is the box's that set the
    // line, which draws one line through all that is in it (2.9).
    const { node } = await render(
      '<style>body{margin:0;font:16px sans-serif}p{margin:0}' +
        'u{text-decoration-color:#ff0000}</style>' +
        '<p id="a"><u>sixteen</u></p>' +
        '<p id="b" style="font-size:40px"><u>forty ' +
        '<small style="font-size:10px">ten</small></u></p>' +
        '<p id="c" style="font-size:9px"><u>nine</u></p>',
      600,
    );
    const el = view(node);
    const fills = await fillsOf(el);
    const rules = (id: string) => {
      const [line] = linesOf(el, id);
      const b = line.y + line.baseline;
      return fills
        .filter((f) => f.style === '#ff0000' && f.y > b - 1 && f.y < b + 8)
        .map((f) => [Math.round(f.y - b), f.h]);
    };
    assert.deepStrictEqual(rules('a'), [[1, 1]], '1.6 is a pixel, one below');
    // the small text's is the 40px box's line: as thick, and as far down
    const forty = rules('b');
    assert.ok(forty.length >= 1, 'the underline is drawn');
    for (const rule of forty) assert.deepStrictEqual(rule, [2, 4]);
    assert.deepStrictEqual(rules('c'), [[1, 1]], 'never under a pixel');
  },
);

metric(
  'a dotted underline is round dots from end to end once it is thick, and squares while it is thin',
  async () => {
    // HTML's `abbr[title]` in a title and in a paragraph. Blink draws a
    // dotted line over three pixels thick as dots with round caps, the
    // first at its start and the last at its end, and a thinner one as
    // squares a thickness apart, the nearest whole pixel wide: 1.6 is two
    const { node } = await render(
      '<style>body{margin:0;font:16px sans-serif}p{margin:0}' +
        'abbr{text-decoration-color:#00ff00}</style>' +
        '<p id="a" style="font-size:140px"><abbr title="t">CSS</abbr></p>' +
        '<p id="b"><abbr title="t">CSS</abbr> and more</p>',
      600,
    );
    const el = view(node);
    const fills = await fillsOf(el);
    const dots = (id: string) => {
      const [line] = linesOf(el, id);
      const b = line.y + line.baseline;
      return {
        extent: extentOf(line.texts[0]),
        dots: fills
          .filter((f) => f.style === '#00ff00' && f.y > b - 2 && f.y < b + 30)
          // `+ 0`: a rule on the baseline is at 0, not the -0 it rounds to
          .map((f) => ({ ...f, y: Math.round(f.y - b) + 0 })),
      };
    };
    const title = dots('a');
    assert.ok(title.dots.length > 3, `dots: ${title.dots.length}`);
    for (const dot of title.dots) {
      assert.deepStrictEqual(
        [dot.y, dot.w, dot.h, dot.radii],
        [7, 14, 14, [7]],
        'a 14px dot, 7 under the baseline',
      );
    }
    const first = title.dots[0];
    const last = title.dots[title.dots.length - 1];
    const gap = title.dots[1].x - first.x - 14;
    assert.ok(Math.abs(gap - 14) < 7, `a gap near a dot's width: ${gap}`);
    title.dots.forEach((dot, i) => {
      assert.ok(
        Math.abs(dot.x - first.x - i * (14 + gap)) < 0.01,
        'evenly spread',
      );
    });
    // the text here is the `<abbr>`'s alone: its rule is as long
    const [from, to] = title.extent;
    assert.ok(Math.abs(first.x - from) <= 1, `from its start: ${first.x}`);
    assert.ok(Math.abs(last.x + 14 - to) <= 1, `to its end: ${last.x + 14}`);

    const body = dots('b');
    assert.ok(body.dots.length > 3, `squares: ${body.dots.length}`);
    for (const dot of body.dots.slice(0, -1)) {
      assert.deepStrictEqual(
        [dot.y, dot.w, dot.h, dot.radii],
        [0, 2, 2, null],
        'a 2px square on the baseline',
      );
    }
    assert.strictEqual(body.dots[1].x - body.dots[0].x, 4, 'two apart');
  },
);

metric(
  'text-transform: capitalize takes the first letter of each word',
  async () => {
    // CSS Text 3, 2.1: punctuation a word starts with is not its first
    // letter, and a word runs on across an element's edge
    const { node } = await render(
      '<p style="text-transform:capitalize">(p.p.) <b>fo</b>o ' +
        "well-known don't x.y 3rd éa a&#xA0;b ǆa ᾀa ßa</p>",
    );
    const text = view(node).textContent();
    // in title case, which is not upper case for a letter that is two
    assert.ok(
      text.includes(
        "(P.p.) Foo Well-Known Don't X.y 3rd Éa A\u00a0B ǅa ᾈa Ssa",
      ),
      JSON.stringify(text),
    );
  },
);

metric(
  "a nowrap element's words stay together, and it may break after its end",
  async () => {
    const { node } = await render(
      '<style>p{margin:0;font:10px monospace}</style>' +
        '<p id="a" style="width:50px">xx <span style="white-space:nowrap">aaa bbb</span> ccc</p>' +
        '<p id="b" style="width:0"><span style="white-space:nowrap">AA </span> BB</p>',
    );
    const el = view(node);
    const a = lineTextsOf(el, 'a');
    assert.ok(
      a.some((line) => line.includes('aaa bbb')),
      `aaa and bbb on one line: ${JSON.stringify(a)}`,
    );
    // the space the element ends on is its block's to break after
    assert.deepStrictEqual(
      lineTextsOf(el, 'b').map((line) => line.trim()),
      ['AA', 'BB'],
    );
  },
);

metric(
  'a word too long for its line runs past it unless the style cuts it',
  async () => {
    // CSS Text 3, 5.5: `overflow-wrap: normal`, the initial value, lets a
    // word wider than its line run past the line's end, as a browser does;
    // `break-word` or `anywhere`, `word-break: break-all` or `break-word`
    // whatever `overflow-wrap` says, cut it. Every such word was cut.
    const word = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
    const { node } = await render(
      '<style>body{margin:0} p{margin:0;width:100px}</style>' +
        `<p id="a">${word}</p>` +
        `<p id="b" style="overflow-wrap:break-word">${word}</p>` +
        `<p id="c" style="word-break:break-word;overflow-wrap:normal">${word}</p>` +
        `<div style="word-break:break-all"><p id="d">${word}</p></div>` +
        // the engine cuts a paragraph's words or none, so a span that asks
        // for it has them cut
        `<p id="e">a <span style="overflow-wrap:anywhere">${word}</span></p>`,
    );
    const el = view(node);
    const a = linesOf(el, 'a');
    assert.strictEqual(a.length, 1, 'whole');
    assert.ok(a[0].width > 100, `past the line's end: ${a[0].width}`);
    for (const id of ['b', 'c', 'd', 'e']) {
      const lines = linesOf(el, id);
      assert.ok(lines.length > 1, `${id}: cut`);
      assert.ok(
        lines.every((line) => line.width <= 100.5),
        `${id}: within the line`,
      );
    }
  },
);

metric(
  'a space that collapses between two nowrap elements is a break',
  async () => {
    // CSS Text 3, 4.1.1: a space after another collapses away and keeps its
    // chance to wrap where its own element wraps, so the lines break between
    // the elements. They ran on as one word, cut where the line ran out.
    const spans = Array.from(
      { length: 8 },
      (_, i) => `<span style="white-space:nowrap">w${i} </span>`,
    );
    const { node } = await render(
      '<style>p{margin:0;font:10px monospace}</style>' +
        `<p id="a" style="width:100px">${spans.join(' ')}</p>`,
    );
    const lines = lineTextsOf(view(node), 'a').map((line) => line.trim());
    assert.ok(lines.length > 1, JSON.stringify(lines));
    for (const line of lines) {
      assert.match(line, /^w\d(\sw\d)*$/, JSON.stringify(lines));
    }
  },
);

metric('a nowrap element does not break at its hyphens', async () => {
  // CSS Text 3, 5.1: no break inside an element that does not wrap, at a
  // space or anywhere else. Its spaces were held; a hyphen was still a
  // place to break, and `whitespace-nowrap` on "state-of-the-art" broke
  // inside it.
  const { node } = await render(
    '<style>p{margin:0;font:10px monospace;width:100px}</style>' +
      '<p id="a">a <span style="white-space:nowrap">state-of-the-art</span> ' +
      'design</p>',
  );
  // whole on a line of its own: the line before cannot take it
  const a = lineTextsOf(view(node), 'a').map((line) => line.trim());
  assert.deepStrictEqual(a.slice(0, 2), ['a', 'state-of-the-art'], `${a}`);
});

metric('a kept tab goes to its stop', async () => {
  // a tab was a space wide in ntk and at CoreText's own stops, 28 points
  // apart: code indented with tabs, and columns a tab apart, did not line
  // up. A stop is every `tab-size` spaces from the line's start, and one
  // less than half a `ch` on is passed over (CSS Text 3, 4.2)
  const { node } = await render(
    '<style>body{margin:0}pre,div{margin:0;font:10px monospace}</style>' +
      '<pre id="a">\tA\n\t\tB\nab\tC\nabcdefghij\tD</pre>' +
      '<pre style="tab-size:4">four\n\tE\nab\tF</pre>' +
      '<pre style="-moz-tab-size:20px">px\nxxx\tG</pre>' +
      '<div style="white-space:pre-wrap">wrap\nab\tH</div>',
  );
  const el = view(node);
  const text = el.textContent();
  assert.ok(text.includes('\t\tB'), 'the document keeps its tabs');
  // from the start of the letter's own line, which is given
  const x = (letter: string, line: string) =>
    el.textCaretRect(text.indexOf(letter))!.x -
    el.textCaretRect(text.indexOf(line))!.x;
  const ch = x('D', 'abcdefghij') / 16;
  const at = (letter: string, line: string, chars: number) =>
    assert.ok(
      Math.abs(x(letter, line) - chars * ch) < 0.5,
      `${letter} at ${x(letter, line) / ch} characters, not ${chars}`,
    );
  at('A', '\tA', 8);
  at('B', '\t\tB', 16);
  at('C', 'ab\tC', 8);
  at('E', '\tE', 4);
  at('F', 'ab\tF', 4);
  at('H', 'ab\tH', 8);
  // three letters are less than half a character short of 20px, so the
  // tab goes on to 40
  assert.ok(20 - 3 * ch < ch / 2, `the case the rule is for, at ${ch}px`);
  const g = x('G', 'xxx');
  assert.ok(Math.abs(g - 40) < 0.5, `G at ${g}px`);
});

metric('a tab is set from where the room before it ends', async () => {
  // the edges of an inline box and the spacing of a word before a tab
  // move it: its stop is counted from where it is drawn, with them
  const { node, result } = await render(
    '<style>body{margin:0}pre{margin:0;padding:0;font:10px monospace}' +
      '.w{word-spacing:13px}</style>' +
      '<pre id="p">one\na<span style="padding-left:13px">b</span>\tX\n' +
      'a<span class="w"> </span>b\tY\nabcdefghij</pre>',
  );
  const el = view(node);
  const text = el.textContent();
  const x = (index: number) => el.textCaretRect(index)!.x;
  const left = x(text.indexOf('abcdefghij'));
  const ch = (x(text.indexOf('abcdefghij') + 10) - left) / 10;
  const stop = (from: number) => {
    let at = (Math.floor(from / (8 * ch)) + 1) * 8 * ch;
    if (at - from < ch / 2) at += 8 * ch;
    return at;
  };
  const expect = (letter: string, from: number) => {
    const got = x(text.indexOf(letter)) - left;
    assert.ok(
      Math.abs(got - stop(from)) < 0.5,
      `${letter} at ${got}, not ${stop(from)}`,
    );
  };
  expect('X', 2 * ch + 13);
  expect('Y', 3 * ch + 13);
  // and from the runs the engine drew, not from its carets: CoreText sets
  // a caret after a spaced glyph part of the way into its spacing. An
  // engine whose carets are all astray draws the same runs
  type Runs = { lines: { x: number; runs: { x: number; start: number }[] }[] };
  const drawn = () =>
    linesOf(el, 'p').flatMap((line) =>
      line.texts.flatMap((placed) => {
        const natural = (placed.layout as unknown as Runs).lines[
          placed.layoutLine
        ];
        return natural.runs.map(
          (run) =>
            `${run.start}@${(placed.drawX + natural.x + run.x).toFixed(2)}`,
        );
      }),
    );
  const before = drawn();
  const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
  const astray: FontsLike = {
    layout: (...args) => {
      const layout = fonts.layout(...args);
      const caretPosition = layout.caretPosition.bind(layout);
      layout.caretPosition = (index: number) => ({
        ...caretPosition(index),
        x: caretPosition(index).x + 1000,
      });
      return layout;
    },
    match: (...args) => fonts.match(...args),
  };
  const { layoutDocument } = await import('../../src/html/layout/block.js');
  const tree = (el as unknown as { _tree: unknown })._tree;
  layoutDocument(tree as never, astray, 400, 600);
  assert.deepStrictEqual(drawn(), before);
});

test('text-shadow is read, inherited, and has no spread and no inset', async () => {
  const { node } = await render(
    '<div id="a" style="text-shadow:1px 2px 3px red, blue 4px 5px">' +
      '<p id="b">b</p></div>' +
      '<p id="c" style="text-shadow:1px 2px 3px 4px red">c</p>' +
      '<p id="d" style="text-shadow:inset 1px 2px red">d</p>' +
      '<p id="e" style="text-shadow:1px 1px red;text-shadow:none">e</p>',
  );
  const el = view(node);
  const shadows = (id: string) =>
    (boxOf(el, id) as unknown as { style: { textShadow: unknown } }).style
      .textShadow;
  const red = parseColor('red');
  const blue = parseColor('blue');
  assert.deepStrictEqual(shadows('a'), [
    { x: 1, y: 2, blur: 3, spread: 0, color: red, inset: false },
    { x: 4, y: 5, blur: 0, spread: 0, color: blue, inset: false },
  ]);
  assert.strictEqual(shadows('b'), shadows('a'), 'inherited');
  assert.strictEqual(shadows('c'), null, 'a spread is no text shadow');
  assert.strictEqual(shadows('d'), null, 'nor is inset');
  assert.strictEqual(shadows('e'), null);
});

metric('text casts its shadows under it, the last first', async () => {
  // it cast none. Each is the layout drawn clear of the window with its
  // shadow offset back, so that only the shadow lands; a hard one is
  // blurred too little to see, as CoreGraphics casts none without a blur
  const { node } = await render(
    '<style>body{margin:0}p{margin:0;font-size:20px}</style>' +
      '<p id="h" style="text-shadow:1px 2px 3px #ff0000, 4px 5px 0 #0000ff">' +
      'Title</p><p id="p">plain</p>' +
      '<p style="text-shadow:0 1px #00ff00">Title</p>' +
      '<p id="m">plain <span id="s" style="text-shadow:0 0 2px #ff0000">' +
      'lit</span> plain</p>',
  );
  const el = view(node);
  const ops: PaintOp[] = [];
  await fillsOf(el, ops);
  const texts = ops.filter(
    (op): op is Extract<PaintOp, { op: 'text' }> => op.op === 'text',
  );
  const [line] = linesOf(el, 'h');
  const at = line.texts[0].drawX;
  const [blue, red, title] = texts;
  assert.ok(blue.shadow && red.shadow && !title.shadow, 'two, then the text');
  assert.strictEqual(title.x, at);
  assert.deepStrictEqual(
    [blue.shadow!.color, blue.x + blue.shadow!.x, blue.shadow!.y],
    ['#0000ff', at + 4, 5],
    'the last, and so the lowest, where it falls',
  );
  assert.ok(blue.shadow!.blur > 0 && blue.shadow!.blur < 0.1, 'hard');
  assert.deepStrictEqual(
    [red.shadow!.color, red.x + red.shadow!.x, red.shadow!.blur],
    ['#ff0000', at + 1, 3],
  );
  assert.ok(red.x + line.width < 0, 'the glyphs clear of the window');
  // a paragraph that casts none draws once, and one whose span casts a
  // shadow draws it clipped to the span
  const plain = texts.filter((op) => !op.shadow);
  assert.strictEqual(plain.length, 4, 'each paragraph once');
  // a paragraph of the same runs shares the first's layout, and casts its
  // own shadow, not the first's
  assert.ok(
    texts.some((op) => op.shadow?.color === '#00ff00'),
    "the second's own",
  );
  // the span's shadow, which alone has a blur of 2
  const shadowed = ops.findIndex(
    (op) => op.op === 'text' && op.shadow?.blur === 2,
  );
  const clip = ops[shadowed - 1];
  assert.ok(clip?.op === 'clip', 'the span clipped');
  const text = el.textContent();
  const from = el.textCaretRect(text.indexOf('lit'))!.x;
  const to = el.textCaretRect(text.indexOf('lit') + 3)!.x;
  assert.ok(
    clip.x <= from && clip.x + clip.w >= to && clip.w < to - from + 20,
    `to the span and its blur: ${clip.x}..${clip.x + clip.w}, ${from}..${to}`,
  );
});

test('tab-size is a number of spaces, or a length', async () => {
  const { node } = await render(
    '<pre id="a" style="tab-size:4">a</pre>' +
      '<pre id="b" style="tab-size:2em;font-size:10px">b</pre>' +
      '<pre id="c" style="-moz-tab-size:3">c</pre>' +
      '<pre id="d" style="tab-size:-1">d</pre>' +
      '<div style="tab-size:5"><pre id="e">e</pre></div>',
  );
  const el = view(node);
  const tab = (id: string) => {
    const { tabSize, tabSizeIsLength } = (
      boxOf(el, id) as unknown as {
        style: { tabSize: number; tabSizeIsLength: boolean };
      }
    ).style;
    return [tabSize, tabSizeIsLength];
  };
  assert.deepStrictEqual(tab('a'), [4, false]);
  assert.deepStrictEqual(tab('b'), [20, true]);
  assert.deepStrictEqual(tab('c'), [3, false]);
  assert.deepStrictEqual(tab('d'), [8, false], 'none below nought');
  assert.deepStrictEqual(tab('e'), [5, false], 'inherited');
});

metric("pre's trailing spaces take room, where a line's hang", async () => {
  const widthOf = async (text: string) => {
    const { node } = await render(
      '<style>div{display:inline-block;font:10px monospace}</style>' +
        `<div id="d"><span style="white-space:pre">${text}</span></div>`,
    );
    const width = boxOf(view(node), 'd').width;
    cleanup();
    return width;
  };
  const bare = await widthOf('ab');
  const spaced = await widthOf('ab  ');
  assert.ok(spaced > bare * 1.8, `${spaced} against ${bare}`);
});

metric(
  "pre-wrap's spaces before a forced break take room where they fit",
  async () => {
    // They hang there only where they do not fit (CSS Text 3, 4.1.3), and an
    // engine strips every space a line ends on: an inline-block holding
    // `ab  ` was as wide as `ab`, and a right-aligned line set `ab` flush
    // against the edge the spaces should have kept it off
    const { node } = await render(
      '<style>body{margin:0;font:10px monospace}p{margin:0;width:200px;' +
        'white-space:pre-wrap}.i{display:inline-block}</style>' +
        '<div class="i" id="bare"><span style="white-space:pre-wrap">ab</span></div><br>' +
        '<div class="i" id="end"><span style="white-space:pre-wrap">ab  </span></div><br>' +
        '<div class="i" id="nl" style="white-space:pre-wrap">ab  \ncd</div>' +
        '<p style="text-align:right"><span id="r">ab  </span></p>' +
        '<p style="text-align:center"><span id="c">ab  </span></p>' +
        '<p dir="rtl"><span id="rtl">ab  </span></p>' +
        // a line a piece at a time, an image on it
        '<p style="text-align:right"><img style="display:inline-block;' +
        'width:10px;height:10px">x<span id="p">ab  </span></p>',
    );
    const el = view(node);
    await act();
    const char = boxOf(el, 'bare').width / 2;
    const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
    for (const id of ['end', 'nl']) {
      const width = boxOf(el, id).width;
      assert.ok(near(width, 4 * char), `#${id}: ${width} for ${char}`);
    }
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    for (const [id, x] of [
      ['r', 200 - 4 * char],
      ['c', 100 - 2 * char],
      ['rtl', 200 - 4 * char],
      ['p', 200 - 4 * char],
    ] as const) {
      const { x: at, width } = rect(id);
      assert.ok(
        near(at, x) && near(width, 4 * char),
        `#${id} across its spaces: ${at}, ${width} for ${x}, ${4 * char}`,
      );
    }
  },
);

metric(
  "pre-wrap's spaces at a soft wrap hang, and are their box's",
  async () => {
    // At a soft wrap they take no room, so the line aligns without them, and
    // they are drawn past its end all the same, in their box: its rect and
    // its background cover them, as a browser's do
    const { result, node } = await render(
      '<style>body{margin:0;font:20px monospace}p{margin:0;width:84px;' +
        'white-space:pre-wrap}span{background:#0000ff}</style>' +
        '<p id="l"><span id="s">abc    def</span></p>' +
        '<p id="rp" style="text-align:right"><span id="rs">abc    def</span></p>' +
        '<p dir="rtl"><span id="t">abc    def</span></p>' +
        // a single space before the end, as WPT's white-space-processing-047
        '<div style="white-space:normal"> <span id="one" ' +
        'style="white-space:pre-wrap"> </span> </div>',
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const char = rect('s').width / 7;
    const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
    assert.ok(near(linesOf(el, 'l')[0].width, 3 * char), 'the line is `abc`');
    const right = rect('rs');
    assert.ok(
      near(right.x, 84 - 3 * char) && near(right.width, 7 * char),
      `aligned without its spaces, which run past: ${JSON.stringify(right)}`,
    );
    const rtl = rect('t');
    assert.ok(
      near(rtl.x, 84 - 7 * char) && near(rtl.width, 7 * char),
      `past the left, where the line reads right to left: ${JSON.stringify(rtl)}`,
    );
    const one = rect('one');
    assert.ok(near(one.width, char), `one space wide: ${JSON.stringify(one)}`);
    const at = (node as unknown as { abs: { x: number; y: number } }).abs;
    await waitFor(async () => {
      const [r, g, b] = await pixelAt(
        result.ctx,
        Math.round(at.x + one.x + one.width / 2),
        Math.round(at.y + one.y + one.height / 2),
      );
      assert.ok(b > 200 && r < 60 && g < 60, `its background: ${r},${g},${b}`);
    });
  },
);

test('text-wrap and white-space-collapse change their halves of white-space', async () => {
  const { node } = await render(
    '<div id="a" style="text-wrap:nowrap"></div>' +
      '<div id="b" style="white-space:pre;text-wrap:wrap"></div>' +
      '<div id="c" style="white-space:nowrap;text-wrap:balance"></div>' +
      '<div id="d" style="white-space:nowrap;text-wrap-style:balance"></div>' +
      '<div id="e" style="white-space:pre-wrap;text-wrap-mode:nowrap"></div>' +
      '<div id="f" style="white-space-collapse:preserve"></div>' +
      '<div id="g" style="white-space:pre;white-space-collapse:collapse"></div>' +
      '<div id="h" style="white-space:break-spaces"></div>' +
      '<div id="i" style="text-wrap:nowrap;text-wrap:nowrap wrap"></div>' +
      '<div style="text-wrap:balance"><p id="j"></p></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { whiteSpace: string; textWrapStyle: string };
      }
    ).style;
  const seen = (id: string) => [style(id).whiteSpace, style(id).textWrapStyle];
  assert.deepStrictEqual(
    seen('a'),
    ['nowrap', 'auto'],
    "Tailwind 4's text-nowrap",
  );
  assert.deepStrictEqual(seen('b'), ['pre-wrap', 'auto']);
  assert.deepStrictEqual(
    seen('c'),
    ['normal', 'balance'],
    'the shorthand wraps',
  );
  assert.deepStrictEqual(
    seen('d'),
    ['nowrap', 'balance'],
    'the longhand does not',
  );
  assert.deepStrictEqual(seen('e'), ['pre', 'auto']);
  assert.deepStrictEqual(seen('f'), ['pre-wrap', 'auto']);
  assert.deepStrictEqual(seen('g'), ['nowrap', 'auto']);
  assert.deepStrictEqual(seen('h'), ['pre-wrap', 'auto']);
  assert.deepStrictEqual(seen('i'), ['nowrap', 'auto'], 'two modes is none');
  assert.deepStrictEqual(seen('j'), ['normal', 'balance'], 'inherited');
});

metric(
  'text-wrap: balance evens a heading out and sets it in the whole width',
  async () => {
    // dropped, and a heading ended on a word of its own
    const heading =
      'Build desktop interfaces in React and ship them to every platform today';
    const { node } = await render(
      '<style>body{margin:0}h2{width:360px;font-size:24px;margin:0}</style>' +
        `<h2 id="ragged">${heading}</h2>` +
        `<h2 id="even" style="text-wrap:balance">${heading}</h2>` +
        `<h2 id="centred" style="text-wrap:balance;text-align:center">${heading}</h2>`,
    );
    const el = view(node);
    const lines = (id: string) =>
      (boxOf(el, id) as unknown as { lines: { x: number; width: number }[] })
        .lines;
    const ragged = lines('ragged');
    const even = lines('even');
    assert.strictEqual(even.length, ragged.length, 'as many lines');
    const spread = (ls: { width: number }[]) =>
      Math.max(...ls.map((l) => l.width)) - Math.min(...ls.map((l) => l.width));
    assert.ok(
      spread(even) < spread(ragged) / 2,
      `${spread(even)} against ${spread(ragged)}`,
    );
    assert.ok(Math.max(...even.map((l) => l.width)) < 360);
    for (const line of lines('centred')) {
      assert.ok(
        Math.abs(line.x - (360 - line.width) / 2) < 1,
        `centred in the whole width: ${line.x}, ${line.width}`,
      );
    }
  },
);

metric('a paragraph of more than six lines is not balanced', async () => {
  const text = 'Some words of a paragraph that runs on. '.repeat(8);
  const { node } = await render(
    '<style>body{margin:0}p{width:200px;margin:0}</style>' +
      `<p id="a">${text}</p><p id="b" style="text-wrap:balance">${text}</p>`,
  );
  const el = view(node);
  const widths = (id: string) =>
    (boxOf(el, id) as unknown as { lines: { width: number }[] }).lines.map(
      (l) => l.width,
    );
  assert.ok(widths('a').length > 6);
  assert.deepStrictEqual(widths('b'), widths('a'));
});

test('line-clamp and text-overflow are read', async () => {
  const box = 'display:-webkit-box;-webkit-box-orient:vertical;';
  const { node } = await render(
    `<p id="a" style="${box}-webkit-line-clamp:2">a</p>` +
      '<p id="b" style="line-clamp:3;line-clamp:none">b</p>' +
      `<p id="c" style="${box}-webkit-line-clamp:2;-webkit-line-clamp:0">c</p>` +
      '<p id="d" style="text-overflow:ellipsis">d</p>' +
      '<p id="e" style="text-overflow:clip ellipsis">e</p>' +
      '<p id="f" style="text-overflow:ellipsis;text-overflow:fade">f</p>' +
      // `-webkit-line-clamp` clamps a vertical `-webkit-box` only, as it
      // does in a browser, and `line-clamp` a block container
      '<p id="g" style="-webkit-line-clamp:2">g</p>' +
      '<p id="h" style="display:-webkit-box;-webkit-line-clamp:2">h</p>' +
      '<p id="i" style="line-clamp:3">i</p>' +
      '<p id="j" style="line-clamp:auto">j</p>' +
      '<p id="k" style="display:flex;line-clamp:3">k</p>' +
      '<p id="l" style="line-clamp:3;columns:2">l</p>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: {
          lineClamp: number | null;
          textOverflow: string;
          display: string;
          flowRoot: boolean;
          flexDirection: string;
        };
      }
    ).style;
  assert.strictEqual(style('a').lineClamp, 2);
  // a block of a formatting context of its own
  assert.strictEqual(style('a').display, 'block');
  assert.strictEqual(style('a').flowRoot, true);
  assert.strictEqual(style('b').lineClamp, null);
  // nought is no clamp, and the one before stands
  assert.strictEqual(style('c').lineClamp, 2);
  assert.strictEqual(style('g').lineClamp, null);
  // a `-webkit-box` that does not clamp vertically is a flex row
  assert.strictEqual(style('h').lineClamp, null);
  assert.strictEqual(style('h').display, 'flex');
  assert.strictEqual(style('h').flexDirection, 'row');
  assert.strictEqual(style('i').lineClamp, 3);
  assert.strictEqual(style('j').lineClamp, Infinity);
  assert.strictEqual(style('k').lineClamp, null);
  assert.strictEqual(style('l').lineClamp, null, 'not a multicol container');
  assert.strictEqual(style('d').textOverflow, 'ellipsis');
  // two values name the start and the end, and a line's end is cut
  assert.strictEqual(style('e').textOverflow, 'ellipsis');
  assert.strictEqual(style('f').textOverflow, 'ellipsis');
});

metric(
  'a clamped block shows its first lines, the last cut with an ellipsis',
  async () => {
    // Tailwind's line-clamp-2: a card's description, however long, two
    // lines tall
    const text =
      'Boost your conversion rate with a layout that keeps every card the ' +
      'same height, however long its description runs on and on and on.';
    const { node } = await render(
      '<style>body{margin:0} p{margin:0;width:160px;line-height:20px}</style>' +
        `<p id="a" style="overflow:hidden;display:-webkit-box;` +
        `-webkit-box-orient:vertical;-webkit-line-clamp:2">${text}</p>` +
        `<p id="b">${text}</p>` +
        // one that is shorter than its clamp is all there
        `<p id="c" style="-webkit-line-clamp:2">Short.</p>`,
    );
    const el = view(node);
    const clamped = linesOf(el, 'a');
    assert.strictEqual(clamped.length, 2);
    assert.strictEqual(boxOf(el, 'a').height, 40);
    assert.ok(linesOf(el, 'b').length > 2, 'the text is longer than two');
    assert.strictEqual(lastRunText(clamped[1]), '\u2026', 'with its ellipsis');
    assert.strictEqual(linesOf(el, 'c').length, 1);
  },
);

/** The text of a line's last run, where the engine hands its span back. */
function lastRunText(line: PlacedLine): string | undefined {
  const text = line.texts[line.texts.length - 1];
  const layout = text.layout as unknown as {
    lines: { runs: { span?: { text: string } }[] }[];
  };
  const runs = layout.lines[text.layoutLine].runs;
  return runs[runs.length - 1]?.span?.text;
}

metric(
  'a clamp counts the lines of its blocks, and hides what is past them',
  async () => {
    // CSS Overflow 4, 5.3.1: Tailwind's `line-clamp-3` on a card whose
    // text is in paragraphs counts through them, and the paragraph after
    // the third line is not drawn, nor any of its height
    const { node } = await render(
      '<style>body{margin:0} p{margin:0} div{width:160px;' +
        'line-height:20px}</style>' +
        '<div id="card" style="overflow:hidden;display:-webkit-box;' +
        '-webkit-box-orient:vertical;-webkit-line-clamp:3">' +
        '<p id="a">One line.</p>' +
        '<p id="b">Boost your conversion rate with a layout that keeps ' +
        'every card the same height.</p>' +
        '<p id="c" style="background:#ff0000">Hidden.</p></div>' +
        '<div id="after">After.</div>',
    );
    const el = view(node);
    assert.strictEqual(linesOf(el, 'a').length, 1);
    const b = linesOf(el, 'b');
    assert.strictEqual(b.length, 2, 'two of its lines left');
    assert.strictEqual(lastRunText(b[1]), '\u2026');
    assert.strictEqual(boxOf(el, 'card').height, 60, 'three lines tall');
    assert.strictEqual(boxOf(el, 'after').y, 60, 'and nothing below them');
    const fills = await fillsOf(el);
    assert.ok(
      !fills.some((f) => f.style === parseColor('#ff0000')),
      'the paragraph past the clamp point is invisible',
    );
  },
);

metric(
  'a clamp ends its last line in an ellipsis at a word, and only where more follows',
  async () => {
    // The ellipsis takes room on the line, and the words that do not fit
    // beside it go to the lines the clamp hides (CSS Overflow 4, 4.2): the
    // engine's own ellipsis, the one `text-overflow` asks for, cut inside
    // the last word. A clamp that shows every line shows no ellipsis, and
    // one that falls just after a block's lines, a block after it, does.
    const { node } = await render(
      '<style>body{margin:0} p{margin:0;width:160px;line-height:20px}' +
        '</style>' +
        '<p id="a" style="line-clamp:2">Boost your conversion rate with ' +
        'a layout that keeps uncharacteristically long words.</p>' +
        '<div style="line-clamp:2"><p id="b">Exactly one line.</p>' +
        '<p id="c">And one more.</p><p>Hidden.</p></div>' +
        '<div style="line-clamp:2"><p id="d">One line.</p>' +
        '<p id="e">And the last.</p></div>',
    );
    const el = view(node);
    const [, last] = linesOf(el, 'a');
    assert.strictEqual(lastRunText(last), '\u2026');
    assert.ok(last.width <= 160, `within the box: ${last.width}`);
    const text = last.texts
      .map((t) => {
        const layout = t.layout as unknown as {
          lines: { runs: { span?: { text: string } }[] }[];
        };
        return layout.lines[t.layoutLine].runs
          .map((r) => r.span?.text ?? '')
          .join('');
      })
      .join('');
    assert.ok(/\s\S+\u2026$/.test(text), `whole words before it: ${text}`);
    assert.ok(!/uncharacteri\u2026/.test(text), text);
    assert.notStrictEqual(lastRunText(linesOf(el, 'b')[0]), '\u2026');
    assert.strictEqual(lastRunText(linesOf(el, 'c')[0]), '\u2026');
    assert.notStrictEqual(lastRunText(linesOf(el, 'e')[0]), '\u2026');
  },
);

metric('line-clamp: auto shows the lines its height holds', async () => {
  // as many lines as a `max-height` in `lh` holds, the last cut with an
  // ellipsis (CSS Overflow 4, 5.3.1)
  const { node } = await render(
    '<style>body{margin:0} div{width:160px;line-height:20px}</style>' +
      '<div id="a" style="line-clamp:auto;max-height:3lh">' +
      '<p style="margin:0">One.</p><p style="margin:0">Two.</p>' +
      '<p style="margin:0">Three.</p><p id="d" style="margin:0">Four.</p>' +
      '</div>' +
      '<div id="b" style="height:2lh">Two lines tall.</div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 60);
  assert.strictEqual(boxOf(el, 'b').height, 40, '`lh` is the line height');
  const ends = linesOf(el, 'a').map((line) => lastRunText(line));
  assert.strictEqual(ends.length, 3);
  assert.strictEqual(ends[2], '\u2026');
});

metric(
  "truncate: a line that clips ends in an ellipsis at the box's width",
  async () => {
    const { node } = await render(
      '<style>body{margin:0} div{width:120px;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap}</style>' +
        '<div id="a">leslie.alexander@example.com and more</div>' +
        '<div id="b">Short</div>' +
        // and a line that does not clip is not cut, however long
        '<div id="c" style="overflow:visible">leslie.alexander@example.com</div>',
    );
    const el = view(node);
    const [cut] = linesOf(el, 'a');
    assert.strictEqual(linesOf(el, 'a').length, 1);
    assert.ok(cut.width <= 120, `within the box: ${cut.width}`);
    const truncated = (id: string) =>
      (linesOf(el, id)[0].texts[0].layout as unknown as { truncated: boolean })
        .truncated;
    assert.strictEqual(truncated('a'), true);
    assert.strictEqual(truncated('b'), false);
    assert.ok(linesOf(el, 'c')[0].width > 120, 'run past the box');
  },
);

metric('a truncated block cuts each of its lines, and loses none', async () => {
  // the cut was the paragraph's, one line with an ellipsis: a `truncate`
  // block with a `<br>` in it, or a `<pre>` that clips with
  // `text-overflow: ellipsis`, showed its first line and nothing else,
  // where `text-overflow` cuts every line that overflows
  const { node } = await render(
    '<style>body{margin:0} .t{width:120px;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap}</style>' +
      '<div id="a" class="t">leslie.alexander@example.com<br>Short<br>' +
      'michael.foster@example.com</div>' +
      '<pre id="b" style="width:120px;padding:0;overflow:hidden;' +
      'text-overflow:ellipsis">const answer = computeTheAnswer();\n' +
      'return answer;</pre>',
  );
  const el = view(node);
  const truncated = (line: PlacedLine) =>
    (line.texts[0].layout as unknown as { truncated: boolean }).truncated;
  const lines = linesOf(el, 'a');
  assert.strictEqual(lines.length, 3, 'every line');
  assert.deepStrictEqual(lines.map(truncated), [true, false, true]);
  for (const line of lines) {
    assert.ok(line.width <= 120, `within the box: ${line.width}`);
  }
  assert.ok(lines[1].y > lines[0].y && lines[2].y > lines[1].y, 'in order');
  const pre = linesOf(el, 'b');
  assert.strictEqual(pre.length, 2);
  assert.deepStrictEqual(pre.map(truncated), [true, false]);
});

metric(
  'a clamped block laid out a line at a time is cut to its lines',
  async () => {
    // an image on a line lays the block out a line at a time, which the
    // engine's clamp does not see: the lines past it are dropped, with no
    // ellipsis, and the block ends where its last line does
    const { node } = await render(
      '<style>body{margin:0} p{margin:0;width:160px;line-height:20px}</style>' +
        '<p id="a" style="line-clamp:2"><img style="width:10px;' +
        'height:10px"> Boost your conversion rate with a layout that keeps ' +
        'every card the same height, however long its description runs.</p>',
    );
    const el = view(node);
    assert.strictEqual(linesOf(el, 'a').length, 2);
    assert.strictEqual(boxOf(el, 'a').height, 40);
  },
);

metric(
  "the spaces justification and word-spacing space out keep their kerning, and an element's letter-spacing does not",
  async () => {
    // A space justification spaces out is a run of its own, and the engine
    // shaped it apart for its letter spacing: Arial's space–T and L–space
    // pairs were lost, a line of the Zen Garden's 037 measured 0.6px wider
    // than it does unjustified, and broke a word early. That spacing is in
    // addition to kerning and no element's (CSS Text 3, 7.2, 7.3), so the
    // run says so; an element's own letter-spacing is where a browser
    // breaks the shaping, and says nothing
    const words = 'The quick brown fox jumps over the lazy dog, and back. ';
    const { result, node } = await render(
      '<style>body{margin:0}p{margin:0;width:200px}</style>' +
        `<p style="text-align:justify">${words.repeat(3)}</p>` +
        '<p style="word-spacing:4px">alpha beta gamma</p>' +
        '<p><span style="letter-spacing:2px">spaced</span> text</p>',
    );
    const el = view(node);
    const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
    const seen: TextRun[] = [];
    const recording: FontsLike = {
      layout: (runs, style, options) => {
        seen.push(...(runs as TextRun[]));
        return fonts.layout(runs, style, options);
      },
      match: (...args) => fonts.match(...args),
    };
    const { layoutDocument } = await import('../../src/html/layout/block.js');
    const tree = (el as unknown as { _tree: unknown })._tree;
    layoutDocument(tree as never, recording, 400, 600);
    const spaced = seen.filter((run) => run.letterSpacing && run.text === ' ');
    assert.ok(spaced.length > 10, `${spaced.length} spaced spaces`);
    for (const run of spaced) assert.strictEqual(run.kernAcross, true);
    const own = seen.filter((run) => run.text === 'spaced');
    assert.ok(own.length > 0 && own.every((run) => run.letterSpacing === 2));
    for (const run of own)
      assert.ok(!run.kernAcross, 'an element spaces apart');
  },
);
