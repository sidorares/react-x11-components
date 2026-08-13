// Charts — shadcn-shaped composition over one registered element that
// paints with cost bounded by pixels, not points. `docs/prd-charts.md` is
// the design record; the pieces:
//
//  - `data.ts` — column resolution, the streaming `ChartData` store, the
//    min/max pyramid and x-index (pure, display-free);
//  - `scale.ts` — linear/band scales, nice/time ticks (pure);
//  - `render.ts` — the series renderers and the command-vs-pixels policy;
//  - `node.ts` — the `<chartplot>` retained node: one paint pass for grid,
//    axes and series, plus the tooltip's hit answers;
//  - `components.ts` — `ChartContainer`, the chart wrappers and the
//    config-carrier children.
//
// **Registration happens when this module is evaluated** — the sparkline
// pattern, and the one side effect tree-shaking relies on being here and
// nowhere shallower.
import { registerElement, registeredElements } from 'react-x11/host';

// Loads the module the JSX augmentation below targets; nothing in `src/`
// writes JSX, so without this the build never resolves the module being
// augmented. Type-only, erased, costs no bundle.
import type {} from 'react-x11/jsx-runtime';

import { ChartPlotNode, ELEMENT } from './node.js';
import type { ChartPlotProps } from './node.js';

// Idempotent for the same reason the sparkline's is: two copies of this
// package in one app (a lockfile skew) should not fail to boot over a name
// both of them mean the same thing by.
if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new ChartPlotNode(props, app),
    // `data` and `spec` are not style names today, but `color`-adjacent
    // vocabulary has drifted into styles before; declaring everything the
    // element reads keeps a future style name from turning these props
    // into DEV throws (AGENTS.md, "Gotchas").
    semanticNames: ['spec', 'data', 'formatters'],
    childrenAllowed: false,
  });
}

export {
  ChartContainer,
  LineChart,
  AreaChart,
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
} from './components.js';
export type {
  ChartContainerProps,
  CartesianChartProps,
  SeriesProps,
  XAxisProps,
  YAxisProps,
  CartesianGridProps,
  ChartTooltipProps,
  ChartLegendProps,
  TooltipData,
} from './components.js';

export { ChartData, isChartDataLike } from './data.js';
export type {
  ChartDataOptions,
  ChartDataChange,
  ChartDataLike,
  ChartRow,
  ColumnarData,
  ChartSourceData,
} from './data.js';

export type { ChartConfig, ChartFrameStats } from './spec.js';
export type { ChartPlotProps, ChartHit, ChartFormatters } from './node.js';

/** The host element name, for apps that would rather write `<chartplot>`. */
export { ELEMENT as CHARTPLOT_ELEMENT };

// Importing any chart component teaches JSX the element too — the module
// augmentation shape react-x11's docs/typescript.md prescribes.
declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      chartplot: ChartPlotProps & {
        onMouseMove?: (ev: { x: number; y: number }) => void;
        onMouseLeave?: (ev: { x: number; y: number }) => void;
      };
    }
  }
}
