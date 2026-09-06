// <ReorderList> — the sortable layer over core's drag and drop, and the
// decisions in it a reader of the source would not guess: the list is the
// only drop target and reads every item's box per motion, the indicator is
// drawn by the item at the closest edge, a same-list drag over its own gap
// promises nothing and fires nothing, a handle takes over both the press
// and the tab stop, a move between two lists is `onInsert` on one and
// `onRemove` on the other, and foreign drags are refused unless `accept`
// took them.
//
// Cannot run on the mock backend: every drag here goes through the
// in-process X server, which is what core's own in-app transport listens
// to. Still headless.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React, { useState } from 'react';
import type { ReactElement } from 'react';

import {
  renderX11,
  cleanup,
  screen,
  fireEvent,
  userEvent,
  act,
} from 'react-x11/test';
import type { PointerOptions } from 'react-x11/test';
import { ThemeProvider } from 'react-x11';
import type { DrawnNode } from 'react-x11';
import type { Node as RetainedNode } from 'react-x11/node';
import {
  XK_DOWN,
  XK_ESCAPE,
  XK_LEFT,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';

import {
  ReorderHandle,
  ReorderItem,
  ReorderList,
  arrayMove,
  useReorderItem,
} from '../src/index.js';
import type {
  ReorderChange,
  ReorderDrop,
  ReorderId,
  ReorderInsert,
  ReorderItemState,
  ReorderListProps,
  ReorderRemove,
} from '../src/index.js';

const h = React.createElement;

afterEach(cleanup);

/** Every piece of text under a node, joined — what an item reads as. The
 *  ghost is a `<popup>` child of the item it copies, and is not the item. */
function textOfItem(node: DrawnNode): string {
  const parts: string[] = [];
  const walk = (n: DrawnNode): void => {
    if (n !== node && (n.kind === 'popup' || n.kind === 'window')) return;
    const text = n.textContent();
    if (text) parts.push(text);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return parts.join('');
}

/** Widen a query result to the retained node, for `props` and `style`. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

const ITEM = { width: 200, height: 30 };
const GAP = 4;

interface ListSpec extends Omit<ReorderListProps, 'children' | 'onReorder'> {
  name: string;
  items: ReorderId[];
  handle?: boolean;
  disabledItems?: ReorderId[];
  /** Whether the harness applies `onReorder` to its own order. Default true. */
  live?: boolean;
  size?: { width: number; height: number };
  onReorder?: (change: ReorderChange) => void;
}

/**
 * One list, holding its order as state and applying every `onReorder` to it
 * — the way an app does — so the keyboard's per-step events land on a tree
 * that has actually moved. Every part is named for the queries:
 * `<name>-<id>` for an item, `<name>-<id>-handle`, `-indicator`, `-preview`.
 */
function List(spec: ListSpec): ReactElement {
  const {
    name,
    items,
    handle = false,
    disabledItems = [],
    live = true,
    size = ITEM,
    onReorder,
    ...rest
  } = spec;
  const [order, setOrder] = useState(items);
  return h(
    ReorderList,
    {
      'data-testname': name,
      onReorder: (change: ReorderChange) => {
        onReorder?.(change);
        if (live) setOrder(change.items);
      },
      style: { gap: GAP, padding: 10 },
      ...rest,
    },
    order.map((id) =>
      h(
        ReorderItem,
        {
          key: id,
          id,
          disabled: disabledItems.includes(id),
          'data-testname': `${name}-${id}`,
          style: {
            ...size,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          },
        },
        handle && h(ReorderHandle, { 'data-testname': `${name}-${id}-handle` }),
        h('text', null, `Item ${id}`),
      ),
    ),
  );
}

function view(...lists: ReactElement[]): ReactElement {
  return h(
    'window',
    { width: 520, height: 420 } as Record<string, unknown>,
    h(
      ThemeProvider,
      { value: {}, colorScheme: 'light' },
      h(
        'box',
        { style: { flexDirection: 'row', gap: 20 } },
        ...lists,
        h('box', {
          'data-testname': 'outside',
          style: { width: 60, height: 200 },
        }),
      ),
    ),
  );
}

const mount = (element: ReactElement, options: Record<string, unknown> = {}) =>
  renderX11(element, { wrap: false, ...options } as never);

const item = (name: string, id: ReorderId) =>
  screen.getByTestName(`${name}-${id}`);

/** The ids of a list's items, in the order layout put them. */
function orderOf(name: string): string[] {
  return screen
    .getAllByRole('listitem')
    .filter((n) =>
      String(retained(n).props['data-testname']).startsWith(`${name}-`),
    )
    .sort((a, b) => a.abs.y - b.abs.y || a.abs.x - b.abs.x)
    .map((n) =>
      String(retained(n).props['data-testname']).slice(name.length + 1),
    );
}

/**
 * ntk coalesces `mousemove` onto its own frame clock, which `act()` does not
 * run — the same wait core's selection tests and `markdown.test.ts` take.
 */
async function landed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act();
}

