# Maps on the GPU

> **Status: `<Map>`'s GL renderer**, 2026-09-12. What began as this proof
> of concept is the renderer `<Map>` chooses by default wherever there is
> direct GL, with the retained renderer as its fallback — see "One `<Map>`,
> two renderers" and "The soak". The code is in `src/maps/gl/`, loaded when a
> map chooses it; `examples/maps-gl.tsx` runs it and
> `scripts/bench/maps-gl.ts` / `maps-gl-live.tsx` measure it. Every number
> below is from an Apple M1 Pro — OpenGL 4.1 on Metal, through
> x11-dri 0.7.0 — under react-x11 2.11.0, on the corpus
> `scripts/bench/tiles.ts` fetches (real OpenStreetMap Shortbread tiles for
> Manhattan, central London, Tokyo and a mid-Pacific control, 104 tiles over
> zooms 0–14).

The question this answers: can `<Map>` pan and zoom at 50 frames a second
over dense city tiles **with no bitmap cache** — every frame drawn from the
vector data into a double buffer, the way a GPU map client works — rather
than compositing tile pictures the way [the retained renderer](prd-maps.md)
does?

On the CPU, no, and not by a margin that tuning closes. Through `<glarea>`,
yes, with room to spare.

## The answer

- **A whole frame, drawn from geometry, costs 0.4–10 ms** at 1200×800 on a
  scale-2 display (2400×1600 device pixels), measured to `glFinish`. The
  worst view in the corpus — Tokyo at zoom 10.5, 3.7 million segments a
  frame — is 8.5 ms median and 10.1 ms p95 while panning. Every one of
  sixteen pan and zoom phases, dense and sparse, is under the 20 ms line at
  p95, and after the first frame of a run no frame of any phase exceeds 13 ms.
- **The retained renderer drawing the same frames uncached costs 112–311 ms
  on the Cocoa backend and 0.66–2.4 s on X11** — 3 to 9 frames a second at
  best. Its surface cache is not an optimisation; it is the only way that
  renderer moves at all.
- **In a real window**, animated from the frame callback: **71–75 fps on the
  Cocoa backend and 94–101 fps on X11** (XQuartz, Apple-DRI). On Cocoa the
  ceiling is the window's frame clock, not the map — a mid-Pacific view that
  costs 0.4 ms a frame gets exactly the same 75 fps as central London.
- **A tile costs 0–21 ms once** — parse, filter and write its buckets, median
  3.6 ms, p95 14 ms — and then **0.3–3.7 ms per frame** for the whole of it,
  against 52–109 ms (Cocoa) and 119–548 ms (X11) to rasterize it into a
  1024-pixel surface. That once is per _tile_, not per zoom level or per
  style, and it runs on a worker thread.
- **Labels cost no frame rate.** With the style's labels drawn — up to 110
  names on screen, street names set along their streets — the same window
  pans, zooms and flies at the same rate as without them: 75 / 75 / 74 fps
  either way on Cocoa, 97 / 97 / 97 against 98 / 100 / 101 on X11, and no
  late frame in any pan or zoom phase. Labels are 0.1–0.7 ms of the main
  thread a frame at the median, 1.5–1.7 ms at p95 ("Labels", below).

## Why the retained renderer cannot get there

A dense city tile is 50–140 ms of software rasterization on either backend
(`prd-maps.md` has the profile), and a 1200×800 pane at scale 2 shows six to
twelve of them. The retained design makes sure that cost is never _in_ a
frame: a pan blits, a fractional zoom composites scaled surfaces, and
rasterization is budgeted across frames. What it cannot do is draw a state
it has not rasterized. Crossing an integer zoom shows a blurry ancestor for
the second or two the new level takes; a restyle holds the old picture until
the whole view is redrawn; and every surface is 4 MB, two per tile.

Asked to draw every state, it measures:

| view (2400×1600) | Cocoa, uncached | X11, uncached |
| ---------------- | --------------: | ------------: |
| London z12       |          278 ms |       1803 ms |
| London z14       |          175 ms |       1140 ms |
| Manhattan z14    |          199 ms |       1375 ms |
| Tokyo z12        |          311 ms |       2431 ms |
| Tokyo z10        |          261 ms |       1660 ms |
| London z8        |          117 ms |        657 ms |
| mid-Pacific z10  |          1.2 ms |         50 ms |
| world z2         |           16 ms |         86 ms |

Median of eight frames from the pan path (below). The X11 column includes a
round trip, so it is the time until the server has the pixels.

## The shape of the GPU renderer

```
source.load ─► parse ─► buildTileBuckets ─► upload ──► every frame:
   bytes        (worker thread, once per tile)  (once)    cover → layers × tiles → draw
                         two ArrayBuffers,                 uniforms only; nothing
                         transferred                       is rebuilt for a camera
```

Six files, each small enough to read in one sitting:

| file          | what it is                                                       |
| ------------- | ---------------------------------------------------------------- |
| `buckets.ts`  | a tile's features as two record streams and a draw list          |
| `shaders.ts`  | four GLSL ES 1.00 programs over one shared vertex layout         |
| `renderer.ts` | the frame: layer-major, scissored, stencil fills, capsule lines  |
| `cover.ts`    | which tiles a frame draws, and what stands in for a missing one  |
| `store.ts`    | load, build (here or on workers), keep, evict                    |
| `view.ts`     | `<GlMap>`: the above inside a `<glarea>`, camera on a controller |

### A tile is two record streams

Everything the GPU reads from a tile is **8-byte records**, and segment _i_
of a stream is records _i_ and _i + 1_, drawn as one instance. A polyline of
_k_ points is _k_ consecutive records, so it costs nothing to "tessellate":

- **line**: `x:int16, y:int16, dist:float32` — `dist` is how far along its
  polyline the point is, for dashes.
- **fill**: `x:int16, y:int16, apex x:int16, apex y:int16` — every ring
  closed explicitly, every record carrying its ring's first point.

