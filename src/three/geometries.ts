// Geometry: the vertex data behind `<boxGeometry>` and friends.
//
// Each parametric class takes the same `args` tuple as its three.js
// counterpart and produces plain arrays — positions, normals, uvs and a
// triangle index — which the indirect renderer compiles into one server-side
// display list and the direct renderer uploads into one set of vertex
// buffers. Either way the arrays are built once per `version`: changing
// `args` bumps the version and drops the cache, and both renderers key their
// GPU/server resources on (geometry identity, version), which is the
// never-send-vertices-twice rule the whole design hangs on.
//
// A port of react-x11's `src/geometry3d.js`, reshaped from prop-reading
// functions into mutable classes so `<boxGeometry args={…} />` and
// `new BoxGeometry(…)` are the same thing — the r3f `args` contract.

export interface GeometryData {
  positions: number[];
  normals: number[];
  uvs: number[];
  index: number[] | null;
}

/**
 * Build a parametric surface as a (segmentsX+1) x (segmentsY+1) vertex grid.
 * `point(u, v)` returns [position, normal] for u, v in 0..1.
 */
function grid(
  segmentsX: number,
  segmentsY: number,
  point: (u: number, v: number) => [number[], number[]],
): GeometryData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let iy = 0; iy <= segmentsY; iy++) {
    for (let ix = 0; ix <= segmentsX; ix++) {
      const u = ix / segmentsX;
      const v = iy / segmentsY;
      const [p, n] = point(u, v);
      positions.push(p[0], p[1], p[2]);
      normals.push(n[0], n[1], n[2]);
      uvs.push(u, 1 - v);
    }
  }
  const stride = segmentsX + 1;
  for (let iy = 0; iy < segmentsY; iy++) {
    for (let ix = 0; ix < segmentsX; ix++) {
      const a = iy * stride + ix;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  return { positions, normals, uvs, index };
}

function merge(parts: GeometryData[]): GeometryData {
  const out: GeometryData = { positions: [], normals: [], uvs: [], index: [] };
  for (const part of parts) {
    const offset = out.positions.length / 3;
    out.positions.push(...part.positions);
    out.normals.push(...part.normals);
    out.uvs.push(...part.uvs);
    for (const i of part.index ?? []) out.index!.push(i + offset);
  }
  return out;
}

/** Flat normals from the triangles themselves, averaged per vertex. */
function faceNormals(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  count: number,
): number[] {
  const normals = new Array<number>(count * 3).fill(0);
  const tri = index ?? Array.from({ length: count }, (_, i) => i);
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const a = tri[i];
    const b = tri[i + 1];
    const c = tri[i + 2];
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const ux = positions[b * 3] - ax;
    const uy = positions[b * 3 + 1] - ay;
    const uz = positions[b * 3 + 2] - az;
    const vx = positions[c * 3] - ax;
    const vy = positions[c * 3 + 1] - ay;
    const vz = positions[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      normals[v * 3] += nx;
      normals[v * 3 + 1] += ny;
      normals[v * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 0) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    } else {
      normals[i + 1] = 1;
    }
  }
  return normals;
}

export interface BufferGeometryAttributes {
  position?: ArrayLike<number>;
  /** Derived from the triangles when omitted. */
  normal?: ArrayLike<number>;
  uv?: ArrayLike<number>;
  index?: ArrayLike<number>;
}

/**
 * The base every geometry is: cached arrays, a version, and `setArgs` for
 * the reconciler.
 *
 * `<bufferGeometry position={…} normal={…} uv={…} index={…} />` is this
 * class used directly — explicit attributes as flat arrays, which is the
 * declarative face of three.js's `setAttribute`. `data({ normals: false })`
 * is what a point cloud or a line asks for: nothing shades them, and
 * deriving face normals for a hundred thousand loose vertices is a pass and
 * a megabyte spent on data no shader will read.
 */
export class BufferGeometry {
  readonly isGeometry = true;
  readonly isBufferGeometry: boolean = true;

  /** Bumped whenever the shape changes; GPU caches key on it. */
  version = 0;
  args: readonly unknown[] = [];

