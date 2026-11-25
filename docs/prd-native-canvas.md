# A page's canvas on the native context (draft)

Status: **experimental, behind `REACT_X11_NATIVE_CANVAS=1` on the Cocoa
backend, off otherwise.** What shipped is the spike's shape with a
per-canvas fallback: the realm records a canvas's draws, the host replays
them on a `Surface` (a `LayerSurface` where react-x11 3.1 has one, shown
on a layer with no copy), and a canvas that draws something the host's
context does differently — a shadow, a pattern, `copy`, `source-in`,
`source-out`, `destination-in`, `destination-atop` — reads its pixels once
and goes on in the realm for good (`nativeBail`). A synchronous readback
needs react-x11's `readPixels` (sidorares/react-x11#1061). Known limits: a
canvas that goes back before the host has drawn anything (before the first
paint) has lost what it had drawn; canvases in workers stay JS; patterns,
shadows and text decoration are the realm's. The numbers it was built for
are in [the GPU note](prd-native-canvas-gpu.md). The question it answers: a page's `<canvas>`
is rasterized in JavaScript inside the page's realm (`scripts/raster.ts`).
The Cocoa backend has a native 2D context over CoreGraphics. Can the first
run on the second, as an experiment that changes nothing for anyone who does
not turn it on?

## What is already native, and what is not

`<Html>`'s own painting (boxes, borders, text, images, gradients, filters,
shadows, inline `<svg>` through `SvgView`) goes through the host's context,
which on macOS is CoreGraphics over a CPU bitmap. That is the part the Cocoa
backend accelerates, and it is why a document scrolls well there.

A page's `<canvas>` is a different path, on purpose:

- Its bitmap is **the realm's** (`CanvasState` in `dom.ts`), straight RGBA in
  a `Uint8ClampedArray`, so that `getImageData` reads back what was drawn at
  once and byte for byte. The realm is a `node:vm` context and cannot hold a
  host object; only primitives cross the bridge.
- Every `fill`, `stroke`, `drawImage` and `clip` is rasterized by
  `raster.ts` into that array, and what changed is base64-encoded once a task
  (`flushCanvases`), sent across (`canvasPut`), decoded, and drawn by
  `<Html>` as an image (`canvasImage`).

So a canvas-heavy page pays twice: JavaScript loops for the pixels, then a
copy and a base64 round trip to get them on screen. Rounds one and two of
the wland work made the JS cheaper; this removes it.

## What a frame of wland asks of it

Counted with a temporary wrapper on the context's methods (not committed),
on the Cocoa rig, at idle, about 3,000 calls per batch:

| call                             |     per 3,000 |
| -------------------------------- | ------------: |
| `lineTo` / `moveTo`              | ~1,100 / ~300 |
| `fillRect`                       |      ~400–750 |
| `stroke` / `fill`                |    ~300 / ~90 |
| `fillText` / `measureText`       |     ~60 / ~50 |
| `getImageData` / `putImageData`  |     ~15 / ~10 |
| `drawImage`, `clip`, `roundRect` |     3–40 each |

Two things follow. The call rate is modest (a few thousand a second), so
**a command stream to the host is cheap**; the cost is the area each call
covers, which is what a native rasterizer is good at. And the page reads
pixels back about once a frame, so **readbacks are a feature to design
for, not a corner case**.

## Design

**The realm keeps the state machine; the host keeps the pixels.** All the
spec behaviour that conformance tests hold us to (the `save`/`restore`
stack, transforms, style parsing, path building, argument checks, errors,
`isPointInPath`, `measureText`) stays in `dom.ts`. Only the rasterization
seam changes: `_fillPath`, `_strokePath`, `fillRect`, `clearRect`,
`drawImage`, `_drawText` and the clip, which today write into `state.data`,
would append to a per-canvas command list instead.

- **Opt-in and per canvas.** `scripts.canvas2d: 'native'` (and an env var
  for the rig). Default stays `'js'`. A canvas is native only when the host
  hands a `NativeCanvases` seam in (as `webgl` is), which the mock backend
  never does, so every existing test runs unchanged.
