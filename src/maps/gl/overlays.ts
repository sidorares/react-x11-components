// The overlays, as the GL renderer draws them: one bucket — the record
// streams a tile's are (`./buckets.ts`), drawn by the same programs — built
// from every overlay on the map, in the order `drawOverlays` draws them.
//
// **An overlay's coordinates are not a tile's.** A tile's are small numbers
// from its own corner, which is why int16 is enough for them at any zoom. An
// overlay is geography with no corner: a route across a city seen at zoom 22
// is a few thousand pixels of line in a world four billion pixels wide, and
// a float32 resolves a position that large to the nearest 512 pixels. So the
// bucket is given a corner — a **region**, a square of the world around the
// view — and its records are int16 from the region's centre, worked out in
// float64 on this thread. Where the region's centre lands is worked out each
// frame, in float64 too and relative to the camera, and reaches the GPU as a
// uniform that is small because the region is near the camera. Nothing large
// is ever a float32, so a vertex holds still under a camera moving by a
// fraction of a pixel at any zoom.
//
// A region holds while the view is inside it and the zoom within a level of
// the one it was built at; past either, the bucket is built again around the
// view. Geometry is clipped to the region, which is what keeps it inside
// int16 — the retained renderer clips to its pane for the same kind of
// reason, XRender's 16.16.
import { clipRing, clipSegment } from '../clip.js';
import type { ClipRect } from '../clip.js';
import { circleSegments, overlayOrder } from '../overlay.js';
import type { MapOverlay, OverlayPalette } from '../overlay.js';
import {
  DEFAULT_TILE_SIZE,
  mercatorXFromLon,
  mercatorYFromLat,
  project,
  worldSize,
} from '../proj.js';
import type { LngLat, MapCamera } from '../proj.js';
import { Stream, pushBreak, pushFillBreak } from './buckets.js';
import type { GlTileData, LayerDraw } from './buckets.js';

/** Units from a region's centre to its edge: int16, clear of the sentinel. */
const REACH = 32000;
/** Logical pixels the view keeps from a region's edge — more than a stroke
 *  is wide, so a clipped end, or an outline along the edge, is never seen. */
const EDGE = 128;

/** A square of the world an overlay bucket is built around. */
export interface OverlayRegion {
  /** Its centre, in mercator. */
  x: number;
  y: number;
  /** Units per mercator unit. */
  k: number;
  /** The zoom it was built at. */
  zoom: number;
  /** The display scale it was built for — what a circle's segments are
   *  counted in. */
  scale: number;
}

/** One draw from the bucket: an overlay's fill, or one of its strokes. */
export interface OverlayPass {
  /** The geometry: an index into the bucket's `draws`. */
  index: number;
  kind: 'fill' | 'stroke';
  /** A stroke of the fill stream — a polygon's or a circle's outline —
   *  rather than of the line stream. */
  outline?: boolean;
  color: string;
  opacity: number;
  /** A stroke's width, in logical pixels. */
  width: number;
  dash?: readonly number[];
}

export interface OverlayBucket {
  data: GlTileData;
  passes: OverlayPass[];
  region: OverlayRegion;
}

const globals = globalThis as { performance?: { now(): number } };
const now = (): number => globals.performance?.now() ?? Date.now();

/**
 * A region around the view: centred on the camera, with room for the pane's
 * diagonal either side — so a view zoomed a level out is still inside it,
 * and a pan has most of a pane to go before the bucket is built again.
 */
export function overlayRegion(
  camera: MapCamera,
  pane: { width: number; height: number },
  scale: number,
): OverlayRegion {
  const centre = project(camera.center);
  const world = worldSize(camera.zoom, DEFAULT_TILE_SIZE);
  const reach = Math.max(1024, Math.hypot(pane.width, pane.height) + 2 * EDGE);
  return {
    x: centre.x,
    y: centre.y,
    k: (REACH * world) / reach,
    zoom: camera.zoom,
    scale,
  };
}

/** Whether a region still serves a view: the zoom within a level of its
 *  own, the scale its own, and the view inside it with room to spare. */
