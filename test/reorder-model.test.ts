// The insertion arithmetic under <ReorderList>, on no display: which slot a
// point is over — the closest item, and which half of it along the axis —
// and what a move to that slot does to an order. Every case here is one the
// component's pointer tests would otherwise have to reach through layout.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  arrayMove,
  closestSlot,
  insertAtSlot,
  insertManyAtSlot,
  isNoopSlot,
  moveManyToSlot,
  moveToSlot,
} from '../src/reorder/index.js';
import type { ReorderRect } from '../src/reorder/index.js';

/** `n` rows of height 20 with a 4px gap, from y = 0. */
function column(n: number): ReorderRect[] {
  return Array.from({ length: n }, (_, i) => ({
    x: 0,
    y: i * 24,
    width: 100,
    height: 20,
  }));
}

/** `n` chips of width 50 with a 6px gap, from x = 0. */
function row(n: number): ReorderRect[] {
  return Array.from({ length: n }, (_, i) => ({
    x: i * 56,
    y: 0,
    width: 50,
    height: 20,
  }));
}

test('closestSlot: the top half of an item is the gap before it, the bottom half after', () => {
  const rects = column(3);
  assert.deepStrictEqual(closestSlot(rects, { x: 50, y: 5 }, 'vertical'), {
    slot: 0,
    index: 0,
    edge: 'before',
    combine: false,
  });
  assert.deepStrictEqual(closestSlot(rects, { x: 50, y: 15 }, 'vertical'), {
    slot: 1,
    index: 0,
    edge: 'after',
    combine: false,
  });
  assert.deepStrictEqual(closestSlot(rects, { x: 50, y: 27 }, 'vertical'), {
    slot: 1,
    index: 1,
    edge: 'before',
    combine: false,
  });
  assert.deepStrictEqual(closestSlot(rects, { x: 50, y: 66 }, 'vertical'), {
    slot: 3,
    index: 2,
    edge: 'after',
    combine: false,
  });
});

test('closestSlot: a point in a gap belongs to the nearer item; past the end, to the last', () => {
  const rects = column(3);
  // the gap between rows 0 and 1 runs 20..24; 21 is nearer row 0's bottom
  assert.strictEqual(closestSlot(rects, { x: 50, y: 21 }, 'vertical')?.slot, 1);
  // 23 is nearer row 1's top — same slot, read off the other item
  assert.deepStrictEqual(closestSlot(rects, { x: 50, y: 23 }, 'vertical'), {
    slot: 1,
    index: 1,
    edge: 'before',
    combine: false,
  });
  // well below the list: the last item, its bottom half
  assert.deepStrictEqual(closestSlot(rects, { x: 50, y: 400 }, 'vertical'), {
    slot: 3,
    index: 2,
    edge: 'after',
    combine: false,
  });
  // well above it
  assert.strictEqual(
    closestSlot(rects, { x: 50, y: -90 }, 'vertical')?.slot,
    0,
  );
  // beside it, level with row 1's middle: row 1, and its lower half at 12
  assert.deepStrictEqual(closestSlot(rects, { x: 900, y: 36 }, 'vertical'), {
    slot: 2,
    index: 1,
    edge: 'after',
    combine: false,
  });
});

test('closestSlot: horizontal reads x, and RTL puts the start edge on the right', () => {
  const rects = row(3);
  assert.deepStrictEqual(
    closestSlot(rects, { x: 10, y: 10 }, 'horizontal', 'ltr'),
    { slot: 0, index: 0, edge: 'before', combine: false },
  );
  assert.deepStrictEqual(
    closestSlot(rects, { x: 40, y: 10 }, 'horizontal', 'ltr'),
    { slot: 1, index: 0, edge: 'after', combine: false },
  );
  // the same points under RTL: item 0 is the *first* in reading order,
  // and its start edge is its right edge
  assert.deepStrictEqual(
    closestSlot(rects, { x: 40, y: 10 }, 'horizontal', 'rtl'),
    { slot: 0, index: 0, edge: 'before', combine: false },
  );
  assert.deepStrictEqual(
    closestSlot(rects, { x: 10, y: 10 }, 'horizontal', 'rtl'),
    { slot: 1, index: 0, edge: 'after', combine: false },
  );
});

