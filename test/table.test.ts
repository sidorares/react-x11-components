// <Table> — the successor to react-x11's own, which may be stripped down or
// removed. The pure model is asserted in table-rows.test.ts and the height
// index in table-heights.test.ts; this file mounts the component and asserts
// the behaviour a user meets: the zero-config fill, sorting from the header,
// the selection grammar in both modes, virtualization in both height models,
// and the seams.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import type { ReactNode } from 'react';

import {
  renderX11,
  cleanup,
  screen,
  userEvent,
  fireEvent,
  act,
} from 'react-x11/test';
import { XK_DOWN, XK_RETURN, XK_RIGHT, XK_UP } from 'react-x11/keysyms';
import type { Node as RetainedNode } from 'react-x11/node';
import type { DrawnNode, KeyboardEvent, ScrollableNode } from 'react-x11';

import { Table } from '../src/index.js';
import type {
  TableColumn,
  TableHandle,
  TableProps,
  TableRowId,
  TableRowState,
  TableSelectChange,
  TableSort,
} from '../src/index.js';

const h = React.createElement;

afterEach(cleanup);

/** The queries hand back the retained node; their public type describes the
 *  narrower ref-facing view. Same widening as `tree.test.ts`. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

function scrolling(node: unknown): ScrollableNode {
  return node as ScrollableNode;
}

function tableRoot(): RetainedNode {
  return retained(screen.all((n) => retained(n).props.role === 'table')[0]);
}

/** The scrolling body pane — the root's second child, after the header
 *  clip. */
function bodyPane(): ScrollableNode {
  return scrolling(tableRoot().children[1]);
}

function rowNodes(): DrawnNode[] {
  return screen.all((n) => retained(n).props.role === 'row');
}

function headerNodes(): DrawnNode[] {
  return screen.all((n) => retained(n).props.role === 'columnheader');
}

/** The first `<text>` under a node. */
function textIn(node: unknown): string {
  const stack = [...retained(node).children];
  while (stack.length) {
    const child = stack.shift() as RetainedNode;
    if (child.kind === 'text') return String(child.props.children ?? '');
    stack.push(...child.children);
  }
  return '';
}

/** The rows on screen, read by their first cell's text. */
function firstCells(): string[] {
  return rowNodes().map((n) => textIn(n));
}

function rowFor(text: string): DrawnNode {
  const node = rowNodes().find((n) => textIn(n) === text);
  assert.ok(node, `no row starting with ${JSON.stringify(text)}`);
  return node;
}

function headerFor(text: string): DrawnNode {
  const node = headerNodes().find((n) => textIn(n) === text);
  assert.ok(node, `no header labelled ${JSON.stringify(text)}`);
  return node;
}

function selectedRows(): string[] {
  return rowNodes()
    .filter((n) => retained(n).props['aria-selected'] === true)
    .map((n) => textIn(n));
}

/** Layout runs on the frame flush and the measure pass a tick after it, so a
 *  render is two turns short of settled. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((res) => setTimeout(res, 20));
    await act();
  }
}

/** Sit still long enough for the idle band to notice and grow — its clock
 *  starts ~120ms after the last scroll and steps every ~40ms. */
async function idle(ms: number): Promise<void> {
  for (let waited = 0; waited < ms; waited += 40) {
    await new Promise((res) => setTimeout(res, 40));
    await act();
  }
}

/** Mount without React's report of an escaping error on stderr. */
async function rejectsQuietly(
  fn: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(fn, expected);
  } finally {
    console.error = origError;
  }
}

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
  { id: 'name', label: 'Name' },
  { id: 'bytes', label: 'Size', value: (f) => f.bytes },
];

function mount(
  props: Record<string, unknown> = {},
  width = 400,
  height = 200,
): Promise<unknown> {
  // The cast, deliberately: several tests hand the union deliberately wrong
  // shapes to meet the remedial TypeErrors, which the compiler would
  // (rightly) refuse. test/types/table.tsx is where the union is asserted.
  return renderX11(
    h(
      'box',
      { style: { width, height, minHeight: 0 } },
      h(Table<File>, {
        columns: COLUMNS,
        rows: FILES,
        ...props,
      } as TableProps<File>),
    ),
  );
}

