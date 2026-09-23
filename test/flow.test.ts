// `<Flow>` — the three ways a registered element fails silently, the pure
// model, and then the gestures, which is where a graph editor actually
// lives.
//
// The pure half (`applyNodeChanges`, the edge routing, `fitViewport`) is
// tested without a server: it was put in `src/flow/model.ts` and
// `src/flow/paths.ts` precisely so that it could be. The gesture tests run
// on the default `'xserver'` backend, because `fireEvent` injects through
// the X server — still headless, still no `$DISPLAY`.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  act,
  cleanup,
  expectPixel,
  fireEvent,
  isNear,
  nodeUtterance,
  pixelAt,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import { drawnKinds, knownElements } from 'react-x11/host';
import { isStyleProp } from 'react-x11/style';
import { keysymOf, XK_DELETE, XK_ESCAPE, XK_RIGHT } from 'react-x11/keysyms';
import type { Node as RetainedNode } from 'react-x11/node';
import type { DrawnNode } from 'react-x11';

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  connectedEdges,
  connectionId,
  Flow,
  FLOW_ELEMENT,
} from '../src/index.js';
import type {
  Connection,
  EdgeChange,
  FlowEdge,
  FlowFrameStats,
  FlowRect,
  FlowInstance,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  FlowProps,
  NodeBodyRect,
  NodeChange,
  NodeRenderContext,
} from '../src/index.js';
import {
  boundsOf,
  fitViewport,
  inflateRect,
  intersectRects,
  measureNode,
  resizeRect,
  resolveHandles,
  unionRects,
} from '../src/flow/model.js';
import {
  bezierControls,
  distanceToPath,
  edgePath,
  pointAtFraction,
} from '../src/flow/paths.js';

const h = React.createElement;

/** {@link Flow} with its node-data parameter fixed — see `mount` below. */
const TypedFlow = Flow<FlowNodeData, unknown>;

afterEach(cleanup);

/** The queries hand back the retained node; their public type describes the
 *  narrower ref-facing view. Same widening as `sparkline.test.ts`. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

function pane(): RetainedNode {
  const [node] = screen.all((n) => retained(n).kind === FLOW_ELEMENT);
  assert.ok(node, 'the pane is in the retained tree');
  return retained(node);
}

/** The one box `<Flow>` lays mounted bodies out in, at the graph's origin
 *  in the pane — a pan moves it and nothing inside it. */
function bodyLayer(): RetainedNode {
  // inside the box that clips it to the pane
  const clip = pane().parent!.children.find((c) => c.kind === 'box');
  const layer = clip?.children.find((c) => c.kind === 'box');
  assert.ok(layer, 'the bodies’ box is mounted');
  return retained(layer);
}

/** A mounted node's box in {@link bodyLayer}: its card's canvas, then its
 *  body over it. */
function cardBox(index = 0): RetainedNode {
  const box = bodyLayer().children[index];
  assert.ok(box, 'the node’s box is mounted');
  return retained(box);
}

/** A mounted body's own box, positioned inside its {@link cardBox}. */
function bodyBox(index = 0): RetainedNode {
  const box = cardBox(index).children[1];
  assert.ok(box, 'the body box is mounted');
  return retained(box);
}

/** The bodies are held through a zoom gesture (`_holdBodies`). */
function bodiesAway(): boolean {
  return (bodyLayer().props.style as { display?: string }).display === 'none';
}

/** Where a mounted body's box sits in the pane: the bodies' one box's
 *  place plus the body's own inside it. */
function bodyPlace(index = 0): { left: number; top: number } {
  const layer = bodyLayer().props.style as { left: number; top: number };
  const card = cardBox(index).props.style as { left: number; top: number };
  const own = bodyBox(index).props.style as { left: number; top: number };
  return {
    left: layer.left + card.left + own.left,
    top: layer.top + card.top + own.top,
  };
}

/** A window coordinate as the offset from the pane's centre that
 *  `fireEvent` wants. The pane fills the test window, and the default
 *  viewport is the identity, so window coordinates *are* graph
 *  coordinates. (At the 1x scale the suite runs at, `abs` and the injected
 *  offsets are device pixels that happen to be logical ones too — see
 *  `at2x` below for the case where they are not.) */
function at(x: number, y: number): { dx: number; dy: number } {
  const { abs } = pane();
  return { dx: x - (abs.x + abs.width / 2), dy: y - (abs.y + abs.height / 2) };
}

/** Two boxes 120×40, one above the other, joined by one edge. Explicit
 *  sizes so every coordinate below is arithmetic rather than a measured
 *  string's width. */
function nodes(): FlowNode[] {
  return [
    {
      id: 'a',
      position: { x: 100, y: 100 },
      width: 120,
      height: 40,
      data: { label: 'A' },
    },
    {
      id: 'b',
      position: { x: 100, y: 300 },
      width: 120,
      height: 40,
      data: { label: 'B' },
    },
  ];
}

function edges(): FlowEdge[] {
  return [{ id: 'a-b', source: 'a', target: 'b' }];
}

// With the default handles — target on top, source on the bottom, react-flow's
// — node `a`'s source is at (160, 140) and node `b`'s target at (160, 300).
const A_SOURCE = { x: 160, y: 140 };
const B_TARGET = { x: 160, y: 300 };

interface Recorded {
  nodeChanges: NodeChange[][];
  edgeChanges: EdgeChange[][];
  connections: Connection[];
}

async function mount(
  props: Partial<FlowProps> = {},
): Promise<{ recorded: Recorded; flow: { current: FlowInstance | null } }> {
  const recorded: Recorded = {
    nodeChanges: [],
    edgeChanges: [],
    connections: [],
  };
  const flow: { current: FlowInstance | null } = { current: null };
  // `TypedFlow` rather than `Flow`: the component is generic over its node
  // data, JSX infers that parameter from `nodes` — and `createElement`,
  // which these tests use because they are `.ts`, cannot. An instantiation
  // expression pins it once instead of casting at every call.
  const all: FlowProps = {
    ref: flow,
    nodes: nodes(),
    edges: edges(),
    onNodesChange: (c) => void recorded.nodeChanges.push(c),
    onEdgesChange: (c) => void recorded.edgeChanges.push(c),
    onConnect: (c) => void recorded.connections.push(c),
    ...props,
  };
  await renderX11(h(TypedFlow, all));
  return { recorded, flow };
}

/** Every change of one kind, flattened out of the batches they arrived in
 *  and narrowed to that member of the union — so a test can read `.id` and
 *  `.position` off what it asked for. */
function ofType<T extends { type: string }, K extends T['type']>(
  batches: T[][],
  type: K,
): Extract<T, { type: K }>[] {
  return batches
    .flat()
    .filter(
      (change): change is Extract<T, { type: K }> => change.type === type,
    );
}

// --- the element ------------------------------------------------------------

test('importing the component is what registers the element', () => {
  assert.strictEqual(FLOW_ELEMENT, 'flowgraph');
  assert.ok(knownElements().includes(FLOW_ELEMENT));
  // the trap: a kind outside this set lays out, reports a sensible rect, and
  // never appears on screen, with no error anywhere
  assert.ok(drawnKinds().includes(FLOW_ELEMENT));
});

test('no prop name of this element is also a style name', () => {
  // The other trap. An element whose vocabulary overlaps the style
  // vocabulary must declare `semanticNames` or it throws on its own props in
  // development and works in production — the worst shape a bug can have.
  // `<Flow>` declares none, and this is what keeps that honest as props are
  // added: `background` is safe only because the style name is
  // `backgroundColor`.
  assert.strictEqual(isStyleProp('backgroundColor'), true, 'precondition');
  const props = [
    'nodes',
    'edges',
    'onNodesChange',
    'onEdgesChange',
    'onConnect',
    'onConnectStart',
    'onConnectEnd',
    'isValidConnection',
    'connectionMode',
    'nodeTypes',
    'defaultEdgeOptions',
    'onNodeClick',
    'onNodeDoubleClick',
    'onNodeContextMenu',
    'onNodeDragStart',
    'onNodeDragStop',
    'onEdgeClick',
    'onEdgeContextMenu',
    'onPaneClick',
    'onPaneContextMenu',
    'viewport',
    'defaultViewport',
    'onViewportChange',
    'fitView',
    'fitViewOptions',
    'minZoom',
    'maxZoom',
    'nodesDraggable',
    'nodesConnectable',
    'elementsSelectable',
    'panOnDrag',
    'zoomOnScroll',
    'zoomOnDoubleClick',
    'selectionOnDrag',
    'deleteOnKey',
    'snapToGrid',
    'snapGrid',
    'background',
    'minimap',
    'controls',
    'palette',
  ];
  const collisions = props.filter(isStyleProp);
  assert.deepStrictEqual(collisions, [], 'these need `semanticNames`');
});

test('it mounts, fills its parent and joins the paint order', async () => {
  await mount();
  const node = pane();
  assert.strictEqual(node.abs.width, 640);
  assert.strictEqual(node.abs.height, 480);
  const { parent } = node;
  assert.ok(parent, 'the pane is attached');
  assert.ok(
    parent.paintOrder().includes(node),
    'painted by its parent rather than silently skipped',
  );
});

test('a style of its own wins over the default `flexGrow`', async () => {
  await renderX11(
    h(
      'box',
      { style: { flexGrow: 1 } },
      h(TypedFlow, { nodes: nodes(), style: { height: 120 } }),
    ),
    { backend: 'mock' },
  );
  assert.strictEqual(pane().abs.height, 120);
});

test('the pane draws its own contents, so it refuses children', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      () =>
        renderX11(h(TypedFlow, { nodes: [] }, h('box', null)), {
          backend: 'mock',
        }),
      /<flowgraph> takes no children/,
    );
  } finally {
    console.error = origError;
  }
});

// --- the model, with no server in sight -------------------------------------

test('applyNodeChanges folds each kind of change', () => {
  const initial = nodes();
  const moved = applyNodeChanges(
    [{ type: 'position', id: 'a', position: { x: 7, y: 9 } }],
    initial,
  );
  assert.deepStrictEqual(moved[0].position, { x: 7, y: 9 });
  assert.deepStrictEqual(
    initial[0].position,
    { x: 100, y: 100 },
    'not mutated',
  );

  const selected = applyNodeChanges(
    [{ type: 'select', id: 'b', selected: true }],
    initial,
  );
  assert.strictEqual(selected[1].selected, true);
  assert.strictEqual(selected[0].selected, undefined, 'only the one named');

  const removed = applyNodeChanges([{ type: 'remove', id: 'a' }], initial);
  assert.deepStrictEqual(
    removed.map((n) => n.id),
    ['b'],
  );

  const added = applyNodeChanges(
    [{ type: 'add', item: { id: 'c', position: { x: 0, y: 0 } } }],
    initial,
  );
  assert.deepStrictEqual(
    added.map((n) => n.id),
    ['a', 'b', 'c'],
  );
});

test('a change that changes nothing hands back the same array', () => {
  const initial = nodes();
  // What a `React.memo` or a `useMemo` above the pane depends on, and what
  // makes a drag that snapped back to the same pixel free.
  assert.strictEqual(applyNodeChanges([], initial), initial);
  assert.strictEqual(
    applyNodeChanges(
      [{ type: 'position', id: 'a', position: { x: 100, y: 100 } }],
      initial,
    ),
    initial,
  );
  assert.strictEqual(
    applyNodeChanges([{ type: 'remove', id: 'ghost' }], initial),
    initial,
  );
});

test('applyEdgeChanges selects and removes by id', () => {
  const initial = edges();
  assert.strictEqual(
    applyEdgeChanges(
      [{ type: 'select', id: 'a-b', selected: true }],
      initial,
    )[0].selected,
    true,
  );
  assert.deepStrictEqual(
    applyEdgeChanges([{ type: 'remove', id: 'a-b' }], initial),
    [],
  );
});

test('addEdge is idempotent, because its id is derived from the ends', () => {
  const connection: Connection = {
    source: 'a',
    target: 'b',
    sourceHandle: null,
    targetHandle: null,
  };
  const once = addEdge(connection, []);
  assert.strictEqual(once.length, 1);
  assert.strictEqual(once[0].id, connectionId(connection));
  assert.strictEqual(addEdge(connection, once).length, 1, 'no duplicate');

  // extra fields ride along, which is how a whole graph gets one edge style
  const styled = addEdge({ ...connection, animated: true, type: 'step' }, []);
  assert.strictEqual(styled[0].animated, true);
  assert.strictEqual(styled[0].type, 'step');
  // a second handle pair on the same two nodes is a different edge
  assert.strictEqual(
    addEdge({ ...connection, sourceHandle: 'err' }, once).length,
    2,
  );
});

test('connectedEdges finds what a delete would leave dangling', () => {
  const all: FlowEdge[] = [
    { id: '1', source: 'a', target: 'b' },
    { id: '2', source: 'b', target: 'c' },
    { id: '3', source: 'c', target: 'd' },
  ];
  assert.deepStrictEqual(
    connectedEdges(['b'], all).map((e) => e.id),
    ['1', '2'],
  );
});

test('a node with no size is measured, and one with a size is not', () => {
  const measure = (text: string): number => text.length * 8;
  const sized = measureNode(
    { id: 'a', position: { x: 0, y: 0 }, width: 300, height: 20 },
    undefined,
    measure,
  );
  assert.deepStrictEqual(sized, { width: 300, height: 20 });

  const short = measureNode(
    { id: 'a', position: { x: 0, y: 0 } },
    undefined,
    measure,
  );
  assert.ok(short.width >= 110, 'a floor, so a one-letter node is not a dot');
  const long = measureNode(
    { id: 'a', position: { x: 0, y: 0 }, data: { label: 'x'.repeat(200) } },
    undefined,
    measure,
  );
  assert.ok(
    long.width <= 260,
    'and a ceiling, so one long label is not a wall',
  );
  const described = measureNode(
    {
      id: 'a',
      position: { x: 0, y: 0 },
      data: { label: 'a', description: 'b' },
    },
    undefined,
    measure,
  );
  assert.ok(described.height > short.height, 'a second line is taller');
});

test("the default handles are react-flow's: target in at the top, source out at the bottom", () => {
  const specs = resolveHandles(
    { id: 'a', position: { x: 0, y: 0 } },
    undefined,
  );
  assert.deepStrictEqual(
    specs.map((s) => [s.type, s.position]),
    [
      ['target', 'top'],
      ['source', 'bottom'],
    ],
  );
  const sideways = resolveHandles(
    {
      id: 'a',
      position: { x: 0, y: 0 },
      sourcePosition: 'right',
      targetPosition: 'left',
    },
    undefined,
  );
  assert.deepStrictEqual(
    sideways.map((s) => s.position),
    ['left', 'right'],
  );
});

test('fitViewport frames the bounds without cutting either axis', () => {
  const bounds = { x: -100, y: -50, width: 400, height: 200 };
  const viewport = fitViewport(
    bounds,
    { width: 800, height: 600 },
    { padding: 0 },
    {
      minZoom: 0.1,
      maxZoom: 4,
    },
  );
  // the tighter axis decides, so nothing is cut
  assert.strictEqual(viewport.zoom, 2);
  // and the scaled bounds land centred
  const centreX = (bounds.x + bounds.width / 2) * viewport.zoom + viewport.x;
  const centreY = (bounds.y + bounds.height / 2) * viewport.zoom + viewport.y;
  assert.strictEqual(centreX, 400);
  assert.strictEqual(centreY, 300);

  const clamped = fitViewport(
    bounds,
    { width: 8000, height: 6000 },
    { padding: 0 },
    {
      minZoom: 0.1,
      maxZoom: 1.5,
    },
  );
  assert.strictEqual(clamped.zoom, 1.5, 'maxZoom wins over the fit');
});

