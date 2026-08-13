// <Tree> — the successor to react-x11's own, which is being retired.
//
// The row model is tested directly and hardest. Every subtle tree bug lives
// there rather than in the painting: a branch that is open but not loaded, a
// guide column that follows the wrong ancestor, a nested regrouping that
// disagrees with the flat pass about depth. None of that needs a display.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, screen, userEvent } from 'react-x11/test';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';
import type { Node as RetainedNode } from 'react-x11/node';
import type { DrawnNode, ScrollableNode } from 'react-x11';

import { Tree, branchEdges, visibleRows } from '../src/index.js';
import type {
  TreeExpandChange,
  TreeHandle,
  TreeItem,
  TreeItemId,
  TreeRow,
  TreeSubtreeState,
} from '../src/index.js';
import { resolveAccessors } from '../src/tree/rows.js';
import { groupRows, isGroup } from '../src/tree/rows.js';

const h = React.createElement;

afterEach(cleanup);

/** The queries hand back the retained node; their public type describes the
 *  narrower ref-facing view. Same widening as `sparkline.test.ts`. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

/** The tree's own box, as the scrolling half of a `<box>` ref. */
function scrolling(node: unknown): ScrollableNode {
  return node as ScrollableNode;
}

/** Every row on screen, in draw order. */
function rowNodes(): DrawnNode[] {
  return screen.all((n) => retained(n).props.role === 'treeitem');
}

/** What the rows on screen say, as `depth:label`. */
function shown(): string[] {
  return rowNodes().map((node) => {
    const props = retained(node).props;
    return `${(props['aria-level'] as number) - 1}:${textIn(node)}`;
  });
}

/** The first `<text>` under a node. `screen.getByText` finds one row; this
 *  reads the one row we already have. */
function textIn(node: DrawnNode): string {
  const stack = [...retained(node).children];
  while (stack.length) {
    const child = stack.shift() as RetainedNode;
    if (child.kind === 'text') return String(child.props.children ?? '');
    stack.push(...child.children);
  }
  return '';
}

function rowFor(label: string): DrawnNode {
  const node = rowNodes().find((n) => textIn(n) === label);
  assert.ok(node, `no row labelled ${JSON.stringify(label)}`);
  return node;
}

const FILES: TreeItem[] = [
  {
    id: 'src',
    label: 'src',
    children: [
      { id: 'src/index.ts', label: 'index.ts' },
      {
        id: 'src/tree',
        label: 'tree',
        children: [
          { id: 'src/tree/index.ts', label: 'index.ts' },
          { id: 'src/tree/rows.ts', label: 'rows.ts' },
        ],
      },
    ],
  },
  { id: 'package.json', label: 'package.json' },
];

const ACCESSORS = resolveAccessors<TreeItem>(undefined);

/** The rows of `FILES` with `open` expanded, as `depth:id`. */
function flatten(open: TreeItemId[]): string[] {
  return visibleRows(FILES, new Set(open), ACCESSORS).map(
    (r) => `${r.depth}:${r.id}`,
  );
}

// --- the row model ---------------------------------------------------------

test('a closed tree shows its roots and nothing else', () => {
  assert.deepStrictEqual(flatten([]), ['0:src', '0:package.json']);
});

test('an open branch contributes its children, in draw order', () => {
  assert.deepStrictEqual(flatten(['src']), [
    '0:src',
    '1:src/index.ts',
    '1:src/tree',
    '0:package.json',
  ]);
  assert.deepStrictEqual(flatten(['src', 'src/tree']), [
    '0:src',
    '1:src/index.ts',
    '1:src/tree',
    '2:src/tree/index.ts',
    '2:src/tree/rows.ts',
    '0:package.json',
  ]);
});

test('expanding something that is not a branch changes nothing', () => {
  // the set is the app's, and it may hold ids the tree cannot open — a
  // collapsed ancestor's descendants stay in it, which is what makes
  // collapse-then-expand restore what was open
  assert.deepStrictEqual(flatten(['package.json', 'src/tree']), [
    '0:src',
    '0:package.json',
  ]);
});

