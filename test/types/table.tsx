// Type-level test: the table's props compile against react-x11's JSX
// namespace, and — the part worth pinning — the selection union walks a
// caller through the single↔multiple rung at compile time, and the generic
// follows the app's own row type through the columns, the seams and the
// callbacks. This is the continuity contract's "compiler-walked shape
// change", asserted where it lives.
import React, { useRef } from 'react';

import { Table } from '../../src/index.js';
import type {
  TableColumn,
  TableHandle,
  TableRowId,
  TableSelectChange,
  TableSort,
  TableStyles,
} from '../../src/index.js';

interface File {
  id: number;
  name: string;
  bytes: number;
  modified: Date;
}

const FILES: File[] = [];

const COLUMNS: TableColumn<File>[] = [
  { id: 'name', label: 'Name', flex: 1 },
  {
    id: 'bytes',
    label: 'Size',
    width: 96,
    align: 'end',
    // value and compare both see the app's row type
    value: (f) => f.bytes,
    compare: (a, b) => a.bytes - b.bytes,
  },
  {
    id: 'modified',
    label: 'Modified',
    render: (f, state) => {
      // the cell state carries the row, the selection, and the ink
      const when: Date = f.modified;
      const ink: string = state.color;
      return <text style={{ color: ink }}>{String(when)}</text>;
    },
    renderHeader: (state) => <text>{state.sort ? '*' : ''}</text>,
  },
];

/** Out of the box: columns and rows, nothing else. */
export const plain = (
  <box style={{ flexGrow: 1 }}>
    <Table columns={COLUMNS} rows={FILES} />
  </box>
);

/** The rungs are independent opt-ins on the same element. */
export const single = (
  <Table
    columns={COLUMNS}
    rows={FILES}
    selected={3}
    onSelect={(id, row) => {
      const key: TableRowId = id;
      const name: string = row.name;
      void key;
      void name;
    }}
    onActivate={(id, row) => void [id, row.bytes]}
    sort={{ column: 'name', direction: 'asc' }}
    onSortChange={(s: TableSort | null) => void s}
    presorted
    rowHeight={24}
  />
);

export const multiple = (
  <Table
    columns={COLUMNS}
    rows={FILES}
    selectionMode="multiple"
    selected={[1, 2]}
    onSelectedChange={(ids, change: TableSelectChange<File>) => {
      const first: TableRowId | undefined = ids[0];
      // the change's row is the app's own type, not `unknown`
      const name: string | undefined = change.row?.name;
      void first;
      void name;
      void change.type;
    }}
  />
);

export const display = (
  <Table columns={COLUMNS} rows={FILES} selectionMode="none" />
);

// The union is the compiler walking a caller up the multi-select rung:
// the plural shape needs the plural mode, and vice versa.

export const arrayInSingle = (
  // @ts-expect-error single selection takes one id, not an array
  <Table columns={COLUMNS} rows={FILES} selected={[1]} />
);

export const scalarInMultiple = (
  // @ts-expect-error multiple selection takes an array of ids, not one id
  <Table columns={COLUMNS} rows={FILES} selectionMode="multiple" selected={1} />
);

export const wrongHandler = (
  <Table
    columns={COLUMNS}
    rows={FILES}
    selectionMode="multiple"
    // @ts-expect-error multiple selection reports onSelectedChange, not onSelect
    onSelect={(id: TableRowId) => void id}
  />
);

// --- an app's own row type, keyed its own way ------------------------------

interface Track {
  key: string;
  title: string;
}

export const keyed = (
  <Table<Track>
    columns={[{ id: 'title' }]}
    rows={[] as Track[]}
    getId={(t) => t.key}
    onRowContextMenu={(id, row, ev) => {
      const title: string = row.title;
      void [id, title, ev.x];
    }}
  />
);

export const wrongKey = (
  <Table<Track>
    columns={[{ id: 'title' }]}
    rows={[] as Track[]}
    // @ts-expect-error getId reads the app's row type
    getId={(t: File) => t.id}
  />
);

// --- styles and the handle -------------------------------------------------

const styles: TableStyles<File> = {
  header: { backgroundColor: 'transparent' },
  headerCell: (state) => state.sort !== null && { backgroundColor: '#eee' },
  // zebra striping is a style function, not a prop
  row: (state) => state.index % 2 === 1 && { backgroundColor: '#00000011' },
  cell: (state) => state.selected && { borderColor: state.color },
};

export function WithHandle(): React.ReactElement {
  const handle = useRef<TableHandle<File>>(null);
  return (
    <Table
      columns={COLUMNS}
      rows={FILES}
      styles={styles}
      ref={handle}
      renderRow={(state, content) => (
        <box style={{ flexDirection: 'row' }}>
          {state.selected ? content : content}
        </box>
      )}
      renderEmpty={() => <text>empty</text>}
      onScroll={(ev) => void ev.scrollY}
      data-testname="files"
      aria-label="Files"
    />
  );
}

export function drive(handle: TableHandle<File>): void {
  handle.focus();
  handle.select('a');
  handle.select(null);
  const ok: boolean = handle.scrollToRow(3);
  const rows = handle.rows();
  const row: File | undefined = rows[0]?.row;
  void [ok, row];
}
