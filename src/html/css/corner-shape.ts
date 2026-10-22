// The superellipse a `corner-shape` draws a corner in (CSS Borders 4, 3.9).
// A corner's curve runs from where its radius meets one side to where it
// meets the other; its parameter K says how: 1 a quarter of an ellipse, 0 a
// straight bevel, the infinities the square corner and the notch through
// the corner's inner point, and a negative one the concave mirror of its
// positive — `scoop` is a quarter of an ellipse bowed the other way.
//
// In the corner's own square, its outer corner at the origin and its radii
// one, the curve for K is |1 − u|ⁿ + |1 − v|ⁿ = 1 for K > 0 and
// |u|ⁿ + |v|ⁿ = 1 for K < 0, with n = 2^|K|. Where it crosses the diagonal
// is the one number everything else here is read from.

/** The spec's normalized half corner of a superellipse (3.9.6): where the
 *  curve crosses the corner's diagonal, from its outer corner, 0, to its
 *  inner one, 1. A half for a bevel; about 0.71 for `round`. */
export function halfCorner(k: number): number {
  if (k === Infinity) return 1;
  if (k === -Infinity) return 0;
  const convex = 0.5 ** (1 / 2 ** Math.abs(k));
  return k < 0 ? 1 - convex : convex;
}

/** The parameter whose half corner `h` is: `halfCorner`'s inverse, which
 *  is how an animation runs between two shapes (3.9.6). */
export function shapeAtHalfCorner(h: number): number {
  if (h >= 1) return Infinity;
  if (h <= 0) return -Infinity;
  if (h === 0.5) return 0;
  const convex = h < 0.5 ? 1 - h : h;
  const k = Math.log2(Math.log(0.5) / Math.log(convex));
  return h < 0.5 ? -k : k;
}

/** How far from the outer corner along the diagonal the curve crosses it,
 *  as a fraction of the diagonal: one less the half corner. */
export function cornerReach(k: number): number {
  return 1 - halfCorner(k);
}

/** 1 − √½: how far a round corner's curve is from its outer corner along
 *  the diagonal, a fraction of the diagonal. */
const ROUND_REACH = 1 - Math.SQRT1_2;

/**
 * How much of a border's width a shaped corner's radius loses to an edge
 * inside it — its padding edge inside the border, a shadow spread in — so
 * that the curve on the inner edge is the width from the outer one where
 * each crosses the diagonal, as a browser keeps a border's thickness round
 * a shaped corner. 1 for a round corner, which is CSS Backgrounds' radius
 * less the border (5.2); less for a bevel, whose line is thinner across
 * than along an edge, and more for a squircle, all the radius for a square
 * corner. Capped, since a corner square to begin with has nothing to lose.
 */
export function cornerInset(k: number): number {
  if (k === 1) return 1;
  const reach = cornerReach(k);
  return reach > 0 ? Math.min(64, ROUND_REACH / reach) : 64;
}
