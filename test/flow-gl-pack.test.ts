// `src/flow/gl/pack.ts` — a scene packed for the GPU, with no GPU. The packer
// is pure, and the properties that matter about it are properties of its
// output: how many draws a frame costs, which layer a shape lands in, and
// the geometry it hands the shaders. The drawing itself is checked where
// there is a GL context to draw with (`scripts/bench/flow.ts`, and the
// offscreen comparison against the 2D painter in `docs/prd-flow-gl.md`).
import { test } from 'node:test';
import assert from 'node:assert';

import {
  measureNode,
  normalizeBackground,
  resolveHandles,
  resolvePalette,
} from '../src/flow/model.js';
import { buildScene } from '../src/flow/scene.js';
import type { SceneInput, SceneNodeSource } from '../src/flow/scene.js';
import { BOX_STRIDE, LINE_STRIDE, ScenePacker } from '../src/flow/gl/pack.js';
import type { FlowEdge, FlowNode } from '../src/flow/types.js';

const measure = (
  text: string,
  options?: { size?: number },
): { width: number; height: number } => {
  const size = options?.size ?? 13;
  return { width: text.length * size * 0.55, height: size * 1.3 };
};

function source(node: FlowNode): SceneNodeSource {
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
}

/** A lattice of `count` nodes, two edges out of each, every one with the
 *  default closed arrowhead and some with labels and a marching dash. */
function graph(count: number): { nodes: SceneNodeSource[]; edges: FlowEdge[] } {
  const cols = Math.ceil(Math.sqrt(count * 1.6));
  const nodes: SceneNodeSource[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push(
      source({
        id: `n${i}`,
        position: { x: (i % cols) * 170, y: Math.floor(i / cols) * 90 },
        width: 120,
        height: 48,
        data: { label: `node ${i}` },
        sourcePosition: 'right',
        targetPosition: 'left',
      }),
    );
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
        label: i % 7 === 0 ? `w${i}` : undefined,
        animated: i % 5 === 0,
        markerStart: i % 3 === 0 ? 'arrow' : undefined,
      });
    }
  }
  return { nodes, edges };
}

function input(
  nodes: readonly SceneNodeSource[],
  edges: readonly FlowEdge[],
  extra: Partial<SceneInput> = {},
): SceneInput {
  return {
    viewport: { x: 0, y: 0, zoom: 1 },
    pane: { x: 0, y: 0, width: 4000, height: 3000 },
    clip: null,
    palette: resolvePalette(null, undefined),
    background: normalizeBackground({ variant: 'dots', gap: 24 }),
    nodes,
    all: nodes,
    edges,
    dashPhase: 0,
    hover: { nodeId: null, handle: null, edgeId: null },
    connection: null,
    selection: { x: 10, y: 10, width: 50, height: 50 },
    miniMap: null,
    controls: [],
    scale: 2,
    measure,
    ...extra,
  };
}

test('a frame is a handful of draws, however big the graph', () => {
  // The regression this guards drew 807 ranges for 200 nodes: each closed
  // arrowhead was a triangle then a hairline, alternating kinds, and every
  // change of kind is a new draw. Two sizes, an order of magnitude apart,
  // must cost the same number of draws.
  const packer = new ScenePacker();
  const counts = [20, 200].map((n) => {
    const { nodes, edges } = graph(n);
    return packer.pack(buildScene(input(nodes, edges))).ranges.length;
  });
  assert.ok(counts[1] <= 16, `200 nodes drew in ${counts[1]} ranges`);
  assert.strictEqual(
    counts[0],
    counts[1],
    'and ten times the graph is not one draw more',
  );
});

test('cards with title bars are one range, not three a card', () => {
  // A card whose body is mounted draws a title bar with a hairline under
  // it, and the hairline went in as a line: box, line, box for every card,
  // and every change of program is a draw. On a board of widget cards
  // that was 566 draws a frame. A rule across or down is a box now.
  const packer = new ScenePacker();
  const counts = [20, 200].map((n) => {
    const { nodes, edges } = graph(n);
    const titled = nodes.map((node) => ({
      ...node,
      mounted: true,
      header: 26,
    }));
    const packed = packer.pack(buildScene(input(titled, edges)));
    return packed.ranges.length;
  });
  assert.ok(counts[1] <= 16, `200 titled cards drew in ${counts[1]} ranges`);
  assert.strictEqual(counts[0], counts[1], 'however many there are');
});

