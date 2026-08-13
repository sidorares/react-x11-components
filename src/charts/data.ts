// The data layer under `<chartplot>`: column resolution over the three
// accepted data shapes, the streaming `ChartData` store, and the min/max
// pyramid that makes paint cost a function of pixels rather than points.
//
// Everything here is pure JavaScript over plain values — no react-x11, no
// ntk — so the whole layer is unit-testable without a display, and the
// renderers stay the only code that knows what a drawing command is.
//
// ## Identity is the cache key, and appends are the one allowed mutation
//
// Preparation artifacts (pyramids, x-column indexes) are cached in WeakMaps
// keyed on a per-column host object, with `{epoch, n}` versioning:
//
//  - a plain rows array or a columnar object is treated as immutable except
//    for *growing* — same identity with a larger length extends the caches
//    incrementally; a same-length change is invisible, which is the usual
//    immutable-data contract React apps already live by;
//  - `ChartData` is the sanctioned mutable store: it versions itself, its
//    caches ride the per-column state objects (stable across compaction),
//    and its `epoch` bump is what invalidates them after a window shift.
//
// Getting this wrong fails as a stale chart, so the rule is stated here
// once: **mutate history only through `ChartData`**.

/** One row, shadcn-style: `{ month: 'Jan', desktop: 186 }`. */
export type ChartRow = Record<string, unknown>;

/** Columnar input — the fast path. Arrays may be typed arrays; a column may
 * hold strings (a category axis). `length` bounds every column. */
export interface ColumnarData {
  length: number;
  columns: Record<string, ArrayLike<number> | ArrayLike<string>>;
}

/**
 * The streaming store's contract, written structurally — deliberately not
 * `typeof ChartData`. Structural, so a JSX augmentation carrying it
 * unifies across the src/dist boundary (a class with private state would
 * not), and so an app can bring its own store: anything that answers
 * columns and announces appends is a chart data source.
 */
export interface ChartDataLike {
  readonly length: number;
  /** Bumps when history shifts; derived caches rebuild then. */
  readonly epoch: number;
  column(key: string): ResolvedColumn | null;
  subscribe(listener: (change: ChartDataChange) => void): () => void;
}

/** What `data` accepts: rows, columns, or a streaming store. */
export type ChartSourceData =
  readonly ChartRow[] | ColumnarData | ChartDataLike;

export function isChartDataLike(data: ChartSourceData): data is ChartDataLike {
  return (
    !Array.isArray(data) &&
    typeof (data as ChartDataLike).column === 'function' &&
    typeof (data as ChartDataLike).subscribe === 'function'
  );
}

/** A resolved column: raw storage, the valid length (storage may hold slack
 * capacity), and the identity/version pair the caches key on. */
export interface ResolvedColumn {
  values: ArrayLike<number> | ArrayLike<string>;
  n: number;
  /** Cache identity — WeakMap key. Stable for the life of the column. */
  host: object;
  /** Bumps when history changed under the same host (a window shift). */
  epoch: number;
  numeric: boolean;
}

/** A resolved numeric column, which is what every renderer consumes. */
export interface NumericColumn extends ResolvedColumn {
  values: ArrayLike<number>;
  numeric: true;
}

const isColumnar = (d: ChartSourceData): d is ColumnarData =>
  typeof (d as ColumnarData).length === 'number' &&
  !!(d as ColumnarData).columns &&
  !Array.isArray(d);

// --- rows → columns --------------------------------------------------------

interface RowsCacheEntry {
  /** how many rows were extracted; same-identity growth re-extracts the tail */
  n: number;
  values: Float64Array | string[];
  numeric: boolean;
}

/** Extracted columns per rows-array identity. WeakMap, so dropping the data
 * drops the extraction. */
const rowsCache = new WeakMap<object, Map<string, RowsCacheEntry>>();

/** Per-host growable Float64 push. Doubling keeps append O(1) amortized. */
function grow(arr: Float64Array, need: number): Float64Array {
  if (need <= arr.length) return arr;
  const next = new Float64Array(Math.max(need, arr.length * 2, 64));
  next.set(arr);
  return next;
}

