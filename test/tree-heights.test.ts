// The height index, on its own.
//
// This is the file that makes variable-height virtualization possible, and
// every bug in it is silent: a wrong offset does not throw, it draws rows in
// the wrong place or scrolls to somewhere that is not what you asked for. So
// it is tested against a naive reference implementation over random
// measurements rather than against a handful of hand-picked cases — the
// Fenwick tree and a plain array of heights must agree about every offset,
// every lookup and the total, at every size.
import { test } from 'node:test';
import assert from 'node:assert';

import { RowHeights } from '../src/tree/heights.js';
import type { TreeItemId } from '../src/index.js';

const rowsOf = (n: number): Array<{ id: TreeItemId }> =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

/** The obvious implementation, which is the oracle. */
class Naive {
  readonly heights: number[];
  constructor(n: number, estimate: number) {
    this.heights = new Array<number>(n).fill(estimate);
  }
  offsetAt(index: number): number {
    let sum = 0;
    for (let i = 0; i < index; i++) sum += this.heights[i];
    return sum;
  }
  total(): number {
    return this.offsetAt(this.heights.length);
  }
  indexAt(offset: number): number {
    let sum = 0;
    for (let i = 0; i < this.heights.length; i++) {
      if (offset < sum + this.heights[i]) return i;
      sum += this.heights[i];
    }
    return Math.max(0, this.heights.length - 1);
  }
}

test('an unmeasured list is the estimate, repeated', () => {
  const h = new RowHeights(22);
  h.sync(rowsOf(10), 22);
  assert.strictEqual(h.total(), 220);
  assert.strictEqual(h.offsetAt(0), 0);
  assert.strictEqual(h.offsetAt(3), 66);
  assert.strictEqual(h.indexAt(0), 0);
  assert.strictEqual(h.indexAt(65), 2);
  assert.strictEqual(h.indexAt(66), 3);
  assert.strictEqual(h.isMeasured(0), false);
});

test('a measurement moves every row after it, and nothing before it', () => {
  const h = new RowHeights(20);
  h.sync(rowsOf(5), 20);
  assert.strictEqual(h.measure('r1', 1, 50), true);
  assert.strictEqual(h.offsetAt(1), 20, 'the row before is where it was');
  assert.strictEqual(h.offsetAt(2), 70, 'and the next one moved by 30');
  assert.strictEqual(h.total(), 130);
  assert.strictEqual(h.heightAt(1), 50);
  assert.strictEqual(h.isMeasured(1), true);
  // the same measurement again is not a change, which is what stops the
  // measure/render loop
  assert.strictEqual(h.measure('r1', 1, 50), false);
});

test('a height survives the rows changing under it', () => {
  // what makes scrolling back to somewhere you have been stable: collapsing
  // a branch and opening it again must not re-estimate its rows
  const h = new RowHeights(20);
  h.sync(rowsOf(5), 20);
  h.measure('r3', 3, 44);
  // the same ids, a new array — a collapse and re-expand
  h.sync(rowsOf(5), 20);
  assert.strictEqual(h.heightAt(3), 44);
  assert.strictEqual(h.total(), 20 * 4 + 44);
});

test('an id that moved is re-indexed rather than corrupting the offsets', () => {
  // a measurement in flight when the rows changed: the index the caller has
  // is stale, and applying its delta at that slot would move the wrong row
  const h = new RowHeights(20);
  h.sync(rowsOf(4), 20);
  const moved = [{ id: 'r3' }, { id: 'r0' }, { id: 'r1' }, { id: 'r2' }];
  h.sync(moved, 20);
  assert.strictEqual(h.measure('r3', 3, 60), true, 'stale index, applied');
  h.sync(moved, 20); // the rebuild the mismatch asked for
  assert.strictEqual(h.heightAt(0), 60, 'r3 is row 0 now, and it is 60 tall');
  assert.strictEqual(h.offsetAt(1), 60);
  assert.strictEqual(h.total(), 60 + 20 * 3);
});

test('the estimate changing re-measures nothing but re-totals everything', () => {
  const h = new RowHeights(20);
  const rows = rowsOf(4);
  h.sync(rows, 20);
  h.measure('r0', 0, 100);
  h.sync(rows, 30);
  assert.strictEqual(h.heightAt(0), 100, 'a measured row keeps its height');
  assert.strictEqual(h.total(), 100 + 30 * 3);
});

test('reset forgets measurements and falls back to the estimate', () => {
  const h = new RowHeights(20);
  const rows = rowsOf(3);
  h.sync(rows, 20);
  h.measure('r0', 0, 90);
  assert.strictEqual(h.measuredCount(), 1);
  h.reset();
  h.sync(rows, 20);
  assert.strictEqual(h.measuredCount(), 0);
  assert.strictEqual(h.total(), 60);
});

test('an empty list has no offsets and no total', () => {
  const h = new RowHeights(22);
  h.sync([], 22);
  assert.strictEqual(h.total(), 0);
  assert.strictEqual(h.indexAt(0), 0);
  assert.strictEqual(h.indexAt(1000), 0);
  assert.strictEqual(h.heightAt(0), 0);
});

test('offsets and lookups match the naive implementation, at every size', () => {
  // sizes either side of the powers of two the descent in `indexAt` steps
  // through — 1, 2, 3 and 15/16/17 are where an off-by-one in the tree shows
  for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 33, 100, 257]) {
    const estimate = 20;
    const h = new RowHeights(estimate);
    const rows = rowsOf(n);
    h.sync(rows, estimate);
    const naive = new Naive(n, estimate);

    // deterministic pseudo-random measurements, so a failure is reproducible
    let seed = n * 2654435761;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let k = 0; k < n; k++) {
      if (rand() < 0.4) continue; // some rows stay unmeasured
      const index = Math.floor(rand() * n);
      const height = 8 + Math.floor(rand() * 90);
      h.measure(`r${index}`, index, height);
      naive.heights[index] = height;
    }

    for (let i = 0; i <= n; i++) {
      assert.strictEqual(
        h.offsetAt(i),
        naive.offsetAt(i),
        `offsetAt(${i}) at n=${n}`,
      );
    }
    assert.strictEqual(h.total(), naive.total(), `total at n=${n}`);
    // every boundary, and either side of it
    for (let i = 0; i < n; i++) {
      for (const probe of [
        naive.offsetAt(i),
        naive.offsetAt(i) + 1,
        naive.offsetAt(i + 1) - 1,
      ]) {
        if (probe < 0 || probe >= naive.total()) continue;
        assert.strictEqual(
          h.indexAt(probe),
          naive.indexAt(probe),
          `indexAt(${probe}) at n=${n}`,
        );
      }
    }
    // past the end clamps rather than running off
    assert.strictEqual(
      h.indexAt(naive.total() + 500),
      n - 1,
      `clamp at n=${n}`,
    );
  }
});

test('a hundred thousand rows stay fast enough to scroll', () => {
  // the point of the tree rather than a prefix-sum array: this is what every
  // scroll event pays, and an O(n) offset would be 100k adds per frame
  const n = 100_000;
  const h = new RowHeights(22);
  h.sync(rowsOf(n), 22);
  const started = Date.now();
  for (let k = 0; k < 20_000; k++) {
    const i = (k * 7919) % n;
    h.measure(`r${i}`, i, 20 + (k % 40));
    h.indexAt((k * 977) % h.total());
    h.offsetAt(i);
  }
  const ms = Date.now() - started;
  assert.ok(ms < 2000, `20k measure+lookup rounds took ${ms}ms`);
});