Between two polylines or rings sits one sentinel record (`-32768`). The two
segments touching it collapse in the vertex shader, which is cheaper than an
index buffer saying where every part ends. Coordinates are normalised to one
4,096-unit extent, because `extent` is per _layer_ in real tiles (Shortbread
cuts `streets`, `land`, `ocean` and `water_polygons` at 2048) and a per-draw
extent would be one more uniform in the hottest loop.

What that buys, measured over the whole corpus: **0.3–2.2 MB per tile on the
GPU**, against the retained cache's two 4 MB surfaces, and buckets valid for
every camera, every display scale and every palette. A light-to-dark switch
rebuilds nothing; only a style whose _filters_ change does, since the
filters are what choose which features a layer draws.

### A style layer is one range

A road network is fourteen style layers over `streets`: seven classes, each a
casing and a fill, and the casing and fill of a class select exactly the
same roads. The builder reads each run of layers over one source layer once
(as the retained painter does), gives every feature a **membership mask** —
the set of the run's layers that select it — and writes features grouped by
mask. `motorway-casing` and `motorway` land in one group: one copy of the
geometry, two draws with a different width and colour.

Across all 104 corpus tiles, **every style layer came out as exactly one
contiguous range**: a layer is one draw per tile, never one per feature and
never a gather. Without the grouping every road would be copied twice and a
layer would be a scatter of ranges.

### Lines: instanced capsules, no extrusion

The vertex shader widens segment _i_ into a quad around it — half the line
width plus a pixel of fringe — and the fragment shader shades by the
distance from the pixel to the segment, **clamped along it**. That one clamp
is round caps and round joins: two consecutive capsules overlap in exactly
the disc a round join is. The same distance is the antialiasing ramp. Nothing
about a join is computed anywhere, the width is a uniform resolved per frame
(so a road widens smoothly through a zoom instead of in steps), and a road
network costs its points.

Given up: a translucent line lays its colour down twice where capsules
overlap. Every line in the default styles is opaque. A style that is not
wants the depth-test trick — one fragment per pixel per layer — first.

### Fills: fans into the stencil buffer, no triangulation

A fan from any apex to every edge of a ring covers each pixel as many times
as the ring winds around it. So the fill stream, drawn as triangles _(apex,
p₀, p₁)_ with the stencil incremented on one facing and decremented on the
other, leaves the **winding number** in the stencil buffer — non-zero is
inside, which is a polygon with its holes cut, for any shape, with **no
triangulation on the CPU at all**. One cover pass per layer then fills where
the stencil is non-zero and zeroes it as it goes, so the next layer starts
clean. That is the same non-zero rule the retained renderer fills with.

The two passes are what non-zero costs. Even-odd is one (`INVERT`) and is
wrong wherever two features of one layer overlap, which real landuse does:
the overlap is cut out as if it were a hole. There is no
`stencilOpSeparate` in the x11-dri table, or non-zero would be one pass too.

The same fill records drawn as capsules are the polygon's outline — the
buildings' edge colour, or, for every other fill, a half-pixel line in the
fill colour that antialiases the edge. The surfaces have no multisampling
(below), so that edge pass is the antialiasing.

### The frame: layer-major, scissored

For each style layer, every tile's share of it, before the next layer. That
is what the cartography needs — every tile's water under any tile's roads,
every casing under any fill, so a junction on a tile seam knits exactly like
one inside a tile. It is cheap because each tile is **scissored** to its own
square: the camera has no rotation, so a tile's footprint is an axis-aligned
rectangle and a scissor is a clip that costs one call. Tiles carry a buffer
of geometry past their edges, and the scissor is what stops two tiles drawing
the same road twice. Shared edges are rounded edge by edge rather than
origin-and-size, so no gap or double column opens at any fractional zoom.

Per frame this is 150–320 draw calls for a dense view and **0.1–0.45 ms of
this thread's time** to issue them. Everything else is the GPU's.

One vertex array per range, because instanced attributes ignore `first` and
neither GL 4.1 nor ES 3.0 has a base instance: the range's start is baked
into the attribute offsets instead. All four programs bind the same five
attribute locations, so one vertex array feeds whichever program draws the
range.

### The cover: stand-ins are geometry, overzoom is a matrix

The cover is `proj.ts`'s own `tileCover`, resolved against what is loaded. A
hole is covered by the nearest ancestor, drawn at its larger size and
clipped to the hole — **as sharp as its data**, not a stretched bitmap — or,
zooming out, by four children when all four are in hand. Overzoom is the same
move with no hole in it: a z14 tile at zoom 20 is the z14 tile drawn 64 times
bigger. There is no overzoom code, no sub-tiling, and none of the retained
renderer's 16.16 fixed-point clipping, because int16 tile coordinates reach
the shader as floats and the transform is relative to the tile.

### Building off the thread

The builder is the one cost a tile has on the CPU, and a dense one is up to
21 ms — most of a 50 Hz frame. On this thread the store budgets it the way
the retained renderer budgets rasterization; with `buildWorkers` it posts the
tile's bytes to a `worker_threads` pool and gets two ArrayBuffers back by
**transfer**. The main thread's whole cost for a tile is then its upload,
0.1–2.7 ms. Measured in a window flying from zoom 5 to 15 and back: builds on
this thread cost 131 ms of it over six seconds, with one 42 ms frame; on two
workers, 3 ms. The bucket format is what makes this a change of thread and
not of data structure — nothing in it needs a serializer.

### Input: the box behind the surface

A `<glarea>` is a window of its own — a CALayer on the Cocoa backend, a child
X window on X11 — and that is why the first version of `<GlMap>` could not be
panned: its handlers were on the surface, and nothing was ever dispatched
there. Core's hit test skipped a window-owning node (it is not in its
parent's paint order) and answered with the box _behind_ it, so on Cocoa
every press, drag and wheel went to the parent and bubbled away. On X11 the
wheel did reach the surface — core forwarded it from the child window, named
at the node — but a _press_ never left the child window: the child selected
button presses in order to hear the wheel, so the server delivered them
there, and nothing handed them on.

