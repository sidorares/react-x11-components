// The math the scene graph stands on: 4x4 matrices in OpenGL's column-major
// order — the layout `MultMatrixf`/`uniformMatrix4fv` take, so nothing is
// transposed on the way out — plus the three value classes react-three-fiber
// code mutates by hand: `Vector3`, `Euler` and `Color`.
//
// The matrix half is a port of react-x11's `src/mat4.js`, kept
// function-shaped rather than wrapped in a `Matrix4` class because the
// renderers are its only callers. The classes exist for the opposite reason:
// they are the *user's* API — `ref.current.position.x += delta` is the whole
// react-three-fiber animation model — so they carry a change callback that
// marks the owning object's local matrix dirty without React hearing about
// it.

export type Mat4 = Float32Array;
export type Vec3Tuple = [number, number, number];

export function identity(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** out = a * b (apply b first, then a — same convention as GL). */
export function multiply(
  a: Mat4,
  b: Mat4,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b0 + a[4 + row] * b1 + a[8 + row] * b2 + a[12 + row] * b3;
    }
  }
  return out;
}

/**
 * Compose position / euler rotation (XYZ order, radians) / scale into a
 * transform, the same order three.js uses: T * Rx * Ry * Rz * S.
 */
export function compose(
  position: ArrayLike<number>,
  rotation: ArrayLike<number>,
  scale: ArrayLike<number>,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const px = position[0];
  const py = position[1];
  const pz = position[2];
  const cx = Math.cos(rotation[0]);
  const sx = Math.sin(rotation[0]);
  const cy = Math.cos(rotation[1]);
  const sy = Math.sin(rotation[1]);
  const cz = Math.cos(rotation[2]);
  const sz = Math.sin(rotation[2]);
  const sxv = scale[0];
  const syv = scale[1];
  const szv = scale[2];

  // rotation matrix for the XYZ euler order
  const r00 = cy * cz;
  const r01 = -cy * sz;
  const r02 = sy;
  const r10 = sx * sy * cz + cx * sz;
  const r11 = -sx * sy * sz + cx * cz;
  const r12 = -sx * cy;
  const r20 = -cx * sy * cz + sx * sz;
  const r21 = cx * sy * sz + sx * cz;
  const r22 = cx * cy;

  out[0] = r00 * sxv;
  out[1] = r10 * sxv;
  out[2] = r20 * sxv;
  out[3] = 0;
  out[4] = r01 * syv;
  out[5] = r11 * syv;
  out[6] = r21 * syv;
  out[7] = 0;
  out[8] = r02 * szv;
  out[9] = r12 * szv;
  out[10] = r22 * szv;
  out[11] = 0;
  out[12] = px;
  out[13] = py;
  out[14] = pz;
  out[15] = 1;
  return out;
}

