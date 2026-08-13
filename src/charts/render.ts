// The series renderers: data columns → drawing commands, with the mode
// decision that keeps every frame bounded by pixels.
//
// Two rules govern everything here:
//
// 1. **Cost scales with pixels, never with points.** Below DENSE_PPX points
//    per pixel a series draws as a real stroked path (antialiased, curved,
//    dotted); above it, each pixel column collapses to its min/max span
//    through the pyramid and the whole series goes out as one `fillRects`
//    batch. A million points in a 40px cell cost ~40 rectangles.
//
// 2. **Server-side commands by default, pixels when they win.** The command
//    stream is bounded by the width (rule 1), so it is almost always far
//    smaller than pushing the plot as an image. The one exception is a
//    scatter so dense it covers most of the plot — rectangles then cost
//    more bytes than the pixels do (8/cell vs 4/px), and the renderer
//    flips to compositing a density image. The crossover is computed from
//    those two numbers, not guessed.
//
// The renderers draw through a structural slice of ntk's context and take
// their caches through `RenderHost`, so they run identically against the
// real server, the recording mock, and the plain fakes in the tests.

import type { NumericColumn, MinMax, XIndex } from './data.js';
import {
  lowerBound,
  minMaxRange,
  pyramidFor,
  visibleIndexRange,
  xIndexFor,
} from './data.js';
import type { BandScale, LinearScale } from './scale.js';
import type { ChartFrameStats, SeriesSpec } from './spec.js';

/** points per pixel above which a line/area stops stroking real segments
 * and collapses to per-column spans */
export const DENSE_PPX = 2;
/** most points a sparse pass will ever stroke (DENSE_PPX × a wide plot) */
export const ROUND_JOIN_MAX = 256;
/** dots/points drawn as real circles; batched squares above, nothing once
 * the grid takes over */
export const CIRCLE_MAX = 96;
export const DIRECT_SCATTER_MAX = 512;
/** bars that may keep their rounded tops — past this they go square into
 * one batch */
export const BAR_RADIUS_MAX = 256;

export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The slice of ntk's 2d context the renderers need. Everything optional is
 * feature-tested: the mock backend has most of it, the plain test fakes
 * less, and a missing method degrades the drawing rather than throwing. */
export interface PlotContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha?: number;
  lineJoin?: string;
  lineCap?: string;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillRects?(rects: number[]): void;
  beginPath?(): void;
  moveTo?(x: number, y: number): void;
  lineTo?(x: number, y: number): void;
  bezierCurveTo?(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x: number,
    y: number,
  ): void;
  arc?(x: number, y: number, r: number, a0: number, a1: number): void;
  closePath?(): void;
  stroke?(): void;
  fill?(): void;
  rect?(x: number, y: number, w: number, h: number): void;
  clip?(): void;
  drawImage?(image: unknown, dx: number, dy: number): void;
  roundRect?(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: number | number[],
  ): void;
}

export const canPath = (
  ctx: PlotContext,
): ctx is PlotContext &
  Required<Pick<PlotContext, 'beginPath' | 'moveTo' | 'lineTo'>> =>
  typeof ctx.beginPath === 'function' &&
  typeof ctx.moveTo === 'function' &&
  typeof ctx.lineTo === 'function';

/** One batched fill for many rectangles, or the loop where the context has
 * no batch — same pixels, more requests, which is the mock's documented
 * contract too. */
function fillRects(ctx: PlotContext, rects: number[]): void {
  if (typeof ctx.fillRects === 'function') {
    ctx.fillRects(rects);
    return;
  }
  for (let i = 0; i + 3 < rects.length; i += 4) {
    ctx.fillRect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
  }
}

/** Mutable accumulator behind `ChartFrameStats`. */
export interface FrameStatsSink {
  pointsSpanned: number;
  commands: number;
  estimatedWireBytes: number;
  series: ChartFrameStats['series'];
}

/** Estimated wire bytes per primitive — the numbers the mode policy
 * compares. A rectangle is 8 bytes in a FillRectangles; a stroked segment
 * extrudes to two triangles at 24 bytes each; an image pixel is 4. */
