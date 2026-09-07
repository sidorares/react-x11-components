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
  installA11ySpy,
  expectPixel,
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
  ReorderCombine,
  ReorderDrop,
  ReorderDropQuery,
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
  // `live` decides who owns the order: the harness applies every change
  // itself (the default), or the caller drives it through the prop.
  const [own, setOwn] = useState(items);
  const order = live ? own : items;
  return h(
    ReorderList,
    {
      'data-testname': name,
      onReorder: (change: ReorderChange) => {
        onReorder?.(change);
        if (live) setOwn(change.items);
      },
      // off by default here: a 180ms flight would otherwise overlap the
      // assertion after every release. `the drop flies home` turns it on.
      dropAnimation: false,
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
  press: PointerOptions = {},
): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(from, press);
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
    { items: ['b', 'c', 'a'], id: 'a', ids: ['a'], from: 0, to: 2 },
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
    { items: ['c', 'a', 'b'], id: 'c', ids: ['c'], from: 2, to: 0 },
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
    { items: ['b', 'c', 'a'], id: 'a', ids: ['a'], from: 0, to: 2 },
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
    { items: ['a', 'c', 'b'], id: 'c', ids: ['c'], from: 2, to: 1 },
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
    { items: ['b', 'c', 'a'], id: 'a', ids: ['a'], from: 0, to: 2 },
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
    { items: ['a', 'c', 'b'], id: 'b', ids: ['b'], from: 1, to: 2 },
  ]);
  assert.deepStrictEqual(orderOf('l'), ['a', 'c', 'b']);
  // the moved item is the same node, and it kept the focus
  assert.ok(item('l', 'b').focused);
  await userEvent.key(XK_UP);
  await userEvent.key(XK_UP);
  assert.deepStrictEqual(changes.at(-1), {
    items: ['b', 'a', 'c'],
    id: 'b',
    ids: ['b'],
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
    ids: ['a'],
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
    ids: ['a'],
    from: 0,
    to: 1,
  });
  await userEvent.key(XK_RIGHT);
  assert.deepStrictEqual(changes.at(-1), {
    items: ['a', 'b', 'c'],
    id: 'a',
    ids: ['a'],
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
            // what the seam sees, not how often — an item re-renders more
            // than once for one state, and that is not what this is about
            const at = `${String(state.id)}:${state.edge}`;
            if (state.edge && !seen.includes(at)) seen.push(at);
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
    { items: ['b', 'a', 'c'], id: 'a', ids: ['a'], from: 0, to: 1 },
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
        {
          'data-testname': 'l',
          dropAnimation: false,
          style: { gap: GAP, padding: 10 },
        },
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
          dropAnimation: false,
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

// --- the list's own view of the gesture (lifecycle) --------------------------

/** One list, three items, reporting every lifecycle event it is given. */
function lifecycle(
  log: string[],
  props: Partial<ReorderListProps> = {},
): ReactElement {
  return h(List, {
    name: 'l',
    id: 'todo',
    items: ['a', 'b', 'c'],
    onDragStart: (e) =>
      log.push(`start ${e.id} [${e.ids}] at ${e.index} by ${e.input}`),
    onDragUpdate: (e) =>
      log.push(
        `update ${e.id} over ${e.over ? `${e.over.list}:${e.over.index}` : 'nothing'}` +
          `${e.combine ? ` combine ${String(e.combine)}` : ''}`,
      ),
    onDragEnd: (e) =>
      log.push(
        `end ${e.id} ${e.reason} at ${e.to ? `${e.to.list}:${e.to.index}` : 'nowhere'}`,
      ),
    ...props,
  });
}

test('the list reports the gesture: start, an update per slot, end', async () => {
  const log: string[] = [];
  await mount(view(lifecycle(log)));

  await dragTo(item('l', 'a'), item('l', 'b'), { dy: 10 });
  // the index is where it would *land*, which is what onReorder will say —
  // past b, and the hole a left behind has closed
  assert.deepStrictEqual(log, [
    'start a [a] at 0 by pointer',
    'update a over todo:1',
  ]);

  // the same slot again says nothing more
  await act(async () => {
    fireEvent.mouseMove(item('l', 'b'), { dy: 12 });
  });
  await landed();
  assert.strictEqual(log.length, 2, log.join(' | '));

  // a new slot is a new update
  await act(async () => {
    fireEvent.mouseMove(item('l', 'c'), { dy: 10 });
  });
  await landed();
  assert.deepStrictEqual(log.at(-1), 'update a over todo:2');

  await release(item('l', 'c'), { dy: 10 });
  assert.deepStrictEqual(log.at(-1), 'end a drop at todo:2');
});

test('a drag that leaves the list reports nothing under it, then a cancel', async () => {
  const log: string[] = [];
  await mount(view(lifecycle(log)));
  // over a real slot first, so the update to "nothing" is a change rather
  // than the answer it started with
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 10 });
  assert.deepStrictEqual(log.at(-1), 'update a over todo:2');
  await act(async () => {
    fireEvent.mouseMove(screen.getByTestName('outside'));
  });
  await landed();
  assert.deepStrictEqual(log.at(-1), 'update a over nothing');
  await release(screen.getByTestName('outside'));
  assert.deepStrictEqual(log.at(-1), 'end a cancel at nowhere');
});

test('the keyboard reports the same three events', async () => {
  const log: string[] = [];
  await mount(view(lifecycle(log)));
  await userEvent.click(item('l', 'a'));
  await space();
  assert.deepStrictEqual(log, ['start a [a] at 0 by keyboard']);
  await userEvent.key(XK_DOWN);
  assert.deepStrictEqual(log.at(-1), 'update a over todo:1');
  await space();
  assert.deepStrictEqual(log.at(-1), 'end a drop at todo:1');

  // and Escape ends it as a cancel
  log.length = 0;
  await space();
  await userEvent.key(XK_DOWN);
  await userEvent.key(XK_ESCAPE);
  assert.deepStrictEqual(log.at(-1), 'end a cancel at nowhere');
});

