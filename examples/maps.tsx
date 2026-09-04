// `<Map>` in anger: OpenStreetMap's own vector tiles, over the real
// network, with markers you can click and a route drawn over them.
//
//   npm run examples:maps                    # London, light
//   npm run examples:maps -- tokyo           # or manhattan
//   npm run examples:maps -- tokyo --dark
//   npm run examples:maps -- --help
//
// Needs a real `$DISPLAY` and a network. The `fetch` below is the whole of
// what this package will not do for you: it is where the user agent, the
// caching and the error policy live, because those are the application's to
// decide (see `docs/components/maps.md`).
import { useMemo, useRef, useState } from 'react';
import { Button, Select, createRoot, useTheme } from 'react-x11';
import * as ntk from 'react-x11/ntk';

import {
  Map,
  osmRasterSource,
  osmVectorSource,
  shortbreadStyle,
} from '../src/maps/index.js';
import type {
  LngLat,
  MapHandle,
  MapMarker,
  MapSource,
  MapStyle,
} from '../src/maps/index.js';

const PLACES: Record<
  string,
  { name: string; centre: LngLat; markers: MapMarker[] }
> = {
  london: {
    name: 'London',
    centre: { lon: -0.1281, lat: 51.508 },
    markers: [
      {
        id: 'trafalgar',
        position: { lon: -0.1281, lat: 51.508 },
        title: 'Trafalgar Square',
      },
      {
        id: 'stpauls',
        position: { lon: -0.0984, lat: 51.5138 },
        title: "St Paul's",
      },
      {
        id: 'tower',
        position: { lon: -0.0759, lat: 51.5081 },
        title: 'Tower of London',
      },
      {
        id: 'eye',
        position: { lon: -0.1195, lat: 51.5033 },
        title: 'London Eye',
      },
    ],
  },
  tokyo: {
    name: 'Tokyo',
    centre: { lon: 139.7004, lat: 35.69 },
    markers: [
      {
        id: 'shinjuku',
        position: { lon: 139.7004, lat: 35.69 },
        title: 'Shinjuku Station',
      },
      {
        id: 'shibuya',
        position: { lon: 139.7016, lat: 35.6595 },
        title: 'Shibuya Crossing',
      },
      {
        id: 'palace',
        position: { lon: 139.7528, lat: 35.6852 },
        title: 'Imperial Palace',
      },
    ],
  },
  manhattan: {
    name: 'Manhattan',
    centre: { lon: -73.9855, lat: 40.758 },
    markers: [
      {
        id: 'times',
        position: { lon: -73.9855, lat: 40.758 },
        title: 'Times Square',
      },
      {
        id: 'central',
        position: { lon: -73.9654, lat: 40.7829 },
        title: 'Central Park',
      },
      {
        id: 'empire',
        position: { lon: -73.9857, lat: 40.7484 },
        title: 'Empire State Building',
      },
    ],
  },
};

if (process.argv.includes('--help')) {
  process.stdout.write(
    'usage: npm run examples:maps -- [place] [--dark]\n' +
      `  place: ${Object.keys(PLACES).join(', ')} (default london)\n`,
  );
  process.exit(0);
}
const dark = process.argv.includes('--dark');
const which =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'london';
const place = PLACES[which] ?? PLACES.london;

/**
 * The application's own tile loader.
 *
 * A one-entry-per-tile promise cache in front of it, because React can ask
 * for the same tile twice before the first answer lands, and OSM's usage
 * policy is not something to be casual about. A real application would put
 * a disk cache here too.
 */
// A plain object rather than a `Map`, because this module imports a
// component of that name — the one real cost of calling it `Map`, and the
// reason `import { Map as MapView }` is documented.
const inFlight: Record<string, Promise<Uint8Array | null>> = {};

