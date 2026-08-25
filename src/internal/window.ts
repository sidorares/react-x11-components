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
// What a scroll actually costs on this renderer is the reason this file is
// more than `indexAt(top) ± overscan`. A wheel notch scrolls the pane and
// repaints the exposed strip **synchronously, before React runs** — core
// blits on the event's own frame — so whatever is mounted in that strip is
// what the user sees. Rows built by the re-render land a frame later at the
// earliest. The only scroll with no blank frame at all is one that lands
// inside rows that were already built, which is what the window is for:
//
//   - **Idle prefetch.** While nothing is scrolling, the window grows
//     chunk-by-chunk beyond the overscan, up to `prefetch` rows each side —
//     prep work done while nobody is watching, so the next scroll lands on
//     rows that are already there. Grown in small steps so no single commit
//     is felt, and paused the moment a scroll arrives.
//   - **Velocity lead.** While scrolling, the window extends in the
//     direction of travel by the distance the next few frames will cover, so
//     the rows being built are the ones about to be exposed rather than ones
//     already behind the viewport.
//   - **Hysteresis.** Rows already built stay in the window until the budget
//     forces them out, trailing side first — a direction reversal lands on
//     rows still mounted instead of rebuilding them. The budget caps what a
//     render can be asked to carry: the on-screen slice plus `prefetch` rows
//     each side.
//
// A row outside the viewport costs its share of layout and nothing on the
// wire — the pane clips it — so the band is cheap to hold and pays for
// itself on the first notch that lands inside it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScrollableNode } from 'react-x11';

import type { RowHeights } from './heights.js';
import { cancelLater, later } from './timers.js';
import type { DelayTick } from './timers.js';

/** Rows kept either side of the viewport, so a fast scroll does not show a
 *  gap before the next frame catches up. The components' default. */
export const DEFAULT_OVERSCAN = 6;

/** How far past the overscan the idle band grows, rows per side — the
 *  components' default for their `prefetch` prop. Roughly two viewports of
 *  ordinary rows: enough that a flick lands inside it, small enough that
 *  holding it is never felt. */
export const DEFAULT_PREFETCH = 40;

/**
 * What to build before the viewport has been measured. `onViewport` cannot
 * arrive until layout has run, which is a frame after the first commit, so
 * there is always one render that has to guess — and guessing "all of them"
 * puts a hundred thousand rows in the tree for a frame.
 */
const ASSUMED_ROWS = 40;

/** How long the pane must sit quiet before prefetch may grow. Longer than a
 *  frame, shorter than a reader's pause. */
const IDLE_MS = 120;
/** Between growth steps — each step is one commit of `GROW_CHUNK` rows per
 *  side, so the band arrives in pieces no single frame feels. */
const GROW_MS = 40;
const GROW_CHUNK = 16;
/** How far ahead the velocity lead looks — about three frames: one for the
 *  render to land, one for its paint, one of margin. */
const LEAD_MS = 50;
/** Velocity is an EMA of the per-event slope; a gap longer than this between
 *  events is a stop, not a very slow scroll. */
