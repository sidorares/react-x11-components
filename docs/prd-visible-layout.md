# Laying out only what can be seen

> **Status: A, B, C, E, F and the table rows are built; the rest is design.** Written 2026-10-24 after
> round 49 of the [perf sweep](perf-sweep-2026-09.md), from the seventeen
> pages its `htmlpage.mjs` loads, with the window's edge dragged 8 px a step
> for 40 steps and back, on react-x11's macOS backend at 2x. Every number
> here is from that drag unless it says otherwise.

A dragged width is the one change that lays a document out again at every
frame, and what a reader sees of it is one viewport. `<Html>` already lays
out only that much where it can. This record measures where it cannot,
names each reason, and orders the work by what each one unlocks.

## What a step of a drag does today

The mechanism is in `layout/block.ts` and `_stopAt` in `node.ts`, and
AGENTS.md has the rules ("A dragged width lays out what can be seen"):

- **`until`.** `layoutChildren` lays out no child of a block that starts
  below a viewport past the one shown, and sets the rest aside
  (`setAside`): the box's `children` is the part laid out until the next
  layout puts the list back (`putBack`), and the box is as tall as what it
  set aside last was. The whole document is laid out once the width rests.
- **`above`.** The blocks that ended above the viewport keep their place
  (`keepAbove`, `FLOW_PLACE`), and the pane keeps what is at its top where
  it is on screen (`_keepAnchor`).
- **`reach`.** A tree a breakpoint built, which has no places to keep, is
  laid out from the top down to where the anchor lands, and as far past it.
