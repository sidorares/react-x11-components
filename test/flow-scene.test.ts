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
import { buildScene, runsReaching, SceneCache } from '../src/flow/scene.js';
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

test('the passes of one frame cull the graph once, and draw what they would alone', () => {
  // A 2D frame paints its damage as several passes — a pan's strips, the
  // pinned furniture, a rounded pane's corners — and the cache culls the
  // graph to the screen once for all of them, keyed on the lists and the
  // viewport. Each pass has to come out as it would built alone, and a
  // frame with the graph moved has to cull again.
  const place = (moved: boolean): SceneNodeSource[] => {
    const out: SceneNodeSource[] = [];
    for (let i = 0; i < 40; i++) {
      const x = (i % 8) * 170 + (moved && i === 9 ? 600 : 0);
      out.push(source(node(`n${i}`, x, Math.floor(i / 8) * 90)));
    }
    return out;
  };
  const edges: FlowEdge[] = [];
  for (let i = 0; i < 40; i++) {
    edges.push({
      id: `e${i}`,
      source: `n${i}`,
      target: `n${(i + 11) % 40}`,
      animated: i % 9 === 0,
    });
  }
  const cache = new SceneCache();
  const v: Viewport = { x: -120, y: 20, zoom: 0.8 };
  const clips = [
    { x: 0, y: 0, width: 6, height: 800 }, // a strip a pan exposed
    { x: 1180, y: 0, width: 20, height: 800 },
    { x: 0, y: 792, width: 8, height: 8 }, // a rounded corner
    { x: 900, y: 600, width: 260, height: 170 }, // the minimap's repair
    null,
  ];
  for (const moved of [false, true]) {
    const nodes = place(moved);
    for (const clip of clips) {
      const cached = buildScene({ ...input(nodes, edges, v, cache), clip });
      const fresh = buildScene({ ...input(nodes, edges, v), clip });
      assert.deepStrictEqual(
        cached.edges.map((e) => [e.id, e.runs?.length ?? 0]),
        fresh.edges.map((e) => [e.id, e.runs?.length ?? 0]),
        `the edges of the pass over ${JSON.stringify(clip)}`,
      );
      for (let i = 0; i < fresh.edges.length; i++) {
        assertSameLine(
          cached.edges[i].points,
          fresh.edges[i].points,
          `${fresh.edges[i].id} over ${JSON.stringify(clip)}`,
        );
      }
      assert.deepStrictEqual(
        cached.nodes.map((n) => [n.id, n.rect]),
        fresh.nodes.map((n) => [n.id, n.rect]),
        `the nodes of the pass over ${JSON.stringify(clip)}`,
      );
      assert.strictEqual(cached.animated, fresh.animated);
    }
    // one cull for the frame: the same lists and viewport get the same list
    const pane = { x: 0, y: 0, width: 1200, height: 800 };
    const sv = { x: v.x, y: v.y, zoom: v.zoom };
    assert.strictEqual(
      cache.edgesOnScreen(sv, pane, edges, nodes, 2),
      cache.edgesOnScreen(sv, pane, edges, nodes, 2),
    );
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

// --- a pass draws what it reaches ----------------------------------------
//
// A partial repaint builds the scene for its own rect. The strip a pan
// exposes down the pane's edge is crossed by every long edge in the graph,
// and a pass over it traced every point of every one of them — a lattice of
// wrap-around edges put a hundred through a strip four pixels wide — and
// the band beside a minimap drew a hundred more whose coarse boxes reached
// it and whose curves did not.

/** A pass over `clip` of the scene `nodes` and `edges` make. */
function pass(
  nodes: readonly SceneNodeSource[],
  edges: readonly FlowEdge[],
  clip: { x: number; y: number; width: number; height: number },
): FlowScene {
  return buildScene({
    ...input(nodes, edges, { x: 0, y: 0, zoom: 1 }),
    clip,
  });
}

const drawn = (edge: FlowScene['edges'][number]): number =>
  (edge.runs ?? [edge.points]).reduce((sum, run) => sum + run.length, 0);

test('a pass over part of a long edge draws the segments it reaches', () => {
  const nodes = [source(node('a', 0, 0)), source(node('b', 900, 500))];
  const edges: FlowEdge[] = [{ id: 'e', source: 'a', target: 'b' }];
  const whole = buildScene(input(nodes, edges, { x: 0, y: 0, zoom: 1 }));
  const route = whole.edges[0].points;
  assert.ok(route.length > 20, `a curve of ${route.length} points`);

  // a strip down the middle of the curve, four pixels wide
  const strip = { x: 500, y: 0, width: 4, height: 800 };
  const edge = pass(nodes, edges, strip).edges[0];
  assert.ok(edge?.runs, 'the edge is drawn in part');
  assert.ok(
    drawn(edge) < route.length / 4,
    `${drawn(edge)} points of ${route.length}`,
  );
  // …and every segment that comes near the strip is in one of the runs
  const reach = edge.lineWidth * 3 + 2;
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i];
    const b = route[i + 1];
    if (Math.max(a.x, b.x) < strip.x - reach) continue;
    if (Math.min(a.x, b.x) > strip.x + strip.width + reach) continue;
    assert.ok(
      edge.runs.some((run) =>
        run.some(
          (p, k) =>
            k + 1 < run.length &&
            p.x === a.x &&
            p.y === a.y &&
            run[k + 1].x === b.x &&
            run[k + 1].y === b.y,
        ),
      ),
      `segment ${i} near the strip is drawn`,
    );
  }
});

test('an edge whose curve misses the pass is not drawn, whatever its box', () => {
  // Diagonal: the corner of the box between the two nodes is far from the
  // curve, and the coarse reject is a box.
  const nodes = [source(node('a', 0, 0)), source(node('b', 900, 500))];
  const edges: FlowEdge[] = [{ id: 'e', source: 'a', target: 'b' }];
  const corner = { x: 820, y: 20, width: 40, height: 40 };
  assert.deepStrictEqual(pass(nodes, edges, corner).edges, []);
});

test('a label plate and an arrowhead are left to the pass that holds them', () => {
  const nodes = [source(node('a', 0, 0)), source(node('b', 900, 0))];
  const edges: FlowEdge[] = [
    { id: 'e', source: 'a', target: 'b', label: 'the middle' },
  ];
  const whole = buildScene(input(nodes, edges, { x: 0, y: 0, zoom: 1 }));
  const chip = whole.edges[0].chip!.rect;
  const head = whole.edges[0].markers[0].points;

  // near the start: the stroke, and neither the plate nor the head
  const start = pass(nodes, edges, { x: 120, y: 0, width: 20, height: 60 });
  assert.strictEqual(start.edges.length, 1);
  assert.strictEqual(start.edges[0].chip, undefined);
  assert.strictEqual(start.edges[0].label, undefined);
  assert.deepStrictEqual(start.edges[0].markers, []);

  // over the plate: the plate and its text
  const middle = pass(nodes, edges, chip);
  assert.ok(middle.edges[0].chip && middle.edges[0].label);

  // over the head: the head
  const at = head[0];
  const end = pass(nodes, edges, {
    x: at.x - 2,
    y: at.y - 2,
    width: 4,
    height: 4,
  });
  assert.strictEqual(end.edges[0].markers.length, 1);
});

test('a dashed edge is cut to the pass, each run knowing how far along it starts', () => {
  // It used to be drawn whole, on the grounds that a run would start the
  // pattern again — and so every marching edge a 2D pan's two-pixel strip
  // crossed was stroked end to end, on X11 a mask the size of its box. The
  // dash offset carries the pattern on from where a run starts (the pixels
  // are held to the whole edge's in test/flow.test.ts).
  const nodes = [source(node('a', 0, 0)), source(node('b', 900, 500))];
  const edges: FlowEdge[] = [
    { id: 'e', source: 'a', target: 'b', animated: true },
  ];
  const whole = buildScene(input(nodes, edges, { x: 0, y: 0, zoom: 1 }))
    .edges[0];
  const edge = pass(nodes, edges, { x: 500, y: 0, width: 4, height: 800 })
    .edges[0];
  assert.ok(edge, 'drawn');
  assert.ok(edge.runs && edge.runs.length > 0, 'cut to what the pass reaches');
  assert.ok(edge.runStarts, 'with where each run starts');
  assert.strictEqual(edge.runStarts.length, edge.runs.length);
  // each start is the length of the route up to the run's first point
  const points = whole.points;
  for (let r = 0; r < edge.runs.length; r++) {
    const first = edge.runs[r][0];
    let length = 0;
    let i = 0;
    for (; i < points.length; i++) {
      if (points[i].x === first.x && points[i].y === first.y) break;
      if (i + 1 < points.length) {
        length += Math.hypot(
          points[i + 1].x - points[i].x,
          points[i + 1].y - points[i].y,
        );
      }
    }
    assert.ok(i < points.length, 'a run starts at a point of the route');
    assert.ok(
      Math.abs(edge.runStarts[r] - length) < 1e-6,
      `run ${r} starts ${length} along, not ${edge.runStarts[r]}`,
    );
  }
  // an undashed edge carries no starts
  const plain = pass(nodes, [{ id: 'e', source: 'a', target: 'b' }], {
    x: 500,
    y: 0,
    width: 4,
    height: 800,
  }).edges[0];
  assert.ok(plain.runs && !plain.runStarts);
});

test('every animated edge on screen is in the box a dash tick repaints', () => {
  // The box came off the edges the pass drew, so a pass that reached one
  // animated edge — a node dragged beside it — made it the only one the
  // next tick repainted, and every other dash on screen stopped.
  const nodes = [
    source(node('a', 0, 0)),
    source(node('b', 300, 0)),
    source(node('c', 0, 600)),
    source(node('d', 300, 600)),
  ];
  const edges: FlowEdge[] = [
    { id: 'top', source: 'a', target: 'b', animated: true },
    { id: 'bottom', source: 'c', target: 'd', animated: true },
  ];
  const whole = buildScene(input(nodes, edges, { x: 0, y: 0, zoom: 1 }));
  const top = pass(nodes, edges, { x: 150, y: 0, width: 20, height: 60 });
  assert.deepStrictEqual(
    top.edges.map((e) => e.id),
    ['top'],
    'the pass draws one of them',
  );
  assert.deepStrictEqual(top.animBox, whole.animBox, 'and ticks both');
  // …and the timer runs for a pass that draws neither
  const neither = pass(nodes, edges, { x: 900, y: 300, width: 20, height: 20 });
  assert.strictEqual(neither.animated, true);
  assert.deepStrictEqual(neither.animBox, whole.animBox);
});

test('runsReaching cuts at the vertices the rect cannot see', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
    { x: 40, y: 0 },
    { x: 50, y: 0 },
  ];
  // all of it: no runs, the route is the run
  assert.strictEqual(
    runsReaching(line, { x: -5, y: -5, width: 60, height: 10 }, 1),
    null,
  );
  // the middle: one run, from the vertex before to the vertex after
  assert.deepStrictEqual(
    runsReaching(line, { x: 24, y: -2, width: 2, height: 4 }, 1),
    [line.slice(2, 4)],
  );
  // two stretches: two runs
  const zigzag = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 100 },
    { x: 20, y: 100 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ];
  assert.deepStrictEqual(
    runsReaching(zigzag, { x: 0, y: -2, width: 40, height: 4 }, 1),
    [zigzag.slice(0, 3), zigzag.slice(3)],
  );
  // none of it: no runs at all
  assert.deepStrictEqual(
    runsReaching(line, { x: 0, y: 50, width: 50, height: 10 }, 1),
    [],
  );
});
