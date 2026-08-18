// The scene renderer: a second react-reconciler instance that turns
// `<mesh>`, `<boxGeometry>` and friends into the mutable objects of
// `objects.ts` — react-three-fiber's architecture, transplanted.
//
// Why a second reconciler rather than registered host elements: everything
// inside core's `<glarea>` is claimed by core's own scene switch, and a
// registered element cannot own a child X window — so the scene vocabulary
// cannot live in the primary tree at all. It also should not: r3f semantics
// (`args`, `attach`, dashed props like `position-x`, refs that hand out
// mutable objects, `extend`) are reconciler behaviours, and owning the
// reconciler is what makes a component written for r3f portable here rather
// than merely similar.
//
// The prop contract, in r3f's terms:
//  - `args` are constructor arguments; changing them rebuilds the shape in
//    place (`setArgs`) rather than swapping the instance, so refs stay valid;
//  - a prop whose current value has `.set()` is set through it — tuples
//    spread into `Vector3`/`Euler`, anything colour-shaped into `Color`, a
//    lone number broadcasts via `setScalar`;
//  - `position-x={2}` and `material-color="red"` walk the dash path;
//  - `onClick` and the pointer handlers are stored for the raycaster;
//  - geometries and materials auto-attach to their parent mesh; an explicit
//    `attach="background"` (etc.) assigns the child into that slot.
import type { ReactNode } from 'react';
import ReactReconciler from 'react-reconciler';
import type { Reconciler } from 'react-reconciler';
import ReactReconcilerConstants from 'react-reconciler/constants.js';

import { Color } from './math.js';
import type { ColorLike } from './math.js';
import {
  AmbientLight,
  DirectionalLight,
  Group,
  InstancedMesh,
  Line,
  LineLoop,
  LineSegments,
  Mesh,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  Points,
  POINTER_PROPS,
  Scene,
  SpotLight,
} from './objects.js';
import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from './geometries.js';
import {
  LineBasicMaterial,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  MeshStandardMaterial,
  PointsMaterial,
  RawShaderMaterial,
  ShaderMaterial,
} from './materials.js';
import {
  BloomPass,
  EffectComposer,
  FxaaPass,
  ShaderPass,
  VignettePass,
} from './passes.js';
import type { ThreeStore } from './store.js';
import {
  warn,
  scheduleMicrotask,
  scheduleTimeout,
  cancelTimeout,
} from './globals.js';

const { ConcurrentRoot, DefaultEventPriority, NoEventPriority } =
  ReactReconcilerConstants;

/** Anything the scene reconciler manages. */
export type Instance = {
  __attach?: string | null;
  __attachedTo?: { owner: Record<string, unknown>; name: string } | null;
  __primitive?: boolean;
  __root?: SceneContainer;
  __hiddenBackup?: boolean;
} & Record<string, unknown>;

/** What the canvas hands the reconciler: the scene, the store, and hooks
 * for the things a commit cannot do itself. */
export interface SceneContainer {
  scene: Scene;
  store: ThreeStore;
  /** any commit landed — the demand-mode surface wants a frame */
  invalidate: () => void;
  /** a geometry or object left the tree — caches and hover state let go */
  onRemoved: (instance: object) => void;
}

// ---------------------------------------------------------------------------
// the element catalogue

type Factory = new (...args: never[]) => object;

const catalogue = new Map<string, Factory>(
  Object.entries({
    group: Group,
    mesh: Mesh,
    instancedMesh: InstancedMesh,
    points: Points,
    line: Line,
    lineSegments: LineSegments,
    lineLoop: LineLoop,
    perspectiveCamera: PerspectiveCamera,
    orthographicCamera: OrthographicCamera,
    ambientLight: AmbientLight,
    directionalLight: DirectionalLight,
    pointLight: PointLight,
    spotLight: SpotLight,
    boxGeometry: BoxGeometry,
    planeGeometry: PlaneGeometry,
    sphereGeometry: SphereGeometry,
    cylinderGeometry: CylinderGeometry,
    coneGeometry: ConeGeometry,
    torusGeometry: TorusGeometry,
    bufferGeometry: BufferGeometry,
    meshBasicMaterial: MeshBasicMaterial,
    meshLambertMaterial: MeshLambertMaterial,
    meshPhongMaterial: MeshPhongMaterial,
    meshStandardMaterial: MeshStandardMaterial,
    pointsMaterial: PointsMaterial,
    lineBasicMaterial: LineBasicMaterial,
    shaderMaterial: ShaderMaterial,
    rawShaderMaterial: RawShaderMaterial,
    effectComposer: EffectComposer,
    bloomPass: BloomPass,
    vignettePass: VignettePass,
    fxaaPass: FxaaPass,
    shaderPass: ShaderPass,
    color: Color,
  } satisfies Record<string, Factory>),
);

