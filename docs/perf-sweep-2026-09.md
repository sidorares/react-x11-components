# The September 2026 performance sweep

A record of one long performance round across this package, react-x11 (core),
ntk and node-x11: what was measured, what was wrong, what fixed it, what did
not, and the numbers either side. Written to be reused: the next round should
start from the method and the lessons here rather than rediscover them.

Scope, in the order it was done: `<Flow>` (2D and GL), `<Map>`, the charts,
`<Table>`/`<Tree>` virtual lists, large `<Markdown>` and `<Html>` documents,
`<CodeEditor>` with large files and very long lines, and `<RichTextEditor>`
with large documents. Every scenario on both backends — X11 (XQuartz on a
Mac) and Cocoa — and, where a component has one, both renderers. It ends
with a sweep of everything against the final tree, which is the baseline for
the next round.

One machine throughout: an Apple M1 Pro (10 cores, 16 GB), macOS 15.2, the
built-in 120 Hz display at scale 2 for Cocoa and XQuartz 2.8.6 at scale 1 for
X11, Node 26, React in development mode. Numbers from another machine are not
comparable with these; the method is.

## Where things landed

| Repository | Change                                                                            | Status              |
| ---------- | --------------------------------------------------------------------------------- | ------------------- |
| node-x11   | #300 extension requests keep the 16-bit sequence anchored (the X11 charts freeze) | released, x11 4.2.2 |
| react-x11  | #692 corner pins and cascade-aware damage merging                                 | released, 2.22.1    |
| react-x11  | #695 Cocoa rounded-box children read back instead of path-clipped                 | released, 2.22.2    |
| react-x11  | #698 a scrollbar thumb drag scrolls whole device pixels                           | released, 2.22.3    |
| react-x11  | #700 column spines, exact-config copies, the absolutize skip                      | released, 2.22.4    |
| react-x11  | #702 a document in a rounded card, and a virtual table, scroll by blitting        | released, 2.22.5    |
| react-x11  | #704 the width pass shapes only the text a floor is read from                     | released, 2.22.6    |
| ntk        | #373, #375 coverage cropped to the clip; `fillRects` under a clip                 | released, 8.12.1    |
| ntk        | #377 glyph runs past 16-bit coordinates culled, not thrown                        | released, 8.12.2    |
| ntk        | #379 a layout reads the face once; bidi skipped for text nothing reverses         | released, 8.12.3    |
| ntk        | #381 a prewarm answers the first layout; a family's faces warm together           | released, 8.12.4    |
| ntk        | #383 the shaping memo in two generations, a style's words under one kept key      | open                |
| components | #128 `<Flow>` GL renderer and its perf work, maps label shaping, lockfile         | open                |
| components | #130 a long flick keeps the virtual window to its budget                          | merged              |
| components | #131 code editor: long lines in pieces, scroll blit                               | merged              |
| components | #132 code editor: a wheel notch scrolls a notch                                   | merged              |
| components | #133 code editor: an edit costs the lines it changes                              | merged              |
| components | #134 rich text editor: a keystroke costs the block it lands in                    | merged              |
| components | #135 `<Html>`: an edit lays out again only the text it changed                    | merged              |
| components | #136 rich text editor: a mark over the document keeps its blocks' keys            | merged              |
| components | #137 code editor: a keystroke repaints its rows; revealing the caret is a blit    | merged              |
| components | #138 code editor: a line far past the frontier is answered from a guess           | open                |

## Method

### The probes

Every number here comes from a probe: a small `.tsx` program that mounts one
component in a real window on the chosen backend, drives it with synthetic
input or data changes on a wall-clock timer, and prints one JSON line. They
live in `scripts/bench/sweep/`, with `run.sh` to run all of them on both
backends, `tabulate.ts` to print a run as tables or mark what moved against
an older one, and the final sweep's results (see the README there):

| Probe             | Component              | Actions (`ACTION=`)                                                                                                                          | Knobs                                                          |
| ----------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `matrix.tsx`      | `<Flow>`               | `pan`, `zoom`, `wheel`, `drag` over five scenes                                                                                              | `SCENE`, `GL`, `ZOOM`, `MAP`, `W`/`H`/`VX`/`VY`, `DIAG`        |
| `mapsweep.tsx`    | `<Map>`                | `pan`, `drag`, `wheel`, `fly` over London z15                                                                                                | `RENDERER` (`retained`/`gl`), `DIAG`; tiles from `BENCH_TILES` |
| `chartsweep.tsx`  | charts                 | `stream`, `pan1m`, `zoom1m`, `multiples`, `scatter`, `scroll`                                                                                |                                                                |
| `tablesweep.tsx`  | `<Table>`              | `wheel`, `fling`, `thumb`, `jump` over 100k rows                                                                                             | `DIAG`, `PREFETCH`                                             |
| `docsweep.tsx`    | `<Markdown>`, `<Html>` | `mount`, `edit`, `append`, `scroll`, `reflow`                                                                                                | `COMP`, `SIZE` (sections), `PHASES`, `NO_FLOORS`               |
| `editorsweep.tsx` | `<CodeEditor>`         | `mount`, `scroll`, `type-end`, `type-mid`, `type-start`, `undo`, `replace`, `long-mount`, `long-type`, `caret-down`, `enter-end`, `jump-end` | `COMP=code`, `LINES`, `LONG`, `PLAIN`                          |
| `editorsweep.tsx` | `<RichTextEditor>`     | `mount`, `scroll`, `type-mid`, `type-hidden`, `type-long`, `bold-all`, `paste`                                                               | `COMP=rte`, `SIZE`                                             |
| `docgen.ts`       | —                      | generates the test documents                                                                                                                 | deterministic by seed                                          |

The diagnostic modes — `DIAG`, `DAMAGE`, `TIMELINE`, `CLAIMS`, `STACKS`,
`PHASES` — are in that README, with what each found.

What they report: `fps` (frames that painted, per second), `frame50`/`frame95`
(the window's own flush time), `lat50`/`lat95` (from an input to the end of
the first flush that painted after it — what a user feels), `cpu` (process
CPU %), `firstPaint` and `idle` for mounts. A frame is `WindowNode._flushFrame`
returning true.

