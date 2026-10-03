// `transform`, and the properties that are one function of it each —
// `translate`, `rotate` and `scale` (CSS Transforms 1 and 2) — read down to
// what is drawn: a matrix in the plane, or what the plane comes to out of it.
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
// `perspective()`, a `matrix3d()` with a depth — are kept as what they are
// in space (`css/transform3d.ts`), and so are the three properties where
// they leave it: `translate`'s depth, `scale`'s, and `rotate` about an axis
// in the page. A style with one of them is a 4×4 matrix, whose translation
// across and down is still layout's, and the rest of it is what the box's
// plane comes to seen in the `perspective` of the box it is laid out in
// (`placedMatrix`) — a matrix of the plane, or a projection that draws its
// far side smaller.
//
// Each function keeps what it was as well as its matrix (`Primitive`): an
// animation from `rotate(0)` to `rotate(360deg)` turns once, where the
// matrices at its ends are the same one (`css/interpolate.ts`).

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
import {
  IDENTITY4,
  flatten4,
  invertProjection,
  isPlanar,
  lift,
  multiply4,
  perspective4,
  project,
  projectRect,
  rotate4,
  scale4,
  translate4,
} from './transform3d.js';
import type { Mat4, Projection } from './transform3d.js';

/** `matrix(a, b, c, d, e, f)`: the point (x, y) goes to
 *  (ax + cy + e, bx + dy + f), as a 2d context's `transform` has it. */
export type Matrix = readonly [number, number, number, number, number, number];

/** What a box's plane comes to where it is drawn (`placedMatrix`): a
 *  matrix of the plane, or a projection of it where a perspective shows
 *  its far side smaller than its near one. */
export type Placed = Matrix | Projection;

/** One function of a `transform` list: a translation by lengths, a
 *  percentage of the box's own width across and its height down, and a
 *  depth in pixels where it moves toward the viewer; a matrix of the
 *  plane; or a 4×4 for a function out of it — each with the function it
 *  was where that is one an animation interpolates by its arguments. */
export type TransformFunction =
  | { by: [Len, Len]; z?: number }
  | { matrix: Matrix; fn?: Primitive }
  | { solid: Mat4; fn?: Primitive };

/** A function that is numbers alone, as its arguments: a scale across,
 *  down and in depth, a turn in degrees in the plane or about an axis
 *  (x, y, z) in space, a skew in degrees across and down, and a
 *  perspective's distance in pixels, null for `none`. `matrix()` and
 *  `matrix3d()` are none of them. */
export type Primitive =
  | { kind: 'scale'; x: number; y: number; z?: number }
  | { kind: 'rotate'; angle: number }
  | { kind: 'rotate3d'; x: number; y: number; z: number; angle: number }
  | { kind: 'skew'; x: number; y: number }
  | { kind: 'perspective'; depth: number | null };

/** A turn, as `rotate` is one (CSS Transforms 2, 5): in the plane of the
 *  page, which `rotate()` is, or about an axis (x, y, z) in space, which
 *  `rotate3d()` is (`turnAbout`). */
export type Turn = Extract<Primitive, { kind: 'rotate' | 'rotate3d' }>;

/** A turn by degrees about an axis: in the plane where the axis is the one
 *  out of the page — the other way where it points into it — and in space
 *  about any other. An axis of no length turns nothing (`rotate4`). */
export function turnAbout(
  x: number,
  y: number,
  z: number,
  angle: number,
): Turn {
  if (x === 0 && y === 0 && z !== 0) {
    return { kind: 'rotate', angle: z > 0 ? angle : -angle };
  }
  return { kind: 'rotate3d', x, y, z, angle };
}

/** Whether a turn takes the plane out of itself: about an axis with a part
 *  in the page, by anything but whole turns, which come back to it — the
 *  turns whose matrix `primitive` finds is no matrix of the plane. */
function turnsOutOfPlane(turn: Turn): boolean {
  return (
    turn.kind === 'rotate3d' &&
    (turn.x !== 0 || turn.y !== 0) &&
    turn.angle % 360 !== 0
  );
}

/** The matrix a primitive is in the plane: of one out of it, what it does
 *  across and down (`flatten4`). */
export function primitiveMatrix(fn: Primitive): Matrix {
  switch (fn.kind) {
    case 'scale':
      return [fn.x, 0, 0, fn.y, 0, 0];
    case 'rotate':
      return rotation(fn.angle);
    case 'skew':
      return [1, tanDegrees(fn.y), tanDegrees(fn.x), 1, 0, 0];
    default:
      return flatten4(primitiveSolid(fn));
  }
}

