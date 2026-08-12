// What changed on screen, derived by diffing the emulator's buffer against a
// mirror of what the surface currently shows.
//
// The renderer deliberately never asks "what did that escape sequence touch?".
// Escape-level damage is fragile — one CSI can move the whole screen, and a
// palette change or a selection drag touches cells no sequence named — while
// a signature compare over the viewport is a few thousand integer compares
// (microseconds for a normal grid) and catches *everything*. It also makes
// "eventually correct" structural rather than a discipline: skip as many
// frames as you like, the next diff repairs the screen, because the mirror
// describes pixels rather than intentions.
//
// Pure: structural emulator types in, plain arrays out. No X, no node, no
// `@xterm/headless` import — so the whole model is asserted against synthetic
// grids in `test/terminal-vt.test.ts`.
import { resolveCell } from './colors.js';
import type { CellState, Palette, ResolvedCell } from './colors.js';
import type { XtermCell, XtermTerminal } from './xterm.js';

/** A run of cells to redraw, in grid coordinates. */
export interface DirtySpan {
  row: number;
  col: number;
  count: number;
}

/** The band the scroll fast path moves, in rows. */
export interface RowCopy {
  srcRow: number;
  dstRow: number;
  count: number;
}

export interface DiffResult {
  /** Issued before anything is drawn, or null when nothing survived. */
  copy: RowCopy | null;
  spans: DirtySpan[];
  /** Geometry or buffer changed under us: everything was marked dirty. */
  full: boolean;
}

/**
 * One frame's worth of resolved cells.
 *
 * Parallel typed arrays rather than objects: a 240×67 grid is 16k cells, and
 * the whole point of the diff is that touching all of them costs less than a
 * millisecond. `chars` is the one string array, and it is read only for cells
 * the diff already decided are dirty.
 */
export interface GridSnapshot {
  cols: number;
  rows: number;
  chars: string[];
  /** 1 normally, 2 for a wide glyph, 0 for the cell it covers. */
  width: Uint8Array;
  fg: Int32Array;
  bg: Int32Array;
  /** `DECO_*` and `VARIANT_*` from `./colors.ts`. */
  flags: Uint16Array;
  sig: Uint32Array;
  rowSig: Uint32Array;
  /** Buffer-absolute index of the row at the top of the viewport. */
  absTop: number;
  alt: boolean;
}

export function createSnapshot(cols: number, rows: number): GridSnapshot {
  const n = Math.max(1, cols * rows);
  return {
    cols,
    rows,
    chars: new Array<string>(n).fill(' '),
    width: new Uint8Array(n).fill(1),
    fg: new Int32Array(n),
    bg: new Int32Array(n),
    flags: new Uint16Array(n),
    sig: new Uint32Array(n),
    rowSig: new Uint32Array(Math.max(1, rows)),
    absTop: 0,
    alt: false,
  };
}

/** A selection, in buffer-absolute lines so scrollback keeps it. */
export interface SelectionRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** Where the cursor is and what it looks like this frame. */
export interface CursorState {
  col: number;
  /** Viewport row, or -1 when the cursor is scrolled out of view. */
  row: number;
  shape: 'block' | 'underline' | 'bar' | 'hollow' | 'none';
}

export interface ReadOptions {
  palette: Palette;
  selection: SelectionRange | null;
  cursor: CursorState;
  brightBold: boolean;
}

/** Whether an absolute line/column is inside the selection. */
export function inSelection(
  selection: SelectionRange | null,
  line: number,
  col: number,
): boolean {
  if (!selection) return false;
  const { startLine, startCol, endLine, endCol } = selection;
  if (line < startLine || line > endLine) return false;
  if (line === startLine && col < startCol) return false;
  if (line === endLine && col >= endCol) return false;
  return true;
}

/** Selection endpoints, ordered — a drag runs in either direction. */
export function orderSelection(
  anchorLine: number,
  anchorCol: number,
  headLine: number,
  headCol: number,
): SelectionRange {
  const backwards =
    headLine < anchorLine || (headLine === anchorLine && headCol < anchorCol);
  return backwards
    ? {
        startLine: headLine,
        startCol: headCol,
        endLine: anchorLine,
        endCol: anchorCol,
      }
    : {
        startLine: anchorLine,
        startCol: anchorCol,
        endLine: headLine,
        endCol: headCol,
      };
}

/** FNV-1a, 32 bits. Fast, well-mixed, and the arithmetic stays in int32. */
function mixIn(hash: number, value: number): number {
  let h = (hash ^ (value & 0xffff)) >>> 0;
  h = Math.imul(h, 0x01000193) >>> 0;
  h = (h ^ ((value >>> 16) & 0xffff)) >>> 0;
  return Math.imul(h, 0x01000193) >>> 0;
}

const FNV_OFFSET = 0x811c9dc5;

/** Distinct numbers rather than the shape names: two of them start with the
 *  same letter, and a signature that cannot tell a bar from a block is a
 *  cursor that does not repaint when the style prop changes. */
const CURSOR_SHAPE_ID: Record<CursorState['shape'], number> = {
  none: 0,
  block: 1,
  underline: 2,
  bar: 3,
  hollow: 4,
};

