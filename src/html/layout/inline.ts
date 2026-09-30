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

import bidiModule from 'bidi-js';
import type { Bidi } from 'bidi-js';

import { codePointAtOffset, codeUnitOffsets } from '../../internal/text.js';
import type { TextRun } from '../../richtext/index.js';
import type { ComputedStyle } from '../css/style.js';
import {
  CONTAIN_LAYOUT,
  INLINE_BEFORE_ABSOLUTE,
  scrolls,
} from '../css/style.js';
import { inkColor, isTransparent, resolve } from '../css/values.js';
import {
  BOX_RAISES,
  LINE_BOX_RAISES,
  PADDED_FACES,
  isOffset,
  letteredAfter,
  SHADOWED_TEXT,
  SHIFTED_LINES,
  TEXT_RAISES,
  transformInPlace,
} from './boxes.js';
import type {
  AtomicPlacement,
  Box,
  EdgePlacement,
  FirstLineStyler,
  InlineDecoration,
  LineBox,
  LineText,
  TextLayoutLike,
} from './boxes.js';
import type { FloatContext } from './floats.js';
import { tableGrid } from './grid.js';

/** How a paragraph's lines are fitted to their width, and measured: as a
 *  browser fits them (`FontsLike`'s `fit`). */
const PARAGRAPH_FIT = 'items' as const;

/** How far past the room a line's content may reach and still fit it: a
 *  64th of a pixel, the epsilon Blink's line breaker adds to the width it
 *  fits to (`LineBreaker::AvailableWidthToFit`), and the one the engine
 *  fits a paragraph's lines with. A line composed a piece at a time asks
 *  the same question of each piece, and half a pixel let a word run a
 *  third of one past the line a browser breaks before it. */
const FIT_SLACK = 1 / 64;

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
      /** A word too long for its line kept whole, past the line's end, or
       *  cut inside itself — ntk's option, which an engine without it
       *  leaves at cutting. */
      overflowWrap?: 'normal' | 'break-word';
      /** Whether soft wraps are made at all: false is a line to each
       *  forced break, cut at `maxWidth` where `overflow` says so. ntk's. */
      wrap?: boolean;
      /** `'items'` fits a line as a browser does, each run's part of it
       *  rounded up to a 64th of a pixel before it is added, as Blink
       *  rounds an element's text on a line up to a LayoutUnit — and
       *  reports a line as wide as that, so a box as wide as its text
       *  holds it. What a paragraph's lines are laid out with; ntk's, from
       *  8.16.1, which an engine without it leaves at the advances' sum. */
      fit?: 'items';
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
 * A fragment of text that runs on from the text before it on its line, with
 * no place to break between the two — only inline boxes' edges, or a float
 * — and how wide those edges are: a word across a `<span>` with padding is
 * in two fragments, and as wide as both and the padding between. What
 * `joinsBefore` answers, for a min-content bound (`block.ts`'s `wordBound`)
 * that would have the word no wider than either fragment's widest.
 */
const JOINS = new WeakMap<LineText, number>();

/** The edges a fragment of text runs on across from the text before it on
 *  its line, or undefined where it does not run on from it (`JOINS`). */
export function joinsBefore(text: LineText): number | undefined {
  return JOINS.get(text);
}

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
    // measured as the lines are fitted, or a word across two elements is
    // read narrower than it fits
    { fit: PARAGRAPH_FIT },
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
  /** The widest row of floats the paragraph placed beside none of its
   *  lines — all of them, where it has nothing else — side by side. */
  floatRow?: number;
  /** Whether a clamp cut the text short: there was more of it than the
   *  lines it left (`InlineOptions.clamp`). */
  cut?: boolean;
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
  /**
   * A `::first-line` that sets the first line's fonts, which move where it
   * breaks: its style, and each box's style on the line (`FirstLineStyler`)
   * — which the line is found in, a piece at a time (CSS 2.1 5.12.1).
   */
  firstLineStyle?: { style: ComputedStyle; styler: FirstLineStyler };
  /** Room the first line has to hold about its baseline besides the
   *  strut's: a list item's marker (`MARKER_ROOM`). */
  firstStrut?: InlineDecoration;
  /** Whether any box in the document paints its background through its
   *  text (`BoxTree.clipText`). */
  clipText?: boolean;
  /**
   * The lines a line-clamp container leaves the block (CSS Overflow 4,
   * 5.3.1): no more than `lines` of them show, and the last of a cut ends
   * in an ellipsis where `ellipsis` says — as it does where they are all
   * the block has and more of the container `follows` them, the clamp
   * point just after them (4.2).
   */
  clamp?: { lines: number; ellipsis: boolean; follows: boolean };
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
  const clamp = options.clamp?.lines;
  // A clamped block shows its first lines and is as tall as they are. The
  // one-layout paths below had the engine cut them, with its ellipsis; a
  // block laid out a line at a time — an image on a line, a float beside
  // it — is cut here, and ends where its last line does, with none.
  if (clamp !== undefined && result.lines.length > clamp) {
    const lines = result.lines.slice(0, clamp);
    const last = lines[clamp - 1];
    let widest = 0;
    for (const line of lines) widest = Math.max(widest, line.width);
    return {
      lines,
      height: last ? last.y + last.height : 0,
      width: widest,
      cut: true,
    };
  }
  return result;
}

/**
 * The cut a block's text is laid out with, as the engine takes it: the
 * lines a line-clamp container leaves it, or the one line of a
 * `white-space: nowrap` block
 * that clips with `text-overflow: ellipsis` — Tailwind's `truncate`, cut at
 * the box's width with an ellipsis. That line is laid out unwrapped and
 * cut where the box ends, inside a word if need be, as a browser cuts it,
 * by an engine that reads `wrap` (ntk from 8.13.0); one that does not
 * wraps it first and ends it after the word that fits.
 */
/** A layout cut at a number of lines, with an ellipsis or with none. */
interface Cut {
  maxLines: number;
  overflow: 'clip' | 'ellipsis';
  wrap?: false;
}

function cutOf(
  style: ComputedStyle,
  clamp: InlineOptions['clamp'],
): Cut | null {
  // the ellipsis a clamp ends in is placed apart (`ellipsized`)
  if (clamp) return { maxLines: clamp.lines, overflow: 'clip' };
  if (
    style.textOverflow === 'ellipsis' &&
    !wraps(style) &&
    style.overflowX !== 'visible'
  ) {
    return { maxLines: 1, overflow: 'ellipsis', wrap: false };
  }
  return null;
}

function layoutLines(block: Box, options: InlineOptions): InlineResult {
  const items: Item[] = [];
  const statics: StaticMark[] = [];
  const floatCount = collect(
    block,
    items,
    options.width,
    options.fonts,
    block.style,
    !!options.floatBoxes,
    statics,
  );
  const result = linesOf(block, options, items, floatCount);
  // whichever way the lines were made, one pass over them
  if (statics.length) {
    staticPositions(statics, items, result.lines, block, options);
  }
  return result;
}

