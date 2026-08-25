// <Tree> — the successor to react-x11's own, which is being retired.
//
// The row model is tested directly and hardest. Every subtle tree bug lives
// there rather than in the painting: a branch that is open but not loaded, a
// guide column that follows the wrong ancestor, a nested regrouping that
// disagrees with the flat pass about depth. None of that needs a display.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import type { ReactNode } from 'react';

import { renderX11, cleanup, screen, userEvent, act } from 'react-x11/test';
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

test('the keyboard only scrolls when the selection would leave the viewport', async () => {
  // The tree's root is a scroll container *and* the focused node, and a
  // focused scroller has default key actions: Down and Up scroll by a wheel
  // notch, the Page keys by a viewport, Home and End to the ends. Without a
  // `preventDefault` every arrow did both — moved the selection and scrolled
  // the list under it — so the tree appeared to scroll whenever the keyboard
  // was used at all.
  const items: TreeItem[] = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    label: `row ${i}`,
  }));
  await renderX11(
    h(
      'box',
      { style: { width: 220, height: 220, minHeight: 0 } },
      h(Tree, { items, rowHeight: 40 }),
    ),
  );
  const tree = () =>
    scrolling(screen.all((n) => retained(n).props.role === 'tree')[0]);
  const fits = Math.floor(220 / 40); // rows that fit in the viewport

  await userEvent.click(rowNodes()[0]);
  assert.strictEqual(tree().scrollY, 0);

  // walking down inside the viewport must not move the list at all
  for (let i = 1; i < fits; i++) {
    await userEvent.key(XK_DOWN);
    assert.strictEqual(
      tree().scrollY,
      0,
      `row ${i} is still on screen, so nothing should have scrolled`,
    );
  }

  // the first row past the fold scrolls by exactly what it needs
  await userEvent.key(XK_DOWN);
  assert.strictEqual(tree().scrollY, (fits + 1) * 40 - 220);

  // and coming back up holds still until the selection would leave the top
  const at = tree().scrollY;
  await userEvent.key(XK_UP);
  assert.strictEqual(tree().scrollY, at, 'the row above is already visible');
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

// --- rows are as tall as their content --------------------------------------

// None of these can use `backend: 'mock'`: the mock context does not measure
// text, so a wrapped label and a clipped one are the same zero-height box
// there and every assertion below would pass either way.

const LONG = 'markdown-component-selection-9ded95-and-then-some-more-still';

/** Let the measurement pass run. Layout happens on a frame flush and the
 *  measurement a tick after it, so a render is two turns short of settled. */
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

test('a row grows to hold a label that wraps', async () => {
  // The whole point of measuring rows. Before this, a wrapped label was two
  // lines inside a 22px box and its second line was drawn over the row below.
  await renderX11(
    h(
      'box',
      { style: { width: 180, height: 200, minHeight: 0 } },
      // `rowHeight` well clear of one line: the exact height of a line is
      // the font's business and CI's font is not this machine's, so a test
      // that pinned 22 would be pinning the font.
      h(Tree, {
        rowHeight: 40,
        items: [
          { id: 'a', label: LONG },
          { id: 'b', label: 'b' },
        ],
      }),
    ),
  );
  const [first, second] = rowNodes().map((n) => retained(n));
  const text = first.children.find(
    (n) => (n as RetainedNode).kind === 'text',
  ) as RetainedNode | undefined;
  assert.ok(text, 'the default label is a <text>');
  assert.ok(text.abs.height > 40, 'the label really did wrap');
  assert.ok(
    first.abs.height >= text.abs.height,
    `the row is ${first.abs.height}px and its label ${text.abs.height}px`,
  );
  // and the row below starts under it rather than through it
  assert.ok(
    second.abs.y >= first.abs.y + first.abs.height,
    'the next row starts below the wrapped one',
  );
  // a short label still gets the floor
  assert.strictEqual(second.abs.height, 40);
});

