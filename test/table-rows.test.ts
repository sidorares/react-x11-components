// The table's row and column model, on its own.
//
// Sorting, id resolution and the pixel arithmetic behind the columns are all
// pure (src/table/rows.ts), so they are asserted directly — no display, no
// component. Every subtle table bug that is not a paint bug lives here.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  MIN_COLUMN,
  UNSIZED_MIN,
  columnValue,
  defaultCompare,
  orderRows,
  orderedRows,
  resolveGetId,
  resolveWidths,
} from '../src/table/rows.js';
import type { TableColumn, TableSort } from '../src/table/rows.js';

interface File {
  id: number;
  name: string;
  bytes: number;
}

const FILES: File[] = [
  { id: 1, name: 'banana', bytes: 300 },
  { id: 2, name: 'apple', bytes: 1000 },
  { id: 3, name: 'cherry', bytes: 20 },
];

const COLUMNS: TableColumn<File>[] = [
  { id: 'name' },
  { id: 'bytes', value: (f) => f.bytes },
];

const readId = resolveGetId<File>(undefined);

function order(sort: TableSort | null, presorted = false): string[] {
  return orderRows(FILES, COLUMNS, readId, sort, presorted).map(
    (r) => (r.row as File).name,
  );
}

// --- ids -------------------------------------------------------------------

test('the id defaults to row.id, and a custom accessor replaces it', () => {
  assert.strictEqual(readId(FILES[0], 0), 1);
  const byName = resolveGetId<File>((f) => f.name);
  assert.strictEqual(byName(FILES[0], 0), 'banana');
});

test('a row with no id is a remedial TypeError, not a broken render', () => {
  // the failure this replaces: a selection that silently never matches
  assert.throws(
    () => resolveGetId<{ name: string }>(undefined)({ name: 'x' }, 4),
    (err: unknown) =>
      err instanceof TypeError &&
      /row 4 has no id/.test(err.message) &&
      /getId/.test(err.message),
  );
});

// --- ordering --------------------------------------------------------------

test('unsorted rows keep the order the app gave them', () => {
  assert.deepStrictEqual(order(null), ['banana', 'apple', 'cherry']);
});

test('a sort orders by value, both directions, and re-indexes', () => {
  assert.deepStrictEqual(order({ column: 'name', direction: 'asc' }), [
    'apple',
    'banana',
    'cherry',
  ]);
  assert.deepStrictEqual(order({ column: 'name', direction: 'desc' }), [
    'cherry',
    'banana',
    'apple',
  ]);
  const rows = orderRows(
    FILES,
    COLUMNS,
    readId,
    { column: 'name', direction: 'asc' },
    false,
  );
  // `index` is the position in sorted order — what virtualization, the
  // keyboard and aria-posinset all count in
  assert.deepStrictEqual(
    rows.map((r) => r.index),
    [0, 1, 2],
  );
});

test('numbers sort numerically through value(), not as text', () => {
  // "1000" < "20" < "300" as strings; the value accessor keeps them numbers
  assert.deepStrictEqual(order({ column: 'bytes', direction: 'asc' }), [
    'cherry',
    'banana',
    'apple',
  ]);
});

test('column.compare overrides, and gets the whole rows', () => {
  const columns: TableColumn<File>[] = [
    { id: 'name', compare: (a, b) => a.bytes - b.bytes },
  ];
  const rows = orderRows(
    FILES,
    columns,
    readId,
    { column: 'name', direction: 'asc' },
    false,
  );
  assert.deepStrictEqual(
    rows.map((r) => (r.row as File).name),
    ['cherry', 'banana', 'apple'],
  );
});

test('a sort naming no column, and presorted rows, both pass through', () => {
  assert.deepStrictEqual(order({ column: 'ghost', direction: 'asc' }), [
    'banana',
    'apple',
    'cherry',
  ]);
  // presorted: the descriptor drives the indicator, never the order — the
  // continuity rung for server-sorted data
  assert.deepStrictEqual(order({ column: 'name', direction: 'asc' }, true), [
    'banana',
    'apple',
    'cherry',
  ]);
});

