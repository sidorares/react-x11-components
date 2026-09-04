// `<Map>` — a 2D map: vector tiles the application supplies, drawn, panned,
// zoomed, with markers and overlays on top.
//
// The surface is deliberately close to Leaflet's and MapLibre's, because a
// map's API is a solved problem and an application that has described a
// camera, a marker and a tile source for one of those should not have to
// describe them again. What differs is the one thing that could not be
// carried over: nothing here fetches. A source is a function the
// application supplies, for the reason `src/html/`'s `onResource` is — see
// `./sources.ts`.
//
// **Registration happens when this module is evaluated**, which is the
// design and not a shortcut: nothing in the package registers anything
// until an application imports the component that needs it, so
// `sideEffects: false` stays honest. Do not move it into `../index.ts`
// (AGENTS.md, "Tree-shaking is a constraint").
import React, { useImperativeHandle, useRef } from 'react';
import type { ReactElement } from 'react';
import { registerElement, registeredElements } from 'react-x11/host';
import { createStyles, flattenStyle } from 'react-x11/style';
// Loads the module the JSX augmentation at the bottom targets: nothing in
// `src/` writes JSX, so without this the build program never resolves
// `react-x11/jsx-runtime` and the augmentation is an error rather than an
// addition. Type-only, so it is erased.
import type {} from 'react-x11/jsx-runtime';

import { ELEMENT, MapViewNode, SELF_DAMAGED_PROPS } from './node.js';
import type {
  FitBoundsOptions,
  MapCamera,
  MapHandle,
  MapProps,
  MapViewProps,
} from './types.js';
import type { LngLat, LngLatBounds } from './proj.js';
import type { MapMarker } from './overlay.js';

if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new MapViewNode(props, app),
    // No `semanticNames`: not one of this element's prop names is also a
    // style name — `center`, `zoom`, `sources` and `markers` are all clear,
    // and the map style is `mapStyle` precisely so that `style` stays
    // react-x11's. `test/maps.test.ts` is what keeps that true, because the
    // failure it guards against (throws in development, works in
    // production) is the worst shape a bug can have.
    childrenAllowed: false,
    // The commit claim: changes to these damage nothing by name — the
    // element's own `applyProps` diffs them into the boxes that actually
    // changed (react-x11#301). Without this, every pan step's new `camera`
    // and every moved marker would repaint the whole pane.
    selfDamagedProps: [...SELF_DAMAGED_PROPS],
  });
}

/**
 * `pane` is the default for the box `<Map>` renders: it fills its parent —
 * unless the application's own style gives it a height or a `flexGrow`, in
 * which case adding one would silently override what it asked for.
 * Checked against the *flattened* style, so an array works too.
 */
const styles = createStyles({
  pane: { flexGrow: 1, overflow: 'hidden' },
  clip: { overflow: 'hidden' },
  fill: { flexGrow: 1 },
});

const DEFAULT_CAMERA: MapCamera = { center: { lon: 0, lat: 20 }, zoom: 2 };

/**
 * A map.
 *
 * ```tsx
 * const source = osmVectorSource({
 *   fetch: async (url, signal) => {
 *     const response = await fetch(url, { signal });
 *     if (response.status === 404) return null;
 *     return new Uint8Array(await response.arrayBuffer());
 *   },
 * });
 *
 * <Map
 *   sources={[source]}
 *   defaultCamera={{ center: { lon: -0.1281, lat: 51.508 }, zoom: 13 }}
 *   markers={[{ id: 'home', position: { lon: -0.1281, lat: 51.508 } }]}
 *   onMarkerClick={(marker) => select(marker.id)}
 * />
 * ```
 *
 * Pass `camera` and `onCameraChange` instead of `defaultCamera` for the
 * controlled form, where the application owns where the map is looking.
 */
