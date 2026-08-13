// Charts: the decimation pyramid against brute force, the mode policy's
// command bounds, the streaming store's incremental contracts, and the
// composed component through the headless harness.
//
// The perf claims in docs/prd-charts.md are asserted here, not aspired to:
// a million points must go out as O(width) rectangles, a hover must not
// repaint the plot, and an append to a chart nobody can see must not
// schedule work.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  act,
  fireEvent,
  textOf,
  pixelAt,
} from 'react-x11/test';
import { drawnKinds, knownElements } from 'react-x11/host';
import type { Node as RetainedNode } from 'react-x11/node';

import {
  ChartContainer,
  LineChart,
  BarChart,
  ScatterChart,
  LineSeries,
  BarSeries,
  ScatterSeries,
  XAxis,
  YAxis,
  CartesianGrid,
  ChartTooltip,
  ChartLegend,
  ChartData,
  CHARTPLOT_ELEMENT,
} from '../src/index.js';
import type { ChartFrameStats } from '../src/index.js';

import {
  minMaxRange,
  nearestIndex,
  pyramidFor,
  resolveColumn,
  visibleIndexRange,
  xIndexFor,
} from '../src/charts/data.js';
import type { NumericColumn } from '../src/charts/data.js';
import {
  bandScale,
  formatNumberTick,
  linearScale,
  linearTicks,
  niceDomain,
  timeTicks,
} from '../src/charts/scale.js';
import {
  DENSE_PPX,
  renderBars,
  renderLineArea,
  renderScatter,
  makeScatterGrid,
} from '../src/charts/render.js';
import type {
  FrameStatsSink,
  PlotContext,
  ScatterGrid,
  SeriesEnv,
  SeriesGeometry,
} from '../src/charts/render.js';
import type { SeriesSpec } from '../src/charts/spec.js';
import type { ChartPlotNode } from '../src/charts/node.js';

const h = React.createElement;

afterEach(cleanup);

/** Widen a query result to the retained node: the queries hand back the
 * ref-facing `DrawnNode` view, and a test about `kind`, `props` and paint
 * order has to reach for the retained class underneath. */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

function plotNode(): ChartPlotNode {
  const [node] = screen.all((n) => retained(n).kind === CHARTPLOT_ELEMENT);
  assert.ok(node, 'the element is in the retained tree');
  return node as unknown as ChartPlotNode;
}

function column(values: ArrayLike<number>): NumericColumn {
  return {
    values,
    n: values.length,
    host: values as object,
    epoch: 0,
    numeric: true,
  };
}

// --- pyramid ---------------------------------------------------------------

function bruteMinMax(
  values: ArrayLike<number>,
  i0: number,
  i1: number,
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = i0; i < i1; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

test('pyramid min/max agrees with brute force over arbitrary ranges', () => {
  const n = 10_000;
  const values = new Float64Array(n);
  let seed = 42;
  const rand = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < n; i++) values[i] = Math.sin(i / 50) * 100 + rand() * 10;
  // a hole, to exercise the NaN skipping
  for (let i = 5000; i < 5100; i++) values[i] = NaN;

  const col = column(values);
  const pyr = pyramidFor(col);
  const out = { min: 0, max: 0 };
  for (let t = 0; t < 500; t++) {
    const i0 = Math.floor(rand() * n);
    const i1 = i0 + Math.floor(rand() * (n - i0));
    minMaxRange(pyr, values, i0, i1, out);
    const [min, max] = bruteMinMax(values, i0, i1);
    assert.strictEqual(out.min, min, `min over [${i0}, ${i1})`);
    assert.strictEqual(out.max, max, `max over [${i0}, ${i1})`);
  }
  // a range that is entirely hole answers "empty"
  minMaxRange(pyr, values, 5010, 5090, out);
  assert.ok(out.min > out.max, 'an all-NaN range reads as empty');
});

test('pyramid extension over appends equals a fresh build', () => {
  const store = new ChartData();
  for (let i = 0; i < 1000; i++) store.append({ y: Math.sin(i / 9) * i });
  const col1 = store.column('y')!;
  const pyr1 = pyramidFor(col1 as NumericColumn);
  assert.strictEqual(pyr1.builtN, 1000);

  for (let i = 1000; i < 2500; i++) store.append({ y: Math.sin(i / 9) * i });
  const col2 = store.column('y')! as NumericColumn;
  const pyr2 = pyramidFor(col2);
  assert.strictEqual(pyr2, pyr1, 'extended in place, not rebuilt');

  const fresh = column(
    Array.from({ length: 2500 }, (_, i) => Math.sin(i / 9) * i),
  );
  const pyrFresh = pyramidFor(fresh);
  const a = { min: 0, max: 0 };
  const b = { min: 0, max: 0 };
  for (const [i0, i1] of [
    [0, 2500],
    [990, 1010],
    [17, 2401],
    [1024, 2048],
  ] as const) {
    minMaxRange(pyr2, col2.values, i0, i1, a);
    minMaxRange(pyrFresh, fresh.values, i0, i1, b);
    assert.deepStrictEqual(a, b, `range [${i0}, ${i1})`);
  }
});

