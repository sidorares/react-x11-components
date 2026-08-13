# PRD: `src/charts/` — composable, cost-bounded charts

Status: implemented. This document records the design and the reasons, the
way `prd-vt-terminal.md` does for the terminal.

## What it is

A shadcn/charts-shaped component set for cartesian charts — line, area, bar,
scatter — built as composition over **one registered element** that paints
the plot, the axes and the grid in a single pass, plus ordinary box/text
composition for the legend and the tooltip.

```tsx
const config = {
  cpu: { label: 'CPU', color: '$accent' },
  mem: { label: 'Memory', color: '#e17055' },
} satisfies ChartConfig;

<ChartContainer config={config} style={{ height: 240 }}>
  <LineChart data={rows}>
    <CartesianGrid />
    <XAxis dataKey="time" type="time" />
    <YAxis width={44} />
    <LineSeries dataKey="cpu" />
    <LineSeries dataKey="mem" />
    <ChartTooltip />
    <ChartLegend />
  </LineChart>
</ChartContainer>;
```

The API mirrors shadcn where it can: `ChartConfig` keyed by series, a
container that carries it, chart-type wrappers, per-series children with
`dataKey`, axis/grid/tooltip/legend as children. It diverges where the DOM
assumption would leak: series are `LineSeries`/`BarSeries`/… rather than
recharts' `Line`/`Bar`, content customisation is render props rather than
`*Content` child components, and there is no CSS-variable indirection —
`color` takes a CSS colour or a `$token` resolved against the theme.

## The performance contract

The three requirements this design is built around, and where each is
enforced:

1. **Off-viewport costs nothing.** Core already culls paint: a node outside
   the damage region or scrolled out of a clipping ancestor never gets its
   `paint()` called (`_outsideDamage`, `_offscreen` in react-x11). What is
   left to this package is to not do work _outside_ paint: data preparation
   is lazy (first paint that needs it) and cached; a streaming update to a
   chart that is fully outside its window's viewport skips `invalidate()`
   entirely — scrolling back in repaints anyway, and paint always reads
   current data.

2. **Too small to see costs nothing to draw.** Rendering cost is a function
   of _pixels_, never of points. Every series renderer works from a
   per-pixel-column reduction (below), so a million points in a 40px-wide
   cell cost ~80 block reads and ~40 rectangles. Sub-2px plots skip paint.

