// The scene: everything a frame draws, as data.
//
// `./node.ts` used to hold both halves of drawing — deciding *what* a frame
// shows and issuing the 2D calls that show it — in one pass of interleaved
// private methods. This module is the first half, lifted out and made pure,
// and `./paint.ts` is the second.
//
// Three things wanted the split, in the order they mattered:
//
//  - **A second renderer.** A `<glarea>` draws from instance buffers, not
//    from a `FlowPainter`, but it draws the *same scene*: the same cards in
//    the same order, the same routed edges, the same culling. A description
//    that names no drawing API is what both can read
//    (`docs/prd-flow-gl.md`).
//  - **Measuring.** A frame's cost could not be told apart from a window's:
//    building the scene needs no server, no surface and no display, so
//    `scripts/bench/flow.ts` can price it on its own.
//  - **Reading it.** What the pane draws is now a value you can print.
//
// Everything here is in **screen space** — logical pixels relative to the
// window, the unit `FlowPainter` takes — because that is where culling has
// to happen and where a routed edge's sample density is decided. The
// exception is {@link SceneNodeSource.rect}, which is graph space: it is
// what the handle anchors and the minimap are computed from.
//
// Purity is the point, so the live state a gesture holds does not reach in
// here: the element resolves it into {@link SceneNodeSource} once per paint
// — a drag's position already applied, a resize's box already substituted —
// and this module reads that. The one callback left is text measurement,
// which needs the app's font cache and cannot be a constant.
import { tint } from 'react-x11/style';

import {
  DEFAULT_MARKER_SIZE,
  EDGE_SLOP,
  EDGE_STEP_OFFSET,
  gripPoint,
  handleAnchor,
  inflateRect,
  NODE_DESC_SIZE,
  NODE_LABEL_SIZE,
  NODE_PAD_X,
  NODE_PAD_Y,
  normalizeMarker,
  rectsOverlap,
  RESIZE_GRIP,
  unionRects,
} from './model.js';
import {
  edgePath,
  endAngle,
  pathBounds,
  pointAtFraction,
  startAngle,
  trimEnd,
} from './paths.js';
import type {
  BackgroundVariant,
  EdgeMarker,
  EdgeType,
  FlowEdge,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  FlowPalette,
  FlowRect,
  HandleAnchor,
  HandleSpec,
  MarkerType,
  TextOptions,
  Viewport,
  XYPosition,
} from './types.js';

type AnyNode = FlowNode<unknown>;
type AnyEdge = FlowEdge<unknown>;
type AnyType = FlowNodeType<unknown>;

/** Below these zooms the pane stops drawing detail nobody could read — the
 * cheapest optimisation there is, and the one that keeps a zoomed-out
 * overview interactive. Exported because the element's hit testing has to
 * agree with what was drawn. */
export const LABEL_ZOOM = 0.45;
export const HANDLE_ZOOM = 0.5;
export const DESC_ZOOM = 0.6;

/** The grid never draws denser than this on screen, whatever the zoom. */
export const MIN_GRID_PX = 16;

/**
 * How far outside its own box a node's ink can land: handles (capped at
 * 6 × 1.4 plus their outline), resize grips, the selection border, a pixel
 * of antialiasing. Damage rects grow by this before they are invalidated,
 * and cull tests grow their target by the same amount — the two must agree,
 * or a moved node leaves crumbs of its old handles behind.
 */
export const CULL_MARGIN = 16;

const DEFAULT_DASH = [7, 5];

// --- the cache ----------------------------------------------------------------

/**
 * One edge's route, kept between frames.
 *
 * The saved work is everything above the arithmetic: resolving which handle
 * each end uses (which allocates an anchor per spec), evaluating the curve
 * (up to 48 points), and dropping the vertices that crowd each other.
 *
 * What makes it reusable is a property of the routing rather than of the
 * cache: **every edge type is translation-equivariant and none is
 * scale-equivariant.** Move both endpoints by the same vector and the whole
 * route moves with them, because every route is built from distances
 * between the two ends; change the zoom and it does not, because a bezier's
 * shoulder, a step's offset, a fillet's radius and a loop's reach are all
 * clamped against pixel constants that do not scale. So the route is stored
 * in screen space next to the viewport origin it was built at, and a pan —
 * which keeps the zoom and moves the origin — is an addition per vertex
 * into an array that already exists. A zoom rebuilds.
 *
 * The screen arrays are **reused and mutated in place**, which is where the
 * allocation goes: a frame of 2000 edges was spending a sixth of itself in
 * the collector. A scene is built and drawn inside one paint and nothing
 * retains it, so the only rule is the one stated on {@link buildScene} —
 * do not hold a scene past the frame that made it.
 */
interface CachedRoute {
  // what it was built from
  zoom: number;
  originX: number;
  originY: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  tx: number;
  ty: number;
  tw: number;
  th: number;
  sourceSpecs: readonly HandleSpec[];
  targetSpecs: readonly HandleSpec[];
  sourceHandle: string | null;
  targetHandle: string | null;
  /** The node ids too: an id can be reused for a different pair between
   *  commits, and the rects alone would not notice two nodes that happen to
   *  sit in the same place. */
  source: string;
  target: string;
  type: EdgeType | undefined;
  loop: boolean;
  /** The arrowheads' shapes and sizes, which decide where the stroke stops
   *  and what the heads look like. Their *colours* are not here: those
   *  change with selection and hover and move no geometry. */
  markerKey: string;
  // what came out, in screen space at `originX`/`originY`
  points: XYPosition[];
  /** The stroke's own points, stopped behind the arrowhead — null when
   *  there is no head and the stroke is the whole route. Kept apart from
   *  `points` because the label sits at the middle of the *whole* route. */
  trimmed: XYPosition[] | null;
  endHead: XYPosition[] | null;
  startHead: XYPosition[] | null;
  from: HandleAnchor;
  to: HandleAnchor;
  bounds: FlowRect;
}

/** Bounded, so a graph that churns edge ids cannot turn this into a leak. */
const ROUTE_LIMIT = 20000;

