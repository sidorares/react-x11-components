// Scroll snapping (CSS Scroll Snap 1): where a scroll container may come to
// rest, and where a scroll to a place comes to rest. Pure, over the boxes a
// layout placed, in device pixels: the node asks it where a script scrolls
// a container to, and again after a layout, for the area each container
// was snapped to.
//
// A container is a scroll container in the document, or the viewport, the
// pane around it (`SnapContainer`): its scrollport, where it is scrolled to
// and how far it can be, and its snap areas — the boxes under it whose
// nearest scroll container it is, with a `scroll-snap-align` that is not
// `none` on an axis it snaps on.

import { resolve } from '../css/values.js';
import type { ComputedStyle, SnapAlign } from '../css/style.js';
import type { Box } from './boxes.js';

/** A snap container, as `snapTo` reads one. */
export interface SnapContainer {
  /** Whose `scroll-snap-type` and `scroll-padding` it has. */
  style: ComputedStyle;
  /** Its snap areas, in tree order, each with where its border box is at
   *  no scroll, from the scrollport's corner. */
  areas: readonly SnapArea[];
  /** The scrollport's size. */
  width: number;
  height: number;
  /** How far it can be scrolled. */
  maxX: number;
  maxY: number;
  /** Whether an area is the focused element or holds it: the first of
   *  those a snap prefers among the areas that line up at one place
   *  ("selecting between multiple aligned snap areas"), and the one a
   *  re-snap that cannot keep both axes' keeps ("re-snapping after layout
   *  changes"). */
  focused?: (box: Box) => boolean;
  /** The same of the URL's target, which comes after the focus. */
  targeted?: (box: Box) => boolean;
}