function extractRows(
  rows: readonly ChartRow[],
  key: string,
): RowsCacheEntry | null {
  let perKey = rowsCache.get(rows);
  if (!perKey) rowsCache.set(rows, (perKey = new Map()));
  let entry = perKey.get(key);
  const n = rows.length;
  if (entry && entry.n === n) return entry;
  if (!entry) {
    // sniff the type from the first present value; a column that never
    // shows the key at all is "not there" rather than all-NaN
    let numeric: boolean | null = null;
    for (let i = 0; i < n; i++) {
      const v = rows[i]?.[key];
      if (v == null) continue;
      numeric = typeof v !== 'string';
      break;
    }
    if (numeric === null) return null;
    entry = {
      n: 0,
      numeric,
      values: numeric ? new Float64Array(Math.max(n, 64)) : [],
    };
    perKey.set(key, entry);
  }
  if (entry.numeric) {
    let values = entry.values as Float64Array;
    values = grow(values, n);
    for (let i = entry.n; i < n; i++) {
      const v = rows[i]?.[key];
      values[i] = typeof v === 'number' ? v : NaN;
    }
    entry.values = values;
  } else {
    const values = entry.values as string[];
    for (let i = entry.n; i < n; i++) {
      const v = rows[i]?.[key];
      values.push(v == null ? '' : String(v));
    }
  }
  entry.n = n;
  return entry;
}

/**
 * The column `key` names in `data`, or null when there is none. Cheap to
 * call every paint: each shape resolves through an identity-keyed cache.
 */
export function resolveColumn(
  data: ChartSourceData,
  key: string,
): ResolvedColumn | null {
  if (isChartDataLike(data)) return data.column(key);
  if (isColumnar(data)) {
    const values = data.columns[key];
    if (!values) return null;
    const n = Math.min(data.length, values.length);
    const numeric = typeof values[0] !== 'string';
    return { values, n, host: values as object, epoch: 0, numeric };
  }
  const rows = data as readonly ChartRow[];
  const entry = extractRows(rows, key);
  if (!entry) return null;
  return {
    values: entry.numeric
      ? (entry.values as Float64Array).subarray(0, entry.n)
      : entry.values,
    n: entry.n,
    host: rows as object,
    epoch: 0,
    numeric: entry.numeric,
  };
}

/** Narrow to numeric, which is what scales and pyramids need. */
export function numericColumn(
  col: ResolvedColumn | null,
): NumericColumn | null {
  return col && col.numeric ? (col as NumericColumn) : null;
}

// --- the streaming store ---------------------------------------------------

interface StoreColumn {
  key: string;
  numeric: boolean;
  values: Float64Array | string[];
  /** the cache identity for this column — survives compaction */
  host: object;
}

export interface ChartDataOptions {
  /** Keep at most this many points, dropping the oldest. The drop happens
   * in occasional batches (12.5% slack), so appends stay O(1) and the
   * expensive re-preparation is amortized over many frames. */
  maxLength?: number;
}

export interface ChartDataChange {
  appended: number;
  /** History moved (a window shift): everything derived must rebuild. */
  epoch: number;
}

/**
 * The streaming data store: append-only columns in growable typed arrays.
 *
 * This is the "proper data structures and preparations" half of the
 * performance story. Charts subscribing to a store never rescan history —
 * an append extends the decimation pyramids incrementally and invalidates
 * nothing, so a 10Hz feed into a million-point series stays O(appended)
 * per tick plus one bounded repaint per visible chart.
 */
export class ChartData {
  private _cols = new Map<string, StoreColumn>();
  private _n = 0;
  private _epoch = 0;
  private _listeners = new Set<(change: ChartDataChange) => void>();
  private readonly _maxLength: number;

  constructor(options: ChartDataOptions = {}) {
    this._maxLength = Math.max(2, options.maxLength ?? Infinity);
  }

  get length(): number {
    return this._n;
  }

  /** Bumps when history shifts; caches keyed on it rebuild then. */
  get epoch(): number {
    return this._epoch;
  }

  /** Append one row. Keys never seen before backfill NaN (numeric) or ''
   * so every column always covers every index. */
  append(row: Readonly<Record<string, number | string>>): void {
    this.appendRows([row]);
  }

  /**
   * Drop every row, keeping the columns and their storage. The reset every
   * live dashboard eventually wants: a stream resuming after its process
   * was suspended (a hidden window, a laptop lid) comes back with a time
   * gap as wide as the sleep, and a windowed store then renders fifty
   * seconds of data squeezed beside fourteen minutes of nothing until the
   * gap evicts. Clearing on resume starts the window honestly instead.
   *
   * An epoch bump, so every cache keyed on `{epoch, n}` — pyramids, x
   * indexes, scatter grids — rebuilds, through the same invalidation a
   * window shift already exercises.
   */
  clear(): void {
    if (this._n === 0) return;
    // numeric storage is reused (reads are capped by n); string columns
    // append with push, so their arrays must actually empty
    for (const col of this._cols.values()) {
      if (!col.numeric) (col.values as string[]).length = 0;
    }
    this._n = 0;
    this._epoch++;
    this._notify(0);
  }

