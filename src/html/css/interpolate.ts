// What a computed value is part of the way to another (CSS Values 4, 3;
// CSS Transforms 1 and 2, 9; CSS Color 4, 12): the values an animation
// passes through between two frames.
//
// It works on computed styles, field by field, so that a length is the
// device pixels or the percentage it came to, whatever unit a frame wrote
// it in, and a colour is the one `parseColor` read. A number goes the
// straight way, a length that is a percentage at one end and pixels at the
// other is a percentage with pixels added (`Pct.px`), and a colour mixes
// in premultiplied sRGB, as a gradient's stops do (`blend`). Two
// `transform` lists go function by function where their functions are
// alike — which is why each keeps what it was (`Primitive`) — and the rest
// of them as matrices, taken apart into a translation, a turn, a scale and
// a skew and put together again: in space where either is out of the
// plane, the turn as a quaternion the short way round
// (`interpolateMatrix4`). `translate` and `scale` go by their values, a
// depth with them, and `rotate` as a `rotate3d()` of a list goes. What none
// of that reads goes over at the half-way point, as CSS has a discrete
// value go.

import { blend, rgbaOf } from './color.js';
import { interpolateFilters } from './filter.js';
import type { FilterFunction } from './filter.js';
import type { BoxShadow } from './style.js';
import {
  IDENTITY,
  multiply,
  primitive,
  primitiveSolid,
  rotation,
  solidOf,
  turnAbout,
} from './transform.js';
import type {
  Matrix,
  Primitive,
  TransformFunction,
  Turn,
} from './transform.js';
import {
  IDENTITY4,
  axisAngleOf,
  flatten4,
  interpolateMatrix4,
  isPlanar,
  multiply4,
} from './transform3d.js';
import type { Mat4 } from './transform3d.js';
import type { Len, Pct } from './values.js';

/**
 * The value of the computed style field `key` that is `q` of the way from
 * `a` to `b` — 0 is `a`, 1 is `b`, and an easing that overshoots goes past
 * either — or undefined where the two cannot be interpolated, and the
 * property they belong to goes over at the half-way point (`discrete`).
 */
export function interpolateField(
  key: string,
  a: unknown,
  b: unknown,
  q: number,
): unknown {
  if (q === 0 || same(a, b)) return a;
  if (q === 1) return b;
  switch (key) {
    case 'visibility':
      // visible all the way between, where either end is, and the nearer
      // end past either (CSS Values 4, 3)
      if (a === 'collapse' || b === 'collapse') return undefined;
      if (a !== 'visible' && b !== 'visible') return undefined;
      return q < 0 ? a : q > 1 ? b : 'visible';
    case 'opacity':
      return typeof a === 'number' && typeof b === 'number'
        ? clamp(a + (b - a) * q, 0, 1)
        : undefined;
    case 'filter':
      return interpolateFilters(
        a as FilterFunction[] | null,
        b as FilterFunction[] | null,
        q,
        mix,
      );
    case 'transform':
      return interpolateTransforms(
        a as TransformFunction[] | null,
        b as TransformFunction[] | null,
        q,
      );
    // `none` at one end is the other's at nothing (CSS Transforms 2, 5):
    // a move by nothing, a turn of none, a scale by one, in depth as well
    case 'translate':
      return mix(a ?? NO_MOVE, b ?? NO_MOVE, q);
    case 'rotate':
      return interpolateRotate(a as Turn | null, b as Turn | null, q);
    case 'scale':
      return mix(a ?? NO_SCALE, b ?? NO_SCALE, q);
    case 'boxShadow':
      return interpolateShadows(
        a as readonly BoxShadow[] | null,
        b as readonly BoxShadow[] | null,
        q,
      );
    case 'fontSizeBasis':
      // a size part of the way between two is the length it comes to,
      // which no family scales, as Blink has an animated size; and the
      // size runs between its ends whatever they were worked out from,
      // where a field that did not mix would hold the whole property
      return 'absolute';
  }
  const value = mix(a, b, q);
  if (typeof value !== 'number') return value;
  if (INTEGERS.has(key)) return Math.round(value);
  return NOT_NEGATIVE.has(key) ? Math.max(0, value) : value;
}

