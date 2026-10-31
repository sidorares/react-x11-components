# Building only what changed

> **Status: phase 1 built, phase 2 for blocks in a block's flow, and
> phase 3: a stream's chunk builds the ends of what it touched.**
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

| builder state                                                          | why a root is safe for it                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| white space (`_ws`), a word's first letter (`_lettered`)               | a block-level box ends the line before it and starts its own (`_endLine`, `after`)                                                                                                                                   |
| the document's text (`_chunks`, `_length`) and every box's `textStart` | the root's text is built from its old start, and every later box shifts by the difference                                                                                                                            |
| `::first-letter` (`_firstLetter`)                                      | refused where a block at or around the root's parent looks for one: a `::first-letter` rule matches it (`lookedForLetter`). Only such a block hands the builder a search, and none is carried out past what it holds |
| `::first-line` (`FIRST_LINE`)                                          | refused where any rule styles one                                                                                                                                                                                    |
| CSS counters and quotes (`_scopes`, `_quoteDepth`)                     | refused where the old or new subtree changes or reads a counter or a quote — but for list items whose markers show no number, as many after as before (`_listItems`)                                                 |
| depth (`_depth`, `MAX_DEPTH`)                                          | the root's depth is counted from its ancestors                                                                                                                                                                       |
| the fix-up (`fixUp`)                                                   | the root is block-level in a block or flex container, before and after, so its parent's anonymous boxes are as they were                                                                                             |
| the flat tree                                                          | the root is in the document's own tree and assigned to no slot (`inLightTree`): what changed in a shadow tree or a slot is built with the host around it                                                             |

So a rebuild root is an element whose old box is its only box, an in-flow
block-level box (`block` or `flex`), child of a block or flex container,
and whose new box is one too — and nothing in the document styles a first
line, and no block around it styles its first letter. A root that fails
any of these hands its parent the role, and a root at the document's top
is a whole build.

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
the same boxes, and moves add up in any order. A relative offset, a
translation and a scroll are worked out again from sizes the block keeps;
a sticky box's shift turns on where the block is, so it is taken off by
how far it was moved (`STUCK`), which a scroll that places it again
keeps.

**A block that holds something placed against what is outside it is
laid out** (`reuseBlockers`): the boxes between an out-of-flow box and its
containing block, every box around a box in the top layer or one fixed to
the viewport, and around a relative or sticky inline box broken around
blocks, which moves blocks beside what holds it. A block that holds an
out-of-flow box placed against something inside it is kept with it, and
the document reaches as far as the box does (`keptPositionedIn`). A block
that holds a sticky box is kept: it had been a blocker, and with every box
around it, which on joshwcomeau.com — a copy button stuck to the viewport
in each code block, the contents list beside the article — laid half the
article's grid out again at every layout of the page.

**The passes after the flow walk what they move, and the ink of the rest
is kept** (`Blockers.moved`; `KEPT_INK`, `frontierBounds` in `paint.ts`).
Taking the offsets off a kept block, putting them on again, placing the
sticky boxes and working the ink out each walked every box of the tree,
where a bare layout of that article lays out ten boxes of its 3,380. A box
the passes move, or move what it holds (`movesAfterFlow`: a relative box
with an inset, a sticky one, a transformed one, a scroll container), is
noted with every box around it as the blockers are, a tenth of that
article's boxes, and the passes go down those alone; a restyle in place
that makes a box one notes it (`noteMoving`). The walk of the ink records,
for each block outside them it reaches from a box inside them, where the
block's border box was and how far it reached; a later walk keeps the
block's ink where a layout kept it or a block around it, its border box is
where it was, and no sticky box is around it, which a pane's scroll places
with no walk of the tree (`boundsAfterMove`). A walk of the whole tree's
ink that keeps none — every one but a layout's — makes the records stale
(`INK_EPOCHS`).

**A flex or grid item is kept by what its container laid it out from**
(`keptNatural` in `layout/flex.ts`, `keptItem` in `layout/css-grid.ts`),
under the rule a block is (`mayKeepLaid`, `keepLaid`): a flex item's
layout at its content's own height at a width (`Natural`), and a grid
item's at its area's width (`ItemLaid`) — with the heights handed down to
it, and its edges — where the item still has that layout. A container
lays an item out more than once a pass: for its contribution, at its
row's height, for a percentage of it. A grid item whose content takes a
percentage of its stretched height is laid out at its content's height
and then at the stretch's, and the first is kept with the second, for
the next layout's first question. joshwcomeau.com's article is a grid of a
hundred paragraphs inside flex boxes, and a sparkle beside one of them
laid every one out again, three times a second.

