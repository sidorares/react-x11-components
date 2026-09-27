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
| ntk        | #383 the shaping memo in two generations, a style's words under one kept key      | released, 8.12.5    |
| components | #128 `<Flow>` GL renderer and its perf work, maps label shaping, lockfile         | open                |
| components | #130 a long flick keeps the virtual window to its budget                          | merged              |
| components | #131 code editor: long lines in pieces, scroll blit                               | merged              |
| components | #132 code editor: a wheel notch scrolls a notch                                   | merged              |
| components | #133 code editor: an edit costs the lines it changes                              | merged              |
| components | #134 rich text editor: a keystroke costs the block it lands in                    | merged              |
| components | #135 `<Html>`: an edit lays out again only the text it changed                    | merged              |
| components | #136 rich text editor: a mark over the document keeps its blocks' keys            | merged              |
| components | #137 code editor: a keystroke repaints its rows; revealing the caret is a blit    | merged              |
| components | #138 code editor: a line far past the frontier is answered from a guess           | merged              |
| react-x11  | #706 a scroll blit's band is copied once, as its frame takes its buffer           | released, 2.22.7    |
| react-x11  | #707 a paragraph laid out at another width reuses its typesetter                  | released, 2.22.7    |
| appkit     | #75 a paragraph's typesetter, kept; packed layout geometry                        | released, 0.14.0    |
| ntk        | #385 a shaped glyph carries the characters it was shaped from                     | released, 8.12.6    |
| components | #139 code editor: squiggles follow edits; what it paints stays true through them  | merged              |
| components | #140 `<Html>`: a resize lays the document out once a frame                        | merged              |
| appkit     | #77 a window shown taller than the screen says it is shown                        | released, 0.14.1    |
| components | #141 `<Html>`: a style is computed once per kind of element                       | merged              |
| components | #142 `<Html>`: a kept layout is found by comparing; a line height is kept         | merged              |
| components | #143 `<Markdown>`: a list item, its marker and a table cell without a box         | merged              |
| ntk        | #387 a paragraph laid out at another width keeps its tokens                       | released, 8.12.7    |
| appkit     | #79 the ungranted calendar reads are settled as they are asked for                | merged              |
| ntk        | #389 text under 64 characters does not go through the paragraph cache             | released, 8.12.8    |
| ntk        | #390 fc-match spawned by its path; a fallback asks for its face's pattern         | released, 8.12.8    |
| components | #153 `<Html>`: padded inline boxes as spacers; the walks the conformance added    | open                |

## Method

### The probes

Every number here comes from a probe: a small `.tsx` program that mounts one
component in a real window on the chosen backend, drives it with synthetic
input or data changes on a wall-clock timer, and prints one JSON line. They
live in `scripts/bench/sweep/`, with `run.sh` to run all of them on both
backends, `tabulate.ts` to print a run as tables or mark what moved against
an older one, and the final sweep's results (see the README there):

| Probe             | Component              | Actions (`ACTION=`)                                                                                                                          | Knobs                                                            |
| ----------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `matrix.tsx`      | `<Flow>`               | `pan`, `zoom`, `wheel`, `drag` over five scenes                                                                                              | `SCENE`, `NODES`, `GL`, `ZOOM`, `MAP`, `W`/`H`/`VX`/`VY`, `DIAG` |
| `mapsweep.tsx`    | `<Map>`                | `pan`, `drag`, `wheel`, `fly` over London z15                                                                                                | `RENDERER` (`retained`/`gl`), `DIAG`; tiles from `BENCH_TILES`   |
| `chartsweep.tsx`  | charts                 | `stream`, `pan1m`, `zoom1m`, `multiples`, `scatter`, `scroll`                                                                                |                                                                  |
| `tablesweep.tsx`  | `<Table>`              | `wheel`, `fling`, `thumb`, `jump` over 100k rows                                                                                             | `DIAG`, `PREFETCH`                                               |
| `docsweep.tsx`    | `<Markdown>`, `<Html>` | `mount`, `edit`, `append`, `scroll`, `reflow`                                                                                                | `COMP`, `SIZE` (sections), `PHASES`, `NO_FLOORS`                 |
| `editorsweep.tsx` | `<CodeEditor>`         | `mount`, `scroll`, `type-end`, `type-mid`, `type-start`, `undo`, `replace`, `long-mount`, `long-type`, `caret-down`, `enter-end`, `jump-end` | `COMP=code`, `LINES`, `LONG`, `PLAIN`                            |
| `editorsweep.tsx` | `<RichTextEditor>`     | `mount`, `scroll`, `type-mid`, `type-hidden`, `type-long`, `bold-all`, `paste`                                                               | `COMP=rte`, `SIZE`                                               |
| `docgen.ts`       | —                      | generates the test documents                                                                                                                 | deterministic by seed                                            |

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
first cost more than the guess. The mutation tests found two bugs that were
the same bug twice — a pair whose state had been replaced without its tokens
going: an edit inside a guessed run, and a walk's turn ending on a guessed
line. CI on Node 24 then found the opposite: tokens dropped before the line
ran again left nothing to compare with, so a guess corrected on the way was
never reported to the host.

## Round 9: the editor's correctness, the scroll copy, reflow

### `<CodeEditor>` correctness (components #139, ntk #385)

Not a performance change, but it came out of the performance work and used
the same tools. Two oracles do the checking. One is the tokenizer's state
after a random sequence of edits, compared with a fresh tokenization of the
text that results. The other is the editor's pixels after the same edits,
compared with a fresh editor showing that text with the same selection and
scroll, at 1x and 2x. Together they found:

- **Stale tokens.** An edit above the frontier took the tokens the background
  walk had left further down.
- **Missed repaints.** After an edit that moved the text's end up, the rows
  below the new end were not repainted.
- **Squiggles that stayed put.** Diagnostics now follow the text until the
  linter answers again.
- **A misplaced squiggle.** Drawn at the bottom of the row box rather than
  under the glyphs, it spilled into the next row.
- **An emoji's row.** Its taller layout set the text off the baseline every
  other row shares.
- **Long lines.** A selection band, a squiggle or a bracket highlight along a
  minified line threw out of the X11 paint past 32,767 pixels.
- **Full repaints.** A controlled editor repainted everything on every
  keystroke, and so did an inline `language` or `tokenStyles` object.
- **ntk #385.** A glyph that fontkit first created without its characters —
  drawing a composite `é` creates the `e` that way — put every caret after an
  `e` on that line one character off for the rest of the session.

The one CI failure is a lesson about the oracle. The squiggle-placement test
diffed a frame with the squiggles against one without, inside a rounded row
rect. With Linux's fractional line height, the row above inks the pixel row
the two share, so one squiggle's end showed up in the next row. It passed on
macOS, whose line height happened to round the other way. The test now draws
one squiggle at a time. The same failure reproduces here at font sizes 11,
13, 17, 19 and 21.

### The Cocoa scroll's double copy (react-x11 #706)

A scroll blit's frame wrote its band twice. The first draw of the frame took
a buffer and caught it up to the frame on glass; the catch-up owed the band,
because the frame before had blitted it too. Then `scrollSurface` moved the
band inside that buffer. Now a scroll that is its frame's first draw copies
the band across from the frame on glass already shifted, with appkit's
`blitSurface`, and the catch-up copies everything else. The result is every
pixel the two passes produced, the strips the shift exposes included.

