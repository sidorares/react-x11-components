// The public vocabulary: what `<Map>` takes, what it hands back, and what
// its events carry.
//
// Separate from `index.ts` for the reason `src/flow/types.ts` is: the
// element, the component and the tests all name these, and a types module
// with no runtime in it can be imported by any of them without dragging the
// others in.
import type { Style } from 'react-x11/style';
import type { ReactNode, Ref } from 'react';

import type { LngLat, LngLatBounds, MapCamera, TileId } from './proj.js';
import type { MapSource } from './sources.js';
import type { MapStyle } from './style.js';
import type { MapMarker, MapOverlay } from './overlay.js';

export type { LngLat, LngLatBounds, MapCamera };
export type { MapSource, TileData, TileRequest } from './sources.js';
export type { MapMarker, MapOverlay, OverlayPalette } from './overlay.js';
export type {
  MapStyle,
  MapStyleLayer,
  MapFilter,
  FillLayer,
  LineLayer,
  CircleLayer,
  SymbolLayer,
  Zoomed,
} from './style.js';

/** Which renderer draws a map — see `<Map renderer>`. */
export type MapRenderer = 'gl' | 'retained';

/**
 * What `<Map renderer>` asks for: one of the two renderers, or `'auto'` —
 * GL wherever this connection has direct GL and nothing the map uses is
 * missing from it, and the retained renderer everywhere else.
 */
export type MapRendererRequest = 'auto' | MapRenderer;

/** Why a map is drawn with the renderer it is, when that is not what it
 *  asked for. */
export type MapRendererReason =
  /** The connection has no direct GL — indirect GLX, or none at all —
   *  so `useSupports('shaders')` is false. */
  | 'no-direct-gl'
  /** The map uses something the GL renderer does not do yet. A one-time
   *  development warning names the prop. */
  | 'capability'
  /** GL failed at run time: no surface, a context that would not create, a
   *  shader that would not compile, a throw from a frame. */
  | 'gl-failed'
  /** `REACT_X11_MAP_RENDERER` chose it. */
  | 'forced';

/** Where a pointer event happened, in every space that could be wanted. */
export interface MapPointerEvent {
  /** Geographic. */
  lngLat: LngLat;
  /** Pane-local logical pixels. */
  x: number;
  y: number;
  /** The marker under the pointer, when there was one. */
  marker: MapMarker | null;
  /** Modifier state, as the synthetic event reported it. */
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** `1` left, `2` middle, `3` right. */
  button: number;
}

/**
 * What one frame cost — for a performance HUD, and what the benches read.
 *
 * The fields both renderers have are named the same; the ones only one of
 * them has are optional, and present on that renderer's frames.
 */
export interface MapFrameStats {
  /** Which renderer drew the frame. */
  renderer: MapRenderer;
  /** Milliseconds spent rasterizing tiles into their surfaces this frame.
   *  Bounded by `rasterBudgetMs` except for the one run that crossed it.
   *  Always `0` on the GL renderer, which rasterizes nothing. */
  rasterMs: number;
  /** The rest of the frame on this thread: compositing tiles and drawing
   *  the labels, overlays and markers (retained), or issuing the frame's GL
   *  calls and placing its labels (GL — the GPU's own time is not in it). */
  drawMs: number;
  /** Tiles the cover asked for. */
  tiles: number;
  /** …of which were drawn from their own data: a finished surface
   *  (retained; under `progressive` the half-drawn ones too) or their own
   *  geometry (GL). */
  ready: number;
  /** …and how many were drawn from a coarser ancestor instead, scaled up.
   *  What covers a hole while zooming *in*. */
  fromAncestor: number;
  /** …and how many from their finer descendants, scaled down. What covers
   *  a hole while zooming *out*, where there is no ancestor to borrow. */
  fromDescendant: number;
  /** Tiles still to rasterize (retained) or to build (GL) — non-zero means
   *  the map is still sharpening and another frame is already scheduled. */
  pending: number;
  /**
   * Whether what is on screen is the previous style.
   *
   * True from a `mapStyle` change or `refresh()` until the swap: the new
   * style is drawn behind the old picture — tiles, background and labels —
   * and replaces all of it in one frame, so the map never shows the two at
   * once. The first frame it is false again is the one that swapped. Never
   * true under `progressive`, which shows the repaint as it happens.
   */
  restyling: boolean;
  /** Labels placed, and labels drawn. */
  labels: number;
  /**
   * Tiles in the cover whose load failed and are waiting on a retry.
   *
   * Here because a map whose tiles all fail looks exactly like a map that
   * is still loading — an empty background and nothing else — and the
   * difference is not something a user can see.
   */
  errors: number;
  /** Bytes of rendered surfaces the cache is holding. `0` on the GL
   *  renderer, whose tiles are geometry — its bytes are `gl.gpuBytes`. */
  surfaceBytes: number;
  /**
   * What this pass repainted, in device pixels, or `null` for a full one —
   * which every GL frame is.
   *
   * The number to watch when a map looks busy: a frame that is only
   * continuing a rasterization should claim almost nothing, because the
   * tile being drawn is a second surface nobody is looking at. A run of
   * full-pane damage while tiles are still landing means something is
   * asking for repaints it does not need — which on a backend that paints
   * many frames a second reads as flashing.
   */
  damage: { x: number; y: number; width: number; height: number } | null;
  /** What the rasterizer did, summed over the tiles drawn this frame. All
   *  zeros on the GL renderer. */
  draw: {
    features: number;
    vertices: number;
    decimated: number;
    culled: number;
    batches: number;
  };
  /** GL only: what the frame cost on the GPU's side of the thread. */
  gl?: MapGlFrameStats;
}

