# Guessing a width the document cannot keep up with

> **Status: spike.** A prototype is behind a switch that is off
> (`guessing.enabled`, `src/html/layout/guess.ts`). Written 2026-11-01 from a
> heavy webmail page of 14,800 boxes, signed in, dragged on react-x11's macOS
> backend at 2x from a window 3,000 device pixels wide, where every step
> reflows.

**This is the last resort, not the plan, and for now it is not worth building.**
Exact reflow came first: what was wasted, never seen, or could be coalesced got a
fix of its own, and those fixes took this drag from 3.3 to 4.0 widths a second to
15 or 16. A guess adds some 15 to 20% on top of that ([numbers](#once-the-fixes-landed)).
It is kept here, behind its switch, for a page exact reflow cannot bring along, and
it never runs for a drag that keeps up.

## What a user sees today

A `<Frame>` pane that falls behind has its last frame stretched across by the
host (react-x11 `panehost.js`, `_anchoredNow`), and the exact frame replaces it
when it lands. On this page that is the experience the whole way through a
drag: a page repainting at three frames a second, every box wrong by as far as
the hand has gone, sidebars and icons squeezed with the rest.

`prd-visible-layout.md` cut a drag down to what can be seen, exactly, and that
is why most pages keep up. This page is the case it cannot reach. The document
is one window tall (a scroller holds the list), so nothing stops
(`partial=false` on every step); what can be seen is itself the cost.

## Where a step goes

200 steps, CPU-profiled, inline. A width costs two cycles: the width moves
(layout 55 ms, paint 45), then the page's script reacts (10 to 100 ms of JS,
sometimes 300, which restyles and builds a few subtrees, 50 to 90 ms, and
paints again, 45).

| share | what                                                               |
| ----: | ------------------------------------------------------------------ |
|   27% | paint: of it 57% native fills and text, 17% scroll bars, 15% icons |
|   22% | the page's own script, half of it a React render                   |
|   19% | flex, of which Yoga is 60%                                         |
|    6% | the build for what the script changed                              |
|    4% | passes after the flow, each a walk of the document                 |
|  1.2% | the text engine                                                    |
|  0.8% | block flow                                                         |
|    ~0 | intrinsic sizes: kept on their boxes                               |

What this says about the question the spike began with, which parts of layout
are most expensive to recalculate:

- **Text is not the cost.** It is 1.2% here. The obvious cut, skipping
  shaping, would have saved nothing.
- **Layout is not most of a frame.** A guess of layout alone cannot do better
  than remove a fifth to a quarter of this drag. Most of what a heavy page
  costs a drag is paint and the page's own reaction.
- **Most of the waste is not in the algorithms.** See [Order](#order).

## Layout is nearly a straight line in the width

A flex item that takes the room left over grows with the width, what is after
it moves with the edge, and what is before it stays. A block is as wide as what
it is in. So each box's rect is a function of the width in pieces, and a drag
walks along one piece: **two exact layouts give every box its slope**, and what
any width near them comes to is arithmetic, with no Yoga, no text engine and no
walk of what the window does not show.

Scored on the real page: every drawn box the window shows, at 111 widths from
3,000 to 2,120 device pixels, with the page's own reactions in the exact
layouts it is held to. Each strategy guesses a width from the exact layouts a
horizon away. The share of boxes whose worst edge lands within 2 device pixels:

| travel, device px | zoom (today) | stale | band | linear |
| ----------------: | -----------: | ----: | ---: | -----: |
|                 8 |          30% |   75% |  88% |   100% |
|                32 |          16% |   75% |  84% |    99% |
|               128 |           1% |   73% |  82% |    97% |
|               512 |           1% |   72% |  84% |    93% |

- **stale** is every box where it was: the frame cut off at the new width.
- **zoom** is what the host's stretch shows today.
- **band** is a nine-slice of the last frame, the page left of the first thing
  that moves staying put and the page right of the last moving with the edge.
- **linear** is each box extrapolated from its own last two exact rects.

Off the one width that breaks the line (the page's `min-width`, where 27% of
the boxes turn at once), linear holds 99.5% of boxes within 2 pixels after 128
pixels of travel and 98.0% after 512. What it misses is a box that turns partway
through the drag: a subject cell keeps its text's width until its row runs out
of room, and then shrinks, so a slope taken before that says it never will.

**Stale values below a depth, against stale slopes.** The idea the spike started
from was to lay out the top of the tree and keep what is under some depth as it
was. Scored fairly, by how much layout a cut skips and how many of the boxes it
skipped land within 2 pixels after 128 pixels of travel, inside a stretch with no
breakpoint:

| page         | cut at depth | layout skipped | rigid below it | linear below it |
| ------------ | -----------: | -------------: | -------------: | --------------: |
| webmail      |           10 |            91% |            76% |             99% |
| webmail      |           14 |            56% |            69% |             99% |
| GitHub, repo |           10 |            91% |             8% |            100% |
| GitHub, repo |           14 |            86% |            92% |            100% |

A depth is a page's markup and not its shape: the same cut is right on one page
and wrong on the next, and wrappers put what shows 15 to 25 levels down. Below any
depth a box mostly needs moving and resizing as what it is in does, which a rigid
copy cannot do and a slope does. A slope needs no cut at all, so nothing above it
needs laying out either.

**Where it is wrong: text that wraps.** A paragraph's height moves a line at a
time and everything under it with it, so no slope holds. Within 2 pixels after 128
pixels of travel, inside the stretches of each page with no breakpoint:

| page              | zoom (today) | linear, all spans | linear, away from a kink |
| ----------------- | -----------: | ----------------: | -----------------------: |
| webmail           |           1% |               97% |                    99.5% |
| GitHub, repo      |           1% |               81% |                    98.6% |
| Wikipedia article |           2% |               66% |                      81% |

On the article a median 5% of boxes leave their line at every 8-pixel step, and
across 512 pixels half of what is drawn is more than 2 pixels out. Such a page is
not what this is for, and the gate keeps it out: a long article lays out what can be
seen in 5 to 16 ms a step (`prd-visible-layout.md`) and never falls behind. A page
both this text-heavy and too slow to keep up would be drawn with its lines broken
where they last were, cut at the window or short of it, until the drag rests.

## The design

**A guess is never written to the boxes for good.** It is put on for the paint
that draws it and taken off again (`LayoutGuess.apply`, `undo`). A layout, a hit
test and a page's read all find the last exact layout, so nothing a layout keeps
can be kept from a guess, and a guess cannot be mistaken for a layout: that is
what marks it.

**It is entered only from behind.** The trigger is the gate `_behind()` already
is: two of the last three frames of a live drag past `FRAME_BUDGET_MS`. A drag
that keeps up never sees any of this, and a window that does not say it is being
dragged (X11's today) is laid out as ever.

**A page is held by what #1210 built, and reads what is there.** A drag that fell
behind holds what a page hears of its viewport (`viewportHeld`), and a guess adds
nothing to it. Reads need nothing either: a guess is on the boxes only for the paint,
so a page reads the last exact layout. The prototype first held `innerWidth` as
well, which the merged fix showed was not needed.

| when                               | what happens                           |
| ---------------------------------- | -------------------------------------- |
| the drag keeps up                  | exact, as ever                         |
| it falls behind (`_behind`)        | two exact layouts noted                |
| a width, with nothing else changed | a guess, no layout                     |
| anything else stale                | an exact layout, and slopes again      |
| a media query's answer turns       | an exact layout, and slopes again      |
| the hand rests 300 ms, or lets go  | the whole document laid out, page told |

**A breakpoint is exact.** A media query's answer turning is a kink no slope can
see, and on GitHub 86% of the boxes turn at one width. So a drag lays out at each
one, and takes its slopes again from there.

**What it skips, and what it keeps exact.** Skipped: all of layout, the passes
after the flow, the page's script and the build. A guess costs a walk of what the
window shows (a clipping box bounds it, so a hidden strip of 12,900 boxes costs
nothing) and arithmetic. Left exact: everything at rest. Left stale during the
drag: where lines break, what an ellipsis cuts, heights, and anything the page's
script would have changed.

## What the prototype shows

Processor time a width, each step waiting for its paint, 120 steps. Wall clocks
were no use here: four other sessions shared the machine at loads of 8 to 84, and
this number held within a fifth across most of that.

| what draws a width | CPU ms a width |
| ------------------ | -------------: |
| today              |  240, 244, 276 |
| page held, exact   |  109, 128, 144 |
| page held, a guess | 75, 75, 87, 94 |

Left out: a run where the page never loaded, and one held run at load 30 that read
230, so this number is not wholly proof against load. A frame by a guess is a paint
and next to nothing else, so what is left of it is the paint, 44 to 64 ms.

Through a real tab process, 200 steps of 4 pixels at 60 Hz, at loads of 4 to 8
where that could be had:

| what draws a width | widths a second | a paint behind the hand, median |
| ------------------ | --------------: | ------------------------------: |
| today              |   3.3, 3.5, 4.0 |                      298–329 ms |
| page held, exact   |        5.9, 8.2 |                      117–172 ms |
| page held, a guess |  2.1, 4.2, 11.9 |                       58–440 ms |

**The spread in the last row is the finding, not noise.** A guess needs the drag to
have fallen behind (three slow frames) and two exact layouts after that, and on this
page those are its slowest frames. The first guessed paint came 1.4 seconds into the
drag that reached 11.9, 2.4 into the one at 4.2, and 4.1 into the one at 2.1, which
was over by then. One more run, at load 82, reached 7.4 where today's read 1.2 at
load 41.

Looked at beside the exact layout at the same width, 120 pixels past the last
real one: the sidebar, folders, toolbar, rows, dates and avatars land where the
exact layout puts them. Three differences:

1. **Text is not cut again.** A subject keeps the ellipsis of the last exact
   layout, and one that had not begun to shrink runs into the star beside it.
2. **The page has not reacted.** It hides a sender from a strip as room runs out,
   and until it is told, the strip overlaps what follows it.

The first cut also drew a horizontal bar on a scroller it had narrowed, since an
extent is the last exact layout's. Bars across are hidden while a guess draws.

## Once the fixes landed

The numbers above are from the commit this spike began on. With every fix in
[Order](#order) merged, on a quiet machine, at loads of 2 to 3, through a real tab
process, three rounds a side and alternating:

| what draws a width | widths a second | behind the hand, median | a paint | CPU a width |
| ------------------ | --------------: | ----------------------: | ------: | ----------: |
| when this began    |         3.3–4.0 |                  300 ms |   45 ms |  240–276 ms |
| `master`, exact    |       14.9–15.9 |                   64 ms |   28 ms |    70–75 ms |
| `master`, a guess  |       17.4–18.3 |                   49 ms |   27 ms |    50–62 ms |

Exact reflow alone made this drag four times the rate, and a guess adds a sixth to
that. The first guess now comes some 0.45 seconds into a drag, since the exact
frames before it are that much quicker. What holds both at some 20 frames a second
is that a frame is still a 27 ms paint: a drag spends more of it there than in
layout, and a guess does nothing about it.

## Limits

- **It starts late.** A guess takes three frames behind and two exact layouts, so
  a short drag gets little of it: 1.4 to 4 seconds in on the commit this began on,
  and some 0.45 now. A document that fell behind once will again, so it could stay
  marked between drags, and slopes from the last drag still hold if nothing changed.
- **Heights are held**, and with them where lines break. See above.
- **A box that turns partway through a drag** is wrong from there until the rest,
  by as far as the drag has gone past the turn.
- **Widgets stay where they were last reported.** A `<textinput>` or a `<select>`
  mounted beside the document is not moved by a guess. The webmail page's search
  field does not show it, being as wide as its frame; a page with a control at the
  right of a row would.
- **What a presenter runs on a layer, and columns, are not guessed.** A drag over
  either stays exact (`_lifted`, `ExactLayout.columns`), as does a turned flow.
- **A page whose own timers keep changing it** gets an exact layout for each
  change. The slopes stay, but each of those frames costs what it did.
- **Paint is the floor.** A guess removes layout, and each frame is still a paint.
- **It rests on `liveResizing`**, so X11, which says nothing of a drag, sees none
  of this.

## Order

Exact first. Each of these found here was a fix of its own, and all have landed:

1. **A page's reaction, coalesced** during a drag that fell behind (#1210). A crude
   hold took a tab from 3.3 to 4.0 widths a second to 5.9 to 8.2.
2. **Scroll bars measured where none can show** (#1207). `scrollBarsOf` walked a
   scroller's content before asking whether a bar can show, so an `overflow: hidden`
   strip of 12,700 boxes was walked after every layout to draw nothing. 147
   containers measured a paint became 4.
3. **Inline `<svg>` parsed at every paint** (#1211, and #1216 for a told refresh).
   `paintSvg` went from some 8 ms a paint to 3 to 5.
4. **Stacking worked out at every layout** (#1209), where `hoistNegative` reads only
   styles and the tree, which a width cannot change. 571 ms of a drag became 3.
5. **A row laid out without Yoga** (#1215). A flex box of one line makes no call into
   Yoga, with results held to Yoga's: 19% off this drag's layout time.

Looked at and ruled out: **overdraw**. A paint's `fillRect`s cover 1.17 windows, so
the fills are what is drawn, and there is nothing there to cull.

And only then **the guess**, for what is still behind. If it is ever wanted:

6. Cut text again in the guess, where it is cheap here: the engine is 1.2% of this
   drag, so the visible ellipses could be laid out for real.
7. Report widgets from the guess, at whatever that costs.
8. A nine-slice in the host, for the frames a pane still misses: it needs no pane
   frame at all, and at 84% within 2 pixels is far nearer than today's stretch's 1%,
   on an app-shaped page. On a page with no one stretching band it is no better.

## Decisions wanted

- **Whether to build it at all.** Not now. It would add some 270 lines and a second
  way to draw a document for a sixth more widths a second on the page that needed it
  most, and it is wrong where exact is right. Paint is where the time is now. Hold it
  for a page exact reflow cannot bring along, and measure on that page.
- **Whether a drag anchors while it moves**, if it is built. The prototype lays out
  only at breakpoints and at rest. An exact layout every so many pixels would keep
  kinks from growing, at one slow frame each.

## Trying it

On a backend that says it is being dragged, a Mac today, in the example browser:

```bash
BROWSER_GUESS=1 npm run examples:browser -- <url>
```

The page has to fall behind for a guess to run: two of three frames past 12 ms.
