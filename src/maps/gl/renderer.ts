// The GL renderer: every frame drawn from geometry, nothing cached as pixels.
//
// The retained renderer's frame composites tile *surfaces*; this one's frame
// is the whole style drawn again from each tile's buckets (`./buckets.ts`),
// which is a few hundred draw calls and a few uniform writes per call. Pan,
// zoom and restyle are therefore the same operation — draw — and a
// fractional zoom is not a scaled bitmap but the vector map at that zoom,
// line widths included.
//
// The frame is **layer-major**: for each style layer, every tile's share of
// it, before the next layer. That is what the cartography needs — every
// tile's water under any tile's roads, every casing under any fill, so
// junctions knit across tile seams exactly as they do inside a tile — and it
// is cheap because each tile is **scissored** to its own square. The camera
// has no rotation, so a tile's footprint on screen is an axis-aligned
// rectangle, and a scissor is a clip that costs one call and no stencil.
// Tiles carry a buffer of geometry past their edges; the scissor is what
// keeps two tiles from drawing the same road twice.
//
// Two things a caller can ask of a frame beyond "the style, here": that it
// be **cheaper** (`detail`, `edges` — adaptive quality's levers, priced in
// advance by `estimate`), and that a second scene be **faded in** over it
// (`render(frame, fade)` — the cross-fade between two pyramid levels, drawn
// into an offscreen target and composited once).
import type { PreparedStyle } from '../paint.js';
import type { MapStyleLayer } from '../style.js';
import { resolveZoomed } from '../style.js';
import { RECORD_BYTES, TILE_EXTENT } from './buckets.js';
import type { GlTileData } from './buckets.js';
import { parseColor, premultiplied } from './color.js';
import type { Rgba } from './color.js';
import { MARKER_INSTANCE } from './markers.js';
import type { MarkerBatch } from './markers.js';
import type { OverlayPass } from './overlays.js';
import { LABEL_INSTANCE } from './placement.js';
import type { LabelBatch } from './placement.js';
import {
  ATTRIBUTES,
  BLIT_FRAGMENT,
  BLIT_VERTEX,
  COVER_FRAGMENT,
  COVER_VERTEX,
  FAN_FRAGMENT,
  FAN_VERTEX,
  LABEL_FRAGMENT,
  LABEL_VERTEX,
  LINE_FRAGMENT,
  LINE_VERTEX,
  MARKER_FRAGMENT,
  MARKER_VERTEX,
  linkProgram,
} from './shaders.js';
import type { GL, Program } from './shaders.js';
import { quadInset } from './text.js';
import type { LabelAtlas } from './text.js';

/** A rectangle in device pixels, top-left origin. */
export interface DeviceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One tile's data placed on screen. */
export interface RenderTile {
  data: GlTileData;
  /** Where the data tile's square lands, in device pixels: its top-left
   *  corner and its edge length. */
  x: number;
  y: number;
  size: number;
  /**
   * The part of the viewport this tile draws into. Its own square, unless
   * it is standing in for a tile that has no data yet — an ancestor scaled
   * up, drawn only over the square it covers for.
   */
  clip: DeviceRect;
}

/** Everything a frame is drawn from. */
export interface RenderFrame {
  /** Device pixels. */
  width: number;
  height: number;
  /** The camera zoom: what zoom ramps and layer ranges resolve at. */
  zoom: number;
  /** Device pixels per logical pixel: what style lengths are multiplied by. */
  scale: number;
  style: PreparedStyle;
  background?: string;
  /**
   * Each source's tiles, in the map's order — a basemap, then a pyramid
   * over it. Each is drawn whole, layer-major, before the next, which is
   * how the retained renderer lays one source's tiles over another's.
   */
  sources: readonly (readonly RenderTile[])[];
  /**
   * Leave out the style layers that begin within this many levels of the
   * zoom: a layer whose `minZoom` is above `zoom - detail` is skipped. `0`
   * (the default) draws what the style says.
   *
   * The layers a style brings in last as the map zooms in are its details —
   * buildings, service roads, paths, sites — so this drops exactly those, in
   * that order, and it needs nothing from the style that the style has not
   * already said.
   */
  detail?: number;
  /** The fill edge pass for this frame, over the renderer's `antialias`. */
  edges?: boolean;
}

/** A second scene, and how much of it to show over the first. */
export interface FadeFrame {
  frame: RenderFrame;
  /** `0` shows only the base scene, `1` only this one. */
  alpha: number;
}

/**
 * The attribution: a box of the theme's background, and the text in it —
 * one label's worth of instance data from the labels' atlas, set level and
 * on whole pixels.
 */
export interface AttributionDraw {
  /** Device pixels, top-left origin. */
  box: DeviceRect;
  /** Premultiplied, its opacity folded in. */
  boxColor: Rgba;
  text: LabelBatch;
}

/** The overlays' bucket, and where its units land this frame. */
export interface OverlayDraw {
  data: GlTileData;
  passes: readonly OverlayPass[];
  /** Device pixels per unit of the bucket's records. */
  unit: number;
  /** Where the bucket's origin lands, in device pixels. */
  x: number;
  y: number;
}

/** What a frame draws over its scene, in this order. */
export interface RenderExtras {
  /** A second scene, faded in over the first. */
  fade?: FadeFrame | null;
  /** The labels, over both. */
  labels?: LabelBatch | null;
  /** The overlays, over the labels — where the retained renderer draws
   *  them. */
  overlays?: OverlayDraw | null;
  /** The markers, over the labels — where the retained renderer draws
   *  them, a marker being what the user aims at. */
  markers?: MarkerBatch | null;
  /** The attribution, over everything — drawn last, as the retained
   *  renderer draws it. */
  attribution?: AttributionDraw | null;
}