test('boundsOf is null for nothing, and the union otherwise', () => {
  assert.strictEqual(boundsOf([]), null);
  assert.deepStrictEqual(
    boundsOf([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: -5, width: 10, height: 10 },
    ]),
    { x: 0, y: -5, width: 30, height: 15 },
  );
});

test('the rect helpers behind damage tracking', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 20, y: 5, width: 10, height: 10 };
  assert.deepStrictEqual(unionRects(a, b), {
    x: 0,
    y: 0,
    width: 30,
    height: 15,
  });
  assert.deepStrictEqual(inflateRect(a, 3), {
    x: -3,
    y: -3,
    width: 16,
    height: 16,
  });
  assert.deepStrictEqual(intersectRects(a, b), null, 'disjoint boxes');
  assert.deepStrictEqual(
    intersectRects(a, { x: 5, y: 5, width: 10, height: 10 }),
    { x: 5, y: 5, width: 5, height: 5 },
  );
});

// --- edge routing -----------------------------------------------------------

const ROUTE = { stepOffset: 20, radius: 8, scale: 1 };

test('every edge kind starts at the source and ends at the target', () => {
  const source = { x: 0, y: 0, position: 'right' as const };
  const target = { x: 200, y: 120, position: 'left' as const };
  for (const type of ['bezier', 'smoothstep', 'step', 'straight'] as const) {
    const points = edgePath(type, source, target, ROUTE);
    assert.ok(points.length >= 2, `${type} has a path`);
    assert.deepStrictEqual(
      { x: points[0].x, y: points[0].y },
      { x: 0, y: 0 },
      `${type} starts on the handle`,
    );
    assert.deepStrictEqual(
      { x: points[points.length - 1].x, y: points[points.length - 1].y },
      { x: 200, y: 120 },
      `${type} ends on the handle`,
    );
  }
});

test('a step edge leaves each handle along its own side before it turns', () => {
  const points = edgePath(
    'step',
    { x: 0, y: 0, position: 'right' },
    { x: 200, y: 120, position: 'left' },
    ROUTE,
  );
  assert.deepStrictEqual(points[1], { x: 20, y: 0 }, 'out to the right first');
  assert.deepStrictEqual(
    points[points.length - 2],
    { x: 180, y: 120 },
    'and in from the left last',
  );
  // orthogonal all the way: every segment moves in exactly one axis
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(points[i].x - points[i - 1].x);
    const dy = Math.abs(points[i].y - points[i - 1].y);
    assert.ok(dx < 0.001 || dy < 0.001, `segment ${i} is axis-aligned`);
  }
});

test('smoothstep is the step route with its corners rounded off', () => {
  const step = edgePath(
    'step',
    { x: 0, y: 0, position: 'right' },
    { x: 200, y: 120, position: 'left' },
    ROUTE,
  );
  const smooth = edgePath(
    'smoothstep',
    { x: 0, y: 0, position: 'right' },
    { x: 200, y: 120, position: 'left' },
    ROUTE,
  );
  assert.ok(smooth.length > step.length, 'the fillets add points');
  // no vertex sits exactly on a corner any more
  assert.ok(
    !smooth.some((p) => p.x === 100 && p.y === 0),
    'the corner itself was replaced by an arc',
  );
});

test('a self-edge encloses area instead of doubling back on itself', () => {
  const points = edgePath(
    'bezier',
    { x: 0, y: 0, position: 'right' },
    { x: 0, y: 0, position: 'left' },
    { ...ROUTE, loop: true },
  );
  const far = Math.max(...points.map((p) => Math.hypot(p.x, p.y)));
  assert.ok(far > 20, 'it goes somewhere');
});

test('distanceToPath is what an edge is hit-tested with', () => {
  const points = edgePath(
    'straight',
    { x: 0, y: 0, position: 'right' },
    { x: 100, y: 0, position: 'left' },
    ROUTE,
  );
  assert.strictEqual(distanceToPath(points, { x: 50, y: 0 }), 0);
  assert.strictEqual(distanceToPath(points, { x: 50, y: 4 }), 4);
  assert.ok(distanceToPath(points, { x: 500, y: 0 }) > 100, 'past the end');
});

test('a label goes half way along by arc length, not half way between the ends', () => {
  const points = edgePath(
    'step',
    { x: 0, y: 0, position: 'bottom' },
    { x: 200, y: 200, position: 'top' },
    ROUTE,
  );
  const middle = pointAtFraction(points, 0.5);
  assert.ok(middle.x > 0 && middle.x < 200);
  assert.ok(middle.y > 0 && middle.y < 200);
});

// --- gestures ---------------------------------------------------------------

test('a press on a node selects it, and a release without motion is a click', async () => {
  const clicked: string[] = [];
  const { recorded } = await mount({
    onNodeClick: (_ev: unknown, node: FlowNode) => clicked.push(node.id),
  });
  await userEvent.click(pane() as unknown as DrawnNode, at(160, 120));
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'select').map((c) => [
      c.id,
      'selected' in c && c.selected,
    ]),
    [['a', true]],
  );
  assert.deepStrictEqual(clicked, ['a']);
});

test('a press on the empty pane clears the selection', async () => {
  const paneClicks: number[] = [];
  const { recorded } = await mount({
    nodes: nodes().map((n) => ({ ...n, selected: true })),
    onPaneClick: () => paneClicks.push(1),
  });
  await userEvent.click(pane() as unknown as DrawnNode, at(500, 60));
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'select').map((c) => [
      c.id,
      'selected' in c && c.selected,
    ]),
    [
      ['a', false],
      ['b', false],
    ],
  );
  assert.strictEqual(paneClicks.length, 1);
});

test('dragging a node reports every step, then the one that settles it', async () => {
  const { recorded } = await mount();
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(160, 120));
    fireEvent.mouseMove(node, at(200, 160));
    fireEvent.mouseUp(node, at(200, 160));
  });
  const positions = ofType(recorded.nodeChanges, 'position');
  assert.ok(positions.length >= 2, 'at least one step and the settle');
  const last = positions[positions.length - 1];
  assert.ok(last.type === 'position');
  assert.deepStrictEqual(last.position, { x: 140, y: 140 });
  assert.strictEqual(last.dragging, false, 'the change worth persisting');
  assert.ok(
    positions
      .slice(0, -1)
      .every((c) => c.type === 'position' && c.dragging === true),
    'every step before it is mid-drag',
  );
});

test('snapToGrid rounds the drag, not the pointer', async () => {
  const { recorded } = await mount({ snapToGrid: true, snapGrid: [50, 50] });
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(160, 120));
    fireEvent.mouseMove(node, at(183, 143));
    fireEvent.mouseUp(node, at(183, 143));
  });
  const positions = ofType(recorded.nodeChanges, 'position');
  const last = positions[positions.length - 1];
  assert.ok(last.type === 'position');
  // 100 + 23 = 123, snapped to the nearest 50
  assert.deepStrictEqual(last.position, { x: 100, y: 100 });
});

test('an uncontrolled pane owns the arrays and moves the node itself', async () => {
  const flow: { current: FlowInstance | null } = { current: null };
  await renderX11(
    h(TypedFlow, { ref: flow, defaultNodes: nodes(), defaultEdges: edges() }),
  );
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(160, 120));
    fireEvent.mouseMove(node, at(260, 120));
    fireEvent.mouseUp(node, at(260, 120));
  });
  const bounds = flow.current?.getNodeBounds('a');
  assert.deepStrictEqual(bounds && { x: bounds.x, y: bounds.y }, {
    x: 200,
    y: 100,
  });
});

test('dragging from a source handle to a target handle is a connection', async () => {
  const { recorded } = await mount();
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(A_SOURCE.x, A_SOURCE.y));
    fireEvent.mouseMove(node, at(B_TARGET.x, B_TARGET.y - 40));
    fireEvent.mouseMove(node, at(B_TARGET.x, B_TARGET.y));
    fireEvent.mouseUp(node, at(B_TARGET.x, B_TARGET.y));
  });
  assert.deepStrictEqual(recorded.connections, [
    { source: 'a', sourceHandle: null, target: 'b', targetHandle: null },
  ]);
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'position'),
    [],
    'a handle drag never moves the node it started on',
  );
});

test('dragging the other way round still names the source first', async () => {
  // The gesture is symmetric; the *edge* is not. Whichever end is the
  // source becomes `source`, so an app never has to normalise.
  const { recorded } = await mount();
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(B_TARGET.x, B_TARGET.y));
    fireEvent.mouseMove(node, at(A_SOURCE.x, A_SOURCE.y));
    fireEvent.mouseUp(node, at(A_SOURCE.x, A_SOURCE.y));
  });
  assert.deepStrictEqual(recorded.connections, [
    { source: 'a', sourceHandle: null, target: 'b', targetHandle: null },
  ]);
});

test('isValidConnection refuses one, and nothing is reported', async () => {
  const asked: Connection[] = [];
  const ended: (Connection | null)[] = [];
  const { recorded } = await mount({
    isValidConnection: (c: Connection) => {
      asked.push(c);
      return false;
    },
    onConnectEnd: (c: Connection | null) => ended.push(c),
  });
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(A_SOURCE.x, A_SOURCE.y));
    fireEvent.mouseMove(node, at(B_TARGET.x, B_TARGET.y));
    fireEvent.mouseUp(node, at(B_TARGET.x, B_TARGET.y));
  });
  assert.ok(asked.length > 0, 'it was asked');
  assert.deepStrictEqual(recorded.connections, []);
  assert.deepStrictEqual(ended, [null], 'the gesture still ends');
});

test('the wheel zooms about the pointer, and the point under it stays put', async () => {
  const { flow } = await mount();
  const node = pane() as unknown as DrawnNode;
  const before = flow.current!.screenToFlowPosition({
    x: pane().abs.x + 200,
    y: pane().abs.y + 200,
  });
  await userEvent.wheel(node, { ...at(200, 200), deltaY: -48 });
  const viewport = flow.current!.getViewport();
  assert.ok(viewport.zoom > 1, 'scrolling up zooms in');
  const after = flow.current!.screenToFlowPosition({
    x: pane().abs.x + 200,
    y: pane().abs.y + 200,
  });
  assert.ok(Math.abs(after.x - before.x) < 0.001);
  assert.ok(Math.abs(after.y - before.y) < 0.001);
});

test('a 2D zoom gesture draws the labels it has, and sets them at rest', async () => {
  // Shaping every label again at every step of a zoom was half of what a
  // 2D step cost. Where the context scales text with its transform — the
  // Windows and macOS one says so; X11's does not, so this test says it for
  // the headless server's — a step inside a gesture draws each label from
  // the size it already has, and the pane sets them exactly once it rests.
  await mount();
  const root = pane().root as unknown as { _ctx: object };
  Object.defineProperty(root._ctx, 'scalesText', {
    value: true,
    configurable: true,
  });
  const fonts = (
    pane() as unknown as {
      app: {
        fonts: { layout(text: string, style: { size: number }): unknown };
      };
    }
  ).app.fonts;
  const own = fonts.layout;
  const shaped: number[] = [];
  fonts.layout = function (text, style) {
    shaped.push(style.size);
    return own.call(this, text, style);
  };
  // A step is part of a gesture when it lands within 120 ms of the last,
  // which a loaded CI runner missed between two awaited wheels — and then
  // shaped the labels the test says a gesture does not. The pane's clock
  // (`performance.now`) runs at the test's pace while the steps go in: a
  // wheel's worth of time between them, however long each one took.
  const perf = globalThis.performance;
  let at16 = perf.now();
  Object.defineProperty(perf, 'now', {
    value: () => at16,
    configurable: true,
  });
  try {
    const node = pane() as unknown as DrawnNode;
    await userEvent.wheel(node, { ...at(200, 200), deltaY: -48 });
    const first = shaped.length;
    assert.ok(first > 0, 'the first step is not a gesture yet: set exactly');
    for (let i = 0; i < 4; i++) {
      at16 += 16;
      await userEvent.wheel(node, { ...at(200, 200), deltaY: -48 });
    }
    assert.strictEqual(shaped.length, first, 'nothing shaped mid-gesture');
    // the real clock again, which is long past the last step
    delete (perf as { now?: unknown }).now;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await act();
    assert.ok(shaped.length > first, 'and set at their own sizes at rest');
  } finally {
    delete (perf as { now?: unknown }).now;
    fonts.layout = own;
    delete (root._ctx as { scalesText?: boolean }).scalesText;
  }
});

test('zoom is clamped to the range it was given', async () => {
  const { flow } = await mount({ minZoom: 0.5, maxZoom: 1.5 });
  await act(() => {
    for (let i = 0; i < 20; i++) flow.current!.zoomIn();
  });
  assert.strictEqual(flow.current!.getViewport().zoom, 1.5);
  await act(() => {
    for (let i = 0; i < 40; i++) flow.current!.zoomOut();
  });
  assert.strictEqual(flow.current!.getViewport().zoom, 0.5);
});

test('fitView frames the graph, and the pane reports where things ended up', async () => {
  const { flow } = await mount({ fitView: true });
  const viewport = flow.current!.getViewport();
  assert.ok(viewport.zoom > 1, 'a 120×240 graph in a 640×480 pane zooms in');
  // both nodes are inside the pane afterwards
  for (const id of ['a', 'b']) {
    const bounds = flow.current!.getNodeBounds(id)!;
    const topLeft = flow.current!.flowToScreenPosition(bounds);
    assert.ok(topLeft.x >= pane().abs.x, `${id} is not off the left`);
    assert.ok(topLeft.y >= pane().abs.y, `${id} is not off the top`);
  }
});

// --- resizing ---------------------------------------------------------------

test('resizeRect moves the edges the grip owns and leaves the rest', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const limits = { minWidth: 40, minHeight: 30 };

  const se = resizeRect(box, { x: 1, y: 1 }, 30, 20, limits);
  assert.deepStrictEqual(se, { x: 100, y: 100, width: 230, height: 120 });

  // dragging the top-left moves the origin, and the far edges do not budge
  const nw = resizeRect(box, { x: -1, y: -1 }, 30, 20, limits);
  assert.deepStrictEqual(nw, { x: 130, y: 120, width: 170, height: 80 });
  assert.strictEqual(nw.x + nw.width, box.x + box.width);
  assert.strictEqual(nw.y + nw.height, box.y + box.height);

  // one axis at a time for an edge grip
  assert.deepStrictEqual(resizeRect(box, { x: 0, y: 1 }, 999, -40, limits), {
    x: 100,
    y: 100,
    width: 200,
    height: 60,
  });
});

test('a node held at its floor stops shrinking instead of walking away', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const limits = { minWidth: 40, minHeight: 30 };
  // Past the floor from the top-left: the dragged edge stops, the opposite
  // one stays where it was — the alternative is a node that creeps across
  // the canvas while the pointer keeps going.
  const squashed = resizeRect(box, { x: -1, y: -1 }, 500, 500, limits);
  assert.deepStrictEqual(squashed, {
    x: 260,
    y: 170,
    width: 40,
    height: 30,
  });
  assert.strictEqual(squashed.x + squashed.width, box.x + box.width);
});

