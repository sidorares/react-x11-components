// `<Map renderer="gl">`: every frame drawn from vector tiles on the GPU,
// with no bitmap cache anywhere, and the GL renderer's own levers on a bar.
//
//   npm run examples:maps-gl                     # London: corpus tiles, else the network
//   npm run examples:maps-gl -- tokyo --dark     # or manhattan, pacific
//   npm run examples:maps-gl -- --offline        # the bench corpus only
//   npm run examples:maps-gl -- --online         # OpenStreetMap's servers only
//   npm run examples:maps-gl -- --zoom=16.5      # start closer (street names are 14+)
//   npm run examples:maps-gl -- --no-labels      # start with labels off
//   npm run examples:maps-gl -- --live-labels    # names placed mid-zoom too
//   npm run examples:maps-gl -- --source=openfreemap   # start on another provider
//   npm run examples:maps-gl -- --snap-numbers   # house numbers inside their buildings
//
// The corpus is `scripts/bench/tiles.ts`'s cache; without it the tiles come
// from `vector.openstreetmap.org`, identified the way its usage policy asks.
// On X11 this needs the direct GL backend (the root below asks for it); on
// the Cocoa backend GL is always direct.
//
// **Source** switches the provider under the same camera — `./map-sources.ts`'
// list, which `maps.tsx` shows too: OSM's own Shortbread tiles (the corpus
// first), VersaTiles' cut of the same schema, OpenFreeMap's OpenMapTiles,
// MapTiler with `MAPTILER_KEY`, and the raster layers. One renderer across
// different data: the same street in two schemas, a planet cut by another
// tool, pixels instead of geometry.
//
// Drag to pan; wheel or double-click to zoom (Shift + double-click out);
// arrows and +/− once the map has focus. Pan, Zoom and Fly animate the camera
// from the frame callback, so the bar shows the renderer under load: Fly
// crosses ten zoom levels and brings in new tiles the whole way.
//
// **Labels** are drawn in the GL frame: street names along the middle of
// their streets, on straight stretches only, placed whole inside the view,
// fading in and out; while a zoom is under way the names shown ride along
// and new ones wait until it stops.
//
// Two things to compare by eye:
//  - **Fade** cross-fades the old zoom level's geometry into the new one's
//    instead of switching in one frame. Only visible where a level brings new
//    geometry — the corpus has only even levels, so with `--offline` the
//    fades happen at 12 → 14; with network tiles, at every level.
//  - **Adaptive** trades detail for frame rate while the camera moves and
//    draws everything again when it stops. This machine rarely needs it at
//    the default 12 ms, so the button steps the budget down until it shows.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { useEffect, useRef, useState } from 'react';
import { Button, Select, createRoot, useTheme } from 'react-x11';

import {
  Map,
  openMapTilesStyle,
  project,
  shortbreadStyle,
  unproject,
  worldSize,
} from '../src/maps/index.js';
import type {
  LngLat,
  MapCamera,
  MapFrameStats,
  MapGlFrameStats,
  MapHandle,
  MapSource,
  MapStyle,
} from '../src/maps/index.js';
import { cachePath } from '../scripts/bench/tiles.js';
import { PROVIDERS, osmVector } from './map-sources.js';
import type { TileProvider, TileSchema } from './map-sources.js';

const PLACES: Record<string, { name: string; centre: LngLat; zoom: number }> = {
  london: { name: 'London', centre: { lon: -0.1281, lat: 51.508 }, zoom: 15 },
  tokyo: { name: 'Tokyo', centre: { lon: 139.7004, lat: 35.69 }, zoom: 12 },
  manhattan: {
    name: 'Manhattan',
    centre: { lon: -73.9855, lat: 40.758 },
    zoom: 14,
  },
  pacific: { name: 'Mid-Pacific', centre: { lon: -160, lat: 0 }, zoom: 10 },
};
const args = process.argv.slice(2);
const place = PLACES[args.find((a) => a in PLACES) ?? 'london'];
const offline = args.includes('--offline');
const online = args.includes('--online');
const zoomArg = Number(
  args.find((a) => a.startsWith('--zoom='))?.slice('--zoom='.length),
);

