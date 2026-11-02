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
import type {
  FlowFrameStats,
  FlowGlBodyFrame,
  FlowGlTexture,
  FlowRect,
  XYPosition,
} from '../types.js';
import type { FlowScene } from '../scene.js';
import { BOX_STRIDE, LINE_STRIDE, ScenePacker, TRI_STRIDE } from './pack.js';
import type {
  DrawRange,
  PackedBody,
  PackedScene,
  PackLayer,
  DrawnLabel,
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
  TEX_FRAGMENT,
  TEX_VERTEX,
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
  /**
   * The nodes a drag is moving and their edges, lifted out of the world —
   * which is built without them while they move — and packed on their own
   * when they changed: absent to draw the ones already on the GPU, null for
   * none. A drag step packs a card or two and their edges, where it packed
   * the whole world: 3-4 ms a step at 2,000 nodes. Drawn in two halves, its
   * edges under every card and its cards over them, as the painter orders
   * a dragged node.
   */
  lifted?: FlowScene | null;
  /**
   * Draws the GL bodies in view into their textures — before anything of
   * the frame is drawn, with the surface's framebuffer bound and put back
   * after — and answers every texture there is to draw, by node id. Left
   * out, a body's place in its card is drawn as the card. `moving` is the
   * frame's: a zoom gesture under way, which a body sits out.
   */
  bodies?: (
    inView: readonly GlBodyRequest[],
    moving: boolean,
  ) => ReadonlyMap<string, FlowGlTexture>;
}

/** A GL body in view this frame, and the texture it is wanted at. */
export interface GlBodyRequest {
  id: string;
  frame: FlowGlBodyFrame;
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

/** A GL body's side in device pixels: what its texture is asked for at, and
 *  what the quad is drawn texel for pixel at. */
function bodyPixels(logical: number, scale: number): number {
  return Math.max(1, Math.round(logical * scale));
}

/** GL's own name for "which VAO is bound", which the table may not carry. */
const VERTEX_ARRAY_BINDING = 0x85b5;
/** …and for the framebuffer bound: the Cocoa surface's is one of its own,
 *  not 0, and a body's draw binds another. */
const FRAMEBUFFER_BINDING = 0x8ca6;

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
  /** Labels drawn from their fields, and the atlas's count of dropped
   *  fields they were last checked against. */
  drawn: DrawnLabel[] = [];
  moved = -1;

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
    this.drawn = packed.drawn;
    this.moved = -1;
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

  /** Nothing to draw, until the next `update`. */
  clear(): void {
    this.packed = null;
    this.scene = null;
    this.waiting = [];
    this.drawn = [];
    this.checked = -1;
    this.moved = -1;
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
  /** The GL bodies' program, linked by the first frame that draws one: a
   *  graph with none links what it did. */
  private tex: Program | null = null;
  private readonly vao: unknown;
  /** The vertex array bound when a draw began, bound again when it ends. */
  private previousVao: unknown = null;
  private readonly quad: unknown;
  private readonly world: Layer;
  private readonly lifted: Layer;
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
    //
    // Bound for the draws and the one bound before put back after them, as
    // `<Map>`'s renderer does: on macOS every `<glarea>` in an app shares one
    // context, so what a draw leaves bound is the next surface's. Left bound
    // and then deleted when the pane went, ours left the context with no
    // vertex array at all, and a `<Canvas>` drawn after it put every vertex
    // at one point.
    const previous = gl.getParameter(VERTEX_ARRAY_BINDING);
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
    this.lifted = new Layer(gl);
    this.overlay = new Layer(gl);
    gl.bindVertexArray(previous ?? null);
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
    this.end();
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
    if (frame.lifted) {
      bytes += this.lifted.update(
        frame.lifted,
        'world',
        atlas ? (t) => atlas.quad(t, true) : undefined,
      );
    } else if (frame.lifted === null) {
      this.lifted.clear();
    }
    bytes += this.overlay.update(frame.overlay, 'overlay');
    if (atlas) {
      bytes += this.landLabels(this.world, atlas);
      bytes += this.landLabels(this.lifted, atlas, true);
    }
    const drawStart = now();

    // The bodies first, each into its own framebuffer: what they bind and
    // set is theirs, and `begin` sets everything the graph draws with again.
    const textures = this.bodyTextures(frame, target);
    this.begin(target, atlas, textures !== null);
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
    // The world's edges, the lifted edges, the world's cards, the lifted
    // cards: a dragged node's edges go under every card, and it over them.
    const world = this.world.packed;
    const lifted = this.lifted.packed;
    const half = (layer: Layer, first: boolean): void => {
      const packed = layer.packed;
      if (!packed || !layer.scene) return;
      calls += this.ranges(
        first
          ? packed.ranges.slice(0, packed.nodesAt)
          : packed.ranges.slice(packed.nodesAt),
        layer,
        layer.scene,
        frame.offset,
        frame.zoom ?? 1,
        frame.phase,
        target,
        textures,
      );
    };
    half(this.world, true);
    half(this.lifted, true);
    half(this.world, false);
    half(this.lifted, false);
    calls += this.ranges(
      over.ranges.slice(over.split),
      this.overlay,
      frame.overlay,
      ZERO,
      1,
      0,
      target,
    );
    this.end();
    const packs = [world, lifted, over].filter((p) => p != null);
    return this.stats(packStart, drawStart, bytes, calls, packs, rebuilt);
  }

