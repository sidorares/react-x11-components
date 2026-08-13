// The row model: what a tree of items looks like once it has been opened.
//
// Everything in this file is pure, and deliberately so. A tree's real
// complexity is not the painting — it is "which rows are on screen, in what
// order, at what depth, and which of them is the last of its siblings", and
// every one of those questions is answerable without a display. The component
// then only has to draw the answer.
//
// The flattening is also what makes virtualization possible at all: a
// window into a list is arithmetic, a window into a recursive structure is
// not. `<Tree layout="nested">` renders the same rows nested again (see
// `groupRows`), so the two layouts cannot disagree about the tree they are
// showing.

import type { ReactNode } from 'react';

/** What an item is keyed by. Numbers are allowed because a row often comes
 *  from a database and stringifying an id is a chance to lose one. */
export type TreeItemId = string | number;

/**
 * The item shape `<Tree>` reads with no accessors configured.
 *
 * `children` being an array — **even an empty one** — is what makes an item a
 * branch, which is how a directory shows a twisty before anything has read
 * it. An item whose children are not known yet says so with `branch: true`
 * and no `children` at all; see {@link TreeAccessors.isBranch}.
 */
export interface TreeItem {
  id: TreeItemId;
  /** A string or a number is wrapped in a `<text>`; anything else is
   *  rendered as it stands. */
  label?: ReactNode;
  children?: readonly TreeItem[];
  /** A branch whose children have not been loaded. Ignored when `children`
   *  is an array, which already answers the question. */
  branch?: boolean;
  disabled?: boolean;
}

/**
 * How to read the app's own node type.
 *
 * The default answers describe {@link TreeItem}, so a tree of
 * `{ id, label, children }` needs none of this. Anything else — a
 * `{ path, entries }` from a file listing, an AST, a normalized store keyed by
 * id — hands over the four or five functions instead of copying its data into
 * a shape this component preferred.
 *
 * **Define them outside the component, or memoize them.** The flattening is
 * keyed on their identity, because an `isBranch` that reads state has to be
 * able to change what the tree shows; a fresh arrow per render therefore
 * re-flattens the tree per render. On a small tree that costs nothing and on
 * a large one it is the whole cost, which is exactly backwards from what an
 * app would guess. `examples/tree.tsx` puts them in a `useMemo`.
 */
export interface TreeAccessors<T> {
  /** Defaults to `item.id`. */
  getId?: (item: T) => TreeItemId;
  /** Defaults to `item.label`, and then to the id, so a tree of bare ids
   *  still shows something. */
  getLabel?: (item: T) => ReactNode;
  /**
   * The text type-ahead matches on. Defaults to the label when the label is
   * a string, and to `''` when it is not.
   *
   * The seam exists because a rendered label is the one thing a component
   * cannot read back: a row drawn as an icon plus a `<text>` is a React
   * element, `String()` of it is `[object Object]`, and a tree whose keyboard
   * search silently stopped working is a bug nobody reports.
   */
  getText?: (item: T) => string;
  /** Defaults to `item.children`. `undefined` means "not loaded", which is
   *  not the same as `[]` — see {@link isBranch}. */
  getChildren?: (item: T) => readonly T[] | undefined;
  /**
   * Is this a branch at all? Defaults to "its children are an array, or it
   * said `branch: true`".
   *
   * The distinction matters for lazy loading: a directory nobody has read is
   * a branch with no children, and it must draw a twisty anyway or there is
   * nothing to click to find out what is in it.
   */
  isBranch?: (item: T) => boolean;
  /** Defaults to `item.disabled`. A disabled row is skipped by the keyboard
   *  and does not select, but is still shown and still opens. */
  isDisabled?: (item: T) => boolean;
}

/** The accessors with every default filled in — what the component and the
 *  functions below actually run on. */
export interface ResolvedAccessors<T> {
  getId: (item: T) => TreeItemId;
  getLabel: (item: T) => ReactNode;
  getText: (item: T) => string;
  getChildren: (item: T) => readonly T[] | undefined;
  isBranch: (item: T) => boolean;
  isDisabled: (item: T) => boolean;
}

