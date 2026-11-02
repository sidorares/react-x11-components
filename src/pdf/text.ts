// A page's text as something a pointer can land on.
//
// PDFium hands over the characters in content order, each with a box. This
// finds the lines in them and answers the three questions selecting asks:
// which character is nearest a point, which bands a range fills, and where
// the word around a character ends. Pure, in points from the page's corner.
import type { PageText } from './engine.js';

export interface TextRow {
  /** Units of `text`, end exclusive. */
  start: number;
  end: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PageTextIndex {
  text: string;
  boxes: Float32Array;
  rows: TextRow[];
}

export interface PointRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const isBreak = (unit: number): boolean => unit === 0x0a || unit === 0x0d;

function hasBox(boxes: Float32Array, i: number): boolean {
  return (
    boxes[i * 4 + 2]! > boxes[i * 4]! || boxes[i * 4 + 3]! > boxes[i * 4 + 1]!
  );
}

export function indexPageText(page: PageText): PageTextIndex {
  const { text, boxes } = page;
  const rows: TextRow[] = [];
  let row: TextRow | null = null;
  for (let i = 0; i < text.length; i++) {
    if (isBreak(text.charCodeAt(i))) {
      row = null;
      continue;
    }
    if (!hasBox(boxes, i)) {
      if (row) row.end = i + 1;
      continue;
    }
    const left = boxes[i * 4]!;
    const top = boxes[i * 4 + 1]!;
    const right = boxes[i * 4 + 2]!;
    const bottom = boxes[i * 4 + 3]!;
    const middle = (top + bottom) / 2;
    // Content order is not reading order, so a line also ends where the next
    // character is not beside the last: a column, a table's next cell.
    if (row && (middle < row.top || middle > row.bottom || left < row.left)) {
      row = null;
    }
    if (!row) {
      row = { start: i, end: i + 1, left, top, right, bottom };
      rows.push(row);
      continue;
    }
    row.end = i + 1;
    row.left = Math.min(row.left, left);
    row.right = Math.max(row.right, right);
    row.top = Math.min(row.top, top);
    row.bottom = Math.max(row.bottom, bottom);
  }
  return { text, boxes, rows };
}

/** How far a point is from a rectangle, across and down, as one number. */
function reach(row: TextRow, x: number, y: number): number {
  const dx = x < row.left ? row.left - x : x > row.right ? x - row.right : 0;
  const dy = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0;
  // Down counts for more: beside a line is on it, and above it is not.
  return dx + dy * 8;
}

/**
 * The caret nearest a point: an index between two characters, so that a
 * press on the right half of a letter starts after it. -1 where the page has
 * no text.
 */
export function caretAt(index: PageTextIndex, x: number, y: number): number {
  let best: TextRow | null = null;
  let distance = Infinity;
  for (const row of index.rows) {
    const d = reach(row, x, y);
    if (d < distance) {
      distance = d;
      best = row;
    }
  }
  if (!best) return -1;
  const { boxes } = index;
  for (let i = best.start; i < best.end; i++) {
    if (!hasBox(boxes, i)) continue;
    const middle = (boxes[i * 4]! + boxes[i * 4 + 2]!) / 2;
    if (x < middle) return i;
  }
  return best.end;
}

/** Whether a point is on a line of the page's text. */
export function onText(index: PageTextIndex, x: number, y: number): boolean {
  for (const row of index.rows) {
    if (x >= row.left && x <= row.right && y >= row.top && y <= row.bottom) {
      return true;
    }
  }
  return false;
}

/** The band of each line `[start, end)` reaches. */
export function rangeBands(
  index: PageTextIndex,
  start: number,
  end: number,
): PointRect[] {
  const { boxes } = index;
  const out: PointRect[] = [];
  for (const row of index.rows) {
    if (row.end <= start || row.start >= end) continue;
    let left = Infinity;
    let right = -Infinity;
    for (let i = Math.max(row.start, start); i < Math.min(row.end, end); i++) {
      if (!hasBox(boxes, i)) continue;
      left = Math.min(left, boxes[i * 4]!);
      right = Math.max(right, boxes[i * 4 + 2]!);
    }
    if (right > left) {
      out.push({
        x: left,
        y: row.top,
        width: right - left,
        height: row.bottom - row.top,
      });
    }
  }
  return out;
}

const WORD = /[\p{L}\p{N}\p{M}_]/u;

/** The word around a character, or the character where it is none. */
export function wordAround(index: PageTextIndex, at: number): [number, number] {
  const { text } = index;
  if (at < 0 || at >= text.length) return [at, at];
  if (!WORD.test(text[at]!)) return [at, at + 1];
  let start = at;
  let end = at + 1;
  while (start > 0 && WORD.test(text[start - 1]!)) start--;
  while (end < text.length && WORD.test(text[end]!)) end++;
  return [start, end];
}

/** The line around a character. */
export function lineAround(index: PageTextIndex, at: number): [number, number] {
  for (const row of index.rows) {
    if (at >= row.start && at < row.end) return [row.start, row.end];
  }
  return [at, at];
}
