// The second half of drawing: a {@link FlowScene} issued through a
// `FlowPainter`.
//
// `./scene.ts` decided what the frame shows; this decides how few requests
// show it. That division is deliberate — every batching rule below is a
// property of *this* renderer, measured against ntk's 2D context, and none
// of it would be right for a GPU (`docs/prd-flow-gl.md`). A scene is
// renderer-neutral precisely because the buckets live here.
//
// Z-order is the order of the calls, and it is load-bearing: the grid, then
// every edge's stroke, then every arrowhead, then every label chip, then
// every label, then the nodes, then the pane's furniture. An edge label that
// drew with its own edge would be crossed out by the next edge over.
import type { FlowPainter, StrokeOptions, XYPosition } from './types.js';
import type {
  FlowScene,
  SceneEdge,
  SceneGrid,
  SceneNodeItem,
  SceneRect,
  SceneRule,
  SceneText,
} from './scene.js';

/** How a renderer draws the grid, when it can do better than the runs below
 *  — the element's pattern-tile path (ntk#263). Answers whether it did. */
export type GridPainter = (painter: FlowPainter, grid: SceneGrid) => boolean;

function paintRect(painter: FlowPainter, item: SceneRect): void {
  painter.rect(
    item.rect.x,
    item.rect.y,
    item.rect.width,
    item.rect.height,
    item.radius,
    { fill: item.fill, stroke: item.stroke, lineWidth: item.lineWidth },
  );
}

/** A rect `paintRect` would fill and nothing else. */
function plainSquare(item: SceneRect): boolean {
  return item.radius <= 0 && !item.stroke && item.fill != null;
}

function paintText(painter: FlowPainter, item: SceneText): void {
  painter.text(item.text, item.x, item.y, {
    size: item.size,
    color: item.color,
    weight: item.weight,
    align: item.align,
    baseline: item.baseline,
    maxWidth: item.maxWidth,
  });
}

/**
 * Strokes grouped by the pen that will draw them, for a pane whose edges are
 * stroked a pen at a time (`FlowScene.batch`, `EDGE_BATCH` in `scene.ts`).
 *
 * Everything a graph strokes is the same two or three pens — the default
 * edge, the selected one, the animated dash — so grouping collapses a
 * per-edge request into a per-pen one. The key carries the dash *and* its
 * offset: two edges marching out of phase cannot share a path, because the
 * offset is set on the context, not on the subpath. And it leads with the
 * layer, so that the pens are stroked in the same order by every pass —
 * the order a pass happened to meet them in put the default pen over the
 * selected one in one pass and under it in the next.
 */
class StrokeBuckets {
  private readonly byPen = new Map<
    string,
    { options: StrokeOptions; runs: (readonly XYPosition[])[] }
  >();

  push(
    points: readonly XYPosition[],
    layer: number,
    stroke: string,
    lineWidth: number,
    dash: readonly number[] | undefined,
    dashOffset: number,
  ): void {
    const key = `${layer}|${stroke}|${lineWidth}|${dash?.join(',') ?? ''}|${dashOffset}`;
    let entry = this.byPen.get(key);
    if (!entry) {
      entry = { options: { stroke, lineWidth, dash, dashOffset }, runs: [] };
      this.byPen.set(key, entry);
    }
    entry.runs.push(points);
  }

  paint(painter: FlowPainter): void {
    for (const key of [...this.byPen.keys()].sort()) {
      const { options, runs } = this.byPen.get(key)!;
      painter.strokeRuns(runs, options);
    }
  }
}

/** Arrowheads piled by colour: the filled heads and the open ones share one,
 *  and differ only in which list they land in. */
interface MarkerBucket {
  color: string;
  lineWidth: number;
  filled: (readonly XYPosition[])[];
  open: (readonly XYPosition[])[];
}

/** The runs a pass strokes of an edge — the part of the route it reaches,
 *  where it reaches only part. */
function runsOf(edge: SceneEdge): readonly (readonly XYPosition[])[] {
  return edge.runs ?? [edge.points];
}