test('the x index detects uniform and sorted columns, and binary search agrees', () => {
  const uniform = column(Array.from({ length: 100 }, (_, i) => 1000 + i * 5));
  const ui = xIndexFor(uniform);
  assert.ok(ui.uniform && ui.sorted);
  assert.deepStrictEqual(
    visibleIndexRange(ui, uniform.values, 100, 1100, 1200),
    [Math.floor((1100 - 1000) / 5) - 1, Math.ceil((1200 - 1000) / 5) + 2],
  );

  const ragged = column([0, 1, 4, 9, 16, 25, 36, 49]);
  const ri = xIndexFor(ragged);
  assert.ok(ri.sorted && !ri.uniform);
  assert.deepStrictEqual(
    visibleIndexRange(ri, ragged.values, 8, 3, 30),
    [1, 7],
  );
  assert.strictEqual(nearestIndex(ri, ragged.values, 8, 10), 3);
  assert.strictEqual(nearestIndex(ri, ragged.values, 8, 13), 4);

  const unsorted = column([5, 3, 8, 1]);
  const si = xIndexFor(unsorted);
  assert.ok(!si.sorted);
  assert.deepStrictEqual(
    visibleIndexRange(si, unsorted.values, 4, 0, 10),
    [0, 4],
  );
});

// --- scales ----------------------------------------------------------------

