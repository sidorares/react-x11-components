// A `FlowScene` packed for the GPU: three instance streams and the order to
// draw them in.
//
// This is `../paint.ts`'s counterpart, and the two differ in exactly the way
// the renderers do. The 2D painter's job is to issue as few *requests* as it
// can, so it buckets by pen and batches past a threshold. This one's job is
// to issue as few *draw calls* as it can while keeping the 2D painter's
// **z-order to the element** — so rather than bucketing, it appends every
// shape to one of three streams in scene order and records where each run
// of one kind begins and ends. A frame is a handful of ranged instanced draws
// walked in that order.
//
// The one program that makes that cheap is the rounded box
// (`./shaders.ts`): a disc is a box of side 2r with a corner radius of r, so
// a card, its accent, a handle, a grip, a label chip, the selection and the
// whole minimap are *one* stream, and a node's handles land above its card
// and below the next node's with no extra draw between them.
//
// Pure, and in the scene's own units — logical window pixels. The renderer
// moves to device pixels in the vertex shader, once, which is `../draw.ts`'s
// single multiply on the way to the context, done on the GPU.
import type { FlowRect, XYPosition } from '../types.js';
import type {
  FlowScene,
  SceneHandle,
  SceneRect,
  SceneRule,
  SceneText,
} from '../scene.js';
import { ColorCache } from './color.js';
import type { Rgba } from './color.js';
import type { GlyphQuad } from './text.js';

/** Turns a string into the quad that draws it — `./text.ts`'s atlas, or
 *  nothing, in which case the string is counted as a gap. */
export type TextResolver = (text: SceneText) => GlyphQuad | null;

/** Floats per line segment: the ends; then half-width, the distance along
 *  the line at the first end, and the dash; then the dash's offset and
 *  whether it marches; then the colour. */
export const LINE_STRIDE = 16;
/** Floats per box: the rect, the corner radius and border width, the fill,
 *  the border colour. A *label* is a box too — its rect the raster's, a flag
 *  where the corner radius's neighbours are, its ink in the fill and its
 *  place in the atlas where a border colour would be — so labels share the
 *  box stream and land in it exactly where the 2D painter draws them. */
export const BOX_STRIDE = 16;
/** Floats per triangle *vertex*: position and colour. */
export const TRI_STRIDE = 6;

/** One run of one kind of instance, drawn in turn. `scissor` limits it to a
 *  rect — the minimap's viewport box is allowed to spill past the panel in
 *  the scene and has to be cut, as the 2D painter's `clipRect` cuts it. */
export interface DrawRange {
  kind: 'grid' | 'line' | 'box' | 'tri';
  first: number;
  count: number;
  scissor?: FlowRect;
}

/** What {@link packScene} could not put on the GPU, counted rather than
 *  dropped silently — the renderer reports it, and a caller deciding
 *  whether GL is good enough for a graph reads it. */
export interface PackGaps {
  /** Strings: node labels, descriptions, edge labels, handle labels. The
   *  label atlas is the next piece of work (`docs/prd-flow-gl.md`). */
  text: number;
  /** Nodes whose type draws itself through `paint`, which is a 2D API. */
  custom: number;
}

/**
 * Which part of a scene to pack.
 *
 * The GL renderer keeps the graph — edges, heads, chips, nodes, the line a
 * connection gesture draws — as a **world** it packs only when it changes,
 * built at a pinned origin so that a pan moves a uniform and repacks
 * nothing. What is pinned to the *pane* rather than to the graph is the
 * **overlay**, packed every frame because it is a handful of boxes: the
 * background and the grid under the world, the selection rectangle, the
 * minimap and the controls over it. `'all'` is both, in one pass, in the 2D
 * painter's order.
 */
export type PackLayer = 'all' | 'world' | 'overlay';

export interface PackedScene {
  lines: Float32Array;
  lineCount: number;
  boxes: Float32Array;
  boxCount: number;
  tris: Float32Array;
  triCount: number;
  ranges: DrawRange[];
  /** For an overlay: the ranges before this index go under the world and
   *  the rest over it. */
  split: number;
  gaps: PackGaps;
}

/**
 * A growable Float32Array, reused frame to frame: a scene is repacked every
 * frame the graph changes, and allocating its buffers each time is exactly
 * the garbage `../scene.ts`'s route cache exists to avoid.
 */