- **Where it gives up:** a multicol container and a scroll container are
  laid out whole (`laidWholeAround`); a probe of an intrinsic size lays out
  all of what it measures (`probeWhole`, `measureIntrinsicWidth`); and a
  tree with a fixed box, or an absolute one placed against something laid
  out, in what was set aside is laid out again whole (`escapes`,
  `laidWhole`). A tree no whole layout laid out is laid out whole, but for
  one a crossing or a `vw` built (#957).

## Where it falls short

A probe counted, for each step, the block-level boxes laid out, how many of
them start below the stop line, and the parent that laid them out anyway;
another counted the time intrinsic-size probes took, on steps that built the
boxes and on steps that kept them.

| page          | ms/step | steps that built | boxes laid out a step | block boxes past the line | what lays those out                    |
| ------------- | ------: | ---------------: | --------------------: | ------------------------: | -------------------------------------- |
| The Guardian  |    57.8 |               80 |                 3,343 |                     3,055 | `<main>` laid out again whole: escaped |
| Next.js blog  |    57.5 |               80 |                 1,752 |                     1,079 | a grid of cards, a flex column         |
| Bootstrap     |    53.6 |               60 |                   425 |                       161 | a sidebar in a scroll container        |
| GitHub        |    49.8 |               70 |                 1,190 |                       120 | flex items; hidden dropdowns           |
| Python docs   |    38.7 |               66 |                   231 |                         9 | — the build itself                     |
| MDN           |    19.5 |               80 |                   353 |                       152 | a grid, a sidebar                      |
| BBC News      |    19.5 |               80 |                   520 |                       100 | grids                                  |
| Wikipedia, US |    15.8 |                4 |                 1,623 |                       932 | menus and contents in scroll panes     |
| RFC 9110      |     7.4 |                2 |                   609 |                       565 | its contents, in a scroll pane         |
| Tailwind docs |     7.0 |                4 |                   616 |                       449 | a flex column nav, a grid              |

Three things stand out.

- **Probes cost nothing on a step that keeps the boxes**, and 3–64 ms on
  one that builds them: an intrinsic size is kept on its box
  (`intrinsicMinContent`, `intrinsicMaxContent`, `MAX_CONTENT`), and a
  build makes new boxes. Bootstrap's grid measures its main column at no
  width and at no limit, all of it, at every step that built.
- **The pages that are slowest build at nearly every step.** It is not the
  layout that forbids the stop on those, it is the build: the probes, the
  places `keepAbove` keeps and the heights `setAside` keeps are all a
  box's.
- **Where the boxes are laid out past the line, it is a few kinds of
  container**: a scroll container, a grid, a flex column, and the layout
  made again whole after an escape.

## Six gaps, in the order they unlock the rest

### A. A length that moves builds the boxes

What a `vw` changes at each step, on the pages that build at each step, is
a length on a block-level box, and never text:

| page         | the field                  |
| ------------ | -------------------------- |
| MDN          | a `div`'s `max-width`      |
| Python docs  | a `div`'s `width`          |
| GitHub       | five hidden menus' `right` |
| Next.js blog | `body`'s `max-width`       |
| The Guardian | an `aside`'s `max-width`   |

`hoverChange` refuses anything that is not ink, so each is a build — and on
most of these pages the readers' subtrees are past what an in-place restyle
takes as well, so the refusal is never even reached (#961's `from` walk fixes
that half for the `vw` path; it is on a local branch).

**Design.** On the `vw` path only — where a layout follows anyway, at the
new width — a change confined to box-model lengths is taken in place: the
box keeps its identity and takes the new style, and what depended on the old
lengths is dropped.

- The lengths: `width`, `height`, `min-*`, `max-*`, `margin-*`, `padding-*`,
  `top`, `right`, `bottom`, `left`, `row-gap`, `column-gap`, `flex-basis`.
  Not a font's size or a line's height: a block's collected runs read those
  (`collect`), and a text change is a build.
- Only a block-level box that is not replaced: an inline box's edges are in
  its block's lines.
- Dropped for the box and every box above it: the intrinsic sizes
  (`intrinsicMinContent`, `intrinsicMaxContent`, `MAX_CONTENT`, `NATURAL`,
  `PREFERRED`), `PERCENT_HEIGHTS`, a table cell's kept widths, and
  `FLOW_PLACE`, so `keepAbove` lays out again what changed above the
  viewport rather than keeping its old place.
- `_stale` becomes `Stale.Layout`, and the paint is the layout's.

The rule AGENTS.md states — "Layout's per-box caches assume a box's style
never changes" — is the risk, and the list above is the audit it asks for:
every `WeakMap<Box, …>` in `layout/` that reads a length a box's own style
decides. The test is the one `test/html/animations.test.ts` holds frames to:
the step laid out in place, against a build of the whole document at the
same width, box for box.

**Worth:** no build on five of the seven pages that build at every step;
their probes go (12–23 ms a step on GitHub, Next.js and MDN), and with the
boxes kept, `keepAbove` and the heights `setAside` keeps work on them.

**Built.** `_restyleInPlace` takes a `lengths` flag, which the `vw` path
passes, and with it a change that `lengthsOnly` finds is of the lengths
alone becomes a quiet restyle of the box (`resized`): only on a box of kind
`block` or `flex` that is not replaced, and on `html` and `body` as well,
whose lengths are none of the canvas's. The boxes take their new styles and
`forgetSizes` forgets, for each and every box above it, the six things a
box's layouts keep for its life of its sizes (the audit found
`intrinsicMinContent`, `intrinsicMaxContent`, `PREFERRED`, `MAX_CONTENT`,
`PERCENT_HEIGHTS` and `FLOW_PLACE`; `NATURAL` is a pass's, and the table
and stretch caches are written by every layout). Readers too many for a
restyle in place are followed down from (`from`). On the Mac the
seventeen drags went from 52.8 s of processor time to 45.0: Python's from
6.40 s to 2.06, its 95th-percentile frame from 47.8 ms to 8.4; the
Guardian's from 6.54 s to 4.69; GitHub's from 7.01 s to 5.49; MDN's from
3.33 s to 2.76. Of twenty steps, MDN, Python, GitHub, Next.js and the
Guardian now keep their boxes at 16 to 20. `test/html/viewport.test.ts`
holds a resize taken in place to a build of the whole document at the same
width, box for box, over thirty generated documents of floats, flex rows
and columns, grids and absolute boxes with lengths in `vw`; it fails with
`forgetSizes` taken out.

### B. An image's density builds the boxes (BBC)

BBC's images have a `srcset` of `w` candidates and a `sizes` in `vw`, so at
each step the same candidate shows at another density, and a choice that
changes what an image shows builds the boxes (`_choose`). A `w` candidate is
as wide as `sizes` says whatever it holds, so the box is the same box:
**where the URL is the one already shown, the replaced box takes its new
density and its new natural size in place**, and the layout that follows
sizes it.

