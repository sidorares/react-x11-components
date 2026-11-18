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

import { parseNumber, splitValue } from './values.js';

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

const CORNER_KEYWORDS: Record<string, number> = {
  round: 1,
  squircle: 2,
  square: Infinity,
  bevel: 0,
  scoop: -1,
  notch: -Infinity,
};

/** One corner's shape — a keyword, or `superellipse()` of a number or of
 *  an infinity — as its parameter; null for none. */
export function cornerShapeOf(value: string): number | null {
  const v = value.trim().toLowerCase();
  const keyword = CORNER_KEYWORDS[v];
  if (keyword !== undefined) return keyword;
  const m = /^superellipse\(\s*([\s\S]+?)\s*\)$/.exec(v);
  if (!m) return null;
  if (m[1] === 'infinity') return Infinity;
  if (m[1] === '-infinity') return -Infinity;
  return parseNumber(m[1]);
}

/** One corner's shape as CSSOM writes it: a keyword in lower case, or
 *  `superellipse()` of its number at its shortest; null for none. */
export function cornerShapeText(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (CORNER_KEYWORDS[v] !== undefined) return v;
  const m = /^superellipse\(\s*([\s\S]+?)\s*\)$/.exec(v);
  if (!m || cornerShapeOf(v) === null) return null;
  if (m[1] === 'infinity' || m[1] === '-infinity')
    return `superellipse(${m[1]})`;
  const n = parseNumber(m[1]);
  // a math function is kept as written, the cascade's to simplify
  return n === null ? `superellipse(${m[1]})` : `superellipse(${n})`;
}

/** The longhands each corner-shape shorthand sets, in the order its values
 *  go to them: the four physical corners for `corner-shape`, and a side's
 *  two for each of the others (CSS Borders 4, 3.9.1). */
export const CORNER_SHAPE_SHORTHANDS: Record<string, readonly string[]> = {
  'corner-shape': [
    'corner-top-left-shape',
    'corner-top-right-shape',
    'corner-bottom-right-shape',
    'corner-bottom-left-shape',
  ],
  'corner-top-shape': ['corner-top-left-shape', 'corner-top-right-shape'],
  'corner-right-shape': ['corner-top-right-shape', 'corner-bottom-right-shape'],
  'corner-bottom-shape': [
    'corner-bottom-left-shape',
    'corner-bottom-right-shape',
  ],
  'corner-left-shape': ['corner-top-left-shape', 'corner-bottom-left-shape'],
  'corner-block-start-shape': [
    'corner-start-start-shape',
    'corner-start-end-shape',
  ],
  'corner-block-end-shape': ['corner-end-start-shape', 'corner-end-end-shape'],
  'corner-inline-start-shape': [
    'corner-start-start-shape',
    'corner-end-start-shape',
  ],
  'corner-inline-end-shape': ['corner-start-end-shape', 'corner-end-end-shape'],
};

/** A corner-shape shorthand's longhands for a value, each canonical: four
 *  values filled in as `border-radius` fills its radii, a side's two as
 *  one or two; null where the name is no shorthand or the value is none. */
export function cornerShapeLonghands(
  name: string,
  value: string,
): [string, string][] | null {
  const longhands = CORNER_SHAPE_SHORTHANDS[name];
  if (!longhands) return null;
  const parts = splitValue(value).map(cornerShapeText);
  if (!parts.length || parts.length > longhands.length) return null;
  if (parts.some((p) => p === null)) return null;
  const k = parts as string[];
  const values =
    longhands.length === 4
      ? [k[0], k[1] ?? k[0], k[2] ?? k[0], k[3] ?? k[1] ?? k[0]]
      : [k[0], k[1] ?? k[0]];
  return longhands.map((n, i) => [n, values[i]]);
}

/** A corner-shape shorthand from its longhands, at its shortest, as
 *  `margin` is; '' where one is missing. */
export function cornerShapeComposed(
  name: string,
  longhand: (name: string) => string | null,
): string | null {
  const longhands = CORNER_SHAPE_SHORTHANDS[name];
  if (!longhands) return null;
  const v = longhands.map(longhand);
  if (v.some((x) => x === null || x === '')) return '';
  const s = v as string[];
  if (s.length === 2) return s[0] === s[1] ? s[0] : `${s[0]} ${s[1]}`;
  const [t, r, b, l] = s;
  if (r === l) {
    if (t === b) return t === r ? t : `${t} ${r}`;
    return `${t} ${r} ${b}`;
  }
  return `${t} ${r} ${b} ${l}`;
}