/** The 4×4 a primitive is. */
export function primitiveSolid(fn: Primitive): Mat4 {
  switch (fn.kind) {
    case 'scale':
      return scale4(fn.x, fn.y, fn.z ?? 1);
    case 'rotate3d':
      return rotate4(fn.x, fn.y, fn.z, fn.angle);
    case 'perspective':
      return fn.depth === null ? IDENTITY4 : perspective4(fn.depth);
    default:
      return lift(primitiveMatrix(fn));
  }
}

function tanDegrees(degrees: number): number {
  return Math.tan((degrees * Math.PI) / 180);
}

/** A function of a list as its primitive: the matrix and what made it —
 *  of the plane where it does nothing out of it, as `rotateY(0)` and
 *  `scale3d(2, 2, 1)` do, and the 4×4 where it does. */
export function primitive(fn: Primitive): TransformFunction {
  if (fn.kind === 'rotate' || fn.kind === 'skew') {
    return { matrix: primitiveMatrix(fn), fn };
  }
  const solid = primitiveSolid(fn);
  return isPlanar(solid) ? { matrix: flatten4(solid), fn } : { solid, fn };
}

/** A function of a list as the 4×4 it is: a translation by `width` and
 *  `height` where its lengths are percentages of them. */
export function solidOf(
  fn: TransformFunction,
  width: number,
  height: number,
): Mat4 {
  if ('solid' in fn) return fn.solid;
  if ('matrix' in fn) return lift(fn.matrix);
  return translate4(
    resolve(fn.by[0], width, 0),
    resolve(fn.by[1], height, 0),
    fn.z ?? 0,
  );
}

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
export function invert(m: Matrix): Matrix | null;
export function invert(m: Placed): Placed | null;
export function invert(m: Placed): Placed | null {
  if (m.length === 9) return invertProjection(m);
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** Where a point goes: through a projection, nowhere — out at infinity —
 *  where it goes behind the viewer, which sees nothing of it. */
export function mapPoint(m: Placed, x: number, y: number): [number, number] {
  if (m.length === 9) return project(m, x, y) ?? [Infinity, Infinity];
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The rectangle around where a rectangle goes: its four corners', and
 *  through a projection the corners of the part of it in front of the
 *  viewer (`projectRect`). */
export function mapRect(
  m: Placed,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  if (m.length === 9) return projectRect(m, x, y, width, height);
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
export function parseFactor(value: string): number | null {
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
 * write to have a layer made — is a list of a translation by nothing, and
 * a transform still: the box is a containing block and a stacking context
 * as any transformed box is.
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
    if (fn !== null) out.push(fn);
  }
  return out;
}

/** One function: what it is, null where that is nothing, and undefined
 *  where it is no function or its arguments are not its own. */
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
      // a depth is a length, and no percentage
      const z = parseOffset(args[2], ctx);
      if (x === null || y === null || typeof z !== 'number') return undefined;
      return z ? { by: [x, y], z } : { by: [x, y] };
    }
    case 'translatex':
    case 'translatey': {
      const by = count === 1 ? parseOffset(args[0], ctx) : null;
      if (by === null) return undefined;
      return { by: name === 'translatex' ? [by, 0] : [0, by] };
    }
    case 'translatez': {
      const z = count === 1 ? parseOffset(args[0], ctx) : null;
      if (typeof z !== 'number') return undefined;
      return z ? { by: [0, 0], z } : { by: [0, 0] };
    }
    case 'scale': {
      const f = count >= 1 && count <= 2 ? factors() : null;
      return f
        ? primitive({ kind: 'scale', x: f[0], y: f[1] ?? f[0] })
        : undefined;
    }
    case 'scale3d': {
      const f = count === 3 ? factors() : null;
      return f
        ? primitive({ kind: 'scale', x: f[0], y: f[1], z: f[2] })
        : undefined;
    }
    case 'scalex':
    case 'scaley': {
      const f = count === 1 ? factors() : null;
      if (!f) return undefined;
      return primitive(
        name === 'scalex'
          ? { kind: 'scale', x: f[0], y: 1 }
          : { kind: 'scale', x: 1, y: f[0] },
      );
    }
    case 'scalez': {
      const f = count === 1 ? factors() : null;
      return f ? primitive({ kind: 'scale', x: 1, y: 1, z: f[0] }) : undefined;
    }
    case 'rotate':
    case 'rotatez': {
      const a = count === 1 ? angles() : null;
      return a ? primitive({ kind: 'rotate', angle: a[0] }) : undefined;
    }
    case 'rotatex':
    case 'rotatey': {
      const a = count === 1 ? angles() : null;
      if (!a) return undefined;
      const x = name === 'rotatex' ? 1 : 0;
      return primitive({ kind: 'rotate3d', x, y: 1 - x, z: 0, angle: a[0] });
    }
    case 'rotate3d': {
      if (count !== 4) return undefined;
      const axis = args.slice(0, 3).map(parseNumber);
      const angle = parseAngle(args[3]);
      if (angle === null || axis.some((n) => n === null)) return undefined;
      const [x, y, z] = axis as number[];
      // still a function of the list where it turns nothing, which an
      // animation interpolates function by function
      return primitive(turnAbout(x, y, z, angle));
    }
    case 'skew': {
      const a = count >= 1 && count <= 2 ? angles() : null;
      return a ? primitive({ kind: 'skew', x: a[0], y: a[1] ?? 0 }) : undefined;
    }
    case 'skewx':
    case 'skewy': {
      const a = count === 1 ? angles() : null;
      if (!a) return undefined;
      return primitive(
        name === 'skewx'
          ? { kind: 'skew', x: a[0], y: 0 }
          : { kind: 'skew', x: 0, y: a[0] },
      );
    }
    case 'matrix':
    case 'matrix3d': {
      const n = args.map(parseNumber);
      const flat = name === 'matrix';
      if (n.length !== (flat ? 6 : 16) || n.some((v) => v === null)) {
        return undefined;
      }
      const v = n as number[];
      // A matrix's translation is in CSS pixels, as a length without its
      // unit; and a 4×4's columns are written in turn, its depth's
      // translation a length as well and the row a perspective divides by
      // a length's reciprocal, so the device's pixels are S·M·S⁻¹ with S
      // the scale in all three directions.
      if (flat) {
        const [a, b, c, d, e, f] = v;
        return { matrix: [a, b, c, d, e * ctx.scale, f * ctx.scale] };
      }
      const s = ctx.scale;
      const solid = v.map((x, i) =>
        i === 12 || i === 13 || i === 14
          ? x * s
          : i === 3 || i === 7 || i === 11
            ? x / s
            : x,
      );
      return isPlanar(solid) ? { matrix: flatten4(solid) } : { solid };
    }
    case 'perspective': {
      if (count !== 1) return undefined;
      if (args[0].toLowerCase() === 'none') {
        return primitive({ kind: 'perspective', depth: null });
      }
      const depth = parseOffset(args[0], ctx);
      // a distance, and none behind the viewer
      if (typeof depth !== 'number' || depth < 0) return undefined;
      return primitive({ kind: 'perspective', depth });
    }
    default:
      return undefined;
  }
}

