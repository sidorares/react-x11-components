// Earth-centred maths for `<Map3D>`: the WGS84 ellipsoid, the local frame (east, up, north) the scene is drawn
// in, and the orbit camera's matrices. Pure, so all of it is asserted with no display.

export type V3 = [number, number, number];
export type Mat4 = Float32Array;

const A = 6378137.0;
const E2 = 0.00669437999014;
export const rad = (d: number): number => (d * Math.PI) / 180;
export const sub = (a: V3, b: V3): V3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const add = (a: V3, b: V3): V3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Geodetic degrees and metres above the ellipsoid to Earth-centred metres. */
export function ecef(lat: number, lon: number, h = 0): V3 {
  const sl = Math.sin(rad(lat)),
    cl = Math.cos(rad(lat));
  const n = A / Math.sqrt(1 - E2 * sl * sl);
  return [
    (n + h) * cl * Math.cos(rad(lon)),
    (n + h) * cl * Math.sin(rad(lon)),
    (n * (1 - E2) + h) * sl,
  ];
}

/** Earth-centred metres back to degrees and ellipsoid height (Bowring's iteration). */
export function geodetic(p: V3): { lat: number; lon: number; h: number } {
  const lon = Math.atan2(p[1], p[0]);
  const r = Math.hypot(p[0], p[1]);
  let lat = Math.atan2(p[2], r * (1 - E2));
  let h = 0;
  for (let i = 0; i < 5; i++) {
    const s = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * s * s);
    h = r / Math.cos(lat) - n;
    lat = Math.atan2(p[2], r * (1 - (E2 * n) / (n + h)));
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, h };
}

/** The local frame at a place: east +X, up +Y, north -Z, the place at the origin. */
export interface Frame {
  origin: V3;
  east: V3;
  north: V3;
  up: V3;
  /** Earth-centred to the frame. */
  toScene(p: V3): V3;
  /** The frame to Earth-centred. */
  toEcef(p: V3): V3;
}

export function frameAt(lat: number, lon: number, h = 0): Frame {
  const origin = ecef(lat, lon, h);
  const sl = Math.sin(rad(lat)),
    cl = Math.cos(rad(lat)),
    so = Math.sin(rad(lon)),
    co = Math.cos(rad(lon));
  const east: V3 = [-so, co, 0];
  const north: V3 = [-sl * co, -sl * so, cl];
  const up: V3 = [cl * co, cl * so, sl];
  return {
    origin,
    east,
    north,
    up,
    toScene(p) {
      const r = sub(p, origin);
      return [dot(r, east), dot(r, up), -dot(r, north)];
    },
    toEcef(p) {
      return [
        origin[0] + east[0] * p[0] + up[0] * p[1] - north[0] * p[2],
        origin[1] + east[1] * p[0] + up[1] * p[1] - north[1] * p[2],
        origin[2] + east[2] * p[0] + up[2] * p[1] - north[2] * p[2],
      ];
    },
  };
}

/** A 3D tiles node's oriented box: [centre, three half-axes], twelve numbers. */
export function boxDistance(box: readonly number[], p: V3): number {
  const c: V3 = [box[0]!, box[1]!, box[2]!];
  let out = sub(p, c);
  const d = out;
  for (let i = 0; i < 3; i++) {
    const a: V3 = [box[3 + 3 * i]!, box[4 + 3 * i]!, box[5 + 3 * i]!];
    const l2 = dot(a, a);
    if (l2 === 0) continue;
    const k = Math.max(-1, Math.min(1, dot(d, a) / l2));
    out = [out[0] - k * a[0], out[1] - k * a[1], out[2] - k * a[2]];
  }
  return Math.hypot(out[0], out[1], out[2]);
}

/** A sphere around a box, for frustum culling. */
export function boxSphere(box: readonly number[]): { c: V3; r: number } {
  let r2 = 0;
  const hx = Math.abs(box[3]!) + Math.abs(box[6]!) + Math.abs(box[9]!);
  const hy = Math.abs(box[4]!) + Math.abs(box[7]!) + Math.abs(box[10]!);
  const hz = Math.abs(box[5]!) + Math.abs(box[8]!) + Math.abs(box[11]!);
  r2 = hx * hx + hy * hy + hz * hz;
  return { c: [box[0]!, box[1]!, box[2]!], r: Math.sqrt(r2) };
}

/**
 * The orbit camera: looking at `target` (in the frame) from `range` metres away, `heading` degrees clockwise
 * from north, `pitch` degrees down from the horizon (90 is straight down).
 */
export interface Orbit {
  heading: number;
  pitch: number;
  range: number;
  /** vertical field of view, degrees */
  fov: number;
  /** the point looked at, in frame coordinates */
  target: V3;
}

/** Where the eye is, and the camera's own axes, in frame coordinates. */
export function eyeOf(o: Orbit): { eye: V3; forward: V3; right: V3; up: V3 } {
  const h = rad(o.heading),
    p = rad(o.pitch);
  // looking direction: down by `pitch`, towards `heading` (north is -Z, east +X)
  const forward = norm([
    Math.sin(h) * Math.cos(p),
    -Math.sin(p),
    -Math.cos(h) * Math.cos(p),
  ]);
  const eye = sub(o.target, scale(forward, o.range));
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { eye, forward, right, up };
}

/** Column-major view-projection (the frame to clip space) for the orbit camera. */
export function viewProjection(
  o: Orbit,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const { eye, forward, right, up } = eyeOf(o);
  const f = 1 / Math.tan(rad(o.fov) / 2);
  const m = new Float32Array(16);
  // view rows: right, up, -forward
  const r = right,
    u = up,
    b = scale(forward, -1);
  const tx = -dot(r, eye),
    ty = -dot(u, eye),
    tz = -dot(b, eye);
  const nf = 1 / (near - far);
  // proj * view, written out
  m[0] = (f / aspect) * r[0];
  m[1] = f * u[0];
  m[2] = (far + near) * nf * b[0];
  m[3] = -b[0];
  m[4] = (f / aspect) * r[1];
  m[5] = f * u[1];
  m[6] = (far + near) * nf * b[1];
  m[7] = -b[1];
  m[8] = (f / aspect) * r[2];
  m[9] = f * u[2];
  m[10] = (far + near) * nf * b[2];
  m[11] = -b[2];
  m[12] = (f / aspect) * tx;
  m[13] = f * ty;
  m[14] = (far + near) * nf * tz + 2 * far * near * nf;
  m[15] = -tz;
  return m;
}

/** Whether a sphere (Earth-centred) may be seen by the camera: four side planes and the far one. */
export function sphereVisible(
  c: V3,
  r: number,
  eye: V3,
  forward: V3,
  right: V3,
  up: V3,
  fov: number,
  aspect: number,
  far: number,
): boolean {
  const d = sub(c, eye);
  const z = dot(d, forward);
  if (z + r < 0 || z - r > far) return false;
  const th = Math.tan(rad(fov) / 2);
  const tw = th * aspect;
  const x = Math.abs(dot(d, right));
  const y = Math.abs(dot(d, up));
  // a sphere is outside a side plane when its centre is past the plane by more than r
  const kx = Math.sqrt(1 + tw * tw),
    ky = Math.sqrt(1 + th * th);
  return x - tw * z <= r * kx && y - th * z <= r * ky;
}
