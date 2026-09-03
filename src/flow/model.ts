// The graph model, as pure functions over the arrays the app owns.
//
// Nothing here touches a node, a context or the DOM-shaped world: it is the
// half of `<Flow>` that can be reasoned about — and tested — without an X
// server, which is most of the interesting arithmetic. `./node.ts` is the
// only caller that has state.
import * as ntk from 'react-x11/ntk';
import { tint } from 'react-x11/style';

import type {
  BackgroundOptions,
  Connection,
  EdgeChange,
  EdgeMarker,
  FitViewOptions,
  FlowEdge,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  FlowPalette,
  FlowRect,
  HandleAnchor,
  HandlePosition,
  HandleSpec,
  MarkerType,
  NodeChange,
  TextOptions,
  Viewport,
  XYPosition,
} from './types.js';

// The built-in card's geometry. A node with no size is measured against
// these, and a node type that draws its own body still gets them unless it
// says otherwise — so a graph of mixed types lines up.
export const NODE_PAD_X = 14;
export const NODE_PAD_Y = 11;
export const NODE_LABEL_SIZE = 13;
export const NODE_DESC_SIZE = 11;
export const NODE_MIN_WIDTH = 110;
export const NODE_MAX_WIDTH = 260;
export const NODE_MIN_HEIGHT = 40;
/** Handle radius in graph units. */
export const HANDLE_RADIUS = 4.5;
/** Resize grip half-width, and how far outside one a press still grabs it. */
export const RESIZE_GRIP = 3.5;
export const RESIZE_SLOP = 4;
/** Floors for a resize, when the node names none. Small enough to be a
 * badge, big enough that a node cannot be dragged out of existence. */
export const MIN_NODE_WIDTH = 48;
export const MIN_NODE_HEIGHT = 32;
/** The strip a `render` node keeps for its title and for dragging. */
export const NODE_HEADER = 26;
/** How far a `render` node's body is inset from its own border, so the
 * resize grips and the border stay the pane's to hit. */
export const NODE_BODY_INSET = 5;
/** Below this the mounted body is not worth showing. It scales with the
 * zoom now, so this is no longer about a form clipped to a corner of its
 * card — it is that nobody can read a form a third of its size, and that a
 * real subtree per card is the one cost a zoomed-out overview cannot pay. */
export const RENDER_ZOOM = 0.6;
/** How far outside a handle a press still counts as grabbing it. */
export const HANDLE_SLOP = 5;
/** How far from an edge a press still counts as hitting it. */
export const EDGE_SLOP = 6;
/** How far a step/smoothstep edge leaves a node before it turns. */
export const EDGE_STEP_OFFSET = 18;
export const DEFAULT_MARKER_SIZE = 11;

export const DEFAULT_MIN_ZOOM = 0.2;
export const DEFAULT_MAX_ZOOM = 2.5;
export const ZOOM_STEP = 1.2;

// --- changes ---------------------------------------------------------------

/**
 * Fold position/select/remove/add/replace changes into a node array — the
 * reducer half of the controlled contract, and the body of `useNodesState`.
 *
 * Returns the array it was given when nothing applied, so a `useMemo` or a
 * `React.memo` above it is not defeated by an edit that changed nothing.
 */
export function applyNodeChanges<Data = FlowNodeData>(
  changes: readonly NodeChange<Data>[],
  nodes: readonly FlowNode<Data>[],
): FlowNode<Data>[] {
  if (changes.length === 0) return nodes as FlowNode<Data>[];
  const removed = new Set<string>();
  const byId = new Map<string, FlowNode<Data>>();
  for (const node of nodes) byId.set(node.id, node);
  const added: { item: FlowNode<Data>; index?: number }[] = [];
  let touched = false;

  for (const change of changes) {
    if (change.type === 'add') {
      added.push({ item: change.item, index: change.index });
      touched = true;
      continue;
    }
    if (change.type === 'remove') {
      if (byId.has(change.id)) {
        removed.add(change.id);
        touched = true;
      }
      continue;
    }
    const current = byId.get(change.id);
    if (!current) continue;
    if (change.type === 'replace') {
      byId.set(change.id, change.item);
      touched = true;
    } else if (change.type === 'select') {
      if ((current.selected ?? false) === change.selected) continue;
      byId.set(change.id, { ...current, selected: change.selected });
      touched = true;
    } else if (change.type === 'dimensions') {
      const { width, height } = change.dimensions;
      if (current.width === width && current.height === height) continue;
      byId.set(change.id, { ...current, width, height });
      touched = true;
    } else if (change.position) {
      const { x, y } = change.position;
      if (current.position.x === x && current.position.y === y) continue;
      byId.set(change.id, { ...current, position: { x, y } });
      touched = true;
    }
  }
  if (!touched) return nodes as FlowNode<Data>[];

  const next: FlowNode<Data>[] = [];
  for (const node of nodes) {
    if (removed.has(node.id)) continue;
    next.push(byId.get(node.id) ?? node);
  }
  for (const { item, index } of added) {
    if (index === undefined || index >= next.length) next.push(item);
    else next.splice(Math.max(0, index), 0, item);
  }
  return next;
}