/**
 * Two lists of shadows `q` of the way between (CSS Backgrounds 3, 7.2): the
 * shorter padded with shadows of nothing — no offset, blur or spread, in
 * transparent, inset as the other end's is — and each pair by its parts,
 * the colours as `color` mixes them, so a glow that comes from nothing
 * keeps its hue as it fades in. Undefined where a pair is one inset and
 * one not, or a colour cannot be read, and the list goes over whole.
 * `none` is the empty list.
 */
function interpolateShadows(
  a: readonly BoxShadow[] | null,
  b: readonly BoxShadow[] | null,
  q: number,
): BoxShadow[] | null | undefined {
  const from = a ?? [];
  const to = b ?? [];
  const n = Math.max(from.length, to.length);
  if (!n) return null;
  const out: BoxShadow[] = [];
  for (let i = 0; i < n; i += 1) {
    const s = from[i] ?? nothingLike(to[i]);
    const t = to[i] ?? nothingLike(from[i]);
    if (s.inset !== t.inset) return undefined;
    const color = s.color === t.color ? s.color : blend(s.color, t.color, q);
    if (color === null) return undefined;
    out.push({
      x: s.x + (t.x - s.x) * q,
      y: s.y + (t.y - s.y) * q,
      blur: Math.max(0, s.blur + (t.blur - s.blur) * q),
      spread: s.spread + (t.spread - s.spread) * q,
      color,
      inset: s.inset,
    });
  }
  return out;
}

/** A shadow of nothing, inset as `like` is: what a shorter list of
 *  shadows is padded with. */
const nothingLike = (like: BoxShadow): BoxShadow => ({
  x: 0,
  y: 0,
  blur: 0,
  spread: 0,
  color: 'transparent',
  inset: like.inset,
});

/** The value a discrete property has `q` of the way between two. */
export function discrete<T>(a: T, b: T, q: number): T {
  return q < 0.5 ? a : b;
}

/** `translate` and `scale` at nothing: what `none` is at one end of an
 *  interpolation of them, across, down and in depth. */
const NO_MOVE = Object.freeze([0, 0, 0]);
const NO_SCALE = Object.freeze([1, 1, 1]);

/** The fields whose values are whole numbers, rounded between. */
const INTEGERS = new Set([
  'zIndex',
  'orphans',
  'widows',
  'columnCount',
  'order',
]);

/** The fields that are lengths and numbers no negative value is one of:
 *  an easing that overshoots stops at nothing. */
const NOT_NEGATIVE = new Set([
  'fontSize',
  'fontStretch',
  'lineHeight',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'outlineWidth',
  'columnWidth',
  'columnGap',
  'rowGap',
  'flexGrow',
  'flexShrink',
]);

/**
 * Two values of the same shape, `q` of the way between: numbers, lengths
 * (pixels and percentages mixed), colours, and arrays and records of them
 * whose every member is one; undefined for anything else.
 */
function mix(a: unknown, b: unknown, q: number): unknown {
  if (same(a, b)) return a;
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * q;
  const x = linear(a);
  const y = linear(b);
  if (x && y) {
    const pct = x.pct + (y.pct - x.pct) * q;
    const px = x.px + (y.px - x.px) * q;
    const out: Pct = { pct };
    if (px !== 0) out.px = px;
    return out;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return blend(a, b, q) ?? undefined;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return undefined;
    const out: unknown[] = [];
    for (let i = 0; i < a.length; i += 1) {
      const v = mix(a[i], b[i], q);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (!(k in b)) return undefined;
      const v = mix(a[k], b[k], q);
      if (v === undefined) return undefined;
      out[k] = v;
    }
    return out;
  }
  return undefined;
}

/** A length as a percentage and pixels: a number is pixels, a `Pct` with
 *  no `min()` or `max()` in it is its sum; null for anything else. */
