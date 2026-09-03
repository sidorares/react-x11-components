// `<Map>` in anger: OpenStreetMap's own vector tiles, over the real
// network, with markers you can click and a route drawn over them.
//
//   npm run examples:maps
//   npm run examples:maps -- --dark
//   npm run examples:maps -- tokyo
//
// Needs a real `$DISPLAY` and a network. The `fetch` below is the whole of
// what this package will not do for you: it is where the user agent, the
// caching and the error policy live, because those are the application's to
// decide (see `docs/components/maps.md`).
import { useMemo, useRef, useState } from 'react';
import { Button, createRoot, useTheme } from 'react-x11';

import { Map, osmVectorSource, shortbreadStyle } from '../src/maps/index.js';
import type { LngLat, MapHandle, MapMarker } from '../src/maps/index.js';

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

const source = osmVectorSource({
  fetch: (url, signal) => {
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
});

function App(): React.ReactElement {
  const theme = useTheme();
  const map = useRef<MapHandle>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const style = useMemo(() => shortbreadStyle({ dark }), []);
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
          <text style={{ color: theme.textMuted }}>{status}</text>
        </box>
        <Map
          ref={map}
          sources={[source]}
          mapStyle={style}
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
          style={{ flexGrow: 1 }}
        />
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