const VEL_GAP_MS = 250;

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
  /** The idle band's target, rows beyond the overscan each side. `0` turns
   *  prefetch and the retained band off — the slice is exactly
   *  viewport-plus-overscan again. */
  prefetch: number;
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
  /** Whether a scroll is in flight — an event arrived and the idle clock has
   *  not run out since. What the growth pauses on, and what a component may
   *  defer non-urgent per-render work on. */
  scrolling(): boolean;
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

  /** Re-render with the same viewport — how an idle tick asks the slice to
   *  be recomputed so the band can take its next growth step. */
  const [, bump] = useState(0);
  /** The window built last render, kept so this render can keep it. */
  const built = useRef<{ first: number; last: number } | null>(null);
  /** The scroll's slope, px/ms, EMA over the events of the current burst —
   *  signed, positive downwards. Meaningful only while `active`. */
  const vel = useRef({ t: 0, top: 0, v: 0 });
  /** A burst is in flight: velocity is live and growth is paused. Cleared by
   *  the idle tick rather than by a clock read at render time, so a render's
   *  output never depends on when it ran. */
  const active = useRef(false);
  /** Whether the slice this render produced still wants growing — read by
   *  the idle tick to decide whether another step is worth a re-render. */
  const wantsGrowth = useRef(false);
  const idleTimer = useRef<DelayTick>(null);

  const tick = useCallback((): void => {
    idleTimer.current = null;
    const wasActive = active.current;
    active.current = false;
    if (!wasActive && !wantsGrowth.current) return;
    // One re-render on settling even when there is nothing to grow: it is
    // the render a component's deferred-while-scrolling work (measuring,
    // estimate adaptation) runs on.
    bump((n) => n + 1);
    if (wantsGrowth.current) {
      idleTimer.current = later(tick, GROW_MS);
    }
  }, []);

  const scrolled = useCallback(
    (top: number): void => {
      // Only a virtualizing component reads the vertical offset — a whole
      // one has no slice to rebuild, and re-rendering it on a scroll it
      // already drew would be work for nothing.
      if (!inp.current.virtualizing) return;
      const now = Date.now();
      const s = vel.current;
      const dt = now - s.t;
      if (dt > 0 && dt < VEL_GAP_MS) {
        // Blend rather than replace: a wheel's notches arrive unevenly, and
        // the lead must not whip around on every one.
        s.v = s.v * 0.6 + ((top - s.top) / dt) * 0.4;
      } else {
        s.v = 0;
      }
      s.t = now;
      s.top = top;
      active.current = true;
      cancelLater(idleTimer.current);
      idleTimer.current = later(tick, IDLE_MS);
      setView((prev) => (prev.top === top ? prev : { ...prev, top }));
    },
    [tick],
  );

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

  const scrolling = useCallback((): boolean => active.current, []);

  // The idle clock has to start somewhere even when nothing ever scrolls —
  // a table that mounts and sits still owes itself the band. After any
  // render that still wants growth, make sure a tick is coming.
  useEffect(() => {
    if (wantsGrowth.current && idleTimer.current === null) {
      idleTimer.current = later(tick, IDLE_MS);
    }
  });
  useEffect(() => () => cancelLater(idleTimer.current), []);

  const { heights, count, virtualizing, overscan, prefetch } = inputs;

  let first = 0;
  let last = count;
  wantsGrowth.current = false;
  if (virtualizing) {
    // The core: what is on screen plus the overscan — extended, while a
    // burst is in flight, by where that burst will be in a few frames. The
    // lead goes on the edge being exposed; the overscan already covers the
    // trailing one.
    const lead = active.current ? vel.current.v * LEAD_MS : 0;
    const topEdge = Math.max(0, view.top + Math.min(0, lead));
    const coreFirst = Math.max(0, heights.indexAt(topEdge) - overscan);
    let coreLast: number;
    if (view.height > 0) {
      const botEdge = view.top + view.height + Math.max(0, lead);
      coreLast = Math.min(count, heights.indexAt(botEdge) + 1 + overscan);
    } else {
      coreLast = Math.min(count, coreFirst + ASSUMED_ROWS);
    }
    first = coreFirst;
    last = coreLast;

    if (prefetch > 0 && view.height > 0) {
      // Keep what the last render built, so far as it touches the window —
      // a band the viewport just left is the band a reversal comes back to.
      // A band that does not touch it at all is a teleport's leavings, and
      // rebuilding from the core is cheaper than carrying rows a screenful
      // of nothing away.
      const b = built.current;
      if (b) {
        const bf = Math.min(Math.max(0, b.first), count);
        const bl = Math.min(Math.max(bf, b.last), count);
        if (bl > bf && bl >= first && bf <= last) {
          first = Math.min(first, bf);
          last = Math.max(last, bl);
        }
      }

      // Grown while idle, one chunk per side per tick — never during a
      // burst, whose renders have rows of their own to build.
      const targetFirst = Math.max(0, coreFirst - prefetch);
      const targetLast = Math.min(count, coreLast + prefetch);
      if (!active.current) {
        if (first > targetFirst)
          first = Math.max(targetFirst, first - GROW_CHUNK);
        if (last < targetLast) last = Math.min(targetLast, last + GROW_CHUNK);
      }
      wantsGrowth.current = first > targetFirst || last < targetLast;

      // The budget: the core plus a full band each side. Trim the trailing
      // side first — those rows are the furthest from coming back.
      const budget = coreLast - coreFirst + 2 * prefetch;
      let excess = last - first - budget;
      if (excess > 0) {
        const aboveExtra = coreFirst - first;
        const belowExtra = last - coreLast;
        if (vel.current.v >= 0) {
          const cut = Math.min(aboveExtra, excess);
          first += cut;
          excess -= cut;
          last -= Math.min(belowExtra, excess);
        } else {
          const cut = Math.min(belowExtra, excess);
          last -= cut;
          excess -= cut;
          first += Math.min(aboveExtra, excess);
        }
      }
    }
    built.current = { first, last };
  } else {
    built.current = null;
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
    scrolling,
  };
}
