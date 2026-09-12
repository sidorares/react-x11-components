// Which of `<Map>`'s two renderers draws a map, and bringing the GL one in.
//
// The retained renderer (`./node.ts`) runs everywhere a 2D context does —
// indirect GLX, a remote X server, Xvfb in CI, the headless harness — and
// is visible to window capture. The GL renderer (`./gl/`) needs direct GL,
// and draws every frame from vector data at the display's rate. Neither is
// deprecated in favour of the other: `docs/prd-maps-gl.md`, "One `<Map>`,
// two renderers", has why the retained one stays, and this file is the
// decision between them — pure, so the whole of it is a unit test.
//
// `'auto'` decides in this order:
//
//  1. An explicit `renderer`, or the environment's, over both props and
//     policy — the way `REACT_X11_BACKEND` works for the backend.
//  2. Whether this connection draws through the direct backend at all —
//     `useSupports('shaders')`, which on X11 needs `glPolicy: 'auto'` and a
//     DRI3 or Apple-DRI server, and on the Cocoa backend is always true once
//     its probe has answered.
//  3. At run time, a GL failure moves the map to the retained renderer, with
//     its camera and its handle intact. That one is sticky.
//
// A map that asked for `'gl'` by name never falls back: it gets GL, or it
// gets `onError`.
import type {
  MapRenderer,
  MapRendererReason,
  MapRendererRequest,
} from './types.js';

/** The environment variable that overrides every map's renderer. */
export const RENDERER_ENV = 'REACT_X11_MAP_RENDERER';

/**
 * What a map asks for when it does not say: GL where this connection draws
 * through the direct backend, the retained renderer everywhere else — which
 * is still every indirect GLX connection, every remote X server and every
 * headless test run. `'retained'` until the GL renderer had soaked on both
 * backends (`docs/prd-maps-gl.md`, "The soak").
 */
export const DEFAULT_RENDERER: MapRendererRequest = 'auto';

const REQUESTS: readonly string[] = ['auto', 'gl', 'retained'];

/** Everything the decision reads. */
export interface RendererInput {
  /** The `renderer` prop. */
  requested?: MapRendererRequest;
  /** `REACT_X11_MAP_RENDERER`, as the environment has it — anything but
   *  the three names is ignored. */
  env?: string;
  /** `useSupports('shaders')`: does this connection draw through the
   *  direct backend? */
  shaders: boolean;
  /**
   * Whether the answer to that is still to come. The Cocoa backend settles
   * it on the first ask rather than at connect, so the first render of a map
   * there reads `false` for an answer that is about to be `true`; drawing
   * the retained renderer for those few milliseconds would fetch the view's
   * tiles twice. A map in that state shows its background and waits.
   */
  probing?: boolean;
  /** Whether GL has already failed on this map. */
  failed: boolean;
}

/** The decision: a renderer — or `'pending'` while the connection's answer
 *  is still to come — and why, when it is not what was asked for. */
export interface RendererChoice {
  renderer: MapRenderer | 'pending';
  /** Null when the map got what it asked for. */
  reason: MapRendererReason | null;
  /** What was asked for, the environment's word included. */
  asked: MapRendererRequest;
}

function requestOf(value: string | undefined): MapRendererRequest | null {
  const v = value?.trim().toLowerCase();
  return v && REQUESTS.includes(v) ? (v as MapRendererRequest) : null;
}

/**
 * What a map asks for: the environment's word over the prop's, the prop's
 * over the default — and whether the environment is what changed it.
 */
export function rendererRequest(
  requested: MapRendererRequest | undefined,
  env: string | undefined,
): { asked: MapRendererRequest; forced: boolean } {
  const fromEnv = requestOf(env);
  const own = requested ?? DEFAULT_RENDERER;
  return { asked: fromEnv ?? own, forced: fromEnv !== null && fromEnv !== own };
}

/** Choose a map's renderer. */
export function chooseRenderer(input: RendererInput): RendererChoice {
  const { asked, forced: byEnv } = rendererRequest(input.requested, input.env);
  if (asked === 'retained') {
    return { renderer: 'retained', reason: byEnv ? 'forced' : null, asked };
  }
  if (asked === 'gl') {
    return { renderer: 'gl', reason: byEnv ? 'forced' : null, asked };
  }
  if (input.failed) return { renderer: 'retained', reason: 'gl-failed', asked };
  if (!input.shaders) {
    return input.probing
      ? { renderer: 'pending', reason: null, asked }
      : { renderer: 'retained', reason: 'no-direct-gl', asked };
  }
  return { renderer: 'gl', reason: null, asked };
}

/** The environment's override, read off `globalThis` because `src/` compiles
 *  with `types: []`. */
export function rendererFromEnv(): string | undefined {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  return g.process?.env?.[RENDERER_ENV];
}

// --- the GL renderer, loaded when it is chosen --------------------------------

/**
 * The GL renderer's module, once it has loaded.
 *
 * Reached by dynamic `import()` and never statically: a static import from
 * `<Map>` would put all of `./gl/` — the shaders, the bucket builder, the
 * label atlas — into every bundle that uses a map, which is the tree-shaking
 * promise broken for an application that never draws one through GL.
 * `test/treeshake.test.ts` holds it to that.
 */
export type GlRendererModule = typeof import('./gl/index.js');

let loaded: GlRendererModule | null = null;
let loading: Promise<GlRendererModule> | null = null;

/** The GL renderer, if it has loaded — so a second map mounts it at once. */
export function glRendererModule(): GlRendererModule | null {
  return loaded;
}

/** Load the GL renderer — once per process, however many maps ask. */
export function loadGlRenderer(): Promise<GlRendererModule> {
  loading ??= import('./gl/index.js').then(
    (module) => (loaded = module),
    (error: unknown) => {
      // Asked again next time rather than failing forever on a cached
      // rejection: a load that failed once is most likely to fail again,
      // and the map that asked has already fallen back or reported it.
      loading = null;
      throw error;
    },
  );
  return loading;
}