function paintEdges(
  painter: FlowPainter,
  edges: readonly SceneEdge[],
  batch: boolean,
): void {
  if (batch) paintEdgesByPen(painter, edges);
  else paintEdgesInOrder(painter, edges);

  // The chips and then the labels, both above every edge — which is the
  // point of a chip. The text is not collected, because a glyph run is
  // already one request and nothing is gained by holding it.
  for (const edge of edges) {
    if (edge.chip) paintRect(painter, edge.chip);
  }
  for (const edge of edges) {
    if (edge.label) paintText(painter, edge.label);
  }
}

/**
 * Every run of a pen as one path, and every arrowhead of a colour. A pass
 * draws the pens it reaches in the same order and with the same compositing
 * as the whole pane does: where two of a pen's runs overlap, their coverage
 * adds, in a pass as in a repaint.
 */
function paintEdgesByPen(
  painter: FlowPainter,
  edges: readonly SceneEdge[],
): void {
  const strokes = new StrokeBuckets();
  const markers = new Map<string, MarkerBucket>();
  for (const edge of edges) {
    const layer = edge.layer ?? 0;
    // a dashed run picking its pattern up where it starts along the edge
    const runs = runsOf(edge);
    for (let i = 0; i < runs.length; i++) {
      const points = runs[i];
      if (points.length < 2) continue;
      strokes.push(
        points,
        layer,
        edge.stroke,
        edge.lineWidth,
        edge.dash,
        edge.dashOffset + (edge.runStarts?.[i] ?? 0),
      );
    }
    for (const marker of edge.markers) {
      const key = `${layer}|${marker.color}|${marker.lineWidth}`;
      let bucket = markers.get(key);
      if (!bucket) {
        bucket = {
          color: marker.color,
          lineWidth: marker.lineWidth,
          filled: [],
          open: [],
        };
        markers.set(key, bucket);
      }
      (marker.filled ? bucket.filled : bucket.open).push(marker.points);
    }
  }
  strokes.paint(painter);
  for (const key of [...markers.keys()].sort()) {
    const bucket = markers.get(key)!;
    if (bucket.filled.length > 0) {
      painter.polygons(bucket.filled, { fill: bucket.color });
    }
    if (bucket.open.length > 0) {
      painter.strokeRuns(bucket.open, {
        stroke: bucket.color,
        lineWidth: bucket.lineWidth,
      });
    }
  }
}

/**
 * An edge at a time, in the graph's order, and the arrowheads after all of
 * them: what a pane with few edges draws, where a path per pen would be a
 * mask the size of the pane (`EDGE_BATCH`). One edge is still one path,
 * however many pieces a pass cut it into: a step edge that doubles back
 * along its own line adds its two legs' coverage in one path and lays one
 * over the other in two, and a pass that drew the pieces apart drew the
 * shared line lighter at its edges than a repaint did. A dashed edge's
 * pieces are the exception — each picks its pattern up where it starts, and
 * a dash offset is the context's, not a subpath's.
 */
function paintEdgesInOrder(
  painter: FlowPainter,
  edges: readonly SceneEdge[],
): void {
  for (const edge of edges) {
    const runs = runsOf(edge);
    const pen = {
      stroke: edge.stroke,
      lineWidth: edge.lineWidth,
      dash: edge.dash,
      dashOffset: edge.dashOffset,
    };
    if (edge.dash && edge.runStarts) {
      for (let i = 0; i < runs.length; i++) {
        if (runs[i].length < 2) continue;
        painter.polyline(runs[i], {
          ...pen,
          dashOffset: edge.dashOffset + (edge.runStarts[i] ?? 0),
        });
      }
    } else if (runs.length === 1) {
      painter.polyline(runs[0], pen);
    } else {
      painter.strokeRuns(runs, pen);
    }
  }
  for (const edge of edges) {
    for (const marker of edge.markers) {
      if (marker.filled) {
        painter.polygon(marker.points, { fill: marker.color });
      } else {
        painter.strokeRuns([marker.points], {
          stroke: marker.color,
          lineWidth: marker.lineWidth,
        });
      }
    }
  }
}

function paintInk(
  painter: FlowPainter,
  ink: readonly (SceneText | SceneRule)[],
): void {
  for (const item of ink) {
    if (item.kind === 'text') paintText(painter, item);
    else {
      painter.strokeRuns([item.points], {
        stroke: item.color,
        lineWidth: item.lineWidth,
      });
    }
  }
}