class Stream {
  data: Float32Array;
  length = 0;

  constructor(
    private readonly stride: number,
    capacity: number,
  ) {
    this.data = new Float32Array(stride * capacity);
  }

  reset(): void {
    this.length = 0;
  }

  /** Room for one more record; answers its offset. */
  next(): number {
    const at = this.length * this.stride;
    if (at + this.stride > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.length++;
    return at;
  }
}

/** Packs scenes into streams it owns and reuses. One per renderer. */
export class ScenePacker {
  private readonly colors = new ColorCache();
  private readonly lineStream = new Stream(LINE_STRIDE, 1024);
  private readonly boxStream = new Stream(BOX_STRIDE, 256);
  private readonly triStream = new Stream(TRI_STRIDE, 256);
  private ranges: DrawRange[] = [];
  private gaps: PackGaps = { text: 0, custom: 0 };
  /** The scissor for whatever is appended until it is changed. */
  private scissor: FlowRect | undefined;

  private text: TextResolver | undefined;

  pack(
    scene: FlowScene,
    layer: PackLayer = 'all',
    text?: TextResolver,
  ): PackedScene {
    this.text = text;
    const world = layer !== 'overlay';
    const overlay = layer !== 'world';
    this.lineStream.reset();
    this.boxStream.reset();
    this.triStream.reset();
    this.ranges = [];
    this.gaps = { text: 0, custom: 0 };
    this.scissor = undefined;

    let split = 0;
    if (scene.region) {
      if (overlay) {
        if (scene.background) this.box(scene.background);
        if (scene.grid) this.ranges.push({ kind: 'grid', first: 0, count: 1 });
      }
      split = this.ranges.length;
    }
    if (scene.region && world) {
      // Every stroke, then every head, then every chip, then every label:
      // the painter's order, and the reason a label sits above the edge
      // that crosses the one it names.
      for (const edge of scene.edges) {
        const dash = dashPair(edge.dash);
        // A marching dash is packed with no phase and a flag: the renderer
        // adds the phase as a uniform, so the timer's tick is a frame, not a
        // world rebuilt (`./renderer.ts`, `u_phase`).
        this.polyline(
          edge.points,
          edge.lineWidth,
          this.colors.get(edge.stroke),
          dash[0],
          dash[1],
          edge.animated ? 0 : edge.dashOffset,
          edge.animated,
        );
      }
      // The heads in two passes — every fill, then every outline and open
      // head — as the 2D painter draws its filled bucket before its stroked
      // one. One pass per head alternated triangle and line and opened two
      // draw ranges an arrowhead: 807 draw calls for 200 nodes, where two
      // are enough. Heads almost never overlap one another, so the order
      // within the layer is not something anyone can see.
      for (const edge of scene.edges) {
        for (const marker of edge.markers) {
          if (marker.filled) {
            this.polygon(marker.points, this.colors.get(marker.color));
          }
        }
      }
      for (const edge of scene.edges) {
        for (const marker of edge.markers) {
          const color = this.colors.get(marker.color);
          if (marker.filled) {
            // Flat triangles are not antialiased; a hairline round the same
            // outline in the same colour is, and it is what the 2D fill's
            // own coverage looks like at its edge.
            this.polyline(closed(marker.points), 1, color, 0, 0, 0);
          } else {
            this.polyline(marker.points, marker.lineWidth, color, 0, 0, 0);
          }
        }
      }
      for (const edge of scene.edges) if (edge.chip) this.box(edge.chip);
      for (const edge of scene.edges) if (edge.label) this.label(edge.label);

      for (const node of scene.nodes) {
        if (node.custom) {
          this.gaps.custom++;
        } else if (node.card) {
          this.box(node.card.shape);
          if (node.card.accent) this.box(node.card.accent);
          for (const ink of node.ink) this.ink(ink);
        }
        for (const handle of node.handles) this.handle(handle);
        for (const grip of node.grips) this.box(grip);
      }

      if (scene.connection) {
        const c = scene.connection;
        const dash = dashPair(c.dash);
        this.polyline(
          c.points,
          c.lineWidth,
          this.colors.get(c.stroke),
          dash[0],
          dash[1],
          0,
        );
        this.handle(c.tip);
      }
    }
    if (scene.region && overlay) {
      split = layer === 'overlay' ? split : this.ranges.length;
      if (scene.selection) this.box(scene.selection);

      if (scene.miniMap) {
        const map = scene.miniMap;
        this.box(map.panel);
        this.scissor = map.panel.rect;
        for (const n of map.nodes) this.box(n);
        this.box(map.view);
        this.scissor = undefined;
      }
      if (scene.controls) {
        this.box(scene.controls.panel);
        for (const rule of scene.controls.rules) this.rule(rule);
        for (const glyph of scene.controls.glyphs) {
          const color = this.colors.get(glyph.color);
          for (const run of glyph.runs) {
            this.polyline(run, glyph.lineWidth, color, 0, 0, 0);
          }
        }
      }
    }

    return {
      lines: this.lineStream.data,
      lineCount: this.lineStream.length,
      boxes: this.boxStream.data,
      boxCount: this.boxStream.length,
      tris: this.triStream.data,
      triCount: this.triStream.length,
      ranges: this.ranges,
      split,
      gaps: this.gaps,
    };
  }

