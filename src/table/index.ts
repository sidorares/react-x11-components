// <Table> — the data table: columns as data, rows from the app's own
// objects, and only the rows in view actually built.
//
// This is a **successor to react-x11's own `<Table>`, not a wrapper around
// it** — the same relationship `<Tree>` has to core's tree. Core's may be
// stripped down or removed altogether; nothing here imports it, and the two
// share no code. What is kept is the behaviour a user has already learnt —
// select on the first click, open on the second, the header that stays put,
// the resize grips, the sort toggle — and the prop names core's call sites
// already use (`columns`, `rows`, `sort`, `selected`, `onActivate`,
// `onColumnResize`), so migrating is changing the import.
//
// What it grows, per docs/prd-table.md (the bar `<Tree>` set):
//
//  1. **The data is the app's.** `getId` plus per-column `value` render any
//     row shape where it lies; a row of `{ id, … }` configures nothing.
//  2. **Rows may be any height.** `rowHeight` declares them uniform and the
//     slice is arithmetic, core's model; omit it and the rows are measured —
//     the tree's model, same machinery — so a `render` seam may wrap text or
//     stack lines without breaking the scrollbar.
//  3. **Every visible part is a seam**: `column.render`,
//     `column.renderHeader`, `renderRow`, `renderEmpty`, and a `styles` bag
//     whose row/cell entries may be functions of row state.
//  4. **Ceremony is additive.** Sorting, selection, multi-selection,
//     virtualization and the seams are independent opt-ins on this one
//     element — the PRD's continuity contract. There is no second API.
//
// Nothing here registers a host element. A table is `<box>`, `<text>` and
// core's chevron, so there is no `registerElement` call, no JSX augmentation
// and no side effect at import time at all.
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { createStyles } from 'react-x11/style';
import type { StyleProp } from 'react-x11';
import { Icon, useDirection, useTheme } from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent,
  MouseEvent,
  ScrollableNode,
  Theme,
} from 'react-x11';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';

import { hx } from './hx.js';
import type { Host } from './hx.js';
// Shared with <Tree> — internal, deliberately not a shared *module*; the
// header of src/internal/heights.ts says why.
import { RowHeights } from '../internal/heights.js';
import {
  afterLayout,
  cancelAfterLayout,
  cancelLater,
  later,
} from '../internal/timers.js';
import type { DelayTick } from '../internal/timers.js';
import { useReveal } from '../internal/scroll.js';
import {
  DEFAULT_OVERSCAN,
  DEFAULT_PREFETCH,
  useVirtualWindow,
} from '../internal/window.js';
import {
  MIN_COLUMN,
  columnValue,
  orderRows,
  resolveGetId,
  resolveWidths,
} from './rows.js';
import type {
  TableCellState,
  TableColumn,
  TableHeaderCellState,
  TableRow,
  TableRowId,
  TableRowState,
  TableSort,
} from './rows.js';

// The row and column model comes out too: it is what the seams are handed,
// and an app that drives a table from outside — "what order are the rows in",
// "how wide did that column get" — does the same arithmetic.
export type {
  ResolvedWidths,
  TableCellState,
  TableColumn,
  TableHeaderCellState,
  TableRow,
  TableRowId,
  TableRowState,
  TableSort,
} from './rows.js';
export {
  MIN_COLUMN,
  UNSIZED_MIN,
  columnValue,
  defaultCompare,
  orderRows,
  resolveGetId,
  resolveWidths,
} from './rows.js';

/** The header strip's height. Core's number — independent of the body's
 *  `rowHeight`, so a table of tall rows keeps a normal header. */
const HEADER_HEIGHT = 24;
/** The default row-height guess, and core's fixed row height. */
const ROW_HEIGHT = 24;
// The band you can grab, and the line you can see — two different sizes on
// purpose. A separator wants to be a hairline; a resize handle wants to be
// wide enough to hit without aiming. The band is centred **on** the rule:
// it is the boundary being moved, so a band lying to one side would light up
// off-centre and read as belonging to the column it covers.
const RULE = 1;
const HALF = 3;
const GRIP = HALF + RULE + HALF;
/** What one Left/Right on a focused grip is worth. */
const STEP = 16;
/**
 * Where `virtual="auto"` starts virtualizing.
 *
 * Well above any viewport, so a table that is merely long is still built
 * whole and keeps the one thing virtualization costs — every row in the
 * accessibility tree. Well below the point where building every row is felt.
 * The tree's threshold, for the tree's reasons.
 */
const VIRTUAL_THRESHOLD = 200;
/** The sort chevron, matched to the capitals of the 12px header caption. */
const SORT_MARK = 9;

