// The `<Flow>` profile: what a frame costs today, what it would cost on the
// GPU, and what the display will actually deliver.
//
//   npx tsx scripts/bench/flow.ts                       # every stage
//   npx tsx scripts/bench/flow.ts --stage=retained
//   npx tsx scripts/bench/flow.ts --stage=gl,live --nodes=200,2000
//   npx tsx scripts/bench/flow.ts --stage=rate --backend=x11
//   npx tsx scripts/bench/flow.ts --nodes=20,200,800 --json=out.json
//
// Five stages, because they fail for different reasons and one number hides
// which (`scene` is described with its function below):
//
//  - **retained** — the real `<Flow>` element painting in a real window, its
//    `paint()` timed per pass and broken down by what it was drawing. This is
//    the cost being replaced: a pan repaints the pane, and everything the
//    pane draws is a 2D request. Two zooms, because the pane's own thresholds
//    change what is drawn: below 0.45 there are no labels and below 0.5 no
//    handles, so `--zoom=0.44` prices the geometry alone and `--zoom=1` the
//    whole card.
//  - **gl** — the shipped GL renderer (`src/flow/gl/`) drawing into an
//    offscreen CGL target, `glFinish` on every frame so a number is the whole
//    of it: this thread issuing the frame and the GPU drawing it. Two kinds
//    of frame, because the renderer has two: a *pan*, where the graph is
//    already on the GPU and only its offset moves, and a *rebuild* — what a
//    drag step or a zoom step costs — where the graph is built, packed and
//    uploaded again. No labels: a zoom-fitted graph is below the zoom that
//    draws them, and the atlas is the `live` stage's to exercise.
//  - **live** — `<Flow renderer="gl">` in a real window, panned from its own
//    frame callback, every delivered frame counted: the rate a user gets,
//    through `<glarea>`'s clock and swap.
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
  FlowFrameStats,
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

const stages = arg('stage', 'scene,retained,gl,live,rate').split(',');
const counts = arg('nodes', '200')
  .split(',')
  .map((n) => Number(n))
  .filter((n) => n > 0);
const sceneName = arg('scene', 'grid');
const backend = arg('backend', 'cocoa') as 'cocoa' | 'x11';
const scale = Number(arg('scale', '2'));
const paneWidth = Number(arg('width', '1200'));
const paneHeight = Number(arg('height', '800'));
const jsonOut = arg('json', '');
/**
 * Which build of `src/flow/` the `scene` stage times.
 *
 * `tsx` transpiles with esbuild's `keepNames`, which wraps every function in
 * a `__name` helper: at two thousand nodes that helper alone was a sixth of
 * the profile, and the whole stage ran **2.2x slower** than the same code
 * built by `tsc`. An application runs the built output, so `--build=dist`
 * (after `npm run build`) is the number to quote and `src` is the convenient
 * one. The other stages are dominated by the graphics backend rather than by
 * JavaScript, so they are left on `src`.
 */
const build = arg('build', 'src');

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
  const from = build === 'dist' ? '../../dist' : '../../src';
  const { buildScene, SceneCache } = (await import(
    `${from}/flow/scene.js`
  )) as typeof import('../../src/flow/scene.js');
  const { measureNode, normalizeBackground, resolveHandles, resolvePalette } =
    (await import(
      `${from}/flow/model.js`
    )) as typeof import('../../src/flow/model.js');
  process.stdout.write(`  timing ${build}/flow\n`);
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

    const run = (label: string, viewport: Viewport, cached: boolean): void => {
      const base = {
        cache: cached ? new SceneCache() : undefined,
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

    // Both ways round, because the gap between them is the claim: a pan
    // keeps the zoom, so every route the cache holds is still the right
    // curve, one addition per vertex away.
    run('fitted, uncached', { x: 20, y: 20, zoom: fitted }, false);
    run('fitted, cached', { x: 20, y: 20, zoom: fitted }, true);
    run('zoom 1.0, uncached', { x: 20, y: 20, zoom: 1 }, false);
    run('zoom 1.0, cached', { x: 20, y: 20, zoom: 1 }, true);
  }
}

// --- stage: the GL renderer, offscreen -----------------------------------------

/** The sources a scene is built from, for a generated graph: what the element
 *  resolves from its entries, with no element. */
