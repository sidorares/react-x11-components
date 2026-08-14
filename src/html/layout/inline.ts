// Inline layout: text, and the atomic things that sit in the middle of it.
//
// The whole file turns on one decision — **how many times ntk's `TextLayout`
// is called per paragraph** — because that is where a document's first paint
// is won or lost.
//
// `TextLayout` does the expensive and difficult half already: UAX#14 break
// opportunities, OpenType shaping with a memo per inter-break segment, font
// fallback, bidi, and per-line UAX#9 reordering. Calling it **once** for a
// whole inline formatting context is therefore both the fastest and the most
// correct thing this can do, and it is what the common case does: a
// paragraph, a heading, a list item's line, a table cell.
//
// Two things break that. An **atomic** in the middle of the text — an image,
// an inline-block, a form control — which the text layout knows nothing
// about; and a **float**, which makes the available width differ line by
// line while `TextLayout` takes one `maxWidth`. Either drops this into a
// line-at-a-time loop that re-lays the remaining text per line. That loop is
// quadratic, and that is fine, because it *leaves* itself the moment nothing
// ahead can vary the width again: the tail of a long paragraph beside a
// floated image is one call, not one per line.
//
// The runs handed to `TextLayout` are richtext's `TextRun`s, and that is
// deliberate rather than incidental: ntk lets unknown span fields ride along
// and hands them back on the laid-out runs, so the decoration a `<span>`
// carries reaches paint on the same object the glyphs did — which is exactly
// the trick `<richtext>` is built on, and it is why paint reuses richtext's
// decoration pass unchanged instead of reimplementing it.
import type { Element } from 'domhandler';

import { codeUnitOffsets } from '../../internal/text.js';
import type { TextRun } from '../../richtext/index.js';
import type { ComputedStyle } from '../css/style.js';
import { inkColor, isTransparent } from '../css/values.js';
import type {
  AtomicPlacement,
  Box,
  LineBox,
  LineText,
  TextLayoutLike,
} from './boxes.js';
import type { FloatContext } from './floats.js';

/** The slice of ntk's font manager this needs. Structural, as everywhere. */
export interface FontsLike {
  layout(
    content: TextRun[],
    style: Record<string, unknown>,
    options: {
      maxWidth?: number;
      lineHeight?: number;
      align?: string;
      direction?: string;
      maxLines?: number;
    },
  ): TextLayoutLike;
  match(
    family: string,
    style: Record<string, unknown>,
  ): {
    metrics(size: number): {
      ascent: number;
      descent: number;
      lineHeight: number;
    };
  };
}

/**
 * The text behind a layout, for the one caller that needs it: a selection
 * band has to turn a document offset into a **code point** index, which is
 * what ntk's caret API speaks, and that conversion needs the string.
 *
 * Kept as the runs rather than the joined text, and joined on demand, because
 * the first paint never asks — only a selection does — and joining every
 * paragraph up front would be a string allocation per block for a feature
 * most documents are read without using.
 */
const LAYOUT_RUNS = new WeakMap<TextLayoutLike, TextRun[] | number[]>();

/** Code-unit → code-point offsets for a layout's text, built once. */
export function layoutOffsets(layout: TextLayoutLike): number[] {
  const held = LAYOUT_RUNS.get(layout);
  if (!held) return EMPTY_OFFSETS;
  if (typeof held[0] === 'number' || held.length === 0) return held as number[];
  const offsets = codeUnitOffsets(
    (held as TextRun[]).map((r) => r.text).join(''),
  );
  LAYOUT_RUNS.set(layout, offsets);
  return offsets;
}

const EMPTY_OFFSETS: number[] = [0];

/** One thing in the inline stream. */
type Item =
  | { kind: 'text'; run: TextRun; box: Box; length: number }
  | { kind: 'atomic'; box: Box };

export interface InlineResult {
  lines: LineBox[];
  height: number;
  /** The widest line — what a shrink-to-fit width takes. */
  width: number;
}

export interface InlineOptions {
  fonts: FontsLike | null;
  /** Content-box width available, before floats narrow it. */
  width: number;
  /** Where the first line starts, in the float context's coordinate space. */
  startY: number;
  floats: FloatContext | null;
  /** The block's content-box left edge, in the float context's space. */
  originX: number;
}