const s = createStyles({
  root: { flexGrow: 1, minHeight: 0, minWidth: 0 },
  headerClip: { flexShrink: 0, overflow: 'hidden' },
  headerRow: { flexDirection: 'row', flexShrink: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: HEADER_HEIGHT,
    paddingStart: 8,
    // Matching the leading inset: the sort mark sits against this edge, and
    // without it the chevron touches the rule between the columns.
    paddingEnd: 8,
    flexShrink: 0,
    transition: { backgroundColor: 80 },
  },
  headerLabel: {
    fontSize: 12,
    textWrap: 'nowrap',
    textBoxTrim: 'cap-alphabetic',
  },
  /** Pushes the sort mark to the far end of the header, so the caption sits
   *  at the column's start edge — where the eye scans — and the marks of
   *  every sortable column line up instead of drifting with caption length. */
  headerSpring: { flexGrow: 1 },
  grip: {
    flexShrink: 0,
    cursor: 'col-resize',
    alignSelf: 'stretch',
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    transition: { backgroundColor: 80 },
  },
  rule: { width: RULE, flexShrink: 0, alignSelf: 'stretch' },
  body: { flexGrow: 1, minHeight: 0, overflow: 'scroll' },
  rowsBox: { flexDirection: 'column', flexShrink: 0 },
  row: {
    flexDirection: 'row',
    flexShrink: 0,
    transition: { backgroundColor: 80 },
  },
  cell: {
    justifyContent: 'center',
    paddingStart: 8,
    flexShrink: 0,
    overflow: 'hidden',
  },
  cellText: { fontSize: 12, textWrap: 'nowrap', textBoxTrim: 'cap-alphabetic' },
  spacer: { flexShrink: 0 },
  /** The bar inside a skeleton row — a line of "text" with no text, so a
   *  band of placeholders reads as rows arriving rather than a void. */
  skeletonBar: {
    height: 8,
    borderRadius: 4,
    marginStart: 8,
    alignSelf: 'center',
    flexShrink: 0,
  },
  /** The lane the fast-scroll pill floats in: absolute against the table's
   *  root so the body pane scrolls under it, full-width so the pill centres
   *  itself, and transparent to the pointer so the rows beneath stay
   *  clickable. */
  scrollHintLane: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  scrollHint: {
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 5,
    paddingBottom: 5,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  sortMark: { marginStart: 4 },
  empty: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
});

/**
 * What `renderScrollHint` is told: where the viewport is, while a fast
 * scroll is still being caught up with. The top row itself is included so a
 * hint can show what is *at* this position — a date, a group, a name — the
 * way a photo library's scrubber shows the month.
 */
export interface TableScrollHintState<Row = any> {
  /** The first row in view, in display order. */
  row: TableRow<Row>;
  /** Its position, 1-based — "row `from` of `count`". */
  from: number;
  /** The last row in view, 1-based. */
  to: number;
  /** How many rows the table has. */
  count: number;
  /** How many of the rows in view are still placeholders. */
  pending: number;
}

/** The selection that just changed, alongside the whole set. `id`/`row` name
 *  the row the gesture landed on; a select-all has no single row to name. */
export interface TableSelectChange<Row> {
  type: 'replace' | 'toggle' | 'range' | 'all';
  id?: TableRowId;
  row?: Row;
}

/** The style overrides, one per part the table draws. Function forms are
 *  called per rendered row or cell, so a style can follow row state — zebra
 *  striping is `row: (s) => s.index % 2 === 1 && { backgroundColor: … }` —
 *  without a render prop that repaints everything. */
export interface TableStyles<Row> {
  /** The header strip — the clipping box the header row scrolls inside. */
  header?: StyleProp;
  headerCell?: StyleProp | ((state: TableHeaderCellState<Row>) => StyleProp);
  row?: StyleProp | ((state: TableRowState<Row>) => StyleProp);
  cell?: StyleProp | ((state: TableCellState<Row>) => StyleProp);
}

/**
 * A `<Table>`'s imperative side.
 *
 * `handleKey` is the one worth knowing about: a filter box above a table
 * holds the keyboard, and forwarding the arrows to this is how the list
 * below it still walks. It reports whether the table took the key, so the
 * caller keeps whatever it did not.
 */
export interface TableHandle<Row = any> {
  focus: () => void;
  /** Select a row by id, as a click would; `null` clears an uncontrolled
   *  selection. An id naming no row is a no-op. */
  select: (id: TableRowId | null) => void;
  /** Bring a row into view. `false` when the id names nothing. */
  scrollToRow: (id: TableRowId) => boolean;
  handleKey: (ev: KeyboardEvent) => boolean;
  /** The rows in display order — the sorted model, not the rendered slice. */
  rows: () => readonly TableRow<Row>[];
}

type BoxProps = Host['box'];

interface TableBaseProps<Row> extends Omit<
  BoxProps,
  'style' | 'children' | 'ref' | 'onKeyDown'
> {
  columns?: readonly TableColumn<Row>[];
  rows?: readonly Row[];
  /** The row's key. Defaults to `row.id`, and a row that resolves no id is a
   *  remedial `TypeError` rather than a broken render. Memoize it. */
  getId?: (row: Row) => TableRowId;

  /** Controlled sort **descriptor**. Who *orders the rows* is a separate
   *  question — see {@link presorted}. */
  sort?: TableSort | null;
  defaultSort?: TableSort | null;
  onSortChange?: (sort: TableSort | null) => void;
  /**
   * The rows already arrive in display order — a server sorted them — so the
   * table only renders the sort indicator and reports toggles. Composes with
   * either descriptor mode; without it the table orders the rows itself,
   * `column.compare ?? natural order over value()`.
   */
  presorted?: boolean;

  /** The *open* gesture on top of selection — a double click, or Enter. */
  onActivate?: (id: TableRowId, row: Row) => void;
  /** Right-click on a row. The row is selected first unless it is already
   *  part of the selection — the file-manager convention, so a context menu
   *  always applies to what is under the pointer. */
  onRowContextMenu?: (id: TableRowId, row: Row, ev: MouseEvent) => void;
  /** A column was resized — by drag, or by Left/Right on the focused grip.
   *  The resize also converts the column to fixed at that width. */
  onColumnResize?: (id: string, width: number) => void;

  /**
   * Declare every row exactly this tall, in pixels — core's model: the
   * visible slice is arithmetic and nothing is ever measured. **Omit it and
   * rows are measured instead**: any row may be any height, at the cost of
   * the measure pass. `rowHeight={24}` restores core's exact behaviour.
   */
  rowHeight?: number;
  /** What an unmeasured row is assumed — and floored — at, while measuring.
   *  Default 24. The scrollbar is this guess for every row not yet seen; it
   *  converges as you scroll, and once enough rows have been measured the
   *  guess itself is re-learnt from their mean, so the scrollbar lands near
   *  the truth without visiting the whole list. */
  estimatedRowHeight?: number;
  /** Build only the rows on screen. `'auto'` (the default) turns it on past
   *  200 rows. */
  virtual?: boolean | 'auto';
  /** Rows built either side of the viewport. */
  overscan?: number;
  /**
   * Rows built *beyond* the overscan while the table sits idle, per side.
   * Default 40. The pane blits a scroll before React can run, so the only
   * scroll with no blank frame is one that lands on rows already built —
   * this band is that, grown in small steps while nobody is scrolling, and
   * kept behind the viewport so a reversal lands on rows still mounted.
   * `0` turns the band off: the slice is exactly viewport-plus-overscan.
   */
  prefetch?: number;

  /**
   * Everything inside the row box, given what would have been there.
   *
   * The row *box* stays this component's — it carries the height
   * virtualization counts on, the role and aria the table is read through,
   * and the click that selects. Style it with `styles.row`.
   */
  renderRow?: (state: TableRowState<Row>, content: ReactNode[]) => ReactNode;
  /** The body's content when the rows resolve empty. Nothing by default —
   *  the header still shows. */
  renderEmpty?: () => ReactNode;
  /**
   * The fast-scroll overlay. Shown only while a scroll has outrun the rows
   * far enough that placeholders cover a meaningful part of the viewport —
   * a scroll the table absorbs within a frame never shows it — and hidden
   * the moment the view is whole again. The default is a pill reading
   * "2,345 / 100,000"; return something else to replace it (the state
   * carries the top row, so a hint can show a date or a name instead of a
   * number), or null for no overlay at all.
   */
  renderScrollHint?: (state: TableScrollHintState<Row>) => ReactNode;

  styles?: TableStyles<Row>;
  style?: StyleProp;
  /** Whether the table is a tab stop. Default true; `false` for a table
   *  inside a popup that owns the focus. */
  focusable?: boolean;
  ref?: Ref<TableHandle<Row>>;
  /** react-x11's queries read this off `props` at run time; its element
   *  declarations do not carry it, so it is declared here and reaches the
   *  root box through the rest spread. */
  'data-testname'?: string;
}

/** Single selection — the default, and core's behaviour. */
export interface TableSingleSelectProps<Row> extends TableBaseProps<Row> {
  selectionMode?: 'single';
  selected?: TableRowId | null;
  defaultSelected?: TableRowId | null;
  onSelect?: (id: TableRowId, row: Row) => void;
}

/** Multiple selection: the file-manager grammar — click replaces, Ctrl
 *  toggles, Shift extends from the anchor, Ctrl+A takes everything. */
export interface TableMultiSelectProps<Row> extends TableBaseProps<Row> {
  selectionMode: 'multiple';
  selected?: readonly TableRowId[];
  defaultSelected?: readonly TableRowId[];
  onSelectedChange?: (
    selected: TableRowId[],
    change: TableSelectChange<Row>,
  ) => void;
}

/** Display only: no cursor, no hover, clicks select nothing. */
export interface TableStaticProps<Row> extends TableBaseProps<Row> {
  selectionMode: 'none';
}

/**
 * The props are a discriminated union on `selectionMode`, the Calendar's
 * precedent: one id and an array of ids are different shapes, and the
 * compiler walking the caller through the change is the point. The wrong
 * pairing at run time is a remedial `TypeError`, not an empty render.
 */
export type TableProps<Row = any> =
  | TableSingleSelectProps<Row>
  | TableMultiSelectProps<Row>
  | TableStaticProps<Row>;

/** Every prop of every variant, loosened — what the implementation reads
 *  after the runtime check has vouched for the pairing. */
interface TableAllProps<Row> extends TableBaseProps<Row> {
  selectionMode?: 'none' | 'single' | 'multiple';
  selected?: TableRowId | null | readonly TableRowId[];
  defaultSelected?: TableRowId | null | readonly TableRowId[];
  onSelect?: (id: TableRowId, row: Row) => void;
  onSelectedChange?: (
    selected: TableRowId[],
    change: TableSelectChange<Row>,
  ) => void;
}

const EMPTY_SET: ReadonlySet<TableRowId> = new Set();

/**
 * One row, as its own memoized component.
 *
 * The reason is the CPU profile of a fast scroll: every notch re-renders
 * the window, and re-creating a hundred rows' elements per notch — then
 * reconciling them and re-applying identical props to every node — was
 * over half the burst. Every prop here is identity-stable across a scroll
 * render (the row model is memoized, the widths resolve once, the handlers
 * are stable callbacks), so React bails out on the rows that did not
 * change and a notch pays only for the rows it brought in.
 */
interface TableRowViewProps<Row> {
  entry: TableRow<Row>;
  columns: readonly TableColumn<Row>[];
  widths: readonly number[];
  /** How many rows the table has — `aria-setsize`. */
  setSize: number;
  isSelected: boolean;
  selectable: boolean;
  uniform: boolean;
  rowHeight: number | undefined;
  estimate: number;
  theme: Theme;
  rowStyle: TableStyles<Row>['row'];
  cellStyle: TableStyles<Row>['cell'];
  renderRow?: (state: TableRowState<Row>, content: ReactNode[]) => ReactNode;
  /** Whether the app passed `onRowContextMenu` — the prop itself stays out
   *  of the row so a re-created handler does not re-render every row. */
  hasMenu: boolean;
  onTap: (
    entry: TableRow<Row>,
    mods: { ctrl: boolean; shift: boolean },
  ) => void;
  onOpen: (entry: TableRow<Row>) => void;
  onMenu: (entry: TableRow<Row>, ev: MouseEvent) => void;
  register: (id: TableRowId, at: number, node: DrawnNode | null) => void;
}

function TableRowView<Row>(props: TableRowViewProps<Row>): ReactElement {
  const {
    entry,
    columns,
    widths,
    setSize,
    isSelected,
    selectable,
    uniform,
    rowHeight,
    estimate,
    theme,
    rowStyle,
    cellStyle,
    renderRow,
    hasMenu,
    onTap,
    onOpen,
    onMenu,
    register,
  } = props;
  const color = isSelected ? theme.hoverText : theme.text;
  const state: TableRowState<Row> = { ...entry, selected: isSelected, color };

  const content: ReactNode[] = columns.map((column, at) => {
    const cellState: TableCellState<Row> = { ...state, column };
    return hx(
      'box',
      {
        key: column.id,
        role: 'cell',
        style: [
          s.cell,
          { width: widths[at] },
          uniform && { height: rowHeight },
          column.align === 'end' && {
            alignItems: 'flex-end',
            paddingEnd: 8,
          },
          column.align === 'center' && { alignItems: 'center' },
          typeof cellStyle === 'function' ? cellStyle(cellState) : cellStyle,
        ],
      },
      column.render
        ? // A cell that draws itself still has to know it is on the
          // selected row — see the doc comment. Keyed by the component,
          // the way every seam's return is.
          React.createElement(
            React.Fragment,
            { key: 'content' },
            column.render(entry.row, cellState),
          )
        : hx(
            'text',
            { style: [s.cellText, { color }] },
            String(columnValue(entry.row, column) ?? ''),
          ),
    );
  });

  return hx(
    'box',
    {
      role: 'row',
      'aria-selected': selectable ? isSelected : undefined,
      'aria-posinset': entry.index + 1,
      'aria-setsize': setSize,
      // The index the row was drawn at travels with the node, so measuring
      // does not have to search the row list for it. It can go stale — the
      // rows may move before the tick that measures — and both this and
      // the height index check it rather than trust it.
      ref: (node: DrawnNode | null) => {
        register(entry.id, entry.index, node);
      },
      onClick: (ev: MouseEvent) => {
        // A right-click also arrives here as a click; the selection it
        // implies is `onContextMenu`'s to make (select-unless-selected),
        // not the left button's replace.
        if (ev.button !== 1) return;
        onTap(entry, { ctrl: ev.ctrlKey, shift: ev.shiftKey });
        // Select on the first click, open on the second — the gesture
        // every file list has. `detail` is the click count the renderer
        // already counts for text selection.
        if (ev.detail === 2) onOpen(entry);
      },
      onContextMenu: hasMenu
        ? (ev: MouseEvent) => {
            onMenu(entry, ev);
          }
        : undefined,
      style: [
        s.row,
        // Declared uniform: exactly this tall, content clipped — core's
        // row. Measured: a floor, and the row grows to whatever its
        // content needs; the height index reads back what it became.
        uniform
          ? { height: rowHeight, alignItems: 'center' }
          : { minHeight: estimate },
        selectable && { cursor: 'pointer' },
        {
          backgroundColor: isSelected ? theme.hoverBackground : 'transparent',
          // The row's ink, said once: `color` inherits, so default cells
          // take it without being handed it.
          color,
        },
        selectable && {
          // pressed even on the selected row: a re-press on the row that
          // is already current is the one click in the table that would
          // otherwise look ignored
          ':active': {
            backgroundColor: isSelected
              ? theme.accentActive
              : theme.surfaceActive,
          },
        },
        selectable &&
          !isSelected && {
            ':hover': { backgroundColor: theme.surfaceHover },
          },
        typeof rowStyle === 'function' ? rowStyle(state) : rowStyle,
      ],
    },
    renderRow ? renderRow(state, content) : content,
  );
}

const MemoTableRow = React.memo(TableRowView) as typeof TableRowView;

/**
 * `<Table columns rows />` — a data table with a header that stays put.
 *
 *     <Table
 *       columns={[{ id: 'name', label: 'Name', flex: 1 }]}
 *       rows={[{ id: 1, name: 'index.ts' }]}
 *     />
 *
 * Columns are `{ id, label, width | flex, align, value, render }` — core's
 * shape. `value(row)` feeds sorting and the default cell text;
 * `render(row, state)` replaces the cell entirely, and the state says
 * whether it is on the selected row, because that row is a filled bar and a
 * colour chosen against the resting background is unreadable on it. A
 * column declaring neither `width` nor `flex` stretches (`flex: 1`, floored
 * at 120px), so a table with no sizing config fills its box.
 *
 * Sorting is uncontrolled unless you pass `sort`; the header reports
 * `onSortChange` either way, and `presorted` says the rows already arrive
 * ordered. Selection is single by default (`selected` + `onSelect`),
 * `selectionMode="multiple"` for the set (`selected` + `onSelectedChange`),
 * `"none"` for display. `onActivate` is the *open* gesture on top — a double
 * click or Enter.
 *
 * The table is a single tab stop; Up/Down walk the rows, PageUp/PageDown
 * move by a viewport, Home/End jump, Shift extends in multiple mode, Space
 * toggles there, Ctrl+A takes everything. **The focus is on the table, not
 * the row** — a virtualized row is unmounted the moment it scrolls out and
 * focus would go with it, so the selection is the cursor. The honest caveat:
 * while virtualizing, only the rendered rows are in the accessibility tree —
 * the same rows a sighted user can see.
 */
export function Table<Row = any>(props: TableProps<Row>): ReactElement {
  const {
    columns = [],
    rows = [],
    getId,
    sort,
    defaultSort,
    onSortChange,
    presorted = false,
    onActivate,
    onRowContextMenu,
    onColumnResize,
    rowHeight,
    estimatedRowHeight,
    virtual = 'auto',
    overscan = DEFAULT_OVERSCAN,
    prefetch = DEFAULT_PREFETCH,
    renderRow,
    renderEmpty,
    renderScrollHint,
    styles,
    style,
    focusable = true,
    ref,
    selectionMode = 'single',
    selected,
    defaultSelected,
    onSelect,
    onSelectedChange,
    // ours to chain rather than to hand over: virtualization and the sticky
    // header are measured through both of these
    onScroll,
    onViewport,
    ...boxProps
  } = props as TableAllProps<Row>;

  // The union keeps a caller honest at compile time; this keeps a caller
  // honest who got the props from somewhere the compiler could not see.
  if (selectionMode === 'multiple') {
    if (selected !== undefined && !Array.isArray(selected)) {
      throw new TypeError(
        '<Table selectionMode="multiple"> takes `selected` as an array of ' +
          'ids. Pass `selected={[id]}`, or drop selectionMode for single ' +
          'selection.',
      );
    }
    if (defaultSelected !== undefined && !Array.isArray(defaultSelected)) {
      throw new TypeError(
        '<Table selectionMode="multiple"> takes `defaultSelected` as an ' +
          'array of ids.',
      );
    }
  } else if (Array.isArray(selected) || Array.isArray(defaultSelected)) {
    throw new TypeError(
      `<Table> got an array for \`selected\` but selectionMode is ` +
        `'${selectionMode}' — pass selectionMode="multiple", or one id.`,
    );
  }

  const theme = useTheme();
  const rtl = useDirection() === 'rtl';
  const [ownSort, setOwnSort] = useState<TableSort | null>(defaultSort ?? null);
  const [ownSingle, setOwnSingle] = useState<TableRowId | null>(() =>
    Array.isArray(defaultSelected)
      ? null
      : ((defaultSelected as TableRowId | null | undefined) ?? null),
  );
  const [ownMulti, setOwnMulti] = useState<readonly TableRowId[]>(() =>
    Array.isArray(defaultSelected) ? defaultSelected : [],
  );
  /** The keyboard cursor in multiple mode; in single mode the selection is
   *  the cursor. */
  const [cursorId, setCursorId] = useState<TableRowId | null>(null);
  const [userWidths, setUserWidths] = useState<
    Readonly<Record<string, number>>
  >({});
  const [scrollX, setScrollX] = useState(0);
  // Bumped by a measurement pass that found a row taller or shorter than the
  // index believed. It is the only reason the component re-renders for a
  // measurement, and a pass that finds nothing new does not bump it — which
  // is what makes measure → render → measure converge instead of spinning.
  const [, setMeasured] = useState(0);

  const readId = useMemo(() => resolveGetId<Row>(getId), [getId]);
  const activeSort = sort === undefined ? ownSort : sort;

  const ordered = useMemo(
    () => orderRows(rows, columns, readId, activeSort, presorted),
    [rows, columns, readId, activeSort, presorted],
  );

  const selectedIds: ReadonlySet<TableRowId> = useMemo(() => {
    if (selectionMode === 'none') return EMPTY_SET;
    if (selectionMode === 'multiple') {
      const list =
        selected === undefined ? ownMulti : (selected as readonly TableRowId[]);
      return new Set(list);
    }
    const one =
      selected === undefined ? ownSingle : (selected as TableRowId | null);
    return one === null || one === undefined ? EMPTY_SET : new Set([one]);
  }, [selectionMode, selected, ownMulti, ownSingle]);

  const cursor =
    selectionMode === 'multiple'
      ? cursorId
      : selected === undefined
        ? ownSingle
        : (selected as TableRowId | null);

  // Held-down or fast keys arrive in a burst, and every handler in that
  // burst sees the render it started from — so the order, the selection and
  // the cursor are mirrored here and updated the moment they change, or
  // three Downs in a row all step off the same starting point.
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  /** Where a Shift range grows from — the last plain click or plain step. */
  const anchorRef = useRef<TableRowId | null>(null);

  const root = useRef<DrawnNode | null>(null);
  const body = useRef<ScrollableNode | null>(null);
  /** The rows on screen, by id — with the index each was drawn at, so a
   *  measurement pass does not have to search the row list for it. */
  const rowNodes = useRef(
    new Map<TableRowId, { node: DrawnNode; at: number }>(),
  );
  const drag = useRef<{ id: string; from: number; width: number } | null>(null);
  /** Whether the fast-scroll pill is up — kept across renders so it does not
   *  flicker through a catch-up, only appearing and disappearing once. */
  const hintShown = useRef(false);
  const userWidthsRef = useRef(userWidths);
  userWidthsRef.current = userWidths;

  /** Declared uniform: divide, never measure — core's model. */
  const uniform = rowHeight !== undefined;
  const estimate = rowHeight ?? estimatedRowHeight ?? ROW_HEIGHT;
  // `useState` for its lazy initializer rather than `useRef`: one index per
  // mounted table, built once. Nothing ever calls the setter — what it holds
  // is mutable and its changes are announced through `setMeasured`. With
  // `rowHeight` declared nothing is ever measured, every height stays the
  // estimate, and the index computes exactly `i * rowHeight` — one code
  // path for both models.
  const [heights] = useState(() => new RowHeights(estimate));
  heights.sync(ordered, estimate);

  const virtualizing =
    virtual === true ||
    (virtual === 'auto' && ordered.length > VIRTUAL_THRESHOLD);

  /** The viewport, and the slice worth building from it — the machinery
   *  shared with `<Tree>` (`../internal/window.ts`). */
  const win = useVirtualWindow({
    box: body,
    heights,
    rows: ordered,
    // declared uniform: every height is exact, so the idle band may grow
    // upward freely — see `exact` on the inputs
    exact: uniform,
    virtualizing,
    overscan,
    prefetch,
  });
  const { view, viewRef } = win;
  const { first, last, above, below } = win.slice;

  /** Columns resolve to pixels once, at the table level, per (columns,
   *  viewport, resizes) — every row agrees on the grid by construction. */
  const { widths, total } = useMemo(
    () => resolveWidths(columns, userWidths, view.width),
    [columns, userWidths, view.width],
  );

  /**
   * The scroll the table owes a row, and the pane's real offset read back
   * after every layout — the two halves of `../internal/scroll.ts`, which
   * says why a reveal cannot be a one-shot and why `onScroll` is not the
   * whole story.
   */
  const reveal = useReveal({
    box: body,
    rows: orderedRef,
    nodes: rowNodes,
    heights,
  });

  /**
   * Re-read the offset the body is *actually* at — the window's `sync` (see
   * `../internal/window.ts` for why the pane moves silently), plus the
   * horizontal half only this component has: the header is shifted by
   * `scrollX`, so the sideways offset is re-read on the same tick.
   */
  const winSync = win.sync;
  const syncScroll = useCallback((): void => {
    const box = body.current;
    if (!box) return;
    const x = box.scrollX;
    setScrollX((prev) => (prev === x ? prev : x));
    winSync();
  }, [winSync]);

  /**
   * Read back what the rows on screen actually laid out at.
   *
   * Runs a tick after the commit because layout runs on the frame flush —
   * an effect reads the *previous* pass's geometry (see ./timers.ts).
   * Idempotent: a row whose measurement has not changed reports no change,
   * so the second pass over the same rows re-renders nothing. Rows above
   * the viewport anchor shift the scroll offset by their delta, or
   * measuring a row already scrolled past yanks the list under the pointer.
   */
  const measureRows = useCallback((): boolean => {
    if (uniform || !virtualizing) return false;
    // Before the first `onViewport` the flex columns sit on their floors and
    // every row is laid out against a width that is about to change — there
    // is nothing honest to measure yet.
    if (viewRef.current.width <= 0) return false;
    // A row laid out at a width the columns no longer resolve to is a
    // measurement of the wrong table, and it must not be recorded — a row
    // that scrolls out before the corrected pass would keep a wrong-width
    // height forever. The expectation is recomputed from event-fresh inputs
    // rather than read from the last render: this tick runs *between* an
    // `onViewport` and the re-render it causes, which is exactly when the
    // rendered state is stale. The tree never needs any of this: its row
    // width never depends on a resolved column model.
    const expected = resolveWidths(
      columnsRef.current,
      userWidthsRef.current,
      viewRef.current.width,
    ).total;
    const box = body.current;
    const rows = orderedRef.current;
    const anchor = box ? heights.indexAt(box.scrollY) : 0;
    let shift = 0;
    let changed = false;
    for (const [id, { node, at }] of rowNodes.current) {
      if (rows[at]?.id !== id) continue; // drawn against a list that moved
      if (node.abs.width !== expected) continue;
      const height = node.abs.height;
      const was = heights.heightAt(at);
      if (!heights.measure(id, at, height)) continue;
      changed = true;
      if (at < anchor) shift += height - was;
    }
    if (!changed) return false;
    // A debt, not a one-shot: the pane clamps against the last layout's
    // content height, so a shift from rows measured above the viewport can
    // land short until the layout that admits the growth has run.
    reveal.nudge(shift);
    setMeasured((n) => n + 1);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `heights` is a
    // stable instance
  }, [uniform, virtualizing]);

  /**
   * Let the estimate learn from the rows that have been measured — the
   * scrollbar of a measured table starts as a guess times the row count,
   * and the measured mean is a far better guess for the rows not yet seen.
   * Idle only: every unmeasured offset moves when it applies, and the
   * anchor arithmetic keeping the screen still is `measureRows`'s.
   */
  const adaptEstimate = useCallback((): boolean => {
    if (uniform || !virtualizing) return false;
    const box = body.current;
    if (!box) return false;
    const anchor = heights.indexAt(box.scrollY);
    const before = heights.offsetAt(anchor);
    if (!heights.adapt()) return false;
    reveal.nudge(heights.offsetAt(anchor) - before);
    setMeasured((n) => n + 1);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `heights` and
    // `reveal` are stable instances
  }, [uniform, virtualizing]);

  /**
   * The one tick after layout, and everything that can only be known there:
   * what the rows measured, whether an owed scroll can go further now that
   * the new rows are laid out, and where the body actually ended up. In that
   * order — each step can move the offset the next one reads.
   *
   * Scheduled for every render a virtualized table makes, because every one
   * of them can move the offset its next slice is built from. A whole table
   * needs none of it: `onViewport` is when its content can have been
   * re-clamped, and it rebuilds no slice anyway.
   */
  /** Whether some drawn row has no size yet — a commit can land between
   *  frame flushes, and a measure pass over it reads zeros. */
  const rowsPendingLayout = useCallback((): boolean => {
    if (uniform) return false;
    const rows = orderedRef.current;
    for (const [id, { node, at }] of rowNodes.current) {
      if (rows[at]?.id === id && !(node.abs.height > 0)) return true;
    }
    return false;
  }, [uniform]);

  useEffect(() => {
    if (!virtualizing) return undefined;
    let look: DelayTick = null;
    let tries = 0;
    const pass = (): void => {
      // `measureRows` first, and its answer handed on: a pass that moved the
      // heights has not settled anything, and an owed scroll judged against
      // the layout it is about to invalidate is not owed any less. During a
      // flick nothing is measured at all — every correction at that speed is
      // invalidated by the next event — and the settle tick that follows any
      // burst is where the deferred passes catch up.
      const moved = win.fast() ? false : measureRows();
      const adapted = !win.scrolling() && adaptEstimate();
      reveal.retry(moved || adapted);
      syncScroll();
      // A commit can land between frame flushes: its rows report zero size
      // until the flush, this tick has already run, and nothing else would
      // come back for them — a window that just finished growing renders
      // nothing further, and the missed measurements would stand for good.
      // Look again, briefly, while any drawn row is still unsized.
      if (rowsPendingLayout() && tries++ < 8) look = later(pass, 16);
    };
    const id = afterLayout(pass);
    return () => {
      cancelAfterLayout(id);
      cancelLater(look);
    };
  });

  /** Put a row in view, by the index its call site already has. */
  const revealAt = useCallback(
    (at: number): void => {
      const row = orderedRef.current[at];
      if (row) reveal.to(row.id);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `reveal` is a
      // stable handle
    },
    [reveal],
  );

  const commitSingle = useCallback(
    (row: TableRow<Row>): void => {
      cursorRef.current = row.id;
      if (selected === undefined) setOwnSingle(row.id);
      onSelect?.(row.id, row.row);
    },
    [selected, onSelect],
  );

  const commitMulti = useCallback(
    (ids: TableRowId[], change: TableSelectChange<Row>): void => {
      selectedRef.current = new Set(ids);
      if (selected === undefined) setOwnMulti(ids);
      onSelectedChange?.(ids, change);
    },
    [selected, onSelectedChange],
  );

  /**
   * One gesture, pointer or keyboard: land on a row, with modifiers.
   * Multiple mode is the file-manager grammar — plain replaces and moves the
   * anchor, Ctrl toggles, Shift extends from the anchor. The cursor and the
   * anchor are **ids, not indexes**, so a re-sort moves the rows, not the
   * user's place.
   */
  const tap = useCallback(
    (row: TableRow<Row>, mods: { ctrl: boolean; shift: boolean }): void => {
      if (selectionMode === 'none') return;
      if (selectionMode === 'single') {
        commitSingle(row);
        revealAt(row.index);
        return;
      }
      cursorRef.current = row.id;
      setCursorId(row.id);
      const anchor = anchorRef.current;
      if (mods.shift && anchor !== null) {
        const all = orderedRef.current;
        let a = all.findIndex((r) => r.id === anchor);
        let b = row.index;
        if (a < 0) a = b;
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        commitMulti(
          all.slice(lo, hi + 1).map((r) => r.id),
          { type: 'range', id: row.id, row: row.row },
        );
      } else if (mods.ctrl) {
        const next = new Set(selectedRef.current);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        anchorRef.current = row.id;
        commitMulti([...next], { type: 'toggle', id: row.id, row: row.row });
      } else {
        anchorRef.current = row.id;
        commitMulti([row.id], { type: 'replace', id: row.id, row: row.row });
      }
      revealAt(row.index);
    },
    [selectionMode, commitSingle, commitMulti, revealAt],
  );

  const activate = useCallback(
    (row: TableRow<Row>): void => {
      onActivate?.(row.id, row.row);
    },
    [onActivate],
  );

  const toggleSort = (column: TableColumn<Row>): void => {
    const next: TableSort =
      activeSort?.column === column.id && activeSort.direction === 'asc'
        ? { column: column.id, direction: 'desc' }
        : { column: column.id, direction: 'asc' };
    if (sort === undefined) setOwnSort(next);
    onSortChange?.(next);
  };

  const resize = (column: TableColumn<Row>, width: number): void => {
    const next = Math.max(column.minWidth ?? MIN_COLUMN, Math.round(width));
    if (userWidthsRef.current[column.id] === next) return;
    const map = { ...userWidthsRef.current, [column.id]: next };
    userWidthsRef.current = map;
    setUserWidths(map);
    onColumnResize?.(column.id, next);
  };

  const resizeProps = (column: TableColumn<Row>, resolved: number) => ({
    // The handle takes focus on the press, so it is in the tab order whether
    // or not it answers a key. Left/Right, the pair `SplitPane`'s divider
    // takes; the table's own keys are Up/Down and never collide.
    focusable: true,
    onMouseDown: (ev: MouseEvent) => {
      drag.current = { id: column.id, from: ev.x, width: resolved };
      ev.capturePointer();
    },
    onMouseMove: (ev: MouseEvent) => {
      const d = drag.current;
      if (!d || d.id !== column.id) return;
      // dragging the grip away from the column's own start edge widens it,
      // and which way that is follows the layout
      resize(column, d.width + (rtl ? d.from - ev.x : ev.x - d.from));
    },
    onMouseUp: () => {
      drag.current = null;
    },
    onKeyDown: (ev: KeyboardEvent) => {
      const narrower = rtl ? XK_RIGHT : XK_LEFT;
      const wider = rtl ? XK_LEFT : XK_RIGHT;
      if (ev.keysym === narrower) resize(column, resolved - STEP);
      else if (ev.keysym === wider) resize(column, resolved + STEP);
    },
  });

  /** Returns whether the key was the table's, so a control that forwards its
   *  keys here keeps the ones it did not use. */
  const handleKey = useCallback(
    (ev: KeyboardEvent): boolean => {
      const rows = orderedRef.current;
      if (!rows.length || selectionMode === 'none') return false;
      const at = rows.findIndex((r) => r.id === cursorRef.current);
      const clamp = (i: number): number =>
        Math.max(0, Math.min(rows.length - 1, i));
      const move = (to: number): void => {
        const row = rows[clamp(to)];
        if (row) {
          tap(row, {
            ctrl: false,
            shift: selectionMode === 'multiple' && ev.shiftKey,
          });
        }
      };
      /**
       * How far a page key moves, in rows — with measured heights that is
       * not a division: it is "where does this row's offset land after a
       * viewport", with one row of overlap kept, and never standing still
       * even when a row is taller than the viewport.
       */
      const pageFrom = (from: number, dir: number): number => {
        const viewport = viewRef.current.height;
        if (viewport <= 0) return from + dir;
        const here = clamp(from);
        const target =
          heights.offsetAt(here) + dir * Math.max(1, viewport - estimate);
        const landed = heights.indexAt(Math.max(0, target));
        return landed === here ? here + dir : landed;
      };

      switch (ev.keysym) {
        case XK_UP:
          move((at < 0 ? rows.length : at) - 1);
          return true;
        case XK_DOWN:
          move((at < 0 ? -1 : at) + 1);
          return true;
        case XK_PAGE_UP:
          move(pageFrom(at < 0 ? 0 : at, -1));
          return true;
        case XK_PAGE_DOWN:
          move(pageFrom(at < 0 ? 0 : at, 1));
          return true;
        case XK_HOME:
          move(0);
          return true;
        case XK_END:
          move(rows.length - 1);
          return true;
        case XK_RETURN: {
          const row = rows[at];
          if (row) activate(row);
          return true;
        }
        default:
          break;
      }
      if (ev.codepoint === 32) {
        const row = rows[at];
        if (!row) return false;
        if (selectionMode === 'multiple')
          tap(row, { ctrl: true, shift: false });
        else activate(row);
        return true;
      }
      if (
        selectionMode === 'multiple' &&
        ev.ctrlKey &&
        (ev.key === 'a' || ev.key === 'A')
      ) {
        commitMulti(
          rows.map((r) => r.id),
          { type: 'all' },
        );
        return true;
      }
      return false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `heights` is
      // a stable instance
    },
    [selectionMode, tap, activate, commitMulti, estimate],
  );

  useImperativeHandle(
    ref,
    (): TableHandle<Row> => ({
      focus: () => {
        root.current?.focus();
      },
      select: (id) => {
        if (id === null) {
          cursorRef.current = null;
          setCursorId(null);
          anchorRef.current = null;
          if (selected !== undefined) return; // controlled: the caller owns it
          if (selectionMode === 'multiple') setOwnMulti([]);
          else setOwnSingle(null);
          return;
        }
        const row = orderedRef.current.find((r) => r.id === id);
        if (row) tap(row, { ctrl: false, shift: false });
      },
      scrollToRow: (id) => {
        const row = orderedRef.current.find((r) => r.id === id);
        if (!row) return false;
        revealAt(row.index);
        return true;
      },
      handleKey,
      rows: () => orderedRef.current,
    }),
    [tap, handleKey, revealAt, selectionMode, selected],
  );

  // --- rendering -----------------------------------------------------------

  const rowStyleProp = styles?.row;
  const cellStyleProp = styles?.cell;
  const headerCellStyleProp = styles?.headerCell;
  const selectable = selectionMode !== 'none';

  // The row component's stable halves — `MemoTableRow` bails out of a
  // re-render only if every prop kept its identity, and these are the two
  // that would otherwise be rebuilt per row per render.
  const registerRow = useCallback(
    (id: TableRowId, at: number, node: DrawnNode | null): void => {
      if (node) rowNodes.current.set(id, { node, at });
      else rowNodes.current.delete(id);
    },
    [],
  );
  const rowMenu = useCallback(
    (entry: TableRow<Row>, ev: MouseEvent): void => {
      // The menu applies to what is under the pointer, so the row is
      // selected first — unless it is already part of the selection,
      // which a menu over "the selected files" must not collapse.
      if (selectable && !selectedRef.current.has(entry.id)) {
        tap(entry, { ctrl: false, shift: false });
      }
      onRowContextMenu?.(entry.id, entry.row, ev);
    },
    [selectable, tap, onRowContextMenu],
  );

  /**
   * A row the window said not to build in full yet: the box at its indexed
   * height and none of its content. Cheap on purpose — no cells, no text, no
   * seams — so the commit answering a flood lands frames before the full
   * rows could, and what blits in reads as rows arriving rather than a
   * void. `styles.row` still applies, so zebra striping and row backgrounds
   * hold. Not registered in `rowNodes`: a skeleton must not be measured
   * into the height index, and cannot satisfy a reveal.
   */
  const renderSkeletonRow = (entry: TableRow<Row>): ReactElement => {
    const isSelected = selectedIds.has(entry.id);
    const state: TableRowState<Row> = {
      ...entry,
      selected: isSelected,
      color: isSelected ? theme.hoverText : theme.text,
    };
    return hx(
      'box',
      {
        key: String(entry.id),
        'aria-hidden': true,
        style: [
          s.row,
          // Exactly what the index believes, so the spacers and the
          // scrollbar agree with the rows on where everything is.
          { height: heights.heightAt(entry.index) },
          {
            backgroundColor: isSelected ? theme.hoverBackground : 'transparent',
          },
          typeof rowStyleProp === 'function'
            ? rowStyleProp(state)
            : rowStyleProp,
        ],
      },
      // A line of "text" with no text. Width varied by index, so a band of
      // placeholders reads as rows arriving rather than a repeated tile.
      hx('box', {
        key: 'bar',
        style: [
          s.skeletonBar,
          {
            width: 96 + ((entry.index * 37) % 89),
            backgroundColor: theme.track,
          },
        ],
      }),
    );
  };

  const headerCells = columns.map((column, at) => {
    const canSort = column.sortable !== false;
    const headerState: TableHeaderCellState<Row> = {
      column,
      sort: activeSort,
      resolvedWidth: widths[at],
    };
    const isLast = at === columns.length - 1;
    return React.createElement(
      React.Fragment,
      { key: column.id },
      hx(
        'box',
        {
          role: 'columnheader',
          focusable: true,
          onClick: canSort ? () => toggleSort(column) : undefined,
          style: [
            s.header,
            // The header cell and the grab band are **siblings**, not a cell
            // with a handle inside it — a click fires on the nearest common
            // ancestor of press and release, so a grip nested in the header
            // made every resize end in a sort. The band is centred on the
            // rule and takes HALF from the column on each side, so every
            // header but the first is inset by that much.
            {
              width: Math.max(0, widths[at] - HALF - RULE - (at ? HALF : 0)),
            },
            canSort && { cursor: 'pointer' },
            typeof headerCellStyleProp === 'function'
              ? headerCellStyleProp(headerState)
              : headerCellStyleProp,
          ],
        },
        column.renderHeader
          ? React.createElement(
              React.Fragment,
              { key: 'content' },
              column.renderHeader(headerState),
            )
          : [
              hx(
                'text',
                {
                  key: 'label',
                  style: [s.headerLabel, { color: theme.text }],
                },
                column.label ?? column.id,
              ),
              hx('box', { key: 'spring', style: s.headerSpring }),
              activeSort?.column === column.id
                ? React.createElement(Icon, {
                    key: 'mark',
                    name:
                      activeSort.direction === 'asc'
                        ? 'chevronUp'
                        : 'chevronDown',
                    size: SORT_MARK,
                    color: theme.textMuted,
                    style: s.sortMark,
                  })
                : null,
            ],
      ),
      // The band is invisible until the pointer is on it, and answers the
      // press itself — a captured press keeps `:active` for the whole drag,
      // wherever the pointer wanders. The rule is its child, so the lit band
      // is symmetric about the line it moves.
      hx(
        'box',
        {
          ...resizeProps(column, widths[at]),
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': `Resize ${column.label || column.id}`,
          'aria-valuenow': widths[at],
          'aria-valuemin': column.minWidth ?? MIN_COLUMN,
          style: [
            s.grip,
            {
              width: isLast ? HALF + RULE : GRIP,
              justifyContent: isLast ? 'flex-end' : 'center',
            },
            { backgroundColor: 'transparent' },
            { ':hover': { backgroundColor: theme.track } },
            { ':active': { backgroundColor: theme.accent } },
          ],
        },
        hx('box', { style: [s.rule, { backgroundColor: theme.border }] }),
      ),
    );
  });

  const bodyChildren: ReactNode[] = [];
  if (ordered.length === 0) {
    if (renderEmpty) {
      bodyChildren.push(
        hx('box', { key: 'empty', style: s.empty }, renderEmpty()),
      );
    }
  } else {
    if (virtualizing && first > 0) {
      bodyChildren.push(
        hx('box', {
          key: 'spacer:before',
          style: [s.spacer, { height: above }],
        }),
      );
    }
    for (let i = first; i < last; i++) {
      const entry = ordered[i];
      bodyChildren.push(
        win.skeletons.has(entry.id)
          ? renderSkeletonRow(entry)
          : React.createElement(
              MemoTableRow as (p: TableRowViewProps<Row>) => ReactElement,
              {
                key: String(entry.id),
                entry,
                columns,
                widths,
                setSize: ordered.length,
                isSelected: selectedIds.has(entry.id),
                selectable,
                uniform,
                rowHeight,
                estimate,
                theme,
                rowStyle: rowStyleProp,
                cellStyle: cellStyleProp,
                renderRow,
                hasMenu: Boolean(onRowContextMenu),
                onTap: tap,
                onOpen: activate,
                onMenu: rowMenu,
                register: registerRow,
              },
            ),
      );
    }
    if (virtualizing && last < ordered.length) {
      bodyChildren.push(
        hx('box', {
          key: 'spacer:after',
          style: [s.spacer, { height: below }],
        }),
      );
    }
  }

  /**
   * The fast-scroll overlay — shown only while placeholders cover enough of
   * the viewport that the user would otherwise be looking at blank rows.
   * The half-viewport threshold keeps a near-miss quiet: a scroll the next
   * frame will absorb is not worth announcing. Once up it stays until the
   * view is whole again, so it does not flicker through the catch-up.
   */
  let scrollHint: ReactNode = null;
  if (virtualizing && ordered.length > 0 && view.height > 0) {
    const vFirst = heights.indexAt(view.top);
    const vLast = Math.min(
      ordered.length - 1,
      heights.indexAt(view.top + view.height),
    );
    // Two ways in: placeholders covering enough of the viewport that it
    // would otherwise read as blank, or a scrub — the window teleporting
    // while the burst is still in flight, where every commit chases a
    // viewport that has already left and nothing useful can be on screen.
    // Latched once triggered: `pending` bounces to zero between catch-up
    // commits, and a pill that blinked with it would read as a glitch. It
    // goes when the burst does.
    const show =
      (win.pending > 0 && win.pending * 2 >= vLast - vFirst + 1) ||
      (win.jumped && win.scrolling()) ||
      (hintShown.current && (win.pending > 0 || win.scrolling()));
    hintShown.current = show;
    if (show) {
      const hintState: TableScrollHintState<Row> = {
        row: ordered[vFirst],
        from: vFirst + 1,
        to: vLast + 1,
        count: ordered.length,
        pending: win.pending,
      };
      const content = renderScrollHint
        ? renderScrollHint(hintState)
        : hx(
            'text',
            { style: { fontSize: 11, color: theme.hoverText } },
            `${hintState.from.toLocaleString()} / ${hintState.count.toLocaleString()}`,
          );
      if (content !== null && content !== undefined && content !== false) {
        scrollHint = hx(
          'box',
          {
            key: 'scroll-hint',
            // The pill duplicates what the scrollbar already tells an
            // assistive technology, and it comes and goes with the catch-up
            // — chatter, not content.
            'aria-hidden': true,
            style: s.scrollHintLane,
          },
          hx(
            'box',
            {
              style: [s.scrollHint, { backgroundColor: theme.hoverBackground }],
            },
            content,
          ),
        );
      }
    }
  } else {
    hintShown.current = false;
  }

  return hx(
    'box',
    {
      theme,
      // The table role, with the honest caveat that virtualization keeps
      // only the rendered rows in the accessible tree. `aria-label` via
      // boxProps names the table.
      role: 'table',
      // the *table* takes focus, not the row — see the doc comment
      focusable,
      ...boxProps,
      ref: root,
      style: [s.root, style],
      /**
       * `preventDefault` is the load-bearing half: the focused table sits
       * over a scroll container with default key actions of its own, and
       * without it every arrow both moved the selection and scrolled the
       * list under it. A key the table did not take keeps its default.
       */
      onKeyDown: (ev) => {
        if (handleKey(ev)) ev.preventDefault();
      },
    },
    // the header scrolls sideways with the body but never vertically, so it
    // lives outside the scrolling pane and is shifted by the body's scrollX —
    // `marginStart`, so it tracks in the direction the columns actually run
    hx(
      'box',
      {
        style: [
          s.headerClip,
          { backgroundColor: theme.surfaceHover },
          styles?.header,
        ],
      },
      hx(
        'box',
        { style: [s.headerRow, { marginStart: -scrollX, width: total }] },
        headerCells,
      ),
    ),
    hx(
      'box',
      {
        ref: body,
        style: s.body,
        onScroll: (ev) => {
          // A scroll this component did not ask for is the user taking over,
          // and an owed `scrollToRow` must not yank the list back out from
          // under them on the next layout.
          reveal.heard(ev.scrollY);
          setScrollX((prev) => (prev === ev.scrollX ? prev : ev.scrollX));
          win.scrolled(ev.scrollY);
          onScroll?.(ev);
        },
        // Layout, not scrolling, is what first tells a table how much of it
        // is worth building — and the viewport width is what the flex
        // columns resolve against, so this is measured whether or not the
        // table virtualizes.
        onViewport: (ev) => {
          win.sized(ev.width, ev.height);
          // The content just changed size, which is both the moment an owed
          // scroll can reach further than the clamp let it and the moment the
          // container may have re-clamped the offset without saying so. It is
          // not a moment anything can be *settled* in while rows are still
          // being measured: this runs from layout, a tick before the pass that
          // reads those rows back.
          reveal.retry(virtualizing && !uniform);
          syncScroll();
          onViewport?.(ev);
        },
      },
      hx('box', { style: [s.rowsBox, { width: total }] }, bodyChildren),
    ),
    scrollHint,
  );
}