  // Underscore-public, not `private`: a private member would make the class
  // nominal and break the src/dist merge of the JSX augmentation — see the
  // same note on Object3D.
  /** @internal */
  _attributes: BufferGeometryAttributes = {};
  /** @internal */
  _built: Map<'shaded' | 'flat', GeometryData> | null = null;
  /** @internal notified on any change so a demand-mode surface redraws */
  __dirty: (() => void) | null = null;

  constructor(attributes?: BufferGeometryAttributes) {
    if (attributes) this._attributes = { ...attributes };
  }

  /** Replace the constructor arguments — how an `args` prop change lands. */
  setArgs(args: readonly unknown[]): void {
    if (sameArgs(this.args, args)) return;
    this.args = [...args];
    this.invalidate();
  }

  setAttribute(
    name: keyof BufferGeometryAttributes,
    array: ArrayLike<number>,
  ): void {
    this._attributes[name] = array;
    this.invalidate();
  }

  getAttribute(
    name: keyof BufferGeometryAttributes,
  ): ArrayLike<number> | undefined {
    return this._attributes[name];
  }

  /** A new shape: drop the cached arrays; the renderers drop theirs. */
  invalidate(): void {
    this._built = null;
    this.version++;
    this.__dirty?.();
  }

  /** `{ positions, normals, uvs, index }` — memoized per version. */
  data({ normals = true }: { normals?: boolean } = {}): GeometryData {
    const key = normals ? 'shaded' : 'flat';
    if (!this._built) this._built = new Map();
    let built = this._built.get(key);
    if (!built) {
      built = this.build({ normals });
      this._built.set(key, built);
    }
    return built;
  }

  build({ normals }: { normals: boolean }): GeometryData {
    const a = this._attributes;
    const positions = toNumbers(a.position);
    const count = positions.length / 3;
    const index = a.index ? toNumbers(a.index) : null;
    let normalArray = a.normal ? toNumbers(a.normal) : null;
    if (!normalArray) {
      normalArray = normals ? faceNormals(positions, index, count) : [];
    }
    return {
      positions,
      normals: normalArray,
      uvs: a.uv ? toNumbers(a.uv) : new Array<number>(count * 2).fill(0),
      index,
    };
  }
}

const toNumbers = (a: ArrayLike<number> | undefined): number[] =>
  a ? Array.from(a) : [];

function sameArgs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' ? v : fallback;

/** `[width, height, depth, widthSeg, heightSeg, depthSeg]` */
export class BoxGeometry extends BufferGeometry {
  readonly isBoxGeometry = true;
  constructor(...args: (number | undefined)[]) {
    super();
    this.args = args;
  }

  override build(): GeometryData {
    const [w, h, d, ws, hs, ds] = this.args;
    const width = num(w, 1);
    const height = num(h, 1);
    const depth = num(d, 1);
    const segW = num(ws, 1);
    const segH = num(hs, 1);
    const segD = num(ds, 1);

    // one grid per face, oriented by (right, up, normal) basis vectors
    const face = (
      right: number[],
      up: number[],
      normal: number[],
      fw: number,
      fh: number,
      segU: number,
      segV: number,
      offset: number,
    ) =>
      grid(segU, segV, (u, v) => {
        const su = (u - 0.5) * fw;
        const sv = (0.5 - v) * fh;
        return [
          [
            right[0] * su + up[0] * sv + normal[0] * offset,
            right[1] * su + up[1] * sv + normal[1] * offset,
            right[2] * su + up[2] * sv + normal[2] * offset,
          ],
          normal,
        ];
      });

    const x = width / 2;
    const y = height / 2;
    const z = depth / 2;
    return merge([
      face([0, 0, 1], [0, 1, 0], [-1, 0, 0], depth, height, segD, segH, x),
      face([0, 0, -1], [0, 1, 0], [1, 0, 0], depth, height, segD, segH, x),
      face([1, 0, 0], [0, 0, -1], [0, 1, 0], width, depth, segW, segD, y),
      face([1, 0, 0], [0, 0, 1], [0, -1, 0], width, depth, segW, segD, y),
      face([-1, 0, 0], [0, 1, 0], [0, 0, -1], width, height, segW, segH, z),
      face([1, 0, 0], [0, 1, 0], [0, 0, 1], width, height, segW, segH, z),
    ]);
  }
}

/** `[width, height, widthSeg, heightSeg]` */
export class PlaneGeometry extends BufferGeometry {
  readonly isPlaneGeometry = true;
  constructor(...args: (number | undefined)[]) {
    super();
    this.args = args;
  }