export interface GlRenderOptions {
  /**
   * Draw each polygon's boundary as a half-pixel antialiased line after the
   * fill. `true` by default. There is no multisampling on these surfaces
   * (x11-dri exposes no `renderbufferStorageMultisample`), so without it a
   * fill's edge is a staircase; this is the same trade MapLibre's
   * `fill-antialias` makes.
   */
  antialias?: boolean;
  /**
   * `'nonzero'` (the default) is the rule the retained renderer fills with,
   * and costs two stencil passes, one per facing. `'evenodd'` is one pass —
   * and wrong wherever two features of one layer overlap, which real
   * landuse does: the overlap is cut out as if it were a hole.
   */
  fillRule?: 'nonzero' | 'evenodd';
  /**
   * Draw into an offscreen framebuffer and copy it to the surface. `'auto'`
   * (the default) does that only when the surface has no stencil buffer —
   * which is XQuartz's Apple-DRI surface today, whose context ntk creates
   * without one.
   */
  offscreen?: 'auto' | boolean;
}

/** What one frame cost, and what it drew. */
export interface GlRenderStats {
  tiles: number;
  layers: number;
  drawCalls: number;
  /** Segment instances drawn, every pass counted — the frame's work. */
  instances: number;
  /** Tiles uploaded this frame, and their bytes. */
  uploads: number;
  uploadBytes: number;
  /** Milliseconds on this thread issuing the frame — not the GPU's time. */
  cpuMs: number;
  offscreen: boolean;
  /** How much of a second scene was faded in; `0` when there was none. */
  fade: number;
  /** Labels drawn. */
  labels: number;
  /** Markers drawn. */
  markers: number;
  /** Overlay passes drawn — a line with a casing is two. */
  overlays: number;
}

/** A stroke: premultiplied colour, and half its width and its dash in
 *  device pixels. */
interface StrokePaint {
  color: Rgba;
  half: number;
  dash: readonly [number, number] | null;
}

/** A polygon: its colour, and its edge — the antialiasing, or an
 *  outline. */
interface FillPaint {
  color: Rgba;
  antialias: boolean;
  outline: Rgba | null;
  outlineHalf: number;
}

const CLEAR: Rgba = [0, 0, 0, 0];

interface TileGpu {
  line: unknown;
  fill: unknown;
  /** One vertex array per range start and stream: `first * 2 + (fill ? 1 : 0)`. */
  vaos: Map<number, unknown>;
  bytes: number;
}

interface Offscreen {
  fbo: unknown;
  texture: unknown;
  depth: unknown;
  width: number;
  height: number;
}

const globals = globalThis as { performance?: { now(): number } };
const now = (): number => globals.performance?.now() ?? Date.now();

/** Whether a style layer draws at this zoom, with `detail` levels of its
 *  newest layers left out — `paint.ts`'s gate, plus adaptive quality's. */
function drawsAt(layer: MapStyleLayer, zoom: number, detail: number): boolean {
  if (layer.visible === false) return false;
  if (layer.type !== 'fill' && layer.type !== 'line') return false;
  if (layer.minZoom !== undefined && zoom < layer.minZoom) return false;
  if (layer.maxZoom !== undefined && zoom >= layer.maxZoom) return false;
  if (
    detail > 0 &&
    layer.minZoom !== undefined &&
    layer.minZoom > zoom - detail
  ) {
    return false;
  }
  return true;
}

/** Label rasters taken into the atlas texture per frame at most. */
const ATLAS_UPLOADS_PER_FRAME = 24;

/** GL's own name for "which VAO is bound", which the table may not carry. */
const VERTEX_ARRAY_BINDING = 0x85b5;
const FRAMEBUFFER_BINDING = 0x8ca6;

export class GlMapRenderer {
  private readonly _gl: GL;
  private readonly _options: Required<GlRenderOptions>;
  private readonly _line: Program;
  private readonly _fan: Program;
  private readonly _cover: Program;
  private _blit: Program | null = null;
  private readonly _corners: unknown;
  private readonly _coverVao: unknown;
  private readonly _tiles = new Map<GlTileData, TileGpu>();
  private readonly _colors = new Map<string, Rgba | null>();
  private _stencil: boolean | null = null;
  /** Offscreen targets by role: `'output'` stands in for a surface with no
   *  stencil buffer, `'fade'` holds the scene being faded in. */
  private readonly _targets = new Map<string, Offscreen>();
  /** The label pass: its program, its instance buffer and the vertex array
   *  over it, and the atlas texture with the atlas generation it holds. */
  private _label: Program | null = null;
  private _labelVao: unknown = null;
  private _labelBuffer: unknown = null;
  private _marker: Program | null = null;
  private _markerVao: unknown = null;
  private _markerBuffer: unknown = null;
  private _atlasTexture: unknown = null;
  private _atlasOwner: LabelAtlas | null = null;
  private _stats: GlRenderStats = GlMapRenderer._emptyStats();
  /** Bytes of tile geometry resident on the GPU. */
  gpuBytes = 0;

