// The collapsing border model (CSS 2.1 17.6.2).
//
// Where borders collapse, a table's cells share the borders between them:
// every edge of the grid carries one border, chosen from everything that
// meets there — the cells on either side, their rows and row groups, the
// columns and column groups, and at the outside the table — and drawn
// centred on the edge. So the choice is made per segment of the grid, not
// per box, and it is made here once per box tree: it reads styles and the
// grid, and neither changes with the width.
//
// Layout sees the result as ordinary border widths. A cell's border on a
// side is half the border drawn along it, and the table's is half of the
// borders around the outside (17.6.2), so the table algorithm sizes and
// places cells exactly as before; the table then paints the segments
// (`paintCollapsedBorders`) and nothing paints the boxes' own.
import type { BorderStyle, ComputedStyle } from '../css/style.js';
import type { Box } from './boxes.js';
import { gridOf, rowsOf, spanAttr } from './grid.js';
import type { Cell } from './grid.js';

/** The border drawn along one segment of the grid. */
export interface CollapsedBorder {
  width: number;
  style: BorderStyle;
  color: string;
  /** How it won, for painting the winners last where segments cross. */
  rank: number;
}

export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CollapsedTable {
  rows: number;
  columns: number;
  /** The border along each row line, per column: `(rows + 1) × columns`,
   *  line by line. Null where there is none, or where the line runs
   *  through a cell that spans it. */
  horizontal: (CollapsedBorder | null)[];
  /** The border along each column line, per row: `rows × (columns + 1)`,
   *  row by row. */
  vertical: (CollapsedBorder | null)[];
  /** What each cell's border widths are, as layout sees them. */
  cells: Map<Box, Edges>;
  /** The table's own border widths. */
  table: Edges;
  /** Where each grid line was laid out, from the table's border-box
   *  corner: `columns + 1` and `rows + 1` of them. Set by the table
   *  layout, empty until it runs. */
  lineX: number[];
  lineY: number[];
}

/** The part of a border that lies before its grid line — to its left, or
 *  above it — and the part after. */
export function halves(width: number): [number, number] {
  const before = Math.floor(width / 2);
  return [before, width - before];
}

/**
 * Give a table, or a cell of one, the border widths the collapsing model
 * leaves it, when its table's borders collapse. A table has no padding
 * there (17.6.2).
 */
export function collapseEdges(box: Box): void {
  const table = box.kind === 'table' ? box : tableOf(box);
  if (!table || table.style.borderCollapse !== 'collapse') return;
  const grid = (table.collapsed ??= collapseTable(table));
  const edges = box === table ? grid.table : grid.cells.get(box);
  if (!edges) return;
  box.borderTop = edges.top;
  box.borderRight = edges.right;
  box.borderBottom = edges.bottom;
  box.borderLeft = edges.left;
  box.bordersCollapsed = true;
  if (box === table) {
    box.padTop = 0;
    box.padRight = 0;
    box.padBottom = 0;
    box.padLeft = 0;
  }
}

function tableOf(cell: Box): Box | null {
  const row = cell.parent;
  const up = row?.parent;
  if (up?.kind === 'table') return up;
  const table = up?.parent;
  return table?.kind === 'table' ? table : null;
}

/** Whose border it is, in the order a tie between two of the same width
 *  and style is settled (17.6.2.1). */
const enum Origin {
  Table = 0,
  ColumnGroup = 1,
  Column = 2,
  RowGroup = 3,
  Row = 4,
  Cell = 5,
}

const STYLE_RANK: Record<BorderStyle, number> = {
  none: 0,
  hidden: 0,
  inset: 1,
  groove: 2,
  outset: 3,
  ridge: 4,
  dotted: 5,
  dashed: 6,
  solid: 7,
  double: 8,
};

type Side = 'Top' | 'Right' | 'Bottom' | 'Left';

/** A side of a box's style as a candidate for a segment. */
interface Candidate {
  style: ComputedStyle;
  side: Side;
  origin: Origin;
}

