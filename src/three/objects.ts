// The retained scene graph: what `<mesh>`, `<group>` and the lights become.
//
// This is the half of the react-three-fiber model react-x11's core renderer
// deliberately did not have. There, the scene was described by props and a
// `useFrame` callback that wanted to move something called a state setter.
// Here the objects are **mutable** and refs hand them out, so
// `ref.current.rotation.y += delta` — the way every three-fiber component is
// written — works unchanged: the write lands in a dirty flag, the next frame
// composes the matrix again, and React hears nothing.
//
// What these classes are *not* is three.js. They carry the fields the two
// react-x11 backends can actually draw — position/euler/scale transforms, no
// quaternions, no layers, no shadow state — and nothing else, so anything
// that works here works identically over indirect GLX and over DRI3.
import {
  Color,
  Euler,
  Vector3,
  compose,
  identity,
  lookAtMatrix,
  orthographic,
  perspective,
} from './math.js';
import type { Mat4 } from './math.js';
import type { BufferGeometry } from './geometries.js';
import type { Material } from './materials.js';

/** The pointer handlers an object may carry — the r3f names. */
export interface PointerHandlers {
  onClick?: (event: unknown) => void;
  onPointerDown?: (event: unknown) => void;
  onPointerUp?: (event: unknown) => void;
  onPointerMove?: (event: unknown) => void;
  onPointerOver?: (event: unknown) => void;
  onPointerOut?: (event: unknown) => void;
}

export const POINTER_PROPS = [
  'onClick',
  'onPointerDown',
  'onPointerUp',
  'onPointerMove',
  'onPointerOver',
  'onPointerOut',
] as const;

let nextId = 1;

/** Base for anything that can sit in the scene tree. */
export class Object3D {
  readonly id = nextId++;
  readonly isObject3D: boolean = true;

  name = '';
  userData: Record<string, unknown> = {};

  parent: Object3D | null = null;
  children: Object3D[] = [];

  readonly position = new Vector3(0, 0, 0);
  readonly rotation = new Euler(0, 0, 0);
  readonly scale = new Vector3(1, 1, 1);
  visible = true;

  /** The cursor to show while this object is hovered (needs a handler). */
  cursor: string | null = null;

  /** @internal pointer handlers, written by the reconciler's applyProps */
  __handlers: PointerHandlers | null = null;
  /** @internal the world matrix of the frame that is on screen — picking
   * rays are transformed by exactly what was drawn */
  __world: Mat4 | null = null;
  /** @internal notified on any change so a demand-mode surface redraws */
  __dirty: (() => void) | null = null;

  // Underscore-public rather than `private` on purpose: a private member
  // makes the class nominal, and the JSX augmentation in jsx.ts then exists
  // twice (src and dist) as non-identical declarations in this repo's own
  // typecheck program. Structural classes merge; nominal ones are TS2717.
  /** @internal */
  _local = identity();
  /** @internal */
  _localDirty = true;

  constructor() {
    const mark = () => {
      this._localDirty = true;
      this.__dirty?.();
    };
    this.position._onChange = mark;
    this.rotation._onChange = mark;
    this.scale._onChange = mark;
  }

  add(...objects: Object3D[]): this {
    for (const object of objects) {
      object.parent?.remove(object);
      object.parent = this;
      this.children.push(object);
      object.propagateDirty(this.__dirty);
    }
    this.__dirty?.();
    return this;
  }

  remove(...objects: Object3D[]): this {
    for (const object of objects) {
      const index = this.children.indexOf(object);
      if (index === -1) continue;
      this.children.splice(index, 1);
      object.parent = null;
      object.propagateDirty(null);
    }
    this.__dirty?.();
    return this;
  }

  clear(): this {
    return this.remove(...this.children);
  }

  /** @internal the whole subtree reports into the surface's dirty hook */
  propagateDirty(dirty: (() => void) | null): void {
    this.__dirty = dirty;
    for (const child of this.children) child.propagateDirty(dirty);
  }

  traverse(callback: (object: Object3D) => void): void {
    callback(this);
    for (const child of this.children) child.traverse(callback);
  }

  getObjectByName(name: string): Object3D | undefined {
    if (this.name === name) return this;
    for (const child of this.children) {
      const found = child.getObjectByName(name);
      if (found) return found;
    }
    return undefined;
  }

  /** Local transform, recomposed only after a position/rotation/scale write. */
  localMatrix(): Mat4 {
    if (this._localDirty) {
      compose(
        this.position.toArray(),
        this.rotation.toArray(),
        this.scale.toArray(),
        this._local,
      );
      this._localDirty = false;
    }
    return this._local;
  }
}

export class Group extends Object3D {
  readonly isGroup = true;
}

/**
 * The scene root a `<Canvas>` owns. `background` is what
 * `<color attach="background" args={['#101418']} />` writes, exactly as it
 * does in r3f — the surface clears to it before drawing.
 */
export class Scene extends Object3D {
  readonly isScene = true;
  background: Color | null = null;
}

export type Primitive =
  'triangles' | 'points' | 'lines' | 'lineStrip' | 'lineLoop';

/** One `<instancedMesh instances={[…]}>` entry. */
export interface InstanceSpec {
  position?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[] | number;
  /** Overrides the material's colour for this instance only. */
  color?: string | number | readonly number[];
}

/**
 * Anything that draws a geometry with a material. `<points>`, `<line>` and
 * friends differ only in the primitive their vertices are assembled into —
 * the geometry, the material and the transform work identically for all of
 * them, which is why they share this class.
 */
export class Mesh extends Object3D {
  readonly isMesh: boolean = true;

  geometry: BufferGeometry | null = null;
  material: Material | null = null;