So the gesture handlers live on a focusable pane box around the surface,
which is what Cocoa's input and X11's forwarded wheel reached; and on X11 the
controller also listened on the child window itself for press, motion and
release — ntk selected the motion and release bits on demand, and the
implicit grab a press started kept a drag coming after the pointer left the
map. Core has since made the pointer over a `<glarea>` the tree's
(react-x11#545) — X delivers a press, a motion or a wheel over the surface to
the owning window — so the pane box hears all of it on both backends, and the
child-window listeners are gone. Drag pans; the wheel and a double click zoom
about the pointer (Shift for out); the arrows and +/− work once the map has
focus. A wheel notch is eased over the frames after it rather than applied
where it lands, and a touchpad's measured fractions (`ev.smooth`) are applied
as they arrive — the controller's glide, so the two renderers feel the same
under a hand and a fallback mid-gesture keeps gliding.

Checked three ways, each through the real dispatch: the harness's X server
(injected presses, a drag, a wheel, a double click — `test/maps-gl.test.ts`);
Xvfb with XTEST over a real GL child window, including a drag that leaves the
window mid-gesture; and native events emitted on a real Cocoa window, the
object core's event manager listens on. In all three the ground under the
pointer stayed under it — to 0° for the drag and 3·10⁻¹⁴° for the zoom. The
harness run also caught the one bug: the zoom anchor used the size the last
_frame_ drew, which is its 1×1 placeholder until one has. The pane box's size
is always current.

### Fading between levels

With `levelFade`, crossing an integer zoom no longer swaps one level's
geometry for the next in a single frame. The new level is waited for — until
every tile of it in view has answered, or 400 ms — and then faded in over the
level it replaces, with an ease at both ends; a change of target halfway
through a fade takes the half-shown level as the one it fades from. A level
more than one step away is not faded, because the view it would fade from is
sixteen times the tiles.

The arriving level is drawn whole into an offscreen target and composited
once, not layer by layer at reduced opacity — a map faded layer by layer
shows its casings through its fills. Both scenes are opaque, so the composite
is exactly a cross-fade, and measured so: against `(1 − a)·A + a·B` the
worst channel of 2.9 million is 0.5 off, which is 8-bit rounding. The cost is
the expected one: the frame is drawn twice for the length of the fade.

### Adaptive quality

With `adaptive`, a moving frame is held to a budget (12 ms by default) by
leaving out what it can best afford to lose, in this order — the rungs of
`QUALITY_LADDER`:

1. **The fill edge pass** — a fifth of a dense frame, and a staircase edge
   nobody sees in motion.
2. **The style's newest detail layers** — those whose `minZoom` is within one,
   then two levels of the zoom: buildings and service roads first, then sites
   and minor roads. The style already says which layers are details by
   bringing them in last, so this needs nothing new from it.
3. **A coarser tile level**, whose generalized geometry is what makes a
   low-zoom frame — all land and water — cheaper. Its tiles are asked for
   while the map moves, so they are there when a rung wants them.

A frame's cost is predicted before it is drawn: `renderer.estimate` walks the
same gates as the frame over the ranges' record counts (a test pins it equal
to what the frame then draws), and a learned milliseconds-per-instance turns
that into time. The rate starts at what this machine measured and is
learned from **settled** frames only — each drained, drawn and timed with
`glFinish`, which a frame that animates nothing can afford.

The first version timed every moving frame instead, and that is this
section's lesson. A finish holds the thread until the GPU is done — and on
the Cocoa backend until the surface is — so what it read was not the frame's
cost: 16–52 ms at rungs whose drawing is a few milliseconds, which taught the
model a rate several times too slow and put nearly every moving frame on the
coarsest rung. (Those runs also came in at 60 frames a second rather than the
75 measured earlier, which looked like the finish's price. A control without
adaptive quality came in at 60 too: the display had changed its rate —
finding 5.) A mechanism whose job is frame rate must not stall the frame to
observe itself, so nothing is timed while the camera moves now. The settled
frames it learns from err slow instead — a lone frame after a pause meets a
GPU that has clocked down — which errs toward frame rate. Timing without
stalling needs GPU timer queries or fences, and x11-dri exposes neither.

The chosen rung is the lowest predicted to fit, and a rung up is taken only
once it is predicted well inside the budget (75%), so a frame at the edge
does not flicker between two. 180 ms after the camera stops, the next frame
draws everything.

### Labels

A `<glarea>` is stacked over every 2D thing in its window, so a GL map's
labels have to be in the GL frame — there is no drawing text over it
afterwards. What the proof of concept had was the retained renderer's
placement (world pixels, per zoom level, one anchor per feature at the
middle of its longest part) and nothing that put a glyph on the GPU. What it
needed was four things, and the brief for them was one sentence: labels
should not distract, and should not obscure what they label — a street's
name along the middle of the street, on a stretch that is straight.

**Where a label could go** (`labels.ts`, built once per tile, on the worker
with the buckets). A point label's place is its point. A line label's is the
answer to the brief, in three steps:

1. **Merge.** A street is one feature per segment in every schema —
   `street_labels` offers "Westminster Bridge Road" 24 times in one London
   tile — so each name's pieces are joined end to end, in either direction,
   the straightest continuation first. Without it, an avenue cut at every
   cross street has no stretch longer than a block. (561 pieces become 425
   chains in that tile; the ends that stay apart are real — termini, tile
   edges, dual carriageways, short named footways.)
2. **Straighten.** Each chain is walked into maximal straight runs: every
   vertex within 8 tile units of the run's chord (a pixel at the tile's own
   zoom), no vertex turning more than 25°. A gentle curve is a run; a corner
   ends one.
3. **Anchor.** Each run offers its middle, the middle of every block between
   two junctions, and — on a long run with none — a point every 256 pixels.
   Each anchor carries what placement needs to judge it at _any_ zoom: the
   straight run either side of it, the distance to the nearest junction, and
   the run's departure from straight. A junction is a vertex two differently
   named streets share.

That is 1.3–2.0 ms a tile, off the main thread, and 300–550 anchors in a
dense city tile.

