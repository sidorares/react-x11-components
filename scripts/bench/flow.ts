// The `<Flow>` profile: what a frame costs today, what it would cost on the
// GPU, and what the display will actually deliver.
//
//   npx tsx scripts/bench/flow.ts                       # every stage
//   npx tsx scripts/bench/flow.ts --stage=retained
//   npx tsx scripts/bench/flow.ts --stage=gl --nodes=2000
//   npx tsx scripts/bench/flow.ts --stage=rate --backend=x11
//   npx tsx scripts/bench/flow.ts --nodes=20,200,800 --json=out.json
//
// Three stages, because they fail for different reasons and one number hides
// which:
//
//  - **retained** — the real `<Flow>` element painting in a real window, its
//    `paint()` timed per pass and broken down by what it was drawing. This is
//    the cost being replaced: a pan repaints the pane, and everything the
//    pane draws is a 2D request. Two zooms, because the pane's own thresholds
//    change what is drawn: below 0.45 there are no labels and below 0.5 no
//    handles, so `--zoom=0.44` prices the geometry alone and `--zoom=1` the
//    whole card.
//  - **gl** — the same scene drawn by four programs into an offscreen CGL
//    target, `glFinish` on every frame so a number is the whole of it: this
//    thread issuing the frame and the GPU drawing it. Nothing here is the
//    shipped renderer — there is no shipped renderer — it is the *shape* of
//    one, priced: instanced rounded-box cards, instanced discs for handles,
//    one instance per edge with the cubic evaluated in the vertex shader, and
//    the grid computed per pixel. No text (see docs/prd-flow-gl.md, "Labels
//    are the whole of the risk").
//  - **rate** — what the display delivers, which is neither of the above: the
//    paints a second the retained pane achieves when asked as fast as it will
//    go, and the frames a second an almost-empty `<glarea>` delivers beside
//    it. The second number is the ceiling any GPU renderer here is measured
//    against, and on this hardware it is not the panel's.
//
// The scene is generated rather than fetched: a graph is its own corpus.
// `--scene=grid` is the stress example's shape (a lattice, every node the
// same size, two edges out of each), `--scene=fan` is a layered DAG and
// `--scene=spiral` the small readable one. `--nodes=` takes a list, so one
// run shows the slope.
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import type {
  FlowEdge,
  FlowInstance,
  FlowNode,
  Viewport,
} from '../../src/index.js';

type Dri = typeof import('x11-dri');
/** x11-dri's GL, which is WebGL-shaped and typed as loosely here as it is in
 *  `src/maps/gl/shaders.ts`, for the same reason. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GL = any;

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const stages = arg('stage', 'scene,retained,gl,rate').split(',');
const counts = arg('nodes', '200')
  .split(',')
  .map((n) => Number(n))
  .filter((n) => n > 0);
const sceneName = arg('scene', 'grid');
const backend = arg('backend', 'cocoa') as 'cocoa' | 'x11';
const scale = Number(arg('scale', '2'));
const paneWidth = Number(arg('width', '1200'));
const paneHeight = Number(arg('height', '800'));
const segments = Number(arg('segments', '24'));
const jsonOut = arg('json', '');

/** Median rather than mean: one GC pause in a hundred frames moves a mean and
 *  does not move a median, and the question is what a frame usually costs. */
function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

interface Summary {
  frames: number;
  p50: number;
  p95: number;
  max: number;
}

function summarize(values: readonly number[]): Summary {
  return {
    frames: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: values.length ? Math.max(...values) : NaN,
  };
}

const ms = (v: number, width = 6): string =>
  (Number.isFinite(v) ? v.toFixed(v < 10 ? 2 : 1) : '—').padStart(width);

function line(label: string, s: Summary): string {
  return (
    `  ${label.padEnd(22)} ${String(s.frames).padStart(4)} frames` +
    `   p50 ${ms(s.p50)}   p95 ${ms(s.p95)}   max ${ms(s.max)} ms\n`
  );
}

const results: Record<string, unknown> = {};

// --- the scenes ---------------------------------------------------------------

interface Scene {
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** A lattice: every node the same size, two edges out of each, which is the
 *  shape `examples/flow-stress.tsx` drives and the one where per-node and
 *  per-edge cost are both undiluted. */
function gridScene(count: number): Scene {
  const cols = Math.ceil(Math.sqrt(count * 1.6));
  const nodes: FlowNode[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `n${i}`,
      position: { x: (i % cols) * 170, y: Math.floor(i / cols) * 90 },
      width: 120,
      height: 48,
      data: { label: `node ${i}`, description: 'a second line' },
      sourcePosition: 'right',
      targetPosition: 'left',
    });
  }
  const edges: FlowEdge[] = [];
  for (let i = 0; i < count; i++) {
    for (let k = 1; k <= 2; k++) {
      const target = (i + cols + k * 3) % count;
      if (target === i) continue;
      edges.push({
        id: `e${i}-${k}`,
        source: `n${i}`,
        target: `n${target}`,
        type: 'bezier',
        // A label on one edge in seven and a marching dash on one in
        // twenty-three: enough of each that dropping them shows up, few
        // enough that they are not the whole measurement.
        label: i % 7 === 0 ? `w${i}` : undefined,
        animated: i % 23 === 0,
      });
    }
  }
  return { name: `grid ${count}`, nodes, edges };
}

