// The vocabulary `<Flow>` speaks. Deliberately close to react-flow's, so
// that a graph described for one describes the same graph for the other:
// nodes carry a position and free-form `data`, edges name a source and a
// target, and every mutation reaches the app as a *change* it applies to its
// own state (see `./model.ts`).
//
// Three names differ, and only because the barrel already owns them or
// because they are too generic to put in it:
//
//   react-flow          here
//   ------------------  ------------------
//   Position            HandlePosition   (`Position` is the editor's line/ch)
//   Rect                FlowRect
//   ReactFlowInstance   FlowInstance
//
// Nothing in this file has a runtime half, so it costs no bundle.
import type { Ref } from 'react';
import type { Style } from 'react-x11/style';
import type {
  DrawnNode,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  WheelEvent,
} from 'react-x11';

/** A point in graph space — the coordinate system node positions live in. */
export interface XYPosition {
  x: number;
  y: number;
}

/** A box in graph space unless the field it is on says screen pixels. */
export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The pane's transform: graph point `p` is drawn at `p * zoom + (x, y)`,
 * relative to the pane's top-left corner. Translate-then-scale, the same
 * order react-flow uses, so a viewport copied from one lands in the other.
 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Which side of a node a handle sits on, and which way its edge leaves. */
export type HandlePosition = 'top' | 'right' | 'bottom' | 'left';

/** A handle either starts edges or receives them. */
export type HandleType = 'source' | 'target';

/**
 * One connection point on a node. A node that declares none gets the pair
 * its type asks for — a target and a source — which is what makes the
 * common case (`{ id, position, data: { label } }`) a complete node.
 */
export interface HandleSpec {
  /** Names this handle in `Connection.sourceHandle`/`targetHandle`. A node
   * with one handle per type can leave it out and connect by node id. */
  id?: string | null;
  type: HandleType;
  position: HandlePosition;
  /** Where along that side, 0 at the top/left corner and 1 at the other.
   * Default `0.5`. This is how a node grows a row of typed inputs. */
  offset?: number;
  /** Drawn beside the handle when the zoom is high enough to read it. */
  label?: string;
}

/** A handle resolved against its node: the spec, plus where it is. */
export interface HandleAnchor extends HandleSpec {
  nodeId: string;
  /** Centre of the handle, in graph space. */
  x: number;
  y: number;
}

/** What the built-in node types read out of `data`. */
export interface FlowNodeData {
  label?: string;
  /** A second line under the label, in the dim colour. */
  description?: string;
}

/** Per-node paint overrides. Colours only: anything that could change the
 * node's *size* belongs in `width`/`height`, which the layout reads. */
export interface NodeAppearance {
  background?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  color?: string;
  /** A stripe down the leading edge — how a type or a status reads at a
   * glance without a legend. */
  accent?: string;
}

export interface FlowNode<Data = FlowNodeData> {
  id: string;
  /** Top-left corner, in graph space. */
  position: XYPosition;
  data?: Data;
  /** Key into `nodeTypes`; `'default'`, `'input'` and `'output'` are built
   * in and differ only in which handles they carry. */
  type?: string;
  /** Explicit size. Left out, the node is measured from its label once and
   * remembered — see `FlowNodeType.size`. */
  width?: number;
  height?: number;
  selected?: boolean;
  hidden?: boolean;
  /** All default to the pane-wide prop (`nodesDraggable`, …). */
  draggable?: boolean;
  selectable?: boolean;
  connectable?: boolean;
  deletable?: boolean;
  /** Higher paints later, and is hit first. */
  zIndex?: number;
  /** Where the built-in handles sit. Defaults: target `'top'`, source
   * `'bottom'` — react-flow's, so a graph laid out for it reads the same. */
  sourcePosition?: HandlePosition;
  targetPosition?: HandlePosition;
  /** Replaces the type's handles outright, for a node whose ports are data
   * rather than shape. */
  handles?: readonly HandleSpec[];
  style?: NodeAppearance;
}

export type EdgeType = 'bezier' | 'smoothstep' | 'step' | 'straight';

/** The arrowhead vocabulary: an outline, or a filled triangle. */
export type MarkerType = 'arrow' | 'arrowclosed';

export interface EdgeMarker {
  type: MarkerType;
  /** Length along the edge, in graph units. Default 12. */
  size?: number;
  /** Defaults to the edge's own stroke. */
  color?: string;
}

export interface EdgeAppearance {
  stroke?: string;
  strokeWidth?: number;
  /** On/off run lengths, in graph units. An `animated` edge that names none
   * gets the default dash. */
  dash?: readonly number[];
  labelColor?: string;
  labelBackground?: string;
}