**Built.** `ImageSources.choose` says which images show another source, and
`_showInPlace` takes each into its box as a build would make it — the size
its source gives at its density, or its attributes' while nothing it chose
has arrived — with `forgetSizes` for the box and every box around it. The
boxes come from a list the builder keeps (`BoxTree.images`), since a box a
layout that stops set aside is out of reach from the root, and laid out at
rest at the size it was last given. The layout the width's move asks for
anyway lays it out, and stops where what can be seen ends: asking for a
layout of its own made the step stale, which `_stopAt` lays out whole, and
the first cut laid out 1,156 boxes a step where a build had laid out 550,
and was slower than the build it saved. Only an image whose `<source>`
sizes it another way now builds. On the Mac, BBC's drag went from 2.72 s of
processor time to 2.10, its median frame from 10.2 ms to 6.6 and its 95th
percentile from 25.4 ms to 19.4; it keeps its boxes at 76 of 80 steps,
where it built at every one. The list is the builder's because the index
of first boxes is not: walking the boxes set aside as well doubled each of
its rebuilds, and Node's API page, which rebuilds it three times a drag,
lost a millisecond at its 95th percentile. The same fix found that an image arriving
after the first layout left the flex item, inline-block or float that
shrank to it as narrow as no image: `_imageArrived` forgets their sizes
too.

### C. A scroll container is laid out whole

A sidebar, a table of contents or a menu is a scroll container as tall as the
viewport, and `laidWholeAround` lays all of it out, because what it shows is
where it is scrolled to rather than where the document's viewport is:
Wikipedia's menus and contents, 900 boxes a step; RFC 9110's, 565; Node's,
Bootstrap's and Tailwind's sidebars.

**Design.** A scroll container stops at its own scrollport: it is scrolled
by moving what it holds after layout (`applyScrollOffsets`), and the offsets
are set before the layout (`setScrollOffsets`), so its `until` is its
content top plus its scroll offset, its client height and a viewport's
slack, in the coordinates its children are laid out in. What it sets aside
keeps its height, so its `scrollHeight` is what it was. `keepAbove` stays
the document's: a sidebar scrolled far down still lays out from its top.

**Built.** `layoutBox` hands a scroll container's flow its own `until`
(`scrollerUntil`): its offset, from `wantedScrollTop`, plus the smaller of
the document's stop line and a viewport past its scrollport, where its
height or its `max-height` bounds the scrollport. `laidWholeAround` is
multicol's alone. What a flow sets aside records how far below its content
top it reaches (`ASIDE_REACH`), which `extentOf` counts, so a container's
scroll height, and an offset that height clamps, stay what they were; and a
container scrolled while the partial layout holds has the document laid out
whole (`_scrollBox`). On the Mac, a drag of RFC 9110 went from 1.51 s of
processor time to 0.94 and its 95th-percentile frame from 10.3 ms to 3.9;
Wikipedia's article on the United States from 2.80 s to 2.46, its median
frame from 10.2 ms to 6.7. Menus and sidebars laid out past the line went
from some 900 boxes a step to 14 on Wikipedia, 565 to none on RFC 9110 and
146 to 3 on Bootstrap. The layout at rest, which now lays out at the final
width the part of a sidebar no step reached, costs what it did.

### D. A flex column lays out every item

Tailwind's nav (323 boxes a step), GitHub's file box, React's and
Next.js's columns. `layoutFlex` hands Yoga every item, measured.

**Design.** In a column that does not wrap, with `justify-content` at its
start and no free space to share — no definite height, or a content height
past it — the items whose last layout started below the line are not
measured: each is frozen at the height it was laid out at, and set aside
after Yoga places it, as a block's children are. On a kept tree the last
layout is the box's (`y` against its container's content top); on a fresh
one there is none, and the column is laid out whole as now.

### E. A grid lays out every row

Next.js's card grid is 1,008 boxes a step, BBC's and MDN's grids fewer.
`layoutGrid` lays out every item at its area's width for its height, then
sizes the rows.

**Design.** The columns are sized from the items' intrinsic sizes, which a
kept tree has kept, so they cost nothing. The rows whose last layout started
below the line keep the sizes they had, and their items are neither laid out
nor reached: a row's size depends only on the items in it, unless an item
spans the cut, the grid has a definite height that `fr` rows share, or
`align-content` spreads the rows; any of those lays the grid out whole.

**Built.** `layoutGrid` asks `cutAt` for the first row to keep: the first
whose top in the grid's last layout that was not a probe (`KEPT_ROWS`) is
below where the layout stops, on a grid with the same items in the same
areas. The columns are sized from every item as before; the items above
the cut are laid out, the rows from the cut on are fixed tracks of the
sizes they had, and their items are set aside (`setAsideOf`), as a block's
children are. A grid with a share, a percentage or a percentage gap among
its rows, a height of its own or a least one, a subgrid, or an item across
the cut is laid out whole; and where the rows above come out shorter and
the cut starts above the line after all, the rest is laid out, so nothing
that can be seen is a width old. `wholeAgain` takes back, at the start of a
box's layout, what this pass set aside of its children, which a probe or a
flex item's measure later in the pass needs. On the Mac, a step of
Next.js's drag laid out 1,211 boxes where it laid out 1,751, its median
frame went from 31.9 ms to 9.15 and the drag's processor time from 5.48 s
to 4.60. BBC's, MDN's and GitHub's grids keep nothing: the ones past the
line are a row each, or wholly in view. `test/html/relayout.test.ts`
holds a step's visible rows to what the layout at rest draws over 24
generated grids.

