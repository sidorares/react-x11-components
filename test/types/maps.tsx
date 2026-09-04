// Type-level test: the declarations compile against react-x11's JSX
// namespace, the raw element the module augmentation adds is a typed tag,
// and the shapes an application actually writes — a source, a style, a
// marker, a handler — check without a cast.
import { useRef } from 'react';

import {
  Map,
  decodePolyline,
  geoJsonOverlays,
  osmRasterSource,
  osmVectorSource,
  shortbreadStyle,
} from '../../src/maps/index.js';
import type {
  MapCamera,
  MapHandle,
  MapMarker,
  MapOverlay,
  MapPointerEvent,
  MapSource,
  MapStyle,
} from '../../src/maps/index.js';
// The barrel carries the same names, qualified where a bare one would be
// ambiguous beside a calendar and a terminal.
import { Map as BarrelMap, decodePolyline as decode } from '../../src/index.js';
import type { LngLat, MapProps } from '../../src/index.js';

const source: MapSource = osmVectorSource({
  fetch: async (url, signal) => {
    // The signal is handed straight to `fetch`, which is the point of its
    // being the real shape rather than a stand-in.
    const response = await fetch(url, { signal: signal as AbortSignal });
    if (response.status === 404) return null;
    return new Uint8Array(await response.arrayBuffer());
  },
});

const raster: MapSource = osmRasterSource({
  fetch: () => null,
  decode: (bytes) => ({ width: 256, height: 256, data: bytes }),
  subdomains: ['a', 'b', 'c'],
});

// A source of one's own is an object with a `load`, and nothing else is
// required.
const local: MapSource = {
  load: ({ z, x, y }) =>
    z > 10 ? null : { kind: 'vector', data: new Uint8Array([]) },
};

const style: MapStyle = {
  background: '#fff',
  layers: [
    {
      id: 'water',
      type: 'fill',
      sourceLayer: 'water_polygons',
      color: '#aad3df',
    },
    {
      id: 'roads',
      type: 'line',
      sourceLayer: 'streets',
      filter: [
        'all',
        ['in', 'kind', 'motorway', 'trunk'],
        ['!=', 'rail', true],
      ],
      color: '#fff',
      width: {
        stops: [
          [10, 1],
          [16, 8],
        ],
      },
      cap: 'round',
    },
    {
      id: 'places',
      type: 'symbol',
      sourceLayer: 'place_labels',
      textField: 'name',
      textSize: {
        stops: [
          [4, 11],
          [12, 16],
        ],
      },
      rank: 100,
    },
    {
      id: 'stops',
      type: 'circle',
      sourceLayer: 'public_transport',
      radius: 3,
      color: '#c00',
      strokeColor: '#fff',
    },
  ],
};

const home: LngLat = { lon: -0.1281, lat: 51.508 };
const markers: MapMarker[] = [
  { id: 'home', position: home, title: 'Home', shape: 'pin' },
  {
    id: 'bus',
    position: home,
    shape: 'circle',
    size: 8,
    data: { route: '38' },
  },
];

const overlays: MapOverlay[] = [
  {
    kind: 'line',
    id: 'route',
    path: decodePolyline('_p~iF~ps|U'),
    casing: '#fff',
  },
  { kind: 'polygon', id: 'zone', rings: [[home, home, home]] },
  { kind: 'circle', id: 'accuracy', center: home, radiusMetres: 120 },
];

const { markers: fromJson, overlays: alsoFromJson } = geoJsonOverlays(
  { type: 'FeatureCollection', features: [] },
  (feature) => ({ color: String(feature.properties?.colour ?? '#333') }),
);

function Controlled(): React.ReactElement {
  const map = useRef<MapHandle>(null);
  const camera: MapCamera = { center: home, zoom: 12 };
  const onClick = (event: MapPointerEvent): void => {
    const lat: number = event.lngLat.lat;
    const id: string | undefined = event.marker?.id;
    void lat;
    void id;
  };
  return (
    <Map
      ref={map}
      sources={[source, raster, local]}
      mapStyle={style}
      camera={camera}
      onCameraChange={(next) => void next.zoom}
      onMoveEnd={(next) => void next.center.lon}
      markers={[...markers, ...fromJson]}
      overlays={[...overlays, ...alsoFromJson]}
      onMapClick={onClick}
      onMarkerClick={(marker, event) => {
        void marker.id;
        void event.x;
      }}
      // The event is null for the leave that comes from leaving the map.
      onMarkerHover={(marker, event) => void (marker && event?.lngLat)}
      onFrame={(stats) => void stats.rasterMs}
      minZoom={2}
      maxZoom={19}
      rasterBudgetMs={8}
      attribution="© OpenStreetMap contributors"
      style={{ height: 400 }}
    >
      <box style={{ position: 'absolute', left: 8, top: 8 }}>
        <text>a legend, mounted beside the pane</text>
      </box>
    </Map>
  );
}

function Uncontrolled(): React.ReactElement {
  return (
    <BarrelMap
      sources={[source]}
      mapStyle={shortbreadStyle({ dark: true, nameField: 'name_en' })}
      defaultCamera={{ center: { lon: 0, lat: 0 }, zoom: 3 }}
      style={{ flexGrow: 1 }}
    />
  );
}

// The element the module augmentation adds is a typed tag of its own.
function Raw(): React.ReactElement {
  return (
    <mapview
      sources={[source]}
      camera={{ center: home, zoom: 10 }}
      style={{ flexGrow: 1 }}
    />
  );
}

// The props type is exported and composable, which is what a wrapper needs.
function Wrapper(props: MapProps): React.ReactElement {
  return <Map {...props} />;
}

void decode;
void Controlled;
void Uncontrolled;
void Raw;
void Wrapper;
