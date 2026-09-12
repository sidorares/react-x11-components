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
//  1. **Tile data**, keyed on the source object and `z/x/y`, and valid
//     forever. The object, not its `id` — see `./tiles.ts`.
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

import { MapController, quantizeZoom } from './controller.js';
import type {
  MapControllerProps,
  MapPointerInput,
  MapView,
} from './controller.js';
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
  dataSquareOf,
  dataTileFor,
  subTileOf,
  rasterFor,
  tileCover,
  tileKey,
  transformFor,
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
import { TileCache, drawnFor, pyramid } from './tiles.js';
import type { CachedTile, SurfaceLike, TileRender } from './tiles.js';
import { attributionOf } from './sources.js';
import type { MapSource } from './sources.js';
import { shortbreadStyle } from './styles.js';
import type { MapStyle } from './style.js';
import { isDarkTheme, overlayPalette } from './theme.js';
import {
  LabelShaper,
  collectLabels,
  drawLabels,
  placeLabels,
} from './labels.js';
import type { FontsLike, LabelCandidate, PlacedLabel } from './labels.js';
import {
  ATTRIBUTION_OPACITY,
  ATTRIBUTION_SIZE,
  attributionLayout,
  drawMarkers,
  drawOverlays,
  markerRect,
} from './overlay.js';
import type { MapMarker, MapOverlay, OverlayPalette } from './overlay.js';
import type { FitBoundsOptions, MapFrameStats } from './types.js';

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