test('applyNodeChanges folds a dimensions change', () => {
  const resized = applyNodeChanges(
    [{ type: 'dimensions', id: 'a', dimensions: { width: 300, height: 90 } }],
    nodes(),
  );
  assert.strictEqual(resized[0].width, 300);
  assert.strictEqual(resized[0].height, 90);
  assert.strictEqual(
    applyNodeChanges(
      [{ type: 'dimensions', id: 'a', dimensions: { width: 120, height: 40 } }],
      nodes(),
    ).length,
    2,
  );
});

test('dragging a grip resizes the node, and reports the settle', async () => {
  const { recorded } = await mount({
    nodes: nodes().map((n) =>
      n.id === 'a' ? { ...n, selected: true, resizable: true } : n,
    ),
  });
  const node = pane() as unknown as DrawnNode;
  // `a` is (100,100)–(220,140); the bottom-right grip is on its corner
  await act(() => {
    fireEvent.mouseDown(node, at(220, 140));
    fireEvent.mouseMove(node, at(280, 190));
    fireEvent.mouseUp(node, at(280, 190));
  });
  const sizes = ofType(recorded.nodeChanges, 'dimensions');
  assert.ok(sizes.length >= 2, 'a step and the settle');
  const last = sizes[sizes.length - 1];
  assert.deepStrictEqual(last.dimensions, { width: 180, height: 90 });
  assert.strictEqual(last.resizing, false);
  assert.ok(
    sizes.slice(0, -1).every((c) => c.resizing === true),
    'every step before it is mid-resize',
  );
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'position'),
    [],
    'the bottom-right corner does not move the node',
  );
});

test('a grip on the top-left moves the node as well as sizing it', async () => {
  const { recorded } = await mount({
    nodes: nodes().map((n) =>
      n.id === 'a' ? { ...n, selected: true, resizable: true } : n,
    ),
  });
  const node = pane() as unknown as DrawnNode;
  // 40px right and 5px down, which keeps the height above its 32px floor
  await act(() => {
    fireEvent.mouseDown(node, at(100, 100));
    fireEvent.mouseMove(node, at(140, 105));
    fireEvent.mouseUp(node, at(140, 105));
  });
  const sizes = ofType(recorded.nodeChanges, 'dimensions');
  const moves = ofType(recorded.nodeChanges, 'position');
  assert.deepStrictEqual(sizes[sizes.length - 1].dimensions, {
    width: 80,
    height: 35,
  });
  assert.deepStrictEqual(moves[moves.length - 1].position, { x: 140, y: 105 });
});

test('a node that is not selected has no grips, so the border pans', async () => {
  const { recorded, flow } = await mount({
    nodes: nodes().map((n) => (n.id === 'a' ? { ...n, resizable: true } : n)),
  });
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(220, 140));
    fireEvent.mouseMove(node, at(280, 190));
    fireEvent.mouseUp(node, at(280, 190));
  });
  assert.deepStrictEqual(ofType(recorded.nodeChanges, 'dimensions'), []);
  // the corner is on the node, so this was a node drag, not a pan
  assert.deepStrictEqual(flow.current!.getViewport(), { x: 0, y: 0, zoom: 1 });
  assert.ok(ofType(recorded.nodeChanges, 'position').length > 0);
});

// --- mounted node bodies ----------------------------------------------------

/** A node type whose body is real host elements rather than a drawing. */
const mountedType: FlowNodeType = {
  size: { width: 200, height: 120 },
  headerHeight: 20,
  render: ({ node }) =>
    h('box', { style: { flexGrow: 1 } }, h('text', null, `body of ${node.id}`)),
};

test('a `render` node type mounts a real subtree over the node', async () => {
  await mount({
    nodes: [
      {
        id: 'a',
        type: 'form',
        position: { x: 100, y: 100 },
        width: 200,
        height: 120,
      },
    ],
    edges: [],
    nodeTypes: { form: mountedType },
  });
  const text = screen.getByText('body of a');
  const box = retained(text).parent!;
  // the body starts under the header strip and is inset from the border, so
  // the grips and the edge of the card stay the pane's to hit
  assert.strictEqual(box.abs.y, pane().abs.y + 100 + 20);
  assert.strictEqual(box.abs.x, pane().abs.x + 100 + 5);
  assert.strictEqual(box.abs.width, 200 - 5 * 2);
  assert.strictEqual(box.abs.height, 120 - 20 - 5);
});

test('the mounted body follows the viewport, and leaves below a zoom', async () => {
  const { flow } = await mount({
    nodes: [
      {
        id: 'a',
        type: 'form',
        position: { x: 100, y: 100 },
        width: 200,
        height: 120,
      },
    ],
    edges: [],
    nodeTypes: { form: mountedType },
  });
  await act(() => flow.current!.setViewport({ x: 40, y: 25, zoom: 1 }));
  assert.strictEqual(
    retained(screen.getByText('body of a')).parent!.abs.x,
    pane().abs.x + 140 + 5,
  );

  // Below a threshold there is nothing worth mounting — a form a third of
  // its size is unreadable, and one real subtree per card is what a
  // zoomed-out overview cannot pay for: the pane draws the card instead.
  await act(() => flow.current!.setViewport({ zoom: 0.3 }));
  assert.strictEqual(screen.queryByText('body of a'), null);
  await act(() => flow.current!.setViewport({ zoom: 1 }));
  screen.getByText('body of a');
});

/** A body with a fixed-size mark in it. What the zoom did to a shaped
 *  string is a font metric; what it did to a `width: 40` box is arithmetic,
 *  and that is what these assert on. */
const sizedType: FlowNodeType = {
  size: { width: 200, height: 120 },
  headerHeight: 20,
  render: () =>
    h(
      'box',
      { style: { flexGrow: 1 } },
      h('text', { style: { width: 40, height: 20 } }, 'mark'),
    ),
};

/** The one node `sizedType`/`mountedType` are given below: 200×120 at
 *  (100, 100), so with the identity viewport every number in the tests is
 *  the graph one. */
function bodyNode(): FlowNode[] {
  return [
    {
      id: 'a',
      type: 'form',
      position: { x: 100, y: 100 },
      width: 200,
      height: 120,
    },
  ];
}

test('the mounted body zooms with the pane, rather than being clipped by it', async () => {
  const { flow } = await mount({
    nodes: bodyNode(),
    edges: [],
    nodeTypes: { form: sizedType },
  });
  const mark = (): { width: number; height: number } => {
    const { width, height } = retained(screen.getByText('mark')).abs;
    return { width, height };
  };
  assert.deepStrictEqual(mark(), { width: 40, height: 20 });

  // The whole point: core's `scale` prop multiplies every length in the
  // subtree (react-x11#449), so the mark grows with the card instead of
  // staying its own size in a bigger box and being cut off.
  await act(() => flow.current!.setViewport({ x: 0, y: 0, zoom: 2 }));
  assert.deepStrictEqual(mark(), { width: 80, height: 40 });
  await act(() => flow.current!.setViewport({ x: 0, y: 0, zoom: 0.75 }));
  assert.deepStrictEqual(mark(), { width: 30, height: 15 });

  // And the box it is laid out in still covers exactly the part of the card
  // the pane left for it: inset from the border, below the header, both of
  // them zoomed. A body sized in its own unit that did not track this would
  // show as the scaled box drifting off the card.
  await act(() => flow.current!.setViewport({ x: 0, y: 0, zoom: 2 }));
  const body = retained(screen.getByText('mark')).parent!;
  assert.deepStrictEqual(
    {
      x: body.abs.x - pane().abs.x,
      y: body.abs.y - pane().abs.y,
      width: body.abs.width,
      height: body.abs.height,
    },
    {
      x: 100 * 2 + 5 * 2,
      y: 100 * 2 + 20 * 2,
      width: (200 - 5 * 2) * 2,
      height: (120 - 20 - 5) * 2,
    },
  );
});

test('a zoom too small to move the box still reaches the body', async () => {
  const { flow } = await mount({
    nodes: bodyNode(),
    edges: [],
    nodeTypes: { form: sizedType },
  });
  const bodyScale = (): unknown => retained(bodyBox().children[0]).props.scale;
  assert.strictEqual(bodyScale(), 1);

  // The pane snaps the box it emits to whole pixels, and this zoom is
  // inside the window where all four numbers snap to the ones zoom 1 gave.
  // The list it hands React is therefore unchanged as a *rect* and changed
  // as a scale, so the emission has to be keyed on both: keyed on the rect
  // alone the body would keep the old factor. The error is sub-pixel by
  // construction — the window is only as wide as the rounding — but the
  // field is load-bearing now and a key that omits one is a bug waiting for
  // the next change to it.
  await act(() => flow.current!.setViewport({ x: 0, y: 0, zoom: 1.0016 }));
  assert.strictEqual(bodyScale(), 1.0016);
});

test('`render` is handed graph units, so the zoom does not move its rect', async () => {
  const seen: NodeRenderContext[] = [];
  const recording: FlowNodeType = {
    size: { width: 200, height: 120 },
    headerHeight: 20,
    render: (context) => {
      seen.push(context);
      return h('text', null, `body of ${context.node.id}`);
    },
  };
  const { flow } = await mount({
    nodes: bodyNode(),
    edges: [],
    nodeTypes: { form: recording },
  });
  const last = (): NodeRenderContext => seen[seen.length - 1];
  // Inset from the border, below the header — in graph units, which with the
  // identity viewport is where the node itself is.
  assert.deepStrictEqual(last().rect, {
    x: 105,
    y: 120,
    width: 190,
    height: 95,
  });

  await act(() => flow.current!.setViewport({ x: 0, y: 0, zoom: 2 }));
  assert.deepStrictEqual(
    last().rect,
    { x: 105, y: 120, width: 190, height: 95 },
    'the same box: the zoom is on the subtree, not on the numbers in it',
  );
  assert.strictEqual(
    last().zoom,
    2,
    'the zoom is still there for a body that wants to show less of itself',
  );
});

test('a graph with no `render` type mounts nothing and is one node deep', async () => {
  await mount();
  // The box `<Flow>` wraps the pane in is always there — it is what an
  // absolutely positioned body is laid out against — but with nothing to
  // mount it is the pane's only child.
  const wrapper = pane().parent!;
  assert.deepStrictEqual(
    wrapper.children.map((c) => c.kind),
    [FLOW_ELEMENT],
  );
});

test('a moved node keeps its measured size; a relabelled one is re-measured', async () => {
  // The identity diff behind smooth dragging: a nodes array where only a
  // position changed must not re-measure (the entries are folded in place),
  // and one where a label changed must — data identity is a structural
  // change, whatever else stayed the same.
  const flow: { current: FlowInstance | null } = { current: null };
  const base: FlowNode[] = [
    { id: 'a', position: { x: 0, y: 0 }, data: { label: 'short' } },
    { id: 'b', position: { x: 0, y: 200 }, data: { label: 'bb' } },
  ];
  const { rerender } = await renderX11(
    h(TypedFlow, { ref: flow, nodes: base, edges: [] }),
  );
  const before = flow.current!.getNodeBounds('a')!;

  const moved = base.map((n) =>
    n.id === 'a' ? { ...n, position: { x: 40, y: 8 } } : n,
  );
  await act(() =>
    rerender(h(TypedFlow, { ref: flow, nodes: moved, edges: [] })),
  );
  const after = flow.current!.getNodeBounds('a')!;
  assert.strictEqual(after.x, 40);
  assert.strictEqual(after.y, 8);
  assert.strictEqual(after.width, before.width, 'size survived the move');

  const relabelled = moved.map((n) =>
    n.id === 'a'
      ? { ...n, data: { label: 'a very much longer label than before' } }
      : n,
  );
  await act(() =>
    rerender(h(TypedFlow, { ref: flow, nodes: relabelled, edges: [] })),
  );
  const wide = flow.current!.getNodeBounds('a')!;
  assert.ok(
    wide.width > before.width,
    `the new label re-measured (${wide.width} vs ${before.width})`,
  );
});

/** A drag's motion reaches the pane with ntk's next frame, which is paced
 *  on a timer of its own: `act` alone can resolve before it lands. A press
 *  or a release flushes it too, but a release ends the gesture. */
async function motionLands(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  await act();
}

/** Every rect claimed of the window from here on — `null` for a claim of
 *  all of it. A node's claim of its own box is its box; core's "nothing I
 *  draw changed" is no claim at all. */
function claimsOf(node: RetainedNode): (FlowRect | null)[] {
  const root = node.root as unknown as {
    invalidate(layout: boolean, damage: unknown, ...rest: unknown[]): void;
  };
  const claims: (FlowRect | null)[] = [];
  const own = root.invalidate.bind(root);
  root.invalidate = (layout, damage, ...rest) => {
    if (damage == null) claims.push(null);
    else if (typeof damage === 'object' && 'width' in damage) {
      claims.push(damage as FlowRect);
    } else if (typeof damage === 'object' && 'abs' in damage) {
      claims.push((damage as { abs: FlowRect }).abs);
    }
    own(layout, damage, ...rest);
  };
  return claims;
}

const inside = (r: FlowRect | null, x: number, y: number): boolean =>
  r === null ||
  (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

test('a box selection step claims the bands its moving sides swept, not the box', async () => {
  // Claiming the box round the old and new selection repainted everything
  // under it, every node and edge, on every step — 21 ms a step on the
  // stress example's 300-node fan-out, and the pointer left behind.
  await mount({ selectionOnDrag: true });
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(20, 20));
    fireEvent.mouseMove(node, at(300, 250));
  });
  const claims = claimsOf(pane());
  // clear of both nodes, so no selection changes on the way
  await act(() => fireEvent.mouseMove(node, at(310, 256)));
  await motionLands();
  assert.ok(claims.length > 0, 'the step claimed something');
  assert.ok(
    claims.some((c) => inside(c, 305, 130)),
    'the band the right side swept',
  );
  assert.ok(
    claims.some((c) => inside(c, 150, 253)),
    'and the one the bottom swept',
  );
  assert.ok(
    !claims.some((c) => inside(c, 150, 130)),
    `but not the middle, where both boxes lay the same tint: ${JSON.stringify(claims)}`,
  );
  assert.ok(
    !claims.some((c) => inside(c, 20, 130) || inside(c, 150, 20)),
    'nor the two sides the box is anchored by',
  );
  await act(() => fireEvent.mouseUp(node, at(310, 256)));
});

test('a selection change repaints the node, not the pane', async () => {
  // Selection lifts a node over its neighbours, which read as structural:
  // every node re-measured and the whole pane repainted — on every step of
  // a box selection that took a node in.
  const flow: { current: FlowInstance | null } = { current: null };
  const base = nodes();
  const { rerender } = await renderX11(
    h(TypedFlow, { ref: flow, nodes: base, edges: edges() }),
  );
  await act();
  const claims = claimsOf(pane());
  const picked = base.map((n) => (n.id === 'a' ? { ...n, selected: true } : n));
  await act(() =>
    rerender(h(TypedFlow, { ref: flow, nodes: picked, edges: edges() })),
  );
  assert.ok(claims.length > 0, 'the change claimed something');
  assert.ok(!claims.includes(null), 'none of it the whole window');
  assert.ok(
    claims.some((c) => inside(c, 160, 120)),
    'the selected node repaints',
  );
  assert.ok(
    !claims.some((c) => inside(c, 160, 320)),
    'the one beside it does not',
  );
});

