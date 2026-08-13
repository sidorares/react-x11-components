// Type-level test: the chart declarations compile against react-x11's JSX
// namespace — the shadcn-shaped composition, the config type, the data
// shapes, and the raw element the module augmentation adds.
import {
  ChartContainer,
  LineChart,
  BarChart,
  ScatterChart,
  LineSeries,
  AreaSeries,
  BarSeries,
  ScatterSeries,
  XAxis,
  YAxis,
  CartesianGrid,
  ChartTooltip,
  ChartLegend,
  ChartData,
} from '../../src/index.js';
import type {
  ChartConfig,
  ChartFrameStats,
  ChartSourceData,
} from '../../src/index.js';

const config = {
  cpu: { label: 'CPU', color: '$accent' },
  mem: { label: 'Memory', color: '#e17055' },
} satisfies ChartConfig;

const rows = [
  { t: 0, cpu: 10, mem: 60 },
  { t: 1000, cpu: 14, mem: 58 },
];

export const composed = (
  <ChartContainer config={config} style={{ height: 240 }}>
    <LineChart
      data={rows}
      onFrameStats={(s: ChartFrameStats) => void s.commands}
    >
      <CartesianGrid vertical={false} />
      <XAxis dataKey="t" type="time" tickFormatter={(v) => String(v)} />
      <YAxis width={44} domain={[0, 'auto']} />
      <LineSeries dataKey="cpu" curve="monotone" dot />
      <AreaSeries dataKey="mem" fillOpacity={0.2} stackId="a" />
      <ChartTooltip
        formatter={(value, id) => `${id}: ${value.toFixed(1)}`}
        labelFormatter={(v) => String(v)}
        mode="overlay"
      />
      <ChartLegend verticalAlign="bottom" />
    </LineChart>
  </ChartContainer>
);

// columnar and streaming data shapes both satisfy the data prop
const columnar: ChartSourceData = {
  length: 3,
  columns: { y: new Float64Array([1, 2, 3]), tag: ['a', 'b', 'c'] },
};
const store: ChartSourceData = new ChartData({ maxLength: 10_000 });

export const columnarChart = (
  <ScatterChart data={columnar}>
    <ScatterSeries dataKey="y" size={2} />
  </ScatterChart>
);

export const barChart = (
  <BarChart data={store}>
    <XAxis dataKey="tag" />
    <BarSeries dataKey="y" radius={3} stackId="s" />
  </BarChart>
);

// importing the components teaches JSX the element too
export const asElement = (
  <chartplot
    spec={{
      series: [],
      x: {
        key: null,
        type: 'auto',
        ticks: 5,
        domain: ['auto', 'auto'],
        hide: false,
        width: 'auto',
        height: 22,
      },
      y: {
        key: null,
        type: 'linear',
        ticks: 5,
        domain: ['auto', 'auto'],
        hide: false,
        width: 'auto',
        height: 0,
      },
      grid: null,
    }}
    data={rows}
    style={{ width: 200, height: 100 }}
  />
);

// @ts-expect-error a series needs its dataKey
export const missingKey = <LineSeries />;

export const missingData = (
  // @ts-expect-error data is required on a chart
  <LineChart>
    <LineSeries dataKey="y" />
  </LineChart>
);

// @ts-expect-error curve names are a closed set
export const badCurve = <LineSeries dataKey="y" curve="wiggly" />;

// @ts-expect-error legend alignment is top or bottom
export const badAlign = <ChartLegend verticalAlign="left" />;

// @ts-expect-error tooltip modes are popup or overlay
export const badMode = <ChartTooltip mode="fixed" />;