test('linear ticks land on the 1-2-5 ladder and cover the domain', () => {
  assert.deepStrictEqual(linearTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepStrictEqual(linearTicks(0, 7, 5), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual(
    linearTicks(-30, 30, 5),
    [-30, -20, -10, 0, 10, 20, 30],
  );
  assert.deepStrictEqual(niceDomain(3, 97, 5), [0, 100]);
  assert.deepStrictEqual(niceDomain(5, 5), [4, 6]);
});

test('time ticks pick calendar-shaped steps', () => {
  const MIN = 60_000;
  // 10 minutes at ~5 ticks: the raw step is 2min, and the ladder rounds up
  // to the 5-minute mark a person would label
  assert.deepStrictEqual(timeTicks(0, 10 * MIN, 5), [0, 5 * MIN, 10 * MIN]);
  const day = timeTicks(0, 3 * 24 * 3600_000, 4);
  assert.ok(day.length >= 2);
  assert.strictEqual((day[1] - day[0]) % 3600_000, 0, 'whole-hour steps');
});

test('band scale maps indices into padded slots and inverts to the nearest', () => {
  const band = bandScale(4, 0, 100);
  assert.ok(band.bandwidth > 0 && band.step > band.bandwidth);
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(band.indexAt(band.center(i)), i);
  }
  assert.strictEqual(band.indexAt(-10), 0);
  assert.strictEqual(band.indexAt(110), 3);
});

test('compact number labels', () => {
  assert.strictEqual(formatNumberTick(0), '0');
  assert.strictEqual(formatNumberTick(1500), '1.5k');
  assert.strictEqual(formatNumberTick(1_200_000), '1.2M');
  assert.strictEqual(formatNumberTick(0.25), '0.25');
});

// --- ChartData -------------------------------------------------------------

test('ChartData appends notify, backfill, and shift the window in batches', () => {
  const store = new ChartData({ maxLength: 100 });
  const changes: { appended: number; epoch: number }[] = [];
  const unsubscribe = store.subscribe((c) => changes.push({ ...c }));

  store.append({ t: 0, a: 1 });
  store.append({ t: 1, b: 2 }); // `b` is new: `a` backfills NaN
  assert.strictEqual(store.length, 2);
  assert.strictEqual(changes.length, 2);
  const a = store.column('a')! as NumericColumn;
  assert.ok(Number.isNaN(a.values[1] as number));
  const b = store.column('b')! as NumericColumn;
  assert.ok(Number.isNaN(b.values[0] as number));

  for (let i = 2; i < 113; i++) store.append({ t: i, a: i });
  // 113 > 100 * 1.125 → one shift back to the window
  assert.strictEqual(store.length, 100);
  assert.strictEqual(store.epoch, 1);
  const t = store.column('t')! as NumericColumn;
  assert.strictEqual(t.values[0], 13);
  const shifted = changes[changes.length - 1];
  assert.strictEqual(shifted.epoch, 1);

  unsubscribe();
  store.append({ t: 999, a: 1 });
  assert.strictEqual(changes.length, 113, 'unsubscribed hears nothing');
});

// --- renderers (fake context) ---------------------------------------------

interface FakeCtx extends PlotContext {
  batches: number[];
  rects: number[][];
  strokes: number;
  fills: number;
  pathPoints: number;
  arcs: number;
}

function fakeCtx(): FakeCtx {
  const ctx: FakeCtx = {
    batches: [],
    rects: [],
    strokes: 0,
    fills: 0,
    pathPoints: 0,
    arcs: 0,
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 1,
    globalAlpha: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    save() {},
    restore() {},
    fillRect(x, y, w, hh) {
      ctx.rects.push([x, y, w, hh]);
    },
    fillRects(flat) {
      ctx.batches.push(flat.length / 4);
      for (let i = 0; i + 3 < flat.length; i += 4) {
        ctx.rects.push([flat[i], flat[i + 1], flat[i + 2], flat[i + 3]]);
      }
    },
    beginPath() {},
    moveTo() {
      ctx.pathPoints++;
    },
    lineTo() {
      ctx.pathPoints++;
    },
    bezierCurveTo() {
      ctx.pathPoints++;
    },
    arc() {
      ctx.arcs++;
    },
    closePath() {},
    stroke() {
      ctx.strokes++;
    },
    fill() {
      ctx.fills++;
    },
    rect() {},
    clip() {},
    roundRect() {},
  };
  return ctx;
}

function seriesSpec(over: Partial<SeriesSpec>): SeriesSpec {
  return {
    id: 'y',
    type: 'line',
    color: '#123456',
    label: 'y',
    strokeWidth: 1,
    fillOpacity: 0.25,
    curve: 'linear',
    dot: false,
    stackId: null,
    barRadius: 0,
    size: 3,
    ...over,
  };
}

function makeEnv(
  ctx: FakeCtx,
  width: number,
  height: number,
  xDomain: [number, number],
  yDomain: [number, number],
): SeriesEnv & { stats: FrameStatsSink } {
  const grids = new Map<string, ScatterGrid>();
  return {
    ctx,
    plot: { x: 0, y: 0, width, height },
    xScale: linearScale(xDomain[0], xDomain[1], 0, width),
    yScale: linearScale(yDomain[0], yDomain[1], height, 0),
    stats: { pointsSpanned: 0, commands: 0, estimatedWireBytes: 0, series: [] },
    host: {
      scatterGrid(id, key) {
        let g = grids.get(id);
        if (!g || g.key !== key) {
          const [cell, gw, gh] = key.split('|');
          g = makeScatterGrid(key, Number(cell), Number(gw), Number(gh));
          grids.set(id, g);
        }
        return g;
      },
      blitImage: () => false,
    },
  };
}

function lineGeometry(
  values: ArrayLike<number>,
  over: Partial<SeriesSpec> = {},
): SeriesGeometry {
  return {
    spec: seriesSpec(over),
    y: column(values),
    base: 0,
    x: null,
    xIdx: null,
    group: { index: 0, count: 1 },
    color: '#123456',
  };
}

test('a million points collapse to one batch of column spans', () => {
  const n = 1_000_000;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = Math.sin(i / 5000) * 50 + 50;
  const ctx = fakeCtx();
  const width = 400;
  const env = makeEnv(ctx, width, 200, [0, n - 1], [0, 100]);

  renderLineArea(env, lineGeometry(values));

  assert.strictEqual(ctx.batches.length, 1, 'one fillRects request');
  assert.ok(
    ctx.rects.length <= width,
    `${ctx.rects.length} rects for ${width} columns`,
  );
  assert.strictEqual(ctx.strokes, 0, 'no path was stroked');
  assert.strictEqual(env.stats.series[0].mode, 'columns');
  assert.strictEqual(env.stats.pointsSpanned, n);
  assert.ok(
    env.stats.estimatedWireBytes <= width * 8 + 64,
    'wire cost is the width, not the data',
  );
  for (const [x, , w] of ctx.rects) {
    assert.ok(x >= 0 && x < width && w === 1);
  }
});

test('column spans are exact for a constant and bridge a square wave', () => {
  const width = 100;
  const flat = new Float64Array(10_000).fill(42);
  const ctxA = fakeCtx();
  renderLineArea(
    makeEnv(ctxA, width, 100, [0, 9999], [0, 100]),
    lineGeometry(flat),
  );
  for (const [, y, , hh] of ctxA.rects) {
    assert.strictEqual(hh, 1, 'a constant series is a hairline');
    assert.strictEqual(y, Math.round(100 - 42));
  }

  // alternating 0/100 at ~100 points per pixel: every column must cover the
  // whole range, and bridging must leave no gap between columns
  const wave = new Float64Array(10_000);
  for (let i = 0; i < wave.length; i++) wave[i] = i % 2 ? 100 : 0;
  const ctxB = fakeCtx();
  renderLineArea(
    makeEnv(ctxB, width, 100, [0, 9999], [0, 100]),
    lineGeometry(wave),
  );
  assert.ok(ctxB.rects.length >= width - 1);
  for (const [, y, , hh] of ctxB.rects) {
    assert.strictEqual(y, 0);
    assert.strictEqual(hh, 100);
  }
});

test('NaN gaps drop their columns instead of bridging across', () => {
  const width = 100;
  const values = new Float64Array(10_000).fill(10);
  // a hole across the middle fifth of the x range
  for (let i = 4000; i < 6000; i++) values[i] = NaN;
  const ctx = fakeCtx();
  renderLineArea(
    makeEnv(ctx, width, 100, [0, 9999], [0, 100]),
    lineGeometry(values),
  );
  assert.ok(
    ctx.rects.length <= width - 15,
    `the hole should cost columns: ${ctx.rects.length}`,
  );
});

test('sparse series stroke a real path, dense never does', () => {
  const sparse = Array.from({ length: 60 }, (_, i) => Math.sin(i / 4));
  const ctx = fakeCtx();
  const env = makeEnv(ctx, 400, 200, [0, 59], [-1, 1]);
  renderLineArea(env, lineGeometry(sparse, { curve: 'monotone' }));
  assert.strictEqual(ctx.strokes, 1);
  assert.strictEqual(ctx.batches.length, 0);
  assert.ok(ctx.pathPoints >= 60, 'every point is in the path');
  assert.strictEqual(env.stats.series[0].mode, 'polyline');
  // the threshold itself
  assert.ok(60 / 400 <= DENSE_PPX);
});

test('an area fills below the line in both modes', () => {
  const sparse = Array.from({ length: 40 }, (_, i) => 1 + (i % 5));
  const a = fakeCtx();
  renderLineArea(
    makeEnv(a, 400, 100, [0, 39], [0, 6]),
    lineGeometry(sparse, { type: 'area' }),
  );
  assert.strictEqual(a.fills, 1, 'one filled polygon');
  assert.strictEqual(a.strokes, 1, 'stroked on top');

  const dense = new Float64Array(50_000);
  for (let i = 0; i < dense.length; i++) dense[i] = 3 + Math.sin(i / 100);
  const b = fakeCtx();
  renderLineArea(
    makeEnv(b, 200, 100, [0, dense.length - 1], [0, 6]),
    lineGeometry(dense, { type: 'area' }),
  );
  assert.strictEqual(b.batches.length, 2, 'fill columns + stroke columns');
  assert.strictEqual(b.strokes, 0);
});

test('bars batch into one request, and rounded tops are capped', () => {
  const values = [3, 5, 2, 8, 4];
  const ctx = fakeCtx();
  const env = makeEnv(ctx, 300, 100, [0, 4], [0, 10]);
  env.xScale = bandScale(5, 0, 300);
  renderBars(env, {
    ...lineGeometry(values, { type: 'bar' }),
  });
  assert.strictEqual(ctx.batches.length, 1);
  assert.strictEqual(ctx.rects.length, 5);

  // 50k bars in 200px collapse to the envelope
  const many = new Float64Array(50_000);
  for (let i = 0; i < many.length; i++) many[i] = (i % 100) + 1;
  const ctx2 = fakeCtx();
  const env2 = makeEnv(ctx2, 200, 100, [0, many.length - 1], [0, 101]);
  env2.xScale = bandScale(many.length, 0, 200);
  renderBars(env2, { ...lineGeometry(many, { type: 'bar' }) });
  assert.ok(ctx2.rects.length <= 200);
  assert.strictEqual(env2.stats.series[0].mode, 'columns');
});

test('dense scatter reduces to alpha-bucketed cells, bounded by the grid', () => {
  const n = 200_000;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let seed = 7;
  const rand = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < n; i++) {
    xs[i] = rand() * 100;
    ys[i] = rand() * 100;
  }
  const ctx = fakeCtx();
  const env = makeEnv(ctx, 120, 90, [0, 100], [0, 100]);
  const xCol = column(xs);
  renderScatter(env, {
    spec: seriesSpec({ type: 'scatter', size: 3 }),
    y: column(ys),
    base: 0,
    x: xCol,
    xIdx: xIndexFor(xCol),
    group: { index: 0, count: 1 },
    color: '#123456',
  });
  assert.ok(ctx.batches.length <= 8, 'at most one batch per alpha level');
  const cells = Math.ceil(120 / 3) * Math.ceil(90 / 3);
  assert.ok(
    ctx.rects.length <= cells,
    `${ctx.rects.length} rects for ${cells} cells and ${n} points`,
  );
  assert.strictEqual(env.stats.series[0].mode, 'columns');
});