export const BYTES_PER_RECT = 8;
export const BYTES_PER_SEGMENT = 48;
export const BYTES_PER_PIXEL = 4;

// --- per-series input ------------------------------------------------------

/** A series' resolved geometry inputs, prepared by the node. */
export interface SeriesGeometry {
  spec: SeriesSpec;
  /** y values (or the stack top for this layer). */
  y: NumericColumn;
  /** The stack base: the layer below's tops, or a constant domain value. */
  base: NumericColumn | number;
  /** x column; null means "the index is the x value". */
  x: NumericColumn | null;
  /** Index metadata for x when there is a column. */
  xIdx: XIndex | null;
  /** Bars: which slot of how many this series takes within a band. */
  group: { index: number; count: number };
  /** Paint-ready colour (theme tokens already resolved). */
  color: string;
}

export interface SeriesEnv {
  ctx: PlotContext;
  plot: PlotRect;
  xScale: LinearScale | BandScale;
  yScale: LinearScale;
  stats: FrameStatsSink;
  host: RenderHost;
}

/** Caches and capabilities only the retained node can provide. */
export interface RenderHost {
  /** Per-series scatter occupancy grid, cached across frames. */
  scatterGrid(id: string, key: string, n: number): ScatterGrid;
  /**
   * Composite a straight-RGBA image over the plot, preserving what is
   * already painted underneath. False when this backend cannot (no
   * XRender surface — the mock), in which case the caller uses rects.
   * `contentKey` names what `fill` would produce: an unchanged key lets
   * the host re-composite its retained surface without refilling or
   * re-uploading a pixel.
   */
  blitImage(
    x: number,
    y: number,
    w: number,
    h: number,
    fill: (data: Uint8ClampedArray) => void,
    contentKey?: string,
  ): boolean;
}

// --- helpers ---------------------------------------------------------------

const mm: MinMax = { min: 0, max: 0 };

function xValueAt(g: SeriesGeometry, i: number): number {
  return g.x ? (g.x.values[i] as number) : i;
}

/** Pixel x for a data index — linear x maps the value, band x maps the
 * index to its band center (a line over categories walks the centers). */
function pxAt(env: SeriesEnv, g: SeriesGeometry, i: number): number {
  return env.xScale.kind === 'band'
    ? env.xScale.center(i)
    : env.xScale.scale(xValueAt(g, i));
}

/** The visible index window for this series under the current x domain. */
export function visibleRange(
  env: SeriesEnv,
  g: SeriesGeometry,
): [number, number] {
  const n = g.y.n;
  if (env.xScale.kind === 'band') return [0, n];
  if (!g.x || !g.xIdx) {
    const i0 = Math.max(0, Math.floor(env.xScale.d0) - 1);
    const i1 = Math.min(n, Math.ceil(env.xScale.d1) + 2);
    return [i0, Math.max(i0, i1)];
  }
  return visibleIndexRange(
    g.xIdx,
    g.x.values,
    Math.min(n, g.x.n),
    env.xScale.d0,
    env.xScale.d1,
  );
}

/** Last finite y at or before `i1-1`, looking back a bounded distance —
 * the M4 "close" value that bridges adjacent columns. */
function lastFinite(values: ArrayLike<number>, i0: number, i1: number): number {
  const stop = Math.max(i0, i1 - 16);
  for (let i = i1 - 1; i >= stop; i--) {
    const v = values[i];
    if (!Number.isNaN(v)) return v;
  }
  return NaN;
}

/**
 * Walk the pixel columns of the visible range, handing each column its
 * exact index window. Uniform x advances arithmetically; sorted x binary
 * searches each boundary (O(width · log n), bounded); the band case is
 * plain proportional slicing. `cb` returns nothing; gaps come through as
 * empty windows.
 */
