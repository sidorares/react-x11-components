// `<GlMap>` — the GL renderer inside a `<glarea>`. A proof of concept: not
// exported from the package, and deliberately small. It has the camera, the
// input, the tile store, the frame and the labels, and none of `<Map>`'s
// markers, overlays or attribution, which are the next things a real one
// would need (see `docs/prd-maps-gl.md`).
//
// The shape follows `<Map>`'s one load-bearing decision: **the camera lives
// on a controller object, not in React state.** A pan step is two numbers
// and `requestFrame()`, with no render and no commit in the loop — which
// matters more here than there, because every frame here is a full redraw
// and the budget for one is the whole frame, not a strip.
//
// **Input reaches a `<glarea>` two ways, and neither is the surface's own
// props.** The surface is a window of its own — a CALayer on the Cocoa
// backend, a child X window on X11 — so core's hit test skips it (it is not
// in its parent's paint order) and answers with the box behind it. That box
// is this component's pane, and its handlers are what Cocoa's presses,
// drags and wheels reach, and what X11's wheel bubbles to (core forwards the
// wheel from the child window, named at the surface). An X11 *press* never
// gets that far: the child window selects presses to hear the wheel, so the
// server delivers them there and nothing hands them on. The controller
// listens on the child window itself for those — press, motion and release,
// which ntk selects on demand — and the implicit grab a press starts keeps
// the drag coming even when the pointer leaves the map.
import React, { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { ReactElement, Ref } from 'react';
import type { Style } from 'react-x11/style';

import { scaleOf } from '../../internal/units.js';
import { prepareStyle } from '../paint.js';
import type { PreparedStyle } from '../paint.js';
import { project, unproject, worldSize } from '../proj.js';
import type { MapCamera } from '../proj.js';
import { pyramidOf } from '../sources.js';
import type { MapSource } from '../sources.js';
import type { MapStyle } from '../style.js';
import { shortbreadStyle } from '../styles.js';
import { renderCover } from './cover.js';
import type { CoverResult } from './cover.js';
import { LabelPlacer } from './placement.js';
import type { LabelBatch, PlacementFrame } from './placement.js';
import { GlMapRenderer } from './renderer.js';
import type {
  FadeFrame,
  GlRenderOptions,
  GlRenderStats,
  RenderFrame,
} from './renderer.js';
import { GlTileStore } from './store.js';
import { LabelAtlas, SurfaceTextEngine } from './text.js';

const h = React.createElement;

/** What one frame cost. */
export interface GlMapFrameStats extends GlRenderStats {
  /** Milliseconds since the frame before — what a frame rate is made of. */
  interval: number;
  /** Milliseconds this frame spent building tiles' buckets. */
  buildMs: number;
  /** Tiles loaded and waiting for a build, and tiles still loading. */
  building: number;
  loading: number;
  /** Bytes of tile geometry on the GPU. */
  gpuBytes: number;
  camera: MapCamera;
  /** The pyramid level the view is drawn from, and the one fully shown —
   *  they differ while a level fades in. */
  level: number;
  shownLevel: number;
  /** The adaptive-quality rung this frame was drawn at: `0` is everything,
   *  higher leaves more out (see {@link QUALITY_LADDER}). */
  quality: number;
  /** What adaptive quality predicted a moving frame would cost, in
   *  milliseconds, or `0` for a frame it did not price. */
  predictedMs: number;
  /** A settled frame's own time, drained and finished — what the cost
   *  model learns from — or `0`. Moving frames are never timed. */
  measuredMs: number;
  /** Whether the camera moved within the settle window. */
  moving: boolean;
  /** Label anchors considered, and labels placed, this frame. */
  labelCandidates: number;
  labelsPlaced: number;
  /** Milliseconds this thread spent on labels: placing them, measuring
   *  the strings it had not measured before. */
  labelMs: number;
  /** Label text waiting to be rasterized. */
  textPending: boolean;
}

export interface GlMapHandle {
  getCamera(): MapCamera;
  setCamera(camera: Partial<MapCamera>): void;
  /** Logical pixels. */
  panBy(dx: number, dy: number): void;
  /** Zoom by `delta` levels, keeping the pane-local point `(x, y)` — the
   *  centre by default — over the same ground. */
  zoomAbout(delta: number, x?: number, y?: number): void;
  /** Ask for a frame. */
  invalidate(): void;
  stats(): GlMapFrameStats | null;
}

export interface GlMapProps extends GlRenderOptions {
  /** The first vector source is drawn; a POC does not stack pyramids. */
  sources: readonly MapSource[];
  mapStyle?: MapStyle;
  defaultCamera?: MapCamera;
  minZoom?: number;
  maxZoom?: number;
  /** `false` freezes the camera against the pointer and the keyboard. */
  interactive?: boolean;
  /** `'always'` while something animates the camera, so frames keep coming
   *  without each step asking. */
  frameLoop?: 'demand' | 'always';
  /** Milliseconds a frame may spend building tiles' buckets. 6 by default;
   *  a frame always builds at least one waiting tile. */
  buildBudgetMs?: number;
  /** Build buckets on this many worker threads instead, so no frame pays
   *  for a tile arriving. `0` by default. Read when the source changes. */
  buildWorkers?: number;
  /**
   * Cross-fade between pyramid levels over this many milliseconds, instead
   * of switching to the new level's geometry in one frame. `0` (the
   * default) switches. While a level fades in the frame is drawn twice —
   * the level leaving, and the level arriving over it — so a fade costs
   * double for its duration.
   */
  levelFade?: number;
  /**
   * Trade detail for frame rate while the camera moves. `true` holds each
   * moving frame to 12 ms; `{ budgetMs }` to another budget. When the
   * camera settles the next frame draws everything again.
   */
  adaptive?: boolean | { budgetMs?: number };
  /**
   * Draw the style's labels — place names, street names along their
   * streets. `true` by default. Needs the app's fonts: on a backend with
   * none the map draws without them.
   */
  labels?: boolean;
  onFrame?: (stats: GlMapFrameStats) => void;
  /**
   * Raw GL after the map has drawn and before the swap, with the frame's
   * framebuffer still bound — `<glarea onDraw>`'s escape hatch. What a
   * test reads a frame back through: a capture of the window from outside
   * does not see a GL surface on either backend.
   */
  onAfterDraw?: (gl: unknown, info: { width: number; height: number }) => void;
  onError?: (error: Error) => void;
  style?: Style;
  'data-testname'?: string;
  ref?: Ref<GlMapHandle>;
}

/**
 * Adaptive quality's rungs, cheapest last. Each leaves out more than the
 * one before it, in the order that costs the picture least:
 *
 *  1. **The fill edge pass** — the half-pixel line that antialiases every
 *     polygon. A fifth of a dense frame, measured, and a staircase edge is
 *     invisible on a map in motion.
 *  2. **The style's newest detail layers** — those whose `minZoom` is within
 *     `detail` levels of the zoom: buildings and service roads first, then
 *     sites, minor roads. The style already says which layers are details,
 *     by bringing them in last.
 *  3. **A coarser tile level** — the parent level's tiles, drawn at this
 *     zoom: generalized geometry and fewer features, which is what a low-zoom
 *     frame (all land and water polygons) is made cheaper by.
 */
export const QUALITY_LADDER: readonly {
  edges: boolean;
  detail: number;
  coarser: number;
}[] = [
  { edges: true, detail: 0, coarser: 0 },
  { edges: false, detail: 0, coarser: 0 },
  { edges: false, detail: 1, coarser: 0 },
  { edges: false, detail: 2, coarser: 0 },
  { edges: false, detail: 2, coarser: 1 },
  { edges: false, detail: 3, coarser: 2 },
];

/**
 * The rung a moving frame is drawn at: the lowest predicted to fit the
 * budget, and a rung up only once that one is predicted well inside it —
 * so a frame that sits at the budget does not flicker between two rungs.
 */
export function chooseQuality(
  current: number,
  predict: (rung: number) => number,
  budgetMs: number,
): number {
  const top = QUALITY_LADDER.length - 1;
  let rung = Math.max(0, Math.min(current, top));
  while (rung < top && predict(rung) > budgetMs) rung++;
  while (rung > 0 && predict(rung - 1) <= budgetMs * 0.75) rung--;
  return rung;
}

/**
 * Milliseconds per segment instance, learned from frames it measured. It
 * starts at what this renderer measured on an M1 Pro (3.7 M instances in
 * 8.5 ms) and moves toward each measured frame, so a slower GPU is priced
 * right within a few frames of the first gesture.
 */
class CostModel {
  msPerInstance = 2.4e-6;
  overheadMs = 0.4;

  predict(instances: number): number {
    return this.overheadMs + instances * this.msPerInstance;
  }

  learn(instances: number, ms: number): void {
    // A near-empty frame is all overhead and says nothing about the slope.
    if (instances < 50_000) return;
    const slope = Math.max(0, ms - this.overheadMs) / instances;
    this.msPerInstance += 0.25 * (slope - this.msPerInstance);
  }
}

interface AreaNode {
  requestFrame?(): void;
}

interface PaneNode {
  focus?(): void;
  getClientRects?(): { x: number; y: number; width: number; height: number }[];
}

interface DrawInfo {
  width: number;
  height: number;
  node: object;
}

/** The part of an ntk pointer event this reads: device pixels, relative to
 *  the window it arrived at, and the button in `keycode`. */
interface NativePointer {
  x: number;
  y: number;
  keycode?: number;
}

interface PointerWindow {
  id?: unknown;
  on?(name: string, listener: (ev: NativePointer) => void): void;
}

interface SyntheticPointer {
  x: number;
  y: number;
  button?: number;
  detail?: number;
  shiftKey?: boolean;
  deltaY?: number;
  keysym?: number;
  capturePointer?(): void;
  preventDefault?(): void;
}

const DEFAULT_CAMERA: MapCamera = { center: { lon: 0, lat: 20 }, zoom: 2 };
const DEFAULT_STYLE = shortbreadStyle();
/** `<Map>`'s wheel constant, so the two feel the same under a hand. */
const WHEEL_ZOOM = 1 / 2.5;
/** How long after the last camera change the map counts as settled and
 *  draws everything again. */
const SETTLE_MS = 180;
/** How long a fade waits for the new level's tiles before starting anyway. */
const FADE_WAIT_MS = 400;
const DEFAULT_BUDGET_MS = 12;
/** Milliseconds a frame may spend measuring strings it has not set before
 *  — the one label cost that can be large (the first strings on X11 load
 *  fonts and rasterize glyphs in JS). Placement's remainder waits a frame. */
const TEXT_BUDGET_MOVING_MS = 1;
const TEXT_BUDGET_SETTLED_MS = 4;
/**
 * How often a moving view is placed again, in milliseconds — every other
 * frame or so. The labels shown follow the map every frame regardless; what
 * waits a frame is a name coming into view, and what that buys is the frame
 * that would have placed *and* measured *and* uploaded at once, which is
 * what the late frames of a labelled pan were made of.
 */
const PLACE_INTERVAL_MS = 25;
/** How long the zoom must hold still before labels not already shown are
 *  placed (see `PlacementFrame.admit`). Under {@link SETTLE_MS}, so the
 *  frame that marks the camera settled is one that admits them. */
const ZOOM_QUIET_MS = 150;

const globals = globalThis as unknown as {
  performance?: { now(): number };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
const now = (): number => globals.performance?.now() ?? Date.now();

/** Which levels a frame shows: one, or two while the second fades in. */
interface LevelPlan {
  base: CoverResult;
  next: CoverResult | null;
  alpha: number;
}

class Controller {
  props: GlMapProps;
  camera: MapCamera;
  area: AreaNode | null = null;
  pane: PaneNode | null = null;
  stats: GlMapFrameStats | null = null;
  private _renderer: GlMapRenderer | null = null;
  private _gl: unknown = null;
  private _store: GlTileStore | null = null;
  private _style: MapStyle | null = null;
  private _prepared: PreparedStyle | null = null;
  private _pane = { width: 1, height: 1 };
  private _last = 0;
  private _failed = false;
  private _drag: { x: number; y: number } | null = null;
  private _pointerWindow: unknown = null;
  private _moved = -Infinity;
  private _settle: unknown = null;
  private _rung = 0;
  private readonly _cost = new CostModel();
  private _shown: number | null = null;
  private _fade: { to: number; start: number; waitSince: number } | null = null;
  private readonly _placer = new LabelPlacer();
  private _atlas: LabelAtlas | null = null;
  private _atlasKey = '';
  /** No labels — the app has no fonts, or placing them failed — and no
   *  asking again every frame. */
  private _noText = false;
  /** When the zoom last changed — which holds new labels back. */
  private _zoomedAt = -Infinity;
  /** When labels were last placed. */
  private _placedAt = -Infinity;
  private _pumpTimer: unknown = null;

  constructor(props: GlMapProps) {
    this.props = props;
    this.camera = props.defaultCamera ?? DEFAULT_CAMERA;
  }

  readonly request = (): void => {
    this.area?.requestFrame?.();
  };

  // --- the camera -------------------------------------------------------------

  private _clampZoom(zoom: number): number {
    const min = this.props.minZoom ?? 0;
    const max = this.props.maxZoom ?? 22;
    return Math.min(max, Math.max(min, zoom));
  }

  /** The camera moved: draw, and draw again at full detail once it stops. */
  private _moveTo(camera: MapCamera): void {
    if (camera.zoom !== this.camera.zoom) this._zoomedAt = now();
    this.camera = camera;
    this._moved = now();
    if (this._settle !== null) globals.clearTimeout(this._settle);
    const timer = globals.setTimeout(() => {
      this._settle = null;
      this.request();
    }, SETTLE_MS + 5);
    (timer as { unref?(): void } | null)?.unref?.();
    this._settle = timer;
    this.request();
  }

  setCamera(next: Partial<MapCamera>): void {
    this._moveTo({
      center: next.center ?? this.camera.center,
      zoom: this._clampZoom(next.zoom ?? this.camera.zoom),
    });
  }

  panBy(dx: number, dy: number): void {
    const world = worldSize(this.camera.zoom);
    const m = project(this.camera.center);
    const x = m.x + dx / world;
    const y = Math.min(1, Math.max(0, m.y + dy / world));
    this.setCamera({ center: unproject({ x: x - Math.floor(x), y }) });
  }

  /**
   * The pane's size in logical pixels — its box's, not the last frame's.
   * The box is current before the first frame and on a surface that cannot
   * draw at all, where the frame's size is still the 1×1 it started as and
   * a zoom about the pointer would be a zoom about the wrong point.
   */
  private _size(): { width: number; height: number } {
    const rect = this.pane?.getClientRects?.()[0];
    return rect && rect.width > 0 && rect.height > 0
      ? { width: rect.width, height: rect.height }
      : this._pane;
  }

  zoomAbout(delta: number, x?: number, y?: number): void {
    const size = this._size();
    const zoom = this._clampZoom(this.camera.zoom + delta);
    // The ground under (x, y) before, and where the centre must go for it
    // to be under (x, y) after.
    const before = worldSize(this.camera.zoom);
    const after = worldSize(zoom);
    const c = project(this.camera.center);
    const ox = (x ?? size.width / 2) - size.width / 2;
    const oy = (y ?? size.height / 2) - size.height / 2;
    const gx = c.x + ox / before;
    const gy = c.y + oy / before;
    const cx = gx - ox / after;
    const cy = Math.min(1, Math.max(0, gy - oy / after));
    this._moveTo({
      center: unproject({ x: cx - Math.floor(cx), y: cy }),
      zoom,
    });
  }

  // --- input --------------------------------------------------------------------

  private _interactive(): boolean {
    return this.props.interactive !== false;
  }

  /** A synthetic event's position in the pane's logical pixels: `x`/`y`
   *  are logical and window-relative, and so is the pane's client rect. */
  private _local(ev: { x: number; y: number }): { x: number; y: number } {
    const rect = this.pane?.getClientRects?.()[0];
    return { x: ev.x - (rect?.x ?? 0), y: ev.y - (rect?.y ?? 0) };
  }

  /** Whether a press starts a pan — the primary button, on a live map. */
  pointerDown(x: number, y: number, button: number): boolean {
    if (button !== 1 || !this._interactive()) return false;
    this._drag = { x, y };
    return true;
  }

  pointerMove(x: number, y: number): void {
    const drag = this._drag;
    if (!drag) return;
    const dx = x - drag.x;
    const dy = y - drag.y;
    if (dx === 0 && dy === 0) return;
    this._drag = { x, y };
    this.panBy(-dx, -dy);
  }

  pointerUp(): void {
    this._drag = null;
  }

  get dragging(): boolean {
    return this._drag !== null;
  }

  /** The pane's handlers — Cocoa's whole input, and X11's wheel. */
  readonly handlers = {
    onMouseDown: (ev: SyntheticPointer): void => {
      const p = this._local(ev);
      if (!this.pointerDown(p.x, p.y, ev.button ?? 1)) return;
      ev.capturePointer?.();
      this.pane?.focus?.();
    },
    onMouseMove: (ev: SyntheticPointer): void => {
      if (!this._drag) return;
      const p = this._local(ev);
      this.pointerMove(p.x, p.y);
    },
    onMouseUp: (): void => this.pointerUp(),
    onClick: (ev: SyntheticPointer): void => {
      // A double click zooms in about the pointer, Shift zooms out: the
      // convention every map client has.
      if (ev.detail !== 2 || !this._interactive()) return;
      const p = this._local(ev);
      this.zoomAbout(ev.shiftKey ? -1 : 1, p.x, p.y);
    },
    onWheel: (ev: SyntheticPointer): void => {
      if (!this._interactive()) return;
      const p = this._local(ev);
      this.zoomAbout(-(ev.deltaY ?? 0) * WHEEL_ZOOM * 0.02, p.x, p.y);
      // A wheel over a map is never meant for whatever is behind it.
      ev.preventDefault?.();
    },
    onKeyDown: (ev: SyntheticPointer): void => {
      if (!this._interactive()) return;
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
          this.zoomAbout(1);
          break;
        case 0x002d: // XK_minus
        case 0xffad: // XK_KP_Subtract
          this.zoomAbout(-1);
          break;
        default:
          return;
      }
      ev.preventDefault?.();
    },
  };

  /**
   * On X11, listen on the surface's own child window for what the server
   * delivers there. A no-op on the Cocoa backend, whose surface is a layer
   * with no events of its own — told apart by the X window id an ntk window
   * has and a layer does not.
   */
  private _attachPointer(node: object): void {
    const wnd = (node as { window?: PointerWindow | null }).window;
    if (!wnd || wnd === this._pointerWindow) return;
    if (typeof wnd.on !== 'function' || typeof wnd.id !== 'number') return;
    this._pointerWindow = wnd;
    const at = (ev: NativePointer) => {
      const scale = scaleOf(node);
      return { x: ev.x / scale, y: ev.y / scale };
    };
    wnd.on('mousedown', (ev) => {
      const p = at(ev);
      if (this.pointerDown(p.x, p.y, ev.keycode ?? 1)) this.pane?.focus?.();
    });
    wnd.on('mousemove', (ev) => {
      if (!this._drag) return;
      const p = at(ev);
      this.pointerMove(p.x, p.y);
    });
    wnd.on('mouseup', () => this.pointerUp());
  }

  // --- the frame ------------------------------------------------------------------

  private _styleNow(): { style: MapStyle; prepared: PreparedStyle } {
    const style = this.props.mapStyle ?? DEFAULT_STYLE;
    if (style !== this._style || !this._prepared) {
      this._style = style;
      this._prepared = prepareStyle(style);
      this._store?.setStyle(this._prepared);
    }
    return { style, prepared: this._prepared };
  }

  private _storeFor(source: MapSource, prepared: PreparedStyle): GlTileStore {
    if (this._store?.source !== source) {
      this._store?.dispose((data) => this._renderer?.release(data));
      this._store = new GlTileStore({
        source,
        prepared,
        onChange: this.request,
        workers: this.props.buildWorkers ?? 0,
      });
    }
    return this._store;
  }

  private _budget(): number | null {
    const adaptive = this.props.adaptive;
    if (!adaptive) return null;
    return typeof adaptive === 'object'
      ? (adaptive.budgetMs ?? DEFAULT_BUDGET_MS)
      : DEFAULT_BUDGET_MS;
  }

  /**
   * The level fade: which level the frame is drawn from, and the one fading
   * in over it.
   *
   * A new level is waited for — briefly, until every tile of it in view has
   * answered — so the fade shows it arriving rather than a stand-in for it;
   * then it fades in over the level it replaces, with an ease at both ends.
   * A level more than one step away is not faded (the view it would fade
   * from is sixteen times the tiles), and a change of target halfway
   * through a fade takes the half-shown level as the one it fades from.
   */
  private _planLevels(
    target: CoverResult,
    cover: (level: number) => CoverResult,
    at: number,
  ): LevelPlan {
    const fadeMs = this.props.levelFade ?? 0;
    const to = target.level;
    const plain = { base: target, next: null, alpha: 0 };
    if (fadeMs <= 0 || this._shown === null || Math.abs(to - this._shown) > 1) {
      this._shown = to;
      this._fade = null;
      return plain;
    }
    if (to === this._shown) {
      this._fade = null;
      return plain;
    }
    let fade = this._fade;
    if (!fade || fade.to !== to) {
      if (fade && fade.start > 0 && (at - fade.start) / fadeMs >= 0.5) {
        this._shown = fade.to;
      }
      if (this._shown === to) {
        this._fade = null;
        return plain;
      }
      fade = this._fade = { to, start: 0, waitSince: at };
    }
    const base = cover(this._shown);
    if (fade.start === 0) {
      if (target.missing.length > 0 && at - fade.waitSince < FADE_WAIT_MS) {
        return { base, next: null, alpha: 0 };
      }
      fade.start = at;
    }
    const p = (at - fade.start) / fadeMs;
    if (p >= 1) {
      this._shown = to;
      this._fade = null;
      return plain;
    }
    return { base, next: target, alpha: p * p * (3 - 2 * p) };
  }

  /**
   * The frame's labels: placed over the tiles of the level being shown —
   * the arriving one, once a fade is past halfway — and batched for the
   * renderer. The atlas is made on the first frame, from the app the
   * surface belongs to, and again when the face or the scale changes.
   */
  private _labelsFor(
    node: object,
    style: MapStyle,
    frame: RenderFrame,
    fade: FadeFrame | null,
    tileSize: number,
    at: number,
    moving: boolean,
  ): LabelBatch | null {
    if (this._noText) return null;
    const family = style.fontFamily ?? 'sans-serif';
    const key = `${family}|${frame.scale}`;
    if (!this._atlas || this._atlasKey !== key) {
      this._atlas?.dispose();
      this._atlas = null;
      const engine = SurfaceTextEngine.forApp(
        (node as { app?: unknown }).app,
        family,
      );
      if (!engine) {
        this._noText = true;
        return null;
      }
      // Margin for a halo of two logical pixels, and the texel either side
      // that keeps its samples inside it (see `quadInset`).
      this._atlas = new LabelAtlas(engine, {
        pad: 2 * Math.ceil(2 * frame.scale) + 2,
      });
      this._atlas.onChange = this.request;
      this._atlasKey = key;
      this._placer.reset();
    }
    const atlas = this._atlas;
    atlas.beginFrame(
      now() + (moving ? TEXT_BUDGET_MOVING_MS : TEXT_BUDGET_SETTLED_MS),
    );
    const from = fade && fade.alpha >= 0.5 ? fade.frame : frame;
    const centre = project(this.camera.center);
    const placement: PlacementFrame = {
      width: frame.width,
      height: frame.height,
      scale: frame.scale,
      zoom: frame.zoom,
      style: frame.style,
      tiles: from.tiles,
      centerX: centre.x,
      centerY: centre.y,
      // The cover's world, which is the source's tile size's — not the
      // projection's default.
      world: worldSize(this.camera.zoom, tileSize) * frame.scale,
      now: at,
      admit: at - this._zoomedAt >= ZOOM_QUIET_MS,
      moving,
    };
    if (!moving || at - this._placedAt >= PLACE_INTERVAL_MS) {
      this._placer.place(placement, atlas);
      this._placedAt = at;
    }
    this._pumpSoon();
    return this._placer.batch(placement, atlas);
  }

  /**
   * Rasterize what placement asked for — after this frame rather than in
   * it. Setting a batch of strings is milliseconds of this thread, and the
   * gap between two frames is where that costs no frame anything.
   */
  private _pumpSoon(): void {
    if (this._pumpTimer !== null || !this._atlas?.pending) return;
    this._pumpTimer = globals.setTimeout(() => {
      this._pumpTimer = null;
      this._atlas?.pump();
    }, 0);
  }

  draw(gl: unknown, info: DrawInfo): void {
    if (this._failed) return;
    this._attachPointer(info.node);
    const scale = scaleOf(info.node);
    if (gl !== this._gl) {
      // A new context — the surface was recreated — owns none of the old
      // one's buffers, so everything is uploaded again from the buckets.
      this._renderer = null;
      this._gl = gl;
    }
    if (!this._renderer) {
      try {
        this._renderer = new GlMapRenderer(gl, this.props);
      } catch (error) {
        this._failed = true;
        this.props.onError?.(error as Error);
        return;
      }
    }
    const renderer = this._renderer;
    renderer.antialias = this.props.antialias ?? true;
    renderer.fillRule = this.props.fillRule ?? 'nonzero';
    const { style, prepared } = this._styleNow();
    const source = this.props.sources[0];
    this._pane = { width: info.width / scale, height: info.height / scale };
    const at = now();
    const moving = at - this._moved < SETTLE_MS;
    const budget = this._budget();

    const frameOf = (
      cover: CoverResult,
      rung: (typeof QUALITY_LADDER)[number],
    ): RenderFrame => ({
      width: info.width,
      height: info.height,
      zoom: this.camera.zoom,
      scale,
      style: prepared,
      background: style.background,
      tiles: cover.tiles,
      detail: rung.detail,
      edges: rung.edges ? undefined : false,
    });

    let frame: RenderFrame = frameOf(
      { tiles: [], missing: [], level: 0 },
      QUALITY_LADDER[0],
    );
    let fade: FadeFrame | null = null;
    let buildMs = 0;
    let more = false;
    let level = 0;
    let rung = 0;
    let predictedMs = 0;
    const store = source ? this._storeFor(source, prepared) : null;
    if (store && source) {
      store.tick();
      const started = now();
      more = store.pump(started + (this.props.buildBudgetMs ?? 6));
      buildMs = now() - started;
      const pyramid = pyramidOf(source);
      const cover = (at?: number) =>
        renderCover(this.camera, this._pane, scale, pyramid, store, {
          level: at,
        });
      const target = cover();
      level = target.level;
      store.want(target.missing);
      const plan = this._planLevels(target, cover, at);
      if (plan.base !== target) store.want(plan.base.missing);

      // The frame at a rung: the plan's levels with that rung's detail left
      // out — and, when no fade is running, a coarser level for the base.
      const build = (
        r: number,
      ): { frame: RenderFrame; fade: FadeFrame | null } => {
        const q = QUALITY_LADDER[r];
        let base = plan.base;
        if (q.coarser > 0 && !plan.next) {
          const coarser = Math.max(pyramid.minZoom, base.level - q.coarser);
          if (coarser < base.level) base = cover(coarser);
        }
        return {
          frame: frameOf(base, q),
          fade: plan.next
            ? { frame: frameOf(plan.next, q), alpha: plan.alpha }
            : null,
        };
      };
      if (budget !== null && moving) {
        // The coarser level is what the ladder's last rungs draw, so ask
        // for it too — after the view's own tiles, which come first.
        store.want(cover(Math.max(pyramid.minZoom, level - 1)).missing);
        const predict = (r: number): number => {
          const built = build(r);
          const work =
            renderer.estimate(built.frame) +
            (built.fade ? renderer.estimate(built.fade.frame) : 0);
          return this._cost.predict(work);
        };
        rung = chooseQuality(this._rung, predict, budget);
        predictedMs = predict(rung);
      }
      this._rung = rung;
      const built = build(rung);
      frame = built.frame;
      fade = built.fade;
    }

    // Adaptive quality prices moving frames with a rate it learns from
    // frames it times — and it times only settled ones. Timing a frame means
    // `glFinish`, which holds this thread until the GPU is done and, on the
    // Cocoa backend, until the surface is: a moving frame cannot afford
    // that, and what it reads is not the frame's cost either. Timed on every
    // moving frame, the cheapest rungs read 16–52 ms of what is a few
    // milliseconds of drawing, and the model learned from that put nearly
    // every frame on the coarsest rung. A settled frame is drawn once and
    // animates nothing, so it can afford two finishes: one to drain what
    // came before it, and one to time it alone. It still errs slow — a lone
    // frame after a pause meets a GPU that has clocked down — which errs on
    // the side of frame rate.
    let labels: LabelBatch | null = null;
    let labelMs = 0;
    if (this.props.labels !== false && source) {
      const started = now();
      try {
        labels = this._labelsFor(
          info.node,
          style,
          frame,
          fade,
          pyramidOf(source).tileSize,
          at,
          moving,
        );
      } catch (error) {
        // Labels are the map's to lose, not the frame's: a failure placing
        // them turns them off, once and reported, and the map draws on. A
        // throw out of here would instead be every frame's, and core hands
        // an `onDraw` throw to `onError` and nothing else — the map would
        // simply stop.
        this._noText = true;
        this._atlas?.dispose();
        this._atlas = null;
        this.props.onError?.(error as Error);
      }
      labelMs = now() - started;
    }

    const calibrate = budget !== null && !moving;
    const finish = (): void => (gl as { finish?(): void }).finish?.();
    if (calibrate) finish();
    const drawStart = now();
    const stats = renderer.render(frame, fade, labels);
    let measuredMs = 0;
    if (calibrate) {
      finish();
      measuredMs = now() - drawStart;
      // An upload is not drawing, and would teach the model it was.
      if (stats.uploads === 0) this._cost.learn(stats.instances, measuredMs);
    }
    this.props.onAfterDraw?.(gl, info);
    store?.evict((data) => renderer.release(data));
    const end = now();
    const interval = this._last ? end - this._last : 0;
    this._last = end;
    this.stats = {
      ...stats,
      interval,
      buildMs,
      building: store?.building ?? 0,
      loading: store?.loading ?? 0,
      gpuBytes: renderer.gpuBytes,
      camera: this.camera,
      level,
      shownLevel: this._shown ?? level,
      quality: rung,
      predictedMs,
      measuredMs,
      moving,
      labelCandidates: labels ? this._placer.stats.candidates : 0,
      labelsPlaced: labels ? this._placer.stats.placed : 0,
      labelMs,
      textPending: this._atlas?.pending ?? false,
    };
    // A label still fading, strings this frame had no budget to measure, or
    // rasters still to go into the texture want the next frame; a raster
    // in flight asks for one itself when it lands.
    const labelling =
      labels !== null &&
      (this._placer.animating ||
        this._atlas?.starved === true ||
        this._atlas?.uploading === true);
    if (more || this._fade || labelling) this.request();
    this.props.onFrame?.(this.stats);
  }

  dispose(): void {
    if (this._settle !== null) globals.clearTimeout(this._settle);
    this._settle = null;
    if (this._pumpTimer !== null) globals.clearTimeout(this._pumpTimer);
    this._pumpTimer = null;
    this._atlas?.dispose();
    this._atlas = null;
    this._store?.dispose((data) => this._renderer?.release(data));
    this._store = null;
    this._renderer?.dispose();
    this._renderer = null;
  }
}

/**
 * A map drawn on the GPU, every frame, from vector tiles.
 *
 * ```tsx
 * <GlMap sources={[source]} defaultCamera={{ center, zoom: 13 }}
 *        style={{ flexGrow: 1 }} />
 * ```
 *
 * Needs the direct GL backend — `createRoot({ glPolicy: 'auto' })` on X11,
 * nothing on the Cocoa backend — and draws nothing on indirect GLX, which
 * has no shaders. Drag to pan, wheel or double-click to zoom (Shift for
 * out), arrows and +/− once focused.
 */
export function GlMap(props: GlMapProps): ReactElement {
  const controller = useMemo(() => new Controller(props), []);
  controller.props = props;
  const area = useRef<AreaNode | null>(null);

  useImperativeHandle(
    props.ref,
    (): GlMapHandle => ({
      getCamera: () => controller.camera,
      setCamera: (camera) => controller.setCamera(camera),
      panBy: (dx, dy) => controller.panBy(dx, dy),
      zoomAbout: (delta, x, y) => controller.zoomAbout(delta, x, y),
      invalidate: () => controller.request(),
      stats: () => controller.stats,
    }),
    [controller],
  );
  useEffect(() => () => controller.dispose(), [controller]);

  return h(
    'box',
    {
      ref: (node: PaneNode | null) => {
        controller.pane = node;
      },
      style: props.style,
      focusable: true,
      role: 'group',
      'aria-label': 'Map',
      'data-testname': props['data-testname'],
      ...controller.handlers,
    },
    h('glarea', {
      ref: (node: AreaNode | null) => {
        area.current = node;
        controller.area = node;
      },
      style: FILL,
      clearColor: (props.mapStyle ?? DEFAULT_STYLE).background ?? '#ffffff',
      frameLoop: props.frameLoop ?? 'demand',
      onDraw: (gl: unknown, info: DrawInfo) => controller.draw(gl, info),
      onError: props.onError,
    }),
  );
}

const FILL = { flexGrow: 1 };
