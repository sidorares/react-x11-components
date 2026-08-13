// The retained node behind `<chartplot>`: one paint pass for the grid, the
// axes and every series, the render-host caches (scatter grids, the density
// image surface), and the hit-test answers the tooltip layer asks through a
// ref.
//
// The perf-relevant structure, in one place:
//
//  - **Nothing happens off-paint.** Pyramids, x indexes and stack tops are
//    built by the first paint that needs them and extended incrementally;
//    a `ChartData` append while this node is entirely outside its window's
//    viewport does not even schedule a frame — scrolling back repaints
//    from current data anyway.
//  - **The scales are computed once per (geometry, data, spec, theme) and
//    memoized**, so a hover asking `hitAt` between frames costs a lookup,
//    not a re-derivation.
//  - **Formatters and stats callbacks ride identity-stable props** (the
//    component layer keeps one mutable object), so re-renders of the React
//    tree above contribute no damage of their own. The hover overlays do
//    overlap the plot, so their damage strips repaint this node — at its
//    usual pixel-bounded cost, which is the actual guarantee: a hover
//    frame is O(width) commands whatever the point count.

import { Node } from 'react-x11/node';
import type {
  Context2D,
  MeasureConstraints,
  MeasuredSize,
} from 'react-x11/node';
import type { Style } from 'react-x11/style';
import { Surface } from 'react-x11/ntk';

import type {
  ChartDataLike,
  ChartSourceData,
  NumericColumn,
  ResolvedColumn,
} from './data.js';
import {
  buildStackTops,
  isChartDataLike,
  minMaxRange,
  nearestIndex,
  numericColumn,
  pyramidFor,
  resolveColumn,
  xIndexFor,
} from './data.js';
import type { BandScale, LinearScale } from './scale.js';
import {
  bandScale,
  formatNumberTick,
  formatTimeTick,
  linearScale,
  linearTicks,
  niceDomain,
  timeTicks,
} from './scale.js';
import type { ChartFrameStats, PlotSpec, SeriesSpec } from './spec.js';
import { resolveThemeColor } from './spec.js';
import type {
  FrameStatsSink,
  PlotContext,
  PlotRect,
  RenderHost,
  ScatterGrid,
  SeriesGeometry,
} from './render.js';
import { canPath, makeScatterGrid, renderSeries } from './render.js';
import { microtask, now } from './timers.js';

/** The element name — registration key, node kind and JSX tag alike. */
export const ELEMENT = 'chartplot';

/** Formatter channel. The component layer keeps ONE mutable object per
 * chart and updates its fields, so the prop's identity never changes and a
 * formatter defined inline never damages the plot. */
export interface ChartFormatters {
  x?: (value: number | string) => string;
  y?: (value: number) => string;
}

export interface ChartPlotProps {
  spec: PlotSpec;
  data: ChartSourceData;
  formatters?: ChartFormatters;
  /** Reported once per painted frame, off the paint stack. */
  onFrameStats?: (stats: ChartFrameStats) => void;
  style?: Style | Style[];
}

/** What the tooltip layer gets for a pointer position. */
export interface ChartHit {
  index: number;
  /** The x value at that index — a label for band axes. */
  xValue: number | string;
  /** Snap position for the crosshair, window coordinates. */
  px: number;
  /** The x domain's width (0 for band axes) — what a time-axis tooltip
   * sizes its default header format to, exactly as the ticks do. */
  xSpan: number;
  plot: PlotRect;
  points: {
    id: string;
    label: string;
    color: string;
    value: number;
    py: number;
  }[];
}

export type NtkApp = ConstructorParameters<typeof Node>[2];

/** The slice of ntk's font service axis labels go through. Absent on the
 * mock backend, and every use below treats that as "skip the text". */
interface FontsLike {
  layout(
    content: string,
    style: Record<string, unknown>,
  ): {
    width: number;
    height: number;
    draw(ctx: unknown, x: number, y: number): void;
  };
}

interface SurfaceLike {
  getContext(name: string): {
    createImageData(
      w: number,
      h: number,
    ): {
      width: number;
      height: number;
      data: Uint8ClampedArray;
    };
    putImageData(data: unknown, x: number, y: number): void;
    destroy?(): void;
  };
  destroy(): void;
}

type SurfaceCtor = new (
  app: unknown,
  options: { width: number; height: number },
) => SurfaceLike;