/**
 * Lay out one inline formatting context. Coordinates in the result are
 * relative to the containing block's content box; the caller translates.
 */
export function layoutInline(block: Box, options: InlineOptions): InlineResult {
  const fonts = options.fonts;
  const items: Item[] = [];
  collect(block, items);
  if (!items.length || !fonts) return EMPTY;

  const style = block.style;
  const base = {
    family: style.fontFamily,
    size: style.fontSize,
    weight: style.fontWeight,
    style: style.fontStyle,
    color: style.color,
  };
  const lineHeightMul = lineHeightMultiplier(fonts, style);
  const align = alignFor(style);
  const indent = indentOf(style, options.width);

  const hasAtomics = items.some((i) => i.kind === 'atomic');
  const floated = options.floats?.intersects(options.startY, Infinity) ?? false;

  // The text-only, float-free, unindented case: one call, every line.
  if (!hasAtomics && !floated && !indent) {
    const runs: TextRun[] = [];
    const spans = new SpanMap();
    for (const item of items) {
      if (item.kind === 'text') {
        spans.add(item.box.textStart, item.run.text.length);
        runs.push(item.run);
      }
    }
    if (!runs.length) return EMPTY;
    const layout = fonts.layout(runs, base, {
      maxWidth: wraps(style) ? options.width : undefined,
      lineHeight: lineHeightMul,
      align,
      direction: style.direction,
    });
    LAYOUT_RUNS.set(layout, runs);
    const lines: LineBox[] = [];
    let widest = 0;
    for (let i = 0; i < layout.lines.length; i += 1) {
      const natural = layout.lines[i];
      const text: LineText = {
        layout,
        layoutLine: i,
        drawX: 0,
        drawY: 0,
        textStart: spans.documentAt(natural.start),
        textEnd: spans.documentAt(natural.end),
        layoutStart: natural.start,
      };
      lines.push({
        x: natural.x,
        y: natural.y,
        width: natural.width,
        height: natural.height,
        baseline: natural.baseline,
        texts: [text],
        textStart: text.textStart,
        textEnd: text.textEnd,
        atomics: [],
      });
      widest = Math.max(widest, natural.width);
    }
    return { lines, height: layout.height, width: widest };
  }

  // --- the general case: line at a time -------------------------------------
  const lines: LineBox[] = [];
  let widest = 0;
  let y = 0;
  let index = 0;
  let offset = 0;
  let open = openLine(indent);

  const close = (): void => {
    const line = finishLine(open, y);
    if (!line) {
      open = openLine(0);
      return;
    }
    lines.push(line);
    widest = Math.max(widest, line.width);
    y += line.height;
    open = openLine(0);
  };

  while (index < items.length) {
    const band = bandAt(options, y, style.fontSize * 1.4);
    const available = band.right - band.left;
    const item = items[index];

    if (item.kind === 'atomic') {
      const box = item.box;
      const outer = box.width + box.marginLeft + box.marginRight;
      if (open.x > 0 && open.x + outer > available) {
        close();
        continue;
      }
      open.atomics.push({ box, x: band.left + open.x + box.marginLeft, y: 0 });
      open.x += outer;
      index += 1;
      continue;
    }

    const segment = segmentFrom(items, index, offset);
    // `segmentFrom` always passes at least the text item it started on, so
    // this advances even when the slice came out empty — which is what stops
    // a zero-length tail from spinning the loop.
    if (!segment.runs.length) {
      index = segment.nextIndex;
      offset = 0;
      continue;
    }

    // Once nothing ahead can narrow a line — no atomic left, an empty line
    // in hand, and no float at or below this y — the rest of the segment is
    // one layout, every line of it. This is the exit that keeps the loop
    // below from being quadratic on an ordinary paragraph: it runs line by
    // line only while it has to.
    const tailIsPlain =
      segment.nextIndex >= items.length &&
      open.x === 0 &&
      !open.atomics.length &&
      !(options.floats?.intersects(options.startY + y, Infinity) ?? false);
    if (tailIsPlain) {
      const layout = fonts.layout(segment.runs, base, {
        maxWidth: wraps(style) ? Math.max(1, available) : undefined,
        lineHeight: lineHeightMul,
        align,
        direction: style.direction,
      });
      LAYOUT_RUNS.set(layout, segment.runs);
      for (let i = 0; i < layout.lines.length; i += 1) {
        const natural = layout.lines[i];
        const text: LineText = {
          layout,
          layoutLine: i,
          drawX: band.left,
          drawY: y,
          textStart: segment.spans.documentAt(natural.start),
          textEnd: segment.spans.documentAt(natural.end),
          layoutStart: natural.start,
        };
        lines.push({
          x: band.left + natural.x,
          y: y + natural.y,
          width: natural.width,
          height: natural.height,
          baseline: natural.baseline,
          texts: [text],
          textStart: text.textStart,
          textEnd: text.textEnd,
          atomics: [],
        });
        widest = Math.max(widest, natural.width);
      }
      y += layout.height;
      index = segment.nextIndex;
      offset = 0;
      continue;
    }

    // One line: `maxLines: 1` cuts the layout at the first break and its
    // `truncated` flag answers "did the segment wrap" — so a line costs one
    // layout of one line, not a layout of the whole remaining tail plus a
    // re-cut (which is what an earlier shape paid, per line, beside every
    // float). ntk's shaping memo makes the successive cuts cheap; only the
    // line breaker re-runs.
    const room = Math.max(1, available - open.x);
    const fragment = fonts.layout(segment.runs, base, {
      maxWidth: wraps(style) ? room : undefined,
      lineHeight: lineHeightMul,
      // A fragment that does not start at the line's left edge cannot be
      // aligned by the text layout: the alignment belongs to the whole line,
      // which only this loop can see.
      align: open.x > 0 ? 'left' : align,
      direction: style.direction,
      maxLines: 1,
    });
    LAYOUT_RUNS.set(fragment, segment.runs);
    const first = fragment.lines[0];
    if (!first) {
      index = segment.nextIndex;
      offset = 0;
      continue;
    }
    open.texts.push({
      layout: fragment,
      layoutLine: 0,
      // The layout's own `first.x` carries the alignment offset, so the
      // origin is the band edge plus the cursor — subtracting `first.x`
      // here would left-align a centred line. Mid-line continuations were
      // laid out `left`, where `first.x` is zero and the two agree.
      drawX: band.left + open.x,
      drawY: 0, // filled in by `finishLine`, which is where the top is known
      textStart: segment.spans.documentAt(first.start),
      textEnd: segment.spans.documentAt(first.end),
      layoutStart: first.start,
    });
    open.x += first.width;
    open.left = band.left;

    if (!fragment.truncated) {
      // It fitted: the cursor stays on this line for whatever comes next.
      index = segment.nextIndex;
      offset = 0;
      continue;
    }
    close();
    const advanced = advance(items, index, offset, first.end);
    index = advanced.index;
    offset = advanced.offset;
  }

  if (open.texts.length || open.atomics.length) close();

  return { lines, height: y, width: widest };
}

