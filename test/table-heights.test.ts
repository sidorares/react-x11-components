// The table's stake in the shared height index.
//
// The index itself lives in `src/internal/heights.ts`, shared with the
// tree, and the oracle suite (test/tree-heights.test.ts) proves the
// algorithm against a naive reference at every size. What is asserted here
// is the property the *table* buys from id-keying, which the tree never
// exercises: a measured height survives a **re-sort** — the permutation
// rebuilds offsets without remeasuring a single row.
import { test } from 'node:test';
import assert from 'node:assert';

import { RowHeights } from '../src/internal/heights.js';

const rowsOf = (
  ids: readonly (string | number)[],
): Array<{ id: string | number }> => ids.map((id) => ({ id }));

test('a measured height survives a re-sort without remeasuring', () => {
  const h = new RowHeights(24);
  h.sync(rowsOf(['a', 'b', 'c', 'd']), 24);
  h.measure('c', 2, 90);
  assert.strictEqual(h.total(), 24 * 3 + 90);

  // the sort moves c to the front
  h.sync(rowsOf(['c', 'a', 'b', 'd']), 24);
  assert.strictEqual(h.heightAt(0), 90, 'c kept its measurement');
  assert.strictEqual(h.offsetAt(1), 90, 'and every offset moved with it');
  assert.strictEqual(h.total(), 24 * 3 + 90, 'the total did not change');
});

test('a shuffle mid-measurement re-indexes rather than corrupting offsets', () => {
  // the table's version of the tree's stale-index case: the measure tick
  // lands after a sort moved the rows under it
  const h = new RowHeights(24);
  h.sync(rowsOf(['a', 'b', 'c']), 24);
  const shuffled = rowsOf(['c', 'b', 'a']);
  h.sync(shuffled, 24);
  assert.strictEqual(h.measure('a', 0, 60), true, 'stale index, applied');
  h.sync(shuffled, 24); // the rebuild the mismatch asked for
  assert.strictEqual(h.heightAt(2), 60, 'a is row 2 now, and it is 60 tall');
  assert.strictEqual(h.total(), 24 * 2 + 60);
});

test('adapt learns the measured mean and re-prices the unmeasured rows', () => {
  const h = new RowHeights(24);
  const rows = rowsOf(Array.from({ length: 100 }, (_, i) => i));
  h.sync(rows, 24);
  for (let i = 0; i < 10; i++) h.measure(i, i, 60);
  assert.strictEqual(h.total(), 10 * 60 + 90 * 24);

  assert.strictEqual(h.adapt(), true, 'ten samples are enough to learn from');
  assert.strictEqual(h.total(), 100 * 60, 'every unmeasured row re-priced');
  assert.strictEqual(
    h.adapt(),
    false,
    'and learning the same thing twice is free',
  );

  // the learnt estimate survives a rebuild for a new row list
  h.sync(rowsOf(Array.from({ length: 100 }, (_, i) => i)), 24);
  assert.strictEqual(h.total(), 100 * 60, 'the learnt estimate survived sync');

  // a caller changing their declared estimate wins back over adaptation
  h.sync(rows, 30);
  assert.strictEqual(h.total(), 10 * 60 + 90 * 30, 'the caller took it back');
});

test('adapt refuses to learn from too few rows', () => {
  const h = new RowHeights(24);
  h.sync(rowsOf(Array.from({ length: 50 }, (_, i) => i)), 24);
  for (let i = 0; i < 7; i++) h.measure(i, i, 60);
  assert.strictEqual(h.adapt(), false, 'seven rows say nothing about fifty');
  h.measure(7, 7, 60);
  assert.strictEqual(h.adapt(), true, 'the eighth tips it');
});

test('reset forgets the adaptation with the measurements it came from', () => {
  const h = new RowHeights(24);
  h.sync(rowsOf(Array.from({ length: 50 }, (_, i) => i)), 24);
  for (let i = 0; i < 10; i++) h.measure(i, i, 60);
  h.adapt();
  h.reset();
  h.sync(rowsOf(Array.from({ length: 50 }, (_, i) => i)), 24);
  assert.strictEqual(h.total(), 50 * 24, 'back to the declared estimate');
});
