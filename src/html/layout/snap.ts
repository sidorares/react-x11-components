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

/** Whether a container snaps on an axis. */
export function snapsOn(style: ComputedStyle, axis: Axis): boolean {
  const type = style.scrollSnapType;
  if (!type) return false;
  if (type.axis === 'both') return true;
  return axis === 'x'
    ? type.axis === 'x' || type.axis === 'inline'
    : type.axis === 'y' || type.axis === 'block';
}

/** A snap area's alignment on an axis: the block axis's is the first
 *  value, the vertical one in the writing mode documents are laid out in. */
function alignOn(box: Box, axis: Axis): SnapAlign {
  return box.style.scrollSnapAlign[axis === 'y' ? 0 : 1];
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
): { at: number; to: number } | null {
  const align = alignOn(area.box, axis);
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
  const yFirst = snapEach(c, x, out.y, scroll, 'y');
  const xFirst = snapEach(c, out.x, y, scroll, 'x');
  const far = (s: Snapped) => Math.hypot(s.x - x, s.y - y);
  return far(yFirst) <= far(xFirst) ? yFirst : xFirst;
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
      if (place) places.push({ at: nearestIn(want, place), box: area.box });
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
    } else {
      out.y = tie.at;
      out.targetY = lists.y![0];
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
  targets: { x: Box | null; y: Box | null },
): Snapped {
  const fresh = snapTo(c, x, y);
  const out: Snapped = { ...fresh };
  const kept: { x: SnapArea | null; y: SnapArea | null } = { x: null, y: null };
  for (const axis of AXES) {
    if (!snapsOn(c.style, axis)) continue;
    const target = axis === 'x' ? targets.x : targets.y;
    const area = target && c.areas.find((a) => a.box === target);
    // one the snapport no longer shows across the axis is none
    if (!area || !visibleAcross(c, area, axis, axis === 'x' ? y : x)) continue;
    const place = placeOf(c, area, axis);
    if (!place) continue;
    kept[axis] = area;
    const at = nearestIn(axis === 'x' ? x : y, place);
    if (axis === 'x') {
      out.x = at;
      out.targetX = target;
    } else {
      out.y = at;
      out.targetY = target;
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
      ky.box;
    return lineUp(c, keep, out.x, out.y);
  }
  return out;
}
