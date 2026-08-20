// `@react-x11/components/three` — a react-three-fiber-shaped scene graph
// over react-x11's `<glarea>`, drawn through whichever GL backend the
// connection has: indirect GLX (fixed-function, reaches any server that
// allows it) or ntk's direct backend (GL ES 2 on the GPU, shaders and
// post-processing). `glPolicy: 'auto'` at createRoot() picks the best one
// available; the same scene JSX renders on both.
//
// Re-exports only — no side effects (AGENTS.md, tree-shaking). The one
// stateful thing here, the scene reconciler, is created on first mount.
export { Canvas } from './canvas.js';
export type { CanvasProps } from './canvas.js';

export { useFrame, useThree } from './store.js';
export type {
  FrameCallback,
  RootState,
  ThreeClock,
  ThreeSize,
  ThreeStore,
  ThreeViewport,
} from './store.js';

export { extend, DIRECT_ONLY_KINDS } from './reconciler.js';

export { Color, Euler, Vector3 } from './math.js';
export type { Mat4, Vec3Tuple } from './math.js';

export {
  AmbientLight,
  Camera,
  DirectionalLight,
  Group,
  InstancedMesh,
  Light,
  Line,
  LineLoop,
  LineSegments,
  Mesh,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  Points,
  Scene,
  SpotLight,
} from './objects.js';
export type { InstanceSpec, PointerHandlers, Primitive } from './objects.js';

export {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from './geometries.js';
export type { BufferGeometryAttributes, GeometryData } from './geometries.js';

export {
  LineBasicMaterial,
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  MeshStandardMaterial,
  PointsMaterial,
  RawShaderMaterial,
  ShaderMaterial,
  standardToPhong,
} from './materials.js';
export type {
  MaterialSide,
  TextureImage,
  UniformEntry,
  Uniforms,
} from './materials.js';

export {
  BloomPass,
  EffectComposer,
  FxaaPass,
  Pass,
  ShaderPass,
  VignettePass,
} from './passes.js';

export { raycast, rayThrough } from './raycast.js';
export type { RayHit } from './raycast.js';
export type { ThreeEvent } from './events.js';

export type { ThreeElements } from './jsx.js';

// The renderers, exported for tests and for anyone driving a `<glarea>` by
// hand; a `<Canvas>` constructs the right one from `gl.backend` itself.
export { IndirectRenderer } from './renderer-indirect.js';
export { DirectRenderer } from './renderer-direct.js';
export { PostProcessor } from './postprocess.js';