/** Whether `outer` covers all of `inner`. */
function containsRect(outer: ScreenRect, inner: ScreenRect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function sameSources(
  a: readonly MapSource[],
  b: readonly MapSource[],
): boolean {
  return a.length === b.length && a.every((source, i) => source === b[i]);
}

/** A frame's stats as this renderer keeps them: every field, including the
 *  ones only it has. */
type RetainedFrameStats = MapFrameStats &
  Required<Pick<MapFrameStats, 'rasterMs' | 'surfaceBytes' | 'draw'>> & {
    damage: { x: number; y: number; width: number; height: number } | null;
  };

/** A tile of the cover that is in view, as a frame's work found it. */
interface VisibleTile {
  entry: TileCoverEntry;
  /** Where it lands, in pane-local logical pixels. */
  box: ScreenRect;
  cached: CachedTile;
}

/**
 * How long a restyle may keep the previous style up once the view moves,
 * in milliseconds the map was free to draw in.
 *
 * A still view is never cut short: its redraw is a fixed amount of work,
 * and the swap waits for all of it. A moving one can bring tiles into view
 * as fast as the old ones are finished — a pan with pauses in it, a camera
 * an application animates — and would never swap. So once the camera has
 * moved the wait is bounded, and a tile not yet redrawn when it runs out
 * shows the background until it is. Frames a gesture holds rasterization
 * off in do not count, since nothing is drawn in them.
 */
const RESTYLE_WAIT_MS = 1500;

/**
 * The previous style, held on screen while a restyle draws the new one.
 *
 * A `mapStyle` change or `refresh()` retires every tile surface at once,
 * and the redraw is budgeted — a dense tile is 50-140 ms against 8 ms a
 * frame — so it takes a second or more. A tile's own double buffer keeps
 * its old picture until its new one is done, which is right for a zoom and
 * wrong here: the map was a patchwork of both styles for that second, under
 * a background and labels that had already switched. So the whole previous
 * picture — the tiles of its generation, its background, its labels —
 * stays up until the view is redrawn, and is replaced in one frame.
 */
interface Outgoing {
  /** The cache generation on screen. Only its pictures are composited. */
  generation: number;
  /** The style background the last frame before the switch painted. */
  background: string | undefined;
  /**
   * The labels on screen, and what they were placed for and from — the
   * quantized zoom, the sources, their candidates and the face — kept
   * because the style that produced them is gone, or, after `refresh()`,
   * was edited in place. A zoom re-places them from the candidates; a
   * source taken off the map takes its names with it.
   */
  labels: PlacedLabel[];
  labelZoom: number;
  labelSources: readonly MapSource[];
  candidates: Map<MapSource, LabelCandidate[]>;
  family: string | undefined;
  /** The camera and the pane at the switch, and whether either has moved
   *  since — which is what makes {@link RESTYLE_WAIT_MS} apply. */
  view: string;
  moved: boolean;
  /** Milliseconds the map has been free to draw since the switch, and when
   *  the last frame that was began — `null` when the last frame was not. */
  waited: number;
  lastDrawn: number | null;
}

export class MapViewNode extends Node {
  private readonly _cache: TileCache;
  private readonly _scratch = new DrawScratch();
  private readonly _geometry = new GeometryBuffer();
  private _shaper: LabelShaper | null = null;

  /**
   * The camera and the gestures: the controller `<Map>` hands down, or this
   * element's own when it is used bare. Both of `<Map>`'s renderers answer
   * to one (`./controller.ts`), which is how a fallback from one to the
   * other keeps the camera and the handle.
   *
   * The camera being an object's rather than React state's is what makes a
   * pan cost nothing but a blit: a drag step moves two numbers and claims a
   * strip, and React is not involved at all. Routed through state instead,
   * every pointer step would be a render, a commit and a full-pane claim,
   * which is the shape `<Flow>` documents as "the content lags and catches
   * up".
   */
  private readonly _controller: MapController;
  private readonly _ownsController: boolean;
  /** This element, as its controller sees it. */
  private readonly _view: MapView;

  private _prepared: PreparedStyle | null = null;
  private _preparedFrom: MapStyle | null = null;
  private _defaultStyle: MapStyle | null = null;

  /** The placement, and what it was computed for. */
  private _labels: PlacedLabel[] = [];
  private _labelKey = '';
  /** …and what it was placed from, all of which a restyle holds on to (see
   *  {@link Outgoing}): the quantized zoom, the sources on the map, their
   *  candidates per source, and the face they were shaped in. */
  private _labelZoom = 0;
  private _labelSources: readonly MapSource[] = [];
  private _labelCandidates = new Map<MapSource, LabelCandidate[]>();
  private _shapedFamily: string | undefined;
  /** Candidates per tile, so a pan that brings a tile back does not redo
   *  the walk over its symbol layers. */
  private readonly _candidates = new Map<string, LabelCandidate[]>();

  /** The previous style while a restyle draws the new one behind it, or
   *  null when what is on screen is the current generation. */
  private _outgoing: Outgoing | null = null;
  /** The style background the last frame painted — what a restyle keeps
   *  painting. Remembered rather than recomputed, because `refresh()`
   *  follows an edit made to the very style object it would be read from. */
  private _paintedBackground: string | undefined;
  /** Whether a frame has been painted: before one, a restyle has no
   *  previous picture to hold. */
  private _painted = false;

  /** Whether any tile has been rasterized in the frame being painted — the
   *  forward-progress guarantee below. */
  private _rastered = false;
  private _frameClip: ScreenRect | null = null;
  private _stats: MapFrameStats | null = null;
  private _sceneAnnounced = false;

  constructor(props: Record<string, unknown>, app: unknown) {
    super(ELEMENT, props, app as ConstructorParameters<typeof Node>[2]);
    const given = props.mapController as MapController | undefined;
    // A bare element's own controller is seeded once: `defaultCamera` is
    // read here and never again, which is what makes it a *default* rather
    // than a second controlled prop. `<Map>` seeds the one it hands down.
    const seed = (props.camera ?? props.defaultCamera) as MapCamera | undefined;
    this._controller = given ?? new MapController(seed);
    this._ownsController = given === undefined;
    if (this._ownsController) {
      this._controller.setProps(props as MapControllerProps);
    }
    this._view = {
      pane: () => this._pane(),
      scale: () => this._scale,
      moved: (previous, next, blit) => {
        // A new pyramid level: different tiles, different labels.
        if (Math.floor(next.zoom) !== Math.floor(previous.zoom)) {
          this._labelKey = '';
        }
        if (!blit || !this._blitPan(previous, next)) this._repaint('scroll');
      },
      // The gesture is over: sharpen. A wake-up, not a repaint — nothing has
      // moved since the last frame, so what is on screen is still right;
      // what is needed is a frame to start rasterizing in, and each tile
      // claims its own box as it lands.
      settled: () => this._wake('content'),
      refresh: () => this._restyle(),
      stats: () => this._stats,
      focus: () => this.focus(),
    };
    this._controller.attach(this._view);
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
          sourceId: entry.sourceId,
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
    return isDarkTheme(this.theme);
  }

  private _palette(): OverlayPalette {
    return overlayPalette(this.theme);
  }

  private _sources(): MapSource[] {
    const given = this._prop<readonly MapSource[]>('sources');
    return given ? [...given] : [];
  }

  /** What a source is called in its requests and its errors. Not what its
   *  tiles are cached under — the cache files them under the object. */
  private _sourceId(source: MapSource, index: number): string {
    return source.id ?? `source-${index}`;
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
    return this._controller.camera();
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

  /** A gesture in flight, or the settle window after a camera move: while
   *  it lasts nothing is rasterized, so a drag or a wheel is composites
   *  only. The window is the controller's, and one for both renderers. */
  private get _gesturing(): boolean {
    return this._controller.gesturing;
  }

  // --- the imperative surface ----------------------------------------------
  //
  // The controller's, for an application holding the element itself rather
  // than `<Map>`'s handle.

  getCamera(): MapCamera {
    return this._controller.getCamera();
  }

  setCamera(camera: Partial<MapCamera>): void {
    this._controller.setCamera(camera);
  }

  /** Move by a distance in pane-local logical pixels. */
  panBy(dx: number, dy: number): void {
    this._controller.panBy(dx, dy);
  }

  zoomIn(step = 1): void {
    this._controller.zoomIn(step);
  }

  zoomOut(step = 1): void {
    this._controller.zoomOut(step);
  }

  zoomTo(zoom: number): void {
    this._controller.zoomTo(zoom);
  }

  fitBounds(bounds: LngLatBounds, options?: FitBoundsOptions): void {
    this._controller.fitBounds(bounds, options);
  }

  fitMarkers(ids?: readonly string[], options?: FitBoundsOptions): void {
    this._controller.fitMarkers(ids, options);
  }

  getBounds(): LngLatBounds {
    return this._controller.getBounds();
  }

  project(position: LngLat): { x: number; y: number } {
    return this._controller.project(position);
  }

  unproject(x: number, y: number): LngLat {
    return this._controller.unproject(x, y);
  }

  markerAt(x: number, y: number): MapMarker | null {
    return this._controller.markerAt(x, y);
  }

  refresh(): void {
    this._restyle();
  }

  /**
   * Retire every rendered tile — for a new `mapStyle`, or `refresh()` after
   * an edit made to the style in place. One path for both, and for anything
   * else that ever needs the map redrawn in a new look.
   *
   * The compiled style and the label candidates go with the tiles: both are
   * readings of the style, and `refresh()` exists because the object was
   * edited under them. What does not go is the picture on screen. Unless
   * there is none yet, or `progressive` asked to watch the repaint, it is
   * held as {@link Outgoing} until the new one is ready to replace it.
   *
   * True when it is held. Then nothing on screen changes yet, so the only
   * claim is the pixel that asks for a frame to start drawing in — and
   * anything else a commit changed has to claim its own damage.
   */
  private _restyle(): boolean {
    this._prepared = null;
    this._preparedFrom = null;
    this._candidates.clear();
    if (
      this._outgoing === null &&
      this._painted &&
      this._prop<boolean>('progressive') !== true
    ) {
      this._outgoing = {
        generation: this._cache.generation,
        background: this._paintedBackground,
        labels: this._labels,
        labelZoom: this._labelZoom,
        labelSources: this._labelSources,
        candidates: this._labelCandidates,
        family: this._shapedFamily,
        view: this._viewKey(this._transform(), this._pane()),
        moved: false,
        waited: 0,
        lastDrawn: null,
      };
    }
    this._cache.invalidateStyle();
    this._labelKey = '';
    if (this._outgoing === null) {
      this._repaint('props');
      return false;
    }
    this._wake('props');
    return true;
  }

  /** The camera and the pane, as a string that changes when either does. */
  private _viewKey(transform: Transform, pane: ScreenRect): string {
    return `${transform.centerX},${transform.centerY},${transform.zoom},${pane.width}x${pane.height}`;
  }

  stats(): MapFrameStats | null {
    return this._stats;
  }

  // --- painting ------------------------------------------------------------

  /** How tall the attribution strip is, in logical pixels — 0 when there is
   *  nothing to say. Read by the blit as well as the paint, so the band it
   *  carves out and the band that is drawn are one number. */
  private _attributionHeight(): number {
    return this._attributionText() ? 16 : 0;
  }

  private _attributionText(): string {
    return attributionOf(this._prop<string>('attribution'), this._sources());
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
    const scale = this._scale;
    this._frameClip = damage
      ? {
          x: damage.x / scale,
          y: damage.y / scale,
          width: damage.width / scale,
          height: damage.height / scale,
        }
      : null;

    // A fit asked for before layout had a size — `fitBounds` in an effect —
    // lands in the first frame that has one, and this frame draws it.
    this._controller.beginFrame();
    this._controller.painting = true;

    const pane = this._pane();
    const camera = this.camera();
    const transform = this._transform(camera);
    const style = this._style();
    const frame = this._cache.beginFrame();
    const stats: RetainedFrameStats = {
      renderer: 'retained',
      rasterMs: 0,
      drawMs: 0,
      tiles: 0,
      ready: 0,
      fromAncestor: 0,
      fromDescendant: 0,
      pending: 0,
      restyling: false,
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
      this._controller.painting = false;
      this._frameClip = null;
      return;
    }
    ctx.rect(clip.x, clip.y, clip.width, clip.height);
    ctx.clip();

    // Rasterization is suspended for the length of a gesture, so a drag or
    // a wheel is composites only. `rasterBudgetMs` bounds the rest.
    const budget = this._gesturing
      ? 0
      : (this._prop<number>('rasterBudgetMs') ?? 8);
    const deadline = started + budget;
    this._rastered = false;
    const progressive = this._prop<boolean>('progressive') === true;

    // **The work first, then the picture.** Every tile the cover wants is
    // asked for, and the ones in view are drawn as far as the budget goes —
    // into their own surfaces, so none of it is on screen yet. Which style
    // this frame shows is decided only after that, because it depends on
    // what the work just finished: a restyle swaps in the frame that finds
    // the view redrawn, and has to know before the first pixel goes down.
    const sources = this._sources();
    const holding = this._outgoing !== null && !progressive;
    const views: VisibleTile[][] = [];
    for (let i = 0; i < sources.length; i++) {
      views.push(
        this._workSource(
          sources[i],
          this._sourceId(sources[i], i),
          transform,
          pane,
          style,
          stats,
          budget > 0,
          deadline,
          holding,
        ),
      );
    }
    this._settleRestyle(
      transform,
      pane,
      stats,
      budget,
      started,
      !damage || containsRect(damage, box),
      progressive,
    );
    const outgoing = this._outgoing;
    stats.restyling = outgoing !== null;

    // The style's background under everything: it is what the parts of the
    // world with no tile yet look like, so it is most of what a map looks
    // like while it loads. The previous style's while a restyle holds it.
    const styleBackground = outgoing
      ? outgoing.background
      : this._preparedBackground();
    if (!outgoing) this._paintedBackground = styleBackground;
    const background =
      (this.style.backgroundColor as string | undefined) ?? styleBackground;
    if (background) {
      ctx.fillStyle = background;
      const region = this._frameClip
        ? this._deviceRect(this._frameClip)
        : { x: box.x, y: box.y, width: box.width, height: box.height };
      ctx.fillRect(region.x, region.y, region.width, region.height);
    }

    // Only pictures of the generation on screen are composited: the
    // previous style's while a restyle holds it up, the current one's
    // otherwise — so a tile last drawn before a switch is never shown in
    // the style the map was switched away from. `progressive` shows
    // whatever there is, which is its point.
    const generation = progressive
      ? undefined
      : (outgoing?.generation ?? this._cache.generation);
    for (let i = 0; i < sources.length; i++) {
      this._drawSource(
        ctx,
        sources[i],
        views[i],
        stats,
        progressive,
        generation,
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
    this._painted = true;
    this._controller.painting = false;
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

  /**
   * Whether this frame keeps showing the previous style or swaps in the new
   * one — see {@link Outgoing}.
   *
   * The swap waits for every tile in view that has data to have a finished
   * rendering in the new style, which is `pending` reaching zero: a tile
   * still loading has nothing to draw and does not hold it, and a tile that
   * is done waits for the rest rather than going up alone. It is made only
   * in a frame that repaints the whole pane, because a swap inside a partial
   * frame would leave the rest of the pane in the old style — so a frame
   * that finds the view redrawn but was clipped to its one pixel claims the
   * pane, and the next frame swaps. That is the one full-pane claim a
   * restyle makes.
   *
   * Or, once the view has moved, when {@link RESTYLE_WAIT_MS} of drawing
   * time has gone by, with whatever is left undrawn.
   */
  private _settleRestyle(
    transform: Transform,
    pane: ScreenRect,
    stats: RetainedFrameStats,
    budget: number,
    started: number,
    whole: boolean,
    progressive: boolean,
  ): void {
    const outgoing = this._outgoing;
    if (!outgoing) return;
    if (progressive) {
      // Turned on while a restyle was held: the opt-in holds nothing.
      this._swapStyle();
      if (!whole) this._repaint('content');
      return;
    }
    if (!outgoing.moved && this._viewKey(transform, pane) !== outgoing.view) {
      outgoing.moved = true;
    }
    // The clock runs across frames that could draw, two in a row, so the
    // gap a gesture made — which drew nothing — is not counted when the
    // next frame after it begins.
    if (budget > 0) {
      if (outgoing.lastDrawn !== null) {
        outgoing.waited += started - outgoing.lastDrawn;
      }
      outgoing.lastDrawn = started;
    } else {
      outgoing.lastDrawn = null;
    }
    const redrawn = stats.pending === 0;
    // Never by the clock in the middle of a gesture: nothing is drawn
    // during one, so the view would swap to holes it cannot fill until the
    // gesture ends.
    const overdue =
      budget > 0 && outgoing.moved && outgoing.waited >= RESTYLE_WAIT_MS;
    if (!redrawn && !overdue) return;
    if (whole) this._swapStyle();
    else this._repaint('content');
  }

  /** The new style goes on screen: every finished tile, its background and
   *  a label placement of its own, all in the frame being painted. */
  private _swapStyle(): void {
    this._outgoing = null;
    this._cache.swap();
    this._labelKey = '';
  }

  /**
   * A frame's work, for one source: want every tile of its cover, so that
   * each loads and stays cached, and draw the ones in view into their own
   * surfaces as far as the budget goes. Returns the ones in view, for
   * {@link _drawSource} to composite once the frame knows which style it is
   * showing.
   */
  private _workSource(
    source: MapSource,
    sourceId: string,
    transform: Transform,
    pane: ScreenRect,
    style: PreparedStyle,
    stats: RetainedFrameStats,
    /** False for the length of a gesture, when nothing is rasterized. */
    mayRaster: boolean,
    deadline: number,
    /** A restyle is holding the previous style up, so a tile that finishes
     *  waits for the swap rather than going on screen alone. */
    holding: boolean,
  ): VisibleTile[] {
    const p = pyramid(source);
    // The cover goes **deeper than the source cuts**, up to
    // `MAX_OVERZOOM` levels past it, and the data for those tiles comes
    // from their ancestor at the deepest cut level. That is what makes an
    // overzoomed map sharp: instead of one tile rasterized onto a surface
    // and stretched sixty-four times, there are two hundred and fifty-six
    // tiles sharing one fetch, each drawn at its own natural size, with
    // detail limited by the data rather than by a bitmap. That is vector
    // data. An image has no more detail than its pixels, so a raster tile
    // past the cut is drawn as the whole of its data tile instead — see
    // `_rasterSquares`.
    const cover = this._rasterSquares(
      source,
      sourceId,
      tileCover(
        { ...transform, zoom: transform.zoom },
        { ...p, maxZoom: p.maxZoom + MAX_OVERZOOM },
        COVER_PADDING,
      ),
      p.maxZoom,
    );
    const zoom = transform.zoom;
    const styleZoom = Math.floor(zoom);
    const visible: VisibleTile[] = [];
    for (const entry of cover) {
      // In the window's logical pixels, the space `pane` is in: what the
      // overlap tests below, the claim when the tile lands and `_composite`
      // all take. The pane's origin goes in here and nowhere after.
      const box = {
        x: pane.x + entry.x,
        y: pane.y + entry.y,
        width: entry.size,
        height: entry.size,
      };
      // Two different questions, and conflating them was a bug worth
      // spelling out. **Whether to work on a tile** is about the pane: the
      // cover is padded, so some of it is off screen and those tiles are
      // wanted (so they load) but never drawn. They are wanted on *every*
      // frame, however small its damage rect, because the cache's `sweep`
      // cancels any load a frame did not want. **Whether to composite it**
      // is about this pass's damage rect, which may be far smaller —
      // including the deliberately tiny claim a rasterization continuation
      // makes, which must still let the rasterizer run. The first is asked
      // here, and the second in `_drawSource`.
      const onScreen = rectsOverlap(box, pane);
      const cached = this._cache.want(
        source,
        sourceId,
        entry.tile,
        dataTileFor(entry.tile, p.maxZoom),
        subTileOf(entry.tile, p.maxZoom),
      );
      if (!onScreen) continue;
      visible.push({ entry, box, cached });
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
          // A raster tile is the provider's image, the same in every style.
          !cached.raster,
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
          //
          // Not while a restyle holds the previous style up, though: one
          // tile in the new style among the rest in the old is the
          // patchwork the hold is there to prevent. It waits, finished, for
          // `_swapStyle` to put the whole view up at once. A raster tile
          // does not wait — it is in no style, so it cannot make one.
          if ((!holding || !drawing.styled) && this._cache.promote(cached)) {
            this._claim(box, 'content');
          }
        }
        // "Pending" means *there is work left that this map could still
        // do*, and nothing weaker — because `paint` asks for another frame
        // while it is non-zero, and a restyle swaps when it reaches zero. A
        // tile whose surface could not be made (a backend that has none)
        // never becomes drawable, and counting it would spin the frame
        // clock at the refresh rate forever, repainting a map that cannot
        // change. A finished tile waiting for a restyle's swap has nothing
        // left to do either.
        if (cached.drawing && cached.drawing.progress !== -1) stats.pending++;
      }
    }
    return visible;
  }

  /**
   * The cover, with every **raster** tile past the source's depth drawn as
   * the whole of its data tile — once, however many of its cells there are.
   *
   * The cover goes deeper than the source cuts because that is what makes
   * vector data sharp there: each cell is rasterized from its data tile's
   * features, through the cell (`sub`, in `_rasterize`). An image has no
   * detail finer than its pixels and no drawing it through a cell: a raster
   * cell was drawn by uploading the image, all of it, so each cell showed
   * its data tile whole, shrunk into its own square. Past a raster source's
   * depth the map was a grid of miniatures of each tile — 2×2 one level
   * past, 4×4 two — and a 256px source is read a level deeper than the
   * view, so for `osmRasterSource`, which cuts at 19, that was every zoom
   * from 19 up.
   *
   * A raster map past its provider's depth draws the deepest images larger,
   * and so does this. The square is where the cover at the source's own
   * depth puts the data tile, and it is drawn from that tile's own surface —
   * the one the view at that depth draws, so crossing into overzoom uploads
   * nothing.
   *
   * Which kind a tile is, is known once its data is in. Until then a cell
   * stays a cell, and is covered from its neighbours in the pyramid like
   * any other hole. Asking is a `want`, which the frame's own pass repeats
   * for a cell kept here, and which is idempotent.
   */
  private _rasterSquares(
    source: MapSource,
    sourceId: string,
    cover: TileCoverEntry[],
    maxZoom: number,
  ): TileCoverEntry[] {
    // A cover is one level, so every entry in it is past the cut or none is.
    if (cover.length === 0 || cover[0].tile.z <= maxZoom) return cover;
    const out: TileCoverEntry[] = [];
    const squares = new Set<string>();
    for (const cell of cover) {
      const cached = this._cache.want(
        source,
        sourceId,
        cell.tile,
        dataTileFor(cell.tile, maxZoom),
        subTileOf(cell.tile, maxZoom),
      );
      if (!cached.raster) {
        out.push(cell);
        continue;
      }
      const square = dataSquareOf(cell, maxZoom);
      const key = `${square.worldCopy}:${tileKey(square.tile)}`;
      if (squares.has(key)) continue;
      squares.add(key);
      out.push(square);
    }
    return out;
  }

  /**
   * A frame's picture, for one source: composite each tile in view from its
   * own finished rendering or, for a tile with none, from a finished
   * ancestor or descendants. Only renderings of `generation` count, and
   * `undefined` counts any — which is `progressive`.
   */
  private _drawSource(
    ctx: MapCanvas,
    source: MapSource,
    visible: readonly VisibleTile[],
    stats: RetainedFrameStats,
    progressive: boolean,
    generation: number | undefined,
  ): void {
    const scale = this._scale;
    for (const { entry, box, cached } of visible) {
      const inPass =
        this._frameClip === null || rectsOverlap(box, this._frameClip);
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
      if (showing && drawnFor(showing, generation)) {
        if (!inPass) continue;
        this._composite(
          ctx,
          showing.surface,
          showing.size,
          box,
          scale,
          0,
          0,
          1,
        );
        stats.ready++;
        continue;
      }

      // Nothing of this tile to show — a first load, which no buffering can
      // help, or a picture in a style the map is not showing. Two ways to
      // cover it, and which is available says which way the camera moved.
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
      //
      // Looked up whether or not this pass draws the tile, because the
      // lookup is what stamps a piece as in use: a piece covering a hole is
      // on screen, and an unstamped entry is the first thing eviction takes
      // — which, in the one-pixel frames a redraw runs in, was every piece
      // but the one under that pixel. A restyle keeps such pieces on screen
      // for as long as its redraw takes.
      const kids = this._cache.descendantsWithSurface(
        source,
        entry.tile,
        undefined,
        generation,
      );
      const covered =
        kids.length > 0 && kids.length === kids[0].span * kids[0].span;
      const ancestor = covered
        ? null
        : this._cache.ancestorWithSurface(
            source,
            entry.tile,
            undefined,
            generation,
          );
      if (!inPass) continue;
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
    stats: RetainedFrameStats,
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
   *
   * **`dest` is already in the window's space**, the one `pane` is in — a
   * tile's `box` is `pane.x + entry.x` — so nothing is added to it here.
   * The pane's origin used to be added a second time, which drew every
   * tile that far right of and below where the markers, labels and
   * overlays put the same place. A constant offset on screen is a
   * different distance on the ground at every zoom, so it looked like a
   * marker sliding across the map as it zoomed, and like nothing at all as
   * it panned, where the blit moves both together. Every test mounted the
   * map at the window's origin, where the offset is zero.
   */
  private _composite(
    ctx: MapCanvas,
    surface: SurfaceLike,
    size: number,
    /** Where it lands, in the window's logical pixels. */
    dest: ScreenRect,
    scale: number,
    /** Which sub-square of the surface to take, in `subSpan`ths. */
    subX: number,
    subY: number,
    subSpan: number,
  ): void {
    if (!ctx.drawImage || size <= 0) return;
    const x0 = Math.round(dest.x * scale);
    const y0 = Math.round(dest.y * scale);
    const x1 = Math.round((dest.x + dest.width) * scale);
    const y1 = Math.round((dest.y + dest.height) * scale);
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
    stats: RetainedFrameStats,
  ): void {
    const fonts = (this.app as { fonts?: FontsLike } | undefined)?.fonts;
    if (!fonts) return; // headless: nothing to shape with
    const text = this.resolvedTextStyle();
    const outgoing = this._outgoing;
    // While a restyle holds the previous style up, its labels are set in
    // its face.
    const family =
      outgoing?.family ??
      this._prop<MapStyle>('mapStyle')?.fontFamily ??
      this._defaultStyle?.fontFamily ??
      text.family;
    if (!this._shaper) {
      this._shaper = new LabelShaper(fonts, family, this._scale);
    } else {
      this._shaper.reconfigure(fonts, family, this._scale);
    }
    const clip = this._frameClip ? { ...this._frameClip } : null;
    if (outgoing) {
      // The labels that were on screen when the restyle began, and not the
      // new style's, which would go up over a map still drawn in the old
      // one. Re-placed only when they have to be — a placement is for one
      // zoom, and a source taken off the map takes its names with it — and
      // from what they were placed from, since the style that produced
      // that is being replaced, or was edited in place.
      const zoom = quantizeZoom(transform.zoom);
      const sources = this._sources();
      if (
        zoom !== outgoing.labelZoom ||
        !sameSources(sources, outgoing.labelSources)
      ) {
        const candidates: LabelCandidate[] = [];
        for (const source of sources) {
          for (const candidate of outgoing.candidates.get(source) ?? []) {
            candidates.push(candidate);
          }
        }
        outgoing.labels = placeLabels(
          candidates,
          transform.world,
          this._shaper,
        );
        outgoing.labelZoom = zoom;
        outgoing.labelSources = sources;
      }
      stats.labels = drawLabels(
        ctx,
        outgoing.labels,
        transform,
        pane,
        this._scale,
        clip,
        this._shaper,
      );
      return;
    }
    this._shapedFamily = family;
    const key = `${quantizeZoom(transform.zoom)}|${this._cache.generation}`;
    if (key !== this._labelKey) {
      this._labelKey = key;
      const styleZoom = Math.floor(transform.zoom);
      // Labels come from the tile the **data** came from, at the depth that
      // source actually cuts — past which many renderings share one tile
      // and collecting per rendering would place every label `span²` times.
      //
      // And only from the sources on the map now. The cache keeps a
      // provider's tiles after it is switched away, so that switching back
      // is free; collecting from all of them drew the old provider's place
      // names over the new one's map until eviction reached them.
      const sources = this._sources();
      const wanted = new Map<MapSource, number>();
      for (const source of sources) {
        wanted.set(source, Math.min(styleZoom, pyramid(source).maxZoom));
      }
      const candidates: LabelCandidate[] = [];
      const bySource = new Map<MapSource, LabelCandidate[]>();
      for (const cached of this._cache.dataEntries()) {
        if (cached.status !== 'ready' || !cached.vector) continue;
        if (wanted.get(cached.source) !== cached.tile.z) continue;
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
        let own = bySource.get(cached.source);
        if (!own) {
          own = [];
          bySource.set(cached.source, own);
        }
        for (const candidate of found) {
          candidates.push(candidate);
          own.push(candidate);
        }
      }
      this._labels = placeLabels(candidates, transform.world, this._shaper);
      this._labelZoom = quantizeZoom(transform.zoom);
      this._labelSources = sources;
      this._labelCandidates = bySource;
    }
    stats.labels = drawLabels(
      ctx,
      this._labels,
      transform,
      pane,
      this._scale,
      clip,
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
    const shaped = this._shaper.shape(text, ATTRIBUTION_SIZE, palette.text);
    if (!shaped) return;
    const at = attributionLayout(shaped, pane, this._scale);
    ctx.save();
    if (ctx.globalAlpha !== undefined) ctx.globalAlpha = ATTRIBUTION_OPACITY;
    ctx.fillStyle = palette.background;
    ctx.fillRect(at.box.x, at.box.y, at.box.width, at.box.height);
    if (ctx.globalAlpha !== undefined) ctx.globalAlpha = 1;
    shaped.layout.draw(ctx, at.x, at.y);
    ctx.restore();
  }

  // --- behaviour -----------------------------------------------------------

  /**
   * An event as the controller reads it. A synthetic event's `x`/`y` are
   * logical and relative to the window, so only the pane's own origin has
   * to come off.
   */
  private _input(ev: MouseEvent): MapPointerInput {
    const pane = this._pane();
    return {
      x: ev.x - pane.x,
      y: ev.y - pane.y,
      button: ev.button,
      // The click count core puts on a press and on its release, which the
      // declarations do not name.
      detail: (ev as { detail?: number }).detail,
      shiftKey: ev.shiftKey,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
    };
  }

  override defaultMouseDown(ev: MouseEvent): void {
    // A pan takes the focus, so the arrows work next. A press on a marker,
    // or on a map that does not move, is captured all the same: its release
    // is a click, and an application listening for one should get it.
    if (this._controller.pointerDown(this._input(ev)) === 'pan') this.focus();
    ev.capturePointer?.();
  }

  override defaultMouseDrag(ev: MouseEvent): void {
    this._controller.pointerDrag(this._input(ev));
  }

  override defaultMouseUp(ev: MouseEvent): void {
    this._controller.pointerUp(this._input(ev));
  }

  override defaultMouseMove(ev: MouseEvent): void {
    this._controller.pointerMove(this._input(ev));
  }

  override defaultMouseLeave(): void {
    this._controller.pointerLeave();
  }

  /**
   * The wheel is a zoom, not a scroll, so it is answered here rather than
   * through `canScroll`/`scrollBy` — the case react-x11's docs/extending.md
   * carves out. A zoom needs the point that must *not* move, which the
   * scroll chain never hands over.
   */
  override defaultWheel(ev: WheelEvent): void {
    const pane = this._pane();
    const point = { x: ev.x - pane.x, y: ev.y - pane.y };
    // Consumed whether or not the zoom moved: a wheel over a map that moves
    // is never meant for whatever is behind it.
    if (this._controller.wheel(point, ev.deltaY ?? 0)) ev.preventDefault();
  }

  override defaultKeyDown(ev: KeyboardEvent): void {
    if (this._controller.keyDown(ev.keysym ?? 0, ev.shiftKey ?? false)) {
      ev.preventDefault();
      return;
    }
    // Everything else goes to the base class, which is what keeps the
    // selection keys and Space/Enter-as-a-click working. `Node` declares the
    // default actions optional — an element that has no behaviour of its
    // own simply has none — so calling up is an optional call.
    super.defaultKeyDown?.(ev);
  }

  /** What a screen reader meets: the markers in view, as buttons — the
   *  controller's answer, which both renderers give. */
  override a11yScene(): A11ySceneItem[] {
    if (!this._visible()) return [];
    return this._controller.markerScene();
  }

  /** Every source this element has been handed, and how many `sources`
   *  changes in a row have made a slot anew — see `_noticeRemade`. */
  private readonly _seenSources = new WeakSet<MapSource>();
  private _remade = 0;
  private _warnedRemade = false;

  /**
   * Say so, once, when the application makes a source anew on every
   * render.
   *
   * Tiles are cached per source object (see `./tiles.ts`), so a source
   * rebuilt on each render starts from an empty cache on each render: every
   * tile in view is fetched again, and the map is its background until they
   * land. Under a controlled camera that is a render per pan step — a drag
   * across a blank map that fetches the whole view on every step.
   *
   * What gives it away is a slot handed a source this element has never
   * had, looking like the one it replaces — the same id, pyramid and
   * attribution — on three `sources` changes in a row. A provider switch
   * does that once, and a switch back to a source already shown does not
   * count at all. Looking alike is only ever the basis of a warning, never
   * of a cache key: two providers can look exactly alike.
   *
   * `process` and `console` come off `globalThis` because `src/` compiles
   * with `types: []`, as for the terminal's warning.
   */
  private _noticeRemade(
    before: readonly MapSource[] | undefined,
    next: readonly MapSource[] | undefined,
  ): void {
    if (this._warnedRemade) return;
    let slot = -1;
    if (before && next) {
      const length = Math.min(before.length, next.length);
      for (let i = 0; i < length && slot < 0; i++) {
        const was = before[i];
        const now = next[i];
        if (
          was &&
          now &&
          now !== was &&
          !this._seenSources.has(now) &&
          now.id === was.id &&
          now.tileSize === was.tileSize &&
          now.minZoom === was.minZoom &&
          now.maxZoom === was.maxZoom &&
          now.attribution === was.attribution
        ) {
          slot = i;
        }
      }
    }
    for (const source of before ?? []) this._seenSources.add(source);
    for (const source of next ?? []) this._seenSources.add(source);
    this._remade = slot < 0 ? 0 : this._remade + 1;
    if (this._remade < 3) return;
    this._warnedRemade = true;
    const g = globalThis as {
      process?: { env?: Record<string, string | undefined> };
      console?: { warn(message: string): void };
    };
    if (g.process?.env?.NODE_ENV === 'production') return;
    g.console?.warn(
      `@react-x11/components: <Map> was handed a new sources[${slot}] on ` +
        'three renders in a row. Tiles are cached per source object, so ' +
        'each one started from an empty cache and fetched every tile in ' +
        'view again. If it is the same provider each time, make it once — ' +
        'at module scope, or with useMemo.',
    );
  }

  override applyProps(
    next: Record<string, unknown>,
    prev: Record<string, unknown>,
  ): void {
    const before = prev ?? this.props;
    super.applyProps(next, prev);
    if (this._ownsController) {
      this._controller.setProps(this.props as MapControllerProps);
    }
    if (next.sources !== before.sources) {
      this._noticeRemade(
        before.sources as readonly MapSource[] | undefined,
        next.sources as readonly MapSource[] | undefined,
      );
    }
    // Every one of these is in `selfDamagedProps`, so the commit claimed
    // nothing for them and this is the only claim there will be.
    //
    // A restyle that repainted the pane covers everything else the commit
    // changed. One that is held claims a single pixel — nothing on screen
    // changes until the swap — so a camera or the markers moved in the same
    // commit still have to claim their own damage below.
    if (next.mapStyle !== before.mapStyle && !this._restyle()) return;
    if (next.sources !== before.sources) {
      // Nothing to throw away here: tiles are filed under the source
      // object, so a new provider starts empty, and one switched away from
      // keeps the tiles it has for when it comes back — its loads still in
      // flight are cancelled by the next frame's `sweep`, since nothing asks
      // for them. Only the label placement is stale.
      this._labelKey = '';
      this._repaint('props');
      return;
    }
    if (next.camera !== before.camera && next.camera !== undefined) {
      const camera = next.camera as MapCamera;
      const previous =
        (before.camera as MapCamera | undefined) ??
        this._controller.ownCamera();
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
    this._controller.detach(this._view);
    if (this._ownsController) this._controller.dispose();
    this._cache.destroy();
    this._candidates.clear();
    this._labels = [];
    this._labelCandidates = new Map();
    this._outgoing = null;
    super.destroySubtree();
  }
}