async function sourcesOf(
  graph: Scene,
  measure: (
    t: string,
    o?: { size?: number },
  ) => { width: number; height: number },
) {
  const { measureNode, resolveHandles } =
    await import('../../src/flow/model.js');
  return graph.nodes.map((node) => {
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
      grips: [] as { x: number; y: number }[],
    };
  });
}

/**
 * The shipped renderer (`src/flow/gl/`) drawing into an offscreen CGL target,
 * `glFinish` on every frame so a number is the whole of it.
 *
 * Two kinds of frame, because the renderer has two and the gap between them
 * is its design: a **pan**, where the world is already on the GPU and only
 * its offset moves (the overlay is still built and packed, as it is every
 * frame), and a **rebuild** — what a drag step or a zoom step costs — where
 * the world is built from the scene, packed and uploaded again. Built the
 * way `FlowGraphNode.glFrame` builds them: the world at a pinned origin,
 * culled to an overscan three panes wide.
 */
async function stageGl(): Promise<void> {
  if (process.platform !== 'darwin') {
    process.stdout.write('  the gl stage uses a CGL context and needs macOS\n');
    return;
  }
  const { buildScene, SceneCache } = await import('../../src/flow/scene.js');
  const { normalizeBackground, resolvePalette } =
    await import('../../src/flow/model.js');
  const { FlowGlRenderer } = await import('../../src/flow/gl/renderer.js');
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
  const measure = (
    text: string,
    options?: { size?: number },
  ): { width: number; height: number } => {
    const size = options?.size ?? 13;
    return { width: text.length * size * 0.55, height: size * 1.3 };
  };
  const palette = resolvePalette(null, undefined);
  const pane = { x: 0, y: 0, width: paneWidth, height: paneHeight };
  const glTarget = { origin: { x: 0, y: 0 }, scale, width, height };

  for (const count of counts) {
    const graph = sceneOf(count);
    const sources = await sourcesOf(graph, measure);
    const extent = sources.reduce(
      (box, source) => ({
        x: Math.max(box.x, source.rect.x + source.rect.width),
        y: Math.max(box.y, source.rect.y + source.rect.height),
      }),
      { x: 1, y: 1 },
    );
    const zoom = Math.min(
      (paneWidth * 0.92) / extent.x,
      (paneHeight * 0.92) / extent.y,
    );
    const base = {
      pane,
      clip: null,
      palette,
      background: normalizeBackground({ variant: 'dots' as const, gap: 24 }),
      all: sources,
      dashPhase: 0,
      hover: { nodeId: null, handle: null, edgeId: null },
      connection: null,
      selection: null,
      scale,
      measure,
    };
    const worldAt = (x: number, y: number) =>
      buildScene({
        ...base,
        viewport: { x: 0, y: 0, zoom },
        cull: {
          x: -x - paneWidth,
          y: -y - paneHeight,
          width: paneWidth * 3,
          height: paneHeight * 3,
        },
        nodes: sources,
        edges: graph.edges,
        miniMap: null,
        controls: [],
        cache: worldCache,
      });
    const overlayAt = (x: number, y: number) =>
      buildScene({
        ...base,
        viewport: { x, y, zoom },
        nodes: [],
        edges: [],
        miniMap: null,
        controls: [],
      });
    const worldCache = new SceneCache();
    const renderer = new FlowGlRenderer(gl);
    const world = worldAt(20, 20);
    const frame = (x: number, rebuild: boolean): number => {
      const started = performance.now();
      renderer.drawFrame(
        {
          world: rebuild ? worldAt(x, 20) : null,
          overlay: overlayAt(x, 20),
          offset: { x, y: 20 },
          phase: 0,
        },
        glTarget,
      );
      gl.finish();
      return performance.now() - started;
    };
    // the first draw of each program builds a driver pipeline, and that
    // belongs to no frame
    renderer.drawFrame(
      { world, overlay: overlayAt(20, 20), offset: { x: 20, y: 20 }, phase: 0 },
      glTarget,
    );
    for (let i = 0; i < 20; i++) frame(20 + i, i === 0);
    gl.finish();

    const pan: number[] = [];
    const rebuild: number[] = [];
    for (let i = 0; i < 200; i++) pan.push(frame(20 + (i % 60), false));
    for (let i = 0; i < 100; i++) rebuild.push(frame(20 + (i % 60), true));
    process.stdout.write(
      `  ${graph.name}: ${sources.length} nodes, ${graph.edges.length} edges\n`,
    );
    process.stdout.write(line(`${graph.name} pan`, summarize(pan)));
    process.stdout.write(line(`${graph.name} rebuild`, summarize(rebuild)));
    results[`gl/${graph.name}`] = {
      pan: summarize(pan),
      rebuild: summarize(rebuild),
    };
    renderer.dispose();
  }

  target.destroy();
  context.destroy();
}