export interface FlowEdge<Data = unknown> {
  id: string;
  source: string;
  target: string;
  /** Which handle on each end. `null`/absent means "the only one of its
   * type", which is what a node built from the defaults has. */
  sourceHandle?: string | null;
  targetHandle?: string | null;
  /** Default `'bezier'`. */
  type?: EdgeType;
  label?: string;
  /** Marches the dash along the edge. Costs a repaint timer while any
   * animated edge is on screen, and nothing when none is. */
  animated?: boolean;
  selected?: boolean;
  hidden?: boolean;
  selectable?: boolean;
  deletable?: boolean;
  /** Default `'arrowclosed'` — this is a *directed* graph, and an edge you
   * cannot read a direction off is a line. `null` opts out. */
  markerEnd?: MarkerType | EdgeMarker | null;
  markerStart?: MarkerType | EdgeMarker | null;
  zIndex?: number;
  style?: EdgeAppearance;
  data?: Data;
}

/** What a finished connection gesture describes. Handed to `onConnect`, and
 * what `addEdge` turns into an edge. */
export interface Connection {
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

/** Where a connection gesture started, for `onConnectStart`/`onConnectEnd`. */
export interface ConnectionStart {
  nodeId: string;
  handleId: string | null;
  handleType: HandleType;
}

// --- changes ---------------------------------------------------------------
//
// The pane never mutates the arrays it was given. It describes what happened
// and the app applies it, which is what makes `nodes`/`edges` an ordinary
// controlled prop and undo a matter of not applying something.

export type NodeChange<Data = FlowNodeData> =
  | {
      type: 'position';
      id: string;
      position?: XYPosition;
      /** True for every step of a drag, false on the one that ends it —
       * so an app can skip persisting the intermediate positions. */
      dragging?: boolean;
    }
  | { type: 'select'; id: string; selected: boolean }
  | { type: 'remove'; id: string }
  | { type: 'add'; item: FlowNode<Data>; index?: number }
  | { type: 'replace'; id: string; item: FlowNode<Data> };

export type EdgeChange<Data = unknown> =
  | { type: 'select'; id: string; selected: boolean }
  | { type: 'remove'; id: string }
  | { type: 'add'; item: FlowEdge<Data>; index?: number }
  | { type: 'replace'; id: string; item: FlowEdge<Data> };

// --- painting --------------------------------------------------------------

/**
 * The colours the pane draws with. Derived from the nearest `theme` so a
 * graph on a dark desktop is dark, and overridable a token at a time through
 * `<Flow palette>`.
 */
export interface FlowPalette {
  /** The pane behind everything. */
  background: string;
  /** The dot/line grid on it. */
  grid: string;
  text: string;
  dim: string;
  nodeBackground: string;
  nodeBorder: string;
  /** Border and handle fill of a selected node, and the connection line. */
  accent: string;
  edge: string;
  edgeSelected: string;
  handle: string;
  /** Panels that float over the graph: the minimap, the controls. */
  surface: string;
  surfaceBorder: string;
  /** The box-selection rectangle's fill. */
  selection: string;
}

export interface TextOptions {
  size?: number;
  color?: string;
  weight?: number | 'normal' | 'bold';
  family?: string;
  /** Default `'left'`. */
  align?: 'left' | 'center' | 'right';
  /** Where `y` is measured: the top of the line, or its middle. Default
   * `'top'`. */
  baseline?: 'top' | 'middle';
  /** Ellipsize past this many pixels. */
  maxWidth?: number;
}

export interface StrokeOptions {
  stroke?: string;
  lineWidth?: number;
  dash?: readonly number[];
  dashOffset?: number;
}

export interface ShapeOptions extends StrokeOptions {
  fill?: string;
}

/**
 * What a custom node type draws through. Everything is in **screen pixels**,
 * already scaled by the zoom — a node type multiplies its own sizes by
 * `zoom` and otherwise ignores the viewport.
 *
 * It is a facade rather than ntk's context because the mock backend used by
 * headless tests has no path API: a node type written against this one is
 * exercised by `renderX11(..., { backend: 'mock' })` without throwing, and
 * `raw` is there for the drawing this does not cover.
 */
export interface FlowPainter {
  /** ntk's 2d context, for anything the facade does not offer. Null on a
   * backend that cannot draw paths. */
  readonly raw: unknown;
  save(): void;
  restore(): void;
  clipRect(x: number, y: number, w: number, h: number, radius?: number): void;
  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    options: ShapeOptions,
  ): void;
  circle(x: number, y: number, r: number, options: ShapeOptions): void;
  polyline(points: readonly XYPosition[], options: StrokeOptions): void;
  polygon(points: readonly XYPosition[], options: ShapeOptions): void;
  /**
   * Many disjoint strokes as one path and one `stroke()`, and many small
   * squares as one path and one `fill()`. A background grid is thousands of
   * marks, and one X request per mark is the difference between a pan that
   * keeps up and one that does not.
   */
  strokeRuns(
    runs: readonly (readonly XYPosition[])[],
    options: StrokeOptions,
  ): void;
  dots(centres: readonly XYPosition[], size: number, color: string): void;
  text(text: string, x: number, y: number, options?: TextOptions): void;
  measureText(
    text: string,
    options?: TextOptions,
  ): { width: number; height: number };
}