/** Layers fanning out, which makes edges rather than nodes the cost. */
function fanScene(count: number): Scene {
  const depth = Math.max(4, Math.round(Math.sqrt(count) * 1.3));
  const perLayer = Math.max(2, Math.round(count / depth));
  const nodes: FlowNode[] = [];
  const ids: string[][] = [];
  let n = 0;
  for (let l = 0; l < depth && n < count; l++) {
    const row: string[] = [];
    for (let i = 0; i < perLayer && n < count; i++) {
      const id = `f${n++}`;
      row.push(id);
      nodes.push({
        id,
        position: { x: l * 150, y: (i - perLayer / 2) * 46 },
        width: 96,
        height: 34,
        data: { label: id },
        sourcePosition: 'right',
        targetPosition: 'left',
      });
    }
    ids.push(row);
  }
  const edges: FlowEdge[] = [];
  for (let l = 0; l + 1 < ids.length; l++) {
    const next = ids[l + 1];
    if (next.length === 0) continue;
    for (let i = 0; i < ids[l].length; i++) {
      const fan = 2 + ((i + l) % 2);
      for (let k = 0; k < fan; k++) {
        edges.push({
          id: `${ids[l][i]}-${k}-${l}`,
          source: ids[l][i],
          target: next[(i * 2 + k * 3 + l) % next.length],
          type: 'bezier',
        });
      }
    }
  }
  return { name: `fan ${nodes.length}`, nodes, edges };
}

/** One chain on an Archimedean spiral: every edge kind has to route between
 *  two nodes at an arbitrary angle. */
function spiralScene(count: number): Scene {
  const step = (Math.PI * 3) / count;
  const nodes: FlowNode[] = [];
  for (let i = 0; i < count; i++) {
    const theta = i * step;
    const radius = 120 + 30 * theta;
    nodes.push({
      id: `s${i}`,
      position: {
        x: Math.round(Math.cos(theta) * radius * 1.25),
        y: Math.round(Math.sin(theta) * radius),
      },
      width: 104,
      height: 38,
      data: { label: `step ${i + 1}` },
    });
  }
  const edges: FlowEdge[] = [];
  for (let i = 0; i + 1 < count; i++) {
    edges.push({
      id: `s${i}-s${i + 1}`,
      source: `s${i}`,
      target: `s${i + 1}`,
      animated: i === count - 2,
    });
  }
  return { name: `spiral ${count}`, nodes, edges };
}

function sceneOf(count: number): Scene {
  if (sceneName === 'fan') return fanScene(count);
  if (sceneName === 'spiral') return spiralScene(count);
  return gridScene(count);
}

// --- stage: the retained renderer ---------------------------------------------

async function stageRetained(): Promise<void> {
  const React = await import('react');
  const { createRoot } = await import('react-x11');
  const { Flow } = await import('../../src/index.js');
  const { FlowGraphNode } = await import('../../src/flow/node.js');

  const times: number[] = [];
  const paint = FlowGraphNode.prototype.paint;
  FlowGraphNode.prototype.paint = function timedPaint(ctx: never): void {
    const started = performance.now();
    try {
      paint.call(this, ctx);
    } finally {
      times.push(performance.now() - started);
    }
  };
  const wait = (delay: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, delay));

  for (const count of counts) {
    const scene = sceneOf(count);
    const handle: { current: FlowInstance | null } = { current: null };
    const root = await createRoot({ backend, desktop: false, scale });
    root.render(
      React.createElement(
        'window',
        { width: paneWidth, height: paneHeight, title: 'flow bench' },
        React.createElement(Flow, {
          ref: handle,
          defaultNodes: scene.nodes,
          defaultEdges: scene.edges,
          fitView: true,
          fitViewOptions: { padding: 0.05 },
          minimap: true,
          controls: true,
          background: { variant: 'dots', gap: 24 },
          style: { flexGrow: 1 },
        }),
      ),
    );

    // Let it settle: the first paints carry the font cache filling and the
    // fit, and neither is a frame anybody waits on twice.
    await wait(900);

    const phase = async (label: string, zoom: number | null): Promise<void> => {
      if (zoom != null) handle.current?.setViewport({ zoom });
      await wait(300);
      times.length = 0;
      // Paced at 16 ms rather than driven flat out: this stage prices a
      // frame, and `rate` measures how many of them land.
      for (let i = 0; i < 60; i++) {
        const viewport = handle.current?.getViewport();
        if (viewport) {
          handle.current?.setViewport({ x: viewport.x + (i % 2 ? -6 : 7) });
        }
        await wait(16);
      }
      await wait(60);
      const summary = summarize(times);
      process.stdout.write(line(`${scene.name} ${label}`, summary));
      results[`retained/${scene.name}/${label}`] = summary;
    };

    // Fitted, where every node is on screen; then past the pane's own
    // thresholds, where labels and handles start being drawn.
    await phase('fitted', null);
    await phase('zoom 0.44', 0.44);
    await phase('zoom 1.0', 1);
    root.unmount?.();
    await wait(200);
  }
}

