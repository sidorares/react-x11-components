// The big datasets the chart examples draw, shared: examples/charts.tsx
// tours them one chart at a time, and examples/flow-stress.tsx puts them in
// two hundred node bodies at once. Made on first use and kept, so an example
// that never shows one never pays for it, and two hundred charts over the
// same points hold one copy.

/** A million-point random walk with slow waves on it — enough structure
 *  that a zoom shows something new at every level. */
export const MILLION = 1_000_000;

/** The 200k points of a three-armed gaussian cloud. */
export const CLOUD = 200_000;

export interface ColumnData {
  length: number;
  columns: Record<string, Float64Array>;
}

let walk: ColumnData | null = null;
let cloud: ColumnData | null = null;

/** `{ walk }`: the million-point random walk, indexed by position. */
export function millionData(): ColumnData {
  if (walk) return walk;
  const values = new Float64Array(MILLION);
  let v = 0;
  for (let i = 0; i < MILLION; i++) {
    v += (Math.random() - 0.5) * 2;
    values[i] =
      v +
      40 * Math.sin(i / 40_000) +
      8 * Math.sin(i / 900) * Math.sin(i / 90_000);
  }
  walk = { length: MILLION, columns: { walk: values } };
  return walk;
}

/** `{ x, y }`: 200,000 scattered points in three arms. */
export function cloudData(): ColumnData {
  if (cloud) return cloud;
  const x = new Float64Array(CLOUD);
  const y = new Float64Array(CLOUD);
  const gauss = () =>
    (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;
  for (let i = 0; i < CLOUD; i++) {
    const arm = i % 3;
    x[i] = gauss() * 30 + (arm - 1) * 45;
    y[i] = gauss() * 22 + (arm - 1) * 18 + x[i] * 0.25;
  }
  cloud = { length: CLOUD, columns: { x, y } };
  return cloud;
}
