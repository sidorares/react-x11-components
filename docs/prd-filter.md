# `filter` in `<Html>`

`filter` (CSS Filter Effects 1) on a document's elements: what `<Html>`
draws of it today, how, what that costs, and the seam core would need to
draw the rest — and the colour functions without a round trip.

The page that asked for it was ekazinich.com, whose hero screenshots are
`filter: grayscale()` until their card is hovered, and `grayscale(0)` through
a `.5s` transition after. `<Html>` dropped the declaration and drew them in
colour.

## What is drawn

| Function                                               | Drawn                                         |
| ------------------------------------------------------ | --------------------------------------------- |
| `grayscale()`, `sepia()`, `saturate()`, `hue-rotate()` | the spec's matrices (Filter Effects 1, 13)    |
| `invert()`, `brightness()`, `contrast()`               | `feComponentTransfer`'s `linear`, as a matrix |
| `opacity()`                                            | multiplied into the box's opacity             |
| `blur()`, `drop-shadow()`                              | read and interpolated, not drawn yet          |
| `url()`                                                | the whole list ignored (Filter Effects 1, 4)  |

Every list, drawn or not, makes the box a stacking context and the
containing block of the absolute and the fixed boxes in it, an inline box
as well (Filter Effects 1, 2). Lists interpolate function by function, a
shorter one and `none` filled out with functions at their initial value
for interpolation (10.4), so a transition of `filter` runs.

`opacity()` comes out of the matrices because scaling alpha commutes with
every other colour function, each of which leaves alpha alone: it is the
group opacity the box already has.

## How: through the context's filter, or a read back

The box's group is painted unfiltered on a surface kept for the element
(`src/html/filters.ts`). Where the paint's context runs a filter itself —
react-x11's native context, from sidorares/react-x11#866, takes the colour
functions as canvas's `filter` — the group is drawn through it onto a
second kept surface in the paint that draws the box, and drawn through
again only as the group or the filter changes (`through`). A context is
asked whether it has a `filter` with `in` before anything is assigned,
because an assignment to an unknown property sticks on any object; and a
list that does not stick on it sends every box to the read from then on.

Everywhere else no context runs a filter, and none hands a surface's
pixels over as it is asked. ntk's surfaces are X pixmaps, a round trip
away. The native contexts before #866 read synchronously inside and
resolve `getImageData` a tick later, keeping the canvas contract. So
`paintFiltered` reads the group back and keeps what it read. Every paint
runs the matrices the box has now over the newest pixels read for it and
draws the result through the box's matrix and at its opacity.

What the box draws changing makes the read stale, through the same hook
that drops the surfaces kept for boxes (`_dropSprites`). The next paint asks
for another read and draws from the stale one until it arrives. So a
round trip of lag falls on the box's content, never on the filter. A hover
transition draws each frame at the amount it has then. The two bugs this
shape came out of are in `AGENTS.md`: ekazinich.com's hover flashed between
grey and colour, then between colour and blank.

### What it costs

Measured on the browser example over ekazinich.com, on a 2x Mac, from a
read back:

- A paint during the hover takes 4–10 ms, with a few around 25 ms where a
  read lands and its box is painted again.
- While a filtered box moves, every frame paints its group a second time
  for the read, and each read that differs repaints the box once more.
- The first time a box is drawn, it is drawn a round trip late, as an image
  arriving is.

Through the context's `filter`, the same frames cost about the same: the
pixel pass is #866's, in JavaScript, about 5.5 ms a frame for the hero
card's 840 by 427 device pixels. What goes is the lag, the read and the
second paint of the group.

## The core seam: `ctx.filter`

Canvas's own property: a `<filter-value-list>` the context applies to what
it draws, `'none'` by default. As with `globalCompositeOperation` and
`imageSmoothingQuality`, **a value a context cannot apply does not stick**
and reads back as the one before. A context that keeps it applies it to
every `drawImage`, surfaces included. A filter applied to some sources and
not others would be worse than none: a box drawn half filtered, with no
error.

`<Html>` asks its surfaces' contexts, as above. Where the value sticks, it
draws the group through it: synchronous, with no read. Elsewhere it keeps
the read. The rungs, by backend:

### macOS: `BackendContext2D` and @windowkit/appkit

1. **In core, over today's bridge** — sidorares/react-x11#866, which every
   drawing call honours: a fill, a stroke, a gradient, a glyph run and a
   symbol through their colours, and a layout in colours of its own through
   its pixels, as an image is. `drawImage` under a colour filter reads
   the source surface with `ctxGetImageData`, which is synchronous inside.
   It runs the matrices in JavaScript, puts the pixels on a scratch surface
   with `ctxPutImageData`, and draws that. That makes the filter
   synchronous on macOS at the cost of a pass per draw. It needs no bridge
   release, and the filter sticks from the first version that has it.
2. **A bridge verb**, `ctxDrawSurfaceFiltered(ctx, src, sx, sy, sw, sh, dx,
dy, dw, dh, alpha, matrix)`, feature-detected as `ctxDrawSurfaceFaded`
   is. It would use vImage: unpremultiply, `vImageMatrixMultiply_ARGB8888`,
   premultiply. Core Image's `CIColorMatrix` is the alternative. Either
   takes the per-pixel pass off the JavaScript thread.
3. **A filter track on a sprite.** `CALayer.filters` with a `CIColorMatrix`
   (`layerUsesCoreImageFilters` on the view), whose input vectors Core
   Animation animates by key path. A filtered element could then be lifted,
   and its hover transition would run in the render server, painting
   nothing, as an opacity transition does since react-x11#819. Until then
   `liftableBox` refuses a filtered box and anything in one.

### Wayland: the GLES context

A colour matrix uniform in the texture mode's fragment shader. The
filtered draw is one more batch, on the GPU.

### Windows: @windowkit/win32

Direct2D's `CLSID_D2D1ColorMatrix` effect on an `ID2D1DeviceContext`, or a
CPU pass through the bridge's pixel read, as macOS's first rung.

### X11: ntk

XRender has no colour matrix. A pixmap cannot be read inside a paint,
because the reply comes back on the socket after it. So `filter` with a
colour function does not stick on ntk's context, and `<Html>` keeps the
read back there.

Two things ntk could do, recorded so they are not rediscovered:

- The colour functions other than `opacity()` are linear maps of
  premultiplied colour that leave alpha alone, so they commute with
  source-over. Filtering each colour drawn (a fill, a stroke, a gradient's
  stops, a text run's colour) and each `Image`'s client-side pixels gives
  the filtered group exactly, without the group. A `Surface` drawn under
  the filter is the one thing this cannot reach, and `<Html>` draws its
  masks, its kept sprites and its SVG rasters as surfaces.
- `blur()` and `drop-shadow()` **can** be synchronous on X11. ntk already
  blurs a shadow's coverage on the server, in two XRender convolution
  passes (`lib/shadow.js`), and the same passes over an argb picture are a
  `blur()`. A `drop-shadow()` is the surface's alpha as coverage, blurred,
  offset and drawn in a colour. So ntk's `filter` could stick for
  `blur()` and `drop-shadow()` before it ever does for a matrix.

## Next

- The vImage verb, macOS's second rung, which takes the pixel pass off the
  JavaScript thread.
- `blur()` and `drop-shadow()`, which need the seam more than the colour
  functions did. A blur in JavaScript over a read back is a convolution
  per frame on the main thread, and the ink a blur or a shadow adds past
  the box has to reach `computePaintBounds` and the damage. ntk's
  convolution, Core Image's or vImage's gaussian, two shader passes on
  Wayland.
