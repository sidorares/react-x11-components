// Where every row starts, when rows are not all the same height.
//
// **Shared between `<Tree>` and `<Table>`** — the one piece of machinery
// both virtualizers stand on, promoted here from the vendored copy the
// table briefly carried (docs/prd-table.md records the decision). "No
// component imports another component" holds: this is shared code, not a
// component, and both import it.
//
// **Deliberately not a shared *module*.** The directory has no `index.ts`,
// so it has no subpath, no docs page, and is not public API — the repo's
// guards (`test/docs.test.ts`, `scripts/check-package.ts`) key on
// `src/<name>/index.ts`, and that is the seam this uses. The day an app
// outside this package needs a height index of its own, the promotion is
// mechanical: give the directory an `index.ts` and the full shared-module
// treatment (subpath, page, barrel), the way `richtext` has it.
//
// The id-keying earns its place twice: in the tree a measured height
// survives a collapse and re-expand, and in the table it survives a
// **re-sort** — the permutation rebuilds offsets without remeasuring a
// single row.
//
// A fixed-height list needs no structure at all: row `i` is at `i * h`, and
// the row at offset `y` is `y / h`. That one multiplication is the whole
// reason fixed-height virtualization is easy, and it is what this file
// replaces — because a tree row wraps, carries two lines, or is whatever a
// render seam returned, and demanding that they all match would be the
// component telling the application what its data may look like.
//
// What replaces it has to answer three questions on every scroll, over a
// list that may be a hundred thousand rows long:
//
//   - where does row `i` start?           `offsetAt`
//   - which row is at offset `y`?         `indexAt`
//   - how tall is the whole thing?        `total`
//
// A prefix-sum array answers the first and third in O(1) but costs O(n) per
// measurement, and measurements arrive in bursts — every row that scrolls
// into view is one. A Fenwick tree (binary indexed tree) answers all three in
// O(log n) and updates in O(log n), which is what makes "measure the rows
// that just appeared, then re-render" affordable at any size.

/** What a row is keyed by. `TreeItemId` and `TableRowId` are both this
 *  type; keeping it structural here is what lets each component keep its
 *  own vocabulary. */
export type RowKey = string | number;

/** All this needs of a row. Taking the rows themselves rather than an array
 *  of ids is what keeps `sync` free on a re-render: the component already
 *  memoizes the row list, so identity alone says "nothing moved". */
interface Keyed {
  id: RowKey;
}

/**
 * The heights of the rows, and where each one starts.
 *
 * Mutable and long-lived: one of these belongs to a component for as long
 * as it is mounted, and `sync` re-points it at the rows a render is about
 * to draw. It is deliberately **not** React state — a measurement pass
 * touches it once per rendered row and the component re-renders once, on a
 * version counter, and only when something actually moved.
 */
export class RowHeights {
  /** Measured heights, by row id. Survives `sync`. */
  private readonly measured = new Map<RowKey, number>();
  /** The rows currently indexed, in draw order. */
  private rows: readonly Keyed[] = [];
  /** Fenwick tree over the heights, 1-based. */
  private tree: number[] = [0];
  /** What an unmeasured row is assumed to be. */
  private estimate = 1;
  /** Largest power of two <= n, for the O(log n) descent in `indexAt`. */
  private power = 0;
  /** Set when a measurement could not be applied in place, so the next
   *  `sync` must rebuild even though the row list did not change. */
  private dirty = false;

  constructor(estimate: number) {
    this.estimate = Math.max(1, estimate);
  }

  private heightOf(index: number): number {
    const measured = this.measured.get(this.rows[index].id);
    return measured === undefined ? this.estimate : measured;
  }