**A probe keeps a flex item too** (`keepsNatural`): a natural layout a
probe or a layout made, where all of the item was laid out and it holds
nothing out of the flow, which a kept box counts in the document's reach.
A layout keeps only a layout's, since a probe keeps none of what a layout
keeps by the boxes in the item (`FLOW_PLACE`, `LAID`). An item along a
row in no room whose automatic minimum is its content at its narrowest is
fitted there at once (`heldAtMinContent`), where it was laid out at no
width for `autoMinimums` to hold it there, which made its record one at
no width. And an item keeps one natural layout a width, four at most
(`NATURAL_WIDTHS`): the latest is the layout it has, and another answers
the height its width came to (`measureBox`). A webmail page's hidden strip
of 2,496 senders, in the `auto` column of a grid whose min-content the
flex row around it asks, was laid out again inside each probe of it at
every layout, and its content pane at its widest and at its width by
turns, a dozen times a layout.

**Not yet**: a table cell, laid out by its table's algorithm; and a probe
of a shrink-to-fit box, which lays out all else it holds at the probe's
width. Both are where most of what a change on the Guardian costs still
goes.

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

## Phase 3: a stream's chunk

`<Html partial>` fed a source that grows — a model writing HTML — took
every chunk through a restyle, a build and a layout of the whole
document, since `_read` invalidated the style whenever the parser wrote:
45 ms a chunk at 670 KB on a Mac, where `<Markdown>` streaming the same
content holds at 11–14 ms. A chunk now costs what it added.

### What the parser says it did

The parser records what a chunk does to the tree (`ParseRecord`, through
`Handler`): each node it put in — always at the end of what holds it, the
one place it puts anything — the texts it wrote on to, and the attributes
a second `<html>` or `<body>` set on the first. `HtmlSource.takeAppended`
hands them over as the change records a `refresh` is told, and
`_parsedChanges` scopes them as `touchDocument` does, with what an append
means known besides (`_appendedScope`, `Cascade.appendChange`): what came
is new, and styled whole; of what was there, a rule reaches the children
that were last, or last of a type that came (`'e'`: `:last-child` and its
kin), every child where it counts from the end (`'n'`: `:nth-last-child()`),
the holder only where it held nothing (`:empty`) or held text that was
white space (`:blank`), and a sibling combinator nothing — it reaches only
what is after the child it follows, which is new. Anything the record cannot
say — a `<body>` taking in what went before it, a shadow root attached, a
parse that yields to its scripts — restyles everything, as before.

The document's scan (`facts()`) extends the scan before the chunk by the
elements it put in (`_extendFacts`), which come after every element already
in the tree; a text put into a `<style>` or a `<title>`, or anything into
a shadow tree, scans the tree whole.

### A tail

A chunk's changes reach the ends of what was open: the parser's stack of
open elements is the last child of each down from the root. So where a
holder's own box and style stay, its boxes can differ only from the first
child the chunk touched on. A **tail** of it (`tailRoot`, `runTail`) is the
run of its box's children after the last block-level box of its own before
that child — a block, a flex box or a table in the flow, which ended the
line before what follows (`endsLine`) — with its `::after`. The builder's
state there is the one it starts a build of its own at:

| builder state                      | why a tail is safe for it                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| white space, a word's first letter | the block before it ended its line (`_endLine`, `after`); and a float or a box out of the flow around it holds the space before it from its line's end only where it pushed text (`after`'s `held`), so one whose text comes to some, or to none, is refused — as a root is                                                                                |
| the document's text                | the tail's text starts where the block before it left the text (`textAfterBox`: the end of the text the tree's ranges say is at or before it, and past it what the fix-up dropped from it, which the list of text boxes keeps) and ends where the holder's did; what follows moves by the difference, its lines and their span maps with it (`shiftLines`) |
| `::first-letter`, `::first-line`   | a first letter: refused where the holder, or a block around it, looks for one (`lookedForLetter`); a first line: refused where any rule styles one                                                                                                                                                                                                         |
| counters and quotes                | a build apart notes a read of any counter it did not make, or of one whose reach a counter outside could change, and refuses (`CounterScopes.detach`); it counts otherwise than the old run did only where nothing kept after it reads a counter                                                                                                           |
| the fix-up                         | the tail is fixed up after a stand-in block, with what the fix-up saw before the block among the holder's children (`ranBefore`, from the first block after each, which `RAN_FROM` keeps by the holder): inline content, which wraps every run, and floats or boxes out of the flow, wrapped only so; refused where the tail would change how they are     |
| the holder                         | its box and style stay: a block container in the document's own tree, hosting no shadow tree, of no element that lays out its children otherwise (`TAILS_REFUSED`), and none whose style the change can reach                                                                                                                                              |

A seed no rebuild root can be found for — text written into an inline box
at the document's top — is in a tail of what holds the child it is in, or
of what holds that, from a block before it (`tailAround`). A root inside a
tail, and a tail inside a root or another tail, are the outer one's.

The counters rule is what lets a tail add a list: a `<ul>` resets
`list-item`, and a root or a tail that changes a counter was refused. In a
build apart every counter used has to have been made by its own elements,
and reached from inside the element that made it or past one whose reach
no counter outside could change; where the counts before and after differ,
the boxes kept after it are walked for one that reads a counter
(`boxesAfter`, `readsCounter`) — at the document's end, none — with none
counting down in the document (`BoxTree.reversed`), since that reads every
item before its scope's end.

### At the document's end

Where every root and tail a build makes ends the document (`atEnd`: no box
kept after the first of them, but those around them) and the change only
put nodes in, the lists, the text nodes, the text boxes and the styles are
spliced at their ends, and only the boxes around the new ones have their
text ranges worked out again. The element keeps its index of first boxes
and its reuse blockers for the new tree (`carryBlockers`), each of which
was a walk of the whole tree a chunk. The layout after takes nothing off
a kept block where nothing in the tree is offset after the flow
(`LayoutContext.offsets`): `unoffsetHeld` walked all a kept block holds,
reading each box's style, at every layout that kept it.

A walk of the bounds that kept a block's where the layout kept the block
where it was was tried, and taken out: it came to a quarter of a
millisecond a chunk at 300 sections, and a layout that kept everything
walked two boxes where it had walked the document, so `computePaintBounds`
went into the next document's first layout less warm — inline-l after
text-l in `htmlsweep.mjs`'s synthetic suite, 40 ms of a 600 ms mount. Its
reach was a double field on `Box` too, made a small integer: written a
fraction after the first layout, it moved every box to a new map as the
paint after reached it, and table-l's first paint took twice as long.

### What a whole build pays

What a tail reads of the boxes before it — where a block's line ended in
the text, and what the fix-up saw before the block — was first noted on
every box as it was built, two fields of `Box`. A document's first paint
at 300 sections (`docsweep.tsx`, `ACTION=mount`) came out 2% later on a
Mac, and two fields that nothing read, put on the base's `Box`, made the
base as much later: it was the size of every box a build makes, and not
what was written in it. Kept in a map by the box instead, the same two
cost every whole build of that document a millisecond, 2% of an edit's
frame.

So nothing a tail reads is noted on every box. Where a block's line ended
is worked out where a tail needs it (`textAfterBox`), from the text ranges
the tree keeps, and past them from the text boxes the fix-up dropped,
which keep their parent: a grid's white space under `white-space: pre` is
the document's text and in no box's range, and read off the ranges alone,
a tail after one cut the white space out of the text. What the fix-up saw
is kept by the boxes it wrapped (`RAN_FROM`), noted in the wrapping's own
loop and only in a build a chunk may follow (`BuildOptions.streaming`): a
box it did not wrap has its children as they were built, and a tail reads
them. The fix-up's loop over every box's children, the scan of the
document's facts and the walk for a tree's reuse blockers have the loops
they had (`scanElements`, `noteBlockers`, shared with what a chunk scans
and walks): two branches more in the first, a call for each element out of
the second's, and the third's step in a function of its own, whose
optimized code was thrown away for leaving the loop at every box with
children, were together half a millisecond of an edit's or an insert's
whole build. And the span maps a build of subtrees moves with a kept
block's lines are moved once by a stamp of the build (`shiftLines`), where
a set of them, an entry for every block kept after the change, was 0.3% of
what github.com allocates as its scripts build its subtrees.

### Measured

`docsweep.tsx` with `COMP=html`, a section appended every 50 ms to a
`<Html partial>` of 30, 100 and 300 sections (300 is 670 KB), run with
plain Node in the production build as A B B A A B, three runs a side, the
base the commit this one is on. Latency is from a chunk to the end of the
frame that first painted after it, in milliseconds; processor time is a
share of one core across the run.

| sections | backend | latency, median, before | after     | p95 before | after     | processor before | after  |
| -------- | ------- | ----------------------- | --------- | ---------- | --------- | ---------------- | ------ |
| 30       | macOS   | 14.1–14.6               | 10.4–10.9 | 19.0–19.1  | 14.6–15.4 | 52–53%           | 30–31% |
| 100      | macOS   | 22.1–22.4               | 11.6–12.2 | 25.9–26.9  | 15.5–16.1 | 72–73%           | 31–32% |
| 300      | macOS   | 40.0–44.2               | 14.6–14.8 | 68.5–75.3  | 16.9–17.6 | 125–134%         | 36–37% |
| 30       | X11     | 12.6–13.8               | 8.9–9.5   | 19.6–29.2  | 12.1–13.0 | 53–55%           | 30–33% |
| 100      | X11     | 20.8–21.5               | 8.9–10.0  | 26.5–33.9  | 13.8–15.7 | 74–75%           | 31–33% |
| 300      | X11     | 41.6–42.1               | 13.4–13.8 | 71.1–83.9  | 15.6–25.5 | 127–142%         | 38–39% |

A chunk's frame hardly grows with the document any more: from 30
sections to 300 its median goes from 10.8 ms to 14.7 on a Mac, where it
went from 14.4 to 40.4. What still grows is what a chunk copies or walks
whole — the source compared with what was written before it, the new
tree's lists and its map of styles copied from the old one, and the
children of what holds the tail, which the layout keeps one by one.

The same sweep's other cells at 300 sections — a mount, a paragraph
rewritten and one inserted mid-document, a scroll, a width dragged — came
out within each other's ranges on both backends, and so did
`htmlpage.mjs`'s loads, on a Mac, of react.dev, nextjs.org/blog,
tailwindcss.com, MDN and github.com with their scripts running, but for
MDN's processor time, which came out lower; tailwindcss.com's first frame
came out 3 ms later in one batch of three runs a side and within range in
the next. None of them is a stream, and a whole document's build, scan,
fix-up and layout are what they were.

### What it found

Holding a stream to a whole build of the same chunks found four bugs
that were there before it, which a whole build at every chunk had hidden:

- **A kept block's lines named the text where it was.** A build that
  lengthens the text before a block a layout keeps moved its boxes and not
  its lines, whose text offsets and span maps are what the selection, the
  hit test and an inline box's fragments are found by: a padded link's ink
  was found on no line. `shiftLines` moves them with the text.
- **An empty inline-block's baseline drifted at every layout.** Its
  baseline was read from the rectangle of an inline box in it that clips,
  which no layout sets (`childBaseline`): every layout after the first
  stood it elsewhere, a resize's as much as a chunk's.
- **A space before a float came and went with what the float held.** A
  float or a box out of the flow holds the collapsible space before it from
  its line's end only where it pushed text, so a root inside one whose text
  came to some, from none, made the space outside it another. A build apart
  of one is refused where its text comes to some or to none, a root's as
  much as a tail's.
- **A drawing kept from before drew a sprite as it was.** What a `<use>`
  names, the rules matched in its copy (`ShapeCopies`) and the id index
  they were looked up in were the last build's. A chunk that brings an id,
  or writes into a drawing, forgets them and draws every drawing again
  (`namesAnew`).

`test/html/subtree-build.test.ts` feeds generated documents and fragments
a chunk at a time — cut inside words, tags and attributes, and as often
between tags — with lists, tables, code, quotes, sheets, images, scripts,
drawings and sprites among them, and holds every step to the same chunks
styled, built and scanned whole: every box, line, list, style and bound,
and what the scan found. `STREAM_SEEDS` sweeps more of them, and
`STREAM_FROM` starts at one.