function walkColumns(
  env: SeriesEnv,
  g: SeriesGeometry,
  i0: number,
  i1: number,
  cb: (colPx: number, ia: number, ib: number) => void,
): void {
  const { plot } = env;
  const cols = Math.max(1, Math.round(plot.width));
  if (env.xScale.kind === 'band' || !g.x || !g.xIdx || !g.xIdx.sorted) {
    // proportional index slicing: exact for bands, and the honest bounded
    // fallback for unsorted x (index order is all there is to draw)
    const span = i1 - i0;
    let prev = i0;
    for (let c = 0; c < cols; c++) {
      const ib = c + 1 >= cols ? i1 : i0 + Math.floor((span * (c + 1)) / cols);
      cb(plot.x + c, prev, ib);
      prev = ib;
    }
    return;
  }
  const xs = g.x.values;
  const n = Math.min(g.y.n, g.x.n);
  const idx = g.xIdx;
  const scale = env.xScale as LinearScale;
  const uniform = idx.uniform && idx.dx > 0;
  let prev = i0;
  for (let c = 0; c < cols; c++) {
    let ib: number;
    if (c + 1 >= cols) {
      ib = i1;
    } else {
      const xRight = scale.invert(plot.x + c + 1);
      ib = uniform
        ? Math.ceil((xRight - idx.x0) / idx.dx)
        : lowerBound(xs, n, xRight);
      if (ib < prev) ib = prev;
      if (ib > i1) ib = i1;
    }
    cb(plot.x + c, prev, ib);
    prev = ib;
  }
}

// --- monotone curve --------------------------------------------------------

/**
 * Fritsch–Carlson monotone cubic tangents — the `curve="monotone"`
 * recharts draws, so a smoothed series never overshoots its own points.
 */