**Which labels are drawn** (`placement.ts`, every frame, in screen space).
Greedy, in the map's order — layer rank, then the feature's importance (road
class, population), then what is already shown, then among one street's
anchors one whose label clears every junction, the longest run, the one
nearest the middle of the view. A label is placed if it is **whole inside
the view**, if its straight run carries it with half a text height to spare
at each end, if the run is within 0.3 of a text height of straight at _this_
zoom, if the same name is not already placed within the repeat distance, and
if it overlaps nothing placed before it (a box for a level label, a chain of
circles along the baseline for a slanted one). Text is always upright, and a
name within 10° of vertical reads bottom to top, so neighbouring streets a
few degrees apart do not read opposite ways.

A per-frame placement is what makes "whole inside the view" possible; what
keeps it from reshuffling every frame is the rest:

- **A label keeps its place.** What is shown is offered first, at the ground
  it was placed on, with slack — a smaller margin, a run 10% short is
  enough — so two labels a margin apart never trade places. It leaves when it
  must: it no longer fits its run at this zoom, would be cut by the edge, is
  outranked, or the tile under it no longer names it (a new source or filter
  takes it off the map; a level change does not).
- **Labels fade** in and out over 220 ms, and one whose text is still being
  rasterized waits, invisibly, until it can fade in.
- **Labels do not slide.** Anchors are ground, so a label moves exactly with
  the map; a street whose label leaves the view offers another anchor.
- **A zoom does not reshuffle.** While the zoom changes, what is shown rides
  along and leaves as it must, but nothing new is admitted until the zoom has
  held still for 150 ms — so names appear once where a zoom stops, rather
  than arriving and leaving at every step of it. This was also where the cost
  was: admitting labels throughout, the fly phase had 62 frames over 20 ms
  against the unlabelled map's 6; admitting them only at rest, 3 against 2.

**Text on the GPU** (`text.ts`). A label is set by the app's own text engine
— `app.fonts.layout()`, CoreText on the Cocoa backend and ntk's shaper on
X11, fallback fonts and all — drawn in white into an offscreen `Surface`,
read back with `getImageData`, and packed into one 2048² atlas. A label is
rasterized **whole**, not glyph by glyph: every line label is set on a
straight stretch, so it is one rigid quad rotated as a unit, and shaping,
kerning and scripts stay the text engine's business. The raster is coverage;
colour and halo are the shader's, so one raster serves every palette, and the
halo is the coverage dilated in the fragment shader (the greatest coverage on
two rings of 16 samples) — which lets one raster serve every halo width too.
A level label is set on whole pixels, texel for pixel, as crisp as the text
engine made it.

Each cost is metered, because on X11 text is not cheap: setting 64 strings
for the first time costs 146 ms of shaping there against 10 ms on Cocoa (ntk
loads fonts and rasterizes glyphs in JS). A frame measures new strings for
1 ms while the camera moves and 4 ms at rest, and always at least one; a
batch of rasters — 32 strings at most — is drawn between frames, not in one,
for at most 1.5 ms, and read back only as far as it was drawn; the renderer
takes at most 24 rasters a frame into the texture, as read back (the shader
reads alpha, so there is nothing to convert); a label is drawn only once its
raster is there; and a moving view is placed again every 25 ms or so rather
than every frame, the labels shown following the map every frame regardless.
Each of those was bought by a late frame: a labelled pan's late frames came
in bursts, as a name entering the view was measured, placed, rasterized and
uploaded within the same few frames, and it took spreading every one of
them thinner to bring pan to parity with the unlabelled map. The atlas keeps
every raster it holds, so a compaction or a new GL context re-uploads
without re-rasterizing, and what it keeps is bounded by the texture it packs
into.

**Drawing** (`renderer.ts`) is one instanced draw, 72 bytes a label, after
the level fade's composite — labels are placed for the view, not for either
level, and would blink at every level change if they faded with one — and
before the offscreen copy where there is one.

Measured in a window, 1200×800 at scale 2, with the budget forced down to
3 ms — at the default 12 ms this machine rarely needs it. Panning London drew
rungs 1–2 for 305 of 363 frames and the coarser level for 57; Tokyo, rungs
2–3 throughout; the zoom and fly phases reached the last rung when the view
took in several levels' worth of land and water. At 6 ms London panned
entirely at full quality and degraded 108 of 362 fly frames. Frame rate and
late frames (1–3 over 20 ms per six-second phase) were those of the same run
without it, and the fade ran on 104–122 frames of every zoom and fly phase.

## Measurements

### One tile

A 512-logical-pixel tile at scale 2 — a 1024-pixel square — the densest and
sparsest tile at each zoom in the corpus. Median milliseconds. The retained
columns are one rasterization into a surface; the GL columns are the tile's
one-time build and upload, then one frame drawing all of it.

| tile           | kind   |  KB | Cocoa |   X11 | GL build | upload | GL frame | segments |
| -------------- | ------ | --: | ----: | ----: | -------: | -----: | -------: | -------: |
| `0/0/0`        | dense  |  51 |   3.2 |  18.2 |      2.6 |   0.36 |     1.32 |   77,715 |
| `2/1/1`        | dense  | 229 |   4.9 |  27.6 |      3.0 |   0.43 |     1.62 |   88,519 |
| `4/7/5`        | dense  |  81 |   1.8 |  16.4 |      0.9 |   0.18 |     0.72 |   28,558 |
| `6/18/24`      | dense  | 586 |  51.9 | 118.8 |     18.6 |   2.72 |     2.62 |  432,451 |
| `8/227/100`    | dense  | 882 | 108.7 | 223.5 |     20.9 |   0.77 |     3.73 |  721,785 |
| `10/511/340`   | dense  | 810 | 105.3 | 354.9 |     18.6 |   1.07 |     2.44 |  642,030 |
| `12/3638/1612` | dense  | 367 |  90.5 | 361.4 |      9.0 |   1.38 |     0.87 |  131,800 |
| `14/8185/5447` | dense  | 483 |  79.9 | 548.0 |      5.5 |   0.20 |     0.91 |  163,627 |
| `2/0/2`        | sparse |  27 |   1.1 |   9.8 |      0.6 |   0.12 |     0.54 |    9,124 |
| `8/14/128`     | sparse |   1 |   0.4 |   7.1 |     0.02 |   0.14 |     0.34 |      418 |
| `12/228/2048`  | sparse |   0 |  0.07 |   5.0 |     0.01 |   0.13 |     0.25 |       15 |

