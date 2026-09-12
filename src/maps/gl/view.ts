// The GL renderer as `<Map>` mounts it: a pane (`./pane.ts`) with a
// `<glarea>` in it, and every frame drawn into the surface from vector tiles
// — the style, and over it the labels.
//
// **The camera is not this renderer's.** It is the map's controller's
// (`../controller.ts`), which the retained renderer answers to as well, so a
// fallback in the middle of a pan keeps the camera and the handle. What this
// file adds is what a camera move costs here: a frame. A pan step is two
// numbers on the controller and `requestFrame()`, with no render and no
// commit in the loop — which matters more here than for the retained
// renderer, because every frame here is a full redraw and the budget for one
// is the whole frame, not a strip.
//
// **Input reaches a `<glarea>` two ways, and neither is the surface's own
// props.** The surface is a window of its own, so core's hit test skips it
// and answers with the pane behind it: the pane's handlers are what Cocoa's
// presses, drags and wheels reach, and what X11's wheel bubbles to (core
// forwards the wheel from the child window, named at the surface). An X11
// *press* never gets that far — the child window selects presses to hear the
// wheel, so the server delivers them there and nothing hands them on — so
// this listens on the child window itself for press, motion, release and
// leave, which ntk selects on demand; the implicit grab a press starts keeps
// a drag coming even when the pointer leaves the map. Both routes end at the
// controller methods the retained renderer's element calls.
//
// **A failure is `<Map>`'s to handle.** A surface that will not come up, a
// connection with no direct GL, a context or a shader that will not build, a
// throw from a frame: each is reported once through `onFailure`, and `<Map>`
// moves an `'auto'` map to the retained renderer or tells a `'gl'` one
// through `onError`. Nothing here falls back on its own.
import React, { useEffect, useMemo } from 'react';
import type { ReactElement } from 'react';
import { useTheme } from 'react-x11';
import type { Style } from 'react-x11/style';

import { scaleOf } from '../../internal/units.js';
import type { MapController, MapPointerInput, MapView } from '../controller.js';
import {
  ATTRIBUTION_OPACITY,
  ATTRIBUTION_SIZE,
  attributionLayout,
} from '../overlay.js';
import type { MapOverlay, OverlayPalette } from '../overlay.js';
import { prepareStyle } from '../paint.js';
import type { PreparedStyle } from '../paint.js';
import {
  DEFAULT_TILE_SIZE,
  project,
  transformFor,
  worldSize,
} from '../proj.js';
import type { MapCamera, ScreenRect } from '../proj.js';
import { attributionOf, pyramidOf } from '../sources.js';
import type { MapSource } from '../sources.js';
import type { MapStyle } from '../style.js';
import { defaultStyleFor, isDarkTheme, overlayPalette } from '../theme.js';
import type { MapFrameStats, MapProps } from '../types.js';
import { parseColor, premultiplied } from './color.js';
import type { Rgba } from './color.js';
import { renderCover } from './cover.js';
import type { CoverResult } from './cover.js';
import { MarkerBatcher } from './markers.js';
import {
  buildOverlayBucket,
  overlayRegion,
  regionHolds,
  regionPlacement,
} from './overlays.js';
import type { OverlayBucket } from './overlays.js';
import { GL_PANE } from './pane.js';
import { LABEL_INSTANCE, LabelPlacer } from './placement.js';
import type { LabelBatch, PlacementFrame } from './placement.js';
import { GlMapRenderer } from './renderer.js';
import type {
  AttributionDraw,
  FadeFrame,
  OverlayDraw,
  RenderFrame,
  RenderTile,
} from './renderer.js';
import { GlTileStore } from './store.js';
import { LabelAtlas, SurfaceTextEngine } from './text.js';

const h = React.createElement;

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

type Rung = (typeof QUALITY_LADDER)[number];

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
  window?: unknown;
  /** Set by a core that forwards presses and motion from the surface's own
   *  window, as it does the wheel — see `_attachPointer`. */
  forwardsPointer?: boolean;
}

interface PaneNode {
  focus?(): void;
  contentBox?(): { x: number; y: number; width: number; height: number };
  notifyA11ySceneChanged?(): void;
  resolvedTextStyle?(): { family?: string };
}

interface DrawInfo {
  width: number;
  height: number;
  node: object;
}

/** The part of an ntk pointer event this reads: device pixels, relative to
 *  the window it arrived at, the button in `keycode` and the modifier state
 *  in `buttons` (X11's, so Shift is bit 0 and Control bit 2). */
interface NativePointer {
  x: number;
  y: number;
  keycode?: number;
  buttons?: number;
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
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  deltaY?: number;
  keysym?: number;
  capturePointer?(): void;
  preventDefault?(): void;
}

