// `src/richtext/runs.ts` — the per-run decoration painter, against the two
// run shapes it meets. ntk hands every laid-out run back with the span it
// came from and the face it was shaped with; an engine may hand back a run's
// geometry and nothing else — react-x11's Windows engine, and its Cocoa engine
// before 2.22.8 — and the painter threw on the first paragraph on macOS
// before it learned to read that shape.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  lineBands,
  paintRunBackgrounds,
  paintRunRules,
} from '../src/richtext/runs.js';
import type { LaidLine, LaidRun } from '../src/richtext/runs.js';

/** A context that records every fill as `[colour, x, y, w, h]`. */
function recorder() {
  const fills: [unknown, number, number, number, number][] = [];
  const ctx = {
    fillStyle: null as unknown,
    save() {},
    restore() {},
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push([ctx.fillStyle, x, y, w, h]);
    },
  };
  return { ctx, fills };
}

/** A 16-pixel line with its baseline 12 down, from y = 0. */
function line(runs: LaidRun[], extra: Partial<LaidLine> = {}): LaidLine {
  return {
    x: 0,
    y: 0,
    height: 16,
    baseline: 12,
    start: 0,
    end: runs[runs.length - 1]?.end ?? 0,
    runs,
    ...extra,
  };
}

test("a run without its span (react-x11's Cocoa engine) draws no decoration, and says so once", () => {
  const cocoa = line([
    { x: 0, width: 30, start: 0, end: 5 },
    { x: 30, width: 20, start: 5, end: 8 },
  ]);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  try {
    const { ctx, fills } = recorder();
    paintRunBackgrounds(ctx, cocoa, 0, 0);
    paintRunRules(ctx, cocoa, 0, 0);
    paintRunBackgrounds(ctx, cocoa, 10, 10, 2);
    paintRunRules(ctx, cocoa, 10, 10, 2);
    assert.deepStrictEqual(fills, []);
  } finally {
    console.warn = original;
  }
  assert.strictEqual(
    warnings.length,
    1,
    `one warning for any number of paints: ${warnings.join(' | ')}`,
  );
  assert.match(warnings[0], /without their spans/);
});

test('a run with its span but not its face takes its extent from the line', () => {
  // The chip and the strikethrough both need the ink's height. The run's
  // own face answers when the engine handed it back; otherwise the line's
  // ascent and descent do, and for a line that reports neither, its
  // baseline against its box.
  const span = { text: 'code', bg: '#eee', strike: '#f00' };
  const face = { metrics: () => ({ ascent: 9, descent: 2 }) };

  const shaped = line(
    [
      {
        x: 4,
        width: 40,
        start: 0,
        end: 4,
        span,
        run: { font: face, size: 14 },
      },
    ],
    { ascent: 10, descent: 3 },
  );
  const own = recorder();
  paintRunBackgrounds(own.ctx, shaped, 0, 0);
  paintRunRules(own.ctx, shaped, 0, 0);
  // the chip: from baseline - ascent, ascent + descent tall, inset 2 each side
  assert.deepStrictEqual(own.fills[0], ['#eee', 2, 3, 44, 11]);
  // the strike: 38% of the ascent above the baseline, one pixel thick
  assert.deepStrictEqual(own.fills[1], ['#f00', 4, 9, 40, 1]);

  const measured = line([{ x: 4, width: 40, start: 0, end: 4, span }], {
    ascent: 10,
    descent: 3,
  });
  const lines = recorder();
  paintRunBackgrounds(lines.ctx, measured, 0, 0);
  paintRunRules(lines.ctx, measured, 0, 0);
  assert.deepStrictEqual(lines.fills[0], ['#eee', 2, 2, 44, 13]);
  assert.deepStrictEqual(lines.fills[1], ['#f00', 4, 8, 40, 1]);

  const boxed = line([{ x: 4, width: 40, start: 0, end: 4, span }]);
  const box = recorder();
  paintRunBackgrounds(box.ctx, boxed, 0, 0);
  // baseline 12 in a 16-tall box from y 0: ascent 12, descent 4
  assert.deepStrictEqual(box.fills[0], ['#eee', 2, 0, 44, 16]);
});

test('an underline and a line through can be drawn in two passes', () => {
  // CSS 2.1 Appendix E: an underline under the glyphs, a line through over
  // them. `<Html>` draws the rules in two passes around its text; one pass
  // draws both, as `<RichText>` does.
  const span = { text: 'ab', underline: '#00f', strike: '#f00' };
  const both = line([{ x: 0, width: 20, start: 0, end: 2, span }], {
    ascent: 10,
    descent: 3,
  });
  const colours = (rules?: 'under' | 'over') => {
    const { ctx, fills } = recorder();
    paintRunRules(ctx, both, 0, 0, 1, rules);
    return [...new Set(fills.map((f) => f[0]))];
  };
  assert.deepStrictEqual(colours('under'), ['#00f']);
  assert.deepStrictEqual(colours('over'), ['#f00']);
  assert.deepStrictEqual(colours(), ['#00f', '#f00']);
});