// --- canDrop ----------------------------------------------------------------

test('canDrop refuses a position: no indicator, nothing lands, and the source knows', async () => {
  const inserts: ReorderInsert[] = [];
  const removes: ReorderRemove[] = [];
  const asked: string[] = [];
  await mount(
    view(
      h(
        ReorderList,
        {
          id: 'from',
          group: 'g',
          'data-testname': 'from',
          dropAnimation: false,
          onRemove: (e: ReorderRemove) => removes.push(e),
          style: { gap: GAP, padding: 10 },
        },
        h(ReorderItem, {
          id: 'a',
          'data-testname': 'from-a',
          style: ITEM,
          children: (s: ReorderItemState) =>
            h('text', null, `a ${describe(s)}`),
        }),
      ),
      h(
        ReorderList,
        {
          id: 'to',
          group: 'g',
          'data-testname': 'to',
          dropAnimation: false,
          canDrop: (q: ReorderDropQuery) => {
            asked.push(`${String(q.id)}@${q.index}`);
            return false;
          },
          onInsert: (e: ReorderInsert) => inserts.push(e),
          style: { gap: GAP, padding: 10 },
        },
        h(
          ReorderItem,
          { id: 'x', 'data-testname': 'to-x', style: ITEM },
          h('text', null, 'x'),
        ),
      ),
    ),
  );

  const target = screen.getByTestName('to-x');
  await dragTo(screen.getByTestName('from-a'), target, { dy: 10 });
  assert.ok(asked.length > 0, 'canDrop was asked');
  assert.ok(
    screen.queryByTestName('to-x-indicator') === null,
    'no slot promised',
  );
  // the refusal reaches the source: its ghost is not over anything that
  // would take it
  assert.match(
    textOfItem(screen.getByTestName('from-a')),
    /dragging(?! accepted)/,
  );

  await release(target, { dy: 10 });
  assert.strictEqual(inserts.length, 0);
  assert.strictEqual(removes.length, 0);
});

test('canDrop can refuse one slot and allow another', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        // nothing may land at the very end
        canDrop: (q: ReorderDropQuery) => q.index !== 3,
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 10 });
  assert.ok(screen.queryByTestName('l-c-indicator') === null);
  await release(item('l', 'c'), { dy: 10 });
  assert.strictEqual(changes.length, 0);

  // the gap before c is allowed
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: -10 });
  assert.ok(screen.queryByTestName('l-c-indicator'));
  await release(item('l', 'c'), { dy: -10 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'a', 'c'], id: 'a', ids: ['a'], from: 0, to: 1 },
  ]);
});

// --- copy from a palette ----------------------------------------------------

test('a palette copies: the item stays, and the list that took it says so', async () => {
  const inserts: ReorderInsert[] = [];
  const removes: ReorderRemove[] = [];
  await mount(
    view(
      h(
        ReorderList,
        {
          id: 'palette',
          group: 'g',
          'data-testname': 'p',
          dropAnimation: false,
          onRemove: (e: ReorderRemove) => removes.push(e),
          style: { gap: GAP, padding: 10 },
        },
        ['brush', 'pen'].map((id) =>
          h(
            ReorderItem,
            {
              key: id,
              id,
              dragActions: ['copy'] as Array<'copy' | 'move' | 'link'>,
              'data-testname': `p-${id}`,
              style: ITEM,
            },
            h('text', null, id),
          ),
        ),
      ),
      h(
        ReorderList,
        {
          id: 'canvas',
          group: 'g',
          'data-testname': 'c',
          dropAnimation: false,
          onInsert: (e: ReorderInsert) => inserts.push(e),
          style: { gap: GAP, padding: 10 },
        },
        h(
          ReorderItem,
          { id: 'here', 'data-testname': 'c-here', style: ITEM },
          h('text', null, 'here'),
        ),
      ),
    ),
  );

  const target = screen.getByTestName('c-here');
  await dragTo(screen.getByTestName('p-brush'), target, { dy: 10 });
  await release(target, { dy: 10 });

  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0]!.action, 'copy');
  assert.deepStrictEqual(inserts[0]!.items, ['here', 'brush']);
  // a copy leaves the palette alone: no removal, and the item is still there
  assert.strictEqual(removes.length, 0);
  assert.ok(screen.queryByTestName('p-brush'), 'the palette kept its item');
});

// --- combine ----------------------------------------------------------------

test('combine: the middle of an item merges into it, its ends still reorder', async () => {
  const combines: ReorderCombine[] = [];
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        combine: true,
        size: { width: 200, height: 40 },
        onCombine: (e: ReorderCombine) => combines.push(e),
        onReorder: (c) => changes.push(c),
      }),
    ),
  );

  // the dead centre of c: a merge, drawn as an outline rather than a line
  const c = item('l', 'c');
  await dragTo(item('l', 'a'), c, { dy: 0 });
  const outline = screen.getByTestName('l-c-indicator');
  assert.strictEqual(retained(outline).style.borderWidth, 2);
  assert.strictEqual(retained(outline).style.backgroundColor, undefined);
  await release(c, { dy: 0 });
  assert.strictEqual(changes.length, 0, 'a merge is not a reorder');
  assert.strictEqual(combines.length, 1);
  assert.deepStrictEqual(
    { id: combines[0]!.id, into: combines[0]!.into, index: combines[0]!.index },
    { id: 'a', into: 'c', index: 2 },
  );

  // 18px below c's centre is past the band: an ordinary edge, and a line
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 18 });
  const line = screen.getByTestName('l-c-indicator');
  assert.strictEqual(retained(line).style.borderWidth, undefined);
  await release(item('l', 'c'), { dy: 18 });
  assert.strictEqual(combines.length, 1, 'still one merge');
  assert.deepStrictEqual(changes, [
    { items: ['b', 'c', 'a'], id: 'a', ids: ['a'], from: 0, to: 2 },
  ]);
});