/**
 * Move a polyline, in place.
 *
 * Addition in place drifts by float rounding — `(x + a) + b` is not always
 * `x + (a + b)` — so a route panned many times sits a few units in the last
 * place off one routed fresh. That is ~1e-14 px a pan, the painter puts
 * every coordinate on the device grid before it draws, and any zoom or node
 * move rebuilds the route from scratch and resets it. Reading through a
 * per-frame copy instead would be exact and would bring back the allocation
 * this cache exists to remove.
 */
function shift(points: XYPosition[], dx: number, dy: number): void {
  for (const p of points) {
    p.x += dx;
    p.y += dy;
  }
}

/**
 * What a renderer keeps between frames. Owned by whoever draws — the
 * element, or a GL renderer — and handed to {@link buildScene}, which reads
 * and fills it. Passing none is correct and simply recomputes everything.
 */
/**
 * One edge routed from scratch, arrowheads and all — the miss path of
 * {@link SceneCache}, and the whole path for a caller that keeps none.
 */
function buildRoute(
  v: Viewport,
  edge: AnyEdge,
  from: SceneNodeSource,
  to: SceneNodeSource,
  markerEnd: EdgeMarker | null,
  markerStart: EdgeMarker | null,
  into?: CachedRoute,
): CachedRoute | null {
  const routed = edgeRoute(v, edge, from, to);
  if (!routed) return null;
  const markerKey = markerKeyOf(markerEnd, markerStart);
  const loop = edge.source === edge.target;
  // The tip stops short of the handle rather than at it: the handle dot is
  // drawn *over* the edges, with the nodes, so an arrow aimed at the
  // handle's centre is an arrow mostly hidden under a white circle.
  const inset = v.zoom >= HANDLE_ZOOM ? handleRadius(v.zoom) + 1 : 1;
  const all = routed.points;
  let trimmed: XYPosition[] | null = null;
  let endHead: XYPosition[] | null = null;
  let startHead: XYPosition[] | null = null;
  if (markerEnd) {
    const size = (markerEnd.size ?? DEFAULT_MARKER_SIZE) * v.zoom;
    const last = all[all.length - 1];
    const angle = endAngle(all);
    // and the stroke stops behind the head, so a filled triangle is a
    // triangle rather than a triangle with a line through it
    // Copied vertex by vertex, not just sliced. `trimEnd` returns a shallow
    // copy — the same point *objects* as the route, less the last — and a
    // pan moves both arrays in place, so a shared vertex moved twice: the
    // stroke slid away from its own head by the pan's distance. Caught by
    // test/flow-scene.test.ts, which the gesture tests could not have seen.
    trimmed = trimEnd(all, size * 0.8 + inset).map((p) => ({ x: p.x, y: p.y }));
    endHead = markerPoints(
      {
        x: last.x - Math.cos(angle) * inset,
        y: last.y - Math.sin(angle) * inset,
      },
      angle,
      markerEnd.type,
      size,
    );
  }
  if (markerStart) {
    const size = (markerStart.size ?? DEFAULT_MARKER_SIZE) * v.zoom;
    const angle = startAngle(all);
    startHead = markerPoints(
      {
        x: all[0].x - Math.cos(angle) * inset,
        y: all[0].y - Math.sin(angle) * inset,
      },
      angle,
      markerStart.type,
      size,
    );
  }
  // Written over the entry this edge already had, where there is one. A
  // zoom misses on every edge of every frame, and allocating a fresh record
  // for each — plus the `Map.set` to file it — cost more than the routing
  // the cache saves: a drag and a zoom both came out ~10% slower than with
  // no cache at all, before this.
  const entry = into ?? ({} as CachedRoute);
  Object.assign(entry, {
    zoom: v.zoom,
    originX: v.x,
    originY: v.y,
    sx: from.rect.x,
    sy: from.rect.y,
    sw: from.rect.width,
    sh: from.rect.height,
    tx: to.rect.x,
    ty: to.rect.y,
    tw: to.rect.width,
    th: to.rect.height,
    sourceSpecs: from.specs,
    targetSpecs: to.specs,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    loop,
    markerKey,
    points: all,
    trimmed,
    endHead,
    startHead,
    from: routed.from,
    to: routed.to,
    bounds: pathBounds(all),
  });
  return entry;
}

/** Which arrowheads a route was built for — their shapes and sizes, never
 *  their colours, which move nothing. */
function markerKeyOf(
  markerEnd: EdgeMarker | null,
  markerStart: EdgeMarker | null,
): string {
  return `${markerEnd?.type ?? ''}:${markerEnd?.size ?? ''}|${
    markerStart?.type ?? ''
  }:${markerStart?.size ?? ''}`;
}

/** A route with nothing kept between frames. */
export function uncachedRoute(
  v: Viewport,
  edge: AnyEdge,
  from: SceneNodeSource,
  to: SceneNodeSource,
  markerEnd: EdgeMarker | null,
  markerStart: EdgeMarker | null,
): CachedRoute | null {
  return buildRoute(v, edge, from, to, markerEnd, markerStart);
}

export class SceneCache {
  private readonly routes = new Map<string, CachedRoute>();
  /** The node index, memoized on the array it was built from: at two
   *  thousand nodes, rebuilding this Map every frame was a tenth of the
   *  build. */
  private index: Map<string, SceneNodeSource> | null = null;
  private indexFor: readonly SceneNodeSource[] | null = null;

  /** Everything is derived, so forgetting it is always safe. */
  clear(): void {
    this.routes.clear();
    this.index = null;
    this.indexFor = null;
  }

  byId(all: readonly SceneNodeSource[]): Map<string, SceneNodeSource> {
    if (this.indexFor === all && this.index) return this.index;
    const map = new Map<string, SceneNodeSource>();
    for (const source of all) map.set(source.node.id, source);
    this.index = map;
    this.indexFor = all;
    return map;
  }