  /** Extend the last range when it is the same kind under the same scissor,
   *  or open a new one — which is what keeps a frame to a handful of draws
   *  however the kinds interleave. */
  private record(kind: 'line' | 'box' | 'tri', first: number): void {
    const last = this.ranges[this.ranges.length - 1];
    if (last && last.kind === kind && last.scissor === this.scissor) {
      last.count++;
      return;
    }
    this.ranges.push({ kind, first, count: 1, scissor: this.scissor });
  }

  private box(item: SceneRect): void {
    const { rect } = item;
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const fill = this.colors.get(item.fill);
    const border = item.stroke ? this.colors.get(item.stroke) : null;
    this.boxRaw(
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      item.radius,
      border ? (item.lineWidth ?? 1) : 0,
      fill,
      border ?? fill,
    );
  }

  private boxRaw(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    border: number,
    fill: Rgba,
    ring: Rgba,
  ): void {
    const s = this.boxStream;
    const index = s.length;
    const at = s.next();
    const d = s.data;
    d[at] = x;
    d[at + 1] = y;
    d[at + 2] = w;
    d[at + 3] = h;
    d[at + 4] = radius;
    d[at + 5] = border;
    d[at + 6] = 0;
    d[at + 7] = 0;
    d[at + 8] = fill[0];
    d[at + 9] = fill[1];
    d[at + 10] = fill[2];
    d[at + 11] = fill[3];
    d[at + 12] = ring[0];
    d[at + 13] = ring[1];
    d[at + 14] = ring[2];
    d[at + 15] = ring[3];
    this.record('box', index);
  }

  /**
   * A handle as a box whose corners meet. The 2D painter strokes a circle's
   * outline *centred* on its edge — half the pen outside the radius — where
   * a box's border is inset, so the disc is grown by half the pen to put the
   * ring where the circle's was.
   */
  private handle(h: SceneHandle): void {
    const pen = h.stroke ? (h.lineWidth ?? 1) : 0;
    const r = h.radius + pen / 2;
    const fill = this.colors.get(h.fill);
    const ring = h.stroke ? this.colors.get(h.stroke) : fill;
    this.boxRaw(h.at.x - r, h.at.y - r, r * 2, r * 2, r, pen, fill, ring);
    if (h.label) this.label(h.label);
  }

  /** A string as a box that samples the atlas; counted as a gap when the
   *  atlas has nothing to draw it from yet. */
  private label(t: SceneText): void {
    const q = this.text?.(t);
    if (!q) {
      this.gaps.text++;
      return;
    }
    const color = this.colors.get(t.color);
    if (color[3] <= 0) return;
    const s = this.boxStream;
    const index = s.length;
    const at = s.next();
    const d = s.data;
    d[at] = q.x;
    d[at + 1] = q.y;
    d[at + 2] = q.w;
    d[at + 3] = q.h;
    d[at + 4] = 0;
    d[at + 5] = 0;
    d[at + 6] = 1; // a label, not a box
    d[at + 7] = 0;
    d[at + 8] = color[0];
    d[at + 9] = color[1];
    d[at + 10] = color[2];
    d[at + 11] = color[3];
    d[at + 12] = q.u0;
    d[at + 13] = q.v0;
    d[at + 14] = q.u1;
    d[at + 15] = q.v1;
    this.record('box', index);
  }

