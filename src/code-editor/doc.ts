// Pure text-model helpers for the editor node: position ordering, word
// boundaries, and the tab display mapping. No react-x11 imports — this file
// is the part of the editor that is trivially unit-testable.
import type { Position } from './types.js';

export function comparePos(a: Position, b: Position): number {
  return a.line - b.line || a.ch - b.ch;
}

export function posEqual(a: Position, b: Position): boolean {
  return a.line === b.line && a.ch === b.ch;
}

export function minPos(a: Position, b: Position): Position {
  return comparePos(a, b) <= 0 ? a : b;
}

export function maxPos(a: Position, b: Position): Position {
  return comparePos(a, b) >= 0 ? a : b;
}

/** Clamp into the document, then onto a code-point boundary — a caret must
 * never land between the halves of a surrogate pair. */
export function clampPos(lines: readonly string[], pos: Position): Position {
  const line = Math.max(0, Math.min(pos.line, lines.length - 1));
  const text = lines[line];
  let ch = Math.max(0, Math.min(pos.ch, text.length));
  if (ch > 0 && ch < text.length) {
    const code = text.charCodeAt(ch);
    if (code >= 0xdc00 && code <= 0xdfff) ch--; // low surrogate: step off it
  }
  return { line, ch };
}

/** One caret step left/right, crossing line boundaries, surrogate-safe. */
export function movePos(
  lines: readonly string[],
  pos: Position,
  dir: -1 | 1,
): Position {
  const text = lines[pos.line];
  if (dir > 0) {
    if (pos.ch >= text.length) {
      return pos.line + 1 < lines.length ? { line: pos.line + 1, ch: 0 } : pos;
    }
    const code = text.codePointAt(pos.ch)!;
    return { line: pos.line, ch: pos.ch + (code > 0xffff ? 2 : 1) };
  }
  if (pos.ch <= 0) {
    return pos.line > 0
      ? { line: pos.line - 1, ch: lines[pos.line - 1].length }
      : pos;
  }
  const prev = text.charCodeAt(pos.ch - 1);
  const wide = prev >= 0xdc00 && prev <= 0xdfff && pos.ch >= 2 ? 2 : 1; // low surrogate
  return { line: pos.line, ch: pos.ch - wide };
}

const BASE_WORD = /[\p{L}\p{N}_]/u;

export function isWordChar(ch: string, extra: string): boolean {
  return BASE_WORD.test(ch) || (extra.length > 0 && extra.includes(ch));
}

/**
 * Where Ctrl+arrow lands: skip any run of non-word characters, then the
 * word — the same rule core's `<textinput>` uses. Within one line; at the
 * line's edge it steps to the neighbouring line first, which is how every
 * editor treats Ctrl+arrow at a boundary.
 */
export function wordBoundary(
  lines: readonly string[],
  pos: Position,
  dir: -1 | 1,
  extra = '',
): Position {
  const text = lines[pos.line];
  if (dir > 0 && pos.ch >= text.length) return movePos(lines, pos, 1);
  if (dir < 0 && pos.ch <= 0) return movePos(lines, pos, -1);
  let i = pos.ch;
  if (dir > 0) {
    while (i < text.length && !isWordChar(text.charAt(i), extra)) i++;
    while (i < text.length && isWordChar(text.charAt(i), extra)) i++;
  } else {
    while (i > 0 && !isWordChar(text.charAt(i - 1), extra)) i--;
    while (i > 0 && isWordChar(text.charAt(i - 1), extra)) i--;
  }
  return { line: pos.line, ch: i };
}

/** The word range around a position — double-click selection. */
export function wordRangeAt(
  line: string,
  ch: number,
  extra = '',
): { from: number; to: number } {
  if (line.length === 0) return { from: 0, to: 0 };
  let i = Math.min(ch, line.length - 1);
  if (!isWordChar(line.charAt(i), extra) && i > 0) i--;
  if (!isWordChar(line.charAt(i), extra)) return { from: ch, to: ch };
  let from = i;
  let to = i + 1;
  while (from > 0 && isWordChar(line.charAt(from - 1), extra)) from--;
  while (to < line.length && isWordChar(line.charAt(to), extra)) to++;
  return { from, to };
}

// --- tabs ------------------------------------------------------------------
//
// ntk's text stack shapes what fonts have glyphs for, and U+0009 is not
// that. So a line is *displayed* through an expansion — each tab becomes the
// spaces to the next tab stop — and everything visual (layout, caret x, hit
// testing, token spans) works in display indices, while the model keeps the
// raw text. The two mapping functions below are total and monotonic; they
// are the only bridge, so getting them right once is the whole game.

export interface TabMap {
  display: string;
  /** Raw UTF-16 index → display UTF-16 index. */
  toDisplay(rawCh: number): number;
  /** Display UTF-16 index → raw UTF-16 index (inside an expanded tab snaps
   * to the tab itself). */
  toRaw(displayCh: number): number;
}

const NO_TABS: Omit<TabMap, 'display'> = {
  toDisplay: (ch) => ch,
  toRaw: (ch) => ch,
};

/** Expand tabs to `tabSize` stops and hand back the index mappings. Lines
 * without tabs pay one `indexOf`. */
export function tabMap(raw: string, tabSize: number): TabMap {
  if (raw.indexOf('\t') === -1) {
    return { display: raw, ...NO_TABS };
  }
  let display = '';
  // rawStarts[i] = raw index of segment i; dispStarts[i] = its display index
  const rawStarts: number[] = [];
  const dispStarts: number[] = [];
  let rawIndex = 0;
  for (;;) {
    const tab = raw.indexOf('\t', rawIndex);
    const segment = tab === -1 ? raw.slice(rawIndex) : raw.slice(rawIndex, tab);
    rawStarts.push(rawIndex);
    dispStarts.push(display.length);
    display += segment;
    if (tab === -1) break;
    const pad = tabSize - (display.length % tabSize);
    display += ' '.repeat(pad);
    rawIndex = tab + 1;
  }
  const segments = rawStarts.length;
  return {
    display,
    toDisplay(rawCh) {
      let seg = segments - 1;
      for (let i = 1; i < segments; i++) {
        if (rawStarts[i] > rawCh) {
          seg = i - 1;
          break;
        }
      }
      const offset = rawCh - rawStarts[seg];
      const segLen =
        (seg + 1 < segments ? rawStarts[seg + 1] - 1 : raw.length) -
        rawStarts[seg];
      // `offset === segLen` is the tab character itself; its caret sits
      // where the padding starts. Larger offsets cannot occur — the next
      // segment starts one past the tab.
      return dispStarts[seg] + Math.min(offset, segLen);
    },
    toRaw(displayCh) {
      let seg = segments - 1;
      for (let i = 1; i < segments; i++) {
        if (dispStarts[i] > displayCh) {
          seg = i - 1;
          break;
        }
      }
      const offset = displayCh - dispStarts[seg];
      const segLen =
        (seg + 1 < segments ? rawStarts[seg + 1] - 1 : raw.length) -
        rawStarts[seg];
      if (offset > segLen) {
        // inside the expanded tab: nearer edge wins, like a wide glyph
        const padEnd =
          seg + 1 < segments ? dispStarts[seg + 1] : display.length;
        const mid =
          dispStarts[seg] + segLen + (padEnd - dispStarts[seg] - segLen) / 2;
        return displayCh < mid
          ? rawStarts[seg] + segLen
          : rawStarts[seg] + segLen + 1;
      }
      return rawStarts[seg] + offset;
    },
  };
}