export function Map(props: MapProps): ReactElement {
  const {
    camera,
    defaultCamera,
    onCameraChange,
    style,
    children,
    ref,
    ...rest
  } = props;

  const view = useRef<MapViewNode | null>(null);
  const controlled = camera !== undefined;

  useImperativeHandle(
    ref,
    (): MapHandle => ({
      // Every method reads the node at call time rather than closing over
      // it: the ref attaches after the commit that created the node, and a
      // handle built once must still work for the whole mount.
      getCamera: () => view.current?.getCamera() ?? DEFAULT_CAMERA,
      setCamera: (next: Partial<MapCamera>) => view.current?.setCamera(next),
      panBy: (dx: number, dy: number) => view.current?.panBy(dx, dy),
      zoomIn: (step?: number) => view.current?.zoomIn(step),
      zoomOut: (step?: number) => view.current?.zoomOut(step),
      zoomTo: (zoom: number) => view.current?.zoomTo(zoom),
      fitBounds: (bounds: LngLatBounds, options?: FitBoundsOptions) =>
        view.current?.fitBounds(bounds, options),
      fitMarkers: (ids?: readonly string[], options?: FitBoundsOptions) =>
        view.current?.fitMarkers(ids, options),
      getBounds: () =>
        view.current?.getBounds() ?? {
          west: -180,
          south: -85,
          east: 180,
          north: 85,
        },
      project: (position: LngLat) =>
        view.current?.project(position) ?? { x: 0, y: 0 },
      unproject: (x: number, y: number) =>
        view.current?.unproject(x, y) ?? { lon: 0, lat: 0 },
      markerAt: (x: number, y: number): MapMarker | null =>
        view.current?.markerAt(x, y) ?? null,
      refresh: () => view.current?.refresh(),
      stats: () => view.current?.stats() ?? null,
    }),
    [],
  );

  const flat = flattenStyle(style ?? null);
  const sized =
    flat.height !== undefined ||
    flat.flexGrow !== undefined ||
    flat.flexBasis !== undefined;

  // The pane and anything the application puts over it are siblings rather
  // than parent and children: a registered element's own drawing happens
  // *after* `super.paint` has painted its children, so anything mounted
  // inside would be painted over by the map. Beside it, and after it, a
  // legend or a control panel lands on top. `<Flow>` makes the same
  // arrangement for the same reason.
  return React.createElement(
    'box',
    { style: sized ? [styles.clip, style] : [styles.pane, style] },
    React.createElement(ELEMENT, {
      ...(rest as MapViewProps),
      key: 'pane',
      ref: view,
      // The controlled/uncontrolled fork, and the whole of it. Controlled:
      // the application's camera goes down and the element only ever
      // *asks* to move. Uncontrolled: nothing goes down after the seed, the
      // element owns the camera, and a pan never reaches React — which is
      // the difference between a drag that blits a strip and one that
      // re-renders and re-claims the pane on every pointer step.
      camera: controlled ? camera : undefined,
      defaultCamera: controlled ? undefined : (defaultCamera ?? DEFAULT_CAMERA),
      onCameraChange,
      style: styles.fill,
      role: rest.role ?? 'group',
      'aria-label': rest['aria-label'] ?? 'Map',
    }),
    children,
  );
}

/** The host element name, for an application that would rather write
 *  `<mapview>`. The raw element is the whole component minus the
 *  controlled/uncontrolled fork and the box around it. */
export { ELEMENT as MAPVIEW_ELEMENT, MapViewNode };

export {
  DEFAULT_TILE_SIZE,
  EARTH_CIRCUMFERENCE,
  EARTH_RADIUS,
  MAX_LATITUDE,
  boundsOf,
  cameraForBounds,
  dataTileFor,
  distanceMetres,
  latFromMercatorY,
  lonFromMercatorX,
  mercatorScale,
  mercatorXFromLon,
  mercatorYFromLat,
  metresPerPixel,
  parentTile,
  project,
  projectLngLat,
  projectPoint,
  rasterFor,
  sourceZoomFor,
  subTileOf,
  tileBounds,
  tileContains,
  tileCountAt,
  tileCover,
  tileKey,
  tileOf,
  tileTransform,
  transformFor,
  unproject,
  unprojectPoint,
  visibleBounds,
  worldSize,
  wrapLon,
  wrapTileX,
} from './proj.js';

export {
  OSM_ATTRIBUTION,
  OSM_RASTER_URL,
  OSM_VECTOR_URL,
  osmRasterSource,
  osmVectorSource,
  parseVectorTile,
  pyramidOf,
  tileUrl,
} from './sources.js';

export { setGunzip } from './gzip.js';

export { DARK_PALETTE, LIGHT_PALETTE, shortbreadStyle } from './styles.js';

export { compileFilter, resolveZoomed } from './style.js';

export {
  decodePolyline,
  geoJsonOverlays,
  markerAt,
  markerRect,
} from './overlay.js';

export { GeomType, GeometryBuffer, MvtError, parseTile } from './mvt.js';

export { TileCache } from './tiles.js';

export type {
  FitBoundsOptions,
  MapFrameStats,
  MapHandle,
  MapPointerEvent,
  MapProps,
  MapViewProps,
} from './types.js';
export type {
  LngLat,
  LngLatBounds,
  MapCamera,
  MercatorPoint,
  TileCoverEntry,
  TileId,
  TilePyramid,
  TileRaster,
  Transform,
} from './proj.js';
export type { MapSource, TileData, TileRequest } from './sources.js';
export type { MapMarker, MapOverlay, GeoJsonLike } from './overlay.js';
export type {
  CircleLayer,
  FillLayer,
  LineLayer,
  MapFilter,
  MapStyle,
  MapStyleLayer,
  SymbolLayer,
  Zoomed,
} from './style.js';
export type { MapPalette, ShortbreadStyleOptions } from './styles.js';
export type {
  FeatureValue,
  GeometryData,
  VectorTile,
  VectorTileLayer,
  FeatureCursor,
} from './mvt.js';
export type { CachedTile, TileStatus } from './tiles.js';

// Importing this module teaches JSX the element too, so `<mapview>` is a
// typed tag rather than an error — the module-augmentation shape
// react-x11's docs/typescript.md prescribes for a third-party element.
declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      mapview: MapViewProps;
    }
  }
}