/** {@link applyNodeChanges} for edges. Removing a node does *not* remove its
 * edges — that is the app's call, and `removeConnectedEdges` is the helper. */
export function applyEdgeChanges<Data = unknown>(
  changes: readonly EdgeChange<Data>[],
  edges: readonly FlowEdge<Data>[],
): FlowEdge<Data>[] {
  if (changes.length === 0) return edges as FlowEdge<Data>[];
  const removed = new Set<string>();
  const byId = new Map<string, FlowEdge<Data>>();
  for (const edge of edges) byId.set(edge.id, edge);
  const added: { item: FlowEdge<Data>; index?: number }[] = [];
  let touched = false;

  for (const change of changes) {
    if (change.type === 'add') {
      added.push({ item: change.item, index: change.index });
      touched = true;
      continue;
    }
    if (change.type === 'remove') {
      if (byId.has(change.id)) {
        removed.add(change.id);
        touched = true;
      }
      continue;
    }
    const current = byId.get(change.id);
    if (!current) continue;
    if (change.type === 'replace') {
      byId.set(change.id, change.item);
      touched = true;
    } else if ((current.selected ?? false) !== change.selected) {
      byId.set(change.id, { ...current, selected: change.selected });
      touched = true;
    }
  }
  if (!touched) return edges as FlowEdge<Data>[];

  const next: FlowEdge<Data>[] = [];
  for (const edge of edges) {
    if (removed.has(edge.id)) continue;
    next.push(byId.get(edge.id) ?? edge);
  }
  for (const { item, index } of added) {
    if (index === undefined || index >= next.length) next.push(item);
    else next.splice(Math.max(0, index), 0, item);
  }
  return next;
}

/** The id `addEdge` gives a connection it turned into an edge. Derived from
 * the endpoints so that connecting the same two handles twice is idempotent
 * rather than a duplicate nobody can tell apart. */
export function connectionId(connection: Connection): string {
  const from = `${connection.source}${connection.sourceHandle ? `:${connection.sourceHandle}` : ''}`;
  const to = `${connection.target}${connection.targetHandle ? `:${connection.targetHandle}` : ''}`;
  return `edge__${from}->${to}`;
}

/**
 * Add the edge a connection describes, unless it is already there. Takes an
 * edge as well as a `Connection`, so `addEdge({ ...connection, animated:
 * true }, edges)` reads the way it does in react-flow.
 */
export function addEdge<Data = unknown>(
  connection: Connection | (Partial<FlowEdge<Data>> & Connection),
  edges: readonly FlowEdge<Data>[],
): FlowEdge<Data>[] {
  const { source, target } = connection;
  if (!source || !target) return edges as FlowEdge<Data>[];
  const sourceHandle = connection.sourceHandle ?? null;
  const targetHandle = connection.targetHandle ?? null;
  const exists = edges.some(
    (e) =>
      e.source === source &&
      e.target === target &&
      (e.sourceHandle ?? null) === sourceHandle &&
      (e.targetHandle ?? null) === targetHandle,
  );
  if (exists) return edges as FlowEdge<Data>[];
  const extras = connection as Partial<FlowEdge<Data>>;
  const edge = {
    ...extras,
    id:
      extras.id ?? connectionId({ source, target, sourceHandle, targetHandle }),
    source,
    target,
    sourceHandle,
    targetHandle,
  } as FlowEdge<Data>;
  return [...edges, edge];
}

/** Every edge with an end on one of these nodes — what a delete usually
 * wants to take with it. */
export function connectedEdges<Data = unknown>(
  ids: readonly string[],
  edges: readonly FlowEdge<Data>[],
): FlowEdge<Data>[] {
  const set = new Set(ids);
  return edges.filter((e) => set.has(e.source) || set.has(e.target));
}