test('a branch is a branch before anything has read it', () => {
  // three ways to be one: an array of children, an empty array, and the
  // `branch` flag for a directory nobody has listed yet
  const items: TreeItem[] = [
    { id: 'full', children: [{ id: 'kid' }] },
    { id: 'empty', children: [] },
    { id: 'unread', branch: true },
    { id: 'leaf' },
  ];
  const rows = visibleRows(items, new Set(), ACCESSORS);
  assert.deepStrictEqual(
    rows.map((r) => r.branch),
    [true, true, true, false],
  );
});

test('an open branch with nothing under it yet is not an error', () => {
  // a directory being read: expanded, no children, no rows. The twisty is
  // open and the tree simply has nothing to put under it this frame.
  const items: TreeItem[] = [{ id: 'loading', branch: true }, { id: 'after' }];
  const rows = visibleRows(items, new Set(['loading']), ACCESSORS);
  assert.deepStrictEqual(
    rows.map((r) => `${r.id}:${r.open}`),
    ['loading:true', 'after:false'],
  );
});

test('rows know where they sit among their siblings', () => {
  const rows = visibleRows(FILES, new Set(['src']), ACCESSORS);
  const by = (id: string): TreeRow<TreeItem> => {
    const row = rows.find((r) => r.id === id);
    assert.ok(row, id);
    return row;
  };
  assert.deepStrictEqual(
    [by('src').posInSet, by('src').setSize, by('src').last],
    [1, 2, false],
  );
  assert.deepStrictEqual(
    [by('src/tree').posInSet, by('src/tree').setSize, by('src/tree').last],
    [2, 2, true],
  );
  assert.strictEqual(by('src/index.ts').parent?.id, 'src');
  assert.strictEqual(by('src').parent, null);
  // the index is a position among *all* visible rows, which is what
  // virtualization counts in
  assert.deepStrictEqual(
    rows.map((r) => r.index),
    [0, 1, 2, 3],
  );
});

test('the flattening does not recurse, so a deep tree is not a stack overflow', () => {
  // A generated tree — a dependency graph, a filesystem walked to the bottom
  // — reaches depths a call per level does not survive.
  let node: TreeItem = { id: 'leaf-9999' };
  for (let i = 9998; i >= 0; i--) node = { id: `n${i}`, children: [node] };
  const open = new Set<TreeItemId>();
  for (let i = 0; i < 10000; i++) open.add(`n${i}`);
  const rows = visibleRows([node], open, ACCESSORS);
  assert.strictEqual(rows.length, 10000);
  assert.strictEqual(rows[9999].depth, 9999);
});

test('a branch edge follows the ancestor whose column it is in', () => {
  const rows = visibleRows(FILES, new Set(['src', 'src/tree']), ACCESSORS);
  const edges = (id: string): boolean[] => {
    const row = rows.find((r) => r.id === id);
    assert.ok(row, id);
    return branchEdges(row);
  };
  // a root has no columns at all
  assert.deepStrictEqual(edges('src'), []);
  // `index.ts` is inside `src`, which has `package.json` after it — but the
  // only column it has is its own, and it has a sibling below it
  assert.deepStrictEqual(edges('src/index.ts'), [true]);
  // `tree` is the last child of `src`, so its own column stops here
  assert.deepStrictEqual(edges('src/tree'), [false]);
  // Two columns down. The outer one is the line joining `src`'s children,
  // and it stops at `tree` — so it is blank here even though `src` itself
  // has `package.json` after it. The inner one is this row's own, and
  // `rows.ts` follows.
  assert.deepStrictEqual(edges('src/tree/index.ts'), [false, true]);
  assert.deepStrictEqual(edges('src/tree/rows.ts'), [false, false]);
});