/** What a GL frame cost, beyond what both renderers report. */
export interface MapGlFrameStats {
  /** Milliseconds since the frame before — what a frame rate is made of. */
  interval: number;
  /** Milliseconds this thread spent issuing the frame's GL calls. */
  cpuMs: number;
  /** …building tiles' geometry, when the builds are on this thread. */
  buildMs: number;
  /** Tiles loaded and waiting for a build, and tiles still loading. */
  building: number;
  loading: number;
  /** Bytes of tile geometry on the GPU. */
  gpuBytes: number;
  /** Segment instances drawn, every pass counted — the frame's work. */
  instances: number;
  drawCalls: number;
  /** Tiles uploaded to the GPU this frame, and their bytes. */
  uploads: number;
  uploadBytes: number;
  /** Whether the frame was drawn through an offscreen framebuffer — which
   *  a surface with no stencil buffer of its own needs. */
  offscreen: boolean;
  /** The pyramid level the view is drawn from, and the one fully shown:
   *  they differ while a level fades in (`levelFade`). */
  level: number;
  shownLevel: number;
  /** How much of the arriving level was faded in; `0` with no fade. */
  fade: number;
  /** The adaptive-quality rung the frame was drawn at: `0` is everything,
   *  higher leaves more out (`adaptive`). */
  quality: number;
  /** What adaptive quality predicted a moving frame would cost, in ms, or
   *  `0` for a frame it did not price. */
  predictedMs: number;
  /** A settled frame's own time, drained and finished — what the cost
   *  model learns from — or `0`. Moving frames are never timed. */
  measuredMs: number;
  /** Whether the camera moved within the settle window. */
  moving: boolean;
  /** Label anchors considered, and labels placed, this frame. */
  labelCandidates: number;
  labelsPlaced: number;
  /** Milliseconds this thread spent on labels: placing them, and measuring
   *  strings it had not measured before. */
  labelMs: number;
  /** Label text still waiting to be rasterized. */
  textPending: boolean;
}

/** Options for framing a box. */
export interface FitBoundsOptions {
  /** Logical pixels kept clear on every side. 24 by default. */
  padding?: number;
  maxZoom?: number;
}

/** The imperative surface, through `ref`. */
export interface MapHandle {
  getCamera(): MapCamera;
  setCamera(camera: Partial<MapCamera>): void;
  panBy(dx: number, dy: number): void;
  zoomIn(step?: number): void;
  zoomOut(step?: number): void;
  zoomTo(zoom: number): void;
  /** Frame a box. */
  fitBounds(bounds: LngLatBounds, options?: FitBoundsOptions): void;
  /** Frame every marker, or the ones named. */
  fitMarkers(ids?: readonly string[], options?: FitBoundsOptions): void;
  /** What the pane can see. `west > east` across the antimeridian. */
  getBounds(): LngLatBounds;
  /** Geography to pane-local logical pixels, and back. */
  project(position: LngLat): { x: number; y: number };
  unproject(x: number, y: number): LngLat;
  /** The marker at a pane-local point, or null. */
  markerAt(x: number, y: number): MapMarker | null;
  /** Throw away every rendered tile — after a style edit an application
   *  made in place, which the map cannot see. */
  refresh(): void;
  /** What the last frame cost. */
  stats(): MapFrameStats | null;
}