/** Press on `from`, move past the threshold, then move to `to` (+ offset)
 *  and stop there — so a test can look at the indicator and the preview
 *  before `release`. `dx`/`dy` are device pixels from the node's centre. */
async function dragTo(
  from: DrawnNode,
  to: DrawnNode,
  at: PointerOptions = {},
  threshold: PointerOptions = { dx: 6 },
): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(from);
  });
  await act(async () => {
    fireEvent.mouseMove(from, threshold);
  });
  await landed();
  await act(async () => {
    fireEvent.mouseMove(to, at);
  });
  await landed();
}

/** Space on whatever has the focus, as a real key. */
async function space(): Promise<void> {
  await act(async () => {
    fireEvent.char(' ');
  });
}

async function release(at: DrawnNode, options: PointerOptions = {}) {
  await act(async () => {
    fireEvent.mouseUp(at, options);
  });
  await landed();
}

test('a list of items, and it tells a screen reader so', async () => {
  await mount(view(h(List, { name: 'l', items: ['a', 'b', 'c'] })));
  const list = screen.getByRole('list');
  assert.strictEqual(retained(list).props['aria-orientation'], 'vertical');
  assert.strictEqual(screen.getAllByRole('listitem').length, 3);
  // without a handle the item is the tab stop, and says what it can do
  const a = retained(item('l', 'a'));
  assert.strictEqual(a.props.focusable, true);
  assert.match(String(a.props['aria-description']), /Space to lift/);
  assert.deepStrictEqual(orderOf('l'), ['a', 'b', 'c']);
});

test("a drag past the threshold to another item's lower half moves it there", async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  const c = item('l', 'c');
  await dragTo(item('l', 'a'), c, { dy: 10 });
  // mid-drag: the indicator is on c's lower edge, and a preview follows
  const indicator = screen.getByTestName('l-c-indicator');
  assert.ok(
    indicator.abs.y + indicator.abs.height / 2 >= c.abs.y + c.abs.height - 2,
  );
  assert.ok(screen.queryByTestName('l-a-preview'), 'a preview window is up');
  await release(c, { dy: 10 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'c', 'a'], id: 'a', from: 0, to: 2 },
  ]);
  assert.deepStrictEqual(orderOf('l'), ['b', 'c', 'a']);
  assert.ok(screen.queryByTestName('l-c-indicator') === null);
  assert.ok(screen.queryByTestName('l-a-preview') === null);
});

test('the upper half of an item is the gap before it', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  const a = item('l', 'a');
  await dragTo(item('l', 'c'), a, { dy: -10 });
  assert.ok(screen.queryByTestName('l-a-indicator'));
  await release(a, { dy: -10 });
  assert.deepStrictEqual(changes, [
    { items: ['c', 'a', 'b'], id: 'c', from: 2, to: 0 },
  ]);
});

test('a drag over its own gap promises nothing and fires nothing', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  const b = item('l', 'b');
  // b's own lower half — the gap after b — and a's lower half: the gap
  // before b. Neither moves anything.
  await dragTo(b, b, { dy: 10 });
  assert.ok(screen.queryByTestName('l-b-indicator') === null);
  await act(async () => {
    fireEvent.mouseMove(item('l', 'a'), { dy: 10 });
  });
  await landed();
  assert.ok(screen.queryByTestName('l-a-indicator') === null);
  await release(item('l', 'a'), { dy: 10 });
  assert.deepStrictEqual(changes, []);
});

test('below the threshold a press is still a click, and nothing moves', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  await act(async () => {
    fireEvent.mouseDown(item('l', 'a'));
    fireEvent.mouseMove(item('l', 'a'), { dx: 1 });
    fireEvent.mouseUp(item('l', 'a'), { dx: 1 });
  });
  await landed();
  assert.deepStrictEqual(changes, []);
  // and the press focused the item, which is what a click does
  assert.ok(item('l', 'a').focused);
});