const scratch: ResolvedCell = { fg: 0, bg: 0, flags: 0 };
const cellState: CellState = {
  selected: false,
  cursor: 'none',
  brightBold: true,
};

/**
 * Read the viewport into `out`, resolving every cell to its two paint colours
 * and its signature.
 *
 * The signature is where selection, cursor position, cursor phase and the
 * palette generation enter the model: they are inputs to the hash, so a
 * selection drag or a theme flip repaints exactly the cells whose *pixels*
 * differ, through the same one mechanism as a program writing text. There is
 * no second damage path anywhere in this component.
 */
export function readViewport(
  term: XtermTerminal,
  out: GridSnapshot,
  options: ReadOptions,
  work?: XtermCell,
): GridSnapshot {
  const buffer = term.buffer.active;
  const { cols, rows } = out;
  const cell = work ?? buffer.getNullCell();
  const { palette, selection, cursor } = options;
  cellState.brightBold = options.brightBold;

  out.absTop = buffer.viewportY;
  out.alt = buffer.type === 'alternate';

  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    const absLine = buffer.viewportY + row;
    // The row hash mixes only its cells. Nothing extra — an input that is
    // *not* visible in a cell (a palette counter, a frame number) would make
    // every row differ every frame, and the scroll detector below reads these
    // signatures to find the band that survived a shift.
    let rowHash = FNV_OFFSET;
    const base = row * cols;
    for (let col = 0; col < cols; col++) {
      const index = base + col;
      const got = line?.getCell(col, cell);
      let chars = ' ';
      let width = 1;
      if (got) {
        chars = got.getChars() || ' ';
        width = got.getWidth();
      }
      cellState.selected = inSelection(selection, absLine, col);
      cellState.cursor =
        cursor.row === row && cursor.col === col ? cursor.shape : 'none';
      if (got) {
        resolveCell(got, palette, cellState, scratch);
      } else {
        // Past the end of a short line, or a line the buffer has trimmed:
        // blank in the default colours, which is what the screen shows.
        scratch.fg = palette.foreground;
        scratch.bg = palette.background;
        scratch.flags = 0;
        if (cellState.selected) {
          scratch.bg = palette.selectionBackground;
          scratch.fg = palette.selectionForeground;
        }
        if (cellState.cursor === 'block') {
          scratch.bg = palette.cursor;
          scratch.fg = palette.cursorText;
        }
      }

      out.chars[index] = chars;
      out.width[index] = width;
      out.fg[index] = scratch.fg;
      out.bg[index] = scratch.bg;
      out.flags[index] = scratch.flags;

      let hash = mixIn(FNV_OFFSET, scratch.fg);
      hash = mixIn(hash, scratch.bg);
      hash = mixIn(hash, scratch.flags | (width << 8));
      for (let i = 0; i < chars.length; i++) {
        hash = mixIn(hash, chars.charCodeAt(i));
      }
      // The cursor shape is not a colour, so it has to enter the signature on
      // its own — a bar becoming an underline changes pixels and nothing else.
      if (cellState.cursor !== 'none') {
        hash = mixIn(hash, CURSOR_SHAPE_ID[cellState.cursor] << 24);
      }
      out.sig[index] = hash;
      rowHash = mixIn(rowHash, hash);
    }
    out.rowSig[row] = rowHash;
  }
  return out;
}

/**
 * What the surface currently shows, as signatures.
 *
 * Only hashes: the mirror never holds text or colours, because the only
 * question it answers is "does this cell still look like what I drew".
 */
export class Mirror {
  cols = 0;
  rows = 0;
  absTop = 0;
  alt = false;
  /** No frame has been drawn yet, so nothing on the surface is trustworthy. */
  private _valid = false;
  private _sig = new Uint32Array(0);
  private _rowSig = new Uint32Array(0);
  private _force = new Uint8Array(0);

  /** Forget everything: a resize, a font change, a renderer swap. */
  invalidate(): void {
    this._valid = false;
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this._sig = new Uint32Array(Math.max(1, cols * rows));
    this._rowSig = new Uint32Array(Math.max(1, rows));
    this._force = new Uint8Array(Math.max(1, rows));
    this._valid = false;
  }

