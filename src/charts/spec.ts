// The resolved chart description `<chartplot>` paints from. The React
// layer builds one of these by introspecting its children (recharts'
// model: series/axis children are config carriers, not renderers) and
// memoizes it, so an unchanged chart re-rendering costs no damage.

/** The shadcn shape: series key → how to present it. Colours take a CSS
 * colour or a `$token` resolved against the nearest theme. */
export type ChartConfig = Record<
  string,
  {
    label?: string;
    color?: string;
  }
>;

export type SeriesType = 'line' | 'area' | 'bar' | 'scatter';

export type CurveKind = 'linear' | 'monotone' | 'step';

export interface SeriesSpec {
  /** The dataKey — column name, config key, legend identity. */
  id: string;
  type: SeriesType;
  /** Resolved presentation colour (config wins over the default palette).
   * `$token` values resolve against the theme at paint time. */
  color: string;
  label: string;
  strokeWidth: number;
  /** Area fill opacity; the stroke on top stays opaque. */
  fillOpacity: number;
  curve: CurveKind;
  /** Line marker dots: false, or a radius in px. Sparse mode only. */
  dot: number | false;
  /** Series sharing a stackId stack in child order (bar/area). */
  stackId: string | null;
  /** Rounded bar tops. Ignored past BAR_RADIUS_MAX bars per frame. */
  barRadius: number;
  /** Scatter point size in px. */
  size: number;
}

export type AxisType = 'auto' | 'linear' | 'band' | 'time';

export interface AxisSpec {
  /** x only: the column holding the axis values. Absent means "the index". */
  key: string | null;
  type: AxisType;
  /** Requested tick count — a target, not a promise. */
  ticks: number;
  /** Domain overrides; 'auto' keeps the data extent (nice-rounded for y). */
  domain: [number | 'auto', number | 'auto'];
  hide: boolean;
  /** y: reserved gutter width. 'auto' measures the tick labels. */
  width: number | 'auto';
  /** x: reserved gutter height. */
  height: number;
}

export interface GridSpec {
  horizontal: boolean;
  vertical: boolean;
}

export interface PlotSpec {
  series: SeriesSpec[];
  x: AxisSpec;
  y: AxisSpec;
  grid: GridSpec | null;
}

/** What a painted frame cost — the demo HUD renders it, the tests assert
 * on it. Estimated wire bytes count 8 per rectangle, 48 per stroked
 * segment and 4 per image pixel: the real encodings' sizes, near enough to
 * choose between paths by. */
export interface ChartFrameStats {
  /** ms spent preparing (pyramid/index/stack/grid builds), this frame. */
  prepMs: number;
  paintMs: number;
  /** Points the visible index ranges spanned, all series summed. */
  pointsSpanned: number;
  /** Drawing commands issued (batched fills count once). */
  commands: number;
  estimatedWireBytes: number;
  series: {
    id: string;
    mode: 'polyline' | 'columns' | 'bars' | 'rects' | 'image' | 'skipped';
    points: number;
  }[];
}

/** The default categorical palette. The first series follows the app's
 * accent, so an unconfigured chart already matches the UI around it; the
 * rest hold their own on light and dark ground. */
export const DEFAULT_PALETTE = [
  '$accent',
  '#e17055',
  '#00b894',
  '#8e6be8',
  '#e84393',
];

/**
 * Resolve a `$token` colour against a theme record. Unknown tokens fall to
 * a visible grey rather than throwing — a chart with a typo'd token should
 * mis-colour, not take the frame down.
 */
export function resolveThemeColor(
  color: string,
  theme: Record<string, unknown> | null,
): string {
  if (!color.startsWith('$')) return color;
  const value = theme?.[color.slice(1)];
  return typeof value === 'string' ? value : '#888888';
}

export const SPEC_DEFAULTS = {
  strokeWidth: 2,
  fillOpacity: 0.25,
  ticks: 5,
  xAxisHeight: 24,
  scatterSize: 3,
} as const;
