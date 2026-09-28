# Frame probes: what a frame shows

The sweep's probes (`../sweep`) measure what a frame costs. These measure
what it shows, on a real display, where the headless suite cannot look:
Present and its vblank, a compositor, GL surfaces and the child windows over
them, a real window manager — and on macOS the window server, and when a
frame reaches it. Each prints one `RESULT` line, and `../sweep/run.sh` runs
them as the `frames` suite (`SUITES=frames`).

The suite's pixel tests prove that a frame is right once it has settled. A
frame that is wrong for one vblank on the way there — a card drawn twice
during a drag, a blank strip, a window moved before its pixels — settles
fine, and nothing in CI sees it. So these read the screen while the
interaction runs.

| Probe                 | What it watches                                                             | Knobs                                                  |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `drag.tsx`            | a `<Flow>` node dragged at 125 Hz: every other card must not change a pixel | `SCENE`, `GL=1`, `ZOOM`, `MS`, `EVERY`, `MAP=1`, `OUT` |
| `renderers.tsx`       | one `<Flow>` scene through the 2D and the GL renderer: the same ink         | `SCENE`, `ZOOM`, `BG`, `INK_T`, `R`, `OUT`             |
| `e2p.tsx`             | Cocoa: a `<Flow>` node dragged in jumps, each from its event to its pixel   | `GL=1`, `ZOOM`, `STEPS`, `GAP`, `JUMP`, `STAGES=1`     |
| `watch.mjs`           | the second X client `drag.tsx` samples the window with                      | —                                                      |
| `cocoa-capture.swift` | the ScreenCaptureKit stream `e2p.tsx` reads the window server with          | —                                                      |

```bash
SCENE=widgets GL=1 npx tsx scripts/bench/frames/drag.tsx
SCENE=widgets OUT=/tmp/parity npx tsx scripts/bench/frames/renderers.tsx
REACT_X11_BACKEND=cocoa GL=1 STAGES=1 npx tsx scripts/bench/frames/e2p.tsx
SUITES=frames scripts/bench/sweep/run.sh frames.jsonl
npx tsx scripts/bench/sweep/tabulate.ts frames.jsonl
```

## `drag.tsx`

The window is read by **another process**, back to back with GetImage,
about 500 times a second on a desktop GPU. From inside the app a readback
would wait on the same event loop that draws, and change the timing it is
there to observe. What it compares is every other card in view, inset past
its rounded corners (an edge passing under a corner changes those pixels,
rightly) and less the band the dragged card sweeps. Any change there is a
sample the user could have seen something wrong in; `runs` counts the
separate stretches of them.

From inside, the probe also counts:

- `drawsInFlight` — draws into the window's backing store while a Present
  of it has not completed. The server copies the pixmap at the vblank, so
  anything drawn meanwhile goes out with it, half a frame (ntk issue #223).
- `churn` — the X11 panes over a GL surface made, dropped, moved and
  resized during the drag, from core's overlay where it can be reached.

The minimap is off unless `MAP=1`: it summarises every node, so the drag
redraws it, and it lies over the cards in its corner.

## `renderers.tsx`

The two renderers draw one graph through different rasterizers, so they are
never pixel-equal. A pixel is ink where it is more than `INK_T` from the
background in any channel, and ink is matched within `R` pixels: `missing`
is 2D ink with no GL ink that close, `extra` the reverse. Antialiasing moves
ink by a pixel. A band of ground over the GL frame, an edge that stops
short, a lost arrowhead or a card not drawn does not hide in `R`. With `OUT`
it writes both captures and a diff, missing in red and extra in blue.

## `e2p.tsx`

Event to pixel on macOS: from a pointer move handed to the app to the
display time of the first frame that shows the dragged node where the move
put it. That is what a drag feels like, as one number, and it is the number
neither a frame rate nor a frame time is — a renderer can finish its frame
sooner and still be seen later.

The node in the middle of the widgets scene is filled `#ff00ff` and dragged
in jumps of `JUMP` pixels, `GAP` ms apart, so no two jumps share a frame.
Beside the app, `cocoa-capture.swift` streams the window through
ScreenCaptureKit and reports each changed frame's display time and where
the magenta is in it. The display time is the window server's, moved onto
the clock `process.hrtime` reads, so both ends are on one clock and no
frame is timed by when it was read. The probe builds the capture with
`swiftc` on first use, into the temporary directory or at `CAPTURE`.

- `first50`, `first90` — to the first frame that moved the node;
- `settled50`, `settled90` — to the first frame from which the node stays
  where the jump put it;
- `doubledFrames` — frames that showed the node wider than at rest: two
  layers drawing it at two places.

`STAGES=1` says where the time went, on the same clock: the drag's change,
the window's flush, the GL frame's swap, the overlay's paint and each
IOSurface flip after the event, and the pixel after the swap and after the
flush.

It needs Screen Recording for the terminal that runs it, which the capture
asks without the system's prompt and exits 5 without, and the window
uncovered: an occluded Cocoa window gets no frames. The window is raised
for the run and the real pointer is held back from it meanwhile, since a
real move with no button down ends the drag.

## What they found

On a GTX 1080 Ti under Xorg 21.1 and Cinnamon, 2026-09-28:

- **A resize killed direct GL on NVIDIA.** Every `<glarea>` is made before
  layout gives it a size, and its first frame at the real size failed with
  `EGL_BAD_SURFACE`, silently: the old generation's surface was destroyed
  while it was current (sidorares/ntk#399, sidorares/node-x11-dri#34). A
  `<Flow renderer="gl">` with bodies drew one frame in three seconds.
- **Cards shook during a GL drag** — 631 of 1,566 samples bad — because
  core handed its panes out by their place in a list, and a pane's move
  reached the screen a vblank before its pixels (sidorares/react-x11#715).
- **GL covered 16 px round every card with a body** — 9% of the 2D ink
  missing: edges stopping short, no arrowheads, no dots — because an X11
  pane was the rectangle of its child's reach (sidorares/react-x11#717).

Against master before those three, `drag.tsx` on the widgets scene read 938
bad samples in 40 runs, with a pane made, two dropped and 133 resized, and
`renderers.tsx` read 9.06% missing; with them, 0, 0 and 0.

On a 16-inch MacBook Pro (M1 Pro, macOS 15.2, its 120 Hz panel),
2026-09-28, `e2p.tsx` on the widgets scene at zoom 0.95:

|     | event to pixel, p50 |      p90 | the frame done | then to the screen |
| --- | ------------------: | -------: | -------------: | -----------------: |
| 2D  |            40-43 ms |    45 ms | 25 ms, flushed |           15-17 ms |
| GL  |            50-54 ms | 58-60 ms | 18 ms, swapped |           32-35 ms |

- **A GL frame is done sooner and seen later.** The GL renderer has its
  frame swapped seven milliseconds before the 2D one has flushed, and the
  swap's surface then reaches the screen two of the display's frames after
  a flush would have. A `glFinish` before the flip changes nothing, and
  zoom 0.5 — no bodies, so nothing over the surface — reads the same: it is
  neither GPU work still running nor the overlay, but how a `<glarea>`'s
  surface is presented on Cocoa, which is core's and @windowkit/appkit's.
- **It is not a regression.** Master of that morning (7254411, before the
  Linux round), master before #251 and core 2.22.8 in place of 2.22.10 all
  read the same, so neither the Linux round's fixes nor this package's
  moved it. No frame in these runs showed the node twice.
