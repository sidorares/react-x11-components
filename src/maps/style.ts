// What to draw a tile's layers as.
//
// A **subset of the Mapbox/MapLibre GL style specification**, and a subset
// on purpose. The reason to shape it after that spec rather than invent one
// is that every provider documents their schema in its terms — Shortbread,
// OpenMapTiles, Mapbox Streets, Azure Maps, TomTom Orbis all publish "which
// layer, which field, at which zoom" as GL style fragments — so an author
// who has read any of those pages already knows what goes here.
//
// What is deliberately *not* here is the expression language. GL styles have
// grown a small typed Lisp (`['case', ['>', ['get', 'x'], 2], …]`) that is
// a real interpreter with a real cost per feature, and none of it is needed
// to say "roads, motorways thicker, at zoom 8 and up". So this takes the
// two older, simpler halves of the same spec:
//
//  - **the legacy filter syntax** — `['all', ['==', 'kind', 'motorway'], …]`
//    — which is a documented part of the spec, is what most schema
//    documentation still shows, and compiles to a closure in one pass; and
//  - **`stops`** for anything that varies with zoom, which is the older
//    spelling of `['interpolate', ['linear'], ['zoom'], …]`.
//
// Both are resolved *once per layer per frame*, never per feature. That is
// the whole performance argument for the restriction: a dense tile has
// twelve thousand features and eighteen layers, so anything computed per
// layer is free and anything computed per feature is the frame.
import type { FeatureValue } from './mvt.js';
import { GeomType } from './mvt.js';
import type { FeatureCursor } from './mvt.js';

/**
 * A value that may vary with the zoom.
 *
 * A bare value is constant. `{ stops }` is a list of `[zoom, value]` pairs,
 * ordered by zoom: numbers interpolate linearly between the surrounding
 * pair, and anything else steps at each stop. Outside the range the nearest
 * stop holds, which is what makes a two-stop ramp a sensible whole answer
 * rather than something that vanishes at zoom 0.
 */
export type Zoomed<T> = T | { stops: readonly (readonly [number, T])[] };

/** Mapbox's legacy filter syntax, which is the part of it a style here
 *  speaks. Compiled with {@link compileFilter}. */
export type MapFilter =
  | readonly ['==' | '!=', string, FeatureValue]
  | readonly ['<' | '<=' | '>' | '>=', string, number]
  | readonly ['in' | '!in', string, ...FeatureValue[]]
  | readonly ['has' | '!has', string]
  | readonly ['all' | 'any' | 'none', ...MapFilter[]]
  // `$type` is the spec's name for the geometry type, and the one filter
  // that does not read a tag.
  | readonly ['geometry', 'point' | 'line' | 'polygon'];

interface LayerBase {
  /** This layer's name in the style. Used in a `<Map>` event payload and as
   *  the cache key for anything derived from it. */
  id: string;
  /** Which source, when the map has more than one. The first source by
   *  default. */
  source?: string;
  /** Which layer of the tile — `'streets'`, `'water_polygons'`. */
  sourceLayer: string;
  /** The zoom range this layer draws in. A layer outside its range costs
   *  nothing: it is skipped before its features are touched. */
  minZoom?: number;
  maxZoom?: number;
  filter?: MapFilter;
  /** `false` keeps the layer in the style and stops drawing it — what a
   *  layer toggle in an application's UI switches. */
  visible?: boolean;
}

/** An area. */
export interface FillLayer extends LayerBase {
  type: 'fill';
  color: Zoomed<string>;
  opacity?: Zoomed<number>;
  /** Stroked at one logical pixel around each ring, after the fill. */
  outlineColor?: Zoomed<string>;
}

/** A line: a road, a river, a boundary, a route. */
export interface LineLayer extends LayerBase {
  type: 'line';
  color: Zoomed<string>;
  /** Logical pixels. */
  width: Zoomed<number>;
  opacity?: Zoomed<number>;
  /** A dash pattern in logical pixels. */
  dash?: readonly number[];
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
}

/** A point, as a disc. */
export interface CircleLayer extends LayerBase {
  type: 'circle';
  radius: Zoomed<number>;
  color: Zoomed<string>;
  opacity?: Zoomed<number>;
  strokeColor?: Zoomed<string>;
  strokeWidth?: Zoomed<number>;
}

/**
 * A label.
 *
 * Symbol layers are **not** rasterized into the tile: they are collected as
 * candidates, placed against every other label on screen, and drawn into
 * the frame directly. Three reasons, and each of them is a bug if it is
 * done the other way. Collision is global — two labels in different tiles
 * overlap just as readily as two in one — so a per-tile placement produces
 * a map that reads as clutter at every seam. A label baked into a tile
 * surface is stretched by the fractional zoom, and text is the one thing on
 * a map nobody accepts blurred. And a tile's labels would be clipped at its
 * edge, which is exactly where half of them sit.
 */
