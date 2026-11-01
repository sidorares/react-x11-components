// What a width comes to, guessed from the two widths laid out before it.
//
// SPIKE. docs/prd-guessed-layout.md is the record.
//
// A window's edge dragged across a page that cannot keep up was shown as the
// last frame stretched, then the exact one when it came: every box wrong for
// as long as the drag lasts, by as far as it has gone. But what a width does
// to a page's boxes is nearly a straight line. A flex item that takes the
// room left over grows with the width, what is after it moves with the
// edge, and what is before it stays; a block is as wide as what it is in.
// Each box's rect is a function of the width in pieces, and a drag walks
// along one piece. So two exact layouts give every box its slope, and what
// any width near them comes to is arithmetic: no Yoga, no text engine, no
// walk of what the window does not show.
//
// A guess is never written to the boxes for good. It is put on for the
// paint that draws it (`apply`) and taken off again (`undo`), so a layout, a
// hit test and a page's read all find the last exact layout, and nothing a
// layout keeps can be kept from a guess.
import type { Box, BoxTree, LineBox } from './boxes.js';

/** SPIKE: whether a drag that stays behind falls back on a guess. */
export const guessing = { enabled: false };

/** One box as an exact layout left it. */
interface ExactBox {
  box: Box;
  /** Where the box around it is in the list, or -1. */
  parent: number;
  x: number;
  y: number;
  width: number;
  height: number;
  boundsX: number;
  boundsY: number;
  boundsWidth: number;
  boundsHeight: number;
  /** Where its lines are, two numbers a line, or null. */
  lines: number[] | null;
}

/** What an exact layout at a width put where the window can see it. */
export interface ExactLayout {
  width: number;
  boxes: ExactBox[];
  index: Map<Box, number>;
  /** Whether it holds columns, whose pieces are kept apart from the boxes
   *  where no guess reaches them (`COLUMN_PIECES`). */
  columns: boolean;
}

/** How far past the viewport's right a box is still taken: a window dragged
 *  wider shows what was past its edge. */
const RIGHT_MARGIN = 0.25;

/**
 * The boxes of a tree the window can see, or could if it grew, in tree
 * order: what a guess has to put somewhere. A clipping box bounds what is
 * in it, so a strip of thousands of boxes behind `overflow: hidden` costs
 * what it shows.
 */
export function exactLayoutOf(
  tree: BoxTree,
  width: number,
  top: number,
  bottom: number,
): ExactLayout {
  const out: ExactLayout = {
    width,
    boxes: [],
    index: new Map(),
    columns: false,
  };
  const right = width * (1 + RIGHT_MARGIN);
  const walk = (
    box: Box,
    parent: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void => {
    const style = box.style;
    if (style.display === 'none') return;
    const free = style.position === 'fixed' || style.position === 'absolute';
    const nx0 = free ? 0 : x0;
    const nx1 = free ? right : x1;
    const ny0 = free ? top : y0;
    const ny1 = free ? bottom : y1;
    let at = parent;
    let cx0 = nx0;
    let cx1 = nx1;
    let cy0 = ny0;
    let cy1 = ny1;
    if (box.kind !== 'text' && box.kind !== 'inline' && box.kind !== 'break') {
      const boxRight = box.x + box.width;
      const boxBottom = box.y + box.height;
      // ink reaches past a box: a child of a box with no height still draws
      const meets =
        box.boundsX < nx1 &&
        box.boundsX + box.boundsWidth > nx0 &&
        box.boundsY < ny1 &&
        box.boundsY + box.boundsHeight > ny0;
      if (!meets) return;
      if (style.columns) out.columns = true;
      at = out.boxes.length;
      out.index.set(box, at);
      out.boxes.push({
        box,
        parent,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        boundsX: box.boundsX,
        boundsY: box.boundsY,
        boundsWidth: box.boundsWidth,
        boundsHeight: box.boundsHeight,
        lines: box.lines ? flatLines(box.lines) : null,
      });
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        cx0 = Math.max(nx0, box.x);
        cx1 = Math.min(nx1, boxRight);
        cy0 = Math.max(ny0, box.y);
        cy1 = Math.min(ny1, boxBottom);
        if (cx1 <= cx0 || cy1 <= cy0) return;
      }
    }
    for (const child of box.children) walk(child, at, cx0, cy0, cx1, cy1);
  };
  walk(tree.root, -1, 0, top, right, bottom);
  return out;
}

function flatLines(lines: readonly LineBox[]): number[] {
  const out = new Array<number>(lines.length * 2);
  for (let i = 0; i < lines.length; i += 1) {
    out[i * 2] = lines[i].x;
    out[i * 2 + 1] = lines[i].y;
  }
  return out;
}

