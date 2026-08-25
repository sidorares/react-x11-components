// Scrolling a row into view, when neither the row nor the scroll pane is
// ready to be asked yet.
//
// **Shared between `<Tree>` and `<Table>`** — the third piece both
// virtualizers stand on, beside `./heights.ts` and `./timers.ts`, and here
// for the same reason: the logic is subtle, it is identical in both, and a
// second copy of it is a second place for the bug below to come back.
//
// Two things a scroll pane does silently, both of them in the gap between a
// commit and the layout it causes, and both of them enough on their own to
// leave a virtualized list drawing rows the viewport is no longer looking at:
//
//   1. **`scrollTo` clamps against the content height the *last* layout
//      measured.** A row appended in the commit now being laid out is past
//      the bottom that clamp knows about, so the request lands short — and
//      short *for good*, because nothing about it is retried. That is the
//      live tail: a list that scrolls to its newest row on every update and
//      settles one update behind, permanently. On mount, where no content
//      has been laid out at all, the scroll simply never happens.
//
//   2. **The pane moves without saying so.** It resolves a queued
//      `scrollIntoView` during layout, and it re-clamps an offset the
//      content has outgrown or outshrunk — neither of which fires
//      `onScroll`. A component that learns the offset only from that event
//      keeps building its slice from where the pane *was*: the rows are
//      drawn off-viewport, there is a blank band where they should be, and
//      nothing puts it right until a scroll of your own re-syncs it by
//      accident.
//
// So a reveal here is not a one-shot: it is a **debt**, kept by row id,
// attempted at once and re-tried on the layout that makes the rest of the
// move possible. It is dropped as soon as the row is in view, leaves the
// list, or the user scrolls somewhere themselves — an owed scroll must never
// yank the list back out from under a hand on the wheel.
//
// The offset is read back from the pane rather than trusted to the event;
// `useReveal` does not do that itself, because what a component *does* with
// the offset differs (a slice to rebuild, a header to shift), but it is the
// other half of the same fix and both components run it on the same tick.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { DrawnNode, ScrollableNode } from 'react-x11';

import type { RowHeights, RowKey } from './heights.js';
import { afterLayout, cancelAfterLayout } from './timers.js';
import type { LayoutTick } from './timers.js';

/** All a reveal needs of a row: `<TreeRow>` and `<TableRow>` are both this. */
interface Keyed {
  id: RowKey;
}

/** A row on screen, and the index it was drawn at — the shape both
 *  components already keep their mounted rows in. */
interface Drawn {
  node: DrawnNode;
  at: number;
}

/** What the component lends the reveal: everything it already has, by ref,
 *  so nothing here goes stale between a render and the tick after layout. */
export interface RevealSources {
  /** The scroll pane. `<Table>`'s body; `<Tree>`'s own root. */
  box: { readonly current: ScrollableNode | null };
  /** The rows in display order. */
  rows: { readonly current: readonly Keyed[] };
  /** The rows on screen, by id. */
  nodes: { readonly current: ReadonlyMap<RowKey, Drawn> };
  /** Where the rows that are *not* on screen are — and how tall a row that
   *  has never been drawn is assumed to be. */
  heights: RowHeights;
}

export interface Reveal {
  /** Owe a scroll to this row, and try to pay it now. */
  to(id: RowKey): void;
  /**
   * The content above the viewport just changed size by `px` — measurements
   * came in — and the offset must absorb the difference or what is on screen
   * jumps. A debt rather than a one-shot for the same reason a reveal is:
   * the pane clamps against the content height of the *last* layout, so a
   * nudge made just after rows above grew taller lands short — near the
   * bottom of the list, all of it lands short — and the remainder must be
   * re-tried once the layout that admits the growth has run. Retried by
   * `retry`, dropped by `heard`: a user mid-scroll keeps the pane.
   */
  nudge(px: number): void;
  /**
   * Try again: after a layout, or when the content changed size.
   *
   * Pass `provisional` on a pass where the height index just moved. The rows
   * are still laid out at the heights it no longer believes, so a row that
   * looks in view is not proof of anything yet — a row measured taller than
   * the guess pushes everything after it down, and the row that was reached a
   * moment ago ends up under the fold. The debt is kept until a pass that
   * measured nothing new confirms it, which is exactly when the heights have
   * converged.
   */
  retry(provisional?: boolean): void;
  /** Scroll the pane, recording that this component is the one that asked. */
  scrollTo(y: number): void;
  /** An `onScroll` arrived. One this component did not ask for is the user
   *  taking over, and it cancels whatever was owed. */
  heard(scrollY: number): void;
}