/** The lines of a block's inline content, gathered into `items`. */
function linesOf(
  block: Box,
  options: InlineOptions,
  items: Item[],
  floatCount: number,
): InlineResult {
  let fonts = options.fonts;
  const placing = options.floatBoxes;
  if (items.length === floatCount || !fonts) {
    // no line to wait for: the floats go at the top
    const placed: Box[] = [];
    for (const item of items) {
      if (item.kind === 'float') {
        placing!.size(item.box);
        placing!.place(item.box, options.startY);
        placed.push(item.box);
      }
    }
    if (!placed.length) return EMPTY;
    return { ...EMPTY, floatRow: besideLines([], placed, options.startY) };
  }
  // text a box's background shows through (`background-clip: text`): its
  // layouts are made through a recorder, so paint can lay the same text out
  // again with no ink of its own and fill it with that background
  if (options.clipText && clipsText(block, items)) {
    CLIPPED_TEXT.add(block);
    fonts = recording(fonts);
  }
  // small capitals the face does not have, made of its capitals
  synthesizeSmallCaps(items, fonts);
  if (wraps(block.style)) holdNoWrap(items, block);
  // one walk for what few paragraphs have: text that casts a shadow, and a
  // tab, which only a `white-space` that keeps it leaves — so no text is
  // searched for one where it cannot be
  let tabbed = false;
  let shadowed = false;
  // and text that keeps its spaces where its lines wrap, whose spaces a
  // line may end on (`hangPreserved`)
  let keepsSpaces = false;
  for (const item of items) {
    if (item.kind !== 'text' || item.control) continue;
    const style = item.box.style;
    if (style.textShadow) shadowed = true;
    if (style.whiteSpace === 'pre-wrap') keepsSpaces = true;
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
    setTabs(items, fonts, block.style, blockIndent(block, options.width));
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
  const wrapWords = overflowWrapOf(style, items);
  // a line may break between any two letters, an edge between them or not
  const breaksAnywhere =
    style.wordBreak === 'break-all' || style.lineBreakAnywhere;
  const base = {
    family: style.fontFamily,
    size: style.fontSize,
    weight: style.fontWeight,
    style: style.fontStyle,
    color: style.color,
  };
  const lineHeightMul = lineHeightMultiplier(fonts, style);
  // The lines the end of the text or a forced break ends take
  // `text-align-last` (CSS Text 3, 7.2), and a text that does not wrap is
  // all such lines. Where they are aligned otherwise than the rest, and
  // neither is justified — which fills a line whatever its alignment — the
  // lines are made one at a time, each aligned its own way.
  const lastAlign = lastAlignOf(style);
  const align = engineAlign(wraps(style) ? style.textAlign : lastAlign);
  const rtl = style.direction === 'rtl';
  const alignedApart =
    wraps(style) &&
    style.textAlign !== 'justify' &&
    lastAlign !== 'justify' &&
    alignShift(style.textAlign, rtl) !== alignShift(lastAlign, rtl);
  const indent = blockIndent(block, options.width);

  let hasAtomics = false;
  let hasEdges = false;
  let hasOffset = false;
  let raised = false;
  for (const item of items) {
    if (item.kind === 'atomic') hasAtomics = true;
    else if (item.kind === 'text') {
      // text in an inline box with a line height of its own, which an
      // inline box of no edges has as much as one with them
      if (!raised && fonts && inBoxOwningLeading(fonts, block, item.box)) {
        hasOffset = true;
        raised = true;
      }
    } else if (item.kind === 'edge') {
      hasEdges = true;
      if (
        item.box.style.verticalAlign !== 'baseline' ||
        ownsLeading(fonts, block.style, item.box.style) ||
        tallerStrut(fonts, block.style, item.box)
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
  // a first line in fonts of its own is found a piece at a time, in them
  const restyled = options.firstLineStyle !== undefined;
  // and where one layout makes a line shorter than the strut, its text all
  // smaller than the block's, the lines are made a piece at a time too,
  // where every line holds it (`shortOfStrut`)
  const strut = fonts ? strutOf(fonts, style) : null;
  // and the first line holds what it is handed besides: a marker's room
  const firstStrut = withRoom(strut, options.firstStrut);
  let strutted = false;

  // Inline boxes' edges as spacers in one layout, where the engine left
  // every edge on the line of the content it belongs to (`layoutSpaced`);
  // the lines a piece at a time, below, where it did not.
  if (spaced && !floated && !indent && !alignedApart && !restyled) {
    const laid = layoutSpaced(
      items,
      base,
      style,
      options.width,
      lineHeightMul,
      align,
      fonts,
      keepsSpaces,
    );
    if (laid && !shortOfStrut(laid.lines, strut, firstStrut)) return laid;
    if (laid) strutted = true;
  }

  // The text-only, float-free, unindented case: one call, every line — or
  // one call per *chunk*, when the text is long and carries hard breaks.
  fast: if (
    !hasAtomics &&
    !hasEdges &&
    !raised &&
    !floated &&
    !indent &&
    !alignedApart &&
    !restyled &&
    !strutted
  ) {
    // no atomics and no edges, so everything is text
    const textItems = items as Extract<Item, { kind: 'text' }>[];
    let total = 0;
    let hasNewline = false;
    for (const item of textItems) {
      total += item.length;
      if (!hasNewline && item.run.text.includes('\n')) hasNewline = true;
    }
    if (!total) return EMPTY;
    // `text-overflow` cuts every line that overflows, and a layout can cut
    // only its last: one that a forced break ends is laid out apart, a hard
    // line at a time, or the lines after the first were lost. A clamp is
    // the paragraph's, and stays one layout.
    const clamp = options.clamp;
    let cut = cutOf(style, clamp);
    const perLine = cut !== null && !clamp && hasNewline;
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
        keepsSpaces,
      );
    }
    if (perLine) cut = null;
    if (total > CHUNK_TRIGGER_CHARS && hasNewline && !hasControls(items)) {
      const chunked = layoutChunked(
        textItems,
        base,
        style,
        options.width,
        lineHeightMul,
        align,
        fonts,
        CHUNKS,
        keepsSpaces,
      );
      if (!shortOfStrut(chunked.lines, strut, firstStrut)) return chunked;
      strutted = true;
      break fast;
    }
    let runs: TextRun[] = [];
    let spans = new SpanMap();
    for (const item of textItems) {
      spans.add(
        item.start,
        item.run.text.length,
        item.control ? null : item.box,
      );
      runs.push(item.run);
    }
    // justified lines fill their width, so where all but the last are,
    // the layout is aligned as those are
    const justifies = wraps(style) && style.textJustify !== 'none';
    const justifyRest = style.textAlign === 'justify' && justifies;
    const justifyLast = lastAlign === 'justify' && justifies;
    const layoutOptions = {
      maxWidth: wraps(style) || cut ? options.width : undefined,
      lineHeight: lineHeightMul,
      align: justifyRest && !justifyLast ? engineAlign(lastAlign) : align,
      direction: style.direction,
      overflowWrap: cutWrap(style, cut, wrapWords),
      fit: PARAGRAPH_FIT,
      ...cut,
    };
    let layout = fonts.layout(runs, base, layoutOptions);
    LAYOUT_RUNS.set(layout, runs);
    const held = keepsSpaces
      ? holdAtBreaks(
          layout,
          runs,
          spans,
          fonts,
          layoutOptions.maxWidth ?? options.width,
          !cut,
        )
      : null;
    if (held) {
      runs = held;
      layout = fonts.layout(runs, base, layoutOptions);
      LAYOUT_RUNS.set(layout, runs);
    }
    // A clamp that cut the text short says so, for the clamp point after
    // it, and its last line ends in an ellipsis — as it does where the
    // clamp point falls just after the lines, more of the container after
    // them (CSS Overflow 4, 4.2).
    let clampCut = false;
    if (clamp) {
      const shown = layout.lines.length;
      clampCut =
        shown > 0 &&
        shown >= clamp.lines &&
        (layout.truncated ?? inkBeyond(runs, layout.lines[shown - 1].end));
      if (
        clamp.ellipsis &&
        shown > 0 &&
        shown === clamp.lines &&
        (clampCut || clamp.follows)
      ) {
        const ended = ellipsized(
          fonts,
          textItems,
          runs,
          base,
          layoutOptions,
          layout,
          options.width,
          style,
        );
        layout = ended.layout;
        runs = ended.runs;
        spans = ended.spans;
        LAYOUT_RUNS.set(layout, runs);
      }
    }
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
    layout = justifiedLayout(
      fonts,
      runs,
      base,
      layoutOptions,
      layout,
      options.width,
      { rest: justifyRest, last: justifyLast },
    ).layout;
    const lines: LineBox[] = [];
    const widest = emitLayout(
      layout,
      spans,
      0,
      0,
      lines,
      layoutOptions.maxWidth === undefined
        ? unwrappedPlacer(style, options.width, true)
        : balanced
          ? unwrappedPlacer(style, options.width, false)
          : null,
    );
    if (keepsSpaces) hangLines(lines, 0, runs, fonts, rtl);
    // a clamp and a cut are the one layout's to make
    if (!clamp && !cut && shortOfStrut(lines, strut, firstStrut)) {
      strutted = true;
      break fast;
    }
    return clampCut
      ? { lines, height: layout.height, width: widest, cut: true }
      : { lines, height: layout.height, width: widest };
  }

  // --- the general case: line at a time -------------------------------------
  // the paragraph's bidi levels, where anything in it can be reordered: a
  // line is laid out a piece at a time here, and its pieces are ordered by
  // them (`levelPieces`)
  const paraBidi = fonts ? paragraphBidi(block, items, rtl) : null;
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
  /** Every float placed, in order, for the lines they stand beside. */
  const floatsPlaced: Box[] = [];
  const placeDeferred = (): void => {
    for (const box of deferred) {
      options.floatBoxes!.place(box, options.startY + y);
      floatsPlaced.push(box);
    }
    deferred = [];
  };

  // How tall a line is taken to be before it is made, for its room beside
  // the floats: the paragraph's strut, a line of its text. An item taller
  // asks over its own height, and the line made over its whole (`close`).
  // A 1.4em guess put a line of `line-height: 0` below floats it fitted
  // beside.
  const guess = strut ? strut.ascent + strut.descent : style.fontSize * 1.4;
  const lifts = raised && fonts ? new Lifts(fonts, block.style) : null;
  const restShift = alignShift(style.textAlign, rtl);
  const lastShift = alignShift(lastAlign, rtl);
  // a justified line fills its room, whatever made it a piece at a time
  const justify = justification(style);
  const lineJustify: LineJustify | null =
    fonts && (justify.rest || justify.last)
      ? {
          fonts,
          base,
          options: {
            lineHeight: lineHeightMul,
            align: 'left',
            direction: style.direction,
            overflowWrap: wrapWords,
            fit: PARAGRAPH_FIT,
          },
        }
      : null;
  // The first line in its `::first-line` fonts, until a line is closed
  const lineOne = options.firstLineStyle
    ? firstLineSetting(
        block,
        items,
        options.firstLineStyle,
        fonts,
        strut,
        lineJustify,
      )
    : null;
  /** Close the open line; `last` where the text or a forced break ends it,
   *  which `text-align-last` aligns. */
  const close = (last = false): void => {
    const onFirst = lineOne !== null && !lines.length;
    const levels: LineLevels | null = paraBidi
      ? {
          bidi: paraBidi,
          fonts: fonts!,
          base: onFirst ? lineOne.base : base,
          lineHeight: onFirst ? lineOne.lineHeight : lineHeightMul,
        }
      : null;
    const line = finishLine(
      open,
      y,
      // the room beside the floats over the whole line box, which an
      // inline-block can make taller than its text (CSS 2.1 9.5)
      (height) => bandAt(options, y, Math.max(height, guess)),
      last || !wraps(style) ? lastShift : restShift,
      rtl,
      lines.length
        ? strut
        : withRoom(onFirst ? lineOne.strut : strut, options.firstStrut),
      onFirst ? lineOne.lifts : lifts,
      (last || !wraps(style) ? justify.last : justify.rest)
        ? onFirst
          ? lineOne.justify
          : lineJustify
        : null,
      levels,
    );
    if (!line) {
      open = openLine(0);
      placeDeferred();
      return;
    }
    // A line with no text on it — a control, an image or an inline-block
    // that wrapped on its own — stands where the text around it does: an
    // empty range at the end of the line before, not at 0. What finds a
    // line by its text binary-searches these ranges as sorted
    // (`lineBands`, `caretAt`), and a textless line at 0 after a line of
    // text sent the search past every line: a `<label>` on the line
    // before a submit button that wrapped measured as no box at all.
    if (!line.texts.length && lines.length) {
      line.textStart = line.textEnd = lines[lines.length - 1].textEnd;
    }
    lines.push(line);
    widest = Math.max(widest, line.width);
    y += line.height;
    open = openLine(0);
    placeDeferred();
  };

  while (index < items.length) {
    const band = bandAt(options, y, guess);
    const available = band.right - band.left;
    const item = items[index];
    const onFirst = lineOne !== null && !lines.length;
    const lineItems = onFirst ? lineOne.items : items;
    const lineBase = onFirst ? lineOne.base : base;

    if (item.kind === 'float') {
      // No higher than the top of the line it is met on (CSS 2.1 9.5.1):
      // at that top where it fits beside what the line holds already, and
      // what the line holds moves over for it; under the line where it
      // does not, with the rest of the line's content still on the line.
      // Where the line cannot break at the float, what follows it up to
      // where it can is on the line too, and has to fit beside it as well,
      // as browsers place one: `nowrap` text it is in the middle of runs on
      // past it otherwise, under it.
      const outer = options.floatBoxes!.size(item.box);
      // and after a float that waits for the next line, since none goes
      // higher than one before it (9.5.1, rule 5)
      let fits =
        !deferred.length &&
        (isEmpty(open) || open.x + pendingWidth + outer <= available);
      if (fits && !isEmpty(open) && !breaksAtEnd(open, style)) {
        const after = unbreakableAfter(
          lineItems,
          index + 1,
          style,
          fonts!,
          lineBase,
        );
        fits = open.x + pendingWidth + after + outer <= available;
      }
      if (fits) {
        options.floatBoxes!.place(item.box, options.startY + y);
        floatsPlaced.push(item.box);
        const left = bandAt(options, y, guess).left;
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
      const lineTall = Math.max(guess, tall);
      const room = tall > guess ? bandAt(options, y, tall) : band;
      const roomWidth = room.right - room.left;
      // a line with nothing on it keeps what comes first, indent or not:
      // there is no break before it (a first line's `text-indent` is room
      // taken, and no content)
      if (open.x !== open.indent && open.x + pendingWidth + outer > roomWidth) {
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
      const raise = atomicRaise(fonts, box, (box.parent ?? block).style);
      if (raise) placed.raise = raise;
      open.atomics.push(placed);
      open.order.push({
        kind: 'atomic',
        at: open.x,
        item: placed,
        ...(paraBidi ? { para: paraBidi.starts[index] } : null),
      });
      open.x += outer;
      open.hang = 0;
      open.left = room.left;
      index += 1;
      continue;
    }

    const plain = segmentFrom(lineItems, index, offset);
    // measured as it will be drawn where it is justified, its spaces
    // spaced apart (`HAIR`) — the same text, so every offset holds
    const segment = lineJustify
      ? { ...plain, runs: spacedApart(plain.runs) }
      : plain;
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
    // An inline box's edges of no width on the open line are no room it
    // takes, and are still on it: an empty `<span>` with a tall line height
    // before the text was left on a line of its own after it, and the
    // text's line was as short as the paragraph's
    // (and its lines all aligned alike, which the last is not where
    // `text-align-last` sets it apart)
    const tailIsPlain =
      !alignedApart &&
      !onFirst &&
      !strutted &&
      segment.nextIndex >= items.length &&
      open.x === 0 &&
      !open.atomics.length &&
      !open.edges.length &&
      !pending.length &&
      !deferred.length &&
      !(options.floats?.intersects(options.startY + y, Infinity) ?? false) &&
      // and ordered alone as the paragraph orders it
      (!paraBidi ||
        orderedAlone(paraBidi, segment, paraBidi.starts[index] + offset, rtl));
    if (tailIsPlain) {
      const tailOptions = {
        maxWidth: wraps(style) ? Math.max(1, available) : undefined,
        lineHeight: lineHeightMul,
        align,
        direction: style.direction,
        overflowWrap: wrapWords,
        fit: PARAGRAPH_FIT,
      };
      let tailRuns = segment.runs;
      let layout = fonts.layout(tailRuns, base, tailOptions);
      LAYOUT_RUNS.set(layout, tailRuns);
      const held = keepsSpaces
        ? holdAtBreaks(
            layout,
            tailRuns,
            segment.spans,
            fonts,
            tailOptions.maxWidth ?? options.width,
            true,
          )
        : null;
      if (held) {
        tailRuns = held;
        layout = fonts.layout(tailRuns, base, tailOptions);
        LAYOUT_RUNS.set(layout, tailRuns);
      }
      // the lines past the floats are justified as the lines beside them
      // were (`finishLine`), in the room they have
      layout = justifiedLayout(
        fonts,
        tailRuns,
        base,
        tailOptions,
        layout,
        Math.max(1, available),
        justify,
      ).layout;
      const tail: LineBox[] = [];
      const lift = layoutLift(layout);
      for (let i = 0; i < layout.lines.length; i += 1) {
        const natural = layout.lines[i];
        const text: LineText = {
          layout,
          layoutLine: i,
          drawX: band.left,
          drawY: y - lift,
          textStart: segment.spans.documentAt(natural.start),
          textEnd: segment.spans.documentAt(natural.end),
          layoutStart: natural.start,
          spans: segment.spans,
        };
        segment.spans.giveGaps(text, natural.start, natural.end);
        tail.push({
          x: band.left + natural.x,
          y: y + natural.y,
          width: natural.width,
          height: natural.height,
          baseline: natural.baseline - natural.y - lift,
          texts: [text],
          textStart: text.textStart,
          textEnd: text.textEnd,
          atomics: [],
        });
      }
      if (keepsSpaces) hangLines(tail, 0, tailRuns, fonts, rtl);
      // or a line at a time, where one of them is shorter than the strut
      if (!shortOfStrut(tail, strut, lines.length ? null : firstStrut)) {
        for (const line of tail) {
          lines.push(line);
          widest = Math.max(widest, line.width);
        }
        y += layout.height;
        index = segment.nextIndex;
        offset = 0;
        continue;
      }
      strutted = true;
    }

    // One line: `maxLines: 1` cuts the layout at the first break and its
    // `truncated` flag answers "did the segment wrap" — so a line costs one
    // layout of one line, not a layout of the whole remaining tail plus a
    // re-cut (which is what an earlier shape paid, per line, beside every
    // float). ntk's shaping memo makes the successive cuts cheap; only the
    // line breaker re-runs.
    const room = Math.max(1, available - open.x - pendingWidth);
    // A float met inside a word, or inside a `nowrap` element, is no place
    // for the line to break: the text after it up to where it may break
    // is on this line too, so this line keeps room for it — or breaks
    // before the word it is tied to. It overran the line otherwise, the
    // float having gone below, and the break it could have taken passed.
    const tied =
      wraps(style) &&
      items[segment.nextIndex]?.kind === 'float' &&
      !BREAKS_AFTER.test(segment.runs[segment.runs.length - 1].text)
        ? unbreakableAfter(lineItems, segment.nextIndex, style, fonts, lineBase)
        : 0;
    const lineHeight = onFirst ? lineOne.lineHeight : lineHeightMul;
    let fragment = fragmentLayout(
      fonts,
      segment.runs,
      lineBase,
      style,
      lineHeight,
      wrapWords,
      room - tied,
    );
    let first = fragment.lines[0];
    if (!first) {
      index = segment.nextIndex;
      offset = 0;
      continue;
    }
    // Did the segment wrap? ntk answers with `truncated`. A layout that does
    // not carry the flag — react-x11's Cocoa engine reports none — is asked
    // the same of its line ends instead: it wrapped if anything but
    // whitespace follows the first line. Read as "fitted", a cut fragment
    // advanced past the whole segment, and a paragraph beside a float lost
    // every line after its first. And a line that ends at a `<br>` is over
    // whether or not anything followed it in this segment: what comes next
    // — an atomic, an element's edge — is the next line's.
    let wrapped =
      breakBefore(segment.runs, first.end) ||
      (fragment.truncated ?? inkBeyond(segment.runs, first.end));
    // An inline box's edge is no place to break a line (CSS Text 3, 5.1):
    // where the segment runs to its end on this line, its last word runs on
    // past it, through the edges after it, into the text they stand before
    // — `ab<span style="padding: 0 4px">cd</span>` is one word, as it is
    // without the padding. Where the line may break at that text after all,
    // the edges that close boxes are still the word's, as a box's end goes
    // with the content it closes, and it is the ones that open a box that
    // go with what follows. The line holds the word and all of that or none
    // of it, so where it does not fit, the line breaks at the last place in
    // the segment it may break, and the word goes to the next line whole.
    // Where the segment has no such place, the word is the line's first,
    // and is measured with what it runs into (below). A word that ends in
    // white space hangs it, and its edges after it with it.
    let glued = 0;
    if (
      !wrapped &&
      wraps(style) &&
      lineItems[segment.nextIndex]?.kind === 'edge' &&
      !BREAKS_AFTER.test(segment.runs[segment.runs.length - 1].text) &&
      // none of it matters where the most it could come to fits: most
      // edges are nowhere near a line's end
      first.width + unbreakableBound(lineItems, segment.nextIndex) >
        room + FIT_SLACK
    ) {
      const after = textAfterEdges(lineItems, segment.nextIndex);
      glued =
        after &&
        !breaksBetween(
          fonts,
          lineBase,
          segment.runs,
          runsLength(segment.runs),
          after,
          breaksAnywhere,
        )
          ? unbreakableAfter(
              lineItems,
              segment.nextIndex,
              style,
              fonts,
              lineBase,
            )
          : closingEdges(lineItems, segment.nextIndex);
    }
    if (glued > 0 && first.width + glued > room + FIT_SLACK) {
      // the last place it may break: laid out a hair narrower than it is,
      // which the rest of the segment fits, not in the room the word
      // leaves, where it broke after its first word if the word and what
      // it runs into are wider than the line
      const earlier = fragmentLayout(
        fonts,
        segment.runs,
        lineBase,
        style,
        lineHeight,
        wrapWords,
        first.width - 0.5,
      );
      const line = earlier.lines[0];
      // and not inside a word that `overflow-wrap` cut to fit: that is for
      // a word no line holds, and the word and what it runs into may fit
      // the next line
      if (line && line.end < first.end && !insideWord(segment.runs, line.end)) {
        fragment = earlier;
        first = line;
        wrapped = true;
        glued = 0;
      }
    }
    // the first word, with what it runs into past the segment
    const word = first.width + glued;
    // Nothing fits beside the floats — the first word is wider than the
    // room they leave, and was either run past it or cut inside itself to
    // fit — so the line moves down to where a float ends, and tries again
    // there (CSS 2.1 9.5). Only where a float took some of the line's width:
    // past the floats the line has the whole of it, and a word wider still
    // is `overflow-wrap`'s to break or to let run past.
    if (
      isEmpty(open) &&
      available < options.width &&
      tooNarrow(segment.runs, first.end, word, room)
    ) {
      const below = belowFloats(options, y, guess);
      if (below !== null) {
        y = below;
        continue;
      }
    }
    // An inline box's opening edge goes with the first word after it: where
    // the word does not fit the room the edge leaves, both go to the next
    // line, rather than the edge being left at this one's end — where the
    // line may break there at all. The edge is no place to break (CSS Text
    // 3, 5.1), so that is where the line may break between what it ends on
    // and the word: after white space or an atomic, or where the text
    // engine breaks the two run together (`breaksBetween`). `ab<span
    // style="padding: 0 4px">cd</span>` is one word, and a line too narrow
    // for it runs past its end, as it does for the word without the
    // padding; broken before the span, a float's min-content width was a
    // letter wide, and it came out as wide as its room.
    // And a word that may start a line — after a space the line ends on,
    // or after an atomic, which has a break after it (CSS Text 3, 5.1) —
    // goes to the next line whole where it does not fit what is left of
    // this one, rather than being broken inside itself to fit it: the text
    // after an inline-block, or after a float it was cut at, was its first
    // letter at the line's end and the rest on the next.
    const startsLine =
      wraps(style) &&
      (open.hang > 0 || open.order[open.order.length - 1]?.kind === 'atomic');
    if (
      !isEmpty(open) &&
      (pendingWidth > 0
        ? tooNarrow(segment.runs, first.end, word, room) &&
          breaksAfterLine(
            open,
            style,
            fonts,
            lineBase,
            segment.runs,
            breaksAnywhere,
          )
        : startsLine &&
          // run past the room — its white space is no part of the width —
          // or cut inside itself to fit it
          (word > room + FIT_SLACK ||
            tooNarrow(segment.runs, first.end, word, room)))
    ) {
      close();
      continue;
    }
    placePending(band.left);
    const joins = joinsOnto(open, segment.runs, first.start);
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
    if (joins !== undefined) JOINS.set(placed, joins);
    open.texts.push(placed);
    open.order.push({
      kind: 'text',
      at: open.x,
      item: placed,
      reads: readingOf(segment.runs, first.start, first.end),
      ...(paraBidi
        ? {
            from: {
              para: paraBidi.starts[index] + offset,
              runs: segment.runs,
              spans: segment.spans,
            },
          }
        : null),
    });
    open.x += first.width;
    open.left = band.left;
    open.hang = 0;
    // the spaces `pre-wrap` keeps that it ends on, which the engine hung
    const hung = keepsSpaces
      ? hangPreserved(placed, segment.runs, runStarts(segment.runs), fonts, rtl)
      : NOTHING_HUNG;
    /** Before a forced break, the ones that fit take room (4.1.3). */
    const holdHung = (): void => {
      open.x += Math.min(hung.total, Math.max(0, available - open.x));
    };

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
          // through the bidi controls after them, which take no room: the
          // engine strips the spaces before one as well
          const text = segment.runs[i].text.replace(ENDING_CONTROLS, '');
          if (!text) continue;
          const m = hung.exec(text);
          if (!m) break;
          trailing = m[0] + trailing;
          if (m[0].length < text.length) break;
        }
        if (trailing) {
          // and noted: if what follows goes to the next line after all,
          // these spaces end this one, where CSS removes them (16.6.1).
          // As wide as the engine says they make its line where the line
          // goes on, which a layout that fits as a browser does rounds with
          // the text they end, once (`advance`): the text rounded up to a
          // 64th and the spaces added after it came to more
          open.hang =
            first.advance !== undefined
              ? first.advance - first.width
              : spaceAdvance(fonts, segment.runs[segment.runs.length - 1]) *
                trailing.length;
          open.x += open.hang;
        }
      } else if (hung.total) holdHung();
      index = segment.nextIndex;
      offset = 0;
      continue;
    }
    const forced = breakBefore(segment.runs, first.end);
    if (forced && hung.total) holdHung();
    close(forced);
    const advanced = advance(items, index, offset, first.end);
    index = advanced.index;
    offset = advanced.offset;
  }

  if (pending.length) placePending(bandAt(options, y, guess).left);
  if (open.texts.length || open.atomics.length || open.edges.length) {
    close(true);
  }
  placeDeferred();

  if (!floatsPlaced.length) return { lines, height: y, width: widest };
  const floatRow = besideLines(
    Number.isFinite(options.width) ? [] : lines,
    floatsPlaced,
    options.startY,
  );
  return { lines, height: y, width: widest, floatRow };
}

const EMPTY: InlineResult = { lines: [], height: 0, width: 0 };

/** The first line of a segment's text in a width, as the line at a time
 *  lays one out (`linesOf`). */
function fragmentLayout(
  fonts: FontsLike,
  runs: TextRun[],
  base: Record<string, unknown>,
  style: ComputedStyle,
  lineHeight: number,
  overflowWrap: 'normal' | 'break-word',
  width: number,
): TextLayoutLike {
  const laid = fonts.layout(runs, base, {
    maxWidth: wraps(style) ? Math.max(1, width) : undefined,
    lineHeight,
    // Never aligned by the text layout: the alignment belongs to the whole
    // line — its text, its atomics and its inline boxes' edges together —
    // which only this loop can see, and `finishLine` shifts it all. Laid
    // out aligned, the first fragment of a centred line was centred alone
    // and whatever followed it on the line was placed as though it had not
    // been, over it.
    align: 'left',
    direction: style.direction,
    overflowWrap,
    fit: PARAGRAPH_FIT,
    maxLines: 1,
  });
  LAYOUT_RUNS.set(laid, runs);
  return laid;
}

/**
 * Which line each float a paragraph placed stands beside: the one whose top
 * it went at, whose content moved over for it — added up on the line, for
 * what the line is measured with (`LineBox.floats`). The widest row of the
 * rest, side by side where they went at one top, is the answer. Both lines
 * and floats come in order down the paragraph, since a float goes no
 * higher than the one before it.
 *
 * The lines are handed over only where the paragraph had no width limit,
 * where its content is measured at its widest and a float is beside a line
 * because nothing made the line go under it. At a width, the least a
 * paragraph can be is its widest word or float, not the two side by side
 * (where the word ran past the room a float left it), and its floats are
 * rows of their own.
 */
function besideLines(lines: LineBox[], placed: Box[], startY: number): number {
  let row = 0;
  let rowTop = NaN;
  let widest = 0;
  let at = 0;
  for (const box of placed) {
    const top = box.y - box.marginTop - startY;
    const width = box.width + box.marginLeft + box.marginRight;
    while (at < lines.length && lines[at].y < top - 0.01) at += 1;
    const line = lines[at];
    if (line && Math.abs(line.y - top) <= 0.01) {
      line.floats = (line.floats ?? 0) + width;
    } else if (Math.abs(top - rowTop) <= 0.01) row += width;
    else {
      widest = Math.max(widest, row);
      row = width;
      rowTop = top;
    }
  }
  return Math.max(widest, row);
}

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

/**
 * A paragraph whose inline boxes have edges, as one layout with the edges
 * in it as spacers (`spacerRun`), each line told where its spacers are and
 * where they put the edges. Null where the engine began a line with an
 * edge that closes a box: a break after a box's last character is after
 * its end edge, which stays on the line of the content it closes (CSS Text
 * 3, 5.1), and a line break after a space may come before a no-break space
 * (UAX #14, LB12a), which is what a spacer is. The lines a piece at a time
 * keep it there.
 */
function layoutSpaced(
  items: Item[],
  base: Record<string, unknown>,
  style: ComputedStyle,
  width: number,
  lineHeightMul: number,
  align: string,
  fonts: FontsLike,
  keepsSpaces: boolean,
): InlineResult | null {
  const wrapWords = overflowWrapOf(style, items);
  let runs: TextRun[] = [];
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
  const layoutOptions = {
    maxWidth: wraps(style) ? width : undefined,
    lineHeight: lineHeightMul,
    align,
    direction: style.direction,
    overflowWrap: wrapWords,
    fit: PARAGRAPH_FIT,
  };
  let layout = fonts.layout(runs, base, layoutOptions);
  LAYOUT_RUNS.set(layout, runs);
  const held = keepsSpaces
    ? holdAtBreaks(layout, runs, spans, fonts, width, true)
    : null;
  if (held) {
    runs = held;
    layout = fonts.layout(runs, base, layoutOptions);
    LAYOUT_RUNS.set(layout, runs);
  }
  // justified with its spacers in it, which are edges and not spaces
  layout = justifiedLayout(
    fonts,
    runs,
    base,
    layoutOptions,
    layout,
    width,
    justification(style),
    new Set(spacers.map((spacer) => spacer.at)),
  ).layout;
  const place = wraps(style) ? null : unwrappedPlacer(style, width);
  const lift = layoutLift(layout);
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
      if (i > 0 && edge.side === 'end' && at === natural.start) return null;
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
      drawY: -lift,
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
      baseline: natural.baseline - natural.y - lift,
      texts: [text],
      textStart: text.textStart,
      textEnd: text.textEnd,
      atomics: [],
      ...(edges.length ? { edges } : null),
    });
    widest = Math.max(widest, natural.width);
  }
  if (keepsSpaces) hangLines(lines, 0, runs, fonts, style.direction === 'rtl');
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
  const lift = layoutLift(layout);
  for (let i = 0; i < layout.lines.length; i += 1) {
    const natural = layout.lines[i];
    const dx = place ? place(natural) : 0;
    const text: LineText = {
      layout,
      layoutLine: i,
      drawX: xOff + dx,
      drawY: yOff - lift,
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
      baseline: natural.baseline - natural.y - lift,
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
  keepsSpaces = false,
): InlineResult {
  const wrapWords = overflowWrapOf(style, items);
  const lines: LineBox[] = [];
  let widest = 0;
  let y = 0;

  let chunkRuns: TextRun[] = [];
  let chunkSpans = new SpanMap();
  let chars = 0;
  let hardLines = 0;

  const { cut } = chunking;
  const place = wraps(style) || cut ? null : unwrappedPlacer(style, width);
  const flush = (last = false): void => {
    if (!chunkRuns.length) return;
    const chunkOptions = {
      maxWidth: wraps(style) || cut ? width : undefined,
      lineHeight: lineHeightMul,
      align,
      direction: style.direction,
      overflowWrap: cutWrap(style, cut, wrapWords),
      fit: PARAGRAPH_FIT,
      ...cut,
    };
    let layout = fonts.layout(chunkRuns, base, chunkOptions);
    LAYOUT_RUNS.set(layout, chunkRuns);
    const held = keepsSpaces
      ? holdAtBreaks(
          layout,
          chunkRuns,
          chunkSpans,
          fonts,
          chunkOptions.maxWidth ?? width,
          last && !cut,
        )
      : null;
    if (held) {
      chunkRuns = held;
      layout = fonts.layout(chunkRuns, base, chunkOptions);
      LAYOUT_RUNS.set(layout, chunkRuns);
    }
    // a chunk ends at a forced break or at the paragraph's end, which is
    // where `justifiedRuns` takes a chunk's last line to end
    layout = justifiedLayout(
      fonts,
      chunkRuns,
      base,
      chunkOptions,
      layout,
      width,
      justification(style),
    ).layout;
    const from = lines.length;
    widest = Math.max(
      widest,
      emitLayout(layout, chunkSpans, 0, y, lines, place),
    );
    if (keepsSpaces) {
      hangLines(lines, from, chunkRuns, fonts, style.direction === 'rtl');
    }
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
  flush(true);
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
  | {
      kind: 'text';
      at: number;
      item: LineText;
      reads: Reading;
      /** Where the text was laid out from, in a paragraph with bidi levels
       *  (`ParagraphBidi`): its segment's place in the paragraph's text,
       *  runs and spans, which `levelPieces` splits it by. */
      from?: { para: number; runs: TextRun[]; spans: SpanMap };
      /** Its UAX #9 level, once `levelPieces` has found it one. */
      level?: number;
    }
  | {
      kind: 'atomic';
      at: number;
      item: AtomicPlacement;
      /** Its object replacement character's place in the paragraph. */
      para?: number;
      level?: number;
    }
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

/** Whether a line may break where it has got to: after the white space it
 *  ends on, which hangs, or after an inline-block, where its block wraps. */
function breaksAtEnd(open: OpenLine, style: ComputedStyle): boolean {
  return (
    wraps(style) &&
    (open.hang > 0 || open.order[open.order.length - 1]?.kind === 'atomic')
  );
}

/**
 * Whether a line may break before an inline box's opening edge, between
 * what the line has got to and `next`, the text after the edge: after an
 * atomic, or after the white space the line ends on, as `breaksAtEnd`
 * says, or where the text engine breaks the line's last text and `next`
 * run together (`breaksBetween`). An edge on the way is no place to break
 * of its own (CSS Text 3, 5.1), and a line with no text or atomic on it
 * yet has none to hold on to.
 */
function breaksAfterLine(
  open: OpenLine,
  style: ComputedStyle,
  fonts: FontsLike,
  base: Record<string, unknown>,
  next: readonly TextRun[],
  anywhere: boolean,
): boolean {
  if (!wraps(style)) return false;
  if (open.hang > 0) return true;
  for (let i = open.order.length - 1; i >= 0; i -= 1) {
    const placed = open.order[i];
    if (placed.kind === 'edge') continue;
    if (placed.kind === 'atomic') return true;
    const text = placed.item;
    const runs = LAYOUT_RUNS.get(text.layout);
    if (!runs || (runs.length > 0 && typeof runs[0] === 'number')) return true;
    const end = text.layout.lines[text.layoutLine].end;
    return breaksBetween(fonts, base, runs as TextRun[], end, next, anywhere);
  }
  return true;
}

/**
 * How wide the edges are between the text the open line ends on and text
 * starting at `start` in `runs`, where the one runs on into the other
 * (`JOINS`): neither is white space at the join, and no atomic, which has a
 * break before and after it, is between them. Undefined where they do not
 * join, or the line has no text yet. Letters on either side are taken to
 * join whatever they are, which may count an ideograph's join that the
 * engine would break at: it makes the bound it is for a larger one, never a
 * smaller.
 */
function joinsOnto(
  open: OpenLine,
  runs: readonly TextRun[],
  start: number,
): number | undefined {
  if (open.hang > 0) return undefined;
  const next = charAt(runs, start);
  if (next === '' || SPACE.test(next)) return undefined;
  let edges = 0;
  for (let i = open.order.length - 1; i >= 0; i -= 1) {
    const placed = open.order[i];
    if (placed.kind === 'edge') {
      edges += placed.item.width;
      continue;
    }
    if (placed.kind === 'atomic') return undefined;
    const text = placed.item;
    const before = LAYOUT_RUNS.get(text.layout);
    if (!before || (before.length > 0 && typeof before[0] === 'number')) {
      return undefined;
    }
    const last = charAt(
      before as TextRun[],
      text.layout.lines[text.layoutLine].end - 1,
    );
    return last === '' || SPACE.test(last) ? undefined : edges;
  }
  return undefined;
}

/**
 * Whether a line may break between two texts an inline box's edge stands
 * between — the text of `before` up to the code unit `end`, and `after` —
 * which is where it may break them run together, the edge being no place
 * to break (CSS Text 3, 5.1). After white space, and not before it, where
 * the break is after that white space instead (UAX #14, LB7). Never between
 * two letters or digits of the alphabets whose words break only at spaces,
 * which is every edge in running text, and needs no asking. Anything else
 * — a hyphen, a dash, an ideograph or kana, a bracket, a slash — is asked
 * of the text engine: the two words, laid out at no width, break at every
 * place a line may, which is UAX #14 as the `linebreak` package has it on
 * both backends — ntk breaks every line with it, and react-x11's CoreText
 * engine a text at no width. So an edge after a hyphen, or between two
 * ideographs, is a place to break exactly where the same text with no edge
 * in it is one; a list of classes here would be a third opinion.
 *
 * Counted, not located: the words run together break into as many pieces
 * as the two apart where they break between them, and one fewer where the
 * last piece of the one runs on into the first of the other. The line
 * offsets are no answer, as they are not the text's on every backend: the
 * CoreText engine lays out a copy with a line break put in at each place,
 * and its offsets are that copy's.
 */
function breaksBetween(
  fonts: FontsLike,
  base: Record<string, unknown>,
  before: readonly TextRun[],
  end: number,
  after: readonly TextRun[],
  anywhere: boolean,
): boolean {
  const last = charAt(before, end - 1);
  const next = charAt(after, 0);
  // nothing to hold the two together
  if (last === '' || next === '') return true;
  if (SPACE.test(last)) return true;
  if (SPACE.test(next)) return false;
  if (anywhere) return true;
  if (HOLDS.test(last) && HOLDS.test(next)) return false;
  if (NO_BREAK_AFTER.test(last) || NO_BREAK_BEFORE.test(next)) return false;
  const tail = sliceRuns(before, lastSpace(before, end) + 1, end);
  const head = sliceRuns(after, 0, firstSpace(after));
  const pieces = (runs: TextRun[]): number =>
    fonts.layout(runs, base, {
      maxWidth: MIN_CONTENT_WIDTH,
      overflowWrap: 'normal',
    }).lines.length;
  return pieces([...tail, ...head]) === pieces(tail) + pieces(head);
}

/** The width a text is laid out at to break it at every place it may
 *  break: none — at a pixel, CoreText breaks inside words (`block.ts`'s
 *  `MIN_CONTENT_PROBE`). */
const MIN_CONTENT_WIDTH = 0;

/** White space a line breaks after. */
const SPACE = /^[ \t\n]$/;

/** Letters and digits of the Latin, Greek and Cyrillic alphabets, and the
 *  marks on them: no line breaks between two of these (UAX #14, LB9, LB23,
 *  LB25, LB28). */
const HOLDS =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}\p{M}]$/u;

/** What no line breaks after, whatever follows: an opening bracket, a
 *  straight quote and a no-break space (UAX #14, LB12, LB14, LB19). */
const NO_BREAK_AFTER = /^[([{"'\u00a0]$/;

/** What no line breaks before, whatever precedes: a closing bracket, a
 *  stop, a comma, a colon, `!`, `?`, `/` and a straight quote (UAX #14,
 *  LB13, LB19) — the punctuation after a link or a `<code>`, which needs
 *  no asking either. */
const NO_BREAK_BEFORE = /^[)\]},.;:!?/"']$/;

/** The code unit at an offset into runs' joined text, or '' outside it. */
function charAt(runs: readonly TextRun[], at: number): string {
  if (at < 0) return '';
  let from = 0;
  for (const run of runs) {
    const next = from + run.text.length;
    if (at < next) return run.text[at - from];
    from = next;
  }
  return '';
}

/** Where the last white space before a code-unit offset is, or -1. */
function lastSpace(runs: readonly TextRun[], end: number): number {
  let found = -1;
  let from = 0;
  for (const run of runs) {
    if (from >= end) break;
    const text = run.text.slice(0, end - from);
    const at = Math.max(
      text.lastIndexOf(' '),
      text.lastIndexOf('\t'),
      text.lastIndexOf('\n'),
    );
    if (at >= 0) found = from + at;
    from += run.text.length;
  }
  return found;
}

/** Where the first white space in runs' joined text is, or its length. */
function firstSpace(runs: readonly TextRun[]): number {
  let from = 0;
  for (const run of runs) {
    const at = run.text.search(/[ \t\n]/);
    if (at >= 0) return from + at;
    from += run.text.length;
  }
  return from;
}

function runsLength(runs: readonly TextRun[]): number {
  let length = 0;
  for (const run of runs) length += run.text.length;
  return length;
}

/**
 * The text inline boxes' edges from `from` on stand before, up to its first
 * white space: what the text before the edges runs on into. Null where an
 * atomic comes first, which has a break before it, or nothing does.
 */
function textAfterEdges(
  items: readonly Item[],
  from: number,
): TextRun[] | null {
  const runs: TextRun[] = [];
  for (let i = from; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === 'edge' || item.kind === 'float') continue;
    if (item.kind === 'atomic') break;
    const text = item.run.text;
    const stop = text.search(/[ \t\n]/);
    if (stop < 0) {
      runs.push(item.run);
      continue;
    }
    runs.push({ ...item.run, text: text.slice(0, stop + 1) });
    break;
  }
  return runs.length ? runs : null;
}

/**
 * The most `unbreakableAfter` could come to, with no layout: the edges on
 * the way, and the text up to its first white space at half again its size
 * a character, which no glyph a document sets words in is wider than, and
 * its letter spacing (`longestWord`'s estimate).
 */
function unbreakableBound(items: readonly Item[], from: number): number {
  let width = 0;
  for (let i = from; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === 'float') continue;
    if (item.kind === 'edge') {
      width += Math.max(0, item.width);
      continue;
    }
    if (item.kind === 'atomic') break;
    const run = item.run;
    const stop = run.text.search(/[ \t\n]/);
    const per = (run.size ?? 16) * 1.5 + Math.max(0, run.letterSpacing ?? 0);
    width += (stop < 0 ? run.text.length : stop) * per;
    if (stop >= 0) break;
  }
  return width;
}

/** How wide the edges from `from` on are that close inline boxes, up to
 *  one that opens a box or anything but an edge or a float. */
function closingEdges(items: readonly Item[], from: number): number {
  let width = 0;
  for (let i = from; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === 'float') continue;
    if (item.kind !== 'edge' || item.side !== 'end') break;
    width += item.width;
  }
  return width;
}

