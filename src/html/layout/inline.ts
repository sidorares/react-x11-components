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
import {
  BOX_RAISES,
  isOffset,
  SHADOWED_TEXT,
  SHIFTED_LINES,
  TEXT_RAISES,
} from './boxes.js';
import type {
  AtomicPlacement,
  Box,
  EdgePlacement,
  InlineDecoration,
  LineBox,
  LineText,
  TextLayoutLike,
} from './boxes.js';
import type { FloatContext } from './floats.js';
import { tableGrid } from './grid.js';

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
      /** What a `maxLines` cut looks like: an ellipsis, or nothing. */
      overflow?: 'clip' | 'ellipsis';
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

const WIDEST_WORD = new WeakMap<TextLayoutLike, number>();

/**
 * The widest word between spaces in a layout's text: its runs laid out
 * again with every space a line break, at no width limit. Where a text's
 * only breaks are spaces that is its min-content width, and where it has
 * others — a hyphen, a slash — more: an upper bound of it either way. The
 * other way to ask, a layout of no width, has ntk search every word for a
 * place to cut it, since none fits, which costs fifteen layouts of this
 * one. Infinity where the runs are no longer kept.
 */
export function widestWord(
  fonts: FontsLike,
  layout: TextLayoutLike,
  measured = true,
): number {
  if (!measured) return longestWord(layout);
  let widest = WIDEST_WORD.get(layout);
  if (widest !== undefined) return widest;
  const held = LAYOUT_RUNS.get(layout);
  if (!held || (held.length > 0 && typeof held[0] === 'number')) {
    return Infinity;
  }
  const words = fonts.layout(
    (held as TextRun[]).map((run) => ({
      ...run,
      text: run.text.replace(/[ \t\u200b]+/g, '\n'),
    })),
    {},
    {},
  );
  widest = 0;
  for (const line of words.lines) widest = Math.max(widest, line.width);
  WIDEST_WORD.set(layout, widest);
  return widest;
}

const SPACE_BREAKS = new WeakMap<TextLayoutLike, boolean>();

/**
 * Whether a layout's text breaks only at its spaces: letters and digits of
 * the Latin, Greek and Cyrillic scripts, and the punctuation that UAX #14
 * never breaks after between two letters — no hyphen, slash, `!`, `?`,
 * `|`, `}`, soft hyphen or ellipsis, and nothing of a script that breaks
 * between its letters or by dictionary. Where it does, its widest word
 * (`widestWord`) is exactly its min-content width.
 */
export function spaceBreaksOnly(layout: TextLayoutLike): boolean {
  let only = SPACE_BREAKS.get(layout);
  if (only !== undefined) return only;
  const held = LAYOUT_RUNS.get(layout);
  only = !!held && (held.length === 0 || typeof held[0] !== 'number');
  if (only) {
    outer: for (const run of held as TextRun[]) {
      const text = run.text;
      for (let i = 0; i < text.length; i += 1) {
        if (!breaksOnlyAtSpace(text.charCodeAt(i))) {
          only = false;
          break outer;
        }
      }
    }
  }
  SPACE_BREAKS.set(layout, only);
  return only;
}

function breaksOnlyAtSpace(c: number): boolean {
  if (c < 0x80) {
    // `-` `/` `!` `?` `|` `}`: a break may follow each
    return (
      c >= 0x20 &&
      c !== 0x2d &&
      c !== 0x2f &&
      c !== 0x21 &&
      c !== 0x3f &&
      c !== 0x7c &&
      c !== 0x7d &&
      c !== 0x7f
    );
  }
  // Latin-1 but the soft hyphen and the acute accent, which a break may
  // precede; Latin Extended, the combining marks, Greek and Cyrillic
  if (c >= 0xa0 && c < 0x530) return c !== 0xad && c !== 0xb4 && c !== 0x2c8;
  // the curly quotes
  return c >= 0x2018 && c <= 0x201f;
}

const LONGEST_WORD = new WeakMap<TextLayoutLike, number>();

/**
 * `widestWord` estimated from the text alone, with no layout: each word's
 * characters at half again their size, which no glyph a document sets
 * words in is wider than, and their letter spacing. What is under it
 * needs no measuring, and most words are.
 */
function longestWord(layout: TextLayoutLike): number {
  let longest = LONGEST_WORD.get(layout);
  if (longest !== undefined) return longest;
  const held = LAYOUT_RUNS.get(layout);
  if (!held || (held.length > 0 && typeof held[0] === 'number')) {
    return Infinity;
  }
  longest = 0;
  let word = 0;
  for (const run of held as TextRun[]) {
    const per = (run.size ?? 16) * 1.5 + Math.max(0, run.letterSpacing ?? 0);
    const text = run.text;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x200b) word = 0;
      else if (c < 0xdc00 || c > 0xdfff) {
        // a surrogate pair is one character
        word += per;
        if (word > longest) longest = word;
      }
    }
  }
  LONGEST_WORD.set(layout, longest);
  return longest;
}

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
      /** A bidi control `unicode-bidi` stands for (`bidiControls`): laid
       *  out, and no text of the document's. */
      control?: true;
    }
  | { kind: 'atomic'; box: Box }
  | { kind: 'edge'; box: Box; side: 'start' | 'end'; width: number }
  /** A float, where it is in the content: placed when the lines reach it
   *  (`InlineOptions.floatBoxes`). */
  | { kind: 'float'; box: Box };

function isText(item: Item): item is Extract<Item, { kind: 'text' }> {
  return item.kind === 'text';
}

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
  /** A `::first-line` colour, for the text before `end` — the first line's
   *  end, in the document index — whose colour is `from`, the block's. */
  firstLine?: { color: string; from: string; end: number };
  /** Whether any box in the document paints its background through its
   *  text (`BoxTree.clipText`). */
  clipText?: boolean;
  /**
   * The floats in the content, placed as the lines reach them: `size` lays
   * one out and answers its outer width, `place` puts it at a height in the
   * float context's space. Absent, the floats are not the lines' to place —
   * they were, by an earlier pass over the same lines.
   */
  floatBoxes?: {
    size(box: Box): number;
    place(box: Box, y: number): void;
  };
}

/**
 * Lay out one inline formatting context. Coordinates in the result are
 * relative to the containing block's content box; the caller translates.
 */
export function layoutInline(block: Box, options: InlineOptions): InlineResult {
  const result = layoutLines(block, options);
  const clamp = block.style.lineClamp;
  // A clamped block shows its first lines and is as tall as they are. The
  // one-layout paths below had the engine cut them, with its ellipsis; a
  // block laid out a line at a time — an image on a line, a float beside
  // it — is cut here, and ends where its last line does, with none.
  if (clamp !== null && result.lines.length > clamp) {
    const lines = result.lines.slice(0, clamp);
    const last = lines[clamp - 1];
    let widest = 0;
    for (const line of lines) widest = Math.max(widest, line.width);
    return { lines, height: last.y + last.height, width: widest };
  }
  return result;
}

/**
 * The cut a block's own style asks of its text, as the engine takes it:
 * `line-clamp`'s lines, or the one line of a `white-space: nowrap` block
 * that clips with `text-overflow: ellipsis` — Tailwind's `truncate`, cut at
 * the box's width with an ellipsis. The engine cuts the line where it
 * would have broken it and makes room for the ellipsis inside its last
 * word, so a line of words shows a little less of them than a browser,
 * which fills the line with as much of the text as fits.
 */
/** A layout cut at a number of lines, with an ellipsis. */
interface Cut {
  maxLines: number;
  overflow: 'ellipsis';
}

function cutOf(style: ComputedStyle): Cut | null {
  if (style.lineClamp !== null) {
    return { maxLines: style.lineClamp, overflow: 'ellipsis' };
  }
  if (
    style.textOverflow === 'ellipsis' &&
    !wraps(style) &&
    style.overflowX !== 'visible'
  ) {
    return { maxLines: 1, overflow: 'ellipsis' };
  }
  return null;
}