/** What the `<mapview>` element takes. `<Map>` adds the uncontrolled
 *  camera and the box around it. */
export interface MapViewProps {
  /**
   * Where tiles come from, drawn in order — a basemap, then an overlay
   * pyramid over it. Empty draws the style's background and nothing else,
   * which is what a map with only markers on it wants.
   *
   * Tiles are cached per source **object**, whatever its `id`: switching
   * to another source shows only its tiles, and switching back finds the
   * first one's still cached. So keep each source stable across renders —
   * one made anew every render fetches every tile again every render.
   */
  sources?: readonly MapSource[];
  /** How to draw them. Defaults to {@link shortbreadStyle} in the theme's
   *  light or dark palette. */
  mapStyle?: MapStyle;
  /**
   * The camera, controlled. Leave it out and the **element** owns it —
   * which is not just a convenience: an element-owned camera means a pan is
   * a blit and a claim, with no React render in the loop at all.
   */
  camera?: MapCamera;
  /** Where an element-owned camera starts. Read once, at construction. */
  defaultCamera?: MapCamera;
  onCameraChange?: (camera: MapCamera) => void;
  /** Fired when a gesture ends and the camera has settled — the moment to
   *  fetch what is now on screen. */
  onMoveEnd?: (camera: MapCamera) => void;
  minZoom?: number;
  maxZoom?: number;
  markers?: readonly MapMarker[];
  overlays?: readonly MapOverlay[];
  onMapClick?: (event: MapPointerEvent) => void;
  onMarkerClick?: (marker: MapMarker, event: MapPointerEvent) => void;
  /**
   * The marker under the pointer, or null when it left every marker.
   *
   * `event` is null for the leave that comes from the pointer leaving the
   * map altogether: there is no position on the map to report, and
   * inventing one would be worse than saying so.
   */
  onMarkerHover?: (
    marker: MapMarker | null,
    event: MapPointerEvent | null,
  ) => void;
  /** `false` freezes the camera: no drag, no wheel, no keys. The map still
   *  draws and still reports clicks. */
  interactive?: boolean;
  /**
   * Show a tile as it is drawn rather than when it is finished.
   *
   * `false` by default, which is what every other map client does: a tile
   * appears whole, and until it does the coarser one already in the cache
   * is scaled up in its place. `true` composites a tile's surface as soon
   * as it exists — so a dense tile arrives as water, then landuse, then
   * road casings, then roads, across a dozen frames — which is honest about
   * what the renderer is doing and does not look like a map.
   *
   * The difference is widest at a `mapStyle` change or `refresh()`, which
   * redraws every tile at once. By default the previous style stays on
   * screen whole — tiles, background and labels — while the new one is
   * drawn behind it, and the view swaps in one frame once every tile in it
   * that has data is redrawn; a tile still loading does not hold the swap.
   * If the view keeps moving meanwhile, the wait is bounded, and a tile not
   * redrawn by then shows the background until it is. `true` shows the
   * repaint instead: the new background and labels at once, and each tile
   * as it is redrawn.
   */
  progressive?: boolean;
  /**
   * Milliseconds a frame may spend rasterizing tiles. 8 by default, which
   * leaves the rest of a 60 Hz frame for everything else; a tile that takes
   * longer than the budget is finished over the frames after it. `0`
   * suspends rasterization, which is what a gesture does on its own.
   */
  rasterBudgetMs?: number;
  /**
   * Device pixels per logical pixel for the tile surfaces, if not the
   * display's.
   *
   * Lowering it to 1 on a retina panel makes rasterization about 1.6×
   * quicker and the basemap correspondingly softer; labels, markers and
   * overlays are unaffected, since none of them goes through a tile
   * surface. Worth having on a slow machine, and worth knowing about before
   * reaching for it.
   */
  rasterScale?: number;
  /** Bytes of rendered tile surfaces to keep. 128 MB by default. */
  surfaceBudget?: number;
  /**
   * Vertices after which the rasterizer flushes its path. 12,000 by
   * default.
   *
   * A real trade on X11, where a fill becomes one coverage-mask upload and
   * a bigger path is fewer of them over the same pixels. It used to be a
   * per-backend trade — `CGContextStrokePath` was quadratic in the number
   * of subpaths, so the Cocoa backend wanted the opposite value and this
   * element probed for it — and react-x11 2.6.1 chunks that stroke inside
   * the backend instead (react-x11#457). Set it only with a profile in
   * hand.
   */
  batchVertices?: number;
  /** What the licence requires, drawn in the corner. Taken from the
   *  sources when they carry one; `''` removes it, which is the
   *  application saying it has put the attribution somewhere else. */
  attribution?: string;
  /** Called once per painted frame with what it cost. */
  onFrame?: (stats: MapFrameStats) => void;
  /**
   * Called once per failed tile load, with whatever the source threw.
   *
   * Nothing is drawn for a failed tile, so without this a source that is
   * misconfigured, rate-limited or down is indistinguishable from one that
   * is slow. The tile is retried on a backoff (0.5 s doubling to 30 s), so
   * this fires again for each retry rather than once and forever.
   */
  onTileError?: (error: unknown, tile: TileId & { sourceId: string }) => void;
  style?: Style;
  role?: string;
  'aria-label'?: string;
  'data-testname'?: string;
  ref?: Ref<unknown>;
}