test('combine: an item cannot merge into itself', async () => {
  const combines: ReorderCombine[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b'],
        combine: true,
        size: { width: 200, height: 40 },
        onCombine: (e: ReorderCombine) => combines.push(e),
      }),
    ),
  );
  await dragTo(item('l', 'a'), item('l', 'a'), { dy: 0 });
  assert.ok(screen.queryByTestName('l-a-indicator') === null);
  await release(item('l', 'a'), { dy: 0 });
  assert.strictEqual(combines.length, 0);
});

// --- a press on a control inside an item ------------------------------------

/** A card with a button and a text field in it, so a press has somewhere to
 *  land that is not the card. */
function cards(
  props: Partial<ReorderListProps> = {},
  interactive = false,
): ReactElement {
  return h(
    ReorderList,
    {
      'data-testname': 'l',
      dropAnimation: false,
      style: { gap: GAP, padding: 10 },
      ...props,
    },
    ['a', 'b', 'c'].map((id) =>
      h(
        ReorderItem,
        {
          key: id,
          id,
          'data-testname': `l-${id}`,
          dragFromInteractive: interactive,
          style: { ...ITEM, flexDirection: 'row', gap: 6 },
        },
        h('text', { key: 't' }, `Item ${id}`),
        h('box', {
          key: 'b',
          role: 'button',
          focusable: true,
          'data-testname': `l-${id}-button`,
          style: { width: 40, height: 20 },
        }),
        h('textinput', {
          key: 'i',
          'data-testname': `l-${id}-field`,
          style: { width: 60 },
        }),
      ),
    ),
  );
}

test('a press on a button or a field inside an item does not drag it', async () => {
  const changes: ReorderChange[] = [];
  await mount(view(cards({ onReorder: (c) => changes.push(c) })));

  // from the button
  await dragTo(screen.getByTestName('l-a-button'), item('l', 'c'), { dy: 10 });
  assert.ok(
    screen.queryByTestName('l-a-preview') === null,
    'no ghost: the press belonged to the button',
  );
  assert.ok(screen.getByTestName('l-a-button').focused, 'the button got it');
  await release(item('l', 'c'), { dy: 10 });
  assert.strictEqual(changes.length, 0);

  // from the text field
  await dragTo(screen.getByTestName('l-a-field'), item('l', 'c'), { dy: 10 });
  assert.ok(screen.queryByTestName('l-a-preview') === null);
  await release(item('l', 'c'), { dy: 10 });
  assert.strictEqual(changes.length, 0);

  // and from the card itself — pressed on its label, since the card's own
  // centre lands on the button in the middle of it
  await dragTo(
    item('l', 'a'),
    item('l', 'c'),
    { dy: 10 },
    { dx: 6 },
    { dx: -90 },
  );
  assert.ok(screen.queryByTestName('l-a-preview'), 'the card itself drags');
  await release(item('l', 'c'), { dy: 10 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'c', 'a'], id: 'a', ids: ['a'], from: 0, to: 2 },
  ]);
});

test('dragFromInteractive gives the press back to the item', async () => {
  const changes: ReorderChange[] = [];
  await mount(view(cards({ onReorder: (c) => changes.push(c) }, true)));
  await dragTo(screen.getByTestName('l-a-button'), item('l', 'c'), { dy: 10 });
  assert.ok(screen.queryByTestName('l-a-preview'), 'the button drags the card');
  await release(item('l', 'c'), { dy: 10 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'c', 'a'], id: 'a', ids: ['a'], from: 0, to: 2 },
  ]);
});

// --- multi-drag -------------------------------------------------------------

test('a selection travels together, and the ghost counts it', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c', 'd'],
        selected: ['a', 'c'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  const d = item('l', 'd');
  await dragTo(item('l', 'a'), d, { dy: 10 });
  assert.strictEqual(textOfItem(screen.getByTestName('l-a-count')), '2');
  await release(d, { dy: 10 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'd', 'a', 'c'], id: 'a', ids: ['a', 'c'], from: 0, to: 2 },
  ]);
});

test('dragging an item outside the selection carries only that item', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        selected: ['a', 'c'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  await dragTo(item('l', 'b'), item('l', 'c'), { dy: 10 });
  assert.ok(screen.queryByTestName('l-b-count') === null, 'no badge for one');
  await release(item('l', 'c'), { dy: 10 });
  assert.deepStrictEqual(changes, [
    { items: ['a', 'c', 'b'], id: 'b', ids: ['b'], from: 1, to: 2 },
  ]);
});

test('a selection moves between lists as one run', async () => {
  const inserts: ReorderInsert[] = [];
  const removes: ReorderRemove[] = [];
  await mount(
    view(
      h(List, {
        name: 'p',
        id: 'p',
        group: 'g',
        items: ['a', 'b', 'c'],
        selected: ['a', 'c'],
        onRemove: (e) => removes.push(e),
      }),
      h(List, {
        name: 'q',
        id: 'q',
        group: 'g',
        items: ['x'],
        onInsert: (e) => inserts.push(e),
      }),
    ),
  );
  const x = item('q', 'x');
  await dragTo(item('p', 'a'), x, { dy: -10 });
  await release(x, { dy: -10 });
  assert.strictEqual(inserts.length, 1);
  assert.deepStrictEqual(inserts[0]!.items, ['a', 'c', 'x']);
  assert.deepStrictEqual(inserts[0]!.ids, ['a', 'c']);
  assert.strictEqual(removes.length, 1);
  assert.deepStrictEqual(removes[0]!.items, ['b']);
  assert.deepStrictEqual(removes[0]!.ids, ['a', 'c']);
});