test('styles.label puts the one-line, clipped look back', async () => {
  // What a file browser wants, and what the example asks for.
  await renderX11(
    h(
      'box',
      { style: { width: 180, height: 200, minHeight: 0 } },
      h(Tree, {
        rowHeight: 40,
        items: [{ id: 'a', label: LONG }],
        styles: { label: { textWrap: 'nowrap' } },
      }),
    ),
  );
  assert.strictEqual(retained(rowNodes()[0]).abs.height, 40);
});

test('rowHeight is a floor, and rows may exceed it', async () => {
  await renderX11(
    h(
      'box',
      { style: { width: 180, height: 200, minHeight: 0 } },
      h(Tree, {
        items: [
          { id: 'a', label: LONG },
          { id: 'b', label: 'b' },
        ],
        rowHeight: 40,
      }),
    ),
  );
  const [first, second] = rowNodes().map((n) => retained(n).abs.height);
  assert.strictEqual(second, 40, 'the floor is honoured');
  assert.ok(first > 40, `a wrapped row exceeds it, got ${first}`);
});

// --- virtualization --------------------------------------------------------

test('a virtualized tree measures its rows and totals them honestly', async () => {
  // Every other row wraps, so a fixed-height guess is wrong for half the
  // list. The scrollbar has to end up measuring what the rows really are.
  const items: TreeItem[] = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    label: i % 2 === 0 ? `row ${i}` : `${LONG} ${i}`,
  }));
  await renderX11(
    h(
      'box',
      { style: { width: 200, height: 220, minHeight: 0 } },
      h(Tree, { items, virtual: true }),
    ),
  );
  const tree = () =>
    scrolling(screen.all((n) => retained(n).props.role === 'tree')[0]);
  await settle();

  // The unmeasured guess is 400 × 22. Every wrapped row that has been drawn
  // is taller than that, so a total still sitting on the guess would mean no
  // measurement reached the index at all. Waited out rather than sampled
  // once: the idle band keeps measuring and the estimate re-learns from the
  // mean, until a whole settle changes nothing.
  const guess = 400 * 22;
  let measured = tree().contentHeight;
  for (let round = 0; round < 10; round++) {
    await idle(200);
    if (tree().contentHeight === measured) break;
    measured = tree().contentHeight;
  }
  assert.ok(
    measured > guess,
    `the total is still the flat guess: ${measured} vs ${guess}`,
  );

  // it stops: a stretch longer than any of the idle clocks finds nothing
  // new, which is what keeps measure → render → measure from spinning
  await idle(200);
  assert.strictEqual(tree().contentHeight, measured, 'it converged');

  // The estimate has learnt the measured mean of this half-and-half mix, so
  // the total speaks for the rows nobody has visited: within a couple of
  // pixels a row of "the rest look like the ones we have seen".
  const drawn = rowNodes().map((n) => retained(n));
  const short = drawn.find((n) => n.abs.height > 0 && n.abs.height <= 30);
  const tall = drawn.find((n) => n.abs.height > 30);
  assert.ok(short && tall, 'both row shapes should be on screen');
  const expected = 200 * short.abs.height + 200 * tall.abs.height;
  assert.ok(
    Math.abs(measured - expected) <= 800,
    `the total ${measured} strays from ${expected}`,
  );

  // scrolling into territory nobody had drawn still ends in full rows
  // covering the viewport, with the window still a slice
  tree().scrollTo({ y: 4000 });
  await settle();
  await idle(300);
  const pane = retained(tree());
  const rows = rowNodes()
    .map((n) => retained(n))
    .filter((n) => n.abs.height > 0)
    .sort((a, b) => a.abs.y - b.abs.y);
  assert.ok(rows.length > 0, 'nothing was built after the jump');
  assert.ok(
    rows[0].abs.y <= pane.abs.y + 1 &&
      rows[rows.length - 1].abs.y + rows[rows.length - 1].abs.height >=
        pane.abs.y + pane.abs.height - 1,
    'the viewport is not covered by rows after the jump',
  );
  assert.ok(rowNodes().length < 180, `built ${rowNodes().length} of 400`);
});