test('a rule across a card is a box one pen tall, where the stroke was', () => {
  const { nodes } = graph(1);
  const titled = nodes.map((node) => ({ ...node, mounted: true, header: 26 }));
  const scene = buildScene(input(titled, []));
  const rule = scene.nodes[0].ink.find((item) => item.kind === 'rule');
  assert.ok(rule && rule.kind === 'rule', 'the title bar has its hairline');
  const packed = new ScenePacker().pack(scene, 'world');
  const [a, b] = rule.points;
  const boxes: number[][] = [];
  for (let i = 0; i < packed.boxCount; i++) {
    boxes.push(
      Array.from(packed.boxes.subarray(i * BOX_STRIDE, i * BOX_STRIDE + 4)),
    );
  }
  assert.ok(
    boxes.some(
      ([x, y, w, h]) =>
        x === Math.min(a.x, b.x) &&
        y === a.y - rule.lineWidth / 2 &&
        w === Math.abs(b.x - a.x) &&
        h === rule.lineWidth,
    ),
    'a box from end to end, centred on the stroke',
  );
  assert.strictEqual(packed.lineCount, 0, 'and no line: there are no edges');
});

test('the world has no furniture and the overlay no graph', () => {
  // The split a pan relies on: the world is drawn at an offset, so anything
  // pinned to the pane in it would pan away with the graph — and anything of
  // the graph's in the overlay would stay put while the graph moved.
  const { nodes, edges } = graph(12);
  const scene = buildScene(input(nodes, edges));
  const packer = new ScenePacker();
  const all = packer.pack(scene, 'all');
  const counts = {
    lines: all.lineCount,
    boxes: all.boxCount,
    tris: all.triCount,
  };

  const world = new ScenePacker().pack(scene, 'world');
  const overlay = new ScenePacker().pack(scene, 'overlay');
  assert.ok(
    !world.ranges.some((r) => r.kind === 'grid'),
    'no grid in the world',
  );
  assert.strictEqual(overlay.lineCount, 0, 'no edge in the overlay');
  assert.strictEqual(overlay.triCount, 0, 'no arrowhead in the overlay');
  // background + selection: the only boxes the pane owns in this scene
  assert.strictEqual(overlay.boxCount, 2);
  assert.deepStrictEqual(
    {
      lines: world.lineCount + overlay.lineCount,
      boxes: world.boxCount + overlay.boxCount,
      tris: world.triCount + overlay.triCount,
    },
    counts,
    'and between them, everything the one-layer pack has',
  );
  // the background and grid under the world, the selection over it
  assert.deepStrictEqual(
    overlay.ranges.slice(0, overlay.split).map((r) => r.kind),
    ['box', 'grid'],
  );
  assert.deepStrictEqual(
    overlay.ranges.slice(overlay.split).map((r) => r.kind),
    ['box'],
  );
});

test('a marching dash is packed with no phase and a flag', () => {
  // The dash timer's tick is a uniform, not a rebuild: so the phase the
  // scene baked in must not be in the instance, or the shader would add it
  // twice.
  const { nodes } = graph(2);
  const edges: FlowEdge[] = [
    { id: 'm', source: 'n0', target: 'n1', animated: true },
    { id: 's', source: 'n1', target: 'n0', style: { dash: [4, 2] } },
  ];
  const scene = buildScene(
    input(nodes, edges, { dashPhase: 5, selection: null }),
  );
  const marching = scene.edges.find((e) => e.id === 'm')!;
  assert.ok(marching.animated && marching.dashOffset !== 0, 'precondition');
  const packed = new ScenePacker().pack(scene, 'world');
  const flags = new Set<number>();
  const offsets = new Set<number>();
  for (let i = 0; i < packed.lineCount; i++) {
    const at = i * LINE_STRIDE;
    if (packed.lines[at + 6] > 0) {
      flags.add(packed.lines[at + 9]);
      offsets.add(packed.lines[at + 8]);
    }
  }
  assert.deepStrictEqual(
    [...flags].sort(),
    [0, 1],
    'one dash marches, one does not',
  );
  assert.deepStrictEqual([...offsets], [0], 'and neither carries the phase');
});

test('a handle is a disc grown by half its pen, as the 2D circle strokes', () => {
  // The 2D painter strokes a circle's outline centred on its edge, half the
  // pen outside the radius; a box's border is inset. So the disc is packed
  // half a pen bigger, with the pen as its border.
  const { nodes } = graph(1);
  const scene = buildScene(input(nodes, [], { selection: null }));
  const handle = scene.nodes[0].handles[0];
  const pen = handle.lineWidth!;
  const packed = new ScenePacker().pack(scene, 'world');
  const want = handle.radius + pen / 2;
  let found = false;
  for (let i = 0; i < packed.boxCount; i++) {
    const at = i * BOX_STRIDE;
    const b = packed.boxes;
    if (
      Math.abs(b[at] - (handle.at.x - want)) < 1e-4 &&
      Math.abs(b[at + 1] - (handle.at.y - want)) < 1e-4
    ) {
      assert.ok(
        Math.abs(b[at + 2] - want * 2) < 1e-4,
        'its side is 2(r + pen/2)',
      );
      assert.ok(Math.abs(b[at + 4] - want) < 1e-4, 'its corners meet');
      assert.ok(Math.abs(b[at + 5] - pen) < 1e-4, 'and its border is the pen');
      found = true;
    }
  }
  assert.ok(found, 'the handle was packed where its circle was');
});

