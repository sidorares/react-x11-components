// `transform`, and the properties that are one function of it each —
// `translate`, `rotate` and `scale` (CSS Transforms 1 and 2) — read down to
// what is drawn: a matrix in the plane.
//
// A transform moves nothing but the box it is on and what that holds, so it
// is no part of layout: the box is laid out where it would be, moved by the
// matrix's translation (`applyRelativeOffsets`), and painted through the
// rest of it, about its `transform-origin` (`paintTransformed`). The two
// halves are one matrix: with `L` its linear part, `t` its translation and
// `O` the origin, a point goes to `O + L(p - O) + t`, which is `L` about the
// origin of the box `t` moved. So the translation stays the layout's, where
// a hit test, a control's rectangle and the ink bounds already find it, and
// only a box that turns, scales or skews is painted through a matrix.
//
// The functions out of the plane — `rotateX()`, `translateZ()`,
// `perspective()` — are read and are no part of the matrix: a declaration
// that names one is kept, and drawn as the rest of its list.

import { parseMath } from './calc.js';
import {
  AUTO,
  parseLength,
  parseNumber,
  resolve,
  splitCommas,
  splitValue,
} from './values.js';
import type { Len, UnitContext } from './values.js';
import type { ComputedStyle } from './style.js';

/** `matrix(a, b, c, d, e, f)`: the point (x, y) goes to
 *  (ax + cy + e, bx + dy + f), as a 2d context's `transform` has it. */
export type Matrix = readonly [number, number, number, number, number, number];

/** One function of a `transform` list: a translation by lengths, a
 *  percentage of the box's own width across and its height down, or a
 *  matrix — a run of the functions that are numbers alone, multiplied. */
