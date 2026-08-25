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
//   - **Skeletons.** A scroll that outruns everything — a thumb dragged
//     across the list, a flick past the band — floods the window with rows
//     no single render can build in time. Those render as *skeletons*: the
//     row box at its indexed height, none of its content. A skeleton commit
//     is cheap, so it lands frames sooner than the full rows would, and
//     what blits in reads as rows arriving rather than a void. Upgrades
//     follow viewport-first, a budget per render, until none remain.
//
// A row outside the viewport costs its share of layout and nothing on the
// wire — the pane clips it — so the band is cheap to hold and pays for
// itself on the first notch that lands inside it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScrollableNode } from 'react-x11';

import type { RowHeights, RowKey } from './heights.js';
import { cancelLater, later } from './timers.js';
import type { DelayTick } from './timers.js';

/** All this needs of a row — `TreeRow` and `TableRow` are both this. */
interface Keyed {
  id: RowKey;
}

const EMPTY_KEYS: ReadonlySet<RowKey> = new Set();

/** Rows kept either side of the viewport, so a fast scroll does not show a
 *  gap before the next frame catches up. The components' default. */
export const DEFAULT_OVERSCAN = 6;

/** How long the viewport must have been showing unresolved content before
 *  the fast-scroll pill appears. A catch-up the next few frames absorb is
 *  not worth announcing — the pill is for the delay you can feel. */
export const SCROLL_HINT_DELAY_MS = 250;

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
/** Above this the scroll is a flick, not a read — px/ms, about three rows a
 *  frame. What `fast()` answers with, for work worth deferring to the
 *  settle. */
const FAST_V = 1.5;

/** More rows than this entering the window in one render is a flood — a
 *  teleport or a hard flick — and floods build skeletons first. An ordinary
 *  notch brings in a handful and never trips this. */
export const SKELETON_THRESHOLD = 16;
/** New full rows built per render while a flood is being caught up with.
 *  Measured (rowcost probe, 300-row commits, warm caches): a default-shape
 *  row costs ~0.11ms against a skeleton's ~0.06ms — about 2×, not the 10×
 *  the original pacing assumed — so the budgets lean generous and the
 *  skeleton tier is there for heavy `render` seams and for the look of
 *  rows arriving, not because full rows are ruinous. */
export const BURST_BUDGET = 24;
/** The same, once the scroll has stopped: bigger steps, still paced, so a
 *  settle after a long flood is a few quick commits rather than one big
 *  one. */
export const SETTLE_BUDGET = 48;

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
  /** The rows in display order — the same list the component draws from. */
  rows: readonly Keyed[];
  /**
   * Every height in the index is exact — the table's declared-uniform model.
   * What it buys here: the idle band may grow *upward* freely. A measured
   * component may only grow upward over rows the index has real numbers
   * for: an unmeasured row laid out above the viewport lands at a height
   * the spacer did not anticipate, and everything on screen jumps by the
   * difference until the measure tick pays it back — a wobble that is
   * masked while scrolling and glaring while idle. Unmeasured territory
   * above is left to the overscan, which meets it during a scroll.
   */
  exact: boolean;
  virtualizing: boolean;
  overscan: number;
  /** The idle band's target, rows beyond the overscan each side. `0` turns
   *  prefetch and the retained band off — the slice is exactly
   *  viewport-plus-overscan again. */
  prefetch: number;
  /** Rows entering the window in one render that count as a flood — below
   *  it everything builds in full. The component resolves it from its
   *  `catchup` prop; `SKELETON_THRESHOLD` is the default. */
  threshold: number;
  /** Full rows built per render while a flood is in flight / once it has
   *  settled. `BURST_BUDGET` / `SETTLE_BUDGET` are the defaults. */
  burstBudget: number;
  settleBudget: number;
}

