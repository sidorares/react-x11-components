// The React layer: the shadcn-shaped composition over `<chartplot>`.
//
// The children of a chart wrapper are **config carriers, not renderers** —
// recharts' own model. `<LineSeries>`, `<XAxis>`, `<CartesianGrid>`,
// `<ChartTooltip>` and the rest render null; the wrapper walks its children
// with `React.Children`, folds their props into one `PlotSpec`, and renders
// the single element that paints everything. What stays real composition is
// what benefits from it: the legend row, and the hover machinery — a
// hit-transparent crosshair and marker dots inside the chart, and a value
// bubble whose home is a policy (`ChartTooltip mode`): a real anchored
// `<popup>` window by default, an in-chart box on request. See
// renderTooltipBubble for why.
//
// Two identity rules keep interaction cheap, and they are the point of
// this file's plumbing:
//
//  - `spec` is memoized on a serialized key of everything JSON-able in the
//    children, so re-renders (hover state!) hand the element the same
//    object and the React commit contributes no damage of its own — what
//    repaints on hover is only the overlays' damage strips, at the plot's
//    usual pixel-bounded cost;
//  - formatters live in ONE mutable object per chart whose identity never
//    changes; paint reads the current fields. The trade, documented on
//    `ChartFormatters`: changing a formatter's *meaning* alone does not
//    repaint until something else does. Inline arrows stay free.

import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useTheme } from 'react-x11';
import type { Style } from 'react-x11/style';

/** What `style` props here accept — the `Style | Style[]` the rest of the
 * package's components take. */
type StyleInput = Style | Style[];

import { hx } from './hx.js';
import type { ChartFormatters, ChartHit, ChartPlotNode } from './node.js';
import { ELEMENT } from './node.js';
import type { ChartDataLike, ChartSourceData } from './data.js';
import { isChartDataLike } from './data.js';
import { formatTimeTick } from './scale.js';
import type {
  AxisSpec,
  AxisType,
  ChartConfig,
  ChartFrameStats,
  CurveKind,
  GridSpec,
  PlotSpec,
  SeriesSpec,
  SeriesType,
} from './spec.js';
import { DEFAULT_PALETTE, SPEC_DEFAULTS } from './spec.js';

const h = React.createElement;

// --- container -------------------------------------------------------------

const ConfigContext = React.createContext<ChartConfig>({});