// --- stage: the GL renderer, live ------------------------------------------------

/**
 * `<Flow renderer="gl">` in a real window, panned from its own frame
 * callback the way an animation would drive it, every delivered frame
 * counted. `gl` prices a frame; this is what arrives, through `<glarea>`'s
 * clock and swap — bounded by the display, so cost shows up as a *late*
 * frame rather than a slow one. Read the gap's p50, never the mean.
 */
async function stageLive(): Promise<void> {
  const React = await import('react');
  const { createRoot } = await import('react-x11');
  const { Flow } = await import('../../src/index.js');
  const wait = (delay: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, delay));

  for (const count of counts) {
    const graph = sceneOf(count);
    const frames: { at: number; stats: FlowFrameStats }[] = [];
    const handle: { current: FlowInstance | null } = { current: null };
    let driving = false;
    let dx = 3;
    const root = await createRoot({
      backend,
      desktop: false,
      scale,
      glPolicy: 'auto',
    });
    root.render(
      React.createElement(
        'window',
        { width: paneWidth, height: paneHeight, title: 'flow bench — live' },
        React.createElement(Flow, {
          ref: handle,
          defaultNodes: graph.nodes,
          defaultEdges: graph.edges,
          fitView: true,
          minimap: true,
          controls: true,
          background: { variant: 'dots', gap: 24 },
          style: { flexGrow: 1 },
          renderer: 'gl',
          onError: (error: Error) =>
            process.stdout.write(`  GL failed: ${error.message}\n`),
          onFrame: (stats: FlowFrameStats) => {
            frames.push({ at: performance.now(), stats });
            if (!driving) return;
            // the next pan step, asked for by the frame that drew the last
            setImmediate(() => {
              const v = handle.current?.getViewport();
              if (!v) return;
              if (v.x < -300 || v.x > 300) dx = -dx;
              handle.current?.setViewport({ x: v.x + dx });
            });
          },
        }),
      ),
    );
    await wait(1500);
    frames.length = 0;
    driving = true;
    const v = handle.current?.getViewport();
    if (v) handle.current?.setViewport({ x: v.x + 1 });
    const seconds = 4;
    await wait(seconds * 1000);
    driving = false;

    const gaps: number[] = [];
    for (let i = 1; i < frames.length; i++) {
      gaps.push(frames[i].at - frames[i - 1].at);
    }
    const cpu = frames.map(
      (f) => f.stats.sceneMs + f.stats.packMs + f.stats.drawMs,
    );
    const rebuilt = frames.filter((f) => f.stats.worldRebuilt).length;
    process.stdout.write(
      `  ${graph.name}  ${(frames.length / seconds).toFixed(1)} frames/s` +
        `   gap p50 ${ms(quantile(gaps, 0.5))}  p95 ${ms(quantile(gaps, 0.95))} ms` +
        `   cpu p50 ${ms(quantile(cpu, 0.5))} ms   ${rebuilt} rebuilds\n`,
    );
    results[`live/${graph.name}`] = {
      framesPerSecond: frames.length / seconds,
      gapP50: quantile(gaps, 0.5),
      gapP95: quantile(gaps, 0.95),
      cpuP50: quantile(cpu, 0.5),
      rebuilt,
    };
    root.unmount?.();
    await wait(200);
  }
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
// `live` before `gl`, and not for tidiness: a raw x11-dri CGL context made
// and destroyed in this process — which is what `gl` does — leaves every
// `<glarea>` made after it drawing nothing, silently. An application never
// makes one, so this is the bench's trap and not the renderer's.
if (stages.includes('live')) {
  process.stdout.write('\nlive — <Flow renderer="gl"> in a window, panned\n');
  await stageLive();
}
if (stages.includes('gl')) {
  process.stdout.write(
    '\ngl — the shipped renderer, offscreen, glFinish per frame\n',
  );
  await stageGl();
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
