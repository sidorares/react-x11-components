# Frame probes: what a frame shows

The sweep's probes (`../sweep`) measure what a frame costs. These measure
what it shows, on a real X server, where the headless suite cannot look:
Present and its vblank, a compositor, GL surfaces and the child windows over
them, a real window manager. Each prints one `RESULT` line, and
`../sweep/run.sh` runs them as the `frames` suite (`SUITES=frames`).

The suite's pixel tests prove that a frame is right once it has settled. A
frame that is wrong for one vblank on the way there — a card drawn twice
during a drag, a blank strip, a window moved before its pixels — settles
fine, and nothing in CI sees it. So these read the screen while the
interaction runs.

| Probe           | What it watches                                                             | Knobs                                                  |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `drag.tsx`      | a `<Flow>` node dragged at 125 Hz: every other card must not change a pixel | `SCENE`, `GL=1`, `ZOOM`, `MS`, `EVERY`, `MAP=1`, `OUT` |
| `renderers.tsx` | one `<Flow>` scene through the 2D and the GL renderer: the same ink         | `SCENE`, `ZOOM`, `BG`, `INK_T`, `R`, `OUT`             |
| `watch.mjs`     | the second X client `drag.tsx` samples the window with                      | —                                                      |

```bash
SCENE=widgets GL=1 npx tsx scripts/bench/frames/drag.tsx
SCENE=widgets OUT=/tmp/parity npx tsx scripts/bench/frames/renderers.tsx
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