### F. A fixed box set aside lays the tree out again whole

The Guardian sets aside a banner fixed to the viewport's bottom
(`aside.dcr-3z2xmj`, `bottom: 0`), and `escapes` lays the whole tree out
again for it, at every step: 2,795 boxes of `<main>` a step.

**Design.** An escaping box is laid out where it is placed — the viewport
for a fixed one, its containing block for an absolute one — and the boxes
between it and where the layout stopped stay in the tree, not laid out, so
the paint and the hit test still reach it: `setAside` keeps, at each level,
the child on the way to an escaping box and sets aside the rest. `heldBack`
answers for the kept path as for what is set aside, so nothing mounted
beside the document reads its stale geometry. A fixed box whose offsets are
`auto` on an axis takes its static position from that path, a width ago;
that one still lays the tree out whole.

**Built**, more simply than designed: the path is laid out, not kept as it
was. `escapingHolders` — the boxes that hold a fixed box, or an absolute one
placed against something outside them, which `keepAbove` already would not
keep — is handed to the layout (`LayoutContext.holders`), and a flow that
stops keeps such a child and lays it out after what it set aside; inside
it, the first child is past the line too, so it is laid out the same way,
down to the box, which is positioned as ever. So the path is at the new
width, and a box whose offsets are `auto` across takes its static place
from it rightly; one `auto` down is below the line either way. `setAside`
leaves the path's heights out of the span it adds, since the flow adds them
again, and a grid does not cut where an item from the cut on is on a path.
`escapes` stays, for a holder the cached set missed. On the Mac, a step of
the Guardian's drag laid out 416 boxes where it laid out 3,343, its median
frame went from 34.4 ms to 6.99, its 95th percentile from 43.7 ms to 11.4,
and the drag's processor time from 4.61 s to 1.78.

### And a table lays out every row

Wikipedia's list of countries is one `wikitable` of some 250 rows, and
`layoutTable` lays out every row at every step: 80% of the boxes a step
lays out there start below the line. A table's columns are sized from its
cells' kept widths (`CELL_CONTENT`, `TABLE_CONTENT`) and its rows are
stacked, so the rows whose last layout started below the line could keep
their heights and be set aside, as E would do a grid's — where no cell
spans the cut and the table's height is its rows'.

**Built**, as designed: `rowCut` finds the first row whose top in the
table's last layout that was not a probe (`KEPT_TABLES`) is below the line,
the cells from there on are not laid out and keep their content heights,
those rows keep theirs, and the rows are set aside in their groups. A
table with a height of its own or given, a least height, a cell spanning
the cut, or a row past it holding a box placed against something outside
it is laid out whole. On the Mac, a step of the list of countries' drag
laid out 452 boxes where it laid out 2,069, its median frame went from
20.3 ms to 5.16, its 95th percentile from 30.1 ms to 10.3, and the drag's
processor time from 3.32 s to 1.74; Wikipedia's article on the United
States, its tables smaller, from 7.30 ms to 6.53 at the median.

### And what draws nothing

GitHub's five dropdowns are `visibility: hidden`, `opacity: 0` and absolutely
placed, and `layoutPositioned` lays all of them out at every step: 11 ms a
step. A box out of the flow that draws nothing all through, and holds no
widget, can be laid out once the width rests, as what is set aside is; its
place matters to nothing a reader sees, and the layout at rest gives it the
right one.

## Order

1. **A** and **B** — built: the enabler. It takes the build off five of
   the seven slowest pages and gives the rest something to keep.
2. **C** — built: small, the same shape as `until`, and every docs page has
   a sidebar.
3. **E** and a table's rows — built — then **D**: the cut decided from the last
   layout, which only a kept tree has — so after A.
4. **F** — built — and what draws nothing: one page each in this set, and
   both common on news sites.

Each is measured as round 48 and 49 were: the seventeen pages dragged on a
Mac, interleaved against master, three runs a side, with X11 as the second
signal; and each keeps the step laid out to what the whole layout at rest
draws, which `test/html/relayout.test.ts` holds a drag to.
