// A parsed capture, as `<richtext>` runs. Pure — no React, no theme lookup,
// no element — so what a span becomes is asserted directly.
//
// This is the second half of the "colour is intent, not pixels" split: the
// parser said "ANSI 2", `../ansi/palette.ts` said which pixels that is, and
// here it becomes a run the text layout can take.
import { resolveAnsiColors } from '../ansi/index.js';
import type { AnsiDocument, AnsiPalette, AnsiSpan } from '../ansi/index.js';
import type { TextRun } from '../richtext/index.js';

/** The font a capture is set in. The palette is separate because it changes
 *  for a different reason — a theme flip rather than a size prop. */
export interface OutputFont {
  family: string;
  size: number;
}

/**
 * One span as one run.
 *
 * `bgFill: 'line'` is the whole reason `../richtext/` grew the field: a
 * terminal's backgrounds have to abut exactly and fill the row, where an
 * inline-code chip is inset and padded. Adjacent runs with the chip fill
 * overlap by two pixels each side, which paints over the neighbour.
 */
export function spanRun(
  span: AnsiSpan,
  font: OutputFont,
  palette: AnsiPalette,
): TextRun {
  const { fg, bg } = resolveAnsiColors(span, palette);
  const run: TextRun = {
    text: span.text,
    family: font.family,
    size: font.size,
    color: fg,
  };
  if (bg !== undefined) {
    run.bg = bg;
    run.bgFill = 'line';
  }
  if (span.bold) run.weight = 'bold';
  if (span.italic) run.style = 'italic';
  if (span.underline) {
    run.underline = span.underlineColor
      ? resolveAnsiColors({ fg: span.underlineColor }, palette).fg
      : fg;
    run.underlineStyle = span.underline;
  }
  if (span.strike) run.strike = fg;
  if (span.href) run.href = span.href;
  return run;
}

/**
 * The whole document as runs, which concatenate to exactly its text.
 *
 * The newline between two lines is a run of its own rather than the tail of
 * the line before it: a line that ends in a coloured background would
 * otherwise paint that colour across the line break, which is a stripe the
 * terminal never drew.
 */
export function documentRuns(
  document: AnsiDocument,
  font: OutputFont,
  palette: AnsiPalette,
): TextRun[] {
  const runs: TextRun[] = [];
  const { lines } = document;
  for (let i = 0; i < lines.length; i++) {
    for (const span of lines[i]!.spans) {
      if (span.text) runs.push(spanRun(span, font, palette));
    }
    if (i < lines.length - 1) {
      runs.push({ text: '\n', family: font.family, size: font.size });
    }
  }
  return runs;
}
