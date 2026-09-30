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
  /** A path, where the backend has one: a thick dotted rule's dots are
   *  round through these, and square without them. */
  beginPath?(): void;
  roundRect?(x: number, y: number, w: number, h: number, radii: number[]): void;
  fill?(): void;
}

export function canFill(ctx: unknown): ctx is FillContext {
  return typeof (ctx as Partial<FillContext> | null)?.fillRect === 'function';
}

/**
 * One run of one laid-out line, as much of it as decoration reads.
 *
 * `span` and `run` are what ntk's layout hands back and what every
 * decoration is read from: the span the run came from, markers and all, and
 * the face it was shaped with. Both are optional because an engine may
 * report only a run's geometry — `{ x, width, start, end }` — as react-x11's
 * Windows engine does and its Cocoa engine did before 2.22.8, and a paint
 * that assumed the rest threw on the first paragraph on macOS. A run without its span has no decoration to draw; a run without
 * its face takes its vertical extent from the line, which both engines
 * report.
 */
export interface LaidRun {
  x: number;
  width: number;
  /** Extent within the laid-out text, in **code units** (ntk's vocabulary). */
  start: number;
  end: number;
  span?: TextRun;
  run?: {
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
  /** The tallest face on the line, above and below `baseline`. Both engines
   *  report them; they stand in for a run's own metrics when the engine did
   *  not hand the run's face back. */
  ascent?: number;
  descent?: number;
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
 * The vertical extent of a run's ink, above and below the baseline: the
 * run's own face when the engine handed it back, otherwise the line's.
 */
function inkExtent(
  r: LaidRun,
  line: LaidLine,
): { ascent: number; descent: number } {
  if (r.run) return r.run.font.metrics(r.run.size);
  return {
    ascent: line.ascent ?? line.baseline - line.y,
    descent: line.descent ?? line.y + line.height - line.baseline,
  };
}

let warnedSpanless = false;

/**
 * Say so, once, when a laid-out run arrives without the span it came from:
 * every decoration is read off that span, so none will be drawn, and a
 * document that suddenly has no code chips or link underlines should not be
 * a mystery. react-x11's Windows engine does this, and its Cocoa engine did
 * before 2.22.8.
 *
 * `process` and `console` come off `globalThis` because `src/` compiles
 * with `types: []` — a Node global that wandered in would fail the build
 * rather than become an implicit `@types/node` dependency.
 */
function warnSpanless(): void {
  if (warnedSpanless) return;
  warnedSpanless = true;
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    console?: { warn(message: string): void };
  };
  if (g.process?.env?.NODE_ENV === 'production') return;
  g.console?.warn(
    '@react-x11/components: the text engine handed back laid-out runs ' +
      'without their spans, so run decorations (backgrounds, underlines, ' +
      "strikethrough) and inline link hit-testing are off. react-x11's " +
      'Windows text engine does this, as its Cocoa engine did before ' +
      "2.22.8; ntk's does not.",
  );
}

/**
 * The fills that sit **under** the glyphs: the inline-code chip, a
 * terminal's cell backgrounds, a highlighted `<span>`.
 *
 * `dx`/`dy` translate the line's own coordinates into the target space, so a
 * caller that placed this line itself passes where it placed it. `scale` is
 * the display scale: the chip's two-pixel inset is a logical length that
 * never passes through a style, and grows with it.
 */
export function paintRunBackgrounds(
  ctx: FillContext,
  line: LaidLine,
  dx: number,
  dy: number,
  scale = 1,
): void {
  const inset = Math.round(2 * scale);
  for (const r of line.runs) {
    const span = r.span;
    if (!span) {
      warnSpanless();
      continue;
    }
    const bg = span.bg;
    if (!bg) continue;
    ctx.fillStyle = bg;
    if (span.bgFill === 'line') {
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
    const m = inkExtent(r, line);
    ctx.fillRect(
      Math.round(dx + line.x + r.x - inset),
      Math.round(dy + line.baseline - m.ascent),
      Math.ceil(r.width + inset * 2),
      Math.ceil(m.ascent + m.descent),
    );
  }
}

/** The rules drawn with a run: its underline and its strikethrough. A rule
 *  is one logical pixel thick — `scale` device pixels, so a link on a 2x
 *  panel is underlined as heavily as on a 1x one, not with a hairline —
 *  and an underline two below the baseline, where the run sets neither
 *  (`underlineThickness`, `underlineOffset`, in device pixels by now). A
 *  line through is a logical pixel as well where the run names no
 *  `strikeThickness`, and is drawn where its face puts it (`strikeTop`).
 *  `rules` picks a pass: CSS draws an underline under the glyphs and a
 *  line through over them (CSS 2.1 Appendix E), which is two passes around
 *  the glyphs'; drawn in one, both go over.
 *
 *  A rule is drawn a stretch at a time and not a run: a layout hands
 *  back a run a word, and a pattern begun again under each — dots spread
 *  from one end of their rule to the other, above all — is a pattern with
 *  a seam at every space. Runs that touch and draw the same rule share
 *  one. */
export function paintRunRules(
  ctx: FillContext,
  line: LaidLine,
  dx: number,
  dy: number,
  scale = 1,
  rules: 'under' | 'over' | 'all' = 'all',
): void {
  const t = ruleThickness(scale);
  if (rules !== 'over') {
    // the stretch being gathered: the span whose rule it is, and its ends
    let ruled: TextRun | null = null;
    let from = 0;
    let to = 0;
    for (const r of line.runs) {
      const span = r.span;
      if (!span?.underline) continue;
      const end = r.x + r.width;
      if (
        ruled &&
        // on either side: a right-to-left stretch's runs come last first
        (Math.abs(r.x - to) <= 0.5 || Math.abs(end - from) <= 0.5) &&
        sameRule(ruled, span)
      ) {
        from = Math.min(from, r.x);
        to = Math.max(to, end);
        continue;
      }
      if (ruled) stretchRule(ctx, ruled, line, dx + from, dx + to, dy, t);
      ruled = span;
      from = r.x;
      to = end;
    }
    if (ruled) stretchRule(ctx, ruled, line, dx + from, dx + to, dy, t);
  }
  if (rules === 'under') return;
  // A line through, gathered the same way, and ended as well where the
  // font size changes: it is drawn across each size where that size has
  // it (`strikeTop`). The faces of one size are one stretch, at the height
  // they have it between them — a word the face has no glyphs for is set
  // in another, and the rule does not step for it.
  let struck: TextRun | null = null;
  let size: number | undefined;
  let from = 0;
  let to = 0;
  // the stretch's ascent: its first run's, and its runs' by how much of
  // the stretch each sets, which is read only where they are not all the
  // first's
  let ascent = 0;
  let summed = 0;
  let widths = 0;
  let mixed = false;
  for (const r of line.runs) {
    const span = r.span;
    if (!span?.strike) continue;
    const own = inkExtent(r, line).ascent;
    const end = r.x + r.width;
    if (
      struck &&
      r.run?.size === size &&
      (Math.abs(r.x - to) <= 0.5 || Math.abs(end - from) <= 0.5) &&
      sameStrike(struck, span)
    ) {
      from = Math.min(from, r.x);
      to = Math.max(to, end);
      summed += own * r.width;
      widths += r.width;
      if (own !== ascent) mixed = true;
      continue;
    }
    if (struck) {
      const mean = mixed && widths > 0 ? summed / widths : ascent;
      strikeRule(ctx, struck, line, dx + from, dx + to, dy, mean, t);
    }
    struck = span;
    size = r.run?.size;
    from = r.x;
    to = end;
    ascent = own;
    summed = own * r.width;
    widths = r.width;
    mixed = false;
  }
  if (struck) {
    const mean = mixed && widths > 0 ? summed / widths : ascent;
    strikeRule(ctx, struck, line, dx + from, dx + to, dy, mean, t);
  }
}

/** The underline of a stretch of a line, from `from` to `to` of it, as
 *  `span` has it; `t` is the thickness of a rule that names none. */
function stretchRule(
  ctx: FillContext,
  span: TextRun,
  line: LaidLine,
  from: number,
  to: number,
  dy: number,
  t: number,
): void {
  const left = Math.round(line.x + from);
  ctx.fillStyle = span.underline;
  underlineRule(
    ctx,
    left,
    Math.round(dy + line.baseline + (span.underlineOffset ?? 2 * t)),
    Math.ceil(line.x + to - left),
    span.underlineStyle ?? 'single',
    span.underlineThickness === undefined
      ? t
      : Math.max(1, Math.round(span.underlineThickness)),
    t,
  );
}

/** How thick a run's line through is: what it says, on whole pixels, or
 *  `t`, a rule's own thickness. */
function strikeThickness(span: TextRun, t: number): number {
  return span.strikeThickness === undefined
    ? t
    : Math.max(1, Math.round(span.strikeThickness));
}

/**
 * Where the top of a line through is, across text whose faces' ascent is
 * `ascent`. Through the middle of the letters with no ascender, which a
 * face does not say the height of in a way both text engines report: a
 * third of its ascent above the baseline, where Blink has it, and the
 * rule's middle there, so that a thick one grows both ways from where a
 * thin one is. The ascent is the text's own, and not that of the font the
 * rule was set in: a line through is worked out again across text of
 * another font size, from the metrics of the fonts that size is set in,
 * so that the text is still crossed out (CSS Text Decoration 4, 2.5), and
 * is not held to the one position an underline is (2.9). Blink measures
 * the ascent of the font the rule was set in from the top of the text it
 * crosses, which puts it near the top of larger text and under smaller.
 * The curl is two levels and straddles the middle; a double rule's first
 * line is the single one's, and its second under it, as Blink draws it.
 *
 * A run that names no thickness keeps the pixel it always had: the rule's
 * top 38% of the ascent up, which at a text size is the same place, and a
 * pixel off it at some.
 */
function strikeTop(
  line: LaidLine,
  dy: number,
  span: TextRun,
  ascent: number,
  t: number,
): number {
  if (span.strikeThickness === undefined) {
    return Math.round(dy + line.baseline - ascent * 0.38);
  }
  const thick = strikeThickness(span, t);
  return Math.round(
    dy +
      line.baseline -
      ascent / 3 -
      (span.strikeStyle === 'curly' ? thick : thick / 2),
  );
}

/** The line through a stretch of a line, from `from` to `to` of it, as
 *  `span` has it, over faces whose ascent is `ascent`. */
function strikeRule(
  ctx: FillContext,
  span: TextRun,
  line: LaidLine,
  from: number,
  to: number,
  dy: number,
  ascent: number,
  t: number,
): void {
  const left = Math.round(line.x + from);
  ctx.fillStyle = span.strike;
  underlineRule(
    ctx,
    left,
    strikeTop(line, dy, span, ascent, t),
    Math.ceil(line.x + to - left),
    span.strikeStyle ?? 'single',
    strikeThickness(span, t),
    t,
  );
}

/** Whether two spans are struck through with one rule: the same ink, style
 *  and thickness. Where it is drawn is their faces' to say (`strikeTop`). */
function sameStrike(a: TextRun, b: TextRun): boolean {
  return (
    a === b ||
    (a.strike === b.strike &&
      a.strikeStyle === b.strikeStyle &&
      a.strikeThickness === b.strikeThickness)
  );
}

/** Whether two spans are underlined with one rule: the same ink, style,
 *  place and thickness. */
function sameRule(a: TextRun, b: TextRun): boolean {
  return (
    a === b ||
    (a.underline === b.underline &&
      a.underlineStyle === b.underlineStyle &&
      a.underlineOffset === b.underlineOffset &&
      a.underlineThickness === b.underlineThickness)
  );
}

/** One logical pixel on the device grid, never less than one device pixel. */
function ruleThickness(scale: number): number {
  return Math.max(1, Math.round(scale));
}

/**
 * The rule under a run, or through it, in one of SGR 4's five styles.
 *
 * All five are built from rectangles `t` pixels thick — one logical pixel —
 * rather than a stroked path: the mock backend has no path API, and a
 * hairline stroke on a text baseline is not worth an antialiased path even
 * where there is one. The curl is a two-level square wave — at a text size
 * it reads as a squiggle, which is the entire job. The dot pitch and the
 * dash length scale with the thickness (`dashedRule`), so the pattern is
 * the pattern at any display scale. The one path is a thick dotted rule's
 * (`dottedRule`): a square is a dot only while it is too small to be seen
 * as a square.
 *
 * `gap` is what parts the two lines of a double rule: a logical pixel
 * however thick they are, as Blink parts them, which for a rule of that
 * thickness is the thickness between them it always was.
 */
export function underlineRule(
  ctx: FillContext,
  x: number,
  y: number,
  width: number,
  style: NonNullable<TextRun['underlineStyle']>,
  t = 1,
  gap = t,
): void {
  switch (style) {
    case 'double':
      ctx.fillRect(x, y, width, t);
      ctx.fillRect(x, y + t + gap, width, t);
      return;
    case 'dotted':
      dottedRule(ctx, x, y, width, t);
      return;
    case 'dashed':
      dashedRule(ctx, x, y, width, t);
      return;
    case 'curly':
      for (let i = 0; i < width; i += 2 * t) {
        ctx.fillRect(
          x + i,
          y + (i % (4 * t) === 0 ? 0 : t),
          Math.min(2 * t, width - i),
          t,
        );
      }
      return;
    default:
      ctx.fillRect(x, y, width, t);
      return;
  }
}

/** The thickness a dashed rule's dashes stop being the long ones of a thin
 *  rule at. */
const THIN_DASHES = 3;

/**
 * A dashed rule, its dashes the lengths Blink's are: three times the rule's
 * thickness and two apart while it is thin, where a shorter dash reads as
 * a dot and a nearer one as no gap, and twice and one from three pixels up.
 * The first dash starts the rule and the last ends it, with as many between
 * as leave the gaps nearest that: a rule that stopped where its length ran
 * out ended on a sliver of a dash, or on nothing. One with room for two
 * dashes and less than their gap is two, scaled to fit, and one too short
 * for two is a line.
 */
function dashedRule(
  ctx: FillContext,
  x: number,
  y: number,
  width: number,
  t: number,
): void {
  const thin = t < THIN_DASHES;
  const dash = t * (thin ? 3 : 2);
  const gap = t * (thin ? 2 : 1);
  if (width <= 2 * dash) {
    ctx.fillRect(x, y, width, t);
    return;
  }
  if (width <= 2 * dash + gap) {
    const each = Math.round((dash * width) / (2 * dash + gap));
    ctx.fillRect(x, y, each, t);
    ctx.fillRect(x + width - each, y, each, t);
    return;
  }
  // the fewest dashes that gap fits between, and one more: whichever
  // count's gap is nearer it
  const few = Math.floor((width + gap) / (dash + gap));
  const wide = (width - few * dash) / (few - 1);
  const narrow = (width - (few + 1) * dash) / few;
  const count =
    narrow <= 0 || Math.abs(wide - gap) < Math.abs(narrow - gap)
      ? few
      : few + 1;
  const pitch = (width - dash) / (count - 1);
  for (let i = 0; i < count; i += 1) {
    ctx.fillRect(x + Math.round(i * pitch), y, dash, t);
  }
}

/** The thickest a dotted rule's dots are squares at: past it a square
 *  reads as one. Where Blink's dotted stroke turns its caps round. */
const SQUARE_DOTS = 3;

/**
 * A dotted rule: squares a thickness apart while it is thin, and round dots
 * once it is thick enough for the shape to show — under a title, where the
 * thickness follows the font size. The round ones are spread over the
 * width, the first at its start and the last at its end, as many as leave
 * the gap between two nearest to a dot's own width; a rule with room for
 * fewer than two is one dot. A context with no path draws the squares.
 */
function dottedRule(
  ctx: FillContext,
  x: number,
  y: number,
  width: number,
  t: number,
): void {
  if (t <= SQUARE_DOTS || !ctx.beginPath || !ctx.roundRect || !ctx.fill) {
    for (let i = 0; i < width; i += 2 * t) {
      ctx.fillRect(x + i, y, Math.min(t, width - i), t);
    }
    return;
  }
  // the fewest dots a gap of their own width fits, and one more: whichever
  // count's gap is nearer that width
  const few = Math.max(1, Math.floor((width + t) / (2 * t)));
  const wide = few > 1 ? (width - few * t) / (few - 1) : Infinity;
  const narrow = (width - (few + 1) * t) / few;
  const count =
    narrow <= 0 || Math.abs(wide - t) < Math.abs(narrow - t) ? few : few + 1;
  const pitch = count > 1 ? (width - t) / (count - 1) : 0;
  for (let i = 0; i < count; i += 1) {
    // a path a dot: ntk knows a path that is one `roundRect` and fills it
    // from its corners, where a path of them all is rasterized whole
    ctx.beginPath();
    ctx.roundRect(x + i * pitch, y, t, t, [t / 2]);
    ctx.fill();
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