  /**
   * The GL bodies in view, drawn by their owners into their textures
   * (`frame.bodies`), or null where the frame has none: no callback, no
   * body packed, or none on screen. A body packed in the overscan and not in
   * the view is not asked for anything — a pan that brings it in asks then.
   *
   * The framebuffer bound when the surface's frame began is bound again
   * whatever a body did, a throw included: on macOS it is the surface's own
   * IOSurface target, and the graph drawn into a body's would be nowhere.
   */
  private bodyTextures(
    frame: FlowGlFrame,
    target: FlowGlTarget,
  ): ReadonlyMap<string, FlowGlTexture> | null {
    if (!frame.bodies) return null;
    const zoom = frame.zoom ?? 1;
    const s = target.scale;
    const left = target.origin.x;
    const top = target.origin.y;
    const right = left + target.width / s;
    const bottom = top + target.height / s;
    const inView: GlBodyRequest[] = [];
    for (const layer of [this.world, this.lifted]) {
      const packed = layer.packed;
      if (!packed || packed.bodies.length === 0 || !layer.scene) continue;
      // the zoom the layer was built at: what its boxes are measured in
      const built = layer.scene.viewport.zoom;
      for (const body of packed.bodies) {
        const r = body.rect;
        const x = r.x * zoom + frame.offset.x;
        const y = r.y * zoom + frame.offset.y;
        if (
          x >= right ||
          y >= bottom ||
          x + r.width * zoom <= left ||
          y + r.height * zoom <= top
        ) {
          continue;
        }
        inView.push({
          id: body.id,
          frame: {
            width: bodyPixels(r.width, s),
            height: bodyPixels(r.height, s),
            scale: s * built,
            zoom: built,
          },
        });
      }
    }
    if (inView.length === 0) return null;
    const gl = this.gl;
    const surface = gl.getParameter(FRAMEBUFFER_BINDING);
    try {
      return frame.bodies(inView, frame.moving ?? false);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, surface ?? null);
    }
  }

  /** One GL body's texture in its card; false where it has none. */
  private drawBody(
    body: PackedBody,
    textures: ReadonlyMap<string, FlowGlTexture>,
    offset: XYPosition,
    zoom: number,
    target: FlowGlTarget,
  ): boolean {
    const texture = textures.get(body.id);
    if (!texture) return false;
    const gl = this.gl;
    if (!this.tex) {
      this.tex = linkProgram(gl, TEX_VERTEX, TEX_FRAGMENT, [
        ...UNIFORMS,
        'u_rect',
        'u_size',
        'u_texture',
      ]);
      gl.useProgram(this.tex.program);
      // unit 1: the label atlas has unit 0 for the whole frame
      gl.uniform1i(this.tex.uniforms.u_texture, 1);
    }
    const tex = this.tex;
    this.uniforms(tex, offset, zoom, target);
    const r = body.rect;
    gl.uniform4f(tex.uniforms.u_rect, r.x, r.y, r.width, r.height);
    // Texel for pixel where the texture is the size its box is drawn at;
    // stretched over the box where it is not — a zoom gesture, or a body
    // still showing what it drew at another size.
    const s = target.scale;
    const exact =
      zoom === 1 &&
      texture.width === bodyPixels(r.width, s) &&
      texture.height === bodyPixels(r.height, s);
    gl.uniform2f(
      tex.uniforms.u_size,
      exact ? texture.width : 0,
      exact ? texture.height : 0,
    );
    this.corners();
    for (const location of [
      ATTRIBUTES.a_i0,
      ATTRIBUTES.a_i1,
      ATTRIBUTES.a_i2,
      ATTRIBUTES.a_i3,
    ]) {
      gl.disableVertexAttribArray(location);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  /**
   * The labels of a layer packed before their fields existed, drawn from
   * them now they have landed: the flag, the place in the atlas and the
   * quad written into each box, and the stream uploaded again.
   * A label arriving used to be the world packed again once everything on
   * screen had its field — every label at once, after all of them — and is
   * now a few floats and one upload, as each lands. Answers the bytes sent.
   *
   * First, the other way: a label whose field the atlas dropped for one
   * nearer the view — or set again somewhere else — is drawn as nothing
   * and waits again, its field wanted from where it is. Only a full atlas
   * drops anything, so a graph under the limit never walks this list.
   */
  private landLabels(layer: Layer, atlas: LabelAtlas, lifted = false): number {
    const packed = layer.packed;
    if (!packed) return 0;
    const d = packed.boxes;
    let lost = 0;
    if (layer.moved !== atlas.moves) {
      layer.moved = atlas.moves;
      const kept: DrawnLabel[] = [];
      for (const l of layer.drawn) {
        if (atlas.slotOf(l.key) === l.slot) {
          kept.push(l);
          continue;
        }
        d[l.index * BOX_STRIDE + 6] = 2;
        layer.waiting.push({ index: l.index, key: l.key, text: l.text });
        atlas.want(l.key, l.text);
        lost++;
      }
      if (lost > 0) {
        layer.drawn = kept;
        packed.gaps.text += lost;
        layer.checked = -1;
      }
    }
    if (layer.waiting.length === 0 || layer.checked === atlas.generation) {
      return lost > 0 ? layer.uploadBoxes() : 0;
    }
    layer.checked = atlas.generation;
    const still: WaitingLabel[] = [];
    let landed = 0;
    for (const w of layer.waiting) {
      const q = atlas.landing(w.key, w.text, lifted);
      if (!q) {
        still.push(w);
        continue;
      }
      layer.drawn.push({
        index: w.index,
        key: q.key,
        text: w.text,
        slot: q.slot,
      });
      // the whole quad: one the pack did not measure was a box of no size
      const at = w.index * BOX_STRIDE;
      d[at] = q.x;
      d[at + 1] = q.y;
      d[at + 2] = q.w;
      d[at + 3] = q.h;
      d[at + 4] = q.margin;
      d[at + 5] = q.page;
      d[at + 6] = 1;
      d[at + 7] = q.texel;
      d[at + 12] = q.u0;
      d[at + 13] = q.v0;
      d[at + 14] = q.u1;
      d[at + 15] = q.v1;
      landed++;
    }
    if (landed === 0) return lost > 0 ? layer.uploadBoxes() : 0;
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

  private begin(
    target: FlowGlTarget,
    atlas?: LabelAtlas,
    afterBodies = false,
  ): void {
    const gl = this.gl;
    if (afterBodies) {
      // What a body may have left set that the graph's draws would trip on:
      // a map leaves its stencil test, its scissor and a face cull behind,
      // and a texture unit other than the atlas's active.
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.activeTexture(gl.TEXTURE0);
    }
    if (atlas) {
      atlas.bind(gl, !this.atlasBound);
      this.atlasBound = true;
      // how many texels a field's values span, for the label ramp
      gl.useProgram(this.box.program);
      gl.uniform1f(this.box.uniforms.u_spread, atlas.pad);
    }
    this.previousVao = gl.getParameter(VERTEX_ARRAY_BINDING);
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
    textures?: ReadonlyMap<string, FlowGlTexture> | null,
  ): number {
    let calls = 0;
    for (const range of ranges) {
      if (range.kind === 'body') {
        const body = layer.packed?.bodies[range.first];
        if (!body || !textures) continue;
        this.scissor(undefined, target);
        if (this.drawBody(body, textures, offset, zoom, target)) calls++;
        continue;
      }
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

  /** What `begin` changed that the next user of the context would trip on. */
  private end(): void {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.previousVao ?? null);
    this.previousVao = null;
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
    this.lifted.dispose();
    this.overlay.dispose();
    for (const program of [this.line, this.box, this.tri, this.grid]) {
      gl.deleteProgram(program.program);
    }
    if (this.tex) gl.deleteProgram(this.tex.program);
    gl.deleteVertexArray(this.vao);
  }
}