3. **Server-side drawing commands by default, pixels when they win.** The
   decimation bounds the command stream by the pixel width, which keeps the
   "drawing commands" path smaller than a pixel push in almost every case:

   | mark             | commands per frame                    | wire cost     |
   | ---------------- | ------------------------------------- | ------------- |
   | dense line/area  | 1–2 `fillRects` batches (ntk#253)     | ~8B × width   |
   | sparse line/area | one stroked/filled path, ≤2×width pts | ~48B × points |
   | bars             | 1 `fillRects` batch per colour        | ~8B × bars    |
   | scatter          | ≤8 `fillRects` batches (alpha levels) | ~8B × cells   |

   The one place a pixel push wins is a scatter so dense it covers more than
   half the plot: rect-stream bytes (8/cell) then exceed image bytes
   (4/pixel), so the renderer flips to building the density image
   client-side and issuing one `putImageData`. The crossover is computed,
   not guessed: `occupiedCells > plotW × plotH / 2`.

   The sparse stroke collapses points sharing a pixel column into a
   single ordered vertical min→max pair before the path is built —
   pixel-identical, a third of the points for a burst-heavy stream, and
   the same envelope the dense branch draws, so the two modes agree at
   the boundary. It began life as a correctness workaround: ntk's stroke
   extruder emitted NaN join geometry on same-x sub-pixel hairpins
   ([ntk#259](https://github.com/sidorares/ntk/issues/259), invisible
   headless and origin-wedges on a real display — why only real-display
   runs ever showed it), fixed in ntk 7.6.1
   ([ntk#260](https://github.com/sidorares/ntk/pull/260)). The collapse
   is kept as the optimisation it also always was, and as a guard for
   any older extruder in an app's tree.

## The data structures

**Columns, not rows.** Rows (`data={[{month, desktop}]}`) are accepted for
shadcn familiarity and normalised to columns once per array identity
(WeakMap-cached). Columnar input (`{ length, columns }`) and `ChartData` are
the fast path — a million points never materialise row objects.

**`ChartData`** is the streaming store: append-only columns in growable
typed arrays, a version counter, and subscriber notification. Appends extend
the pyramids incrementally (O(appended/16 + levels)); nothing rescans.
`clear()` empties the window through the same epoch bump a window shift
uses — the reset for switching feeds. Windowing is by count (`maxLength`)
**and by time** (`maxAge: { key, ms }`, binary-searched over the sorted age
key, trimmed with the same slack): the time window is what a live feed
actually means, and the failure that taught us is an OS _throttling_ a
hidden window's timers — fired slowly rather than stopped, so no tick-gap
heuristic notices — leaving a minutes-wide, points-thin era that renders
as fresh data squeezed into a sliver until a count window evicts it. Age
eviction skips the slack when the stale run dwarfs the window, so a hard
stall's backlog drops on the first append after resume. Two rules the caches under it live by,
both learned from field bugs: **nothing cached across frames may bake in
window coordinates** (the scatter's alpha buckets are plot-local, translated
at draw — a scroll or reflow moves the plot while every cache key stays
equal), and **every cross-frame cache keys on `{epoch, n}`** so history
shifts invalidate everything at once.

**The min/max pyramid** is the decimation index, built per numeric column,
lazily, on the first paint whose density needs it:

- Level 0 is the raw column. Level k holds min/max over blocks of
  `16 · 2^(k-1)` points; the base block of 16 keeps total pyramid memory at
  ~1/4 the column (two values per block, halving per level).
- A paint at density d points/px picks the deepest level whose block is
  ≤ d/2 and reads ~2–4 blocks per pixel column, plus ≤32 raw edge points.
  Per frame that is O(width), independent of n.
- First/last per block are free: blocks are contiguous index ranges, so
  they are raw-array lookups — no M4 storage, same M4 rendering (the
  column's span is bridged to the previous column's closing value, so a
  dense line never shows gaps).
- The top block answers "what is the y extent" in O(1), which is what makes
  auto-domains free as data streams in.

**x is assumed sorted for line/area** (the norm for series data). The prep
pass detects, once per column identity: sortedness, and uniform spacing. A
uniform x maps pixel column → index range arithmetically; a sorted
non-uniform x binary-searches the boundary per column (O(width·log n) — 16k
ops at 800px over 1M points); unsorted x falls back to index-order
subsampling for lines and is scatter's normal case.

**Scatter** reduces to an occupancy grid (count per plot-space cell), built
per (data version, plot size, domain) and reused across frames; appends
update it incrementally. Counts bucket into 8 alpha levels → one `fillRects`
per level, or the density image when past the crossover.

**Stacks** (`stackId`) precompute cumulative tops per layer at prep time,
so a stacked layer decimates its own top and fills to the layer below with
the same per-column machinery.

## The element / composition split

One registered element, `<chartplot>` (`CHARTPLOT_ELEMENT`), paints the
whole cartesian frame: grid, both axes (ticks, labels via `fonts.layout`,
glyph-cached server-side), and every series, in that order, in one pass
under one clip. Doing axes inside the element rather than as React `<text>`
avoids the measure→render loop entirely: the y-gutter width comes from
measuring the tick labels of the _current_ domain during paint, and layout
never has to converge.

Everything interactive or content-shaped is React composition above it:

- `ChartContainer` provides the config context and the sizing box.
- The chart wrapper (`LineChart` et al.) introspects its children —
  `React.Children` over `LineSeries`/`XAxis`/`CartesianGrid`/… — into one
  memoized `spec` prop for the element. The child components render null;
  they are config carriers, exactly recharts' model.
- `ChartTooltip`/`ChartLegend` opt into the wrapper's hover state and
  legend row. The crosshair and the hover markers are absolutely-positioned,
  **hit-transparent** boxes the wrapper moves (`pointerEvents: 'none'`, so
  the pointer can never land on the hover's own furniture). A hover is a
  **live query, not a snapshot**: while hovered, a `ChartData` notification
  (or a change of `data` identity) re-snaps the hit from the parked pointer
  position, so a streaming chart sliding under a stationary mouse keeps the
  crosshair, markers and values on what is actually drawn. A time axis
  formats the bubble header with the same `formatTimeTick` its ticks use —
  never raw epoch milliseconds. The value bubble's home is a policy,
  `ChartTooltip mode`:

  - `'popup'` (the default): a real override-redirect `<popup>` anchored to
    the data point (`anchor.at`), so it stacks above content that flows
    after the chart — an in-window box paints in tree order and loses to
    any later sibling it leans over — may extend past the window edge, and
    never takes focus. The theme is re-declared on the popup (the
    DatePicker precedent) so tokens resolve across the window boundary,
    and the bubble hangs on the side of the crosshair _away_ from the
    pointer, with hysteresis, so the pointer cannot wander onto the
    tooltip window and flicker the hover.
  - `'overlay'`: the bubble stays an in-window, hit-transparent box clamped
    into the chart — one window, one paint surface, right for screenshots
    and embedding, with the overdraw trade above accepted.

  **The bubble hides while a button is down and re-mounts on release** —
  the Qt/GTK tooltip convention, and what keeps a press-gesture (pan,
  click-to-flip) from fighting the window manager over stacking: a
  click-to-raise WM raises the owner window above the override-redirect
  popup, and no WM restacks unmanaged windows (there is no EWMH standing
  keep-above-owner constraint for them). A freshly created window starts
  above its siblings, so release restores the bubble on top. The
  crosshair and markers are in-window and track through the drag. The
  residue this cannot cover — popup already up, pointer parked, owner
  raised from the Dock — is filed as core work:
  [react-x11#299](https://github.com/sidorares/react-x11/issues/299)
  (VisibilityNotify-driven raise, blocked on
  [ntk#261](https://github.com/sidorares/ntk/issues/261)), with
  [react-x11#298](https://github.com/sidorares/react-x11/issues/298) for
  the `_NET_WM_WINDOW_TYPE` semantics popups should carry regardless.

  The memoized `spec`/`data` props hold their identity and handler props
  are excluded from core's damage test, so the React re-render contributes
  **no damage of its own**; what a mousemove costs is the overlays' damage
  strips, which overlap the plot and repaint it at its usual pixel-bounded
  price — O(width) commands per hover frame whatever the point count, with
  the density-image path recompositing its retained surface rather than
  re-uploading it.

- Hit lookup (pointer x → index → per-series values and pixel positions) is
  answered by the element through a ref (`getPublicInstance` hands back the
  node), so scales live in exactly one place.

Props changes flow through the normal commit: new `data`/`spec` identity
damages the element (bounded to its rect); `ChartData` appends invalidate
with `'content'` unless fully off-viewport.

## What is deliberately not here

- **Pie/radar/radial.** Cartesian is where the perf work is; a pie is a
  follow-up (`ctx.arc` fills, no decimation to speak of).
- **A second y axis.** One `YAxis` per chart for now.
- **Enter animations.** Would fight the damage story; revisit with a real
  need.
- **RTL mirroring.** Axes and series stay LTR — numeric charts read that
  way in RTL locales too; only the composed parts (legend) follow the app.
- **Selection.** Chart text is painted, not `<text>`; nothing here answers
  the text accessors. Tooltips/legends are chrome.

## Instrumentation

`onFrameStats` on the chart wrapper reports, per painted frame: per-series
mode (`polyline` / `columns` / `rects` / `image`), points spanned, commands
and estimated wire bytes, prep and paint milliseconds, and whether the
frame was culled. The demo's HUD renders it live; the tests assert on it
(commands bounded by width, zero frames while scrolled away, prep runs
once). The mock backend records draw ops, so the bounds are asserted
headlessly in CI.