// --- stage: the scene, with no window at all ----------------------------------

/**
 * What a frame costs *before* anything is drawn: routing every edge, culling
 * against the pane, resolving colours and laying labels out.
 *
 * This is the half a GPU renderer still pays on this thread, so it bounds
 * what moving the drawing can buy. It needs no server, no surface and no
 * display — which is the point of `src/flow/scene.ts` being pure, and why
 * this stage runs anywhere, including CI.
 */
async function stageScene(): Promise<void> {
  const { buildScene } = await import('../../src/flow/scene.js');
  const { measureNode, normalizeBackground, resolveHandles, resolvePalette } =
    await import('../../src/flow/model.js');
  const palette = resolvePalette(null, undefined);
  const pane = { x: 0, y: 0, width: paneWidth, height: paneHeight };
  // No font stack out here, so the same estimate `measureText` falls back to
  // when there is none. It makes labels a plausible size, which is all the
  // routing and the chips need.
  const measure = (
    text: string,
    options?: { size?: number },
  ): { width: number; height: number } => {
    const size = options?.size ?? 13;
    return { width: text.length * size * 0.55, height: size * 1.3 };
  };

  for (const count of counts) {
    const graph = sceneOf(count);
    const sources = graph.nodes.map((node) => {
      const { width, height } = measureNode(
        node,
        undefined,
        (t, o) => measure(t, o as { size?: number }).width,
      );
      return {
        node,
        rect: { x: node.position.x, y: node.position.y, width, height },
        specs: resolveHandles(node, undefined),
        type: undefined,
        header: 0,
        mounted: false,
        connectable: true,
        grips: [],
      };
    });
    const extent = sources.reduce(
      (box, source) => ({
        x: Math.max(box.x, source.rect.x + source.rect.width),
        y: Math.max(box.y, source.rect.y + source.rect.height),
      }),
      { x: 1, y: 1 },
    );
    const fitted = Math.min(
      (paneWidth * 0.92) / extent.x,
      (paneHeight * 0.92) / extent.y,
    );

    const run = (label: string, viewport: Viewport): void => {
      const base = {
        viewport,
        pane,
        clip: null,
        palette,
        background: normalizeBackground({ variant: 'dots' as const, gap: 24 }),
        nodes: sources,
        all: sources,
        edges: graph.edges,
        dashPhase: 0,
        hover: { nodeId: null, handle: null, edgeId: null },
        connection: null,
        selection: null,
        miniMap: null,
        controls: [],
        scale,
        measure,
      };
      for (let i = 0; i < 20; i++) buildScene(base);
      const samples: number[] = [];
      let drawn = { nodes: 0, edges: 0 };
      // Panned between samples, so no run is measuring a cache the last one
      // warmed — and so the culling does real work.
      for (let i = 0; i < 200; i++) {
        const input = {
          ...base,
          viewport: { ...viewport, x: viewport.x + (i % 40) * 3 },
        };
        const started = performance.now();
        const built = buildScene(input);
        samples.push(performance.now() - started);
        drawn = { nodes: built.nodes.length, edges: built.edges.length };
      }
      process.stdout.write(
        line(`${graph.name} ${label}`, summarize(samples)) +
          `      ${drawn.nodes} nodes, ${drawn.edges} edges in view\n`,
      );
      results[`scene/${graph.name}/${label}`] = summarize(samples);
    };

    run('fitted', { x: 20, y: 20, zoom: fitted });
    run('zoom 1.0', { x: 20, y: 20, zoom: 1 });
  }
}

// --- stage: the shape of a GL renderer ----------------------------------------