/** One node — card, ink, handles, grips — as the scene paints it; the
 *  scene is read for its zoom and palette only. */
export function paintNodeItem(
  painter: FlowPainter,
  item: SceneNodeItem,
  scene: Pick<FlowScene, 'viewport' | 'palette'>,
): void {
  paintNode(painter, item, scene as FlowScene);
}

function paintNode(
  painter: FlowPainter,
  item: SceneNodeItem,
  scene: FlowScene,
): void {
  if (item.custom) {
    // Never batched: a type that draws its own body is drawing whatever it
    // likes, in an order only it knows.
    item.custom.type.paint!({
      node: item.custom.node,
      rect: item.rect,
      zoom: scene.viewport.zoom,
      selected: item.selected,
      hovered: item.hovered,
      palette: scene.palette,
      painter,
      handles: item.custom.anchors,
    });
  } else if (item.card) {
    paintRect(painter, item.card.shape);
    if (item.card.accent) paintRect(painter, item.card.accent);
    paintInk(painter, item.ink);
  }

  // Handles are drawn one disc at a time, and that is the measured answer
  // rather than the obvious one. Batching them into a single path halved the
  // requests and made the frame *slower*: a path's mask is its bounding box,
  // so forty dots scattered across the pane rasterize to a paneful of mask —
  // three quarters of a megabyte — where forty small ones cost a kilobyte
  // each. Batching pays for the edges because an edge already spans that
  // box; it does not pay for anything small and scattered.
  for (const handle of item.handles) {
    painter.circle(handle.at.x, handle.at.y, handle.radius, {
      fill: handle.fill,
      stroke: handle.stroke,
      lineWidth: handle.lineWidth,
    });
    if (handle.label) paintText(painter, handle.label);
  }
  for (const grip of item.grips) paintRect(painter, grip);
}

/** The runs a grid variant is made of, when there is no faster path.
 *  `mark` is a mark's size on screen — the scene's is in graph units. */