/**
 * The border one segment carries (17.6.2.1): `hidden` anywhere suppresses
 * it; otherwise `none` takes no part, the widest wins, then the style by
 * `double`, `solid`, `dashed`, `dotted`, `ridge`, `outset`, `groove`,
 * `inset`, then the box by cell, row, row group, column, column group,
 * table — and between two of one kind, the one offered first, which the
 * callers make the one to the left or above.
 */
function resolve(candidates: Candidate[]): CollapsedBorder | null {
  let best: Candidate | null = null;
  let bestWidth = 0;
  let bestStyle = 0;
  for (const c of candidates) {
    const style = c.style[`border${c.side}Style`];
    if (style === 'hidden') return null;
    if (style === 'none') continue;
    const width = c.style[`border${c.side}Width`];
    const rank = STYLE_RANK[style];
    if (
      best &&
      (width < bestWidth ||
        (width === bestWidth &&
          (rank < bestStyle ||
            (rank === bestStyle && c.origin <= best.origin))))
    ) {
      continue;
    }
    best = c;
    bestWidth = width;
    bestStyle = rank;
  }
  if (!best || !(bestWidth > 0)) return null;
  const color = best.style[`border${best.side}Color`];
  return {
    width: bestWidth,
    style: best.style[`border${best.side}Style`],
    color: color === 'currentColor' ? best.style.color : color,
    rank: (bestWidth * 16 + bestStyle) * 8 + best.origin,
  };
}

/** Which column box and column group each column of the grid is in. */
function columnsOf(
  table: Box,
  count: number,
): { column: (Box | null)[]; group: (Box | null)[] } {
  const column: (Box | null)[] = new Array<Box | null>(count).fill(null);
  const group: (Box | null)[] = new Array<Box | null>(count).fill(null);
  let at = 0;
  const place = (box: Box | null, owner: Box | null, span: number): void => {
    for (let i = 0; i < span && at < count; i += 1, at += 1) {
      column[at] = box;
      group[at] = owner;
    }
  };
  for (const child of table.children) {
    if (at >= count) break;
    const display = child.style.display;
    if (display === 'table-column') {
      place(child, null, spanAttr(child, 'span'));
    } else if (display === 'table-column-group') {
      const columns = child.children.filter(
        (c) => c.style.display === 'table-column',
      );
      if (!columns.length) place(null, child, spanAttr(child, 'span'));
      for (const c of columns) place(c, child, spanAttr(c, 'span'));
    }
  }
  return { column, group };
}

