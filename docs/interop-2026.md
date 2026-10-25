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

By focus area, from the first run to the eleventh. Three areas have been
measured again since, each by the PR that moved it, and their "now" is that
PR's run, which the last column names; the total above is the eleventh
run's.

| focus area                       | tests | first | now   | what moved it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ----- | ----- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| anchor-positioning               | 234   | 16.7% | 84.4% | WPT's helper scripts running at all (#850), the properties' grammars and computed values (#895), the default scroll shift and `position-visibility` (#896), and since the eleventh run `anchor-center`, `anchor()` in math functions and the `@position-try` CSSOM ([#984]) and anchor positioning in vertical writing modes' axes ([#1013]), chains of anchors and sticky anchors ([#1014]), positioned boxes in a browser's order ([#1015]), tree-scoped anchor names ([#1016]), position options as the box's style ([#1017]), and `anchor-size()` wherever CSS allows it ([#1018]), whose run of the area this is |
| attr                             | 19    | 8.8%  | 88.1% | `attr()` in any property, typed or not, and `CSS.registerProperty` (#866), in `style()` (#883)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| contrast-color                   | 5     | 0.0%  | 96.4% | `contrast-color()` (#851, #871)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| container-style-queries          | 19    | 0.0%  | 100%  | `CSSContainerRule` (#852), the helpers running (#850), `var()` in `style()` (#872), dynamic changes and `display: contents` (#882), escaped names (#911), ranges and registered types in `style()` (#921), and since the eleventh run `inherit` and container units in `style()` ([#990]), whose run of the area this is                                                                                                                                                                                                                                                                                              |
| custom-highlights                | 104   | 8.9%  | 94.2% | `CSS.highlights` and `::highlight()` (#856), their painting (#877, #878), and since the eleventh run `::target-text` ([#971]) and a highlight's computed style, `highlightsFromPoint()` and a frame's own registry ([#992]), whose run of the area this is                                                                                                                                                                                                                                                                                                                                                            |
| dialogs-and-popovers             | 18    | 27.7% | 94.7% | the Popover API, light dismiss, `closedby` (#854), the open dialogs (#873), `will-change` read back (#881), slotted popovers (#888), the root past the layout (#922), the Fullscreen API and modal popovers (#923)                                                                                                                                                                                                                                                                                                                                                                                                    |
| fetch                            | 23    | 16.9% | 98.5% | bodies as Fetch extracts them (#857), responses that stream (#859), `SharedWorker` (#869), service workers (#918)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| indexeddb                        | 24    | 0.0%  | 100%  | `getAllRecords` and `getAll` options (#853), `importScripts` (#858), `SharedWorker` (#869), transferred buffers (#917), service workers (#918)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| jspi-for-wasm                    | 6     | 2.5%  | 100%  | JSPI where Node has it behind a flag (#855)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| media-pseudo-classes             | 5     | 0.0%  | 100%  | `:muted` and `:volume-locked` (#861), `:playing` and `:paused` (#891), `canPlayType` (#904), a source loaded where there is a network (#916, #920)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| navigation                       | 439   | 0.0%  | 50.6% | session history and the Navigation API (#864, #867, #874, #875), form submissions (#886), navigations aimed at a frame (#902)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| scoped-custom-element-registries | 29    | 0.2%  | 87.0% | scoped registries, `setHTMLUnsafe` (#863), clonable shadow roots (#887), `getHTML()` (#925), a registry fixed where an element is made (#926)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| scroll-driven-animations         | 146   | 4.9%  | 71.8% | the timeline properties (#885), `ScrollTimeline` and `ViewTimeline` over Web Animations' model (#892), their grammars (#893), CSS's `animation-timeline` (#894), `animation-range` (#899), `CSSAnimation`s (#906), `timeline-scope` (#907), timeline offsets (#908)                                                                                                                                                                                                                                                                                                                                                   |
| scroll-snap                      | 39    | 7.6%  | 59.4% | scroll snapping (#876), after the wheel, a key and `focus()` (#890), the root's snap type (#905), the innermost area (#919)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| shape                            | 24    | 41.6% | 95.8% | `circle()`, `ellipse()`, `path()`, `shape()` and `url()` clip paths (#860), `CSSAnimation`s and `CSSTransition`s (#906, #928)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| view-transitions                 | 389   | 3.4%  | 60.7% | `startViewTransition()`, drawn as no transition, and its properties and selectors (#884), the pseudo-element tree (#909), `:active-view-transition` (#911), `CSSViewTransitionRule` (#914), animation events (#929)                                                                                                                                                                                                                                                                                                                                                                                                   |
| webcompat                        | 9     | 22.2% | 77.7% | the helpers running (#850), `user-select` (#861), the page's selection (#870), `Selection.modify()` (#880)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| webrtc                           | 91    | 0.2%  | 0.2%  | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| webtransport                     | 58    | 0.0%  | 0.0%  | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| zoom                             | 33    | 21.2% | 93.9% | CSS `zoom` (#865), inherited SVG strokes (#924)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The second run's jump is the runner's as much as the engine's: WPT's
helpers — `computed-testcommon.js`, `parsing-testcommon.js` and their kin —
are strict scripts, and before #850 their declarations stayed in the
`eval` that ran them, so every test that loaded one failed whole. Several
areas went from a handful of subtests to thousands with that one change.

## What is not implemented, by area

What each area's remaining failures come down to, from the eleventh run's
messages, the heaviest first, and then from the PRs that took them up
after it: each gap the eleventh run left here went to a PR of its own, and
what follows is what each PR says it left. "Out of reach" means it needs
something this architecture does not have, rather than more of what it
has. An area's number is the eleventh run's unless its paragraph names a
PR that measured it again. Most of those PRs were checked against ports
and models of the WPT cases they name rather than a run, so what they
moved shows in the next run.

Three of them are whole only once an upstream release is cut, and until
then they draw what was drawn before: a field's selection in its widget
([#972]) needs [react-x11#1006], a `<select>`'s picker ([#983]) needs
[react-x11#1010], and the HTML in a `foreignObject` ([#979], [#982]) needs
[ntk#549]. All three are merged upstream and are in no release yet.

Two runs between the eighth and the eleventh moved because of the runner
rather than the engine. Before #927, the harness entered React's `act()`
from the page's own loop and from a `test_driver` action at once, and
two scopes that overlap left React's scope depth stuck for the rest of
the child: in every full run a chunk after
`window-resize-aborts-transition*.html` timed out
`zoom/iframe-zoom-nested.html` and ended `zoom/line-height.html` in
"Maximum update depth exceeded", which passes alone.

**anchor-positioning (84.4%).** The number is [#1018]'s run of the area's
234 tests, made locally; [#1013]'s, on a base that already held [#984] and
scored 69.7%, was 72.6%, [#1014]'s 76.6%, [#1015]'s 78.3%, [#1016]'s 80.1%
and [#1017]'s 82.4%. `anchor-center`; the self-alignment of an absolutely
positioned box between its insets and in a `position-area`; `anchor()`
inside `calc()` and the other math functions, serialized simplified as CSS
Values has it; the CSSOM of `@position-try`, `CSSPositionTryRule` and
`CSSPositionTryDescriptors` (about 340 subtests at the eleventh run); a
fixed box following an anchor the pane scrolls; and fallbacks tried again
after a scroll: all are there ([#984]). Anchor positioning works in the
axes of a vertical writing mode ([#1013]): a box laid out in the frame of
a vertical flow ([#975]) is placed by what it names in the page's axes,
its logical keywords read against its containing block's writing mode, and
`anchor-position-writing-modes-001.html`'s 864 subtests pass, with the
position-area and try-tactic tests in vertical modes. A box anchored to an
anchored box a scroll moves moves with it, as a chain, and one anchored to
a sticky box with where it sticks; and `anchors-visible` hides a box whose
anchor `visibility` hides or that is in a box it hid ([#1014]). Positioned
boxes are laid out in a browser's order where there are anchors, so an
anchor inside an absolute box is laid out before a box anchored to it that
comes first ([#1015]). Anchor names, `anchor-scope` and `@position-try`
names are of the tree their rule was written in, as tree-scoped names,
matched strictly as Chrome matches them ([#1016]). The position option a
box is placed by is its computed style, its last successful option changes
once a rendering and with the `@position-try` rules it names, and
`position-try-order` sorts the options ([#1017]). `anchor-size()` is a
length in the least and greatest sizes, the insets and the margins as well
as in the sizes, an `anchor()` of the other axis is its fallback, a tactic
flips the self-alignment, and an anchor in the top layer is no anchor of a
box below it ([#1018]). What is left, the heaviest first: anchored boxes
inside a multi-column's columns (a dozen tests); the cascade of a
`@position-try` rule's declarations, which an `!important` one, an
animation and a transition outrank, and its layers
(`position-try-cascade*.html`); the root scroller scrolling across, which
the `anchor-scroll-position-try-*` tests in a vertical or right-to-left
root and `anchor-scroll-nested.html` need; a chain through scrollers
nested in scrollers (`anchor-scroll-chained-002.html` and `004`); a
horizontal box inside a vertical flow, which is no frame of its own; a
popover's implicit anchor, `anchors-valid`, an `anchor()` inside another's
fallback, and the scrollable containing block of a box with a default
anchor; a scroll offset remembered for each anchor reference, where each
layout takes an anchor where it is scrolled to then; `safe` and `unsafe`,
read as the default overflow alignment; and a computed value simplified
around an `anchor()`, where only a specified one is.

**attr (88.1%).** Attr-tainting keeps an attribute's value out of a URL,
`background-image` is serialized in full, and `attr()` reads an attribute
in an XML namespace and takes a name a `var()` gives it ([#993]). In
[#993]'s own run, the two tests the eleventh run named went from 9 of 32
subtests to 30 (`attr-security.html`) and from 0 of 1 to 1
(`attr-universal-selector.html`). What is left: a registered custom
property computing a typed value, and `src(string(…))`, whose `string()`
is in no spec yet, one subtest each; and `attr-null-namespace.xhtml`, which
needs DOM namespaces — `getAttributeNS` and `setAttributeNS` drop the
namespace, and the document is parsed as HTML.

**contrast-color (96.4%).** A computed colour keeps the space it was
written or mixed in, so a `color-mix()` or a relative colour over
`contrast-color()` reads back as `color(srgb …)`, and a `color()` inside
one is serialized with its `calc()`s simplified ([#985]). Those are the
three subtests the eleventh run left, which [#985] holds to WPT's
expectations in tests of its own.

**container-style-queries (100%).** Every subtest passes in [#990]'s run
of the area's 19 tests, made locally against a static server: `inherit`
and `unset` in `style()` take the value the container gets from its
parent, a container unit in a query is of the size container above the
query container, `rlh` is the root's line height, and a `::before` with no
`content` answers `getComputedStyle()` with the style its rules give it. A
change of the root's `font-size` reaching a comparison in `rem` had passed
since [#932]. Beside the area, container units are read in horizontal axes
under a container whose writing mode is vertical: two subtests of
`container-units-in-at-container.html`, and the `vi`/`vb` case of
`style-query-registered-custom-root-relative-units-change.html`.

**custom-highlights (94.2%).** The number is [#992]'s run of the area's
104 tests, made locally on a base that reproduced the eleventh run's
86.1%. A highlight pseudo-element's computed style, `highlightsFromPoint()`
as the spec has it, a frame's own `CSS.highlights`, a highlight over a
replaced element and the IDL details are there ([#992]), and so is
`::target-text`, lit where a URL's text directive names text ([#971]). What is left: the two tests that tamper
with `Set.prototype` and `Map.prototype`, which time out on the facade's
own collections calling what the page replaced, and want private
collection prototypes across all of `dom.ts`; a rule's `style` written
through `cssRules[i].style`, a read-only snapshot in the facade
(`custom-highlight-painting-text-decoration-dynamic-001`); the two
`::target-text` tests that go to `#:~:text=…` from a script in the same
document, which `<Html>` does not run and the runner hands back in no
`baseUrl`; `highlightsFromPoint()` over a frame's own registry, where a
frame document's range asks the page's view for its rects; text in
`hidden="until-found"` or a closed `<details>`, which has no boxes and is
not searched; `::search-text`; a highlight over a form control; and the
painter's chain going up by the parent rather than the flat tree. Two more
fail on pixels and on timing: ligatures in the mplus font
(`custom-highlight-painting-020`), and a frame resized one animation frame
before the screenshot (`custom-highlight-dynamic-container-metrics-001`, which passes
now and then).

**dialogs-and-popovers (94.7%).** Whether a drop-down `<select>`'s menu is
down is the document's now: `:open` and `:closed` match it, and
`select.showPicker()` drops it, with HTML's checks and the transient
activation it spends ([#983]). The menu drops only on a core with
[react-x11#1010]; until that is released, `showPicker()` makes its checks
and spends the activation, nothing drops, and `:open` matches no select.
What is left: `input.showPicker()`, which shows nothing, since `<Html>` has
no date, time, colour or file picker and no `<datalist>` list; the
`SecurityError` for a cross-origin frame; and an activation shared across
frame realms. The dialog opened and closed during its own focus fix-up
(`dialog-closedby-start-open.html`) is unsettled: [#983] reproduced both its
subtests in a hosted page and both behave as the test expects, so seeing
what fails in the run needs WPT's server.

**fetch (98.5%).** The subtest the eleventh run left in each of the four
variants of `request-upload.h2.any` — a `POST` with a `ReadableStream`
body that the server answers 421 — wants the 421 back rather than a retry,
and gets it: a body that is a stream and nothing else is handed to the
runtime's `fetch` as a stream, which neither Node nor Bun sends again
([#991]). [#991] tested it against a loopback server that counts requests
as WPT's does, not against WPT's own.

**indexeddb (100%).**

**jspi-for-wasm (100%).**

**media-pseudo-classes (100%).** A media element loads its own source
where the page has a network (#916), from its first byte (#920), and
`:seeking`, `:buffering` and `:stalled` follow the load.

**navigation (50.6%).** A document a navigation leaves hears
`beforeunload`, `pagehide`, `visibilitychange` and `unload`, and the
methods of a document that has gone reject ([#973]). A tab's documents are
one session history that a host hands each of them, over which
`navigation.entries()` is the run of entries around the current one that
share its origin, and a document hears `pageswap` and `pagereveal`
([#980]). What is left: the `navigate` event in another window — a link or
a form aimed at a frame, a `window.open` — where a frame without scripts
has no navigation of its own; a frame's history inside its tab's;
restoring a document's scroll when it is shown again; a back-forward
cache, so `persisted` is always false; `navigator.sendBeacon`, which still
answers false; a page in a background tab, which stays `visible`; and a
`beforeunload` for an `iframe.src` its parent assigns, told late, as the
frame goes. The runner hands its documents no `session` and no
`navigate`, so a run does not yet go through the history across documents
that [#980] keeps. At the eleventh run most of what was left timed out
waiting for a cross-document navigation.

**scoped-custom-element-registries (87.0%).** `initialize()` upgrades
what its registry defines wherever the element is ([#933]), `upgrade()`
keeps to its own registry and a copy of no registry keeps none ([#934]),
and `createContextualFragment()` parses in its context's registry and a
template's in none ([#935]). A scoped registry upgrades in each document it
was associated with, in the order each was, and a frame's window's
registry works in the frame's document ([#988]). In [#988]'s run of the
area's 29 tests — `<Html scripts>` on the mock backend, through a runner
of its own — `scoped-registry-define-upgrade-order` went from 3 of 7
subtests to 7, `scoped-registry-define-upgrade-criteria` from 8 of 14 to
9, and `scoped-custom-element-registry-customelementregistry-attribute`
from 22 of 23 to 23. What is left: `window.open('about:blank')` answering
a window where it answers null, so the "other frame trees" test of
`-criteria` throws in its cleanup and the four after it never run; the
parser case of `Element-customElementRegistry-exceptions`, which writes a
script into a frame with `document.write`, which never runs here, and
reads `host` off the frame's window by name; and the attribute in a
top-level XHTML document, which `<Html>` parses as HTML.

**scroll-driven-animations (71.8%).** A CSS animation on a scroll timeline
tells its events and follows what a page does to it, as one on the clock
does; a scroll timeline's time is the last frame's until the next; and a
view timeline's `auto` insets and a sticky subject's range are there
([#986]). What is left: the vertical axes — `block` and `inline` in a
vertical writing mode, where a subject inside one of [#975]'s turned
frames is in the frame's coordinates, and a `vertical-rl` scroller's
negative offsets; a `CSSAnimation` a page already holds, refreshed from
the cascade only when `getAnimations()` lists it, so a style that pauses
it does not show on that object (`scroll-timeline-paused-animations.html`,
`view-timeline-paused-animations.html`); a clock-driven CSS animation's
`playbackRate` carried to the cascade
(`scroll-timeline-update-reversed-animation.html`); animation triggers on
scroll timelines; and the viewport's horizontal scroll. Also in the area:
the `html/dom/render-blocking/` tests, which need rendering held while
what blocks it is pending. The parse yields to the scripts that block it
now ([#978]), so they are no longer out of reach, and holding the
rendering is the half of it not started.

**scroll-snap (59.4%).** Paged scrolling, `scroll-snap-stop: always`, the
viewport snapping under the wheel and the keys, a re-snap after a layout
that keeps the focused area, then the target, then the block axis's, the
spec's order among several areas that line up, a scroll target lined up
where a scroll brings it into view, and a `focus()` that scrolls nothing
where its element is already shown are there ([#976]). A snap position
past what can be scrolled to was already clamped. What is left: snapping
the viewport across, which has no horizontal overflow to snap since
`<Html>` lays a document out at the pane's width (the x half of
`changing-scroll-snap-type-on-root-element`); snap positions in a
right-to-left scroll container and in a vertical writing mode; the snap
positions before and after an area larger than the snapport limiting where
a scroll may rest in it (`scroll-snap-stop-002-nested`,
`overflowing-snap-areas-nested`); and `focus-element-no-snap`, which asks
`focus()` not to snap at all, against what `snap-on-focus` and
`scroll-target-align-003` ask — which reading it intends is unsettled.

**shape (95.8%).** One reftest: a `clip-path` on a `foreignObject`. The
HTML in an object is laid out in the object and drawn in the drawing's
order, with the drawing's transforms, opacity, mask and clip path on the
context ([#979]), through a hook `SvgView` hands it ([#982]), which is
[ntk#549]. Until an ntk release carries the hook, no object is built, laid
out or drawn, as before.

**view-transitions (60.7%).** The `::view-transition` pseudo-element
tree is drawn ([#909]), its styles are in `getComputedStyle()` and its
animations in `getAnimations()`, which tell their events ([#929]). Not
there: rendering held while the update runs (`render-blocking/`), where
the parse yields to the scripts that block it now ([#978]) and holding the
rendering is the half not started; and cross-document transitions
(`@view-transition { navigation: auto }`) — `pageswap` and `pagereveal` are
told where one document replaces another ([#980]), with a `viewTransition`
of null, but the old state is not captured before the element takes the
new source, and a `pageswap` listener's name changes do not reach a
capture — between them most of what is left; a transition in a frame; and
a transition's vertical axes, which [#975] leaves, though `writing-mode`
and `text-orientation` are in `getComputedStyle()` now.

**webcompat (77.7%).** A page's `select()` and `setSelectionRange()` reach
the field's widget, the getters read the user's caret, and text the user
selects is told as `select` ([#972]), on a core with [react-x11#1006];
until that is released, the selection is kept and read back as before and
the widget shows none of it. A frame's window answers for its own viewport
and hears its `resize` and its media queries' `change` in HTML's order
([#977]). What is left is the order of a frame's `scroll` events against
its animation frames: a frame in the page's realm scrolls nothing —
`scrollX` is 0 and `scrollTo()` does nothing — and a scroll container's
`scroll` and the CSS animation and transition events are still told by
timers of their own.

**webrtc (0.2%) and webtransport (0.0%).** Out of scope:
`RTCPeerConnection` and `WebTransport` are a network stack of their own,
and a document renderer embedded in an application has no business opening
peer connections or QUIC sessions behind its host's back. Were they
wanted, they would go through a seam the host answers, as a page's `fetch`
does, and there is none yet.

**zoom (93.9%).** The two reftests the eleventh run failed — frames nested
under `zoom` (`iframe-zoom-nested.html`) and `zoom` on an inline SVG
drawing (`svg.html`) — draw as their references do in [#987]'s ports of
them, which render each test and its reference through `<Html>` and
compare them: a drawing's lengths in a unit, a rule's lengths and font on
a shape, and a frame's zoom set after its layout were what they needed.
What is left beside them: `<textPath>`, of which ntk's `SvgView` draws
nothing, in a test or in its reference; a `font` shorthand in a shape's
own `style` attribute where no rule reaches the shape; and a face named
only by SVG text through a rule, which is not asked for on that account.

Across areas, three things recurred, and each now has its first slice:

1. **A parser that yields.** The parse waits at each script that blocks it,
   and `document.write` writes into it ([#978]). Not started is the other
   half, render blocking — `blocking="render"`, `<link rel=expect>`, the
   rendering and the animation frames held while what blocks them is
   pending — which is what view transitions and scroll-driven animations
   have left of it. A frame's document is still parsed whole before its
   scripts run, and a `document.write` with no insertion point is ignored.
2. **Navigation between documents in one renderer.** A tab's documents are
   one session history that the host hands each of them, and a document
   hears how it was shown and where it goes, `pageswap` and `pagereveal`
   among it ([#973], [#980]). Left: the capture a cross-document view
   transition starts from, a frame's history inside its tab's, the
   `navigate` event in another window, and the example browser and the
   runner on a session.
3. **A frame's own viewport.** A frame's window answers `matchMedia`,
   `visualViewport` and its animation frames for its own box, and every
   window hears its `resize` and its media queries' `change` in HTML's
   order ([#977]). Left: a frame in the page's realm scrolls nothing; a
   frame in a realm of its own runs its rendering steps on its own clock
   rather than in the page's; and a scroll container's `scroll` and the
   CSS animation events keep timers of their own.

[#909]: https://github.com/sidorares/react-x11-components/pull/909
[#929]: https://github.com/sidorares/react-x11-components/pull/929
[#932]: https://github.com/sidorares/react-x11-components/pull/932
[#933]: https://github.com/sidorares/react-x11-components/pull/933
[#934]: https://github.com/sidorares/react-x11-components/pull/934
[#935]: https://github.com/sidorares/react-x11-components/pull/935
[#971]: https://github.com/sidorares/react-x11-components/pull/971
[#972]: https://github.com/sidorares/react-x11-components/pull/972
[#973]: https://github.com/sidorares/react-x11-components/pull/973
[#975]: https://github.com/sidorares/react-x11-components/pull/975
[#976]: https://github.com/sidorares/react-x11-components/pull/976
[#977]: https://github.com/sidorares/react-x11-components/pull/977
[#978]: https://github.com/sidorares/react-x11-components/pull/978
[#979]: https://github.com/sidorares/react-x11-components/pull/979
[#980]: https://github.com/sidorares/react-x11-components/pull/980
[#982]: https://github.com/sidorares/react-x11-components/pull/982
[#983]: https://github.com/sidorares/react-x11-components/pull/983
[#984]: https://github.com/sidorares/react-x11-components/pull/984
[#985]: https://github.com/sidorares/react-x11-components/pull/985
[#986]: https://github.com/sidorares/react-x11-components/pull/986
[#987]: https://github.com/sidorares/react-x11-components/pull/987
[#988]: https://github.com/sidorares/react-x11-components/pull/988
[#990]: https://github.com/sidorares/react-x11-components/pull/990
[#991]: https://github.com/sidorares/react-x11-components/pull/991
[#992]: https://github.com/sidorares/react-x11-components/pull/992
[#993]: https://github.com/sidorares/react-x11-components/pull/993
[#1013]: https://github.com/sidorares/react-x11-components/pull/1013
[#1014]: https://github.com/sidorares/react-x11-components/pull/1014
[#1015]: https://github.com/sidorares/react-x11-components/pull/1015
[#1016]: https://github.com/sidorares/react-x11-components/pull/1016
[#1017]: https://github.com/sidorares/react-x11-components/pull/1017
[#1018]: https://github.com/sidorares/react-x11-components/pull/1018
[react-x11#1006]: https://github.com/sidorares/react-x11/pull/1006
[react-x11#1010]: https://github.com/sidorares/react-x11/pull/1010
[ntk#549]: https://github.com/sidorares/ntk/pull/549
