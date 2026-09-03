// The rasterizer: a tile's features, drawn.
//
// One function does the whole of it ({@link drawTileLayers}), and it is
// written for one situation — twelve thousand features and a hundred and
// eighty thousand vertices, sixty times a second — so every decision in it
// is about the per-vertex and per-feature paths. In rough order of how much
// each is worth on the corpus in `scripts/bench/`:
//
//  1. **One path per style layer, not per feature.** ntk batches a fill
//     into server-side trapezoids and a stroke into server-side spans, both
//     gated on the whole path arriving before `fill()`. Drawing 2,700
//     streets as 2,700 `beginPath`/`stroke` pairs is 2,700 round-trippable
//     request groups; drawing them as one path is a handful. The path is
//     flushed every {@link BATCH_VERTICES} vertices so a pathological layer
//     cannot make one unbounded request.
//  2. **Vertex decimation against the target grid.** A vertex less than
//     `tolerance` from the one before it lands on the same pixel, so it is
//     dropped. Sounds marginal; is not — Shortbread's low-zoom `land`
//     layer is a single 130,000-vertex forest multipolygon whose vertices
//     are, at zoom 8, roughly a fifth of a pixel apart.
//  3. **A sub-pixel feature is skipped whole.** The bounding box came free
//     from the geometry read, so a building a third of a pixel across is
//     one comparison rather than a path.
//  4. **Paint resolved per layer.** A zoom ramp, a filter compile and a
//     colour string are per layer, never per feature. The filter arrives
//     already compiled ({@link compileFilter}).
//  5. **Nothing allocates per feature.** One {@link GeometryBuffer} and one
//     {@link FeatureCursor} for the whole call.
//
// The unit convention is the other half of the file, and it is the thing to
// get right before changing anything: **everything here is in *target*
// pixels**, where the target is either a tile's own surface (the retained
// path, where the tile occupies the whole surface) or the window's paint
// context (the direct path). {@link TileDraw} carries the two numbers that
// make one out of the other, so the same code serves both and neither has a
// branch in the vertex loop.
import type { CompiledFilter, MapStyleLayer, Zoomed } from './style.js';
import { compileFilter, resolveZoomed } from './style.js';
import { GeomType, GeometryBuffer } from './mvt.js';
import type { VectorTile, VectorTileLayer } from './mvt.js';

/**
 * The slice of ntk's 2d context this draws through.
 *
 * Structural because react-x11 types `Context2D` as `unknown` on purpose —
 * it is ntk's API rather than react-x11's — so something has to name the
 * operations, and naming them once beats naming them at sixty call sites
 * (the same argument `src/flow/draw.ts` makes).
 */
export interface MapCanvas {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin?: unknown;
  lineCap?: unknown;
  globalAlpha?: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, r: number, from: number, to: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  /** One request for many rectangles — what a marker cluster and a
   *  scale bar are drawn with. */
  fillRects?(rects: readonly number[]): void;
  setLineDash?(segments: readonly number[]): void;
  roundRect?(x: number, y: number, w: number, h: number, radii: number): void;
  drawImage?(image: unknown, ...args: number[]): void;
  /** Straight RGBA in, for a raster tile the application decoded. */
  putImageData?(
    data: { width: number; height: number; data: Uint8Array },
    x: number,
    y: number,
  ): void;
}

/**
 * Whether a context can draw at all.
 *
 * The mock backend the headless suite runs on has no path API, which is the
 * repo convention for keeping a drawn element testable: the element's paint
 * becomes a no-op there rather than a throw, and everything worth asserting
 * about it — the cover, the projection, the cache, the hit test — is
 * asserted without pixels.
 */
export function isMapCanvas(ctx: unknown): ctx is MapCanvas {
  const c = ctx as Partial<MapCanvas> | null | undefined;
  return typeof c?.beginPath === 'function' && typeof c?.fill === 'function';
}

/** Vertices after which the accumulated path is flushed. Large enough that
 *  a whole ordinary layer is one path, small enough that the 130,000-vertex
 *  outlier is a few rather than one enormous request. */
