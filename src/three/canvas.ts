// `<Canvas>` — the react-three-fiber-shaped entry point, standing on core's
// public `<glarea>` element.
//
// The division of labour: `<glarea>` owns everything that is renderer
// internals — the child X window on a GL visual, the context, the frame
// clock, the swap — and exposes it as `onCreated`/`onDraw`/`frameLoop`. On
// a core with react-x11#545 the pointer over the surface is the tree's too,
// dispatched at the `<glarea>` like the pointer over any node.
// This component owns everything that is scene: the second reconciler
// rendering `children` into the object graph, the store `useThree`/`useFrame`
// read, the backend-appropriate renderer, picking, and post-processing.
//
// Which backend draws is not chosen here: ntk's `glPolicy` decided it when
// the connection was made, and the context that arrives says which one it
// is. `glPolicy: 'auto'` at createRoot() is what "pick the best available"
// spells — the same scene JSX renders either way, which is the point of the
// shared subset.
import {
  createElement as h,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode, Ref } from 'react';
import { useSupports } from 'react-x11';
import type { ReactX11Elements, SyntheticEvent } from 'react-x11';
// Loads the module the JSX augmentation in jsx.ts targets (see flow/index.ts
// for the same pattern). Type-only, so it is erased.
import type {} from 'react-x11/jsx-runtime';

import type { Color } from './math.js';
import { hx } from './hx.js';
import { OrthographicCamera, PerspectiveCamera, Scene } from './objects.js';
import type { Camera } from './objects.js';
import type { BufferGeometry } from './geometries.js';
import { applyProps, createSceneRoot } from './reconciler.js';
import type { Instance, SceneContainer, SceneRoot } from './reconciler.js';
import { ThreeContext, computeViewport, createThreeStore } from './store.js';
import type { RootState, ThreeStore } from './store.js';
import { IndirectRenderer } from './renderer-indirect.js';
import { DirectRenderer } from './renderer-direct.js';
import { PostProcessor } from './postprocess.js';
import type { EffectComposer } from './passes.js';
import { ForwardedPointer, ScenePointer, type ThreeEvent } from './events.js';
import { sceneWantsPointer } from './raycast.js';
import { now, warn } from './globals.js';
import { scaleOf } from '../internal/units.js';

/**
 * Failures that mean "one thing in this scene is broken", not "this machine
 * has no 3D". The fallback is for the second: replacing a whole scene with
 * "no 3D here" because a pass shader has a typo would send the reader off
 * to check their drivers.
 */
const SCENE_LEVEL = new Set([
  'GL_SHADER_FAILED',
  'GL_CONTEXT_INCOMPLETE',
  'GL_POST_UNAVAILABLE',
  'GL_POST_TARGET_FAILED',
]);

type GlAreaProps = ReactX11Elements['glarea'];

/** The glarea node surface this component reaches through its ref. */
interface SurfaceNode {
  requestFrame?: () => void;
  /** `true` where core dispatches the pointer over the surface at this node,
   *  through the tree (react-x11#545); absent on a core that does not. */
  forwardsPointer?: boolean;
  /** The node's box, which is the surface's: device pixels, in the owning
   *  window's space. */
  abs?: { x: number; y: number };
  window?: {
    /** The X window's id — the Cocoa backend's surface is a layer, and has
     *  none. */
    id?: unknown;
    on(name: string, handler: (event: { x: number; y: number }) => void): void;
    setCursor?(cursor: string | null): void;
  } | null;
}

/**
 * A pointer event where the scene measures it: device pixels from the
 * surface's corner, as the surface's own X window reports them. Core hands a
 * handler the point in the window's logical pixels — divided by the node's
 * scale — while the surface covers the node's box, `abs`, in device pixels:
 * so the point goes back to device pixels and the box's corner comes off.
 * (The content box's corner would be out by any padding or border, which the
 * surface covers too.)
 */
function surfacePoint(
  node: SurfaceNode | null,
  ev: { x: number; y: number },
): { x: number; y: number } {
  const scale = scaleOf(node);
  return {
    x: ev.x * scale - (node?.abs?.x ?? 0),
    y: ev.y * scale - (node?.abs?.y ?? 0),
  };
}

interface DrawInfo {
  width: number;
  height: number;
}