/** Whether a code-unit offset into runs' joined text is between two
 *  letters or digits: inside a word, where only `overflow-wrap` breaks. */
function insideWord(runs: readonly TextRun[], at: number): boolean {
  return (
    WORD_CHAR.test(charAt(runs, at - 1)) && WORD_CHAR.test(charAt(runs, at))
  );
}

/**
 * How wide the content from `from` on is up to where its line may break:
 * its text up to a space it may break at — one `holdNoWrap` left a space —
 * or, in a block that does not wrap, up to a line's end, with the edges of
 * inline boxes on the way, and an inline-block, which has a break before it
 * where the block wraps. Floats take no room on the line.
 */
function unbreakableAfter(
  items: readonly Item[],
  from: number,
  style: ComputedStyle,
  fonts: FontsLike,
  base: Record<string, unknown>,
): number {
  const wrapping = wraps(style);
  const runs: TextRun[] = [];
  let width = 0;
  for (let i = from; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === 'float') continue;
    if (item.kind === 'edge') {
      width += item.width;
      continue;
    }
    if (item.kind === 'atomic') {
      if (wrapping) break;
      width += item.box.width + item.box.marginLeft + item.box.marginRight;
      continue;
    }
    const text = item.run.text;
    const stop = wrapping ? text.search(/[ \t\n]/) : text.indexOf('\n');
    if (stop < 0) {
      runs.push(item.run);
      continue;
    }
    if (stop > 0) runs.push({ ...item.run, text: text.slice(0, stop) });
    break;
  }
  return runs.length
    ? width + fonts.layout(runs, base, { fit: PARAGRAPH_FIT }).width
    : width;
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
  justify: LineJustify | null = null,
  /** The paragraph's bidi levels, where it has them (`ParagraphBidi`). */
  levels: LineLevels | null = null,
): LineBox | null {
  if (!open.texts.length && !open.atomics.length && !open.edges.length) {
    return null;
  }
  const reordered = levels
    ? levelPieces(open, levels) ||
      open.order.some((p) => p.kind === 'edge' && needsOrdering(p, rtl))
    : open.order.some((p) => needsOrdering(p, rtl));
  if (reordered) reorderLine(open, rtl);
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
      open.edges.some(
        (edge) => edge.width !== 0 || hasEdgeOn(edge.box, edge.side),
      ));
  let ascent = held ? strut.ascent : 0;
  let descent = held ? strut.descent : 0;
  // A text `vertical-align` raises takes its own box's room about where it
  // is raised to. A `top` or `bottom` box takes the room of all it holds
  // on the line about its baseline, and the line is as tall as that.
  const lifted = lifts ? open.texts.map((text) => lifts.of(text)) : null;
  let edges: Map<
    Box,
    { to: 'top' | 'bottom'; ascent: number; descent: number }
  > | null = null;
  for (let i = 0; i < open.texts.length; i += 1) {
    const lift = lifted?.[i];
    if (lift) {
      if (lift.edge) {
        edges ??= new Map();
        let room = edges.get(lift.edge.box);
        if (!room) {
          room = {
            to: lift.edge.to,
            ascent: lift.edge.ascent,
            descent: lift.edge.descent,
          };
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
    // with its leading shared as the strut's is: it is drawn on the line's
    // baseline, wherever its engine put its own
    const own = lineAscent(natural);
    ascent = Math.max(ascent, own);
    descent = Math.max(descent, natural.height - own);
  }
  // an inline box with no text on the line is on it all the same, as tall
  // as its own face and line height make it (CSS 2.1 10.8): an empty one,
  // or one whose text is on another line — raised, or with a line height
  // of its own, which an empty `<span>` made the line's no taller for.
  // Only on a line that is one at all, which is none for boxes of no
  // edges and no text (9.4.2)
  if (lifts && held) {
    for (const placed of open.edges) {
      if (placed.side !== 'start' || placed.box.kind !== 'inline') continue;
      const room = lifts.ofBox(placed.box);
      if (!room) continue;
      ascent = Math.max(ascent, room.ascent + room.raise);
      descent = Math.max(descent, room.descent - room.raise);
    }
  }
  // `top` and `bottom` boxes are set against the line's edges rather than
  // its baseline, so all they ask of it is to be as tall as they are
  let top = 0;
  let bottom = 0;
  for (const placed of open.atomics) {
    const box = placed.box;
    const h = box.height + box.marginTop + box.marginBottom;
    const va = box.style.verticalAlign;
    if (va === 'top' || va === 'bottom') {
      if (va === 'top') top = Math.max(top, h);
      else bottom = Math.max(bottom, h);
      continue;
    }
    // on the line's baseline by its own, raised from it by its
    // `vertical-align`, and below it by the rest of it
    const raise = placed.raise ?? 0;
    const b = atomicBaseline(box);
    ascent = Math.max(ascent, b + raise);
    descent = Math.max(descent, h - b - raise);
  }
  if (edges) {
    for (const room of edges.values()) {
      const h = room.ascent + room.descent;
      if (room.to === 'top') top = Math.max(top, h);
      else bottom = Math.max(bottom, h);
    }
  }
  // Where the baseline goes in a line one of them made taller than the
  // rest is left open (CSS 2.1 10.8.1). Browsers keep it where the rest
  // puts it, under the line's top, and only a taller `bottom` box moves it
  // down: an image set `top` beside a line of text has the text at its
  // top, not halfway down it.
  let height = ascent + descent;
  let baseline = ascent;
  if (bottom > height) {
    baseline += bottom - height;
    height = bottom;
  }
  height = Math.max(height, top);

  // Placed beside the floats at the text's height; a float the whole line
  // reaches moves it, and the alignment divides the room that is left.
  // The indent is at the line's start, which is its right in a
  // right-to-left paragraph: the content moves back over it there, and
  // the room it takes is at the other end (CSS 2.1 16.1).
  const band = bandFor(height);
  const indent = rtl ? open.indent : 0;
  let used = open.x - open.hang - indent;
  let free = band.right - indent - band.left - used;
  // A justified line fills its room (CSS Text 3, 7.4). Not yet one that
  // reads right to left, whose pieces are in visual order by now and would
  // take their shares from the wrong end: that is left at its start, as it
  // was.
  if (justify && !rtl && !reordered && Number.isFinite(free) && free > 0) {
    const grew = justifyLine(open, free, justify);
    used += grew;
    free -= grew;
  }
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
  for (const placed of open.atomics) placed.y = y + alignAtomic(placed, line);
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
      // and the boxes it is in, up to the `top` or `bottom` one, whose
      // backgrounds are drawn from their own baselines
      if (lift.edge && lifts) {
        const owner = text.spans.boxAt?.(text.layoutStart);
        for (
          let at2 = owner?.parent;
          at2?.kind === 'inline';
          at2 = at2.parent
        ) {
          const placed = lifts.edgeOf(at2);
          if (!placed) break;
          const room = edges!.get(placed.edge);
          if (!room) break;
          const own =
            placed.edge.style.verticalAlign === 'top'
              ? y + room.ascent
              : y + height - room.descent;
          let raises = LINE_BOX_RAISES.get(line);
          if (!raises) LINE_BOX_RAISES.set(line, (raises = new Map()));
          raises.set(at2, y + baseline - (own - placed.raise));
          SHIFTED_LINES.add(line);
        }
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
 * a level: the paragraph's own, where it has them (`levelPieces`), and
 * otherwise the one it reads at (`readingLevels`).
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
  // UAX #9's levels where the paragraph's are known (`levelPieces`), each
  // piece at one of them; its reading otherwise
  const given = content.map((i) => {
    const p = order[i];
    return p.kind === 'edge' ? undefined : p.level;
  });
  const levels = given.every((level) => level !== undefined)
    ? (given as number[])
    : readingLevels(order, content, rtl);
  const isRtl = levels.map((level) => (level & 1) === 1);
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
      // and the spaces it hung are on the side of it its room is left on
      if (piece.item.hung) placeHung(piece.item, isRtl[k]);
    } else {
      piece.item.x += dx;
    }
    x += room;
  }
}

/**
 * The levels of a line's pieces from which way each reads, where the
 * paragraph's are not known: a fragment the direction its letters read in,
 * or the paragraph's where they read both ways, and a neutral — an atomic, a
 * fragment of spaces and digits — its neighbours' where they agree and the
 * paragraph's where they do not (N1, N2). R is level 1 in either paragraph;
 * L is 0 in a left-to-right one and 2 in a right-to-left one.
 */
function readingLevels(
  order: Placed[],
  content: number[],
  rtl: boolean,
): number[] {
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
  return strong.map((r, k) => {
    const reads =
      r ?? (strongAt(k, -1) === strongAt(k, 1) ? strongAt(k, -1) : rtl);
    return reads ? 1 : rtl ? 2 : 0;
  });
}

/**
 * A paragraph's UAX #9 levels, for its lines made a piece at a time. The
 * engine resolves bidi over what it is handed, which on such a line is a
 * piece: an embedding or an override opened on one side of an inline box's
 * edge or an atomic and closed on the other was resolved on each side
 * apart, and a neutral at a piece's edge took the paragraph's direction
 * wherever it sat (#149). So they are resolved here, once, over the
 * paragraph's text as its layouts see it — the controls `unicode-bidi`
 * stands for among it, and an object replacement character for each
 * atomic, as CSS Writing Modes 3 has one taken (2.4.2) — by bidi-js, which
 * is what ntk's own layout resolves them with.
 */
interface ParagraphBidi {
  text: string;
  levels: Uint8Array;
  /** Whether it holds an explicit embedding, override or isolate, which
   *  a piece laid out alone may be outside of. */
  explicit: boolean;
  /** The paragraph's own level: 1 where it reads right to left. */
  base: number;
  /** Where each item's text starts in `text`, by the item's index. */
  starts: number[];
}

/** What a line's pieces are ordered by (`levelPieces`): the paragraph's
 *  levels, and the fonts, font and line height a piece is laid out again
 *  in where it is split. */
interface LineLevels {
  bidi: ParagraphBidi;
  fonts: FontsLike;
  base: Record<string, unknown>;
  lineHeight: number;
}

type TextPlaced = Extract<Placed, { kind: 'text' }>;

let BIDI: Bidi | null = null;

/** bidi-js, made the first time a paragraph needs it. Its declarations
 *  give a CommonJS module a default export, which NodeNext reads as the
 *  module object; Node and a bundler both hand over its factory. */
function bidiJs(): Bidi {
  if (!BIDI) {
    const factory = bidiModule as unknown as
      (() => Bidi) | { default: () => Bidi };
    BIDI = (typeof factory === 'function' ? factory : factory.default)();
  }
  return BIDI;
}

/** A paragraph's levels, or null where nothing in it can be reordered:
 *  it reads left to right, and holds no right-to-left letter and no bidi
 *  control. Kept on its block, and resolved again only where its text is
 *  not what it was: a pass at another width has the same. */
function paragraphBidi(
  block: Box,
  items: Item[],
  rtl: boolean,
): ParagraphBidi | null {
  let reorders = rtl;
  for (let i = 0; !reorders && i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === 'text' && REORDERS.test(item.run.text)) reorders = true;
  }
  if (!reorders) return null;
  const starts: number[] = [];
  let text = '';
  for (const item of items) {
    starts.push(text.length);
    if (item.kind === 'text') text += item.run.text;
    else if (item.kind === 'atomic') text += '\ufffc';
  }
  const base = rtl ? 1 : 0;
  const kept = PARAGRAPH_BIDI.get(block);
  if (kept && kept.text === text && kept.base === base) {
    return { ...kept, starts };
  }
  const { levels } = bidiJs().getEmbeddingLevels(text, rtl ? 'rtl' : 'ltr');
  const explicit = EXPLICIT.test(text);
  const bidi = { text, levels, explicit, base, starts };
  PARAGRAPH_BIDI.set(block, bidi);
  return bidi;
}