export interface SymbolLayer extends LayerBase {
  type: 'symbol';
  /** The tag to read the text from — `'name'`, or `'name:en'`. */
  textField: string;
  /** Logical pixels. */
  textSize?: Zoomed<number>;
  textColor?: Zoomed<string>;
  /** Drawn under the glyphs, so a place name stays readable over a road. */
  textHaloColor?: Zoomed<string>;
  textHaloWidth?: Zoomed<number>;
  /**
   * Which label wins a collision, layer-wide. Higher wins; 0 by default,
   * and the style's layer order breaks a tie.
   *
   * Deliberately not a per-feature expression. A schema's own importance
   * field looks like the obvious input and is not usable as one: Shortbread
   * carries `population`, which is 8,000,000 for London and 500 for Soho,
   * so adding it to a rank that also has to order against street names
   * needs a normalization nobody can guess. Splitting by `filter` — a layer
   * for cities, a layer for suburbs — is exact, is what the ordering
   * actually wants, and costs one more entry in a list.
   */
  rank?: number;
  /**
   * How far apart, in pixels, the same text may repeat within this layer.
   * 250 by default; `0` lets it repeat as often as it fits.
   *
   * Not a nicety. A street is one feature **per segment** in every schema
   * there is, so `street_labels` offers "Oxford Street" a dozen times over
   * for one street, and a placement that only tests overlap accepts all
   * twelve — they do not overlap, they are strung out along the road. The
   * same is true of an administrative area whose name arrives once per
   * polygon part. Repeating a long street's name across a wide view is
   * wanted; repeating it four times in a hundred pixels is not, and the
   * distance is where that line goes.
   */
  repeatDistance?: number;
}

export type MapStyleLayer = FillLayer | LineLayer | CircleLayer | SymbolLayer;

/** A whole style. */
export interface MapStyle {
  /** Painted under every tile — the colour of the parts of the world that
   *  have no data yet, so it is what a map looks like while it loads. */
  background?: string;
  layers: readonly MapStyleLayer[];
  /** The face labels are set in. The theme's `fontFamily` by default. */
  fontFamily?: string;
}

// --- zoom ramps ------------------------------------------------------------

function isStops<T>(
  value: Zoomed<T>,
): value is { stops: readonly (readonly [number, T])[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { stops?: unknown }).stops)
  );
}

/** A {@link Zoomed} at one zoom. Numbers interpolate, everything else
 *  steps. */
export function resolveZoomed<T>(value: Zoomed<T>, zoom: number): T {
  if (!isStops(value)) return value;
  const stops = value.stops;
  if (stops.length === 0) throw new Error('a zoom ramp needs a stop');
  if (zoom <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (zoom >= last[0]) return last[1];
  let i = 1;
  while (i < stops.length && stops[i][0] <= zoom) i++;
  const [z0, v0] = stops[i - 1];
  const [z1, v1] = stops[i];
  if (typeof v0 !== 'number' || typeof v1 !== 'number') return v0;
  const t = z1 === z0 ? 0 : (zoom - z0) / (z1 - z0);
  return (v0 + (v1 - v0) * t) as unknown as T;
}

// --- filters ---------------------------------------------------------------

/** A compiled filter: the shape the rasterizer calls per feature. */
export type CompiledFilter = (feature: FeatureCursor) => boolean;

const ALWAYS: CompiledFilter = () => true;

/**
 * Compile a filter to a closure, once.
 *
 * The point of compiling rather than interpreting: the operator dispatch,
 * the `in`-set construction and the geometry-type mapping all happen here,
 * per layer, instead of twelve thousand times per tile. A `['in', 'kind',
 * …]` with forty values becomes a `Set` lookup rather than a scan.
 */
export function compileFilter(filter: MapFilter | undefined): CompiledFilter {
  if (!filter) return ALWAYS;
  const op = filter[0];
  switch (op) {
    case 'all': {
      const parts = (filter.slice(1) as MapFilter[]).map(compileFilter);
      if (parts.length === 0) return ALWAYS;
      if (parts.length === 1) return parts[0];
      return (f) => {
        for (const part of parts) if (!part(f)) return false;
        return true;
      };
    }
    case 'any': {
      const parts = (filter.slice(1) as MapFilter[]).map(compileFilter);
      if (parts.length === 0) return ALWAYS;
      return (f) => {
        for (const part of parts) if (part(f)) return true;
        return false;
      };
    }
    case 'none': {
      const parts = (filter.slice(1) as MapFilter[]).map(compileFilter);
      return (f) => {
        for (const part of parts) if (part(f)) return false;
        return true;
      };
    }
    case 'has': {
      const key = filter[1];
      return (f) => f.get(key) !== undefined;
    }
    case '!has': {
      const key = filter[1];
      return (f) => f.get(key) === undefined;
    }
    case '==': {
      const [, key, want] = filter;
      return (f) => f.get(key) === want;
    }
    case '!=': {
      const [, key, want] = filter;
      return (f) => f.get(key) !== want;
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const [, key, want] = filter;
      return (f) => {
        const value = f.get(key);
        // A missing tag compares false rather than as zero: `['>' , 'pop',
        // 0]` must not select every feature that has no population.
        if (typeof value !== 'number') return false;
        return op === '<'
          ? value < want
          : op === '<='
            ? value <= want
            : op === '>'
              ? value > want
              : value >= want;
      };
    }
    case 'in': {
      const key = filter[1];
      const set = new Set(filter.slice(2) as FeatureValue[]);
      return (f) => {
        const value = f.get(key);
        return value !== undefined && set.has(value);
      };
    }
    case '!in': {
      const key = filter[1];
      const set = new Set(filter.slice(2) as FeatureValue[]);
      return (f) => {
        const value = f.get(key);
        return value === undefined || !set.has(value);
      };
    }
    case 'geometry': {
      const want =
        filter[1] === 'point'
          ? GeomType.Point
          : filter[1] === 'line'
            ? GeomType.LineString
            : GeomType.Polygon;
      return (f) => f.type === want;
    }
    default: {
      // An unknown operator draws nothing rather than everything: a typo in
      // a filter that quietly selected the whole layer would look like the
      // style working.
      const unknown: never = op;
      throw new Error(`unknown map filter operator ${String(unknown)}`);
    }
  }
}