test('a branch edge continues past a row when the branch above it has siblings left', () => {
  // the other half of the rule:
  //   a
  //   ├─ x
  //   │  └─ 1
  //   └─ z
  //   b
  // row `1` has a line in column 0 — `x` is not the last child of `a` — and
  // nothing in its own column, since it is `x`'s only child
  const items: TreeItem[] = [
    {
      id: 'a',
      children: [{ id: 'x', children: [{ id: '1' }] }, { id: 'z' }],
    },
    { id: 'b' },
  ];
  const rows = visibleRows(items, new Set(['a', 'x']), ACCESSORS);
  const edges = (id: string): boolean[] => {
    const row = rows.find((r) => r.id === id);
    assert.ok(row, id);
    return branchEdges(row);
  };
  assert.deepStrictEqual(edges('1'), [true, false]);
  assert.deepStrictEqual(edges('x'), [true]);
  assert.deepStrictEqual(edges('z'), [false]);
});

test('the nested regrouping is the flat pass, rearranged', () => {
  const rows = visibleRows(FILES, new Set(['src', 'src/tree']), ACCESSORS);
  const root = groupRows(rows);
  /** Every row the groups hold, depth-first — which must be draw order. */
  const walk = (
    group: ReturnType<typeof groupRows<TreeItem>>,
    out: string[] = [],
  ): string[] => {
    for (const node of group.rows) {
      if (isGroup(node)) walk(node, out);
      else out.push(`${node.depth}:${node.id}`);
    }
    return out;
  };
  assert.deepStrictEqual(
    walk(root),
    rows.map((r) => `${r.depth}:${r.id}`),
  );
  // and one group per open branch that actually has children under it
  const groups: string[] = [];
  const collect = (group: ReturnType<typeof groupRows<TreeItem>>): void => {
    for (const node of group.rows) {
      if (!isGroup(node)) continue;
      groups.push(String(node.parent?.id));
      collect(node);
    }
  };
  collect(root);
  assert.deepStrictEqual(groups, ['src', 'src/tree']);
});

test('an expanded branch that is still loading gets no subtree container', () => {
  // an empty container would still paint whatever `renderSubtree` gives it —
  // a border, a background — around nothing
  const rows = visibleRows(
    [{ id: 'loading', branch: true }],
    new Set(['loading']),
    ACCESSORS,
  );
  assert.deepStrictEqual(groupRows(rows).rows.filter(isGroup), []);
});

test('accessors read the app’s own shape, and default to TreeItem’s', () => {
  interface Entry {
    path: string;
    entries?: Entry[];
  }
  const custom = resolveAccessors<Entry>({
    getId: (e) => e.path,
    getChildren: (e) => e.entries,
    getLabel: (e) => e.path.split('/').pop(),
  });
  const tree: Entry[] = [{ path: 'a', entries: [{ path: 'a/b' }] }];
  const rows = visibleRows(tree, new Set(['a']), custom);
  assert.deepStrictEqual(
    rows.map((r) => `${r.id}|${String(r.item.path)}`),
    ['a|a', 'a/b|a/b'],
  );
  assert.strictEqual(custom.getLabel(tree[0]), 'a');
  // and the default label falls through to the id, so a tree of bare ids
  // still shows something
  assert.strictEqual(ACCESSORS.getLabel({ id: 'bare' }), 'bare');
});

// --- rendering -------------------------------------------------------------

test('it renders the roots, and opens on the twisty', async () => {
  await renderX11(h(Tree, { items: FILES }));
  assert.deepStrictEqual(shown(), ['0:src', '0:package.json']);

  // the twisty is the first child of the row, and clicking it opens the
  // branch *without* moving the selection
  const twisty = retained(rowFor('src')).children[0] as unknown as DrawnNode;
  await userEvent.click(twisty);
  assert.deepStrictEqual(shown(), [
    '0:src',
    '1:index.ts',
    '1:tree',
    '0:package.json',
  ]);
  assert.strictEqual(
    retained(rowFor('src')).props['aria-selected'],
    false,
    'peeking into a folder should not select it',
  );
});

