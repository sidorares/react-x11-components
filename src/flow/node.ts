// The retained node behind `<flowgraph>`: the viewport, every gesture, and
// all of the drawing.
//
// **Why one node draws the whole graph.** react-flow gives each node a DOM
// subtree and pans and zooms with a CSS transform on their common parent, so
// the browser moves ten thousand boxes for free. This renderer has no
// transform — `style` is yoga plus paint, and zoom is not among them — so
// the same design here would mean re-laying-out and re-rendering every node
// on every pointer step of a pan, through React and through yoga, sixty
// times a second. Drawing the graph instead makes the viewport arithmetic:
// panning is two numbers and a repaint of one node's rect, zoom scales the
// text along with everything else, and React is not involved at all unless
// the graph itself changed. `<codeeditor>` in this package is the same call
// made for the same reason.
//
// **How input arrives.** Through the default-action seam (react-x11#266):
// `defaultMouseDown`/`Drag`/`Up`, `defaultKeyDown`, `defaultContextMenu` run
// after the app's own handlers and not at all if one of them called
// `preventDefault()`. The wheel and plain pointer motion have no such seam,
// so `<Flow>` forwards those two through `handleWheel`/`handleHover` — with
// the same veto, checked here.
import { Node } from 'react-x11/node';
import type { Context2D } from 'react-x11/node';
import type { KeyboardEvent, MouseEvent, WheelEvent } from 'react-x11';
import {
  ctrlChordLetter,
  keysymOf,
  XK_BACKSPACE,
  XK_DELETE,
  XK_DOWN,
  XK_ESCAPE,
  XK_HOME,
  XK_LEFT,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';

import { createPainter, measureText } from './draw.js';
import type { FontsLike, PainterOptions } from './draw.js';
import {
  boundsOf,
  canConnect,
  clamp,
  DEFAULT_MARKER_SIZE,
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  EDGE_SLOP,
  EDGE_STEP_OFFSET,
  fitViewport,
  handleAnchor,
  HANDLE_RADIUS,
  HANDLE_SLOP,
  gripPoint,
  measureNode,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  NODE_BODY_INSET,
  NODE_DESC_SIZE,
  NODE_HEADER,
  NODE_LABEL_SIZE,
  NODE_PAD_X,
  NODE_PAD_Y,
  normalizeBackground,
  normalizeMarker,
  orientConnection,
  rectContains,
  rectsOverlap,
  RENDER_ZOOM,
  RESIZE_DIRECTIONS,
  RESIZE_GRIP,
  RESIZE_SLOP,
  resizeRect,
  resolveHandles,
  resolvePalette,
  snapTo,
  tint,
  ZOOM_STEP,
} from './model.js';
import {
  distanceToPath,
  edgePath,
  endAngle,
  pathBounds,
  pointAtFraction,
  startAngle,
  trimEnd,
} from './paths.js';
import type {
  BackgroundOptions,
  ControlsOptions,
  EdgeChange,
  FitViewOptions,
  FlowEdge,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  FlowPainter,
  FlowPalette,
  FlowRect,
  FlowInstance,
  HandleAnchor,
  HandleSpec,
  MiniMapOptions,
  NodeBodyRect,
  NodeChange,
  TextOptions,
  Viewport,
  XYPosition,
} from './types.js';

/** Registration key, `kind` and JSX tag, one string — react-x11 rejects a
 * node whose `kind` is not the name it was registered under, because `kind`
 * is what paint order, the test queries and the DEV style assertion all
 * match on. */
export const ELEMENT = 'flowgraph';

/** Timers, through `globalThis`: `src/` compiles with `types: []` so a Node
 * global that wandered in would become an implicit `@types/node` dependency
 * a consumer has to satisfy. */
const timers = globalThis as {
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(id: unknown): void;
};

/** How often the dash on an animated edge moves. Slow enough that a graph
 * full of them is not a repaint storm, fast enough to read as motion. */
const ANIMATION_MS = 60;
const ANIMATION_SPEED = 1.4; // px of dash travel per tick, at zoom 1
const DEFAULT_DASH = [7, 5];

/** Below these zooms the pane stops drawing detail nobody could read — the
 * cheapest optimisation there is, and the one that keeps a zoomed-out
 * overview interactive. */
const LABEL_ZOOM = 0.35;
const HANDLE_ZOOM = 0.5;
const DESC_ZOOM = 0.6;

/** Screen pixels the pointer may travel before a press becomes a drag. */
const DRAG_THRESHOLD = 3;
/** The grid never draws denser than this on screen, whatever the zoom. */
const MIN_GRID_PX = 16;

const CONTROL_SIZE = 26;
const PANEL_MARGIN = 10;
const MINIMAP_W = 190;
const MINIMAP_H = 130;

type AnyNode = FlowNode<unknown>;
type AnyEdge = FlowEdge<unknown>;
type AnyType = FlowNodeType<unknown>;

/** A node, resolved: its size and its handle specs, both of which only
 * change when the graph does. Positions are *not* cached — a drag moves them
 * between commits, and reading them through {@link FlowGraphNode.rectOf} is
 * what keeps the two in step. */
interface NodeEntry {
  node: AnyNode;
  width: number;
  height: number;
  specs: readonly HandleSpec[];
  type: AnyType | undefined;
}

type Gesture =
  | {
      kind: 'pan';
      /** False when `panOnDrag` is off: the gesture still exists, because it
       * is also what turns a press and release into `onPaneClick`. */
      pans: boolean;
      startX: number;
      startY: number;
      vx: number;
      vy: number;
    }
  | {
      kind: 'drag';
      ids: string[];
      primary: string;
      origin: Map<string, XYPosition>;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | {
      kind: 'connect';
      from: HandleAnchor;
      pointer: XYPosition;
      to: HandleAnchor | null;
      valid: boolean;
    }
  | {
      kind: 'select';
      startX: number;
      startY: number;
      x: number;
      y: number;
      base: Set<string>;
    }
  /** A press that landed on an edge. It moves nothing; it exists so that
   * the release can tell a click from the start of something else. */
  | { kind: 'edge'; id: string; startX: number; startY: number }
  | {
      kind: 'resize';
      id: string;
      /** Which grip, as a unit direction: `{-1,-1}` is the top-left. */
      dir: XYPosition;
      startX: number;
      startY: number;
      origin: FlowRect;
    }
  | { kind: 'minimap' };

/** What the pointer is over, for hover styling and for the cursor a press
 * would produce. */
interface HoverState {
  nodeId: string | null;
  handle: HandleAnchor | null;
  edgeId: string | null;
}

const NO_HOVER: HoverState = { nodeId: null, handle: null, edgeId: null };

/**
 * Are these the same handle? Anchors are rebuilt from the node on every read
 * — a drag moves them between commits — so identity says nothing, and the
 * `id` alone says too little: the node every graph starts with has *two*
 * handles with no id at all. Node, id, type and side together are what
 * distinguish them.
 */
function sameHandle(
  a: HandleAnchor | null | undefined,
  b: HandleAnchor,
): boolean {
  return (
    a != null &&
    a.nodeId === b.nodeId &&
    (a.id ?? null) === (b.id ?? null) &&
    a.type === b.type &&
    a.position === b.position
  );
}

export class FlowGraphNode extends Node implements FlowInstance {
  // --- viewport, owned here unless the `viewport` prop takes it over ------
  private _vp: Viewport = { x: 0, y: 0, zoom: 1 };
  private _fitPending = false;

  // --- derived graph, rebuilt only when the arrays change -----------------
  private _nodesSeen: unknown;
  private _typesSeen: unknown;
  private _edgesSeen: unknown;
  private _edgeDefaultsSeen: unknown;
  private _fontSeen = '';
  private _entries: NodeEntry[] = [];
  private _byId = new Map<string, NodeEntry>();
  /** Paint order: `zIndex`, then selection, so a selected node is not hidden
   * under one it overlaps. Hit testing walks it backwards. */
  private _order: NodeEntry[] = [];
  private _edges: AnyEdge[] = [];

  // --- interaction --------------------------------------------------------
  private _gesture: Gesture | null = null;
  private _hover: HoverState = NO_HOVER;
  /** Where a drag is putting each node it moves. Read in preference to
   * `node.position`, so the pane is never a frame behind the pointer even
   * when the app applies the changes it is being sent. Cleared on release,
   * which is also how a refused drag snaps back. */
  private _dragTo: Map<string, XYPosition> | null = null;
  /** The box a resize is currently making, for the same reason. */
  private _resizeTo: { id: string; rect: FlowRect } | null = null;
  /** What was last handed to `onNodeBodies`, so the React half is told only
   * when something actually moved. */
  private _bodiesKey = '';
  private _dashPhase = 0;
  private _animTimer: unknown = null;
  /** Inside `paint`, where an invalidation would only schedule a redraw of
   * the frame being drawn. */
  private _painting = false;

  private _textCache = new Map<string, number>();

  constructor(props: Record<string, unknown>, app: unknown) {
    super(ELEMENT, props, app as ConstructorParameters<typeof Node>[2]);
    // Without this nothing focuses the pane and no key ever reaches it; an
    // app's `focusable`/`tabIndex` still overrides either way.
    this.focusableByDefault = true;
    const initial = (props.defaultViewport ?? props.viewport) as
      Viewport | undefined;
    if (initial) this._vp = { ...initial };
    this._fitPending = props.fitView === true;
  }

  // --- props ---------------------------------------------------------------

  private _prop<T>(name: string): T | undefined {
    return this.props[name] as T | undefined;
  }

  private _bool(name: string, fallback: boolean): boolean {
    const v = this.props[name];
    return typeof v === 'boolean' ? v : fallback;
  }

  private _num(name: string, fallback: number): number {
    const v = this.props[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  private get _minZoom(): number {
    return this._num('minZoom', DEFAULT_MIN_ZOOM);
  }

  private get _maxZoom(): number {
    return this._num('maxZoom', DEFAULT_MAX_ZOOM);
  }

  private _nodes(): readonly AnyNode[] {
    const v = this.props.nodes;
    return Array.isArray(v) ? (v as AnyNode[]) : [];
  }

  private _rawEdges(): readonly AnyEdge[] {
    const v = this.props.edges;
    return Array.isArray(v) ? (v as AnyEdge[]) : [];
  }

  // --- text ----------------------------------------------------------------

  private _fonts(): FontsLike | null {
    return (
      (this.app as { fonts?: FontsLike } | null | undefined)?.fonts ?? null
    );
  }

  private _themeString(token: string): string | undefined {
    const v = (this.theme as Record<string, unknown> | null)?.[token];
    return typeof v === 'string' ? v : undefined;
  }

  private _textOptions(): PainterOptions {
    return {
      fonts: this._fonts(),
      family:
        (this.style.fontFamily as string | undefined) ??
        this._themeString('fontFamily') ??
        'sans-serif',
      color: this._palette().text,
      cache: this._textCache,
    };
  }

  private _measure = (text: string, options?: TextOptions): number =>
    measureText(this._textOptions(), text, options).width;

  private _palette(): FlowPalette {
    return resolvePalette(
      this.theme as Record<string, unknown> | null,
      this._prop<Partial<FlowPalette>>('palette'),
    );
  }

  // --- the derived graph ---------------------------------------------------

  /**
   * Rebuild the node index when — and only when — one of its inputs changed
   * identity. Sizes come out of the font stack, so the face is an input too:
   * a theme switch that changes it has to re-measure or every node keeps the
   * width it had under the old one.
   */
  private _sync(): void {
    const nodes = this.props.nodes;
    const types = this.props.nodeTypes;
    const opts = this._textOptions();
    const fontKey = `${opts.family}|${this._fonts() ? 1 : 0}`;
    if (
      nodes !== this._nodesSeen ||
      types !== this._typesSeen ||
      fontKey !== this._fontSeen
    ) {
      this._nodesSeen = nodes;
      this._typesSeen = types;
      this._fontSeen = fontKey;
      this._rebuildNodes();
    }
    const edges = this.props.edges;
    const defaults = this.props.defaultEdgeOptions;
    if (edges !== this._edgesSeen || defaults !== this._edgeDefaultsSeen) {
      this._edgesSeen = edges;
      this._edgeDefaultsSeen = defaults;
      this._rebuildEdges();
    }
  }

  private _rebuildNodes(): void {
    const registry = this._prop<Record<string, AnyType>>('nodeTypes');
    const entries: NodeEntry[] = [];
    const byId = new Map<string, NodeEntry>();
    for (const node of this._nodes()) {
      if (!node || typeof node.id !== 'string' || !node.position) continue;
      const type = registry?.[node.type ?? 'default'];
      const { width, height } = measureNode(node, type, this._measure);
      const entry: NodeEntry = {
        node,
        width,
        height,
        specs: resolveHandles(node, type),
        type,
      };
      entries.push(entry);
      byId.set(node.id, entry);
    }
    this._entries = entries;
    this._byId = byId;
    this._order = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const az = a.entry.node.zIndex ?? 0;
        const bz = b.entry.node.zIndex ?? 0;
        if (az !== bz) return az - bz;
        const as = a.entry.node.selected ? 1 : 0;
        const bs = b.entry.node.selected ? 1 : 0;
        if (as !== bs) return as - bs;
        return a.index - b.index; // stable: declaration order breaks ties
      })
      .map((e) => e.entry);
  }

  private _rebuildEdges(): void {
    const defaults = this._prop<Partial<AnyEdge>>('defaultEdgeOptions');
    const raw = this._rawEdges();
    this._edges = defaults
      ? raw.map((edge) => ({ ...defaults, ...edge }) as AnyEdge)
      : (raw as AnyEdge[]);
  }

  // --- coordinates ---------------------------------------------------------

  private _viewport(): Viewport {
    return this._prop<Viewport>('viewport') ?? this._vp;
  }

  /**
   * The pane proper: `abs` inset by border and padding. Everything the
   * viewport is measured against uses this rather than `abs`, so a
   * `<Flow style={{ borderWidth: 1, padding: 8 }}>` keeps its border — the
   * graph is drawn after `super.paint` has already stroked it — and its
   * padding means what it does on a `<box>`.
   *
   * [react-x11 gap] the built-ins read an internal `contentBox()`; a public
   * one would remove this arithmetic. Filed as react-x11#254, and
   * `src/code-editor/node.ts` carries the same copy.
   */
  private _pane(): FlowRect {
    const s = this.style as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const border = num(s.borderWidth);
    const pad = num(s.padding);
    const top = num(s.borderTopWidth ?? border) + num(s.paddingTop ?? pad);
    const right =
      num(s.borderRightWidth ?? border) + num(s.paddingRight ?? pad);
    const bottom =
      num(s.borderBottomWidth ?? border) + num(s.paddingBottom ?? pad);
    const left = num(s.borderLeftWidth ?? border) + num(s.paddingLeft ?? pad);
    const { x, y, width, height } = this.abs;
    return {
      x: x + left,
      y: y + top,
      width: Math.max(0, width - left - right),
      height: Math.max(0, height - top - bottom),
    };
  }

  /** Graph point to window pixels. */
  private _toScreen(p: XYPosition): XYPosition {
    const v = this._viewport();
    const pane = this._pane();
    return {
      x: pane.x + p.x * v.zoom + v.x,
      y: pane.y + p.y * v.zoom + v.y,
    };
  }

  /** Window pixels to graph point. */
  private _toGraph(x: number, y: number): XYPosition {
    const v = this._viewport();
    const pane = this._pane();
    return {
      x: (x - pane.x - v.x) / v.zoom,
      y: (y - pane.y - v.y) / v.zoom,
    };
  }

  /** Where a node is *now*: mid-drag that is not where its props say. */
  private _positionOf(node: AnyNode): XYPosition {
    return this._dragTo?.get(node.id) ?? node.position;
  }

  /** A node's box in graph space — including whatever a gesture in flight
   * is making of it, which is what keeps the pane from being a frame behind
   * the pointer even when the app is applying the changes it is sent. */
  rectOf(entry: NodeEntry): FlowRect {
    const resizing = this._resizeTo;
    if (resizing && resizing.id === entry.node.id) return resizing.rect;
    const p = this._positionOf(entry.node);
    return { x: p.x, y: p.y, width: entry.width, height: entry.height };
  }

  /** The strip a `render` node keeps for its title and for dragging. Zero
   * for a node whose body the pane draws itself. */
  private _headerHeight(entry: NodeEntry): number {
    if (!entry.type?.render) return 0;
    return entry.type.headerHeight ?? NODE_HEADER;
  }

  private _resizable(entry: NodeEntry): boolean {
    return (
      (entry.node.resizable ?? this._bool('nodesResizable', false)) !== false
    );
  }

  /** The grips a node offers right now: none unless it is selected and
   * resizable, because eight dots on every node is a graph nobody can
   * read. */
  private _grips(entry: NodeEntry): readonly XYPosition[] {
    if (!entry.node.selected || !this._resizable(entry)) return [];
    if (this._viewport().zoom < HANDLE_ZOOM) return [];
    if (!this._connectable(entry)) return RESIZE_DIRECTIONS;
    // Both families live on the border, and a side-centred handle sits
    // exactly on a side-centred grip. The handle wins the hit test, so a
    // grip drawn under one is a control that does not work: drop it. The
    // corners — which is what a resize actually reaches for — are never the
    // ones lost, unless a handle was put there on purpose.
    const rect = this.rectOf(entry);
    const anchors = this._handlesOf(entry);
    const near = RESIZE_GRIP + RESIZE_SLOP;
    return RESIZE_DIRECTIONS.filter((dir) => {
      const at = gripPoint(rect, dir);
      return !anchors.some(
        (a) => Math.abs(a.x - at.x) <= near && Math.abs(a.y - at.y) <= near,
      );
    });
  }

  private _handlesOf(entry: NodeEntry): HandleAnchor[] {
    const rect = this.rectOf(entry);
    return entry.specs.map((spec) => handleAnchor(entry.node.id, rect, spec));
  }

  private _screenRect(entry: NodeEntry): FlowRect {
    const v = this._viewport();
    const rect = this.rectOf(entry);
    const p = this._toScreen(rect);
    return {
      x: p.x,
      y: p.y,
      width: rect.width * v.zoom,
      height: rect.height * v.zoom,
    };
  }

  private _visible(): boolean {
    const pane = this._pane();
    return pane.width > 0 && pane.height > 0;
  }

  // --- viewport control ----------------------------------------------------

  private _repaint(reason = 'content'): void {
    this.invalidate(false, this.abs, reason);
  }

  private _applyViewport(next: Viewport): void {
    const zoom = clamp(next.zoom, this._minZoom, this._maxZoom);
    const v = { x: next.x, y: next.y, zoom };
    const controlled = this.props.viewport !== undefined;
    if (!controlled) this._vp = v;
    this._prop<(vp: Viewport) => void>('onViewportChange')?.(v);
    // The `fitView` that runs at the top of a paint has already changed what
    // this frame will draw, so asking for another one would only draw the
    // same picture twice.
    if (!controlled && !this._painting) this._repaint('scroll');
  }

  /** Zoom about a point that must not move — the pointer under a wheel, the
   * pane's centre for a keyboard zoom. */
  private _zoomAbout(factor: number, screenX: number, screenY: number): void {
    const v = this._viewport();
    const zoom = clamp(v.zoom * factor, this._minZoom, this._maxZoom);
    if (zoom === v.zoom) return;
    const pane = this._pane();
    const px = screenX - pane.x;
    const py = screenY - pane.y;
    const k = zoom / v.zoom;
    this._applyViewport({
      zoom,
      x: px - (px - v.x) * k,
      y: py - (py - v.y) * k,
    });
  }

  private _fit(options?: FitViewOptions): void {
    if (!this._visible()) return;
    this._sync();
    const pane = this._pane();
    const only = options?.nodes && new Set(options.nodes.map((n) => n.id));
    const rects: FlowRect[] = [];
    for (const entry of this._entries) {
      if (entry.node.hidden) continue;
      if (only && !only.has(entry.node.id)) continue;
      rects.push(this.rectOf(entry));
    }
    const bounds = boundsOf(rects);
    if (!bounds) return;
    this._applyViewport(
      fitViewport(bounds, { width: pane.width, height: pane.height }, options, {
        minZoom: this._minZoom,
        maxZoom: this._maxZoom,
      }),
    );
  }

  // --- the imperative surface (`FlowInstance`) -----------------------------

  getViewport(): Viewport {
    return { ...this._viewport() };
  }

  setViewport(viewport: Partial<Viewport>): void {
    const v = this._viewport();
    this._applyViewport({
      x: viewport.x ?? v.x,
      y: viewport.y ?? v.y,
      zoom: viewport.zoom ?? v.zoom,
    });
  }

  zoomIn(step = ZOOM_STEP): void {
    const pane = this._pane();
    this._zoomAbout(step, pane.x + pane.width / 2, pane.y + pane.height / 2);
  }

  zoomOut(step = ZOOM_STEP): void {
    this.zoomIn(1 / step);
  }

  zoomTo(zoom: number): void {
    const v = this._viewport();
    const pane = this._pane();
    this._zoomAbout(
      zoom / v.zoom,
      pane.x + pane.width / 2,
      pane.y + pane.height / 2,
    );
  }

  fitView(options?: FitViewOptions): void {
    this._fit(options ?? this._prop<FitViewOptions>('fitViewOptions'));
  }

  setCenter(x: number, y: number, options?: { zoom?: number }): void {
    const v = this._viewport();
    const zoom = clamp(options?.zoom ?? v.zoom, this._minZoom, this._maxZoom);
    const pane = this._pane();
    this._applyViewport({
      zoom,
      x: pane.width / 2 - x * zoom,
      y: pane.height / 2 - y * zoom,
    });
  }

  screenToFlowPosition(point: XYPosition): XYPosition {
    return this._toGraph(point.x, point.y);
  }

  flowToScreenPosition(point: XYPosition): XYPosition {
    return this._toScreen(point);
  }

  getNodeBounds(id: string): FlowRect | null {
    this._sync();
    const entry = this._byId.get(id);
    return entry ? this.rectOf(entry) : null;
  }

  getNodesBounds(ids?: readonly string[]): FlowRect | null {
    this._sync();
    const only = ids && new Set(ids);
    const rects: FlowRect[] = [];
    for (const entry of this._entries) {
      if (only && !only.has(entry.node.id)) continue;
      rects.push(this.rectOf(entry));
    }
    return boundsOf(rects);
  }

  // --- change emission -----------------------------------------------------

  private _emitNodes(changes: NodeChange<unknown>[]): void {
    if (changes.length === 0) return;
    this._prop<(c: NodeChange<unknown>[]) => void>('onNodesChange')?.(changes);
  }

  private _emitEdges(changes: EdgeChange<unknown>[]): void {
    if (changes.length === 0) return;
    this._prop<(c: EdgeChange<unknown>[]) => void>('onEdgesChange')?.(changes);
  }

  /** Make this the selection. `additive` toggles instead, which is what
   * Shift and Ctrl do everywhere else. */
  private _select(
    target: { kind: 'node' | 'edge'; id: string } | null,
    additive: boolean,
  ): void {
    if (!this._bool('elementsSelectable', true)) return;
    const nodeChanges: NodeChange<unknown>[] = [];
    const edgeChanges: EdgeChange<unknown>[] = [];
    const isNode = target?.kind === 'node';
    const isEdge = target?.kind === 'edge';

    for (const entry of this._entries) {
      const hit = isNode && entry.node.id === target.id;
      const selected = entry.node.selected ?? false;
      const next = hit
        ? additive
          ? !selected
          : true
        : additive
          ? selected
          : false;
      if (next !== selected) {
        nodeChanges.push({ type: 'select', id: entry.node.id, selected: next });
      }
    }
    for (const edge of this._edges) {
      const hit = isEdge && edge.id === target.id;
      const selected = edge.selected ?? false;
      const next = hit
        ? additive
          ? !selected
          : true
        : additive
          ? selected
          : false;
      if (next !== selected) {
        edgeChanges.push({ type: 'select', id: edge.id, selected: next });
      }
    }
    this._emitNodes(nodeChanges);
    this._emitEdges(edgeChanges);
  }

  private _selectedNodeIds(): string[] {
    const ids: string[] = [];
    for (const entry of this._entries) {
      if (entry.node.selected) ids.push(entry.node.id);
    }
    return ids;
  }

  // --- hit testing ---------------------------------------------------------

  /** The topmost node under a window point, or null. Walks paint order
   * backwards, which is what "topmost" means. */
  private _nodeAt(x: number, y: number): NodeEntry | null {
    for (let i = this._order.length - 1; i >= 0; i--) {
      const entry = this._order[i];
      if (entry.node.hidden) continue;
      if (rectContains(this._screenRect(entry), { x, y })) return entry;
    }
    return null;
  }

  private _handleAt(
    x: number,
    y: number,
    accept?: (anchor: HandleAnchor, entry: NodeEntry) => boolean,
  ): HandleAnchor | null {
    const zoom = this._viewport().zoom;
    const reach = Math.max(7, (HANDLE_RADIUS + HANDLE_SLOP) * zoom);
    for (let i = this._order.length - 1; i >= 0; i--) {
      const entry = this._order[i];
      if (entry.node.hidden) continue;
      if (!this._connectable(entry)) continue;
      // cheap reject: the handles are on the node's border, so nothing more
      // than `reach` outside its box can be one
      const rect = this._screenRect(entry);
      if (
        x < rect.x - reach ||
        x > rect.x + rect.width + reach ||
        y < rect.y - reach ||
        y > rect.y + rect.height + reach
      ) {
        continue;
      }
      for (const anchor of this._handlesOf(entry)) {
        if (accept && !accept(anchor, entry)) continue;
        const s = this._toScreen(anchor);
        if (Math.hypot(s.x - x, s.y - y) <= reach) return anchor;
      }
    }
    return null;
  }

  /**
   * A resize grip under the point, if any. Tested *after* the connection
   * handles: the two families both live on the border and a side-centred
   * handle sits exactly on a side-centred grip, so one of them has to give
   * way, and it should be the one whose corners are still reachable.
   */
  private _gripAt(
    x: number,
    y: number,
  ): { entry: NodeEntry; dir: XYPosition } | null {
    const zoom = this._viewport().zoom;
    const reach = Math.max(6, (RESIZE_GRIP + RESIZE_SLOP) * zoom);
    for (let i = this._order.length - 1; i >= 0; i--) {
      const entry = this._order[i];
      if (entry.node.hidden) continue;
      const grips = this._grips(entry);
      if (grips.length === 0) continue;
      const rect = this._screenRect(entry);
      if (
        x < rect.x - reach ||
        x > rect.x + rect.width + reach ||
        y < rect.y - reach ||
        y > rect.y + rect.height + reach
      ) {
        continue;
      }
      for (const dir of grips) {
        const at = gripPoint(rect, dir);
        if (Math.abs(at.x - x) <= reach && Math.abs(at.y - y) <= reach) {
          return { entry, dir };
        }
      }
    }
    return null;
  }

  private _edgeAt(x: number, y: number): AnyEdge | null {
    const reach = Math.max(5, EDGE_SLOP * this._viewport().zoom);
    const point = { x, y };
    for (let i = this._edges.length - 1; i >= 0; i--) {
      const edge = this._edges[i];
      if (edge.hidden) continue;
      const box = this._edgeCoarseBox(edge);
      if (!box) continue;
      if (!rectContains(box, point)) continue;
      const geometry = this._edgeGeometry(edge);
      if (!geometry) continue;
      if (distanceToPath(geometry.points, point) <= reach) return edge;
    }
    return null;
  }

  /**
   * A box the edge cannot leave, from its two nodes alone — no path built.
   * Hover runs this over every edge on every pointer step, and building the
   * real geometry to reject it would make motion cost what drawing does.
   *
   * The slack covers the two ways a route leaves the span between its nodes:
   * a step edge by a fixed offset, a bezier by its shoulder, which grows as
   * the square root of the gap (see `paths.ts`) — `8` where the shoulder
   * uses `6.25`, so the bound is generous rather than tight.
   */
  private _edgeCoarseBox(edge: AnyEdge): FlowRect | null {
    const source = this._byId.get(edge.source);
    const target = this._byId.get(edge.target);
    if (!source || !target) return null;
    if (source.node.hidden || target.node.hidden) return null;
    const zoom = this._viewport().zoom;
    const a = this._screenRect(source);
    const b = this._screenRect(target);
    const span = Math.hypot(
      a.x + a.width / 2 - (b.x + b.width / 2),
      a.y + a.height / 2 - (b.y + b.height / 2),
    );
    const slack =
      Math.max(5, EDGE_SLOP * zoom) +
      Math.max(EDGE_STEP_OFFSET * 3 * zoom, 8 * Math.sqrt(zoom * span));
    const x = Math.min(a.x, b.x) - slack;
    const y = Math.min(a.y, b.y) - slack;
    return {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) + slack - x,
      height: Math.max(a.y + a.height, b.y + b.height) + slack - y,
    };
  }

  /** The drawn handle, in screen pixels. Capped as well as floored: a dot
   * that scaled all the way up would be a saucer at 2.5×, and the thing it
   * marks — a point on the border — does not get bigger. */
  private _handleRadius(): number {
    return clamp(HANDLE_RADIUS * this._viewport().zoom, 2.5, 6);
  }

  private _connectable(entry: NodeEntry): boolean {
    return (
      (entry.node.connectable ?? this._bool('nodesConnectable', true)) !== false
    );
  }

  private _draggable(entry: NodeEntry): boolean {
    return (
      (entry.node.draggable ?? this._bool('nodesDraggable', true)) !== false
    );
  }

  // --- edge geometry -------------------------------------------------------

  /** Pick the handle an edge attaches to: the one it names, else the only
   * one of the right type, else the one facing the other end. */
  private _endpoint(
    entry: NodeEntry,
    handleId: string | null | undefined,
    type: 'source' | 'target',
    towards: XYPosition | null,
  ): HandleAnchor | null {
    const anchors = this._handlesOf(entry);
    if (handleId != null) {
      const named = anchors.find((a) => a.id === handleId);
      if (named) return named;
    }
    const typed = anchors.filter((a) => a.type === type);
    const candidates = typed.length > 0 ? typed : anchors;
    if (candidates.length === 0) return null;
    if (candidates.length === 1 || !towards) return candidates[0];
    let best = candidates[0];
    let bestDistance = Infinity;
    for (const anchor of candidates) {
      const d = Math.hypot(anchor.x - towards.x, anchor.y - towards.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = anchor;
      }
    }
    return best;
  }

  /** An edge's polyline, in **screen** pixels, plus the two ends it joins.
   * Null when either end is missing — an edge to a node that was removed is
   * a normal state during an edit, not an error. */
  private _edgeGeometry(
    edge: AnyEdge,
  ): { points: XYPosition[]; from: HandleAnchor; to: HandleAnchor } | null {
    const sourceEntry = this._byId.get(edge.source);
    const targetEntry = this._byId.get(edge.target);
    if (!sourceEntry || !targetEntry) return null;
    if (sourceEntry.node.hidden || targetEntry.node.hidden) return null;
    const sourceCentre = this._centre(sourceEntry);
    const targetCentre = this._centre(targetEntry);
    const from = this._endpoint(
      sourceEntry,
      edge.sourceHandle,
      'source',
      targetCentre,
    );
    const to = this._endpoint(
      targetEntry,
      edge.targetHandle,
      'target',
      sourceCentre,
    );
    if (!from || !to) return null;

    const zoom = this._viewport().zoom;
    const s = this._toScreen(from);
    const t = this._toScreen(to);
    const points = edgePath(
      edge.type,
      { x: s.x, y: s.y, position: from.position },
      { x: t.x, y: t.y, position: to.position },
      {
        stepOffset: EDGE_STEP_OFFSET * zoom,
        radius: 8 * zoom,
        scale: zoom,
        loop: edge.source === edge.target,
      },
    );
    return { points, from, to };
  }

  private _centre(entry: NodeEntry): XYPosition {
    const r = this.rectOf(entry);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }

  // --- pane furniture geometry --------------------------------------------

  private _corner(
    where: string | undefined,
    width: number,
    height: number,
    fallback: string,
  ): FlowRect {
    const at = where ?? fallback;
    const right = at.endsWith('right');
    const bottom = at.startsWith('bottom');
    const pane = this._pane();
    return {
      x: right
        ? pane.x + pane.width - width - PANEL_MARGIN
        : pane.x + PANEL_MARGIN,
      y: bottom
        ? pane.y + pane.height - height - PANEL_MARGIN
        : pane.y + PANEL_MARGIN,
      width,
      height,
    };
  }

  private _controlsOptions(): ControlsOptions | null {
    const value = this.props.controls;
    if (value === false) return null;
    return typeof value === 'object' && value !== null
      ? (value as ControlsOptions)
      : {};
  }

  private _controlButtons(): {
    rect: FlowRect;
    action: 'in' | 'out' | 'fit';
  }[] {
    const options = this._controlsOptions();
    if (!options) return [];
    const actions: ('in' | 'out' | 'fit')[] = [];
    if (options.showZoom !== false) actions.push('in', 'out');
    if (options.showFitView !== false) actions.push('fit');
    if (actions.length === 0) return [];
    const panel = this._corner(
      options.position,
      CONTROL_SIZE,
      CONTROL_SIZE * actions.length,
      'bottom-left',
    );
    return actions.map((action, i) => ({
      action,
      rect: {
        x: panel.x,
        y: panel.y + i * CONTROL_SIZE,
        width: CONTROL_SIZE,
        height: CONTROL_SIZE,
      },
    }));
  }

  private _miniMapOptions(): MiniMapOptions | null {
    const value = this.props.minimap;
    if (!value) return null;
    return typeof value === 'object' ? (value as MiniMapOptions) : {};
  }

  /** The minimap panel and the graph-to-panel transform, or null when there
   * is no minimap or nothing to put in it. */
  private _miniMap(): {
    panel: FlowRect;
    bounds: FlowRect;
    scale: number;
    options: MiniMapOptions;
  } | null {
    const options = this._miniMapOptions();
    if (!options) return null;
    const width = options.width ?? MINIMAP_W;
    const height = options.height ?? MINIMAP_H;
    const pane = this._pane();
    if (pane.width < width * 1.6 || pane.height < height * 1.6) {
      // A minimap that covers the pane it summarises is worse than none.
      return null;
    }
    const rects: FlowRect[] = [];
    for (const entry of this._entries) {
      if (!entry.node.hidden) rects.push(this.rectOf(entry));
    }
    // The viewport joins the bounds, so panning off the graph still shows
    // where you are rather than pinning the box to an edge.
    const v = this._viewport();
    rects.push({
      x: -v.x / v.zoom,
      y: -v.y / v.zoom,
      width: pane.width / v.zoom,
      height: pane.height / v.zoom,
    });
    const bounds = boundsOf(rects);
    if (!bounds) return null;
    const pad = Math.max(bounds.width, bounds.height) * 0.05 + 10;
    const padded = {
      x: bounds.x - pad,
      y: bounds.y - pad,
      width: bounds.width + pad * 2,
      height: bounds.height + pad * 2,
    };
    const panel = this._corner(options.position, width, height, 'bottom-right');
    const scale = Math.min(
      panel.width / Math.max(1, padded.width),
      panel.height / Math.max(1, padded.height),
    );
    return { panel, bounds: padded, scale, options };
  }

  private _miniToGraph(
    map: { panel: FlowRect; bounds: FlowRect; scale: number },
    x: number,
    y: number,
  ): XYPosition {
    const ox =
      map.panel.x + (map.panel.width - map.bounds.width * map.scale) / 2;
    const oy =
      map.panel.y + (map.panel.height - map.bounds.height * map.scale) / 2;
    return {
      x: (x - ox) / map.scale + map.bounds.x,
      y: (y - oy) / map.scale + map.bounds.y,
    };
  }

  private _miniToScreen(
    map: { panel: FlowRect; bounds: FlowRect; scale: number },
    p: XYPosition,
  ): XYPosition {
    const ox =
      map.panel.x + (map.panel.width - map.bounds.width * map.scale) / 2;
    const oy =
      map.panel.y + (map.panel.height - map.bounds.height * map.scale) / 2;
    return {
      x: ox + (p.x - map.bounds.x) * map.scale,
      y: oy + (p.y - map.bounds.y) * map.scale,
    };
  }

  // --- gestures ------------------------------------------------------------

  override defaultMouseDown(ev: MouseEvent): void {
    if (this.props.disabled) return;
    this.focus();
    this._sync();
    if (ev.button === 3) return; // the context menu is its own seam

    const { x, y } = ev;
    // 1. the pane's own furniture, which is over everything else
    for (const button of this._controlButtons()) {
      if (rectContains(button.rect, { x, y })) {
        if (button.action === 'in') this.zoomIn();
        else if (button.action === 'out') this.zoomOut();
        else this.fitView();
        ev.preventDefault();
        return;
      }
    }
    const map = this._miniMap();
    if (map && rectContains(map.panel, { x, y })) {
      this._gesture = { kind: 'minimap' };
      const p = this._miniToGraph(map, x, y);
      this.setCenter(p.x, p.y);
      ev.capturePointer();
      ev.preventDefault();
      return;
    }

    // 2. a handle, which sits proud of its node and so is tested first
    if (ev.button === 1 && this._bool('nodesConnectable', true)) {
      const handle = this._handleAt(x, y);
      if (handle) {
        this._gesture = {
          kind: 'connect',
          from: handle,
          pointer: this._toGraph(x, y),
          to: null,
          valid: false,
        };
        this._prop<(s: unknown) => void>('onConnectStart')?.({
          nodeId: handle.nodeId,
          handleId: handle.id ?? null,
          handleType: handle.type,
        });
        ev.capturePointer();
        ev.preventDefault();
        this._repaint('style-state');
        return;
      }
    }

    // 3. a resize grip on a selected node
    if (ev.button === 1) {
      const grip = this._gripAt(x, y);
      if (grip) {
        this._gesture = {
          kind: 'resize',
          id: grip.entry.node.id,
          dir: grip.dir,
          startX: x,
          startY: y,
          origin: this.rectOf(grip.entry),
        };
        ev.capturePointer();
        ev.preventDefault();
        return;
      }
    }

    // 4. a node
    const entry = ev.button === 1 ? this._nodeAt(x, y) : null;
    if (entry) {
      const additive = ev.shiftKey || ev.ctrlKey;
      const selectable =
        (entry.node.selectable ?? this._bool('elementsSelectable', true)) !==
        false;
      // A press inside an existing multi-selection keeps it, so that
      // dragging the group does not first collapse it to one node.
      if (selectable && !(entry.node.selected && !additive)) {
        this._select({ kind: 'node', id: entry.node.id }, additive);
      }
      // The gesture is armed even for a node nothing may move: it is also
      // what turns a press-and-release into `onNodeClick`, and a node that
      // cannot be dragged can still be clicked. It simply moves nothing.
      const ids =
        entry.node.selected && this._draggable(entry)
          ? Array.from(new Set([...this._selectedNodeIds(), entry.node.id]))
          : this._draggable(entry)
            ? [entry.node.id]
            : [];
      const origin = new Map<string, XYPosition>();
      for (const id of ids) {
        const target = this._byId.get(id);
        if (target && this._draggable(target)) {
          origin.set(id, { ...this._positionOf(target.node) });
        }
      }
      this._gesture = {
        kind: 'drag',
        ids: Array.from(origin.keys()),
        primary: entry.node.id,
        origin,
        startX: x,
        startY: y,
        moved: false,
      };
      ev.capturePointer();
      ev.preventDefault();
      return;
    }

    // 5. an edge
    if (ev.button === 1) {
      const edge = this._edgeAt(x, y);
      if (edge) {
        if (
          (edge.selectable ?? this._bool('elementsSelectable', true)) !== false
        ) {
          this._select(
            { kind: 'edge', id: edge.id },
            ev.shiftKey || ev.ctrlKey,
          );
        }
        this._gesture = { kind: 'edge', id: edge.id, startX: x, startY: y };
        ev.capturePointer();
        ev.preventDefault();
        return;
      }
    }

    // 6. the empty pane: a box selection, or a pan
    const boxSelect =
      ev.button === 1 &&
      (ev.shiftKey || this._bool('selectionOnDrag', false)) &&
      this._bool('elementsSelectable', true);
    if (boxSelect) {
      this._gesture = {
        kind: 'select',
        startX: x,
        startY: y,
        x,
        y,
        base: ev.shiftKey ? new Set(this._selectedNodeIds()) : new Set(),
      };
      if (!ev.shiftKey) this._select(null, false);
      ev.capturePointer();
      ev.preventDefault();
      return;
    }
    const v = this._viewport();
    this._gesture = {
      kind: 'pan',
      pans: ev.button === 2 || this._bool('panOnDrag', true),
      startX: x,
      startY: y,
      vx: v.x,
      vy: v.y,
    };
    ev.capturePointer();
    ev.preventDefault();
  }

  override defaultMouseDrag(ev: MouseEvent): void {
    const gesture = this._gesture;
    if (!gesture) return;
    ev.preventDefault();
    switch (gesture.kind) {
      case 'pan':
        if (!gesture.pans) return;
        this._applyViewport({
          ...this._viewport(),
          x: gesture.vx + (ev.x - gesture.startX),
          y: gesture.vy + (ev.y - gesture.startY),
        });
        return;
      case 'drag':
        this._dragStep(gesture, ev);
        return;
      case 'connect':
        this._connectStep(gesture, ev);
        return;
      case 'resize':
        this._resizeStep(gesture, ev);
        return;
      case 'select':
        gesture.x = ev.x;
        gesture.y = ev.y;
        this._selectBox(gesture);
        this._repaint('style-state');
        return;
      case 'minimap': {
        const map = this._miniMap();
        if (!map) return;
        const p = this._miniToGraph(map, ev.x, ev.y);
        this.setCenter(p.x, p.y);
        return;
      }
    }
  }

  override defaultMouseUp(ev: MouseEvent): void {
    const gesture = this._gesture;
    this._gesture = null;
    if (!gesture) return;

    if (gesture.kind === 'drag') {
      const to = this._dragTo;
      this._dragTo = null;
      if (gesture.moved && to && gesture.ids.length > 0) {
        // The settling change: `dragging: false` is what tells an app this
        // is the position worth persisting.
        this._emitNodes(
          gesture.ids.map((id) => ({
            type: 'position' as const,
            id,
            position: to.get(id) ?? this._byId.get(id)?.node.position,
            dragging: false,
          })),
        );
        const primary = this._byId.get(gesture.primary);
        if (primary) {
          this._prop<(e: MouseEvent, n: AnyNode) => void>('onNodeDragStop')?.(
            ev,
            primary.node,
          );
        }
      } else {
        this._clickNode(ev, gesture.primary);
      }
      this._repaint();
      return;
    }

    if (gesture.kind === 'connect') {
      const connection =
        gesture.to && gesture.valid
          ? orientConnection(
              {
                nodeId: gesture.from.nodeId,
                handleId: gesture.from.id ?? null,
                type: gesture.from.type,
              },
              {
                nodeId: gesture.to.nodeId,
                handleId: gesture.to.id ?? null,
                type: gesture.to.type,
              },
            )
          : null;
      if (connection) {
        this._prop<(c: unknown) => void>('onConnect')?.(connection);
      }
      this._prop<(c: unknown) => void>('onConnectEnd')?.(connection);
      this._repaint('style-state');
      return;
    }

    if (gesture.kind === 'pan') {
      const moved =
        Math.abs(ev.x - gesture.startX) > DRAG_THRESHOLD ||
        Math.abs(ev.y - gesture.startY) > DRAG_THRESHOLD;
      if (!moved && ev.button === 1) {
        this._select(null, false);
        this._prop<(e: MouseEvent) => void>('onPaneClick')?.(ev);
        if (ev.detail === 2 && this._bool('zoomOnDoubleClick', true)) {
          this._zoomAbout(ZOOM_STEP, ev.x, ev.y);
        }
      }
      return;
    }

    if (gesture.kind === 'resize') {
      this._resizeStep(gesture, ev, true);
      this._resizeTo = null;
      this._repaint();
      return;
    }

    if (gesture.kind === 'edge') {
      const moved =
        Math.abs(ev.x - gesture.startX) > DRAG_THRESHOLD ||
        Math.abs(ev.y - gesture.startY) > DRAG_THRESHOLD;
      const edge = this._edges.find((e) => e.id === gesture.id);
      if (!moved && edge) {
        this._prop<(e: MouseEvent, x: AnyEdge) => void>('onEdgeClick')?.(
          ev,
          edge,
        );
      }
      return;
    }

    if (gesture.kind === 'select' || gesture.kind === 'minimap') {
      this._repaint('style-state');
    }
  }

  override defaultContextMenu(ev: MouseEvent): void {
    if (this.props.disabled) return;
    this._sync();
    const entry = this._nodeAt(ev.x, ev.y);
    if (entry) {
      this._prop<(e: MouseEvent, n: AnyNode) => void>('onNodeContextMenu')?.(
        ev,
        entry.node,
      );
      return;
    }
    const edge = this._edgeAt(ev.x, ev.y);
    if (edge) {
      this._prop<(e: MouseEvent, x: AnyEdge) => void>('onEdgeContextMenu')?.(
        ev,
        edge,
      );
      return;
    }
    this._prop<(e: MouseEvent) => void>('onPaneContextMenu')?.(ev);
  }

  private _clickNode(ev: MouseEvent, id: string): void {
    const entry = this._byId.get(id);
    if (!entry) return;
    if (ev.detail === 2) {
      this._prop<(e: MouseEvent, n: AnyNode) => void>('onNodeDoubleClick')?.(
        ev,
        entry.node,
      );
      return;
    }
    this._prop<(e: MouseEvent, n: AnyNode) => void>('onNodeClick')?.(
      ev,
      entry.node,
    );
  }

  private _dragStep(
    gesture: Extract<Gesture, { kind: 'drag' }>,
    ev: MouseEvent,
  ): void {
    const zoom = this._viewport().zoom;
    const dx = (ev.x - gesture.startX) / zoom;
    const dy = (ev.y - gesture.startY) / zoom;
    if (
      !gesture.moved &&
      Math.abs(ev.x - gesture.startX) < DRAG_THRESHOLD &&
      Math.abs(ev.y - gesture.startY) < DRAG_THRESHOLD
    ) {
      return;
    }
    if (!gesture.moved) {
      gesture.moved = true;
      const primary = this._byId.get(gesture.primary);
      if (primary) {
        this._prop<(e: MouseEvent, n: AnyNode) => void>('onNodeDragStart')?.(
          ev,
          primary.node,
        );
      }
    }
    const snap = this._bool('snapToGrid', false);
    const grid = this._prop<readonly [number, number]>('snapGrid') ?? [16, 16];
    const to = new Map<string, XYPosition>();
    const changes: NodeChange<unknown>[] = [];
    for (const id of gesture.ids) {
      const origin = gesture.origin.get(id);
      if (!origin) continue;
      let x = origin.x + dx;
      let y = origin.y + dy;
      if (snap) {
        x = snapTo(x, grid[0]);
        y = snapTo(y, grid[1]);
      }
      to.set(id, { x, y });
      changes.push({
        type: 'position',
        id,
        position: { x, y },
        dragging: true,
      });
    }
    this._dragTo = to;
    this._emitNodes(changes);
    this._repaint();
  }

  /** The box a resize is making, reported as it goes. A grip that moves the
   * top or the left edge moves the node too, so both changes go out — an
   * app that applied only one would watch the node crawl. */
  private _resizeStep(
    gesture: Extract<Gesture, { kind: 'resize' }>,
    ev: MouseEvent,
    settling = false,
  ): void {
    const entry = this._byId.get(gesture.id);
    if (!entry) return;
    const zoom = this._viewport().zoom;
    const grid = this._prop<readonly [number, number]>('snapGrid') ?? [16, 16];
    const snap = this._bool('snapToGrid', false)
      ? (value: number, axis: 0 | 1) => snapTo(value, grid[axis])
      : undefined;
    const rect = resizeRect(
      gesture.origin,
      gesture.dir,
      (ev.x - gesture.startX) / zoom,
      (ev.y - gesture.startY) / zoom,
      {
        minWidth: entry.node.minWidth ?? MIN_NODE_WIDTH,
        minHeight: entry.node.minHeight ?? MIN_NODE_HEIGHT,
      },
      snap,
    );
    this._resizeTo = { id: gesture.id, rect };
    const changes: NodeChange<unknown>[] = [
      {
        type: 'dimensions',
        id: gesture.id,
        dimensions: { width: rect.width, height: rect.height },
        resizing: !settling,
      },
    ];
    if (rect.x !== entry.node.position.x || rect.y !== entry.node.position.y) {
      changes.push({
        type: 'position',
        id: gesture.id,
        position: { x: rect.x, y: rect.y },
        dragging: !settling,
      });
    }
    this._emitNodes(changes);
    this._repaint();
  }

  private _connectStep(
    gesture: Extract<Gesture, { kind: 'connect' }>,
    ev: MouseEvent,
  ): void {
    gesture.pointer = this._toGraph(ev.x, ev.y);
    const mode =
      this._prop<'strict' | 'loose'>('connectionMode') === 'loose'
        ? 'loose'
        : 'strict';
    const from = {
      nodeId: gesture.from.nodeId,
      type: gesture.from.type,
      handleId: gesture.from.id ?? null,
    };
    // A handle if the pointer is on one, else the nearest usable handle of
    // the node it is over — dropping on a node is what people try first, and
    // refusing it teaches nothing.
    let to =
      this._handleAt(ev.x, ev.y, (anchor) =>
        canConnect(from, { nodeId: anchor.nodeId, type: anchor.type }, mode),
      ) ?? null;
    if (!to) {
      const entry = this._nodeAt(ev.x, ev.y);
      if (entry && this._connectable(entry) && entry.node.id !== from.nodeId) {
        to = this._endpoint(
          entry,
          null,
          from.type === 'source' ? 'target' : 'source',
          gesture.from,
        );
        if (
          to &&
          !canConnect(from, { nodeId: to.nodeId, type: to.type }, mode)
        ) {
          to = null;
        }
      }
    }
    gesture.to = to;
    gesture.valid = to
      ? this._validConnection(
          orientConnection(from, {
            nodeId: to.nodeId,
            handleId: to.id ?? null,
            type: to.type,
          }),
        )
      : false;
    this._repaint('style-state');
  }

  private _validConnection(connection: {
    source: string;
    target: string;
    sourceHandle: string | null;
    targetHandle: string | null;
  }): boolean {
    const check = this._prop<(c: unknown) => boolean>('isValidConnection');
    return check ? check(connection) !== false : true;
  }

  private _selectBox(gesture: Extract<Gesture, { kind: 'select' }>): void {
    const a = this._toGraph(gesture.startX, gesture.startY);
    const b = this._toGraph(gesture.x, gesture.y);
    const box: FlowRect = {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
    const changes: NodeChange<unknown>[] = [];
    for (const entry of this._entries) {
      if (entry.node.hidden) continue;
      if (
        (entry.node.selectable ?? this._bool('elementsSelectable', true)) ===
        false
      ) {
        continue;
      }
      const inside = rectsOverlap(box, this.rectOf(entry));
      const next = inside || gesture.base.has(entry.node.id);
      if (next !== (entry.node.selected ?? false)) {
        changes.push({ type: 'select', id: entry.node.id, selected: next });
      }
    }
    this._emitNodes(changes);
  }

  // --- input with no default-action seam -----------------------------------

  /** Wheel: zoom about the pointer, or pan when zooming is off. Called by
   * `<Flow>`, after the app's own `onWheel` and only if it did not veto. */
  handleWheel(ev: WheelEvent): void {
    if (this.props.disabled || ev.defaultPrevented) return;
    this._sync();
    const zooming = ev.ctrlKey || this._bool('zoomOnScroll', true);
    if (zooming) {
      // X delivers a notch as ±48; e^(48·0.002) is about a 10% step, which
      // is roughly what a browser does for one detent.
      this._zoomAbout(Math.exp(-ev.deltaY * 0.002), ev.x, ev.y);
    } else {
      const v = this._viewport();
      this._applyViewport({ ...v, x: v.x - ev.deltaX, y: v.y - ev.deltaY });
    }
    ev.preventDefault();
  }

  /** Pointer motion with no button down: hover highlighting. Also from
   * `<Flow>`, for the same reason. */
  handleHover(ev: MouseEvent): void {
    if (this.props.disabled || this._gesture) return;
    this._sync();
    const handle = this._bool('nodesConnectable', true)
      ? this._handleAt(ev.x, ev.y)
      : null;
    const entry = handle ? null : this._nodeAt(ev.x, ev.y);
    const edge = handle || entry ? null : this._edgeAt(ev.x, ev.y);
    const next: HoverState = {
      nodeId: handle?.nodeId ?? entry?.node.id ?? null,
      handle,
      edgeId: edge?.id ?? null,
    };
    if (
      next.nodeId === this._hover.nodeId &&
      next.edgeId === this._hover.edgeId &&
      (next.handle?.id ?? null) === (this._hover.handle?.id ?? null) &&
      (next.handle?.nodeId ?? null) === (this._hover.handle?.nodeId ?? null)
    ) {
      return;
    }
    this._hover = next;
    this._repaint('style-state');
  }

  handleLeave(): void {
    if (this._hover === NO_HOVER) return;
    this._hover = NO_HOVER;
    this._repaint('style-state');
  }

  // --- keyboard ------------------------------------------------------------

  override defaultKeyDown(ev: KeyboardEvent): void {
    if (this.props.disabled) return;
    this._sync();
    const { keysym } = ev;

    if (ev.ctrlKey) {
      const letter = ctrlChordLetter(ev);
      if (letter === keysymOf('a')) {
        this._selectAll();
        ev.preventDefault();
      }
      return;
    }

    if (
      (keysym === XK_DELETE || keysym === XK_BACKSPACE) &&
      this._bool('deleteOnKey', true)
    ) {
      this._deleteSelection();
      ev.preventDefault();
      return;
    }
    if (keysym === XK_ESCAPE) {
      if (this._gesture) {
        this._gesture = null;
        this._dragTo = null;
        this._resizeTo = null;
        this._repaint();
      } else {
        this._select(null, false);
      }
      ev.preventDefault();
      return;
    }
    if (keysym === XK_HOME || ev.key === '0') {
      this.fitView();
      ev.preventDefault();
      return;
    }
    if (ev.key === '+' || ev.key === '=') {
      this.zoomIn();
      ev.preventDefault();
      return;
    }
    if (ev.key === '-' || ev.key === '_') {
      this.zoomOut();
      ev.preventDefault();
      return;
    }

    const step = ev.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    if (keysym === XK_LEFT) dx = -step;
    else if (keysym === XK_RIGHT) dx = step;
    else if (keysym === XK_UP) dy = -step;
    else if (keysym === XK_DOWN) dy = step;
    if (dx === 0 && dy === 0) return;

    const ids = this._selectedNodeIds();
    if (ids.length === 0) {
      // Nothing selected: the arrows pan, which is the only thing left for
      // them to mean and is what every canvas does.
      const v = this._viewport();
      this._applyViewport({ ...v, x: v.x - dx * 20, y: v.y - dy * 20 });
      ev.preventDefault();
      return;
    }
    this._emitNodes(
      ids.map((id) => {
        const node = this._byId.get(id)!.node;
        return {
          type: 'position' as const,
          id,
          position: { x: node.position.x + dx, y: node.position.y + dy },
          dragging: false,
        };
      }),
    );
    ev.preventDefault();
  }

  private _selectAll(): void {
    if (!this._bool('elementsSelectable', true)) return;
    this._emitNodes(
      this._entries
        .filter((e) => !e.node.selected && !e.node.hidden)
        .map((e) => ({
          type: 'select' as const,
          id: e.node.id,
          selected: true,
        })),
    );
    this._emitEdges(
      this._edges
        .filter((e) => !e.selected && !e.hidden)
        .map((e) => ({ type: 'select' as const, id: e.id, selected: true })),
    );
  }

  /**
   * Remove what is selected — and, with the nodes, the edges that would
   * otherwise dangle. Emitted as changes like everything else, so an app
   * that wants a confirmation step simply does not apply them.
   */
  private _deleteSelection(): void {
    const nodeIds = this._entries
      .filter((e) => e.node.selected && e.node.deletable !== false)
      .map((e) => e.node.id);
    const gone = new Set(nodeIds);
    const edgeIds = this._edges
      .filter(
        (e) =>
          e.deletable !== false &&
          (e.selected || gone.has(e.source) || gone.has(e.target)),
      )
      .map((e) => e.id);
    this._emitEdges(edgeIds.map((id) => ({ type: 'remove' as const, id })));
    this._emitNodes(nodeIds.map((id) => ({ type: 'remove' as const, id })));
  }

  // --- lifecycle -----------------------------------------------------------

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    const before = prevProps ?? this.props;
    super.applyProps(nextProps, prevProps);
    if (
      nextProps.nodes !== before.nodes ||
      nextProps.edges !== before.edges ||
      nextProps.nodeTypes !== before.nodeTypes ||
      nextProps.defaultEdgeOptions !== before.defaultEdgeOptions
    ) {
      this._sync();
    }
    // `fitView` is a one-shot: turning it on later refits, and it stays off
    // through every unrelated re-render in between.
    if (nextProps.fitView === true && before.fitView !== true) {
      this._fitPending = true;
    }
    // Unconditional, and cheap because the damage is this node's rect: the
    // pane draws from a dozen props (`palette`, `background`, `minimap`, the
    // controls) and enumerating them here is a list that goes stale silently
    // — a colour that does not change until the next unrelated repaint.
    this._repaint('props');
  }

  override destroySubtree(): void {
    this._stopAnimation();
    super.destroySubtree();
  }

  private _startAnimation(): void {
    if (this._animTimer != null) return;
    this._animTimer =
      timers.setInterval?.(() => {
        this._dashPhase += ANIMATION_SPEED;
        this.invalidate(false, this.abs, 'animation');
      }, ANIMATION_MS) ?? null;
  }

  private _stopAnimation(): void {
    if (this._animTimer == null) return;
    timers.clearInterval?.(this._animTimer);
    this._animTimer = null;
  }

  // --- painting ------------------------------------------------------------

  override paint(ctx: Context2D): void {
    // background, border and the node's own box
    super.paint(ctx);
    if (!this._visible()) return;
    const painter = createPainter(ctx, this._textOptions());
    if (!painter) return; // a backend with no path API: geometry only

    this._sync();
    this._painting = true;
    if (this._fitPending) {
      // Deferred to the first paint that has a size: `fitView` is asked for
      // before layout has run, and framing a graph in a zero-sized pane is
      // not an answer.
      this._fitPending = false;
      this._fit(this._prop<FitViewOptions>('fitViewOptions'));
    }

    const palette = this._palette();
    const { x, y, width, height } = this._pane();
    painter.save();
    // `Node.paint` clips *children*, and this element has none — its drawing
    // happens after `super.paint` returned, outside any clip of its own. The
    // clip is the content box rather than `abs` because the border has been
    // stroked already, inside the box, and drawing over it would leave a
    // `borderWidth: 1` looking like half of one.
    const radius = Math.max(
      0,
      ((this.style.borderRadius as number | undefined) ?? 0) -
        ((this.style.borderWidth as number | undefined) ?? 0),
    );
    painter.clipRect(x, y, width, height, radius);
    // The style's own colour if it set one — `super.paint` already filled
    // it, and repeating it costs one rectangle and keeps the two agreeing.
    painter.rect(x, y, width, height, 0, {
      fill:
        (this.style.backgroundColor as string | undefined) ??
        palette.background,
    });

    this._paintGrid(painter, palette);
    const animated = this._paintEdges(painter, palette);
    this._paintNodes(painter, palette);
    this._paintConnection(painter, palette);
    this._paintSelectionBox(painter, palette);
    this._paintMiniMap(painter, palette);
    this._paintControls(painter, palette);
    painter.restore();
    this._painting = false;

    // The timer exists only while something on screen needs it.
    if (animated) this._startAnimation();
    else this._stopAnimation();

    // Last, and outside the drawing: this is what tells the React half where
    // to put the node bodies it mounts, and it is answered from the geometry
    // this frame just used — the same numbers, never a second derivation.
    this._emitBodies();
  }

  /**
   * Where every mounted node body belongs, relative to the pane's own
   * top-left. Sent only when the list changed, so a repaint that moved
   * nothing does not re-render React — but a pan does, once per frame,
   * which is the cost `render` is documented to carry.
   */
  private _emitBodies(): void {
    const notify =
      this._prop<(bodies: readonly NodeBodyRect[]) => void>('onNodeBodies');
    if (!notify) return;
    const v = this._viewport();
    const pane = this._pane();
    const bodies: NodeBodyRect[] = [];
    for (const entry of this._order) {
      if (entry.node.hidden || !this._mounted(entry)) continue;
      const rect = this._screenRect(entry);
      if (!rectsOverlap(rect, pane)) continue;
      const header = this._headerHeight(entry) * v.zoom;
      const inset = NODE_BODY_INSET * v.zoom;
      const width = rect.width - inset * 2;
      const height = rect.height - header - inset;
      if (width <= 1 || height <= 1) continue;
      bodies.push({
        id: entry.node.id,
        // pane-relative, because that is what an absolutely positioned box
        // beside the pane is laid out against
        x: Math.round(rect.x + inset - pane.x),
        y: Math.round(rect.y + header - pane.y),
        width: Math.round(width),
        height: Math.round(height),
        zoom: v.zoom,
        selected: entry.node.selected ?? false,
      });
    }
    const key = bodies
      .map((b) => `${b.id}:${b.x},${b.y},${b.width},${b.height},${b.selected}`)
      .join('|');
    if (key === this._bodiesKey) return;
    this._bodiesKey = key;
    notify(bodies);
  }

  private _paintGrid(painter: FlowPainter, palette: FlowPalette): void {
    const options = normalizeBackground(
      this.props.background as BackgroundOptions | string | boolean | undefined,
    );
    if (options.variant === 'none') return;
    const v = this._viewport();
    let step = options.gap * v.zoom;
    if (!(step > 0)) return;
    // Doubling rather than clamping keeps the grid *aligned* to the graph
    // while zooming out: every visible line is still a real one.
    while (step < MIN_GRID_PX) step *= 2;
    const color = options.color ?? palette.grid;
    const { x, y, width, height } = this._pane();
    const originX = x + v.x;
    const originY = y + v.y;
    const firstX = originX + Math.ceil((x - originX) / step) * step;
    const firstY = originY + Math.ceil((y - originY) / step) * step;

    if (options.variant === 'lines') {
      const runs: XYPosition[][] = [];
      for (let gx = firstX; gx <= x + width; gx += step) {
        runs.push([
          { x: gx, y },
          { x: gx, y: y + height },
        ]);
      }
      for (let gy = firstY; gy <= y + height; gy += step) {
        runs.push([
          { x, y: gy },
          { x: x + width, y: gy },
        ]);
      }
      painter.strokeRuns(runs, { stroke: color, lineWidth: 1 });
      return;
    }

    if (options.variant === 'cross') {
      const arm = Math.max(2, options.size * 3 * v.zoom);
      const runs: XYPosition[][] = [];
      for (let gx = firstX; gx <= x + width; gx += step) {
        for (let gy = firstY; gy <= y + height; gy += step) {
          runs.push([
            { x: gx - arm, y: gy },
            { x: gx + arm, y: gy },
          ]);
          runs.push([
            { x: gx, y: gy - arm },
            { x: gx, y: gy + arm },
          ]);
        }
      }
      painter.strokeRuns(runs, { stroke: color, lineWidth: 1 });
      return;
    }

    const centres: XYPosition[] = [];
    for (let gx = firstX; gx <= x + width; gx += step) {
      for (let gy = firstY; gy <= y + height; gy += step) {
        centres.push({ x: gx, y: gy });
      }
    }
    painter.dots(
      centres,
      Math.max(1, Math.round(options.size * 2 * v.zoom)),
      color,
    );
  }

  /** Draws every visible edge; answers whether any of them is animated, so
   * the caller knows whether to keep a timer alive. */
  private _paintEdges(painter: FlowPainter, palette: FlowPalette): boolean {
    const v = this._viewport();
    const pane = this._pane();
    const labels = v.zoom >= LABEL_ZOOM;
    let animated = false;

    for (const edge of this._edges) {
      if (edge.hidden) continue;
      // two rejects: one from the nodes alone, one from the route it took
      const coarse = this._edgeCoarseBox(edge);
      if (!coarse || !rectsOverlap(coarse, pane)) continue;
      const geometry = this._edgeGeometry(edge);
      if (!geometry) continue;
      if (!rectsOverlap(pathBounds(geometry.points), pane)) continue;

      const selected = edge.selected ?? false;
      const hovered = this._hover.edgeId === edge.id;
      const stroke =
        edge.style?.stroke ??
        (selected
          ? palette.edgeSelected
          : hovered
            ? palette.text
            : palette.edge);
      const lineWidth = Math.max(
        1,
        (edge.style?.strokeWidth ?? (selected ? 2 : 1.5)) * v.zoom,
      );
      // `markerEnd` left out means an arrow: a directed graph whose edges do
      // not say which way they point is a set of lines. `null` opts out.
      const markerEnd = normalizeMarker(
        edge.markerEnd === undefined ? 'arrowclosed' : edge.markerEnd,
      );
      const markerStart = normalizeMarker(edge.markerStart);

      // The tip stops short of the handle rather than at it: the handle dot
      // is drawn *over* the edges, with the nodes, so an arrow aimed at the
      // handle's centre is an arrow mostly hidden under a white circle.
      const inset = v.zoom >= HANDLE_ZOOM ? this._handleRadius() + 1 : 1;
      const last = geometry.points[geometry.points.length - 1];
      const outAngle = endAngle(geometry.points);
      const endTip = {
        x: last.x - Math.cos(outAngle) * inset,
        y: last.y - Math.sin(outAngle) * inset,
      };
      let points = geometry.points;
      if (markerEnd) {
        // and the stroke stops behind the head, so a filled triangle is a
        // triangle rather than a triangle with a line through it
        points = trimEnd(
          points,
          (markerEnd.size ?? DEFAULT_MARKER_SIZE) * v.zoom * 0.8 + inset,
        );
      }
      const dash =
        edge.style?.dash ?? (edge.animated ? DEFAULT_DASH : undefined);
      if (edge.animated) animated = true;
      painter.polyline(points, {
        stroke,
        lineWidth,
        dash: dash ? dash.map((d) => d * v.zoom) : undefined,
        dashOffset: edge.animated ? -this._dashPhase * v.zoom : 0,
      });

      if (markerEnd) {
        this._paintMarker(
          painter,
          endTip,
          outAngle,
          markerEnd.type,
          markerEnd.color ?? stroke,
          (markerEnd.size ?? DEFAULT_MARKER_SIZE) * v.zoom,
          lineWidth,
        );
      }
      if (markerStart) {
        const inAngle = startAngle(geometry.points);
        this._paintMarker(
          painter,
          {
            x: geometry.points[0].x - Math.cos(inAngle) * inset,
            y: geometry.points[0].y - Math.sin(inAngle) * inset,
          },
          inAngle,
          markerStart.type,
          markerStart.color ?? stroke,
          (markerStart.size ?? DEFAULT_MARKER_SIZE) * v.zoom,
          lineWidth,
        );
      }

      if (labels && edge.label) {
        const at = pointAtFraction(geometry.points, 0.5);
        const size = Math.max(8, 11 * v.zoom);
        const metrics = painter.measureText(edge.label, { size });
        const padX = 5 * v.zoom;
        const padY = 2 * v.zoom;
        painter.rect(
          at.x - metrics.width / 2 - padX,
          at.y - metrics.height / 2 - padY,
          metrics.width + padX * 2,
          metrics.height + padY * 2,
          Math.max(2, 3 * v.zoom),
          {
            fill: edge.style?.labelBackground ?? tint(palette.background, 0.92),
            stroke: selected ? stroke : undefined,
            lineWidth: 1,
          },
        );
        painter.text(edge.label, at.x, at.y, {
          size,
          color: edge.style?.labelColor ?? palette.text,
          align: 'center',
          baseline: 'middle',
        });
      }
    }
    return animated;
  }

  private _paintMarker(
    painter: FlowPainter,
    at: XYPosition,
    angle: number,
    type: 'arrow' | 'arrowclosed',
    color: string,
    size: number,
    lineWidth: number,
  ): void {
    const spread = 0.42; // radians off the shaft — a ~24° half-angle
    const back = {
      x: at.x - Math.cos(angle) * size,
      y: at.y - Math.sin(angle) * size,
    };
    const left = {
      x: at.x - Math.cos(angle - spread) * size,
      y: at.y - Math.sin(angle - spread) * size,
    };
    const right = {
      x: at.x - Math.cos(angle + spread) * size,
      y: at.y - Math.sin(angle + spread) * size,
    };
    if (type === 'arrowclosed') {
      painter.polygon([at, left, back, right], { fill: color });
    } else {
      painter.strokeRuns([[left, at, right]], { stroke: color, lineWidth });
    }
  }

  private _paintNodes(painter: FlowPainter, palette: FlowPalette): void {
    const dragging = this._dragTo;
    const deferred: NodeEntry[] = [];
    for (const entry of this._order) {
      if (dragging?.has(entry.node.id)) {
        deferred.push(entry); // a dragged node comes to the top
        continue;
      }
      this._paintNode(painter, palette, entry);
    }
    for (const entry of deferred) this._paintNode(painter, palette, entry);
  }

  private _paintNode(
    painter: FlowPainter,
    palette: FlowPalette,
    entry: NodeEntry,
  ): void {
    if (entry.node.hidden) return;
    const rect = this._screenRect(entry);
    if (!rectsOverlap(rect, this._pane())) return;
    const v = this._viewport();
    const selected = entry.node.selected ?? false;
    const hovered = this._hover.nodeId === entry.node.id;
    const handles = this._handlesOf(entry).map((anchor) => {
      const s = this._toScreen(anchor);
      return { ...anchor, x: s.x, y: s.y };
    });

    if (entry.type?.paint) {
      entry.type.paint({
        node: entry.node,
        rect,
        zoom: v.zoom,
        selected,
        hovered,
        palette,
        painter,
        handles,
      });
    } else {
      // A node whose body is mounted keeps its title in the header strip;
      // one whose body is drawn centres it. The card is the same card.
      const header = this._mounted(entry) ? this._headerHeight(entry) : 0;
      this._paintCard(painter, palette, entry, rect, selected, hovered, header);
    }

    if (this._connectable(entry) && (v.zoom >= HANDLE_ZOOM || hovered)) {
      this._paintHandles(painter, palette, handles);
    }
    this._paintGrips(painter, palette, entry, rect);
  }

  /** Is this node's React body on screen? Below `RENDER_ZOOM` it is not
   * mounted, and the pane draws the whole card instead. */
  private _mounted(entry: NodeEntry): boolean {
    return entry.type?.render != null && this._viewport().zoom >= RENDER_ZOOM;
  }

  private _paintGrips(
    painter: FlowPainter,
    palette: FlowPalette,
    entry: NodeEntry,
    rect: FlowRect,
  ): void {
    const grips = this._grips(entry);
    if (grips.length === 0) return;
    const size = Math.max(4, RESIZE_GRIP * 2 * this._viewport().zoom);
    for (const dir of grips) {
      const at = gripPoint(rect, dir);
      painter.rect(at.x - size / 2, at.y - size / 2, size, size, 1, {
        fill: palette.nodeBackground,
        stroke: palette.accent,
        lineWidth: 1.5,
      });
    }
  }

  /** The built-in node: a card with a label, an optional second line and an
   * optional accent stripe down its leading edge. */
  private _paintCard(
    painter: FlowPainter,
    palette: FlowPalette,
    entry: NodeEntry,
    rect: FlowRect,
    selected: boolean,
    hovered: boolean,
    header: number,
  ): void {
    const v = this._viewport();
    const style = entry.node.style;
    const radius = (style?.borderRadius ?? 6) * v.zoom;
    const border = selected
      ? palette.accent
      : hovered
        ? tint(palette.accent, 0.55)
        : (style?.borderColor ?? palette.nodeBorder);
    painter.rect(rect.x, rect.y, rect.width, rect.height, radius, {
      fill: style?.background ?? palette.nodeBackground,
      stroke: border,
      lineWidth: Math.max(
        1,
        (style?.borderWidth ?? (selected ? 2 : 1)) * v.zoom,
      ),
    });

    if (style?.accent) {
      painter.save();
      painter.clipRect(rect.x, rect.y, rect.width, rect.height, radius);
      painter.rect(rect.x, rect.y, Math.max(2, 3 * v.zoom), rect.height, 0, {
        fill: style.accent,
      });
      painter.restore();
    }

    if (v.zoom < LABEL_ZOOM) return;
    const data = entry.node.data as FlowNodeData | undefined;
    const label = data?.label ?? entry.node.id;
    const description = data?.description;
    const color = style?.color ?? palette.text;
    const padX = NODE_PAD_X * v.zoom;
    const centre = rect.x + rect.width / 2;
    const maxWidth = Math.max(8, rect.width - padX * 2);
    const showDescription = Boolean(description) && v.zoom >= DESC_ZOOM;

    if (header > 0) {
      // The title bar of a node whose body is somebody else's: left-aligned,
      // with a hairline under it so the strip reads as the thing to grab.
      const band = header * v.zoom;
      painter.text(label, rect.x + padX, rect.y + band / 2, {
        size: NODE_LABEL_SIZE * v.zoom,
        weight: 'bold',
        color,
        baseline: 'middle',
        maxWidth,
      });
      painter.strokeRuns(
        [
          [
            { x: rect.x + 1, y: rect.y + band },
            { x: rect.x + rect.width - 1, y: rect.y + band },
          ],
        ],
        { stroke: palette.nodeBorder, lineWidth: 1 },
      );
      return;
    }

    if (!showDescription) {
      painter.text(label, centre, rect.y + rect.height / 2, {
        size: NODE_LABEL_SIZE * v.zoom,
        weight: 'bold',
        color,
        align: 'center',
        baseline: 'middle',
        maxWidth,
      });
      return;
    }
    const top = rect.y + NODE_PAD_Y * v.zoom;
    painter.text(label, centre, top, {
      size: NODE_LABEL_SIZE * v.zoom,
      weight: 'bold',
      color,
      align: 'center',
      maxWidth,
    });
    painter.text(description!, centre, top + NODE_LABEL_SIZE * 1.35 * v.zoom, {
      size: NODE_DESC_SIZE * v.zoom,
      color: palette.dim,
      align: 'center',
      maxWidth,
    });
  }

  private _paintHandles(
    painter: FlowPainter,
    palette: FlowPalette,
    handles: readonly HandleAnchor[],
  ): void {
    const v = this._viewport();
    const radius = this._handleRadius();
    const gesture = this._gesture;
    const connecting = gesture?.kind === 'connect' ? gesture : null;
    for (const anchor of handles) {
      const active =
        sameHandle(this._hover.handle, anchor) ||
        sameHandle(connecting?.to ?? null, anchor) ||
        sameHandle(connecting?.from ?? null, anchor);
      painter.circle(anchor.x, anchor.y, active ? radius * 1.4 : radius, {
        fill: active ? palette.accent : palette.nodeBackground,
        stroke: active ? palette.accent : palette.handle,
        lineWidth: Math.max(1, 1.5 * v.zoom),
      });
      if (anchor.label && v.zoom >= DESC_ZOOM) {
        const outside = anchor.position === 'left' || anchor.position === 'top';
        painter.text(
          anchor.label,
          anchor.x +
            (anchor.position === 'left'
              ? -radius - 4 * v.zoom
              : radius + 4 * v.zoom),
          anchor.y,
          {
            size: 10 * v.zoom,
            color: palette.dim,
            align: outside ? 'right' : 'left',
            baseline: 'middle',
          },
        );
      }
    }
  }

  private _paintConnection(painter: FlowPainter, palette: FlowPalette): void {
    const gesture = this._gesture;
    if (gesture?.kind !== 'connect') return;
    const v = this._viewport();
    const from = this._toScreen(gesture.from);
    const target = gesture.to ?? gesture.pointer;
    const to = this._toScreen(target);
    const toPosition =
      gesture.to?.position ??
      (gesture.from.position === 'left'
        ? 'right'
        : gesture.from.position === 'right'
          ? 'left'
          : gesture.from.position === 'top'
            ? 'bottom'
            : 'top');
    const points = edgePath(
      'bezier',
      { x: from.x, y: from.y, position: gesture.from.position },
      { x: to.x, y: to.y, position: toPosition },
      {
        stepOffset: EDGE_STEP_OFFSET * v.zoom,
        radius: 8 * v.zoom,
        scale: v.zoom,
      },
    );
    const invalid = gesture.to != null && !gesture.valid;
    painter.polyline(points, {
      stroke: invalid ? palette.dim : palette.accent,
      lineWidth: Math.max(1.5, 2 * v.zoom),
      dash: gesture.to && gesture.valid ? undefined : [5 * v.zoom, 4 * v.zoom],
    });
    painter.circle(to.x, to.y, this._handleRadius(), {
      fill: invalid ? palette.dim : palette.accent,
    });
  }

  private _paintSelectionBox(painter: FlowPainter, palette: FlowPalette): void {
    const gesture = this._gesture;
    if (gesture?.kind !== 'select') return;
    const x = Math.min(gesture.startX, gesture.x);
    const y = Math.min(gesture.startY, gesture.y);
    painter.rect(
      x,
      y,
      Math.abs(gesture.x - gesture.startX),
      Math.abs(gesture.y - gesture.startY),
      2,
      { fill: palette.selection, stroke: palette.accent, lineWidth: 1 },
    );
  }

  private _paintMiniMap(painter: FlowPainter, palette: FlowPalette): void {
    const map = this._miniMap();
    if (!map) return;
    const { panel, options } = map;
    painter.rect(panel.x, panel.y, panel.width, panel.height, 4, {
      fill: tint(palette.surface, 0.92),
      stroke: palette.surfaceBorder,
      lineWidth: 1,
    });
    painter.save();
    painter.clipRect(panel.x, panel.y, panel.width, panel.height, 4);

    const nodeColor = options.nodeColor;
    for (const entry of this._entries) {
      if (entry.node.hidden) continue;
      const rect = this.rectOf(entry);
      const at = this._miniToScreen(map, rect);
      const fill =
        typeof nodeColor === 'function'
          ? nodeColor(entry.node as FlowNode<never>)
          : (nodeColor ??
            (entry.node.selected ? palette.accent : palette.nodeBorder));
      painter.rect(
        at.x,
        at.y,
        Math.max(1, rect.width * map.scale),
        Math.max(1, rect.height * map.scale),
        0,
        { fill },
      );
    }

    // The viewport, as an outline over a wash on everything outside it —
    // cheaper than four mask rectangles and reads the same.
    const v = this._viewport();
    const paneRect = this._pane();
    const view = this._miniToScreen(map, {
      x: -v.x / v.zoom,
      y: -v.y / v.zoom,
    });
    painter.rect(
      view.x,
      view.y,
      (paneRect.width / v.zoom) * map.scale,
      (paneRect.height / v.zoom) * map.scale,
      2,
      {
        fill: options.maskColor ?? tint(palette.accent, 0.1),
        stroke: palette.accent,
        lineWidth: 1,
      },
    );
    painter.restore();
  }

  private _paintControls(painter: FlowPainter, palette: FlowPalette): void {
    const buttons = this._controlButtons();
    if (buttons.length === 0) return;
    const first = buttons[0].rect;
    const last = buttons[buttons.length - 1].rect;
    painter.rect(
      first.x,
      first.y,
      first.width,
      last.y + last.height - first.y,
      4,
      {
        fill: tint(palette.surface, 0.94),
        stroke: palette.surfaceBorder,
        lineWidth: 1,
      },
    );
    for (let i = 0; i < buttons.length; i++) {
      const { rect, action } = buttons[i];
      if (i > 0) {
        painter.strokeRuns(
          [
            [
              { x: rect.x + 4, y: rect.y },
              { x: rect.x + rect.width - 4, y: rect.y },
            ],
          ],
          { stroke: palette.surfaceBorder, lineWidth: 1 },
        );
      }
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const arm = 5;
      const runs: XYPosition[][] = [];
      if (action === 'in' || action === 'out') {
        runs.push([
          { x: cx - arm, y: cy },
          { x: cx + arm, y: cy },
        ]);
        if (action === 'in') {
          runs.push([
            { x: cx, y: cy - arm },
            { x: cx, y: cy + arm },
          ]);
        }
      } else {
        // a frame with its sides opened out: "fit what is there into this"
        const a = 5;
        runs.push(
          [
            { x: cx - a, y: cy - a + 3 },
            { x: cx - a, y: cy - a },
            { x: cx - a + 3, y: cy - a },
          ],
          [
            { x: cx + a - 3, y: cy - a },
            { x: cx + a, y: cy - a },
            { x: cx + a, y: cy - a + 3 },
          ],
          [
            { x: cx + a, y: cy + a - 3 },
            { x: cx + a, y: cy + a },
            { x: cx + a - 3, y: cy + a },
          ],
          [
            { x: cx - a + 3, y: cy + a },
            { x: cx - a, y: cy + a },
            { x: cx - a, y: cy + a - 3 },
          ],
        );
      }
      painter.strokeRuns(runs, { stroke: palette.text, lineWidth: 1.5 });
    }
  }
}