const PARAGRAPH_BIDI = new WeakMap<Box, ParagraphBidi>();

/** The explicit embeddings, overrides and isolates. */
const EXPLICIT = /[\u202a-\u202e\u2066-\u2069]/;

/** The explicit embeddings, overrides and isolates a text ends on. */
const ENDING_CONTROLS = /[\u202a-\u202e\u2066-\u2069]+$/;

/** Whether a character is one X9 removes, or an isolate: a bidi control,
 *  or a boundary neutral such as a zero-width space or a soft hyphen. */
function isControl(c: number): boolean {
  return (
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    (c >= 0x200b && c <= 0x200d) ||
    (c >= 0x2060 && c <= 0x2064) ||
    c === 0xad ||
    c === 0xfeff ||
    c === 0x180e
  );
}

/** The paired brackets UAX #9 resolves together (N0), which may pair
 *  across a piece's end. */
const BRACKETS =
  /[()[\]{}\u0f3a-\u0f3d\u169b\u169c\u2045\u2046\u207d\u207e\u208d\u208e\u2308-\u230b\u2329\u232a\u2768-\u2775\u27c5\u27c6\u27e6-\u27ef\u2983-\u2998\u29d8-\u29db\u29fc\u29fd\u2e22-\u2e29\u3008-\u3011\u3014-\u301b\ufe59-\ufe5e\uff08\uff09\uff3b\uff3d\uff5b\uff5d\uff5f\uff60\uff62\uff63]/;

/** The strong types, which nothing around them resolves again. */
const STRONG = new Set(['L', 'R', 'AL']);

/** What UAX #9 L1 puts back at the paragraph's level where a line ends on
 *  it: white space, the isolates, and what X9 removed. */
const TRAILING = new Set([
  'WS',
  'S',
  'B',
  'LRI',
  'RLI',
  'FSI',
  'PDI',
  'BN',
  'LRE',
  'RLE',
  'LRO',
  'RLO',
  'PDF',
]);

/** A segment's text, and its levels as the engine resolves them, laid out
 *  alone in the paragraph's direction. */
const ALONE = new WeakMap<TextRun[], { text: string; levels: Uint8Array }>();

function aloneLevels(
  runs: TextRun[],
  rtl: boolean,
): { text: string; levels: Uint8Array } {
  let alone = ALONE.get(runs);
  if (!alone) {
    const text = runs.map((run) => run.text).join('');
    const { levels } = bidiJs().getEmbeddingLevels(text, rtl ? 'rtl' : 'ltr');
    alone = { text, levels };
    ALONE.set(runs, alone);
  }
  return alone;
}

/** Whether the text from a segment on, laid out alone, is ordered as the
 *  paragraph orders it: every letter at the level it has there. */
function orderedAlone(
  bidi: ParagraphBidi,
  segment: Segment,
  para: number,
  rtl: boolean,
): boolean {
  const { text, levels } = aloneLevels(segment.runs, rtl);
  for (let at = 0; at < levels.length; at += 1) {
    if (segment.spans.isGap(at)) continue;
    if (levels[at] === bidi.levels[para + at]) continue;
    if (!isControl(text.charCodeAt(at))) return false;
  }
  return true;
}

/**
 * Give each piece on a line its level, and answer whether the line is to be
 * put in visual order at all. A piece's letters have the paragraph's levels,
 * with the white space the line ends on back at the paragraph's (L1). A
 * fragment was laid out alone and ordered inside itself by the engine: it
 * is kept whole where the engine's levels for it are the paragraph's and it
 * begins and ends at its lowest one, so that nothing of another piece comes
 * between its letters (L2), and it is the line's at that level. It is split
 * otherwise, a layout to each run of its letters at one level, held in that
 * level's direction by an override; the controls in it, which take no
 * room, are left out. An atomic is at its replacement character's level.
 */
function levelPieces(open: OpenLine, line: LineLevels): boolean {
  const { bidi } = line;
  let start = Infinity;
  let end = -Infinity;
  for (const p of open.order) {
    if (p.kind === 'text' && p.from) {
      const natural = p.item.layout.lines[p.item.layoutLine];
      if (!natural) continue;
      start = Math.min(start, p.from.para + natural.start);
      end = Math.max(end, p.from.para + natural.end);
    } else if (p.kind === 'atomic' && p.para !== undefined) {
      start = Math.min(start, p.para);
      end = Math.max(end, p.para + 1);
    }
  }
  // an element's edges alone are ordered as the paragraph reads
  if (!(end > start)) return bidi.base > 0;
  const levels = bidi.levels.slice(start, end);
  const js = bidiJs();
  for (let i = end - 1; i >= start; i -= 1) {
    if (!TRAILING.has(js.getBidiCharTypeName(bidi.text[i]))) break;
    levels[i - start] = bidi.base;
  }
  const levelAt = (at: number): number => levels[at - start];
  let off = false;
  const order: Placed[] = [];
  const texts: LineText[] = [];
  for (const p of open.order) {
    if (p.kind === 'edge') {
      order.push(p);
      continue;
    }
    if (p.kind === 'atomic') {
      p.level = p.para === undefined ? bidi.base : levelAt(p.para);
      off ||= p.level > 0;
      order.push(p);
      continue;
    }
    for (const piece of levelled(p, levelAt, line)) {
      off ||= piece.level! > 0;
      order.push(piece);
      texts.push(piece.item);
    }
  }
  open.order = order;
  open.texts = texts;
  return off;
}