// `react-x11/ntk` types loosely on purpose; older ntk has no Surface at all
const SurfaceClass = (Surface ?? null) as unknown as SurfaceCtor | null;

const MIN_PAINT_PX = 8;
const PAD_TOP = 6;
const PAD_RIGHT = 8;
const TICK_GAP = 6;
const X_AXIS_HEIGHT = 22;
const LABEL_CACHE_MAX = 256;

interface AxisTick {
  /** position in window px along the tick's axis */
  px: number;
  label: string;
}

/** Everything derived from (abs, data, spec, theme): scales, gutters,
 * ticks, per-series geometry. One computation serves paint and hitAt. */
interface Layout {
  key: string;
  plot: PlotRect;
  xScale: LinearScale | BandScale;
  yScale: LinearScale;
  xTicks: AxisTick[];
  yTicks: AxisTick[];
  geoms: SeriesGeometry[];
  /** the x column (band labels / hit values), when there is one */
  xCol: ResolvedColumn | null;
  prepMs: number;
}

interface StackEntry {
  /** identity key of the member columns + their epochs */
  epochKey: string;
  builtN: number;
  layers: Float64Array[];
  /** stable pyramid-cache hosts, one per layer */
  hosts: object[];
  /** bumped on rebuild so wrapped columns invalidate their pyramids */
  rebuilds: number;
}