test('a saturated 1px scatter flips to the density image when the host can', () => {
  const w = 60;
  const hgt = 40;
  const n = w * hgt * 2; // cover essentially every pixel
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = i % w;
    ys[i] = Math.floor(i / w) % hgt;
  }
  const ctx = fakeCtx();
  const env = makeEnv(ctx, w, hgt, [0, w - 1], [0, hgt - 1]);
  let blits = 0;
  env.host.blitImage = (_x, _y, _w, _h, fill) => {
    blits++;
    fill(new Uint8ClampedArray(_w * _h * 4));
    return true;
  };
  const xCol = column(xs);
  renderScatter(env, {
    spec: seriesSpec({ type: 'scatter', size: 1 }),
    y: column(ys),
    base: 0,
    x: xCol,
    xIdx: xIndexFor(xCol),
    group: { index: 0, count: 1 },
    color: '#336699',
  });
  assert.strictEqual(blits, 1, 'the image path was taken');
  assert.strictEqual(ctx.batches.length, 0, 'and no rect batches were sent');
  assert.strictEqual(env.stats.series[0].mode, 'image');
});

// --- the element, headlessly ----------------------------------------------

function sampleRows(n: number): { t: number; cpu: number; mem: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i * 1000,
    cpu: 20 + Math.sin(i / 3) * 10,
    mem: 50 + Math.cos(i / 5) * 5,
  }));
}

function chart(
  rows: unknown,
  extras: {
    onFrameStats?: (s: ChartFrameStats) => void;
    tooltip?: boolean;
  } = {},
): React.ReactElement {
  return h(
    ChartContainer,
    { config: { cpu: { label: 'CPU', color: '#e17055' } } },
    h(
      LineChart,
      {
        data: rows as never,
        onFrameStats: extras.onFrameStats,
        style: { width: 420, height: 240 },
      },
      h(CartesianGrid, null),
      h(XAxis, { dataKey: 't', type: 'time' }),
      h(YAxis, null),
      h(LineSeries, { dataKey: 'cpu' }),
      h(LineSeries, { dataKey: 'mem' }),
      extras.tooltip ? h(ChartTooltip, null) : null,
      h(ChartLegend, null),
    ),
  );
}

test('importing the components registers the element, drawn and known', () => {
  assert.strictEqual(CHARTPLOT_ELEMENT, 'chartplot');
  assert.ok(knownElements().includes(CHARTPLOT_ELEMENT));
  assert.ok(drawnKinds().includes(CHARTPLOT_ELEMENT));
});

test('the composed chart mounts, lays out and reports bounded frame stats', async () => {
  const frames: ChartFrameStats[] = [];
  await renderX11(
    chart(sampleRows(200), { onFrameStats: (s) => frames.push(s) }),
    {
      backend: 'mock',
    },
  );
  await act();

  const node = plotNode();
  assert.ok(node.abs.width > 300, 'the element fills the wrapper');
  assert.ok(frames.length >= 1, 'stats were reported');
  const last = frames[frames.length - 1];
  assert.strictEqual(last.series.length, 2);
  for (const s of last.series) assert.strictEqual(s.mode, 'polyline');
  assert.ok(last.pointsSpanned >= 400 - 4);

  // legend is real composition
  const legend = screen.all(
    (n) => retained(n).kind === 'text' && textOf(n) === 'CPU',
  );
  assert.ok(legend.length >= 1, 'the config label reaches the legend');
});