  constructor(gl: GL, options: GlRenderOptions = {}) {
    this._gl = gl;
    this._options = {
      antialias: options.antialias ?? true,
      fillRule: options.fillRule ?? 'nonzero',
      offscreen: options.offscreen ?? 'auto',
    };
    this._line = linkProgram(gl, LINE_VERTEX, LINE_FRAGMENT, [
      'u_tile',
      'u_viewport',
      'u_half',
      'u_color',
      'u_dash',
      'u_part',
    ]);
    this._fan = linkProgram(gl, FAN_VERTEX, FAN_FRAGMENT, [
      'u_tile',
      'u_viewport',
    ]);
    this._cover = linkProgram(gl, COVER_VERTEX, COVER_FRAGMENT, ['u_color']);

    const previous = gl.getParameter(VERTEX_ARRAY_BINDING);
    // The quad every instance is drawn over. A capsule is a four-vertex
    // strip; a fan triangle takes the first three corners.
    this._corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._corners);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this._coverVao = gl.createVertexArray();
    gl.bindVertexArray(this._coverVao);
    gl.enableVertexAttribArray(ATTRIBUTES.a_corner);
    gl.vertexAttribPointer(ATTRIBUTES.a_corner, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(previous);
  }

  set antialias(on: boolean) {
    this._options.antialias = on;
  }

  set fillRule(rule: 'nonzero' | 'evenodd') {
    this._options.fillRule = rule;
  }

  private static _emptyStats(): GlRenderStats {
    return {
      tiles: 0,
      layers: 0,
      drawCalls: 0,
      instances: 0,
      uploads: 0,
      uploadBytes: 0,
      cpuMs: 0,
      offscreen: false,
      fade: 0,
      labels: 0,
      markers: 0,
      overlays: 0,
    };
  }