export interface ChartContainerProps {
  /** Series key → label and colour, the shadcn shape. */
  config?: ChartConfig;
  style?: StyleInput;
  /** Names the root box for `react-x11/test`'s queries. */
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * Carries the `ChartConfig` and the sizing box. Charts inside read their
 * labels and colours from it by series key.
 */
export function ChartContainer(props: ChartContainerProps): ReactElement {
  return h(
    ConfigContext.Provider,
    { value: props.config ?? {} },
    hx(
      'box',
      {
        style: [{ flexDirection: 'column' }, props.style],
        'data-testname': props['data-testname'],
      },
      props.children,
    ),
  );
}

// --- config-carrier children ----------------------------------------------

export interface SeriesProps {
  /** The column this series draws, and its config/legend key. */
  dataKey: string;
  /** Overrides the config/palette colour. `$token` allowed. */
  color?: string;
  label?: string;
  strokeWidth?: number;
  /** Area fill opacity (the stroke stays opaque). */
  fillOpacity?: number;
  curve?: CurveKind;
  /** Marker dots on line points: a radius, or true for the default 3. */
  dot?: boolean | number;
  /** Series sharing a stackId stack in child order (bar/area). */
  stackId?: string;
  /** Rounded bar corners on the value end. */
  radius?: number;
  /** Scatter point size in px. */
  size?: number;
}

/* The series/axis/grid/tooltip/legend components render nothing: the chart
 * wrapper introspects them by element type. Each keeps a display name so a
 * child the wrapper does not recognise can be reported usefully. */

export function LineSeries(_props: SeriesProps): null {
  return null;
}
export function AreaSeries(_props: SeriesProps): null {
  return null;
}
export function BarSeries(_props: SeriesProps): null {
  return null;
}
export function ScatterSeries(_props: SeriesProps): null {
  return null;
}

export interface XAxisProps {
  /** The column holding x values. Absent means "the index". */
  dataKey?: string;
  type?: AxisType;
  ticks?: number;
  tickFormatter?: (value: number | string) => string;
  domain?: [number | 'auto', number | 'auto'];
  hide?: boolean;
  /** Reserved gutter height under the plot. */
  height?: number;
}

export function XAxis(_props: XAxisProps): null {
  return null;
}

export interface YAxisProps {
  ticks?: number;
  tickFormatter?: (value: number) => string;
  domain?: [number | 'auto', number | 'auto'];
  hide?: boolean;
  /** Reserved gutter width; 'auto' measures the tick labels. */
  width?: number | 'auto';
}

export function YAxis(_props: YAxisProps): null {
  return null;
}

export interface CartesianGridProps {
  horizontal?: boolean;
  vertical?: boolean;
}

export function CartesianGrid(_props: CartesianGridProps): null {
  return null;
}

export interface ChartTooltipProps {
  /** Format one value row. Default: the y tick formatter's rendering. */
  formatter?: (value: number, id: string) => string;
  /** Format the header (the x value at the pointer). */
  labelFormatter?: (value: number | string) => string;
  /** Draw the vertical crosshair. Default true. */
  cursor?: boolean;
  /** Replace the bubble entirely. */
  content?: (hit: TooltipData) => ReactNode;
  /**
   * Where the bubble lives.
   *
   * `'popup'` (the default) is a real override-redirect window anchored to
   * the data point — it stacks above everything in the app (content that
   * flows after the chart included), may extend past the window's edge,
   * and never takes focus. `'overlay'` keeps the bubble as a box inside
   * the chart, clamped to the plot: no extra window, one paint surface —
   * for screenshots and tests, or an app that dislikes tooltip windows.
   * The crosshair and the point markers are part of the plot and stay
   * in-window in both modes.
   */
  mode?: 'popup' | 'overlay';
}

export function ChartTooltip(_props: ChartTooltipProps): null {
  return null;
}

export interface ChartLegendProps {
  verticalAlign?: 'top' | 'bottom';
}

export function ChartLegend(_props: ChartLegendProps): null {
  return null;
}

/** What a custom tooltip `content` receives. */
export interface TooltipData {
  xValue: number | string;
  points: { id: string; label: string; color: string; value: number }[];
}

/**
 * The imperative handle `plotRef` exposes: the snap-to-nearest query the
 * tooltip itself uses. It is also the primitive an app builds pan and zoom
 * gestures on — the hit carries the plot rect (for pixels→domain-units)
 * and the x value under any window x, so a drag handler needs nothing
 * else from the chart's internals. The x asked for and every pixel in the
 * answer are **logical** window pixels — the unit a mouse event's `x`
 * arrives in, whatever the display scale.
 */
export interface ChartPlotHandle {
  hitAt(x: number): ChartHit | null;
}

// --- child introspection ---------------------------------------------------

const SERIES_TYPES = new Map<unknown, SeriesType>([
  [LineSeries, 'line'],
  [AreaSeries, 'area'],
  [BarSeries, 'bar'],
  [ScatterSeries, 'scatter'],
]);

interface Introspected {
  series: { type: SeriesType; props: SeriesProps }[];
  xAxis: XAxisProps | null;
  yAxis: YAxisProps | null;
  grid: CartesianGridProps | null;
  tooltip: ChartTooltipProps | null;
  legend: ChartLegendProps | null;
}

function introspect(children: ReactNode): Introspected {
  const out: Introspected = {
    series: [],
    xAxis: null,
    yAxis: null,
    grid: null,
    tooltip: null,
    legend: null,
  };
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const type = child.type;
    const seriesType = SERIES_TYPES.get(type);
    if (seriesType) {
      out.series.push({
        type: seriesType,
        props: child.props as SeriesProps,
      });
    } else if (type === XAxis) out.xAxis = child.props as XAxisProps;
    else if (type === YAxis) out.yAxis = child.props as YAxisProps;
    else if (type === CartesianGrid)
      out.grid = child.props as CartesianGridProps;
    else if (type === ChartTooltip)
      out.tooltip = child.props as ChartTooltipProps;
    else if (type === ChartLegend) out.legend = child.props as ChartLegendProps;
    // anything else is silently ignored, recharts-style: a chart's children
    // are declarations, and there is nowhere sensible to render a stray box
  });
  return out;
}

