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
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Dispatch, ReactElement, SetStateAction } from 'react';
import { Renderer, useApp, useScale, useSupports, useTheme } from 'react-x11';
import { registerElement, registeredElements } from 'react-x11/host';
import { createStyles, flattenStyle } from 'react-x11/style';
// Loads the module the JSX augmentation at the bottom targets: nothing in
// `src/` writes JSX, so without this the build program never resolves
// `react-x11/jsx-runtime` and the augmentation is an error rather than an
// addition. Type-only, so it is erased.
import type {} from 'react-x11/jsx-runtime';

import { applyEdgeChanges, applyNodeChanges, resolvePalette } from './model.js';
import { CULL_MARGIN } from './scene.js';
import { ELEMENT, FlowGraphNode, SELF_DAMAGED_PROPS } from './node.js';
import type {
  EdgeChange,
  FlowEdge,
  FlowInstance,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  FlowProps,
  FlowRect,
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
  // Over the pane, holding the bodies' layer and clipping it to the pane:
  // a 2D pan carries the layer's pixels in its blit, and what the layer can
  // paint outside the pane — in the border round it — would be repainted
  // on every step (`_blitPan` in ./node.ts).
  bodiesClip: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    pointerEvents: 'box-none',
  },
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

/** How far a card's handles and grips ink outside its box — the canvas
 *  its card is painted on in the bodies' layer reaches that far round it. */
const CARD_INK = CULL_MARGIN;

/** The grid the bodies' layer grows to, in logical pixels. Every card is
 *  placed relative to the layer's corner, so a corner that followed the
 *  cards exactly moved — and moved every card with it — whenever the one
 *  being dragged was the outermost; grown to this grid it moves only when
 *  a card crosses a line of it. */
const EXTENT_STEP = 256;

/** A number per object, for a card's cache key: a style or a handle list
 *  that changed is a new object, and its card is painted again. */
const serials = new WeakMap<object, number>();
let serial = 0;
function serialOf(node: object): number {
  let n = serials.get(node);
  if (n === undefined) serials.set(node, (n = ++serial));
  return n;
}

/**
 * What of a node its card draws, for the card's cache key: the label, the
 * description, the style and the handles. A body's own data — a queue
 * length, a chart's points — is none of it: keyed on the node object, a
 * live body that patched its data repainted its card on every patch, the
 * title's text shaped and drawn again for nothing. A type that paints its
 * own card may draw anything of the node, so it is keyed on the node whole.
 */
function cardShows(
  node: FlowNode<unknown>,
  type: FlowNodeType<unknown>,
): string {
  if (type.paint) return `n${serialOf(node)}`;
  const data = node.data as FlowNodeData | undefined;
  const style = node.style ? serialOf(node.style) : 0;
  const handles = node.handles ? serialOf(node.handles) : 0;
  return (
    `${style}:${handles}:${String(data?.label ?? '')}` +
    `\u0000${String(data?.description ?? '')}`
  );
}

/** What `forwardWheel` reads off a wheel that landed on a body. */
interface WheelLike {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  defaultPrevented?: boolean;
  preventDefault(): void;
  target?: WheelTarget;
}
interface WheelTarget {
  parent?: WheelTarget | null;
  scale?: number;
  kind?: string;
  props?: Record<string, unknown>;
  style?: { cursor?: string };
  canScroll?(dx: number, dy: number): boolean;
}

/** What `forwardPress` reads off a press, a drag step or a release. */
interface PressLike extends WheelLike {
  button?: number;
  capturePointer?(): void;
}

/** The pane's half of a pointer gesture, as `forwardPress` drives it. */
interface PressSink {
  scale?: number;
  parent?: unknown;
  defaultMouseDown?(ev: never): void;
  defaultMouseDrag?(ev: never): void;
  defaultMouseUp?(ev: never): void;
}

