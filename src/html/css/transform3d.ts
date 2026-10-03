// The transforms out of the plane (CSS Transforms 2): a 4×4 matrix, what a
// box's plane comes to through it and the perspective it is seen in, and
// two of them interpolated.
//
// A matrix is sixteen numbers in the order `matrix3d()` writes them, a
// column at a time: a point (x, y, z) goes to
//   x' = m[0]x + m[4]y + m[8]z  + m[12]
//   y' = m[1]x + m[5]y + m[9]z  + m[13]
//   z' = m[2]x + m[6]y + m[10]z + m[14]
//   w' = m[3]x + m[7]y + m[11]z + m[15]
// and is drawn at (x'/w', y'/w'). A box is flat and lies at z = 0, so all
// it comes to on the page is three of those rows and three of the columns:
// a projection of the plane (`Projection`), which is a matrix of the plane
// where its last row is (0, 0, 1) — a box turned about the axis out of the
// page, or about any other with no perspective to see it in — and draws a
// rectangle as a trapezoid where a perspective shows its far side smaller.

import type { Matrix } from './transform.js';

/** A 4×4 matrix, a column at a time (`matrix3d()`'s order). */
export type Mat4 = readonly number[];

/** What a plane comes to through a 4×4 matrix: (x, y) goes to
 *  ((p0 x + p1 y + p2) / w, (p3 x + p4 y + p5) / w), where
 *  w = p6 x + p7 y + p8. */
export type Projection = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY4: Mat4 = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

/** `m` after `n`: what doing `n` and then `m` comes to. */
export function multiply4(m: Mat4, n: Mat4): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      out[c * 4 + r] =
        m[r] * n[c * 4] +
        m[4 + r] * n[c * 4 + 1] +
        m[8 + r] * n[c * 4 + 2] +
        m[12 + r] * n[c * 4 + 3];
    }
  }
  return out;
}

/** A matrix of the plane as one of space. */
export function lift(m: Matrix): number[] {
  return [m[0], m[1], 0, 0, m[2], m[3], 0, 0, 0, 0, 1, 0, m[4], m[5], 0, 1];
}

/** What a 4×4 does in the plane, where it is no more than that: the rows
 *  and columns of x and y, and the translation (`lift`'s inverse). */
export function flatten4(m: Mat4): Matrix {
  return [m[0], m[1], m[4], m[5], m[12], m[13]];
}

/** Whether a 4×4 is a matrix of the plane, which a 2d context draws
 *  through as it is. */
export function isPlanar(m: Mat4): boolean {
  const zero = (v: number) => Math.abs(v) < 1e-12;
  return (
    zero(m[2]) &&
    zero(m[3]) &&
    zero(m[6]) &&
    zero(m[7]) &&
    zero(m[8]) &&
    zero(m[9]) &&
    zero(m[10] - 1) &&
    zero(m[11]) &&
    zero(m[14]) &&
    zero(m[15] - 1)
  );
}