/**
 * The scroll a component owes a row, and the bookkeeping that pays it.
 *
 * Stable across renders — every method reads through the refs it was handed,
 * so an event handler or a layout tick built in an earlier render still sees
 * the current rows.
 */
export function useReveal(sources: RevealSources): Reveal {
  const src = useRef(sources);
  src.current = sources;
  /** The row still owed a scroll, by id. */
  const owed = useRef<RowKey | null>(null);
  /**
   * The row the last reveal settled on, kept for one reason: a measurement
   * pass can move the heights that settlement was judged against. A row that
   * was in view when the debt was paid is not in view any more once the rows
   * around it turn out taller than the index believed, and the honest answer
   * to "is that still true?" is to owe it again and look. Measurement
   * converges, so this stops asking.
   */
  const settled = useRef<RowKey | null>(null);
  /** The offset the last scroll *this component* asked for, so the
   *  `onScroll` that answers it is not read as the user taking over. */
  const asked = useRef<number | null>(null);
  /**
   * What the pane looked like at the last attempt that could not move.
   *
   * An attempt clamped by a content height that is a layout out of date has
   * to be looked at again — and nothing else will schedule that look: the
   * scroll that did not happen renders nothing, so the component's own tick
   * after layout never comes. One is queued here instead, and only while the
   * pane keeps changing under it: an attempt that finds the same offset and
   * the same content as the last one has nothing new to try, and stops.
   */
  const stuck = useRef<{ y: number; content: number } | null>(null);
  const look = useRef<LayoutTick>(null);
  useEffect(() => () => cancelAfterLayout(look.current), []);
  /** Pixels the pane still owes the content that grew or shrank above the
   *  viewport — the unpaid remainder of `nudge`. */
  const owedShift = useRef(0);

  const scrollTo = useCallback((y: number): void => {
    const box = src.current.box.current;
    if (!box) return;
    // Clamped here rather than left to the container, so what comes back on
    // `onScroll` is the number that was asked for and can be recognised.
    const to = Math.min(
      Math.max(0, y),
      Math.max(0, box.contentHeight - box.abs.height),
    );
    if (to === box.scrollY) return;
    asked.current = to;
    box.scrollTo({ y: to });
  }, []);

  /** Pay as much of the owed shift as the pane will take right now. What it
   *  refuses — a clamp still measuring the last layout's content — stays
   *  owed, and the `retry` after the next layout tries again. */
  const payShift = useCallback((): void => {
    const box = src.current.box.current;
    const want = owedShift.current;
    if (!box || want === 0) return;
    const was = box.scrollY;
    scrollTo(was + want);
    owedShift.current = want - (box.scrollY - was);
  }, [scrollTo]);

  const nudge = useCallback(
    (px: number): void => {
      // Either the reveal owns the pane or the anchor does. While a row is
      // owed — or settled and still being confirmed — the reveal re-places
      // it against the heights as they settle, so preserving the anchor
      // would fight it: a remainder paid out after the reveal has already
      // put its row where it belongs scrolls straight past it.
      if (owed.current !== null || settled.current !== null) return;
      if (px === 0) return;
      owedShift.current += px;
      payShift();
    },
    [payShift],
  );

  const retry = useCallback(
    (provisional?: boolean): void => {
      const { box: boxRef, rows: rowsRef, nodes, heights } = src.current;
      const box = boxRef.current;
      // The shift first: the reveal below judges placement from the offset,
      // and an offset still owing the content above it is the wrong one to
      // judge anything from.
      payShift();
      // The heights just moved, so what the last reveal settled on was settled
      // against numbers that have changed: owe it again until it can be
      // confirmed at the new ones.
      if (provisional && owed.current === null) owed.current = settled.current;
      const id = owed.current;
      if (!box || id === null) return;
      const rows = rowsRef.current;
      const at = rows.findIndex((r) => r.id === id);
      if (at < 0) {
        // the row left the list
        owed.current = null;
        settled.current = null;
        return;
      }
      const viewport = box.abs.height;
      if (viewport <= 0) return; // nothing laid out to scroll inside yet

      // How far the row is outside the pane, in pixels of scrolling. The row's
      // own rect answers when it is mounted — it knows what it really laid out
      // at, and the arithmetic stays in screen coordinates, so a pane with
      // padding on it needs no correction. The height index answers when the
      // row is not mounted, which while virtualizing is the normal case.
      const drawn = nodes.current.get(id);
      const mounted =
        drawn && drawn.node.abs.height > 0 && rows[drawn.at]?.id === id
          ? drawn.node
          : null;
      const placed = mounted
        ? {
            above: box.abs.y - mounted.abs.y,
            below: mounted.abs.y + mounted.abs.height - (box.abs.y + viewport),
            height: mounted.abs.height,
          }
        : {
            above: box.scrollY - heights.offsetAt(at),
            below:
              heights.offsetAt(at) +
              heights.heightAt(at) -
              (box.scrollY + viewport),
            height: heights.heightAt(at),
          };
      /**
       * Whether this is worth *settling* on, or only worth acting on.
       *
       * Two ways a row can look in view and not stay there. Its own placement
       * may be a guess — the index's answer for a row nothing has measured —
       * and "in view" judged from a guess is how a tail lands short of a bottom
       * that has not been measured yet. Or a row *between* the viewport and it
       * may still be a guess, and every one of those that turns out taller than
       * the index believed pushes this row down by the difference, out of the
       * view it had just been brought into.
       *
       * Both are settled by the same thing: measurement converges, so the rows
       * that matter stop being guesses. A component that measures nothing at all
       * has no guesses to wait on — `hasMeasurements` is how that is told
       * apart, and it is what keeps a declared-uniform table from owing a debt
       * for ever.
       */
      let certain = mounted !== null || heights.isMeasured(at);
      if (certain && heights.hasMeasurements()) {
        const from = Math.min(at, heights.indexAt(box.scrollY));
        const to = Math.max(at, heights.indexAt(box.scrollY + viewport));
        for (let i = from; i <= to && certain; i++) {
          certain = heights.isMeasured(i);
        }
      }

      let move = 0;
      if (placed.height >= viewport) {
        // A row taller than the pane is never *fully* in view, and asking for
        // both its edges in turn is a debt that alternates for ever. Its top is
        // the part worth showing — a wrapped row reads from its first line —
        // and arriving there settles it.
        move = -placed.above;
      } else if (placed.above > 0) move = -placed.above;
      else if (placed.below > 0) move = placed.below;

      if (move === 0) {
        // As far in view as it can be — settled, unless what that was judged
        // against is still moving: a placement that came from a guess, or a
        // pass that has just changed the heights under it.
        if (certain && !provisional) {
          settled.current = id;
          owed.current = null;
        }
        return;
      }
      // A move the pane cannot make yet leaves the debt standing: the layout
      // that admits the rows just appended is the one that will let it finish.
      const was = box.scrollY;
      scrollTo(was + move);
      if (box.scrollY !== was) {
        stuck.current = null; // it moved; the scroll it caused brings us back
        return;
      }
      const seen = stuck.current;
      const now = { y: box.scrollY, content: box.contentHeight };
      stuck.current = now;
      if (seen && seen.y === now.y && seen.content === now.content) return;
      cancelAfterLayout(look.current);
      look.current = afterLayout(() => {
        look.current = null;
        retryRef.current?.();
      });
    },
    [scrollTo, payShift],
  );

  /** `retry` referring to itself through a ref, so the queued look calls the
   *  current one rather than closing over the render that queued it. */
  const retryRef = useRef<(() => void) | null>(null);
  retryRef.current = retry;

  const to = useCallback(
    (id: RowKey): void => {
      // Recorded before the attempt rather than after it, because the
      // interesting case is the one that cannot succeed yet.
      owed.current = id;
      settled.current = null;
      stuck.current = null;
      // the reveal owns the pane now — see `nudge`
      owedShift.current = 0;
      retry();
    },
    [retry],
  );

  const heard = useCallback((scrollY: number): void => {
    // A scroll this component did not ask for ends the whole chase, not just
    // the outstanding half of it.
    if (scrollY !== asked.current) {
      owed.current = null;
      settled.current = null;
      owedShift.current = 0;
    }
    asked.current = null;
  }, []);

  // One stable object, not a fresh literal per render: callbacks built on
  // this handle (`revealAt`, and the row handlers behind it) keep their
  // identity, which is what lets a memoized row bail out of a scroll
  // render. A literal here made every row re-render on every notch — the
  // exact cost the memo exists to remove — with nothing anywhere naming it.
  return useMemo(
    () => ({ to, retry, scrollTo, nudge, heard }),
    [to, retry, scrollTo, nudge, heard],
  );
}