test('what the GPU cannot draw yet is counted, not dropped silently', () => {
  const { nodes } = graph(3);
  const edges: FlowEdge[] = [
    { id: 'l', source: 'n0', target: 'n1', label: 'x' },
  ];
  const painted = source({
    id: 'p',
    type: 'painted',
    position: { x: 600, y: 0 },
    width: 80,
    height: 40,
  });
  painted.type = { paint: () => {} };
  const scene = buildScene(
    input([...nodes, painted], edges, { selection: null }),
  );
  const { gaps } = new ScenePacker().pack(scene);
  // three labels on cards, one on the edge
  assert.strictEqual(gaps.text, 4);
  assert.strictEqual(gaps.custom, 1);
});

// --- labels still being set --------------------------------------------------

/** A label atlas that has set nothing, until `land()`: every string is a
 *  placeholder, then every one is drawable at the same field — on page 2,
 *  in its `slot`th placement, until `drop()` takes it away again. */
function waitingAtlas() {
  let landed = false;
  let slot = 0;
  const atlas = {
    generation: 0,
    moves: 0,
    wanted: [] as string[],
    pad: 4,
    beginPack() {},
    bind() {},
    quad(t: { x: number; y: number; text: string }) {
      return {
        key: t.text,
        ready: landed,
        x: t.x,
        y: t.y,
        w: 40,
        h: 12,
        margin: 1,
        texel: 0.5,
        page: landed ? 2 : 0,
        slot: landed ? slot : 0,
        u0: landed ? 0.1 : 0,
        v0: landed ? 0.2 : 0,
        u1: landed ? 0.3 : 0,
        v1: landed ? 0.4 : 0,
      };
    },
    landing(key: string, t: { x: number; y: number; text: string }) {
      return landed ? atlas.quad(t) : null;
    },
    slotOf() {
      return landed ? slot : -1;
    },
    want(key: string) {
      atlas.wanted.push(key);
    },
    land() {
      landed = true;
      slot++;
      atlas.generation++;
    },
    drop() {
      landed = false;
      atlas.moves++;
      atlas.generation++;
    },
  };
  return atlas;
}

test('a label still being set is packed where it goes, drawn as nothing, and waits', () => {
  const { nodes, edges } = graph(6);
  const atlas = waitingAtlas();
  const packed = new ScenePacker().pack(
    buildScene(input(nodes, edges)),
    'all',
    (t) => atlas.quad(t),
  );
  assert.ok(packed.waiting.length > 0, 'precondition: labels to wait for');
  assert.strictEqual(
    packed.gaps.text,
    packed.waiting.length,
    'counted as gaps',
  );
  for (const w of packed.waiting) {
    const at = w.index * BOX_STRIDE;
    assert.strictEqual(
      packed.boxes[at + 6],
      2,
      'flagged: its field is not set',
    );
    assert.strictEqual(packed.boxes[at + 2], 40, 'at the size it will be');
    assert.strictEqual(w.key.length > 0, true);
  }
});

/** A GL context that records every call and answers the rest with numbers:
 *  enough for the renderer to make its programs and buffers. */
function recordingGl() {
  const log: { name: string; args: unknown[] }[] = [];
  let next = 1;
  const constants = new Map<string, number>();
  const target: Record<string, unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => next++,
  };
  return {
    log,
    gl: new Proxy(target, {
      get(obj, name: string) {
        if (name in obj) return obj[name];
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
          if (!constants.has(name))
            constants.set(name, 0x1000 + constants.size);
          return constants.get(name);
        }
        return (...args: unknown[]) => {
          log.push({ name, args });
          return name.startsWith('create') ? next++ : undefined;
        };
      },
    }),
  };
}