/** The axis `rotate` names by a letter, as `rotateX()`, `rotateY()` and
 *  `rotateZ()` turn about it; null for anything else. */
function namedAxis(name: string): number[] | null {
  if (name === 'x') return [1, 0, 0];
  if (name === 'y') return [0, 1, 0];
  return name === 'z' ? [0, 0, 1] : null;
}

/**
 * `rotate` (CSS Transforms 2, 5): an angle in degrees, about the axis out of
 * the page, or about the axis it names — a letter, or a vector, which need
 * not be of length one — in space (`turnAbout`). Null for `none`; undefined
 * for what is no value of it.
 */
export function parseRotate(value: string): Turn | null | undefined {
  const parts = splitValue(value.trim().toLowerCase());
  if (parts.length === 1) {
    if (parts[0] === 'none') return null;
    const angle = parseAngle(parts[0], false);
    return angle === null ? undefined : { kind: 'rotate', angle };
  }
  // an axis and an angle, in either order; the axis a letter or a vector
  const at = parts.findIndex((p) => parseAngle(p, false) !== null);
  const angle = at < 0 ? null : parseAngle(parts[at], false);
  if (angle === null || (at !== 0 && at !== parts.length - 1)) return undefined;
  const axis = parts.filter((_, i) => i !== at);
  const vector =
    axis.length === 1
      ? namedAxis(axis[0])
      : axis.length === 3
        ? axis.map(parseNumber)
        : null;
  if (!vector || vector.some((n) => n === null)) return undefined;
  const [x, y, z] = vector as number[];
  return turnAbout(x, y, z, angle);
}

/** `scale` (CSS Transforms 2, 5): across, down and in depth, the one
 *  factor across and down where one is written, and none in depth where
 *  two are. Null for `none`. */
export function parseScale(
  value: string,
): [number, number, number] | null | undefined {
  const parts = splitValue(value.trim());
  if (parts.length === 1 && parts[0].toLowerCase() === 'none') return null;
  if (parts.length < 1 || parts.length > 3) return undefined;
  const factors = parts.map(parseFactor);
  if (factors.some((f) => f === null)) return undefined;
  const [x, y, z] = factors as number[];
  return [x, y ?? x, z ?? 1];
}

type Transformed = Pick<
  ComputedStyle,
  'translate' | 'rotate' | 'scale' | 'transform' | 'perspective'
>;

/** Whether a style transforms its box: any of the four properties at
 *  anything but `none`, whatever it comes to — which makes the box a
 *  containing block for all it holds and a stacking context (CSS
 *  Transforms 1, 3) — or a `perspective` for what it holds, which does the
 *  same (CSS Transforms 2, 6.1). */