export const BATCH_VERTICES = 12_000;

/**
 * How a tile's own integer coordinates reach the target.
 *
 * `ox`/`oy`/`span` place the tile: its local `0` lands at `ox`, and its
 * whole square is `span` target pixels across — so a layer's scale is
 * `span / layer.extent`, computed **per layer**, because extent is a
 * per-layer field and real tiles use that (OSM's Shortbread cuts `streets`,
 * `land`, `ocean` and `water_polygons` at 2048 and its other twenty layers
 * at 4096; a renderer that reads it once per tile draws half of them at
 * twice their size).
 *
 * `pixelsPerLogical` is what a style's lengths are multiplied by. On the
 * direct path it is simply the display scale. On the retained path it is
 * `surfaceSize / tileScreenSize`, which is the display scale divided by
 * whatever the composite is about to multiply by — so a two-logical-pixel
 * road is two logical pixels on screen at every fractional zoom, without
 * the raster being redrawn for any of them.
 */
export interface TileDraw {
  ox: number;
  oy: number;
  span: number;
  pixelsPerLogical: number;
  /** The zoom the style is resolved at. */
  zoom: number;
  /** Target pixels below which a vertex is dropped as a duplicate of the
   *  one before it. `0` disables decimation. */
  tolerance?: number;
  /** Target pixels below which a whole feature is skipped. */
  minFeature?: number;
  /** Clip rectangle in target coordinates — the direct path's viewport.
   *  Null on the retained path, where the surface is the clip. */
  clip?: { x: number; y: number; width: number; height: number } | null;
  /**
   * Vertices after which the accumulated path is flushed, if not
   * {@link BATCH_VERTICES}.
   *
   * **This is the one number whose best value differs by backend**, and it
   * differs because the two rasterizers fail in opposite directions:
   *
   *  - On **X11** a fill or stroke becomes an a8 coverage mask over the
   *    path's bounding box, uploaded with one `PutImage`. Bigger batches
   *    mean fewer uploads over the same pixels, so the number wants to be
   *    large — a whole layer in one path.
   *  - On the **Cocoa** backend the path goes to `CGContextStrokePath`,
   *    whose cost is superlinear in the number of subpaths: a tile's two
   *    thousand building rings in one path measured 347 ms and the same
   *    rings in batches of 512 vertices measured a fifth of that. There the
   *    number wants to be small. Filed as react-x11#456; the batch size is
   *    a legitimate caller-side choice either way.
   *
   * `<Map>` picks it from the backend it is on. See `docs/prd-maps.md`.
   */
  batchVertices?: number;
}

/** What a rasterization cost, for the bench and for `onFrame`. */
export interface DrawStats {
  layers: number;
  features: number;
  /** Vertices that survived decimation and were sent. */
  vertices: number;
  /** Vertices dropped as sub-pixel duplicates. */
  decimated: number;
  /** Features skipped because their whole box was sub-pixel. */
  culled: number;
  /** `fill()` and `stroke()` calls — the request count, near enough. */
  batches: number;
}

function emptyStats(): DrawStats {
  return {
    layers: 0,
    features: 0,
    vertices: 0,
    decimated: 0,
    culled: 0,
    batches: 0,
  };
}

/** A style layer with its filter already compiled — what a cache holds so
 *  the compile happens once per style rather than once per tile. */
export interface PreparedLayer {
  layer: MapStyleLayer;
  filter: CompiledFilter;
}

/** A maximal run of consecutive style layers over one source layer. */
export interface StyleRun {
  sourceLayer: string;
  /** `[from, to)` into {@link PreparedStyle.layers}. */
  from: number;
  to: number;
}

/**
 * A style with its filters compiled and its runs found — computed once per
 * style, not once per tile.
 *
 * The runs are also the unit of **resumable** rasterization: a tile's own
 * layers are drawn run by run, with a time budget between them, so a
 * hundred-millisecond tile becomes a dozen frames that each stay inside
 * one. See {@link drawTileRun}.
 */
