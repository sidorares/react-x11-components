// Labels: collected from the symbol layers, placed against each other, and
// drawn into the frame.
//
// Not into the tile surfaces, and the three reasons are each a visible bug
// if it is done the other way. **Collision is global**: two labels in
// different tiles overlap exactly as readily as two in one, so a per-tile
// placement produces clutter at every seam. **Text must not be scaled**: a
// tile surface is composited at up to 2× during a fractional zoom, and text
// is the one thing on a map nobody accepts blurred. And a tile's labels
// would be **clipped at its edge**, which is where half of them sit.
//
// The placement itself is done in **world pixels** rather than screen
// pixels, and that is the load-bearing decision in this file. A placement
// computed against the viewport changes whenever the viewport does, so a
// pan would have to repaint the whole pane rather than blit it — and a
// label that was suppressed by a neighbour would pop in as that neighbour
// scrolled away. Placed in world pixels, whether a label wins depends only
// on the labels near it and the zoom, so a pan is a translation of a
// placement that is already correct, and the blit stands.
import type { MapCanvas } from './paint.js';
import { GeomType, GeometryBuffer } from './mvt.js';
import type { VectorTile } from './mvt.js';
import type { PreparedStyle, PreparedLayer } from './paint.js';
import { resolveZoomed } from './style.js';
import type { SymbolLayer, Zoomed } from './style.js';
import type { TileId, Transform } from './proj.js';
import { tileCountAt, tileKey } from './proj.js';

/** ntk's font cache, structurally — the same slice `src/flow/draw.ts`
 *  names, for the same reason. */
export interface FontsLike {
  layout(
    content: string,
    style: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): {
    width: number;
    height: number;
    draw(ctx: unknown, x: number, y: number): void;
  };
}

/** One shaped string, kept between frames. Shaping is the expensive half of
 *  drawing text and a label does not change between frames. */
export interface ShapedLabel {
  width: number;
  height: number;
  layout: { draw(ctx: unknown, x: number, y: number): void };
}

/**
 * A label that could be drawn.
 *
 * `mx`/`my` are normalized mercator, so a candidate outlives every camera
 * move — it is a property of the data, and collected once per tile per
 * zoom.
 */
export interface LabelCandidate {
  /** Stable for the life of the tile, which is what lets a placement be
   *  compared frame to frame. */
  id: string;
  /** `layer|text` — what the repeat-distance rule counts as "the same
   *  label". Keyed on the layer as well as the text so that a street and a
   *  place of the same name do not suppress each other. */
  key: string;
  text: string;
  mx: number;
  my: number;
  /** Layer-wide priority; higher wins a collision. */
  rank: number;
  /** Logical pixels. */
  size: number;
  color: string;
  halo: string | undefined;
  haloWidth: number;
  /** Pixels within which this text may not repeat. */
  repeat: number;
}

/** A candidate that won its place, with the box it occupies in world
 *  pixels at the zoom it was placed for. */
export interface PlacedLabel extends LabelCandidate {
  /** World pixels: `mercator × worldSize`. */
  wx: number;
  wy: number;
  width: number;
  height: number;
  shaped: ShapedLabel;
}

function num<T extends number>(
  value: Zoomed<T> | undefined,
  zoom: number,
  fallback: number,
): number {
  return value === undefined ? fallback : resolveZoomed(value, zoom);
}

/**
 * The label candidates one tile contributes.
 *
 * Point geometry anchors at the point. Line and polygon geometry anchor at
 * the **midpoint of the longest part** — which is not a true label
 * placement (a street name should follow its street, and a country name
 * should sit at the pole of inaccessibility of its border) but is the
 * anchor those two would start from, and is right often enough to be worth
 * having while line placement is unwritten. See `docs/prd-maps.md`.
 */