test('a leaf draws no chevron, and a branch draws the one that matches its state', async () => {
  await renderX11(h(Tree, { items: FILES, defaultExpanded: ['src'] }), {
    backend: 'mock',
  });
  const glyphOf = (label: string): RetainedNode | undefined => {
    const twisty = retained(rowFor(label)).children[0] as RetainedNode;
    return twisty.children[0] as RetainedNode | undefined;
  };
  assert.strictEqual(glyphOf('src')?.props.cacheKey, 'chevronDown');
  assert.strictEqual(glyphOf('tree')?.props.cacheKey, 'chevronRight');
  // a leaf keeps the empty hit box, so every label on a level lines up
  assert.strictEqual(glyphOf('package.json'), undefined);
});

test('clicking a row selects it; double-clicking activates it', async () => {
  const selected: TreeItemId[] = [];
  const activated: TreeItemId[] = [];
  await renderX11(
    h(Tree, {
      items: FILES,
      onSelect: (id: TreeItemId) => selected.push(id),
      onActivate: (id: TreeItemId) => activated.push(id),
    }),
  );
  await userEvent.click(rowFor('package.json'));
  assert.deepStrictEqual(selected, ['package.json']);
  assert.deepStrictEqual(activated, []);
  assert.strictEqual(
    retained(rowFor('package.json')).props['aria-selected'],
    true,
  );

  await userEvent.doubleClick(rowFor('package.json'));
  assert.deepStrictEqual(activated, ['package.json']);
});

test('a disabled row is shown, but does not take the selection', async () => {
  const items: TreeItem[] = [
    { id: 'a', label: 'a' },
    { id: 'b', label: 'b', disabled: true },
    { id: 'c', label: 'c' },
  ];
  const selected: TreeItemId[] = [];
  await renderX11(
    h(Tree, { items, onSelect: (id: TreeItemId) => selected.push(id) }),
  );
  await userEvent.click(rowFor('b'));
  assert.deepStrictEqual(selected, []);

  // and the keyboard steps over it rather than stopping on it
  await userEvent.click(rowFor('a'));
  await userEvent.key(XK_DOWN);
  assert.deepStrictEqual(selected, ['a', 'c']);
});

test('the keyboard walks the tree the way every tree does', async () => {
  const expanded: TreeItemId[][] = [];
  await renderX11(
    h(Tree, {
      items: FILES,
      onExpandedChange: (ids: TreeItemId[]) => expanded.push(ids),
    }),
  );
  await userEvent.click(rowFor('src'));

  // Right opens a closed branch...
  await userEvent.key(XK_RIGHT);
  assert.deepStrictEqual(expanded.at(-1), ['src']);
  // ...and then steps into it, since it is open now
  await userEvent.key(XK_RIGHT);
  assert.strictEqual(retained(rowFor('index.ts')).props['aria-selected'], true);

  // Left on a leaf steps out to the parent
  await userEvent.key(XK_LEFT);
  assert.strictEqual(retained(rowFor('src')).props['aria-selected'], true);
  // Left on an open branch closes it
  await userEvent.key(XK_LEFT);
  assert.deepStrictEqual(expanded.at(-1), []);
  assert.deepStrictEqual(shown(), ['0:src', '0:package.json']);

  await userEvent.key(XK_END);
  assert.strictEqual(
    retained(rowFor('package.json')).props['aria-selected'],
    true,
  );
  await userEvent.key(XK_HOME);
  assert.strictEqual(retained(rowFor('src')).props['aria-selected'], true);
  await userEvent.key(XK_DOWN);
  assert.strictEqual(
    retained(rowFor('package.json')).props['aria-selected'],
    true,
  );
  await userEvent.key(XK_UP);
  assert.strictEqual(retained(rowFor('src')).props['aria-selected'], true);
});