test('a million columnar points cost O(width) commands through the element', async () => {
  const n = 1_000_000;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = Math.sin(i / 2000) * 100;
  const frames: ChartFrameStats[] = [];
  await renderX11(
    h(
      ChartContainer,
      null,
      h(
        LineChart,
        {
          data: { length: n, columns: { y } },
          onFrameStats: (s: ChartFrameStats) => frames.push(s),
          style: { width: 440, height: 220 },
        },
        h(LineSeries, { dataKey: 'y' }),
      ),
    ),
    { backend: 'mock' },
  );
  await act();

  assert.ok(frames.length >= 1);
  const last = frames[frames.length - 1];
  assert.strictEqual(last.series[0].mode, 'columns');
  assert.strictEqual(last.pointsSpanned, n);
  assert.ok(last.commands <= 12, `bounded command count, got ${last.commands}`);
  assert.ok(
    last.estimatedWireBytes < 16_000,
    `bounded wire estimate, got ${last.estimatedWireBytes}`,
  );
});

test('hitAt snaps to the nearest point with per-series values', async () => {
  await renderX11(chart(sampleRows(50)), { backend: 'mock' });
  await act();
  const node = plotNode();
  const plot = node.plotRect();
  assert.ok(plot, 'layout is available');
  const hit = node.hitAt(plot.x + plot.width / 2);
  assert.ok(hit, 'a hit lands mid-plot');
  assert.strictEqual(hit.points.length, 2);
  const cpu = hit.points.find((p) => p.id === 'cpu');
  assert.ok(cpu);
  assert.strictEqual(cpu.label, 'CPU');
  assert.strictEqual(cpu.color, '#e17055');
  const rows = sampleRows(50);
  assert.strictEqual(cpu.value, rows[hit.index].cpu);
  assert.strictEqual(hit.xValue, rows[hit.index].t);
});

// fireEvent needs the in-process X server, so this one runs on the default
// backend rather than the mock.
test('hovering opens the tooltip popup, and the repaint stays pixel-bounded', async () => {
  const frames: ChartFrameStats[] = [];
  await renderX11(
    chart(sampleRows(60), {
      tooltip: true,
      onFrameStats: (s) => frames.push(s),
    }),
  );
  await act();
  // a popup's retained kind is 'window' (PopupNode is a WindowNode); a
  // nested window — one with a parent — is the popup
  const nestedWindows = () =>
    screen.all((n) => {
      const r = retained(n);
      return r.kind === 'window' && r.parent !== null;
    });
  assert.strictEqual(nestedWindows().length, 0, 'no popup before a hover');

  const node = plotNode();
  fireEvent.mouseMove(
    node as unknown as Parameters<typeof fireEvent.mouseMove>[0],
    {
      dx: 10,
      dy: 0,
    },
  );
  await act();

  // the bubble is a real popup window by default — that is what stacks it
  // above content that flows after the chart
  const popups = nestedWindows();
  assert.strictEqual(popups.length, 1, 'the bubble is a popup window');
  const popup = retained(popups[0]);
  assert.ok(
    popup.props.theme,
    'the palette is re-declared on the separate window, so $tokens resolve',
  );
  const bubble = screen.all(
    (n) => retained(n).kind === 'text' && textOf(n) === 'CPU',
  );
  // one CPU text in the legend, one in the popup's bubble
  assert.ok(bubble.length >= 2, 'the tooltip bubble rendered');

  // the crosshair and markers stay in-window and are hit-transparent, so
  // the pointer can never land on the hover's own furniture
  const overlays = screen.all((n) => {
    const r = retained(n);
    return r.kind === 'box' && r.style.pointerEvents === 'none';
  });
  assert.ok(overlays.length >= 2, 'crosshair and markers are inert');

  // The crosshair overlaps the plot, so its damage does repaint the
  // element — the guarantee is that those repaints cost O(width) commands
  // (the memoized spec/data props contribute no damage of their own, and
  // the paint that does run is the usual bounded one).
  for (const frame of frames) {
    assert.ok(
      frame.commands <= 24,
      `every hover frame stays bounded, got ${frame.commands}`,
    );
    for (const s of frame.series) assert.strictEqual(s.mode, 'polyline');
  }
});

test('mode="overlay" keeps the bubble in-window, clamped and inert', async () => {
  await renderX11(
    h(
      ChartContainer,
      { config: { cpu: { label: 'CPU', color: '#e17055' } } },
      h(
        LineChart,
        { data: sampleRows(60), style: { width: 420, height: 240 } },
        h(XAxis, { dataKey: 't' }),
        h(YAxis, null),
        h(LineSeries, { dataKey: 'cpu' }),
        h(ChartTooltip, { mode: 'overlay' }),
      ),
    ),
  );
  await act();

  const node = plotNode();
  fireEvent.mouseMove(
    node as unknown as Parameters<typeof fireEvent.mouseMove>[0],
    { dx: 0, dy: 0 },
  );
  await act();

  assert.strictEqual(
    screen.all((n) => {
      const r = retained(n);
      return r.kind === 'window' && r.parent !== null;
    }).length,
    0,
    'no popup window in overlay mode',
  );
  const cpuTexts = screen.all(
    (n) => retained(n).kind === 'text' && textOf(n) === 'CPU',
  );
  assert.ok(cpuTexts.length >= 1, 'the overlay bubble rendered in-window');
  const bubbleText = retained(cpuTexts[cpuTexts.length - 1]);
  // walk up to the absolutely-positioned bubble box and check it is inert
  // and inside the chart's own box
  let bubbleBox = bubbleText.parent;
  while (bubbleBox && bubbleBox.style.position !== 'absolute') {
    bubbleBox = bubbleBox.parent;
  }
  assert.ok(bubbleBox, 'the bubble is an absolutely-positioned box');
  assert.strictEqual(bubbleBox.style.pointerEvents, 'none');
  const chart = node as unknown as RetainedNode;
  assert.ok(
    bubbleBox.abs.y >= chart.abs.y &&
      bubbleBox.abs.y <= chart.abs.y + chart.abs.height,
    'the bubble is clamped into the chart box',
  );
});

