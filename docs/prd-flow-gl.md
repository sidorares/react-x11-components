# Flow on the GPU

`<Flow>`'s pane draws a graph with the 2D context: a rounded box per node, a
stroked polyline per edge, a disc per handle, a dot grid behind them, and a
shaped run per label. At twenty nodes that is a frame nobody notices. At two
hundred it is 12.5 ms, at eight hundred it is 100 ms, and every one of the
gestures a graph editor exists for — dragging a node, pulling an edge,
panning, zooming, typing into a node's body — repaints more than nine tenths
of the pane.

The maps renderer already answered the same question for a different picture
(`docs/prd-maps-gl.md`). This is what carrying that answer to `<Flow>` costs
and buys, measured rather than assumed, and the two places where a graph is
_not_ a map.

Every number here is this laptop: an M-series MacBook Pro, built-in 120 Hz
panel, Cocoa backend, a 1200×800 pane at scale 2 — 2400×1600 device pixels.
`scripts/bench/flow.ts` is what produced them and "Reproduce" says how.

## The answer

A whole frame of graph geometry — grid, edges, cards, handles — costs
**0.59 ms** at 200 nodes and **1.41 ms** at 2000, against an 8.33 ms budget at
120 Hz. The retained renderer costs **12.5 ms** for the same 200 nodes and
**100 ms** for 800.

| nodes / edges | scene | retained @fit | retained @0.44 | retained @1.0 | GL pan   | GL edit |
| ------------- | ----- | ------------- | -------------- | ------------- | -------- | ------- |
| 20 / 40       | 0.11  | 1.76          | 1.46           | 1.57          | **0.58** | 0.58    |
| 200 / 400     | 0.82  | 2.68          | 4.43           | 8.78          | **0.59** | 0.82    |
| 800 / 1600    | 2.97  | 78.9          | 16.1           | 9.84          | **1.14** | 2.28    |
| 2000 / 4000   | 8.97  | —             | —              | —             | **1.41** | 2.56    |

p50 milliseconds a frame. The retained columns are three zooms because the
pane's own thresholds change what it draws: below 0.45 there are no labels and
below 0.5 no handles, so `@0.44` is the geometry alone. The GL columns are a
**prototype**, not a shipped renderer: four programs, four draw calls, and no
text. Text is the whole of the risk and has its own section.

The `scene` column is the fitted view's, and it is the one to read twice. It
is `buildScene` alone — routing every edge, culling, resolving colours — with
no window, no surface and no drawing at all. **It is the half a GPU renderer
still pays on this thread**, so it bounds what moving the drawing can buy: at
2000 nodes it is 8.97 ms, which is the whole 120 Hz budget before a single
triangle is issued. Geometry on the GPU does not fix that; caching does, and
"Cache what does not change" below says which cache.

The shape of the win matters more than its size. A hundredfold more nodes
costs GL 2.4× — because a pan is a uniform write and four
`drawArraysInstanced` calls, and nothing in the frame is proportional to the
camera having moved.

### The ceiling was the real bug, and it is fixed