  route(
    v: Viewport,
    edge: AnyEdge,
    from: SceneNodeSource,
    to: SceneNodeSource,
    markerEnd: EdgeMarker | null,
    markerStart: EdgeMarker | null,
  ): CachedRoute | null {
    const loop = edge.source === edge.target;
    const markerKey = markerKeyOf(markerEnd, markerStart);
    const hit = this.routes.get(edge.id);
    if (
      hit &&
      hit.zoom === v.zoom &&
      hit.sx === from.rect.x &&
      hit.sy === from.rect.y &&
      hit.sw === from.rect.width &&
      hit.sh === from.rect.height &&
      hit.tx === to.rect.x &&
      hit.ty === to.rect.y &&
      hit.tw === to.rect.width &&
      hit.th === to.rect.height &&
      hit.sourceSpecs === from.specs &&
      hit.targetSpecs === to.specs &&
      hit.sourceHandle === (edge.sourceHandle ?? null) &&
      hit.targetHandle === (edge.targetHandle ?? null) &&
      hit.source === edge.source &&
      hit.target === edge.target &&
      hit.type === edge.type &&
      hit.loop === loop &&
      hit.markerKey === markerKey
    ) {
      const dx = v.x - hit.originX;
      const dy = v.y - hit.originY;
      if (dx !== 0 || dy !== 0) {
        shift(hit.points, dx, dy);
        // `trimmed` is null when it would be `points`, so nothing is moved
        // twice — the bug that aliasing invites here.
        if (hit.trimmed) shift(hit.trimmed, dx, dy);
        if (hit.endHead) shift(hit.endHead, dx, dy);
        if (hit.startHead) shift(hit.startHead, dx, dy);
        hit.bounds.x += dx;
        hit.bounds.y += dy;
        hit.originX = v.x;
        hit.originY = v.y;
      }
      return hit;
    }

    const entry = buildRoute(v, edge, from, to, markerEnd, markerStart, hit);
    if (!entry) {
      this.routes.delete(edge.id);
      return null;
    }
    if (!hit) {
      if (this.routes.size >= ROUTE_LIMIT) this.routes.clear();
      this.routes.set(edge.id, entry);
    }
    return entry;
  }
}

// --- what goes in -------------------------------------------------------------

/**
 * One node, resolved. The element builds these: a drag's live position is
 * already in `rect`, a resize's live box has already replaced it, and
 * `grips` is already filtered by whatever the handles took.
 */
export interface SceneNodeSource {
  node: AnyNode;
  /** **Graph space**, unlike everything else here. */
  rect: FlowRect;
  specs: readonly HandleSpec[];
  type: AnyType | undefined;
  /** The title bar's height in graph units — only read when `mounted`. */
  header: number;
  /** Whether a React body is mounted over this node, which is what makes
   *  the card draw a title bar rather than a centred label. */
  mounted: boolean;
  connectable: boolean;
  /** Which resize grips to draw, already filtered. Empty for most nodes. */
  grips: readonly XYPosition[];
}

/** The pointer's business, for hover styling. */
export interface SceneHover {
  nodeId: string | null;
  handle: HandleAnchor | null;
  edgeId: string | null;
}

/** A connection being dragged out of a handle. */
export interface SceneConnectionSource {
  from: HandleAnchor;
  to: HandleAnchor | null;
  pointer: XYPosition;
  valid: boolean;
}

/** The minimap's frame, as the element resolved it. */
export interface SceneMiniMapSource {
  panel: FlowRect;
  bounds: FlowRect;
  scale: number;
  nodeColor?: string | ((node: FlowNode<never>) => string);
  maskColor?: string;
}

/** One control button's box and what it does. */
export interface SceneControlButton {
  rect: FlowRect;
  action: 'in' | 'out' | 'fit';
}

/** The background, normalized. */
export interface SceneBackgroundSource {
  variant: BackgroundVariant;
  gap: number;
  size: number;
  color?: string;
}

/** Everything {@link buildScene} reads. */
export interface SceneInput {
  viewport: Viewport;
  /** The pane's content box, in screen space. */
  pane: FlowRect;
  /**
   * The damage rect this pass repaints, in screen space — null for a full
   * pass. Everything outside it survives on the window from the last frame,
   * so it is a second cull on top of the pane's.
   *
   * A renderer that redraws the whole frame every time (the GL one) passes
   * null, and the scene is the whole pane.
   */
  clip: FlowRect | null;
  /**
   * What is kept, in the same window pixels — the pane when left out.
   *
   * A renderer that keeps a scene across frames wants more than the pane:
   * the GL one builds the graph at a pinned origin and pans it by moving a
   * uniform, so it culls to an *overscan* region round the view, and only
   * rebuilds once the view leaves it (`./node.ts`, `glFrame`).
   */
  cull?: FlowRect | null;
  palette: FlowPalette;
  /** The pane's own background, when its style set one. */
  paneBackground?: string;
  background: SceneBackgroundSource;
  /** Paint order: z-index, then selection, with a dragged node on top. */
  nodes: readonly SceneNodeSource[];
  /** Every node, for the minimap — which summarises the graph, not the
   *  pass. */
  all: readonly SceneNodeSource[];
  edges: readonly AnyEdge[];
  /** How far an animated edge's dash has marched, in graph units. */
  dashPhase: number;
  hover: SceneHover;
  connection: SceneConnectionSource | null;
  /** The box-selection rectangle, in screen space. */
  selection: FlowRect | null;
  miniMap: SceneMiniMapSource | null;
  controls: readonly SceneControlButton[];
  /** Device pixels per logical pixel — only to put node boxes on whole
   *  device pixels; everything else here is scale-free. */
  scale: number;
  /** Text metrics, which need the app's font cache. */
  measure(
    text: string,
    options?: TextOptions,
  ): { width: number; height: number };
  /** What survived the last frame. Optional: without one every route is
   *  computed again, which is correct and slower. */
  cache?: SceneCache;
}

// --- what comes out -----------------------------------------------------------

/** A filled and/or stroked rectangle. */
export interface SceneRect {
  rect: FlowRect;
  radius: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
}

