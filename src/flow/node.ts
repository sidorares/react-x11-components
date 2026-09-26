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
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  EDGE_SLOP,
  fitViewport,
  HANDLE_RADIUS,
  HANDLE_SLOP,
  gripPoint,
  inflateRect,
  intersectRects,
  measureNode,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  NODE_BODY_INSET,
  NODE_HEADER,
  normalizeBackground,
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
import { distanceToPath, pathBounds } from './paths.js';
import {
  paintFloat,
  paintGraph,
  paintGraphEdges,
  paintGraphNodes,
  paintGround,
  paintNodeItem,
  paintPanels,
  paintScene,
} from './paint.js';
import {
  anchorsOf,
  buildNodeItems,
  buildScene,
  connectionPath,
  SceneCache,
  CULL_MARGIN,
  edgeCoarseBox,
  edgeRoute,
  endpoint,
  HANDLE_ZOOM,
  screenRect,
  screenViewport,
} from './scene.js';
import type {
  FlowScene,
  SceneGrid,
  SceneInput,
  SceneNodeSource,
} from './scene.js';
import type {
  BackgroundOptions,
  BackgroundVariant,
  ControlsOptions,
  EdgeChange,
  FitViewOptions,
  FlowEdge,
  FlowBodyBudget,
  FlowFrameStats,
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

/** The slice of ntk's Surface a 2D zoom gesture paints the graph onto. */
interface ShotSurface {
  getContext(name: '2d'): unknown;
  destroy?(): void;
}
type ShotCtor = new (
  app: unknown,
  options: { width: number; height: number; format: string },
) => ShotSurface;

/** The graph as a 2D zoom gesture's first step drew it, and the viewport
 *  it drew at. */
interface ZoomShot {
  surface: ShotSurface;
  viewport: Viewport;
  width: number;
  height: number;
}

/**
 * What a 2D drag copies from instead of repainting: the graph without the
 * nodes it moves, in two pictures of the pane — the ground and the edges,
 * and the cards on a clear ground over them — so the moved nodes' edges go
 * between the two and the nodes over both, as the painter orders them.
 * Good for the gesture it was made in, at the viewport and the version of
 * the graph it was painted at.
 */
interface LiftShot {
  under: ShotSurface;
  over: ShotSurface;
  /** Where the cards' picture has anything, in the pane's logical pixels:
   *  each card and the reach of its handles. Blended in there and nowhere
   *  else — a step's box between the cards has none to blend. */
  cards: FlowRect[];
  gesture: object;
  version: number;
  viewport: Viewport;
  width: number;
  height: number;
}

/** A canvas `<Flow>` paints a panel on: a core node, asked to repaint its
 *  own box. */
interface PanelCanvas {
  invalidate(layout: boolean, damage: unknown, reason: string): void;
  /** Where a claim of the canvas lands: its box and core's damage slop,
   *  device pixels. */
  paintBounds?(): FlowRect;
  /** Its box, device pixels. */
  readonly abs?: FlowRect;
}

/** Timers, through `globalThis`: `src/` compiles with `types: []` so a Node
 * global that wandered in would become an implicit `@types/node` dependency
 * a consumer has to satisfy. */
const timers = globalThis as {
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(id: unknown): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
};

/** How long the zoom has to hold still before mounted bodies come back at
 *  the new scale. Wheel notches in a flick land well inside it. */
const BODY_ZOOM_REST_MS = 150;
/** What re-scaling the mounted bodies may add to one step of a zoom
 *  gesture before they sit the gesture out (`_holdBodies`). */
const BODY_BUDGET_MS = 8;
/** What one body costs a zoom step until the pane has measured it: 1.1–1.2
 *  ms on an M-series Mac, the 400-widget scene on Cocoa (42 bodies added
 *  49 ms to a 13 ms step, 9 added 10). Learned from then on. */
const BODY_STEP_PRIOR_MS = 1.2;

/** Under GL, how long a zoom holds still before the world is rebuilt at it
 *  — until then each step draws the world already on the GPU, scaled
 *  (`glFrame`) — and how far that scaling may go before a step rebuilds
 *  anyway, so a long gesture never magnifies one build by more than this.
 *  The 2D renderer's zoom picture keeps to both. */
const GL_ZOOM_REST_MS = 120;
const GL_ZOOM_SPAN = 2;
/** How much of the pane a 2D zoom step may paint live, round the picture it
 *  composites — the ring a zoom out uncovers — before it paints a new one. */
const ZOOM_SHOT_LIVE = 0.5;
/** How far round a box selection's outline its step claims: the pen, the
 *  corner's radius and a pixel of antialiasing, with room to spare. */
const SELECT_BAND = 4;
/** How often the dash on an animated edge moves. Slow enough that a graph
 * full of them is not a repaint storm, fast enough to read as motion. */
const ANIMATION_MS = 60;
const ANIMATION_SPEED = 1.4; // px of dash travel per tick, at zoom 1

/** Screen pixels the pointer may travel before a press becomes a drag. */
const DRAG_THRESHOLD = 3;
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
  'renderer',
] as const;