test('a handle is the only press target, and the tab stop', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        handle: true,
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  const a = retained(item('l', 'a'));
  const grip = screen.getByTestName('l-a-handle');
  assert.strictEqual(a.props.focusable, undefined, 'the item gave up its stop');
  assert.strictEqual(a.props.draggable, undefined);
  assert.strictEqual(retained(grip).props.focusable, true);
  assert.strictEqual(retained(grip).props.draggable, true);
  assert.strictEqual(retained(grip).props.role, 'button');

  // the body: a drag that never starts
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 10 }, { dx: 30 });
  assert.ok(screen.queryByTestName('l-c-indicator') === null);
  await release(item('l', 'c'), { dy: 10 });
  assert.deepStrictEqual(changes, []);

  // the grip: the same gesture works
  await dragTo(grip, item('l', 'c'), { dy: 10 });
  await release(item('l', 'c'), { dy: 10 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'c', 'a'], id: 'a', from: 0, to: 2 },
  ]);
});

test('a disabled item does not drag, but is still a slot others land beside', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        disabledItems: ['b'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  assert.strictEqual(retained(item('l', 'b')).props.draggable, undefined);
  assert.strictEqual(retained(item('l', 'b')).props.focusable, false);
  await dragTo(item('l', 'b'), item('l', 'c'), { dy: 10 });
  await release(item('l', 'c'), { dy: 10 });
  assert.deepStrictEqual(changes, []);
  // a lands before b
  await dragTo(item('l', 'c'), item('l', 'b'), { dy: -10 });
  await release(item('l', 'b'), { dy: -10 });
  assert.deepStrictEqual(changes, [
    { items: ['a', 'c', 'b'], id: 'c', from: 2, to: 1 },
  ]);
});

test('a horizontal strip reads x, and its indicator stands on a side', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        orientation: 'horizontal',
        size: { width: 100, height: 30 },
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  assert.strictEqual(
    retained(screen.getByRole('list')).props['aria-orientation'],
    'horizontal',
  );
  const c = item('l', 'c');
  await dragTo(item('l', 'a'), c, { dx: 20 });
  const indicator = screen.getByTestName('l-c-indicator');
  assert.ok(indicator.abs.width < indicator.abs.height, 'a vertical line');
  assert.ok(
    indicator.abs.x + indicator.abs.width / 2 >= c.abs.x + c.abs.width - 2,
  );
  await release(c, { dx: 20 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'c', 'a'], id: 'a', from: 0, to: 2 },
  ]);
});

test('the keyboard: Space lifts, the arrows move and fire per step, Space drops', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  const b = item('l', 'b');
  await userEvent.click(b);
  assert.ok(b.focused);
  // not lifted: the arrows walk the neighbours
  await userEvent.key(XK_DOWN);
  assert.ok(item('l', 'c').focused);
  await userEvent.key(XK_UP);
  assert.ok(b.focused);
  assert.deepStrictEqual(changes, []);

  await space();
  await userEvent.key(XK_DOWN);
  assert.deepStrictEqual(changes, [
    { items: ['a', 'c', 'b'], id: 'b', from: 1, to: 2 },
  ]);
  assert.deepStrictEqual(orderOf('l'), ['a', 'c', 'b']);
  // the moved item is the same node, and it kept the focus
  assert.ok(item('l', 'b').focused);
  await userEvent.key(XK_UP);
  await userEvent.key(XK_UP);
  assert.deepStrictEqual(changes.at(-1), {
    items: ['b', 'a', 'c'],
    id: 'b',
    from: 1,
    to: 0,
  });
  // at the top already: nothing more
  await userEvent.key(XK_UP);
  assert.strictEqual(changes.length, 3);
  await space();
  // dropped: the arrows walk again
  await userEvent.key(XK_DOWN);
  assert.ok(item('l', 'a').focused);
  assert.strictEqual(changes.length, 3);
});

