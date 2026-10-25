# Building only what changed

> **Status: phase 1 built, and phase 2 for blocks in a block's flow.**
> Written 2026-10-25, from the fifteen pages `htmlpagejs.mjs` loads with
> their scripts running, on react-x11's macOS backend at 2x. Every number
> here is from those loads unless it says otherwise.

A page's scripts change the document all through its load: a component
renders, an ad slot fills, a CSS-in-JS library writes a rule. `<Html>`
answers most such changes with a build that keeps every style it can
(`_restyleChanged`, `KeptStyles`), and then lays the document out again.
Both halves are the whole document every time. This record measures where
that time goes, and orders the work that makes a change cost what it
changed.

## What a change costs today

A probe timed every `buildBoxes` and every `layoutDocument` while each page
loaded (median of a run):

| page                      | builds keeping styles | full builds | layouts after a build |
| ------------------------- | --------------------- | ----------- | --------------------- |
| theguardian.com           | 46, 598 ms            | 8, 491 ms   | 54, 2,664 ms          |
| github.com/facebook/react | 9, 266 ms             | 5, 453 ms   | 14, 559 ms            |
| developer.mozilla.org     | 10, 39 ms             | 7, 272 ms   | 17, 721 ms            |
| bbc.com/news              | 6, 77 ms              | 6, 101 ms   | 12, 496 ms            |
| tailwindcss.com           | 22, 99 ms             | 7, 175 ms   | 27, 301 ms            |

And on the Guardian, loaded, each kind of update forced five times:

| update                                        |  ms |
| --------------------------------------------- | --: |
| a layout, every kept size kept                |  33 |
| a layout, the intrinsic sizes forgotten       |  40 |
| a build keeping every style, and its layout   |  48 |
| a restyle of everything, a build and a layout | 109 |

Two things follow.

- **The box build is a third of a build that keeps styles, and the layout
  after it two thirds.** A build that keeps styles costs 13 ms of box
  making on the Guardian, against 49 ms of layout. Building only what
  changed saves the first, and no more, unless the layout after it can
  also leave alone what did not change.
- **The layout is the whole document because the boxes are new.** Layout
  keeps what it learns on the boxes (`intrinsicMinContent`, `PREFERRED`,
  `PERCENT_HEIGHTS`, `FLOW_PLACE`), so a build hands it a tree with none.
  But even with every size kept, a layout places all 4,600 of the
  Guardian's boxes (33 ms), and what makes it cheaper is skipping the
  boxes whose place cannot have changed — which needs them to be the same
  boxes as last time.

So the work is two phases, and the first is worth doing for the second.

## Phase 1: a changed subtree built into the kept tree

Where a change reaches only some elements, the tree keeps every box it
does not reach, and the builder builds only the boxes of the elements it
does, into the tree in their place.

### What a change reaches

The elements whose boxes can differ are known before the build:

- the targets of the change records (`touchDocument(changes)`): an
  element whose attribute changed, the element around a text that
  changed, and the parent of nodes put in or taken out — but where every
  node a record put in or took out draws nothing (`draws`: a comment, an
  element the last build styled `display: none`, or one of a kind the UA's
  sheet never draws that the page's rules leave so), the nodes taken out
  stand in for the parent, and their styles go;
- the elements whose styles the change can change (`ChangeScope.own`),
  and, discovered as the build styles them, the elements below one whose
  parent's style came out otherwise (`KeptStyles.follow`).

Each of those is in the subtree of a **rebuild root**: the nearest element
at or above it whose box is one whose content can be built apart from its
siblings. Nested roots merge into the outermost. An element with no box is
a **boxless root** where it was `display: none`, or is new and of a kind
the UA never draws — the `<script>`s, `<link>`s and `<style>`s a page
puts in as it loads: it is styled where it is, its style put in the
tree's in the document's order, and where it comes out drawn the whole
document is built. Those were most of what made a change reach the
document's top on Next.js, Tailwind and the Guardian.

### What a rebuild root must be

The builder carries state across siblings, and a root is where all of it
is at a known value and comes out the same:

| builder state                                                          | why a root is safe for it                                                                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| white space (`_ws`), a word's first letter (`_lettered`)               | a block-level box ends the line before it and starts its own (`_endLine`, `after`)                                                                                   |
| the document's text (`_chunks`, `_length`) and every box's `textStart` | the root's text is built from its old start, and every later box shifts by the difference                                                                            |
| `::first-letter` (`_firstLetter`)                                      | refused where any rule styles one                                                                                                                                    |
| `::first-line` (`FIRST_LINE`)                                          | refused where any rule styles one                                                                                                                                    |
| CSS counters and quotes (`_scopes`, `_quoteDepth`)                     | refused where the old or new subtree changes or reads a counter or a quote — but for list items whose markers show no number, as many after as before (`_listItems`) |
| depth (`_depth`, `MAX_DEPTH`)                                          | the root's depth is counted from its ancestors                                                                                                                       |
| the fix-up (`fixUp`)                                                   | the root is block-level in a block or flex container, before and after, so its parent's anonymous boxes are as they were                                             |
| the flat tree                                                          | the root is in the document's own tree, assigned to no slot, and neither subtree hosts a shadow tree (`inLightTree`, `holdsShadow`)                                  |

So a rebuild root is an element whose old box is its only box, an in-flow
block-level box (`block` or `flex`), child of a block or flex container,
and whose new box is one too — and nothing in the document styles a first
letter or a first line. A root that fails any of these hands its parent
the role, and a root at the document's top is a whole build.

### What the tree keeps besides boxes

`BoxTree` holds lists in document order, found as the builder goes, and
flags that say where none of a kind is:

- **The lists** (`controls`, `media`, `embedded`, `links`, `focusables`,
  `backgrounds`, `images`, `awaiting`, `contentImages`, `awaitingKind`,
  `textBoxes`, `textNodes`, `unselectable`): the entries of the old
  subtree are taken out and the new subtree's put in their place, which is
  a run of each list, since a subtree is a run of document order — and so
  is the entry of anything moved out of a root to where nothing draws it.
- **The text** (`text`, every `textStart`/`textEnd`, `subtreeTextStart`):
  the old subtree's range is replaced by the new, and what follows shifts.
- **The styles** (`styles`): the old subtree's elements go and the new
  subtree's come, and none is left under an element of `display: none`.
- **The flags** (`relative`, `tilted`, `negative`, `anchors`, …): each is
  `true` where some box needs looking at, so the new subtree's are added
  to the old, and one the old subtree set stays set — a walk that finds
  nothing, as before the change.
- **What is refused**: a subtree with a `<foreignObject>`, an orthogonal
  flow, a view transition's tree or a box in the top layer builds the
  whole document, as now.

### What it is held to

`test/html/subtree-build.test.ts` builds random documents — blocks,
inlines, lists numbered and not, floats, positioned and relative boxes,
transforms, clips, shadow hosts — makes random changes to them, scripts
and titles put in and taken out among them, and holds the tree a subtree
build makes to the one a whole build makes: every box's kind, element,
style, text, range and marker, every list in order, and the geometry of
every box and line after layout. `SUBTREE_SEEDS` sweeps more documents
than the suite's sixty, and `SUBTREE_FROM` starts at the one a sweep
failed at. Every mismatch the sweeps found while this was written is a
case in the code: two of them were whole builds that were wrong, and are
fixed on their own (#1005, #1006).

## Phase 2: laying out only what moved

Once unchanged boxes are the same boxes, a layout can leave alone a block
whose subtree did not change and whose constraints are as they were, and
move it to where the flow puts it now (`reuseLaid` in `layout/block.ts`).

**What a block was laid out from is noted as its flow lays it out**
(`Laid`): the room the flow had, its percentage height base, the viewport,
the scale and the fonts, where it went from where the flow had it, and the
bottom margin its last children left hanging through it, which the flow
resets before it lays a child out (`resolveEdges`). A later layout keeps
it where all of that is the same, nothing has laid it out since
(`Box.layoutSerial` — a probe of what it is in lays it out), and nothing
in it changed: `forgetSizes`, which every change that a box's layout
reads calls for the box and every box it is in, forgets the record with
the sizes. A layout that may keep a block is one of the whole document, of
a tree with no anchor, no vertical flow, no `::first-line` and no foreign
object.

**What it holds is where its layout put it, from its corner.** The passes
after a flow move boxes — their transforms' translations, their relative
offsets, their scrolls — and a flow reads what a block holds as it laid it
out: a line's baseline in an inline-block, a marker's first line. So a
kept block has those offsets taken off what it holds (`unoffsetHeld`)
before it is moved, and the passes put them on again: each is a move of
the same boxes, worked out from sizes the block keeps, and moves add up in
any order.

**A block that holds something placed against what is outside it is
laid out** (`reuseBlockers`): the boxes between an out-of-flow box and its
containing block, every box around a sticky box, a box in the top layer
or one fixed to the viewport, and around a relative inline box broken
around blocks, which moves blocks beside what holds it. A block that holds
an out-of-flow box placed against something inside it is kept with it,
and the document reaches as far as the box does (`keptPositionedIn`).

**Not yet**: a flex or grid item, and a table cell, is laid out by its
container's algorithm (`layoutSubtree`), which lays it out more than once
a pass — for its contribution, at its row's height, for a percentage of
it — and keeps one geometry; and a probe of a shrink-to-fit box lays out
all it holds at the probe's width. Both are where most of what a change
on the Guardian costs still goes.

## What it measured

The thirteen scripted pages in the cache, loaded three times a side,
interleaved, on react-x11's macOS backend at 2x, against the commit before
(medians):

| page                      | settle (ms)     | processor (ms)  | builds    |
| ------------------------- | --------------- | --------------- | --------- |
| theguardian.com           | 7,850 → 7,375   | 10,960 → 10,231 | 55 → 51   |
| github.com/facebook/react | 2,608 → 2,504   | 4,766 → 4,582   | 14 → 14   |
| developer.mozilla.org     | 1,216 → 1,057   | 2,349 → 2,050   | 17 → 17   |
| tailwindcss.com           | 1,191 → 985     | 1,924 → 1,512   | 26 → 8    |
| nextjs.org/blog           | 1,975 → 1,759   | 3,621 → 3,289   | 11 → 9    |
| all thirteen              | 21,435 → 20,211 | 33,693 → 31,691 | 182 → 158 |

The four pages above Next.js are apart in every run: every run after is
under every run before. The totals are too — 21.1–21.8 s of settling
before, 19.4–20.6 s after. Tailwind's builds are mostly gone: what its
scripts put in the body is scripts, which now draw nothing and build
nothing. Svelte and BBC, a point and a half the other way in that run, came
out a point under before when run alone, five times a side.

On X11, the same pages on Xvfb: 22,359 → 21,295 ms of settling and 36,011
→ 33,857 ms of processor, the Guardian, MDN, Tailwind, GitHub and react.dev
apart in every run. Reddit, three milliseconds of ninety the other way, was
the same run alone.