function layoutLines(block: Box, options: InlineOptions): InlineResult {
  let fonts = options.fonts;
  const items: Item[] = [];
  const placing = options.floatBoxes;
  const floatCount = collect(
    block,
    items,
    options.width,
    fonts,
    block.style,
    !!placing,
  );
  if (items.length === floatCount || !fonts) {
    // no line to wait for: the floats go at the top
    for (const item of items) {
      if (item.kind === 'float') {
        placing!.size(item.box);
        placing!.place(item.box, options.startY);
      }
    }
    return EMPTY;
  }
  // text a box's background shows through (`background-clip: text`): its
  // layouts are made through a recorder, so paint can lay the same text out
  // again with no ink of its own and fill it with that background
  if (options.clipText && clipsText(block, items)) {
    CLIPPED_TEXT.add(block);
    fonts = recording(fonts);
  }
  if (wraps(block.style)) holdNoWrap(items);
  // one walk for what few paragraphs have: text that casts a shadow, and a
  // tab, which only a `white-space` that keeps it leaves — so no text is
  // searched for one where it cannot be
  let tabbed = false;
  let shadowed = false;
  for (const item of items) {
    if (item.kind !== 'text' || item.control) continue;
    const style = item.box.style;
    if (style.textShadow) shadowed = true;
    if (
      !tabbed &&
      (style.whiteSpace === 'pre' || style.whiteSpace === 'pre-wrap') &&
      item.run.text.includes('\t')
    ) {
      tabbed = true;
    }
  }
  if (shadowed) SHADOWED_TEXT.add(block);
  if (tabbed) {
    setTabs(items, fonts, block.style, indentOf(block.style, options.width));
  }
  // an override on the block is one on all of its inline content (CSS 2.1
  // 9.10); its embedding or isolation is the paragraph's own direction
  const own =
    block.style.unicodeBidi === 'bidi-override' ||
    block.style.unicodeBidi === 'isolate-override'
      ? bidiControls(block.style, true)
      : null;
  if (own) {
    const first = items.find(isText);
    let last: Extract<Item, { kind: 'text' }> | undefined;
    for (const item of items) if (item.kind === 'text') last = item;
    if (first && last) {
      const opening: Item[] = [];
      pushControls(opening, own[0], block, first.start);
      items.unshift(...opening);
      pushControls(items, own[1], block, last.start + last.length);
    }
  }
  if (options.firstLine) firstLineColour(items, options.firstLine);

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

  let hasAtomics = false;
  let hasEdges = false;
  let hasOffset = false;
  let raised = false;
  for (const item of items) {
    if (item.kind === 'atomic') hasAtomics = true;
    else if (item.kind === 'edge') {
      hasEdges = true;
      if (
        item.box.style.verticalAlign !== 'baseline' ||
        ownsLeading(fonts, block.style, item.box.style)
      ) {
        hasOffset = true;
        raised = true;
      } else if (!hasOffset && isOffset(item.box.style)) hasOffset = true;
    }
  }
  // a float in the content is placed on the line it is on, which only the
  // line-at-a-time loop knows, as it does whatever floats are beside it
  const floated =
    floatCount > 0 ||
    (options.floats?.intersects(options.startY, Infinity) ?? false);
  // An inline box's edges take room on their lines. Where nothing else on
  // the lines has to be placed a piece at a time, they go into the one
  // layout as spacers (`spacerRun`) — which only holds where no bidi
  // reordering can move one off the side of its box it belongs to, and no
  // box between edges is moved afterwards, which needs its text apart.
  const spaced =
    hasEdges && !hasAtomics && !hasOffset && spacersHold(style, items);

  // The text-only, float-free, unindented case: one call, every line — or
  // one call per *chunk*, when the text is long and carries hard breaks.
  if (!hasAtomics && (!hasEdges || spaced) && !floated && !indent) {
    // no atomics, so what is not an edge is text
    const textItems = hasEdges
      ? items.filter(isText)
      : (items as Extract<Item, { kind: 'text' }>[]);
    let total = 0;
    let hasNewline = false;
    for (const item of textItems) {
      total += item.length;
      if (!hasNewline && item.run.text.includes('\n')) hasNewline = true;
    }
    if (!total && !hasEdges) return EMPTY;
    if (spaced) {
      return layoutSpaced(
        items,
        base,
        style,
        options.width,
        lineHeightMul,
        align,
        fonts,
      );
    }
    // `text-overflow` cuts every line that overflows, and a layout can cut
    // only its last: one that a forced break ends is laid out apart, a hard
    // line at a time, or the lines after the first were lost. A clamp is
    // the paragraph's, and stays one layout.
    let cut = cutOf(style);
    const perLine = cut !== null && style.lineClamp === null && hasNewline;
    // an embedding cannot be cut into chunks
    if (perLine && !hasControls(items)) {
      return layoutChunked(
        textItems,
        base,
        style,
        options.width,
        lineHeightMul,
        align,
        fonts,
        { chars: Infinity, hardLines: 1, cut },
      );
    }
    if (perLine) cut = null;
    if (total > CHUNK_TRIGGER_CHARS && hasNewline && !hasControls(items)) {
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
      spans.add(
        item.start,
        item.run.text.length,
        item.control ? null : item.box,
      );
      runs.push(item.run);
    }
    const layoutOptions = {
      maxWidth: wraps(style) || cut ? options.width : undefined,
      lineHeight: lineHeightMul,
      align,
      direction: style.direction,
      ...cut,
    };
    let layout = fonts.layout(runs, base, layoutOptions);
    LAYOUT_RUNS.set(layout, runs);
    // `text-wrap: balance`: the lines broken at the narrowest width that
    // keeps as many of them, and then set in the whole width
    let balanced = false;
    if (
      style.textWrapStyle === 'balance' &&
      layoutOptions.maxWidth !== undefined &&
      !cut &&
      style.textAlign !== 'justify' &&
      layout.lines.length > 1 &&
      layout.lines.length <= BALANCE_LINES
    ) {
      const width = layoutOptions.maxWidth;
      const at = balancedWidth(fonts, runs, base, layoutOptions, width, layout);
      if (at < width) {
        layout = fonts.layout(runs, base, { ...layoutOptions, maxWidth: at });
        LAYOUT_RUNS.set(layout, runs);
        balanced = true;
      }
    }
    if (
      style.textAlign === 'justify' &&
      wraps(style) &&
      layout.lines.length > 1
    ) {
      // measured as it will be drawn, its spaces spaced apart (`HAIR`)
      const spaced = spacedApart(runs);
      const measured = fonts.layout(spaced, base, layoutOptions);
      const justified = justifiedRuns(spaced, measured, options.width);
      layout = justified
        ? fonts.layout(justified, base, layoutOptions)
        : measured;
      LAYOUT_RUNS.set(layout, justified ?? spaced);
    }
    const lines: LineBox[] = [];
    const widest = emitLayout(
      layout,
      spans,
      0,
      0,
      lines,
      layoutOptions.maxWidth === undefined || balanced
        ? unwrappedPlacer(style, options.width)
        : null,
    );
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
  /** Floats met on a line they did not fit beside: they go at the top of
   *  the next line, as the line they were met on closes. */
  let deferred: Box[] = [];
  const placeDeferred = (): void => {
    for (const box of deferred)
      options.floatBoxes!.place(box, options.startY + y);
    deferred = [];
  };

  const strut = fonts ? strutOf(fonts, style) : null;
  const lifts = raised && fonts ? new Lifts(fonts, block.style) : null;
  const close = (): void => {
    const line = finishLine(
      open,
      y,
      // the room beside the floats over the whole line box, which an
      // inline-block can make taller than its text (CSS 2.1 9.5)
      (height) => bandAt(options, y, Math.max(height, style.fontSize * 1.4)),
      lineShift(style),
      style.direction === 'rtl',
      strut,
      lifts,
    );
    if (!line) {
      open = openLine(0);
      placeDeferred();
      return;
    }
    lines.push(line);
    widest = Math.max(widest, line.width);
    y += line.height;
    open = openLine(0);
    placeDeferred();
  };

  while (index < items.length) {
    const band = bandAt(options, y, style.fontSize * 1.4);
    const available = band.right - band.left;
    const item = items[index];

    if (item.kind === 'float') {
      // No higher than the top of the line it is met on (CSS 2.1 9.5.1):
      // at that top where it fits beside what the line holds already, and
      // what the line holds moves over for it; under the line where it
      // does not, with the rest of the line's content still on the line
      const outer = options.floatBoxes!.size(item.box);
      if (isEmpty(open) || open.x + pendingWidth + outer <= available) {
        options.floatBoxes!.place(item.box, options.startY + y);
        const left = bandAt(options, y, style.fontSize * 1.4).left;
        if (!isEmpty(open) && left !== open.left) {
          const dx = left - open.left;
          for (const text of open.texts) text.drawX += dx;
          for (const placed of open.atomics) placed.x += dx;
          for (const edge of open.edges) edge.x += dx;
          open.left = left;
        }
      } else {
        deferred.push(item.box);
      }
      index += 1;
      continue;
    }

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
      // An inline-block makes its line as tall as itself, and the line box
      // must not run into a float over that height either (CSS 2.1 9.5):
      // the room is what the floats leave beside all of it.
      const tall = box.marginTop + box.height + box.marginBottom;
      const lineTall = Math.max(style.fontSize * 1.4, tall);
      const room =
        tall > style.fontSize * 1.4 ? bandAt(options, y, tall) : band;
      const roomWidth = room.right - room.left;
      if (open.x > 0 && open.x + pendingWidth + outer > roomWidth) {
        close();
        continue;
      }
      // an inline-block wider than the room a float left goes below it,
      // as a word does (below)
      if (
        isEmpty(open) &&
        pendingWidth + outer > roomWidth &&
        roomWidth < options.width
      ) {
        const below = belowFloats(options, y, lineTall);
        if (below !== null) {
          y = below;
          continue;
        }
      }
      placePending(room.left);
      const placed: AtomicPlacement = {
        box,
        x: room.left + open.x + box.marginLeft,
        y: 0,
      };
      open.atomics.push(placed);
      open.order.push({ kind: 'atomic', at: open.x, item: placed });
      open.x += outer;
      open.hang = 0;
      open.left = room.left;
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
      !deferred.length &&
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
        segment.spans.giveGaps(text, natural.start, natural.end);
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
    // line, rather than the edge being left at this one's end. And a word
    // that may start a line — after a space the line ends on, or after an
    // atomic, which has a break after it (CSS Text 3, 5.1) — goes to the
    // next line whole where it does not fit what is left of this one,
    // rather than being broken inside itself to fit it: the text after an
    // inline-block, or after a float it was cut at, was its first letter
    // at the line's end and the rest on the next.
    const startsLine =
      wraps(style) &&
      (open.hang > 0 || open.order[open.order.length - 1]?.kind === 'atomic');
    if (
      (pendingWidth > 0 || startsLine) &&
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
    segment.spans.giveGaps(placed, first.start, first.end);
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
      // With one correction first. A text engine strips a line's trailing
      // whitespace — right at a real line end, wrong here, where the "line"
      // is only a fragment and an atomic follows on the same one: `Name
      // <input>` laid the space out to width zero and the control sat flush
      // against the label. The stripped advance is measured back and added
      // to the cursor: what the engine strips, and no more (`hungSpaces`).
      if (segment.nextIndex < items.length) {
        const hung = hungSpaces(fonts, segment.runs[segment.runs.length - 1]);
        let trailing = '';
        for (let i = segment.runs.length - 1; i >= 0; i -= 1) {
          const text = segment.runs[i].text;
          const m = hung.exec(text);
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
  placeDeferred();

  return { lines, height: y, width: widest };
}

const EMPTY: InlineResult = { lines: [], height: 0, width: 0 };

/** A no-break space in a paragraph's face, and its advance, per font
 *  manager and per style — which the cascade shares between every element
 *  of a kind, so a document of paragraphs asks once. */
const SPACERS = new WeakMap<
  object,
  WeakMap<ComputedStyle, { run: TextRun; advance: number }>
>();

/**
 * An inline box's edge as a run of the one layout: a no-break space in the
 * paragraph's face, letter-spaced to the edge's width. A no-break space
 * glues to the text on either side, so a start edge goes to whichever line
 * the box's first word goes to, and an end edge stays with its last; a line
 * may still break after a space before it (UAX #14, LB12a). It is drawn as
 * nothing, and is no part of the document's text: the line's text notes
 * where it is (`LineText.gaps`). Laid out piece by piece instead, a
 * paragraph with an inline `<code>` in it — whose padding is an edge —
 * cost five layouts where one does, and a document of them reflowed two
 * and a half times slower.
 */
function spacerRun(
  fonts: FontsLike,
  style: ComputedStyle,
  width: number,
): TextRun {
  let byStyle = SPACERS.get(fonts);
  if (!byStyle) {
    byStyle = new WeakMap();
    SPACERS.set(fonts, byStyle);
  }
  let spacer = byStyle.get(style);
  if (!spacer) {
    const face = {
      family: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      style:
        style.fontStyle === 'normal'
          ? ('normal' as const)
          : ('italic' as const),
    };
    const run: TextRun = { text: '\u00a0', ...face };
    spacer = { run, advance: fonts.layout([run], face, {}).width };
    byStyle.set(style, spacer);
  }
  return { ...spacer.run, letterSpacing: width - spacer.advance };
}

/** Text that bidi could reorder around a spacer: any right-to-left
 *  letter, and the explicit embedding and isolate controls. */
const REORDERS =
  /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u202a-\u202e\u2066-\u2069]|[\ud802\ud803\ud83a\ud83b]/;

/** Whether a paragraph's edges can be spacers: it reads left to right, and
 *  nothing in it can be reordered. */
function spacersHold(style: ComputedStyle, items: Item[]): boolean {
  if (style.direction !== 'ltr') return false;
  for (const item of items) {
    if (item.kind === 'text' && REORDERS.test(item.run.text)) return false;
    // A negative margin takes room back. As a spacer it is a space with
    // negative letter spacing, which ntk's line fill counts and CoreText's
    // typesetter breaks the line before: the line at a time does the sum.
    if (
      item.kind === 'edge' &&
      (item.box.style.direction !== 'ltr' || item.width < 0)
    )
      return false;
  }
  return true;
}

/** A paragraph whose inline boxes have edges, as one layout with the edges
 *  in it as spacers (`spacerRun`), each line told where its spacers are and
 *  where they put the edges. */
function layoutSpaced(
  items: Item[],
  base: Record<string, unknown>,
  style: ComputedStyle,
  width: number,
  lineHeightMul: number,
  align: string,
  fonts: FontsLike,
): InlineResult {
  const runs: TextRun[] = [];
  const spans = new SpanMap();
  const spacers: { at: number; edge: Extract<Item, { kind: 'edge' }> }[] = [];
  let doc = 0;
  for (const item of items) {
    if (item.kind === 'text') {
      doc = item.start;
      break;
    }
  }
  for (const item of items) {
    if (item.kind === 'edge') {
      spacers.push({ at: spans.laidOut, edge: item });
      spans.add(doc, 1, null);
      runs.push(spacerRun(fonts, style, item.width));
    } else if (item.kind === 'text') {
      spans.add(
        item.start,
        item.run.text.length,
        item.control ? null : item.box,
      );
      runs.push(item.run);
      if (!item.control) doc = item.start + item.run.text.length;
    }
  }
  const layout = fonts.layout(runs, base, {
    maxWidth: wraps(style) ? width : undefined,
    lineHeight: lineHeightMul,
    align,
    direction: style.direction,
  });
  LAYOUT_RUNS.set(layout, runs);
  const place = wraps(style) ? null : unwrappedPlacer(style, width);
  let offsets: number[] | null = null;
  const lines: LineBox[] = [];
  let widest = 0;
  let next = 0;
  for (let i = 0; i < layout.lines.length; i += 1) {
    const natural = layout.lines[i];
    const dx = place ? place(natural) : 0;
    const edges: EdgePlacement[] = [];
    while (next < spacers.length && spacers[next].at < natural.end) {
      const { at, edge } = spacers[next];
      next += 1;
      if (at < natural.start) continue;
      const run = natural.runs?.find((r) => r.start === at);
      const x = run
        ? natural.x + run.x
        : layout.caretPosition(
            codePointAt((offsets ??= layoutOffsets(layout)), at),
          ).x;
      edges.push({
        box: edge.box,
        side: edge.side,
        x: x + dx,
        width: edge.width,
      });
    }
    const text: LineText = {
      layout,
      layoutLine: i,
      drawX: dx,
      drawY: 0,
      textStart: spans.documentAt(natural.start),
      textEnd: spans.documentAt(natural.end),
      layoutStart: natural.start,
      spans,
    };
    spans.giveGaps(text, natural.start, natural.end);
    lines.push({
      x: natural.x + dx,
      y: natural.y,
      width: natural.width,
      height: natural.height,
      baseline: natural.baseline - natural.y,
      texts: [text],
      textStart: text.textStart,
      textEnd: text.textEnd,
      atomics: [],
      ...(edges.length ? { edges } : null),
    });
    widest = Math.max(widest, natural.width);
  }
  return { lines, height: layout.height, width: widest };
}

/** The code point a code-unit offset into a layout's text starts. */
function codePointAt(offsets: number[], units: number): number {
  if (!offsets.length) return units;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= units) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * A code-unit offset in a line's layout as a document index, and back:
 * `textStart` is `layoutStart`, and every spacer before the offset is a
 * unit of the layout that is no text of the document's. A document offset
 * with a spacer right at it is past the spacer, where a caret or a range's
 * start goes — inside a padded box, after its padding — and before it as
 * a range's `end`, so a selection does not take in the padding after it.
 */
export function documentOffsetOf(text: LineText, units: number): number {
  let doc = text.textStart + (units - text.layoutStart);
  for (const gap of text.gaps ?? []) if (gap < units) doc -= 1;
  return doc;
}

export function layoutOffsetOf(
  text: LineText,
  doc: number,
  end = false,
): number {
  let units = text.layoutStart + (doc - text.textStart);
  for (const gap of text.gaps ?? []) {
    if (end ? gap < units : gap <= units) units += 1;
  }
  return units;
}

/** Append one layout's lines as LineBoxes at an offset, each moved where
 *  `place` says; returns the widest. */
function emitLayout(
  layout: TextLayoutLike,
  spans: SpanMap,
  xOff: number,
  yOff: number,
  lines: LineBox[],
  place: LinePlacer | null = null,
): number {
  let widest = 0;
  for (let i = 0; i < layout.lines.length; i += 1) {
    const natural = layout.lines[i];
    const dx = place ? place(natural) : 0;
    const text: LineText = {
      layout,
      layoutLine: i,
      drawX: xOff + dx,
      drawY: yOff,
      textStart: spans.documentAt(natural.start),
      textEnd: spans.documentAt(natural.end),
      layoutStart: natural.start,
      spans,
    };
    spans.giveGaps(text, natural.start, natural.end);
    lines.push({
      x: xOff + dx + natural.x,
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

/** Where `layoutChunked` cuts a text — a chunk's most characters and hard
 *  lines — and the cut each chunk's layout makes, if any. */
interface Chunking {
  chars: number;
  hardLines: number;
  cut: Cut | null;
}

const CHUNKS: Chunking = {
  chars: CHUNK_MAX_CHARS,
  hardLines: CHUNK_MAX_HARD_LINES,
  cut: null,
};

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
  chunking: Chunking = CHUNKS,
): InlineResult {
  const lines: LineBox[] = [];
  let widest = 0;
  let y = 0;

  let chunkRuns: TextRun[] = [];
  let chunkSpans = new SpanMap();
  let chars = 0;
  let hardLines = 0;

  const { cut } = chunking;
  const place = wraps(style) || cut ? null : unwrappedPlacer(style, width);
  const flush = (): void => {
    if (!chunkRuns.length) return;
    const layout = fonts.layout(chunkRuns, base, {
      maxWidth: wraps(style) || cut ? width : undefined,
      lineHeight: lineHeightMul,
      align,
      direction: style.direction,
      ...cut,
    });
    LAYOUT_RUNS.set(layout, chunkRuns);
    widest = Math.max(
      widest,
      emitLayout(layout, chunkSpans, 0, y, lines, place),
    );
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
        taken < chunking.chars &&
        lines2 < chunking.hardLines
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
  /** The first line's `text-indent`, which `x` starts at. */
  indent: number;
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
    indent,
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
  strut: InlineDecoration | null,
  lifts: Lifts | null = null,
): LineBox | null {
  if (!open.texts.length && !open.atomics.length && !open.edges.length) {
    return null;
  }
  if (open.order.some((p) => needsOrdering(p, rtl))) reorderLine(open, rtl);
  // Every line box starts with the block's strut, its face at its line
  // height, so a line of images alone is still as tall as `line-height`
  // makes a line (CSS 2.1 10.8.1). Not one with nothing on it that takes
  // room, which has no height at all (9.4.2), nor one that holds a block
  // an inline box was split around, which is no line of text.
  const held =
    strut &&
    (open.texts.length > 0 ||
      open.atomics.some((placed) =>
        placed.box.style.display.startsWith('inline'),
      ) ||
      open.edges.some((edge) => edge.width !== 0));
  let ascent = held ? strut.ascent : 0;
  let descent = held ? strut.descent : 0;
  let height = ascent + descent;
  // A text `vertical-align` raises takes its own box's room about where it
  // is raised to. A `top` or `bottom` box takes the room of all it holds
  // on the line about its baseline, and the line is as tall as that.
  const lifted = lifts ? open.texts.map((text) => lifts.of(text)) : null;
  let edges: Map<Box, { ascent: number; descent: number }> | null = null;
  for (let i = 0; i < open.texts.length; i += 1) {
    const lift = lifted?.[i];
    if (lift) {
      if (lift.edge) {
        edges ??= new Map();
        let room = edges.get(lift.edge.box);
        if (!room) {
          room = { ascent: lift.edge.ascent, descent: lift.edge.descent };
          edges.set(lift.edge.box, room);
        }
        room.ascent = Math.max(room.ascent, lift.ascent + lift.raise);
        room.descent = Math.max(room.descent, lift.descent - lift.raise);
      } else {
        ascent = Math.max(ascent, lift.ascent + lift.raise);
        descent = Math.max(descent, lift.descent - lift.raise);
      }
      continue;
    }
    const natural = open.texts[i].layout.lines[open.texts[i].layoutLine];
    const own = natural.baseline - natural.y;
    ascent = Math.max(ascent, own);
    descent = Math.max(descent, natural.height - own);
    height = Math.max(height, natural.height);
  }
  // a raised inline box with no text on the line is on it all the same,
  // as tall as its own face and line height make it (CSS 2.1 10.8): an
  // empty one, or one whose text is on another line
  if (lifts) {
    for (const placed of open.edges) {
      if (placed.side !== 'start' || placed.box.kind !== 'inline') continue;
      const room = lifts.ofBox(placed.box);
      if (!room) continue;
      ascent = Math.max(ascent, room.ascent + room.raise);
      descent = Math.max(descent, room.descent - room.raise);
    }
  }
  for (const placed of open.atomics) {
    const box = placed.box;
    const h = box.height + box.marginTop + box.marginBottom;
    const va = box.style.verticalAlign;
    if (va === 'top' || va === 'bottom' || va === 'middle') {
      height = Math.max(height, h);
      continue;
    }
    // on the line's baseline by its own, and below it by the rest of it
    const raise = typeof va === 'number' ? va : 0;
    const b = atomicBaseline(box);
    ascent = Math.max(ascent, b + raise);
    descent = Math.max(descent, h - b - raise);
  }
  if (edges) {
    for (const room of edges.values()) {
      height = Math.max(height, room.ascent + room.descent);
    }
  }
  height = Math.max(height, ascent + descent);
  const baseline = Math.max(ascent, (height - ascent - descent) / 2 + ascent);

  // Placed beside the floats at the text's height; a float the whole line
  // reaches moves it, and the alignment divides the room that is left.
  // The indent is at the line's start, which is its right in a
  // right-to-left paragraph: the content moves back over it there, and
  // the room it takes is at the other end (CSS 2.1 16.1).
  const band = bandFor(height);
  const indent = rtl ? open.indent : 0;
  const used = open.x - open.hang - indent;
  const free = band.right - indent - band.left - used;
  let dx = band.left - open.left - indent;
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
    x: open.left + indent,
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
  // layout thinks: that is what makes a small `<span>` beside body text sit
  // on the same baseline rather than on its own. One that `vertical-align`
  // raises is drawn that far above it.
  for (let i = 0; i < open.texts.length; i += 1) {
    const text = open.texts[i];
    const natural = text.layout.lines[text.layoutLine];
    let at = y + baseline;
    const lift = lifted?.[i];
    if (lift) {
      const room = lift.edge && edges!.get(lift.edge.box)!;
      if (lift.edge?.to === 'top') at = y + room!.ascent - lift.raise;
      else if (lift.edge) at = y + height - room!.descent - lift.raise;
      else at -= lift.raise;
      if (at !== y + baseline) {
        TEXT_RAISES.set(text, y + baseline - at);
        SHIFTED_LINES.add(line);
      }
    }
    text.drawY = at - natural.baseline;
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
      return line.baseline - atomicBaseline(box) + line.height * 0.1;
    case 'super':
      return line.baseline - atomicBaseline(box) - line.height * 0.25;
    default:
      if (typeof box.style.verticalAlign === 'number') {
        return line.baseline - atomicBaseline(box) - box.style.verticalAlign;
      }
      return line.baseline - atomicBaseline(box);
  }
}

/**
 * Where an atomic's baseline is, from the top of its margin box (CSS 2.1
 * 10.8.1, 17.5.3): an inline-block's is its last line box's, an
 * inline-table's its first row's — its first line box's — and the bottom of
 * its margin box where it has none, is replaced, or clips what overflows
 * it. Set bottom-on-baseline, an inline-block's text sat its descent above
 * the text beside it, and a line holding one grew by as much.
 *
 * Read while the atomic is still where it was laid out, before the line
 * moves it: its lines are then at the same offset from its top as they will
 * be after.
 */
function atomicBaseline(box: Box): number {
  const bottom = box.height + box.marginTop + box.marginBottom;
  if (
    box.kind === 'replaced' ||
    box.style.overflowX !== 'visible' ||
    box.style.overflowY !== 'visible'
  ) {
    return bottom;
  }
  const baseline =
    box.kind === 'table' ? tableBaseline(box) : lastBaselineIn(box);
  return baseline === null ? bottom : box.marginTop + (baseline - box.y);
}

/**
 * A table's baseline: its first row's (CSS 2.1 17.5.3), which is the first
 * line of a cell in the row, or where no cell in it has a line, the bottom
 * content edge of the row's lowest cell. Not the table's bottom: a table
 * of empty rows stands on its first one, and the rest hang below the line.
 */
function tableBaseline(table: Box): number | null {
  const { cells } = tableGrid(table);
  let lowest = -Infinity;
  for (const cell of cells) {
    if (cell.row > 0) break;
    const found = firstBaselineIn(cell.box);
    if (found !== null) return found;
    const b = cell.box;
    lowest = Math.max(lowest, b.y + b.height - b.padBottom - b.borderBottom);
  }
  return lowest === -Infinity ? null : lowest;
}

/**
 * The baseline a box's content gives it, in document coordinates: its last
 * line box's, or its last in-flow child's with one — and a child that clips
 * what overflows it gives its bottom margin edge and no deeper, whatever
 * text it holds (CSS Box Alignment's synthesized baseline). Null where
 * nothing in it has one.
 */
function lastBaselineIn(box: Box): number | null {
  if (box.lines?.length) {
    const line = box.lines[box.lines.length - 1];
    return line.y + line.baseline;
  }
  for (let i = box.children.length - 1; i >= 0; i -= 1) {
    const found = childBaseline(box.children[i], lastBaselineIn);
    if (found !== null) return found;
  }
  return null;
}

/** The same, from the first line box or child: a table's baseline is its
 *  first row's, and so is a table cell's. */
export function firstBaselineIn(box: Box): number | null {
  if (box.lines?.length) return box.lines[0].y + box.lines[0].baseline;
  for (const child of box.children) {
    const found = childBaseline(child, firstBaselineIn);
    if (found !== null) return found;
  }
  return null;
}

function childBaseline(
  child: Box,
  inside: (box: Box) => number | null,
): number | null {
  if (child.outOfFlow || child.isFloat || child.kind === 'replaced') {
    return null;
  }
  if (
    child.style.overflowX !== 'visible' ||
    child.style.overflowY !== 'visible'
  ) {
    return child.y + child.height + child.marginBottom;
  }
  return inside(child);
}

// --- gathering --------------------------------------------------------------

/** Flatten an inline subtree into a stream of runs, atomics, breaks and the
 *  edges of the inline boxes the text sits in. */
/** Gather an inline formatting context's content into `out`, and answer
 *  how many floats it gathered — none unless `floats` asks for them. */
function collect(
  box: Box,
  out: Item[],
  width: number,
  fonts: FontsLike | null,
  block: ComputedStyle,
  floats: boolean,
): number {
  let floated = 0;
  for (const child of box.children) {
    if (child.outOfFlow) continue;
    if (child.isFloat) {
      if (floats) {
        out.push({ kind: 'float', box: child });
        floated += 1;
      }
      continue;
    }
    switch (child.kind) {
      case 'text':
        if (child.text) {
          const run = runFor(heldText(child), child.style);
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
        // And a box that `position: relative` moves or `vertical-align`
        // raises has them, so that its text is laid out apart from the text
        // around it, to be drawn where the box goes (`offsetInline`,
        // `Lifts`)
        const edged =
          start !== 0 ||
          end !== 0 ||
          (child.decoration !== null &&
            child.style.borderRadius.some((r) => r !== 0)) ||
          isOffset(child.style) ||
          child.style.verticalAlign !== 'baseline' ||
          (fonts !== null && ownsLeading(fonts, block, child.style));
        if (edged) {
          out.push({ kind: 'edge', box: child, side: 'start', width: start });
        }
        // `unicode-bidi` as the controls it stands for, inside the box's
        // edges and around its text, where it has any
        const controls =
          child.style.unicodeBidi !== 'normal' &&
          child.subtreeTextEnd > child.subtreeTextStart
            ? bidiControls(child.style, false)
            : null;
        if (controls) {
          pushControls(out, controls[0], child, child.subtreeTextStart);
        }
        floated += collect(child, out, width, fonts, block, floats);
        if (controls) {
          pushControls(out, controls[1], child, child.subtreeTextEnd);
        }
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
  return floated;
}

/**
 * Keep the words of a `nowrap` element together where its block wraps
 * (CSS 2.1 16.6): laid out, a space it may not break after is a no-break
 * space, as wide and as many, so every offset holds. Whether a line breaks
 * after a space is the call of the nearest element holding the space and
 * what follows it (CSS Text 3, 5.1), so the space such an element ends on
 * stays one where the text after it wraps.
 */
function holdNoWrap(items: Item[]): void {
  let next: Extract<Item, { kind: 'text' }> | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'text') continue;
    const text = item.run.text;
    // `pre`'s are no-break spaces already (`runFor`)
    if (item.box.style.whiteSpace === 'nowrap' && text.includes(' ')) {
      let held = text.replace(/ /g, '\u00a0');
      if (text.endsWith(' ') && (!next || wraps(next.box.style))) {
        held = held.slice(0, -1) + ' ';
      }
      item.run = { ...item.run, text: held };
    }
    next = item;
  }
}

/** The bidi controls `unicode-bidi` stands for, opening and closing (CSS
 *  Writing Modes 3, 2.4.2), in the direction of the box; null for `normal`.
 *  On a block only an override opens anything: the block's embedding is
 *  its paragraph's direction. */
function bidiControls(
  style: ComputedStyle,
  block: boolean,
): [string, string] | null {
  const rtl = style.direction === 'rtl';
  const override = rtl ? '\u202E' : '\u202D';
  switch (style.unicodeBidi) {
    case 'embed':
      return [rtl ? '\u202B' : '\u202A', '\u202C'];
    case 'bidi-override':
      return [override, '\u202C'];
    case 'isolate':
      return [rtl ? '\u2067' : '\u2066', '\u2069'];
    case 'isolate-override':
      return block
        ? [override, '\u202C']
        : [(rtl ? '\u2067' : '\u2066') + override, '\u202C\u2069'];
    case 'plaintext':
      return ['\u2068', '\u2069'];
    default:
      return null;
  }
}

/** Bidi controls as items of their own, one a unit, at a document index
 *  none of them takes up. */
function pushControls(
  out: Item[],
  controls: string,
  box: Box,
  start: number,
): void {
  for (const control of controls) {
    out.push({
      kind: 'text',
      run: runFor(control, box.style),
      box,
      length: 1,
      start,
      control: true,
    });
  }
}

function hasControls(items: Item[]): boolean {
  for (const item of items)
    if (item.kind === 'text' && item.control) return true;
  return false;
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
  box.borderTop = usedBorder(s.borderTopWidth, s.borderTopStyle);
  box.borderRight = usedBorder(s.borderRightWidth, s.borderRightStyle);
  box.borderBottom = usedBorder(s.borderBottomWidth, s.borderBottomStyle);
  box.borderLeft = usedBorder(s.borderLeftWidth, s.borderLeftStyle);
  box.padTop = resolve(s.paddingTop, width);
  box.padRight = resolve(s.paddingRight, width);
  box.padBottom = resolve(s.paddingBottom, width);
  box.padLeft = resolve(s.paddingLeft, width);
  box.marginLeft = resolve(s.marginLeft, width);
  box.marginRight = resolve(s.marginRight, width);
  if (box.cut) {
    // a piece of a box broken around a block has no edge where it was cut
    const rtl = s.direction === 'rtl';
    if (box.cut & (rtl ? 2 : 1)) {
      box.marginLeft = box.borderLeft = box.padLeft = 0;
    }
    if (box.cut & (rtl ? 1 : 2)) {
      box.marginRight = box.borderRight = box.padRight = 0;
    }
  }
  const decorated =
    !isTransparent(s.backgroundColor) ||
    box.borderTop + box.borderRight + box.borderBottom + box.borderLeft > 0 ||
    s.outlineStyle !== 'none';
  box.decoration = !decorated ? null : fonts ? faceExtent(fonts, s) : NO_EXTENT;
  const left = box.marginLeft + box.borderLeft + box.padLeft;
  const right = box.padRight + box.borderRight + box.marginRight;
  return s.direction === 'rtl' ? [right, left] : [left, right];
}

/** A border's width, or none where its style draws none. */
function usedBorder(
  width: number,
  style: ComputedStyle['borderTopStyle'],
): number {
  return style === 'none' || style === 'hidden' ? 0 : width;
}

/** A face's ascent and descent at a style's size, kept per font manager
 *  and shared by the boxes set in it: by the style, which the cascade
 *  shares between every element of a kind, and by the face, which styles
 *  that differ in anything else share. */
const FACE_EXTENTS = new WeakMap<
  FontsLike,
  {
    byStyle: WeakMap<ComputedStyle, InlineDecoration>;
    byFace: Map<string, InlineDecoration>;
  }
>();

/** The extent of a decorated box where there are no fonts to ask. */
const NO_EXTENT: InlineDecoration = { ascent: 0, descent: 0 };

/** A style's face's ascent and descent, which an inline box's background
 *  is painted over. */
export function faceExtentOf(
  fonts: FontsLike,
  style: ComputedStyle,
): InlineDecoration {
  return faceExtent(fonts, style);
}

function faceExtent(fonts: FontsLike, style: ComputedStyle): InlineDecoration {
  let cache = FACE_EXTENTS.get(fonts);
  if (!cache) {
    cache = { byStyle: new WeakMap(), byFace: new Map() };
    FACE_EXTENTS.set(fonts, cache);
  }
  let extent = cache.byStyle.get(style);
  if (extent) return extent;
  const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.fontStyle}`;
  extent = cache.byFace.get(key);
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
    if (cache.byFace.size > 64) cache.byFace.clear();
    cache.byFace.set(key, extent);
  }
  cache.byStyle.set(style, extent);
  return extent;
}

/**
 * The first line's text in its `::first-line` colour: the runs before the
 * line's end whose colour is the block's own, the one that ends past it cut
 * there. A run in a colour of its own — a link's — keeps it, as an element
 * inside the pseudo-element does. Colour moves no glyph, so the lines break
 * where they did.
 */
function firstLineColour(
  items: Item[],
  firstLine: { color: string; from: string; end: number },
): void {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind !== 'text') continue;
    // past the line: a run in a colour of its own may have been the one
    // across its end, so this is where the walk stops, not at the cut
    if (item.start >= firstLine.end) break;
    if (item.run.color !== firstLine.from) continue;
    const cut = firstLine.end - item.start;
    if (cut < item.length) {
      items.splice(i + 1, 0, {
        ...item,
        run: { ...item.run, text: item.run.text.slice(cut) },
        start: item.start + cut,
        length: item.length - cut,
      });
      items[i] = {
        ...item,
        run: {
          ...item.run,
          text: item.run.text.slice(0, cut),
          color: firstLine.color,
        },
        length: cut,
      };
      break;
    }
    items[i] = { ...item, run: { ...item.run, color: firstLine.color } };
  }
}

/** The `TextRun` one styled piece of text becomes: its text, and what paint
 *  needs of its style — nothing that names a box or an element, so that a
 *  layout made from it can be kept for the next parse (`TextLayoutCache`). */
/**
 * A text box's text as it is laid out. `pre` keeps its spaces whole: none
 * is broken after, and none hangs at a line's end, where a trailing space
 * counts in the line's width. Laid out, they are no-break spaces, as wide
 * and as many, so every offset holds (CSS Text 3, 4.1.3). Kept per box: a
 * pass makes no new string, and the kept layouts find their text by
 * identity before they compare it.
 */
/**
 * Tabs a `white-space` keeps, set at their stops (CSS Text 3, 4.2): a stop
 * every `tab-size` spaces of the block's font from the line's start, and a
 * tab that would reach one less than half a `ch` on goes to the next.
 * Neither engine has them — ntk draws a tab a space wide, and CoreText
 * sets it at stops of its own every 28 points — so a tab is laid out as a
 * space spaced out to its stop: text as the engine sees it and not as the
 * document holds it, the way `heldText` holds a `pre`'s spaces. Where each
 * tab starts is read off one layout of the paragraph with its tabs as
 * spaces, and its inline boxes' edges and its atomics as the room they
 * take, unwrapped: a line `pre-wrap` wraps sets the tabs after the wrap as
 * though it had not, and a right-to-left one sets them a space wide.
 *
 * Read off each tab's run, which the tab is given of its own, and not off
 * a caret: CoreText puts a caret after a spaced glyph part of the way
 * into its spacing, so a tab after `word-spacing` was set from a place
 * half the spacing short of where it is drawn.
 */
function setTabs(
  items: Item[],
  fonts: FontsLike,
  block: ComputedStyle,
  indent: number,
): void {
  // the paragraph as it will be laid out, an inline box's edges and an
  // atomic as the room they take, each tab a run of its own, and where
  // each text item starts in it
  const runs: TextRun[] = [];
  const starts = new Map<Item, number>();
  const tabs = new Set<number>();
  let units = 0;
  for (const item of items) {
    // a float is beside the line, and takes none of it
    if (item.kind === 'float') continue;
    if (item.kind !== 'text') {
      const box = item.box;
      runs.push(
        spacerRun(
          fonts,
          block,
          item.kind === 'edge'
            ? item.width
            : box.width + box.marginLeft + box.marginRight,
        ),
      );
      units += 1;
      continue;
    }
    starts.set(item, units);
    const text = item.run.text;
    if (item.control || !text.includes('\t')) {
      runs.push(item.run);
      units += text.length;
      continue;
    }
    let done = 0;
    for (let p = text.indexOf('\t'); p >= 0; p = text.indexOf('\t', p + 1)) {
      if (p > done) runs.push({ ...item.run, text: text.slice(done, p) });
      // spaced a hair apart from its neighbours, which an engine that
      // merges runs alike (CoreText) would otherwise take it into
      tabs.add(units + p);
      runs.push({
        ...item.run,
        text: spaceIn(item.box),
        letterSpacing: (item.run.letterSpacing ?? 0) + tabs.size * HAIR,
      });
      done = p + 1;
    }
    if (done < text.length) runs.push({ ...item.run, text: text.slice(done) });
    units += text.length;
  }
  const natural = fonts.layout(runs, fontOf(block), {
    direction: block.direction,
  });
  /** Where each tab starts, by its place in the layout's text. */
  const found = new Map<number, { x: number; line: number }>();
  natural.lines.forEach((line, i) => {
    for (const run of line.runs ?? []) {
      if (tabs.has(run.start))
        found.set(run.start, { x: line.x + run.x, line: i });
    }
  });
  let offsets: number[] | null | undefined;
  const space =
    advanceOf(fonts, fontOf(block), ' ') +
    block.letterSpacing +
    block.wordSpacing;
  const every = block.tabSizeIsLength ? block.tabSize : block.tabSize * space;
  const half = advanceOf(fonts, fontOf(block), '0') / 2;
  const rtl = block.direction === 'rtl';
  /** The room tabs have added to each line so far. */
  const added = new Map<number, number>();
  const next: Item[] = [];
  for (const item of items) {
    if (item.kind !== 'text' || item.control || !item.run.text.includes('\t')) {
      next.push(item);
      continue;
    }
    const text = item.run.text;
    const at = starts.get(item)!;
    // what the space a tab is laid out as takes before it is spaced out
    const own =
      advanceOf(fonts, item.run, spaceIn(item.box)) +
      (item.run.letterSpacing ?? 0);
    const piece = (start: number, end: number, run: TextRun): void => {
      next.push({
        ...item,
        run,
        length: end - start,
        start: item.start + start,
      });
    };
    let done = 0;
    for (let p = text.indexOf('\t'); p >= 0; p = text.indexOf('\t', p + 1)) {
      if (p > done) piece(done, p, { ...item.run, text: text.slice(done, p) });
      let advance = own;
      if (!rtl) {
        const unit = at + p;
        let caret = found.get(unit);
        if (!caret) {
          // an engine that says nothing of its runs has a caret to go by
          if (offsets === undefined) {
            const joined = runs.map((run) => run.text).join('');
            offsets = /[\uD800-\uDFFF]/.test(joined)
              ? codeUnitOffsets(joined)
              : null;
          }
          caret = natural.caretPosition(
            offsets ? codePointAt(offsets, unit) : unit,
          );
        }
        const before = added.get(caret.line) ?? 0;
        const x = caret.x + before + (caret.line === 0 ? indent : 0);
        if (every > 0) {
          let stop = (Math.floor(x / every) + 1) * every;
          if (stop - x < half) stop += every;
          advance = stop - x;
        } else advance = 0;
        added.set(caret.line, before + advance - own);
      }
      piece(p, p + 1, {
        ...item.run,
        text: spaceIn(item.box),
        letterSpacing: (item.run.letterSpacing ?? 0) + advance - own,
      });
      done = p + 1;
    }
    if (done < text.length) {
      piece(done, text.length, { ...item.run, text: text.slice(done) });
    }
  }
  items.splice(0, items.length, ...next);
}

/** The space a tab in a box is laid out as: a `pre`'s spaces are held
 *  together (`heldText`), and so are its tabs. */
function spaceIn(box: Box): string {
  return box.style.whiteSpace === 'pre' ? '\u00a0' : ' ';
}

/** A text's font, the part of a run a character's advance depends on. */
type Face = Pick<TextRun, 'family' | 'size' | 'weight' | 'style'>;

/** A block's font, as its runs name it (`runFor`). */
function fontOf(style: ComputedStyle): Face {
  return {
    family: style.fontFamily,
    size: style.fontSize,
    weight: style.fontWeight,
    style: style.fontStyle === 'normal' ? 'normal' : 'italic',
  };
}

/** One character's advance in a font, kept per font manager. */
function advanceOf(fonts: FontsLike, font: Face, char: string): number {
  let kept = ADVANCES.get(fonts);
  if (!kept) ADVANCES.set(fonts, (kept = new Map()));
  const key = `${font.family}|${font.size}|${font.weight}|${font.style}|${char}`;
  let advance = kept.get(key);
  if (advance === undefined) {
    const face: Face = {
      family: font.family,
      size: font.size,
      weight: font.weight,
      style: font.style,
    };
    // between two letters, so that no engine drops it as a line's end
    advance =
      fonts.layout([{ ...face, text: `x${char}x` }], face, {}).width -
      fonts.layout([{ ...face, text: 'xx' }], face, {}).width;
    kept.set(key, advance);
  }
  return advance;
}

const ADVANCES = new WeakMap<FontsLike, Map<string, number>>();

function heldText(box: Box): string {
  if (box.style.whiteSpace !== 'pre' || !box.text.includes(' ')) {
    return box.text;
  }
  let held = HELD.get(box);
  if (held === undefined) {
    held = box.text.replace(/ /g, '\u00a0');
    HELD.set(box, held);
  }
  return held;
}

const HELD = new WeakMap<Box, string>();

/**
 * The OpenType features a style's text is shaped with: the `font-variant`
 * longhands' and `font-kerning`'s, then `font-feature-settings`, which has
 * the last word (CSS Fonts 3, 7.2). One object for each set of them, kept,
 * because a run's fields are compared by identity — a new object a pass
 * would find no layout the last pass made.
 */
export function featuresOf(
  style: ComputedStyle,
): Readonly<Record<string, number>> | null {
  const {
    fontKerning: kerning,
    fontVariantLigatures: ligatures,
    fontVariantNumeric: numeric,
    fontVariantCaps: caps,
    fontVariantPosition: position,
    fontFeatureSettings: settings,
  } = style;
  if (!kerning && !ligatures && !numeric && !caps && !position && !settings) {
    return null;
  }
  const key = `${kerning}|${ligatures}|${numeric}|${caps}|${position}|${settings}`;
  let features = FEATURES.get(key);
  if (!features) {
    const out: Record<string, number> = {};
    for (const part of [
      kerning,
      ligatures,
      numeric,
      caps,
      position,
      settings,
    ]) {
      if (!part) continue;
      for (const pair of part.split(',')) {
        const at = pair.indexOf('=');
        out[pair.slice(0, at)] = Number(pair.slice(at + 1));
      }
    }
    features = Object.freeze(out);
    FEATURES.set(key, features);
  }
  return features;
}

const FEATURES = new Map<string, Readonly<Record<string, number>>>();

function runFor(text: string, style: ComputedStyle): TextRun {
  const run: TextRun = {
    text,
    family: style.fontFamily,
    size: style.fontSize,
    weight: style.fontWeight,
    style: style.fontStyle === 'normal' ? 'normal' : 'italic',
    // the glyphs' fill, which `-webkit-text-fill-color` sets apart from
    // `color` — the decorations keep `color`
    color:
      style.textFillColor === null
        ? style.color
        : inkColor(style.textFillColor, style.color),
  };
  if (style.letterSpacing) run.letterSpacing = style.letterSpacing;
  const features = featuresOf(style);
  if (features) run.features = features;
  // Hidden text keeps its place on the line and draws nothing, rules
  // included, and the text of a visible element inside it is its own run
  // (CSS 2.1 11.2): drawn in no ink, it is laid out as it was
  if (style.visibility !== 'visible') {
    run.color = 'transparent';
    return run;
  }
  // A background is not the run's: the inline box it belongs to paints it,
  // behind every fragment of the box — nested elements' text included — and
  // out to its padding (`paintInlineBoxes`).
  // the element's own decorations and the ones propagated to it, in the
  // colours of the elements that set them (`decorate`)
  if (style.underline) {
    run.underline = style.underline;
    // CSS's five rule styles and SGR 4's five are the same set under two
    // names; richtext speaks SGR's, so `solid` is `single` and `wavy` is
    // `curly`. The other three are spelled identically.
    run.underlineStyle =
      style.underlineStyle === 'wavy'
        ? 'curly'
        : style.underlineStyle === 'solid'
          ? 'single'
          : style.underlineStyle;
    if (style.underlineOffset !== null) {
      run.underlineOffset = style.underlineOffset;
    }
    if (style.underlineThickness !== null) {
      run.underlineThickness = style.underlineThickness;
    }
  }
  if (style.lineThrough) run.strike = style.lineThrough;
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
  /** Where the laid-out text has a unit that is no text of the document's:
   *  a spacer, a bidi control. */
  private _gaps: number[] | null = null;
  laidOut = 0;

  add(documentStart: number, length: number, box: Box | null = null): void {
    this._laid.push(this.laidOut);
    this._doc.push(documentStart);
    this._boxes.push(box);
    if (!box) {
      this._gaps ??= [];
      for (let i = 0; i < length; i += 1) this._gaps.push(this.laidOut + i);
    }
    this.laidOut += length;
  }

  /** Give a line's text the gaps in its part of the laid-out text, where
   *  it has any. Set after the text is made rather than spread into it: a
   *  spread in an object literal costs every line that has none. */
  giveGaps(text: LineText, start: number, end: number): void {
    if (!this._gaps) return;
    const gaps = this._gaps.filter((at) => at >= start && at < end);
    if (gaps.length) text.gaps = gaps;
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
      spans.add(item.start + skip, text.length, item.control ? null : item.box);
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

/**
 * The white space a text engine strips from a line's end, as a pattern for
 * the end of a run: spaces and tabs, and the no-break space too where the
 * engine strips that — ntk to 8.12.9 and CoreText through @windowkit/appkit
 * 0.15.0 do, where CSS measures it (sidorares/ntk#395, windowkit/appkit#83).
 * Asked of the engine once per font manager, because what the line adds back
 * has to be what the engine took: added back after an engine that kept it, a
 * no-break space before an image counted twice.
 */
const HUNG = new WeakMap<FontsLike, RegExp>();

export function hungSpaces(fonts: FontsLike, run: TextRun): RegExp {
  let hung = HUNG.get(fonts);
  if (!hung) {
    const style = { family: run.family, size: run.size };
    const width = (text: string): number =>
      fonts.layout([{ ...style, text }], style, {}).lines[0]?.width ?? 0;
    hung = width('x\u00A0') > width('x') ? /[ \t]+$/ : /[ \t\u00A0]+$/;
    HUNG.set(fonts, hung);
  }
  return hung;
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

/** How far a line of a layout moves to where it belongs in its box. */
type LinePlacer = (line: { x: number; width: number }) => number;

/** The blocks whose lines hold text a box's background shows through. */
export const CLIPPED_TEXT = new WeakSet<Box>();

/** How each of those blocks' layouts was made, to make it again. */
const RECORDED = new WeakMap<
  object,
  {
    fonts: FontsLike;
    content: TextRun[];
    style: Record<string, unknown>;
    options: Parameters<FontsLike['layout']>[2];
  }
>();
const RECORDERS = new WeakMap<FontsLike, FontsLike>();
const INKLESS = new WeakMap<object, TextLayoutLike | null>();

/** The fonts, noting how each layout they make was made. One recorder a
 *  fonts object, so what is kept per fonts object is kept for it too. */
function recording(fonts: FontsLike): FontsLike {
  let recorder = RECORDERS.get(fonts);
  if (!recorder) {
    recorder = {
      layout(content, style, options) {
        const layout = fonts.layout(content, style, options);
        RECORDED.set(layout, { fonts, content, style, options });
        return layout;
      },
      match: (family, style) => fonts.match(family, style),
    };
    RECORDERS.set(fonts, recorder);
  }
  return recorder;
}

/**
 * A layout of the same text with no ink of its own, which an engine draws
 * in the context's fill — a gradient's, for text a background shows
 * through; the same runs, so the same glyphs where the first put them.
 * Null for a layout that was not recorded.
 */
export function inklessLayout(layout: object): TextLayoutLike | null {
  let inkless = INKLESS.get(layout);
  if (inkless !== undefined) return inkless;
  const made = RECORDED.get(layout);
  inkless = made
    ? made.fonts.layout(
        made.content.map((run) => ({ ...run, color: undefined })),
        { ...made.style, color: undefined },
        made.options,
      )
    : null;
  INKLESS.set(layout, inkless);
  return inkless;
}

/** Whether any of a block's text is text a background shows through. */
function clipsText(block: Box, items: Item[]): boolean {
  for (const item of items) {
    if (item.kind === 'text' && !item.control && clipBoxOf(item.box, block)) {
      return true;
    }
  }
  return false;
}

/** The box whose background a text box's glyphs show: the nearest element
 *  box from it up to the block its lines are in with `background-clip:
 *  text`, or null. */
export function clipBoxOf(box: Box | null, block: Box): Box | null {
  for (let at = box; at; at = at.parent) {
    if (at.kind !== 'text' && at.style.backgroundClipText) return at;
    if (at === block) break;
  }
  return null;
}

/** The most lines `text-wrap: balance` evens out, as in Chrome: a heading,
 *  a caption, a pull quote — not a paragraph, whose last line is its own. */
const BALANCE_LINES = 6;

/**
 * The narrowest width a paragraph's text breaks into no more lines than
 * `layout` has (CSS Text 4, 6.2), found by halving the width between the
 * least that could hold them — their widths over their number — and the
 * width it was laid out at. The engine breaks the lines, so each step
 * asks it; eight steps come to within a pixel of the answer for a heading
 * across a page.
 */
function balancedWidth(
  fonts: FontsLike,
  runs: TextRun[],
  base: Record<string, unknown>,
  options: Parameters<FontsLike['layout']>[2],
  width: number,
  layout: TextLayoutLike,
): number {
  const count = layout.lines.length;
  let total = 0;
  for (const line of layout.lines) total += line.width;
  let lo = total / count;
  let hi = width;
  for (let step = 0; step < 8 && hi - lo > 1; step += 1) {
    const mid = (lo + hi) / 2;
    const probe = fonts.layout(runs, base, { ...options, maxWidth: mid });
    if (probe.lines.length <= count) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi);
}

/**
 * Where `text-align` puts the lines of a layout that was given no width to
 * align them in — text that does not wrap, which has no `maxWidth` — as how
 * far each moves: the engine aligns those lines within the widest of them,
 * which for a single line is no alignment at all, so a centred `<td
 * nowrap>` or a `white-space: nowrap` button label was set flush left. A
 * line too long for its box is set at its start, overflowing its end (CSS
 * Text 3, 7.1), which is its left in a right-to-left paragraph, as in
 * Blink. Null where every line is already where it belongs: flush left in
 * a left-to-right paragraph, or measured for a width it has not been given.
 */
function unwrappedPlacer(
  style: ComputedStyle,
  width: number,
): LinePlacer | null {
  const shift = lineShift(style);
  const rtl = style.direction === 'rtl';
  if ((shift === 0 && !rtl) || !Number.isFinite(width)) return null;
  return (line) => {
    const free = width - line.width;
    return (free >= 0 ? free * shift : rtl ? free : 0) - line.x;
  };
}

/**
 * The spacing a space is given to be laid out as one that may be spaced
 * apart, too little to move a glyph. It is not nothing, because neither
 * engine measures a space that is a spaced run of its own as it measures
 * the same space inside its run: ntk shapes each run apart, so the kerning
 * pair a space made with the letter beside it is gone (Arial's `A` and
 * `T` have them), and CoreText spaces a glyph with its kerning attribute,
 * which takes the place of the font's pairs. A line justified from a
 * measure of its spaces as they were came out wider than its box and
 * broke a word early: on macOS, in Helvetica, half of a paragraph did.
 */
const HAIR = 1e-6;

/** The runs with each space a run of its own, spaced a hair apart. */
function spacedApart(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    const text = run.text;
    let piece = 0;
    for (let at = 0; at < text.length; at += 1) {
      const c = text.charCodeAt(at);
      if (c !== 0x20 && c !== 0xa0) continue;
      if (at > piece) out.push({ ...run, text: text.slice(piece, at) });
      out.push({
        ...run,
        text: text[at],
        letterSpacing: (run.letterSpacing ?? 0) + HAIR,
      });
      piece = at + 1;
    }
    if (piece === 0) out.push(run);
    else if (piece < text.length) out.push({ ...run, text: text.slice(piece) });
  }
  return out;
}

/**
 * `text-align: justify` (CSS Text 3, 7.4), as neither engine has it: the
 * paragraph's runs again, with each space inside a line that is to be
 * justified widened by its share of what the line leaves of `width` — the
 * `letter-spacing` a `word-spacing` is drawn with — so the same breaks fill
 * their lines. A line that is the paragraph's last, or that a forced break
 * ends, is not justified, nor one with no space inside it; the spaces a
 * line ends on hang, and take no share. Null where no line is justified.
 */
function justifiedRuns(
  runs: TextRun[],
  layout: TextLayoutLike,
  width: number,
): TextRun[] | null {
  const text = runs.map((run) => run.text).join('');
  // each space's extra, by its offset in the paragraph
  const extra = new Map<number, number>();
  const lines = layout.lines;
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i];
    let end = line.end;
    if (text[end - 1] === '\n' || text[end] === '\n') continue;
    while (
      end > line.start &&
      (text[end - 1] === ' ' || text[end - 1] === '\u00a0')
    )
      end -= 1;
    const spaces: number[] = [];
    for (let at = line.start; at < end; at += 1) {
      if (text[at] === ' ' || text[at] === '\u00a0') spaces.push(at);
    }
    // a hair short, so that the engine breaks where it did
    const slack = width - line.width - 0.01;
    if (!spaces.length || !(slack > 0)) continue;
    for (const at of spaces) extra.set(at, slack / spaces.length);
  }
  if (!extra.size) return null;
  const out: TextRun[] = [];
  let from = 0;
  for (const run of runs) {
    const end = from + run.text.length;
    let piece = from;
    for (let at = from; at < end; at += 1) {
      const add = extra.get(at);
      if (add === undefined) continue;
      if (at > piece) out.push({ ...run, text: text.slice(piece, at) });
      out.push({
        ...run,
        text: text[at],
        letterSpacing: (run.letterSpacing ?? 0) + add,
      });
      piece = at + 1;
    }
    if (end > piece) out.push({ ...run, text: text.slice(piece, end) });
    from = end;
  }
  return out;
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
  // of zero where the width is not known yet, as when measuring the
  // content's width: a `calc()` keeps its pixels (CSS Sizing 3 5.2.1)
  return resolve(indent, Number.isFinite(width) ? width : 0);
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
export function lineHeightMultiplier(
  fonts: FontsLike,
  style: ComputedStyle,
): number {
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
 * CoreText every answer was a call to the native side. Found by the style
 * object first, as `faceExtent` is: the paragraphs of a pass share their
 * styles, and spelling a face into a string key for each was a millisecond
 * of every pass over a long document.
 */
const NATURAL_LINE_HEIGHT = new WeakMap<
  FontsLike,
  { byStyle: WeakMap<ComputedStyle, number>; byFace: Map<string, number> }
>();

function naturalLineHeight(fonts: FontsLike, style: ComputedStyle): number {
  let cache = NATURAL_LINE_HEIGHT.get(fonts);
  if (!cache) {
    cache = { byStyle: new WeakMap(), byFace: new Map() };
    NATURAL_LINE_HEIGHT.set(fonts, cache);
  }
  const known = cache.byStyle.get(style);
  if (known !== undefined) return known;
  const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.fontStyle}`;
  let height = cache.byFace.get(key);
  if (height === undefined) {
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
    if (cache.byFace.size > 64) cache.byFace.clear();
    cache.byFace.set(key, height);
  }
  cache.byStyle.set(style, height);
  return height;
}

/**
 * A block's strut: the ascent and descent of a line of nothing in its face,
 * the half-leading its `line-height` adds shared above and below, as the
 * text engines set a line (CSS 2.1 10.8.1).
 */
export function strutOf(
  fonts: FontsLike,
  style: ComputedStyle,
): InlineDecoration {
  // text set at no size takes no room, and CoreText reads a size of 0 as
  // its default twelve points
  if (!(style.fontSize > 0)) return NO_EXTENT;
  const face = faceExtent(fonts, style);
  const target =
    style.lineHeight === 'normal'
      ? naturalLineHeight(fonts, style)
      : style.lineHeightIsLength
        ? (style.lineHeight as number)
        : (style.lineHeight as number) * style.fontSize;
  const half = (target - face.ascent - face.descent) / 2;
  return { ascent: face.ascent + half, descent: face.descent + half };
}

/** Where a text `vertical-align` raised goes on its line. */
interface Lift {
  /** How far above the line's baseline its baseline is — above the top
   *  or bottom box's, under one of those. */
  raise: number;
  /** The room its own inline box takes about its baseline. */
  ascent: number;
  descent: number;
  /** A `top` or `bottom` box it is in, aligned with the line box's edge
   *  rather than with anything's baseline, and the room that box's own
   *  font takes: its content on the line adds to it (`finishLine`). */
  edge: {
    box: Box;
    to: 'top' | 'bottom';
    ascent: number;
    descent: number;
  } | null;
}

/**
 * The raises `vertical-align` gives a paragraph's inline boxes (CSS 2.1
 * 10.8.1): each from its parent's baseline, so a box inside a raised box is
 * raised with it. `sub` and `super` by a fifth and a third of the parent's
 * font size and a pixel, as browsers set them; `text-top` and `text-bottom`
 * to the edges of the parent's font; `middle` by its middle to half the
 * parent's x-height above its baseline; a length by itself and a
 * percentage of the box's own line height. Worked out once a box a pass.
 */
class Lifts {
  private _boxes = new Map<
    Box,
    { raise: number; edge: Box | null; lead: boolean }
  >();

  constructor(
    private readonly fonts: FontsLike,
    private readonly block: ComputedStyle,
  ) {}

  /** Where a text goes, or null for one that is on the line's baseline and
   *  in no box with a line height of its own. */
  of(text: LineText): Lift | null {
    const owner = text.spans.boxAt?.(text.layoutStart);
    const parent = owner?.parent;
    if (!owner || !parent || parent.kind !== 'inline') return null;
    const { raise, edge, lead } = this._box(parent);
    if (!raise && !edge && !lead) return null;
    // the room of every box whose text is in it: no raised box starts or
    // ends inside a fragment, but one it holds may be set larger
    const own = { ...strutOf(this.fonts, owner.style) };
    // and of the inline boxes around it, each about its own baseline: each
    // is on the line with its line height, which the text's may not reach.
    // Not only where one sets a line height of its own: a raised `<sup>`
    // holding a smaller `<a>` — every footnote mark — is as tall on the
    // line as its own font and line height make it (CSS 2.1 10.8)
    if (lead || raise) {
      for (let at: Box | null = parent; at?.kind === 'inline'; at = at.parent) {
        const box = this._box(at);
        const room = strutOf(this.fonts, at.style);
        own.ascent = Math.max(own.ascent, room.ascent + box.raise - raise);
        own.descent = Math.max(own.descent, room.descent - box.raise + raise);
        if (box.edge === at) break;
      }
    }
    const natural = text.layout.lines[text.layoutLine];
    let seen = owner.style;
    for (const run of natural?.runs ?? []) {
      const style = text.spans.boxAt?.(run.start)?.style;
      if (!style || style === seen) continue;
      seen = style;
      const room = strutOf(this.fonts, style);
      own.ascent = Math.max(own.ascent, room.ascent);
      own.descent = Math.max(own.descent, room.descent);
    }
    let to: Lift['edge'] = null;
    if (edge) {
      const room = strutOf(this.fonts, edge.style);
      to = {
        box: edge,
        to: edge.style.verticalAlign === 'top' ? 'top' : 'bottom',
        ascent: room.ascent,
        descent: room.descent,
      };
    }
    return { raise, ascent: own.ascent, descent: own.descent, edge: to };
  }

  /** Where an inline box's own room is about the line's baseline — its
   *  face at its line height, raised as it is — or null for one on the
   *  baseline, or one the line's edge sets. */
  ofBox(box: Box): { raise: number; ascent: number; descent: number } | null {
    const { raise, edge } = this._box(box);
    if (!raise || edge) return null;
    const room = strutOf(this.fonts, box.style);
    return { raise, ascent: room.ascent, descent: room.descent };
  }

  private _box(box: Box): { raise: number; edge: Box | null; lead: boolean } {
    if (box.kind !== 'inline' || !box.parent) return NO_LIFT;
    const known = this._boxes.get(box);
    if (known) return known;
    const va = box.style.verticalAlign;
    const own = ownsLeading(this.fonts, this.block, box.style);
    let lift: { raise: number; edge: Box | null; lead: boolean };
    if (va === 'top' || va === 'bottom') {
      // what is in it is raised from its baseline, which the line's edge
      // sets, whatever is around it
      lift = { raise: 0, edge: box, lead: own };
    } else {
      const up = this._box(box.parent);
      lift = {
        raise: up.raise + this._own(box, box.parent),
        edge: up.edge,
        lead: own || up.lead,
      };
      if (lift.raise && !lift.edge) BOX_RAISES.set(box, lift.raise);
    }
    this._boxes.set(box, lift);
    return lift;
  }

  /** How far a box's own `vertical-align` raises it from its parent's
   *  baseline. */
  private _own(box: Box, parent: Box): number {
    const va = box.style.verticalAlign;
    const size = parent.style.fontSize;
    switch (va) {
      case 'baseline':
      case 'top':
      case 'bottom':
        return 0;
      case 'sub':
        return -(size / 5 + size / 16);
      case 'super':
        return size / 3 + size / 16;
      case 'text-top':
        return (
          faceExtent(this.fonts, parent.style).ascent -
          strutOf(this.fonts, box.style).ascent
        );
      case 'text-bottom':
        return (
          strutOf(this.fonts, box.style).descent -
          faceExtent(this.fonts, parent.style).descent
        );
      case 'middle': {
        const own = strutOf(this.fonts, box.style);
        return (
          xHeightOf(this.fonts, parent.style) / 2 -
          (own.ascent - own.descent) / 2
        );
      }
      default:
        return typeof va === 'number'
          ? va
          : resolve(va, lineHeightOf(this.fonts, box.style));
    }
  }
}

const NO_LIFT = { raise: 0, edge: null, lead: false };

/**
 * Whether an inline box's own line height is more than the one a
 * paragraph's layout gives its text. That layout sets every run at the
 * block's line height, as a multiple of the run's font's natural one;
 * CSS gives each inline box its own, and the line box holds them all (CSS
 * 2.1 10.8.1), so a box whose own is more makes its line taller. One whose
 * own is less, a `<code>` in a font with taller natural lines, is left to
 * the one layout: the line at a time it would take instead costs a long
 * document dear.
 *
 * Asked of every inline box in every paragraph, so it has to cost nothing
 * for the ones that are nothing: a box with its block's line height, family
 * and size is past at once, and any other answer is kept on its style.
 */
function ownsLeading(
  fonts: FontsLike,
  block: ComputedStyle,
  style: ComputedStyle,
): boolean {
  // a bold or an italic face keeps its family's line metrics, and a
  // paragraph is thick with <strong>, <em> and <a>
  if (
    style.lineHeight === block.lineHeight &&
    style.lineHeightIsLength === block.lineHeightIsLength &&
    style.fontSize === block.fontSize &&
    style.fontFamily === block.fontFamily
  ) {
    return false;
  }
  const known = LEADS.get(style);
  if (known && known.block === block && known.fonts === fonts) {
    return known.own;
  }
  const own =
    lineHeightOf(fonts, style) >
    lineHeightMultiplier(fonts, block) * naturalLineHeight(fonts, style) + 0.5;
  LEADS.set(style, { fonts, block, own });
  return own;
}

const LEADS = new WeakMap<
  ComputedStyle,
  { fonts: FontsLike; block: ComputedStyle; own: boolean }
>();

/** A style's line height in pixels. */
function lineHeightOf(fonts: FontsLike, style: ComputedStyle): number {
  if (style.lineHeight === 'normal') return naturalLineHeight(fonts, style);
  return style.lineHeightIsLength
    ? (style.lineHeight as number)
    : (style.lineHeight as number) * style.fontSize;
}

/** A style's x-height, where its font says, or half its size. */
function xHeightOf(fonts: FontsLike, style: ComputedStyle): number {
  try {
    const metrics = fonts
      .match(style.fontFamily, {
        size: style.fontSize,
        weight: style.fontWeight,
        style: style.fontStyle,
      })
      .metrics(style.fontSize) as { xHeight?: number | null };
    if (typeof metrics.xHeight === 'number') return metrics.xHeight;
  } catch {
    // no font to ask
  }
  return style.fontSize / 2;
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