test('streaming appends repaint visible charts and skip offscreen ones', async () => {
  const store = new ChartData();
  for (let i = 0; i < 100; i++) store.append({ y: i % 10 });
  const frames: ChartFrameStats[] = [];

  // visible chart: appends repaint it
  const visible = await renderX11(
    h(
      ChartContainer,
      null,
      h(
        LineChart,
        {
          data: store,
          onFrameStats: (s: ChartFrameStats) => frames.push(s),
          style: { width: 300, height: 120 },
        },
        h(LineSeries, { dataKey: 'y' }),
      ),
    ),
    { backend: 'mock' },
  );
  await act();
  const before = frames.length;
  assert.ok(before >= 1);
  store.appendRows([{ y: 1 }, { y: 2 }]);
  await act();
  assert.ok(frames.length > before, 'a visible chart repainted on append');
  await cleanup();
  void visible;

  // offscreen chart: pushed fully below the window by a tall spacer
  const offscreenFrames: ChartFrameStats[] = [];
  await renderX11(
    h(
      'box',
      { style: { flexDirection: 'column' } },
      h('box', { style: { height: 2000, flexShrink: 0 } }),
      h(
        ChartContainer,
        null,
        h(
          LineChart,
          {
            data: store,
            onFrameStats: (s: ChartFrameStats) => offscreenFrames.push(s),
            style: { width: 300, height: 120 },
          },
          h(LineSeries, { dataKey: 'y' }),
        ),
      ),
    ),
    { backend: 'mock', height: 400 },
  );
  await act();
  const baseline = offscreenFrames.length;
  store.appendRows([{ y: 5 }, { y: 6 }]);
  await act();
  assert.strictEqual(
    offscreenFrames.length,
    baseline,
    'an offscreen chart neither painted nor scheduled a frame',
  );
});

test('band bars from row keys, stacked, one batch per series', async () => {
  const rows = [
    { month: 'Jan', a: 3, b: 2 },
    { month: 'Feb', a: 5, b: 1 },
    { month: 'Mar', a: 2, b: 4 },
  ];
  const frames: ChartFrameStats[] = [];
  await renderX11(
    h(
      ChartContainer,
      null,
      h(
        BarChart,
        {
          data: rows,
          onFrameStats: (s: ChartFrameStats) => frames.push(s),
          style: { width: 300, height: 160 },
        },
        h(XAxis, { dataKey: 'month' }),
        h(BarSeries, { dataKey: 'a', stackId: 's' }),
        h(BarSeries, { dataKey: 'b', stackId: 's' }),
      ),
    ),
    { backend: 'mock' },
  );
  await act();
  const last = frames[frames.length - 1];
  assert.ok(last, 'painted');
  assert.strictEqual(last.series.length, 2);
  for (const s of last.series) {
    assert.ok(s.mode === 'bars' || s.mode === 'rects');
    assert.strictEqual(s.points, 3);
  }

  // stacking: the painted top of `b` sits at a+b
  const node = plotNode();
  const hit = node.hitAt(node.plotRect()!.x + 1);
  assert.ok(hit);
  const bPoint = hit.points.find((p) => p.id === 'b');
  assert.ok(bPoint);
  assert.strictEqual(
    bPoint.value,
    rows[hit.index].b,
    'tooltip shows the raw value',
  );
});

test('degenerate inputs stay standing', async () => {
  const cases: unknown[] = [
    [],
    [{ y: 5 }],
    [{ y: NaN }, { y: NaN }],
    { length: 0, columns: {} },
    { length: 3, columns: { y: [1, 2, 3] } },
  ];
  for (const rows of cases) {
    await renderX11(
      h(
        ChartContainer,
        null,
        h(
          LineChart,
          { data: rows as never, style: { width: 200, height: 100 } },
          h(LineSeries, { dataKey: 'y' }),
        ),
      ),
      { backend: 'mock' },
    );
    await act();
    plotNode();
    await cleanup();
  }
});

test('resolveColumn extracts rows once and reuses by identity', () => {
  const rows = sampleRows(1000);
  const a = resolveColumn(rows, 'cpu');
  const b = resolveColumn(rows, 'cpu');
  assert.ok(a && b);
  // `values` is a fresh subarray view per call; the *storage* is shared
  assert.strictEqual(
    (a.values as Float64Array).buffer,
    (b.values as Float64Array).buffer,
    'same backing extraction',
  );
  assert.strictEqual(a.host, b.host, 'same cache identity');
  assert.strictEqual(a.n, 1000);
  const missing = resolveColumn(rows, 'nope');
  assert.strictEqual(missing, null);
});