test('runs that touch and draw one rule are underlined in one stretch', () => {
  // A layout hands back a run a word, and a rule begun again under each
  // has a seam at every space — a dotted one above all, whose dots are
  // spread from one end of it to the other.
  const link = { text: 'two words', underline: '#00f' };
  const same = { text: ' more', underline: '#00f' };
  const other = { text: 'red', underline: '#f00' };
  const thick = { text: 'thick', underline: '#f00', underlineThickness: 3 };
  const words = line([
    { x: 0, width: 20.4, start: 0, end: 4, span: link },
    { x: 20.4, width: 30, start: 4, end: 9, span: link },
    // another span, the same rule
    { x: 50.4, width: 25, start: 9, end: 14, span: same },
    // another colour, then another thickness: each its own
    { x: 75.4, width: 10, start: 14, end: 17, span: other },
    { x: 85.4, width: 10, start: 17, end: 22, span: thick },
    // and the same rule again, but not touching the first stretch
    { x: 120, width: 10, start: 22, end: 23, span: link },
  ]);
  const { ctx, fills } = recorder();
  paintRunRules(ctx, words, 3, 0);
  assert.deepStrictEqual(fills, [
    ['#00f', 3, 14, 76, 1],
    ['#f00', 78, 14, 11, 1],
    ['#f00', 88, 14, 11, 3],
    ['#00f', 123, 14, 10, 1],
  ]);
  // a right-to-left stretch's runs come last first
  const rtl = line([
    { x: 30, width: 20, start: 0, end: 4, span: link },
    { x: 0, width: 30, start: 4, end: 9, span: link },
  ]);
  const back = recorder();
  paintRunRules(back.ctx, rtl, 0, 0);
  assert.deepStrictEqual(back.fills, [['#00f', 0, 14, 50, 1]]);
});

test('a thick dotted rule is round dots spread over it, where the context has a path', () => {
  const dotted = (thickness: number, width: number) =>
    line([
      {
        x: 0,
        width,
        start: 0,
        end: 4,
        span: {
          text: 'abbr',
          underline: '#00f',
          underlineStyle: 'dotted' as const,
          underlineThickness: thickness,
          underlineOffset: 5,
        },
      },
    ]);
  /** A recorder with a path: a `roundRect` filled is `[x, y, w, radius]`. */
  const pathRecorder = () => {
    const flat = recorder();
    const dots: number[][] = [];
    let pending: number[] | null = null;
    // added to the recorder's own context, whose fills read its `fillStyle`
    const ctx = Object.assign(flat.ctx, {
      beginPath() {
        pending = null;
      },
      roundRect(x: number, y: number, w: number, h: number, r: number[]) {
        assert.strictEqual(w, h, 'a circle');
        pending = [x, y, w, r[0]];
      },
      fill() {
        if (pending) dots.push(pending);
      },
    });
    return { ctx, dots, fills: flat.fills };
  };

  // ten thick over a hundred: five dots leave gaps of 12.5 and six of 8,
  // and 8 is the nearer to a dot's own ten
  const round = pathRecorder();
  paintRunRules(round.ctx, dotted(10, 100), 0, 0);
  assert.deepStrictEqual(
    round.dots,
    [0, 18, 36, 54, 72, 90].map((x) => [x, 17, 10, 5]),
  );
  assert.deepStrictEqual(round.fills, [], 'and no squares');

  // no room for two with a gap between them: one, at the start
  const one = pathRecorder();
  paintRunRules(one.ctx, dotted(10, 20), 0, 0);
  assert.deepStrictEqual(one.dots, [[0, 17, 10, 5]]);
  const two = pathRecorder();
  paintRunRules(two.ctx, dotted(10, 25), 0, 0);
  assert.deepStrictEqual(two.dots, [
    [0, 17, 10, 5],
    [15, 17, 10, 5],
  ]);

  // three pixels and under, a square is a dot: squares a thickness apart
  const thin = pathRecorder();
  paintRunRules(thin.ctx, dotted(3, 15), 0, 0);
  assert.deepStrictEqual(thin.dots, []);
  assert.deepStrictEqual(thin.fills, [
    ['#00f', 0, 17, 3, 3],
    ['#00f', 6, 17, 3, 3],
    ['#00f', 12, 17, 3, 3],
  ]);

  // and a context with no path draws a thick one's as squares too
  const flat = recorder();
  paintRunRules(flat.ctx, dotted(10, 50), 0, 0);
  assert.deepStrictEqual(flat.fills, [
    ['#00f', 0, 17, 10, 10],
    ['#00f', 20, 17, 10, 10],
    ['#00f', 40, 17, 10, 10],
  ]);
});