export interface PreparedStyle {
  layers: PreparedLayer[];
  runs: StyleRun[];
}

/**
 * Compile a style once.
 *
 * Runs rather than a global grouping by source layer, because the order a
 * style lists its layers in *is* the cartography — water over landuse,
 * buildings over both — and a grouping would reorder a style that
 * interleaves two sources. A run preserves order exactly and captures the
 * win whenever a style is written the way the casing-then-fill split forces
 * anyway: a road network is fourteen consecutive layers over `streets`.
 */
export function prepareStyle(style: {
  layers: readonly MapStyleLayer[];
}): PreparedStyle {
  const layers = style.layers.map((layer) => ({
    layer,
    filter: compileFilter(layer.filter),
  }));
  const runs: StyleRun[] = [];
  let i = 0;
  while (i < layers.length) {
    const sourceLayer = layers[i].layer.sourceLayer;
    let end = i + 1;
    while (
      end < layers.length &&
      layers[end].layer.sourceLayer === sourceLayer
    ) {
      end++;
    }
    runs.push({ sourceLayer, from: i, to: end });
    i = end;
  }
  return { layers, runs };
}

function num(
  value: Zoomed<number> | undefined,
  zoom: number,
  fallback: number,
): number {
  return value === undefined ? fallback : resolveZoomed(value, zoom);
}

function str(
  value: Zoomed<string> | undefined,
  zoom: number,
): string | undefined {
  return value === undefined ? undefined : resolveZoomed(value, zoom);
}

/**
 * Scratch a caller keeps between tiles, so nothing here allocates per
 * feature or per layer.
 */
export class DrawScratch {
  buffer = new GeometryBuffer();
  stats: DrawStats = emptyStats();
  private _buckets: number[][] = [];

  /** `n` index lists, emptied. Grown to the widest run ever seen and then
   *  reused for the life of the element. */
  buckets(n: number): number[][] {
    while (this._buckets.length < n) this._buckets.push([]);
    for (let i = 0; i < n; i++) this._buckets[i].length = 0;
    return this._buckets;
  }

  resetStats(): DrawStats {
    this.stats = emptyStats();
    return this.stats;
  }
}

/** Whether a style layer draws at this zoom at all. */
function activeAt(layer: MapStyleLayer, zoom: number): boolean {
  if (layer.visible === false) return false;
  if (layer.type === 'symbol') return false; // placed and drawn per frame
  if (layer.minZoom !== undefined && zoom < layer.minZoom) return false;
  if (layer.maxZoom !== undefined && zoom >= layer.maxZoom) return false;
  return true;
}

/**
 * Which geometry types a style layer draws.
 *
 * A `line` layer takes polygons too — stroking a ring is what a style
 * asking for a pier's outline means — and a `fill` layer takes only
 * polygons, since there is no area to fill in a line.
 */
function typeAllowed(type: MapStyleLayer['type'], geometry: GeomType): boolean {
  if (type === 'fill') return geometry === GeomType.Polygon;
  if (type === 'circle') return geometry === GeomType.Point;
  if (type === 'line') return geometry !== GeomType.Point;
  return false;
}

/**
 * Draw every layer of the style this tile has data for.
 *
 * The style is walked in **runs of consecutive layers over one source
 * layer**, and each run's features are seeked once for the whole run. That
 * is worth stating plainly because it is the difference between a fast
 * zoom-12 tile and a slow one: a road network is fourteen style layers over
 * `streets` (seven classes, and a casing pass before the fill pass so that
 * junctions knit), so a layer-at-a-time walk parses each of eight thousand
 * features' headers and tags fourteen times over. A run parses them once
 * and asks fourteen already-compiled filters about them.
 *
 * Runs rather than a global grouping by source layer, because the order a
 * style lists its layers in *is* the cartography — water over landuse,
 * buildings over both — and a grouping would reorder a style that
 * interleaves. A run preserves order exactly and captures the win whenever
 * a style is written the way the casing/fill split forces anyway.
 */
