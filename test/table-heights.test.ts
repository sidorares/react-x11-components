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
