// The scene vocabulary, typed — r3f-shaped props with refs that hand out
// the mutable objects.
//
// Two layers, because of where the names currently live:
//
// 1. `ThreeElements` here is the full catalogue and the durable contract.
//    The optional `@react-x11/components/three/jsx-runtime` gives a file
//    the whole vocabulary at these types (see that file for the pragma).
// 2. The `declare module` at the bottom teaches the default JSX namespace
//    the names react-x11 does **not** already declare. The shared names —
//    `<mesh>`, the geometries, the lights — are still typed by core's own
//    3D declarations until core drops them with its scene graph; an
//    augmentation cannot replace an inherited member, only add new ones.
//    When the core removal lands, the shared names move into this block and
//    the pragma stops being necessary.
import type { Key, ReactNode, Ref } from 'react';

import type { Color, Euler, Vector3 } from './math.js';
import type {
  AmbientLight,
  DirectionalLight,
  Group,
  InstancedMesh,
  InstanceSpec,
  Line,
  LineLoop,
  LineSegments,
  Mesh,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  Points,
  SpotLight,
} from './objects.js';
import type {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from './geometries.js';
import type {
  LineBasicMaterial,
  Material,
  MaterialSide,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  MeshStandardMaterial,
  PointsMaterial,
  RawShaderMaterial,
  ShaderMaterial,
  TextureImage,
} from './materials.js';
import type {
  BloomPass,
  EffectComposer,
  FxaaPass,
  ShaderPass,
  VignettePass,
} from './passes.js';
import type { ThreeEvent } from './events.js';

export type Vec3 = [number, number, number] | Vector3;
export type EulerLike = [number, number, number] | Euler;
export type ColorLike =
  | string
  | number
  | Color
  | [number, number, number]
  | [number, number, number, number];

export interface PointerEventProps {
  onClick?: (event: ThreeEvent) => void;
  onPointerDown?: (event: ThreeEvent) => void;
  onPointerUp?: (event: ThreeEvent) => void;
  onPointerMove?: (event: ThreeEvent) => void;
  onPointerOver?: (event: ThreeEvent) => void;
  onPointerOut?: (event: ThreeEvent) => void;
}

/** What every scene element takes on top of its own props. */
export interface NodeProps<T> {
  key?: Key;
  ref?: Ref<T>;
  children?: ReactNode;
  /** Where in the parent this object is assigned instead of being a child —
   * `"geometry"`, `"material"`, `"background"`, a dashed path. Geometries,
   * materials and `<color>` infer theirs. */
  attach?: string;
}

export interface Object3DProps<T = Object3D>
  extends NodeProps<T>, PointerEventProps {
  position?: Vec3;
  /** XYZ euler angles, radians. */
  rotation?: EulerLike;
  /** A tuple, or one number for a uniform scale. */
  scale?: Vec3 | number;
  visible?: boolean;
  name?: string;
  userData?: Record<string, unknown>;
  /** Shown while this object is hovered (needs a pointer handler). */
  cursor?: string;
  /** dashed paths — `position-x`, `material-color` — are applied but typed
   * loosely; spell the object form when the checker matters. */
  'position-x'?: number;
  'position-y'?: number;
  'position-z'?: number;
  'rotation-x'?: number;
  'rotation-y'?: number;
  'rotation-z'?: number;
  'scale-x'?: number;
  'scale-y'?: number;
  'scale-z'?: number;
}

export interface GeometryElementProps<T, A = number[]> extends NodeProps<T> {
  /** Constructor arguments, exactly as in three.js. Changing them rebuilds
   * the shape in place (refs stay valid). */
  args?: A;
}

export interface MaterialElementProps<T = Material> extends NodeProps<T> {
  color?: ColorLike;
  opacity?: number;
  transparent?: boolean;
  wireframe?: boolean;
  side?: MaterialSide;
  map?: TextureImage;
}

export interface LightProps<T> extends Object3DProps<T> {
  color?: ColorLike;
  intensity?: number;
}

export interface ShaderMaterialProps<
  T = ShaderMaterial,
> extends MaterialElementProps<T> {
  vertexShader?: string;
  fragmentShader?: string;
  /** three.js's `{ name: { value } }` shape; bare values are wrapped. */
  uniforms?: Record<string, unknown>;
}

export interface PassProps<T> extends NodeProps<T> {
  /** false skips this pass; the rest of the chain still runs. */
  enabled?: boolean;
}

/** The full scene vocabulary at this package's types. */
export interface ThreeElements {
  group: Object3DProps<Group>;
  mesh: Object3DProps<Mesh>;
  instancedMesh: Object3DProps<InstancedMesh> & {
    instances?: readonly InstanceSpec[];
  };
  points: Object3DProps<Points>;
  line: Object3DProps<Line>;
  lineSegments: Object3DProps<LineSegments>;
  lineLoop: Object3DProps<LineLoop>;
  /** Mounts an existing object: `<primitive object={mesh} />`. */
  primitive: Omit<Object3DProps<Object3D>, 'args'> & { object: object };

  perspectiveCamera: Object3DProps<PerspectiveCamera> & {
    /** Replace the canvas's default camera with this one. */
    makeDefault?: boolean;
    fov?: number;
    near?: number;
    far?: number;
    zoom?: number;
    target?: Vec3;
    up?: Vec3;
  };
  orthographicCamera: Object3DProps<OrthographicCamera> & {
    makeDefault?: boolean;
    near?: number;
    far?: number;
    zoom?: number;
    target?: Vec3;
    up?: Vec3;
  };

  ambientLight: LightProps<AmbientLight>;
  directionalLight: LightProps<DirectionalLight>;
  pointLight: LightProps<PointLight> & { distance?: number; decay?: number };
  spotLight: LightProps<SpotLight> & {
    distance?: number;
    decay?: number;
    /** Radians. */
    angle?: number;
    penumbra?: number;
    target?: Vec3;
  };

  boxGeometry: GeometryElementProps<BoxGeometry>;
  planeGeometry: GeometryElementProps<PlaneGeometry>;
  sphereGeometry: GeometryElementProps<SphereGeometry>;
  cylinderGeometry: GeometryElementProps<
    CylinderGeometry,
    (number | boolean)[]
  >;
  coneGeometry: GeometryElementProps<ConeGeometry, (number | boolean)[]>;
  torusGeometry: GeometryElementProps<TorusGeometry>;
  bufferGeometry: NodeProps<BufferGeometry> & {
    position?: ArrayLike<number>;
    /** Derived from the triangles when omitted. */
    normal?: ArrayLike<number>;
    uv?: ArrayLike<number>;
    index?: ArrayLike<number>;
  };

  meshBasicMaterial: MaterialElementProps<MeshBasicMaterial>;
  meshLambertMaterial: MaterialElementProps<MeshLambertMaterial> & {
    emissive?: ColorLike;
  };
  meshPhongMaterial: MaterialElementProps<MeshPhongMaterial> & {
    emissive?: ColorLike;
    specular?: ColorLike;
    shininess?: number;
  };
  /** `roughness`/`metalness`, approximated onto Blinn-Phong — identically
   * on both backends. See the docs page for the honest edges. */
  meshStandardMaterial: MaterialElementProps<MeshStandardMaterial> & {
    emissive?: ColorLike;
    roughness?: number;
    metalness?: number;
  };
  pointsMaterial: MaterialElementProps<PointsMaterial> & { size?: number };
  lineBasicMaterial: MaterialElementProps<LineBasicMaterial> & {
    linewidth?: number;
  };
  shaderMaterial: ShaderMaterialProps;
  rawShaderMaterial: ShaderMaterialProps<RawShaderMaterial>;

  /** `<color attach="background" args={['#101418']} />` */
  color: NodeProps<Color> & { args?: [ColorLike] };

  effectComposer: NodeProps<EffectComposer> & { enabled?: boolean };
  shaderPass: PassProps<ShaderPass> & {
    fragmentShader?: string;
    vertexShader?: string;
    uniforms?: Record<string, unknown>;
  };
  bloomPass: PassProps<BloomPass> & {
    threshold?: number;
    strength?: number;
    radius?: number;
  };
  vignettePass: PassProps<VignettePass> & {
    offset?: number;
    darkness?: number;
  };
  fxaaPass: PassProps<FxaaPass>;
}

// Teach the default JSX namespace the names core does not already declare.
// The module-augmentation shape react-x11's docs prescribe for third-party
// elements — `src/flow/index.ts` is the worked example.
declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      primitive: ThreeElements['primitive'];
      perspectiveCamera: ThreeElements['perspectiveCamera'];
      orthographicCamera: ThreeElements['orthographicCamera'];
      coneGeometry: ThreeElements['coneGeometry'];
      meshStandardMaterial: ThreeElements['meshStandardMaterial'];
      color: ThreeElements['color'];
    }
  }
}
