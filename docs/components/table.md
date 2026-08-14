# Table

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
      value: (f) => f.bytes,
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

A data table: a header that stays put, sort on header click, selection on
row click, resizable columns, and only the rows in view actually built. It
registers no host element — a table is `<box>`, `<text>` and core's chevron,
with no side effect at import time.

`<Table>` is a **successor to react-x11's own `<Table>`**, the way the
[Tree](tree.md) succeeds core's tree: nothing here imports it, the two share
no code, and the prop names core call sites already use (`columns`, `rows`,
`sort`, `selected`, `onActivate`, `onColumnResize`) mean migrating is
changing the import. The design record, including the prior-art survey and
the continuity contract the API is built around, is
[the PRD](../prd-table.md).

## Columns

Columns are data, not children — there is no HTML table layout algorithm
here, so the pixel arithmetic is this component's, and it resolves **once,
at the table level**: every row agrees on the grid by construction, and a
virtualized row mounting late cannot re-negotiate it.

| Field          | Type                            | Notes                                                                                                                                                                                                    |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `string`                        | Names the column, the sort, and — by default — the row property the cell shows.                                                                                                                          |
| `label`        | `string`                        | The header caption. Defaults to the id.                                                                                                                                                                  |
| `width`        | `number`                        | A fixed column, in pixels. Ignored when `flex` is set.                                                                                                                                                   |
| `flex`         | `number`                        | Shares the viewport width left over after the fixed columns, by weight. **A column declaring neither `width` nor `flex` is `flex: 1` with a 120px floor** — a table with no sizing config fills its box. |
| `minWidth`     | `number`                        | The floor for flex resolution and user resize. Defaults to 40; 120 for an unsized column.                                                                                                                |
| `align`        | `'left' \| 'right' \| 'center'` | `'right'` means the end of the row — the left edge in a mirrored table.                                                                                                                                  |
| `sortable`     | `boolean`                       | Whether the header click sorts here. Default true.                                                                                                                                                       |
| `value`        | `(row) => unknown`              | Feeds the default cell text **and** the sort. Defaults to `row[id]`.                                                                                                                                     |
| `compare`      | `(a, b) => number`              | Sort order over whole rows. Defaults to a natural comparison over `value()` — numbers numerically, everything else as text.                                                                              |
| `render`       | `(row, state) => ReactNode`     | Replaces the cell — see [Seams](#seams).                                                                                                                                                                 |
| `renderHeader` | `(state) => ReactNode`          | Replaces the header cell's content — the box, its width, the sort click and the grip stay the table's.                                                                                                   |

Dragging a grip (or Left/Right on a focused grip, 16px a press) resizes the
column and **converts it to fixed** at that width, reported through
`onColumnResize(id, width)` — the behaviour every desktop file manager has
taught.

## Props

| Prop                                    | Type                               | Notes                                                                                                                                                         |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `columns`                               | `readonly TableColumn[]`           | The grid. Empty renders an empty header strip.                                                                                                                |
| `rows`                                  | `readonly Row[]`                   | Any shape. Each row must resolve an id — see `getId`.                                                                                                         |
| `getId`                                 | `(row) => TableRowId`              | Defaults to `row.id`, and a row that resolves none is a remedial `TypeError` naming the fix. Memoize it.                                                      |
| `sort` / `defaultSort` / `onSortChange` | `TableSort \| null`                | The sort **descriptor**, controlled or uncontrolled. `TableSort` is `{ column, direction: 'asc' \| 'desc' }`.                                                 |
| `presorted`                             | `boolean`                          | The rows already arrive in display order; the table renders the indicator and reports toggles, nothing more. Composes with either descriptor mode.            |
| `selectionMode`                         | `'single' \| 'multiple' \| 'none'` | Default `'single'`. The selection props change shape with it — see [Selection](#selection).                                                                   |
| `selected` / `defaultSelected`          | one id, or an array                | `TableRowId \| null` in single mode, `readonly TableRowId[]` in multiple. The wrong pairing throws.                                                           |
| `onSelect`                              | `(id, row) => void`                | Single mode.                                                                                                                                                  |
| `onSelectedChange`                      | `(ids, change) => void`            | Multiple mode; `change` names the gesture (`replace` / `toggle` / `range` / `all`) and the row it landed on.                                                  |
| `onActivate`                            | `(id, row) => void`                | The _open_ gesture on top of selection — a double click, or Enter.                                                                                            |
| `onRowContextMenu`                      | `(id, row, ev) => void`            | Right-click. The row is selected first unless it is already part of the selection, so a menu always applies to what is under the pointer.                     |
| `onColumnResize`                        | `(id, width) => void`              | A grip was dragged or keyed.                                                                                                                                  |
| `rowHeight`                             | `number`                           | Declares every row exactly this tall — core's model, nothing measured. **Omit it and rows are measured instead.** `rowHeight={24}` is core's exact behaviour. |
| `estimatedRowHeight`                    | `number`                           | What an unmeasured row is assumed — and floored — at, while measuring. Default 24.                                                                            |
| `virtual`                               | `boolean \| 'auto'`                | Build only the rows on screen. `'auto'` (the default) turns it on past 200 rows.                                                                              |
| `overscan`                              | `number`                           | Rows built either side of the viewport. Default 6.                                                                                                            |
| `renderRow` / `renderEmpty`             |                                    | Seams — see below.                                                                                                                                            |
| `styles`                                | `TableStyles`                      | Per-part style overrides; row/cell entries may be functions of row state.                                                                                     |
| `focusable`                             | `boolean`                          | Whether the table is a tab stop. Default true; `false` for a table inside a popup that owns the focus.                                                        |
| `style`                                 | `StyleProp`                        | The root box. Width, `flexGrow` and `minHeight: 0` go here.                                                                                                   |
| `ref`                                   | `Ref<TableHandle>`                 | The imperative side — see below.                                                                                                                              |
| `data-testname`                         | `string`                           | For `react-x11/test`'s queries.                                                                                                                               |

Everything else a `<box>` takes passes through to the root — `aria-label`
names the table.

## Sorting is split in two

Who holds the _descriptor_ and who _orders the rows_ are separate questions,
because conflating them is the classic table-library cliff: the day sort
state moves into app state must not be the day the app inherits comparator
duty.

- **Descriptor**: `sort` / `defaultSort` / `onSortChange`. Lifting it
  changes nothing about who sorts.
- **Ordering**: the table's, by default, in both descriptor modes. Pass
  `presorted` when a server already ordered the rows.

The header click cycles asc ↔ desc and never emits `null`; `null` stays in
the type as the controlled "cleared" state. Uncontrolled sorting is one
`Array.prototype.sort` per toggle — fine into the hundreds of thousands, and
`presorted` is the documented path beyond that.

## Selection

Three modes, and the props are a discriminated union on `selectionMode` —
one id and an array of ids are different shapes, and the compiler walking a
caller through that change is the point. The wrong pairing at run time is a
remedial `TypeError`, not an empty render.

- **`'single'`** (default, core's behaviour): `selected` /
  `defaultSelected` / `onSelect(id, row)`. Click selects; the selection is
  the keyboard cursor.
- **`'multiple'`**: `selected` as an array, `onSelectedChange(ids, change)`.
  The pointer grammar is the file manager's: click replaces, Ctrl+click
  toggles, Shift+click extends from the anchor — and a Ctrl toggle moves the
  anchor with it. The cursor and anchor are **ids, not indexes**: a re-sort
  moves the rows, not the user's place.
- **`'none'`**: display only. No cursor, no hover, no `aria-selected`.

## Keyboard

The table is a single tab stop; the focus is on the table, never the row.

| Key                            | What it does                                                             |
| ------------------------------ | ------------------------------------------------------------------------ |
| Down / Up                      | Move the selection (multiple: the cursor; Shift extends from the anchor) |
| Home / End                     | First / last row (Shift extends)                                         |
| PageDown / PageUp              | One viewport, minus a row of overlap (Shift extends)                     |
| Enter                          | Activate the cursor row (`onActivate`)                                   |
| Space                          | Multiple: toggle the cursor row. Single: activate                        |
| Ctrl+A                         | Multiple: select everything                                              |
| Left / Right on a focused grip | Resize that column by 16px                                               |

Arrows the table takes are `preventDefault`ed — the root is focused above a
scroll container with default key actions of its own, and without that every
arrow both moved the selection and scrolled the list under it. The keyboard
scrolls **only when the selection would leave the viewport**. A key the
table did not take keeps its default, which is also what
`TableHandle.handleKey` reports to a control that forwards keys down.

## Two height models, one prop

- **`rowHeight={n}` — declared uniform.** Every row is exactly `n` tall,
  content clipped to one line, and the visible slice is arithmetic: nothing
  is ever measured. Core's model, and the fast path for the ordinary
  text-rows table.
- **`rowHeight` omitted — measured.** Rows grow to their content — a
  `render` seam may wrap text or stack lines — and the [tree's height
  index](tree.md#virtualization) reads back what each drawn row became.
  `estimatedRowHeight` is what the scrollbar assumes for rows not yet seen
  (and the floor a row cannot shrink under), and the guess converges as you
  scroll. Id-keying means a re-sort permutes offsets without remeasuring a
  single row.

`virtual="auto"` (the default) starts windowing past 200 rows; below that
every row is real. The honest caveat, the same one the tree carries: while
virtualizing, **only the rendered rows are in the accessibility tree** — the
same rows a sighted user can see. `virtual={false}` keeps a table whole
regardless, for a screenshot or a test that wants every row.

## Laying one out

The same rule as the tree, and the same symptom when it is missed: every
flex ancestor between the window and the table needs `minHeight: 0`, or the
ancestor grows to hold every row and the scroll pane inside it has nothing
left to scroll. The table's own root carries `flexGrow: 1`, `minHeight: 0`
and `minWidth: 0`; give the box you put it in the same treatment.

The header strip is not part of the scrolled content — it sits above the
pane and tracks the body's horizontal scroll by `marginStart`, so it follows
the direction the columns run under RTL and never moves vertically.

## Seams

Every visible part is replaceable without giving up what the table manages —
geometry, selection, the keyboard, virtualization.

### `column.render`

```tsx
{
  id: 'status',
  render: (file, state) => (
    <box style={{ flexDirection: 'row', gap: 4 }}>
      <Icon name="dot" size={8} color={file.dirty ? '#e17055' : state.color} />
      <text style={{ color: state.color }}>{file.status}</text>
    </box>
  ),
}
```

The state says whether the cell is on the selected row and carries `color`,
the row's resolved ink — the selection is a filled bar, and a colour picked
against the resting background is unreadable on it. Colour does not cascade
into an `<Icon>` or a `<canvas>`; hand it over.

### `renderRow`

Wraps a row's _content_, given what would have been there. The row box
stays the table's — it carries the height virtualization counts on, the
role and aria the table is read through, and the click that selects.

### `renderEmpty`

The body when the rows resolve empty. Nothing by default; the header still
shows.

### `styles`

`{ header, headerCell, row, cell }` — the row and cell entries may be
functions of the row/cell state, called per rendered row, so a style can
follow state without a render prop that repaints everything. Zebra striping
is the recipe:

```tsx
<Table
  …
  styles={{ row: (s) => s.index % 2 === 1 && { backgroundColor: '#00000010' } }}
/>
```

There is deliberately no `striped` prop: the palette has no alternate-row
token, and a boolean that painted `surfaceHover` would collide with hover
itself. One line of `styles.row` says exactly what you mean.

## `TableHandle`

```ts
interface TableHandle<Row> {
  focus(): void;
  select(id: TableRowId | null): void; // null clears an uncontrolled selection
  scrollToRow(id: TableRowId): boolean; // false: unknown id
  handleKey(ev: KeyboardEvent): boolean; // a filter box above forwards arrows down
  rows(): readonly TableRow<Row>[]; // the sorted model, not the rendered slice
}
```

The row model is importable on its own —
`orderRows`, `resolveWidths`, `columnValue`, `defaultCompare`,
`resolveGetId` from `@react-x11/components/table` — for an app that does the
same arithmetic outside the component (a status bar totalling a column, a
test asserting order).

## Decisions

- **Multiple selection exists here, where the tree refused it.** The tree's
  reasons do not apply to a flat list: there is no branch for Ctrl+click to
  ambiguously take, and a Shift range over sorted order has exactly one
  meaning. The grammar shipped is the one every desktop file manager
  agrees on, anchor semantics included.
- **A right-click selects the row under it unless that row is already part
  of the selection** — a menu over "the selected files" must not collapse
  them. Only the left button drives the click-to-select path.
- **The sort click never emits `null`.** Core's type admitted it and never
  produced it; the successor keeps the toggle and documents the type as the
  controlled clearing path, rather than inventing a third click state.
- **Unsized columns stretch.** Core parked dead space to the right of
  fixed-120 columns; here an unsized column is `flex: 1` floored at 120.
  Declaring `width` restores core's behaviour per column.
- **`estimatedRowHeight` is both the guess and the floor** while measuring.
  One knob moves both, and an estimate that is also a floor can never
  over-report a row it has already seen.

## Migrating from core's `<Table>`

Change the import. Then, only if it matters:

- Rows still need an `id` — or pass `getId`, which core did not have.
- Core's fixed 24px rows are `rowHeight={24}`; omitting it measures instead.
- Columns without `width` now stretch rather than sitting at 120 fixed.
- Tables under 200 rows are no longer virtualized (better for the
  accessibility tree); `virtual` forces it either way.

## Example

`npm run examples:table` — a process monitor over the real `ps` output:
zero-config columns on the left, and the same table grown rung by rung —
custom cells, multiple selection, sorting, a hundred thousand measured rows
— on the right. It needs a real `$DISPLAY`.