export interface SnapArea {
  box: Box;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a snap came to: where on each axis, and the area each axis lined
 *  up, or null where none did. */
export interface Snapped {
  x: number;
  y: number;
  targetX: Box | null;
  targetY: Box | null;
  /** Every area that lined up on each axis where one was chosen, which a
   *  re-snap after a layout chooses among again: the one focused since,
   *  say. */
  alignedX?: readonly Box[];
  alignedY?: readonly Box[];
}

/**
 * How a scroll moved, which decides where it comes to rest ("types of
 * scrolling methods"). An absolute scroll — `scrollTo()`, Home and End —
 * rests at the place nearest where it went, whichever way that is.
 */
export interface SnapScroll {
  /** Where a relative scroll began — `scrollBy()`, a scroll key, the wheel
   *  — which rests ahead of it, the way it went. */
  from?: { x: number; y: number } | null;
  /** A scroll by a page — PageDown, PageUp, Space — which takes a place
   *  within one snapport of where it began before any farther, so that it
   *  skips no area on its way ("choosing snap positions"). */
  page?: boolean;
}

/** How near a place has to be to snap to it under `proximity`: a third of
 *  the snapport, as Chrome has it. */
const PROXIMITY = 1 / 3;

const AXES = ['x', 'y'] as const;
type Axis = (typeof AXES)[number];

const other = (axis: Axis): Axis => (axis === 'x' ? 'y' : 'x');

/** The physical axis a container's block axis runs along: down the page
 *  in a horizontal writing mode, across it in a vertical one. */
function blockAxisOf(style: ComputedStyle): Axis {
  return style.writingMode === 'horizontal-tb' ? 'y' : 'x';
}

/** Whether a container's flow starts at the far end of a physical axis, the
 *  right or the bottom: its block start in `vertical-rl` and `sideways-rl`,
 *  its inline start in a right-to-left line, and in a vertical one that
 *  runs up the page (CSS Writing Modes 4, 6.1). */
function startsHigh(style: ComputedStyle, axis: Axis): boolean {
  const mode = style.writingMode;
  if (axis === blockAxisOf(style)) {
    return mode === 'vertical-rl' || mode === 'sideways-rl';
  }
  const rtl = style.direction === 'rtl';
  return axis === 'x' ? rtl : rtl !== (mode === 'sideways-lr');
}

/** Whether a container snaps on an axis: `block` and `inline` are the
 *  physical axes its writing mode puts them on. */
export function snapsOn(style: ComputedStyle, axis: Axis): boolean {
  const type = style.scrollSnapType;
  if (!type) return false;
  if (type.axis === 'both') return true;
  if (type.axis === 'block' || type.axis === 'inline') {
    const block = blockAxisOf(style);
    return type.axis === 'block' ? axis === block : axis !== block;
  }
  return type.axis === axis;
}

/** A snap area's alignment on a physical axis of its container (CSS Scroll
 *  Snap 1, 6.2): the first value is the container's block axis's, the
 *  second its inline axis's, and `start` the end its flow starts at — as
 *  `start` and `end` of the axis's low end here, the left or the top. */
function alignOn(c: SnapContainer, box: Box, axis: Axis): SnapAlign {
  const align =
    box.style.scrollSnapAlign[axis === blockAxisOf(c.style) ? 0 : 1];
  if (!startsHigh(c.style, axis)) return align;
  return align === 'start' ? 'end' : align === 'end' ? 'start' : align;
}

/** A container's snapport on an axis — its scrollport less its
 *  `scroll-padding` — by the padding at each end, and how long it is. */
function snapportOn(
  c: SnapContainer,
  axis: Axis,
): { pad: number; end: number; size: number } {
  const client = axis === 'x' ? c.width : c.height;
  const pad = resolve(
    axis === 'x' ? c.style.scrollPaddingLeft : c.style.scrollPaddingTop,
    client,
  );
  const end = resolve(
    axis === 'x' ? c.style.scrollPaddingRight : c.style.scrollPaddingBottom,
    client,
  );
  return { pad, end, size: Math.max(0, client - pad - end) };
}

/** Where a container is scrolled to on an axis to line an area up, or the
 *  range of places it may be where the area is larger than the snapport;
 *  null where the area does not line up on the axis. */
function placeOf(
  c: SnapContainer,
  area: SnapArea,
  axis: Axis,
  align: SnapAlign = alignOn(c, area.box, axis),
): { at: number; to: number } | null {
  if (align === 'none') return null;
  const st = area.box.style;
  const client = axis === 'x' ? c.width : c.height;
  const { pad: padStart, end: padEnd, size: port } = snapportOn(c, axis);
  const marginStart = axis === 'x' ? st.scrollMarginLeft : st.scrollMarginTop;
  const marginEnd = axis === 'x' ? st.scrollMarginRight : st.scrollMarginBottom;
  const start = (axis === 'x' ? area.x : area.y) - marginStart;
  const size =
    (axis === 'x' ? area.width : area.height) + marginStart + marginEnd;
  const max = axis === 'x' ? c.maxX : c.maxY;
  // a place past what can be scrolled to is as far as it can be scrolled
  // that way ("unreachable snap positions")
  const clamp = (v: number) => Math.min(Math.max(0, v), Math.max(0, max));
  // an area larger than the snapport may come to rest anywhere it covers
  // the snapport ("snapping boxes that overflow the scrollport")
  if (size > port) {
    return {
      at: clamp(start - padStart),
      to: clamp(start + size - port - padStart),
    };
  }
  let at: number;
  if (align === 'start') at = start - padStart;
  else if (align === 'end') at = start + size - (client - padEnd);
  else at = start + size / 2 - (padStart + port / 2);
  at = clamp(at);
  return { at, to: at };
}

/**
 * Where a container is first scrolled to with an area its initial target
 * (CSS Scroll Snap 2, 3.1): the area lined up as its `scroll-snap-align`
 * says, and at the start of its flow on an axis where that is `none`, as
 * `scrollIntoView()` would bring it; an area larger than the snapport at
 * its start.
 */
export function initialPlace(
  c: SnapContainer,
  area: SnapArea,
): { x: number; y: number } {
  const on = (axis: Axis): number => {
    let align = alignOn(c, area.box, axis);
    if (align === 'none') {
      align = startsHigh(c.style, axis) ? 'end' : 'start';
    }
    const place = placeOf(c, area, axis, align);
    if (!place) return 0;
    return startsHigh(c.style, axis) ? place.to : place.at;
  };
  return { x: on('x'), y: on('y') };
}

/**
 * Where an area larger than the snapport may rest nearest `want`, on an
 * axis ("snapping boxes that overflow the scrollport"): anywhere it covers
 * the snapport, but where the snapport's start would be inside another of
 * the container's areas, which intrudes there and has a snap position of
 * its own — so a scroll that comes to rest across a small area inside a
 * long one lines that area up, or rests past it, and does not cut it.
 */
function nearestCovering(
  c: SnapContainer,
  area: SnapArea,
  place: { at: number; to: number },
  axis: Axis,
  want: number,
  areas: readonly SnapArea[],
): number {
  const { pad } = snapportOn(c, axis);
  // the open stretches of the range the other areas take out
  const cuts: [number, number][] = [];
  for (const other of areas) {
    if (other === area || !placeOf(c, other, axis)) continue;
    const st = other.box.style;
    const before = axis === 'x' ? st.scrollMarginLeft : st.scrollMarginTop;
    const after = axis === 'x' ? st.scrollMarginRight : st.scrollMarginBottom;
    const start = (axis === 'x' ? other.x : other.y) - before - pad;
    const end =
      start + (axis === 'x' ? other.width : other.height) + before + after;
    if (end > place.at && start < place.to) cuts.push([start, end]);
  }
  if (!cuts.length) return nearestIn(want, place);
  cuts.sort((a, b) => a[0] - b[0]);
  // what is left of the range, stretch by stretch
  let best = place.at;
  let off = Infinity;
  const take = (from: number, to: number) => {
    if (to < from) return;
    const at = Math.min(Math.max(want, from), to);
    if (Math.abs(at - want) < off) {
      off = Math.abs(at - want);
      best = at;
    }
  };
  let from = place.at;
  for (const [start, end] of cuts) {
    if (start >= from) take(from, Math.min(start, place.to));
    from = Math.max(from, end);
  }
  take(from, place.to);
  return off === Infinity ? nearestIn(want, place) : best;
}

/** The place in a range nearest a place: itself, inside it. */
function nearestIn(want: number, place: { at: number; to: number }): number {
  return Math.min(Math.max(want, place.at), place.to);
}

/**
 * Where a scroll to `x`, `y` comes to rest in a container ("choosing snap
 * positions"): on an axis it snaps on, the place an area lines up at
 * nearest the one asked for — where `mandatory` says it must, and within a
 * third of the snapport where `proximity` says it may — or anywhere inside
 * an area larger than the snapport that covers it. An axis it does not
 * snap on is where it was asked to be.
 *
 * Where several areas line up at that place, the one chosen ("selecting
 * between multiple aligned snap areas") is the focused one, or the one
 * that holds the focus, then the URL's target or one that holds it, then
 * the innermost, then one that lines up on both axes, then the first in
 * tree order.
 *
 * A scroll that has a direction — `scrollBy()`, a key, the wheel — comes
 * from where the container was (`scroll.from`), and on an axis it moved
 * along rests only at a place ahead of it, the one nearest where it was
 * asked to go ("types of scrolling methods"): a step from one snap
 * position goes on to the next, however near the last. It passes over no
 * place of an area whose `scroll-snap-stop` is `always`, and rests at the
 * first it reaches; and a scroll by a page rests within a snapport of
 * where it began where any place does, so that it skips nothing.
 */
export function snapTo(
  c: SnapContainer,
  x: number,
  y: number,
  scroll: SnapScroll = {},
): Snapped {
  const out = snapEach(c, x, y, scroll);
  if (!out.targetX || !out.targetY || out.targetX === out.targetY) return out;
  // on both axes, only an area the snapport shows where the other axis
  // comes to is a snap position ("scoping valid snap positions to visible
  // boxes"): where the nearest on each does not show the other's, one axis
  // is snapped first and the other among the areas shown there, whichever
  // way comes to rest nearer
  const shows = (box: Box, axis: Axis, at: number): boolean => {
    const area = c.areas.find((a) => a.box === box);
    return !!area && shownAcross(c, area, axis, at);
  };
  if (shows(out.targetX, 'x', out.y) && shows(out.targetY, 'y', out.x)) {
    return out;
  }
  // a scroll with no direction rests at the nearest pair of places, one on
  // each axis, at which the snapport shows both areas
  if (!scroll.from) {
    const pair = nearestPair(c, x, y);
    if (pair) return pair;
  }
  const yFirst = snapEach(c, x, out.y, scroll, 'y');
  const xFirst = snapEach(c, out.x, y, scroll, 'x');
  const far = (s: Snapped) => Math.hypot(s.x - x, s.y - y);
  return far(yFirst) <= far(xFirst) ? yFirst : xFirst;
}

/**
 * The nearest pair of places to `x`, `y`, one an area lines up at on each
 * axis, at which the snapport shows the area of each: a place of one area
 * on one axis and another's on the other, which neither area's places
 * alone come to ("scoping valid snap positions to visible boxes"). An area
 * larger than the snapport rests where it is asked to, inside its range.
 * Null where no pair has both shown.
 */
function nearestPair(c: SnapContainer, x: number, y: number): Snapped | null {
  const on = (axis: Axis, want: number) =>
    c.areas.flatMap((area) => {
      const place = placeOf(c, area, axis);
      if (!place) return [];
      const at =
        place.to > place.at
          ? nearestCovering(c, area, place, axis, want, c.areas)
          : place.at;
      return [{ area, at }];
    });
  let best: Snapped | null = null;
  let off = Infinity;
  for (const px of on('x', x)) {
    for (const py of on('y', y)) {
      if (!shownAcross(c, px.area, 'x', py.at)) continue;
      if (!shownAcross(c, py.area, 'y', px.at)) continue;
      const d = Math.hypot(px.at - x, py.at - y);
      if (d < off - 0.5) {
        off = d;
        best = {
          x: px.at,
          y: py.at,
          targetX: px.area.box,
          targetY: py.area.box,
        };
      }
    }
  }
  return best;
}

/**
 * `snapTo` on each axis on its own; or, given `first`, with that axis held
 * where it is asked to be, and the other snapped among the areas the
 * snapport shows there.
 */
function snapEach(
  c: SnapContainer,
  x: number,
  y: number,
  scroll: SnapScroll,
  first: Axis | null = null,
): Snapped {
  const out: Snapped = { x, y, targetX: null, targetY: null };
  const from = scroll.from ?? null;
  const ties: Partial<Record<Axis, { at: number; boxes: Box[] }>> = {};
  for (const axis of AXES) {
    if (!snapsOn(c.style, axis)) continue;
    let want = axis === 'x' ? x : y;
    const port = axis === 'x' ? c.width : c.height;
    const start = from ? (axis === 'x' ? from.x : from.y) : want;
    const dir = Math.abs(want - start) < 0.5 ? 0 : Math.sign(want - start);
    // with a direction, only the areas with a place ahead of where it
    // started, where there are any: the way down an area's last place,
    // and the way up its first
    const ahead = (area: SnapArea): boolean => {
      const place = placeOf(c, area, axis);
      return !!place && dir * ((dir > 0 ? place.to : place.at) - start) > 0.5;
    };
    // only the areas the snapport shows across this axis, where it stays
    // where it is on the other: an axis snapped first is where it was put
    const across = axis === 'x' ? y : x;
    const shown =
      first === other(axis)
        ? c.areas.filter((a) => shownAcross(c, a, axis, across))
        : first === axis
          ? c.areas.filter((a) => {
              const place = placeOf(c, a, axis);
              return !!place && want > place.at - 0.5 && want < place.to + 0.5;
            })
          : c.areas.filter((a) => visibleAcross(c, a, axis, across));
    const areas = dir && shown.some(ahead) ? shown.filter(ahead) : shown;
    // a scroll passes over no place of an area that stops it: it rests at
    // the first such place between where it began and where it was going
    if (dir) {
      const stop = stopBetween(c, areas, axis, start, want, dir);
      if (stop !== null) want = stop;
    }
    let places: { at: number; box: Box }[] = [];
    for (const area of areas) {
      const place = placeOf(c, area, axis);
      // where it was asked to be is a place an area larger than the
      // snapport may rest
      if (!place) continue;
      const at =
        place.to > place.at
          ? nearestCovering(
              c,
              area,
              dir ? stoppedShort(c, areas, place, axis, start, dir) : place,
              axis,
              want,
              areas,
            )
          : place.at;
      places.push({ at, box: area.box });
    }
    // a page goes no farther than a snapport where a place ahead is that
    // near, however much nearer a farther one is to where it was going
    if (scroll.page && dir) {
      const reach = snapportOn(c, axis).size + 0.5;
      const near = places.filter((p) => {
        const by = dir * (p.at - start);
        return by > 0.5 && by <= reach;
      });
      if (near.length) places = near;
    }
    let best: { at: number; boxes: Box[] } | null = null;
    for (const { at, box } of places) {
      const off = Math.abs(at - want);
      if (!best || off < Math.abs(best.at - want) - 0.5) {
        best = { at, boxes: [box] };
      } else if (Math.abs(off - Math.abs(best.at - want)) <= 0.5) {
        best.boxes.push(box);
      }
    }
    if (!best) continue;
    const mandatory = c.style.scrollSnapType!.mandatory;
    const inside = Math.abs(best.at - want) < 0.5;
    if (!inside && !mandatory && Math.abs(best.at - want) > port * PROXIMITY) {
      continue;
    }
    ties[axis] = best;
  }
  // of the areas that line up at each place, the ones a snap prefers
  // ("selecting between multiple aligned snap areas"); and where both
  // axes' share any, those
  const lists: Partial<Record<Axis, Box[]>> = {};
  for (const axis of AXES) {
    const tie = ties[axis];
    if (tie) lists[axis] = preferred(c, tie.boxes);
  }
  if (lists.x && lists.y) {
    const both = lists.x.filter((b) => lists.y!.includes(b));
    if (both.length) lists.x = lists.y = both;
  }
  for (const axis of AXES) {
    const tie = ties[axis];
    if (!tie) continue;
    if (axis === 'x') {
      out.x = tie.at;
      out.targetX = lists.x![0];
      out.alignedX = tie.boxes;
    } else {
      out.y = tie.at;
      out.targetY = lists.y![0];
      out.alignedY = tie.boxes;
    }
  }
  return out;
}

/**
 * The first place, the way a scroll goes from `start`, of an area whose
 * `scroll-snap-stop` is `always` that is before where it was going
 * (`want`), or null where it passes none ("scroll-snap-stop"): the way
 * down an area's first place and the way up its last, so that one larger
 * than the snapport it began inside stops nothing.
 */
function stopBetween(
  c: SnapContainer,
  areas: readonly SnapArea[],
  axis: Axis,
  start: number,
  want: number,
  dir: number,
): number | null {
  let stop: number | null = null;
  for (const area of areas) {
    if (area.box.style.scrollSnapStop !== 'always') continue;
    const place = placeOf(c, area, axis);
    if (!place) continue;
    const at = dir > 0 ? place.at : place.to;
    if (dir * (at - start) <= 0.5 || dir * (want - at) <= 0.5) continue;
    if (stop === null || dir * (at - stop) < 0) stop = at;
  }
  return stop;
}

/**
 * Where a scroll with a direction may rest inside an area larger than the
 * snapport: no farther than where an area whose `scroll-snap-stop` is
 * `always`, out of the snapport where it began, would come into it — so
 * that it passes over none it would show, and goes on to its place only
 * where that is nearer ("scroll-snap-stop", Chromium's reading of it).
 */
function stoppedShort(
  c: SnapContainer,
  areas: readonly SnapArea[],
  place: { at: number; to: number },
  axis: Axis,
  start: number,
  dir: number,
): { at: number; to: number } {
  const port = snapportOn(c, axis);
  let { at, to } = place;
  for (const area of areas) {
    if (area.box.style.scrollSnapStop !== 'always') continue;
    if (!placeOf(c, area, axis)) continue;
    const st = area.box.style;
    const lo =
      (axis === 'x' ? area.x : area.y) -
      (axis === 'x' ? st.scrollMarginLeft : st.scrollMarginTop);
    const hi =
      (axis === 'x' ? area.x + area.width : area.y + area.height) +
      (axis === 'x' ? st.scrollMarginRight : st.scrollMarginBottom);
    if (dir > 0 && lo >= start + port.pad + port.size - 0.5) {
      to = Math.min(to, lo - port.pad - port.size);
    } else if (dir < 0 && hi <= start + port.pad + 0.5) {
      at = Math.max(at, hi - port.pad);
    }
  }
  return to < at ? place : { at, to };
}

/**
 * Of the areas that line up at one place on an axis, the ones a snap may
 * be to ("selecting between multiple aligned snap areas"), in tree order:
 * those that are or hold the focused element where any do, else those
 * that are or hold the URL's target where any do; and of those, none that
 * holds another.
 */
function preferred(c: SnapContainer, boxes: readonly Box[]): Box[] {
  if (boxes.length === 1) return [boxes[0]];
  let list: readonly Box[] = boxes;
  const focused = c.focused ? list.filter(c.focused) : [];
  if (focused.length) list = focused;
  else {
    const targeted = c.targeted ? list.filter(c.targeted) : [];
    if (targeted.length) list = targeted;
  }
  return list.filter((b) => !list.some((o) => o !== b && isInside(o, b)));
}

/**
 * Whether an area shows in the snapport across an axis — the container
 * scrolled to `at` on the other — and so is a snap position on it
 * ("scoping valid snap positions to visible boxes"). Where the container
 * snaps on the other axis too, both are chosen together, and every area
 * counts.
 */
function visibleAcross(
  c: SnapContainer,
  area: SnapArea,
  axis: Axis,
  at: number,
): boolean {
  if (snapsOn(c.style, other(axis))) return true;
  return shownAcross(c, area, axis, at);
}

/** Whether the snapport shows an area across an axis, scrolled to `at` on
 *  the other: its snap area, its border box with its `scroll-margin`,
 *  which may show where the box does not. */
function shownAcross(
  c: SnapContainer,
  area: SnapArea,
  axis: Axis,
  at: number,
): boolean {
  const o = other(axis);
  const st = area.box.style;
  const before = o === 'x' ? st.scrollMarginLeft : st.scrollMarginTop;
  const after = o === 'x' ? st.scrollMarginRight : st.scrollMarginBottom;
  const start = (o === 'x' ? area.x : area.y) - before;
  const size = (o === 'x' ? area.width : area.height) + before + after;
  const port = o === 'x' ? c.width : c.height;
  // an area of no size shows where it touches the snapport, at either edge
  if (size <= 0) return start >= at && start <= at + port;
  return start < at + port && start + size > at;
}

function isInside(box: Box, outer: Box): boolean {
  for (let at = box.parent; at; at = at.parent) if (at === outer) return true;
  return false;
}

/** Whether an area still lines up on an axis in a container: a snap
 *  position a container snapped to it may stay at. */
export function linesUp(
  c: SnapContainer,
  box: Box,
  axis: Axis,
  across: number,
): boolean {
  const area = c.areas.find((a) => a.box === box);
  return (
    !!area &&
    placeOf(c, area, axis) !== null &&
    visibleAcross(c, area, axis, across)
  );
}

/**
 * Where a container comes to rest with one area lined up (`box`): on each
 * axis the area lines up on — of those the container snaps on, or all of
 * them where it snaps on none — at its place nearest `x`, `y`; and on an
 * axis it snaps on that the area does not line up on, snapped among the
 * areas the snapport shows there. A scroll that brings an element into
 * view rests so where the element is an area ("choosing snap positions":
 * a fragment's target, `scrollIntoView()`'s, the focus's), and a
 * container with no `scroll-snap-type` lines its target up too, as the
 * specification lets it. Where the area is none of the container's,
 * `snapTo`'s.
 */
export function lineUp(
  c: SnapContainer,
  box: Box,
  x: number,
  y: number,
): Snapped {
  const area = c.areas.find((a) => a.box === box);
  if (!area) return snapTo(c, x, y);
  const snaps = snapsOn(c.style, 'x') || snapsOn(c.style, 'y');
  const out: Snapped = { x, y, targetX: null, targetY: null };
  let lined: Axis | null = null;
  for (const axis of AXES) {
    if (snaps && !snapsOn(c.style, axis)) continue;
    const place = placeOf(c, area, axis);
    if (!place) continue;
    lined = axis;
    if (axis === 'x') {
      out.x = nearestIn(x, place);
      out.targetX = box;
    } else {
      out.y = nearestIn(y, place);
      out.targetY = box;
    }
  }
  if (!lined) return snaps ? snapTo(c, x, y) : out;
  // the other axis, where the container snaps on it and the area did not
  // line up there: among the areas shown where the area is
  const rest = other(lined);
  if (snapsOn(c.style, rest) && !(rest === 'x' ? out.targetX : out.targetY)) {
    const s = snapEach(c, out.x, out.y, {}, lined);
    if (rest === 'x') {
      out.x = s.x;
      out.targetX = s.targetX;
    } else {
      out.y = s.y;
      out.targetY = s.targetY;
    }
  }
  return out;
}

/** Every area that lines up at `at` on an axis, shown in the snapport
 *  across it at `across`: what a re-snap that lands there chooses among
 *  the next time. */
function alignedAt(
  c: SnapContainer,
  axis: Axis,
  at: number,
  across: number,
): Box[] {
  const out: Box[] = [];
  for (const area of c.areas) {
    const place = placeOf(c, area, axis);
    if (!place || place.to > place.at) continue;
    if (Math.abs(place.at - at) > 0.5) continue;
    if (visibleAcross(c, area, axis, across)) out.push(area.box);
  }
  return out;
}

/**
 * Where a container that was snapped to an area comes to rest after a
 * layout ("re-snapping after layout changes"): lined up with that area
 * again where it is still one, and where it is not, at the place nearest
 * where it is that `snapTo` finds. Null on an axis it neither snaps on nor
 * was snapped on.
 *
 * Snapped to one area on each axis, where the snapport cannot show both
 * lined up so — one moved out of the other's way — it keeps the focused
 * one, or the one that holds the focus, then the URL's target, then the
 * block axis's, and lines it up on both.
 */
export function resnap(
  c: SnapContainer,
  x: number,
  y: number,
  targets: {
    x: Box | null;
    y: Box | null;
    /** Every area that lined up on each axis with the one chosen, of
     *  which the re-snap keeps the one a snap prefers now. */
    xs?: readonly Box[];
    ys?: readonly Box[];
    /** Whether the focus moved since it was snapped: only then does the
     *  focused area win over the one it was snapped to. */
    focusMoved?: boolean;
  },
): Snapped {
  const fresh = snapTo(c, x, y);
  const out: Snapped = { ...fresh };
  const kept: { x: SnapArea | null; y: SnapArea | null } = { x: null, y: null };
  const lists: Partial<Record<Axis, Box[]>> = {};
  for (const axis of AXES) {
    if (!snapsOn(c.style, axis)) continue;
    const here = axis === 'x' ? x : y;
    // of the areas that lined up, those still areas there, the snapport
    // showing them across the axis, which a covering area another now
    // intrudes on where the container is is not: it comes to rest where a
    // snap would
    const valid = (box: Box | null): boolean => {
      const area = box && c.areas.find((a) => a.box === box);
      if (!area || !visibleAcross(c, area, axis, axis === 'x' ? y : x)) {
        return false;
      }
      const place = placeOf(c, area, axis);
      if (!place) return false;
      return !(
        place.to > place.at &&
        here > place.at - 0.5 &&
        here < place.to + 0.5 &&
        Math.abs(nearestCovering(c, area, place, axis, here, c.areas) - here) >
          0.5
      );
    };
    const one = axis === 'x' ? targets.x : targets.y;
    const all = (axis === 'x' ? targets.xs : targets.ys) ?? [one];
    const still = all.filter((b): b is Box => valid(b));
    if (still.length) lists[axis] = still;
  }
  // the ones a snap prefers among them as they are now — the focused one
  // where the focus moved to another since (CSS Scroll Snap 1,
  // "re-snapping after layout changes") — and of those, one both axes
  // share, as `snapEach` chooses; else the one it chose before
  for (const axis of AXES) {
    const list = lists[axis];
    if (!list || list.length < 2) continue;
    const one = axis === 'x' ? targets.x : targets.y;
    const moved =
      (targets.focusMoved !== false && c.focused && list.some(c.focused)) ||
      (c.targeted && list.some(c.targeted));
    lists[axis] =
      moved || !one || !list.includes(one) ? preferred(c, list) : [one];
  }
  if (lists.x && lists.y && lists.x[0] !== lists.y[0]) {
    const both = lists.x.filter((b) => lists.y!.includes(b));
    if (both.length) lists.x = lists.y = both;
  }
  for (const axis of AXES) {
    const target = lists[axis]?.[0] ?? null;
    const area = target && c.areas.find((a) => a.box === target);
    if (!area) continue;
    const here = axis === 'x' ? x : y;
    const place = placeOf(c, area, axis)!;
    kept[axis] = area;
    const at = nearestIn(here, place);
    // and what lined up with it, for the next
    if (axis === 'x') {
      out.x = at;
      out.targetX = target;
      out.alignedX = alignedAt(c, 'x', at, y);
    } else {
      out.y = at;
      out.targetY = target;
      out.alignedY = alignedAt(c, 'y', at, x);
    }
  }
  const kx = kept.x;
  const ky = kept.y;
  if (
    kx &&
    ky &&
    kx.box !== ky.box &&
    !(shownAcross(c, kx, 'x', out.y) && shownAcross(c, ky, 'y', out.x))
  ) {
    const pair = [kx.box, ky.box];
    const keep =
      (c.focused && pair.find(c.focused)) ||
      (c.targeted && pair.find(c.targeted)) ||
      (blockAxisOf(c.style) === 'y' ? ky.box : kx.box);
    return lineUp(c, keep, out.x, out.y);
  }
  return out;
}
