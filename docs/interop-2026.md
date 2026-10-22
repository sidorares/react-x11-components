# `<Html scripts>` against Interop 2026

A record of running the [Interop 2026](https://github.com/web-platform-tests/interop)
focus areas through [`<Html>`](components/html.md) with its scripts on, the
way the example browser runs a page: what it scores, what moved the score,
and what each area still needs. Written to be rerun: the runner is in the
repository, and the numbers below are its output.

## What is scored, and how it runs

Interop 2026 is twenty focus areas, each a list of web-platform-tests that
the browser vendors agreed to make pass. The lists are the
`interop-2026-*` labels in
[wpt-metadata](https://github.com/web-platform-tests/wpt-metadata) (anchor
positioning carries 2025's label), and wpt.fyi scores a run by the rule
results-analysis has: a test scores the fraction of its subtests that pass,
in thousandths and rounded down, a reftest or a crashtest all or nothing; a
focus area is the mean of its tests; the total is the mean of the areas.
Every area weighs the same, whatever its number of tests — the 5 of
`contrast-color` count as much as the 439 of `navigation`.

`scripts/conformance/interop.ts` works out the same number for `<Html>`:

```bash
git clone --depth 1 https://github.com/web-platform-tests/wpt-metadata.git
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/web-platform-tests/wpt.git
# in wpt: ./wpt serve, with server_host 127.0.0.1 and check_subdomains off
npx tsx scripts/conformance/interop.ts wpt wpt-metadata --jobs 5
```

Each test is loaded from WPT's own server, as the example browser loads a
page — `HtmlNetwork` for the document and what it asks for, the page's
scripts in the engine (`<Html scripts>`) — and its outcome read back the way
wptrunner reads a browser's (`scripts/conformance/testharness.tsx`):

- **testharness.js tests** report through the `testharnessreport.js` the
  host answers in place of the checkout's stub: every subtest's outcome and
  the harness's status.
- **Reftests** are rendered with their scripts on, held until
  `reftest-wait` is gone, read back at 800×600 in react-x11's in-process X
  server and compared with their reference within the `fuzzy` the test
  allows.
- **Crashtests** pass when the document loads and the renderer neither
  throws nor hangs.
- **`test_driver`** is answered by the host: the vendor script sends each
  command to a path the page's `fetch` reaches the host through, and the
  host injects the input into the X server — clicks, keys, wheel, pointer
  actions.

Each child runs under a memory cap of its own (`systemd-run --scope`), so a
document that runs away with memory is its own child's crash and not the
machine's. One in the set does: `request-upload.h2.any.worker.html` grows
past 27 GB. A full run of the 1,714 tests takes about ten minutes on five
jobs.

## Results

| run   | what it was                                                                                                             | total     |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| first | `<Html scripts>` as it stood, anchor positioning (#845) included                                                        | 9.1%      |
| 2     | a classic script is a script of its own (#850), `contrast-color()`                                                      | 13.4%     |
| 3     | `@container` in the CSSOM, IndexedDB's `getAll` options                                                                 | 19.6%     |
| 4     | popovers, JSPI, custom highlights, fetch bodies                                                                         | 29.9%     |
| 5     | streams, `clip-path` shapes, `:muted`, implied documents, scoped registries, the Navigation API, `zoom`, typed `attr()` | **47.9%** |

By focus area, from the first run to the fifth:

| focus area                       | tests | first | now   | what moved it                                                                  |
| -------------------------------- | ----- | ----- | ----- | ------------------------------------------------------------------------------ |
| anchor-positioning               | 234   | 16.7% | 36.5% | WPT's helper scripts running at all (#850)                                     |
| attr                             | 19    | 8.8%  | 81.1% | `attr()` in any property, typed or not, and `CSS.registerProperty` (#866)      |
| contrast-color                   | 5     | 0.0%  | 76.4% | `contrast-color()` (#851)                                                      |
| container-style-queries          | 19    | 0.0%  | 58.2% | `CSSContainerRule` (#852), and the helpers running (#850)                      |
| custom-highlights                | 104   | 8.9%  | 45.7% | `CSS.highlights` and `::highlight()` (#856)                                    |
| dialogs-and-popovers             | 18    | 27.7% | 67.1% | the Popover API, light dismiss, `closedby` (#854)                              |
| fetch                            | 23    | 16.9% | 66.6% | bodies as Fetch extracts them (#857), responses that stream (#859)             |
| indexeddb                        | 24    | 0.0%  | 48.0% | `getAllRecords` and `getAll` options (#853), a worker's `importScripts` (#858) |
| jspi-for-wasm                    | 6     | 2.5%  | 100%  | JSPI where Node has it behind a flag (#855)                                    |
| media-pseudo-classes             | 5     | 0.0%  | 16.0% | `:muted` and `:volume-locked` (#861)                                           |
| navigation                       | 439   | 0.0%  | 35.3% | session history and the Navigation API (#864)                                  |
| scoped-custom-element-registries | 29    | 0.2%  | 65.2% | scoped registries, `setHTMLUnsafe` (#863)                                      |
| scroll-driven-animations         | 146   | 4.9%  | 11.4% | the helpers running (#850)                                                     |
| scroll-snap                      | 39    | 7.6%  | 11.1% | the helpers running (#850)                                                     |
| shape                            | 24    | 41.6% | 87.5% | `circle()`, `ellipse()`, `path()`, `shape()` and `url()` clip paths (#860)     |
| view-transitions                 | 389   | 3.4%  | 5.6%  | the helpers running (#850)                                                     |
| webcompat                        | 9     | 22.2% | 55.5% | the helpers running (#850), `user-select` (#861)                               |
| webrtc                           | 91    | 0.2%  | 0.2%  | —                                                                              |
| webtransport                     | 58    | 0.0%  | 0.0%  | —                                                                              |
| zoom                             | 33    | 21.2% | 90.9% | CSS `zoom` (#865)                                                              |

The second run's jump is the runner's as much as the engine's: WPT's
helpers — `computed-testcommon.js`, `parsing-testcommon.js` and their kin —
are strict scripts, and before #850 their declarations stayed in the
`eval` that ran them, so every test that loaded one failed whole. Several
areas went from a handful of subtests to thousands with that one change.

## What is not implemented, by area

What each area's remaining failures come down to, from the fifth run's
messages, the heaviest first. "Out of reach" means it needs something this
architecture does not have, rather than more of what it has.

**anchor-positioning (36.5%).** Vertical writing modes, which `<Html>` does
not lay out (`anchor-position-writing-modes-001.html` alone is 864
subtests); `position-area` read back from `getComputedStyle` (632);
`anchor-size()` kept canonical in `el.style` (some 700); the `CSSOM` of
`@position-try` — `CSSPositionTryRule` and `CSSPositionTryDescriptors`
(about 340); and the used offsets of a number of layouts the reftests
check.

**attr (81.1%).** Attr-tainting, which keeps an attribute's value out of a
URL, and `background-image` serialized in full, which
`attr-security.html` needs; `attr()` in an XML namespace; an `attr()` whose
own name is a `var()`.

**contrast-color (76.4%).** Two parsing tests: arguments beyond the one
colour (`contrast-color(white max)` and its kin) are kept where they should
be refused, and a computed value in `color(srgb …)` form.

**container-style-queries (58.2%).** Style queries of registered properties
compared as their type (`style(--x: 10px)` against `calc(5px + 5px)`), range
syntax in `style()`, and a few serializations.

**custom-highlights (45.7%).** Most of the loss is reftests in
`painting/`: a highlight's `text-decoration` and its offsets, `text-shadow`,
highlights across shadow trees and in `::first-line`, and painting order
between overlapping highlights. Beside them, `highlightsFromPoint()` and a
few IDL details.

**dialogs-and-popovers (67.1%).** `requestFullscreen()` on a top-layer
element, `select.showPicker()`, `:open` on a closed `<details>`, and the
ordering of nested popovers' light dismiss.

**fetch (66.6%).** The service-worker and shared-worker variants of the
tests (six), and range requests that time out on WPT's slow server
scripts.

**indexeddb (48.0%).** The same twelve tests in a `SharedWorker` and a
service worker, which do not exist here; the other twelve pass.

**jspi-for-wasm (100%).**

**media-pseudo-classes (16.0%).** `:playing`, `:paused`, `:seeking`,
`:buffering` and `:stalled`, and what they read: a media element's state as
its player has it. A page's `play()` and `pause()` reach core's `<video>`,
but nothing comes back from the player to the page yet.

**navigation (35.3%).** The `navigate` event for a form's submission, a
cross-window navigation and a `window.open`; `navigation.entries()` across
documents (the host's history is not the page's); `beforeunload`,
`pagehide` and detached documents in the methods' return values. The
transition's lifetime and scroll restoration, which this run still failed
on, are fixed in #867, which takes the area to 44.4% on its own.

**scoped-custom-element-registries (65.2%).** `initialize()` on a
document that is not the window's, `getHTML()`, and registries inherited
through `importNode` and `cloneNode`.

**scroll-driven-animations (11.4%).** `ScrollTimeline` and `ViewTimeline`,
`animation-timeline`, `scroll-timeline`, `view-timeline`,
`timeline-scope` and `animation-range` — none is there yet, nor the CSS
Typed OM values (`CSS.percent()`) the scripted tests build them with. Also
in the area, and out of reach: 59 `html/dom/render-blocking/` tests that
need rendering held while the parser is still in the document, where
`<Html>` parses a document whole before its scripts run.

**scroll-snap (11.1%).** Scroll snapping itself: snap points, snapping
after a scroll ends and after a layout moves its target, and
`scroll-snap-stop`.

**shape (87.5%).** Two animation reftests that time out and one
`clip-path` reftest.

**view-transitions (5.6%).** `document.startViewTransition()` and the
`::view-transition` pseudo-element tree it draws — 195 of the 389 tests are
reftests of a transition's frames — and cross-document transitions,
`pagereveal` and `pageswap`, which need a navigation between documents in
one renderer.

**webcompat (55.5%).** Text entered by `test_driver` into an element with
`user-select: none` inside an editable one, and the timing of a `scroll`
event against rendering.

**webrtc (0.2%) and webtransport (0.0%).** Out of scope:
`RTCPeerConnection` and `WebTransport` are a network stack of their own,
and a document renderer embedded in an application has no business opening
peer connections or QUIC sessions behind its host's back. Were they
wanted, they would go through a seam the host answers, as a page's `fetch`
does, and there is none yet.

Across areas, three things recur:

1. **`SharedWorker` and service workers.** IndexedDB and fetch lose a
   quarter of their tests to the variants that run in them.
2. **A parser that yields.** `<Html>` parses a document whole before its
   first script runs; anything that observes the parser mid-document —
   render blocking, `document.write` timing — fails.
3. **What comes back from a player.** Media state, and with it the media
   pseudo-classes, is one-way.