/** How far outside the pane tiles are kept warm, in logical pixels — the
 *  retained renderer's ring, so an ordinary flick has its tiles. */
const COVER_PADDING = 256;
/** How long a fade waits for the new level's tiles before starting anyway. */
const FADE_WAIT_MS = 400;
const DEFAULT_BUDGET_MS = 12;
/** Milliseconds a frame may spend building tiles' buckets on this thread;
 *  a frame always builds at least one waiting tile. */
const BUILD_BUDGET_MS = 6;
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
 *  placed (see `PlacementFrame.admit`). Under the controller's settle
 *  window, so the frame that marks the camera settled is one that admits
 *  them. */
const ZOOM_QUIET_MS = 120;
/** Sources taken off the map whose tiles are kept for a switch back. */
const INACTIVE_STORES = 2;
const NO_RASTER: MapFrameStats['draw'] = {
  features: 0,
  vertices: 0,
  decimated: 0,
  culled: 0,
  batches: 0,
};
/** A theme colour that does not parse falls back to these. */
const BLACK: Rgba = [0, 0, 0, 1];
const WHITE: Rgba = [1, 1, 1, 1];

const INDIRECT =
  '@react-x11/components maps: this <glarea> draws through indirect GLX, ' +
  'which has no shaders — the GL renderer needs the direct backend, which ' +
  "on X11 is createRoot({ glPolicy: 'auto' }) and a DRI3 or Apple-DRI server";

const globals = globalThis as unknown as {
  performance?: { now(): number };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  process?: { env?: Record<string, string | undefined> };
  console?: { warn(message: string): void };
};
const now = (): number => globals.performance?.now() ?? Date.now();

const EMPTY_PANE: ScreenRect = { x: 0, y: 0, width: 0, height: 0 };
const EMPTY_COVER: CoverResult = {
  tiles: [],
  missing: [],
  level: 0,
  own: 0,
  ancestors: 0,
  descendants: 0,
  inView: [],
};

/** Which levels a frame shows: one, or two while the second fades in. */
interface LevelPlan {
  base: CoverResult;
  next: CoverResult | null;
  alpha: number;
}

/** One source on the map, as a frame found it. */
interface SourceCover {
  source: MapSource;
  store: GlTileStore;
  pyramid: { minZoom: number; maxZoom: number; tileSize: number };
  target: CoverResult;
}

/** What `<Map>` hands the GL renderer. */
export interface GlMapPaneProps {
  /** The map's controller: its camera, its gestures and its handle. */
  controller: MapController;
  /** Everything `<Map>` was given. */
  map: MapProps;
  /** GL failed — the surface, the context, a shader, a frame. Called once;
   *  what happens next is `<Map>`'s decision. */
  onFailure: (error: Error) => void;
  style?: Style;
  role?: string;
  'aria-label'?: string;
  'data-testname'?: string;
}

/** A mouse button, as opposed to a wheel notch, which X11 also reports as a
 *  press — of buttons 4 to 7. */
function isButton(ev: NativePointer): boolean {
  const button = ev.keycode ?? 1;
  return button >= 1 && button <= 3;
}

class GlMapDriver implements MapView {
  props: GlMapPaneProps;
  theme: unknown = null;
  private readonly _controller: MapController;
  private _pane: PaneNode | null = null;
  private _area: AreaNode | null = null;
  private _renderer: GlMapRenderer | null = null;
  private _gl: unknown = null;
  private _failed = false;
  /** A store per source object — the retained cache's rule: a source is its
   *  own cache, whatever its id. */
  private readonly _stores = new Map<MapSource, GlTileStore>();
  /** Sources taken off the map, oldest first, whose tiles are kept. */
  private _inactive: MapSource[] = [];
  private _style: MapStyle | null = null;
  private _prepared: PreparedStyle | null = null;
  private _committed: MapProps | null = null;
  private _lastEnd: number | null = null;
  private _drawnZoom: number | null = null;
  /** When the zoom last changed — which holds new labels back. */
  private _zoomedAt = -Infinity;
  private _rung = 0;
  private readonly _cost = new CostModel();
  private _shown: number | null = null;
  private _fade: {
    to: number;
    start: number | null;
    waitSince: number;
  } | null = null;
  private readonly _placer = new LabelPlacer();
  private readonly _markers = new MarkerBatcher();
  /** The overlays' bucket, and what it was built from. */
  private _overlay: {
    bucket: OverlayBucket;
    overlays: readonly MapOverlay[];
    accent: string;
  } | null = null;
  private _atlas: LabelAtlas | null = null;
  private _atlasKey = '';
  /** No labels — the app has no fonts, or placing them failed — and no
   *  asking again every frame. */
  private _noText = false;
  /** The attribution's one instance. */
  private readonly _attributionText = new Float32Array(LABEL_INSTANCE);
  /** An attribution a frame could not draw yet — its string not measured,
   *  or its raster not in the texture — and the size it is set at. */
  private _attributionWanted: { text: string; size: number } | null = null;
  /** When labels were last placed. */
  private _placedAt = -Infinity;
  private _pumpTimer: unknown = null;
  private _stats: MapFrameStats | null = null;
  private _pointerWindow: unknown = null;
  /** The last press on the X11 child window, for its click count. */
  private _press = { time: 0, x: 0, y: 0, detail: 0 };
  private _announced = false;
  private _paneStyle: {
    base: Style | undefined;
    background: string;
    value: Style;
  } | null = null;

