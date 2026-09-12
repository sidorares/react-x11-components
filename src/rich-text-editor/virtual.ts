// Long documents: only the top-level blocks near the viewport are drawn.
//
// The machinery is `<Tree>`'s and `<Table>`'s — the height index
// (../internal/heights.ts), the window (../internal/window.ts) and the owed
// reveal (../internal/scroll.ts) — laid over the document's top-level blocks
// and keyed by their block keys (./keys.ts), so a height measured once
// survives every edit that keeps its block. Each drawn block is in a box of
// its own, measured after layout (./render.ts, `renderBlockRange`), and the
// blocks outside the window are two spacers, so the scrollbar measures the
// whole document.
//
// The view's geometry is laid-out text — a caret, a hit, the line an arrow
// key moves to — so a block that is not drawn has none. The view asks this
// window (`BlockWindow`) whether the block a position is in is drawn, and
// when it is not, because the reader scrolled away from the caret, it has
// the block revealed first and does what it meant to once the block is laid
// out (./view.ts: `scrollToSelection` and `move`).
//
// A block is measured with the gap after it, so that the index's offsets are
// where blocks start: the content column keeps its `gap`, and each spacer
// gives back the one gap it stands beside.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node as PMNode } from 'prosemirror-model';
import type { DrawnNode, ScrollableNode } from 'react-x11';

import { RowHeights } from '../internal/heights.js';
import type { RowKey } from '../internal/heights.js';
import { useReveal } from '../internal/scroll.js';
import {
  afterLayout,
  cancelAfterLayout,
  cancelLater,
  later,
} from '../internal/timers.js';
import type { DelayTick, LayoutTick } from '../internal/timers.js';
import { scaleOf } from '../internal/units.js';
import {
  BURST_BUDGET,
  DEFAULT_OVERSCAN,
  DEFAULT_PREFETCH,
  SETTLE_BUDGET,
  useVirtualWindow,
} from '../internal/window.js';
import type { BlockKeys } from './keys.js';

/** Top-level blocks past which `virtual: 'auto'` draws only a window of
 *  them — `<Tree>`'s threshold, and far more than a composer ever holds. */
export const VIRTUAL_THRESHOLD = 200;

/** What the view asks of a long document's window. */
export interface BlockWindow {
  /** Whether top-level block `index` is drawn and laid out. */
  drawn(index: number): boolean;
  /** Scroll top-level block `index` into view, and so draw it; `then` runs
   *  once it is laid out — unless the reader scrolls somewhere else first,
   *  which drops it. */
  reveal(index: number, then: () => void): void;
}

interface Row {
  id: string;
}

interface Drawn {
  node: DrawnNode;
  at: number;
}

/** The document's top-level blocks, by key, in order. */
function topBlocks(doc: PMNode, keys: BlockKeys): Row[] {
  const rows: Row[] = [];
  doc.forEach((_node, offset) => {
    rows.push({ id: keys.keyAt(offset) ?? `p${offset}` });
  });
  return rows;
}

export interface BlockWindowInputs {
  doc: PMNode;
  keys: BlockKeys;
  virtual: boolean | 'auto';
  /** What a block nobody has measured is guessed at, gap included —
   *  logical pixels, like every length here. */
  estimate: number;
  /** The content column's gap between blocks. */
  gap: number;
}

export interface BlockWindowState {
  virtualizing: boolean;
  /** The top-level blocks to draw, `last` exclusive. */
  first: number;
  last: number;
  /** The spacers before and after them — 0 for none. */
  above: number;
  below: number;
  /** The scroll pane. */
  box: { current: ScrollableNode | null };
  /** The pane's handlers, while the window is on. */
  onViewport(ev: { width: number; height: number }): void;
  onScroll(ev: { scrollY: number }): void;
  /** A drawn block's box as it mounts, and null as it goes. */
  register(key: string, at: number, node: unknown): void;
  /** What the view asks — see `BlockWindow`. */
  window: BlockWindow;
}

