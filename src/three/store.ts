// The per-canvas state react-three-fiber components read: `useThree` for the
// camera, the sizes and `invalidate`; `useFrame` for the frame clock.
//
// A deliberately small store in zustand's shape — `getState`, `setState`,
// `subscribe`, and a hook that selects — because that is the API surface
// r3f components are written against, and matching it is this module's whole
// job. The store lives outside React (mutated from the surface's frame
// callback), and the hook reads it through `useSyncExternalStore`, so a
// component that selects `size` re-renders on resize and nothing else does.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

import type { Camera, Scene } from './objects.js';

export interface ThreeSize {
  width: number;
  height: number;
}

/**
 * The world-space rectangle the camera sees at its target's distance —
 * r3f's `viewport`, which components use to size meshes against the window.
 */
export interface ThreeViewport {
  width: number;
  height: number;
  aspect: number;
  distance: number;
  /** pixels per world unit */
  factor: number;
}

export interface ThreeClock {
  /** Seconds since the surface's first frame. */
  elapsedTime: number;
  /** Seconds since the previous frame, clamped as core's clock clamps. */
  delta: number;
}

/** What `useFrame` callbacks and `useThree` selectors see. */
export interface RootState {
  /** The GL context — camelCase ES 2 on `'direct'`, PascalCase OpenGL 1.x
   * on `'indirect'`. Null until the surface's context exists. */
  gl: unknown;
  backend: 'direct' | 'indirect' | null;
  scene: Scene;
  camera: Camera;
  size: ThreeSize;
  viewport: ThreeViewport;
  clock: ThreeClock;
  /** Whether `<shaderMaterial>`/`<effectComposer>` can exist here. */
  supportsShaders: boolean;
  frameloop: 'always' | 'demand' | 'never';
  /** Ask for one more frame — the demand-mode animation valve. */
  invalidate: () => void;
  get: () => RootState;
  set: (partial: Partial<RootState>) => void;
}

export type FrameCallback = (state: RootState, delta: number) => void;

interface FrameSubscriber {
  callback: FrameCallback;
  priority: number;
}

export interface ThreeStore {
  getState: () => RootState;
  setState: (partial: Partial<RootState>) => void;
  subscribe: (listener: () => void) => () => void;
  /** @internal ordered `useFrame` subscribers */
  frames: FrameSubscriber[];
  /** @internal subscribe a frame callback; returns unsubscribe */
  addFrame: (callback: FrameCallback, priority: number) => () => void;
  /** @internal run the subscribers, in priority order */
  runFrames: (state: RootState, delta: number) => boolean;
  /** @internal the scene gained/lost pointer handlers since last checked */
  eventsDirty: boolean;
}

export function createThreeStore(
  initial: Omit<RootState, 'get' | 'set'>,
): ThreeStore {
  const listeners = new Set<() => void>();
  let state: RootState;

  const setState = (partial: Partial<RootState>) => {
    // a new object per write, so useSyncExternalStore sees the change; the
    // scene and camera stay identity-stable across writes
    state = { ...state, ...partial };
    for (const listener of [...listeners]) listener();
  };
  state = {
    ...initial,
    get: () => state,
    set: setState,
  };

  const store: ThreeStore = {
    getState: () => state,
    setState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    frames: [],
    addFrame(callback, priority) {
      const entry: FrameSubscriber = { callback, priority };
      store.frames.push(entry);
      store.frames.sort((a, b) => a.priority - b.priority);
      // subscribing makes the surface animate; the canvas watches this count
      setState({});
      return () => {
        const index = store.frames.indexOf(entry);
        if (index !== -1) store.frames.splice(index, 1);
        setState({});
      };
    },
    runFrames(frameState, delta) {
      if (store.frames.length === 0) return false;
      for (const { callback } of [...store.frames]) {
        callback(frameState, delta);
      }
      return true;
    },
    eventsDirty: true,
  };
  return store;
}

export function computeViewport(
  camera: Camera,
  size: ThreeSize,
): ThreeViewport {
  const aspect = size.width / Math.max(1, size.height);
  const distance = camera.position.distanceTo(camera.target);
  let height: number;
  if ((camera as { isOrthographicCamera?: boolean }).isOrthographicCamera) {
    height = 2 / camera.zoom;
  } else {
    const fov =
      (((camera as { fov?: number }).fov ?? 50) / camera.zoom) *
      (Math.PI / 180);
    height = 2 * Math.tan(fov / 2) * distance;
  }
  const width = height * aspect;
  return {
    width,
    height,
    aspect,
    distance,
    factor: size.width / Math.max(1e-6, width),
  };
}

export const ThreeContext = createContext<ThreeStore | null>(null);

function useStore(hook: string): ThreeStore {
  const store = useContext(ThreeContext);
  if (!store) {
    throw new Error(
      `@react-x11/components: ${hook}() must be called from a component ` +
        'inside <Canvas> — its state belongs to one surface.',
    );
  }
  return store;
}

/**
 * The canvas state, r3f-shaped: `useThree()` for all of it, or
 * `useThree((s) => s.camera)` to re-render only when the selection changes.
 */
export function useThree(): RootState;
export function useThree<T>(selector: (state: RootState) => T): T;
export function useThree<T>(selector?: (state: RootState) => T): T | RootState {
  const store = useStore('useThree');
  return useSyncExternalStore(store.subscribe, () =>
    selector ? selector(store.getState()) : store.getState(),
  );
}

/**
 * Run `callback(state, delta)` on every frame of the enclosing `<Canvas>`.
 *
 * This *is* r3f's escape from re-rendering: mutate what the ref holds —
 * `ref.current.rotation.y += delta` — and the next frame draws it, with
 * React uninvolved. Subscribing makes the surface animate (a demand-driven
 * surface would otherwise tick once and stop); unmount and it goes quiet.
 * `priority` orders callbacks, lowest first, as in r3f.
 */
export function useFrame(callback: FrameCallback, priority = 0): void {
  const store = useStore('useFrame');
  // stored in a ref, so the subscription is stable while the callback still
  // sees current props — no memoizing needed to avoid resubscribing
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(
    () =>
      store.addFrame((state, delta) => latest.current(state, delta), priority),
    [store, priority],
  );
}
