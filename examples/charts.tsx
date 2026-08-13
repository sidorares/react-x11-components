// Run with: npm run examples:charts   (needs an X server / DISPLAY)
//
// A tour of the chart set, arranged to make the performance design visible
// rather than claimed:
//
//  - the streaming section appends 60 points a second into a windowed
//    `ChartData`; the pyramid extends incrementally, so the cost per tick
//    is the append, not a rescan;
//  - the million-point section draws 2,000,000 points per frame's worth of
//    data through per-column min/max spans — watch the HUD: one or two
//    batched requests, a few kilobytes on the wire, whatever the zoom;
//  - the small-multiples row shows the same cost model at 90px wide: cost
//    follows pixels, so a tiny chart is a tiny cost;
//  - scroll any chart out of view and its frame counter freezes — an
//    invisible chart neither paints nor schedules frames, even while its
//    store keeps appending.
//
// Every chart reports `onFrameStats`; the HUD under each one prints the
// last frame's mode, span, command count and estimated wire bytes.
import { useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createRoot } from 'react-x11';

import {
  AreaChart,
  AreaSeries,
  BarChart,
  BarSeries,
  CartesianGrid,
  ChartContainer,
  ChartData,
  ChartLegend,
  ChartTooltip,
  LineChart,
  LineSeries,
  ScatterChart,
  ScatterSeries,
  XAxis,
  YAxis,
} from '../src/index.js';
import type {
  ChartConfig,
  ChartFrameStats,
  ChartPlotHandle,
} from '../src/index.js';

// --- shared bits -----------------------------------------------------------

function Section(props: {
  title: string;
  blurb: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <box style={{ flexDirection: 'column', gap: 6, flexShrink: 0 }}>
      <text style={{ fontSize: 15, color: '$text' }}>{props.title}</text>
      <text style={{ fontSize: 11, color: '$textMuted' }}>{props.blurb}</text>
      {props.children}
    </box>
  );
}

/** One line of truth per chart: what the last painted frame actually cost. */
function useHud(): {
  onFrameStats: (s: ChartFrameStats) => void;
  hud: ReactElement;
} {
  const [line, setLine] = useState('waiting for a frame…');
  const frames = useRef(0);
  const last = useRef(0);
  const onFrameStats = (s: ChartFrameStats) => {
    frames.current++;
    const t = Date.now();
    if (t - last.current < 250) return; // calm the readout, not the chart
    last.current = t;
    const modes = s.series.map((x) => `${x.id}:${x.mode}`).join(' ');
    setLine(
      `frame #${frames.current}  ${modes}  span ${s.pointsSpanned.toLocaleString()} pts` +
        `  ${s.commands} cmds  ~${(s.estimatedWireBytes / 1024).toFixed(1)}KB` +
        `  prep ${s.prepMs.toFixed(1)}ms paint ${s.paintMs.toFixed(1)}ms`,
    );
  };
  const hud = (
    <text
      style={{ fontSize: 10, color: '$textMuted', fontFamily: '$monoFamily' }}
    >
      {line}
    </text>
  );
  return { onFrameStats, hud };
}

// --- 1. streaming ----------------------------------------------------------

// A time window, not just a count window: an occluded app's timers are
// *throttled* rather than stopped (no per-tick gap a heuristic could see),
// and a count window would keep that minutes-wide, points-thin era —
// squeezing the fresh data into a sliver until it evicts. maxAge drops
// anything older than a minute on the first append after resume, hard
// stalls included.
const telemetry = new ChartData({
  maxLength: 3000,
  maxAge: { key: 't', ms: 60_000 },
});
let phase = 0;
setInterval(() => {
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    phase += 0.02;
    telemetry.append({
      t: now,
      cpu: 35 + 25 * Math.sin(phase) + Math.random() * 8,
      mem: 55 + 12 * Math.sin(phase / 3 + 1) + Math.random() * 3,
    });
  }
}, 50);

const telemetryConfig = {
  cpu: { label: 'CPU %', color: '$accent' },
  mem: { label: 'Memory %', color: '#e17055' },
} satisfies ChartConfig;

function Streaming(): ReactElement {
  const { onFrameStats, hud } = useHud();
  return (
    <Section
      title="Streaming"
      blurb="60 points/s into a 3,000-point window. Appends extend the decimation pyramid; nothing rescans."
    >
      <ChartContainer config={telemetryConfig} style={{ height: 220 }}>
        <LineChart data={telemetry} onFrameStats={onFrameStats}>
          <CartesianGrid />
          <XAxis dataKey="t" type="time" />
          <YAxis width={38} domain={[0, 100]} />
          <LineSeries dataKey="cpu" />
          <LineSeries dataKey="mem" />
          <ChartTooltip />
          <ChartLegend />
        </LineChart>
      </ChartContainer>
      {hud}
    </Section>
  );
}

// --- 2. a million points ---------------------------------------------------

const MILLION = 1_000_000;
const million = new Float64Array(MILLION);
{
  let v = 0;
  for (let i = 0; i < MILLION; i++) {
    v += (Math.random() - 0.5) * 2;
    million[i] =
      v +
      40 * Math.sin(i / 40_000) +
      8 * Math.sin(i / 900) * Math.sin(i / 90_000);
  }
}
const millionData = { length: MILLION, columns: { walk: million } };