test('Enter toggles a branch and activates whatever it lands on', async () => {
  const activated: TreeItemId[] = [];
  await renderX11(
    h(Tree, {
      items: FILES,
      onActivate: (id: TreeItemId) => activated.push(id),
    }),
  );
  await userEvent.click(rowFor('src'));
  await userEvent.key(XK_RETURN);
  assert.deepStrictEqual(activated, ['src']);
  assert.deepStrictEqual(shown(), [
    '0:src',
    '1:index.ts',
    '1:tree',
    '0:package.json',
  ]);
});

test('typing letters jumps to the row that starts with them', async () => {
  await renderX11(h(Tree, { items: FILES, defaultExpanded: ['src'] }));
  await userEvent.click(rowFor('src'));
  await userEvent.type(rowFor('src'), 'tr', { skipClick: true });
  assert.strictEqual(retained(rowFor('tree')).props['aria-selected'], true);
});

test('the change event names the row that changed, not just the new set', async () => {
  // what lazy loading reads: `change.open && !loaded.has(change.id)` is the
  // fetch, and the set alone cannot say which id to fetch
  const changes: Array<TreeExpandChange<TreeItem>> = [];
  await renderX11(
    // `Tree<TreeItem>` rather than `Tree`: `createElement` does not infer a
    // component's type argument from its props object, and the callbacks
    // below are the only place in this file where that shows.
    h(Tree<TreeItem>, {
      items: FILES,
      onExpandedChange: (
        _ids: TreeItemId[],
        change: TreeExpandChange<TreeItem>,
      ) => {
        changes.push(change);
      },
    }),
  );
  await userEvent.click(rowFor('src'));
  await userEvent.key(XK_RIGHT);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].id, 'src');
  assert.strictEqual(changes[0].open, true);
  assert.strictEqual(changes[0].item.label, 'src');
});

test('a controlled tree does not move until the app says so', async () => {
  const seen: TreeItemId[][] = [];
  await renderX11(
    h(Tree, {
      items: FILES,
      expanded: [],
      onExpandedChange: (ids: TreeItemId[]) => seen.push(ids),
    }),
  );
  const twisty = retained(rowFor('src')).children[0] as unknown as DrawnNode;
  await userEvent.click(twisty);
  assert.deepStrictEqual(seen, [['src']], 'it still reports the intent');
  assert.deepStrictEqual(
    shown(),
    ['0:src', '0:package.json'],
    'and nothing else',
  );
});

// --- the seams -------------------------------------------------------------

test('the default look has no branch lines, and asking for them adds a column per level', async () => {
  await renderX11(
    h(Tree, { items: FILES, defaultExpanded: ['src', 'src/tree'] }),
    { backend: 'mock' },
  );
  // no guides: the indent is padding, so a row ten deep is not ten boxes
  const deep = retained(rowFor('rows.ts'));
  assert.strictEqual(deep.children.length, 2, 'twisty and label only');
  await cleanup();

  const levels: number[] = [];
  await renderX11(
    h(Tree, {
      items: FILES,
      defaultExpanded: ['src', 'src/tree'],
      renderGuide: (g: { level: number }) => {
        levels.push(g.level);
        return null;
      },
    }),
    { backend: 'mock' },
  );
  const guided = retained(rowFor('rows.ts'));
  assert.strictEqual(guided.children.length, 4, 'two guides, twisty, label');
  assert.deepStrictEqual(levels.slice(-2), [0, 1], 'outermost column first');
});

test('renderToggle replaces the chevron and can still open the branch', async () => {
  await renderX11(
    h(Tree, {
      items: FILES,
      renderToggle: (state: { branch: boolean; open: boolean }) =>
        state.branch ? h('text', null, state.open ? '-' : '+') : null,
    }),
  );
  const twisty = retained(rowFor('src')).children[0] as unknown as DrawnNode;
  assert.strictEqual(textIn(twisty), '+');
  await userEvent.click(twisty);
  assert.deepStrictEqual(shown(), [
    '0:src',
    '1:index.ts',
    '1:tree',
    '0:package.json',
  ]);
});