/** The window over a document's top-level blocks. Call every render, with
 *  the document about to be drawn. */
export function useBlockWindow(inputs: BlockWindowInputs): BlockWindowState {
  const { doc, keys, virtual, estimate, gap } = inputs;
  const box = useRef<ScrollableNode | null>(null);
  const [, setMeasured] = useState(0);
  const rows = useMemo(() => topBlocks(doc, keys), [doc, keys]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const gapRef = useRef(gap);
  gapRef.current = gap;
  /** The drawn blocks' boxes, by key, with the index each was drawn at. */
  const nodes = useRef(new Map<RowKey, Drawn>());
  const virtualizing =
    virtual === true || (virtual === 'auto' && rows.length > VIRTUAL_THRESHOLD);

  // One index per editor, for as long as it is mounted. A new look is a new
  // height for every block, so what was measured under the old one goes.
  const [heights] = useState(() => new RowHeights(estimate));
  const estimated = useRef(estimate);
  if (estimated.current !== estimate) {
    estimated.current = estimate;
    heights.reset();
  }
  heights.sync(rows, estimate);

  const win = useVirtualWindow({
    box,
    heights,
    rows,
    exact: false,
    virtualizing,
    overscan: DEFAULT_OVERSCAN,
    prefetch: DEFAULT_PREFETCH,
    // a block is built whole or not at all: no skeletons
    threshold: Number.POSITIVE_INFINITY,
    burstBudget: BURST_BUDGET,
    settleBudget: SETTLE_BUDGET,
  });
  const reveal = useReveal({ box, rows: rowsRef, nodes, heights });

  /** A reveal the view is waiting on, and what it does once the block is
   *  laid out. */
  const owed = useRef<{ id: string; then: () => void } | null>(null);

  const drawnAt = useCallback((index: number): boolean => {
    const row = rowsRef.current[index];
    const drawn = row ? nodes.current.get(row.id) : undefined;
    return !!drawn && drawn.at === index && drawn.node.abs.height > 0;
  }, []);

  /** What the drawn blocks laid out at, into the index — `<Tree>`'s pass:
   *  what grew above the viewport comes back out of the offset, so the text
   *  being read does not move. */
  const measure = (): boolean => {
    const pane = box.current;
    const list = rowsRef.current;
    const anchor = pane ? heights.indexAt(pane.scrollY / scaleOf(pane)) : 0;
    let shift = 0;
    let changed = false;
    for (const [id, { node, at }] of nodes.current) {
      if (list[at]?.id !== id || !(node.abs.height > 0)) continue;
      // `abs` is device, the index logical (../internal/units.ts)
      const height = node.abs.height / scaleOf(node) + gapRef.current;
      const was = heights.heightAt(at);
      if (!heights.measure(id, at, height)) continue;
      changed = true;
      if (at < anchor) shift += height - was;
    }
    if (!changed) return false;
    reveal.nudge(shift);
    setMeasured((n) => n + 1);
    return true;
  };

  /** The estimate learns the measured mean — idle only, and the screen
   *  kept still by the same anchor arithmetic. */
  const adapt = (): boolean => {
    const pane = box.current;
    if (!pane) return false;
    const anchor = heights.indexAt(pane.scrollY / scaleOf(pane));
    const before = heights.offsetAt(anchor);
    if (!heights.adapt()) return false;
    reveal.nudge(heights.offsetAt(anchor) - before);
    setMeasured((n) => n + 1);
    return true;
  };

  /** Whether a drawn block has no size yet: a commit can land between frame
   *  flushes, and a pass over it reads zeros. */
  const unsized = (): boolean => {
    const list = rowsRef.current;
    for (const [id, { node, at }] of nodes.current) {
      if (list[at]?.id === id && !(node.abs.height > 0)) return true;
    }
    return false;
  };

  /** Hand the view the block it was waiting on, once it is laid out — or
   *  drop the wait, when the block has left the document. */
  const settle = (): void => {
    const o = owed.current;
    if (!o) return;
    const drawn = nodes.current.get(o.id);
    if (
      drawn &&
      rowsRef.current[drawn.at]?.id === o.id &&
      drawn.node.abs.height > 0
    ) {
      owed.current = null;
      o.then();
    } else if (!rowsRef.current.some((row) => row.id === o.id)) {
      owed.current = null;
    }
  };

  // The tick after layout, and everything only known there: what the blocks
  // measured, whether an owed scroll can go further, where the pane really
  // is, and whether the block the view waits on is laid out — in that order,
  // each able to move what the next one reads.
  const ticks = useRef<{ layout: LayoutTick; look: DelayTick; tries: number }>({
    layout: null,
    look: null,
    tries: 0,
  });
  const pass = useRef<() => void>(() => {});
  pass.current = (): void => {
    if (!virtualizing) return;
    const pane = box.current;
    // `onViewport` reports a change, so a window turned on after the pane's
    // first layout has never heard its size: read it here
    if (pane && win.viewRef.current.height === 0 && pane.abs.height > 0) {
      const s = scaleOf(pane);
      win.sized(pane.abs.width / s, pane.abs.height / s);
    }
    const moved = win.fast() ? false : measure();
    const adapted = !win.scrolling() && adapt();
    reveal.retry(moved || adapted);
    win.sync();
    settle();
    // look again, briefly, while a block is unsized or the view still waits
    // — nothing else would come back for them
    const t = ticks.current;
    if ((unsized() || owed.current !== null) && t.tries++ < 8) {
      t.look = later(() => {
        t.look = null;
        pass.current();
      }, 16);
    }
  };
  const kick = useCallback((): void => {
    const t = ticks.current;
    cancelAfterLayout(t.layout);
    cancelLater(t.look);
    t.look = null;
    t.tries = 0;
    t.layout = afterLayout(() => {
      t.layout = null;
      pass.current();
    });
  }, []);
  useEffect(() => {
    if (virtualizing) kick();
  });
  useEffect(
    () => () => {
      const t = ticks.current;
      cancelAfterLayout(t.layout);
      cancelLater(t.look);
    },
    [],
  );

  const { sized, scrolled, sync } = win;
  const onViewport = useCallback(
    (ev: { width: number; height: number }): void => {
      sized(ev.width, ev.height);
      // the content changed size: an owed scroll may reach further, and the
      // pane may have re-clamped its offset without a word
      reveal.retry(true);
      sync();
    },
    [sized, reveal, sync],
  );
  const onScroll = useCallback(
    (ev: { scrollY: number }): void => {
      // a scroll this editor did not ask for is the reader's, and what the
      // view was waiting to do gives way to it
      if (!reveal.heard(ev.scrollY)) owed.current = null;
      scrolled(ev.scrollY);
    },
    [reveal, scrolled],
  );

  const register = useCallback(
    (key: string, at: number, node: unknown): void => {
      const map = nodes.current;
      if (node) map.set(key, { node: node as DrawnNode, at });
      else if (map.get(key)?.at === at) map.delete(key);
    },
    [],
  );

  const window = useMemo<BlockWindow>(
    () => ({
      drawn: drawnAt,
      reveal: (index, then) => {
        const row = rowsRef.current[index];
        if (!row) return;
        if (drawnAt(index)) {
          then();
          return;
        }
        owed.current = { id: row.id, then };
        reveal.to(row.id);
        // the reveal may need no render of its own — a block already in the
        // window, not yet laid out — so a pass is asked for here
        kick();
      },
    }),
    [drawnAt, reveal, kick],
  );

  const { first, last } = win.slice;
  return {
    virtualizing,
    first,
    last,
    above: virtualizing && first > 0 ? Math.max(0, win.slice.above - gap) : 0,
    below:
      virtualizing && last < rows.length
        ? Math.max(0, win.slice.below - gap)
        : 0,
    box,
    onViewport,
    onScroll,
    register,
    window,
  };
}
