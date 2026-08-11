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
import { registerElement, registeredElements } from 'react-x11/host';
import { createStyles, flattenStyle } from 'react-x11/style';
import type { DrawnNode, MouseEvent, WheelEvent } from 'react-x11';

// Loads the module the JSX augmentation at the bottom targets: nothing in
// `src/` writes JSX, so without this the build program never resolves
// `react-x11/jsx-runtime` and the augmentation is an error rather than an
// addition. Type-only, so it is erased.
import type {} from 'react-x11/jsx-runtime';

import { applyEdgeChanges, applyNodeChanges } from './model.js';
import { ELEMENT, FlowGraphNode } from './node.js';
import type {
  EdgeChange,
  FlowEdge,
  FlowInstance,
  FlowNode,
  FlowNodeData,
  FlowProps,
  NodeBodyRect,
  NodeChange,
} from './types.js';

if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new FlowGraphNode(props, app),
    // No `semanticNames`: not one of this element's prop names is also a
    // style name, and `test/flow.test.ts` is what keeps that true — the
    // failure it guards against (throws in development, works in
    // production) is the worst shape a bug can have.
    childrenAllowed: false,
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

  const handleWheel = (ev: WheelEvent<DrawnNode>): void => {
    onWheel?.(ev);
    // The same veto the default-action seam gives every other gesture; the
    // wheel just has no seam of its own to route through.
    if (!ev.defaultPrevented) pane.current?.handleWheel(ev);
  };
  const handleMouseMove = (ev: MouseEvent<DrawnNode>): void => {
    pane.current?.handleHover(ev);
  };
  const handleMouseLeave = (): void => {
    pane.current?.handleLeave();
  };

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
  const byId = useMemo(() => {
    const map = new Map<string, FlowNode<N>>();
    if (mounts) for (const node of currentNodes) map.set(node.id, node);
    return map;
  }, [mounts, currentNodes]);

  const overlays = mounts
    ? bodies.map((body) => {
        const node = byId.get(body.id);
        const type = node && nodeTypes?.[node.type ?? 'default'];
        if (!node || !type?.render) return null;
        return React.createElement(
          'box',
          {
            key: body.id,
            style: {
              position: 'absolute',
              left: body.x,
              top: body.y,
              width: body.width,
              height: body.height,
              // The box follows the zoom; what is inside it does not, so
              // this is what stops a zoomed-out node spilling its form over
              // the graph.
              overflow: 'hidden',
            },
          },
          type.render({
            node,
            selected: body.selected,
            zoom: body.zoom,
            rect: {
              x: body.x,
              y: body.y,
              width: body.width,
              height: body.height,
            },
          }),
        );
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
      onWheel: handleWheel,
      onMouseMove: handleMouseMove,
      onMouseLeave: handleMouseLeave,
      onNodeBodies: mounts ? setBodies : undefined,
      style: styles.fill,
      role: 'group',
      'aria-label': rest['aria-label'] ?? 'Flow graph',
    }),
    overlays,
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