/** OpenStreetMap's own tiles: the bench corpus where it has the tile, the
 *  network where it does not. */
const corpus: MapSource = {
  id: 'osm-vector',
  minZoom: 0,
  maxZoom: 14,
  tileSize: 512,
  attribution: osmVector.attribution,
  async load(request) {
    if (!online) {
      const file = cachePath(request);
      if (existsSync(file)) {
        const bytes = new Uint8Array(await readFile(file));
        return bytes.length > 0 ? { kind: 'vector', data: bytes } : null;
      }
      if (offline) return null;
    }
    return osmVector.load(request);
  },
};

/** The bar's providers: OSM through the corpus first, then every other one
 *  `./map-sources.ts` has. */
const GL_PROVIDERS: TileProvider[] = [
  {
    id: 'osm',
    label: offline
      ? 'OpenStreetMap — corpus only'
      : online
        ? 'OpenStreetMap — vector'
        : 'OpenStreetMap — corpus, then network',
    sources: [corpus],
    schema: 'shortbread',
  },
  ...PROVIDERS.filter((p) => p.id !== 'osm'),
];
const sourceArg = args
  .find((a) => a.startsWith('--source='))
  ?.slice('--source='.length);
if (sourceArg && !GL_PROVIDERS.some((p) => p.id === sourceArg)) {
  process.stderr.write(
    `--source=${sourceArg}: not one of ${GL_PROVIDERS.map((p) => p.id).join(', ')}` +
      ' (a keyed provider needs its key in the environment)\n',
  );
}

/** Every style the bar can ask for — per schema, palette, labels and
 *  whether house numbers snap into their buildings — made once each, as a
 *  style should be: a new style object is a restyle. */
const STYLES: Record<string, MapStyle> = {};
for (const dark of [false, true]) {
  for (const labels of [false, true]) {
    for (const snapBuildingNumbers of [false, true]) {
      const options = { dark, labels, snapBuildingNumbers };
      const key = `${dark}|${labels}|${snapBuildingNumbers}`;
      STYLES[`shortbread|${key}`] = shortbreadStyle(options);
      STYLES[`openmaptiles|${key}`] = openMapTilesStyle(options);
    }
  }
}
/** None for a raster provider: its tiles arrive already drawn. */
const styleFor = (
  schema: TileSchema,
  dark: boolean,
  labels: boolean,
  snap: boolean,
): MapStyle | undefined =>
  schema === 'raster'
    ? undefined
    : STYLES[`${schema}|${dark}|${labels}|${snap}`];

/** A frame's GL figures, with its tiles and the zoom it was drawn at. */
type Frame = MapGlFrameStats & { tiles: number; zoom: number };
const defaultCamera: MapCamera = {
  center: place.centre,
  zoom: Number.isFinite(zoomArg) ? zoomArg : place.zoom,
};

type Animation = 'still' | 'pan' | 'zoom' | 'fly';

/** The adaptive budgets the button steps through, in milliseconds; 0 is off.
 *  The component's own default is first, so the map starts as a shipped one
 *  behaves and the button steps *down* to the unbudgeted case — which is a
 *  thing worth seeing here and a thing no app should be left in by default:
 *  unbudgeted, a fly takes the whole thread and the host's timers with it. */
const BUDGETS = [12, 6, 3, 0] as const;

