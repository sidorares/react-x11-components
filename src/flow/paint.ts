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

/**
 * Below this many runs in one pen, they are stroked one at a time.
 *
 * A path's mask is its bounding box, so batching scattered geometry trades
 * many small masks for one the size of the pane — about three quarters of a
 * megabyte at a normal window size. That is a large win at seven hundred
 * edges (measured: 3.9 MB a frame down to 1.3) and a loss at twenty, where
 * the individual masks never add up to a paneful. The threshold is where
 * they start to.
 */
const BATCH_MIN = 24;

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
 * Strokes grouped by the pen that will draw them.
 *
 * Everything a graph strokes is the same two or three pens — the default
 * edge, the selected one, the animated dash — so grouping collapses a
 * per-edge request into a per-pen one. The key carries the dash *and* its
 * offset: two edges marching out of phase cannot share a path, because the
 * offset is set on the context, not on the subpath.
 */
class StrokeBuckets {
  private readonly byPen = new Map<
    string,
    { options: StrokeOptions; runs: (readonly XYPosition[])[] }
  >();

  push(
    points: readonly XYPosition[],
    stroke: string,
    lineWidth: number,
    dash: readonly number[] | undefined,
    dashOffset: number,
  ): void {
    const key = `${stroke}|${lineWidth}|${dash?.join(',') ?? ''}|${dashOffset}`;
    let entry = this.byPen.get(key);
    if (!entry) {
      entry = {
        options: { stroke, lineWidth, dash, dashOffset },
        runs: [],
      };
      this.byPen.set(key, entry);
    }
    entry.runs.push(points);
  }

  paint(painter: FlowPainter): void {
    for (const { options, runs } of this.byPen.values()) {
      if (runs.length >= BATCH_MIN) {
        painter.strokeRuns(runs, options);
      } else {
        for (const run of runs) painter.polyline(run, options);
      }
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

function paintEdges(painter: FlowPainter, edges: readonly SceneEdge[]): void {
  const strokes = new StrokeBuckets();
  const markers = new Map<string, MarkerBucket>();
  for (const edge of edges) {
    // the part of the route this pass reaches, where it reaches only part
    for (const points of edge.runs ?? [edge.points]) {
      if (points.length < 2) continue;
      strokes.push(
        points,
        edge.stroke,
        edge.lineWidth,
        edge.dash,
        edge.dashOffset,
      );
    }
    for (const marker of edge.markers) {
      const key = `${marker.color}|${marker.lineWidth}`;
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

  for (const bucket of markers.values()) {
    // the same threshold, for the same reason: a handful of arrowheads
    // scattered over the pane is cheaper drawn as a handful
    if (bucket.filled.length >= BATCH_MIN) {
      painter.polygons(bucket.filled, { fill: bucket.color });
    } else {
      for (const head of bucket.filled) {
        painter.polygon(head, { fill: bucket.color });
      }
    }
    const stroke = { stroke: bucket.color, lineWidth: bucket.lineWidth };
    if (bucket.open.length >= BATCH_MIN) {
      painter.strokeRuns(bucket.open, stroke);
    } else {
      for (const head of bucket.open) painter.strokeRuns([head], stroke);
    }
  }

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
  paintEdges(painter, scene.edges);
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
