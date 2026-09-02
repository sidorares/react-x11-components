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
// `preventDefault()`. The wheel and plain pointer motion have no such seam
// (filed as react-x11#302), so `<Flow>` forwards those two through
// `handleWheel`/`handleHover` — with the same veto, checked here.
import * as ntk from 'react-x11/ntk';
import { Node } from 'react-x11/node';
import type { A11ySceneAction, A11ySceneItem } from 'react-x11/node';
import type { Context2D } from 'react-x11/node';
import { tint } from 'react-x11/style';
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

import { createPainter, measureText, toDevice } from './draw.js';
import type { CachedText, FontsLike, PainterOptions } from './draw.js';
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
  inflateRect,
  intersectRects,
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
  unionRects,
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
  BackgroundVariant,
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
  ShapeOptions,
  StrokeOptions,
  TextOptions,
  Viewport,
  XYPosition,
} from './types.js';

/** Registration key, `kind` and JSX tag, one string — react-x11 rejects a
 * node whose `kind` is not the name it was registered under, because `kind`
 * is what paint order, the test queries and the DEV style assertion all
 * match on. */
export const ELEMENT = 'flowgraph';

/** The slice of ntk's Surface/pattern API the grid tile uses, typed here
 * structurally — `react-x11/ntk`'s declarations are deliberately loose. */
interface SurfaceLike {
  render(fn: (ctx: TileContext) => void): unknown;
  destroy?(): void;
}
interface TileContext {
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect?(x: number, y: number, w: number, h: number): void;
}
type SurfaceCtor = new (
  app: unknown,
  options: { width: number; height: number; format: string },
) => SurfaceLike;
interface PatternLike {
  _picture?: { destroy?(): void };
}

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
const LABEL_ZOOM = 0.45;
const HANDLE_ZOOM = 0.5;
const DESC_ZOOM = 0.6;

/** Screen pixels the pointer may travel before a press becomes a drag. */
const DRAG_THRESHOLD = 3;
/** The grid never draws denser than this on screen, whatever the zoom. */
const MIN_GRID_PX = 16;

/** See `StrokeBuckets.BATCH_MIN`. */
const MARKER_BATCH_MIN = 24;

/**
 * How far outside its own box a node's ink can land: handles (capped at
 * 6 × 1.4 plus their outline), resize grips, the selection border, a pixel
 * of antialiasing. Damage rects grow by this before they are invalidated,
 * and cull tests grow their target by the same amount — the two must agree,
 * or a moved node leaves crumbs of its old handles behind.
 */
const CULL_MARGIN = 16;

/**
 * The props whose change means different pixels. `applyProps` repaints when
 * one of these moves and stays quiet otherwise — the event handlers are
 * recreated on every render of the component above, and a full repaint per
 * re-render is what made dragging repaint the world twice.
 *
 * Compared by shallow value, not identity: `background={{ variant: 'dots' }}`
 * written inline is a new object on every render of the app, and treating
 * that as a change would put the full repaint right back.
 */
const VISUAL_PROPS = [
  'background',
  'minimap',
  'controls',
  'palette',
  'viewport',
  'minZoom',
  'maxZoom',
  'nodesConnectable',
  'nodesResizable',
  'disabled',
] as const;

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
      /** Where the line was last drawn, so the next step can erase it. */
      box?: FlowRect;
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

/** The rectangle a box-selection gesture spans on screen. */
function selectBoxRect(g: {
  startX: number;
  startY: number;
  x: number;
  y: number;
}): FlowRect {
  return {
    x: Math.min(g.startX, g.x),
    y: Math.min(g.startY, g.y),
    width: Math.abs(g.x - g.startX),
    height: Math.abs(g.y - g.startY),
  };
}

/**
 * The props whose repaints this element claims for itself — everything
 * `applyProps` below either diffs into a damage rect (`nodes`, `edges`…),
 * repaints in full when it truly changed (the visual list), or that changes
 * behaviour without touching a pixel (`snapToGrid`, the gesture switches).
 * Declared to `registerElement` as `selfDamagedProps`, so core's per-commit
 * `paintChanged` contributes no damage for them — without the declaration,
 * every drag step is a full-pane repaint again, because the commit's new
 * `nodes` array identity would damage the whole node.
 */
export const SELF_DAMAGED_PROPS: readonly string[] = [
  'nodes',
  'edges',
  'nodeTypes',
  'defaultEdgeOptions',
  ...VISUAL_PROPS,
  'defaultViewport',
  'fitView',
  'fitViewOptions',
  'isValidConnection',
  'connectionMode',
  'nodesDraggable',
  'elementsSelectable',
  'panOnDrag',
  'zoomOnScroll',
  'zoomOnDoubleClick',
  'selectionOnDrag',
  'deleteOnKey',
  'snapToGrid',
  'snapGrid',
];

/** Two edges saying the same thing, whatever the object identity. `style`
 * and the markers compare one level deep; `data` is the app's and compares
 * by identity, the same rule the node diff applies. */
function edgeValueEqual(a: AnyEdge, b: AnyEdge): boolean {
  return (
    a.source === b.source &&
    a.target === b.target &&
    (a.sourceHandle ?? null) === (b.sourceHandle ?? null) &&
    (a.targetHandle ?? null) === (b.targetHandle ?? null) &&
    a.type === b.type &&
    a.label === b.label &&
    a.animated === b.animated &&
    a.selected === b.selected &&
    a.hidden === b.hidden &&
    a.selectable === b.selectable &&
    a.deletable === b.deletable &&
    a.zIndex === b.zIndex &&
    a.data === b.data &&
    shallowEqual(a.style, b.style) &&
    shallowEqual(a.markerEnd, b.markerEnd) &&
    shallowEqual(a.markerStart, b.markerStart)
  );
}

/** One level of value equality, for the object-shaped props above. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (
      !Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Union where either side may be missing. */
function unionMaybe(a: FlowRect | null, b: FlowRect | null): FlowRect | null {
  if (!a) return b;
  if (!b) return a;
  return unionRects(a, b);
}

/** An arrowhead pile: the filled heads and the open ones share a colour, so
 * they share a bucket and differ only in which list they land in. */
interface MarkerBucket {
  color: string;
  lineWidth: number;
  filled: XYPosition[][];
  open: XYPosition[][];
}

/**
 * Edge strokes, grouped by the pen that will draw them.
 *
 * Everything a graph strokes is the same two or three pens — the default
 * edge, the selected one, the animated dash — so grouping collapses a
 * per-edge request into a per-pen one. The key has to carry the dash *and*
 * its offset: two edges marching out of phase cannot share a path, because
 * the offset is set on the context, not on the subpath.
 */
class StrokeBuckets {
  private readonly byPen = new Map<
    string,
    { options: StrokeOptions; runs: XYPosition[][] }
  >();

  bucket(
    stroke: string,
    lineWidth: number,
    dash: readonly number[] | undefined,
    phase: number,
    zoom: number,
  ): XYPosition[][] {
    const scaled = dash?.map((d) => d * zoom);
    const key = `${stroke}|${lineWidth}|${scaled?.join(',') ?? ''}|${phase}`;
    let entry = this.byPen.get(key);
    if (!entry) {
      entry = {
        options: {
          stroke,
          lineWidth,
          dash: scaled,
          dashOffset: phase ? -phase * zoom : 0,
        },
        runs: [],
      };
      this.byPen.set(key, entry);
    }
    return entry.runs;
  }