/** The `TreeItem` fields, read off an item of unknown type. */
type DefaultItem = Partial<TreeItem>;

export function resolveAccessors<T>(
  accessors: TreeAccessors<T> | undefined,
): ResolvedAccessors<T> {
  const getId =
    accessors?.getId ?? ((item: T) => (item as DefaultItem).id as TreeItemId);
  const getChildren =
    accessors?.getChildren ??
    ((item: T) => (item as DefaultItem).children as readonly T[] | undefined);
  const getLabel =
    accessors?.getLabel ??
    ((item: T) => (item as DefaultItem).label ?? getId(item));
  return {
    getId,
    getLabel,
    getText:
      accessors?.getText ??
      ((item: T) => {
        const label = getLabel(item);
        return typeof label === 'string' || typeof label === 'number'
          ? String(label)
          : '';
      }),
    getChildren,
    isBranch:
      accessors?.isBranch ??
      ((item: T) =>
        Array.isArray(getChildren(item)) ||
        (item as DefaultItem).branch === true),
    isDisabled:
      accessors?.isDisabled ??
      ((item: T) => (item as DefaultItem).disabled === true),
  };
}

/**
 * One visible row.
 *
 * `parent` is the row object rather than the item, so walking to an ancestor
 * — which is what Left does, and what the branch guides read — costs no
 * lookup. That makes the array cyclic in the graph sense; nothing serializes
 * it, and the alternative (an index into the same array) is the same cycle
 * written less clearly.
 */
export interface TreeRow<T> {
  item: T;
  id: TreeItemId;
  /** 0 for a root. */
  depth: number;
  /** Can be opened — including a branch whose children are not loaded. */
  branch: boolean;
  /** Is open *now*. Always false for a leaf. */
  open: boolean;
  disabled: boolean;
  /** Position among **all** visible rows. What virtualization counts in, and
   *  what `aria-posinset` would be if a tree were a flat list, which it is
   *  not — see `posInSet`. */
  index: number;
  parent: TreeRow<T> | null;
  /** The last of its siblings — the row a `└─` guide belongs to. */
  last: boolean;
  /** 1-based position among its siblings, for `aria-posinset`. */
  posInSet: number;
  /** How many siblings it has, for `aria-setsize`. */
  setSize: number;
}

/**
 * The rows a tree can show right now: the roots, plus the children of every
 * expanded branch, in the order they are drawn.
 *
 * Iterative rather than recursive. A generated tree — a dependency graph, a
 * filesystem walked to the bottom — is deep enough often enough that a call
 * per level is a stack overflow waiting for one unlucky user, and the
 * explicit stack costs nothing to read.
 */
export function visibleRows<T>(
  items: readonly T[],
  open: ReadonlySet<TreeItemId>,
  accessors: ResolvedAccessors<T>,
): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  /** Siblings still to visit, innermost last — each with the parent they
   *  belong to and how far through them we are. */
  const stack: Array<{
    items: readonly T[];
    at: number;
    parent: TreeRow<T> | null;
  }> = [{ items, at: 0, parent: null }];

  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.at >= frame.items.length) {
      stack.pop();
      continue;
    }
    const item = frame.items[frame.at];
    const at = frame.at++;
    const id = accessors.getId(item);
    const branch = accessors.isBranch(item);
    const isOpen = branch && open.has(id);
    const row: TreeRow<T> = {
      item,
      id,
      depth: stack.length - 1,
      branch,
      open: isOpen,
      disabled: accessors.isDisabled(item),
      index: rows.length,
      parent: frame.parent,
      last: at === frame.items.length - 1,
      posInSet: at + 1,
      setSize: frame.items.length,
    };
    rows.push(row);
    if (isOpen) {
      const children = accessors.getChildren(item);
      // An open branch with nothing under it yet is not a bug: it is a
      // directory being read. It simply contributes no rows this frame.
      if (children?.length) stack.push({ items: children, at: 0, parent: row });
    }
  }
  return rows;
}