test('a line through is as thick as its run says, about a third of the ascent up', () => {
  // A line through was a pixel thick and solid whatever was asked of it.
  // `strikeThickness` makes it thicker, its middle a third of the run's
  // own ascent above the baseline so that it grows both ways from where
  // a thin one is, and `strikeStyle` draws it in the underline's styles.
  const face = { metrics: () => ({ ascent: 9, descent: 3 }) };
  const struck = (span: Record<string, unknown>, scale = 1) => {
    const { ctx, fills } = recorder();
    paintRunRules(
      ctx,
      line([
        {
          x: 4,
          width: 40,
          start: 0,
          end: 4,
          span: { text: 'gone', strike: '#f00', ...span },
          run: { font: face, size: 12 },
        },
      ]),
      0,
      0,
      scale,
    );
    return fills.map((f) => f.slice(1));
  };
  // the baseline is 12 down, and a third of the ascent is 3: the middle at 9
  assert.deepStrictEqual(struck({ strikeThickness: 4 }), [[4, 7, 40, 4]]);
  assert.deepStrictEqual(struck({ strikeThickness: 2 }), [[4, 8, 40, 2]]);
  assert.deepStrictEqual(
    struck({ strikeThickness: 0.2 }),
    [[4, 9, 40, 1]],
    'never under a pixel',
  );
  // a run that says nothing is struck as it always was: a logical pixel
  // thick, its top 38% of the ascent up
  assert.deepStrictEqual(struck({}), [[4, 9, 40, 1]]);
  assert.deepStrictEqual(struck({}, 2), [[4, 9, 40, 2]]);

  // two lines, the first where the single one is and the second a pixel
  // clear of it underneath
  assert.deepStrictEqual(
    struck({ strikeStyle: 'double', strikeThickness: 4 }),
    [
      [4, 7, 40, 4],
      [4, 12, 40, 4],
    ],
  );
  // the curl's two levels either side of the middle
  assert.deepStrictEqual(
    struck({ strikeStyle: 'curly', strikeThickness: 2 }).slice(0, 2),
    [
      [4, 7, 4, 2],
      [8, 9, 4, 2],
    ],
  );
  // squares a thickness apart, and dashes from one end to the other
  assert.deepStrictEqual(
    struck({ strikeStyle: 'dotted', strikeThickness: 2 }).slice(0, 2),
    [
      [4, 8, 2, 2],
      [8, 8, 2, 2],
    ],
  );
  const dashes = struck({ strikeStyle: 'dashed', strikeThickness: 4 });
  assert.deepStrictEqual(dashes[0], [4, 7, 8, 4]);
  assert.deepStrictEqual(dashes[dashes.length - 1], [36, 7, 8, 4]);
});

test('runs that touch are struck through in one stretch, a font size at a time', () => {
  // A line through is drawn over each font size where that size has it,
  // so that text of another size is still crossed out (CSS Text Decoration
  // 4, 2.5); the runs of one size, which a layout hands back a word at a
  // time, share a rule as an underline's do.
  const small = { metrics: () => ({ ascent: 9, descent: 3 }) };
  const large = { metrics: () => ({ ascent: 27, descent: 9 }) };
  const del = { text: 'two words', strike: '#f00', strikeThickness: 2 };
  const big = { text: 'BIG', strike: '#f00', strikeThickness: 2, size: 36 };
  const other = { text: 'red', strike: '#00f', strikeThickness: 2 };
  const at = (font: typeof small, size: number) => ({ font, size });
  const words = line(
    [
      { x: 0, width: 20.4, start: 0, end: 4, span: del, run: at(small, 12) },
      { x: 20.4, width: 30, start: 4, end: 9, span: del, run: at(small, 12) },
      // a larger size: the same rule, a third of its own ascent up
      { x: 50.4, width: 60, start: 9, end: 12, span: big, run: at(large, 36) },
      // and another colour at the first height
      {
        x: 110.4,
        width: 10,
        start: 12,
        end: 15,
        span: other,
        run: at(small, 12),
      },
    ],
    { y: 0, height: 40, baseline: 30 },
  );
  const { ctx, fills } = recorder();
  paintRunRules(ctx, words, 3, 0);
  assert.deepStrictEqual(fills, [
    ['#f00', 3, 26, 51, 2],
    ['#f00', 53, 20, 61, 2],
    ['#00f', 113, 26, 11, 2],
  ]);

  // A word the face has no glyphs for is set in another at the same size,
  // whose ascent is its own: the rule does not step for it. One position
  // for the size, averaged from its fonts' metrics by how much each sets.
  const fallback = { metrics: () => ({ ascent: 15, descent: 3 }) };
  const mixed = line(
    [
      { x: 0, width: 30, start: 0, end: 4, span: del, run: at(small, 12) },
      { x: 30, width: 10, start: 4, end: 6, span: del, run: at(fallback, 12) },
      { x: 40, width: 20, start: 6, end: 9, span: del, run: at(small, 12) },
    ],
    { y: 0, height: 40, baseline: 30 },
  );
  const straight = recorder();
  paintRunRules(straight.ctx, mixed, 0, 0);
  // five sixths at 9 and a sixth at 15 is 10: the middle 3.33 up
  assert.deepStrictEqual(straight.fills, [['#f00', 0, 26, 60, 2]]);
  // …and a rule that names no thickness, the same way
  const plain = { text: 'two words', strike: '#f00' };
  const legacy = recorder();
  paintRunRules(
    legacy.ctx,
    { ...mixed, runs: mixed.runs.map((r) => ({ ...r, span: plain })) },
    0,
    0,
  );
  assert.deepStrictEqual(legacy.fills, [['#f00', 0, 26, 60, 1]]);
});

