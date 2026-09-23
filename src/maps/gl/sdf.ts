// A label's raster as a signed distance field: what lets one raster serve a
// name at every size its zoom ramp passes through, and a halo of any width.
//
// The text engine sets a string as coverage — alpha, antialiased — at one
// base size. Each texel here becomes its distance to the glyphs' edge,
// encoded in a byte so that `SDF_EDGE` is the edge itself, more is inside
// and less is outside:
//
//   byte = 255 · (1 − d / radius − SDF_CUTOFF),   d > 0 outside
//
// so a field reaches `radius · (1 − SDF_CUTOFF)` texels past the glyphs
// before it saturates at 0 — the room a halo has to grow into — and
// `radius · SDF_CUTOFF` into them.
//
// The distance is the exact Euclidean one, from two passes of Felzenszwalb
// and Huttenlocher's linear-time transform (one for the texels outside the
// glyphs, one for those inside), started at the edge by what the coverage
// says: an antialiased texel half covered sits on the edge, one a quarter
// covered a quarter of a texel outside it. That sub-texel start is what
// keeps a field set at 16 pixels from drawing a lumpy stroke at 40.

/** The fraction of the byte range spent inside the glyphs. */
export const SDF_CUTOFF = 0.25;

/** The byte value of the glyphs' edge, as a fraction: `1 − SDF_CUTOFF`. */
export const SDF_EDGE = 1 - SDF_CUTOFF;

/** Large enough to be "no edge in reach", small enough that the transform's
 *  arithmetic on it never becomes `Infinity − Infinity`. */
const FAR = 1e20;

/** Scratch, grown to the largest raster seen and reused. */
let outer = new Float64Array(0);
let inner = new Float64Array(0);
let f = new Float64Array(0);
let z = new Float64Array(0);
let v = new Uint16Array(0);

function grow(texels: number, line: number): void {
  if (outer.length < texels) {
    outer = new Float64Array(texels);
    inner = new Float64Array(texels);
  }
  if (f.length < line) {
    f = new Float64Array(line);
    z = new Float64Array(line + 1);
    v = new Uint16Array(line);
  }
}

/**
 * The squared distance transform of one row or column of `grid`, in place:
 * each value becomes the least `grid[r] + (q − r)²` over the line — the
 * lower envelope of parabolas rooted at every texel.
 */
function transform1d(
  grid: Float64Array,
  offset: number,
  stride: number,
  length: number,
): void {
  v[0] = 0;
  z[0] = -FAR;
  z[1] = FAR;
  f[0] = grid[offset];
  let k = 0;
  for (let q = 1; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    let s: number;
    for (;;) {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
      if (s > z[k] || k === 0) break;
      k--;
    }
    if (s <= z[k]) {
      // Only reachable with k at 0: this parabola wins everywhere so far.
      v[0] = q;
      z[0] = -FAR;
      z[1] = FAR;
      continue;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = FAR;
  }
  k = 0;
  for (let q = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const d = q - r;
    grid[offset + q * stride] = f[r] + d * d;
  }
}

function transform2d(grid: Float64Array, width: number, height: number): void {
  for (let x = 0; x < width; x++) transform1d(grid, x, width, height);
  for (let y = 0; y < height; y++) transform1d(grid, y * width, 1, width);
}

/**
 * The field of a `width` × `height` raster whose coverage is `alpha`
 * (0-255), read every `step` bytes from `start` — so an RGBA readback is
 * read in place, `step` 4 and `start` 3. One byte a texel, see the top of
 * this file for the encoding.
 */
export function distanceField(
  alpha: Uint8Array,
  width: number,
  height: number,
  radius: number,
  step = 4,
  start = 3,
): Uint8Array {
  const texels = width * height;
  grow(texels, Math.max(width, height));
  for (let i = 0; i < texels; i++) {
    const a = alpha[start + i * step] / 255;
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = FAR;
    } else if (a <= 0) {
      outer[i] = FAR;
      inner[i] = 0;
    } else {
      // Partly covered: on the edge, off it by how far from half covered.
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  transform2d(outer, width, height);
  transform2d(inner, width, height);
  const out = new Uint8Array(texels);
  for (let i = 0; i < texels; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    const value = Math.round(255 - 255 * (d / radius + SDF_CUTOFF));
    out[i] = value < 0 ? 0 : value > 255 ? 255 : value;
  }
  return out;
}