  private ink(item: SceneText | SceneRule): void {
    if (item.kind === 'text') this.label(item);
    else this.rule(item);
  }

  private rule(item: SceneRule): void {
    // A hairline across or down — every rule a scene draws, the one under a
    // title bar and the one between two control buttons — is a box: the
    // pixels of the butt-capped stroke the 2D painter lays. As a line it put
    // the line program between a card's boxes, and a range is one program:
    // every card with a title bar opened three draw ranges where the rest
    // of the world's nodes shared one — 566 draws a frame on a board of
    // widget cards, each two dozen calls into the GL bridge.
    const [a, b] = item.points;
    if (item.points.length === 2 && (a.y === b.y || a.x === b.x)) {
      const color = this.colors.get(item.color);
      if (color[3] <= 0) return;
      const half = item.lineWidth / 2;
      if (a.y === b.y) {
        const w = Math.abs(b.x - a.x);
        if (w > 0) {
          this.boxRaw(
            Math.min(a.x, b.x),
            a.y - half,
            w,
            item.lineWidth,
            0,
            0,
            color,
            color,
          );
        }
      } else {
        const h = Math.abs(b.y - a.y);
        if (h > 0) {
          this.boxRaw(
            a.x - half,
            Math.min(a.y, b.y),
            item.lineWidth,
            h,
            0,
            0,
            color,
            color,
          );
        }
      }
      return;
    }
    this.polyline(
      item.points,
      item.lineWidth,
      this.colors.get(item.color),
      0,
      0,
      0,
    );
  }

  /** A polyline as capsule segments, carrying the distance along it so a
   *  dash runs continuously round every vertex. */
  private polyline(
    points: readonly XYPosition[],
    lineWidth: number,
    color: Rgba,
    dashOn: number,
    dashOff: number,
    dashOffset: number,
    marching = false,
  ): void {
    if (points.length < 2 || color[3] <= 0) return;
    const s = this.lineStream;
    const half = lineWidth / 2;
    let along = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const index = s.length;
      const at = s.next();
      const d = s.data;
      d[at] = a.x;
      d[at + 1] = a.y;
      d[at + 2] = b.x;
      d[at + 3] = b.y;
      d[at + 4] = half;
      d[at + 5] = along;
      d[at + 6] = dashOn;
      d[at + 7] = dashOff;
      d[at + 8] = dashOffset;
      d[at + 9] = marching ? 1 : 0;
      d[at + 10] = 0;
      d[at + 11] = 0;
      d[at + 12] = color[0];
      d[at + 13] = color[1];
      d[at + 14] = color[2];
      d[at + 15] = color[3];
      this.record('line', index);
      along += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }

  /** A convex polygon as a triangle fan off its first vertex. Arrowheads
   *  are the only filled polygons a graph draws, and both kinds are
   *  convex. */
  private polygon(points: readonly XYPosition[], color: Rgba): void {
    if (points.length < 3 || color[3] <= 0) return;
    const s = this.triStream;
    for (let i = 1; i + 1 < points.length; i++) {
      for (const p of [points[0], points[i], points[i + 1]]) {
        const index = s.length;
        const at = s.next();
        const d = s.data;
        d[at] = p.x;
        d[at + 1] = p.y;
        d[at + 2] = color[0];
        d[at + 3] = color[1];
        d[at + 4] = color[2];
        d[at + 5] = color[3];
        this.record('tri', index);
      }
    }
  }
}

/**
 * A canvas dash pattern as the one on/off pair the line program draws.
 * `[a]` means `[a, a]`, as `setLineDash` repeats an odd-length list; a
 * longer pattern keeps its first pair. Every pattern a graph draws by
 * default is a pair, and a user `style.dash` of more is rare enough to say
 * so rather than to pay a second uniform block for.
 */
function dashPair(dash: readonly number[] | undefined): [number, number] {
  if (!dash || dash.length === 0) return [0, 0];
  if (dash.length === 1) return [dash[0], dash[0]];
  return [dash[0], dash[1]];
}

function closed(points: readonly XYPosition[]): XYPosition[] {
  return points.length > 0 ? [...points, points[0]] : [];
}