- **The host object.** `open({ width, height })` makes a
  `new Surface(app, …)` and its `getContext('2d')`
  (`BackendContext2D` over `ctxFillPath` etc.). `run(commands)` replays
  them; `read(x, y, w, h)` answers straight RGBA; `resize` and `dispose`.
- **The wire.** One JSON string a flush. Paths cross as the numeric command
  arrays `PathData.cmds` already is. Gradients, patterns and images are
  registered once and named by id; a `drawImage` of another native canvas is
  a surface-to-surface draw on the host with no pixels crossing.
- **Sync points** flush the list and read: `getImageData`, `toDataURL`,
  `toBlob`, `createImageBitmap`, a `drawImage` of a canvas whose pixels the
  realm holds, and anything that wants `state.data`. The realm mirror is
  filled lazily, and only the requested rectangle.
- **Display with no copy.** `canvasImage(element)` hands `<Html>` the host
  surface itself, and the document composites it with `drawImage(surface)`.
  `flushCanvases`, the base64 and `canvasPut` leave the picture for a native
  canvas. This is probably as large a win as the rasterizer.
- **Per-canvas fallback to JS.** If an operation cannot be done natively,
  the canvas reads its pixels back once into `state.data` and continues in
  `raster.ts`, for good. Both back ends implement the same state, so the
  switch is one readback. That bounds the risk of every difference below.
- **SVG.** Nothing new on the realm side: an SVG image drawn into a native
  canvas is `SvgView` on the host context, which is what `<Html>` already
  does for inline drawings. Today it is rasterized for the realm. Phase 3.

## Known differences from the JS path (why it is opt-in)

1. **Compositing past the draw.** On the Cocoa context an operator applies
   inside what the draw covers; a browser's `copy`, `source-in` and friends
   clear everything the draw missed (react-x11's own note on
   `globalCompositeOperation`). The existing "an operator that reaches past
   `drawImage`'s rectangle clears what it leaves" case would need the
   fallback, or a full-canvas clip-and-fill emulation.
2. **Premultiplied storage.** A CG bitmap is premultiplied, so a
   `putImageData`/`getImageData` round trip at low alpha loses bits that the
   straight-RGBA realm array keeps. Spec-legal, but page code and WPT can
   see it. A canvas that uses `putImageData` heavily may be better left JS.
3. **Anti-aliasing is CoreGraphics's**, not ours. Pixel-exact canvas tests
   will differ at edges; the experiment compares counts and tolerances, not
   bytes.
4. **Synchronous readback is not public.** `ctx.getImageData` here is
   callback or promise shaped, delivered a tick later; the realm needs the
   bytes now. Underneath it is `ctxGetImageData`, a plain memcpy. To avoid
   reaching into core's `_native`, **file a react-x11 request for a
   synchronous `readPixels(x, y, w, h)`** on the context before phase 1.
5. **Threads.** A `Surface` lives where the app does. Canvases in workers
   (`OffscreenCanvas` off the page's thread) stay JS until a relay exists.
6. **No path API on the mock backend**: native is simply unavailable there.

## Plan, with go/no-go

0. **Spike, a day.** Route `fillRect`, `fill`, `stroke`, `clip`, `drawImage`
   and `fillText` for one canvas through a Surface, no fallback, no tests.
   Measure wland on the Cocoa rig (paints per 6 s, CPU per paint; baseline
   about 70 paints and 105–125 ms). **Go if paints per 6 s at least double.**
1. **Command stream, sync points, fallback**, behind the flag. Parametrize
   `test/html/canvas-2d.test.ts` to run both ways, with a stated tolerance
   for edge pixels; run WPT `html/canvas` and `2dcontext` on both and
   record the delta, so the flag's cost to conformance is a number.
2. **Zero-copy display.** `canvasImage` hands the surface over.
3. **SVG into native canvases; OffscreenCanvas on the main thread.**
4. Only then ask whether it should be the default on Cocoa.

## Is it additive?

Mostly. New files: a realm-side command recorder (source text, like
`raster.ts`) and a host-side `native-canvas.ts` with the seam on
`HtmlScripts`. Existing files change at a handful of places (the paint
sites in `dom.ts`, the flush, the readbacks, `canvasImage`), each gated on
`state.native`; with the flag off the code path is the one that ships
today. Nothing in `src/html/css/` or the layout is touched.
