// The table's height index is a vendored copy of the tree's
// (src/table/heights.ts — see the banner there), and a vendored copy's
// failure mode is drift: a fix lands in one and not the other. So the guard
// here is agreement — both classes driven through the same randomized
// sequence of syncs, measurements and lookups must answer identically,
// which is also what makes the eventual shared-module promotion a no-op.
//
// The tree's own suite (test/tree-heights.test.ts) proves the algorithm
// against a naive oracle; this file proves the copy, plus the one property
// the *table* buys from id-keying: a measured height survives a re-sort.
import { test } from 'node:test';
import assert from 'node:assert';

import { RowHeights as TableHeights } from '../src/table/heights.js';
import { RowHeights as TreeHeights } from '../src/tree/heights.js';

const rowsOf = (
  ids: readonly (string | number)[],
): Array<{ id: string | number }> => ids.map((id) => ({ id }));

test('the vendored copy agrees with the original, operation for operation', () => {
  const a = new TableHeights(22);
  const b = new TreeHeights(22);
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let ids = Array.from({ length: 257 }, (_, i) => `r${i}`);
  let rows = rowsOf(ids);
  a.sync(rows, 22);
  b.sync(rows, 22);

  for (let round = 0; round < 500; round++) {
    const op = rand();
    if (op < 0.15) {
      // shuffle — a sort — and re-point both at the same new array
      ids = [...ids].sort(() => rand() - 0.5);
      rows = rowsOf(ids);
      a.sync(rows, 22);
      b.sync(rows, 22);
    } else if (op < 0.6) {
      const at = Math.floor(rand() * ids.length);
      const height = 8 + Math.floor(rand() * 90);
      assert.strictEqual(
        a.measure(ids[at], at, height),
        b.measure(ids[at], at, height),
        `measure disagreement at round ${round}`,
      );
    } else {
      const probe = Math.floor(rand() * (a.total() + 100));
      assert.strictEqual(
        a.indexAt(probe),
        b.indexAt(probe),
        `indexAt(${probe})`,
      );
      const at = Math.floor(rand() * (ids.length + 1));
      assert.strictEqual(a.offsetAt(at), b.offsetAt(at), `offsetAt(${at})`);
      assert.strictEqual(a.total(), b.total(), `total at round ${round}`);
    }
  }
});

test('a measured height survives a re-sort without remeasuring', () => {
  // what id-keying buys the table: sorting permutes offsets, not knowledge
  const h = new TableHeights(24);
  h.sync(rowsOf(['a', 'b', 'c', 'd']), 24);
  h.measure('c', 2, 90);
  assert.strictEqual(h.total(), 24 * 3 + 90);

  // the sort moves c to the front
  h.sync(rowsOf(['c', 'a', 'b', 'd']), 24);
  assert.strictEqual(h.heightAt(0), 90, 'c kept its measurement');
  assert.strictEqual(h.offsetAt(1), 90, 'and every offset moved with it');
  assert.strictEqual(h.total(), 24 * 3 + 90, 'the total did not change');
});