/** A string to set. */
export interface SceneText {
  kind: 'text';
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  weight?: 'bold';
  align?: 'left' | 'center' | 'right';
  baseline?: 'middle';
  maxWidth?: number;
}

/** A hairline: the rule under a title bar, a separator between two control
 *  buttons. Stroked rather than filled, so it lands where a 1px border
 *  does. */
export interface SceneRule {
  kind: 'rule';
  points: readonly XYPosition[];
  color: string;
  lineWidth: number;
}

/** An arrowhead. `filled` is a closed triangle; the open kind is a
 *  two-segment chevron. */
export interface SceneMarker {
  points: readonly XYPosition[];
  filled: boolean;
  color: string;
  lineWidth: number;
}

/** One edge, routed and ready. */
export interface SceneEdge {
  id: string;
  /** The polyline, already shortened behind an arrowhead. */
  points: readonly XYPosition[];
  stroke: string;
  lineWidth: number;
  dash?: readonly number[];
  dashOffset: number;
  /** Whether the dash marches. `dashOffset` already holds this frame's
   *  phase; a renderer that keeps edges across frames reads this instead and
   *  moves the phase itself, so a tick is not a rebuild. */
  animated: boolean;
  markers: readonly SceneMarker[];
  /** The plate behind a label, so it sits above every edge. */
  chip?: SceneRect;
  label?: SceneText;
}

/** A connection point. */
export interface SceneHandle {
  at: XYPosition;
  radius: number;
  fill: string;
  stroke?: string;
  lineWidth?: number;
  label?: SceneText;
}

/** One node's drawing. `custom` means the node's type draws its own body,
 *  and everything but the handles and grips is its business. */
export interface SceneNodeItem {
  id: string;
  rect: FlowRect;
  selected: boolean;
  hovered: boolean;
  /** Present unless the type paints itself. */
  card?: { shape: SceneRect; accent?: SceneRect };
  /** The label, the description, and the rule under a title bar. */
  ink: readonly (SceneText | SceneRule)[];
  handles: readonly SceneHandle[];
  grips: readonly SceneRect[];
  /** Set when the type has a `paint`: the painter calls it, and a renderer
   *  that cannot must say so rather than draw the wrong thing. */
  custom?: {
    type: AnyType;
    node: AnyNode;
    /** The node's handles in screen space, which is what the hook is
     *  handed. */
    anchors: readonly HandleAnchor[];
  };
}

/** The grid, described rather than drawn: a renderer works it out per pixel,
 *  as a pattern tile or as a pile of runs, and the choice is the
 *  renderer's. */
export interface SceneGrid {
  variant: BackgroundVariant;
  /** The pitch on screen, already doubled past {@link MIN_GRID_PX}. */
  step: number;
  /** Where a grid line falls: the viewport origin, in screen space. */
  origin: XYPosition;
  /** A mark's size in graph units — multiply by the zoom for screen. */
  size: number;
  color: string;
  /** The part of the pane this pass covers. */
  region: FlowRect;
}

/** The connection line being dragged out of a handle. */
export interface SceneConnection {
  points: readonly XYPosition[];
  stroke: string;
  lineWidth: number;
  dash?: readonly number[];
  tip: SceneHandle;
}

/** The minimap panel. */
export interface SceneMiniMap {
  panel: SceneRect;
  nodes: readonly SceneRect[];
  view: SceneRect;
}

/** One button's mark: its runs go in one path, which is what the 2D painter
 *  did per button before any of this moved. */
export interface SceneGlyph {
  runs: readonly (readonly XYPosition[])[];
  color: string;
  lineWidth: number;
}

/** The zoom controls. */
export interface SceneControls {
  panel: SceneRect;
  rules: readonly SceneRule[];
  glyphs: readonly SceneGlyph[];
}

/** The whole frame. */
export interface FlowScene {
  viewport: Viewport;
  pane: FlowRect;
  /** Carried so a custom node type's `paint` can be handed it — the hook
   *  takes the palette the rest of the frame was drawn from. */
  palette: FlowPalette;
  /** What this pass covers: the pane, or the damage rect inside it. Null
   *  when the pass reaches nothing. */
  region: FlowRect | null;
  background: SceneRect | null;
  grid: SceneGrid | null;
  edges: readonly SceneEdge[];
  nodes: readonly SceneNodeItem[];
  connection: SceneConnection | null;
  selection: SceneRect | null;
  miniMap: SceneMiniMap | null;
  controls: SceneControls | null;
  /** Whether any edge in view is animated — the element keeps a timer alive
   *  only while this is true. */
  animated: boolean;
  /** The box those animated edges actually inked, so a dash tick repaints
   *  that rather than the pane. Null when this pass drew none. */
  animBox: FlowRect | null;
}

// --- geometry -----------------------------------------------------------------

/**
 * The viewport as the *window* sees it: the pane's own origin folded into
 * the translation.
 *
 * A {@link Viewport} is the pane's — `x`/`y` place the graph relative to the
 * pane's top-left, which is what `setViewport` and `onViewportChange` speak
 * — while everything this module draws and everything the element hit-tests
 * is in window pixels. Every graph-to-window conversion goes through this
 * first. The scene extraction once skipped it, so a pane that did not sit at
 * the window's origin drew and hit-tested shifted by its own offset — and
 * agreed with itself while doing it, which is why only an off-origin test
 * could see it (`test/flow.test.ts`, "off the window origin").
 */
export function screenViewport(v: Viewport, pane: FlowRect): Viewport {
  return { x: pane.x + v.x, y: pane.y + v.y, zoom: v.zoom };
}

/** Graph point to window, through a {@link screenViewport}. */
export function toScreen(v: Viewport, p: XYPosition): XYPosition {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}

/**
 * A node's box on screen, put on whole device pixels.
 *
 * Rounded as *edges* rather than as a size, so two nodes that share a column
 * still share it after rounding.
 */