  /**
   * Diff a snapshot against the mirror and adopt it.
   *
   * The mirror is updated to describe what the caller is *about* to draw, so
   * a caller that does not draw the result has to `invalidate()`.
   */
  diff(snapshot: GridSnapshot): DiffResult {
    const { cols, rows } = snapshot;
    if (cols !== this.cols || rows !== this.rows) this.resize(cols, rows);

    const spans: DirtySpan[] = [];
    const full =
      !this._valid || snapshot.alt !== this.alt || cols === 0 || rows === 0;

    let copy: RowCopy | null = null;
    this._force.fill(full ? 1 : 0);

    if (!full) {
      const shift = detectShift(this, snapshot);
      if (shift !== 0) {
        copy = shiftMirror(this, shift, cols, rows);
      }
    }

    for (let row = 0; row < rows; row++) {
      const base = row * cols;
      if (!this._force[row] && this._rowSig[row] === snapshot.rowSig[row]) {
        continue;
      }
      this._rowSig[row] = snapshot.rowSig[row];
      if (this._force[row]) {
        // Nothing is known about this row's pixels — a fresh mirror, or the
        // strip a scroll exposed. One span, no per-cell comparison.
        for (let col = 0; col < cols; col++) {
          this._sig[base + col] = snapshot.sig[base + col];
        }
        if (cols > 0) spans.push({ row, col: 0, count: cols });
        continue;
      }
      // Collect runs of changed cells, bridging gaps of up to two unchanged
      // cells: three draw calls for `a_b_c` cost more than one for `a_b_c`.
      let start = -1;
      let clean = 0;
      for (let col = 0; col < cols; col++) {
        const index = base + col;
        const changed = this._sig[index] !== snapshot.sig[index];
        if (changed) {
          this._sig[index] = snapshot.sig[index];
          if (start < 0) start = col;
          clean = 0;
        } else if (start >= 0) {
          clean++;
          if (clean > 2) {
            spans.push({ row, col: start, count: col - clean - start + 1 });
            start = -1;
            clean = 0;
          }
        }
      }
      if (start >= 0)
        spans.push({ row, col: start, count: cols - clean - start });
    }

    this.absTop = snapshot.absTop;
    this.alt = snapshot.alt;
    this._valid = true;
    return { copy, spans, full };
  }

  /** For the shift search and the row shuffle — not part of the contract. */
  rowSignature(row: number): number {
    return this._rowSig[row];
  }

  /** @internal */
  _internals(): {
    sig: Uint32Array;
    rowSig: Uint32Array;
    force: Uint8Array;
  } {
    return { sig: this._sig, rowSig: this._rowSig, force: this._force };
  }
}

/**
 * How far the screen moved, in rows. Positive means content moved *up* — the
 * shell scrolled, or the user paged down.
 *
 * The buffer's own `viewportY` is the first guess and is exact while the
 * scrollback is still filling. Once it saturates, lines are trimmed off the
 * top and `viewportY` stops moving although the screen very much does — so
 * the fallback is a search over the mirror's row signatures.
 *
 * A wrong guess cannot corrupt anything. The mirror is shifted by exactly the
 * amount the pixels were, so any row that does not then match its snapshot
 * signature is repainted; a bad guess costs one CopyArea and some redraw, and
 * that is the whole exposure.
 */
function detectShift(mirror: Mirror, snapshot: GridSnapshot): number {
  const { rows, cols } = snapshot;
  if (rows < 2 || cols === 0) return 0;

  let differing = 0;
  for (let row = 0; row < rows; row++) {
    if (mirror.rowSignature(row) !== snapshot.rowSig[row]) differing++;
    if (differing > 2) break;
  }
  // Typing, a spinner, a cursor blink: nothing moved, and the search is the
  // most expensive thing that would happen this frame if we let it run.
  if (differing <= 2) return 0;

  const hint = snapshot.absTop - mirror.absTop;
  if (
    hint !== 0 &&
    Math.abs(hint) < rows &&
    verifyShift(mirror, snapshot, hint)
  ) {
    return hint;
  }
  for (let shift = 1; shift < rows; shift++) {
    if (mirror.rowSignature(shift) === snapshot.rowSig[0]) {
      if (verifyShift(mirror, snapshot, shift)) return shift;
    }
    if (mirror.rowSignature(0) === snapshot.rowSig[shift]) {
      if (verifyShift(mirror, snapshot, -shift)) return -shift;
    }
  }
  return 0;
}

/** Does most of the band that would survive this shift actually match? */
function verifyShift(
  mirror: Mirror,
  snapshot: GridSnapshot,
  shift: number,
): boolean {
  const { rows } = snapshot;
  const survivors = rows - Math.abs(shift);
  if (survivors < 2) return false;
  let matched = 0;
  for (let i = 0; i < survivors; i++) {
    const from = shift > 0 ? i + shift : i;
    const to = shift > 0 ? i : i - shift;
    if (mirror.rowSignature(from) === snapshot.rowSig[to]) matched++;
  }
  // Three quarters: a partial scroll region (vim inserting a line inside a
  // window) still moves most of the band, and the rows it does not move are
  // repainted by the ordinary diff below.
  return matched >= Math.max(2, Math.ceil(survivors * 0.75));
}

/** Move the mirror's rows the way the pixels are about to move. */
function shiftMirror(
  mirror: Mirror,
  shift: number,
  cols: number,
  rows: number,
): RowCopy {
  const { sig, rowSig, force } = mirror._internals();
  const count = rows - Math.abs(shift);
  if (shift > 0) {
    sig.copyWithin(0, shift * cols, rows * cols);
    rowSig.copyWithin(0, shift, rows);
    for (let row = count; row < rows; row++) force[row] = 1;
  } else {
    const up = -shift;
    sig.copyWithin(up * cols, 0, count * cols);
    rowSig.copyWithin(up, 0, count);
    for (let row = 0; row < up; row++) force[row] = 1;
  }
  return shift > 0
    ? { srcRow: shift, dstRow: 0, count }
    : { srcRow: 0, dstRow: -shift, count };
}
