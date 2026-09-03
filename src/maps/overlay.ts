// What the application puts on the map: markers, and the lines, areas and
// circles that carry a route, a traffic segment, a transit shape or a
// GeoJSON layer.
//
// All of it is drawn **into the frame**, not into a tile surface, for the
// reason the labels are: it is application state that changes on its own
// clock, and baking it into a tile would mean re-rasterizing a tile every
// time a vehicle moved. It rides the pan blit like everything else on the
// map, because it is anchored to geography.
//
// The vocabulary is deliberately small and deliberately geometric — a line
// is a line whether it came from a routing engine, a GTFS shape or a
// traffic feed — with the format adapters ({@link decodePolyline},
// {@link geoJsonOverlays}) kept as pure functions beside it rather than as
// props of the map. `docs/prd-maps.md` surveys what the real feeds look
// like and why this is the shape they all reduce to.
import type { MapCanvas } from './paint.js';
import { projectLngLat } from './proj.js';
import type { LngLat, Transform } from './proj.js';

/** A point on the map the user can click. */
export interface MapMarker {
  /** Stable across renders — what an event names and what a hit test
   *  returns. */
  id: string;
  position: LngLat;
  /** `'pin'` (the default) stands on its position; `'circle'` is centred on
   *  it. A pin is what a place wants and a circle is what a vehicle or a
   *  measurement wants. */
  shape?: 'pin' | 'circle';
  /** Logical pixels: a pin's width, a circle's diameter. 14 by default. */
  size?: number;
  /** Fill. The theme's accent by default. */
  color?: string;
  /** The ring around it, so a marker stays visible on any basemap. The
   *  theme's background by default. */
  outline?: string;
  /** Drawn above unselected markers, and given the selected ring. */
  selected?: boolean;
  /** Higher draws later. Ties break on array order. */
  zIndex?: number;
  /** Skipped by hit testing — for a marker that is decoration. */
  interactive?: boolean;
  /** Announced by a screen reader, and shown by an application's own
   *  tooltip. */
  title?: string;
  /** Handed back on an event. Never read here. */
  data?: unknown;
}

/** Anything else drawn over the basemap. */
export type MapOverlay =
  | {
      kind: 'line';
      id: string;
      path: readonly LngLat[];
      color?: string;
      /** Logical pixels. 3 by default. */
      width?: number;
      opacity?: number;
      dash?: readonly number[];
      cap?: 'butt' | 'round' | 'square';
      join?: 'miter' | 'round' | 'bevel';
      /** A second, wider stroke under the first — what makes a route
       *  readable over a road of the same colour. */
      casing?: string;
      casingWidth?: number;
      zIndex?: number;
      data?: unknown;
    }
  | {
      kind: 'polygon';
      id: string;
      /** Exterior ring first; every ring after it is a hole. */
      rings: readonly (readonly LngLat[])[];
      fill?: string;
      opacity?: number;
      outline?: string;
      outlineWidth?: number;
      zIndex?: number;
      data?: unknown;
    }
  | {
      kind: 'circle';
      id: string;
      center: LngLat;
      /** Ground metres, so the circle grows with the zoom the way a real
       *  radius does — an accuracy ring, a catchment, a geofence. */
      radiusMetres: number;
      fill?: string;
      opacity?: number;
      outline?: string;
      outlineWidth?: number;
      zIndex?: number;
      data?: unknown;
    };

/** Colours an overlay falls back to, from the theme. */
export interface OverlayPalette {
  accent: string;
  background: string;
  text: string;
}

function byZ<T extends { zIndex?: number }>(items: readonly T[]): T[] {
  // A stable sort — the language guarantees it — so items with no `zIndex`
  // keep the order the application listed them in.
  return [...items].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
}

/**
 * Draw the overlays.
 *
 * Under the markers, because a marker is a thing the user aims at and an
 * overlay is context for it.
 */