  /** Append many rows in one notification. */
  appendRows(rows: readonly Readonly<Record<string, number | string>>[]): void {
    if (rows.length === 0) return;
    for (const row of rows) {
      for (const key of Object.keys(row)) this._ensureColumn(key, row[key]);
      const at = this._n;
      for (const col of this._cols.values()) {
        const v = row[col.key];
        if (col.numeric) {
          let values = col.values as Float64Array;
          values = grow(values, at + 1);
          values[at] = typeof v === 'number' ? v : NaN;
          col.values = values;
        } else {
          (col.values as string[]).push(v == null ? '' : String(v));
        }
      }
      this._n = at + 1;
    }
    const shifted = this._enforceWindow();
    this._notify(shifted ? 0 : rows.length);
  }

  private _ensureColumn(key: string, sample: unknown): void {
    if (this._cols.has(key)) return;
    const numeric = typeof sample !== 'string';
    const col: StoreColumn = {
      key,
      numeric,
      values: numeric ? new Float64Array(Math.max(this._n + 1, 64)) : [],
      host: { key },
    };
    if (numeric) (col.values as Float64Array).fill(NaN, 0, this._n);
    else for (let i = 0; i < this._n; i++) (col.values as string[]).push('');
    this._cols.set(key, col);
  }

  /** Drop the oldest points once the window is exceeded by its slack.
   * Returns true when history moved. */
  private _enforceWindow(): boolean {
    const limit = this._maxLength;
    if (!Number.isFinite(limit) || this._n <= limit * 1.125) return false;
    const drop = this._n - limit;
    for (const col of this._cols.values()) {
      if (col.numeric) {
        const values = col.values as Float64Array;
        values.copyWithin(0, drop, this._n);
      } else {
        (col.values as string[]).splice(0, drop);
      }
    }
    this._n -= drop;
    this._epoch++;
    return true;
  }

  column(key: string): ResolvedColumn | null {
    const col = this._cols.get(key);
    if (!col) return null;
    return {
      values: col.numeric
        ? (col.values as Float64Array).subarray(0, this._n)
        : (col.values as string[]),
      n: this._n,
      host: col.host,
      epoch: this._epoch,
      numeric: col.numeric,
    };
  }