export type TransformFunction = { by: [Len, Len] } | { matrix: Matrix };

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` after `n`: the matrix that does `n` and then `m`, which is what two
 *  functions of a list come to, the first written being `m`. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** The matrix that undoes `m`, or null where none does: one that flattens
 *  the plane to a line or a point, which draws nothing (CSS Transforms 1,
 *  6). */
export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** Where a point goes. */
export function mapPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The rectangle around where a rectangle goes: its four corners'. */
export function mapRect(
  m: Matrix,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (let i = 0; i < 4; i += 1) {
    const px = i & 1 ? x + width : x;
    const py = i & 2 ? y + height : y;
    const qx = m[0] * px + m[2] * py + m[4];
    const qy = m[1] * px + m[3] * py + m[5];
    if (qx < x1) x1 = qx;
    if (qx > x2) x2 = qx;
    if (qy < y1) y1 = qy;
    if (qy > y2) y2 = qy;
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** A rotation by degrees, clockwise as the page is seen. A quarter turn is
 *  its own numbers exactly: the cosine of ninety degrees computed is 6e-17,
 *  and a box turned on its side was a sliver of a pixel off the grid. */
export function rotation(degrees: number): Matrix {
  const quarters = degrees / 90;
  if (Number.isInteger(quarters)) {
    const at = ((quarters % 4) + 4) % 4;
    const cos = at === 0 ? 1 : at === 2 ? -1 : 0;
    const sin = at === 1 ? 1 : at === 3 ? -1 : 0;
    // no negative zero: it is a zero that compares unequal to one
    return [cos, sin, sin === 0 ? 0 : -sin, cos, 0, 0];
  }
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos, sin, -sin, cos, 0, 0];
}

const DEGREES: Record<string, number> = {
  deg: 1,
  grad: 0.9,
  rad: 180 / Math.PI,
  turn: 360,
};

const ANGLE = /^([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)$/;

/** An angle in degrees: a number with its unit, or a `calc()` of them —
 *  and a zero without one, where `bare` lets it be, as a transform
 *  function's argument does (CSS Values 4, 7.1). Null for anything else. */
export function parseAngle(value: string, bare = true): number | null {
  const v = value.trim().toLowerCase();
  const m = ANGLE.exec(v);
  if (m) return Number(m[1]) * DEGREES[m[2]];
  if (bare && /^[+-]?0*\.?0+$/.test(v)) return 0;
  if (!v.includes('(')) return null;
  const sum = parseMath(v, (token) => {
    const unit = ANGLE.exec(token);
    return unit ? Number(unit[1]) * DEGREES[unit[2]] : null;
  });
  return typeof sum === 'number' ? sum : null;
}

/** A scale factor: a number, or a percentage of one (CSS Transforms 2, 5),
 *  or a `calc()` of either. */
function parseFactor(value: string): number | null {
  const v = value.trim();
  if (v.endsWith('%')) {
    const n = parseNumber(v.slice(0, -1));
    return n === null ? null : n / 100;
  }
  const n = parseNumber(v);
  if (n !== null) return n;
  if (!v.includes('(')) return null;
  const sum = parseMath(v.toLowerCase(), () => null);
  if (sum === null || sum === AUTO || typeof sum === 'number') return null;
  return sum.of ? null : sum.pct / 100;
}

function parseOffset(value: string | undefined, ctx: UnitContext): Len | null {
  if (value === undefined) return null;
  const len = parseLength(value, ctx);
  return len === AUTO ? null : len;
}

/**
 * A `transform`: its functions in the order written. Null for `none`, and
 * undefined for what is no transform list, which drops the declaration. A
 * list that comes to nothing in the plane — `translateZ(0)`, which pages
 * write to have a layer made — is a list of none, and a transform still: the
 * box is a containing block and a stacking context as any transformed box
 * is.
 */
export function parseTransform(
  value: string,
  ctx: UnitContext,
): TransformFunction[] | null | undefined {
  if (value.trim().toLowerCase() === 'none') return null;
  const parts = splitValue(value);
  if (!parts.length) return undefined;
  const out: TransformFunction[] = [];
  for (const part of parts) {
    const m = /^([a-z0-9]+)\((.*)\)$/is.exec(part.trim());
    if (!m) return undefined;
    const args = splitCommas(m[2]).map((a) => a.trim());
    const fn = functionOf(m[1].toLowerCase(), args, ctx);
    if (fn === undefined) return undefined;
    if (fn === null) continue;
    const last = out[out.length - 1];
    if ('matrix' in fn && last && 'matrix' in last) {
      out[out.length - 1] = { matrix: multiply(last.matrix, fn.matrix) };
    } else out.push(fn);
  }
  return out;
}

/** One function: what it is in the plane, null where that is nothing, and
 *  undefined where it is no function or its arguments are not its own. */
function functionOf(
  name: string,
  args: string[],
  ctx: UnitContext,
): TransformFunction | null | undefined {
  const count = args.length;
  const angles = (): number[] | null => {
    const out = args.map((a) => parseAngle(a));
    return out.some((a) => a === null) ? null : (out as number[]);
  };
  const factors = (): number[] | null => {
    const out = args.map(parseFactor);
    return out.some((n) => n === null) ? null : (out as number[]);
  };
  const tan = (degrees: number): number => Math.tan((degrees * Math.PI) / 180);
  switch (name) {
    case 'translate': {
      if (count < 1 || count > 2) return undefined;
      const x = parseOffset(args[0], ctx);
      const y = count === 2 ? parseOffset(args[1], ctx) : 0;
      return x === null || y === null ? undefined : { by: [x, y] };
    }
    case 'translate3d': {
      if (count !== 3) return undefined;
      const x = parseOffset(args[0], ctx);
      const y = parseOffset(args[1], ctx);
      if (x === null || y === null) return undefined;
      // a depth is a length, and no percentage
      return typeof parseOffset(args[2], ctx) === 'number'
        ? { by: [x, y] }
        : undefined;
    }
    case 'translatex':
    case 'translatey': {
      const by = count === 1 ? parseOffset(args[0], ctx) : null;
      if (by === null) return undefined;
      return { by: name === 'translatex' ? [by, 0] : [0, by] };
    }
    case 'translatez':
      return count === 1 && typeof parseOffset(args[0], ctx) === 'number'
        ? null
        : undefined;
    case 'scale': {
      const f = count >= 1 && count <= 2 ? factors() : null;
      return f ? { matrix: [f[0], 0, 0, f[1] ?? f[0], 0, 0] } : undefined;
    }
    case 'scale3d': {
      const f = count === 3 ? factors() : null;
      return f ? { matrix: [f[0], 0, 0, f[1], 0, 0] } : undefined;
    }
    case 'scalex':
    case 'scaley': {
      const f = count === 1 ? factors() : null;
      if (!f) return undefined;
      return {
        matrix:
          name === 'scalex' ? [f[0], 0, 0, 1, 0, 0] : [1, 0, 0, f[0], 0, 0],
      };
    }
    case 'scalez':
      return count === 1 && factors() ? null : undefined;
    case 'rotate':
    case 'rotatez': {
      const a = count === 1 ? angles() : null;
      return a ? { matrix: rotation(a[0]) } : undefined;
    }
    case 'rotatex':
    case 'rotatey':
      return count === 1 && angles() ? null : undefined;
    case 'rotate3d': {
      if (count !== 4) return undefined;
      const axis = args.slice(0, 3).map(parseNumber);
      const angle = parseAngle(args[3]);
      if (angle === null || axis.some((n) => n === null)) return undefined;
      return axisRotation(axis as number[], angle);
    }
    case 'skew': {
      const a = count >= 1 && count <= 2 ? angles() : null;
      return a
        ? { matrix: [1, tan(a[1] ?? 0), tan(a[0]), 1, 0, 0] }
        : undefined;
    }
    case 'skewx':
    case 'skewy': {
      const a = count === 1 ? angles() : null;
      if (!a) return undefined;
      return {
        matrix:
          name === 'skewx'
            ? [1, 0, tan(a[0]), 1, 0, 0]
            : [1, tan(a[0]), 0, 1, 0, 0],
      };
    }
    case 'matrix':
    case 'matrix3d': {
      const n = args.map(parseNumber);
      const flat = name === 'matrix';
      if (n.length !== (flat ? 6 : 16) || n.some((v) => v === null)) {
        return undefined;
      }
      const v = n as number[];
      // the plane's part of a 4×4, whose columns are written in turn; a
      // matrix's translation is in CSS pixels, as a length without its unit
      const [a, b, c, d, e, f] = flat
        ? v
        : [v[0], v[1], v[4], v[5], v[12], v[13]];
      return { matrix: [a, b, c, d, e * ctx.scale, f * ctx.scale] };
    }
    case 'perspective': {
      if (count !== 1) return undefined;
      if (args[0].toLowerCase() === 'none') return null;
      return typeof parseOffset(args[0], ctx) === 'number' ? null : undefined;
    }
    default:
      return undefined;
  }
}

/** A turn about an axis, where the axis is the one out of the page — the
 *  other way where it points into it; about any other it is out of the
 *  plane, and nothing here. */
function axisRotation(axis: number[], angle: number): TransformFunction | null {
  const [x, y, z] = axis;
  if (x !== 0 || y !== 0 || z === 0) return null;
  return { matrix: rotation(z > 0 ? angle : -angle) };
}

/**
 * `rotate` (CSS Transforms 2, 4): an angle in degrees, about the axis out of
 * the page where one is named. Null for `none`, and for a turn about any
 * other axis, which is out of the plane; undefined for what is no value of
 * it.
 */
export function parseRotate(value: string): number | null | undefined {
  const parts = splitValue(value.trim().toLowerCase());
  if (parts.length === 1) {
    if (parts[0] === 'none') return null;
    return parseAngle(parts[0], false) ?? undefined;
  }
  // an axis and an angle, in either order; the axis a letter or a vector
  const at = parts.findIndex((p) => parseAngle(p, false) !== null);
  const angle = at < 0 ? null : parseAngle(parts[at], false);
  if (angle === null || (at !== 0 && at !== parts.length - 1)) return undefined;
  const axis = parts.filter((_, i) => i !== at);
  if (axis.length === 1) {
    if (axis[0] === 'z') return angle;
    return axis[0] === 'x' || axis[0] === 'y' ? null : undefined;
  }
  const vector = axis.map(parseNumber);
  if (vector.length !== 3 || vector.some((n) => n === null)) return undefined;
  const turned = axisRotation(vector as number[], 1);
  if (!turned) return null;
  return (vector[2] as number) > 0 ? angle : -angle;
}

/** `scale` (CSS Transforms 2, 5): across and down, the one factor both
 *  where one is written, and a depth that is nothing here. Null for
 *  `none`. */
export function parseScale(value: string): [number, number] | null | undefined {
  const parts = splitValue(value.trim());
  if (parts.length === 1 && parts[0].toLowerCase() === 'none') return null;
  if (parts.length < 1 || parts.length > 3) return undefined;
  const factors = parts.map(parseFactor);
  if (factors.some((f) => f === null)) return undefined;
  const [x, y] = factors as number[];
  return [x, y ?? x];
}

type Transformed = Pick<
  ComputedStyle,
  'translate' | 'rotate' | 'scale' | 'transform'
>;

/** Whether a style transforms its box: any of the four properties at
 *  anything but `none`, whatever it comes to — which makes the box a
 *  containing block for all it holds and a stacking context (CSS
 *  Transforms 1, 3). */
export function transformed(style: Transformed): boolean {
  return (
    style.transform !== null ||
    style.translate !== null ||
    style.rotate !== null ||
    style.scale !== null
  );
}

/**
 * A style's whole transform, for a box `width` by `height`, which its
 * percentages are of: `translate`, then `rotate`, then `scale`, then the
 * `transform` list (CSS Transforms 2, 7) — without its origin, which is
 * where the box is.
 */
export function matrixOf(
  style: Transformed,
  width: number,
  height: number,
): Matrix {
  let m = IDENTITY;
  const moved = style.translate;
  if (moved) {
    m = [1, 0, 0, 1, resolve(moved[0], width, 0), resolve(moved[1], height, 0)];
  }
  if (style.rotate !== null) m = multiply(m, rotation(style.rotate));
  if (style.scale) {
    m = multiply(m, [style.scale[0], 0, 0, style.scale[1], 0, 0]);
  }
  if (style.transform) {
    for (const fn of style.transform) {
      m = multiply(
        m,
        'matrix' in fn
          ? fn.matrix
          : [
              1,
              0,
              0,
              1,
              resolve(fn.by[0], width, 0),
              resolve(fn.by[1], height, 0),
            ],
      );
    }
  }
  return m;
}

/** The part of a matrix that turns, scales and skews. */
export type Linear = readonly [number, number, number, number];

const LINEAR = new WeakMap<object, Linear | null>();

/**
 * What a style's transform does besides move the box: null where that is
 * nothing, as it is for every box but a few. The same for a box of any
 * size — a translation's percentages are no part of it — so kept by the
 * style.
 */
export function linearOf(style: Transformed): Linear | null {
  if (
    style.transform === null &&
    style.rotate === null &&
    style.scale === null
  ) {
    return null;
  }
  let linear = LINEAR.get(style);
  if (linear === undefined) {
    const m = matrixOf(style, 0, 0);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    linear =
      near(m[0], 1) && near(m[1], 0) && near(m[2], 0) && near(m[3], 1)
        ? null
        : [m[0], m[1], m[2], m[3]];
    LINEAR.set(style, linear);
  }
  return linear;
}

/** `linear` about a point: the matrix a box at that origin is drawn
 *  through, in the coordinates the point is in. */
export function about(linear: Linear, x: number, y: number): Matrix {
  const [a, b, c, d] = linear;
  return [a, b, c, d, x - (a * x + c * y), y - (b * x + d * y)];
}
