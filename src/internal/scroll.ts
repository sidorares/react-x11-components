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

import { useCallback, useRef } from 'react';
import type { DrawnNode, ScrollableNode } from 'react-x11';

import type { RowHeights, RowKey } from './heights.js';

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
  /** Try again: after a layout, or when the content changed size. */
  retry(): void;
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
  /** The offset the last scroll *this component* asked for, so the
   *  `onScroll` that answers it is not read as the user taking over. */
  const asked = useRef<number | null>(null);

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

  const retry = useCallback((): void => {
    const { box: boxRef, rows: rowsRef, nodes, heights } = src.current;
    const box = boxRef.current;
    const id = owed.current;
    if (!box || id === null) return;
    const rows = rowsRef.current;
    const at = rows.findIndex((r) => r.id === id);
    if (at < 0) {
      owed.current = null; // the row left the list
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
    const placed =
      drawn && drawn.node.abs.height > 0 && rows[drawn.at]?.id === id
        ? {
            above: box.abs.y - drawn.node.abs.y,
            below:
              drawn.node.abs.y + drawn.node.abs.height - (box.abs.y + viewport),
            height: drawn.node.abs.height,
          }
        : {
            above: box.scrollY - heights.offsetAt(at),
            below:
              heights.offsetAt(at) +
              heights.heightAt(at) -
              (box.scrollY + viewport),
            height: heights.heightAt(at),
          };

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
      owed.current = null; // as far in view as it can be: nothing owed
      return;
    }
    // A move the pane cannot make yet leaves the debt standing: the layout
    // that admits the rows just appended is the one that will let it finish.
    scrollTo(box.scrollY + move);
  }, [scrollTo]);

  const to = useCallback(
    (id: RowKey): void => {
      // Recorded before the attempt rather than after it, because the
      // interesting case is the one that cannot succeed yet.
      owed.current = id;
      retry();
    },
    [retry],
  );

  const heard = useCallback((scrollY: number): void => {
    if (scrollY !== asked.current) owed.current = null;
    asked.current = null;
  }, []);

  return { to, retry, scrollTo, heard };
}