function buildSpec(parts: Introspected, config: ChartConfig): PlotSpec {
  const series: SeriesSpec[] = parts.series.map((s, i) => {
    const conf = config[s.props.dataKey] ?? {};
    return {
      id: s.props.dataKey,
      type: s.type,
      color:
        s.props.color ??
        conf.color ??
        DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
      label: s.props.label ?? conf.label ?? s.props.dataKey,
      strokeWidth: s.props.strokeWidth ?? SPEC_DEFAULTS.strokeWidth,
      fillOpacity: s.props.fillOpacity ?? SPEC_DEFAULTS.fillOpacity,
      curve: s.props.curve ?? 'linear',
      dot:
        s.props.dot === true
          ? 3
          : s.props.dot === false || s.props.dot === undefined
            ? false
            : s.props.dot,
      stackId: s.props.stackId ?? null,
      barRadius: s.props.radius ?? 0,
      size: s.props.size ?? SPEC_DEFAULTS.scatterSize,
    };
  });
  const x: AxisSpec = {
    key: parts.xAxis?.dataKey ?? null,
    type: parts.xAxis?.type ?? 'auto',
    ticks: parts.xAxis?.ticks ?? SPEC_DEFAULTS.ticks,
    domain: parts.xAxis?.domain ?? ['auto', 'auto'],
    hide: parts.xAxis?.hide ?? false,
    width: 'auto',
    height: parts.xAxis?.height ?? SPEC_DEFAULTS.xAxisHeight,
  };
  const y: AxisSpec = {
    key: null,
    type: 'linear',
    ticks: parts.yAxis?.ticks ?? SPEC_DEFAULTS.ticks,
    domain: parts.yAxis?.domain ?? ['auto', 'auto'],
    hide: parts.yAxis?.hide ?? false,
    width: parts.yAxis?.width ?? 'auto',
    height: 0,
  };
  const grid: GridSpec | null = parts.grid
    ? {
        horizontal: parts.grid.horizontal ?? true,
        vertical: parts.grid.vertical ?? false,
      }
    : null;
  return { series, x, y, grid };
}

/** Everything JSON-able that shapes the spec — the memo key. Functions and
 * the data stay out; they have their own channels. */
function specKey(parts: Introspected, config: ChartConfig): string {
  return JSON.stringify([
    parts.series.map((s) => [
      s.type,
      s.props.dataKey,
      s.props.color,
      s.props.label,
      s.props.strokeWidth,
      s.props.fillOpacity,
      s.props.curve,
      s.props.dot,
      s.props.stackId,
      s.props.radius,
      s.props.size,
    ]),
    parts.xAxis && [
      parts.xAxis.dataKey,
      parts.xAxis.type,
      parts.xAxis.ticks,
      parts.xAxis.domain,
      parts.xAxis.hide,
      parts.xAxis.height,
    ],
    parts.yAxis && [
      parts.yAxis.ticks,
      parts.yAxis.domain,
      parts.yAxis.hide,
      parts.yAxis.width,
    ],
    parts.grid && [parts.grid.horizontal, parts.grid.vertical],
    config,
  ]);
}

// --- the chart wrappers ----------------------------------------------------

export interface CartesianChartProps {
  /** Rows, columns, or a `ChartData` store. */
  data: ChartSourceData;
  /** Per painted frame: modes, command counts, wire bytes, timings. */
  onFrameStats?: (stats: ChartFrameStats) => void;
  /** The imperative snap query, for app gestures — pan, zoom, brushing. */
  plotRef?: React.Ref<ChartPlotHandle | null>;
  style?: StyleInput;
  /** Names the chart's root box for `react-x11/test`'s queries. */
  'data-testname'?: string;
  children?: ReactNode;
}

