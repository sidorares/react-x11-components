// The signed distance field under the GL labels of both `<Map>` and
// `<Flow>` (`src/internal/sdf.ts`): pure arithmetic over a coverage raster,
// asserted with no display.
import { test } from 'node:test';
import assert from 'node:assert';

import { SDF_EDGE, distanceField } from '../src/internal/sdf.js';

/** A coverage raster, alpha only, from a predicate on texel centres. */
function coverage(
  width: number,
  height: number,
  inside: (x: number, y: number) => number,
): Uint8Array {
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) alpha[y * width + x] = inside(x, y);
  return alpha;
}

/** The byte a field holds `d` texels past the edge (negative inside). */
const fieldByte = (d: number, radius: number) =>
  Math.min(
    255,
    Math.max(0, Math.round(255 - 255 * (d / radius + 1 - SDF_EDGE))),
  );

test("a distance field holds each texel's distance to the edge, saturating either side", () => {
  // A 12-texel square, fully covered, in a 32-texel raster.
  const alpha = coverage(32, 32, (x, y) =>
    x >= 10 && x < 22 && y >= 10 && y < 22 ? 255 : 0,
  );
  const field = distanceField(alpha, 32, 32, 8, 1, 0);
  const at = (x: number, y: number) => field[y * 32 + x];
  // Texel centres a whole texel either side of the boundary between them.
  assert.strictEqual(at(10, 16), fieldByte(-1, 8), 'first texel in');
  assert.strictEqual(at(9, 16), fieldByte(1, 8), 'first texel out');
  assert.strictEqual(at(5, 16), fieldByte(5, 8), 'five out');
  // Diagonally off a corner the distance is Euclidean, not a count.
  assert.strictEqual(at(7, 7), fieldByte(3 * Math.SQRT2, 8));
  assert.strictEqual(at(16, 16), 255, 'deep inside saturates');
  assert.strictEqual(at(0, 0), 0, 'far outside saturates');
});

test('a half-covered texel sits on the edge', () => {
  // A column of full coverage, then one half covered: the edge runs
  // through that texel's centre.
  const alpha = coverage(16, 8, (x) => (x < 6 ? 255 : x === 6 ? 128 : 0));
  const field = distanceField(alpha, 16, 8, 8, 1, 0);
  const edge = field[4 * 16 + 6];
  assert.ok(
    Math.abs(edge - 255 * SDF_EDGE) <= 1,
    `the half-covered texel is the edge: ${edge}`,
  );
  // And a texel beyond it is measured from there, not from the full column.
  assert.ok(Math.abs(field[4 * 16 + 8] - fieldByte(2, 8)) <= 1);
});

test('the distance transform is exact against brute force on an irregular shape', () => {
  const w = 24;
  const h = 20;
  let seed = 7;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const blobs = [0, 1, 2, 3].map(() => [rnd() * w, rnd() * h, 2 + rnd() * 4]);
  const alpha = coverage(w, h, (x, y) =>
    blobs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 < r * r)
      ? 255
      : 0,
  );
  const field = distanceField(alpha, w, h, 8, 1, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = alpha[y * w + x] === 255;
      let nearest = Infinity;
      for (let v = 0; v < h; v++)
        for (let u = 0; u < w; u++)
          if ((alpha[v * w + u] === 255) !== inside)
            nearest = Math.min(nearest, Math.hypot(u - x, v - y));
      const d = inside ? -nearest : nearest;
      assert.strictEqual(field[y * w + x], fieldByte(d, 8), `at ${x}, ${y}`);
    }
  }
});