test('layout="nested" puts each open branch in a container of its own', async () => {
  await renderX11(
    h(Tree, {
      items: FILES,
      layout: 'nested',
      defaultExpanded: ['src', 'src/tree'],
    }),
    { backend: 'mock' },
  );
  const groups = screen.all((n) => retained(n).props.role === 'group');
  assert.strictEqual(groups.length, 2, 'one per open branch with children');
  // the rows are the same rows, in the same order, at the same depths
  assert.deepStrictEqual(shown(), [
    '0:src',
    '1:index.ts',
    '1:tree',
    '2:index.ts',
    '2:rows.ts',
    '0:package.json',
  ]);
  // and the container really does contain them
  const inner = retained(groups[1]);
  assert.strictEqual(inner.children.length, 2);
});

test('renderSubtree replaces the container', async () => {
  await renderX11(
    h(Tree<TreeItem>, {
      items: FILES,
      layout: 'nested',
      defaultExpanded: ['src'],
      // no key: the seam's return is wrapped in one the component owns, so a
      // subtree cannot collide with the row it hangs off
      renderSubtree: (
        state: TreeSubtreeState<TreeItem>,
        rows: React.ReactNode,
      ) => h('box', { 'aria-label': `under ${state.parent.id}` }, rows),
    }),
    { backend: 'mock' },
  );
  const [box] = screen.all(
    (n) => retained(n).props['aria-label'] === 'under src',
  );
  assert.ok(box, 'the subtree seam should have been asked');
  assert.strictEqual(retained(box).children.length, 2);
});

// --- virtualization --------------------------------------------------------

/** `count` roots, `label`led by index. */
function manyItems(count: number): TreeItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    label: `row ${i}`,
  }));
}

test('a big tree builds only the rows near the viewport', async () => {
  await renderX11(
    h(
      'box',
      { style: { width: 200, height: 220 } },
      h(Tree, {
        items: manyItems(10000),
      }),
    ),
  );
  const built = rowNodes().length;
  assert.ok(built > 0, 'something is on screen');
  assert.ok(built < 100, `10000 rows should not all be built, got ${built}`);
  // every built row still says where it sits in the whole tree, which is
  // what a screen reader has instead of the rows it cannot see
  assert.strictEqual(retained(rowNodes()[0]).props['aria-setsize'], 10000);
});

test('the spacers make the scrollbar measure the whole tree', async () => {
  await renderX11(
    h(
      'box',
      { style: { width: 200, height: 220 } },
      h(Tree, {
        items: manyItems(1000),
        rowHeight: 20,
      }),
    ),
  );
  const tree = screen.all((n) => retained(n).props.role === 'tree')[0];
  // the last child is the spacer standing in for everything below the slice
  const kids = retained(tree).children;
  const rows = rowNodes().length;
  const spacers = kids.length - rows;
  assert.ok(spacers >= 1, 'at least the trailing spacer');
  assert.strictEqual(scrolling(tree).contentHeight, 1000 * 20);
});

test('a small tree is built whole, so its rows may be any height', async () => {
  await renderX11(h(Tree, { items: manyItems(50) }), { backend: 'mock' });
  assert.strictEqual(rowNodes().length, 50);
});

test('virtual={false} keeps a big tree whole, for rows that are not all one height', async () => {
  await renderX11(h(Tree, { items: manyItems(300), virtual: false }), {
    backend: 'mock',
  });
  assert.strictEqual(rowNodes().length, 300);
});

test('layout="nested" is never virtualized, whatever virtual says', async () => {
  // a slice of a flat list is a list; a slice of a nested structure is not a
  // tree, so the two features are exclusive and the layout wins
  await renderX11(
    h(Tree, { items: manyItems(300), layout: 'nested', virtual: true }),
    { backend: 'mock' },
  );
  assert.strictEqual(rowNodes().length, 300);
});