  override build(): GeometryData {
    const [w, h, ws, hs] = this.args;
    const width = num(w, 1);
    const height = num(h, 1);
    return grid(num(ws, 1), num(hs, 1), (u, v) => [
      [(u - 0.5) * width, (0.5 - v) * height, 0],
      [0, 0, 1],
    ]);
  }
}

/** `[radius, widthSeg, heightSeg]` */
export class SphereGeometry extends BufferGeometry {
  readonly isSphereGeometry = true;
  constructor(...args: (number | undefined)[]) {
    super();
    this.args = args;
  }

  override build(): GeometryData {
    const [r, ws, hs] = this.args;
    const radius = num(r, 1);
    return grid(num(ws, 32), num(hs, 16), (u, v) => {
      const theta = u * Math.PI * 2;
      const phi = v * Math.PI;
      const n = [
        -Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ];
      return [[n[0] * radius, n[1] * radius, n[2] * radius], n];
    });
  }
}

function cylinderData(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number,
  heightSegments: number,
  openEnded: boolean,
): GeometryData {
  const half = height / 2;
  const slope = (radiusBottom - radiusTop) / height;
  const side = grid(radialSegments, heightSegments, (u, v) => {
    const theta = u * Math.PI * 2;
    const radius = radiusTop + (radiusBottom - radiusTop) * v;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const len = Math.hypot(1, slope) || 1;
    return [
      [radius * sin, half - v * height, radius * cos],
      [sin / len, slope / len, cos / len],
    ];
  });
  if (openEnded) return side;

  // caps: a triangle fan around the centre, expressed as a 1-segment grid
  const cap = (radius: number, y: number, dir: number) =>
    grid(radialSegments, 1, (u, v) => {
      const theta = u * Math.PI * 2 * dir;
      const r = v * radius;
      return [
        [r * Math.sin(theta), y, r * Math.cos(theta)],
        [0, dir, 0],
      ];
    });
  const parts = [side];
  if (radiusTop > 0) parts.push(cap(radiusTop, half, 1));
  if (radiusBottom > 0) parts.push(cap(radiusBottom, -half, -1));
  return merge(parts);
}

/** `[radiusTop, radiusBottom, height, radialSeg, heightSeg, openEnded]` */
export class CylinderGeometry extends BufferGeometry {
  readonly isCylinderGeometry = true;
  constructor(...args: (number | boolean | undefined)[]) {
    super();
    this.args = args;
  }

  override build(): GeometryData {
    const [rt, rb, h, rs, hs, open] = this.args;
    return cylinderData(
      num(rt, 1),
      num(rb, 1),
      num(h, 1),
      num(rs, 32),
      num(hs, 1),
      open === true,
    );
  }
}

/** `[radius, height, radialSeg, heightSeg, openEnded]` — a cylinder whose
 * top radius is zero, exactly as in three.js. */
export class ConeGeometry extends BufferGeometry {
  readonly isConeGeometry = true;
  constructor(...args: (number | boolean | undefined)[]) {
    super();
    this.args = args;
  }

  override build(): GeometryData {
    const [r, h, rs, hs, open] = this.args;
    return cylinderData(
      0,
      num(r, 1),
      num(h, 1),
      num(rs, 32),
      num(hs, 1),
      open === true,
    );
  }
}

/** `[radius, tube, radialSeg, tubularSeg]` */
export class TorusGeometry extends BufferGeometry {
  readonly isTorusGeometry = true;
  constructor(...args: (number | undefined)[]) {
    super();
    this.args = args;
  }

  override build(): GeometryData {
    const [r, t, rs, ts] = this.args;
    const radius = num(r, 1);
    const tube = num(t, 0.4);
    return grid(num(ts, 48), num(rs, 12), (u, v) => {
      const theta = u * Math.PI * 2;
      const phi = v * Math.PI * 2;
      const cx = radius * Math.cos(theta);
      const cz = radius * Math.sin(theta);
      const n = [
        Math.cos(theta) * Math.cos(phi),
        Math.sin(phi),
        Math.sin(theta) * Math.cos(phi),
      ];
      return [[cx + tube * n[0], tube * n[1], cz + tube * n[2]], n];
    });
  }
}
