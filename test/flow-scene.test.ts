// `src/flow/scene.ts` — the scene builder and its route cache, with no
// server. Everything here is pure, which is why it is its own file: the
// cache is the kind of thing that breaks silently, drawing last frame's
// curve for an edge that has moved, and the gesture tests in
// `test/flow.test.ts` would only notice if the stale route happened to land
// on a probed pixel.
//
// The property the cache rests on is that **routing is translation-
// equivariant**: move both endpoints by one vector and the whole route moves
// by it. So the central test is the one that holds a cached route to a fresh
// one after a pan, vertex for vertex.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  measureNode,
  normalizeBackground,
  resolveHandles,
  resolvePalette,
} from '../src/flow/model.js';
import { paintPanels } from '../src/flow/paint.js';
import { buildScene, SceneCache } from '../src/flow/scene.js';
import type {
  FlowScene,
  SceneInput,
  SceneNodeSource,
} from '../src/flow/scene.js';
import type {
  EdgeType,
  FlowEdge,
  FlowNode,
  Viewport,
  XYPosition,
} from '../src/flow/types.js';

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

function node(id: string, x: number, y: number): FlowNode {
  return {
    id,
    position: { x, y },
    width: 100,
    height: 40,
    data: { label: id },
    sourcePosition: 'right',
    targetPosition: 'left',
  };
}

function input(
  nodes: readonly SceneNodeSource[],
  edges: readonly FlowEdge[],
  viewport: Viewport,
  cache?: SceneCache,
): SceneInput {
  return {
    viewport,
    pane: { x: 0, y: 0, width: 1200, height: 800 },
    clip: null,
    palette: resolvePalette(null, undefined),
    background: normalizeBackground({ variant: 'dots', gap: 24 }),
    nodes,
    all: nodes,
    edges,
    dashPhase: 0,
    hover: { nodeId: null, handle: null, edgeId: null },
    connection: null,
    selection: null,
    miniMap: null,
    controls: [],
    scale: 2,
    measure,
    cache,
  };
}

/** The stroked points of one edge, copied out — the cache moves its arrays
 *  in place, so a test holding one across frames must take a copy. */
function strokeOf(scene: FlowScene, id: string): XYPosition[] {
  const edge = scene.edges.find((e) => e.id === id);
  assert.ok(edge, `edge ${id} was drawn`);
  return edge.points.map((p) => ({ x: p.x, y: p.y }));
}

function headOf(scene: FlowScene, id: string): XYPosition[] {
  const edge = scene.edges.find((e) => e.id === id);
  assert.ok(edge && edge.markers.length > 0, `edge ${id} has a head`);
  return edge.markers[0].points.map((p) => ({ x: p.x, y: p.y }));
}

/** Two polylines the same to within float addition. */
function assertSameLine(
  actual: readonly XYPosition[],
  expected: readonly XYPosition[],
  message: string,
): void {
  assert.strictEqual(actual.length, expected.length, `${message}: length`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(actual[i].x - expected[i].x) < 1e-6 &&
        Math.abs(actual[i].y - expected[i].y) < 1e-6,
      `${message}: vertex ${i} is (${actual[i].x}, ${actual[i].y}), ` +
        `expected (${expected[i].x}, ${expected[i].y})`,
    );
  }
}

const TYPES: (EdgeType | undefined)[] = [
  undefined,
  'bezier',
  'straight',
  'step',
  'smoothstep',
];

