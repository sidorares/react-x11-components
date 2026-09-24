// A frame, drawn. Owns the programs, two layers of instance buffers and the
// order of the frame — and nothing about the graph, which is `../scene.ts`'s,
// or about what to draw, which is `./pack.ts`'s.
//
// The two layers are the whole of the optimisation that makes a pan cheap.
// The **world** — edges, heads, chips, nodes — is packed and uploaded only
// when the element says it changed, and drawn wherever `offset` puts it; a
// pan changes the offset and nothing else, so its frame is a few uniforms and
// a handful of draw calls over buffers already on the GPU. The **overlay** —
// the background, the grid, the selection, the minimap and the controls — is
// pinned to the pane, is a few dozen boxes, and is packed every frame.
import type { FlowFrameStats, FlowRect, XYPosition } from '../types.js';
import type { FlowScene } from '../scene.js';
import { BOX_STRIDE, LINE_STRIDE, ScenePacker, TRI_STRIDE } from './pack.js';
import type {
  DrawRange,
  PackedScene,
  PackLayer,
  TextResolver,
  WaitingLabel,
} from './pack.js';
import type { LabelAtlas } from './text.js';
import {
  ATTRIBUTES,
  BOX_FRAGMENT,
  BOX_VERTEX,
  GRID_FRAGMENT,
  GRID_VERTEX,
  LINE_FRAGMENT,
  LINE_VERTEX,
  linkProgram,
  TRI_FRAGMENT,
  TRI_VERTEX,
} from './shaders.js';
import type { GL, Program } from './shaders.js';
import { ColorCache } from './color.js';

/** One frame's drawing, counted; `<Flow>` adds the scene's share. */
export type FlowGlDrawStats = Omit<
  FlowFrameStats,
  'sceneMs' | 'renderer' | 'bodies'
>;

/** Where the surface sits and how big it is: the pane's content box in
 *  logical window pixels, and the surface in device pixels. */
export interface FlowGlTarget {
  origin: XYPosition;
  scale: number;
  width: number;
  height: number;
}

/** What the element hands the renderer for one frame. */
export interface FlowGlFrame {
  /** The graph, when it changed since the last frame — null to draw the one
   *  already on the GPU where `offset` now puts it. */
  world: FlowScene | null;
  /** Where the world's pinned origin lands in the window, in logical
   *  pixels: the pane's origin plus the viewport's translation. */
  offset: XYPosition;
  /** How much the world on the GPU is magnified: the view's zoom over the
   *  zoom it was built at. 1 — or absent — except while a zoom gesture
   *  moves, when the world is drawn scaled rather than rebuilt a step. */
  zoom?: number;
  /** The pane's furniture, every frame. */
  overlay: FlowScene;
  /** How far a marching dash has moved, in the world's logical pixels — a
   *  uniform, so the dash timer's tick redraws without a rebuild. */
  phase: number;
  /** A zoom gesture is moving: a stream of zoom steps, not a single one —
   *  what the label atlas holds new strings back for. */
  moving?: boolean;
}

const UNIFORMS = [
  'u_origin',
  'u_offset',
  'u_scale',
  'u_zoom',
  'u_viewport',
] as const;

/** The clock, through `globalThis`: `src/` compiles with `types: []`. */
const globals = globalThis as { performance?: { now(): number } };
export const now = (): number => globals.performance?.now() ?? Date.now();

const ZERO: XYPosition = { x: 0, y: 0 };

/** One layer: a packer, the three buffers its streams go into, and what it
 *  last packed. */
class Layer {
  readonly packer = new ScenePacker();
  readonly lines: unknown;
  readonly boxes: unknown;
  readonly tris: unknown;
  packed: PackedScene | null = null;
  scene: FlowScene | null = null;
  /** Labels packed before their fields landed, not yet written in, and the
   *  atlas's generation they were last checked against. */
  waiting: WaitingLabel[] = [];
  checked = -1;

  constructor(private readonly gl: GL) {
    this.lines = gl.createBuffer();
    this.boxes = gl.createBuffer();
    this.tris = gl.createBuffer();
  }

