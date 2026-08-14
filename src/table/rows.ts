// The row and column model: everything a table decides before it draws.
//
// Pure, and deliberately so — the way `../tree/rows.ts` is. Which rows are
// shown in what order, what a cell's raw value is, how two rows compare, and
// how many pixels each column gets are all answerable with no display, and
// they are where the subtle table bugs live. The component only draws the
// answer, and the tests assert on the answer directly.

import type { ReactNode } from 'react';

/** What a row is keyed by. Numbers are allowed because a row often comes
 *  from a database, and stringifying an id is a chance to lose one. */
export type TableRowId = string | number;

/** One row of the current view: the app's row object, its resolved id, and
 *  its position **in sorted order** — the order everything else counts in. */
export interface TableRow<Row> {
  id: TableRowId;
  row: Row;
  index: number;
}

/** A row, plus what only the render knows about it. */
export interface TableRowState<Row> extends TableRow<Row> {
  selected: boolean;
  /**
   * The ink the row is painted in. Handed over by name because **colour does
   * not cascade into a drawing**: an `<Icon>` or a `<canvas mono>` takes its
   * colour from its own style, so a glyph inside a cell on the selected row
   * has to be told. The `<text>` in a default cell needs nothing — text
   * inherits.
   */
  color: string;
}

/** What `column.render` and `styles.cell` are told. `selected` and `column`
 *  are the two fields core's `<Table>` passed, kept under the same names. */
export interface TableCellState<Row> extends TableRowState<Row> {
  column: TableColumn<Row>;
}

/** The sort descriptor. Core's shape, verbatim: `column` names a column id.
 *  `null` is "unsorted" — reachable through the controlled prop; the header
 *  click cycle is asc ↔ desc and never emits it. */
export interface TableSort {
  column: string;
  direction: 'asc' | 'desc';
}

/** What `column.renderHeader` and `styles.headerCell` are told. */
export interface TableHeaderCellState<Row> {
  column: TableColumn<Row>;
  /** The table's current sort — this column's when `sort.column` matches. */
  sort: TableSort | null;
  /** The width the column resolved to this layout, in pixels. */
  resolvedWidth: number;
}

/**
 * One column. `id`, `label`, `width`, `align`, `value` and `render` are
 * core's `TableColumn`, kept compatible; the rest is this component's.
 *
 * Sizing: `flex` makes the column share the viewport width left over after
 * the fixed columns; `width` alone makes it fixed. **A column declaring
 * neither is `flex: 1` with a 120px floor** — so a table with no sizing
 * config fills its box instead of parking dead space beside fixed-120
 * columns. A user resize converts the column to fixed at the dragged width.
 */
export interface TableColumn<Row = any> {
  id: string;
  /** The header caption. Defaults to the id. */
  label?: string;
  /** Fixed width, in pixels. Ignored when `flex` is set. */
  width?: number;
  /** Share of the leftover viewport width, by weight. */
  flex?: number;
  /** The narrowest the column may go — flex resolution and user resize both
   *  respect it. Defaults to 40 (core's resize floor); 120 for a column with
   *  neither `width` nor `flex`. */
  minWidth?: number;
  /** `'right'` means "the end of the row" — a column of figures lines up on
   *  the edge the row finishes at, which is the left one in a mirrored
   *  table. */
  align?: 'left' | 'right' | 'center';
  /** Whether the header click sorts on this column. Default true. */
  sortable?: boolean;
  /** The cell's raw value: feeds the default cell text **and** the sort.
   *  Defaults to `row[id]`. */
  value?: (row: Row) => unknown;
  /** The sort order, given the whole rows. Defaults to a natural comparison
   *  over `value()` — numbers numerically, everything else as text. */
  compare?: (a: Row, b: Row) => number;
  /** The cell, replaced entirely. The state says whether the cell is on the
   *  selected row — that row is a filled bar, and a colour picked against
   *  the resting background is unreadable on it. */
  render?: (row: Row, state: TableCellState<Row>) => ReactNode;
  /** The header cell's content — the caption and the sort mark's place. The
   *  header *box* stays the table's: it carries the width, the sort click
   *  and the resize grip beside it. */
  renderHeader?: (state: TableHeaderCellState<Row>) => ReactNode;
}

/** A cell's raw value: `column.value`, or the property named by the id. */
export function columnValue<Row>(row: Row, column: TableColumn<Row>): unknown {
  return column.value
    ? column.value(row)
    : (row as Record<string, unknown>)[column.id];
}

/** Core's comparator, verbatim: numbers numerically, everything else as
 *  text, with `null`/`undefined` sorting as the empty string. */
export function defaultCompare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/**
 * The id accessor with its default filled in — and its failure made loud.
 *
 * A row without an id cannot be selected, keyed, or measured, and rendering
 * it anyway fails somewhere far away (a React key warning, a selection that
 * silently never matches). The remedial throw here is the Calendar's
 * precedent: name the fix, not just the fault.
 */