The documents: `docgen.ts` writes a technical report of N sections (heading,
three paragraphs with inline bold/italic/code/links, a list nested every few
sections, a table every fifth, a code block every third, a quote every
seventh), byte-identical for a seed. 300 sections is about 600 KB of
Markdown; 1,000 is about 2 MB. The code editor's file is generated
TypeScript, 50,000 lines (2.5 MB); its long line is a minified-looking
100,000 or 1,000,000 characters.

### How to not fool yourself

These are the traps this round actually fell into. Each cost at least one
wrong conclusion before it was caught.

- **Check that the probe measures what you think.** The charts "scroll stall"
  was a probe scrolling a page 40 notches into a document 1,296 px tall — it
  was clamped most of the time. The code editor's wheel benchmark reached
  line 34,033 in four seconds, which is how the 144-lines-a-notch bug was
  found. The rich text editor's `type-mid` set its selection and scrolled
  inside the timed window, so mounting the blocks there was counted as
  typing. A number that looks absurd is usually the probe or a bug, and both
  are worth finding.
- **Keep the machine idle and interleave A/B.** Running a test suite in the
  background during a benchmark made a real improvement look like a
  regression. Background daemons after `npm ci` and worktree creation do the
  same. Interleave A/B/A/B, two or more of each.
- **Dev versus production React.** All numbers are development React unless
  noted; it mattered little (0.4 ms of 5 ms typing latency in the rich text
  editor) but check before blaming `createElement`.
- **The harness is not the display.** The in-process X server lays out and
  measures between two synthetic events, which a 60 Hz event stream on a real
  display does not; one window-growth bug reproduced only on the real Cocoa
  app.
- **A background task's result is only read when the event loop is free.**
  An async prewarm that "finishes" in 150 ms may be read two seconds later if
  the main thread is busy rendering, and meanwhile it competes for CPU.
- **One run is not a number.** Four of the final sweep's 226 cells moved
  10–30% the wrong way and none of them was real (see "Regression check"):
  an XQuartz fence that took twice as long once, a cell whose spread is
  50–58 fps, sixteen samples. Rerun, interleave, and only then bisect.
- **A latency measured against a periodic input depends on the phase.**
  Appends every 50 ms against a frame cycle of about 70 ms gave a median of
  49 ms in one run and 68 ms in the next, on the same build. Read the frame
  cost and the frame rate beside it; they were steady.

### Instrumenting the renderer

Most of the core findings came from counting _why_ a frame did what it did,
not how long it took. The techniques that worked:

- **CPU profiles** (`NODE_OPTIONS=--cpu-prof`) aggregated by self time, by
  inclusive time for a set of functions, and by caller chain for one
  function (`scripts/bench/sweep/cpuprofile.ts` does all four):
  `createElement` and fontkit's `lookup` were both only understood through
  their callers.
- **Gate counters in a disposable copy of core.** Rewriting every `return;`
  in `_applyScrollBlits` and every `return false` in `_scrollBlitSafe` of the
  installed `node_modules/react-x11` to count its line number turned "the
  scroll does not blit" into "line 858, the rounded corner of the
  `richeditor` box at radius 8", then into the next gate after that was
  fixed. Same for the five places a blit gets poisoned. Restore the files
  after (`npm ci`).
- **Per-frame timelines**: flush start/end, the frame's kind (blitted,
  poisoned, declined, no scroll), every claim with its reason and size,
  every node whose rect changed by more than a threshold, and the damage the
  frame took. This is what showed the remaining full repaints came from a
  column whose far edge moved.
- **Counting calls, not time**: layouts per keystroke, split by kind
  (min-content, wrapped, one line) and by call stack, found a paragraph laid
  out at two widths and the probe's setup being counted as typing.

## Round 1: `<Flow>`

(Numbers: the full matrix of five scenes × pan/zoom/wheel/drag × 2D/GL ×
X11/Cocoa, before and after the round.)

| Scenario                                               | Before           | After      |
| ------------------------------------------------------ | ---------------- | ---------- |
| The "2 fps" view (widgets, 1686×1180, zoom 0.455), X11 | 2 → 13 fps       | 64 fps     |
| Same, Cocoa                                            | 15 fps           | 97 fps     |
| 200-node lattice pan, X11 2D                           | 25 fps           | 82 fps     |
| Widgets pan, Cocoa                                     | 29 fps           | 117 fps    |
| Charts scene zoom, X11                                 | froze the window | 9 fps      |
| GL cells (all scenes)                                  | 80–120 fps       | 84–120 fps |

What worked:

- **The X11 charts freeze was a wire-sequence bug in node-x11** (#300): 36
  chart bodies mounting in one frame sent 137,000 requests; extension
  requests bumped the sequence number themselves and skipped the anchor
  request inserted every 60,000, so the 16-bit sequence wrapped, replies
  were mis-assigned, and the fences never came back.
- **Corner pins instead of full-width bands** (react-x11 #692): a pane inside
  a rounded card carved two full-width bands out of every pan's blit; pinning
  just the four corner squares, plus a damage-merge that prices what a merge
  would swallow, took the 2 fps view to 61 (X11) and 90 (Cocoa).
- **Cocoa rounded-box children** (react-x11 #695) were clipped by a path —
  CoreGraphics masks the whole draw — rather than read back.
- **ntk**: coverage uploads cropped to the clip's extents (#373) and
  `fillRects` under a path clip as one masked composite for disjoint rects
  (#375).
- **In `<Flow>`** (#128): the scene culled once per frame, dash ticks held
  while the view moves, dashed edges cut to a pass's runs, dragged nodes
  lifted out of the world in GL and into pane pictures in 2D, picture
  compositing with `copy` for the ground.

What did not:

- **Splitting the zoom composite** — the rounded clip came from core's
  ancestor, not from `<Flow>`.
- **Narrowing ntk's rasterisation grid to the clip**: float summation order
  changed, pixels flipped by ±1, and core's byte-equal blit tests broke.
  Only the upload was cropped.
- **Batching `fillRects` for overlapping rects**: double-blended at the
  clip's antialiased edge. Kept for disjoint rects only.
- **Edge damage as bands** (twice): core merges damage to four rects, so the
  bands merged back into boxes.

Left: XQuartz's fence pacing caps 2D pans near 75 fps; Cocoa's scaled picture
composite costs about 8 ms; a programmatic zoom re-renders bodies by design.

## Round 2: charts, maps, the table

(Baseline: the round's first sweep of all three.)

### `<Table>` and `<Tree>` (100,000 rows)

A flick at 16–17 fps with 50 ms frames. The virtual window grew without
bound during the flick: measuring was deferred while scrolling fast, and the
trim refused to cut rows it had no measured height for — 1,250 rows and 8,768
nodes mounted four seconds in, and core's content floors then laid out all
of it four times a frame.

**Fix (#130):** the trim measures a row on its way out (a `measure` hook on
the shared window, converting device to logical pixels). Held at 151 rows.
Cocoa fling 16 → 39 fps (61 with production React, the input rate), X11
17 → 44; wheel 56 → 67 and 46 → 53. The later core releases and react-x11
#702 took it further: Cocoa fling 98 fps and wheel 117 in the final sweep,
of which #702 alone is 56–88 → 98 and 77 → 117 (round 5).

**Thumb drag, X11: 25 → 52 fps** (react-x11 #698). Dragging the scrollbar
thumb produced fractional scroll offsets, which decline the blit and sent
every box through X11's mask path (45 pixmaps a frame). Rounding the drag to
whole device pixels: X CPU 66% → 15%, requests a frame 494 → 116.

Did not help: treating scroll containers as floor boundaries — the scroll
pane held the whole table anyway. `prefetch={0}` as an upper bound: 70 fps
with 71 rows.

### Charts

The "scroll stall" (35 fps, p95 52 ms) was the probe (above). Fixed probe:
74 fps Cocoa, 71 X11, p95 18 ms — no product change. Streaming six charts at
19 fps is the 20 Hz append rate; about 2 ms per chart per append. Left as is.

### `<Map>` (London z15, retained renderer)

Cocoa wheel zoom at 44 fps with 50 ms draw p95: the label shaper's cache
(4,000 entries, cleared wholesale) thrashed across a six-level zoom — 360,000
shape calls, 43,000 CoreText layouts and 11 clears in four seconds (812 ms).

**Fix (#128):** measuring split from shaping — a colour-blind measure
cache (8,000 a generation, numbers only), shaping only at draw time for the
names in the pane, two-generation eviction for both, a WeakMap from placed
label to shaped label so a pan costs what it did. Layouts 43k → 7.8k; Cocoa
wheel 44 → 51 fps, draw p95 50 → 27 ms; X11 56 → 60, 20 → 12.

Did not help: reordering the repeat test (shape calls 361k → 306k, layouts
unchanged: most names are unique); a bigger layout generation (halved layouts
but doubled the native memory bound). Left: Cocoa scaled composites
(`drawImage`, 1.1 s of 4 s) — platform-bound; GL is the answer.

## Round 3: large documents — core first

(Baseline: 300 sections, before any of the round's changes.)

|                    | Markdown Cocoa | Markdown X11 | Html Cocoa | Html X11 |
| ------------------ | -------------- | ------------ | ---------- | -------- |
| mount, first paint | 1.9 s          | 2.5 s        | 0.57 s     | 1.3 s    |
| reflow, a frame    | 330–400 ms     | 404 ms       | 600–830 ms | 832 ms   |
| edit, a frame      | 117 ms         | 104 ms       | 336–400 ms | 399 ms   |
| append, a frame    | 168 ms         | 154 ms       | 344–385 ms | 385 ms   |
| scroll             | 55 fps         | 55 fps       | 55 fps     | 55 fps   |

**The finding that mattered:** content floors measured with
`measuringExactly`, which toggles yoga's `pointScaleFactor` between 0 and 1.
That bumps the config version, and _every_ node's layout cache is invalid
afterwards: the next real pass is a full relayout (58 ms on 13,000 nodes
against 0.05 ms warm). Any frame that measured any floor paid it.

**Fix (react-x11 #700, in 2.22.4):**

1. **Column spines.** A change inside a long column (a document, a log, a
   feed) is measured from the highest box no column above it can sum; the
   columns up to a box that names its own size on both axes are summed
   arithmetically (`columnHeightSpan`, which replicates `contentSpan`'s
   rules: extents, inner margins, gaps, padding and border). Width extents
   on the spine are left unmeasured, which is what the floors do with every
   extent nobody reads.
2. **Measuring on exact copies.** An isolated measurement lays out a copy of
   the subtree in a second yoga config with `pointScaleFactor` 0; the
   renderer's config never toggles, so its caches survive. The real pass
   went 39 → 3.6 ms on an edit.
3. **The absolutize walk skips** children yoga did not reach under an unmoved
   parent — only on frames with no scroll since the last walk.
4. **`measureScrollContent` caches its reach** per box while the flag is
   clear.

Result, a frame: Markdown edit Cocoa 117 → 19.6 ms, append 168 → 38.6; X11
104 → 14.6 and 154 → 31.7. Scroll unchanged; reflow and mount are text-bound.

Gotchas found on the way: a brand-new node's _computed_ margins read 0 on a
copy (it was never laid out in the tree), so the spine reads margins from
style; a spine root that stopped at a list row bailed, so the root became
the highest box a column cannot sum; skipping the absolutize walk
unconditionally broke eight scroll tests (the walk carries scroll offsets);
the equivalence test missed a wrong width-pass width until a growing row
was added to it.

## Round 4: `<CodeEditor>`

A 50,000-line TypeScript file (2.5 MB), and single lines of 100,000 and
1,000,000 characters.

### Long lines (#131)

A minified line was one text layout, and everything the editor asks of a
layout is linear in its length or worse: putting the caret at the end of a
100,000-character line took **4.3 s** in CoreText's caret lookup; every
keystroke shaped the whole line again; on X11 a line wider than 32,767 device
pixels threw a `RangeError` out of the paint (the glyph run's int16
coordinates — fixed at the source in ntk #377 too).

Past 2,048 characters a line is laid out in pieces of 256–2,048 characters
placed end to end, cut after a delimiter that the two characters before it
pick out — content-defined, so a keystroke moves the cuts near it and none of
the rest, and the pieces after it are found again in a cache keyed by what
they hold. The tokenizer stops at 10,000 characters a line (CodeMirror's
`maxHighlightLength`).

|                                      | Before | After                            |
| ------------------------------------ | ------ | -------------------------------- |
| 100k chars, mount (Cocoa)            | 392 ms | 100 ms                           |
| 100k chars, caret to the end (Cocoa) | 4.3 s  | 2 ms                             |
| 1M chars, mount (Cocoa)              | 2.8 s  | 206 ms                           |
| 1M chars, a keystroke (Cocoa)        | —      | 13 ms                            |
| 100k / 1M chars, mount and key (X11) | threw  | 277 ms / 4.4 ms, 672 ms / 9.3 ms |

### The wheel (#132)

Found by the scroll benchmark reaching line 34,033 in four seconds. Since
react-x11 2.0.0 (react-x11 #278) the wheel reaches handlers in **logical
pixels**, 48 a notch; `<CodeEditor>` landed the day before that change and
read the deltas as notches, three lines each — one notch scrolled 144 lines.
Nothing tested the wheel. An audit of every other wheel consumer found them
correct except QML's `angleDelta` (units and sign), filed as a task.

### The scroll blit (#131)

Every scroll step repainted the whole editor — on Cocoa 2.1 ms of each frame
was the box's own border and background. A vertical scroll is now core's
`scrollContents` over the content box with the thumbs' strips carved out and
claimed edge to edge. `paint` culls to `paintDamage()` in **both** axes:
core paints one pass per damage rect, and the thumb strip's pass, a column at
the right edge, would otherwise redraw every line. The caret blink claims its
row. Frame 5.3 → 3.9 ms on Cocoa, 3.9 → 2.5 ms on X11 (11 and 6.8 ms before
the wheel fix). The pixel test compares the blitted frame to a full repaint
byte for byte at 1x and 2x.

Left on Cocoa: core's buffer chain copies the pane twice a scroll frame (the
catch-up of the back buffer, then the shift) — about 2 ms at 2x. Fusing them
into one shifted copy needs a native in `@windowkit/appkit`.

### The edit path (#133)

Four ways an edit cost the file:

- the line cache dropped every entry from the edited line down (typing on
  line 1 relaid every line in view);
- with no language a line's tokens were a fresh `[]` on every lookup and the
  cache compared tokens by identity — a plain-text editor never hit its
  cache;
- the stream tokenizer's `edit()` discarded the entry state convergence
  compares against, so every edit re-tokenized the line after it (its own
  test documented "a line of wasted work");
- the undo history held up to 200 copies of the whole text, joined on every
  keystroke; undo reset the editor to a copy.

Plus the cache was unbounded (a native layout per line ever shown), and a
paste of more than about 150,000 lines threw `RangeError: Maximum call stack
size exceeded` from `splice(at, n, ...lines)`.

Fixes: cache entries follow their lines across an edit; one frozen empty
token array; the convergence candidate kept; the cache bounded at 2,048;
the history as line diffs (`{from, before, after, selections}`) with
coalescing by touching ranges; one edit path that narrows a replacement to
the lines it changes; the text joined only when an `onChange`,
`onSelectionChange` or controlled `value` reads it; `spliceAll`. Undo now
puts the caret where the change was made.

| Latency, median             | macOS before → after | XQuartz before → after |
| --------------------------- | -------------------- | ---------------------- |
| type at the top of the file | 12.9 → 6.7 ms        | 6.3 → 3.8 ms           |
| type mid-file, plain text   | 8.2 → 6.3 ms         | 4.7 → 3.1 ms           |
| undo                        | 16.5 → 11.6 ms       | 10.3 → 8.2 ms          |
| select all, replace         | 256 → 21 ms          | 177 → 19 ms            |

Left: every edit repaints the whole editor. A claim of just the rows an edit
changed would make a keystroke's cost independent of the window's size, but
has to track the active line, the bracket match, the thumbs and the gutter
width. Jumping to the end of a freshly opened 50,000-line file tokenizes all
of it; CodeMirror 5's answer is to highlight from a nearby state imprecisely
and correct in the background.

## Round 5: `<RichTextEditor>`

The generated report at 300 sections (600 KB) and 1,000 (2 MB).

### Typing (#134)

Key-to-frame latency grew with the document: 5.6 ms at 200 KB, 6.8 ms at
600 KB, 12 ms at 2 MB (82% of a core at 60 keys a second).

- `BlockKeys.update` mapped every block's position, walked the document and
  built three maps from scratch on every transaction — 6 ms a key at 2 MB.
  Now only the top-level blocks between the first and last one the
  transaction changed are re-keyed; the rest are the same node objects,
  keep their keys and only move. Entries in document order, positions by
  bisection.
- `<richtext>` cleared its layout cache whenever `runs` was a new array, and
  the editor builds runs in render; an equal array now keeps its layout and
  its pixels.
- Each unchanged block gets its last element back, so React bails out
  without comparing props.
- The block window measures a block on its way out, like the table (#130).

2 MB: 12.0 → 4.9 ms on macOS (CPU 78% → 38%), 10.8 → 4.2 ms on XQuartz;
600 KB: 6.8 → 4.5 and 5.9 → 4.0. The latency no longer depends on the
document's size.

### Scrolling (react-x11 #702)

On master none of the editor's scroll frames blitted and each repainted
about 1.1 windows. Three layers, each found by the gate counters after the
one before was fixed, and each alone barely moving the number:

1. **An ancestor's rounded corners refused the blit** (`_scrollBlitSafe`):
   the editor's frame has a radius of 8 and its scroll viewport starts just
   inside the border. Pinned now, as element blits already were (#691), and
   capped in one `addDamageRects` call — capped one rect at a time,
   scrolling _up_ merged the corners at one end with the strip at the other
   into the viewport, which only the pixel test caught.
2. **A child entering or leaving a box inside a scroll box claimed that
   box**, clipped to the viewport — the whole viewport — even below the
   fold; the fine route of #398 applied only to the scroll box's own
   children. Now any box inside a scroll box claims per child for entering
   and leaving children, in any frame; a move still claims the box (a
   reorder changes stacking, which no rect says).
3. **A box that only grew claimed its whole old and new rect.** A column
   gaining a block below the fold, or re-slicing in the scroll's frame with
   its unbuilt rows at a guessed height, claimed the viewport and poisoned
   the blit. It claims the bands along the edges that moved now, both in
   ordinary frames and under a scroll's shifted diff.

Frame 8.9 → 3.4 ms on Cocoa (p95 12.2 → 6.7, latency 9.5 → 3.5, CPU 73% →
48%); 4.0 → 2.5 ms on X11. Every scroll frame blits; frames between scrolls
paint 3% of the view where they painted all of it.

The final sweep found the same three claims holding back `<Table>`, whose
rows enter and leave a column inside its scroll box on every notch — nobody
had looked, because round 2's fix had already made it fast enough to stop
looking. Released 2.22.4 against #702, three interleaved runs each, 100,000
rows: a Cocoa wheel 77 → 117 fps (frame 5.6 → 2.7 ms, p95 8.0 → 3.2), a
Cocoa flick 56–88 → 98 fps (frame 10.9 → 7.2 ms); on X11 the flick is paced
at 60 fps either way and its frame goes 7.9 → 7.0 ms. A core fix found for
one component is worth running every component's probes against.

Left: bold over the whole document 140–430 ms, a 100 KB paste about 100 ms,
typing into a 50,000-character paragraph 10 ms a frame (the paragraph is laid
out again whole). The Cocoa text engine still hands back runs without their
spans (react-x11's "gap 2"), so run decorations and link hit-testing are off
there.

## Round 6: documents again — ntk (ntk #379)

On XQuartz almost all of an `<Html>` edit was text layout in ntk, and most of
that re-read things that never change:

- `_makeToken` asked fontkit for the space glyph — a cmap lookup — for every
  word ending in a space, to price trailing whitespace: 1.56 s of a run;
- `metrics()` and `scale()` went back through fontkit's table getters on
  every call: about 0.5 s;
- UAX#9 ran over every paragraph, including pure left-to-right text: 0.38 s.

Now the space advance and the face's metrics are read once a face (`metrics`
still returns a fresh object), and text with no right-to-left character, no
Arabic number, no RLM/ALM and no embedding, override or isolate gets level 0
without the pass (tested against bidi-js level for level on both sides).

XQuartz latency: `<Html>` edit 389 → 199 ms, append 380 → 205, reflow step
877 → 329; `<Markdown>` reflow 411 → 276, first paint 2.4 → 2.07 s.

Tried and dropped: **prewarming bold, italic and monospace font matches at
connect.** A Markdown mount waits on four synchronous `fc-match` runs (491 ms
on this Mac). The prewarm children started at 370 ms but their output was only
read when the event loop freed up — at 2.8 s, after the render — and running
in parallel they slowed the first synchronous spawn from 143 to 389 ms: first
paint got worse, 2.08 → 2.31 s. The existing single prewarm has the same
problem whenever the first layout follows the connect. A real fix needs a
result readable synchronously: the child writing a file the sync path reads,
or one synchronous spawn that resolves all of a document's faces in parallel.

## The final sweep

Every probe, both backends, against one tree: components `master` (#130–#133)
with #128 and #134 merged, on react-x11 2.22.4 with #702 applied and ntk
8.12.2 with #379 applied — the code react-x11 2.22.5 and ntk 8.12.3 then
released, and nothing else. 226 cells, the 136-cell Flow matrix among them;
none failed. The numbers are the new baseline:
`scripts/bench/sweep/results-2026-09-25.jsonl` holds them (the instrumented
`DIAG` runs left out), and

```bash
npx tsx scripts/bench/sweep/tabulate.ts new.jsonl scripts/bench/sweep/results-2026-09-25.jsonl
```

marks what a later sweep moved. They are this machine's numbers and no other's. Round 7, after it, moved some of them on purpose —
the Markdown and HTML mounts and edits, and every first paint on X11 — so a
sweep after round 7 is the one to compare the next round with.

An arrow compares a cell with the first measurement of the round that worked
on it: the first Flow matrix (already past the stress view's 2 → 13 fps
fix), round 2's first sweep for the maps, charts and table, round 3's for
the documents, `master` after #131 and #132 for the code editor (the
long-line and wheel numbers before those are in round 4), and `master` for
the rich text editor. A cell without an arrow moved less than 10%, three
frames a second or a millisecond, which on this machine is noise. `²` is a
GL cell that drew 2D: a graph whose node types mount bodies falls back on
XQuartz, where GL is composited over the window's X content
(`useSupports('glOverlay')`).

#### flow: fps

|                                                   |          X11 2D |           X11 GL |        Cocoa 2D | Cocoa GL |
| ------------------------------------------------- | --------------: | ---------------: | --------------: | -------: |
| lattice · pan z0.5                                |   25 → **82.8** |             93.7 |  32.1 → **120** |      120 |
| lattice · pan z1                                  |   31 → **66.2** |             93.7 |  34.2 → **120** |      120 |
| lattice · zoom z0.8                               |            32.5 |               92 | 32.1 → **41.4** |      119 |
| lattice · wheel z0.8                              |            52.4 |             92.4 |            57.7 |      118 |
| lattice · drag z1                                 |            91.7 |             91.9 |             112 |      119 |
| lattice2000 · pan z0.5                            | 16.3 → **47.6** |             81.5 | 21.1 → **69.4** |      120 |
| lattice2000 · pan z1                              | 30.4 → **53.7** |             84.3 | 34.4 → **87.5** |      120 |
| lattice2000 · zoom z0.8                           |              20 |             84.2 | 26.6 → **36.2** |      113 |
| lattice2000 · wheel z0.8                          |              40 |               84 |            41.7 |      115 |
| lattice2000 · drag z1                             |            90.1 |             88.7 |             111 |      119 |
| fanout · pan z0.5                                 |   53 → **86.5** |             91.7 |  55.6 → **120** |      120 |
| fanout · pan z1                                   | 53.7 → **83.5** |               92 |  58.1 → **120** |      120 |
| fanout · zoom z0.8                                |            36.7 |             92.8 | 30.9 → **39.9** |      118 |
| fanout · wheel z0.8                               |            61.6 |             91.2 |            57.9 |      117 |
| fanout · drag z1                                  |            88.6 |             92.8 |             113 |      115 |
| widgets · pan z0.5                                | 27.5 → **65.4** |   27 → **62.7**² |  29.5 → **115** |      120 |
| widgets · pan z1                                  |     41 → **68** | 39.2 → **69.5**² |    32 → **105** |      116 |
| widgets · zoom z0.8                               |              26 |            25.7² | 13.5 → **16.7** |     32.7 |
| widgets · wheel z0.8                              |            56.5 |            53.5² |            51.1 |      117 |
| widgets · drag z1                                 |            76.7 |            76.5² |            98.6 |      119 |
| charts · pan z0.5                                 | 36.4 → **72.5** | 35.4 → **70.2**² |  34.7 → **120** |      119 |
| charts · pan z1                                   |   48.5 → **71** |   47.9 → **74**² | 36.9 → **89.6** |      118 |
| charts · zoom z0.8                                |     0 → **9.7** |     0 → **9.3**² |            10.4 |     26.6 |
| charts · wheel z0.8                               |            60.6 |            60.5² |            52.9 |      118 |
| charts · drag z1                                  | 68.7 → **80.2** |            73.3² | 49.5 → **79.4** |      119 |
| widgets · pan, the stress example's view, map off | 64.7 → **75.2** | 58.5 → **76.2**² |             120 |      120 |
| widgets · pan, the stress example's view, map on  | 12.7 → **63.9** |   12.7 → **67**² | 15.4 → **92.5** |      120 |

#### maps: fps

|       | X11 retained | X11 GL |  Cocoa retained | Cocoa GL |
| ----- | -----------: | -----: | --------------: | -------: |
| pan   |         72.2 |   80.7 |             106 |      117 |
| drag  |         92.6 |   78.6 |             111 |      114 |
| wheel |         59.7 |   59.5 | 45.4 → **50.6** |     85.4 |
| fly   |         82.1 |   81.6 |            77.2 |      103 |

#### charts: fps / frame p50, ms

|           |         X11 |       Cocoa |
| --------- | ----------: | ----------: |
| stream    | 19.2 / 10.2 | 19.2 / 12.9 |
| pan1m     |   103 / 0.6 |   113 / 2.3 |
| zoom1m    |   102 / 0.7 |   113 / 2.4 |
| multiples |   110 / 0.3 |   111 / 1.2 |
| scatter   |  75.2 / 4.3 |  84.7 / 8.6 |
| scroll†   |  74.1 / 1.8 |  71.5 / 2.8 |

#### table: fps / frame p50, ms

|       |                              X11 |                            Cocoa |
| ----- | -------------------------------: | -------------------------------: |
| wheel | 46.4 → **81.6** / 11.1 → **2.3** |  55.1 → **117** / 12.9 → **2.6** |
| fling | 17.4 → **59.8** / 49.6 → **7.2** | 16.2 → **98.4** / 50.6 → **4.9** |
| thumb |              28.9 → **51** / 7.1 |                       51.9 / 9.7 |
| jump  |                       28.3 / 8.5 |                      20.2 / 15.2 |

#### docs: first paint, ms

|              |             X11 | Cocoa |
| ------------ | --------------: | ----: |
| md · mount   | 2480 → **2090** |  1832 |
| html · mount | 1315 → **1019** |   556 |

#### docs: input to paint p50, ms / fps

|               |                           X11 |                           Cocoa |
| ------------- | ----------------------------: | ------------------------------: |
| md · edit     |            125 → **38.9** / 9 |              139 → **47.8** / 9 |
| md · append   | 180 → **54** / 4.9 → **16.1** | 176 → **61.1** / 4.5 → **14.1** |
| md · scroll   |                    4.7 / 55.4 |                      6.6 / 56.4 |
| md · reflow   |           413 → **284** / 3.9 |                       340 / 2.7 |
| html · edit   |           415 → **204** / 4.3 |                       350 / 2.5 |
| html · append |           402 → **203** / 4.3 |                       356 / 2.4 |
| html · scroll |                    3.4 / 55.1 |                      3.8 / 55.4 |
| html · reflow |           870 → **346** / 2.8 |                       612 / 1.5 |

#### editors: first paint, ms

|                   |           X11 |           Cocoa |
| ----------------- | ------------: | --------------: |
| code · mount      | 363 → **320** | 79.8 → **66.7** |
| code · long-mount | 662 → **504** |             182 |
| rte · mount       |           744 |             201 |

#### editors: input to paint p50, ms / fps

|                             |                   X11 |                           Cocoa |
| --------------------------- | --------------------: | ------------------------------: |
| code · scroll               |            2.7 / 54.6 |                      3.6 / 55.4 |
| code · type-end             |            3.8 / 52.5 |            7.8 → **6.6** / 48.4 |
| code · type-mid             |            3.9 / 53.6 |            7.8 → **6.6** / 49.6 |
| code · type-start           |  6.3 → **3.5** / 55.2 |           12.9 → **6.6** / 52.7 |
| code · undo                 | 10.3 → **7.9** / 17.5 |          16.5 → **10.3** / 17.4 |
| code · replace              |  177 → **19.5** / 3.6 |            256 → **21.2** / 3.4 |
| code · long-type            |            9.3 / 53.7 |                     13.2 / 55.1 |
| code · type-mid (plain)     |  4.7 → **2.8** / 54.9 |            8.2 → **6.1** / 52.1 |
| rte · scroll                |    4.8 → **2.4** / 65 | 9.1 → **3.6** / 59.2 → **68.1** |
| rte · type-mid‡             |  5.9 → **3.7** / 55.4 |            6.8 → **4.6** / 51.7 |
| rte · type-long             |  7.9 → **5.1** / 55.4 |                     12.4 / 54.4 |
| rte · bold-all              |            95.5 / 4.2 |                       141 / 3.7 |
| rte · paste                 |            87.2 / 4.4 |             123 → **110** / 3.4 |
| rte · type-mid (size 1000)‡ |   10.8 → **4** / 55.5 |               12 → **5** / 51.6 |

† The round's baseline for the charts scroll was the probe bug in round 2
(clamped most of the time), not the component's; there is no before.
‡ The rich text editor's `type-mid` baseline is round 5's, from the corrected
probe; the first probe typed inside the timed window's setup.

### Regression check

The question the final sweep exists for is whether a later round undid an
earlier one, so each cell was also compared with its own round's _result_.
Four of the 226 moved the wrong way by more than the noise, and each was run
three more times, alternating the released core and ntk with the two open PRs
applied:

| Cell                                       | Round's result | Final sweep | Released         | With #702, #379  | Verdict                                                                                               |
| ------------------------------------------ | -------------: | ----------: | ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| Flow, lattice, programmatic zoom, X11 2D   |       33.2 fps |        26.8 | 32.7, 32.2, 33.3 | 31.8, 32.5, 33.5 | noise: that run waited 14 ms on XQuartz's fence, twice the usual                                      |
| Flow, charts scene, wheel, Cocoa 2D        |       58.6 fps |        51.4 | 53.1, 51.4, 53.0 | 50.3, 52.9, 55.1 | the cell's spread; core 2.22.3 against 2.22.4 gave 49.7–55.3 and 50.8–53.5                            |
| `<Markdown>` append, Cocoa, latency        |          47 ms |          62 | 49, 68, 66       | 62, 60, 61       | noise in the metric; #702 makes the frames cheaper (38–40 → 34 ms) and more of them (12.7 → 14.1 fps) |
| `<CodeEditor>` select all + replace, Cocoa |        20.6 ms |        22.7 | 21.3, 17.2, 19.4 | 21.2, 21.4, 20.6 | noise: sixteen samples a run                                                                          |

None of the four is a regression, and the baseline file holds the median of
the three reruns with both PRs applied for each of them.

## Round 7: the still-open list

After the final sweep, the items it left open, in the order of what they cost
someone using the component.

### `<Markdown>` first paint: the width pass (react-x11 #704)

Of a 1.94 s first paint on Cocoa, 1.05 s was the content floors' width pass:
the whole tree laid out with no room on offer, every paragraph set a word to
a line, for min-content widths that almost nothing reads. A width floor is
written only on a row's items; a paragraph down a column has none and adds
into no extent that has one.

The pass now marks the leaves whose min-content width nothing reads, and
their measure function answers a zero size without shaping them;
`contentSpan` leaves the extents nobody reads unmeasured and walks on to the
rows inside. A leaf is marked only where its answer cannot reach anything
read: every box above it is as wide as something other than its content (a
named width, or a column stretching it), no column above it wraps, and none
hands out a share of space its height changed — which is how a height
becomes a width, through an aspect ratio, a wrapping column or an image
sized to its height.

What did not work at first: the first version guarded widths only, and was
wrong for two arrangements yoga turned out to have — a fixed-height column
whose shrinking aspect-ratio box gives up the space a paragraph takes (a
growing one, checked the same way, does not), and a box pinned to both edges
of a column as tall as its content. Tightening to "every column above is as
tall as its content" was safe and found nothing: core gives a scroll pane
`flexBasis: 0` and `minHeight: 0`, so the walk stopped at the document's own
pane and the first paint was unchanged. The rule that shipped asks the
narrower question — does a column with a height of its own hold anything
that grows or gives way in the pass. The differential test has one
arrangement per guard, and each of nine mutations fails it.

First paint, 600 KB of Markdown: Cocoa 1.86 → 1.24 s, X11 2.08 → 1.56 s.

### X11 startup font matching (ntk #381)

Five synchronous `fc-match` spawns sat on the first frame of the Markdown
mount, 613 ms. The one for regular text duplicated the connect-time
prewarm, whose answer reached only the event loop — held, for the whole
first frame, by the render that needed it. A prewarm now writes its answer
to files as well (shell builtins only), and a synchronous miss for a pattern
in flight waits on those instead of spawning; the default family's four
faces prewarm at connect, and any other family's four start together on its
first miss. The "prewarm children cannot be read in time" dead end of round
6 was right about the event loop and wrong about the answer: the file is
readable without it.

First paint on XQuartz: Markdown 1.53 → 0.99 s (with #704), `<Html>` 1.02 →
0.66 s, `<RichTextEditor>` 0.73 → 0.22 s, `<CodeEditor>` 0.33 → 0.18 s.

### `<Html>` edit and append (components #135)

Three quarters of an edit was CoreText setting paragraphs exactly as it had
the pass before. Text layouts are now kept under what went into them (runs,
styles, width, alignment), two generations deep. What had made them
unshareable was the element each run carried for hit testing, which pinned a
layout to its parse; the element is now found from where the run's text sits
in the document, which also made hit testing inside a paragraph work on the
Cocoa engine, whose runs come back without their spans.

An edit or an append to 670 KB of HTML: Cocoa 355 → 128 ms, X11 202 → 93 ms.

### `<Table>` jumps: nothing to fix

The probe jumps ten times a second, so 20–28 fps is two or three frames a
jump, at 8–14 ms each — the new window mounted and measured. The number read
like a problem because it was a frame rate of something that is not a
stream of frames.

## Round 8: the still-open list, second pass

### `<RichTextEditor>` bold over everything (components #136)

Bold over a document is one `AddMarkStep` per paragraph, and the block keys
mapped every changed block's start through the whole mapping: about 35 ms of
a 140 ms toggle at 600 KB. A mark step moves nothing — its step map is
empty — so a mapping made only of such steps is the identity, and the keys
now keep their starts without mapping them. macOS 143 → 128 ms, XQuartz 95
→ 72 ms. What is left is ProseMirror's `addMark`, React's render and the
visible blocks laid out again in bold, all of which the command needs.

### X11 reflow: the shaping memo (ntk #383)

Half of a Markdown reflow's text layout on XQuartz was the shaping memo's
own time: a key of seven concatenated fields for every word, hashed fresh,
and an LRU's delete-and-set on every hit. It is two generations of 4,000
words now — a hit is one lookup — and a style's words live under one key,
kept per style object, so a hit hashes the word alone. A reflow step at
600 KB: Markdown 264 → 232 ms, `<Html>` 339 → 253 ms. Cocoa's reflow is
CoreText setting every paragraph again, which this does not touch.

### `<CodeEditor>` repaints (components #137)

Every edit, caret move and caret-revealing scroll repainted the whole editor.
Three layers, each found by the one before:

1. **An edit claims its rows**: the edited lines, the caret's row and line
   number before and after, the selection's and the bracket pair's, and the
   rows below whose tokens the edit changed or moved. The first cut still
   painted 92% of the editor for a character, because it claimed both scroll
   thumbs' strips on every edit, and **core merges overlapping claims into
   the box around them** — a strip the editor's height beside a one-row band
   is the editor. A strip is claimed now only when what sizes its thumb
   changed, and only where no row already is.
2. **Revealing the caret is a blit**: a line down past the bottom, Enter at
   the end, a character past the right edge (where the region is the text
   area and the gutter stays). The rows that changed go to core as `pinned`
   rects (react-x11 #682), repainted where they land after the copy.
   Scroll offsets are snapped to whole device pixels: the line height is a
   measured, fractional number, so every reveal was a fractional shift, and
   a fractional shift is not a copy.
3. **A claim beside the region must not touch another one.** With the caret
   on the last row, the row's gutter piece overlapped the horizontal thumb's
   strip; merged, the two made a band that took in the region, and core
   refused every sideways blit. The pixel test could not see it — its
   sideways typing was never on the last row — and the probe's per-frame
   blit outcomes (`byKind`) did: 103 frames armed and declined.

A keystroke in view: 6.6 → 2.8 ms on macOS, 3.6 → 2.2 ms on XQuartz, from
0.97 of the window per paint pass to 0.08. Typing for four seconds, most of
it past the right edge: frame 5.1 → 1.6 ms and 3.5 → 1.7 ms. The caret down
past the bottom: frame 5.4 → 3.9 and 3.9 → 2.6 ms; what is left on macOS is
the scroll's double copy.

It moved master's floor to `^2.22.0` for the `pinned` argument — the move
#128 makes too, to the same lockfile versions. Every local run had passed
against a newer core than master's lockfile: the scratch worktree had it
installed `--no-save` for benchmarking, and CI's build failed on the call.

### `<CodeEditor>` far jump (components #138)

The first jump to the end of a freshly opened 50,000-line file tokenized
every line above it before the frame: 298 ms on macOS, 207 ms on XQuartz.
More than a thousand lines past the frontier, the stream engine now runs the
line from the furthest state it has within a hundred lines above it, or else
from the start state at the least indented of those lines (CodeMirror 5's
`findStartLine`), and walks the frontier there in the background, 500 lines
a turn. A guess is written as an ordinary state-and-tokens pair past the
frontier, so the convergence the engine already had keeps a right guess as
it is and tokenizes a wrong one again, and the host's `invalidate` repaints
it. The jump: 38 and 24 ms, the rest being the lines newly in view laid out.
Typing during the walk pays about 1 ms at the 95th percentile.

Deciding by distance rather than by trying matters: trying a thousand lines
first cost more than the guess. And the two bugs the mutation tests found
were the same bug twice — a pair whose state had been replaced without its
tokens going: an edit inside a guessed run, and a walk's turn ending on a
guessed line.

## Lessons

1. **Look for caches that never hit.** Identity-keyed caches handed a new
   object every time (`?? []`, runs arrays rebuilt in render); LRUs sized for
   a screen and used for a document (CoreText's 64 layouts, a 4,000-entry
   shaper cleared wholesale); keys that include something that always
   changes. Count hits before tuning anything else.
2. **O(document) per keystroke hides in bookkeeping**, not in rendering: the
   block keys, the line cache dropping everything after an edit, the history
   snapshots, a tokenizer that cannot converge. ProseMirror's structural
   sharing and a prefix/suffix scan make most of it O(change).
3. **Damage claims were the scroll problem.** Three separate core claims,
   each coarser than the change, each alone hiding the next. Count gate and
   poison outcomes per frame instead of timing frames.
4. **Whole pixels and one unit.** A fractional scroll offset declines every
   blit; device versus logical pixels decides whether a hit test is right at
   2x. Test at scale 2.
5. **Text engines pay per call for constants.** fontkit getters, a cmap
   lookup per word, bidi for Latin text. Profile by caller.
6. **Spread has a stack limit.** `splice(at, n, ...items)` throws past about
   150,000 items.
7. **Keep perf changes byte-honest.** Every blit and damage change here ships
   with a test comparing the frame to a full repaint of the same state, and
   each test was checked by breaking the code it guards.
8. **End a round with a sweep of everything, against the round's results.**
   Every change here was measured where it was made; only the final sweep
   asks whether a later one undid it — and it has to be read with reruns,
   because a sweep of 226 cells has a few outliers by construction.
9. **A cache whose entries carry identity cannot outlive what they were made
   for.** `<Html>`'s layouts could not survive a re-parse while each run
   named its element; moving the element out, and finding it from the
   document instead, made them content-keyed.
10. **A guard that is safe can still be useless — measure it before
    believing it.** The width pass's first safe rule stopped at every scroll
    pane, which is where documents live.
11. **Claim beside, never over.** Core merges overlapping damage into the
    box around it, so a strip beside a row, or a gutter piece touching a
    thumb's strip, becomes the whole region. Count what each frame's passes
    painted, and whether its blit happened, in the probe: a pixel test
    proves the frame right, not cheap.
12. **The tree you benchmark is not the tree CI builds.** A scratch
    worktree with a newer core installed `--no-save` runs every test
    against it; `npm ci` on the branch's own lockfile before pushing is the
    only check that the floor is what the code needs.
13. **A guess is safe when it is an ordinary cache entry.** The far jump's
    guesses are the same pairs convergence already reasons about, so the
    walk that corrects them is the one that already existed.

## Still open

Ordered by practical impact, after round 8.

- **Reflow** (both document components): the text engines shape again at
  every width. On XQuartz ntk #383 takes an eighth off Markdown's and a
  quarter off `<Html>`'s; on macOS, shape once and break many — a
  CTTypesetter kept per paragraph — needs an appkit native.
- **`<Markdown>` first paint** (1.24 s Cocoa, 0.99 s X11 for 600 KB): what
  is left is the height floors (~300 ms), React's render (~350 ms in
  development, less in production) and the layout.
- **`<Html>` edit and append** (128 ms Cocoa, 93 ms X11): the re-parse, the
  cascade and the box tree run whole; the text engine no longer does.
- **Cocoa scroll's double copy** (about 2 ms a frame at 2x, round 4) — now
  also most of what is left of `<CodeEditor>`'s reveal-scroll frames.
- **`<RichTextEditor>`**: large pastes (110–123 ms, mostly React's
  development render), and a very long paragraph, which `<richtext>` lays
  out whole on every keystroke.