/** Perspective projection; `fov` is the vertical field of view in degrees. */
export function perspective(
  fov: number,
  aspect: number,
  near: number,
  far: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function orthographic(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  out.fill(0);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = -2 / (far - near);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = -(far + near) / (far - near);
  out[15] = 1;
  return out;
}

function norm3(v: Vec3Tuple): Vec3Tuple {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** View matrix for a camera at `eye` looking at `target`. */
export function lookAtMatrix(
  eye: ArrayLike<number>,
  target: ArrayLike<number>,
  up: ArrayLike<number> = [0, 1, 0],
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const z = norm3([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  let x = cross3([up[0], up[1], up[2]], z);
  if (Math.hypot(x[0], x[1], x[2]) < 1e-6) {
    // up is parallel to the view direction: nudge it so the basis stays sane
    x = cross3([up[0] + 1e-4, up[1], up[2] + 1e-4], z);
  }
  x = norm3(x);
  const y = cross3(z, x);

  out[0] = x[0];
  out[1] = y[0];
  out[2] = z[0];
  out[3] = 0;
  out[4] = x[1];
  out[5] = y[1];
  out[6] = z[1];
  out[7] = 0;
  out[8] = x[2];
  out[9] = y[2];
  out[10] = z[2];
  out[11] = 0;
  out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  out[15] = 1;
  return out;
}

/** Inverse of an affine or projective 4x4; null when singular. */
export function invert(m: Mat4, out: Mat4 = new Float32Array(16)): Mat4 | null {
  const a00 = m[0];
  const a01 = m[1];
  const a02 = m[2];
  const a03 = m[3];
  const a10 = m[4];
  const a11 = m[5];
  const a12 = m[6];
  const a13 = m[7];
  const a20 = m[8];
  const a21 = m[9];
  const a22 = m[10];
  const a23 = m[11];
  const a30 = m[12];
  const a31 = m[13];
  const a32 = m[14];
  const a33 = m[15];

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
  if (!det) return null;
  const d = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

/** Apply a matrix to a point, dividing through by w. */
export function transformPoint(m: Mat4, p: ArrayLike<number>): Vec3Tuple {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

/** Apply a matrix to a direction (no translation, no w divide). */
export function transformDirection(m: Mat4, d: ArrayLike<number>): Vec3Tuple {
  const x = d[0];
  const y = d[1];
  const z = d[2];
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

/** The 3x3 inverse-transpose that takes a normal into view space. */
export function normalMatrix(
  modelView: Mat4,
  out: Float32Array = new Float32Array(9),
): Float32Array {
  const inverse = invert(modelView);
  if (!inverse) {
    // a degenerate transform (a zero scale): leave normals alone rather than
    // filling the buffer with NaN, which would blacken the whole mesh
    out.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    return out;
  }
  // transpose of the inverse, upper 3x3, from a column-major 4x4
  out[0] = inverse[0];
  out[1] = inverse[4];
  out[2] = inverse[8];
  out[3] = inverse[1];
  out[4] = inverse[5];
  out[5] = inverse[9];
  out[6] = inverse[2];
  out[7] = inverse[6];
  out[8] = inverse[10];
  return out;
}

// ---------------------------------------------------------------------------
// the mutable value classes

type ChangeCallback = (() => void) | null;

/**
 * What `position`, `scale`, a spot light's `target` and the camera's `up`
 * are. The subset of three.js's Vector3 that ported components actually
 * touch; every write lands in the owner's dirty flag through `_onChange`, so
 * a `useFrame` mutation is picked up by the next frame without a re-render.
 */
export class Vector3 {
  declare _x: number;
  declare _y: number;
  declare _z: number;
  /** @internal set by the owning object */
  _onChange: ChangeCallback = null;

  readonly isVector3 = true;

  constructor(x = 0, y = 0, z = 0) {
    this._x = x;
    this._y = y;
    this._z = z;
  }

  get x(): number {
    return this._x;
  }
  set x(v: number) {
    this._x = v;
    this._onChange?.();
  }
  get y(): number {
    return this._y;
  }
  set y(v: number) {
    this._y = v;
    this._onChange?.();
  }
  get z(): number {
    return this._z;
  }
  set z(v: number) {
    this._z = v;
    this._onChange?.();
  }

  set(x: number, y: number, z: number): this {
    this._x = x;
    this._y = y;
    this._z = z;
    this._onChange?.();
    return this;
  }

  setScalar(s: number): this {
    return this.set(s, s, s);
  }

  copy(v: { x: number; y: number; z: number }): this {
    return this.set(v.x, v.y, v.z);
  }

  clone(): Vector3 {
    return new Vector3(this._x, this._y, this._z);
  }

  add(v: { x: number; y: number; z: number }): this {
    return this.set(this._x + v.x, this._y + v.y, this._z + v.z);
  }

  sub(v: { x: number; y: number; z: number }): this {
    return this.set(this._x - v.x, this._y - v.y, this._z - v.z);
  }

  multiplyScalar(s: number): this {
    return this.set(this._x * s, this._y * s, this._z * s);
  }

  lerp(v: { x: number; y: number; z: number }, alpha: number): this {
    return this.set(
      this._x + (v.x - this._x) * alpha,
      this._y + (v.y - this._y) * alpha,
      this._z + (v.z - this._z) * alpha,
    );
  }

  dot(v: { x: number; y: number; z: number }): number {
    return this._x * v.x + this._y * v.y + this._z * v.z;
  }

  length(): number {
    return Math.hypot(this._x, this._y, this._z);
  }

  lengthSq(): number {
    return this._x * this._x + this._y * this._y + this._z * this._z;
  }

  distanceTo(v: { x: number; y: number; z: number }): number {
    return Math.hypot(this._x - v.x, this._y - v.y, this._z - v.z);
  }

  normalize(): this {
    const len = this.length() || 1;
    return this.set(this._x / len, this._y / len, this._z / len);
  }

  fromArray(array: ArrayLike<number>, offset = 0): this {
    return this.set(array[offset], array[offset + 1], array[offset + 2]);
  }

  toArray(): Vec3Tuple {
    return [this._x, this._y, this._z];
  }
}

/**
 * XYZ euler angles in radians — the one rotation order both renderers
 * compose, and three.js's default. There is no quaternion here: the
 * fixed-function backend has nowhere to spend one, and every rotation the
 * shared subset can express is an euler.
 */
export class Euler {
  declare _x: number;
  declare _y: number;
  declare _z: number;
  /** @internal set by the owning object */
  _onChange: ChangeCallback = null;

  readonly isEuler = true;
  readonly order = 'XYZ';

  constructor(x = 0, y = 0, z = 0) {
    this._x = x;
    this._y = y;
    this._z = z;
  }

  get x(): number {
    return this._x;
  }
  set x(v: number) {
    this._x = v;
    this._onChange?.();
  }
  get y(): number {
    return this._y;
  }
  set y(v: number) {
    this._y = v;
    this._onChange?.();
  }
  get z(): number {
    return this._z;
  }
  set z(v: number) {
    this._z = v;
    this._onChange?.();
  }

  set(x: number, y: number, z: number): this {
    this._x = x;
    this._y = y;
    this._z = z;
    this._onChange?.();
    return this;
  }

  copy(e: { x: number; y: number; z: number }): this {
    return this.set(e.x, e.y, e.z);
  }

  clone(): Euler {
    return new Euler(this._x, this._y, this._z);
  }

  fromArray(array: ArrayLike<number>, offset = 0): this {
    return this.set(array[offset], array[offset + 1], array[offset + 2]);
  }

  toArray(): Vec3Tuple {
    return [this._x, this._y, this._z];
  }
}

/** Anything a colour prop accepts: CSS string, 0xrrggbb, tuple, or Color. */
export type ColorLike =
  | string
  | number
  | Color
  | readonly [number, number, number]
  | readonly [number, number, number, number];

type StraightColor = [number, number, number, number];

/**
 * ntk's CSS parser, reached through react-x11's re-export rather than a
 * second `ntk` dependency, and read off the namespace rather than declared
 * through `declare module` — an augmentation would be emitted into this
 * package's own `.d.ts` and then seen twice by a program holding both `src/`
 * and `dist/`. `src/flow/model.ts` has the same paragraph for the same
 * reason. Straight alpha on purpose: these values become GL state, and GL
 * takes unassociated components — `cssColor` premultiplies for XRender,
 * which would render a translucent material dark.
 */
import * as ntk from 'react-x11/ntk';

const cssColorStraight = (
  ntk as unknown as {
    cssColorStraight?: (color: string) => StraightColor | null;
  }
).cssColorStraight;

/**
 * The subset of three.js's Color the scene graph reads: `r`, `g`, `b` as
 * 0..1 floats, and a `set` that takes the spellings three.js code uses —
 * `'hotpink'`, `'#e0533d'`, `0xe0533d`, another Color.
 *
 * One extension: CSS can spell alpha (`rgba()`, `#rrggbbaa`) and three's
 * Color cannot carry it, so it is kept on the side as `_alpha` and folded
 * into the material's opacity by the renderers — the same product the core
 * renderer computed from its `color` and `opacity` props.
 */
export class Color {
  r = 1;
  g = 1;
  b = 1;
  /** @internal alpha spelled inside a CSS colour, multiplied into opacity */
  _alpha = 1;
  /** @internal set by the owning material */
  _onChange: ChangeCallback = null;

  readonly isColor = true;

  constructor(value?: ColorLike) {
    if (value !== undefined) this.set(value);
  }

  set(value: ColorLike): this {
    if (typeof value === 'number') return this.setHex(value);
    if (typeof value === 'string') {
      const parsed = cssColorStraight?.(value);
      if (parsed) {
        this.r = parsed[0];
        this.g = parsed[1];
        this.b = parsed[2];
        this._alpha = parsed[3];
        this._onChange?.();
      }
      return this;
    }
    if (value instanceof Color) {
      this.r = value.r;
      this.g = value.g;
      this.b = value.b;
      this._alpha = value._alpha;
      this._onChange?.();
      return this;
    }
    return this.setRGB(value[0], value[1], value[2], value[3]);
  }

  setHex(hex: number): this {
    hex = Math.floor(hex);
    return this.setRGB(
      ((hex >> 16) & 255) / 255,
      ((hex >> 8) & 255) / 255,
      (hex & 255) / 255,
    );
  }

  setRGB(r: number, g: number, b: number, alpha = 1): this {
    this.r = r;
    this.g = g;
    this.b = b;
    this._alpha = alpha;
    this._onChange?.();
    return this;
  }

  copy(c: Color): this {
    return this.set(c);
  }

  clone(): Color {
    const c = new Color();
    c.r = this.r;
    c.g = this.g;
    c.b = this.b;
    c._alpha = this._alpha;
    return c;
  }

  toArray(): [number, number, number] {
    return [this.r, this.g, this.b];
  }
}