interface HoverState {
  hit: ChartHit;
  /** the element's window rect when the hit was taken, in logical pixels —
   * overlays are positioned relative to the plot wrapper, which the element
   * fills, and a style length is logical */
  originX: number;
  originY: number;
  width: number;
  height: number;
  pointerY: number;
  /** which side of the crosshair the bubble hangs on — chosen with
   * hysteresis so it sits opposite the pointer and never gets chased */
  side: 'left' | 'right';
}

/** How far past the snapped point the pointer travels before the bubble
 * switches sides. The dead zone keeps the bubble still while the pointer
 * sits on the point itself. */
const SIDE_HYSTERESIS = 8;

function makeCartesianChart(
  displayName: string,
): (props: CartesianChartProps) => ReactElement {
  function Chart(props: CartesianChartProps): ReactElement {
    const config = React.useContext(ConfigContext);
    const theme = useTheme();
    const parts = introspect(props.children);
    const key = specKey(parts, config);
    // `key` serializes everything buildSpec reads, so it is the memo's
    // whole dependency: same key, same spec object, no damage upstream.
    const spec = React.useMemo(
      () => buildSpec(parts, config),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [key],
    );

    // ONE mutable formatter object per chart: identity-stable on purpose,
    // so inline arrow formatters never damage the plot (see file header)
    const formatters = React.useRef<ChartFormatters>({}).current;
    formatters.x = parts.xAxis?.tickFormatter;
    formatters.y = parts.yAxis?.tickFormatter;

    const nodeRef = React.useRef<ChartPlotNode | null>(null);
    const [hover, setHover] = React.useState<HoverState | null>(null);
    const sideRef = React.useRef<'left' | 'right'>('right');
    const lastPointer = React.useRef<{ x: number; y: number } | null>(null);

    // one callback ref feeds both the internal node ref and the public
    // plotRef handle; memoized so React does not detach/attach per render
    const plotRefProp = props.plotRef;
    const setNode = React.useCallback(
      (n: ChartPlotNode | null) => {
        nodeRef.current = n;
        if (typeof plotRefProp === 'function') plotRefProp(n);
        else if (plotRefProp) {
          (
            plotRefProp as React.MutableRefObject<ChartPlotHandle | null>
          ).current = n;
        }
      },
      [plotRefProp],
    );

    const wantHover = parts.tooltip !== null;
    // Re-runnable for a pointer that has not moved: streaming data slides
    // the chart under a parked pointer, and a hover snapshot taken at the
    // last mousemove would keep showing the point that was there before.
    const takeHover = (x: number, y: number) => {
      const node = nodeRef.current;
      const hit = node?.hitAt(x);
      if (!hit || !node) {
        setHover(null);
        return;
      }
      // bubble side: opposite the pointer, with a dead zone around the
      // snap so sitting on a point does not flip it back and forth
      if (x > hit.px + SIDE_HYSTERESIS) sideRef.current = 'left';
      else if (x < hit.px - SIDE_HYSTERESIS) sideRef.current = 'right';
      // Everything in a HoverState becomes a style length or an anchor
      // point, so it is logical pixels: the hit already is, and `abs` is
      // device (react-x11's docs/scale.md) — divided here, once.
      const s = node.scale > 0 ? node.scale : 1;
      setHover({
        hit,
        originX: node.abs.x / s,
        originY: node.abs.y / s,
        width: node.abs.width / s,
        height: node.abs.height / s,
        pointerY: y,
        side: sideRef.current,
      });
    };
    // effects re-take the hover through this ref, so they always run the
    // render's latest closure without re-subscribing per render
    const takeHoverRef = React.useRef(takeHover);
    takeHoverRef.current = takeHover;
    const hoverActive = hover !== null;

    // a live store shifts under the pointer between mouse events: while
    // hovered, every store notification re-snaps from the parked position
    const data = props.data;
    React.useEffect(() => {
      if (!wantHover || !hoverActive) return;
      if (!data || !isChartDataLike(data as never)) return;
      return (data as ChartDataLike).subscribe(() => {
        const p = lastPointer.current;
        if (p) takeHoverRef.current(p.x, p.y);
      });
    }, [data, wantHover, hoverActive]);

    // plain rows/columns move by prop identity instead — same re-snap
    React.useEffect(() => {
      const p = lastPointer.current;
      if (p && hoverActive) takeHoverRef.current(p.x, p.y);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data]);

    // The bubble hides while a button is down — the toolkit convention
    // (Qt and GTK dismiss tooltips on any press), and what makes a press
    // that doubles as a gesture (pan, click-to-flip) never fight the
    // window manager over stacking: a click-to-raise WM raises the owner
    // window above the override-redirect popup, and no WM restacks
    // unmanaged windows back (react-x11#299 is the standing fix). The
    // crosshair and markers are in-window and keep tracking through the
    // drag; on release the popup re-mounts, and a freshly created window
    // starts above its siblings.
    const [pressed, setPressed] = React.useState(false);

    // The handlers ride the plot *wrapper*, not the element: the hover
    // overlays live between the two, and tracking must survive the pointer
    // passing over its own crosshair. (They are also hit-transparent — see
    // renderPlotOverlays — this is the second layer of the same defence.)
    const onMouseMove = wantHover
      ? (ev: { x: number; y: number }) => {
          lastPointer.current = { x: ev.x, y: ev.y };
          takeHover(ev.x, ev.y);
        }
      : undefined;
    const onMouseLeave = wantHover
      ? () => {
          lastPointer.current = null;
          setPressed(false);
          setHover(null);
        }
      : undefined;
    const onMouseDown = wantHover ? () => setPressed(true) : undefined;
    const onMouseUp = wantHover ? () => setPressed(false) : undefined;

    const plotChildren: ReactNode[] = [
      h(ELEMENT, {
        key: 'plot',
        ref: setNode,
        spec,
        data: props.data,
        formatters,
        onFrameStats: props.onFrameStats,
        // minHeight/minWidth 0: yoga's `min* : auto` content floor would
        // otherwise hold the element at its intrinsic measure, and a chart
        // plus its legend then OVERFLOWS a fixed-height container — the
        // x-gutter's tick labels land on whatever flows below the chart
        style: { flexGrow: 1, alignSelf: 'stretch', minHeight: 0, minWidth: 0 },
      } as never),
    ];
    if (hover) {
      plotChildren.push(...renderPlotOverlays(hover, parts.tooltip));
      if (!pressed) {
        const bubble = renderTooltipBubble(
          hover,
          parts.tooltip,
          formatters,
          theme,
          nodeRef,
          parts.xAxis?.type,
        );
        if (bubble) plotChildren.push(bubble);
      }
    }

    const legendRow = parts.legend
      ? renderLegend(spec, parts.legend.verticalAlign ?? 'bottom')
      : null;

    return hx(
      'box',
      // flexGrow so a chart FILLS the container's styled height instead of
      // sitting at the element's intrinsic size and overflowing it; with no
      // height anywhere the intrinsic size still decides, as before.
      // minHeight/minWidth 0 at every level of the column (here, the plot
      // wrapper, the element): yoga's `min*: auto` content floor at ANY of
      // them re-inflates the chart past a fixed container, and the gutter's
      // tick labels then print over whatever flows after the chart.
      {
        style: [
          { flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0 },
          props.style,
        ],
        'data-testname': props['data-testname'],
      },
      parts.legend?.verticalAlign === 'top' ? legendRow : null,
      hx(
        'box',
        {
          style: {
            flexGrow: 1,
            flexDirection: 'column',
            position: 'relative',
            // the other half of the content-floor release: the wrapper
            // itself must be allowed to shrink into the container's box
            minHeight: 0,
            minWidth: 0,
          },
          onMouseMove,
          onMouseLeave,
          onMouseDown,
          onMouseUp,
        },
        ...plotChildren,
      ),
      parts.legend?.verticalAlign !== 'top' ? legendRow : null,
    );
  }
  Chart.displayName = displayName;
  return Chart;
}