export function regionHolds(
  region: OverlayRegion,
  camera: MapCamera,
  pane: { width: number; height: number },
  scale: number,
): boolean {
  if (scale !== region.scale) return false;
  if (Math.abs(camera.zoom - region.zoom) > 1) return false;
  const centre = project(camera.center);
  let dx = centre.x - region.x;
  dx -= Math.round(dx);
  const perPixel = region.k / worldSize(camera.zoom, DEFAULT_TILE_SIZE);
  const x = Math.abs(dx * region.k) + (pane.width / 2 + EDGE) * perPixel;
  const y =
    Math.abs((centre.y - region.y) * region.k) +
    (pane.height / 2 + EDGE) * perPixel;
  return x <= REACH && y <= REACH;
}

/**
 * Where a region lands this frame: device pixels per unit, and its centre
 * in device pixels — in float64, from the camera, which is what keeps both
 * small enough for the float32s they become.
 */
export function regionPlacement(
  region: OverlayRegion,
  camera: MapCamera,
  width: number,
  height: number,
  scale: number,
): { unit: number; x: number; y: number } {
  const centre = project(camera.center);
  const world = worldSize(camera.zoom, DEFAULT_TILE_SIZE) * scale;
  let dx = region.x - centre.x;
  dx -= Math.round(dx);
  return {
    unit: world / region.k,
    x: dx * world + width / 2,
    y: (region.y - centre.y) * world + height / 2,
  };
}

/**
 * The bucket for a map's overlays, around a region: each overlay's geometry
 * once, in `drawOverlays`' order, and the passes that draw it — a line's
 * casing and then the line; a polygon's or a circle's fill and then its
 * outline. Colours an overlay does not name are the palette's.
 */
export function buildOverlayBucket(
  overlays: readonly MapOverlay[],
  region: OverlayRegion,
  palette: OverlayPalette,
): OverlayBucket {
  const started = now();
  const line = new Stream(256);
  const fill = new Stream(256);
  const draws: LayerDraw[] = [];
  const passes: OverlayPass[] = [];
  const clip: ClipRect = {
    minX: -REACH,
    minY: -REACH,
    maxX: REACH,
    maxY: REACH,
  };
  // Region units, from its centre — on the copy of the world nearest it, as
  // `projectLngLat` takes the copy nearest the camera.
  const units = (path: readonly LngLat[]): number[] => {
    const out: number[] = [];
    for (const position of path) {
      let x = mercatorXFromLon(position.lon) - region.x;
      x -= Math.round(x);
      const y = mercatorYFromLat(position.lat) - region.y;
      out.push(x * region.k, y * region.k);
    }
    return out;
  };
  for (const overlay of overlayOrder(overlays)) {
    const opacity = overlay.opacity ?? 1;
    if (opacity <= 0) continue;
    const index = draws.length;
    if (overlay.kind === 'line') {
      const first = line.count;
      emitPath(line, units(overlay.path), clip);
      if (line.count === first) continue;
      draws.push({
        layer: index,
        kind: 'line',
        ranges: [first, line.count - first],
      });
      const width = overlay.width ?? 3;
      if (overlay.casing !== undefined) {
        passes.push({
          index,
          kind: 'stroke',
          color: overlay.casing,
          opacity,
          width: Math.max(width + 2, overlay.casingWidth ?? 0),
        });
      }
      passes.push({
        index,
        kind: 'stroke',
        color: overlay.color ?? palette.accent,
        opacity,
        width,
        dash: overlay.dash,
      });
      continue;
    }
    const rings =
      overlay.kind === 'polygon'
        ? overlay.rings.map(units)
        : circleRing(overlay, region);
    const first = fill.count;
    for (const ring of rings) emitRing(fill, clipRing(ring, clip));
    if (fill.count === first) continue;
    draws.push({
      layer: index,
      kind: 'fill',
      ranges: [first, fill.count - first],
    });
    passes.push({
      index,
      kind: 'fill',
      color: overlay.fill ?? palette.accent,
      opacity,
      width: 0,
    });
    if (overlay.outline !== undefined) {
      passes.push({
        index,
        kind: 'stroke',
        outline: true,
        color: overlay.outline,
        opacity,
        width: overlay.outlineWidth ?? 1,
      });
    }
  }
  return {
    data: {
      line: line.take(),
      lineRecords: line.count,
      fill: fill.take(),
      fillRecords: fill.count,
      draws,
      stats: {
        features: overlays.length,
        lineRecords: line.count,
        fillRecords: fill.count,
        groups: 0,
        ms: now() - started,
      },
    },
    passes,
    region,
  };
}