  /** Pack and upload; answers the bytes sent. Orphaning with `bufferData`
   *  rather than `bufferSubData`: the driver hands back fresh storage
   *  instead of waiting for the last frame's draws to finish reading the
   *  old. */
  update(scene: FlowScene, layer: PackLayer, text?: TextResolver): number {
    const gl = this.gl;
    const packed = this.packer.pack(scene, layer, text);
    this.packed = packed;
    this.scene = scene;
    this.waiting = packed.waiting;
    this.checked = -1;
    let bytes = 0;
    const put = (buf: unknown, data: Float32Array, used: number): void => {
      if (used === 0) return;
      const view = data.subarray(0, used);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, view, gl.DYNAMIC_DRAW);
      bytes += view.byteLength;
    };
    put(this.lines, packed.lines, packed.lineCount * LINE_STRIDE);
    put(this.boxes, packed.boxes, packed.boxCount * BOX_STRIDE);
    put(this.tris, packed.tris, packed.triCount * TRI_STRIDE);
    return bytes;
  }

  /** The box stream again, whole — orphaned as `update` does, so no draw
   *  of the last frame is waited for. Answers the bytes sent. */
  uploadBoxes(): number {
    const packed = this.packed;
    if (!packed || packed.boxCount === 0) return 0;
    const gl = this.gl;
    const view = packed.boxes.subarray(0, packed.boxCount * BOX_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxes);
    gl.bufferData(gl.ARRAY_BUFFER, view, gl.DYNAMIC_DRAW);
    return view.byteLength;
  }

  dispose(): void {
    for (const buffer of [this.lines, this.boxes, this.tris]) {
      this.gl.deleteBuffer(buffer);
    }
  }
}

export class FlowGlRenderer {
  private readonly gl: GL;
  private readonly line: Program;
  private readonly box: Program;
  private readonly tri: Program;
  private readonly grid: Program;
  private readonly vao: unknown;
  private readonly quad: unknown;
  private readonly world: Layer;
  private readonly overlay: Layer;
  private readonly colors = new ColorCache();
  /** Whether this context has had the atlas's texture made in it — a new
   *  renderer is a new context, into which every raster is uploaded again. */
  private atlasBound = false;

  constructor(gl: GL) {
    this.gl = gl;
    this.line = linkProgram(gl, LINE_VERTEX, LINE_FRAGMENT, [
      ...UNIFORMS,
      'u_phase',
    ]);
    this.box = linkProgram(gl, BOX_VERTEX, BOX_FRAGMENT, [
      ...UNIFORMS,
      'u_atlas',
      'u_spread',
    ]);
    // the label atlas is always on unit 0
    gl.useProgram(this.box.program);
    gl.uniform1i(this.box.uniforms.u_atlas, 0);
    this.tri = linkProgram(gl, TRI_VERTEX, TRI_FRAGMENT, UNIFORMS);
    this.grid = linkProgram(gl, GRID_VERTEX, GRID_FRAGMENT, [
      ...UNIFORMS,
      'u_grid',
      'u_mark',
      'u_color',
    ]);
    // A core profile draws nothing with no vertex array bound. One is enough:
    // every range re-points the attributes at its own offset anyway, because
    // GLSL ES 1.00 has no base instance to do it for us.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.world = new Layer(gl);
    this.overlay = new Layer(gl);
  }

  /** A whole scene, in one layer, at no offset — what a test or a one-off
   *  render wants, and the same drawing the two-layer frame composes. */
  draw(
    scene: FlowScene,
    target: FlowGlTarget,
    atlas?: LabelAtlas,
  ): FlowGlDrawStats {
    const packStart = now();
    const bytes = this.overlay.update(
      scene,
      'all',
      atlas ? (t) => atlas.quad(t) : undefined,
    );
    const drawStart = now();
    this.begin(target, atlas);
    const packed = this.overlay.packed!;
    // Every marching edge in one scene has the same phase baked in.
    const phase = scene.edges.find((e) => e.animated)?.dashOffset ?? 0;
    const calls = this.ranges(
      packed.ranges,
      this.overlay,
      scene,
      ZERO,
      1,
      phase,
      target,
    );
    this.gl.disable(this.gl.SCISSOR_TEST);
    return this.stats(packStart, drawStart, bytes, calls, [packed], false);
  }

  /** One frame: the overlay under the world, the world at its offset, the
   *  overlay over it. */
  drawFrame(
    frame: FlowGlFrame,
    target: FlowGlTarget,
    atlas?: LabelAtlas,
  ): FlowGlDrawStats {
    const packStart = now();
    let bytes = 0;
    const rebuilt = frame.world != null;
    if (frame.world) {
      atlas?.beginPack();
      bytes += this.world.update(
        frame.world,
        'world',
        atlas ? (t) => atlas.quad(t) : undefined,
      );
    }
    bytes += this.overlay.update(frame.overlay, 'overlay');
    if (atlas) bytes += this.landLabels(this.world, atlas);
    const drawStart = now();

    this.begin(target, atlas);
    const over = this.overlay.packed!;
    let calls = this.ranges(
      over.ranges.slice(0, over.split),
      this.overlay,
      frame.overlay,
      ZERO,
      1,
      0,
      target,
    );
    const world = this.world.packed;
    if (world && this.world.scene) {
      calls += this.ranges(
        world.ranges,
        this.world,
        this.world.scene,
        frame.offset,
        frame.zoom ?? 1,
        frame.phase,
        target,
      );
    }
    calls += this.ranges(
      over.ranges.slice(over.split),
      this.overlay,
      frame.overlay,
      ZERO,
      1,
      0,
      target,
    );
    this.gl.disable(this.gl.SCISSOR_TEST);
    const packs = world ? [world, over] : [over];
    return this.stats(packStart, drawStart, bytes, calls, packs, rebuilt);
  }