test('the keyboard moves the whole selection too', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c', 'd'],
        selected: ['a', 'b'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  await userEvent.click(item('l', 'a'));
  await space();
  await userEvent.key(XK_DOWN);
  assert.deepStrictEqual(changes, [
    { items: ['c', 'a', 'b', 'd'], id: 'a', ids: ['a', 'b'], from: 0, to: 1 },
  ]);
});

// --- the ghost's size, and what a pointer drag says -------------------------

test('previewSize sizes the ghost, whatever the item is', async () => {
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b'],
        previewSize: { width: 64, height: 24 },
      }),
    ),
  );
  await dragTo(item('l', 'a'), item('l', 'b'), { dy: 10 });
  const ghost = retained(screen.getByTestName('l-a-preview'));
  assert.strictEqual(ghost.props.width, 64);
  assert.strictEqual(ghost.props.height, 24);
  await release(item('l', 'b'), { dy: 10 });
});

test('a pointer drag is announced, not only a keyboard one', async () => {
  const spy = installA11ySpy();
  await mount(view(h(List, { name: 'l', items: ['a', 'b', 'c'] })));
  const said = () =>
    spy
      .events()
      .filter((e) => e.type === 'announce')
      .map((e) => e.text ?? '');

  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 10 });
  assert.match(said().join(' | '), /Dragging Item a, position 1 of 3/);
  await release(item('l', 'c'), { dy: 10 });
  assert.match(said().at(-1) ?? '', /Item a dropped at position 3 of 3/);

  // and a drag that ended nowhere says so
  spy.clear();
  await dragTo(item('l', 'a'), screen.getByTestName('outside'));
  await release(screen.getByTestName('outside'));
  assert.match(said().at(-1) ?? '', /returned to where it was/);
});

// --- the drop animation -----------------------------------------------------

test('the drop flies home, takes no input on the way, and then is gone', async () => {
  const MS = 80;
  await mount(
    view(h(List, { name: 'l', items: ['a', 'b', 'c'], dropAnimation: MS })),
  );
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 10 });
  await release(item('l', 'c'), { dy: 10 });

  const flight = screen.getByTestName('l-a-flight');
  assert.ok(flight, 'a copy flies to where the item landed');
  // it is a box in the list, not a window over it: the press that follows a
  // drop must reach the list
  assert.strictEqual(retained(flight).kind, 'box');
  assert.strictEqual(retained(flight).style.pointerEvents, 'none');
  assert.ok(
    screen.queryByTestName('l-a-preview') === null,
    'the ghost is gone',
  );

  // **Plain time, then one `act()`** — not `waitFor`. The flight is a chain
  // of real timers, and `waitFor` spends its wait *inside* `act()`, which
  // round-trips the X connection: on a slow enough runner that occupies the
  // loop for longer than the animation, the timers never run, and the test
  // waits for a flight that its own waiting has frozen mid-air. (CI's Node
  // 20 leg: one `act()` took 28 seconds, and the test hung for 53 minutes.
  // Node 22 and 24 never showed it.) Sleeping *outside* `act()` lets the
  // animation run, and one `act()` after it commits the state it ended on.
  await new Promise((resolve) => setTimeout(resolve, MS * 3));
  await act();
  assert.ok(
    screen.queryByTestName('l-a-flight') === null,
    'the copy is gone once it has landed',
  );
});

test('no flight when the desktop asks for reduced motion, or the app does', async () => {
  await mount(
    view(h(List, { name: 'l', items: ['a', 'b', 'c'], dropAnimation: false })),
  );
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 10 });
  await release(item('l', 'c'), { dy: 10 });
  assert.ok(screen.queryByTestName('l-a-flight') === null);
});

// --- the cases the first cut never exercised --------------------------------

test('a scrolling list reads the slot off where the rows actually are', async () => {
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c', 'd', 'e', 'f'],
        onReorder: (c) => changes.push(c),
        // a viewport two rows tall over six rows
        style: { gap: GAP, padding: 10, height: 90, overflow: 'scroll' },
      }),
    ),
  );
  const pane = screen.getByRole('list') as DrawnNode & {
    scrollTo(to: { y: number }): void;
    readonly scrollY: number;
  };
  await act(async () => {
    // past the end: the pane clamps to its own content, which is the
    // bottom of the list whatever the rows measured
    pane.scrollTo({ y: 1000 });
  });
  await landed();
  assert.ok(pane.scrollY > 0, `the pane did not scroll: ${pane.scrollY}`);

  // Every row moved up by the scroll. A slot read off where the rows *were*
  // would name a different item for the same point — and every point in
  // this test is inside the viewport, so the pointer really is over the
  // item the assertion names.
  const onScreen = (node: DrawnNode): boolean =>
    node.abs.y >= pane.abs.y &&
    node.abs.y + node.abs.height <= pane.abs.y + pane.abs.height;
  const e = item('l', 'e');
  assert.ok(onScreen(e), `e is on screen after the scroll: ${e.abs.y}`);
  assert.ok(onScreen(item('l', 'f')), 'and so is f');
  await dragTo(item('l', 'f'), e, { dy: -10 });
  assert.ok(screen.queryByTestName('l-e-indicator'), 'the slot before e');
  await release(e, { dy: -10 });
  assert.deepStrictEqual(changes, [
    {
      items: ['a', 'b', 'c', 'd', 'f', 'e'],
      id: 'f',
      ids: ['f'],
      from: 5,
      to: 4,
    },
  ]);
});