const MILLION_FULL: readonly [number, number] = [0, MILLION - 1];
const MIN_ZOOM_SPAN = 64;

function ZoomButton(props: {
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <box
      onClick={props.onClick}
      style={{
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 3,
        paddingBottom: 3,
        borderWidth: 1,
        borderColor: '$border',
        borderRadius: 5,
        backgroundColor: '$surface',
      }}
    >
      <text style={{ fontSize: 12, color: '$text' }}>{props.label}</text>
    </box>
  );
}

function Million(): ReactElement {
  const { onFrameStats, hud } = useHud();
  // pan + zoom = a controlled x domain, in data units (indices here).
  // null means "the whole series".
  const [domain, setDomain] = useState<readonly [number, number] | null>(null);
  const plot = useRef<ChartPlotHandle | null>(null);
  const drag = useRef<{
    startX: number;
    d: readonly [number, number];
    perPx: number;
  } | null>(null);

  const clamp = (a: number, b: number): readonly [number, number] | null => {
    const span = b - a;
    if (span >= MILLION - 1) return null; // fully out = back to auto
    let lo = a;
    if (lo < 0) lo = 0;
    if (lo + span > MILLION - 1) lo = MILLION - 1 - span;
    return [lo, lo + span];
  };
  const zoom = (factor: number) => {
    const [a, b] = domain ?? MILLION_FULL;
    const mid = (a + b) / 2;
    const half = Math.max(MIN_ZOOM_SPAN / 2, ((b - a) / 2) * factor);
    setDomain(clamp(mid - half, mid + half));
  };

  return (
    <Section
      title="One million points"
      blurb="Per-pixel-column min/max through the pyramid keeps every frame O(width) at any zoom. Drag to pan; the buttons zoom around the centre."
    >
      <box style={{ flexDirection: 'row', gap: 8 }}>
        <ZoomButton label="Zoom in" onClick={() => zoom(0.5)} />
        <ZoomButton label="Zoom out" onClick={() => zoom(2)} />
        {domain ? (
          <ZoomButton label="Reset" onClick={() => setDomain(null)} />
        ) : null}
      </box>
      <box
        style={{ flexDirection: 'column' }}
        onMouseDown={(ev) => {
          // the hit carries the plot rect and the snap — everything a
          // pixels→indices conversion needs (see ChartPlotHandle)
          const hit = plot.current?.hitAt(ev.x);
          if (!hit) return;
          const d = domain ?? MILLION_FULL;
          drag.current = {
            startX: ev.x,
            d,
            perPx: (d[1] - d[0]) / Math.max(1, hit.plot.width),
          };
        }}
        onMouseMove={(ev) => {
          const g = drag.current;
          if (!g) return;
          const shift = (g.startX - ev.x) * g.perPx;
          setDomain(clamp(g.d[0] + shift, g.d[1] + shift));
        }}
        onMouseUp={() => {
          drag.current = null;
        }}
        onMouseLeave={() => {
          drag.current = null;
        }}
      >
        <ChartContainer
          config={{ walk: { label: 'random walk', color: '#00b894' } }}
          style={{ height: 220 }}
        >
          <LineChart
            data={millionData}
            onFrameStats={onFrameStats}
            plotRef={plot}
          >
            <CartesianGrid />
            <XAxis domain={domain ? [domain[0], domain[1]] : undefined} />
            <YAxis width={44} />
            <LineSeries dataKey="walk" strokeWidth={1} />
            <ChartTooltip />
          </LineChart>
        </ChartContainer>
      </box>
      {hud}
    </Section>
  );
}

// --- 3. small multiples ----------------------------------------------------

function SmallMultiples(): ReactElement {
  const [totalCmds, setTotal] = useState(0);
  const sum = useRef(0);
  const lastShown = useRef(0);
  const onFrameStats = (s: ChartFrameStats) => {
    sum.current += s.commands;
    const t = Date.now();
    if (t - lastShown.current < 300) return;
    lastShown.current = t;
    setTotal(sum.current);
  };
  return (
    <Section
      title="Small multiples"
      blurb="The same million points, twelve times, 90px wide each: cost follows pixels, so small is cheap."
    >
      <box style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {Array.from({ length: 12 }, (_, i) => (
          <ChartContainer key={i} style={{ width: 90, height: 44 }}>
            <LineChart data={millionData} onFrameStats={onFrameStats}>
              <XAxis hide />
              <YAxis hide />
              <LineSeries
                dataKey="walk"
                strokeWidth={1}
                color={i % 2 ? '#e17055' : '$accent'}
              />
            </LineChart>
          </ChartContainer>
        ))}
      </box>
      <text
        style={{ fontSize: 10, color: '$textMuted', fontFamily: '$monoFamily' }}
      >
        {`${totalCmds} drawing commands total, across every repaint of all twelve`}
      </text>
    </Section>
  );
}

// --- 4. bars ---------------------------------------------------------------