/** The four chart types are one cartesian chart under four names, the way
 * shadcn's all sit on one recharts: the series children say what is drawn,
 * and mixing them — bars under a line — works in any of these. The names
 * exist so a chart reads as what it is. */
export const LineChart = makeCartesianChart('LineChart');
export const AreaChart = makeCartesianChart('AreaChart');
export const BarChart = makeCartesianChart('BarChart');
export const ScatterChart = makeCartesianChart('ScatterChart');

// --- hover overlays --------------------------------------------------------

/**
 * The crosshair and the point markers: part of the plot, always in-window,
 * and **hit-transparent** — without `pointerEvents: 'none'` the pointer
 * lands on its own crosshair, the wrapper's move events keep flowing but a
 * box the hover conjured must never be the thing under the mouse.
 */
function renderPlotOverlays(
  hover: HoverState,
  tooltip: ChartTooltipProps | null,
): ReactNode[] {
  const { hit, originX, originY } = hover;
  const out: ReactNode[] = [];
  const plotTop = hit.plot.y - originY;
  const crosshairX = hit.px - originX;

  if (tooltip?.cursor !== false) {
    out.push(
      hx('box', {
        key: 'crosshair',
        style: {
          position: 'absolute',
          pointerEvents: 'none',
          left: Math.round(crosshairX),
          top: Math.round(plotTop),
          width: 1,
          height: Math.round(hit.plot.height),
          backgroundColor: '$border',
        },
      }),
    );
  }

  for (const p of hit.points) {
    out.push(
      hx('box', {
        key: `marker-${p.id}`,
        style: {
          position: 'absolute',
          pointerEvents: 'none',
          left: Math.round(crosshairX - 3),
          top: Math.round(p.py - originY - 3),
          width: 7,
          height: 7,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: '$background',
          backgroundColor: p.color,
        },
      }),
    );
  }
  return out;
}

