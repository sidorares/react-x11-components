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
| 7     | highlight decorations, view transitions, timeline properties, style queries, typed `attr()`, form navigations           | 59.4%     |
| 8     | scroll and view timelines over Web Animations' model, anchor scroll and grammars, user scroll snapping, `:playing`      | 64.2%     |
| 9     | the view transition's pseudo-element tree, `CSSAnimation`s, media loading, service workers, style ranges, fullscreen    | 74.5%     |
| 10    | `getHTML()`, registries fixed where an element is made, the runner's `act()` one at a time                              | 75.2%     |
| 11    | CSS transitions and animations: their objects, their events, and what a page does to them                               | **75.5%** |

By focus area, from the first run to the eleventh:

| focus area                       | tests | first | now   | what moved it                                                                                                                                                                                                                                                       |
| -------------------------------- | ----- | ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| anchor-positioning               | 234   | 16.7% | 54.2% | WPT's helper scripts running at all (#850), the properties' grammars and computed values (#895), the default scroll shift and `position-visibility` (#896)                                                                                                          |
| attr                             | 19    | 8.8%  | 88.1% | `attr()` in any property, typed or not, and `CSS.registerProperty` (#866), in `style()` (#883)                                                                                                                                                                      |
| contrast-color                   | 5     | 0.0%  | 96.4% | `contrast-color()` (#851, #871)                                                                                                                                                                                                                                     |
| container-style-queries          | 19    | 0.0%  | 95.4% | `CSSContainerRule` (#852), the helpers running (#850), `var()` in `style()` (#872), dynamic changes and `display: contents` (#882), escaped names (#911), ranges and registered types in `style()` (#921)                                                           |
| custom-highlights                | 104   | 8.9%  | 86.1% | `CSS.highlights` and `::highlight()` (#856), their painting (#877, #878)                                                                                                                                                                                            |
| dialogs-and-popovers             | 18    | 27.7% | 94.7% | the Popover API, light dismiss, `closedby` (#854), the open dialogs (#873), `will-change` read back (#881), slotted popovers (#888), the root past the layout (#922), the Fullscreen API and modal popovers (#923)                                                  |
| fetch                            | 23    | 16.9% | 98.5% | bodies as Fetch extracts them (#857), responses that stream (#859), `SharedWorker` (#869), service workers (#918)                                                                                                                                                   |
| indexeddb                        | 24    | 0.0%  | 100%  | `getAllRecords` and `getAll` options (#853), `importScripts` (#858), `SharedWorker` (#869), transferred buffers (#917), service workers (#918)                                                                                                                      |
| jspi-for-wasm                    | 6     | 2.5%  | 100%  | JSPI where Node has it behind a flag (#855)                                                                                                                                                                                                                         |
| media-pseudo-classes             | 5     | 0.0%  | 100%  | `:muted` and `:volume-locked` (#861), `:playing` and `:paused` (#891), `canPlayType` (#904), a source loaded where there is a network (#916, #920)                                                                                                                  |
| navigation                       | 439   | 0.0%  | 50.6% | session history and the Navigation API (#864, #867, #874, #875), form submissions (#886), navigations aimed at a frame (#902)                                                                                                                                       |
| scoped-custom-element-registries | 29    | 0.2%  | 87.0% | scoped registries, `setHTMLUnsafe` (#863), clonable shadow roots (#887), `getHTML()` (#925), a registry fixed where an element is made (#926)                                                                                                                       |
| scroll-driven-animations         | 146   | 4.9%  | 71.8% | the timeline properties (#885), `ScrollTimeline` and `ViewTimeline` over Web Animations' model (#892), their grammars (#893), CSS's `animation-timeline` (#894), `animation-range` (#899), `CSSAnimation`s (#906), `timeline-scope` (#907), timeline offsets (#908) |
| scroll-snap                      | 39    | 7.6%  | 59.4% | scroll snapping (#876), after the wheel, a key and `focus()` (#890), the root's snap type (#905), the innermost area (#919)                                                                                                                                         |
| shape                            | 24    | 41.6% | 95.8% | `circle()`, `ellipse()`, `path()`, `shape()` and `url()` clip paths (#860), `CSSAnimation`s and `CSSTransition`s (#906, #928)                                                                                                                                       |
| view-transitions                 | 389   | 3.4%  | 60.7% | `startViewTransition()`, drawn as no transition, and its properties and selectors (#884), the pseudo-element tree (#909), `:active-view-transition` (#911), `CSSViewTransitionRule` (#914), animation events (#929)                                                 |
| webcompat                        | 9     | 22.2% | 77.7% | the helpers running (#850), `user-select` (#861), the page's selection (#870), `Selection.modify()` (#880)                                                                                                                                                          |
| webrtc                           | 91    | 0.2%  | 0.2%  | —                                                                                                                                                                                                                                                                   |
| webtransport                     | 58    | 0.0%  | 0.0%  | —                                                                                                                                                                                                                                                                   |
| zoom                             | 33    | 21.2% | 93.9% | CSS `zoom` (#865), inherited SVG strokes (#924)                                                                                                                                                                                                                     |

The second run's jump is the runner's as much as the engine's: WPT's
helpers — `computed-testcommon.js`, `parsing-testcommon.js` and their kin —
are strict scripts, and before #850 their declarations stayed in the
`eval` that ran them, so every test that loaded one failed whole. Several
areas went from a handful of subtests to thousands with that one change.

## What is not implemented, by area

What each area's remaining failures come down to, from the eleventh run's
messages, the heaviest first. "Out of reach" means it needs something this
architecture does not have, rather than more of what it has.

Two runs between the eighth and the eleventh moved because of the runner
rather than the engine. Before #927, the harness entered React's `act()`
from the page's own loop and from a `test_driver` action at once, and
two scopes that overlap left React's scope depth stuck for the rest of
the child: in every full run a chunk after
`window-resize-aborts-transition*.html` timed out
`zoom/iframe-zoom-nested.html` and ended `zoom/line-height.html` in
"Maximum update depth exceeded", which passes alone.

**anchor-positioning (54.2%).** Vertical writing modes, which `<Html>` does
not lay out (`anchor-position-writing-modes-001.html` alone is 864
subtests); the `CSSOM` of `@position-try` — `CSSPositionTryRule` and
`CSSPositionTryDescriptors` (about 340); a fixed box following an anchor
the pane scrolls, and fallbacks tried again after a scroll; anchors in a
multi-column or a top-layer box; `anchor-center`; and `calc()` simplified
around an `anchor()` (`calc((a + b) / 2)` as `calc(0.5 * (a + b))`).

**attr (88.1%).** Attr-tainting, which keeps an attribute's value out of a
URL, and `background-image` serialized in full — `image-set()`, `src()`,
gradients — which `attr-security.html` and `attr-universal-selector.html`
need; `attr()` in an XML namespace; an `attr()` whose own name is a
`var()`.

**contrast-color (96.4%).** A `color-mix()` or a relative colour over
`contrast-color()` computes to `color(srgb …)`, which needs a computed
colour to keep the space it was mixed in — every colour is kept as sRGB
for the drawing contexts and serialized as `rgb()` — and a `color()`
inside one is serialized as written, its `calc()`s not simplified.

**container-style-queries (95.4%).** Ranges, registered types and
unknown conditions in `style()` are there (#921). What is left: `inherit`
matched against a custom property, a registered `<length>` compared in
`cqi`, a `::before` matched against `style()`, and a change of the root's
`font-size` reaching a comparison in `rem`.

**custom-highlights (86.1%).** `::target-text`, a highlight a page
registers in a frame's `CSS.highlights`, a highlight over a replaced
element, `highlightsFromPoint()`'s details, `getComputedStyle()` for a
highlight pseudo-element, and a few IDL details.

**dialogs-and-popovers (94.7%).** `select.showPicker()` and
`select:open`, which need a `<select>` widget's picker state in the
cascade, and a dialog opened and closed during its own focus fix-up.

**fetch (98.5%).** Service workers run where the host lets a page have
them (#918). What is left is one subtest in each of the four variants of
`request-upload.h2.any`: a `POST` with a `ReadableStream` body that the
server answers 421, which HTTP/2's retry would send again.

**indexeddb (100%).**

**jspi-for-wasm (100%).**

**media-pseudo-classes (100%).** A media element loads its own source
where the page has a network (#916), from its first byte (#920), and
`:seeking`, `:buffering` and `:stalled` follow the load.

**navigation (50.6%).** The `navigate` event in another window — a link or
a form aimed at a frame, a `window.open` — where a frame without scripts
has no navigation of its own; `navigation.entries()` across documents (the
host's history is not the page's); `beforeunload`, `pagehide` and detached
documents in the methods' return values. Most of what is left times out
waiting for a cross-document navigation.

**scoped-custom-element-registries (87.0%).** A registry is fixed where
an element is made, a frame's window has its own and a copy keeps its
original's (#926), and `getHTML()` writes shadow trees (#925). What is
left is upgrades across documents and frames in the order the registry
was associated with them (`scoped-registry-define-upgrade-*`),
`initialize()` upgrading what a document already holds, `:defined` after
it, a template content's own document (whose registry is none) for
`createContextualFragment()` and a clone of what it holds, and the
attribute in an XHTML parse.

**scroll-driven-animations (71.8%).** CSS animations are `CSSAnimation`s
(#906), and on the clock tell their events and follow what a page does to
them (#929); on a scroll timeline they do neither yet. Also left: a view
timeline's `auto` insets, vertical writing modes, sticky subjects, and a
scroll timeline's time held until the next frame. Also in the area, and out
of reach: the `html/dom/render-blocking/` tests that need rendering held
while the parser is still in the document, where `<Html>` parses a
document whole before its scripts run.

**scroll-snap (59.4%).** The choice between several targets that line up,
after a layout, by focus and by the URL's fragment (the innermost first is
there, #919); snapping again when the root's `scroll-snap-type` changes;
`scroll-target-align`; `scroll-snap-stop: always` past a nearer target; a
snap position past what can be scrolled to; a focus that scrolls a target
already in view; and paged scrolling.

**shape (95.8%).** One reftest: a `clip-path` on a `foreignObject`, which
needs HTML laid out inside an SVG drawing.

**view-transitions (60.7%).** The `::view-transition` pseudo-element
tree is drawn (#909), its styles are in `getComputedStyle()` and its
animations in `getAnimations()`, which tell their events (#929). Not
there: rendering held while the update runs (`render-blocking/`), and
cross-document transitions, `pagereveal` and `pageswap`, which need a
navigation between documents in one renderer (`navigation/`) — between
them most of what is left; a transition in a frame; and writing modes,
`text-orientation` among the computed styles of its pseudo-elements.

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

**zoom (93.9%).** Two reftests: frames nested under `zoom`
(`iframe-zoom-nested.html`) and `zoom` on an inline SVG drawing
(`svg.html`).

Across areas, three things recur:

1. **A parser that yields.** `<Html>` parses a document whole before its
   first script runs; anything that observes the parser mid-document —
   render blocking, `document.write` timing — fails. It is most of what
   view transitions and scroll-driven animations have left.
2. **Navigation between documents in one renderer.** A cross-document view
   transition, `pageswap` and `pagereveal`, and the `navigate` event in
   another window need a document to be replaced in the same `<Html>`, as
   a browser's tab replaces it.
3. **A frame's own viewport.** A frame without a realm of its own shares
   the page's `matchMedia`, scroll events and animation frames, so what a
   frame's size answers, and the order of its rendering steps, are the
   page's.