test('a list nested inside another list item keeps its items to itself', async () => {
  const outer: ReorderChange[] = [];
  const inner: ReorderChange[] = [];
  await mount(
    view(
      h(
        ReorderList,
        {
          'data-testname': 'outer',
          dropAnimation: false,
          onReorder: (c: ReorderChange) => outer.push(c),
          style: { gap: GAP, padding: 10 },
        },
        h(
          ReorderItem,
          {
            id: 'group-1',
            'data-testname': 'outer-group-1',
            style: { width: 220 },
          },
          h('text', null, 'Group one'),
          h(
            ReorderList,
            {
              'data-testname': 'inner',
              dropAnimation: false,
              onReorder: (c: ReorderChange) => inner.push(c),
              style: { gap: GAP, padding: 6 },
            },
            ['x', 'y'].map((id) =>
              h(
                ReorderItem,
                { key: id, id, 'data-testname': `inner-${id}`, style: ITEM },
                h('text', null, id),
              ),
            ),
          ),
        ),
        h(
          ReorderItem,
          {
            id: 'group-2',
            'data-testname': 'outer-group-2',
            style: { width: 220, height: 40 },
          },
          h('text', null, 'Group two'),
        ),
      ),
    ),
  );

  // the inner list's own item, dropped inside it: the inner list reorders
  // and the outer one hears nothing, even though the drag was over both
  const y = screen.getByTestName('inner-y');
  await dragTo(screen.getByTestName('inner-x'), y, { dy: 10 });
  await release(y, { dy: 10 });
  assert.deepStrictEqual(inner, [
    { items: ['y', 'x'], id: 'x', ids: ['x'], from: 0, to: 1 },
  ]);
  assert.deepStrictEqual(outer, []);
});

test('a board can reorder its columns as well as the cards in them', async () => {
  const columns: ReorderChange[] = [];
  const cardsMoved: ReorderChange[] = [];
  await mount(
    view(
      h(
        ReorderList,
        {
          'data-testname': 'board',
          orientation: 'horizontal' as const,
          dropAnimation: false,
          onReorder: (c: ReorderChange) => columns.push(c),
          style: { gap: 12, padding: 10 },
        },
        ['todo', 'done'].map((column) =>
          h(
            ReorderItem,
            {
              key: column,
              id: column,
              'data-testname': `col-${column}`,
              style: { width: 150 },
            },
            h(ReorderHandle, { 'data-testname': `col-${column}-grip` }),
            h(
              ReorderList,
              {
                id: column,
                group: 'cards',
                'data-testname': `list-${column}`,
                dropAnimation: false,
                onReorder: (c: ReorderChange) => cardsMoved.push(c),
                style: { gap: GAP, minHeight: 60 },
              },
              [`${column}-1`, `${column}-2`].map((card) =>
                h(
                  ReorderItem,
                  {
                    key: card,
                    id: card,
                    'data-testname': `card-${card}`,
                    style: { width: 130, height: 26 },
                  },
                  h('text', null, card),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  // a card, inside its column
  const second = screen.getByTestName('card-todo-2');
  await dragTo(screen.getByTestName('card-todo-1'), second, { dy: 8 });
  await release(second, { dy: 8 });
  assert.deepStrictEqual(cardsMoved, [
    {
      items: ['todo-2', 'todo-1'],
      id: 'todo-1',
      ids: ['todo-1'],
      from: 0,
      to: 1,
    },
  ]);
  assert.deepStrictEqual(columns, [], 'the board did not move');

  // and the column itself, by its grip
  const done = screen.getByTestName('col-done');
  await dragTo(screen.getByTestName('col-todo-grip'), done, { dx: 40 });
  await release(done, { dx: 40 });
  assert.deepStrictEqual(columns, [
    {
      items: ['done', 'todo'],
      id: 'todo',
      ids: ['todo'],
      from: 0,
      to: 1,
    },
  ]);
  assert.strictEqual(cardsMoved.length, 1, 'no card moved with it');
});

test('a drop into an empty list lands at nothing, index 0', async () => {
  const inserts: ReorderInsert[] = [];
  await mount(
    view(
      h(List, { name: 'p', id: 'p', group: 'g', items: ['a'] }),
      h(List, {
        name: 'q',
        id: 'q',
        group: 'g',
        items: [],
        onInsert: (e) => inserts.push(e),
        style: { gap: GAP, padding: 10, width: 160, height: 120 },
      }),
    ),
  );
  const empty = screen.getByTestName('q');
  await dragTo(item('p', 'a'), empty);
  await release(empty);
  assert.strictEqual(inserts.length, 1);
  assert.deepStrictEqual(inserts[0]!.items, ['a']);
  assert.strictEqual(inserts[0]!.index, 0);
});

test('items added and removed mid-drag are the ones the drop lands among', async () => {
  const changes: ReorderChange[] = [];
  // The change has to come from outside the gesture: a live drag owns the
  // pointer, so a click on a button in the same window never arrives. This
  // is the shape of a list whose data updated while a hand was on it.
  let grow: (() => void) | null = null;
  function Growing(): ReactElement {
    const [items, setItems] = useState(['a', 'b']);
    grow = () => setItems((list) => [...list, 'c', 'd']);
    return h(List, {
      name: 'l',
      items,
      live: false,
      onReorder: (c: ReorderChange) => changes.push(c),
    });
  }
  await mount(view(h(Growing)));
  await dragTo(item('l', 'a'), item('l', 'b'), { dy: 10 });

  // two more items arrive while the pointer is down
  await act(async () => {
    grow?.();
  });
  await landed();
  assert.deepStrictEqual(orderOf('l'), ['a', 'b', 'c', 'd']);

  // the drop reads the list as it is now
  await act(async () => {
    fireEvent.mouseMove(item('l', 'd'), { dy: 10 });
  });
  await landed();
  await release(item('l', 'd'), { dy: 10 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'c', 'd', 'a'], id: 'a', ids: ['a'], from: 0, to: 3 },
  ]);
});

test('a few hundred items still answer one gesture', async () => {
  const changes: ReorderChange[] = [];
  const many = Array.from({ length: 300 }, (_, i) => `i${i}`);
  await mount(
    view(
      h(List, {
        name: 'l',
        items: many,
        onReorder: (c) => changes.push(c),
        size: { width: 160, height: 12 },
        style: { gap: 0, padding: 4, height: 200, overflow: 'scroll' },
      }),
    ),
  );
  assert.strictEqual(orderOf('l').length, 300);
  const started = Date.now();
  await dragTo(item('l', 'i0'), item('l', 'i5'), { dy: 4 });
  await release(item('l', 'i5'), { dy: 4 });
  assert.deepStrictEqual(changes.at(-1)?.to, 5);
  // a rectangle per item per motion, and nothing else: this is a smoke test
  // for an accidental O(n²), not a benchmark
  assert.ok(Date.now() - started < 4000, `${Date.now() - started}ms`);
});

test('the whole surface still answers at scale 2: combine, multi and the flight', async () => {
  const combines: ReorderCombine[] = [];
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        combine: true,
        selected: ['a', 'b'],
        size: { width: 160, height: 40 },
        onCombine: (e: ReorderCombine) => combines.push(e),
        onReorder: (c) => changes.push(c),
      }),
    ),
    { scale: 2 },
  );
  // the dead centre of c, in device pixels — a merge
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 0 });
  assert.ok(screen.queryByTestName('l-c-indicator'), 'the outline is drawn');
  await release(item('l', 'c'), { dy: 0 });
  assert.strictEqual(combines.length, 1);
  assert.strictEqual(combines[0]!.into, 'c');
  assert.deepStrictEqual(combines[0]!.ids, ['a', 'b']);
  assert.strictEqual(changes.length, 0);
});