export function transformed(style: Transformed): boolean {
  return (
    style.transform !== null ||
    style.translate !== null ||
    style.rotate !== null ||
    style.scale !== null ||
    style.perspective !== null
  );
}

/** Whether a style's transform may do more to its box than move it across
 *  and down — turn it, scale it, skew it, or move it toward the viewer —
 *  which is what a box is painted through a matrix for (`placedMatrix`).
 *  Its fields alone, since it is asked before every box that may be one
 *  is painted: a list that only moves the box is one as well. */
export function drawnThrough(style: Transformed): boolean {
  return (
    style.transform !== null ||
    style.rotate !== null ||
    style.scale !== null ||
    (style.translate !== null && style.translate[2] !== 0)
  );
}

const SOLID = new WeakMap<readonly TransformFunction[], boolean>();

/** Whether a style's transform takes its box out of the plane: `translate`
 *  or `scale` with a depth, `rotate` about an axis in the page, or a
 *  function of the list that does one of those or puts the box in a
 *  perspective of its own. The list's answer kept by the list, which every
 *  style with it shares. */
export function outOfPlane(
  style: Pick<ComputedStyle, 'translate' | 'rotate' | 'scale' | 'transform'>,
): boolean {
  const { translate, rotate, scale } = style;
  if (translate !== null && translate[2] !== 0) return true;
  if (scale !== null && scale[2] !== 1) return true;
  if (rotate !== null && turnsOutOfPlane(rotate)) return true;
  const list = style.transform;
  if (!list) return false;
  let solid = SOLID.get(list);
  if (solid === undefined) {
    solid = list.some((fn) => 'solid' in fn || ('by' in fn && !!fn.z));
    SOLID.set(list, solid);
  }
  return solid;
}

/**
 * A style's whole transform in space, for a box `width` by `height`
 * (`matrixOf`), where it takes the box out of the plane — `translate`,
 * then `rotate`, then `scale`, then the list, each with what it does in
 * depth (CSS Transforms 2, 6) — and null where it does not, and
 * `matrixOf` is all of it.
 */
export function matrix4Of(
  style: Transformed,
  width: number,
  height: number,
): Mat4 | null {
  if (!outOfPlane(style)) return null;
  let m: Mat4 = IDENTITY4;
  const moved = style.translate;
  if (moved) {
    m = translate4(
      resolve(moved[0], width, 0),
      resolve(moved[1], height, 0),
      moved[2],
    );
  }
  if (style.rotate) m = multiply4(m, primitiveSolid(style.rotate));
  const scale = style.scale;
  if (scale) m = multiply4(m, scale4(scale[0], scale[1], scale[2]));
  if (style.transform) {
    for (const fn of style.transform) {
      m = multiply4(m, solidOf(fn, width, height));
    }
  }
  return m;
}

/** How far a 4×4 moves the point it turns about, across and down where the
 *  plane is drawn: the translation layout gives the box
 *  (`applyRelativeOffsets`). None where the point goes to the viewer's eye,
 *  where nothing of the box is drawn. */
export function translation4(m: Mat4): [number, number] {
  const w = m[15];
  if (!(Math.abs(w) > 1e-12)) return [0, 0];
  return [m[12] / w, m[13] / w];
}

/**
 * A style's whole transform, for a box `width` by `height`, which its
 * percentages are of: `translate`, then `rotate`, then `scale`, then the
 * `transform` list (CSS Transforms 2, 6) — without its origin, which is
 * where the box is.
 */
export function matrixOf(
  style: Transformed,
  width: number,
  height: number,
): Matrix {
  const solid = matrix4Of(style, width, height);
  if (solid) {
    // what it does across and down, and how far it moves its origin there
    const [tx, ty] = translation4(solid);
    return [solid[0], solid[1], solid[4], solid[5], tx, ty];
  }
  let m = IDENTITY;
  const moved = style.translate;
  if (moved) {
    m = [1, 0, 0, 1, resolve(moved[0], width, 0), resolve(moved[1], height, 0)];
  }
  // in the plane, a turn is about the axis out of the page, or one in it by
  // whole turns, and a scale has no depth
  if (style.rotate !== null) m = multiply(m, primitiveMatrix(style.rotate));
  if (style.scale) {
    m = multiply(m, [style.scale[0], 0, 0, style.scale[1], 0, 0]);
  }
  if (style.transform) {
    for (const fn of style.transform) {
      m = multiply(
        m,
        'by' in fn
          ? [
              1,
              0,
              0,
              1,
              resolve(fn.by[0], width, 0),
              resolve(fn.by[1], height, 0),
            ]
          : 'matrix' in fn
            ? fn.matrix
            : flatten4(fn.solid),
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
  if (!drawnThrough(style)) return null;
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