export function collectLabels(
  tile: VectorTile,
  id: TileId,
  prepared: PreparedStyle,
  zoom: number,
  buffer: GeometryBuffer,
): LabelCandidate[] {
  const out: LabelCandidate[] = [];
  const n = tileCountAt(id.z);
  const key = tileKey(id);
  for (let i = 0; i < prepared.layers.length; i++) {
    const { layer, filter } = prepared.layers[i];
    if (layer.type !== 'symbol' || layer.visible === false) continue;
    if (layer.minZoom !== undefined && zoom < layer.minZoom) continue;
    if (layer.maxZoom !== undefined && zoom >= layer.maxZoom) continue;
    const source = tile.layers.get(layer.sourceLayer);
    if (!source || source.length === 0) continue;
    const symbol = layer as SymbolLayer;
    const size = num(symbol.textSize, zoom, 12);
    const color = symbol.textColor
      ? resolveZoomed(symbol.textColor, zoom)
      : '#000000';
    const halo = symbol.textHaloColor
      ? resolveZoomed(symbol.textHaloColor, zoom)
      : undefined;
    const haloWidth = num(symbol.textHaloWidth, zoom, 1);
    const rank = symbol.rank ?? 0;
    const repeat = symbol.repeatDistance ?? 250;
    const extent = source.extent;
    const cursor = source.feature(0);
    for (let f = 0; f < source.length; f++) {
      source.seek(f, cursor);
      if (!filter(cursor)) continue;
      const raw = cursor.get(symbol.textField);
      // The schema's fallback: a translated name field is absent for most
      // features, and the local `name` is what a map without a translation
      // shows rather than nothing.
      const text =
        typeof raw === 'string' && raw.length > 0
          ? raw
          : symbol.textField !== 'name'
            ? typeof cursor.get('name') === 'string'
              ? String(cursor.get('name'))
              : ''
            : '';
      if (text.length === 0) continue;
      cursor.readGeometry(buffer);
      const anchor = anchorOf(buffer, cursor.type);
      if (!anchor) continue;
      out.push({
        id: `${key}:${layer.id}:${f}`,
        key: `${layer.id}|${text}`,
        text,
        // Tile-local to normalized mercator, the same arithmetic the
        // rasterizer's transform does and for the same precision reason.
        mx: (id.x + anchor.x / extent) / n,
        my: (id.y + anchor.y / extent) / n,
        rank,
        size,
        color,
        halo,
        haloWidth,
        repeat,
      });
    }
  }
  return out;
}

function anchorOf(
  buffer: GeometryBuffer,
  type: GeomType,
): { x: number; y: number } | null {
  if (buffer.points === 0) return null;
  if (type === GeomType.Point) {
    return { x: buffer.coords[0], y: buffer.coords[1] };
  }
  // The longest part, by its box — a cheap stand-in for arc length that
  // does not need a second pass over the vertices.
  let best = 0;
  let bestSpan = -1;
  for (let part = 0; part < buffer.parts; part++) {
    const at = part * 4;
    const span =
      buffer.partBounds[at + 2] -
      buffer.partBounds[at] +
      (buffer.partBounds[at + 3] - buffer.partBounds[at + 1]);
    if (span > bestSpan) {
      bestSpan = span;
      best = part;
    }
  }
  const from = buffer.starts[best];
  const to = buffer.starts[best + 1];
  if (to <= from) return null;
  const mid = from + ((to - from) >> 1);
  return { x: buffer.coords[mid * 2], y: buffer.coords[mid * 2 + 1] };
}

/** Cache of shaped strings, owned by the element. */
export class LabelShaper {
  private readonly _cache = new Map<string, ShapedLabel>();
  private _fonts: FontsLike | null;
  private _family: string;
  /** Device pixels per logical pixel. Text is shaped at the device size the
   *  panel wants, exactly as core shapes a `<text>` — a label on a retina
   *  screen is sharper, not bigger. */
  private _scale: number;

  constructor(fonts: FontsLike | null, family: string, scale: number) {
    this._fonts = fonts;
    this._family = family;
    this._scale = scale;
  }

  /** Re-point at a new font manager, face or scale, dropping what was
   *  shaped for the old one. */
  reconfigure(fonts: FontsLike | null, family: string, scale: number): void {
    if (
      this._fonts === fonts &&
      this._family === family &&
      this._scale === scale
    ) {
      return;
    }
    this._fonts = fonts;
    this._family = family;
    this._scale = scale;
    this._cache.clear();
  }

  /** Shape one label, or null on a backend with no font manager. Widths
   *  come back in **logical** pixels, which is what placement is in. */
  shape(text: string, size: number, color: string): ShapedLabel | null {
    const fonts = this._fonts;
    if (!fonts) return null;
    const key = `${this._family}|${size}|${color}|${text}`;
    const hit = this._cache.get(key);
    if (hit) return hit;
    // Bounded, so a map panned across a continent cannot turn the cache
    // into a leak. Cleared wholesale rather than evicted one at a time: the
    // labels on screen are re-shaped on the next frame and the cost of that
    // is a few hundred strings once.
    if (this._cache.size > 4000) this._cache.clear();
    const layout = fonts.layout(text, {
      family: this._family,
      size: size * this._scale,
      weight: 400,
      style: 'normal',
      color,
    });
    const shaped: ShapedLabel = {
      width: layout.width / this._scale,
      height: layout.height / this._scale,
      layout,
    };
    this._cache.set(key, shaped);
    return shaped;
  }
}