Before any of this was worth designing, a `<glarea>` that did nothing but
`glClear` delivered **68 fps at a 16.4 ms gap** on a 120 Hz panel: two gates
of one display period sat in series and the second rounded the first up
(react-x11#631). A GL `<Flow>` would have been ten times faster at drawing and
_slower_ at arriving than the 2D pane, which manages ~90 paints a second.

react-x11#632 phase-locks the swap gate to the window's frame clock. On
2.17.1:

```
retained  85.2 paints/s from 50 asks/s
<glarea>  119.3 frames/s   gap p50 8.29   p95 9.53 ms
```

The panel's rate, and 0.59 ms of an 8.33 ms budget to spend inside it. This
package now floors on `^2.17.1` for that reason.

## Standard optimisations first

Before a budget, before priority groups, before any adaptive anything: the
ordinary things. Three apply, and measuring them is what decided the design.

### Don't draw what is not in view — already done, and not where the cost is

The pane culls twice per edge (a coarse box off the two nodes, then the
routed path's bounds) and once per node, both against the pane and then
against the pass's damage rect. That works. What does not work is the _damage
rect_ itself, and the measurement is unambiguous:

| gesture, 200 nodes       | p50 ms | of the pane repainted |
| ------------------------ | ------ | --------------------- |
| node drag, 60 steps      | 36.4   | **93%**               |
| edge drag, 60 steps      | 36.2   | **94%**               |
| pan, 60 steps            | 12.9   | 40%                   |
| zoom, 40 steps           | 40.0   | 100%                  |
| node body re-render, 60× | 33.4   | **96%**               |

All five rows from one session, before any of the work below. They are
comparable with each other and with nothing measured on another day: the
same gesture on the same code moved 27 → 32 ms between two sessions here,
which is the machine and not the code — "Reproduce" has the rule that
follows from it.

Dragging one node out of two hundred repaints nine tenths of the pane, and
costs three times what panning the whole graph costs. The reason is structural
rather than a bug: a node's damage is the union of its own box with the bounds
of every edge touching it, and in any graph where edges are longer than a
screenful that union _is_ the screenful. Culling harder cannot fix it, because
nothing is being culled wrongly — the edges really do cross the pane.

The pan row is the one that works, and it works because of a different
mechanism: `_blitPan` scrolls the backing store and repaints the exposed
strip. That mechanism is unavailable to every other row — a zoom is not a
translation, and a drag moves content in the middle of the pane.

On GL this question dissolves rather than being answered. There is no damage
rect, no blit, no `_frameClip`, no per-pass culling of what the last frame
already drew: every frame draws the whole scene from buffers for 0.59 ms, and
the several hundred lines of subtle damage bookkeeping in `node.ts` stop being
load-bearing.

### Use shaders where they help — and the profile says exactly where

One node drag, broken down over 64 paints, before the scene was split out:

```
_paintEdges     64 calls   1781.0 ms    (68% of the gesture)
_paintNodes     64 calls    431.3 ms
_edgeGeometry 19312 calls    116.5 ms
_paintMiniMap   64 calls     54.0 ms
_paintGrid      64 calls     40.4 ms
_dragStep       60 calls      6.9 ms
```

Strokes are the frame. This is not a text problem: at zoom 0.44, with labels
and handles switched off entirely, 200 nodes still cost 4.43 ms with most of
it stroking. The thing to move to the GPU is the thing maps already moved.

The split the bench reports now says the same thing in two numbers rather
than six: at 200 nodes fitted, `buildScene` is 0.82 ms of a 2.68 ms frame, so
**the drawing is the other 1.86** — and the drawing is what four draw calls
replace.

### Cache what does not change — three caches, in order of value

`_edgeGeometry` is called **302 times per paint** during a drag in which
exactly one node moved. Every visible edge is re-routed, and re-routed in
_screen_ space, so a pan that changes no endpoint re-samples every bezier in
the graph. It is only 4% of the time today, hidden behind the stroking, but it
is the cost that does not go away by itself when the stroking does.

The three caches the GL renderer needs, and what each kills:

1. **Edge control points in graph space, not screen space.** Four control
   points per edge, rebuilt when an endpoint moves and never when the camera
   does. This is the structural one: it is what makes a pan a uniform write,
   and it is what brings the 8.97 ms scene build at 2000 nodes down — because
   a pan changes no endpoint, so a cached route survives it whole.
2. **Label rasters, keyed by text, weight and size _bucket_.** 80 ms cold,
   nothing warm. See below.
3. **Node instance data, keyed by node identity.** A drag rewrites one card's
   16 floats with `bufferSubData`, not two hundred.

## What a graph is not: the two places this differs from a map

### A node body is somebody else's React subtree

A node type with a `render` gets a real React subtree mounted over the pane.
Today those are siblings of the pane, positioned from `_emitBodies`. A
`<glarea>` is stacked over everything 2D in its window, so a sibling would be
_under_ the surface: node bodies must become children of the `<glarea>`, which
core supports and answers for through `useSupports('glOverlay')` — true on
both backends here. On Cocoa it is a transparent layer above the GL layer; on
X11 it is one opaque child window per region the children reach, which is
acceptable precisely because a node body is an opaque card.

This is also the row of the table with the most to gain, and the gain is not
speed but correctness of scope. Typing one character into a child textarea
today costs a 33.4 ms repaint of 96% of the graph. Under GL it should cost
**no graph frame at all**: the body is core's to composite, the scene did not
change, and nothing asks the renderer for a frame.

### Zoom changes the size of every label, continuously

A map's labels are set at a size and stay there. A graph's are multiplied by
the zoom on every frame, and a zoom range of 0.2–2.5 is 12.5× of continuous
resizing. Rasterizing on demand is not available:

```
shape 400 strings (cold)         26.5 ms total
shape 400 strings (warm)          0.4 ms total
raster + readback, 400 labels    53.0 ms in 6 batches
```

**~80 ms to set a 200-node graph's labels cold** — ten frames at 120 Hz — and
a zoom gesture would ask for that on every frame. So labels are rastered at
**size buckets** and scaled in the shader between them: at a ratio of √2, the
nearest bucket is never more than 19% off, and eight buckets cover the whole
zoom range. A bucket change re-rasters, which is the one unbounded cost in the
frame and the reason the next section exists.

Everything else about labels is maps' answer unchanged: `app.fonts.layout()`
shapes it, an offscreen `Surface` draws it, `getImageData` reads coverage
back, one atlas texture, one instanced draw, colour and halo in the shader.
Flow's labels are always axis-aligned, which makes the vertex shader simpler
than maps'.

## Then, and only then, the budget

The instinct to carry maps' adaptive-quality ladder over is worth resisting,
and the numbers say why. **Drawing does not need triage.** Two thousand nodes
is 1.41 ms of an 8.33 ms budget; there is no frame in which the renderer must
choose between the grid and the edges, and a priority scheme over things that
all fit is complexity bought for nothing.

What _is_ unbounded is turning strings into pixels, and node bodies. So Flow
wants a narrower mechanism than maps': an **admission budget on
rasterisation**, with the priority order falling out of what makes a gesture
make sense rather than out of a quality ladder.

- **Group 0 — the scene is the action.** Cards, edges, handles, grips, the
  selection box, the connection line being dragged. Always drawn, never
  budgeted, measured ceiling 1.41 ms at 2000 nodes. A drag whose edges lag the
  node is a broken drag; this group is what makes the answer to "where am I
  putting this" correct.
- **Group 1 — labels already in the atlas.** Drawn from whatever bucket
  exists, scaled if it is not exact. One instanced draw, free.
- **Group 2 — labels that need rastering.** Admitted against a per-frame
  budget on the order of maps' 1.5 ms, nearest-to-the-centre first, and
  **suspended entirely while a gesture is running**. This is maps' own lesson
  restated: label churn during a zoom was the cost, and labels are admitted at
  rest.

The degradation that buys is honest. During a fast zoom the graph is correct
and complete, with labels one bucket stale — slightly soft, never missing,
never late. One or two frames after the gesture stops they are crisp. Nothing
pops in or out, because group 1 always draws whatever raster exists.

## The four gestures, under this design

|                    | today                | under GL                                                                                                                      |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **node drag**      | 36.4 ms, 93% of pane | one card instance + the incident edges' control points rewritten with `bufferSubData`; everything else untouched. ≈ the draw. |
| **edge drag**      | 36.2 ms, 94% of pane | one instance in a scratch buffer. Free.                                                                                       |
| **pan / zoom**     | 12.9 / 40.0 ms       | a uniform write. **Zero** buffer traffic — the case where GL is most dramatically better.                                     |
| **body re-render** | 33.4 ms, 96% of pane | no graph frame at all: core composites the overlay child.                                                                     |

The hit testing does not move. `distanceToPath`, `_edgeCoarseBox` and the rest
are CPU work over graph-space geometry, they are not in the profile, and a
`<glarea>` being a child window means the gestures arrive at a pane element
behind it — the arrangement `src/maps/gl/pane.ts` already documents.

## What is still open

- **The overlay's cost is core's now.** With bodies over the surface, 26.5% of
  a GL pan over 49 widget bodies is core re-painting the overlay (on Cocoa, a
  `<glarea>`'s children share one transparent layer the size of the surface,
  and moving their box repaints all of it) and ~10–16% is layout. Panes that
  move with their content instead of repainting — or a layer per body — are
  the next order of magnitude, and they are core work.
- **`box-none` has to ship.** Bodies over the surface need
  sidorares/react-x11#637; on 2.17.1 the value reads as `'auto'` and a pane
  with bodies under GL would lose its bare-surface clicks. The floor moves
  with that release, and not before.
- **Rebuild frames are whole rebuilds.** A zoom step or a drag step rebuilds
  and repacks the world: 2.3 ms at 200 nodes, 15 ms at 2000 (offscreen,
  `glFinish`). Incremental packing — rewrite the dragged node's and its
  edges' instances in place — is what 2000 nodes at 120 Hz _while dragging_
  needs; 200 do not.
- **The `shaders` probe is asynchronous on Cocoa.** `useSupports('shaders')`
  answers `false` on the first render and `true` on the second, which is the
  `'pending'` state maps' `chooseRenderer` exists for. `renderer="auto"`
  needs the same three-way answer, or it draws two frames on the 2D renderer
  and throws them away.
- **`FlowPainter` for custom node types.** A type with its own `paint` is
  counted in `onFrame`'s `gaps.custom` and not drawn on GL. Most of that
  vocabulary (rect, circle, polyline, text) maps onto the instance streams;
  a type that reaches for `painter.raw` cannot be served and has to be able
  to find that out.
- **X11 is unmeasured.** Everything here was measured on the Cocoa backend.
  The GL surface, the overlay (opaque child windows per region there) and the
  wheel through a child window want a pass on an X server with direct GL.
- **The label atlas and maps' are the same idea twice.** `AGENTS.md` keeps
  components from importing each other; the shared part is a candidate for a
  module of its own.

## Order of work

1. ~~**Scene extraction.**~~ **Done.** `src/flow/scene.ts` builds a
   renderer-neutral {@link FlowScene} and `src/flow/paint.ts` issues one
   through a `FlowPainter`; `node.ts` lost 850 lines and now gathers inputs,
   builds, and paints. All 65 Flow tests pass unchanged, which is the claim
   that the pixels did not move.

   It was meant to be cost-neutral and was not — the frame got **materially
   faster**, because resolving each node once (`_source`) replaced repeated
   `rectOf`/`_handlesOf`/`_grips` calls per node per pass. Confirmed by an
   interleaved A/B (the old `node.ts` and the new one swapped in turn, two
   rounds, one session): 200 nodes fitted 5.1/5.4 → 2.7/2.6 ms, 200 at zoom
   1.0 11.6/12.1 → 8.4/8.2, 800 at zoom 1.0 22.1/21.8 → 10.7. An earlier
   draft of this said the four gestures fell 21–40%; that compared sessions,
   and is withdrawn. The geometry primitives are exported from `scene.ts`
   and the element's hit testing calls the same ones the drawing does, so
   the two can no longer drift.

2. ~~**The graph-space edge cache.**~~ **Done.** `SceneCache` keeps each
   edge's route, arrowheads and bounds between frames. It rests on one
   property of the routing: **every edge type is translation-equivariant and
   none is scale-equivariant** — a pan moves both endpoints by one vector and
   the route with them, while a zoom changes a bezier's shoulder, a step's
   offset and a loop's reach against pixel clamps. So routes are stored in
   screen space beside the origin they were built at, a pan is one addition
   per vertex into arrays that already exist, and a zoom rebuilds (hit rate
   100% on a pan, 2% on a zoom, measured).

   What it bought, honestly stated:
   - **The scene build, which is what a GPU renderer still pays:** 2000
     nodes fitted, built output, 7.04 → **3.76 ms** (1.9×); 200 nodes 0.65 →
     0.54.
   - **The 2D path: nothing measurable.** An interleaved A/B of the real
     gestures with the cache on and off is within noise on all four. That
     is the expected answer rather than a disappointing one — the scene is
     well under a millisecond of a 30 ms 2D drag, the drawing is the rest,
     and the cache was built for the renderer whose drawing is 0.6 ms.

   `test/flow-scene.test.ts` holds a cached route to a fresh one, vertex for
   vertex, after pans and across every edge type, and holds a whole cached
   frame to an uncached one. It found a bug on its first run that no gesture
   test could have: `trimEnd` returns a shallow copy, so the stroke and the
   route shared their vertex _objects_, and a pan moved each shared vertex
   twice — the stroke slid away from its own arrowhead by the distance
   panned. The test fails seven ways with that bug put back.

   One measurement trap found on the way, now in the bench: `tsx`
   transpiles with esbuild's `keepNames`, and its `__name` helper was a sixth
   of the scene profile — the same code built by `tsc` ran **2.2× faster**.
   `--build=dist` times what an application runs.

3. ~~**Geometry on the GPU.**~~ **Done**, behind an explicit
   `renderer="gl"`. The renderer reads the same `FlowScene` the 2D painter
   does; `gl/pack.ts` appends every shape to one of three instance streams in
   the painter's z-order, and a frame is ~10 ranged instanced draws. A disc
   is a rounded box whose corners meet, so cards, handles, chips and panels
   are one program. The graph is a **world** built at a pinned origin,
   culled to an overscan three panes wide and uploaded only when it changes;
   the pane's furniture is a small **overlay** packed every frame; a pan is
   the world's offset and a marching dash its phase — both uniforms.

   Panning the lattice on a real window (Cocoa, 120 Hz): 117.8 / 120.0 /
   118.8 fps at 200 / 800 / 2000 nodes, 0.36–0.70 ms of this thread a frame,
   no world rebuilt during the pan; the same under Bun. A node drag at 200
   nodes is 3.1 ms a frame (2D: 28).

   Three things found on the way, each with a test now: a closed arrowhead
   alternated a triangle and a hairline and cost 807 draws a frame where 10
   do; the surface swallowed every press until it was made transparent to the
   pointer; and the surface drew nothing at all — it divided by a `scale` core
   declares on `onDraw`'s info and did not pass (sidorares/react-x11#634,
   fixed in #635), which every counter it keeps could not see, because NaN
   vertices cost the GPU nothing. The surface now reads the node's scale and
   throws on a target that is not finite.

4. ~~**Labels.**~~ **Done.** An atlas: strings shaped by the app's own text
   engine in white, read back in batches of up to 48, packed into a 2048²
   texture, and drawn by the _box_ program sampling it — so each label sits
   in the box stream exactly where the painter draws it and a frame is still
   ~10 draws. A label is drawn from the raster of its exact size, or from the
   nearest size the atlas holds, scaled, while the zoom moves; exact sizes are
   set once it holds still. Offscreen against the 2D painter the text is
   indistinguishable. A 200-node lattice at zoom 1 fills its 311 labels in
   five batches after a zoom settles and pans at 120 fps with every label
   drawn; 2000 nodes, 119.8.
5. **Node bodies** — ~~over the surface~~ **done** on this branch, pending
   react-x11's `box-none` (#637): bodies are the `<glarea>`'s children, and
   the surface is `box-none` while it holds them. And a pan moves one box of
   bodies instead of re-committing each one's position. The widget scene (49
   bodies at 0.6×) pans at 27–28 fps on GL against 23 on 2D, both now drawing
   the bodies; see "What is still open" for what bounds it. Custom `paint`
   types and `renderer="auto"` remain.

## Reproduce

```bash
npx tsx scripts/bench/flow.ts                          # every stage
npx tsx scripts/bench/flow.ts --stage=scene --nodes=20,200,800,2000
npx tsx scripts/bench/flow.ts --stage=gl --nodes=20,200,800,2000
npx tsx scripts/bench/flow.ts --stage=retained --scene=fan
npx tsx scripts/bench/flow.ts --stage=rate             # the ceiling
```

Four stages: `scene` times `buildScene` with no window at all (so it runs
anywhere, including CI), `retained` times the real element's `paint()`, `gl`
draws the same scene into an offscreen CGL target with `glFinish` on every
frame, and `rate` reports what the window delivers — the retained pane's
paints a second, and an almost-empty `<glarea>`'s frames a second beside it.
Read `rate` first: it is the ceiling, and if it is not the panel's rate then
nothing else in the file matters.

Traps worth knowing before trusting a number:

- **Compare within one session, interleaved.** The same gesture on the same
  code measured 27 ms one session and 32 the next. An A/B is two arms
  alternated — old, new, old, new — in one sitting, or it is two
  measurements of the weather.
- **Time the built output for anything JavaScript-bound.** `tsx` runs the
  scene build 2.2× slower than `tsc`'s output does (`--build=dist`).
- **Read p50, never the mean.** A window that loses focus takes a multi-second
  stall, and a backgrounded Cocoa window makes an A/B comparison worthless.
- **A live rate can only be a submultiple of the display period.** Two
  different workloads reporting the same rate is the tell for a quantization
  bug, not a plateau in the work.
- **The offscreen stage must `glFinish`**, or it measures queueing.
- **The first draw of each program builds a driver pipeline**; the stage warms
  up twenty frames and they belong to no frame.
