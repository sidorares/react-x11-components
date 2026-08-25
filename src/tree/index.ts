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
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { createStyles } from 'react-x11/style';
import type { StyleProp } from 'react-x11';
import { Icon, useDirection, useTheme } from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent,
  ScrollableNode,
  Theme,
} from 'react-x11';
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
// Shared with <Table> — internal, deliberately not a shared *module*; the
// header of src/internal/heights.ts says why.
import { RowHeights } from '../internal/heights.js';
import {
  afterLayout,
  cancelAfterLayout,
  cancelLater,
  later,
} from '../internal/timers.js';
import type { DelayTick } from '../internal/timers.js';
import { useReveal } from '../internal/scroll.js';
import {
  BURST_BUDGET,
  DEFAULT_OVERSCAN,
  DEFAULT_PREFETCH,
  SCROLL_HINT_DELAY_MS,
  SKELETON_THRESHOLD,
  SETTLE_BUDGET,
  useVirtualWindow,
} from '../internal/window.js';
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
    paddingTop: 3,
    paddingBottom: 3,
    cursor: 'pointer',
    transition: { backgroundColor: 80 },
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
   * The label **wraps**, and the row grows to hold it.
   *
   * This is the whole point of rows being measured rather than fixed: a name
   * too long for the pane becomes two lines of a taller row, not two lines
   * drawn over the row below. An app that wants the one-line, clipped look a
   * file browser has says so — `styles={{ label: { textWrap: 'nowrap' } }}` —
   * and gets it for the whole tree.
   *
   * `textBoxTrim` makes the box the letters rather than the font's ascent and
   * descent, so a label centres on what can be seen. That is what core's
   * `labelContent` gives every label in the widget set.
   */
  label: {
    flexShrink: 1,
    minWidth: 0,
    textBoxTrim: 'cap-alphabetic',
  },
  subtree: { flexShrink: 0 },
  spacer: { flexShrink: 0 },
  /** The bar inside a skeleton row — a line of "text" with no text, so a
   *  band of placeholders reads as rows arriving rather than a void. */
  skeletonBar: {
    height: 8,
    borderRadius: 4,
    alignSelf: 'center',
    flexShrink: 0,
  },
  /** The box the scroll pane and the fast-scroll pill share — it exists so
   *  the pill can float *outside* the pane, where a scroll cannot move it. */
  outer: { flexGrow: 1, minHeight: 0 },
  /** The lane the fast-scroll pill floats in: absolute against the outer
   *  box so the pane scrolls under it, full-width so the pill centres
   *  itself, and transparent to the pointer so the rows beneath stay
   *  clickable. */
  scrollHintLane: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  scrollHint: {
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 5,
    paddingBottom: 5,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
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
  /** How wide the column is: the `indent` prop. */
  width: number;
  /** The row's **minimum** height — `rowHeight`. The column stretches to
   *  whatever the row turned out to be, and a drawing is told that real size
   *  in its own `onDraw`, so this is a hint rather than a measurement.
   *  A `<canvas cacheKey>` need not name it: the paint cache already keys on
   *  the node's laid-out size. */
  height: number;
}

/**
 * What `renderScrollHint` is told: where the viewport is, while a fast
 * scroll is still being caught up with. The top row itself is included so a
 * hint can show what is *at* this position rather than a number.
 */