/**
 * A circle as a ring, in region units: `drawOverlays`' radius — from the
 * projection a hundredth of a degree north of the centre — and as many
 * segments as the largest it is drawn at while the region holds, a level
 * in, needs to keep its sagitta under half a pixel.
 */
function circleRing(
  overlay: Extract<MapOverlay, { kind: 'circle' }>,
  region: OverlayRegion,
): number[][] {
  const lat = overlay.center.lat;
  const cy = mercatorYFromLat(lat);
  const north = mercatorYFromLat(Math.min(85, lat + 0.01));
  const radius =
    (overlay.radiusMetres * Math.abs(cy - north)) / (0.01 * 111_319.9);
  const pixels =
    radius * worldSize(region.zoom + 1, DEFAULT_TILE_SIZE) * region.scale;
  if (!(pixels > 0.5)) return [];
  const segments = circleSegments(pixels);
  let x = mercatorXFromLon(overlay.center.lon) - region.x;
  x -= Math.round(x);
  const y = cy - region.y;
  const ring: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    ring.push(
      (x + Math.cos(angle) * radius) * region.k,
      (y + Math.sin(angle) * radius) * region.k,
    );
  }
  return [ring];
}

const int16 = (v: number): number => {
  const s = Math.round(v);
  return s < -32767 ? -32767 : s > 32767 ? 32767 : s;
};

function record(line: Stream, x: number, y: number, dist: number): void {
  line.reserve(1);
  const at = line.count;
  line.i16[at * 4] = int16(x);
  line.i16[at * 4 + 1] = int16(y);
  line.f32[at * 2 + 1] = dist;
  line.count++;
}

function endLine(line: Stream): void {
  line.reserve(1);
  pushBreak(line);
}

/**
 * A path's pieces inside the clip, as polylines each ended by a sentinel.
 * `dist` is measured along the whole path, clipped or not, so a dash
 * pattern stays where it is on the ground when the region moves.
 */
function emitPath(
  line: Stream,
  points: readonly number[],
  clip: ClipRect,
): void {
  let along = 0;
  let open = false;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const x0 = points[i];
    const y0 = points[i + 1];
    const x1 = points[i + 2];
    const y1 = points[i + 3];
    const piece = clipSegment(x0, y0, x1, y1, clip);
    if (piece) {
      const [a, b, c, d] = piece;
      if (!open) {
        record(line, a, b, along + Math.hypot(a - x0, b - y0));
        open = true;
      }
      record(line, c, d, along + Math.hypot(c - x0, d - y0));
      // Cut short at its far end: the next piece is a new polyline.
      if (c !== x1 || d !== y1) {
        endLine(line);
        open = false;
      }
    } else if (open) {
      endLine(line);
      open = false;
    }
    along += Math.hypot(x1 - x0, y1 - y0);
  }
  if (open) endLine(line);
}

/** A ring as a fan, as `./buckets.ts` writes one: its points, closed, each
 *  carrying the first as the fan's apex, then a sentinel. */
function emitRing(fill: Stream, ring: readonly number[]): void {
  const n = ring.length >> 1;
  if (n < 3) return;
  fill.reserve(n + 2);
  const i16 = fill.i16;
  const ax = int16(ring[0]);
  const ay = int16(ring[1]);
  let at = fill.count * 4;
  for (let i = 0; i < n; i++) {
    i16[at] = int16(ring[i * 2]);
    i16[at + 1] = int16(ring[i * 2 + 1]);
    i16[at + 2] = ax;
    i16[at + 3] = ay;
    at += 4;
  }
  i16[at] = ax;
  i16[at + 1] = ay;
  i16[at + 2] = ax;
  i16[at + 3] = ay;
  fill.count += n + 1;
  pushFillBreak(fill);
}
