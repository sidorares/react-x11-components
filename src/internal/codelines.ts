// Code drawn as a column of blocks of lines, under `<Code>` and
// `<Markdown>`'s fences.
//
// One `<richtext>` for a whole block of code is laid out whole whenever any
// of it changes, and a code block that streams — a model writing a fence a
// token at a time, a log of source — changes at its end every time: 0.4 s
// for a line appended to 5,000 in either component. As blocks, a change
// lays out the blocks it touches. The runs are tokenized afresh on every
// change, so a block is kept by what it holds rather than by identity: while
// its runs are the same text in the same styles, its element is the one
// already drawn.
import React from 'react';
import type { ReactElement } from 'react';
import type { Style } from 'react-x11/style';

import { RICHTEXT_ELEMENT } from '../richtext/index.js';
import type { RichTextProps, TextRun } from '../richtext/index.js';

const h = React.createElement;

/** Lines a block of code holds. */
export const CODE_BLOCK_LINES = 256;

/**
 * Runs split into blocks of `lines` whole lines: the text cut at every
 * `lines`th newline, that newline left out, so the blocks stacked are the
 * text again. A newline that ends the whole text stays in its block, where
 * it draws the empty last line it always drew.
 */
export function codeBlocks(
  runs: readonly TextRun[],
  lines = CODE_BLOCK_LINES,
): TextRun[][] {
  let last = runs.length - 1;
  while (last >= 0 && runs[last]!.text === '') last--;
  const blocks: TextRun[][] = [];
  let block: TextRun[] = [];
  let count = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]!;
    let from = 0;
    let search = 0;
    for (;;) {
      const nl = run.text.indexOf('\n', search);
      if (nl < 0) break;
      search = nl + 1;
      if (++count < lines) continue;
      // the text's own last newline is a line of its own, and stays
      if (r === last && nl === run.text.length - 1) break;
      if (nl > from) block.push(piece(run, from, nl));
      blocks.push(block);
      block = [];
      count = 0;
      from = nl + 1;
    }
    if (from < run.text.length) {
      block.push(from === 0 ? run : piece(run, from, run.text.length));
    }
  }
  blocks.push(block);
  return blocks;
}

function piece(run: TextRun, from: number, to: number): TextRun {
  return { ...run, text: run.text.slice(from, to) };
}

/** Whether two runs are the same text in the same style, field for field. */
function sameRun(a: TextRun, b: TextRun): boolean {
  if (a === b) return true;
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  for (const key in x) if (x[key] !== y[key]) return false;
  for (const key in y) if (!(key in x) && y[key] !== undefined) return false;
  return true;
}

function sameRuns(a: readonly TextRun[], b: readonly TextRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameRun(a[i]!, b[i]!)) return false;
  return true;
}

function sameStyle(a: Style, b: Style): boolean {
  return sameRun(a as unknown as TextRun, b as unknown as TextRun);
}

export interface CodeLinesProps {
  runs: readonly TextRun[];
  /** Every block's style, compared by value: a style object built afresh
   *  each render keeps the blocks. */
  style: Style;
  /** `false` lays each block out unwrapped, as `<richtext>` takes it. */
  wrap?: boolean;
}

/** The blocks' elements from the last render, and what they were built of. */
interface Kept {
  style: Style;
  wrap: boolean | undefined;
  blocks: TextRun[][];
  elements: ReactElement[];
}

/**
 * The runs of a block of code, drawn as blocks of lines (`codeBlocks`),
 * each a `<richtext>` kept while its runs are the same. A selection runs
 * across the blocks and copies as one text, since core joins text elements
 * stacked one above the other with a newline.
 */
export function CodeLines(props: CodeLinesProps): ReactElement {
  const { style, wrap } = props;
  const kept = React.useRef<Kept | null>(null);
  const was =
    kept.current &&
    kept.current.wrap === wrap &&
    sameStyle(kept.current.style, style)
      ? kept.current
      : null;
  const blocks = codeBlocks(props.runs);
  const elements = blocks.map((block, i) => {
    const before = was?.blocks[i];
    if (before && sameRuns(before, block)) {
      blocks[i] = before;
      return was.elements[i]!;
    }
    const blockProps: RichTextProps = { runs: block, style };
    if (wrap === false) blockProps.wrap = false;
    return h(RICHTEXT_ELEMENT, {
      key: i,
      ...blockProps,
    } as Record<string, unknown>);
  });
  kept.current = { style, wrap, blocks, elements };
  return h(React.Fragment, null, ...elements);
}

export interface CodeGutterProps {
  /** Lines in the code beside it. */
  lines: number;
  /** How a number is set: the code's family and size, a dimmer colour. */
  run: Omit<TextRun, 'text'>;
  style: Style;
}

/**
 * The line numbers beside `CodeLines`, blocked the same way so that the two
 * stay in register a block at a time, and a number not rebuilt for a line
 * appended far below it. Each number is followed by a newline, the last as
 * well, as the gutter always was.
 */
export function CodeGutter(props: CodeGutterProps): ReactElement {
  const { lines, run, style } = props;
  const kept = React.useRef<{
    run: Omit<TextRun, 'text'>;
    style: Style;
    byStart: Map<string, ReactElement>;
  } | null>(null);
  if (
    !kept.current ||
    !sameRun(kept.current.run as TextRun, run as TextRun) ||
    !sameStyle(kept.current.style, style)
  ) {
    kept.current = { run, style, byStart: new Map() };
  }
  const byStart = kept.current.byStart;
  const elements: ReactElement[] = [];
  const used = new Set<string>();
  for (let start = 0; start < lines || start === 0; start += CODE_BLOCK_LINES) {
    const end = Math.min(start + CODE_BLOCK_LINES, lines);
    const key = `${start}:${end}`;
    used.add(key);
    let element = byStart.get(key);
    if (!element) {
      const runs: TextRun[] = [];
      for (let i = start; i < end; i++) {
        runs.push({ ...run, text: `${i + 1}\n` } as TextRun);
      }
      // the newline that ends a block is the gap to the next one
      if (end < lines && runs.length > 0) {
        const tail = runs[runs.length - 1]!;
        runs[runs.length - 1] = { ...tail, text: tail.text.slice(0, -1) };
      }
      element = h(RICHTEXT_ELEMENT, {
        key: start,
        // The numbering is chrome, not text: `selectable={false}` keeps it
        // out of a drag and out of the copied text.
        selectable: false,
        runs,
        wrap: false,
        style,
      } as Record<string, unknown>);
      byStart.set(key, element);
    }
    elements.push(element);
    if (lines === 0) break;
  }
  for (const key of byStart.keys()) if (!used.has(key)) byStart.delete(key);
  return h(React.Fragment, null, ...elements);
}