test('the keyboard reaches a row that is not built yet', async () => {
  // End in a virtualized tree selects a row that does not exist in the node
  // tree at the moment the key is handled — the model is what answers, and
  // the scroll that follows is arithmetic rather than a node's geometry
  const selected: TreeItemId[] = [];
  await renderX11(
    h(
      'box',
      { style: { width: 200, height: 220 } },
      h(Tree, {
        items: manyItems(5000),
        onSelect: (id: TreeItemId) => selected.push(id),
      }),
    ),
  );
  await userEvent.click(rowNodes()[0]);
  await userEvent.key(XK_END);
  assert.deepStrictEqual(selected.at(-1), 4999);
  const tree = screen.all((n) => retained(n).props.role === 'tree')[0];
  assert.ok(scrolling(tree).scrollY > 0, 'and it scrolled there');
  assert.ok(rowNodes().some((n) => textIn(n) === 'row 4999'));

  await userEvent.key(XK_PAGE_DOWN);
  assert.strictEqual(selected.at(-1), 4999, 'the end is the end');
});

// --- the handle ------------------------------------------------------------

test('the handle drives the tree from outside it', async () => {
  const ref = React.createRef<TreeHandle<TreeItem>>();
  await renderX11(
    h(
      'box',
      { style: { width: 200, height: 220 } },
      h(Tree, {
        items: FILES,
        ref,
      }),
    ),
  );
  const handle = ref.current;
  assert.ok(handle);

  assert.deepStrictEqual(
    handle.rows().map((r) => r.id),
    ['src', 'package.json'],
  );
  handle.setExpanded('src', true);
  await userEvent.key(XK_DOWN, { target: null });
  assert.deepStrictEqual(
    handle.rows().map((r) => r.id),
    ['src', 'src/index.ts', 'src/tree', 'package.json'],
  );

  // a row nobody can see cannot be scrolled to, and says so rather than
  // pretending
  assert.strictEqual(handle.scrollToItem('src/tree/rows.ts'), false);
  assert.strictEqual(handle.scrollToItem('src/tree'), true);
});

test('setExpanded reaches a branch no row is showing, and refuses an id that is not there', async () => {
  // the case this exists for: a lazy load finishing under a branch the user
  // collapsed again. There is no row for it, and expanding it is still
  // legitimate — so the whole loaded tree is searched, not the rows.
  const changes: Array<TreeExpandChange<TreeItem>> = [];
  const ref = React.createRef<TreeHandle<TreeItem>>();
  await renderX11(
    h(Tree<TreeItem>, {
      items: FILES,
      ref,
      onExpandedChange: (
        _ids: TreeItemId[],
        change: TreeExpandChange<TreeItem>,
      ) => {
        changes.push(change);
      },
    }),
  );
  const handle = ref.current;
  assert.ok(handle);

  // `src` is collapsed, so `src/tree` is not a row anywhere
  assert.strictEqual(
    rowNodes().some((n) => textIn(n) === 'tree'),
    false,
  );
  assert.strictEqual(handle.setExpanded('src/tree', true), true);
  assert.strictEqual(changes.at(-1)?.id, 'src/tree');
  // and the item on the change is the real one, which is what makes
  // `TreeExpandChange<T>.item` honestly `T`
  assert.strictEqual(changes.at(-1)?.item.label, 'tree');

  // an id nothing answers to has no item to report, so nothing happens at all
  assert.strictEqual(handle.setExpanded('nowhere', true), false);
  assert.strictEqual(changes.length, 1);
});

test('handleKey lets a control above the tree hold the keyboard', async () => {
  // a filter box owns the focus; the arrows still have to walk the list
  const ref = React.createRef<TreeHandle<TreeItem>>();
  await renderX11(h(Tree, { items: FILES, ref }));
  const handle = ref.current;
  assert.ok(handle);

  assert.strictEqual(handle.handleKey({ keysym: XK_DOWN } as never), true);
  // and it reports what it did not take, so the caller keeps its own keys
  assert.strictEqual(handle.handleKey({ keysym: 0xff1b } as never), false);
});