// --- rendering -------------------------------------------------------------

test('columns and rows are the whole basic setup', async () => {
  await mount();
  await settle();
  assert.deepStrictEqual(
    headerNodes().map((n) => textIn(n)),
    ['Name', 'Size'],
  );
  assert.deepStrictEqual(firstCells(), ['banana', 'apple', 'cherry']);
  // value() feeds the default cell text
  const cells = retained(rowFor('banana')).children.map((c) => textIn(c));
  assert.deepStrictEqual(cells, ['banana', '300']);
});

test('unsized columns stretch: the row fills the box it was given', async () => {
  await mount({}, 400);
  await settle();
  const cells = retained(rowFor('banana')).children.filter(
    (c) => (c as RetainedNode).props.role === 'cell',
  );
  const total = cells.reduce(
    (sum, c) => sum + (c as RetainedNode).abs.width,
    0,
  );
  assert.strictEqual(
    total,
    400,
    `cells should share the whole 400px, got ${total}`,
  );
});

test('the app’s own row shape reads through getId and value', async () => {
  interface Track {
    key: string;
    title: string;
  }
  const rows: Track[] = [
    { key: 'a', title: 'one' },
    { key: 'b', title: 'two' },
  ];
  const picked: TableRowId[] = [];
  await renderX11(
    h(
      'box',
      { style: { width: 300, height: 120, minHeight: 0 } },
      h(Table<Track>, {
        columns: [{ id: 'title' }],
        rows,
        getId: (t) => t.key,
        onSelect: (id) => {
          picked.push(id);
        },
      }),
    ),
  );
  await settle();
  await userEvent.click(rowFor('two'));
  assert.deepStrictEqual(picked, ['b']);
});

test('a row that resolves no id throws the remedial TypeError', async () => {
  await rejectsQuietly(
    () =>
      renderX11(
        h(Table, {
          columns: [{ id: 'name' }],
          rows: [{ name: 'x' }],
        }),
      ),
    /has no id|getId/,
  );
});

// --- sorting ---------------------------------------------------------------

test('the header sorts: asc, then desc, and reports either way', async () => {
  const seen: Array<string> = [];
  await mount({
    onSortChange: (s: TableSort | null) => {
      seen.push(s ? `${s.column}:${s.direction}` : 'null');
    },
  });
  await settle();
  await userEvent.click(headerFor('Size'));
  assert.deepStrictEqual(firstCells(), ['cherry', 'banana', 'apple']);
  await userEvent.click(headerFor('Size'));
  assert.deepStrictEqual(firstCells(), ['apple', 'banana', 'cherry']);
  assert.deepStrictEqual(seen, ['bytes:asc', 'bytes:desc']);
});

test('sortable: false leaves a header inert', async () => {
  await mount({
    columns: [{ id: 'name', label: 'Name', sortable: false }, { id: 'bytes' }],
  });
  await settle();
  await userEvent.click(headerFor('Name'));
  assert.deepStrictEqual(firstCells(), ['banana', 'apple', 'cherry']);
});

test('the controlled descriptor still orders rows unless presorted', async () => {
  await mount({ sort: { column: 'name', direction: 'asc' } });
  await settle();
  assert.deepStrictEqual(firstCells(), ['apple', 'banana', 'cherry']);
  await cleanup();
  await mount({ sort: { column: 'name', direction: 'asc' }, presorted: true });
  await settle();
  assert.deepStrictEqual(firstCells(), ['banana', 'apple', 'cherry']);
});

// --- selection: single -----------------------------------------------------

test('click selects, double-click activates, and the keyboard walks', async () => {
  const selects: TableRowId[] = [];
  const opens: TableRowId[] = [];
  await mount({
    onSelect: (id: TableRowId) => {
      selects.push(id);
    },
    onActivate: (id: TableRowId) => {
      opens.push(id);
    },
  });
  await settle();
  await userEvent.click(rowFor('apple'));
  assert.deepStrictEqual(selectedRows(), ['apple']);
  await userEvent.key(XK_DOWN);
  assert.deepStrictEqual(selectedRows(), ['cherry']);
  await userEvent.key(XK_UP);
  await userEvent.key(XK_RETURN);
  await userEvent.doubleClick(rowFor('banana'));
  assert.deepStrictEqual(selects, [2, 3, 2, 1, 1]);
  // Enter opened the cursor row; the double click selected then opened
  assert.deepStrictEqual(opens, [2, 1]);
});