function monotoneTangents(xs: number[], ys: number[]): number[] {
  const m = xs.length;
  const t = new Array<number>(m);
  if (m < 2) return t.fill(0);
  const s: number[] = [];
  for (let i = 0; i < m - 1; i++) {
    const h = xs[i + 1] - xs[i];
    s.push(h === 0 ? 0 : (ys[i + 1] - ys[i]) / h);
  }
  t[0] = s[0];
  t[m - 1] = s[m - 2];
  for (let i = 1; i < m - 1; i++) {
    t[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
  }
  for (let i = 0; i < m - 1; i++) {
    if (s[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / s[i];
    const b = t[i + 1] / s[i];
    const len = a * a + b * b;
    if (len > 9) {
      const scale = 3 / Math.sqrt(len);
      t[i] = scale * a * s[i];
      t[i + 1] = scale * b * s[i];
    }
  }
  return t;
}

/** Emit one already-collected run of points into the current path. */
function emitRun(
  ctx: PlotContext,
  xs: number[],
  ys: number[],
  curve: SeriesSpec['curve'],
  move: boolean,
): void {
  const m = xs.length;
  if (m === 0) return;
  if (move) ctx.moveTo!(xs[0], ys[0]);
  else ctx.lineTo!(xs[0], ys[0]);
  if (curve === 'monotone' && m > 2 && ctx.bezierCurveTo) {
    const t = monotoneTangents(xs, ys);
    for (let i = 0; i < m - 1; i++) {
      const h = (xs[i + 1] - xs[i]) / 3;
      ctx.bezierCurveTo(
        xs[i] + h,
        ys[i] + t[i] * h,
        xs[i + 1] - h,
        ys[i + 1] - t[i + 1] * h,
        xs[i + 1],
        ys[i + 1],
      );
    }
    return;
  }
  if (curve === 'step') {
    for (let i = 1; i < m; i++) {
      ctx.lineTo!(xs[i], ys[i - 1]);
      ctx.lineTo!(xs[i], ys[i]);
    }
    return;
  }
  for (let i = 1; i < m; i++) ctx.lineTo!(xs[i], ys[i]);
}

// --- line / area -----------------------------------------------------------

/** Clamp a pixel span to the plot; null when it misses entirely. */
function clampSpan(
  plot: PlotRect,
  top: number,
  bottom: number,
): [number, number] | null {
  const y0 = Math.max(plot.y, top);
  const y1 = Math.min(plot.y + plot.height, bottom);
  if (y1 <= y0 - 0.5) return null;
  return [y0, Math.max(y1, y0 + 1)];
}

function baseValueAt(g: SeriesGeometry, i: number): number {
  return typeof g.base === 'number' ? g.base : (g.base.values[i] as number);
}

/**
 * A line or area series. Sparse: a stroked (and for areas, filled) path
 * through the real points. Dense: per-column min/max spans bridged with the
 * previous column's closing value, batched into one request — the M4
 * rendering, which is pixel-identical to drawing every point.
 */
export function renderLineArea(env: SeriesEnv, g: SeriesGeometry): void {
  const { ctx, plot, yScale, stats } = env;
  const [i0, i1] = visibleRange(env, g);
  const count = Math.max(0, i1 - i0);
  stats.pointsSpanned += count;
  const isArea = g.spec.type === 'area';
  if (count < 2) {
    stats.series.push({ id: g.spec.id, mode: 'skipped', points: count });
    return;
  }

  const density = count / Math.max(1, plot.width);
  if (density <= DENSE_PPX && canPath(ctx) && ctx.stroke) {
    // ---- sparse: real geometry. Runs split at NaN, each carrying its own
    // base edge so an area's return path is collected in the same walk.
    const runsX: number[][] = [];
    const runsY: number[][] = [];
    const runsB: number[][] = [];
    let xs: number[] = [];
    let ys: number[] = [];
    let bs: number[] = [];
    const yv = g.y.values;
    const flush = () => {
      if (xs.length) {
        runsX.push(xs);
        runsY.push(ys);
        runsB.push(bs);
        xs = [];
        ys = [];
        bs = [];
      }
    };
    for (let i = i0; i < i1; i++) {
      const v = yv[i] as number;
      if (Number.isNaN(v)) {
        flush();
        continue;
      }
      xs.push(pxAt(env, g, i));
      ys.push(yScale.scale(v));
      if (isArea) {
        const b = baseValueAt(g, i);
        bs.push(yScale.scale(Number.isNaN(b) ? 0 : b));
      }
    }
    flush();

    if (isArea && ctx.fill) {
      // fill each run down to its base edge, walked back with the same
      // curve — a stacked layer's base is the layer below's top, so the
      // two paths coincide and the seam is exact
      ctx.save();
      if (ctx.globalAlpha !== undefined) ctx.globalAlpha = g.spec.fillOpacity;
      ctx.fillStyle = g.color;
      ctx.beginPath!();
      for (let r = 0; r < runsX.length; r++) {
        emitRun(ctx, runsX[r], runsY[r], g.spec.curve, true);
        const backX = runsX[r].slice().reverse();
        const backY = runsB[r].slice().reverse();
        emitRun(ctx, backX, backY, g.spec.curve, false);
        ctx.closePath?.();
      }
      ctx.fill();
      ctx.restore();
      stats.commands++;
      stats.estimatedWireBytes += count * BYTES_PER_SEGMENT * 2;
    }

    ctx.save();
    ctx.strokeStyle = g.color;
    ctx.lineWidth = g.spec.strokeWidth;
    if (count <= ROUND_JOIN_MAX) {
      if (ctx.lineJoin !== undefined) ctx.lineJoin = 'round';
      if (ctx.lineCap !== undefined) ctx.lineCap = 'round';
    }
    ctx.beginPath!();
    for (let r = 0; r < runsX.length; r++) {
      emitRun(ctx, runsX[r], runsY[r], g.spec.curve, true);
    }
    ctx.stroke();
    ctx.restore();
    stats.commands++;
    stats.estimatedWireBytes += count * BYTES_PER_SEGMENT;

    if (g.spec.dot !== false && g.spec.dot > 0) {
      renderDots(env, runsX, runsY, g.spec.dot, g.color);
    }
    stats.series.push({ id: g.spec.id, mode: 'polyline', points: count });
    return;
  }

  // ---- dense: per-column spans through the pyramid
  const pyr = pyramidFor(g.y);
  const yv = g.y.values;
  const strokeRects: number[] = [];
  const fillRectsArr: number[] = [];
  const half = Math.max(0, (g.spec.strokeWidth - 1) / 2);
  const baseConst =
    typeof g.base === 'number' ? Math.round(yScale.scale(g.base)) : null;
  const basePyr =
    isArea && typeof g.base !== 'number' ? pyramidFor(g.base) : null;
  let prevLast = NaN;
  walkColumns(env, g, i0, i1, (colPx, ia, ib) => {
    if (ib <= ia) {
      prevLast = NaN;
      return;
    }
    minMaxRange(pyr, yv, ia, ib, mm);
    if (mm.min > mm.max) {
      prevLast = NaN;
      return;
    }
    const closing = lastFinite(yv, ia, ib);
    let lo = mm.min;
    let hi = mm.max;
    if (!Number.isNaN(prevLast)) {
      if (prevLast < lo) lo = prevLast;
      if (prevLast > hi) hi = prevLast;
    }
    prevLast = closing;
    const span = clampSpan(
      env.plot,
      Math.round(yScale.scale(hi) - half),
      Math.round(yScale.scale(lo) + half),
    );
    if (span) strokeRects.push(colPx, span[0], 1, span[1] - span[0]);

    if (isArea && !Number.isNaN(closing)) {
      let basePx: number;
      if (baseConst !== null) {
        basePx = baseConst;
      } else {
        const baseCol = g.base as NumericColumn;
        minMaxRange(basePyr!, baseCol.values, ia, ib, mm);
        const baseClosing = lastFinite(baseCol.values, ia, ib);
        basePx = Math.round(
          yScale.scale(Number.isNaN(baseClosing) ? 0 : baseClosing),
        );
      }
      const topPx = Math.round(yScale.scale(closing));
      const fillSpan = clampSpan(
        env.plot,
        Math.min(topPx, basePx),
        Math.max(topPx, basePx),
      );
      if (fillSpan) {
        fillRectsArr.push(colPx, fillSpan[0], 1, fillSpan[1] - fillSpan[0]);
      }
    }
  });

  if (isArea && fillRectsArr.length) {
    ctx.save();
    if (ctx.globalAlpha !== undefined) ctx.globalAlpha = g.spec.fillOpacity;
    ctx.fillStyle = g.color;
    fillRects(ctx, fillRectsArr);
    ctx.restore();
    stats.commands++;
    stats.estimatedWireBytes += (fillRectsArr.length / 4) * BYTES_PER_RECT;
  }
  if (strokeRects.length) {
    ctx.save();
    ctx.fillStyle = g.color;
    fillRects(ctx, strokeRects);
    ctx.restore();
    stats.commands++;
    stats.estimatedWireBytes += (strokeRects.length / 4) * BYTES_PER_RECT;
  }
  stats.series.push({ id: g.spec.id, mode: 'columns', points: count });
}

function renderDots(
  env: SeriesEnv,
  runsX: number[][],
  runsY: number[][],
  r: number,
  color: string,
): void {
  const { ctx, stats } = env;
  let total = 0;
  for (const run of runsX) total += run.length;
  if (total <= CIRCLE_MAX && ctx.arc && ctx.fill && ctx.beginPath) {
    ctx.save();
    ctx.fillStyle = color;
    for (let k = 0; k < runsX.length; k++) {
      for (let i = 0; i < runsX[k].length; i++) {
        ctx.beginPath();
        ctx.arc(runsX[k][i], runsY[k][i], r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    stats.commands += total;
    stats.estimatedWireBytes += total * BYTES_PER_SEGMENT;
    return;
  }
  const rects: number[] = [];
  for (let k = 0; k < runsX.length; k++) {
    for (let i = 0; i < runsX[k].length; i++) {
      rects.push(
        Math.round(runsX[k][i] - r),
        Math.round(runsY[k][i] - r),
        Math.round(2 * r),
        Math.round(2 * r),
      );
    }
  }
  ctx.save();
  ctx.fillStyle = color;
  fillRects(ctx, rects);
  ctx.restore();
  stats.commands++;
  stats.estimatedWireBytes += (rects.length / 4) * BYTES_PER_RECT;
}

// --- bars ------------------------------------------------------------------

/**
 * Bars over a band scale. The normal case is one `fillRects` batch per
 * series; rounded tops keep their radius only while the count stays small
 * enough that per-bar paths are cheaper than they are pretty; and a series
 * with more bars than pixels collapses to the same per-column envelope a
 * dense line uses — a 100k-bar histogram is a silhouette either way.
 */
export function renderBars(env: SeriesEnv, g: SeriesGeometry): void {
  const { ctx, yScale, stats } = env;
  if (env.xScale.kind !== 'band') {
    stats.series.push({ id: g.spec.id, mode: 'skipped', points: 0 });
    return;
  }
  const band = env.xScale;
  const n = Math.min(g.y.n, band.count);
  stats.pointsSpanned += n;
  const yv = g.y.values;

  if (band.bandwidth / g.group.count < 1 || n > env.plot.width * 2) {
    // envelope: per-column span from the base to the tallest bar
    const pyr = pyramidFor(g.y);
    const rects: number[] = [];
    const cols = Math.max(1, Math.round(env.plot.width));
    const basePx = Math.round(
      yScale.scale(typeof g.base === 'number' ? g.base : 0),
    );
    let prev = 0;
    for (let c = 0; c < cols; c++) {
      const ib = c + 1 >= cols ? n : Math.floor((n * (c + 1)) / cols);
      if (ib > prev) {
        minMaxRange(pyr, yv, prev, ib, mm);
        if (mm.min <= mm.max) {
          const hiPx = Math.round(yScale.scale(mm.max));
          const loPx = Math.round(yScale.scale(Math.min(mm.min, 0)));
          const span = clampSpan(
            env.plot,
            Math.min(hiPx, loPx, basePx),
            Math.max(hiPx, loPx, basePx),
          );
          if (span) rects.push(env.plot.x + c, span[0], 1, span[1] - span[0]);
        }
      }
      prev = ib;
    }
    ctx.save();
    ctx.fillStyle = g.color;
    fillRects(ctx, rects);
    ctx.restore();
    stats.commands++;
    stats.estimatedWireBytes += (rects.length / 4) * BYTES_PER_RECT;
    stats.series.push({ id: g.spec.id, mode: 'columns', points: n });
    return;
  }

  const slot = band.bandwidth / g.group.count;
  const gap = g.group.count > 1 && slot > 3 ? 1 : 0;
  const w = Math.max(1, Math.round(slot - gap));
  const rounded =
    g.spec.barRadius > 0 &&
    n <= BAR_RADIUS_MAX &&
    canPath(ctx) &&
    typeof ctx.roundRect === 'function' &&
    typeof ctx.fill === 'function';
  const rects: number[] = [];
  ctx.save();
  ctx.fillStyle = g.color;
  for (let i = 0; i < n; i++) {
    const v = yv[i] as number;
    if (Number.isNaN(v)) continue;
    const base = baseValueAt(g, i);
    const x = Math.round(band.scale(i) + slot * g.group.index);
    const y0 = yScale.scale(v);
    const y1 = yScale.scale(Number.isNaN(base) ? 0 : base);
    const top = Math.round(Math.min(y0, y1));
    const h = Math.max(1, Math.round(Math.abs(y1 - y0)));
    if (rounded) {
      const r = Math.min(g.spec.barRadius, w / 2, h);
      ctx.beginPath!();
      // round the value end only — the stack seam and the axis stay square
      const radii = y0 <= y1 ? [r, r, 0, 0] : [0, 0, r, r];
      ctx.roundRect!(x, top, w, h, radii);
      ctx.fill!();
      stats.commands++;
      stats.estimatedWireBytes += BYTES_PER_RECT * 3;
    } else {
      rects.push(x, top, w, h);
    }
  }
  if (rects.length) {
    fillRects(ctx, rects);
    stats.commands++;
    stats.estimatedWireBytes += (rects.length / 4) * BYTES_PER_RECT;
  }
  ctx.restore();
  stats.series.push({
    id: g.spec.id,
    mode: rounded ? 'rects' : 'bars',
    points: n,
  });
}

// --- scatter ---------------------------------------------------------------

/** The occupancy grid a dense scatter reduces to: point counts per
 * dot-sized cell, extended incrementally as data appends. */
export interface ScatterGrid {
  key: string;
  cell: number;
  gw: number;
  gh: number;
  counts: Uint32Array;
  occupied: number;
  maxCount: number;
  /** points consumed so far — the incremental cursor */
  consumedN: number;
  /** rects per alpha bucket, rebuilt only when the grid changed */
  buckets: number[][] | null;
}

export function makeScatterGrid(
  key: string,
  cell: number,
  gw: number,
  gh: number,
): ScatterGrid {
  return {
    key,
    cell,
    gw,
    gh,
    counts: new Uint32Array(gw * gh),
    occupied: 0,
    maxCount: 0,
    consumedN: 0,
    buckets: null,
  };
}

const ALPHA_LEVELS = 8;

/** #rgb/#rrggbb/#rrggbbaa → [r,g,b,a?]; null for anything fancier, which
 * simply keeps the rect path. */
export function parseHexColor(
  color: string,
): [number, number, number, number] | null {
  if (!color.startsWith('#')) return null;
  const hex = color.slice(1);
  const digit = (c: string) => parseInt(c, 16);
  if (hex.length === 3) {
    return [digit(hex[0]) * 17, digit(hex[1]) * 17, digit(hex[2]) * 17, 255];
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const gg = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
    if ([r, gg, b, a].some(Number.isNaN)) return null;
    return [r, gg, b, a];
  }
  return null;
}

/**
 * A scatter series. A handful of points draw directly (circles, then one
 * batch of squares); past that the series reduces to the occupancy grid —
 * a million coincident points are one cell — rendered as per-alpha-level
 * `fillRects` batches, or as one composited density image once rectangles
 * would cost more bytes than pixels.
 */
export function renderScatter(env: SeriesEnv, g: SeriesGeometry): void {
  const { ctx, plot, yScale, stats } = env;
  const n = g.x ? Math.min(g.y.n, g.x.n) : g.y.n;
  stats.pointsSpanned += n;
  const size = Math.max(1, Math.round(g.spec.size));
  const yv = g.y.values;

  if (n <= DIRECT_SCATTER_MAX) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = yv[i] as number;
      if (Number.isNaN(v)) continue;
      const px = pxAt(env, g, i);
      const py = yScale.scale(v);
      if (px < plot.x || px > plot.x + plot.width) continue;
      xs.push(px);
      ys.push(py);
    }
    renderDots(env, [xs], [ys], size / 2 + 0.5, g.color);
    stats.series.push({ id: g.spec.id, mode: 'rects', points: n });
    return;
  }

  // ---- dense: occupancy grid
  const cell = size;
  const gw = Math.max(1, Math.ceil(plot.width / cell));
  const gh = Math.max(1, Math.ceil(plot.height / cell));
  const xScale = env.xScale;
  const domKey =
    xScale.kind === 'band' ? `b${xScale.count}` : `${xScale.d0},${xScale.d1}`;
  const key = `${cell}|${gw}|${gh}|${domKey}|${yScale.d0},${yScale.d1}|${g.y.epoch}`;
  const grid = env.host.scatterGrid(g.spec.id, key, n);

  if (grid.consumedN < n) {
    const kx = gw / plot.width;
    const ky = gh / plot.height;
    for (let i = grid.consumedN; i < n; i++) {
      const v = yv[i] as number;
      if (Number.isNaN(v)) continue;
      const px = pxAt(env, g, i) - plot.x;
      const py = yScale.scale(v) - plot.y;
      const cx = Math.floor(px * kx);
      const cy = Math.floor(py * ky);
      if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) continue;
      const at = cy * gw + cx;
      const before = grid.counts[at]++;
      if (before === 0) grid.occupied++;
      if (before + 1 > grid.maxCount) grid.maxCount = before + 1;
    }
    grid.consumedN = n;
    grid.buckets = null;
  }

  // rectangles vs pixels: the byte crossover, computed
  const rectBytes = grid.occupied * BYTES_PER_RECT;
  const imageBytes = plot.width * plot.height * BYTES_PER_PIXEL;
  const rgb = parseHexColor(g.color);
  if (rectBytes > imageBytes && rgb) {
    const drawn = env.host.blitImage(
      plot.x,
      plot.y,
      gw * cell,
      gh * cell,
      (data) => {
        const [r, gg, b] = rgb;
        for (let cy = 0; cy < gh; cy++) {
          for (let cx = 0; cx < gw; cx++) {
            const count = grid.counts[cy * gw + cx];
            if (count === 0) continue;
            const a = Math.round(
              255 * (0.3 + 0.7 * Math.sqrt(count / grid.maxCount)),
            );
            for (let dy = 0; dy < cell; dy++) {
              let at = ((cy * cell + dy) * gw * cell + cx * cell) * 4;
              for (let dx = 0; dx < cell; dx++) {
                data[at] = r;
                data[at + 1] = gg;
                data[at + 2] = b;
                data[at + 3] = a;
                at += 4;
              }
            }
          }
        }
      },
      // same grid content + colour → the host recomposites its retained
      // surface: no refill, no upload
      `${grid.key}#${grid.consumedN}|${g.color}`,
    );
    if (drawn) {
      stats.commands++;
      stats.estimatedWireBytes += imageBytes;
      stats.series.push({ id: g.spec.id, mode: 'image', points: n });
      return;
    }
  }

  if (!grid.buckets) {
    // Plot-LOCAL coordinates, translated at draw time. Nothing that lives
    // across frames may bake in the plot's window position: every part of
    // the cache key stays equal while a scroll or a section reflow moves
    // the plot rect, and window-space buckets then redraw at the old
    // origin — sliced flat by the series clip, or clipped away entirely.
    const buckets: number[][] = Array.from({ length: ALPHA_LEVELS }, () => []);
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        const count = grid.counts[cy * gw + cx];
        if (count === 0) continue;
        const level = Math.min(
          ALPHA_LEVELS - 1,
          Math.floor(Math.sqrt(count / grid.maxCount) * ALPHA_LEVELS),
        );
        buckets[level].push(cx * cell, cy * cell, cell, cell);
      }
    }
    grid.buckets = buckets;
  }
  ctx.save();
  ctx.fillStyle = g.color;
  for (let level = 0; level < ALPHA_LEVELS; level++) {
    const local = grid.buckets[level];
    if (!local.length) continue;
    if (ctx.globalAlpha !== undefined) {
      ctx.globalAlpha = 0.3 + (0.7 * (level + 1)) / ALPHA_LEVELS;
    }
    // translate manually: ctx.translate would kick fillRects off ntk's
    // single-FillRectangles fast path (it requires an identity transform)
    const rects = new Array<number>(local.length);
    for (let i = 0; i < local.length; i += 4) {
      rects[i] = local[i] + plot.x;
      rects[i + 1] = local[i + 1] + plot.y;
      rects[i + 2] = local[i + 2];
      rects[i + 3] = local[i + 3];
    }
    fillRects(ctx, rects);
    stats.commands++;
    stats.estimatedWireBytes += (rects.length / 4) * BYTES_PER_RECT;
  }
  ctx.restore();
  stats.series.push({ id: g.spec.id, mode: 'columns', points: n });
}

/** One dispatch for the node's series loop. */
export function renderSeries(env: SeriesEnv, g: SeriesGeometry): void {
  switch (g.spec.type) {
    case 'line':
    case 'area':
      renderLineArea(env, g);
      break;
    case 'bar':
      renderBars(env, g);
      break;
    case 'scatter':
      renderScatter(env, g);
      break;
  }
}

/** Re-exported for the node; keeps `data.js` out of its import list. */
export { pyramidFor, xIndexFor };