  /** Hear about appends and window shifts. Returns the unsubscribe. */
  subscribe(listener: (change: ChartDataChange) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _notify(appended: number): void {
    const change = { appended, epoch: this._epoch };
    for (const listener of [...this._listeners]) listener(change);
  }
}

// --- the min/max pyramid ---------------------------------------------------

/** Base block size. 16 keeps total pyramid memory at ~1/4 of the column
 * (2 values per block, halving per level) while capping the raw-scan edges
 * of any query at 15 points a side. */
const BASE = 16;
const BASE_SHIFT = 4;

interface PyramidLevel {
  /** points per block at this level: BASE << k */
  size: number;
  mins: Float64Array;
  maxs: Float64Array;
  /** blocks currently valid (the last one may cover a partial tail, and is
   * correct *for its coverage* — see extend) */
  blocks: number;
}

export interface Pyramid {
  builtN: number;
  epoch: number;
  levels: PyramidLevel[];
}

const pyramids = new WeakMap<object, Pyramid>();

function growLevel(level: PyramidLevel, blocks: number): void {
  if (blocks <= level.mins.length) return;
  const cap = Math.max(blocks, level.mins.length * 2, 8);
  const mins = new Float64Array(cap);
  const maxs = new Float64Array(cap);
  mins.set(level.mins);
  maxs.set(level.maxs);
  level.mins = mins;
  level.maxs = maxs;
}

/**
 * Recompute the blocks of every level that the growth from `fromN` to `n`
 * touched. Level 1 reads raw values; every higher level reads the two
 * blocks below it — a partial lower block is correct for its coverage, so
 * the parent combining it is correct for *its* coverage too, which is the
 * invariant that makes incremental extension safe.
 */
function extendPyramid(
  pyr: Pyramid,
  values: ArrayLike<number>,
  n: number,
): void {
  const fromN = pyr.builtN;
  if (n <= fromN) return;

  // make sure enough levels exist that the top is a single block
  let topSize = pyr.levels.length
    ? pyr.levels[pyr.levels.length - 1].size
    : BASE >> 1;
  while (topSize < n) {
    topSize <<= 1;
    pyr.levels.push({
      size: topSize,
      mins: new Float64Array(0),
      maxs: new Float64Array(0),
      blocks: 0,
    });
  }

  for (let k = 0; k < pyr.levels.length; k++) {
    const level = pyr.levels[k];
    const size = level.size;
    const first = Math.floor(fromN / size);
    const last = Math.floor((n - 1) / size);
    growLevel(level, last + 1);
    for (let b = first; b <= last; b++) {
      let min = Infinity;
      let max = -Infinity;
      if (k === 0) {
        const end = Math.min((b + 1) * size, n);
        for (let i = b * size; i < end; i++) {
          const v = values[i];
          // explicit comparisons skip NaN without poisoning the block
          if (v < min) min = v;
          if (v > max) max = v;
        }
      } else {
        const below = pyr.levels[k - 1];
        const b0 = b * 2;
        const b1 = b0 + 1;
        if (b0 < below.blocks) {
          if (below.mins[b0] < min) min = below.mins[b0];
          if (below.maxs[b0] > max) max = below.maxs[b0];
        }
        if (b1 < below.blocks) {
          if (below.mins[b1] < min) min = below.mins[b1];
          if (below.maxs[b1] > max) max = below.maxs[b1];
        }
      }
      level.mins[b] = min;
      level.maxs[b] = max;
    }
    level.blocks = last + 1;
  }
  pyr.builtN = n;
}

/**
 * The pyramid for a numeric column, built on first use and extended in
 * place as the column grows. An epoch change rebuilds from scratch —
 * history moved, and no incremental repair is worth the bug surface.
 */
export function pyramidFor(col: NumericColumn): Pyramid {
  let pyr = pyramids.get(col.host);
  if (!pyr || pyr.epoch !== col.epoch) {
    pyr = { builtN: 0, epoch: col.epoch, levels: [] };
    pyramids.set(col.host, pyr);
  }
  extendPyramid(pyr, col.values, col.n);
  return pyr;
}

/** Reusable min/max result — renderers call this per pixel column, and a
 * fresh object per call would be a million allocations a second. */
export interface MinMax {
  min: number;
  max: number;
}

/**
 * Exact min/max over `[i0, i1)`, in O(log) block reads plus ≤15 raw points
 * at each edge: greedy decomposition over the aligned blocks that fit, the
 * way a sparse segment tree answers range queries. `out.min > out.max`
 * means the range held no finite value (a gap).
 */
export function minMaxRange(
  pyr: Pyramid,
  values: ArrayLike<number>,
  i0: number,
  i1: number,
  out: MinMax,
): void {
  let min = Infinity;
  let max = -Infinity;
  let i = i0;
  // raw leading edge up to base-block alignment
  const firstAligned = Math.min(i1, (i + BASE - 1) & ~(BASE - 1));
  for (; i < firstAligned; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // aligned middle: the biggest block that starts here and fits
  while (i + BASE <= i1) {
    let k = 0;
    let size = BASE;
    while (
      k + 1 < pyr.levels.length &&
      i % (size << 1) === 0 &&
      i + (size << 1) <= i1
    ) {
      k++;
      size <<= 1;
    }
    const level = pyr.levels[k];
    const b = i >> (BASE_SHIFT + k);
    if (level.mins[b] < min) min = level.mins[b];
    if (level.maxs[b] > max) max = level.maxs[b];
    i += size;
  }
  // raw trailing edge
  for (; i < i1; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  out.min = min;
  out.max = max;
}

// --- the x-column index ----------------------------------------------------

export interface XIndex {
  builtN: number;
  epoch: number;
  /** non-decreasing so far — what makes binary search legal */
  sorted: boolean;
  /** evenly spaced so far — what makes column→index arithmetic */
  uniform: boolean;
  x0: number;
  dx: number;
  min: number;
  max: number;
}

const xIndexes = new WeakMap<object, XIndex>();

/** |observed − predicted| tolerated before "uniform" is given up, relative
 * to the step. Covers float noise in generated timestamps without letting a
 * genuinely ragged series pretend. */
const UNIFORM_TOL = 1e-6;

function extendXIndex(idx: XIndex, values: ArrayLike<number>, n: number): void {
  let i = idx.builtN;
  if (n <= i) return;
  if (i === 0) {
    idx.x0 = values[0];
    idx.dx = NaN;
    idx.min = Infinity;
    idx.max = -Infinity;
    i = 0;
  }
  let prev = i > 0 ? values[i - 1] : -Infinity;
  for (; i < n; i++) {
    const v = values[i];
    if (Number.isNaN(v)) {
      // a hole in x breaks both properties at once; there is no honest
      // position for the points after it
      idx.sorted = false;
      idx.uniform = false;
    } else {
      if (v < prev) idx.sorted = false;
      if (idx.uniform && i > 0) {
        if (Number.isNaN(idx.dx)) idx.dx = v - idx.x0;
        const predicted = idx.x0 + idx.dx * i;
        const tol = Math.abs(idx.dx) * UNIFORM_TOL + 1e-12;
        if (Math.abs(v - predicted) > tol) idx.uniform = false;
      }
      if (v < idx.min) idx.min = v;
      if (v > idx.max) idx.max = v;
      prev = v;
    }
  }
  // one point, or every step so far identical-to-zero: still "uniform",
  // with a degenerate dx the callers guard against
  idx.builtN = n;
}

/** The sortedness/uniformity/extent record for an x column, incremental
 * like the pyramid. */
export function xIndexFor(col: NumericColumn): XIndex {
  let idx = xIndexes.get(col.host);
  if (!idx || idx.epoch !== col.epoch) {
    idx = {
      builtN: 0,
      epoch: col.epoch,
      sorted: true,
      uniform: true,
      x0: 0,
      dx: NaN,
      min: Infinity,
      max: -Infinity,
    };
    xIndexes.set(col.host, idx);
  }
  extendXIndex(idx, col.values, col.n);
  return idx;
}

/** First index whose value is >= x, over a sorted column. */
export function lowerBound(
  values: ArrayLike<number>,
  n: number,
  x: number,
): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > x, over a sorted column. */
export function upperBound(
  values: ArrayLike<number>,
  n: number,
  x: number,
): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The index range `[i0, i1)` of points whose x falls in `[xMin, xMax]`,
 * widened by one point each side so a line entering the viewport draws its
 * crossing segment. Arithmetic for a uniform column, O(log n) for a sorted
 * one, everything for the rest.
 */
export function visibleIndexRange(
  idx: XIndex,
  values: ArrayLike<number>,
  n: number,
  xMin: number,
  xMax: number,
): [number, number] {
  if (n === 0) return [0, 0];
  let i0: number;
  let i1: number;
  if (idx.uniform && idx.dx > 0) {
    i0 = Math.floor((xMin - idx.x0) / idx.dx);
    i1 = Math.ceil((xMax - idx.x0) / idx.dx) + 1;
  } else if (idx.sorted) {
    i0 = lowerBound(values, n, xMin);
    i1 = upperBound(values, n, xMax);
  } else {
    return [0, n];
  }
  i0 = Math.max(0, i0 - 1);
  i1 = Math.min(n, i1 + 1);
  if (i1 < i0) i1 = i0;
  return [i0, i1];
}

/**
 * The nearest index to x, for tooltip snapping. Sorted columns answer in
 * O(log n); unsorted in O(n) — scatter tooltips over huge unsorted data can
 * live with the miss being approximate instead.
 */
export function nearestIndex(
  idx: XIndex,
  values: ArrayLike<number>,
  n: number,
  x: number,
): number {
  if (n === 0) return -1;
  if (idx.uniform && idx.dx !== 0 && !Number.isNaN(idx.dx)) {
    const i = Math.round((x - idx.x0) / idx.dx);
    return Math.max(0, Math.min(n - 1, i));
  }
  if (idx.sorted) {
    const at = lowerBound(values, n, x);
    if (at <= 0) return 0;
    if (at >= n) return n - 1;
    return x - values[at - 1] <= values[at] - x ? at - 1 : at;
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(values[i] - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// --- stacks ----------------------------------------------------------------

/**
 * Cumulative tops for a stack: `tops[j][i]` is the sum of layers `0..j` at
 * index `i`, NaN treated as 0 so one series' gap does not knock a hole in
 * the layers above it. The arrays are fresh per build; the caller caches by
 * its own version key and hands each layer's array back through
 * `pyramidFor`-compatible columns (a fresh array is its own host).
 */
export function buildStackTops(
  layers: readonly ArrayLike<number>[],
  n: number,
): Float64Array[] {
  const tops: Float64Array[] = [];
  let prev: Float64Array | null = null;
  for (const layer of layers) {
    const top = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = layer[i];
      const below: number = prev ? prev[i] : 0;
      top[i] = below + (typeof v === 'number' && !Number.isNaN(v) ? v : 0);
    }
    tops.push(top);
    prev = top;
  }
  return tops;
}