test('selectionMode="none" is display only', async () => {
  await mount({ selectionMode: 'none' });
  await settle();
  await userEvent.click(rowFor('apple'));
  assert.deepStrictEqual(selectedRows(), []);
  assert.strictEqual(
    retained(rowFor('apple')).props['aria-selected'],
    undefined,
  );
});

test('the two selection shapes are told apart loudly', async () => {
  await rejectsQuietly(
    () => mount({ selected: [1, 2] } as unknown as Partial<TableProps<File>>),
    /selectionMode="multiple"/,
  );
  await cleanup();
  await rejectsQuietly(
    () =>
      mount({
        selectionMode: 'multiple',
        selected: 1,
      } as unknown as Partial<TableProps<File>>),
    /array of ids/,
  );
});

// --- selection: multiple ---------------------------------------------------

test('multiple selection speaks the file-manager grammar', async () => {
  const changes: string[] = [];
  await mount({
    selectionMode: 'multiple',
    onSelectedChange: (ids: TableRowId[], change: TableSelectChange<File>) => {
      changes.push(`${change.type}:${ids.join(',')}`);
    },
  });
  await settle();

  await userEvent.click(rowFor('banana'));
  assert.deepStrictEqual(selectedRows(), ['banana']);

  // shift extends from the anchor — the last plain click
  await userEvent.click(rowFor('cherry'), { modifiers: ['Shift'] });
  assert.deepStrictEqual(selectedRows(), ['banana', 'apple', 'cherry']);

  await userEvent.click(rowFor('apple'), { modifiers: ['Control'] });
  assert.deepStrictEqual(selectedRows(), ['banana', 'cherry']);

  // …and a ctrl toggle moves the anchor with it, the file-manager way
  await userEvent.click(rowFor('cherry'), { modifiers: ['Shift'] });
  assert.deepStrictEqual(selectedRows(), ['apple', 'cherry']);

  assert.deepStrictEqual(changes, [
    'replace:1',
    'range:1,2,3',
    'toggle:1,3',
    'range:2,3',
  ]);
});

test('shift on the keyboard extends, space toggles, ctrl+a takes all', async () => {
  await mount({ selectionMode: 'multiple' });
  await settle();
  await userEvent.click(rowFor('banana'));
  await userEvent.key(XK_DOWN, { modifiers: ['Shift'] });
  assert.deepStrictEqual(selectedRows(), ['banana', 'apple']);

  // space toggles the cursor row out again
  fireEvent.char(' ');
  await act();
  assert.deepStrictEqual(selectedRows(), ['banana']);

  fireEvent.char('a', { modifiers: ['Control'] });
  await act();
  assert.deepStrictEqual(selectedRows(), ['banana', 'apple', 'cherry']);
});

test('a right-click selects what is under it, unless it already is', async () => {
  const menus: TableRowId[] = [];
  await mount({
    selectionMode: 'multiple',
    onRowContextMenu: (id: TableRowId) => {
      menus.push(id);
    },
  });
  await settle();
  fireEvent.contextMenu(rowFor('apple'));
  await act();
  assert.deepStrictEqual(selectedRows(), ['apple']);

  // grow the selection, then right-click inside it: it must not collapse
  await userEvent.click(rowFor('cherry'), { modifiers: ['Shift'] });
  assert.deepStrictEqual(selectedRows(), ['apple', 'cherry']);
  fireEvent.contextMenu(rowFor('apple'));
  await act();
  assert.deepStrictEqual(selectedRows(), ['apple', 'cherry']);

  // …and outside it, the menu applies to what is under the pointer
  fireEvent.contextMenu(rowFor('banana'));
  await act();
  assert.deepStrictEqual(selectedRows(), ['banana']);
  assert.deepStrictEqual(menus, [2, 2, 1]);
});

// --- virtualization --------------------------------------------------------

const many = (n: number): File[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `row ${i}`,
    bytes: i,
  }));