const EMPTY: InlineResult = { lines: [], height: 0, width: 0 };

// --- the line under construction --------------------------------------------

interface OpenLine {
  /** How much of the line is used, from `left`. */
  x: number;
  left: number;
  texts: LineText[];
  atomics: AtomicPlacement[];
}

function openLine(indent: number): OpenLine {
  return { x: indent, left: 0, texts: [], atomics: [] };
}

function finishLine(open: OpenLine, y: number): LineBox | null {
  if (!open.texts.length && !open.atomics.length) return null;
  let ascent = 0;
  let descent = 0;
  let height = 0;
  for (const text of open.texts) {
    const natural = text.layout.lines[text.layoutLine];
    ascent = Math.max(ascent, natural.baseline);
    descent = Math.max(descent, natural.height - natural.baseline);
    height = Math.max(height, natural.height);
  }
  for (const placed of open.atomics) {
    const h =
      placed.box.height + placed.box.marginTop + placed.box.marginBottom;
    const va = placed.box.style.verticalAlign;
    if (va === 'top' || va === 'bottom' || va === 'middle')
      height = Math.max(height, h);
    else ascent = Math.max(ascent, h);
  }
  height = Math.max(height, ascent + descent);
  const baseline = Math.max(ascent, (height - ascent - descent) / 2 + ascent);

  let textStart = Infinity;
  let textEnd = 0;
  for (const text of open.texts) {
    textStart = Math.min(textStart, text.textStart);
    textEnd = Math.max(textEnd, text.textEnd);
  }
  const line: LineBox = {
    x: open.left,
    y,
    width: open.x,
    height,
    baseline,
    texts: open.texts,
    textStart: Number.isFinite(textStart) ? textStart : 0,
    textEnd,
    atomics: open.atomics,
  };
  for (const placed of open.atomics)
    placed.y = y + alignAtomic(placed.box, line);
  // Every fragment on this line shares the line's baseline, whatever its own
  // layout thinks: that is what makes a small `<sup>` beside body text sit on
  // the same baseline rather than on its own.
  for (const text of open.texts) {
    const natural = text.layout.lines[text.layoutLine];
    text.drawY = y + baseline - natural.baseline - natural.y;
  }
  return line;
}