test('the keyboard: Escape puts a lifted item back where it was', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  await userEvent.click(item('l', 'a'));
  await space();
  await userEvent.key(XK_DOWN);
  await userEvent.key(XK_DOWN);
  assert.deepStrictEqual(orderOf('l'), ['b', 'c', 'a']);
  await userEvent.key(XK_ESCAPE);
  assert.deepStrictEqual(changes.at(-1), {
    items: ['a', 'b', 'c'],
    id: 'a',
    from: 2,
    to: 0,
  });
  assert.deepStrictEqual(orderOf('l'), ['a', 'b', 'c']);
  // no longer lifted: an arrow walks rather than moves
  await userEvent.key(XK_DOWN);
  assert.ok(item('l', 'b').focused);
  assert.strictEqual(changes.length, 3);
});

test('the keyboard on a horizontal strip: Left and Right, mirrored under RTL', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        orientation: 'horizontal',
        size: { width: 100, height: 30 },
        onReorder: (c) => changes.push(c),
        style: { direction: 'rtl' },
      }),
    ),
  );
  await userEvent.click(item('l', 'a'));
  await space();
  // in RTL the next item in reading order is to the *left*
  await userEvent.key(XK_LEFT);
  assert.deepStrictEqual(changes.at(-1), {
    items: ['b', 'a', 'c'],
    id: 'a',
    from: 0,
    to: 1,
  });
  await userEvent.key(XK_RIGHT);
  assert.deepStrictEqual(changes.at(-1), {
    items: ['a', 'b', 'c'],
    id: 'a',
    from: 1,
    to: 0,
  });
});

test('two lists in a group: onInsert on the one it landed in, onRemove on the one it left', async () => {
  const inserts: ReorderInsert[] = [];
  const removes: ReorderRemove[] = [];
  const reorders: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'todo',
        id: 'todo',
        group: 'board',
        items: ['a', 'b'],
        onReorder: (c) => reorders.push(c),
        onRemove: (c) => removes.push(c),
        onInsert: (c) => inserts.push({ ...c, items: ['wrong list'] }),
      }),
      h(List, {
        name: 'done',
        id: 'done',
        group: 'board',
        items: ['x', 'y'],
        onReorder: (c) => reorders.push(c),
        onInsert: (c) => inserts.push(c),
      }),
    ),
  );
  const y = item('done', 'y');
  await dragTo(item('todo', 'a'), y, { dy: -10 });
  assert.ok(
    screen.queryByTestName('done-y-indicator'),
    'the other list marks the slot',
  );
  await release(y, { dy: -10 });

  assert.strictEqual(inserts.length, 1);
  const [insert] = inserts;
  assert.deepStrictEqual(
    {
      items: insert!.items,
      id: insert!.id,
      index: insert!.index,
      source: insert!.source,
    },
    {
      items: ['x', 'a', 'y'],
      id: 'a',
      index: 1,
      source: { list: 'todo', index: 0 },
    },
  );
  assert.strictEqual(insert!.event.source, 'internal');

  assert.strictEqual(removes.length, 1);
  const [remove] = removes;
  assert.deepStrictEqual(
    {
      items: remove!.items,
      id: remove!.id,
      index: remove!.index,
      to: remove!.to,
    },
    { items: ['b'], id: 'a', index: 0, to: { list: 'done', index: 1 } },
  );
  assert.strictEqual(remove!.event.action, 'move');
  assert.strictEqual(remove!.event.dropped, true);
  assert.deepStrictEqual(reorders, [], 'a move between lists is not a reorder');
});

test('two lists not in one group ignore each other', async () => {
  const inserts: ReorderInsert[] = [];
  const removes: ReorderRemove[] = [];
  await mount(
    view(
      h(List, {
        name: 'p',
        items: ['a', 'b'],
        onRemove: (c) => removes.push(c),
      }),
      h(List, {
        name: 'q',
        items: ['x', 'y'],
        onInsert: (c) => inserts.push(c),
      }),
    ),
  );
  const y = item('q', 'y');
  await dragTo(item('p', 'a'), y, { dy: -10 });
  assert.ok(screen.queryByTestName('q-y-indicator') === null);
  await release(y, { dy: -10 });
  assert.deepStrictEqual(inserts, []);
  assert.deepStrictEqual(removes, []);
  assert.deepStrictEqual(orderOf('p'), ['a', 'b']);
});