test('a selected node is painted over the one it overlaps, without a rebuild', async () => {
  const flow: { current: FlowInstance | null } = { current: null };
  const overlapping: FlowNode[] = [
    {
      id: 'top',
      position: { x: 100, y: 100 },
      width: 120,
      height: 40,
      data: { label: 'T' },
    },
    {
      id: 'under',
      position: { x: 60, y: 90 },
      width: 120,
      height: 40,
      data: { label: 'U' },
    },
  ];
  const { rerender } = await renderX11(
    h(TypedFlow, { ref: flow, nodes: overlapping, edges: [] }),
  );
  await act();
  // declaration order: `under` is drawn last, over `top`
  const order = () =>
    (pane() as unknown as { _paintOrder(): { node: FlowNode }[] })
      ._paintOrder()
      .map((e) => e.node.id);
  assert.deepStrictEqual(order(), ['top', 'under']);
  const picked = overlapping.map((n) =>
    n.id === 'top' ? { ...n, selected: true } : n,
  );
  await act(() =>
    rerender(h(TypedFlow, { ref: flow, nodes: picked, edges: [] })),
  );
  assert.deepStrictEqual(order(), ['under', 'top'], 'selection lifts it');
});

test('under GL a box selection step is a frame, not a new world', async () => {
  const { node, asked } = await glPane({ selectionOnDrag: true });
  let frame = node.glFrame(null)!;
  const target = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(target, at(20, 20));
    fireEvent.mouseMove(target, at(60, 60));
  });
  await motionLands();
  frame = node.glFrame(frame.key)!;
  const before = asked();
  await act(() => fireEvent.mouseMove(target, at(70, 66)));
  await motionLands();
  assert.ok(asked() > before, 'the step asks for a frame');
  frame = node.glFrame(frame.key)!;
  assert.strictEqual(frame.world, null, 'and the world on the GPU stands');
  await act(() => fireEvent.mouseUp(target, at(70, 66)));
});

test('under GL a drag step routes no edges for a rect nobody reads', async () => {
  const { node } = await glPane();
  const pane2 = node as unknown as {
    _nodeDamage(e: unknown): unknown;
    _gesture: unknown;
  };
  let routed = 0;
  const own = pane2._nodeDamage.bind(pane2);
  pane2._nodeDamage = (e) => {
    routed++;
    return own(e);
  };
  const target = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(target, at(115, 110));
    fireEvent.mouseMove(target, at(135, 125));
    fireEvent.mouseMove(target, at(155, 140));
    fireEvent.mouseUp(target, at(155, 140));
  });
  assert.strictEqual(routed, 0);
});

test('under GL a commit that moved a node claims nothing of the window', async () => {
  // The 2D pane under the surface shows nothing; a claim billed as `props`
  // was a window pass over it on every step of a drag an app stores.
  // the pane itself, as `<Flow>` renders it over a surface that drew
  const element = (list: FlowNode[]) =>
    h(FLOW_ELEMENT, {
      nodes: list,
      edges: edges(),
      renderer: 'gl',
      style: { flexGrow: 1 },
    });
  const base = nodes();
  const { rerender } = await renderX11(element(base));
  const node = pane() as unknown as { setGlRequest(fn: () => void): void };
  let asked = 0;
  node.setGlRequest(() => void asked++);
  await act();
  const claims: unknown[] = [];
  const root = pane().root as unknown as {
    invalidate(l: boolean, d: unknown, r: unknown, s: unknown): void;
  };
  const own = root.invalidate.bind(root);
  root.invalidate = (l, d, r, s) => {
    if (s === pane()) claims.push(d);
    own(l, d, r, s);
  };
  const before = asked;
  const moved = base.map((n) =>
    n.id === 'a' ? { ...n, position: { x: 140, y: 120 } } : n,
  );
  await act(() => rerender(element(moved)));
  assert.ok(asked > before, 'a GL frame is asked for');
  assert.deepStrictEqual(claims, [], 'and the window is claimed for nothing');
});

test('screenToFlowPosition and back is a round trip at any viewport', async () => {
  const { flow } = await mount();
  await act(() => flow.current!.setViewport({ x: -37, y: 12, zoom: 1.75 }));
  const point = { x: 123, y: -45 };
  const back = flow.current!.screenToFlowPosition(
    flow.current!.flowToScreenPosition(point),
  );
  assert.ok(Math.abs(back.x - point.x) < 0.001);
  assert.ok(Math.abs(back.y - point.y) < 0.001);
});

test('Delete removes the selection, and the edges it would leave dangling', async () => {
  const { recorded } = await mount({
    nodes: nodes().map((n) => (n.id === 'a' ? { ...n, selected: true } : n)),
  });
  await userEvent.click(pane() as unknown as DrawnNode, at(160, 120));
  recorded.nodeChanges.length = 0;
  recorded.edgeChanges.length = 0;
  await userEvent.key(XK_DELETE);
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'remove').map((c) => c.id),
    ['a'],
  );
  assert.deepStrictEqual(
    ofType(recorded.edgeChanges, 'remove').map((c) => c.id),
    ['a-b'],
    'the edge to the removed node goes with it',
  );
});

test('Ctrl+A takes everything, Escape gives it back', async () => {
  const { recorded } = await mount();
  await userEvent.click(pane() as unknown as DrawnNode, at(500, 60));
  recorded.nodeChanges.length = 0;
  recorded.edgeChanges.length = 0;

  await userEvent.key(keysymOf('a'), { modifiers: ['Control'] });
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'select').map((c) => c.id),
    ['a', 'b'],
  );
  assert.deepStrictEqual(
    ofType(recorded.edgeChanges, 'select').map((c) => c.id),
    ['a-b'],
  );
});

test('the arrows nudge the selection', async () => {
  const { recorded } = await mount({
    nodes: nodes().map((n) => (n.id === 'b' ? { ...n, selected: true } : n)),
  });
  // click the pane to give it the keyboard focus, not to change the
  // selection — these `nodes` are controlled and nothing applies the changes
  await userEvent.click(pane() as unknown as DrawnNode, at(500, 60));
  recorded.nodeChanges.length = 0;
  await userEvent.key(XK_RIGHT);
  const moved = ofType(recorded.nodeChanges, 'position');
  assert.strictEqual(moved.length, 1);
  assert.ok(moved[0].type === 'position');
  assert.deepStrictEqual(moved[0].position, { x: 101, y: 300 });
});

test('with nothing selected there is nothing to nudge, so the arrows pan', async () => {
  const { recorded, flow } = await mount();
  await userEvent.click(pane() as unknown as DrawnNode, at(500, 60));
  await userEvent.key(XK_ESCAPE);
  const before = flow.current!.getViewport().x;
  await userEvent.key(XK_RIGHT);
  assert.ok(flow.current!.getViewport().x < before, 'the pane moved left');
  assert.deepStrictEqual(ofType(recorded.nodeChanges, 'position'), []);
});

test('Shift+drag on the pane selects the nodes it crossed', async () => {
  const { recorded } = await mount({ nodes: nodes(), edges: [] });
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, { ...at(60, 60), modifiers: ['Shift'] });
    fireEvent.mouseMove(node, at(400, 200));
    fireEvent.mouseUp(node, at(400, 200));
  });
  // the box covered `a` (100,100–220,140) and not `b` (100,300–220,340)
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'select').map((c) => [
      c.id,
      'selected' in c && c.selected,
    ]),
    [['a', true]],
  );
});

test('panning moves the viewport and not the graph', async () => {
  const { recorded, flow } = await mount();
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(500, 60));
    fireEvent.mouseMove(node, at(540, 100));
    fireEvent.mouseUp(node, at(540, 100));
  });
  assert.deepStrictEqual(flow.current!.getViewport(), {
    x: 40,
    y: 40,
    zoom: 1,
  });
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'position'),
    [],
    'a pan is not an edit',
  );
  assert.deepStrictEqual(flow.current!.getNodeBounds('a')!.x, 100);
});

test('a press on an edge selects it and reports the click', async () => {
  const clicked: string[] = [];
  const { recorded } = await mount({
    onEdgeClick: (_ev, edge) => clicked.push(edge.id),
  });
  // the only edge runs from (160, 140) straight down to (160, 300), so its
  // middle is somewhere no node is
  await userEvent.click(pane() as unknown as DrawnNode, at(160, 220));
  assert.deepStrictEqual(
    ofType(recorded.edgeChanges, 'select').map((c) => [c.id, c.selected]),
    [['a-b', true]],
  );
  assert.deepStrictEqual(clicked, ['a-b']);
});

test('`panOnDrag={false}` still clicks the pane, it just does not pan', async () => {
  const paneClicks: number[] = [];
  const { recorded, flow } = await mount({
    panOnDrag: false,
    nodes: nodes().map((n) => ({ ...n, selected: true })),
    onPaneClick: () => paneClicks.push(1),
  });
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(500, 60));
    fireEvent.mouseMove(node, at(540, 100));
    fireEvent.mouseUp(node, at(540, 100));
  });
  assert.deepStrictEqual(flow.current!.getViewport(), { x: 0, y: 0, zoom: 1 });
  // it moved, so it was a drag and not a click
  assert.deepStrictEqual(paneClicks, []);

  await userEvent.click(node, at(500, 60));
  assert.deepStrictEqual(paneClicks, [1], 'a press and release still is one');
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'select').map((c) => c.selected),
    [false, false],
  );
});

test('`nodesDraggable={false}` still clicks and selects, it just does not move', async () => {
  const { recorded } = await mount({ nodesDraggable: false });
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(160, 120));
    fireEvent.mouseMove(node, at(260, 220));
    fireEvent.mouseUp(node, at(260, 220));
  });
  assert.deepStrictEqual(ofType(recorded.nodeChanges, 'position'), []);
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'select').map((c) => c.id),
    ['a'],
  );
});

// --- drawing ----------------------------------------------------------------

test('the whole picture draws: furniture, markers, labels, a custom type', async () => {
  // On the real backend, so this walks every path in `paint` — the grid, the
  // routing, the arrowheads, the label chips, the minimap and the controls.
  // The mock backend has no path API and skips the drawing entirely, which
  // is right for a layout test and no coverage at all for this one.
  const painted: string[] = [];
  await renderX11(
    h(TypedFlow, {
      nodes: [
        ...nodes(),
        {
          id: 'c',
          position: { x: 400, y: 100 },
          type: 'card',
          data: { label: 'C', description: 'a second line' },
        },
        { id: 'hidden', position: { x: 0, y: 0 }, hidden: true },
      ],
      edges: [
        {
          id: '1',
          source: 'a',
          target: 'b',
          type: 'smoothstep',
          label: 'labelled',
          animated: true,
        },
        {
          id: '2',
          source: 'a',
          target: 'c',
          type: 'step',
          markerStart: 'arrow',
        },
        {
          id: '3',
          source: 'b',
          target: 'c',
          type: 'straight',
          markerEnd: null,
          selected: true,
        },
        { id: '4', source: 'c', target: 'c', type: 'bezier' },
        { id: 'dangling', source: 'a', target: 'nobody' },
      ],
      nodeTypes: {
        card: {
          paint: ({
            rect,
            painter,
          }: {
            rect: { x: number; y: number };
            painter: unknown;
          }) => {
            painted.push('card');
            void rect;
            void painter;
          },
        },
      },
      background: { variant: 'cross', gap: 30 },
      minimap: true,
      controls: true,
      fitView: true,
    }),
  );
  assert.ok(painted.includes('card'), 'the custom node type was asked to draw');
});

test('a graph with nothing in it, and one with no server font, both paint', async () => {
  await renderX11(h(TypedFlow, { nodes: [], edges: [], minimap: true }));
  await cleanup();
  await renderX11(h(TypedFlow, { nodes: nodes(), edges: edges() }), {
    backend: 'mock',
  });
  assert.strictEqual(pane().kind, FLOW_ELEMENT);
});

test('a drag step recomposites mounted bodies in the same dispatch', async () => {
  // The mounted body must move in the frame that moves the card. The pane
  // hands body rects out during the gesture dispatch itself — a discrete
  // update React commits before the frame — not from the paint after it,
  // which is one frame too late by construction.
  const bodies: NodeBodyRect[][] = [];
  await renderX11(
    h(
      FLOW_ELEMENT as 'box',
      {
        nodes: [
          {
            id: 'form',
            type: 'form',
            position: { x: 100, y: 100 },
            width: 200,
            height: 120,
          },
        ],
        edges: [],
        nodeTypes: { form: mountedType },
        onNodeBodies: (b: readonly NodeBodyRect[]) => void bodies.push([...b]),
        // the raw element brings no default style; without a size it never
        // paints, never syncs and has no bodies to hand out
        style: { flexGrow: 1 },
      } as never,
    ),
  );
  await act();
  const seam = pane() as unknown as {
    defaultMouseDown(ev: unknown): void;
    defaultMouseDrag(ev: unknown): void;
    defaultMouseUp(ev: unknown): void;
  };
  const synth = (x: number, y: number) => ({
    x,
    y,
    button: 1,
    shiftKey: false,
    ctrlKey: false,
    detail: 1,
    preventDefault() {},
    capturePointer() {},
  });
  const paneAbs = pane().abs;
  // press the header strip, then one step of 40,20
  await act(() =>
    seam.defaultMouseDown(synth(paneAbs.x + 200, paneAbs.y + 110)),
  );
  bodies.length = 0;
  await act(() =>
    seam.defaultMouseDrag(synth(paneAbs.x + 240, paneAbs.y + 130)),
  );
  assert.strictEqual(bodies.length, 1, 'one recomposite per step, no echo');
  const [body] = bodies[0];
  // moved by the step: x = 100 + 40 + inset(5), y = 100 + 20 + header(20)
  assert.strictEqual(body.x, 145);
  assert.strictEqual(body.y, 140);
  await act(() => seam.defaultMouseUp(synth(paneAbs.x + 240, paneAbs.y + 130)));
});

test('the body commit is synchronous inside the gesture dispatch', async () => {
  // The stronger property, the one the eye checks: motion dispatches at
  // continuous priority, whose React updates the scheduler may hold across
  // frames — so an async setState converges 2–3 updates late while the pane
  // tracks the pointer. The gesture-time emission flushes the commit before
  // the dispatch returns: the overlay box's committed style already carries
  // the step's position when `defaultMouseDrag` comes back, with no flush,
  // no settle, no frame in between.
  await renderX11(
    h(TypedFlow, {
      nodes: [
        {
          id: 'form',
          type: 'form',
          position: { x: 100, y: 100 },
          width: 200,
          height: 120,
        },
      ],
      edges: [],
      nodeTypes: { form: mountedType },
    }),
  );
  const seam = pane() as unknown as {
    defaultMouseDown(ev: unknown): void;
    defaultMouseDrag(ev: unknown): void;
    defaultMouseUp(ev: unknown): void;
  };
  const synth = (x: number, y: number) => ({
    x,
    y,
    button: 1,
    shiftKey: false,
    ctrlKey: false,
    detail: 1,
    preventDefault() {},
    capturePointer() {},
  });
  const paneAbs = pane().abs;
  await act(() =>
    seam.defaultMouseDown(synth(paneAbs.x + 200, paneAbs.y + 110)),
  );

  // No act, no await: the dispatch itself must leave the box committed.
  seam.defaultMouseDrag(synth(paneAbs.x + 250, paneAbs.y + 140));
  const place = bodyPlace();
  assert.strictEqual(place.left, 155, 'left committed inside the dispatch');
  assert.strictEqual(place.top, 150, 'top committed inside the dispatch');

  await act(() => seam.defaultMouseUp(synth(paneAbs.x + 250, paneAbs.y + 140)));
});