const revenue = [
  { month: 'Jan', desktop: 186, mobile: 80 },
  { month: 'Feb', desktop: 305, mobile: 200 },
  { month: 'Mar', desktop: 237, mobile: 120 },
  { month: 'Apr', desktop: 73, mobile: 190 },
  { month: 'May', desktop: 209, mobile: 130 },
  { month: 'Jun', desktop: 214, mobile: 140 },
];

const revenueConfig = {
  desktop: { label: 'Desktop', color: '$accent' },
  mobile: { label: 'Mobile', color: '#8e6be8' },
} satisfies ChartConfig;

function Bars(): ReactElement {
  const [stacked, setStacked] = useState(false);
  return (
    <Section
      title="Bars"
      blurb="Grouped or stacked — one batched request per series either way. Click the chart to flip. This tooltip opts into mode='overlay' (an in-chart box); every other chart here uses the default popup window, which stacks above the sections that follow."
    >
      <box onClick={() => setStacked((s) => !s)}>
        <ChartContainer config={revenueConfig} style={{ height: 200 }}>
          <BarChart data={revenue}>
            <CartesianGrid />
            <XAxis dataKey="month" />
            <YAxis width={38} />
            <BarSeries
              dataKey="desktop"
              radius={3}
              stackId={stacked ? 'a' : undefined}
            />
            <BarSeries
              dataKey="mobile"
              radius={3}
              stackId={stacked ? 'a' : undefined}
            />
            <ChartTooltip mode="overlay" />
            <ChartLegend />
          </BarChart>
        </ChartContainer>
      </box>
    </Section>
  );
}

// --- 5. stacked areas ------------------------------------------------------

const traffic = Array.from({ length: 120 }, (_, i) => ({
  day: i,
  organic: 40 + 20 * Math.sin(i / 9) + 12 * Math.sin(i / 3.1) + 25,
  referral: 25 + 12 * Math.sin(i / 13 + 2) + 15,
  ads: 15 + 9 * Math.sin(i / 6 + 4) + 10,
}));

const trafficConfig = {
  organic: { label: 'Organic', color: '$accent' },
  referral: { label: 'Referral', color: '#00b894' },
  ads: { label: 'Ads', color: '#fdcb6e' },
} satisfies ChartConfig;

function Areas(): ReactElement {
  return (
    <Section
      title="Stacked areas"
      blurb="Monotone curves; each layer's base is the layer below, so the seams are exact."
    >
      <ChartContainer config={trafficConfig} style={{ height: 220 }}>
        <AreaChart data={traffic}>
          <CartesianGrid />
          <XAxis dataKey="day" />
          <YAxis width={38} />
          <AreaSeries
            dataKey="organic"
            stackId="t"
            curve="monotone"
            fillOpacity={0.35}
          />
          <AreaSeries
            dataKey="referral"
            stackId="t"
            curve="monotone"
            fillOpacity={0.35}
          />
          <AreaSeries
            dataKey="ads"
            stackId="t"
            curve="monotone"
            fillOpacity={0.35}
          />
          <ChartTooltip />
          <ChartLegend />
        </AreaChart>
      </ChartContainer>
    </Section>
  );
}

// --- 6. scatter ------------------------------------------------------------

const CLOUD = 200_000;
const cloudX = new Float64Array(CLOUD);
const cloudY = new Float64Array(CLOUD);
{
  const gauss = () =>
    (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;
  for (let i = 0; i < CLOUD; i++) {
    const arm = i % 3;
    cloudX[i] = gauss() * 30 + (arm - 1) * 45;
    cloudY[i] = gauss() * 22 + (arm - 1) * 18 + cloudX[i] * 0.25;
  }
}
const cloudData = { length: CLOUD, columns: { x: cloudX, y: cloudY } };

function Cloud(): ReactElement {
  const { onFrameStats, hud } = useHud();
  return (
    <Section
      title="Scatter, 200k points"
      blurb="Points reduce to an occupancy grid — coincident points are one cell, counts become alpha. Past half coverage it would ship as one density image instead of rectangles."
    >
      <ChartContainer
        config={{ y: { label: 'sample', color: '$accent' } }}
        style={{ height: 240 }}
      >
        <ScatterChart data={cloudData} onFrameStats={onFrameStats}>
          <CartesianGrid vertical />
          <XAxis dataKey="x" />
          <YAxis width={40} />
          <ScatterSeries dataKey="y" size={2} />
        </ScatterChart>
      </ChartContainer>
      {hud}
    </Section>
  );
}

// --- the app ---------------------------------------------------------------

function App(): ReactElement {
  return (
    <window width={860} height={720} title="charts — @react-x11/components">
      <box
        style={{
          flexGrow: 1,
          flexDirection: 'column',
          overflow: 'scroll',
          padding: 16,
          gap: 24,
        }}
      >
        <text style={{ fontSize: 11, color: '$textMuted' }}>
          Scroll. Charts outside the viewport stop painting — their frame
          counters freeze even while the streaming store keeps appending.
        </text>
        <Streaming />
        <Million />
        <SmallMultiples />
        <Bars />
        <Areas />
        <Cloud />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