  constructor(controller: MapController, props: GlMapPaneProps) {
    this._controller = controller;
    this.props = props;
  }

  // --- the controller's view ----------------------------------------------------

  /** The pane in the window's logical pixels: its box's, which is current
   *  before the first frame and on a surface that never draws at all. */
  pane(): ScreenRect {
    const box = this._pane?.contentBox?.();
    if (!box) return EMPTY_PANE;
    const s = scaleOf(this._pane);
    return {
      x: box.x / s,
      y: box.y / s,
      width: box.width / s,
      height: box.height / s,
    };
  }

  scale(): number {
    return scaleOf(this._pane);
  }

  /** Any camera move is one frame — there is no blit to prefer. */
  moved(): void {
    this.request();
  }

  /** Still: the next frame draws everything adaptive quality left out. */
  settled(): void {
    this.request();
  }

  /** `refresh()`: the style read again, and every tile's buckets and label
   *  anchors built again from its bytes. */
  refresh(): void {
    this._style = null;
    this._prepared = null;
    for (const store of this._stores.values()) store.rebuild();
    this._placer.reset();
    this.request();
  }

  stats(): MapFrameStats | null {
    return this._stats;
  }

  focus(): void {
    this._pane?.focus?.();
  }

  readonly request = (): void => {
    this._area?.requestFrame?.();
  };

  attach(): void {
    this._controller.attach(this);
  }

  readonly paneRef = (node: PaneNode | null): void => {
    this._pane = node;
    if (node) this._controller.attach(this);
  };

  readonly areaRef = (node: AreaNode | null): void => {
    this._area = node;
  };

  /** A commit landed: what it changed that a frame shows asks for one. */
  committed(): void {
    const map = this.props.map;
    const before = this._committed;
    this._committed = map;
    if (!before) return;
    if (map.markers !== before.markers) {
      this._pane?.notifyA11ySceneChanged?.();
    }
    if (
      map.camera !== before.camera ||
      map.markers !== before.markers ||
      map.overlays !== before.overlays ||
      map.sources !== before.sources ||
      map.mapStyle !== before.mapStyle ||
      map.attribution !== before.attribution ||
      map.antialias !== before.antialias ||
      map.fillRule !== before.fillRule ||
      map.levelFade !== before.levelFade ||
      map.adaptive !== before.adaptive
    ) {
      this.request();
    }
  }

  /** The style's background: what the pane shows under the surface, and
   *  what the surface is cleared to. */
  background(): string {
    const style =
      this.props.map.mapStyle ?? defaultStyleFor(isDarkTheme(this.theme));
    return style.background ?? '#ffffff';
  }

  /** The pane's style, the same object for as long as nothing in it changes
   *  — a new one every render would be a damage claim every render. */
  paneStyle(base: Style | undefined, background: string): Style {
    const cached = this._paneStyle;
    if (cached && cached.base === base && cached.background === background) {
      return cached.value;
    }
    const value = [base, { backgroundColor: background }] as unknown as Style;
    this._paneStyle = { base, background, value };
    return value;
  }

  // --- input --------------------------------------------------------------------

  private _local(ev: { x: number; y: number }): { x: number; y: number } {
    const pane = this.pane();
    return { x: ev.x - pane.x, y: ev.y - pane.y };
  }

  private _input(ev: SyntheticPointer): MapPointerInput {
    const p = this._local(ev);
    return {
      x: p.x,
      y: p.y,
      button: ev.button,
      detail: ev.detail,
      shiftKey: ev.shiftKey,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
    };
  }

