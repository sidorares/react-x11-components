// Type-level test: the tree's props compile against react-x11's JSX
// namespace, and — the part worth pinning — the generic follows the app's own
// item type all the way through the accessors, the seams and the callbacks.
// A `<Tree>` over a custom node whose `renderLabel` had to take `any` would
// still run; it would just have stopped being typed, which no run-time test
// can see.
import React, { useRef } from 'react';

import { Tree } from '../../src/index.js';
import type {
  TreeHandle,
  TreeItem,
  TreeItemId,
  TreeRowState,
  TreeStyles,
} from '../../src/index.js';

const FILES: TreeItem[] = [
  {
    id: 'src',
    label: 'src',
    children: [{ id: 'src/index.ts', label: 'index.ts' }],
  },
  // a branch nobody has read yet
  { id: 'node_modules', label: 'node_modules', branch: true },
  { id: 'README.md', label: 'README.md', disabled: true },
];

/** Out of the box: items, and nothing else. */
export const plain = (
  <box style={{ flexGrow: 1 }}>
    <Tree items={FILES} />
  </box>
);

export const controlled = (
  <Tree
    items={FILES}
    expanded={['src']}
    selected="src/index.ts"
    onExpandedChange={(ids, change) => {
      const first: TreeItemId | undefined = ids[0];
      // the item on the change is the app's own type, not `unknown`
      const label = change.item.label;
      void first;
      void label;
      void change.open;
    }}
    onSelect={(id, item) => {
      void id;
      void item.children;
    }}
    onActivate={(id) => void id}
  />
);

// --- an app's own node type ------------------------------------------------

interface Entry {
  path: string;
  entries?: Entry[];
  loaded: boolean;
}

const TREE: Entry[] = [{ path: '/', loaded: true, entries: [] }];

export const custom = (
  <Tree<Entry>
    items={TREE}
    getId={(e) => e.path}
    getChildren={(e) => e.entries}
    getLabel={(e) => e.path.split('/').pop() ?? '/'}
    getText={(e) => e.path}
    isBranch={(e) => e.entries !== undefined || !e.loaded}
    isDisabled={() => false}
    onSelect={(id, item) => {
      // both sides of the callback know what an item is
      const path: string = item.path;
      void id;
      void path;
    }}
    renderLabel={(state) => <text>{state.item.path}</text>}
    renderToggle={(state) =>
      state.branch ? (
        <text style={{ color: state.color }}>{state.open ? '▾' : '▸'}</text>
      ) : null
    }
    renderGuide={(guide) =>
      guide.continues ? (
        <box
          style={{ width: 1, backgroundColor: '$border', height: guide.height }}
        />
      ) : null
    }
    renderSubtree={(state, rows) => (
      <box aria-label={state.parent.item.path}>{rows}</box>
    )}
    renderContent={(state, content) => (
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {content}
        <text style={{ color: state.color }}>
          {state.item.loaded ? '' : '…'}
        </text>
      </box>
    )}
  />
);

/** The style bag, including the per-row function form. */
export const styled: TreeStyles<TreeItem> = {
  row: (state: TreeRowState<TreeItem>) =>
    state.branch ? { fontWeight: 'bold' } : null,
  toggle: { width: 16 },
  guide: { width: 1 },
  label: { fontSize: 12 },
  subtree: { paddingStart: 8 },
};

export const withStyles = (
  <Tree items={FILES} styles={styled} style={{ minWidth: 180 }} />
);

/** Virtualization and layout are plain props, and `<box>`'s own props still
 *  pass through to the container. */
export const big = (
  <Tree
    items={FILES}
    virtual
    overscan={10}
    rowHeight={24}
    indent={18}
    layout="flat"
    aria-label="Files"
    onScroll={(ev) => void ev.scrollY}
  />
);

export const nested = <Tree items={FILES} layout="nested" indent={0} />;

/** The handle is generic too: `rows()` hands back the app's items. */
export function WithHandle(): React.ReactElement {
  const tree = useRef<TreeHandle<Entry>>(null);
  return (
    <box
      onKeyDown={(ev) => {
        if (tree.current?.handleKey(ev)) return;
        const first: Entry | undefined = tree.current?.rows()[0]?.item;
        void first;
      }}
    >
      <Tree<Entry> ref={tree} items={TREE} getId={(e) => e.path} />
    </box>
  );
}