/** Roles a press means something to — the body keeps those presses. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'tab',
  'link',
  'scrollbar',
]);

/**
 * Whether a press on `n` is the body's own: a control, something that
 * listens for the press, something whose cursor says it can be clicked or
 * typed into, or something that scrolls. Everything else in a body — its
 * padding, a label, a progress bar — is the card, and a press there is the
 * card's: it selects and drags the node, as it would on a card with no body.
 */
function interactive(n: WheelTarget): boolean {
  const props = n.props ?? {};
  if (
    typeof props.onMouseDown === 'function' ||
    typeof props.onClick === 'function' ||
    typeof props.onPress === 'function' ||
    typeof props.onChange === 'function' ||
    typeof props.onMouseUp === 'function'
  ) {
    return true;
  }
  if (typeof props.role === 'string' && INTERACTIVE_ROLES.has(props.role)) {
    return true;
  }
  if (typeof props.tabIndex === 'number' && props.tabIndex >= 0) return true;
  const cursor = n.style?.cursor;
  if (cursor === 'pointer' || cursor === 'text') return true;
  if (n.kind === 'textinput' || n.kind === 'textarea') return true;
  return Boolean(n.canScroll?.(0, 1) || n.canScroll?.(1, 0));
}

/** The event as the pane reads it: its coordinates taken out of the unit of
 *  the body they landed in (`scale`, the zoom) and into the window's. */