export function drawOverlays(
  ctx: MapCanvas,
  overlays: readonly MapOverlay[],
  transform: Transform,
  pane: { x: number; y: number },
  scale: number,
  palette: OverlayPalette,
): void {
  for (const overlay of byZ(overlays)) {
    const opacity = overlay.opacity ?? 1;
    if (opacity <= 0) continue;
    ctx.save();
    if (ctx.globalAlpha !== undefined && opacity < 1) ctx.globalAlpha = opacity;
    if (overlay.kind === 'line') {
      const width = (overlay.width ?? 3) * scale;
      if (overlay.casing !== undefined) {
        ctx.strokeStyle = overlay.casing;
        ctx.lineWidth = Math.max(
          width + 2 * scale,
          (overlay.casingWidth ?? 0) * scale,
        );
        ctx.lineCap = overlay.cap ?? 'round';
        ctx.lineJoin = overlay.join ?? 'round';
        strokePath(ctx, overlay.path, transform, pane, scale);
      }
      ctx.strokeStyle = overlay.color ?? palette.accent;
      ctx.lineWidth = width;
      ctx.lineCap = overlay.cap ?? 'round';
      ctx.lineJoin = overlay.join ?? 'round';
      if (overlay.dash && ctx.setLineDash) {
        ctx.setLineDash(overlay.dash.map((d) => d * scale));
      }
      strokePath(ctx, overlay.path, transform, pane, scale);
      if (overlay.dash && ctx.setLineDash) ctx.setLineDash([]);
    } else if (overlay.kind === 'polygon') {
      ctx.beginPath();
      for (const ring of overlay.rings)
        appendPath(ctx, ring, transform, pane, scale, true);
      ctx.fillStyle = overlay.fill ?? palette.accent;
      ctx.fill();
      if (overlay.outline !== undefined) {
        ctx.strokeStyle = overlay.outline;
        ctx.lineWidth = (overlay.outlineWidth ?? 1) * scale;
        ctx.stroke();
      }
    } else {
      // A circle in ground metres is an ellipse on a Mercator map, and at
      // the sizes an application draws one it is close enough to a circle
      // that the difference is under a pixel — except near the poles, where
      // it is not. So the radius is computed from the *projection* rather
      // than from a metres-per-pixel constant: one degree of latitude
      // either side of the centre, projected, is exactly the scale factor
      // this circle should be drawn at.
      const centre = projectLngLat(transform, overlay.center);
      const north = projectLngLat(transform, {
        lon: overlay.center.lon,
        lat: Math.min(85, overlay.center.lat + 0.01),
      });
      const metresPerDegree = 111_319.9;
      const pixelsPerMetre =
        Math.abs(centre.y - north.y) / (0.01 * metresPerDegree);
      const radius = overlay.radiusMetres * pixelsPerMetre * scale;
      if (radius > 0.5) {
        ctx.beginPath();
        const cx = (pane.x + centre.x) * scale;
        const cy = (pane.y + centre.y) * scale;
        ctx.moveTo(cx + radius, cy);
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = overlay.fill ?? palette.accent;
        ctx.fill();
        if (overlay.outline !== undefined) {
          ctx.strokeStyle = overlay.outline;
          ctx.lineWidth = (overlay.outlineWidth ?? 1) * scale;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}

function appendPath(
  ctx: MapCanvas,
  path: readonly LngLat[],
  transform: Transform,
  pane: { x: number; y: number },
  scale: number,
  close: boolean,
): void {
  for (let i = 0; i < path.length; i++) {
    const point = projectLngLat(transform, path[i]);
    const x = (pane.x + point.x) * scale;
    const y = (pane.y + point.y) * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  if (close && path.length > 0) ctx.closePath();
}

function strokePath(
  ctx: MapCanvas,
  path: readonly LngLat[],
  transform: Transform,
  pane: { x: number; y: number },
  scale: number,
): void {
  if (path.length < 2) return;
  ctx.beginPath();
  appendPath(ctx, path, transform, pane, scale, false);
  ctx.stroke();
}

/** Where a marker's ink lands, in pane-local logical pixels. Shared by the
 *  drawing and the hit test, so the two cannot disagree — the bug that
 *  makes a marker unclickable a few pixels from where it looks. */
export function markerRect(
  marker: MapMarker,
  transform: Transform,
): {
  x: number;
  y: number;
  width: number;
  height: number;
  tipX: number;
  tipY: number;
} {
  const point = projectLngLat(transform, marker.position);
  const size = marker.size ?? 14;
  if ((marker.shape ?? 'pin') === 'circle') {
    return {
      x: point.x - size / 2,
      y: point.y - size / 2,
      width: size,
      height: size,
      tipX: point.x,
      tipY: point.y,
    };
  }
  // A pin *stands on* its position: the point is the tip, and the head is
  // above it. Getting this the other way round puts every marker half its
  // own height north of where it belongs, which on a city map is a street.
  const height = size * 1.4;
  return {
    x: point.x - size / 2,
    y: point.y - height,
    width: size,
    height,
    tipX: point.x,
    tipY: point.y,
  };
}

/** Draw the markers, lowest `zIndex` first. */
export function drawMarkers(
  ctx: MapCanvas,
  markers: readonly MapMarker[],
  transform: Transform,
  pane: { x: number; y: number; width: number; height: number },
  scale: number,
  palette: OverlayPalette,
): number {
  let drawn = 0;
  for (const marker of byZ(markers)) {
    const rect = markerRect(marker, transform);
    if (
      rect.x + rect.width < 0 ||
      rect.y + rect.height < 0 ||
      rect.x > pane.width ||
      rect.y > pane.height
    ) {
      continue;
    }
    const size = marker.size ?? 14;
    const fill = marker.color ?? palette.accent;
    const ring = marker.outline ?? palette.background;
    const x = (pane.x + rect.tipX) * scale;
    const y = (pane.y + rect.tipY) * scale;
    const r = (size / 2) * scale;
    ctx.save();
    ctx.lineWidth = Math.max(1, (marker.selected ? 2.5 : 1.5) * scale);
    ctx.strokeStyle = marker.selected ? palette.text : ring;
    ctx.fillStyle = fill;
    if ((marker.shape ?? 'pin') === 'circle') {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      // A teardrop: a circle for the head and two lines down to the tip.
      // The tangent angle is where the straight sides meet the circle, so
      // the outline is smooth rather than two lines crossing an arc.
      const cy = y - size * 1.4 * scale + r;
      const d = y - cy;
      const angle = Math.asin(Math.min(1, r / d));
      ctx.beginPath();
      ctx.arc(x, cy, r, Math.PI / 2 + angle, Math.PI / 2 - angle);
      ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    drawn++;
  }
  return drawn;
}

/** The marker under a pane-local logical point, topmost first, or null. */
export function markerAt(
  markers: readonly MapMarker[],
  transform: Transform,
  x: number,
  y: number,
  slop = 2,
): MapMarker | null {
  const ordered = byZ(markers);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const marker = ordered[i];
    if (marker.interactive === false) continue;
    const rect = markerRect(marker, transform);
    if (
      x >= rect.x - slop &&
      x <= rect.x + rect.width + slop &&
      y >= rect.y - slop &&
      y <= rect.y + rect.height + slop
    ) {
      return marker;
    }
  }
  return null;
}

/**
 * Decode Google's Encoded Polyline Algorithm Format.
 *
 * Here because it is what every routing engine on the open web answers
 * with — Google Directions, OSRM, Valhalla, GraphHopper, Mapbox Directions
 * — so a route arrives as one of these strings far more often than as
 * GeoJSON. `precision` is 5 for Google and OSRM's default, 6 for Valhalla
 * and OSRM's `polyline6`; passing the wrong one puts the route in the
 * Atlantic, which is the standard way to discover this.
 */
export function decodePolyline(encoded: string, precision = 5): LngLat[] {
  const factor = Math.pow(10, precision);
  const out: LngLat[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    out.push({ lat: lat / factor, lon: lon / factor });
  }
  return out;
}

/** The slice of GeoJSON {@link geoJsonOverlays} reads. Written out
 *  structurally rather than taken from `@types/geojson`, so this package
 *  does not put a type dependency in an application's graph for a shape
 *  that is four lines. */
export interface GeoJsonLike {
  type: string;
  features?: readonly GeoJsonLike[];
  geometry?: GeoJsonLike | null;
  geometries?: readonly GeoJsonLike[];
  coordinates?: unknown;
  properties?: Record<string, unknown> | null;
  id?: string | number;
}

/**
 * GeoJSON to overlays.
 *
 * Points become markers and everything else becomes an overlay, which is
 * the split the drawing makes. `style` is asked once per feature so an
 * application can colour by a property — a traffic feed's congestion, a
 * transit feed's route colour — without this function growing an
 * expression language.
 *
 * Coordinates are `[lon, lat]`, which is GeoJSON's order and the opposite
 * of how most people say it.
 */
export function geoJsonOverlays(
  geojson: GeoJsonLike,
  style?: (
    feature: GeoJsonLike,
  ) => Partial<Extract<MapOverlay, { kind: 'line' }>> &
    Partial<Extract<MapOverlay, { kind: 'polygon' }>>,
): { overlays: MapOverlay[]; markers: MapMarker[] } {
  const overlays: MapOverlay[] = [];
  const markers: MapMarker[] = [];
  let counter = 0;
  const positions = (value: unknown): LngLat[] =>
    Array.isArray(value)
      ? value
          .filter(
            (pair): pair is [number, number] =>
              Array.isArray(pair) &&
              typeof pair[0] === 'number' &&
              typeof pair[1] === 'number',
          )
          .map(([lon, lat]) => ({ lon, lat }))
      : [];

  const walk = (node: GeoJsonLike, owner: GeoJsonLike): void => {
    const id = String(owner.id ?? `geojson-${counter++}`);
    const extra = style?.(owner) ?? {};
    switch (node.type) {
      case 'FeatureCollection':
        for (const feature of node.features ?? []) walk(feature, feature);
        return;
      case 'Feature':
        if (node.geometry) walk(node.geometry, node);
        return;
      case 'GeometryCollection':
        for (const geometry of node.geometries ?? []) walk(geometry, owner);
        return;
      case 'Point': {
        const [point] = positions([node.coordinates]);
        if (point)
          markers.push({ id, position: point, data: owner.properties });
        return;
      }
      case 'MultiPoint':
        for (const point of positions(node.coordinates)) {
          markers.push({
            id: `${id}-${counter++}`,
            position: point,
            data: owner.properties,
          });
        }
        return;
      case 'LineString': {
        const path = positions(node.coordinates);
        if (path.length >= 2) {
          overlays.push({
            kind: 'line',
            id,
            path,
            data: owner.properties,
            ...extra,
          });
        }
        return;
      }
      case 'MultiLineString':
        for (const part of (node.coordinates as unknown[]) ?? []) {
          const path = positions(part);
          if (path.length >= 2) {
            overlays.push({
              kind: 'line',
              id: `${id}-${counter++}`,
              path,
              data: owner.properties,
              ...extra,
            });
          }
        }
        return;
      case 'Polygon': {
        const rings = ((node.coordinates as unknown[]) ?? []).map(positions);
        if (rings.length > 0) {
          overlays.push({
            kind: 'polygon',
            id,
            rings,
            data: owner.properties,
            ...extra,
          });
        }
        return;
      }
      case 'MultiPolygon':
        for (const polygon of (node.coordinates as unknown[]) ?? []) {
          const rings = ((polygon as unknown[]) ?? []).map(positions);
          if (rings.length > 0) {
            overlays.push({
              kind: 'polygon',
              id: `${id}-${counter++}`,
              rings,
              data: owner.properties,
              ...extra,
            });
          }
        }
        return;
      default:
        return;
    }
  };
  walk(geojson, geojson);
  return { overlays, markers };
}