function gridRuns(
  grid: SceneGrid,
  mark: number,
): {
  runs: XYPosition[][];
  dots: XYPosition[];
} {
  const { step, origin, region: r, variant } = grid;
  // Alignment stays anchored to the viewport origin, so the region never
  // changes where a dot falls.
  const firstX = origin.x + Math.ceil((r.x - origin.x) / step) * step;
  const firstY = origin.y + Math.ceil((r.y - origin.y) / step) * step;
  const runs: XYPosition[][] = [];
  const dots: XYPosition[] = [];

  if (variant === 'lines') {
    for (let gx = firstX; gx <= r.x + r.width; gx += step) {
      runs.push([
        { x: gx, y: r.y },
        { x: gx, y: r.y + r.height },
      ]);
    }
    for (let gy = firstY; gy <= r.y + r.height; gy += step) {
      runs.push([
        { x: r.x, y: gy },
        { x: r.x + r.width, y: gy },
      ]);
    }
    return { runs, dots };
  }

  if (variant === 'cross') {
    const arm = Math.max(2, mark * 3);
    for (let gx = firstX; gx <= r.x + r.width; gx += step) {
      for (let gy = firstY; gy <= r.y + r.height; gy += step) {
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
    return { runs, dots };
  }

  for (let gx = firstX; gx <= r.x + r.width; gx += step) {
    for (let gy = firstY; gy <= r.y + r.height; gy += step) {
      dots.push({ x: gx, y: gy });
    }
  }
  return { runs, dots };
}

/** The grid, the slow and universal way. A mark's size arrives in graph
 *  units, so it is sized against the same zoom the pitch was. */
export function paintGrid(
  painter: FlowPainter,
  grid: SceneGrid,
  zoom: number,
): void {
  const { runs, dots } = gridRuns(grid, grid.size * zoom);
  if (runs.length > 0) {
    painter.strokeRuns(runs, { stroke: grid.color, lineWidth: 1 });
  }
  if (dots.length > 0) {
    painter.dots(
      dots,
      Math.max(1, Math.round(grid.size * 2 * zoom)),
      grid.color,
    );
  }
}

/**
 * Draw a scene.
 *
 * `grid` is the element's accelerated grid painter, if it has one: it
 * answers false when it could not, and the runs path takes over.
 */
export function paintScene(
  painter: FlowPainter,
  scene: FlowScene,
  grid?: GridPainter,
): void {
  if (!scene.region) return;
  paintGround(painter, scene, grid);
  paintGraph(painter, scene);
  paintFloat(painter, scene);
}

/** Under the graph, pinned to the pane: the background and the grid. */
export function paintGround(
  painter: FlowPainter,
  scene: FlowScene,
  grid?: GridPainter,
): void {
  if (scene.background) paintRect(painter, scene.background);
  if (scene.grid && !(grid?.(painter, scene.grid) ?? false)) {
    paintGrid(painter, scene.grid, scene.viewport.zoom);
  }
}

/** The graph: edges, nodes, and the line a connection gesture draws. What
 *  a 2D zoom gesture composites scaled from one paint of it. */
export function paintGraph(painter: FlowPainter, scene: FlowScene): void {
  paintGraphEdges(painter, scene);
  paintGraphNodes(painter, scene);
}

/** The graph's edges alone: the first half of `paintGraph`, which a drag's
 *  pictures take apart so the dragged node's edges go between them. */
export function paintGraphEdges(painter: FlowPainter, scene: FlowScene): void {
  paintEdges(painter, scene.edges, scene.batch);
}

/** The graph's nodes, and the connection line over them: the second half. */
export function paintGraphNodes(painter: FlowPainter, scene: FlowScene): void {
  for (const item of scene.nodes) paintNode(painter, item, scene);
  if (scene.connection) {
    painter.polyline(scene.connection.points, {
      stroke: scene.connection.stroke,
      lineWidth: scene.connection.lineWidth,
      dash: scene.connection.dash,
    });
    const tip = scene.connection.tip;
    painter.circle(tip.at.x, tip.at.y, tip.radius, { fill: tip.fill });
  }
}

/** Over the graph, pinned to the pane: the selection box and the panels. */
export function paintFloat(painter: FlowPainter, scene: FlowScene): void {
  if (scene.selection) paintRect(painter, scene.selection);
  paintPanels(painter, scene);
}

/** The panels that float over the graph — the minimap and the controls —
 *  alone: the last of a scene's paint, and what `<Flow>` paints on its own
 *  canvases over mounted bodies (`FlowGraphNode.paintPanels`). */
export function paintPanels(
  painter: FlowPainter,
  scene: Pick<FlowScene, 'miniMap' | 'controls'>,
): void {
  if (scene.miniMap) {
    const map = scene.miniMap;
    paintRect(painter, map.panel);
    painter.save();
    painter.clipRect(
      map.panel.rect.x,
      map.panel.rect.y,
      map.panel.rect.width,
      map.panel.rect.height,
      4,
    );
    // A run of square, unstroked nodes of one colour is one path and one
    // fill — every node of a graph's minimap is usually one run, and a call
    // apiece was 400 of them on every repaint of a drag.
    const nodes = map.nodes;
    for (let i = 0; i < nodes.length;) {
      const first = nodes[i];
      let end = i + 1;
      if (plainSquare(first)) {
        while (
          end < nodes.length &&
          plainSquare(nodes[end]) &&
          nodes[end].fill === first.fill
        ) {
          end++;
        }
      }
      if (end - i > 1) {
        const shapes: XYPosition[][] = [];
        for (let k = i; k < end; k++) {
          const { x, y, width, height } = nodes[k].rect;
          shapes.push([
            { x, y },
            { x: x + width, y },
            { x: x + width, y: y + height },
            { x, y: y + height },
          ]);
        }
        painter.polygons(shapes, { fill: first.fill });
      } else {
        paintRect(painter, first);
      }
      i = end;
    }
    paintRect(painter, map.view);
    painter.restore();
  }

  if (scene.controls) {
    paintRect(painter, scene.controls.panel);
    for (const rule of scene.controls.rules) {
      painter.strokeRuns([rule.points], {
        stroke: rule.color,
        lineWidth: rule.lineWidth,
      });
    }
    // One path per button rather than one for the panel: a button's marks
    // share a tiny mask, and the panel's would span every button.
    for (const glyph of scene.controls.glyphs) {
      painter.strokeRuns(glyph.runs, {
        stroke: glyph.color,
        lineWidth: glyph.lineWidth,
      });
    }
  }
}
