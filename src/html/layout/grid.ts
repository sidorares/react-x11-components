// A table's grid: which rows it has, and which slot of them each cell
// takes. Shared by the table layout, which sizes the columns, and the
// collapsing border model, which resolves the borders along every edge of
// the grid — the two have to agree on where a cell is.
import type { Box } from './boxes.js';

export interface Cell {
  box: Box;
  row: number;
  column: number;
  colSpan: number;
  rowSpan: number;
}

/** A table's rows in order, with the row group each is in, and its
 *  captions. */
export interface TableRows {
  rows: Box[];
  /** Per row, the row group it is in, or null for a row of the table's
   *  own. */
  groups: (Box | null)[];
  captions: Box[];
}

/**
 * A table's rows in the order they are drawn: a header group's first,
 * wherever it stands, and a footer group's last (CSS 2.1 17.2) — HTML 4
 * put `<tfoot>` before `<tbody>`, and a document that did would draw its
 * totals mid-table. Only the first of each is set apart; any other is a
 * body group.
 */
export function rowsOf(table: Box): TableRows {
  const rows: Box[] = [];
  const groups: (Box | null)[] = [];
  const captions: Box[] = [];
  let header: Box | null = null;
  let footer: Box | null = null;
  for (const child of table.children) {
    if (child.kind !== 'table-row-group') continue;
    const display = child.style.display;
    if (display === 'table-header-group') header ??= child;
    else if (display === 'table-footer-group') footer ??= child;
  }
  const take = (group: Box): void => {
    for (const row of group.children) {
      if (row.kind !== 'table-row') continue;
      rows.push(row);
      groups.push(group);
    }
  };
  if (header) take(header);
  for (const child of table.children) {
    if (child.kind === 'table-caption') captions.push(child);
    else if (child.kind === 'table-row-group') {
      if (child !== header && child !== footer) take(child);
    } else if (child.kind === 'table-row') {
      rows.push(child);
      groups.push(null);
    }
  }
  if (footer) take(footer);
  return { rows, groups, captions };
}

/** A table's rows, as `rowsOf` gives them, and its grid. */
export interface TableGrid extends TableRows {
  cells: Cell[];
  columnCount: number;
  /** Per column, the column box it is in, or null. */
  columnBoxes: (Box | null)[];
  /** Per column, the column group it is in, or null. */
  columnGroups: (Box | null)[];
}

const GRIDS = new WeakMap<Box, TableGrid>();

/**
 * A table's rows and grid, worked out once per box tree: they come from the
 * markup alone — a restyle builds the boxes again — while the layout asks
 * on every pass, at every width a resize goes through, and the collapsing
 * border model asks too.
 */
export function tableGrid(table: Box): TableGrid {
  let grid = GRIDS.get(table);
  if (!grid) {
    const rows = rowsOf(table);
    const cells = gridOf(rows.rows);
    const { column, group } = columnsOf(table, cells.columnCount);
    if (table.style.direction === 'rtl') {
      // A table right to left has its first column at the right (CSS 2.1
      // 17.2). The grid is turned round once, here, so the layout, the
      // collapsing borders and the column backgrounds, which all read it
      // from the left, agree about where a cell is.
      const count = cells.columnCount;
      for (const cell of cells.cells) {
        cell.column = count - cell.column - cell.colSpan;
      }
      column.reverse();
      group.reverse();
    }
    grid = {
      ...rows,
      ...cells,
      columnBoxes: column,
      columnGroups: group,
    };
    GRIDS.set(table, grid);
  }
  return grid;
}

/**
 * Assign every cell a row and a column, honouring `colspan` and `rowspan`.
 * The occupancy grid is what makes a `rowspan` in an earlier row push a
 * later row's cells to the right, which is the bug every naive table
 * renderer ships with.
 */
export function gridOf(rows: Box[]): { cells: Cell[]; columnCount: number } {
  const cells: Cell[] = [];
  const occupied: boolean[][] = [];
  let columnCount = 0;

  const mark = (r: number, c: number): void => {
    (occupied[r] ??= [])[c] = true;
  };
  const taken = (r: number, c: number): boolean => occupied[r]?.[c] === true;

  for (let r = 0; r < rows.length; r += 1) {
    let c = 0;
    for (const box of rows[r].children) {
      if (box.kind !== 'table-cell') continue;
      while (taken(r, c)) c += 1;
      const colSpan = Math.max(1, spanAttr(box, 'colspan'));
      const rowSpan = Math.max(1, spanAttr(box, 'rowspan'));
      cells.push({ box, row: r, column: c, colSpan, rowSpan });
      for (let dr = 0; dr < rowSpan; dr += 1) {
        for (let dc = 0; dc < colSpan; dc += 1) mark(r + dr, c + dc);
      }
      c += colSpan;
      columnCount = Math.max(columnCount, c);
    }
  }
  return { cells, columnCount };
}

export function spanAttr(box: Box, name: string): number {
  const raw = box.el?.attribs?.[name];
  if (!raw) return 1;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 1;
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