/** Resolve every segment of a table's grid. */
export function collapseTable(table: Box): CollapsedTable {
  const { rows, groups } = rowsOf(table);
  const { cells, columnCount } = gridOf(rows);
  const R = rows.length;
  const C = columnCount;
  const owner: (Cell | null)[] = new Array<Cell | null>(R * C).fill(null);
  for (const cell of cells) {
    const lastRow = Math.min(R, cell.row + cell.rowSpan);
    const lastColumn = Math.min(C, cell.column + cell.colSpan);
    for (let r = cell.row; r < lastRow; r += 1) {
      for (let c = cell.column; c < lastColumn; c += 1) owner[r * C + c] = cell;
    }
  }
  const at = (r: number, c: number): Cell | null =>
    r < 0 || r >= R || c < 0 || c >= C ? null : owner[r * C + c];
  const { column, group } = columnsOf(table, C);

  const candidates: Candidate[] = [];
  const offer = (box: Box | null, side: Side, origin: Origin): void => {
    if (box) candidates.push({ style: box.style, side, origin });
  };

  // along each row line: the cell above and the cell below, their rows and
  // row groups where the line is their edge, and at the top and the bottom
  // of the table the columns, the column groups and the table
  const horizontal: (CollapsedBorder | null)[] =
    new Array<CollapsedBorder | null>((R + 1) * C).fill(null);
  for (let line = 0; line <= R; line += 1) {
    for (let c = 0; c < C; c += 1) {
      const above = at(line - 1, c);
      const below = at(line, c);
      if (above && above === below) continue;
      candidates.length = 0;
      if (above && above.row + above.rowSpan === line) {
        offer(above.box, 'Bottom', Origin.Cell);
      }
      if (below && below.row === line) offer(below.box, 'Top', Origin.Cell);
      if (line > 0) offer(rows[line - 1], 'Bottom', Origin.Row);
      if (line < R) offer(rows[line], 'Top', Origin.Row);
      if (line > 0 && groups[line - 1] !== groups[line]) {
        offer(groups[line - 1], 'Bottom', Origin.RowGroup);
      }
      if (line < R && (line === 0 || groups[line - 1] !== groups[line])) {
        offer(groups[line], 'Top', Origin.RowGroup);
      }
      if (line === 0 || line === R) {
        const side = line === 0 ? 'Top' : 'Bottom';
        offer(column[c], side, Origin.Column);
        offer(group[c], side, Origin.ColumnGroup);
        offer(table, side, Origin.Table);
      }
      horizontal[line * C + c] = resolve(candidates);
    }
  }

  // along each column line, the same turned on its side
  const vertical: (CollapsedBorder | null)[] =
    new Array<CollapsedBorder | null>(R * (C + 1)).fill(null);
  for (let r = 0; r < R; r += 1) {
    for (let line = 0; line <= C; line += 1) {
      const left = at(r, line - 1);
      const right = at(r, line);
      if (left && left === right) continue;
      candidates.length = 0;
      if (left && left.column + left.colSpan === line) {
        offer(left.box, 'Right', Origin.Cell);
      }
      if (right && right.column === line) {
        offer(right.box, 'Left', Origin.Cell);
      }
      if (line > 0) offer(column[line - 1], 'Right', Origin.Column);
      if (line < C) offer(column[line], 'Left', Origin.Column);
      if (line > 0 && (line === C || group[line - 1] !== group[line])) {
        offer(group[line - 1], 'Right', Origin.ColumnGroup);
      }
      if (line < C && (line === 0 || group[line - 1] !== group[line])) {
        offer(group[line], 'Left', Origin.ColumnGroup);
      }
      if (line === 0 || line === C) {
        const side = line === 0 ? 'Left' : 'Right';
        offer(rows[r], side, Origin.Row);
        offer(groups[r], side, Origin.RowGroup);
        offer(table, side, Origin.Table);
      }
      vertical[r * (C + 1) + line] = resolve(candidates);
    }
  }

  const widthOf = (b: CollapsedBorder | null): number => (b ? b.width : 0);
  const cellEdges = new Map<Box, Edges>();
  for (const cell of cells) {
    const lastRow = Math.min(R, cell.row + cell.rowSpan);
    const lastColumn = Math.min(C, cell.column + cell.colSpan);
    const edges: Edges = { top: 0, right: 0, bottom: 0, left: 0 };
    for (let c = cell.column; c < lastColumn; c += 1) {
      const top = widthOf(horizontal[cell.row * C + c]);
      const bottom = widthOf(horizontal[lastRow * C + c]);
      edges.top = Math.max(edges.top, halves(top)[1]);
      edges.bottom = Math.max(edges.bottom, halves(bottom)[0]);
    }
    for (let r = cell.row; r < lastRow; r += 1) {
      const left = widthOf(vertical[r * (C + 1) + cell.column]);
      const right = widthOf(vertical[r * (C + 1) + lastColumn]);
      edges.left = Math.max(edges.left, halves(left)[1]);
      edges.right = Math.max(edges.right, halves(right)[0]);
    }
    cellEdges.set(cell.box, edges);
  }

  // The table's own: half the first row's outer borders at the sides, and
  // half the widest along the top and the bottom (17.6.2). A later row with
  // a wider side border spills into the table's margin.
  const edges: Edges = { top: 0, right: 0, bottom: 0, left: 0 };
  if (R && C) {
    edges.left = halves(widthOf(vertical[0]))[0];
    edges.right = halves(widthOf(vertical[C]))[1];
    for (let c = 0; c < C; c += 1) {
      edges.top = Math.max(edges.top, halves(widthOf(horizontal[c]))[0]);
      edges.bottom = Math.max(
        edges.bottom,
        halves(widthOf(horizontal[R * C + c]))[1],
      );
    }
  }
  return {
    rows: R,
    columns: C,
    horizontal,
    vertical,
    cells: cellEdges,
    table: edges,
    lineX: [],
    lineY: [],
  };
}
