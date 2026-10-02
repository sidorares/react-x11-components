# PRD: `<Html>` animations off the JavaScript clock, and transforms that do not re-rasterize

> **Status: step 1 is built but for 1c, which measured as not worth
> building.** `<Html>` runs CSS
> animations since
> [#584](https://github.com/sidorares/react-x11-components/pull/584), on a
> timer of its own, restyling and repainting in JavaScript. This document
> answers two questions the PR left open: whether the animation primitives
> the platforms provide can run any of it, and how an animated transform
> can stop re-rasterizing its subtree on every frame. §7 is the
> recommendation and the order to build it in; §8 is what has to be filed
> upstream first. The retained sprite of §5.1 is built for the boxes X11
> draws on a surface through their matrix — the kept surface, §7's step 1a
> — and group opacity, with a fade drawn from its kept group, step 1b: on
> X11 and Wayland, and on macOS over react-x11 2.27.0. The retained
> background, 1c, is deferred on its measurement. Step 4's spike is done,
> and step 5 is built: core's sprite seam (react-x11#819) and the bridge's
> matrices (windowkit/appkit#97), with `<Html>` offering what a layer can
> carry, at no JavaScript frame on macOS — released in react-x11 2.29.0 and
> appkit 0.19.0. Step 3 is built: `will-change` for what it means to
> layout and paint, an animation acting as though it named what it sets,
> and what a layer may cover decided in the order the document paints.
> Steps 2 and 6 are not built. The reference for what runs today is
> `docs/components/html.md`, "Animations".

## 1. What `<Html>` does today

A frame of an animation is a restyle of the elements it runs on, at the
timeline's time. `src/html/css/timeline.ts` keeps when each element's
animations started; the cascade asks it for each animation's progress and
interpolates the computed values between the frames around it
(`css/interpolate.ts`). A 16 ms timer (`animationClock`, `src/html/node.ts`)
asks for the next frame while an animation is under way.

What a frame costs depends on what the animation changes:

- **An opacity, a colour, a visibility, a transform, a `z-index`** are
  changes a hover may make in place (`hoverChange`, the `fade` and `move`
  classes). The element's boxes keep their identity and take the new
  style; the frame claims the ink the element drew before and draws now,
  and the window repaints that. A transform's translation moves the box
  (`applyRelativeOffsets`); what is left of it, a turn, a scale or a skew,
  is painted through `paintTransformed`.
- **Anything layout reads** — Zen Garden 219's marquees animate
  `text-indent` — builds the boxes again around every other element's kept
  style and lays the document out: about 5 ms a frame for 219. Where all
  that changed is positioned out of the flow, only those boxes' old and new
  ink is repainted.

Two costs inside the first class are the subject of this document:

**A transform paints its subtree again every frame.** On the Cocoa backend
the context scales text (`scalesText`), so the subtree is painted through
the context's matrix, and the cost is the paint. On X11 ntk draws a glyph as
it was shaped, upright, where the matrix puts its origin, so a box with
text in it goes through `paintRaster`: a fresh ntk `Surface` the size of
the box's ink, the whole subtree painted into it, one composite through
`SetPictureTransform`, and the surface destroyed in a `finally`. A card
turning for a second pays sixty full rasterizations of its contents, for
pixels that did not change. (So it did; while its transform or opacity
animates, the surface is kept now — §7, step 1a.)

**The frame runs on the JavaScript thread, whatever the platform could
do.** On macOS the frame's claim re-rasters that part of the `<Html>` node's
bitmap, from JavaScript, through the bridge. A document whose script host
is busy, a long layout elsewhere in the app, or a garbage collection pause
stalls every animation on the page, where a CSS animation in a browser runs
on the compositor thread and does not notice.

And one bug in the same class, recorded because the fix below fixes it:
**group opacity is not a group.** `paintBox` multiplies `globalAlpha` into
each thing the element draws rather than compositing the element once at
that alpha, so where two of its own boxes overlap the lower shows through
the upper. The comment at the site says so. CSS Color 4 §3.2 makes the
element a group; so does react-x11's own `Node._paintGroup`, which draws the
subtree once into a retained surface and composites it.

## 2. What the platforms provide

### 2.1 Core Animation, through `@windowkit/appkit`

The bridge's animation vocabulary is complete for this purpose
([README, "Animations"](https://github.com/windowkit/appkit#animations)).
A layer takes a `CABasicAnimation` (`from`, `to`, `duration`), a
`CAKeyframeAnimation` (`values`, `keyTimes`, per-segment `timings`,
`calculationMode`) or a `CASpringAnimation`; every one takes `timing` as a
curve name or cubic-bezier control points, `repeat` up to `Infinity`,
`autoreverse`, `additive`, `delay`, `speed`, `timeOffset`, `hold` and an
`id` that reports `animation-end`. `presentationValue(layer, keyPath)`
reads back what the render server is showing. All of it runs in the render
server: the bridge's own words are that the pump's cadence and a busy JS
thread do not touch it.

### 2.2 How react-x11 uses it

Core's design is `docs/architecture/animation.md` in react-x11, and the
rule it sets is the one this document inherits: **the node model is the
source of truth for what is animating and when it ends; a presenter may
take the pixels.** The seam is `presenter.animate(node, prop, entry)`,
driven from a node's `transition` or `animation` style, and an entry the
presenter declines runs on the window's frame clock as it always did
(`src/nodes/animation.js`, `_offload`).

Two presenters answer it on macOS, and which one is in use matters here:

- **The surface presenter is the default**, one bitmap for the window,
  with **layer promotion** on by default (`src/cocoa/promotion.js`,
  react-x11#483). A node that animates a property a layer can express is
  given a CALayer of its own above the window's bitmap for as long as it
  animates and a second after, and the paint walk leaves a hole where it
  was (`Node._promoted`). Promotion is deliberately narrow: the node must
  be a plain `<box>` with the base paint, nothing painted after it in the
  walk may reach into its bounds, and every clipping ancestor must hold
  the whole of it, because the layer would not be clipped. Declining is
  always safe.
- **The layer presenter** (`cocoa: { presenter: 'layers' }`,
  `src/cocoa/presenter.js`) keeps a CALayer per drawn node, and is opt-in
  while core's measure-first gate is open. A plain box is a PropBox, its
  background, border and radius as layer properties; everything else is a
  Raster visual, its own paint replayed into a bitmap layer, children in
  visuals of their own. **Every registered element is a Raster visual**,
  `<Html>` included. The key paths the presenter animates today are
  `backgroundColor`, `borderColor`, `borderWidth` and `cornerRadius`
  (`ANIMATED_KEY_PATHS`); `opacity` is sent as a layer property.

Core's vocabulary is behind `<Html>`'s. The `animation` style in react-x11
2.26.3 is a loop per property, `from`/`to`/`duration`/`alternate`/`delay`
and one of four named easings; the finite timelines, keyframes, bezier
easing and the six paint-only properties (`opacity`, `translateX`,
`translateY`, `rotate`, `scaleX`, `scaleY`) in animation.md §3 are pending
there as of its 2026-09-06 status. `<Html>` already has every CSS
Animations semantic in `css/timeline.ts`. And `docs/macos.md` names the seam
this document needs and says it is unbuilt: `registerElement({ visual })`,
an element supplying layer-aware visuals in place of its raster.

### 2.3 X11 and Wayland

Nothing. XRender has no timeline and no animation request; a compositor
redirects top-level windows and animates nothing inside one. The Wayland
protocol core speaks has no compositor-side animation either. On both, the
JavaScript frame clock _is_ the platform, and the only gains are cheaper
frames: pixels kept rather than drawn again, composited at an alpha and
through a transform the server applies, with as little of the document
repainted around them as possible.

### 2.4 The GL surfaces

A `<glarea>` is a real child window on X11, above everything 2D in its
window; on the Cocoa backend it is a layer at the top of the stack; on
XQuartz every GL surface composites above the window's content
(`useSupports('glOverlay')` is false there). Its children are drawn into
panes above it (`src/gloverlay.js`), opaque on X11 because a child window
blends with nothing. ntk's direct GLES context renders to dma-bufs and
presents them with DRI3 and Present; the swapchain imports each buffer as a
pixmap with `DRI3.PixmapFromBuffer` (`lib/glswapchain.js`). That import is
the one fact about GL this document uses.

## 3. What is eligible

Only a part of what runs is a candidate for the platform or for a cheap
frame, and it is the same part a browser hands its compositor: **an
animation whose every keyframe sets only `opacity` and `transform`** (with
`translate`, `rotate` and `scale`), on an element that is a stacking
context — which an opacity below 1 or any transform makes it (CSS Color 4
§3.2, CSS Transforms 1 §3). Such an element's pixels are the same on every
frame; only where they are drawn, and how opaque, changes.

Everything else re-rasterizes by definition — a colour on text, a
`text-indent`, a width, a shadow's blur — and stays on the JavaScript clock
on every platform, as it does in a browser. This document changes nothing
about it.

Three more conditions, each checked per element per frame, since a style
change or a scroll can undo any of them:

- **Bounded ink.** The element's subtree ink, with the transform's reach
  over the animation, fits a surface (`RASTER_LIMIT`, `RASTER_SIDE`, and
  the 16.16 fixed-point limit a picture transform is sent in).
- **Its place in the paint order.** A sprite composited after the document
  is right only where nothing painted after the element reaches into its
  bounds: a later sibling, a fixed header, a scrollbar, a parent's outline.
  `<Html>` has its paint order and its stacking contexts, so it can answer
  this where core's promotion cannot see inside it.
- **Its clips.** Every `overflow: hidden`, `clip-path` and `clip` ancestor
  either holds the whole of the element's reach or is applied to the
  sprite's composite. A platform layer cannot take the document's clip.
  It can take a rectangle, though: react-x11's sprites are cut to one
  (react-x11#827, a layer in a box that masks to it), and `<Html>` hands
  over the clips of the boxes around an element as one (`clipFor`). A
  rounded edge or a `clip-path` is not a rectangle, and keeps the
  element in the document where it reaches into it.

`will-change: transform` and `will-change: opacity` are the author's
statement that an element will be animated this way (CSS Will Change 1).
`<Html>` reads the property for what it means to layout and paint — the
stacking context, and the containing block of the absolute or the fixed
boxes, a value of each property it names would make — and an animation
acts as though it named what it sets (Web Animations 1, 5.6). It is no
hint for a sprite. Lifting an element before its animation starts saves
nothing here: the style change that starts the animation makes its part
again, and its layer is painted again with it. And it would hold a layer
for every element a page names, which pages do freely.

## 4. Running eligible animations on Core Animation

Three routes, in the order they could ship.

### 4.1 Compose sprites through core's own elements — no core change

The pattern `<Flow>` uses for node bodies. `<Html>` renders a `<box>`
around its pane and mounts, as absolutely positioned siblings above it, one
`<box>` per eligible element, holding a `<canvas>` whose `onDraw` draws the
element's subtree from a retained surface. The document paints a hole where
the element is. Core's `animation` style on the box drives its `opacity`;
promotion lifts it onto a CALayer; Core Animation runs it, and `<Html>`
schedules no frame.

This works today for a fade, and it is the right spike: it answers on a
real Mac whether promotion holds a sprite over an `<Html>` node before
anything is built on it. It is not the design. Core's loop is `from`/`to`
with four easings, not a keyframe list; transforms wait on core's §3.4
vocabulary; a promoted layer is above every 2D pixel in the window, so the
element must be top-most where it is and unclipped, a test `<Html>` has to
run itself (§3); and every sprite is a React element, so each eligible
animation costs a render and a commit to start and to stop.

### 4.2 A sprite seam in core — the end state

The `registerElement({ visual })` extension `docs/macos.md` names, shaped
by what a document needs. An element answers the presenter with a list of
sprites, each:

- a rectangle in the element's device pixels, and a paint callback the
  presenter rasterizes into the sprite's layer, or a surface it has drawn
  already;
- an `opacity`, a transform and a transform origin;
- its animations as keyframes: the property, `values`, `keyTimes`,
  per-segment `timings`, `delay`, `repeat`, `autoreverse`, `hold`, and an
  `id`.

On the layer presenter the sprites are sublayers of the element's raster
visual, so the document's own clip is theirs. On the surface presenter they
are promoted layers, with promotion's own z-order test asked of the element
rather than of the walk. Either way the element's bitmap leaves a hole, and
`animation-end` comes back to the element, which tells its timeline the
animation is over.

CSS maps onto a `CAKeyframeAnimation` nearly one to one, and the bridge
already has every row:

| CSS                                    | Core Animation                                 |
| -------------------------------------- | ---------------------------------------------- |
| `cubic-bezier(x1, y1, x2, y2)`         | `timing: [x1, y1, x2, y2]`                     |
| `animation-timing-function` on a frame | `timings[i]`, per segment                      |
| `animation-iteration-count`            | `repeat`                                       |
| `animation-direction: alternate`       | `autoreverse`                                  |
| `animation-delay`                      | `delay` (`beginTime`, `fillMode: backwards`)   |
| `animation-fill-mode: forwards`        | `hold`                                         |
| `animation-play-state: paused`         | `speed: 0` and `timeOffset` at the held time   |
| `transform-origin`                     | `anchorPoint`, and the position moved to match |
| the animation ending                   | `animation-end` with its `id`                  |

Two mismatches, each with a clean answer:

- **`steps()`** has no Core Animation curve. `calculationMode: 'discrete'`
  is `steps(n, jump-end)` and nothing else. A stepped animation stays on
  the JavaScript clock, which is where the timeline already runs it.
- **Transform lists.** CSS interpolates a list function by function where
  the lists match, and through matrices taken apart into translation,
  turn, scale and skew where they do not — which is what #584's
  `Primitive` and `css/interpolate.ts` do, and why a full turn turns.
  Core Animation interpolates `CATransform3D` values by its own
  decomposition, which differs for mixed lists, and cannot tell a full
  turn from none. The answer is to **pre-sample**: JavaScript evaluates the
  interpolation it already has at N points over the iteration once, sends
  the matrices as a linear keyframe animation's `values`, and the render
  server plays them. Any interpolation `<Html>` can compute is reproduced
  server-side, at the cost of N sixteen-number values a sprite, once. Sixty
  a second of iteration is more than a display shows.

The seam is a core change and is filed as such (§8). It is not only
`<Html>`'s: a `<vtterm>` cursor blink, a `<Flow>` edge dash and a chart's
tooltip fade are the same shape.

### 4.3 Nothing to offload to, on X11 and Wayland

§2.3. The routes above are macOS-only by the nature of the platforms, which
is the posture `docs/macos.md` and AGENTS.md's "Two backends" already take
for this package: the component runs on both, and says in its page which
backend runs what where. On X11 and Wayland the frame runs in JavaScript,
and §5 is what makes it cheap.

## 5. Transforms that do not re-rasterize

Four options, measured against §1's cost. The first is the fallback every
other needs and is built first whichever is chosen after it.

### 5.1 A retained sprite surface, composited through the matrix

`paintRaster`'s surface becomes a sprite kept per eligible element across
frames, keyed by the element as `Node._groupSurface` is kept per node, and
repainted only when the element's own ink changes — a hover inside it, a
style change, text that re-laid-out. A frame of the animation is then one
`drawImage` through the matrix at `globalAlpha`, which both contexts do
server-side: XRender's `SetPictureTransform` with bilinear filtering, and
`CGContextDrawImage` through the CTM on Cocoa. Hit-testing already maps
through the inverse (`deepestAt`, `nearestText`); the frame's damage is
already the union of the old and new ink; the fixed-point and size limits
stay as they are.

The sprite is painted once at opacity 1 and composited at the element's
opacity, so **group opacity is a group**, and §1's double-blend goes with
no further work. A fade with no transform takes the same path, as
`Node._paintGroup` does.

Two refinements, the second the one that matters:

- **Scale with the sprite.** A sprite rasterized at the element's laid-out
  size and scaled up by a transform is blurred. A transform whose scale
  runs over the animation is rasterized at its largest scale, within the
  limits, and composited down; the pre-sampling §4.2 does gives the range.
- **A retained background.** The sprite's composite is cheap; what is
  expensive is the document under it, repainted through every box the
  damage reaches to fill the rectangle the sprite left. A document with a
  sprite animating keeps a surface of itself without its sprites, clipped
  to the sprites' reach, and a frame is a blit of the exposed part of that
  plus the sprite's composite. That is a two-layer compositor in
  JavaScript, the shape a browser's is, and it is what makes a transform
  cost a composite rather than a paint. Its budget is the shadow cache's
  (`SurfaceCache`, `src/html/surfaces.ts`), and it is dropped when the
  last sprite ends.

### 5.2 Translation without a surface

Most transforms in the wild are translations: a slide-in, an entrance, a
marquee, a drawer. None of them needs a sprite. The subtree is painted
through `ctx.translate`, the fast path animation.md §5 names for core, on
either backend, with the old and new ink claimed. On X11 there is a cheaper
frame still: a translation of an opaque sprite by whole pixels is a copy,
which `scrollContents` with `pinned` rects already does for `<CodeEditor>`'s
caret reveal and `<Flow>`'s pan — one `CopyArea` and the exposed strips
repainted. A marquee on the in-process test server, where compositing is
most of the frame, is the case this is for.

### 5.3 An offscreen GL renderer, composited back

The suggestion the question came with, and the one to assess per platform,
because the answer differs on each.

- **On the Cocoa backend it is strictly worse than a layer.** A `<glarea>`
  is a layer at the top of the stack. Drawing a textured quad through a
  matrix is what a CALayer's `transform` does already, in the render
  server, with no GL context, no swapchain and no JavaScript frame. §4.2 is
  the GL answer on macOS.
- **On XQuartz the same, with no way round it.** Every GL surface
  composites above the window.
- **On X11 with direct rendering there is one coherent design.** The
  sprite is rendered, transformed, into a dma-buf the size of its
  destination rectangle; the buffer is imported as a pixmap with
  `DRI3.PixmapFromBuffer`, as the swapchain imports its frames; the pixmap
  is a `Surface` to the 2D context, and the frame composites it into the
  window with a plain `Composite`, no transform and no readback. The GPU
  resamples instead of XRender's software, which is where a large sprite's
  frame goes on Xorg. This needs an ntk seam, a `Surface` backed by a GL
  framebuffer, and a GL context per `<Html>` with sprites. It helps on a
  Linux desktop with a GPU and nowhere else: not the in-process server the
  suite runs on, not XQuartz, not the Cocoa backend. A variant that reads
  the GL frame back to put it in the window cancels its own gain.
- **Rendering the whole document in GL** is a different project, a text
  renderer and a path rasterizer away, and `<Html>`'s cost is not where it
  would help.

The verdict: a Linux-only rung after §5.1 exists and is measured on real
documents, if XRender's resample is what measures slow. Not the primary
path, and not first.

### 5.4 Core's own transform properties

When react-x11 ships `translateX`, `rotate` and `scaleX` (animation.md §3.4)
and its X11 group path, §4.1's composed sprites can animate transforms as
well as opacity through core, and on X11 core's `Node._paintGroup` and its
translate fast path do the compositing. It is worth having for the spike
and for any component here composed of core boxes. It does not change the
recommendation: a document's sprites are a list the element knows, not
React elements, and the per-sprite render and commit is the cost §4.2
removes.

## 6. What does not change

- **The timeline stays the source of truth.** `css/timeline.ts` says what
  is animating, at what progress and when it ends, on every platform. A
  presenter that takes a sprite takes its pixels, and reports the end; it
  never decides whether an animation runs. That is core's rule (§2.2) and
  it holds here.
- **Every sprite has the JavaScript frame as its fallback.** A presenter
  that declines, a sprite that stops being eligible mid-animation (an
  element scrolled under a fixed header, a later sibling that moved over
  it, a hover that changed its text), a platform with nothing to offload
  to: the timeline's next frame restyles and repaints as #584 does today.
  No animation is ever lost to the optimisation, which is what lets the
  eligibility test be strict.
- **Hit-testing, selection and accessibility stay in layout space**, as
  they are for transforms today. A sprite changes pixels and nothing else.
- **`animate={false}`** is unchanged: no timeline, no sprites, the
  at-rest drawing the Zen Garden bench holds Chrome with.

## 7. Recommendation and sequencing

In order, each step useful on its own and measured before the next:

1. **§5.1, the retained sprite** with group opacity, both backends, keyed
   per element, with `test/html/animations.test.ts`'s pixel checks holding
   a frame drawn from a sprite to a frame drawn whole. Then the retained
   background. Measure a turning card and a fading panel on the in-process
   server and on Cocoa, frame time before and after.

   **1a, built: the kept surface.** Where it was cheapest to prove, first:
   the surface X11 already draws a turned box with text in it on
   (`paintRaster`), kept from frame to frame while the box's transform or
   opacity animates (`SpriteStore`, `src/html/surfaces.ts`) and drawn at
   the box's opacity, so that box is faded as a group. What it holds is
   painted at opacity 1; the key is the fraction of a pixel its corner
   falls on, the scale and the selection's part in its text. A build
   clears the store, and so does a layout at another width or under
   another viewport; a restyle in place drops a surface when a box in it
   draws something else, and keeps it when only the box's own transform,
   opacity or `z-index` changed. Every frame is held to a build, and to a
   surface made for that paint alone. A frame on the in-process server,
   six interleaved runs: a turning card 17.3 → 10.1 ms, a growing one
   13.9 → 6.2 ms, a fade 8.5 and a slide 7.6, unchanged. Not measured on
   Xorg. The macOS and Windows contexts draw such a box through the matrix
   every frame, as before.

   **1b, built: group opacity, on the contexts where a group pays.** An
   element under full opacity that draws two things that can overlap is
   painted on a surface and faded as it is drawn (`paintGroup`), and one
   drawn through a matrix by the context itself onto a surface where it
   lands (`paintGroupThrough`); one that draws a single thing is faded as
   before, which is exact. A fading element keeps its group, so a frame of
   a fade is a composite: 8.0 → 3.8 ms on the in-process server. A still
   surface up to 128k pixels is kept as well, a turned one among them:
   a repaint of 24 turned cards 40.3 → 30.0 ms. Being right costs the
   composite: 24 faded cards 13.9 → 18.0 ms. A box fixed to the viewport
   inside a faded element is drawn past the ink a surface would be cut to,
   and fades each thing. **macOS measured the other way**: the native
   context draws a surface through a `CGImage` of its bitmap at about
   12 ns a pixel, and a card's group cost 2 ms at 2x where its fills and
   glyphs cost 0.3 — a fade's frame 1.7 → 3.4 ms, 24 faded cards 7.0 →
   11.3. So the native contexts (`scalesText`) fade each thing as before,
   until one says a faded surface is cheap.

   **1b on macOS.** The cost was not the image path but its alpha:
   CoreGraphics draws an image under any alpha below 1 at some fifteen
   times its cost at 1, and its transparency layers composite the same
   way, so a native layer would not have helped (react-x11#810, with the
   standalone benchmark). Scaling the surface's premultiplied pixels by
   the alpha and drawing them at 1 is a fifth of the cost:
   `ctxDrawSurfaceFaded` in @windowkit/appkit (windowkit/appkit#94), sent
   by react-x11's `drawImage` under an alpha and announced as the context's
   `fadesSurfacesCheaply` (react-x11#812). `<Html>` hands a group to a
   native context that says so. On macOS over both, grouped against faded
   a thing at a time on the same build: 24 faded cards 3.7–5.5 → 2.4–4.4
   ms, a fade's frame 0.65–1.2 → 0.39–0.73. Windows, unmeasured, fades
   each thing.

   **1c, measured and deferred: the retained background.** It would keep
   the document under a moving sprite, so a frame stops painting it again.
   That is only worth a two-layer compositor where the painting under the
   sprite is what a frame costs, and it was not. On the in-process server,
   with 1a's kept surface, a card turning over sixty paragraphs of text
   cost a frame what it cost turning over an empty page — 11.5–15 ms
   against 11.7–14.4, under a load that widened both — and a profile of
   the frame put 35% of it in the server's XRender, the kept surface
   resampled through its turn in JavaScript, and under 2% in `<Html>`. A
   real X server resamples in C or on the GPU. So 1c waits for a document
   whose frames show the painting under a sprite is their cost, and the
   next step is the one no faster X server gives: §4.1's spike, towards no
   JavaScript frame at all on macOS (step 4, below).

2. **§5.2, translation without a surface**, and the `scrollContents` copy
   for a whole-pixel translation of an opaque sprite on X11.
3. **`will-change`** parsed as the eligibility hint, and the eligibility
   test of §3 written once, in the paint order's terms, for every route to
   share.

   **Built, but for the hint**, which §3 says why. Naming a property makes
   what a value of it would on the boxes it applies to: WPT's
   `css-will-change` reftests went from 7 of 42 passing to all 42, and
   `css-contain` gained the one that names it. An animation acts as though
   it named what it sets, from its delay to its end, or for good where it
   fills forwards, as Chrome 152 has it — so a fade is one stacking
   context at every frame, where it changed its place in the paint order
   each time its opacity reached 1. That makes an element whose animation
   a layer can carry one of its context's layers on every frame, and the
   test is in the order `paintContent` paints in (`paintedAfter`): the
   layers after it in its context's list, the context's outline, and the
   same up to the root. What is painted before it is under its layer as it
   is under it, where the test had been that no ink but its own and its
   ancestors' was within its reach. A box fixed to the viewport is asked
   about every frame, where the scroll has it. On a real Mac, a toast
   fading over text and a block rising over the paragraph after it went
   from 117 window frames and 117 paints of the document in two seconds,
   neither lifted, to none. The other route that will need the test is
   step 2's copy, and it is a function of `paint.ts` for that.

4. **§4.1 as a spike**, a fade only, to confirm on a real Mac that
   promotion holds a sprite above an `<Html>` node, before the seam is
   designed against it.

   **Done, and half of it holds.** A `<box>` mounted after an `<Html>`
   node, a `<canvas>` in it drawing the sprite, is promoted onto a layer
   of its own over the page — with a background colour looping on it,
   two seconds of the loop cost no window frame, no paint of `<Html>` and
   no draw of the canvas: the render server runs it. A fade does not:
   promotion declines a box whose opacity is below 1 or animating
   (`fadesAsGroup`, react-x11's `src/cocoa/promotion.js`), because the
   bitmap fades such a box and all it holds as one group
   (`NodePaint._paintGroup`) and the layer would fade them one over the
   other, while the frame clock goes on owning the opacity. The fading
   sprite ran on the clock at 75 frames a second, and each frame painted
   the `<Html>` under it again and drew the canvas again. So the seam of
   step 5 has to carry opacity as a group — a layer whose sublayers
   composite with it as one, which Core Animation has as
   `allowsGroupOpacity` — and hand the opacity loop to the render server,
   and promotion's own fade is the same change.

   **Which react-x11 2.28.0 made** (react-x11#817, #818). A layer under an
   opacity below 1 composites with its sublayers as one by default on
   macOS — `allowsGroupOpacity` read back off a promoted layer is 1 — so
   promotion takes a fade, and refuses a box inside a fading one instead.
   The fading sprite over `<Html>` went from 150 window frames, 150 paints
   of `<Html>` and 150 draws of the canvas in two seconds to none of any.

5. **§4.2, the sprite seam in core**, with pre-sampled transform
   keyframes, `<Html>` as its first consumer. Zero JavaScript frames for an
   eligible animation on macOS is the gate: the presenter bench's
   frames-per-120 ms row, 0 against 8.

   **Built, three halves.**
   - **Core** (react-x11#819) asks a drawn element every frame for the
     parts of its drawing it may lift, `sprites()`, and lifts each under
     promotion's rules onto a layer of its own, at everywhere the part can
     be over its animations. The element hears which are lifted before the
     frame paints, `spritesLifted`, and when the render server has run one
     to its end.
   - **The bridge** (windowkit/appkit#97) takes a transform as CSS's matrix,
     and a negative delay as a begin time in the past: a `timeOffset` would
     wrap a one-shot animation joined half way round to its start before
     its end.
   - **`<Html>`** offers each element whose animations set only opacity
     and the transform properties, one animation a property, in a box of its own, inside nothing that
     fades, turns, clips or animates, with no ink but its own and its
     ancestors' within reach while it runs (`src/html/sprites.ts`). Its
     frames are sampled, opacity as well as transform, so every easing and
     every interpolation `<Html>` has comes out as it draws it. A lifted
     element is a hole in the paint and no frame of the document's clock,
     and one given back is restyled where its animation has got to.

   A CSS fade and a CSS turn on a page went from 113 window frames and 113
   paints of the document in two seconds to none. The gate is met on a
   real window, and on the released builds the pixels are the document's:
   a quarter turn turns clockwise about the box's centre, and a layer at
   half opacity reads half-faded.

   **Transitions too.** They run on the document's timeline
   (`AnimationTimeline.transition`), and one of the opacity or the
   transform is the same sprite as an animation of it: one iteration
   sampled from its start to its end, offered in its delay as well, since
   the bridge fills a delayed animation backwards. One turned back is a
   new animation on the layer from where the old one had come to, and the
   restyle that turns it is in place. A card that fades and lifts over
   700 ms under the pointer went from 40–43 window frames and as many
   paints of the document, each way, to 4–6 frames and 3 or 4 paints: the
   change that starts it, and the one that hands it back.

   **And what is fixed to the viewport.** A toast, a banner or a modal
   fixed to the viewport, or something in one, goes on a layer placed from
   the viewport's corner, which stays there as the pane scrolls the
   document under it. What is painted after it is asked about over the
   whole document, since a scroll can take it anywhere over that, and what
   is fixed after it where it is. A fading toast in a scrolling pane went
   from 116–118 window frames in two seconds, still or scrolled, to none.

   **And what a rounded box cuts.** A layer's box takes round corners
   (react-x11#838's `clipRadius`), so an element that reaches a rounded
   clipping box's corners is lifted with its layer cut by them, where it
   had to keep clear of them: one circle's radius at all four corners, and
   no other clip cutting the rounded one again. A shimmer sliding through a
   card with a radius went from 117 window frames and 104 paints of the
   document in two seconds to none.

6. **§5.3's Linux rung** only if step 1's measurements on Xorg say the
   resample is the cost.

## 8. Upstream

Four things to file, each in the repository it belongs to — the first three
before step 5:

- **react-x11: the sprite visual seam** (§4.2) — filed as react-x11#819
  and built as an element method the presenter asks per frame,
  `sprites()`, for promotion; the layer presenter declines for now. What
  step 4's spike asked of it first, an opacity composited as a group and run
  by the render server, is react-x11#817/#818, in 2.28.0.
- **react-x11: §3.4's vocabulary**, which is on its roadmap already;
  §4.1 and §5.4 wait on it. No new request, a dependency to note.
- **ntk: a `Surface` backed by a GL framebuffer** (§5.3), a dma-buf the 2D
  context composites as a pixmap, over the import `glswapchain.js` already
  does. Filed when and if step 6 is reached, with step 1's numbers.
- **react-x11: a faded surface as cheap as an opaque one on macOS** —
  filed as react-x11#810. A native layer (`beginLayer`/`endLayer` over
  `CGContextBeginTransparencyLayer`) was the first idea and measured no
  better: CoreGraphics composites a layer under an alpha as slowly as an
  image. The fix is windowkit/appkit#94's `ctxDrawSurfaceFaded` and
  react-x11#812's `drawImage` and `fadesSurfacesCheaply`, which core's own
  `<box>` opacity (`_paintGroup`) takes as it is. Windows is unmeasured:
  Direct2D draws a bitmap with an opacity on the GPU, and the capability
  stays off there until someone measures it.

## 9. Open questions

- **How many sprites is too many.** A page of a hundred spinners is a
  hundred layers on macOS and a hundred surfaces on X11. Promotion's
  per-raster `MAX_DIRTY_RECTS` and the shadow cache's pixel budget are the
  precedents; the number is measured, not chosen.
- **Pre-sampling density** (§4.2). Sixty values an iteration is the
  starting point; an iteration of ten seconds at sixty a second is six
  hundred matrices, and a keyframe animation that long may deserve a
  coarser list with the bridge's `cubic` calculation mode.
- **A sprite under a scrolling document.** The sprite's rectangle is made
  each frame from where the document is, so a layer moves with a scroll,
  and what a scroll changes about what may cover it — a box fixed to the
  viewport — is asked each frame (step 3). Whether a long scroll should
  demote it instead and promote it again when the page settles, the way
  hover is held (`hoverClock`), is not measured.