/** What a node type is handed to draw one node. */
export interface NodePaintContext<Data = FlowNodeData> {
  node: FlowNode<Data>;
  /** The node's box, in screen pixels. */
  rect: FlowRect;
  zoom: number;
  selected: boolean;
  hovered: boolean;
  palette: FlowPalette;
  painter: FlowPainter;
  /** The node's handles, resolved and in screen pixels. Drawn by the pane
   * after `paint` returns, so a type that wants them somewhere else moves
   * them with `handles`, not by drawing its own. */
  handles: readonly HandleAnchor[];
}

/**
 * A node type: what the node is shaped like, where it connects, and how it
 * is drawn.
 *
 * react-flow's `nodeTypes` maps a name to a React component, because there
 * the node body is a DOM subtree the browser transforms. Here the pane draws
 * the graph — zoom is not a transform this renderer has, so it is arithmetic
 * — and the analogue of a node component is a `paint`. Everything else about
 * the seam is the same: the registry is a prop, the name lives on the node,
 * and an app that needs none of it never writes one.
 */
export interface FlowNodeType<Data = FlowNodeData> {
  /** The node's size when it carries no `width`/`height`. A function is
   * called once per node and may measure text through the painter it is
   * given. */
  size?:
    | { width: number; height: number }
    | ((
        node: FlowNode<Data>,
        measure: (text: string, options?: TextOptions) => number,
      ) => { width: number; height: number });
  /** The handles nodes of this type carry, overriding the built-in pair. */
  handles?:
    readonly HandleSpec[] | ((node: FlowNode<Data>) => readonly HandleSpec[]);
  /** Draw the body. Leave it out for the built-in card. */
  paint?: (context: NodePaintContext<Data>) => void;
}

// --- pane furniture --------------------------------------------------------

export type BackgroundVariant = 'dots' | 'lines' | 'cross' | 'none';

export interface BackgroundOptions {
  variant?: BackgroundVariant;
  /** Grid pitch in graph units. Default 20. */
  gap?: number;
  /** Dot radius / cross arm, in graph units. Default 1. */
  size?: number;
  color?: string;
}

export type PanePosition =
  'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface MiniMapOptions {
  width?: number;
  height?: number;
  /** Default `'bottom-right'`. */
  position?: PanePosition;
  nodeColor?: string | ((node: FlowNode<never>) => string);
  maskColor?: string;
}

export interface ControlsOptions {
  /** Default `'bottom-left'`. */
  position?: PanePosition;
  showZoom?: boolean;
  showFitView?: boolean;
}

export interface FitViewOptions {
  /** Fraction of the pane left as margin. Default `0.1`. */
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
  /** Fit only these nodes. */
  nodes?: readonly { id: string }[];
}

// --- the imperative surface ------------------------------------------------

/**
 * What a `<Flow ref>` hands back — react-flow's `useReactFlow()`, as a ref
 * rather than a context hook, because a ref needs no provider above the pane
 * and there is exactly one pane to talk to.
 */
export interface FlowInstance {
  getViewport(): Viewport;
  setViewport(viewport: Partial<Viewport>): void;
  zoomIn(step?: number): void;
  zoomOut(step?: number): void;
  zoomTo(zoom: number): void;
  /** Frame the graph. A no-op while the pane has no size yet — which is why
   * the `fitView` prop exists: it waits for the first layout. */
  fitView(options?: FitViewOptions): void;
  setCenter(x: number, y: number, options?: { zoom?: number }): void;
  /** Window coordinates — what an event carries — to graph space. */
  screenToFlowPosition(point: XYPosition): XYPosition;
  flowToScreenPosition(point: XYPosition): XYPosition;
  /** The node's box in graph space, including a measured size. */
  getNodeBounds(id: string): FlowRect | null;
  /** The box around every node, or around the ones named. */
  getNodesBounds(ids?: readonly string[]): FlowRect | null;
}