test('the sort is stable, so equal rows keep the given order', () => {
  const rows = [
    { id: 'a', group: 1 },
    { id: 'b', group: 0 },
    { id: 'c', group: 1 },
    { id: 'd', group: 0 },
  ];
  const ordered = orderRows(
    rows,
    [{ id: 'group' }],
    resolveGetId(undefined),
    { column: 'group', direction: 'asc' },
    false,
  );
  assert.deepStrictEqual(
    ordered.map((r) => r.id),
    ['b', 'd', 'a', 'c'],
  );
});

// --- the order the component holds ----------------------------------------
//
// `<Table>` holds its rows as `orderedRows`, which makes an entry only for a
// row something asks for; `orderRows` makes them all. The two have to be the
// same order and the same entries, whatever the sort.

test('orderedRows is orderRows, entry for entry, under every sort', () => {
  // a corpus with ties, missing values and both kinds of id
  let seed = 7;
  const next = (): number => (seed = (seed * 16807) % 2147483647);
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: i % 3 === 0 ? `r${i}` : i,
    v: next() % 5 === 0 ? undefined : next() % 40,
    w: `w${next() % 9}`,
  }));
  type R = (typeof rows)[number];
  const columns: TableColumn<R>[] = [
    { id: 'v' },
    { id: 'w', compare: (a, b) => a.w.localeCompare(b.w) },
  ];
  const getId = resolveGetId<R>(undefined);
  const sorts: Array<TableSort | null> = [
    null,
    { column: 'v', direction: 'asc' },
    { column: 'v', direction: 'desc' },
    { column: 'w', direction: 'asc' },
    { column: 'w', direction: 'desc' },
    { column: 'nope', direction: 'asc' },
  ];
  for (const sort of sorts) {
    for (const presorted of [false, true]) {
      const lazy = orderedRows(rows, columns, getId, sort, presorted);
      const eager = orderRows(rows, columns, getId, sort, presorted);
      const what = `${JSON.stringify(sort)}, presorted ${presorted}`;
      assert.strictEqual(lazy.length, eager.length, what);
      for (let i = 0; i < eager.length; i++) {
        assert.deepStrictEqual(lazy.at(i), eager[i], `${what}, at ${i}`);
        assert.strictEqual(lazy.keyAt(i), eager[i].id, `${what}, at ${i}`);
      }
      assert.deepStrictEqual(lazy.toArray(), eager, what);
      const id = eager[123].id;
      assert.strictEqual(lazy.indexOf(id), 123, what);
      assert.deepStrictEqual(
        lazy.idsBetween(10, 14),
        eager.slice(10, 14).map((r) => r.id),
        what,
      );
    }
  }
});

