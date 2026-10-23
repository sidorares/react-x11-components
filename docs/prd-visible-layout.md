# Laying out only what can be seen

> **Status: design, measured, nothing built.** Written 2026-10-24 after round
> 49 of the [perf sweep](perf-sweep-2026-09.md), from the seventeen pages its
> `htmlpage.mjs` loads, with the window's edge dragged 8 px a step for 40
> steps and back, on react-x11's macOS backend at 2x. Every number here is
> from that drag unless it says otherwise.

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

### B. An image's density builds the boxes (BBC)

BBC's images have a `srcset` of `w` candidates and a `sizes` in `vw`, so at
each step the same candidate shows at another density, and a choice that
changes what an image shows builds the boxes (`_choose`). A `w` candidate is
as wide as `sizes` says whatever it holds, so the box is the same box:
**where the URL is the one already shown, the replaced box takes its new
density and its new natural size in place**, and the layout that follows
sizes it.

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

### And what draws nothing

GitHub's five dropdowns are `visibility: hidden`, `opacity: 0` and absolutely
placed, and `layoutPositioned` lays all of them out at every step: 11 ms a
step. A box out of the flow that draws nothing all through, and holds no
widget, can be laid out once the width rests, as what is set aside is; its
place matters to nothing a reader sees, and the layout at rest gives it the
right one.

## Order

1. **A**, then **B**: the enabler. It takes the build off five of the seven
   slowest pages and gives the rest something to keep.
2. **C**: small, the same shape as `until`, and every docs page has a
   sidebar.
3. **E**, then **D**: the cut decided from the last layout, which only a
   kept tree has — so after A.
4. **F**, and what draws nothing: one page each in this set, and both
   common on news sites.

Each is measured as round 48 and 49 were: the seventeen pages dragged on a
Mac, interleaved against master, three runs a side, with X11 as the second
signal; and each keeps the step laid out to what the whole layout at rest
draws, which `test/html/relayout.test.ts` holds a drag to.
