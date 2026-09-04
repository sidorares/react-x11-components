// `<mapview>` — the element that draws the map.
//
// One element, drawing a whole scene, for the reason `AGENTS.md` gives
// under "Drawing beats composing when the viewport is a transform": pan and
// zoom are a transform, this renderer's style vocabulary has no transform,
// and a composed map would re-render every road through React and re-lay it
// out through yoga on every pointer step. `<Flow>` reached the same place
// first; this adds the part a graph does not have, which is that the scene
// arrives a tile at a time and costs tens of milliseconds a tile to draw.
//
// Three caches, and the map's whole performance argument is the way they
// are layered:
//
//  1. **Tile data**, keyed on `source/z/x/y` and valid forever.
//  2. **A rendered `Surface` per tile**, valid for a zoom *level* and a
//     style — not for a camera position. So a **pan** composites the same
//     surfaces at new offsets (and blits, so most of them are not even
//     composited), and a **fractional zoom** composites them scaled. Neither
//     rasterizes anything. Only crossing an integer zoom does.
//  3. **A label placement in world pixels**, valid for a zoom and a set of
//     loaded tiles — so a pan translates it rather than recomputing it, and
//     the blit stays correct.
//
// And one budget: rasterization is resumable by style run, and a frame
// spends at most `rasterBudgetMs` on it. A dense city tile is 50-140 ms to
// draw (see `docs/prd-maps.md` for the measurements), so without this a
// tile arriving would drop eight frames; with it, the tile fills in over a
// dozen frames and no frame is late. Gestures set the budget to zero, so
// nothing is ever rasterized during a drag.
import { Node } from 'react-x11/node';
import type { A11ySceneItem, Context2D } from 'react-x11/node';
import type { KeyboardEvent, MouseEvent, WheelEvent } from 'react-x11';
import { Surface } from 'react-x11/ntk';

import { GeometryBuffer } from './mvt.js';
import {
  BATCH_VERTICES,
  DrawScratch,
  drawTileRun,
  isMapCanvas,
  now,
  prepareStyle,
} from './paint.js';
import type { MapCanvas, PreparedStyle } from './paint.js';
import {
  DEFAULT_TILE_SIZE,
  cameraForBounds,
  boundsOf,
  dataTileFor,
  subTileOf,
  projectLngLat,
  rasterFor,
  tileCover,
  transformFor,
  unprojectPoint,
  visibleBounds,
} from './proj.js';
import type {
  LngLat,
  LngLatBounds,
  MapCamera,
  ScreenRect,
  TileCoverEntry,
  TileId,
  Transform,
} from './proj.js';
import { TileCache, pyramid } from './tiles.js';
import type { CachedTile, SurfaceLike, TileRender } from './tiles.js';
import type { MapSource } from './sources.js';
import { shortbreadStyle } from './styles.js';
import type { MapStyle } from './style.js';
import {
  LabelShaper,
  collectLabels,
  drawLabels,
  placeLabels,
} from './labels.js';
import type { FontsLike, LabelCandidate, PlacedLabel } from './labels.js';
import { drawMarkers, drawOverlays, markerAt, markerRect } from './overlay.js';
import type { MapMarker, MapOverlay, OverlayPalette } from './overlay.js';
import type { MapFrameStats, MapPointerEvent } from './types.js';

/** Registration key, `kind` and JSX tag, one string — react-x11 rejects a
 *  node whose `kind` is not the name it was registered under, because
 *  `kind` is what paint order, the test queries and the DEV style assertion
 *  all match on. */
export const ELEMENT = 'mapview';

/**
 * The props whose change means different pixels but whose damage this
 * element claims for itself.
 *
 * Without this, a controlled map committing a new `markers` array per
 * pointer step would claim the whole pane on every one of them, and the
 * scoped claim the gesture made would be swallowed by it — the same trap
 * `<Flow>` documents (react-x11#301).
 */
export const SELF_DAMAGED_PROPS = [
  'camera',
  'markers',
  'overlays',
  'sources',
  'mapStyle',
] as const;

/** Screen pixels the pointer may travel before a press becomes a drag. */
const DRAG_THRESHOLD = 3;

/** How long after the last gesture step the map goes back to rasterizing.
 *  Long enough that a wheel-zoom's many steps count as one gesture, short
 *  enough that the map sharpens before the user has finished looking. */
const SETTLE_MS = 140;

/** Zoom is quantized to this, for the reason react-x11's docs/scale.md
 *  gives about a gesture-driven `scale`: every distinct value is a distinct
 *  set of font sizes to shape, and a wheel feeding a raw accumulator makes
 *  a new set per frame. A sixteenth of a level is finer than the eye reads
 *  as stepping. */
const ZOOM_STEP = 1 / 16;

/** A wheel notch is this much zoom. */
const WHEEL_ZOOM = 1 / 2.5;

/** The largest tile surface, per edge, in device pixels. An argb32 surface
 *  is `4 × size²` bytes, so 2048 is 16 MB and is already more than any
 *  pyramid justifies. */
const MAX_RASTER = 2048;

/**
 * How many levels past a source's own depth the cover may go.
 *
 * Each level is a factor of two in linear detail and four in the number of
 * tiles sharing one fetch, so six is 64× sharper than the stretched bitmap
 * it replaces and 4,096 renderings per source tile at the very bottom —
 * which is fine, because only the handful on screen are ever built. Beyond
 * this the data itself is the limit: at zoom 20 one unit of a zoom-14
 * tile's 4,096-unit grid is already 16 device pixels across, so there is no
 * more shape to draw.
 */
const MAX_OVERZOOM = 6;

/** How far outside the pane tiles are kept warm, in logical pixels. Half a
 *  tile: enough that an ordinary flick has its tiles, not so much that a
 *  window covers four times the tiles it shows. */
const COVER_PADDING = 256;