export function drawTileLayers(
  ctx: MapCanvas,
  tile: VectorTile,
  prepared: PreparedStyle,
  draw: TileDraw,
  scratch: DrawScratch,
): DrawStats {
  for (let run = 0; run < prepared.runs.length; run++) {
    drawTileRun(ctx, tile, prepared, run, draw, scratch);
  }
  return scratch.stats;
}

/**
 * One run of the style, drawn.
 *
 * The unit a caller budgets in: the node draws runs until its per-frame
 * budget is spent, remembers where it stopped, and comes back next frame.
 * Layers are painted bottom-up, so a tile stopped part-way looks like a map
 * whose upper layers have not arrived — which is what a partly-drawn map
 * should look like — rather than like a hole.
 */
export function drawTileRun(
  ctx: MapCanvas,
  tile: VectorTile,
  prepared: PreparedStyle,
  runIndex: number,
  draw: TileDraw,
  scratch: DrawScratch,
  resume?: {
    /** Skip this many of the run's active layers — where a previous frame
     *  stopped. */
    fromLayer?: number;
    /** Stop after the layer that crosses this, in `Date.now()` terms. */
    deadline?: number;
  },
): number {
  const stats = scratch.stats;
  const run = prepared.runs[runIndex];
  if (!run) return -1;
  const source = tile.layers.get(run.sourceLayer);
  if (!source || source.length === 0) return -1;

  // The zoom gate before anything is touched. A style with forty layers
  // draws eight at a given zoom, and the other thirty-two must not cost a
  // feature walk.
  const active: PreparedLayer[] = [];
  for (let j = run.from; j < run.to; j++) {
    if (activeAt(prepared.layers[j].layer, draw.zoom)) {
      active.push(prepared.layers[j]);
    }
  }
  if (active.length === 0) return -1;
  const from = resume?.fromLayer ?? 0;
  if (from >= active.length) return -1;
  stats.layers += active.length - from;
  const deadline = resume?.deadline;

  if (active.length === 1) {
    // Everything but roads: one layer over the source, so there is nothing
    // to share and no index list to build.
    drawLayer(ctx, source, active[0], draw, scratch, null);
    return -1;
  }
  // Several layers over one source: seek each feature once and ask every
  // filter about it, rather than walking the layer once per style layer.
  // On a zoom-12 tile that is one pass over 8,488 streets instead of
  // fourteen.
  const buckets = scratch.buckets(active.length);
  const cursor = source.feature(0);
  for (let f = 0; f < source.length; f++) {
    source.seek(f, cursor);
    for (let j = from; j < active.length; j++) {
      const { layer, filter } = active[j];
      if (!typeAllowed(layer.type, cursor.type)) continue;
      if (!filter(cursor)) continue;
      buckets[j].push(f);
    }
  }
  // Stopping between layers rather than only between runs, because a run is
  // not a small unit: a road network is one run and fourteen layers, and
  // one of those layers alone measured 90 ms on the profiling corpus. The
  // budget has to be able to interrupt *inside* it or it is not a budget.
  // Resuming re-does the bucketing pass above — one seek over the source
  // layer, a few milliseconds — which is the price of not holding a frame's
  // scratch across frames.
  for (let j = from; j < active.length; j++) {
    drawLayer(ctx, source, active[j], draw, scratch, buckets[j]);
    if (
      deadline !== undefined &&
      j + 1 < active.length &&
      Date.now() >= deadline
    ) {
      return j + 1;
    }
  }
  return -1;
}

function drawLayer(
  ctx: MapCanvas,
  source: VectorTileLayer,
  prepared: PreparedLayer,
  draw: TileDraw,
  scratch: DrawScratch,
  indices: readonly number[] | null,
): void {
  const { layer, filter } = prepared;
  switch (layer.type) {
    case 'fill':
      drawFill(ctx, source, layer, filter, draw, scratch, indices);
      break;
    case 'line':
      drawLine(ctx, source, layer, filter, draw, scratch, indices);
      break;
    case 'circle':
      drawCircle(ctx, source, layer, filter, draw, scratch, indices);
      break;
    case 'symbol':
      break;
  }
}