  /** The pane's handlers — the whole of Cocoa's input, and X11's wheel. */
  readonly handlers = {
    onMouseDown: (ev: SyntheticPointer): void => {
      if (this._controller.pointerDown(this._input(ev)) === 'pan') {
        this._pane?.focus?.();
      }
      ev.capturePointer?.();
    },
    onMouseMove: (ev: SyntheticPointer): void => {
      const input = this._input(ev);
      if (this._controller.dragging) this._controller.pointerDrag(input);
      else this._controller.pointerMove(input);
    },
    onMouseUp: (ev: SyntheticPointer): void => {
      this._controller.pointerUp(this._input(ev));
    },
    onMouseLeave: (): void => this._controller.pointerLeave(),
    onWheel: (ev: SyntheticPointer): void => {
      if (this._controller.wheel(this._local(ev), ev.deltaY ?? 0)) {
        ev.preventDefault?.();
      }
    },
    onKeyDown: (ev: SyntheticPointer): void => {
      if (this._controller.keyDown(ev.keysym ?? 0, ev.shiftKey ?? false)) {
        ev.preventDefault?.();
      }
    },
  };

  /**
   * On X11, listen on the surface's own child window for what the server
   * delivers there. A no-op on the Cocoa backend, whose surface is a layer
   * with no events of its own — told apart by the X window id an ntk window
   * has and a layer does not — and on a core that already forwards presses
   * and motion from the surface to the pane, where listening here as well
   * would take every press twice.
   */
  private _attachPointer(node: object): void {
    const area = node as AreaNode;
    const wnd = area.window as PointerWindow | null | undefined;
    if (!wnd || wnd === this._pointerWindow) return;
    if (typeof wnd.on !== 'function' || typeof wnd.id !== 'number') return;
    if (area.forwardsPointer === true) return;
    this._pointerWindow = wnd;
    const input = (ev: NativePointer, detail: number): MapPointerInput => {
      const scale = scaleOf(node);
      const state = ev.buttons ?? 0;
      // The surface fills the pane, so its origin is the pane's.
      return {
        x: ev.x / scale,
        y: ev.y / scale,
        button: ev.keycode ?? 1,
        detail,
        shiftKey: (state & 1) !== 0,
        ctrlKey: (state & 4) !== 0,
        altKey: (state & 8) !== 0,
        metaKey: (state & 64) !== 0,
      };
    };
    wnd.on('mousedown', (ev) => {
      if (!isButton(ev)) return;
      const detail = this._clickCount(ev, scaleOf(node));
      if (this._controller.pointerDown(input(ev, detail)) === 'pan') {
        this._pane?.focus?.();
      }
    });
    wnd.on('mousemove', (ev) => {
      const at = input(ev, 0);
      if (this._controller.dragging) this._controller.pointerDrag(at);
      else this._controller.pointerMove(at);
    });
    wnd.on('mouseup', (ev) => {
      if (!isButton(ev)) return;
      this._controller.pointerUp(input(ev, this._press.detail));
    });
    wnd.on('mouseout', () => this._controller.pointerLeave());
  }

  /** Core's click count, for presses core never sees: repeated presses
   *  close together in time and space count up. */
  private _clickCount(ev: NativePointer, scale: number): number {
    const at = Date.now();
    const last = this._press;
    const slop = 4 * scale;
    const detail =
      at - last.time < 400 &&
      Math.abs(ev.x - last.x) <= slop &&
      Math.abs(ev.y - last.y) <= slop
        ? last.detail + 1
        : 1;
    this._press = { time: at, x: ev.x, y: ev.y, detail };
    return detail;
  }

  // --- failure ------------------------------------------------------------------

  readonly surfaceError = (error: Error): void => {
    this._fail(error);
  };