/** The overlap of two rects, or null when they do not meet. */
function intersectRects(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

const timers = globalThis as {
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
};

/**
 * The settle timer, unref'd where the runtime allows it.
 *
 * A map that has just been panned holds a 140 ms timer, and an unref'd one
 * does not keep a process alive on its own — which matters for a script or
 * a test that renders a map and expects to exit, and is the call core's
 * caret blink makes for the same reason.
 */
function arm(tick: () => void): unknown {
  const handle = timers.setTimeout?.(tick, SETTLE_MS) ?? null;
  (handle as { unref?(): void } | null)?.unref?.();
  return handle;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function quantize(zoom: number): number {
  return Math.round(zoom / ZOOM_STEP) * ZOOM_STEP;
}

/** A logical value put on the device grid — the same helper `src/flow/`
 *  keeps, and for the same reason: ntk's fast paths for a blit and a
 *  rounded box are gated on integral geometry, and `x * 1.5` is not always
 *  the integer it should be in floating point. */
function toDevice(value: number, scale: number): number {
  const out = value * scale;
  const whole = Math.round(out);
  return Math.abs(out - whole) < 1e-6 ? whole : out;
}

function rectsOverlap(a: ScreenRect, b: ScreenRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

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

export class MapViewNode extends Node {
  private readonly _cache: TileCache;
  private readonly _scratch = new DrawScratch();
  private readonly _geometry = new GeometryBuffer();
  private _shaper: LabelShaper | null = null;

  /**
   * The camera this element owns, used whenever `props.camera` is absent.
   *
   * The element keeping it — rather than the component above holding it in
   * `useState` — is what makes a pan cost nothing but a blit: a drag step
   * moves this number and claims a strip, and React is not involved at all.
   * Routed through state instead, every pointer step would be a render, a
   * commit and a full-pane claim, which is the shape `<Flow>` documents as
   * "the content lags and catches up".
   */
  private _camera: MapCamera = { center: { lon: 0, lat: 20 }, zoom: 2 };

  private _prepared: PreparedStyle | null = null;
  private _preparedFrom: MapStyle | null = null;
  private _defaultStyle: MapStyle | null = null;

  /** The placement, and what it was computed for. */
  private _labels: PlacedLabel[] = [];
  private _labelKey = '';
  /** Candidates per tile, so a pan that brings a tile back does not redo
   *  the walk over its symbol layers. */
  private readonly _candidates = new Map<string, LabelCandidate[]>();

  private _gesture: Gesture | null = null;
  private _hover: string | null = null;
  /** Set while a gesture is in flight and for `SETTLE_MS` after it, which
   *  is when rasterization is suspended. */
  private _settleAt = 0;
  private _settleTimer: unknown = null;
  private _painting = false;
  /** Whether any tile has been rasterized in the frame being painted — the
   *  forward-progress guarantee below. */
  private _rastered = false;
  private _frameClip: ScreenRect | null = null;
  private _stats: MapFrameStats | null = null;
  private _sceneAnnounced = false;

  constructor(props: Record<string, unknown>, app: unknown) {
    super(ELEMENT, props, app as ConstructorParameters<typeof Node>[2]);
    // Seeded once. `defaultCamera` is read here and never again, which is
    // what makes it a *default* rather than a second controlled prop.
    const seed = (props.camera ?? props.defaultCamera) as MapCamera | undefined;
    if (seed) this._camera = { center: { ...seed.center }, zoom: seed.zoom };
    // A map is a thing you drive with the keyboard as well as the mouse:
    // arrows pan, +/- zoom. Without this it is never focused and no key
    // arrives.
    this.focusableByDefault = true;
    this.defaultCursor = 'grab';
    this._cache = new TileCache({
      surfaceBudget: this._prop<number>('surfaceBudget'),
      onError: (entry) => {
        this._prop<
          (error: unknown, tile: TileId & { sourceId: string }) => void
        >('onTileError')?.(entry.error, {
          ...entry.tile,
          // The data entry is keyed per source, so the id is recoverable
          // from the key it was built with.
          sourceId: entry.key.slice(0, entry.key.lastIndexOf(':')),
        });
      },
      onChange: () => {
        // A tile landed. Its own box is the honest claim, but the tile is
        // not yet rasterized and the label placement may change, so the
        // frame is a full one — which is what a tile arriving looks like
        // anyway, and it happens once per tile rather than per frame.
        this._labelKey = '';
        this._repaint('content');
      },
    });
  }

  // --- props ---------------------------------------------------------------

  private _prop<T>(name: string): T | undefined {
    return this.props[name] as T | undefined;
  }

  private get _scale(): number {
    return this.scale > 0 ? this.scale : 1;
  }

  /** The style, compiled. Recompiled only when the style object changes
   *  identity, so an application holding one in a module constant pays
   *  once for the life of the process. */
  private _style(): PreparedStyle {
    const given = this._prop<MapStyle>('mapStyle');
    if (given) {
      if (this._prepared && this._preparedFrom === given) return this._prepared;
      this._preparedFrom = given;
      this._prepared = prepareStyle(given);
      return this._prepared;
    }
    if (!this._defaultStyle) {
      // Built once, and from the theme's own light/dark decision rather
      // than from a prop: a map inside a dark application that stays light
      // is the thing everyone notices first.
      this._defaultStyle = shortbreadStyle({ dark: this._isDark() });
    }
    if (this._prepared && this._preparedFrom === this._defaultStyle) {
      return this._prepared;
    }
    this._preparedFrom = this._defaultStyle;
    this._prepared = prepareStyle(this._defaultStyle);
    return this._prepared;
  }

  private _isDark(): boolean {
    const theme = this.theme as Record<string, unknown> | undefined;
    const background = theme?.background;
    if (typeof background !== 'string') return false;
    // The same reading `src/code-editor/`'s token themes make: luminance of
    // the surface the widget sits on, not a flag nobody sets.
    const hex = background.trim();
    if (!hex.startsWith('#') || hex.length < 7) return false;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }

  private _palette(): OverlayPalette {
    const theme = this.theme as Record<string, unknown> | undefined;
    return {
      accent: (theme?.accent as string) ?? '#2d6cdf',
      background: (theme?.background as string) ?? '#ffffff',
      text: (theme?.text as string) ?? '#111111',
    };
  }

  private _sources(): MapSource[] {
    const given = this._prop<readonly MapSource[]>('sources');
    return given ? [...given] : [];
  }

  private _sourceId(source: MapSource, index: number): string {
    return source.id ?? `source-${index}`;
  }

  private _minZoom(): number {
    return this._prop<number>('minZoom') ?? 0;
  }

  private _maxZoom(): number {
    return this._prop<number>('maxZoom') ?? 22;
  }

  private _interactive(): boolean {
    return this._prop<boolean>('interactive') !== false;
  }

  private _markers(): readonly MapMarker[] {
    return this._prop<readonly MapMarker[]>('markers') ?? [];
  }

  private _overlays(): readonly MapOverlay[] {
    return this._prop<readonly MapOverlay[]>('overlays') ?? [];
  }

  // --- geometry ------------------------------------------------------------

  /** The pane in logical pixels — the unit everything public here speaks.
   *  `contentBox()` is device, like everything core hands an element. */
  private _pane(): ScreenRect {
    const box = this.contentBox();
    const s = this._scale;
    return {
      x: box.x / s,
      y: box.y / s,
      width: box.width / s,
      height: box.height / s,
    };
  }

  private _visible(): boolean {
    const pane = this._pane();
    return pane.width > 0 && pane.height > 0;
  }

  camera(): MapCamera {
    const given = this._prop<MapCamera>('camera');
    return given ?? this._camera;
  }

  /** The camera resolved against the pane. */
  private _transform(camera = this.camera()): Transform {
    const pane = this._pane();
    return transformFor(
      camera,
      { width: pane.width, height: pane.height },
      DEFAULT_TILE_SIZE,
    );
  }

  /** Claim a logical rect as damage. */
  private _claim(rect: ScreenRect, reason: string): void {
    const s = this._scale;
    const x = Math.floor(toDevice(rect.x, s));
    const y = Math.floor(toDevice(rect.y, s));
    this.invalidate(
      false,
      {
        x,
        y,
        width: Math.ceil(toDevice(rect.x + rect.width, s)) - x,
        height: Math.ceil(toDevice(rect.y + rect.height, s)) - y,
      },
      reason,
    );
  }

  private _repaint(reason = 'content'): void {
    this.invalidate(false, this.abs, reason);
  }

  /**
   * Ask for another frame without asking for a repaint.
   *
   * There is no "call me next frame" on the element seam — damage is what
   * schedules a paint — so this claims a single pixel. That is the honest
   * claim for a frame whose only job is to continue a rasterization: the
   * tile being drawn is a second surface nobody is looking at, so *nothing
   * on screen changes* until it lands, and the one thing that does change
   * pixels claims its own box when it does.
   *
   * Claiming the pane instead repaints the whole map at the refresh rate
   * for the several frames a redraw takes. On X11 that is wasted work; on
   * the Cocoa backend, which paints many more frames a second, it is a
   * visible burst of repaints at the end of every zoom.
   */
  private _wake(reason = 'content'): void {
    const box = this.contentBox();
    this.invalidate(false, { x: box.x, y: box.y, width: 1, height: 1 }, reason);
  }

  // --- camera --------------------------------------------------------------

  /**
   * Move the camera.
   *
   * The one place the camera changes, so the controlled/uncontrolled fork,
   * the clamping, the notification and — the interesting part — the
   * decision between a blit and a repaint all live together.
   */
  private _applyCamera(next: MapCamera, blit = true): void {
    const previous = this.camera();
    const zoom = clamp(next.zoom, this._minZoom(), this._maxZoom());
    // Latitude is clamped to what Web Mercator can represent; longitude is
    // not, because the map wraps and a camera just past the antimeridian is
    // a camera in the next copy of the world.
    const camera: MapCamera = {
      center: { lon: next.center.lon, lat: clamp(next.center.lat, -85, 85) },
      zoom,
    };
    if (
      camera.zoom === previous.zoom &&
      camera.center.lon === previous.center.lon &&
      camera.center.lat === previous.center.lat
    ) {
      return;
    }
    if (this.props.camera === undefined) this._camera = camera;
    this._prop<(camera: MapCamera) => void>('onCameraChange')?.(camera);
    if (this._painting) return;
    // Every camera move defers rasterization, not just a pointer gesture.
    // An application animating a camera with `panBy` in a loop wants
    // exactly what a drag wants — composites while it moves, a sharpen when
    // it stops — and a single programmatic move only pays the settle delay,
    // which is a seventh of a second.
    this._touchGesture();
    if (Math.floor(camera.zoom) !== Math.floor(previous.zoom)) {
      // A new pyramid level: different tiles, different labels.
      this._labelKey = '';
    }
    if (!blit || !this._blitPan(previous, camera)) this._repaint('scroll');
  }

  /**
   * A pan is a scroll in every way but the bookkeeping, and react-x11#303
   * made the bookkeeping public: `scrollContents` claims the pane, arms the
   * frame to blit the band that survives, and narrows the claim to the
   * strip the shift exposed — which `paintDamage()` then hands to `paint`,
   * so the existing culling draws the sliver and nothing else.
   *
   * The attribution strip is pinned to the pane, so its pixels must not
   * ride the blit: its band is carved out of the region that shifts and
   * claimed the ordinary way. The blit gate tests foreign claims against
   * the *rect* (react-x11#309/#310), so a claim sitting edge to edge with
   * it leaves the frame a blit.
   *
   * Still a full repaint when the zoom moved (scaling is not a blit) or the
   * shift is fractional on the device grid — every real pan gesture is
   * whole device pixels, because that is how it came off the wire.
   */
  private _blitPan(previous: MapCamera, next: MapCamera): boolean {
    if (next.zoom !== previous.zoom) return false;
    const pane = this._pane();
    if (pane.width <= 0 || pane.height <= 0) return false;
    const before = this._transform(previous);
    const after = this._transform(next);
    if (before.world !== after.world) return false;
    const s = this._scale;
    // How far the *pixels* moved — the sense `Surface.copyWithin` uses,
    // which is the opposite of the camera's motion.
    const shiftX = toDevice((before.centerX - after.centerX) * before.world, s);
    const shiftY = toDevice((before.centerY - after.centerY) * before.world, s);
    const dx = Math.round(shiftX);
    const dy = Math.round(shiftY);
    if (dx === 0 && dy === 0) return true; // sub-pixel: nothing to show yet
    if (shiftX !== dx || shiftY !== dy) return false;

    const box = this.contentBox();
    const strip = Math.ceil(toDevice(this._attributionHeight(), s));
    const blit = {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height - strip,
    };
    if (blit.width < 64 * s || blit.height < 64 * s) return false;
    if (Math.abs(dx) >= blit.width || Math.abs(dy) >= blit.height) return false;
    this.scrollContents(blit, dx, dy);
    if (strip > 0) {
      this.invalidate(
        false,
        { x: box.x, y: blit.y + blit.height, width: box.width, height: strip },
        'scroll',
      );
    }
    return true;
  }

  /** Zoom about a point that must not move — the pointer under a wheel,
   *  the pane's centre for a key. */
  private _zoomAbout(delta: number, screenX: number, screenY: number): void {
    const camera = this.camera();
    const zoom = clamp(
      quantize(camera.zoom + delta),
      this._minZoom(),
      this._maxZoom(),
    );
    if (zoom === camera.zoom) return;
    const before = this._transform(camera);
    const anchor = unprojectPoint(before, screenX, screenY);
    const after = this._transform({ center: camera.center, zoom });
    // Where the anchor would land at the new zoom, and how far the centre
    // has to move so it lands where it already is.
    const moved = projectLngLat(after, anchor);
    const dx = (moved.x - screenX) / after.world;
    const dy = (moved.y - screenY) / after.world;
    this._applyCamera(
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

  /** Suspend rasterization for the length of a gesture, and arrange for it
   *  to resume. */
  private _touchGesture(): void {
    // Wall-clock here, not the budget clock: this is a 140 ms window, and
    // it is compared inside a timer callback.
    this._settleAt = Date.now() + SETTLE_MS;
    if (this._settleTimer !== null) return;
    const tick = (): void => {
      this._settleTimer = null;
      if (Date.now() < this._settleAt) {
        this._settleTimer = arm(tick);
        return;
      }
      // The gesture is over: sharpen. A wake-up, not a repaint — nothing
      // has moved since the last frame, so what is on screen is still
      // right; what is needed is a frame to start rasterizing in, and each
      // tile claims its own box as it lands.
      this._prop<(camera: MapCamera) => void>('onMoveEnd')?.(this.camera());
      this._wake('content');
    };
    this._settleTimer = arm(tick);
  }

  private get _gesturing(): boolean {
    return this._gesture !== null || Date.now() < this._settleAt;
  }

  // --- the imperative surface ----------------------------------------------

  getCamera(): MapCamera {
    const camera = this.camera();
    return { center: { ...camera.center }, zoom: camera.zoom };
  }

  setCamera(camera: Partial<MapCamera>): void {
    const current = this.camera();
    this._applyCamera(
      {
        center: camera.center ?? current.center,
        zoom: camera.zoom ?? current.zoom,
      },
      false,
    );
  }

  /** Move by a distance in pane-local logical pixels. */
  panBy(dx: number, dy: number): void {
    const transform = this._transform();
    this._applyCamera({
      zoom: transform.zoom,
      center: unprojectPoint(
        transform,
        transform.paneX + dx,
        transform.paneY + dy,
      ),
    });
  }

  zoomIn(step = 1): void {
    const pane = this._pane();
    this._zoomAbout(step, pane.width / 2, pane.height / 2);
  }

  zoomOut(step = 1): void {
    this.zoomIn(-step);
  }

  zoomTo(zoom: number): void {
    this.setCamera({ zoom });
  }

  fitBounds(
    bounds: LngLatBounds,
    options?: { padding?: number; maxZoom?: number },
  ): void {
    const pane = this._pane();
    if (pane.width <= 0 || pane.height <= 0) {
      // Asked before layout has run — which `fitBounds` in an effect always
      // is. Remembered and applied at the first paint that has a size.
      this._pendingFit = { bounds, options };
      return;
    }
    this._applyCamera(
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

  fitMarkers(
    ids?: readonly string[],
    options?: { padding?: number; maxZoom?: number },
  ): void {
    const wanted = ids ? new Set(ids) : null;
    const positions: LngLat[] = [];
    for (const marker of this._markers()) {
      if (wanted && !wanted.has(marker.id)) continue;
      positions.push(marker.position);
    }
    const bounds = boundsOf(positions);
    if (bounds) this.fitBounds(bounds, options);
  }

  getBounds(): LngLatBounds {
    return visibleBounds(this._transform());
  }

  project(position: LngLat): { x: number; y: number } {
    return projectLngLat(this._transform(), position);
  }

  unproject(x: number, y: number): LngLat {
    return unprojectPoint(this._transform(), x, y);
  }

  markerAt(x: number, y: number): MapMarker | null {
    return markerAt(this._markers(), this._transform(), x, y);
  }

  refresh(): void {
    this._cache.invalidateStyle();
    this._labelKey = '';
    this._repaint('content');
  }

  stats(): MapFrameStats | null {
    return this._stats;
  }

  private _pendingFit: {
    bounds: LngLatBounds;
    options?: { padding?: number; maxZoom?: number };
  } | null = null;

  // --- painting ------------------------------------------------------------

  /** How tall the attribution strip is, in logical pixels — 0 when there is
   *  nothing to say. Read by the blit as well as the paint, so the band it
   *  carves out and the band that is drawn are one number. */
  private _attributionHeight(): number {
    return this._attributionText() ? 16 : 0;
  }

  private _attributionText(): string {
    const given = this._prop<string>('attribution');
    if (given !== undefined) return given;
    const parts: string[] = [];
    for (const source of this._sources()) {
      if (source.attribution && !parts.includes(source.attribution)) {
        parts.push(source.attribution);
      }
    }
    return parts.join(' · ');
  }

  /** How large a tile is rasterized, and how many surface pixels one
   *  logical pixel is — the pair the rasterizer needs, and the pair that
   *  keeps a road two logical pixels wide at every fractional zoom. */
  private _rasterPlan(
    entry: TileCoverEntry,
    pyramid: { minZoom: number; maxZoom: number; tileSize: number },
    zoom: number,
  ): { size: number; pixelsPerLogical: number } {
    const scale = this._prop<number>('rasterScale') ?? this._scale;
    // The cover level, not the source's: past the source's own depth the
    // cover synthesizes tiles, and each is rasterized at its own natural
    // size rather than as a slice of a stretched one.
    const raster = rasterFor(
      zoom,
      entry.tile.z,
      { ...pyramid, maxZoom: pyramid.maxZoom + MAX_OVERZOOM },
      scale,
      MAX_RASTER,
    );
    return { size: raster.size, pixelsPerLogical: raster.size / entry.size };
  }

  private _makeSurface(size: number): SurfaceLike | null {
    try {
      return new Surface(this.app, {
        width: size,
        height: size,
      }) as SurfaceLike;
    } catch {
      // A backend with no offscreen surface — the headless mock. The map
      // then draws its background, its overlays and its markers and no
      // basemap, which is the same posture `src/terminal/vt/` takes when
      // there is no pixel API: degrade, never throw.
      return null;
    }
  }

  override paint(ctx: Context2D): void {
    const damage = this.paintDamage();
    super.paint(ctx);
    if (!this._visible() || !isMapCanvas(ctx)) return;

    const started = now();
    this._painting = true;
    const scale = this._scale;
    this._frameClip = damage
      ? {
          x: damage.x / scale,
          y: damage.y / scale,
          width: damage.width / scale,
          height: damage.height / scale,
        }
      : null;

    if (this._pendingFit) {
      const { bounds, options } = this._pendingFit;
      this._pendingFit = null;
      this._painting = false;
      this.fitBounds(bounds, options);
      this._painting = true;
    }

    const pane = this._pane();
    const camera = this.camera();
    const transform = this._transform(camera);
    const style = this._style();
    const frame = this._cache.beginFrame();
    const stats: MapFrameStats = {
      rasterMs: 0,
      drawMs: 0,
      tiles: 0,
      ready: 0,
      fromAncestor: 0,
      fromDescendant: 0,
      pending: 0,
      labels: 0,
      errors: 0,
      surfaceBytes: 0,
      damage: damage ? { ...damage } : null,
      draw: { features: 0, vertices: 0, decimated: 0, culled: 0, batches: 0 },
    };

    ctx.save();
    ctx.beginPath();
    const box = this.contentBox();
    // **The damage rect, not just the pane.**
    //
    // Everything below draws in pane coordinates — a tile at its own box,
    // the whole label layer, every overlay and marker, the attribution —
    // and a partial frame must not put any of it outside the rect it
    // claimed. Core presents the claimed region; pixels drawn beyond it
    // reach the backing store without reaching the screen, and the two
    // then disagree until something repaints the lot. That is what a
    // stale strip of the *previous style* surviving a theme switch is,
    // and why an app switch or a window drag clears it: those force a
    // full expose, which presents everything.
    //
    // It is also most of the cost of a wake frame. A frame that only
    // continues a rasterization claims one pixel and used to redraw every
    // label and marker on the map into it.
    const clip = this._frameClip
      ? intersectRects(box, this._deviceRect(this._frameClip))
      : box;
    if (!clip) {
      this._painting = false;
      this._frameClip = null;
      return;
    }
    ctx.rect(clip.x, clip.y, clip.width, clip.height);
    ctx.clip();

    // The style's background under everything: it is what the parts of the
    // world with no tile yet look like, so it is most of what a map looks
    // like while it loads.
    const background =
      (this.style.backgroundColor as string | undefined) ??
      this._preparedBackground();
    if (background) {
      ctx.fillStyle = background;
      const region = this._frameClip
        ? this._deviceRect(this._frameClip)
        : { x: box.x, y: box.y, width: box.width, height: box.height };
      ctx.fillRect(region.x, region.y, region.width, region.height);
    }

    // Rasterization is suspended for the length of a gesture, so a drag or
    // a wheel is composites only. `rasterBudgetMs` bounds the rest.
    const budget = this._gesturing
      ? 0
      : (this._prop<number>('rasterBudgetMs') ?? 8);
    const deadline = started + budget;
    this._rastered = false;

    const sources = this._sources();
    for (let i = 0; i < sources.length; i++) {
      this._paintSource(
        ctx,
        sources[i],
        this._sourceId(sources[i], i),
        transform,
        pane,
        style,
        stats,
        budget > 0,
        deadline,
      );
    }

    this._paintLabels(ctx, transform, pane, style, stats);

    const palette = this._palette();
    drawOverlays(ctx, this._overlays(), transform, pane, scale, palette);
    drawMarkers(ctx, this._markers(), transform, pane, scale, palette);
    this._paintAttribution(ctx, pane, palette);

    ctx.restore();
    this._cache.sweep();
    stats.surfaceBytes = this._cache.surfaceBytes;
    stats.drawMs = now() - started - stats.rasterMs;
    this._stats = stats;
    this._painting = false;
    this._frameClip = null;
    void frame;
    this._prop<(stats: MapFrameStats) => void>('onFrame')?.(stats);

    // Tiles left to rasterize: come back next frame and spend another
    // budget on them. This is the whole of the progressive fill-in.
    //
    // Only when a next frame could make progress. With no budget — during a
    // gesture, or because an application pinned `rasterBudgetMs` to 0 — the
    // next frame would draw exactly this one again, and asking for it is a
    // spin. The gesture's own settle timer is what brings the map back.
    //
    // And the claim is **one pixel**, not the pane. A frame that only
    // continues a rasterization changes nothing on screen — the tile being
    // drawn is a second surface nobody is looking at — so claiming the pane
    // asks the renderer to repaint the whole map, at the refresh rate, for
    // the several frames a redraw takes. On X11 that is wasted work; on the
    // Cocoa backend, which paints many more frames a second, it is a
    // visible burst of repaints at the end of every zoom. The one thing
    // that *does* change pixels is a tile finishing, and that claims its
    // own box above.
    if (stats.pending > 0 && budget > 0) this._wake('content');

    if (!this._sceneAnnounced) {
      this._sceneAnnounced = true;
      this.notifyA11ySceneChanged();
    }
  }

  private _preparedBackground(): string | undefined {
    const given = this._prop<MapStyle>('mapStyle');
    if (given) return given.background;
    this._style(); // builds `_defaultStyle` on the first paint
    return this._defaultStyle?.background;
  }

  private _deviceRect(rect: ScreenRect): ScreenRect {
    const s = this._scale;
    const x = Math.floor(rect.x * s);
    const y = Math.floor(rect.y * s);
    return {
      x,
      y,
      width: Math.ceil((rect.x + rect.width) * s) - x,
      height: Math.ceil((rect.y + rect.height) * s) - y,
    };
  }

  private _paintSource(
    ctx: MapCanvas,
    source: MapSource,
    sourceId: string,
    transform: Transform,
    pane: ScreenRect,
    style: PreparedStyle,
    stats: MapFrameStats,
    /** False for the length of a gesture, when nothing is rasterized. */
    mayRaster: boolean,
    deadline: number,
  ): void {
    const scale = this._scale;
    const p = pyramid(source);
    // The cover goes **deeper than the source cuts**, up to
    // `MAX_OVERZOOM` levels past it, and the data for those tiles comes
    // from their ancestor at the deepest cut level. That is what makes an
    // overzoomed map sharp: instead of one tile rasterized onto a surface
    // and stretched sixty-four times, there are two hundred and fifty-six
    // tiles sharing one fetch, each drawn at its own natural size, with
    // detail limited by the data rather than by a bitmap.
    const cover = tileCover(
      { ...transform, zoom: transform.zoom },
      { ...p, maxZoom: p.maxZoom + MAX_OVERZOOM },
      COVER_PADDING,
    );
    const zoom = transform.zoom;
    const styleZoom = Math.floor(zoom);
    const progressive = this._prop<boolean>('progressive') === true;
    for (const entry of cover) {
      const box = {
        x: pane.x + entry.x,
        y: pane.y + entry.y,
        width: entry.size,
        height: entry.size,
      };
      // Two different questions, and conflating them was a bug worth
      // spelling out. **Whether to work on a tile** is about the pane: the
      // cover is padded, so some of it is off screen and those tiles are
      // wanted (so they load) but never drawn. **Whether to composite it**
      // is about this pass's damage rect, which may be far smaller —
      // including the deliberately tiny claim a rasterization continuation
      // makes, which must still let the rasterizer run.
      const onScreen = rectsOverlap(box, pane);
      const inPass =
        this._frameClip === null || rectsOverlap(box, this._frameClip);
      const cached = this._cache.want(
        source,
        sourceId,
        entry.tile,
        dataTileFor(entry.tile, p.maxZoom),
        subTileOf(entry.tile, p.maxZoom),
      );
      if (!onScreen) continue;
      stats.tiles++;
      if (cached.status === 'error') stats.errors++;

      if (cached.status === 'ready') {
        const plan = this._rasterPlan(entry, p, zoom);
        const size = cached.raster ? cached.raster.width : plan.size;
        const drawing = this._cache.beginRender(
          cached,
          size,
          cached.raster ? 0 : styleZoom,
          (edge: number) => this._makeSurface(edge),
        );
        if (drawing && drawing.progress !== -1) {
          if (cached.raster) {
            this._uploadRaster(cached, drawing);
          } else if (mayRaster && (!this._rastered || now() < deadline)) {
            // **At least one tile per frame, whatever the budget.** A
            // budget smaller than one unit of work is not "do less", it is
            // "do nothing" — and since the frame then still has tiles
            // pending it asks for another one, forever, at the refresh
            // rate. So the first tile of a frame ignores the deadline and
            // every tile after it respects it, which bounds a frame at one
            // tile's overrun and guarantees the map finishes.
            this._rasterize(
              cached,
              drawing,
              style,
              entry,
              plan,
              styleZoom,
              stats,
              deadline,
            );
          }
          // Finished this frame: the new picture replaces the old one, and
          // the swap is what the whole pair exists for — the tile never
          // goes blank between them. Claim the box it occupies, because
          // *that* is the pixel change this whole sequence of frames was
          // for; the frames before it claimed almost nothing.
          if (this._cache.promote(cached)) this._claim(box, 'content');
        }
        // "Pending" means *there is work left that this map could still
        // do*, and nothing weaker — because `paint` asks for another frame
        // while it is non-zero. A tile whose surface could not be made (a
        // backend that has none) never becomes drawable, and counting it
        // would spin the frame clock at the refresh rate forever,
        // repainting a map that cannot change.
        if (cached.drawing) stats.pending++;
      }

      // What is composited is `shown`, which is **finished by
      // construction** — a rendering only becomes `shown` when its last
      // style run is done. So a tile appears whole rather than as water,
      // then landuse, then road casings, then roads over a dozen frames,
      // and a *re*-rasterization does not blank it either: the previous
      // picture stays up until the new one is ready to replace it.
      //
      // `progressive` composites the draft instead, which is the old
      // behaviour and is honest about what the renderer is doing.
      const showing =
        progressive && cached.drawing ? cached.drawing : cached.shown;
      if (showing) {
        if (!inPass) continue;
        this._composite(
          ctx,
          showing.surface,
          showing.size,
          box,
          pane,
          scale,
          0,
          0,
          1,
        );
        stats.ready++;
        continue;
      }
      // Nothing of this tile yet — a first load, which no buffering can
      // help. Borrow the ancestor that is already drawn, scaled up: that is
      // the difference between a map that fills in and one that flashes
      // empty on every zoom.
      if (!inPass) continue;

      // Nothing of this tile yet — a first load, which no buffering can
      // help. Two ways to cover it, and which is available says which way
      // the camera moved.
      //
      // **Zooming in**, the tile already in hand is this one's *ancestor*:
      // one composite, scaled up, blurry but complete. **Zooming out**, the
      // tiles in hand are its *descendants*: several composites, scaled
      // down, sharp but only as complete as the pieces that are cached.
      // Only the first of those existed at first, so a zoom out showed the
      // background — with the labels and the markers still drawn over it —
      // until the coarser tile had been fetched, rasterized and composited.
      //
      // Descendants win when they cover the whole square, because they are
      // sharper and they are the level the user is coming *from*; the
      // ancestor wins when they do not, because a complete blurry picture
      // beats a sharp one with holes in it.
      const kids = this._cache.descendantsWithSurface(sourceId, entry.tile);
      const covered =
        kids.length > 0 && kids.length === kids[0].span * kids[0].span;
      const ancestor = covered
        ? null
        : this._cache.ancestorWithSurface(sourceId, entry.tile);
      if (ancestor?.shown) {
        const up = entry.tile.z - ancestor.tile.z;
        const span = 1 << up;
        const fx = entry.tile.x - (ancestor.tile.x << up);
        const fy = entry.tile.y - (ancestor.tile.y << up);
        this._composite(
          ctx,
          ancestor.shown.surface,
          ancestor.shown.size,
          box,
          pane,
          scale,
          fx,
          fy,
          span,
        );
        stats.fromAncestor++;
      } else if (kids.length > 0) {
        for (const kid of kids) {
          const piece = entry.size / kid.span;
          this._composite(
            ctx,
            kid.entry.shown!.surface,
            kid.entry.shown!.size,
            {
              x: box.x + kid.x * piece,
              y: box.y + kid.y * piece,
              width: piece,
              height: piece,
            },
            pane,
            scale,
            0,
            0,
            1,
          );
        }
        stats.fromDescendant++;
      }
    }
  }

  /**
   * Rasterize as much of a tile as the budget allows, run by run.
   *
   * `progress` is where it stopped, so the next frame carries on. Layers
   * are painted bottom-up, so a tile stopped part-way looks like a map
   * whose upper layers have not arrived rather than like a hole.
   */
  private _rasterize(
    cached: CachedTile,
    render: TileRender,
    style: PreparedStyle,
    entry: TileCoverEntry,
    plan: { size: number; pixelsPerLogical: number },
    styleZoom: number,
    stats: MapFrameStats,
    deadline: number,
  ): void {
    const vector = cached.vector;
    if (!vector) return;
    const context = render.context;
    if (!isMapCanvas(context)) {
      // No path API on this surface: call it finished and empty rather than
      // asking again every frame.
      render.progress = -1;
      return;
    }
    const started = now();
    this._rastered = true;
    const pixels = plan.pixelsPerLogical;
    this._scratch.resetStats();
    // Where the **data** tile's square lands on this surface. When the
    // cover has gone deeper than the source cuts, this tile is one cell of
    // a `span × span` grid over that square, so the square is `span` times
    // the surface and starts `sub.x` surfaces to the left of it. Everything
    // outside the surface is clipped by the surface itself, and the cull
    // below stops it being drawn at all.
    const sub = cached.sub;
    const span = render.size * sub.span;
    const draw = {
      ox: -sub.x * render.size,
      oy: -sub.y * render.size,
      span,
      pixelsPerLogical: pixels,
      zoom: styleZoom,
      // A vertex closer than two-thirds of a pixel to the last one kept
      // says nothing; a feature under a pixel and a half is not worth a
      // path. Both are in surface pixels, which is why they are scaled.
      tolerance: 0.65 * pixels,
      minFeature: 1.5 * pixels,
      batchVertices: this._batchVertices(),
      // The surface, in its own coordinates. Only meaningful when this is
      // one cell of a larger square — and then it is what stops each of the
      // cells re-drawing the whole tile's features, which would make an
      // overzoomed frame cost `span²` times what it should.
      clip:
        sub.span > 1
          ? { x: 0, y: 0, width: render.size, height: render.size }
          : null,
    };
    let run = render.progress;
    let layer = render.progressLayer;
    while (run < style.runs.length) {
      const stoppedAt = drawTileRun(
        context,
        vector,
        style,
        run,
        draw,
        this._scratch,
        {
          fromLayer: layer,
          deadline,
        },
      );
      if (stoppedAt >= 0) {
        // The budget ran out inside the run; come back to the same run at
        // the layer after the one that crossed it.
        layer = stoppedAt;
        break;
      }
      run++;
      layer = 0;
      if (now() >= deadline) break;
    }
    this._cache.advance(render, run, layer, style);
    const drawn = this._scratch.stats;
    stats.draw.features += drawn.features;
    stats.draw.vertices += drawn.vertices;
    stats.draw.decimated += drawn.decimated;
    stats.draw.culled += drawn.culled;
    stats.draw.batches += drawn.batches;
    stats.rasterMs += now() - started;
  }

  /**
   * How large a path to accumulate before flushing it.
   *
   * One number for both backends, which it was not until react-x11 2.6.1.
   * Before it, the two rasterizers wanted opposite things — X11 turns a
   * fill into one a8 coverage mask upload, so a bigger path is fewer
   * uploads over the same pixels, while `CGContextStrokePath` was quadratic
   * in the number of subpaths — and this element probed the backend and
   * picked 512 or 12,000. Core chunks a Cocoa stroke itself now
   * (react-x11#457), at a size it can choose and a caller cannot, so
   * batching small on that backend only defeats it: on the profiling corpus
   * 12,000 measures 114 ms against 512's 142 ms at zoom 8, and 96 against
   * 101 at zoom 12.
   *
   * The prop stays, because the number is still a real X11 trade.
   */
  private _batchVertices(): number {
    return this._prop<number>('batchVertices') ?? BATCH_VERTICES;
  }

  private _uploadRaster(cached: CachedTile, render: TileRender): void {
    const raster = cached.raster;
    if (!raster) return;
    const context = render.context;
    if (isMapCanvas(context) && context.putImageData) {
      context.putImageData(raster, 0, 0);
    }
    render.progress = -1;
  }

  /**
   * Composite one tile's surface, clipped to the pane.
   *
   * Two things this has to get right, and they pull in different
   * directions.
   *
   * **The destination edges are rounded independently**, so two tiles that
   * share an edge round it to the same device pixel and abut exactly. Round
   * the origin and the size instead and adjacent tiles differ by a pixel
   * wherever the fractional zoom lands, which draws a grid of hairlines
   * across the map — the classic tiled-renderer seam.
   *
   * **And the destination is clipped before it is handed over**, because
   * XRender takes composite coordinates as **int16** and an overzoomed tile
   * is far larger than the pane: at zoom 22 against a pyramid that stops at
   * 14, one tile is `512 · 2^8` = 131,072 logical pixels across, so a tile
   * that overlaps the pane can start 73,000 pixels outside it. Unclipped
   * that is a `RangeError` from `x11/lib/ext/render.js` thrown inside
   * `paint`, which is the same shape of bug as the unclipped overlay and a
   * different limit — 32,767 rather than the stroke path's 16.16 fixed
   * point. Clipping the destination and moving the source rectangle to
   * match keeps the scale factor `sw/dw` exactly what it was, so nothing
   * about the picture changes.
   */
  private _composite(
    ctx: MapCanvas,
    surface: SurfaceLike,
    size: number,
    /** Where it lands, in pane-local logical pixels. */
    dest: ScreenRect,
    pane: ScreenRect,
    scale: number,
    /** Which sub-square of the surface to take, in `subSpan`ths. */
    subX: number,
    subY: number,
    subSpan: number,
  ): void {
    if (!ctx.drawImage || size <= 0) return;
    const x0 = Math.round((pane.x + dest.x) * scale);
    const y0 = Math.round((pane.y + dest.y) * scale);
    const x1 = Math.round((pane.x + dest.x + dest.width) * scale);
    const y1 = Math.round((pane.y + dest.y + dest.height) * scale);
    if (x1 <= x0 || y1 <= y0) return;

    // The clip is the content box — device pixels, like everything core
    // hands an element — so what survives is bounded by the window.
    const box = this.contentBox();
    const cx0 = Math.max(x0, Math.floor(box.x));
    const cy0 = Math.max(y0, Math.floor(box.y));
    const cx1 = Math.min(x1, Math.ceil(box.x + box.width));
    const cy1 = Math.min(y1, Math.ceil(box.y + box.height));
    if (cx1 <= cx0 || cy1 <= cy0) return;

    const span = size / subSpan;
    // Source pixels per destination pixel. Preserved exactly by the
    // clipping below, which is what keeps the composite's scale right.
    const kx = span / (x1 - x0);
    const ky = span / (y1 - y0);
    const sx = subX * span + (cx0 - x0) * kx;
    const sy = subY * span + (cy0 - y0) * ky;
    // Clamped to the surface: a rounding of the destination edges must not
    // sample a pixel that is not there.
    const sw = Math.min((cx1 - cx0) * kx, size - sx);
    const sh = Math.min((cy1 - cy0) * ky, size - sy);
    if (!(sw > 0) || !(sh > 0)) return;
    ctx.drawImage(surface, sx, sy, sw, sh, cx0, cy0, cx1 - cx0, cy1 - cy0);
  }

  /**
   * Place the labels if the placement is stale, then draw the ones on
   * screen.
   *
   * The placement is keyed on the zoom and the cache generation, and *not*
   * on the camera position — which is the whole reason it is computed in
   * world pixels. A pan reuses it and blits; a zoom recomputes it, and a
   * zoom is already a full repaint. A tile arriving clears the key from
   * `onChange`, which is the only other thing that can change who wins.
   */
  private _paintLabels(
    ctx: MapCanvas,
    transform: Transform,
    pane: ScreenRect,
    style: PreparedStyle,
    stats: MapFrameStats,
  ): void {
    const fonts = (this.app as { fonts?: FontsLike } | undefined)?.fonts;
    if (!fonts) return; // headless: nothing to shape with
    const text = this.resolvedTextStyle();
    const family =
      this._prop<MapStyle>('mapStyle')?.fontFamily ??
      this._defaultStyle?.fontFamily ??
      text.family;
    if (!this._shaper) {
      this._shaper = new LabelShaper(fonts, family, this._scale);
    } else {
      this._shaper.reconfigure(fonts, family, this._scale);
    }
    const key = `${quantize(transform.zoom)}|${this._cache.generation}`;
    if (key !== this._labelKey) {
      this._labelKey = key;
      const styleZoom = Math.floor(transform.zoom);
      // Labels come from the tile the **data** came from, at the depth that
      // source actually cuts — past which many renderings share one tile
      // and collecting per rendering would place every label `span²` times.
      const wanted = new Set(
        this._sources().map((source) =>
          Math.min(styleZoom, pyramid(source).maxZoom),
        ),
      );
      const candidates: LabelCandidate[] = [];
      for (const cached of this._cache.dataEntries()) {
        if (cached.status !== 'ready' || !cached.vector) continue;
        if (!wanted.has(cached.tile.z)) continue;
        const at = `${cached.key}|${styleZoom}`;
        let found = this._candidates.get(at);
        if (!found) {
          found = collectLabels(
            cached.vector,
            cached.tile,
            style,
            styleZoom,
            this._geometry,
          );
          // Bounded the way the shaper's cache is: a map panned across a
          // continent must not turn this into a leak, and rebuilding a
          // tile's candidates is one walk over its symbol layers.
          if (this._candidates.size > 512) this._candidates.clear();
          this._candidates.set(at, found);
        }
        for (const candidate of found) candidates.push(candidate);
      }
      this._labels = placeLabels(candidates, transform.world, this._shaper);
    }
    stats.labels = drawLabels(
      ctx,
      this._labels,
      transform,
      pane,
      this._scale,
      this._frameClip ? { ...this._frameClip } : null,
      this._shaper,
    );
  }

  /**
   * The attribution.
   *
   * Drawn by the map rather than left to the application because for open
   * data it is a licence condition rather than a nicety, and a component
   * whose default quietly omitted it would put every application that used
   * it in breach. `attribution=""` is the way to say it has been put
   * somewhere else.
   */
  private _paintAttribution(
    ctx: MapCanvas,
    pane: ScreenRect,
    palette: OverlayPalette,
  ): void {
    const text = this._attributionText();
    if (!text || !this._shaper) return;
    const shaped = this._shaper.shape(text, 9, palette.text);
    if (!shaped) return;
    const scale = this._scale;
    const padding = 4;
    const width = shaped.width + padding * 2;
    const height = shaped.height + padding;
    const x = pane.x + pane.width - width;
    const y = pane.y + pane.height - height;
    ctx.save();
    if (ctx.globalAlpha !== undefined) ctx.globalAlpha = 0.72;
    ctx.fillStyle = palette.background;
    ctx.fillRect(
      Math.round(x * scale),
      Math.round(y * scale),
      Math.ceil(width * scale),
      Math.ceil(height * scale),
    );
    if (ctx.globalAlpha !== undefined) ctx.globalAlpha = 1;
    shaped.layout.draw(
      ctx,
      Math.round((x + padding) * scale),
      Math.round((y + padding / 2) * scale),
    );
    ctx.restore();
  }

  // --- behaviour -----------------------------------------------------------

  /** An event's position in the pane's own logical pixels. A synthetic
   *  event's `x`/`y` are logical and relative to the window, so only the
   *  pane's own origin has to come off. */
  private _point(ev: MouseEvent): { x: number; y: number } {
    const pane = this._pane();
    return { x: ev.x - pane.x, y: ev.y - pane.y };
  }

  private _pointerEvent(
    ev: MouseEvent,
    marker: MapMarker | null,
  ): MapPointerEvent {
    const point = this._point(ev);
    return {
      lngLat: unprojectPoint(this._transform(), point.x, point.y),
      x: point.x,
      y: point.y,
      marker,
      shiftKey: ev.shiftKey ?? false,
      ctrlKey: ev.ctrlKey ?? false,
      altKey: ev.altKey ?? false,
      metaKey: ev.metaKey ?? false,
      button: ev.button ?? 1,
    };
  }

  override defaultMouseDown(ev: MouseEvent): void {
    const point = this._point(ev);
    const marker = markerAt(
      this._markers(),
      this._transform(),
      point.x,
      point.y,
    );
    if (marker) {
      this._gesture = {
        kind: 'marker',
        id: marker.id,
        startX: point.x,
        startY: point.y,
      };
      ev.capturePointer?.();
      return;
    }
    if (!this._interactive()) {
      // Not a pan, but still a press: the release is what makes a click,
      // and an application listening for one on a frozen map should get it.
      this._gesture = {
        kind: 'pan',
        startX: point.x,
        startY: point.y,
        lastX: point.x,
        lastY: point.y,
        moved: false,
      };
      ev.capturePointer?.();
      return;
    }
    this._gesture = {
      kind: 'pan',
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      moved: false,
    };
    this.focus();
    ev.capturePointer?.();
  }

  override defaultMouseDrag(ev: MouseEvent): void {
    const gesture = this._gesture;
    if (!gesture || gesture.kind !== 'pan') return;
    if (!this._interactive()) return;
    const point = this._point(ev);
    if (
      !gesture.moved &&
      Math.abs(point.x - gesture.startX) < DRAG_THRESHOLD &&
      Math.abs(point.y - gesture.startY) < DRAG_THRESHOLD
    ) {
      return;
    }
    gesture.moved = true;
    // Whole device pixels, because that is what the blit can shift — a
    // fractional pan would decline it every frame and repaint the pane.
    const scale = this._scale;
    const dx = Math.round((point.x - gesture.lastX) * scale) / scale;
    const dy = Math.round((point.y - gesture.lastY) * scale) / scale;
    if (dx === 0 && dy === 0) return;
    gesture.lastX += dx;
    gesture.lastY += dy;
    this._touchGesture();
    this.panBy(-dx, -dy);
  }

  override defaultMouseUp(ev: MouseEvent): void {
    const gesture = this._gesture;
    this._gesture = null;
    if (!gesture) return;
    const point = this._point(ev);
    if (gesture.kind === 'marker') {
      const marker = this._markers().find((m) => m.id === gesture.id);
      if (
        marker &&
        Math.abs(point.x - gesture.startX) < DRAG_THRESHOLD &&
        Math.abs(point.y - gesture.startY) < DRAG_THRESHOLD
      ) {
        const event = this._pointerEvent(ev, marker);
        this._prop<(m: MapMarker, e: MapPointerEvent) => void>(
          'onMarkerClick',
        )?.(marker, event);
        this._prop<(e: MapPointerEvent) => void>('onMapClick')?.(event);
      }
      return;
    }
    if (gesture.moved) {
      this._touchGesture();
      return;
    }
    this._prop<(e: MapPointerEvent) => void>('onMapClick')?.(
      this._pointerEvent(ev, null),
    );
  }

  override defaultMouseMove(ev: MouseEvent): void {
    const notify =
      this._prop<(m: MapMarker | null, e: MapPointerEvent | null) => void>(
        'onMarkerHover',
      );
    if (!notify) return;
    const point = this._point(ev);
    const marker = markerAt(
      this._markers(),
      this._transform(),
      point.x,
      point.y,
    );
    const id = marker?.id ?? null;
    if (id === this._hover) return;
    this._hover = id;
    notify(marker, this._pointerEvent(ev, marker));
  }

  override defaultMouseLeave(): void {
    if (this._hover === null) return;
    this._hover = null;
    // No event: the pointer has left the map, so there is no position on it
    // to report and inventing one would be worse than saying so.
    this._prop<(m: MapMarker | null, e: MapPointerEvent | null) => void>(
      'onMarkerHover',
    )?.(null, null);
  }

  /**
   * The wheel is a zoom, not a scroll, so it is answered here rather than
   * through `canScroll`/`scrollBy` — the case react-x11's docs/extending.md
   * carves out. A zoom needs the point that must *not* move, which the
   * scroll chain never hands over.
   */
  override defaultWheel(ev: WheelEvent): void {
    if (!this._interactive()) return;
    const pane = this._pane();
    this._touchGesture();
    this._zoomAbout(
      -(ev.deltaY ?? 0) * WHEEL_ZOOM * 0.02,
      ev.x - pane.x,
      ev.y - pane.y,
    );
    // Consumed whether or not the zoom moved: a wheel over a map is never
    // meant for whatever is behind it.
    ev.preventDefault();
  }

  override defaultKeyDown(ev: KeyboardEvent): void {
    // `Node` declares the default actions optional — an element that has
    // no behaviour of its own simply has none — so calling up is an
    // optional call rather than a plain one.
    if (!this._interactive()) {
      super.defaultKeyDown?.(ev);
      return;
    }
    const pane = this._pane();
    const step = ev.shiftKey ? 200 : 60;
    switch (ev.keysym) {
      case 0xff51: // XK_Left
        this.panBy(-step, 0);
        break;
      case 0xff53: // XK_Right
        this.panBy(step, 0);
        break;
      case 0xff52: // XK_Up
        this.panBy(0, -step);
        break;
      case 0xff54: // XK_Down
        this.panBy(0, step);
        break;
      case 0x002b: // XK_plus
      case 0x003d: // XK_equal
      case 0xffab: // XK_KP_Add
        this._zoomAbout(1, pane.width / 2, pane.height / 2);
        break;
      case 0x002d: // XK_minus
      case 0xffad: // XK_KP_Subtract
        this._zoomAbout(-1, pane.width / 2, pane.height / 2);
        break;
      default:
        // Everything else goes to the base class, which is what keeps the
        // selection keys and Space/Enter-as-a-click working.
        super.defaultKeyDown?.(ev);
        return;
    }
    ev.preventDefault();
  }

  /**
   * What a screen reader meets.
   *
   * A map is one painted rectangle to an assistive technology, and its
   * markers are the only things in it that are *objects* rather than
   * cartography — so those are the scene, and the map itself carries the
   * camera in its description. Announcing every road would be worse than
   * announcing none.
   */
  override a11yScene(): A11ySceneItem[] {
    if (!this._visible()) return [];
    const transform = this._transform();
    const pane = this._pane();
    const scale = this._scale;
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

  override applyProps(
    next: Record<string, unknown>,
    prev: Record<string, unknown>,
  ): void {
    const before = prev ?? this.props;
    super.applyProps(next, prev);
    // Every one of these is in `selfDamagedProps`, so the commit claimed
    // nothing for them and this is the only claim there will be.
    if (next.mapStyle !== before.mapStyle) {
      this._prepared = null;
      this._preparedFrom = null;
      this._candidates.clear();
      this._cache.invalidateStyle();
      this._labelKey = '';
      this._repaint('props');
      return;
    }
    if (next.sources !== before.sources) {
      this._labelKey = '';
      this._repaint('props');
      return;
    }
    if (next.camera !== before.camera && next.camera !== undefined) {
      const camera = next.camera as MapCamera;
      const previous = (before.camera as MapCamera | undefined) ?? this._camera;
      if (
        camera.zoom !== previous.zoom ||
        camera.center.lon !== previous.center.lon ||
        camera.center.lat !== previous.center.lat
      ) {
        if (camera.zoom !== previous.zoom) this._labelKey = '';
        if (!this._blitPan(previous, camera)) this._repaint('props');
      }
      return;
    }
    if (next.markers !== before.markers || next.overlays !== before.overlays) {
      // The union of where they were and where they are. A vehicle moving
      // across a city claims two marker-sized boxes rather than the pane.
      this._claimOverlayDamage(
        (before.markers as readonly MapMarker[] | undefined) ?? [],
        (next.markers as readonly MapMarker[] | undefined) ?? [],
        next.overlays !== before.overlays,
      );
      this.notifyA11ySceneChanged();
    }
  }

  private _claimOverlayDamage(
    before: readonly MapMarker[],
    after: readonly MapMarker[],
    overlaysChanged: boolean,
  ): void {
    if (overlaysChanged || !this._visible()) {
      // An overlay is an arbitrary polyline; its damage is not worth
      // deriving, and a route changing is not a per-frame event.
      this._repaint('props');
      return;
    }
    const transform = this._transform();
    const pane = this._pane();
    const claim = (markers: readonly MapMarker[]): void => {
      for (const marker of markers) {
        const rect = markerRect(marker, transform);
        this._claim(
          {
            x: pane.x + rect.x - 3,
            y: pane.y + rect.y - 3,
            width: rect.width + 6,
            height: rect.height + 6,
          },
          'props',
        );
      }
    };
    // Both sets, because a marker that was removed has to be painted over.
    claim(before);
    claim(after);
  }

  override destroySubtree(): void {
    if (this._settleTimer !== null) {
      timers.clearTimeout?.(this._settleTimer);
      this._settleTimer = null;
    }
    this._cache.destroy();
    this._candidates.clear();
    this._labels = [];
    super.destroySubtree();
  }
}