test('the idle band grows past the overscan while the tree sits still', async () => {
  // The band itself is asserted in detail against <Table>; this holds the
  // tree to the same machinery: rows accumulate beyond the slice while
  // nothing scrolls, so the next notch lands on rows already built.
  const items: TreeItem[] = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    label: `row ${i}`,
  }));
  await renderX11(
    h(
      'box',
      { style: { width: 200, height: 220, minHeight: 0 } },
      h(Tree, { items, virtual: true }),
    ),
  );
  await settle();
  await idle(400);
  assert.ok(
    rowNodes().length > 40,
    `the band never grew: ${rowNodes().length} rows built`,
  );
  assert.ok(rowNodes().length < 180, `built ${rowNodes().length} of 400`);
});

test('measuring a row above the viewport does not move what is on screen', async () => {
  // The failure this guards: rows scrolled past are measured late, every one
  // of them taller than the guess, and the list yanks upward under the
  // pointer. The scroll offset has to absorb the difference.
  const items: TreeItem[] = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    label: `${LONG} ${i}`,
  }));
  // prefetch: 0, so nothing beyond the slice is built — the band's own
  // behaviour is asserted in table.test.ts ('the idle band grows without
  // moving what is on screen'). This test wants the narrow invariant:
  // measuring the rows the slice drew never moves the row under the pointer.
  await renderX11(
    h(
      'box',
      { style: { width: 200, height: 220, minHeight: 0 } },
      h(Tree, { items, virtual: true, prefetch: 0 }),
    ),
  );
  const tree = () =>
    scrolling(screen.all((n) => retained(n).props.role === 'tree')[0]);
  await settle();

  tree().scrollTo({ y: 4000 });
  await settle();
  /** The id of the row drawn at the top of the viewport. */
  const topRow = (): string => {
    const rows = rowNodes()
      .map((n) => retained(n))
      .filter((n) => n.abs.height > 0)
      .sort((a, b) => a.abs.y - b.abs.y);
    const top = rows.find((n) => n.abs.y + n.abs.height > 0);
    return String(top?.props['aria-posinset'] ?? '?');
  };
  const wasShowing = topRow();

  await settle();
  // The offset itself may move — the estimate re-learning from the measured
  // mean rebuilds every unmeasured offset, and the nudge absorbs the
  // difference. What must hold still is what is on screen.
  assert.strictEqual(topRow(), wasShowing, 'the row under the pointer moved');
});

// --- virtualization --------------------------------------------------------

test('a tree whose ancestors bound it can scroll once a branch is opened', async () => {
  // The other half of the same report, and it is a layout rule rather than a
  // component bug: a flex item's automatic minimum size is its content, so an
  // ancestor without `minHeight: 0` grows to the whole expanded tree and the
  // scroll container inside it has nothing left to scroll. Asserted here so
  // that the shape this component is meant to be used in keeps working.
  const kids = Array.from({ length: 40 }, (_, i) => ({
    id: `k${i}`,
    label: `child ${i}`,
  }));
  // The sidebar shape in full — a caption above the tree, and a second pane
  // beside it. The second pane matters: with one child the row takes the
  // window's height anyway, and the bug only shows once the row has to
  // resolve a cross size across two of them.
  await renderX11(
    h(
      'box',
      { style: { flexGrow: 1, flexDirection: 'row', minHeight: 0 } },
      h(
        'box',
        { style: { width: 200, flexShrink: 0, minHeight: 0 } },
        h('text', { style: { fontSize: 11 } }, 'worktrees'),
        h(Tree, { items: [{ id: 'root', label: 'root', children: kids }] }),
      ),
      h('box', { style: { flexGrow: 1 } }),
    ),
    { width: 400, height: 200 },
  );
  const [tree] = screen.all((n) => retained(n).props.role === 'tree');
  const before = scrolling(tree).contentHeight;

  const twisty = retained(rowFor('root')).children[0] as unknown as DrawnNode;
  await userEvent.click(twisty);

  const box = scrolling(tree);
  assert.ok(box.contentHeight > before, 'opening a branch grows the content');
  assert.ok(
    box.abs.height < box.contentHeight,
    `the tree stayed ${box.abs.height}px tall inside its ancestors, ` +
      `not ${box.contentHeight}px`,
  );
  box.scrollTo({ y: 200 });
  assert.strictEqual(box.scrollY, 200, 'and it actually scrolls');
});

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
      // A floor no line of text can exceed, so every row is exactly 40 on
      // any font and the total is a number this can assert rather than a
      // range. With a floor near one line the answer is the font's.
      h(Tree, {
        items: manyItems(1000),
        rowHeight: 40,
      }),
    ),
  );
  const tree = screen.all((n) => retained(n).props.role === 'tree')[0];
  // the last child is the spacer standing in for everything below the slice
  const kids = retained(tree).children;
  const rows = rowNodes().length;
  const spacers = kids.length - rows;
  assert.ok(spacers >= 1, 'at least the trailing spacer');
  assert.strictEqual(scrolling(tree).contentHeight, 1000 * 40);
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