/**
 * The item with this id, wherever it is — including inside branches nobody
 * has opened.
 *
 * What `TreeHandle.setExpanded` needs: the change it reports carries the item,
 * and the id it is given may well name something no row is showing. A lazy
 * load finishing under a branch the user collapsed again is exactly that, and
 * it is a legitimate thing to expand.
 *
 * Searches only what is loaded, which is all there is to search.
 */
export function findItem<T>(
  items: readonly T[],
  id: TreeItemId,
  accessors: ResolvedAccessors<T>,
): T | undefined {
  const stack: Array<readonly T[]> = [items];
  while (stack.length) {
    const level = stack.pop() as readonly T[];
    for (const item of level) {
      if (accessors.getId(item) === id) return item;
      const children = accessors.getChildren(item);
      if (children?.length) stack.push(children);
    }
  }
  return undefined;
}

/**
 * The branch edges to draw down a row's indent, outermost first.
 *
 * There is one entry per level of depth, and `true` means "a line passes
 * through this column".
 *
 * Column `k` is where the line joining the children of the ancestor at depth
 * `k` runs, so it passes this row when the row's own ancestor at depth `k+1`
 * still has a sibling below it. The last column — `depth - 1` — is therefore
 * the row's own, which is where a `├─` or `└─` connector goes, and it is the
 * row itself that decides whether the line continues past it.
 *
 * The consequence worth stating, because it is the one an implementation gets
 * backwards: a row deep inside the **last** child of a branch has a *blank*
 * column above that branch, even though the branch's own parent has plenty of
 * siblings left. The line stops at the last child; nothing below it is joined
 * to anything.
 *
 * Computed on demand rather than stored on the row, because it is only ever
 * asked for the handful of rows actually on screen while a row may be one of
 * a hundred thousand.
 */
export function branchEdges(row: TreeRow<unknown>): boolean[] {
  const edges = new Array<boolean>(row.depth);
  // Walk up from the row itself: at each column the question is about the
  // ancestor one level *deeper* than the column, and the row is its own.
  let below: TreeRow<unknown> | null = row;
  for (let level = row.depth - 1; level >= 0; level--) {
    edges[level] = below ? !below.last : false;
    below = below?.parent ?? null;
  }
  return edges;
}

/** A run of rows that share a parent — what `layout="nested"` wraps in a
 *  subtree container. */
export interface TreeGroup<T> {
  /** The row the group hangs off; `null` for the roots. */
  parent: TreeRow<T> | null;
  rows: Array<TreeRow<T> | TreeGroup<T>>;
}

/** Tell a group from a row without a `kind` field on either. */
export function isGroup<T>(
  node: TreeRow<T> | TreeGroup<T>,
): node is TreeGroup<T> {
  return Array.isArray((node as TreeGroup<T>).rows);
}

/**
 * The same rows, nested again: each expanded branch's children collected
 * into a group that `renderSubtree` can wrap.
 *
 * Rebuilt from the flat list rather than from the items, so the two layouts
 * cannot disagree about depth, order, or which row is last — the flat pass is
 * the single answer and this is a regrouping of it.
 */
export function groupRows<T>(rows: readonly TreeRow<T>[]): TreeGroup<T> {
  const root: TreeGroup<T> = { parent: null, rows: [] };
  /** The open group per depth: `stack[d]` collects the rows at depth `d`. */
  const stack: Array<TreeGroup<T>> = [root];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Rows arrive in draw order, so a shallower row closes every group
    // deeper than it.
    stack.length = row.depth + 1;
    const group = stack[row.depth];
    group.rows.push(row);
    // A group is opened only when a deeper row actually follows. An expanded
    // branch that is still loading has no children to hold, and an empty
    // container would still paint whatever `renderSubtree` gives it.
    if (row.open && rows[i + 1]?.depth === row.depth + 1) {
      const child: TreeGroup<T> = { parent: row, rows: [] };
      group.rows.push(child);
      stack.push(child);
    }
  }
  return root;
}