test('declared-uniform rows virtualize by arithmetic: nothing is measured', async () => {
  await mount({ rows: many(400), rowHeight: 24 }, 400, 220);
  await settle();
  // the scrollbar measures the whole list exactly — 400 × 24, no estimates
  assert.strictEqual(bodyPane().contentHeight, 400 * 24 + 0);
  // a slice plus at most the idle band — never the whole list
  assert.ok(rowNodes().length < 180, `built ${rowNodes().length} of 400`);

  bodyPane().scrollTo({ y: 5000 });
  await settle();
  const posts = rowNodes().map((n) =>
    Number(retained(n).props['aria-posinset']),
  );
  assert.ok(
    posts.some((p) => p > 200),
    `the slice should have moved with the scroll, saw ${posts[0]}…`,
  );
  assert.strictEqual(bodyPane().contentHeight, 400 * 24);
});

test('measured rows total honestly, converge, and stay a slice', async () => {
  // every cell wraps to several lines in a narrow column, so the uniform
  // guess is wrong for every row — the scrollbar has to learn better
  const LONG =
    'a name much too long for one line of a narrow column, kept long enough to wrap twice';
  await mount(
    {
      rows: many(400),
      columns: [
        {
          id: 'name',
          label: 'Name',
          render: (f: File) => h('text', { key: 't' }, `${LONG} ${f.id}`),
        },
      ],
      virtual: true,
    },
    240,
    220,
  );
  await settle();
  const guess = 400 * 24;
  const measured = bodyPane().contentHeight;
  assert.ok(
    measured > guess,
    `the total is still the flat guess: ${measured} vs ${guess}`,
  );
  await settle();
  assert.strictEqual(bodyPane().contentHeight, measured, 'it converged');

  // Far enough that the idle band around the top cannot already have
  // measured the destination — the band converges the scrollbar while the
  // table sits still, which is the point of it.
  bodyPane().scrollTo({ y: 8000 });
  await settle();
  assert.ok(
    bodyPane().contentHeight > measured,
    'scrolling should have measured more rows',
  );
  assert.ok(rowNodes().length < 180, `built ${rowNodes().length} of 400`);
});

// --- the idle band ---------------------------------------------------------
//
// The pane blits a scroll before React can run, so the only scroll with no
// blank frame is one that lands on rows already built. The band is those
// rows: grown while the table sits still, kept behind the viewport for the
// way back, and off entirely at prefetch={0}.

test('the idle band grows past the overscan while the table sits still', async () => {
  await mount({ rows: many(400), rowHeight: 24 }, 400, 220);
  await settle();
  await idle(400);
  // the viewport holds ~10 rows and the overscan 6 more — anything well past
  // that is the band, built while nobody was scrolling
  assert.ok(
    rowNodes().length > 40,
    `the band never grew: ${rowNodes().length} rows built`,
  );
  assert.ok(rowNodes().length < 180, `built ${rowNodes().length} of 400`);
});

test('prefetch={0} keeps the slice at viewport plus overscan', async () => {
  await mount({ rows: many(400), rowHeight: 24, prefetch: 0 }, 400, 220);
  await settle();
  await idle(400);
  assert.ok(
    rowNodes().length < 40,
    `the band grew with prefetch off: ${rowNodes().length} rows built`,
  );
});

test('a scroll inside the band lands on rows already built', async () => {
  await mount({ rows: many(400), rowHeight: 24 }, 400, 220);
  await settle();
  await idle(400);
  const posts = (): number[] =>
    rowNodes().map((n) => Number(retained(n).props['aria-posinset']));
  const before = new Set(posts());
  assert.ok(Math.max(...before) > 40, 'the band should reach past row 40');

  // one viewport down — inside the band, so every row now on screen must
  // have been built before the scroll: that is what the band is *for*
  bodyPane().scrollTo({ y: 240 });
  await act();
  for (const p of posts()) {
    const y = (p - 1) * 24;
    if (y >= 240 && y < 240 + 220) {
      assert.ok(before.has(p), `row ${p} scrolled in unbuilt`);
    }
  }
  // and the rows scrolled past stay mounted, for the way back
  assert.ok(posts().includes(1), 'the trailing rows were dropped');
});