/** A fragment of a line as the pieces it is ordered in (`levelPieces`). */
function levelled(
  p: TextPlaced,
  levelAt: (at: number) => number,
  line: LineLevels,
): TextPlaced[] {
  const text = p.item;
  const natural = text.layout.lines[text.layoutLine];
  const base = line.bidi.base;
  if (!p.from || !natural) return [{ ...p, level: base }];
  const { para, runs, spans } = p.from;
  const paragraph = line.bidi.text;
  // A bidi control takes no room and has no level of its own, whether
  // `unicode-bidi` stands for it or the document holds it: X9 removes it,
  // and bidi-js gives it the level of what is before it, which may be
  // another piece's. It is no end of a piece, nor of a run of one level.
  const quiet = (at: number): boolean =>
    spans.isGap(at) || isControl(paragraph.charCodeAt(para + at));
  let lowest = Infinity;
  let first = -1;
  let last = -1;
  for (let at = natural.start; at < natural.end; at += 1) {
    if (quiet(at)) continue;
    if (first < 0) first = at;
    last = at;
    lowest = Math.min(lowest, levelAt(para + at));
  }
  if (first < 0) return [{ ...p, level: base }];
  if (
    levelAt(para + first) === lowest &&
    levelAt(para + last) === lowest &&
    (plainlyLevelled(line.bidi, p.from, first, last, levelAt) ||
      laidAsLevelled(p.from, natural, levelAt, base))
  ) {
    return [{ ...p, level: lowest }];
  }
  const starts = runStarts(runs);
  const out: TextPlaced[] = [];
  let at = p.at;
  let lastRuns: TextRun[] = [];
  /** Where each piece is in the fragment's segment. */
  const ranges: [number, number][] = [];
  const piece = (from: number, to: number, level: number): void => {
    // its letters, each run's with where it is in the document and whose
    // text it is
    const letters: { run: TextRun; doc: number; box: Box | null }[] = [];
    let points = 0;
    for (let k = runIndexAt(starts, from); k < runs.length; k += 1) {
      const runStart = starts[k];
      if (runStart >= to) break;
      const a = Math.max(from, runStart);
      const b = Math.min(to, runStart + runs[k].text.length);
      if (b <= a || spans.isGap(a)) continue;
      const slice = runs[k].text.slice(a - runStart, b - runStart);
      letters.push({
        run: slice === runs[k].text ? runs[k] : { ...runs[k], text: slice },
        doc: spans.documentAt(a),
        box: spans.boxAt(a),
      });
      points += codeUnitOffsets(slice).length - 1;
    }
    if (!letters.length) return;
    const head = letters[0];
    const tail = letters[letters.length - 1];
    const docStart = head.doc;
    const docEnd = tail.doc + tail.run.text.length;
    const face = (run: TextRun, control: string): TextRun => ({
      text: control,
      family: run.family,
      size: run.size,
      weight: run.weight,
      style: run.style,
    });
    const rtl = (level & 1) === 1;
    const laidRuns: TextRun[] = [face(head.run, rtl ? '\u202e' : '\u202d')];
    const laidSpans = new SpanMap();
    laidSpans.add(docStart, 1, head.box, true);
    for (const { run, doc, box } of letters) {
      laidSpans.add(doc, run.text.length, box);
      laidRuns.push(run);
    }
    laidRuns.push(face(tail.run, '\u202c'));
    laidSpans.add(docEnd, 1, tail.box, true);
    const layout = line.fonts.layout(laidRuns, line.base, {
      lineHeight: line.lineHeight,
      align: 'left',
      direction: rtl ? 'rtl' : 'ltr',
      fit: PARAGRAPH_FIT,
    });
    LAYOUT_RUNS.set(layout, laidRuns);
    lastRuns = laidRuns;
    const laid = layout.lines[0];
    const item: LineText = {
      layout,
      layoutLine: 0,
      drawX: text.drawX + (at - p.at),
      drawY: 0,
      textStart: docStart,
      textEnd: docEnd,
      layoutStart: laid ? laid.start : 0,
      spans: laidSpans,
    };
    laidSpans.giveGaps(item, 0, laidSpans.laidOut);
    out.push({ kind: 'text', at, item, reads: null, level });
    ranges.push([from, to]);
    // the room it takes, its white space at its end with it, which the
    // engine hangs past the layout's width: from caret to caret
    const extent = Math.abs(
      layout.caretPosition(1 + points).x - layout.caretPosition(1).x,
    );
    at += Math.max(laid?.width ?? 0, extent);
  };
  let from = first;
  let level = levelAt(para + first);
  let prev = first;
  for (let o = first + 1; o <= last; o += 1) {
    if (quiet(o)) continue;
    const l = levelAt(para + o);
    if (l !== level) {
      piece(from, prev + 1, level);
      from = o;
      level = l;
    }
    prev = o;
  }
  piece(from, last + 1, level);
  if (!out.length) return [{ ...p, level: base }];
  // a word across two of the pieces runs on from one to the next, with no
  // edge between, as the fragment ran on from the text before it (`JOINS`)
  const joins = JOINS.get(text);
  if (joins !== undefined) JOINS.set(out[0].item, joins);
  for (let k = 1; k < out.length; k += 1) {
    const before = paragraph[para + ranges[k - 1][1] - 1];
    const after = paragraph[para + ranges[k][0]];
    if (!SPACE.test(before) && !SPACE.test(after)) JOINS.set(out[k].item, 0);
  }
  // the spaces `pre-wrap` keeps that the fragment ended on are its last
  // piece's, which the engine hangs as it hung them (`hangPreserved`)
  const tail = out[out.length - 1];
  if (text.hung) {
    const rtl = (tail.level! & 1) === 1;
    hangPreserved(tail.item, lastRuns, runStarts(lastRuns), line.fonts, rtl);
  }
  return out;
}

/**
 * Whether the engine, laying a fragment out alone, must have given its
 * letters the paragraph's levels, without resolving them to see: in a
 * paragraph of no explicit embedding, a stretch that begins and ends with a
 * strong letter and pairs no bracket is resolved inside itself, whatever is
 * around it (W1 to W7, N1 and N2 look no further than the strong letters
 * either side). The white space it ends on is the paragraph's level to the
 * engine, whose line ends there (L1), and has to be to the line.
 */
function plainlyLevelled(
  bidi: ParagraphBidi,
  from: NonNullable<TextPlaced['from']>,
  first: number,
  last: number,
  levelAt: (at: number) => number,
): boolean {
  if (bidi.explicit) return false;
  const text = bidi.text;
  const js = bidiJs();
  let end = last;
  while (
    end > first &&
    TRAILING.has(js.getBidiCharTypeName(text[from.para + end]))
  ) {
    if (levelAt(from.para + end) !== bidi.base) return false;
    end -= 1;
  }
  return (
    STRONG.has(js.getBidiCharTypeName(text[from.para + first])) &&
    STRONG.has(js.getBidiCharTypeName(text[from.para + end])) &&
    !BRACKETS.test(text.slice(from.para + first, from.para + end + 1))
  );
}

/** Whether the engine, laying a fragment out alone, gave its letters the
 *  levels the paragraph gives them: with its line's end white space back
 *  at the paragraph's level (L1), as the engine's own line ends there. */
function laidAsLevelled(
  from: NonNullable<TextPlaced['from']>,
  natural: TextLayoutLike['lines'][number],
  levelAt: (at: number) => number,
  base: number,
): boolean {
  const { text, levels } = aloneLevels(from.runs, base === 1);
  const js = bidiJs();
  const quiet = (at: number): boolean =>
    from.spans.isGap(at) || isControl(text.charCodeAt(at));
  let hung = natural.end;
  while (
    hung > natural.start &&
    TRAILING.has(js.getBidiCharTypeName(text[hung - 1]))
  ) {
    hung -= 1;
  }
  for (let at = natural.start; at < natural.end; at += 1) {
    if (quiet(at)) continue;
    const alone = at >= hung ? base : levels[at];
    if (alone !== levelAt(from.para + at)) return false;
  }
  return true;
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
function alignAtomic(placed: AtomicPlacement, line: LineBox): number {
  const box = placed.box;
  switch (box.style.verticalAlign) {
    case 'top':
      return 0;
    case 'bottom':
      return line.height - (box.height + box.marginTop + box.marginBottom);
    default:
      return line.baseline - atomicBaseline(box) - (placed.raise ?? 0);
  }
}

/**
 * How far an atomic's `vertical-align` raises its baseline above its
 * parent's (CSS 2.1 10.8.1), as `Lifts` raises an inline box's: `sub` and
 * `super` by a fifth and a third of the parent's font size and a pixel,
 * `text-top` and `text-bottom` to the edges of the parent's font, `middle`
 * by its middle to half the parent's x-height above the baseline, a length
 * by itself and a percentage of its own line height. `top` and `bottom` are
 * the line box's edges, and raise nothing from a baseline.
 *
 * `middle` is the parent's baseline, not the middle of the line: an image
 * set `middle` beside text in a line an image before it made tall sat
 * where that image left room, and drew the text beside it a pixel off.
 * Read before the line moves the atomic, as `atomicBaseline` is.
 */
function atomicRaise(
  fonts: FontsLike,
  box: Box,
  parent: ComputedStyle,
): number {
  const va = box.style.verticalAlign;
  switch (va) {
    case 'baseline':
    case 'top':
    case 'bottom':
      return 0;
    case 'sub':
      return -(parent.fontSize / 5 + parent.fontSize / 16);
    case 'super':
      return parent.fontSize / 3 + parent.fontSize / 16;
  }
  const h = box.height + box.marginTop + box.marginBottom;
  const b = atomicBaseline(box);
  switch (va) {
    case 'text-top':
      return faceExtent(fonts, parent).ascent - b;
    case 'text-bottom':
      return h - b - faceExtent(fonts, parent).descent;
    case 'middle':
      return xHeightOf(fonts, parent) / 2 + h / 2 - b;
    default:
      return typeof va === 'number'
        ? va
        : resolve(va, lineHeightOf(fonts, box.style));
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
    // a box that clips sits on its bottom margin edge, for legacy reasons
    // that stop at block containers (CSS Box Alignment 3, 9.2) — and an
    // inline table, as browsers keep it: an inline flex box that clips
    // sits on its first item's, as it does unclipped. A MediaWiki button
    // is an `overflow: hidden` inline flex box of one icon, and stood its
    // whole height on the baseline, the line under it the strut's descent
    // taller
    (scrolls(box.style) && box.kind !== 'flex') ||
    // layout containment keeps its baseline in (CSS Containment 2, 3.3)
    box.style.contain & CONTAIN_LAYOUT
  ) {
    return bottom;
  }
  const baseline =
    box.kind === 'table'
      ? tableBaseline(box)
      : // an inline flex box sits on its first (CSS Flexbox 8.5), where an
        // inline block sits on its last line's
        box.kind === 'flex'
        ? firstBaselineIn(box)
        : lastBaselineIn(box);
  return baseline === null ? bottom : box.marginTop + (baseline - box.y);
}

/**
 * A flex container's first baseline, or its last (CSS Flexbox 8.5): that
 * of the first item on its first line that is aligned by its baseline — the
 * last on its last line — or where none is, of its first item, or last,
 * in `order`. An item gives its own, or where it has none, its border
 * box's bottom edge. Not its last child's: an `inline-flex` of a small
 * item and a big one sat on the big one's baseline. Null for a box with no
 * item.
 */
function flexBaseline(box: Box, first: boolean): number | null {
  let items: Box[] = [];
  let reordered = false;
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.style.order !== 0) reordered = true;
    items.push(child);
  }
  if (!items.length) return null;
  if (reordered) items.sort((a, b) => a.style.order - b.style.order);
  if (!first) items = items.reverse();
  const style = box.style;
  if (style.flexDirection.startsWith('row') && !style.grid) {
    // a line ends where the next item does not go on along the main axis,
    // which from the last item is where it goes on
    const back =
      ((style.flexDirection === 'row-reverse') !==
        (style.direction === 'rtl')) !==
      !first;
    let last = NaN;
    for (const item of items) {
      if (!Number.isNaN(last) && (back ? item.x >= last : item.x <= last)) {
        break;
      }
      last = item.x;
      const align =
        item.style.alignSelf === 'auto'
          ? style.alignItems
          : item.style.alignSelf;
      if (align === 'baseline') return itemBaselineOf(item, first, style);
    }
  }
  return itemBaselineOf(items[0], first, style);
}

/** A flex item's baseline, in document coordinates: its first line's or
 *  its last's — its bottom margin edge where it clips what it holds — or
 *  where it has none, its border box's bottom edge, which a grid does not
 *  take from its item, and has none of its own then (CSS Grid 1, 9). */
function itemBaselineOf(
  item: Box,
  first: boolean,
  container: ComputedStyle,
): number | null {
  const found = childBaseline(item, first ? firstBaselineIn : lastBaselineIn);
  if (found !== null) return found;
  return container.grid ? null : item.y + item.height;
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
  // a flex box's is its items', in the order it lays them out
  if (box.kind === 'flex') return flexBaseline(box, false);
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
  if (box.kind === 'flex') return flexBaseline(box, true);
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
  // the legacy rule is a block container's last baseline alone (CSS Box
  // Alignment 3, 9.2): its first is its first line's, clipped or not
  if (
    inside === lastBaselineIn &&
    child.kind !== 'flex' &&
    scrolls(child.style)
  ) {
    return child.y + child.height + child.marginBottom;
  }
  return inside(child);
}

/** An absolutely positioned box among a paragraph's content, before the
 *  item at `index`. */
interface StaticMark {
  index: number;
  box: Box;
}

/**
 * The static position of each absolutely positioned box among a
 * paragraph's content (CSS 2.1 10.3.7, 10.6.4): where it would have been
 * in flow, found from the content before it. A block-level one would have
 * broken the line that content is on, so it goes under that line at the
 * line's start; an inline-level one goes on it, where the pen stood after
 * that content, or under it where a forced break ends the text; either goes
 * at the top where nothing comes before it. Taken as the block's content
 * top for every one of them, a box after a line of text was drawn over that
 * line, and a menu under its link came up on it. Not from a probe of
 * intrinsic width, whose room is no place for one.
 */
function staticPositions(
  statics: StaticMark[],
  items: Item[],
  lines: LineBox[],
  block: Box,
  options: InlineOptions,
): void {
  if (!Number.isFinite(options.width)) return;
  for (const { index, box } of statics) {
    const inline = INLINE_BEFORE_ABSOLUTE.has(box.style);
    let top = lines.length ? lines[0].y : 0;
    let x = 0;
    const after = lines.length ? penAfter(items, index, lines) : null;
    if (after) {
      const { line, pen, broken } = after;
      if (inline && !broken) {
        top = line.y;
        x = pen;
      } else {
        top = line.y + line.height;
      }
    }
    box.staticPosition = {
      from: block,
      x: options.originX + x - block.x,
      right: options.originX + options.width - block.x,
      y: options.startY + top - block.y,
    };
  }
}

/** The line the content before `items[index]` ended on, where the pen
 *  stood after it, and whether it ended in a forced break. Null where no
 *  text or atomic comes before. */
function penAfter(
  items: Item[],
  index: number,
  lines: LineBox[],
): { line: LineBox; pen: number; broken: boolean } | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === 'edge') {
      // an inline box's margin, border or padding is content, which keeps
      // its line from being one of no height (CSS 2.1 9.4.2), even where
      // they add up to no width
      if (!hasEdgeOn(item.box, item.side)) continue;
      for (const line of lines) {
        const placed = line.edges?.find(
          (e) => e.box === item.box && e.side === item.side,
        );
        if (placed) {
          return { line, pen: placed.x + placed.width, broken: false };
        }
      }
      continue;
    }
    if (item.kind === 'atomic') {
      for (const line of lines) {
        const placed = line.atomics.find((a) => a.box === item.box);
        if (!placed) continue;
        const pen = placed.x + item.box.width + item.box.marginRight;
        return { line, pen, broken: false };
      }
      return null;
    }
    if (item.kind !== 'text' || item.control) continue;
    const end = item.start + item.length;
    const line =
      lines.find((l) => l.textStart < end && end <= l.textEnd) ??
      lines[lines.length - 1];
    const broken = item.run.text.endsWith('\n');
    return { line, pen: broken ? 0 : caretX(line, end), broken };
  }
  return null;
}