export interface VirtualWindow {
  view: VirtualViewport;
  /** The viewport as of the last event, ahead of the state between an
   *  `onViewport` and the re-render it causes — what a measure tick reads. */
  viewRef: { readonly current: VirtualViewport };
  slice: WindowSlice;
  /**
   * Rows in the slice to draw as skeletons this render — the box at its
   * indexed height, no content, `aria-hidden`, and **not registered as a
   * mounted row**: a skeleton must not be measured into the height index or
   * satisfy a reveal. Empty except while a flood is being caught up with.
   */
  skeletons: ReadonlySet<RowKey>;
  /**
   * The window teleported this render: nothing it had built overlaps where
   * the viewport is now. One jump is a scrollbar page; a *run* of them
   * while a burst is in flight is a thumb scrub, where every commit chases
   * a viewport that has already left — the case a scroll-position overlay
   * exists for, because nothing else useful can be on screen.
   */
  jumped: boolean;
  /**
   * When the viewport first stopped being whole — placeholders on screen,
   * or a scrub outrunning the built rows — epoch milliseconds, `null` while
   * everything in view is real. What a hint's show-delay is measured from,
   * and cleared the moment the catch-up ends.
   */
  catchupSince: number | null;
  /**
   * How many of the rows **on screen** are skeletons this render — the
   * measure of "the user is looking at rows that have no content yet".
   * `0` the moment the viewport is fully real again, even while the band
   * beyond it is still catching up: it is the signal a scroll-position
   * overlay shows on, and an overlay that lingered past the last visible
   * skeleton would be announcing a delay nobody can see.
   */
  pending: number;
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
  /**
   * Scrolling, and too fast to be reading: work whose payoff is precision —
   * measuring rows, adapting estimates — is churn at this speed, every
   * correction invalidated by the next event. The settle tick that follows
   * any burst is where deferred work catches up.
   */
  fast(): boolean;
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
  /** Whether the slice this render produced still wants another step — band
   *  growth left to do, or skeletons left to upgrade — read by the idle tick
   *  to decide whether a re-render is worth it. */
  const wantsGrowth = useRef(false);
  /** Skeletons the slice this render carries — the tick shortens its own
   *  clock while any remain, so a flood is caught up with at `GROW_MS` pace
   *  rather than waiting out the idle delay. */
  const hasSkeletons = useRef(false);
  /** The rows currently built in full, by id — everything else in the slice
   *  is a skeleton. Ids, not indexes, so a re-sort moves the rows without
   *  demoting them. */
  const real = useRef<Set<RowKey>>(new Set());
  /** When the current catch-up began — see `catchupSince` on the result. */
  const catchupStart = useRef<number | null>(null);
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
      (globalThis as any).__scrolls = ((globalThis as any).__scrolls ?? 0) + 1;
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

  const fast = useCallback(
    (): boolean => active.current && Math.abs(vel.current.v) >= FAST_V,
    [],
  );

  // The idle clock has to start somewhere even when nothing ever scrolls —
  // a table that mounts and sits still owes itself the band. After any
  // render that still wants growth, make sure a tick is coming — and while
  // skeletons remain, a *near* one: they are on screen, and waiting out the
  // idle delay to fill them in would be a visible pause.
  useEffect(() => {
    if (hasSkeletons.current) {
      cancelLater(idleTimer.current);
      idleTimer.current = later(tick, GROW_MS);
    } else if (wantsGrowth.current && idleTimer.current === null) {
      idleTimer.current = later(tick, IDLE_MS);
    }
  });
  useEffect(() => () => cancelLater(idleTimer.current), []);

  const {
    heights,
    rows,
    exact,
    virtualizing,
    overscan,
    prefetch,
    threshold,
    burstBudget,
    settleBudget,
  } = inputs;
  const count = rows.length;