/** Rough bubble height, for clamping before anything is laid out. */
function bubbleEstimate(points: number): number {
  return 34 + points * 18;
}

/**
 * The value bubble, in whichever home `ChartTooltip mode` chose.
 *
 * The default is a `<popup>` hung off the data point through the anchor
 * system — a real override-redirect window, so it stacks above content
 * that flows after the chart (an in-window overlay paints in tree order
 * and loses to any later sibling it leans over), follows screen-edge
 * flips, and never takes focus. The bubble hangs on the side of the
 * crosshair *away* from the pointer (with hysteresis), so the pointer
 * cannot wander onto the tooltip window and flicker the hover.
 *
 * `mode="overlay"` keeps it as an absolutely-positioned, hit-transparent
 * box clamped inside the chart: one window, one paint surface — and the
 * documented trade that later siblings can overdraw whatever part of it
 * would have left the chart's box.
 */
function renderTooltipBubble(
  hover: HoverState,
  tooltip: ChartTooltipProps | null,
  formatters: ChartFormatters,
  theme: ReturnType<typeof useTheme>,
  anchorRef: React.RefObject<ChartPlotNode | null>,
  xType?: AxisType,
): ReactNode | null {
  const { hit, originX, originY, width, height, side } = hover;
  const crosshairX = hit.px - originX;
  const data: TooltipData = { xValue: hit.xValue, points: hit.points };
  const fmtLabel =
    tooltip?.labelFormatter ??
    ((v: number | string) => {
      if (typeof v !== 'number') return String(v);
      if (formatters.x) return formatters.x(v);
      // a time axis without a formatter of its own labels the header the
      // way it labels its ticks — never as raw epoch milliseconds
      if (xType === 'time') return formatTimeTick(v, Math.max(1, hit.xSpan));
      return String(v);
    });
  const fmtValue =
    tooltip?.formatter ??
    ((v: number) => (formatters.y ? formatters.y(v) : formatValue(v)));
  const content = tooltip?.content
    ? [tooltip.content(data)]
    : defaultTooltipContent(data, fmtLabel, fmtValue);

  if (tooltip?.mode === 'overlay') {
    const est = bubbleEstimate(hit.points.length);
    const bubbleStyle: Style = {
      position: 'absolute',
      pointerEvents: 'none',
      top: Math.max(
        0,
        Math.min(
          Math.round(hover.pointerY - originY + 14),
          Math.round(height - est),
        ),
      ),
      flexDirection: 'column',
      padding: 8,
      gap: 4,
      // Theme.radiusTooltip is not reachable as a style token (radius
      // tokens resolve to numbers only), so it is read off the theme here.
      borderRadius: theme.radiusTooltip,
      borderWidth: 1,
      borderColor: '$border',
      backgroundColor: '$background',
    };
    if (side === 'left')
      bubbleStyle.right = Math.round(width - crosshairX + 10);
    else bubbleStyle.left = Math.round(crosshairX + 10);
    return hx('box', { key: 'tooltip', style: bubbleStyle }, ...content);
  }

  // the pointer's y, clamped into the plot band so tracking across the
  // axis gutter does not drag the bubble out of the chart
  const anchorY = Math.max(
    hit.plot.y - originY,
    Math.min(hover.pointerY - originY, hit.plot.y - originY + hit.plot.height),
  );
  return hx(
    'popup',
    {
      key: 'tooltip-popup',
      // the palette does not cross into a separate window on its own; the
      // re-declared theme is what makes the $tokens below resolve (the
      // calendar's DatePicker sets the precedent)
      theme,
      width: 'auto',
      height: 'auto',
      anchor: {
        // the ref-facing DrawnNode view and the retained node are the same
        // object; the anchor system wants the former's type
        to: anchorRef as unknown as { current: null },
        at: { x: crosshairX, y: anchorY },
        placement: side,
        align: 'start',
        offset: 14,
      },
      transparent: true,
      style: {
        backgroundColor: theme.background,
        '@supports transparency': {
          backgroundColor: 'transparent',
        },
      } as Style,
    },
    hx(
      'box',
      {
        style: {
          flexDirection: 'column',
          padding: 8,
          gap: 4,
          borderRadius: theme.radiusTooltip,
          borderWidth: 1,
          borderColor: '$border',
          backgroundColor: '$background',
        },
      },
      ...content,
    ),
  );
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
}