export interface TreeScrollHintState<T> {
  /** The first row in view, in draw order. */
  row: TreeRow<T>;
  /** Its position, 1-based — "row `from` of `count`". */
  from: number;
  /** The last row in view, 1-based. */
  to: number;
  /** How many rows the tree is showing. */
  count: number;
  /** How many of the rows in view are still placeholders. */
  pending: number;
  /** When the viewport first stopped being whole, epoch ms — what the
   *  show-delay was measured against. `Date.now() - since` is how long the
   *  user has been looking at unresolved content. */
  since: number;
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
  /**
   * The **shortest** a row may be, in pixels. Default 22.
   *
   * A row is not this tall, it is at least this tall: it grows to whatever
   * its content needs, so a label that wraps to two lines gets a row of two
   * lines. Virtualization measures rows rather than assuming them, which is
   * what makes that safe — see {@link estimatedRowHeight}.
   */
  rowHeight?: number;
  /**
   * What a row that has not been measured yet is assumed to be, while
   * virtualizing. Defaults to `rowHeight`.
   *
   * Only the rows on screen have ever been laid out, so the scrollbar is
   * this guess for everything else; it converges as you scroll, and once
   * enough rows have been measured the guess itself is re-learnt from their
   * mean. Set it when rows are typically much taller than `rowHeight` — a
   * tree of two-line rows with the default guess starts with a scrollbar
   * that thinks the tree is half its real length, until the re-learning
   * corrects it.
   */
  estimatedRowHeight?: number;

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
   * Rows built *beyond* the overscan while the tree sits idle, per side.
   * Default 40. The pane blits a scroll before React can run, so the only
   * scroll with no blank frame is one that lands on rows already built —
   * this band is that, grown in small steps while nobody is scrolling, and
   * kept behind the viewport so a reversal lands on rows still mounted.
   * `0` turns the band off: the slice is exactly viewport-plus-overscan.
   */
  prefetch?: number;

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
  /**
   * The fast-scroll overlay. Shown only while a scroll has outrun the rows
   * far enough that placeholders cover a meaningful part of the viewport —
   * a scroll the tree absorbs within a frame never shows it — and hidden
   * the moment the view is whole again. The default is a pill reading
   * "2,345 / 100,000"; return something else to replace it, or null for no
   * overlay at all.
   */
  renderScrollHint?: (state: TreeScrollHintState<T>) => ReactNode;
  /**
   * How long the viewport must have been showing unresolved content before
   * the overlay appears, in milliseconds. Default 250: a catch-up the next
   * few frames absorb is never announced. `0` shows it the moment a
   * catch-up engages.
   */
  scrollHintDelay?: number;
  /**
   * Tuning for the catch-up pacing — how a scroll that outruns the built
   * rows is absorbed. All optional, all in rows: `threshold` (default 16)
   * is how many rows entering in one render count as a flood, `burst`
   * (default 24) and `settle` (default 48) are the full rows built per
   * render mid-scroll and after it. See the same prop on `<Table>`.
   */
  catchup?: { threshold?: number; burst?: number; settle?: number };

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
 * One row, as its own memoized component.
 *
 * The reason is the CPU profile of a fast scroll: every notch re-renders
 * the window, and re-creating a hundred rows' elements per notch — then
 * reconciling them and re-applying identical props to every node — was
 * over half the burst. Every prop here is identity-stable across a scroll
 * render (the row model is memoized, the accessors and handlers are stable
 * callbacks), so React bails out on the rows that did not change and a
 * notch pays only for the rows it brought in.
 */
interface TreeRowViewProps<T> {
  row: TreeRow<T>;
  isSelected: boolean;
  indent: number;
  rowHeight: number;
  rtl: boolean;
  theme: Theme;
  renderToggle?: (state: TreeToggleState<T>) => ReactNode;
  renderGuide?: (state: TreeGuideState<T>) => ReactNode;
  renderLabel?: (state: TreeRowState<T>) => ReactNode;
  renderContent?: (state: TreeRowState<T>, content: ReactNode[]) => ReactNode;
  rowStyle: TreeStyles<T>['row'];
  guideStyle: TreeStyles<T>['guide'];
  toggleStyle: StyleProp | undefined;
  labelStyle: StyleProp | undefined;
  getLabel: (item: T) => ReactNode;
  onToggle: (id: TreeItemId, item: T, open?: boolean) => void;
  onGo: (row: TreeRow<T>) => void;
  onOpen: (row: TreeRow<T>) => void;
  register: (id: TreeItemId, at: number, node: DrawnNode | null) => void;
}

function TreeRowView<T>(props: TreeRowViewProps<T>): ReactElement {
  const {
    row,
    isSelected,
    indent,
    rowHeight,
    rtl,
    theme,
    renderToggle,
    renderGuide,
    renderLabel,
    renderContent,
    rowStyle,
    guideStyle,
    toggleStyle,
    labelStyle,
    getLabel,
    onToggle,
    onGo,
    onOpen,
    register,
  } = props;
  const color = row.disabled
    ? theme.textMuted
    : isSelected
      ? theme.hoverText
      : theme.text;
  const state: TreeRowState<T> = {
    ...row,
    selected: isSelected,
    color,
    toggle: (open?: boolean) => onToggle(row.id, row.item, open),
    select: () => onGo(row),
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
              typeof guideStyle === 'function' ? guideStyle(guide) : guideStyle,
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
        style: [s.twisty, toggleStyle],
        // The twisty is its own hit target: clicking it opens the branch
        // without moving the selection, the way a file browser lets you
        // peek inside a folder you have not chosen.
        onClick: row.branch
          ? (ev) => {
              ev.stopPropagation();
              onToggle(row.id, row.item);
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
              style: isSelected ? undefined : { color: theme.textMuted },
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
      : labelNode(getLabel(row.item), [s.label, labelStyle]),
  );

  return hx(
    'box',
    {
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
      // The index the row was drawn at travels with the node, so measuring
      // does not have to search a hundred thousand rows for where it is.
      // It can go stale — the rows may move before the tick that measures —
      // and both this and the height index check it rather than trust it.
      ref: (node: DrawnNode | null) => {
        register(row.id, row.index, node);
      },
      onClick: (ev) => {
        if (row.disabled) return;
        onGo(row);
        // Select on the first click, open on the second — the gesture every
        // file list has. `detail` is the click count the renderer already
        // counts for text selection.
        if (ev.detail === 2) onOpen(row);
      },
      style: [
        s.row,
        // A floor, not a height. The row grows to whatever its content
        // needs — a wrapped label, two lines, a thumbnail — and the height
        // index reads back what it actually became.
        { minHeight: rowHeight },
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
        typeof rowStyle === 'function' ? rowStyle(state) : rowStyle,
      ],
    },
    renderContent ? renderContent(state, content) : content,
  );
}

const MemoTreeRow = React.memo(TreeRowView) as typeof TreeRowView;

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
  estimatedRowHeight,
  virtual = 'auto',
  overscan = DEFAULT_OVERSCAN,
  prefetch = DEFAULT_PREFETCH,
  layout = 'flat',
  renderToggle,
  renderGuide,
  renderLabel,
  renderContent,
  renderSubtree,
  renderScrollHint,
  scrollHintDelay = SCROLL_HINT_DELAY_MS,
  catchup,
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
  (globalThis as any).__renders = ((globalThis as any).__renders ?? 0) + 1;
  const theme = useTheme();
  const rtl = useDirection() === 'rtl';
  const [ownExpanded, setOwnExpanded] = useState<ReadonlySet<TreeItemId>>(
    () => new Set(defaultExpanded),
  );
  const [ownSelected, setOwnSelected] = useState<TreeItemId | null>(
    defaultSelected ?? null,
  );
  // Bumped by a measurement pass that found a row taller or shorter than the
  // index believed. It is the only reason the component re-renders for a
  // measurement, and a pass that finds nothing new does not bump it, which is
  // what makes measure → render → measure converge instead of spinning.
  const [, setMeasured] = useState(0);
  const typeAhead = useTypeAhead();
  const scroller = useRef<ScrollableNode | null>(null);
  /** The rows on screen, by id — with the index each was drawn at, so a
   *  measurement pass does not have to search the row list for it. */
  const rowNodes = useRef(
    new Map<TreeItemId, { node: DrawnNode; at: number }>(),
  );
  const estimate = estimatedRowHeight ?? rowHeight;
  // `useState` for its lazy initializer rather than `useRef`: one index per
  // mounted tree, built once. Nothing ever calls the setter — what it holds
  // is mutable and its changes are announced through `setMeasured`.
  const [heights] = useState(() => new RowHeights(estimate));

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

  const virtualizing =
    layout === 'flat' &&
    (virtual === true ||
      (virtual === 'auto' && rows.length > VIRTUAL_THRESHOLD));

  // The index is re-pointed at the rows about to be drawn before anything
  // asks it where they are. `rows` is memoized, so this is an identity check
  // on every render that did not change the tree.
  const index = heights;
  index.sync(rows, estimate);

  /** The viewport, and the slice worth building from it — the machinery
   *  shared with `<Table>` (`../internal/window.ts`). */
  const win = useVirtualWindow({
    box: scroller,
    heights,
    rows,
    // tree rows are always measured, so the idle band above the viewport
    // only re-builds territory already visited — see `exact` on the inputs
    exact: false,
    virtualizing,
    overscan,
    prefetch,
    threshold: catchup?.threshold ?? SKELETON_THRESHOLD,
    burstBudget: catchup?.burst ?? BURST_BUDGET,
    settleBudget: catchup?.settle ?? SETTLE_BUDGET,
  });
  const { view, viewRef } = win;
  /** Whether the fast-scroll pill is up — kept across renders so it does not
   *  flicker through a catch-up, only appearing and disappearing once. */
  const hintShown = useRef(false);
  const { first, last, above, below } = win.slice;

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
   * The scroll the tree owes a row, and the pane's real offset read back
   * after every layout — the two halves of `../internal/scroll.ts`, which
   * says why a reveal cannot be a one-shot and why `onScroll` is not the
   * whole story. A tree grows and shrinks under its own hands: opening a
   * branch is a content that got taller between the ask and the layout, in
   * exactly the way an arriving row is.
   */
  const reveal = useReveal({
    box: scroller,
    rows: rowsRef,
    nodes: rowNodes,
    heights,
  });

  /** Put a row in view, by the index its call site already has. */
  const revealAt = useCallback(
    (at: number): void => {
      const row = rowsRef.current[at];
      if (row) reveal.to(row.id);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `reveal` is a
      // stable handle
    },
    [reveal],
  );

  /** Re-read the offset the pane is *actually* at — the window's `sync`; see
   *  `../internal/window.ts` for why the pane moves silently. */
  const syncScroll = win.sync;

  /**
   * Read back what the rows on screen actually laid out at.
   *
   * The one thing that makes rows of different heights work, and the reason
   * it is not simply "read the height in an effect": **layout runs after
   * React's effects, on the frame flush**, so a `useEffect` sees the
   * *previous* pass's geometry — zero, on the render that created the row.
   * This runs a tick later, when `abs` is current.
   *
   * Idempotent by construction. A row whose measurement has not changed
   * reports no change, so the second pass over the same rows costs a map walk
   * and re-renders nothing, and measure → render → measure terminates.
   */
  const measureRows = useCallback((): boolean => {
    if (!virtualizing) return false;
    const box = scroller.current;
    const rows = rowsRef.current;
    const idx = heights;
    // Rows above the top of the viewport are the ones that move the content
    // under it, so their total change is what has to come back out of the
    // scroll offset — otherwise measuring a row you have already scrolled
    // past yanks the list under the pointer.
    const anchor = box ? idx.indexAt(box.scrollY) : 0;
    let shift = 0;
    let changed = false;
    for (const [id, { node, at }] of rowNodes.current) {
      if (rows[at]?.id !== id) continue; // drawn against a list that has moved
      const height = node.abs.height;
      const was = idx.heightAt(at);
      if (!idx.measure(id, at, height)) continue;
      changed = true;
      if (at < anchor) shift += height - was;
    }
    if (!changed) return false;
    // A debt, not a one-shot: the pane clamps against the last layout's
    // content height, so a shift from rows measured above the viewport can
    // land short until the layout that admits the growth has run.
    reveal.nudge(shift);
    setMeasured((n) => n + 1);
    return true;
  }, [virtualizing]);

  /**
   * Let the estimate learn from the rows that have been measured — the
   * scrollbar of a measured tree starts as a guess times the row count, and
   * the measured mean is a far better guess for the rows not yet seen. Idle
   * only: every unmeasured offset moves when it applies, and the anchor
   * arithmetic keeping the screen still is `measureRows`'s.
   */
  const adaptEstimate = useCallback((): boolean => {
    if (!virtualizing) return false;
    const box = scroller.current;
    if (!box) return false;
    const anchor = heights.indexAt(box.scrollY);
    const before = heights.offsetAt(anchor);
    if (!heights.adapt()) return false;
    reveal.nudge(heights.offsetAt(anchor) - before);
    setMeasured((n) => n + 1);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `heights` and
    // `reveal` are stable instances
  }, [virtualizing]);

  /**
   * The one tick after layout, and everything that can only be known there:
   * what the rows measured, whether an owed scroll can go further now that
   * the rows it was waiting for are laid out, and where the pane actually
   * ended up. In that order — each step can move the offset the next one
   * reads.
   */
  /** Whether some drawn row has no size yet — a commit can land between
   *  frame flushes, and a measure pass over it reads zeros. */
  const rowsPendingLayout = useCallback((): boolean => {
    const rows = rowsRef.current;
    for (const [id, { node, at }] of rowNodes.current) {
      if (rows[at]?.id === id && !(node.abs.height > 0)) return true;
    }
    return false;
  }, []);

  useEffect(() => {
    if (!virtualizing) return undefined;
    let look: DelayTick = null;
    let tries = 0;
    const pass = (): void => {
      (globalThis as any).__ticks = ((globalThis as any).__ticks ?? 0) + 1;
      // `measureRows` first, and its answer handed on: a pass that moved the
      // heights has not settled anything, and an owed scroll judged against
      // the layout it is about to invalidate is not owed any less. During a
      // flick nothing is measured at all — every correction at that speed is
      // invalidated by the next event — and the settle tick that follows any
      // burst is where the deferred passes catch up.
      const moved = win.fast() ? false : measureRows();
      const adapted = !win.scrolling() && adaptEstimate();
      reveal.retry(moved || adapted);
      syncScroll();
      // A commit can land between frame flushes: its rows report zero size
      // until the flush, this tick has already run, and nothing else would
      // come back for them — a window that just finished growing renders
      // nothing further, and the missed measurements would stand for good.
      // Look again, briefly, while any drawn row is still unsized.
      if (rowsPendingLayout() && tries++ < 8) look = later(pass, 16);
    };
    const id = afterLayout(pass);
    return () => {
      cancelAfterLayout(id);
      cancelLater(look);
    };
  });

  const goTo = useCallback(
    (row: TreeRow<T> | null | undefined): void => {
      if (!row) return;
      currentRef.current = row.id;
      if (selected === undefined) setOwnSelected(row.id);
      onSelect?.(row.id, row.item);
      revealAt(row.index);
    },
    [selected, onSelect, revealAt],
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
      /**
       * How far a page key moves, in rows.
       *
       * A viewport's worth, which with rows of different heights is not a
       * division: it is "where does the row `index` sits at end up if I add a
       * viewport to its offset". One row of overlap is kept, the way every
       * document viewer does, so a page down leaves a line of context.
       */
      const pageFrom = (from: number, dir: number): number => {
        const idx = heights;
        const viewport = viewRef.current.height;
        if (viewport <= 0) return from + dir;
        const at = Math.max(0, Math.min(rows.length - 1, from));
        const target =
          idx.offsetAt(at) + dir * Math.max(1, viewport - rowHeight);
        const landed = idx.indexAt(Math.max(0, target));
        // never stand still: a row taller than the viewport would otherwise
        // make Page Down a no-op
        return landed === at ? at + dir : landed;
      };

      switch (ev.keysym) {
        case XK_UP:
          goTo(step(-1));
          return true;
        case XK_DOWN:
          goTo(step(1));
          return true;
        case XK_PAGE_UP:
          goTo(nearest(index < 0 ? 0 : pageFrom(index, -1), 1));
          return true;
        case XK_PAGE_DOWN:
          goTo(nearest(index < 0 ? pageFrom(0, 1) : pageFrom(index, 1), -1));
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
        revealAt(row.index);
        return true;
      },
      handleKey,
      rows: () => rowsRef.current,
    }),
    [goTo, toggleId, revealAt, handleKey, selected, accessors],
  );

  // --- rendering -----------------------------------------------------------

  const rowStyleProp = styles?.row;
  const guideStyleProp = styles?.guide;

  // The row component's stable half — `MemoTreeRow` bails out of a
  // re-render only if every prop kept its identity, and this one would
  // otherwise be rebuilt per row per render.
  const registerRow = useCallback(
    (id: TreeItemId, at: number, node: DrawnNode | null): void => {
      if (node) rowNodes.current.set(id, { node, at });
      else rowNodes.current.delete(id);
    },
    [],
  );

  /**
   * The row *elements*, reused by identity while nothing they depend on has
   * changed. The memo already skips re-rendering an unchanged row, but the
   * skip still costs a `createElement` and a props compare per row per
   * notch — the burst profile put bare `createElement` at a tenth of a
   * flick's CPU. Handing React the identical element object instead takes
   * the cheapest path it has: the fiber is reused with no compare at all.
   */
  const rowElems = useRef(
    new Map<
      TreeItemId,
      { row: TreeRow<T>; selected: boolean; el: ReactElement }
    >(),
  );
  const rowElemDeps = useRef<readonly unknown[]>([]);
  {
    const deps = [
      indent,
      rowHeight,
      rtl,
      theme,
      renderToggle,
      renderGuide,
      renderLabel,
      renderContent,
      rowStyleProp,
      guideStyleProp,
      styles?.toggle,
      styles?.label,
      accessors,
      toggleId,
      goTo,
      activate,
      registerRow,
    ];
    const prev = rowElemDeps.current;
    if (prev.length !== deps.length || deps.some((d, at) => d !== prev[at])) {
      rowElems.current.clear();
      rowElemDeps.current = deps;
    }
  }

  const renderOneRow = (row: TreeRow<T>): ReactElement => {
    const isSelected = row.id === current;
    const cached = rowElems.current.get(row.id);
    if (cached && cached.row === row && cached.selected === isSelected) {
      return cached.el;
    }
    const el = React.createElement(
      MemoTreeRow as (p: TreeRowViewProps<T>) => ReactElement,
      {
        key: String(row.id),
        row,
        isSelected,
        indent,
        rowHeight,
        rtl,
        theme,
        renderToggle,
        renderGuide,
        renderLabel,
        renderContent,
        rowStyle: rowStyleProp,
        guideStyle: guideStyleProp,
        toggleStyle: styles?.toggle,
        labelStyle: styles?.label,
        getLabel: accessors.getLabel,
        onToggle: toggleId,
        onGo: goTo,
        onOpen: activate,
        register: registerRow,
      },
    );
    rowElems.current.set(row.id, { row, selected: isSelected, el });
    return el;
  };

  /**
   * A row the window said not to build in full yet: the box at its indexed
   * height and none of its content — no guides, no twisty, no label — so
   * the commit answering a flood lands frames before the full rows could.
   * `styles.row` still applies, so row backgrounds hold. Not registered in
   * `rowNodes`: a skeleton must not be measured into the height index, and
   * cannot satisfy a reveal.
   */
  const renderSkeletonRow = (row: TreeRow<T>): ReactElement => {
    const isSelected = row.id === current;
    const color = row.disabled
      ? theme.textMuted
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
    return hx(
      'box',
      {
        key: String(row.id),
        'aria-hidden': true,
        style: [
          s.row,
          // Exactly what the index believes, so the spacers and the
          // scrollbar agree with the rows on where everything is.
          { height: index.heightAt(row.index) },
          {
            backgroundColor: isSelected ? theme.hoverBackground : 'transparent',
          },
          typeof rowStyleProp === 'function'
            ? rowStyleProp(state)
            : rowStyleProp,
        ],
      },
      // A line of "text" with no text, at the row's own indent, so a band
      // of placeholders reads as the tree arriving rather than a void.
      hx('box', {
        key: 'bar',
        style: [
          s.skeletonBar,
          {
            width: 72 + ((row.index * 37) % 89),
            marginStart: 4 + row.depth * indent + TWISTY + 4,
            backgroundColor: theme.track,
          },
        ],
      }),
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
          style: [s.spacer, { height: above }],
        }),
      );
    }
    for (let i = first; i < last; i++) {
      body.push(
        win.skeletons.has(rows[i].id)
          ? renderSkeletonRow(rows[i])
          : renderOneRow(rows[i]),
      );
    }
    if (virtualizing && last < rows.length) {
      body.push(
        hx('box', {
          key: 'spacer:after',
          style: [s.spacer, { height: below }],
        }),
      );
    }
    // Rows that left the window leave the cache too, once it has grown
    // well past the window — a scrub across a long list would otherwise
    // hold an element for every row it passed.
    if (rowElems.current.size > (last - first) * 3 + 64) {
      rowElems.current.clear();
    }
  }

  /**
   * The fast-scroll overlay — shown only while placeholders cover enough of
   * the viewport that the user would otherwise be looking at blank rows.
   * The half-viewport threshold keeps a near-miss quiet: a scroll the next
   * frame will absorb is not worth announcing. Once up it stays until the
   * view is whole again, so it does not flicker through the catch-up.
   *
   * A sibling of the scroll pane, never a child: everything inside the pane
   * — absolute children included — is shifted by the scroll, so a pill in
   * there rides away with the very flick it is meant to narrate. Outside,
   * it is painted after the pane on every repaint frame, which is what a
   * scrub produces (a jump past the viewport cannot take the blit fast
   * path), so it stays put while the content flies.
   */
  let scrollHint: ReactNode = null;
  if (virtualizing && rows.length > 0 && view.height > 0) {
    const vFirst = index.indexAt(view.top);
    const vLast = Math.min(
      rows.length - 1,
      index.indexAt(view.top + view.height),
    );
    // Two ways in: placeholders covering enough of the viewport that it
    // would otherwise read as blank, or a scrub — the window teleporting
    // while the burst is still in flight, where every commit chases a
    // viewport that has already left and nothing useful can be on screen.
    // Either way only once the catch-up has already *lasted*: a jump the
    // next few frames absorb is not worth announcing, so the pill waits
    // out the show-delay against the catch-up clock. Latched once
    // triggered: `pending` bounces to zero between catch-up commits, and a
    // pill that blinked with it would read as a glitch. It goes when the
    // burst does.
    const engaged =
      (win.pending > 0 && win.pending * 2 >= vLast - vFirst + 1) ||
      (win.jumped && win.scrolling());
    const lasted =
      win.catchupSince !== null &&
      Date.now() - win.catchupSince >= scrollHintDelay;
    const show =
      (engaged && lasted) ||
      (hintShown.current && (win.pending > 0 || win.scrolling()));
    hintShown.current = show;
    if (show) {
      const hintState: TreeScrollHintState<T> = {
        row: rows[vFirst],
        from: vFirst + 1,
        to: vLast + 1,
        count: rows.length,
        pending: win.pending,
        since: win.catchupSince ?? Date.now(),
      };
      const content = renderScrollHint
        ? renderScrollHint(hintState)
        : hx(
            'text',
            { style: { fontSize: 11, color: theme.hoverText } },
            `${hintState.from.toLocaleString()} / ${hintState.count.toLocaleString()}`,
          );
      if (content !== null && content !== undefined && content !== false) {
        scrollHint = hx(
          'box',
          {
            key: 'scroll-hint',
            // The pill duplicates what the scrollbar already tells an
            // assistive technology, and it comes and goes with the
            // catch-up — chatter, not content.
            'aria-hidden': true,
            style: s.scrollHintLane,
          },
          hx(
            'box',
            {
              style: [s.scrollHint, { backgroundColor: theme.hoverBackground }],
            },
            content,
          ),
        );
      }
    }
  } else {
    hintShown.current = false;
  }

  // The wrapper exists for the overlay: the scroll pane keeps the role, the
  // focus, the refs and the events — everything a `<Tree>` has always put
  // on its root — and the caller's `style` lands out here, where the
  // tree's place in the layout is decided.
  return hx(
    'box',
    { style: [s.outer, style] },
    hx(
      'box',
      {
        theme,
        role: 'tree',
        // The tree takes the focus, not the row — see the doc comment.
        focusable: true,
        ...boxProps,
        ref: scroller,
        style: s.root,
        /**
         * `preventDefault` is the load-bearing half.
         *
         * The tree's root is a scroll container **and** the focused node, and a
         * focused scroller has default key actions of its own: Down and Up
         * scroll by a wheel notch, the Page keys by a viewport, Home and End to
         * the ends, Space by a page. Without this, every arrow did both — moved
         * the selection *and* scrolled the list under it — which reads as the
         * tree scrolling whenever you use the keyboard rather than only when
         * the selection would otherwise leave the viewport.
         *
         * `handleKey` reports whether the tree took the key, so a key it did
         * not take (a letter that matched nothing) still gets the default.
         */
        onKeyDown: (ev) => {
          if (handleKey(ev)) ev.preventDefault();
        },
        // Layout, not scrolling, is what first tells a list how much of it is
        // worth building — and it is also where a page key gets its distance,
        // so this is measured whether or not the tree virtualizes.
        onViewport: (ev) => {
          win.sized(ev.width, ev.height);
          // The content just changed size, which is both the moment an owed
          // scroll can reach further than the clamp let it and the moment the
          // pane may have re-clamped its offset without saying so. It is not a
          // moment anything can be *settled* in: this runs from layout, a tick
          // before the pass that reads the rows it just drew back.
          reveal.retry(virtualizing);
          syncScroll();
          onViewport?.(ev);
        },
        onScroll: (ev) => {
          // A scroll this component did not ask for is the user taking over,
          // and an owed reveal must not yank the tree back out from under them
          // on the next layout.
          reveal.heard(ev.scrollY);
          win.scrolled(ev.scrollY);
          onScroll?.(ev);
        },
      },
      body,
    ),
    scrollHint,
  );
}