test("a dashed rule's dashes run from its start to its end, their lengths by its thickness", () => {
  // Blink's dashes: three of the thickness long and two apart while the
  // rule is thin, twice and one from three pixels thick, the gap then the
  // nearest to that which sets the first dash at the rule's start and the
  // last at its end. Three on and three off whatever the length ended a
  // rule on a sliver of a dash, or on a gap.
  const dashed = (thickness: number | undefined, width: number) => {
    const { ctx, fills } = recorder();
    paintRunRules(
      ctx,
      line([
        {
          x: 0,
          width,
          start: 0,
          end: 4,
          span: {
            text: 'dash',
            underline: '#00f',
            underlineStyle: 'dashed' as const,
            ...(thickness === undefined
              ? null
              : { underlineThickness: thickness }),
          },
        },
      ]),
      0,
      0,
    );
    return fills.map((f) => [f[1], f[3], f[4]]);
  };
  // a hairline over fifty: ten dashes of three leave gaps of 2.2, and
  // eleven of 1.7
  assert.deepStrictEqual(
    dashed(undefined, 50),
    [0, 5, 10, 16, 21, 26, 31, 37, 42, 47].map((x) => [x, 3, 1]),
  );
  // four thick over a hundred: eight dashes of eight leave gaps of 5.1,
  // and nine of 3.5, the nearer to four
  assert.deepStrictEqual(
    dashed(4, 100),
    [0, 12, 23, 35, 46, 58, 69, 81, 92].map((x) => [x, 8, 4]),
  );
  // room for two dashes and not their gap: two, scaled to fit
  assert.deepStrictEqual(dashed(4, 18), [
    [0, 7, 4],
    [11, 7, 4],
  ]);
  // and no room for two: a line
  assert.deepStrictEqual(dashed(4, 16), [[0, 16, 4]]);
});

test('the two lines of a double rule are a logical pixel apart, however thick', () => {
  const double = (thickness: number | undefined, scale = 1) => {
    const { ctx, fills } = recorder();
    paintRunRules(
      ctx,
      line([
        {
          x: 0,
          width: 30,
          start: 0,
          end: 4,
          span: {
            text: 'both',
            underline: '#00f',
            underlineStyle: 'double' as const,
            underlineOffset: 2 * scale,
            ...(thickness === undefined
              ? null
              : { underlineThickness: thickness }),
          },
        },
      ]),
      0,
      0,
      scale,
    );
    return fills.map((f) => [f[2], f[4]]);
  };
  // a rule of the default thickness, as it always was
  assert.deepStrictEqual(double(undefined), [
    [14, 1],
    [16, 1],
  ]);
  assert.deepStrictEqual(double(undefined, 2), [
    [16, 2],
    [20, 2],
  ]);
  // a thick one's second line was its thickness clear of the first, where
  // Blink draws it a pixel clear
  assert.deepStrictEqual(double(4), [
    [14, 4],
    [19, 4],
  ]);
});

test("a selection band needs only a run's geometry", () => {
  const cocoa = line([
    { x: 0, width: 30, start: 0, end: 5 },
    { x: 30, width: 20, start: 5, end: 8 },
  ]);
  const layout = {
    caretPosition: (i: number) => ({ x: i * 6, y: 0, height: 16, line: 0 }),
  };
  const offsets = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  // [2, 7) crosses the run boundary at 5: two touching stretches, merged
  assert.deepStrictEqual(lineBands(layout, cocoa, offsets, 2, 7), [
    { x: 12, width: 30 },
  ]);
});