/**
 * Append one part of a feature to the path, simplified against the target
 * grid, and answer how many vertices were emitted.
 *
 * Two tests, in the order that makes the cheap one do most of the work:
 *
 *  - **radial** — a vertex within `tolerance` of the one last kept lands on
 *    the same pixel, so it says nothing;
 *  - **perpendicular** — a vertex within `tolerance` of the straight line
 *    from the one last kept to the one after it is on that line, so it says
 *    nothing either. This is the one that matters on real data: a
 *    generalized coastline's vertices are about a pixel apart, which the
 *    radial test keeps, and nearly collinear, which this drops.
 *
 * The first and last vertices are always kept: a ring simplified down to
 * its first point is not a ring, and a road whose end moved is a road that
 * no longer meets the next one at the tile seam.
 */
function emitPart(
  ctx: MapCanvas,
  coords: Int32Array,
  from: number,
  to: number,
  ox: number,
  oy: number,
  k: number,
  /** Squared, so the vertex loop needs no square root. */
  toleranceSq: number,
  closed: boolean,
  stats: DrawStats,
): number {
  const count = to - from;
  if (count < 2) return 0;
  let x = ox + coords[from * 2] * k;
  let y = oy + coords[from * 2 + 1] * k;
  ctx.moveTo(x, y);
  let emitted = 1;
  let keptX = x;
  let keptY = y;
  const last = to - 1;
  for (let i = from + 1; i <= last; i++) {
    x = ox + coords[i * 2] * k;
    y = oy + coords[i * 2 + 1] * k;
    if (toleranceSq > 0 && i !== last) {
      const dx = x - keptX;
      const dy = y - keptY;
      if (dx * dx + dy * dy < toleranceSq) {
        stats.decimated++;
        continue;
      }
      const nx = ox + coords[(i + 1) * 2] * k;
      const ny = oy + coords[(i + 1) * 2 + 1] * k;
      const ax = nx - keptX;
      const ay = ny - keptY;
      const lenSq = ax * ax + ay * ay;
      if (lenSq > 0) {
        // The cross product is the parallelogram's area, so its square over
        // `lenSq` is the squared perpendicular distance — compared as a
        // product to keep the division out of the loop.
        const cross = ax * dy - ay * dx;
        if (cross * cross < toleranceSq * lenSq) {
          stats.decimated++;
          continue;
        }
      }
    }
    ctx.lineTo(x, y);
    emitted++;
    keptX = x;
    keptY = y;
  }
  if (closed) ctx.closePath();
  return emitted;
}

/** Whether a part's box is too small to be worth a path. */
function partTooSmall(
  bounds: Float64Array,
  part: number,
  k: number,
  minFeature: number,
): boolean {
  if (minFeature <= 0) return false;
  const at = part * 4;
  return (
    (bounds[at + 2] - bounds[at]) * k < minFeature &&
    (bounds[at + 3] - bounds[at + 1]) * k < minFeature
  );
}

/** Iterate a bucket, or the whole layer applying the filter. Written as a
 *  pair of loops in each drawer rather than a shared generator: a generator
 *  per feature is exactly the allocation this file exists to avoid. */
function featureCount(
  source: VectorTileLayer,
  indices: readonly number[] | null,
): number {
  return indices ? indices.length : source.length;
}

