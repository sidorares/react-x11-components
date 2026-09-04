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

/** What one frame cost — for a performance HUD, and what
 *  `scripts/bench/maps.ts` reads. */
export interface MapFrameStats {
  /** Milliseconds spent rasterizing tiles into their surfaces this frame.
   *  Bounded by `rasterBudgetMs` except for the one run that crossed it. */
  rasterMs: number;
  /** …and compositing them, drawing the labels, overlays and markers. */
  drawMs: number;
  /** Tiles the cover asked for. */
  tiles: number;
  /** …of which were composited from their own finished surface. Under
   *  `progressive` this also counts the half-drawn ones. */
  ready: number;
  /** …and how many were drawn from a coarser ancestor instead. */
  fromAncestor: number;
  /** Tiles still to rasterize — non-zero means the map is still sharpening
   *  and another frame is already scheduled. */
  pending: number;
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
  /** Bytes of rendered surfaces the cache is holding. */
  surfaceBytes: number;
  /**
   * What this pass repainted, in device pixels, or `null` for a full one.
   *
   * The number to watch when a map looks busy: a frame that is only
   * continuing a rasterization should claim almost nothing, because the
   * tile being drawn is a second surface nobody is looking at. A run of
   * full-pane damage while tiles are still landing means something is
   * asking for repaints it does not need — which on a backend that paints
   * many frames a second reads as flashing.
   */
  damage: { x: number; y: number; width: number; height: number } | null;
  /** What the rasterizer did, summed over the tiles drawn this frame. */
  draw: {
    features: number;
    vertices: number;
    decimated: number;
    culled: number;
    batches: number;
  };
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
   * The one thing the default costs is a transition that invalidates every
   * surface at once: a `mapStyle` change, `refresh()`, or a display-scale
   * change leaves no finished tile *and* no finished ancestor, so the map
   * drops to its background colour until the new tiles land. `true` shows
   * it repainting instead.
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
   * Vertices after which the rasterizer flushes its path, if not the
   * backend's own answer.
   *
   * The default is chosen from the backend, because the two rasterizers
   * fail in opposite directions and the measurements are three to five
   * times apart either way — see `docs/prd-maps.md`. Set it only with a
   * profile in hand.
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

/** What `<Map>` takes. */
export interface MapProps extends Omit<MapViewProps, 'ref'> {
  ref?: Ref<MapHandle>;
  /** Anything absolutely positioned over the map — a legend, a control
   *  panel. Laid out as siblings of the drawn pane rather than inside it,
   *  because a registered element paints its children *before* its own
   *  drawing and anything inside would be painted over. */
  children?: ReactNode;
}
