// The camera and the input, which both of `<Map>`'s renderers drive.
//
// `<Map>` draws through one of two renderers — the retained one in
// `./node.ts`, which composites rasterized tile surfaces, and the GL one in
// `./gl/`, which draws every frame from vector buckets — and chooses between
// them at run time (`./renderer.ts`). What neither may own is the camera. A
// map that falls back from GL to the retained renderer in the middle of a pan
// has to keep the camera it was panned to, the handle an application holds
// has to keep working, and a gesture has to mean the same thing on both —
// which is only true if both renderers answer to one object. This is it: the
// camera and its controlled/uncontrolled fork, the settle window,
// `onCameraChange` and `onMoveEnd`, the gestures (drag, wheel, keys, double
// click, a press on a marker, the hover), the marker hit test, and the
// handle `<Map>`'s ref hands out. A renderer attaches to it as a
// {@link MapView} — where its pane is, what a camera move costs it — and
// holds no camera of its own.
//
// The camera lives on an object rather than in React state for the reason
// `AGENTS.md` gives under "A map, and the three caches under it": that is
// what makes a drag step two numbers and a blit, with no render and no commit
// in the loop. `<Map>` makes one controller per mount and hands it to
// whichever renderer is drawing; a bare `<mapview>` makes its own.
import type { A11ySceneItem } from 'react-x11/node';

import { markerAt, markerRect } from './overlay.js';
import type { MapMarker } from './overlay.js';
import {
  DEFAULT_TILE_SIZE,
  boundsOf,
  cameraForBounds,
  projectLngLat,
  transformFor,
  unprojectPoint,
  visibleBounds,
} from './proj.js';
import type {
  LngLat,
  LngLatBounds,
  MapCamera,
  ScreenRect,
  Transform,
} from './proj.js';
import type {
  FitBoundsOptions,
  MapFrameStats,
  MapHandle,
  MapPointerEvent,
} from './types.js';

/** Where a map with no camera given starts. */
export const DEFAULT_CAMERA: MapCamera = {
  center: { lon: 0, lat: 20 },
  zoom: 2,
};

/** Logical pixels the pointer may travel before a press becomes a drag. */
export const DRAG_THRESHOLD = 3;

/**
 * How long after the last camera change the map counts as moving.
 *
 * One window for both renderers, and both ask it the same question — is this
 * a gesture? The retained renderer rasterizes nothing inside it, so a drag or
 * a wheel is composites only; the GL renderer draws at reduced detail inside
 * it when adaptive quality asks, and admits no new labels. `onMoveEnd` fires
 * when it closes. Long enough that a wheel zoom's many notches count as one
 * gesture, short enough that the map sharpens before the user has finished
 * looking. (The retained renderer had 140 ms and the GL proof of concept
 * 180; the retained number was the one its tests had pinned.)
 */
export const SETTLE_MS = 140;

/**
 * Zoom is quantized to this, for the reason react-x11's docs/scale.md gives
 * about a gesture-driven `scale`: every distinct value is a distinct set of
 * font sizes to shape, and a wheel feeding a raw accumulator makes a new set
 * per frame. A sixteenth of a level is finer than the eye reads as stepping.
 */
const ZOOM_STEP = 1 / 16;

/** A zoom on the {@link ZOOM_STEP} grid — also what a label placement is
 *  keyed on, so a placement and the zooms a wheel produces agree. */
export function quantizeZoom(zoom: number): number {
  return Math.round(zoom / ZOOM_STEP) * ZOOM_STEP;
}

/** A wheel notch is this much zoom. */
const WHEEL_ZOOM = 1 / 2.5;

/** The props the controller reads — `<Map>`'s, whichever renderer draws. */
export interface MapControllerProps {
  camera?: MapCamera;
  onCameraChange?: (camera: MapCamera) => void;
  onMoveEnd?: (camera: MapCamera) => void;
  minZoom?: number;
  maxZoom?: number;
  interactive?: boolean;
  markers?: readonly MapMarker[];
  onMapClick?: (event: MapPointerEvent) => void;
  onMarkerClick?: (marker: MapMarker, event: MapPointerEvent) => void;
  onMarkerHover?: (
    marker: MapMarker | null,
    event: MapPointerEvent | null,
  ) => void;
}