// --- where the ghost is drawn ------------------------------------------------

test('preview="inline" draws the ghost in the list, following the pointer', async () => {
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        preview: 'inline' as const,
        dropAnimation: false,
      }),
    ),
  );
  const a = item('l', 'a');
  await dragTo(a, item('l', 'c'), { dy: 10 });

  const ghost = screen.getByTestName('l-a-preview');
  // a box inside the item, not a window over it
  assert.strictEqual(retained(ghost).kind, 'box');
  assert.strictEqual(retained(ghost).style.pointerEvents, 'none');
  assert.ok(a.contains(ghost), 'it is drawn inside the item');
  // and it is where the pointer is, not where the item is
  const far = ghost.abs.y;
  assert.ok(far > a.abs.y, `the ghost is down at the pointer: ${far}`);

  // it follows: half way back up, it moves with the pointer
  await act(async () => {
    fireEvent.mouseMove(item('l', 'b'), { dy: 0 });
  });
  await landed();
  const near = screen.getByTestName('l-a-preview').abs.y;
  assert.ok(near < far, `the ghost followed the pointer: ${near} < ${far}`);

  await release(item('l', 'b'), { dy: 0 });
  assert.ok(screen.queryByTestName('l-a-preview') === null);
});

test('preview="auto" is a popup, and a transparent one', async () => {
  await mount(view(h(List, { name: 'l', items: ['a', 'b'] })));
  await dragTo(item('l', 'a'), item('l', 'b'), { dy: 10 });
  const ghost = retained(screen.getByTestName('l-a-preview'));
  // a `<popup>` is a window node placed in screen coordinates — written
  // inside the item's element tree, but a window of its own, which is what
  // lets it leave the list and draw over other applications
  assert.strictEqual(ghost.kind, 'window');
  assert.strictEqual(typeof ghost.props.x, 'number');
  assert.strictEqual(ghost.style.position, undefined);
  // and transparent, because the card inside it is rounded: an opaque
  // window shows its own ground in the corners the radius gives up
  assert.strictEqual(ghost.props.transparent, true);
  await release(item('l', 'b'), { dy: 10 });
});

test('an inline ghost paints over the items it passes', async () => {
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        preview: 'inline' as const,
        dropAnimation: false,
      }),
    ),
  );
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 10 });
  // the item carrying the ghost is lifted above its neighbours, or the copy
  // slides under the next row down
  assert.strictEqual(retained(item('l', 'a')).style.zIndex, 3);
  assert.strictEqual(retained(item('l', 'b')).style.zIndex, undefined);
  await release(item('l', 'c'), { dy: 10 });
  assert.strictEqual(retained(item('l', 'a')).style.zIndex, undefined);
});

test('preview={false} draws no ghost either way', async () => {
  await mount(
    view(h(List, { name: 'l', items: ['a', 'b'], preview: false as const })),
  );
  await dragTo(item('l', 'a'), item('l', 'b'), { dy: 10 });
  assert.ok(screen.queryByTestName('l-a-preview') === null);
  assert.ok(screen.queryByTestName('l-b-indicator'), 'the indicator remains');
  await release(item('l', 'b'), { dy: 10 });
});

test('an inline ghost paints over the list it is being dragged into', async () => {
  // The bug this pins: `zIndex` sorts a node among its *siblings*, so a
  // ghost lifted inside its own item still paints under a different list —
  // which is exactly a palette dropping into a target. Asserted in pixels,
  // because paint order is the whole question.
  const GHOST = '#ff0000';
  const TARGET = '#0000ff';
  const { ctx } = await mount(
    h(
      'window',
      { width: 300, height: 300 } as Record<string, unknown>,
      h(
        ThemeProvider,
        { value: {}, colorScheme: 'light' },
        h(
          'box',
          { style: { gap: 0 } },
          // the palette, written first, so the target below paints over it
          // unless the list comes forward for the gesture
          h(
            ReorderList,
            {
              'data-testname': 'p',
              preview: 'inline' as const,
              dropAnimation: false,
              styles: { preview: { backgroundColor: GHOST } },
              style: { padding: 0 },
            },
            h(ReorderItem, {
              id: 'tag',
              'data-testname': 'p-tag',
              style: { width: 200, height: 30 },
            }),
          ),
          h(
            ReorderList,
            {
              'data-testname': 'q',
              dropAnimation: false,
              style: { padding: 0 },
            },
            h(ReorderItem, {
              id: 'note',
              'data-testname': 'q-note',
              style: { width: 200, height: 60, backgroundColor: TARGET },
            }),
          ),
        ),
      ),
    ),
  );

  const note = screen.getByTestName('q-note');
  const px = note.abs.x + 100;
  const py = note.abs.y + 30;
  // the note is painted where we think it is
  await expectPixel(ctx as never, px, py, TARGET);

  await dragTo(screen.getByTestName('p-tag'), note, { dy: 0 });
  // the ghost follows the pointer, which is over the note: it must be the
  // thing on top there
  await expectPixel(ctx as never, px, py, GHOST);
  await release(note, { dy: 0 });
});