/** Where an atomic's top edge sits, relative to the line box top. */
function alignAtomic(box: Box, line: LineBox): number {
  const h = box.height + box.marginTop + box.marginBottom;
  switch (box.style.verticalAlign) {
    case 'top':
      return 0;
    case 'bottom':
      return line.height - h;
    case 'middle':
      return (line.height - h) / 2;
    case 'sub':
      return line.baseline - h + line.height * 0.1;
    case 'super':
      return line.baseline - h - line.height * 0.25;
    default:
      if (typeof box.style.verticalAlign === 'number') {
        return line.baseline - h - box.style.verticalAlign;
      }
      return line.baseline - h;
  }
}

// --- gathering --------------------------------------------------------------

/** Flatten an inline subtree into a stream of runs, atomics and breaks. */
function collect(box: Box, out: Item[]): void {
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    switch (child.kind) {
      case 'text':
        if (child.text) {
          out.push({
            kind: 'text',
            run: runFor(child.text, child.style, child.el),
            box: child,
            length: child.text.length,
          });
        }
        break;
      case 'break':
        // A `<br>` is a newline *character* in the stream, not a control
        // item: ntk's breaker treats `\n` as a required break, gives the
        // blank line between two of them real font metrics, and both paths
        // — the one-layout fast path and the line-at-a-time one — then
        // handle it identically. (An earlier shape kept breaks as their own
        // item kind and the fast path, which only reads text items, dropped
        // them: `a<br>b` rendered as one line.) The box builder gave the
        // break its slot in the document index, so the span map lines up.
        out.push({
          kind: 'text',
          run: {
            text: '\n',
            family: child.style.fontFamily,
            size: child.style.fontSize,
          },
          box: child,
          length: 1,
        });
        break;
      case 'inline':
        collect(child, out);
        break;
      default:
        // Everything else that reached an inline context is inline-level and
        // atomic: a replaced element, an `inline-block`, an `inline-table`.
        out.push({ kind: 'atomic', box: child });
        break;
    }
  }
}

/** The `TextRun` one styled piece of text becomes. */
function runFor(
  text: string,
  style: ComputedStyle,
  owner: Element | null,
): TextRun {
  // ntk hands unknown span fields back on the laid-out runs untouched, which
  // is how the element reaches the paint and hit-test passes without a
  // parallel structure to keep in step.
  const run: TextRun & { element?: Element } = {
    text,
    family: style.fontFamily,
    size: style.fontSize,
    weight: style.fontWeight,
    style: style.fontStyle === 'normal' ? 'normal' : 'italic',
    color: style.color,
  };
  // An inline background fills the line box rather than hugging the ink:
  // `<span style="background: yellow">` is a highlighter, and two adjacent
  // highlighted spans must not leave a seam between them. That is exactly
  // what richtext's `bgFill: 'line'` was added for.
  if (!isTransparent(style.backgroundColor)) {
    run.bg = inkColor(style.backgroundColor as string, style.color);
    run.bgFill = 'line';
  }
  if (owner) run.element = owner;
  if (style.textDecorationLine === 'underline') {
    run.underline = inkColor(
      style.textDecorationColor ?? 'currentColor',
      style.color,
    );
    // CSS's five rule styles and SGR 4's five are the same set under two
    // names; richtext speaks SGR's, so `solid` is `single` and `wavy` is
    // `curly`. The other three are spelled identically.
    run.underlineStyle =
      style.textDecorationStyle === 'wavy'
        ? 'curly'
        : style.textDecorationStyle === 'solid'
          ? 'single'
          : style.textDecorationStyle;
  } else if (style.textDecorationLine === 'line-through') {
    run.strike = inkColor(
      style.textDecorationColor ?? 'currentColor',
      style.color,
    );
  }
  return run;
}