/**
 * Place candidates against each other, in world pixels.
 *
 * Greedy by rank, which is what every map does: sort, and take a label if
 * nothing already taken overlaps it. The order has to be **total and
 * stable** — rank, then the candidate's id — because a tie broken by array
 * order would flicker as tiles arrived in a different order.
 */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  worldSize: number,
  shaper: LabelShaper,
  options?: { padding?: number },
): PlacedLabel[] {
  const padding = options?.padding ?? 2;
  const sorted = [...candidates].sort(
    (a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const placed: PlacedLabel[] = [];
  // A sparse grid over world pixels. The cell is sized for the labels
  // themselves, so a box touches one or two cells and a collision test is a
  // handful of comparisons rather than a scan of everything placed.
  const CELL = 64;
  const grid = new Map<number, PlacedLabel[]>();
  const cellKey = (cx: number, cy: number): number => cx * 0x40000 + cy;
  /** Where each distinct text has already been placed, for the
   *  repeat-distance rule. */
  const byText = new Map<string, { wx: number; wy: number }[]>();

  for (const candidate of sorted) {
    const shaped = shaper.shape(
      candidate.text,
      candidate.size,
      candidate.color,
    );
    if (!shaped) return placed; // no font manager: nothing can be measured
    const wx = candidate.mx * worldSize;
    const wy = candidate.my * worldSize;
    // The repeat test before the overlap test, because it is the cheaper
    // one and because it is what rejects most of a street layer: a street
    // is one feature per segment, so the same name arrives a dozen times
    // strung out along the road, none of them overlapping any other.
    if (candidate.repeat > 0) {
      const already = byText.get(candidate.key);
      if (already) {
        const limit = candidate.repeat * candidate.repeat;
        let tooClose = false;
        for (const at of already) {
          const dx = at.wx - wx;
          const dy = at.wy - wy;
          if (dx * dx + dy * dy < limit) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
      }
    }
    const width = shaped.width + padding * 2;
    const height = shaped.height + padding * 2;
    const left = wx - width / 2;
    const top = wy - height / 2;
    const x0 = Math.floor(left / CELL);
    const x1 = Math.floor((left + width) / CELL);
    const y0 = Math.floor(top / CELL);
    const y1 = Math.floor((top + height) / CELL);
    let free = true;
    for (let cx = x0; cx <= x1 && free; cx++) {
      for (let cy = y0; cy <= y1 && free; cy++) {
        const bucket = grid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const other of bucket) {
          if (
            left < other.wx - other.width / 2 + other.width &&
            left + width > other.wx - other.width / 2 &&
            top < other.wy - other.height / 2 + other.height &&
            top + height > other.wy - other.height / 2
          ) {
            free = false;
            break;
          }
        }
      }
    }
    if (!free) continue;
    const entry: PlacedLabel = {
      ...candidate,
      wx,
      wy,
      width,
      height,
      shaped,
    };
    placed.push(entry);
    if (candidate.repeat > 0) {
      const already = byText.get(candidate.key);
      if (already) already.push({ wx, wy });
      else byText.set(candidate.key, [{ wx, wy }]);
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const at = cellKey(cx, cy);
        const bucket = grid.get(at);
        if (bucket) bucket.push(entry);
        else grid.set(at, [entry]);
      }
    }
  }
  return placed;
}

/**
 * Draw the placed labels that land in the pane.
 *
 * The halo is the same string shaped a second time in the halo colour and
 * drawn four times around the glyphs, rather than a real outline: ntk has
 * no glyph-outline stroke, and both runs are cached, so a label costs five
 * composites of two shaped runs. That is cheap for the few dozen labels a
 * pane holds and it is the difference between a place name that is
 * readable over a motorway and one that is not.
 */
export function drawLabels(
  ctx: MapCanvas,
  placed: readonly PlacedLabel[],
  transform: Transform,
  pane: { x: number; y: number; width: number; height: number },
  scale: number,
  clip: { x: number; y: number; width: number; height: number } | null,
  shaper: LabelShaper,
): number {
  let drawn = 0;
  const world = transform.world;
  const originX = pane.x + transform.paneX - transform.centerX * world;
  const originY = pane.y + transform.paneY - transform.centerY * world;
  for (const label of placed) {
    const x = originX + label.wx - label.shaped.width / 2;
    const y = originY + label.wy - label.shaped.height / 2;
    if (
      x + label.shaped.width < pane.x ||
      y + label.shaped.height < pane.y ||
      x > pane.x + pane.width ||
      y > pane.y + pane.height
    ) {
      continue;
    }
    if (
      clip &&
      (x + label.shaped.width < clip.x ||
        y + label.shaped.height < clip.y ||
        x > clip.x + clip.width ||
        y > clip.y + clip.height)
    ) {
      continue;
    }
    const dx = Math.round(x * scale);
    const dy = Math.round(y * scale);
    if (label.halo !== undefined && label.haloWidth > 0) {
      const halo = shaper.shape(label.text, label.size, label.halo);
      if (halo) {
        const offset = Math.max(1, Math.round(label.haloWidth * scale));
        halo.layout.draw(ctx, dx - offset, dy);
        halo.layout.draw(ctx, dx + offset, dy);
        halo.layout.draw(ctx, dx, dy - offset);
        halo.layout.draw(ctx, dx, dy + offset);
      }
    }
    label.shaped.layout.draw(ctx, dx, dy);
    drawn++;
  }
  return drawn;
}

export type { PreparedLayer };