The dense rows are **20–104 times** quicker per frame than the Cocoa raster,
and the raster repeats at every integer zoom and every style change while the
build does not. The sparse rows are near nothing either way; the GL frame's
0.25 ms floor is the `glFinish` round trip, not drawing.

### Every frame drawn

1200×800 at scale 2, 120 frames per phase: **pan** is a circle of 256
logical pixels, so tiles enter and leave the view continuously; **zoom** goes
from one level below the view to one above and back, crossing two pyramid
levels. Every frame is drawn from the buckets and timed to `glFinish`; the
tiles are resident, because what arrives is the store's cost and is measured
in the window below.

| view          | kind   | phase |  median |   p95 |    max | segments |
| ------------- | ------ | ----- | ------: | ----: | -----: | -------: |
| London z12    | dense  | pan   | 3.21 ms |  8.28 | 66.0 * |    2.90M |
| London z12    | dense  | zoom  | 3.36 ms |  7.52 |   7.61 |    2.63M |
| London z14    | dense  | pan   | 2.83 ms |  5.10 |   5.94 |    0.90M |
| London z14    | dense  | zoom  | 2.23 ms |  2.39 |   2.65 |    0.64M |
| Manhattan z14 | dense  | pan   | 2.35 ms |  5.14 |   7.66 |    0.91M |
| Manhattan z14 | dense  | zoom  | 2.03 ms |  3.67 |   4.78 |    0.81M |
| Tokyo z12     | dense  | pan   | 2.47 ms |  3.52 |   3.61 |    1.05M |
| Tokyo z12     | dense  | zoom  | 2.63 ms |  7.11 |   7.25 |    2.56M |
| Tokyo z10     | dense  | pan   | 8.54 ms | 10.10 |  12.10 |    3.70M |
| Tokyo z10     | dense  | zoom  | 7.22 ms |  9.20 |  13.00 |    3.60M |
| London z8     | dense  | pan   | 3.24 ms |  4.06 |   4.38 |    1.20M |
| London z8     | dense  | zoom  | 3.16 ms |  4.82 |   8.57 |    3.26M |
| mid-Pacific   | sparse | pan   | 0.40 ms |  0.44 |   0.52 |    0.001 |
| mid-Pacific   | sparse | zoom  | 0.37 ms |  0.40 |   0.43 |    0.001 |
| world z2      | sparse | pan   | 1.88 ms |  2.28 |   2.75 |    0.69M |
| world z2      | sparse | zoom  | 1.50 ms |  2.32 |   4.70 |    0.85M |

\* The first measured frame of the run, in both runs that were made; no other
frame of any phase exceeds 13 ms. A one-time cost of the run, not of a state.

### In a window

`scripts/bench/maps-gl-live.tsx`: `<GlMap>` in a 1200×800 window with
`frameLoop="always"`, the camera driven from the frame callback for six
seconds a phase. **Fly** zooms from 5 to 15 and back, so tiles arrive and
are built the whole way. Frames per second as delivered; the interval
columns are between successive frames; "late" is intervals over 20 ms.

| backend                 | builds    | phase | fps | interval median / p95 / max | late |
| ----------------------- | --------- | ----- | --: | --------------------------- | ---: |
| Cocoa                   | here      | pan   |  73 | 13.4 / 15.1 / 26.8 ms       |   12 |
| Cocoa                   | here      | fly   |  71 | 13.3 / 15.2 / 67.9 ms       |   15 |
| Cocoa                   | 2 workers | pan   |  74 | 13.4 / 14.9 / 26.2 ms       |    6 |
| Cocoa                   | 2 workers | zoom  |  74 | 13.3 / 14.7 / 27.1 ms       |    4 |
| Cocoa                   | 2 workers | fly   |  73 | 13.3 / 14.7 / 49.7 ms       |    9 |
| Cocoa, mid-Pacific      | 2 workers | pan   |  75 | 13.2 / 14.4 / 26.3 ms       |    1 |
| X11 (XQuartz Apple-DRI) | 2 workers | pan   |  94 | 10.5 / 12.6 / 28.9 ms       |    2 |
| X11 (XQuartz Apple-DRI) | 2 workers | zoom  |  95 | 10.5 / 12.4 / 24.8 ms       |    1 |
| X11 (XQuartz Apple-DRI) | 2 workers | fly   | 101 | 9.8 / 11.9 / 28.5 ms        |    1 |

The Cocoa rows sit on one peak at 13–14 ms whatever the map costs — the
mid-Pacific control issues 0.4 ms a frame and gets the same 75 fps as London
at 1.3 ms — so the Cocoa figure is the window's frame clock on this machine
(a 120 Hz ProMotion panel), not the renderer. Shortening `<glarea>`'s swap
gate to three quarters of a period (`--gate=0.75`) removed the late frames
from pan and zoom but did not move the median, which is what ruled the gate
out as the cause. X11 frames peak at 10–11 ms.

### What the choices cost

The view stage again, one option changed at a time. The sum is over the
sixteen phases' medians; Tokyo at zoom 10 is the densest view.

| variant                                         | all phases |    Δ | Tokyo z10 pan (median / p95) | segments |
| ----------------------------------------------- | ---------: | ---: | ---------------------------- | -------: |
| as shipped: non-zero, edge pass, direct         |    46.9 ms |      | 8.54 / 10.07 ms              |    3.70M |
| no fill antialiasing (`--aa=off`)               |    36.5 ms | −22% | 6.14 / 7.04 ms               |    2.69M |
| even-odd fills (`--fill=evenodd`)               |    38.0 ms | −19% | 6.14 / 7.49 ms               |    2.69M |
| offscreen framebuffer + copy (`--offscreen=on`) |    51.3 ms |  +9% | 8.68 / 10.20 ms              |    3.70M |