test('the idle band measures above the viewport without moving what is on screen', async () => {
  // The end-to-end shape of `reveal.nudge`: rows above the viewport measure
  // taller than the guess while the table sits idle, the content above
  // grows, and the offset absorbs every pixel of it — near the bottom of
  // the list that takes more than one layout, because the pane clamps
  // against a content height that has not admitted the growth yet.
  const LONG =
    'a name much too long for one line of a narrow column, kept long enough to wrap twice';
  await mount(
    {
      rows: many(400),
      columns: [
        {
          id: 'name',
          label: 'Name',
          render: (f: File) => h('text', { key: 't' }, `${LONG} ${f.id}`),
        },
      ],
      virtual: true,
    },
    240,
    220,
  );
  await settle();
  bodyPane().scrollTo({ y: 4000 });
  await settle();
  const topRow = (): number => {
    const pane = retained(bodyPane());
    const top = rowNodes()
      .map(retained)
      .filter((n) => n.abs.height > 0)
      .sort((a, b) => a.abs.y - b.abs.y)
      .find((n) => n.abs.y + n.abs.height > pane.abs.y);
    return Number(top?.props['aria-posinset'] ?? -1);
  };
  const was = topRow();
  const content = bodyPane().contentHeight;
  await idle(500);
  assert.ok(
    bodyPane().contentHeight > content,
    'the band never measured anything',
  );
  assert.strictEqual(topRow(), was, 'the row at the top of the viewport moved');
});

test('virtual={false} keeps a big table whole', async () => {
  await mount({ rows: many(300), virtual: false, rowHeight: 24 }, 400, 200);
  await settle();
  assert.strictEqual(rowNodes().length, 300);
});

// --- the header stays put --------------------------------------------------

test('the header tracks horizontal scroll and never vertical', async () => {
  const wide: TableColumn<File>[] = [
    { id: 'name', label: 'Name', width: 300 },
    { id: 'bytes', label: 'Size', width: 300 },
  ];
  await mount({ columns: wide, rows: many(300), rowHeight: 24 }, 400, 200);
  await settle();
  const before = retained(headerFor('Name')).abs.x;

  bodyPane().scrollTo({ x: 120, y: 2000 });
  await settle();
  assert.strictEqual(
    retained(headerFor('Name')).abs.x,
    before - 120,
    'the header shifted with scrollX',
  );
  assert.ok(
    retained(headerFor('Name')).abs.y < 30,
    'and never moved vertically',
  );
});

test('clicking a row keeps the columns where they are', async () => {
  // Revealing the row it selected used to be `scrollIntoView`, which brings a
  // node fully into view on *both* axes — and a row is as wide as the whole
  // content, so a table scrolled sideways snapped back to the first column on
  // every click. A reveal is vertical; that is all it ever meant.
  const wide: TableColumn<File>[] = [
    { id: 'name', label: 'Name', width: 300 },
    { id: 'bytes', label: 'Size', width: 300 },
  ];
  await mount({ columns: wide, rows: many(300), rowHeight: 24 }, 400, 200);
  await settle();
  bodyPane().scrollTo({ x: 150 });
  await settle();
  assert.strictEqual(bodyPane().scrollX, 150);

  await userEvent.click(rowNodes()[2]);
  await settle();
  assert.strictEqual(bodyPane().scrollX, 150, 'the click moved the columns');
});

// --- resize ----------------------------------------------------------------

test('the grip resizes by keyboard, reports, and converts to fixed', async () => {
  const resizes: Array<[string, number]> = [];
  await mount({
    columns: [
      { id: 'name', label: 'Name', width: 100 },
      { id: 'bytes', label: 'Size', flex: 1 },
    ],
    onColumnResize: (id: string, w: number) => {
      resizes.push([id, w]);
    },
  });
  await settle();
  const grip = screen.all((n) => retained(n).props.role === 'separator')[0];
  await userEvent.click(grip); // focuses the handle
  await userEvent.key(XK_RIGHT);
  assert.deepStrictEqual(resizes, [['name', 116]]);
  await settle();
  const nameCell = retained(rowFor('banana')).children[0] as RetainedNode;
  assert.strictEqual(nameCell.abs.width, 116);
});

// --- seams -----------------------------------------------------------------