/** Whether an inline box has margin, border or padding on a side. */
function hasEdgeOn(box: Box, side: 'start' | 'end'): boolean {
  const left = (side === 'start') !== (box.style.direction === 'rtl');
  return left
    ? box.marginLeft !== 0 || box.borderLeft !== 0 || box.padLeft !== 0
    : box.marginRight !== 0 || box.borderRight !== 0 || box.padRight !== 0;
}

/** Where the caret at document offset `at` stands on a line, in the
 *  paragraph's coordinates: the line's end where no text of it holds the
 *  offset. */
function caretX(line: LineBox, at: number): number {
  for (const text of line.texts) {
    if (at < text.textStart || at > text.textEnd) continue;
    const offsets = layoutOffsets(text.layout);
    const units = layoutOffsetOf(text, at, true);
    const caret = text.layout.caretPosition(codePointAtOffset(offsets, units));
    return text.drawX + caret.x;
  }
  return line.x + line.width;
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
  /** Where each absolutely positioned box among the content is: before the
   *  item at `index`. No item of the stream, which reads none of them. */
  statics?: StaticMark[],
  /** Whether the text is an inline box's that has a margin, border or
   *  padding at a side, which parts it from the text beside it. */
  apart = false,
): number {
  let floated = 0;
  for (const child of box.children) {
    if (child.outOfFlow) {
      statics?.push({ index: out.length, box: child });
      continue;
    }
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
          // shaping is broken across the edge (CSS Text 3, 7.3), and the
          // engine shapes a word that runs across spans shaped alike as one:
          // its text is shaped on its own. At both of its sides, the one
          // with no edge among them, as the engine takes it
          if (apart) run.shapeApart = true;
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
        // and a margin a border cancels is still an edge, which keeps its
        // line from being one of no height (CSS 2.1 9.4.2)
        const edged =
          start !== 0 ||
          end !== 0 ||
          hasEdgeOn(child, 'start') ||
          hasEdgeOn(child, 'end') ||
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
        floated += collect(
          child,
          out,
          width,
          fonts,
          block,
          floats,
          statics,
          start !== 0 || end !== 0,
        );
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
 * What a paragraph does with a word too long for its line: cuts it where
 * its style or any text in it says a word may be cut — `overflow-wrap`, or
 * `word-break` or `line-break: anywhere`, which cut one whatever
 * `overflow-wrap` says (CSS Text 3, 5.2 and 5.3) — and lets it run past the
 * line's end where nothing does, as a browser does. The engine takes one answer for the paragraph, so a span
 * that breaks its words breaks the paragraph's.
 */
function overflowWrapOf(
  style: ComputedStyle,
  items: readonly Item[],
): 'normal' | 'break-word' {
  if (breaksWords(style)) return 'break-word';
  for (const item of items) {
    if (item.kind === 'text' && breaksWords(item.box.style)) {
      return 'break-word';
    }
  }
  return 'normal';
}

/** A `text-overflow` cut on a line that does not wrap puts its ellipsis at
 *  the box's edge, inside a word where one runs past it, as a browser
 *  does — which is the engine cutting the word there. */
function cutWrap(
  style: ComputedStyle,
  cut: Cut | null | undefined,
  wrapWords: 'normal' | 'break-word',
): 'normal' | 'break-word' {
  return cut && !wraps(style) ? 'break-word' : wrapWords;
}

function breaksWords(style: ComputedStyle): boolean {
  return (
    style.overflowWrap !== 'normal' ||
    style.wordBreak === 'break-all' ||
    style.wordBreak === 'break-word' ||
    style.lineBreakAnywhere
  );
}

/**
 * Keep the text of a `nowrap` element together where its block wraps (CSS
 * 2.1 16.6). Its runs share the element as their `nowrap`, which ntk makes
 * no break inside or between; and, for an engine that does not read it,
 * a space it may not break after is a no-break space, as wide and as many,
 * so every offset holds. Whether a line breaks between two characters is
 * the call of the nearest element holding both (CSS Text 3, 5.1), so the
 * space such an element ends on stays one to break at where the text after
 * it is not the same element's: text that wraps, or another `nowrap`
 * element's — two tags side by side, a collapsed space between them.
 */
function holdNoWrap(items: Item[], block: Box): void {
  let last = true;
  let nextGroup: Box | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'text') continue;
    const group = wraps(item.box.style) ? null : noWrapGroup(item.box, block);
    if (group) {
      const text = item.run.text;
      let held = text;
      // `pre`'s are no-break spaces already (`runFor`)
      if (item.box.style.whiteSpace === 'nowrap' && text.includes(' ')) {
        held = text.replace(/ /g, '\u00a0');
        if (text.endsWith(' ') && (last || nextGroup !== group)) {
          held = held.slice(0, -1) + ' ';
        }
      }
      item.run = { ...item.run, text: held, nowrap: group };
    }
    last = false;
    nextGroup = group;
  }
}

/** The element a text that does not wrap is held together by: the outermost
 *  one inside the block that does not wrap either. */
function noWrapGroup(box: Box, block: Box): Box {
  let group = box;
  for (let up = box.parent; up && up !== block; up = up.parent) {
    if (wraps(up.style)) break;
    group = up;
  }
  return group;
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
        ...(extra
          ? {
              letterSpacing: (run.letterSpacing ?? 0) + extra,
              kernAcross: true,
            }
          : null),
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
  box.decoration = inlineDecoration(fonts, box, s);
  if (!box.decoration && fonts && (box.padTop > 0 || box.padBottom > 0)) {
    PADDED_FACES.set(box, faceExtent(fonts, s));
  } else PADDED_FACES.delete(box);
  const left = box.marginLeft + box.borderLeft + box.padLeft;
  const right = box.padRight + box.borderRight + box.marginRight;
  return s.direction === 'rtl' ? [right, left] : [left, right];
}

/**
 * What an inline box draws around its text, in `s`: the extent of its face
 * where it has a background, a border or an outline, and null where it
 * draws none. Its borders are the ones `inlineEdges` just used. Shared with
 * a pointer move that gives a link a background (`HtmlViewNode`).
 */
export function inlineDecoration(
  fonts: FontsLike | null,
  box: Box,
  s: ComputedStyle,
): InlineDecoration | null {
  // a background is a colour, a gradient or an image: a span a gradient
  // underlines, a highlighter's, was painted only where it had a border
  const decorated =
    !isTransparent(s.backgroundColor) ||
    s.backgroundGradient !== null ||
    s.backgroundImage !== null ||
    s.backgroundImages !== null ||
    box.borderTop + box.borderRight + box.borderBottom + box.borderLeft > 0 ||
    s.outlineStyle !== 'none';
  return !decorated ? null : fonts ? faceExtent(fonts, s) : NO_EXTENT;
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

/** A first line in its `::first-line` fonts (`firstLineSetting`). */
interface FirstLineSetting {
  /** The content, its text in the styles its boxes have on the line. */
  items: Item[];
  base: Record<string, unknown>;
  lineHeight: number;
  strut: InlineDecoration | null;
  lifts: Lifts;
  justify: LineJustify | null;
}

/**
 * What a first line is made with where its `::first-line` sets its fonts
 * (CSS 2.1 5.12.1). Its text is in the styles its boxes have on it — each
 * element's own rules over what it inherits there, which takes the fonts
 * from `::first-line` (CSS Pseudo 4, 2.1.2), so a `<small>` is smaller
 * than the line's font and not than the block's — and it is laid out at
 * the pseudo-element's line height. The pseudo-element is an inline box
 * around the line's content, so its face at its line height is on the line
 * with the block's strut, which stays: a `::first-line` of a smaller line
 * height leaves the line as tall as the block's.
 */
function firstLineSetting(
  block: Box,
  items: Item[],
  how: NonNullable<InlineOptions['firstLineStyle']>,
  fonts: FontsLike,
  strut: InlineDecoration | null,
  justify: LineJustify | null,
): FirstLineSetting {
  const style = how.style;
  const of = (box: Box): ComputedStyle =>
    box === block || !box.parent
      ? style
      : styleOnFirstLine(box, of(box.parent), how.styler);
  // and in its `text-transform` where the line has one of its own, which
  // the boxes' text was not made with: a word carried from one run into
  // the next, as the box builder carries it (`letteredAfter`)
  let lettered = false;
  const restyled = items.map((item): Item => {
    if (item.kind === 'atomic') lettered = false;
    if (item.kind !== 'text') return item;
    const own = item.box.style;
    const on = of(item.box);
    let run = restyledRun(item.run, own, on);
    const transform = on.textTransform;
    if (
      !item.control &&
      transform !== own.textTransform &&
      transform !== 'none'
    ) {
      const text = transformInPlace(run.text, transform, lettered);
      if (text !== run.text) run = { ...run, text };
    }
    lettered = letteredAfter(run.text, lettered);
    return run === item.run ? item : { ...item, run };
  });
  const lineHeight = lineHeightMultiplier(fonts, style);
  const base = {
    family: style.fontFamily,
    size: style.fontSize,
    weight: style.fontWeight,
    style: style.fontStyle,
    color: style.color,
  };
  const own = strutOf(fonts, style);
  return {
    items: restyled,
    base,
    lineHeight,
    strut: strut && {
      ascent: Math.max(strut.ascent, own.ascent),
      descent: Math.max(strut.descent, own.descent),
    },
    lifts: new Lifts(fonts, style, of),
    justify: justify && {
      ...justify,
      base,
      options: { ...justify.options, lineHeight },
    },
  };
}

/**
 * Each box's style on a first line (`FirstLineStyler`), kept for the style
 * its parent has there: every pass asks again, and a style that is a new
 * object each time is a new face to every cache that keys on one.
 */
const ON_FIRST_LINE = new WeakMap<
  Box,
  { parent: ComputedStyle; style: ComputedStyle }
>();

/** A box's style on a first line, where its parent's there is `parent`. */
function styleOnFirstLine(
  box: Box,
  parent: ComputedStyle,
  styler: FirstLineStyler,
): ComputedStyle {
  const known = ON_FIRST_LINE.get(box);
  if (known && known.parent === parent) return known.style;
  const style = styler(box, parent);
  ON_FIRST_LINE.set(box, { parent, style });
  return style;
}

/** What a run takes from its style (`runFor`). */
const RUN_STYLE = [
  'family',
  'size',
  'weight',
  'style',
  'color',
  'letterSpacing',
  'features',
  'underline',
  'underlineStyle',
  'underlineOffset',
  'underlineThickness',
  'strike',
] as const;

/**
 * A run of text in `style` rather than `own`, the style it was made in:
 * what it has of neither — the room a tab or `word-spacing` adds to its
 * letter spacing, a `nowrap` group, where its shaping is broken — kept.
 */
function restyledRun(
  run: TextRun,
  own: ComputedStyle,
  style: ComputedStyle,
): TextRun {
  if (style === own) return run;
  const fresh = runFor(run.text, style) as unknown as Record<string, unknown>;
  const out = { ...run } as unknown as Record<string, unknown>;
  for (const name of RUN_STYLE) {
    if (fresh[name] === undefined) delete out[name];
    else out[name] = fresh[name];
  }
  const added = (run.letterSpacing ?? 0) - (own.letterSpacing || 0);
  if (added) out.letterSpacing = ((out.letterSpacing as number) ?? 0) + added;
  return out as unknown as TextRun;
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
 * Whether a line one layout made is shorter about its baseline than the
 * block's strut. Every line box starts with the strut, the block's font at
 * its line height (CSS 2.1 10.8.1), and a layout has none: it makes a line
 * as tall as the text on it, at the block's line height as a multiple of
 * each face's natural one. So a line of `<small>` text alone came out as
 * short as the small text, and overlapped what followed. A paragraph with
 * such a line is made a line at a time instead, where `finishLine` puts
 * the strut on every line; one whose lines all hold text of the block's
 * own face is kept as it was laid out.
 */
function shortOfStrut(
  lines: readonly LineBox[],
  strut: InlineDecoration | null,
  /** The first line's, where it holds more: a marker's room. */
  first: InlineDecoration | null = null,
): boolean {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const holds = i === 0 && first ? first : strut;
    if (!holds) continue;
    // its room as the strut's is worked out, whichever baseline the layout
    // it is drawn with could keep (`layoutLift`)
    const text = line.texts.length === 1 ? line.texts[0] : null;
    const natural = text?.layout.lines[text.layoutLine];
    const ascent = natural ? lineAscent(natural) : line.baseline;
    if (
      ascent < holds.ascent - 0.5 ||
      line.height - ascent < holds.descent - 0.5
    ) {
      return true;
    }
  }
  return false;
}

/** A strut with room besides it about the same baseline, or the strut
 *  where there is none. */
function withRoom(
  strut: InlineDecoration | null,
  room: InlineDecoration | undefined,
): InlineDecoration | null {
  if (!room) return strut;
  if (!strut) return room;
  return {
    ascent: Math.max(strut.ascent, room.ascent),
    descent: Math.max(strut.descent, room.descent),
  };
}

/** The share of the size a synthesized small capital is set at, rounded to
 *  a whole pixel as Blink rounds it (`SimpleFontData`'s scaled font data):
 *  CSS Fonts 4 (6.2) leaves the size to the user agent. */
const SMALL_CAPS_SCALE = 0.7;

/**
 * Small capitals a face does not have, made of its capitals set smaller
 * (CSS Fonts 4, 6.2): where `font-variant-caps` asks for `smcp` — or
 * `c2sc` too, for `all-small-caps` — and the face does not answer it,
 * each letter that would be a small capital is its capital at 70% of the
 * size, in a run of its own: a lower-case letter, and for `all-small-caps`
 * the rest of the text too. Under `small-caps` what has no case — a space,
 * a digit, a mark of punctuation — keeps its size, as Blink keeps it. Only
 * a letter whose capital is one character is made one, so every offset
 * holds.
 */
function synthesizeSmallCaps(items: Item[], fonts: FontsLike): void {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'text' || item.control) continue;
    // `font-variant-caps`'s, which is synthesized where the face has none;
    // not `font-feature-settings`', which asks for the feature as it is
    const caps = item.box.style.fontVariantCaps;
    const features = item.run.features;
    if (!caps.includes('smcp') || !features?.smcp) continue;
    const all = caps.includes('c2sc');
    if (hasSmallCaps(fonts, item.run, all)) continue;
    const pieces = smallCapsPieces(item, all, withoutCaps(features));
    if (!pieces) continue;
    items.splice(i, 1, ...pieces);
    i += pieces.length - 1;
  }
}

/** A text item cut where its letters turn to synthesized small capitals
 *  and back, or null where none does. */
function smallCapsPieces(
  item: Extract<Item, { kind: 'text' }>,
  all: boolean,
  features: Readonly<Record<string, number>> | null,
): Extract<Item, { kind: 'text' }>[] | null {
  const text = item.run.text;
  const pieces: Extract<Item, { kind: 'text' }>[] = [];
  let from = 0;
  let small = false;
  let capitals = '';
  const cut = (to: number): void => {
    if (to === from) return;
    const run: TextRun = small
      ? {
          ...item.run,
          text: capitals,
          size: Math.round((item.run.size ?? 16) * SMALL_CAPS_SCALE),
        }
      : { ...item.run, text: text.slice(from, to) };
    if (small) {
      if (features) run.features = features;
      else delete run.features;
    }
    pieces.push({ ...item, run, start: item.start + from, length: to - from });
    from = to;
    capitals = '';
  };
  let any = false;
  for (let at = 0; at < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(at)!);
    const upper = ch.toUpperCase();
    // everything, for `all-small-caps`: its spaces are small too
    const becomes = (all || upper !== ch) && upper.length === ch.length;
    if (becomes !== small) {
      cut(at);
      small = becomes;
    }
    if (becomes) {
      capitals += upper;
      any = true;
    }
    at += ch.length;
  }
  cut(text.length);
  return any ? pieces : null;
}

/** Features without the small capitals a synthesis stands in for, one
 *  object for each set, as `featuresOf` keeps them. */
