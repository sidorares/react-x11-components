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
  /**
   * The pointer is inside the item's middle band and combining is on, so a
   * drop merges *into* `index` rather than landing beside it. Always false
   * when the caller passes no band, which is what keeps a list that does not
   * combine reading exactly as it did before.
   */
  combine: boolean;
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
 *
 * `combineBand` is the fraction of the item's length at *each* end that
 * still reads as an edge: 0 (the default) means every point picks an edge,
 * and 0.25 means the middle half of an item reads as "merge into this one"
 * — but only for a point genuinely inside it, since a point in the gap
 * between two items is not over either of them.
 */
export function closestSlot(
  rects: readonly ReorderRect[],
  point: ReorderPoint,
  orientation: ReorderOrientation,
  direction: 'ltr' | 'rtl' = 'ltr',
  combineBand = 0,
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
  const vertical = orientation === 'vertical';
  const start = vertical ? rect.y : rect.x;
  const length = vertical ? rect.height : rect.width;
  const along = vertical ? point.y : point.x;
  let before = along < start + length / 2;
  // the start edge of an RTL strip is on the right
  if (!vertical && direction === 'rtl') before = !before;
  const edge: ReorderEdge = before ? 'before' : 'after';
  // `best === 0` is the point being inside the rectangle: a band is about
  // the item under the pointer, and a gap belongs to neither of its
  // neighbours' middles.
  const fraction = length > 0 ? (along - start) / length : 0.5;
  const combine =
    combineBand > 0 &&
    best === 0 &&
    fraction >= combineBand &&
    fraction <= 1 - combineBand;
  return { slot: before ? index : index + 1, index, edge, combine };
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
  const many = moveManyToSlot(order, [id], slot, id);
  return many && { items: many.items, from: many.from, to: many.to };
}

/**
 * The same move with a **set** of items — a multi-drag. The set travels in
 * the list's own order, whatever order it was selected in, and lands as one
 * run at `slot`; `from`/`to` are where `primary` (the item actually under
 * the pointer) started and ended up.
 *
 * The slot counts gaps in the *original* order, so the arithmetic has to
 * discount the members of the set that were before it — which is also why
 * the single-item no-op rule generalizes rather than being special-cased:
 * a set that lands where it already was produces the order it started from,
 * and that is what `null` reports.
 */
export function moveManyToSlot(
  order: readonly ReorderId[],
  ids: readonly ReorderId[],
  slot: number,
  primary: ReorderId = ids[0]!,
): { items: ReorderId[]; ids: ReorderId[]; from: number; to: number } | null {
  const taking = new Set(ids);
  // the set in the list's order, and only the members the list actually has
  const moving = order.filter((id) => taking.has(id));
  if (moving.length === 0) return null;
  const from = order.indexOf(primary);
  if (from < 0) return null;
  const rest = order.filter((id) => !taking.has(id));
  const before = order
    .slice(0, Math.max(slot, 0))
    .filter((id) => taking.has(id)).length;
  const at = Math.min(Math.max(slot - before, 0), rest.length);
  const items = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (
    items.length === order.length &&
    items.every((id, i) => id === order[i])
  ) {
    return null;
  }
  return { items, ids: moving, from, to: items.indexOf(primary) };
}

/** `order` with `id` inserted at `slot` — an item arriving from elsewhere. */
export function insertAtSlot(
  order: readonly ReorderId[],
  id: ReorderId,
  slot: number,
): ReorderId[] {
  return insertManyAtSlot(order, [id], slot);
}

/** The same, with a set arriving together — a multi-drag from another list. */
export function insertManyAtSlot(
  order: readonly ReorderId[],
  ids: readonly ReorderId[],
  slot: number,
): ReorderId[] {
  const out = order.slice();
  out.splice(Math.min(Math.max(slot, 0), out.length), 0, ...ids);
  return out;
}