  /**
   * What a frame would cost, in the unit `stats.instances` counts — segment
   * instances, every pass included — without drawing it. The same gates the
   * frame itself applies, over the ranges' record counts, so it is a walk of
   * a few hundred numbers: cheap enough to price several versions of the
   * next frame and draw the one that fits.
   */
  estimate(frame: RenderFrame): number {
    const { width, height } = frame;
    const layers = frame.style.layers;
    const detail = frame.detail ?? 0;
    const edges = frame.edges ?? this._options.antialias;
    const stencil = this._options.fillRule === 'nonzero' ? 2 : 1;
    let work = 0;
    for (const tiles of frame.sources) {
      const visible = tiles.map(
        (t) => scissorOf(t.clip, width, height) !== null,
      );
      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i].layer;
        if (!drawsAt(layer, frame.zoom, detail)) continue;
        let records = 0;
        for (let t = 0; t < tiles.length; t++) {
          if (!visible[t]) continue;
          const draw = tiles[t].data.draws[i];
          if (!draw) continue;
          for (let r = 1; r < draw.ranges.length; r += 2) {
            records += draw.ranges[r] - 1;
          }
        }
        if (layer.type === 'fill') {
          const edge = layer.outlineColor !== undefined || edges ? 1 : 0;
          work += records * (stencil + edge);
        } else {
          work += records;
        }
      }
    }
    return work;
  }

  /**
   * Draw a frame into whatever framebuffer is bound — and, given `fade`, a
   * second scene over it at `fade.alpha`, and given `labels`, the labels
   * over both.
   *
   * The second scene is drawn whole into an offscreen target and composited
   * once, rather than layer by layer at reduced opacity: a map faded layer
   * by layer shows its casings through its fills and its water through its
   * land. Both scenes are opaque, so the composite is exactly a cross-fade.
   * Labels go on after it, at full strength: they are placed for the view,
   * not for either level, and a name that dimmed with the level it came
   * from would blink at every level change.
   */
  render(frame: RenderFrame, extras: RenderExtras = {}): GlRenderStats {
    const { fade, labels, overlays, markers, attribution } = extras;
    const gl = this._gl;
    const started = now();
    const stats = (this._stats = GlMapRenderer._emptyStats());
    const previousVao = gl.getParameter(VERTEX_ARRAY_BINDING);
    const surface = gl.getParameter(FRAMEBUFFER_BINDING);
    const { width, height } = frame;

    // Before the probe: it draws, and a context that has never had a
    // viewport set — a windowless one, bound to a framebuffer — has a 0×0
    // one, which draws nothing and reads as "no stencil".
    gl.viewport(0, 0, width, height);
    if (this._stencil === null) this._stencil = this._probeStencil();
    const mode = this._options.offscreen;
    const offscreen = mode === true || (mode === 'auto' && !this._stencil);
    stats.offscreen = offscreen;
    const output = offscreen ? this._target('output', width, height) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, output ? output.fbo : surface);

    this._scene(frame);

    if (fade && fade.alpha > 0) {
      const layer = this._target('fade', width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fbo);
      this._scene(fade.frame);
      gl.bindFramebuffer(gl.FRAMEBUFFER, output ? output.fbo : surface);
      this._composite(layer, width, height, Math.min(1, fade.alpha));
      stats.fade = Math.min(1, fade.alpha);
    }

    // Even with nothing to draw: the batch's atlas may have rasters waiting
    // for the texture, and until they are in it nothing of theirs can be.
    if (labels) stats.labels = this._labels(labels, width, height);

    if (overlays) stats.overlays = this._overlays(overlays, frame);

    if (markers) stats.markers = this._markers(markers, width, height);

    // Last, over the labels and everything else, which is where the
    // retained renderer draws it: a licence condition is not something a
    // street name may cover.
    if (attribution) this._attribution(attribution, width, height);

    if (output) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, surface);
      this._composite(output, width, height, 1);
    }
    gl.bindVertexArray(previousVao);
    stats.cpuMs = now() - started;
    return stats;
  }

  /** Drop one tile's buffers. */
  release(data: GlTileData): void {
    const gpu = this._tiles.get(data);
    if (!gpu) return;
    const gl = this._gl;
    for (const vao of gpu.vaos.values()) gl.deleteVertexArray(vao);
    if (gpu.line) gl.deleteBuffer(gpu.line);
    if (gpu.fill) gl.deleteBuffer(gpu.fill);
    this.gpuBytes -= gpu.bytes;
    this._tiles.delete(data);
  }

  /** Whether a tile's buffers are resident. */
  resident(data: GlTileData): boolean {
    return this._tiles.has(data);
  }

  dispose(): void {
    const gl = this._gl;
    for (const data of [...this._tiles.keys()]) this.release(data);
    for (const program of [
      this._line,
      this._fan,
      this._cover,
      this._blit,
      this._label,
      this._marker,
    ]) {
      if (program) gl.deleteProgram(program.program);
    }
    gl.deleteBuffer(this._corners);
    gl.deleteVertexArray(this._coverVao);
    if (this._labelVao) gl.deleteVertexArray(this._labelVao);
    if (this._labelBuffer) gl.deleteBuffer(this._labelBuffer);
    if (this._markerVao) gl.deleteVertexArray(this._markerVao);
    if (this._markerBuffer) gl.deleteBuffer(this._markerBuffer);
    if (this._atlasTexture) gl.deleteTexture(this._atlasTexture);
    for (const target of this._targets.values()) this._dropTarget(target);
    this._targets.clear();
  }

  // --- the scene ------------------------------------------------------------

  /** The whole style, into the bound framebuffer, from a clear. */
  private _scene(frame: RenderFrame): void {
    const gl = this._gl;
    const stats = this._stats;
    const { width, height } = frame;
    gl.viewport(0, 0, width, height);
    const background = premultiplied(
      this._color(frame.background ?? '#ffffff') ?? [1, 1, 1, 1],
    );
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(background[0], background[1], background[2], background[3]);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);

    for (const program of [this._line, this._fan]) {
      gl.useProgram(program.program);
      gl.uniform2f(program.uniforms.u_viewport, width, height);
    }

    const edges = frame.edges ?? this._options.antialias;
    const detail = frame.detail ?? 0;
    const layers = frame.style.layers;
    for (const tiles of frame.sources) {
      // Upload before drawing, so a frame's uploads are counted once and a
      // tile arriving mid-frame is not half drawn.
      const scissors: (number[] | null)[] = [];
      for (const tile of tiles) {
        this._gpu(tile.data);
        scissors.push(scissorOf(tile.clip, width, height));
      }
      stats.tiles += tiles.length;
      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i].layer;
        if (!drawsAt(layer, frame.zoom, detail)) continue;
        if (layer.type === 'fill') {
          if (this._fill(frame, tiles, i, layer, scissors, edges)) {
            stats.layers++;
          }
        } else if (layer.type === 'line') {
          if (this._lines(frame, tiles, i, layer, scissors)) stats.layers++;
        }
      }
    }

    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
  }

  // --- layers ---------------------------------------------------------------

  private _fill(
    frame: RenderFrame,
    tiles: readonly RenderTile[],
    index: number,
    layer: Extract<MapStyleLayer, { type: 'fill' }>,
    scissors: (number[] | null)[],
    edges: boolean,
  ): boolean {
    const zoom = frame.zoom;
    const opacity =
      layer.opacity === undefined ? 1 : resolveZoomed(layer.opacity, zoom);
    if (opacity <= 0) return false;
    const base = this._color(resolveZoomed(layer.color, zoom));
    if (!base) return false;
    const outline =
      layer.outlineColor === undefined
        ? undefined
        : this._color(resolveZoomed(layer.outlineColor, zoom));
    return this._fillWith(tiles, index, scissors, {
      color: premultiplied(base, opacity),
      // The edge: the outline colour a style asked for, at one logical
      // pixel, or else the fill colour at half a device pixel — which is
      // the antialiasing.
      antialias: !outline && edges,
      outline: outline ? premultiplied(outline, opacity) : null,
      outlineHalf: Math.max(0.5, frame.scale / 2),
    });
  }

  /**
   * A polygon's ranges, over every tile that has them: the winding number
   * into the stencil buffer, the colour wherever it is not zero, then the
   * edge — the antialiasing, or an outline.
   */
  private _fillWith(
    tiles: readonly RenderTile[],
    index: number,
    scissors: (number[] | null)[],
    paint: FillPaint,
  ): boolean {
    const gl = this._gl;
    // The cover's extent: the union of the squares this layer drew in.
    const box = this._unionOf(tiles, index, scissors);
    if (!box) return false;
    const stats = this._stats;

    // 1. The winding number, into the stencil buffer.
    gl.useProgram(this._fan.program);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    const passes: [number | null, number][] =
      this._options.fillRule === 'nonzero'
        ? [
            [gl.BACK, gl.INCR_WRAP],
            [gl.FRONT, gl.DECR_WRAP],
          ]
        : [[null, gl.INVERT]];
    for (const [cull, op] of passes) {
      if (cull === null) gl.disable(gl.CULL_FACE);
      else {
        gl.enable(gl.CULL_FACE);
        gl.cullFace(cull);
      }
      gl.stencilOp(gl.KEEP, gl.KEEP, op);
      this._eachTile(tiles, index, scissors, this._fan, true, (count) => {
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, count);
      });
    }
    gl.disable(gl.CULL_FACE);

    // 2. The colour, wherever the winding is not zero. An opaque fill sets
    // the stencil back to zero as it goes, so the next layer starts clean;
    // a translucent one keeps it for its edge, which is drawn outside the
    // polygon only — laid over the fill's own colour it would be a darker
    // rim round every translucent polygon — and clears it after.
    const translucent = paint.color[3] < 1;
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    if (translucent) gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    else gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    gl.scissor(box[0], box[1], box[2], box[3]);
    this._drawCover(paint.color);
    stats.drawCalls++;

    // 3. The edge, which is the fill stream drawn as segments.
    if (translucent) {
      if (paint.antialias) {
        // Where the winding is zero and no edge has been yet, each pixel
        // once, at what a pixel the polygon partly covers is covered by:
        // a segment of no width, whose ramp is half a pixel either side.
        gl.stencilFunc(gl.EQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
        this._segments(
          tiles,
          index,
          scissors,
          { color: paint.color, half: 0, dash: null },
          true,
          0,
        );
      }
      this._clearStencil(box);
      gl.disable(gl.STENCIL_TEST);
    } else {
      gl.disable(gl.STENCIL_TEST);
      if (paint.antialias) {
        this._strokeWith(
          tiles,
          index,
          scissors,
          { color: paint.color, half: 0.5, dash: null },
          true,
        );
      }
    }
    if (paint.outline) {
      this._strokeWith(
        tiles,
        index,
        scissors,
        { color: paint.outline, half: paint.outlineHalf, dash: null },
        true,
      );
    }
    return true;
  }

  private _lines(
    frame: RenderFrame,
    tiles: readonly RenderTile[],
    index: number,
    layer: Extract<MapStyleLayer, { type: 'line' }>,
    scissors: (number[] | null)[],
  ): boolean {
    const zoom = frame.zoom;
    const logical = resolveZoomed(layer.width, zoom);
    if (!(logical > 0)) return false;
    const opacity =
      layer.opacity === undefined ? 1 : resolveZoomed(layer.opacity, zoom);
    if (opacity <= 0) return false;
    const base = this._color(resolveZoomed(layer.color, zoom));
    if (!base) return false;
    if (!this._unionOf(tiles, index, scissors)) return false;
    // A road narrower than a pixel is drawn *at* a pixel, as paint.ts does:
    // a motorway network that vanishes at zoom 6 is worse than a heavy one.
    const width = Math.max(1, logical * frame.scale);
    const dash = layer.dash;
    this._strokeWith(
      tiles,
      index,
      scissors,
      {
        color: premultiplied(base, opacity),
        half: width / 2,
        dash:
          dash && dash.length >= 2
            ? [dash[0] * frame.scale, dash[1] * frame.scale]
            : null,
      },
      false,
    );
    return true;
  }

  /**
   * A stroke of one layer's ranges — of the line stream, or of the fill
   * stream as a polygon's outline. A translucent one is drawn each pixel
   * once: two capsules overlap at every join, and colour laid down twice
   * there is a darker bead at every vertex. So the pixels a capsule covers
   * wholly go first, under the stencil, the first capsule to reach one
   * taking it; then the antialiased fringe, where nothing has been yet.
   */
  private _strokeWith(
    tiles: readonly RenderTile[],
    index: number,
    scissors: (number[] | null)[],
    paint: StrokePaint,
    fillStream: boolean,
  ): void {
    if (paint.color[3] >= 1) {
      this._segments(tiles, index, scissors, paint, fillStream, 0);
      return;
    }
    const box = this._unionOf(tiles, index, scissors);
    if (!box) return;
    const gl = this._gl;
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.EQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    this._segments(tiles, index, scissors, paint, fillStream, 1);
    this._segments(tiles, index, scissors, paint, fillStream, 2);
    this._clearStencil(box);
    gl.disable(gl.STENCIL_TEST);
  }

  /** One layer's ranges as capsules, over every tile that has them. `part`
   *  1 draws only the pixels a capsule covers wholly, 2 only the rest, and
   *  0 both. */
  private _segments(
    tiles: readonly RenderTile[],
    index: number,
    scissors: (number[] | null)[],
    paint: StrokePaint,
    fillStream: boolean,
    part: number,
  ): void {
    const gl = this._gl;
    const u = this._line.uniforms;
    const { color, dash } = paint;
    gl.useProgram(this._line.program);
    gl.uniform4f(u.u_color, color[0], color[1], color[2], color[3]);
    gl.uniform1f(u.u_half, paint.half);
    gl.uniform2f(u.u_dash, dash ? dash[0] : 0, dash ? dash[1] : 0);
    gl.uniform1f(u.u_part, part);
    this._eachTile(tiles, index, scissors, this._line, fillStream, (count) => {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    });
  }

  /** The union of the squares a layer draws in, as a scissor box; null
   *  when no tile draws it. */
  private _unionOf(
    tiles: readonly RenderTile[],
    index: number,
    scissors: (number[] | null)[],
  ): number[] | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let t = 0; t < tiles.length; t++) {
      const s = scissors[t];
      if (!s || !tiles[t].data.draws[index]) continue;
      if (s[0] < x0) x0 = s[0];
      if (s[1] < y0) y0 = s[1];
      if (s[0] + s[2] > x1) x1 = s[0] + s[2];
      if (s[1] + s[3] > y1) y1 = s[1] + s[3];
    }
    return x0 === Infinity ? null : [x0, y0, x1 - x0, y1 - y0];
  }

  /** The stencil back to zero over a box, the colour untouched. */
  private _clearStencil(box: number[]): void {
    const gl = this._gl;
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    gl.scissor(box[0], box[1], box[2], box[3]);
    this._drawCover(CLEAR);
    this._stats.drawCalls++;
    gl.colorMask(true, true, true, true);
  }

  // --- overlays ---------------------------------------------------------------

  /**
   * The overlays, over the labels — the retained renderer's order — from
   * their bucket, placed this frame, pass by pass: a fill as a style's fill
   * layer is drawn, a stroke as its line layer is. Answers how many passes
   * it drew.
   */
  private _overlays(draw: OverlayDraw, frame: RenderFrame): number {
    const gl = this._gl;
    const { width, height, scale } = frame;
    this._gpu(draw.data);
    const clip = { x: 0, y: 0, width, height };
    const tiles: RenderTile[] = [
      {
        data: draw.data,
        x: draw.x,
        y: draw.y,
        size: draw.unit * TILE_EXTENT,
        clip,
      },
    ];
    const scissors = [scissorOf(clip, width, height)];
    gl.viewport(0, 0, width, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const program of [this._line, this._fan]) {
      gl.useProgram(program.program);
      gl.uniform2f(program.uniforms.u_viewport, width, height);
    }
    let drawn = 0;
    for (const pass of draw.passes) {
      const base = this._color(pass.color);
      if (!base) continue;
      const color = premultiplied(base, pass.opacity);
      if (pass.kind === 'fill') {
        this._fillWith(tiles, pass.index, scissors, {
          color,
          antialias: this._options.antialias,
          outline: null,
          outlineHalf: 0,
        });
      } else {
        const dash = pass.dash;
        this._strokeWith(
          tiles,
          pass.index,
          scissors,
          {
            color,
            half: (pass.width * scale) / 2,
            dash:
              dash && dash.length >= 2
                ? [dash[0] * scale, dash[1] * scale]
                : null,
          },
          pass.outline === true,
        );
      }
      drawn++;
    }
    gl.disable(gl.SCISSOR_TEST);
    return drawn;
  }

  /**
   * Every tile's ranges for one layer: scissor, place, draw. The loop the
   * whole frame is made of, so it allocates nothing and sets only what
   * changes between tiles.
   */
  private _eachTile(
    tiles: readonly RenderTile[],
    index: number,
    scissors: (number[] | null)[],
    program: Program,
    fillStream: boolean,
    draw: (instances: number) => void,
  ): void {
    const gl = this._gl;
    const stats = this._stats;
    for (let t = 0; t < tiles.length; t++) {
      const tile = tiles[t];
      const layerDraw = tile.data.draws[index];
      const s = scissors[t];
      if (!layerDraw || !s) continue;
      const gpu = this._tiles.get(tile.data);
      if (!gpu) continue;
      gl.scissor(s[0], s[1], s[2], s[3]);
      gl.uniform3f(
        program.uniforms.u_tile,
        tile.size / TILE_EXTENT,
        tile.x,
        tile.y,
      );
      // A fill layer's edges come from the fill stream too; which stream a
      // range indexes is the draw's kind, not the program's.
      const stream = fillStream || layerDraw.kind === 'fill';
      const ranges = layerDraw.ranges;
      for (let r = 0; r < ranges.length; r += 2) {
        const instances = ranges[r + 1] - 1;
        if (instances <= 0) continue;
        gl.bindVertexArray(this._vao(gpu, stream, ranges[r]));
        draw(instances);
        stats.drawCalls++;
        stats.instances += instances;
      }
    }
  }

  // --- labels -----------------------------------------------------------------

  /**
   * The attribution, over whatever is bound: its box — the cover program,
   * scissored to it — and then its text, one more label quad.
   */
  private _attribution(
    draw: AttributionDraw,
    width: number,
    height: number,
  ): void {
    const gl = this._gl;
    const box = scissorOf(draw.box, width, height);
    if (box) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(box[0], box[1], box[2], box[3]);
      gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this._drawCover(draw.boxColor);
      this._stats.drawCalls++;
      gl.disable(gl.SCISSOR_TEST);
    }
    this._labels(draw.text, width, height);
  }

  /**
   * A batch of labels, over whatever is bound: one instanced draw of the
   * batch's quads, after the atlas texture has what the batch draws.
   * Answers how many it drew.
   */
  private _labels(batch: LabelBatch, width: number, height: number): number {
    const gl = this._gl;
    const atlas = batch.atlas;
    const program = (this._label ??= linkProgram(
      gl,
      LABEL_VERTEX,
      LABEL_FRAGMENT,
      ['u_viewport', 'u_atlas', 'u_inset', 'u_image'],
    ));
    gl.activeTexture(gl.TEXTURE0);
    this._uploadAtlas(atlas);
    if (batch.count === 0) return 0;

    if (!this._labelVao) {
      this._labelBuffer = gl.createBuffer();
      this._labelVao = gl.createVertexArray();
      gl.bindVertexArray(this._labelVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._corners);
      gl.enableVertexAttribArray(ATTRIBUTES.a_corner);
      gl.vertexAttribPointer(ATTRIBUTES.a_corner, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(ATTRIBUTES.a_corner, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._labelBuffer);
      const stride = LABEL_INSTANCE * 4;
      const fields: [number, number, number][] = [
        [ATTRIBUTES.a_anchor, 4, 0],
        [ATTRIBUTES.a_rect, 4, 16],
        [ATTRIBUTES.a_ink, 4, 32],
        [ATTRIBUTES.a_halo, 4, 48],
        [ATTRIBUTES.a_params, 2, 64],
      ];
      for (const [location, size, offset] of fields) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
        gl.vertexAttribDivisor(location, 1);
      }
    }
    gl.bindVertexArray(this._labelVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._labelBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      batch.instances.subarray(0, batch.count * LABEL_INSTANCE),
      gl.STREAM_DRAW,
    );

    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program.program);
    const u = program.uniforms;
    gl.uniform2f(u.u_viewport, width, height);
    gl.uniform2f(u.u_atlas, atlas.size, atlas.size);
    gl.uniform1f(u.u_inset, quadInset(atlas.pad));
    gl.uniform1i(u.u_image, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
    this._stats.drawCalls++;
    return batch.count;
  }

  // --- markers ----------------------------------------------------------------

  /**
   * The markers, over whatever is bound: one instanced draw of a quad each,
   * every pixel shaded by its distance to the marker's outline. Answers how
   * many it drew.
   */
  private _markers(batch: MarkerBatch, width: number, height: number): number {
    if (batch.count === 0) return 0;
    const gl = this._gl;
    const program = (this._marker ??= linkProgram(
      gl,
      MARKER_VERTEX,
      MARKER_FRAGMENT,
      ['u_viewport'],
    ));
    if (!this._markerVao) {
      this._markerBuffer = gl.createBuffer();
      this._markerVao = gl.createVertexArray();
      gl.bindVertexArray(this._markerVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._corners);
      gl.enableVertexAttribArray(ATTRIBUTES.a_corner);
      gl.vertexAttribPointer(ATTRIBUTES.a_corner, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(ATTRIBUTES.a_corner, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._markerBuffer);
      const stride = MARKER_INSTANCE * 4;
      const fields: [number, number, number][] = [
        [ATTRIBUTES.a_anchor, 4, 0],
        [ATTRIBUTES.a_ink, 4, 16],
        [ATTRIBUTES.a_halo, 4, 32],
        [ATTRIBUTES.a_params, 2, 48],
      ];
      for (const [location, size, offset] of fields) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
        gl.vertexAttribDivisor(location, 1);
      }
    }
    gl.bindVertexArray(this._markerVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._markerBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      batch.instances.subarray(0, batch.count * MARKER_INSTANCE),
      gl.STREAM_DRAW,
    );
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program.program);
    gl.uniform2f(program.uniforms.u_viewport, width, height);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
    this._stats.drawCalls++;
    return batch.count;
  }

  /**
   * Take what the atlas has waiting into the texture — a few dozen rasters
   * a frame at most, so a batch landing is spread over frames rather than
   * paid in one. A texture that is new, or another atlas's, starts over:
   * the atlas queues everything again. Leaves the texture bound.
   *
   * The rasters go up as the text engine read them back — straight RGBA,
   * white where the glyphs are — because the shader reads only alpha:
   * premultiplying them first was a pass over every pixel for nothing.
   */
  private _uploadAtlas(atlas: LabelAtlas): void {
    const gl = this._gl;
    if (!this._atlasTexture || this._atlasOwner !== atlas) {
      if (this._atlasTexture) gl.deleteTexture(this._atlasTexture);
      this._atlasTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._atlasTexture);
      // Left undefined: every texel a label samples is one its own upload
      // wrote, margin included.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        atlas.size,
        atlas.size,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._atlasOwner = atlas;
      atlas.restart();
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._atlasTexture);
    }
    for (const entry of atlas.takeUploads(ATLAS_UPLOADS_PER_FRAME)) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        entry.x,
        entry.y,
        entry.width,
        entry.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        entry.pixels,
      );
      entry.ready = true;
      this._stats.uploadBytes += entry.pixels.length;
    }
  }

  // --- resources ------------------------------------------------------------

  private _color(value: string): Rgba | null {
    let color = this._colors.get(value);
    if (color === undefined) {
      color = parseColor(value);
      this._colors.set(value, color);
    }
    return color;
  }

  private _gpu(data: GlTileData): TileGpu {
    let gpu = this._tiles.get(data);
    if (gpu) return gpu;
    const gl = this._gl;
    gpu = { line: null, fill: null, vaos: new Map(), bytes: 0 };
    if (data.lineRecords > 1) {
      gpu.line = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.line);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(data.line), gl.STATIC_DRAW);
      gpu.bytes += data.line.byteLength;
    }
    if (data.fillRecords > 1) {
      gpu.fill = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.fill);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(data.fill), gl.STATIC_DRAW);
      gpu.bytes += data.fill.byteLength;
    }
    this._tiles.set(data, gpu);
    this.gpuBytes += gpu.bytes;
    this._stats.uploads++;
    this._stats.uploadBytes += gpu.bytes;
    return gpu;
  }

  /**
   * The vertex array for a range: the corner quad per vertex, and records
   * `first`, `first + 1` (and the third attribute) per instance.
   *
   * One per range because instanced attributes ignore `first` — GL 4.1 and
   * ES 3.0 have no base instance — so the range's start is baked into the
   * attribute offsets instead. A tile has one range per style layer it
   * draws, so this is two dozen small objects per tile, made once.
   */
  private _vao(gpu: TileGpu, fill: boolean, first: number): unknown {
    const key = first * 2 + (fill ? 1 : 0);
    let vao = gpu.vaos.get(key);
    if (vao) return vao;
    const gl = this._gl;
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._corners);
    gl.enableVertexAttribArray(ATTRIBUTES.a_corner);
    gl.vertexAttribPointer(ATTRIBUTES.a_corner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(ATTRIBUTES.a_corner, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, fill ? gpu.fill : gpu.line);
    const base = first * RECORD_BYTES;
    const S = RECORD_BYTES;
    gl.enableVertexAttribArray(ATTRIBUTES.a_p0);
    gl.vertexAttribPointer(ATTRIBUTES.a_p0, 2, gl.SHORT, false, S, base);
    gl.vertexAttribDivisor(ATTRIBUTES.a_p0, 1);
    gl.enableVertexAttribArray(ATTRIBUTES.a_p1);
    gl.vertexAttribPointer(ATTRIBUTES.a_p1, 2, gl.SHORT, false, S, base + S);
    gl.vertexAttribDivisor(ATTRIBUTES.a_p1, 1);
    gl.enableVertexAttribArray(ATTRIBUTES.a_x);
    if (fill) {
      gl.vertexAttribPointer(ATTRIBUTES.a_x, 2, gl.SHORT, false, S, base + 4);
    } else {
      gl.vertexAttribPointer(ATTRIBUTES.a_x, 1, gl.FLOAT, false, S, base + 4);
    }
    gl.vertexAttribDivisor(ATTRIBUTES.a_x, 1);
    gpu.vaos.set(key, vao);
    return vao;
  }

  private _drawCover(color: Rgba): void {
    const gl = this._gl;
    gl.useProgram(this._cover.program);
    gl.uniform4f(
      this._cover.uniforms.u_color,
      color[0],
      color[1],
      color[2],
      color[3],
    );
    gl.bindVertexArray(this._coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Does the bound framebuffer have a stencil buffer? Asked by drawing
   * rather than by querying, because the query differs between the default
   * framebuffer of a core profile (where `STENCIL_BITS` is gone) and a
   * user one, and the Cocoa surface is the second while XQuartz's is the
   * first. Two pixels, one read-back, on the first frame only.
   *
   * Both halves are needed, and the first version had only the second: **a
   * framebuffer with no stencil buffer passes every stencil test**, so "write
   * 1, then draw where it is 1" draws either way and cannot tell the two
   * apart. XQuartz's surface — which has none — answered yes, the frame went
   * straight to it, and every fill's cover pass painted the whole view in
   * that layer's colour. So pixel 0 asks the question that only a real
   * buffer answers "no" to: a draw where a *cleared* stencil is not zero.
   */
  private _probeStencil(): boolean {
    const gl = this._gl;
    const previousVao = gl.getParameter(VERTEX_ARRAY_BINDING);
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 2, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    // Pixel 0: stencil is 0 everywhere, so NOTEQUAL 0 must draw nothing.
    gl.scissor(0, 0, 1, 1);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    this._drawCover([1, 0, 1, 1]);
    // Pixel 1: write 1, then draw where it is 1 — which must draw.
    gl.scissor(1, 0, 1, 1);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
    gl.colorMask(false, false, false, false);
    this._drawCover([0, 0, 0, 0]);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    this._drawCover([1, 0, 1, 1]);
    gl.disable(gl.STENCIL_TEST);
    const pixels = new Uint8Array(8);
    gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(previousVao);
    const magenta = (at: number) =>
      pixels[at] > 200 && pixels[at + 1] < 60 && pixels[at + 2] > 200;
    return !magenta(0) && magenta(4);
  }

  /** An offscreen colour target with its own stencil, made or remade at
   *  this size. Leaves its framebuffer bound. */
  private _target(role: string, width: number, height: number): Offscreen {
    const gl = this._gl;
    const existing = this._targets.get(role);
    if (existing && existing.width === width && existing.height === height) {
      return existing;
    }
    if (existing) this._dropTarget(existing);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      depth,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      depth,
    );
    const target = { fbo, texture, depth, width, height };
    this._targets.set(role, target);
    return target;
  }

  /** An offscreen target onto the bound framebuffer: a copy at `alpha` 1,
   *  a cross-fade below it. */
  private _composite(
    target: Offscreen,
    width: number,
    height: number,
    alpha: number,
  ): void {
    const gl = this._gl;
    this._blit ??= linkProgram(gl, BLIT_VERTEX, BLIT_FRAGMENT, [
      'u_image',
      'u_alpha',
    ]);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    if (alpha >= 1) gl.disable(gl.BLEND);
    else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    gl.useProgram(this._blit.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(this._blit.uniforms.u_image, 0);
    gl.uniform1f(this._blit.uniforms.u_alpha, alpha);
    gl.bindVertexArray(this._coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this._stats.drawCalls++;
  }

  private _dropTarget(target: Offscreen): void {
    const gl = this._gl;
    gl.deleteFramebuffer(target.fbo);
    gl.deleteRenderbuffer(target.depth);
    gl.deleteTexture(target.texture);
  }
}

/**
 * A clip rectangle as a GL scissor box: whole pixels, bottom-left origin,
 * clamped to the viewport, or null when nothing of it is visible.
 *
 * Rounded edge by edge rather than origin-and-size, so two tiles that share
 * an edge round it to the same pixel column and neither a gap nor a double
 * row can open between them at any fractional zoom.
 */
export function scissorOf(
  clip: DeviceRect,
  width: number,
  height: number,
): number[] | null {
  const x0 = Math.max(0, Math.round(clip.x));
  const x1 = Math.min(width, Math.round(clip.x + clip.width));
  const y0 = Math.max(0, Math.round(clip.y));
  const y1 = Math.min(height, Math.round(clip.y + clip.height));
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, height - y1, x1 - x0, y1 - y0];
}