/** The numbers of a box's rect and ink that a width moves. */
const FIELDS = 8;

/** Whether a guess can move a tree: not one with a turned flow, whose
 *  lengths run across the page. */
export function guessable(tree: BoxTree): boolean {
  return !tree.vertical;
}

/** Every box's slope, from two exact layouts of the same boxes. */
export class LayoutGuess {
  private readonly _slopes: Float64Array;
  private readonly _lineSlopes: (Float64Array | null)[];
  /** How far `apply` moved each box's lines, to take off again. */
  private _width: number | null = null;

  constructor(
    a: ExactLayout,
    private readonly _b: ExactLayout,
  ) {
    const boxes = _b.boxes;
    const span = _b.width - a.width;
    const slopes = new Float64Array(boxes.length * FIELDS);
    this._lineSlopes = new Array<Float64Array | null>(boxes.length).fill(null);
    for (let i = 0; i < boxes.length; i += 1) {
      const now = boxes[i];
      const at = a.index.get(now.box);
      const o = i * FIELDS;
      if (at === undefined) {
        // a box the other layout did not have goes with the one it is in
        const parent = now.parent;
        if (parent >= 0) {
          const p = parent * FIELDS;
          slopes[o] = slopes[p];
          slopes[o + 1] = slopes[p + 1];
          slopes[o + 4] = slopes[p + 4];
          slopes[o + 5] = slopes[p + 5];
        }
        continue;
      }
      const was = a.boxes[at];
      slopes[o] = (now.x - was.x) / span;
      slopes[o + 2] = (now.width - was.width) / span;
      slopes[o + 4] = (now.boundsX - was.boundsX) / span;
      slopes[o + 6] = (now.boundsWidth - was.boundsWidth) / span;
      // Heights stay. A paragraph's height moves a line at a time, so two
      // layouts a step apart either show no slope or one a line over a few
      // pixels, which would throw everything below it down the page.
      if (now.lines && was.lines && now.lines.length === was.lines.length) {
        const lines = new Float64Array(now.lines.length / 2);
        for (let l = 0; l < lines.length; l += 1) {
          lines[l] = (now.lines[l * 2] - was.lines[l * 2]) / span;
        }
        this._lineSlopes[i] = lines;
      }
    }
    this._slopes = slopes;
  }

  /** How many boxes a guess moves. */
  get size(): number {
    return this._b.boxes.length;
  }

  /** The width the layouts this guesses from were last laid out at. */
  get from(): number {
    return this._b.width;
  }

  /** Put the guess for a width on the boxes. */
  apply(width: number): void {
    if (this._width !== null) this.undo();
    this._width = width;
    const t = width - this._b.width;
    const boxes = this._b.boxes;
    const slopes = this._slopes;
    for (let i = 0; i < boxes.length; i += 1) {
      const kept = boxes[i];
      const box = kept.box;
      const o = i * FIELDS;
      const dx = slopes[o] * t;
      box.x = kept.x + dx;
      box.width = kept.width + slopes[o + 2] * t;
      box.boundsX = kept.boundsX + slopes[o + 4] * t;
      box.boundsWidth = kept.boundsWidth + slopes[o + 6] * t;
      if (box.marker) box.marker.x += dx;
      if (box.lines) moveLines(box.lines, this._lineSlopes[i], slopes[o], t);
    }
  }

  /** Take it off again: the boxes as the last exact layout left them. */
  undo(): void {
    if (this._width === null) return;
    const t = this._width - this._b.width;
    this._width = null;
    const boxes = this._b.boxes;
    const slopes = this._slopes;
    for (let i = 0; i < boxes.length; i += 1) {
      const kept = boxes[i];
      const box = kept.box;
      const o = i * FIELDS;
      box.x = kept.x;
      box.width = kept.width;
      box.boundsX = kept.boundsX;
      box.boundsWidth = kept.boundsWidth;
      if (box.marker) box.marker.x -= slopes[o] * t;
      if (box.lines) moveLines(box.lines, this._lineSlopes[i], slopes[o], -t);
    }
  }
}

/** Move a box's lines and all that is placed on them across by what the
 *  width does to each, or by what it does to the box where the two layouts
 *  broke them differently. */
function moveLines(
  lines: readonly LineBox[],
  slopes: Float64Array | null,
  slope: number,
  t: number,
): void {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const dx = (slopes ? slopes[i] : slope) * t;
    if (!dx) continue;
    line.x += dx;
    for (const text of line.texts) text.drawX += dx;
    for (const placed of line.atomics) placed.x += dx;
    for (const edge of line.edges ?? []) edge.x += dx;
  }
}