test('renderHeader, renderRow and renderEmpty each replace their part', async () => {
  await mount({
    columns: [
      {
        id: 'name',
        label: 'Name',
        renderHeader: () => h('text', { key: 'x' }, 'CUSTOM HEAD'),
      },
    ],
    renderRow: (state: TableRowState<File>, content: ReactNode[]) =>
      h('box', { key: 'wrap', style: { flexDirection: 'row' } }, [
        h('text', { key: 'mark' }, `#${state.index} `),
        ...content,
      ]),
  });
  await settle();
  assert.ok(
    headerNodes().some((n) => textIn(n) === 'CUSTOM HEAD'),
    'renderHeader owns the header content',
  );
  assert.strictEqual(textIn(rowFor('#0 ')), '#0 ', 'renderRow wrapped the row');

  await cleanup();
  await mount({ rows: [], renderEmpty: () => h('text', null, 'no files yet') });
  await settle();
  const empty = screen.all(
    (n) =>
      retained(n).kind === 'text' &&
      String(retained(n).props.children) === 'no files yet',
  );
  assert.strictEqual(empty.length, 1);
  assert.strictEqual(rowNodes().length, 0);
});

// --- a live tail -----------------------------------------------------------
//
// The pattern a log, a console or a packet trace is: rows arrive, and the app
// scrolls to the newest one. What made that hard is that neither half of it
// is synchronous — layout runs a frame after the commit, and the scroll
// container moves *silently* when it resolves a queued `scrollIntoView` or
// re-clamps an offset the content outgrew or outshrank.

/** A table that appends rows and scrolls to the last one, the way a log
 *  viewer does. `append` is handed back through the ref-shaped argument. */
function Tail(props: {
  start: number;
  cap?: number;
  hooks: { append?: (n: number) => void };
  rowHeight?: number;
  wrap?: boolean;
  /** `0` in the tests whose invariant is "the slice moves rather than
   *  grows" — the idle band deliberately keeps rows behind the viewport. */
  prefetch?: number;
}): ReactNode {
  const [rows, setRows] = React.useState<File[]>(() => many(props.start));
  const ref = React.useRef<TableHandle<File> | null>(null);
  const next = React.useRef(props.start);
  props.hooks.append = (n: number) => {
    setRows((prev) => {
      const grown = [
        ...prev,
        ...Array.from({ length: n }, () => {
          const i = next.current++;
          return { id: i, name: `row ${i}`, bytes: i };
        }),
      ];
      return props.cap
        ? grown.slice(Math.max(0, grown.length - props.cap))
        : grown;
    });
  };
  React.useEffect(() => {
    const last = rows[rows.length - 1];
    if (last) ref.current?.scrollToRow(last.id);
  }, [rows]);
  return h(
    'box',
    { style: { width: 400, height: 220, minHeight: 0 } },
    h(Table<File>, {
      ref,
      rows,
      virtual: true,
      rowHeight: props.rowHeight,
      prefetch: props.prefetch,
      columns: props.wrap
        ? [
            {
              id: 'name',
              label: 'Name',
              // a cell that wraps: rows are not one height, so the height
              // index has to be measured and the total moves as rows drop
              render: (f: File) =>
                h(
                  'text',
                  { key: 't' },
                  `${f.name} — a summary long enough to wrap across more than one line of this column`,
                ),
            },
          ]
        : COLUMNS,
    } as TableProps<File>),
  );
}

/** The whole point of a virtualized slice: the rows that were built have to
 *  be the rows the viewport is looking at. A gap at either end is the bug —
 *  a blank band where rows should be. */
function assertCoversViewport(what: string): void {
  const box = bodyPane();
  const drawn = rowNodes().map(retained);
  assert.ok(drawn.length > 0, `${what}: nothing was built`);
  const top = drawn[0].abs.y;
  const bottom =
    drawn[drawn.length - 1].abs.y + drawn[drawn.length - 1].abs.height;
  assert.ok(
    top <= retained(box).abs.y + 1,
    `${what}: ${retained(box).abs.y - top}px of blank above the rows`,
  );
  assert.ok(
    bottom >= retained(box).abs.y + retained(box).abs.height - 1,
    `${what}: blank below the rows`,
  );
}