/** Where an animation has the camera `t` seconds in. */
function cameraAt(kind: Animation, base: MapCamera, t: number): MapCamera {
  if (kind === 'pan') {
    const m = project(base.center);
    const world = worldSize(base.zoom);
    const angle = (2 * Math.PI * t) / 6;
    return {
      center: unproject({
        x: m.x + (300 * Math.cos(angle) - 300) / world,
        y: m.y + (300 * Math.sin(angle)) / world,
      }),
      zoom: base.zoom,
    };
  }
  if (kind === 'zoom') {
    return {
      center: base.center,
      zoom: base.zoom + 1 - Math.cos((2 * Math.PI * t) / 6),
    };
  }
  if (kind === 'fly') {
    return {
      center: base.center,
      zoom: 10 - 5 * Math.cos((2 * Math.PI * t) / 16),
    };
  }
  return base;
}

function summary(frames: Frame[], seconds: number): string {
  if (frames.length === 0) return 'idle';
  const intervals = frames
    .map((f) => f.interval)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const p95 = intervals[Math.floor(intervals.length * 0.95)] ?? 0;
  const last = frames[frames.length - 1];
  const degraded = frames.filter((f) => f.quality > 0).length;
  const worstRung = Math.max(...frames.map((f) => f.quality));
  const measured = frames
    .filter((f) => f.measuredMs > 0)
    .map((f) => f.measuredMs);
  const parts = [
    `${(frames.length / seconds).toFixed(0)} fps`,
    `frame p95 ${p95.toFixed(1)} ms`,
    `${last.tiles} tiles`,
    `${(last.instances / 1e6).toFixed(2)}M segments`,
    `z${last.zoom.toFixed(2)} (level ${last.level})`,
  ];
  if (measured.length > 0) {
    parts.push(
      `quality rung ≤${worstRung} on ${degraded}/${frames.length} frames, ` +
        `GPU ${Math.max(...measured).toFixed(1)} ms max`,
    );
  }
  if (frames.some((f) => f.fade > 0)) {
    parts.push(`fading ${last.shownLevel} → ${last.level}`);
  }
  if (last.loading || last.building) {
    parts.push(`loading ${last.loading + last.building}`);
  }
  return parts.join(' · ');
}