test('one gap is one insertion point, wherever in it the pointer is', async () => {
  // The bug this pins: the slot was read off the nearest item, so the lower
  // half of item b and the upper half of item c — the same gap, the same
  // resulting order — drew the line on two different items and flipped
  // between them as the pointer crossed.
  const changes: ReorderChange[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c', 'd'],
        onReorder: (c) => changes.push(c),
      }),
    ),
  );
  const b = item('l', 'b');
  const c = item('l', 'c');
  const marked = (): string[] =>
    ['a', 'b', 'c', 'd'].filter(
      (id) => screen.queryByTestName(`l-${id}-indicator`) !== null,
    );

  // just inside b's lower half, and just inside c's upper half: one gap
  await dragTo(item('l', 'a'), b, { dy: 12 });
  const atB = marked();
  assert.deepStrictEqual(atB.length, 1, `one mark, got ${atB.join()}`);

  await act(async () => {
    fireEvent.mouseMove(c, { dy: -12 });
  });
  await landed();
  assert.deepStrictEqual(
    marked(),
    atB,
    'the same mark, either side of the gap',
  );

  // and it is the same drop either way
  await release(c, { dy: -12 });
  assert.deepStrictEqual(changes, [
    { items: ['b', 'a', 'c', 'd'], id: 'a', ids: ['a'], from: 0, to: 1 },
  ]);
});

test('every gap still gets its own mark', async () => {
  await mount(view(h(List, { name: 'l', items: ['a', 'b', 'c'] })));
  const marks: string[] = [];
  const seen = (where: DrawnNode, at: PointerOptions) => {
    marks.push(
      ['a', 'b', 'c']
        .filter((id) => screen.queryByTestName(`l-${id}-indicator`) !== null)
        .map((id) => {
          const n = screen.getByTestName(`l-${id}-indicator`);
          return `${id}:${n.abs.y < item('l', id).abs.y + 2 ? 'before' : 'after'}`;
        })
        .join(),
    );
    void where;
    void at;
  };
  // drag c and walk it up: the gap above b, then the gap above a
  await dragTo(item('l', 'c'), item('l', 'b'), { dy: -10 });
  seen(item('l', 'b'), {});
  await act(async () => {
    fireEvent.mouseMove(item('l', 'a'), { dy: -10 });
  });
  await landed();
  seen(item('l', 'a'), {});
  assert.strictEqual(marks.length, 2);
  assert.notStrictEqual(marks[0], marks[1], `two gaps, two marks: ${marks}`);
  await release(item('l', 'a'), { dy: -10 });
});

test('the insertion line sits in the middle of the gap, not against an item', async () => {
  const GAP = 12;
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        style: { gap: GAP, padding: 10 },
      }),
    ),
  );
  // the gap between b and c, marked from either side of its middle
  const b = item('l', 'b');
  const c = item('l', 'c');
  await dragTo(item('l', 'a'), c, { dy: -12 });
  const line = screen.getByTestName('l-c-indicator');
  const middle = (b.abs.y + b.abs.height + c.abs.y) / 2;
  const drawn = line.abs.y + line.abs.height / 2;
  assert.ok(
    Math.abs(drawn - middle) <= 1,
    `the line is centred in the gap: ${drawn} vs ${middle}`,
  );
  // and it is not where it used to be — hard against c's edge
  assert.ok(Math.abs(drawn - c.abs.y) > 2, 'not against the item below it');
  await release(c, { dy: -12 });
});

test('at the ends the line stays on the edge, where there is no gap', async () => {
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        style: { gap: 12, padding: 10 },
      }),
    ),
  );
  // above the first item: nothing precedes it, so the line is its own edge
  const a = item('l', 'a');
  await dragTo(item('l', 'c'), a, { dy: -12 });
  const top = screen.getByTestName('l-a-indicator');
  assert.ok(
    Math.abs(top.abs.y + top.abs.height / 2 - a.abs.y) <= 1,
    "centred on the first item's leading edge",
  );
  await release(a, { dy: -12 });
  // that drop reordered the list, so start the second half from a fresh one
  await cleanup();
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        style: { gap: 12, padding: 10 },
      }),
    ),
  );

  // and past the last item, likewise
  const c = item('l', 'c');
  await dragTo(item('l', 'a'), c, { dy: 12 });
  const bottom = screen.getByTestName('l-c-indicator');
  assert.ok(
    Math.abs(bottom.abs.y + bottom.abs.height / 2 - (c.abs.y + c.abs.height)) <=
      1,
    "centred on the last item's trailing edge",
  );
  await release(c, { dy: 12 });
});