export function translate4(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scale4(x: number, y: number, z: number): number[] {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

/** `perspective(d)` (CSS Transforms 2, 13.1): what is `d` from the viewer
 *  at z = 0 is drawn its size, and what is nearer larger. Less than one
 *  pixel is one (CSS Transforms 2, 6.1). */
export function perspective4(d: number): number[] {
  const m = [...IDENTITY4];
  m[11] = -1 / Math.max(1, d);
  return m;
}

/**
 * `rotate3d(x, y, z, angle)` (CSS Transforms 2, 13.1): a turn by degrees
 * about the axis (x, y, z), clockwise as one looks down it toward the
 * origin. An axis of no length is no turn.
 */
export function rotate4(
  x: number,
  y: number,
  z: number,
  degrees: number,
): number[] {
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) return [...IDENTITY4];
  x /= length;
  y /= length;
  z /= length;
  const a = (degrees * Math.PI) / 180;
  const sc = Math.sin(a / 2) * Math.cos(a / 2);
  const sq = Math.sin(a / 2) ** 2;
  return [
    1 - 2 * (y * y + z * z) * sq,
    2 * (x * y * sq + z * sc),
    2 * (x * z * sq - y * sc),
    0,
    2 * (x * y * sq - z * sc),
    1 - 2 * (x * x + z * z) * sq,
    2 * (y * z * sq + x * sc),
    0,
    2 * (x * z * sq + y * sc),
    2 * (y * z * sq - x * sc),
    1 - 2 * (x * x + y * y) * sq,
    0,
    0,
    0,
    0,
    1,
  ];
}

/** What the plane z = 0 comes to through `m`. */
export function projectionOf(m: Mat4): Projection {
  return [m[0], m[4], m[12], m[1], m[5], m[13], m[3], m[7], m[15]];
}

/** Whether a projection is a matrix of the plane: one that divides by the
 *  same number everywhere. */
export function projectionIsAffine(p: Projection): boolean {
  return Math.abs(p[6]) < 1e-12 && Math.abs(p[7]) < 1e-12 && p[8] !== 0;
}

/** A projection that is a matrix of the plane, as one. */
export function affineOf(p: Projection): Matrix {
  const w = p[8];
  return [p[0] / w, p[3] / w, p[1] / w, p[4] / w, p[2] / w, p[5] / w];
}

/** Where a point goes, or null where it goes behind the viewer, which
 *  draws nothing of it there. */
export function project(
  p: Projection,
  x: number,
  y: number,
): [number, number] | null {
  const w = p[6] * x + p[7] * y + p[8];
  if (!(w > 1e-9)) return null;
  return [(p[0] * x + p[1] * y + p[2]) / w, (p[3] * x + p[4] * y + p[5]) / w];
}

/** The projection that undoes `p`, or null where none does. */
export function invertProjection(p: Projection): Projection | null {
  const [a, b, c, d, e, f, g, h, i] = p;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

/** How near the horizon a point of the plane is kept: where it is drawn
 *  no more than this many times smaller than its corner furthest from the
 *  viewer. Nearer, it is drawn further off than any window reaches, and
 *  past the horizon it is behind the viewer, who sees nothing of it. */
const HORIZON = 4096;

/**
 * The part of a polygon of the plane in front of the viewer: its corners
 * where they are, and where an edge crosses the line it goes behind at, a
 * corner there instead (CSS Transforms 2, 6, "the part of the plane behind
 * the viewer is not rendered"). Empty where none of it is in front.
 */
export function inFront(
  p: Projection,
  points: readonly (readonly [number, number])[],
): [number, number][] {
  let most = -Infinity;
  for (const [x, y] of points) {
    most = Math.max(most, p[6] * x + p[7] * y + p[8]);
  }
  if (!(most > 0)) return [];
  const floor = most / HORIZON;
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const wa = p[6] * a[0] + p[7] * a[1] + p[8] - floor;
    const wb = p[6] * b[0] + p[7] * b[1] + p[8] - floor;
    if (wa >= 0) out.push([a[0], a[1]]);
    if (wa >= 0 !== wb >= 0) {
      const t = wa / (wa - wb);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/** The rectangle around where the part of a rectangle in front of the
 *  viewer goes (`inFront`); one at infinity, of no size, where none is. */
export function projectRect(
  p: Projection,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const corners = inFront(p, [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ]);
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const [cx, cy] of corners) {
    const to = project(p, cx, cy);
    if (!to) continue;
    if (to[0] < x1) x1 = to[0];
    if (to[0] > x2) x2 = to[0];
    if (to[1] < y1) y1 = to[1];
    if (to[1] > y2) y2 = to[1];
  }
  if (x1 === Infinity) return { x: Infinity, y: Infinity, width: 0, height: 0 };
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** A projection followed by a matrix of the plane: what `m` makes of where
 *  `p` puts a point. */
export function projectionAfter(m: Matrix, p: Projection): Projection {
  const [a, b, c, d, e, f] = m;
  return [
    a * p[0] + c * p[3] + e * p[6],
    a * p[1] + c * p[4] + e * p[7],
    a * p[2] + c * p[5] + e * p[8],
    b * p[0] + d * p[3] + f * p[6],
    b * p[1] + d * p[4] + f * p[7],
    b * p[2] + d * p[5] + f * p[8],
    p[6],
    p[7],
    p[8],
  ];
}

/** The matrix of the plane nearest a projection at a point: the one that
 *  puts the point where the projection does, and steps from it as the
 *  projection steps there. Null where the point is behind the viewer. */
export function tangentAt(p: Projection, x: number, y: number): Matrix | null {
  const w = p[6] * x + p[7] * y + p[8];
  if (!(w > 0)) return null;
  const u = (p[0] * x + p[1] * y + p[2]) / w;
  const v = (p[3] * x + p[4] * y + p[5]) / w;
  const a = (p[0] - u * p[6]) / w;
  const c = (p[1] - u * p[7]) / w;
  const b = (p[3] - v * p[6]) / w;
  const d = (p[4] - v * p[7]) / w;
  return [a, b, c, d, u - a * x - c * y, v - b * x - d * y];
}

/** `p` in coordinates moved by (dx, dy): what it does to a point given and
 *  answered in those. */
export function projectionMoved(
  p: Projection,
  dx: number,
  dy: number,
): Projection {
  // T(dx, dy) · p · T(-dx, -dy)
  const [a, b, c, d, e, f, g, h, i] = p;
  const c1 = c - a * dx - b * dy;
  const f1 = f - d * dx - e * dy;
  const i1 = i - g * dx - h * dy;
  return [
    a + dx * g,
    b + dx * h,
    c1 + dx * i1,
    d + dy * g,
    e + dy * h,
    f1 + dy * i1,
    g,
    h,
    i1,
  ];
}

/** Whether the plane z = 0 is seen from behind through `m`: the z of its
 *  normal, which the inverse's transpose carries it through, points away
 *  from the viewer (CSS Transforms 2, 7, `backface-visibility`). Not where
 *  `m` flattens the plane, which draws nothing either way. */
export function facesAway(m: Mat4): boolean {
  const inverse = invert4(m);
  return !!inverse && inverse[10] < 0;
}

// --- two matrices between (CSS Transforms 2, 11) -----------------------------

interface Decomposed3 {
  translate: [number, number, number];
  scale: [number, number, number];
  skew: [number, number, number];
  perspective: [number, number, number, number];
  quaternion: [number, number, number, number];
}

/** The determinant of a 4×4. */
function determinant4(m: Mat4): number {
  const [a, b, c, d, e, f, g, h, i, j, k, l, mm, n, o, p] = m;
  const kp = k * p - l * o;
  const jp = j * p - l * n;
  const jo = j * o - k * n;
  const ip = i * p - l * mm;
  const io = i * o - k * mm;
  const in_ = i * n - j * mm;
  return (
    a * (f * kp - g * jp + h * jo) -
    b * (e * kp - g * ip + h * io) +
    c * (e * jp - f * ip + h * in_) -
    d * (e * jo - f * io + g * in_)
  );
}

/** The inverse of a 4×4, or null. */
function invert4(m: Mat4): number[] | null {
  const inv = new Array<number>(16);
  inv[0] =
    m[5] * m[10] * m[15] -
    m[5] * m[11] * m[14] -
    m[9] * m[6] * m[15] +
    m[9] * m[7] * m[14] +
    m[13] * m[6] * m[11] -
    m[13] * m[7] * m[10];
  inv[4] =
    -m[4] * m[10] * m[15] +
    m[4] * m[11] * m[14] +
    m[8] * m[6] * m[15] -
    m[8] * m[7] * m[14] -
    m[12] * m[6] * m[11] +
    m[12] * m[7] * m[10];
  inv[8] =
    m[4] * m[9] * m[15] -
    m[4] * m[11] * m[13] -
    m[8] * m[5] * m[15] +
    m[8] * m[7] * m[13] +
    m[12] * m[5] * m[11] -
    m[12] * m[7] * m[9];
  inv[12] =
    -m[4] * m[9] * m[14] +
    m[4] * m[10] * m[13] +
    m[8] * m[5] * m[14] -
    m[8] * m[6] * m[13] -
    m[12] * m[5] * m[10] +
    m[12] * m[6] * m[9];
  inv[1] =
    -m[1] * m[10] * m[15] +
    m[1] * m[11] * m[14] +
    m[9] * m[2] * m[15] -
    m[9] * m[3] * m[14] -
    m[13] * m[2] * m[11] +
    m[13] * m[3] * m[10];
  inv[5] =
    m[0] * m[10] * m[15] -
    m[0] * m[11] * m[14] -
    m[8] * m[2] * m[15] +
    m[8] * m[3] * m[14] +
    m[12] * m[2] * m[11] -
    m[12] * m[3] * m[10];
  inv[9] =
    -m[0] * m[9] * m[15] +
    m[0] * m[11] * m[13] +
    m[8] * m[1] * m[15] -
    m[8] * m[3] * m[13] -
    m[12] * m[1] * m[11] +
    m[12] * m[3] * m[9];
  inv[13] =
    m[0] * m[9] * m[14] -
    m[0] * m[10] * m[13] -
    m[8] * m[1] * m[14] +
    m[8] * m[2] * m[13] +
    m[12] * m[1] * m[10] -
    m[12] * m[2] * m[9];
  inv[2] =
    m[1] * m[6] * m[15] -
    m[1] * m[7] * m[14] -
    m[5] * m[2] * m[15] +
    m[5] * m[3] * m[14] +
    m[13] * m[2] * m[7] -
    m[13] * m[3] * m[6];
  inv[6] =
    -m[0] * m[6] * m[15] +
    m[0] * m[7] * m[14] +
    m[4] * m[2] * m[15] -
    m[4] * m[3] * m[14] -
    m[12] * m[2] * m[7] +
    m[12] * m[3] * m[6];
  inv[10] =
    m[0] * m[5] * m[15] -
    m[0] * m[7] * m[13] -
    m[4] * m[1] * m[15] +
    m[4] * m[3] * m[13] +
    m[12] * m[1] * m[7] -
    m[12] * m[3] * m[5];
  inv[14] =
    -m[0] * m[5] * m[14] +
    m[0] * m[6] * m[13] +
    m[4] * m[1] * m[14] -
    m[4] * m[2] * m[13] -
    m[12] * m[1] * m[6] +
    m[12] * m[2] * m[5];
  inv[3] =
    -m[1] * m[6] * m[11] +
    m[1] * m[7] * m[10] +
    m[5] * m[2] * m[11] -
    m[5] * m[3] * m[10] -
    m[9] * m[2] * m[7] +
    m[9] * m[3] * m[6];
  inv[7] =
    m[0] * m[6] * m[11] -
    m[0] * m[7] * m[10] -
    m[4] * m[2] * m[11] +
    m[4] * m[3] * m[10] +
    m[8] * m[2] * m[7] -
    m[8] * m[3] * m[6];
  inv[11] =
    -m[0] * m[5] * m[11] +
    m[0] * m[7] * m[9] +
    m[4] * m[1] * m[11] -
    m[4] * m[3] * m[9] -
    m[8] * m[1] * m[7] +
    m[8] * m[3] * m[5];
  inv[15] =
    m[0] * m[5] * m[10] -
    m[0] * m[6] * m[9] -
    m[4] * m[1] * m[10] +
    m[4] * m[2] * m[9] +
    m[8] * m[1] * m[6] -
    m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  return inv.map((v) => v / det);
}

const dot3 = (a: number[], b: number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const combine = (a: number[], b: number[], ascl: number, bscl: number) => [
  ascl * a[0] + bscl * b[0],
  ascl * a[1] + bscl * b[1],
  ascl * a[2] + bscl * b[2],
];

/** "Decomposing a 3D matrix" (CSS Transforms 2, 11.3): null where the
 *  matrix cannot be, which interpolates as a step. */
function decompose3(m: Mat4): Decomposed3 | null {
  if (m[15] === 0) return null;
  const n = m.map((v) => v / m[15]);
  const persp = [...n];
  persp[3] = 0;
  persp[7] = 0;
  persp[11] = 0;
  persp[15] = 1;
  if (Math.abs(determinant4(persp)) < 1e-12) return null;
  let perspective: [number, number, number, number] = [0, 0, 0, 1];
  if (n[3] !== 0 || n[7] !== 0 || n[11] !== 0) {
    const rhs = [n[3], n[7], n[11], n[15]];
    const inverse = invert4(persp);
    if (!inverse) return null;
    // the inverse's transpose times the right-hand side
    perspective = [0, 1, 2, 3].map(
      (r) =>
        inverse[r * 4] * rhs[0] +
        inverse[r * 4 + 1] * rhs[1] +
        inverse[r * 4 + 2] * rhs[2] +
        inverse[r * 4 + 3] * rhs[3],
    ) as [number, number, number, number];
  }
  const translate: [number, number, number] = [n[12], n[13], n[14]];
  const row = [
    [n[0], n[1], n[2]],
    [n[4], n[5], n[6]],
    [n[8], n[9], n[10]],
  ];
  const scale: [number, number, number] = [0, 0, 0];
  const skew: [number, number, number] = [0, 0, 0];
  scale[0] = Math.hypot(...row[0]);
  row[0] = row[0].map((v) => v / (scale[0] || 1));
  skew[0] = dot3(row[0], row[1]);
  row[1] = combine(row[1], row[0], 1, -skew[0]);
  scale[1] = Math.hypot(...row[1]);
  row[1] = row[1].map((v) => v / (scale[1] || 1));
  skew[0] /= scale[1] || 1;
  skew[1] = dot3(row[0], row[2]);
  row[2] = combine(row[2], row[0], 1, -skew[1]);
  skew[2] = dot3(row[1], row[2]);
  row[2] = combine(row[2], row[1], 1, -skew[2]);
  scale[2] = Math.hypot(...row[2]);
  row[2] = row[2].map((v) => v / (scale[2] || 1));
  skew[1] /= scale[2] || 1;
  skew[2] /= scale[2] || 1;
  const cross = [
    row[1][1] * row[2][2] - row[1][2] * row[2][1],
    row[1][2] * row[2][0] - row[1][0] * row[2][2],
    row[1][0] * row[2][1] - row[1][1] * row[2][0],
  ];
  if (dot3(row[0], cross) < 0) {
    for (let i = 0; i < 3; i += 1) {
      scale[i] = -scale[i];
      row[i] = row[i].map((v) => -v);
    }
  }
  const q: [number, number, number, number] = [
    0.5 * Math.sqrt(Math.max(1 + row[0][0] - row[1][1] - row[2][2], 0)),
    0.5 * Math.sqrt(Math.max(1 - row[0][0] + row[1][1] - row[2][2], 0)),
    0.5 * Math.sqrt(Math.max(1 - row[0][0] - row[1][1] + row[2][2], 0)),
    0.5 * Math.sqrt(Math.max(1 + row[0][0] + row[1][1] + row[2][2], 0)),
  ];
  if (row[2][1] > row[1][2]) q[0] = -q[0];
  if (row[0][2] > row[2][0]) q[1] = -q[1];
  if (row[1][0] > row[0][1]) q[2] = -q[2];
  return { translate, scale, skew, perspective, quaternion: q };
}

/** "Recomposing to a 3D matrix" (CSS Transforms 2, 11.4). */
function recompose3(d: Decomposed3): number[] {
  let m: number[] = [...IDENTITY4];
  m[3] = d.perspective[0];
  m[7] = d.perspective[1];
  m[11] = d.perspective[2];
  m[15] = d.perspective[3];
  m = multiply4(m, translate4(...d.translate));
  const [x, y, z, w] = d.quaternion;
  const rotation = [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    0,
    0,
    0,
    1,
  ];
  m = multiply4(m, rotation);
  if (d.skew[2]) {
    const s = [...IDENTITY4];
    s[9] = d.skew[2];
    m = multiply4(m, s);
  }
  if (d.skew[1]) {
    const s = [...IDENTITY4];
    s[8] = d.skew[1];
    m = multiply4(m, s);
  }
  if (d.skew[0]) {
    const s = [...IDENTITY4];
    s[4] = d.skew[0];
    m = multiply4(m, s);
  }
  return multiply4(m, scale4(...d.scale));
}

/** Two quaternions `q` of the way between, the short way round. */
function slerp(
  a: [number, number, number, number],
  b: [number, number, number, number],
  q: number,
): [number, number, number, number] {
  let product = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  product = Math.min(1, Math.max(-1, product));
  if (Math.abs(product) === 1) return [...a];
  const theta = Math.acos(product);
  const w = Math.sin(q * theta) / Math.sqrt(1 - product * product);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    out[i] = a[i] * (Math.cos(q * theta) - product * w) + b[i] * w;
  }
  return out;
}

/** Two 4×4 matrices `q` of the way between (CSS Transforms 2, 11.2): their
 *  parts interpolated, the turn as quaternions; one that cannot be taken
 *  apart is the nearer end. */
export function interpolateMatrix4(a: Mat4, b: Mat4, q: number): number[] {
  const x = decompose3(a);
  const y = decompose3(b);
  if (!x || !y) return [...(q < 0.5 ? a : b)];
  const at = (u: number, v: number) => u + (v - u) * q;
  return recompose3({
    translate: [0, 1, 2].map((i) => at(x.translate[i], y.translate[i])) as [
      number,
      number,
      number,
    ],
    scale: [0, 1, 2].map((i) => at(x.scale[i], y.scale[i])) as [
      number,
      number,
      number,
    ],
    skew: [0, 1, 2].map((i) => at(x.skew[i], y.skew[i])) as [
      number,
      number,
      number,
    ],
    perspective: [0, 1, 2, 3].map((i) =>
      at(x.perspective[i], y.perspective[i]),
    ) as [number, number, number, number],
    quaternion: slerp(x.quaternion, y.quaternion, q),
  });
}