test('a foreign drag is refused without `accept`, and taken at a slot with it', async () => {
  const drops: ReorderDrop[] = [];
  let ended: { action: string | null; dropped: boolean } | null = null;
  const source = () =>
    h('box', {
      'data-testname': 'src',
      draggable: true,
      dragData: { 'text/plain': 'hello' },
      dragActions: ['copy'],
      onDragEnd: (ev: { action: string | null; dropped: boolean }) => {
        ended = { action: ev.action, dropped: ev.dropped };
      },
      style: { width: 60, height: 30 },
    });

  await mount(
    view(
      source(),
      h(List, { name: 'l', items: ['a', 'b'], onDrop: (d) => drops.push(d) }),
    ),
  );
  await dragTo(screen.getByTestName('src'), item('l', 'b'), { dy: 10 });
  await release(item('l', 'b'), { dy: 10 });
  // `strictEqual` on the length rather than `deepStrictEqual(drops, [])`:
  // the latter narrows `drops` to `never[]` for the rest of the test
  assert.strictEqual(drops.length, 0);
  assert.deepStrictEqual(ended, { action: null, dropped: false });
  await cleanup();

  await mount(
    view(
      source(),
      h(List, {
        name: 'l',
        items: ['a', 'b'],
        accept: ['text'],
        onDrop: (d) => drops.push(d),
      }),
    ),
  );
  await dragTo(screen.getByTestName('src'), item('l', 'b'), { dy: 10 });
  assert.ok(screen.queryByTestName('l-b-indicator'), 'the slot is marked');
  await release(item('l', 'b'), { dy: 10 });
  assert.strictEqual(drops.length, 1);
  assert.strictEqual(drops[0]!.index, 2);
  assert.strictEqual(drops[0]!.event.text, 'hello');
  assert.deepStrictEqual(ended, { action: 'copy', dropped: true });
});

test('a disabled list takes nothing and lifts nothing', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        disabled: true,
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  assert.strictEqual(retained(item('l', 'a')).props.draggable, undefined);
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 10 });
  await release(item('l', 'c'), { dy: 10 });
  assert.deepStrictEqual(changes, []);
});

test("the preview follows the pointer at the item's size, and `preview={false}` leaves only the cursor", async () => {
  await mount(view(h(List, { name: 'l', items: ['a', 'b', 'c'] })));
  const a = item('l', 'a');
  await dragTo(a, item('l', 'c'), { dy: 10 });
  const preview = screen.getByTestName('l-a-preview');
  // the popup is the item's size, and shows the item's text again
  assert.strictEqual(retained(preview).props.width, ITEM.width);
  assert.strictEqual(retained(preview).props.height, ITEM.height);
  assert.strictEqual(screen.getAllByText('Item a').length, 2);
  await release(item('l', 'c'), { dy: 10 });
  assert.strictEqual(screen.getAllByText('Item a').length, 1);
  await cleanup();

  await mount(
    view(h(List, { name: 'l', items: ['a', 'b', 'c'], preview: false })),
  );
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 10 });
  assert.ok(screen.queryByTestName('l-a-preview') === null);
  assert.ok(
    screen.queryByTestName('l-c-indicator'),
    'the indicator still shows',
  );
  await release(item('l', 'c'), { dy: 10 });
});

test('styles: the item seam sees the state, the indicator takes a style', async () => {
  const seen: string[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b'],
        styles: {
          item: (state) => {
            if (state.edge) seen.push(`${state.id}:${state.edge}`);
            return state.dragging ? { borderWidth: 3 } : null;
          },
          indicator: { height: 6 },
        },
      }),
    ),
  );
  const b = item('l', 'b');
  await dragTo(item('l', 'a'), b, { dy: 10 });
  assert.deepStrictEqual(seen, ['b:after']);
  assert.strictEqual(screen.getByTestName('l-b-indicator').abs.height, 6);
  assert.strictEqual(retained(item('l', 'a')).style.borderWidth, 3);
  await release(b, { dy: 10 });
});

test('at scale 2 the slot is read in the same unit as the pointer', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        onReorder: (c) => changes.push(c),
      }),
    ),
    { scale: 2 },
  );
  const c = item('l', 'c');
  // `abs` is device: the item is 60 device pixels tall here
  assert.strictEqual(c.abs.height, ITEM.height * 2);
  // 20 device pixels below c's centre: its lower half, whichever unit the
  // list compares in — but a list that compared a logical pointer with a
  // device box would read the point as half as far down, still c's lower
  // half. So aim at the *gap* above c instead: 22 device pixels above c's
  // centre is 8 device pixels above its top, nearer c than b — slot 2 —
  // while the same numbers taken as logical would land inside b.
  await dragTo(item('l', 'a'), c, { dy: -22 }, { dx: 12 });
  assert.ok(screen.queryByTestName('l-c-indicator'), 'the slot before c');
  assert.ok(screen.queryByTestName('l-b-indicator') === null);
  await release(c, { dy: -22 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'a', 'c'], id: 'a', from: 0, to: 1 },
  ]);
});