| scroll, Cocoa 2x                    | copies per frame | flush p50      |
| ----------------------------------- | ---------------- | -------------- |
| `<CodeEditor>`, 50,000 lines, wheel | 2.09 → 1.61 ms   | 4.00 → 3.72 ms |
| `<Markdown>`, 600 KB, wheel         | 1.44 → 1.01 ms   | 6.02 → 5.55 ms |
| `<Table>`, 100,000 rows, wheel      | 1.15 → 0.99 ms   | 2.66 → 2.68 ms |
| `<Flow>`, a pan of the cards scene  | 1.36 → 0.80 ms   | —              |

What is left is the band copy itself, and it runs at a fifth of the speed a
benchmark of it shows. A 15 MB copy between two IOSurfaces takes 0.34 ms
back to back, 45 GB/s. One copy every 16 ms, with the thread asleep in
between, takes 1.8 ms at the median and 4 ms at the 90th percentile, and
that is the rate the frames saw. It is not the IOSurface: plain `malloc`ed
memory behaves the same. It is not QoS: user-interactive and utility measure
alike. And it is not the core: splitting the rows over eight GCD threads
halves the loop and leaves the paced copy where it was. The memory system
slows down while the thread idles, and a copy made once a frame pays for
waking it. The only lever is copying fewer bytes.

### `<Html>`: three document layouts a frame (components #140)

