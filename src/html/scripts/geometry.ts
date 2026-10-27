// Geometry Interfaces Module Level 1, as a page's scripts see it: a point, a
// rectangle, a quadrilateral and a matrix, each with its read-only parent —
// `DOMPoint`, `DOMRect`, `DOMQuad` and `DOMMatrix` — and the names a window
// keeps for them besides (`WebKitCSSMatrix`, `SVGPoint`, `SVGRect`,
// `SVGMatrix`).
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` is handed it and calls it.
//
// A page reaches for these to do arithmetic it would otherwise write
// itself, and the commonest is reading where a box was moved to:
// `new DOMMatrixReadOnly(getComputedStyle(el).transform).m41`, which a
// carousel or a drag library asks at every step. So a string is parsed
// here, as CSS Transforms has a `<transform-list>` — every transform
// function, its lengths absolute (`px`, `cm`, …), since there is no box or
// font to resolve a percentage or an `em` against, which the standard makes
// a `SyntaxError`. The parse is this realm's rather than the cascade's: a
// string is no element's, and the answer is sixteen numbers the realm has
// once it has them, with nothing to ask the host.
//
// What each object holds is in a `WeakMap` by the object, as Web IDL keeps
// an interface's internal slots, so its attributes are accessors on its
// prototype and nothing of it is an own property a page can copy or
// overwrite; a setter or a method of the mutable interface asks that the
// object is one (`MUTABLE`). A 4×4 matrix is sixteen numbers in column-major
// order, `m11` to `m44` — `m41` is the first column of the fourth, which is
// the translation along x — and where both sides are 2D a product is made of
// the six numbers a 2D matrix has, as a browser makes it, so that an
// infinity in one meets no zero of the other's third dimension.

/** What `installDom` hands this. */
export interface GeometryDeps {
  DOMException: unknown;
}

/** What `installDom` is handed back. */
export interface GeometryInstall {
  /** The interfaces, and the names a window keeps for them besides. */
  classes: Record<string, unknown>;
  /** A `DOMMatrix` of the six numbers of a 2D matrix, `a` to `f`. */
  matrix2D(values: ArrayLike<number>): unknown;
  /** The six numbers a `DOMMatrix2DInit` comes to, validated and fixed up
   *  (Geometry 1, 6.2); a `TypeError` that starts `fail` where it
   *  contradicts itself. */
  values2D(init: unknown, fail: string): number[];
  /** What a structured clone keeps of one of these: its interface's name
   *  and its numbers; null for anything else. */
  serialize(value: unknown): [string, number[]] | null;
  /** One of these made again from what `serialize` kept. */
  deserialize(name: string, values: ArrayLike<number>): unknown;
  /** This realm is a worker's: a matrix is made from no string there, and
   *  has no stringifier. */
  worker(): void;
}

export function installGeometry(deps: GeometryDeps): GeometryInstall {
  'use strict';
  type Any = any;
  const DOMException: Any = (deps as Any).DOMException;

  // the context's own, taken before any page code runs, since a page may
  // replace what is reached through a prototype
  const apply: Any = Reflect.apply;
  const WM: Any = WeakMap;
  const wmGet: Any = WM.prototype.get;
  const wmSet: Any = WM.prototype.set;
  const WS: Any = WeakSet;
  const wsHas: Any = WS.prototype.has;
  const wsAdd: Any = WS.prototype.add;
  const F64: Any = Float64Array;
  const F32: Any = Float32Array;
  const typedName: Any = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    Symbol.toStringTag,
  )!.get;
  const typedLength: Any = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    'length',
  )!.get;
  const ITERATOR = Symbol.iterator;
  const create = Object.create;
  const defineProperty = Object.defineProperty;
  const ownNames = Object.getOwnPropertyNames;
  const describe = Object.getOwnPropertyDescriptor;
  const sin = Math.sin;
  const cos = Math.cos;
  const tan = Math.tan;
  const sqrt = Math.sqrt;
  const atan2 = Math.atan2;
  const min = Math.min;
  const max = Math.max;
  const RAD = Math.PI / 180;

  /** Whether this realm is a window's (`worker`). */
  let windowRealm = true;

  // --- internal slots ---------------------------------------------------------

  const POINTS = new WM();
  const RECTS = new WM();
  const QUADS = new WM();
  const MATRICES = new WM();
  /** The objects of the mutable interfaces: `DOMPoint`, `DOMRect` and
   *  `DOMMatrix`, and what a page derives from them. */
  const MUTABLE = new WS();

  /** A matrix's slots: its sixteen numbers, column-major, and whether it
   *  is 2D. */
  interface Slots {
    m: Any;
    is2D: boolean;
  }

  const slotsIn = (map: Any, o: Any): Any => {
    const s = apply(wmGet, map, [o]);
    if (!s) throw new TypeError('Illegal invocation');
    return s;
  };
  const mutableIn = (map: Any, o: Any): Any => {
    const s = slotsIn(map, o);
    if (!apply(wsHas, MUTABLE, [o])) throw new TypeError('Illegal invocation');
    return s;
  };
  /** An object of `Kind` with its slots, made as a static method or an
   *  operation makes one: without running its constructor. */
  const made = (Kind: Any, map: Any, slots: Any, mutable: boolean): Any => {
    const o = create(Kind.prototype);
    apply(wmSet, map, [o, slots]);
    if (mutable) apply(wsAdd, MUTABLE, [o]);
    return o;
  };

  // --- dictionaries -------------------------------------------------------------

  /** A dictionary argument: an empty one for `undefined` or `null`. */
  const dictionary = (v: Any, type: string): Any => {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' && typeof v !== 'function') {
      throw new TypeError(`The provided value is not of type '${type}'.`);
    }
    return v;
  };
  /** An `unrestricted double` member: `fallback` where it is not there. */
  const member = (d: Any, key: string, fallback: Any): Any => {
    const v = d[key];
    return v === undefined ? fallback : +v;
  };
  /** A `DOMPointInit`'s x, y, z and w, its members read in the order Web
   *  IDL reads them, which is their names'. */
  const pointInit = (v: Any): Any => {
    const d = dictionary(v, 'DOMPointInit');
    const w = member(d, 'w', 1);
    const x = member(d, 'x', 0);
    const y = member(d, 'y', 0);
    const z = member(d, 'z', 0);
    return new F64([x, y, z, w]);
  };
  /** A `DOMRectInit`'s x, y, width and height. */
  const rectInit = (v: Any): Any => {
    const d = dictionary(v, 'DOMRectInit');
    const height = member(d, 'height', 0);
    const width = member(d, 'width', 0);
    const x = member(d, 'x', 0);
    const y = member(d, 'y', 0);
    return new F64([x, y, width, height]);
  };
  const sameValueZero = (a: number, b: number): boolean =>
    a === b || (a !== a && b !== b);
  /** A `DOMMatrix2DInit`'s six numbers, validated and fixed up (6.2): `a`
   *  and `m11` may both be given only where they agree, and so on. */
  const fixup2D = (d: Any, fail: string): number[] => {
    const a = member(d, 'a', undefined);
    const b = member(d, 'b', undefined);
    const c = member(d, 'c', undefined);
    const dd = member(d, 'd', undefined);
    const e = member(d, 'e', undefined);
    const f = member(d, 'f', undefined);
    const m11 = member(d, 'm11', undefined);
    const m12 = member(d, 'm12', undefined);
    const m21 = member(d, 'm21', undefined);
    const m22 = member(d, 'm22', undefined);
    const m41 = member(d, 'm41', undefined);
    const m42 = member(d, 'm42', undefined);
    const pairs = [
      [a, m11, 'a', 'm11'],
      [b, m12, 'b', 'm12'],
      [c, m21, 'c', 'm21'],
      [dd, m22, 'd', 'm22'],
      [e, m41, 'e', 'm41'],
      [f, m42, 'f', 'm42'],
    ];
    for (let i = 0; i < 6; i++) {
      const p = pairs[i];
      if (
        p[0] !== undefined &&
        p[1] !== undefined &&
        !sameValueZero(p[0], p[1])
      ) {
        throw new TypeError(
          `${fail}: The '${p[2]}' property should equal the '${p[3]}' property.`,
        );
      }
    }
    return [
      m11 ?? a ?? 1,
      m12 ?? b ?? 0,
      m21 ?? c ?? 0,
      m22 ?? dd ?? 1,
      m41 ?? e ?? 0,
      m42 ?? f ?? 0,
    ];
  };
  /** The matrix a `DOMMatrixInit` makes (6.2, "create a DOMMatrix from the
   *  dictionary"): 2D where it says so, or where nothing of its third
   *  dimension is other than the identity's. */
  const matrixInit = (v: Any, fail: string): Slots => {
    const d = dictionary(v, 'DOMMatrixInit');
    const flat = fixup2D(d, fail);
    const given = d.is2D;
    const is2D = given === undefined ? undefined : !!given;
    const m13 = member(d, 'm13', 0);
    const m14 = member(d, 'm14', 0);
    const m23 = member(d, 'm23', 0);
    const m24 = member(d, 'm24', 0);
    const m31 = member(d, 'm31', 0);
    const m32 = member(d, 'm32', 0);
    const m33 = member(d, 'm33', 1);
    const m34 = member(d, 'm34', 0);
    const m43 = member(d, 'm43', 0);
    const m44 = member(d, 'm44', 1);
    const third =
      m13 !== 0 ||
      m14 !== 0 ||
      m23 !== 0 ||
      m24 !== 0 ||
      m31 !== 0 ||
      m32 !== 0 ||
      m34 !== 0 ||
      m43 !== 0 ||
      m33 !== 1 ||
      m44 !== 1;
    if (is2D === true && third) {
      throw new TypeError(
        `${fail}: The is2D member is set to true but the input matrix is a 3d matrix.`,
      );
    }
    if (is2D ?? !third) {
      return {
        m: of2D(flat[0], flat[1], flat[2], flat[3], flat[4], flat[5]),
        is2D: true,
      };
    }
    return {
      m: new F64([
        flat[0],
        flat[1],
        m13,
        m14,
        flat[2],
        flat[3],
        m23,
        m24,
        m31,
        m32,
        m33,
        m34,
        flat[4],
        flat[5],
        m43,
        m44,
      ]),
      is2D: false,
    };
  };

  // --- matrices -----------------------------------------------------------------

  /** The sixteen numbers of the 2D matrix `a` to `f`. */
  const of2D = (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): Any => new F64([a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1]);
  const identity = (): Any => of2D(1, 0, 0, 1, 0, 0);
  /** x × y; of the six numbers a 2D matrix has where `flat`. */
  const product = (x: Any, y: Any, flat: boolean): Any => {
    if (flat) {
      const a = x[0];
      const b = x[1];
      const c = x[4];
      const d = x[5];
      const e = x[12];
      const f = x[13];
      const A = y[0];
      const B = y[1];
      const C = y[4];
      const D = y[5];
      const E = y[12];
      const F = y[13];
      return of2D(
        a * A + c * B,
        b * A + d * B,
        a * C + c * D,
        b * C + d * D,
        a * E + c * F + e,
        b * E + d * F + f,
      );
    }
    const out = new F64(16);
    for (let col = 0; col < 16; col += 4) {
      for (let row = 0; row < 4; row++) {
        out[col + row] =
          x[row] * y[col] +
          x[4 + row] * y[col + 1] +
          x[8 + row] * y[col + 2] +
          x[12 + row] * y[col + 3];
      }
    }
    return out;
  };
  /** The matrix post-multiplied by `n`, 2D where both are. An identity
   *  changes nothing, as Chrome skips a turn or a move of none, so an
   *  infinity in the matrix meets none of its zeros. */
  const post = (s: Slots, n: Any, nIs2D: boolean): void => {
    if (!isIdentity(n)) s.m = product(s.m, n, s.is2D && nIs2D);
    if (!nIs2D) s.is2D = false;
  };
  const translation = (x: number, y: number, z: number): Any =>
    new F64([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  const scaling = (x: number, y: number, z: number): Any =>
    new F64([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
  /** An angle's sine and cosine, in degrees, exactly at each quarter turn,
   *  as Chrome's are, so a turn of 90° leaves a 0 and not 6e-17. */
  const sinCos = (deg: number): number[] => {
    const r = deg % 360;
    if (r % 90 === 0) {
      const q = (r / 90 + 4) % 4;
      return q === 0 ? [0, 1] : q === 1 ? [1, 0] : q === 2 ? [0, -1] : [-1, 0];
    }
    return [sin(deg * RAD), cos(deg * RAD)];
  };
  /** The turn by `deg` degrees about (x, y, z), CSS Transforms 2's
   *  `rotate3d()`; none where the axis has no length. */
  const rotation = (x: number, y: number, z: number, deg: number): Any => {
    const length = sqrt(x * x + y * y + z * z);
    if (length === 0) return identity();
    x /= length;
    y /= length;
    z /= length;
    const sc = sinCos(deg);
    const s = sc[0];
    const c = sc[1];
    // about an axis, from the angle alone, so the axis keeps its 1
    if (x === 0 && y === 0) {
      const t = z > 0 ? s : -s;
      return new F64([c, t, 0, 0, -t, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }
    if (y === 0 && z === 0) {
      const t = x > 0 ? s : -s;
      return new F64([1, 0, 0, 0, 0, c, t, 0, 0, -t, c, 0, 0, 0, 0, 1]);
    }
    if (x === 0 && z === 0) {
      const t = y > 0 ? s : -s;
      return new F64([c, 0, -t, 0, 0, 1, 0, 0, t, 0, c, 0, 0, 0, 0, 1]);
    }
    const t = 1 - c;
    return new F64([
      c + x * x * t,
      x * y * t + z * s,
      x * z * t - y * s,
      0,
      x * y * t - z * s,
      c + y * y * t,
      y * z * t + x * s,
      0,
      x * z * t + y * s,
      y * z * t - x * s,
      c + z * z * t,
      0,
      0,
      0,
      0,
      1,
    ]);
  };
  /** `skew(ax, ay)`, in degrees. */
  const skewing = (ax: number, ay: number): Any =>
    of2D(1, tan(ay * RAD), tan(ax * RAD), 1, 0, 0);
  const finite = (v: number): boolean => v - v === 0;
  /** The inverse of a 4×4 matrix, or null where it has none. */
  const inverse4 = (a: Any): Any => {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    const det =
      b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (det === 0 || !finite(det)) return null;
    const k = 1 / det;
    return new F64([
      (a11 * b11 - a12 * b10 + a13 * b09) * k,
      (a02 * b10 - a01 * b11 - a03 * b09) * k,
      (a31 * b05 - a32 * b04 + a33 * b03) * k,
      (a22 * b04 - a21 * b05 - a23 * b03) * k,
      (a12 * b08 - a10 * b11 - a13 * b07) * k,
      (a00 * b11 - a02 * b08 + a03 * b07) * k,
      (a32 * b02 - a30 * b05 - a33 * b01) * k,
      (a20 * b05 - a22 * b02 + a23 * b01) * k,
      (a10 * b10 - a11 * b08 + a13 * b06) * k,
      (a01 * b08 - a00 * b10 - a03 * b06) * k,
      (a30 * b04 - a31 * b02 + a33 * b00) * k,
      (a21 * b02 - a20 * b04 - a23 * b00) * k,
      (a11 * b07 - a10 * b09 - a12 * b06) * k,
      (a00 * b09 - a01 * b07 + a02 * b06) * k,
      (a31 * b01 - a30 * b03 - a32 * b00) * k,
      (a20 * b03 - a21 * b01 + a22 * b00) * k,
    ]);
  };
  const isIdentity = (m: Any): boolean =>
    m[0] === 1 &&
    m[1] === 0 &&
    m[2] === 0 &&
    m[3] === 0 &&
    m[4] === 0 &&
    m[5] === 1 &&
    m[6] === 0 &&
    m[7] === 0 &&
    m[8] === 0 &&
    m[9] === 0 &&
    m[10] === 1 &&
    m[11] === 0 &&
    m[12] === 0 &&
    m[13] === 0 &&
    m[14] === 0 &&
    m[15] === 1;

  // The transform methods' steps (6.5), on a matrix's slots, which the
  // mutable methods run on their own and the immutable ones on a copy.

  const translateSlots = (s: Slots, tx: number, ty: number, tz: number) =>
    post(s, translation(tx, ty, tz), tz === 0);
  const scaleSlots = (
    s: Slots,
    sx: number,
    sy: number,
    sz: number,
    ox: number,
    oy: number,
    oz: number,
  ): void => {
    translateSlots(s, ox, oy, oz);
    post(s, scaling(sx, sy, sz), sz === 1);
    translateSlots(s, -ox, -oy, -oz);
  };
  /** `rotateSelf`'s steps: the turn about z, then about y, then about x. */
  const rotateSlots = (s: Slots, rx: Any, ry: Any, rz: Any): void => {
    let x = +rx;
    let y = ry === undefined ? undefined : +ry;
    let z = rz === undefined ? undefined : +rz;
    if (y === undefined && z === undefined) {
      z = x;
      x = 0;
      y = 0;
    }
    y ??= 0;
    z ??= 0;
    if (x !== 0 || y !== 0) s.is2D = false;
    post(s, rotation(0, 0, 1, z), true);
    if (y !== 0) post(s, rotation(0, 1, 0, y), false);
    if (x !== 0) post(s, rotation(1, 0, 0, x), false);
  };
  const rotateFromVectorSlots = (s: Slots, x: number, y: number): void => {
    const deg = x === 0 && y === 0 ? 0 : atan2(y, x) / RAD;
    post(s, rotation(0, 0, 1, deg), true);
  };
  const rotateAxisAngleSlots = (
    s: Slots,
    x: number,
    y: number,
    z: number,
    angle: number,
  ): void => post(s, rotation(x, y, z, angle), x === 0 && y === 0);
  const invertSlots = (s: Slots): void => {
    const m = s.m;
    if (s.is2D) {
      const det = m[0] * m[5] - m[1] * m[4];
      if (det !== 0 && finite(det)) {
        s.m = of2D(
          m[5] / det,
          -m[1] / det,
          -m[4] / det,
          m[0] / det,
          (m[4] * m[13] - m[5] * m[12]) / det,
          (m[1] * m[12] - m[0] * m[13]) / det,
        );
        return;
      }
    } else {
      const inverse = inverse4(m);
      if (inverse) {
        s.m = inverse;
        return;
      }
    }
    const nan = new F64(16);
    for (let i = 0; i < 16; i++) nan[i] = NaN;
    s.m = nan;
    s.is2D = false;
  };
  /** A point through a matrix (6.5, "transform a point with a matrix"),
   *  as a new `DOMPoint`; in the plane where both are. */
  const transformed = (p: Any, s: Slots): Any => {
    const m = s.m;
    const x = p[0];
    const y = p[1];
    const z = p[2];
    const w = p[3];
    const out =
      s.is2D && z === 0 && w === 1
        ? new F64([
            m[0] * x + m[4] * y + m[12],
            m[1] * x + m[5] * y + m[13],
            0,
            1,
          ])
        : new F64([
            m[0] * x + m[4] * y + m[8] * z + m[12] * w,
            m[1] * x + m[5] * y + m[9] * z + m[13] * w,
            m[2] * x + m[6] * y + m[10] * z + m[14] * w,
            m[3] * x + m[7] * y + m[11] * z + m[15] * w,
          ]);
    return made(DOMPoint, POINTS, out, true);
  };

  // --- a <transform-list> ------------------------------------------------------

  const table = (entries: Record<string, number>): Record<string, number> => {
    const t = create(null);
    for (const key of ownNames(entries)) t[key] = entries[key];
    return t;
  };
  /** CSS pixels in each absolute length (CSS Values 4, 6.2). */
  const ABSOLUTE = table({
    px: 1,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    q: 96 / 101.6,
    in: 96,
    pc: 16,
    pt: 4 / 3,
  });
  /** Degrees in each angle. */
  const DEGREES = table({ deg: 1, grad: 0.9, rad: 1 / RAD, turn: 360 });
  /** The lengths that depend on something a string has none of: a box, a
   *  font, a viewport, a container. */
  const RELATIVE =
    /^(%|r?(em|ex|ch|ic|cap|lh)|[sld]?v(w|h|i|b|min|max)|cq(w|h|i|b|min|max))$/;
  const COMMENT = /\/\*[^]*?(\*\/|$)/g;
  const EDGES = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
  /** A token: white space, a function's name and its `(`, a number with
   *  its unit or `%`, an identifier, `,` or `)`. */
  const TOKEN =
    /([ \t\n\r\f]+)|([a-zA-Z][a-zA-Z0-9]*)\(|([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(%|-?[a-zA-Z_][a-zA-Z0-9_-]*)?|([a-zA-Z][a-zA-Z0-9_-]*)|([,)])/y;

  /** A transform function's argument: a number and its unit, lower-cased
   *  (`''` for none, `'%'`), or an identifier. */
  interface Arg {
    n: number;
    unit: string;
    ident: string | null;
  }

  /**
   * A string parsed into a matrix (6.2, "parse a string into an abstract
   * matrix"): a `<transform-list>`, `none` or the empty string, its
   * functions post-multiplied in turn, and 2D where every one of them is a
   * 2D transform function. What it fails on is said as Chrome says it.
   */
  const parseTransformList = (text: string): Slots | string => {
    if (text === '') return { m: identity(), is2D: true };
    const source = text.replace(COMMENT, ' ').replace(EDGES, '');
    if (source.toLowerCase() === 'none') return { m: identity(), is2D: true };
    const failed = `Failed to parse '${text}'.`;
    let relative = false;
    const length = (a: Arg): number | null => {
      if (a.ident !== null) return null;
      if (a.unit === '') return a.n === 0 ? 0 : null;
      const px = ABSOLUTE[a.unit];
      if (px !== undefined) return a.n * px;
      if (RELATIVE.test(a.unit)) relative = true;
      return null;
    };
    const angle = (a: Arg): number | null => {
      if (a.ident !== null) return null;
      if (a.unit === '') return a.n === 0 ? 0 : null;
      const deg = DEGREES[a.unit];
      return deg === undefined ? null : a.n * deg;
    };
    const number = (a: Arg): number | null =>
      a.ident === null && a.unit === '' ? a.n : null;
    const scale = (a: Arg): number | null =>
      a.ident === null && a.unit === '%' ? a.n / 100 : number(a);
    /** The arguments as `kinds` reads them, or null where one is not one
     *  or there are not as many as it takes. */
    const read = (
      args: Arg[],
      least: number,
      kinds: Array<(a: Arg) => number | null>,
    ): number[] | null => {
      if (args.length < least || args.length > kinds.length) return null;
      const out: number[] = [];
      for (let i = 0; i < args.length; i++) {
        const v = kinds[i](args[i]);
        if (v === null) return null;
        out[i] = v;
      }
      return out;
    };
    const numbers = (n: number) => {
      const kinds: Array<(a: Arg) => number | null> = [];
      for (let i = 0; i < n; i++) kinds[i] = number;
      return kinds;
    };
    /** A function's matrix, and whether it is a 2D transform function;
     *  null where its arguments are none of its. */
    const fn = (name: string, args: Arg[]): [Any, boolean] | null => {
      let v: number[] | null;
      switch (name) {
        case 'matrix':
          v = read(args, 6, numbers(6));
          return v && [of2D(v[0], v[1], v[2], v[3], v[4], v[5]), true];
        case 'matrix3d':
          v = read(args, 16, numbers(16));
          return v && [new F64(v), false];
        case 'translate':
          v = read(args, 1, [length, length]);
          return v && [translation(v[0], v[1] ?? 0, 0), true];
        case 'translatex':
          v = read(args, 1, [length]);
          return v && [translation(v[0], 0, 0), true];
        case 'translatey':
          v = read(args, 1, [length]);
          return v && [translation(0, v[0], 0), true];
        case 'translatez':
          v = read(args, 1, [length]);
          return v && [translation(0, 0, v[0]), false];
        case 'translate3d':
          v = read(args, 3, [length, length, length]);
          return v && [translation(v[0], v[1], v[2]), false];
        case 'scale':
          v = read(args, 1, [scale, scale]);
          return v && [scaling(v[0], v[1] ?? v[0], 1), true];
        case 'scalex':
          v = read(args, 1, [scale]);
          return v && [scaling(v[0], 1, 1), true];
        case 'scaley':
          v = read(args, 1, [scale]);
          return v && [scaling(1, v[0], 1), true];
        case 'scalez':
          v = read(args, 1, [scale]);
          return v && [scaling(1, 1, v[0]), false];
        case 'scale3d':
          v = read(args, 3, [scale, scale, scale]);
          return v && [scaling(v[0], v[1], v[2]), false];
        case 'rotate':
          v = read(args, 1, [angle]);
          return v && [rotation(0, 0, 1, v[0]), true];
        case 'rotatex':
          v = read(args, 1, [angle]);
          return v && [rotation(1, 0, 0, v[0]), false];
        case 'rotatey':
          v = read(args, 1, [angle]);
          return v && [rotation(0, 1, 0, v[0]), false];
        case 'rotatez':
          v = read(args, 1, [angle]);
          return v && [rotation(0, 0, 1, v[0]), false];
        case 'rotate3d':
          v = read(args, 4, [number, number, number, angle]);
          return v && [rotation(v[0], v[1], v[2], v[3]), false];
        case 'skew':
          v = read(args, 1, [angle, angle]);
          return v && [skewing(v[0], v[1] ?? 0), true];
        case 'skewx':
          v = read(args, 1, [angle]);
          return v && [skewing(v[0], 0), true];
        case 'skewy':
          v = read(args, 1, [angle]);
          return v && [skewing(0, v[0]), true];
        case 'perspective': {
          if (args.length !== 1) return null;
          const m = identity();
          if (args[0].ident === 'none') return [m, false];
          const d = length(args[0]);
          if (d === null || d < 0) return null;
          // under 1px it is 1px, as CSS Transforms 2 has it drawn
          m[11] = -1 / max(d, 1);
          return [m, false];
        }
      }
      return null;
    };
    const s: Slots = { m: identity(), is2D: true };
    let at = 0;
    let functions = 0;
    const token = (): Any => {
      TOKEN.lastIndex = at;
      const t = TOKEN.exec(source);
      if (t) at = TOKEN.lastIndex;
      return t;
    };
    const skipSpace = (): void => {
      TOKEN.lastIndex = at;
      const t = TOKEN.exec(source);
      if (t && t[1]) at = TOKEN.lastIndex;
    };
    while (at < source.length) {
      skipSpace();
      if (at >= source.length) break;
      const head = token();
      if (!head || !head[2]) return failed;
      const args: Arg[] = [];
      for (;;) {
        skipSpace();
        const t = token();
        if (!t) return failed;
        if (t[3]) {
          args[args.length] = {
            n: +t[3],
            unit: (t[4] ?? '').toLowerCase(),
            ident: null,
          };
        } else if (t[5]) {
          args[args.length] = { n: NaN, unit: '', ident: t[5].toLowerCase() };
        } else return failed;
        skipSpace();
        const end = token();
        if (!end || !end[6]) return failed;
        if (end[6] === ')') break;
      }
      const step = fn(head[2].toLowerCase(), args);
      if (!step) {
        return relative ? 'Lengths must be absolute, not relative' : failed;
      }
      post(s, step[0], step[1]);
      functions += 1;
    }
    return functions ? s : failed;
  };

  /** The matrix a constructor's `init` makes (6.3): the identity, a
   *  string's, or a sequence's six numbers or sixteen. */
  const initMatrix = (init: Any, name: string): Slots => {
    const fail = `Failed to construct '${name}'`;
    if (init === undefined) return { m: identity(), is2D: true };
    if (
      (typeof init === 'object' && init !== null) ||
      typeof init === 'function'
    ) {
      const method = init[ITERATOR];
      if (method !== undefined && method !== null) {
        if (typeof method !== 'function') {
          throw new TypeError(
            `${fail}: The object must have a callable @@iterator property.`,
          );
        }
        const it = apply(method, init, []);
        if (
          (typeof it !== 'object' || it === null) &&
          typeof it !== 'function'
        ) {
          throw new TypeError(`${fail}: The iterator is not an object.`);
        }
        const next = it.next;
        const values: number[] = [];
        for (;;) {
          const r = apply(next, it, []);
          if (
            (typeof r !== 'object' || r === null) &&
            typeof r !== 'function'
          ) {
            throw new TypeError(
              `${fail}: The iterator result is not an object.`,
            );
          }
          if (r.done) break;
          values[values.length] = +r.value;
        }
        return fromSequence(values, fail);
      }
    }
    const text = `${init}`;
    if (!windowRealm) {
      throw new TypeError(
        `${fail}: Can't parse a matrix from a string in a worker.`,
      );
    }
    const parsed = parseTransformList(text);
    if (typeof parsed === 'string') {
      throw new DOMException(`${fail}: ${parsed}`, 'SyntaxError');
    }
    return parsed;
  };
  const fromSequence = (v: ArrayLike<number>, fail: string): Slots => {
    if (v.length === 6)
      return { m: of2D(v[0], v[1], v[2], v[3], v[4], v[5]), is2D: true };
    if (v.length === 16) {
      const m = new F64(16);
      for (let i = 0; i < 16; i++) m[i] = v[i];
      return { m, is2D: false };
    }
    throw new TypeError(
      `${fail}: The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix.`,
    );
  };
  /** A `Float32Array` or a `Float64Array`'s numbers, the matrix they make. */
  const fromTyped = (array: Any, type: string, fail: string): Slots => {
    const kind =
      typeof array === 'object' && array !== null
        ? apply(typedName, array, [])
        : undefined;
    if (kind !== type) {
      throw new TypeError(`${fail}: parameter 1 is not of type '${type}'.`);
    }
    const n = apply(typedLength, array, []);
    const values: number[] = [];
    for (let i = 0; i < n; i++) values[i] = array[i];
    return fromSequence(values, fail);
  };

  // --- DOMPoint -----------------------------------------------------------------

  class DOMPointReadOnly {
    constructor(x: Any = 0, y: Any = 0, z: Any = 0, w: Any = 1) {
      apply(wmSet, POINTS, [this, new F64([+x, +y, +z, +w])]);
    }
    static fromPoint(other: Any = undefined): Any {
      return made(DOMPointReadOnly, POINTS, pointInit(other), false);
    }
    get x(): number {
      return slotsIn(POINTS, this)[0];
    }
    get y(): number {
      return slotsIn(POINTS, this)[1];
    }
    get z(): number {
      return slotsIn(POINTS, this)[2];
    }
    get w(): number {
      return slotsIn(POINTS, this)[3];
    }
    matrixTransform(matrix: Any = undefined): Any {
      const p = slotsIn(POINTS, this);
      return transformed(
        p,
        matrixInit(
          matrix,
          "Failed to execute 'matrixTransform' on 'DOMPointReadOnly'",
        ),
      );
    }
    toJSON(): Any {
      const p = slotsIn(POINTS, this);
      return { x: p[0], y: p[1], z: p[2], w: p[3] };
    }
  }
  class DOMPoint extends DOMPointReadOnly {
    constructor(x: Any = 0, y: Any = 0, z: Any = 0, w: Any = 1) {
      super(x, y, z, w);
      apply(wsAdd, MUTABLE, [this]);
    }
    static override fromPoint(other: Any = undefined): Any {
      return made(DOMPoint, POINTS, pointInit(other), true);
    }
    override get x(): number {
      return slotsIn(POINTS, this)[0];
    }
    override set x(v: Any) {
      mutableIn(POINTS, this)[0] = +v;
    }
    override get y(): number {
      return slotsIn(POINTS, this)[1];
    }
    override set y(v: Any) {
      mutableIn(POINTS, this)[1] = +v;
    }
    override get z(): number {
      return slotsIn(POINTS, this)[2];
    }
    override set z(v: Any) {
      mutableIn(POINTS, this)[2] = +v;
    }
    override get w(): number {
      return slotsIn(POINTS, this)[3];
    }
    override set w(v: Any) {
      mutableIn(POINTS, this)[3] = +v;
    }
  }

  // --- DOMRect ------------------------------------------------------------------

  /** A rectangle as `getBoundingClientRect` hands one over: the viewport's
   *  coordinates, which are the document's less the scroll. Its edges are
   *  where its width and height take it, either way. */
  class DOMRectReadOnly {
    constructor(x: Any = 0, y: Any = 0, width: Any = 0, height: Any = 0) {
      apply(wmSet, RECTS, [this, new F64([+x, +y, +width, +height])]);
    }
    static fromRect(other: Any = undefined): Any {
      return made(DOMRectReadOnly, RECTS, rectInit(other), false);
    }
    get x(): number {
      return slotsIn(RECTS, this)[0];
    }
    get y(): number {
      return slotsIn(RECTS, this)[1];
    }
    get width(): number {
      return slotsIn(RECTS, this)[2];
    }
    get height(): number {
      return slotsIn(RECTS, this)[3];
    }
    get top(): number {
      const r = slotsIn(RECTS, this);
      return min(r[1], r[1] + r[3]);
    }
    get right(): number {
      const r = slotsIn(RECTS, this);
      return max(r[0], r[0] + r[2]);
    }
    get bottom(): number {
      const r = slotsIn(RECTS, this);
      return max(r[1], r[1] + r[3]);
    }
    get left(): number {
      const r = slotsIn(RECTS, this);
      return min(r[0], r[0] + r[2]);
    }
    toJSON(): Any {
      const r = slotsIn(RECTS, this);
      return {
        x: r[0],
        y: r[1],
        width: r[2],
        height: r[3],
        top: min(r[1], r[1] + r[3]),
        right: max(r[0], r[0] + r[2]),
        bottom: max(r[1], r[1] + r[3]),
        left: min(r[0], r[0] + r[2]),
      };
    }
  }
  class DOMRect extends DOMRectReadOnly {
    constructor(x: Any = 0, y: Any = 0, width: Any = 0, height: Any = 0) {
      super(x, y, width, height);
      apply(wsAdd, MUTABLE, [this]);
    }
    static override fromRect(other: Any = undefined): Any {
      return made(DOMRect, RECTS, rectInit(other), true);
    }
    override get x(): number {
      return slotsIn(RECTS, this)[0];
    }
    override set x(v: Any) {
      mutableIn(RECTS, this)[0] = +v;
    }
    override get y(): number {
      return slotsIn(RECTS, this)[1];
    }
    override set y(v: Any) {
      mutableIn(RECTS, this)[1] = +v;
    }
    override get width(): number {
      return slotsIn(RECTS, this)[2];
    }
    override set width(v: Any) {
      mutableIn(RECTS, this)[2] = +v;
    }
    override get height(): number {
      return slotsIn(RECTS, this)[3];
    }
    override set height(v: Any) {
      mutableIn(RECTS, this)[3] = +v;
    }
  }

  // --- DOMQuad ------------------------------------------------------------------

  /** Four points, each a `DOMPoint` the quad keeps (`[SameObject]`), so a
   *  page that moves one moves the quad. */
  class DOMQuad {
    constructor(
      p1: Any = undefined,
      p2: Any = undefined,
      p3: Any = undefined,
      p4: Any = undefined,
    ) {
      const a = pointInit(p1);
      const b = pointInit(p2);
      const c = pointInit(p3);
      const d = pointInit(p4);
      apply(wmSet, QUADS, [this, quadOf(a, b, c, d)]);
    }
    static fromRect(other: Any = undefined): Any {
      const r = rectInit(other);
      const x = r[0];
      const y = r[1];
      const right = x + r[2];
      const bottom = y + r[3];
      return made(
        DOMQuad,
        QUADS,
        quadOf(
          new F64([x, y, 0, 1]),
          new F64([right, y, 0, 1]),
          new F64([right, bottom, 0, 1]),
          new F64([x, bottom, 0, 1]),
        ),
        false,
      );
    }
    static fromQuad(other: Any = undefined): Any {
      const d = dictionary(other, 'DOMQuadInit');
      const a = pointInit(d.p1);
      const b = pointInit(d.p2);
      const c = pointInit(d.p3);
      const e = pointInit(d.p4);
      return made(DOMQuad, QUADS, quadOf(a, b, c, e), false);
    }
    get p1(): Any {
      return slotsIn(QUADS, this)[0];
    }
    get p2(): Any {
      return slotsIn(QUADS, this)[1];
    }
    get p3(): Any {
      return slotsIn(QUADS, this)[2];
    }
    get p4(): Any {
      return slotsIn(QUADS, this)[3];
    }
    /** The rectangle around the four points, NaN where any is. */
    getBounds(): Any {
      const q = quadNumbers(slotsIn(QUADS, this));
      const left = min(q[0], q[4], q[8], q[12]);
      const top = min(q[1], q[5], q[9], q[13]);
      const right = max(q[0], q[4], q[8], q[12]);
      const bottom = max(q[1], q[5], q[9], q[13]);
      return made(
        DOMRect,
        RECTS,
        new F64([left, top, right - left, bottom - top]),
        true,
      );
    }
    toJSON(): Any {
      const q = slotsIn(QUADS, this);
      return { p1: q[0], p2: q[1], p3: q[2], p4: q[3] };
    }
  }
  const quadOf = (a: Any, b: Any, c: Any, d: Any): Any[] => [
    made(DOMPoint, POINTS, a, true),
    made(DOMPoint, POINTS, b, true),
    made(DOMPoint, POINTS, c, true),
    made(DOMPoint, POINTS, d, true),
  ];
  /** A quad's points' x, y, z and w, in turn. */
  const quadNumbers = (q: Any[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      const p = slotsIn(POINTS, q[i]);
      for (let j = 0; j < 4; j++) out[i * 4 + j] = p[j];
    }
    return out;
  };

  // --- DOMMatrix ----------------------------------------------------------------

  const readOnlyFail = (op: string) =>
    `Failed to execute '${op}' on 'DOMMatrixReadOnly'`;
  /** A copy of a matrix's slots, which an immutable method runs its
   *  mutable twin's steps on and makes a `DOMMatrix` of. */
  const copyOf = (o: Any): Slots => {
    const s = slotsIn(MATRICES, o);
    const m = new F64(16);
    for (let i = 0; i < 16; i++) m[i] = s.m[i];
    return { m, is2D: s.is2D };
  };
  const matrixOf = (s: Slots): Any => made(DOMMatrix, MATRICES, s, true);

  class DOMMatrixReadOnly {
    constructor(init: Any = undefined) {
      apply(wmSet, MATRICES, [
        this,
        initMatrix(
          init,
          this instanceof DOMMatrix ? 'DOMMatrix' : 'DOMMatrixReadOnly',
        ),
      ]);
    }
    static fromMatrix(other: Any = undefined): Any {
      return made(
        DOMMatrixReadOnly,
        MATRICES,
        matrixInit(other, readOnlyFail('fromMatrix')),
        false,
      );
    }
    static fromFloat32Array(array32: Any): Any {
      return made(
        DOMMatrixReadOnly,
        MATRICES,
        fromTyped(array32, 'Float32Array', readOnlyFail('fromFloat32Array')),
        false,
      );
    }
    static fromFloat64Array(array64: Any): Any {
      return made(
        DOMMatrixReadOnly,
        MATRICES,
        fromTyped(array64, 'Float64Array', readOnlyFail('fromFloat64Array')),
        false,
      );
    }
    get is2D(): boolean {
      return slotsIn(MATRICES, this).is2D;
    }
    get isIdentity(): boolean {
      return isIdentity(slotsIn(MATRICES, this).m);
    }
    translate(tx: Any = 0, ty: Any = 0, tz: Any = 0): Any {
      const s = copyOf(this);
      translateSlots(s, +tx, +ty, +tz);
      return matrixOf(s);
    }
    scale(
      scaleX: Any = 1,
      scaleY: Any = undefined,
      scaleZ: Any = 1,
      originX: Any = 0,
      originY: Any = 0,
      originZ: Any = 0,
    ): Any {
      const s = copyOf(this);
      const sx = +scaleX;
      const sy = scaleY === undefined ? sx : +scaleY;
      scaleSlots(s, sx, sy, +scaleZ, +originX, +originY, +originZ);
      return matrixOf(s);
    }
    scaleNonUniform(scaleX: Any = 1, scaleY: Any = 1): Any {
      const s = copyOf(this);
      scaleSlots(s, +scaleX, +scaleY, 1, 0, 0, 0);
      return matrixOf(s);
    }
    scale3d(
      scale: Any = 1,
      originX: Any = 0,
      originY: Any = 0,
      originZ: Any = 0,
    ): Any {
      const s = copyOf(this);
      const k = +scale;
      scaleSlots(s, k, k, k, +originX, +originY, +originZ);
      return matrixOf(s);
    }
    rotate(rotX: Any = 0, rotY: Any = undefined, rotZ: Any = undefined): Any {
      const s = copyOf(this);
      rotateSlots(s, rotX, rotY, rotZ);
      return matrixOf(s);
    }
    rotateFromVector(x: Any = 0, y: Any = 0): Any {
      const s = copyOf(this);
      rotateFromVectorSlots(s, +x, +y);
      return matrixOf(s);
    }
    rotateAxisAngle(x: Any = 0, y: Any = 0, z: Any = 0, angle: Any = 0): Any {
      const s = copyOf(this);
      rotateAxisAngleSlots(s, +x, +y, +z, +angle);
      return matrixOf(s);
    }
    skewX(sx: Any = 0): Any {
      const s = copyOf(this);
      post(s, skewing(+sx, 0), true);
      return matrixOf(s);
    }
    skewY(sy: Any = 0): Any {
      const s = copyOf(this);
      post(s, skewing(0, +sy), true);
      return matrixOf(s);
    }
    multiply(other: Any = undefined): Any {
      const s = copyOf(this);
      const o = matrixInit(other, readOnlyFail('multiply'));
      post(s, o.m, o.is2D);
      return matrixOf(s);
    }
    flipX(): Any {
      const s = copyOf(this);
      post(s, scaling(-1, 1, 1), true);
      return matrixOf(s);
    }
    flipY(): Any {
      const s = copyOf(this);
      post(s, scaling(1, -1, 1), true);
      return matrixOf(s);
    }
    inverse(): Any {
      const s = copyOf(this);
      invertSlots(s);
      return matrixOf(s);
    }
    transformPoint(point: Any = undefined): Any {
      const s = slotsIn(MATRICES, this);
      return transformed(pointInit(point), s);
    }
    toFloat32Array(): Any {
      return new F32(slotsIn(MATRICES, this).m);
    }
    toFloat64Array(): Any {
      return new F64(slotsIn(MATRICES, this).m);
    }
    /** `matrix(…)` or `matrix3d(…)`, which a string makes the same matrix
     *  of; a window's alone, since a worker parses no string. */
    toString(): string {
      const s = slotsIn(MATRICES, this);
      const m = s.m;
      for (let i = 0; i < 16; i++) {
        if (!finite(m[i])) {
          throw new DOMException(
            `${readOnlyFail('toString')}: Cannot be serialized with NaN or Infinity values.`,
            'InvalidStateError',
          );
        }
      }
      if (s.is2D) {
        return `matrix(${m[0]}, ${m[1]}, ${m[4]}, ${m[5]}, ${m[12]}, ${m[13]})`;
      }
      let out = 'matrix3d(';
      for (let i = 0; i < 16; i++) out += i ? `, ${m[i]}` : `${m[i]}`;
      return `${out})`;
    }
    toJSON(): Any {
      const s = slotsIn(MATRICES, this);
      const m = s.m;
      return {
        a: m[0],
        b: m[1],
        c: m[4],
        d: m[5],
        e: m[12],
        f: m[13],
        m11: m[0],
        m12: m[1],
        m13: m[2],
        m14: m[3],
        m21: m[4],
        m22: m[5],
        m23: m[6],
        m24: m[7],
        m31: m[8],
        m32: m[9],
        m33: m[10],
        m34: m[11],
        m41: m[12],
        m42: m[13],
        m43: m[14],
        m44: m[15],
        is2D: s.is2D,
        isIdentity: isIdentity(m),
      };
    }
  }

  const fail = (op: string) => `Failed to execute '${op}' on 'DOMMatrix'`;
  class DOMMatrix extends DOMMatrixReadOnly {
    constructor(init: Any = undefined) {
      super(init);
      apply(wsAdd, MUTABLE, [this]);
    }
    static override fromMatrix(other: Any = undefined): Any {
      return matrixOf(matrixInit(other, fail('fromMatrix')));
    }
    static override fromFloat32Array(array32: Any): Any {
      return matrixOf(
        fromTyped(array32, 'Float32Array', fail('fromFloat32Array')),
      );
    }
    static override fromFloat64Array(array64: Any): Any {
      return matrixOf(
        fromTyped(array64, 'Float64Array', fail('fromFloat64Array')),
      );
    }
    multiplySelf(other: Any = undefined): Any {
      const s = mutableIn(MATRICES, this);
      const o = matrixInit(other, fail('multiplySelf'));
      post(s, o.m, o.is2D);
      return this;
    }
    preMultiplySelf(other: Any = undefined): Any {
      const s = mutableIn(MATRICES, this);
      const o = matrixInit(other, fail('preMultiplySelf'));
      s.m = product(o.m, s.m, s.is2D && o.is2D);
      if (!o.is2D) s.is2D = false;
      return this;
    }
    translateSelf(tx: Any = 0, ty: Any = 0, tz: Any = 0): Any {
      translateSlots(mutableIn(MATRICES, this), +tx, +ty, +tz);
      return this;
    }
    scaleSelf(
      scaleX: Any = 1,
      scaleY: Any = undefined,
      scaleZ: Any = 1,
      originX: Any = 0,
      originY: Any = 0,
      originZ: Any = 0,
    ): Any {
      const s = mutableIn(MATRICES, this);
      const sx = +scaleX;
      const sy = scaleY === undefined ? sx : +scaleY;
      scaleSlots(s, sx, sy, +scaleZ, +originX, +originY, +originZ);
      return this;
    }
    scale3dSelf(
      scale: Any = 1,
      originX: Any = 0,
      originY: Any = 0,
      originZ: Any = 0,
    ): Any {
      const s = mutableIn(MATRICES, this);
      const k = +scale;
      scaleSlots(s, k, k, k, +originX, +originY, +originZ);
      return this;
    }
    rotateSelf(
      rotX: Any = 0,
      rotY: Any = undefined,
      rotZ: Any = undefined,
    ): Any {
      rotateSlots(mutableIn(MATRICES, this), rotX, rotY, rotZ);
      return this;
    }
    rotateFromVectorSelf(x: Any = 0, y: Any = 0): Any {
      rotateFromVectorSlots(mutableIn(MATRICES, this), +x, +y);
      return this;
    }
    rotateAxisAngleSelf(
      x: Any = 0,
      y: Any = 0,
      z: Any = 0,
      angle: Any = 0,
    ): Any {
      rotateAxisAngleSlots(mutableIn(MATRICES, this), +x, +y, +z, +angle);
      return this;
    }
    skewXSelf(sx: Any = 0): Any {
      post(mutableIn(MATRICES, this), skewing(+sx, 0), true);
      return this;
    }
    skewYSelf(sy: Any = 0): Any {
      post(mutableIn(MATRICES, this), skewing(0, +sy), true);
      return this;
    }
    invertSelf(): Any {
      invertSlots(mutableIn(MATRICES, this));
      return this;
    }
    /** The matrix a transform list makes, in place: a window's alone. */
    setMatrixValue(transformList: Any): Any {
      const s = mutableIn(MATRICES, this);
      if (arguments.length < 1) {
        throw new TypeError(
          `${fail('setMatrixValue')}: 1 argument required, but only 0 present.`,
        );
      }
      const parsed = parseTransformList(`${transformList}`);
      if (typeof parsed === 'string') {
        throw new DOMException(
          `${fail('setMatrixValue')}: ${parsed}`,
          'SyntaxError',
        );
      }
      s.m = parsed.m;
      s.is2D = parsed.is2D;
      return this;
    }
  }

  // Each number's attribute, `a` to `f` and `m11` to `m44`, by its place
  // in the sixteen: read-only on the parent and settable on `DOMMatrix`,
  // where a number of the third dimension other than the identity's makes
  // the matrix 3D for good (6.4).
  const ELEMENTS: Array<[string, number]> = [
    ['a', 0],
    ['b', 1],
    ['c', 4],
    ['d', 5],
    ['e', 12],
    ['f', 13],
  ];
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      ELEMENTS[ELEMENTS.length] = [`m${col + 1}${row + 1}`, col * 4 + row];
    }
  }
  /** What each element is in the identity, where it is of the third
   *  dimension. */
  const THIRD = table({
    2: 0,
    3: 0,
    6: 0,
    7: 0,
    8: 0,
    9: 0,
    10: 1,
    11: 0,
    14: 0,
    15: 1,
  });
  for (const [name, i] of ELEMENTS) {
    const get = function (this: Any): number {
      return slotsIn(MATRICES, this).m[i];
    };
    defineProperty(get, 'name', { value: `get ${name}` });
    defineProperty(DOMMatrixReadOnly.prototype, name, {
      get,
      enumerable: true,
      configurable: true,
    });
    const level = THIRD[i];
    const set = function (this: Any, v: Any): void {
      const s = mutableIn(MATRICES, this);
      const n = +v;
      s.m[i] = n;
      if (level !== undefined && n !== level) s.is2D = false;
    };
    defineProperty(set, 'name', { value: `set ${name}` });
    defineProperty(DOMMatrix.prototype, name, {
      get,
      set,
      enumerable: true,
      configurable: true,
    });
  }

  const interfaces: Record<string, Any> = {
    DOMPointReadOnly,
    DOMPoint,
    DOMRectReadOnly,
    DOMRect,
    DOMQuad,
    DOMMatrixReadOnly,
    DOMMatrix,
  };
  // An attribute and an operation are enumerable on its interface, as
  // Web IDL has them (3.7.6, 3.7.7), so a page that copies a rectangle with
  // `for…in` copies its edges; a class's own are not.
  for (const name of ownNames(interfaces)) {
    const C = interfaces[name];
    for (const target of [C, C.prototype]) {
      for (const key of ownNames(target)) {
        if (
          key === 'constructor' ||
          key === 'prototype' ||
          key === 'length' ||
          key === 'name'
        ) {
          continue;
        }
        const d = describe(target, key)!;
        if (!d.enumerable) {
          d.enumerable = true;
          defineProperty(target, key, d);
        }
      }
    }
  }

  return {
    classes: {
      ...interfaces,
      // a window's other names for them (`[LegacyWindowAlias]`), which a
      // worker's global drops (`dom.ts`, `WINDOW_ONLY`)
      WebKitCSSMatrix: DOMMatrix,
      SVGMatrix: DOMMatrix,
      SVGPoint: DOMPoint,
      SVGRect: DOMRect,
    },
    matrix2D: (v) =>
      matrixOf({ m: of2D(v[0], v[1], v[2], v[3], v[4], v[5]), is2D: true }),
    values2D: (init, fail) =>
      fixup2D(dictionary(init, 'DOMMatrix2DInit'), fail),
    serialize(value) {
      if (typeof value !== 'object' || value === null) return null;
      const mutable = apply(wsHas, MUTABLE, [value]);
      const p = apply(wmGet, POINTS, [value]);
      if (p)
        return [
          mutable ? 'DOMPoint' : 'DOMPointReadOnly',
          [p[0], p[1], p[2], p[3]],
        ];
      const r = apply(wmGet, RECTS, [value]);
      if (r)
        return [
          mutable ? 'DOMRect' : 'DOMRectReadOnly',
          [r[0], r[1], r[2], r[3]],
        ];
      const q = apply(wmGet, QUADS, [value]);
      if (q) return ['DOMQuad', quadNumbers(q)];
      const s = apply(wmGet, MATRICES, [value]);
      if (!s) return null;
      const m = s.m;
      const values: number[] = [];
      if (s.is2D) {
        values[0] = m[0];
        values[1] = m[1];
        values[2] = m[4];
        values[3] = m[5];
        values[4] = m[12];
        values[5] = m[13];
      } else {
        for (let i = 0; i < 16; i++) values[i] = m[i];
      }
      return [mutable ? 'DOMMatrix' : 'DOMMatrixReadOnly', values];
    },
    deserialize(name, v) {
      switch (name) {
        case 'DOMPoint':
        case 'DOMPointReadOnly':
          return made(
            interfaces[name],
            POINTS,
            new F64([v[0], v[1], v[2], v[3]]),
            name === 'DOMPoint',
          );
        case 'DOMRect':
        case 'DOMRectReadOnly':
          return made(
            interfaces[name],
            RECTS,
            new F64([v[0], v[1], v[2], v[3]]),
            name === 'DOMRect',
          );
        case 'DOMQuad': {
          const corners: Any[] = [];
          for (let i = 0; i < 4; i++) {
            corners[i] = new F64([
              v[i * 4],
              v[i * 4 + 1],
              v[i * 4 + 2],
              v[i * 4 + 3],
            ]);
          }
          return made(
            DOMQuad,
            QUADS,
            quadOf(corners[0], corners[1], corners[2], corners[3]),
            false,
          );
        }
        case 'DOMMatrix':
        case 'DOMMatrixReadOnly':
          return made(
            interfaces[name],
            MATRICES,
            fromSequence(v, 'Failed to read a matrix'),
            name === 'DOMMatrix',
          );
      }
      return null;
    },
    worker() {
      windowRealm = false;
      // the stringifier and `setMatrixValue` are `[Exposed=Window]`
      delete (DOMMatrixReadOnly.prototype as Any).toString;
      delete (DOMMatrix.prototype as Any).setMatrixValue;
    },
  };
}