  get primitive(): Primitive {
    return 'triangles';
  }

  constructor(geometry?: BufferGeometry, material?: Material) {
    super();
    if (geometry) this.geometry = geometry;
    if (material) this.material = material;
  }
}

/** `<points>` — one vertex, one dot. Size comes from `<pointsMaterial>`. */
export class Points extends Mesh {
  readonly isPoints = true;
  override get primitive(): Primitive {
    return 'points';
  }
}

/** `<line>` — a connected strip, as three.js reads a vertex list. */
export class Line extends Mesh {
  readonly isLine: boolean = true;
  override get primitive(): Primitive {
    return 'lineStrip';
  }
}

/** `<lineSegments>` — disjoint vertex pairs. */
export class LineSegments extends Line {
  override get primitive(): Primitive {
    return 'lines';
  }
}

/** `<lineLoop>` — a closed strip. */
export class LineLoop extends Line {
  override get primitive(): Primitive {
    return 'lineLoop';
  }
}

/**
 * `<instancedMesh instances={[{ position, rotation, scale, color }, …]}>` —
 * one geometry drawn many times.
 *
 * The `instances` array is declarative rather than three.js's imperative
 * `setMatrixAt`, kept from the core design: what it saves is the geometry,
 * which is uploaded (or compiled into a display list) once. Each instance
 * still costs a transform and a draw — neither backend does GPU instancing,
 * because ES 2 guarantees none and the GLX protocol encodes none.
 */
export class InstancedMesh extends Mesh {
  readonly isInstancedMesh = true;
  instances: InstanceSpec[] = [];
}

// ---------------------------------------------------------------------------
// lights

export class Light extends Object3D {
  readonly isLight: boolean = true;
  intensity = 1;
  readonly color = new Color([1, 1, 1]);

  constructor() {
    super();
    this.color._onChange = () => this.__dirty?.();
  }
}

/** Costs no light unit: its colour joins the ambient term. */
export class AmbientLight extends Light {
  readonly isAmbientLight = true;
}

/** `position` is the direction the light comes from; no attenuation. */
export class DirectionalLight extends Light {
  readonly isDirectionalLight = true;
}

export class PointLight extends Light {
  readonly isPointLight = true;
  distance = 0;
  decay = 0;
}

export class SpotLight extends PointLight {
  readonly isSpotLight = true;
  /** Radians; three.js's default. */
  angle = Math.PI / 6;
  penumbra = 0;
  /**
   * Where the cone points, as a point in world space. three.js's spot light
   * aims at a `target` Object3D that has to be added to the scene; a Vector3
   * carries the same information without the extra mount, and
   * `target={[x, y, z]}` sets it.
   */
  readonly target = new Vector3(0, 0, 0);

  constructor() {
    super();
    this.target._onChange = () => this.__dirty?.();
  }
}

// ---------------------------------------------------------------------------
// cameras

/**
 * The camera model both backends share: a position looking at a target.
 *
 * three.js cameras carry a free orientation (a quaternion); this one derives
 * its view from `position`, `target` and `up`, which is what the fixed
 * subset can express and what nearly all ported code does anyway —
 * `camera.position.set(…); camera.lookAt(0, 0, 0)`. Writing to `rotation`
 * on a camera does nothing, and that edge is documented rather than half
 * supported.
 */
export class Camera extends Object3D {
  readonly isCamera: boolean = true;
  readonly up = new Vector3(0, 1, 0);
  readonly target = new Vector3(0, 0, 0);
  near = 0.1;
  far = 1000;
  zoom = 1;

  constructor() {
    super();
    const mark = () => this.__dirty?.();
    this.up._onChange = mark;
    this.target._onChange = mark;
  }

  lookAt(
    x: number | Vector3 | readonly [number, number, number],
    y?: number,
    z?: number,
  ): void {
    if (typeof x === 'number') this.target.set(x, y ?? 0, z ?? 0);
    else if (x instanceof Vector3) this.target.copy(x);
    else this.target.set(x[0], x[1], x[2]);
  }

  /** View matrix for the frame being drawn. */
  viewMatrix(out?: Mat4): Mat4 {
    return lookAtMatrix(
      this.position.toArray(),
      this.target.toArray(),
      this.up.toArray(),
      out,
    );
  }

  projectionMatrix(width: number, height: number, out?: Mat4): Mat4 {
    void width;
    void height;
    return identity(out);
  }
}

export class PerspectiveCamera extends Camera {
  readonly isPerspectiveCamera = true;
  /** Vertical field of view, degrees — three.js's convention. */
  fov = 50;

  constructor(fov?: number, near?: number, far?: number) {
    super();
    if (fov !== undefined) this.fov = fov;
    if (near !== undefined) this.near = near;
    if (far !== undefined) this.far = far;
    this.position.set(0, 0, 5);
  }

  override projectionMatrix(width: number, height: number, out?: Mat4): Mat4 {
    const aspect = width / Math.max(1, height);
    return perspective(this.fov / this.zoom, aspect, this.near, this.far, out);
  }
}

export class OrthographicCamera extends Camera {
  readonly isOrthographicCamera = true;

  constructor(near?: number, far?: number) {
    super();
    if (near !== undefined) this.near = near;
    if (far !== undefined) this.far = far;
    this.position.set(0, 0, 5);
  }

  override projectionMatrix(width: number, height: number, out?: Mat4): Mat4 {
    const aspect = width / Math.max(1, height);
    return orthographic(
      -aspect / this.zoom,
      aspect / this.zoom,
      -1 / this.zoom,
      1 / this.zoom,
      this.near,
      this.far,
      out,
    );
  }
}
