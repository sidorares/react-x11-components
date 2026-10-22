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
  /** Whether an area is one a snap prefers among those that line up at
   *  one place: the focused element's, or the URL's target's. */
  prefer?: (box: Box) => boolean;
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

/** How near a place has to be to snap to it under `proximity`: a third of
 *  the snapport, as Chrome has it. */
const PROXIMITY = 1 / 3;

/** Whether a container snaps on an axis. */
export function snapsOn(style: ComputedStyle, axis: 'x' | 'y'): boolean {
  const type = style.scrollSnapType;
  if (!type) return false;
  if (type.axis === 'both') return true;
  return axis === 'x'
    ? type.axis === 'x' || type.axis === 'inline'
    : type.axis === 'y' || type.axis === 'block';
}

/** A snap area's alignment on an axis: the block axis's is the first
 *  value, the vertical one in the writing mode documents are laid out in. */
function alignOn(box: Box, axis: 'x' | 'y'): SnapAlign {
  return box.style.scrollSnapAlign[axis === 'y' ? 0 : 1];
}

/** Where a container is scrolled to on an axis to line an area up, or the
 *  range of places it may be where the area is larger than the snapport;
 *  null where the area does not line up on the axis. */
function placeOf(
  c: SnapContainer,
  area: SnapArea,
  axis: 'x' | 'y',
): { at: number; to: number } | null {
  const align = alignOn(area.box, axis);
  if (align === 'none') return null;
  const st = area.box.style;
  const client = axis === 'x' ? c.width : c.height;
  const padStart = resolve(
    axis === 'x' ? c.style.scrollPaddingLeft : c.style.scrollPaddingTop,
    client,
  );
  const padEnd = resolve(
    axis === 'x' ? c.style.scrollPaddingRight : c.style.scrollPaddingBottom,
    client,
  );
  const marginStart = axis === 'x' ? st.scrollMarginLeft : st.scrollMarginTop;
  const marginEnd = axis === 'x' ? st.scrollMarginRight : st.scrollMarginBottom;
  const start = (axis === 'x' ? area.x : area.y) - marginStart;
  const size =
    (axis === 'x' ? area.width : area.height) + marginStart + marginEnd;
  const port = Math.max(0, client - padStart - padEnd);
  const max = axis === 'x' ? c.maxX : c.maxY;
  const clamp = (v: number) => Math.min(Math.max(0, v), Math.max(0, max));
  // an area larger than the snapport may come to rest anywhere it covers
  // the snapport (5.3, "snapping boxes that overflow the scrollport")
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
 * Where a scroll to `x`, `y` comes to rest in a container (5.2): on an axis
 * it snaps on, the place an area lines up at nearest the one asked for —
 * where `mandatory` says it must, and within a third of the snapport where
 * `proximity` says it may — or anywhere inside an area larger than the
 * snapport that covers it. An axis it does not snap on is where it was
 * asked to be.
 *
 * Where several areas line up at that place, the one chosen (5.5) is the
 * container's preferred one — the focused element, or the target of the
 * document's URL — then one that lines up on both axes, then one inside
 * another, then the first in tree order.
 *
 * A scroll that has a direction — `scrollBy()`, a key, the wheel — comes
 * from where the container was (`from`), and on an axis it moved along
 * rests only at a place ahead of it, the one nearest where it was asked to
 * go (5.1, "intended direction and end position"): a step from one snap
 * position goes on to the next, however near the last.
 */
export function snapTo(
  c: SnapContainer,
  x: number,
  y: number,
  from: { x: number; y: number } | null = null,
): Snapped {
  const out: Snapped = { x, y, targetX: null, targetY: null };
  const ties: Partial<Record<'x' | 'y', { at: number; boxes: Box[] }>> = {};
  for (const axis of ['x', 'y'] as const) {
    if (!snapsOn(c.style, axis)) continue;
    const want = axis === 'x' ? x : y;
    const port = axis === 'x' ? c.width : c.height;
    const start = from ? (axis === 'x' ? from.x : from.y) : want;
    const dir = Math.abs(want - start) < 0.5 ? 0 : Math.sign(want - start);
    // with a direction, only the places ahead of where it started, where
    // there are any
    const ahead = (area: SnapArea): boolean => {
      const place = placeOf(c, area, axis);
      return !!place && dir * (place.to - start) > 0.5;
    };
    const areas = dir && c.areas.some(ahead) ? c.areas.filter(ahead) : c.areas;
    let best: { at: number; boxes: Box[] } | null = null;
    for (const area of areas) {
      const place = placeOf(c, area, axis);
      if (!place) continue;
      // where it was asked to be is a place an area larger than the
      // snapport may rest
      const range = place.to > place.at;
      const at =
        range && want >= place.at && want <= place.to
          ? want
          : range && want > place.to
            ? place.to
            : place.at;
      const off = Math.abs(at - want);
      if (!best || off < Math.abs(best.at - want) - 0.5) {
        best = { at, boxes: [area.box] };
      } else if (Math.abs(off - Math.abs(best.at - want)) <= 0.5) {
        best.boxes.push(area.box);
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
  for (const axis of ['x', 'y'] as const) {
    const tie = ties[axis];
    if (!tie) continue;
    const other = ties[axis === 'x' ? 'y' : 'x'];
    const chosen = choose(c, tie.boxes, other?.boxes ?? null);
    if (axis === 'x') {
      out.x = tie.at;
      out.targetX = chosen;
    } else {
      out.y = tie.at;
      out.targetY = chosen;
    }
  }
  return out;
}

/** Of the areas that line up at one place, the one a snap is to (5.5). */
function choose(
  c: SnapContainer,
  boxes: readonly Box[],
  other: readonly Box[] | null,
): Box {
  if (boxes.length === 1) return boxes[0];
  const preferred = c.prefer && boxes.find((b) => c.prefer!(b));
  if (preferred) return preferred;
  const both = other && boxes.find((b) => other.includes(b));
  if (both) return both;
  // one inside another is the more particular of the two
  const inner = boxes.find((b) => boxes.some((o) => o !== b && isInside(b, o)));
  return inner ?? boxes[0];
}

function isInside(box: Box, outer: Box): boolean {
  for (let at = box.parent; at; at = at.parent) if (at === outer) return true;
  return false;
}

/**
 * Where a container that was snapped to an area comes to rest after a
 * layout (5.4, "re-snapping after layout changes"): lined up with that
 * area again where it is still one, and where it is not, at the place
 * nearest where it is that `snapTo` finds. Null on an axis it neither
 * snaps on nor was snapped on.
 */
export function resnap(
  c: SnapContainer,
  x: number,
  y: number,
  targets: { x: Box | null; y: Box | null },
): Snapped {
  const fresh = snapTo(c, x, y);
  const out: Snapped = { ...fresh };
  for (const axis of ['x', 'y'] as const) {
    if (!snapsOn(c.style, axis)) continue;
    const target = axis === 'x' ? targets.x : targets.y;
    const area = target && c.areas.find((a) => a.box === target);
    if (!area) continue;
    const place = placeOf(c, area, axis);
    if (!place) continue;
    const now = axis === 'x' ? x : y;
    const at =
      place.to > place.at && now >= place.at && now <= place.to
        ? now
        : place.to > place.at
          ? now < place.at
            ? place.at
            : place.to
          : place.at;
    if (axis === 'x') {
      out.x = at;
      out.targetX = target;
    } else {
      out.y = at;
      out.targetY = target;
    }
  }
  return out;
}