function drawFill(
  ctx: MapCanvas,
  source: VectorTileLayer,
  layer: Extract<MapStyleLayer, { type: 'fill' }>,
  filter: CompiledFilter,
  draw: TileDraw,
  scratch: DrawScratch,
  indices: readonly number[] | null,
): void {
  const stats = scratch.stats;
  const buffer = scratch.buffer;
  const k = draw.span / source.extent;
  const opacity = num(layer.opacity, draw.zoom, 1);
  if (opacity <= 0) return;
  const outline = str(layer.outlineColor, draw.zoom);
  const tol = (draw.tolerance ?? 0) * (draw.tolerance ?? 0);
  const minFeature = draw.minFeature ?? 0;
  const cursor = source.feature(0);
  const total = featureCount(source, indices);
  const batch = draw.batchVertices ?? BATCH_VERTICES;

  ctx.save();
  if (ctx.globalAlpha !== undefined && opacity < 1) ctx.globalAlpha = opacity;
  ctx.fillStyle = resolveZoomed(layer.color, draw.zoom);
  if (outline !== undefined) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = Math.max(1, draw.pixelsPerLogical);
  }
  let pending = 0;
  ctx.beginPath();
  for (let n = 0; n < total; n++) {
    source.seek(indices ? indices[n] : n, cursor);
    if (!indices) {
      if (cursor.type !== GeomType.Polygon) continue;
      if (!filter(cursor)) continue;
    }
    cursor.readGeometry(buffer);
    if (buffer.parts === 0) continue;
    stats.features++;
    for (let part = 0; part < buffer.parts; part++) {
      // Rings go into one path and are filled with the non-zero rule, which
      // is what makes a hole a hole: MVT winds an exterior ring one way and
      // an interior ring the other, so the rule does the work and nothing
      // here pairs them up.
      //
      // Which is exactly why the batch is flushed **only before an exterior
      // ring**. A positive area is a new polygon (the specification's own
      // definition), so that is the one point at which the path so far is a
      // whole number of polygons; flushing between an exterior ring and its
      // interior ones would fill the hole in. This is what `areas` is for.
      const exterior = buffer.areas[part] > 0;
      if (exterior && pending >= batch) {
        ctx.fill();
        if (outline !== undefined) ctx.stroke();
        stats.batches += outline === undefined ? 1 : 2;
        stats.vertices += pending;
        pending = 0;
        ctx.beginPath();
      }
      if (partTooSmall(buffer.partBounds, part, k, minFeature)) {
        stats.culled++;
        continue;
      }
      pending += emitPart(
        ctx,
        buffer.coords,
        buffer.starts[part],
        buffer.starts[part + 1],
        draw.ox,
        draw.oy,
        k,
        tol,
        true,
        stats,
      );
    }
  }
  if (pending > 0) {
    ctx.fill();
    if (outline !== undefined) ctx.stroke();
    stats.batches += outline === undefined ? 1 : 2;
    stats.vertices += pending;
  }
  ctx.restore();
}

function drawLine(
  ctx: MapCanvas,
  source: VectorTileLayer,
  layer: Extract<MapStyleLayer, { type: 'line' }>,
  filter: CompiledFilter,
  draw: TileDraw,
  scratch: DrawScratch,
  indices: readonly number[] | null,
): void {
  const stats = scratch.stats;
  const buffer = scratch.buffer;
  const k = draw.span / source.extent;
  const logical = num(layer.width, draw.zoom, 1);
  if (logical <= 0) return;
  const opacity = num(layer.opacity, draw.zoom, 1);
  if (opacity <= 0) return;
  // A road narrower than a pixel is drawn *at* a pixel rather than dropped:
  // a motorway network that vanishes below zoom 6 is worse than one drawn a
  // little heavy, and every map makes this same choice.
  const width = Math.max(1, logical * draw.pixelsPerLogical);
  const tol = (draw.tolerance ?? 0) * (draw.tolerance ?? 0);
  const minFeature = draw.minFeature ?? 0;
  const cursor = source.feature(0);
  const total = featureCount(source, indices);
  const batch = draw.batchVertices ?? BATCH_VERTICES;

  ctx.save();
  if (ctx.globalAlpha !== undefined && opacity < 1) ctx.globalAlpha = opacity;
  ctx.strokeStyle = resolveZoomed(layer.color, draw.zoom);
  ctx.lineWidth = width;
  if (layer.cap !== undefined) ctx.lineCap = layer.cap;
  if (layer.join !== undefined) ctx.lineJoin = layer.join;
  if (layer.dash && ctx.setLineDash) {
    ctx.setLineDash(layer.dash.map((d) => d * draw.pixelsPerLogical));
  }
  let pending = 0;
  ctx.beginPath();
  for (let n = 0; n < total; n++) {
    source.seek(indices ? indices[n] : n, cursor);
    if (!indices) {
      if (cursor.type === GeomType.Point) continue;
      if (!filter(cursor)) continue;
    }
    cursor.readGeometry(buffer);
    if (buffer.parts === 0) continue;
    stats.features++;
    const closed = cursor.type === GeomType.Polygon;
    for (let part = 0; part < buffer.parts; part++) {
      // Any part boundary is a safe flush point for a stroke: a subpath is
      // stroked independently of every other, so where the path is cut
      // changes nothing about the result. Inside the loop rather than after
      // the feature because the feature that needs it most is a single one
      // — a `land` multipolygon at zoom 8, a `buildings` multipolygon at
      // zoom 14 — with tens of thousands of vertices in it.
      if (pending >= batch) {
        ctx.stroke();
        stats.batches++;
        stats.vertices += pending;
        pending = 0;
        ctx.beginPath();
      }
      if (partTooSmall(buffer.partBounds, part, k, minFeature)) {
        stats.culled++;
        continue;
      }
      pending += emitPart(
        ctx,
        buffer.coords,
        buffer.starts[part],
        buffer.starts[part + 1],
        draw.ox,
        draw.oy,
        k,
        tol,
        closed,
        stats,
      );
    }
  }
  if (pending > 0) {
    ctx.stroke();
    stats.batches++;
    stats.vertices += pending;
  }
  if (layer.dash && ctx.setLineDash) ctx.setLineDash([]);
  ctx.restore();
}