// --- geometry --------------------------------------------------------------

export function snapTo(value: number, grid: number): number {
  return grid > 0 ? Math.round(value / grid) * grid : value;
}

/** Which way an edge leaves a side. */
export function handleDirection(position: HandlePosition): XYPosition {
  switch (position) {
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    default:
      return { x: 1, y: 0 };
  }
}

/** The handles a node carries: its own, else its type's, else the pair every
 * node has — a target in and a source out. */
export function resolveHandles<Data>(
  node: FlowNode<Data>,
  type: FlowNodeType<Data> | undefined,
): readonly HandleSpec[] {
  if (node.handles) return node.handles;
  const fromType =
    typeof type?.handles === 'function' ? type.handles(node) : type?.handles;
  if (fromType) return fromType;
  return [
    { type: 'target', position: node.targetPosition ?? 'top' },
    { type: 'source', position: node.sourcePosition ?? 'bottom' },
  ];
}

/** Place a handle on a node's box. Graph space, and the centre of the dot. */
export function handleAnchor(
  nodeId: string,
  rect: FlowRect,
  spec: HandleSpec,
): HandleAnchor {
  const t = spec.offset ?? 0.5;
  switch (spec.position) {
    case 'top':
      return { ...spec, nodeId, x: rect.x + rect.width * t, y: rect.y };
    case 'bottom':
      return {
        ...spec,
        nodeId,
        x: rect.x + rect.width * t,
        y: rect.y + rect.height,
      };
    case 'left':
      return { ...spec, nodeId, x: rect.x, y: rect.y + rect.height * t };
    default:
      return {
        ...spec,
        nodeId,
        x: rect.x + rect.width,
        y: rect.y + rect.height * t,
      };
  }
}

/**
 * How big a node is when it does not say. The label decides the width, one
 * or two lines decide the height, and both are clamped — an unbounded label
 * would otherwise turn one long string into a node wider than the pane.
 */
export function measureNode<Data>(
  node: FlowNode<Data>,
  type: FlowNodeType<Data> | undefined,
  measure: (text: string, options?: TextOptions) => number,
): { width: number; height: number } {
  if (node.width != null && node.height != null) {
    return { width: node.width, height: node.height };
  }
  let width: number;
  let height: number;
  const size =
    typeof type?.size === 'function' ? type.size(node, measure) : type?.size;
  if (size) {
    width = size.width;
    height = size.height;
  } else {
    const data = node.data as FlowNodeData | undefined;
    const label = data?.label ?? node.id;
    const description = data?.description;
    const labelW = measure(label, { size: NODE_LABEL_SIZE, weight: 'bold' });
    const descW = description
      ? measure(description, { size: NODE_DESC_SIZE })
      : 0;
    width = Math.max(
      NODE_MIN_WIDTH,
      Math.min(
        NODE_MAX_WIDTH,
        Math.ceil(Math.max(labelW, descW)) + NODE_PAD_X * 2,
      ),
    );
    height = Math.max(
      NODE_MIN_HEIGHT,
      NODE_PAD_Y * 2 +
        Math.round(NODE_LABEL_SIZE * 1.3) +
        (description ? Math.round(NODE_DESC_SIZE * 1.5) : 0),
    );
  }
  return { width: node.width ?? width, height: node.height ?? height };
}

/** The box around a set of rects, or null when there are none. */
export function boundsOf(rects: readonly FlowRect[]): FlowRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The box around two boxes. */
export function unionRects(a: FlowRect, b: FlowRect): FlowRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** A box grown by `m` on every side; negative shrinks. */
export function inflateRect(r: FlowRect, m: number): FlowRect {
  return {
    x: r.x - m,
    y: r.y - m,
    width: r.width + m * 2,
    height: r.height + m * 2,
  };
}