/**
 * A renderer, as the controller sees it: where its pane is, and what a camera
 * move costs it. Nothing about how it draws.
 */
export interface MapView {
  /** The pane, in the window's logical pixels — empty before layout. */
  pane(): ScreenRect;
  /** Device pixels per logical pixel. */
  scale(): number;
  /**
   * The camera moved, and the view should show it. `blit` says whether the
   * move is a translation of what is already on screen — a pan — rather
   * than a zoom or a jump: the retained renderer's difference between a
   * blit and a repaint.
   */
  moved(previous: MapCamera, next: MapCamera, blit: boolean): void;
  /** The settle window closed: the map is still, and may sharpen. */
  settled(): void;
  /** `refresh()`: throw away everything derived from the style. */
  refresh(): void;
  stats(): MapFrameStats | null;
  /** Take the keyboard focus — a pan is where the arrows start working. */
  focus(): void;
}

/** A pointer event as the controller reads it: pane-local logical pixels,
 *  the button, the click count and the modifiers. */
export interface MapPointerInput {
  x: number;
  y: number;
  /** `1` left, `2` middle, `3` right. */
  button?: number;
  /** The click count: `2` is the second press of a double click. */
  detail?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/** What a press began — see {@link MapController.pointerDown}. */
export type PressKind = 'marker' | 'pan' | 'frozen';

type Gesture =
  | {
      kind: 'pan';
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      moved: boolean;
    }
  | { kind: 'marker'; id: string; startX: number; startY: number };

const timers = globalThis as {
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
};

/**
 * The settle timer, unref'd where the runtime allows it.
 *
 * A map that has just been panned holds a timer, and an unref'd one does not
 * keep a process alive on its own — which matters for a script or a test that
 * renders a map and expects to exit, and is the call core's caret blink makes
 * for the same reason.
 */
function arm(tick: () => void, ms: number): unknown {
  const handle = timers.setTimeout?.(tick, ms) ?? null;
  (handle as { unref?(): void } | null)?.unref?.();
  return handle;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

const EMPTY_PANE: ScreenRect = { x: 0, y: 0, width: 0, height: 0 };

export class MapController {
  /**
   * What `<Map>`'s ref hands out. Made once, so it is the **same object**
   * for the life of the mount — across a renderer switch too, which is
   * what lets an application hold it in a ref and never look again.
   */
  readonly handle: MapHandle;

  /**
   * Set by the view for the length of a frame. A camera change made inside
   * one — the fit that a `fitBounds` asked for before layout, applied at
   * the first frame with a size — is already what the frame draws, so it
   * claims nothing and starts no gesture.
   */
  painting = false;

  private _props: MapControllerProps = {};
  /** The camera, when the application does not control it. */
  private _camera: MapCamera;
  private _view: MapView | null = null;
  private _gesture: Gesture | null = null;
  private _hover: string | null = null;
  /** Wall-clock time the settle window closes at. */
  private _settleAt = 0;
  private _settleTimer: unknown = null;
  private _pendingFit: {
    bounds: LngLatBounds;
    options?: FitBoundsOptions;
  } | null = null;

  constructor(seed: MapCamera = DEFAULT_CAMERA) {
    this._camera = { center: { ...seed.center }, zoom: seed.zoom };
    this.handle = {
      getCamera: () => this.getCamera(),
      setCamera: (camera) => this.setCamera(camera),
      panBy: (dx, dy) => this.panBy(dx, dy),
      zoomIn: (step) => this.zoomIn(step),
      zoomOut: (step) => this.zoomOut(step),
      zoomTo: (zoom) => this.zoomTo(zoom),
      fitBounds: (bounds, options) => this.fitBounds(bounds, options),
      fitMarkers: (ids, options) => this.fitMarkers(ids, options),
      getBounds: () => this.getBounds(),
      project: (position) => this.project(position),
      unproject: (x, y) => this.unproject(x, y),
      markerAt: (x, y) => this.markerAt(x, y),
      refresh: () => this._view?.refresh(),
      stats: () => this._view?.stats() ?? null,
    };
  }

  // --- props and views --------------------------------------------------------

  /** The props to read from here on. Read lazily, at event and frame time,
   *  so a new object per render costs an assignment. */
  setProps(props: MapControllerProps): void {
    this._props = props;
  }

  get props(): MapControllerProps {
    return this._props;
  }

  /** The renderer drawing the map from now on. */
  attach(view: MapView): void {
    this._view = view;
  }

  /** …and letting go, if it still is: during a renderer switch the new
   *  view can attach before the old one is torn down. */
  detach(view: MapView): void {
    if (this._view === view) this._view = null;
  }

  get view(): MapView | null {
    return this._view;
  }

  /**
   * Stop the settle timer — the one thing held that outlives a frame. The
   * camera and the view stay, so a mount that React only pretends to tear
   * down (a strict-mode double effect) comes back to a working controller;
   * the next camera move arms the timer again.
   */
  dispose(): void {
    if (this._settleTimer !== null) timers.clearTimeout?.(this._settleTimer);
    this._settleTimer = null;
  }

  private _minZoom(): number {
    return this._props.minZoom ?? 0;
  }

  private _maxZoom(): number {
    return this._props.maxZoom ?? 22;
  }

  private _interactive(): boolean {
    return this._props.interactive !== false;
  }

  private _markers(): readonly MapMarker[] {
    return this._props.markers ?? [];
  }

  // --- the camera ----------------------------------------------------------

  /** The camera in effect: the application's when it controls one. */
  camera(): MapCamera {
    return this._props.camera ?? this._camera;
  }

  /** The camera this controller keeps for itself — the one in effect
   *  whenever the application is not controlling it. */
  ownCamera(): MapCamera {
    return this._camera;
  }

  /** The pane, in the window's logical pixels — empty with no view. */
  pane(): ScreenRect {
    return this._view?.pane() ?? EMPTY_PANE;
  }

  /** A camera resolved against the pane. */
  transform(camera: MapCamera = this.camera()): Transform {
    const pane = this.pane();
    return transformFor(
      camera,
      { width: pane.width, height: pane.height },
      DEFAULT_TILE_SIZE,
    );
  }

  /**
   * Move the camera — the one place it changes.
   *
   * Clamped (the zoom to the range, the latitude to what Web Mercator can
   * represent; the longitude is not, because the map wraps and a camera just
   * past the antimeridian is a camera in the next copy of the world),
   * reported, and the settle window restarted: every camera move is a
   * gesture, not only a pointer one, because an application animating the
   * camera with `panBy` in a loop wants what a drag wants.
   *
   * A camera the application controls is only *asked* to move:
   * `onCameraChange` is the request, and the view hears about the move when
   * the new `camera` prop arrives. Telling it here as well was a double
   * shift — the retained renderer blitted the pane for the request and then
   * again for the prop, and `scrollContents` adds two shifts in a frame
   * together.
   */
  apply(next: MapCamera, blit: boolean): void {
    const previous = this.camera();
    const camera: MapCamera = {
      center: { lon: next.center.lon, lat: clamp(next.center.lat, -85, 85) },
      zoom: clamp(next.zoom, this._minZoom(), this._maxZoom()),
    };
    if (
      camera.zoom === previous.zoom &&
      camera.center.lon === previous.center.lon &&
      camera.center.lat === previous.center.lat
    ) {
      return;
    }
    const controlled = this._props.camera !== undefined;
    if (!controlled) this._camera = camera;
    this._props.onCameraChange?.(camera);
    if (this.painting) return;
    this.touch();
    if (!controlled) this._view?.moved(previous, camera, blit);
  }

  getCamera(): MapCamera {
    const camera = this.camera();
    return { center: { ...camera.center }, zoom: camera.zoom };
  }

  setCamera(camera: Partial<MapCamera>): void {
    const current = this.camera();
    this.apply(
      {
        center: camera.center ?? current.center,
        zoom: camera.zoom ?? current.zoom,
      },
      false,
    );
  }

  /** Move by a distance in pane-local logical pixels. */
  panBy(dx: number, dy: number): void {
    const t = this.transform();
    this.apply(
      {
        zoom: t.zoom,
        center: unprojectPoint(t, t.paneX + dx, t.paneY + dy),
      },
      true,
    );
  }

  zoomIn(step = 1): void {
    const pane = this.pane();
    this.zoomAbout(step, pane.width / 2, pane.height / 2);
  }

  zoomOut(step = 1): void {
    this.zoomIn(-step);
  }

  zoomTo(zoom: number): void {
    this.setCamera({ zoom });
  }

  /**
   * Zoom by `delta` levels about a pane-local point that must not move —
   * the pointer under a wheel, the pane's centre for a key.
   */
  zoomAbout(delta: number, x: number, y: number): void {
    const camera = this.camera();
    const zoom = clamp(
      quantizeZoom(camera.zoom + delta),
      this._minZoom(),
      this._maxZoom(),
    );
    if (zoom === camera.zoom) return;
    const before = this.transform(camera);
    const anchor = unprojectPoint(before, x, y);
    const after = this.transform({ center: camera.center, zoom });
    // Where the anchor would land at the new zoom, and how far the centre
    // has to move so it lands where it already is.
    const moved = projectLngLat(after, anchor);
    const dx = (moved.x - x) / after.world;
    const dy = (moved.y - y) / after.world;
    this.apply(
      {
        zoom,
        center: unprojectPoint(
          {
            ...after,
            centerX: after.centerX + dx,
            centerY: after.centerY + dy,
          },
          after.paneX,
          after.paneY,
        ),
      },
      false,
    );
  }

  fitBounds(bounds: LngLatBounds, options?: FitBoundsOptions): void {
    const pane = this.pane();
    if (pane.width <= 0 || pane.height <= 0) {
      // Asked before layout has run — which `fitBounds` in an effect always
      // is. Remembered, and applied at the first frame that has a size.
      this._pendingFit = { bounds, options };
      return;
    }
    this._pendingFit = null;
    this.apply(
      cameraForBounds(
        bounds,
        { width: pane.width, height: pane.height },
        {
          padding: options?.padding ?? 24,
          tileSize: DEFAULT_TILE_SIZE,
          minZoom: this._minZoom(),
          maxZoom: options?.maxZoom ?? this._maxZoom(),
        },
      ),
      false,
    );
  }

  fitMarkers(ids?: readonly string[], options?: FitBoundsOptions): void {
    const wanted = ids ? new Set(ids) : null;
    const positions: LngLat[] = [];
    for (const marker of this._markers()) {
      if (wanted && !wanted.has(marker.id)) continue;
      positions.push(marker.position);
    }
    const bounds = boundsOf(positions);
    if (bounds) this.fitBounds(bounds, options);
  }

  /** What the pane can see — the whole world before it has a size. */
  getBounds(): LngLatBounds {
    const pane = this.pane();
    if (pane.width <= 0 || pane.height <= 0) {
      return { west: -180, south: -85, east: 180, north: 85 };
    }
    return visibleBounds(this.transform());
  }

  project(position: LngLat): { x: number; y: number } {
    return projectLngLat(this.transform(), position);
  }

  unproject(x: number, y: number): LngLat {
    return unprojectPoint(this.transform(), x, y);
  }

  markerAt(x: number, y: number): MapMarker | null {
    return markerAt(this._markers(), this.transform(), x, y);
  }

  /**
   * A view is about to draw a frame: a `fitBounds` that arrived before the
   * pane had a size is applied now, so the frame draws it.
   */
  beginFrame(): void {
    const fit = this._pendingFit;
    if (!fit) return;
    const pane = this.pane();
    if (pane.width <= 0 || pane.height <= 0) return;
    this.fitBounds(fit.bounds, fit.options);
  }

  // --- the settle window ---------------------------------------------------

  /** Whether the camera moved within the settle window. */
  get moving(): boolean {
    return Date.now() < this._settleAt;
  }

  /** …or a press is still down: what the retained renderer holds
   *  rasterization off for. */
  get gesturing(): boolean {
    return this._gesture !== null || this.moving;
  }

  /** Whether a pan gesture is under way — a press that may yet drag. */
  get dragging(): boolean {
    return this._gesture?.kind === 'pan';
  }

  /**
   * Restart the settle window. When it closes the camera has held still for
   * {@link SETTLE_MS}: `onMoveEnd` fires — the moment an application fetches
   * what is now on screen — and the view is told it may sharpen.
   *
   * Wall-clock time rather than a frame clock: this is a window a hundred
   * and forty milliseconds long compared inside a timer callback, and a
   * timer is the one thing that runs when no frame does.
   */
  touch(): void {
    this._settleAt = Date.now() + SETTLE_MS;
    if (this._settleTimer !== null) return;
    const tick = (): void => {
      this._settleTimer = null;
      const left = this._settleAt - Date.now();
      if (left > 0) {
        this._settleTimer = arm(tick, left);
        return;
      }
      this._props.onMoveEnd?.(this.camera());
      this._view?.settled();
    };
    this._settleTimer = arm(tick, SETTLE_MS);
  }

  // --- input ---------------------------------------------------------------

  /**
   * A press. Answers what it began, for the view to capture the pointer — and
   * for a pan, to take the focus — or null when nothing is.
   *
   * A press on a marker is a marker gesture: its release is a marker click.
   * A press anywhere else is a pan, or on a map that does not move a
   * `'frozen'` press, which pans nothing and is still a click when it is
   * released — an application listening for clicks on a frozen map gets
   * them.
   */
  pointerDown(input: MapPointerInput): PressKind {
    const marker = markerAt(
      this._markers(),
      this.transform(),
      input.x,
      input.y,
    );
    if (marker) {
      this._gesture = {
        kind: 'marker',
        id: marker.id,
        startX: input.x,
        startY: input.y,
      };
      return 'marker';
    }
    this._gesture = {
      kind: 'pan',
      startX: input.x,
      startY: input.y,
      lastX: input.x,
      lastY: input.y,
      moved: false,
    };
    return this._interactive() ? 'pan' : 'frozen';
  }

  /** The pointer moved with the press still down. */
  pointerDrag(input: MapPointerInput): void {
    const gesture = this._gesture;
    if (!gesture || gesture.kind !== 'pan') return;
    if (!this._interactive()) return;
    if (
      !gesture.moved &&
      Math.abs(input.x - gesture.startX) < DRAG_THRESHOLD &&
      Math.abs(input.y - gesture.startY) < DRAG_THRESHOLD
    ) {
      return;
    }
    gesture.moved = true;
    // Whole device pixels, because that is what the retained renderer's
    // blit can shift — a fractional pan would decline it every frame and
    // repaint the pane. Invisible on the GL renderer, which draws any shift.
    const scale = this._view?.scale() ?? 1;
    const dx = Math.round((input.x - gesture.lastX) * scale) / scale;
    const dy = Math.round((input.y - gesture.lastY) * scale) / scale;
    if (dx === 0 && dy === 0) return;
    gesture.lastX += dx;
    gesture.lastY += dy;
    this.touch();
    this.panBy(-dx, -dy);
  }

  /**
   * The press let go. A release within the drag threshold of a marker press
   * is that marker's click, then the map's; one that ended no drag is the
   * map's click. And the second release of a double click zooms in about the
   * pointer, Shift for out — the convention every map client has.
   */
  pointerUp(input: MapPointerInput): void {
    const gesture = this._gesture;
    this._gesture = null;
    if (!gesture) return;
    if (gesture.kind === 'marker') {
      const marker = this._markers().find((m) => m.id === gesture.id);
      if (
        marker &&
        Math.abs(input.x - gesture.startX) < DRAG_THRESHOLD &&
        Math.abs(input.y - gesture.startY) < DRAG_THRESHOLD
      ) {
        const event = this.pointerEvent(input, marker);
        this._props.onMarkerClick?.(marker, event);
        this._props.onMapClick?.(event);
      }
      return;
    }
    if (gesture.moved) {
      this.touch();
      return;
    }
    this._props.onMapClick?.(this.pointerEvent(input, null));
    if (input.detail === 2 && this._interactive()) {
      this.zoomAbout(input.shiftKey ? -1 : 1, input.x, input.y);
    }
  }

  /** The pointer moved with nothing pressed: the marker under it, if that
   *  changed, is `onMarkerHover`'s. */
  pointerMove(input: MapPointerInput): void {
    const notify = this._props.onMarkerHover;
    if (!notify) return;
    const marker = markerAt(
      this._markers(),
      this.transform(),
      input.x,
      input.y,
    );
    const id = marker?.id ?? null;
    if (id === this._hover) return;
    this._hover = id;
    notify(marker, this.pointerEvent(input, marker));
  }

  /**
   * The pointer left the map. No event: there is no position on the map to
   * report, and inventing one would be worse than saying so.
   */
  pointerLeave(): void {
    if (this._hover === null) return;
    this._hover = null;
    this._props.onMarkerHover?.(null, null);
  }

  /**
   * The wheel, which is a zoom about the pointer. True when it was consumed
   * — always, on a map that moves: a wheel over a map is never meant for
   * whatever is behind it.
   */
  wheel(input: MapPointerInput, deltaY: number): boolean {
    if (!this._interactive()) return false;
    this.touch();
    this.zoomAbout(-deltaY * WHEEL_ZOOM * 0.02, input.x, input.y);
    return true;
  }

  /** A key: the arrows pan, +/− zoom about the centre. True when it was one
   *  of those, on a map that moves. */
  keyDown(keysym: number, shiftKey: boolean): boolean {
    if (!this._interactive()) return false;
    const pane = this.pane();
    const step = shiftKey ? 200 : 60;
    switch (keysym) {
      case 0xff51: // XK_Left
        this.panBy(-step, 0);
        return true;
      case 0xff53: // XK_Right
        this.panBy(step, 0);
        return true;
      case 0xff52: // XK_Up
        this.panBy(0, -step);
        return true;
      case 0xff54: // XK_Down
        this.panBy(0, step);
        return true;
      case 0x002b: // XK_plus
      case 0x003d: // XK_equal
      case 0xffab: // XK_KP_Add
        this.zoomAbout(1, pane.width / 2, pane.height / 2);
        return true;
      case 0x002d: // XK_minus
      case 0xffad: // XK_KP_Subtract
        this.zoomAbout(-1, pane.width / 2, pane.height / 2);
        return true;
      default:
        return false;
    }
  }

  /** Where a pointer event happened, in every space that could be wanted. */
  pointerEvent(
    input: MapPointerInput,
    marker: MapMarker | null,
  ): MapPointerEvent {
    return {
      lngLat: unprojectPoint(this.transform(), input.x, input.y),
      x: input.x,
      y: input.y,
      marker,
      shiftKey: input.shiftKey ?? false,
      ctrlKey: input.ctrlKey ?? false,
      altKey: input.altKey ?? false,
      metaKey: input.metaKey ?? false,
      button: input.button ?? 1,
    };
  }

  /**
   * What a screen reader meets: the markers in view, as buttons.
   *
   * A map is one painted rectangle to an assistive technology, and its
   * markers are the only things in it that are *objects* rather than
   * cartography — so those are the scene. Announcing every road would be
   * worse than announcing none. The same whichever renderer draws.
   */
  markerScene(): A11ySceneItem[] {
    const pane = this.pane();
    if (pane.width <= 0 || pane.height <= 0) return [];
    const transform = this.transform();
    const scale = this._view?.scale() ?? 1;
    const items: A11ySceneItem[] = [];
    for (const marker of this._markers()) {
      const rect = markerRect(marker, transform);
      if (
        rect.x + rect.width < 0 ||
        rect.y + rect.height < 0 ||
        rect.x > pane.width ||
        rect.y > pane.height
      ) {
        continue;
      }
      items.push({
        id: `marker:${marker.id}`,
        // Device pixels in the owning window's coordinates, which is what
        // an a11y scene rect is — the same space as `abs`.
        rect: {
          x: (pane.x + rect.x) * scale,
          y: (pane.y + rect.y) * scale,
          width: rect.width * scale,
          height: rect.height * scale,
        },
        role: 'button',
        name:
          marker.title ??
          `${marker.position.lat.toFixed(4)}, ${marker.position.lon.toFixed(4)}`,
        states: { selected: marker.selected ?? false },
      });
    }
    return items;
  }
}