function inPaneUnits<E extends WheelLike>(ev: E, sink: PressSink): E {
  const ratio = (ev.target?.scale ?? 1) / (sink.scale || 1);
  return Object.assign(Object.create(ev) as E, {
    x: ev.x * ratio,
    y: ev.y * ratio,
  });
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

/** What one mounted card is drawn from — see {@link FlowBodyCard}. */
interface FlowBodyCardProps {
  body: NodeBodyRect;
  node: FlowNode<unknown>;
  type: FlowNodeType<unknown>;
  /** The card's box in the layer it sits in, on the device-pixel grid. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** The card's fill, which its body's box takes too. */
  fill: string;
  cacheKey: string;
  /** One per card for as long as what paints cards holds (`drawCard`). */
  onDraw: (ctx: unknown, info: { node: { abs: XYPosition } }) => void;
  /** Where each card is the surface's child in its own right (no layer),
   *  where the layer would have put it, whether it sits a zoom out, and
   *  the forwarding it does for itself. */
  offsetX?: number;
  offsetY?: number;
  hidden?: boolean;
  handlers?: Record<string, (ev: unknown) => void>;
}

/**
 * One mounted node: its card, painted by the pane's own 2D painter
 * (`FlowGraphNode.paintCard`), and its body over it. A component of its own
 * so that React can skip it: every prop is a value or a reference that
 * holds while the card does, and a drag re-renders the card that moved.
 */
const FlowBodyCard = React.memo(function FlowBodyCard(
  props: FlowBodyCardProps,
): ReactElement {
  const { body, node, type } = props;
  const { card } = body;
  // The two boxes are two units. The outer one is the pane's: it is
  // positioned and clipped in the same logical window pixels the pane
  // painted the card in, so the body lands on the card exactly. The inner
  // one is the body's, and `scale` is what makes the difference between
  // them the zoom (react-x11#449, core 2.6): every length under it is
  // multiplied by that factor, so a body sized in graph units comes out at
  // the size the card is drawn at, with its text shaped at that size rather
  // than stretched.
  const width = body.width / body.zoom;
  const height = body.height / body.zoom;
  const bodyBox = React.createElement(
    'box',
    {
      key: 'body',
      style: {
        position: 'absolute',
        left: body.x - card.x + CARD_INK,
        top: body.y - card.y + CARD_INK,
        width: body.width,
        height: body.height,
        // A body is free to overflow what it was given — a popup's
        // fallback, a long line — and this is what stops it spilling over
        // the graph.
        overflow: 'hidden',
        // Opaque, in the card's own fill: the card painted under it shows
        // none of what a transparent body would let through.
        backgroundColor: props.fill,
      },
    },
    React.createElement(
      'box',
      {
        scale: body.zoom,
        // Sized in the unit it establishes, which is what makes it fill the
        // outer box at every zoom.
        style: { width, height },
      },
      React.createElement(FlowNodeBody, {
        type,
        node,
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
  // The card, just under its body: the bodies share one layer over every
  // card the graph draws, so without it a body covered the header, border
  // and handles of any card over its own.
  const cardCanvas = React.createElement('canvas', {
    key: 'card',
    style: {
      position: 'absolute',
      left: 0,
      top: 0,
      width: card.width + CARD_INK * 2,
      height: card.height + CARD_INK * 2,
      pointerEvents: 'none',
    },
    cacheKey: props.cacheKey,
    onDraw: props.onDraw,
  });
  return React.createElement(
    'box',
    {
      style: {
        position: 'absolute',
        left: props.left + (props.offsetX ?? 0),
        top: props.top + (props.offsetY ?? 0),
        width: props.width,
        height: props.height,
        // the card's presses are the pane's; its body's are the body's
        pointerEvents: 'box-none',
        ...(props.hidden === undefined
          ? null
          : { display: props.hidden ? 'none' : 'flex' }),
      },
      ...props.handlers,
    },
    cardCanvas,
    bodyBox,
  );
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
    renderer,
    onFrame,
    onError,
    ...rest
  } = props;

  const pane = useRef<FlowGraphNode | null>(null);
  // whether the surface draws the graph, as of the last render — read by a
  // layout effect declared before the surface is decided
  const drawsGlRef = useRef(false);

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
  // Hidden while a zoom moves, and nothing else about them touched — see
  // `_holdBodies` in ./node.ts for what re-scaling them every step cost.
  const [held, setHeld] = useState(false);
  // Where the minimap and controls are, painted over the bodies when there
  // are any to be over.
  const [panels, setPanels] = useState<readonly FlowRect[]>([]);
  const panelCanvases = useRef<
    ({
      invalidate(layout: boolean, damage: unknown, reason: string): void;
    } | null)[]
  >([]);
  // Gesture-time emissions commit inline (see `flushSync` above); the rest —
  // a programmatic `fitView`, the first paint — take the ordinary path.
  const handleBodies = (
    next: readonly NodeBodyRect[],
    sync: boolean,
    at: XYPosition,
    hold: boolean,
  ): void => {
    const apply = (): void => {
      // the same array on a pan: React bails out of this update
      setBodies(next);
      setOrigin((was) => (was.x === at.x && was.y === at.y ? was : at));
      setHeld(hold);
    };
    if (sync) flushSync(apply);
    else apply();
  };
  const byId = useMemo(() => {
    const map = new Map<string, FlowNode<N>>();
    if (mounts) for (const node of currentNodes) map.set(node.id, node);
    return map;
  }, [mounts, currentNodes]);

  // Every box the bodies are laid out in sits on the device-pixel grid.
  // Layout rounds a box's two edges to whole device pixels separately, so at
  // a fractional scale (1.25, 1.5) a box that moved by a fraction of a
  // device pixel also changed size by one — and core moves a `<glarea>`
  // child's pixels on its pane only when it moved and nothing else
  // (sidorares/react-x11#644): a pan over bodies repainted every one of
  // them, every step. On the grid, a pan moves the layer by whole pixels
  // and every card in it by exactly as many.
  const rootScale = useScale();
  // the pane's own, where it is mounted: a `scale` prop above it counts
  const deviceScale = pane.current?.scale ?? rootScale;
  const snap = (v: number): number => Math.round(v * deviceScale) / deviceScale;

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
    for (const { card } of bodies) {
      x0 = Math.min(x0, card.x - CARD_INK);
      y0 = Math.min(y0, card.y - CARD_INK);
      x1 = Math.max(x1, card.x + card.width + CARD_INK);
      y1 = Math.max(y1, card.y + card.height + CARD_INK);
    }
    const out = (v: number, up: boolean): number =>
      snap((up ? Math.ceil : Math.floor)(v / EXTENT_STEP) * EXTENT_STEP);
    x0 = out(x0, false);
    y0 = out(y0, false);
    x1 = out(x1, true);
    y1 = out(y1, true);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }, [bodies, deviceScale]);

  // The fill a card is drawn in, which its body's box takes too.
  const theme = useTheme();
  const nodeFill = resolvePalette(
    theme as unknown as Record<string, unknown> | null,
    rest.palette,
  ).nodeBackground;

  // One `onDraw` per card for as long as what paints cards holds: core
  // repaints a canvas whose `onDraw` is a new function (react-x11
  // src/nodes/canvas.js), and a closure made per render made every step of
  // a drag repaint every card on screen and every body over them — 36
  // claims, past the frame's rect cap, one rect the size of the pane. What a
  // card shows is in its `cacheKey`; the palette, the theme and the node
  // types are what paint it, and a change to any of them starts over.
  const cardPaint = useMemo(
    () => ({
      drawers: new Map<
        string,
        (ctx: unknown, info: { node: { abs: XYPosition } }) => void
      >(),
    }),
    [theme, rest.palette, nodeTypes],
  );
  const drawCard = (
    id: string,
  ): ((ctx: unknown, info: { node: { abs: XYPosition } }) => void) => {
    let draw = cardPaint.drawers.get(id);
    if (!draw) {
      draw = (ctx, info) => pane.current?.paintCard(id, ctx, info.node.abs);
      cardPaint.drawers.set(id, draw);
    }
    return draw;
  };

  // One card per body, each a memoized component: a drag step moves one
  // card and hands the others the same props they had — the same body
  // object (`_emitBodies` reuses it), the same node object, the same
  // `onDraw` — so React re-renders the card that moved and bails out of the
  // rest. Built as one element list per render, which a pan does not
  // trigger: the box they sit in moves, and nothing here is asked.
  const cards = useMemo(() => {
    if (!mounts) return null;
    const out: FlowBodyCardProps[] = [];
    for (const body of bodies) {
      const node = byId.get(body.id);
      const type = node && nodeTypes?.[node.type ?? 'default'];
      if (!node || !type?.render) continue;
      const { card } = body;
      // on the grid, like the layer (`snap` above)
      const left = snap(card.x - CARD_INK);
      const top = snap(card.y - CARD_INK);
      out.push({
        body,
        node: node as FlowNode<unknown>,
        type: type as FlowNodeType<unknown>,
        left: left - extent.x,
        top: top - extent.y,
        // Sized from the card alone, not as the gap between two edges each
        // put on the grid: at 1.25x a card dragged a fraction of a pixel
        // grew or shrank by one as its edges rounded apart, and a box that
        // changed size is no longer a box that only moved — every step of
        // a drag measured the content floors and repainted the card where
        // core would have moved it. The box draws nothing and takes no
        // pointer; the canvas and the body inside it keep sizes of their
        // own.
        width: snap(card.width + CARD_INK * 2),
        height: snap(card.height + CARD_INK * 2),
        fill:
          (node.style as { background?: string } | undefined)?.background ??
          nodeFill,
        // Cached until something it shows changes (`cardShows`): a new
        // label or style repaints it, a body's own data does not.
        cacheKey:
          `${body.id}:${cardShows(node as FlowNode<unknown>, type as FlowNodeType<unknown>)}:` +
          `${card.width}x${card.height}:` +
          `${body.zoom}:${body.selected}:${body.hovered}:` +
          `${serialOf(cardPaint)}`,
        onDraw: drawCard(body.id),
      });
    }
    return out;
  }, [
    mounts,
    bodies,
    extent,
    byId,
    nodeTypes,
    nodeFill,
    deviceScale,
    cardPaint,
  ]);
  const overlays = cards?.map((props) =>
    React.createElement(FlowBodyCard, { key: props.body.id, ...props }),
  );
  // A wheel over a body is a wheel over the graph. Core runs the wheel's
  // default action on the node under the pointer and scrolls up from there,
  // and the bodies are the pane's siblings, not its children — so over a
  // card's body the pane never heard it, and zooming a graph whose cards
  // are mostly bodies stalled wherever the pointer rested. Forwarded unless
  // something between the pointer and the pane can scroll that way itself:
  // a list inside a card keeps its wheel.
  const forwardWheel = useMemo(
    () =>
      (ev: unknown): void => {
        const node = pane.current;
        const wheel = ev as WheelLike;
        if (!node || wheel.defaultPrevented) return;
        const stop = node.parent;
        for (
          let n: WheelTarget | null | undefined = wheel.target;
          n && n !== (stop as unknown);
          n = n.parent
        ) {
          if (n.canScroll?.(wheel.deltaX, wheel.deltaY)) return;
        }
        node.defaultWheel(inPaneUnits(wheel, node) as never);
        wheel.preventDefault();
      },
    [],
  );
  // A press on a body's card-like part is a press on the card. Core runs a
  // press's default actions — select, drag, and the drag's steps and
  // release — on the node that took it, so a body took them all: the cards
  // of a graph whose nodes are mostly body could not be selected or dragged
  // by most of their area. A press that bubbles up here from something that
  // is not a control is the pane's instead: its default is vetoed on the
  // body, the pointer captured so the drag and the release come back here
  // wherever they wander, and each step handed to the pane.
  const pressing = useRef(false);
  const forwardPress = useMemo(() => {
    // From the pressed node up to the bodies' box — which listens for the
    // press itself, and is where the walk stops.
    const within = (ev: PressLike, sink: PressSink): boolean => {
      for (
        let n: WheelTarget | null | undefined = ev.target;
        n && n !== (sink.parent as unknown);
        n = n.parent
      ) {
        if (n.props?.onMouseDown === handlers.onMouseDown) return true;
        if (interactive(n)) return false;
      }
      return true;
    };
    const handlers = {
      onMouseDown: (ev: unknown): void => {
        const press = ev as PressLike;
        const sink = pane.current as unknown as PressSink | null;
        if (!sink || press.defaultPrevented || (press.button ?? 1) !== 1)
          return;
        if (!within(press, sink)) return;
        pressing.current = true;
        press.preventDefault();
        press.capturePointer?.();
        sink.defaultMouseDown?.(inPaneUnits(press, sink) as never);
      },
      onMouseMove: (ev: unknown): void => {
        if (!pressing.current) return;
        const sink = pane.current as unknown as PressSink | null;
        sink?.defaultMouseDrag?.(inPaneUnits(ev as PressLike, sink) as never);
      },
      onMouseUp: (ev: unknown): void => {
        if (!pressing.current) return;
        pressing.current = false;
        const sink = pane.current as unknown as PressSink | null;
        sink?.defaultMouseUp?.(inPaneUnits(ev as PressLike, sink) as never);
      },
    };
    return handlers;
  }, []);
  // what each card forwards on its own where it is the surface's child
  const directHandlers = useMemo(
    () => ({ onWheel: forwardWheel, ...forwardPress }),
    [forwardWheel, forwardPress],
  );
  const bodiesLayer = useRef<unknown>(null);
  const layer =
    overlays && overlays.length > 0
      ? React.createElement(
          'box',
          {
            key: 'bodies',
            ref: bodiesLayer,
            style: {
              position: 'absolute',
              left: snap(origin.x) + extent.x,
              top: snap(origin.y) + extent.y,
              width: extent.width,
              height: extent.height,
              // The box spans every body, the gaps between them and the
              // cards' headers with them — taking the pointer itself, it ate
              // every press in that span: no pan, no pane click, no selecting
              // a node by its header. Its bodies take the pointer; it does not.
              pointerEvents: 'box-none',
              // held through a zoom gesture: see `_holdBodies` in ./node.ts
              display: held ? 'none' : 'flex',
            },
            onWheel: forwardWheel,
            ...forwardPress,
          },
          overlays,
        )
      : null;

  // The box a 2D pan carries along with the pane's pixels (`_blitPan`).
  useLayoutEffect(() => {
    pane.current?.setBodiesLayer(
      drawsGlRef.current ? null : bodiesLayer.current,
    );
  });

  // The cards whose canvases are on screen, told to the pane once they are,
  // so it stops drawing them itself — and the empty set while bodies are
  // held out of a zoom, when their cards are the graph's again.
  useLayoutEffect(() => {
    const shown = new Set<string>();
    if (mounts && !held) for (const body of bodies) shown.add(body.id);
    pane.current?.setShownBodies(shown);
  }, [mounts, held, bodies]);

  // The minimap and the controls over the bodies: the bodies' layer is over
  // the graph, so panels the graph drew went under any card that reached
  // them. Painted by the pane (`paintPanels`) on canvases after the layer,
  // which take no pointer — a press on a button is the pane's, as before.
  const panelLayer =
    mounts && panels.length > 0
      ? panels.map((rect, i) =>
          React.createElement('canvas', {
            key: `panel-${i}`,
            ref: (
              node: {
                invalidate(
                  layout: boolean,
                  damage: unknown,
                  reason: string,
                ): void;
              } | null,
            ) => {
              panelCanvases.current[i] = node;
            },
            style: {
              position: 'absolute',
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              pointerEvents: 'none',
            },
            onDraw: (ctx: unknown, info: { node: { abs: FlowRect } }) =>
              pane.current?.paintPanels(ctx, info.node.abs),
          }),
        )
      : null;
  useLayoutEffect(() => {
    const live = panelCanvases.current
      .slice(0, panelLayer?.length ?? 0)
      .filter((c) => c != null);
    pane.current?.setPanelCanvases(live);
  }, [panelLayer?.length, panels]);

  // On X11 a <glarea>'s children are not composited over its frame: each
  // child gets an opaque child window, as big as the region it reaches,
  // filled with the surface's clear colour (react-x11's src/gloverlay.js).
  // The bodies' one box reaches every card and the gaps between them, so it
  // became one window over the whole view: cards and bodies, and not one
  // edge. There each card is the surface's child in its own right, placed
  // at the origin itself, and a pane covers a card and nothing more. Where
  // panes composite (Cocoa) the one box stays — a pan moves it alone.
  const app = useApp() as { createOverlayPane?: unknown } | null;
  const composited = typeof app?.createOverlayPane === 'function';
  // …and on XQuartz not shown at all: the macOS window server composites
  // every GL surface there above everything the X server draws, panes
  // included. Core says so (`useSupports('glOverlay')` false, from the first
  // render — sidorares/react-x11#653), and there a graph whose node types
  // mount bodies draws with the 2D renderer: for as long as the pane lives,
  // not per zoom, so the surface does not come and go as bodies mount.
  const overlaySupported = useSupports('glOverlay');
  const cardsDirect: ReactElement[] = [];
  if (cards && !composited) {
    const offsetX = snap(origin.x) + extent.x;
    const offsetY = snap(origin.y) + extent.y;
    for (const props of cards) {
      cardsDirect.push(
        React.createElement(FlowBodyCard, {
          key: props.body.id,
          ...props,
          offsetX,
          offsetY,
          hidden: held,
          handlers: directHandlers,
        }),
      );
    }
  }

  // --- the GL surface -----------------------------------------------------
  //
  // Loaded when it is asked for and not before — see `./gl/index.ts` for why
  // the import is dynamic. Until it arrives, and for good once it has failed,
  // the pane draws itself: `renderer` reaches the element only while a
  // surface is there to draw, so there is never a frame with neither.
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
  const drawsGl =
    wantGl && gl != null && !glFailed && !(mounts && !overlaySupported);
  drawsGlRef.current = drawsGl;
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
        children: composited
          ? [layer, panelLayer]
          : [cardsDirect.length > 0 ? cardsDirect : null, panelLayer],
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
      onPanels: mounts ? setPanels : undefined,
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
    drawsGl || !layer
      ? null
      : React.createElement(
          'box',
          { key: 'bodies-clip', style: styles.bodiesClip },
          layer,
        ),
    drawsGl ? null : panelLayer,
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
  FlowBodyBudget,
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