/**
 * Maps a code-unit offset in text handed to `TextLayout` back to its offset
 * in the document index. The two differ because a layout covers one segment
 * of the stream while the document index covers all of it.
 */
class SpanMap {
  private _laid: number[] = [];
  private _doc: number[] = [];
  laidOut = 0;

  add(documentStart: number, length: number): void {
    this._laid.push(this.laidOut);
    this._doc.push(documentStart);
    this.laidOut += length;
  }

  documentAt(offset: number): number {
    const laid = this._laid;
    if (!laid.length) return 0;
    let lo = 0;
    let hi = laid.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (laid[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return this._doc[lo] + (offset - laid[lo]);
  }
}

interface Segment {
  runs: TextRun[];
  spans: SpanMap;
  nextIndex: number;
}

/** The maximal run of text items from `(index, offset)` to the next atomic. */
function segmentFrom(items: Item[], index: number, offset: number): Segment {
  const runs: TextRun[] = [];
  const spans = new SpanMap();
  let i = index;
  let skip = offset;
  for (; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind !== 'text') break;
    const text = skip > 0 ? item.run.text.slice(skip) : item.run.text;
    if (text) {
      spans.add(item.box.textStart + skip, text.length);
      runs.push(skip > 0 ? { ...item.run, text } : item.run);
    }
    skip = 0;
  }
  return { runs, spans, nextIndex: i };
}

/** Move `(index, offset)` forward by `consumed` code units of text. */
function advance(
  items: Item[],
  index: number,
  offset: number,
  consumed: number,
): { index: number; offset: number } {
  let i = index;
  let skip = offset;
  let left = consumed;
  while (i < items.length) {
    const item = items[i];
    if (item.kind !== 'text') break;
    const remaining = item.length - skip;
    if (left < remaining) return { index: i, offset: skip + left };
    left -= remaining;
    skip = 0;
    i += 1;
  }
  return { index: i, offset: 0 };
}

// --- style questions --------------------------------------------------------

function wraps(style: ComputedStyle): boolean {
  return style.whiteSpace !== 'nowrap' && style.whiteSpace !== 'pre';
}

function alignFor(style: ComputedStyle): string {
  // ntk has no justification; `start` is closer than a silent left on an RTL
  // paragraph, and closer than a ragged-right lie about what was drawn.
  return style.textAlign === 'justify' ? 'start' : style.textAlign;
}

function indentOf(style: ComputedStyle, width: number): number {
  const indent = style.textIndent;
  if (typeof indent === 'number') return indent;
  if (indent === 'auto') return 0;
  return Number.isFinite(width) ? (indent.pct / 100) * width : 0;
}

/**
 * CSS's `line-height` expressed as ntk's multiplier.
 *
 * ntk multiplies the **font's natural line height** (metrics, line gap
 * included); CSS's number form multiplies the **font size**. Converting here
 * rather than passing the CSS number through is the difference between
 * `line-height: 1.5` meaning 1.5 × 16px and it meaning 1.5 × 19px, which is
 * a visibly looser document than the author asked for.
 */
function lineHeightMultiplier(fonts: FontsLike, style: ComputedStyle): number {
  if (style.lineHeight === 'normal') return 1;
  const target = style.lineHeightIsLength
    ? (style.lineHeight as number)
    : (style.lineHeight as number) * style.fontSize;
  const natural = naturalLineHeight(fonts, style);
  if (!natural) return 1;
  return Math.max(0.1, target / natural);
}

function naturalLineHeight(fonts: FontsLike, style: ComputedStyle): number {
  try {
    const font = fonts.match(style.fontFamily, {
      size: style.fontSize,
      weight: style.fontWeight,
      style: style.fontStyle,
    });
    return font.metrics(style.fontSize).lineHeight;
  } catch {
    return style.fontSize * 1.2;
  }
}

function bandAt(
  options: InlineOptions,
  y: number,
  height: number,
): { left: number; right: number } {
  if (!options.floats) return { left: 0, right: options.width };
  const band = options.floats.bandAt(options.startY + y, height);
  return {
    left: Math.max(0, band.left - options.originX),
    right: Math.min(options.width, band.right - options.originX),
  };
}