test('arrayMove is what an app holding objects calls', () => {
  const todos = [{ t: 'a' }, { t: 'b' }, { t: 'c' }];
  assert.deepStrictEqual(
    arrayMove(todos, 0, 2).map((x) => x.t),
    ['b', 'c', 'a'],
  );
});

/** What a state reads as, in one word per field, for the assertions. */
function describe(state: ReorderItemState): string {
  return [
    state.dragging && 'dragging',
    state.lifted && 'lifted',
    state.accepted && 'accepted',
    state.preview && 'preview',
    state.edge && `edge:${state.edge}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** A component deeper inside an item, reading the state through the hook. */
function Status(): ReactElement {
  const state = useReorderItem();
  return h('text', null, `[${String(state.id)} ${describe(state)}]`);
}

test('function children and useReorderItem() see the drag as it happens', async () => {
  await mount(
    view(
      h(
        ReorderList,
        { 'data-testname': 'l', style: { gap: GAP, padding: 10 } },
        ['a', 'b', 'c'].map((id) =>
          h(ReorderItem, {
            key: id,
            id,
            'data-testname': `l-${id}`,
            style: ITEM,
            children: (state: ReorderItemState) => [
              h('text', { key: 'fn' }, `(${id} ${describe(state)})`),
              h(Status, { key: 'hook' }),
            ],
          }),
        ),
      ),
    ),
  );
  const at = () =>
    screen
      .getAllByRole('listitem')
      .map((n) => textOfItem(n))
      .join(' | ');
  assert.strictEqual(at(), '(a )[a ] | (b )[b ] | (c )[c ]');

  const c = item('l', 'c');
  await dragTo(item('l', 'a'), c, { dy: 10 });
  // the held item knows it is held and would be taken; the item at the
  // slot knows which edge; the ghost's copy knows it is the ghost
  assert.strictEqual(
    at(),
    '(a dragging accepted)[a dragging accepted] | (b )[b ] | (c edge:after)[c edge:after]',
  );
  const ghost = screen.getByTestName('l-a-preview');
  assert.match(
    textOfItem(ghost),
    /\(a dragging accepted preview\)\[a dragging accepted preview\]/,
  );

  // over something that would not take it: still held, no longer accepted
  await act(async () => {
    fireEvent.mouseMove(screen.getByTestName('outside'));
  });
  await landed();
  assert.strictEqual(at(), '(a dragging)[a dragging] | (b )[b ] | (c )[c ]');
  await release(screen.getByTestName('outside'));
  assert.strictEqual(at(), '(a )[a ] | (b )[b ] | (c )[c ]');

  // the keyboard's lift is a state too
  await userEvent.click(item('l', 'b'));
  await space();
  assert.strictEqual(at(), '(a )[a ] | (b lifted)[b lifted] | (c )[c ]');
  await space();
  assert.strictEqual(at(), '(a )[a ] | (b )[b ] | (c )[c ]');
});

test('the item seam and renderPreview see the ghost with `preview` set', async () => {
  const seen = new Set<string>();
  await mount(
    view(
      h(
        ReorderList,
        {
          'data-testname': 'l',
          style: { gap: GAP, padding: 10 },
          styles: {
            item: (state: ReorderItemState) => {
              if (state.dragging) seen.add(`item:${describe(state)}`);
              return null;
            },
          },
          renderPreview: (state: ReorderItemState) => {
            seen.add(`render:${describe(state)}`);
            return h('text', null, 'ghost');
          },
        },
        ['a', 'b'].map((id) =>
          h(
            ReorderItem,
            { key: id, id, 'data-testname': `l-${id}`, style: ITEM },
            h('text', null, `Item ${id}`),
          ),
        ),
      ),
    ),
  );
  await dragTo(item('l', 'a'), item('l', 'b'), { dy: 10 });
  assert.ok(seen.has('item:dragging accepted'), [...seen].join(', '));
  assert.ok(seen.has('render:dragging accepted preview'), [...seen].join(', '));
  assert.strictEqual(textOfItem(screen.getByTestName('l-a-preview')), 'ghost');
  await release(item('l', 'b'), { dy: 10 });
});