function defaultTooltipContent(
  data: TooltipData,
  fmtLabel: (v: number | string) => string,
  fmtValue: (v: number, id: string) => string,
): ReactNode[] {
  const rows: ReactNode[] = [
    hx(
      'text',
      { key: 'label', style: { color: '$textMuted', fontSize: 12 } },
      fmtLabel(data.xValue),
    ),
  ];
  for (const p of data.points) {
    rows.push(
      hx(
        'box',
        {
          key: p.id,
          style: { flexDirection: 'row', alignItems: 'center', gap: 6 },
        },
        hx('box', {
          style: {
            width: 8,
            height: 8,
            borderRadius: 2,
            backgroundColor: p.color,
          },
        }),
        hx('text', { style: { color: '$textMuted', fontSize: 12 } }, p.label),
        hx('box', { style: { flexGrow: 1, minWidth: 12 } }),
        hx(
          'text',
          { style: { color: '$text', fontSize: 12 } },
          fmtValue(p.value, p.id),
        ),
      ),
    );
  }
  return rows;
}

// --- legend ----------------------------------------------------------------

function renderLegend(spec: PlotSpec, align: 'top' | 'bottom'): ReactElement {
  return hx(
    'box',
    {
      key: `legend-${align}`,
      style: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 16,
        paddingTop: align === 'bottom' ? 8 : 0,
        paddingBottom: align === 'top' ? 8 : 0,
      },
    },
    ...spec.series.map((s) =>
      hx(
        'box',
        {
          key: s.id,
          style: { flexDirection: 'row', alignItems: 'center', gap: 6 },
        },
        hx('box', {
          style: {
            width: 10,
            height: 10,
            borderRadius: 3,
            backgroundColor: s.color,
          },
        }),
        hx('text', { style: { color: '$textMuted', fontSize: 12 } }, s.label),
      ),
    ),
  );
}
