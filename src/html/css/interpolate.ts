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
// a skew and put together again. What none of that reads goes over at the
// half-way point, as CSS has a discrete value go.

import { blend } from './color.js';
import { IDENTITY, multiply, primitive, rotation } from './transform.js';
import type { Matrix, Primitive, TransformFunction } from './transform.js';
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
    case 'transform':
      return interpolateTransforms(
        a as TransformFunction[] | null,
        b as TransformFunction[] | null,
        q,
      );
    case 'translate':
      return mix(a ?? [0, 0], b ?? [0, 0], q);
    case 'rotate':
      return mix(a ?? 0, b ?? 0, q);
    case 'scale':
      return mix(a ?? [1, 1], b ?? [1, 1], q);
  }
  const value = mix(a, b, q);
  if (typeof value !== 'number') return value;
  if (INTEGERS.has(key)) return Math.round(value);
  return NOT_NEGATIVE.has(key) ? Math.max(0, value) : value;
}

/** The value a discrete property has `q` of the way between two. */
export function discrete<T>(a: T, b: T, q: number): T {
  return q < 0.5 ? a : b;
}

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
function same(a: unknown, b: unknown): boolean {
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
 * lengths, a scale, a turn or a skew by its arguments, a `matrix()` taken
 * apart — up to the first pair that are not alike, from which the rest of
 * each list is one matrix, taken apart. Undefined where that rest moves by
 * a percentage, which no matrix can hold before the box's size is known.
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
    const from = flatten(x.slice(i));
    const to = flatten(y.slice(i));
    if (!from || !to) return undefined;
    out.push({ matrix: interpolateMatrix(from, to, q) });
  }
  return out;
}

/** A function at nothing, of the kind `fn` is. */
function identityOf(fn: TransformFunction): TransformFunction {
  if ('by' in fn) return { by: [0, 0] };
  if (!fn.fn) return { matrix: IDENTITY };
  switch (fn.fn.kind) {
    case 'scale':
      return primitive({ kind: 'scale', x: 1, y: 1 });
    case 'rotate':
      return primitive({ kind: 'rotate', angle: 0 });
    case 'skew':
      return primitive({ kind: 'skew', x: 0, y: 0 });
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
    return by === undefined ? null : { by: by as [Len, Len] };
  }
  if (!f.fn || !g.fn) {
    if (f.fn || g.fn) return null;
    return { matrix: interpolateMatrix(f.matrix, g.matrix, q) };
  }
  const s = f.fn;
  const t = g.fn;
  const at = (u: number, v: number) => u + (v - u) * q;
  let fn: Primitive;
  if (s.kind === 'rotate' && t.kind === 'rotate') {
    fn = { kind: 'rotate', angle: at(s.angle, t.angle) };
  } else if (s.kind === 'scale' && t.kind === 'scale') {
    fn = { kind: 'scale', x: at(s.x, t.x), y: at(s.y, t.y) };
  } else if (s.kind === 'skew' && t.kind === 'skew') {
    fn = { kind: 'skew', x: at(s.x, t.x), y: at(s.y, t.y) };
  } else {
    return null;
  }
  return primitive(fn);
}

/** A list as one matrix, its translations in pixels; null where one is a
 *  percentage of the box. */
function flatten(list: readonly TransformFunction[]): Matrix | null {
  let m = IDENTITY;
  for (const fn of list) {
    if ('matrix' in fn) {
      m = multiply(m, fn.matrix);
      continue;
    }
    const [x, y] = fn.by;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    m = multiply(m, [1, 0, 0, 1, x, y]);
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
