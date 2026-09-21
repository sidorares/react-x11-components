// `<Flow>` — a directed-graph editor: nodes you can drag, handles you can
// drag between, a pane you can pan and zoom, and a controlled `nodes`/`edges`
// pair that the app owns.
//
// The surface is react-flow's, because a graph editor's API is a solved
// problem and an app that has described a graph for one should not have to
// describe it again. What differs is the one thing that could not be carried
// over: react-flow renders each node as a DOM subtree and zooms with a CSS
// transform, and this renderer has neither, so a custom node type is a
// `paint` rather than a component. `./node.ts` has the argument in full.
//
// **Registration happens when this module is evaluated**, which is the
// design and not a shortcut: nothing in the package registers anything until
// an app imports the component that needs it, so `sideEffects: false` stays
// honest. Do not move it into `../index.ts` (AGENTS.md, "Tree-shaking is a
// constraint").
import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Dispatch, ReactElement, SetStateAction } from 'react';
import { Renderer, useTheme } from 'react-x11';
import { registerElement, registeredElements } from 'react-x11/host';
import { createStyles, flattenStyle } from 'react-x11/style';
// Loads the module the JSX augmentation at the bottom targets: nothing in
// `src/` writes JSX, so without this the build program never resolves
// `react-x11/jsx-runtime` and the augmentation is an error rather than an
// addition. Type-only, so it is erased.
import type {} from 'react-x11/jsx-runtime';

import { applyEdgeChanges, applyNodeChanges, resolvePalette } from './model.js';
import { ELEMENT, FlowGraphNode, SELF_DAMAGED_PROPS } from './node.js';
import type {
  EdgeChange,
  FlowEdge,
  FlowInstance,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  FlowProps,
  NodeBodyRect,
  NodeChange,
  XYPosition,
} from './types.js';

if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new FlowGraphNode(props, app),
    // No `semanticNames`: not one of this element's prop names is also a
    // style name, and `test/flow.test.ts` is what keeps that true — the
    // failure it guards against (throws in development, works in
    // production) is the worst shape a bug can have.
    childrenAllowed: false,
    // The commit claim: changes to these damage nothing by name — the
    // element's own `applyProps` diffs them into the box that actually
    // changed (react-x11#301). Without this, every drag step's new `nodes`
    // array identity would repaint the whole pane.
    selfDamagedProps: [...SELF_DAMAGED_PROPS],
  });
}

/**
 * `pane` is the default for the box `<Flow>` renders: it fills its parent —
 * unless the app's own style gives it a height or a `flexGrow`, in which
 * case adding one would silently override what it asked for. Checked
 * against the *flattened* style, so an array works too.
 *
 * `fill` is what the drawn pane always gets, because the app's style went on
 * the box around it. `overflow: 'hidden'` there is what clips a mounted node
 * body that has been panned half off the edge.
 */
const styles = createStyles({
  pane: { flexGrow: 1, overflow: 'hidden' },
  clip: { overflow: 'hidden' },
  fill: { flexGrow: 1 },
});

/**
 * Commit a state update before returning, whatever lane the surrounding
 * dispatch runs in.
 *
 * Pointer motion and the wheel dispatch at *continuous* priority, whose
 * React updates the scheduler may hold across several frames — while the
 * pane paints every gesture step immediately from its own state. A mounted
 * node body positioned through ordinary setState therefore trails the drawn
 * card by however many steps queue up, converging only when the gesture
 * pauses; this is what "the content lags and catches up" looks like. The
 * reconciler's own escape hatch forces the render and commit inline, so the
 * body's box moves in the same frame as the card that carries it.
 *
 * `Renderer` is documented as an unstable escape hatch, so the shape is
 * probed: a core that drops it degrades to the plain setState — laggy under
 * continuous input, never wrong.
 */
const flushSync: (fn: () => void) => void =
  typeof (Renderer as { flushSyncFromReconciler?: unknown })
    .flushSyncFromReconciler === 'function'
    ? (fn) =>
        void (
          Renderer as { flushSyncFromReconciler: (fn: () => void) => void }
        ).flushSyncFromReconciler(fn)
    : (fn) => fn();

/**
 * The GL renderer's module, once it has loaded — reached by dynamic
 * `import()` and never statically, so an application that never asks for
 * `renderer="gl"` bundles none of it.
 */