function App(): React.ReactElement {
  const theme = useTheme();
  const map = useRef<MapHandle>(null);
  const [dark, setDark] = useState(args.includes('--dark'));
  const [antialias, setAntialias] = useState(true);
  const [fade, setFade] = useState(0);
  const [budget, setBudget] = useState<(typeof BUDGETS)[number]>(12);
  const [labels, setLabels] = useState(!args.includes('--no-labels'));
  const [liveLabels, setLiveLabels] = useState(args.includes('--live-labels'));
  const [snap, setSnap] = useState(args.includes('--snap-numbers'));
  const [providerId, setProviderId] = useState(
    GL_PROVIDERS.some((p) => p.id === sourceArg) ? sourceArg! : 'osm',
  );
  const provider =
    GL_PROVIDERS.find((p) => p.id === providerId) ?? GL_PROVIDERS[0];
  const [status, setStatus] = useState('');
  // A GL failure has to outlast the summary. The line below is rewritten
  // twice a second from the frame stats, so a message set from `onError` was
  // gone again before it could be read — and a map that asked for GL by name
  // never falls back, so there is nothing else on screen to say why it is
  // empty. It holds the line until frames arrive again, which is the only
  // thing that can make it stale.
  const [failure, setFailure] = useState('');
  const frames = useRef<Frame[]>([]);
  const running = useRef({
    kind: 'still' as Animation,
    started: 0,
    base: defaultCamera,
  });

  // The bar updates twice a second; the frames themselves never touch React.
  useEffect(() => {
    let since = performance.now();
    const timer = setInterval(() => {
      const at = performance.now();
      setStatus(summary(frames.current, (at - since) / 1000));
      frames.current = [];
      since = at;
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const start = (kind: Animation): void => {
    const base = map.current?.getCamera() ?? defaultCamera;
    running.current = { kind, started: performance.now(), base };
    // The first step: its frame's callback takes the next one, and so on
    // until Stop. A still map asks for nothing.
    if (kind !== 'still') map.current?.setCamera(cameraAt(kind, base, 0.001));
  };

  const onFrame = (stats: MapFrameStats): void => {
    if (failure) setFailure('');
    if (stats.gl) {
      frames.current.push({
        ...stats.gl,
        tiles: stats.tiles,
        zoom: map.current?.getCamera().zoom ?? 0,
      });
    }
    const { kind, started, base } = running.current;
    if (kind === 'still') return;
    map.current?.setCamera(
      cameraAt(kind, base, (performance.now() - started) / 1000),
    );
  };

  const nextBudget = BUDGETS[(BUDGETS.indexOf(budget) + 1) % BUDGETS.length];

  return (
    <window
      width={1200}
      height={880}
      title={`react-x11 GL map — ${place.name}`}
    >
      <box style={{ flexDirection: 'column', flexGrow: 1 }}>
        <box
          style={{
            flexDirection: 'column',
            gap: 6,
            padding: 8,
            backgroundColor: theme.background,
          }}
        >
          <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <text style={{ fontWeight: 600 }}>{place.name}</text>
            <Select
              value={provider.id}
              options={GL_PROVIDERS.map((p) => ({
                value: p.id,
                label: p.label,
              }))}
              onChange={(event) => setProviderId(event.value)}
              style={{ width: 240 }}
            />
            <Button onClick={() => start('pan')}>Pan</Button>
            <Button onClick={() => start('zoom')}>Zoom</Button>
            <Button onClick={() => start('fly')}>Fly</Button>
            <Button onClick={() => start('still')}>Stop</Button>
            <Button onClick={() => setFade(fade ? 0 : 300)}>
              {fade ? `Fade ${fade} ms` : 'Fade off'}
            </Button>
            <Button onClick={() => setBudget(nextBudget)}>
              {budget ? `Adaptive ${budget} ms` : 'Adaptive off'}
            </Button>
            <Button onClick={() => setLabels(!labels)}>
              {labels ? 'Labels on' : 'Labels off'}
            </Button>
            <Button onClick={() => setLiveLabels(!liveLabels)}>
              {liveLabels ? 'Labels live' : 'Labels at rest'}
            </Button>
            <Button onClick={() => setSnap(!snap)}>
              {snap ? 'Numbers in buildings' : 'Numbers as mapped'}
            </Button>
            <Button onClick={() => setAntialias(!antialias)}>
              {antialias ? 'AA on' : 'AA off'}
            </Button>
            <Button onClick={() => setDark(!dark)}>
              {dark ? 'Light' : 'Dark'}
            </Button>
          </box>
          <text style={{ color: failure ? theme.danger : theme.textMuted }}>
            {failure || status || 'drag to pan · wheel or double-click to zoom'}
          </text>
        </box>
        <Map
          renderer="gl"
          ref={map}
          sources={provider.sources}
          mapStyle={styleFor(provider.schema, dark, labels, snap)}
          defaultCamera={defaultCamera}
          antialias={antialias}
          levelFade={fade}
          labelsWhileMoving={liveLabels}
          adaptive={budget ? { budgetMs: budget } : false}
          buildWorkers={2}
          onFrame={onFrame}
          onError={(error) => {
            // The bar has one line and a GL error's hint runs to several, so
            // the line says what failed and stderr carries the whole of it —
            // the same division the tile errors below make.
            const { hint } = error as Error & { hint?: string };
            process.stderr.write(
              `GL failed: ${error.message}\n${hint ? `${hint}\n` : ''}`,
            );
            setFailure(`GL failed: ${error.message}`);
          }}
          // The bar's line is the frame summary, rewritten twice a second, so
          // a provider that is down or wants a key says so here instead.
          onTileError={(error, tile) =>
            process.stderr.write(
              `${provider.id} tile ${tile.z}/${tile.x}/${tile.y}: ` +
                `${error instanceof Error ? error.message : String(error)}\n`,
            )
          }
          style={{ flexGrow: 1 }}
        />
      </box>
    </window>
  );
}

const root = await createRoot({ glPolicy: 'auto' });
root.render(<App />);