function linear(v: unknown): { pct: number; px: number } | null {
  if (typeof v === 'number') return { pct: 0, px: v };
  if (!isRecord(v) || typeof v.pct !== 'number' || 'of' in v) return null;
  for (const k of Object.keys(v)) if (k !== 'pct' && k !== 'px') return null;
  return { pct: v.pct, px: typeof v.px === 'number' ? v.px : 0 };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Whether two values are the same, member by member. */
/** Structural equality for a computed value: a number, a string, or the
 *  plain objects and arrays a length or a transform list is. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const k of keys) if (!same(x[k], y[k])) return false;
  return true;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- transforms --------------------------------------------------------------

/**
 * Two `transform` lists `q` of the way between (CSS Transforms 2, 9): `none`
 * is the other's functions at nothing, a shorter list is padded with them,
 * and the functions are interpolated pair by pair — a translation by its
 * lengths, a scale, a turn, a skew or a perspective by its arguments, a
 * `matrix()` taken apart — up to the first pair that are not alike, from
 * which the rest of each list is one matrix, taken apart: of the plane
 * where both rests are in it, and in space where either is not. Undefined
 * where that rest moves by a percentage, which no matrix can hold before
 * the box's size is known.
 */
export function interpolateTransforms(
  a: readonly TransformFunction[] | null,
  b: readonly TransformFunction[] | null,
  q: number,
): TransformFunction[] | null | undefined {
  if (!a && !b) return null;
  const x = a ?? b!.map(identityOf);
  const y = b ?? a!.map(identityOf);
  const n = Math.max(x.length, y.length);
  const out: TransformFunction[] = [];
  let i = 0;
  for (; i < n; i += 1) {
    const f = x[i] ?? identityOf(y[i]);
    const g = y[i] ?? identityOf(x[i]);
    const one = interpolateFunction(f, g, q);
    if (!one) break;
    out.push(one);
  }
  if (i < n) {
    const from = x.slice(i);
    const to = y.slice(i);
    if (from.some(isSolid) || to.some(isSolid)) {
      const m = flatten3(from);
      const n3 = flatten3(to);
      if (!m || !n3) return undefined;
      out.push(solidFunction(interpolateMatrix4(m, n3, q)));
    } else {
      const m = flatten(from);
      const n2 = flatten(to);
      if (!m || !n2) return undefined;
      out.push({ matrix: interpolateMatrix(m, n2, q) });
    }
  }
  return out;
}

/** Whether a function is out of the plane. */
function isSolid(fn: TransformFunction): boolean {
  return 'solid' in fn || ('by' in fn && !!fn.z);
}

/** A 4×4 as the function it is: of the plane where it is one. */
function solidFunction(m: Mat4): TransformFunction {
  return isPlanar(m) ? { matrix: flatten4(m) } : { solid: m };
}

/** A function at nothing, of the kind `fn` is. */
function identityOf(fn: TransformFunction): TransformFunction {
  if ('by' in fn) return { by: [0, 0] };
  if (!fn.fn)
    return 'solid' in fn ? { solid: IDENTITY4 } : { matrix: IDENTITY };
  switch (fn.fn.kind) {
    case 'scale':
      return primitive(
        fn.fn.z === undefined
          ? { kind: 'scale', x: 1, y: 1 }
          : { kind: 'scale', x: 1, y: 1, z: 1 },
      );
    case 'rotate':
      return primitive({ kind: 'rotate', angle: 0 });
    case 'rotate3d':
      return primitive({ ...fn.fn, angle: 0 });
    case 'skew':
      return primitive({ kind: 'skew', x: 0, y: 0 });
    case 'perspective':
      return primitive({ kind: 'perspective', depth: null });
  }
}

/** Two functions of a kind between, or null where they are not alike. */
function interpolateFunction(
  f: TransformFunction,
  g: TransformFunction,
  q: number,
): TransformFunction | null {
  if ('by' in f || 'by' in g) {
    if (!('by' in f) || !('by' in g)) return null;
    const by = mix(f.by, g.by, q);
    if (by === undefined) return null;
    const z = (f.z ?? 0) + ((g.z ?? 0) - (f.z ?? 0)) * q;
    return z ? { by: by as [Len, Len], z } : { by: by as [Len, Len] };
  }
  if (!f.fn || !g.fn) {
    if (f.fn || g.fn) return null;
    if ('matrix' in f && 'matrix' in g) {
      return { matrix: interpolateMatrix(f.matrix, g.matrix, q) };
    }
    // `matrix3d()` at either end: taken apart in space
    return solidFunction(
      interpolateMatrix4(solidOf(f, 0, 0), solidOf(g, 0, 0), q),
    );
  }
  const s = f.fn;
  const t = g.fn;
  const at = (u: number, v: number) => u + (v - u) * q;
  let fn: Primitive;
  if (s.kind === 'rotate' && t.kind === 'rotate') {
    fn = { kind: 'rotate', angle: at(s.angle, t.angle) };
  } else if (turns(s) && turns(t)) {
    // two turns about axes of their own are matrices, taken apart
    const turn = turnBetween(s, t, q);
    if (!turn) {
      return solidFunction(
        interpolateMatrix4(solidOf(f, 0, 0), solidOf(g, 0, 0), q),
      );
    }
    fn = turn;
  } else if (s.kind === 'scale' && t.kind === 'scale') {
    fn =
      s.z === undefined && t.z === undefined
        ? { kind: 'scale', x: at(s.x, t.x), y: at(s.y, t.y) }
        : {
            kind: 'scale',
            x: at(s.x, t.x),
            y: at(s.y, t.y),
            z: at(s.z ?? 1, t.z ?? 1),
          };
  } else if (s.kind === 'skew' && t.kind === 'skew') {
    fn = { kind: 'skew', x: at(s.x, t.x), y: at(s.y, t.y) };
  } else if (s.kind === 'perspective' && t.kind === 'perspective') {
    // by how much it divides, where `none` divides by nothing, as Blink
    // has it: a distance halfway to none is twice as far
    const r = at(s.depth ? 1 / s.depth : 0, t.depth ? 1 / t.depth : 0);
    fn = { kind: 'perspective', depth: r > 0 ? 1 / r : null };
  } else {
    return null;
  }
  return primitive(fn);
}

/** Whether a primitive is a turn, in the plane or in space. */
function turns(fn: Primitive): fn is Turn {
  return fn.kind === 'rotate' || fn.kind === 'rotate3d';
}

/**
 * Two turns `q` of the way between where they are about one axis (CSS
 * Transforms 2, 14, `rotate3d()`): the axis they share, or the one of the
 * two that turns at all — a turn of none is none about any axis — by the
 * angle. Null for two about axes of their own, which go as matrices.
 */
function turnBetween(s: Turn, t: Turn, q: number): Turn | null {
  const u = axisOf(s);
  const v = axisOf(t);
  const axis = !u[3] ? v : !v[3] ? u : sameAxis(u, v) ? u : null;
  if (!axis) return null;
  return turnAbout(axis[0], axis[1], axis[2], u[3] + (v[3] - u[3]) * q);
}

/** A turn of none: `none`, at one end of an interpolation of `rotate`. */
const NO_TURN: Turn = Object.freeze({ kind: 'rotate', angle: 0 });

/**
 * Two values of `rotate` `q` of the way between, as two `rotate3d()` of a
 * list go: about one axis by the angle (`turnBetween`), and about axes of
 * their own as their matrices, taken apart and put together again — the
 * turn as a quaternion (`interpolateMatrix4`) — which is a turn about an
 * axis of its own, between theirs. Undefined where that cannot be taken
 * apart.
 */
function interpolateRotate(
  a: Turn | null,
  b: Turn | null,
  q: number,
): Turn | undefined {
  const s = a ?? NO_TURN;
  const t = b ?? NO_TURN;
  const turn = turnBetween(s, t, q);
  if (turn) return turn;
  const m = interpolateMatrix4(primitiveSolid(s), primitiveSolid(t), q);
  const axis = axisAngleOf(m);
  return axis ? turnAbout(axis[0], axis[1], axis[2], axis[3]) : undefined;
}

/** A turn's axis, of length one, and its angle: no angle where the axis
 *  has no length, which is no turn. */
function axisOf(fn: Turn): [number, number, number, number] {
  if (fn.kind === 'rotate') return [0, 0, 1, fn.angle];
  const length = Math.hypot(fn.x, fn.y, fn.z);
  if (!(length > 0)) return [0, 0, 1, 0];
  return [fn.x / length, fn.y / length, fn.z / length, fn.angle];
}

function sameAxis(u: readonly number[], v: readonly number[]): boolean {
  return (
    Math.abs(u[0] - v[0]) < 1e-9 &&
    Math.abs(u[1] - v[1]) < 1e-9 &&
    Math.abs(u[2] - v[2]) < 1e-9
  );
}

/** A list as one matrix of the plane, its translations in pixels; null
 *  where one is a percentage of the box. */
function flatten(list: readonly TransformFunction[]): Matrix | null {
  let m = IDENTITY;
  for (const fn of list) {
    if ('by' in fn) {
      const [x, y] = fn.by;
      if (typeof x !== 'number' || typeof y !== 'number') return null;
      m = multiply(m, [1, 0, 0, 1, x, y]);
    } else {
      m = multiply(m, 'matrix' in fn ? fn.matrix : flatten4(fn.solid));
    }
  }
  return m;
}

/** `flatten` in space. */
function flatten3(list: readonly TransformFunction[]): Mat4 | null {
  let m: Mat4 = IDENTITY4;
  for (const fn of list) {
    if ('by' in fn) {
      const [x, y] = fn.by;
      if (typeof x !== 'number' || typeof y !== 'number') return null;
    }
    m = multiply4(m, solidOf(fn, 0, 0));
  }
  return m;
}

/**
 * A matrix of the plane taken apart (CSS Transforms 1, 9.2, "Decomposing a
 * 2D matrix"): what it moves by, scales by and turns by, in degrees, and
 * the skew left when those are out of it, as the columns `m11, m12` and
 * `m21, m22`. One that flips the plane has a negative scale on the axis it
 * flips least.
 */
export interface Decomposed {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  angle: number;
  m11: number;
  m12: number;
  m21: number;
  m22: number;
}

export function decompose(m: Matrix): Decomposed {
  let [r0x, r0y, r1x, r1y] = m;
  let sx = Math.hypot(r0x, r0y);
  let sy = Math.hypot(r1x, r1y);
  if (r0x * r1y - r0y * r1x < 0) {
    if (r0x < r1y) sx = -sx;
    else sy = -sy;
  }
  if (sx) {
    r0x /= sx;
    r0y /= sx;
  }
  if (sy) {
    r1x /= sy;
    r1y /= sy;
  }
  const angle = Math.atan2(r0y, r0x);
  if (angle) {
    // the turn taken out: each column less what the other gives it
    const sn = -r0y;
    const cs = r0x;
    const [a, b, c, d] = [r0x, r0y, r1x, r1y];
    r0x = cs * a + sn * c;
    r0y = cs * b + sn * d;
    r1x = -sn * a + cs * c;
    r1y = -sn * b + cs * d;
  }
  return {
    tx: m[4],
    ty: m[5],
    sx,
    sy,
    angle: (angle * 180) / Math.PI,
    m11: r0x,
    m12: r0y,
    m21: r1x,
    m22: r1y,
  };
}

/** A matrix put together from its parts: the skew, then the turn, then the
 *  scale, and the translation — what `decompose` took apart. */
export function recompose(d: Decomposed): Matrix {
  const skew: Matrix = [d.m11, d.m12, d.m21, d.m22, 0, 0];
  const m = multiply(multiply(skew, rotation(d.angle)), [
    d.sx,
    0,
    0,
    d.sy,
    0,
    0,
  ]);
  return [m[0], m[1], m[2], m[3], d.tx, d.ty];
}

/**
 * Two matrices `q` of the way between (CSS Transforms 1, 9.3): their parts
 * interpolated, the turn the short way round, and a flip on one axis at one
 * end and the other at the other made a half turn.
 */
export function interpolateMatrix(a: Matrix, b: Matrix, q: number): Matrix {
  const x = decompose(a);
  const y = decompose(b);
  if ((x.sx < 0 && y.sy < 0) || (x.sy < 0 && y.sx < 0)) {
    x.sx = -x.sx;
    x.sy = -x.sy;
    x.angle += x.angle < 0 ? 180 : -180;
  }
  if (!x.angle) x.angle = 360;
  if (!y.angle) y.angle = 360;
  if (Math.abs(x.angle - y.angle) > 180) {
    if (x.angle > y.angle) x.angle -= 360;
    else y.angle -= 360;
  }
  const at = (u: number, v: number) => u + (v - u) * q;
  return recompose({
    tx: at(x.tx, y.tx),
    ty: at(x.ty, y.ty),
    sx: at(x.sx, y.sx),
    sy: at(x.sy, y.sy),
    angle: at(x.angle, y.angle),
    m11: at(x.m11, y.m11),
    m12: at(x.m12, y.m12),
    m21: at(x.m21, y.m21),
    m22: at(x.m22, y.m22),
  });
}

/** The least change anyone sees in where something is drawn, in device
 *  pixels: what an animation's next frame waits for (`visibleSpan`). */
export const SEEN_PX = 1 / 8;

/**
 * How far apart two values of a field are in what is drawn, counted in the
 * least changes anyone sees: the most a point it moves goes, in
 * `SEEN_PX`, and the most a colour or an opacity goes, in levels of 255.
 * Between the two the field runs as `interpolateField` mixes it, evenly
 * near enough — a turn by its angle, a scale by its factors, a move by its
 * lengths — so a span `q` of the way across is that part of it. `reach` is
 * how far from the point a transform turns or scales about anything it
 * moves can be. Infinity for a field this does not measure, and for one
 * that goes over at once rather than running between; 0 for two the same.
 */
export function visibleSpan(
  key: string,
  a: unknown,
  b: unknown,
  reach: number,
): number {
  if (same(a, b)) return 0;
  switch (key) {
    case 'opacity':
      return typeof a === 'number' && typeof b === 'number'
        ? Math.abs(b - a) * 255
        : Infinity;
    case 'transform':
      return (
        transformsApart(
          a as readonly TransformFunction[] | null,
          b as readonly TransformFunction[] | null,
          reach,
        ) / SEEN_PX
      );
    case 'translate': {
      const x = (a ?? NO_MOVE) as readonly Len[];
      const y = (b ?? NO_MOVE) as readonly Len[];
      let px = 0;
      for (let i = 0; i < 3; i += 1) {
        px += lengthsApart(x[i] ?? 0, y[i] ?? 0, reach);
      }
      return px / SEEN_PX;
    }
    case 'scale': {
      const x = (a ?? NO_SCALE) as readonly number[];
      const y = (b ?? NO_SCALE) as readonly number[];
      let by = 0;
      for (let i = 0; i < 3; i += 1) by += Math.abs((y[i] ?? 1) - (x[i] ?? 1));
      return (by * reach) / SEEN_PX;
    }
    case 'rotate': {
      const turn = turnsApart(
        (a as Turn | null) ?? NO_TURN,
        (b as Turn | null) ?? NO_TURN,
      );
      return (turn * reach) / SEEN_PX;
    }
  }
  // a colour: the most a channel or its alpha goes
  if (typeof a === 'string' && typeof b === 'string') {
    const x = rgbaOf(a);
    const y = rgbaOf(b);
    if (!x || !y) return Infinity;
    let most = 0;
    for (let i = 0; i < 4; i += 1) most = Math.max(most, Math.abs(y[i] - x[i]));
    return most * 255;
  }
  return Infinity;
}

/** How far two lists of transform functions move a point `reach` from
 *  where they turn or scale about, in device pixels, paired as
 *  `interpolateTransforms` pairs them; Infinity where it interpolates
 *  them as matrices, or out of the plane. */
function transformsApart(
  a: readonly TransformFunction[] | null,
  b: readonly TransformFunction[] | null,
  reach: number,
): number {
  if (!a && !b) return 0;
  const x = a ?? b!.map(identityOf);
  const y = b ?? a!.map(identityOf);
  if (x.length !== y.length) return Infinity;
  let px = 0;
  for (let i = 0; i < x.length; i += 1) {
    const f = x[i];
    const g = y[i];
    if ('by' in f && 'by' in g) {
      px +=
        lengthsApart(f.by[0], g.by[0], reach) +
        lengthsApart(f.by[1], g.by[1], reach) +
        Math.abs((g.z ?? 0) - (f.z ?? 0));
      continue;
    }
    const p = 'matrix' in f ? f.fn : undefined;
    const q = 'matrix' in g ? g.fn : undefined;
    if (!p || !q || p.kind !== q.kind) return Infinity;
    if (p.kind === 'scale' && q.kind === 'scale') {
      px +=
        (Math.abs(q.x - p.x) +
          Math.abs(q.y - p.y) +
          Math.abs((q.z ?? 1) - (p.z ?? 1))) *
        reach;
    } else if (
      (p.kind === 'rotate' || p.kind === 'rotate3d') &&
      (q.kind === 'rotate' || q.kind === 'rotate3d')
    ) {
      px += turnsApart(p, q) * reach;
    } else {
      return Infinity;
    }
  }
  return px;
}

/** Two lengths' distance in device pixels, a percentage of `reach`. */
function lengthsApart(a: Len | 'auto', b: Len | 'auto', reach: number): number {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(b - a);
  const x = linear(a);
  const y = linear(b);
  if (!x || !y) return Infinity;
  return (Math.abs(y.pct - x.pct) / 100) * reach + Math.abs(y.px - x.px);
}

/** How far apart two turns are, in radians: by their angles about one
 *  axis, as `turnBetween` runs them, every whole turn counted. */
function turnsApart(a: Turn, b: Turn): number {
  const u = axisOf(a);
  const v = axisOf(b);
  if (u[3] !== 0 && v[3] !== 0 && !sameAxis(u, v)) return Infinity;
  return (Math.abs(v[3] - u[3]) * Math.PI) / 180;
}