A frame of a window resize laid a 600 KB `<Html>` document out three times.
The first pass was at the new width. Then came core's height-floor probe,
which asks every leaf for its height at the width it was last measured at as
well as the one it has now (`probeHeightFloors`, whose comment expects "a
paragraph answers from its layout cache"). The document answered by laying
itself out at the old width. Then yoga's next pass asked for the new width
again. `TextLayoutCache` kept two generations and rotated them once a pass,
so each pass missed what the one before had dropped. The stacks in
`createLayout` gave it away: 65,337 calls for 25,769 distinct text-and-width
pairs. The element now keeps the size each of its last four widths came to,
until anything a layout reads changes. A reflow step: 573 → 196 ms on macOS,
256 → 86 ms on XQuartz.

### Cocoa reflow: the typesetter, kept (appkit #75, react-x11 #707)

Timed inside `createLayout` over a 600 KB reflow:

| part of `createLayout`                   | `<Markdown>` | `<Html>` |
| ---------------------------------------- | ------------ | -------- |
| the attributed string from the spans     | 30%          | 27%      |
| `CTTypesetterCreateWithAttributedString` | 37%          | 40%      |
| breaking lines, the `CTLine`s and runs   | 16%          | 16%      |
| the result's objects                     | 17%          | 17%      |

The first two are the same at every width. appkit now returns a paragraph's
typesetter on request (`keep`) and lays out from it (`typesetter`), and it
can return the geometry as two `Float64Array`s (`packed`). Core's CoreText
engine keeps up to a megabyte of text's worth of typesetters, keyed by
everything shaping reads. It also stopped building a code point table for
text with no surrogate pair. A short paragraph costs 34 µs from its spans,
16 µs from its typesetter and 8.6 µs packed.

| 600 KB, Cocoa | reflow step, before | kept typesetters | with #140 too |
| ------------- | ------------------- | ---------------- | ------------- |
| `<Markdown>`  | 335 ms              | 228 ms           | 227 ms        |
| `<Html>`      | 574 ms              | 273 ms           | 94 ms         |

First paint improves too, because a paragraph's max-content measurement and
its wrapped layout are now one shaping: Markdown 1255 → 1174 ms.

### What is left of a Markdown reflow

Per frame at 600 KB, X11 / Cocoa, in ms:

| phase                                   | X11 | Cocoa |
| --------------------------------------- | --- | ----- |
| the first layout pass, at the new width | 104 | 194   |
| height floors measured after the probe  | 32  | 46    |
| the second pass, with the new floors    | 38  | 39    |
| absolutize                              | 26  | 40    |

These Cocoa times are from before the kept typesetters; they cut the first
pass. The second pass lays out 13,000 nodes again because the floors that
emulate CSS's `min-height: auto` come from the previous layout. At a
narrower width the content is taller than the old floors, and the first pass
shrinks paragraphs toward them. A live resize on Cocoa already skips the
measurement until the drag ends (`_deferContentFloors`). A split pane or a
sidebar drag, which changes a document's width without resizing the window,
takes the measured path every frame. The fix would be yoga knowing
content-based minimum sizes itself.

### Regression check

Every Cocoa probe of the maps, the charts, the table, the documents and the
editors — 48 cells — ran twice. The first pass used master's files and the
second the four changes, with the appkit #75 build under both. Nothing moved
the wrong way beyond the noise. What moved the right way: Markdown reflow
344 → 229 ms, `<Html>` reflow 584 → 94.8 ms (1.6 → 8.7 fps), and `<Table>`'s
jump frame 15.3 → 13.4 ms. First paint moved inside the noise but the same
way the A/B had it: Markdown 1238 → 1175 ms, `<Html>` 557 → 511 ms. One cell
read the wrong way, the editor's scroll, at 3.47 → 4.29 ms a frame in one
run each. Four interleaved runs of that cell alone read 3.90 → 3.76, with
the change ahead in all four pairs.

## Round 10: a window that never drew, the handle, `<Html>`'s passes

This round ran on a different display arrangement from the ones before it
(the last section says how), so its Cocoa numbers are compared with each
other and not with the final sweep's.

### A window taller than the screen drew nothing (appkit #77)

The worst cell of the regression check: `<Flow>`'s GL renderer drew 0 fps
in the stress example's 1686×1180 view on Cocoa, where the final sweep had 120. With a worker thread, react-x11 reads a window's visibility from the
copy the UI thread published last, and defers the frames of a window it
cannot see until an event says the window is back. The event that usually
says so is AppKit's own: the move that follows ordering the window in. A
window taller than the main display, now the built-in 1728×1117-point panel,
is constrained while it is ordered in, so its resize and move both fire
before it is visible, and nothing fires after. The published copy turned
visible with no event, and the frame queue waited indefinitely. 2D content
survived, because it paints on input; a `<glarea>`'s frames only run from
the queue.

`showWindow` now sends `window-shown` once it has published. react-x11
needed no change: it ignores event types it does not know, and every batch
it receives ends with a frame tick and a present. A bare `<glarea>` in a
constrained window: 0 → 351 frames in 3 s; with 0.14.1 in the lockfile, the
stress view's two GL cells draw 119.7 and 120 fps again.

### `<Flow>`: a programmatic pan's bodies (components #128)

The check's other Cocoa regression, the widgets scene panned at zoom 1:
93–95 fps under the September 25 core, 81–83 under 2.22.7. Toggling each
change of the release put it on react-x11 #706, 91 against 82 fps, and yet
#706 had made every blit frame cheaper. A decline counter in
`_applyScrollBlits` explained it: with #706, 22% of the pan's frames
declined the blit, up from 12%, and every extra one was `layoutMoved`.

The probe pans the way an animation does, `setViewport` a step a frame. The
pane moved at once; the box the mounted bodies ride in moved through React,
on React's schedule, and caught up in jumps of several steps. A rider that
moves by more than the blit shifts is a layout move, and core repaints the
pane whole for it. #706 had only made the frames come sooner, which left
React further behind. A gesture's emissions already committed inline;
calls through the handle now do too, and from inside a commit, a pan from a
layout effect, the reconciler defers that flush to the commit's end by
itself.

| widgets pan, zoom 1       | before      | after           |
| ------------------------- | ----------- | --------------- |
| Cocoa                     | 81–86 fps   | 110.5–110.9 fps |
| Cocoa, p95 frame interval | 26 ms       | 10 ms           |
| Cocoa, `layoutMoved`      | 57–71 a run | none            |
| XQuartz                   | 65–66 fps   | 65–66 fps       |

XQuartz never declined: its frame clock left React time to commit.

### `<Html>`: a style per kind of element (components #141)

With #140 in, a third of an edit to the 600 KB report was the cascade: a
style computed for each of 9,039 elements, in a document with 110 kinds of
element. `Cascade.sharedStyleFor` hands one
computed style to every element in a build that must compute the same one.
A style depends on the parent's style, the rules that match, the
presentational attributes, the inline style and whether the parent is a
flex container, and unless a rule reads siblings, position or contents,
what matches depends only on the element's tag and attributes and its
ancestors'. So the key is the parent's key, the flex flag, the tag, every
attribute and, where a rule reads it, the pointer state; an element whose
key was seen earlier in the build takes that style and matches nothing.

The rules that do read siblings, position or contents opt their elements
out of that, and the first version gave each such element a key of its
own. That lost the subtree as well as the element, since children share
under their parent's key: the test document, whose sheet has seven such
rules, computed 473 styles for 497 elements. Now such an element is matched
and then shared by what it matched, so a striped table's cells come in two
kinds and what is inside them keeps sharing. The report computes 110
styles, and 112 with its tables striped, where the builds before computed
9,039.

The test is an oracle: the same document built twice, once shared and once
with every style computed alone, and every box's style compared. Four
mutations each fail it: dropping css-select's aliases for positional
pseudo-classes from the opt-out pattern, sharing everything, leaving the
pointer state out of the key, and leaving the parent's key out.

### `<Html>`: finding a kept layout, and a line height (components #142)

With #141 in, a Cocoa profile of an edit was led by the text layout cache's
own bookkeeping. A pass asks the cache for 8,828 layouts of 15,410 runs,
and each key spelled out every field of every run, the block style and the
options: 2.95 M characters a pass, built, hashed and compared in two maps,
for a pass that misses about once. A layout is now filed under its width and
its text, 0.64 M characters a pass, and found by comparing the rest field
by field against a copy kept with it. The natural line height a
`line-height: 1.5` is converted against is kept per style too: every
paragraph asked for it, and on CoreText every answer was a call to the
native side.

| 600 KB `<Html>`, flush p50 | master     | #141     | #142     | both     |
| -------------------------- | ---------- | -------- | -------- | -------- |
| edit, Cocoa                | 111–114 ms | 76 ms    | 85–87 ms | 50–51 ms |
| append, Cocoa              | 118–119 ms | 82–86 ms | 92–93 ms | 55–56 ms |
| edit, XQuartz              | 79–82 ms   | 52–55 ms | 69–73 ms | 43 ms    |
| append, XQuartz            | 87–90 ms   | 58–60 ms | 76–78 ms | 48 ms    |
| reflow, Cocoa              | 195–196 ms | —        | 175 ms   | —        |
| reflow, XQuartz            | 116–123 ms | —        | 104 ms   | —        |

Each column is its own interleaved A/B against master, three runs a state.
These trees ran react-x11 2.22.6, so the Cocoa reflow is without 2.22.7's
kept typesetters. With both, an append on XQuartz paints 15 frames a second
of the probe's 20 appends, where it painted 9.

### The machine, rearranged

The Mac's main display changed between round 9 and this one: the built-in
1728×1117-point panel, with two 2560×1440 monitors beside it. That did more
than constrain one window. `<Table>`'s fling frame reads 7.0 ms
under today's core and 7.0–7.2 under the September 25 one, against 4.9 ms
in the final sweep, so the difference is the machine and not the code.
Before believing a regression, rerun the old tree on the machine as it is
now; a Cocoa window's backing scale, and which display it opens on, are
part of what a probe measures.

## Round 11: fewer boxes, kept paragraphs

### `<Markdown>`: a box less per list item, marker and cell (components #143)

A Markdown reflow frame is mostly core's layout machinery: yoga's passes,
the height floors measured after them and absolutize, each over every node.
The 600 KB report was 14,717 nodes, and 4,808 of its 7,186 boxes held one
child — a box around every list marker, a column around every list item's
one paragraph, a padded box around every table cell's text. The marker is
now its own `<text>`, an item of one paragraph is the paragraph, and a cell
is its `<richtext>` with the padding as margins, since the row paints the
background a cell box never did. 10,188 nodes, and 279 single-child boxes.

Nine documents at three widths and both scales rendered byte-identically
before and after, 54 frames, and a copy of lists and tables gave the same
text. The two structure tests fail against master.

| 600 KB `<Markdown>`  | before      | after       |
| -------------------- | ----------- | ----------- |
| reflow, Cocoa        | 331–333 ms  | 274–276 ms  |
| reflow, XQuartz      | 256–281 ms  | 204–207 ms  |
| first paint, Cocoa   | 1,225–1,234 | 1,042–1,080 |
| first paint, XQuartz | 979–1,003   | 812–834     |
| scroll frame, Cocoa  | 5.95 ms     | 4.93 ms     |

These trees ran react-x11 2.22.6, so the Cocoa reflow is without the kept
typesetters.

### ntk: a paragraph laid out at another width keeps its tokens (ntk #387)

Timed inside `TextLayout` over an XQuartz reflow: 62% of its time was the
part no width decides — the spans normalised and their faces resolved, the
bidi levels, the UAX#14 tokens shaped — done again for every width. The
font manager now keeps a paragraph up to the line fill, found by its text
and direction and by every field of its spans and base style, for two
generations of 512K characters. It is appkit #75's kept typesetter, for
the other text engine.

The first cut cost `<Markdown>`'s first paint 40 ms. The mount made 13,574
layouts and only 3,816 preparations, and the hits were list markers, whose
preparation costs nothing; meanwhile every lookup built its key by
concatenation, a new string to flatten and hash. Remembering the key per
span list — the list a caller lays out at many widths is one object — put
the first paint back where it was.

| 600 KB, XQuartz          | before     | ntk #387   | with #143 too  |
| ------------------------ | ---------- | ---------- | -------------- |
| `<Html>` reflow          | 85–87 ms   | 42 ms      | —              |
| `<Markdown>` reflow      | 222–225 ms | 161–170 ms | 102.5–103.3 ms |
| `<Markdown>` first paint | 931–947 ms | 956–960 ms | 767–779 ms     |

### appkit's CI on main

Two different failures on the Node 26 leg of `main`, neither from the change
merged before it. `test/calendars.js` started both ungranted reads and
awaited them in turn, so a second rejection that came first had no handler
and ended the process; it settles each answer as it asks now (appkit #79).
`threaded-verbs` once waited 5 s for an app-modal panel cancelled 300 ms
after it was asked for: a `cancelPanel` that reaches the UI thread before
the panel's modal session has begun stops nothing. That one is open.

## Round 12: small cases first

The rule this round was set by: **an optimization found through a stress
case must cost next to nothing at small scale, or stay off until the scale
that needs it is there.** The stress probes exist to make everyday use
smooth, not to make the stress cases a little faster. So every change below
was measured at an everyday size as well — short labels, a 20 KB page, a
500-line file, a 30-node graph — and the round's sweep ran both scales:
`matrix.tsx` takes `NODES` for the lattice's size, and the everyday cells
are `SIZE=10` documents, `LINES=500` and `NODES=30`.

### `<Flow>`: an animated zoom holds its bodies (components #128)

A zoom stepped by an app's animation — `setViewport` a frame at a time —
ran at a fifth to a third of a wheel zoom over the same graph. The pane
already treats zoom steps under 120 ms apart as a stream for its picture
and its scaled labels, whatever sent them; only `_holdBodies` still asked
whether the step was a gesture, so every mounted body was re-scaled at every
frame of an animation. A stream now holds them as a gesture does. A single
jump still applies at once, and bodies that fit the frame's budget still
zoom live, so a graph with a few of them is exactly as it was. Round 1
listed it as by design; nothing else in the pane told an animation from a
gesture.

| animated zoom, stress scenes | before  | after     |
| ---------------------------- | ------- | --------- |
| XQuartz, widgets             | 26 fps  | 40 fps    |
| XQuartz, charts              | 12 fps  | 43 fps    |
| Cocoa 2D, widgets / charts   | 16 / 11 | 41 / 42   |
| Cocoa GL, widgets / charts   | 31 / 26 | 117 / 114 |

### `<Flow>`: a zoom's picture only for a graph that needs one (components #128)

The zoom picture (round 1) paints the graph once onto an offscreen surface
and composites it scaled at every step. It was measured on the 200-node
lattice and the stress example, and it was on for every graph. On a 30-node
graph it was the slowest thing in the zoom: at 2x on macOS the composite is
~20 ms a step whatever the graph, where the graph paints live in 5–9; on
XQuartz each picture painted again was a stall, and the zoom's
95th-percentile frame was 58–59 ms. And it held a surface the size of the pane, 15 MB for a
1200×800 pane at 2x, for every zoom.

Where the line falls was measured rather than chosen: the same zoom with
the picture forced off and forced on, by the lattice's size.

| lattice, live / picture | XQuartz                           | macOS                                |
| ----------------------- | --------------------------------- | ------------------------------------ |
| 30 nodes                | 56 / 64 fps, p95 22 / 58 ms       | 88 / 45 fps, p95 15 / 35 ms          |
| 100                     | 28–29 / 38 fps, p95 43 / 105 ms   | 38–43 / 43–44 fps, p95 27–34 / 37 ms |
| 200                     | 22–23 / 32–33 fps, p95 54 / 96 ms | 31–32 / 41 fps, p95 35 / 40 ms       |
| 400                     | 18 / 32 fps, p95 71 / 136 ms      | 26 / 39 fps, p95 45 / 46 ms          |

On macOS the two meet where painting live costs what the composite does,
about 20 ms. On XQuartz the picture always draws more frames and always
stalls longer, so there it is a trade at every size. A frame at 60 Hz as
the line keeps live every graph that paints within a frame, and gives the
picture, as before, to every graph that does not.

A zoom now composites a picture only once painting the graph whole has cost
more than 16 ms, and paints live again under 12. It judges on the median of
the last five whole paints: the steps of a zoom painted live, and the
pictures' own paints less their ground. The first cut read a running mean
of a zoom's paints and went wrong three ways. A zoom's first step sets every
label at its new size, which the steps after it do not, and one slow first
step sent a thirty-node graph on macOS to the picture for a whole
animation. On XQuartz the live steps of the same graph run 8–18 ms, and a
run of slow ones crossed the line on one run in three. And a picture's own
paint draws its ground as runs where the window has a tile, half as dear
again as a step on X11, so a picture made by mistake measured itself as
worth keeping. The first step is left out now, the median takes five, and
a picture's paint is timed without its ground.

| 2D zoom, lattice            | before               | after                   |
| --------------------------- | -------------------- | ----------------------- |
| 30 nodes, macOS, animated   | 46 fps, p95 34–35 ms | 92–94 fps, p95 13–14    |
| 30 nodes, macOS, wheel      | 59–61, p95 32–34     | 100–101, p95 13         |
| 30 nodes, XQuartz, animated | 63–65, p95 57–60     | 55–56, p95 22           |
| 30 nodes, XQuartz, wheel    | 77–78, p95 29–32     | 61–62, p95 22           |
| 100, 200 and 2,000, both    | a picture            | a picture, within noise |

The thirty-node graph on XQuartz draws fewer frames live, each a 9 ms paint
where a composite was 1, and none of the 60 ms stalls a picture's repaint
was. A picture is also 15 MB of surface for a 1200×800 pane at 2x that a
small graph no longer holds.

### ntk: short text does not go through the paragraph cache (ntk #389)

Round 11's kept paragraphs (ntk #387) halved a large document's resize, and
cost every short text layout about a microsecond — a lookup, a copy of its
spans and an entry — on text a UI lays out once. Measured on a warm font
manager: 2,000 labels mounting went from 7.7–8.3 to 9.7–10.3 ms, a ticking
counter 20–30% slower, two-span labels likewise. Text under 64 characters
now skips the cache entirely and takes the path it took before; documents
keep their resize (Markdown 101–105 ms against 103–107, `<Html>` 38 against
34–38) and their first paint.

What the kept paragraphs cost in memory is now said where they are
described: about 60 bytes a character of kept text, 36 MB for a 600 KB
document with its layouts held, a few megabytes for a page, and nothing for
a UI's labels.

The same check on the other kept things this sweep added:

- **Core's kept CoreText typesetters (react-x11 #707)** cost small cases
  nothing: 2,000 labels mount in 24.5–25.3 ms against 25.2 before, and the
  packed geometry makes two-span labels faster (37 against 40 ms).
- **`<Html>`'s style sharing and compared layouts (#141, #142)** make a
  five-section document faster, not slower: an edit 12.0–12.5 → 10.1–10.4 ms
  and first paint 81–86 → 73–77 ms on macOS, an edit 8.1–8.4 → 7.2–7.3 ms on
  XQuartz.
- **The code editor's pieces and the virtual windows** are gated by size
  already: a line is cut into pieces past 2,048 characters, and `<Tree>`,
  `<Table>` and `<RichTextEditor>` draw a window past 200 rows or blocks.

### ntk: `fc-match` by its path, and a fallback's pattern (ntk #390)

A 20 KB HTML page took 384–416 ms to its first paint on XQuartz, against 88
on macOS. Half of it was two synchronous `fc-match` runs inside the first
text layout, 92 and 93 ms each.

The first was a fallback asking for a pattern nobody had fetched.
`fallbackFor` passed the span's raw weight and style — undefined for
regular text — where `match` and the prewarm normalised both, so the first
character a face lacked spawned `fc-match` for a pattern that fontconfig
answers with the list already in hand. Both build the pattern in one place
now.

The second was the spawn itself. By its bare name, `fc-match` is found by
`posix_spawnp`, which on macOS tries each `PATH` directory ahead of the
one that holds it; seventh on this machine's `PATH`, a spawn took 45–65 ms
where the same spawn by its path takes 12–16. The open-file limit had
nothing to do with it. ntk looks the path up once per `PATH` value, and a
missing fontconfig reports as it did.

| XQuartz first paint, median of five | before | after  |
| ----------------------------------- | ------ | ------ |
| a 20 KB HTML page                   | 416 ms | 232 ms |
| the same content as Markdown        | 183 ms | 184 ms |
| a 500-line code editor              | 175 ms | 177 ms |
| a small rich text editor            | 220 ms | 220 ms |

The last three make no synchronous spawn at their first paint, so #390
leaves them where they were; the code editor waits on a prewarm instead,
which the spawn log #390 was measured with did not see (see "The everyday
sweep"). The page's other `fc-match`, for the weight 600 its table headers
use, is outside the four prewarmed faces and still spawns — in 24 ms rather
than 93.

### The everyday sweep

The small cells of the round's sweep, before the two changes above:

| everyday cell                       | XQuartz                | macOS                  |
| ----------------------------------- | ---------------------- | ---------------------- |
| 20 KB `<Markdown>`, first paint     | 177 ms                 | 116 ms                 |
| …an edit / a reflow, a frame        | 2.4 / 3.7 ms           | 3.1 / 7.5 ms           |
| 20 KB `<Html>`, first paint         | 384 ms (232, #390)     | 88 ms                  |
| …an edit / a reflow, a frame        | 8.1 / 3.3 ms           | 10.9 / 4.9 ms          |
| 500-line code editor, first paint   | 165 ms                 | 65 ms                  |
| …a keystroke, input to screen       | 3.4–3.8 ms             | 4.7–6.5 ms             |
| 20 KB rich text editor, first paint | 217 ms                 | 180 ms                 |
| …a keystroke, input to screen       | 3.8 ms                 | 4.6 ms                 |
| …select all and bold, a frame       | 28 ms, 61 ms to screen | 40 ms, 81 ms to screen |
| 30-node `<Flow>`, pan               | 83 fps                 | 120 fps                |
| a city `<Map>`, pan (GL)            | 86 fps                 | 117 fps                |

Everything a keystroke or a scroll does is a few milliseconds at this size.
Two things are not, and both were taken apart and left open:

- **First paints on XQuartz.** A 500-line code editor's first frame is
  143–158 ms against 30–32 on macOS, and 104–110 ms of it is one wait: the
  first layout of monospace text asks fontconfig for the family, and ntk
  starts `fc-match` for its four faces and waits on the one asked for — the
  code's highlighting asks for bold as well. Launched at that moment, from
  the app, `fc-match` takes 80–150 ms; launched from a small process it takes
  20, and launched from a worker thread every 70 ms through the same mount
  it stayed near 10. It spends that time waiting — its CPU time and its
  instructions are a fast launch's, with no page faults — and neither its
  priority nor an idle gap accounts for it. Sans-serif hides the same cost
  because ntk starts it while the X connection is set up; warming monospace
  there too took 7–10 ms off, since the bold face was still asked for, and
  warming all four would cost every app four processes it may never need.
- **Bold over a whole small document** in `<RichTextEditor>`: 55–57 ms to
  the screen on XQuartz and 71–72 on macOS in React's production build,
  66–88 in development, where React's component tracks — a
  `performance.measure` per component — are part of the difference. Per
  toggle on macOS: 22 ms of React, 21 of layout — every paragraph set again
  in bold, the ones off screen included, below the 200 blocks at which the
  editor draws a window — 13 of paint, mostly the selection's band over
  every line, and 2.5 of ProseMirror. Every block really changed; none of it
  is waste.

A small Markdown page's scroll reported a 95th-percentile latency of 110 and
260 ms. That is the probe: a page that short reaches its end inside the
probe's 90 notches, and a notch at the end paints nothing, so its latency
runs to the frame after the scroll turns round.

### Parked: Markdown's second layout pass

Every react-x11 node may shrink, and core emulates CSS's `min-height: auto`
with measured floors; a width change re-wraps paragraphs, so the floors are
measured again and the tree laid out a second time. Skipping it safely needs
core to prove a subtree cannot be squeezed — an auto-height column under a
scroll port — which is new analysis inside the floors system, not a
workaround, and the other route is yoga itself. The one cheap lever, core's
floors deferred through a live resize, has no signal to key on under X11.
Parked, as asked, in favour of the rest.

## Round 13: what correctness cost

Between rounds 12 and 13, `<Html>` went through five rounds of CSS 2.1
conformance work: #144 to #148, merged, and #152 and #153, open. It passes
4,739 of the suite's reftests on X11 where it passed 1,831
(`docs/html-conformance.md`). This round measured what that cost the sweep's
documents and won most of it back, in #153.

**One core for both sides.** This branch's tree runs react-x11 2.22.7 and
@windowkit/appkit 0.14.1, and the conformance branches run 2.22.8 and 0.15.1.
The newer pair's half-leading, trailing-space widths and span-hung runs move
macOS text numbers on their own. So every comparison here is between copies
of one tree that share its `node_modules` and differ only in `src/html`, run
interleaved. The first comparison, across the two trees, blamed the
conformance work for a 28% slower macOS resize, part of which was the core's.

| `<Html>`, same core     | before round 1       | round 5      | after #153       |
| ----------------------- | -------------------- | ------------ | ---------------- |
| 600 KB, a resize frame  | 47 / 82 ms           | 124 / 172 ms | 49 / 89 ms       |
| 600 KB, an edit's frame | 45 / 51 ms           | 57 / 65 ms   | 44 / 51 ms       |
| 600 KB, first paint     | 424–429 / 464–477 ms | 549 / 581 ms | 461–468 / 509 ms |
| 20 KB, an edit's frame  | 7.9 / 11.4 ms        |              | 9.6 / 12.5 ms    |
| 20 KB, first paint      | 224 / 89 ms          |              | 227 / 98 ms      |

XQuartz first, then macOS. Round 5 is the conformance branch before #153's
performance commits, measured against it in the same way.

### A padded inline box leaves its paragraph one layout (components #153)

Round 3 of the conformance work gave inline boxes their padding, borders
and margins. Those take room on a line, which one layout of a paragraph's
text cannot give them, so any edge sent its paragraph down the path that sets
a line at a time: a layout per line and per box, five for a paragraph with
one inline `<code>` in it. That was the whole of the resize regression. Where
nothing on the lines has to be placed a piece at a time (no atomic, float,
`text-indent` or right-to-left text), each edge now goes into the one layout
as a no-break space in the paragraph's face, letter-spaced to the edge's
width. The line records where its spacers are, and the caret, the hit test
and the selection step over them.

### The walks the conformance added (components #153)

The rest was many small things, which no profile ranked on its own:

- a box handing its children the height their percentages resolve against,
  on every pass, for every block;
- a table's grid, worked out on every pass and again for its collapsing
  borders;
- the document's height, a walk of its own after the bounds walk;
- the relative-position walk, in documents with nothing relative in them;
- `!text.trim()`, which copied every paragraph's text that ended in a space;
- the kept layouts, filed under their whole text, which a pass built,
  flattened and hashed for every layout.

Each now runs only where it can change something, or is folded into a walk
already being made. They took an edit at 600 KB from 48 to 44 ms on XQuartz,
and a mount's CPU on macOS from 1,057 to 926 ms.

Three things made them hard to find:

- **tsx keeps function names.** The probes run `src` through tsx, which
  wraps every named arrow function in `__name` as it is made. A closure in a
  hot function showed up as `__name` time that the published build does not
  have.
- **The first reader of a box pays for it.** A walk that visits the children
  before the layout does takes on the cache misses the layout used to take,
  so profile deltas moved between functions without adding up. A
  self-time diff between trees is a map of where the misses landed, not of
  what got slower.
- **The size of a box matters.** Fifteen fields added to the old `Box` and
  never read made the first paint 6.6% slower on XQuartz. Moving eleven of
  them to side objects that only list items, absolute boxes and decorated
  inline boxes allocate was measurable only together with the walks.

Two costs remain. On macOS the spacers are text, about 1,600 runs at
600 KB, and CoreText's layout time grows with them by about 5%, 12 ms of a
mount. At 20 KB an edit still costs 1.1–1.7 ms more than before round 1.
That is chips, collapsed borders and clips the old renderer did not draw,
spread thin, and the incremental rebuild under "Still open" is where it
goes.

### The sweep

`run.sh` against round 10's full sweep, and the small cells against round
12's. Everything `<Html>` does got faster from input to paint: an edit from
95 to 65 ms on XQuartz and from 126 to 72 on macOS, an append from 97 to 61
and from 127 to 69, a reflow from 95 to 53 on XQuartz. Rounds 11 and 12
account for most of `<Markdown>`'s gain, a reflow from 235 to 110 ms on
XQuartz. Every cell the tabulation flagged turned out to be something else
when measured again:

- `<Flow>`'s widgets and charts wheel zooms on macOS, 12% down against
  round 12, run the same on core 2.22.7 and 2.22.8 when interleaved. The
  sweep's difference was between runs.
- `<Table>`'s fling on macOS, 101 → 78 fps against round 10, is bimodal on
  both cores: a run lands at 98–99 fps or at 78–80, whichever tree it is.
- The flow cells down against round 10 and not against round 12 (a fanout
  wheel, a 2,000-node zoom, a charts drag on XQuartz) moved between those
  two rounds, before any of this one's changes.

One bug turned up that is not this package's: CoreText draws letter-spaced
text that opens a line after a hard break one device pixel left of where it
reports it. A `<span style="letter-spacing">` does the same. It costs
`<Html>` one reftest on macOS, and an issue for windowkit/appkit is drafted.

## Round 14: what correctness cost, again

Between rounds 13 and 14, `<Html>` went through seventeen more rounds of
conformance work, #154 to #179. It passes 5,370 of the CSS 2.1 suite's
reftests on X11, where it passed 4,739 after #153, and it now reads custom
properties, `calc()` and CSS Color 4's colours (`docs/html-conformance.md`).
This round measured what that cost, the same way as round 13: copies of one
tree that share its `node_modules`, differ only in `src/html`, and run
interleaved.

Little of it was measurable. An edit at 600 KB was 2.1 ms slower on XQuartz
and 1.3 ms slower on macOS, and the profiles put most of that in the paint.
Finding out why the paint had grown showed that it had always cost far more
than it should.

| `<Html>`, same core     | after #153     | before this round | after          |
| ----------------------- | -------------- | ----------------- | -------------- |
| 600 KB, an edit's frame | 44.6 / 51.5 ms | 46.7 / 52.8 ms    | 42.4 / 51.3 ms |
| 600 KB, a scroll frame  | 3.2 / 4.3 ms   | 3.5 / 4.0 ms      | 1.2 / 2.9 ms   |
| 600 KB, scrolling's CPU | 33 / 34%       | 34 / 33%          | 19 / 25%       |

XQuartz first, then macOS. Medians of three interleaved runs.

### A link stretched its paragraph to the top (components #180)

The paint pass skips a subtree whose ink bounds miss the damage. A box with
64 children or more also keeps them sorted by where their ink starts, so a
viewport's worth of them is a binary search away. The hit test a selection
drag runs, and the search for the element under the pointer, use the same
bounds.

`computePaintBounds` took every child's bounds into its parent's, an inline
box's too. An inline box has no rectangle of its own: its text is drawn on
its block's lines, which the block's bounds already hold, and its position
and size are never laid out. They stayed at zero. So every block with a
link, an `<em>` or a `<code>` in it had ink reaching up to the top of the
document, and a `<col>` did the same to its table.

The index then sorted every section of the sweep's report at zero, and a
paint low in the document went through every block above the viewport.
Averaged over a scroll, that was 1,115 blocks and 8,154 children a frame,
where the viewport holds about 80 blocks. This was in the component's first
version, so every round before this one measured with it.

A box with no rectangle of its own now takes only the bounds of what it
holds that is placed: an inline-block, an image or a float. It has none
where it holds nothing. On the built package, over the 600 KB report:

|                                      | before        | after          |
| ------------------------------------ | ------------- | -------------- |
| a viewport's paint, glyphs not drawn | 0.31–0.35 ms  | 0.047–0.054 ms |
| the hit test of a selection drag     | 0.011–0.14 ms | 0.002–0.007 ms |

Both the hit test's old cost and its new one depend on where in the
document the pointer is.

### The walk into inline boxes (components #180)

The conformance work's round 12 (#164) laid out floats and absolute boxes
inside inline boxes. It found them by walking into every inline box of
every paragraph, before the line breaker walked them again. The box builder
now notes whether any float or out-of-flow box sits in an inline box.
Layout goes into inline boxes to find them only in a document where one
does.

### Custom properties as a chain (components #180)

Round 21 (#178) gave each element that sets a custom property a copy of
the map it inherits, with its own added. Under a design system's theme,
three hundred properties on `:root` as Tailwind 4 writes one, each element
whose utility class sets properties of its own paid for a copy of three
hundred.

An element's custom properties are now a link to its parent's, with its own
on top. The chain is folded into one map every sixteen links, so a lookup
stays short. A `var()` is also replaced once for each set of properties it
is read against, not once per element: the elements under one that sets
properties share its set.

Restyle and box build of a page of 2,000 elements, on the built package:

|                                                | before     | after      |
| ---------------------------------------------- | ---------- | ---------- |
| 50 classes, their colours from `:root`         | 1.8–2.0 ms | 1.8–2.0 ms |
| a 300-property theme, each class setting two   | 3.1–3.3 ms | 2.2 ms     |
| the same, each element setting one more inline | 50–52 ms   | 19 ms      |
| the values written out, no custom properties   | 1.8 ms     | 1.7 ms     |

### Measuring the built package

The sweep's probes run `src` through tsx, and round 13's first trap was
here again. `paintBorders` made a closure for every box it was asked about,
bordered or not, and tsx's `__name` wrapped each one: 17% of a profile of
the paint, which the published build does not pay. The closure is still
there for a box with a border, but a box with none now returns before it is
made. The paint, hit test and custom property figures above come from the
probes pointed at `dist/` after `npm run build`. The sweep's own cells run
`src`, which is why they are compared only with each other.

### The sweep

The changes are all in `<Html>`, so its cells were run against the tree
before them, interleaved, rather than the whole sweep again. Everything
moved the right way or stayed where it was:

|                           | before         | after          |
| ------------------------- | -------------- | -------------- |
| 600 KB, a reflow frame    | 44.0 / 87.7 ms | 40.1 / 86.4 ms |
| 600 KB, an append's frame | 48.0 / 57.3 ms | 46.9 / 55.4 ms |
| 600 KB, first paint       | 472 / 534 ms   | 461 / 522 ms   |
| 20 KB, an edit's frame    | 8.9 / 13.3 ms  | 8.8 / 12.6 ms  |
| 20 KB, a scroll frame     | 1.3 / 2.9 ms   | 1.2 / 2.7 ms   |
| 20 KB, a reflow frame     | 2.3 / 5.7 ms   | 2.2 / 5.6 ms   |
| 20 KB, first paint        | 230 / 104 ms   | 231 / 99 ms    |

A reflow repaints the top of the document after every step. With every
block's bounds reaching the top, each of those paints went through the
whole document. The macOS first paint at 600 KB is a median of eight runs,
and the 20 KB edit of six; the rest are medians of three.

## Round 15: finding a kept layout, again

`<Html>` went through ten more rounds of conformance work, #181 to #190,
and passes 5,460 of the CSS 2.1 suite's reftests on X11. Profiling an edit
at 600 KB afterwards put the text layout cache (#142) back at the top of
the layout: finding a pass's 8,800 layouts again cost 5 ms of its 32.

- **The key was still a string.** Each layout was filed under its width,
  its runs' count and length, and the first and last 16 characters of its
  text, spelled into a string that every lookup built and hashed twice. It
  is a number now, hashed from the same, small enough to stay a small
  integer; paragraphs whose hashes meet are told apart by the comparison,
  as ones whose strings met were.
- **A run was compared by walking its own fields.** Every field, so that
  one added to `TextRun` could not be left out: 76 ns a run with `for…in`.
  The fields are named one by one now, which keeps the guarantee: the
  compiler holds the list to `TextRun`, so a field added there names itself
  in an error until the list has it, and a test holds the comparison to the
  list. A field left `undefined` is now the same as one absent, which the
  engine cannot tell apart either. The block's style is a run's fields
  without the text, and the options a list of their own, and both are
  compared the same way: they were two more walks a layout.
- **The natural line height spelled its face into a key.** Every paragraph
  asks for it, and each question built a string of the family, size,
  weight and style. It is found by the style object first now, as the
  face's extent already was: the paragraphs of a pass share their styles.

In process, on the built package, medians of interleaved runs:

|                           | before  | after   |
| ------------------------- | ------- | ------- |
| an edit's layout, 600 KB  | 31.0 ms | 25.0 ms |
| an edit's layout, 68 KB   | 2.97 ms | 2.18 ms |
| an edit's layout, 20 KB   | 1.16 ms | 0.94 ms |
| a resize's layout, 600 KB | 18.6 ms | 15.0 ms |

And the frames, in real windows, XQuartz first and macOS second, before
the style and the options were compared by name:

|                         | before         | after          |
| ----------------------- | -------------- | -------------- |
| 600 KB, an edit's frame | 43.8 / 52.5 ms | 39.4 / 45.8 ms |
| 600 KB, a reflow frame  | 41.0 / 87.4 ms | 40.9 / 84.5 ms |

Medians of three interleaved runs. A reflow's frame is mostly the engine
laying out every paragraph at the new width, which no lookup changes.

## Round 16: a framework's stylesheet

Much of the HTML an application is handed is styled with Tailwind — a
model's, a CMS's, a template's — and `<Html>` had only been measured under
the report's forty rules. `DOC=tailwind` puts a Tailwind-4-shaped
stylesheet under the report (`scripts/bench/sweep/docgen.ts`): a theme of
220 colours in oklch, four layers, preflight, the `@supports` block that
sets thirty-five `--tw-*` properties on every element, and a thousand
utilities in `var()`, `calc()`, nesting and media ranges, about 90 KB. An
append to a document under it took 83 ms a frame on macOS against 18 ms
without it, and an edit 62 ms against 15. Four things, in the order the
profile gave them:

- **Every restyle parsed the stylesheets again.** A streamed append, an
  edit and a width across a `@media` breakpoint each parsed every sheet and
  indexed every rule again. The parsed sheets and the cascade built from
  them are kept now, and taken again where every sheet reads as it did —
  its text, its encoding and the texts of what it imports — under the same
  look, scale and fonts: the restyle only re-runs the cascade, which is
  what the cascade was built for.
- **Every element had a set of custom properties of its own.** The `*`
  rule sets thirty-five, so each element made a set and resolved every
  value in it, and `substituteIn`, which remembers the `var()`s it replaced
  by the set they were read against, never met the same set twice. A set
  is shared now by the elements whose parent has the same one and whose
  own come from the same declarations; a test holds a shared set to the
  one the element makes alone.
- **Every element had a `::before` and an `::after` computed**, since
  `*, ::before, ::after` reaches them all, and both were thrown away for
  having no `content`. A pseudo-element no rule gives a `content` to is
  none now before its style is computed.
- **Inheriting, and preflight's border, stored through computed names.**
  `inherit` copied the twenty-six inherited fields in a loop over their
  names, and `border: 0 solid`, on every element, wrote its twelve fields
  through names it built; such a store cost thirty times a written one.
  Both are written out, and a test holds `inherit` to its list.

In process, on the built package, a Tailwind-shaped dashboard of 549
boxes, medians of twelve:

|                                     | before  | after   |
| ----------------------------------- | ------- | ------- |
| a restyle: sheets, boxes and layout | 25.0 ms | 14.5 ms |
| the boxes and the layout            | 17.4 ms | 12.6 ms |
| the layout                          | 8.8 ms  | 8.8 ms  |

In a real window on macOS, `docsweep` with `DOC=tailwind` at 60 sections
(218 KB), medians of two runs:

|                     | before  | after   |
| ------------------- | ------- | ------- |
| an append's frame   | 83 ms   | 28.6 ms |
| an append's latency | 86 ms   | 32 ms   |
| an edit's frame     | 61.6 ms | 21.8 ms |
| an edit's latency   | 66.7 ms | 27.9 ms |
| an edit's CPU       | 88%     | 46%     |
| a mount's CPU       | 737 ms  | 580 ms  |

Without the framework nothing moved, small or large: an append's frame at
10 sections 12.8 → 12.1 ms and at 60 17.6 → 16.6 ms, and an edit's
12.3 → 11.6 ms and 15.0 → 14.6 ms.

Then the layout, which the four left where it was. Two fifths of it was
the calls into Yoga: every flex container and item set its direction,
wrap, alignment, growth, shrinking, four margins, four paddings, four
borders, a width, a height and a basis, each a call from JavaScript into
the engine's assembly, and each width and height built three bound
setters to make it with — and most of them restated what a new Yoga node
already is. They are left unsaid now, and the setters called directly.
In process, medians of interleaved runs:

|                                      | before  | after   |
| ------------------------------------ | ------- | ------- |
| the dashboard's layout               | 8.6 ms  | 6.5 ms  |
| two hundred flex items (`flexbench`) | 17.7 ms | 13.7 ms |
| the report at 300 sections           | 14.8 ms | 14.7 ms |

## Round 17: what correctness cost, a third time

Between rounds 16 and 17, `<Html>` went through fifteen more rounds of
conformance and real-page work, #204 to #214: `line-clamp` and
`text-overflow`, 3D borders, `<details>`, justified text, text that does
not wrap aligned, tab stops, OpenType features, text shadows and the line
height of raised boxes (`docs/html-conformance.md`, rounds 43 to 53). This
round measured what they cost, as rounds 13 and 14 did: a tree with the
`src/html` of #203 and one with master's, sharing everything else, run
interleaved.

In process, medians of three or four interleaved runs:

|                                  | #203    | master  |
| -------------------------------- | ------- | ------- |
| the report's layout at 600 KB    | 15.0 ms | 15.7 ms |
| an edit's layout, 600 KB         | 24.3 ms | 25.0 ms |
| an edit's layout, 20 KB          | 0.92 ms | 0.95 ms |
| the Tailwind dashboard's layout  | 7.2 ms  | 5.7 ms  |
| the Tailwind dashboard's restyle | 12.6 ms | 11.0 ms |

The dashboard came out faster, and #206 alone makes most of the
difference, 8.5 → 7.5 ms with nothing else applied: a flex row measured
for its content no longer grows its items to 10³⁸, which Yoga then had
to lay out. The report came out slower, by 4.5%. The profile named the cost at once:
`isTab`, the search of every paragraph's text for a tab (#211), and
behind it the walk over the same items for a shadow (#213). A tab is
only left in text whose `white-space` keeps it — every other text's are
spaces by the time it is laid out — so the search asks that first now,
and the two walks are one: the report's layout is 15.2 ms, against 15.1
before any of it.

In real windows, `docsweep` for `<Html>`, medians of two interleaved runs
and of six for the 20 KB cells on XQuartz, which moved by a quarter
between runs of the same tree:

|                           | #203           | now            |
| ------------------------- | -------------- | -------------- |
| 600 KB, an edit's frame   | 37.4 / 42.4 ms | 38.7 / 42.8 ms |
| 600 KB, an append's frame | 40.2 / 45.9 ms | 41.0 / 46.8 ms |
| 600 KB, a reflow's frame  | 40.3 / 84.2 ms | 40.9 / 83.8 ms |
| 600 KB, a scroll's frame  | 1.4 / 3.0 ms   | 1.4 / 2.9 ms   |
| 600 KB, first paint       | 466 / 527 ms   | 471 / 532 ms   |
| 20 KB, an edit's frame    | 8.2 / 11.3 ms  | 7.9 / 11.4 ms  |
| 20 KB, a reflow's frame   | 2.4 / 5.6 ms   | 2.3 / 5.7 ms   |
| 20 KB, a scroll's frame   | 1.5 / 2.8 ms   | 1.6 / 2.9 ms   |

XQuartz first, then macOS. Nothing moved past the noise. The paint's
share of a frame at 20 KB, with the glyphs left out, is 0.034 ms in both.

The one thing tried and dropped: the paint bounds walk every line of
every box after a layout, and taking the lines' extent as they are placed
instead measured the same, 0.8 ms either way, because at 600 KB the walk
is twenty thousand boxes and seven thousand lines.

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
14. **A copy benchmarked in a loop is not the copy a frame makes.** On
    Apple silicon a 15 MB copy runs five times slower when the thread has
    slept since the last one, whatever the QoS and however many threads
    share it. Benchmark with the frame's own idle gaps, and cut bytes rather
    than tune the copy.
15. **Core asks an element the same question at two widths every frame.**
    The height-floor probe compares a leaf's height at the width it was
    measured at with the one it has now. An element whose measurement is
    expensive has to answer a width it has seen from memory. `<Html>` laid
    the document out three times a frame until it did.
16. **Split the time inside the native call before designing its
    replacement.** A few counters inside `createLayout` said two thirds of
    it was shaping, the same at every width; the typesetter cache followed,
    and the packed geometry came from the same table.
17. **An oracle built from a fresh instance finds correctness bugs a
    targeted test does not**, and its own measurement needs the same care:
    a pixel rect that rounds differently on another platform's metrics
    reads a neighbour's ink.
18. **Rerun the old tree on today's machine before calling a regression.**
    A display arrangement moved the table's fling frame from 4.9 to 7.0 ms
    under the old core as well as the new; only running both said so.
19. **A faster frame can expose a race it did not cause.** #706 made the
    Flow pan's frames cheaper and the pan slower, because React's commits
    of the bodies fell further behind them. Count what each frame declined
    before blaming what it does.
20. **A state change that arrives with no event is lost on a thread that
    waits for events.** A window made visible by AppKit's constraint, with
    its only notifications already sent, left a worker's frames waiting
    forever. Announce what was published.
21. **Work repeated per element often depends only on the kind of element.**
    A 600 KB report is 9,039 elements and 110 kinds; the cascade computed
    all 9,039. Find what an answer really depends on, and key it on that,
    with an oracle that compares against the unshared answer.
22. **A cache key costs what it spells out.** Finding a kept layout built
    3 MB of key strings a pass, a tenth of an edit, to answer "the same as
    last time" about once a paragraph. File under the cheap part and
    compare the rest.
23. **Count the boxes.** Layout, floors and absolutize all walk every node
    on a width change, and a third of `<Markdown>`'s nodes were boxes with
    one child. Fold a wrapper into its child only with the pixels compared
    before and after.
24. **A cache has to be cheap for the lookups that save nothing.** At mount
    most of the kept paragraphs' hits were list markers, and a key built by
    concatenation cost more than they saved. Count hits by what they would
    have cost, and keep the key a string the caller already has.
25. **A stress fix is off until its scale is there.** The paragraph cache
    cost every short label a microsecond, 20–30%, and the zoom picture held
    a 30-node graph to half its frame rate on macOS; both were measured
    only on the scenes they were for. Measure each change at an everyday
    size too, and gate it by size or by the cost it exists to avoid.
26. **Find a gate's line by forcing both sides.** The zoom picture's
    threshold came from the same zoom with the picture forced off and on at
    four graph sizes. On macOS the two cross where a live paint costs what
    the composite does; on XQuartz they never cross, and the picture is a
    trade of frames for stalls at every size.
27. **Decide on the steady state, by a median.** The zoom picture's first
    gate read a running mean of every paint: one slow step, a zoom's first
    step shaping every label, or a picture's own paint of its ground, and a
    small graph was on the picture for a whole zoom, on one run in three.
    Leave out what the steady state does not repeat, and take a median.
28. **A spawn by name searches `PATH` at spawn time.** On macOS
    `posix_spawnp` spawns in each directory ahead of the binary's, 30–50 ms
    of a synchronous `fc-match`. Find the path once.
29. **Count what an index returns, not whether it is used.** `<Html>`'s
    paint index was asked on every frame from the component's first version,
    and answered with every block above the viewport: a link's box, never
    laid out, stretched its paragraph's bounds to the top. A probe counting
    the boxes a frame visits said 1,115 where the window holds 80.
30. **Measure under the stylesheets documents carry.** A report under
    forty rules never paid for a thousand rules re-read on every restyle,
    or for thirty-five custom properties on every element; none of the
    four costs above showed until the document was styled the way real
    ones are.
31. **A search for what few documents have asks first whether it can be
    there.** A scan of every paragraph for a tab cost the report 4% of its
    layout, where the answer was already in each text's `white-space`:
    only a `pre` or a `pre-wrap` keeps one.

## Still open

Ordered by practical impact, after round 12, and `<Html>`'s edit after
round 15.

- **XQuartz first paints**: the first layout of a family ntk has not warmed
  waits on `fc-match`, which takes 80–150 ms launched from inside a
  mounting app against 20 from a small process — 104–110 ms of a 500-line
  code editor's 143–158 ms first frame. Sans-serif is warmed while the
  connection is set up; any other family pays it. An app naming its
  families early, or answers kept across runs, would hide it; neither is
  small.
- **Markdown reflow's second layout pass**: the floors emulating
  `min-height: auto` come from the previous layout, so a width change lays
  the document out twice — 10,188 nodes at 600 KB with #143, in a frame of
  103 ms on XQuartz with ntk #387 as well. A live resize on Cocoa defers
  them; a split-pane drag does not. The fix is content-based minimum sizes
  in yoga; parked in round 12, with no workaround here or in core short of
  that.
- **`<Markdown>` first paint** (0.77–0.78 s on XQuartz with #143 and ntk
  #387; 1.04–1.08 s on Cocoa with #143, measured on a core without the
  kept typesetters): the height floors, React's development render and the
  layout.
- **`<Html>` edit and append** (45.8 ms on macOS and 39.4 on XQuartz at 600 KB after round 15, 12.6
  and 8.8 ms at 20 KB after round 14): the parse, the box build and the
  layout with its bounds still run over the whole document, at about 8, 11
  and 25 ms of an edit at 600 KB in process. A parse that kept the identity
  of what it did not change would let each of them skip it.
- **Cocoa scroll**: what is left is the band copy itself, about 1.4 ms a
  frame at 2x, memory-bound; see "The Cocoa scroll's double copy".
- **`<RichTextEditor>`**: large pastes, mostly React's development render.
- **A 2D zoom on XQuartz**: live, a step shapes every label at its size,
  since X11 draws glyphs at the size they were shaped at — 9 ms a step at 30
  nodes, 22 at 100. The picture it takes past 16 ms stalls 60–140 ms each
  time it is painted again.
- **Bold over a whole small document** in `<RichTextEditor>`: 55–72 ms to
  the screen in production, proportional to the document below the 200
  blocks at which the editor draws a window; see round 12.