for (const type of TYPES) {
  test(`a cached ${type ?? 'default'} route, panned, is the route computed fresh`, () => {
    // Every edge type, because the claim is about all of them: the ones with
    // clamps against pixel constants (a step's offset, a fillet's radius)
    // are exactly the ones a scale would break and a translation must not.
    const nodes = [source(node('a', 0, 0)), source(node('b', 260, 140))];
    const edges: FlowEdge[] = [{ id: 'e', source: 'a', target: 'b', type }];
    const cache = new SceneCache();
    const start: Viewport = { x: 40, y: 30, zoom: 1.3 };
    buildScene(input(nodes, edges, start, cache));

    for (const [dx, dy] of [
      [17, 0],
      [0, -9],
      [123.5, 44.25],
      [-300, 7],
    ]) {
      const panned = { x: start.x + dx, y: start.y + dy, zoom: start.zoom };
      const cached = buildScene(input(nodes, edges, panned, cache));
      const fresh = buildScene(input(nodes, edges, panned));
      assertSameLine(
        strokeOf(cached, 'e'),
        strokeOf(fresh, 'e'),
        `stroke after a pan of (${dx}, ${dy})`,
      );
      assertSameLine(
        headOf(cached, 'e'),
        headOf(fresh, 'e'),
        `arrowhead after a pan of (${dx}, ${dy})`,
      );
    }
  });
}

test('a self-loop, cached and panned, is the loop computed fresh', () => {
  const nodes = [source(node('a', 100, 100))];
  const edges: FlowEdge[] = [{ id: 'loop', source: 'a', target: 'a' }];
  const cache = new SceneCache();
  buildScene(input(nodes, edges, { x: 0, y: 0, zoom: 0.8 }, cache));
  const panned = { x: 55, y: -20, zoom: 0.8 };
  assertSameLine(
    strokeOf(buildScene(input(nodes, edges, panned, cache)), 'loop'),
    strokeOf(buildScene(input(nodes, edges, panned)), 'loop'),
    'loop after a pan',
  );
});

test('a zoom rebuilds the route rather than scaling the cached one', () => {
  // A bezier's shoulder is a square root of the gap when the ends face away,
  // so the curve at twice the zoom is not the curve at one zoom doubled —
  // which is why the cache keys on the zoom at all.
  const nodes = [source(node('a', 300, 0)), source(node('b', 0, 120))];
  const edges: FlowEdge[] = [{ id: 'back', source: 'a', target: 'b' }];
  const cache = new SceneCache();
  buildScene(input(nodes, edges, { x: 0, y: 0, zoom: 1 }, cache));
  const zoomed = { x: 0, y: 0, zoom: 2.2 };
  assertSameLine(
    strokeOf(buildScene(input(nodes, edges, zoomed, cache)), 'back'),
    strokeOf(buildScene(input(nodes, edges, zoomed)), 'back'),
    'route after a zoom',
  );
});

test('moving a node reroutes its edges and nothing else', () => {
  const a = source(node('a', 0, 0));
  const b = source(node('b', 300, 0));
  const c = source(node('c', 0, 200));
  const d = source(node('d', 300, 200));
  const edges: FlowEdge[] = [
    { id: 'ab', source: 'a', target: 'b' },
    { id: 'cd', source: 'c', target: 'd' },
  ];
  const cache = new SceneCache();
  const v = { x: 20, y: 20, zoom: 1 };
  const first = buildScene(input([a, b, c, d], edges, v, cache));
  const untouched = first.edges.find((e) => e.id === 'cd')!.points;

  // b moves: a new source, as the element builds one per paint mid-drag
  const moved = source(node('b', 360, 90));
  const after = buildScene(input([a, moved, c, d], edges, v, cache));

  assertSameLine(
    strokeOf(after, 'ab'),
    strokeOf(buildScene(input([a, moved, c, d], edges, v)), 'ab'),
    'the moved edge follows its node',
  );
  // and the other edge is the same array, not merely the same numbers: it
  // was a hit, which is what makes a drag cost one edge rather than all
  assert.strictEqual(
    after.edges.find((e) => e.id === 'cd')!.points,
    untouched,
    'an edge not touching the moved node is reused, not rebuilt',
  );
});

