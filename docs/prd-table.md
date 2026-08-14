# PRD: `src/table/` — the data table, and the end of core's `<Table>`

Status: proposed. Nothing is implemented; this document records the
prior-art research and the design decisions, the way `prd-charts.md` does
for charts. Core's `<Table>` is expected to be decommissioned or stripped
to a trivial grid once this ships — the design here is written as its
successor, not as a second table.

## What it is

A data-driven table: columns as data, rows from the app's own objects,
selection and sorting controlled or uncontrolled, a seam at every visible
part, and virtualization that does not require uniform row heights.

```tsx
import { Table } from '@react-x11/components/table';

<Table
  rows={files}
  columns={[
    { id: 'name', label: 'Name', flex: 1 },
    {
      id: 'size',
      label: 'Size',
      width: 96,
      align: 'right',
      value: (f) => formatBytes(f.bytes),
    },
    {
      id: 'modified',
      label: 'Modified',
      width: 160,
      value: (f) => f.mtime.toLocaleString(),
    },
  ]}
  onActivate={(id, file) => open(file)}
  style={{ flexGrow: 1, minHeight: 0 }}
/>;
```

That is the whole basic setup. It buys: a header strip that stays put and
tracks horizontal scroll, sort on header click, selection on row click,
activation on double-click or Enter, resizable columns, theme colours, and
— past 200 rows — windowed rendering. Everything else is opt-in on the same
element; there is no second API to graduate to.

## Prior art, and what it settles