// --- component props -------------------------------------------------------

/** `(event, node)` — react-flow's argument order. */
export type NodeMouseHandler<Data> = (
  event: MouseEvent<DrawnNode>,
  node: FlowNode<Data>,
) => void;

export type EdgeMouseHandler<Data> = (
  event: MouseEvent<DrawnNode>,
  edge: FlowEdge<Data>,
) => void;

export interface FlowProps<N = FlowNodeData, E = unknown> {
  /** Controlled. Pair with `onNodesChange` and `applyNodeChanges`. */
  nodes?: readonly FlowNode<N>[];
  /** Uncontrolled: the pane owns the array from here on. */
  defaultNodes?: readonly FlowNode<N>[];
  edges?: readonly FlowEdge<E>[];
  defaultEdges?: readonly FlowEdge<E>[];
  onNodesChange?: (changes: NodeChange<N>[]) => void;
  onEdgesChange?: (changes: EdgeChange<E>[]) => void;
  /** A connection gesture landed on a valid handle. Turn it into an edge
   * with `addEdge`; refuse it by doing nothing. */
  onConnect?: (connection: Connection) => void;
  onConnectStart?: (start: ConnectionStart) => void;
  /** The gesture ended, connected or not. */
  onConnectEnd?: (connection: Connection | null) => void;
  /** Vetoes a connection before `onConnect`, and greys the line while the
   * pointer is over a handle it would refuse. */
  isValidConnection?: (connection: Connection) => boolean;
  /** `'strict'` (default) only joins a source to a target; `'loose'` lets
   * either end start, for graphs whose handles are not typed. */
  connectionMode?: 'strict' | 'loose';

  nodeTypes?: Readonly<Record<string, FlowNodeType<N>>>;
  /** Merged under every edge — where `markerEnd`, `type` and `style` for a
   * whole graph belong. */
  defaultEdgeOptions?: Partial<FlowEdge<E>>;

  onNodeClick?: NodeMouseHandler<N>;
  onNodeDoubleClick?: NodeMouseHandler<N>;
  onNodeContextMenu?: NodeMouseHandler<N>;
  onNodeDragStart?: NodeMouseHandler<N>;
  onNodeDragStop?: NodeMouseHandler<N>;
  onEdgeClick?: EdgeMouseHandler<E>;
  onEdgeContextMenu?: EdgeMouseHandler<E>;
  onPaneClick?: (event: MouseEvent<DrawnNode>) => void;
  onPaneContextMenu?: (event: MouseEvent<DrawnNode>) => void;
  onSelectionChange?: (selection: {
    nodes: FlowNode<N>[];
    edges: FlowEdge<E>[];
  }) => void;

  /** Controlled viewport. Left out, the pane owns it — which is what keeps
   * panning off the React render path entirely. */
  viewport?: Viewport;
  defaultViewport?: Viewport;
  onViewportChange?: (viewport: Viewport) => void;
  /** Frame the graph once, on the first layout that has a size. */
  fitView?: boolean;
  fitViewOptions?: FitViewOptions;
  minZoom?: number;
  maxZoom?: number;

  /** All default to `true`. */
  nodesDraggable?: boolean;
  nodesConnectable?: boolean;
  elementsSelectable?: boolean;
  panOnDrag?: boolean;
  zoomOnScroll?: boolean;
  zoomOnDoubleClick?: boolean;
  /** Drag on the pane draws a selection box instead of panning; Shift+drag
   * does it either way. */
  selectionOnDrag?: boolean;
  /** Delete/Backspace removes the selection. Default `true`. */
  deleteOnKey?: boolean;

  snapToGrid?: boolean;
  /** `[x, y]` pitch. Default `[16, 16]`. */
  snapGrid?: readonly [number, number];

  background?: BackgroundOptions | BackgroundVariant | false;
  minimap?: MiniMapOptions | boolean;
  controls?: ControlsOptions | boolean;
  palette?: Partial<FlowPalette>;

  /** The pane fills its parent unless this gives it a height or a
   * `flexGrow` of its own. */
  style?: Style | Style[];
  tabIndex?: number;
  focusable?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  /** Runs before the pane's own wheel handling; `preventDefault()` keeps
   * the pane from zooming or panning. */
  onWheel?: (event: WheelEvent<DrawnNode>) => void;
  /** Runs before the pane's own keys, same veto. */
  onKeyDown?: (event: KeyboardEvent<DrawnNode>) => void;
  onFocus?: (event: FocusEvent<DrawnNode>) => void;
  onBlur?: (event: FocusEvent<DrawnNode>) => void;
  ref?: Ref<FlowInstance>;
}
