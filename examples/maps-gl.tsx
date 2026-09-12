// `<GlMap>`, the GL map proof of concept: every frame drawn from vector
// tiles on the GPU, with no bitmap cache anywhere.
//
//   npm run examples:maps-gl                     # London: corpus tiles, else the network
//   npm run examples:maps-gl -- tokyo --dark     # or manhattan, pacific
//   npm run examples:maps-gl -- --offline        # the bench corpus only
//   npm run examples:maps-gl -- --online         # OpenStreetMap's servers only
//   npm run examples:maps-gl -- --zoom=16.5      # start closer (street names are 14+)
//   npm run examples:maps-gl -- --no-labels      # start with labels off
//
// The corpus is `scripts/bench/tiles.ts`'s cache; without it the tiles come
// from `vector.openstreetmap.org`, identified the way its usage policy asks.
// On X11 this needs the direct GL backend (the root below asks for it); on
// the Cocoa backend GL is always direct.
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
import { Button, createRoot, useTheme } from 'react-x11';

import {
  osmVectorSource,
  project,
  shortbreadStyle,
  unproject,
  worldSize,
} from '../src/maps/index.js';
import type { LngLat, MapCamera, MapSource } from '../src/maps/index.js';
import { GlMap } from '../src/maps/gl/view.js';
import type { GlMapFrameStats, GlMapHandle } from '../src/maps/gl/view.js';
import { cachePath } from '../scripts/bench/tiles.js';

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

const osm = osmVectorSource({
  fetch: async (url, signal) => {
    const response = await fetch(url, {
      signal: signal as AbortSignal | undefined,
      headers: {
        'user-agent':
          'react-x11-components-example/0.1 (+https://github.com/sidorares/react-x11-components)',
      },
    });
    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  },
});

/** The bench corpus where it has the tile, the network where it does not. */
const source: MapSource = {
  id: 'osm-vector',
  minZoom: 0,
  maxZoom: 14,
  tileSize: 512,
  attribution: osm.attribution,
  async load(request) {
    if (!online) {
      const file = cachePath(request);
      if (existsSync(file)) {
        const bytes = new Uint8Array(await readFile(file));
        return bytes.length > 0 ? { kind: 'vector', data: bytes } : null;
      }
      if (offline) return null;
    }
    return osm.load(request);
  },
};
const sources = [source];
const light = shortbreadStyle();
const darkStyle = shortbreadStyle({ dark: true });
const defaultCamera: MapCamera = {
  center: place.centre,
  zoom: Number.isFinite(zoomArg) ? zoomArg : place.zoom,
};

type Animation = 'still' | 'pan' | 'zoom' | 'fly';

/** The adaptive budgets the button steps through, in milliseconds; 0 is off. */
const BUDGETS = [0, 12, 6, 3] as const;

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

function summary(frames: GlMapFrameStats[], seconds: number): string {
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
    `z${last.camera.zoom.toFixed(2)} (level ${last.level})`,
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
  const map = useRef<GlMapHandle>(null);
  const [animation, setAnimation] = useState<Animation>('still');
  const [dark, setDark] = useState(args.includes('--dark'));
  const [antialias, setAntialias] = useState(true);
  const [fade, setFade] = useState(0);
  const [budget, setBudget] = useState<(typeof BUDGETS)[number]>(0);
  const [labels, setLabels] = useState(!args.includes('--no-labels'));
  const [status, setStatus] = useState('');
  const frames = useRef<GlMapFrameStats[]>([]);
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
    setAnimation(kind);
    map.current?.invalidate();
  };

  const onFrame = (stats: GlMapFrameStats): void => {
    frames.current.push(stats);
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
            <Button onClick={() => setAntialias(!antialias)}>
              {antialias ? 'AA on' : 'AA off'}
            </Button>
            <Button onClick={() => setDark(!dark)}>
              {dark ? 'Light' : 'Dark'}
            </Button>
          </box>
          <text style={{ color: theme.textMuted }}>
            {status || 'drag to pan · wheel or double-click to zoom'}
          </text>
        </box>
        <GlMap
          ref={map}
          sources={sources}
          mapStyle={dark ? darkStyle : light}
          defaultCamera={defaultCamera}
          frameLoop={animation === 'still' ? 'demand' : 'always'}
          antialias={antialias}
          levelFade={fade}
          adaptive={budget ? { budgetMs: budget } : false}
          labels={labels}
          buildWorkers={2}
          onFrame={onFrame}
          style={{ flexGrow: 1 }}
        />
      </box>
    </window>
  );
}

const root = await createRoot({ glPolicy: 'auto' });
root.render(<App />);
