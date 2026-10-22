// The row and column model: everything a table decides before it draws.
//
// Pure, and deliberately so — the way `../tree/rows.ts` is. Which rows are
// shown in what order, what a cell's raw value is, how two rows compare, and
// how many pixels each column gets are all answerable with no display, and
// they are where the subtle table bugs live. The component only draws the
// answer, and the tests assert on the answer directly.

import type { ReactNode } from 'react';
import { compareText } from '../internal/collate.js';
import type { RowKeys } from '../internal/heights.js';

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
  /** Logical, so bidi is the layout's problem and never the app's: `'end'`
   *  is the edge the row finishes at — where a column of figures lines up —
   *  and under RTL that is the left edge without anyone saying so. Core
   *  said `'left' | 'right'`; the successor says what it always meant. */
  align?: 'start' | 'center' | 'end';
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

/** Core's comparator: numbers numerically, everything else as text, with
 *  `null`/`undefined` sorting as the empty string. The text half is
 *  `localeCompare`'s, through one collator (`../internal/collate.ts`). */
export function defaultCompare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return compareText(String(a ?? ''), String(b ?? ''));
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
    const compare = column.compare;
    if (compare) {
      entries.sort((a, b) => sign * compare(a.row, b.row));
    } else {
      // each row's value read once rather than twice a comparison: a sort
      // asks for about 17 of them a row at 100,000 rows
      const keyed = entries.map((entry) => ({
        entry,
        key: columnValue(entry.row, column),
      }));
      keyed.sort((a, b) => sign * defaultCompare(a.key, b.key));
      for (let i = 0; i < keyed.length; i++) entries[i] = keyed[i].entry;
    }
    entries.forEach((entry, index) => {
      entry.index = index;
    });
  }
  return entries;
}

/**
 * `orderRows`, as the component holds it: the same order and the same
 * entries — `test/table-rows.test.ts` holds the two to each other — with an
 * entry made only for a row something asks for.
 *
 * Every id is resolved up front — that is what checks them, so a row with
 * none still throws in the render that brought it — and kept in one array,
 * which is all the height index, the window and the reveal read. What is
 * deferred is the `{ id, row, index }` per row: the table draws a screenful
 * of them, and a million made at once, for an app handing over a new array
 * of rows already in order, were most of a 60-80 ms render and the
 * collection after it.
 */
export function orderedRows<Row>(
  rows: readonly Row[],
  columns: readonly TableColumn<Row>[],
  getId: (row: Row, index: number) => TableRowId,
  sort: TableSort | null,
  presorted: boolean,
): OrderedRows<Row> {
  const ids: TableRowId[] = [];
  for (let i = 0; i < rows.length; i++) ids.push(getId(rows[i], i));
  const column =
    sort && !presorted ? columns.find((c) => c.id === sort.column) : undefined;
  if (!sort || !column) return new OrderedRows(rows, ids, null);
  // The positions sorted, rather than the rows: the comparator sees the
  // rows in the order the entries used to be in, so it is asked the same
  // questions in the same order, and the sort is as stable as it was.
  const sign = sort.direction === 'desc' ? -1 : 1;
  const order: number[] = [];
  for (let i = 0; i < rows.length; i++) order.push(i);
  const compare = column.compare;
  if (compare) {
    order.sort((a, b) => sign * compare(rows[a], rows[b]));
  } else {
    // each row's value read once rather than twice a comparison: a sort
    // asks for about 17 of them a row at 100,000 rows
    const keys = rows.map((row) => columnValue(row, column));
    order.sort((a, b) => sign * defaultCompare(keys[a], keys[b]));
  }
  return new OrderedRows(
    rows,
    order.map((i) => ids[i]),
    order,
  );
}

/**
 * The rows in display order, read by position: how many, each one's id,
 * and its entry — made the first time it is asked for and the same object
 * every time after, which the row elements' cache keys on.
 */
export class OrderedRows<Row> implements RowKeys {
  readonly length: number;
  private readonly rows: readonly Row[];
  /** Each position's id. */
  private readonly ids: readonly TableRowId[];
  /** Where each position's row is in `rows`; null when it is the same. */
  private readonly order: readonly number[] | null;
  private readonly made = new Map<number, TableRow<Row>>();
  private all: TableRow<Row>[] | null = null;

  constructor(
    rows: readonly Row[],
    ids: readonly TableRowId[],
    order: readonly number[] | null,
  ) {
    this.rows = rows;
    this.ids = ids;
    this.order = order;
    this.length = ids.length;
  }

  /** The id at `index`, or undefined outside the list. */
  keyAt(index: number): TableRowId | undefined {
    return this.ids[index];
  }

  /** The entry at `index`, or undefined outside the list. */
  at(index: number): TableRow<Row> | undefined {
    if (!(index >= 0 && index < this.length)) return undefined;
    if (this.all !== null) return this.all[index];
    let entry = this.made.get(index);
    if (entry === undefined) {
      entry = this.entry(index);
      this.made.set(index, entry);
    }
    return entry;
  }

  private entry(index: number): TableRow<Row> {
    return {
      id: this.ids[index],
      row: this.rows[this.order === null ? index : this.order[index]],
      index,
    };
  }

  /** Where the row with this id is, or -1. */
  indexOf(id: TableRowId | null): number {
    return id === null ? -1 : this.ids.indexOf(id);
  }

  /** The ids from `start` up to, not including, `end` — a new array. */
  idsBetween(start = 0, end = this.length): TableRowId[] {
    return this.ids.slice(start, end);
  }

  /** Every entry, as `orderRows` hands them back — made once, on demand. */
  toArray(): TableRow<Row>[] {
    if (this.all === null) {
      const all: TableRow<Row>[] = [];
      for (let i = 0; i < this.length; i++) all.push(this.entry(i));
      // …keeping the ones already handed out, which something may hold
      for (const [index, entry] of this.made) all[index] = entry;
      this.made.clear();
      this.all = all;
    }
    return this.all;
  }
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