### Labels, in a window

The live bench at London zoom 15.5, where street names begin, with labels on
and then off, back to back: 1200×800, two build workers, four seconds a
phase. 390–490 anchors are considered a frame and up to 94 labels placed on
Cocoa (scale 2), 71 on X11 (scale 1). "Late" is intervals over 20 ms; label
milliseconds are the main thread's, per frame, while panning.

| backend | labels | pan fps / late | zoom fps / late | fly fps / late | label ms, median / p95 |
| ------- | ------ | -------------- | --------------- | -------------- | ---------------------- |
| Cocoa   | off    | 75 / 0         | 75 / 0          | 74 / 3         |                        |
| Cocoa   | on     | 75 / 0         | 75 / 0          | 74 / 3         | 0.67 / 1.68            |
| X11     | off    | 98 / 0         | 100 / 0         | 101 / 0        |                        |
| X11     | on     | 97 / 0         | 97 / 0          | 97 / 2         | 0.09 / 1.49            |

What labels do cost is the first frames of a view, at rest: its strings are
measured 4 ms a frame, so on X11 the names of a fresh view arrive over its
first half second, and two to four of those frames run late — which, the
camera being still, nobody sees. The zoom and fly phases place almost
nothing (a label is admitted only once the zoom holds still), which is why
their label cost is near zero.

The fill stream is drawn three times — two stencil passes and the edge pass
— and each pass is about a fifth of a dense frame, so **the fills, not the
roads, are where the next milliseconds are**. Low-zoom `land` and
`water_polygons` are single features of up to 130,000 vertices, most of them
closer together than a pixel. The levers, in order of what they would buy:
simplify fill rings to the level's resolution once, at build time (the
retained renderer's decimation, moved from every frame to every tile); drop
the edge pass where a fill's neighbour shares its colour; and
`stencilOpSeparate`, which makes non-zero one pass — x11-dri 0.8 has it, and
the renderer uses it wherever the table does. The offscreen copy is
0.1–1.3 ms a frame — what XQuartz pays for its missing stencil, until ntk
asks CGL for one (ntk#353).

### The soak

What `'auto'` became the default on: the live bench with everything an
application puts on a map switched on — the style's labels, 200 markers (a
tenth of them discs, one selected) and overlays (a 400-point route with a
casing, a dashed line, a translucent area with a hole and two translucent
circles) — and the same map with only its labels. London at zoom 12.3,
1200×800, six seconds a phase; "late" is intervals over 20 ms.

| backend                 | builds    | markers, overlays | settle fps | pan fps / late | zoom fps / late | fly fps / late | pan interval median / p95 / max |
| ----------------------- | --------- | ----------------- | ---------: | -------------- | --------------- | -------------- | ------------------------------- |
| Cocoa                   | here      | on                |         49 | 60 / 0         | 80 / 4          | 86 / 6         | 16.6 / 18.4 / 19.4 ms           |
| Cocoa                   | 2 workers | on                |         71 | 60 / 0         | 79 / 1          | 89 / 1         | 16.6 / 18.7 / 19.8 ms           |
| Cocoa                   | 2 workers | off               |         72 | 60 / 0         | 79 / 2          | 91 / 0         | 16.7 / 18.1 / 19.4 ms           |
| X11 (XQuartz Apple-DRI) | here      | on                |         79 | 93 / 0         | 93 / 4          | 91 / 4         | 10.6 / 13.2 / 16.6 ms           |
| X11 (XQuartz Apple-DRI) | 2 workers | on                |         85 | 97 / 0         | 94 / 0          | 97 / 1         | 10.1 / 12.4 / 14.5 ms           |
| X11 (XQuartz Apple-DRI) | 2 workers | off               |         91 | 95 / 0         | 97 / 0          | 103 / 0        | 10.5 / 12.6 / 18.5 ms           |

What the markers and overlays cost is a fraction of a millisecond of the
main thread a frame — 0.74 against 0.51 ms at the median while panning on
Cocoa, within the noise on X11 — and no frame rate on either backend. The
late frames that remain are tile builds on the main thread, a dense tile up
to 80 ms of it; with `buildWorkers={2}` they are gone from pan and zoom and
down to one in fly. On Cocoa the pan phase runs at 60 fps with or without
anything on the map, while zoom and fly run at 79–91: the window paces that
phase, and the renderer issues a pan frame in under a millisecond. The
frames read back from GL inside the frame — the only capture that sees the
surface — are attached to the pull request that closed #101.

## Platform findings

Each of these cost a wrong answer before it was understood, and four of them
were candidates for upstream issues; core has since fixed one (6).

1. **XQuartz's Apple-DRI surface has no stencil buffer.** ntk's CGL context
   (`renderingcontext_cgl.js`) passes only `depthSize` to `apple.Context`,
   so a `<glarea>` on the X11 backend under macOS cannot stencil, while the
   Cocoa backend's IOSurface targets carry `DEPTH24_STENCIL8`. The renderer
   probes, and draws through an offscreen framebuffer plus one full-frame
   copy where there is none. _Upstream candidate: forward `stencilSize`._
2. **A framebuffer with no stencil buffer passes every stencil test.** So the
   first probe — write 1, draw where it is 1 — drew either way, reported a
   stencil buffer XQuartz does not have, and every fill's cover pass painted
   the whole view in that layer's colour. Only a read-back from GL showed it.
   The probe now also asks the question only a real buffer answers "no" to (a
   draw where a cleared stencil is not zero), and a test pins both halves.
3. **Window capture does not see a GL surface.** `CGWindowListCreateImage`
   on the Cocoa backend returns the window without the `<glarea>` layer —
   solid white — as X-side capture does on X11. Read frames back through GL:
   `<GlMap onAfterDraw>` exists for exactly that.
4. **No multisampling.** x11-dri exposes neither
   `renderbufferStorageMultisample` nor `blitFramebuffer`, so antialiasing
   is the capsule shader's ramp for lines and the half-pixel edge pass for
   fills. _Upstream candidate, if MSAA ever matters more than that._