/** How far the body can go — the bottom a tail is trying to sit at. */
function maxScroll(): number {
  return Math.max(
    0,
    bodyPane().contentHeight - retained(bodyPane()).abs.height,
  );
}

/**
 * The newest row is built, and all of it is in the pane.
 *
 * That is what a tail promises. Not `scrollY === maxScroll()`: in a measured
 * list the bottom moves for a reason that has nothing to do with the tail —
 * measuring a row *above* the viewport grows the content, and the scroll
 * offset absorbs the difference on purpose so that what is on screen does not
 * jump. The distance to the bottom grows; the view is exactly where it was.
 * Where nothing is ever measured — `rowHeight` declared — the exact bottom is
 * asserted instead.
 */
async function assertTailShows(what: string, position: number): Promise<void> {
  // Given a few frames, not one: with rows measured, reaching the newest row
  // takes as many passes as the heights around it take to settle, and a
  // loaded machine fits fewer of those into a fixed wait.
  let under = 0;
  for (let round = 0; round < 8; round++) {
    const drawn = rowNodes().map(retained);
    const last = drawn[drawn.length - 1];
    assert.ok(last, `${what}: nothing was built`);
    assert.strictEqual(
      Number(last.props['aria-posinset']),
      position,
      `${what}: the newest row is not the last one built`,
    );
    const pane = retained(bodyPane());
    assert.ok(
      last.abs.y >= pane.abs.y - 1,
      `${what}: the newest row starts above the pane`,
    );
    under = last.abs.y + last.abs.height - (pane.abs.y + pane.abs.height);
    if (under <= 1) return;
    await settle();
  }
  assert.fail(`${what}: the newest row is ${under}px below the fold`);
}

function lastDrawnPosition(): number {
  const drawn = rowNodes().map(retained);
  return Number(drawn[drawn.length - 1].props['aria-posinset']);
}

test('a tail reaches the newest row, however fast the rows arrive', async () => {
  const hooks: { append?: (n: number) => void } = {};
  await renderX11(h(Tail, { start: 300, hooks }));
  await settle();
  // the mount's own scroll counts: it is asked for before there is any
  // laid-out content to scroll through
  await assertTailShows('on mount', 300);

  // a burst: many updates in one frame, each one scrolling to its newest row
  for (let burst = 0; burst < 4; burst++) {
    await act(() => {
      for (let i = 0; i < 12; i++) hooks.append?.(4);
    });
    await settle();
    await assertTailShows(`burst ${burst}`, 300 + (burst + 1) * 48);
    assertCoversViewport(`burst ${burst}`);
  }
});

test('the slice follows the offset even when nothing said it moved', async () => {
  // One row at a time, with the newest row already mounted — so the reveal
  // resolves as a `scrollIntoView` inside layout, which fires no event. The
  // slice used to freeze there: `first` stopped moving, the rendered rows
  // piled up, and the newest rows stopped being built at all.
  const hooks: { append?: (n: number) => void } = {};
  // prefetch: 0 — the invariant here is that the slice *moves* rather than
  // grows, and the idle band exists precisely to keep rows behind the
  // viewport. Its own behaviour is asserted separately.
  await renderX11(h(Tail, { start: 300, hooks, rowHeight: 24, prefetch: 0 }));
  await settle();
  const firstDrawn = (): number =>
    Number(retained(rowNodes()[0]).props['aria-posinset']);
  const started = firstDrawn();
  const built = rowNodes().length;
  for (let i = 0; i < 8; i++) {
    await act(() => hooks.append?.(1));
    await settle();
  }
  assert.strictEqual(bodyPane().scrollY, maxScroll(), 'still pinned');
  assert.strictEqual(lastDrawnPosition(), 308, 'the newest row is built');
  assert.strictEqual(firstDrawn(), started + 8, 'the slice moved with it');
  assert.ok(
    rowNodes().length <= built + 1,
    `the slice grew instead of moving: ${built} → ${rowNodes().length}`,
  );
  assertCoversViewport('one row at a time');
});