  /**
   * Below this many edges in one pen, they are stroked one at a time.
   *
   * A path's mask is its bounding box, so batching scattered geometry trades
   * many small masks for one the size of the pane — about three quarters of
   * a megabyte at a normal window size. That is a large win at seven hundred
   * edges (measured: 3.9 MB a frame down to 1.3) and a loss at twenty, where
   * the individual masks never add up to a paneful. The threshold is where
   * they start to.
   */
  private static readonly BATCH_MIN = 24;

  paint(painter: FlowPainter): void {
    for (const { options, runs } of this.byPen.values()) {
      if (runs.length >= StrokeBuckets.BATCH_MIN) {
        painter.strokeRuns(runs, options);
      } else {
        for (const run of runs) painter.polyline(run, options);
      }
    }
  }
}

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
  private _edgesByNode = new Map<string, AnyEdge[]>();
  /** The prop array the built edges came from, for the per-edge diff. */
  private _edgesRaw: AnyEdge[] = [];
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
  /** Inside a live input dispatch — what makes a body emission `sync`.
   * Motion and the wheel run at continuous priority, whose React updates
   * can trail the pane's own painting by frames; an emission made under
   * this flag asks the receiver to commit before the dispatch returns. */
  private _gestureSync = false;
  /** The scene has been offered to assistive tech at least once — items
   * only exist once layout has placed them, which no commit marks. */
  private _sceneAnnounced = false;
  /** The damage rect of the pass being painted, or null for a full one —
   * what the drawing subroutines cull against. */
  private _frameClip: FlowRect | null = null;
  /** Where the animated edges were last frame, so the dash timer can
   * invalidate that box instead of the whole pane. */
  private _animBox: FlowRect | null = null;

  private _textCache = new Map<string, CachedText>();
  /** The grid's repeating tile: one surface for as long as the pitch
   * holds, re-rendered in place when the phase or the colours move. */
  private _gridTile: {
    key: string;
    size: number;
    surface: SurfaceLike;
    pattern: PatternLike;
  } | null = null;

  constructor(props: Record<string, unknown>, app: unknown) {
    super(ELEMENT, props, app as ConstructorParameters<typeof Node>[2]);
    // Without this nothing focuses the pane and no key ever reaches it; an
    // app's `focusable`/`tabIndex` still overrides either way.
    this.focusableByDefault = true;
    // What the element is to a screen reader when the app says nothing —
    // the scene below fills in what is inside it.
    this.a11yRole = 'group';
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
      scale: this._scale,
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
    const types = this.props.nodeTypes;
    const opts = this._textOptions();
    const fontKey = `${opts.family}|${this._fonts() ? 1 : 0}`;
    if (types !== this._typesSeen || fontKey !== this._fontSeen) {
      this._typesSeen = types;
      this._fontSeen = fontKey;
      this._nodesSeen = this.props.nodes;
      this._rebuildNodes();
    } else if (this.props.nodes !== this._nodesSeen) {
      this._applyNodes(this._nodes());
    }
    const defaults = this.props.defaultEdgeOptions;
    if (defaults !== this._edgeDefaultsSeen) {
      this._edgeDefaultsSeen = defaults;
      this._edgesSeen = this.props.edges;
      this._rebuildEdges();
    } else if (this.props.edges !== this._edgesSeen) {
      this._applyEdges(this._rawEdges());
    }
  }

  /**
   * Fold a new `edges` array into the built list, the cheap way when that
   * is honest — the `_applyNodes` treatment, for the other array.
   *
   * An app that writes `edges={[…]}` inline hands over a fresh array of
   * fresh objects on every render, most of them value-identical to the
   * last. Those keep their built entry (same object, so everything
   * downstream that compares by identity stays quiet). An edge that truly
   * changed is rebuilt alone and claims its own route, old and new. Adds,
   * removes and reorders fall back to the full rebuild.
   */
  private _applyEdges(raw: readonly AnyEdge[]): 'full' | FlowRect | null {
    const prev = this._edgesRaw;
    this._edgesSeen = this.props.edges;
    if (prev.length !== raw.length) {
      this._rebuildEdges();
      return 'full';
    }
    const defaults = this._prop<Partial<AnyEdge>>('defaultEdgeOptions');
    let damage: FlowRect | null = null;
    let adjacencyDirty = false;
    for (let i = 0; i < raw.length; i++) {
      const next = raw[i];
      const old = prev[i];
      if (next === old) continue;
      if (next.id !== old.id) {
        this._rebuildEdges();
        return 'full';
      }
      if (edgeValueEqual(next, old)) {
        // a fresh literal saying the same thing: keep the built entry
        continue;
      }
      const wasBox = this._edgeCoarseBox(this._edges[i]);
      this._edges[i] = defaults
        ? ({ ...defaults, ...next } as AnyEdge)
        : (next as AnyEdge);
      this._edgesRaw[i] = next;
      const isBox = this._edgeCoarseBox(this._edges[i]);
      if (wasBox) damage = damage ? unionRects(damage, wasBox) : wasBox;
      if (isBox) damage = damage ? unionRects(damage, isBox) : isBox;
      if (next.source !== old.source || next.target !== old.target) {
        adjacencyDirty = true;
      }
    }
    // keep the raw array in step even where entries were kept
    this._edgesRaw = raw as AnyEdge[];
    if (adjacencyDirty) this._rebuildAdjacency();
    return damage;
  }

  /**
   * Fold a new `nodes` array into the existing entries, the cheap way when
   * that is honest.
   *
   * During a drag the array is rebuilt by the app on every pointer step, and
   * the only thing in it that changed is one node's `position`. Re-measuring
   * and re-sorting three hundred nodes per step — the full `_rebuildNodes` —
   * was most of a drag frame's CPU. So: if every node differs from its entry
   * in nothing but `position`, the entries are updated in place (same
   * objects, same order, same measured sizes) and the return value is the
   * screen box that actually changed — the moved nodes, old and new, plus
   * every edge that touches them. Anything else — a label, a size, a
   * selection, an add or remove — falls back to the full rebuild, because it
   * can change measurement or paint order.
   *
   * Returns `'full'` after a rebuild, a damage rect after an in-place fold,
   * and `null` when nothing visual changed at all.
   */
  private _applyNodes(nodes: readonly AnyNode[]): 'full' | FlowRect | null {
    const prev = this._entries;
    this._nodesSeen = this.props.nodes;
    let structural = nodes.length !== prev.length;
    if (!structural) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const o = prev[i].node;
        if (n === o) continue;
        if (
          n.id !== o.id ||
          n.type !== o.type ||
          n.selected !== o.selected ||
          n.hidden !== o.hidden ||
          n.zIndex !== o.zIndex ||
          n.handles !== o.handles ||
          n.sourcePosition !== o.sourcePosition ||
          n.targetPosition !== o.targetPosition ||
          n.resizable !== o.resizable ||
          n.connectable !== o.connectable
        ) {
          structural = true;
          break;
        }
      }
    }
    if (structural) {
      this._rebuildNodes();
      return 'full';
    }
    let damage: FlowRect | null = null;
    for (let i = 0; i < nodes.length; i++) {
      const entry = prev[i];
      const next = nodes[i];
      const old = entry.node;
      if (next === old) continue;
      const moved =
        next.position.x !== old.position.x ||
        next.position.y !== old.position.y;
      // `data`, an explicit size or a paint style are the node's own to
      // change: they re-measure and repaint *this* node, never the graph. A
      // keystroke into a mounted node's textarea patches `data` on every
      // character — as a structural change that was a full re-measure and a
      // full-pane repaint per keypress, which is what "typing feels slow"
      // turned out to mean.
      const reshaped =
        next.data !== old.data ||
        next.width !== old.width ||
        next.height !== old.height;
      const restyled = next.style !== old.style;
      if (!moved && !reshaped && !restyled) {
        // a behavioural flag (draggable, deletable…) — nothing drawn reads it
        entry.node = next;
        continue;
      }
      const widthBefore = entry.width;
      const heightBefore = entry.height;
      let box = moved ? this._nodeDamage(entry) : this._screenRect(entry);
      entry.node = next;
      if (reshaped) {
        const size = measureNode(next, entry.type, this._measure);
        entry.width = size.width;
        entry.height = size.height;
        entry.specs = resolveHandles(next, entry.type);
      }
      const grew = entry.width !== widthBefore || entry.height !== heightBefore;
      // The edges ride along only when an endpoint actually moved — a
      // label edit that kept the box is the box's own business, and a
      // keystroke that unioned its node's edges swept half the layer's
      // neighbours into every repaint.
      box = unionRects(
        box,
        moved || grew ? this._nodeDamage(entry) : this._screenRect(entry),
      );
      damage = damage ? unionRects(damage, box) : box;
    }
    return damage ? inflateRect(damage, CULL_MARGIN) : null;
  }

  /**
   * The screen box a node's redraw touches: its own rect and every edge on
   * it — what a move must invalidate, before and after.
   *
   * Edge bounds come from the real routed geometry, not the coarse box: the
   * coarse slack is sized for a bezier that *might* bulge, which in a dense
   * graph sweeps dozens of neighbours into every drag step's damage. The
   * exact path costs what drawing the edge costs, and a moved node's edges
   * are about to be drawn anyway. Past a fan-out worth of edges the coarse
   * box wins again — one huge union is one huge union either way, and the
   * geometry walk stops being free.
   */
  private _nodeDamage(entry: NodeEntry): FlowRect {
    let box = this._screenRect(entry);
    const edges = this._edgesByNode.get(entry.node.id) ?? [];
    const tight = edges.length <= 16;
    for (const edge of edges) {
      const geometry = tight ? this._edgeGeometry(edge) : null;
      const bounds = geometry
        ? pathBounds(geometry.points)
        : this._edgeCoarseBox(edge);
      if (bounds) box = unionRects(box, bounds);
    }
    return box;
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
    this._edgesRaw = raw as AnyEdge[];
    this._edges = defaults
      ? raw.map((edge) => ({ ...defaults, ...edge }) as AnyEdge)
      : (raw as AnyEdge[]);
    this._rebuildAdjacency();
  }

  /** who touches whom — what a moved node's damage has to include */
  private _rebuildAdjacency(): void {
    const byNode = new Map<string, AnyEdge[]>();
    const push = (id: string, edge: AnyEdge): void => {
      const list = byNode.get(id);
      if (list) list.push(edge);
      else byNode.set(id, [edge]);
    };
    for (const edge of this._edges) {
      push(edge.source, edge);
      if (edge.target !== edge.source) push(edge.target, edge);
    }
    this._edgesByNode = byNode;
  }

  // --- coordinates ---------------------------------------------------------

  private _viewport(): Viewport {
    return this._prop<Viewport>('viewport') ?? this._vp;
  }

  /**
   * Device pixels per logical pixel — the display scale this pane's window
   * resolved to (react-x11's docs/scale.md): `1` on an ordinary display,
   * `2` on a retina panel, fractional on a desktop configured to 1.5.
   *
   * The pane thinks in logical pixels throughout. They are the unit its API
   * speaks (a viewport, a node's size, a `NodeBodyRect`), the unit a
   * synthetic event's `x`/`y` arrive in, and the unit the sibling boxes
   * `<Flow>` mounts bodies in are laid out in. What core hands this element
   * is device pixels — `abs`, `contentBox()`, `this.style`, the paint
   * context, `paintDamage()`, a rect given to `invalidate` or
   * `scrollContents`, an a11y scene rect — so each of those crossings
   * converts, once, in the helpers below, and nothing in between knows the
   * factor. At 1x every conversion is the identity, which is how a pane
   * that compared `ev.x` with `contentBox()` passed every test and then
   * hovered at half the distance, panned at half speed and framed the graph
   * at half size the day a native backend reported a retina panel.
   *
   * `scale` is on every node at runtime; the cast is for a `Node`
   * declaration that does not list it yet (react-x11#430 adds it).
   */
  private get _scale(): number {
    const s = (this as unknown as { scale?: number }).scale;
    return typeof s === 'number' && s > 0 ? s : 1;
  }

  /** A logical rect on the device grid, grown outward to whole pixels —
   * what a damage claim has to cover for an antialiased edge to repaint. */
  private _device(rect: FlowRect): FlowRect {
    const s = this._scale;
    const x = Math.floor(toDevice(rect.x, s));
    const y = Math.floor(toDevice(rect.y, s));
    return {
      x,
      y,
      width: Math.ceil(toDevice(rect.x + rect.width, s)) - x,
      height: Math.ceil(toDevice(rect.y + rect.height, s)) - y,
    };
  }

  /** One of core's device rects in the pane's logical units. */
  private _logical(rect: FlowRect): FlowRect {
    const s = this._scale;
    return {
      x: rect.x / s,
      y: rect.y / s,
      width: rect.width / s,
      height: rect.height / s,
    };
  }

  /** Claim a logical rect as damage. Every partial repaint the pane asks
   * for goes through here; the full ones pass `abs`, which is device
   * already. */
  private _claim(rect: FlowRect, reason: string): void {
    this.invalidate(false, this._device(rect), reason);
  }

  /**
   * The pane proper: `abs` inset by border and padding, off core's own
   * resolved layout (react-x11#254) — so a `<Flow style={{ borderWidth: 1,
   * padding: 8 }}>` keeps its border, and its padding means what it does on
   * a `<box>`. In logical pixels, like everything the pane computes.
   */
  private _pane(): FlowRect {
    return this._logical(this.contentBox());
  }

  /** Graph point to logical window pixels. */
  private _toScreen(p: XYPosition): XYPosition {
    const v = this._viewport();
    const pane = this._pane();
    return {
      x: pane.x + p.x * v.zoom + v.x,
      y: pane.y + p.y * v.zoom + v.y,
    };
  }

  /** Logical window pixels to graph point. */
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

  /**
   * A node's box on screen, **on whole device pixels**.
   *
   * The rounding is not cosmetic. ntk draws a rounded box as cached corner
   * glyphs plus `FillRectangles` when its geometry is integral, and
   * rasterizes a mask it has to `PutImage` when it is not — and a zoom of
   * 0.42 makes every one of them fractional. On a 300-node graph that was
   * six hundred mask uploads a frame and about four megabytes on the wire;
   * `react-x11/debug`'s trace names it as `fell back … fractional`.
   *
   * The grid is the panel's, not the logical one: at 2x a logical half is
   * a whole pixel, and at 1.5x a logical integer is not always one. Hit
   * testing reads the same rect, so what is drawn and what is clicked still
   * agree to the pixel.
   */
  private _screenRect(entry: NodeEntry): FlowRect {
    const v = this._viewport();
    const rect = this.rectOf(entry);
    const p = this._toScreen(rect);
    const s = this._scale;
    const grid = (value: number): number => Math.round(value * s) / s;
    const x = grid(p.x);
    const y = grid(p.y);
    return {
      x,
      y,
      // rounded as edges rather than as a size, so two nodes that share a
      // column still share it after rounding
      width: grid(p.x + rect.width * v.zoom) - x,
      height: grid(p.y + rect.height * v.zoom) - y,
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
    const previous = this._viewport();
    const v = { x: next.x, y: next.y, zoom };
    const controlled = this.props.viewport !== undefined;
    if (!controlled) this._vp = v;
    this._prop<(vp: Viewport) => void>('onViewportChange')?.(v);
    // The `fitView` that runs at the top of a paint has already changed what
    // this frame will draw, so asking for another one would only draw the
    // same picture twice.
    if (!controlled && !this._painting) {
      if (!this._blitPan(previous, v)) this._repaint('scroll');
      // same-frame compositing for mounted bodies — see `_dragStep`
      this._emitBodies();
    }
    this.notifyA11ySceneChanged();
  }

  /**
   * A pan is a scroll in every way but the bookkeeping, and react-x11#303
   * made the bookkeeping public: `scrollContents` claims the pane, arms the
   * frame to blit the surviving band, and narrows the claim to the strip
   * the shift exposed — which `paintDamage()` then hands to `paint`, so the
   * existing culling draws the sliver and nothing else.
   *
   * The furniture — minimap, zoom controls — is pinned to the pane while
   * its pixels would ride the blit, so its bands are carved out of the
   * region that shifts and claimed as ordinary damage. The blit gate tests
   * foreign claims against the *rect* (react-x11#309/#310), so a claim
   * sitting edge to edge with it leaves the frame a blit: the middle of
   * the pane is copied, the strips repaint with the new viewport, and the
   * panels repaint in place.
   *
   * Still a full repaint when:
   *  - the zoom moved (scaling is not a blit) or the shift is fractional on
   *    the device grid — every real pan gesture is whole device pixels;
   *  - mounted node bodies exist: they are core-owned siblings whose
   *    gesture-time commits claim *inside* the rect every step, which
   *    declines the blit anyway — bailing early skips the churn;
   *  - the furniture bands would eat the pane (a tiny pane, or panels on
   *    both the top and the bottom of a short one).
   */
  private _blitPan(previous: Viewport, next: Viewport): boolean {
    if (next.zoom !== previous.zoom) return false;
    if (this._bodiesKey !== '') return false;
    // Device pixels: the blit copies the backing store, and its grid is the
    // panel's. A pointer step lands on it whatever the scale — it came off
    // the wire as whole device pixels — so every real pan gesture blits.
    const s = this._scale;
    const shiftX = toDevice(next.x - previous.x, s);
    const shiftY = toDevice(next.y - previous.y, s);
    const dx = Math.round(shiftX);
    const dy = Math.round(shiftY);
    if (dx === 0 && dy === 0) return true; // sub-pixel: nothing to show yet
    if (shiftX !== dx || shiftY !== dy) return false;
    const pane = this._pane();

    // The horizontal bands the furniture lives in. Full-width, because the
    // graph beside a panel must repaint too — it does not ride the blit.
    let topBand = 0;
    let bottomBand = 0;
    const claim = (panel: FlowRect, position: string | undefined): void => {
      if ((position ?? 'bottom-right').startsWith('top')) {
        topBand = Math.max(topBand, panel.y + panel.height - pane.y);
      } else {
        bottomBand = Math.max(bottomBand, pane.y + pane.height - panel.y);
      }
    };
    const map = this._miniMapOptions();
    if (map) {
      claim(
        this._corner(
          map.position,
          map.width ?? MINIMAP_W,
          map.height ?? MINIMAP_H,
          'bottom-right',
        ),
        map.position,
      );
    }
    const buttons = this._controlButtons();
    if (buttons.length > 0) {
      const first = buttons[0].rect;
      const last = buttons[buttons.length - 1].rect;
      claim(
        unionRects(first, last),
        this._controlsOptions()?.position ?? 'bottom-left',
      );
    }
    // From here on, device pixels: `scrollContents` and the claims speak
    // core's units. The bands round *up* and the blit is what is left, so
    // the three sit edge to edge on whole pixels — a claim overlapping the
    // blit rect by a pixel is a foreign claim, and declines the blit.
    const box = this.contentBox();
    const top = Math.ceil(toDevice(topBand, s));
    const bottom = Math.ceil(toDevice(bottomBand, s));
    const blit: FlowRect = {
      x: box.x,
      y: box.y + top,
      width: box.width,
      height: box.height - top - bottom,
    };
    if (blit.width < 64 * s || blit.height < 64 * s) return false;
    if (Math.abs(dx) >= blit.width || Math.abs(dy) >= blit.height) {
      return false;
    }
    this.scrollContents(blit, dx, dy);
    if (top > 0) {
      this.invalidate(
        false,
        { x: box.x, y: box.y, width: box.width, height: top },
        'scroll',
      );
    }
    if (bottom > 0) {
      this.invalidate(
        false,
        {
          x: box.x,
          y: blit.y + blit.height,
          width: box.width,
          height: bottom,
        },
        'scroll',
      );
    }
    return true;
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
    this._gestureSync = true;
    try {
      this._dragDispatch(gesture, ev);
    } finally {
      this._gestureSync = false;
    }
  }

  private _dragDispatch(gesture: Gesture, ev: MouseEvent): void {
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
      case 'select': {
        const oldBox = selectBoxRect(gesture);
        gesture.x = ev.x;
        gesture.y = ev.y;
        this._selectBox(gesture);
        // The box outline is all that moves this step; a node crossing the
        // boundary changes `selected`, and that repaints through the
        // controlled round trip like any other selection change.
        this._claim(
          inflateRect(unionRects(oldBox, selectBoxRect(gesture)), CULL_MARGIN),
          'style-state',
        );
        return;
      }
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
    // Old places first, new places second: the union is everything this
    // step uncovers plus everything it covers, and nothing else — with the
    // edges that follow the moved nodes, coarse, on both sides.
    let damage: FlowRect | null = null;
    for (const id of gesture.ids) {
      const entry = this._byId.get(id);
      if (entry) damage = unionMaybe(damage, this._nodeDamage(entry));
    }
    this._dragTo = to;
    for (const id of gesture.ids) {
      const entry = this._byId.get(id);
      if (entry) damage = unionMaybe(damage, this._nodeDamage(entry));
    }
    this._emitNodes(changes);
    if (damage) {
      this._claim(inflateRect(damage, CULL_MARGIN), 'content');
    } else {
      this._repaint();
    }
    // Inside the gesture dispatch, deliberately: the body-rect setState this
    // triggers is a discrete-priority update, so React commits the moved
    // overlay box before the frame runs — the drawn card and the mounted
    // body land in the same frame. Emitted only from paint, the commit
    // chases the frame and the body is always one step behind the card.
    this._emitBodies();
    this.notifyA11ySceneChanged();
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
    let damage = this._nodeDamage(entry);
    this._resizeTo = { id: gesture.id, rect };
    damage = unionRects(damage, this._nodeDamage(entry));
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
    this._claim(inflateRect(damage, CULL_MARGIN), 'content');
    this._emitBodies();
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
    const oldBox = gesture.box ?? null;
    const oldTarget = gesture.to ? this._byId.get(gesture.to.nodeId) : null;
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
    // the line's own bounds, plus the node whose handle lights up (old and
    // new — the one that stops glowing needs repainting too)
    let box = pathBounds(this._connectionPath(gesture));
    if (oldTarget) box = unionRects(box, this._screenRect(oldTarget));
    const target = to ? this._byId.get(to.nodeId) : null;
    if (target) box = unionRects(box, this._screenRect(target));
    gesture.box = box;
    this._claim(
      inflateRect(oldBox ? unionRects(oldBox, box) : box, CULL_MARGIN),
      'style-state',
    );
  }

  /** The pending connection's polyline — one builder for the paint and for
   * the damage it has to claim, so the two cannot disagree. */
  private _connectionPath(
    gesture: Extract<Gesture, { kind: 'connect' }>,
  ): XYPosition[] {
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
    return edgePath(
      'bezier',
      { x: from.x, y: from.y, position: gesture.from.position },
      { x: to.x, y: to.y, position: toPosition },
      {
        stepOffset: EDGE_STEP_OFFSET * v.zoom,
        radius: 8 * v.zoom,
        scale: v.zoom,
      },
    );
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

  /** Wheel: zoom about the pointer, or pan when zooming is off. The seam
   * runs it after the app's own `onWheel` and not at all if that vetoed;
   * consuming it here is what keeps the scroll chain out of the pane. */
  override defaultWheel(ev: WheelEvent): void {
    if (this.props.disabled) return;
    this._gestureSync = true;
    try {
      this._wheelDispatch(ev);
    } finally {
      this._gestureSync = false;
    }
  }

  private _wheelDispatch(ev: WheelEvent): void {
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

  /** Pointer motion with no button down: hover highlighting. The seam skips
   * delivery while a capture is in force, so the gesture guard is belt to
   * its braces. */
  override defaultMouseMove(ev: MouseEvent): void {
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
    const damage = unionMaybe(
      this._hoverDamage(this._hover),
      this._hoverDamage(next),
    );
    this._hover = next;
    if (damage) {
      this._claim(inflateRect(damage, CULL_MARGIN), 'style-state');
    } else {
      this._repaint('style-state');
    }
  }

  override defaultMouseLeave(): void {
    if (this._hover === NO_HOVER) return;
    const damage = this._hoverDamage(this._hover);
    this._hover = NO_HOVER;
    if (damage) {
      this._claim(inflateRect(damage, CULL_MARGIN), 'style-state');
    } else {
      this._repaint('style-state');
    }
  }

  /** What a hover state lights up on screen: the node (whose border and
   * handles restyle), or the edge. Null when it points at nothing. */
  private _hoverDamage(state: HoverState): FlowRect | null {
    const nodeId = state.handle?.nodeId ?? state.nodeId;
    if (nodeId) {
      const entry = this._byId.get(nodeId);
      return entry ? this._screenRect(entry) : null;
    }
    if (state.edgeId) {
      const edge = this._edges.find((e) => e.id === state.edgeId);
      return edge ? this._edgeCoarseBox(edge) : null;
    }
    return null;
  }

  // --- what a screen reader meets (react-x11#304) --------------------------

  /**
   * The graph, described: every visible node as an item a screen reader
   * can reach, name and activate. Edges ride on each node's description
   * rather than as items of their own — "what is this connected to" is the
   * useful question, and a hundred unlabelled `link` items between the
   * nodes would only bury them.
   *
   * Called once per question an AT asks, so it answers from the entries the
   * pane already holds — no measuring, no layout.
   */
  override a11yScene(): A11ySceneItem[] {
    this._sync();
    const pane = this._pane();
    const items: A11ySceneItem[] = [];
    for (const entry of this._order) {
      if (entry.node.hidden) continue;
      const rect = this._screenRect(entry);
      if (!rectsOverlap(rect, pane)) continue;
      const data = entry.node.data as FlowNodeData | undefined;
      const out = this._edgesByNode.get(entry.node.id) ?? [];
      const degree = out.length;
      items.push({
        id: entry.node.id,
        // the scene's rects are `abs`'s space — device pixels
        rect: this._device(rect),
        role: 'listitem',
        name: data?.label ?? entry.node.id,
        description:
          degree === 0
            ? (data?.description ?? undefined)
            : `${data?.description ? `${data.description}. ` : ''}${degree} connection${degree === 1 ? '' : 's'}`,
        states: { selected: entry.node.selected ?? false },
      });
    }
    return items;
  }

  /**
   * An AT activated a node: select it, the way a click would — but by id
   * rather than by synthesizing a pointer at its rect, which would also
   * arm a drag.
   */
  override a11ySceneAction(id: string, action: A11ySceneAction): boolean {
    if (action !== 'activate') return false;
    if (!this._byId.has(id)) return false;
    this._select({ kind: 'node', id }, false);
    return true;
  }

  // --- keyboard ------------------------------------------------------------

  override defaultKeyDown(ev: KeyboardEvent): void {
    if (this.props.disabled) return;
    this._gestureSync = true;
    try {
      this._keyDispatch(ev);
    } finally {
      this._gestureSync = false;
    }
  }

  private _keyDispatch(ev: KeyboardEvent): void {
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
    // This used to repaint the pane on every prop change, which was honest
    // and ruinous: the component above recreates its handler props on every
    // render, so each drag step repainted the world once for the gesture and
    // once for the commit it caused. Now the commit is billed for what it
    // changed — a moved node repaints the box it moved through, an edit to
    // anything else on the visual list repaints in full, and handler churn
    // repaints nothing.
    let damage: 'full' | FlowRect | null = null;
    if (
      !shallowEqual(nextProps.nodeTypes, before.nodeTypes) ||
      !shallowEqual(nextProps.defaultEdgeOptions, before.defaultEdgeOptions)
    ) {
      this._sync();
      damage = 'full';
    } else {
      if (nextProps.edges !== before.edges) {
        damage = this._applyEdges(this._rawEdges());
      }
      if (damage !== 'full' && nextProps.nodes !== before.nodes) {
        const nodeDamage = this._applyNodes(this._nodes());
        damage =
          nodeDamage === 'full' || damage === null
            ? nodeDamage
            : nodeDamage === null
              ? damage
              : unionRects(damage, nodeDamage);
      }
    }
    // `fitView` is a one-shot: turning it on later refits, and it stays off
    // through every unrelated re-render in between.
    if (nextProps.fitView === true && before.fitView !== true) {
      this._fitPending = true;
      damage = 'full';
    }
    if (damage !== 'full') {
      for (const key of VISUAL_PROPS) {
        if (!shallowEqual(nextProps[key], before[key])) {
          damage = 'full';
          break;
        }
      }
    }
    if (damage === 'full') this._repaint('props');
    else if (damage) this._claim(damage, 'props');
    // Core re-reads the scene for aria-prop commits; a `nodes`/`edges`
    // change is invisible to it, so the re-read is asked for by name.
    // Free when no assistive technology is listening.
    if (damage) this.notifyA11ySceneChanged();
  }

  override destroySubtree(): void {
    this._stopAnimation();
    this._dropGridTile();
    super.destroySubtree();
  }

  private _startAnimation(): void {
    if (this._animTimer != null) return;
    this._animTimer =
      timers.setInterval?.(() => {
        this._dashPhase += ANIMATION_SPEED;
        // the box the last paint saw animated edges in, not the pane: a
        // marching dash should not cost a full grid repaint per tick
        this.invalidate(
          false,
          this._animBox ? this._device(this._animBox) : this.abs,
          'animation',
        );
      }, ANIMATION_MS) ?? null;
  }

  private _stopAnimation(): void {
    if (this._animTimer == null) return;
    timers.clearInterval?.(this._animTimer);
    this._animTimer = null;
  }

  // --- painting ------------------------------------------------------------

  override paint(ctx: Context2D): void {
    // What this pass is repainting. The renderer paints each damage rect as
    // its own clipped pass; content outside it survives on the window, so
    // everything we skip here is content the last frame already drew — the
    // window's backing is the composition cache, and this rect is the dirty
    // state. Null means a full pass.
    const clip = this.paintDamage();

    // The pane's own border and background need redrawing only when the
    // pass reaches them: a drag deep inside the pane should not restroke a
    // rounded border whose mask is the size of the pane.
    const sNum = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const ring =
      sNum(this.style.borderWidth) + sNum(this.style.borderRadius) + 2;
    const inner = inflateRect(this.abs, -ring);
    const insideInner =
      clip != null &&
      inner.width > 0 &&
      inner.height > 0 &&
      clip.x >= inner.x &&
      clip.y >= inner.y &&
      clip.x + clip.width <= inner.x + inner.width &&
      clip.y + clip.height <= inner.y + inner.height;
    // background, border and the node's own box
    if (!insideInner) super.paint(ctx);

    if (!this._visible()) return;
    const painter = createPainter(ctx, this._textOptions());
    if (!painter) return; // a backend with no path API: geometry only

    this._sync();
    this._painting = true;
    if (this._fitPending) {
      if (clip) {
        // a partial pass cannot show a refit — everything outside its rect
        // would keep the old viewport — so keep the flag and come back full
        this._repaint('scroll');
      } else {
        // Deferred to the first paint that has a size: `fitView` is asked
        // for before layout has run, and framing a graph in a zero-sized
        // pane is not an answer.
        this._fitPending = false;
        this._fit(this._prop<FitViewOptions>('fitViewOptions'));
      }
    }
    // `paintDamage()` speaks device pixels, like `abs`; the culling below
    // speaks logical ones, like everything the pane draws.
    this._frameClip = this._fitPending
      ? this._pane()
      : clip
        ? this._logical(clip)
        : null;

    const palette = this._palette();
    const { x, y, width, height } = this._pane();
    painter.save();
    // `Node.paint` clips *children*, and this element has none — its drawing
    // happens after `super.paint` returned, outside any clip of its own. The
    // clip is the content box rather than `abs` because the border has been
    // stroked already, inside the box, and drawing over it would leave a
    // `borderWidth: 1` looking like half of one.
    // `this.style` arrives in device pixels (react-x11's docs/scale.md);
    // the painter takes logical ones.
    const radius =
      Math.max(
        0,
        ((this.style.borderRadius as number | undefined) ?? 0) -
          ((this.style.borderWidth as number | undefined) ?? 0),
      ) / this._scale;
    // The rounded clip only when this pass can actually reach a corner: a
    // non-rectangular clip forfeits ntk's rounded-box fast path for every
    // fill under it, which multiplies a rounded *pane* into a per-card
    // trapezoid pass. A keystroke's or a drag's damage is interior almost
    // always, and an interior pass under a plain rect clip cannot touch
    // the corners it is being protected from.
    const nearCorner =
      radius > 0 &&
      (!this._frameClip ||
        [
          { x, y },
          { x: x + width - radius, y },
          { x, y: y + height - radius },
          { x: x + width - radius, y: y + height - radius },
        ].some((corner) =>
          rectsOverlap(
            { x: corner.x, y: corner.y, width: radius, height: radius },
            this._frameClip!,
          ),
        ));
    painter.clipRect(x, y, width, height, nearCorner ? radius : 0);
    // The fill and the grid draw only the region this pass repaints — on a
    // full pass that is the pane, and on a drag it is the sliver that moved.
    const region = this._frameClip
      ? intersectRects({ x, y, width, height }, this._frameClip)
      : { x, y, width, height };
    if (region) {
      // The style's own colour if it set one — `super.paint` already filled
      // it, and repeating it costs one rectangle and keeps the two agreeing.
      painter.rect(region.x, region.y, region.width, region.height, 0, {
        fill:
          (this.style.backgroundColor as string | undefined) ??
          palette.background,
      });
      this._paintGrid(painter, palette, region);
    }

    const animated = this._paintEdges(painter, palette);
    this._paintNodes(painter, palette);
    this._paintConnection(painter, palette);
    this._paintSelectionBox(painter, palette);
    this._paintMiniMap(painter, palette);
    this._paintControls(painter, palette);
    painter.restore();
    this._painting = false;
    this._frameClip = null;

    // The timer exists only while something on screen needs it.
    if (animated) this._startAnimation();
    else this._stopAnimation();

    if (!this._sceneAnnounced) {
      // The first paint with a size is the first moment the items have
      // rects; before it the scene is honestly empty.
      this._sceneAnnounced = true;
      this.notifyA11ySceneChanged();
    }

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
      this._prop<(bodies: readonly NodeBodyRect[], sync: boolean) => void>(
        'onNodeBodies',
      );
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
        // pane-relative and logical, because that is what an absolutely
        // positioned box beside the pane is laid out against, and in
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
    notify(bodies, this._gestureSync);
  }

  /** The grid, drawn only inside `region` — the pass's damage on a partial
   * repaint, the pane on a full one. Alignment stays anchored to the
   * viewport origin, so the region never changes where a dot falls. */
  private _paintGrid(
    painter: FlowPainter,
    palette: FlowPalette,
    region: FlowRect,
  ): void {
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
    const pane = this._pane();
    const { x, y, width, height } = region;
    const originX = pane.x + v.x;
    const originY = pane.y + v.y;
    if (this._paintGridPattern(painter, options, step, color, region)) return;
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

  /**
   * The grid as one repeating fill (ntk#263): a step-sized tile drawn once,
   * a `createPattern('repeat')` over it, and one composite for the whole
   * region — where the runs path pays a region-sized coverage mask.
   *
   * Two decisions with reasons:
   *
   * - **Integral device steps only.** The tile is a pixmap, so its size is
   *   whole pixels; at a fractional step the pattern would drift against
   *   the graph's own coordinates — against `snapToGrid`, against node
   *   positions — by a fraction per tile, and a grid that slides under the
   *   content it grids is worse than a slower exact one.
   * - **The phase lives in the tile, not in a picture transform.** An
   *   untransformed repeat is anchored to the window origin, so the grid's
   *   alignment is baked in by drawing the mark at `origin mod tile` — and
   *   re-baking when the origin moves. A `setTransform` translate says the
   *   same thing in one request, but a *transformed* repeat forfeits the
   *   server's untransformed fast path — on the in-process test server
   *   that was ~180 ms a frame of per-pixel arithmetic, and re-rendering a
   *   24px tile is a handful of requests on any server.
   */
  private _paintGridPattern(
    painter: FlowPainter,
    options: { variant: BackgroundVariant; size: number },
    step: number,
    color: string,
    region: FlowRect,
  ): boolean {
    // The tile is a pixmap on the panel's grid, so the pitch has to be a
    // whole number of *device* pixels, and the phase is where the viewport
    // origin lands on that grid.
    const s = this._scale;
    const pitch = toDevice(step, s);
    const tileSize = Math.round(pitch);
    if (Math.abs(pitch - tileSize) > 0.01 || tileSize < 2) return false;
    const raw = painter.raw as {
      createPattern?: (source: unknown, repetition: string) => PatternLike;
      fillStyle?: unknown;
      fillRect?(x: number, y: number, w: number, h: number): void;
    } | null;
    if (!raw || typeof raw.createPattern !== 'function') return false;

    const v = this._viewport();
    const pane = this._pane();
    const mod = (a: number, m: number): number => ((a % m) + m) % m;
    const px = Math.round(mod(toDevice(pane.x + v.x, s), tileSize)) % tileSize;
    const py = Math.round(mod(toDevice(pane.y + v.y, s), tileSize)) % tileSize;
    // device pixels per graph unit — what a mark's size is drawn in
    const unit = v.zoom * s;
    const key = `${options.variant}|${Math.round(options.size * unit * 4)}|${color}|${px},${py}`;

    let tile = this._gridTile;
    if (!tile || tile.size !== tileSize) {
      this._dropGridTile();
      const surface = this._makeGridSurface(tileSize);
      if (!surface) return false;
      tile = {
        key: '',
        size: tileSize,
        surface,
        pattern: raw.createPattern(surface, 'repeat'),
      };
      this._gridTile = tile;
    }
    if (tile.key !== key) {
      tile.key = key;
      this._renderGridTile(tile, options, unit, color, px, py);
    }
    raw.fillStyle = tile.pattern;
    const fill = this._device(region);
    raw.fillRect?.(fill.x, fill.y, fill.width, fill.height);
    return true;
  }

  private _makeGridSurface(tileSize: number): SurfaceLike | null {
    const ctor = (ntk as unknown as { Surface?: SurfaceCtor }).Surface;
    if (typeof ctor !== 'function') return null;
    try {
      return new ctor(this.app, {
        width: tileSize,
        height: tileSize,
        format: 'argb32',
      });
    } catch {
      return null;
    }
  }

  /** Draw one grid cell with the mark at the phase point, wrapped — a mark
   * near an edge is drawn again a tile over, so the seam never cuts it.
   * Device pixels throughout: `unit` is how many of them a graph unit is. */
  private _renderGridTile(
    tile: { size: number; surface: SurfaceLike },
    options: { variant: BackgroundVariant; size: number },
    unit: number,
    color: string,
    px: number,
    py: number,
  ): void {
    const t = tile.size;
    tile.surface.render((ctx) => {
      ctx.clearRect?.(0, 0, t, t);
      ctx.fillStyle = color;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const cx = px + i * t;
          const cy = py + j * t;
          if (options.variant === 'lines') {
            if (j === 0) ctx.fillRect(cx - 0.5, 0, 1, t);
            if (i === 0) ctx.fillRect(0, cy - 0.5, t, 1);
          } else if (options.variant === 'cross') {
            const arm = Math.max(2, options.size * 3 * unit);
            ctx.fillRect(cx - arm, cy - 0.5, arm * 2, 1);
            ctx.fillRect(cx - 0.5, cy - arm, 1, arm * 2);
          } else {
            const dot = Math.max(1, Math.round(options.size * 2 * unit));
            ctx.fillRect(cx - dot / 2, cy - dot / 2, dot, dot);
          }
        }
      }
    });
  }

  private _dropGridTile(): void {
    const tile = this._gridTile;
    if (!tile) return;
    tile.pattern._picture?.destroy?.();
    tile.surface.destroy?.();
    this._gridTile = null;
  }

  /** Draws every visible edge; answers whether any of them is animated, so
   * the caller knows whether to keep a timer alive. */
  private _paintEdges(painter: FlowPainter, palette: FlowPalette): boolean {
    const v = this._viewport();
    const pane = this._pane();
    const labels = v.zoom >= LABEL_ZOOM;
    let animated = false;
    // Collect, then draw. A stroke has no fast path in ntk — every one is a
    // mask rasterized in JS, uploaded with `PutImage` and composited — so a
    // graph of seven hundred edges was seven hundred round trips and about
    // four megabytes a frame. Bucketed by the style they will be stroked
    // with, the same graph is one path per distinct pen, which for almost
    // every graph is one.
    const strokes = new StrokeBuckets();
    const markers = new Map<string, MarkerBucket>();
    const labelChips: { rect: FlowRect; radius: number; fill: string }[] = [];
    const pendingLabels: {
      text: string;
      x: number;
      y: number;
      size: number;
      color: string;
    }[] = [];

    const clip = this._frameClip;
    let animBox: FlowRect | null = null;
    for (const edge of this._edges) {
      if (edge.hidden) continue;
      // two rejects: one from the nodes alone, one from the route it took
      const coarse = this._edgeCoarseBox(edge);
      if (!coarse || !rectsOverlap(coarse, pane)) continue;
      // Tracked before the damage skip, deliberately: whether the dash
      // timer runs is a question about the viewport, not about what this
      // particular pass repaints — deciding it after the skip is how a drag
      // in one corner would stop the dash marching in the other. The box
      // the ticks invalidate is collected below from the *drawn* geometry:
      // the coarse box carries the bezier slack, and a tick that repaints
      // slack repaints a card-sized halo of neighbours sixteen times a
      // second.
      if (edge.animated) animated = true;
      if (clip && !rectsOverlap(coarse, clip)) continue;
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
      if (edge.animated) {
        const tight = inflateRect(pathBounds(geometry.points), CULL_MARGIN);
        animBox = animBox ? unionRects(animBox, tight) : tight;
      }
      strokes
        .bucket(
          stroke,
          lineWidth,
          dash,
          edge.animated ? this._dashPhase : 0,
          v.zoom,
        )
        .push(points);

      if (markerEnd) {
        this._collectMarker(
          markers,
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
        this._collectMarker(
          markers,
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
        // The chip is collected with the rest; the text is not, because a
        // glyph run is already one request and nothing is gained by holding
        // it. Both still land above every edge, which is the point of the
        // chip.
        labelChips.push({
          rect: {
            x: Math.round(at.x - metrics.width / 2 - padX),
            y: Math.round(at.y - metrics.height / 2 - padY),
            width: Math.round(metrics.width + padX * 2),
            height: Math.round(metrics.height + padY * 2),
          },
          radius: Math.max(2, Math.round(3 * v.zoom)),
          fill: edge.style?.labelBackground ?? tint(palette.background, 0.92),
        });
        pendingLabels.push({
          text: edge.label,
          x: at.x,
          y: at.y,
          size,
          color: edge.style?.labelColor ?? palette.text,
        });
      }
    }

    strokes.paint(painter);
    for (const bucket of markers.values()) {
      // the same threshold, for the same reason: a handful of arrowheads
      // scattered over the pane is cheaper drawn as a handful
      if (bucket.filled.length >= MARKER_BATCH_MIN) {
        painter.polygons(bucket.filled, { fill: bucket.color });
      } else {
        for (const head of bucket.filled) {
          painter.polygon(head, { fill: bucket.color });
        }
      }
      if (bucket.open.length >= MARKER_BATCH_MIN) {
        painter.strokeRuns(bucket.open, {
          stroke: bucket.color,
          lineWidth: bucket.lineWidth,
        });
      } else {
        for (const head of bucket.open) {
          painter.strokeRuns([head], {
            stroke: bucket.color,
            lineWidth: bucket.lineWidth,
          });
        }
      }
    }
    for (const chip of labelChips) {
      painter.rect(
        chip.rect.x,
        chip.rect.y,
        chip.rect.width,
        chip.rect.height,
        chip.radius,
        { fill: chip.fill },
      );
    }
    for (const l of pendingLabels) {
      painter.text(l.text, l.x, l.y, {
        size: l.size,
        color: l.color,
        align: 'center',
        baseline: 'middle',
      });
    }
    // A pass that drew an animated edge knows exactly where its dash is; a
    // pass that culled them all keeps the previous box — the endpoints did
    // not move, or the move's own damage would have redrawn them here.
    if (animBox) this._animBox = animBox;
    return animated;
  }

  /** An arrowhead's three or four points, added to the pile for its colour
   * rather than drawn — see {@link StrokeBuckets} for why. */
  private _collectMarker(
    markers: Map<string, MarkerBucket>,
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
    const key = `${color}|${lineWidth}`;
    let bucket = markers.get(key);
    if (!bucket) {
      bucket = { color, lineWidth, filled: [], open: [] };
      markers.set(key, bucket);
    }
    if (type === 'arrowclosed') bucket.filled.push([at, left, back, right]);
    else bucket.open.push([left, at, right]);
  }

  private _paintNodes(painter: FlowPainter, palette: FlowPalette): void {
    const dragging = this._dragTo;
    const order: NodeEntry[] = [];
    const deferred: NodeEntry[] = [];
    for (const entry of this._order) {
      // a dragged node comes to the top
      if (dragging?.has(entry.node.id)) deferred.push(entry);
      else order.push(entry);
    }
    order.push(...deferred);

    // Nodes are drawn one at a time, in z-order, and both halves of that
    // were measured rather than assumed — see `_paintHandles` for why
    // batching a card or a handle costs more than it saves.
    for (const entry of order) this._paintNode(painter, palette, entry);
  }

  private _paintNode(
    painter: FlowPainter,
    palette: FlowPalette,
    entry: NodeEntry,
  ): void {
    if (entry.node.hidden) return;
    const rect = this._screenRect(entry);
    if (!rectsOverlap(rect, this._pane())) return;
    // inflated by the margin its handles and grips can ink outside the box —
    // the same margin every invalidate grew by, so the two agree
    const clip = this._frameClip;
    if (clip && !rectsOverlap(inflateRect(rect, CULL_MARGIN), clip)) return;
    const v = this._viewport();
    const selected = entry.node.selected ?? false;
    const hovered = this._hover.nodeId === entry.node.id;
    const handles = this._handlesOf(entry).map((anchor) => {
      const s = this._toScreen(anchor);
      return { ...anchor, x: s.x, y: s.y };
    });

    if (entry.type?.paint) {
      // Never batched: a type that draws its own body is drawing whatever it
      // likes, in an order only it knows.
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
      this._paintCardShape(painter, palette, entry, rect, selected, hovered);
      this._paintCardInk(painter, palette, entry, rect);
    }

    if (this._connectable(entry) && (v.zoom >= HANDLE_ZOOM || hovered)) {
      this._paintHandles(painter, palette, handles);
    }
    this._paintGrips(painter, palette, entry, rect);
  }

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
  /** The card itself: one rounded box, and the accent stripe if it has one.
   * With a `batch` the box joins the pile for its appearance instead of
   * being drawn on its own. */
  private _paintCardShape(
    painter: FlowPainter,
    palette: FlowPalette,
    entry: NodeEntry,
    rect: FlowRect,
    selected: boolean,
    hovered: boolean,
  ): void {
    const v = this._viewport();
    const style = entry.node.style;
    const radius = Math.round((style?.borderRadius ?? 6) * v.zoom);
    const border = selected
      ? palette.accent
      : hovered
        ? tint(palette.accent, 0.55)
        : (style?.borderColor ?? palette.nodeBorder);
    const options: ShapeOptions = {
      fill: style?.background ?? palette.nodeBackground,
      stroke: border,
      lineWidth: Math.max(
        1,
        Math.round((style?.borderWidth ?? (selected ? 2 : 1)) * v.zoom),
      ),
    };
    painter.rect(rect.x, rect.y, rect.width, rect.height, radius, options);

    if (style?.accent) {
      // Inset past the rounded corners instead of clipped to them: a
      // non-rectangular clip forfeits ntk's rounded-box fast path for every
      // fill under it — measured as a pixmap create/free and a trapezoid
      // pass per card per repaint.
      painter.rect(
        rect.x + Math.max(1, v.zoom),
        rect.y + radius,
        Math.max(2, 3 * v.zoom),
        rect.height - radius * 2,
        0,
        { fill: style.accent },
      );
    }
  }

  /** The label and its second line — the half of a card that has to come
   * after every card when they are batched. */
  private _paintCardInk(
    painter: FlowPainter,
    palette: FlowPalette,
    entry: NodeEntry,
    rect: FlowRect,
  ): void {
    const v = this._viewport();
    if (v.zoom < LABEL_ZOOM) return;
    const style = entry.node.style;
    const header = this._mounted(entry) ? this._headerHeight(entry) : 0;
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

  /**
   * Handles are drawn one disc at a time, and that is the measured answer
   * rather than the obvious one.
   *
   * Batching them into a single path halved the requests and made the frame
   * *slower*: a path's mask is its bounding box, so forty dots scattered
   * across the pane rasterize to a paneful of mask — three quarters of a
   * megabyte — where forty small ones cost a kilobyte each. Batching pays
   * for the edges because an edge already spans that box; it does not pay
   * for anything small and scattered.
   */
  private _paintHandles(
    painter: FlowPainter,
    palette: FlowPalette,
    handles: readonly HandleAnchor[],
  ): void {
    const v = this._viewport();
    const radius = this._handleRadius();
    const gesture = this._gesture;
    const connecting = gesture?.kind === 'connect' ? gesture : null;
    const lineWidth = Math.max(1, 1.5 * v.zoom);
    for (const anchor of handles) {
      const active =
        sameHandle(this._hover.handle, anchor) ||
        sameHandle(connecting?.to ?? null, anchor) ||
        sameHandle(connecting?.from ?? null, anchor);
      const options: ShapeOptions = {
        fill: active ? palette.accent : palette.nodeBackground,
        stroke: active ? palette.accent : palette.handle,
        lineWidth,
      };
      painter.circle(
        anchor.x,
        anchor.y,
        active ? radius * 1.4 : radius,
        options,
      );
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
    const target = gesture.to ?? gesture.pointer;
    const to = this._toScreen(target);
    const points = this._connectionPath(gesture);
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
    const opts = this._miniMapOptions();
    if (!opts) return;
    // The panel cull comes before `_miniMap()`, which walks every node to
    // find the graph's bounds — during a drag that walk per pass would cost
    // more than the panel it skips. The dot for a mid-drag node goes stale
    // until the release repaints in full; that is the trade, and it is
    // deliberate.
    const clip = this._frameClip;
    if (clip) {
      const quick = this._corner(
        opts.position,
        opts.width ?? MINIMAP_W,
        opts.height ?? MINIMAP_H,
        'bottom-right',
      );
      if (!rectsOverlap(quick, clip)) return;
    }
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
    const clip = this._frameClip;
    if (clip && !buttons.some((b) => rectsOverlap(b.rect, clip))) return;
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