const fetching = {
  fetch: (url: string, signal: { readonly aborted: boolean } | undefined) => {
    const hit = inFlight[url];
    if (hit) return hit;
    const request = fetch(url, {
      signal: signal as AbortSignal | undefined,
      headers: {
        // Identifying the application is the first line of OSM's tile usage
        // policy, and a shared default is what gets a whole runtime blocked.
        'user-agent':
          'react-x11-components-example/0.1 (+https://github.com/sidorares/react-x11-components)',
      },
    })
      .then(async (response) => {
        if (response.status === 404 || response.status === 204) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        return new Uint8Array(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        delete inFlight[url];
        throw error;
      });
    inFlight[url] = request;
    return request;
  },
};

const source = osmVectorSource(fetching);

/**
 * OSM's own raster style, which is the other thing the Foundation serves.
 *
 * A raster tile is pixels, so somebody has to decode the PNG — this package
 * will not grow a codec or guess which format a provider serves. ntk has
 * one and every react-x11 application already has ntk.
 *
 * Two things about reaching it that are easy to get wrong: `decodeImage` is
 * a **named** export of `react-x11/ntk` (which re-exports ntk with
 * `export *`), not a property of the default one — and it is not in the
 * declarations, so the namespace is cast structurally, the way this repo
 * works around every other narrow react-x11 declaration.
 */
const { decodeImage } = ntk as unknown as {
  decodeImage(bytes: Uint8Array): {
    width: number;
    height: number;
    data: Uint8Array;
  };
};

const raster = osmRasterSource({
  ...fetching,
  decode: (bytes) => {
    const image = decodeImage(bytes);
    return { width: image.width, height: image.height, data: image.data };
  },
});

/**
 * The layers this example can show.
 *
 * **OpenStreetMap has no satellite layer**, and that is worth knowing
 * rather than working around: OSM is map *data*, and the Foundation serves
 * the vector tiles and the standard raster style and nothing else. Every
 * aerial image you have seen in an OSM editor comes from a third party —
 * Esri, Bing, Maxar, Mapbox — under terms that permit *tracing for OSM*
 * rather than redisplay, or from OpenAerialMap, which is genuinely open
 * (CC BY 4.0) and patchy per-image rather than a global pyramid.
 *
 * So an imagery layer is a `MapSource` of your own, pointed at whichever
 * provider you have the rights to use, with their attribution:
 *
 * ```ts
 * const imagery: MapSource = {
 *   id: 'imagery', tileSize: 256, maxZoom: 19,
 *   attribution: 'whoever you are licensed from',
 *   load: async ({ z, x, y, signal }) => {
 *     const bytes = await fetchTile(`https://…/${z}/${y}/${x}`, signal);
 *     const image = decodeImage(bytes);
 *     return { kind: 'raster', width: image.width, height: image.height, data: image.data };
 *   },
 * };
 * ```
 */
interface Layer {
  id: string;
  label: string;
  sources: MapSource[];
  style?: MapStyle;
}

const LAYERS: Layer[] = [
  {
    id: 'vector',
    label: 'Vector — light',
    sources: [source],
    style: shortbreadStyle(),
  },
  {
    id: 'vector-dark',
    label: 'Vector — dark',
    sources: [source],
    style: shortbreadStyle({ dark: true }),
  },
  {
    id: 'vector-plain',
    label: 'Vector — no buildings',
    sources: [source],
    style: shortbreadStyle({ buildings: false }),
  },
  {
    id: 'raster',
    label: 'Raster — OSM standard',
    sources: [raster],
  },
];

function App(): React.ReactElement {
  const theme = useTheme();
  const map = useRef<MapHandle>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const [layerId, setLayerId] = useState(dark ? 'vector-dark' : 'vector');
  const layer = LAYERS.find((l) => l.id === layerId) ?? LAYERS[0];
  const markers = useMemo(
    () =>
      place.markers.map((marker) => ({
        ...marker,
        selected: marker.id === selected,
        size: marker.id === hovered ? 18 : 14,
      })),
    [selected, hovered],
  );

  // A route between the markers, as a routing engine would hand one over —
  // except that this one is the straight lines between them, since the
  // example is about drawing a route rather than about finding one.
  const overlays = useMemo(
    () => [
      {
        kind: 'line' as const,
        id: 'route',
        path: place.markers.map((m) => m.position),
        color: dark ? '#7aa2f7' : '#2d6cdf',
        width: 4,
        casing: dark ? '#0b0d12' : '#ffffff',
        casingWidth: 8,
      },
    ],
    [],
  );

  return (
    <window
      width={1100}
      height={760}
      title={`react-x11 maps — ${place.name}`}
      theme={dark ? { background: '#14161a', text: '#d7dae0' } : undefined}
    >
      <box style={{ flexDirection: 'column', flexGrow: 1 }}>
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 10,
            backgroundColor: theme.background,
          }}
        >
          <text style={{ fontWeight: 600 }}>{place.name}</text>
          <Button onClick={() => map.current?.zoomIn()}>Zoom in</Button>
          <Button onClick={() => map.current?.zoomOut()}>Zoom out</Button>
          <Button
            onClick={() => map.current?.fitMarkers(undefined, { padding: 60 })}
          >
            Fit markers
          </Button>
          <Select
            value={layerId}
            options={LAYERS.map((l) => ({ value: l.id, label: l.label }))}
            onChange={(event) => setLayerId(event.value)}
            style={{ width: 200 }}
          />
          <text style={{ color: theme.textMuted }}>{status}</text>
        </box>
        <Map
          ref={map}
          // Both change together, and both are stable objects, so
          // switching layers is one prop change rather than a re-render
          // storm: the element drops its rendered tiles and rebuilds them.
          sources={layer.sources}
          mapStyle={layer.style}
          defaultCamera={{ center: place.centre, zoom: 14 }}
          markers={markers}
          overlays={overlays}
          onMarkerClick={(marker) => setSelected(marker.id)}
          onMarkerHover={(marker) => setHovered(marker?.id ?? null)}
          onMapClick={(event) =>
            setStatus(
              `${event.lngLat.lat.toFixed(5)}, ${event.lngLat.lon.toFixed(5)}` +
                (event.marker
                  ? ` — ${event.marker.title ?? event.marker.id}`
                  : ''),
            )
          }
          onMoveEnd={(camera) => setStatus(`zoom ${camera.zoom.toFixed(2)}`)}
          // Without this, a source that is down, rate-limited or
          // misconfigured looks exactly like one that is slow: nothing is
          // drawn for a failed tile, and an empty map is what both look
          // like. Every application wants some version of this.
          onTileError={(error, tile) => {
            const message =
              error instanceof Error ? error.message : String(error);
            setStatus(`tile ${tile.z}/${tile.x}/${tile.y} failed: ${message}`);
            process.stderr.write(
              `tile ${tile.z}/${tile.x}/${tile.y}: ${message}\n`,
            );
          }}
          style={{ flexGrow: 1 }}
        />
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