5. **The Cocoa frame clock follows the display's current rate, and macOS
   moves it.** It gave this window ~75 Hz for most of the session — a map
   that costs almost nothing got the same 75 fps as London, so it was not
   the renderer — and 60 Hz later, with the code and configuration
   unchanged, once this ProMotion panel had moved. The X11 path reached
   ~100 Hz at the time of the 75. A frame-rate comparison on this backend
   is only good against a control run in the same minutes.
6. **Pointer input went around a `<glarea>`, differently on each backend.**
   Core's hit test skipped the surface, so on Cocoa everything landed on the
   box behind it; on X11 only the wheel was forwarded, and a press was
   swallowed by the child window, which selected presses to hear the wheel.
   `<GlMap>` handled both — its pane box, and listeners on the child window
   ("Input", above) — but every GL element would have had to learn the same
   two routes, and 2D content could not overlap the surface either, which is
   why a GL map draws its own labels, markers and attribution. _Fixed
   upstream: react-x11#545 makes the pointer over a surface the tree's, and
   #546 draws a surface's children above it._
7. **A worker under `tsx` just works.** Workers inherit tsx's loader through
   `execArgv`, and a `.js` specifier resolves to the `.ts` source, so
   `new Worker(new URL('./build-worker.js', import.meta.url))` runs in
   development and in `dist/` alike.
8. **Not measured: Linux.** The DRI3 path (Mesa GLES) should run the same
   GLSL ES 1.00 unchanged, but this machine's Xvfb is indirect GLX, which has
   no shaders. Indirect GLX is the other reason the retained renderer stays:
   it is the fallback wherever there is no direct GL.
9. **A Cocoa window covered by another application's gets no frames at
   all.** Core holds its frame callbacks until the window is back on glass,
   which is right for an app and silent for a benchmark: three labelled runs
   stopped delivering frames partway through a phase, with no error, and
   read as a hang in the new code until the frame queue explained it.
   `maps-gl-live.tsx` now samples the window's visibility and marks a
   covered phase as not a measurement.
10. **Text is an order of magnitude dearer on X11, the first time.** Sixty-
    four fresh strings: 146 ms of shaping and a 41 ms readback, against
    10 ms and 1 ms on Cocoa — ntk loads fonts and rasterizes glyphs in JS —
    and cached after that, which is why every text cost above is metered. A
    readback past a pixmap's edge is a `BadMatch` there where Cocoa clamps,
    so the staging surface is read back only as far as it was drawn. And
    ntk's X11 font fallback spaces Cyrillic out ("М о с т" in a probe).
    _Upstream candidate: the fallback's advances._

## What is still to do

