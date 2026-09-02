// `src/richtext/runs.ts` — the per-run decoration painter, against the two
// run shapes it meets. ntk hands every laid-out run back with the span it
// came from and the face it was shaped with; react-x11's Cocoa engine (2.3.x)
// hands back a run's geometry and nothing else, and the painter threw on the
// first paragraph on macOS before it learned to read that shape.
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