  /**
   * Point the index at the rows about to be drawn.
   *
   * Rebuilt rather than patched, and cheap to call on every render: the row
   * list is memoized, so the common case is an identity check. When it does
   * rebuild it is O(n) — the rows change when a branch opens, when items
   * arrive, when a sort flips, when a filter runs, all O(n) events already.
   */
  sync(rows: readonly Keyed[], estimate: number): void {
    const next = Math.max(1, estimate);
    if (!this.dirty && this.rows === rows && next === this.estimate) return;
    this.dirty = false;
    this.rows = rows;
    this.estimate = next;
    const n = rows.length;
    // Build in O(n): write each height at its own slot, then push every slot
    // into its parent. The textbook loop of point-updates is O(n log n) and
    // arrives at the same tree.
    const tree = new Array<number>(n + 1).fill(0);
    for (let i = 0; i < n; i++) tree[i + 1] = this.heightOf(i);
    for (let i = 1; i <= n; i++) {
      const parent = i + (i & -i);
      if (parent <= n) tree[parent] += tree[i];
    }
    this.tree = tree;
    this.power = n > 0 ? 1 << Math.floor(Math.log2(n)) : 0;
  }

  /**
   * Record what a row actually laid out at. Returns whether this changed
   * anything — which is what tells the component whether to re-render, and
   * the reason a measurement pass that finds nothing new costs nothing.
   */
  measure(id: RowKey, index: number, height: number): boolean {
    if (!(height > 0)) return false;
    const before = this.measured.get(id);
    if (before === height) return false;
    this.measured.set(id, height);
    if (this.rows[index]?.id !== id) {
      // The caller's index is stale — the rows moved under a measurement
      // that was already in flight. Applying a delta at the wrong slot would
      // corrupt every offset after it, so the tree is rebuilt instead.
      this.dirty = true;
      return true;
    }
    const delta = height - (before === undefined ? this.estimate : before);
    if (delta === 0) return false;
    for (let i = index + 1; i < this.tree.length; i += i & -i) {
      this.tree[i] += delta;
    }
    return true;
  }

  /** What a row measured, or the estimate if it has not been seen. */
  heightAt(index: number): number {
    return index >= 0 && index < this.rows.length ? this.heightOf(index) : 0;
  }

  /** Whether this row has a real measurement rather than an estimate. */
  isMeasured(index: number): boolean {
    const row = this.rows[index];
    return row !== undefined && this.measured.has(row.id);
  }

  /** Where row `index` starts. `offsetAt(rowCount)` is the total. */
  offsetAt(index: number): number {
    let sum = 0;
    for (
      let i = Math.max(0, Math.min(index, this.rows.length));
      i > 0;
      i -= i & -i
    ) {
      sum += this.tree[i];
    }
    return sum;
  }

  /** How tall the whole list is — what the scrollbar measures. */
  total(): number {
    return this.offsetAt(this.rows.length);
  }

  /**
   * The row containing `offset`, clamped into the list.
   *
   * A descent down the tree rather than a binary search over `offsetAt`,
   * which would be O(log² n) — this is the operation every scroll performs,
   * twice.
   */
  indexAt(offset: number): number {
    const n = this.rows.length;
    if (n === 0) return 0;
    let index = 0;
    let remaining = offset;
    for (let step = this.power; step > 0; step >>= 1) {
      const next = index + step;
      if (next <= n && this.tree[next] <= remaining) {
        index = next;
        remaining -= this.tree[next];
      }
    }
    return Math.max(0, Math.min(n - 1, index));
  }

  /** How many of the current rows have a real measurement. */
  measuredCount(): number {
    let count = 0;
    for (const row of this.rows) if (this.measured.has(row.id)) count++;
    return count;
  }

  /**
   * Forget every measurement, keeping the row list.
   *
   * For a change that invalidates heights wholesale rather than row by row.
   * Nothing calls it for new items — their ids are simply not in the map yet
   * — and nothing calls it on a resize either: rows re-measure as they are
   * drawn, and throwing away the heights of rows whose content does not
   * depend on the width would make the scrollbar worse, not better.
   */
  reset(): void {
    this.measured.clear();
    this.dirty = true;
  }
}
