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
import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useApp, useSupports, useTheme } from 'react-x11';
import { registerElement, registeredElements } from 'react-x11/host';
import { createStyles, flattenStyle } from 'react-x11/style';
// Loads the module the JSX augmentation at the bottom targets: nothing in
// `src/` writes JSX, so without this the build program never resolves
// `react-x11/jsx-runtime` and the augmentation is an error rather than an
// addition. Type-only, so it is erased.
import type {} from 'react-x11/jsx-runtime';

import { DEFAULT_CAMERA, MapController } from './controller.js';
import { ELEMENT, MapViewNode, SELF_DAMAGED_PROPS } from './node.js';
import {
  capabilityBlockers,
  chooseRenderer,
  glRendererModule,
  loadGlRenderer,
  rendererFromEnv,
  rendererRequest,
} from './renderer.js';
import type { GlRendererModule } from './renderer.js';
import { defaultStyleFor, isDarkTheme } from './theme.js';
import type {
  MapProps,
  MapRenderer,
  MapRendererReason,
  MapViewProps,
} from './types.js';

const h = React.createElement;

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
  // One controller for the life of the mount: the camera, the gestures and
  // the handle, which whichever renderer is drawing answers to (see
  // `./controller.ts`). Seeded here, once — `defaultCamera` is read on the
  // first render and never again, which is what makes it a *default*.
  const [controller] = useState(
    () => new MapController(props.defaultCamera ?? DEFAULT_CAMERA),
  );
  // Read at event and frame time, so the latest props are always the ones
  // that count — and the controlled/uncontrolled fork is simply whether
  // `camera` is among them.
  controller.setProps(props);
  // The controller's own handle, made once: the same object for the whole
  // mount, whatever draws the map — across a renderer switch too.
  useImperativeHandle(props.ref, () => controller.handle, [controller]);
  useEffect(() => () => controller.dispose(), [controller]);

  // A GL failure is the map's for the rest of its mount: an `'auto'` map
  // that met one draws through the retained renderer from then on.
  const [failure, setFailure] = useState<Error | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const flat = flattenStyle(props.style ?? null);
  const sized =
    flat.height !== undefined ||
    flat.flexGrow !== undefined ||
    flat.flexBasis !== undefined;

  const { asked, forced } = rendererRequest(props.renderer, rendererFromEnv());
  const pane =
    asked === 'auto'
      ? h(AutoPane, {
          key: 'auto',
          map: props,
          controller,
          failed: failure !== null,
          onFailure: setFailure,
        })
      : h(MapPane, {
          key: asked,
          renderer: asked,
          reason: forced ? 'forced' : null,
          map: props,
          controller,
          // Asked for by name: never a fallback, always the application's
          // to hear about.
          onFailure: (error: Error) => latest.current.onError?.(error),
        });

  // The pane and anything the application puts over it are siblings rather
  // than parent and children: a registered element's own drawing happens
  // *after* `super.paint` has painted its children, so anything mounted
  // inside would be painted over by the map. Beside it, and after it, a
  // legend or a control panel lands on top. `<Flow>` makes the same
  // arrangement for the same reason.
  return h(
    'box',
    { style: sized ? [styles.clip, props.style] : [styles.pane, props.style] },
    pane,
    props.children,
  );
}

/** Props `<Map>` reads itself, or that only the GL renderer reads — kept off
 *  the `<mapview>` element, which would take each as a prop of its own. */
const NOT_FOR_THE_ELEMENT: readonly string[] = [
  'camera',
  'defaultCamera',
  'style',
  'children',
  'ref',
  'renderer',
  'onRendererChange',
  'onError',
  'levelFade',
  'adaptive',
  'buildWorkers',
  'antialias',
  'fillRule',
  'onAfterDraw',
];

function elementProps(map: MapProps): MapViewProps {
  const out: Record<string, unknown> = { ...map };
  for (const name of NOT_FOR_THE_ELEMENT) delete out[name];
  return out as MapViewProps;
}

interface PaneProps {
  map: MapProps;
  controller: MapController;
  onFailure: (error: Error) => void;
}

/**
 * `renderer="auto"`: GL where this connection draws through the direct
 * backend and nothing the map uses is missing from GL, the retained renderer
 * everywhere else — `./renderer.ts` is the decision, and this is where it
 * reads the connection. Its own component so that a map that asked for a
 * renderer by name never asks the connection: on the Cocoa backend the
 * question is a GL runtime brought up to answer it.
 */