test('a capped tail of unequal rows keeps the viewport full', async () => {
  // The buffer is capped, so rows drop off the front and the content height
  // *shrinks* — the container re-clamps its offset with nothing said about
  // it, and a slice built from the offset before that is drawn where the
  // viewport is not.
  const hooks: { append?: (n: number) => void } = {};
  await renderX11(h(Tail, { start: 400, cap: 400, hooks, wrap: true }));
  await settle();
  for (let burst = 0; burst < 6; burst++) {
    await act(() => {
      for (let i = 0; i < 6; i++) hooks.append?.(5);
    });
    await settle();
    assertCoversViewport(`capped burst ${burst}`);
    assert.strictEqual(
      lastDrawnPosition(),
      400,
      `capped burst ${burst}: the newest row is built`,
    );
  }
});

test('a row taller than the viewport is revealed by its top, once', async () => {
  // Neither edge of such a row can be brought into view without pushing the
  // other one out, and a reveal that keeps asking for both takes turns
  // forever. The top is the part worth showing, and reaching it settles it.
  const tall = Array.from(
    { length: 40 },
    (_, i) => `line ${i} of one row`,
  ).join(' ');
  const rows: File[] = many(400).map((f) =>
    f.id === 250 ? { ...f, name: tall } : f,
  );
  const ref = React.createRef<TableHandle<File>>();
  let scrolls = 0;
  await renderX11(
    h(
      'box',
      { style: { width: 240, height: 160, minHeight: 0 } },
      h(Table<File>, {
        ref,
        rows,
        virtual: true,
        columns: [
          {
            id: 'name',
            label: 'Name',
            render: (f: File) => h('text', { key: 't' }, f.name),
          },
        ],
        onScroll: () => {
          scrolls++;
        },
      } as TableProps<File>),
    ),
  );
  await settle();
  ref.current?.scrollToRow(250);
  await settle();
  // asked again, now that the row has been measured at its real height
  ref.current?.scrollToRow(250);
  await settle();
  const at = bodyPane().scrollY;
  const quiet = scrolls;
  await settle();
  assert.strictEqual(bodyPane().scrollY, at, 'the offset is still moving');
  assert.strictEqual(scrolls, quiet, 'and it is still scrolling');
  const row = rowNodes()
    .map(retained)
    .find((n) => Number(n.props['aria-posinset']) === 251);
  assert.ok(row, 'the tall row is built');
  assert.strictEqual(
    row.abs.y,
    retained(bodyPane()).abs.y,
    'the row starts at the top of the pane',
  );
  assert.ok(
    row.abs.height > retained(bodyPane()).abs.height,
    'the row really is taller than the viewport',
  );
});

test('a scroll of the user’s own ends the tail rather than fighting it', async () => {
  const hooks: { append?: (n: number) => void } = {};
  await renderX11(h(Tail, { start: 300, hooks, rowHeight: 24 }));
  await settle();
  bodyPane().scrollTo({ y: 0 });
  await settle();
  assert.strictEqual(bodyPane().scrollY, 0, 'the user is at the top');
  assert.strictEqual(
    Number(retained(rowNodes()[0]).props['aria-posinset']),
    1,
    'and the first rows are the ones built',
  );
});

// --- the handle ------------------------------------------------------------

test('the handle selects, scrolls, walks keys, and reads the model', async () => {
  const ref = React.createRef<TableHandle<File>>();
  await mount({ rows: many(400), rowHeight: 24, ref }, 400, 220);
  await settle();
  const handle = ref.current;
  assert.ok(handle);

  assert.strictEqual(handle.rows().length, 400);
  assert.strictEqual(handle.rows()[0].id, 0);

  assert.strictEqual(handle.scrollToRow(399), true);
  await settle();
  assert.ok(bodyPane().scrollY > 8000, 'scrolled to the far end');
  assert.strictEqual(handle.scrollToRow('missing'), false);

  handle.select(5);
  await act();
  assert.strictEqual(handle.rows().find((r) => r.id === 5)?.index, 5);

  // a filter box above the table forwards the keys it does not use
  const took = handle.handleKey({ keysym: XK_DOWN } as KeyboardEvent);
  assert.strictEqual(took, true);
  const notOurs = handle.handleKey({
    keysym: 0x1234,
    key: 'x',
  } as KeyboardEvent);
  assert.strictEqual(notOurs, false);
});