/**
 * What only the GL renderer reads. Accepted by the retained renderer and
 * ignored there, as the retained renderer's own — `progressive`,
 * `rasterBudgetMs`, `rasterScale`, `surfaceBudget`, `batchVertices` — are
 * ignored by GL: switching renderer is never a type error or a rewrite.
 */
export interface MapGlProps {
  /**
   * Cross-fade between pyramid levels over this many milliseconds, instead
   * of switching to the new level's geometry in one frame. `0` (the
   * default) switches. While a level fades in the frame is drawn twice —
   * the level leaving, and the level arriving over it.
   */
  levelFade?: number;
  /**
   * Trade detail for frame rate while the camera moves. `true` holds each
   * moving frame to 12 ms; `{ budgetMs }` to another budget. When the camera
   * settles the next frame draws everything again.
   */
  adaptive?: boolean | { budgetMs?: number };
  /** Build tiles' geometry on this many worker threads, so no frame pays
   *  for a tile arriving. `0` (the default) builds on this thread, a few
   *  milliseconds a frame. */
  buildWorkers?: number;
  /** Antialias polygon edges with a half-pixel line. `true` by default; the
   *  surfaces have no multisampling, so without it an edge is a staircase. */
  antialias?: boolean;
  /** `'nonzero'` (the default, and the retained renderer's rule) or
   *  `'evenodd'`, one stencil pass cheaper and wrong wherever two features
   *  of one layer overlap. */
  fillRule?: 'nonzero' | 'evenodd';
  /**
   * Raw GL after the map has drawn and before the swap, with the frame's
   * framebuffer bound. What a test or a screenshot reads a frame back
   * through: a capture of the window from outside does not see a GL surface
   * on either backend.
   */
  onAfterDraw?: (gl: unknown, info: { width: number; height: number }) => void;
}

/** What `<Map>` takes. */
export interface MapProps extends Omit<MapViewProps, 'ref'>, MapGlProps {
  ref?: Ref<MapHandle>;
  /**
   * Which renderer draws the map: `'retained'` (the default) composites
   * rasterized tile pictures and runs anywhere; `'gl'` draws every frame
   * from the vector data on the GPU, and needs direct GL; `'auto'` takes GL
   * where the connection has it and nothing the map uses is missing from
   * it, and the retained renderer everywhere else. `REACT_X11_MAP_RENDERER`
   * overrides it for every map. See the docs page's "Renderers".
   */
  renderer?: MapRendererRequest;
  /** The map is drawn with a renderer other than the one it asked for, or
   *  changed renderer: `'auto'` finding no direct GL, a prop GL does not
   *  do yet, or GL failing at run time. The camera and the handle carry
   *  over. */
  onRendererChange?: (renderer: MapRenderer, reason: MapRendererReason) => void;
  /**
   * GL failed, on a map that asked for it by name (`renderer="gl"`). Such a
   * map never falls back — an application that asked for GL wants to know it
   * did not get it — so this is where it finds out; under `'auto'` a failure
   * moves the map to the retained renderer and says so through
   * `onRendererChange` instead.
   */
  onError?: (error: Error) => void;
  /** Anything absolutely positioned over the map — a legend, a control
   *  panel. Laid out as siblings of the drawn pane rather than inside it,
   *  because a registered element paints its children *before* its own
   *  drawing and anything inside would be painted over. */
  children?: ReactNode;
}
