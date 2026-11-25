# A page's canvas on the GPU (draft)

Status: **draft, not built.** Follows [the native-canvas spike](prd-native-canvas.md),
which replays a page's 2D canvas on CoreGraphics. This asks what is left
after that, and whether the GPU is the way to take it.

## Where the spike left wland (Cocoa rig, 10 s, idle)

|                                            | page fps (its own counter) | main thread busy |
| ------------------------------------------ | -------------------------: | ---------------: |
| before this work                           |                        1–3 |                  |
| JS canvas, with the drag-props fix (#1976) |                        ~12 |            ~100% |
| native canvas + diff + clip fixes          |                        ~44 |             ~96% |
| Chrome                                     |                        ~70 |                  |

What the spike found, in the order it mattered:

1. **Every `<Html>` render repainted its whole root** (#1976): core repaints
   an element whose non-event prop is a new object, and the document's
   drag props were. Not a canvas problem, and 4× on its own.
2. **`drawImage` of one native canvas onto another read the source's pixels
   back into the realm** to ask its size: ~1.2 s of every 10.
3. **Clipped draws cost 13× unclipped** (CoreGraphics makes a mask of any
   clip that is not a rectangle): a clip a draw cannot reach is not
   applied.
4. **wland clears and redraws each window every frame.** Hashing the
   commands that touch each 64-pixel tile, frame against frame, finds the
   30–70% that did not change: those tiles are not drawn, and the document
   repaints only the box around the rest.

## What is still on the main thread (per 10 s, 1,170 paints)

|                                            |    s |                                                             |
| ------------------------------------------ | ---: | ----------------------------------------------------------- |
| `getImageData` the page asks for           | ~2.6 | 1.3 GB of pixels a run, crossing the bridge as base64       |
| replaying the page's draws                 | ~2.4 | CoreGraphics rasterizing on the CPU                         |
| the document painting canvases and shadows | ~2.7 | `drawImage` of surfaces onto the window, drop-shadow groups |
| the page's own JavaScript and the facade   | ~1.5 |                                                             |

An upper bound for the readback: skipping the native read altogether (the
bytes still crossing as zeros) buys 4%. The transfer (base64, a shared
buffer) is next to it, not the whole of it. The page asks for these pixels
so as to convert them in JavaScript; they have to reach it.

## Options

**A. Same CPU rasterizer, no copy to the screen.** Replay into a surface the
window server can show as a layer (an `IOSurface` bitmap on a `CALayer`),
as core already does for `<video>` and for promoted sprites. The document
stops compositing the canvas pixels itself (the ~1 s of `drawImage` and
what the drop-shadow groups copy around it), and a window of wland becomes
a layer the render server moves. The rasterizing (~2.4 s) stays.
Needs: a bridge verb to put a `Surface`'s pixels on a layer
(@windowkit/appkit), and `<Html>` to leave a hole for it in its paint, as
it does for a lifted sprite.

**B. A GPU 2D renderer.** Skia over Metal (`skia-canvas` is a Rust/Skia
Node addon with a Metal path and the whole Canvas2D surface, including the
gradient, clip, text and compositing operators this spike does not do),
drawing to an `IOSurface`-backed texture that option A shows. It takes the
replay to well under a millisecond a frame, and gives the operators
CoreGraphics cannot (`copy`, `source-in` past the draw). What it costs: a
native dependency (optional, as `node-pty` is), a second text engine to
agree with, and **readback**: a GPU `getImageData` is a pipeline stall each
call, and wland makes ~100 of them a second. Chrome copes by moving a
canvas to the CPU once it is read often (`willReadFrequently`); the same
heuristic fits here (a canvas that is read more than N times a second
stays on the CPU rasterizer), which makes B an addition to the spike's
host and not a replacement for it.

**C. Canvas drawn in the page process's own GL** (`<glarea>`): rejected.
It needs a GL context per canvas on a thread that is not the app's, the
text engine is again the problem, and macOS GL is deprecated.

## Recommendation

Do **A** first. It is a protocol change in two places that already have
precedents (video frames, sprites), it removes the per-paint copy of every
canvas, it keeps one rasterizer to agree with, and it is the half of B that
any GPU renderer needs anyway. Then measure: if the replay is still the
largest cost on a real page, B with the read-often fallback.

The main thread's remaining readback is the other lever, and is not
GPU-shaped: a shared buffer between the page's realm and the host in place
of base64 (the realm makes a `SharedArrayBuffer`, the host views it), worth
perhaps a second of ten. It touches the engine's isolation rules, so it
wants its own review.

## Out of scope here

Workers (`OffscreenCanvas` off the page's thread), WebGL canvases, SVG
into a canvas, and the mock and X11 backends, which keep the JS rasterizer.

## Option A, built (react-x11 3.1.0's `LayerSurface`)

react-x11 3.1.0 added `createLayerSurface` (sidorares/react-x11#1059): a ring of
IOSurface-backed bitmaps a sprite part shows as it is. The spike now replays a
canvas into one (`NativeCanvas.layer`) and `<Html>` offers it as a part with
that surface as its `contents` (`canvasLayer`, `_layeredBoxes`, `canvasLiftOf`),
a hole in its own paint, and a `drop-shadow()`-only filter above it no reason to
keep it off a layer (the document draws the shadow from the silhouette, which a
group read still draws the canvas for).

Measured on the Cocoa rig, 5 s of the document's paints:

|                                             | paints | page's own fps |
| ------------------------------------------- | -----: | -------------: |
| a canvas on a plain page, no layer          |    271 |                |
| the same, on a layer                        |      0 |                |
| wland, native replay, no layer              |    628 |             44 |
| wland, all four canvases forced onto layers |     10 |             47 |
| wland, as the ordering rules allow it       |    384 |             41 |

Findings:

1. The mechanism works and the document stops painting a canvas that moves.
2. wland gains little in frames a second (44 to 47): after the tile diff, the
   document's composite was not what bound it. What is left is the replay, the
   `getImageData` readback and the page's own JavaScript, which is option B and
   the shared-buffer readback.
3. wland's windows are not lifted as things stand. Each is under a
   `drop-shadow` filter, and a later window's shadow is drawn by the document
   over an earlier window, which a layer for that window would then cover: the
   presenter turns it down. Lifting them means giving the shadows a layer too
   (a `shadows` part for an opaque rounded silhouette, listed before its canvas).
4. Only a canvas in a stacking context's layer list can be lifted
   (`paintOrderOf`); a canvas in normal flow has no place in the order yet.

## Option B, measured and not built

wland's real canvas commands (4,988 batches, 1.7 GB, captured from the spike's
host) replayed through the same `NativeCanvas` code on three 2d contexts, the
first 3,000 batches, with every cost but the context's the same (JSON, the
tile diff, the draw states):

|                                        | ms per batch |
| -------------------------------------- | -----------: |
| CoreGraphics (what the spike uses)     |         1.30 |
| skia-canvas 4.0.1, CPU raster          |         0.77 |
| skia-canvas, Metal, draws queued       |         0.77 |
| skia-canvas, Metal, a readback a batch |         2.71 |

1. Replacing CoreGraphics saves 0.5 ms a batch at best, about 40% of a replay
   that is itself no longer the largest cost: the rest of the 0.77 is the host's
   own JavaScript, which no context changes.
2. A GPU canvas's pixels have to come back to the CPU for the page's
   `getImageData`, and one readback costs more than the whole CoreGraphics
   replay. wland makes ~100 a second, so the read-often fallback would put it
   on the CPU rasterizer anyway.
3. It would add a native dependency and a second text engine to agree with.

So B is not worth building for this page. What is left that is worth doing is
not GPU-shaped: the readback itself (a buffer the page's realm and the host
share, in place of base64), and the page's own JavaScript.

## The readback, measured and not built

A profile of wland on the spike (10 s, 766 document paints) puts the whole
`getImageData` path at about 0.6 s: the native read 0.26 s, and base64 encoding
and decoding 0.27 s between the host and the realm. A buffer the two share would
save the second, some 3% of the main thread, and it is the one change here that
touches the realm's isolation: the buffer would be a host object in the page's
context (the host's `Function` is its `constructor.constructor`), made safe only
by moving its prototype into the context before any page code runs. Not worth
the risk for 3%.

What the same profile shows is CoreGraphics itself: the page's replayed fills,
strokes, image copies and text come to ~2.4 s of native time, and the document's
own `drawImage` of canvases ~1 s. Fewer or cheaper draws, not a different path
for pixels, is what is left.
