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
| 5     | streams, `clip-path` shapes, `:muted`, implied documents, scoped registries, the Navigation API, `zoom`, typed `attr()` | 47.9%     |
| 6     | `SharedWorker`, the page's selection, scroll snapping, highlight painting, navigation fixes                             | 56.3%     |
| 7     | highlight decorations, view transitions, timeline properties, style queries, typed `attr()`, form navigations           | **59.4%** |

By focus area, from the first run to the seventh:

| focus area                       | tests | first | now   | what moved it                                                                                                                      |
| -------------------------------- | ----- | ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| anchor-positioning               | 234   | 16.7% | 36.6% | WPT's helper scripts running at all (#850)                                                                                         |
| attr                             | 19    | 8.8%  | 88.1% | `attr()` in any property, typed or not, and `CSS.registerProperty` (#866), in `style()` (#883)                                     |
| contrast-color                   | 5     | 0.0%  | 96.4% | `contrast-color()` (#851, #871)                                                                                                    |
| container-style-queries          | 19    | 0.0%  | 86.2% | `CSSContainerRule` (#852), the helpers running (#850), `var()` in `style()` (#872), dynamic changes and `display: contents` (#882) |
| custom-highlights                | 104   | 8.9%  | 86.1% | `CSS.highlights` and `::highlight()` (#856), their painting (#877, #878)                                                           |
| dialogs-and-popovers             | 18    | 27.7% | 84.4% | the Popover API, light dismiss, `closedby` (#854), the open dialogs (#873), `will-change` read back (#881)                         |
| fetch                            | 23    | 16.9% | 79.3% | bodies as Fetch extracts them (#857), responses that stream (#859), `SharedWorker` (#869)                                          |
| indexeddb                        | 24    | 0.0%  | 72.1% | `getAllRecords` and `getAll` options (#853), `importScripts` (#858), `SharedWorker` (#869)                                         |
| jspi-for-wasm                    | 6     | 2.5%  | 100%  | JSPI where Node has it behind a flag (#855)                                                                                        |
| media-pseudo-classes             | 5     | 0.0%  | 16.0% | `:muted` and `:volume-locked` (#861)                                                                                               |
| navigation                       | 439   | 0.0%  | 47.9% | session history and the Navigation API (#864, #867, #874, #875), form submissions (#886)                                           |
| scoped-custom-element-registries | 29    | 0.2%  | 65.2% | scoped registries, `setHTMLUnsafe` (#863)                                                                                          |
| scroll-driven-animations         | 146   | 4.9%  | 16.9% | the helpers running (#850), the timeline properties (#885)                                                                         |
| scroll-snap                      | 39    | 7.6%  | 39.7% | scroll snapping (#876)                                                                                                             |
| shape                            | 24    | 41.6% | 87.5% | `circle()`, `ellipse()`, `path()`, `shape()` and `url()` clip paths (#860)                                                         |
| view-transitions                 | 389   | 3.4%  | 19.2% | `startViewTransition()`, drawn as no transition, and its properties and selectors (#884)                                           |
| webcompat                        | 9     | 22.2% | 77.7% | the helpers running (#850), `user-select` (#861), the page's selection (#870), `Selection.modify()` (#880)                         |
| webrtc                           | 91    | 0.2%  | 0.2%  | —                                                                                                                                  |
| webtransport                     | 58    | 0.0%  | 0.0%  | —                                                                                                                                  |
| zoom                             | 33    | 21.2% | 90.9% | CSS `zoom` (#865)                                                                                                                  |

The second run's jump is the runner's as much as the engine's: WPT's
helpers — `computed-testcommon.js`, `parsing-testcommon.js` and their kin —
are strict scripts, and before #850 their declarations stayed in the
`eval` that ran them, so every test that loaded one failed whole. Several
areas went from a handful of subtests to thousands with that one change.

## What is not implemented, by area

What each area's remaining failures come down to, from the seventh run's
messages, the heaviest first. Two PRs that landed after it are measured
by area alone: scoped custom element registries at 75.7% (#887) and
dialogs and popovers at 87.1% (#888). Zoom read 87.8% in the seventh run
for one test the runner lost to a fault of its own — React's update-depth
limit, under five parallel jobs — which passes on its own and in its
sequence; it is counted at 90.9% above. "Out of reach" means it needs something this
architecture does not have, rather than more of what it has.

**anchor-positioning (36.5%).** Vertical writing modes, which `<Html>` does
not lay out (`anchor-position-writing-modes-001.html` alone is 864
subtests); `position-area` read back from `getComputedStyle` (632);
`anchor-size()` kept canonical in `el.style` (some 700); the `CSSOM` of
`@position-try` — `CSSPositionTryRule` and `CSSPositionTryDescriptors`
(about 340); and the used offsets of a number of layouts the reftests
check.

**attr (88.1%).** Attr-tainting, which keeps an attribute's value out of a
URL, and `background-image` serialized in full — `image-set()`, `src()`,
gradients — which `attr-security.html` and `attr-universal-selector.html`
need; `attr()` in an XML namespace; an `attr()` whose own name is a
`var()`.

**contrast-color (96.4%).** A computed value in `color(srgb …)` form,
where it is serialized as `rgb()`.

**container-style-queries (86.2%).** Range syntax in `style()`
(`style(5 >= calc(3 + 1))`, `style(1px <= 1em)`), and registered properties
compared as their type (`2em` against `100px`, `light-dark()` colours),
which needs a registered property's value computed; conditions that are
valid but unknown, and an escaped property name serialized.

**custom-highlights (86.1%).** `::target-text`, a highlight a page
registers in a frame's `CSS.highlights`, a highlight over a replaced
element, `highlightsFromPoint()`'s details, `getComputedStyle()` for a
highlight pseudo-element, and a few IDL details.

**dialogs-and-popovers (84.4%; 87.1% with #888).** A popover in a shadow
tree's slot, whose ancestors are the flat tree's (#888);
`requestFullscreen()` on a top-layer element, `select.showPicker()` and
`select:open`, which need a `<select>` widget's picker state in the
cascade, and light dismiss by a click on a dialog's padding.

**fetch (79.3%).** The service-worker variants of the tests, and range
requests that time out on WPT's slow server scripts.

**indexeddb (72.1%).** The same tests in a service worker, which does not
exist here; the rest pass.

**jspi-for-wasm (100%).**

**media-pseudo-classes (16.0%).** `:playing`, `:paused`, `:seeking`,
`:buffering` and `:stalled`, and what they read: a media element's state as
its player has it. A page's `play()` and `pause()` reach core's `<video>`,
but nothing comes back from the player to the page yet.

**navigation (47.9%).** The `navigate` event in another window — a link or
a form aimed at a frame, a `window.open` — where a frame without scripts
has no navigation of its own; `navigation.entries()` across documents (the
host's history is not the page's); `beforeunload`, `pagehide` and detached
documents in the methods' return values. Most of what is left times out
waiting for a cross-document navigation.

**scoped-custom-element-registries (65.2%; 75.7% with #887).** Which
registry a clone and `importNode()` give what they copy, and `getHTML()`.
#887 clones a clonable shadow host's tree and reads `initialize()` as it
now stands.

**scroll-driven-animations (16.9%).** The timeline properties are read and
serialized (#885) but drive nothing: `ScrollTimeline` and `ViewTimeline`,
an animation run on one, `animation-range`, and the CSS Typed OM values
(`CSS.percent()`) the scripted tests build them with are not there yet, nor
the `scroll-timeline` and `view-timeline` shorthands in `el.style`. Also
in the area, and out of reach: 59 `html/dom/render-blocking/` tests that
need rendering held while the parser is still in the document, where
`<Html>` parses a document whole before its scripts run.

**scroll-snap (39.7%).** Snapping after a user's scroll — the wheel, a
key, a drag — where a script's scroll snaps; `scroll-snap-stop`; and the
choice between several targets that line up, by focus and by the URL's
fragment, after a layout.

**shape (87.5%).** Two animation reftests that time out and one
`clip-path` reftest.

**view-transitions (19.2%).** `startViewTransition()` runs as the
specification orders it and draws as no transition (#884), which passes
the reftests of the page after one. Not there: the `::view-transition`
pseudo-element tree — its styles in `getComputedStyle()`, its animations
in `getAnimations()`, its frames, which most of the 177 failing reftests
draw — rendering held while the update runs, and cross-document
transitions, `pagereveal` and `pageswap`, which need a navigation between
documents in one renderer.

**webcompat (77.7%).** `select()` on a field reaching its widget, which
needs a selection setter on core's `<textinput>` and `<textarea>`; and the
order of a frame's `scroll`, media query and transition events against its
animation frames, which needs a frame's own viewport.

**webrtc (0.2%) and webtransport (0.0%).** Out of scope:
`RTCPeerConnection` and `WebTransport` are a network stack of their own,
and a document renderer embedded in an application has no business opening
peer connections or QUIC sessions behind its host's back. Were they
wanted, they would go through a seam the host answers, as a page's `fetch`
does, and there is none yet.

Across areas, three things recur:

1. **Service workers.** IndexedDB and fetch lose what is left of their
   tests to the variants that run in one; `SharedWorker` is there since
   #869.
2. **A parser that yields.** `<Html>` parses a document whole before its
   first script runs; anything that observes the parser mid-document —
   render blocking, `document.write` timing — fails.
3. **What comes back from a player.** Media state, and with it the media
   pseudo-classes, is one-way.