The survey behind this design:
[Radix Themes Table](https://www.radix-ui.com/themes/docs/components/table),
[Chakra UI Table](https://chakra-ui.com/docs/components/table),
[Untitled UI React tables](https://www.untitledui.com/react/components/tables),
[React Aria Table](https://react-aria.adobe.com/Table),
[TanStack Table](https://tanstack.com/table/v8/docs/introduction).

**Radix and Chakra are presentation only.** Both compose styled mirrors of
the HTML table element (`Table.Root/Header/Body/Row/Cell`, plus Chakra's
`ScrollArea`, `Caption`, `Footer`). No data binding, no sorting, no
selection, no virtualization — rows are `items.map(...)` in userland, and
behaviour is explicitly somebody else's problem (Chakra's docs point at
TanStack). The basic case is ~15 lines of JSX; the complicated case is
"bring your own everything". Chakra's root-level skin switches (`striped`,
`interactive`, `showColumnBorder`, `size`) are how a styled-system library
spells what this package spells as `styles` functions.

**Untitled UI is an application kit above the table.** Card chrome, badges,
avatars, pagination buttons, row-action dropdown menus — distributed by
copying source, with React Aria underneath doing the actual table work. It
marks the layer this component must stay _below_: cards and action menus
are the app's, or a future recipe's; they are not table API.

**React Aria owns the behaviour layer.** Sorting is
`sortDescriptor`/`onSortChange` with per-column `allowsSorting`; selection
is `selectionMode` + `selectedKeys`/`onSelectionChange`; rows come from
`items` plus a render function. That controlled/uncontrolled grammar is the
right one, and this package already speaks its dialect —
`selected`/`defaultSelected`/`onSelect(id, item)` on `<Tree>`,
`sort`/`defaultSort`/`onSortChange` on core's `<Table>` — so the successor
keeps the house spelling rather than importing Aria's. Aria's cell-level
focus grid is the one part deliberately not taken: it is a web-accessibility
posture; desktop tables navigate by row, and the row cursor is the
selection (§Keyboard).

**TanStack is the far end.** Headless column defs + row models +
`flexRender` plumbing: maximal power, zero markup, and its own docs are
frank that the cost is setup. Two of its ideas are load-bearing here —
columns as _data_, and the row model as a pure module — without adopting
the hook-assembly surface.

Three conclusions settle the shape:

1. **Column geometry must be first-class API.** Every library above
   delegates column sizing to the browser's table layout algorithm. There
   is no such engine here — yoga lays out flex boxes — so the column model
   (`width`/`flex`/`minWidth`, resolved to pixels by the table, §Columns)
   is the part of the API that has no web precedent to copy.
2. **Virtualization requires owning the row model.** You cannot window
   arbitrary JSX children; every virtualizing design (Aria collections,
   TanStack row models, this repo's `<Tree>`) is data-driven. That decides
   data-driven over Radix-style composition for the primary API.
3. **Part composition is off-grammar in this package anyway.** No JSX in
   `src/`, no component imports another component, and the established
   escape hatch is accessors + render props + a `styles` bag ("every
   visible part a seam" — the bar `<Tree>` set, `AGENTS.md` §"Replacing a
   core widget"). A charts-style route — null-rendering `<TableColumn>`
   config children, introspected like `LineSeries` — was considered and
   rejected: it is a second spelling of the same `columns` array, and the
   array is what core's `<Table>` already takes.

## The successor contract

Core's `<Table>` (`react-x11/src/components/Table.js`, ~520 lines) is real
and reasonable: `columns`/`rows`, uncontrolled-unless-passed `sort` and
`selected`, fixed-height virtualization with two spacers, resizable
columns, a sticky header shifted by `marginStart: -scrollX`, roles and
ARIA, focus on the table rather than the row. Nothing in this repo imports
it; `<Tree>` cites it as precedent. `AGENTS.md` §"Replacing a core widget
rather than moving it" is the rulebook: **a successor keeps the behaviour
and drops the implementation**, and earns the replacement by clearing the
bar `<Tree>` set. Item by item:

| The bar                                     | This design                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The app's own data, via accessors           | `getId` accessor + per-column `value`; rows are any shape (§Public API)                                                                         |
| Variable-height virtualization              | The tree's id-keyed height index, plus a declared-uniform fast path (§Virtualization)                                                           |
| Focus on the container, selection as cursor | Kept from core, extended to a multi-select cursor (§Keyboard)                                                                                   |
| Every visible part a seam                   | `column.render` (kept), `column.renderHeader` (new), `renderRow` (new), `renderEmpty` (new), `styles` bag with per-row/per-cell functions (new) |

**Kept from core verbatim** (migration should be an import swap for most
call sites): the `TableColumn` shape (`id`, `label`, `width` defaulting
120, `align`, `value` feeding both the default cell text and the sort,
`render`), `TableSort { column, direction }`,
`sort`/`defaultSort`/`onSortChange`, `selected`/`defaultSelected`/
`onSelect`/`onActivate`, `onColumnResize`, select on first click, activate
on `ev.detail === 2` or Enter, resize grips as header-cell siblings
(min 40, keyboard step 16), the sticky header idiom, `roles`
`table`/`columnheader`/`row`/`separator` with `aria-selected`/
`aria-posinset`/`aria-setsize`/`aria-valuenow`.

**Deliberate divergences**, each with its reason:

- **`getId` accessor** (default `(row) => row.id`) — core requires a
  literal `row.id`; apps have their own key fields. A row whose id
  resolves `undefined` throws a remedial `TypeError` naming `getId`, the
  Calendar's precedent, rather than rendering broken.
- **Unsized columns stretch.** A column declaring neither `width` nor
  `flex` resolves as `flex: 1, minWidth: 120` — the zero-config table
  fills its box instead of parking dead space to the right of fixed-120
  columns. Declaring `width` restores core's behaviour per column.
- **Row height is measured unless declared.** Core's default is fixed 24
  and always-divide. Here, omitting `rowHeight` means measured
  variable-height rows; passing `rowHeight={24}` restores core's exact
  model. `AGENTS.md` already states the two models as the Table/Tree
  distinction; this component carries both and lets the prop pick.
- **`virtual` defaults `'auto'`** (on past 200 rows, the tree's
  threshold) where core always virtualizes. Below threshold every row is
  real — better for the accessibility tree and for `react-x11/test`
  queries — and the switch is invisible at that size.
- **Sort click cycle stays asc↔desc**, and `null` stays in the type as
  the controlled/cleared state. Core's type admits `null` but never emits
  it; the successor documents that honestly instead of inventing a
  third click state.
- **Multi-select exists** behind a discriminated union (§Selection);
  core is single-select only.

## Goals and non-goals

### Goals

1. **Minimal setup for basic tables** — the snippet above is complete;
   every column defaults to something sane (unsized columns share the
   width at a 120px floor, sortable, text cell from `value` ?? `row[id]`).
2. **Reasonable setup for complicated tables** — each capability
   (controlled sort/selection, multi-select, seams, virtualization) is an
   independent opt-in on the same element; no cliff, no second API. This
   is the load-bearing goal, specified in §The continuity contract.
3. **Virtualization optional, uniform heights never required** — measured
   rows by default, declared-uniform as the optimization hint.
4. **Prop-compatible successor** — core `<Table>` call sites migrate by
   changing the import; divergences are listed above and in the migration
   note of the docs page.
5. **Desktop conventions** — always-visible header, first-click select,
   double-click/Enter activate, ctrl/shift multi-select, type-ahead
   (later), keyboard resize.
6. **No new core features** — everything used (scroll blit, yoga, keysyms,
   `Icon` glyphs, focus ring, `measureContent`) exists at the current
   lockfile pin. Anything that turns out to need core work is a deliberate,
   named pin bump, not a drive-by.

### Non-goals

- **Pagination.** Desktop tables scroll; virtualization is the answer to
  the problem pagination solves on the web. An app that wants pages
  composes buttons above a `rows` slice.
- **Grouping, pivoting, aggregation footers.** Data-grid territory;
  nothing in the seam design forecloses a future `groupBy`, but it is not
  this PRD.
- **Cell editing.** A `column.render` can mount a `<textinput>` today;
  an editing _framework_ (commit/rollback, tab-to-next-cell) is not this
  PRD.
- **Horizontal column virtualization.** Tables have tens of columns, not
  thousands; row windowing bounds the work.
- **Frozen/pinned columns, multi-column sort.** Revisit with a real need;
  `TableSort` stays a single `{ column, direction }` so the shape does not
  have to break later (a future multi-sort can widen it compatibly).
- **A headless state export.** The row model lives in `src/table/rows.ts`
  as a pure module (the tree's `rows.ts` precedent), so promotion to
  public API is possible the way `prd-vt-terminal.md` §11 promotes escape
  hatches — but it starts internal.
- **Radix-style part composition.** Settled in §Prior art.

## The continuity contract

The design decision above every other one: **ceremony is additive**. The
basic table is not a starter kit a real table outgrows — it is the same
element at the bottom rung of a ladder, and every rung up is a small diff
to the code already written, never a rewrite onto a second API.

| When a table needs…                     | …it adds                                     | and nothing else moves                               |
| --------------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| rows on screen                          | `rows` + `columns`                           | —                                                    |
| the app's own data shape                | `getId`, per-column `value`                  | cells and sort already read through `value`          |
| one custom cell                         | that column's `render`                       | other columns keep the text default                  |
| row chrome (stripe, badge, menu target) | `styles.row` / `renderRow`                   | geometry and selection stay the table's              |
| sort tweaks                             | `column.compare`, `sortable: false`          | the toggle cycle is unchanged                        |
| sort state lifted (URL, prefs)          | `sort` + `onSortChange`                      | the table still orders the rows                      |
| server-ordered data                     | `presorted`                                  | the descriptor stays where it was, controlled or not |
| selection state lifted                  | `selected` + `onSelect`                      | uncontrolled sites keep `defaultSelected`            |
| multi-select                            | `selectionMode: 'multiple'`, the plural pair | the one shape change, compiler-walked                |
| a hundred thousand rows                 | nothing (`virtual` defaults `'auto'`)        | seams, keyboard, selection behave identically        |
| uniform-height speed                    | `rowHeight`                                  | measurement machinery drops out silently             |
| an empty state                          | `renderEmpty`                                | —                                                    |
| a filter box above it                   | `ref.handleKey`                              | the table's own keys are untouched                   |

Three rules keep the ladder honest — design constraints on every future
prop, not observations:

1. **Opt-ins are orthogonal.** No prop changes meaning because of another
   prop's value. The one licensed exception is the selection union — the
   data shape genuinely changes between one id and an array — and it is a
   discriminated union precisely so the compiler walks the caller through
   that rung, with the remedial `TypeError` catching what escapes it.
2. **Windowing is unobservable.** `virtual` on/off changes which rows are
   mounted, never how a seam, the selection, or a key behaves. The stated
   exception is accessibility-tree completeness (§Virtualization), and it
   is the only one.
3. **Escalation is local.** Saying more about a column edits that column's
   def; about a row, the row seams; about the table, a root prop. No rung
   reaches down and rewrites a lower one.

Enforced where it can be: `docs/components/table.md` and
`examples/table.tsx` grow **one table** through the rungs, each rung shown
as its diff — a reviewer who cannot write the next rung as a small diff has
found a design bug, not a docs bug. `test/types/table.tsx` compiles every
rung.

## Public API

```ts
export type TableRowId = string | number;

export interface TableColumn<Row = any> {
  id: string;
  label?: string;
  width?: number; // px; a fixed column
  flex?: number; // shares leftover width. Neither set: flex 1, minWidth 120
  minWidth?: number; // floor for flex resolution and user resize; default 40
  align?: 'left' | 'right' | 'center';
  sortable?: boolean; // default true (core sorts on any header click)
  value?: (row: Row) => unknown; // default row[id]; feeds the default cell text AND the sort
  compare?: (a: Row, b: Row) => number; // sort override; default natural order over value()
  render?: (row: Row, state: TableCellState<Row>) => ReactNode;
  renderHeader?: (state: TableHeaderCellState<Row>) => ReactNode;
}

export interface TableSort {
  column: string;
  direction: 'asc' | 'desc';
}

interface TableBaseProps<Row> extends Omit<
  BoxProps,
  'style' | 'children' | 'ref' | 'onKeyDown'
> {
  columns?: readonly TableColumn<Row>[];
  rows?: readonly Row[];
  getId?: (row: Row) => TableRowId; // default (row) => row.id; memoize it

  sort?: TableSort | null; // controlled descriptor
  defaultSort?: TableSort | null;
  onSortChange?: (sort: TableSort | null) => void;
  presorted?: boolean; // rows arrive ordered; the table renders the indicator only

  onActivate?: (id: TableRowId, row: Row) => void; // double-click, Enter
  onRowContextMenu?: (id: TableRowId, row: Row, ev: MouseEvent) => void;
  onColumnResize?: (id: string, width: number) => void;

  rowHeight?: number; // declared uniform: divide, never measure. Absent: measured.
  estimatedRowHeight?: number; // seeds the height index; default 24
  virtual?: boolean | 'auto'; // default 'auto': on past 200 rows
  overscan?: number; // default 6

  renderRow?: (state: TableRowState<Row>, content: ReactNode) => ReactNode;
  renderEmpty?: () => ReactNode; // body content when rows resolve empty
  styles?: TableStyles<Row>;
  style?: StyleProp;
  focusable?: boolean; // default true; false for a table inside a popup
  ref?: Ref<TableHandle<Row>>;
  'data-testname'?: string;
}

// Selection is a discriminated union, the Calendar's precedent —
// the wrong pairing is a remedial TypeError, not an empty render.
interface TableSingleSelectProps<Row> extends TableBaseProps<Row> {
  selectionMode?: 'single'; // the default; core's behaviour
  selected?: TableRowId | null;
  defaultSelected?: TableRowId | null;
  onSelect?: (id: TableRowId, row: Row) => void;
}
interface TableMultiSelectProps<Row> extends TableBaseProps<Row> {
  selectionMode: 'multiple';
  selected?: readonly TableRowId[];
  defaultSelected?: readonly TableRowId[];
  onSelectedChange?: (
    selected: TableRowId[],
    change: TableSelectChange<Row>,
  ) => void;
}
interface TableStaticProps<Row> extends TableBaseProps<Row> {
  selectionMode: 'none'; // display-only; rows take no cursor
}
export type TableProps<Row = any> =
  | TableSingleSelectProps<Row>
  | TableMultiSelectProps<Row>
  | TableStaticProps<Row>;
```

Conventions this follows, so they are stated once: `undefined` (never
`null`) is the uncontrolled sentinel; list widgets report
`onSelect(id, item)` rather than a `WidgetChangeEvent` (that event shape is
the _value_-widget side of the package's split — Calendar has it, Tree does
not); styling is `style` plus a `styles` bag, never a `className` or a
`width` prop; `'data-testname'` is declared explicitly because the host
elements do not carry it; the props interface omits `onKeyDown` because the
component owns the keyboard.

### Sort ownership, split in two

Who holds the _descriptor_ and who _orders the rows_ are separate rungs,
because conflating them is the classic table-library cliff: the day sort
state moves to the URL must not be the day the app inherits comparator
duty.

- **Descriptor**: `sort`/`defaultSort`/`onSortChange`, the standard
  controlled/uncontrolled pair. Lifting it changes nothing about who
  sorts.
- **Ordering**: the table's, by default, in both descriptor modes —
  `column.compare ?? natural order over value()`. `presorted` hands
  ordering to the caller: `rows` arrive in display order, and the table
  only renders the indicator and reports toggles. That is the server-side
  rung, and it composes with either descriptor mode.

### Seam states

```ts
export interface TableRowState<Row> {
  id: TableRowId;
  row: Row;
  index: number; // index in sorted order
  selected: boolean;
  color: string; // resolved text colour — colour does not
} //   cascade into <Icon>/<canvas>; pass it on
export interface TableCellState<Row> extends TableRowState<Row> {
  column: TableColumn<Row>; // core's render context, grown
}
export interface TableHeaderCellState<Row> {
  column: TableColumn<Row>;
  sort: TableSort | null; // this column's current part in it
  resolvedWidth: number;
}

export interface TableStyles<Row> {
  header?: StyleProp; // the strip
  headerCell?: StyleProp | ((state: TableHeaderCellState<Row>) => StyleProp);
  row?: StyleProp | ((state: TableRowState<Row>) => StyleProp);
  cell?: StyleProp | ((state: TableCellState<Row>) => StyleProp);
}
```

The function forms are called per rendered row/cell, so zebra striping is a
one-liner a docs recipe owns —
`styles={{ row: (s) => s.index % 2 === 1 && { backgroundColor: '…' } }}` —
rather than a `striped` prop baked into the component (§Theming for the
token question). This is the same reasoning as `<Tree>`'s function-valued
`styles.row`: a style that follows row state without a render prop that
repaints everything.

`renderRow` wraps a row's _content_, not the row box — the box, its
geometry, and its selection/hover chrome stay the table's, so a wrapper
cannot desynchronize the grid (the tree's `renderContent` precedent). A
drag source, a tooltip anchor, or a per-row menu target goes here;
`onRowContextMenu` covers the common case without any wrapper.

### The handle

```ts
export interface TableHandle<Row = any> {
  focus(): void;
  select(id: TableRowId): void;
  scrollToRow(id: TableRowId): boolean; // false: unknown id
  handleKey(ev: KeyboardEvent): boolean; // a filter box above the table forwards arrows down
  rows(): readonly TableRow<Row>[]; // the sorted row model, not the rendered slice
}
```

`TableRow<Row>` is `{ id, row, index }` from `src/table/rows.ts` — the
pure, display-free model file, mirroring `src/tree/rows.ts`: sorting and
id resolution live there, testable headless with no component mounted.

## Columns resolve to pixels

The one problem no surveyed library had to solve. HTML's table layout
algorithm does not exist here, and per-row yoga flex must not decide column
widths (each row would negotiate its own). So:

- **Widths resolve once at the table level, to integers, per
  (columns, viewport width, user resizes).** Fixed columns take `width`;
  flex columns share `max(0, viewport − Σfixed)` by `flex` weight, floored
  at `minWidth`; a column declaring neither is `flex: 1, minWidth: 120`,
  core's fixed default carried forward as a floor. When nothing fits, flex columns sit at their floor and the
  body scrolls horizontally — the header tracking with
  `marginStart: -scrollX`, which follows the direction columns actually
  run under RTL.
- Every cell then lays out at a resolved pixel width; rows agree by
  construction, and a virtualized row mounting late cannot re-negotiate
  the grid.
- **A user resize converts that column to fixed** at the dragged width
  (reported out through `onColumnResize`) — the behaviour every desktop
  file manager has taught.
- Content-measured "auto" columns are deliberately deferred: the
  machinery exists (`app.fonts.layout` with an LRU, the charts label
  cache; absent on the headless backend and skipped there), and the
  charts' `YAxis width="auto"` is the in-repo precedent — but sampling
  policy for a hundred-thousand-row column is its own design. `flex`
  covers the common intent ("this column takes the room") without
  measuring anything.

Viewport width arrives through `onViewport` — fired from layout, not
scrolling — and before the first one, layout assumes the tree's
`ASSUMED_ROWS`-style guess rather than building against `Infinity`.

## Virtualization and the height model

Two models, one prop:

- **`rowHeight: number` — declared uniform.** Core `<Table>`'s model kept
  whole: `first = floor(scrollY / rowHeight) − overscan`, two spacer boxes
  of `first × rowHeight` and `(rows.length − last) × rowHeight`, no
  measurement anywhere. The fast path for the 24px-text-rows table, and
  the exact-parity mode for migrated call sites.
- **`rowHeight` absent — measured.** The tree's model, machinery included:
  an id-keyed Fenwick height index (`sync`/`offsetAt`/`indexAt`/`total`/
  `measure`) seeded by `estimatedRowHeight`. Id-keyed matters twice here:
  a measured height survives collapse in the tree, and here it survives a
  **re-sort** — sorting permutes offsets in O(n log n) index rebuild
  without remeasuring a single row.

Shared mechanics, all established by `<Tree>` and reused, not reinvented:

- The slice is `indexAt(viewportTop) − overscan …
indexAt(viewportBottom) + overscan`, mounted between two spacers so the
  scrollbar measures the whole list.
- **Measurement reads geometry after the frame flush** — react-x11 lays
  out on flush, not commit, so `useLayoutEffect` sees the previous pass;
  `afterLayout()` is the first honest read. Measure→render→measure
  terminates because `measure()` reports whether anything changed and
  only a change re-renders.
- **A measurement above the anchor compensates the scroll offset** by the
  delta, or the table yanks under the pointer.
- `virtual: 'auto'` (default) turns windowing on past 200 rows;
  `virtual: false` forces every row real (screenshots, tests);
  `overscan` defaults 6.
- Scrolling itself is core's: `<box overflow="scroll">` frames that are
  pure scroll are one `CopyArea` plus the exposed strip (react-x11#138),
  and nodes scrolled out of clip are never painted. The component's only
  obligation is to not break frame purity — the slice advances by
  overscan-absorbed steps, and handler-identity churn is kept out of the
  damage test the way charts does it.
- The honest caveat, stated wherever `<Tree>` states it: **only rendered
  rows exist in the accessibility tree** — the same rows a sighted user
  can see. The table is one tab stop; the row cursor is the selection.

The height index, `afterLayout`, and type-ahead currently live inside
`src/tree/` (`heights.ts`, `timers.ts`, `internal.ts`); the table must not
import another component. Decided: vendor-copy into `src/table/` for now —
the `useTypeAhead` precedent, delete-when-shared notes included — and
promote to a shared module in M2 alongside the tree refactor.

## Keyboard and focus

Focus lands on the table (`focusable`, one tab stop); the focus ring is
the renderer's on `:focus-visible`. Keys arrive on the root box as
react-x11 `KeyboardEvent`s, tested by Latin `keysym` (`XK_UP`…`XK_RETURN`;
Space is `codepoint === 32`).

| Key                   | Single (`'single'`, default)        | Multiple                                 |
| --------------------- | ----------------------------------- | ---------------------------------------- |
| Down / Up             | move selection                      | move cursor, selection follows (replace) |
| Shift+Down / Shift+Up | —                                   | extend range from anchor                 |
| Home / End            | first / last row                    | same, Shift extends                      |
| PageDown / PageUp     | one viewport minus a row of overlap | same, Shift extends                      |
| Space                 | —                                   | toggle cursor row                        |
| Ctrl+A                | —                                   | select all                               |
| Enter                 | activate (`onActivate`)             | activate the cursor row                  |
| On the resize grip    | Left/Right ±16px, floor 40          | same                                     |

Pointer, in multiple mode: click replaces, Ctrl+click toggles, Shift+click
extends from the anchor. Right-click reports `onRowContextMenu` (core's
`onContextMenu`, button 3, underneath), first selecting the row it lands
on unless that row is already part of the selection — the file-manager
convention. The cursor and anchor are **ids, not indexes** — a re-sort
moves the rows, not the user's place.

Mechanics kept from the tree, because they were each learned the hard way:
key-repeat bursts outrun re-render, so the handler reads cursor/rows/view
from refs mirrored during render; the keyboard scrolls **only when the
selection would leave the viewport** (core commit `c01b483`), preferring
`scrollIntoView(node)` for a mounted row and the height index for an
unmounted one; PageDown with variable heights is `offsetAt`/`indexAt`
arithmetic, not a division, and forces at least one row past a
taller-than-viewport row. Type-ahead (`useTypeAhead`, 700ms window) is a
later milestone, not a day-one key.

## Theming

Everything comes from tokens core's `<Table>` already exercises — no new
palette entries required:

| Part                       | Token                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Header strip background    | `surfaceHover`                                                                                                |
| Header label, sort chevron | `text`, `textMuted` (`<Icon name="chevronUp/Down" size={9}>` — colour does not cascade into an Icon; pass it) |
| Column rule / outer border | `border`                                                                                                      |
| Row hover / pressed        | `surfaceHover` / `surfaceActive`                                                                              |
| Selected row / its text    | `hoverBackground` / `hoverText`                                                                               |
| Selected and pressed       | `accentActive`                                                                                                |
| Resize grip hover / active | `track` / `accent`                                                                                            |
| Focus ring                 | renderer-drawn from `focusRing*`                                                                              |

Row-state colours ride `':hover'`/`':active'` style blocks with the
`transition: { backgroundColor: 80 }` both core's table rows and the
tree's rows use. **There is no stripe token** — the palette has no
alternate-row colour, which is why zebra is a `styles.row` recipe rather
than a prop; minting a `stripe` token is a core palette change and
therefore a named pin bump plus a repo-wide grep (token strings type-check
against any palette and fail only at mount).

## The performance contract

1. **Rendered work is O(viewport), never O(rows).** The slice plus two
   spacers; row/cell seam functions run per rendered row only. Enforced
   where the tree enforces it: the index math in `src/table/index.ts`, and
   a test asserting the mounted-row count against a 100k-row input.
2. **Scrolling an unchanged table is a blit.** Free from
   `overflow: 'scroll'` (react-x11#138); the component's job is to not
   poison it — memoized column resolution, handler identity held stable,
   slice steps absorbed by overscan. Asserted with the mock backend's
   draw-op recording, the charts precedent.
3. **Measurement terminates and never loops at frame rate.**
   `measure()` is idempotent; only a changed height re-renders; heights
   are id-keyed so sort/filter churn cannot invalidate them. The Fenwick
   index is O(log n) per question and answer, tested against a naive
   oracle exactly as `test/tree-heights.test.ts` does.
4. **Sorting is honest about where it runs.** Uncontrolled sort is one
   `Array.prototype.sort` on the main thread per toggle — fine to 10⁵
   rows, and the documented big-data path is `presorted` with rows
   ordered upstream. The height index survives the permutation without
   remeasuring (§Virtualization).

## Testing and guards

Headless `node --test` throughout (no `$DISPLAY` in CI): the `rows.ts`
model (sorting, id resolution, comparator defaults) tests pure; the height
index tests against the oracle; mount tests use the mock backend and
`data-testname` queries; draw-op assertions cover contract #2. Type tests
in `test/types/table.tsx` pin the discriminated union (a `'multiple'`
`selected` array rejected in `'single'`, and the remedial-throw paths).
Repo guards to satisfy: `test/docs.test.ts` (a `docs/components/table.md`
page must land with the component), `test/treeshake.test.ts`
(`{ exportName: 'Table', dir: 'table', marker: 'columnheader' }` — the
role string survives minification), `scripts/check-package.ts` (a
`./table` subpath in the exports map).

## Milestones and shipping

**M1 — the successor, prop-compatible.** `src/table/` (`index.ts`,
`hx.ts` copied from the tree, `rows.ts`), columns with
`width`/`flex`/`minWidth`, declared-uniform virtualization
(`rowHeight: number`), sort, single selection, activation, column resize,
sticky header, roles/ARIA, theming, `data-testname`. Everything a core
`<Table>` call site uses today, importing from
`@react-x11/components/table`.

**M2 — the bar.** `getId`, measured variable heights, `virtual:
'auto'`/`overscan`, the seams (`renderHeader`, `renderRow`, `renderEmpty`,
`styles` bag, grown cell state), the handle, `selectionMode: 'multiple'`
with the full pointer/keyboard grammar, `presorted`, `onRowContextMenu`,
`focusable` — and the vendored height index/`afterLayout` promoted to a
shared module, the tree refactored onto it.

**M3 — polish.** Type-ahead, controlled column widths (beyond
`onColumnResize` reporting), the zebra/`stripe` decision, content-measured
auto columns if a real table demands them.

**Decommission.** When M2 lands: file the upstream issue to strip or
remove core's `<Table>`, add the migration note to
`docs/components/table.md`, and update `AGENTS.md`'s incoming/roadmap
tables and the README (`## Components` row, prose section, Roadmap) — the
package checklist in `AGENTS.md` §"Adding a component" governs the
mechanical steps, and the docs page follows the house page format
(props table with defaults in the description, the decisions section, the
`npm run examples:table` line). The PR carries a headless-rendered
screenshot via `gh-attach`, per `AGENTS.md`.

## Open questions (decision needed, defaults proposed)

1. **`align` vocabulary.** Core says `'left' | 'right' | 'center'`; the
   style system prefers logical edges (`start`/`end`), and the sticky
   header already uses `marginStart`. Proposed: keep core's words for
   parity (numeric right-alignment is what the prop is for) and map to
   logical edges internally under RTL.
2. **Core's fate.** Undecided, and both outcomes are live: stripped down
   to a very simple table, or removed altogether. Nothing in M1/M2
   depends on either — this component composes host primitives only, and
   the decommission milestone files the coordination issue whichever way
   core goes. Only if a remainder survives do the packages share a name
   (subpaths disambiguate mechanically; the docs page says which one a
   reader wants).
3. **`selectionMode: 'none'` vs `selectionMode` absent + no handlers.**
   The union needs the explicit `'none'` for display-only tables (hover
   off, no cursor); the alternative — inferring from handler absence —
   breaks controlled usage. Proposed: keep the explicit `'none'`.
4. **Does `renderEmpty` belong in M2, or is an empty body enough?**
   Proposed: ship it in M2; it is one seam and every real app asks for it.

## Risks

- **The installed core is stale relative to the branch pin.** The
  worktree's parent `node_modules` holds a pre-theme-rename core (`dim`,
  not `textMuted`); anything mounted against it throws unknown-token in
  DEV. `npm ci` before running `examples/table.tsx`. The pin itself
  (`ceb9da5`) already has everything this design needs — goal 6 holds.
- **A sibling component is landing conventions in parallel.** The flow
  branch (`src/flow/`, react-flow-shaped) is a second large component in
  flight; check it for accessor/seam naming drift before freezing
  `TableProps` in M1.
- **Two `Table`s exist during the overlap window** (core's and this one).
  Import subpaths disambiguate; the README should not list the component
  until M1 merges, and the decommission issue closes the window from the
  other side.