test('a board lifts the whole path: the card, its column and the board', async () => {
  // The bug this pins: `zIndex` sorts among siblings, so a ghost inside a
  // card in the first column painted under the second and third columns —
  // the card was lifted, and nothing above it was.
  const GHOST = '#ff0000';
  const COLUMN = '#0000ff';
  const { ctx } = await mount(
    h(
      'window',
      { width: 420, height: 240 } as Record<string, unknown>,
      h(
        ThemeProvider,
        { value: {}, colorScheme: 'light' },
        h(
          ReorderList,
          {
            'data-testname': 'board',
            orientation: 'horizontal' as const,
            dropAnimation: false,
            style: { gap: 0, padding: 0 },
          },
          ['one', 'two'].map((column) =>
            h(
              ReorderItem,
              {
                key: column,
                id: column,
                'data-testname': `col-${column}`,
                style: { width: 200, height: 200, backgroundColor: COLUMN },
              },
              h(
                ReorderList,
                {
                  id: column,
                  group: 'cards',
                  'data-testname': `list-${column}`,
                  preview: 'inline' as const,
                  dropAnimation: false,
                  styles: { preview: { backgroundColor: GHOST } },
                  style: { gap: 0, padding: 0 },
                },
                h(ReorderItem, {
                  id: `${column}-card`,
                  'data-testname': `card-${column}`,
                  style: { width: 180, height: 40 },
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  const second = screen.getByTestName('col-two');
  const px = second.abs.x + 60;
  const py = second.abs.y + 30;
  await expectPixel(ctx as never, px, py, COLUMN);

  // drag the first column's card over the second column
  await dragTo(screen.getByTestName('card-one'), second, { dx: -40, dy: -60 });
  // only the card is being dragged: an ancestor item must not claim the
  // gesture, or draw a ghost of a whole column
  assert.strictEqual(
    screen.queryAllByTestName('col-one-preview').length,
    0,
    'the column did not start a drag of its own',
  );
  assert.strictEqual(screen.queryAllByTestName('card-one-preview').length, 1);
  await expectPixel(ctx as never, px, py, GHOST);
  await release(second, { dx: -40, dy: -60 });
});

test('the ghost is the item: same corners, same ground, same width', async () => {
  // The bug this pins: the default ghost drew a card of its own over the
  // item's style — the theme's radius, a surface, and a hairline border. A
  // chip lost its rounded corners, and the border ate two pixels of content
  // box, which is enough to wrap a word.
  const CHIP = {
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 3,
    paddingBottom: 3,
    borderRadius: 10,
    backgroundColor: '#336699',
  } as const;
  await mount(
    view(
      h(
        ReorderList,
        {
          'data-testname': 'l',
          orientation: 'horizontal' as const,
          dropAnimation: false,
          style: { gap: 6, padding: 8 },
        },
        ['later', 'urgent'].map((id) =>
          h(
            ReorderItem,
            { key: id, id, 'data-testname': `l-${id}`, style: CHIP },
            h('text', { style: { fontSize: 11 } }, id),
          ),
        ),
      ),
    ),
  );

  const chip = item('l', 'later');
  const width = chip.abs.width;
  const label = screen.getAllByText('later')[0]!;
  const lines = label.abs.height;

  await dragTo(chip, item('l', 'urgent'), { dx: 20 });
  const ghost = retained(screen.getByTestName('l-later-preview'));
  // the popup is at least the item's size, never rounded under it
  assert.ok(
    Number(ghost.props.width) >= Math.floor(width),
    `ghost ${String(ghost.props.width)} >= item ${width}`,
  );
  // the body inside it keeps the chip's own look
  const body = ghost.children[0]!;
  assert.strictEqual(retained(body).style.borderRadius, 10);
  assert.strictEqual(retained(body).style.backgroundColor, '#336699');
  assert.strictEqual(
    retained(body).style.borderWidth,
    undefined,
    'no border of its own to eat the content box',
  );
  // and the label inside the ghost is on one line, as it is at rest
  const copies = screen.getAllByText('later');
  assert.strictEqual(copies.length, 2, 'the item and its ghost');
  assert.strictEqual(
    copies[1]!.abs.height,
    lines,
    'the label did not wrap in the ghost',
  );
  await release(item('l', 'urgent'), { dx: 20 });
});

test('a drop that did something does not fly home; one that did not, does', async () => {
  // The bug this pins: the flight ends at where the item *is*, so a merge —
  // which leaves the item where it started — animated it back to the source
  // and read as a rejection, though the drop had been taken.
  const MS = 60;
  const combines: ReorderCombine[] = [];
  await mount(
    view(
      h(List, {
        name: 'l',
        items: ['a', 'b', 'c'],
        combine: true,
        dropAnimation: MS,
        size: { width: 200, height: 40 },
        onCombine: (e: ReorderCombine) => combines.push(e),
      }),
    ),
  );

  // a merge: taken, and the item stays where it was
  await dragTo(item('l', 'a'), item('l', 'c'), { dy: 0 });
  await release(item('l', 'c'), { dy: 0 });
  assert.strictEqual(combines.length, 1, 'the merge happened');
  assert.ok(
    screen.queryByTestName('l-a-flight') === null,
    'no flight home after a drop that was taken',
  );

  // released over nothing: it really did return, and says so
  await dragTo(item('l', 'a'), screen.getByTestName('outside'));
  await release(screen.getByTestName('outside'));
  assert.ok(
    screen.queryByTestName('l-a-flight'),
    'a drag that landed nowhere flies back',
  );
  await new Promise((resolve) => setTimeout(resolve, MS * 3));
  await act();
  assert.ok(screen.queryByTestName('l-a-flight') === null);
});

test('a copy taken by another list does not fly home either', async () => {
  const MS = 60;
  const inserts: ReorderInsert[] = [];
  await mount(
    view(
      h(
        ReorderList,
        {
          id: 'palette',
          group: 'g',
          'data-testname': 'p',
          dropAnimation: MS,
          style: { gap: GAP, padding: 10 },
        },
        h(ReorderItem, {
          id: 'tag',
          dragActions: ['copy'] as Array<'copy' | 'move' | 'link'>,
          'data-testname': 'p-tag',
          style: ITEM,
        }),
      ),
      h(List, {
        name: 'q',
        id: 'q',
        group: 'g',
        items: ['x'],
        onInsert: (e) => inserts.push(e),
      }),
    ),
  );
  const x = item('q', 'x');
  await dragTo(screen.getByTestName('p-tag'), x, { dy: 10 });
  await release(x, { dy: 10 });
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0]!.action, 'copy');
  assert.ok(
    screen.queryByTestName('p-tag-flight') === null,
    'the copy was taken: the ghost does not crawl back to the palette',
  );
});