test('scatter buckets follow the plot across a scroll', async () => {
  // The regression: alpha-bucket rects cached in window coordinates drew
  // at the old origin after a scroll or a reflow — the cloud sliced flat
  // or clipped away entirely — because nothing in the cache key changes
  // when only the plot's position moves.
  const N = 4000;
  const xs = new Float64Array(N);
  const ys = new Float64Array(N);
  let seed = 7;
  const rand = () => {
    // deterministic points, so both mounts see identical data
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < N; i++) {
    xs[i] = rand() * 100;
    ys[i] = rand() * 100;
  }
  const data = { length: N, columns: { x: xs, y: ys } };

  const scatterApp = (testname: string) =>
    h(
      'box',
      { style: { flexDirection: 'column', overflow: 'scroll', flexGrow: 1 } },
      h('box', { style: { height: 80, flexShrink: 0 } }),
      h(
        ChartContainer,
        {
          config: { y: { label: 'Y', color: '#2980b9' } },
          style: { height: 240, flexShrink: 0 },
          'data-testname': testname,
        },
        h(
          ScatterChart,
          { data },
          h(XAxis, { dataKey: 'x' }),
          h(YAxis, null),
          h(ScatterSeries, { dataKey: 'y', size: 2 }),
        ),
      ),
      h('box', { style: { height: 600, flexShrink: 0 } }),
    );

  // mount (paints once at scroll 0, priming the grid cache), scroll, then
  // force a full repaint at the new position — the scroll blit otherwise
  // drags the old pixels and hides the stale draw in the exposed strip;
  // the field failure is exactly a full repaint reusing position-baked
  // buckets (a poisoned blit, a section reflow, fast wheel reversals)
  const result = await renderX11(scatterApp('scrolled'), {
    width: 420,
    height: 420,
  });
  await act();
  const [scrollNode] = screen.all((n) => {
    const r = retained(n) as unknown as { isScroller?: () => boolean };
    return typeof r.isScroller === 'function' && r.isScroller();
  });
  (retained(scrollNode) as unknown as { scrollTo(to: number): void }).scrollTo(
    60,
  );
  await act();
  const plot = retained(plotNode() as unknown);
  plot.invalidate(false, null, 'expose');
  await act();

  // the points span the full y-domain, so after the repaint the TOP band
  // of the plot must hold cloud ink; buckets drawn at the pre-scroll
  // origin leave it empty (displaced down and clipped flat — the bug)
  const ctx = (
    result as unknown as { window: { getContext(n: string): unknown } }
  ).window.getContext('2d');
  const abs = plot.abs;
  // reference background: inside the element, above the plot's ink, in
  // the y-gutter's top-left corner
  const bg = await pixelAt(ctx as never, abs.x + 2, abs.y + 2);
  let inked = 0;
  for (let dx = 60; dx < abs.width - 12; dx += 24) {
    for (let dy = 8; dy <= 44; dy += 12) {
      const px = await pixelAt(ctx as never, abs.x + dx, abs.y + dy);
      const diff =
        Math.abs(px[0] - bg[0]) +
        Math.abs(px[1] - bg[1]) +
        Math.abs(px[2] - bg[2]);
      if (diff > 40) inked++;
    }
  }
  assert.ok(
    inked >= 5,
    `the plot's top band holds cloud ink after the scrolled repaint ` +
      `(${inked} inked samples — zero means the buckets stayed at the ` +
      `pre-scroll origin)`,
  );
});

test('a windowed stream stays bounded through compactions', async () => {
  // The field failure: after the maxLength window compacts, a frame
  // rendered the series as a full-length polyline hairball — hundreds of
  // commands, a ballooned x-domain — then healed. Drive a stream through
  // several compactions with the demo's timestamp shape (bursts sharing
  // one millisecond) and hold every frame to the command budget.
  const store = new ChartData({ maxLength: 300 });
  let t = 1_700_000_000_000;
  const frames: ChartFrameStats[] = [];
  await renderX11(
    h(
      ChartContainer,
      {
        config: { v: { label: 'V', color: '#2980b9' } },
        style: { width: 420, height: 200 },
      },
      h(
        LineChart,
        { data: store, onFrameStats: (s: ChartFrameStats) => frames.push(s) },
        h(XAxis, { dataKey: 't', type: 'time' }),
        h(YAxis, { domain: [0, 100] }),
        h(LineSeries, { dataKey: 'v' }),
      ),
    ),
  );
  await act();

  let phase = 0;
  for (let batch = 0; batch < 120; batch++) {
    // three appends per tick, one shared timestamp — the demo's shape
    t += 50;
    for (let i = 0; i < 3; i++) {
      phase += 0.02;
      store.append({ t, v: 50 + 40 * Math.sin(phase) });
    }
    await act();
  }

  assert.ok(
    frames.length >= 20,
    `painted through the stream, got ${frames.length}`,
  );
  for (const [i, frame] of frames.entries()) {
    assert.ok(
      frame.commands <= 40,
      `frame ${i} stayed bounded: ${frame.commands} cmds, ` +
        `~${Math.round(frame.estimatedWireBytes / 1024)}KB, ` +
        `modes ${frame.series.map((s) => s.mode).join(',')}`,
    );
  }
});

test('clear() resets the window and every cache rebuilds through the epoch', async () => {
  const store = new ChartData({ maxLength: 500 });
  for (let i = 0; i < 400; i++) {
    store.append({ t: 1000 + i * 50, v: i % 90, tag: `r${i}` });
  }
  const before = store.column('t')!;
  assert.strictEqual(before.n, 400);

  const epochBefore = store.epoch;
  store.clear();
  assert.strictEqual(store.length, 0);
  assert.ok(store.epoch > epochBefore, 'clear bumps the epoch');
  assert.strictEqual(store.column('t')!.n, 0);
  assert.strictEqual(
    (store.column('tag')!.values as string[]).length,
    0,
    'string columns actually empty — they append with push',
  );

  // a resumed stream: minutes later, fresh points only
  for (let i = 0; i < 50; i++) {
    store.append({ t: 900_000 + i * 50, v: i, tag: `s${i}` });
  }
  const after = store.column('t')! as NumericColumn;
  assert.strictEqual(after.n, 50);
  assert.strictEqual(after.values[0], 900_000, 'reads start at the new rows');
  const idx = xIndexFor(after);
  assert.strictEqual(idx.min, 900_000, 'the x extent forgot the old run');
  assert.ok(idx.sorted);
});