  /**
   * The labels of a layer packed before their fields existed, drawn from
   * them now they have landed: the flag, the place in the atlas and the
   * field's own size written into each box, and the stream uploaded again.
   * A label arriving used to be the world packed again once everything on
   * screen had its field — every label at once, after all of them — and is
   * now a few floats and one upload, as each lands. Answers the bytes sent.
   */
  private landLabels(layer: Layer, atlas: LabelAtlas): number {
    const packed = layer.packed;
    if (!packed || layer.waiting.length === 0) return 0;
    if (layer.checked === atlas.generation) return 0;
    layer.checked = atlas.generation;
    const d = packed.boxes;
    const still: WaitingLabel[] = [];
    let landed = 0;
    for (const w of layer.waiting) {
      const field = atlas.landed(w.key);
      if (!field) {
        still.push(w);
        continue;
      }
      const at = w.index * BOX_STRIDE;
      const texel = d[at + 7];
      d[at + 2] = field.columns * texel;
      d[at + 3] = field.rows * texel;
      d[at + 6] = 1;
      d[at + 12] = field.u0;
      d[at + 13] = field.v0;
      d[at + 14] = field.u1;
      d[at + 15] = field.v1;
      landed++;
    }
    if (landed === 0) return 0;
    layer.waiting = still;
    packed.gaps.text -= landed;
    return layer.uploadBoxes();
  }

  private stats(
    packStart: number,
    drawStart: number,
    uploadBytes: number,
    drawCalls: number,
    packs: readonly PackedScene[],
    worldRebuilt: boolean,
  ): FlowGlDrawStats {
    let lines = 0;
    let boxes = 0;
    let triangles = 0;
    const gaps = { text: 0, custom: 0 };
    for (const p of packs) {
      lines += p.lineCount;
      boxes += p.boxCount;
      triangles += p.triCount / 3;
      gaps.text += p.gaps.text;
      gaps.custom += p.gaps.custom;
    }
    return {
      packMs: drawStart - packStart,
      drawMs: now() - drawStart,
      drawCalls,
      lines,
      boxes,
      triangles,
      uploadBytes,
      worldRebuilt,
      gaps,
    };
  }

