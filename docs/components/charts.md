# Charts

```jsx
import {
  ChartContainer,
  LineChart,
  LineSeries,
  XAxis,
  YAxis,
  CartesianGrid,
  ChartTooltip,
  ChartLegend,
} from '@react-x11/components/charts';

const config = {
  cpu: { label: 'CPU', color: '$accent' },
  mem: { label: 'Memory', color: '#e17055' },
};

<ChartContainer config={config} style={{ height: 240 }}>
  <LineChart data={rows}>
    <CartesianGrid />
    <XAxis dataKey="time" type="time" />
    <YAxis />
    <LineSeries dataKey="cpu" />
    <LineSeries dataKey="mem" curve="monotone" />
    <ChartTooltip />
    <ChartLegend />
  </LineChart>
</ChartContainer>;
```

A [shadcn/charts](https://ui.shadcn.com/charts)-shaped set for cartesian
charts — line, area, bar, scatter — with a cost model you usually do not
get: **every frame is bounded by pixels, never by points**. A million-point
series in a 90px cell is one batched drawing request; a chart scrolled out
of view costs nothing at all, even while its data keeps streaming.
[prd-charts.md](../prd-charts.md) is the design record; this page is the
reference.

The children of a chart are **config carriers, not renderers** — recharts'
own model, and shadcn's. `<LineSeries>`, `<XAxis>`, `<ChartTooltip>` and the
rest render null; the chart wrapper folds their props into one spec for the
single registered element (`<chartplot>`) that paints the grid, both axes
and every series in one clipped pass. `LineChart`, `AreaChart`, `BarChart`
and `ScatterChart` are one cartesian chart under four names: mixing series
kinds — bars under a line — works in any of them.

## Data

`data` takes any of three shapes, recognised by looking:

- **Rows** — `[{ month: 'Jan', desktop: 186, mobile: 80 }, …]`, the shadcn
  shape. Normalised to columns once per array identity and cached, so pass
  the same array while nothing changed.
- **Columns** — `{ length, columns: { t: Float64Array, cpu: Float64Array } }`.
  The fast path: a million points never materialise row objects. Plain
  arrays work too; typed arrays skip the copy.
- **A `ChartData` store** — the streaming case:

```js
const store = new ChartData({ t: 'f64', cpu: 'f64' });
store.append({ t: now, cpu: reading }); // or appendRows([...])
```

Appends extend the decimation index incrementally — nothing rescans — and
notify every mounted chart. A chart whose element is entirely outside its
window's viewport skips even the invalidation; scrolling back repaints from
current data. `NaN` is a gap: the line breaks there and resumes after.

For line and area series, x is assumed sorted ascending (the norm for
series data); unsorted x still draws, in index order. Band (categorical) x
comes from string columns — `dataKey="month"` on the axis.

## Props

`<ChartContainer>`:

| Prop            | Type               | Notes                                                          |
| --------------- | ------------------ | -------------------------------------------------------------- |
| `config`        | `ChartConfig`      | Series key → `{ label, color }`. Colours take CSS or `$token`. |
| `style`         | `Style \| Style[]` | The sizing box — height, width, `flexGrow`.                    |
| `data-testname` | `string`           | For `react-x11/test` queries.                                  |

The chart wrappers (`LineChart`, `AreaChart`, `BarChart`, `ScatterChart`):

| Prop            | Type                               | Notes                                                     |
| --------------- | ---------------------------------- | --------------------------------------------------------- |
| `data`          | `ChartSourceData`                  | Rows, columns, or a `ChartData` store. Required.          |
| `onFrameStats`  | `(stats: ChartFrameStats) => void` | Per painted frame: modes, command counts, bytes, timings. |
| `style`         | `Style \| Style[]`                 | The chart's own box, inside the container.                |
| `data-testname` | `string`                           | For `react-x11/test` queries.                             |

The series (`LineSeries`, `AreaSeries`, `BarSeries`, `ScatterSeries`):

| Prop          | Type                               | Notes                                                                     |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `dataKey`     | `string`                           | The column this series draws, and its config/legend key. Required.        |
| `color`       | `string`                           | Overrides the config colour, then the built-in palette. `$token` allowed. |
| `label`       | `string`                           | Overrides the config label.                                               |
| `strokeWidth` | `number`                           | Line/area stroke. Default 2.                                              |
| `curve`       | `'linear' \| 'monotone' \| 'step'` | Line/area interpolation. Default `'linear'`.                              |
| `dot`         | `boolean \| number`                | Marker dots on line points — a radius, or true for 3. Default off.        |
| `fillOpacity` | `number`                           | Area fill opacity; the stroke stays opaque. Default 0.25.                 |
| `stackId`     | `string`                           | Bar/area series sharing a `stackId` stack in child order.                 |
| `radius`      | `number`                           | Rounded bar corners, value end. Default 0.                                |
| `size`        | `number`                           | Scatter point size in px. Default 2.                                      |

`<XAxis>` / `<YAxis>`:

| Prop            | Type                                   | Notes                                                                                              |
| --------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `dataKey`       | `string`                               | x only: the column holding x values. Absent means the index. A string column is a band axis.       |
| `type`          | `'linear' \| 'time' \| 'band'`         | x only. Default: inferred — `'band'` for string columns, else `'linear'`. `'time'` reads epoch ms. |
| `ticks`         | `number`                               | Target tick count. Default: from the axis length.                                                  |
| `tickFormatter` | `(value) => string`                    | Formats tick labels — and the tooltip's values, unless the tooltip overrides.                      |
| `domain`        | `[number \| 'auto', number \| 'auto']` | Pins an end of the range; `'auto'` keeps that end measured (y includes zero for bars).             |
| `hide`          | `boolean`                              | Drops the labels and the gutter; the scale still applies.                                          |
| `height`        | `number`                               | x only: gutter height under the plot. Default 22.                                                  |
| `width`         | `number \| 'auto'`                     | y only: gutter width. Default `'auto'` — measured from the current domain's tick labels.           |

`<CartesianGrid>` takes `horizontal` / `vertical` booleans (both default
true). `<ChartLegend>` takes `verticalAlign: 'top' | 'bottom'` (default
bottom).

## The tooltip

```jsx
<ChartTooltip
  labelFormatter={(t) => new Date(t).toLocaleTimeString()}
  formatter={(value, id) => `${value.toFixed(1)}%`}
/>
```

Hover snaps to the nearest data point — an O(log n) query through the
element, never a scan — and draws a crosshair, a marker per series, and the
value bubble. The crosshair and markers are hit-transparent boxes inside the
chart; **the bubble is a real `<popup>` window by default**, anchored to the
data point. That is what stacks it above content that flows after the chart
(an in-window box paints in tree order and loses to any later sibling it
leans over), lets it extend past the window's edge, and keeps it out of the
focus order. It hangs on the side of the crosshair away from the pointer,
with hysteresis, so the pointer cannot wander onto it.

| Prop             | Type                              | Notes                                                                                                                                                                                                    |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`           | `'popup' \| 'overlay'`            | Where the bubble lives. Default `'popup'`; `'overlay'` keeps it an in-chart box — one window, one paint surface, right for screenshots — clamped into the chart, with the overdraw trade above accepted. |
| `cursor`         | `boolean`                         | The vertical crosshair. Default true.                                                                                                                                                                    |
| `formatter`      | `(value, id) => string`           | One value row. Default: the y axis's `tickFormatter`.                                                                                                                                                    |
| `labelFormatter` | `(value) => string`               | The header (the x value). Default: the x axis's `tickFormatter`.                                                                                                                                         |
| `content`        | `(hit: TooltipData) => ReactNode` | Replaces the bubble's content entirely; positioning and the chrome stay the chart's.                                                                                                                     |

## Performance

The three guarantees, and where they come from
([prd-charts.md](../prd-charts.md) has the full story):

1. **Off the viewport costs nothing.** Core culls the paint of
   scrolled-away nodes; this package adds that data prep is lazy and that a
   `ChartData` append to a fully offscreen chart skips the invalidation too.
2. **Too small to see costs nothing to draw.** Every series renders through
   a per-pixel-column min/max pyramid: paint reads ~2–4 blocks per pixel
   column at any zoom, so cost follows the pixel width. Sub-2px plots skip
   paint entirely.
3. **Server-side drawing commands, sized by pixels.** Dense line/area frames
   are 1–2 `fillRects` batches (~8 bytes × width); sparse ones a stroked
   path of at most 2×width points; bars one batch per colour; scatter an
   occupancy grid in ≤8 alpha-bucketed batches, flipping to one
   client-built density image only when the grid would out-weigh it
   (`occupied > plotW·plotH/2` — computed, not guessed).

`onFrameStats` reports what a frame actually cost — per-series mode
(`'polyline' | 'minmax' | 'bars' | 'scatter' | 'density'`), drawing
commands, approximate wire bytes, prep and paint milliseconds — and the
demo's HUD is just this prop printed.

## The element

`<chartplot>` (`CHARTPLOT_ELEMENT`) is the one registered element behind
every wrapper; importing anything from `/charts` registers it. A ref on a
chart wrapper is not public API, but the exported `ChartPlotProps`,
`ChartHit` and `ChartFormatters` types describe the element for an app
composing its own wrapper over it.

## Example

`npm run examples:charts` (needs a real `$DISPLAY`) is the demo: a
streaming line chart over a `ChartData` window, the same million points at
full width and as twelve 90px small multiples, grouped/stacked bars (click
to flip), smooth stacked areas, a 200k-point scatter, and a scroll-away
section whose frame counters freeze the moment their chart leaves the
viewport.
