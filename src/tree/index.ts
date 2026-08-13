// <Tree> — a disclosure tree: file browsers, outline panes, property
// inspectors, anything with a twisty.
//
// This is a **successor to react-x11's own `<Tree>`, not a wrapper around
// it**. Core's is being retired, so nothing here imports it and the two share
// no code. What is kept is the behaviour a user has already learnt — the
// keyboard map, type-ahead, the twisty being its own hit target — because
// that is the part it would be rude to change.
//
// Three things it has that core's does not, and they are the reason it lives
// out here rather than in core:
//
//  1. **It reads the app's own data.** `getId` / `getChildren` / `isBranch`
//     and friends mean a filesystem listing, an AST or a normalized store is
//     rendered where it lies, instead of being copied into a shape this
//     component preferred. The defaults describe `{ id, label, children }`,
//     so a tree that has that shape configures nothing.
//  2. **It virtualizes.** Past a couple of hundred visible rows it builds
//     only the slice on screen, the way `Table` does, and the rest of the
//     list is two spacer boxes so the scrollbar still measures the whole
//     tree. That is what "very large number of elements" costs: nothing.
//  3. **Every visible part is a seam.** The twisty, the branch edge down the
//     indent, the label, the row's contents and — in `layout="nested"` — the
//     subtree container are each a render prop with a style override beside
//     it. The default look is deliberately plain: a chevron, no branch lines,
//     just indentation.
//
// Nothing here registers a host element. A tree is `<box>`, `<text>` and
// core's chevron, so there is no `registerElement` call, no JSX augmentation
// and no side effect at import time at all.
import React, {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { createStyles } from 'react-x11/style';
import type { StyleProp } from 'react-x11';
import { Icon, useDirection, useTheme } from 'react-x11';
import type { DrawnNode, KeyboardEvent, ScrollableNode } from 'react-x11';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';

import { hx } from './hx.js';
import type { Host } from './hx.js';
import { typeAheadChar, useTypeAhead } from './internal.js';
import {
  branchEdges,
  findItem,
  groupRows,
  isGroup,
  resolveAccessors,
  visibleRows,
} from './rows.js';
import type {
  ResolvedAccessors,
  TreeAccessors,
  TreeGroup,
  TreeItem,
  TreeItemId,
  TreeRow,
} from './rows.js';

// The row model comes out too: it is what the seams are handed, and an app
// that drives a tree from outside — "reveal this path", "how many rows is
// that" — does the same arithmetic. `resolveAccessors` is part of it rather
// than an internal, because `visibleRows` takes accessors with every default
// already filled in and there is no other way to make a set.
export type {
  ResolvedAccessors,
  TreeAccessors,
  TreeItem,
  TreeItemId,
  TreeRow,
  TreeGroup,
} from './rows.js';
export {
  branchEdges,
  findItem,
  resolveAccessors,
  visibleRows,
} from './rows.js';

/** One level of indent. */
const INDENT = 14;
/** The twisty's hit box — what a file browser lets you click to peek into a
 *  folder without selecting it. It stays this wide whatever the glyph does. */
const TWISTY = 12;
/** The chevron inside it. A chevron's long axis is its box and its short one
 *  is half of that, so `size` for one reads as its width. */
const TWISTY_GLYPH = 10;
const ROW_HEIGHT = 22;
/** Rows kept either side of the viewport, so a fast scroll does not show a
 *  gap before the next frame catches up. */
const OVERSCAN = 6;
/**
 * What to build before the viewport has been measured. `onViewport` cannot
 * arrive until layout has run, which is a frame after the first commit, so
 * there is always one render that has to guess — and guessing "all of them"
 * puts a hundred thousand rows in the tree for a frame.
 */
const ASSUMED_ROWS = 40;
/**
 * Where `virtual="auto"` starts virtualizing.
 *
 * Well above any viewport, so a tree that is merely long is still built whole
 * and keeps the two things virtualization costs: a row may be any height, and
 * every row is in the accessibility tree. Well below the point where building
 * every row is felt.
 */
const VIRTUAL_THRESHOLD = 200;

const s = createStyles({
  root: { flexGrow: 1, minHeight: 0, overflow: 'scroll' },
  row: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingEnd: 8,
    cursor: 'pointer',
    transition: { backgroundColor: 80 },
    // A row is exactly `rowHeight` tall — virtualization counts on it — so
    // anything that did not fit is clipped here rather than drawn over the
    // row below. The label already refuses to wrap; this is what stops a
    // `renderLabel` that does not know the rule from painting outside.
    overflow: 'hidden',
  },
  twisty: {
    width: TWISTY,
    height: TWISTY,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guide: { flexShrink: 0, alignSelf: 'stretch' },
  /**
   * A label is one line, and a long one is clipped rather than wrapped.
   *
   * `textWrap: 'nowrap'` is the load-bearing half. Without it a name too long
   * for the panel wraps to two lines inside a box that is `rowHeight` tall,
   * and the second line is drawn straight over the row below — the whole
   * column ends up illegible, and the row geometry virtualization and the
   * keyboard are measured in stays right while the pixels are wrong. Same
   * call core's `Table` makes about a cell.
   *
   * `textBoxTrim` makes the box the letters rather than the font's ascent and
   * descent, so a label centres on what can be seen. That is what core's
   * `labelContent` gives every label in the widget set.
   */
  label: {
    flexShrink: 1,
    minWidth: 0,
    textWrap: 'nowrap',
    textBoxTrim: 'cap-alphabetic',
  },
  subtree: { flexShrink: 0 },
  spacer: { flexShrink: 0 },
});

// --- what the seams are told -----------------------------------------------

/** A row, plus what only the render knows about it. */
export interface TreeRowState<T> extends TreeRow<T> {
  selected: boolean;
  /**
   * The ink the row is painted in.
   *
   * Handed over by name because **colour does not cascade into a drawing**:
   * an `<Icon>` or a `<canvas mono>` takes its colour from its own style, so
   * a glyph that has to stay legible on a selected row has to be told. The
   * `<text>` in the default label needs nothing — text does inherit.
   */
  color: string;
  /** Open or close this row's branch. Ignored on a leaf. */
  toggle: (open?: boolean) => void;
  /** Make this row the selection, as a click would. */
  select: () => void;
}

/** What `renderToggle` is told. */
export interface TreeToggleState<T> extends TreeRowState<T> {
  /** The size the default chevron is drawn at. */
  size: number;
}

/**
 * One column of a row's indent, as `renderGuide` sees it — the tree's branch
 * edge.
 *
 * There is one call per level of depth, outermost first. `own` marks the
 * row's own column, where a `├─` or `└─` connector goes; every earlier column
 * belongs to an ancestor and only ever carries a `│`.
 */
export interface TreeGuideState<T> {
  row: TreeRowState<T>;
  /** 0 is the outermost column. */
  level: number;
  /** A line passes through this column and continues below this row. */
  continues: boolean;
  /** This is the row's own column rather than an ancestor's. */
  own: boolean;
  /** The column's box: `indent` wide, `rowHeight` tall. */
  width: number;
  height: number;
}

/** What `renderSubtree` is told, in `layout="nested"`. */
export interface TreeSubtreeState<T> {
  /** The row the subtree hangs off. Never null: the roots are not a
   *  subtree, they are the tree. */
  parent: TreeRow<T>;
  /** The depth of the rows inside it — one more than `parent.depth`. */
  depth: number;
}

/** The expansion that just changed, alongside the whole set. */
export interface TreeExpandChange<T> {
  id: TreeItemId;
  item: T;
  open: boolean;
}

/** The style overrides, one per part the tree draws. */
export interface TreeStyles<T> {
  /** A function is called per rendered row, so a style can follow the row's
   *  own state without a `renderContent` that repaints everything. */
  row?: StyleProp | ((state: TreeRowState<T>) => StyleProp);
  toggle?: StyleProp;
  guide?: StyleProp | ((state: TreeGuideState<T>) => StyleProp);
  label?: StyleProp;
  subtree?: StyleProp;
}

/**
 * A `<Tree>`'s imperative side.
 *
 * `handleKey` is the one worth knowing about: a filter box above a tree holds
 * the keyboard, and forwarding the arrows to this is how the list below it
 * still walks. It reports whether the tree took the key, so the caller keeps
 * whatever it did not.
 */
export interface TreeHandle<T = TreeItem> {
  focus: () => void;
  select: (id: TreeItemId | null) => void;
  /** Open or close a branch by id, anywhere in the tree — including one no
   *  row is showing. `false` when the id names nothing loaded. */
  setExpanded: (id: TreeItemId, open?: boolean) => boolean;
  /** Bring a row into view, expanding nothing — a collapsed ancestor means
   *  there is no row to scroll to, and this reports `false`. */
  scrollToItem: (id: TreeItemId) => boolean;
  handleKey: (ev: KeyboardEvent) => boolean;
  /** The rows on screen right now, in draw order. */
  rows: () => readonly TreeRow<T>[];
}

type BoxProps = Host['box'];

export interface TreeProps<T = TreeItem>
  extends
    TreeAccessors<T>,
    Omit<BoxProps, 'style' | 'children' | 'ref' | 'onKeyDown'> {
  /** The roots. */
  items?: readonly T[];

  /** Controlled expansion. */
  expanded?: readonly TreeItemId[];
  defaultExpanded?: readonly TreeItemId[];
  /**
   * The whole open set, plus the one row that changed — which is what lazy
   * loading needs: `change.open && !loaded.has(change.id)` is the fetch.
   */
  onExpandedChange?: (
    expanded: TreeItemId[],
    change: TreeExpandChange<T>,
  ) => void;

  /** Controlled selection. One row: see the note on multiple selection in
   *  the component's doc comment. */
  selected?: TreeItemId | null;
  defaultSelected?: TreeItemId | null;
  onSelect?: (id: TreeItemId, item: T) => void;
  /** The *open* gesture on top of selection — a double click, Enter, or
   *  Space. On a branch it also toggles. */
  onActivate?: (id: TreeItemId, item: T) => void;

  /** One level of indent, in pixels. `0` puts the whole indent in
   *  `renderSubtree`'s hands instead. */
  indent?: number;
  /** Every row is this tall. Virtualization is arithmetic over it, so a tree
   *  with rows of different heights must say `virtual={false}`. */
  rowHeight?: number;

  /**
   * Build only the rows on screen. `'auto'` (the default) turns it on past
   * {@link VIRTUAL_THRESHOLD} visible rows.
   *
   * Not available in `layout="nested"`, where the rows are not siblings and
   * a slice of them is not a subtree.
   */
  virtual?: boolean | 'auto';
  /** Rows built either side of the viewport. */
  overscan?: number;

  /**
   * `'flat'` (the default) makes every row a sibling — which is what lets the
   * tree virtualize, and what the branch guides are drawn per row for.
   *
   * `'nested'` puts each expanded branch's rows inside a container of their
   * own, for a `renderSubtree` that wants to draw a background, a rule down
   * the group, or its own indent. Rows carry their own indent in both, so a
   * subtree container that indents as well should pass `indent={0}`.
   */
  layout?: 'flat' | 'nested';

  /** The open/close control, inside its hit box. */
  renderToggle?: (state: TreeToggleState<T>) => ReactNode;
  /** One column of the indent — the branch edge. Nothing by default. */
  renderGuide?: (state: TreeGuideState<T>) => ReactNode;
  /** The label cell. An icon in front of the text goes here. */
  renderLabel?: (state: TreeRowState<T>) => ReactNode;
  /**
   * Everything inside the row box, given what would have been there.
   *
   * The row *box* stays this component's — it carries the height
   * virtualization counts on, the role and the aria the tree is read through,
   * and the click that selects. Style it with `styles.row`.
   */
  renderContent?: (state: TreeRowState<T>, content: ReactNode[]) => ReactNode;
  /** The subtree container, in `layout="nested"`. */
  renderSubtree?: (state: TreeSubtreeState<T>, rows: ReactNode) => ReactNode;

  styles?: TreeStyles<T>;
  style?: StyleProp;
  ref?: Ref<TreeHandle<T>>;
  /** react-x11's queries read this off `props` at run time; its element
   *  declarations do not carry it, so it is declared here and reaches the
   *  root box through the rest spread. */
  'data-testname'?: string;
}

/** A string or a number becomes a `<text>`; anything else is already a
 *  node. */
function labelNode(label: ReactNode, style: StyleProp): ReactNode {
  return typeof label === 'string' || typeof label === 'number'
    ? hx('text', { key: 'label', style }, String(label))
    : label;
}

/**
 * `<Tree items />` — a disclosure tree.
 *
 *     <Tree items={[{ id: 'src', label: 'src', children: [...] }]} />
 *
 * An item with a `children` array is a branch, **even when the array is
 * empty** — that is how a directory shows a twisty before anything has read
 * it. A branch whose children are not loaded at all says `branch: true`, and
 * fills them in from `onExpandedChange`.
 *
 * Expansion and selection are each controlled (`expanded` + `onExpandedChange`,
 * `selected` + `onSelect`) or uncontrolled (`defaultExpanded`,
 * `defaultSelected`).
 *
 * The tree is a single tab stop. Up/Down walk the visible rows, Right expands
 * a branch and then steps into it, Left collapses and then steps out to the
 * parent, PageUp/PageDown move by a viewport, Home/End jump to the ends,
 * Enter and Space activate, and typing letters jumps to a matching row — the
 * same type-ahead core's `Select` and menus use.
 *
 * **The focus is on the tree, not on the row.** Core's tree focused each row
 * node; a virtualized row is unmounted the moment it scrolls out of view and
 * the focus would go with it, so the container is the focusable thing and the
 * selection is the cursor. That is `Table`'s model, and the honest caveat is
 * the one `Table` carries: while virtualizing, only the rendered rows are in
 * the accessibility tree — the same rows a sighted user can see.
 *
 * **Selection is one row.** Multiple selection is not a prop because there is
 * no version of it everybody agrees on (does Shift extend from the anchor or
 * from the cursor? does Ctrl+click on a branch take its children?), and every
 * such policy is expressible on top of what is here: hold the set yourself,
 * pass `selected` for the cursor, and paint the rest from `styles.row`.
 */
export function Tree<T = TreeItem>({
  items = [],
  expanded,
  defaultExpanded,
  onExpandedChange,
  selected,
  defaultSelected,
  onSelect,
  onActivate,
  indent = INDENT,
  rowHeight = ROW_HEIGHT,
  virtual = 'auto',
  overscan = OVERSCAN,
  layout = 'flat',
  renderToggle,
  renderGuide,
  renderLabel,
  renderContent,
  renderSubtree,
  styles,
  style,
  ref,
  // the accessors, pulled out so the rest can be spread onto the box
  getId,
  getLabel,
  getText,
  getChildren,
  isBranch,
  isDisabled,
  // ours to chain rather than to hand over: virtualization is measured
  // through both of these
  onScroll,
  onViewport,
  ...boxProps
}: TreeProps<T>): ReactElement {
  const theme = useTheme();
  const rtl = useDirection() === 'rtl';
  const [ownExpanded, setOwnExpanded] = useState<ReadonlySet<TreeItemId>>(
    () => new Set(defaultExpanded),
  );
  const [ownSelected, setOwnSelected] = useState<TreeItemId | null>(
    defaultSelected ?? null,
  );
  const [view, setView] = useState({ top: 0, height: 0 });
  const typeAhead = useTypeAhead();
  const scroller = useRef<ScrollableNode | null>(null);
  const rowNodes = useRef(new Map<TreeItemId, DrawnNode>());

  const accessors: ResolvedAccessors<T> = useMemo(
    () =>
      resolveAccessors<T>({
        getId,
        getLabel,
        getText,
        getChildren,
        isBranch,
        isDisabled,
      }),
    [getId, getLabel, getText, getChildren, isBranch, isDisabled],
  );

  const openSet = useMemo(
    () => (expanded ? new Set(expanded) : ownExpanded),
    [expanded, ownExpanded],
  );
  const current = selected === undefined ? ownSelected : selected;
  const rows = useMemo(
    () => visibleRows(items, openSet, accessors),
    [items, openSet, accessors],
  );

  // Held-down or fast keys arrive in a burst, and every handler in that burst
  // sees the render it started from — so what is open and what is selected
  // are mirrored here and updated the moment they change, or three Downs in a
  // row all step off the same starting point.
  const openRef = useRef(openSet);
  openRef.current = openSet;
  const currentRef = useRef(current);
  currentRef.current = current;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const viewRef = useRef(view);
  viewRef.current = view;

  const virtualizing =
    layout === 'flat' &&
    (virtual === true ||
      (virtual === 'auto' && rows.length > VIRTUAL_THRESHOLD));

  // The slice worth building: what is on screen, plus a little either side.
  const first = virtualizing
    ? Math.max(0, Math.floor(view.top / rowHeight) - overscan)
    : 0;
  const count = virtualizing
    ? view.height > 0
      ? Math.ceil(view.height / rowHeight) + overscan * 2
      : ASSUMED_ROWS
    : rows.length;
  const last = Math.min(rows.length, first + count);

  const setExpandedSet = useCallback(
    (next: ReadonlySet<TreeItemId>, change: TreeExpandChange<T>): void => {
      openRef.current = next;
      if (expanded === undefined) setOwnExpanded(next);
      onExpandedChange?.([...next], change);
    },
    [expanded, onExpandedChange],
  );

  const toggleId = useCallback(
    (id: TreeItemId, item: T, open?: boolean): void => {
      const next = new Set(openRef.current);
      const shouldOpen = open ?? !next.has(id);
      if (shouldOpen) next.add(id);
      else next.delete(id);
      setExpandedSet(next, { id, item, open: shouldOpen });
    },
    [setExpandedSet],
  );

  /**
   * Put a row in view.
   *
   * A mounted row can say where it is, and `scrollIntoView` then works
   * whatever height it turned out to be — which is what a tree that is *not*
   * virtualizing wants, since its rows may be anything. A row that is not
   * mounted has no geometry to ask about, and while virtualizing that is the
   * normal case, so the offset is computed from the index instead. The two
   * agree because virtualization already assumes every row is `rowHeight`.
   */
  const reveal = useCallback(
    (index: number): void => {
      const box = scroller.current;
      const row = rowsRef.current[index];
      if (!box || !row) return;
      const node = rowNodes.current.get(row.id);
      if (node) {
        box.scrollIntoView(node);
        return;
      }
      const top = index * rowHeight;
      const height = viewRef.current.height;
      if (top < box.scrollY) box.scrollTo({ y: top });
      else if (height > 0 && top + rowHeight > box.scrollY + height) {
        box.scrollTo({ y: top + rowHeight - height });
      }
    },
    [rowHeight],
  );

  const goTo = useCallback(
    (row: TreeRow<T> | null | undefined): void => {
      if (!row) return;
      currentRef.current = row.id;
      if (selected === undefined) setOwnSelected(row.id);
      onSelect?.(row.id, row.item);
      reveal(row.index);
    },
    [selected, onSelect, reveal],
  );

  const activate = useCallback(
    (row: TreeRow<T>): void => {
      if (row.branch) toggleId(row.id, row.item);
      onActivate?.(row.id, row.item);
    },
    [toggleId, onActivate],
  );

  /** Returns whether the key was the tree's, so a control that forwards its
   *  keys here keeps the ones it did not use. */
  const handleKey = useCallback(
    (ev: KeyboardEvent): boolean => {
      const rows = rowsRef.current;
      if (!rows.length) return false;
      const index = rows.findIndex((r) => r.id === currentRef.current);
      const row = rows[index];
      const step = (delta: number): TreeRow<T> | null => {
        for (let i = index + delta; i >= 0 && i < rows.length; i += delta) {
          if (!rows[i].disabled) return rows[i];
        }
        return null;
      };
      /** The nearest enabled row at or before `to`, walking `dir` if the
       *  landing row is disabled — what a page jump needs. */
      const nearest = (to: number, dir: number): TreeRow<T> | null => {
        const at = Math.max(0, Math.min(rows.length - 1, to));
        for (let i = at; i >= 0 && i < rows.length; i += dir) {
          if (!rows[i].disabled) return rows[i];
        }
        return null;
      };
      // Deeper is the direction the indent grows in, which is the direction
      // the text runs — so it is Left that opens a branch in a mirrored tree,
      // and the two arrows swap wholesale rather than the tree growing a
      // second set of cases.
      const deeper = rtl ? XK_LEFT : XK_RIGHT;
      const shallower = rtl ? XK_RIGHT : XK_LEFT;
      const page = Math.max(
        1,
        Math.floor(viewRef.current.height / rowHeight) - 1,
      );

      switch (ev.keysym) {
        case XK_UP:
          goTo(step(-1));
          return true;
        case XK_DOWN:
          goTo(step(1));
          return true;
        case XK_PAGE_UP:
          goTo(nearest(index < 0 ? 0 : index - page, 1));
          return true;
        case XK_PAGE_DOWN:
          goTo(nearest(index < 0 ? page : index + page, -1));
          return true;
        case deeper:
          // open it, then walk into it — one key does both, in order
          if (row?.branch && !row.open) toggleId(row.id, row.item, true);
          else if (row?.branch) goTo(step(1));
          return true;
        case shallower:
          if (row?.branch && row.open) toggleId(row.id, row.item, false);
          else if (row?.parent) goTo(row.parent);
          return true;
        case XK_HOME:
          goTo(rows.find((r) => !r.disabled));
          return true;
        case XK_END:
          goTo([...rows].reverse().find((r) => !r.disabled));
          return true;
        case XK_RETURN:
          if (row) activate(row);
          return true;
        default:
          break;
      }
      if (ev.codepoint === 32) {
        if (row) activate(row);
        return true;
      }
      const char = typeAheadChar(ev);
      if (!char) return false;
      const found = typeAhead(
        char,
        rows,
        index < 0 ? null : index,
        (r: TreeRow<T>) => accessors.getText(r.item),
        (r: TreeRow<T>) => !r.disabled,
      );
      if (found >= 0) goTo(rows[found]);
      return found >= 0;
    },
    [rtl, rowHeight, goTo, toggleId, activate, typeAhead, accessors],
  );

  useImperativeHandle(
    ref,
    (): TreeHandle<T> => ({
      focus: () => {
        scroller.current?.focus();
      },
      select: (id) => {
        const row = rowsRef.current.find((r) => r.id === id);
        if (row) goTo(row);
        else if (id === null) {
          currentRef.current = null;
          if (selected === undefined) setOwnSelected(null);
        }
      },
      setExpanded: (id, open) => {
        // An id nobody can see is still legitimately expandable — a lazy load
        // finishing under a branch the user collapsed again, say — so the
        // whole tree is searched rather than the rows on screen.
        //
        // An id that is in neither is a no-op, and that is the point: the
        // change this reports carries the item, `TreeExpandChange<T>.item` is
        // `T`, and an id nothing answers to has no item to put there. Doing
        // nothing beats reporting an expansion of `undefined`.
        const item =
          rowsRef.current.find((r) => r.id === id)?.item ??
          findItem(itemsRef.current, id, accessors);
        if (item === undefined) return false;
        toggleId(id, item, open);
        return true;
      },
      scrollToItem: (id) => {
        const row = rowsRef.current.find((r) => r.id === id);
        if (!row) return false;
        reveal(row.index);
        return true;
      },
      handleKey,
      rows: () => rowsRef.current,
    }),
    [goTo, toggleId, reveal, handleKey, selected, accessors],
  );

  // --- rendering -----------------------------------------------------------

  const rowStyleProp = styles?.row;
  const guideStyleProp = styles?.guide;

  const renderOneRow = (row: TreeRow<T>): ReactElement => {
    const isSelected = row.id === current;
    const color = row.disabled
      ? theme.dim
      : isSelected
        ? theme.hoverText
        : theme.text;
    const state: TreeRowState<T> = {
      ...row,
      selected: isSelected,
      color,
      toggle: (open?: boolean) => toggleId(row.id, row.item, open),
      select: () => goTo(row),
    };

    const content: ReactNode[] = [];

    // The indent. With no guide seam it is one padding value rather than
    // `depth` empty boxes — a tree ten deep would otherwise build ten nodes
    // per row to draw nothing.
    if (renderGuide && row.depth > 0) {
      const edges = branchEdges(row);
      for (let level = 0; level < row.depth; level++) {
        const guide: TreeGuideState<T> = {
          row: state,
          level,
          continues: edges[level],
          own: level === row.depth - 1,
          width: indent,
          height: rowHeight,
        };
        content.push(
          hx(
            'box',
            {
              key: `guide${level}`,
              style: [
                s.guide,
                { width: indent },
                typeof guideStyleProp === 'function'
                  ? guideStyleProp(guide)
                  : guideStyleProp,
              ],
            },
            renderGuide(guide),
          ),
        );
      }
    }

    const toggleState: TreeToggleState<T> = { ...state, size: TWISTY_GLYPH };
    content.push(
      hx(
        'box',
        {
          key: 'toggle',
          style: [s.twisty, styles?.toggle],
          // The twisty is its own hit target: clicking it opens the branch
          // without moving the selection, the way a file browser lets you
          // peek inside a folder you have not chosen.
          onClick: row.branch
            ? (ev) => {
                ev.stopPropagation();
                toggleId(row.id, row.item);
              }
            : undefined,
        },
        renderToggle
          ? renderToggle(toggleState)
          : row.branch
            ? React.createElement(Icon, {
                name: row.open
                  ? 'chevronDown'
                  : rtl
                    ? 'chevronLeft'
                    : 'chevronRight',
                size: TWISTY_GLYPH,
                // dimmer than the label on a resting row, and the row's own
                // ink once it is selected
                style: isSelected ? undefined : { color: theme.dim },
              })
            : null,
      ),
    );

    content.push(
      renderLabel
        ? // Keyed here rather than by the app, for the reason `renderSubtree`
          // is: the label sits in an array beside the guides and the twisty,
          // and "add a key to the box you return" is not something a render
          // prop should have to know.
          React.createElement(
            React.Fragment,
            { key: 'label' },
            renderLabel(state),
          )
        : labelNode(accessors.getLabel(row.item), [s.label, styles?.label]),
    );

    return hx(
      'box',
      {
        key: String(row.id),
        role: 'treeitem',
        'aria-level': row.depth + 1,
        'aria-selected': isSelected,
        'aria-expanded': row.branch ? row.open : undefined,
        'aria-posinset': row.posInSet,
        'aria-setsize': row.setSize,
        // `disabled` rather than `aria-disabled`: on a react-x11 node it is
        // the real thing — it clears the AT-SPI ENABLED/SENSITIVE states and
        // selects the `:disabled` style block — and there is no aria spelling
        // of it to write instead.
        disabled: row.disabled || undefined,
        ref: (node: DrawnNode | null) => {
          if (node) rowNodes.current.set(row.id, node);
          else rowNodes.current.delete(row.id);
        },
        onClick: (ev) => {
          if (row.disabled) return;
          goTo(row);
          // Select on the first click, open on the second — the gesture every
          // file list has. `detail` is the click count the renderer already
          // counts for text selection.
          if (ev.detail === 2) activate(row);
        },
        style: [
          s.row,
          { height: rowHeight },
          // The indent is what says "inside", so it is measured from the edge
          // the row's label begins at.
          { paddingStart: renderGuide ? 4 : 4 + row.depth * indent },
          {
            backgroundColor: isSelected ? theme.hoverBackground : 'transparent',
            // The row's ink, said once: `color` inherits, so the label takes
            // it without being handed it.
            color,
          },
          !row.disabled && {
            ':hover': {
              backgroundColor: isSelected
                ? theme.hoverBackground
                : theme.surfaceHover,
            },
            // The selection only moves on the release, and `:active` marks
            // the whole press chain, so a press on the label or the twisty
            // still darkens the row it is in.
            ':active': {
              backgroundColor: isSelected
                ? theme.accentActive
                : theme.surfaceActive,
            },
          },
          typeof rowStyleProp === 'function'
            ? rowStyleProp(state)
            : rowStyleProp,
        ],
      },
      renderContent ? renderContent(state, content) : content,
    );
  };

  /** `layout="nested"`: the same rows, wrapped group by group. */
  const renderGroup = (group: TreeGroup<T>, key: string): ReactNode => {
    const children = group.rows.map((node, i) =>
      isGroup(node) ? renderGroup(node, `${key}.${i}`) : renderOneRow(node),
    );
    if (!group.parent) return children;
    const state: TreeSubtreeState<T> = {
      parent: group.parent,
      depth: group.parent.depth + 1,
    };
    // The key is this component's either way, and a fragment is how a seam
    // gets one without being told to write it. A `renderSubtree` that had to
    // remember a key would get it wrong the obvious way — keying on the
    // parent id, which is already the key of the parent *row* beside it.
    if (renderSubtree) {
      return React.createElement(
        React.Fragment,
        { key: `subtree:${group.parent.id}` },
        renderSubtree(state, children),
      );
    }
    return hx(
      'box',
      {
        key: `subtree:${group.parent.id}`,
        role: 'group',
        style: [s.subtree, styles?.subtree],
      },
      children,
    );
  };

  const body: ReactNode[] = [];
  if (layout === 'nested') {
    body.push(renderGroup(groupRows(rows), 'root'));
  } else {
    if (virtualizing && first > 0) {
      body.push(
        hx('box', {
          key: 'spacer:before',
          style: [s.spacer, { height: first * rowHeight }],
        }),
      );
    }
    for (let i = first; i < last; i++) body.push(renderOneRow(rows[i]));
    if (virtualizing && last < rows.length) {
      body.push(
        hx('box', {
          key: 'spacer:after',
          style: [s.spacer, { height: (rows.length - last) * rowHeight }],
        }),
      );
    }
  }

  return hx(
    'box',
    {
      theme,
      role: 'tree',
      // The tree takes the focus, not the row — see the doc comment.
      focusable: true,
      ...boxProps,
      ref: scroller,
      style: [s.root, style],
      onKeyDown: handleKey,
      // Layout, not scrolling, is what first tells a list how much of it is
      // worth building — and it is also where a page key gets its distance,
      // so this is measured whether or not the tree virtualizes.
      onViewport: (ev) => {
        setView((prev) =>
          prev.height === ev.height ? prev : { ...prev, height: ev.height },
        );
        onViewport?.(ev);
      },
      onScroll: (ev) => {
        if (virtualizing) {
          setView((prev) =>
            prev.top === ev.scrollY ? prev : { ...prev, top: ev.scrollY },
          );
        }
        onScroll?.(ev);
      },
    },
    body,
  );
}