export function screenRect(
  v: Viewport,
  rect: FlowRect,
  scale: number,
): FlowRect {
  const p = toScreen(v, rect);
  const grid = (value: number): number => Math.round(value * scale) / scale;
  const x = grid(p.x);
  const y = grid(p.y);
  return {
    x,
    y,
    width: grid(p.x + rect.width * v.zoom) - x,
    height: grid(p.y + rect.height * v.zoom) - y,
  };
}

/** A handle's drawn radius: it grows with the zoom, but only so far, so a
 *  zoomed-out graph still has something to aim at. */
export function handleRadius(zoom: number): number {
  return Math.min(6, Math.max(2.5, 4.5 * zoom));
}

export function sameHandle(
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

function intersect(a: FlowRect, b: FlowRect): FlowRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function centre(rect: FlowRect): XYPosition {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * A node's handle anchors, in graph space.
 *
 * Takes the three fields it reads rather than a whole
 * {@link SceneNodeSource}, and that is load-bearing rather than tidy: a
 * source carries `grips`, and which grips a node shows depends on where its
 * handles are — asking for the whole source here is a cycle.
 */
export function anchorsOf(source: {
  node: { id: string };
  rect: FlowRect;
  specs: readonly HandleSpec[];
}): HandleAnchor[] {
  return source.specs.map((spec) =>
    handleAnchor(source.node.id, source.rect, spec),
  );
}

/** An arrowhead's points. */
function markerPoints(
  at: XYPosition,
  angle: number,
  type: MarkerType,
  size: number,
): XYPosition[] {
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
  return type === 'arrowclosed' ? [at, left, back, right] : [left, at, right];
}

// --- the builder --------------------------------------------------------------

/**
 * The scene for one pass.
 *
 * Pure but for one thing, and it is worth stating plainly: with a
 * {@link SceneCache} the routes it returns are **arrays the cache owns and
 * the next frame will move in place**. A scene is built and drawn inside one
 * paint and nothing keeps it, so the rule is simply that — do not hold a
 * scene past the frame that made it, and do not mutate what it hands back.
 * Without a cache every array is fresh and the rule is vacuous.
 */
export function buildScene(input: SceneInput): FlowScene {
  const { viewport: v, pane, clip, palette } = input;
  const region = clip ? intersect(pane, clip) : pane;

  const scene: FlowScene = {
    viewport: v,
    pane,
    palette,
    region,
    background: region
      ? {
          rect: region,
          radius: 0,
          fill: input.paneBackground ?? palette.background,
        }
      : null,
    grid: null,
    edges: [],
    nodes: [],
    connection: null,
    selection: null,
    miniMap: null,
    controls: null,
    animated: false,
    animBox: null,
  };
  if (!region) return scene;

  scene.grid = buildGrid(input, region);
  scene.edges = buildEdges(input, scene);
  scene.nodes = buildNodes(input);
  scene.connection = buildConnection(input);
  if (input.selection) {
    scene.selection = {
      rect: input.selection,
      radius: 2,
      fill: palette.selection,
      stroke: palette.accent,
      lineWidth: 1,
    };
  }
  // Both panels are pinned to a corner, so a pass whose damage misses them
  // skips the walk that builds them — which for the minimap is every node in
  // the graph, not just the ones in view.
  if (input.miniMap && (!clip || rectsOverlap(input.miniMap.panel, clip))) {
    scene.miniMap = buildMiniMap(input, input.miniMap);
  }
  if (
    input.controls.length > 0 &&
    (!clip || input.controls.some((b) => rectsOverlap(b.rect, clip)))
  ) {
    scene.controls = buildControls(input);
  }
  return scene;
}

function buildGrid(input: SceneInput, region: FlowRect): SceneGrid | null {
  const { background: options, viewport: v, pane, palette } = input;
  if (options.variant === 'none') return null;
  let step = options.gap * v.zoom;
  if (!(step > 0)) return null;
  // Doubling rather than clamping keeps the grid *aligned* to the graph
  // while zooming out: every visible line is still a real one.
  while (step < MIN_GRID_PX) step *= 2;
  return {
    variant: options.variant,
    step,
    origin: { x: pane.x + v.x, y: pane.y + v.y },
    size: options.size,
    color: options.color ?? palette.grid,
    region,
  };
}

function indexOf(
  all: readonly SceneNodeSource[],
): Map<string, SceneNodeSource> {
  const map = new Map<string, SceneNodeSource>();
  for (const source of all) map.set(source.node.id, source);
  return map;
}

function buildEdges(input: SceneInput, scene: FlowScene): SceneEdge[] {
  const { pane, clip, palette, hover, scale } = input;
  const v = screenViewport(input.viewport, pane);
  const kept = input.cull ?? pane;
  const labels = v.zoom >= LABEL_ZOOM;
  const out: SceneEdge[] = [];
  const cache = input.cache;
  const byId = cache ? cache.byId(input.all) : indexOf(input.all);
  let animBox: FlowRect | null = null;

  for (const edge of input.edges) {
    if (edge.hidden) continue;
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (!from || !to || from.node.hidden || to.node.hidden) continue;

    // Two rejects: one from the nodes alone, one from the route it took.
    const coarse = edgeCoarseBox(v, from, to, scale);
    if (!rectsOverlap(coarse, kept)) continue;
    // Tracked before the damage skip, deliberately: whether the dash timer
    // runs is a question about the viewport, not about what this particular
    // pass repaints — deciding it after the skip is how a drag in one corner
    // would stop the dash marching in the other.
    if (edge.animated) scene.animated = true;
    if (clip && !rectsOverlap(coarse, clip)) continue;

    // `markerEnd` left out means an arrow: a directed graph whose edges do
    // not say which way they point is a set of lines. `null` opts out.
    const markerEnd = normalizeMarker(
      edge.markerEnd === undefined ? 'arrowclosed' : edge.markerEnd,
    );
    const markerStart = normalizeMarker(edge.markerStart);

    // The route, from the cache where there is one: a pan keeps the zoom, so
    // the cached route is the same curve translated, and re-deriving it —
    // the handles, the curve, the arrowheads — is the work this skips.
    const routed = cache
      ? cache.route(v, edge, from, to, markerEnd, markerStart)
      : uncachedRoute(v, edge, from, to, markerEnd, markerStart);
    if (!routed) continue;
    const bounds = routed.bounds;
    if (!rectsOverlap(bounds, kept)) continue;

    const selected = edge.selected ?? false;
    const hovered = hover.edgeId === edge.id;
    const stroke =
      edge.style?.stroke ??
      (selected ? palette.edgeSelected : hovered ? palette.text : palette.edge);
    const lineWidth = Math.max(
      1,
      (edge.style?.strokeWidth ?? (selected ? 2 : 1.5)) * v.zoom,
    );
    // The heads' geometry came with the route; only their ink is this
    // frame's, because selection and hover recolour without moving anything.
    const markers: SceneMarker[] = [];
    if (routed.endHead && markerEnd) {
      markers.push({
        points: routed.endHead,
        filled: markerEnd.type === 'arrowclosed',
        color: markerEnd.color ?? stroke,
        lineWidth,
      });
    }
    if (routed.startHead && markerStart) {
      markers.push({
        points: routed.startHead,
        filled: markerStart.type === 'arrowclosed',
        color: markerStart.color ?? stroke,
        lineWidth,
      });
    }

    const dash = edge.style?.dash ?? (edge.animated ? DEFAULT_DASH : undefined);
    if (edge.animated) {
      // The coarse box carries the bezier's slack, and a tick that repaints
      // slack repaints a card-sized halo of neighbours sixteen times a
      // second — so the box the ticks invalidate comes off the *drawn*
      // geometry.
      const tight = inflateRect(bounds, CULL_MARGIN);
      animBox = animBox ? unionRects(animBox, tight) : tight;
    }

    const item: SceneEdge = {
      id: edge.id,
      points: routed.trimmed ?? routed.points,
      stroke,
      lineWidth,
      dash: dash?.map((d) => d * v.zoom),
      dashOffset: edge.animated ? -input.dashPhase * v.zoom : 0,
      animated: edge.animated ?? false,
      markers,
    };

    if (labels && edge.label) {
      const at = pointAtFraction(routed.points, 0.5);
      const size = Math.max(8, 11 * v.zoom);
      const metrics = input.measure(edge.label, { size });
      const padX = 5 * v.zoom;
      const padY = 2 * v.zoom;
      item.chip = {
        rect: {
          x: Math.round(at.x - metrics.width / 2 - padX),
          y: Math.round(at.y - metrics.height / 2 - padY),
          width: Math.round(metrics.width + padX * 2),
          height: Math.round(metrics.height + padY * 2),
        },
        radius: Math.max(2, Math.round(3 * v.zoom)),
        fill: edge.style?.labelBackground ?? tint(palette.background, 0.92),
      };
      item.label = {
        kind: 'text',
        text: edge.label,
        x: at.x,
        y: at.y,
        size,
        color: edge.style?.labelColor ?? palette.text,
        align: 'center',
        baseline: 'middle',
      };
    }
    out.push(item);
  }

  scene.animBox = animBox;
  return out;
}

/** The box two nodes' edge cannot leave, before it is routed. */
export function edgeCoarseBox(
  v: Viewport,
  from: SceneNodeSource,
  to: SceneNodeSource,
  // unused: a coarse box with pixels of slack has no use for the device
  // grid `screenRect` snaps to, and snapping two rects per edge was most of
  // what this cost — every edge, every frame of a drag
  _scale?: number,
): FlowRect {
  const z = v.zoom;
  const f = from.rect;
  const t = to.rect;
  const ax = f.x * z + v.x;
  const ay = f.y * z + v.y;
  const aw = f.width * z;
  const ah = f.height * z;
  const bx = t.x * z + v.x;
  const by = t.y * z + v.y;
  const bw = t.width * z;
  const bh = t.height * z;
  const span = Math.hypot(
    ax + aw / 2 - (bx + bw / 2),
    ay + ah / 2 - (by + bh / 2),
  );
  const slack =
    Math.max(5, EDGE_SLOP * z) +
    Math.max(EDGE_STEP_OFFSET * 3 * z, 8 * Math.sqrt(z * span));
  const x = Math.min(ax, bx) - slack;
  const y = Math.min(ay, by) - slack;
  return {
    x,
    y,
    width: Math.max(ax + aw, bx + bw) + slack - x,
    height: Math.max(ay + ah, by + bh) + slack - y,
  };
}

/** Which handles an edge joins, and the polyline between them. */
export function edgeRoute(
  v: Viewport,
  edge: AnyEdge,
  from: SceneNodeSource,
  to: SceneNodeSource,
): { points: XYPosition[]; from: HandleAnchor; to: HandleAnchor } | null {
  const a = endpoint(from, edge.sourceHandle, 'source', centre(to.rect));
  const b = endpoint(to, edge.targetHandle, 'target', centre(from.rect));
  if (!a || !b) return null;
  const s = toScreen(v, a);
  const t = toScreen(v, b);
  return {
    points: edgePath(
      edge.type as EdgeType | undefined,
      { x: s.x, y: s.y, position: a.position },
      { x: t.x, y: t.y, position: b.position },
      {
        stepOffset: EDGE_STEP_OFFSET * v.zoom,
        radius: 8 * v.zoom,
        scale: v.zoom,
        loop: edge.source === edge.target,
      },
    ),
    from: a,
    to: b,
  };
}

export function endpoint(
  source: {
    node: { id: string };
    rect: FlowRect;
    specs: readonly HandleSpec[];
  },
  handleId: string | null | undefined,
  type: 'source' | 'target',
  towards: XYPosition | null,
): HandleAnchor | null {
  const anchors = anchorsOf(source);
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

/** The node items of a scene alone — what a mounted node's card is painted
 *  from, apart from the rest of the scene (`FlowGraphNode.paintCard`). */
export function buildNodeItems(input: SceneInput): SceneNodeItem[] {
  return buildNodes(input);
}

function buildNodes(input: SceneInput): SceneNodeItem[] {
  const { pane, clip, hover, scale } = input;
  const v = screenViewport(input.viewport, pane);
  const kept = input.cull ?? pane;
  const out: SceneNodeItem[] = [];
  for (const source of input.nodes) {
    if (source.node.hidden) continue;
    const rect = screenRect(v, source.rect, scale);
    if (!rectsOverlap(rect, kept)) continue;
    // inflated by the margin its handles and grips can ink outside the box —
    // the same margin every invalidate grew by, so the two agree
    if (clip && !rectsOverlap(inflateRect(rect, CULL_MARGIN), clip)) continue;

    const selected = source.node.selected ?? false;
    const hovered = hover.nodeId === source.node.id;
    const anchors = anchorsOf(source).map((anchor) => {
      const s = toScreen(v, anchor);
      return { ...anchor, x: s.x, y: s.y };
    });

    const item: SceneNodeItem = {
      id: source.node.id,
      rect,
      selected,
      hovered,
      ink: [],
      handles: [],
      grips: [],
    };

    if (source.type?.paint) {
      // Never described: a type that draws its own body is drawing whatever
      // it likes, in an order only it knows.
      item.custom = { type: source.type, node: source.node, anchors };
    } else {
      item.card = buildCard(input, source, rect, selected, hovered);
      item.ink = buildCardInk(input, source, rect);
    }

    if (source.connectable && (v.zoom >= HANDLE_ZOOM || hovered)) {
      item.handles = buildHandles(input, anchors);
    }
    item.grips = buildGrips(input, source, rect);
    out.push(item);
  }
  return out;
}

function buildCard(
  input: SceneInput,
  source: SceneNodeSource,
  rect: FlowRect,
  selected: boolean,
  hovered: boolean,
): { shape: SceneRect; accent?: SceneRect } {
  const { viewport: v, palette } = input;
  const style = source.node.style;
  const radius = Math.round((style?.borderRadius ?? 6) * v.zoom);
  const border = selected
    ? palette.accent
    : hovered
      ? tint(palette.accent, 0.55)
      : (style?.borderColor ?? palette.nodeBorder);
  const shape: SceneRect = {
    rect,
    radius,
    fill: style?.background ?? palette.nodeBackground,
    stroke: border,
    lineWidth: Math.max(
      1,
      Math.round((style?.borderWidth ?? (selected ? 2 : 1)) * v.zoom),
    ),
  };
  if (!style?.accent) return { shape };
  return {
    shape,
    // Inset past the rounded corners instead of clipped to them: a
    // non-rectangular clip forfeits ntk's rounded-box fast path for every
    // fill under it — measured as a pixmap create/free and a trapezoid pass
    // per card per repaint.
    accent: {
      rect: {
        x: rect.x + Math.max(1, v.zoom),
        y: rect.y + radius,
        width: Math.max(2, 3 * v.zoom),
        height: rect.height - radius * 2,
      },
      radius: 0,
      fill: style.accent,
    },
  };
}

function buildCardInk(
  input: SceneInput,
  source: SceneNodeSource,
  rect: FlowRect,
): (SceneText | SceneRule)[] {
  const { viewport: v, palette } = input;
  if (v.zoom < LABEL_ZOOM) return [];
  const style = source.node.style;
  const header = source.mounted ? source.header : 0;
  const data = source.node.data as FlowNodeData | undefined;
  const label = data?.label ?? source.node.id;
  const description = data?.description;
  const color = style?.color ?? palette.text;
  const padX = NODE_PAD_X * v.zoom;
  const centreX = rect.x + rect.width / 2;
  const maxWidth = Math.max(8, rect.width - padX * 2);
  const showDescription = Boolean(description) && v.zoom >= DESC_ZOOM;

  if (header > 0) {
    // The title bar of a node whose body is somebody else's: left-aligned,
    // with a hairline under it so the strip reads as the thing to grab.
    const band = header * v.zoom;
    return [
      {
        kind: 'text',
        text: label,
        x: rect.x + padX,
        y: rect.y + band / 2,
        size: NODE_LABEL_SIZE * v.zoom,
        weight: 'bold',
        color,
        baseline: 'middle',
        maxWidth,
      },
      {
        kind: 'rule',
        points: [
          { x: rect.x + 1, y: rect.y + band },
          { x: rect.x + rect.width - 1, y: rect.y + band },
        ],
        color: palette.nodeBorder,
        lineWidth: 1,
      },
    ];
  }

  if (!showDescription) {
    return [
      {
        kind: 'text',
        text: label,
        x: centreX,
        y: rect.y + rect.height / 2,
        size: NODE_LABEL_SIZE * v.zoom,
        weight: 'bold',
        color,
        align: 'center',
        baseline: 'middle',
        maxWidth,
      },
    ];
  }
  const top = rect.y + NODE_PAD_Y * v.zoom;
  return [
    {
      kind: 'text',
      text: label,
      x: centreX,
      y: top,
      size: NODE_LABEL_SIZE * v.zoom,
      weight: 'bold',
      color,
      align: 'center',
      maxWidth,
    },
    {
      kind: 'text',
      text: description!,
      x: centreX,
      y: top + NODE_LABEL_SIZE * 1.35 * v.zoom,
      size: NODE_DESC_SIZE * v.zoom,
      color: palette.dim,
      align: 'center',
      maxWidth,
    },
  ];
}

function buildHandles(
  input: SceneInput,
  anchors: readonly HandleAnchor[],
): SceneHandle[] {
  const { viewport: v, palette, hover, connection } = input;
  const radius = handleRadius(v.zoom);
  const lineWidth = Math.max(1, 1.5 * v.zoom);
  return anchors.map((anchor) => {
    const active =
      sameHandle(hover.handle, anchor) ||
      sameHandle(connection?.to ?? null, anchor) ||
      sameHandle(connection?.from ?? null, anchor);
    const handle: SceneHandle = {
      at: { x: anchor.x, y: anchor.y },
      radius: active ? radius * 1.4 : radius,
      fill: active ? palette.accent : palette.nodeBackground,
      stroke: active ? palette.accent : palette.handle,
      lineWidth,
    };
    if (anchor.label && v.zoom >= DESC_ZOOM) {
      const outside = anchor.position === 'left' || anchor.position === 'top';
      handle.label = {
        kind: 'text',
        text: anchor.label,
        x:
          anchor.x +
          (anchor.position === 'left'
            ? -radius - 4 * v.zoom
            : radius + 4 * v.zoom),
        y: anchor.y,
        size: 10 * v.zoom,
        color: palette.dim,
        align: outside ? 'right' : 'left',
        baseline: 'middle',
      };
    }
    return handle;
  });
}

function buildGrips(
  input: SceneInput,
  source: SceneNodeSource,
  rect: FlowRect,
): SceneRect[] {
  if (source.grips.length === 0) return [];
  const { viewport: v, palette } = input;
  const size = Math.max(4, RESIZE_GRIP * 2 * v.zoom);
  return source.grips.map((dir) => {
    const at = gripPoint(rect, dir);
    return {
      rect: {
        x: at.x - size / 2,
        y: at.y - size / 2,
        width: size,
        height: size,
      },
      radius: 1,
      fill: palette.nodeBackground,
      stroke: palette.accent,
      lineWidth: 1.5,
    };
  });
}

/**
 * The line a connection gesture draws, routed. Exported because the element
 * claims damage for it between frames and the two must be the same curve —
 * a box drawn from a second derivation is a box that leaves crumbs.
 */
export function connectionPath(
  v: Viewport,
  source: SceneConnectionSource,
): XYPosition[] {
  const from = toScreen(v, source.from);
  const to = toScreen(v, source.to ?? source.pointer);
  const toPosition =
    source.to?.position ??
    (source.from.position === 'left'
      ? 'right'
      : source.from.position === 'right'
        ? 'left'
        : source.from.position === 'top'
          ? 'bottom'
          : 'top');
  return edgePath(
    'bezier',
    { x: from.x, y: from.y, position: source.from.position },
    { x: to.x, y: to.y, position: toPosition },
    {
      stepOffset: EDGE_STEP_OFFSET * v.zoom,
      radius: 8 * v.zoom,
      scale: v.zoom,
    },
  );
}

function buildConnection(input: SceneInput): SceneConnection | null {
  const { palette, connection } = input;
  if (!connection) return null;
  const v = screenViewport(input.viewport, input.pane);
  const to = toScreen(v, connection.to ?? connection.pointer);
  const invalid = connection.to != null && !connection.valid;
  const color = invalid ? palette.dim : palette.accent;
  return {
    points: connectionPath(v, connection),
    stroke: color,
    lineWidth: Math.max(1.5, 2 * v.zoom),
    dash:
      connection.to && connection.valid ? undefined : [5 * v.zoom, 4 * v.zoom],
    tip: { at: to, radius: handleRadius(v.zoom), fill: color },
  };
}

function buildMiniMap(
  input: SceneInput,
  map: SceneMiniMapSource,
): SceneMiniMap {
  const { viewport: v, pane, palette } = input;
  const ox = map.panel.x + (map.panel.width - map.bounds.width * map.scale) / 2;
  const oy =
    map.panel.y + (map.panel.height - map.bounds.height * map.scale) / 2;
  const place = (p: XYPosition): XYPosition => ({
    x: ox + (p.x - map.bounds.x) * map.scale,
    y: oy + (p.y - map.bounds.y) * map.scale,
  });
  const nodes: SceneRect[] = [];
  for (const source of input.all) {
    if (source.node.hidden) continue;
    const at = place(source.rect);
    const colour = map.nodeColor;
    nodes.push({
      rect: {
        x: at.x,
        y: at.y,
        width: Math.max(1, source.rect.width * map.scale),
        height: Math.max(1, source.rect.height * map.scale),
      },
      radius: 0,
      fill:
        typeof colour === 'function'
          ? colour(source.node as FlowNode<never>)
          : (colour ??
            (source.node.selected ? palette.accent : palette.nodeBorder)),
    });
  }
  const view = place({ x: -v.x / v.zoom, y: -v.y / v.zoom });
  return {
    panel: {
      rect: map.panel,
      radius: 4,
      fill: tint(palette.surface, 0.92),
      stroke: palette.surfaceBorder,
      lineWidth: 1,
    },
    nodes,
    // The viewport, as an outline over a wash on everything outside it —
    // cheaper than four mask rectangles and reads the same.
    view: {
      rect: {
        x: view.x,
        y: view.y,
        width: (pane.width / v.zoom) * map.scale,
        height: (pane.height / v.zoom) * map.scale,
      },
      radius: 2,
      fill: map.maskColor ?? tint(palette.accent, 0.1),
      stroke: palette.accent,
      lineWidth: 1,
    },
  };
}

function buildControls(input: SceneInput): SceneControls {
  const { palette, controls } = input;
  const first = controls[0].rect;
  const last = controls[controls.length - 1].rect;
  const glyphs: SceneGlyph[] = [];
  const rules: SceneRule[] = [];
  for (let i = 0; i < controls.length; i++) {
    const { rect, action } = controls[i];
    if (i > 0) {
      rules.push({
        kind: 'rule',
        points: [
          { x: rect.x + 4, y: rect.y },
          { x: rect.x + rect.width - 4, y: rect.y },
        ],
        color: palette.surfaceBorder,
        lineWidth: 1,
      });
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
    glyphs.push({ runs, color: palette.text, lineWidth: 1.5 });
  }
  return {
    panel: {
      rect: {
        x: first.x,
        y: first.y,
        width: first.width,
        height: last.y + last.height - first.y,
      },
      radius: 4,
      fill: tint(palette.surface, 0.94),
      stroke: palette.surfaceBorder,
      lineWidth: 1,
    },
    rules,
    glyphs,
  };
}