const VIEW_GLSL = `
uniform vec3 u_view;      // device pixels per graph unit, then the origin
uniform vec2 u_viewport;
vec2 toDevice(vec2 p) { return p * u_view.x + u_view.yz; }
vec4 clipOf(vec2 d) {
  return vec4(d.x / u_viewport.x * 2.0 - 1.0,
              1.0 - d.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

/** The grid: one quad, and the dots worked out per pixel from the viewport.
 *  No tile, no pattern, and no integral-pitch restriction — which is the
 *  whole of what `_paintGridPattern` has to arrange for on the 2D side. */
const GRID_VERTEX = `precision highp float;
attribute vec2 a_corner;
uniform vec2 u_viewport;
varying vec2 v_device;
void main() {
  v_device = vec2(a_corner.x * u_viewport.x,
                  (a_corner.y * 0.5 + 0.5) * u_viewport.y);
  gl_Position = vec4(a_corner.x * 2.0 - 1.0, a_corner.y, 0.0, 1.0);
}`;

const GRID_FRAGMENT = `precision highp float;
uniform vec3 u_view;
uniform vec4 u_color;
uniform float u_gap;      // graph units between dots
uniform float u_size;     // dot radius, device pixels
varying vec2 v_device;
void main() {
  float step = u_gap * u_view.x;
  vec2 rel = v_device - u_view.yz;
  vec2 cell = abs(mod(rel + step * 0.5, step) - step * 0.5);
  float a = clamp(0.5 - (length(cell) - u_size), 0.0, 1.0);
  if (a <= 0.0) discard;
  gl_FragColor = u_color * a;
}`;

/**
 * An edge: **one instance**, whatever its curvature.
 *
 * The per-vertex stream is static — segment index and quad corner, built once
 * — and the instance carries the four control points, so the vertex shader
 * evaluates the cubic at both ends of its segment and extrudes the capsule
 * between them. Two things follow, and they are the reason this shape is
 * worth pricing rather than the maps renderer's:
 *
 *   - **a pan or a zoom is a uniform**, not a rebuild. The 2D pane re-samples
 *     every bezier in *screen* space on every frame (`_edgeGeometry`), which
 *     is work proportional to the camera moving rather than to the graph
 *     changing.
 *   - **smoothness is a uniform too**: the same 16 floats draw a curve at any
 *     segment count, so a zoomed-in curve can be finer without the buffer
 *     changing.
 *
 * Round joins and caps fall out of the capsule's distance function, as they
 * do in `src/maps/gl/shaders.ts`, and the dash is the same idea: distance
 * along the line, modulo the pattern.
 */
const EDGE_VERTEX = `precision highp float;
attribute vec3 a_vert;    // segment index, corner x (0|1), corner y (-1|1)
attribute vec4 a_c01;     // control points 0 and 1
attribute vec4 a_c23;     // control points 2 and 3
attribute vec4 a_color;
attribute vec4 a_style;   // width (device px), dash on, dash off, phase
${VIEW_GLSL}
uniform float u_segments;
varying vec2 v_local;
varying float v_len;
varying float v_along;
varying float v_half;
varying vec4 v_color;
varying vec3 v_dash;
vec2 bezier(float t) {
  float m = 1.0 - t;
  return m * m * m * a_c01.xy + 3.0 * m * m * t * a_c01.zw
       + 3.0 * m * t * t * a_c23.xy + t * t * t * a_c23.zw;
}
void main() {
  vec2 a = toDevice(bezier(a_vert.x / u_segments));
  vec2 b = toDevice(bezier((a_vert.x + 1.0) / u_segments));
  vec2 d = b - a;
  float len = length(d);
  vec2 t = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float half_ = a_style.x * 0.5;
  float e = half_ + 1.0;
  float along = mix(-e, len + e, a_vert.y);
  v_local = vec2(along, a_vert.z * e);
  v_len = len;
  v_half = half_;
  v_color = a_color;
  v_dash = a_style.yzw;
  v_along = a_vert.x * len + along;
  gl_Position = clipOf(a + t * along + n * (a_vert.z * e));
}`;

const EDGE_FRAGMENT = `precision highp float;
varying vec2 v_local;
varying float v_len;
varying float v_along;
varying float v_half;
varying vec4 v_color;
varying vec3 v_dash;
void main() {
  float x = clamp(v_local.x, 0.0, v_len);
  float dist = length(vec2(v_local.x - x, v_local.y));
  float a = clamp(v_half - dist + 0.5, 0.0, 1.0);
  float period = v_dash.x + v_dash.y;
  if (period > 0.0) {
    float m = mod(v_along + v_dash.z, period);
    a *= clamp(min(m, v_dash.x - m) + 0.5, 0.0, 1.0);
  }
  if (a <= 0.0) discard;
  gl_FragColor = v_color * a;
}`;

/** A card: one instance, a rounded box measured per pixel. Fill, border and
 *  the antialiased edge all come out of the one distance, so a card is not a
 *  fill plus an inset stroke — which is what the 2D painter has to make it,
 *  and why it needs the half-pixel geometry `draw.ts` documents. */
const CARD_VERTEX = `precision highp float;
attribute vec2 a_corner;
attribute vec4 a_rect;    // x, y, w, h — graph space
attribute vec4 a_shape;   // radius, border width — graph units
attribute vec4 a_fill;
attribute vec4 a_border;
${VIEW_GLSL}
varying vec2 v_local;
varying vec2 v_half;
varying vec2 v_shape;
varying vec4 v_fill;
varying vec4 v_border;
void main() {
  vec2 corner = vec2(a_corner.x, a_corner.y * 0.5 + 0.5);
  vec2 size = a_rect.zw * u_view.x;
  vec2 half_ = size * 0.5;
  vec2 local = (corner - 0.5) * (size + 2.0);
  v_local = local;
  v_half = half_;
  v_shape = vec2(a_shape.x * u_view.x, max(a_shape.y * u_view.x, 1.0));
  v_fill = a_fill;
  v_border = a_border;
  gl_Position = clipOf(toDevice(a_rect.xy) + half_ + local);
}`;

const CARD_FRAGMENT = `precision highp float;
varying vec2 v_local;
varying vec2 v_half;
varying vec2 v_shape;
varying vec4 v_fill;
varying vec4 v_border;
void main() {
  float r = min(v_shape.x, min(v_half.x, v_half.y));
  vec2 q = abs(v_local) - (v_half - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float outside = clamp(0.5 - d, 0.0, 1.0);
  float inner = clamp(0.5 - (d + v_shape.y), 0.0, 1.0);
  vec4 c = v_fill * inner + v_border * (outside - inner);
  if (c.a <= 0.0) discard;
  gl_FragColor = c;
}`;

/** A handle: a disc with a ring, sized in device pixels so it stays the same
 *  size at every zoom — which is what the pane already does with it. Scatter
 *  is free here, which is the measured trap `_paintHandles` documents on the
 *  2D side: batching forty dots into one path cost a paneful of mask. */
const HANDLE_VERTEX = `precision highp float;
attribute vec2 a_corner;
attribute vec4 a_at;      // centre (graph space), radius and ring (device px)
attribute vec4 a_fill;
attribute vec4 a_ring;
${VIEW_GLSL}
varying vec2 v_local;
varying vec2 v_shape;
varying vec4 v_fill;
varying vec4 v_ring;
void main() {
  vec2 corner = vec2(a_corner.x, a_corner.y * 0.5 + 0.5);
  v_local = (corner - 0.5) * 2.0 * (a_at.z + 1.0);
  v_shape = a_at.zw;
  v_fill = a_fill;
  v_ring = a_ring;
  gl_Position = clipOf(toDevice(a_at.xy) + v_local);
}`;

const HANDLE_FRAGMENT = `precision highp float;
varying vec2 v_local;
varying vec2 v_shape;
varying vec4 v_fill;
varying vec4 v_ring;
void main() {
  float d = length(v_local) - v_shape.x;
  float outside = clamp(0.5 - d, 0.0, 1.0);
  float inner = clamp(0.5 - (d + v_shape.y), 0.0, 1.0);
  vec4 c = v_fill * inner + v_ring * (outside - inner);
  if (c.a <= 0.0) discard;
  gl_FragColor = c;
}`;

interface Linked {
  program: unknown;
  uniforms: Record<string, unknown>;
}

function linkProgram(
  gl: GL,
  vertex: string,
  fragment: string,
  attributes: Record<string, number>,
  uniforms: readonly string[],
): Linked {
  const compile = (type: number, source: string): unknown => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  for (const [name, location] of Object.entries(attributes)) {
    gl.bindAttribLocation(program, location, name);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
  }
  const found: Record<string, unknown> = {};
  for (const name of uniforms)
    found[name] = gl.getUniformLocation(program, name);
  return { program, uniforms: found };
}

const EDGE_STRIDE = 16;
const CARD_STRIDE = 16;
const HANDLE_STRIDE = 12;

function stageGl(): void {
  if (process.platform !== 'darwin') {
    process.stdout.write('  the gl stage uses a CGL context and needs macOS\n');
    return;
  }
  const dri = createRequire(import.meta.url)('x11-dri') as Dri;
  const width = paneWidth * scale;
  const height = paneHeight * scale;
  const context = new dri.apple.Context({
    alphaSize: 8,
    depthSize: 24,
    stencilSize: 8,
    doubleBuffer: false,
    profile: 'core',
  });
  context.makeCurrent();
  const target = context.createTarget(width, height, { depth: true });
  context.bindTarget(target);
  const gl = dri.gl as GL;

  const grid = linkProgram(gl, GRID_VERTEX, GRID_FRAGMENT, { a_corner: 0 }, [
    'u_view',
    'u_viewport',
    'u_color',
    'u_gap',
    'u_size',
  ]);
  const edge = linkProgram(
    gl,
    EDGE_VERTEX,
    EDGE_FRAGMENT,
    { a_vert: 0, a_c01: 1, a_c23: 2, a_color: 3, a_style: 4 },
    ['u_view', 'u_viewport', 'u_segments'],
  );
  const card = linkProgram(
    gl,
    CARD_VERTEX,
    CARD_FRAGMENT,
    { a_corner: 0, a_rect: 1, a_shape: 2, a_fill: 3, a_border: 4 },
    ['u_view', 'u_viewport'],
  );
  const handle = linkProgram(
    gl,
    HANDLE_VERTEX,
    HANDLE_FRAGMENT,
    { a_corner: 0, a_at: 1, a_fill: 2, a_ring: 3 },
    ['u_view', 'u_viewport'],
  );

  const buffer = (data: Float32Array, dynamic: boolean): unknown => {
    const handleId = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, handleId);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      data,
      dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW,
    );
    return handleId;
  };
  const attribute = (
    location: number,
    size: number,
    stride: number,
    offset: number,
    divisor: number,
  ): void => {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      size,
      gl.FLOAT,
      false,
      stride * 4,
      offset * 4,
    );
    gl.vertexAttribDivisor(location, divisor);
  };

  const quad = buffer(new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), false);
  // Two triangles per segment, built once and shared by every edge.
  const vertexStream = new Float32Array(segments * 6 * 3);
  {
    const corners = [
      [0, -1],
      [1, -1],
      [0, 1],
      [1, -1],
      [1, 1],
      [0, 1],
    ];
    let at = 0;
    for (let s = 0; s < segments; s++) {
      for (const [cx, cy] of corners) {
        vertexStream[at++] = s;
        vertexStream[at++] = cx;
        vertexStream[at++] = cy;
      }
    }
  }
  const segmentBuffer = buffer(vertexStream, false);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
  gl.viewport(0, 0, width, height);

  for (const count of counts) {
    const scene = sceneOf(count);
    const byId = new Map(scene.nodes.map((n) => [n.id, n]));
    const anchorOf = (
      node: FlowNode,
      side: 'source' | 'target',
    ): [number, number] => {
      const w = node.width ?? 120;
      const h = node.height ?? 48;
      return side === 'source'
        ? [node.position.x + w, node.position.y + h / 2]
        : [node.position.x, node.position.y + h / 2];
    };

    const drawn = scene.edges.filter(
      (e) => byId.has(e.source) && byId.has(e.target),
    );
    const edgeData = new Float32Array(drawn.length * EDGE_STRIDE);
    const fillEdges = (): void => {
      drawn.forEach((e, i) => {
        const at = i * EDGE_STRIDE;
        const [ax, ay] = anchorOf(byId.get(e.source)!, 'source');
        const [bx, by] = anchorOf(byId.get(e.target)!, 'target');
        const shoulder = Math.max(40, Math.abs(bx - ax) * 0.4);
        edgeData.set(
          [ax, ay, ax + shoulder, ay, bx - shoulder, by, bx, by],
          at,
        );
        edgeData.set([0.42, 0.47, 0.55, 1], at + 8);
        edgeData[at + 12] = 2;
        edgeData[at + 13] = e.animated ? 10 : 0;
        edgeData[at + 14] = e.animated ? 8 : 0;
        edgeData[at + 15] = 0;
      });
    };
    fillEdges();

    const cardData = new Float32Array(scene.nodes.length * CARD_STRIDE);
    scene.nodes.forEach((node, i) => {
      const at = i * CARD_STRIDE;
      cardData.set(
        [
          node.position.x,
          node.position.y,
          node.width ?? 120,
          node.height ?? 48,
        ],
        at,
      );
      cardData[at + 4] = 6;
      cardData[at + 5] = 1;
      cardData.set([0.16, 0.18, 0.22, 1], at + 8);
      cardData.set([0.35, 0.38, 0.45, 1], at + 12);
    });

    const handleData = new Float32Array(scene.nodes.length * 2 * HANDLE_STRIDE);
    scene.nodes.forEach((node, i) => {
      for (const [k, side] of [
        [0, 'source'],
        [1, 'target'],
      ] as const) {
        const at = (i * 2 + k) * HANDLE_STRIDE;
        const [hx, hy] = anchorOf(node, side);
        handleData.set([hx, hy, 4, 1.5], at);
        handleData.set([0.16, 0.18, 0.22, 1], at + 4);
        handleData.set([0.45, 0.6, 0.85, 1], at + 8);
      }
    });

    const edgeBuffer = buffer(edgeData, true);
    const cardBuffer = buffer(cardData, true);
    const handleBuffer = buffer(handleData, true);

    const gridVao = gl.createVertexArray();
    gl.bindVertexArray(gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    attribute(0, 2, 2, 0, 0);

    const edgeVao = gl.createVertexArray();
    gl.bindVertexArray(edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, segmentBuffer);
    attribute(0, 3, 3, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
    attribute(1, 4, EDGE_STRIDE, 0, 1);
    attribute(2, 4, EDGE_STRIDE, 4, 1);
    attribute(3, 4, EDGE_STRIDE, 8, 1);
    attribute(4, 4, EDGE_STRIDE, 12, 1);

    const cardVao = gl.createVertexArray();
    gl.bindVertexArray(cardVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    attribute(0, 2, 2, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, cardBuffer);
    attribute(1, 4, CARD_STRIDE, 0, 1);
    attribute(2, 4, CARD_STRIDE, 4, 1);
    attribute(3, 4, CARD_STRIDE, 8, 1);
    attribute(4, 4, CARD_STRIDE, 12, 1);

    const handleVao = gl.createVertexArray();
    gl.bindVertexArray(handleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    attribute(0, 2, 2, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, handleBuffer);
    attribute(1, 4, HANDLE_STRIDE, 0, 1);
    attribute(2, 4, HANDLE_STRIDE, 4, 1);
    attribute(3, 4, HANDLE_STRIDE, 8, 1);

    const bounds = scene.nodes.reduce(
      (box, n) => ({
        x: Math.max(box.x, n.position.x + (n.width ?? 120)),
        y: Math.max(box.y, n.position.y + (n.height ?? 48)),
      }),
      { x: 1, y: 1 },
    );
    const fitted = Math.min(
      (width * 0.92) / bounds.x,
      (height * 0.92) / bounds.y,
    );

    const drawFrame = (zoom: number, panX: number, phase: number): void => {
      gl.clearColor(0.09, 0.1, 0.12, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(grid.program);
      gl.uniform3f(grid.uniforms.u_view, zoom, panX, 40);
      gl.uniform2f(grid.uniforms.u_viewport, width, height);
      gl.uniform4f(grid.uniforms.u_color, 0.22, 0.24, 0.28, 1);
      gl.uniform1f(grid.uniforms.u_gap, 24);
      gl.uniform1f(grid.uniforms.u_size, 1.2);
      gl.bindVertexArray(gridVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.useProgram(edge.program);
      gl.uniform3f(edge.uniforms.u_view, zoom, panX, 40);
      gl.uniform2f(edge.uniforms.u_viewport, width, height);
      gl.uniform1f(edge.uniforms.u_segments, segments);
      gl.bindVertexArray(edgeVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, segments * 6, drawn.length);

      gl.useProgram(card.program);
      gl.uniform3f(card.uniforms.u_view, zoom, panX, 40);
      gl.uniform2f(card.uniforms.u_viewport, width, height);
      gl.bindVertexArray(cardVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, scene.nodes.length);

      gl.useProgram(handle.program);
      gl.uniform3f(handle.uniforms.u_view, zoom, panX, 40);
      gl.uniform2f(handle.uniforms.u_viewport, width, height);
      gl.bindVertexArray(handleVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, scene.nodes.length * 2);
      void phase;
    };

    // The driver builds a pipeline on the first draw of each program, and
    // that belongs to no frame.
    for (let i = 0; i < 20; i++) drawFrame(fitted, 20, 0);
    gl.finish();

    const panned: number[] = [];
    const edited: number[] = [];
    for (let i = 0; i < 200; i++) {
      const started = performance.now();
      drawFrame(fitted, 20 + Math.sin(i * 0.05) * 300, i * 0.5);
      gl.finish();
      panned.push(performance.now() - started);
    }
    // The other half: a graph *edit*, where the instance streams are rebuilt
    // and re-uploaded whole. A pan must not cost this, and the gap between
    // the two lines is the evidence that it does not.
    for (let i = 0; i < 200; i++) {
      const started = performance.now();
      fillEdges();
      gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, edgeData, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, cardBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, cardData, gl.DYNAMIC_DRAW);
      drawFrame(fitted, 20 + Math.sin(i * 0.05) * 300, i * 0.5);
      gl.finish();
      edited.push(performance.now() - started);
    }

    const panSummary = summarize(panned);
    const editSummary = summarize(edited);
    process.stdout.write(
      `  ${scene.name}: ${scene.nodes.length} nodes · ${drawn.length} edges · ` +
        `${scene.nodes.length * 2} handles · 4 draws · ` +
        `${(edgeData.byteLength / 1024).toFixed(1)} KB of edge data\n`,
    );
    process.stdout.write(line(`${scene.name} pan`, panSummary));
    process.stdout.write(line(`${scene.name} edit`, editSummary));
    results[`gl/${scene.name}`] = { pan: panSummary, edit: editSummary };
  }

  target.destroy();
  context.destroy();
}

// --- stage: what the display delivers -----------------------------------------

async function stageRate(): Promise<void> {
  const React = await import('react');
  const { createRoot } = await import('react-x11');
  const { Flow } = await import('../../src/index.js');
  const { FlowGraphNode } = await import('../../src/flow/node.js');

  const wait = (delay: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, delay));

  let paints = 0;
  const paint = FlowGraphNode.prototype.paint;
  FlowGraphNode.prototype.paint = function counted(ctx: never): void {
    paints++;
    paint.call(this, ctx);
  };

  const scene = sceneOf(counts[0]);
  const handle: { current: FlowInstance | null } = { current: null };
  const root = await createRoot({ backend, desktop: false, scale });
  root.render(
    React.createElement(
      'window',
      { width: paneWidth, height: paneHeight, title: 'flow bench — rate' },
      React.createElement(Flow, {
        ref: handle,
        defaultNodes: scene.nodes,
        defaultEdges: scene.edges,
        fitView: true,
        minimap: true,
        controls: true,
        background: { variant: 'dots', gap: 24 },
        style: { flexGrow: 1 },
      }),
    ),
  );
  await wait(900);

  // Asked for a new viewport as fast as the loop will turn: what lands is
  // what the window's clock allows, which is the number a user feels.
  paints = 0;
  const started = performance.now();
  let asks = 0;
  while (performance.now() - started < 3000) {
    const viewport = handle.current?.getViewport();
    if (viewport)
      handle.current?.setViewport({ x: viewport.x + (asks % 2 ? -5 : 6) });
    asks++;
    await wait(0);
  }
  const seconds = (performance.now() - started) / 1000;
  process.stdout.write(
    `  retained  ${(paints / seconds).toFixed(1)} paints/s ` +
      `from ${(asks / seconds).toFixed(0)} asks/s\n`,
  );
  results['rate/retained'] = { paintsPerSecond: paints / seconds };
  root.unmount?.();
  await wait(200);

  // And the ceiling: a `<glarea>` clearing the screen and nothing else. Any
  // GPU renderer in this window is bounded by this, so it is the first number
  // to read and the one that says whether a target is reachable at all.
  const glFrames: number[] = [];
  const glRoot = await createRoot({
    backend,
    desktop: false,
    scale,
    glPolicy: 'auto',
  });
  glRoot.render(
    React.createElement(
      'window',
      { width: paneWidth, height: paneHeight, title: 'flow bench — ceiling' },
      React.createElement('glarea', {
        style: { flexGrow: 1 },
        frameLoop: 'always',
        onDraw: (gl: GL) => {
          glFrames.push(performance.now());
          gl.clearColor(0.1, 0.12, 0.16, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        },
      }),
    ),
  );
  await wait(4000);
  const gaps: number[] = [];
  for (let i = 1; i < glFrames.length; i++)
    gaps.push(glFrames[i] - glFrames[i - 1]);
  process.stdout.write(
    `  <glarea>  ${(glFrames.length / 4).toFixed(1)} frames/s` +
      `   gap p50 ${ms(quantile(gaps, 0.5))}   p95 ${ms(quantile(gaps, 0.95))} ms\n`,
  );
  results['rate/glarea'] = {
    framesPerSecond: glFrames.length / 4,
    gapP50: quantile(gaps, 0.5),
  };
  glRoot.unmount?.();
}

// --- run ----------------------------------------------------------------------

process.stdout.write(
  `flow bench — ${sceneName}, ${paneWidth}x${paneHeight} at scale ${scale}` +
    ` (${paneWidth * scale}x${paneHeight * scale} device), backend ${backend}\n`,
);
if (stages.includes('scene')) {
  process.stdout.write('\nscene — routing and culling, no window\n');
  await stageScene();
}
if (stages.includes('retained')) {
  process.stdout.write('\nretained — the 2D pane, per paint\n');
  await stageRetained();
}
if (stages.includes('gl')) {
  process.stdout.write('\ngl — the same scene, four programs, offscreen\n');
  stageGl();
}
if (stages.includes('rate')) {
  process.stdout.write('\nrate — what the window actually delivers\n');
  await stageRate();
}
if (jsonOut) {
  await writeFile(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`\nwrote ${jsonOut}\n`);
}
process.exit(0);