The GL renderer draws everything `<Map>` does ("One `<Map>`, two
renderers", next). What it does not do yet, in rough order:

- **Curved labels, icons and label priorities from the style.** A name that
  only fits around a bend is not drawn (by design — see "Labels"), a style
  cannot yet say `symbol-sort-key` or weight a face, and there are no POI
  icons, which are instanced quads from the same atlas.
- **Caps and joins other than round.** Every GL line has round caps and
  round joins, so a style's `cap` and `join` are the retained renderer's
  alone. Butt and square caps and miter and bevel joins need a segment's
  neighbours in the vertex shader: a sentinel before a stream's first
  record, and two more attributes.
- **Dash patterns of more than four dashes**, cut to four today.
- **Timer queries and multisampling** from x11-dri 0.8 — the first to price
  adaptive quality's moving frames without `glFinish`, the second to retire
  the fill edge pass. x11-dri reports both (`gl.getFeatures()`); nothing
  here reads them yet. Its `stencilOpSeparate` is read: it makes a non-zero
  fill one stencil pass.
- **Marker boxes in the label collision grid**, so that a name does not run
  under a marker — which neither renderer does.
- **Pinch**: a two-finger scroll is a wheel and zooms, as on the retained
  renderer.

## One `<Map>`, two renderers

The question this proof of concept leaves is not _which_ renderer but how the
two live together, and the proposal is: **keep the retained renderer, and put
both behind the one `<Map>`, which chooses for itself.**

### Why the retained renderer stays

It is the only renderer in four places the GL one cannot reach, and none of
them is going away:

1. **No direct GL.** An X11 connection gets indirect GLX unless the app asks
   otherwise — `'indirect'` is ntk's default, and it has no shaders — and a
   remote X server over SSH, Xvfb in CI, VNC and a VM without a GPU have
   nothing better to give. (Linux DRI3 should run the GL renderer; it is not
   yet measured.)
2. **The headless harness.** Every test here runs on node-x11's in-process
   server, where a `<glarea>` has no surface. The retained renderer is how
   `<Map>` is tested at all.
3. **GL failing at run time** — a context that will not create, a driver that
   rejects a shader. A map that goes blank is worse than a map that is
   slower.
4. **Capture.** A GL surface is invisible to window capture on both backends
   (finding 3). A retained map is in the window's own pixels, so a snapshot,
   a documentation screenshot or a print sees it.

There was a fifth, and it did go away: 2D over the map. `<Map>`'s `children`
— a legend, a control panel — are laid out over the pane, and a `<glarea>`
is stacked above every 2D thing in its window, so under GL they were hidden
until react-x11#546 drew a surface's children above it.

What keeping it costs is a second draw path, which is less than it sounds:
everything above the draw is shared already, or can be.

| concern                                     | shared now                                        | per renderer today                                 |
| ------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| decoding                                    | `mvt.ts`                                          |                                                    |
| style                                       | `style.ts`, `styles.ts`, `prepareStyle` + filters |                                                    |
| projection, tile cover                      | `proj.ts`                                         |                                                    |
| sources, pyramids, `load`                   | `sources.ts`                                      |                                                    |
| tile cache                                  | (the bytes could be)                              | surfaces (retained), buckets and textures (GL)     |
| labels                                      | the anchors (`anchors.ts`) and the fit rules      | world-pixel vs screen-space placement; 2D vs atlas |
| camera, input, handle                       | `controller.ts`                                   |                                                    |
| markers, overlays, attribution, hit testing | order, paint, layout, hit test (`overlay.ts`)     | 2D paths vs instanced discs and a rebased bucket   |

The label anchors are `src/maps/anchors.ts` now, and the retained renderer
places from them — in world pixels still, with the GL renderer's fit rules —
so both renderers name the same streets in the same places, at the same
angles. Placement stays each renderer's own: world pixels are what keep the
retained renderer's pan a blit, and screen space with fades is what a
renderer that draws every frame can afford.

### One component, chosen for you

```tsx
<Map sources={[osm]} />                       // GL where it can, retained where it cannot
<Map sources={[osm]} renderer="retained" />   // pinned
<Map sources={[osm]} renderer="gl" />         // GL, or onError — never a silent fallback
```

Each rung of ceremony is an addition to the one before it:

1. **Nothing.** `renderer: 'auto'` is the default.
2. **Per map:** `renderer: 'auto' | 'gl' | 'retained'`.
3. **Per app:** the root's `glPolicy` already decides whether there is direct
   GL to choose — `'off'` makes every map retained, and on X11 the app asks
   for GL there (`createRoot({ glPolicy: 'auto' })`), because a map cannot
   raise a connection's policy after the fact. An environment variable,
   `REACT_X11_MAP_RENDERER`, overrides both for whoever is debugging and for
   CI, the way `REACT_X11_BACKEND` does for the backend.
4. **Observe:** `stats.renderer` in `onFrame`, and
   `onRendererChange(renderer, reason)` when a map falls back.

A prop only one renderer reads — `rasterBudgetMs`, `rasterScale`,
`surfaceBudget`, `batchVertices` and `progressive` for the retained one;
`levelFade`, `adaptive` and `buildWorkers` for GL — is accepted by both and
ignored by the other, so switching renderers is never a type error and never
a rewrite.

`'auto'` decides, in order:

1. an explicit `renderer`, or the environment;
2. `useSupports('shaders')` — whether this connection has direct GL;
3. at run time, a GL failure (`<glarea onError>`: no surface, no context, a
   shader) moves that map to the retained renderer and reports it.

A capability gate sat between the last two while GL caught up — nothing the
map uses missing from the GL path (the list below), with a DEV-mode line
naming the prop that kept a map retained. Its last entry was `children`, and
it went with react-x11#546.

Three decisions go with it:

- **The camera lives on a controller both renderers share**, as it already
  lives on each renderer's own — so a fallback in the middle of a pan keeps
  the camera, and the handle the application holds keeps working.
- **The GL renderer is loaded when it is chosen**, by dynamic import. A
  static import from `<Map>` would put `src/maps/gl/` into every bundle that
  uses a map, which is the tree-shaking promise broken; `treeshake.test.ts`
  gets a guard that importing `Map` bundles none of it.
- **`'gl'` never falls back silently.** An application that asked for GL
  wants to know it did not get it.

### What GL needed before `'auto'` could choose it

In the order of how many maps each one blocked — all of them in now:

1. **Attribution** — a licence condition, on every OpenStreetMap map. Drawn
   through the label atlas, on the pixels the retained renderer puts it on
   (`attributionLayout`, shared).
2. **Markers and overlays**, and their events. Markers are one instanced
   draw, each shaded by its distance to its outline — a disc, or the pin's
   teardrop — and the hit test and its events are the controller's. Overlays
   are one bucket of the tiles' own record streams, drawn by the same
   programs; its records are int16 from the centre of a region around the
   view, worked out in float64, so a vertex holds still at zoom 22
   (`gl/overlays.ts`).
3. **The rest of the handle and events** — the controller's, so
   `test/maps-renderers.test.ts` runs one suite against both renderers.
4. **Raster sources** as textures, drawn whole past the source's depth, and
   **circle layers** as instanced discs.
5. **`children` over the map** — react-x11#546 draws a surface's children
   above it. Until it did, `'auto'` kept a map with children retained.

### Order of work

1. This proof of concept, and this plan. **Done** (#100).
2. The shared controller, and `<Map renderer>` with `'retained'` as the
   default and `'gl'` an opt-in. **Done** (#101).
3. GL parity, items 1–4 above; the retained renderer adopts the GL label
   anchors. **Done** (#101).
4. `'auto'` becomes the default, once both backends have soaked ("The soak",
   above) and a test proves the fallback — a GL that fails on its first
   frame. **Done** (#101).
5. In core, alongside: 2D over a `<glarea>` (react-x11#546), the pointer
   over it delivered to the owning window (react-x11#545) and x11-dri 0.8
   for every app (react-x11#547) — all three **Done**, and `<Map>` no
   longer works around the first two; and the `glPolicy` question answered
   in `<Map>`'s documentation rather than by a new default for X11 — a map
   cannot raise its connection's policy, and an app that wants GL on X11
   says so once, at `createRoot`.

The retained renderer is deprecated at no step. It is the fallback.

## Reproduce

```bash
npx tsx scripts/bench/tiles.ts                          # the corpus, once
npx tsx scripts/bench/maps-gl.ts                        # tile, view, cpu-view
npx tsx scripts/bench/maps-gl.ts --cpu=cocoa,x11        # the CPU side on both
npx tsx scripts/bench/maps-gl.ts --stage=view --aa=off  # or --fill=evenodd, --offscreen=on
npx tsx scripts/bench/maps-gl-live.tsx --workers=2      # in a window, default backend
REACT_X11_BACKEND=x11 npx tsx scripts/bench/maps-gl-live.tsx --workers=2
npx tsx scripts/bench/maps-gl-live.tsx --workers=2 --adaptive=3 --fade=300
npx tsx scripts/bench/maps-gl-live.tsx --workers=2 --zoom=15.5 --readback=f.png   # labels
npx tsx scripts/bench/maps-gl-live.tsx --workers=2 --zoom=15.5 --labels=off       # and without
npx tsx scripts/bench/maps-gl-live.tsx --markers=200 --overlays=on                 # the soak
REACT_X11_BACKEND=x11 npx tsx scripts/bench/maps-gl-live.tsx --markers=200 --overlays=on
npm run examples:maps-gl                                # and look at it
```