  private begin(target: FlowGlTarget, atlas?: LabelAtlas): void {
    const gl = this.gl;
    if (atlas) {
      atlas.bind(gl, !this.atlasBound);
      this.atlasBound = true;
      // how many texels a field's values span, for the label ramp
      gl.useProgram(this.box.program);
      gl.uniform1f(this.box.uniforms.u_spread, atlas.pad);
    }
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    // premultiplied, which is what every colour `./color.ts` hands back is
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private ranges(
    ranges: readonly DrawRange[],
    layer: Layer,
    scene: FlowScene,
    offset: XYPosition,
    zoom: number,
    phase: number,
    target: FlowGlTarget,
  ): number {
    let calls = 0;
    for (const range of ranges) {
      this.scissor(range.scissor, target);
      if (range.kind === 'grid') {
        if (!scene.grid) continue;
        this.drawGrid(scene, target);
      } else if (range.kind === 'line') {
        this.drawInstances(
          this.line,
          layer.lines,
          LINE_STRIDE,
          range,
          offset,
          zoom,
          target,
          phase,
        );
      } else if (range.kind === 'box') {
        this.drawInstances(
          this.box,
          layer.boxes,
          BOX_STRIDE,
          range,
          offset,
          zoom,
          target,
        );
      } else {
        this.drawTriangles(layer.tris, range, offset, zoom, target);
      }
      calls++;
    }
    return calls;
  }

  private uniforms(
    program: Program,
    offset: XYPosition,
    zoom: number,
    target: FlowGlTarget,
  ): void {
    const gl = this.gl;
    gl.useProgram(program.program);
    gl.uniform2f(program.uniforms.u_origin, target.origin.x, target.origin.y);
    gl.uniform2f(program.uniforms.u_offset, offset.x, offset.y);
    gl.uniform1f(program.uniforms.u_scale, target.scale);
    gl.uniform1f(program.uniforms.u_zoom, zoom);
    gl.uniform2f(program.uniforms.u_viewport, target.width, target.height);
  }

  /** The quad's corners at location 0, stepping per vertex. */
  private corners(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(ATTRIBUTES.a_corner);
    gl.vertexAttribPointer(ATTRIBUTES.a_corner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(ATTRIBUTES.a_corner, 0);
  }

  private drawInstances(
    program: Program,
    buffer: unknown,
    stride: number,
    range: DrawRange,
    offset: XYPosition,
    zoom: number,
    target: FlowGlTarget,
    phase?: number,
  ): void {
    const gl = this.gl;
    this.uniforms(program, offset, zoom, target);
    // only the line program declares it, and only after `uniforms` has made
    // that program current
    if (phase !== undefined) gl.uniform1f(program.uniforms.u_phase, phase);
    this.corners();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const bytes = stride * 4;
    const base = range.first * bytes;
    const slots = [
      ATTRIBUTES.a_i0,
      ATTRIBUTES.a_i1,
      ATTRIBUTES.a_i2,
      ATTRIBUTES.a_i3,
    ];
    slots.forEach((location, i) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        4,
        gl.FLOAT,
        false,
        bytes,
        base + i * 16,
      );
      gl.vertexAttribDivisor(location, 1);
    });
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, range.count);
  }

  private drawTriangles(
    buffer: unknown,
    range: DrawRange,
    offset: XYPosition,
    zoom: number,
    target: FlowGlTarget,
  ): void {
    const gl = this.gl;
    this.uniforms(this.tri, offset, zoom, target);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const bytes = TRI_STRIDE * 4;
    // Per vertex, not per instance: a triangle is three records.
    gl.enableVertexAttribArray(ATTRIBUTES.a_corner);
    gl.vertexAttribPointer(ATTRIBUTES.a_corner, 2, gl.FLOAT, false, bytes, 0);
    gl.vertexAttribDivisor(ATTRIBUTES.a_corner, 0);
    gl.enableVertexAttribArray(ATTRIBUTES.a_i0);
    gl.vertexAttribPointer(ATTRIBUTES.a_i0, 4, gl.FLOAT, false, bytes, 8);
    gl.vertexAttribDivisor(ATTRIBUTES.a_i0, 0);
    for (const location of [
      ATTRIBUTES.a_i1,
      ATTRIBUTES.a_i2,
      ATTRIBUTES.a_i3,
    ]) {
      gl.disableVertexAttribArray(location);
    }
    gl.drawArrays(gl.TRIANGLES, range.first, range.count);
  }

  private drawGrid(scene: FlowScene, target: FlowGlTarget): void {
    const gl = this.gl;
    const grid = scene.grid!;
    this.uniforms(this.grid, ZERO, 1, target);
    this.corners();
    for (const location of [
      ATTRIBUTES.a_i0,
      ATTRIBUTES.a_i1,
      ATTRIBUTES.a_i2,
      ATTRIBUTES.a_i3,
    ]) {
      gl.disableVertexAttribArray(location);
    }
    const zoom = scene.viewport.zoom;
    const variant =
      grid.variant === 'lines' ? 1 : grid.variant === 'cross' ? 2 : 0;
    // A mark's on-screen size, the 2D path's own arithmetic: a dot is
    // `size * 2 * zoom` across (at least a pixel) and a cross's arm
    // `size * 3 * zoom` (at least two).
    const mark =
      variant === 0
        ? Math.max(1, Math.round(grid.size * 2 * zoom))
        : variant === 2
          ? Math.max(2, grid.size * 3 * zoom)
          : 1;
    const color = this.colors.get(grid.color);
    gl.uniform3f(
      this.grid.uniforms.u_grid,
      grid.origin.x,
      grid.origin.y,
      grid.step,
    );
    gl.uniform2f(this.grid.uniforms.u_mark, variant, mark);
    gl.uniform4f(
      this.grid.uniforms.u_color,
      color[0],
      color[1],
      color[2],
      color[3],
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private scissor(rect: FlowRect | undefined, target: FlowGlTarget): void {
    const gl = this.gl;
    if (!rect) {
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    const s = target.scale;
    const x = Math.floor((rect.x - target.origin.x) * s);
    const y = Math.floor((rect.y - target.origin.y) * s);
    const w = Math.ceil(rect.width * s);
    const h = Math.ceil(rect.height * s);
    gl.enable(gl.SCISSOR_TEST);
    // GL's scissor counts up from the bottom; the scene counts down.
    gl.scissor(x, target.height - (y + h), w, h);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.quad);
    this.world.dispose();
    this.overlay.dispose();
    for (const program of [this.line, this.box, this.tri, this.grid]) {
      gl.deleteProgram(program.program);
    }
    gl.deleteVertexArray(this.vao);
  }
}