test('an edge id re-pointed at another node is rerouted', () => {
  // The rects alone cannot see this: two nodes can sit in the same place.
  // The cache keys on the endpoint ids for exactly that reason.
  const a = source(node('a', 0, 0));
  const b = source(node('b', 300, 0));
  const twin = source(node('twin', 300, 0));
  const cache = new SceneCache();
  const v = { x: 0, y: 0, zoom: 1 };
  buildScene(
    input([a, b, twin], [{ id: 'e', source: 'a', target: 'b' }], v, cache),
  );
  const repointed: FlowEdge[] = [{ id: 'e', source: 'b', target: 'a' }];
  assertSameLine(
    strokeOf(buildScene(input([a, b, twin], repointed, v, cache)), 'e'),
    strokeOf(buildScene(input([a, b, twin], repointed, v)), 'e'),
    'a re-pointed edge',
  );
});

test('changing an arrowhead reroutes the stroke it stops behind', () => {
  // The head decides where the stroke ends: a bigger head is a shorter
  // stroke, so the marker's size is part of the route and not only its ink.
  const nodes = [source(node('a', 0, 0)), source(node('b', 300, 60))];
  const cache = new SceneCache();
  const v = { x: 0, y: 0, zoom: 1 };
  buildScene(input(nodes, [{ id: 'e', source: 'a', target: 'b' }], v, cache));
  const bigger: FlowEdge[] = [
    {
      id: 'e',
      source: 'a',
      target: 'b',
      markerEnd: { type: 'arrowclosed', size: 22 },
    },
  ];
  assertSameLine(
    strokeOf(buildScene(input(nodes, bigger, v, cache)), 'e'),
    strokeOf(buildScene(input(nodes, bigger, v)), 'e'),
    'the stroke after its head grew',
  );
});

test('selection recolours an edge without rerouting it', () => {
  // Ink is the frame's; geometry is the cache's. A selected edge is a new
  // colour on the same curve, and must stay a hit.
  const nodes = [source(node('a', 0, 0)), source(node('b', 300, 60))];
  const cache = new SceneCache();
  const v = { x: 0, y: 0, zoom: 1 };
  const plain = buildScene(
    input(nodes, [{ id: 'e', source: 'a', target: 'b' }], v, cache),
  );
  const points = plain.edges[0].points;
  const stroke = plain.edges[0].stroke;
  const selected = buildScene(
    input(
      nodes,
      [{ id: 'e', source: 'a', target: 'b', selected: true }],
      v,
      cache,
    ),
  );
  assert.notStrictEqual(selected.edges[0].stroke, stroke, 'it was recoloured');
  assert.strictEqual(selected.edges[0].points, points, 'and not rerouted');
  assert.strictEqual(
    selected.edges[0].markers[0].color,
    selected.edges[0].stroke,
    'the head took the new colour too',
  );
});