export interface CanvasProps {
  children?: ReactNode;
  /** Layout, as any drawn element takes it. */
  style?: GlAreaProps['style'];
  /**
   * Partial settings for the default camera, r3f-shaped:
   * `{ position: [3, 3, 6], fov: 50, near, far, zoom, up, target }`.
   * A `<perspectiveCamera makeDefault>` in the scene replaces it wholesale.
   */
  camera?: Record<string, unknown>;
  /** An orthographic default camera instead of the perspective one. */
  orthographic?: boolean;
  /**
   * `'demand'` (the default): render when something changed — a commit, a
   * resize, an expose, or `invalidate()`. Subscribing to `useFrame` makes
   * the surface animate, so ported r3f components move without asking.
   * `'always'` runs the clock continuously; `'never'` renders only on
   * `invalidate()`. (r3f defaults to `'always'`; a desktop toolkit is the
   * one place that default wastes a battery, so it is opt-in here.)
   */
  frameloop?: 'always' | 'demand' | 'never';
  /** CSS colour or `[r, g, b, a]` floats (default black). A
   * `<color attach="background" />` in the scene wins over this. */
  clearColor?: GlAreaProps['clearColor'];
  /** Visual spec for the GL window, e.g. `{ DEPTH_SIZE: 24 }`. */
  glx?: GlAreaProps['glx'];
  /** Shown in place of the surface when this connection has no GL at all —
   * an element, or a function of the error (whose `code` says why). */
  fallback?: ReactNode | ((error: Error) => ReactNode);
  /** Runs once the context exists, with the full root state. */
  onCreated?: (state: RootState) => void;
  /** A press that hit no object. */
  onPointerMissed?: (event: ThreeEvent) => void;
  onError?: (error: Error) => void;
  /** Raw GL after the scene draws — the escape hatch `<glarea onDraw>` is.
   * Branch on `gl.backend`: camelCase ES 2 against PascalCase GL 1.x. */
  onDraw?: GlAreaProps['onDraw'];
}

interface CanvasKit {
  scene: Scene;
  store: ThreeStore;
  container: SceneContainer;
  pointer: ScenePointer;
  /** The pointer as core forwards it, which the surface's handlers feed. */
  forwarded: ForwardedPointer;
  renderer: IndirectRenderer | DirectRenderer | null;
  post: PostProcessor | null;
  gl: unknown;
  disposals: BufferGeometry[];
  root: SceneRoot | null;
  lastFrameAt: number | null;
  firstFrameAt: number | null;
}

const isGeometry = (value: object): value is BufferGeometry =>
  (value as { isBufferGeometry?: boolean }).isBufferGeometry === true;

