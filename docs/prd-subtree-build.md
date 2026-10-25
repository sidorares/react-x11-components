# Building only what changed

> **Status: design; phase 1 in progress.** Written 2026-10-25, from the
> thirteen pages `htmlpagejs.mjs` loads with their scripts running, on
> react-x11's macOS backend at 2x. Every number here is from those loads
> unless it says otherwise.

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

- the targets of the change records (`touchDocument(changes)`): the
  parent of nodes put in or taken out, an element whose attribute changed,
  the element around a text that changed;
- the elements whose styles the change can change (`ChangeScope.own`),
  and, discovered as the build styles them, the elements below one whose
  parent's style came out otherwise (`KeptStyles.follow`).

Each of those is in the subtree of a **rebuild root**: the nearest element
at or above it whose box is one whose content can be built apart from its
siblings. Nested roots merge into the outermost.

### What a rebuild root must be

The builder carries state across siblings, and a root is where all of it
is at a known value and comes out the same:

| builder state                                                          | why a root is safe for it                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| white space (`_ws`), a word's first letter (`_lettered`)               | a block-level box ends the line before it and starts its own (`_endLine`, `after`)                                       |
| the document's text (`_chunks`, `_length`) and every box's `textStart` | the root's text is built from its old start, and every later box shifts by the difference                                |
| `::first-letter` (`_firstLetter`)                                      | refused where any rule styles one                                                                                        |
| `::first-line` (`FIRST_LINE`)                                          | refused where any rule styles one                                                                                        |
| CSS counters and quotes (`_scopes`, `_quoteDepth`)                     | refused where the old or new subtree changes or reads a counter or a quote, a list item's included                       |
| depth (`_depth`, `MAX_DEPTH`)                                          | the root's depth is counted from its ancestors                                                                           |
| the fix-up (`fixUp`)                                                   | the root is block-level in a block or flex container, before and after, so its parent's anonymous boxes are as they were |

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
  a run of each list, since a subtree is a run of document order.
- **The text** (`text`, every `textStart`/`textEnd`, `subtreeTextStart`):
  the old subtree's range is replaced by the new, and what follows shifts.
- **The styles** (`styles`): the old subtree's elements go and the new
  subtree's come.
- **The flags** (`relative`, `tilted`, `negative`, `anchors`, …): each is
  `true` where some box needs looking at, so the new subtree's are added
  to the old, and one the old subtree set stays set — a walk that finds
  nothing, as before the change.
- **What is refused**: a subtree with a `<foreignObject>`, an orthogonal
  flow, a view transition's tree or a box in the top layer builds the
  whole document, as now.

### What it is held to

A generated test builds random documents and makes random changes to them
(`test/html/refresh.test.ts`'s generators), and holds the tree a subtree
build makes to the one a whole build makes: every box's kind, element,
style, text and range, every list in order, and the geometry after layout.

## Phase 2: laying out only what moved

Once unchanged boxes are the same boxes, a layout can leave alone a block
whose subtree did not change and whose constraints are as they were — the
width it is laid out at, the floats beside it, the margins that collapse
into it — and move it by however far the boxes before it moved, as a drag
already moves the blocks above the viewport (`keepAbove`, `FLOW_PLACE`).
That is the 33 ms of the Guardian's 48, and its design is for after phase 1
is measured.