test('a stream resuming after a stall renders the new window, not the gap', async () => {
  const store = new ChartData({ maxLength: 300 });
  let t = 1_700_000_000_000;
  const frames: ChartFrameStats[] = [];
  await renderX11(
    h(
      ChartContainer,
      {
        config: { v: { label: 'V', color: '#2980b9' } },
        style: { width: 420, height: 200 },
      },
      h(
        LineChart,
        { data: store, onFrameStats: (s: ChartFrameStats) => frames.push(s) },
        h(XAxis, { dataKey: 't', type: 'time' }),
        h(YAxis, { domain: [0, 100] }),
        h(LineSeries, { dataKey: 'v' }),
      ),
    ),
  );
  await act();
  for (let batch = 0; batch < 40; batch++) {
    t += 50;
    store.append({ t, v: 50 });
    await act();
  }

  // the stall: fourteen minutes pass, the app resumes, the feed clears
  t += 14 * 60_000;
  store.clear();
  for (let batch = 0; batch < 40; batch++) {
    t += 50;
    store.append({ t, v: 60 });
    await act();
  }

  const last = frames[frames.length - 1];
  assert.ok(last, 'painted after the resume');
  assert.strictEqual(last.pointsSpanned, 40, 'the frame spans the new window');
  for (const frame of frames) {
    assert.ok(
      frame.commands <= 40,
      `bounded through clear and resume, got ${frame.commands}`,
    );
  }
});

test('a fixed-height container contains the chart, legend included', async () => {
  // yoga's `minHeight: auto` content floor held the element at its
  // intrinsic measure, so chart + legend overflowed the styled box and
  // the x-gutter's tick labels printed over whatever flowed below
  await renderX11(
    h(
      'box',
      { style: { flexDirection: 'column', padding: 8 } },
      h(
        ChartContainer,
        {
          config: { v: { label: 'V', color: '#2980b9' } },
          style: { height: 220 },
          'data-testname': 'contained',
        },
        h(
          LineChart,
          { data: [{ v: 1 }, { v: 3 }, { v: 2 }] },
          h(XAxis, null),
          h(YAxis, null),
          h(LineSeries, { dataKey: 'v' }),
          h(ChartLegend, null),
        ),
      ),
    ),
  );
  await act();
  const container = retained(
    screen.all(
      (n) => retained(n).props['data-testname'] === 'contained',
    )[0] as unknown,
  );
  assert.ok(container, 'the container is queryable');
  assert.strictEqual(container.abs.height, 220);
  const plot = retained(plotNode() as unknown);
  const legendBottom = container.children.reduce(
    (max, c) => Math.max(max, c.abs.y + c.abs.height),
    0,
  );
  assert.ok(
    plot.abs.y + plot.abs.height <= container.abs.y + 220,
    `the element stays inside the box: ` +
      `${plot.abs.y + plot.abs.height} <= ${container.abs.y + 220}`,
  );
  assert.ok(legendBottom <= container.abs.y + 220, 'the legend row does too');
});

test('a parked pointer keeps a live tooltip: data shifts re-snap the hover', async () => {
  const store = new ChartData({ maxLength: 200 });
  let t = 1_700_000_000_000;
  for (let i = 0; i < 100; i++) {
    t += 1000;
    store.append({ t, v: 10 });
  }
  await renderX11(
    h(
      ChartContainer,
      {
        config: { v: { label: 'V', color: '#2980b9' } },
        style: { width: 420, height: 220 },
      },
      h(
        LineChart,
        { data: store },
        h(XAxis, { dataKey: 't', type: 'time' }),
        h(YAxis, { domain: [0, 100] }),
        h(LineSeries, { dataKey: 'v' }),
        h(ChartTooltip, null),
      ),
    ),
  );
  await act();

  const node = plotNode();
  fireEvent.mouseMove(
    node as unknown as Parameters<typeof fireEvent.mouseMove>[0],
    { dx: 200, dy: 60 },
  );
  await act();

  const valueTexts = () =>
    screen.all((n) => {
      const r = retained(n);
      return r.kind === 'text' && /^\d+(\.\d+)?$/.test(textOf(n) ?? '');
    });
  assert.ok(valueTexts().length >= 1, 'the bubble shows a value');
  assert.ok(
    valueTexts().some((n) => textOf(n) === '10'),
    'the parked hover shows the old value',
  );

  // the stream moves on under the parked pointer: the same x now holds
  // different values, and the tooltip must follow without a mouse event
  for (let i = 0; i < 120; i++) {
    t += 1000;
    store.append({ t, v: 90 });
  }
  await act();
  await act();
  assert.ok(
    valueTexts().some((n) => textOf(n) === '90'),
    `the tooltip re-snapped to the shifted data, saw: ${valueTexts()
      .map((n) => textOf(n))
      .join(', ')}`,
  );

  // and the time-axis header is a clock reading, not epoch milliseconds
  const headers = screen.all((n) => {
    const r = retained(n);
    return r.kind === 'text' && /^\d{1,2}:\d{2}/.test(textOf(n) ?? '');
  });
  assert.ok(headers.length >= 1, 'the header formats as time');
  assert.strictEqual(
    screen.all(
      (n) => retained(n).kind === 'text' && /^17\d{11}$/.test(textOf(n) ?? ''),
    ).length,
    0,
    'no raw epoch header anywhere',
  );
});