  private _fail(error: unknown): void {
    if (this._failed) return;
    this._failed = true;
    try {
      this._renderer?.dispose();
    } catch {
      // A context that failed may not delete what it made either.
    }
    this._renderer = null;
    this.props.onFailure(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  // --- the frame ------------------------------------------------------------------

  readonly draw = (gl: unknown, info: DrawInfo): void => {
    if (this._failed) return;
    try {
      if ((gl as { backend?: string }).backend !== 'direct') {
        throw new Error(INDIRECT);
      }
      this._attachPointer(info.node);
      const controller = this._controller;
      // A fit asked for before layout had a size lands in the first frame
      // that has one, and this frame draws it.
      controller.beginFrame();
      controller.painting = true;
      try {
        this._frame(gl, info);
      } finally {
        controller.painting = false;
      }
    } catch (error) {
      // Core hands an `onDraw` throw to `<glarea onError>` and nothing else;
      // caught here, it is the map's failure, reported the one way.
      this._fail(error);
    }
  };

  private _styleNow(): { style: MapStyle; prepared: PreparedStyle } {
    const style =
      this.props.map.mapStyle ?? defaultStyleFor(isDarkTheme(this.theme));
    if (style !== this._style || !this._prepared) {
      this._style = style;
      this._prepared = prepareStyle(style);
      for (const store of this._stores.values()) {
        store.setStyle(this._prepared);
      }
    }
    return { style, prepared: this._prepared };
  }

  /** A store for every source on the map, in order; the stores of sources
   *  taken off it stop loading and keep their tiles, a couple of them. */
  private _sourcesNow(
    prepared: PreparedStyle,
  ): { source: MapSource; store: GlTileStore }[] {
    const map = this.props.map;
    const sources = map.sources ?? [];
    const out: { source: MapSource; store: GlTileStore }[] = [];
    sources.forEach((source, index) => {
      let store = this._stores.get(source);
      if (!store) {
        store = new GlTileStore({
          source,
          sourceId: source.id ?? `source-${index}`,
          prepared,
          onChange: this.request,
          onError: (error, tile) => this.props.map.onTileError?.(error, tile),
          workers: map.buildWorkers ?? 0,
        });
        this._stores.set(source, store);
      }
      out.push({ source, store });
    });
    this._inactive = this._inactive.filter((s) => !sources.includes(s));
    for (const [source, store] of this._stores) {
      if (sources.includes(source) || this._inactive.includes(source)) {
        continue;
      }
      store.abortLoads();
      this._inactive.push(source);
    }
    while (this._inactive.length > INACTIVE_STORES) {
      const old = this._inactive.shift()!;
      this._stores.get(old)?.dispose((data) => this._renderer?.release(data));
      this._stores.delete(old);
    }
    return out;
  }

  private _budget(): number | null {
    const adaptive = this.props.map.adaptive;
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
    const fadeMs = this.props.map.levelFade ?? 0;
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
      if (fade && fade.start !== null && (at - fade.start) / fadeMs >= 0.5) {
        this._shown = fade.to;
      }
      if (this._shown === to) {
        this._fade = null;
        return plain;
      }
      fade = this._fade = { to, start: null, waitSince: at };
    }
    const base = cover(this._shown);
    if (fade.start === null) {
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

  private _frame(gl: unknown, info: DrawInfo): void {
    const map = this.props.map;
    const controller = this._controller;
    const scale = scaleOf(info.node);
    if (gl !== this._gl) {
      // A new context — the surface was recreated — owns none of the old
      // one's buffers, so everything is uploaded again from the buckets the
      // stores still hold.
      this._renderer = null;
      this._gl = gl;
    }
    this._renderer ??= new GlMapRenderer(gl, {
      antialias: map.antialias,
      fillRule: map.fillRule,
    });
    const renderer = this._renderer;
    renderer.antialias = map.antialias ?? true;
    renderer.fillRule = map.fillRule ?? 'nonzero';
    const { style, prepared } = this._styleNow();
    const camera = controller.camera();
    if (this._drawnZoom !== null && this._drawnZoom !== camera.zoom) {
      this._zoomedAt = now();
    }
    this._drawnZoom = camera.zoom;
    const pane = { width: info.width / scale, height: info.height / scale };
    const at = now();
    const moving = controller.moving;
    const budget = this._budget();

    // Every source's tiles: built as far as the budget goes, then asked
    // for — the view, and the ring around it that keeps a pan's tiles warm.
    const sources = this._sourcesNow(prepared);
    const buildStart = now();
    const deadline = buildStart + BUILD_BUDGET_MS;
    let more = false;
    for (const { store } of sources) {
      store.tick();
      if (store.pump(deadline)) more = true;
    }
    const buildMs = now() - buildStart;
    const covers: SourceCover[] = sources.map(({ source, store }) => {
      const pyramid = pyramidOf(source);
      const target = renderCover(camera, pane, scale, pyramid, store, {
        padding: COVER_PADDING,
      });
      store.want(target.missing);
      return { source, store, pyramid, target };
    });

    // The level fade and adaptive quality are the first source's — the
    // basemap's; a pyramid over it is drawn at its own level throughout.
    const primary = covers[0] ?? null;
    const coverAt = (level: number): CoverResult =>
      primary
        ? renderCover(camera, pane, scale, primary.pyramid, primary.store, {
            level,
          })
        : EMPTY_COVER;
    const plan: LevelPlan = primary
      ? this._planLevels(primary.target, coverAt, at)
      : { base: EMPTY_COVER, next: null, alpha: 0 };
    if (primary && plan.base !== primary.target) {
      primary.store.want(plan.base.missing);
    }

    const frameOf = (tiles: RenderTile[][], rung: Rung): RenderFrame => ({
      width: info.width,
      height: info.height,
      zoom: camera.zoom,
      scale,
      style: prepared,
      background: style.background,
      sources: tiles,
      detail: rung.detail,
      edges: rung.edges ? undefined : false,
    });
    // The frame at a rung: the plan's levels with that rung's detail left
    // out — and, when no fade is running, a coarser level for the base.
    const build = (
      r: number,
    ): { frame: RenderFrame; fade: FadeFrame | null } => {
      const q = QUALITY_LADDER[r];
      const base: RenderTile[][] = [];
      const arriving: RenderTile[][] = [];
      covers.forEach((c, i) => {
        let own = i === 0 ? plan.base : c.target;
        if (i === 0 && q.coarser > 0 && !plan.next) {
          const coarser = Math.max(c.pyramid.minZoom, own.level - q.coarser);
          if (coarser < own.level) own = coverAt(coarser);
        }
        base.push(own.tiles);
        arriving.push(i === 0 && plan.next ? plan.next.tiles : c.target.tiles);
      });
      return {
        frame: frameOf(base, q),
        fade: plan.next
          ? { frame: frameOf(arriving, q), alpha: plan.alpha }
          : null,
      };
    };
    let rung = 0;
    let predictedMs = 0;
    if (budget !== null && moving && primary) {
      // The coarser level is what the ladder's last rungs draw, so ask for
      // it too — after the view's own tiles, which come first.
      primary.store.want(
        coverAt(Math.max(primary.pyramid.minZoom, primary.target.level - 1))
          .missing,
      );
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
    const { frame, fade } = build(rung);

    // The text: the labels, and the attribution, set in the same atlas.
    let labels: LabelBatch | null = null;
    let attribution: AttributionDraw | null = null;
    let labelMs = 0;
    if (!this._noText) {
      const started = now();
      try {
        const atlas = this._atlasFor(info.node, style, scale);
        if (atlas) {
          atlas.beginFrame(
            now() + (moving ? TEXT_BUDGET_MOVING_MS : TEXT_BUDGET_SETTLED_MS),
          );
          // The attribution before the names: it is one string, measured
          // once, and a frame whose budget went on names would leave it
          // for a later one — for as long as names keep arriving.
          attribution = this._attributionFor(atlas, frame);
          labels = this._labelsFor(atlas, frame, fade, at, moving);
          this._pumpSoon();
        }
      } catch (error) {
        // Labels are the map's to lose, not the frame's: a failure placing
        // them turns them off, once and said, and the map draws on.
        this._noText = true;
        this._atlas?.dispose();
        this._atlas = null;
        if (globals.process?.env?.NODE_ENV !== 'production') {
          globals.console?.warn(
            `@react-x11/components: <Map> stopped drawing labels: ${String(error)}`,
          );
        }
      }
      labelMs = now() - started;
    }

    // The overlays and the markers, laid out on the same world as the
    // tiles under them.
    const palette = overlayPalette(this.theme);
    const overlays = this._overlaysFor(
      renderer,
      camera,
      pane,
      scale,
      palette,
      info,
    );
    const markers = map.markers?.length
      ? this._markers.batch(
          map.markers,
          transformFor(camera, pane, DEFAULT_TILE_SIZE),
          pane,
          scale,
          palette,
        )
      : null;

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
    const calibrate = budget !== null && !moving;
    const finish = (): void => (gl as { finish?(): void }).finish?.();
    if (calibrate) finish();
    const drawStart = now();
    const stats = renderer.render(frame, {
      fade,
      labels,
      overlays,
      markers,
      attribution,
    });
    let measuredMs = 0;
    if (calibrate) {
      finish();
      measuredMs = now() - drawStart;
      // An upload is not drawing, and would teach the model it was.
      if (stats.uploads === 0) this._cost.learn(stats.instances, measuredMs);
    }
    map.onAfterDraw?.(gl, { width: info.width, height: info.height });
    for (const { store } of sources) {
      store.evict((data) => renderer.release(data));
    }

    const end = now();
    const interval = this._lastEnd === null ? 0 : end - this._lastEnd;
    this._lastEnd = end;
    let tiles = 0;
    let ready = 0;
    let fromAncestor = 0;
    let fromDescendant = 0;
    let errors = 0;
    let building = 0;
    let loading = 0;
    for (const c of covers) {
      tiles += c.target.inView.length;
      ready += c.target.own;
      fromAncestor += c.target.ancestors;
      fromDescendant += c.target.descendants;
      errors += c.store.failedAmong(c.target.inView);
      building += c.store.building;
      loading += c.store.loading;
    }
    const level = primary?.target.level ?? 0;
    this._stats = {
      renderer: 'gl',
      // Nothing rasterized, no surfaces held, and every frame whole.
      rasterMs: 0,
      surfaceBytes: 0,
      damage: null,
      draw: NO_RASTER,
      drawMs: stats.cpuMs + labelMs,
      tiles,
      ready,
      fromAncestor,
      fromDescendant,
      pending: building,
      restyling: false,
      labels: stats.labels,
      errors,
      gl: {
        interval,
        cpuMs: stats.cpuMs,
        buildMs,
        building,
        loading,
        gpuBytes: renderer.gpuBytes,
        instances: stats.instances,
        drawCalls: stats.drawCalls,
        uploads: stats.uploads,
        uploadBytes: stats.uploadBytes,
        offscreen: stats.offscreen,
        level,
        shownLevel: this._shown ?? level,
        fade: stats.fade,
        quality: rung,
        predictedMs,
        measuredMs,
        moving,
        labelCandidates: labels ? this._placer.stats.candidates : 0,
        labelsPlaced: labels ? this._placer.stats.placed : 0,
        labelMs,
        textPending: this._atlas?.pending ?? false,
      },
    };
    // A label still fading, strings this frame had no budget to measure, or
    // rasters still to go into the texture want the next frame; a raster
    // in flight asks for one itself when it lands.
    const labelling =
      labels !== null &&
      (this._placer.animating ||
        this._atlas?.starved === true ||
        this._atlas?.uploading === true);
    // An attribution this frame could not draw may have gone into the
    // texture during it — the upload happens as the labels draw, after the
    // frame chose what to draw — and then it is the next frame's.
    const wanted = this._attributionWanted;
    const attributing =
      wanted !== null && this._atlas?.entry(wanted.text, wanted.size) != null;
    if (more || this._fade || labelling || attributing) this.request();
    if (!this._announced) {
      this._announced = true;
      this._pane?.notifyA11ySceneChanged?.();
    }
    map.onFrame?.(this._stats);
  }

  /**
   * The overlays' bucket, placed for this frame: the one there is while the
   * overlays are the same array, the theme's accent the same colour and
   * the view inside the bucket's region, and a new one around the view
   * otherwise.
   */
  private _overlaysFor(
    renderer: GlMapRenderer,
    camera: MapCamera,
    pane: { width: number; height: number },
    scale: number,
    palette: OverlayPalette,
    info: DrawInfo,
  ): OverlayDraw | null {
    const overlays = this.props.map.overlays;
    let current = this._overlay;
    if (!overlays || overlays.length === 0) {
      if (current) renderer.release(current.bucket.data);
      this._overlay = null;
      return null;
    }
    if (
      !current ||
      current.overlays !== overlays ||
      current.accent !== palette.accent ||
      !regionHolds(current.bucket.region, camera, pane, scale)
    ) {
      if (current) renderer.release(current.bucket.data);
      current = this._overlay = {
        bucket: buildOverlayBucket(
          overlays,
          overlayRegion(camera, pane, scale),
          palette,
        ),
        overlays,
        accent: palette.accent,
      };
    }
    const { bucket } = current;
    return {
      data: bucket.data,
      passes: bucket.passes,
      ...regionPlacement(bucket.region, camera, info.width, info.height, scale),
    };
  }

  /**
   * The atlas every string on the map is set in — the labels, and the
   * attribution. Made on the first frame, from the app the surface belongs
   * to, and again when the face or the scale changes; null, and not asked
   * for again, when the app has no fonts.
   */
  private _atlasFor(
    node: object,
    style: MapStyle,
    scale: number,
  ): LabelAtlas | null {
    const family =
      style.fontFamily ??
      this._pane?.resolvedTextStyle?.().family ??
      'sans-serif';
    const key = `${family}|${scale}`;
    if (this._atlas && this._atlasKey === key) return this._atlas;
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
    this._atlas = new LabelAtlas(engine, { pad: 2 * Math.ceil(2 * scale) + 2 });
    this._atlas.onChange = this.request;
    this._atlasKey = key;
    this._placer.reset();
    return this._atlas;
  }

  /**
   * The frame's labels: placed over the tiles of the level being shown —
   * the arriving one, once a fade is past halfway — and batched for the
   * renderer.
   */
  private _labelsFor(
    atlas: LabelAtlas,
    frame: RenderFrame,
    fade: FadeFrame | null,
    at: number,
    moving: boolean,
  ): LabelBatch {
    const from = fade && fade.alpha >= 0.5 ? fade.frame : frame;
    const centre = project(this._controller.camera().center);
    const placement: PlacementFrame = {
      width: frame.width,
      height: frame.height,
      scale: frame.scale,
      zoom: frame.zoom,
      style: frame.style,
      tiles: from.sources.flat(),
      centerX: centre.x,
      centerY: centre.y,
      // The projection's world, which the cover lays every source out on.
      world: worldSize(frame.zoom, DEFAULT_TILE_SIZE) * frame.scale,
      now: at,
      admit: at - this._zoomedAt >= ZOOM_QUIET_MS,
      moving,
    };
    if (!moving || at - this._placedAt >= PLACE_INTERVAL_MS) {
      this._placer.place(placement, atlas);
      this._placedAt = at;
    }
    return this._placer.batch(placement, atlas);
  }

  /**
   * The attribution, as the retained renderer draws it: the same box on the
   * same pixels (`attributionLayout`), the text in the labels' face, from
   * the labels' atlas. Null while there is none to draw — `attribution=""`,
   * or no source that names one — and until its raster is in the texture,
   * so the box and its text arrive together.
   */
  private _attributionFor(
    atlas: LabelAtlas,
    frame: RenderFrame,
  ): AttributionDraw | null {
    this._attributionWanted = null;
    const map = this.props.map;
    const text = attributionOf(map.attribution, map.sources ?? []);
    if (!text) return null;
    const s = frame.scale;
    const size = ATTRIBUTION_SIZE * s;
    const box = atlas.measure(text, size);
    const entry = box ? atlas.entry(text, size) : null;
    if (!box || !entry) {
      this._attributionWanted = { text, size };
      return null;
    }
    const at = attributionLayout(
      { width: box.width / s, height: box.height / s },
      { x: 0, y: 0, width: frame.width / s, height: frame.height / s },
      s,
    );
    const palette = overlayPalette(this.theme);
    // The string sits `pad` inside its raster, and a level label's quad is
    // centred on its anchor and set on whole pixels: this anchor puts the
    // string's corner on the layout's.
    const d = this._attributionText;
    d[0] = at.x - atlas.pad + entry.width / 2;
    d[1] = at.y - atlas.pad + entry.height / 2;
    d[2] = 1;
    d[3] = 0;
    d[4] = entry.x;
    d[5] = entry.y;
    d[6] = entry.width;
    d[7] = entry.height;
    d.set(premultiplied(parseColor(palette.text) ?? BLACK), 8);
    d.fill(0, 12, 17); // no halo: the box is what it reads against
    d[17] = 1;
    return {
      box: at.box,
      boxColor: premultiplied(
        parseColor(palette.background) ?? WHITE,
        ATTRIBUTION_OPACITY,
      ),
      text: { atlas, instances: d, count: 1 },
    };
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

  /**
   * Let go of everything GL: the stores, the atlas, the renderer — all of
   * it made again, lazily, by the next frame if there is one. React's
   * strict-mode double effect is the case where there is.
   */
  dispose(): void {
    this._controller.detach(this);
    if (this._pumpTimer !== null) globals.clearTimeout(this._pumpTimer);
    this._pumpTimer = null;
    this._atlas?.dispose();
    this._atlas = null;
    this._atlasKey = '';
    for (const store of this._stores.values()) {
      store.dispose((data) => this._renderer?.release(data));
    }
    this._stores.clear();
    this._inactive = [];
    // Its buffers go with the renderer's.
    this._overlay = null;
    try {
      this._renderer?.dispose();
    } catch {
      // The surface may be gone already, and its context with it.
    }
    this._renderer = null;
    this._gl = null;
  }
}

/**
 * The GL half of `<Map>`: a pane with a `<glarea>` in it, drawn every frame
 * from vector tiles. Mounted by `<Map>` when it chooses GL; not exported
 * from the package on its own.
 */
export function GlMapPane(props: GlMapPaneProps): ReactElement {
  const theme = useTheme();
  const driver = useMemo(
    () => new GlMapDriver(props.controller, props),
    [props.controller],
  );
  driver.props = props;
  driver.theme = theme;
  useEffect(() => {
    driver.attach();
    return () => driver.dispose();
  }, [driver]);
  useEffect(() => driver.committed());
  const background = driver.background();
  return h(
    GL_PANE,
    {
      ref: driver.paneRef,
      mapController: props.controller,
      style: driver.paneStyle(props.style, background),
      role: props.role,
      'aria-label': props['aria-label'],
      'data-testname': props['data-testname'],
      ...driver.handlers,
    },
    h('glarea', {
      ref: driver.areaRef,
      style: FILL,
      clearColor: background,
      frameLoop: 'demand',
      onDraw: driver.draw,
      onError: driver.surfaceError,
    }),
  );
}

const FILL = { flexGrow: 1 };