export function resolveGetId<Row>(
  getId: ((row: Row) => TableRowId) | undefined,
): (row: Row, index: number) => TableRowId {
  return (row: Row, index: number): TableRowId => {
    const id = getId
      ? getId(row)
      : ((row as { id?: TableRowId }).id as TableRowId);
    if (id === undefined || id === null) {
      throw new TypeError(
        `<Table> row ${index} has no id — every row needs one. ` +
          'Give rows an `id` field, or pass `getId` to read your own key.',
      );
    }
    return id;
  };
}

/**
 * The rows in display order: ids resolved, sort applied.
 *
 * `sort` and *applying* the sort are separate on purpose (see the PRD's
 * "Sort ownership, split in two"): pass `presorted` when the rows already
 * arrive in display order — a server sorted them — and the descriptor only
 * drives the header indicator. The sort is stable, so rows that compare
 * equal keep the order the app gave them.
 */
export function orderRows<Row>(
  rows: readonly Row[],
  columns: readonly TableColumn<Row>[],
  getId: (row: Row, index: number) => TableRowId,
  sort: TableSort | null,
  presorted: boolean,
): TableRow<Row>[] {
  const entries = rows.map((row, index) => ({
    id: getId(row, index),
    row,
    index,
  }));
  const column =
    sort && !presorted ? columns.find((c) => c.id === sort.column) : undefined;
  if (sort && column) {
    const sign = sort.direction === 'desc' ? -1 : 1;
    const compare =
      column.compare ??
      ((a: Row, b: Row) =>
        defaultCompare(columnValue(a, column), columnValue(b, column)));
    entries.sort((a, b) => sign * compare(a.row, b.row));
    entries.forEach((entry, index) => {
      entry.index = index;
    });
  }
  return entries;
}

/** Core's resize floor, and the sized-column default for `minWidth`. */
export const MIN_COLUMN = 40;
/** What a column with neither `width` nor `flex` will not shrink below —
 *  core's fixed default, carried forward as a floor. */
export const UNSIZED_MIN = 120;

/** The pixels every column resolved to, in column order, plus their sum —
 *  the content width, and what the header row is sized to. */
export interface ResolvedWidths {
  widths: number[];
  total: number;
}

/**
 * Columns resolve to pixels **once, at the table level** — the one problem
 * no browser table library has, because HTML's table layout algorithm does
 * not exist here, and per-row flex must not decide column widths (each row
 * would negotiate its own grid).
 *
 * Fixed columns take their width; a user resize overrides anything; flex
 * columns share `max(0, viewport − Σfixed)` by weight, floored at their
 * `minWidth`. When nothing fits — the viewport is smaller than the floors —
 * every flex column sits at its floor and the body scrolls horizontally.
 * Before the first layout the viewport is 0, which lands in the same branch.
 */
export function resolveWidths<Row>(
  columns: readonly TableColumn<Row>[],
  user: Readonly<Record<string, number>>,
  viewport: number,
): ResolvedWidths {
  const widths = new Array<number>(columns.length).fill(0);
  interface FlexEntry {
    at: number;
    weight: number;
    min: number;
  }
  let flex: FlexEntry[] = [];
  let fixedSum = 0;
  columns.forEach((column, at) => {
    const resized = user[column.id];
    if (resized !== undefined) {
      widths[at] = resized;
      fixedSum += resized;
      return;
    }
    if (column.flex === undefined && column.width !== undefined) {
      widths[at] = column.width;
      fixedSum += column.width;
      return;
    }
    const unsized = column.flex === undefined && column.width === undefined;
    flex.push({
      at,
      weight: column.flex ?? 1,
      min: column.minWidth ?? (unsized ? UNSIZED_MIN : MIN_COLUMN),
    });
  });

  if (flex.length) {
    let pool = Math.max(0, viewport - fixedSum);
    // Distribute, clamping to floors: a column whose share lands under its
    // floor takes the floor and leaves the pool, and the rest re-share what
    // is left. Terminates because every pass either clamps someone or
    // distributes and stops.
    for (;;) {
      const minSum = flex.reduce((sum, f) => sum + f.min, 0);
      if (pool <= minSum) {
        for (const f of flex) widths[f.at] = f.min;
        break;
      }
      const weightSum = flex.reduce((sum, f) => sum + f.weight, 0);
      const clamped = flex.filter((f) => (pool * f.weight) / weightSum < f.min);
      if (!clamped.length) {
        // Cumulative rounding, so the integer widths sum to the pool exactly
        // and the table's edge meets the viewport's rather than drifting a
        // pixel per column.
        let acc = 0;
        let assigned = 0;
        for (const f of flex) {
          acc += (pool * f.weight) / weightSum;
          const w = Math.round(acc) - assigned;
          assigned += w;
          widths[f.at] = w;
        }
        break;
      }
      for (const f of clamped) {
        widths[f.at] = f.min;
        pool -= f.min;
      }
      flex = flex.filter((f) => !clamped.includes(f));
    }
  }

  return { widths, total: widths.reduce((sum, w) => sum + w, 0) };
}