type GlModule = typeof import('./gl/index.js');

let glModule: GlModule | null = null;
let glLoading: Promise<GlModule> | null = null;

/** Load the GL renderer, once per process however many panes ask. A failed
 *  load is forgotten, so the next pane to ask tries again. */
function loadGl(): Promise<GlModule> {
  glLoading ??= import('./gl/index.js').then(
    (module) => (glModule = module),
    (error: unknown) => {
      glLoading = null;
      throw error;
    },
  );
  return glLoading;
}

interface FlowNodeBodyProps {
  type: FlowNodeType<unknown>;
  node: FlowNode<unknown>;
  selected: boolean;
  zoom: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The same node, as far as its body can tell: every field but `position`.
 *
 * Identity is not the test. A drag — and every commit of a controlled graph
 * — hands the pane a *new* node object each step with only its position
 * changed, so comparing identity called `render` on every step of every
 * drag: 60 renders with unchanged `data` in a 60-step drag, counted by
 * `examples/flow-stress.tsx`. Any other field that changes — `data`,
 * `selected`, `style`, a size — still re-renders, as it must.
 */
function sameButPosition(a: FlowNode<unknown>, b: FlowNode<unknown>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof FlowNode<unknown>)[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (key === 'position') continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * One mounted node body. Memoized so that a *move* re-renders nothing: a
 * drag or a pan changes only the overlay box's `left`/`top` — the body's
 * subtree keeps its identity and React commits a style-only update. The
 * compare deliberately ignores `x`/`y`, which is why `rect`'s position half
 * is documented as advisory: content re-renders when the node, its
 * selection, the zoom or its size change, and rides along otherwise.
 *
 * This is what makes a mounted node cost one box diff per drag step with no
 * memoisation asked of the app — its `render` is simply not called.
 */
const FlowNodeBody = React.memo(
  function FlowNodeBody(props: FlowNodeBodyProps): ReactElement {
    return props.type.render!({
      node: props.node,
      selected: props.selected,
      zoom: props.zoom,
      rect: {
        x: props.x,
        y: props.y,
        width: props.width,
        height: props.height,
      },
    }) as ReactElement;
  },
  (a, b) =>
    a.type === b.type &&
    sameButPosition(a.node, b.node) &&
    a.selected === b.selected &&
    a.zoom === b.zoom &&
    a.width === b.width &&
    a.height === b.height,
);

/**
 * A directed graph.
 *
 * ```tsx
 * const [nodes, setNodes, onNodesChange] = useNodesState([
 *   { id: 'a', position: { x: 0, y: 0 }, data: { label: 'read' } },
 *   { id: 'b', position: { x: 0, y: 120 }, data: { label: 'write' } },
 * ]);
 * const [edges, setEdges, onEdgesChange] = useEdgesState([
 *   { id: 'a-b', source: 'a', target: 'b' },
 * ]);
 *
 * <Flow
 *   nodes={nodes}
 *   edges={edges}
 *   onNodesChange={onNodesChange}
 *   onEdgesChange={onEdgesChange}
 *   onConnect={(c) => setEdges((es) => addEdge(c, es))}
 *   fitView
 *   minimap
 * />
 * ```
 *
 * Leave `nodes`/`edges` out and pass `defaultNodes`/`defaultEdges` for the
 * uncontrolled form, where the pane owns the arrays.
 */
export function Flow<N = FlowNodeData, E = unknown>(
  props: FlowProps<N, E>,
): ReactElement {
  const {
    nodes,
    defaultNodes,
    edges,
    defaultEdges,
    onNodesChange,
    onEdgesChange,
    onSelectionChange,
    onWheel,
    style,
    ref,
    renderer,
    onFrame,
    onError,
    ...rest
  } = props;

  const pane = useRef<FlowGraphNode | null>(null);

  const [ownNodes, setOwnNodes] = useState<readonly FlowNode<N>[]>(
    () => defaultNodes ?? [],
  );
  const [ownEdges, setOwnEdges] = useState<readonly FlowEdge<E>[]>(
    () => defaultEdges ?? [],
  );
  const controlledNodes = nodes !== undefined;
  const controlledEdges = edges !== undefined;
  const currentNodes = nodes ?? ownNodes;
  const currentEdges = edges ?? ownEdges;

  // The controlled/uncontrolled fork, and the whole of it: the pane always
  // *describes* a change, and who applies it is the only difference between
  // the two modes.
  const handleNodesChange = (changes: NodeChange<N>[]): void => {
    if (!controlledNodes) {
      setOwnNodes((current) => applyNodeChanges(changes, current));
    }
    onNodesChange?.(changes);
  };
  const handleEdgesChange = (changes: EdgeChange<E>[]): void => {
    if (!controlledEdges) {
      setOwnEdges((current) => applyEdgeChanges(changes, current));
    }
    onEdgesChange?.(changes);
  };

  useImperativeHandle(
    ref,
    (): FlowInstance => ({
      // Every method reads the node at call time rather than closing over
      // it: the ref attaches after the commit that created the node, and a
      // handle built once must still work for the whole mount.
      getViewport: () => pane.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 },
      setViewport: (viewport) => pane.current?.setViewport(viewport),
      zoomIn: (step) => pane.current?.zoomIn(step),
      zoomOut: (step) => pane.current?.zoomOut(step),
      zoomTo: (zoom) => pane.current?.zoomTo(zoom),
      fitView: (options) => pane.current?.fitView(options),
      setCenter: (x, y, options) => pane.current?.setCenter(x, y, options),
      screenToFlowPosition: (point) =>
        pane.current?.screenToFlowPosition(point) ?? point,
      flowToScreenPosition: (point) =>
        pane.current?.flowToScreenPosition(point) ?? point,
      getNodeBounds: (id) => pane.current?.getNodeBounds(id) ?? null,
      getNodesBounds: (ids) => pane.current?.getNodesBounds(ids) ?? null,
    }),
    [],
  );

  // Selection lives in the arrays, so "it changed" is a question about them
  // and not a second source of truth to keep in step.
  const selectionKey = useMemo(() => {
    const parts: string[] = [];
    for (const node of currentNodes)
      if (node.selected) parts.push(`n:${node.id}`);
    for (const edge of currentEdges)
      if (edge.selected) parts.push(`e:${edge.id}`);
    return parts.join('|');
  }, [currentNodes, currentEdges]);

  const latest = useRef({ onSelectionChange, currentNodes, currentEdges });
  useEffect(() => {
    latest.current = { onSelectionChange, currentNodes, currentEdges };
  });
  useEffect(() => {
    const {
      onSelectionChange: notify,
      currentNodes: ns,
      currentEdges: es,
    } = latest.current;
    notify?.({
      nodes: ns.filter((n) => n.selected),
      edges: es.filter((e) => e.selected),
    });
    // Only when the selection itself changed: the arrays are rebuilt by
    // every drag step, and re-notifying then would make a drag a storm.
  }, [selectionKey]);

  const flat = flattenStyle(style ?? null);
  const sized =
    flat.height !== undefined ||
    flat.flexGrow !== undefined ||
    flat.flexBasis !== undefined;

  // --- mounted node bodies ------------------------------------------------
  //
  // Only the node types that asked for one cost anything: with no `render`
  // in the registry the pane is never given `onNodeBodies`, never computes a
  // rect, and this half of the component is one `useState` that stays empty.
  const { nodeTypes } = rest;
  const mounts = useMemo(
    () =>
      nodeTypes
        ? Object.values(nodeTypes).some((type) => type?.render != null)
        : false,
    [nodeTypes],
  );
  const [bodies, setBodies] = useState<readonly NodeBodyRect[]>([]);
  // Where the graph's origin sits in the pane. The bodies are laid out in
  // one box placed here, so a pan — which moves this and nothing else — is
  // one style change rather than a render of every body.
  const [origin, setOrigin] = useState<XYPosition>({ x: 0, y: 0 });
  // Gesture-time emissions commit inline (see `flushSync` above); the rest —
  // a programmatic `fitView`, the first paint — take the ordinary path.
  const handleBodies = (
    next: readonly NodeBodyRect[],
    sync: boolean,
    at: XYPosition,
  ): void => {
    const apply = (): void => {
      // the same array on a pan: React bails out of this update
      setBodies(next);
      setOrigin((was) => (was.x === at.x && was.y === at.y ? was : at));
    };
    if (sync) flushSync(apply);
    else apply();
  };
  const byId = useMemo(() => {
    const map = new Map<string, FlowNode<N>>();
    if (mounts) for (const node of currentNodes) map.set(node.id, node);
    return map;
  }, [mounts, currentNodes]);

  // The box the bodies are laid out in covers exactly them. It has to have a
  // real size: core culls a child whose *own* box is off screen or outside
  // a clipping ancestor before it looks at the child's subtree, and a 0×0
  // box at the graph's origin is off screen whenever the graph has been
  // panned past the pane's top-left — which took every body with it.
  const extent = useMemo(() => {
    if (bodies.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const body of bodies) {
      x0 = Math.min(x0, body.x);
      y0 = Math.min(y0, body.y);
      x1 = Math.max(x1, body.x + body.width);
      y1 = Math.max(y1, body.y + body.height);
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }, [bodies]);

  // Memoized on the bodies array, which a pan does not replace: the box they
  // sit in moves, and React reconciles none of them.
  const overlays = useMemo(
    () =>
      mounts
        ? bodies.map((body) => {
            const node = byId.get(body.id);
            const type = node && nodeTypes?.[node.type ?? 'default'];
            if (!node || !type?.render) return null;
            // The two boxes are two units. The outer one is the pane's: it is
            // positioned and clipped in the same logical window pixels the pane
            // painted the card in, so the body lands on the card exactly. The
            // inner one is the body's, and `scale` is what makes the difference
            // between them the zoom (react-x11#449, core 2.6): every length
            // under it is multiplied by that factor, so a body sized in graph
            // units comes out at the size the card is drawn at, with its text
            // shaped at that size rather than stretched.
            const width = body.width / body.zoom;
            const height = body.height / body.zoom;
            return React.createElement(
              'box',
              {
                key: body.id,
                style: {
                  position: 'absolute',
                  left: body.x - extent.x,
                  top: body.y - extent.y,
                  width: body.width,
                  height: body.height,
                  // A body is free to overflow what it was given — a popup's
                  // fallback, a long line — and this is what stops it spilling
                  // over the graph.
                  overflow: 'hidden',
                },
              },
              React.createElement(
                'box',
                {
                  scale: body.zoom,
                  // Sized in the unit it establishes, which is what makes it
                  // fill the outer box at every zoom.
                  style: { width, height },
                },
                React.createElement(FlowNodeBody, {
                  type: type as FlowNodeType<unknown>,
                  node: node as FlowNode<unknown>,
                  selected: body.selected,
                  zoom: body.zoom,
                  // Graph units, like everything else the body sees.
                  x: body.x / body.zoom,
                  y: body.y / body.zoom,
                  width,
                  height,
                }),
              ),
            );
          })
        : null,
    [mounts, bodies, extent, byId, nodeTypes],
  );
  const layer =
    overlays && overlays.length > 0
      ? React.createElement(
          'box',
          {
            key: 'bodies',
            style: {
              position: 'absolute',
              left: origin.x + extent.x,
              top: origin.y + extent.y,
              width: extent.width,
              height: extent.height,
            },
          },
          overlays,
        )
      : null;

  // --- the GL surface -----------------------------------------------------
  //
  // Loaded when it is asked for and not before — see `./gl/index.ts` for why
  // the import is dynamic. Until it arrives, and for good once it has failed,
  // the pane draws itself: `renderer` reaches the element only while a
  // surface is there to draw, so there is never a frame with neither.
  const theme = useTheme();
  const wantGl = renderer === 'gl';
  const [gl, setGl] = useState<GlModule | null>(glModule);
  const [glFailed, setGlFailed] = useState(false);
  const latestError = useRef(onError);
  latestError.current = onError;
  const failGl = useMemo(
    () =>
      (error: Error): void => {
        setGlFailed(true);
        latestError.current?.(error);
      },
    [],
  );
  useEffect(() => {
    if (!wantGl || gl || glFailed) return;
    let live = true;
    loadGl().then(
      (module) => {
        if (live) setGl(module);
      },
      (error: unknown) => {
        if (live)
          failGl(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      live = false;
    };
  }, [wantGl, gl, glFailed]);
  const drawsGl = wantGl && gl != null && !glFailed;
  const surface = drawsGl
    ? React.createElement(gl.FlowGlSurface, {
        key: 'gl',
        pane,
        clearColor: resolvePalette(
          theme as unknown as Record<string, unknown> | null,
          rest.palette,
        ).background,
        onFrame: onFrame,
        onError: failGl,
        // A `<glarea>`'s children are drawn over its surface, so that is
        // where the bodies go under GL — beside the pane, they would be
        // under it.
        children: layer,
      })
    : null;

  // The pane and the bodies are siblings rather than parent and children:
  // a registered element's own drawing happens *after* `super.paint` has
  // painted its children, so anything mounted inside the pane would be
  // painted over by the graph. Beside it, and after it, they land on top.
  return React.createElement(
    'box',
    { style: sized ? [styles.clip, style] : [styles.pane, style] },
    React.createElement(ELEMENT, {
      ...rest,
      key: 'pane',
      ref: pane,
      nodes: currentNodes,
      edges: currentEdges,
      onNodesChange: handleNodesChange,
      onEdgesChange: handleEdgesChange,
      // The wheel and hover reach the element through the default-action
      // seam now (react-x11#302): an app's own `onWheel` runs first and
      // `preventDefault()` vetoes, with no forwarding here — and the bare
      // `<flowgraph>` element zooms and hovers on its own.
      onWheel,
      onNodeBodies: mounts ? handleBodies : undefined,
      renderer: drawsGl ? 'gl' : undefined,
      // the element reports the 2D renderer's frames, the surface the GL
      // one's — one callback either way
      onFrame,
      style: styles.fill,
      role: 'group',
      'aria-label': rest['aria-label'] ?? 'Flow graph',
    }),
    // After the pane, so the surface covers exactly its box — and with the
    // bodies inside it under GL, or beside the pane without.
    surface,
    drawsGl ? null : layer,
  );
}

/**
 * `useState` for nodes, with the change handler `<Flow>` wants already
 * bound — react-flow's hook of the same name, and the shortest correct way
 * to hold a graph.
 *
 * ```tsx
 * const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
 * ```
 */
export function useNodesState<N = FlowNodeData>(
  initial: readonly FlowNode<N>[],
): [
  FlowNode<N>[],
  Dispatch<SetStateAction<FlowNode<N>[]>>,
  (changes: NodeChange<N>[]) => void,
] {
  const [nodes, setNodes] = useState<FlowNode<N>[]>(() => [...initial]);
  const onNodesChange = useRef((changes: NodeChange<N>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }).current;
  return [nodes, setNodes, onNodesChange];
}

/** {@link useNodesState} for edges. */
export function useEdgesState<E = unknown>(
  initial: readonly FlowEdge<E>[],
): [
  FlowEdge<E>[],
  Dispatch<SetStateAction<FlowEdge<E>[]>>,
  (changes: EdgeChange<E>[]) => void,
] {
  const [edges, setEdges] = useState<FlowEdge<E>[]>(() => [...initial]);
  const onEdgesChange = useRef((changes: EdgeChange<E>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }).current;
  return [edges, setEdges, onEdgesChange];
}

/** The host element name, for apps that would rather write `<flowgraph>`.
 * The raw element is the whole component minus the controlled/uncontrolled
 * fork and the wheel and hover wiring, which have no default-action seam. */
export { ELEMENT as FLOW_ELEMENT, FlowGraphNode };

export {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  connectedEdges,
  connectionId,
  resolvePalette,
} from './model.js';

export type {
  BackgroundOptions,
  BackgroundVariant,
  Connection,
  ConnectionStart,
  ControlsOptions,
  EdgeAppearance,
  EdgeChange,
  EdgeMarker,
  EdgeMouseHandler,
  EdgeType,
  FitViewOptions,
  FlowEdge,
  FlowFrameStats,
  FlowInstance,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  FlowPainter,
  FlowPalette,
  FlowProps,
  FlowRect,
  HandleAnchor,
  HandlePosition,
  HandleSpec,
  HandleType,
  MarkerType,
  MiniMapOptions,
  NodeAppearance,
  NodeBodyRect,
  NodeChange,
  NodeMouseHandler,
  NodePaintContext,
  NodeRenderContext,
  PanePosition,
  ShapeOptions,
  StrokeOptions,
  TextOptions,
  Viewport,
  XYPosition,
} from './types.js';

// Importing this module teaches JSX the element too, so `<flowgraph>` is a
// typed tag rather than an error — the module-augmentation shape react-x11's
// docs/typescript.md prescribes for a third-party element.
declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      flowgraph: FlowProps<unknown, unknown>;
    }
  }
}