/** The overlap of two boxes, or null when they have none. */
export function intersectRects(a: FlowRect, b: FlowRect): FlowRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function rectsOverlap(a: FlowRect, b: FlowRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function rectContains(r: FlowRect, p: XYPosition): boolean {
  return (
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
  );
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * The viewport that frames `bounds` inside a pane of `size`. Zoom first —
 * the smaller of the two axis ratios, so nothing is cut — then translate so
 * the scaled bounds land centred.
 */
export function fitViewport(
  bounds: FlowRect,
  size: { width: number; height: number },
  options: FitViewOptions = {},
  limits: { minZoom: number; maxZoom: number },
): Viewport {
  const padding = options.padding ?? 0.1;
  const minZoom = options.minZoom ?? limits.minZoom;
  const maxZoom = options.maxZoom ?? limits.maxZoom;
  const usableW = Math.max(1, size.width * (1 - padding * 2));
  const usableH = Math.max(1, size.height * (1 - padding * 2));
  const zoom = clamp(
    Math.min(
      usableW / Math.max(1, bounds.width),
      usableH / Math.max(1, bounds.height),
    ),
    minZoom,
    maxZoom,
  );
  return {
    zoom,
    x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

/** The eight grips on a node's border, as unit directions. */
export const RESIZE_DIRECTIONS: readonly XYPosition[] = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
];

/** Where a grip sits on a box. */
export function gripPoint(rect: FlowRect, dir: XYPosition): XYPosition {
  return {
    x: rect.x + (rect.width * (dir.x + 1)) / 2,
    y: rect.y + (rect.height * (dir.y + 1)) / 2,
  };
}

/**
 * Drag one grip and get the box it makes. The edges the grip does not own
 * stay exactly where they were — which is what makes a resize from the
 * top-left move the node's origin and one from the bottom-right not.
 *
 * Clamped to the minimum by moving the dragged edge back, never by moving
 * the opposite one: a node held at its floor must not creep across the
 * canvas while the pointer keeps going.
 */
export function resizeRect(
  origin: FlowRect,
  dir: XYPosition,
  dx: number,
  dy: number,
  limits: { minWidth: number; minHeight: number },
  snap?: (value: number, axis: 0 | 1) => number,
): FlowRect {
  let { x, y, width, height } = origin;
  if (dir.x < 0) {
    const right = origin.x + origin.width;
    x = snap ? snap(origin.x + dx, 0) : origin.x + dx;
    x = Math.min(x, right - limits.minWidth);
    width = right - x;
  } else if (dir.x > 0) {
    const edge = snap
      ? snap(origin.x + origin.width + dx, 0)
      : origin.x + origin.width + dx;
    width = Math.max(limits.minWidth, edge - origin.x);
  }
  if (dir.y < 0) {
    const bottom = origin.y + origin.height;
    y = snap ? snap(origin.y + dy, 1) : origin.y + dy;
    y = Math.min(y, bottom - limits.minHeight);
    height = bottom - y;
  } else if (dir.y > 0) {
    const edge = snap
      ? snap(origin.y + origin.height + dy, 1)
      : origin.y + origin.height + dy;
    height = Math.max(limits.minHeight, edge - origin.y);
  }
  return { x, y, width, height };
}

// --- connections -----------------------------------------------------------

/**
 * Can these two handles be joined? A source only meets a target in
 * `'strict'` mode; `'loose'` asks only that the two ends are different
 * nodes, for graphs whose handles are not typed.
 */
export function canConnect(
  from: { nodeId: string; type: 'source' | 'target' },
  to: { nodeId: string; type: 'source' | 'target' },
  mode: 'strict' | 'loose',
): boolean {
  if (from.nodeId === to.nodeId) return false;
  if (mode === 'loose') return true;
  return from.type !== to.type;
}

/** Orient a finished gesture into a `Connection`: whichever end is the
 * source becomes `source`, whichever way round the user dragged. */
export function orientConnection(
  from: { nodeId: string; handleId: string | null; type: 'source' | 'target' },
  to: { nodeId: string; handleId: string | null; type: 'source' | 'target' },
): Connection {
  const forward = from.type !== 'target';
  const s = forward ? from : to;
  const t = forward ? to : from;
  return {
    source: s.nodeId,
    sourceHandle: s.handleId,
    target: t.nodeId,
    targetHandle: t.handleId,
  };
}

// --- colours ---------------------------------------------------------------

/**
 * `[r, g, b, a]`, 0-1, unassociated. ntk's parser is reached through
 * react-x11's re-export rather than a second `ntk` dependency, and read off
 * the namespace rather than declared through `declare module` — an
 * augmentation would be emitted into this package's own `.d.ts` and then
 * seen twice by a program holding both `src/` and `dist/`. `src/calendar/`
 * has the same three paragraphs for the same reason.
 *
 * Only `lightness` needs it now: the `tint` that used to sit beside it is
 * `react-x11/style`'s, and every surface here imports it from there.
 */
type StraightColor = [number, number, number, number];

const cssColorStraight = (
  ntk as unknown as {
    cssColorStraight?: (color: string) => StraightColor | null;
  }
).cssColorStraight;

/** Perceived lightness, 0-1, or null for a colour that would not parse. Only
 * used to pick between two hard-coded fallbacks, never to compute one. */
export function lightness(color: string | undefined): number | null {
  if (!color) return null;
  const c = cssColorStraight?.(color);
  if (!c) return null;
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

const LIGHT_PALETTE: FlowPalette = {
  background: '#f4f5f7',
  grid: '#d3d7de',
  text: '#1c2024',
  dim: '#697280',
  nodeBackground: '#ffffff',
  nodeBorder: '#c6cad2',
  accent: '#2f6feb',
  edge: '#8b93a1',
  edgeSelected: '#2f6feb',
  handle: '#8b93a1',
  surface: '#ffffff',
  surfaceBorder: '#c6cad2',
  selection: 'rgba(47, 111, 235, 0.14)',
};

const DARK_PALETTE: FlowPalette = {
  background: '#1a1c20',
  grid: '#2e3238',
  text: '#e6e8ec',
  dim: '#9aa1ad',
  nodeBackground: '#23262c',
  nodeBorder: '#3a3f47',
  accent: '#5b8cff',
  edge: '#6d7482',
  edgeSelected: '#5b8cff',
  handle: '#8891a0',
  surface: '#23262c',
  surfaceBorder: '#3a3f47',
  selection: 'rgba(91, 140, 255, 0.18)',
};

function themeString(
  theme: Record<string, unknown> | null,
  token: string,
): string | undefined {
  const v = theme?.[token];
  return typeof v === 'string' ? v : undefined;
}

/**
 * The pane's colours: the desktop palette where it has an opinion, a
 * hard-coded scheme where it does not, and the app's `palette` prop over
 * both.
 *
 * Every token is taken by its own name. A node is `surface` and the pane is
 * `background` — "the ground" and "what is raised off it", which is exactly
 * the distinction core's palette draws, and the reason a card on a dark
 * desktop is a card you can see.
 */
export function resolvePalette(
  theme: Record<string, unknown> | null,
  overrides?: Partial<FlowPalette>,
): FlowPalette {
  const base =
    (lightness(themeString(theme, 'background')) ?? 1) < 0.5
      ? DARK_PALETTE
      : LIGHT_PALETTE;
  const accent = themeString(theme, 'accent') ?? base.accent;
  // `textMuted`, not `dim`: core renamed it (react-x11#290) and a stale read
  // here would not fail — it would fall through to the hard-coded scheme and
  // quietly stop following the desktop.
  const muted = themeString(theme, 'textMuted');
  const surface = themeString(theme, 'surface');
  const border = themeString(theme, 'border');
  const palette: FlowPalette = {
    background: themeString(theme, 'background') ?? base.background,
    grid: border ?? base.grid,
    text: themeString(theme, 'text') ?? base.text,
    dim: muted ?? base.dim,
    nodeBackground: surface ?? base.nodeBackground,
    nodeBorder: border ?? base.nodeBorder,
    accent,
    edge: muted ?? base.edge,
    edgeSelected: accent,
    handle: muted ?? base.handle,
    surface: surface ?? base.surface,
    surfaceBorder: border ?? base.surfaceBorder,
    selection: tint(accent, 0.16),
  };
  return overrides ? { ...palette, ...overrides } : palette;
}

// --- prop normalisation ----------------------------------------------------

export function normalizeBackground(
  value: BackgroundOptions | string | boolean | undefined,
): Required<Omit<BackgroundOptions, 'color'>> & { color?: string } {
  const opts: BackgroundOptions =
    typeof value === 'string'
      ? { variant: value as BackgroundOptions['variant'] }
      : value === false
        ? { variant: 'none' }
        : typeof value === 'object' && value !== null
          ? value
          : {};
  return {
    variant: opts.variant ?? 'dots',
    gap: opts.gap ?? 20,
    size: opts.size ?? 1,
    color: opts.color,
  };
}

export function normalizeMarker(
  marker: MarkerType | EdgeMarker | null | undefined,
): EdgeMarker | null {
  if (marker == null) return null;
  if (typeof marker === 'string') return { type: marker };
  return marker;
}