test('a value-identical inline graph repaints nothing it can name', async () => {
  // `nodes={[…]} edges={[…]}` written inline hands the pane fresh arrays of
  // fresh objects on every app render. The diffs keep the built entries, so
  // a keystroke into one node's data is that node's repaint — not a
  // structural rebuild, which is what made typing into a mounted node's
  // textarea feel slow.
  const flow: { current: FlowInstance | null } = { current: null };
  const graph = (text: string): FlowProps => ({
    ref: flow,
    nodes: [
      { id: 'a', position: { x: 0, y: 0 }, width: 120, height: 40 },
      {
        id: 'notes',
        position: { x: 200, y: 100 },
        width: 200,
        height: 120,
        data: { label: 'notes', description: text },
      },
    ],
    edges: [{ id: 'e', source: 'a', target: 'notes' }],
  });
  const { rerender } = await renderX11(h(TypedFlow, graph('one')));
  const before = flow.current!.getNodeBounds('notes')!;
  await act(() => rerender(h(TypedFlow, graph('two'))));
  const after = flow.current!.getNodeBounds('notes')!;
  assert.deepStrictEqual(after, before, 'explicit size held through the edit');
  // and the graph still behaves — the entries were kept, not wedged
  assert.ok(flow.current!.getNodeBounds('a'));
});

test('the drawn graph is accessible children, not one silent group', async () => {
  // react-x11#304: the pane draws its nodes, so the retained tree has
  // nothing under it — `a11yScene()` is what a screen reader meets instead.
  const flow: { current: FlowInstance | null } = { current: null };
  const graph: FlowNode[] = [
    { id: 'alpha', position: { x: 0, y: 0 }, data: { label: 'alpha' } },
    { id: 'beta', position: { x: 0, y: 120 }, data: { label: 'beta' } },
  ];
  const { at, rerender } = await renderX11(
    h(TypedFlow, {
      ref: flow,
      nodes: graph,
      edges: [{ id: 'e', source: 'alpha', target: 'beta' }],
    }),
    { a11y: true },
  );
  assert.ok(at, 'the spy is installed');

  // The scene itself, through the public seam: named, placed, listed.
  const scene = (
    pane() as unknown as {
      a11yScene(): {
        id: string;
        name?: string;
        role?: string;
        rect: { width: number };
        states?: { selected?: boolean };
      }[];
    }
  ).a11yScene();
  assert.deepStrictEqual(
    scene.map((item) => [item.id, item.name, item.role]),
    [
      ['alpha', 'alpha', 'listitem'],
      ['beta', 'beta', 'listitem'],
    ],
  );
  assert.ok(scene[0].rect.width > 0, 'placed where it was drawn');

  // Appearing is a baseline, not a change — the spy's model, same as a
  // mount. What it *reports* is state moving on an item it already holds.
  at.since();
  await act(() =>
    rerender(
      h(TypedFlow, {
        ref: flow,
        nodes: graph.map((n) =>
          n.id === 'beta' ? { ...n, selected: true } : n,
        ),
        edges: [{ id: 'e', source: 'alpha', target: 'beta' }],
      }),
    ),
  );
  const events = at.since();
  const selectedEvent = events.find((e) => /selected/.test(e.summary));
  assert.ok(
    selectedEvent,
    `a selected-state event reached the feed: ${events.map((e) => e.summary).join(', ')}`,
  );
  assert.ok(selectedEvent.node, 'the event carries the item');
  assert.strictEqual(
    nodeUtterance(selectedEvent.node).includes('beta'),
    true,
    'and it names the node it landed on',
  );
});

test('the pane names itself to a screen reader', async () => {
  await mount({ 'aria-label': 'build pipeline' });
  assert.strictEqual(pane().props['aria-label'], 'build pipeline');
  assert.strictEqual(pane().props.role, 'group');
});

// --- the display scale -------------------------------------------------------
//
// react-x11 hands a registered element two units (its docs/scale.md): `abs`,
// `contentBox()`, the paint context and every damage rect are device pixels,
// while a synthetic event's `x`/`y`, every style length and therefore the
// sibling boxes the bodies mount in are logical ones. At 1x — every other
// test in this file — the two coincide, which is how a pane that mixed them
// passed all of it and then hovered, panned and framed at half size on a
// retina panel. These run at 2x and pin the pane to logical pixels.

/** `renderX11` forwards `scale` to `createRoot`, but its options type does
 *  not list it yet (react-x11#430 adds it) — the same "declaration narrower
 *  than the runtime" shape AGENTS.md records for core, worked around the
 *  same way. */
const AT_2X = {
  scale: 2,
  width: 400,
  height: 300,
  screen: { width: 1000, height: 800 },
} as unknown as RenderX11Options;

/** `at()` for the 2x pane: `fireEvent` offsets are device pixels from the
 *  pane's device centre, and the point asked for is a logical one. */
function at2x(x: number, y: number): { dx: number; dy: number } {
  const { abs } = pane();
  return {
    dx: x * 2 - (abs.x + abs.width / 2),
    dy: y * 2 - (abs.y + abs.height / 2),
  };
}

test('at a display scale of 2 the pane hits, pans and frames in logical pixels', async () => {
  const recorded: Recorded = {
    nodeChanges: [],
    edgeChanges: [],
    connections: [],
  };
  const flow: { current: FlowInstance | null } = { current: null };
  await renderX11(
    h(TypedFlow, {
      ref: flow,
      nodes: nodes(),
      edges: edges(),
      onNodesChange: (c: NodeChange[]) => void recorded.nodeChanges.push(c),
    }),
    AT_2X,
  );
  const node = pane() as unknown as DrawnNode;
  const { abs } = pane();
  assert.deepStrictEqual(
    { width: abs.width, height: abs.height },
    { width: 800, height: 600 },
    'a 400×300 logical window is 800×600 device pixels, and `abs` is device',
  );

  // Node `a` is the box (100,100)–(220,140) in graph units, which with the
  // identity viewport is where it is in *logical* window pixels. Read in
  // device pixels it would be at half those numbers — where there is only
  // empty pane, which a click reports as nothing.
  await userEvent.click(node, at2x(80, 60));
  assert.deepStrictEqual(ofType(recorded.nodeChanges, 'select'), []);
  await userEvent.click(node, at2x(160, 120));
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'select').map((c) => c.id),
    ['a'],
  );

  // A pan moves the viewport by the logical distance the pointer travelled:
  // 50×30 here is 100×60 on the wire.
  await act(() => {
    fireEvent.mouseDown(node, at2x(300, 60));
    fireEvent.mouseMove(node, at2x(350, 90));
    fireEvent.mouseUp(node, at2x(350, 90));
  });
  assert.deepStrictEqual(flow.current?.getViewport(), {
    x: 50,
    y: 30,
    zoom: 1,
  });

  // `fitView` frames the graph in the pane's logical size: 400×300 around a
  // 120×240 graph is a zoom of 1.25, where the device size gave 2.5.
  await cleanup();
  await renderX11(
    h(TypedFlow, {
      ref: flow,
      nodes: nodes(),
      edges: edges(),
      fitView: true,
      fitViewOptions: { padding: 0 },
    }),
    AT_2X,
  );
  await act();
  assert.strictEqual(flow.current?.getViewport().zoom, 1.25);
});

test('the display scale is the floor the body zoom multiplies', async () => {
  await renderX11(
    h(TypedFlow, {
      nodes: bodyNode(),
      edges: [],
      nodeTypes: { form: sizedType },
      defaultViewport: { x: 0, y: 0, zoom: 1.5 },
    }),
    AT_2X,
  );
  await act();
  // Two factors, and they multiply rather than one of them winning: a 40
  // graph unit mark is 60 logical pixels at this zoom, and 120 device ones
  // on a 2x panel. A body that took only the zoom would be half this and
  // one that took only the panel two thirds of it.
  const { width, height } = retained(screen.getByText('mark')).abs;
  assert.deepStrictEqual({ width, height }, { width: 120, height: 60 });
});

test('at a display scale of 2 the card lands on device pixels and its body on logical ones', async () => {
  const { ctx } = await renderX11(
    h(TypedFlow, {
      nodes: [
        {
          id: 'a',
          position: { x: 100, y: 100 },
          width: 120,
          height: 40,
          style: { background: '#ff0000', borderColor: '#ff0000' },
        },
        {
          id: 'form',
          type: 'form',
          position: { x: 100, y: 200 },
          width: 200,
          height: 120,
        },
      ],
      edges: [],
      nodeTypes: { form: mountedType },
    }),
    AT_2X,
  );
  await act();

  // The card is the logical box (100,100)–(220,140): on the panel, device
  // pixels (200,200)–(440,280). Sampled inside its corners, clear of the
  // rounding, the border and the label in the middle.
  await expectPixel(ctx, 215, 215, '#ff0000', {
    message: 'the card is drawn at its device position',
  });
  await expectPixel(ctx, 425, 265, '#ff0000', {
    message: 'and at its device size',
  });
  assert.ok(
    !isNear(await pixelAt(ctx, 160, 120), '#ff0000'),
    'nothing of it at the logical numbers read as device ones',
  );
  assert.ok(
    !isNear(await pixelAt(ctx, 450, 290), '#ff0000'),
    'and it ends where its logical size says',
  );

  // The body's box is a sibling laid out in logical pixels, like any style:
  // x = 100 + inset(5), y = 200 + header(20); 200 − 2×5 wide, 120 − 20 − 5
  // tall. Doubled numbers here were the body sitting a node's width away
  // from its card.
  const style = bodyBox().props.style as {
    width?: number;
    height?: number;
  };
  assert.deepStrictEqual(
    {
      ...bodyPlace(),
      width: style.width,
      height: style.height,
    },
    { left: 105, top: 220, width: 190, height: 95 },
  );
});

// --- off the window's origin -------------------------------------------------
//
// Every test above mounts the pane at the window's top-left, where "window
// coordinates" and "pane coordinates" are the same numbers — which is how a
// pane offset can be dropped and nothing notices. It was dropped once, by the
// scene extraction (`src/flow/scene.ts`): the scene's `toScreen` left out the
// pane's origin that the element's own had added, and because hit testing now
// shares the scene's helpers, the drawing and the pointer moved together and
// agreed with each other while both disagreeing with the window. `<Map>` fell
// into the same hole once (maps#95). These two put the pane 60 × 40 pixels in.

const OFFSET = { x: 60, y: 40 };

async function mountOffset(
  props: Partial<FlowProps> = {},
): Promise<{ recorded: Recorded; ctx: unknown }> {
  const recorded: Recorded = {
    nodeChanges: [],
    edgeChanges: [],
    connections: [],
  };
  const { ctx } = await renderX11(
    h(
      'box',
      {
        style: {
          flexGrow: 1,
          paddingLeft: OFFSET.x,
          paddingTop: OFFSET.y,
        },
      },
      h(TypedFlow, {
        nodes: nodes(),
        edges: edges(),
        onNodesChange: (c) => void recorded.nodeChanges.push(c),
        ...props,
      }),
    ),
  );
  await act();
  return { recorded, ctx };
}

test('off the window origin, a press lands on the node drawn under it', async () => {
  const { recorded } = await mountOffset();
  const { abs } = pane();
  assert.deepStrictEqual(
    { x: abs.x, y: abs.y },
    OFFSET,
    'precondition: the pane really is off the origin',
  );
  // node `a` is graph (100,100)–(220,140); the pane's origin moves it on the
  // window by the offset, and a press there is a press on it
  await userEvent.click(
    pane() as unknown as DrawnNode,
    at(160 + OFFSET.x, 120 + OFFSET.y),
  );
  assert.deepStrictEqual(
    ofType(recorded.nodeChanges, 'select').map((c) => c.id),
    ['a'],
  );
});

test('off the window origin, a card is drawn where the pane puts it', async () => {
  const { ctx } = await mountOffset({
    nodes: nodes().map((n) =>
      n.id === 'a'
        ? { ...n, style: { background: '#ff0000', borderColor: '#ff0000' } }
        : n,
    ),
  });
  await expectPixel(ctx, 115 + OFFSET.x, 115 + OFFSET.y, '#ff0000', {
    message: 'the card is drawn offset by the pane origin',
  });
  assert.ok(
    !isNear(await pixelAt(ctx, 105, 105), '#ff0000'),
    'and not at the graph numbers read as window ones',
  );
});

// --- onFrame -------------------------------------------------------------------

test('onFrame reports each 2D frame once, whatever it painted', async () => {
  // `<Map onFrame>`'s contract: a frame, not a paint. The 2D renderer can
  // paint several damage rects in one flush, and an FPS read off this must
  // count the flush once.
  const frames: FlowFrameStats[] = [];
  const { flow } = await mount({
    onFrame: (stats: FlowFrameStats) => void frames.push(stats),
  });
  await act();
  frames.length = 0;
  flow.current?.setViewport({ x: 30 });
  await act();
  assert.strictEqual(frames.length, 1, 'one viewport change, one frame');
  assert.strictEqual(frames[0].renderer, 'retained');
  assert.ok(frames[0].sceneMs >= 0 && frames[0].drawMs >= 0);
  assert.strictEqual(frames[0].drawCalls, 0, 'draw calls are the GL one’s');
});

test('a mounted body is not re-rendered for a move, only for what it shows', async () => {
  // A drag, and every commit of a controlled graph, hands the pane a new
  // node object with only its position changed. The body's `render` must
  // not run for that — its box moves and its subtree rides along — and must
  // run for anything else: new `data` here.
  let renders = 0;
  const counted: FlowNodeType = {
    size: { width: 200, height: 120 },
    render: ({ node }) => {
      renders++;
      return h('text', null, String((node.data as FlowNodeData).label));
    },
  };
  const flow: { current: FlowInstance | null } = { current: null };
  const base: FlowNode[] = [
    {
      id: 'a',
      type: 'counted',
      position: { x: 0, y: 0 },
      data: { label: 'one' },
    },
  ];
  const props = { ref: flow, edges: [], nodeTypes: { counted } };
  const { rerender } = await renderX11(h(TypedFlow, { ...props, nodes: base }));
  await act();
  assert.ok(renders > 0, 'precondition: the body is mounted');
  const before = renders;

  let current = base;
  for (let step = 1; step <= 5; step++) {
    current = current.map((n) => ({ ...n, position: { x: step * 10, y: 0 } }));
    await act(() => rerender(h(TypedFlow, { ...props, nodes: current })));
  }
  assert.strictEqual(renders, before, 'five moves, no render');

  current = current.map((n) => ({ ...n, data: { label: 'two' } }));
  await act(() => rerender(h(TypedFlow, { ...props, nodes: current })));
  assert.strictEqual(renders, before + 1, 'new data, one render');
});