function drawCircle(
  ctx: MapCanvas,
  source: VectorTileLayer,
  layer: Extract<MapStyleLayer, { type: 'circle' }>,
  filter: CompiledFilter,
  draw: TileDraw,
  scratch: DrawScratch,
  indices: readonly number[] | null,
): void {
  const stats = scratch.stats;
  const buffer = scratch.buffer;
  const k = draw.span / source.extent;
  const radius = num(layer.radius, draw.zoom, 3) * draw.pixelsPerLogical;
  if (radius <= 0) return;
  const opacity = num(layer.opacity, draw.zoom, 1);
  if (opacity <= 0) return;
  const stroke = str(layer.strokeColor, draw.zoom);
  const strokeWidth =
    num(layer.strokeWidth, draw.zoom, 1) * draw.pixelsPerLogical;
  const cursor = source.feature(0);
  const total = featureCount(source, indices);
  const discBatch = Math.min(1024, draw.batchVertices ?? BATCH_VERTICES);

  ctx.save();
  if (ctx.globalAlpha !== undefined && opacity < 1) ctx.globalAlpha = opacity;
  ctx.fillStyle = resolveZoomed(layer.color, draw.zoom);
  if (stroke !== undefined) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
  }
  let pending = 0;
  ctx.beginPath();
  for (let n = 0; n < total; n++) {
    source.seek(indices ? indices[n] : n, cursor);
    if (!indices) {
      if (cursor.type !== GeomType.Point) continue;
      if (!filter(cursor)) continue;
    }
    cursor.readGeometry(buffer);
    stats.features++;
    for (let p = 0; p < buffer.points; p++) {
      const x = draw.ox + buffer.coords[p * 2] * k;
      const y = draw.oy + buffer.coords[p * 2 + 1] * k;
      // A fresh subpath per disc: an `arc` continuing from the previous
      // point would join the two with a line.
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      pending++;
    }
    // Discs, not vertices — each is `moveTo` plus an `arc` — so the cap is
    // its own, bounded by the backend's batch preference.
    if (pending >= discBatch) {
      ctx.fill();
      if (stroke !== undefined) ctx.stroke();
      stats.batches += stroke === undefined ? 1 : 2;
      stats.vertices += pending;
      pending = 0;
      ctx.beginPath();
    }
  }
  if (pending > 0) {
    ctx.fill();
    if (stroke !== undefined) ctx.stroke();
    stats.batches += stroke === undefined ? 1 : 2;
    stats.vertices += pending;
  }
  ctx.restore();
}
