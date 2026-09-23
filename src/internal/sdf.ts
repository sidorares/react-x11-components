// A label's raster as a signed distance field: what lets one raster serve a
// name at every size a zoom passes through, and a halo of any width. Under
// the GL labels of both `<Map>` (`src/maps/gl/text.ts`) and `<Flow>`
// (`src/flow/gl/text.ts`), which is why it is here rather than in either.
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
// The distance is the exact Euclidean one, started at the edge by what the
// coverage says: an antialiased texel half covered sits on the edge, one a
// quarter covered a quarter of a texel outside it. That sub-texel start is
// what keeps a field set at 16 pixels from drawing a lumpy stroke at 40.
//
// **Only where it can change a byte.** A field is set the first time its
// string is drawn, so its cost is how late a label appears. Outside the
// glyphs the distance is Felzenszwalb and Huttenlocher's linear-time
// transform — but only over the window a field reaches round the ink, the
// rows that hold ink first and then the window's columns, since past the
// reach every byte is 0 and every source is inside it. Inside, a field
// saturates `radius · SDF_CUTOFF` texels in (1.5 at Flow's margin, 2.25 at
// a map's), so the nearest texel less than half covered is found by
// searching the few rings round each texel inside, not by a second
// transform over the whole raster. Byte for byte what the two whole
// transforms gave, at half the cost: measured over DirectWrite's coverage
// of 520 labels, 262 → 140 µs a field at Flow's margin and 626 → 311 at a
// map's.

/** The fraction of the byte range spent inside the glyphs. */
export const SDF_CUTOFF = 0.25;

/** The byte value of the glyphs' edge, as a fraction: `1 − SDF_CUTOFF`. */
export const SDF_EDGE = 1 - SDF_CUTOFF;

/**
 * Device pixels outside a field's outline that its ink's edge is drawn. A
 * text engine darkens stems at small sizes; a field thresholded at half
 * coverage gives that back, and a string drawn from one looks a weight
 * lighter than the same string set. Both GL label shaders draw it.
 */
export const SDF_INK_BIAS_PX = 0.15;

/** "No edge in reach": far past any raster's squared diagonal, and small
 *  enough that `FAR + q²` is still exact in a double, so two of them cross
 *  where two parabolas of one height do. */
const FAR = 1e10;

/**
 * Each coverage byte's squared distance to the edge *inside* its own
 * texel: (a − ½)² where more than half covered, 0 where not — a texel less
 * than half covered is outside, where an inside distance ends — and FAR
 * where whole.
 */
const INSIDE = new Float64Array(256);
for (let a8 = 1; a8 < 255; a8++) {
  const d = 0.5 - a8 / 255;
  INSIDE[a8] = d < 0 ? d * d : 0;
}
INSIDE[255] = FAR;

/** Scratch, grown to the largest raster seen and reused. */
let outer = new Float64Array(0);
let f = new Float64Array(0);
let g = new Float64Array(0);
let z = new Float64Array(0);
let v = new Int32Array(0);

function grow(texels: number, line: number): void {
  if (outer.length < texels) outer = new Float64Array(texels);
  if (f.length < line) {
    f = new Float64Array(line);
    g = new Float64Array(line);
    z = new Float64Array(line + 1);
    v = new Int32Array(line);
  }
}

/**
 * The squared distance transform of `length` values of `grid` from
 * `offset`, `stride` apart, in place: each becomes the least
 * `grid[r] + (q − r)²` — the lower envelope of parabolas rooted at every
 * texel. `g` holds each parabola's `grid[r] + r²`, so where two cross is
 * one division.
 */
function transform1d(
  grid: Float64Array,
  offset: number,
  stride: number,
  length: number,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  f[0] = grid[offset];
  g[0] = f[0];
  for (let q = 1, at = offset + stride; q < length; q++, at += stride) {
    const fq = grid[at];
    f[q] = fq;
    const gq = fq + q * q;
    g[q] = gq;
    let s: number;
    for (;;) {
      const r = v[k];
      s = (gq - g[r]) / (2 * (q - r));
      if (s > z[k] || k === 0) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0, at = offset; q < length; q++, at += stride) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const d = q - r;
    grid[at] = f[r] + d * d;
  }
}

/**
 * The field of a `width` × `height` raster whose coverage is `alpha`
 * (0-255), read every `step` bytes from `start` — so an RGBA readback is
 * read in place, `step` 4 and `start` 3, and an engine's own coverage with
 * `step` 1 and `start` 0. One byte a texel, see the top of this file for
 * the encoding.
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
  // Zeroed: a byte nothing below writes is as far outside as a field sees.
  const out = new Uint8Array(texels);
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0, i = 0, a = start; y < height; y++) {
    for (let x = 0; x < width; x++, i++, a += step) {
      const a8 = alpha[a];
      if (a8 === 0) {
        outer[i] = FAR;
        continue;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (a8 === 255) {
        outer[i] = 0;
        continue;
      }
      // Partly covered: on the edge, off it by how far from half covered.
      const d = 0.5 - a8 / 255;
      outer[i] = d > 0 ? d * d : 0;
    }
  }
  if (maxX < 0) return out;

  // Outside: the window the field reaches round the ink. Every source is
  // in it, so what the transform computes there is exact, and past it every
  // byte is 0. The rows with ink first — every source is on one — then
  // every column of the window.
  const reach = Math.ceil(radius * (1 - SDF_CUTOFF)) + 1;
  const x0 = Math.max(0, minX - reach);
  const x1 = Math.min(width - 1, maxX + reach);
  const y0 = Math.max(0, minY - reach);
  const y1 = Math.min(height - 1, maxY + reach);
  for (let y = minY; y <= maxY; y++) {
    transform1d(outer, y * width + x0, 1, x1 - x0 + 1);
  }
  for (let x = x0; x <= x1; x++) {
    transform1d(outer, y0 * width + x, width, y1 - y0 + 1);
  }

  // Inside, the field saturates this many rings in.
  const deep = Math.ceil(radius * SDF_CUTOFF);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0, i = y * width + x0; x <= x1; x++, i++) {
      // Outside the ink, or in it: never both.
      const o = outer[i];
      let d: number;
      if (o > 0) {
        d = Math.sqrt(o);
      } else {
        // The least (a − ½)² + distance² over the texels round it, ring by
        // ring, until no ring further out could be nearer — or the field
        // has saturated, where the exact answer and this one are both 255.
        let best = INSIDE[alpha[start + i * step]];
        for (let k = 1; k <= deep && best > k * k; k++) {
          for (let yy = y - k; yy <= y + k; yy++) {
            if (yy < 0 || yy >= height) continue;
            const dy2 = (yy - y) * (yy - y);
            // a ring's top and bottom rows whole, its sides two texels
            const across = yy === y - k || yy === y + k ? 1 : 2 * k;
            for (let xx = x - k; xx <= x + k; xx += across) {
              if (xx < 0 || xx >= width) continue;
              const dx = xx - x;
              const m =
                INSIDE[alpha[start + (yy * width + xx) * step]] + dx * dx + dy2;
              if (m < best) best = m;
            }
          }
        }
        d = -Math.sqrt(best);
      }
      const value = Math.round(255 - 255 * (d / radius + SDF_CUTOFF));
      out[i] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
  }
  return out;
}
