// The insertion arithmetic under `<ReorderList>`: which slot a pointer is
// over, and what a move to that slot does to an order. Pure — no React, no
// display — so every case is asserted on no server (`test/reorder-model.test.ts`),
// and so a second consumer (a reorderable `<Table>`, say) can take it
// without taking the component. That promotion is the reason this is its
// own module rather than a section of `index.ts`.
//
// The model is pragmatic-drag-and-drop's **closest edge**: the item nearest
// the pointer, and which half of it — along the list's axis — the pointer is
// in. It needs nothing but the items' own rectangles, so it is the same rule
// for a vertical list, a horizontal strip, an RTL one and a wrapping grid,
// and it never has to know the gap between two items to answer for a point
// in it (`docs/prd-reorder.md`, "Geometry: the closest edge").

export type ReorderId = string | number;
export type ReorderOrientation = 'vertical' | 'horizontal';
/** Which edge of an item the pointer is nearest — in reading order, so
 *  `'before'` is the top of a vertical list and the *right* edge of an RTL
 *  strip. */
export type ReorderEdge = 'before' | 'after';

/** A rectangle in any one consistent space — the component hands over
 *  logical pixels, and the tests hand over whatever they like. */
export interface ReorderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReorderPoint {
  x: number;
  y: number;
}

/** Where a pointer would insert: the slot (`0` … `n`, a gap between items),
 *  and the item and edge that slot was read off, for whoever draws it. */
export interface ReorderSlot {
  slot: number;
  index: number;
  edge: ReorderEdge;
}

/** Squared distance from a point to a rectangle; zero inside it. */
function distance2(rect: ReorderRect, p: ReorderPoint): number {
  const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.height));
  return dx * dx + dy * dy;
}

/**
 * The slot a pointer is over, among items laid out in `rects`' order.
 *
 * The nearest item wins — the one under the pointer when there is one, and
 * on a tie the earlier — and its midpoint along the axis decides the edge.
 * `null` only when there are no items, where the caller's answer is slot 0.
 */
export function closestSlot(
  rects: readonly ReorderRect[],
  point: ReorderPoint,
  orientation: ReorderOrientation,
  direction: 'ltr' | 'rtl' = 'ltr',
): ReorderSlot | null {
  if (rects.length === 0) return null;
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const d = distance2(rects[i]!, point);
    if (d < best) {
      best = d;
      index = i;
    }
  }
  const rect = rects[index]!;
  let before: boolean;
  if (orientation === 'vertical') {
    before = point.y < rect.y + rect.height / 2;
  } else {
    const mid = rect.x + rect.width / 2;
    // the start edge of an RTL strip is on the right
    before = direction === 'rtl' ? point.x > mid : point.x < mid;
  }
  const edge: ReorderEdge = before ? 'before' : 'after';
  return { slot: before ? index : index + 1, index, edge };
}

/**
 * `list` with the item at `from` moved to `to` — a new array, always, so it
 * can be handed straight to a state setter. Indices past either end clamp.
 * dnd-kit's helper, by its name, because it is what every `onReorder`
 * handler ends up calling.
 */
export function arrayMove<T>(
  list: readonly T[],
  from: number,
  to: number,
): T[] {
  const out = list.slice();
  if (out.length === 0) return out;
  const a = Math.min(Math.max(from, 0), out.length - 1);
  const b = Math.min(Math.max(to, 0), out.length - 1);
  if (a === b) return out;
  const [item] = out.splice(a, 1);
  out.splice(b, 0, item as T);
  return out;
}

/** Whether dropping the item at `from` into `slot` would change nothing:
 *  the gap before it, and the gap after it, are both where it already is. */
export function isNoopSlot(from: number, slot: number): boolean {
  return from >= 0 && (slot === from || slot === from + 1);
}

/**
 * What a drop of `id` into `slot` does to `order`: the new order and the
 * two indices, or `null` when nothing would move — the item is not in the
 * list, or the slot is one of its own two gaps. `to` is where the item
 * ends up *after* it has been taken out, which is what `arrayMove` wants
 * and what a caller holding objects splices with.
 */
export function moveToSlot(
  order: readonly ReorderId[],
  id: ReorderId,
  slot: number,
): { items: ReorderId[]; from: number; to: number } | null {
  const from = order.indexOf(id);
  if (from < 0 || isNoopSlot(from, slot)) return null;
  const to = slot > from ? slot - 1 : slot;
  return { items: arrayMove(order, from, to), from, to };
}

/** `order` with `id` inserted at `slot` — an item arriving from elsewhere. */
export function insertAtSlot(
  order: readonly ReorderId[],
  id: ReorderId,
  slot: number,
): ReorderId[] {
  const out = order.slice();
  out.splice(Math.min(Math.max(slot, 0), out.length), 0, id);
  return out;
}