  let first = 0;
  let last = count;
  let jumped = false;
  wantsGrowth.current = false;
  /** Skeletons are still being filled in from the last render — the band
   *  must not grow while they are, or the debt outruns the catch-up. */
  const catchingUp = hasSkeletons.current;
  if (virtualizing) {
    // The core: what is on screen plus the overscan — extended, while a
    // burst is in flight, by where that burst will be in a few frames. The
    // lead goes on the edge being exposed; the overscan already covers the
    // trailing one.
    //
    // **Clamped to one viewport.** A scrollbar scrub moves millions of
    // pixels a second, and an unclamped `v × LEAD_MS` asked the slice for
    // tens of thousands of rows — one commit mounting them froze the app
    // for seconds, the very thing a virtualized list exists to prevent. A
    // viewport ahead is all a lead can usefully buy: anything further is
    // out of sight again before it finishes landing.
    const rawLead = active.current ? vel.current.v * LEAD_MS : 0;
    const lead = Math.max(-view.height, Math.min(view.height, rawLead));
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
        } else if (bl > bf) {
          jumped = true;
        }
      }

      // Grown while idle, one chunk per side per tick — never during a
      // burst, whose renders have rows of their own to build, and never
      // while skeletons are still filling in, whose catch-up comes first.
      // Upward growth stops at the first row the index has no real height
      // for — see `exact` on the inputs for why building one would make
      // the view wobble while idle.
      const targetFirst = Math.max(0, coreFirst - prefetch);
      const targetLast = Math.min(count, coreLast + prefetch);
      const growableUp = (): boolean =>
        first > targetFirst && (exact || heights.isMeasured(first - 1));
      if (!active.current && !catchingUp) {
        const stop = Math.max(targetFirst, first - GROW_CHUNK);
        while (first > stop && growableUp()) first--;
        if (last < targetLast) last = Math.min(targetLast, last + GROW_CHUNK);
      }
      wantsGrowth.current = growableUp() || last < targetLast;

      // The budget: the core plus a full band each side. Trim the trailing
      // side first — those rows are the furthest from coming back. The
      // top-side cut stops at the first row the index has no real height
      // for, the same rule growth follows and for the reverse reason: a
      // row laid out taller than the index believes contributes its real
      // height while mounted and its guessed one once dropped, so cutting
      // it silently shrinks the content above the viewport and the view
      // yanks up by the difference with no debt left to put it right. Held
      // a render or two longer, it gets measured, and the next trim takes
      // it cleanly.
      const budget = coreLast - coreFirst + 2 * prefetch;
      let excess = last - first - budget;
      if (excess > 0) {
        const cutAbove = (want: number): number => {
          let k = 0;
          while (k < want && (exact || heights.isMeasured(first + k))) k++;
          return k;
        };
        const aboveExtra = coreFirst - first;
        const belowExtra = last - coreLast;
        if (vel.current.v >= 0) {
          const cut = cutAbove(Math.min(aboveExtra, excess));
          first += cut;
          excess -= cut;
          last -= Math.min(belowExtra, excess);
        } else {
          const cut = Math.min(belowExtra, excess);
          last -= cut;
          excess -= cut;
          first += cutAbove(Math.min(aboveExtra, excess));
        }
      }
    }
    built.current = { first, last };
  } else {
    built.current = null;
  }

  // The skeleton tier: which of the slice's rows are worth building in full
  // *this* render. All of them, almost always — a flood is the exception.
  let skeletons: ReadonlySet<RowKey> = EMPTY_KEYS;
  let pending = 0;
  hasSkeletons.current = false;
  if (virtualizing) {
    const prev = real.current;
    const next = new Set<RowKey>();
    let entering = 0;
    for (let i = first; i < last; i++) {
      if (prev.has(rows[i].id)) next.add(rows[i].id);
      else entering++;
    }
    // A window with nothing carried over and no scroll in flight is a mount
    // or a wholesale data change, not a flood — those build in full, or the
    // first paint would be skeletons.
    const flood =
      entering > threshold && (active.current || next.size > 0);
    if (!flood) {
      for (let i = first; i < last; i++) next.add(rows[i].id);
    } else {
      // Viewport rows first — they are the ones being looked at — then
      // outward, up to the budget; the rest are skeletons until the ticks
      // catch up.
      let budget = active.current ? burstBudget : settleBudget;
      const vFirst = heights.indexAt(view.top);
      const vLast =
        view.height > 0 ? heights.indexAt(view.top + view.height) : vFirst;
      const take = (i: number): void => {
        if (i < first || i >= last || budget <= 0) return;
        if (!next.has(rows[i].id)) {
          next.add(rows[i].id);
          budget--;
        }
      };
      for (let i = vFirst; i <= vLast && i < last; i++) take(i);
      for (
        let d = 1;
        budget > 0 && (vFirst - d >= first || vLast + d < last);
        d++
      ) {
        take(vLast + d);
        take(vFirst - d);
      }
      const skel = new Set<RowKey>();
      for (let i = first; i < last; i++) {
        if (!next.has(rows[i].id)) {
          skel.add(rows[i].id);
          if (i >= vFirst && i <= vLast) pending++;
        }
      }
      skeletons = skel;
      hasSkeletons.current = skel.size > 0;
      if (skel.size > 0) wantsGrowth.current = true;
    }
    real.current = next;
  } else if (real.current.size > 0) {
    real.current = new Set();
  }

  // The catch-up clock: started the first render the viewport stops being
  // whole — placeholders in view, or a scrub outrunning the built rows —
  // and cleared when the catch-up ends, on the same condition a hint's
  // latch releases. Renders keep coming while it runs (the skeleton ticks,
  // the scrub's own events), so a deadline measured against it is
  // re-evaluated within a tick of passing.
  if (virtualizing && (pending > 0 || (jumped && active.current))) {
    catchupStart.current ??= Date.now();
  } else if (pending === 0 && !active.current) {
    catchupStart.current = null;
  }

  /** Where the slice starts, and how much of the list is below it — the two
   *  spacers that keep the scrollbar measuring the whole list. */
  const above = virtualizing ? heights.offsetAt(first) : 0;
  const below = virtualizing ? heights.total() - heights.offsetAt(last) : 0;

  return {
    view,
    viewRef,
    slice: { first, last, above, below },
    skeletons,
    jumped,
    catchupSince: catchupStart.current,
    pending,
    scrolled,
    sized,
    sync,
    scrolling,
    fast,
  };
}