test('a scene built with a cache is the scene built without one', () => {
  // The whole frame, not one edge: labels, chips, heads and all, across a
  // few pans — the claim that the cache changes the cost and nothing else.
  const nodes: SceneNodeSource[] = [];
  const edges: FlowEdge[] = [];
  for (let i = 0; i < 24; i++) {
    nodes.push(source(node(`n${i}`, (i % 6) * 180, Math.floor(i / 6) * 110)));
  }
  for (let i = 0; i < 24; i++) {
    edges.push({
      id: `e${i}`,
      source: `n${i}`,
      target: `n${(i + 7) % 24}`,
      type: TYPES[i % TYPES.length],
      label: i % 3 === 0 ? `label ${i}` : undefined,
      animated: i % 5 === 0,
      markerStart: i % 4 === 0 ? 'arrow' : undefined,
    });
  }
  const cache = new SceneCache();
  for (const v of [
    { x: 0, y: 0, zoom: 0.9 },
    { x: 40, y: -15, zoom: 0.9 },
    { x: 41.5, y: -15, zoom: 0.9 },
    { x: -200, y: 60, zoom: 0.9 },
  ]) {
    const cached = buildScene(input(nodes, edges, v, cache));
    const fresh = buildScene(input(nodes, edges, v));
    assert.strictEqual(cached.edges.length, fresh.edges.length, 'edge count');
    for (let i = 0; i < fresh.edges.length; i++) {
      const want = fresh.edges[i];
      const got = cached.edges[i];
      assert.strictEqual(got.id, want.id);
      assertSameLine(got.points, want.points, `${want.id} stroke`);
      assert.strictEqual(got.markers.length, want.markers.length);
      for (let m = 0; m < want.markers.length; m++) {
        assertSameLine(
          got.markers[m].points,
          want.markers[m].points,
          `${want.id} head ${m}`,
        );
      }
      // A chip is rounded to whole pixels when it is built, so it is exact.
      // A label's anchor is not — the painter rounds it on the device grid —
      // so it is allowed the float addition a pan does in place, and nothing
      // else: text, size, colour and alignment all compare exactly.
      assert.deepStrictEqual(got.chip, want.chip, `${want.id} chip`);
      if (want.label) {
        assert.ok(got.label, `${want.id} label`);
        const { x: gx, y: gy, ...gotRest } = got.label;
        const { x: wx, y: wy, ...wantRest } = want.label;
        assert.deepStrictEqual(gotRest, wantRest, `${want.id} label`);
        assertSameLine(
          [{ x: gx, y: gy }],
          [{ x: wx, y: wy }],
          `${want.id} label anchor`,
        );
      } else {
        assert.strictEqual(got.label, undefined, `${want.id} has no label`);
      }
    }
    // The dash box is damage, grown outward to whole device pixels before
    // it is claimed, so the same tolerance as a label's anchor.
    if (fresh.animBox) {
      assert.ok(cached.animBox, 'animBox');
      const a = cached.animBox;
      const b = fresh.animBox;
      assertSameLine(
        [
          { x: a.x, y: a.y },
          { x: a.x + a.width, y: a.y + a.height },
        ],
        [
          { x: b.x, y: b.y },
          { x: b.x + b.width, y: b.y + b.height },
        ],
        'animBox',
      );
    } else {
      assert.strictEqual(cached.animBox, null, 'no animBox');
    }
  }
});

test('a minimap’s run of one colour is one fill, in the order it was drawn', () => {
  // A call apiece was 400 of them on every repaint of a drag. Runs are
  // consecutive, not grouped: two colours that overlap keep their order.
  const calls: string[] = [];
  const noop = (): void => {};
  const painter = {
    raw: null,
    scale: 1,
    save: noop,
    restore: noop,
    clipRect: noop,
    rect: (
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      _r: number,
      o: { fill?: string },
    ) => void calls.push(`rect ${o.fill}`),
    polygons: (shapes: readonly unknown[], o: { fill?: string }) =>
      void calls.push(`polygons ${shapes.length} ${o.fill}`),
    circle: noop,
    polyline: noop,
    polygon: noop,
    strokeRuns: noop,
    dots: noop,
    text: noop,
    measureText: () => ({ width: 0, height: 0 }),
  };
  const node = (x: number, fill: string) => ({
    rect: { x, y: 0, width: 4, height: 3 },
    radius: 0,
    fill,
  });
  paintPanels(painter, {
    miniMap: {
      panel: {
        rect: { x: 0, y: 0, width: 40, height: 20 },
        radius: 4,
        fill: 'panel',
      },
      nodes: [
        node(0, 'a'),
        node(5, 'a'),
        node(10, 'a'),
        node(15, 'b'),
        node(20, 'a'),
      ],
      view: {
        rect: { x: 0, y: 0, width: 10, height: 10 },
        radius: 0,
        fill: 'view',
      },
    },
    controls: null,
  });
  assert.deepStrictEqual(calls, [
    'rect panel',
    'polygons 3 a',
    'rect b',
    'rect a',
    'rect view',
  ]);
});