export function Canvas({
  children,
  style,
  camera,
  orthographic = false,
  frameloop = 'demand',
  clearColor,
  glx,
  fallback,
  onCreated,
  onPointerMissed,
  onError,
  onDraw,
}: CanvasProps) {
  const supportsShaders = useSupports('shaders');
  const [error, setError] = useState<Error | null>(null);
  const areaRef = useRef<unknown>(null);

  // Everything with the canvas's lifetime, made once. The camera the scene
  // starts with is the default one; `<perspectiveCamera makeDefault>`
  // replaces it through the store.
  const kit = useMemo<CanvasKit>(() => {
    const scene = new Scene();
    const defaultCamera: Camera = orthographic
      ? new OrthographicCamera()
      : new PerspectiveCamera();
    const size = { width: 1, height: 1 };
    const store = createThreeStore({
      gl: null,
      backend: null,
      scene,
      camera: defaultCamera,
      size,
      viewport: computeViewport(defaultCamera, size),
      clock: { elapsedTime: 0, delta: 0 },
      supportsShaders,
      frameloop,
      invalidate: () => {
        const node = areaRef.current as SurfaceNode | null;
        node?.requestFrame?.();
      },
    });
    const state: CanvasKit = {
      scene,
      store,
      container: {
        scene,
        store,
        invalidate: () => store.getState().invalidate(),
        onRemoved: (instance) => {
          state.pointer.forget(instance);
          if (isGeometry(instance)) state.disposals.push(instance);
        },
      },
      pointer: new ScenePointer({
        scene,
        cameraOf: () => state.renderer?.camera ?? null,
        onPointerMissed: (event) => {
          // read through a ref so the prop can change without remaking the kit
          missedRef.current?.(event);
        },
      }),
      forwarded: new ForwardedPointer(
        () => (areaRef.current as SurfaceNode | null)?.window,
      ),
      renderer: null,
      post: null,
      gl: null,
      disposals: [],
      root: null,
      lastFrameAt: null,
      firstFrameAt: null,
    };
    // mutations arriving outside React — `ref.current.position.x = 2` in an
    // event handler — redraw a demand-mode surface without an invalidate()
    scene.propagateDirty(() => store.getState().invalidate());
    return state;
    // the kit is per-mount; remaking it on prop changes would drop the scene
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const missedRef = useRef(onPointerMissed);
  missedRef.current = onPointerMissed;

  // r3f's camera prop contract: partial settings applied onto the default
  // camera, diffed so an unchanged inline object costs nothing new.
  const prevCameraProps = useRef<Record<string, unknown>>({});
  useEffect(() => {
    if (!camera) return;
    applyProps(
      kit.store.getState().camera as unknown as Instance,
      prevCameraProps.current,
      camera,
    );
    prevCameraProps.current = camera;
    kit.store.getState().invalidate();
  }, [camera, kit]);

  useEffect(() => {
    if (kit.store.getState().frameloop !== frameloop) {
      kit.store.setState({ frameloop });
    }
  }, [frameloop, kit]);

  // Until a context exists the hook is the best prediction there is, and
  // it can settle false→true after the kit captured it (caps resolve on
  // their own clock). Keep the store following the hook so a direct-only
  // element mounting on that flip is judged by the fresh value — declared
  // before the scene-root effects so it lands first. The created context
  // overwrites this with the backend that actually arrived.
  useLayoutEffect(() => {
    const state = kit.store.getState();
    if (!state.backend && state.supportsShaders !== supportsShaders) {
      kit.store.setState({ supportsShaders });
    }
  }, [kit, supportsShaders]);

  // The scene root: created once, fed the children every render, torn down
  // with the canvas. `useLayoutEffect` so the scene exists before the
  // surface's first frame asks it to draw.
  useLayoutEffect(() => {
    kit.root = createSceneRoot(kit.container);
    return () => {
      kit.root?.unmount();
      kit.root = null;
      if (kit.renderer && kit.gl) {
        kit.renderer.dispose(kit.gl);
        kit.post?.dispose(kit.gl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kit]);
  useLayoutEffect(() => {
    kit.root?.render(h(ThreeContext.Provider, { value: kit.store }, children));
  });

  // The surface animates while anything subscribes to useFrame — that is
  // what makes a ported r3f component move — or while frameloop asks for it.
  const [animating, setAnimating] = useState(false);
  useEffect(
    () =>
      kit.store.subscribe(() => {
        setAnimating(kit.store.frames.length > 0);
      }),
    [kit],
  );

  const handleError = useCallback(
    (err: Error & { code?: string }) => {
      // The fallback means "this surface has no GL", so only a failure to
      // get a context switches to it.
      if (!SCENE_LEVEL.has(err?.code ?? '')) setError(err);
      if (onError) return onError(err);
      if (fallback === undefined) {
        warn(`@react-x11/components: <Canvas>: ${err?.message ?? err}`);
      }
    },
    [onError, fallback],
  );

  const handleCreated = useCallback(
    (gl: { backend?: string }) => {
      kit.gl = gl;
      const backend = gl?.backend === 'direct' ? 'direct' : 'indirect';
      if (backend === 'direct') {
        const renderer = new DirectRenderer();
        renderer.onError = handleError;
        kit.renderer = renderer;
      } else {
        kit.renderer = new IndirectRenderer();
      }
      // The context in hand outranks any prediction: once a backend has
      // actually arrived, `useThree((s) => s.supportsShaders)` and the
      // direct-only mount guard follow it. (Since react-x11#358 the
      // useSupports('shaders') hook is policy-aware and agrees with this;
      // writing it here keeps the store truthful on any core version.)
      kit.store.setState({
        gl,
        backend,
        supportsShaders: backend === 'direct',
      });
      onCreated?.(kit.store.getState());
    },
    // handleError is stable enough (fallback/onError changes reroute later
    // reports through the current closure on the next created surface)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kit],
  );

  const onDrawRef = useRef(onDraw);
  onDrawRef.current = onDraw;

  const handleDraw = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gl: any, info: DrawInfo) => {
      const renderer = kit.renderer;
      if (!renderer) return;
      const store = kit.store;
      const state = store.getState();

      if (
        state.size.width !== info.width ||
        state.size.height !== info.height
      ) {
        const size = { width: info.width, height: info.height };
        store.setState({
          size,
          viewport: computeViewport(state.camera, size),
        });
      }

      // geometry that left the tree: its server/GPU resources go with it
      if (kit.disposals.length) {
        for (const geometry of kit.disposals) renderer.forget(gl, geometry);
        kit.disposals.length = 0;
      }

      // the frame clock, before anything draws: a callback that mutates the
      // scene is drawing this frame, and one that sets React state lands on
      // the next — both the r3f contract
      const time = now();
      if (kit.firstFrameAt === null) kit.firstFrameAt = time;
      // clamped: a surface that was occluded for a second must not teleport
      // everything that integrates against delta
      const delta = Math.min((time - (kit.lastFrameAt ?? time)) / 1000, 0.1);
      kit.lastFrameAt = time;
      const clock = store.getState().clock;
      clock.elapsedTime = (time - kit.firstFrameAt) / 1000;
      clock.delta = delta;
      store.runFrames(store.getState(), delta);

      // The pointer is only worth taking when something in the scene
      // listens — checked when the tree said it changed, attached the first
      // time it is true. Where core forwards it (react-x11#545) it comes from
      // the surface's own handlers and nowhere else: a listener on the
      // surface's X window would select the events there, and X would
      // deliver every press, and the wheel, to that window rather than to
      // the tree. An older core delivers nothing over the surface, so there
      // it is the X window's own events — X11 only, since the Cocoa surface
      // is a layer, with no X window id and no pointer events of its own.
      if (store.eventsDirty) {
        store.eventsDirty = false;
        if (!kit.pointer.attached && sceneWantsPointer(kit.scene.children)) {
          const node = areaRef.current as SurfaceNode | null;
          if (node?.forwardsPointer === true) {
            kit.pointer.attach(kit.forwarded);
          } else if (node?.window && typeof node.window.id === 'number') {
            kit.pointer.attach(node.window);
          }
        }
      }

      const current = store.getState();
      const scene = kit.scene;

      // `<color attach="background" />` wins over the clearColor prop. The
      // surface already cleared to the prop before this ran, so only an
      // explicit background costs a second clear.
      const background = scene.background;
      const composer =
        renderer.backend === 'direct'
          ? (scene.children.find(
              (child) => (child as unknown as EffectComposer).isComposer,
            ) as EffectComposer | undefined)
          : undefined;

      const anyGl = gl as {
        clearColor?: (r: number, g: number, b: number, a: number) => void;
        clear?: (bits: number) => void;
        ClearColor?: (r: number, g: number, b: number, a: number) => void;
        Clear?: (bits: number) => void;
        COLOR_BUFFER_BIT?: number;
        DEPTH_BUFFER_BIT?: number;
      };
      const clearTo = (color: Color | null) => {
        const [r, g, b] = color ? color.toArray() : [0, 0, 0];
        const a = color ? color._alpha : 1;
        if (renderer.backend === 'direct') {
          anyGl.clearColor?.(r, g, b, a);
          anyGl.clear?.(anyGl.COLOR_BUFFER_BIT! | anyGl.DEPTH_BUFFER_BIT!);
        } else {
          anyGl.ClearColor?.(r, g, b, a);
          anyGl.Clear?.(anyGl.COLOR_BUFFER_BIT! | anyGl.DEPTH_BUFFER_BIT!);
        }
      };

      // An <effectComposer> redirects the frame into a texture, and the
      // redirect has to happen before the clear: the clear colour is the
      // composed image's background, and `onDraw` output is part of what
      // gets composed.
      let composed = false;
      if (composer && renderer.backend === 'direct') {
        kit.post ??= new PostProcessor(renderer as DirectRenderer);
        composed = kit.post.begin(gl, info, composer);
        if (composed) clearTo(background);
      } else if (background) {
        clearTo(background);
      }

      renderer.render(gl, scene, current.camera, info);
      onDrawRef.current?.(gl, info as never);
      if (composed) kit.post!.end(gl, info);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kit],
  );

  // The pointer core dispatches at the surface, into the scene — through
  // `kit.forwarded`, which passes it on only once the frame loop attached
  // the scene to it. Where the pointer comes from the surface's X window
  // instead, these hear nothing of it and pass nothing on.
  const pointerHandlers = useMemo(() => {
    const at = (ev: SyntheticEvent) =>
      surfacePoint(areaRef.current as SurfaceNode | null, ev);
    return {
      onMouseDown: (ev: SyntheticEvent) => {
        // Held until the release, as X's grab held it for the surface's
        // window: a drag that leaves the canvas still reaches the scene.
        if (kit.forwarded.emit('mousedown', at(ev))) ev.capturePointer();
      },
      onMouseMove: (ev: SyntheticEvent) => {
        kit.forwarded.emit('mousemove', at(ev));
      },
      onMouseUp: (ev: SyntheticEvent) => {
        kit.forwarded.emit('mouseup', at(ev));
      },
      onMouseLeave: (ev: SyntheticEvent) => {
        kit.forwarded.emit('mouseout', at(ev));
      },
    };
  }, [kit]);

  if (error && fallback !== undefined) {
    return hx(
      'box',
      { style },
      typeof fallback === 'function' ? fallback(error) : fallback,
    );
  }

  const loop =
    frameloop === 'always' || (frameloop === 'demand' && animating)
      ? 'always'
      : 'demand';

  return hx('glarea', {
    ref: areaRef as Ref<never>,
    style,
    clearColor,
    glx,
    frameLoop: loop,
    onCreated: handleCreated as GlAreaProps['onCreated'],
    onDraw: handleDraw as GlAreaProps['onDraw'],
    onError: handleError,
    ...pointerHandlers,
  });
}
