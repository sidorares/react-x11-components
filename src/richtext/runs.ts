// Per-run decoration, as functions over one laid-out line.
//
// This is the part of `<richtext>` that was never really about the element:
// ntk lets a span carry fields it does not understand and hands them back on
// the laid-out runs, and everything here reads those fields back and draws
// what they describe — a chip behind inline code, a terminal cell's
// background, a link's underline, a strikethrough, and the bands a selection
// covers.
//
// It lives in its own module because `<Html>` draws the same decorations
// against the same `TextRun` vocabulary while owning its own layout: it has
// laid a line out at a place of its own choosing and needs the decoration
// drawn *there*, not wherever the layout put it. So each function takes a
// line and an offset rather than a layout and a node, and `node.ts` is a loop
// over its own lines calling them.
import { codePointAtOffset, codeUnitOffsets } from '../internal/text.js';
import type { TextRun } from './node.js';

/** The 2d context slice a decoration needs. The mock backend has no
 *  `fillRect`, which is why every caller checks before drawing. */
export interface FillContext {
  fillStyle: unknown;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

export function canFill(ctx: unknown): ctx is FillContext {
  return typeof (ctx as Partial<FillContext> | null)?.fillRect === 'function';
}

/** One run of one laid-out line, as much of it as decoration reads. */
export interface LaidRun {
  x: number;
  width: number;
  /** Extent within the laid-out text, in **code units** (ntk's vocabulary). */
  start: number;
  end: number;
  span: TextRun;
  run: {
    font: { metrics(size: number): { ascent: number; descent: number } };
    size: number;
    direction?: 'ltr' | 'rtl';
  };
}

/** One laid-out line, as much of it as decoration reads. */
export interface LaidLine {
  x: number;
  y: number;
  height: number;
  baseline: number;
  start: number;
  end: number;
  runs: LaidRun[];
}

/** What a caret query needs — a layout, narrowed to the one method. */
export interface CaretSource {
  caretPosition(index: number): {
    x: number;
    y: number;
    height: number;
    line: number;
  };
}

/**
 * The fills that sit **under** the glyphs: the inline-code chip, a
 * terminal's cell backgrounds, a highlighted `<span>`.
 *
 * `dx`/`dy` translate the line's own coordinates into the target space, so a
 * caller that placed this line itself passes where it placed it.
 */
export function paintRunBackgrounds(
  ctx: FillContext,
  line: LaidLine,
  dx: number,
  dy: number,
): void {
  for (const r of line.runs) {
    const bg = r.span.bg;
    if (!bg) continue;
    ctx.fillStyle = bg;
    if (r.span.bgFill === 'line') {
      // Both edges are rounded from absolute positions rather than the left
      // being rounded and the width ceiled, so two adjacent runs agree on the
      // pixel between them: no seam, and no overlap either.
      const left = Math.round(dx + line.x + r.x);
      const right = Math.round(dx + line.x + r.x + r.width);
      ctx.fillRect(
        left,
        Math.round(dy + line.y),
        Math.max(0, right - left),
        Math.ceil(line.height),
      );
      continue;
    }
    const m = r.run.font.metrics(r.run.size);
    ctx.fillRect(
      Math.round(dx + line.x + r.x - 2),
      Math.round(dy + line.baseline - m.ascent),
      Math.ceil(r.width + 4),
      Math.ceil(m.ascent + m.descent),
    );
  }
}

/** The rules that sit **over** the glyphs: link underlines, strikethrough. */
export function paintRunRules(
  ctx: FillContext,
  line: LaidLine,
  dx: number,
  dy: number,
): void {
  for (const r of line.runs) {
    const { underline, strike } = r.span;
    if (underline) {
      ctx.fillStyle = underline;
      underlineRule(
        ctx,
        Math.round(dx + line.x + r.x),
        Math.round(dy + line.baseline + 2),
        Math.ceil(r.width),
        r.span.underlineStyle ?? 'single',
      );
    }
    if (strike) {
      const m = r.run.font.metrics(r.run.size);
      ctx.fillStyle = strike;
      ctx.fillRect(
        Math.round(dx + line.x + r.x),
        Math.round(dy + line.baseline - m.ascent * 0.38),
        Math.ceil(r.width),
        1,
      );
    }
  }
}

/**
 * The rule under a run, in one of SGR 4's five styles.
 *
 * All five are built from 1px rectangles rather than a stroked path: the mock
 * backend has no path API, and a hairline stroke on a text baseline is not
 * worth an antialiased path even where there is one. The curl is a two-level
 * square wave — at a text size it reads as a squiggle, which is the entire
 * job.
 */
export function underlineRule(
  ctx: FillContext,
  x: number,
  y: number,
  width: number,
  style: NonNullable<TextRun['underlineStyle']>,
): void {
  switch (style) {
    case 'double':
      ctx.fillRect(x, y, width, 1);
      ctx.fillRect(x, y + 2, width, 1);
      return;
    case 'dotted':
      for (let i = 0; i < width; i += 2) ctx.fillRect(x + i, y, 1, 1);
      return;
    case 'dashed':
      for (let i = 0; i < width; i += 6)
        ctx.fillRect(x + i, y, Math.min(3, width - i), 1);
      return;
    case 'curly':
      for (let i = 0; i < width; i += 2) {
        ctx.fillRect(
          x + i,
          y + (i % 4 === 0 ? 0 : 1),
          Math.min(2, width - i),
          1,
        );
      }
      return;
    default:
      ctx.fillRect(x, y, width, 1);
      return;
  }
}

/** A selected empty line still shows as a sliver, so a selection spanning a
 *  blank line does not appear to skip it. Core's own width for the same. */
export const EMPTY_LINE_BAND = 4;

/**
 * The horizontal stretches of one line that a range `[from, to)` — in **code
 * units** of the laid-out text — covers.
 *
 * More than one on a line that changes direction, because a selection is
 * contiguous in *logical* order while a line is laid out in *visual* order: a
 * range crossing from Latin into Arabic covers two disjoint stretches of
 * pixels, and a single rectangle drawn between the two caret positions paints
 * over text nobody selected. So this walks the line's runs and intersects
 * each with the range rather than interpolating between carets.
 *
 * Core's `<text>` does the same thing with the same code (react-x11#291's
 * `rangeBands`), which is not on its exports map; when it is, delete this.
 */
export function lineBands(
  layout: CaretSource,
  line: LaidLine,
  offsets: number[],
  from: number,
  to: number,
): { x: number; width: number }[] {
  const spans: [number, number][] = [];
  for (const positioned of line.runs) {
    const a = Math.max(from, positioned.start);
    const b = Math.min(to, positioned.end);
    if (b <= a) continue;
    const rtl = positioned.run?.direction === 'rtl';
    const near = line.x + positioned.x;
    const far = near + positioned.width;
    // a boundary at the run's own logical edge is that edge — which side of
    // the pixels it is on is what the run's direction decides
    const edgeAt = (cu: number, logicalStart: boolean): number => {
      if (logicalStart ? cu <= positioned.start : cu >= positioned.end) {
        return rtl === logicalStart ? far : near;
      }
      return layout.caretPosition(codePointAtOffset(offsets, cu)).x;
    };
    const x1 = edgeAt(a, true);
    const x2 = edgeAt(b, false);
    spans.push([Math.min(x1, x2), Math.max(x1, x2)]);
  }
  if (!spans.length) {
    return from < line.end && to > line.start
      ? [{ x: line.x, width: EMPTY_LINE_BAND }]
      : [];
  }
  // Runs also split at every style span, so an ordinary line with a bold word
  // in it is three rectangles that touch. Merging keeps the common case at
  // one per line.
  spans.sort((p, q) => p[0] - q[0]);
  const out: { x: number; width: number }[] = [];
  let [left, right] = spans[0];
  for (let i = 1; i <= spans.length; i += 1) {
    const next = spans[i];
    if (next && next[0] <= right + 0.5) {
      right = Math.max(right, next[1]);
      continue;
    }
    if (right > left) out.push({ x: left, width: right - left });
    if (next) [left, right] = next;
  }
  return out;
}

export { codePointAtOffset, codeUnitOffsets };
