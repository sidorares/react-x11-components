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
// decoration pass unchanged instead of reimplementing it. What a run does
// *not* carry is its element: a layout outlives the parse it was made for
// (`TextLayoutCache`), so the element under a run is found from its text's
// place in the document (`LineText.spans`) instead.

import { codeUnitOffsets } from '../../internal/text.js';
import type { TextRun } from '../../richtext/index.js';
import type { ComputedStyle } from '../css/style.js';
import { inkColor, isTransparent, resolve } from '../css/values.js';
import type {
  AtomicPlacement,
  Box,
  EdgePlacement,
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

/** One thing in the inline stream. An `edge` is an inline box's own margin,
 *  border and padding on one side — before its first fragment, or after its
 *  last (CSS 2.1 8.x, 10.3.1) — which takes room on the line and draws no
 *  glyph. */
type Item =
  | {
      kind: 'text';
      run: TextRun;
      box: Box;
      length: number;
      /** Where the run's text starts in the document index: its box's
       *  start, or further in, where the box's text is split. */
      start: number;
    }
  | { kind: 'atomic'; box: Box }
  | { kind: 'edge'; box: Box; side: 'start' | 'end'; width: number };

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
  collect(block, items, options.width, fonts);
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

  // an inline box's edges take room on their lines, which one layout of the
  // text cannot give them
  const hasAtomics = items.some((i) => i.kind !== 'text');
  const floated = options.floats?.intersects(options.startY, Infinity) ?? false;

  // The text-only, float-free, unindented case: one call, every line — or
  // one call per *chunk*, when the text is long and carries hard breaks.
  if (!hasAtomics && !floated && !indent) {
    // `hasAtomics` is false, so every item is text; the cast is that fact.
    const textItems = items as Extract<Item, { kind: 'text' }>[];
    let total = 0;
    let hasNewline = false;
    for (const item of textItems) {
      total += item.length;
      if (!hasNewline && item.run.text.includes('\n')) hasNewline = true;
    }
    if (!total) return EMPTY;
    if (total > CHUNK_TRIGGER_CHARS && hasNewline) {
      return layoutChunked(
        textItems,
        base,
        style,
        options.width,
        lineHeightMul,
        align,
        fonts,
      );
    }
    const runs: TextRun[] = [];
    const spans = new SpanMap();
    for (const item of textItems) {
      spans.add(item.start, item.run.text.length, item.box);
      runs.push(item.run);
    }
    const layout = fonts.layout(runs, base, {
      maxWidth: wraps(style) ? options.width : undefined,
      lineHeight: lineHeightMul,
      align,
      direction: style.direction,
    });
    LAYOUT_RUNS.set(layout, runs);
    const lines: LineBox[] = [];
    const widest = emitLayout(layout, spans, 0, 0, lines);
    return { lines, height: layout.height, width: widest };
  }

  // --- the general case: line at a time -------------------------------------
  const lines: LineBox[] = [];
  let widest = 0;
  let y = 0;
  let index = 0;
  let offset = 0;
  let open = openLine(indent);
  /** Start edges waiting for the content they belong to: an inline box's
   *  opening margin, border and padding go on the line its first content
   *  goes on, so they are placed with it, never left at a line's end. */
  let pending: Extract<Item, { kind: 'edge' }>[] = [];
  let pendingWidth = 0;
  const placePending = (left: number): void => {
    if (pending.length) open.left = left;
    for (const edge of pending) {
      const placed: EdgePlacement = {
        box: edge.box,
        side: 'start',
        x: left + open.x,
        width: edge.width,
      };
      open.edges.push(placed);
      open.order.push({ kind: 'edge', at: open.x, item: placed });
      open.x += edge.width;
    }
    pending = [];
    pendingWidth = 0;
  };

  const close = (): void => {
    const line = finishLine(
      open,
      y,
      // the room beside the floats over the whole line box, which an
      // inline-block can make taller than its text (CSS 2.1 9.5)
      (height) => bandAt(options, y, Math.max(height, style.fontSize * 1.4)),
      lineShift(style),
      style.direction === 'rtl',
    );
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

    if (item.kind === 'edge') {
      if (item.side === 'start') {
        pending.push(item);
        pendingWidth += item.width;
      } else {
        // an end edge follows the content it closes onto its line; it may
        // run past the line's end, as a trailing space does, rather than
        // leave the content it closes
        placePending(band.left);
        const placed: EdgePlacement = {
          box: item.box,
          side: 'end',
          x: band.left + open.x,
          width: item.width,
        };
        open.edges.push(placed);
        open.order.push({ kind: 'edge', at: open.x, item: placed });
        open.x += item.width;
        open.left = band.left;
      }
      index += 1;
      continue;
    }

    if (item.kind === 'atomic') {
      const box = item.box;
      const outer = box.width + box.marginLeft + box.marginRight;
      if (open.x > 0 && open.x + pendingWidth + outer > available) {
        close();
        continue;
      }
      // an inline-block wider than the room a float left goes below it,
      // as a word does (below)
      if (
        isEmpty(open) &&
        pendingWidth + outer > available &&
        available < options.width
      ) {
        const below = belowFloats(options, y, style.fontSize * 1.4);
        if (below !== null) {
          y = below;
          continue;
        }
      }
      placePending(band.left);
      const placed: AtomicPlacement = {
        box,
        x: band.left + open.x + box.marginLeft,
        y: 0,
      };
      open.atomics.push(placed);
      open.order.push({ kind: 'atomic', at: open.x, item: placed });
      open.x += outer;
      open.hang = 0;
      open.left = band.left;
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
      !pending.length &&
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
          spans: segment.spans,
        };
        lines.push({
          x: band.left + natural.x,
          y: y + natural.y,
          width: natural.width,
          height: natural.height,
          baseline: natural.baseline - natural.y,
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
    const room = Math.max(1, available - open.x - pendingWidth);
    const fragment = fonts.layout(segment.runs, base, {
      maxWidth: wraps(style) ? room : undefined,
      lineHeight: lineHeightMul,
      // Never aligned by the text layout: the alignment belongs to the whole
      // line — its text, its atomics and its inline boxes' edges together —
      // which only this loop can see, and `finishLine` shifts it all. Laid
      // out aligned, the first fragment of a centred line was centred alone
      // and whatever followed it on the line was placed as though it had
      // not been, over it.
      align: 'left',
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
    // Nothing fits beside the floats — the first word is wider than the
    // room they leave, and was either run past it or cut inside itself to
    // fit — so the line moves down to where a float ends, and tries again
    // there (CSS 2.1 9.5). Only where a float took some of the line's width:
    // past the floats the line has the whole of it, and a word wider still
    // is the engine's to break. A line that ends on white space fitted its
    // word: the space hangs, and CoreText counted it in the width until
    // @windowkit/appkit 0.15.0.
    if (
      isEmpty(open) &&
      available < options.width &&
      tooNarrow(segment.runs, first.end, first.width, room)
    ) {
      const below = belowFloats(options, y, style.fontSize * 1.4);
      if (below !== null) {
        y = below;
        continue;
      }
    }
    // An inline box's opening edge goes with the first word after it: where
    // the word does not fit the room the edge leaves, both go to the next
    // line, rather than the edge being left at this one's end.
    if (
      pendingWidth > 0 &&
      !isEmpty(open) &&
      tooNarrow(segment.runs, first.end, first.width, room)
    ) {
      close();
      continue;
    }
    placePending(band.left);
    const placed: LineText = {
      layout: fragment,
      layoutLine: 0,
      // laid out `left`, so the fragment starts at the cursor
      drawX: band.left + open.x,
      drawY: 0, // filled in by `finishLine`, which is where the top is known
      textStart: segment.spans.documentAt(first.start),
      textEnd: segment.spans.documentAt(first.end),
      layoutStart: first.start,
      spans: segment.spans,
    };
    open.texts.push(placed);
    open.order.push({
      kind: 'text',
      at: open.x,
      item: placed,
      reads: readingOf(segment.runs, first.start, first.end),
    });
    open.x += first.width;
    open.left = band.left;
    open.hang = 0;

    // Did the segment wrap? ntk answers with `truncated`. A layout that does
    // not carry the flag — react-x11's Cocoa engine reports none — is asked
    // the same of its line ends instead: it wrapped if anything but
    // whitespace follows the first line. Read as "fitted", a cut fragment
    // advanced past the whole segment, and a paragraph beside a float lost
    // every line after its first. And a line that ends at a `<br>` is over
    // whether or not anything followed it in this segment: what comes next
    // — an atomic, an element's edge — is the next line's.
    const wrapped =
      breakBefore(segment.runs, first.end) ||
      (fragment.truncated ?? inkBeyond(segment.runs, first.end));
    if (!wrapped) {
      // It fitted: the cursor stays on this line for whatever comes next.
      //
      // With one correction first. ntk strips a line's trailing whitespace —
      // right at a real line end, wrong here, where the "line" is only a
      // fragment and an atomic follows on the same one: `Name <input>` laid
      // the space out to width zero and the control sat flush against the
      // label (nbsp included; ntk's whitespace set has U+00A0 in it). The
      // stripped advance is measured back and added to the cursor.
      if (segment.nextIndex < items.length) {
        let trailing = '';
        for (let i = segment.runs.length - 1; i >= 0; i -= 1) {
          const text = segment.runs[i].text;
          const m = /[ \t\u00A0]+$/.exec(text);
          if (!m) break;
          trailing = m[0] + trailing;
          if (m[0].length < text.length) break;
        }
        if (trailing) {
          // and noted: if what follows goes to the next line after all,
          // these spaces end this one, where CSS removes them (16.6.1)
          open.hang =
            spaceAdvance(fonts, segment.runs[segment.runs.length - 1]) *
            trailing.length;
          open.x += open.hang;
        }
      }
      index = segment.nextIndex;
      offset = 0;
      continue;
    }
    close();
    const advanced = advance(items, index, offset, first.end);
    index = advanced.index;
    offset = advanced.offset;
  }

  if (pending.length)
    placePending(bandAt(options, y, style.fontSize * 1.4).left);
  if (open.texts.length || open.atomics.length || open.edges.length) close();

  return { lines, height: y, width: widest };
}

const EMPTY: InlineResult = { lines: [], height: 0, width: 0 };

/** Append one layout's lines as LineBoxes at an offset; returns the widest. */
function emitLayout(
  layout: TextLayoutLike,
  spans: SpanMap,
  xOff: number,
  yOff: number,
  lines: LineBox[],
): number {
  let widest = 0;
  for (let i = 0; i < layout.lines.length; i += 1) {
    const natural = layout.lines[i];
    const text: LineText = {
      layout,
      layoutLine: i,
      drawX: xOff,
      drawY: yOff,
      textStart: spans.documentAt(natural.start),
      textEnd: spans.documentAt(natural.end),
      layoutStart: natural.start,
      spans,
    };
    lines.push({
      x: xOff + natural.x,
      y: yOff + natural.y,
      width: natural.width,
      height: natural.height,
      baseline: natural.baseline - natural.y,
      texts: [text],
      textStart: text.textStart,
      textEnd: text.textEnd,
      atomics: [],
    });
    widest = Math.max(widest, natural.width);
  }
  return widest;
}

/** Chunking kicks in past this much text (with hard breaks in it). The
 *  chunk bounds are sized to the *drawing*, not the layout: a chunk is one
 *  glyph batch, an expose submits every batch it touches whole, and a strip
 *  two lines tall should not pay for five hundred — 64 hard lines is a
 *  couple of viewports, measured at well under a millisecond a batch. */
const CHUNK_TRIGGER_CHARS = 16384;
const CHUNK_MAX_CHARS = 8192;
const CHUNK_MAX_HARD_LINES = 64;

/**
 * A long hard-broken text — a `<pre>` holding a log, a wall of `<br>`s — laid
 * out as a sequence of layouts split at newline boundaries.
 *
 * Two reasons, and either would suffice. A single `TextLayout` spanning
 * hundreds of thousands of pixels cannot be *drawn*: ntk emits a layout as
 * one glyph batch, X carries the positions as Int16, and the skip guard that
 * keeps that from crashing would keep the whole thing blank instead. And a
 * monolithic layout defeats viewport culling — every paint would hold the
 * one object every line shares. Splitting at hard breaks is exact (line
 * breaking never crosses a required break), so the chunk seams are
 * invisible; each chunk stays a single batch a viewport can keep whole.
 */
function layoutChunked(
  items: Extract<Item, { kind: 'text' }>[],
  base: Record<string, unknown>,
  style: ComputedStyle,
  width: number,
  lineHeightMul: number,
  align: string,
  fonts: FontsLike,
): InlineResult {
  const lines: LineBox[] = [];
  let widest = 0;
  let y = 0;

  let chunkRuns: TextRun[] = [];
  let chunkSpans = new SpanMap();
  let chars = 0;
  let hardLines = 0;

  const flush = (): void => {
    if (!chunkRuns.length) return;
    const layout = fonts.layout(chunkRuns, base, {
      maxWidth: wraps(style) ? width : undefined,
      lineHeight: lineHeightMul,
      align,
      direction: style.direction,
    });
    LAYOUT_RUNS.set(layout, chunkRuns);
    widest = Math.max(widest, emitLayout(layout, chunkSpans, 0, y, lines));
    y += layout.height;
    chunkRuns = [];
    chunkSpans = new SpanMap();
    chars = 0;
    hardLines = 0;
  };

  for (const item of items) {
    let text = item.run.text;
    let docStart = item.start;
    while (text.length) {
      // Scan up to the budgets, remembering the last newline: the split has
      // to land just after one for the chunking to be exact.
      let i = 0;
      let lastBreak = -1;
      let lines2 = hardLines;
      let taken = chars;
      while (
        i < text.length &&
        taken < CHUNK_MAX_CHARS &&
        lines2 < CHUNK_MAX_HARD_LINES
      ) {
        if (text.charCodeAt(i) === 10) {
          lines2 += 1;
          lastBreak = i;
        }
        i += 1;
        taken += 1;
      }
      if (i >= text.length) {
        // the rest of this run fits the open chunk
        chunkRuns.push(
          text === item.run.text ? item.run : { ...item.run, text },
        );
        chunkSpans.add(docStart, text.length, item.box);
        chars = taken;
        hardLines = lines2;
        break;
      }
      if (lastBreak < 0) {
        if (chunkRuns.length) {
          // no break inside the budget: close the chunk, retry with room
          flush();
          continue;
        }
        // a single unbroken stretch larger than a whole chunk: take it to
        // its next newline (or its end) and let the overflow guard judge it
        const next = text.indexOf('\n', i);
        const end = next < 0 ? text.length : next + 1;
        chunkRuns.push({ ...item.run, text: text.slice(0, end) });
        chunkSpans.add(docStart, end, item.box);
        flush();
        docStart += end;
        text = text.slice(end);
        continue;
      }
      const cut = lastBreak + 1;
      chunkRuns.push({ ...item.run, text: text.slice(0, cut) });
      chunkSpans.add(docStart, cut, item.box);
      flush();
      docStart += cut;
      text = text.slice(cut);
    }
  }
  flush();
  return { lines, height: y, width: widest };
}

// --- the line under construction --------------------------------------------

interface OpenLine {
  /** How much of the line is used, from `left`. */
  x: number;
  left: number;
  texts: LineText[];
  atomics: AtomicPlacement[];
  edges: EdgePlacement[];
  /** All of the above in the order they were placed, which is the logical
   *  order, and where on the line each began: what a line with
   *  right-to-left text on it is put into visual order by. */
  order: Placed[];
  /** The advance of the spaces the line ends with, kept in `x` for what
   *  may follow them on it and no part of the line if nothing does. */
  hang: number;
}

type Placed =
  | { kind: 'text'; at: number; item: LineText; reads: Reading }
  | { kind: 'atomic'; at: number; item: AtomicPlacement }
  | { kind: 'edge'; at: number; item: EdgePlacement };

/** Which way a fragment's letters read: all one way, both, or neither —
 *  spaces, digits and punctuation, which are neutrals. */
type Reading = 'ltr' | 'rtl' | 'mixed' | null;

function openLine(indent: number): OpenLine {
  return {
    x: indent,
    left: 0,
    texts: [],
    atomics: [],
    edges: [],
    order: [],
    hang: 0,
  };
}

/**
 * Close a line: its height and baseline from what is on it, then where it
 * sits — in the room `bandFor` answers for a line that tall, and aligned in
 * it by `shift` of the room it did not use (0 flush left, 1 flush right, ½
 * centred), moved onto every text, atomic and edge on it at once.
 */
function finishLine(
  open: OpenLine,
  y: number,
  bandFor: (height: number) => { left: number; right: number },
  shift: number,
  rtl: boolean,
): LineBox | null {
  if (!open.texts.length && !open.atomics.length && !open.edges.length) {
    return null;
  }
  if (open.order.some((p) => needsOrdering(p, rtl))) reorderLine(open, rtl);
  let ascent = 0;
  let descent = 0;
  let height = 0;
  for (const text of open.texts) {
    const natural = text.layout.lines[text.layoutLine];
    const own = natural.baseline - natural.y;
    ascent = Math.max(ascent, own);
    descent = Math.max(descent, natural.height - own);
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

  // Placed beside the floats at the text's height; a float the whole line
  // reaches moves it, and the alignment divides the room that is left.
  const band = bandFor(height);
  const used = open.x - open.hang;
  const free = band.right - band.left - used;
  let dx = band.left - open.left;
  if (shift > 0 && Number.isFinite(free) && free > 0) dx += free * shift;
  if (dx) {
    for (const text of open.texts) text.drawX += dx;
    for (const placed of open.atomics) placed.x += dx;
    for (const edge of open.edges) edge.x += dx;
    open.left += dx;
  }

  let textStart = Infinity;
  let textEnd = 0;
  for (const text of open.texts) {
    textStart = Math.min(textStart, text.textStart);
    textEnd = Math.max(textEnd, text.textEnd);
  }
  const line: LineBox = {
    x: open.left,
    y,
    width: used,
    height,
    baseline,
    texts: open.texts,
    textStart: Number.isFinite(textStart) ? textStart : 0,
    textEnd,
    atomics: open.atomics,
    ...(open.edges.length ? { edges: open.edges } : null),
  };
  for (const placed of open.atomics)
    placed.y = y + alignAtomic(placed.box, line);
  // Every fragment on this line shares the line's baseline, whatever its own
  // layout thinks: that is what makes a small `<sup>` beside body text sit on
  // the same baseline rather than on its own.
  for (const text of open.texts) {
    const natural = text.layout.lines[text.layoutLine];
    text.drawY = y + baseline - natural.baseline;
  }
  return line;
}

/**
 * Put a line's pieces in visual order. The text and the atomics first, by
 * UAX #9's L2 over pieces rather than characters: a fragment is in order
 * inside itself already — the engine laid it out bidirectionally — so what
 * is left to order is the fragments and the atomics between them, each at
 * a level — a fragment the direction its letters read in, or the
 * paragraph's where they read both ways, and a neutral (an atomic, a
 * fragment of spaces and digits) its neighbours' where they agree and the
 * paragraph's where they do not (N1, N2).
 *
 * Then each element's edges, innermost first, around what of it is on the
 * line: CSS 2.1 8.6 puts an ltr element's left margin, border and padding
 * on its leftmost box and a rtl one's right ones on its rightmost, which is
 * a matter of its `direction` rather than of which way its text reads — so
 * an edge is placed beside its element's pieces, never ordered among them.
 * Each piece keeps the room it took, and a right-to-left fragment's hung
 * trailing space goes to its left, where its logical end is.
 */
function reorderLine(open: OpenLine, rtl: boolean): void {
  const order = open.order;
  const n = order.length;
  if (!n) return;
  const content: number[] = [];
  for (let i = 0; i < n; i += 1) if (order[i].kind !== 'edge') content.push(i);
  const strong = content.map((i): boolean | null => {
    const p = order[i];
    if (p.kind !== 'text' || p.reads === null) return null;
    return p.reads === 'mixed' ? rtl : p.reads === 'rtl';
  });
  const strongAt = (from: number, step: number): boolean => {
    for (let k = from + step; k >= 0 && k < content.length; k += step) {
      if (strong[k] !== null) return strong[k]!;
    }
    return rtl;
  };
  const isRtl = strong.map((r, k) => {
    if (r !== null) return r;
    const before = strongAt(k, -1);
    return before === strongAt(k, 1) ? before : rtl;
  });
  // R is level 1 in either paragraph; L is 0 in a left-to-right one and 2
  // in a right-to-left one
  const levels = isRtl.map((r) => (r ? 1 : rtl ? 2 : 0));
  const visual = content.map((_, k) => k);
  for (let level = Math.max(0, ...levels); level >= 1; level -= 1) {
    for (let a = 0; a < visual.length;) {
      if (levels[visual[a]] < level) {
        a += 1;
        continue;
      }
      let b = a;
      while (b < visual.length && levels[visual[b]] >= level) b += 1;
      for (let i = a, j = b - 1; i < j; i += 1, j -= 1) {
        [visual[i], visual[j]] = [visual[j], visual[i]];
      }
      a = b;
    }
  }
  const seq = visual.map((k) => content[k]);

  const elements = new Map<Box, { start: number | null; end: number | null }>();
  for (let i = 0; i < n; i += 1) {
    const p = order[i];
    if (p.kind !== 'edge') continue;
    const sides = elements.get(p.item.box) ?? { start: null, end: null };
    sides[p.item.side] = i;
    elements.set(p.item.box, sides);
  }
  const inside = [...elements].sort(([a], [b]) => depthOf(b) - depthOf(a));
  for (const [box, { start, end }] of inside) {
    // what of the element is on this line: everything between its edges,
    // or the line's end where one of them is on another line
    const from = start ?? -1;
    const to = end ?? n;
    let lo = -1;
    let hi = -1;
    for (let k = 0; k < seq.length; k += 1) {
      if (seq[k] > from && seq[k] < to) {
        if (lo < 0) lo = k;
        hi = k;
      }
    }
    if (lo < 0) {
      // Nothing of it here but its edges: they go where it is in the text,
      // after what comes before it, in the paragraph's direction.
      let at = rtl ? seq.length : 0;
      for (let i = from - 1; i >= 0; i -= 1) {
        const k = seq.indexOf(i);
        if (k >= 0) {
          at = rtl ? k : k + 1;
          break;
        }
      }
      lo = at;
      hi = at - 1;
    }
    const ltr = box.style.direction !== 'rtl';
    const left = ltr ? start : end;
    const right = ltr ? end : start;
    if (right !== null) seq.splice(hi + 1, 0, right);
    if (left !== null) seq.splice(lo, 0, left);
  }

  let x = order[0].at;
  for (const i of seq) {
    const piece = order[i];
    const room = (i + 1 < n ? order[i + 1].at : open.x) - piece.at;
    let dx = x - piece.at;
    if (piece.kind === 'text') {
      const natural = piece.item.layout.lines[piece.item.layoutLine];
      const k = content.indexOf(i);
      if (isRtl[k] && natural) dx += Math.max(0, room - natural.width);
      piece.item.drawX += dx;
    } else {
      piece.item.x += dx;
    }
    x += room;
  }
}

/** Whether a piece can be out of place in logical order: anything on a
 *  right-to-left line, a fragment that reads right to left, or the edge of
 *  an element whose direction is not the line's. A line of left-to-right
 *  text, the common one, is placed as it was built. */
function needsOrdering(piece: Placed, rtl: boolean): boolean {
  if (rtl) return true;
  if (piece.kind === 'text') return piece.reads === 'rtl';
  return piece.kind === 'edge' && piece.item.box.style.direction === 'rtl';
}

/** How deep a box is in the tree — an element inside another is deeper. */
export function depthOf(box: Box): number {
  let depth = 0;
  for (let at = box.parent; at; at = at.parent) depth += 1;
  return depth;
}

/**
 * Which way the text from `start` to `end` of a segment's runs reads, from
 * its letters. Asked of the text rather than of the engine's runs: a run of
 * the space before a word reads the paragraph's way wherever it starts a
 * fragment, which says nothing about the word, and an engine may not say
 * which way its runs went at all.
 */
function readingOf(runs: TextRun[], start: number, end: number): Reading {
  let right = false;
  let left = false;
  let at = 0;
  for (const run of runs) {
    const length = run.text.length;
    const from = Math.max(start, at);
    const to = Math.min(end, at + length);
    if (to > from) {
      const text =
        to - from === length ? run.text : run.text.slice(from - at, to - at);
      right ||= RIGHT_TO_LEFT.test(text);
      left ||= LEFT_TO_RIGHT.test(text);
    }
    at += length;
    if (at >= end) break;
  }
  return right ? (left ? 'mixed' : 'rtl') : left ? 'ltr' : null;
}

/** A letter of a script written right to left — Hebrew, Arabic, Syriac,
 *  Thaana, N'Ko and their neighbours, their presentation forms, and the
 *  supplementary planes' right-to-left blocks — and any other letter. */
const RIGHT_TO_LEFT =
  /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LEFT_TO_RIGHT =
  /(?![\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}])\p{L}/u;

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

/** Flatten an inline subtree into a stream of runs, atomics, breaks and the
 *  edges of the inline boxes the text sits in. */
function collect(
  box: Box,
  out: Item[],
  width: number,
  fonts: FontsLike | null,
): void {
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    switch (child.kind) {
      case 'text':
        if (child.text) {
          const run = runFor(child.text, child.style);
          if (child.style.wordSpacing) {
            wordSpaced(out, child, run, child.style.wordSpacing);
          } else {
            out.push({
              kind: 'text',
              run,
              box: child,
              length: child.text.length,
              start: child.textStart,
            });
          }
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
          start: child.textStart,
        });
        break;
      case 'inline': {
        const [start, end] = inlineEdges(child, width, fonts);
        // Both edges or neither, so that an element with any is bounded on
        // the line: its pieces are what lies between them, which is how a
        // right-to-left line finds them (`reorderLine`), and how a rounded
        // background knows the fragments that open and close it, to round
        // only those corners — so it gets them even at width zero.
        const edged =
          start > 0 ||
          end > 0 ||
          (child.decorated && child.style.borderRadius.some((r) => r > 0));
        if (edged) {
          out.push({ kind: 'edge', box: child, side: 'start', width: start });
        }
        collect(child, out, width, fonts);
        if (edged) {
          out.push({ kind: 'edge', box: child, side: 'end', width: end });
        }
        break;
      }
      default:
        // Everything else that reached an inline context is inline-level and
        // atomic: a replaced element, an `inline-block`, an `inline-table`.
        out.push({ kind: 'atomic', box: child });
        break;
    }
  }
}

/**
 * A text box with `word-spacing`, as runs of its words and of the spaces
 * between them, each space run carrying the extra as letter spacing: the
 * engines space letters, not words, and a space's letter spacing is exactly
 * the room CSS adds after a word separator (16.4 — the space and the
 * no-break space). Only text that asks for it is split.
 */
function wordSpaced(
  out: Item[],
  box: Box,
  run: TextRun,
  spacing: number,
): void {
  const text = box.text;
  const push = (from: number, to: number, extra: number): void => {
    if (to <= from) return;
    out.push({
      kind: 'text',
      run: {
        ...run,
        text: text.slice(from, to),
        ...(extra ? { letterSpacing: (run.letterSpacing ?? 0) + extra } : null),
      },
      box,
      length: to - from,
      start: box.textStart + from,
    });
  };
  let from = 0;
  for (const m of text.matchAll(/[ \u00A0]+/g)) {
    push(from, m.index, 0);
    push(m.index, m.index + m[0].length, spacing);
    from = m.index + m[0].length;
  }
  push(from, text.length, 0);
}

/**
 * An inline box's margin, border and padding, resolved onto it — percentages
 * of the containing block's width, as a block's are — and the widths of its
 * two edges on the line: the start side's before its first fragment, the
 * end side's after its last. One with a background or a border to paint
 * also notes its face's ascent and descent, the height CSS paints them over
 * (10.6.1, the content area), so paint needs no font.
 */
function inlineEdges(
  box: Box,
  width: number,
  fonts: FontsLike | null,
): [number, number] {
  const s = box.style;
  const border = (w: number, style: ComputedStyle['borderTopStyle']) =>
    style === 'none' || style === 'hidden' ? 0 : w;
  box.borderTop = border(s.borderTopWidth, s.borderTopStyle);
  box.borderRight = border(s.borderRightWidth, s.borderRightStyle);
  box.borderBottom = border(s.borderBottomWidth, s.borderBottomStyle);
  box.borderLeft = border(s.borderLeftWidth, s.borderLeftStyle);
  box.padTop = resolve(s.paddingTop, width);
  box.padRight = resolve(s.paddingRight, width);
  box.padBottom = resolve(s.paddingBottom, width);
  box.padLeft = resolve(s.paddingLeft, width);
  box.marginLeft = resolve(s.marginLeft, width);
  box.marginRight = resolve(s.marginRight, width);
  box.decorated =
    !isTransparent(s.backgroundColor) ||
    box.borderTop + box.borderRight + box.borderBottom + box.borderLeft > 0;
  if (box.decorated && fonts) {
    const extent = faceExtent(fonts, s);
    box.contentAscent = extent.ascent;
    box.contentDescent = extent.descent;
  }
  const left = box.marginLeft + box.borderLeft + box.padLeft;
  const right = box.padRight + box.borderRight + box.marginRight;
  return s.direction === 'rtl' ? [right, left] : [left, right];
}

/** A face's ascent and descent at a style's size, kept per font manager. */
const FACE_EXTENTS = new WeakMap<
  FontsLike,
  Map<string, { ascent: number; descent: number }>
>();

function faceExtent(
  fonts: FontsLike,
  style: ComputedStyle,
): { ascent: number; descent: number } {
  let cache = FACE_EXTENTS.get(fonts);
  if (!cache) {
    cache = new Map();
    FACE_EXTENTS.set(fonts, cache);
  }
  const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.fontStyle}`;
  let extent = cache.get(key);
  if (!extent) {
    try {
      const m = fonts
        .match(style.fontFamily, {
          size: style.fontSize,
          weight: style.fontWeight,
          style: style.fontStyle,
        })
        .metrics(style.fontSize);
      extent = { ascent: m.ascent, descent: m.descent };
    } catch {
      extent = { ascent: style.fontSize * 0.8, descent: style.fontSize * 0.2 };
    }
    if (cache.size > 64) cache.clear();
    cache.set(key, extent);
  }
  return extent;
}

/** The `TextRun` one styled piece of text becomes: its text, and what paint
 *  needs of its style — nothing that names a box or an element, so that a
 *  layout made from it can be kept for the next parse (`TextLayoutCache`). */
function runFor(text: string, style: ComputedStyle): TextRun {
  const run: TextRun = {
    text,
    family: style.fontFamily,
    size: style.fontSize,
    weight: style.fontWeight,
    style: style.fontStyle === 'normal' ? 'normal' : 'italic',
    color: style.color,
  };
  if (style.letterSpacing) run.letterSpacing = style.letterSpacing;
  // A background is not the run's: the inline box it belongs to paints it,
  // behind every fragment of the box — nested elements' text included — and
  // out to its padding (`paintInlineBoxes`).
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
  private _boxes: (Box | null)[] = [];
  laidOut = 0;

  add(documentStart: number, length: number, box: Box | null = null): void {
    this._laid.push(this.laidOut);
    this._doc.push(documentStart);
    this._boxes.push(box);
    this.laidOut += length;
  }

  /** The text box whose text an offset in the laid-out text is. */
  boxAt(offset: number): Box | null {
    const i = this._entryAt(offset);
    return i < 0 ? null : this._boxes[i];
  }

  documentAt(offset: number): number {
    const i = this._entryAt(offset);
    return i < 0 ? 0 : this._doc[i] + (offset - this._laid[i]);
  }

  /** The entry an offset falls in, or -1 when there are none. */
  private _entryAt(offset: number): number {
    const laid = this._laid;
    if (!laid.length) return -1;
    let lo = 0;
    let hi = laid.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (laid[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
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
      spans.add(item.start + skip, text.length, item.box);
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

/**
 * One space's advance in a run's style, measured as the difference between
 * `x x` and `xx` — ntk strips a lone trailing space from a line, so it
 * cannot be measured directly — plus the run's letter spacing, which a
 * space takes as every other character does. Cached per font manager per
 * face; the measurement itself hits ntk's shaping memo.
 */
const SPACE_ADVANCE = new WeakMap<FontsLike, Map<string, number>>();

function spaceAdvance(fonts: FontsLike, run: TextRun): number {
  let cache = SPACE_ADVANCE.get(fonts);
  if (!cache) {
    cache = new Map();
    SPACE_ADVANCE.set(fonts, cache);
  }
  const spacing = run.letterSpacing ?? 0;
  const key = `${run.family}|${run.size}|${run.weight}|${run.style}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit + spacing;
  const style = {
    family: run.family,
    size: run.size,
    weight: run.weight,
    style: run.style,
  };
  const measure = (text: string): number =>
    fonts.layout([{ ...style, text }], style, {}).lines[0]?.width ?? 0;
  const advance = Math.max(0, measure('x x') - measure('xx'));
  if (cache.size > 64) cache.clear();
  cache.set(key, advance);
  return advance + spacing;
}

/** Whether the runs' joined text has a forced break just before a
 *  code-unit offset — a line's end, which an engine counts the break in. */
function breakBefore(runs: TextRun[], offset: number): boolean {
  let at = 0;
  for (const run of runs) {
    const next = at + run.text.length;
    if (offset - 1 < next) return run.text.charCodeAt(offset - 1 - at) === 10;
    at = next;
  }
  return false;
}

/** Whether anything but whitespace lies past a code-unit offset into the
 *  runs' joined text — "did `maxLines` drop content", for a layout that
 *  does not say. */
function inkBeyond(runs: TextRun[], offset: number): boolean {
  let at = 0;
  for (const run of runs) {
    const next = at + run.text.length;
    if (next > offset && /\S/.test(run.text.slice(Math.max(0, offset - at)))) {
      return true;
    }
    at = next;
  }
  return false;
}

// --- style questions --------------------------------------------------------

function wraps(style: ComputedStyle): boolean {
  return style.whiteSpace !== 'nowrap' && style.whiteSpace !== 'pre';
}

/** How much of a line's unused room goes before it: 0 for a line set flush
 *  left, 1 flush right, ½ centred. `start` and `end` follow the direction;
 *  `justify` is set as `start`, as `alignFor` sets it. */
function lineShift(style: ComputedStyle): number {
  const rtl = style.direction === 'rtl';
  switch (style.textAlign) {
    case 'center':
      return 0.5;
    case 'right':
      return 1;
    case 'left':
      return 0;
    case 'end':
      return rtl ? 0 : 1;
    default:
      return rtl ? 1 : 0;
  }
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
 *
 * `line-height: 0` is legal and means what it says — lines of no height,
 * the glyphs overflowing evenly — and ntk's half-leading does exactly that
 * with a multiplier of 0. The floor is a hair above it rather than the 0.1
 * it was, which set such lines a tenth of a line apart: the Cocoa engine
 * takes a zero multiple for none at all.
 */
function lineHeightMultiplier(fonts: FontsLike, style: ComputedStyle): number {
  if (style.lineHeight === 'normal') return 1;
  const target = style.lineHeightIsLength
    ? (style.lineHeight as number)
    : (style.lineHeight as number) * style.fontSize;
  const natural = naturalLineHeight(fonts, style);
  if (!natural) return 1;
  return Math.max(1e-4, target / natural);
}

/**
 * The font's natural line height in a style, which CSS's number form is
 * converted against. Kept per font manager per style, like a space's
 * advance: a pass asks once a paragraph — 8,800 times at 600 KB — and on
 * CoreText every answer was a call to the native side.
 */
const NATURAL_LINE_HEIGHT = new WeakMap<FontsLike, Map<string, number>>();

function naturalLineHeight(fonts: FontsLike, style: ComputedStyle): number {
  let cache = NATURAL_LINE_HEIGHT.get(fonts);
  if (!cache) {
    cache = new Map();
    NATURAL_LINE_HEIGHT.set(fonts, cache);
  }
  const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.fontStyle}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let height: number;
  try {
    const font = fonts.match(style.fontFamily, {
      size: style.fontSize,
      weight: style.fontWeight,
      style: style.fontStyle,
    });
    height = font.metrics(style.fontSize).lineHeight;
  } catch {
    height = style.fontSize * 1.2;
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, height);
  return height;
}

/** Whether a line has nothing on it yet. */
function isEmpty(open: { x: number; texts: unknown[]; atomics: unknown[] }) {
  return open.x === 0 && !open.texts.length && !open.atomics.length;
}

/** Where a line at `y` next has more room, in the block's own space: the
 *  nearest bottom edge of a float beside it, or null when none is. */
function belowFloats(
  options: InlineOptions,
  y: number,
  height: number,
): number | null {
  const edge = options.floats?.nextEdgeBelow(options.startY + y, height);
  return edge == null ? null : Math.max(y + 1, edge - options.startY);
}

/**
 * Whether a line's first word did not fit its room: the line runs past the
 * room on a word rather than on hanging white space, or it ends inside a
 * word — between two letters or digits, where no break is allowed, so only
 * a line too narrow for the word put one there. Ideographs and kana break
 * between any two, and are not counted as a word's letters.
 */
function tooNarrow(
  runs: TextRun[],
  end: number,
  width: number,
  room: number,
): boolean {
  let at = 0;
  let before = '';
  let after = '';
  for (const run of runs) {
    const text = run.text;
    if (end > at && end <= at + text.length) before = text[end - at - 1];
    if (end >= at && end < at + text.length) after = text[end - at];
    at += text.length;
  }
  if (WORD_CHAR.test(before) && WORD_CHAR.test(after)) return true;
  return width > room + 0.5 && before !== '' && !/\s/.test(before);
}

const WORD_CHAR =
  /^(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}\p{M}]$/u;

function bandAt(
  options: InlineOptions,
  y: number,
  height: number,
): { left: number; right: number } {
  if (!options.floats) return { left: 0, right: options.width };
  // Floats narrow the block's own line, where they reach into it; the
  // formatting context's edges are not this block's, and a block wider than
  // its context — a fixed width in a narrow body — keeps its lines whole.
  const band = options.floats.bandAt(
    options.startY + y,
    height,
    options.originX,
    options.originX + options.width,
  );
  return {
    left: Math.max(0, band.left - options.originX),
    right: Math.min(options.width, band.right - options.originX),
  };
}