/**
 * Teach the scene new elements — r3f's `extend`, verbatim: the key becomes
 * the JSX name with its first letter lowered, and `args` become constructor
 * arguments. `extend({ WavyGrid })` makes `<wavyGrid args={[…]} />` valid.
 */
export function extend(objects: Record<string, Factory>): void {
  for (const [name, factory] of Object.entries(objects)) {
    catalogue.set(name[0].toLowerCase() + name.slice(1), factory);
  }
}

const NO_SHADERS = 'GLSL shaders: the GLX protocol encodes no shader objects';
const NO_FRAMEBUFFERS =
  'post-processing renders the scene to a texture first, and the GLX ' +
  'protocol encodes no framebuffer objects';

/**
 * Scene elements only the direct backend can render, with the reason the
 * indirect one cannot. Both are properties of the transport rather than gaps
 * someone could fill. Creating one on a connection without direct GL throws
 * up front — a blank surface is a much worse way to learn it.
 */
export const DIRECT_ONLY_KINDS: Record<string, string> = {
  shaderMaterial: NO_SHADERS,
  rawShaderMaterial: NO_SHADERS,
  effectComposer: NO_FRAMEBUFFERS,
  shaderPass: NO_FRAMEBUFFERS,
  bloomPass: NO_FRAMEBUFFERS,
  vignettePass: NO_FRAMEBUFFERS,
  fxaaPass: NO_FRAMEBUFFERS,
};

// ---------------------------------------------------------------------------
// applying props

const RESERVED = new Set([
  'children',
  'key',
  'ref',
  'args',
  'attach',
  'object',
  'dispose',
]);

const POINTER_SET = new Set<string>(POINTER_PROPS);

function setHandler(instance: Instance, name: string, value: unknown): void {
  const object = instance as unknown as Object3D;
  let handlers = object.__handlers;
  if (typeof value === 'function') {
    if (!handlers) handlers = object.__handlers = {};
    (handlers as Record<string, unknown>)[name] = value;
  } else if (handlers) {
    delete (handlers as Record<string, unknown>)[name];
  }
  // gaining or losing handlers changes whether the surface selects X
  // pointer events at all
  if (instance.__root) instance.__root.store.eventsDirty = true;
}

interface Settable {
  set: (...values: unknown[]) => unknown;
  setScalar?: (value: number) => unknown;
  isColor?: boolean;
}

const isSettable = (value: unknown): value is Settable =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Settable).set === 'function';

/** One prop onto one target — the value contract described up top. */
function applyProp(instance: Instance, key: string, value: unknown): void {
  let target: Record<string, unknown> = instance;
  let name = key;

  if (key.includes('-')) {
    const path = key.split('-');
    name = path.pop()!;
    for (const part of path) {
      const next = target[part];
      if (next === null || typeof next !== 'object') {
        warn(
          `@react-x11/components: cannot apply "${key}" — "${part}" is not ` +
            'an object on this element.',
        );
        return;
      }
      target = next as Record<string, unknown>;
    }
  }

  // `<bufferGeometry position={…}>` is attribute data, not a transform
  if (
    (target as { isBufferGeometry?: boolean }).isBufferGeometry &&
    (name === 'position' ||
      name === 'normal' ||
      name === 'uv' ||
      name === 'index')
  ) {
    (target as unknown as BufferGeometry).setAttribute(
      name,
      value as ArrayLike<number>,
    );
    return;
  }

  const current = target[name];
  if (isSettable(current)) {
    if (Array.isArray(value)) {
      if (current.isColor) current.set(value);
      else current.set(...(value as unknown[]));
    } else if (
      typeof value === 'number' &&
      current.setScalar &&
      !current.isColor
    ) {
      current.setScalar(value);
    } else {
      current.set(value);
    }
    return;
  }
  target[name] = value;
}

export function applyProps(
  instance: Instance,
  oldProps: Record<string, unknown>,
  newProps: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(newProps)) {
    if (RESERVED.has(key)) continue;
    if (oldProps[key] === value) continue;
    if (POINTER_SET.has(key)) setHandler(instance, key, value);
    else applyProp(instance, key, value);
  }
  // a handler that disappeared has to stop firing
  for (const key of Object.keys(oldProps)) {
    if (key in newProps) continue;
    if (POINTER_SET.has(key)) setHandler(instance, key, undefined);
  }
}

// ---------------------------------------------------------------------------
// attaching