test('a pan moves the bodies’ one box, and re-renders no body', async () => {
  // A pan changes the viewport's translation and nothing else, so it moves
  // the box the bodies are laid out in — one style change — and hands every
  // body the same props as before. Committing each body's new position on
  // every pan step was what held a pan over 48 of them to 57 frames/s.
  let renders = 0;
  const counted: FlowNodeType = {
    size: { width: 200, height: 120 },
    headerHeight: 20,
    render: () => {
      renders++;
      return h('text', null, 'body');
    },
  };
  const { flow } = await mount({
    nodes: [
      { id: 'a', type: 'counted', position: { x: 100, y: 100 } },
      { id: 'b', type: 'counted', position: { x: 400, y: 100 } },
    ],
    edges: [],
    nodeTypes: { counted },
  });
  await act();
  const before = renders;
  const bodyLeft = bodyBox().props.style as { left: number };
  const start = {
    ...(bodyLayer().props.style as { left: number; top: number }),
  };
  for (let step = 1; step <= 5; step++) {
    await act(() => flow.current!.setViewport({ x: step * 7, y: step * 3 }));
  }
  assert.strictEqual(renders, before, 'five pan steps, no body render');
  const layer = bodyLayer().props.style as { left: number; top: number };
  assert.deepStrictEqual(
    { left: layer.left - start.left, top: layer.top - start.top },
    { left: 35, top: 15 },
    'the box moved by the pan',
  );
  assert.strictEqual(
    (bodyBox().props.style as { left: number }).left,
    bodyLeft.left,
    'and the body inside it did not',
  );
});

test('bodies are painted with the graph’s origin panned off the pane', async () => {
  // The bodies' one box sat at the graph's origin, 0×0 — and core culls a
  // child whose *own* box is off screen before it looks at what the child
  // holds. So a graph panned or zoomed past the pane's top-left, which is
  // every real view of a large graph, painted no body at all: the cards
  // drew, and the checkboxes and buttons inside them did not.
  const filled: FlowNodeType = {
    size: { width: 200, height: 120 },
    headerHeight: 20,
    render: () =>
      h('box', { style: { flexGrow: 1, backgroundColor: '#ff00ff' } }),
  };
  const flow: { current: FlowInstance | null } = { current: null };
  const { ctx } = await renderX11(
    h(TypedFlow, {
      ref: flow,
      nodes: [{ id: 'far', type: 'filled', position: { x: 600, y: 400 } }],
      edges: [],
      nodeTypes: { filled },
    }),
  );
  await act();
  // the origin 500 px left of the pane and 300 above; the card at (100,100)
  await act(() => flow.current!.setViewport({ x: -500, y: -300 }));
  await act();
  const layer = bodyLayer();
  assert.ok(
    layer.abs.x + layer.abs.width > 0 && layer.abs.y + layer.abs.height > 0,
    `the bodies' box reaches the pane (${JSON.stringify(layer.abs)})`,
  );
  await expectPixel(ctx, 200, 180, '#ff00ff', {
    message: 'the body is painted on its card',
  });
});

test('bodies over the budget sit a wheel zoom out, mounted and hidden, and come back at the new scale', async () => {
  // Re-scaling a body is a restyle, a layout and a repaint of its whole
  // subtree, about a millisecond each per zoom step; over 42 bodies that
  // held a zoom to 15 frames a second. Ten are predicted over the budget,
  // so a gesture zoom hides them and leaves them alone, and they return
  // once it rests.
  let renders = 0;
  let unmounts = 0;
  const counted: FlowNodeType = {
    size: { width: 200, height: 120 },
    headerHeight: 20,
    render: () => {
      renders++;
      React.useEffect(() => () => void unmounts++, []);
      return h('text', null, 'body');
    },
  };
  await mount({
    // ten cards in two rows, all on screen
    nodes: Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      type: 'counted',
      position: { x: 20 + (i % 5) * 140, y: 60 + Math.floor(i / 5) * 150 },
      width: 120,
      height: 100,
    })),
    edges: [],
    nodeTypes: { counted },
  });
  await act();
  assert.strictEqual(bodyLayer().children.length, 10, 'precondition');
  const before = renders;
  const node = pane();
  for (let notch = 0; notch < 4; notch++) {
    await userEvent.wheel(node, { ...at(40, 40), deltaY: -24 });
  }
  assert.ok(bodiesAway(), 'hidden while the wheel turns');
  assert.strictEqual(renders, before, 'and not rendered once per notch');

  await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
  assert.ok(!bodiesAway(), 'back once the zoom rests');
  // the zoom pushed some cards off the pane, and theirs leave; the rest
  // were mounted throughout — their state survives — and render once each
  const still = bodyLayer().children.length;
  assert.ok(still > 0 && still < 10, `precondition: some left (${still})`);
  assert.strictEqual(renders, before + still, 'once each, at the new scale');
  assert.strictEqual(unmounts, 10 - still, 'no body still on screen remounted');
  const scale = retained(bodyBox().children[0]).props.scale as number;
  assert.ok(scale > 1, `at the zoom the wheel left (${scale})`);
});

test('a body that fits the budget zooms live with the wheel', async () => {
  await mount({ nodes: bodyNode(), edges: [], nodeTypes: { form: sizedType } });
  await userEvent.wheel(pane() as unknown as DrawnNode, {
    ...at(40, 40),
    deltaY: -48,
  });
  assert.ok(!bodiesAway(), 'one body is not held');
  const scale = retained(bodyBox().children[0]).props.scale as number;
  assert.ok(scale > 1, `and it is at the new zoom (${scale})`);
});

test('a programmatic zoom applies to bodies at once', async () => {
  const { flow } = await mount({
    nodes: bodyNode(),
    edges: [],
    nodeTypes: { form: sizedType },
  });
  await act(() => flow.current!.setViewport({ zoom: 1.5 }));
  await act(() => flow.current!.setViewport({ zoom: 2 }));
  assert.ok(!bodiesAway());
  assert.strictEqual(retained(bodyBox().children[0]).props.scale, 2);
});

test('a wheel over a mounted body zooms the graph', async () => {
  // The bodies are the pane's siblings, so a wheel over one never reached
  // the pane: over a graph of cards with bodies, the zoom stalled wherever
  // the pointer rested.
  const { flow } = await mount({
    nodes: bodyNode(),
    edges: [],
    nodeTypes: { form: sizedType },
  });
  // at 2×, so the body's own unit is not the pane's
  await act(() => flow.current!.setViewport({ x: 0, y: 0, zoom: 2 }));
  const mark = retained(screen.getByText('mark'));
  const point = {
    x: mark.abs.x + mark.abs.width / 2,
    y: mark.abs.y + mark.abs.height / 2,
  };
  const under = flow.current!.screenToFlowPosition(point);
  await userEvent.wheel(mark as unknown as DrawnNode, { deltaY: -48 });
  assert.ok(flow.current!.getViewport().zoom > 2, 'the wheel zoomed');
  const after = flow.current!.screenToFlowPosition(point);
  assert.ok(
    Math.abs(after.x - under.x) < 0.5 && Math.abs(after.y - under.y) < 0.5,
    `about the pointer: ${JSON.stringify(under)} -> ${JSON.stringify(after)}`,
  );
});

test('a curve is drawn within a fifth of a pixel of itself at any zoom', () => {
  // A backwards S-bend — the edge doubling back past its own cards — zoomed
  // in threefold, in screen space as the pane routes it. The count was
  // clamp(length / 6, 8, 48) and uniform: chords of tens of pixels across a
  // tight bend, the facets visible in a zoomed-in graph.
  const zoom = 3;
  const source = { x: 900, y: 200, position: 'right' as const };
  const target = { x: 100, y: 700, position: 'left' as const };
  const route = { ...ROUTE, stepOffset: 20 * zoom, scale: zoom };
  const drawn = edgePath('bezier', source, target, route);
  // the curve itself, from its own control points
  const [c0, c1] = bezierControls(source, target, zoom);
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const t = i / 2000;
    const u = 1 - t;
    const p = {
      x:
        u * u * u * source.x +
        3 * u * u * t * c0.x +
        3 * u * t * t * c1.x +
        t * t * t * target.x,
      y:
        u * u * u * source.y +
        3 * u * u * t * c0.y +
        3 * u * t * t * c1.y +
        t * t * t * target.y,
    };
    worst = Math.max(worst, distanceToPath(drawn, p));
  }
  assert.ok(worst <= 0.2 + 1e-6, `strays ${worst.toFixed(3)} px`);
  // and a gentle curve at the fitted zoom is not paying for it
  const gentle = edgePath(
    'bezier',
    { x: 0, y: 0, position: 'right' },
    { x: 60, y: 10, position: 'left' },
    ROUTE,
  );
  assert.ok(gentle.length <= 12, `${gentle.length} vertices`);
});

test('`adaptive` sets the body budget, and every frame reports it', async () => {
  // ten bodies, predicted at 12 ms: held under the default 8, live under 20
  // or with `adaptive={false}`, held through any gesture under 0
  const cards = Array.from({ length: 10 }, (_, i) => ({
    id: `n${i}`,
    type: 'form',
    position: { x: 20 + (i % 5) * 140, y: 60 + Math.floor(i / 5) * 150 },
    width: 120,
    height: 100,
  }));
  for (const [adaptive, held] of [
    [undefined, true],
    [{ budgetMs: 20 }, false],
    [false, false],
    [{ budgetMs: 0 }, true],
  ] as const) {
    const frames: FlowFrameStats[] = [];
    await mount({
      nodes: cards,
      edges: [],
      nodeTypes: { form: sizedType },
      adaptive,
      onFrame: (f) => void frames.push(f),
    });
    await userEvent.wheel(pane() as unknown as DrawnNode, {
      ...at(10, 10),
      deltaY: -24,
    });
    assert.strictEqual(
      bodiesAway(),
      held,
      `adaptive ${JSON.stringify(adaptive)}`,
    );
    await act();
    const last = frames[frames.length - 1];
    assert.ok(last, 'a frame was reported');
    assert.strictEqual(last.bodies.held, held);
    assert.ok(last.bodies.count > 0 && last.bodies.count <= 10);
    assert.strictEqual(
      last.bodies.budgetMs,
      adaptive === false ? Infinity : (adaptive?.budgetMs ?? 8),
    );
    cleanup();
  }
});

test('the pane between mounted bodies takes the pointer, and so does a card’s header', async () => {
  // The bodies' one box spans every body, gaps and headers included. Taking
  // the pointer itself, it ate every press between the cards — no pan, no
  // pane click — and every header inside its span — no selecting the node.
  const nodeClicks: string[] = [];
  let paneClicks = 0;
  await mount({
    nodes: [
      {
        id: 'a',
        type: 'form',
        position: { x: 60, y: 60 },
        width: 200,
        height: 120,
      },
      {
        id: 'b',
        type: 'form',
        position: { x: 460, y: 260 },
        width: 200,
        height: 120,
      },
    ],
    edges: [],
    nodeTypes: { form: sizedType },
    onPaneClick: () => void paneClicks++,
    onNodeClick: (_ev: unknown, node: FlowNode) =>
      void nodeClicks.push(node.id),
  });
  await act();
  const node = pane() as unknown as DrawnNode;
  // bare pane, inside the span of the bodies' box
  await userEvent.click(node, at(360, 220));
  assert.strictEqual(
    paneClicks,
    1,
    'the press between the cards reached the pane',
  );
  // b's header: inside the span, above b's body
  await userEvent.click(node, at(560, 270));
  assert.deepStrictEqual(nodeClicks, ['b'], 'the header selects its node');
});

test('a press on a body’s plain part selects and drags its node; its controls keep theirs', async () => {
  // Core runs a press's defaults on the node that took it, so a body took
  // the card's select and drag with it — a card mostly body could barely be
  // grabbed. Its controls still get theirs.
  let pressed = 0;
  const withButton: FlowNodeType = {
    size: { width: 200, height: 120 },
    headerHeight: 20,
    render: () =>
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h('box', {
          style: { width: 40, height: 20, backgroundColor: '#888' },
          onClick: () => void pressed++,
        }),
      ),
  };
  const { recorded } = await mount({
    nodes: [
      {
        id: 'a',
        type: 'form',
        position: { x: 100, y: 100 },
        width: 200,
        height: 120,
      },
    ],
    edges: [],
    nodeTypes: { form: withButton },
  });
  await act();
  const node = pane() as unknown as DrawnNode;
  // the control: 10 px into the body (x 105 + 10, y 120 + 10)
  await userEvent.click(node, at(125, 135));
  assert.strictEqual(pressed, 1, 'the control inside the body took its click');
  assert.strictEqual(ofType(recorded.nodeChanges, 'position').length, 0);

  // the body's plain part, well clear of the control: drag it 30 px
  await act(() => {
    fireEvent.mouseDown(node, at(250, 190));
    fireEvent.mouseMove(node, at(265, 200));
    fireEvent.mouseMove(node, at(280, 210));
    fireEvent.mouseUp(node, at(280, 210));
  });
  const moved = ofType(recorded.nodeChanges, 'position');
  const last = moved[moved.length - 1];
  assert.ok(last?.type === 'position', 'the drag moved the node');
  assert.deepStrictEqual(last.position, { x: 130, y: 120 });
  const selected = ofType(recorded.nodeChanges, 'select');
  assert.ok(
    selected.some((c) => c.type === 'select' && c.id === 'a' && c.selected),
    'and selected it',
  );
  assert.strictEqual(pressed, 1, 'the control saw none of it');
});

test('an opaque body over a lower card’s body hides it, in the cards’ paint order', async () => {
  // Every body is over every card — they share one layer above the graph —
  // so a transparent body showed whatever body lay under it: two cards'
  // controls mixed in one box. The lower card's body here is solid red to
  // its edges; the upper card, selected (so painted later), has an empty
  // body over the overlap.
  const redType: FlowNodeType = {
    size: { width: 200, height: 120 },
    headerHeight: 20,
    render: () =>
      h('box', { style: { flexGrow: 1, backgroundColor: '#ff0000' } }),
  };
  const emptyType: FlowNodeType = {
    size: { width: 200, height: 120 },
    headerHeight: 20,
    render: () => h('box', { style: { flexGrow: 1 } }),
  };
  const { ctx } = await renderX11(
    h(TypedFlow, {
      nodes: [
        { id: 'under', type: 'red', position: { x: 100, y: 100 } },
        {
          id: 'over',
          type: 'empty',
          position: { x: 160, y: 140 },
          selected: true,
        },
      ],
      edges: [],
      nodeTypes: { red: redType, empty: emptyType },
    }),
  );
  await act();
  assert.strictEqual(bodyLayer().children.length, 2, 'precondition');
  // inside the overlap, well inside the upper card's body: x 160+5..,
  // y 140+20..; and inside the lower card's red body (100+5..295, 120..215)
  assert.ok(
    !isNear(await pixelAt(ctx, 220, 190), '#ff0000'),
    'the upper body hides the red body under it',
  );
  await expectPixel(ctx, 130, 150, '#ff0000', {
    message: 'and the red body shows where nothing is over it',
  });
});

