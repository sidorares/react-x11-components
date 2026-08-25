// The virtualization window: which rows are worth building, given where the
// viewport is and what it is doing.
//
// **Shared between `<Tree>` and `<Table>`** — the fourth piece both
// virtualizers stand on, beside `./heights.ts`, `./timers.ts` and
// `./scroll.ts`, and promoted for the same reason: the slice arithmetic, the
// viewport bookkeeping and the offset re-read after layout were line-for-line
// identical in both, and the scroll-responsiveness work lands in one place
// instead of two. See the header of `./heights.ts` for why this directory is
// internal rather than a shared module with a subpath.
//
// What a scroll actually costs on this renderer is why the window matters.
// A wheel notch scrolls the pane and repaints the exposed strip
// **synchronously, before React runs** — core blits on the event's own frame
// — so whatever is mounted in that strip is what the user sees. Rows built by
// the re-render land a frame later at the earliest. The only scroll with no
// blank frame at all is one that lands inside rows that were already built,
// which is what the window this hands back is for.
import { useCallback, useRef, useState } from 'react';
import type { ScrollableNode } from 'react-x11';

import type { RowHeights } from './heights.js';

/** Rows kept either side of the viewport, so a fast scroll does not show a
 *  gap before the next frame catches up. The components' default. */
export const DEFAULT_OVERSCAN = 6;

/**
 * What to build before the viewport has been measured. `onViewport` cannot
 * arrive until layout has run, which is a frame after the first commit, so
 * there is always one render that has to guess — and guessing "all of them"
 * puts a hundred thousand rows in the tree for a frame.
 */
const ASSUMED_ROWS = 40;

export interface VirtualViewport {
  /** The pane's vertical offset. */
  top: number;
  height: number;
  width: number;
}

/** The rows worth building this render, and the two spacer heights that keep
 *  the scrollbar measuring the whole list. `last` is exclusive. */
export interface WindowSlice {
  first: number;
  last: number;
  above: number;
  below: number;
}

/** What the hook reads of its component, re-supplied every render so none of
 *  it goes stale inside the stable callbacks. */
export interface VirtualWindowInputs {
  /** The scroll pane. `<Table>`'s body; `<Tree>`'s own root. */
  box: { readonly current: ScrollableNode | null };
  /** The height index, already `sync`ed to the rows this render draws. */
  heights: RowHeights;
  /** How many rows there are. */
  count: number;
  virtualizing: boolean;
  overscan: number;
}

export interface VirtualWindow {
  view: VirtualViewport;
  /** The viewport as of the last event, ahead of the state between an
   *  `onViewport` and the re-render it causes — what a measure tick reads. */
  viewRef: { readonly current: VirtualViewport };
  slice: WindowSlice;
  /** An `onScroll` arrived. */
  scrolled(top: number): void;
  /** An `onViewport` arrived. The ref is updated at event time — the measure
   *  tick runs before the re-render this causes, and must see this size. */
  sized(width: number, height: number): void;
  /**
   * Re-read the offset the pane is *actually* at.
   *
   * The pane moves silently — it resolves a queued reveal during layout, and
   * re-clamps an offset the content outgrew or outshrank — and a slice built
   * from the offset before those is drawn where the viewport is not: a blank
   * band where the rows should be, and no way back until a scroll of your
   * own re-syncs it by accident.
   */
  sync(): void;
}

/**
 * The window a virtualizing component builds its rows from.
 *
 * Owns the viewport state and the slice; the component keeps everything the
 * two virtualizers genuinely differ on — what a row *is*, measuring it,
 * revealing it. Call after `heights.sync`, so the slice is computed against
 * the rows this render is about to draw.
 */
export function useVirtualWindow(inputs: VirtualWindowInputs): VirtualWindow {
  const [view, setView] = useState<VirtualViewport>({
    top: 0,
    height: 0,
    width: 0,
  });
  const viewRef = useRef(view);
  viewRef.current = view;

  const inp = useRef(inputs);
  inp.current = inputs;

  const scrolled = useCallback((top: number): void => {
    // Only a virtualizing component reads the vertical offset — a whole one
    // has no slice to rebuild, and re-rendering it on a scroll it already
    // drew would be work for nothing.
    if (!inp.current.virtualizing) return;
    setView((prev) => (prev.top === top ? prev : { ...prev, top }));
  }, []);

  const sized = useCallback((width: number, height: number): void => {
    viewRef.current = { ...viewRef.current, width, height };
    setView((prev) =>
      prev.width === width && prev.height === height
        ? prev
        : { ...prev, width, height },
    );
  }, []);

  const sync = useCallback((): void => {
    const { box, virtualizing } = inp.current;
    const node = box.current;
    if (!node || !virtualizing) return;
    const y = node.scrollY;
    setView((prev) => (prev.top === y ? prev : { ...prev, top: y }));
  }, []);

  // The slice worth building: what is on screen, plus a little either side.
  // Which rows those are is a question for the height index — with rows of
  // different heights there is no division that answers it.
  const { heights, count, virtualizing, overscan } = inputs;
  let first = 0;
  let last = count;
  if (virtualizing) {
    first = Math.max(0, heights.indexAt(view.top) - overscan);
    last =
      view.height > 0
        ? Math.min(
            count,
            heights.indexAt(view.top + view.height) + 1 + overscan,
          )
        : Math.min(count, first + ASSUMED_ROWS);
  }
  /** Where the slice starts, and how much of the list is below it — the two
   *  spacers that keep the scrollbar measuring the whole list. */
  const above = virtualizing ? heights.offsetAt(first) : 0;
  const below = virtualizing ? heights.total() - heights.offsetAt(last) : 0;

  return {
    view,
    viewRef,
    slice: { first, last, above, below },
    scrolled,
    sized,
    sync,
  };
}