function withoutCaps(
  features: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> | null {
  let kept = WITHOUT_CAPS.get(features);
  if (kept === undefined) {
    const out: Record<string, number> = {};
    for (const [tag, value] of Object.entries(features)) {
      if (tag !== 'smcp' && tag !== 'c2sc') out[tag] = value;
    }
    kept = Object.keys(out).length ? out : null;
    WITHOUT_CAPS.set(features, kept);
  }
  return kept;
}

const WITHOUT_CAPS = new WeakMap<
  Readonly<Record<string, number>>,
  Readonly<Record<string, number>> | null
>();

/**
 * Whether a run's face has small capitals of its own — and capitals to
 * small capitals, for `all-small-caps`: the alphabet set with the feature
 * and without it comes out another width where it does. Asked of the
 * engine's layout rather than of the font's tables, which a CoreText face
 * does not hand over. Kept per face.
 */
function hasSmallCaps(fonts: FontsLike, run: TextRun, all: boolean): boolean {
  let known = SMALL_CAPS.get(fonts);
  if (!known) SMALL_CAPS.set(fonts, (known = new Map()));
  const key = `${run.family}|${run.weight}|${run.style}|${all}`;
  let has = known.get(key);
  if (has === undefined) {
    const face = {
      family: run.family,
      weight: run.weight,
      style: run.style,
      size: 16,
    };
    const width = (text: string, features: Record<string, number> | null) =>
      fonts.layout(
        [{ text, ...face, ...(features ? { features } : null) }],
        face,
        {},
      ).width;
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    has = Math.abs(width(lower, { smcp: 1 }) - width(lower, null)) > 0.01;
    if (has && all) {
      const upper = lower.toUpperCase();
      has = Math.abs(width(upper, { c2sc: 1 }) - width(upper, null)) > 0.01;
    }
    known.set(key, has);
  }
  return has;
}

const SMALL_CAPS = new WeakMap<FontsLike, Map<string, boolean>>();

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

/** A run of `text` in `style`: its face, its ink and its rules. Every
 *  paint field of a run of the document's text is this function's, which
 *  is what lets a pointer move re-ink a paragraph without laying it out
 *  again (`HtmlViewNode._hoverInPlace`). */
export function runFor(text: string, style: ComputedStyle): TextRun {
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
    // set here, and made true later for an inline box's text (`collect`):
    // added to a run after it was made, it gave the runs of a document two
    // shapes where the layout cache compares them, and a pass over 600 KB
    // took 3 ms longer finding every paragraph's layout again
    shapeApart: false,
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
    // The band the rule is drawn in: as thick as the box that set it made
    // it (`usedThickness`), and as far under the baseline as that box said.
    // `auto` leaves how far to the user agent, at or under the baseline
    // (CSS Text Decoration 4, 2.7 and 2.8), and it is half the rule's
    // thickness, a pixel at the least — Blink's gap, which keeps a thick
    // rule as clear of its letters as a thin one. A length is from the
    // baseline itself.
    const band = style.underlineThickness ?? 1;
    const top =
      style.underlineOffset === null
        ? Math.max(1, Math.ceil(band / 2))
        : Math.round(style.underlineOffset);
    if (run.underlineStyle === 'dotted' || run.underlineStyle === 'dashed') {
      // dots and dashes are a stroke along the band's middle, its width the
      // nearest whole pixel to the band's: 1.6 is two, where a solid rule's
      // is the one pixel it fills
      const width = Math.round(band);
      run.underlineThickness = width;
      run.underlineOffset =
        top + Math.floor(Math.max(band / 2, 0.5)) - Math.floor(width / 2);
    } else {
      run.underlineThickness = Math.floor(band);
      run.underlineOffset = top;
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

  add(
    documentStart: number,
    length: number,
    box: Box | null = null,
    /** No text of the document's, though a box's: a bidi control a
     *  level's layout is wrapped in (`levelPieces`), which answers for
     *  the element around it. */
    gap = box === null,
  ): void {
    this._laid.push(this.laidOut);
    this._doc.push(documentStart);
    this._boxes.push(box);
    if (gap) {
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

  /** Whether an offset in the laid-out text is no text of the
   *  document's: a spacer, a bidi control. */
  isGap(offset: number): boolean {
    const gaps = this._gaps;
    if (!gaps) return false;
    let lo = 0;
    let hi = gaps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gaps[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return gaps[lo] === offset;
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

/** A text a line may break after where its block wraps: one that ends in
 *  white space, which a no-break space a `nowrap` element holds is not. */
const BREAKS_AFTER = /[ \t\n]$/;

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

/** Where each run starts in their joined text. */
function runStarts(runs: TextRun[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const run of runs) {
    starts.push(at);
    at += run.text.length;
  }
  return starts;
}

/** The run a code-unit offset in the runs' joined text falls in. */
function runIndexAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The spaces `pre-wrap` keeps that a line ends on (CSS Text 3, 4.1.3), in
 * logical order and each with its advance, and whether a forced break
 * follows them. An engine strips a line's trailing white space, which is
 * right for the collapsible spaces CSS removes there, and wrong for these.
 */
function keptAtEnd(
  natural: TextLayoutLike['lines'][number],
  runs: TextRun[],
  starts: number[],
  spans: LineText['spans'],
  fonts: FontsLike,
): { found: HungSpace[] | null; forced: boolean } {
  const boxAt = spans.boxAt;
  if (!boxAt || !runs.length) return { found: null, forced: false };
  const charAt = (offset: number): number => {
    const k = runIndexAt(starts, offset);
    return runs[k].text.charCodeAt(offset - starts[k]);
  };
  let end = natural.end;
  let forced = false;
  if (end > natural.start && charAt(end - 1) === 10) {
    forced = true;
    end -= 1;
  }
  let found: HungSpace[] | null = null;
  let kept = false;
  for (let at = end - 1; at >= natural.start; at -= 1) {
    const c = charAt(at);
    if (isControl(c)) continue;
    if (c !== 0x20) break;
    // a collapsible space after the last kept one is removed (4.1.3), and
    // one before a kept one hangs with it
    const keeps = boxAt.call(spans, at)?.style.whiteSpace === 'pre-wrap';
    if (!keeps && !kept) continue;
    kept = true;
    const run = runs[runIndexAt(starts, at)];
    (found ??= []).push({ at, x: 0, width: spaceAdvance(fonts, run) });
  }
  found?.reverse();
  return { found, forced };
}

type HungSpace = NonNullable<LineText['hung']>[number];

/**
 * The spaces `pre-wrap` keeps that a text's line ends on, which the engine
 * hung (`keptAtEnd`): past the line's end, to its left where the layout
 * reads right to left, and their inline box's, whose background and border
 * cover them, as a browser draws them. Noted on the text (`LineText.hung`),
 * and their advance answered, with whether a forced break follows them.
 */
function hangPreserved(
  text: LineText,
  runs: TextRun[],
  starts: number[],
  fonts: FontsLike,
  rtl: boolean,
): { total: number; forced: boolean } {
  const natural = text.layout.lines[text.layoutLine];
  if (!natural) return { total: 0, forced: false };
  const { found, forced } = keptAtEnd(natural, runs, starts, text.spans, fonts);
  if (!found) return { total: 0, forced };
  text.hung = found;
  placeHung(text, rtl);
  let total = 0;
  for (const space of found) total += space.width;
  return { total, forced };
}

const NOTHING_HUNG = { total: 0, forced: false };

/** Put a text's hung spaces beside its line's end, logical order outward:
 *  to the right of its glyphs, or to their left. */
function placeHung(text: LineText, left: boolean): void {
  const natural = text.layout.lines[text.layoutLine];
  if (!text.hung || !natural) return;
  let x = left ? natural.x : natural.x + natural.width;
  for (const space of text.hung) {
    if (left) x -= space.width;
    space.x = x;
    if (!left) x += space.width;
  }
}

/**
 * The runs of a layout with the spaces `pre-wrap` keeps before a forced
 * break held where they fit (`keptAtEnd`) — a kept newline, or the block's
 * end after the last line where `ends` — or null where none are. They hang
 * there only where they do not fit (CSS Text 3, 4.1.3), so they take room,
 * which the engine gives them when they are handed over as no-break
 * spaces, as `pre`'s are (`heldText`): it measures them, and aligns the
 * line with them. Laid out again, the lines break where they did, since
 * the spaces fit where they are. A line of a layout cannot be moved over
 * for them afterwards: its lines are drawn in one draw, from one place.
 */
function holdAtBreaks(
  layout: TextLayoutLike,
  runs: TextRun[],
  spans: SpanMap,
  fonts: FontsLike,
  width: number,
  ends: boolean,
): TextRun[] | null {
  const starts = runStarts(runs);
  let held: number[] | null = null;
  const lines = layout.lines;
  for (let i = 0; i < lines.length; i += 1) {
    const natural = lines[i];
    const { found, forced } = keptAtEnd(natural, runs, starts, spans, fonts);
    if (!found || !(forced || (ends && i === lines.length - 1))) continue;
    let free = width - natural.width;
    for (const space of found) {
      if (space.width > free + 0.01) break;
      free -= space.width;
      (held ??= []).push(space.at);
    }
  }
  if (!held) return null;
  held.sort((a, b) => a - b);
  const out = runs.slice();
  let next = 0;
  for (let k = 0; k < runs.length && next < held.length; k += 1) {
    const start = starts[k];
    const end = start + runs[k].text.length;
    if (held[next] >= end) continue;
    const chars = runs[k].text.split('');
    while (next < held.length && held[next] < end) {
      chars[held[next] - start] = '\u00a0';
      next += 1;
    }
    out[k] = { ...runs[k], text: chars.join('') };
  }
  return out;
}

/** The spaces `pre-wrap` keeps that the lines one layout made hung at
 *  their ends (`hangPreserved`), noted on each line's text. */
function hangLines(
  lines: LineBox[],
  from: number,
  runs: TextRun[],
  fonts: FontsLike,
  rtl: boolean,
): void {
  let starts: number[] | null = null;
  for (let i = from; i < lines.length; i += 1) {
    const text = lines[i].texts[0];
    if (!text) continue;
    starts ??= runStarts(runs);
    hangPreserved(text, runs, starts, fonts, rtl);
  }
}

/**
 * A clamped paragraph with an ellipsis at the end of its last line (CSS
 * Overflow 4, 4.2): its text up to where that line breaks in the room the
 * ellipsis leaves it — at a soft wrap opportunity, so the words that do
 * not fit beside the ellipsis go to the lines the clamp hides, and inside
 * a word only where the line has no other — and the ellipsis after it, in
 * the block's own style. The engine's own ellipsis cuts inside the last
 * word, as `text-overflow` does.
 */
function ellipsized(
  fonts: FontsLike,
  items: readonly Extract<Item, { kind: 'text' }>[],
  runs: TextRun[],
  base: Record<string, unknown>,
  options: Parameters<FontsLike['layout']>[2],
  layout: TextLayoutLike,
  width: number,
  style: ComputedStyle,
): { layout: TextLayoutLike; runs: TextRun[]; spans: SpanMap } {
  const mark = runFor('\u2026', style);
  const room = width - fonts.layout([mark], base, {}).width;
  const last = layout.lines[layout.lines.length - 1];
  let end = last.end;
  if (last.width > room) {
    const probe = fonts.layout(sliceRuns(runs, last.start, last.end), base, {
      ...options,
      maxWidth: Math.max(0, room),
      maxLines: 1,
      overflow: 'clip',
      overflowWrap: 'break-word',
    });
    end = last.start + (probe.lines[0]?.end ?? 0);
  }
  // the text to the break, less the white space the line ends in — an
  // empty line keeps the break before it, and is the ellipsis alone
  const line = sliceRuns(runs, last.start, end);
  let trailing = 0;
  for (let i = line.length - 1; i >= 0; i -= 1) {
    const text = line[i].text;
    const trimmed = text.replace(/[ \t\n\r\f]+$/, '').length;
    trailing += text.length - trimmed;
    if (trimmed) break;
  }
  const kept = sliceRuns(runs, 0, end - trailing);
  // and the spans to match, the ellipsis no text of the document's
  const spans = new SpanMap();
  let at = items.length ? items[0].start : 0;
  let left = 0;
  for (const run of kept) left += run.text.length;
  for (const item of items) {
    if (left <= 0) break;
    const length = Math.min(item.run.text.length, left);
    spans.add(item.start, length, item.control ? null : item.box);
    left -= length;
    at = item.start + length;
  }
  spans.add(at, 1, null);
  kept.push(mark);
  return { layout: fonts.layout(kept, base, options), runs: kept, spans };
}

/** The runs' text from one code-unit offset into their joined text to
 *  another, each piece in its own run's style. */
function sliceRuns(
  runs: readonly TextRun[],
  from: number,
  to: number,
): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const run of runs) {
    const next = at + run.text.length;
    if (next > from && at < to) {
      const text = run.text.slice(Math.max(0, from - at), to - at);
      out.push(text === run.text ? run : { ...run, text });
    }
    at = next;
    if (at >= to) break;
  }
  return out;
}

/** Whether anything but whitespace lies past a code-unit offset into the
 *  runs' joined text — "did `maxLines` drop content", for a layout that
 *  does not say. */
function inkBeyond(runs: TextRun[], offset: number): boolean {
  let at = 0;
  for (const run of runs) {
    const next = at + run.text.length;
    if (
      next > offset &&
      /[^ \t\n\r\f]/.test(run.text.slice(Math.max(0, offset - at)))
    ) {
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
/** How far into the room a line an alignment sets goes: 0 at the left, 1
 *  at the right; `justify` at the start, since a line not justified is
 *  set there. */
function alignShift(
  align: ComputedStyle['textAlign'] | ComputedStyle['textAlignLast'],
  rtl: boolean,
): number {
  switch (align) {
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
/** How the lines of a layout made with no width to fill are placed in
 *  the room: each is its text's last or a forced break's, and takes
 *  `text-align-last`, but where `last` is false — a balanced paragraph's,
 *  laid out narrower than its room. */
function unwrappedPlacer(
  style: ComputedStyle,
  width: number,
  last = true,
): LinePlacer | null {
  const rtl = style.direction === 'rtl';
  const shift = alignShift(last ? lastAlignOf(style) : style.textAlign, rtl);
  if ((shift === 0 && !rtl) || !Number.isFinite(width)) return null;
  return (line) => {
    const free = width - line.width;
    return (free >= 0 ? free * shift : rtl ? free : 0) - line.x;
  };
}

/**
 * The spacing a space is given to be laid out as one that may be spaced
 * apart, too little to move a glyph. It is not nothing, because CoreText
 * does not measure a space that is a spaced run of its own as it measures
 * the same space inside its run: it spaces a glyph with its kerning
 * attribute, which takes the place of the font's pairs. A line justified
 * from a measure of its spaces as they were came out wider than its box
 * and broke a word early: on macOS, in Helvetica, half of a paragraph did.
 * ntk keeps the pairs a spaced space makes with the letters beside it
 * (Arial's space and `T`, its `L` and space) where the run is marked
 * `kernAcross` — spacing that justifies a line is in addition to kerning
 * (CSS Text 3, 7.2) — so there the measure is the unjustified line's, as
 * a browser's is.
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
        kernAcross: true,
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
 * line ends on hang, and take no share. `skip` is the offsets of spaces
 * that are no word separators — an inline box's edge laid out as a spacer
 * (`layoutSpaced`) — which take no share either. Null where no line is
 * justified.
 */
function justifiedRuns(
  runs: TextRun[],
  layout: TextLayoutLike,
  width: number,
  rest = true,
  last = false,
  skip?: ReadonlySet<number>,
): TextRun[] | null {
  const text = runs.map((run) => run.text).join('');
  // each space's extra, by its offset in the paragraph
  const extra = new Map<number, number>();
  const lines = layout.lines;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let end = line.end;
    // the paragraph's last line, or one a forced break ends, is
    // `text-align-last`'s to justify
    const ends =
      i === lines.length - 1 || text[end - 1] === '\n' || text[end] === '\n';
    if (!(ends ? last : rest)) continue;
    while (
      end > line.start &&
      (text[end - 1] === ' ' ||
        text[end - 1] === '\u00a0' ||
        !!skip?.has(end - 1))
    )
      end -= 1;
    const spaces: number[] = [];
    for (let at = line.start; at < end; at += 1) {
      if ((text[at] === ' ' || text[at] === '\u00a0') && !skip?.has(at)) {
        spaces.push(at);
      }
    }
    // a hair short, so that the engine breaks where it did
    const slack = width - line.width - 0.01;
    if (!spaces.length || !(slack > 0)) continue;
    for (const at of spaces) extra.set(at, slack / spaces.length);
  }
  return extra.size ? widenedAt(runs, extra) : null;
}

/** The runs with the character at each offset of `extra` a run of its
 *  own, spaced that much more. */
function widenedAt(runs: TextRun[], extra: Map<number, number>): TextRun[] {
  const text = runs.map((run) => run.text).join('');
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
        kernAcross: true,
      });
      piece = at + 1;
    }
    if (end > piece) out.push({ ...run, text: text.slice(piece, end) });
    from = end;
  }
  return out;
}

/** A word separator, as justification spaces them out (CSS Text 3, 7.4):
 *  a space, or a no-break one. */
function isSeparator(code: number): boolean {
  return code === 0x20 || code === 0xa0;
}

/** What `finishLine` lays a justified line's text out again with. */
interface LineJustify {
  fonts: FontsLike;
  base: Record<string, unknown>;
  options: Parameters<FontsLike['layout']>[2];
}

/**
 * A line made a piece at a time — beside a float, around an inline-block,
 * between an inline box's edges — justified where it is (CSS Text 3, 7.4):
 * the room it leaves, `free`, shared out equally among its word
 * separators, as `justifiedRuns` shares out a paragraph's. A space inside a
 * piece of text takes its share as letter spacing, the piece laid out again
 * with it; a space a piece ends on, with something after it on the line,
 * takes it as room before what follows. The spaces the line ends on hang
 * (7.3), whatever inline box closes after them, and take none. Whatever
 * follows a share on the line moves over by it. How much wider the line
 * is.
 */
function justifyLine(open: OpenLine, free: number, how: LineJustify): number {
  const order = open.order;
  let lastContent = -1;
  for (let i = order.length - 1; i >= 0; i -= 1) {
    if (order[i].kind !== 'edge') {
      lastContent = i;
      break;
    }
  }
  const plans = new Map<
    LineText,
    { runs: TextRun[]; inside: number[]; after: number }
  >();
  let count = 0;
  for (let i = 0; i < order.length; i += 1) {
    const placed = order[i];
    if (placed.kind !== 'text') continue;
    const text = placed.item;
    // the runs it was laid out from, where they are still what is kept
    // (a selection keeps its offsets in their place)
    const kept = LAYOUT_RUNS.get(text.layout);
    const runs =
      kept?.length && typeof kept[0] !== 'number' ? (kept as TextRun[]) : null;
    const line = text.layout.lines[text.layoutLine];
    if (!runs || !line) continue;
    const all = runs.map((run) => run.text).join('');
    let end = line.end;
    while (end > line.start && isSeparator(all.charCodeAt(end - 1))) end -= 1;
    const inside: number[] = [];
    for (let at = line.start; at < end; at += 1) {
      if (isSeparator(all.charCodeAt(at))) inside.push(at);
    }
    // the spaces it ends on, before what follows it on the line
    let after = 0;
    if (i < lastContent) {
      for (let at = end; at < all.length; at += 1) {
        if (!isSeparator(all.charCodeAt(at))) break;
        after += 1;
      }
    }
    count += inside.length + after;
    plans.set(text, { runs, inside, after });
  }
  if (!count) return 0;
  const share = free / count;
  let moved = 0;
  for (const placed of order) {
    if (placed.kind !== 'text') {
      placed.item.x += moved;
      continue;
    }
    const text = placed.item;
    text.drawX += moved;
    const plan = plans.get(text);
    if (!plan) continue;
    if (plan.inside.length) {
      const line = text.layout.lines[text.layoutLine];
      const widened = widenedAt(
        plan.runs,
        new Map(plan.inside.map((at) => [at, share])),
      );
      // as wide as the piece is to be, and the piece alone: the text after
      // it did not fit beside it before it was any wider
      const layout = how.fonts.layout(widened, how.base, {
        ...how.options,
        maxWidth: line.width + plan.inside.length * share + 0.5,
        maxLines: 1,
      });
      const first = layout.lines[0];
      if (first && first.start === line.start && first.end === line.end) {
        LAYOUT_RUNS.set(layout, widened);
        text.layout = layout;
        text.layoutLine = 0;
        moved += first.width - line.width;
      }
    }
    moved += plan.after * share;
  }
  return moved;
}

/** Which of a paragraph's lines are justified (CSS Text 3, 7.4): those
 *  its end or a forced break does not end, where `text-align` is
 *  `justify`, and those it does, where `text-align-last` is — neither
 *  where the text does not wrap, nor under `text-justify: none`. */
function justification(style: ComputedStyle): { rest: boolean; last: boolean } {
  const on = wraps(style) && style.textJustify !== 'none';
  return {
    rest: on && style.textAlign === 'justify',
    last: on && lastAlignOf(style) === 'justify',
  };
}

/**
 * A layout of `runs` whose justified lines fill `width`: measured as it
 * will be drawn, its spaces spaced apart (`HAIR`), then laid out again with
 * each space inside a justified line widened by its share
 * (`justifiedRuns`), which keeps the lines where they broke. The layout
 * that is given where no line is to be justified. Every path that lays a
 * paragraph out as one layout justifies through this, so that a paragraph
 * is justified whichever it took.
 */
function justifiedLayout(
  fonts: FontsLike,
  runs: TextRun[],
  base: Record<string, unknown>,
  options: Parameters<FontsLike['layout']>[2],
  layout: TextLayoutLike,
  width: number,
  { rest, last }: { rest: boolean; last: boolean },
  skip?: ReadonlySet<number>,
): { layout: TextLayoutLike; runs: TextRun[] } {
  if (
    !Number.isFinite(width) ||
    !((rest && layout.lines.length > 1) || (last && layout.lines.length > 0))
  ) {
    return { layout, runs };
  }
  const spaced = spacedApart(runs);
  const measured = fonts.layout(spaced, base, options);
  const justified = justifiedRuns(spaced, measured, width, rest, last, skip);
  const out = justified ? fonts.layout(justified, base, options) : measured;
  const outRuns = justified ?? spaced;
  LAYOUT_RUNS.set(out, outRuns);
  return { layout: out, runs: outRuns };
}

/** An alignment as the text engine takes it. It has no justification:
 *  `start` is closer than a silent left on an RTL paragraph, and closer
 *  than a ragged-right lie about what was drawn — justified lines are
 *  spaced to fill their width before they get here (`justifiedRuns`). */
function engineAlign(
  align: ComputedStyle['textAlign'] | ComputedStyle['textAlignLast'],
): string {
  return align === 'justify' || align === 'auto' ? 'start' : align;
}

/** How the lines the text or a forced break ends are aligned (CSS Text 3,
 *  7.2): `text-align-last`, or where that is `auto`, `text-align`, but
 *  `justify`'s, which leaves them at the start. */
function lastAlignOf(
  style: ComputedStyle,
): Exclude<ComputedStyle['textAlignLast'], 'auto'> {
  const last = style.textAlignLast;
  if (last !== 'auto') return last;
  return style.textAlign === 'justify' ? 'start' : style.textAlign;
}

/**
 * The `text-indent` a block's first line takes: none where that line is
 * not its element's first formatted line (CSS 2.1 16.1). An anonymous
 * block's is only where the block is its parent's first child: the text
 * after a `<div>` in a `<span>`, or after a paragraph in a `<div>`, starts
 * a line of no indent.
 */
function blockIndent(block: Box, width: number): number {
  if (!block.el && block.parent && block.parent.children[0] !== block) {
    return 0;
  }
  return indentOf(block.style, width);
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
 * the leading its `line-height` adds shared above and below as
 * `ascentOnLine` shares it (CSS 2.1 10.8.1).
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
  const ascent = ascentOnLine(face.ascent, face.descent, target);
  return { ascent, descent: target - ascent };
}

/**
 * How far above its baseline an inline box's room on a line reaches: its
 * face's ascent and half its leading (CSS 2.1 10.8.1, CSS Inline 3 5.3),
 * rounded down to a whole pixel, the rest of the leading going below.
 *
 * The spec's halves are exact, and where one is not a whole pixel which
 * side of the grid the text lands on is the user agent's. Blink rounds the
 * half above down (`CalculateLeadingSpace`, core/layout/inline/
 * line_utils.cc): a 13px Arial on an 18px line has 1px of leading over its
 * 15 and 2px under. Split evenly, that box reached half a pixel above the
 * 12px strut beside it, whose 4px of leading divides, and every such line
 * came out 18.5px tall.
 */
export function ascentOnLine(
  ascent: number,
  descent: number,
  height: number,
): number {
  return ascent + Math.floor((height - ascent - descent) / 2 + 1e-6);
}

/**
 * How far above its baseline a text engine's line reaches, its leading
 * shared as `ascentOnLine` shares it. The engines split it evenly (the
 * contract every text engine owes, a baseline `(height - ascent -
 * descent) / 2 + ascent` down), so a line on its own sits up to a pixel
 * lower than a browser's; one that did not say how tall its face is keeps
 * the engine's.
 */
function lineAscent(natural: TextLayoutLike['lines'][number]): number {
  const { ascent, descent } = natural;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) {
    return natural.baseline - natural.y;
  }
  return ascentOnLine(ascent, descent, natural.height);
}

/**
 * How far up a layout drawn whole moves for each of its lines' baselines
 * to be where `lineAscent` puts it. A layout is drawn in one batch, from
 * one origin, so it moves by one amount or not at all: where its lines
 * would move by different amounts — a face of other metrics on one — it
 * keeps the engine's baselines, which are less than a pixel out.
 */
function layoutLift(layout: TextLayoutLike): number {
  let lift = NaN;
  for (const natural of layout.lines) {
    const own = natural.baseline - natural.y - lineAscent(natural);
    if (Number.isNaN(lift)) lift = own;
    else if (Math.abs(own - lift) > 1e-6) return 0;
  }
  return Number.isNaN(lift) ? 0 : lift;
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
    /** A box's style on the lines these are for: its own, or the one it
     *  has on a first line (`firstLineSetting`). */
    private readonly styleOf: (box: Box) => ComputedStyle = ownStyle,
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
    const own = { ...strutOf(this.fonts, this.styleOf(owner)) };
    // and of the inline boxes around it, each about its own baseline: each
    // is on the line with its line height, which the text's may not reach.
    // Not only where one sets a line height of its own: a raised `<sup>`
    // holding a smaller `<a>` — every footnote mark — is as tall on the
    // line as its own font and line height make it (CSS 2.1 10.8)
    if (lead || raise) {
      for (let at: Box | null = parent; at?.kind === 'inline'; at = at.parent) {
        const box = this._box(at);
        const room = strutOf(this.fonts, this.styleOf(at));
        own.ascent = Math.max(own.ascent, room.ascent + box.raise - raise);
        own.descent = Math.max(own.descent, room.descent - box.raise + raise);
        if (box.edge === at) break;
      }
    }
    const natural = text.layout.lines[text.layoutLine];
    let seen = this.styleOf(owner);
    for (const run of natural?.runs ?? []) {
      const at = text.spans.boxAt?.(run.start);
      const style = at && this.styleOf(at);
      if (!style || style === seen) continue;
      seen = style;
      const room = strutOf(this.fonts, style);
      own.ascent = Math.max(own.ascent, room.ascent);
      own.descent = Math.max(own.descent, room.descent);
    }
    let to: Lift['edge'] = null;
    if (edge) {
      const room = strutOf(this.fonts, this.styleOf(edge));
      to = {
        box: edge,
        to: this.styleOf(edge).verticalAlign === 'top' ? 'top' : 'bottom',
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
    const { raise, edge, lead } = this._box(box);
    if (edge) return null;
    if (!raise && !lead && !tallerStrut(this.fonts, this.block, box)) {
      return null;
    }
    const room = strutOf(this.fonts, this.styleOf(box));
    return { raise, ascent: room.ascent, descent: room.descent };
  }

  /** The `top` or `bottom` box a box is in, itself included, and how far
   *  its baseline is raised from that box's; null outside one. */
  edgeOf(box: Box): { edge: Box; raise: number } | null {
    const lift = this._box(box);
    return lift.edge ? { edge: lift.edge, raise: lift.raise } : null;
  }

  private _box(box: Box): { raise: number; edge: Box | null; lead: boolean } {
    if (box.kind !== 'inline' || !box.parent) return NO_LIFT;
    const known = this._boxes.get(box);
    if (known) return known;
    const va = this.styleOf(box).verticalAlign;
    const own = ownsLeading(this.fonts, this.block, this.styleOf(box));
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
    const va = this.styleOf(box).verticalAlign;
    const size = this.styleOf(parent).fontSize;
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
          faceExtent(this.fonts, this.styleOf(parent)).ascent -
          strutOf(this.fonts, this.styleOf(box)).ascent
        );
      case 'text-bottom':
        return (
          strutOf(this.fonts, this.styleOf(box)).descent -
          faceExtent(this.fonts, this.styleOf(parent)).descent
        );
      case 'middle': {
        const own = strutOf(this.fonts, this.styleOf(box));
        return (
          xHeightOf(this.fonts, this.styleOf(parent)) / 2 -
          (own.ascent - own.descent) / 2
        );
      }
      default:
        return typeof va === 'number'
          ? va
          : resolve(va, lineHeightOf(this.fonts, this.styleOf(box)));
    }
  }
}

const ownStyle = (box: Box): ComputedStyle => box.style;

const NO_LIFT = { raise: 0, edge: null, lead: false };

/**
 * Whether an inline box's own line height sets its line otherwise than the
 * one a paragraph's layout gives its text. That layout sets every run at
 * the block's line height, as a multiple of the run's font's natural one;
 * CSS gives each inline box its own, and the line box holds them all (CSS
 * 2.1 10.8.1). So a box whose own is more makes its line taller, and a box
 * whose own is less makes it shorter than the multiple does, where the
 * multiple is more than the block's line height too: a larger face under
 * a `line-height` length, which every inline box inherits as that length —
 * `font: 11px/15px` on the body and a 14px heading run inline, which the
 * multiple set 19px tall on a line CSS makes 16.5. One whose own is less
 * but which the block's line height holds anyway, a `<code>` in a font
 * with taller natural lines, is left to the one layout: its lines come out
 * the same, and the line at a time costs a long document dear.
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
  // the block's own face is past at once. A bold or an italic one is not:
  // a paragraph is thick with <strong>, <em> and <a>, and most families'
  // faces share their line metrics, but not every one's — Helvetica Neue
  // Bold reaches 0.975em above its baseline to the regular's 0.952, and
  // Blink, which rounds each to a whole pixel, sets a 12px bold word on a
  // 19.2px line a pixel taller. It is measured once for its style, below.
  if (
    style.lineHeight === block.lineHeight &&
    style.lineHeightIsLength === block.lineHeightIsLength &&
    style.fontSize === block.fontSize &&
    style.fontFamily === block.fontFamily &&
    style.fontWeight === block.fontWeight &&
    style.fontStyle === block.fontStyle
  ) {
    return false;
  }
  const known = LEADS.get(style);
  if (known && known.block === block && known.fonts === fonts) {
    return known.own;
  }
  const multiple =
    lineHeightMultiplier(fonts, block) * naturalLineHeight(fonts, style);
  const height = lineHeightOf(fonts, style);
  const own =
    height > multiple + 0.5 ||
    multiple > Math.max(height, lineHeightOf(fonts, block)) + 0.5;
  LEADS.set(style, { fonts, block, own });
  return own;
}

/** Whether a text is in an inline box that owns its leading
 *  (`ownsLeading`), below the block it is laid out in. */
function inBoxOwningLeading(fonts: FontsLike, block: Box, text: Box): boolean {
  for (let at = text.parent; at && at !== block; at = at.parent) {
    if (at.kind !== 'inline') break;
    if (ownsLeading(fonts, block.style, at.style)) return true;
  }
  return false;
}

const LEADS = new WeakMap<
  ComputedStyle,
  { fonts: FontsLike; block: ComputedStyle; own: boolean }
>();

/**
 * Whether an inline box with no text is taller on its line than the
 * paragraph's own line height: what it holds there, which the engine,
 * which lays out text, gives no room (CSS 2.1 10.8). A box with text is
 * given its face's room with the text, at the paragraph's leading, which
 * `ownsLeading` compares its own line height with; asked of one with none,
 * the border of an empty `<span>` in a large face was drawn over the text
 * above its line, which was as short as the paragraph's. Not asked of a
 * box with text, which the one-layout paths lay out whole: a padded
 * `<code>` in a paragraph would have been laid out a line at a time.
 */
function tallerStrut(
  fonts: FontsLike,
  block: ComputedStyle,
  box: Box,
): boolean {
  if (box.subtreeTextEnd > box.subtreeTextStart) return false;
  const style = box.style;
  if (
    style.fontSize === block.fontSize &&
    style.lineHeight === block.lineHeight
  ) {
    return false;
  }
  const own = strutOf(fonts, style);
  const theirs = strutOf(fonts, block);
  return own.ascent + own.descent > theirs.ascent + theirs.descent + 0.5;
}

/** A style's line height in pixels. */
function lineHeightOf(fonts: FontsLike, style: ComputedStyle): number {
  if (style.lineHeight === 'normal') return naturalLineHeight(fonts, style);
  return style.lineHeightIsLength
    ? (style.lineHeight as number)
    : (style.lineHeight as number) * style.fontSize;
}

/**
 * A style's x-height, where its font says, or half its size, as `ex` takes
 * it (CSS 2.1 4.3.2). A face whose OS/2 table is older than version 2 —
 * DejaVu's — states none, and the engine's answer is then NaN, which is a
 * number: taken for one, it put an image set `middle` nowhere at all.
 */
function xHeightOf(fonts: FontsLike, style: ComputedStyle): number {
  try {
    const metrics = fonts
      .match(style.fontFamily, {
        size: style.fontSize,
        weight: style.fontWeight,
        style: style.fontStyle,
      })
      .metrics(style.fontSize) as { xHeight?: number | null };
    const x = metrics.xHeight;
    if (typeof x === 'number' && x > 0) return x;
  } catch {
    // no font to ask
  }
  return style.fontSize / 2;
}

/** Whether a line has nothing on it yet. */
function isEmpty(open: {
  x: number;
  indent: number;
  texts: unknown[];
  atomics: unknown[];
}) {
  return open.x === open.indent && !open.texts.length && !open.atomics.length;
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
 * room — a line's width leaves out the white space it ends on, which hangs,
 * so this is the word, kept whole where `overflow-wrap` says so — or it
 * ends inside a word — between two letters or digits, where no break is
 * allowed, so only a line too narrow for the word put one there. Ideographs
 * and kana break between any two, and are not counted as a word's letters.
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
  return width > room + FIT_SLACK && before !== '';
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