test('a dragged node’s body is lifted over the others, as its card is', async () => {
  await mount({
    nodes: [
      {
        id: 'a',
        type: 'form',
        position: { x: 100, y: 100 },
        width: 200,
        height: 120,
      },
      {
        id: 'b',
        type: 'form',
        position: { x: 400, y: 100 },
        width: 200,
        height: 120,
      },
    ],
    edges: [],
    nodeTypes: { form: sizedType },
  });
  await act();
  const firstBody = () => retained(bodyLayer().children[0]).abs.x;
  const node = pane() as unknown as DrawnNode;
  // drag `a` (declared first, so painted first) by its header
  await act(() => {
    fireEvent.mouseDown(node, at(150, 108));
    fireEvent.mouseMove(node, at(170, 118));
    fireEvent.mouseMove(node, at(190, 128));
  });
  const last = bodyLayer().children[bodyLayer().children.length - 1];
  assert.ok(
    retained(last).abs.x < retained(bodyLayer().children[0]).abs.x,
    'mid-drag, `a`’s body (the left one) is the last child — on top',
  );
  await act(() => fireEvent.mouseUp(node, at(190, 128)));
  assert.ok(firstBody() < 400, 'after the drop, back in declaration order');
});

test('a card over another card’s body is painted over it, border and header', async () => {
  // Every body shares one layer over every card, so the lower card's body
  // covered whatever of the upper card was not body — its header, border,
  // handles: a selected node's outline behind the node under it. Each
  // mounted card is now painted in the bodies' layer, just under its body.
  const redType: FlowNodeType = {
    size: { width: 200, height: 120 },
    headerHeight: 20,
    render: () =>
      h('box', { style: { flexGrow: 1, backgroundColor: '#ff0000' } }),
  };
  const { ctx } = await renderX11(
    h(TypedFlow, {
      nodes: [
        { id: 'under', type: 'red', position: { x: 100, y: 100 } },
        // selected, so painted over `under`, and bordered in the accent;
        // its header and left border cross `under`'s red body
        {
          id: 'over',
          type: 'red',
          position: { x: 180, y: 160 },
          selected: true,
          style: { borderColor: '#00ff00' },
        },
      ],
      edges: [],
      nodeTypes: { red: redType },
      palette: { accent: '#00ff00' },
    }),
  );
  await act();
  // `over`'s left border, 2 px wide at x 180..182, at y 170: inside
  // `under`'s red body (x 105..295, y 120..215)
  await expectPixel(ctx, 180, 190, '#00ff00', {
    message: 'the upper card’s border is over the lower card’s body',
  });
  // `over`'s header band (y 160..180), right of the border
  assert.ok(
    !isNear(await pixelAt(ctx, 240, 170), '#ff0000'),
    'and so is its header',
  );
  await expectPixel(ctx, 130, 150, '#ff0000', {
    message: 'the lower body still shows where nothing is over it',
  });
});

test('the minimap and the controls stay over mounted bodies', async () => {
  // The bodies' layer is over the graph, and the panels were the graph's:
  // a card that reached a corner covered them. With bodies mounted they are
  // painted on canvases over the bodies' layer.
  const redType: FlowNodeType = {
    size: { width: 400, height: 300 },
    headerHeight: 20,
    render: () =>
      h('box', { style: { flexGrow: 1, backgroundColor: '#ff0000' } }),
  };
  const { ctx } = await renderX11(
    h(TypedFlow, {
      // one big card under both corners the panels sit in
      nodes: [{ id: 'big', type: 'red', position: { x: -20, y: 40 } }],
      edges: [],
      nodeTypes: { red: redType },
      minimap: true,
      controls: true,
      palette: { surface: '#00ff00', surfaceBorder: '#00ff00' },
      style: { width: 380, height: 360 },
    }),
    { width: 380, height: 360 },
  );
  await act();
  const node = pane() as unknown as { panelRects(): FlowRect[] };
  const [map, controls] = node.panelRects();
  assert.ok(map && controls, 'precondition: both panels are shown');
  // each panel's centre, over the card's red body (x −15..375, y 60..335)
  const inside = (r: FlowRect) => ({
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
  });
  for (const [name, r] of [
    ['minimap', map],
    ['controls', controls],
  ] as const) {
    const p = inside(r);
    assert.ok(
      !isNear(await pixelAt(ctx, p.x, p.y), '#ff0000'),
      `the ${name} is over the red body at (${p.x}, ${p.y})`,
    );
  }
});

test('the graph leaves out the cards the bodies’ layer shows, and takes them back while bodies are held', async () => {
  await mount({
    nodes: Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      type: 'form',
      position: { x: 20 + (i % 5) * 140, y: 60 + Math.floor(i / 5) * 150 },
      width: 120,
      height: 100,
    })),
    edges: [],
    nodeTypes: { form: sizedType },
  });
  await act();
  const shown = () =>
    (pane() as unknown as { _shownBodies: ReadonlySet<string> })._shownBodies;
  assert.strictEqual(shown().size, 10, 'every mounted card is the layer’s');
  // a wheel zoom over the budget holds the bodies: their cards come back
  await userEvent.wheel(pane() as unknown as DrawnNode, {
    ...at(10, 10),
    deltaY: -24,
  });
  assert.ok(bodiesAway(), 'precondition: held');
  assert.strictEqual(shown().size, 0, 'held bodies hand their cards back');
});

test('under GL a pan asks for a GL frame and claims nothing of the 2D pane', async () => {
  // The pan is the surface's offset uniform. Claiming the pane's box every
  // step repainted it under the surface for nothing, and with bodies
  // mounted the claim reached core's overlay too (react-x11#644).
  await renderX11(
    h(FLOW_ELEMENT, {
      nodes: bodyNode(),
      edges: [],
      renderer: 'gl',
      style: { flexGrow: 1 },
    }),
  );
  const node = pane() as unknown as {
    setGlRequest(fn: () => void): void;
    setViewport(v: object): void;
    invalidate(...a: unknown[]): void;
  };
  let asked = 0;
  node.setGlRequest(() => void asked++);
  await act();
  const claims: unknown[][] = [];
  const own = node.invalidate.bind(node);
  node.invalidate = (...a: unknown[]) => {
    claims.push(a);
    own(...a);
  };
  const before = asked;
  node.setViewport({ x: 30, y: 10, zoom: 1 });
  assert.ok(asked > before, 'a GL frame was asked for');
  assert.strictEqual(claims.length, 0, 'and nothing of the pane was claimed');
  // nor does a zoom: the frame decides what it rebuilds
  const zoomed = asked;
  node.setViewport({ x: 30, y: 10, zoom: 1.5 });
  assert.ok(asked > zoomed, 'a zoom asks for a GL frame');
  assert.strictEqual(claims.length, 0, 'and claims nothing either');
});

/** The GL frame `<Flow>`'s surface asks the pane for, and how it asks. */
interface GlPane {
  setGlRequest(fn: () => void): void;
  setViewport(v: object): void;
  glFrame(lastKey: string | null): {
    world: unknown;
    key: string;
    zoom: number;
  } | null;
}

async function glPane(
  props: Record<string, unknown> = {},
): Promise<{ node: GlPane; asked: () => number }> {
  await renderX11(
    h(FLOW_ELEMENT, {
      nodes: nodes(),
      edges: edges(),
      renderer: 'gl',
      style: { flexGrow: 1 },
      ...props,
    }),
  );
  const node = pane() as unknown as GlPane;
  let asked = 0;
  node.setGlRequest(() => void asked++);
  await act();
  return { node, asked: () => asked };
}

test('under GL a zoom gesture draws the world it has, scaled, and rebuilds it once the zoom rests', async () => {
  // Every step of a zoom built, packed and uploaded the whole world again
  // — 19 ms a step on a 300-node graph, where a step of a pan is a uniform.
  const { node, asked } = await glPane();
  let frame = node.glFrame(null)!;
  assert.ok(frame.world, 'the first frame builds the world');
  // a zoom alone is a jump — a control's button, fitView — drawn exactly
  node.setViewport({ x: 0, y: 0, zoom: 1.2 });
  frame = node.glFrame(frame.key)!;
  assert.ok(frame.world, 'a jump rebuilds at once');
  assert.strictEqual(frame.zoom, 1);
  const key = frame.key;
  // the steps that follow it are a gesture
  node.setViewport({ x: 0, y: 0, zoom: 1.5 });
  frame = node.glFrame(key)!;
  assert.strictEqual(frame.world, null, 'a step of a gesture rebuilds nothing');
  assert.strictEqual(frame.key, key, 'the world on the GPU is still the one');
  assert.ok(
    Math.abs(frame.zoom - 1.5 / 1.2) < 1e-9,
    `and is drawn magnified from the zoom it was built at: ${frame.zoom}`,
  );
  node.setViewport({ x: 0, y: 0, zoom: 1.4 });
  frame = node.glFrame(key)!;
  assert.strictEqual(frame.world, null, 'out as well as in');
  // once it holds still, the pane asks for the frame that rebuilds it
  const before = asked();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(asked() > before, 'the rest asks for a frame by itself');
  frame = node.glFrame(key)!;
  assert.ok(frame.world, 'which rebuilds the world at the zoom it rested at');
  assert.strictEqual(frame.zoom, 1);
});

test('under GL a zoom gesture never magnifies one build past the span', async () => {
  const { node } = await glPane();
  let frame = node.glFrame(null)!;
  node.setViewport({ x: 0, y: 0, zoom: 1.1 });
  frame = node.glFrame(frame.key)!;
  node.setViewport({ x: 0, y: 0, zoom: 1.6 });
  frame = node.glFrame(frame.key)!;
  assert.strictEqual(frame.world, null, 'precondition: a scaled step');
  // 2.4 is more than twice the 1.1 the world was built at
  node.setViewport({ x: 0, y: 0, zoom: 2.4 });
  frame = node.glFrame(frame.key)!;
  assert.ok(frame.world, 'a step past the span rebuilds, mid-gesture');
  assert.strictEqual(frame.zoom, 1);
  node.setViewport({ x: 0, y: 0, zoom: 2.5 });
  frame = node.glFrame(frame.key)!;
  assert.strictEqual(frame.world, null, 'and the gesture scales from there');
  assert.ok(Math.abs(frame.zoom - 2.5 / 2.4) < 1e-9);
});

test('under GL a change to the graph mid-zoom rebuilds at the zoom of the moment', async () => {
  const { node } = await glPane();
  let frame = node.glFrame(null)!;
  node.setViewport({ x: 0, y: 0, zoom: 1.1 });
  frame = node.glFrame(frame.key)!;
  node.setViewport({ x: 0, y: 0, zoom: 1.3 });
  // the world the surface holds is not the one the pane last built — an
  // atlas reset, or anything that moved the version
  frame = node.glFrame(null)!;
  assert.ok(frame.world, 'rebuilt');
  assert.strictEqual(frame.zoom, 1, 'at the zoom it is drawn at, unscaled');
});

test('a panel canvas is asked to repaint its own box, not the window', async () => {
  // A claim with no region is the whole window: every pan step and every
  // dash tick became a full frame.
  await mount({
    nodes: bodyNode(),
    edges: [],
    nodeTypes: { form: sizedType },
    minimap: true,
    controls: true,
  });
  await act();
  const calls: unknown[][] = [];
  const canvas = {
    invalidate: (...a: unknown[]) => void calls.push(a),
  };
  const node = pane() as unknown as {
    setPanelCanvases(c: unknown[]): void;
    setViewport(v: object): void;
  };
  node.setPanelCanvases([canvas]);
  calls.length = 0;
  node.setViewport({ x: 12, y: 0, zoom: 1 });
  assert.ok(calls.length > 0, 'the canvas is asked to repaint');
  for (const [layout, damage, reason] of calls) {
    assert.strictEqual(layout, false);
    assert.strictEqual(damage, canvas, 'its own box');
    assert.strictEqual(reason, 'props');
  }
});

/** The pane's two panel canvases, each told apart by its box, as `<Flow>`
 *  mounts them where node types mount bodies. */
function panelCanvases(): { map: RetainedNode; controls: RetainedNode } {
  const canvases = (pane() as unknown as { _panelCanvases: RetainedNode[] })
    ._panelCanvases;
  assert.strictEqual(canvases.length, 2, 'the minimap’s and the controls’');
  // the minimap sits bottom-right, the controls bottom-left
  const [a, b] = canvases;
  return a.abs.x > b.abs.x ? { map: a, controls: b } : { map: b, controls: a };
}

test('a change to the graph repaints the minimap’s canvas, and not the controls’', async () => {
  // The controls draw nothing of the graph. Repainting their canvas with
  // every step of a drag repainted the minimap with it, since each canvas
  // built the panels its box reached — and theirs reached both.
  await mount({
    nodes: bodyNode(),
    edges: [],
    nodeTypes: { form: sizedType },
    minimap: true,
    controls: true,
  });
  await act();
  const { map, controls } = panelCanvases();
  const asked = new Map<RetainedNode, number>();
  for (const canvas of [map, controls]) {
    const own = canvas.invalidate.bind(canvas);
    canvas.invalidate = ((...a: Parameters<typeof own>) => {
      asked.set(canvas, (asked.get(canvas) ?? 0) + 1);
      own(...a);
    }) as typeof canvas.invalidate;
  }
  const node = pane() as unknown as DrawnNode;
  await act(() => {
    fireEvent.mouseDown(node, at(115, 110));
    fireEvent.mouseMove(node, at(135, 125));
    fireEvent.mouseUp(node, at(135, 125));
  });
  assert.ok((asked.get(map) ?? 0) > 0, 'the minimap follows the node');
  assert.strictEqual(asked.get(controls) ?? 0, 0, 'the controls do not');
  // …and a pan is the minimap's alone too: its view box moves
  asked.clear();
  (pane() as unknown as { setViewport(v: object): void }).setViewport({
    x: 20,
    y: 0,
    zoom: 1,
  });
  assert.ok((asked.get(map) ?? 0) > 0);
  assert.strictEqual(asked.get(controls) ?? 0, 0);
});

test('the controls’ canvas paints the controls without walking the graph', async () => {
  await mount({
    nodes: bodyNode(),
    edges: [],
    nodeTypes: { form: sizedType },
    minimap: true,
    controls: true,
  });
  await act();
  const { map, controls } = panelCanvases();
  const node = pane() as unknown as { _miniMap(): unknown };
  let walks = 0;
  const own = node._miniMap.bind(node);
  node._miniMap = () => {
    walks++;
    return own();
  };
  await act(() => controls.invalidate(false, controls, 'props'));
  await act();
  assert.strictEqual(walks, 0, 'the minimap is not the controls’ to build');
  await act(() => map.invalidate(false, map, 'props'));
  await act();
  assert.ok(walks > 0, 'the minimap’s canvas builds it');
});

// --- the device-pixel grid at a fractional scale ------------------------------
//
// Windows runs most laptops at 125%, where one logical pixel is 1.25 device
// ones and layout rounds a box's two edges to the device grid separately.
// These pin what that broke.

const AT_125 = {
  scale: 1.25,
  width: 480,
  height: 320,
  screen: { width: 1000, height: 800 },
} as unknown as RenderX11Options;

/** Three mounted cards side by side. */
function threeBodies(): FlowNode[] {
  return ['a', 'b', 'c'].map((id, i) => ({
    id,
    type: 'form',
    position: { x: 20 + i * 150, y: 60 },
    width: 130,
    height: 100,
  }));
}