test('closestSlot: a wrapping grid is the same rule — the nearest item, then its edge along the axis', () => {
  // two rows of two, 40 wide, 20 tall, wrapping in a vertical list
  const rects: ReorderRect[] = [
    { x: 0, y: 0, width: 40, height: 20 },
    { x: 44, y: 0, width: 40, height: 20 },
    { x: 0, y: 24, width: 40, height: 20 },
    { x: 44, y: 24, width: 40, height: 20 },
  ];
  // over the second cell's upper half: before it
  assert.deepStrictEqual(closestSlot(rects, { x: 60, y: 4 }, 'vertical'), {
    slot: 1,
    index: 1,
    edge: 'before',
    combine: false,
  });
  // over the third cell's lower half: after it
  assert.deepStrictEqual(closestSlot(rects, { x: 10, y: 40 }, 'vertical'), {
    slot: 3,
    index: 2,
    edge: 'after',
    combine: false,
  });
});

test('closestSlot: no items, no answer', () => {
  assert.strictEqual(closestSlot([], { x: 0, y: 0 }, 'vertical'), null);
});

test('arrayMove: a new array, clamped at both ends, the same array on a no-op', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepStrictEqual(arrayMove(list, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepStrictEqual(arrayMove(list, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepStrictEqual(arrayMove(list, 1, 99), ['a', 'c', 'd', 'b']);
  assert.deepStrictEqual(arrayMove(list, -5, 1), ['b', 'a', 'c', 'd']);
  const same = arrayMove(list, 2, 2);
  assert.deepStrictEqual(same, list);
  assert.notStrictEqual(same, list, 'always a copy');
  assert.deepStrictEqual(list, ['a', 'b', 'c', 'd'], 'the input is untouched');
  assert.deepStrictEqual(arrayMove([], 0, 1), []);
});

test('isNoopSlot: an item over its own two gaps', () => {
  assert.ok(isNoopSlot(2, 2));
  assert.ok(isNoopSlot(2, 3));
  assert.ok(!isNoopSlot(2, 1));
  assert.ok(!isNoopSlot(2, 4));
  assert.ok(
    !isNoopSlot(-1, 0),
    'an item that is not in the list is not a no-op',
  );
});

test('moveToSlot: the slot is a gap, `to` is the index after removal', () => {
  const order = ['a', 'b', 'c', 'd'];
  // 'a' into the gap after 'c' (slot 3): it lands at index 2
  assert.deepStrictEqual(moveToSlot(order, 'a', 3), {
    items: ['b', 'c', 'a', 'd'],
    from: 0,
    to: 2,
  });
  // 'd' into the gap before 'b' (slot 1): it lands at index 1
  assert.deepStrictEqual(moveToSlot(order, 'd', 1), {
    items: ['a', 'd', 'b', 'c'],
    from: 3,
    to: 1,
  });
  // 'a' to the very end
  assert.deepStrictEqual(moveToSlot(order, 'a', 4), {
    items: ['b', 'c', 'd', 'a'],
    from: 0,
    to: 3,
  });
  // its own gaps: nothing
  assert.strictEqual(moveToSlot(order, 'b', 1), null);
  assert.strictEqual(moveToSlot(order, 'b', 2), null);
  // not in the list: nothing
  assert.strictEqual(moveToSlot(order, 'z', 0), null);
});

test('insertAtSlot: a newcomer at a gap, clamped', () => {
  const order = ['a', 'b'];
  assert.deepStrictEqual(insertAtSlot(order, 'x', 0), ['x', 'a', 'b']);
  assert.deepStrictEqual(insertAtSlot(order, 'x', 1), ['a', 'x', 'b']);
  assert.deepStrictEqual(insertAtSlot(order, 'x', 2), ['a', 'b', 'x']);
  assert.deepStrictEqual(insertAtSlot(order, 'x', 9), ['a', 'b', 'x']);
  assert.deepStrictEqual(insertAtSlot([], 'x', 0), ['x']);
  assert.deepStrictEqual(order, ['a', 'b'], 'the input is untouched');
});

// --- the combine band -------------------------------------------------------

test('closestSlot: with a band, the middle of an item is a merge and the ends are not', () => {
  const rects = column(3);
  const band = 0.25;
  // row 1 runs y 24..44; its middle half is 29..39
  const at = (y: number) =>
    closestSlot(rects, { x: 50, y }, 'vertical', 'ltr', band);
  assert.deepStrictEqual(at(26), {
    slot: 1,
    index: 1,
    edge: 'before',
    combine: false,
  });
  assert.deepStrictEqual(at(30), {
    slot: 1,
    index: 1,
    edge: 'before',
    combine: true,
  });
  assert.deepStrictEqual(at(38), {
    slot: 2,
    index: 1,
    edge: 'after',
    combine: true,
  });
  assert.deepStrictEqual(at(42), {
    slot: 2,
    index: 1,
    edge: 'after',
    combine: false,
  });
  // the edge answer is unchanged by the band, which is what lets a
  // combining list still be reordered through
  assert.strictEqual(at(30)!.slot, at(26)!.slot);
});

test('closestSlot: a point in the gap between two items never combines', () => {
  const rects = column(3);
  // 22 is in the 20..24 gap: nearest is row 0, but the pointer is not on it
  const hit = closestSlot(rects, { x: 50, y: 22 }, 'vertical', 'ltr', 0.25);
  assert.strictEqual(hit!.combine, false);
  // and neither does a point beside the list, level with an item's middle
  const beside = closestSlot(rects, { x: 400, y: 34 }, 'vertical', 'ltr', 0.25);
  assert.strictEqual(beside!.combine, false);
});

test('closestSlot: no band, no combining — the default answers as it always did', () => {
  const rects = column(3);
  assert.strictEqual(
    closestSlot(rects, { x: 50, y: 34 }, 'vertical')!.combine,
    false,
  );
});

// --- moving a set -----------------------------------------------------------

test('moveManyToSlot: the set travels in the list order and lands as one run', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  // picked up in the order c then a; they land in the list's own order
  assert.deepStrictEqual(moveManyToSlot(order, ['c', 'a'], 4, 'c'), {
    items: ['b', 'd', 'a', 'c', 'e'],
    ids: ['a', 'c'],
    from: 2,
    to: 3,
  });
  // to the very front
  assert.deepStrictEqual(moveManyToSlot(order, ['d', 'e'], 0, 'd'), {
    items: ['d', 'e', 'a', 'b', 'c'],
    ids: ['d', 'e'],
    from: 3,
    to: 0,
  });
  // to the very end
  assert.deepStrictEqual(moveManyToSlot(order, ['a', 'b'], 5, 'b'), {
    items: ['c', 'd', 'e', 'a', 'b'],
    ids: ['a', 'b'],
    from: 1,
    to: 4,
  });
});

test('moveManyToSlot: a set that lands where it already is moves nothing', () => {
  const order = ['a', 'b', 'c', 'd'];
  // the contiguous run b,c over its own gaps
  assert.strictEqual(moveManyToSlot(order, ['b', 'c'], 1, 'b'), null);
  assert.strictEqual(moveManyToSlot(order, ['b', 'c'], 2, 'b'), null);
  assert.strictEqual(moveManyToSlot(order, ['b', 'c'], 3, 'b'), null);
  // but past them is a real move
  assert.ok(moveManyToSlot(order, ['b', 'c'], 4, 'b'));
  // a set that is not contiguous always moves: it is gathered. Slot 2 is
  // the gap after 'b' in the *original* order, and 'b' is what is left
  // above it once a and c come out.
  assert.deepStrictEqual(moveManyToSlot(order, ['a', 'c'], 2, 'a'), {
    items: ['b', 'a', 'c', 'd'],
    ids: ['a', 'c'],
    from: 0,
    to: 1,
  });
  // and gathering to the front is slot 0
  assert.deepStrictEqual(moveManyToSlot(order, ['a', 'c'], 0, 'a'), {
    items: ['a', 'c', 'b', 'd'],
    ids: ['a', 'c'],
    from: 0,
    to: 0,
  });
});

test('moveManyToSlot: ids the list does not hold are ignored; an empty set is null', () => {
  const order = ['a', 'b', 'c'];
  assert.deepStrictEqual(moveManyToSlot(order, ['a', 'zz'], 3, 'a'), {
    items: ['b', 'c', 'a'],
    ids: ['a'],
    from: 0,
    to: 2,
  });
  assert.strictEqual(moveManyToSlot(order, [], 1, 'a'), null);
  assert.strictEqual(moveManyToSlot(order, ['zz'], 1, 'zz'), null);
});

test('moveToSlot is moveManyToSlot with one id', () => {
  const order = ['a', 'b', 'c', 'd'];
  for (let slot = 0; slot <= order.length; slot++) {
    const one = moveToSlot(order, 'b', slot);
    const many = moveManyToSlot(order, ['b'], slot, 'b');
    assert.deepStrictEqual(
      one,
      many && { items: many.items, from: many.from, to: many.to },
      `slot ${slot}`,
    );
  }
});

test('insertManyAtSlot: a run arrives together, clamped', () => {
  assert.deepStrictEqual(insertManyAtSlot(['a', 'b'], ['x', 'y'], 1), [
    'a',
    'x',
    'y',
    'b',
  ]);
  assert.deepStrictEqual(insertManyAtSlot(['a', 'b'], ['x'], 9), [
    'a',
    'b',
    'x',
  ]);
  assert.deepStrictEqual(insertManyAtSlot([], ['x', 'y'], 0), ['x', 'y']);
});
