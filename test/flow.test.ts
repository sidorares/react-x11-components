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
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
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
  FlowInstance,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  FlowProps,
  NodeChange,
} from '../src/index.js';
import {
  boundsOf,
  fitViewport,
  measureNode,
  resizeRect,
  resolveHandles,
} from '../src/flow/model.js';
import {
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

/** A window coordinate as the offset from the pane's centre that
 *  `fireEvent` wants. The pane fills the test window, and the default
 *  viewport is the identity, so window coordinates *are* graph
 *  coordinates. */
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

  // The box follows the zoom but its content does not, so below a threshold
  // there would be nothing readable to show: the pane draws the card instead.
  await act(() => flow.current!.setViewport({ zoom: 0.3 }));
  assert.strictEqual(screen.queryByText('body of a'), null);
  await act(() => flow.current!.setViewport({ zoom: 1 }));
  screen.getByText('body of a');
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

test('the pane names itself to a screen reader', async () => {
  await mount({ 'aria-label': 'build pipeline' });
  assert.strictEqual(pane().props['aria-label'], 'build pipeline');
  assert.strictEqual(pane().props.role, 'group');
});