test('a label that lands is written into the world on the GPU, not packed again', async () => {
  const { FlowGlRenderer } = await import('../src/flow/gl/renderer.js');
  const { nodes, edges } = graph(6);
  const atlas = waitingAtlas();
  const { gl, log } = recordingGl();
  const renderer = new FlowGlRenderer(gl);
  const world = buildScene(input(nodes, edges, { selection: null }));
  const overlay = buildScene(input([], [], { selection: null }));
  const target = { origin: { x: 0, y: 0 }, scale: 1, width: 800, height: 600 };
  const frame = { world, offset: { x: 0, y: 0 }, zoom: 1, overlay, phase: 0 };
  const first = renderer.drawFrame(frame, target, atlas as never);
  assert.ok(first.gaps.text > 0, 'precondition: labels waiting');
  const waiting = first.gaps.text;

  // nothing new: the next frame writes nothing
  log.length = 0;
  const idle = renderer.drawFrame(
    { ...frame, world: null },
    target,
    atlas as never,
  );
  assert.strictEqual(idle.gaps.text, waiting);

  atlas.land();
  log.length = 0;
  const next = renderer.drawFrame(
    { ...frame, world: null },
    target,
    atlas as never,
  );
  assert.strictEqual(next.worldRebuilt, false, 'no world packed');
  assert.strictEqual(next.gaps.text, 0, 'every label drawn');
  const uploads = log.filter((c) => c.name === 'bufferData');
  const boxes = uploads
    .map((c) => c.args[1] as Float32Array)
    .find((data) => {
      for (let i = 0; i + BOX_STRIDE <= data.length; i += BOX_STRIDE) {
        if (data[i + 6] === 1 && Math.abs(data[i + 12] - 0.1) < 1e-6)
          return true;
      }
      return false;
    });
  assert.ok(
    boxes,
    'the world’s boxes went up with the landed field written in',
  );
  for (let i = 0; i + BOX_STRIDE <= boxes.length; i += BOX_STRIDE) {
    assert.notStrictEqual(boxes[i + 6], 2, 'no label still waits');
  }
});

test('a label whose field is dropped waits again, and comes back without a world packed', async () => {
  const { FlowGlRenderer } = await import('../src/flow/gl/renderer.js');
  const { nodes, edges } = graph(6);
  const atlas = waitingAtlas();
  const { gl, log } = recordingGl();
  const renderer = new FlowGlRenderer(gl);
  const world = buildScene(input(nodes, edges, { selection: null }));
  const overlay = buildScene(input([], [], { selection: null }));
  const target = { origin: { x: 0, y: 0 }, scale: 1, width: 800, height: 600 };
  const frame = { world, offset: { x: 0, y: 0 }, zoom: 1, overlay, phase: 0 };
  atlas.land();
  const first = renderer.drawFrame(frame, target, atlas as never);
  assert.strictEqual(first.gaps.text, 0, 'precondition: every label drawn');
  // A label's record: flagged 1 or 2, at the fake's texel of 0.5.
  const isLabel = (d: Float32Array, i: number) =>
    (d[i + 6] === 1 || d[i + 6] === 2) && d[i + 7] === 0.5;
  const lastBoxes = () =>
    log
      .filter((c) => c.name === 'bufferData')
      .map((c) => c.args[1] as Float32Array)
      .filter((data) => {
        for (let i = 0; i + BOX_STRIDE <= data.length; i += BOX_STRIDE) {
          if (isLabel(data, i)) return true;
        }
        return false;
      })
      .at(-1)!;
  /** Each label's flag and page, in turn. */
  const labels = (data: Float32Array) => {
    const flags: number[] = [];
    for (let i = 0; i + BOX_STRIDE <= data.length; i += BOX_STRIDE) {
      if (isLabel(data, i)) flags.push(data[i + 6], data[i + 5]);
    }
    return flags;
  };
  assert.ok(
    labels(lastBoxes()).every((v, i) => (i % 2 ? v === 2 : v === 1)),
    'drawn from page 2',
  );

  // The field goes: every label drawn from it is drawn as nothing, and
  // wanted again.
  atlas.drop();
  log.length = 0;
  const dropped = renderer.drawFrame(
    { ...frame, world: null },
    target,
    atlas as never,
  );
  assert.strictEqual(dropped.worldRebuilt, false, 'no world packed');
  assert.strictEqual(dropped.gaps.text, first.gaps.text + atlas.wanted.length);
  assert.ok(atlas.wanted.length > 0, 'its labels asked for it again');
  assert.ok(
    labels(lastBoxes()).every((v, i) => i % 2 || v === 2),
    'every label waits',
  );

  // It lands again, in a new placement: written in again.
  atlas.land();
  log.length = 0;
  const back = renderer.drawFrame(
    { ...frame, world: null },
    target,
    atlas as never,
  );
  assert.strictEqual(back.worldRebuilt, false, 'no world packed');
  assert.strictEqual(back.gaps.text, 0, 'every label drawn again');
  assert.ok(
    labels(lastBoxes()).every((v, i) => (i % 2 ? v === 2 : v === 1)),
    'from its field',
  );
});