export class ChartPlotNode extends Node {
  private _layoutCache: Layout | null = null;
  private _labelLayouts = new Map<
    string,
    {
      width: number;
      height: number;
      draw(ctx: unknown, x: number, y: number): void;
    }
  >();
  private _scatterGrids = new Map<string, ScatterGrid>();
  private _stacks = new Map<string, StackEntry>();
  private _unsubscribe: (() => void) | null = null;
  private _image: {
    w: number;
    h: number;
    surface: SurfaceLike;
    sctx: ReturnType<SurfaceLike['getContext']>;
    data: { width: number; height: number; data: Uint8ClampedArray };
    /** what the surface currently holds — a repaint with the same content
     * (a crosshair moving over a dense scatter) is one composite, no
     * refill and no re-upload */
    contentKey: string;
  } | null = null;

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
    this.a11yRole = 'img';
    this._subscribeData(props.data);
  }

  private _props(): Partial<ChartPlotProps> {
    return this.props as unknown as Partial<ChartPlotProps>;
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    if (nextProps.data !== prevProps.data) {
      this._subscribeData(nextProps.data);
    }
    super.applyProps(nextProps, prevProps);
  }

  private _subscribeData(data: unknown): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (data && isChartDataLike(data as ChartSourceData)) {
      this._unsubscribe = (data as ChartDataLike).subscribe(() => {
        if (this.destroyed) return;
        // A chart nobody can see skips even the invalidation: scrolling it
        // back into view repaints from current data, so no frame is owed.
        if (this._fullyOffscreen()) return;
        this.invalidate(false, this, 'content');
      });
    }
  }

  /**
   * Entirely outside the owning window, by public geometry alone. Core
   * culls the *paint* of offscreen nodes on its own; this is only about
   * skipping the invalidation a streaming append would otherwise schedule.
   * Conservative: any doubt answers "maybe visible".
   */
  private _fullyOffscreen(): boolean {
    const root = this.root;
    if (!root || root === this) return true;
    const win = root.abs;
    const a = this.abs;
    if (!win || !a || win.width <= 0) return false;
    return (
      a.x + a.width <= 0 ||
      a.y + a.height <= 0 ||
      a.x >= win.width ||
      a.y >= win.height
    );
  }

  override destroySubtree(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._image?.sctx.destroy?.();
    this._image?.surface.destroy();
    this._image = null;
    super.destroySubtree();
  }

  /** A chart with no styled size still shows up usefully — the HTML canvas
   * default, scaled a little. Flex sizing overrides it as usual. */
  override measureContent(constraints: MeasureConstraints): MeasuredSize {
    return {
      width: Math.min(480, constraints.width),
      height: Math.min(260, constraints.height),
    };
  }

  // --- data plumbing -------------------------------------------------------

  private _dataVersion(spec: PlotSpec, data: ChartSourceData): string {
    // cheap and exact: every column's (epoch, n) — appends and window
    // shifts both land here, so the layout memo can key on it
    const parts: string[] = [];
    const seen = new Set<string>();
    const push = (key: string | null) => {
      if (!key || seen.has(key)) return;
      seen.add(key);
      const col = resolveColumn(data, key);
      parts.push(col ? `${key}=${col.epoch}:${col.n}` : `${key}=∅`);
    };
    push(spec.x.key);
    for (const s of spec.series) push(s.id);
    return parts.join(',');
  }

  /** Wrap a stack layer as a column with a stable cache host, so its
   * pyramid survives the layer array being reallocated by growth. */
  private _stackColumn(
    entry: StackEntry,
    layer: number,
    n: number,
  ): NumericColumn {
    return {
      values: entry.layers[layer],
      n,
      host: entry.hosts[layer],
      epoch: entry.rebuilds,
      numeric: true,
    };
  }

  /**
   * Cumulative tops for a stack group, extended incrementally on append
   * and rebuilt when membership or history changes.
   */
  private _stackTops(
    stackId: string,
    members: { id: string; col: NumericColumn }[],
  ): StackEntry {
    const epochKey = members.map((m) => `${m.id}:${m.col.epoch}`).join('|');
    const n = members.reduce((min, m) => Math.min(min, m.col.n), Infinity);
    let entry = this._stacks.get(stackId);
    if (!entry || entry.epochKey !== epochKey) {
      entry = {
        epochKey,
        builtN: 0,
        layers: members.map(() => new Float64Array(0)),
        hosts: members.map(() => ({})),
        rebuilds: (entry?.rebuilds ?? 0) + 1,
      };
      this._stacks.set(stackId, entry);
    }
    if (entry.builtN < n) {
      if (entry.builtN === 0) {
        entry.layers = buildStackTops(
          members.map((m) => m.col.values),
          n,
        );
      } else {
        for (let j = 0; j < members.length; j++) {
          const old = entry.layers[j];
          const next = new Float64Array(n);
          next.set(old.subarray(0, entry.builtN));
          entry.layers[j] = next;
        }
        for (let i = entry.builtN; i < n; i++) {
          let below = 0;
          for (let j = 0; j < members.length; j++) {
            const v = members[j].col.values[i] as number;
            below += Number.isNaN(v) ? 0 : v;
            entry.layers[j][i] = below;
          }
        }
      }
      entry.builtN = n;
    }
    return entry;
  }

  // --- layout --------------------------------------------------------------

  private _themeRecord(): Record<string, unknown> | null {
    return this.theme;
  }

  private _color(token: string, fallback: string): string {
    const v = resolveThemeColor(token, this._themeRecord());
    return v === '#888888' && token.startsWith('$') ? fallback : v;
  }

  /** Measure one label through the font service, cached. Null without a
   * font service (the mock backend) — callers fall back to fixed gutters. */
  private _label(
    text: string,
    size: number,
    color: string,
  ): {
    width: number;
    height: number;
    draw(ctx: unknown, x: number, y: number): void;
  } | null {
    const key = `${size}|${color}|${text}`;
    const hit = this._labelLayouts.get(key);
    if (hit) return hit;
    const fonts = (this.app as { fonts?: FontsLike } | null)?.fonts;
    if (!fonts) return null;
    const ts = this.resolvedTextStyle();
    const layout = fonts.layout(text, {
      family: ts.family,
      size,
      weight: ts.weight,
      style: ts.style,
      color,
    });
    if (this._labelLayouts.size >= LABEL_CACHE_MAX) this._labelLayouts.clear();
    this._labelLayouts.set(key, layout);
    return layout;
  }

  private _layout(): Layout | null {
    const { spec, data, formatters } = this._props();
    if (!spec || !data) return null;
    const box = this.contentBox();
    if (box.width < MIN_PAINT_PX || box.height < MIN_PAINT_PX) return null;

    const dataVersion = this._dataVersion(spec, data);
    const key = [
      box.x,
      box.y,
      box.width,
      box.height,
      dataVersion,
      // spec is memoized by the component layer, so identity is enough —
      // but it is an object, so it goes into the key by a WeakRef-free
      // trick: the cache also stores the reference and compares it below
    ].join('|');
    const cached = this._layoutCache;
    if (
      cached &&
      cached.key === key &&
      this._cachedSpec === spec &&
      this._cachedTheme === this.theme
    ) {
      return cached;
    }

    const t0 = now();
    const theme = this._themeRecord();
    const labelSize = Math.max(
      9,
      Math.round(this.resolvedTextStyle().size * 0.8),
    );
    const labelColor = this._color('$textMuted', '#777777');

    // -- columns
    const xCol = spec.x.key ? resolveColumn(data, spec.x.key) : null;
    const xNum = numericColumn(xCol);
    const xIdx = xNum ? xIndexFor(xNum) : null;

    // series → raw columns (missing columns drop the series this frame)
    const raw: { spec: SeriesSpec; col: NumericColumn }[] = [];
    for (const s of spec.series) {
      const col = numericColumn(resolveColumn(data, s.id));
      if (col) raw.push({ spec: s, col });
    }

    // -- x kind
    const anyBar = raw.some((r) => r.spec.type === 'bar');
    let xKind: 'band' | 'linear' | 'time';
    if (spec.x.type === 'band') xKind = 'band';
    else if (spec.x.type === 'time') xKind = 'time';
    else if (spec.x.type === 'linear') xKind = 'linear';
    else xKind = anyBar || (xCol !== null && !xCol.numeric) ? 'band' : 'linear';

    // -- stacks: replace y with cumulative tops, base with the layer below
    const stackGroups = new Map<string, { id: string; col: NumericColumn }[]>();
    for (const r of raw) {
      if (!r.spec.stackId || (r.spec.type !== 'bar' && r.spec.type !== 'area'))
        continue;
      const list = stackGroups.get(r.spec.stackId) ?? [];
      list.push({ id: r.spec.id, col: r.col });
      stackGroups.set(r.spec.stackId, list);
    }
    // bar slots: stacked bars share one, everything else gets its own
    const barSlots: string[] = [];
    for (const r of raw) {
      if (r.spec.type !== 'bar') continue;
      const slot = r.spec.stackId ?? r.spec.id;
      if (!barSlots.includes(slot)) barSlots.push(slot);
    }

    const geoms: SeriesGeometry[] = [];
    let yMin = Infinity;
    let yMax = -Infinity;
    const seenStackLayer = new Map<string, number>();
    for (const r of raw) {
      let y: NumericColumn = r.col;
      let base: NumericColumn | number = 0;
      const stacked =
        r.spec.stackId && (r.spec.type === 'bar' || r.spec.type === 'area')
          ? stackGroups.get(r.spec.stackId)
          : undefined;
      if (stacked && stacked.length > 1) {
        const entry = this._stackTops(r.spec.stackId!, stacked);
        const layer = seenStackLayer.get(r.spec.stackId!) ?? 0;
        seenStackLayer.set(r.spec.stackId!, layer + 1);
        const n = entry.builtN;
        y = this._stackColumn(entry, layer, n);
        base = layer > 0 ? this._stackColumn(entry, layer - 1, n) : 0;
      }
      // y extent through the pyramid: O(1) after the first build, and the
      // build is the prep dense paint needs anyway
      if (y.n > 0) {
        const pyr = pyramidFor(y);
        const mm = { min: 0, max: 0 };
        minMaxRange(pyr, y.values, 0, y.n, mm);
        if (mm.min <= mm.max) {
          if (mm.min < yMin) yMin = mm.min;
          if (mm.max > yMax) yMax = mm.max;
        }
      }
      const grounded =
        r.spec.type === 'bar' ||
        (r.spec.type === 'area' && typeof base === 'number');
      if (grounded) {
        if (yMin > 0) yMin = 0;
        if (yMax < 0) yMax = 0;
      }
      geoms.push({
        spec: r.spec,
        y,
        base,
        x: xKind === 'band' ? null : xNum,
        xIdx: xKind === 'band' ? null : xIdx,
        group: {
          index: Math.max(0, barSlots.indexOf(r.spec.stackId ?? r.spec.id)),
          count: Math.max(1, barSlots.length),
        },
        color: resolveThemeColor(r.spec.color, theme),
      });
    }

    // -- y domain and ticks
    const [autoY0, autoY1] = niceDomain(yMin, yMax, spec.y.ticks);
    const yD0 = spec.y.domain[0] === 'auto' ? autoY0 : spec.y.domain[0];
    const yD1 = spec.y.domain[1] === 'auto' ? autoY1 : spec.y.domain[1];
    const fmtY = formatters?.y ?? formatNumberTick;
    const yTickValues = spec.y.hide ? [] : linearTicks(yD0, yD1, spec.y.ticks);
    const yTickLabels = yTickValues.map((v) => fmtY(v));

    // -- gutters (the y gutter measures its own labels; fixed on the mock)
    let left = 0;
    if (!spec.y.hide) {
      if (spec.y.width !== 'auto') {
        left = spec.y.width;
      } else {
        let max = 0;
        for (const text of yTickLabels) {
          const l = this._label(text, labelSize, labelColor);
          if (!l) {
            max = 34;
            break;
          }
          if (l.width > max) max = l.width;
        }
        left = Math.ceil(max) + TICK_GAP + 2;
      }
    }
    const bottom = spec.x.hide ? 0 : spec.x.height || X_AXIS_HEIGHT;
    const plot: PlotRect = {
      x: box.x + left,
      y: box.y + PAD_TOP,
      width: Math.max(1, box.width - left - PAD_RIGHT),
      height: Math.max(1, box.height - PAD_TOP - bottom),
    };

    const yScale = linearScale(yD0, yD1, plot.y + plot.height, plot.y);
    const yTicks: AxisTick[] = yTickValues.map((v, i) => ({
      px: yScale.scale(v),
      label: yTickLabels[i],
    }));

    // -- x scale and ticks
    let xScale: LinearScale | BandScale;
    let xTicks: AxisTick[] = [];
    const fmtX = formatters?.x;
    if (xKind === 'band') {
      const n = xCol ? xCol.n : (geoms[0]?.y.n ?? 0);
      xScale = bandScale(n, plot.x, plot.x + plot.width);
      if (!spec.x.hide && n > 0) {
        // at most `ticks` evenly-strided band labels
        const step = Math.max(1, Math.ceil(n / Math.max(1, spec.x.ticks)));
        for (let i = 0; i < n; i += step) {
          const value = xCol ? xCol.values[i] : i;
          const label = fmtX ? fmtX(value as number | string) : String(value);
          xTicks.push({ px: xScale.center(i), label });
        }
      }
    } else {
      let d0: number;
      let d1: number;
      if (xNum && xIdx && xIdx.min <= xIdx.max) {
        d0 = xIdx.min;
        d1 = xIdx.max;
      } else {
        d0 = 0;
        d1 = Math.max(1, (geoms[0]?.y.n ?? 1) - 1);
      }
      if (spec.x.domain[0] !== 'auto') d0 = spec.x.domain[0];
      if (spec.x.domain[1] !== 'auto') d1 = spec.x.domain[1];
      if (d0 === d1) [d0, d1] = niceDomain(d0, d1);
      xScale = linearScale(d0, d1, plot.x, plot.x + plot.width);
      if (!spec.x.hide) {
        const values =
          xKind === 'time'
            ? timeTicks(d0, d1, spec.x.ticks)
            : linearTicks(d0, d1, spec.x.ticks);
        const span = d1 - d0;
        xTicks = values.map((v) => ({
          px: xScale.scale(v),
          label: fmtX
            ? fmtX(v)
            : xKind === 'time'
              ? formatTimeTick(v, span)
              : formatNumberTick(v),
        }));
      }
    }

    const layout: Layout = {
      key,
      plot,
      xScale,
      yScale,
      xTicks,
      yTicks,
      geoms,
      xCol,
      prepMs: now() - t0,
    };
    this._layoutCache = layout;
    this._cachedSpec = spec;
    this._cachedTheme = this.theme;
    return layout;
  }

  private _cachedSpec: PlotSpec | undefined;
  private _cachedTheme: Record<string, unknown> | null | undefined;

  // --- render host ---------------------------------------------------------

  private _host(): RenderHost {
    return {
      scatterGrid: (id, key, _n) => {
        let grid = this._scatterGrids.get(id);
        if (!grid || grid.key !== key) {
          const [cell, gw, gh] = key.split('|');
          grid = makeScatterGrid(key, Number(cell), Number(gw), Number(gh));
          this._scatterGrids.set(id, grid);
        }
        return grid;
      },
      blitImage: (x, y, w, h, fill, contentKey) => {
        const app = this.app as {
          display?: { Render?: unknown };
        } | null;
        if (!SurfaceClass || !app?.display?.Render) return false;
        const ctx = this._paintCtx;
        if (!ctx || typeof ctx.drawImage !== 'function') return false;
        try {
          if (this._image && (this._image.w !== w || this._image.h !== h)) {
            this._image.sctx.destroy?.();
            this._image.surface.destroy();
            this._image = null;
          }
          if (!this._image) {
            const surface = new SurfaceClass(this.app, { width: w, height: h });
            const sctx = surface.getContext('2d');
            this._image = {
              w,
              h,
              surface,
              sctx,
              data: sctx.createImageData(w, h),
              contentKey: '',
            };
          }
          const img = this._image;
          // an unchanged content key means the retained surface already
          // holds these pixels: a repaint (a crosshair crossing the plot)
          // is one composite, not a megabyte re-upload
          if (!contentKey || img.contentKey !== contentKey) {
            img.data.data.fill(0);
            fill(img.data.data);
            img.sctx.putImageData(img.data, 0, 0);
            img.contentKey = contentKey ?? '';
          }
          ctx.drawImage!(img.surface, x, y);
          return true;
        } catch {
          // a server that refuses the pixmap: the rect path is still right
          return false;
        }
      },
    };
  }

  private _paintCtx: PlotContext | null = null;

  // --- painting ------------------------------------------------------------

  override paint(ctx: Context2D): void {
    super.paint(ctx);
    const t0 = now();
    const layout = this._layout();
    if (!layout) return;
    const c = ctx as PlotContext;
    if (typeof c.fillRect !== 'function') return;
    this._paintCtx = c;

    const stats: FrameStatsSink = {
      pointsSpanned: 0,
      commands: 0,
      estimatedWireBytes: 0,
      series: [],
    };
    const { spec } = this._props();
    const { plot } = layout;

    this._paintGridAndAxes(c, layout, stats);

    // one rectangular clip around the series pass: server-side fast paths
    // stay available, and sparse strokes cannot escape the plot
    const clipped =
      canPath(c) &&
      typeof c.rect === 'function' &&
      typeof c.clip === 'function';
    if (clipped) {
      c.save();
      c.beginPath?.();
      c.rect?.(plot.x, plot.y, plot.width, plot.height);
      c.clip?.();
    }
    const env = {
      ctx: c,
      plot,
      xScale: layout.xScale,
      yScale: layout.yScale,
      stats,
      host: this._host(),
    };
    for (const geom of layout.geoms) renderSeries(env, geom);
    if (clipped) c.restore();
    this._paintCtx = null;

    const onFrameStats = spec ? this._props().onFrameStats : undefined;
    if (onFrameStats) {
      const report: ChartFrameStats = {
        prepMs: layout.prepMs,
        paintMs: now() - t0,
        pointsSpanned: stats.pointsSpanned,
        commands: stats.commands,
        estimatedWireBytes: stats.estimatedWireBytes,
        series: stats.series,
      };
      microtask(() => {
        if (!this.destroyed) onFrameStats(report);
      });
    }
  }

  private _paintGridAndAxes(
    ctx: PlotContext,
    layout: Layout,
    stats: FrameStatsSink,
  ): void {
    const { spec } = this._props();
    if (!spec) return;
    const { plot, xTicks, yTicks } = layout;
    const lineColor = this._color('$border', '#cccccc');
    const labelColor = this._color('$textMuted', '#777777');
    const labelSize = Math.max(
      9,
      Math.round(this.resolvedTextStyle().size * 0.8),
    );

    // grid: 1px rules batched into one request per direction
    if (spec.grid) {
      const rects: number[] = [];
      if (spec.grid.horizontal) {
        for (const t of yTicks) {
          const y = Math.round(t.px);
          if (y > plot.y && y < plot.y + plot.height) {
            rects.push(plot.x, y, plot.width, 1);
          }
        }
      }
      if (spec.grid.vertical) {
        for (const t of xTicks) {
          const x = Math.round(t.px);
          if (x > plot.x && x < plot.x + plot.width) {
            rects.push(x, plot.y, 1, plot.height);
          }
        }
      }
      if (rects.length) {
        ctx.save();
        ctx.fillStyle = lineColor;
        if (ctx.globalAlpha !== undefined) ctx.globalAlpha = 0.45;
        if (typeof ctx.fillRects === 'function') ctx.fillRects(rects);
        else {
          for (let i = 0; i + 3 < rects.length; i += 4) {
            ctx.fillRect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
          }
        }
        ctx.restore();
        stats.commands++;
        stats.estimatedWireBytes += (rects.length / 4) * 8;
      }
    }

    // axis lines
    const axisRects: number[] = [];
    if (!spec.x.hide) {
      axisRects.push(plot.x, plot.y + plot.height, plot.width, 1);
    }
    if (!spec.y.hide) axisRects.push(plot.x - 1, plot.y, 1, plot.height + 1);
    if (axisRects.length) {
      ctx.save();
      ctx.fillStyle = lineColor;
      if (typeof ctx.fillRects === 'function') ctx.fillRects(axisRects);
      else {
        for (let i = 0; i + 3 < axisRects.length; i += 4) {
          ctx.fillRect(
            axisRects[i],
            axisRects[i + 1],
            axisRects[i + 2],
            axisRects[i + 3],
          );
        }
      }
      ctx.restore();
      stats.commands++;
      stats.estimatedWireBytes += (axisRects.length / 4) * 8;
    }

    // labels: glyphs are cached server-side, layouts cached here
    if (!spec.y.hide) {
      for (const t of yTicks) {
        const l = this._label(t.label, labelSize, labelColor);
        if (!l) continue;
        l.draw(ctx, plot.x - TICK_GAP - l.width, t.px - l.height / 2);
        stats.commands++;
      }
    }
    if (!spec.x.hide) {
      const baseY = plot.y + plot.height + 4;
      let lastRight = -Infinity;
      for (const t of xTicks) {
        const l = this._label(t.label, labelSize, labelColor);
        if (!l) continue;
        const x = t.px - l.width / 2;
        // drop labels that would collide rather than letting them smear
        if (x < lastRight + 4) continue;
        lastRight = x + l.width;
        l.draw(ctx, x, baseY);
        stats.commands++;
      }
    }
  }

  // --- the tooltip's questions --------------------------------------------

  /** The plot rectangle in window coordinates, for overlay positioning. */
  plotRect(): PlotRect | null {
    return this._layout()?.plot ?? null;
  }

  /**
   * What is under a window-coordinate pointer x: the snapped index, its x
   * value, and every series' value and pixel position there. Null outside
   * the data or before layout. O(log n) against sorted data.
   */
  hitAt(winX: number): ChartHit | null {
    const layout = this._layout();
    const { spec } = this._props();
    if (!layout || !spec || layout.geoms.length === 0) return null;
    const { plot, xScale, yScale } = layout;
    const clamped = Math.max(plot.x, Math.min(plot.x + plot.width, winX));

    let index: number;
    let px: number;
    let xValue: number | string;
    if (xScale.kind === 'band') {
      index = xScale.indexAt(clamped);
      if (index < 0) return null;
      px = xScale.center(index);
      xValue = layout.xCol
        ? (layout.xCol.values[index] as number | string)
        : index;
    } else {
      const xv = xScale.invert(clamped);
      const g0 = layout.geoms[0];
      if (g0.x && g0.xIdx) {
        index = nearestIndex(
          g0.xIdx,
          g0.x.values,
          Math.min(g0.x.n, g0.y.n),
          xv,
        );
        if (index < 0) return null;
        xValue = g0.x.values[index] as number;
        px = xScale.scale(xValue);
      } else {
        index = Math.max(0, Math.min(g0.y.n - 1, Math.round(xv)));
        xValue = index;
        px = xScale.scale(index);
      }
    }

    const points: ChartHit['points'] = [];
    for (const geom of layout.geoms) {
      // the tooltip reports the raw series value, not the stack top
      const rawCol = numericColumn(
        resolveColumn(this._props().data as ChartSourceData, geom.spec.id),
      );
      if (!rawCol || index >= rawCol.n) continue;
      const value = rawCol.values[index] as number;
      if (Number.isNaN(value)) continue;
      // the marker sits on what is painted — the stack top for stacked series
      const painted = geom.y.values[index] as number;
      points.push({
        id: geom.spec.id,
        label: geom.spec.label,
        color: geom.color,
        value,
        py: yScale.scale(Number.isNaN(painted) ? value : painted),
      });
    }
    if (points.length === 0) return null;
    const xSpan = xScale.kind === 'band' ? 0 : xScale.d1 - xScale.d0;
    return { index, xValue, px, xSpan, plot, points };
  }
}