test('orderedRows makes an entry when asked, and the same one after', () => {
  // Read through a proxy that counts every row it hands out: resolving the
  // ids reads each row once, as `orderRows` does, and then nothing more is
  // read until an entry is asked for.
  const source = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  let reads = 0;
  const rows = new Proxy(source, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const ordered = orderedRows(rows, [], resolveGetId(undefined), null, true);
  assert.strictEqual(reads, 1000, 'the ids are read once a row');
  const entry = ordered.at(500);
  assert.deepStrictEqual(entry, { id: 500, row: source[500], index: 500 });
  assert.strictEqual(reads, 1001, 'one entry, one row read');
  assert.strictEqual(ordered.at(500), entry, 'the same entry, read once');
  assert.strictEqual(reads, 1001);
  assert.strictEqual(ordered.at(1000), undefined);
  assert.strictEqual(ordered.at(-1), undefined);
  assert.strictEqual(ordered.keyAt(1000), undefined);
  const all = ordered.toArray();
  assert.strictEqual(all[500], entry, 'the whole list keeps it');
  assert.strictEqual(ordered.at(500), entry);
  assert.strictEqual(ordered.toArray(), all, 'made once');
});

test('orderedRows checks every id up front, as orderRows does', () => {
  // a row with no id still throws in the render that brought it, wherever
  // it is in the list and whether or not it is ever drawn
  const rows = [{ id: 1 }, { id: 2 }, {}, { id: 4 }] as Array<{ id: number }>;
  assert.throws(
    () => orderedRows(rows, [], resolveGetId(undefined), null, true),
    (err: unknown) =>
      err instanceof TypeError && /row 2 has no id/.test(err.message),
  );
});

test('columnValue reads the property the id names, unless value says otherwise', () => {
  assert.strictEqual(columnValue(FILES[0], { id: 'name' }), 'banana');
  assert.strictEqual(
    columnValue(FILES[0], { id: 'anything', value: (f: File) => f.bytes }),
    300,
  );
  assert.strictEqual(defaultCompare(undefined, ''), 0);
  assert.strictEqual(defaultCompare(2, 10) < 0, true);
});

// --- column widths ---------------------------------------------------------

const px = (
  columns: TableColumn<unknown>[],
  viewport: number,
  user: Record<string, number> = {},
): number[] => resolveWidths(columns, user, viewport).widths;

test('fixed columns take their width, whatever the viewport', () => {
  assert.deepStrictEqual(
    px(
      [
        { id: 'a', width: 100 },
        { id: 'b', width: 60 },
      ],
      500,
    ),
    [100, 60],
  );
});

test('an unsized column stretches: flex 1 with a 120px floor', () => {
  // the zero-config table fills its box…
  assert.deepStrictEqual(px([{ id: 'a' }, { id: 'b' }], 500), [250, 250]);
  // …and never below core's old fixed default, even squeezed
  assert.deepStrictEqual(px([{ id: 'a' }, { id: 'b' }], 100), [
    UNSIZED_MIN,
    UNSIZED_MIN,
  ]);
});

test('flex shares the leftover by weight, after the fixed columns', () => {
  assert.deepStrictEqual(
    px(
      [
        { id: 'a', width: 100 },
        { id: 'b', flex: 1 },
        { id: 'c', flex: 3 },
      ],
      500,
    ),
    [100, 100, 300],
  );
});

test('a flex column clamps at its floor and the rest re-share', () => {
  const widths = px(
    [
      { id: 'a', flex: 1, minWidth: 200 },
      { id: 'b', flex: 1 },
    ],
    300,
  );
  // a's fair share would be 150 < 200, so it takes the floor; b gets the rest
  assert.deepStrictEqual(widths, [200, 100]);
});

test('an explicit flex column floors at 40 unless minWidth says otherwise', () => {
  assert.deepStrictEqual(px([{ id: 'a', flex: 1 }], 10), [MIN_COLUMN]);
});

test('integer widths sum to the pool exactly, whatever the weights', () => {
  const columns = [
    { id: 'a', flex: 1 },
    { id: 'b', flex: 1 },
    { id: 'c', flex: 1 },
  ];
  const { widths, total } = resolveWidths(columns, {}, 401);
  assert.strictEqual(
    widths.reduce((s, w) => s + w, 0),
    401,
    `widths ${widths.join('+')} should sum to the viewport`,
  );
  assert.strictEqual(total, 401);
});

test('a user resize converts the column to fixed, whatever it declared', () => {
  assert.deepStrictEqual(
    px(
      [
        { id: 'a', flex: 1 },
        { id: 'b', flex: 1 },
      ],
      400,
      { a: 90 },
    ),
    [90, 310],
  );
});

test('before the first layout the viewport is 0, and floors hold', () => {
  assert.deepStrictEqual(px([{ id: 'a' }, { id: 'b', flex: 2 }], 0), [
    UNSIZED_MIN,
    MIN_COLUMN,
  ]);
});