/** The clock, through `globalThis`: `src/` compiles with `types: []`. */
const clock = globalThis as { performance?: { now(): number } };
const now = (): number => clock.performance?.now() ?? Date.now();

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
  'adaptive',
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
  /** The bodies last sent, re-sent as the same array when only the origin
   *  moved, and that origin — and each one by id, reused as the same object
   *  when nothing about it changed, so the React half re-renders the card
   *  that moved and not the ones beside it. */
  private _bodies: readonly NodeBodyRect[] = [];
  private _bodiesById = new Map<string, NodeBodyRect>();
  private _bodiesOrigin: XYPosition = { x: 0, y: 0 };
  /** Bodies held back while the zoom moves (`_holdBodies`): whether they
   *  are, the zoom last seen, the timer that brings them back and when the
   *  last held step was. */
  private _bodiesHeld = false;
  private _seenZoom = NaN;
  private _bodiesRest: unknown = null;
  private _bodiesAt = 0;
  /** Mounted cards `<Flow>` shows, painted in the bodies' layer — the
   *  graph leaves them out (`setShownBodies`). */
  private _shownBodies: ReadonlySet<string> = new Set();
  /**
   * Under GL, the shown cards the bodies' layer has painted since it was
   * told they were shown (`paintCard`). The layer is 2D, over the surface:
   * it reaches the screen with the window's paint, and a GL frame presents
   * at once. Leaving a card to the layer from the commit that mounted its
   * body, as the 2D renderer can, left edges with no cards under them for as
   * long as that paint took — the whole of a scene of charts' first paint,
   * and again after every zoom that held the bodies. So the world keeps a
   * card until its canvas has painted.
   */
  private _paintedCards = new Set<string>();
  /** The canvases `<Flow>` paints the minimap and controls on, over the
   *  bodies — while there are any, the graph leaves the panels out. */
  private _panelCanvases: readonly PanelCanvas[] = [];
  private _panelsKey = '';
  /** The budget's model (`_holdBodies`, `_frameTick`): what a body adds to a
   *  zoom step, what a step costs with none re-scaled, the last frame's
   *  time, and what the step awaiting its frame did. */
  private _bodyStepMs = BODY_STEP_PRIOR_MS;
  private _baseStepMs = NaN;
  private _lastFrameAt = -Infinity;
  private _zoomStep: { live: boolean; bodies: number } | null = null;
  private _dashPhase = 0;
  /** The box the bodies are laid out in, which a 2D pan carries. */
  private _bodiesLayer: Node | null = null;
  /** When a pan last asked to blit — the dash timer waits for it. */
  private _blittedPanAt = -Infinity;
  /** When the view last moved, and when the dash timer last came round,
   *  ticking or not: a 2D pan's dashes wait for a view that held still. */
  private _viewMovedAt = -Infinity;
  private _tickAt = -Infinity;
  /** When the dash timer last marched, and what a 2D frame has cost lately
   *  — the paint, and the server's answer to the frame before it; a running
   *  mean, ms: what a tick waits on. */
  private _marchedAt = -Infinity;
  private _tickCost = 0;
  private _animTimer: unknown = null;
  /** Inside `paint`, where an invalidation would only schedule a redraw of
   * the frame being drawn. */
  private _painting = false;
  /** Routes that survived the last frame — see {@link SceneCache}. */
  private readonly _sceneCache = new SceneCache();
  /** Asks the GL surface for a frame, while one is drawing this pane. */
  private _glRequest: (() => void) | null = null;
  /**
   * Bumped by every repaint this element asks for that is *not* a pure pan
   * — which is how the GL surface knows the graph it holds on the GPU is
   * still the graph, and a frame is only a new offset. Errs one way on
   * purpose: anything it cannot see is covered by the rest of the key
   * (`glFrame`), and a rebuild too many costs a frame's packing, where one
   * too few draws the wrong graph.
   */
  private _worldVersion = 0;
  /**
   * The same for the nodes a drag is moving under GL, which are lifted out
   * of the world for as long as it moves them (`_lifted`): a step changes
   * them and nothing else, so it moves this and the world stays on the GPU.
   * Rebuilding the world was the whole of a drag step's cost — 5-7 ms of
   * scene and packing a step at 2,000 nodes, for one card.
   */
  private _liftVersion = 0;
  /** The lifted ids, for the drag gesture they were made for, and a count
   *  of every change to them — the world's key, since the world is built
   *  without them. */
  private _liftSet: Set<string> | null = null;
  private _liftFor: object | null = null;
  private _liftGen = 0;
  /** Whether a marching edge is in the world, or in the lifted layer. */
  private _worldAnimated = false;
  private _liftedAnimated = false;
  /** The last nodes commit changed lifted nodes and nothing else. */
  private _liftOnly = false;
  /** The overscan the GL world was culled to, in its own pinned
   *  coordinates, and the key it was built under. */
  private _worldCull: FlowRect | null = null;
  private _worldCullId = 0;
  private _worldZoom = NaN;
  /** When the zoom last moved, whether that move continued a stream of
   *  them — a gesture, where one alone is a jump — and the timer that asks
   *  for the frame that rebuilds the GL world once the stream stops. */
  private _zoomAt = -Infinity;
  private _zoomStream = false;
  private _zoomRest: unknown = null;
  /** A 2D paint drew labels scaled mid-zoom, and owes them at their own
   *  sizes once it rests. */
  private _textApproximated = false;
  /**
   * Mid-zoom on the 2D renderer: the graph and its ground as the gesture
   * drew them once, on a surface of their own, composited scaled for every
   * step after — the GL renderer's world drawn scaled, in a bitmap. A step
   * used to stroke every edge, fill every card and lay the grid again, 20 ms
   * of Direct2D a step over the stress lattice, for a picture the next step
   * moved off. Dropped when the zoom rests, which paints it all again
   * exactly, and whenever the graph itself changes.
   */
  private _zoomShot: ZoomShot | null = null;
  /** A 2D drag's pictures (`_liftShotFor`), and the gesture that is not to
   *  have any: one whose view moved under it, where a picture a step would
   *  cost two full paints a step. */
  private _liftShot: LiftShot | null = null;
  private _liftShotRefused: object | null = null;
  /** Inside a live input dispatch — what makes a body emission `sync`.
   * Motion and the wheel run at continuous priority, whose React updates
   * can trail the pane's own painting by frames; an emission made under
   * this flag asks the receiver to commit before the dispatch returns. */
  private _gestureSync = false;
  /** Inside a call through `FlowInstance` (`fromHandle`) — an application's
   * handler, timer or animation loop moving the viewport. Its emissions ask
   * to commit inline too. */
  private _handleSync = false;
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

  /** The same shaping, both dimensions: what a scene's label chips are
   *  sized from. `_measure` answers a width because `measureNode` only ever
   *  wanted one. */
  private _measureBox = (
    text: string,
    options?: TextOptions,
  ): { width: number; height: number } =>
    measureText(this._textOptions(), text, options);

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
  private _applyNodes(nodes: readonly AnyNode[]): 'full' | FlowRect[] {
    const sameCardText = (a: AnyNode, b: AnyNode): boolean => {
      const da = a.data as FlowNodeData | undefined;
      const db = b.data as FlowNodeData | undefined;
      return (
        (da?.label ?? a.id) === (db?.label ?? b.id) &&
        da?.description === db?.description
      );
    };
    const prev = this._entries;
    this._nodesSeen = this.props.nodes;
    // Whether every node this commit changed is one a drag has lifted out
    // of the GL world — the commit of the drag's own step, when the app
    // stores it — so the world on the GPU is still the world.
    const lift = this._lifted();
    let onlyLifted = lift != null;
    this._liftOnly = false;
    let structural = nodes.length !== prev.length;
    if (!structural) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const o = prev[i].node;
        if (n === o) continue;
        if (
          n.id !== o.id ||
          n.type !== o.type ||
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
    const damage: FlowRect[] = [];
    // A node that is selected, or no longer is, is restyled and restacked —
    // selection lifts it over its neighbours — and both happen inside its
    // own box: edges are drawn under every node. Treated as structural, a
    // selection change re-measured every node and repainted the pane, which
    // a box selection does on every step that takes a node in.
    let reordered = false;
    // round the box: its handles, and the resize grips a selected node
    // grows at its corners, which at a deep zoom reach past the cull margin
    const margin = Math.max(
      CULL_MARGIN,
      RESIZE_GRIP * this._viewport().zoom + 2,
    );
    for (let i = 0; i < nodes.length; i++) {
      const entry = prev[i];
      const next = nodes[i];
      const old = entry.node;
      if (next === old) continue;
      if (!lift?.has(next.id)) onlyLifted = false;
      if (next.selected !== old.selected) reordered = true;
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
      const restyled =
        next.style !== old.style || next.selected !== old.selected;
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
      // Nothing the pane draws changed, while the node holds its place and
      // its size, when its card is the bodies' layer's — the layer repaints
      // it, if anything it shows changed — or when what changed is data its
      // card does not show: a card shows the label, the description and the
      // style, and a type that paints its own may show anything. A board of
      // live widgets, a tenth of them patching their data ten times a
      // second, rebuilt the GL world on every patch, and on the 2D renderer
      // repainted cards that showed none of it.
      if (!moved && !grew) {
        if (this._cardInLayer(next.id)) continue;
        if (!restyled && !entry.type?.paint && sameCardText(old, next)) {
          continue;
        }
      }
      // The edges ride along only when an endpoint actually moved — a
      // label edit that kept the box is the box's own business, and a
      // keystroke that unioned its node's edges swept half the layer's
      // neighbours into every repaint.
      box = unionRects(
        box,
        moved || grew ? this._nodeDamage(entry) : this._screenRect(entry),
      );
      damage.push(inflateRect(box, margin));
    }
    if (reordered) {
      this._sortOrder();
      // the minimap marks what is selected, in its corner of the pane
      const map = this._miniMapCorner();
      if (map) damage.push(map);
    }
    this._liftOnly = onlyLifted;
    return damage;
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
    this._sortOrder();
  }

  /** The paint order: by `zIndex`, a selected node over the rest of its
   *  layer, and declaration order breaking ties. */
  private _sortOrder(): void {
    this._order = this._entries
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

  /** The viewport with the pane's window origin folded in — what every
   *  graph-to-window conversion shared with `./scene.ts` takes. */
  private _screenViewport(): Viewport {
    return screenViewport(this._viewport(), this._pane());
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
   */
  private get _scale(): number {
    return this.scale > 0 ? this.scale : 1;
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

  /**
   * One entry as `./scene.ts` takes it: the live gesture state resolved
   * away, so everything past this point is pure. A drag's position and a
   * resize's box are already in `rect`, and `grips` is already filtered by
   * whatever the handles took.
   *
   * Built per call rather than cached: `rectOf` is what keeps a drag in step
   * with the commit that has not landed yet, and a cache here is a cache of
   * last frame's positions.
   */
  /** Whether a React body is mounted over this node — which is what makes
   * its card draw a title bar rather than a centred label, and what
   * `_emitBodies` reports a box for. */
  private _mounted(entry: NodeEntry): boolean {
    return entry.type?.render != null && this._viewport().zoom >= RENDER_ZOOM;
  }

  /**
   * The frame being painted: each node's scene source, and the two lists a
   * 2D pass builds its scene from. A frame paints its damage as several
   * passes — a pan's strips, its pinned furniture, the corners of a rounded
   * pane — and the scene cache culls the graph to the screen once for all
   * of them (`SceneCache.edgesOnScreen`), keyed on these very lists, so
   * every pass has to be handed the same ones. The passes run one after
   * another in a single task, so a microtask queued by the first forgets
   * the frame after the last — the same reasoning as `_reportFrame`.
   */
  private _frame: {
    sources: Map<NodeEntry, SceneNodeSource>;
    lists: { all: SceneNodeSource[]; nodes: SceneNodeSource[] } | null;
  } | null = null;

  private _paintedFrame(): NonNullable<FlowGraphNode['_frame']> {
    let frame = this._frame;
    if (!frame) {
      frame = this._frame = { sources: new Map(), lists: null };
      void Promise.resolve().then(() => {
        this._frame = null;
      });
    }
    return frame;
  }

  private _sourceOf(entry: NodeEntry): SceneNodeSource {
    if (!this._painting) return this._source(entry);
    const { sources } = this._paintedFrame();
    let source = sources.get(entry);
    if (!source) {
      source = this._source(entry);
      sources.set(entry, source);
    }
    return source;
  }

  /** A 2D pass's node lists, the same arrays for every pass of a frame. */
  private _frameLists(order: readonly NodeEntry[]): {
    all: SceneNodeSource[];
    nodes: SceneNodeSource[];
  } {
    const frame = this._paintedFrame();
    frame.lists ??= {
      all: this._entries.map((entry) => this._sourceOf(entry)),
      nodes: order
        .filter((entry) => !this._cardInLayer(entry.node.id))
        .map((entry) => this._sourceOf(entry)),
    };
    return frame.lists;
  }

  private _source(entry: NodeEntry): SceneNodeSource {
    return {
      node: entry.node,
      rect: this.rectOf(entry),
      specs: entry.specs,
      type: entry.type,
      header: this._headerHeight(entry),
      mounted: this._mounted(entry),
      connectable: this._connectable(entry),
      grips: this._grips(entry),
    };
  }

  /** Not through `_source`: a source carries its grips, and `_grips` asks
   *  where the handles are — the pair would recur. */
  private _handlesOf(entry: NodeEntry): HandleAnchor[] {
    return anchorsOf({
      node: entry.node,
      rect: this.rectOf(entry),
      specs: entry.specs,
    });
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
  private _screenRect(
    entry: NodeEntry,
    // A loop over the nodes passes it in: the viewport reads the pane's
    // content box off layout, and asked once per node it was most of what a
    // hit test cost on a large graph — every pointer move, 400 times.
    sv: Viewport = this._screenViewport(),
  ): FlowRect {
    return screenRect(sv, this.rectOf(entry), this._scale);
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
    if (previous.x !== v.x || previous.y !== v.y || previous.zoom !== v.zoom) {
      this._viewMovedAt = now();
    }
    if (previous.zoom !== v.zoom) {
      const t = now();
      this._zoomStream = t - this._zoomAt < GL_ZOOM_REST_MS;
      this._zoomAt = t;
    }
    // Each claims its own box: a claim with no region is the whole window,
    // which made every pan step and dash tick a full frame. The minimap's
    // alone: its view box moves, and the controls show nothing of the
    // viewport.
    for (const canvas of this._miniMapCanvases())
      canvas.invalidate(false, canvas, 'props');
    this._prop<(vp: Viewport) => void>('onViewportChange')?.(v);
    // The `fitView` that runs at the top of a paint has already changed what
    // this frame will draw, so asking for another one would only draw the
    // same picture twice.
    if (!controlled && !this._painting) {
      if (this._gl) {
        // Under GL a pan is the surface's offset uniform and nothing else,
        // and a zoom is the frame's to decide — the world scaled while the
        // gesture moves, rebuilt once it rests (`glFrame`). Neither is a
        // change to the world, and the 2D pane under the surface shows none
        // of the graph: claiming its box every step repainted it for
        // nothing (~4 ms a frame) — and, with bodies mounted, reached
        // core's overlay too.
        this._glRequest?.();
      } else if (!this._blitPan(previous, v)) this._repaint('scroll');
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
   * The furniture — minimap, zoom controls — stays put while the graph
   * moves, so it is handed over as `pinned` (react-x11#682, 2.22): the
   * whole pane is copied, and core repaints each panel and the image of
   * it the copy dragged along, with the strips the shift exposed.
   *
   * Mounted node bodies ride it. They are laid out in one box beside the
   * pane, which a pan moves by exactly the pan, so their pixels move with
   * the pane's: the box goes to `scrollContents` as a rider
   * (react-x11#671), its commit claims nothing, and what it leaves or
   * reaches outside the rect is all it costs. `<Flow>` clips it to the pane for that. A body entering or
   * leaving the pane, or changing as it goes, claims inside the rect and
   * declines that frame's blit; the next one blits again.
   *
   * Still a full repaint when:
   *  - the zoom moved (scaling is not a blit) or the shift is fractional on
   *    the device grid — every real pan gesture is whole device pixels;
   *  - bodies are mounted and `<Flow>` has not handed their box over;
   *  - the pane is too small to be worth it; and core falls back itself
   *    when the repairs would repaint most of it.
   */
  private _blitPan(previous: Viewport, next: Viewport): boolean {
    // There is no backing store to scroll under GL: the surface redraws the
    // whole scene every frame, and a pan is its cheapest frame of all.
    if (this._gl) return false;
    if (next.zoom !== previous.zoom) return false;
    const riders = this._bodies.length > 0 ? this._bodiesLayer : null;
    if (this._bodies.length > 0 && !riders) return false;
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
    // The furniture — minimap, zoom controls — stays put while the graph
    // moves under it: pinned inside the region, which core repaints after
    // the copy, with the stale image the copy dragged along (react-x11
    // #682, 2.22). It used to be carved out of the region, and a region is
    // one rectangle, so controls in one bottom corner and the minimap in the
    // other carved a band the pane's full width — every card, label and edge
    // in it repainted on every pan frame: 47 fps over the stress example's
    // widgets on XQuartz, where a pane with no furniture pans at 80.
    //
    // Device pixels, rounded out, and a pixel over: a panel's own claims —
    // the minimap's view box moves with every pan — must land inside its
    // pinned rect, or they decline the blit.
    const box = this.contentBox();
    if (box.width < 64 * s || box.height < 64 * s) return false;
    if (Math.abs(dx) >= box.width || Math.abs(dy) >= box.height) return false;
    const pinned: FlowRect[] = [];
    const pin = (rect: FlowRect): void => {
      const x0 = Math.max(box.x, Math.floor(rect.x) - 1);
      const y0 = Math.max(box.y, Math.floor(rect.y) - 1);
      const x1 = Math.min(
        box.x + box.width,
        Math.ceil(rect.x + rect.width) + 1,
      );
      const y1 = Math.min(
        box.y + box.height,
        Math.ceil(rect.y + rect.height) + 1,
      );
      if (x1 > x0 && y1 > y0) {
        pinned.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      }
    };
    if (this._panelCanvases.length > 0) {
      // Painted on canvases of their own, over mounted bodies: a node laid
      // over the region is pinned by its paint bounds, which carry core's
      // slop round its box.
      for (const canvas of this._panelCanvases) {
        const reach = canvas.paintBounds?.();
        if (reach) pin(reach);
      }
    } else {
      const map = this._miniMapOptions();
      if (map) {
        pin(
          this._device(
            this._corner(
              map.position,
              map.width ?? MINIMAP_W,
              map.height ?? MINIMAP_H,
              'bottom-right',
            ),
          ),
        );
      }
      const buttons = this._controlButtons();
      if (buttons.length > 0) {
        const first = buttons[0].rect;
        const last = buttons[buttons.length - 1].rect;
        pin(this._device(unionRects(first, last)));
      }
    }
    this.scrollContents(box, dx, dy, riders ? [riders] : null, pinned);
    this._blittedPanAt = now();
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

  /**
   * `fn`, as a call through the handle. A programmatic pan — an animation
   * loop stepping `setViewport` — moves the pane at once and the bodies'
   * box through React, and on React's schedule the box caught up with the
   * pane in jumps: several steps' worth in one commit, landing in a frame
   * whose blit shifted by one. A rider that moves by more than the blit is
   * a layout move, so that frame repainted the pane whole — a fifth of the
   * frames of a pan over mounted bodies (`_blitPan`). Marked like a
   * gesture's, the emission commits before the call returns, and the box
   * moves by exactly the pan in the frame that blits it.
   */
  fromHandle<T>(fn: () => T): T {
    const was = this._handleSync;
    this._handleSync = true;
    try {
      return fn();
    } finally {
      this._handleSync = was;
    }
  }

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
    const sv = this._screenViewport();
    for (let i = this._order.length - 1; i >= 0; i--) {
      const entry = this._order[i];
      if (entry.node.hidden) continue;
      if (rectContains(this._screenRect(entry, sv), { x, y })) return entry;
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
    const sv = this._screenViewport();
    for (let i = this._order.length - 1; i >= 0; i--) {
      const entry = this._order[i];
      if (entry.node.hidden) continue;
      if (!this._connectable(entry)) continue;
      // cheap reject: the handles are on the node's border, so nothing more
      // than `reach` outside its box can be one
      const rect = this._screenRect(entry, sv);
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
    const sv = this._screenViewport();
    for (let i = this._order.length - 1; i >= 0; i--) {
      const entry = this._order[i];
      if (entry.node.hidden) continue;
      const grips = this._grips(entry);
      if (grips.length === 0) continue;
      const rect = this._screenRect(entry, sv);
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
    return edgeCoarseBox(
      this._screenViewport(),
      this._source(source),
      this._source(target),
      this._scale,
    );
  }

  /** The drawn handle, in screen pixels. Capped as well as floored: a dot
   * that scaled all the way up would be a saucer at 2.5×, and the thing it
   * marks — a point on the border — does not get bigger. */
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
    return endpoint(
      { node: entry.node, rect: this.rectOf(entry), specs: entry.specs },
      handleId,
      type,
      towards,
    );
  }

  /** An edge's polyline, in **screen** pixels, plus the two ends it joins.
   * Null when either end is missing — an edge to a node that was removed is
   * a normal state during an edit, not an error. */
  private _edgeGeometry(
    edge: AnyEdge,
  ): { points: XYPosition[]; from: HandleAnchor; to: HandleAnchor } | null {
    const source = this._byId.get(edge.source);
    const target = this._byId.get(edge.target);
    if (!source || !target) return null;
    if (source.node.hidden || target.node.hidden) return null;
    return edgeRoute(
      this._screenViewport(),
      edge,
      this._source(source),
      this._source(target),
    );
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
        // The box is all that moves this step; a node crossing the boundary
        // changes `selected`, and that repaints through the controlled round
        // trip like any other selection change.
        this._claimSelectStep(oldBox, selectBoxRect(gesture));
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

  /**
   * The nodes a drag is moving, once it has moved them: lifted out of the
   * rest of the graph for the rest of the gesture. Under GL the world is
   * built without them and they are a layer of their own (`glFrame`), so
   * each step packs them and their edges and leaves the world on the GPU;
   * in 2D the rest is two pictures a step copies from (`_liftShotFor`).
   * Null otherwise — and under GL the change back is a change of the
   * world's key, which rebuilds it with them in.
   */
  private _lifted(): ReadonlySet<string> | null {
    const g = this._gesture;
    if (g?.kind !== 'drag' || !g.moved || g.ids.length === 0) {
      if (this._liftSet) {
        this._liftSet = null;
        this._liftFor = null;
        this._liftGen++;
      }
      return null;
    }
    if (this._liftFor !== g) {
      this._liftSet = new Set(g.ids);
      this._liftFor = g;
      this._liftGen++;
    }
    return this._liftSet;
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
    // edges that follow the moved nodes, coarse, on both sides. Under GL
    // there is nothing to size: the step is a frame of the surface's, and
    // routing each moved node's edges for a rect nobody reads was a third
    // of a millisecond a step.
    const sized = !this._gl;
    let damage: FlowRect | null = null;
    if (sized) {
      for (const id of gesture.ids) {
        const entry = this._byId.get(id);
        if (entry) damage = unionMaybe(damage, this._nodeDamage(entry));
      }
    }
    this._dragTo = to;
    if (sized) {
      for (const id of gesture.ids) {
        const entry = this._byId.get(id);
        if (entry) damage = unionMaybe(damage, this._nodeDamage(entry));
      }
    }
    this._emitNodes(changes);
    const reason = this._lifted() ? 'lift' : 'content';
    if (damage) {
      this._claim(inflateRect(damage, CULL_MARGIN), reason);
    } else {
      // under GL: a frame, and — while the nodes are lifted — of them alone
      this._repaint(reason);
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
    return connectionPath(this._screenViewport(), gesture);
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

  /**
   * What one step of a box selection changes on screen: a band round each
   * side of the box that moved, across the whole of both boxes. That covers
   * the outline where it was and where it is, and the tint where one box
   * lies over the graph and the other does not; a side that held still —
   * the two the gesture is anchored by — changed only where a moving side
   * shortened or lengthened it, which that side's band covers. Claiming the
   * box round both repainted everything under the selection, every node and
   * edge in it, on every step: 21 ms of a step on the stress example's
   * fan-out, which is what made a sweep lag the pointer.
   *
   * The bands are cut on the device grid so that none of them overlaps
   * another: core merges overlapping damage into the box round it, which is
   * the whole selection again — and a pass over a translucent tint must not
   * paint it twice. Claimed past this element's own `invalidate`, whose one
   * job here would be to repaint the minimap and the controls on their
   * canvases, and a box selection moves nothing on either.
   *
   * Under GL the box is the overlay's, drawn every frame: a step is a frame
   * and not a change to the world, which a claim would have rebuilt.
   */
  private _claimSelectStep(from: FlowRect, to: FlowRect): void {
    if (this._gl) {
      this._glRequest!();
      return;
    }
    const s = this._scale;
    const lo = (v: number): number => Math.floor(toDevice(v - SELECT_BAND, s));
    const hi = (v: number): number => Math.ceil(toDevice(v + SELECT_BAND, s));
    /** The bands round the sides that moved along one axis, merged where
     *  they meet, in device pixels. */
    const bands = (
      a0: number,
      a1: number,
      b0: number,
      b1: number,
    ): [number, number][] => {
      const out: [number, number][] = [];
      if (a0 !== b0) out.push([lo(Math.min(a0, b0)), hi(Math.max(a0, b0))]);
      if (a1 !== b1) out.push([lo(Math.min(a1, b1)), hi(Math.max(a1, b1))]);
      out.sort((m, n) => m[0] - n[0]);
      if (out.length === 2 && out[1][0] <= out[0][1]) {
        return [[out[0][0], Math.max(out[0][1], out[1][1])]];
      }
      return out;
    };
    const outer = unionRects(from, to);
    const x0 = lo(outer.x);
    const x1 = hi(outer.x + outer.width);
    const y0 = lo(outer.y);
    const y1 = hi(outer.y + outer.height);
    const columns = bands(from.x, from.x + from.width, to.x, to.x + to.width);
    const rows = bands(from.y, from.y + from.height, to.y, to.y + to.height);
    const claim = (x: number, y: number, width: number, height: number) => {
      if (width > 0 && height > 0) {
        super.invalidate(false, { x, y, width, height }, 'style-state');
      }
    };
    for (const [c0, c1] of columns) claim(c0, y0, c1 - c0, y1 - y0);
    for (const [r0, r1] of rows) {
      // across both boxes, less the columns already claimed
      let x = x0;
      for (const [c0, c1] of columns) {
        claim(x, r0, c0 - x, r1 - r0);
        x = Math.max(x, c1);
      }
      claim(x, r0, x1 - x, r1 - r0);
    }
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
    const sv = screenViewport(this._viewport(), pane);
    const items: A11ySceneItem[] = [];
    for (const entry of this._order) {
      if (entry.node.hidden) continue;
      const rect = this._screenRect(entry, sv);
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
    // Boxes rather than the box around them: the nodes a box selection
    // takes in one step lie along both of its moving edges, and the box
    // round an L of nodes is the whole selection again.
    let damage: 'full' | FlowRect[] = [];
    let edgesRedrawn = false;
    this._liftOnly = false;
    if (
      !shallowEqual(nextProps.nodeTypes, before.nodeTypes) ||
      !shallowEqual(nextProps.defaultEdgeOptions, before.defaultEdgeOptions)
    ) {
      this._sync();
      damage = 'full';
    } else {
      if (nextProps.edges !== before.edges) {
        const edgeDamage = this._applyEdges(this._rawEdges());
        if (edgeDamage === 'full') damage = 'full';
        else if (edgeDamage) {
          damage.push(edgeDamage);
          edgesRedrawn = true;
        }
      }
      if (damage !== 'full' && nextProps.nodes !== before.nodes) {
        const nodeDamage = this._applyNodes(this._nodes());
        if (nodeDamage === 'full') damage = 'full';
        else damage.push(...nodeDamage);
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
    // What moved, restyled or reshaped is the graph's own content: under GL
    // it is a frame of the surface's, where a claim billed as `props` went
    // on to a window pass over the 2D pane under it — every step of a drag
    // an app stores, 1.2 ms of each, for pixels the surface covers.
    if (damage === 'full') this._repaint('props');
    else {
      // a commit of lifted nodes alone is a frame of the lifted layer
      const reason = this._liftOnly && !edgesRedrawn ? 'lift' : 'content';
      for (const box of damage) this._claim(box, reason);
    }
    this._liftOnly = false;
    // Core re-reads the scene for aria-prop commits; a `nodes`/`edges`
    // change is invisible to it, so the re-read is asked for by name.
    // Free when no assistive technology is listening.
    if (damage === 'full' || damage.length > 0) this.notifyA11ySceneChanged();
  }

  override destroySubtree(): void {
    this._dropZoomShot();
    this._dropLiftShot();
    this._glRequest = null;
    if (this._bodiesRest != null) timers.clearTimeout?.(this._bodiesRest);
    this._bodiesRest = null;
    if (this._zoomRest != null) timers.clearTimeout?.(this._zoomRest);
    this._zoomRest = null;
    this._stopAnimation();
    this._dropGridTile();
    this._sceneCache.clear();
    super.destroySubtree();
  }

  private _startAnimation(): void {
    if (this._animTimer != null) return;
    this._animTimer =
      timers.setInterval?.(() => {
        // A pan that blits copies the pane's pixels, dashes and all, and a
        // tick claims the dashes inside the band it copies — which declines
        // the copy: every frame a tick landed in repainted the whole pane,
        // a sixth of a pan's frames and all of its stutter. So the dashes
        // sit the pan out, phase and all, and what the pan copies and what
        // it draws agree; they march again once it has held still.
        //
        // And the view moving at all is what they wait out, not a blit that
        // happened: a tick declines the blit it lands beside, so a pan
        // whose frames ran past the wait had its ticks back, each one
        // cancelling the next blit and repainting the pane — over the
        // stress example's widgets in a large window, 2 frames a second,
        // ticks and pan steps taking turns. A step since the last tick, or
        // one within two ticks, holds the dashes still whatever a frame
        // costs. Under GL a tick is a uniform and blits nothing, and they
        // march through a pan as before.
        //
        // A 2D tick is a repaint of the box the dashes are in, which over a
        // dense graph in a large window is most of the pane: 75 ms a tick on
        // XQuartz, against a timer of 60. So the wait scales with what
        // frames cost: the view held still for two frames' worth, and one
        // tick every two frames at most — the dashes slow down before the
        // thread is theirs, and a pan whose frames come slowly still sees
        // them hold still.
        const t = now();
        const lastTick = this._tickAt;
        this._tickAt = t;
        if (t - this._blittedPanAt < ANIMATION_MS * 2) return;
        let steps = 1;
        if (!this._gl) {
          const cost = this._tickCost * 2;
          const still = Math.max(ANIMATION_MS * 2, cost);
          if (this._viewMovedAt > lastTick || t - this._viewMovedAt < still) {
            return;
          }
          // a tick under ANIMATION_MS apart, less a millisecond of timer
          // slop; further while ticks are dear — and then the dashes cover
          // the ground the skipped ticks would have, so they slow down in
          // steps and not in speed
          const since = t - this._marchedAt;
          if (since < Math.max(ANIMATION_MS, cost) - 1) return;
          steps = Math.min(4, Math.max(1, Math.round(since / ANIMATION_MS)));
        }
        this._marchedAt = t;
        this._dashPhase += ANIMATION_SPEED * steps;
        // the box the last paint saw animated edges in, not the pane: a
        // marching dash should not cost a full grid repaint per tick. And
        // only the part of it the pane shows — an edge on its way out of
        // the pane takes the box past it, and claimed whole, a tick
        // repainted everything the window has beside the graph.
        const box = this._animBox ? this._device(this._animBox) : this.abs;
        const shown = intersectRects(box, this.contentBox());
        if (shown) this.invalidate(false, shown, 'animation');
      }, ANIMATION_MS) ?? null;
  }

  private _stopAnimation(): void {
    if (this._animTimer == null) return;
    timers.clearInterval?.(this._animTimer);
    this._animTimer = null;
  }

  // --- painting ------------------------------------------------------------

  override paint(ctx: Context2D): void {
    this._frameTick();
    const paintStart = now();

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
    if (this._gl) {
      // The surface over this box draws the graph. What the 2D pass still
      // owes is the part of a paint that is not drawing — the derived graph
      // brought up to date, the bodies placed — and then the frame itself,
      // asked of the surface. Every claim this element makes arrives here,
      // so every change the 2D renderer would repaint is one GL frame.
      this._sync();
      this._emitBodies();
      this._emitPanels();
      this._glRequest?.();
      return;
    }
    // Mid-gesture, labels come from the layouts they already have, scaled:
    // shaping every one again at each step of a zoom was half of what a 2D
    // step cost, at sizes the next step moves off. Only where the context
    // scales text with its transform — X11's draws glyphs at the size they
    // were shaped at — and set exactly once the zoom rests (`_restZoom`).
    const approximateText =
      this._zoomMoving() &&
      (ctx as { scalesText?: boolean }).scalesText === true;
    const painter = createPainter(ctx, {
      ...this._textOptions(),
      approximateText,
    });
    if (!painter) return; // a backend with no path API: geometry only
    if (approximateText) {
      this._textApproximated = true;
      this._restZoom();
    }

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
    const started = now();
    // Not under a drag or a connection: the picture would hold the moving
    // node, or the line, where they were
    const shot =
      this._zoomMoving() && !this._gesture
        ? this._zoomShotFor(palette, approximateText)
        : null;
    // A drag's nodes over pictures of the rest (`_liftShotFor`), in 2D and
    // not mid-zoom.
    const lift = shot || approximateText ? null : this._lifted();
    const liftShot = lift ? this._liftShotFor(palette, lift) : null;
    if (!lift && this._liftShot) this._dropLiftShot();
    let scene: FlowScene;
    if (liftShot && lift) {
      // the pictures, with the moved nodes' edges between them and the
      // nodes over both; the pane's furniture over it all
      const lifted = buildScene(
        this._sceneInput(palette, { lift: { ids: lift, only: true } }),
      );
      scene = buildScene(this._sceneInput(palette, 'overlay'));
      const built = now();
      this._compositeLift(ctx, liftShot, liftShot.under, null);
      paintGraphEdges(painter, lifted);
      this._compositeLift(ctx, liftShot, liftShot.over, liftShot.cards);
      paintGraphNodes(painter, lifted);
      paintFloat(painter, scene);
      this._reportFrame(built - started, now() - built);
    } else if (shot) {
      // the graph and the ground under it as the gesture drew them, scaled;
      // both live wherever the picture does not reach; and the pane's
      // furniture over them at the zoom of the moment
      scene = buildScene(this._sceneInput(palette, 'overlay'));
      const bands = this._uncovered(shot);
      const input = bands.length > 0 ? this._sceneInput(palette) : null;
      const live = input
        ? bands.map((band) => ({
            band,
            scene: buildScene({ ...input, clip: band }),
          }))
        : [];
      const built = now();
      this._compositeShot(ctx, shot);
      for (const { band, scene: part } of live) {
        painter.save();
        painter.clipRect(band.x, band.y, band.width, band.height, 0);
        paintGround(painter, part, this._grid);
        paintGraph(painter, part);
        painter.restore();
      }
      paintFloat(painter, scene);
      this._textApproximated = true;
      this._restZoom();
      this._reportFrame(built - started, now() - built);
    } else {
      scene = buildScene(this._sceneInput(palette));
      const built = now();
      paintScene(painter, scene, this._grid);
      this._reportFrame(built - started, now() - built);
    }
    // The box the dash ticks invalidate comes off the *drawn* geometry; a
    // pass that culled every animated edge keeps the one before it, because
    // the endpoints did not move, or that move's own damage would have
    // redrawn them here.
    if (scene.animBox) this._animBox = scene.animBox;
    painter.restore();
    this._painting = false;
    this._frameClip = null;
    {
      // What a frame costs, for the dash timer (`_startAnimation`): this
      // paint, and how long the server took to answer the frame before it
      // — on XQuartz most of it.
      const latency = (
        this.root as { window?: { frameLatency?: number } } | null
      )?.window?.frameLatency;
      // A reply can take seconds on a server that is waiting for a
      // display — a Mac's asleep — and that is when ticks most need to
      // hold; clamped rather than dropped, so one outlier does not stand
      // for long in the mean.
      const cost =
        now() -
        paintStart +
        (typeof latency === 'number' && latency > 0
          ? Math.min(latency, 2000)
          : 0);
      this._tickCost = this._tickCost * 0.7 + cost * 0.3;
    }

    // The timer exists only while something on screen needs it.
    if (scene.animated) this._startAnimation();
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
    this._emitPanels();
  }

  /**
   * Everything `buildScene` reads, gathered from the element once.
   *
   * The two node lists differ on purpose: `nodes` is the paint order with a
   * dragged node lifted to the top, and `all` is every node, because the
   * minimap summarises the graph rather than the pass.
   */
  override invalidate(
    layout?: boolean,
    damage?: Parameters<Node['invalidate']>[1],
    reason?: string,
  ): void {
    // Whatever changed the graph may have changed the minimap, which
    // `<Flow>` may be painting on a canvas of its own; a change to this
    // element's props may have changed the controls too. The controls draw
    // nothing of the graph, and repainting them with every step of a drag
    // repainted the minimap with them — each canvas builds the panels its
    // box reaches, and theirs reached both. Each claims its own box: a
    // claim with no region is the whole window, which made every pan step
    // and dash tick a full frame. A dash tick changes neither — the minimap
    // draws no dashes — and repainting both canvases on every one kept an
    // idle pane painting them 17 times a second, and put a claim in the
    // middle of any pan frame it landed in.
    if (reason !== 'animation') {
      const canvases =
        reason === 'props' ? this._panelCanvases : this._miniMapCanvases();
      for (const canvas of canvases) canvas.invalidate(false, canvas, 'props');
    }
    // A dash tick moves the phase, a uniform on the GPU, so it is no change
    // to the world. A pan or a zoom never gets here under GL.
    if (reason === 'lift') this._liftVersion++;
    else if (reason !== 'animation') this._worldVersion++;
    // …and what a 2D zoom gesture composites is the graph as it was: a
    // change to it is a picture that no longer is
    if (reason !== 'animation' && reason !== 'scroll') this._dropZoomShot();
    // Under GL the surface over this box draws the graph and the 2D pane
    // under it shows nothing: a claim of its pixels was a window pass over
    // them, unseen, whose one job was to reach `paint` and ask the surface
    // for a frame — a BeginDraw, a walk and a commit on every step of a
    // drag, 2.6 ms of each. The graph's own claims ask for the frame
    // directly; the frame does what `paint` did (`glFrame`). A layout change
    // and a change of props — which may move the panels — still go through.
    if (
      !layout &&
      damage != null &&
      (reason === 'content' ||
        reason === 'style-state' ||
        reason === 'animation' ||
        reason === 'lift') &&
      this._gl
    ) {
      this._glRequest!();
      return;
    }
    // a lift is this element's own bookkeeping; core knows it as content
    super.invalidate(layout, damage, reason === 'lift' ? 'content' : reason);
  }

  /** A 2D frame's cost so far, while its flush is still painting passes. */
  private _frameCost: { sceneMs: number; drawMs: number } | null = null;

  /**
   * One `onFrame` per window flush, however many damage passes it painted.
   * The window paints its passes one after another in a single task, so a
   * microtask queued by the first runs after the last — and reports the
   * frame whole, which is what a frame rate counts.
   */
  private _reportFrame(sceneMs: number, drawMs: number): void {
    if (!this.props.onFrame) return;
    if (this._frameCost) {
      this._frameCost.sceneMs += sceneMs;
      this._frameCost.drawMs += drawMs;
      return;
    }
    this._frameCost = { sceneMs, drawMs };
    void Promise.resolve().then(() => {
      const cost = this._frameCost;
      this._frameCost = null;
      if (!cost || this.destroyed) return;
      this._prop<(stats: FlowFrameStats) => void>('onFrame')?.({
        renderer: 'retained',
        sceneMs: cost.sceneMs,
        packMs: 0,
        drawMs: cost.drawMs,
        drawCalls: 0,
        lines: 0,
        boxes: 0,
        triangles: 0,
        uploadBytes: 0,
        worldRebuilt: false,
        gaps: { text: 0, custom: 0 },
        bodies: this.bodyBudget(),
      });
    });
  }

  private get _gl(): boolean {
    return this.props.renderer === 'gl' && this._glRequest != null;
  }

  /** What the GL renderer's label atlas sets strings with: this pane's app,
   *  for its staging surface, and the options its 2D painter measures with
   *  — so a label is cut and placed the same on both renderers. Null where
   *  there is no text engine to ask. */
  glText(): { app: unknown; options: PainterOptions } | null {
    const options = this._textOptions();
    return options.fonts ? { app: this.app, options } : null;
  }

  /**
   * The GL surface's hook: how it asks for frames. Set while a surface draws
   * this pane, cleared when it goes — and until it is set the pane draws
   * itself, so a surface that is still loading shows the 2D graph rather
   * than an empty box.
   */
  setGlRequest(request: (() => void) | null): void {
    if (this._glRequest === request) return;
    this._glRequest = request;
    // whichever renderer now draws, it draws the whole pane
    this._repaint('props');
  }

  /**
   * One GL frame's worth of scene, in the two layers the renderer keeps
   * apart (`./gl/renderer.ts`): the **world**, rebuilt only when it changed
   * since the key the surface last drew, and the **overlay**, every frame.
   *
   * The world is built at a pinned origin and culled to an *overscan* — the
   * view grown by a pane in every direction — so a pan inside it changes
   * nothing but `offset`. When the view leaves the overscan, or the zoom
   * moves, the overscan is re-centred and the world rebuilt; at every other
   * frame of a pan the world comes back `null` and the renderer draws the
   * buffers already on the GPU.
   *
   * A zoom *gesture* is drawn the same way: while the zoom keeps moving,
   * each step draws the world on the GPU magnified by `zoom` — the view's
   * zoom over the one it was built at — and the world is rebuilt at the
   * zoom the gesture stopped at, `GL_ZOOM_REST_MS` after its last step.
   * Rebuilding every step was the whole of a zoom's cost: a scene built,
   * packed and uploaded per step, 19 ms of it on a 300-node graph, where a
   * pan step is a uniform. What a magnified world gets wrong until then is
   * what a zoom does not scale linearly — a label's raster, the hairlines
   * with a floor of a pixel, the detail that appears past a zoom — which is
   * what every map does during a pinch. A single jump — a control's button,
   * `fitView`, `setViewport` — is not a stream and rebuilds at once, and so
   * does a step that would magnify one build by more than `GL_ZOOM_SPAN`
   * or show more of the graph than the overscan holds.
   *
   * The key is everything the world is a function of that this element can
   * name: its version (every repaint but a view change moves it), the
   * overscan, the zoom it was built at, and the palette and face — the two
   * a theme change moves, which core announces to the window rather than
   * to this element.
   *
   * Everything a 2D paint does around its drawing happens here too: the
   * pending fit, the dash timer, the first scene announcement, the bodies.
   */
  glFrame(
    lastKey: string | null,
    lastLifted: string | null = null,
  ): {
    world: FlowScene | null;
    key: string;
    lifted: FlowScene | null | undefined;
    liftedKey: string | null;
    offset: XYPosition;
    zoom: number;
    overlay: FlowScene;
    phase: number;
    moving: boolean;
  } | null {
    if (!this._visible()) return null;
    this._frameTick();
    this._sync();
    this._painting = true;
    this._frameClip = null;
    if (this._fitPending) {
      this._fitPending = false;
      this._fit(this._prop<FitViewOptions>('fitViewOptions'));
    }
    const v = this._viewport();
    const pane = this._pane();
    const palette = this._palette();

    const lift = this._lifted();
    const keyOf = (): string =>
      `${this._worldVersion}|${this._worldCullId}|${this._worldZoom}|` +
      `${this._fontSeen}|${JSON.stringify(palette)}|${this._liftGen}`;
    let key = keyOf();
    // The view in the world's own coordinates — graph × the zoom it was
    // built at, the pan left out: `offset` puts the pan back, and `zoom`
    // the rest of the zoom.
    const zoom = v.zoom / this._worldZoom;
    const view = {
      x: -v.x / zoom,
      y: -v.y / zoom,
      width: pane.width / zoom,
      height: pane.height / zoom,
    };
    const cull = this._worldCull;
    const inside =
      cull != null &&
      view.x >= cull.x &&
      view.y >= cull.y &&
      view.x + view.width <= cull.x + cull.width &&
      view.y + view.height <= cull.y + cull.height;
    const scaled =
      inside &&
      zoom !== 1 &&
      key === lastKey &&
      this._zoomStream &&
      now() - this._zoomAt < GL_ZOOM_REST_MS &&
      zoom <= GL_ZOOM_SPAN &&
      zoom >= 1 / GL_ZOOM_SPAN;
    if (scaled) {
      this._restZoom();
    } else if (!inside || zoom !== 1) {
      this._worldCull = {
        x: -v.x - pane.width,
        y: -v.y - pane.height,
        width: pane.width * 3,
        height: pane.height * 3,
      };
      this._worldZoom = v.zoom;
      this._worldCullId++;
      key = keyOf();
    }

    let world: FlowScene | null = null;
    if (key !== lastKey) {
      world = buildScene(
        this._sceneInput(palette, {
          world: this._worldCull!,
          lift: lift ? { ids: lift, only: false } : undefined,
        }),
      );
      this._worldAnimated = world.animated;
    }
    // The nodes a drag moves, and their edges, on their own: a step
    // rebuilds them and not the world (`_liftVersion`).
    let lifted: FlowScene | null | undefined;
    const liftedKey = lift ? `${this._liftVersion}|${key}` : null;
    if (lift && liftedKey !== lastLifted) {
      lifted = buildScene(
        this._sceneInput(palette, {
          world: this._worldCull!,
          lift: { ids: lift, only: true },
        }),
      );
      this._liftedAnimated = lifted.animated;
    } else if (!lift && lastLifted != null) {
      lifted = null;
      this._liftedAnimated = false;
    }
    if (world || lifted !== undefined) {
      // The dash timer lives as long as an animated edge is drawn; its
      // ticks move the phase, a uniform.
      if (this._worldAnimated || this._liftedAnimated) this._startAnimation();
      else this._stopAnimation();
    }
    const overlay = buildScene(this._sceneInput(palette, 'overlay'));
    this._painting = false;

    if (!this._sceneAnnounced) {
      this._sceneAnnounced = true;
      this.notifyA11ySceneChanged();
    }
    this._emitBodies();
    return {
      world,
      key,
      lifted,
      liftedKey,
      offset: { x: pane.x + v.x, y: pane.y + v.y },
      zoom: scaled ? zoom : 1,
      overlay,
      // the scene bakes `-phase * zoom` into a marching edge; the GPU is
      // handed the same number as a uniform
      phase: -this._dashPhase * v.zoom,
      moving: this._zoomMoving(),
    };
  }

  /** The frame that rebuilds the GL world once a zoom gesture stops — asked
   *  for `GL_ZOOM_REST_MS` after its last step, however many steps the
   *  timer outlived. */
  private _restZoom(): void {
    if (this._zoomRest != null) return;
    const wait = this._zoomAt + GL_ZOOM_REST_MS - now();
    this._zoomRest = timers.setTimeout?.(
      () => {
        this._zoomRest = null;
        if (now() - this._zoomAt < GL_ZOOM_REST_MS) this._restZoom();
        else if (this._gl) this._glRequest?.();
        else if (this._textApproximated) {
          this._dropZoomShot();
          // …and in 2D, the labels the gesture drew scaled, set at their
          // own sizes
          this._textApproximated = false;
          this._repaint('content');
        }
      },
      Math.max(0, wait) + 1,
    );
  }

  /**
   * The graph painted once onto a surface of its own for the zoom gesture
   * under way — made at the gesture's first step that finds none — or null
   * where there is no surface to paint on.
   */
  private _zoomShotFor(
    palette: FlowPalette,
    approximateText: boolean,
  ): ZoomShot | null {
    const held = this._zoomShot;
    if (held) {
      // Kept while it is sharp enough and covers enough: magnified past
      // `GL_ZOOM_SPAN` it is soft, and a zoom out uncovers a ring the step
      // paints live, which past `ZOOM_SHOT_LIVE` of the pane costs what a
      // new picture does.
      const k = this._viewport().zoom / held.viewport.zoom;
      const pane = this._pane();
      const live =
        this._uncovered(held).reduce((sum, r) => sum + r.width * r.height, 0) /
        Math.max(1, pane.width * pane.height);
      if (k <= GL_ZOOM_SPAN && live <= ZOOM_SHOT_LIVE) return held;
      this._dropZoomShot();
    }
    const ctor = (ntk as unknown as { Surface?: ShotCtor }).Surface;
    if (typeof ctor !== 'function') return null;
    const pane = this._pane();
    const scale = this._scale;
    const width = Math.max(1, Math.ceil(pane.width * scale));
    const height = Math.max(1, Math.ceil(pane.height * scale));
    let surface: ShotSurface;
    try {
      surface = new ctor(this.app, { width, height, format: 'argb32' });
    } catch {
      return null;
    }
    const sctx = surface.getContext('2d') as {
      translate?(x: number, y: number): void;
    } | null;
    // its labels drawn as a step inside the gesture draws them — from the
    // sizes they have, where the window's context scales text — so the one
    // paint of the gesture shapes nothing the gesture would not
    const painter = sctx
      ? createPainter(sctx, { ...this._textOptions(), approximateText })
      : null;
    if (!sctx || !painter || typeof sctx.translate !== 'function') {
      surface.destroy?.();
      return null;
    }
    // The surface's corner is the pane's, and the whole of the pane is in
    // it whatever this pass's damage, since every step after composites it.
    // The ground too: a grid at the fractional pitch a zoom passes through
    // is thousands of runs, 7 ms of Direct2D a step over the stress
    // lattice's pane once the graph was a picture. Drawn as runs here —
    // the tile is a pattern on the window's context, phased in its pixels,
    // and a zoom's pitch is a fraction of a pixel almost always.
    sctx.translate(-pane.x * scale, -pane.y * scale);
    const whole = buildScene({ ...this._sceneInput(palette), clip: null });
    paintGround(painter, whole);
    paintGraph(painter, whole);
    this._zoomShot = { surface, viewport: this._viewport(), width, height };
    return this._zoomShot;
  }

  /** Where the gesture's picture lands at the viewport of the moment, in
   *  the pane's logical pixels: a world point drawn at `w·z₀ + v₀` is at
   *  `w·z + v`, so the picture is scaled by `z / z₀` about the pane's corner
   *  and moved by `v − v₀·z/z₀`. */
  private _shotRect(shot: ZoomShot): FlowRect {
    const v = this._viewport();
    const v0 = shot.viewport;
    const k = v.zoom / v0.zoom;
    const pane = this._pane();
    const s = this._scale;
    return {
      x: pane.x + v.x - v0.x * k,
      y: pane.y + v.y - v0.y * k,
      width: (shot.width / s) * k,
      height: (shot.height / s) * k,
    };
  }

  private _compositeShot(ctx: Context2D, shot: ZoomShot): void {
    const draw = (
      ctx as unknown as {
        drawImage?(image: unknown, ...args: number[]): void;
      }
    ).drawImage;
    if (typeof draw !== 'function') return;
    const to = this._shotRect(shot);
    const s = this._scale;
    draw.call(
      ctx,
      shot.surface,
      0,
      0,
      shot.width,
      shot.height,
      to.x * s,
      to.y * s,
      to.width * s,
      to.height * s,
    );
  }

  /**
   * The pane this pass reaches that the gesture's picture does not: nothing
   * while zooming in about a point in the pane, a ring round it zooming out,
   * a side after a pan. Up to four bands — above, below, and either side
   * between them — each reaching a pixel under the picture's edge, which
   * its filtering leaves half there.
   */
  private _uncovered(shot: ZoomShot): FlowRect[] {
    const pane = this._frameClip
      ? intersectRects(this._pane(), this._frameClip)
      : this._pane();
    if (!pane) return [];
    const inner = inflateRect(this._shotRect(shot), -1);
    const x0 = Math.max(pane.x, inner.x);
    const y0 = Math.max(pane.y, inner.y);
    const x1 = Math.min(pane.x + pane.width, inner.x + inner.width);
    const y1 = Math.min(pane.y + pane.height, inner.y + inner.height);
    if (x1 <= x0 || y1 <= y0) return [pane];
    const right = pane.x + pane.width;
    const bottom = pane.y + pane.height;
    const bands: FlowRect[] = [];
    if (y0 > pane.y) {
      bands.push({
        x: pane.x,
        y: pane.y,
        width: pane.width,
        height: y0 - pane.y,
      });
    }
    if (bottom > y1) {
      bands.push({ x: pane.x, y: y1, width: pane.width, height: bottom - y1 });
    }
    if (x0 > pane.x) {
      bands.push({ x: pane.x, y: y0, width: x0 - pane.x, height: y1 - y0 });
    }
    if (right > x1) {
      bands.push({ x: x1, y: y0, width: right - x1, height: y1 - y0 });
    }
    return bands;
  }

  private _dropZoomShot(): void {
    this._zoomShot?.surface.destroy?.();
    this._zoomShot = null;
  }

  /**
   * The pictures a 2D drag copies from — made on the first pass of the
   * gesture that has its nodes lifted, and kept while the graph under them
   * and the view hold still. A drag step repainted the box round the moved
   * node and every edge on it, and an edge is as long as it is: the stress
   * lattice sends its last rows' edges back to its first nodes, so dragging
   * one repainted the window a step, every card and edge in it, at 46-57
   * fps on Cocoa. Cutting the damage finer did not help — core merges a
   * frame's rects down to four, and a long diagonal's pieces merge back to
   * most of the pane. Copying what did not move is what does.
   *
   * Null where there is no offscreen surface, and for a gesture whose view
   * moved while it held pictures: it paints live from then on, rather than
   * paint the graph twice a step.
   */
  private _liftShotFor(
    palette: FlowPalette,
    lift: ReadonlySet<string>,
  ): LiftShot | null {
    const gesture = this._liftFor;
    if (!gesture || this._liftShotRefused === gesture) return null;
    const v = this._viewport();
    const pane = this._pane();
    const scale = this._scale;
    const width = Math.max(1, Math.ceil(pane.width * scale));
    const height = Math.max(1, Math.ceil(pane.height * scale));
    const held = this._liftShot;
    if (held) {
      const still =
        held.viewport.x === v.x &&
        held.viewport.y === v.y &&
        held.viewport.zoom === v.zoom;
      if (
        held.gesture === gesture &&
        still &&
        held.version === this._worldVersion &&
        held.width === width &&
        held.height === height
      ) {
        return held;
      }
      this._dropLiftShot();
      if (held.gesture === gesture && !still) {
        this._liftShotRefused = gesture;
        return null;
      }
    }
    const ctor = (ntk as unknown as { Surface?: ShotCtor }).Surface;
    if (typeof ctor !== 'function') return null;
    const make = (): {
      surface: ShotSurface;
      painter: FlowPainter;
    } | null => {
      let surface: ShotSurface;
      try {
        surface = new ctor(this.app, { width, height, format: 'argb32' });
      } catch {
        return null;
      }
      const sctx = surface.getContext('2d') as {
        translate?(x: number, y: number): void;
        clearRect?(x: number, y: number, w: number, h: number): void;
      } | null;
      const painter = sctx ? createPainter(sctx, this._textOptions()) : null;
      if (!sctx || !painter || typeof sctx.translate !== 'function') {
        surface.destroy?.();
        return null;
      }
      // a clear ground: the cards' picture goes over the edges
      sctx.clearRect?.(0, 0, width, height);
      sctx.translate(-pane.x * scale, -pane.y * scale);
      return { surface, painter };
    };
    const under = make();
    const over = under ? make() : null;
    if (!under || !over) {
      under?.surface.destroy?.();
      return null;
    }
    const rest = buildScene({
      ...this._sceneInput(palette, { lift: { ids: lift, only: false } }),
      clip: null,
    });
    paintGround(under.painter, rest);
    paintGraphEdges(under.painter, rest);
    paintGraphNodes(over.painter, rest);
    this._liftShot = {
      under: under.surface,
      over: over.surface,
      cards: rest.nodes.map((item) => inflateRect(item.rect, CULL_MARGIN)),
      gesture,
      version: this._worldVersion,
      viewport: { ...v },
      width,
      height,
    };
    return this._liftShot;
  }

  /**
   * One of a drag's pictures, copied into this pass's rect of the pane —
   * the whole pane on a full pass. The ground's picture is opaque and is
   * *copied*, which the server does as a copy rather than a blend (`copy`
   * is XRender's `Src`, and a memcpy on Cocoa); the cards' picture is
   * blended in only where a card is (`only`). On XQuartz the two blends of
   * the step's box — as big as the moved node's longest edge — were most
   * of what a drag cost the server.
   */
  private _compositeLift(
    ctx: Context2D,
    shot: LiftShot,
    surface: ShotSurface,
    only: FlowRect[] | null,
  ): void {
    const c = ctx as unknown as {
      drawImage?(image: unknown, ...args: number[]): void;
      globalCompositeOperation?: string;
    };
    if (typeof c.drawImage !== 'function') return;
    const pane = this._pane();
    const rect = this._frameClip ? intersectRects(pane, this._frameClip) : pane;
    if (!rect) return;
    if (only) {
      for (const card of only) {
        const part = intersectRects(rect, card);
        if (part) this._copyShotRect(c, shot, surface, part);
      }
      return;
    }
    const before = c.globalCompositeOperation;
    c.globalCompositeOperation = 'copy';
    try {
      this._copyShotRect(c, shot, surface, rect);
    } finally {
      c.globalCompositeOperation = before ?? 'source-over';
    }
  }

  /** A rect of the pane, logical pixels, drawn from the same rect of a
   *  picture of it — on whole device pixels, so nothing is resampled. */
  private _copyShotRect(
    ctx: { drawImage?(image: unknown, ...args: number[]): void },
    shot: LiftShot,
    surface: ShotSurface,
    rect: FlowRect,
  ): void {
    const pane = this._pane();
    const s = this._scale;
    const ox = pane.x * s;
    const oy = pane.y * s;
    const x0 = Math.max(0, Math.floor(rect.x * s - ox));
    const y0 = Math.max(0, Math.floor(rect.y * s - oy));
    const x1 = Math.min(shot.width, Math.ceil((rect.x + rect.width) * s - ox));
    const y1 = Math.min(
      shot.height,
      Math.ceil((rect.y + rect.height) * s - oy),
    );
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0;
    const h = y1 - y0;
    ctx.drawImage!(surface, x0, y0, w, h, ox + x0, oy + y0, w, h);
  }

  private _dropLiftShot(): void {
    this._liftShot?.under.destroy?.();
    this._liftShot?.over.destroy?.();
    this._liftShot = null;
  }

  /** Whether a zoom gesture is moving: a stream of zoom steps, the last of
   *  them under `GL_ZOOM_REST_MS` ago. A single step — a button, `fitView`,
   *  an app's `setViewport` — is not one. */
  private _zoomMoving(): boolean {
    return this._zoomStream && now() - this._zoomAt < GL_ZOOM_REST_MS;
  }

  /** Whether this pass's damage reaches the minimap's corner at all —
   *  answered from the panel's box alone, without resolving the map. */
  private _miniMapReached(): boolean {
    const corner = this._miniMapCorner();
    if (!corner) return false;
    const clip = this._frameClip;
    return !clip || rectsOverlap(corner, clip);
  }

  /** The minimap's panel, in logical window pixels, or null without one. */
  private _miniMapCorner(): FlowRect | null {
    const options = this._miniMapOptions();
    if (!options) return null;
    return this._corner(
      options.position,
      options.width ?? MINIMAP_W,
      options.height ?? MINIMAP_H,
      'bottom-right',
    );
  }

  /**
   * Everything `buildScene` reads, for one of three uses:
   *
   * - `'all'` — the 2D renderer's pass: the pane as it is, culled to this
   *   pass's damage.
   * - `{ world }` — the GL graph: built at a **pinned origin** (the viewport's
   *   translation and the pane's origin both left out, so a pan does not
   *   change a vertex) and culled to the overscan `world` rather than the
   *   pane, with none of the pane's furniture.
   * - `'overlay'` — the GL furniture: the pane's background, grid, selection,
   *   minimap and controls, and no graph at all.
   */
  /**
   * The order nodes are drawn in, bottom to top: `zIndex`, then selection,
   * then declaration (`_order`), with a node being dragged lifted over all
   * of them. The one order both halves of a node follow — its card in the
   * scene, its mounted body in `_emitBodies` — so a body is stacked over
   * the bodies of the cards under its own, and under the ones above.
   */
  private _paintOrder(): NodeEntry[] {
    const dragging = this._dragTo;
    if (!dragging || dragging.size === 0) return this._order;
    const order: NodeEntry[] = [];
    const lifted: NodeEntry[] = [];
    for (const entry of this._order) {
      if (dragging.has(entry.node.id)) lifted.push(entry);
      else order.push(entry);
    }
    return order.concat(lifted);
  }

  private _sceneInput(
    palette: FlowPalette,
    layer:
      | 'all'
      | 'overlay'
      | 'card'
      | {
          /** The GL world's overscan; left out, the pane as a 2D pass sees
           *  it. */
          world?: FlowRect;
          /** Without the lifted nodes and their edges, or those alone
           *  (`only`). */
          lift?: { ids: ReadonlySet<string>; only: boolean };
        } = 'all',
    /** The panels even while `<Flow>` paints them itself — for that paint. */
    panels = false,
  ): SceneInput {
    // One card, for `paintCard`, which hands in the node itself: nothing
    // about the rest of the graph is read, where the whole input — every
    // node's source twice over, the minimap's walk for its bounds — was most
    // of what a card cost to paint, and a zoom repaints every one of them.
    if (layer === 'card') {
      const gesture = this._gesture;
      return {
        viewport: this._viewport(),
        pane: this._pane(),
        clip: null,
        palette,
        background: normalizeBackground(undefined),
        nodes: [],
        all: [],
        edges: [],
        dashPhase: this._dashPhase,
        hover: this._hover,
        connection: gesture?.kind === 'connect' ? gesture : null,
        selection: null,
        miniMap: null,
        controls: [],
        scale: this._scale,
        measure: this._measureBox,
        cache: this._sceneCache,
      };
    }
    const order = this._paintOrder();
    const gesture = this._gesture;
    // The panel cull comes before `_miniMap()`, which walks every node to
    // find the graph's bounds — during a drag that walk per pass would cost
    // more than the panel it skips. The dot for a mid-drag node goes stale
    // until the release repaints in full; that is the trade, and it is
    // deliberate.
    const world = typeof layer === 'object' ? (layer.world ?? null) : null;
    const lift = typeof layer === 'object' ? layer.lift : undefined;
    const overlay = layer === 'overlay';
    // the furniture is the overlay's: a lifted layer or the graph under it
    // has none of its own
    const map =
      !world && !lift && this._miniMapReached() ? this._miniMap() : null;
    const viewport = this._viewport();
    const pane = this._pane();
    // An edge is the lifted layer's when either end is lifted.
    const edges = lift
      ? this._edges.filter(
          (e) =>
            (lift.ids.has(e.source) || lift.ids.has(e.target)) === lift.only,
        )
      : this._edges;
    let all: SceneNodeSource[];
    if (lift?.only) {
      // the lifted nodes and the far ends of their edges: all the lifted
      // layer routes to, where every node's source was most of a step
      const ids = new Set(lift.ids);
      for (const e of edges) {
        ids.add(e.source);
        ids.add(e.target);
      }
      all = [];
      for (const id of ids) {
        const entry = this._byId.get(id);
        if (entry) all.push(this._sourceOf(entry));
      }
    } else if (overlay && !map) {
      all = [];
    } else if (layer === 'all' && this._painting) {
      all = this._frameLists(order).all;
    } else {
      all = this._entries.map((entry) => this._sourceOf(entry));
    }
    return {
      viewport: world ? { x: 0, y: 0, zoom: viewport.zoom } : viewport,
      pane: world
        ? { x: 0, y: 0, width: pane.width, height: pane.height }
        : pane,
      clip: world || overlay ? null : this._frameClip,
      cull: world,
      palette,
      paneBackground: this.style.backgroundColor as string | undefined,
      background: normalizeBackground(
        this.props.background as
          BackgroundOptions | string | boolean | undefined,
      ),
      // a card `<Flow>` paints in the bodies' layer is not painted twice
      nodes: overlay
        ? []
        : layer === 'all' && this._painting
          ? this._frameLists(order).nodes
          : order
              .filter(
                (entry) =>
                  !this._cardInLayer(entry.node.id) &&
                  (!lift || lift.ids.has(entry.node.id) === lift.only),
              )
              .map((entry) => this._sourceOf(entry)),
      all,
      edges: overlay ? [] : edges,
      dashPhase: this._dashPhase,
      hover: this._hover,
      connection: !overlay && gesture?.kind === 'connect' ? gesture : null,
      selection:
        !world && gesture?.kind === 'select' ? selectBoxRect(gesture) : null,
      miniMap:
        map && (panels || this._panelCanvases.length === 0)
          ? {
              panel: map.panel,
              bounds: map.bounds,
              scale: map.scale,
              nodeColor: map.options.nodeColor,
              maskColor: map.options.maskColor,
            }
          : null,
      controls:
        world || lift || (!panels && this._panelCanvases.length > 0)
          ? []
          : this._controlButtons(),
      scale: this._scale,
      measure: this._measureBox,
      cache: this._sceneCache,
    };
  }

  /**
   * Where every mounted node body belongs, and where the graph's origin is.
   *
   * The two are sent apart because they change apart. A body's rect is
   * relative to the **graph's origin on screen** — its position times the
   * zoom — which a pan does not move; the origin is the viewport's
   * translation, which is all a pan moves. So a pan re-sends the *same*
   * bodies array with a new origin, `<Flow>` moves the one box they are
   * laid out in, and React re-renders none of them: the per-step commit of
   * every mounted body's position is what held a pan over 48 of them to 57
   * frames a second. A drag, a zoom, a selection or a body entering the pane
   * sends a new array, as before.
   */
  private _emitBodies(): void {
    const notify =
      this._prop<
        (
          bodies: readonly NodeBodyRect[],
          sync: boolean,
          origin: XYPosition,
          held: boolean,
        ) => void
      >('onNodeBodies');
    if (!notify) return;
    const v = this._viewport();
    if (this._holdBodies(v.zoom)) {
      if (!this._bodiesHeld) {
        this._bodiesHeld = true;
        // The cards are the graph's again from this frame, not from the
        // commit that hides the bodies: GL frames do not wait for React's,
        // and one that landed between the two drew neither — edges with no
        // nodes under them, for a frame at the start of a zoom. What the
        // layer painted is forgotten too, so the cards stay the graph's
        // until the bodies are back and their canvases have painted again.
        this._paintedCards.clear();
        this._worldVersion++;
        this._glRequest?.();
        notify(
          this._bodies,
          this._gestureSync || this._handleSync,
          this._bodiesOrigin,
          true,
        );
      }
      return;
    }
    const pane = this._pane();
    // Exact, and every rect below relative to it and free of the pan: a
    // card's offset from the graph's origin is its graph position times the
    // zoom, so a pan re-sends the same array and moves only the origin.
    // Nothing here is rounded — `<Flow>` puts the boxes on the device-pixel
    // grid, once. Rounded here as well, to logical pixels against a rounded
    // origin, a card's offset flipped by a pixel as the pan's fraction
    // cycled against the device grid `_screenRect` snaps to: the array was
    // new on most steps of a pan, and at 1.25× the layer changed size with
    // it — every body repainted, where core would have moved them.
    const origin = { x: v.x, y: v.y };
    const sv = screenViewport(v, pane);
    const was = this._bodies;
    const bodies: NodeBodyRect[] = [];
    let changed = false;
    for (const entry of this._paintOrder()) {
      if (entry.node.hidden || !this._mounted(entry)) continue;
      if (!rectsOverlap(this._screenRect(entry, sv), pane)) continue;
      const graph = this.rectOf(entry);
      const x = graph.x * v.zoom;
      const y = graph.y * v.zoom;
      const cardWidth = graph.width * v.zoom;
      const cardHeight = graph.height * v.zoom;
      const header = this._headerHeight(entry) * v.zoom;
      const inset = NODE_BODY_INSET * v.zoom;
      const width = cardWidth - inset * 2;
      const height = cardHeight - header - inset;
      if (width <= 1 || height <= 1) continue;
      const id = entry.node.id;
      const hovered = this._hover.nodeId === id;
      const selected = entry.node.selected ?? false;
      // The zoom counts as well as the rect it produced: it is the body's
      // subtree scale, and two zooms a hair apart can leave a box where it
      // was while the text inside it should have moved.
      const old = this._bodiesById.get(id);
      const body =
        old &&
        old.zoom === v.zoom &&
        old.selected === selected &&
        old.hovered === hovered &&
        old.card.x === x &&
        old.card.y === y &&
        old.card.width === cardWidth &&
        old.card.height === cardHeight &&
        old.height === height
          ? old
          : {
              id,
              card: { x, y, width: cardWidth, height: cardHeight },
              hovered,
              // logical, and relative to the graph's origin on screen — the
              // box they are laid out in sits at `origin` in the pane
              x: x + inset,
              y: y + header,
              width,
              height,
              zoom: v.zoom,
              selected,
            };
      if (body !== was[bodies.length]) changed = true;
      bodies.push(body);
    }
    if (bodies.length !== was.length) changed = true;
    // An origin with no bodies laid out at it is nobody's news: a pan over a
    // graph whose node types mount bodies, with none on screen, sent one per
    // step, and `<Flow>` re-rendered for it — its panels' canvases with it.
    // The origin is still kept, and goes out with the first body to arrive.
    const moved =
      was.length > 0 &&
      (origin.x !== this._bodiesOrigin.x || origin.y !== this._bodiesOrigin.y);
    const released = this._bodiesHeld;
    if (!changed && !moved && !released) return;
    if (changed) {
      this._bodies = bodies;
      this._bodiesById = new Map(bodies.map((body) => [body.id, body]));
    }
    this._bodiesOrigin = origin;
    this._bodiesHeld = false;
    notify(this._bodies, this._gestureSync || this._handleSync, origin, false);
  }

  /**
   * Whether mounted bodies sit this zoom out.
   *
   * A zoom changes every body's scale, and a scale is not a transform: each
   * body is styled, laid out, its text shaped and its pixels painted again,
   * at the new size, per step. That is about a millisecond a body on this
   * class of machine — 42 bodies held a zoom to 15 frames a second where
   * the graph alone costs 13 ms a step. So each step of a zoom *gesture*
   * predicts what re-scaling the bodies on screen would add, and when that
   * is over `BODY_BUDGET_MS` they sit the gesture out: still mounted — no
   * state is lost — but hidden (`display: 'none'`) and untouched, while the
   * cards, their labels and the edges carry it. Once the zoom has held still
   * for
   * `BODY_ZOOM_REST_MS` they come back, laid out once at the new scale. A
   * handful of bodies fits the budget and zooms live.
   *
   * The prediction is bodies × what one costs, measured from the pane's own
   * frames (`_frameTick`) — so a slower machine holds sooner. Once held, a
   * gesture stays held until it rests: bodies blinking in and out as the
   * count crosses the line would be worse than either.
   *
   * Only a stream counts: a gesture's steps — the wheel, a pinch, the keys
   * (`_gestureSync`) — or an animation's, `setViewport` a frame at a time,
   * each zoom under `GL_ZOOM_REST_MS` after the one before (`_zoomStream`,
   * the rule the zoom's picture and its scaled labels already follow). A
   * single programmatic jump — `fitView`, `setViewport`, a control's button
   * — applies at once, so an app that sets the viewport and reads the result
   * sees it; the pane never animates a viewport of its own. An animation
   * that stepped every body at every frame held a zoom over the stress
   * example's charts to 10 frames a second.
   */
  private _holdBodies(zoom: number): boolean {
    if (zoom !== this._seenZoom) {
      const first = Number.isNaN(this._seenZoom);
      this._seenZoom = zoom;
      if (
        first ||
        (!this._gestureSync && !this._zoomStream && !this._bodiesHeld)
      ) {
        return false;
      }
      const bodies = this._bodies.length;
      if (!this._bodiesHeld && bodies * this._bodyStepMs <= this._budgetMs()) {
        this._zoomStep = { live: true, bodies };
        return false;
      }
      this._zoomStep = { live: false, bodies: 0 };
      this._bodiesAt = now();
      this._restBodies();
      return true;
    }
    return this._bodiesHeld && this._bodiesRest != null;
  }

  /** Bring the held bodies back once the zoom has held still for
   *  `BODY_ZOOM_REST_MS` — judged on the pane's clock, like the zoom's own
   *  rest (`_restZoom`): a timer that comes due while steps are still
   *  arriving waits out what is left of the rest instead. */
  private _restBodies(): void {
    if (this._bodiesRest != null) return;
    const wait = this._bodiesAt + BODY_ZOOM_REST_MS - now();
    this._bodiesRest = timers.setTimeout?.(
      () => {
        this._bodiesRest = null;
        if (now() - this._bodiesAt < BODY_ZOOM_REST_MS) this._restBodies();
        else this._emitBodies();
      },
      Math.max(0, wait) + 1,
    );
  }

  /**
   * Paint one mounted node's card — fill, border, header, handles, grips —
   * into `ctx`, a `<canvas>` in the bodies' layer (`<Flow>`), exactly as the
   * scene paints it. `ctx` is at the canvas's origin, `abs` its place in
   * the window in device pixels.
   *
   * Why the card is painted twice: the bodies share one layer over every
   * card — over the GL surface, or beside the 2D pane — so a body could not
   * go under a card that was over its own. It painted over that card's
   * header, border and handles: a selected node's outline hidden behind the
   * body of the node under it. A card painted in the bodies' layer, just
   * under its own body, is stacked with it in the cards' paint order, and
   * covers the card the graph drew for it.
   */
  paintCard(id: string, ctx: unknown, abs: XYPosition): void {
    const entry = this._byId.get(id);
    if (!entry) return;
    const painter = createPainter(ctx, this._textOptions());
    if (!painter) return;
    const palette = this._palette();
    const input = this._sceneInput(palette, 'card');
    const [item] = buildNodeItems({
      ...input,
      nodes: [this._source(entry)],
      clip: null,
      cull: undefined,
    });
    if (!item) return;
    const c = ctx as {
      save(): void;
      restore(): void;
      translate(x: number, y: number): void;
    };
    c.save();
    try {
      c.translate(-abs.x, -abs.y);
      paintNodeItem(painter, item, { viewport: input.viewport, palette });
    } finally {
      c.restore();
    }
    if (this._gl && this._shownBodies.has(id) && !this._paintedCards.has(id)) {
      // The layer has it now: the world stops drawing it, in a frame after
      // the one this paint is part of. The world's version and a frame, and
      // not `_repaint` — nothing of the 2D pane or its panels moved.
      this._paintedCards.add(id);
      this._worldVersion++;
      this._glRequest?.();
    }
  }

  /** Whether a card is the bodies' layer's to draw rather than the
   *  graph's: shown there — and under GL, painted there already — and the
   *  bodies not held out of a zoom. */
  private _cardInLayer(id: string): boolean {
    // held: hidden, or on the way to it, whatever `<Flow>` last reported
    if (this._bodiesHeld || !this._shownBodies.has(id)) return false;
    return !this._gl || this._paintedCards.has(id);
  }

  /**
   * The cards `<Flow>` has on screen in the bodies' layer (`paintCard`),
   * which the graph then leaves out — on the GL renderer that is the whole
   * of what drawing them cost, twice. Told after the commit that shows
   * them, so no 2D frame lacks both; told the empty set while bodies are
   * held out of a zoom, when their cards are the graph's again. Under GL a
   * card is left out only once its canvas has painted (`_paintedCards`).
   */
  setShownBodies(ids: ReadonlySet<string>): void {
    const was = this._shownBodies;
    if (was.size === ids.size && [...ids].every((id) => was.has(id))) return;
    this._shownBodies = ids;
    // a card that left the layer is painted there again before the world
    // leaves it out again
    for (const id of this._paintedCards) {
      if (!ids.has(id)) this._paintedCards.delete(id);
    }
    // the pane, not the window — and under GL, a frame
    this._repaint('content');
  }

  /**
   * The canvases `<Flow>` paints the minimap and controls on, over its
   * bodies (`paintPanels`): the bodies' layer is over the graph, so panels
   * the graph drew went under any card that reached them. While there are
   * any the graph leaves the panels out, and every change to the pane asks
   * them to repaint. Presses still land on the pane: the canvases take
   * none.
   */
  /** The panel canvases the minimap is painted on — the ones whose box
   *  reaches its corner. */
  private _miniMapCanvases(): readonly PanelCanvas[] {
    const canvases = this._panelCanvases;
    if (canvases.length === 0) return canvases;
    const corner = this._miniMapCorner();
    if (!corner) return [];
    const box = this._device(corner);
    return canvases.filter((c) => !c.abs || rectsOverlap(c.abs, box));
  }

  /**
   * The box `<Flow>` lays the node bodies out in, beside this pane, under
   * the 2D renderer — null under GL, and with no bodies to lay out. A pan
   * hands it to `scrollContents` as a rider: its pixels move with the
   * pane's.
   */
  setBodiesLayer(layer: unknown): void {
    this._bodiesLayer = (layer as Node | null) ?? null;
  }

  setPanelCanvases(canvases: readonly PanelCanvas[]): void {
    const had = this._panelCanvases.length > 0;
    this._panelCanvases = canvases;
    if (had !== canvases.length > 0) this._repaint('props');
  }

  /** Where the minimap and the controls are, relative to the pane's
   *  top-left, logical — with a pixel round for their borders. */
  panelRects(): FlowRect[] {
    const pane = this._pane();
    const rects: FlowRect[] = [];
    const map = this._miniMapOptions();
    if (map) {
      const panel = this._corner(
        map.position,
        map.width ?? MINIMAP_W,
        map.height ?? MINIMAP_H,
        'bottom-right',
      );
      if (pane.width >= panel.width * 1.6 && pane.height >= panel.height * 1.6)
        rects.push(panel);
    }
    const buttons = this._controlButtons();
    if (buttons.length > 0) {
      rects.push(unionRects(buttons[0].rect, buttons[buttons.length - 1].rect));
    }
    return rects.map((r) => ({
      x: Math.floor(r.x - pane.x) - 1,
      y: Math.floor(r.y - pane.y) - 1,
      width: Math.ceil(r.width) + 2,
      height: Math.ceil(r.height) + 2,
    }));
  }

  /** Paint the minimap and the controls into `ctx`, a canvas whose place in
   *  the window, in device pixels, is `abs` — as the scene paints them. */
  paintPanels(ctx: unknown, abs: FlowRect): void {
    const painter = createPainter(ctx, this._textOptions());
    if (!painter) return;
    // Only the panels this canvas's box reaches: the minimap's canvas and
    // the controls' each built and painted both, which for the controls
    // was every node in the graph, clipped away. The frame clip is set to
    // the box too, for the minimap's own reach test — a canvas paints
    // outside this element's paint, where the clip is the last pass's.
    const bounds = abs.width > 0 && abs.height > 0 ? this._logical(abs) : null;
    const clip = this._frameClip;
    this._frameClip = bounds;
    let scene: FlowScene;
    try {
      scene = buildScene({
        ...this._sceneInput(this._palette(), 'overlay', true),
        clip: bounds,
      });
    } finally {
      this._frameClip = clip;
    }
    const c = ctx as {
      save(): void;
      restore(): void;
      translate(x: number, y: number): void;
    };
    c.save();
    try {
      c.translate(-abs.x, -abs.y);
      paintPanels(painter, scene);
    } finally {
      c.restore();
    }
  }

  /** Tell `<Flow>` where the panels are when that changed (`onPanels`). */
  private _emitPanels(): void {
    const notify = this._prop<(rects: readonly FlowRect[]) => void>('onPanels');
    if (!notify) return;
    const rects = this.panelRects();
    const key = rects
      .map((r) => `${r.x},${r.y},${r.width},${r.height}`)
      .join('|');
    if (key === this._panelsKey) return;
    this._panelsKey = key;
    notify(rects);
  }

  /** `adaptive` as a number of milliseconds: `Infinity` never holds. */
  private _budgetMs(): number {
    const adaptive = this._prop<boolean | { budgetMs?: number }>('adaptive');
    if (adaptive === false) return Infinity;
    if (typeof adaptive === 'object' && adaptive?.budgetMs != null) {
      return Math.max(0, adaptive.budgetMs);
    }
    return BODY_BUDGET_MS;
  }

  /** Where the mounted bodies stand against the budget — reported with
   *  every frame (`FlowFrameStats.bodies`). */
  bodyBudget(): FlowBodyBudget {
    const count = this._bodies.length;
    return {
      count,
      held: this._bodiesHeld,
      perBodyMs: this._bodyStepMs,
      predictedMs: count * this._bodyStepMs,
      budgetMs: this._budgetMs(),
    };
  }

  /**
   * A frame was drawn: time the zoom step it carried, into the model
   * `_holdBodies` predicts from. A step with no body re-scaled is the
   * baseline; one that re-scaled some says what each cost over it. Passes
   * a millisecond or two apart are one frame (the 2D renderer paints a
   * frame's damage as several), and a gap long enough to be the user
   * pausing is not a step at all.
   */
  private _frameTick(): void {
    const t = now();
    const dt = t - this._lastFrameAt;
    if (dt < 2) return;
    this._lastFrameAt = t;
    const step = this._zoomStep;
    this._zoomStep = null;
    if (!step || dt > 250) return;
    if (!step.live || step.bodies === 0) {
      this._baseStepMs = Number.isNaN(this._baseStepMs)
        ? dt
        : this._baseStepMs * 0.7 + dt * 0.3;
    } else if (!Number.isNaN(this._baseStepMs)) {
      const each = Math.max(0, dt - this._baseStepMs) / step.bodies;
      this._bodyStepMs = this._bodyStepMs * 0.7 + each * 0.3;
    }
  }

  /**
   * The grid as one repeating fill (ntk#263): a step-sized tile drawn once,
   * a `createPattern('repeat')` over it, and one composite for the whole
   * region — where the runs path in `./paint.ts` pays a region-sized
   * coverage mask.
   *
   * Handed to `paintScene` as its grid painter, and answering **false** when
   * it does not apply, so the universal path takes over. Two decisions with
   * reasons:
   *
   * - **Integral device steps only.** The tile is a pixmap, so its size is
   *   whole pixels; at a fractional step the pattern would drift against the
   *   graph's own coordinates — against `snapToGrid`, against node positions
   *   — by a fraction per tile, and a grid that slides under the content it
   *   grids is worse than a slower exact one.
   * - **The phase lives in the tile, not in a picture transform.** An
   *   untransformed repeat is anchored to the window origin, so the grid's
   *   alignment is baked in by drawing the mark at `origin mod tile` — and
   *   re-baking when the origin moves. A `setTransform` translate says the
   *   same thing in one request, but a *transformed* repeat forfeits the
   *   server's untransformed fast path — on the in-process test server that
   *   was ~180 ms a frame of per-pixel arithmetic, and re-rendering a 24px
   *   tile is a handful of requests on any server.
   *
   * An arrow property rather than a method: it is passed as a value, and a
   * method would arrive with no `this`.
   */
  private _grid = (painter: FlowPainter, grid: SceneGrid): boolean => {
    const options = { variant: grid.variant, size: grid.size };
    const { step, color, region } = grid;
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
  };

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
}
