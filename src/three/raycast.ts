// Client-side picking for the scene, a port of react-x11's
// `src/raycast3d.js` onto the object graph.
//
// There is no GPU picking here: reading pixels back over the protocol is a
// round trip per event, and on XQuartz GL output is not even readable
// through GetImage. So the ray is cast against the CPU-side geometry — the
// same arrays the display lists were compiled from — the way three.js does
// it. Only meshes that (or whose ancestors) have pointer handlers take part,
// which is r3f's one picking optimization that matters.
import type { Mat4, Vec3Tuple } from './math.js';
import {
  invert,
  multiply,
  transformDirection,
  transformPoint,
} from './math.js';
import type { Mesh, Object3D } from './objects.js';
import { InstancedMesh } from './objects.js';
import type { FrameCamera } from './renderer-indirect.js';

const EPSILON = 1e-8;

function normalize([x, y, z]: Vec3Tuple): Vec3Tuple {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * Möller–Trumbore. Returns the ray parameter at the intersection, or null.
 * `dir` need not be unit length: `t` is then in the same units as `dir`,
 * which is what keeps object-space hits comparable in world space.
 */
function intersectTriangle(
  origin: Vec3Tuple,
  dir: Vec3Tuple,
  a: Vec3Tuple,
  b: Vec3Tuple,
  c: Vec3Tuple,
): { t: number; u: number; v: number } | null {
  const e1: Vec3Tuple = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: Vec3Tuple = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p: Vec3Tuple = [
    dir[1] * e2[2] - dir[2] * e2[1],
    dir[2] * e2[0] - dir[0] * e2[2],
    dir[0] * e2[1] - dir[1] * e2[0],
  ];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < EPSILON) return null;
  const inv = 1 / det;
  const t0: Vec3Tuple = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) * inv;
  if (u < 0 || u > 1) return null;
  const q: Vec3Tuple = [
    t0[1] * e1[2] - t0[2] * e1[1],
    t0[2] * e1[0] - t0[0] * e1[2],
    t0[0] * e1[1] - t0[1] * e1[0],
  ];
  const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > EPSILON ? { t, u, v } : null;
}

/** The world-space ray through a pixel of the surface. */
export function rayThrough(
  x: number,
  y: number,
  camera: FrameCamera,
): { origin: Vec3Tuple; direction: Vec3Tuple } | null {
  const inverse = invert(multiply(camera.projection, camera.view));
  if (!inverse) return null;
  const ndcX = (2 * x) / camera.width - 1;
  const ndcY = 1 - (2 * y) / camera.height;
  const near = transformPoint(inverse, [ndcX, ndcY, -1]);
  const far = transformPoint(inverse, [ndcX, ndcY, 1]);
  return {
    origin: near,
    direction: normalize([
      far[0] - near[0],
      far[1] - near[1],
      far[2] - near[2],
    ]),
  };
}

export const hasPointerHandlers = (object: Object3D): boolean =>
  object.__handlers !== null && Object.keys(object.__handlers).length > 0;

/** Does anything in this subtree listen for pointer events? */
export function sceneWantsPointer(nodes: Object3D[]): boolean {
  for (const node of nodes) {
    if (!node.isObject3D) continue;
    if (hasPointerHandlers(node)) return true;
    if (sceneWantsPointer(node.children)) return true;
  }
  return false;
}

/** Meshes worth testing: they, or an ancestor, listen for pointer events. */
function pickable(
  nodes: Object3D[],
  inherited: boolean,
  out: Mesh[] = [],
): Mesh[] {
  for (const node of nodes) {
    if (!node.isObject3D || !node.visible) continue;
    const listening = inherited || hasPointerHandlers(node);
    // Triangles only, and only where the node's own transform is where the
    // geometry really is. A `<points>` or `<line>` has no surface for a ray
    // to meet, and an `<instancedMesh>` is drawn at each instance's
    // transform rather than at its own — testing the base geometry there
    // would report hits in a place nothing was drawn.
    const mesh = node as Mesh;
    if (
      listening &&
      mesh.isMesh &&
      mesh.geometry &&
      mesh.primitive === 'triangles' &&
      !(mesh instanceof InstancedMesh)
    ) {
      out.push(mesh);
    }
    pickable(node.children, listening, out);
  }
  return out;
}

export interface RayHit {
  object: Mesh;
  distance: number;
  point: Vec3Tuple;
  face: number;
  uv: [number, number];
}

/**
 * Intersect the scene with the ray through pixel (x, y). World matrices come
 * from the last rendered frame. Nearest first.
 */
export function raycast(
  roots: Object3D[],
  x: number,
  y: number,
  camera: FrameCamera,
): RayHit[] {
  const ray = rayThrough(x, y, camera);
  if (!ray) return [];
  const hits: RayHit[] = [];

  for (const mesh of pickable(roots, false)) {
    const world = mesh.__world as Mat4 | null;
    const toObject = world ? invert(world) : null;
    if (!toObject) continue;
    const origin = transformPoint(toObject, ray.origin);
    const direction = transformDirection(toObject, ray.direction);
    const { positions, index } = mesh.geometry!.data();
    const count = index ? index.length : positions.length / 3;
    const vertex = (i: number): Vec3Tuple => {
      const v = index ? index[i] : i;
      return [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    };

    let best: { t: number; u: number; v: number; face: number } | null = null;
    for (let i = 0; i + 2 < count; i += 3) {
      const hit = intersectTriangle(
        origin,
        direction,
        vertex(i),
        vertex(i + 1),
        vertex(i + 2),
      );
      if (hit && (!best || hit.t < best.t)) best = { ...hit, face: i / 3 };
    }
    if (!best) continue;
    hits.push({
      object: mesh,
      distance: best.t,
      point: [
        ray.origin[0] + ray.direction[0] * best.t,
        ray.origin[1] + ray.direction[1] * best.t,
        ray.origin[2] + ray.direction[2] * best.t,
      ],
      face: best.face,
      uv: [best.u, best.v],
    });
  }

  return hits.sort((a, b) => a.distance - b.distance);
}