function AutoPane(props: PaneProps & { failed: boolean }): ReactElement {
  const { map } = props;
  const app = useApp();
  const shaders = useSupports('shaders');
  const probing = useDirectGlProbe(app, shaders);
  const blockers = capabilityBlockers(map);
  const choice = chooseRenderer({
    requested: 'auto',
    shaders,
    probing,
    blockers,
    failed: props.failed,
  });
  const warned = useRef(false);
  useEffect(() => {
    if (choice.reason !== 'capability' || warned.current) return;
    warned.current = true;
    const g = globalThis as {
      process?: { env?: Record<string, string | undefined> };
      console?: { warn(message: string): void };
    };
    if (g.process?.env?.NODE_ENV === 'production') return;
    g.console?.warn(
      `@react-x11/components: <Map renderer="auto"> is drawing through the ` +
        `retained renderer because of ${blockers.map((b) => `\`${b}\``).join(', ')}. ` +
        'A GL surface is stacked above every 2D thing in its window, so a ' +
        'map with children would hide them; renderer="gl" draws through GL ' +
        'anyway, under them.',
    );
  });
  return h(MapPane, {
    renderer: choice.renderer,
    reason: choice.reason,
    map,
    controller: props.controller,
    onFailure: props.onFailure,
  });
}

/**
 * Whether this connection's answer to `useSupports('shaders')` is still to
 * come. Under a policy that could choose direct GL, X11 settles it before
 * `createRoot()` hands the app back; the Cocoa backend settles it on the
 * first ask, which is this. Until it has, a map shows its background rather
 * than drawing through the retained renderer for a few milliseconds and
 * fetching the view's tiles twice.
 */
function useDirectGlProbe(app: unknown, shaders: boolean): boolean {
  const mode = (app as { glPolicy?: { mode?: string } } | null)?.glPolicy?.mode;
  const wants = mode === 'auto' || mode === 'direct';
  const [settled, setSettled] = useState(false);
  const pending = wants && !shaders && !settled;
  useEffect(() => {
    if (!pending) return;
    const probe = (
      app as { glCapabilities?(): Promise<unknown> } | null
    )?.glCapabilities?.();
    if (!probe) {
      setSettled(true);
      return;
    }
    let live = true;
    const done = (): void => {
      if (live) setSettled(true);
    };
    probe.then(done, done);
    return () => {
      live = false;
    };
  }, [app, pending]);
  return pending;
}

/**
 * The pane, drawn by the renderer chosen: the `<mapview>` element, the GL
 * renderer once its module has loaded, or — while the connection's answer
 * or the module is on its way — a box in the style's background. Whichever
 * it is, it answers to the map's one controller.
 */
function MapPane(
  props: PaneProps & {
    renderer: MapRenderer | 'pending';
    reason: MapRendererReason | null;
  },
): ReactElement {
  const { renderer, reason, map, controller } = props;
  const theme = useTheme();

  // `onRendererChange`: when the map lands somewhere it did not ask for,
  // and whenever it changes renderer after that.
  const reported = useRef<MapRenderer | null>(null);
  useEffect(() => {
    if (renderer === 'pending') return;
    const before = reported.current;
    reported.current = renderer;
    if (before === renderer) return;
    if (before === null && reason === null) return;
    map.onRendererChange?.(renderer, reason ?? 'capability');
  }, [renderer, reason]);

  const wantGl = renderer === 'gl';
  const [gl, setGl] = useState<GlRendererModule | null>(glRendererModule);
  useEffect(() => {
    if (!wantGl || gl) return;
    let live = true;
    loadGlRenderer().then(
      (module) => {
        if (live) setGl(module);
      },
      (error: unknown) => {
        if (!live) return;
        props.onFailure(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );
    return () => {
      live = false;
    };
  }, [wantGl, gl]);

  const common = {
    style: styles.fill,
    role: map.role ?? 'group',
    'aria-label': map['aria-label'] ?? 'Map',
    'data-testname': map['data-testname'],
  };
  if (renderer === 'retained') {
    return h(ELEMENT, {
      ...elementProps(map),
      ...common,
      key: 'retained',
      mapController: controller,
      // The controlled/uncontrolled fork, and the whole of it. Controlled:
      // the application's camera goes down and the element only ever
      // *asks* to move. Uncontrolled: nothing goes down, the controller
      // owns the camera, and a pan never reaches React — which is the
      // difference between a drag that blits a strip and one that
      // re-renders and re-claims the pane on every pointer step.
      camera: map.camera,
    } as MapViewProps);
  }
  if (renderer === 'gl' && gl) {
    return h(gl.GlMapPane, {
      ...common,
      key: 'gl',
      controller,
      map,
      onFailure: props.onFailure,
    });
  }
  const background = (map.mapStyle ?? defaultStyleFor(isDarkTheme(theme)))
    .background;
  return h('box', {
    ...common,
    key: 'pending',
    style: background
      ? [styles.fill, { backgroundColor: background }]
      : styles.fill,
  });
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
  zoomOffsetFor,
  wrapLon,
  wrapTileX,
} from './proj.js';

export {
  OSM_ATTRIBUTION,
  OSM_RASTER_URL,
  OSM_VECTOR_URL,
  googleTileSource,
  osmRasterSource,
  osmVectorSource,
  parseVectorTile,
  pyramidOf,
  tileUrl,
} from './sources.js';

export { setGunzip } from './gzip.js';

export {
  DARK_PALETTE,
  LIGHT_PALETTE,
  openMapTilesStyle,
  shortbreadStyle,
} from './styles.js';

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
  MapGlFrameStats,
  MapGlProps,
  MapHandle,
  MapPointerEvent,
  MapProps,
  MapRenderer,
  MapRendererReason,
  MapRendererRequest,
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
export type {
  GoogleSession,
  GoogleTileSourceOptions,
  MapSource,
  TileData,
  TileRequest,
} from './sources.js';
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
export type {
  MapPalette,
  OpenMapTilesStyleOptions,
  ShortbreadStyleOptions,
} from './styles.js';
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