// --- following a tree that grows -------------------------------------------
//
// A tree grows under its own hands — a branch opens, a watcher adds rows —
// and the scroll pane can only reach as far as the content the *last* layout
// measured. It also moves without saying so, re-clamping an offset the
// content outgrew. Neither is visible until something asks to be scrolled to
// in the same breath as the growth. See `src/internal/scroll.ts`.

/** The tree's pane, as a scroller. */
function treePane(): ScrollableNode {
  return scrolling(screen.all((n) => retained(n).props.role === 'tree')[0]);
}

/** The rows on screen, by their position in the whole tree. */
function drawnPositions(): number[] {
  return rowNodes()
    .map((n) => Number(retained(n).props['aria-posinset']))
    .sort((a, b) => a - b);
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
    const pane = retained(treePane());
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

/** A tree whose rows arrive over time, scrolling to the newest one — a log,
 *  a watcher, a build tailing its own output. */
function GrowingTree(props: {
  start: number;
  hooks: { add?: (n: number) => void };
  /** Deliberately wrong, in the test that wants the guess to be wrong. */
  estimate?: number;
  /** `0` in the test whose invariant is "the slice moves rather than
   *  grows" — the idle band deliberately keeps rows behind the viewport. */
  prefetch?: number;
}): ReactNode {
  const [items, setItems] = React.useState<TreeItem[]>(() =>
    Array.from({ length: props.start }, (_, i) => ({
      id: `n${i}`,
      label: `row ${i}`,
    })),
  );
  const ref = React.useRef<TreeHandle | null>(null);
  const next = React.useRef(props.start);
  props.hooks.add = (n: number) => {
    setItems((prev) => [
      ...prev,
      ...Array.from({ length: n }, () => {
        const i = next.current++;
        return { id: `n${i}`, label: `row ${i}` };
      }),
    ]);
  };
  React.useEffect(() => {
    const last = items[items.length - 1];
    if (last) ref.current?.scrollToItem(last.id);
  }, [items]);
  return h(
    'box',
    { style: { width: 240, height: 200, minHeight: 0 } },
    h(Tree, {
      ref,
      items,
      virtual: true,
      estimatedRowHeight: props.estimate,
      prefetch: props.prefetch,
    }),
  );
}

test('rows arriving in bursts leave the newest one in view', async () => {
  const hooks: { add?: (n: number) => void } = {};
  await renderX11(h(GrowingTree, { start: 300, hooks }));
  await settle();
  // the mount's own scroll counts: it is asked for before there is any
  // laid-out content to scroll through
  await assertTailShows('on mount', 300);

  for (let burst = 0; burst < 3; burst++) {
    await act(() => {
      for (let i = 0; i < 10; i++) hooks.add?.(4);
    });
    await settle();
    await assertTailShows(`burst ${burst}`, 300 + (burst + 1) * 40);
  }
});

test('a tail whose rows are taller than the guess still ends on the newest', async () => {
  // `estimatedRowHeight` deliberately half a row: every row measures taller
  // than the index believed, so the content grows under the scroll that was
  // just made and the bottom moves after the tail reached it. What must not
  // happen is the tail settling for a row that is *not* the newest — the
  // reveal is judged against a guess there, and a guess is not something to
  // settle on.
  const hooks: { add?: (n: number) => void } = {};
  await renderX11(h(GrowingTree, { start: 300, hooks, estimate: 12 }));
  await settle();
  await assertTailShows('on mount, guessing low', 300);

  await act(() => {
    for (let i = 0; i < 10; i++) hooks.add?.(4);
  });
  await settle();
  if (process.env.TAIL_DEBUG) {
    for (let i = 0; i < 6; i++) {
      const drawn = rowNodes().map((n) => retained(n));
      const last = drawn[drawn.length - 1];
      const pane = retained(treePane());
      console.log(
        `[tail] round ${i}: pos=${last.props['aria-posinset']} ` +
          `bottom=${last.abs.y + last.abs.height} paneBottom=${pane.abs.y + pane.abs.height} ` +
          `scrollY=${treePane().scrollY} content=${treePane().contentHeight}`,
      );
      await settle();
    }
  }
  await assertTailShows('after a burst, guessing low', 340);
});

test('the slice follows the offset even when nothing said it moved', async () => {
  // One row at a time, with the newest row already on screen — the reveal
  // resolves inside layout, which fires no event. The slice used to freeze
  // there: the rendered rows piled up and the newest ones stopped being built.
  const hooks: { add?: (n: number) => void } = {};
  await renderX11(h(GrowingTree, { start: 300, hooks, prefetch: 0 }));
  await settle();
  const started = drawnPositions()[0];
  const built = rowNodes().length;
  for (let i = 0; i < 8; i++) {
    await act(() => hooks.add?.(1));
    await settle();
  }
  await assertTailShows('after eight single rows', 308);
  assert.ok(
    drawnPositions()[0] > started,
    `the slice froze at row ${started} instead of moving`,
  );
  assert.ok(
    rowNodes().length <= built + 1,
    `the slice grew instead of moving: ${built} → ${rowNodes().length}`,
  );
});

test('a row revealed in the branch that just opened is reached', async () => {
  // The reveal path the tail tests never take: a row that has never been
  // mounted, placed by the height index rather than by its own geometry.
  const kids = Array.from({ length: 300 }, (_, i) => ({
    id: `k${i}`,
    label: `child ${i}`,
  }));
  const ref = React.createRef<TreeHandle>();
  await renderX11(
    h(
      'box',
      { style: { width: 240, height: 200, minHeight: 0 } },
      h(Tree, {
        ref,
        virtual: true,
        // the guess is wrong on purpose: the index places this row from it,
        // and the rows drawn on the way there are measured taller afterwards
        estimatedRowHeight: 12,
        items: [
          { id: 'top', label: 'top' },
          { id: 'branch', label: 'branch', children: kids },
        ],
      }),
    ),
  );
  await settle();
  await act(() => {
    ref.current?.setExpanded('branch', true);
  });
  // A row 280 deep in a branch that was closed a moment ago: it is in the
  // model, it has never been drawn, and the height index is the only thing
  // that knows where it is.
  assert.strictEqual(ref.current?.scrollToItem('k280'), true);
  await settle();
  const row = rowNodes()
    .map((n) => retained(n))
    .find((n) => textIn(n as unknown as DrawnNode) === 'child 280');
  assert.ok(row, 'the row asked for was never built');
  const pane = retained(treePane());
  assert.ok(
    row.abs.y >= pane.abs.y - 1 &&
      row.abs.y + row.abs.height <= pane.abs.y + pane.abs.height + 1,
    `the row is at ${row.abs.y}..${row.abs.y + row.abs.height}, ` +
      `outside the pane's ${pane.abs.y}..${pane.abs.y + pane.abs.height}`,
  );
});

test('a scroll of the user’s own ends the chase rather than fighting it', async () => {
  const hooks: { add?: (n: number) => void } = {};
  await renderX11(h(GrowingTree, { start: 300, hooks }));
  await settle();
  treePane().scrollTo({ y: 0 });
  await settle();
  assert.strictEqual(treePane().scrollY, 0, 'the user is at the top');
  assert.strictEqual(drawnPositions()[0], 1, 'and the first rows are built');
});

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