test('at 1.25x a pan moves the bodies’ box by whole pixels, the same size, and re-renders no card', async () => {
  // The pane rounded a card's offset from the graph's origin to logical
  // pixels, against an origin rounded separately — so as a pan's fraction
  // cycled against the device grid, a card's offset flipped by a pixel,
  // the bodies were handed out anew, and the box around them changed size
  // with them. Core moves a `<glarea>` child's pixels only when it moved
  // and nothing else (react-x11#644): every step of a GL pan over bodies
  // repainted all of them. 20 frames a second on the widgets scene; 50
  // with the box on the grid.
  const flow: { current: FlowInstance | null } = { current: null };
  await renderX11(
    h(TypedFlow, {
      ref: flow,
      nodes: threeBodies(),
      edges: [],
      nodeTypes: { form: sizedType },
    }),
    AT_125,
  );
  await act();
  const layer0 = bodyLayer().abs;
  const offsets = (): string =>
    bodyLayer()
      .children.map((c) => {
        const r = retained(c).abs;
        return `${r.x - bodyLayer().abs.x},${r.y - bodyLayer().abs.y},${r.width}x${r.height}`;
      })
      .join('|');
  const inside = offsets();
  const cardProps = bodyLayer().children.map((c) => retained(c).props);
  for (const [x, y] of [
    [1.7, 0.3],
    [4.1, 2.9],
    [7.35, 3.3],
    [9.8, 5.05],
    [12.6, 7.4],
  ]) {
    await act(() => flow.current!.setViewport({ x, y }));
    const layer = bodyLayer().abs;
    assert.deepStrictEqual(
      [layer.width, layer.height],
      [layer0.width, layer0.height],
      `the box kept its size at (${x}, ${y})`,
    );
    assert.ok(
      Number.isInteger(layer.x) && Number.isInteger(layer.y),
      'and sits on whole device pixels',
    );
    assert.strictEqual(offsets(), inside, 'every card rode along unchanged');
  }
  bodyLayer().children.forEach((c, i) =>
    assert.ok(retained(c).props === cardProps[i], `card ${i} not re-rendered`),
  );
});

test('at 1.25x a dragged card’s box moves and keeps its size', async () => {
  // The box a card is laid out in was the gap between two edges, each put
  // on the device grid: dragged a fraction of a pixel, the edges rounded
  // apart and the box grew or shrank by one. A box that changed size is not
  // a box that only moved, so every step of a drag measured the content
  // floors and repainted the card where core would have moved it.
  const flow: { current: FlowInstance | null } = { current: null };
  const graph = (x: number): FlowNode[] => [
    { ...threeBodies()[0], position: { x, y: 100 } },
  ];
  const { rerender } = await renderX11(
    h(TypedFlow, {
      ref: flow,
      nodes: graph(100),
      edges: [],
      nodeTypes: { form: sizedType },
    }),
    AT_125,
  );
  await act();
  const card = (): { width: number; height: number } =>
    retained(bodyLayer().children[0]).abs;
  const size = card();
  for (const x of [100.3, 100.9, 101.45, 102.2, 103.7]) {
    await act(() =>
      rerender(
        h(TypedFlow, {
          ref: flow,
          nodes: graph(x),
          edges: [],
          nodeTypes: { form: sizedType },
        }),
      ),
    );
    assert.deepStrictEqual(
      [card().width, card().height],
      [size.width, size.height],
      `the card at x=${x} kept its size`,
    );
  }
});

test('a drag step re-renders the card that moved and no other', async () => {
  // Every card element was made anew whenever any body moved, and each card
  // canvas got a new `onDraw` with it — which core reads as new content and
  // repaints (src/nodes/canvas.js). A drag over 36 bodies claimed 36 canvases
  // a step, past the frame's rect cap: one claim the size of the pane, every
  // card and every widget painted again, to move one of them.
  await mount({
    nodes: threeBodies(),
    edges: [],
    nodeTypes: { form: sizedType },
  });
  await act();
  const cards = () => bodyLayer().children.map((c) => retained(c));
  const [, b0, c0] = cards();
  const before = {
    b: b0.props,
    c: c0.props,
    bDraw: retained(b0.children[0]).props.onDraw,
  };
  const seam = pane() as unknown as {
    defaultMouseDown(ev: unknown): void;
    defaultMouseDrag(ev: unknown): void;
    defaultMouseUp(ev: unknown): void;
  };
  const synth = (x: number, y: number) => ({
    x,
    y,
    button: 1,
    shiftKey: false,
    ctrlKey: false,
    detail: 1,
    preventDefault() {},
    capturePointer() {},
  });
  const abs = pane().abs;
  // card `a` by its header strip
  await act(() => seam.defaultMouseDown(synth(abs.x + 80, abs.y + 70)));
  for (let step = 1; step <= 4; step++) {
    await act(() =>
      seam.defaultMouseDrag(
        synth(abs.x + 80 + step * 7, abs.y + 70 + step * 3),
      ),
    );
  }
  await act(() => seam.defaultMouseUp(synth(abs.x + 108, abs.y + 82)));
  const after = cards();
  const b1 = after.find((c) => c.props === before.b);
  const c1 = after.find((c) => c.props === before.c);
  assert.ok(b1, 'card b was not re-rendered');
  assert.ok(c1, 'card c was not re-rendered');
  assert.strictEqual(
    retained(b1.children[0]).props.onDraw,
    before.bDraw,
    'and its canvas kept its `onDraw`',
  );
});

test('a dash tick repaints neither the minimap nor the controls', async () => {
  // The panels draw no dashes. Asked to repaint on every change to the
  // pane, dash ticks included, an idle pane with one animated edge kept
  // painting both canvases 17 times a second — and a tick landing in a pan
  // frame put a claim inside the band the pan was about to move.
  await mount({
    nodes: [...threeBodies().slice(0, 2)],
    edges: [{ id: 'a-b', source: 'a', target: 'b', animated: true }],
    nodeTypes: { form: sizedType },
    minimap: true,
    controls: true,
  });
  await act();
  const reasons: string[] = [];
  const canvas = {
    invalidate: (_layout: boolean, _damage: unknown, reason: string) =>
      void reasons.push(reason),
  };
  const node = pane() as unknown as {
    setPanelCanvases(c: unknown[]): void;
    invalidate(...a: unknown[]): void;
  };
  node.setPanelCanvases([canvas]);
  const ticks: unknown[] = [];
  const own = node.invalidate.bind(node);
  node.invalidate = (...a: unknown[]) => {
    if (a[2] === 'animation') ticks.push(a);
    own(...a);
  };
  reasons.length = 0;
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(ticks.length >= 2, 'the dash moved');
  assert.deepStrictEqual(reasons, [], 'and the panels were left alone');
});

test('a dash tick claims only what the pane shows of its edges', async () => {
  // The box a tick repaints is the drawn edges', and an animated edge on
  // its way out of the pane takes that box past the pane's sides — here
  // two thousand pixels past. Claimed whole, a tick repainted everything
  // the window has beside the graph, sixteen times a second.
  await mount({
    nodes: [
      { id: 'a', position: { x: 100, y: 100 }, data: { label: 'a' } },
      { id: 'b', position: { x: 2600, y: 900 }, data: { label: 'b' } },
    ],
    edges: [{ id: 'a-b', source: 'a', target: 'b', animated: true }],
  });
  await act();
  const node = pane() as unknown as {
    contentBox(): { x: number; y: number; width: number; height: number };
    invalidate(...a: unknown[]): void;
  };
  const claims: { x: number; y: number; width: number; height: number }[] = [];
  const own = node.invalidate.bind(node);
  node.invalidate = (...a: unknown[]) => {
    if (a[2] === 'animation') claims.push(a[1] as (typeof claims)[number]);
    own(...a);
  };
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(claims.length >= 2, 'the dash moved');
  const box = node.contentBox();
  for (const claim of claims) {
    assert.ok(
      claim.x >= box.x &&
        claim.y >= box.y &&
        claim.x + claim.width <= box.x + box.width &&
        claim.y + claim.height <= box.y + box.height,
      `a tick claimed ${JSON.stringify(claim)}, past ${JSON.stringify(box)}`,
    );
  }
});

test('a 2D pan over mounted bodies moves their pixels with the graph’s', async () => {
  // The bodies are laid out in one box a pan moves by exactly the pan, and
  // that box sat over the region the pane blits: every step declined the
  // copy and repainted the pane and every body on it. The pane hands the
  // box over as a rider (react-x11#671), and `<Flow>` clips it to the pane.
  await mount({
    nodes: threeBodies(),
    edges: [],
    nodeTypes: { form: sizedType },
    minimap: true,
    controls: true,
  });
  await act();
  assert.ok(bodyLayer().children.length > 0, 'the bodies are mounted');
  const wnd = (pane().root as unknown as { window: unknown }).window as {
    scrollRegion(rect: unknown, dx: number, dy: number): boolean;
  };
  const moved: number[] = [];
  const own = wnd.scrollRegion.bind(wnd);
  wnd.scrollRegion = (rect, dx, dy) => {
    moved.push(dx);
    return own(rect, dx, dy);
  };
  const flow = pane() as unknown as { setViewport(v: object): void };
  const layerX = bodyLayer().abs.x;
  for (let step = 1; step <= 3; step++) {
    await act(() => flow.setViewport({ x: step * 4, y: 0, zoom: 1 }));
  }
  assert.deepStrictEqual(moved, [4, 4, 4], 'every step moved the pixels');
  assert.strictEqual(bodyLayer().abs.x, layerX + 12, 'and the bodies went too');
});

test('a pan past panel canvases still moves the pane’s pixels', async () => {
  // Where node types mount bodies the minimap and controls are canvases of
  // `<Flow>`'s own, over the pane, and each asks to repaint on every change
  // to it — a claim of its paint bounds, core's damage slop included. The
  // bands a pan carves out for its furniture stopped at the panel's box, so
  // that pixel of slop landed inside the band the pan moves, and core, which
  // will not move pixels something else just claimed, repainted the whole
  // pane on every step instead.
  await mount({
    // mounting types, and nodes that use none of them: the stress
    // example's lattice
    nodes: nodes(),
    edges: edges(),
    nodeTypes: { form: sizedType },
    minimap: true,
    controls: true,
  });
  await act();
  const wnd = (pane().root as unknown as { window: unknown }).window as {
    scrollRegion(rect: unknown, dx: number, dy: number): boolean;
  };
  const moved: number[] = [];
  const own = wnd.scrollRegion.bind(wnd);
  wnd.scrollRegion = (rect, dx, dy) => {
    moved.push(dx);
    return own(rect, dx, dy);
  };
  const flow = pane() as unknown as { setViewport(v: object): void };
  for (let step = 1; step <= 3; step++) {
    await act(() => flow.setViewport({ x: step * 4, y: 0, zoom: 1 }));
  }
  assert.deepStrictEqual(moved, [4, 4, 4], 'every step moved the pixels');
});

test('the dashes sit a pan out, and every step of it moves the pixels', async () => {
  // A tick claims the dashes inside the band a pan copies, which declines
  // the copy: every frame a tick landed in repainted the pane whole.
  await mount({
    nodes: [
      { id: 'a', position: { x: 100, y: 100 }, data: { label: 'a' } },
      { id: 'b', position: { x: 400, y: 300 }, data: { label: 'b' } },
    ],
    edges: [{ id: 'a-b', source: 'a', target: 'b', animated: true }],
  });
  await act();
  const wnd = (pane().root as unknown as { window: unknown }).window as {
    scrollRegion(rect: unknown, dx: number, dy: number): boolean;
  };
  let moved = 0;
  const own = wnd.scrollRegion.bind(wnd);
  wnd.scrollRegion = (rect, dx, dy) => {
    moved++;
    return own(rect, dx, dy);
  };
  const node = pane() as unknown as {
    setViewport(v: object): void;
    invalidate(...a: unknown[]): void;
  };
  let ticks = 0;
  const invalidate = node.invalidate.bind(node);
  node.invalidate = (...a: unknown[]) => {
    if (a[2] === 'animation') ticks++;
    invalidate(...a);
  };
  const steps = 16;
  for (let step = 1; step <= steps; step++) {
    await act(() => node.setViewport({ x: step * 4, y: 0, zoom: 1 }));
    await new Promise((r) => setTimeout(r, 20));
  }
  await act();
  assert.strictEqual(ticks, 0, 'no tick in the middle of the pan');
  assert.strictEqual(moved, steps, 'and every step was a copy');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(ticks >= 2, `the dashes march again once it stops (${ticks})`);
});

test('a pan with no body on screen commits nothing', async () => {
  // The pane sent the bodies' origin on every step of a pan whether or not
  // any body was laid out at it, and `<Flow>` re-rendered for each — the
  // panels' canvases with it, whose new `onDraw` repainted the controls on
  // every frame of a pan over a graph of plain cards.
  await mount({
    nodes: nodes(),
    edges: edges(),
    nodeTypes: { form: sizedType },
    minimap: true,
    controls: true,
  });
  await act();
  const { map, controls } = panelCanvases();
  const before = [map.props, controls.props];
  const flow = pane() as unknown as { setViewport(v: object): void };
  for (let step = 1; step <= 3; step++) {
    await act(() => flow.setViewport({ x: step * 4, y: 0, zoom: 1 }));
  }
  assert.ok(
    map.props === before[0] && controls.props === before[1],
    'neither canvas was committed to',
  );
});

test('under GL a drag step asks for a GL frame and claims nothing of the window', async () => {
  // The 2D pane under the surface shows nothing, and every claim of it was
  // a window pass over it — a BeginDraw, a walk and a commit a drag step —
  // whose one job was to reach `paint` and ask the surface for a frame.
  await renderX11(
    h(FLOW_ELEMENT, {
      nodes: nodes(),
      edges: edges(),
      renderer: 'gl',
      style: { flexGrow: 1 },
    }),
  );
  const node = pane() as unknown as {
    setGlRequest(fn: () => void): void;
    defaultMouseDown(ev: unknown): void;
    defaultMouseDrag(ev: unknown): void;
    defaultMouseUp(ev: unknown): void;
  };
  let asked = 0;
  node.setGlRequest(() => void asked++);
  await act();
  const root = pane().root as unknown as {
    invalidate(...a: unknown[]): void;
  };
  const claims: unknown[][] = [];
  const own = root.invalidate.bind(root);
  root.invalidate = (...a: unknown[]) => {
    claims.push(a);
    own(...a);
  };
  const synth = (x: number, y: number) => ({
    x,
    y,
    button: 1,
    shiftKey: false,
    ctrlKey: false,
    detail: 1,
    preventDefault() {},
    capturePointer() {},
  });
  const abs = pane().abs;
  // node `a` (100,100 120×40) by its middle
  node.defaultMouseDown(synth(abs.x + 160, abs.y + 120));
  const before = asked;
  for (let step = 1; step <= 3; step++) {
    node.defaultMouseDrag(synth(abs.x + 160 + step * 10, abs.y + 120));
  }
  node.defaultMouseUp(synth(abs.x + 190, abs.y + 120));
  assert.ok(asked > before, 'the drag asked for GL frames');
  assert.deepStrictEqual(
    claims.filter(([, , reason]) => reason === 'content'),
    [],
    'and claimed none of the window for them',
  );
});