const attachable = (child: Instance): string | null => {
  if (typeof child.__attach === 'string') return child.__attach;
  if ((child as { isGeometry?: boolean }).isGeometry) return 'geometry';
  if ((child as { isMaterial?: boolean }).isMaterial) return 'material';
  if ((child as { isColor?: boolean }).isColor) {
    // a bare <color> with no attach has nowhere to go; background is the
    // only slot the scene offers and the r3f idiom that uses it
    return 'background';
  }
  return null;
};

function attach(parent: Instance, child: Instance): boolean {
  const slot = attachable(child);
  if (!slot) return false;
  let owner: Record<string, unknown> = parent;
  const path = slot.split('-');
  const name = path.pop()!;
  for (const part of path) {
    const next = owner[part];
    if (next === null || typeof next !== 'object') {
      warn(
        `@react-x11/components: attach="${slot}" — "${part}" is not an ` +
          'object on the parent element.',
      );
      return true;
    }
    owner = next as Record<string, unknown>;
  }
  owner[name] = child;
  child.__attachedTo = { owner, name };
  return true;
}

function detach(child: Instance): boolean {
  const at = child.__attachedTo;
  if (!at) return false;
  if (at.owner[at.name] === child) at.owner[at.name] = null;
  child.__attachedTo = null;
  return true;
}

// ---------------------------------------------------------------------------
// the host config

function createInstance(
  type: string,
  props: Record<string, unknown>,
  rootContainer: SceneContainer,
): Instance {
  if (type === 'primitive') {
    const object = props.object;
    if (!object || typeof object !== 'object') {
      throw new Error(
        '@react-x11/components: <primitive> needs an `object` prop holding ' +
          'a scene object (a Mesh, a Group, a geometry…).',
      );
    }
    const instance = object as Instance;
    instance.__primitive = true;
    instance.__root = rootContainer;
    instance.__attach = (props.attach as string) ?? instance.__attach ?? null;
    applyProps(instance, {}, props);
    return instance;
  }

  const state = rootContainer.store.getState();
  if (DIRECT_ONLY_KINDS[type] && !state.supportsShaders) {
    const err = new Error(
      `@react-x11/components: <${type}> needs direct rendering — ` +
        `${DIRECT_ONLY_KINDS[type]} — and this connection does not have ` +
        "it.\n\nPass { glPolicy: 'auto' } to createRoot() to use the GPU " +
        'where it is available, and branch on useThree(s => ' +
        "s.supportsShaders) — or on react-x11's useSupports('shaders') — " +
        'if this scene should degrade rather than fail.',
    );
    (err as { code?: string }).code = 'GL_NO_DIRECT';
    throw err;
  }

  const Factory = catalogue.get(type);
  if (!Factory) {
    throw new Error(
      `@react-x11/components: <${type}> is not a scene element. Inside ` +
        '<Canvas> the vocabulary is the built-in scene elements plus ' +
        'anything registered with extend().',
    );
  }
  const args = Array.isArray(props.args) ? props.args : [];
  const instance = new (Factory as new (...a: unknown[]) => object)(
    ...args,
  ) as Instance;
  instance.__root = rootContainer;
  instance.__attach = (props.attach as string) ?? null;
  applyProps(instance, {}, props);
  return instance;
}

function applyArgs(instance: Instance, args: unknown[]): void {
  if (typeof instance.setArgs === 'function') {
    (instance.setArgs as (a: unknown[]) => void)(args);
    return;
  }
  if ((instance as { isColor?: boolean }).isColor) {
    (instance as unknown as Color).set(args[0] as ColorLike);
    return;
  }
  warn(
    '@react-x11/components: this element cannot change `args` in place; ' +
      'give it a `key` so React remounts it instead.',
  );
}

function addChild(
  parent: Instance,
  child: Instance,
  before: Instance | null,
): void {
  if (attach(parent, child)) {
    child.__root?.invalidate();
    return;
  }
  const parentObject = parent as unknown as Object3D;
  const childObject = child as unknown as Object3D;
  parentObject.add(childObject);
  if (before) {
    // Object3D.add appends; the tree order is the draw and pass order, so a
    // React insertion in the middle moves it where React says
    const children = parentObject.children;
    children.splice(children.indexOf(childObject), 1);
    const at = children.indexOf(before as unknown as Object3D);
    children.splice(at === -1 ? children.length : at, 0, childObject);
  }
  if (child.__root) {
    child.__root.store.eventsDirty = true;
    child.__root.invalidate();
  }
}

function dropChild(parent: Instance, child: Instance): void {
  if (!detach(child)) {
    (parent as unknown as Object3D).remove(child as unknown as Object3D);
  }
  const root = child.__root;
  if (root) {
    root.onRemoved(child);
    root.store.eventsDirty = true;
    root.invalidate();
  }
}

let currentUpdatePriority: number = NoEventPriority;

const HostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsMicrotasks: true,
  // the primary renderer is react-x11's; this one draws inside one element
  isPrimaryRenderer: false,
  warnsIfNotActing: false,

  scheduleTimeout,
  cancelTimeout,
  noTimeout: null,
  scheduleMicrotask,

  getRootHostContext: () => ({}),
  getChildHostContext: (parent: unknown) => parent,
  getPublicInstance: (instance: Instance) => instance,

  prepareForCommit: () => null,
  resetAfterCommit: (container: SceneContainer) => {
    container.invalidate();
  },
  clearContainer: (container: SceneContainer) => {
    container.scene.clear();
  },

  createInstance,

  createTextInstance(): never {
    throw new Error(
      '@react-x11/components: text is not part of a 3D scene — wrap it in ' +
        'a component outside <Canvas>.',
    );
  },

  appendInitialChild: (parent: Instance, child: Instance) =>
    addChild(parent, child, null),
  appendChild: (parent: Instance, child: Instance) =>
    addChild(parent, child, null),
  insertBefore: (parent: Instance, child: Instance, before: Instance) =>
    addChild(parent, child, before),
  removeChild: (parent: Instance, child: Instance) => dropChild(parent, child),

  appendChildToContainer: (container: SceneContainer, child: Instance) =>
    addChild(container.scene as unknown as Instance, child, null),
  insertInContainerBefore: (
    container: SceneContainer,
    child: Instance,
    before: Instance,
  ) => addChild(container.scene as unknown as Instance, child, before),
  removeChildFromContainer: (container: SceneContainer, child: Instance) =>
    dropChild(container.scene as unknown as Instance, child),

  finalizeInitialChildren: () => false,
  commitMount() {},

  commitUpdate(
    instance: Instance,
    type: string,
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
  ) {
    const oldArgs = (oldProps.args as unknown[]) ?? [];
    const newArgs = (newProps.args as unknown[]) ?? [];
    if (
      oldArgs.length !== newArgs.length ||
      newArgs.some((v, i) => v !== oldArgs[i])
    ) {
      applyArgs(instance, newArgs);
    }
    applyProps(instance, oldProps, newProps);
    instance.__root?.invalidate();
  },

  shouldSetTextContent: () => false,
  resetTextContent() {},
  commitTextUpdate() {},

  hideInstance(instance: Instance) {
    const object = instance as unknown as Object3D;
    instance.__hiddenBackup = object.visible;
    object.visible = false;
    instance.__root?.invalidate();
  },
  unhideInstance(instance: Instance) {
    const object = instance as unknown as Object3D;
    object.visible = instance.__hiddenBackup ?? true;
    instance.__root?.invalidate();
  },
  hideTextInstance() {},
  unhideTextInstance() {},

  detachDeletedInstance() {},
  preparePortalMount() {},
  prepareScopeUpdate() {},
  getInstanceFromScope: () => null,
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},

  // Update priority plumbing (React 19 scheduling contract). Kept local:
  // this renderer's updates originate inside the primary renderer's effects
  // and events, so a default priority is always a sound answer.
  setCurrentUpdatePriority(priority: number) {
    currentUpdatePriority = priority;
  },
  getCurrentUpdatePriority: () => currentUpdatePriority,
  resolveUpdatePriority: () =>
    currentUpdatePriority !== NoEventPriority
      ? currentUpdatePriority
      : DefaultEventPriority,
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent() {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  requestPostPaintCallback() {},

  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady: () => null,

  NotPendingTransition: null,
  resetFormInstance() {},
};

// Created on first use rather than at module scope, so importing the barrel
// costs nothing until a <Canvas> actually mounts (AGENTS.md, tree-shaking).
let renderer: Reconciler | null = null;

function getRenderer(): Reconciler {
  if (!renderer) {
    renderer = ReactReconciler(
      HostConfig as unknown as Record<string, unknown>,
    );
  }
  return renderer;
}

export interface SceneRoot {
  /** `onCommitted` fires when this update has landed in the scene graph. */
  render(children: ReactNode, onCommitted?: () => void): void;
  unmount(): void;
}

/** The scene root a `<Canvas>` renders its children into. */
export function createSceneRoot(container: SceneContainer): SceneRoot {
  const reconciler = getRenderer();
  const root = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    'three',
    (error: unknown) =>
      warn(`@react-x11/components: <Canvas> ${String(error)}`),
    (error: unknown) =>
      warn(`@react-x11/components: <Canvas> ${String(error)}`),
    () => {},
    null,
  );
  return {
    render(children: ReactNode, onCommitted?: () => void) {
      reconciler.updateContainer(children, root, null, onCommitted ?? null);
    },
    unmount() {
      reconciler.updateContainer(null, root, null, null);
    },
  };
}
