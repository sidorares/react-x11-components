# AGENTS.md

Guidance for AI agents (and new contributors) working on
`@react-x11/components`.

## What this package is

A collection of components for
[react-x11](https://github.com/sidorares/react-x11) that do **not** belong in
the core package. Everything here is built on react-x11's public API — the
built-in host elements, or the `registerElement` seam in `react-x11/host` —
so nothing here needs a change to core to exist, and core does not grow to
carry it.

Read react-x11's own `AGENTS.md` first for how the renderer works. This file
only covers what is different about living out here.

## What belongs here, and what belongs in core

This is the governing decision for the whole repository. When a change
arrives that adds something, the first question is not "how" but "where".

**It belongs in react-x11 (core) when any one of these holds:**

- the vast majority of UI apps use it; or
- it depends on react-x11 internals — implementing it externally would mean
  exposing details that should not be public, or compromising performance; or
- it needs enough standards compliance that the behaviour is hard to agree on
  or to implement piecemeal.

**It belongs in `@react-x11/components` when all of these hold:**

- a smaller fraction of apps need it;
- it can be built on the public react-x11 API — core host elements, or the
  "register a custom element" path;
- it is big enough that core would pay for it, in install closure or in
  maintenance.

### The boundary can run _through_ a feature

The most useful worked example is 3D, because the line does not fall between
two features but inside one:

- **`<glarea>` stays in core.** It is a real child X window on a GLX visual,
  created top-down in the commit phase. That is renderer internals; there is
  no public API it could be built on.
- **The scene graph over it does not.** `<mesh>`, `<group>`, geometry and
  material nodes, a Three.js / react-three-fiber-shaped layer, `Canvas3D` —
  all of that is composition over a public element, wanted by a small
  fraction of apps, and heavy. That is this package.

Apply the same cut before assuming a whole subsystem moves or stays. Ask
which part is standing on internals and which part is standing on the
element.

### Two backends, and which side of them a component is on

core has an X11 backend and a native macOS one (`createRoot({ backend })`,
`REACT_X11_BACKEND`), and **the default assumption for anything added here is
that it runs on both** — because the things this package builds on, host
elements and the 2D context and the text engine contract, are what both
backends answer. Most of what is here needed no work at all to cross over;
what work there was is recorded where it happened, and is worth reading
before writing the next component:

- the glyph-run seams the vt terminal needs, and the degrade when an engine
  has none ("The terminal that is not somebody else's program");
- device versus logical pixels, which is the bug the second backend
  _introduced_ for every drawn element here, because 1x hid it
  ("Drawing beats composing");
- `CGContextStrokePath` being superlinear in subpath count, which is why
  `<Map>`'s `batchVertices` is a per-backend probe ("A map, and the three
  caches under it");
- frame pacing, because a Cocoa window paints at the display's rate with no
  server backpressure behind it (`docs/prd-frame-pacing.md`).

**Three components embed over XEmbed, and that part of them is X11-only
for good**: `<Terminal>`'s embedded emulators, `<MediaPlayer>`'s mpv and VLC,
and `<TrayHost>`. macOS has no cross-process window embedding — react-x11's
own `docs/macos.md` says so and names this package in as much — and neither
has Wayland. That is a wall, not a gap, so do not file it as one; the answer
where an app needs the capability on every backend is a native sibling,
which is what `backend="vt"` is for the terminal and `backend="ffmpeg"` is
for the player: a decoder pushing frames into core's `<video frames>`,
silent, drawn in the paint order (react-x11 `docs/architecture/video.md`
§8.3).

All three embedders degrade the same way there — `status: 'unavailable'` plus
`fallback` — and all three find out from the **app**, never the machine:
core's Cocoa `X` is a stub with no selection machinery and no reparent, the
same posture as the headless mock's. `<TrayHost>`'s manager asks for
`SetSelectionOwner`; `canHostXEmbed(app)` in `src/embed/` asks that and
`ReparentWindow`, and `useEmbeddedClient` answers `'unavailable'` with an
`EmbedUnsupportedError` on the first render instead of trusting
`<foreign onReady>`. That is the trap the check closes: on the Cocoa backend
`<foreign>` still calls `onReady`, with `windowId: undefined`, so the two
spawning components used to run their plans with it — `xterm -into
undefined`, `mpv --wid=undefined` — over a blank pane, with no error.
`<Terminal backend="auto">` asks before its `PATH` probe, so a Mac with
XQuartz's xterm installed lands on vt, and `<MediaPlayer backend="auto">`
the same way lands on ffmpeg without looking for an mpv it could not use. **That is the posture to copy for
anything else that reaches for raw X**: ask the connection, answer on the
first render, and mount no `<foreign>` where it has no socket to be — on
core's headless mock one throws from the commit.

The rule this leaves for a new component: **if it can only work on one
backend, its docs page says which, in the first screenful.** A reader who
finds out from a blank window has been failed by the page.

## Layout

- `src/<component>/` — **one directory per component.** Each has an
  `index.ts` (the React component, its props interface, and the
  `registerElement` call if it has one) and whatever private modules it
  needs. No component imports another component.
- **Shared modules are directories too**, with their own `index.ts` and
  subpath, and the difference from a component is that they are
  side-effect free: `src/richtext/` (the styled-text element behind
  `<Markdown>`, `<Code>` and `<TerminalOutput>` — it paints per-run
  decoration and answers
  core's four text accessors, so a document selects across it — plus the
  edit menu a read-only surface offers and the link-click hook), `src/codeblock/` (the look of a
  block of code: the palette, the runs and the chrome `<Code>` and
  `<Markdown>`'s fences share), `src/code-language/` (the tokenizer
  seam, the built-in languages, the token palettes — under `<CodeEditor>`,
  `<Code>` and `<Markdown>`'s fences alike), `src/ansi/` (a captured
  terminal session reduced to a document of styled spans: the escape-sequence
  parser, the flow reducer and the palette under `<TerminalOutput>`, with no
  React and no dependency in it) and `src/embed/` (the spawn,
  watch and hand-back lifecycle under `<Terminal>` and `<MediaPlayer>`,
  plus the `ProcessHost` seam — see "Running someone else's program"). A
  shared module never calls
  `registerElement` at module scope; `richtext` exports
  `registerRichText()` instead, and **each component that renders the
  element calls it at its own module scope**, so "a component registers
  its element in its own index.ts" keeps holding and an app that imports
  neither component registers nothing.
- `src/internal/` is the half-step **below** a shared module: code two
  components share — the height index, window, layout tick and
  scroll-reveal under `<Tree>`, `<Table>` and a long `<RichTextEditor>`,
  the typed `hx()` every composed widget writes its
  elements
  with, the change event and dismiss-on-blur subscription under
  `<Calendar>`/`<DatePicker>` and `<ColorPicker>`/`<ColorField>`, the
  signed distance field `<Map>`'s and `<Flow>`'s GL labels are drawn from
  (`sdf.ts`), and the blocks of lines `<Code>` and `<Markdown>`'s fences
  draw code in (`codelines.ts`) — that no app needs yet. Deliberately without an `index.ts`,
  so it has no subpath and no docs page; `test/docs.test.ts` and
  `scripts/check-package.ts` both key on `src/<name>/index.ts`, and that
  is the seam this uses. Giving it an `index.ts` and the full
  shared-module treatment is the promotion path.
- `src/index.ts` — the convenience barrel. Re-exports only. Never put
  anything with a side effect here.
- `dist/` — **the build output, and what ships.** `tsc` writes it, git
  ignores it, and nothing in the repo edits it by hand.
- `test/` — `node --test` files run through `tsx`, one per component plus
  the repo-wide guards (`treeshake.test.ts`, `package.test.ts`).
- `test/html/` — `<Html>`'s tests, a file a subject (`floats.test.ts`,
  `tables.test.ts`, `media.test.ts`, …) over the `harness.ts` they share.
  They were one file of eighteen thousand lines that every change appended
  to, so any two changes conflicted at its end. **A new test goes in the
  file its subject has, beside the tests it is like**, and not at the end
  of the longest one; a helper a second file comes to need moves to
  `harness.ts`.
- `test/types/` — type-level tests, compiled by `npm run typecheck`.
- `scripts/check-package.ts` — the exports-map/publishability check. `tsc`
  is the build now, but it has no opinion about the exports map, so this
  still runs.
- `examples/` — one runnable file per component. These need a display: a real
  `$DISPLAY`, or a Mac running core's native backend
  (`REACT_X11_BACKEND=cocoa`), which is the cheapest way to see whether a
  component holds up on the other one. CI does not run them.
- `docs/` — the reference, one page per component under `docs/components/`,
  plus design documents. **The only copy** — see "Documentation".
- `website/` — the Docusaurus site that renders `docs/`. Its own
  `package.json` and lockfile; nothing in it is published to npm.

Two tsconfigs, and the split matters. `tsconfig.json` typechecks
_everything_ — `src`, `test`, `examples`, `scripts` — and emits nothing;
it is what `npm run typecheck` and your editor use. `tsconfig.build.json`
extends it, narrows `include` to `src`, and is the only config that writes
files. It also sets `types: []`, so a `process` or a `Buffer` that wanders
into `src/` fails the build instead of becoming a `@types/node` dependency
a consumer has to satisfy.

`src/richtext/` is the smallest worked example of the element half of all
this — one `registerElement` call, one `Node` subclass, one props interface —
and `src/code-editor/` is the same shape at full size, registering at its own
module scope the way a component does.

### Not every component registers an element

`<CodeEditor>` does; `<Calendar>` does not. A calendar is a composition of
`<box>`, `<text>` and `<canvas>` — there is nothing for the reconciler to
learn, so `src/calendar/` has no `registerElement` call, no JSX augmentation
and **no side effect at import time at all**. `src/color-picker/` is the same
shape and the sharper example of it: a saturation/value field _looks_ like an
element that should draw itself, and it is three `<canvas>` panes and a
couple of absolutely positioned `<box>` thumbs, because ntk's gradients do
the drawing server-side and a thumb that is a node is a thumb whose drag
repaints nothing else. Both shapes belong here; the `registerElement` seam is
a tool, not an entry requirement.

### Drawing beats composing when the viewport is a transform

`src/flow/` is the third shape, and the reason it is not the second is worth
recording because the next component with a viewport will face it too.

A graph editor looks like composition: a `<box>` per node, absolutely
positioned. It cannot be. Pan and zoom are a _transform_, and this renderer's
style vocabulary has no transform — so a composed graph would have to
re-render every node through React and re-lay-out every node through yoga on
every pointer step of a pan, and zoom could not scale text at all. `<Flow>`
therefore registers one element and draws the whole graph in its `paint`,
the way `<codeeditor>` draws a whole text editor: panning is two numbers and
one node's damage rect, zoom is arithmetic, and React sees nothing until the
graph itself changes.

What that costs is the thing react-flow is best known for — the default node
type is a `paint` callback rather than a React component. `FlowPainter`
exists so that a type's drawing is written against something that also works
on the mock backend.

**And then the escape hatch, which is worth understanding before it is
copied.** A node whose body is a form cannot be a picture, so a node type may
`render` a real react-x11 tree instead. The pane cannot _contain_ it —
`Node.paint` paints a node's children before the node's own drawing, so
anything mounted inside the pane would be painted over by the graph — so
`<Flow>` renders a `<box>` around the pane and mounts the bodies as
absolutely positioned _siblings_, at rectangles the pane hands over through
`onNodeBodies`. The pane stays the only thing that knows where a node is; the
React half only places boxes.

Three consequences are load-bearing and are documented at the seam: a mounted
body re-renders as the viewport moves (the cost the drawn path exists to
avoid, paid only by the nodes that opt in), it **zooms with the pane** — the
subtree is mounted in a box carrying core's `scale` prop (react-x11 2.6,
react-x11#452), which multiplies every length under it with CSS `zoom`
semantics rather than a transform, so a body is written in graph units and
its text is shaped at the size it is drawn at, and below `zoom` 0.6 it is not
mounted at all — and its type reserves a `headerHeight` strip the body does
not cover, because a node made entirely of text fields has nothing left to
drag.

The rule to carry forward: **ask whether the feature's viewport is a
transform.** If it is, the element draws, and anything that has to be a real
widget is mounted beside it rather than inside it. If it is not — a calendar,
a date picker — compose.

**And whichever it is, know which unit you are in.** react-x11 hands a
registered element two (its `docs/scale.md`): `abs`, `contentBox()`,
`this.style`, the paint context, `paintDamage()`, a rect handed to
`invalidate` or `scrollContents` and an a11y scene rect are _device_ pixels,
while a synthetic event's `x`/`y`, every style length an app writes and so
the boxes `<Flow>` mounts bodies in are _logical_ ones. On a 1x display —
the in-process server the suite runs on, XQuartz — the two coincide, which
is how `<Flow>` compared `ev.x` with `contentBox()` and passed everything,
then hovered at half the distance, panned at half speed and framed the graph
at half size the day react-x11's native macOS backend reported a retina
panel. The pane now thinks in logical pixels and converts at the crossings —
`_pane()`, `_screenRect()`'s device-grid rounding, `_claim()`, the blit, the
grid tile and the painter — and `test/flow.test.ts` runs its gestures at
`scale: 2`. A drawn element that compares `ev.x` with `this.abs` has the
same bug. The vt terminal, `<Html>`, `<RichText>` and the chart plot had it
and convert now — the terminal reads the event back through
`ev.nativeEvent` (core's own idiom, `_devicePoint`), the other three take
logical points at their public queries (`elementAtPoint`, `hrefAtPoint`,
`hitAt`) and multiply once inside — and each has a `scale: 2` test that
failed before. The same audit found the second shape of the bug, **a
constant that never passes through a style**: the terminal's default font
size, every CSS pixel `<Html>` lays out, a `TextRun.size`, a chart's gutters
and stroke widths were all drawn as device pixels and came out half size at
2x; each now multiplies by `this.scale` where it enters. `<Formula>`'s `size`
was the same shape — pixels per em that no style ever scales — so the
mathematics came out half the size of the text beside it; the node builds
its layout at `size × scale`, and everything downstream of the layout (`abs`,
the accessors, the paint) stays device. Core's
`textIndexAt`/`textCaretRect`/`textRangeRects` seam is the deliberate
exception — it speaks device pixels, and the accessors here answer it that
way. `<CodeEditor>` is the terminal's shape again — device pixels inside,
because every measurement it makes is a layout `app.fonts` shaped at the
device font size: `_devicePoint()` on the way in, `caretRect()`,
`metrics()`, `measureText()` and `scrollBy()` divided on the way out, the
caret, gutter pad and scroll thumbs multiplied where they are drawn — and
`test/code-editor.test.ts` clicks, drags and opens the completion popup at
`scale: 2`, holding every number to `abs` and a core-shaped `<text>` ruler
rather than to another answer of the editor's, which a doubled `metrics()`
would have made pass. `<ColorPicker>`'s `fractionIn` compared a logical
event with a device `abs` until it was the last one left: it reads
`node.getClientRects()[0]` now — the same box already divided, which is the
third way through this and the one to reach for when there is a rect to ask
for at all, since it leaves the arithmetic in one unit instead of converting
into the other. `test/color-picker.test.ts` drags the area and clicks the
hue strip at `scale: 2`, which is the test the file never had.

Composing is no exemption once a component reads geometry back. The QML
family draws nothing and still carried device numbers into documents
written in logical ones: `mouse.x` (a logical event less a device `abs`),
the RowLayout read-back and the root's implicit size (a device `abs` in a
logical slot), and a `Text`'s implicit size — `app.fonts.layout` measures
at `resolvedTextStyle()`'s size, and that is the device one, because the
cascade resolves a theme's size once, at the root. The read-back fed
itself: an author `width:` is the slot it writes, so at 2x the item drew
double. Each now divides by the node's scale where it crosses. The
read-back subtracts first, since `(a - b) / s` rounds once; it and
`mouse.x` read `abs` rather than `getClientRects()`, which answers nothing
for a 0×0 box, and a 0×0 QML item still has an `x` and still hears a click
on a child that hangs outside it. `test/qml.test.ts` runs each at
`scale: 2`.

`src/internal/hx.ts` is what makes the no-JSX rule survive TypeScript.
`React.createElement`'s own overloads are `@types/react`'s and describe the
DOM, so a `<box onKeyDown>` handler gets checked against React's
`KeyboardEvent` rather than react-x11's. `hx('box', …)` looks the name up in
react-x11's element table instead, and `hx('div', …)` is an error. Reach for
it in any component that writes more than a couple of elements.

### Vendored from core

`src/calendar/dates.ts` and `src/internal/widget.ts` are copies of code that
is still in react-x11 today — the day arithmetic, `changeEvent`,
`useDismissOnWindowBlur`. They were copied rather than imported because they
are not on core's exports map, and they are pure, so the copy is cheap.
(`widget.ts` started as `src/calendar/internal.ts` and moved when
`<ColorPicker>` became its second consumer — the promotion `src/internal/`
exists for.)

**Core is expected to drop `<Calendar>` and `<DatePicker>`, so divergence here
is intended rather than drift.** This package is the owner now. Until that
lands, the two copies exist; do not try to keep them in sync.

Everything else the calendar stands on is public API: `useTheme`,
`createStyles`, `tint`, `<Icon>`, `useAnchor`/`useAnchorTracking`, the `XK_*`
keysyms, and `cssColorStraight` off `react-x11/ntk`.

**The rule when core catches up is: delete the copy, import the export.**
`tint` is the worked example. It was vendored three times over — the
calendar's copy, `src/richtext/`'s, and `src/flow/`'s — each with the same
paragraph about `cssColorStraight` not being on the exports map. It is on
`react-x11/style` now (with `readableInk` and `interpolate` beside it), so all
three are gone and every surface imports core's. `/richtext` stopped
re-exporting it at the same time: a subpath of this package forwarding a core
symbol under its own name is a claim of ownership that is no longer true.

### Affordance glyphs come from core's set; nouns do not

Core ships a **system icon set** — twelve affordance glyphs (the four
chevrons, `check`, `dash`, `dot`, `close`, `plus`, `moreVertical`, `eye`,
`eyeOff`) drawn over `<canvas mono>` and reached through `<Icon name size
color />`. Anything in this package that means _something about the control_
takes its mark from there rather than drawing its own, so a `<Calendar>` a
user opened from a core `<Select>` agrees with it without being told to. The
month nav is the worked example: two `<Icon name="chevronLeft|chevronRight">`
where there used to be a local `<canvas>`.

The line core draws is affordances, not nouns, and it holds here too:
`DatePicker`'s wall-calendar glyph stays a local `<canvas>` because a
calendar page is a noun, and the set will never have one. A component that
wants a noun draws it, or the app brings an icon library.

Two things every call site has to know, because neither is inherited:
**colour and size do not cascade** — an icon inside a row painted in
`theme.hoverText` is handed that colour by name — and **`:hover` marks the
ancestor chain rather than the children**, so a glyph that has to follow a
hover follows it through React state. Both are the current model in core
rather than a settled verdict; if a real cascade lands, the explicit
arguments become defaults rather than mistakes. Three of react-x11's declarations are
narrower than its runtime, and each is worked around locally with a comment
saying so — `theme` on any node (not just `<window>`), `'@supports
transparency'` as a style block, and `cssColorStraight` not being in
`ntk.d.ts`'s named list. None of them is patched globally: a package should
not quietly change what type-checks in an app that merely installs it.

## Tree-shaking is a constraint, not a nice-to-have

An app that uses one component and a bundler must pay for one component.
That is a promise the package makes, so it is enforced by
`test/treeshake.test.ts` rather than left to good intentions.

What that means in practice:

1. **`"sideEffects": false` stays true.** Every module must be safe to drop
   when nothing imports its exports.
2. **A component registers its element in its own `index.ts`, at module
   scope.** That is the one side effect the design relies on, and it is fine
   precisely because it lives in the module a bundler keeps only when the
   component is used. Hoisting a registration into `src/index.ts` is the
   single edit that would drag every component into every bundle.
3. **Every component gets its own subpath export.** `check-package.ts`
   fails the build if a `src/<name>/index.ts` has no `./<name>` entry — the
   no-bundler and the deep-import cases both need it.
4. **No component imports another component.** Shared code goes in a shared
   module that both import; a lateral import makes two components one unit.
5. **No side effects at import time anywhere else.** No eager theme install,
   no feature probe, no registry warm-up.

The first tree-shaking test is the one that actually catches regressions:
importing the barrel for _no_ exports must bundle to nothing.

`treeshake.test.ts` bundles `dist/`, not `src/`, because `dist/` is what an
app installs and a compiler is perfectly capable of emitting something that
does not shake — a downlevelled class, a `namespace`, an `enum`. `pretest`
builds, so the artifact under test is never stale.

## react-x11 is a peer dependency, and it has to be

`react-x11` and `react` are `peerDependencies`, never regular ones. This is
not style. `registerElement` mutates module-level state inside react-x11 —
the registry `Map` that `createInstance` consults, and the `DRAWN_KINDS` set
that `paintOrder()` filters on. Two copies of react-x11 in one app means the
registration lands in one copy and the render happens in the other, so the
component's first render throws `unknown element type <chartplot>` and
suggests `registerElement()` — which is exactly what this package did, into
the other copy. The tell is that the error lists none of this package's
elements as registered. (Checked on 2.9.1 and 2.11.0, with a second core
nested under this package.)

### Current status: core is released, and the git pin is gone

react-x11 is published on npm, and it carries every subpath this package
imports — `react-x11` itself plus `/host`, `/node`, `/style`, `/keysyms`,
`/ntk`, `/yoga`, `/jsx-runtime`, and `/test` and `/debug` from the suite.
Both specs are ordinary registry ranges:

- `peerDependencies.react-x11` is `^2.56.1` — what a consumer must supply.
- `devDependencies.react-x11` is `^2.56.1` — what the suite runs against.

Keep them the same range. They are one decision written twice, and a
devDependency that drifts above the peer range means the suite passes
against a core that consumers are not required to have. The drift is one
command away: `npm install -D react-x11@latest` moves the devDependency and
leaves the peer where it was, which is the shape the 2.3.0 bump (PR #53) had
before it was redone as 2.3.1. `scripts/check-package.ts` fails CI on any
difference, and on `react-x11` or `react` in `dependencies` or
`optionalDependencies`.

Needing something core landed after the current floor is a normal release
wait, not a pin bump: it ships in the next core release and both ranges pick
it up. **The floor is a running one and moves often** — every move since
`^2.0.0`, both specs together each time:

- `^2.3.1` — the `Node.scale` declaration `<Flow>` had been reading through
  a cast (react-x11#430).
- `^2.5.0` — the Cocoa glyph-run seams (2.4.0, react-x11#432) and the
  offscreen `Surface` through `react-x11/ntk` (2.5.0, react-x11#433), the two
  things the vt terminal was feature-detecting and degrading on.
- `^2.6.0` — no seam adopted: the floor moved with `<Tabs>`'s overflow menu,
  the first thing here to place a `<popup>` from a node that moves under it.
- `^2.6.1` — the chunked Cocoa stroke `<Map>`'s profiling asked for
  (react-x11#456/#457).
- `^2.8.3` — `<ReorderList>` on core's drag and drop: the Cocoa backend in
  2.7.0, then 2.8.0–2.8.3 for the Cocoa drag faults its branch filed
  (react-x11#484, #488, #494).
- `^2.9.1` — the desktop calendar's move into core (react-x11#508). It also
  carried 2.9.0, the release the vt terminal's flood profiling asked for —
  `opaqueRect()`, the `copy` composite and the window's `frameRate`
  (react-x11#497/#501, `docs/prd-frame-pacing.md`).
- `^2.11.0` — the eyedropper's macOS rung, `NSColorSampler`
  (react-x11#517/#520 — before it, `useEyedropper().supported` was true on
  the Cocoa backend and the first press threw).
- `^2.13.0` — the pointer over a `<glarea>` delivered to the owning window
  (react-x11#545) and a `<glarea>`'s children drawn above its surface
  (#546), which retired `<Map>`'s listeners on the surface's child window
  and the `children` gate that kept an `'auto'` map off GL.
- `^2.15.0` — the three things the vt terminal's grid draws through, none
  of which the Wayland backend had: `fillRects` taking the flat rectangle
  list the other two accept (react-x11#564), `createSolidPicture` so
  `drawGlyphs` can be spelled the documented way (#565), and an offscreen
  `Surface`'s context being holdable rather than usable only inside
  `render()` (#566, which also retired putting the window's GL state back
  by hand). Each failed by drawing nothing rather than by throwing, so the
  terminal came up empty under `REACT_X11_BACKEND=wayland` while the rest
  of the UI was fine (#17).
- `^2.18.4` — `useSupports('glOverlay')`, false from the first render on
  XQuartz, where the macOS window server composites every GL surface above
  the window's X content (react-x11#653, fixed by #654): `<Flow>` draws a
  graph whose node types mount bodies with the 2D renderer there, rather
  than mounting bodies nobody can see.
- `^2.18.6` — `<Flow>`'s Windows round. The layers a `<glarea>`'s children
  are drawn on (2.18.5, react-x11#656, over windowkit/win32#2) need the
  bridge that has them, and core's range reaches `@windowkit/win32` 0.0.2
  only from 2.18.6 (#660 — a caret on 0.0.x is exact). The same two releases
  hold pointer motion for the next frame (#657), claim a move inside a
  surface on its panes alone (#659), and give the Windows and macOS context
  the `lineDashOffset` an animated edge marches with (#664).
- `^2.19.0` — `scalesText` on the context (react-x11#666), which
  `<Flow>`'s 2D zoom asks before drawing labels from the sizes it has; the
  content floors measured inside the card that changed (#668), half of a
  frame that ticks forty widget bodies; and the paint cache drawing through
  the translation an overlay pane paints with (#667), without which every
  card over a GL surface was painted live on Windows.
- `^2.20.0` — `scrollContents`'s riders (react-x11#671): the box `<Flow>`
  lays node bodies out in moves with a 2D pan, and now rides its blit
  instead of declining it. The same release claims a moved subtree once,
  clipped to what clips it, and moves the nodes Yoga did not lay out again
  instead of reading them back (#670) — a pan over bodies stopped
  repainting the whole window.
- `^2.21.1` — a text layout's own coverage, `layout.coverage({ pad })`
  (react-x11#673, #674, in 2.21.0): the GL label atlases of `<Flow>` and
  `<Map>` set a string's distance field from it rather than drawing the
  string onto a staging surface and reading it back. ntk's layouts answer
  it (8.11.0, X11, Wayland and the mock), CoreText's through
  `@windowkit/appkit` 0.13 and DirectWrite's through `@windowkit/win32`
  0.0.4 — which core's range reaches only from 2.21.1 (#676; a caret on
  0.0.x is exact, the `^2.18.6` story again), so 2.21.0 still answered
  null on Windows. The atlases still feature-detect it and keep the
  readback, for an engine that answers null.
- `^2.22.0` — `scrollContents`'s `pinned` rects (react-x11#682): `<Flow>`'s
  2D pan copies the whole pane and has core repaint the minimap and the
  controls in place, where it had to carve a band the pane's full width
  out of the copy. A scroll that reveals `<CodeEditor>`'s caret a line or a
  character away is a blit of the view the same way, with the rows that
  changed pinned and repainted where they land (#137); before it, a claim
  inside the blitted region refused the blit, and the scroll repainted the
  editor whole. The same release copies an opaque subtree that only
  moved rather than repainting it (#681) and stops a rounded box masking
  every fill inside it to round its corners (#685). Neither needed a
  change here; the stress example's widgets are what they were measured
  on.
- `^2.22.8` — a Cocoa text layout's runs hang off the spans they came
  from, as ntk's do (react-x11#710), so `<Html>`, `<Markdown>` and
  `<RichText>` draw their link underlines, code chips, highlights and
  strikethrough on macOS, where they drew none. The same release stops
  `<text>` shifting a line's leading a second time (#709) and takes
  @windowkit/appkit 0.15.0, which sets a line's glyphs where ntk does and
  leaves the white space a line ends on out of its width (windowkit/appkit#80,
  #81). All of it was found running the CSS 2.1 test suite through `<Html>`
  on both backends (`docs/html-conformance.md`).
- `^2.23.0` — `cursorAt` (react-x11#757): an element that draws what is
  inside it names the cursor for the point under the pointer, and `<Html>`
  answers it — a link's `pointer`, text's I-beam — where core set one cursor
  a node and a document is one node. The same release keeps a `<Frame>`
  pane's wheel to its notch (#755) and stops a press scrolling a document
  to its top, which turned every selection in a scrolled page into one from
  its start (#756); with 2.22.13's `<Frame>` pane that stays on its main
  thread on macOS (#747), all four were found in the browser example.
- `^2.25.0` — `viewportFixedRects()` (react-x11#795): an element says what
  it draws fixed to its scroll pane's viewport, and the pane's scroll blit
  repaints it rather than copying it with the content. `<Html>` places a
  `position: fixed` box and a fixed background against the pane that
  scrolls it and answers with them; without the hook a small scroll's blit
  smeared a fixed header up the pane. Found by the Zen Garden bench (041,
  051, 069, 090, 095). The same release draws shadows from tiles
  (react-x11#794, over ntk 8.16.1's `ntk/shadow-tiles`, sidorares/ntk#471):
  the 2d context draws the blurred shadow of a `rect`, a `roundRect` or a
  `rect` less one filled `evenodd` from a tile made once for its corners
  and blur, where CoreGraphics blurred it on every fill and Direct2D drew
  none. `<Html>` draws its box shadows that way and keeps no bake of its
  own, which it had keyed on the part a paint reached — so each strip a
  scroll exposed across one baked it again, and Zen Garden's header
  scrolled at 14 frames a second at 2x. It also has hover follow content
  that scrolls under a still pointer (#793), and `roundRect` take
  elliptical `{ x, y }` radii.
- `^2.26.0` — `<Select>`'s `labelStyle` and `chevronStyle` (react-x11#796),
  style slots over its caption and its chevron in the shape `<Slider>`'s
  took. A `<select>` the page gave a border, a background or
  `appearance: none` is mounted bare in its content box, as a text field
  is, its caption in the element's colour and font and its arrow in that
  colour, or left out at `appearance: none`. The caption had named the
  palette's `text` itself, so nothing reached it, and melbcss.com's select
  was the palette's white framed dropdown inside the page's padding. Either
  slot also makes it the drawn trigger, where a native popup bezel would
  draw AppKit's frame over the page's box.
- `^2.26.3` — an empty paragraph is one line on Cocoa (react-x11#798, in
  2.26.1), so the caret of an empty field is as tall as the text it will
  hold: CoreText set no line for no text, and an empty `<textinput>`'s
  caret was six device pixels on macOS — github.com's login field, which
  `<Html>` focuses on load, among them. The same three releases keep hover
  to the active window on macOS (#800) and make `-apple-system` and
  `BlinkMacSystemFont` the system font (#803), which head GitHub's font
  stack and had fallen to Helvetica.
- `^2.27.0` — `fadesSurfacesCheaply` (react-x11#812) over @windowkit/appkit
  0.18.0's `ctxDrawSurfaceFaded` (windowkit/appkit#94, react-x11#814):
  CoreGraphics draws an image under an alpha below 1 at some fifteen times
  its cost at 1, so on macOS a group faded on a surface cost more than
  fading each thing in it, and `<Html>` faded each thing — a card's
  background through its text (react-x11#810). The macOS context draws a
  surface's pixels scaled by the alpha now and says so, and `<Html>` hands
  it a faded element's group and keeps a fade's: a repaint of 24 faded
  cards went from 3.7–5.5 ms to 2.4–4.4 on macOS, a frame of a fade from
  0.65–1.2 to 0.39–0.73. Read at run time, so an older core still paints,
  a thing at a time. The lockfile held ntk at 8.17.8, the least 2.27.0
  takes, until 8.21.0: see "the in-process server is not pixman" under
  Gotchas for the `<Flow>` test that held it there.
- `^2.29.0` — the sprite seam (react-x11#821, over #819): an element hands
  the macOS surface presenter parts of its drawing, each lifted onto a
  layer of its own and run there by the render server, and `<Html>` offers
  each element whose CSS animation a layer can carry (`src/html/sprites.ts`)
  — a page with a fade and a turn on it went from 113 frames painted in two
  seconds to none. A lift needs @windowkit/appkit 0.19.0's matrices and its
  delays in the past (windowkit/appkit#97, react-x11#823), and the same
  bridge colour-manages the window on a wide-gamut display (#820). 2.28.0
  under it runs an opacity in the render server on a promoted box that
  fades as one group (#818), which a lift's own checks stand on, and stops
  a focus moving inside a scroll pane repainting the pane's whole viewport
  (#815): every Tab through an `<Html>` in its pane did (react-x11#813),
  and `test/html/focus.test.ts` holds one to the rows of its two links.
- `^2.30.0` — a sprite cut to a clip (react-x11#828, over #827): core puts
  a part's layer in a box that masks to the part's `clip` and to the clip
  of every ancestor with square corners, where an ancestor that did not
  hold everywhere the part could be refused it. `<Html>` hands over the
  clips of the boxes around an element (`clipFor`), so a carousel's slide,
  a marquee and a shimmer under `overflow: hidden` go on layers, and so
  does a fade scrolled half out of its pane, which went from 117 frames in
  two seconds to none on a real Mac. A core that takes no `clip` would show
  the layer uncut, so the floor moves with the feature rather than after
  it.
- `^2.32.0` — `decodeImageBytes` on `react-x11/ntk` (react-x11#834), the
  decoder ladder `<image>` reads bytes with since 2.31.0 (#832): WebP
  everywhere, and under Bun every format `Bun.Image` reads, off the
  JavaScript thread. 2.31.0 alone changed nothing here, because `<Html>`
  draws its own images and decoded them with ntk's `decodeImage`, PNG and
  JPEG, and the ladder was off core's exports map. `<Html>` decodes
  through it now, so an image shows in a document exactly where it would
  show in an `<image>`, and the browser example asks for WebP and passes
  it on.
- `^2.33.0` — a sprite's clip with round corners (react-x11#838): core
  rounds the box a part's layer is cut in by `clipRadius`, where a clip was
  a rectangle and a rounded clipping box had to keep clear of everywhere
  the part could be. `<Html>` hands over the corners of a rounded box an
  element reaches, where they are one circle's and no other clip cuts it
  again (`clipFor`), so a shimmer sliding through a card with a radius
  went from 117 frames in two seconds to none on a real Mac. A core that
  reads no `clipRadius` would cut the layer square and show the corners the
  document cuts away, so the floor moves with the feature. The same
  release sets text on a Retina display at its point size (#840), which
  needed no change here, and adds `<video>` (#836, #837): frames an
  application decodes into a `VideoFrames` sink on every backend, and a
  `src` AVFoundation plays on macOS. `<Html>` mounts one over each
  `<video>` it can, playing what the host answers `kind: 'video'` with
  (`src/html/media.ts`), where a video had been its poster. A sprite
  part's `paint` is optional from this release, since a part may show a
  source instead.
- `^2.34.0` — a sprite inside another (react-x11#842): a part names the
  one it is inside as its `parent`, its layer goes in that one's, and the
  presenter paints the parent's raster without it, handing the parent's
  `paint` the keys it lifted inside it. `<Html>` offers an element
  animating inside a lifted one so, where it had to keep it on the
  document's clock: a spinner turning in a card that pulses painted the
  card's layer again at every frame of the spinner's, 117 window frames
  and 117 uploads in two seconds on a real Mac, and none with both lifted.
  A core that reads no `parent` would lift the spinner on a layer of its
  own over the card's raster, which still holds it, unfaded with the
  card, so the floor moves with the feature.
- `^2.35.0` — `@windowkit/appkit` ^0.22.0 (react-x11#845), where core's
  range admitted 0.19 alone: a `<video src>` is played by AVFoundation,
  so `useSupports('mediaPlayback')` is true on a Mac and a `<video>` in
  a document plays the source its host answers with a `src`, where every
  one showed its poster. The player had been written as
  windowkit/appkit#104, merged into its parent's branch after the parent
  merged, and reached a release only as #107 in 0.22.0. The same range
  lifts a `VideoFrames` sink onto a layer, sets text on a Retina display
  at its point size and drops AppKit's own menu for a select; and the
  same release keeps a sprite none of which shows on its layer (#844),
  which `<Html>`'s parts needed no change for.
- `^2.36.0` — a part listed before another that the presenter turns down,
  and that the other overlaps, is turned down with it in that frame
  (react-x11#852): `<Html>` offers the parts a later part of its own
  covers, listed in the order it paints them, where it kept every one of
  them but the last on the document's clock — the rows of a list that
  slide in one into the next. A core without it would leave an earlier
  part's layer over a later part the document draws, so the floor moves
  with the feature. The same release declares `DesktopSettings.animations`
  (#851), and `<Flow>` reads it without a cast; it pauses a loop nothing
  of it can be seen from and runs an indeterminate `ProgressBar` and a
  scrolled list's loop in the render server (#847, #848, #849), which no
  component here needed a change for.
- `^2.38.0` — a `<Frame>` pane's `<video src>` played by its host
  (react-x11#856). The browser example runs each page in a pane, and on
  macOS a pane runs no AppKit, so a player it made never heard from
  AVFoundation: every video in a page sat on its poster and a press did
  nothing, samplelib.com's among them. The host makes the player now and
  copies its frames down through shared IOSurfaces, so `<Html>`'s videos
  play in a pane as they do in a window. The same release keeps a node
  inside a pane that is scrolling off promotion layers (#857): since #848
  a row's hover fade went on a layer, and a wheel over `<Table>` cost 29%
  more of a frame on macOS, found by round 45 of the perf sweep
  (`docs/perf-sweep-2026-09.md`). Neither needed a change here.
- `^2.39.0` — a sprite turned out of the plane (react-x11#859): a part's
  transform at rest and in its keyframes may be a `matrix3d()`, its corners
  asked about where the perspective shows them, and Core Animation draws
  the layer through it on the GPU. `<Html>` puts a box out of the plane on
  a layer, still or moving, where it drew it a tile at a time at every
  paint (`stillLiftOf`, `solidFrames`); Zen Garden 219 went from 25 frames
  a second to 54 at rest on macOS. A core without it has no
  `SpriteMatrix3D` to type one with, and turns down such a part as no
  sprite at all, warning, so the floor moves with the feature.
- `^2.40.0` — `filter` on the native context (react-x11#866): canvas's own
  property, the colour functions of a CSS filter list applied to everything
  drawn after it. `<Html>` hands a filtered element's group to it and draws
  it through, in the paint that draws the element (`through`), where on
  macOS it read the group back and drew it from the read a round trip late,
  and painted it a second time to read it at every frame a box moved. Read
  at run time, so an older core, and X11 and Wayland, which run no colour
  matrix, still draw it from a read. The same release carries
  `imageSmoothingQuality` on the native context over @windowkit/appkit
  0.24.0 (#861, #865): the smoothing `<Html>` asks a perspective's tiles to
  be drawn with had reached no Mac, since core's range admitted no bridge
  with the verb, and now does.
- `^2.42.0` — a sprite that is shadows alone (react-x11#883): CSS's outer
  box-shadows, which the render server draws and blurs on the GPU from a
  caster in a box masked to all but the part's rect, their blur, colour and
  offset animated there. `<Html>` offers the shadows of a box whose
  `box-shadow` is in transition as one (`shadowPartOf`), and leaves them
  out of its paint and of the box's damage while they are lifted: a frame
  of a Zen Garden card's hover went from 22 ms to 12 on macOS, and to 4
  while its glow is on the layer. A core without it turns such a part down
  as no sprite at all, warning, so the floor moves with the feature.
- `^2.43.0` — a surface on Wayland drawn as it was when it is destroyed
  straight after (react-x11#887): the draw was still in the window's batch
  when its texture went, and sampled nothing, so a surface `<Html>` drew
  and let go in one paint came out an opaque black box — Zen Garden 219's
  header was one. That is why the floor moves. The same release has
  `drawImageProjected` on the Wayland context (#888), an image drawn
  through a 3×3 projection as one quad, and `drawProjected` hands a box in
  perspective to it where it was a few hundred clipped tiles, each a GL
  batch: 219's sidebar went from 12 frames a second to 25 there. It is
  read at run time, so a context without it still tiles. The lockfile
  holds ntk at 8.23.2 with it: an image read through a transform keeps the
  picture state it was read with (sidorares/ntk#534), which halved the
  requests a surface drawn a tile at a time costs, and a path clip's
  coverage is rasterized in the process and its mask kept across restores
  (#536), where glamor read back a pixmap for every clip's traps — the
  rounded rows of 219's marquees cost Xwayland 53 ms a frame and cost 1.2.
- `^2.44.1` — a `<Frame>` pane's last frame shown at its size while the
  frame of a new size is on its way, on a Mac. Core's range had admitted
  only @windowkit/appkit 0.25.0 since 2.42.0, a bridge that does not read
  the `contentsRect` and `contentsCenter` the anchoring is set with, so a
  page in the browser example was stretched at every step of a drag
  (react-x11#897, over windowkit/appkit#117). That is why the floor moves.
  The same release stretches a pane that fell behind across only and
  never down (#898), since a height moves nothing a page lays out, and
  makes a pane's buffers as frames take them, one a size, where a drag
  made and cleared three at every step (#899): with #714 here, a frame of
  Zen Garden 101's drag in the browser example went from 16 ms to 9.
- `^2.45.0` — a scroll pane's offsets follow content an element moved
  under its viewport, in the same layout pass (`anchorScrollBy`,
  react-x11#900). `<Html>` keeps the block at the top of what a pane shows
  where it is on screen when a layout at another width moves it, and keeps
  what ended above it as it was while the width is dragged, so a drag half
  way down Wikipedia's article on the X Window System lays out what can be
  seen and not the article above it. A `<Frame>`'s pane hears that the
  window it is in is being resized live (#901), and the whole layout a drag
  owes waits for the drag to end. Both are read at run time, so an older
  core lays out as before. The same release has the content floors leave a
  document in a scroller unshaped where nothing reads its width (#902): a
  page in the browser example's pane was set a word to a line at every
  breakpoint a drag crossed, 220 ms of a frame.

- `^2.46.0` — `<Frame execArgv env>` (react-x11#923): the browser example
  starts each tab's page process with a heap bound of its own,
  `--max-old-space-size`, so a page whose script allocates without end —
  which no `node:vm` context bounds — ends its own tab rather than taking
  the machine's memory, where a pane could only inherit the browser's
  flags. Node enforces it and Bun 1.4 does not. The same range carries
  Tab through a `<Frame>` pane (2.45.3, react-x11#920): into the page at
  its first stop and out past its last, where the host cycled its own focus
  as well and on X11 Tab never left the pane, so the browser's Tab goes
  toolbar, page, strip.
- `^2.47.1` — `filter: blur()` on the native context (react-x11#926, in
  2.47.0), which `<Html>` draws a `backdrop-filter`'s surface through
  (`makeBackdrop`): reactmelbourne.com's sticky nav, `blur(10px)` over a
  tint, drew the heading scrolled under it sharp on macOS. The same release
  draws `createRadialGradient` through @windowkit/appkit's
  `ctxFillRadialGradient`, where every radial gradient a page drew on macOS
  came out flat; its range, `^0.27.0`, admitted no bridge with the verb, and
  2.47.1 widens it to `^0.28.0` (react-x11#928), which is why the floor is
  the patch. Both are read at run time, so an older core draws the backdrop
  sharp and the gradient flat. 2.47.0 also ends a `<Frame>` pane that stops
  answering for 15 seconds (#924), which reaches the browser example's
  `fallback` as any failure of its page's process does: the tab says its
  page stopped and offers Reload.
- `^2.48.0` — a drag on a Mac (react-x11#959). An app runs on a worker
  there by default, and core handed AppKit a `provide` callback on every
  drag, which @windowkit/appkit refuses off the main thread: a press
  dragged past the threshold threw from `beginDrag`, so `<ReorderList>`,
  `<RichTextEditor>` and every other drag source here crashed the app on
  macOS. On a worker every `dragData` thunk now resolves as the drag
  begins, which is why `<RichTextEditor>`'s slice payload reads the copy
  modifier at the drop rather than when its thunk runs.
- `^2.51.0` — full screen on a Mac (react-x11#978, over windowkit/appkit#124).
  `useWindowState().fullscreen` never moved on the Cocoa backend and
  `<window fullscreen>` did nothing, since the bridge had no window-state
  verbs or events; it follows the green button now, from the transition's
  begin, before the animation, and the zoom and the Dock come back as
  `maximized` and `minimized`. The browser example hides its strip and
  toolbar in full screen and brings them back at the top edge. The same
  range makes `background` a style shorthand, which `<flowgraph>`'s grid
  prop of that name now declares in `semanticNames` — undeclared, every
  `<Flow>` threw on mount in development — and widens `lineHeight`'s type to
  the strings a style takes, so `<RichText>` narrows it before its layout as
  core does. It also carries react-x11#969, from 2.50.0: an absolute box its
  content sizes, hung from a row, holds a change inside it in for the content
  floors. `<Table>`'s fast-scroll pill is one, so a new count in it lays out
  the pill alone, where it measured the whole table — 0.6 ms of a frame on a
  Mac at a million rows, where it was 8. `test/table.test.ts` counts the
  passes.
- `^2.54.0` — `decodeImageBytes(bytes, { offThread: true })`
  (react-x11#1004): under Node, a PNG, a JPEG or a WebP of 8 KB or more
  decodes on a worker thread for a caller that waits for a promise anyway,
  and `<Html>`'s images ask for it (`resources.ts`). Image decoding held the
  JavaScript thread for half of the Guardian's load and react.dev's; a
  load settles a quarter to a half sooner on such pages, for some 6% more
  processor time across the process, since each worker warms the decoders
  on its own. 2.53.0 under it converts a `<video frames>` frame on the GPU
  on Linux (#1003).
- `^2.55.0` — a field's selection set and read from outside
  (react-x11#1006): `selectionStart`, `selectionEnd`, `selectionDirection`,
  `setSelectionRange()` and `select()` on `<textinput>` and `<textarea>`,
  in the DOM's UTF-16 offsets. `<Html>` had asked for them at run time
  since #972 (`selectingField`), and on a core without them a page's
  `select()` set what a script read back while the widget showed none of
  it: Backspace after it took one letter, which is WPT's
  `user-select-none-on-input`, and Interop's webcompat area went from 77.7%
  to 88.8% with the move. The same release tells whether a `<Select>`'s
  menu is down through `onOpenChange` and lets an owner hold it through
  `open` (#1010), which a `<select>`'s picker drops through (#983), so
  `showPicker()` drops it and `:open` matches. Both are read at run time,
  so an older core still mounts the fields. `withFieldSelection` in
  `test/html/harness.ts`, which stood in for #1006, went with the move.
- `^2.55.2` — a variable face's font at its axis values made once and kept
  per handle on a Mac (react-x11#1015). `<Html>` hands every run in a
  variable web font the point on its axes (`layout/axes.ts`), and the Cocoa
  backend made a new CTFont for each span of each layout, which CoreText
  shapes with none of its caches warm: bun.com's blog, in Archivo and
  Martian Mono, held its page process for seconds after its first paint
  setting text, and is scrollable as it paints now. What the fonts
  themselves cost the page process — a WOFF2 rebuilt, opened and
  registered — is some 20 ms of the load. 2.55.1 under it gives each child
  of a `<glarea>` a pane of its own on Cocoa (react-x11#1011), which took
  `<Flow>`'s GL minimap from a quarter of a core to none.
- `^2.56.0` — `<audio src>`, the platform's player without a picture
  (react-x11#1019): AVFoundation on macOS and a `<Frame>` pane's host for a
  pane, with `<video src>`'s props, events and ref, taking no room and
  drawing nothing. `<Html>` mounts one for each `<audio>` a page's script
  plays (`sounds.ts`), and the page's clock follows what its player says:
  an OpenAI article's "Listen" button, a plain `<audio>` fed one MP3 after
  another, was silent in the example browser. The same release adds
  `fakeMediaPlayers(app)` to `react-x11/test`, a player that plays nothing
  for an app that has none, which `test/html/audio.test.ts` drives in place
  of AVFoundation. A core without `<audio>` throws on the element, so the
  floor moves with the feature. It also carries `<textinput mask>`
  (react-x11#1017), a bullet drawn for each character, which `<Html>`
  mounts a password field with: its widget was `sensitive`, which keeps
  the text off the clipboard, and drew what was typed as typed.
- `^2.56.1` — a `<textarea>`'s lines spaced by its `lineHeight`, as a
  `<text>`'s are (react-x11#1020). `<Html>` hands a text area the page
  draws the multiple its `line-height` comes to (`BareField.lineHeight`):
  a code editor lays its field over the `<pre>` it highlights, and on
  joshwcomeau.com's playgrounds the field's caret and selection fell
  behind the text a line by the twenty-fifth. A core before it reads no
  `lineHeight` on a field and sets it at its font's own, so the floor
  moves with the fix.

Do not reach back for a `github:` spec to get at unreleased core — cut a core
release instead.

**A component's docs page should not restate the floor.** Say what that
change needed and why — "the Cocoa glyph-run seams landed in 2.4.0 and 2.5.0"
stays true forever — but leave "the floor is `^x.y.z`" to `package.json`,
which is the only copy that moves when the floor does. This section and
`package.json` are the two places the current number belongs.

<details>
<summary>Why the git pin named a full sha (history, for when this recurs)</summary>

Before 2.0.0 the devDependency was `github:sidorares/react-x11#<full sha>`,
never `#master`. A branch spec plus a locked commit reads like it pins, and
does on npm 10 — but npm 11 (Node 24) re-resolves the branch and installs
whatever master is now, so `npm ci` gave the CI matrix two different cores
and only the Node 24 leg failed. The lockfile alone does not hold a floating
ref; naming the sha is what made every `npm ci` install the same thing.

That made using a new core feature two edits, not one — use it, and move the
pin — and skipping the second was the failure that looks like nothing: a
working tree with the newer core already installed passed everything
locally, and every CI job failed on an import that was not there yet.

If this package ever has to track an unreleased core again, that is the
shape to return to.

</details>

**Palette tokens still need a grep, not a `tsc` run.** The 2.0.0 theme break
(react-x11#290, `feat(theme)!`) renamed `dim`/`dimActive` to
`textMuted`/`textMutedActive`, and both the `theme.dim` reads and the
`'$dim'` style tokens here moved with it. The `'$dim'` half is the one to
remember for the next such rename: string tokens type-check against any
palette and fail only at mount, in DEV, as an unknown-token throw — so a
palette migration is a repo-wide grep for the token, `examples/` and `test/`
included. The same change also grew base-class selection members
(`selectAll(): this` et al., react-x11#294's declarations), which a
registered element here must `override` with matching return types or stop
being structurally a `DrawnNode`.

## Talking to the desktop, and optional dependencies

`src/desktop-calendar/` used to live here: the user's real calendars — Google,
Microsoft, CalDAV, local — over D-Bus through Evolution Data Server, and the
reason `<Calendar dayContent>` exists at all. **It moved to react-x11 in
2.9.1** (sidorares/react-x11#508, over #504), and the move is the most
instructive worked example in this file of the question at the top of it,
because the code did not change — where it could be built did.

Three things decided it, and the next feature that talks to the system should
be held against them before a line is written:

- **A calendar is one of the things an app does _outside_ its own windows**,
  which is a family core had already claimed one member at a time —
  notifications, permissions, the tray, the file dialog, the Dock, deep
  links. Every one of them is a ladder in core with a freedesktop rung and a
  macOS one, and a seventh built out here would have been the odd one.
- **The macOS rung cannot be built from this side.** EventKit is reachable
  only through `@windowkit/appkit`, which react-x11 holds through
  `CocoaApp._native`, and core's cocoa modules are deliberately off its
  exports map. The only ways out were exporting the raw bridge or exporting
  a typed `app.calendars` — and the second _is_ the feature, so the design
  would have been split with the policy in the wrong package. **When the
  second clause of the inclusion rule (does it stand on public API) fails on
  one backend only, the whole feature belongs upstream**, not the failing
  half.
- **The grid stayed.** `<Calendar>`, `<DatePicker>` and `dayContent` are
  composition over public host elements that a small fraction of apps want:
  every clause points here. The boundary ran through the feature, exactly as
  it does for 3D — and the seam it left is a **string format**, not a
  function. `byDay`'s keys are the `'YYYY-MM-DD'` days `dayContent` is
  handed, which is why one half could move without the other noticing.

`docs/prd-desktop-calendar.md` is the survey and the record.

Two rules it established while it was here still hold, and both now have
their worked example elsewhere in this package:

- **Never open your own bus.** `useSessionBus()` (or `sessionBus()` off the
  render path) hands over react-x11's shared connection. A second one makes
  the app two names on the bus — the tray under one, the exported service
  under another — and leaks a connection per mount. The EDS client took its
  bus as a constructor argument for exactly this reason, which is also what
  let a fake one drive it in a test; anything here that reaches the bus
  should be shaped the same way.
- **A heavy dependency is loaded lazily and its types are ours.** A module
  that most apps will not touch is reached through a dynamic `import()` that
  is allowed to fail, and its types are written out structurally rather than
  imported, because `import type … from '<optional package>'` puts it in the
  type graph and an app that did not install it can no longer type-check
  against this package. `src/terminal/vt/xterm.ts` and `vt/pty.ts` are the
  live examples; `src/embed/host.ts` does it to node's own modules for a
  different reason (`types: []`). react-x11 does the same with `dbus-native`
  and `@windowkit/appkit` — but note that it made `ical.js` a **regular**
  dependency when it took the calendar, because at 268 KB with no
  dependencies and no native code it did not earn a missing-module state.
  Optionality is a judgement about weight and reach, not a reflex.

"No bus", "no EDS", "no notification daemon" are all ordinary states of a
perfectly healthy machine. None of them is an error to report — the feature
degrades, and the calendar still renders without its dots.

`src/code-editor/lezer.ts` follows the same dynamic-import rule with one
deliberate difference: `@lezer/highlight` is an **optional peer** rather
than an optional dependency. An optionalDependency installs by default,
which is the right trade for `@xterm/headless` (nothing else would bring
it) and the wrong one here — every `@lezer/<lang>` grammar package the app installs
already depends on `@lezer/highlight`, so listing it as optionalDeps would
install ~100 KB for apps that never touch the adapter, and the apps that do
touch it have it anyway. `peerDependenciesMeta.optional` also keeps the
bare `import('@lezer/highlight')` resolvable under pnpm's strict layout,
where a genuinely undeclared package would not be. The TextMate adapter
(`textmate.ts`) needs no dependency at all: the app hands it an initialized
grammar object, typed structurally.

`src/html/quico.ts` is the third shape of it: `quico`, the QUIC, HTTP/3 and
WebTransport stack a page's `WebTransport` sessions are opened over, is an
**optional peer** as `node-pty` is — never installed for anyone, since
three megabytes of a network stack is what an app that shows no
WebTransport page should never pay — and a devDependency, as `ondine` is,
for the loopback test. It is pure JavaScript on `node:dgram` and
`node:crypto`, which is why it was chosen over a native addon (it runs on
Bun as it does on Node, and needs no build) and over `node:quic` (in no
release build of Node 24); `docs/prd-html-scripts.md` has the comparison.
Absent, a session fails as one with no network does, and nothing throws at
import. **`quico.ts` uses quico's public API alone, and that is a rule.**
It had reached in once and mapped two of quico's behaviours, and filed
each upstream: colocohen/quico#8 (no way to put the page's `Origin` and
headers on the CONNECT, so it wrapped `_sendConnect`), #9 (only a 200
established a session, which left WPT's four "status code 204" subtests)
and #10 (a CONNECT stream ended with no capsule settled nothing, and a lost
connection resolved `closed` with code 0, both read off quico's insides
here). quico 0.8.0 fixed all three, and the adapter passes `origin` and
`headers` and reads `closed` as it settles, with the peer range starting
at 0.8. **Where quico next differs from a browser, file it, map it in
`quico.ts` with the issue named beside the mapping, and delete the mapping
and move the peer range when a release fixes it**, as "Vendored from core"
has it for a copy.

`src/html/werift.ts` is the same shape for a page's peer connections:
`werift`, ICE, DTLS, SCTP and SRTP in TypeScript, is an **optional peer**
and a devDependency, as quico is — some 29 megabytes installed — loaded
the first time a page makes a connection, its types written out. It runs
on Node 22 and later and on Bun, so `webrtc-werift.test.ts` skips on Node
20, and `webrtc-peer.test.ts` holds the page's API over a fake stack
(`test/fake-webrtc.ts`) on every runtime. What a connection offers is
`src/html/rtc-codecs.ts`, which `getCapabilities` answers from before
werift is loaded. Where werift differs from a browser the adapter
corrects what it can, and docs/prd-webrtc.md lists the rest as issues to
file upstream. **The adapter reaches into werift three times**, each for what
werift has no public way to do, and a werift without the field goes on as
before. An empty message, which werift sends as nothing, is put on its
`RTCSctpTransport`'s own send queue as RFC 8831's one byte under payload
protocol 56 or 57 (`WeriftChannel._sendEmpty`). A close waits for what it sent
to be acknowledged (`WeriftChannel.close`, reading `sentQueue`): a reset
overtakes a retransmission, and werift's far side drops what arrives after
one. And a connection whose page names no STUN server asks none
(`_gatherFromNamed`, clearing each transport's `stunServer`): werift falls back
to Google's whatever `iceServers` says, which is a request nobody asked for and
five seconds of `setLocalDescription` on a network that does not answer. Ask
werift for each of these before reaching in anywhere else.

`publicSuffixList()` in `src/html/cookies.ts` is the fourth: `tldts`, the
Public Suffix List with its private domains, is an **optional peer** and a
devDependency, loaded the first time a host asks for the list and handed
to a `CookieJar` as `publicSuffix`. Absent, a jar takes the last label of
a host for its suffix, which refuses `Domain=com` and not `Domain=co.uk`.

## Running someone else's program

`src/embed/`, `src/terminal/` and `src/media-player/` are the first things
here that spawn a process and host another X client. They establish four
rules, and each one exists because getting it wrong fails somewhere else.
(`src/tray-host/` is the third XEmbed consumer and shares none of this:
nothing is spawned, so there is no `ProcessHost` and no backend probe — see
"Hosting a client nobody spawned" below.)

**`<foreign>` owns the protocol; this package owns the argv.** The reparent,
the save set, `_XEMBED_INFO`, the synthetic ICCCM ConfigureNotify, layout,
focus forwarding and handing the client back **without destroying it** on
unmount are all core's (react-x11 `src/foreignnodes.js`, ntk's
`XEmbedSocket`). What is left is: take the container id from `onReady`, build
a command line, spawn it, watch it, kill it. That is the whole of
`src/embed/client.ts`, and it is why a third wrapper around some other
`-into WID` program should be a `backends.ts` and nothing else.

**Node's API is an interface, not an import.** `tsconfig.build.json` sets
`types: []`, so `src/` cannot name `child_process`, `net`, `fs` or `process`.
`src/embed/host.ts` writes out the slice it uses structurally and reaches the
modules through a dynamic `import()` whose specifier is built at run time —
the same shape `vt/xterm.ts` uses for an optional dependency, for a
different reason. `globalThis` is how `process.env` and the timers are
reached (`src/embed/timers.ts`, and `code-language/timers.ts` before it).

**`ProcessHost` is public because it is a feature, not a test double.** It
happens to be what `test/fake-host.ts` drives — which is the only way CI,
with no xterm and no mpv, can assert what _would_ have been spawned — but the
reason it is exported is that "run the terminal in a container / over ssh /
under a sandbox" is a real thing to want and should not need a fork.

**A missing backend is not an error.** No emulator installed, no player
installed: both are ordinary states of a healthy machine, so `backend`
defaults to `'auto'`, detection is a `PATH` probe, and the result is
`status: 'unavailable'` plus a `fallback` — never a throw and never a
dependency on a binary. Same call react-x11's `useDesktopCalendarEvents`
makes about a desktop with no calendar service. A react-x11 backend with no
XEmbed is the same kind of news and gets the same status, but it is a fact
about the app rather than the machine, so it is asked first
(`canHostXEmbed`) and nothing on `PATH` can overrule it — see "Two backends"
above.

Three things about these components that are decisions rather than gaps, so
they are not re-litigated:

- **The launch key is a string, and it is the restart signal.** An external
  emulator cannot be handed a new command, so changing `command` respawns —
  but `command={['bash']}` is a new array on every paint, and an effect keyed
  on identity would respawn per frame. Both components serialize the
  launch-relevant props into one string and memoize the plan factory on it.
  `<MediaPlayer>` deliberately leaves `src`, `volume`, `muted` and `paused`
  _out_ of that key: those go over the control channel to the running player.
- **`write()` is per backend, and that is the API rather than a gap.** Over an
  external emulator there is no honest implementation — the pty belongs to
  xterm, and synthetic X key events are refused by xterm (`allowSendEvents`,
  off by default and not ours to change in a user's terminal) and dropped by
  alacritty — so it returns `false` there and works on `backend="vt"`, whose
  pty is ours. `false` rather than a throw is what lets an app feature-test
  with the call itself.
- **VLC's control channel is write-only.** Its rc replies carry no request id,
  so a reply cannot be matched to its question except by counting, and one
  dropped line desynchronises that permanently. `reportsProgress: false` says
  so in the type rather than shipping a parser that lies to a progress bar.

`<MediaPlayer backend="ffmpeg">` (`src/media-player/ffmpeg.ts`,
`frames.ts`) runs its program through the same `ProcessHost` and is the one
caller that reads a child's output: `SpawnOptions.output` pipes stdout and
stderr to `onStdout`/`onStderr`, which are optional on the interface so a
host written before them still type-checks. Its transport is signals and
restarts — SIGSTOP/SIGCONT for pause, a respawn with `-ss` for a seek — which
is why `kill()` asks whether the child has exited rather than reading node's
`killed`: that flag goes true after the first signal of any kind, and the
SIGCONT after a SIGSTOP was silently dropped. The route between it and the
embedders is `useRoute` in `index.ts`: `'auto'` on an app that can embed asks
`PATH` for mpv and VLC first, and nowhere else asks at all.

## The terminal that is not somebody else's program

`src/terminal/vt/` is the other half of `<Terminal>`: a pty, `@xterm/headless`
as the escape-sequence state machine, and `<vtterm>` — a registered element
that draws the cell grid itself. It shares `TerminalProps` with the XEmbed
path deliberately, so "use ours instead" is one prop.

The rules it adds, each of which exists because getting it wrong fails
somewhere else:

- **The side effect lives behind a dynamic `import()`.** `src/terminal/index.ts`
  still has none at import time; `vt/index.ts` is the module that calls
  `registerElement('vtterm')`, and it is loaded only when the backend is
  actually selected. That is what keeps `@xterm/headless` (2 MB) and the
  renderer out of an app that embeds a real xterm — asserted by the
  "vt backend is a lazy chunk" case in `test/treeshake.test.ts`, which bundles
  **with code splitting**, because that is what a bundler does with a dynamic
  import and an unsplit build inlines everything by design.
- **Two optional dependencies, two different postures.** `@xterm/headless` is
  an `optionalDependency` (installs by default — nothing else would bring it,
  and the terminal is a flagship); the pty is an optional _peer_, `node-pty`
  or `@lydell/node-pty`, probed in that order and never installed for anyone.
  node-pty alone unpacks to 64 MB with a native build, which is more than
  react-x11's entire closure. **Under Bun neither is probed**: `defaultPtyHost()`
  prefers `bunPtyHost()` (Bun 1.4's `Bun.spawn({ terminal })`, feature-detected
  on `Bun.Terminal`) over both, because a runtime that ships the capability
  should not make an app install a binary for it. Both absences are `status: 'unavailable'` plus
  `fallback`, never a throw — the same call core's calendar makes about a
  desktop with no calendar service.
- **Their types are ours.** `vt/xterm.ts` and `vt/pty.ts` write out the slice
  each package exposes structurally, for the reason "Talking to the desktop"
  gives: `import type … from '@xterm/headless'` would make an app that skipped
  optional dependencies fail to type-check against this package.
  `@xterm/headless` 6.0 also gates `buffer`, `parser` and `modes` behind
  `allowProposedApi: true` — `term.buffer` _throws_ without it — so the
  component sets the flag and the version is pinned.
- **Damage is a diff, not a story about escape sequences.** The renderer keeps
  a mirror of the signatures of what the surface currently shows and repaints
  the cells whose signature changed. Selection, cursor position and blink
  phase are inputs to that signature, so there is exactly one damage path for
  every cause. Two consequences worth not undoing: a skipped frame repairs
  itself on the next diff (eventual correctness is structural), and **nothing
  invisible may enter a row's hash** — a frame counter or a palette generation
  would make every row differ every frame and silently kill the scroll
  detector, which reads those same row signatures to find the band a scroll
  moved.
- **The renderer is two implementations of one interface**, and the fallback
  is not decoration: `RetainedRenderer` owns an ntk `Surface` and scrolls it
  with `Surface.copyWithin`, `DirectRenderer` draws into the paint context and
  refuses `copyRows`. The mock backend's context has no pixel API at all, so
  `createRenderer` answers `null` there and paint is a no-op — the repo
  convention that keeps components testable headlessly.
- **No escape hatches.** The design started on four (a raw `X.CopyArea` on a
  pixmap, a private `Render.FillRectangles`, an undocumented glyph-run shape,
  `altKey` off `nativeEvent.buttons`); all four were promoted upstream —
  ntk#252/#253/#254 and react-x11#284 — and the lockfile was bumped in the
  same change, per "react-x11 is a peer dependency". Do not reintroduce one:
  the two things still missing (mouse _encoding_ and underline colour, both in
  `@xterm/headless`) are worked around through its public parser instead, and
  filed.
- **A foreign text engine degrades; it does not throw.** `FontSet`
  feature-detects the glyph-run seams (`hasGlyphRuns`: `glyphIdFor` and
  `advanceOf` on a face) and reads line height under either engine's name
  (`lineGap`, or CoreText's `leading`). A face with `metrics` and `hasGlyph`
  and nothing else — react-x11's Cocoa backend up to 2.3.x, the default on a
  Mac — makes `_fontSet()` answer null, cached per font key, with a one-time
  development warning; the node then paints its background and nothing else,
  the same posture as the mock backend's missing pixel API. The seams were
  filed as sidorares/react-x11#432 (the face and ctx) and #433 (an offscreen
  `Surface`), over windowkit/appkit#1 (the CoreText natives), and landed in
  react-x11 2.4.0 and 2.5.0; adopting them was the floor bump to `^2.5.0`
  and nothing in `renderer.ts` or `fonts.ts`, because both already spoke the
  documented contract. The degrade path stays, for the mock backend and for
  the next engine. The streaming profile of 2026-09-07 asked for two more
  seams and got them in react-x11 2.9.0 — `Node.opaqueRect()`, which the
  node answers with its grid and claims a rect inside of, and a `copy`
  composite the Cocoa backend sends as a memcpy — plus `frameRate`, which is
  the window's policy and not the terminal's (`docs/prd-frame-pacing.md`,
  and the terminal page's "A flood of output").
- **`PtyHost` is public because it is a feature**, exactly as `ProcessHost` is:
  "run the shell in a container / over ssh / in a sandbox" is a real thing to
  want. `test/fake-pty.ts` drives it, which is how CI tests a terminal with no
  native module anywhere, and `examples/terminal-ssh.tsx` is the real thing —
  an ssh2 adapter, no pty on this machine at all. Two rules the seam carries
  for those hosts: **`onData` may hand over bytes** (`Uint8Array` straight to
  the emulator, because a `.toString()` per network chunk halves a multi-byte
  character and no care downstream repairs it), and **empty argv means "the
  default shell over there"** — substituting this machine's `$SHELL` would be
  wrong for every host that is not this machine.
- **A test that renders `<Terminal>` must pin `pty`.** Since `'auto'` falls
  through to vt, a `<Terminal>` with no emulator installed and no `pty` prop
  opens a _real login shell_ — which then keeps node's event loop alive, so
  the suite does not fail, it **hangs**. `'auto'` also goes straight to vt
  on any app that cannot host XEmbed, and the mock backend is one: there a
  `<Terminal>` opens a pty whatever `processes` says is installed. Every
  test here passes a `FakePtyHost`; the one that drives a real pty is
  opt-in behind `REACT_X11_COMPONENTS_REAL_PTY=1` for the same reason.

## Hosting a client nobody spawned

`src/tray-host/` is the same protocol as the two above pointed the other way:
the windows arrive because applications ask, so there is no argv, no backend
table and no `ProcessHost`. What replaces them is the freedesktop
[system tray spec][tray-spec], and the split inside the directory is the rule
worth keeping:

- **`protocol.ts` is the spec as data and pure functions** — atoms, opcodes,
  the balloon reassembler, the UTF-8 decode, and `argbVisualOf`. None of it
  needs a display, so all of it is asserted without one.
- **`manager.ts` is the only thing that talks to the server.** Selection
  ownership, the `MANAGER` broadcast, the two advertised properties, opcode
  routing, `SelectionClear`.
- **`index.ts` holds the icon list as React state** and renders one
  `<foreign>` per icon. That is the whole component.

[tray-spec]: http://specifications.freedesktop.org/systemtray/latest/

Four decisions in it that are load-bearing:

- **The selection is held on a window this creates with `X.CreateWindow`, not
  on a node.** A selection owned by something that can unmount is a tray that
  silently stops being the tray.
- **The ICCCM 2.1 timestamp comes from core.** `serverTime(app)` is a fresh
  server timestamp for an operation no user action caused, which is exactly
  what taking a manager selection at startup is; `lastInputTime(app)` is the
  other half, for something the user did. Never substitute `0` for either —
  that is `CurrentTime`, which ICCCM forbids and which leaves two clients
  racing for one selection unable to be ordered. **This needed a core bump
  when it landed**, back when core was a git spec; `serverTime` is in 2.0.0
  now, so it is just there. See "react-x11 is a peer dependency".
- **`X.on('event')` here is deliberate, not a gap.** Core has an
  element-scoped ClientMessage seam, and an application should use it — but
  `onClientMessage` is a **`<window>`** prop, and the tray's manager window is
  not an element. It cannot be: the selection has to be held on something that
  outlives the render. That is the case core's own `src/clientmessage.js`
  carves out in as many words — filtering `X.on('event')` "is the right shape
  _there_, because a settings daemon's window is nobody's element". Do not
  "fix" this by moving the selection onto the host `<window>`.
- **Advertising a capability the window does not have is worse than
  advertising none.** `_NET_SYSTEM_TRAY_VISUAL` is written only when the
  top-level window genuinely carries a 32-bit TrueColor visual, because an
  icon that believes it and draws an alpha channel into a 24-bit parent comes
  out as a black box.
- **Icon nodes are keyed on the window id and their `windowId` never
  changes**, so reordering is a move. Handing a client between two `<foreign>`
  nodes parks it at the root long enough for a window manager to frame it, and
  the second node then reports `onClientGone` for a live window
  (react-x11 `docs/embedding.md`).

`onIcons`-shaped mutation is the one bug to watch for here: the component
holds the icon list as state, so every change has to be a **new array**. A
splice removes the icon from the list and leaves it on screen.

## Replacing a core widget rather than moving it

`src/tree/` is the first component here that **supersedes a core widget that
is being retired**. react-x11's `src/components/Tree.js` is going away;
nothing in this package imports it, and the two share no code. That is a
different relationship from `<Calendar>` (moved, still exported by core for
now) and from `<Markdown>` (replaced an _ntk_ widget), so the rule it
establishes is worth stating: **a successor keeps the behaviour and drops the
implementation.** The keyboard map, type-ahead, and the twisty being its own
hit target are the same, because they are what a user has already learnt; the
rendering is new, because that is what needed to change.

What it had to grow to be worth replacing, and what each one costs:

- **The data is the app's.** `getId` / `getLabel` / `getText` /
  `getChildren` / `isBranch` / `isDisabled` — defaulting to
  `{ id, label, children }`, so a tree of that shape configures nothing.
  `getText` looks redundant next to `getLabel` and is not: a label rendered
  as an icon beside a `<text>` is a React element, `String()` of it is
  `[object Object]`, and type-ahead would silently stop matching.
- **It virtualizes rows it does not have to assume the height of.** A slice
  plus two spacer boxes, like `Table` — but `Table` may divide by a row height
  and this may not, because a tree row wraps, carries two lines, or is
  whatever `renderContent` returned. `src/tree/heights.ts` measures what each
  drawn row became and indexes it; `rowHeight` is a floor and
  `estimatedRowHeight` is what an unseen row is guessed at. `virtual` is
  `'auto'`, past 200 visible rows. The threshold survives because
  virtualization still costs one thing — only the built rows are in the
  accessibility tree — and a tree that is merely long should not pay it.
- **The focus is on the tree, not the row.** Core's focused each row node.
  A virtualized row unmounts the moment it scrolls out and the focus would go
  with it, so the container is the single tab stop and the selection is the
  cursor — `Table`'s model, and the reason `<Tree>` could not simply keep
  core's.
- **Every visible part is a seam**: `renderToggle`, `renderGuide`,
  `renderLabel`, `renderContent`, `renderSubtree`, plus a `styles` bag.

Five decisions in it that are decisions rather than gaps:

- **Layout runs after React's effects, so a row cannot be measured in one.**
  react-x11 lays out on a frame flush, not in the commit: `useLayoutEffect`
  and `useEffect` both read the _previous_ pass, and on the render that
  created a row `node.abs.height` is still 0. `src/tree/timers.ts` schedules
  the measurement a macrotask later, which is the first moment the geometry is
  real. Anything else in this package that needs to read back what layout
  decided has the same problem and the same answer.
- **The measure/render loop terminates because measuring is idempotent.**
  `RowHeights.measure` reports whether it changed anything, and only a change
  bumps the counter the component re-renders on. A second pass over the same
  rows finds nothing and stops. Break that — re-render unconditionally after
  measuring — and the tree spins at the frame rate, quietly, on a machine
  fast enough not to look broken.
- **`src/tree/rows.ts` is pure, and the flattening is iterative.** Which rows
  are visible, at what depth, which is the last of its siblings — all of it is
  answerable with no display, and it is where every subtle tree bug lives.
  The explicit stack is not fastidiousness: a generated tree (a dependency
  graph, a filesystem walked to the bottom) reaches depths that a call per
  level does not survive, and `test/tree.test.ts` flattens ten thousand.
- **`layout="nested"` is a regrouping of the flat rows, never a second
  traversal.** `groupRows` rebuilds the nesting from the flat array, so the
  two layouts cannot disagree about depth, order, or which row is last. It is
  also the layout that cannot virtualize — a slice of a list is a list, a
  slice of a tree is not — and the layout wins over `virtual` rather than the
  other way round.
- **The branch edge is computed per rendered row, not stored.** `branchEdges`
  is asked for the handful of rows on screen while a row may be one of a
  hundred thousand. The rule it encodes is the one an implementation gets
  backwards: column `k` carries the line joining the _children_ of the
  ancestor at depth `k`, so a row deep inside the **last** child of a branch
  has a blank column above it even when that branch's parent has siblings
  left. There is a test per case; get it wrong and the tree still draws,
  just wrongly.
- **A seam's return is keyed by the component.** `renderLabel` and
  `renderSubtree` land in arrays beside the guides, the twisty, and the row
  they hang off. "Remember to put a key on the box you return" is not
  something a render prop should have to know, and the obvious guess — key it
  on the row's id — collides with the row itself. Both are wrapped in a
  `Fragment` carrying the key.

The one thing it deliberately does **not** have is multiple selection.
Nobody agrees on the policy (does Shift extend from the anchor or the cursor?
does Ctrl+click on a branch take its children?), and every such policy is
expressible on what is here: hold the set yourself, pass `selected` for the
cursor, paint the rest from `styles.row`.

`examples/tree.tsx` is the seams used in anger — a real file explorer over
the real filesystem, lazily listed, with lucide-shaped folder glyphs and a
dotted branch edge. Its glyphs are **drawn in the example**, which is the same
line core's icon set draws: affordances are core's (the twisty's chevron is
`<Icon>`), nouns are the app's.

## A sortable layer over core's drag and drop

`src/reorder/` is the first component here built on **core's drag and
drop** — the `draggable`/`dragData`/`dropAccept` props, the in-app
transport, `<popup dragPreview>` — rather than on pointer events of its
own, and it establishes the rule for the next one: **a drag library out
here is a layer, never an engine.** Core already has the threshold, click
suppression, `:dragging`/`:drag-over`, edge auto-scroll, the payload by
reference on `e.items`, the preview window and the promotion of a drag to
XDND; a second sensor stack in the process would lose the last of those and
duplicate the rest. `docs/prd-reorder.md` is the survey (dnd-kit,
hello-pangea, pragmatic-drag-and-drop, React Aria, Framer) and the record.

Four decisions in it that are decisions rather than gaps:

- **The list is the only drop target.** One `dropAccept` on the root, one
  `onDragOver` that reads every item's `abs` (device pixels, divided by the
  node's `scale` once) and finds the closest edge; the item at that edge is
  told to draw the indicator through a per-item setter, so a pointer motion
  re-renders two items and never the list. `src/reorder/model.ts` is the
  arithmetic, pure and asserted on no display, and written to be promoted
  to `src/internal/` when `<Table>` grows a reorder rung.
- **Membership is in the payload's type name.** A list accepts
  `application/x-react-x11-reorder;scope=group:<g>` (or `list:<uid>`),
  which keeps "who takes this drop" a declarative fact core answers from
  `dropAccept` data. It has to be: `e.accept()` in `onDragOver` can only
  override a node whose `dropAccept` already matched — the engine keeps the
  accepting _node_, not the answer — so an `onDragOver` cannot conjure a
  target. And `onDragOver` reaches every node on the path whether or not it
  matched, so the list re-asks the accept question before it marks a slot.
- **A move between lists is two local handlers**, `onInsert` on the target
  and `onRemove` on the source (React Aria's model), in the order core
  already fires `onDrop` then `onDragEnd`. The target writes where the item
  landed onto the live payload object — a thunk in `dragData` resolves to
  it at the drop — which is how the source's `onDragEnd`, which carries no
  destination, can report `to`.
- **The indicator, not the slide.** No transform in this renderer means a
  displaced neighbour is a layout pass; a line at the closest edge answers
  the same question for a rectangle per item. Recorded as a rung if wanted.

Four more, from the round that closed the gaps a survey of
react-beautiful-dnd's storybook found (`docs/prd-reorder.md`, "The second
round"), and each is a rule for the next component that drives core's drag
and drop:

- **`onDragOver` cannot reach the payload.** Only `DropEvent` carries
  `items`, so a target has no way to write on the dragged object while the
  pointer is merely over it. A layer that needs a hover channel — "which
  list is under the pointer, at what index" — needs one module-scope object
  per gesture, written by the target and read by the source in its own
  `onDrag` (core dispatches to the target first, by documented order).
- **A `<popup>` outlives the gesture as a window.** Animating the ghost home
  after the drop leaves an override-redirect window over the list for the
  animation's length, and the next press lands on it — a double-click's
  second press hits a ghost. Anything that outlasts a drag should be a box
  with `pointerEvents: 'none'`, in the list's own coordinates.
- **A drag owns the thread on cocoa, and that is core's to solve.** Nothing
  an application renders during a drag reached the screen there before
  react-x11 2.8.0: AppKit's tracking loop holds the thread from the threshold
  to the release, so no timer, frame tick or microtask of ours runs.
  `<ReorderList>` shipped a layer workaround for it — draw the ghost
  in-window rather than in a `<popup dragPreview>` — and **the workaround
  could not have worked**, because an in-window box needs a frame just as
  much as a popup does. The reasoning was sound from what was visible here;
  the missing step was running it on the backend in question, which this
  machine cannot do without synthetic input. Filing what was actually
  observed (react-x11#482) is what got it fixed properly in core 2.8.0
  (#484), where a drag's frames are painted from the callback that reports
  them. **Treat a fix for a platform you cannot run as a hypothesis, and say
  so where it ships.** What survived on merit is `preview: 'inline'`, for a
  list that would rather not open a window per drag, and `transparent` on the
  preview popup — without it a rounded card shows the window's own ground in
  the corners its radius gives up.
- **Drive the transport when you cannot drive the backend.** The follow-up
  bug — a `<popup dragPreview>` registering as a _dragging destination_ on
  cocoa and swallowing the drop meant for the window under it
  (react-x11#488, fixed in 2.8.1) — was found in seconds by rendering
  `<ReorderList>` into a real `CocoaApp` over the recording fake bridge
  core's own `test/cocoa-dnd.test.js` uses, and driving
  `drag-enter`/`drag-over`/`drag-perform` by hand. Trying to drive a real
  cocoa session with synthetic CGEvents took an afternoon and never
  separated the product's behaviour from the rig's. The same rig then
  validated the upstream fix — `registerDropTypes` called for the list's
  window alone, where the release before called it for the ghost's too. That
  reading was **not enough**: it is a fact about react-x11's bookkeeping, and
  the drop still failed on a real machine, because the window server finds
  the window under the pointer whether or not it has a destination. The fix
  that worked was `ignoresMouseEvents` on the preview (2.8.2), and the rig
  earns its keep by showing the option reaching `createWindow2` — the
  mechanism itself rather than a proxy for it. **Check the thing that makes
  the behaviour, not the thing that correlates with it**, and remember that
  neither is proof of what the OS does with it. Core's cocoa modules are not on its exports map, so a scratch
  script reaches them by file URL: fine for investigation, not for a
  committed test, and keep the script outside the repository.
- **A drag's events bubble.** `DragStart`/`onDrag`/`onDragEnd` dispatch
  capture → target → bubble like every other event, so a draggable node that
  _contains_ the dragged one sees all of them — and `useDragSource` inside it
  will happily set a position and render a second preview. Nested lists (a
  board: a card, in a column's list, in a column, in the board) are where
  this bites, and the symptom is not only a stray ghost: the outer item's
  handlers claim the gesture. Check `ev.target` against the node the drag
  props were spread on before doing anything in a source callback.
  `preventDefault()` is not the tool — on this event it cancels the drag.
- **Core arms a drag from the nearest draggable ancestor**, so a press on a
  control inside a draggable drags the ancestor. The layer's answer is to
  remember the press target (`onMouseDownCapture`) and cancel at the
  threshold with `onDragStart`'s `preventDefault()`, which core defines as
  "the gesture continues as ordinary mouse events".
- **A keyboard step over a _set_ is not `from + 1`.** That index is inside
  the run being moved, so the run lands where it already was and the
  selection appears frozen. A step moves the run past its next non-member.

One more, learned the expensive way here: **a scratch file written into
`test/` or `examples/` is swept up by `git add -A`**, and `test/*.test.ts` is
a glob — a bisect file left behind runs in the suite and fails
`format:check` in CI long after the question it answered was settled. Delete
it in the same command that stops needing it.

Two traps found writing its tests: a `<popup dragPreview>` that re-renders
the item's children re-renders a `<ReorderHandle>` inside them, which must
find an _inert_ item context rather than throw or register itself; and an
assertion that hands a `DrawnNode` to `assert.strictEqual(node, null)`
dies with `RangeError: Invalid string length` formatting the cyclic node —
compare with `===` and pass a message. Two more from the second round: a
harness helper that seeds `useState(items)` silently ignores later prop
changes (the mid-drag test that looked like a product bug), and a press
injected during a live drag never reaches a widget, because the drag owns
the pointer — drive that state from outside the gesture. And one from CI:
the drop flight runs on the wall clock, so a test that looks at it holds
the clock (`holdClock(t, flightClock)`, `test/held-clock.ts`) — a runner
slow enough to spend the whole flight inside `release()` found it already
landed, and a check that there is _no_ flight passes that way whether one
flew or not.

## An HTML renderer that draws

`src/html/` is the largest thing here and the one that breaks the most house
rules, so each break is recorded with its reason.

**It draws a document instead of composing one, and the rule is new.**
"Drawing beats composing when the viewport is a transform" was `<Flow>`'s
rule. This adds a second: **ask whether the feature brings its own layout
model.** react-x11 lays out with yoga, which is flexbox; CSS block flow with
margin collapsing, an inline formatting context, floats and table column
sizing are not flexbox and cannot be expressed in it. Composing onto `<box>`
would mean _approximating the layout model_, which is exactly what makes
ntk's `HtmlView` untrustworthy — the markup is standard, the rendering is
not, and nothing tells an author which is which. Cost matters too (a document
is thousands of elements), but the model is the load-bearing reason.

**It is the first thing here with regular `dependencies`**, and that is a
fact rather than a preference. ntk already depends on `htmlparser2`,
`domhandler`, `domutils` and `css-select` for its own deprecated `HtmlView`,
and on `bidi-js` for its text layout, and ntk is react-x11's dependency — so
every app that can use this package has all five installed already.
Declaring them adds no packages to an install; it makes the resolution
correct under pnpm's strict layout instead of relying on npm hoisting.
**Check that this is still true before adding another.** If ntk drops the
first four when the document widgets go, the closure argument goes with
them and they become this package's to justify alone. `bidi-js` is the
UAX #9 ntk's own layout resolves with, which is why it is the one `<Html>`
resolves a paragraph's levels with where a line is laid out a piece at a
time: the two have to agree about every letter the engine orders.
`image-in-browser` is on the same footing as the five: a dependency of
react-x11's, which decodes a still WebP with it, declared here because
`webp.ts` decodes an animated one's frames with it, and loaded by a dynamic
`import()` the first time one arrives, since evaluating it takes some
140 ms. `linebreak` is the sixth, on the same footing: ntk breaks every line with
it, and react-x11 depends on it directly to find a CoreText paragraph's
least width. `text-wrap: pretty` reads the places a line may break from it
(`layout/pretty.ts`), which is the engines' opinion and no third one. It
decodes its tables as it is imported, which no bundler can drop, so only
`<Html>`'s layout imports it, and this package's `sideEffects: false` drops
it with that layout from an app that renders no `<Html>`.

What is still written out, and why the line falls there: the **CSS parser**
(postcss is a tooling parser — positions, comments and raws, none of which
survives into a render, and the cascade wants rules pre-split with
specificity already computed) and the **rule index** (bucketing rules by
their rightmost simple selector is the difference between a 3 ms and a 300 ms
first paint on a document with a framework stylesheet). Flexbox is **Yoga's**,
reached through `react-x11/ntk` so there is one instance in the process. The
line is not "is there a library" but **"would a bug be visible"**: flexbox is
long, subtle and silently wrong when wrong; block flow and floats are none of
those.

**The index answers most rules without the matcher, and only ever says
no.** A rule that is nothing but the class or the id it is filed under —
`.p-4`, `#nav`, a utility framework's every rule — is the element's
whenever its bucket is asked (`keyOnly`). A rule that names an ancestor
(`.dark .card`, `#nav a`) is not the element's where no ancestor has the
name, which the cascade knows without css-select's climb to the root: it
keeps, for each element of a build, the names above it that some rule
asks of an ancestor (`_namesAbove`), one set shared by every element under
it that adds none, and outside a build works them out once for each
element matched. A rule whose names are all there still goes to the
matcher. Two things are load-bearing. **Only the names some rule asks are
kept** (`_needsOf` notes each, and drops what was kept when a rule asks a
new one), so a page of Tailwind utilities keeps `.dark` and `.group`
rather than every class of every ancestor. And **the path that keeps
nothing was measured on the deepest document there was**: the first cut
kept every name and, outside a build, worked them out again for each rule,
so the build it was written for got faster and a hover over a Tailwind
page 24 elements deep got 180 times slower. `test/html-selector-filter.test.ts`
holds both paths to css-select, over generated documents and selectors
and over a name first asked after the names above an element were worked
out. **A bucket is anything every element a rule matches has**
(`compoundKey`): the subject's id, a class, its type, else the first
attribute it tests (lower-cased, and never one in a namespace or any) or
`:root`, and the subject of an `:is()` or a `:where()` of one complex
selector; never anything inside `:not()`. Anything new that reads the
buckets reads `byAttr` and `rootRules` too — `names`, `_matchInto`,
`_shareable` — or a rule filed there is never asked.

**A rule says where it was written, and the parser is what keeps that
true.** `StyleRule.at` is the offset of its selector in the text the sheet
was parsed from, comments and all, for a developer's tools
(`MatchedRule.source`, `HtmlHandle.styleSheets`). Comments are cut before the
walk (`withoutComments`, whose `cuts` are what `asWritten` puts back), and a
block is walked as a string of its own, so **anything new that walks a slice
of a sheet carries where the slice starts** (`origin`, `bodyAt`), or a rule
in it points somewhere near the top of its sheet with nothing failing. That
number is all a page with no tools pays: a line and a column are worked out
as they are asked for (`ruleSource`), and a declaration's place by the tools
when one is clicked. And `Stylesheet.source` is set as the document places a
sheet, never as it is parsed: a parse is kept by its text, so two elements
that read alike can take one in turn (`_parseSheet`), and a cascade kept
across a new element has the element put right where it is kept.

**A registered custom property is the root's from the start.** What an
`@property` rule registers (CSS Properties and Values 1) is kept by the
cascade (`_registered`), and its initial values are a set of custom
properties the root inherits (`_registeredBase`), so a `var()` finds one
wherever nothing set it. One that does not inherit is set back to its
initial value under any set that holds it at another
(`_resetsUnder`, in `_customFor`). **Anything new that makes an element's
custom properties goes through `_customFor`**, or a property that does not
inherit leaks from the parent, and one that inherits loses its initial
value at the root. A page drew a gradient's stops from `--blob-core`,
registered at `0%` and set on few elements, and the rest drew none.

**What an `attr()` reads never reaches a URL** (CSS Values 5, 8.7.2). The
value an `attr()` substitutes is tainted, and so is the whole of anything
a substitution made with one: a custom property (`CustomProps.taint`), a
`var()`, its fallback, an `if()` whose condition read one. Nothing is
passed down for it: `vars.ts` counts every tainted value read (`taints`),
and a substitution compares the count before and after. A property that
is no custom property's goes through `substituteIn`, which makes the
declaration invalid where a tainted range is or is in a `url()`, a
`src()`, or a string an `image()` or an `image-set()` takes as one
(`taintsUrl`). Three things are load-bearing. **A substitution reads a
custom property with `read`, never `get`**, which counts it; a `get`
leaves what it read untainted. **Anything new that takes a string as a
URL joins `URL_STRINGS`**, and a string alone is no image
(`backgroundImageOf`): read leniently as one, `background-image:
attr(data-token)` would have asked for the attribute's value. And
**anything new that substitutes a value for a property goes through
`substituteIn`**, not `substitute`, whose result is not checked.

**And one step of it is written out, because Yoga's is silently wrong.**
Yoga 3.2.1 shares a line out in two passes where CSS Flexbox 9.7 goes round
until no limit stops an item, divides by a running sum (react/yoga#2006),
and weighs, floors and starts items as 9.7 does not. So the one line of a
box that does not wrap is shared out here (`resolveLine` in
`layout/flex.ts`) wherever an item has a minimum or a maximum, or the
factors come to less than 1, and Yoga is handed every item frozen at its
size; it still breaks lines, places items and aligns them. The rule that
keeps it cheap: **compare before asking.** A line's flex base sizes are
nearly always known here — a length, or the content's size the measure
function found — so 9.7 is sums of numbers, and Yoga is asked again only
where its answer differs. A page of Tailwind rows, most of them
`min-w-0`, makes the same calls into Yoga as before.

**Along such a line of a row, what Yoga is asked before the line settles
is its widths** (`Laid.sizing`): the measure answers a height from what
the item has rather than laying it out (`sizingHeight`), and once
`resolveLine` and `autoMinimums` are done, one pass with each item frozen
at the width it came to lays each out there, alone. Laid out at each width
Yoga tried — its flex basis, the row's whole width for an item `width:
100%`, then Yoga's answer, then the line's — a webmail page's three rows
one inside another laid its message list out some fifty times a layout.
That stands on **a single-line row's widths being no function of its
items' heights**: anything new that makes one so — a ratio handed to Yoga,
a basis read from a height the measure found — turns sizing off for its
row, or the widths come out of heights nobody measured.

**Three phases, three invalidation reasons, and the split is the component.**
Boxes depend on the DOM and the stylesheets; layout depends on the width;
paint depends on neither. So a resize skips the cascade and an expose skips
layout — which is only true because **no computed style depends on the
width** (percentages and `auto` survive into layout as unresolved `Len`s) and
**no box depends on the scroll** (layout writes absolute document
coordinates). Both are properties of the data shapes in `css/values.ts` and
`layout/boxes.ts`. Breaking either turns every resize into a full restyle,
silently and only on large documents. `@media` is the deliberate exception:
the widths at which some rule changes its mind are collected at parse time,
so a resize restyles only when it crossed one — and then only the elements
the rules it turned on or off match (`Cascade.crossed`), with the elements
under them whose parent's style came out other than it was
(`KeptStyles.follow`): Wikipedia's 1120px breakpoint turns 55 rules over
that match 27 of its 4,386 elements. A query on the height or the aspect
ratio is a breakpoint too: its answer is in the band (`mediaBand`), and
`crossed` is handed both heights. That stands on **a child's computed
style being a function of the rules that match it and its parent's
style**: anything new that makes a style read more — a sibling's style, an
ancestor's past the parent — has to say so to `follow`, or a crossing keeps
a style that changed. And `crossed` answers null, a whole restyle, for
what is under a media query outside the rule indexes — a `@keyframes`, a
rule in a tree's edge lists (`_outsideIndexes`) — where that query's answer
turns between the two widths: GitHub keeps its `@keyframes` under
`prefers-reduced-motion`, which no resize turns, and every breakpoint a
drag crossed styled the whole page again. A shadow tree's own rules, and a
`:host()` rule with more after it, are in the indexes under their tree, and
the walk goes into every tree, so **anything new that a shadow tree's sheet
holds outside the indexes notes its media with `_outsideIndexes`**: MDN's
custom elements made every crossing a style of the whole page. The viewport
units are the other exception, handled the same way: a `vw` or a `vh` is a
number once computed, so the cascade notes as a length is resolved which
sides a style holds (`_viewportRead`, by the style, since a style is
shared), and a move of that side styles again those elements, with
`follow` (`viewportReaders`), and the root box, whose style is no
element's. They are restyled in place where that is all they need, as a
hover is (`_restyleInPlace`, up to an eighth of the document), and the
boxes are kept: a change only of ink, or of what nothing draws — under
`display: none` before and after, which `_restyleInPlace` takes whatever
the change is, since no box shows it. Node's API pages hold a hidden picker
`max-width: 75vw`, and every step of a drag built the whole document's
boxes for it. And since a layout follows, a change of a block's lengths
alone is taken in place too (`lengths`, `lengthChange`): its width and its
limits, its margins, paddings, offsets and gaps, on a block or a flex or
grid box that is not replaced, an element's or a `::before`'s or an
`::after`'s — Apple's product pages draw a stripe `width: 100vw` from one,
and every step of a drag built all the page for it — and its text's size, its lines' height and
its indent (`FONT_FIELDS`), on such a box, on an inline box in one, on a
`::before` or an `::after`, and on the anonymous boxes that inherit them,
since `collect` sets a paragraph's runs from each box's style as the block
is laid out; never a sizing keyword, nor a font where a `::first-line` is
styled from it as the boxes are built. The box takes the new style, and
what its layouts keep of its sizes for its life is forgotten for it and
every box it is in (`forgetSizes`), so the layout after measures them
again: MDN's, Python's, GitHub's, Next.js's and the Guardian's builds at
every step of a drag were each a length in `vw`, and Bootstrap's were its
headings' fluid type, `calc(1.3rem + .6vw)`. **A box that takes a new
font has its sizes forgotten too, whoever's style it is** — an anonymous
box around a flex row's text kept the max-content it was measured at, and
the row came out at the old size's widths. **And a root whose font is
such a length moves every `rem` and `rlh` with it**: the cascade notes
what of the root's font each style reads (`ROOT_READS`, as a style's
sides), and an element's pseudo-elements' and container queries' by the
element (`_pseudoRoot`, `_queryRoot`), and a resize that moves the root's
font in place styles them again (`rootReaders`) — under a `<body>` with a
size of its own, `follow` reached none. Anything new that takes the root's
font in place does the same; a build that finds it moved keeps no style
(`_rootMoved`).
**Anything new a box's layouts keep for its life that a length decides is
forgotten in `forgetSizes`**, or a drag lays the box out at the lengths it
had; `test/html/viewport.test.ts` holds the resize to a build of the whole
document over generated documents. Readers too many for a restyle in place
are followed down from (`_restyleInPlace`'s `from`), as a change to the
tree is. **Anything new that resolves a viewport unit outside a style's
computation goes through `_queryViewportRead`**, as a container query's
length does, which styles every element again: what reads it is no style
the build can find. The viewport
is the box that scrolls the element, whose height core's layout pass
decides _after_ the element was measured — so a document that reads it (a
`vh`, the root's percentage height, a box against the initial containing
block; `LayoutResult.readsViewportHeight`) finds the move at paint and asks
to be measured again, which costs a frame per resize and only for those.

**A container query is the third exception, and it is answered after the
layout.** A container's size is layout's, so the cascade answers an
`@container` query, and a `cqw` or its kin, for the content box the last
layout gave the container (`Cascade._containerSizes`), and notes for each
element which container each read and what it came to
(`_containerReads`). Every layout then hands the containers' boxes back
(`HtmlViewNode._containersMoved`), and the subtrees of the elements whose
answers moved are built again and laid out again, at most
`CONTAINER_PASSES` times. Three things are load-bearing. **A read is noted
only where the selector matched**, so a query is a cost of the elements it
styles and not of its bucket. **An element a container rule reaches, or
whose style holds a container unit, shares no style** (`UNSHAREABLE`'s
buckets, `_containerUnitRead`): a sharing key is the element's ancestors'
and attributes, and two elements alike in all of them can be in containers
of other sizes. And **the containers are measured from boxes taken as the
tree was built** (`BoxTree.containers`), since a dragged width sets boxes
aside from the root's walk. Anything new that makes a style read a
container's size goes through `_containerReads`, or a layout that moves the
container leaves the style as it was. A query's container units are its
container's — the nearest size container above it, since a query's lengths
are the container's (`_queryUnit`) — noted for the element under a key per
container and axis (`_queryUnitKey`), and a query asked again after a
layout reads them at the sizes that layout gave (`_moving`): asked at the
last ones, a container no style had read yet answered with the viewport's,
and the query kept its answer.

**Form controls are real widgets, mounted beside the element.** `<Flow>`'s
escape hatch, and the same reason: a drawn control takes no focus, says
nothing to an assistive technology, blinks no caret and opens no menu. The
cost is that the box in the flow has to be the size the widget will be
_before the widget exists_, which is why `controls.ts` measures against the
same font metrics and the same palette tokens (`fontFamily`, `fontSize`,
`paddingY`, `borderWidth`, `radius`) core's own widgets read — the UA sheet
sets a control's text in the palette's face and size, not its parent's, as
Chrome sets it in a system font, and the widget is handed the element's
computed face and size, the page's where it set its own (`font: inherit`).
`<textinput>` and `<textarea>` are elements rather than components and draw
no frame of their own, so the component supplies one from those tokens — a
form in a document and a form in the window around it have to be the same
height. Two things are not widgets
of the palette's: a `<button>`, whose content is the document's and which is
drawn like any box (its press reported through `onControlChange`), and a
field the page styled — a border, a background, or `appearance: none`
(`styledField`) — whose box the document draws, the widget mounted bare in
its content box. A design system restyles every control it has, and a
palette frame inside the page's drew two boxes where it designed one.
And a widget is the palette's only in the palette's colour scheme: one
whose element is in the other (`ControlRect.colorScheme`) is drawn in
Chrome's control colours for that scheme, under a `ThemeProvider` of
them (`BROWSER_CONTROLS`), in the palette's shape. A browser host draws
a page that names no scheme light, so in a dark application Hacker
News's comment box was a dark well on a light page. **Anything new a
widget draws in reads its colours from the theme in force, or from
`fieldChrome`'s scheme**, never from `look` directly, and the UA sheet's
control rules name system colours rather than the look's values, so a
control the page styles builds on its scheme's colours as well.

**A field's selection is its widget's, and `FormState` holds it only
between widgets.** A script's `setSelectionRange()` selects in the
`<textinput>` mounted for the field, through core's selection API, which is
read at run time (`selectingField`). The getters read the widget, so they
answer where the user left the caret. A selection set while no widget is
mounted, and the one a widget had as it went (`WidgetBoxes`' `leaving` and
`came`), is kept for the next widget. **Anything new that sets a field's
selection goes through `Forms.setSelection`.** It keeps the selection for a
widget not mounted yet, and it notes it as `seen`, so the user's next key
is not told as `select` for the script's selection.

**A widget is cut by what the document paints over its control.** A menu
opened over a form is painted over its fields, and a widget drawn whole
came out over the menu. `controlRectsOf` asks the layers painted after the
control (`layersOver`, which places a box in the flow where its layer, or
its context's own flow, is painted) what they fill with an opaque
background (`opaqueWithin`), takes the band off the widget that a box
across it from a side covers, and hides it with a clip of no area where
what covers it leaves no rectangle. Two things are load-bearing. **What is
translucent, or wholly inside the field, does not count**: a veil would
take every field under a dimmed page away, and an icon a page sets in a
field would take the field. And **anything new that can put a box over a
control without a layout reports the controls again**, as a restyle in
place that shows, hides, fades in or grounds a box does (`coverChange`),
a scroll that moves a fixed box does at paint (`_controlsShift`), and one
that moves a sticky box does through `_stickyMoved`. A report for a scroll
asks only the controls in the viewport (`near`), where a scroll can move a
box over one, and keeps the others' last answers while they have not moved
(`_covered`): asked of all of them, a page of three hundred fields in
cards under a fixed header paid a millisecond more at every frame of a
scroll.

**What `content-visibility: hidden` holds has no boxes.** The builder makes
none of it where size containment applies to the box (`containmentApplies`,
which paint asks too), so it takes no press, no focus, no widget and no
part in the text, as CSS Containment 2, 4.1 says skipped content must not,
and an element in it answers `elementRect` with null, as one under
`display: none` does. `hidden="until-found"` is it (HTML 15.3.1), not
`display: none`, which a page's own `display` won: a mega menu that keeps
its closed panels so drew every panel at once.

**An input button the page styles is a `<button>`, not a widget.** One the
page gives a border, a ground or `appearance: none` (`styledControl`) is
built as a box with its label in it and drawn by the document, its press
and its keyboard activation a `<button>`'s (`pressableAt`, `activate`); one
it leaves alone is the palette's widget. **Anything that asks whether a box
is a button asks `isButton` or `isButtonBlock`**, which answer for both,
and a restyle that turns the styling on or off builds the box again
(`isInputButton` in `_restyleInPlace`): a black pill was the palette's
white framed button, half as wide again.

**A `<select>`'s menu is the document's to hold.** Its widget is core's
`<Select>` given `open` and `onOpenChange` (`renderControl`), so a press
asks and `pickerChanged` answers, a script's `showPicker()` sets the same
state, and `:open` reads it (`isPickerOpen`), told as a change of
`-rx-picker-open`, which restyles in place. **Anything new that opens or
shuts a control's picker goes through `pickerChanged`**, or the menu and
`:open` come apart. A core before `open` hands both props to the trigger's
box, which is how `holdsOpen` tells, so they go on the `<Select>` itself
and never on a box around it.

**A button's content is centred in whatever height the button comes to.**
HTML's button layout (15.5.5) puts it in a box of its own, centred down the
button, and `centreButton` (`layout/block.ts`) moves it there when the
button is laid out. A flex box, a grid and a pair of offsets give a box its
height _after_ its layout, so each asks again where it does: **a new path
that sets a box's height once it is laid out calls it too**, or a button
stretched that way keeps its label at the top. It moves the content and not
the box, as a cell's `vertical-align` does, and both go through
`moveContent`, which takes the static positions kept from the box's corner
down with the content. Anything else that moves what a box holds inside it
goes through it too, or an absolute box with no offsets is left where the
flow used to be.

**`text-wrap: pretty` is Blink's score line breaker, and asks the engine
for its breaks with a character.** The scoring is `layout/pretty.ts`, pure:
the last four lines of a paragraph, only where they end on a short word
alone, Minikin's penalties, and Blink's gates — a line that overflowed or
was cut, a `::first-line`, an inline box with `box-decoration-break:
clone`. Its tests hold it to Chrome's lines over the same text. Neither
engine takes break positions, so a break is asked for by making the space a
line ends on U+2028, as long as the space, so every offset holds. Three
things are load-bearing:

- **A line separator is no forced break.** `justifiedRuns` and the
  line-at-a-time loop's `forced` read a line feed alone as one, so a line a
  separator ends is justified and aligned as the rest are. Everything that
  asks where a line may break after white space (`SPACE`, `BREAKS_AFTER`,
  `unbreakableAfter`, …) counts U+2028 with it, and `breakBefore(…, true)`
  ends a segment's line at one: without them, a separator straight after
  an inline box's text glued the next word to the box's last, and the line
  broke a word early or not at all.
- **Lines made a piece at a time are made twice.** The loop knows nothing
  of scores. `prettyAgain` lays the paragraph out once as `layoutSpaced`
  would, scores that where its lines start where the loop's did, and
  `layoutLines` makes the lines again with the separators in the items,
  keeping them only where the engine broke at every one.
- **A break with no space to take cannot be asked for.** After a hyphen,
  between two ideographs: a paragraph whose best breaks include one keeps
  its greedy lines. An engine option for break positions would lift this,
  and `balance` could use it too.

**A justified paragraph is the text engine's to space, where it says it
can.** An engine that takes `justify` (`fonts.justifies`: ntk's, and
react-x11's macOS engine's over @windowkit/appkit) spaces the lines after
it breaks them, from the shaping it keeps, so a paragraph laid out at
another width is not shaped again. Spaced here instead — every space a run
of its own (`spacedApart`), and the layout made again with each spaced by
its line's share (`justifiedRuns`) — the last layout was a new text at
every width, which CoreText shaped again: most of a resize's frame on the
Zen Garden's justified designs. Three things are load-bearing. **The fast
path lays a paragraph out justified at once only where nothing after it
reads the lines unjustified** (`justifiedAtOnce`): kept spaces, a clamp, a
cut and `text-wrap: pretty` go on through `justifiedLayout`, which hands
the engine the runs a second time. **Spacers between inline boxes are no
separators**, so a paragraph that has them (`layoutSpaced`'s `skip`) and a
line beside a float (`justifyLine`, whose share runs across its pieces) are
spaced here on every engine. And **anything that stands in for the engine
answers `justifies` as the engine does** — `withLayout` forwards what an
engine has, and the layout cache and the recorder say it themselves: a
wrapper that dropped it would send every paragraph back to the spacing.

**A line made a piece at a time is cut for `text-overflow` after the
lines are placed** (`ellipsizeLines`, CSS Overflow 3, 5.1). A line with an
image or an inline-block on it is pieces, which no engine sees whole, and
the engine's cut is what ends a line of the other paths in an ellipsis:
Gmail ends a message's preview with an emoji `<img>`, and the line was
clipped mid-word with nothing after it. The text the cut falls in is laid
out again as far as it fits beside the mark (`clipText`), the mark is set
after it in the block's style and on the line's baseline, and what comes
after is gone — a text taken off the line, an atomic hidden whole through
`CLAMPED`, which paint and the ink bounds pass over. Two things are
load-bearing. **What a cut hid is shown again at the next layout of its
lines** (`ellipsizes`), before they are cut again: `CLAMPED` outlives a
layout, and a wider box would draw a hole where the icon was. And **a line
cut so tells an intrinsic width it was** (`CUT_LINES`, beside the engine's
`truncated`), as one the engine cut does: it is wider than it was drawn,
and what a probe measured of it is of what was drawn.

**Nothing is fetched, by construction, and nothing is executed unless the
application turns it on.** `onResource` is the only way anything loads —
the same call the desktop calendar makes about credentials: the host
already did the work of knowing its policy, and a component that silently
made requests would turn "render this HTML" into "make these requests". A
declined resource is an ordinary state, not an error. **Do not add a
convenience default that fetches**; the absence is the feature.
`HtmlNetwork` and `useHtmlNetwork` (`network.ts`) are a policy an
application _hands in_ — the example browser's, moved here so that the
common case is one line — and never a default `<Html>` reaches for.

**Nothing is stored by construction either**
(docs/prd-browser-profile.md). A network keeps a cookie only where it is
handed a `CookieJar`, a document has `document.cookie` only where
`scripts.cookies` is one, and `scripts.storage` is the process's memory and
a document's own IndexedDB unless a host hands in a store — `HtmlProfile`'s,
an SQLite database every process of a browser opens, and the only place
anything reaches a disk. The HTTP cache is the same: a network's memory
unless it is handed a store (`httpCache`), and the profile's is a second
file beside the database (`cache.sqlite`), since its bodies would grow the
log every cookie write goes through and its writes would move the
`data_version` every reader of a cookie watches. **A subresource goes
through the cache's rules, RFC 9111's** (`http-cache.ts`, `_http`): a
response is used again only while it is fresh, a stale one is asked about by
its validators, and nothing is kept that may not be — the old memory kept
every response for the process's life, `no-store` and all, and never asked.
So **anything new that hands a page a body it may use again goes through
`load`**, and anything new a response's use depends on — a request header a
`Vary` can name — is in `_headers`, which the cache compares, or a kept
response answers a request it was not chosen for. **A network with a jar follows redirects itself**
(`_exchange`, `redirect: 'manual'`), because a login's session is set on
the redirect it answers with and the runtime's `fetch` follows it out of
sight: anything new that sends a request goes through `_exchange` with what
the request is to the jar — its credentials mode, its site for cookies,
whether it navigates — or its cookies are neither sent nor kept. Without a
jar `_exchange` hands the transport `redirect: 'follow'`, as before.

`scripts` is the one switch that executes anything, and it keeps the same
rule: it is off unless an application turns it on, and what a page loads
goes through the application's seams — a script's source through
`onResource` as `kind: 'script'`, a page's own requests through
`scripts.fetch`, which fails every request where it is not given. **Every
new seam the engine needs gets a default that does nothing or reads what
is already there**, never one that fetches, navigates or writes outside the
document. `onScript` still runs nothing, for an application with an engine
of its own.

**What arrives late is answered by what it changes.** A stylesheet the head
links to, or one it imports, holds the first rendering until it is in
(`_renderBlocked`), as a browser holds a page: built before then, the
document was built, laid out and painted unstyled and built again for
each sheet. An image only a background, a border image or a mask paints
is painted where it lands (`_imagePainted`), the store having been told
so where it was asked for (`request`'s `paintOnly`). An `<img>` built
before its image was in takes the image's size in place (`awaiting`,
`_imageArrived`), and the document is laid out again only where a size
moves; only an element whose box is another kind with its image
(`awaitingKind`), or a marker or generated content sized by it, builds the
boxes. **Anything new that a box takes from an image as it is built joins
one of those lists**, or an arrival leaves the box as the image was not.
And a size taken in place forgets what the boxes around it measured of it
for their lives (`forgetSizes`): a flex item, an inline-block or a float
shrunk to an image still on its way stayed as narrow as no image once it
came, and the image hung out of it.
Over a network, the Zen Garden's designs took eleven builds a page before
these and take one; Wikipedia's X Window System article was built eleven
times as its images came in, at some 180 ms a time on a Mac, and is
painted.
**What lands while a build is owed adds to that build, and never widens
it** (`_imageArrived`, `_arrivedKinds`). A change says what its build
reaches (`_buildSeeds`), and `_invalidate` with `Stale.Boxes` and no seeds
takes that away: the build is the whole document's. An image lands on any
turn of a page still loading, and each that landed between a change and its
frame did that, with no box of any other kind. On a cold load of the
Guardian, in a real window, that was seven to ten builds of the whole
document, and on BBC two to five. So a build of subtrees that is owed stays
one: what it builds reads each size as it makes the box, every other box
takes its size in place as it would with nothing owed, and what comes out
another box with its image joins the seeds with its element, styles kept.
Measure these cold, from a profile with nothing in its cache: a warm one
lands every image in a bunch before the page's scripts have changed
anything, and shows none of it. **Anything new that answers something late
adds to a build owed through `_invalidate`'s `seeds`, or leaves it as it
is**: `'resized'`, which no site here has told, is the last that does neither.
**A list's entry goes with what built it** (`ContentImage.box`): a tail
builds its holder's `::after` again, and an entry kept by the holder stays
beside the new one, and with no size is news at every arrival after it. And
**what will have no image is listed as waiting for none**: an `<object>`
that holds a document is its frame for good. A build of subtrees cuts the
document's text where its boxes say, so **a build's text and its boxes agree
to the character** (`textBoxesAstray` holds them to it): `_endLine` takes a
space back off the last chunk, and one it empties goes, or the next takes
its space from nothing and every place after it is one out, which a
comparison of two builds cannot see, since both are.
`htmlsweep.mjs`'s `LATENCY` is how that is measured: answered at once,
arrivals coalesce into a frame and none of it shows. **A sheet declined
or failed after it was asked for is news too** (`'declined'`, in
`resources.ts`): it changes no style, but nothing else asks the held
rendering again. Zen Garden 215 imports two `http:` sheets its secure page's
host refuses, and the bench's harness measured it a viewport tall until a
query built it; anything new that holds the first rendering has to be told
when what it waits on will never come.

**What nobody can see waits, and a face that arrives is the first to.**
A face changes two things: the family list of the styles it is for, and
the text set in them. Neither needs a cascade or a box. So the lists change
where they are, in every style the tree holds (`_takeFaces`), a walk of a
few milliseconds where a whole build was most of a swap, and each block
with text in such a face owes setting again (`_owe`, `_setAgain`). What can
be seen is set at the next frame, and the rest a slice at a time on
`owedClock`, up to `OWED_SLICE_MS` a slice, once no scroll or key has come
for `OWED_QUIET_MS`, sooner where a scroll comes near it (`_followOwed`).
Nothing is set aside: an owed block keeps its old lines and is moved by the
layouts around it as any kept block is (`reuseLaid`), so a scroll onto it
finds it there, drawn as it was. That is why this is the keep and not the
drag's `setAside`: a drag's boxes are a width out of date and cannot be
drawn, and these can. Faces that come before a frame are taken as one, and
a bold face leaves the regular text alone (`WebFonts.arrivals`). Seven
things are load-bearing.

- **`familyWritten` is what a list comes from, and `fontFamily` what the
  engine is handed.** Two lists can come to one `fontFamily` while no face
  of a family has loaded, `Inter, sans-serif` and `sans-serif`, and only the
  first changes when Inter does. Anything new that sets `fontFamily` sets
  `familyWritten`, or a style keeps the face it had. The host's own family
  is written as `''`, since no list of the sheets' is mapped from it.
- **Every style the tree can hand out takes the list**: those of the
  elements and the boxes, a marker's, and each style `anonymous` made, one
  no box has now among them (`anonymousMade`). Anything new that keeps a
  style past a build joins that walk. A style is changed where it is, so
  what is noted of it by identity stands (`ROOT_READS`, `VIEWPORT_SIDES`).
- **A length read from a face is computed again** (`readsFace`, `_exOf`,
  `_chOf`, `_lineHeightOf`): anything new that reads a face as a style is
  computed sets `_faceRead`, or `max-width: 65ch` stays the old face's. Such
  an element waits with its box, in `_stylesOwed` until then.
- **A box built from a face is built again** (`READS_FACE_AS_BUILT`): a
  widget's size and a drawing's text are read as the boxes are built, so a
  kept box would keep them. Anything new the builder reads of a face joins
  it.
- **A block owes setting again for its own font as well as its text**: its
  lines are held open by its strut, whatever is on them, and an inline box's
  by its. Anything new that lays a line out from a style's face is asked in
  `_takeFaces`' walk, or a line stays the old face's height.
- **What a box was laid out by is `FontsLike.engine`, not the cache**: a
  `TextLayoutCache` is new at each arrival, which drops every per-`fonts`
  cache keyed by a list (`FACE_EXTENTS`, `SPACERS`), and a kept box stands.
  Anything new that notes what a box was laid out by notes `ctx.engine`.
- **A tree a face cannot be taken into in place takes the swap whole**, at
  the next frame, as it always did: where a layout keeps no blocks, under
  anchors, `::first-line` or a `<foreignObject>` (`layoutDocument`'s
  `reusing`), and a vertical flow, whose styles are turned copies of the
  cascade's.

**A read of the page's brings all of it up to date** (`_settle`): a rect,
an offset, a client box, a range's rects, a scroll to an element, and a
scroller's extent where something in it waits. So it answers what a whole
build would, and pays what is left, which is the text and no build. A
script's `getComputedStyle` is the one that looks first: a style is right
with its text still to set, so the host answers with what waits left waiting
and says so, and the facade asks again for a property a box decides
(`comesFromBox`), which is the read that settles. Settled at every call, one
read of a sidebar's style in the middle of a scroll paid 258 ms on MDN for 208
blocks nobody could see. **Anything new `cssomAt` reads from a box joins
`FROM_A_BOX`**, and a test in `values.test.ts` finds one that does not. What aims a press, or a hover, is no such read: it asks
what is drawn, and a pointer move must settle nothing, which is why the
handle's `elementAtPoint` settles and the node's does not.
`IntersectionObserver`s and `ResizeObserver`s do not settle either: they are
told as the boxes move (`_geometry`). **Anything new that answers a page from
the layout calls `_settle`**, and anything that answers core or a pointer does
not. `FontFaceSet` is told as a face settles, as before: what a page reads
after `ready` goes through `_settle`, so it is neither early nor late.

**Joining it takes three things**, for an image's size or a sheet's rules
as for a face (`_owe`). A change may wait where the document stays whole
without it: the box stays drawn as it was, and nothing that runs before its
turn reads what the change would make. Its work is handed to `_owe` with the
box it is for, the block a layout keeps, and brings that box up to date for
the layout that follows, forgetting what is kept of it (`forgetSizesIn`);
what it owes a style goes in `_stylesOwed`, which a read works out
(`_owedStyle`). And what the work changes is kept off screen by a box's
place: anything that depends on the whole document, a stylesheet's new
`@font-face` say, is no change that can wait. A build makes it all new
(`_owedDone`), so nothing has to be undone, and work on a box a subtree build
replaced runs on nothing. The order is the viewport first, then the nearest
either way while they are near, then down the page, then up it: what is set
above what can be seen moves it, and the pane follows (`_keepAnchor`), which
repaints what it shows. So does telling the pane how tall the document came
to be, so that is held to `OWED_MEASURE_MS`.
`test/html/owed.test.ts` holds a document set again around a page's scrolls,
reads and changes to a whole build, box for box over generated documents;
`OWED_SEEDS` sweeps more of them, and `OWED_FROM` starts at one. **None of
it runs under a drag's layout** (`_partial`): what a flex box measures of
an item is kept for the item's life, and measured with what is set aside
cut out of it, so forgotten during a drag it stays short of what the item
holds. The drag lays out what can be seen in the faces there are, and what
waits runs once it has rested; a read during a drag has what the drag has.

**An image's size is its header's until its pixels are in**
(`image-header.ts`, `ResourceStore._decoding`). A PNG, a JPEG or a WebP of
8 KB or more decodes on a worker thread, and a page of photographs queues
them, so the store reads the size from the head of the file as the bytes
arrive — PNG's IHDR, a JPEG's frame header turned by its EXIF orientation
as ntk's decoder turns the pixels, WebP's first chunk, GIF's logical
screen — and the image is laid out at it while it decodes, as a browser
lays one out. On Apple's MacBook Pro page an `<img>` answered from the
cache was still decoding 2.5 s after the network went quiet, and the boxes
under it sat 284px too high until it landed. Three things are
load-bearing. **"Pending" is two questions, and each reader asks one**:
`ResourceStore.state` is `'pending'` until the pixels are in, which is what
paint (`image`), the document's `load` (`pending`) and the picture a source
swap keeps showing (`ImageSources.shown`) ask; `imageSize` answers from the
header as well, and a box waits on `_sizePending` and
`ImageSources.sizePending` (`awaiting`). Anything new that reads an image's
state says which it means, or an image is drawn before it has pixels or
laid out before it has a size. **The header is believed until the decode
says otherwise**: a decode that comes to another size, or fails, is told as
`'resized'`, and the boxes are built again around kept styles. And **a size
from the header is told as `'sized'`**, which takes sizes in place and
paints nothing; the pixels' arrival is the `'image'` it always was. A test
holds the decode through `imageDecoder`, as it holds a clock.

**A cache kept by an element is dropped by what can make it stale.** A
`refresh()` is an application saying it changed the tree — anything in it,
an attribute or the middle of a drawing — and a stream's chunk is the
parser adding to it. Two clocks in `dom.ts` tell them apart:
`treeGeneration` moves at both, `mutationGeneration` at a `refresh()`
alone. A matcher that keeps answers (`compileSelector`) and the pragma
language go at the first, since a chunk can change what they read; a
shape's attribute `var()`s and the inline drawings at the second, since the
parser sets no attribute of an element it made before and a drawing sees
for itself what a chunk added to it. `SvgView` is a cache of this kind
too: it reads a root's `viewBox` and the ids its `url()`s name as it is
handed the tree, so a drawing is made again rather than kept. **Anything
new that keeps what it read off an element, by the element, drops it at
one of the two**, or an application's change and `refresh()` leave it as
it was — which `test/html/replaced.test.ts` finds for a drawing only by
changing what `SvgView` reads once, since what it reads at each draw
passes either way.

**A refresh told what changed restyles what a selector testing it
reaches** (`refresh(changes)`, `HtmlChange`, a `MutationRecord`'s shape).
The cascade reads every selector once for where it tests each class, id,
attribute and what an element holds (`MutationRules`, `scanChanges`): its
subject, before a descendant or a child combinator, before a sibling
combinator, or in a `:has()` (`CHANGES_*`); and the element finds the
elements those reach from each change (`_changeScope`, `spreadChange`).
What only inks is restyled in place, as a hover is; a box out of the flow
that moved goes through a frame's build (`_rebuildFrame`); anything else
is a build keeping every other element's style with `follow`, so what is
under a restyled element is styled again only where its parent's style
came out other than it was. A restyle in place does the same where the
elements a change reaches and all they hold are more than it takes
(`_restyleInPlace`'s `from`): it walks down from the top through what is
above them, a parent before its children, and on below an element only
where its style moved. A `:root:has(…)` puts the root among what a
`<script>` put in the `<head>` reaches, and each was a build of the whole
document on Next.js. Three things are load-bearing. **A
pseudo-class css-select knows is in `PSEUDO_READS` with what it reads**:
one missing there reads nothing, which is right only for one css-select
refuses, since that drops the rule. **An attribute anything but the
cascade reads is out of `STYLE_ONLY_ATTRIBUTE`** — a source, a value, a
label, a hint whose style reaches the element's descendants — and builds
the boxes, restyling the element and what is in it. `role`, `aria-*` but
for `aria-label`, `hidden` and what a player tells of itself are in it,
since only a selector and a widget's render read them, and a `tabindex`
that stays a number says only whether Tab reaches its element, so it
reports the stops again and builds nothing (`tabindexStays`): Apple's
galleries move theirs from card to card. **A key in a
`:has()`'s argument reaches the elements whose answer changed, found by
the `:has()`'s compound** (`HasAnchor`, `spreadAnchors`): the element that
changed and its ancestors, their earlier siblings where the argument
starts at a sibling, and what a holder holds, each asked whether it
matches the compound with nothing in it a change can change the answer to
(`stableCompound`: its type, classes, ids and attribute tests). So
**anything a compound reads besides an element's own name and attributes
stays out of its anchor** — a pseudo-class reads its place, what it holds
or the pointer, and the anchor is asked after the change — and **no walk
goes down**: a key read inside its element too (`PSEUDO_INHERITED`,
`:lang()`, `:dir()`) is the attribute of none that is style-only, so a
change of it restyles the element and everything in it, wherever the
element whose `:has()` it changed is. Make one style-only and that walk is
owed. **What a holder holds and where its children sit are two keys**
(`'h'`, `'s'`): a child coming or going reaches its holder's own later
siblings only through a test of what the holder holds before a sibling
combinator (`:empty + x`), and a sibling combinator alone reaches the
holder's children after where the child came or went and what is in them
(`TreeReach.followers`, `followersOf`) — all of them where the record does
not say where; the Guardian's ad scripts put a `<script>` in its `<head>`
some thirty times a load, and each restyled the whole `<body>`. **A test
of where a child sits, or of what an element holds, reaches from what its
compound names** (`TreeReach.self` and `below`, `MutationRules.tested`):
the holder for a test of what an element holds (`:empty`), its children
for one of where an element sits (`:first-child`, `:nth-child()`), each
where the stable part of the compound it is in matches — a child
where the compound a combinator leads to it from is around it,
above a rule's subject as in it, `.menu > :first-child` — and below them what its
rule's subject names. **A new pseudo-class that reads what an element holds
or where it sits joins `HOLDS_TESTS` or `SITS_TESTS`**, or it is taken to
reach every one of them, as `:default` is. A webmail
page hides a split button's separator by where the button sits,
`.btn:not(:last-child) .label`, and every popup it put at the end of its
`<body>` restyled all 13,000 of its elements. So **a record says where
its nodes came or went where it can** (`HtmlChange`'s `previousSibling`
and `nextSibling`, which the script host hands on as a `MutationRecord`
has them), and a sibling it names that the list took out as well is
followed to what that one's record names (`ChangeScope.gone`): a page
that takes its popups out one after another names each the next. A holder nothing draws still
reaches its later siblings, which are not under it. **A child that comes
or goes reaches a `:has()` that asks only of its subject where what came
or went holds one** (`'g'`, `MutationRules.held`, `Cascade._heldReached`):
an argument with no sibling combinator and nothing that reads where an
element sits, what it holds, its text or the elements around it
(`SITS_KEYS`, `READS_AROUND`) answers otherwise for a child put in or
taken out only where that child, or what is in it, matches the stable
part of its subject, since no element that stays gains or loses an
ancestor. Any other notes `'s'` and is reached by every child, as every
`:has()` was. joshwcomeau.com's
`html:has([data-disable-document-scroll=true])` put the root among what
each sparkle its like button put in reached, and the root, a seed no
subtree is built around, built the whole document three times a second. **A pseudo-class read from elements around
its element that no key says joins `READS_AROUND`**, or a `:has()` that
tests it is reached by less than it reads. **An attribute selector is a key of its own** (`v:`), asked of the
value its attribute had and has by css-select itself (`Cascade._flips`),
which made Primer's `[class*=…]` and its `:has(~ …)` no change of every
class on github.com/features. **A key tested above its rule's subject
reaches, below the element it changes, only what the subject names**
(`MutationRules.below`, `AttributeReach.below`, `addSubjects`): the stable
part of the subject compound of each rule that tests it there
(`stableCompound`), matched below the element, as hover's
`PointerCompounds.below` is. bun.com's blog sets `data-scrolled` on
`<html>` at the first notch of the wheel, which one rule reads for its
header, and `reveal-ready` for elements it has none of, and each restyled
all 7,000 of its elements: 213 ms at the first notch. A function's argument
is tested above the subject of the rule it is in, `query-builder:not(:defined)
.QueryBuilder-Input` as much as `.dark .card`, which every custom element
GitHub upgrades took for all it holds. So does one tested
before a sibling combinator, among the later siblings and what they hold
(`MutationRules.later`, `AttributeReach.later`): Apple's local nav turns
dark with `#ac-localnav.ac-localnav-dark ~ #ac-ln-curtain`, and that one
class restyled and built the 5,000 elements after it. And so does a
`:has()` above its rule's subject, from each element its compound matches
(`HasAnchor.subject`): Apple's `:has(>.caption-primary) .caption` names
nothing, so it is asked of the `<body>` at every change to what it holds,
and all 5,800 of the page's elements were styled and built for its
captions. The reach stays whole wherever the selectors do not say all a
change styles: a rule at a tree's edge, a key inside a function's argument,
a `:has()` in one, what an inherited pseudo-class reads
(`PSEUDO_INHERITED`), a subject with nothing stable in it (`*`,
pseudo-classes alone), a class or an id whose old value is not known, and
an attribute anything but the cascade reads. So
**anything new that notes a key below its element notes it with its
subject, or with none for the whole of what is there**, and the walk below
stays in the element's tree, since only a rule at an edge styles across
one and those reach everything. Tailwind's preflight brings `:host, html`,
an edge rule, to every page it styles, which makes every change cross
trees (`changesCrossTrees`): that must not turn the narrowing off. **A sheet's element is a change to the
cascade only where the sheets read otherwise** (`_sheetsKept`, over the
`_sameSheets` that `_restyle` asks to keep the cascade) — a `<link>` put
in before its sheet is in is a change when the sheet comes — and
`changesCascade` lists the attributes `DocumentSource.facts` reads of
them: anything new read there joins it. Where the sheets do read
otherwise, **the cascade made again takes the parses of the one before**
(`_parseSheet`), each once, since `place` sets its rules' `order`: so
anything new a parse comes to read besides its text, its base, the media
it is under and the layers ranked before it joins `ParsedSheet`, and
nothing after a parse changes a sheet but that `order`. It takes what the
one before read of them too (`_noted`), the reach of a change, a hover and
a focus, which was most of what making a cascade cost: **what `MutationRules`
and `StateRules` keep reads a selector and nothing else**, and is only ever
added to, so what a sheet that has gone left in it reaches more than it
need and never less. **And where the indexes hold nothing that has gone, it
takes them too** (`_stillHolds`, `_takeOver`): every sheet filed in them is
still there, for the tree it is filed under, so only the rules of the
sheets that are new are walked (`_fileRules`), and a sheet that adds rules
costs what it holds. GitHub and YouTube hold some 28,000 rules, and each
sheet their scripts brought walked all of them, 50 to 60 ms, were it two
rules or none: each is about a millisecond, and `_restyle` comes to a
quarter to a third less a load. A sheet taken out, or written over, which
is another parse, makes the indexes from nothing, as a `<style>` a CSS-in-JS
library writes to does: such sheets are small, and BBC's and the Guardian's
cascades come to some 50 ms a load whichever way they are made. Four things
are load-bearing. **Anything new a walk of a sheet's rules leaves on the
cascade is taken over in `_takeOver`**, and what is read from a sheet's
short lists is read by each cascade from each sheet, in their order
(`_addSheet`), since a sheet may land anywhere: GitHub's land before the
sheets in its `<body>`. **A place in the cascade is read from `rule.order`
as a rule is matched**, and never from where a bucket has it, so **a rule
made from a sheet's under another selector goes in `_restated`** — a
pseudo-element's, a view transition's, a `:host()`'s — whose `order` is a
copy `place` does not reach. **A matcher asks what changes through
`_current`, never `this`**, since it outlives the cascade that compiled it,
and **what an `IndexedRule` keeps is kept with what it noted**: a `needs`
with `_askedIds` and `_askedClasses`. And an added rule is looked for among
what the cascade filed (`_latest`), since a walk of the indexes for it costs
what the take-over saved. A refresh of everything keeps a cascade whose
sheets read as they did, so it agrees with itself: the sheet fuzz in
`test/html/refresh.test.ts` holds each step to a cascade made from nothing
as well, and `walkOf` holds all a walk leaves. **Where all the
sheets did is add rules, what those rules can style is styled and nothing
else** (`_sheetsAdded`): a sheet put in, a `<style>` written to at its
end — a CSS-in-JS library's as each component first renders — and a
`<link>`'s sheet that came are a build keeping every other element's
style, the cascade made again before it, and the elements an added rule's
selector matches, whatever its media, styled with what the change reached
(`addedRules`, `Cascade.addedReach`, which finds an added rule by its
declarations). The Guardian's, BBC's and GitHub's scripts each restyled
the whole document a few times a load so. A `@keyframes` reaches what runs
its name, an element or a `::before` of one (`runningAny`): Wikipedia's
chunks of CSS each bring one, and each styled all 18,000 elements of an
article. Anything else a sheet does styles every element again: one taken
out or written over, and one adding what reaches past its selectors — an
`@import`, `@font-face`, `@property`, `@function`, `@position-try`,
`@counter-style` or layer, a rule at a shadow tree's edge or for a highlight.
**Anything new a sheet can declare that reaches past the elements its
selectors name joins `onlyRules`' and `rulesAfter`'s checks**, or a sheet
bringing it restyles too little. A shadow tree's sheet reaches only what the
tree's host holds, so a tree that comes to read otherwise, or to other
rules, styles its host and all it holds (`_shadowKeys`), where GitHub's first
`<tool-tip>` styled the whole document. A `<meta>` the
cascade reads (`pragmaMeta`: a `color-scheme`, a `content-language`), a
`<base>`, a `:has()` every element could anchor
that reaches past it (`ANYWHERE_ANCHOR`), and one in `:nth-child(… of …)`
are refreshes of everything: the scope says null, and nothing is skipped.
Any other `<meta>` is an element like any, which the Guardian's scripts,
Next.js's and npm's put in for a page's social cards. And the
`stylesheet` prop is compared by the sheets it holds: `<Html scripts>`
merges a page's adopted sheets into it at every render, and github.com
was styled whole some sixty times a load. A shadow tree attached is none:
no selector outside a host can tell it has one, so its record
(`type: 'shadowRoot'`) reaches the host and all it holds, across trees, and
the tree is bound to its rules as the sheets are read (`bindShadows`), as a
host put in with its tree is (`HELD_TREE`). Every custom element with a
shadow tree styled and built the whole document, a second of MDN's load.
Nor is a rule at a tree's edge
— `:host()`, `:host-context()`, `::slotted()`, `::part()` —: every
key it tests is read as reaching the element it is tested of and all below
it (`MutationRules.noteEdge`), and while one is in the cascade a change
spreads across shadow trees and into slots (`addFlatSubtree`). It had made
every change a refresh of everything, and GitHub's `<tool-tip>` brings
such a tree to every page that upgrades it. `test/html/refresh.test.ts` holds a refresh told what
changed to one of everything, computed style by computed style, over
random documents, rules and changes, and fails if none of them went in
place, through a frame or through a build; every way a reach was dropped
on purpose was caught by it or by a test beside it.

**What a `:has()` holds that compiles a selector of its own is compiled
apart from it** (`compileHoisted`). css-select hands the `:has()`'s element
to whatever is in an argument with a combinator, as a context, and reads the
selector in it as relative to that element (fb55/css-select#1930), where
Selectors 4 matches it against the whole document: `.p:has(+ .a:not(.b))`
asked for a `.b` inside the `.p`, which its sibling never is, so it held of
every `.a`, and Apple's sections matched rules a browser's do not;
`:has(+ :is(.a))` and `:has(+ input:checked)` matched nothing, and
`:has(> .a:is(.x .a))` found no `.x` around the element. So each `:is()`,
`:where()`, `:not()`, `:nth-child(… of S)`, alias of css-select's and `:scope`
(fb55/css-select#1931) in an argument is compiled by itself, with
`:-rx-hoisted(n)` left in its place, and only what is compiled changes: what reads a rule for what it
reaches reads it as written. What is left of an argument is held inside the
element (`insideHas`): css-select anchors an entry that starts at no
combinator and has one in it with a descendant combinator that may take the
element itself (fb55/css-select#1928), so `.a:has(.a .b)` held of an `.a` with
a `.b` in it, and `* > X Y` hands that combinator the `*` to take instead. It
is that form because `> X Y, > * X Y` or a `:scope` in the entry gives up what
css-select keeps of a `:has()`'s answers, and `* X Y` walks up from each of
`X`'s ancestors in turn. Four things are load-bearing. **Anything new that
hands css-select a selector goes through `compileHoisted`**, as
`compileSelector` and `_query` do, or what it answers and what the page is
styled by come apart. **`_query` gives each piece the context it was asked
with**, since a `:scope` in an argument is the query's, and the root's in a
rule. **A pseudo-class css-select adds that compiles a selector joins
`compilesSelector`, or `SELECTOR_ALIASES`** where it is one of its `aliases`,
which it does not export. And **a selector in such a function may read what
no walk from a change finds** (`readsApart`): what a combinator in it climbs
to may be above the `:has()`'s element, and what a sibling combinator reaches
may be before it where the argument starts at a sibling.
`scanFunctionChanges` notes such a selector `CHANGES_ANYWHERE` and `testsApart`
makes a state it tests no local one, and a change of either styles every
element, as what `:nth-child(… of S)` counts by does, so the test stays as
narrow as it can: a sibling combinator in an argument that goes down stays
inside the `:has()`'s element, and Tailwind's `peer` in a `has-` is one, which
read as reaching everything would make every change to tailwindcss.com's tree
a refresh of the whole document. A refresh told what changed and a refresh of
everything share what the matcher answers, so the fuzz in
`test/html/refresh.test.ts` sees none of this: `HAS_ARGUMENTS` in
`test/html/harness.ts` holds the answers to Chrome's. When a release of
css-select fixes fb55/css-select#1928 delete `insideHas`, and when releases
have fixed both fb55/css-select#1930 and fb55/css-select#1931 delete
`compileHoisted`, as "Vendored from core" has it for a copy.

**A matcher that outlives a change is told to keep no answers.** css-select
keeps them by default for as long as a matcher lives, and not only for a
`:has()`: a descendant combinator after an `:is()` or a `:not()` with a
combinator in it does too (fb55/css-select#1929), so `:is(.x .a) .y` answered
what it did before the `.x` came, under a whole refresh as well.
`compileSelector` and `_query` pass `cacheResults: false` to all but what is
compiled again after a change. A test of the text cannot say which selectors
arm it, since a tenth of a page's selectors hold such a function and few of
those arm anything. The option stays when a release narrows that cache: it is
what css-select's README asks of a document that changes between queries.
**Anything new that keeps a compiled matcher does the same.**

**A `:has()` that asks only of its element's children or its siblings is
asked only so many levels up, and a sibling combinator reaches what it
leads to from what it follows.** A `:has()` whose argument goes by child
and sibling combinators alone and tests nothing of an element but its name
and attributes (`childLevels`) has its anchor bounded (`HasAnchor.levels`),
a sibling counting as no level: Apple's sections style
`:has(+ .section:not(.background-alt))`, and a dialog moved out of a card
was 14 sections built and laid out again, some 4,300 boxes a read, 26 reads
a task. Only an anchor that starts at a sibling is asked of what is beside a
change (`at`'s `beside`), not every anchor of a set one of which does. So: `spreadAnchors` asks no element
further above what changed than that, and `_heldReached` looks no further
into what came. So a compound that names nothing is no longer an anchor
every element is, `CHANGES_ANYWHERE`: Apple's product pages style
`:has(>.caption-primary) .caption`, which made every change to their tree
a restyle, a build and a layout of all of it, some 400 ms each forced read
of their script's, and ran it into its time. A sibling combinator notes
the stable part of the compound it follows and of the one it leads to,
paired (`MutationRules.tilde`, `plus`), and `siblingsReached` walks a
holder's children once, in order: what came, what went, a child whose
place a test before a combinator reads (`TreeReach.later`) and a child
reached are each a source, a `~` reaches what it leads to after one it
follows, a `+` the next. That is what follows a chain, `A + B ~ C`, and
`:checked ~ .form-label` beside `#menu:checked ~ #main` reaches labels
from a banner put in at the top of a `<body>`, and not `#main`. Three
things are load-bearing. **An argument that can read past the elements it
tests gets no levels** — above them, as a functional pseudo-class other than
an `:is()` or a `:not()` of names and attributes can, or `:lang()`, or
`:disabled`, or what one holds, as `:empty` does — so anything new a compound
in one can read is checked in `childLevels`. **Anything new that walks from a change to the elements
whose answers changed counts its levels**, or a bounded anchor matches
where its `:has()` cannot. And **the tree an element is in is found again
once the tree changes** (`Cascade._treeInfo`, by `treeGeneration`), not
only at a build: a refresh that builds nothing styled an element a script
moved into a shadow tree by the document's rules, which this change's
reach was the first to leave to a refresh of that kind.

**What a change can reach and comes out as it was is not built**
(`_seedsThatMoved`). Before a build of subtrees each seed is styled, from
the top down, from its parent's style as it stands: one that comes out as
it was is no seed, and keeps its style in whatever is built around it, and
what is in one that moved is built with it and not asked. Scrolling
through Apple's page while it loads laid out 146,000 boxes where it laid out
252,000, and built the document 15 times where it built it 28. Four things
are load-bearing. **A seed whose boxes differ whatever its style comes to
is in `ChangeScope.always`**: what holds what came or went, a text's
element, the element of an attribute that is not style-only, and all that
came or moved, which a rule of a pseudo-element's may reach where it is
now. **An element's style says nothing of its `::before`**: where a rule of
a pseudo-element's can answer otherwise (`ChangeScope.pseudo`, `treePseudo`)
a seed is built if it has had one (`GENERATED_ON`, since an anonymous box
hides one from its element's box, and a `display: contents` has no box to
look under) or comes to, and no seed is asked at all for a `::marker`'s, a
`::first-line`'s or a `::first-letter`'s. So **anything new a build reads
of an element that is neither its style nor an attribute's value joins
`always`**, and **anything new that reaches an element joins the
pseudo-elements' levels**, or a change that moves only what a rule of a
pseudo-element's sees is dropped with the seed. And **what holds what came
or went is built from there on where its own style stands**
(`_subtreeRoots`' `restyled`, which a seed that came out as it was is taken
out of), so a `:has()` anchored at the `<body>` leaves a tail at its end,
where it had built the document.

**A build for such a change builds the subtrees it reached, and the
layout after it keeps the blocks it did not** (`buildSubtrees`,
`reuseLaid`, docs/prd-subtree-build.md). Where every change said which
elements it reached (`_buildSeeds`), the tree keeps every box outside
them, and only the subtree of each **rebuild root** — the nearest
in-flow block around a seed whose content the builder can build apart
(`canRebuild`, `subtreeRoot`) — is built again, into the tree where the
old one was, with the document's text, every box's place in it, the
lists and the styles spliced to say what a whole build says. A seed with
no box, new or `display: none` before, is styled where it is and its
style put in, and where it comes out drawn its parent is built, or the end
of its parent from it where nothing around it can be: a menu or a dialog
shown or hidden built the whole document.
A root whose element comes out as no block in the flow of its own — a
caption a class makes absolute, a block turned inline — is placed by its
parent's flow: the build gives up at every such root before it changes
the tree, and starts again from the elements around them all
(`SubtreeRoots.wider`), a few times over (`SUBTREE_WIDENINGS`). Apple's
script makes each slide's caption of a gallery absolute at every step of a
drag, and each built the whole document.
The layout after it keeps a block an earlier layout laid out where
nothing it was laid out from changed (`Laid`), moving it to where the
flow puts it now, with the offsets the passes after the flow put on what
it holds taken off first (`unoffsetHeld`) — and a flex item (`keptNatural`)
or a grid item (`keptItem`) the same way, by what its last layout in its
container was laid out from (`Natural`, `ItemLaid`), under the rule a
block is kept by (`mayKeepLaid`, `keepLaid`): joshwcomeau.com's article is
a grid of a hundred paragraphs in flex boxes, and each sparkle beside one
of them laid every one out again. A probe keeps a flex item's natural
layout as well, a probe's or a layout's, where all of the item was laid
out and it holds nothing out of the flow (`keepsNatural`), and an item
keeps one a width (`NATURAL_WIDTHS`): a webmail page's hidden strip of
2,496 senders was laid out again in every probe of the page, and its
content pane at its widest and its width by turns. **Anything new that
reads a natural layout's geometry asks that its `serial` is the box's**,
since only the latest is the layout the box has. Four rules hold it up. **State
the builder carries across siblings is a root's to bring to a known
value, or a refusal**: a new one goes in the table in the design record.
**Anything new a `BoxTree` lists in document order is spliced in
`buildSubtrees`**, or a subtree build leaves an entry of the old
subtree, or none of the new. A root is in the document's own tree and in no
slot (`inLightTree`), so a change in a shadow tree is built with the host
around it, and a root may hold a host: **anything in the splice that asks
what a root held, or whether an element is still drawn, asks of the flat
tree** — through a host (`connected`), into its tree, and past what it
holds and no slot takes (`outOfFlat`), which keeps a place in the document
and no boxes. **Anything new a block's layout reads from
outside it joins `Laid`** — a flex item's `Natural`, a grid item's
`ItemLaid` — and anything that changes what a box's layout reads calls
`forgetSizes`, which forgets the records with the sizes. And
**anything new a pass after the flow moves boxes by is taken off in
`unoffsetHeld`**, or a block kept is moved by it twice. A block whose
layout reaches outside it — what holds a box placed against something
outside it, or a relative or sticky inline broken around blocks — is laid
out every time (`reuseBlockers`). A sticky box is kept with its block:
where it sticks turns on where the block is, so it is taken off by how far
it was moved (`STUCK`) and worked out again after the flow, where it had
made every box around it a blocker — joshwcomeau.com's code blocks each
hold a copy button stuck to the viewport, and its article's grid laid
half its items out again at every layout. An absolute box placed by nothing
of what it is placed against is no such box (`movesWithFlow`): no inset,
and a size and edges of its own, so a kept block moves it where its own
layout would — a link's `sr-only` label is one, and with it every
paragraph, list and aside around such a link on joshwcomeau.com was laid
out at every layout. **Anything new that places an absolute box from
its containing block keeps it out of `movesWithFlow`.** A box is kept
under another viewport height where the layout that laid it out read none
of it (`LaidUnder`, `heightHolds`): a pane's height is a frame's to
decide, after the document's first layout, and the next layout laid out
again every block, flex item and grid item the first had. So **anything
new a layout reads of the viewport's height sets `readViewportHeight`**,
as `containingRect` does, or a box kept under a new height is laid out as
it was under the old one. A hover's or a focus's build is seeded with
its reach, as a frame's is.
`test/html/subtree-build.test.ts` holds a subtree build and the layout
after it to a whole build, box, line, list and style, over generated
documents; `SUBTREE_SEEDS` sweeps more of them, and `SUBTREE_FROM` starts
at the one that failed, and `MOVING_SEEDS` sweeps documents of sticky,
relative, transformed and scrolled boxes in blocks a layout keeps.

**A probe takes a block it laid out before in the same room for what it
came to then** (`Stand`, `STOOD`): how far down it reached, the margin it
left hanging, and what a walk of it read (`intrinsicWidth`), noted as it
is laid out (`standAfter`) and dropped with its sizes (`forgetSizes`). The
block is not laid out, and is where the last layout put it, so the layout
after the probe keeps it (`reuseLaid`). A webmail page's content pane is
held to its least width, and a spinner coming into its footer had every
message in the list laid out again at no width, at none at all and at the
widths between, and the layout after could keep none of them: 12,672
boxes in the harness where it is some 600. Four things are load-bearing.
**Anything new a walk reads of a block in a flow joins `Stand`**, or a
block that stood answers with less than one laid out. **A layout a block
stood in is partial**, since that block is where another layout put it,
and only a probe keeps one (`LAID_OWN`'s and a flex item's `Natural`'s
`partial`), and a probe that keeps one counts it (`keptPartial`), which
makes the layout around it partial too: **anything new that keeps a box's
layout within a pass refuses a partial one outside a probe**, or a block
is drawn where a probe found it. **A block where a row may wrap stands
for nothing** (`wrapRows`): a walk at the narrowest reads it otherwise.
Nor does a table, which the pass keeps at a width it laid it out at
already (`kept`): standing, it left the layout around it partial, and a
table in a table's cell was laid out again at every level. And **the
shrink-to-fit probe takes none** (`standsOff`): its caller reads the
words of what it laid out (`wordBound`). `PROBE_SEEDS` sweeps more
documents of what a probe measures in `test/html/subtree-build.test.ts`.

**A change a refresh is told of that is lengths alone keeps the boxes,
and its layout repaints what it moved** (`_restyleInPlace`'s `lengths`,
`_layoutOwed`, `_claimLaidOut`). A box's lengths and a flex item's grow
and shrink factors (`LENGTH_FIELDS`, `BOX_LENGTHS`) are taken in place,
and not a text's size, whose `rem`s a build follows; a box laid out
apart from all around it is taken the same way, and goes to a frame's
build (`_rebuildFrame`) only where a restyle in place refuses it. Apple's
hero is an absolute box its script sizes at every step of a scroll, and a
frame's build was six times a layout's cost for it. The
document is laid out at once, and each box's place, size, lines and
marker before it (`_laidShapes`) say which it moved or reshaped
(`reshaped`): their ink before and after, cut to what the pane shows, is
claimed, and the whole element where the document is another size, a box
around a change is drawn through a matrix, or more changed than a few
rects hold. Core's measure of the element, which a layout owed to the
frame asks for, claims all the element shows before and after — so a
layout that knows what it moved does not wait for it. A playground's
divider sets its panes' `flex` at every step of a drag, and each step
built the panes and repainted the whole article in view. **Anything new
a layout can change in how a box is drawn, besides its rect, its lines
and its marker, joins `reshaped`**, or a refresh leaves it drawn as it
was.

**The passes after a layout that keeps blocks walk what they move, and
the walk of the ink keeps the rest's** (`Blockers.moved`, `KEPT_INK` in
`paint.ts`). A box the passes after a flow move, or move what it holds —
a relative box with an inset, a sticky one, a transformed one, a scroll
container (`movesAfterFlow`) — is in `moved` with every box around it,
and `unoffsetHeld`, `applyRelativeOffsets`, `applyScrollOffsets` and
`restickAll` go down it alone. The walk of the ink records, for a block
outside it that it reached from a box inside it, where its border box was
and how far it reached, and a later walk keeps that block's ink where a
layout kept the block or one around it, its border box is where it was,
and no sticky box is around it (`frontierBounds`). With the sticky boxes
kept, a bare layout of joshwcomeau.com's article went from 4 ms to 0.8.
Three things are load-bearing. **Anything new that makes a box one the
passes move joins `movesAfterFlow`, and anything that makes one so in
place calls `noteMoving`**, as a restyle in place does, or a layout that
lays the box out again leaves it where the flow put it. **Anything new
that moves boxes or changes their ink outside a layout walks the tree's
ink whole** (`computePaintBounds` with no `KeptInk`), which makes every
record stale, or a later walk keeps ink of where the boxes were: a sticky
box the pane's scroll places is the one walk of part of it
(`boundsAfterMove`), and why no ink under one is kept. And **a text or a
break carries its element's style and is no box of its own**: no pass
moves it, and no scroll places it (`stickyBlock`). Taken for a sticky
box, a sticky element's text was held where its rect had drifted to, and
the ink around it grown to reach it.

**A stream's chunk is a change the parser tells of, and builds the ends of
what it touched** (`HtmlSource.takeAppended`, `_parsedChanges`,
`ChangeScope.tails`, `tailRoot`, `runTail`, docs/prd-subtree-build.md). The
parser records what a chunk does — the nodes it put in, each at the end of
what holds it, the texts it wrote on to, the attributes a second `<body>`
set — and those are the change records a `refresh` is told, scoped as an
append reaches: the new nodes, `:last-child` and its kin of the children
that were last, every child where a rule counts from the end, `:empty` only
of a holder that held nothing. A holder's boxes then differ from the first
child the chunk touched on, so a **tail** of it is built: its box stays, and
its children after the last block-level box of its own before that child are
built after a stand-in block, as the fix-up has them after it (`ranBefore`,
from the first blocks `RAN_FROM` keeps by the holder), from where that box's
line ended in the text (`textAfterBox`: the text ranges, and past them what
the fix-up dropped from the box). A build apart counts no counter it did not
make (`CounterScopes.detach`), and counts otherwise than it did only where
nothing kept after it reads a quote, or a counter made before it or around
it (`countsAcross`, by the nearest reset of its name) — at the document's
end, nothing does, and an `<ol>` after it makes its own `list-item`: Apple's
footnotes, after a section with a `<ul>` in it, made every change to a
section a build of the whole page. And a root that does what it did to the
counters and the quotes around it (`countedBy`) leaves what comes after it
as it was, whatever it holds: Wikipedia's references are numbered, and a
change to any section with a list in it built the whole article. **Anything
new a box reads of a counter joins `countersOf`, and anything that changes
one joins `countedBy`.** Where every root and tail ends the document, what the build
lists, its text and its styles are spliced at their ends (`atEnd`), the
element keeps its index of first boxes and its reuse blockers
(`carryBlockers`), and the layout after it walks no kept block to take its
offsets off where nothing in the tree is offset (`LayoutContext.offsets`).
Seven rules hold it up. **Anything new the parser does to the tree is
recorded, or marks the record unknown**, as a body taking in what went
before it and a shadow root attached do — a chunk the record cannot say
restyles everything. **State the builder carries across siblings is at a
known value after a block-level box in the flow, or a tail refuses**, as it
does for a root. **Anything new a `BoxTree` lists in document order is
spliced at the end as well as in the middle** (`atEnd`'s branch). **Anything
new a layout keeps on a box that names a place in the document's text moves
with the text** (`shiftLines`, which moves a kept block's lines and their
span maps): a build that lengthens the text before a block a layout keeps
had left its lines pointing at the old text, and an inline box's fragments
were found on no line. A float or a box out of the flow holds the space
before it from its line's end only where it pushed text (`after`'s `held`),
so **a root or a tail in one whose text comes to some, or to none, is
refused where a line may have begun before the box** (`mayFollowSpace`):
the space outside it is another. **A drawing kept from before is
drawn again where a chunk brings an id or writes into a drawing**
(`namesAnew`), since what one names may be what came. And **nothing a tail
needs is noted on every box a build makes**: two fields more on `Box` were a
fiftieth of a document's first paint, and a map with an entry for every
block a fiftieth of every whole build, so what a tail reads is worked out
where it needs it, or kept by the few boxes it is about.
`test/html/subtree-build.test.ts` feeds generated documents and fragments a
chunk at a time, cut inside words, tags and attributes, and holds every step
to the same chunks styled, built and scanned whole; `STREAM_SEEDS` sweeps
more of them, and `STREAM_FROM` starts at one.

**A script's child put in or taken out builds the end of what holds it
too** (`ChangeScope.ends`, `changedFrom`): from the first child it put in,
or what its record says was after what it took out, or past the last,
where the record says where — a tail holds a child, so one past the last
is built from the last (`_subtreeRoots`). A webmail page puts its popups at
the end of its `<body>` and takes them out, and each built the whole
document: 1.1 seconds in the harness where it is 0.1. Three things are
load-bearing. **The end of a flex or grid box is built as a block's is**
(`tailRoot`'s `items`): each of its children is an item of its own, and
nothing of one before a tail is carried to it. **A block's is built from
what every build notes of its wraps** (`RAN_FROM`, `ranBefore`): what ran
before a block, inline-level content and white space a wrap dropped, is
what a tail is fixed up after, and a wrap says it of no box. Noted for a
stream's builds alone, a document handed over whole built the whole page
for every child put in a `<body>` with a wrap in it, which is Apple's. And
**a tail's
styles go before what follows its holder** (`placed`): a script's tail may
hold what it moved there from before, styled where it was, where a
stream's held only what came. The subtree fuzz hands on where its
children came and went half the time, and builds such tails. The root
element's end is built as a block's is, and the fuzz puts children after
the `<body>` and takes them out: Apple's scripts put a probe of the
viewport there at every step of a drag, and `TAILS_REFUSED` had named
`html`, so each built the whole document.

**An image's source is chosen where the viewport is known, and stays
chosen.** An `<img srcset>`, or an `<img>` in a `<picture>`, is chosen in
`_update`, for the width the boxes are about to be built at
(`srcset.ts`), and not as the markup is read: `facts().pictures` keeps
them out of `_sweep`. Two things there are load-bearing. A choice is made
again only when what it turns on moves — the width, the height, the
scale, the scheme — or its attributes change, and never because an image
arrived: `pick` prefers a denser candidate already asked for, as Chrome
prefers one it has cached, so a choice made again on an arrival would
trade one element's image for one another element asked for. And a choice
that changes what an image shows is taken into its box in place
(`_showInPlace`) — the size the source gives at its density, what the
boxes around it measured of it forgotten (`forgetSizes`) — and laid out by
the layout the width's move asks for anyway, which stops where what can be
seen ends: a stale layout would lay out whole. BBC's images are `w`
candidates with a `sizes` in `vw`, so each showed the candidate it showed
at another density at every step of a drag, and the boxes were built for
it. Only a choice that sizes an image by another `<source>` now builds,
keeping every style but that image's. Either way it **leaves `_sizes`
alone**, as a `vw` does: core asks a document
its height at a resize's old width as well as its new one, and a cleared
cache laid it out three times a frame. That is sound because the size a
width comes to is the same whichever candidate it holds — a `w` one is as
wide as `sizes` says, an `x` one its pixels over its density — and an
arrival, which can change it, clears the cache as it always has.

Two more things a choice decides, and each has a rule. **The `<source>` it
took sizes the `<img>`** where it has a `width` or a `height` (HTML's
dimension attribute source), so the cascade asks for it
(`Cascade.dimensionSource`), and an `<img>`'s presentational hints are no
longer a function of its own attributes. That is why the style-sharing key
carries the source's two attributes, and why a choice that takes another
source hands its `<img>` to the build to restyle (`SourceChanges.restyle`)
rather than keeping its style: two images written alike in two pictures
shared one style, and a resize across a `media` kept the old one. Anything
else that makes a hint read past its element joins the key the same way.
**An image whose `sizes` is `auto` is picked after layout**, from its
content width (`chooseLaidOut`), and where that changes what it draws, the
boxes are built and laid out once more, in the same `_update`. That
terminates only because HTML's UA sheet gives such an image `contain: size
!important`, so its width is no candidate's to change. That is also why the
cascade has a UA `!important` origin over the author's
(`Origin.UserAgentImportant`): a page's `img { contain: none }` would let
the second layout move the width the pick was made for. And it is why
layout reads a replaced box's own size through `ownIntrinsic` alone, which
answers the contained one: the flex item's basis and cross size read
`box.intrinsic`, and an auto image in a flex row took its height from the
candidate's ratio.

**An `image-set()` is chosen as the style is computed, and a choice at
another density is not a string.** A cascade is made for one scale, and
its lengths are device pixels already, so `imageSetOf` (`css/style.ts`)
picks an option with `pick` there, and a style computed for another
display is computed again with the choice. A url chosen at 1x is the url,
as `url()` writes it; at any other density it is `{ url, density }`
(`UrlImage`), and the density is its size (`atDensity`). So **anything
that reads a layer's image — a background's, a border image's, a mask's,
a marker's — asks `urlOf`, `densityOf` and `gradientOf`**, and never
`typeof image === 'string'`: that test passes a 2x image over silently,
and its negation took one for a gradient. `decodesImageType` is in
`image-types.ts`, a module that imports nothing, because the cascade asks
it and `resources.ts` reaches the cascade through `svg.ts`. What
`getComputedStyle` answers for `background-image` is none of these: the
choice drops the options, and a gradient its direction as written, so it
is serialized from the layers as they were written
(`backgroundImageText`, `computed.ts`). **Anything new that sets a
background's layers sets that field too**, or a page reads the image the
declaration before it set.

**`zoom` is in every length a style holds, as Blink keeps it.** The
cascade sees the parent at the element's own zoom (`zoomedBy`) and resolves
its units at the display scale times the effective zoom
(`ComputedStyle.effectiveZoom`), so layout and paint read zoomed values and
never ask. Two things are load-bearing. **Anything that turns a CSS pixel
into a device one outside a style's lengths multiplies by the box's
`effectiveZoom` as well as the scale** — an image's natural size, an SVG's
user unit, a frame's mount, a container query's lengths — and anything that
answers a page in CSS pixels from a style divides by both, as
`cssomStyle` does. And **a length a child inherits is rescaled by its own
zoom**: one added to `INHERITED` that holds a length joins `zoomedBy`, or a
zoomed child inherits it at its parent's size.

**A computed colour is sRGB, and keeps what it was written as beside
it.** Every drawing context reads a colour field as `#rrggbb` or `rgba()`,
and the field holds that, whatever it was written in. Where its computed
value is no legacy sRGB colour — an `oklch()`, a mix, a relative colour, a
`none` — the style keeps the colour as written in the field's source
(`colorSource`, `backgroundColorSource`, the borders' and
`outlineColorSource`: `COLOR_SOURCES`), and `getComputedStyle` reads it in
the space CSS Color 4 and 5 keep (`colorFormText`): `color(srgb …)` for a
mix in sRGB, `oklch()` as itself. Tailwind 4's whole palette is `oklch()`
and its opacities `color-mix()`, so a page's theme script reads these.
Three things are load-bearing. **Anything new that writes one of those
fields from a declaration writes its source too** (`keptColorText`, null
for a legacy colour), or the field reads as the colour an earlier rule
gave it. **A source counts only while it reads to its field**
(`liveSource`): an animation or a transition writes the field alone, and
its frames read as `rgb()` rather than as the colour it set out from. And
**nothing that draws reads a source**: the common hex and named colour
keep nothing, and cost two string tests.

**A form is a link it writes itself, and it sends nothing either.**
`onSubmit` is `onLink` for a form: `src/html/form.ts` works out HTML's
entry list, encodes it and resolves the action, and the host decides
whether the request goes anywhere — `examples/browser/` sends it. The pure
half (which controls a form owns, what Enter submits, what a reset puts
back, why a form is invalid) is `form.ts` and is tested with no display;
the widgets, the presses on a `<button>`, a `<label>` or an image button,
the validation message and `autofocus` are `widgets.ts`. Two things there
are load-bearing: typed text lives in `FormState` beside the DOM — the
`value` attribute is the field's default, and a `<textarea>` has none — and
**a widget is keyed by its element, not by where it is.** Keyed by
position, every relayout that moved a field (a stylesheet landing while
someone typed) mounted a new widget, and the focus and the caret went with
the old one. Nor by a count of resets: a reset sets a field's text through
core's `value` setter, since a counter in every key mounted each control in
the document again, and the focus went with the button pressed. **A control whose
state a selector reads tells what it did as a change** (`touch`'s records):
`checked`, `selected`, a `<details>`'s `open`, restyled as any attribute is,
where a tick styled, built and laid out the whole document.

**What happens to a document is told before what it does**
(`onDomEvent`, `dom-events.ts`), and a host's `false` stops it — the seam a
script engine over the DOM stands on, which runs nothing here. Three things
are load-bearing. **Anything new that does something on a user's action
asks first**: a click before a link is followed or a button pressed, a key
before a field types it, a `submit` before the entry list is built — built
before, a handler that filled in a hidden field sent it empty. **A default
that changes state before it is asked about puts it back when it is
cancelled**, as a checkbox's tick and a radio's group do (HTML's
legacy-pre-activation), and only one that went on is an `input` and a
`change`. And **an event is told once, by whoever knows it happened**: the
root's capture phase tells presses, releases and keys before any widget
hears them, the root tells the click on what the document draws, and a
checkbox's, a radio's and a button's widget tell their own as they tick or
press, which the root then leaves alone. The handle's `interactive` reaches
the hooks' state through one object made once and a ref every render sets
(`documentInteraction`), so a host calling it between renders is answered
from the last one.

**A `<link>`'s `load` and `error` are told after the fact, by the element**
(`_tellSheets`, through `onSheet`): `load` once the restyle that reads the
sheet, and everything it imports, has run (`_sheetsInForce`), not when the
sheet arrives, so a theme switcher that takes the old `<link>` out on the
new one's `load` never shows the page under neither. It cannot be the
host's, from `onResource`: the store asks for a URL once, so a `<link>` put
in for a sheet already in — a switcher going back to a theme it showed —
asks for nothing, and was never told. Each is told once an `href`.

**A script the parser met waits for the sheets before it, and `<Html>`
knows which those are** (`scriptsUnblocked`, `_blocksScripts`): HTML's
"style sheet that is blocking scripts". The host's runner waits on the
handle's promise before each such script, and asks with no script for a
deferred one or a module, which waits for every sheet. It does not ask for
an `async` one. A sheet holds a script while it is the parser's
(`madeByParser` while the parse goes on, `_parserSheets` — those of them
there when it ended — after), is before the script, and has a `media`
that holds: one a script put in with the DOM, while the parse waited for
it, holds nothing. A `<link>` holds it until
`_sheetOutcome` answers, the answer its `load` is told from, and a
`<style>` until its imports are in. Run at `onParsed`, a script after a
head's `<link>` read the document while its first rendering was held for
the sheet, and `getComputedStyle` answered nothing. Three things are
load-bearing:

- **`_tellSheets` runs before `_wakeScripts`** in `_lifecycle`, so the
  page hears a sheet's `load` before the script it held runs, as in HTML.
- **It is not `onParsed`'s timing.** Held for the sheets, a head's theme
  script ahead of them would run after the first paint, which it is
  written to precede.
- **A waiter is woken only from `_lifecycle`**, which every layout and
  every settled request reaches — while the parse waits at a script as
  well as once it has ended. Anything new that can let a script go
  without one has to call `_wakeScripts`, or the page's scripts stop where
  they were.

A script ahead of the sheets still runs while the first rendering is held,
and `computedStyle` and `elementRect` answer null there, where a browser
answers from the sheets it has. A forced style while a rendering is held
would close that, and it has to keep the paint held as well.

**The parse yields to the scripts that block it** (`HtmlSource.yields`,
HTML 13.2.6.4.8): a classic script, inline or with a `src` that is neither
`async` nor `defer`, runs where the parser met it, and what it writes with
`document.write` goes into the input stream after it and is parsed there
(`HtmlSource.write`, through `parserWrite` and the host's `write` op). The
runner runs it from `onParserBlocked` and lets the parse go on with
`parserResume` (`ScriptRunner.blocked`); deferred scripts and modules run
once the parse has ended, and an `async` one as soon as its source is here
(`_soon`). It yields only where `useScripts` hands `<Html>` its
`_onParserBlocked`, so a document with scripts off, or a host with an
engine of its own, is parsed whole as it always was, and so is one with no
script that blocks it. What the parse reads on to after a script, and what
a script writes, is recorded as a stream's chunk is (`HtmlSource._recorded`)
and restyles and builds what it reaches (`_parsedOnTo`): Apple's product
pages wait at six scripts in their `<body>`, and the parse going on after
each styled all of the page again. Six things are load-bearing:

- **The parser is handed a piece at a time, each ending with the `>` of a
  `</script`** (`pieceEnd`), and stops after a piece whose end tag closed a
  script `blocksParser` says waits: that is what keeps everything after the
  script out of the tree, since htmlparser2 has no way to stop in the
  middle of a chunk. No `</script` is read across two pieces — a tail that
  may start one waits for more input. **Anything new that writes into the
  parser of a document that yields goes through `_feed`**, or the parse
  reads past the script it should have waited at.
- **The parse waits only at a script the scan hands over.** `blocksParser`
  leaves out a `<template>`'s and, where scripts run, a `<noscript>`'s, as
  `facts()` does, and the runner's `blocked` lets the parse go on for a
  script it runs none of: a script the parse waits at that nothing runs is
  a document whose rest is never drawn. A change to which scripts the scan
  hands over changes `blocksParser` with it.
- **The input stream is what was written ahead of the source, then the
  source** (`_ahead`, `_input`), with the insertion point in the first
  (`_insertion`), so a write copies only what was written. A script the
  written markup closes is `_pending`: the rest of the write, and any later
  one, waits behind it, and it is held next, its writes going in front of
  them.
- **`onParserBlocked` is told as `onParsed` is**: a microtask later, and
  held for the element's first layout (`useParsedOnceLaidOut`), so a head
  script measures a document laid out at its width.
- **What the parser makes once a script has run is the page's to hear,
  and not `<Html>`'s** (`takeMade`, `parserInserted`): a mutation record
  a node, and its custom elements connected, from the handler's `addNode`.
  `<Html>` parsed it and restyles for it itself, so none of it goes
  through `_tell`.
- **A frame's document is parsed whole**, by the page's realm, before its
  scripts run (`adopt`), so a frame's classic scripts still run after its
  parse, in order, and its `document.write` is the fragment the host puts
  after the script. An `async` script queued behind one of them waits for
  that pass, as it always did.

**What the document draws takes the focus through a box mounted over it.**
A link, a `<button>`, a summary or a `tabindex` element is a drawing, and
a drawing takes no focus, so `stops.ts` mounts a **stop** over it — a
`<box>` with no paint and `pointerEvents: 'none'` — which core focuses as
any node, scrolls into view and names to an assistive technology; its
`onFocus` makes the element the document's `:focus` (`setFocus`), as a
text field's widget does. The pure half — what markup is focusable, where
Tab goes from a stop, a widget or a pressed point — is `focus.ts`. Four
things are load-bearing:

- **Only a few stops are mounted** — the first, the last, the one focused
  and its neighbours — because a box per link is a node core walks on every
  hit test and paint. So Tab inside the document is the root's `onKeyDown`,
  in the markup's order, and only running off the end is left to core.
- **Widgets and stops are mounted in the document's order**, since core's
  own cycle, which takes Tab into the document and out of it, goes by tree
  order. The merge is in `index.ts`; the first test in
  `test/html/focus.test.ts` fails without it.
- **Nothing it changes may repaint the document.** An unfocused stop is a
  point (a box of no size damages nothing as it mounts), `watchStops` is in
  `selfDamagedProps`, and the root's `tabIndex` is guessed from the source
  so it does not flip after the first render — each of the three was a
  whole repaint of the document, at load or on every Tab. The stop report
  runs after every restyle in place, a hover's included, so it compares
  without allocating. Core claimed a scroll pane's whole viewport whenever
  it scrolled a focused node into view, scrolled or not, until 2.28.0
  (react-x11#813): a Tab between two links in view repaints their rows
  now, and a test holds it there.
- **A focused stop is not the selection's surface.** Core runs Ctrl+A and
  Ctrl+C on the focused node only, so a stop forwards them to the root's
  `selectAll()` and `selectedText()`.

Two things it changed elsewhere, both extractions rather than copies:

- **`src/richtext/runs.ts`** is new: the per-run decoration painter and the
  bidi-correct selection bands, lifted out of `node.ts` so `<Html>` can draw
  the same decorations against its own line placement. `<richtext>`'s `paint`
  is now a loop over its lines calling them, so the two cannot drift.
  `useLinkClicks` lost its `instanceof RichTextNode` at the same time — it
  asks for `hrefAtPoint` structurally, which also stops the hook importing
  the element.
- **`src/internal/text.ts`** is `src/richtext/internal.ts` promoted, now that
  two directories need the code-point/code-unit conversions. Exactly the
  promotion path "Layout" describes for `src/internal/`.

**Resolving a URL is the component's; fetching one is not.** A host cannot
resolve a `url()` in a linked stylesheet: by the time a background is asked
for it is a computed value, and nothing says which sheet it was written in.
So given `baseUrl` (or an absolute `<base href>`) the component resolves
everything itself — markup against the document's base, a sheet's `url()`s,
`@import`s and `@font-face` sources against the sheet's own URL as it is
parsed (`absoluteUrls`, `css/parse.ts`) — and `onResource` and `onLink` see
absolute URLs. Without a base nothing is resolved, which is what every host
before it saw. `examples/browser/` is the host that does fetch, and the
place a fetching policy belongs: an HTTP cache every tab shares through the
profile, per-host pacing,
`file:` only for `file:` pages, no mixed content (a secure page's
stylesheets and fonts over an insecure connection are blocked and its images
upgraded, as a browser has it), no cookies.

**The browser runs each tab's page in a `<Frame>`, and two things about a
pane are worth knowing before the next example makes one.** A pane is a
real child window on X11, so the pointer decides who gets a key: X hands it
to the deepest window under the pointer, and while that is the page the
browser's handlers never run (core's `<foreign>` documents the gap). The
page watches for the browser's chords and passes them back through a
callback (`examples/browser/keys.ts`) — only where the pane is its own
window, since on Cocoa the host forwards every key and would see a chord
twice. And a pane that is not showing is kept beside the window rather than
under `display: 'none'`: a `<foreign>` in a hidden subtree stays mapped and
is squeezed to one pixel, so the page inside would lay itself out again at
that width on every switch of tab. Both are core's to fix — an embeddable
window that selected no keys, a `<foreign>` that unmapped when hidden — and
the example's workarounds say so where they are. A pane kept aside is held
at the size the window last held still at, not the size it is now: one that
followed the window laid its page out again at every step of a drag, as
often as the tab showing, for pixels nobody sees.

**The browser's tabs share their profile through the file, not through the
browser** (`examples/browser/profile.ts`, docs/prd-browser-profile.md). A
pane's props are fire-and-forget, so nothing could ask the browser's process
for a request's `Cookie` header and wait; every tab's process opens the
profile's SQLite database itself, and a reader reads a table again only
where `PRAGMA data_version` says another connection committed. Two rules
follow. **The browser opens the profile and ends the last session before
any pane starts** (`endSession`), since a pane reads what is there as it
makes its first request; and **a jar reads its store at its first use, not
as it is made**, since an inline page's jar is made as `page.tsx` is
imported, before the browser has tidied anything. The tab's key, which its
`sessionStorage` is kept by across a restart, reaches its process as
`BROWSER_TAB_KEY`, and the directory as `BROWSER_PROFILE_DIR`.

**`<Html scripts>` runs a page's scripts in a context of their own, and
what keeps them there is a few rules** (`src/html/scripts/`,
docs/prd-html-scripts.md). The engine is a `node:vm` context a document —
the example browser's, which runs it behind the toolbar's JS switch, and
which moved here so that a document's scripts are one prop. Each rule
closes a way out a DOM binding opens by accident:

- **The facade is source text.** `installDom` (`dom.ts`) is handed to the
  context by `toString()` and closes over nothing, so every object a page
  touches is the context's. Anything new it needs comes over the bridge as
  an op; an import there is unreachable at run time, and a host object
  handed in has the host's `Function` for its `constructor.constructor`.
- **Only primitives cross.** The bridge answers primitives and a host
  error as a coded string the facade throws as its own `DOMException`; the
  host hands an entry its input as a JSON string through `__in`, a
  non-configurable data property, so no page puts a setter where the host
  writes; and no entry lets a page's exception out, so the host never reads
  a page's object. An op that answered an object would be a way out.
- **The tree changes are `<Html>`'s once a task.** An op marks the host
  dirty; the outermost entry's end refreshes (`settled`), and an op that
  asks the layout anything flushes first, since it has to answer from the
  change.
- **But an inline script a page's script puts in runs inside the op that
  puts it in** (`_prepareScript`, from `_connected`), as a script of its
  own (`exec`), `inert` from then on, with `currentScript` the outer
  script's again once it ends (`outerScripts`). Google's sign-in page puts
  its BotGuard program in a `<script>`, takes it out at once and reads the
  global it made, as jQuery's `globalEval` does: met at `<Html>`'s next
  read of the tree, it never ran. So **anything new that puts nodes into a
  document goes through `_put` or `_replaceAll`**, and **anything new that
  copies a script carries `inert` over** (`_copiedScripts`, HTML's cloning
  steps), or a copy of what `innerHTML` made runs. On Node the context
  runs the microtasks queued so far as the inner script ends, as it does
  for a worker's `importScripts`. One with a `src`, and a module, is handed
  to the runner in the same op (`scriptConnected`), since a script made by
  a script and set `async` false runs in the order it went in
  (`forceAsync`, `inOrder`, `_runInOrder`), and the document's order is
  not that one: Google's module loader puts each module at the top of the
  `<head>`. Met at `<Html>`'s read of the tree, they ran backwards and a
  module ran before the one defining what it needs. **Anything new that
  makes a `<script>` element sets its `forceAsync`**, as `create` and a
  copy do.
- **The page's time is its own code's, counted at the bridge.** The
  runtime's watchdog counts all of an entry and nothing pauses it, so it is
  only the ceiling, five times the page's time; the engine counts the
  page's own with each op's time left out (`ScriptEngine._bridge`), and an
  op asked once it is spent throws a `TimeoutError`. Counted by the
  watchdog, a webmail page's 2.4 s forced layout was cut half way at every
  `getComputedStyle`. So **anything new that calls the host from the page
  goes through the bridge, and anything new that runs the page's code from
  the host goes through `_enter` and `_leave`**, or the clock counts one's
  time as the other's. A cut inside an op still runs no `finally` under it,
  and the host has `<Html>` make the document again
  (`interruptedSince`, `HtmlViewNode.interrupted`): **a flag of `<Html>`'s
  that a `finally` puts back is put back in `interrupted()` too.**
- **Every script compiled into the context has an `import()` callback**,
  rejecting with the context's own `TypeError` (`refuseImport`), the
  facade's installation included: a page's `eval`, `new Function`, string
  timers and `on…` attributes run from inside it, and an `import()` in
  them is found from it. Without one, the runtime refuses an `import()`
  with an error of the host's, and its `constructor.constructor` is the
  host's `Function` — which shipped in phase 1, because the escape test
  checked that `import('fs')` did not resolve and never read what it was
  refused with. Node calls the callback only under
  `--experimental-vm-modules`, so the engine runs nothing without it
  (`SCRIPTS_CONTAINED`), and Node 21 to 23 make the promise `import()`
  hands the page in the host's realm whatever the callback does, so it
  runs nothing there either (`importStaysInPage`). **An escape test reads
  what a refusal hands the page**, and what `import()` hands it, not only
  that it was refused.
- **A page's stacks are its own frames** (`stacks.ts`). Every task is
  entered from the host, and the runtime wrote every frame into an error's
  `stack`: any page read the user's home directory and the install's
  layout off an error it made, and an error logger sent them home. The
  context's `Error.prepareStackTrace` is locked to a formatter that keeps
  the page's frames, drops the facade's and stops at the host's — a
  `node:` module, an entry (`engine:__timer`), a file by its path. Node
  asks the error's global for its `Error`, and a page that replaced
  `window.Error` was handed the call sites, so that binding is locked too;
  Bun's `captureStackTrace` asks no formatter, so it is wrapped there. A
  page sees a native `Error.prepareStackTrace` and a `window.Error` it
  cannot replace, where Chrome has neither. **Code the engine compiles
  into the context is named**: the facade's as `FACADE`, which a stack
  passes over, and an entry as `engine:…`, where the page's stack ends. A
  script with no name is `file:///` on Bun, which reads as the page's.
- **The process's `unhandledRejection` is the engine's** (`watchRejections`).
  Every listener hears every rejection, and core's pane registers one that
  ends the process before the page's module loads, so a page's uncaught
  promise closed its tab though the engine listened too. The engine takes
  the listeners already there off and hands them every rejection that is
  not a page's. A test needs no setting node:test's listener aside: that
  it fails no test is the check.
- **A frame's window holds the page's realm.** `contentWindow` is a
  WindowProxy over the window of the frame's current document, with the
  page's globals as they were before page code ran (`realmGlobals`), since
  scripts take a clean `RegExp` or `fetch` from a hidden frame. What it
  hands out is the page's own, so a script that changes what it took from
  a frame changes the page: a frame's script that is written into it never
  runs (core-js's would empty `Object.prototype`).
- **A custom element's state is the facade's; what happens to it in the
  tree is the host's.** The registry, and each element's state, definition
  and reaction queue by its wrapper (`customOf`), are in the page's realm,
  where its class and its callbacks are. Once a name is defined the host
  notes each element that may be one as it is connected, disconnected,
  adopted, given another attribute value or copied, in any document
  (`_custom…`), and the facade takes the notes after the op that made them
  and runs the reactions (`takeReactions`), before the method returns.
  Once a node has a scoped registry the host also notes every node
  connected, with its document (`_scoped`): a scoped registry's `define()`
  upgrades only in the documents its nodes were connected in, in the order
  each first was (its scoped document set), and that order cannot be
  worked out again later. **Anything new that puts a node into the tree,
  takes one out or changes an attribute goes through `_childList`, `_adopt`
  or `_changed`**, or its custom elements hear nothing of it, and a scoped
  registry's `define()` misses the document. `:defined` is the cascade's
  (`isDefinedElement`), told of an upgrade as a change of `-rx-defined`, an
  attribute no element has.
- **What an `<img>` came to is `<Html>`'s to tell, in the document and out
  of it** (`askImage`, `_watchImage`, `imageState`). `new Image()` is how a
  page preloads and how it tests for a format: Apple's product pages hold
  their whole setup on a `data:image/avif` probe, and with no `load` and no
  `error` they waited out a five-second timer. So an image in no document
  goes through the same `ResourceStore` as one in it, whose `settled` says
  which URL it was (`_imageSettled`, an index by URL, since `_lifecycle`
  runs at every layout and a page of images would walk them all). Three
  things are load-bearing. **Anything new that changes which image an
  `<img>` shows tells `_changed`, or `_imagesMade` for what no attribute
  write sets**, or a page waits for a `load` that never comes; a connected
  `<img>` that chooses its source is chosen in `_update`, so `askImage`
  leaves it owed and `complete` is false until then (`_imagesOwed`). **What
  is told goes through one microtask** (`_tellImage`), which is never inside
  the page's task, keeps the last of two sources set in one task, and runs
  before the one `_lifecycle` tells the window's `load` in. And **`image`
  moves no `opEpoch`**: it is a read, and a page reads `complete` in loops
  between its reads of a computed style. What an image answers before the
  engine is here is kept (`Early.images`), since an `onload` in the markup
  is still to hear it.
- **What a page asks of a media element is the player's, kept by
  element.** `play()`, `pause()`, `muted`, `volume`, `playbackRate` and a
  seek are the facade's state (`mediaAsks`) and one `mediaState` op each;
  `<Html>` keeps them for the element (`setMediaState`), lays them over
  the markup's in each `MediaRect`, and `videos.ts` hands them to core's
  `<video>` as props that tell the player it has — never in the key, which
  would make a new player. Kept by element, so a hidden video a page paused
  is mounted paused, and `paused` is left out until something says, so
  `autoplay` still plays. **Anything new that tells a player what to do
  goes through `setMediaState`**, a press on `controls` included, or the
  next prop a script sets is no change and the player is not told. An
  `<audio>` is the same through `sounds.ts` and core's `<audio>`, mounted
  from the first time it is told it plays until its end (`_sounding`),
  out of the document as much as in it. **What an audio's player says
  comes back** (`soundEvent`, the `__player` entry, `mediaPlayed`): its
  length, its time, its end and its failure are the page's, and the
  model's clock runs at most `PLAYER_AHEAD` past what the player last
  said, so it waits while the player does. A video's player says nothing
  back yet. **Anything new that makes a media element play or stop goes
  through `mediaSync`**, which keeps `playingMedia`: what a document going
  into the back-forward cache pauses besides what is in its tree. **Where the page's
  requests reach a network (`network`, `hasNetwork`), the page loads the
  media itself as far as its metadata**: the host fetches the source
  (`_mediaFetch`), reads its container's head (`scripts/media.ts`) and
  tells the facade the duration, the size and how much has arrived
  (`__media`), and the facade runs HTML's load algorithm, ready states,
  stall timer and clock over that (`mediaLoad`, `mediaReady`,
  `mediaSync`). **The bytes stay host-side**: parsed in the page's realm,
  another origin's would be readable by any page that patched a
  `Uint8Array` method. And `mediaSync` is what tells the host the flags
  `:seeking`, `:buffering` and `:stalled` read, so **anything new that
  changes a media element's paused, network or ready state, its seek or
  its stall calls it**.
- **A module is linked once and evaluated once** (`_linked`, `_evaluated`),
  however many `import()`s wait on it — the runtime allows each only once,
  and two concurrent imports handed a module mid-evaluation read its
  bindings before they were set. **What settles a page's promise from the
  host runs only at the next entry** (`microtaskMode: 'afterEvaluate'`), so
  an `import()` drains the context once it settles (`_drainLater`). And
  **the host never reads what a page threw**: a module's error goes to the
  page through `__thrown` to be reported there, under the timeout.
- **What a page feature-detects or assigns is the IDL's, not the facade's
  reading of it.** A missing interface brings a polyfill: Next.js's
  IntersectionObserver polyfill re-measured every target at every
  mutation, because `IntersectionObserverEntry` was missing. A getter with
  no setter throws in strict code, as `contentEditable` did for
  CodeMirror. A serialization that is close but not exact breaks what a
  page builds on it: `cssText +=` needs the trailing `;`. An attribute is
  an accessor on its interface's prototype, never a field of the
  instance: GitHub's delegated-events takes `currentTarget`'s descriptor
  off `Event.prototype` to shadow it on the event, and found none. The
  global's methods are its interfaces' as well: Shady DOM, which YouTube
  forces, copies `addEventListener` off `EventTarget.prototype` and calls
  the copy on the window, which had its own and inherited none, so the
  global inherits from `Window.prototype` and `EventTarget`'s methods
  know a window when they are called on one (`windowMethods`). A method
  acts on what it is called on, never on the window it was read from:
  YouTube binds a hidden `about:blank` frame's `history.replaceState` to
  the page's `history`, and one that kept its frame's session refused the
  page's URL (`historyOf`). A mixin's members are each interface's own,
  never a class's between it and its parent: ParentNode's `children` was,
  Shady DOM's copy off `Element.prototype` was nothing, and YouTube's
  stamper stamped its masthead twice. **A new mixin is copied onto its
  interfaces**, as ParentNode is after `XMLDocument`. And what no script
  can make is stood in for by what keeps the comparisons a page makes:
  `document.all` is `NaN`, falsy and equal to nothing, since polymer-resin
  passes a falsy value through only where it is not `document.all`, and
  as `undefined` every binding to `undefined` came out "zClosurez". And a
  reflected attribute the facade leaves out is an expando that changes
  nothing: github.blog's menus open by `ariaHidden`, and Google's sign-in
  page sandboxes a frame through `sandbox.supports()`. How a callback is
  called is the IDL's too: a global's `onerror` is handed an error's
  message, file, line, column and error rather than the event
  (`globalError`), and Closure's handler read the event as the message's
  string. Listing the getter-only accessors on the facade's interfaces,
  and checking each against the IDL, is a quick way to find the next one.
  When a stand-in hands its callback what it has counts as well: an
  observer hands every entry it has in one call. Wikipedia's contents pick
  the heading above the top out of all their entries, and an
  `IntersectionObserver` that called back once a target had them mark
  every section in turn, with a layout each, five times a second while the
  article scrolled. A library's
  reading of a standard counts too: css-select reads a query from an
  element as jQuery does, `:scope .a .b`, where the DOM matches the
  selector against the whole document, so `el.querySelectorAll('.a .b')`
  found nothing whose `.a` was above `el`. **A page's selector goes
  through `_query`**, which compiles it as the DOM does and keeps it.
- **An `on…` handler is a listener in the place it was first set in**
  (HTML 8.1.8.1): `activateHandler` puts a slot in the target's
  `_listeners` as it comes to be something, `invoke` runs it there, and
  null takes it out, so a listener added before `onload = f` runs before
  `f`. Run before every listener, an `onloadend` set after a page's
  `addEventListener('loadend', …)` ran first. A content attribute set or
  taken out moves it the same way, and one the parser set has the first
  place, but for a `<body>`'s window-reflecting one made after a head's
  scripts listened, which `__mutated` places as the host says it was
  made. **Anything new that sets a handler goes through `setHandler`**,
  never `_handlers` itself: written there, the handler has no slot and
  runs before every listener, as it used to.
- **What HTML gates on the user's gesture reads the realm's activation.**
  `__event` notes an activation-triggering press or key (`lastActivation`),
  `hasTransientActivation` holds for five seconds after, and
  `consumeActivation` spends it where the spec consumes it, as
  `showPicker()` does: anything new that needs a gesture asks those, never
  `stickyActivation`, which says only that the page was used.
- **What a page waits on settles.** A stand-in that answers and never
  finishes is worse than none: `animate()` handed back an object whose
  `onfinish` was never called, so a menu that hid a panel at the end of its
  fade drew every panel it had opened. An `Animation` keeps its timing and
  its promises and tells `finish` when the timing ends (`liveAnimations`).
- **An animation's state is the spec's, and so is the clock it reads.**
  `Animation` keeps Web Animations' start time, hold time, pending rate
  and pending tasks and runs its procedures step by step, and
  `document.timeline` is read once a task (`taskNow`): WPT's
  `waitForNextFrame` asks for frames until the time moves, and a clock
  read live answered it with no frame at all. A frame runs the resize
  steps, the scroll steps and the media queries' changes
  (`renderingSteps`), updates the scroll-driven animations, then runs
  `requestAnimationFrame`'s callbacks in a task after its microtasks, which
  is where a browser's checkpoint puts a finished promise. **Anything new
  that reads the document's time reads `taskNow`**, and anything a frame
  must do before the page's callbacks goes in `runFrame`'s first half, in
  the order HTML's "update the rendering" has it.
- **Each document a realm runs has a viewport of its own.** The page's is
  its pane; a frame's document with no realm of its own has its frame's
  content box (`viewportFor`), which its window's `innerWidth`,
  `matchMedia`, `visualViewport`, `resize` and animation frame callbacks
  answer for and run in, after the page's in tree order. **Anything new a
  window answers from its viewport reads its `Viewport`**, never the
  page's `viewport()`, and is fired at the window's own target, which its
  listeners hear as the window (`targetWindows`). The steps read every
  viewport they run for from the host once a frame (`rendering`), and the
  host wakes a realm with no frame coming only where what it answered last
  moved, looked at after each paint (`renderingMoved`) — so **anything new
  a media query is answered from joins `mediaEnvironment`**, or a list
  hears no `change` when it moves. A list no listener hears, and a frame's
  viewport nothing watches, is let go (`_heard`, `watched`): a page that
  listens to a list while a component is mounted makes one at each mount.
- **What an animation draws follows the timing the page reads, never
  beside it.** The realm keeps the timing, and tells the host the effect
  and where the animation's time is, as a JSON string and a time, a rate
  and whether it runs, each time either changes (`Animation._report`, the
  `animation` op); `<Html>` samples the frames on its own clock from there
  (`css/scripted.ts`), above the CSS animations. A finished one is held
  where the realm finished it, before `finished` resolves, so a page that
  reads or commits the style in its `onfinish` finds the last frame. So
  **anything new that moves an animation's time — a setter, a method, a
  timer of its own — ends in `_schedule` or `_report`**, or what the page
  reads and what is drawn come apart. An element a script animates styles
  alone (`sharedStyleFor`): two items alike in every attribute share a
  style, and the one faded in took its twin's at the next build. And it
  is never lifted onto a layer (`liftOf`): a layer's frames are sampled
  ahead, which a seek, a pause or a cancel from the page can take back at
  any time.
- **A scroll timeline's time is the last frame's, on both sides of the
  bridge.** The realm's `ScrollTimeline` and `ViewTimeline` are measured
  as they are made and again at each `runFrame` (`snapTimelines`), and a
  page reads that until the next; the cascade's style asked for between
  frames — a `getComputedStyle` after a page sought a scroll-driven CSS
  animation — reads the timeline its element was last styled with
  (`AnimationTimeline.heldProgress`). **Anything new that reads a scroll
  timeline's geometry in the realm reads `_snapshot()`**, and anything
  that forks the timeline for a style between frames hands the fork
  `heldProgress`, or a page that scrolls and reads in one task reads the
  new scroll, which WPT's sampling tests hold to the old. And a CSS
  animation on a scroll's timeline keeps its time apart from the clock's
  (`ScrollRun`): what a page does to one reaches it through
  `CSSAnimation._tellScrolled` (`seekScrolled`), held, started or aligned,
  and a view timeline's subject is placed by `_viewPlace` alone, which
  holds its `auto` insets and its sticky reach.
- **A page's geometry is in two places, and a read takes the one its
  attribute names.** `getBoundingClientRect` is `elementRect`, drawn
  through every transform and moved by every scroll, a box fixed to the
  viewport and what is in it moved where the pane's scroll draws them
  (`_moveToViewport`), as paint and the hit test move them; a header fixed
  `top: 30px` read -470 on a page scrolled 500px. And for the offsets the
  pane has now: a `scrollTo` moves them at once and `abs` at the next
  pass, so a page that measures straight after its own read -470 again.
  `elementRect` and `elementAt` measure from `_scrolledOrigin` — `abs`
  moved by the scroll since a pass placed it, noted where core calls the
  element only after one, its paint and the blit's `viewportFixedRects`.
  **Anything new that answers a page in `elementRect`'s coordinates
  measures from it**, and what core asks — paint, damage, the cursor, the
  text accessors — keeps `abs`, as core's own nodes do until the pass.
  So a rect cannot say whether a scroll moves its box, and what scrolls
  for an element asks, through `HandleInternals` (which
  `useHtmlHandle`'s handle has and `HtmlHandle` does not declare):
  `atViewport` of the viewport, and `scrollMoves`, the rule
  `applyScrollOffsets` moves boxes by, of each scroll container.
  `scrollIntoView` scrolled the page 30px on for that header, and a list
  300px for a box absolute in a `position: relative` wrapper around it,
  where Chrome scrolls neither: no scroll moves a box positioned against
  something outside it. The sticky boxes the viewport holds are placed
  from `_scrolledOrigin` whoever asks, core included (`_followViewport`),
  since they are one placement and not one per asker: placed from `abs`,
  a header held at `top: 0` read -492, and placed for the next pass when
  a page asks and for the last when core does, a hover between a page's
  `scrollTo` and its pass would move them back and forth. So until that
  pass, a point core asks about finds a held box where the pass will draw
  it. `offsetLeft` and its
  kin are `offsetRect`, where layout put the box before either, from the
  offset parent's padding edge. Primer's `<Tabs>` slides a pill under a
  tab in a strip that scrolls by its `offsetLeft`, and the document's x
  answered for it put the pill as far past its tab as the strip is from
  the page's edge. A custom property's name keeps
  its case wherever the facade carries one: `el.style` lowercased
  `--brand-Tabs-slider-width`, a property Primer's sheet never reads, and
  the pill came out as wide as its borders.
- **An `IntersectionObserver` is measured by the host, and asked again
  after each paint.** Each frame hands the host every observer's root and
  targets in one op (`intersections`, `HtmlViewNode.intersectionsOf`),
  which measures them in `elementRect`'s coordinates — each target's
  bounding box, and what the boxes around it leave of that as far as the
  root (`intersectionClips`) — and the facade does the rest of 3.2.8: the
  root margin, the ratio, the thresholds, the entries. Nothing tells the
  realm that a layout, a scroll inside the document or an image's arrival
  moved a target, so the host asks the last frame's question again after
  each paint and wakes a frame where the answer moved
  (`DomHost.renderingMoved`); **a frame with no target left says so with
  an empty query**, or the host measures after every paint for good. And
  **an observer's targets are measured together**, the layout and the
  viewport's follow once for all of them: once a target, that was most of
  a measurement. It had been a stand-in that reported each target once,
  whole, and joshwcomeau.com's header, which hears that it is stuck from
  an observer with `rootMargin: "-1px 0px 0px 0px"` and a threshold of 1,
  never put its glass on.
- **A `ResizeObserver` measures only where the boxes moved.** Its look,
  a tenth of a second after the last, first asks the host what the boxes
  were laid out and scrolled as (`geometry`, `HtmlViewNode.geometryKey`):
  a key that moves with every invalidation, layout, restyle in place,
  frame and scroll of a box (`_geometry`), with the pane's scroll and the
  element's size, and is new at each ask while a change waits to be laid
  out. A look that finds the key as the last left it measures nothing,
  but for a target observed since. **Anything new that moves a box
  without going through one of those bumps `_geometry`**, or an observer
  is not told the size its target came to. Measured at every look, a
  webmail page's observers were most of what it cost at rest: 6 to 8% of
  a core, where it is 1 to 3.
- **The facade runs in the page's realm, so its own work calls what a page
  replaced, and an op that only reads moves no count.** `opEpoch` counts
  the ops that may change a computed style (`getComputedStyle`'s cache) or
  the document a frame holds (`frameDocumentOf`'s): a read — `computed`,
  `customProperty`, `frameDocument` — leaves it, or a page that reads
  between two reads of a style has the whole style read again. And a
  builtin the facade calls on a path a page runs in a loop is one the page
  may have put its own hand in: the Guardian's ad wrapper replaces
  `String.prototype.replace` and reads every frame's window from it, and
  `getComputedStyle` made each property's name with `replace`, so each read
  of a style ran the wrapper hundreds of times, each frame read moved the
  count, and the next read read the style again — 17.7 million ops in a
  load. **Anything new on such a path keeps what it works out** (`camel`
  does) rather than asking the page's builtins again.
- **Nothing the runtime settles from a task of its own may be a page's
  promise.** The context runs its microtasks only when the engine enters
  it (`afterEvaluate`), so a promise V8 resolves from a platform task —
  WebAssembly's asynchronous compile — is heard at the page's next timer,
  or never. The facade compiles a module at once, in the promise, and
  replaces the streaming forms, which on Node are the host's and refuse a
  page's `Response` with an error of the host's realm: a way out of the
  context, which the escape test reads.
- **A canvas's pixels are the page realm's** (`CanvasState` in `dom.ts`),
  and the host is told what changed once a task (`markCanvas`,
  `canvasPut`). Anything new that draws on a canvas marks the rectangle it
  changed, or the browser shows the canvas as it was. Paths are
  rasterized there too (`raster.ts`, source text handed to `installDom`
  as `webgl.ts` is), since a host context reads back a round trip late.
  `<Html>` draws the pixels in the canvas's box (`canvasImage`), in its
  place in the paint order, where a mount over the document had to be
  refused wherever anything was painted over it: up.com.au's logo, fixed
  over the top of its mascot's canvas, hid all of it. An `OffscreenCanvas`
  holds a `CanvasState` too, through the same 2d context code — its
  context's prototype is the canvas context's copied, so it is no
  `CanvasRenderingContext2D`, as in a browser — and its rectangles go to
  the `<canvas>` that handed it its control (`transferControlToOffscreen`):
  this realm's, or across the thread it was transferred over, as a frame,
  `{ k, s, d }`, that the realm with the placeholder puts (`canvasRoutes`,
  `canvasFrame`). **Anything new that can make a canvas's bitmap show or
  stop showing answers in `canvasShown`**, which `markCanvas` asks first:
  a canvas nothing shows marks nothing, and a placeholder's own bitmap
  must never reach the host over the frames of the canvas it gave its
  control to. A bitmap as a file is a PNG the host makes (`encodeImage`,
  `png.ts`, over node's zlib), whatever type was asked for.
- **A WebGL context answers and draws nothing** (`webgl.ts`, source text
  handed to `installDom`). Chrome has WebGL wherever it has a canvas, in
  software where there is no GPU, so a null context is a page that
  crashes — up.com.au's react-three-fiber scene took React's whole tree
  down with it — where a context that keeps state and draws nothing is a
  page with an empty box. What a context answers is Chrome's: its
  constants and limits, its version strings, a value read back as the
  typed array Chrome hands back; an answer that a real context could not
  give sends a page down a path no browser takes.
- **A worker is a thread, and a string is all that reaches it.** Each
  `Worker` is a `worker_threads` thread with an engine, a host over an
  empty document and the facade made a worker's global
  (`__becomeWorker`); a message is serialized where it is posted
  (`serializeClone`) and made again where it lands. The thread's network
  is the page process's, and `importScripts` waits for its answer on a
  shared word (`Atomics.wait`, `receiveMessageOnPort`), which blocks the
  worker and never the page. A `SharedWorker` is the same thread, one for
  a script and a name, and each connection to it a `MessagePort` at
  either end whose other side is a stand-in that sends across
  (`wirePort`): its messages share the thread's one channel tagged with
  the connection, `{ c, d }`, and the first is `{ c, connect }`. **Anything
  new that crosses to a worker goes over that channel**, tagged where it
  is a shared worker's, or a connection hears another's messages. A port
  a message transfers there is a wire over the same channel (`wireEnd`,
  `{ q, d }`), and over another realm of the page, its `__wire`: **anything
  new that posts across a thread or a realm hands `serializeClone` what
  its list transfers (`transfersOf`: the ports, the `OffscreenCanvas`es
  and the `ImageBitmap`s) and runs its `later` after the send**, or a
  port in it is a `DataCloneError`, and what was queued for one arrives
  before the port does. A port's `_deliver` is handed all of what a
  message moved, not its ports alone, so a canvas a port's message moves
  crosses a wire with it; **anything that makes a message event of it
  takes the ports out first**.
- **Another origin's frame is linked as another origin.** Its realm and
  the page's hand each other their globals, as same-origin frames do, and
  the facade keeps what either reaches to what crosses origins
  (`crossLinked`, the cross-origin `parent`): a cross-origin frame's global
  never answers a property read from the other realm. `postMessage`'s
  `targetOrigin` is held to the window posted to (`__origin`), which is
  not the sender's once two origins are linked.
- **A document that goes is unloaded first, whatever replaces it.** The
  page's runner unloads its document as it is disposed (`__unload`), after
  its frames' realms; a frame's document in the page's realm unloads as
  the host puts another in its place, while the frame still shows it, or as
  the task that took the frame out of the document ends
  (`_unloadFrameDocument`) — never from inside an op, since what it tells
  runs the page's listeners. And a navigation to another document asks the
  one it leaves first, after its `navigate` (`unloadAllowed`). **Anything
  new that swaps a frame's document, drops a runner or hands the host a
  navigation goes through these**, or a page never hears its `pagehide`,
  and its window's `navigation` answers for a document that is gone.
- **A tab's session is the host's object, and the engine keeps it**
  (`HtmlSessionHistory`, `scripts/session.ts`). The page's realm holds a
  copy of every entry, its own and the other documents', and writes the
  list back at each change (`persist`, `sessionWrite`); a navigation to
  another document is planned there before the host's seam is called
  (`planAway`), and the next document shown with the session takes the
  plan as it starts (`arriveAt`, in `useScripts`'s `start`), which is also
  where the document shown before it is told where it goes and goes — its
  `pageswap`, then its unload — whichever `<Html>` it was in. **Anything new
  that changes an entry of the page's session — a field, the list, the
  index — ends in `persist`, and anything new that leaves for another
  document calls `planAway` before the host hears of it**, or the next
  document is shown at the wrong entry, with another's states. Only the
  document shown last may write (`shown`): one that goes runs its listeners
  after the next is in. And **the Navigation API's entries are a slice of
  the session, never `s.entries`** (`navEntriesOf`: the run around the
  current entry of its origin) — an index, a key looked up, `canGoBack`,
  `back()` — while `history` counts and steps through all of them; with no
  session the two are one list, which is why every test of a document's
  own history passed either way. **A host follows the session, and a
  document with no scripts is the host's to show it**: `onChange` tells a
  host each change a microtask after it (`changed`, in `session.ts`), which
  is how the example browser's address bar follows a single-page app's
  `pushState` and its Back goes back one route rather than off the site,
  and `show()` and `fragment()` are what an engine does for a document
  shown with JavaScript off, which the browser's switch makes most of them.
  So **anything new in `session.ts` that changes the entries or the index
  calls `changed`**, or the host draws the history as it was; and the
  browser's history is the page process's session mirrored
  (`PageProps.onHistory`), never a second list kept beside it — that list,
  stepped by the browser alone, was the bug.
- **A document in the back-forward cache is frozen at its engine, and its
  `<Html>` is the host's to keep** (`backForwardCache`, `swapOut` and
  `reactivate` in `session.ts`, `ScriptRunner.freeze`). The context runs
  only as the host enters it, so `ScriptEngine.freeze` holds the whole
  realm by holding what the host asks — `call`, `exec`, `module`,
  `rejected` — and `thaw` runs the reactivation's own entry before what
  waited, in order. **Anything new that enters a page's context goes
  through one of those**, never `runInContext` itself, or it runs in a
  document nobody can see; and an entry joins `HELD_ONCE` only where it
  says that something is due, never where it carries what happened — a
  message held once is a message lost. The session decides whether to
  keep a document (an entry is still of it, and it is no reload), the
  runner whether it may go (`salvageable`: loaded, and nothing open a peer
  would see held — `DomHost.connected`), so **anything new that holds a
  connection open answers `open` and joins `connected`**. A page that
  listens for `unload` is kept and never hears it, as HTML, Chrome and
  Safari have it. A kept document shown again re-reads the session
  (`reseedSession`), keeping its own entries' `NavigationHistoryEntry`
  objects — WPT holds `currentEntry` to the one a script kept — and
  disposing the rest in a task after `pageshow`. A step to a kept document
  is taken a microtask later, since a page's `history.back()` reaches
  `session.go` from inside its own entry. The DOM, the layout and what was
  typed are the `<Html>`'s, so a host keeps a kept document's `<Html>`
  mounted and hidden and shows the one the current entry is of — the
  runner's `follow` is the worked example, and two of its rules came from
  bugs: **the host's documents are one state, changed by updaters**, since
  `onChange` can fire before React has drawn the document the host just
  added; and **a document is unmounted only once the one taking its place
  is in**, or it unloads before the session could keep it. The example
  browser's `page.tsx` is the same `follow` with a third rule, for a host
  whose navigations overlap: **a document on its way in that another
  overtakes goes at once**, and so does the one a reload makes again, or
  it comes into the session after the document that overtook it — which is
  why the browser numbers a document only as it comes in, never ahead.
- **A page's streams are the standard's, and none of their state is the
  page's** (`streams.ts`, source text as `dom.ts` is). Every abstract
  operation of WHATWG Streams is there, over slots kept in a `WeakMap` by
  the public object, and the promise and array methods they call are taken
  before page code runs. So **anything new that makes or drives a stream
  goes through `StreamsInternals`** — `readable`, `readableBytes`,
  `writable`, `controllerOf`, `errorReadable`, `errorWritable`,
  `writableSignal` — never through a field of the object, and a subclass
  (WebTransport's send and receive streams) is made with `INTERNAL` and set
  up by them. A byte stream a source closes answers a pending BYOB read
  with `respond(0)` after `close()`, or the reader waits for ever
  (`closeBytes` in `webtransport.ts`). WPT's `streams/` is the check: run
  it after a change, through `scripts/conformance/testharness.tsx` and a
  list.
- **WebTransport's network is a seam whose default opens nothing**
  (`HtmlScripts.webTransport`, `NO_WEBTRANSPORT`, `src/html/transport.ts`).
  The page's API is the facade's (`webtransport.ts`); the host's half is
  the `wt…` ops and `__wt…` entries (`transports.ts`), where a session and a
  stream are numbers and bytes are base64. **A stream's bytes are pulled**,
  `wtRead` answered from the seam's buffer and `__wtReadable` waited for, so
  a page that reads nothing leaves its bytes in the seam, which is what
  holds the peer back. **A session's fate is told, never asked**: `ready`,
  `failed`, `closed`, `draining`, a datagram, an incoming stream, and a
  stream's `readable`, `end`, `reset` and `stopSending` — the shape a proxy
  across a worker's thread carries and a fake server drives
  (`test/fake-transport.ts`). Anything new the page can ask of a session
  either is an event or answers from what the seam has at once; a seam
  method that blocked on the network could not be proxied. What a page is
  handed — every rejection, every `WebTransportError`, every stats object
  — is made in its realm, and the escape test reads what a refused
  session's `ready` rejects with. A worker's sessions are the page's seam's
  too, carried across its thread as plain data (`TransportProxy` in the
  thread, `TransportRelay` in the page process, `transport-relay.ts`):
  **anything new on the seam is added to both and to the `wt` messages**,
  or a worker's realm has a member that never answers. A session is held
  to the document's `connect-src` before the seam is asked
  (`connectAllowed`, `src/html/csp.ts`), its policies noted as a `<meta>`
  goes into the head (`_noteCsp`, from `_childList`) and kept after it
  goes: **anything new that opens a connection from a page asks
  `connectAllowed` first**, which is where `fetch` would join it.
- **A page's WebSocket is the standard's state over a seam that opens
  nothing by default** (`websocket.ts` in the page, `sockets.ts` on the
  host, `HtmlScripts.webSocket`, `NO_WEBSOCKET`, `src/html/socket.ts`). The
  ops are `ws…` and the entries `__ws…`, which no other op starts with; a
  socket is a number and a binary message base64. **What the page reads is
  kept in the realm** — `readyState`, `bufferedAmount`, `protocol` — and the
  host tells it what moved (`__wsOpen`, `__wsMessage`, `__wsSent`,
  `__wsClosed`): nothing is asked across the bridge. A seam answers how many
  bytes wait (`bufferedAmount()`), not when they go, so `SendWatch` asks it a
  task after a send and while some wait. **A seam's `failed` is the page's
  `error` and `close` of 1006**, every failure alike, and anything new the
  host refuses — a bad port, mixed content, `connect-src` — goes through
  `_fail`, before the seam is asked. **A seam that answers while it is
  asked is told a task later** (`PageSockets._tell`, `_inOp`), or the page
  hears `open` inside the constructor that has not returned. A worker's
  sockets cross its thread as a `SocketProxy` and a `SocketRelay`
  (`socket-relay.ts`, `{ kind: 'ws' }`), and a worker's open socket keeps
  its page out of the back-forward cache through `PageWorkers.connected`,
  as the page's own does through `DomHost.connected`.
  `HtmlNetwork.webSockets(page)` is the runtime's `WebSocket`, whose
  constructor takes `{ protocols, headers }` on Node 22 and later and on
  Bun, so the handshake carries the opener's `Origin`, the network's
  `User-Agent` and the jar's cookies; the `Set-Cookie` it is answered with
  is read only where undici publishes it (`undici:websocket:open`, Node 24
  and later), and stored before the page hears `open`. **Anything new the
  adapter tells waits behind `open`** (`held`), since the cookie is stored
  a microtask after the runtime's `open` event. **And an `error` is the
  socket's end**, told as `failed` there, whatever `close` comes after it:
  Node 22's undici fires none after a refused handshake, and a socket that
  waited for one hung in CONNECTING.
- **A page's WebRTC is the realm's semantics over the seam's protocol**
  (`webrtc.ts`, `datachannel.ts` and `mediastream.ts` in the page;
  `peers.ts` and `media-sources.ts` on the host; `HtmlScripts.webRTC` and
  `mediaDevices`; docs/prd-webrtc.md). **What WebRTC 1.0 works out from
  state the realm has is worked out in the realm**: the connection's ICE,
  connection and gathering states from its transports', whether
  negotiation is needed, a description's `track` events, what a rollback
  takes back. A stack answers a description with state
  (`RTCSessionState`) and tells a transport's state whole, so the realm
  never forwards one of its events. **What a connection tells while one of
  its descriptions is applied waits for that operation's answer**
  (`PagePeers._event`): a stack gathers while `setLocalDescription` is
  under way, and the page hears its candidates after the promise, so
  anything new a connection tells goes through `_event`. **Where werift
  says what a browser would not, one side corrects it and the PRD's table
  says which** ("Where werift differs, case by case"): the protocol in the
  adapter (`werift.ts`), the API in the facade. A werift release that
  fixes one retires the correction, as quico 0.8.0 retired quico's. The
  ops are `rtc…` and `md…`, which no other op starts with. Data channels
  are `datachannel.ts`, candidates, transports and stats
  `rtc-transports.ts`, and tracks `mediastream.ts`, each source text of its
  own, so that workstreams 2 and 3 build there and not in the connection. `rtc-transports.ts` is installed by
  `installWebRTC` with its own helpers and slots, since a sender's
  `transport` is one of its objects, where the other two are `installDom`'s;
  on the host, `werift-transports.ts` is the adapter's half of the same
  line. **A data channel handed to a worker stays the page process's**: the
  channel is the seam's, so a worker's realm makes one of its own for the
  host's number (`adopt`), what it asks crosses the thread as a
  `ChannelRelay` that `PagePeers` does, and what becomes of the channel goes
  back the same way, held until the worker has made its own. **Anything new a
  worker can ask of a channel is a `ChannelRelay` op**, done in
  `PagePeers.fromWorker`, or the worker's channel has a member that does
  nothing.
- **Web Audio is the whole API, and silent** (`webaudio.ts`). A page that
  finds `AudioContext` uses all of it, so every node Web Audio 1 has a
  factory for is there with its parameters, automation and errors, where
  a partial context would send a page that worked without one down a
  path that throws. Nothing is heard and nothing is processed but what a
  `MediaStreamAudioDestinationNode`'s track renders, and that is the host's
  synth (`media-sources.ts`), told the oscillators and constant sources
  that reach the destination through gains (`feeding`). **Anything new a
  destination should render joins `feeding` and the synth's voices**, or
  its track is silent with nothing failing. A node is kept by what it is
  connected to (`inputs`), never by its context, since a page makes one a
  note.
- **`MediaSource` is the API with no type behind it** (`mse.ts`). What
  plays a page's media is a player that opens a URL, and nothing hands it
  bytes a page appended, so `isTypeSupported` says no to every type: hls.js
  asks it first, and goes on to `canPlayType` and the playlist as the
  `src`, which the player plays. **Anything that makes it say yes feeds a
  player first**, or every HLS stream goes from a player that plays it to a
  buffer nothing reads. The API still has to be there, since Apple's
  product pages make a `MediaSource` in every browser but Safari without
  asking: it opens on its element, `addSourceBuffer` throws
  `NotSupportedError`, and the stream's end fails the element, which is
  the path such a page has for a type it cannot decode. A `MediaSource`'s
  URLs are kept apart from the blobs' (`mediaSourceUrls`), since a `fetch`
  finds nothing behind one, and an element goes through the load algorithm
  for one with no network, or a page waits for a `sourceopen` that never
  comes.
- **What a page stores goes through the host's storage, and a change is
  told.** `localStorage` and `sessionStorage` are one op, `storage`, over
  `HtmlStorage`'s areas (`DomHost._storage`), which tells
  `HtmlStorage.tell` of each change that changed something; every host
  watches the storage and hands another document's change to its realm as
  a `StorageEvent` (`__storage`). Anything new that writes an area goes
  through `_storage`, or no other document hears of it. `document.cookie`
  and `cookieStore` are the `cookie` op, which names the document's
  address — **held to the realm's origin in the host**, since a page can
  set anything the facade reads off a document.
- **IndexedDB is the realm's, and a profile is its disk.** Where the host
  keeps databases (`idb on`), a transaction's difference is taken at its
  commit against the copy of each store it kept to undo itself
  (`_before`, `idbDiff`): a record changed is a record whose value is
  another object. So **a record is replaced, never changed in place** — a
  new op that wrote into a record's value would be missed by the diff, and
  lost at the next restart. A database another document committed to is
  read again as a transaction starts (`idbRefresh`), never while one of the
  realm's is under way (`active`), and nothing of it runs where the host
  keeps none, which is what holds the Interop area where it was.
- **Run it on Bun too.** `test/html/scripts.test.ts` runs on Node, and
  Bun's `vm` differs in ways no probe found until the whole browser ran
  there: its `DONT_CONTEXTIFY` context drops a script's `var`s, its
  `console` cannot be replaced, and its error stacks have no message line.
  The engine feature-detects the first; a change to the engine is checked
  by running the browser under `bun` before it is believed.

**The engine is half lazy, and the line between the halves is a rule.**
`<Html>` imports `scripts/scripted.ts` and `scripts/hook.ts` whether or not a
document runs scripts, so those two hold the props, the defaults and the
buffering and nothing heavy; everything else — the engine, the DOM facade,
the runner, the workers, the frames — is `scripts/runtime.ts`'s chunk,
reached by one dynamic `import()` (`loadScriptRuntime`), and
`test/treeshake.test.ts` fails if `<Html>` alone reaches it. **A light
module imports a heavy one by `import type` only.** What `<Html>` reports
before the chunk is in — the document, its scripts, the end of its parse,
its `load` — is kept and handed to the runner in that order, and the
parse's scripts wait for the element's first layout, since a document
mounted with its source is parsed before core has laid anything out.
`<Html>` holds `onParsed` for it (`parsed.ts`), and `onLoaded` behind it,
until core's `onLayout` says the element was laid out, so every host waits,
a frame's view included. **Wait for the layout, never for a count of turns**: the frame is
the window's clock, a vertical blank away where the display paces it, and
the eight `setImmediate`s the parse once waited were spent in a millisecond
of it, so on an X server a page's first scripts measured a document laid
out at one pixel, with `innerWidth` 0. Three more things:

- **The engine's Node is written out** (`scripts/platform.ts`): `node:vm`,
  `node:util` and `node:worker_threads` are loaded with a specifier the
  compiler cannot see, at the top of the module that needs them — top-level
  `await`, which only the lazy chunk has — and the globals each module
  uses are `declare const` in that module, never in a declaration file,
  which would declare them for every component the build compiles.
- **`dom.ts`, `raster.ts` and `webgl.ts` declare page globals, not host
  ones**: they run in the page's context by `toString()`, so a
  `queueMicrotask` or a `DOMException` there is the context's, and an
  import of a helper is unreachable at run time.
- **A worker's entry is found beside the module that starts it**, as
  `worker-thread.js` in `dist/` and `worker-thread.ts` in the source the
  suite runs (`workers.ts`'s `ENTRY`); a bundler that moves the engine has
  to carry that file with it.

**A frame a page's scripts load as HTML is drawn over its box, and one
with a script in it runs in a realm of its own, which is the frame's**
(`src/html/scripts/frames.ts`).
Each realm is a host and an engine over one tree of nodes (`DomShared`),
and the page's engine and the frame's are linked (`ScriptEngine.link`): the
page's `contentWindow` is the frame's global and the frame's `parent` the
page's, so a message, an object and a function cross between them as they
do between a browser's frames, and nothing crosses to the host that did
not before. Three things are load-bearing:

- **The realm outlives the view.** A frame's `<Html>` is mounted where the
  page lays its box out (`renderEmbedded`) and goes where it stops — a
  `display: none`, a layout that set it aside — and a frame with no box is
  run in a holder that draws nothing (`FrameHolder`). So the page's runner
  keeps the frame's, by document (`FrameSeat`), and a view only lends it
  its seams and its handle: a view made again finds the realm it ran in,
  and a script the parser met runs once, whichever view met it (`inert`,
  HTML's "already started"). Made by the view, the realm was made again
  each time a frame was shown, and a page that kept a frame hidden until
  it was ready lost everything the frame had set up.
- **Only a document loaded as HTML with a script in it has a realm**
  (`DomShared.realms`). A frame's first `about:blank`, what a script writes
  into one and a document with no script are the page realm's: a page
  reaches into them at once, and a realm answers only once React has
  mounted its view. Acid3 drives its static frames from the page that way,
  and with a realm each it scored 92 where it scores 96. Such a frame is
  drawn, and told of what the page's scripts change in it, and runs nothing
  of its own.
- **A change is told to the `<Html>` that draws its document, whichever
  realm made it** (`_tell`, `DomShared.changes`). What a realm's
  `MutationObserver` sees is still only what that realm changed. A change
  to a node in no document is told to none: the change that puts it in is
  told with all it holds. Told, the records of a webmail page building
  thirty messages apart passed what a change is told as (`CHANGES_TOLD`),
  and every page of messages styled the whole document again.

**A document's fonts are registered under names nothing else has.**
`@font-face` faces go through `onResource` as `kind: 'font'` and into
react-x11's font manager with `loadFont` — the application's manager, so
`fonts.ts` registers each family as `html webfont <letters>`, keyed by its
files, weights and range, and rewrites the cascade's `font-family` lists to
it. A page's `Inter` must not change what `Inter` means to the window around
it, and two sites' `Icons` are two fonts. A face loads when a computed style
wants it and the document has a character in its `unicode-range`, and its
family is out of the list until then: the list changing is what tells every
cache keyed by a family string — the text layouts', the metrics', ntk's —
to set the text again. **No name a document declares reaches a text engine
as written**, whether or not a face of it ever loads (CSS Fonts 4, 5.2): an
engine answers a family nobody has with its nearest guess, and fontconfig's
for next/font's `"GeistSans Fallback"` — `src: local("Arial")`, a rule that
was dropped for having no `url()` — was Gill Sans Ultra Bold. A `local()`
is a source like any other, and comes to an alias: the system's family goes
into the list where the document's was, found by asking for a match and
believing it only when the face that comes back carries the name
(`localFamily`), since a font manager has no lookup to ask.

**A face is asked for an instance before it is registered.** ntk sets a
variable face at the weight and the size a style asks for by cutting an
instance out of it inside `match`, and fontkit cut none out of a WOFF or a
WOFF2: the throw came out of the first layout in the family, and
nextjs.org's blog, in Geist, was left blank. `refusal` (`fonts.ts`) asks the
opened face for the instance a layout would, at the far end of `wght` and
`opsz`, and a face that throws is a source that did not load — the next is
tried, and the family stays out of the list. Before registering, not after:
nothing is ever unregistered, and a refused face left under its group's
name is matched by weight ahead of a sibling that loaded later. And only an
engine whose own faces have `variation` is asked, since the face core opens
on Cocoa is fontkit's and CoreText draws the axis itself. The fix proper is
fontkit's (windowkit/fontkit#1), and the check asks rather than knows, so
it passes the day the engine can.

**A WOFF2 the engine turns down is offered again as the font inside it.**
The web serves a font as WOFF2 and as little else, and CoreText reads no
such container: core's `loadFont` throws for one on macOS, so a page's
fonts were never set there. `src/html/woff2.ts` rebuilds the sfnt — the
tables out of their Brotli stream, through node's `zlib` reached the way
`src/embed/host.ts` reaches `child_process`, and `glyf`, `loca` and `hmtx`
put back from the form the format stores them in — and `_register` offers
it only after the file as served was refused. Nothing asks which engine it
is, which is why the same path hands an ntk whose fontkit cuts no instance
out of a WOFF2 the TrueType it can cut, and Geist is set on X11 too. The
decoder is held to the TrueType each of KaTeX's WOFF2s ships beside, glyph
by glyph, and to a fixture with the two transforms theirs do not use.

How it was found is the part to keep. The report was a regression: "set in
Geist before #465, in Arial after". It had never been Geist. The list
before was `"GeistSans Fallback"`, a name nobody has, and CoreText's guess
at one is San Francisco — close enough to Geist that a glance, and a link
2px narrower than Chrome's, passed for it. **When a report says what the
text was set in before, ask the engine which face it matched**
(`app.fonts.match(list).postscriptName`), at both commits, before reading
either diff.

**The weight and width axes are the document's to set.** A style's weight
is a place on a variable face's `wght` axis, and its `font-stretch` one on
its `wdth` axis, each clamped to the range its `@font-face` declares (CSS
Fonts 4, 7.2), and an engine knows the file, not the rule: ntk moves the
weight axis to the style's weight whatever was declared, CoreText, for a
face core registered, does not move it — every heading set in Geist was its
regular on macOS — and neither knows a width at all. **A single weight is
a range of one**: Gmail declares Google Sans at 400, 500 and 700, each the
same variable file, and on macOS its bold was the file's regular. The one
weight left to the engine is a bold asked of a face declared lighter than
600 (`emboldened`), which a browser draws by emboldening the outlines; no
engine here does, and ntk's axis at the style's weight is the nearest
there is. `WebFonts.setting`
says the values and `layout/axes.ts` hands them on as the run's
`variations`, under the layout cache, so nothing a layout is found by
changes. Four things there are load-bearing: only a run whose list
**leads** with a variable face of the document's is touched, because an
axis value set on a run in another family lands on the system's own
variable font (San Francisco takes `wght` and would be set at this
document's rule); the run is handed on as a copy, since it is the caller's;
a value is one shared object, since ntk tells two runs' `variations` apart
by identity and would split a paragraph at one weight into a run a word;
and the width reaches that layer as the run's `stretch`, a field of
`DocumentRun` that no engine reads, so it is in `RUN_FIELDS` — two runs that
differ only in it are two layouts. CSS matches a family's faces by width
before slant and weight (5.2), and the font manager picks by weight and
slant alone, so faces of several widths in one family are registered a name
per width, and the same layer hands a run the list with its width's name
first.

**A face's rule sets its size and its lines, in the same layer.**
`size-adjust` scales the run's size there, and `layout/axes.ts` answers
`match` with a face whose metrics are the rule's — its own at the scaled
size, or the overrides' — so every line height, strut and `ex` the layout
asks for is the rule's without a caller knowing. Text in one face whose
lines are overridden is laid out with the engine's multiplier made the
engine's and its lines' ascent and descent the rule's (`linedLayout`),
since `lineHeightMultiplier` worked it out against the overridden face and
`lineAscent` stands text on its line by the engine's lines. A `local()`
face is the system's name, which any list may name, so `map` puts the
group's private name after the alias and `setting` takes it out: **the
marker is never first in a list**, since a name nobody has, first, is
answered with a guess (see `local()` above), and it reaches a widget's
`fontFamily` as written.

**A probe of an unbounded width places nothing at infinity.** A
shrink-to-fit probe lays a subtree out in infinite room, where sharing room
out — auto margins, a table's columns — comes to `Infinity`; the pass after
moved the box from there by a finite amount, `NaN`, and one `NaN` in the ink
bounds culls every ancestor from paint. Wikipedia's navboxes in a flex item
did it, and its whole article drew nothing. `placeBlock` shares no infinite
slack and `moveTo` refuses a non-finite destination. The same pass found
that `translate` moves an inline box's `x`/`y`, which are never laid out,
with the rest — they add up across passes — so nothing may read an inline
box's rect: `computePaintBounds` read it as the box's reach and measured a
card grid three times its height.

**A level of nesting costs every frame on the way down, and an interpreted
frame is whole.** A table in a cell is measured and laid out from inside
its table's layout, and a box is painted from inside its parent's paint,
so a document nested deep holds every level's frames at once — and V8's
interpreter, which runs code until it is hot, gives a function a frame
with a register for every local it has, whichever branch it is in.
No one change did it: as table fixes added locals to `layoutTable`, its
frame grew to a kilobyte, and a level of nested tables to 4 KB, until 254
of them ran out of the 984 KB V8 gives the main thread and the document
came out blank. So a function that recurses into what it holds is its
phases and the few values passed between them, with the arithmetic before
and after the recursion in functions of its own (`layoutTable`, its frame
a sixth of what it was). And `MAX_DEPTH` in the box builder bounds boxes, not
elements: the anonymous boxes the fix-up will add count as they are built
(`wrappersAround`), since painting a box takes some 800 bytes of stack
whoever made it.

Measure it under a test runner. On macOS, importing `react-x11` outside
one relaunches the process onto a worker with a 4 MB stack (core's
`src/cocoa/relaunch.js`), so a probe script has four times the room the
suite has; `NODE_ENV=test` keeps it on the main thread, as Linux, CI and
an X11 app are. A binary search over `--stack-size` says what a document
needs, and `node --print-bytecode --print-bytecode-filter=<name>` a
function's frame.

**A context lent to code that is not ours comes back as it was lent.** The
window's 2D context outlives the frame: core keeps one per window, and a
save a paint leaves open keeps its clip and its transform on it for every
frame after. ntk's `SvgView` saves as it draws and restores in no
`finally`, so a drawing it throws on halfway — nextjs.org's icons,
`fill="var(--accents-3)"` — left its saves open, `SvgDrawing.draw`'s one
restore took the last of them for its own, and the clip to a sixteen-pixel
icon stayed on the window. Everything painted after it, and every frame
after that, drew nothing, with no error anywhere: no X request failed, and
the document was laid out and painted as it should have been. `lend`
(`svg.ts`) hands the drawing the same context through a proxy that counts
its saves, restores what it left open, and makes none of the restores it
makes past its own. **Anything else that hands the context to code that
may throw — a callback, a library's painter — lends it the same way.**
The proxy keeps the alpha it was lent at as well: `SvgView` sets
`globalAlpha` to each mark's own, from 1 at its root, so where an element
is faded a thing at a time rather than as a group on a surface — macOS —
a drawing came out whole. reactmelbourne.com's grain, a full-window rect at
`opacity: .025`, drew the window black there and nothing on X11, where a
group took the fade. Every alpha the drawing sets is a fraction of the one
it was lent at, and what it reads back is what it set.

**A pointer move costs what it changed, and a scroll costs no hover at
all.** Three things, and each is a rule for whatever is added to the
cascade or the box tree next. A hover is restyled where it happened
(`HtmlViewNode._hoverInPlace`): the boxes keep their identity and take new
styles, so **a cache keyed on a `Box` that holds something a style decides
goes stale under it** — `DECORATED` in `paint.ts` did — and **a box whose
style is derived from an element's has to be derivable again**, which is
why the tree keeps its anonymous-style function and a pseudo-element's box
its `pseudo`. Where a hover has to build the boxes again, the build is
handed the elements the move reached and keeps every other element's style
(`Cascade.beginSharing(kept)`), since matching is most of a build:
**anything new that makes a computed style depend on more than the cascade,
the DOM and the pointer has to clear `_restyleOnly`**, as the viewport
units and a face's arrival do. And core's hover-follows-content
(react-x11#793) arrives as a move to the point the pointer is already at,
every frame of a scroll: the document holds it until the content has been
still a tenth of a second (`hoverClock`), because a page whose hover
rebuilt scrolled at 4 frames a second under a parked pointer. That is a
hold and not a throttle on purpose, and it is the document's and not
core's: a `:hover` on a node is a flag, and only a drawn element knows what
answering costs it. `pointerCompounds` is where a selector is read for what
a hover in it can reach; Tailwind 4 writes `:hover` inside `:is()` and
`:where()` as a matter of course, so "nested" there means a function it
cannot read a selector list in, and nothing more. A compound that leads
below to a subject (`PointerCompounds.below`) reaches the elements in it
the subject names, not all that is in it: Bootstrap's `:hover >
.anchor-link` names every element the pointer crosses, and reached the
whole page. The subject is read without its functional pseudo-classes
(`subjectOf`), each of which only narrows what the rest of it names, so
Angular's `*:hover > kbd:not(:has(kbd))` reaches keys and not all of every
hovered element. A compound that is its selector's subject, at its top,
reaches its element alone (`HOVER_SELF`, `PointerCompounds.subjects`), and
the restyle follows down from it only where a style comes out other than it
was (`StateReach.follows`, `_restyleInPlace`'s `from`): a webmail page's
banner, `:hover` a background, holds a hidden strip of ten thousand
elements, past what a hover restyles in place, and each move across it
built them all. **A touch that reaches less than an element's subtree says
how the restyle reaches what inherits from it**, or what it hands down is
left as it was. **Anything that draws an element some other box's way has to
bring that box into the reach** — a shape in an inline `<svg>` brings the
drawing (`_stateReach`'s `subject`), since only an `<svg>` in the reach
has its shapes asked for again. And a rule at a shadow tree's edge is in
no index a restyle in place asks, so a move that flips a host, an element
in a tree or a slotted one (`HOVER_EDGE`, `StateRules.edge`) styles again
every element it reaches, the subtree and later siblings the reach already
holds, as the build would (`_restyleHover`); only one where an edge rule
styles a pseudo-element (`pseudoAtEdges`) builds the boxes. MDN's custom
elements built them at every other move of the pointer.

**What is inside an inline `<svg>` has no boxes, and a cascade of its
own.** An `<svg>` is one replaced box, so the builder never reaches a
`<path>` and no `ComputedStyle` is made for one — a style for each would
be a few hundred properties for the dozen a shape has, on a page of
hundreds of icons. What the rules give a drawing's elements is `Cascade.shapeStyles`
(`css/shapes.ts`): the rules that declare one of a shape's properties, in
an index of their own, down to the strings `SvgView` reads from a `style`
attribute, which the drawing's copy of its tree carries (`svg.ts`). It is
asked as a drawing is first painted (`BoxTree.shapeStyler`, as
`::selection`'s style is) and kept by the box — the cache keyed on a `Box`
the paragraph above warns of, so `_hoverInPlace` asks again for each
drawing a move reached: `a:hover svg path` changes no box's style. A
change inside a drawing a page's script tells is the same: the drawing is
drawn again, and a `:has()` that asks what it holds restyles what its
anchors find from the drawing up (`_scopeOf`), as for a change anywhere —
it had been a restyle of everything wherever a sheet had a `:has()`, and
joshwcomeau.com's sparkles, a path at a time, restyled its 6,000 elements
three times a second. Two
things keep a page of icons from paying for it, and both are easy to
undo. A rule asked of every `<path>`, or of every element, names the
ancestor it is for by a class or an id, which is looked for once around
the drawing rather than matched from each of its elements
(`ancestorKeys`); and the root's paint is its box's already, so an icon
set's `.icon { fill }` is not matched a second time. GitHub's repository
page, a hundred drawings and no rule for any shape in them, went from a
tenth of a millisecond a drawing to a few microseconds. A property added to
`shapes.ts` has to be one `SvgView` reads, or a shorthand the cascade
writes out as some (`shapeFont`). **A length `SvgView` reads otherwise
than CSS is worked out in the drawing's copy** (`geometryLength`,
`fontSizeOf`): a percentage, a math function, a length in any unit but
`px` — it read `x2="2.5em"` as 2.5 and a `rem` as 16 — in user units,
which are CSS pixels unzoomed, since a zoom is the scale the drawing is
drawn at; a rule's lengths are read at the drawing's zoom and come to the
same (`DrawingUnits`). An SVG _image_ is the same
cascade over a document of its own: `SvgDrawing.drawImage` builds a
`Cascade` over the image's `<style>` sheets alone, one per colour scheme,
tells it the image's `<svg>` is `:root` (the cascade's own `:root` is
`<html>`), and gives the root its `fill`, `stroke` and `color` from
`styleFor`, as an inline root has them from its box. So `svg.ts` imports
the cascade, and the cascade must not import `svg.ts` back — which is why
`svgSizeHint` lives in `cascade.ts`.

**A `<use>`'s copy is matched in a tree of its own.** A selector sees
nothing above the element the `<use>` names and nothing beside it, and the
copy inherits from the `<use>` (SVG 2, 5.5.3). So one element can have two
styles, where it stands (`ShapeStyles.of`) and in each copy (`used`), and
`copyTree` draws every `<use>` itself once a rule reaches the drawing. The
matchers for a copy are compiled apart, over `_copyAdapter`, with nothing
kept between calls: css-select remembers what it found above an element
for as long as the matcher lives, and above an element is not the same in
a copy. What a copy matched is the same whichever `<use>` makes it, so it
is kept for the build with the document's id index (`ShapeCopies`), and a
page of hundreds of sprite icons matches each symbol once. Blink used to
style a copy as its original where the original stands
(`CorrespondingElement()`), and that is still how it is remembered. Chrome
154 does not: `.sprite .line` misses a sprite's line. Settle a claim like
that with a test page in Chrome, not with the recollection. **A `<use>` in
a `<clipPath>` is not copied**: a copy is a group, and a clipPath takes
nothing from a group (CSS Masking 1, 6.3), so the clip came out empty and
hid what it cut. It stays a use, and an element it names outside the root
is copied into a `<defs>` at the end of the tree (`bring`), since `SvgView`
looks a reference up in the tree it is given.

**What a `<foreignObject>` holds is a document of its own, which the
drawing paints.** Its HTML is a `BoxTree` of its own (`ForeignObject`,
`BoxTree.foreign`, by the object): built by a builder of its own inside
the document's build, so it is matched under the document's sharing and
rules, styled through the drawing's elements from the `<svg>`'s box down
(`_foreignObjects`); laid out by `layoutDocument` at the object's size in
device pixels, at the end of the document's layout (`layoutForeign`); and
painted by `paintDocument` from inside `SvgView`, where the drawing
reaches the object in its order, its transforms, opacity, mask and clip
already on the context (`ForeignPainter`, `paintForeign`). Five things are
load-bearing:

- **`tree.foreign` is absent where the document has none, and every path
  asks it first** — the layout, the paint, the restyle, the scope of a
  change. A document with none takes the paths it took: keep any new
  work for objects behind it.
- **No walk of the document's boxes reaches an object's**, and that is
  the design rather than a gap: what it holds is laid out against the
  object and nothing else (it is the containing block of all of it, fixed
  boxes among them), and it has no place in the document's flow. So
  anything that finds what it acts on from `tree.root` — the hit test,
  the selection, the widgets, the stops, the text — knows nothing of it
  yet, and a change in it, or in the drawing around it, builds the boxes
  (`_scopeOf`, and `_restyleInPlace` refusing): nothing restyles it in
  place. What the document asks of a build for its images and faces is
  handed up (the backgrounds, the generated images, `textStyles`, and an
  `<img>` built before its image arrived as `awaitingKind`, since nothing
  lays an object out again in place), and its text joins the document's
  for the faces it loads (`textOfTree`). **Anything new that a build
  collects for the host joins that list**, or an object never asks for it.
- **An object is painted with options of its own** (`foreignOptions`): the
  images, surfaces and rasters the document paints with, and none of what
  the document keeps by its own boxes — kept surfaces, filters' reads,
  lifted and captured boxes, the drag — nor its selection. **Anything new
  on `PaintOptions` keyed by a box is left out of them**, and anything a
  paint needs from the host goes in. Its tree's palette scheme is the
  object's own, so no opaque canvas is drawn under it (`paintDocument`):
  an object is transparent.
- **Where the matrix to the context is a move and no more, it is painted
  with none** (`setTransform`, the move in its origin), so its text is set
  on the pixel grid and the damage culls it. Otherwise it is drawn through
  the matrix where the context sets text through one or it is paths
  (`scalesText`, `drawnAsPaths`), and on a surface drawn through the
  matrix elsewhere, as `paintRaster` draws a transformed box; on a surface
  too wherever the drawing fades it, as the group it is. A picture of it
  scaled up is soft: laying it out at the drawing's scale would be a zoom
  on the object, which the box tree it is built in does not know yet.
- **The seam is ntk's, upstream, and asked for at run time.** `SvgView`
  hands an object to `draw()`'s `opts.foreignObject(element, ctx, box)`
  where the drawing reaches it — its transforms, clip paths, masks and
  opacity on the context, `box` its rectangle and that opacity — and
  measures it as its rectangle for `objectBoundingBox` units, and holds
  SVG 1.1's `Extensibility` in a `<switch>` where it is handed one
  (sidorares/ntk#549). An ntk from before it ignores the option, so
  whether it draws one is asked of the view itself, by drawing an object
  on a context that draws nothing (`drawsForeignObjects`): where it does
  not, no object is built, laid out or drawn, as before, and a `<switch>`
  draws its fallback. **Nothing here reaches into `SvgView`'s privates**;
  the tests stand in for the hook on an ntk without it
  (`withForeignObjects` in `test/html/harness.ts`, as #972's
  `withFieldSelection` stands in for core's), and that stand-in goes when
  the floor's ntk carries it. A copy of the tree the view is handed
  (`copyTree`) holds none of an object's HTML and maps each copy to its
  element (`FOREIGN_COPIES`), which the hook is handed.

And one finding it made: **a type selector matches no element with a
capital in its name.** The parser keeps SVG's camelCase (`foreignObject`,
`clipPath`, `linearGradient`), css-select lowercases the selector, and
`getName` hands it the name as parsed. So SVG's UA rule for an object,
`overflow: hidden`, is a presentation hint (`presentationHints`), under
its own `overflow` attribute and every rule, where it is in no worse
place.

**A transform is two halves, and inside one every number is the box's
own.** Its translation is layout's — `applyRelativeOffsets` moves the box
and what it holds, so everything that reads a box finds it moved — and what
is left, a turn, a scale or a skew, is paint's: `paintTransformed` draws
the box through `placedMatrix`, about its origin where the translation put
it (`css/transform.ts` has why the two are one matrix). So under a box that
turns, the `x`, `y` and ink bounds of everything it holds are in the
coordinates it was laid out in, and only the box's own `boundsX`… are where
it is drawn. **A rectangle taken out of such a box goes through
`throughTransforms`, and a point taken into one through the inverse**
(`deepestAt`, `nearestText`): without the first, a link hovered in a turned
box was repainted where it was laid out. It is the 1x-display trap with a
matrix for the scale, and has the same answer: a test of a transformed box
that reads geometry back turns the box, and does not only move it. What a
matrix reaches is the context's: ntk draws a glyph as it was shaped, where
the matrix puts it, and says so by having no `scalesText`, and it draws an
image through a picture transform in 16.16 fixed point, in the window's
coordinates — a photograph at a fortieth of its size 2,200 pixels across
threw from the request's encoder, which blanks the document. So there only
a box that is paths and flat colour is drawn through the matrix
(`drawnAsPaths`), and any other on a surface, the surface through the
matrix (`paintRaster`). **Anything new a box can draw that is not a path
goes on `drawnAsPaths`' list**, and the stress that found this is worth
rerunning after: hostile values (`scale(1e30)`, `skewX(90deg)`), and an
image far across a window wider than any test's. **A shadow cast from a
drawing moved clear of the window is moved by `aside`**: a context takes a
shadow's offset and blur in the window's coordinates whatever matrix it
draws through, so a shape moved `dx` aside in the box's own coordinates and
offset back by `dx` in the window's lands `(a − 1)·dx` off — the Zen
Garden's design list, a card hovered to `scale(1.01)`, cast its glow 20px
left of itself on macOS, where every box is drawn through its matrix.
`PaintOptions.matrix` is the matrix the context draws through, and a box
painted on a surface as it was laid out (`onSurface`) has none.

**Out of the plane, `placedMatrix` is a projection, and only one context
draws through one.** A style out of the plane — by a function of its list,
`translate`'s or `scale`'s depth, or `rotate` about an axis in the page —
is a 4×4 (`css/transform3d.ts`). **Ask `outOfPlane`, and `drawnThrough`
for whether a box is painted through a matrix at all, never the fields**:
`translate: 0 0 100px` leaves `transform`, `rotate` and `scale` all
`null`, which three tests of just those took for a box that only moves.
Layout still takes its translation across and down
(`translation4`), and what is left is seen in the `perspective` of the
nearest box with one up the containing blocks (`perspectiveFor` — through a
positioned box, as Blink hangs a transform under the nearest perspective,
and not past a box with a transform of its own, which flattens what it
holds). What the box's plane comes to is a 3×3 `Projection`, or the matrix
of the plane it is where all of the box is as far from the viewer as any of
it, so `placedMatrix` answers a `Placed` and **anything that reads geometry
through it asks `invert`, `mapPoint` and `mapRect`, which take either**, and
never indexes it as a matrix: `paintTransformed` sends a projection to
`paintProjected`, and that paints the box on a surface and draws the
surface a tile of whole device pixels at a time, each tile through the
matrix nearest the projection over it and clipped to it (`drawProjected`).
Whole pixels are the point: clips cut through a pixel leave it half covered
twice over, which shows as a seam, and tiles that overlap draw a fade
twice. A tile is cut until its matrix is within a quarter of a logical
pixel of the projection at its corners, across the way it bends; 219's
panel at 35° is some 440 tiles, and they cost a repaint a few
milliseconds. The tiles are cut from all of the box, whatever the damage,
and those the damage misses are passed over before they are cut again, so
a repaint of part of it draws the tiles a paint of all of it does there:
cut from the damage, a repaint drew it a level or a few apart from what
was around it. Behind the viewer is nothing (`inFront`). Where the context
has `drawImageProjected` — react-x11's Wayland one, a quad interpolated in
perspective on the GPU — the surface is handed to it once instead, clipped
to the pixels the tiles would cover, and tiled only where it answers false
for a corner behind the viewer: a tile there is a GL batch of its own,
since each is clipped, and 219's sidebar ran at 12 frames a second in tiles
and 25 drawn whole. **Anything new that draws a surface through a
projection goes through `drawProjected`**, so it gets both. The tiles are drawn
at `imageSmoothingQuality = 'low'`, bilinear, where the context has the
setting: each tile's matrix is within a fraction of a pixel of the plane's,
and on macOS a context's own `'medium'` resamples the whole surface for
each tile whatever its clip, 200 ms for 784 tiles of a 1400 by 1120
surface where `'low'` takes 27 (windowkit/appkit#109, react-x11#861). On
macOS the box goes on a layer instead where it can, whose matrix is the
whole 4×4 and which the render server draws on the GPU (see "A box out of
the plane is lifted" below): the perspective is `perspectiveAround`, one
copy of it for both.

**An animation is a style that changes as time passes, and runs as one.**
`css/timeline.ts` keeps when each element's animations started — by
element, so a document built again finds them — and the cascade asks it
for each animation's progress as it styles the element, interpolates the
computed values between the frames around it (`css/interpolate.ts`) and
applies them at the animation origin, as declarations that carry their
computed fields (`Declaration.computed`). Three things are load-bearing. A
style an animation runs in is that element's alone, since its animations
started when it did, so `sharedStyleFor` shares none. A frame restyles
the animated elements through the hover's path (`_restyleInPlace`) — which
is why an opacity and a visibility are changes it makes in place — and
builds the boxes again around kept styles where layout reads what changed;
`test/html/animations.test.ts` holds a frame made in place to the pixels a
build of the whole document draws, which is how the `::before` a frame
never reached was found. And a transform keeps what each of its functions
was (`Primitive`): a matrix cannot tell a full turn from none. Layout's
per-box caches assume a box's style never changes (only the `vw` path
drops them yet, through `forgetSizes`), so a frame that changes a length
builds the subtrees it reached rather than restyling them and laying out
again, keeping every other box (`_rebuildFrame`, `_buildSeeds`) — at once,
so that where everything it changed is positioned out of the flow, or is
inside a box that is, and no other box moved, it repaints only those
boxes' ink. Compare where a box is laid out there, not how far it
draws: an ancestor's ink bounds take in the marquee scrolling inside it.
**The boxes a frame's build kept are the same boxes after it**, which its
layout moves, so where each was laid out, and what the boxes out of the
flow around what the frame reached drew, are taken before the build
(`placed`, `KeptInk`): compared after it, a box is always where it is. A
sparkle on joshwcomeau.com turns a drawing in a span placed absolutely,
and the start and the end of each turn built the whole article, laid it
out and repainted all of it. And **a box that draws nothing reaches
nowhere** (`inkBottom`): its ink's bounds are at infinity, which a
restyle in place took for past the document's end, and the document was
laid out at every frame a sparkle was scaled to nothing.
**A frame repaints a box where it is drawn now** (`_inkOf`): a box fixed
to the viewport, or in one, is laid out at the document's top and drawn
where the pane's scroll has the viewport, so its ink is moved by that
scroll, as the paint and the hit test move it; and a `::before` or an
`::after` has no element in `styles`, so `_changedOutOfFlow` compares its
own box. Zen Garden 215's starburst turns and its robot rises, both fixed
pseudo-elements, and neither showed a frame until a scroll repainted them.
**A frame waits for the window once it is two frames behind.** The clock
asks for a frame every 16 ms; a server slower than that painted 219's
every sixth, and the document built its boxes for the five between, which
nobody saw. So a frame that asked for a repaint notes when
(`_owedSince`, counted through an `invalidate` override), the frame after
it is made anyway, one ahead being a pipeline, and the next waits for the
paint, which asks for it, or a quarter of a second, for a document nothing
paints. Made only after each paint, 219 lost a third of its frames on a
Wayland window that kept up; one ahead, it lost none and built half as
often on the slow one. **Anything new that a frame claims damage through
goes through `invalidate`**, which it does unless it reaches past the
node. `animate={false}` draws each animation at rest, which is how the Zen
Garden bench runs `<Html>`.

**A frame waits for a change anyone sees.** An animation under way asks for
its next frame when what it draws next changes by the least anyone sees —
an eighth of a device pixel in where something is drawn (`SEEN_PX`), a
level of 255 in a colour or an opacity — and not a frame from now
(`AnimationTimeline.pace`). The cascade knows the values a span of the
animation's frames runs between (`visibleSpan`), the timeline its duration,
its direction and how long it goes on, and the easing bounds how fast it
moves at its steepest (`steepest`): a span that holds its values waits for
its end, and no wait outlasts the span or the animation. Zen Garden 214's
enso scales from 1 to 3 in ten hours, and had a frame forty times a second
that moved its edge a hundred-millionth of a pixel; it has one every half
second, and the page at rest went from more than a core to 4% of one.
Three things are load-bearing. **A field `visibleSpan` cannot measure is a
frame from now**, as every one was — a length, a shadow, a filter, a step,
a curve as steep as a step — so measuring a new one is a decision about
what counts as seen, not a default. **A transform is measured by what it
does, not by its matrix**: a turn of ten whole turns between two frames
has the same matrix at both ends, so turns are counted by their angles,
scales by their factors and moves by their lengths, as
`interpolateTransforms` runs them, each scaled by how far from where it
turns the box reaches (`reach`); a list it interpolates as matrices is a
frame from now. And **only an animation in its active phase is paced**: one
paused, in its delay or filling holds its value, and the delay's end is
the timeline's own to wake for.

**A `::before` or an `::after` an animation turns, scales or fades is
restyled where it is**, as an element's box is (`_restyleInPlace`): its new
translation moved in (`retranslate`), how far it reaches and the order its
layer paints in worked out again, and what it drew before and draws after
repainted. It had been refused, and each frame of one built the document
again and repainted all of it, since a box in the flow is not one a
frame's build can repaint apart (`_changedOutOfFlow`): the enso's frames
were 4.2 megapixels at 2x, and are its tenth of one.

**And what an animation sets acts as though `will-change` named it**,
from the start of its delay to its end, or for good where it fills
forwards (Web Animations 1, 5.6): the timeline keeps each element's bits
as it samples it (`animatedWillChange`) and the cascade ORs them into the
style. So a fade is a stacking context on the frames at an opacity of 1
too — before, it changed its place in the paint order each time it got
there — and a transform holds what is fixed in it through its delay. A
phase that changes the bits, an animation starting or ending, changes
`willChange`, which `hoverChange` does not take in place: the boxes are
built again. The frame an opacity first leaves 1 is not one more, since
the bits name the opacity on both sides of it, and the paint order is
what it was. **The bits are what makes an animated element one of its
context's layers on every frame**, which the sprites' paint-order test
below stands on.

**A new animation starts at the paint that first shows it, and one that
runs out waits at its end for the page to hear of it.** The document's
timeline holds a CSS animation it has not drawn yet at its start
(`Running.pending`, `startsAtPaint`) and starts it at the next paint
(`startPending`), as a browser holds one until the frame that renders it
(Web Animations 1, 4.4.2): Radix reads a menu's `getComputedStyle` as it
mounts it, the paint came 240 ms after, and a fade of 100 ms was over
before the menu was drawn. It is paced as one that plays, so frames keep
coming while it waits, and one no paint shows for `PAINT_WAIT_MS` starts
at a frame. Where nothing waits to be painted it starts at once
(`_claimsPainted`, in `_scheduleFrame`): one whose first frame is what the
window shows already — a colour from the element's own, on a hover —
changes nothing a paint would draw, and waited for a paint that was not
coming. A transition waits the same way (`Transit.pending`, a
`CSSTransition` being an animation): it is made again at the clock's time
each time it is sampled while it waits (`beginAt`), its delay with it, so
whatever reads its times — the lifts, `getAnimations()` — finds one only
just begun, and the paint makes it once more and lets it go. And where a
page listens (`holdsEnds`), a run that ends is
drawn at its end, as though it filled forwards, until its `animationend`
is told (`releaseEnds`, in `_oweCssEvents`, just before the telling): a
browser tells it before the frame that draws the element as the animation
leaves it, and Radix keeps a menu that faded out at its end from the
listener, so told a frame late the menu was drawn whole between its fade
and its unmounting. Two things are load-bearing. **A run on the
document's clock is made in `sample`, and a transition in `transition`
through `_made`**, or it starts as its style is worked out. And **no
page code runs from a frame**: `_frame` is also called from core's
`spritesLifted`, inside the presenter's pass, which is why an end is held
until the events' own tick rather than told before the frame.

**A transition runs on the same timeline, from the style the document
draws.** `AnimationTimeline.transition` is asked of every style the cascade
computes, after its animations (`Cascade._computeStyle`), and keeps an
element's transitions under way, and a pseudo-element's, by the field of
the computed style each runs on. What a change starts one from is the
style the document has for the element (`Cascade.previous`,
`HtmlViewNode._previousStyle`), asked only where the style's list names a
property that could start one — so a document with no transition pays a
map lookup a style — and none where the tree was styled by other sheets: a
stylesheet arriving is no change a browser, which waits for it, shows.
Three things are load-bearing. **A style its transitions run in is the
element's alone** (`_running` asks `transiting(el)`), or a sibling under
the same key takes it and never starts its own. **The lists draw
nothing**, as the animation lists do (`hoverChange`, `spriteChange`). And
a transition starting or ending changes `willChange`, as an animation
does, so its first frame is a build. **A field an animation sets is the
animation's**: the drawn style holds the frame before, and compared with
this frame's it started a transition every frame, so the fields the
element's animations set now (`fieldsAnimatedBy`), and those its drawn
style's set (`noteAnimated`, by the style), start none and turn none
back, and one under way on them runs on beneath. A transition on what a
layer carries goes on one as an animation does (`liftOf`): one iteration
from where it starts to where it ends, held at its start through its
delay.

**A dragged width lays out what can be seen, and sets the rest aside.**
While the width keeps moving, `_stopAt` hands `layoutDocument` an `until`,
and `layoutChildren` lays out no child that starts below it: the rest of
that box's children are set aside (`setAside`) — the box's `children` is
the part laid out until the next layout puts the whole list back
(`putBack`), so the paint, the hit test and every walk from the root miss
them — and the box is as tall as they last were. The whole document is laid
out once the width rests (`resizeClock`). Four things are load-bearing.
**Anything that reaches boxes from a list of the tree's rather than from
the root asks `heldBack`**, as `controlRectsOf` and `mediaRectsOf` do: a
box set aside is where it was a width ago, which may be over what is laid
out there now. **And a restyle in place leaves what is set aside to a
build** (`_asideOwed`): it walks down `children`, which pass it, and where
it passed some, the boxes are built again, keeping every element's style it
gave, before the next layout that puts them back whole. A step that took a
`vw` in place had left the text below the fold in the last width's style,
and the layout at rest set it there; restyled at every step instead, the
set-aside half of a page in fluid type was restyled each time, and its
icons sized in `em` built the boxes for it. **Anything new that changes a
box's style outside a build does the same**, and the index of boxes by
element goes down what `asideOf` keeps, so it holds what is set aside whenever
it is made. **A layout that cannot set a box aside leaves it laid out**:
a multicol container's content is one strip its columns balance
(`multicolAround`), and the boxes that hold a fixed box, or an absolute one
placed against something outside them, are laid out where they would be set
aside (`escapingHolders`, `LayoutContext.holders`), with all but what holds
it set aside in each, so the box is placed at the new width and the paint
reaches it; the span set aside leaves their heights out, since the flow adds
them again. The Guardian's banner, fixed to the bottom, laid its whole tree
out at every step. A tree that sets such a box aside anyway — a holder the
cache missed — is laid out whole from then on (`escapes`). **An absolute
box that draws nothing waits for the layout at rest** (`unseenWhileStopped`):
hidden or faded to nothing all through, placed by a layout before and holding
no widget, it is set aside from its parent with all it holds, where it was a
width ago, since where it is matters to nothing a reader sees. GitHub keeps
its menus so, shrink-to-fit, and they were a third of every step of a drag.
A restyle in place restyles such a box where it is (`unseenIn`,
`unseenHeld`), and lays the document out where the box now draws
(`showsUnseen`): **anything new that can show a box without a layout asks
`showsUnseen` too**, or a menu a script opens during a drag is drawn only
once the drag ends. And **a partial
layout stands on intrinsic sizes the
tree's first, whole layout found**, which a box keeps for its lifetime: one
no whole layout has laid out is laid out whole (`_wholeTree`), since a
measure taken after a descendant was set aside would see less than is
there — but for a tree a drag built, a breakpoint's or a `vw`'s, which a
layout that stops sizes from all a box holds (`probeWhole`), and which is
laid out whole at once where the tree before it escaped (`laidWhole`):
built at every step, such a tree was laid out twice a step, once stopped
and once whole. **Anything new that builds the boxes while the width moves
says whether its tree may stop**, through `crossing` in `_update`, or a
long page is laid out whole at every step of the drag.

**A step of a drag styles what can be seen, and takes what it can in
place.** A `vw` in a box's lengths and a `translate` in `vw` on the same
box are one step's change, and `hoverChange` takes both: where a layout
follows it is told which `lengths` it may take beside what only inks
(`HoverChange.lengths`), since a change that was neither lengths alone nor
ink alone built the boxes. Apple's gallery draws a slide's `::after` so, and
every step built 40 subtrees for 24 boxes. Three things are load-bearing.
**What a drag set aside is styled last** (`_heldBackOf`, `_stylesOwed`): a
reader of the viewport no walk would reach is left out of a step, and
`tree.styles` holds what it was, so **anything that reads an element's
style goes through `_styleOf`**, which works out an owed one
(`_owedStyle`), and **anything that keeps styles across a build keeps them
through `_withOwed`**, or an element is left in the styles of a width ago
once the drag rests. A build of the whole document pays them all, and a
build of subtrees leaves them owed. **No walk says what a box set aside
has**: `generated` is of what was walked, so the test for a new `::before`
or `::after` passes over an element set aside, or one whose `::after`
alone was, which the build it is owed makes. And **a layout that follows
sets text at its new size**: `reinked` lets such a run go (`lengths`), since
a box inked beside it sends every run of the block through there.

**A page that writes while the width is dragged is laid out and built as
the step is.** A page's resize handlers write at every step and read back
at once: Apple's set classes on a gallery's slides and put a probe of the
viewport after the `<body>`. A layout at the width the drag is on, while
the rest the step armed waits (`_stopAt`'s `again`), stops where the
step's did, and arms no rest of its own, or a page writing at every frame
would put off the layout at rest for good. A build of subtrees puts back
what the drag set aside before it splices (`putBack` in `_subtreeBuild`),
leaves what a restyle in place owed it owed (`_asideOwed`), and its tree
stops where a breakpoint's does (`crossing`). And what a step restyles
itself — what a breakpoint turns rules on or off for, the elements that
read a `vw`, an image that shows another source — is the build's seeds
(`seedWith`), so that only their subtrees are built. Each had laid out,
and built, the whole of Apple's page: a drag of 80 steps over it in the
harness went from 113 builds of the whole document to 10, and from 47 s of
processor time to 27, and in a window on a Mac from 264 to 6, and from 87
seconds to 14. Two things are load-bearing. **Anything new that
builds the boxes for what a step changed hands its elements to
`seedWith`**, or the step builds the whole document. And **every path of a
restyle in place that passes what is set aside sets `_asideOwed`**, the
one that restyles no box as much as the rest: a write that changed only
the lengths of a box below the fold left it in its old style once the drag
rested. `a page that writes while a window edge is dragged comes to rest…`
in `test/html/subtree-build.test.ts` found that, and holds the rest to a
restyle, a build and a layout of the whole document, over generated pages,
writes and breakpoints; `DRAG_SEEDS` sweeps more of them, and `DRAG_FROM`
starts at the one that failed.

**A grid stops at a row, where its rows' sizes are their own.** A layout
that stops keeps the rows of a grid whose last layout started below where
it stops at the sizes they had, and sets their items aside (`cutAt`,
`setAsideOf`), from what the grid's last layout that was not a probe made
of them (`KEPT_ROWS`): the same items in the same areas, or nothing is
kept. A row's size is its items' alone but where something shares the
grid's height out among its rows — a share (`fr`), a percentage, a
percentage gap, a height of its own or a least one — or an item spans the
cut, or one is a subgrid; any of those lays the grid out whole. Where the
rows above come out shorter and the first row kept starts above where the
layout stops, it is laid out after all, as a block's child would be.
Next.js's blog is a grid of cards, and a step of a drag laid out every
card. **Anything new that sets a box's children aside takes them back with
`wholeAgain` where the box's layout starts**, or a layout of it later in
the same pass — a probe, a flex item measured — finds them cut short.

**A table stops at a row in the same way** (`rowCut`, `KEPT_TABLES`): the
rows whose last layout started below the line keep their heights, their
cells keep the content heights they came to (`natural`) and are not laid
out, and the rows are set aside in their groups. The columns are sized from
every cell as before, from what each kept of its widths. A table that
shares a height out among its rows — one of its own, one a flex or grid
layout gave it, a least one — or has a cell spanning the cut, or a row past
it that holds a box placed against something outside it, is laid out whole.
`clampHeight` never comes to less than a box's borders and padding, so a
least height is one past `verticalExtra`: compared with 0, every bordered
table was taken for one with a `min-height`, and Wikipedia's list of
countries, a bordered `wikitable`, was laid out whole.

**What is above the viewport is kept as well, and the viewport holds
still.** A pane that can follow what it shows (`anchorScrollBy`, react-x11
2.45.0, CSS Scroll Anchoring 1) keeps the block at the top of its viewport
where it is on screen: `anchorAt` finds the block as the document is drawn
(`_shown`), and after a layout at another width `_keepAnchor` asks the pane
to move its offset by as far as the layout moved the block, in the same
pass. So a drag keeps the blocks that ended above the viewport as they were
(`keepAbove`, by the place each child of a flow was last laid out at,
`FLOW_PLACE`) and lays out from there. The text above a paragraph half way
down an article comes to more lines or fewer at every step, and laying it
out was most of the step. Three things are load-bearing. **A layout at a
fraction of the width the document is drawn at is a question about its
size**, core's content floors asking, so it is laid out whole, and so is
the layout after it: the places a question leaves belong to no layout that
is drawn (`_questioned`). With no room on offer, a document drawn at a width
lays nothing out at all (`_sizeAt`): what it answers is cut to the room, and
what is left is a height a pass that measures widths does not read. Laid out
a pixel wide, it crossed every breakpoint down and back, twice a question on
Apple's product page, some 900 ms each. One in a box that really is no wider
goes on, since what its scripts are told is told from a layout. **A frame may
lay the document out more than
once**, so the anchor is the one drawn last and the pane is asked only for
what it has not been asked yet (`_frameAnchor.asked`). And **a breakpoint's
fresh tree has no places to keep**, so it is laid out from the top down to
where the anchor lands, and as far past it as the layout would have gone
(`LayoutContext.reach`). The whole layout a drag owes waits for the drag to
end where the window says one is under way (`liveResizing`, which a
`<Frame>`'s pane hears from its host, react-x11 2.45.0): a hand that pauses
is still dragging, and a long document laid out whole at each pause held
the next frame 60 to 100 ms.

**A drag the document cannot keep up with is drawn cheaper while it
moves, and as at rest when it does not.** Where the window says its edge is
being dragged (`liveResizing`), the element times its own work between
paints (`_counted`, on `frameClock`): a layout, a build, a frame of its
animations, the sprites it offers and the paint. Two of the last three
frames of the drag past `FRAME_BUDGET_MS` draw the next one cheaper
(`_behind`): a background whose size moves with the drag on a step of
sizes 4% apart (`steppedTile`), the document's clock making no frame of
its animations, and a box a paused animation turns or scales from the
surface kept for it (`DragPaint`). A hand that holds still for
`DRAG_REST_MS`, or lets go, has the page drawn as at rest. Four things
are load-bearing. **A frame drawn cheaper decides nothing**: it is cheap
because it is drawn so, and counted it would draw the next one as at rest,
and the one after cheaper, one way and the other at alternate frames — so
`_overBudget` holds frames drawn as at rest alone, and a drag that fell
behind is drawn cheaper from the first step after a pause. **Only a size
that moved in the drag steps** (`DragPaint.moved`, by the layer's style):
an avatar's photograph that covers a box of its own size gains nothing
from a step, and would be drawn 4% off for nothing. **Anything new drawn
cheaper calls `DragPaint.drawn`**, or the paint at rest leaves it as the
drag drew it; and that paint clears every surface kept for a box, since a
frame of the drag may have drawn something cheaper on one. And **anything
new that asks for an animation frame honours `_cheap`** as it honours
`_skipLifted`, and anything that does a frame's work from a timer or a
core hook times itself with `_counted`, or a drag behind its edge is not
seen to be.

**A box drawn on a surface of its own keeps the surface, keyed on its
`Box`.** X11 draws a turned box with text in it on a surface
(`paintRaster`), and X11 and Wayland draw an element an opacity fades as a
group on one (`paintGroup`). The surface is kept (`SpriteStore`) while the
box animates, or something inside it does (`animatesWithin`), or while it
is no larger than a card's, and each paint draws
it through the matrix and at the opacity it has then — the Box-keyed
cache the hover paragraph warns of, on a still page as much as a moving
one, so it is forgotten wherever what a box draws can change. A layout at
another width or under another viewport keeps a surface **whose box laid
out as it did when the surface was drawn** — the place, size and ink of
everything in it and every line and piece of text, relative to the box's
corner (`layoutShape`, `src/html/layout/shape.ts`), taken as the surface is
made and compared after the layout (`relaid`) — and forgets the rest. A
card of a fixed width that a narrower column only moves draws what it
drew: Zen Garden 101's eleven faded panels were each drawn again at every
step of a drag, which went from 29 seconds to 8.5 on Wayland. The record
reads no inline box's rect, which no layout sets (see "A probe of an
unbounded width"): what an inline box holds is in its block's lines.
**Anything new a layout can change in what a box draws joins
`layoutShape`'s record**, or a surface kept across a width draws it as it
was. Two records are compared to a millionth of a pixel (`SAME_PLACE`): a
box a drag moves a fraction of a pixel at a time has the places from its
corner of all it holds worked out in other last bits at each step, and
Zen Garden 214's enso was drawn again at every one. A surface given up is kept, by its size, until the paint ends, for a
box that asks for one that size to be drawn on again rather than one made
(`release`, `reuse`, `trim`). A build clears the store — **but for a
frame's build that changed only what is out of the flow** (`_rebuildFrame`): each
surface moves to the box that draws its element now, where that box is
where the old one was and styled as it was, with the ink of what changed
inside it marked to be cleared and painted again on it (`_carrySprites`,
`repaintStale`), and the rest of it left as it is. Zen Garden 219's sidebar,
turned in a perspective with eight marquees in it, was painted whole at
every frame; where the context draws it as one quad (`drawImageProjected`),
keeping it took 219 from 25 frames a second on Wayland to 35, and where it
is drawn in tiles, the tiles are most of the frame and it gains little. Such a
build lays a new tree out at the width the one before was laid out at
(`_carryingFrom`), which the check for another width has to be told.
**Anything new that a frame's build can change inside a box joins what
`_carrySprites` marks stale**, or a kept surface shows it as it was.
`_restyleInPlace` drops
the surface of every box around one that draws something else now
(`_restyledSprites`), and leaves a box its own where only its transform,
opacity or `z-index` changed; the fraction of a pixel its corner falls on
and the selection's part in its text are its key. **Anything new that
changes what a box draws without a restyle, a build or a layout drops the
surfaces around it** (`_dropSprites`), as the shapes a hover recolours in
a drawing do. Every frame in `test/html/animations.test.ts` is held to a
build and to a surface made for that paint alone: a frame and a build can
both be wrong the same way, and only the second check sees it.

**An SVG image is kept as a raster by its drawing and its size, not by a
box.** A background, a list marker or an `<img>` that is an SVG is copied
from a raster of the drawing at that size (`drawSvg`), made the second
time it is drawn there (`_drawingKept`), wherever the context draws in
whole pixels of its own: no `PaintOptions.matrix`, and a corner on the
pixel grid, where the copy is the drawing set from its paths, pixel for
pixel. Elsewhere — a macOS context drawing through a transform — it is set
from its paths as before. Keyed by the drawing and not by a `Box`, it
outlives a build, which clears every surface kept for a box: on a page
whose every frame builds, under an animation of a `top` or a
`text-indent`, it is the part of the paint a frame does not do again.
**A key holds everything the drawing is set from** — the drawing, its
device size, the scale and the colour scheme — and a drawing that came to
depend on anything else, the page's fonts or its rules, would have to
join it.

A raster image drawn at another size than its own is kept the same way
(`drawRaster`), by the image and its device size: CoreGraphics reads all of
a source for a draw that scales it, whatever the clip, so a preview drawn
at a third of its size cost its whole size at every paint that reached it.
**While the width moves, a raster is made only of a size the paint before
drew as well** (`_drawnLast`): each width of a drag draws whatever is sized
from it at a size of its own, and one drawn a second time later in the
drag — a hand going back over the widths it came through — was made into a
raster that nothing copied. Zen Garden 214's photographs were 278 of them
in a drag of the bench's, and a frame's paint went from 17 ms to 10.

**An animated image is the document's to play, and a frame is a repaint
of the boxes that drew the one before** (`animated.ts`, `_gifFrame`). It is
here and not in core's `<image>` because `<Html>` draws its own images, so
nothing core's element did would reach a document. The frames are read
here too: `gif.ts` because core's decoder ladder reads no GIF under Node
and only a first frame under Bun, and `webp.ts` because the ladder answers
a WebP's first frame. A WebP frame's pixels are image-in-browser's,
handed each frame as a still of its own (`stillOf`), and the compositing is
`WebPCanvas`'s: image-in-browser's own blends every frame and clears the
whole canvas before a frame whose dispose flag is set, where the flags say
to replace and to clear the frame's rectangle after it shows. Should core's
`<image>` come to play animations, the frames belong on the ladder, and the
rule in "Vendored from core" applies: delete the copy, import the export.
Two things are load-bearing. **A paint that draws an image for a box names
the box** (`painting` in `paint.ts`): `paintBox` does, and so do a block's
background and marker, which its parent's flow pass paints; drawn under the
wrong box, a frame repaints the parent's whole ink. And **nothing ticks for
what no paint reached**: a frame is waited for only by a box a paint drew,
so an image scrolled out of view stops until a paint draws it again, where
it shows the frame its clock has come to.

**On macOS a clip that is not a rectangle of whole pixels is a mask**, and
CoreGraphics draws through one at some four times the cost of a
rectangle, over everything the draw covers: a rounded box cut out of a
shadow's reach made a card's 200px glow 16 ms where it is 4.5. An edge a
fraction of a pixel in counts, so a rectangle under a box's matrix is one
too. So an outer shadow is cut away from a box that shows what is behind
it by bands of whole pixels of the surface round the box, laid with the
matrix set aside, and only over the box by its outline (`castOutside`).
**Anything new that clips a large draw does the same**: rectangles of whole
pixels for what is large, and the path only where it is small.

**A large gradient straight down or across is a strip copied**
(`gradientStrip`): shaded 64 pixels wide on a scratch surface, copied along
the axis it does not change on, only where the context draws in whole
pixels of its own. CoreGraphics shades a gradient at some 3.6 ns a pixel
and copies at a tenth of that; on X11 it measured even. A copy is the
pixels the shading made, so an opaque gradient is drawn as it was and a
translucent one may be a level apart, the store-and-composite rounding a
kept raster has. **And one whose stops hold a colour over a run is filled a
run at a time** (`gradientRuns`): an opaque run filled with its one
colour, a transparent one not drawn, and what runs between two colours —
or is translucent — shaded as before, cut to its run. Zen Garden 214's
sidebar is `linear-gradient(to right, #fff 66%, #e5ede8 66%)`, two fills
where it was a strip shaded and copied down the window at every frame of
a resize. A pixel takes the colour at its centre, as ntk's shading has it,
pixel for pixel, and a gradient with a stop on a pixel's centre, which the
floating point of the two gives either run, is left to the shading; CoreGraphics puts a hard stop a column either side of a
pixel's centre, as the rectangle and the clip it shades through have it —
a repaint of part of such a gradient could move its stop a column there
before — so on macOS a stop between two runs filled holds where its
centre is. **Shade a run as the whole is shaded, cut to the run**: shaded
on its own, a narrower rectangle put a stop in another column.

**A small gradient repeated is shaded once** (`gradientBlocks`): past
`BLOCK_FROM` tiles in a paint, one tile is shaded on a raster kept by its
key (`tilesKept`) and copied from a block of them (`tileBlock`), as a
small image's tiles are, where the context draws in whole pixels of its
own. Tailwind's docs hatch their gutters with a repeating gradient ten
pixels a side, and every tile a frame of a scroll reached was its stops
laid down again, their colours read again and the tile shaded again: 22 MB
and half of each frame on a Mac. **The key is everything the tile is
shaded from** — the gradient, the current colour and the tile's device
size — and a gradient that came to read anything else would have to join
it.

**A group goes only to a context where it pays** (`groupsOnSurfaces`):
ntk's, and a native one that says a faded surface is cheap
(`fadesSurfacesCheaply`). CoreGraphics draws an image under an alpha below
1 at some fifteen times its cost at 1, so on macOS a faded card's group
cost twice what drawing the card again did, until react-x11 drew a surface
there from its pixels scaled by the alpha (react-x11#810). A native context
that does not say so fades each thing an element draws. And ntk's glyphs
take no alpha of the context's — a text layout is drawn in its runs'
colours — so on X11 and Wayland text is grouped even alone (`fadesGlyphs`):
nothing on ntk fades text through `globalAlpha`. Which side of a
trade like that is cheap differs by backend and was the opposite of the
in-process server's here, and the first guess at why — the image path, a
flip, the interpolation — was wrong too: measure a new surface on macOS,
in a benchmark that varies one thing at a time, before taking a composite
for the cheap side or a cause for the cost.

**A group drawn through a matrix is kept while the matrix holds**
(`groupKept`): painted whole on a surface kept for its box, by the matrix
and where it puts the box's corner from the surface's, and drawn again from
there — the surface a paint of the group would make, made once. A box that
draws nothing over itself, faded a thing at a time before, is drawn as a
group so too where it has no text in it, and comes out a level or two of
255 apart on the edges of what it draws: Zen Garden 214's enso, an image
an animation scales and fades, was set from its paths at every paint, and
a frame of a resize of the page's wide layout went from 24 ms of paint to 20. Two things are load-bearing. **The box is drawn from the pixel its
corner is snapped to** (`paintTransformed`), so its place on the surface
and the surface's own are worked out from there, and a move of a fraction
of a pixel finds the surface it drew; from the box as laid out, a drag
moving it 0.8 of a pixel a step found none. And **what a frame's build
changed inside it** (`SpriteSource.stale`) **has the group painted again
whole**, as a surface kept for a box takes it.

**A filter's colour functions are run over pixels read back, and what
lags is the content, never the filter** (`paintFiltered`,
`src/html/filters.ts`). A filtered box's group is painted on a surface
kept by element. Where the context runs a filter itself — react-x11's
native one takes the colour functions as canvas's `filter` — the group is
drawn through it onto a second kept surface (`through`), again only as the
group or the filter changes, and nothing lags. Everywhere else none runs a
filter and none hands a surface's pixels over as it is asked — ntk's are
the X server's, a round trip away — so the group is read back, and every
paint runs the matrices the box has now over the newest pixels read for
it. A context whose `filter` does not stick for a list sends every box to
the read from then on (`unfiltered`), and is asked with `in` first, since
assigning an unknown property sticks on any object. Five things about the
read are load-bearing, and one about what a filter reaches past the box.
**A blur is ink, and the surface is as large**: `filterOutsets` grows a
box's bounds by three deviations a `blur()`, before its clip path and its
transform cut and move them, so the damage of the strip a glow falls in
reaches the box and the group is painted on a surface that holds the
glow; the blur is canvas's `filter` where a context runs one and
`blurPixels` over the read elsewhere. A list with a `drop-shadow()` is
run in its steps, in the order written (`ColourFilter.steps`): a shadow
is cast from what the functions before it made, and the ones after run
over it, so its matrices and its blur no longer say what it does. **Anything new a filter draws past
the box joins `filterOutsets`**, or it is cut at the box's ink.
**A read is made stale, never dropped** (`stale`, through
`_dropSprites`): a page whose animations build the document every frame
— ekazinich.com's — dropped the read at each build, and those frames drew
what was filtered last, at the amount it had then, between frames at the
amount they had, so its hover flashed between grey and colour. **The
surface is the box's size and a pixel, wherever the box's corner falls**:
sized from its edges it was one height and the next alternately as a
hover lifted the card a fraction at a time, and a read of the other
height drew nothing. **A move a fraction of a pixel at a time reads
nothing**: where the box's corner falls within a pixel is out of the
read's key, the read is drawn with its corner where the box's is now,
resampled, and a read arriving while the box moves paints nothing of its
own; once it has been still for `SETTLE_MS` it is read where it is
(`placed`). Read at each frame, ekazinich.com's turning phones were drawn
crisp by reads landing between frames and resampled at the frames, and
shimmered. **Anything new that changes what a box draws makes
the reads around it stale**, as it drops the surfaces kept around it —
`_dropSprites` does both. And **a context from ntk's `getContext` is the
caller's to destroy**: a surface kept and written each frame keeps the
one it was made with. A filtered element is neither lifted onto a layer
nor in one, and no video is mounted in one: neither runs the matrices.
The core seam that lifts the round trip — `ctx.filter` — is planned in
`docs/prd-filter.md`.

**A backdrop is painted again, not read** (`paintBackdrop`,
`makeBackdrop`): `backdrop-filter` draws the document behind a box — from
its canvas up to the box, over the box's border box, at a scale that keeps
the blur's deviation two pixels across, its edges mirrored out — through a
surface's `filter`, `blur()` and all, which react-x11's native context runs
and ntk's does not. Three things are load-bearing. **A paint that makes a
backdrop stops at its box**: `paintBox` returns there, and `stoppingAt`
drops every draw after it, so a thing painted after the box from outside
`paintBox` — the root box's outline is one — stays out. **A backdrop is
made once a paint** (`BackdropPaint.made`) and a later box's draws it
again, or each box would paint every earlier one's, twice over. And **a
large draw on macOS is clipped by whole-pixel rectangles where it can be**
(`inBorderBox`, `castOutside`'s rule): through its rounded outline alone,
a glass card's backdrop cost a quarter of a frame. Anything new that
gives a box a filtered surface of what is under it starts from here.

**A gradient's stops are handed over as CSS mixes them** (`addStops`):
premultiplied, where canvas — and CoreGraphics — mixes them straight, and
a stop of no alpha faded a colour through grey. Anything new that adds
colour stops to a context's gradient goes through it.

**A repeating gradient is unrolled where its box is known** (`unrolled`):
its stops laid down again along a linear one's line or out to a radial
one's farthest corner, as the gradient that draws the same there, which
every path a gradient is painted along — runs, a strip, a raster, a fill —
then takes as it is. `gradientTile` and `gradientFill` unroll it, and
**anything new that reads a gradient's stops reads them after
`unrolled`**: one period of stops leaves out the hard edge at each period's
end, which is why `smoothScale` declines a repeating one.

**Mask layers are composited one at a time** (`compositeMask`): a layer
that is not `add` is painted on a surface of its own and drawn whole over
the layers below with its operator, since an operator reaches only what a
draw covers on every backend (react-x11's `globalCompositeOperation`), and
a layer's shapes drawn straight on the mask left what an `intersect`
empties as it was. A card outlined by a ring, its border box less its
content box with `exclude`, was tinted all over.

**An animation a layer can carry is handed to core as a sprite**
(`src/html/sprites.ts`; react-x11's `sprites()`, sidorares/react-x11#819).
On macOS the surface presenter lifts it onto a layer of its own and the
render server runs it: a fade and a turn on a page paint no frame. Five
things are load-bearing.

- **A lifted element is a hole and no frame of the clock's.**
  `PaintOptions.lifted` is checked at `paintBox` and `paintTransformed`,
  the two doors a box is painted through. `_skipLifted` is handed to the
  timeline's `live` and `nextFrame`. **Anything new that paints a box, or
  asks for an animation frame, honours both.** What is lifted is an
  element's own animations or a pseudo-element's (`_lifted`, keyed by
  both), and a `::before`'s box has no element of its own
  (`GENERATED_FROM`), so the lifted set is read as boxes
  (`_liftedBoxes`) and the skip asks of a target, the element and the
  pseudo-element, never of the element alone.
- **A part is made once and kept by a stamp of what it is made from.** Its
  frames are sampled on a fork of the timeline (`AnimationTimeline.fork`),
  which leaves the document's as it was, sixty styles a second of cycle.
  **Anything new that changes what a lifted box draws without a build
  bumps `_spriteGen` and asks for a frame (`spritesChanged()`)**, as a
  restyle in place inside one does: a lifted box's hole claims no damage, so
  nothing else would bring the frame in which its layer is painted again.
  The part is made again then, and its frames are kept apart, by its
  style, the style it inherits from — compared by value where a build made
  the root box's again — and its animations, with its box's size
  (`Sampled`): a spinner turning in a lifted card paints the card's layer
  again at each of its frames, and sampled the card's whole cycle at each
  as well until the frames were kept so. Not by the box, since a build
  that keeps the element's style makes new boxes: Zen Garden 219's
  marquees build the document at every frame, and every lifted part
  sampled its cycle again at each.
- **A point is hit where the layer has the element.** A lifted element's
  style stops at the lift, so every hit test first restyles the lifted
  elements whose animation moves them to now (`_followLifted`). That
  restyle repaints nothing, makes no part again and lays nothing out: their
  pixels are their layers'. **Anything new that hit-tests the document
  follows them first**, as `elementAtPoint`, `cursorAt` and `textIndexAt`
  do.
- **What is handed over is made fresh every frame from the kept part.**
  Core reads an animation's `delay` when it attaches it, counted from that
  frame, and a document that scrolled has moved every rect.
- **What a layer may cover is decided in the order the document paints.**
  A layer is drawn over the whole document, so it is right where nothing
  painted after the element reaches anywhere the element can be, and
  whatever is painted before it may: `paintedAfter` (`paint.ts`) walks
  `paintContent`'s order — the layers after it in its stacking context's
  list, that context's outline, and the same up to the root. **Anything
  new that paints after a stacking context's layers, or reorders them,
  is in `paintedAfter` as well**, or a layer covers what is drawn over it.
  A box fixed to the viewport is asked about every frame instead
  (`fixedWithin`), since a scroll moves it over the document; and where
  the element is in no list — under its flow, in an inline box that is a
  stacking context — the old test stands, no ink but its own and its
  ancestors' within reach (`crowded`). An element fixed to the viewport,
  or in one that is (`drawnAtViewport`), is the other way round: its
  layer is placed from the viewport's corner (`Part.atViewport`) and
  painted there (`paintLiftedBox`), the fixed boxes painted after it are
  asked about once, where it is, and everything else painted after it
  over the whole document a pane scrolls under it. The boxes that clip
  the element cut its layer to a rectangle (`clipFor`, the sprite's
  `clip`, react-x11#827), or to one with round corners where the element
  reaches a rounded box's (`clipRadius`, react-x11#838) — one circle's at
  all four corners, held by every other clip, since one box takes one
  shape — and what shows through it is all any of this is asked of.
  **Anything new that clips a box joins `clipFor`**, or a layer shows
  what the document cuts away. A part offered with the element and painted
  after it is not what covers it: its layer stands over the element's,
  and the presenter takes the element off its layer in any frame it turns
  that part down where the two meet (react-x11#852). So the parts are
  listed in the order the document paints them and asked from the last
  painted down, each past the later ones that were kept (`coveredAfter`).

**A part inside another's box goes in that part's layer** (`parent`,
react-x11#842). `sprites()` offers the lifts an ancestor's first, and a
lift whose box is inside an offered part's is offered inside it: `partOf`
asks only about the boxes between the two (`liftableBox` and `clipFor`
stop at the parent's box), and places it in the space the parent's
raster is drawn in — layout moved every box inside a part by the part's
translation, so a part's `translation` is its own and its parents', and
a child's `rect` and `clip` are the document's less its parent's. The
presenter hands a parent's paint the keys of the parts it lifted inside
it, which it leaves out (`_holesOf`), and paints it again when they
change; the element hears which are lifted only after that paint, so
the knowledge has to be the presenter's. An element and its `::before`
are two lifts like any others: the pseudo-element's box is in the
element's, so it goes in the element's layer, where the two had gone one
at a time and a button that pulsed with a spinner in its `::before` kept
both on the document's clock.

**A transition is lifted as an animation is.** Its frames are sampled
from its start to its end, a track for the opacity and one for the
transform's fields (`liftOf`), each on a fork of its own: a fork runs a
transition to its end and keeps it there, so a track that began earlier
would find it over. It is offered in its delay too, since the bridge fills
a delayed animation backwards and the layer holds where it starts, as the
transition does. A transition is never changed but replaced, and its
`serial` is the track's id, so one turned back is a new animation on the
layer from where the old one had come to. The restyle that turns it back
is in place: the opacity is named in `will-change` on both sides of 1, and
the paint order is what it was (`hoverChange`).

**A box's shadows in transition go on a layer of their own, and the box
stays the document's** (`shadowLiftOf`, `shadowPartOf`, react-x11's
`Sprite.shadows`). A card's hover changes its border colour and its shadows
together, so the box cannot be lifted, but its outer shadows can: they are
a part with no `paint`, sampled from the timeline as a transform is, and
the document leaves them out of its paint (`PaintOptions.shadowless`) and
out of a box's ink (`_inkOf` answers its border box). **Anything new that
reads a box's ink, or paints its outer shadows, asks `shadowless` first**,
or a frame repaints the whole glow the layer already shows. The keys are
apart from `_lifted` (`_offeredShadows`, `_shadowsLifted`): a box whose
shadows are lifted is no hole, and its clock runs.

**A box out of the plane is lifted with its whole 4×4, and one that is
still is lifted too.** A part's matrix is then each frame's `matrix3d()`
about the depth of the transform origin, seen in the perspective the
document sees the box in, about the point the layer turns about
(`solidFrames`); core takes it in device pixels and hands Core Animation
points (react-x11 2.39.0, react-x11#859). A box the document draws
through a projection and whose own animation is not under way is a part
with none (`stillLiftOf`), because on macOS the document draws it a tile
at a time, and CoreGraphics' medium interpolation resamples the whole
surface a tile is cut from for each one, at every paint that reaches it:
Zen Garden 219's tilted sidebar was most of every frame there, and a
browser gives every box with a 3D transform a layer anyway. Three
things are load-bearing. A part out of the plane is a layer of the
window's alone (`liftableBox`'s `within`): in a parent's layer it would be
seen in the parent's plane, which a perspective outside the parent does not
move with. A box that shows its back under `backface-visibility: hidden` in
any frame stays the document's, since a layer draws the back the document
leaves undrawn. And the boxes a tree turns out of the plane are found by a
walk, once a tree and only where the builder saw one (`BoxTree.tilted`);
a restyle in place that turns a box in or out sets the flag and drops what
was found (`_tiltedKept`). **Anything new that can turn a box out of the
plane without a build does the same**, or the box is drawn a tile at a
time with a layer to be had.

**What the document paints over a part out of the plane goes on a layer
too, and a part is painted again only where what it holds changed.** A box
painted after such a part and within its reach would keep it in the
document, so it is made a part of its own with no animation (`overLiftOf`)
and its layer stands over the other's, as Chrome gives an overlapping box
a layer: 219's preamble hangs over a corner of the sidebar
(`coverersAfter`, the walk `paintedAfter` shares). All of what is over it
or none, no more than `MAX_OVER_PARTS`, none larger than what shows the
document, which would be a raster as large, and never for a part in the plane,
which the document draws as cheaply as what is over it — the badge over a
fading card stays the document's. And a part's `version`, which a
presenter paints its raster again for, survives a build a frame made for
boxes laid out apart, where none of them is the part's element, inside it
or around it (`_quietBuild`, `repaints`): the marquees beside 219's
preamble repainted its layer at every frame before. A root of that build
inside a lifted part claims nothing of the document's — its ink is a hole
— and asks for the frame that paints the layer instead (`spritesChanged`).
**Anything new that builds the boxes again and can say what it changed
records it the same way**, or every part on a layer is painted again with
each build.

**A custom highlight's style is worked out as it is painted, and on ntk
its text is drawn again, never cast.** `BoxTree.highlightStyler` asks the
cascade for an element's `::highlight()` when a paint first lights it, so
what that style reads — a container's size, a rule a told change turns on
— is no element's, and nothing restyles for it: the paint sizes every
container first (`Cascade.sizeContainers`), and both move
`highlightGeneration`, which drops what the styler kept. **Anything new a
highlight's style comes to read moves it too.** Its colour, and its
shadow, are drawn from a copy of ntk's layout whose runs are cut at the
highlight's characters (`cutRun`, `inColours`, `onlyOf`), since ntk's text
shadow sets each run on a whole pixel and a cast glyph came out a pixel
aside; other engines cast, clipped to the bands.

**`::target-text` is a highlight like the page's, and the fragment
directive is nobody's URL.** The text a `#:~:text=…` names
(`text-fragments.ts`) is lit through the same `_litRanges` as a page's
`CSS.highlights`, its rules kept among theirs under `TARGET_TEXT`, a name
no `::highlight()` can write, and the UA sheet styles it — so
`Cascade.hasHighlights` holds in every document, and a gate that asks it
has to ask whether there is anything to light as well. And the directive
is taken off before anything reads the fragment: `_updateBase` splits it
(`splitFragment`) before it finds `:target`, and `DomHost` drops it from
the URL a page's `location` reads. **Anything new that reads `baseUrl`'s
fragment splits it the same way**, or `#sec:~:text=a` names an element
called `sec:~:text=a`.

**A highlight registry is its window's, and the host is told once a
task.** The page's `CSS.highlights` and each frame window's (`CSS` is in
`OWN_PER_WINDOW`, `registryFor`) are in `highlightRegistries`, and
`sendHighlights` tells the host each one's ranges with its document's id,
from a microtask `highlightsChanged` queues: a search that adds a thousand
matches one at a time sent every range a thousand times. The host keeps
them by document (`_highlightSpecs`) and hands each to the `<Html>` that
draws it, its ranges in another document left out. **Anything new that
changes a highlight or a registry calls `highlightsChanged`**, and nothing
reads them back from the host in the task that changed them: what a page
asks of them, `highlightsFromPoint`, is answered in its realm. A
highlight's `getComputedStyle` is not the painter's styler but
`Cascade.highlightPseudoStyle`, down the flat tree and with no UA rule in
it (the UA's look is a paired default, CSS Pseudo 4, 3.3.1): the two are
asked different questions, and one built on the other came out with
`::target-text`'s `Mark` on every element under the root.

**An inline element's opacity is in the colours its text is set in.**
What an inline box holds is drawn on its block's lines, and a paragraph's
text is one batch of glyphs, so the fade of the inline boxes around a run
goes into the run's colours where the run is made (`collect`, `fadeRun`).
**Anything that makes a run again folds the fade in again** —
`restyledRun` and `firstLineColour` for a first line, `reinked` for a
restyle in place, which compares a run with what its style makes, fade
and all, and re-inks every run under an inline box whose opacity changed
— or that text is drawn at full strength with nothing failing. What else
is on the lines is faded where it is painted (`inlineFade`), and none of
it may be text faded through the context's alpha, which ntk's glyphs do
not take (`fadesGlyphs`).

**A shadow tree is built where a browser's parser builds it, and drawn
through the flat tree.** The handler attaches a declarative shadow root as
the parser meets its template (`Handler._shadowRoot` in `dom.ts`), so the
DOM is a browser's: the host's `children` are its light children, the tree
hangs off it (`shadowRootOf`), and every walk by `children` — the scan, the
forms, `getElementById`, `:first-child` — stays in the tree it started in,
as the DOM's own walks do. What is drawn is `flatChildrenOf`. Three things
are load-bearing. **Anything that inherits, hovers or is within goes up by
`flatParentOf`, not `parent`** — the builder, a restyle in place's parent
style, the hover chain, `:focus-within`, the Tab order: from the top of a
shadow tree `parent` stops at its root, and from a slotted element it skips
the slot. **A rule is filed under its tree** (`IndexedRule.scope`) in the
one set of indexes, the trees whose sheets read alike sharing one set of
rules, and a sharing key says which tree an element is in and which it
hosts: a `<b>` assigned to a slot in one card and the `<b>` that slot falls
back to in another have parents of one key, and are styled by different
trees' rules. And **between trees,
context decides before specificity** (`byCascade`): a candidate carries its
tree's depth, which in a document with no shadow tree is 0 everywhere, so
that document orders as it always did. The rules at a tree's edges —
`:host`, `::slotted()`, `::part()` — are not in the indexes a restyle in
place asks, so one that tests the pointer or the focus builds the boxes
again on a change of it (`Cascade._noteEdge`); and they are compiled as the
sheets are read, so the cascade's css-select adapter exists before the
first sheet does.

**A sheet a shadow root adopts is the tree's last sheet, and the host has it
once.** `root.adoptedStyleSheets` is the document's array (`adoptedArray`,
`setAdopted`), but where the document's reaches `<Html>` as the `stylesheet`
prop, a root's stays with its tree. The realm numbers a sheet as a root first
takes it and tells the host its text (`adoptedSheet`, once an edit, however
many roots hold it) and each root the numbers it holds (`adoptShadow`, only
where they moved), and `ShadowRoot.adopted` is one `AdoptedSheet` for all of
them. `facts()` reads them after the tree's own sheets, so from there they
are a `<style>` in the tree: trees that adopted one sheet are one set of
rules (`_sheetsKey`), a Lit element's second instance makes no cascade, and
what a change reaches is the host and what it holds (`_sheetsAdded`). Lit
looks for `adoptedStyleSheets` on `Document.prototype` alone and then sets it
on every root it renders, so a root that takes the sheets and does nothing
with them drops a component's styles with no error. Three things are
load-bearing. **Anything new that changes what a constructed sheet says ends
in `readopt`**, which is why `disabled` is an accessor, or the roots holding
it read what it was. **Anything that changes `adopted` tells a `shadowRoot`
record**: `touch` is what makes the next scan a whole one, and a scan
extended from the last (`_extendFacts`) keeps the text it read. And **an
adopted sheet's `source.element` is null** (`SheetRef.constructed`): its
ref's `element` is the host, since an import is asked for by an element, and
a developer's tools read a `<style>`'s text off the element they are given.

**A read of an element's style or box from a page's script costs a
lookup.** `_boxOf` finds an element's first box by the tree's index of
first boxes (`_firstBoxesOf`), and a box a drag set aside, which the index
holds and no walk from the root reaches, by the walk; and `_styleOf` keeps
the style it works out for an element nothing draws (`_unboxedStyles`)
until the tree, the cascade, the document's nodes (`treeGeneration`) or
what the boxes were styled and laid out as (`_geometry`) moves. Apple's
product pages read `getComputedStyle` and `offsetTop` tens of thousands of
times a load, of their closed dialogs' contents a property at a time, and
the walk and the styling were a third of what their script took.
**Anything new that changes the style of what nothing draws without moving
one of those drops `_unboxed`.**

**A video is core's `<video>`, mounted over the box, and never drawn
here** (`media.ts`, `videos.ts`; core's `docs/architecture/video.md`, 8.2).
The control rule again — a drawn video is a picture of a video — and the
same seam a host answers everything else through: `onResource` is asked
for each source as `kind: 'video'`, and answers with a `src` the platform's
player opens or a `VideoFrames` sink it feeds. The document lays the box
out and paints its poster as before, and the player, transparent until it
has a frame, goes over it, so nothing in the paint changes but the frame a
mounted video with no poster is not drawn in. Four things are
load-bearing. **What the document paints after the video over its picture
is painted again over the player, or no player is mounted**, the sprite
test (`coverersOver`, `crowded`), because a sibling over the document hides
what is drawn over the video. Up to four such boxes, cut by a rectangle, go
on a `<canvas>` after the player (`coversOf`, `paintCovers`), as a sprite's
coverers go on layers of their own (`overLiftOf`): GitHub's hero has a play
button in its video's corner. Each is painted as the document paints a
layer (`paintCover`), through its own matrix, opacity and filter — not
`paintLiftedBox`, which leaves those to the layer — and nothing around it
may group it with the video: a cover is a layer of a context the video is
in, so a box around it that fades or filters it fades or filters both, as
one group, which a player and a paint over it are two of. The canvas takes
no opacity of the video's for the same reason. A video in a box's flow —
diabrowser.com's hero, under a sticky dock with a blurred, faded halo in
it — is under what is painted after the box it is painted with
(`flowLayerOf`), and under what that box's flow paints over it, in any pass
(`flowMeets`), which keeps its poster. **Anything new the paint draws a
layer through goes through `paintCover` as well**, or a cover over a
player is drawn without it. A video under anything else keeps its poster,
by design. **The walk asks what a later layer draws over the picture, not
how far it reaches** (`inkMeets`, the rule the next paragraph states):
taking a layer at its ink bounds, GitHub's empty box over its hero's video
and its header's hidden mega menu each kept the video its poster. **A
video's sources are chosen once** (`_videoChoice`), by their `media` where
the video is first shown, and again only where its sources change, as
HTML's resource selection runs once: chosen at each layout, a window
dragged across a breakpoint would start the video again. And **a mounted
player is one React element for its element and source**, cut, rounded and
faded by the boxes around it (`renderVideo`'s three boxes): a new element
is a new player, and the video starts again. The boxes fixed to the
viewport are asked about at each paint (`_publishMedia`), since a scroll
brings a header over a player and lays nothing out — those the document
paints after the element alone (`fixedOver`, by `paintOrderOf`), worked
out as the rects are laid out: a fixed box before a frame in the paint
order is under it, and joshwcomeau.com's like button, fixed beside its
article, hid every playground's frame it was inside.

**What an `<iframe>`, a `<canvas>` or an `<embed>` shows is the host's,
mounted over its box** (`renderEmbedded`, `embedded.ts`). The document
lays each out as an empty box of its size and loads and runs nothing for
it; the host is handed the content box (`EmbeddedRect`) and what it returns
is mounted beside the document as a player is, held to the same rules
(`placementOf` in `media.ts`, shared with `mediaRectsOf`). **A mount is
keyed by its element**, so a layout or a scroll that moves an `<iframe>`
keeps the document in it and its scripts: anything new that reports these
rects keeps the element as the key. **What happens in a mount is the
mount's**: a key or a press there bubbles out of the frame's own `<Html>`
to the root of the page's, and the frame's node answers `elementAtPoint`
and `hrefAtPoint` as the page's does, so **anything new the root does with
an event asks `embedded.contains` first**. The press handlers did not, and
the page toggled back every summary a frame opened — joshwcomeau.com's
interpolate-size playground did nothing on a click — and followed the
frame's links and sent its forms itself. **Only what draws something covers a mount,
or a player** (`drawsNothing`, `inkMeets`): a box faded to nothing or
hidden all through — Docusaurus's menu backdrop, fixed over the viewport —
and the overflow of a pane beside it that a box clipping it cuts away
neither cut a mount nor refuse it. They had: a subtree's ink is the union
of all it holds, CodeMirror parks an element ten thousand pixels up, and
the react-x11 playground's frame was refused, then cut to the strip below
the window. Anything new that asks what is over a box looks into a subtree
whose ink meets it, and passes over what draws nothing. The browser example mounts another
`<Html>` with the frame's document in it. **Nothing mounted beside the
document may sit where its clips leave nothing of it**: core's scroll pane
reaches as far as a box under it does, clipped or not, so a mount or a
focus stop at its own place in a scroll container's hidden overflow made
the page that much taller — up.com.au's, nine thousand pixels. A clip that
empties is kept inside the box that emptied it (`clipFor`'s `cut`), and a
mount and a stop are placed inside their clips (`shownBy`); anything new
mounted beside the document goes through one or the other. **And what is
mounted for a box fixed to the viewport goes in a box core keeps there**
(`AT_VIEWPORT`, a position `registerHtmlView` registers with core's
`registerPosition`): the document draws such a box where the pane's
viewport is however far it has scrolled, and a widget mounted at its rect,
at the document's top, scrolled away with the text from a fixed header
that stayed. Core moves the box in the pass a scroll runs, as it moves a
sticky header, so the widget lands with the header in the frame that
scrolled and React hears nothing of the scroll. Reported again at paint,
as `_publishMedia` re-cuts the players, it landed a frame late and
rendered every widget at every frame of a scroll. The positioned box is
inside a box at the element's corner (`atViewport` in `widgets.ts`): a
position moves a box laid out in the flow, and a pane reaches as far as
its content is laid out, not as far as it was moved, so in the flow after
the element it sat at the document's foot and the page scrolled that much
past its end to the widget. An embedded element in a box fixed to the
viewport is mounted in the same box (`EmbeddedRect.atViewport`), and the
fixed boxes the scroll moves the others under do not cut it.

**A sticky box the viewport holds cuts a mount as a fixed box does, and
refuses none** (`heldSet`, `heldOver`, `cutByFixed`'s `held`). The pane's
scroll moves it over the document without a layout, so `placementOf` passes
it over for an embedded element, and the mount is cut where it is held at
each paint. joshwcomeau.com's header is one, a white bar and its links over
it, and a playground's frame scrolled up under it was refused its mount
and was blank. A player keeps its covers instead, which paint a held box
over it where it is (`coversOf`); a frame has none. Three things are
load-bearing. **A box cuts by where it draws in the rect** (`inkWithin`),
not by its bounds: the links' bounds reach past the bar for their icons'
labels, and would cut a strip off the frame that nothing covers. **A box
that leaves no rectangle is asked again after the others have cut**, so the
order they are listed in does not matter: the links come first in the tree
and only the bar under them takes a band. And **the band is taken off what
the pane shows** (`cutByFixed`'s `viewport`): a frame scrolled half away
above its pane has the header across its middle, and hiding it for that hid
the half that shows, under a fixed header as much as a held one.

**What a mask makes transparent is no ink** (`maskShows`, in `walkInk` and
`drawnInk`). A masked box shows itself and what it holds only in its
border box, and only where some layer of its mask is not transparent: a
gradient straight down or across reaches as far along it as its stops show,
and an image all of its painting area. The site's frosted header in its
dark scheme is a layer of glass that reaches 100px past the bar, for its
blur to catch what comes up under it, masked to the bar, and a frame under
it was cut 100px below the bar, more of it blank the further it scrolled
up. **Anything new that reads what a box draws asks `maskShows` where the
box is masked**, or takes the box for its bounds; it answers for the box in
its own plane, so one drawn through a matrix is taken at its bounds still.

**A scale the same both ways is a rectangle a mount can stand for, and
the mount is drawn at it** (`zoomBetween`, `evenScaleOf` in `paint.ts`). A
slide deck fits its stage to the window with `scale()`, and an `<iframe>`
on a slide was refused for being drawn through a matrix: its realm ran in
a `FrameHolder` and nothing of it was drawn. Where every matrix around a
box is a scale the same across as down and a move, `placementOf` maps the
content box and the clips through them to where they are drawn
(`clipFor`'s `zoomFrom`), and an embedded element's rect carries the
factor (`EmbeddedRect.zoom`), which `embedded.ts` hands to core's `scale`
prop on a box the element's own size before it — so the frame's document
is laid out at its CSS size and its text shaped at the size it is drawn
at, the zoom `<Flow>` gives a body. Three things are load-bearing. **What
is under a matrix is laid out in the coordinates before it**: the walk
for what is painted after the box is asked in the box's own coordinates
and taken up through each context's matrices (`paintedAfter`'s `zoomed`),
and `crowded` asks what each box on the path holds in that box's own
(`extentIn`); asked in the window's, a page's text beside the frame on
the slide reached a frame drawn somewhere else. **The scale box is always
there**, at 1 where nothing scales the element, so a frame whose stage
comes to fit the window exactly is the same node, and its document is
not started again — and is styled again when the factor moves
(`_followScale`): a frame's script zooms the `<iframe>` its document is
drawn in once it was laid out, and core lays the document out again at a
width it may have had, under styles whose lengths are device pixels of
the old scale. And **a cover is never painted over a scaled player**
(`coversOf` is not asked): it is painted where it is laid out, through
its own matrix and through no matrix around it, so such a video keeps
its poster. A turn, a
skew, a flip, two factors and a projection still refuse; a widget is not
held to any of this, since `controls.ts` mounts it where the box was laid
out.

**A box in the top layer is reached by nothing around it**
(`Box.topLayer`, CSS Position 4): a dialog a page's scripts opened with
`showModal()`, which the cascade gives `overlay: auto` (`isModal`), and
its `::backdrop`, a box of its own before it. The box stays where its
element is in the tree, so every walk from the root — the widgets, the
stops, the selection, the ink — finds it as it finds any box; but no
stacking context has it among its layers, `paintDocument` paints the
tree's (`topLayerBoxes`) after everything else, and the hit test asks
them first. Two things are load-bearing. **Anything new that walks up
from a box for what it is under — a clip, a matrix, an opacity, a
filter, a containing block — stops once it has passed a top-layer box**,
as `fixedToViewport`, `containingBlockOf`, `clipAround`,
`throughTransforms`, `controlRectsOf`, `liftableBox` and `offsetParentOf`
do, and the
layout's `containingBlockFor` answers as paint's `containingBlockOf`
does: the viewport for a fixed one and the root for an absolute one,
whatever transform is around it. A walk that went on past it would draw
a dialog in a transformed card through the card's matrix, centred in the
card, which is why `test/html/html-elements.test.ts` scales, clips and
fades the box its dialog is in. And **what a modal dialog blocks gets no
widget** (`blockedByModal`): a widget is a node over the document, which
the backdrop is drawn under, so the page's fields would be drawn over the
backdrop and over the dialog where the two meet.

**A view transition's tree is boxes in the top layer, and what it
captured is a hole** (`src/html/transition.ts`). The page's realm runs
the transition's steps and asks the element to capture each state; the
element keeps the old state's pictures, and from the new state on the
builder hangs `::view-transition` and its groups, pairs and images off
the root element's box, over every other top-layer box, styled by
`Cascade.transitionStyle`. So layout, borders, opacity and the hit test
are the document's own. Four things are load-bearing. **A captured
element is in `PaintOptions.captured`, never `lifted`**: `lifted` is the
macOS presenter's, and a top-layer box inside a captured element is
skipped with it. **The tree's animations run on the transition's own
`AnimationTimeline`**, which the document's frames never see; the
transition arms its own frame and builds again at it. **A new image is
painted straight onto the context where it is drawn at its size**: a
picture of it on a surface rounds a faded element a level off, which a
reference drawn directly does not. And **a named element is a stacking
context** (`stacksLayers`), or a capture of it leaves out its positioned
descendants, which another context paints.

**A scroll container scrolls by moving its content, as `position:
relative` does** (`layout/scroll.ts`). After layout, `applyScrollOffsets`
moves each container's lines and boxes by the offset its element is
scrolled to, kept by the node in CSS pixels across builds and layouts, and
its clip cuts them as before. So nothing that reads a box knows there is a
scroll, and that is the design: the hit test, the selection, `elementRect`
and every mount were right the first time they ran. Four things are
load-bearing. **What a container moves is what it is the containing block
of** (`translate`'s `stays`): an absolute box positioned against something
outside it, and a fixed one, stay, as they are not clipped by it either.
**A scroll without a layout recomputes the ink bounds of the whole tree**
(`_scrollBox`), since they and the culling indexes built with them hold
document coordinates; it moves the boxes, then reports the controls, the
media, the embedded rects and the stops again. Anything new that keeps a
box's position past a layout is redone there too, or a scroll leaves it
where the content was. **A layout that stops where the viewport ends
stops inside a scroll container where its scrollport ends** (`layoutBox`,
`scrollerUntil`): what a container holds is where it is scrolled to, so it
stops a viewport past what it shows, moved down by its offset — the one
the node hands the tree before the layout (`wantedScrollTop`) — and a
drag's partial layout once set aside what a scrolled `main` was showing,
measured against the document's viewport. What it set aside keeps its
scroll height (`ASIDE_REACH`, which `extentOf` counts), or the offset
would be cut back to a shorter content and the sidebar would jump; and a
container scrolled while a layout that stopped holds has the document laid
out whole (`_scrollBox`). It keeps nothing above (`keepIn` returns at
one). Wikipedia's menus, RFC 9110's contents and the docs sites' sidebars
were laid out whole at every step of a drag. And
**a layout puts the boxes back where no scroll has them**, so the offset a
box was moved by is cleared for every box the layout visits
(`APPLIED`), or the next scroll moves it by the difference from an offset
it no longer has.

Three things sit on that. **A sticky box is placed again at every scroll
of its container and after every layout** (`restickWithin`,
`restickAll`), from where the flow has it: `STUCK` holds how far it was
moved, and a container's reach is measured with every sticky box taken
back by it, or a footer stuck at `bottom: 0` makes the container shorter
by its height. One the viewport keeps (`VIEWPORT_STICKY`) is the
element's to place, since the pane's scroll lays nothing out
(`_followViewport`, `restickToViewport`), for the offsets the pane has
now (`_scrolledOrigin`), the next pass's: **anything new that reads where
a box is follows the viewport first**, as a paint, a hit test, a layout
and `elementRect` do, and the pane's blit is told where each was drawn
held and where it is held now (`viewportFixedRects`), or its copy drags a
held box with the text. **What is pinned is what draws** (`drawnInkOf`):
a held or fixed box is told by its ink less every subtree in it that
draws nothing, since a pinned rect is repainted at every frame and past
three quarters of the viewport the scroll is a repaint. Docusaurus keeps
its menu's backdrop, fixed over the viewport and hidden, in its sticky
navbar, and every Docusaurus page repainted its whole pane at each notch
of the wheel. **The scroll keys are `<Html>`'s root's**, since clicking a
document focuses it and core runs `defaultKeyDown` on the focused node
alone: `scrollForKey` chains from the focused link or the last press out
to the pane. And **the bars are a pass of their own at the end of
`paintDocument`** (`paintScrollBars`): a container that is no stacking
context is painted in its context's flow passes, and nothing of its own
paints after what it scrolls. A press on one is the node's
(`defaultMouseDown`), and `<Html>`'s capture handlers keep it from the
links and the page (`scrollBarAt`).

**A scroll snaps by how it moved** (`layout/snap.ts`'s `SnapScroll`): an
absolute one to the place nearest where it went, a relative one only ahead
of where it began (`from`) and never past a `scroll-snap-stop: always`, a
page within a snapport of where it began first (`page`), and one that
brings an element into view with the element lined up (`lineUp`, the
`target` of `scrollElementTo` and `snapViewport`). **Anything new that
scrolls a container or the viewport goes through `_snapScroll` or
`_snapViewportAt` and says which kind it is**, or a snap container comes to
rest between its places, or a carousel skips a slide. The viewport's
re-snap runs after the layout has said how far the document reaches
(`_documentHeight`), and asks the pane again once the frame is over
(`_scrollPaneTo`): inside the pass the pane still has the extent from
before, and clamped an area that the layout moved down past it to where
the document used to end.

**A vertical writing mode is a frame turned a quarter, and the layout in
it is the horizontal one** (`layout/writing.ts`). A block container whose
writing mode is vertical in a horizontal parent is an orthogonal flow's root
(CSS Writing Modes 4, 7.3); the builder moves what it holds into an
anonymous block, its frame, whose transform is the quarter turn
(`makeFrame`), so paint, the hit test, the damage, `elementRect` and the
layers all go through it as through any transform. The root is laid out by
its parent in the page's axes, and lays its frame out in the flow's
(`layoutFramed` in `block.ts`): the frame as wide as the root is tall, fit
to its content within the room down the page — the containing block's
height, or the viewport's, which marks the layout as reading it
(`readsViewportHeight`) — and the root as wide as the frame came to down its
block axis, which is the root's intrinsic width at its least and its most
(`intrinsicWidth`). Six things are load-bearing.

- **A box in a frame has its style turned** (`framedStyle`): its physical
  sides, sizes, corners and shadow offsets handed to the frame's, so the
  horizontal layout reads the flow's block and inline sides where it reads
  top and left. The element's own style, the cascade's and a script's, is
  the page's, and a turned style is no element's: a restyle in place finds
  `box.style !== kept` and builds. **Anything new that hands a box in a
  frame a style from the cascade turns it, or builds**, and **anything new
  that reads such a box's sides or sizes for the page turns them back**
  (`pageSides`, as `getComputedStyle` does; a widget's rect through the
  frame's matrix, as `controlRectsOf` does).
- **The gate is the tree's** (`BoxTree.vertical`, set by the builder):
  `framed.any` is set from it as a layout, a paint or an anchor walk of a
  tree begins (`layoutDocument`, `paintDocument`, `paintCapture`,
  `paintLiftedBox`, `paintCover`, `anchorAt`), and every per-box question —
  `FRAMES.get`, `FRAME_ROOTS.has`, a box's writing mode in the inline layout
  and in `paintLinePart` — asks it first, so a document in no vertical mode
  pays a boolean. Anything new that lays out or paints a tree from another
  entry sets it there; anything new that asks a box whether it is a frame's
  asks it first.
- **The root is a formatting context of its own with no baseline across
  its line** (`establishesBFC`, `lastBaselineIn`, `firstBaselineIn`): an
  inline-block one sits on its bottom margin edge. Its words say nothing of
  its width (`exactMinContent`, `wordBound`), and its frame is laid out
  whole: `until`, `reach` and `keep` are heights down the page, and the
  frame's heights are across it. An anchor walk stops at the root.
- **What a vertical line sets upright is a run a character, spaced to an
  em, and drawn after the frame level with the page** (`uprightItems`,
  `paintUpright`): ntk turns no glyph, and a glyph turned back through two
  quarter turns would be resampled twice on a surface. The run carries the
  glyph it is drawn from under a symbol (`setUpright`), which a copy of the
  run (`{ ...run, nowrap }`) keeps and its identity would not, and its
  spacing a hair no horizontal run's has, so the layout cache never hands
  one's layout to the other. The frame's own draw leaves the upright cells
  out (`drawSideways`): **anything new that draws a frame's text leaves
  them out too**, or they are drawn twice, once on their sides.
- **`vertical-lr` is laid out as `vertical-rl` and put back across**
  (`reflectFrame`): its lines and blocks moved, each whole and none
  mirrored, to where they are laid out from the other end, so its glyphs
  stay the right way up — which is why its lines are made a piece at a
  time (`apart` in `linesOf`), each a layout of its own that can be moved
  alone, quadratic in its lines as that loop is, and why a block's margins
  in it are turned from the other side (`REFLECTED_MARGINS`). A block no
  layout has laid out since it was put back is left as it is
  (`layoutSerial`).
- **A frame is laid out whole, and what is around it is kept as any box
  is.** All a frame holds, and the boxes that hold it, are blockers
  (`noteBlockers`), so no layout keeps a frame and no kept block holds one:
  what a kept block is moved by is the page's, and a frame's heights run
  across it. And a build apart stops at a frame (`buildSubtrees`, `_apart`):
  a frame is made as a build of the whole ends and what is in one takes its
  sides from it, so a change in one builds the whole document. One live
  sample in a vertical writing mode made every build of an MDN article
  whole and every layout 12,892 boxes, where a CodeMirror cursor costs a
  few. **Anything new a layout keeps asks `blockers`**, or it keeps what a
  frame holds, and `framed.any` keeps a probe from standing in such a tree.
- **A writing mode and a direction are read ahead of the other
  declarations where a sheet declares a writing mode** (`Cascade._writing`):
  a logical property maps by the element's own, whatever its place in
  cascade order. In a document that declares none nothing is read twice,
  and the direction is as the cascade has it when a logical property is
  read, as before.

**An anchored box follows an anchor a scroll moves by being moved, not
laid out** (CSS Anchor Positioning 1, 3.3; `layoutPositioned`,
`AnchorScroll` in `layout/scroll.ts`). Where a scroll moves a box's
default anchor and not the box — a scroll container's, or the pane's for
a box fixed to the viewport anchored in the document, or the other way
round — the layout places the box against the anchor where the scroll
has it, moves it back to where it would be with nothing scrolled, and the
scroll moves it on with the anchor: `scrollContent` through
`anchoredAcross`, and `followPane` from `_followViewport`. Three things
are load-bearing. **Anything new that scrolls what an anchor is in moves
the boxes anchored across it, and asks `refitAnchored` after**: whether
one now overflows an edge of what it is placed in that is not its
anchor's — the anchor's move with it — which has the next layout try its
position options there, and what `position-visibility` hides. **A layout
places such a box afresh** (`forgetPaneShift`), so what the pane moved it
by is forgotten with it. And a box fixed to the viewport that follows its
anchor is still one of `FIXED_BOXES`, which the pane's blit would hold in
place: it is told where the box was drawn and where it is drawn now
(`_anchoredRects`). **What follows an anchor follows it as a chain**: a box
anchored to an anchored box a scroll moves — or to something in one —
moves with it, on the axes both follow on (`followersOf`, under
`anchoredAcross`), and a box anchored to a sticky box, or to something in
it, moves as far as its stickiness moves it, at a layout and at a scroll
(`anchoredWith`, from `followSticky`). Anything new that moves an anchor
without a layout moves its followers through one of the two. And
`anchors-visible` hides a box whose anchor is not seen at all — hidden by
`visibility`, or in a box `position-visibility` hid, its own anchor gone —
which a restyle in place can change without a layout, so it asks again
where the tree has anchors (`_revisit`).

**In a tree with anchors, positioned boxes are laid out in the order a
browser lays them out** (`finishOrder`, `inFinishOrder` in
`layoutDocument`): as the layout of each one's containing block ends, the
boxes in a block before the block's own, and those a positioned box holds
straight after it. Found in the flow's order, a box anchored to an anchor
inside an absolute box after it was placed before the anchor was laid out,
and read a box of no size (CSS Anchor Positioning 1, 2.3 makes that
anchor acceptable). A tree with no anchors keeps the order the boxes were
found in. **Anything new that queues positioned boxes during that loop
keeps the queue in this order**, or an anchor is read before its layout.

**An anchor name is of the tree its rule was written in** (CSS Shadow 1,
3.5, tree-scoped names). The cascade notes, beside `anchor-name`,
`position-anchor`, `anchor-scope`, the anchor functions of the insets and
the sizes, and `position-try-fallbacks`, the shadow root of the tree whose
rule set each, null for the document's (`noteTree`, `TREE_SCOPED`). A
name then matches only a reference of the same tree, as Chrome matches
them (`anchorBoxFor`, `referencedAnchor`). A scope reaches only its own
tree's names, from the anchor's side and from the box's (`scopedAway`), and a
`@position-try` is looked for in the reference's tree and then in each
tree around it (`_positionTry`, by `TreeRules.positionTries`). Two cards'
shadow trees each named their own `--a`, and a target in the second found
the first card's. **Anything new that names an anchor, or refers to one,
notes its tree with `noteTree`**: without one, it is the document's.

**A box's default anchor is found in one place, and an implicit one has no
name** (CSS Anchor Positioning 1, 2.2 and `position-anchor`;
`defaultAnchorBox`). `position-anchor: auto`, and `normal` where the box is
in a `position-area`, is its implicit anchor element (`implicitAnchorBox`):
a `::before`'s or an `::after`'s originating element (`GENERATED_FROM`),
and a popover's whatever showed it — its `popovertarget` button, or
`showPopover()`'s and `togglePopover()`'s `source` — which the facade hands
the host with the `popoverOpen` op, and `dom.ts` keeps by element until the
popover is hidden (`implicitAnchorOf`). An `anchor()` or an
`anchor-size()` that names no anchor, a `position-area`, `anchor-center`,
the scroll a box follows its anchor by (`noteDefaultAnchor`) and
`position-visibility` all reach the default anchor through
`referencedAnchor`, so an implicit anchor is followed and hidden as a named
one is; it is acceptable or not as any anchor is (`acceptableAnchor`), and
no tree and no `anchor-scope` reach it, since it is no name. Two things are
load-bearing. **A tree with a box that may be anchored implicitly is a tree
with anchors** (`mayAnchorImplicitly`, in the builder): nothing names an
anchor there, and `BoxTree.anchors` gates the whole of anchor layout — a
popover's `position-area` found no anchor in a document with no
`anchor-name`. **And anything new that gives an element an implicit anchor
— an invoker command's `show-popover`, an interest invoker — sets it where
the popover goes into the top layer**, through `setPopoverOpen`'s `source`,
whose change of `:popover-open` builds the boxes the layout reads it from.

**A position option a box is placed by is the box's style, and its last
successful one changes once a rendering** (CSS Anchor Positioning 1, 6.2
and 6.5.1.1). The style the chosen option made of the box's, its tactics
applied, is kept by the box (`placedStyleOf`), and `getComputedStyle`
reads it, a `::before`'s and an `::after`'s too (`_placedStyle`): a box
flipped by `flip-start` reads its `width` and `height` swapped. What a
layout places a box by becomes its last successful option only when the
element paints (`commitLastPositions`), as HTML updates it with the
resize observations, so a layout a script forces between two renderings
tries what the last one had; and the option's key holds the declarations
of the `@position-try` rules it names (`positionTryRules`), so a change
to one forgets it. `position-try-order` sorts the options by the room
each leaves on its axis before they are tried (`sortedOptions`,
`roomOf`). **Anything new that lays a box out by an option goes through
`triedStyle`**, or the style it reads back is another.

**An `anchor-size()` is kept by the field it is written in, wherever CSS
allows one** (CSS Anchor Positioning 1, 5.1): the sizes, the least and the
greatest ones, the insets and the margins (`setAnchorSize`, the
`AnchorSizeField`s of `anchorSizes`), the field holding its fallback — or
the field's initial value, `ANCHOR_SIZE_UNSET` — until layout makes it the
anchor's length. A tactic and a frame move the fields with the sides they
are of (`movedSizes`, `turnAnchoring`), and `getComputedStyle` reads the
lengths the placement came to (`placedStyleOf`, which holds the resolved
style of every anchored placement). **Anything new that takes an
`anchor-size()` keeps it in `anchorSizes` by its field**, or a tactic
leaves it on the side it was written on. An `anchor()` reading a side of
the other axis is its fallback (`OTHER_AXIS`), and an anchor in the top
layer is no anchor of a box laid out before it there (`topLayerRank`).

**An anchored box in a vertical writing mode is placed in its frame's
axes, and what it is placed by is read in the page's** (CSS Anchor
Positioning 1, 3.1–4.1). `framedStyle` turns what a box's anchor functions
name physically — an `anchor()` inset's side and the anchor's side it
reads, an `anchor-size()`'s axis, and the `@position-try` rules' styles —
as it turns the box's own sides (`turnAnchoring`); what is logical stays
so, and the layout reads it against the containing block's writing mode,
or the box's own for `self-`, through `AnchorAxes` (`startsLow`,
`blockDown`, `laidDimension`, `laidArea`): `start` across a `vertical-lr`
flow is the frame's bottom, since the frame is laid out as `vertical-rl`'s
is. Three things are load-bearing. **An anchor's rectangle reaches the box
through `inFrameOf`**, which turns it out of the anchor's frame and into
the box's: a rectangle read off a box in another frame is in other axes.
**A `position-area` is made the layout's tracks before the tactics run**
(`triedWith`, `areaTracks`), and a tactic flips the layout's axes, so
`flip-block` mirrors across the page in a vertical flow and `flip-start`
swaps about the containing block's start corner. And **a frame is the
containing block of what it holds at its root's padding box**
(`paddingRectOf`): the frame is only as tall as its content, which the
page has as wide, and `left: 30px` in a `vertical-rl` box came out at its
right. An offset read off a box in a frame is turned onto the page as well
(`onPage`, in `_laidOutAt`). A horizontal box inside a vertical flow is no
frame of its own yet, and is laid out turned with the flow.

**The isolated mode is designed and not built.** `<Html isolated>` — a child
process rendering into an XEmbed window — is specified in `docs/prd-html.md`,
including why the seams stay the parent's and why `handle.document` would
have to say it is a mirror rather than the live tree. The engine is written
so the renderer half is already process-portable; the follow-up adds a runner
over `src/embed/`'s existing lifecycle and changes nothing in `src/html/`.

## A map, and the three caches under it

`src/maps/` is the third element that draws a whole scene, after `<Flow>`
and `<Html>`, and it is here because it adds the case neither of those has:
**the scene arrives a piece at a time and each piece costs tens of
milliseconds to draw.** A dense city tile is 50-140 ms to rasterize on
either backend — that is a software rasterizer over a hundred thousand
vertices, and no arrangement of the component makes it free. What the
component does instead is make sure it is never _in a frame_.
`docs/prd-maps.md` has the format survey, the provider table and every
measurement; what follows is what the next scene element should take from
it.

**Overzoom is sub-tiling, not stretching.** The obvious implementation
clamps the tile cover to the source's own depth and lets the composite
scale what it finds, which is what every simple client does and is visibly
wrong two levels in: OSM cuts to zoom 14, so a zoom-21 view was one tile
rasterized at 2,048 pixels and stretched to 131,072. Instead the cover runs
up to six levels _past_ the source, and those tiles take their data from the
ancestor at the cut level — one fetch, 4,096 possible renderings, each at
its natural size. It is affordable because a feature whose box misses the
cell is skipped before it becomes a path (a deep cell measures _cheaper_
than a whole tile: 6 ms against 56), and it is correct because the geometry
is **clipped** as well as culled — a tile-wide polygon is sixty-four tiles
wide in the cell's pixels, which overflows the same 16.16 fixed point an
unclipped overlay did. `src/maps/clip.ts` is the pair of algorithms both
paths share. The cap is six because the _data_ runs out there, not the
renderer.

**Only for vector data.** A raster tile went through the same cells, and
only the rasterizer read what a cell was: the upload put the whole image
into every cell, so past each raster source's depth the map was a grid of
miniatures of its tiles — from zoom 19 on OSM's raster layer, which is read
a level deeper than the view. An image has nothing finer in it, so past the
cut a raster cell is drawn as the whole of its data tile, stretched
(`MapViewNode._rasterSquares`). The rule to carry: **when a unit of work
changes meaning, every path that does the work has to learn it** — two
paths drew a tile here, and one of them had never heard of cells.

**A hole is covered from whichever side has pixels, and there are two.**
Zooming _in_, the tile already drawn is the target's ancestor — one
composite, scaled up. Zooming _out_, the tiles already drawn are its
descendants, and walking up the pyramid finds nothing, so the first cut
showed the background (with the labels and markers still over it) for as
long as the coarser tile took to fetch and rasterize. The second cut still
chose one neighbour per square — descendants only when one level of them
tiled it, else the ancestor — and a zoom out lands at the _edges_ of the
level it left, where they never do, or two levels past it, where the search
did not look: blank again, sharp tiles in hand. Now each quarter of a hole
comes from the nearest level under it that has it (`fillFromBelow` in
`proj.ts`, four levels down, both renderers) and the ancestor fills only
the gaps, clipped to them so nothing is drawn twice. The rule generalises
past maps: **a pyramid cache has two neighbours, and code that only knows
one of them is half a cache** — and it has them per square, not per tile.

**And a cold view has neither, so it is given one.** Opened, or panned onto
ground nothing has loaded, the view's own twenty-odd tiles landed a square
at a time over the background. Its **overview** — the finest level above it
whose tiles are as large as the pane, four at most (`overviewLevel` in
`proj.ts`) — is asked for ahead of them on every frame, so its requests go
first and its picture becomes the ancestor the existing fill draws every
hole from. The retained renderer draws it first and only where a hole has
nothing as sharp, which keeps it out of a zoom in; the GL store puts its
loads and builds at the front of its queues (`want(tiles, ahead)`), ahead
of a pan's leftovers. The retained renderer also draws it during a gesture,
under a few milliseconds a frame, where a hole has no picture at any level:
"a gesture rasterizes nothing" was the right rule for ground the map has
drawn and the wrong one for a pan over a flat colour. The rule to carry:
**a pyramid's cold start is its coarse level first** — a handful of loads
for the whole view, then the detail over it.

**Three caches, layered, and the layering is the whole argument.** Tile
data, keyed on `source/z/x/y` and valid forever. Up to two rendered
`Surface`s per tile — the one on screen and the one being drawn, swapped
only when the new one is finished, because redrawing in place blanks a tile
for the several frames a redraw takes and above a source's `maxZoom` that is
_every_ integer zoom — each valid for a zoom _level_ and a style but **not
for a camera position** — so a pan composites the same surfaces at new offsets and a
fractional zoom composites them scaled, and neither rasterizes anything. A
label placement in **world** pixels, valid for a zoom and a set of loaded
tiles, so a pan translates it rather than recomputing it. Get the second
one wrong — key a surface on the camera — and every frame of a drag redraws
the world.

**A double buffer per piece is not a double buffer for the scene.** Each
tile keeps its old picture until its new one is finished, which is right
when tiles change one at a time — a zoom level, a display scale — and was
wrong when a style change retired every tile at once: the view was redrawn
a tile at a time, and for the second or more that took the map showed both
styles, under a background and labels that had switched on the first
frame. A restyle now holds the whole previous picture — its generation's
tiles, its background, its label placement — until every tile in view that
has data is redrawn, and swaps it in one frame; a tile still loading does
not hold it, and a view that keeps moving is bounded. The rule to carry:
**when a change invalidates the whole scene, swap the scene, not the
pieces** — and the frame that decides has to have done its work before it
draws anything, which is why `paint` is a work pass followed by a picture
pass.

**Rasterization is budgeted and resumable, and the unit has to be small
enough.** A frame spends at most `rasterBudgetMs` on it and remembers where
it stopped. The first cut resumed between _style runs_, which measured a
median of 47 ms and a maximum of 192 ms per frame, because a road network
is one run of fourteen layers and one of those layers is 90 ms on its own.
Resuming between **layers** brought that to 13 ms median and 55 ms maximum.
The rule to carry: a budget that can only interrupt at a boundary the data
never reaches is not a budget.

**A gesture rasterizes nothing.** Any camera change — a drag step, a wheel,
a programmatic `panBy` in an animation loop — sets the budget to zero for
140 ms. The map sharpens when it stops, which is also when `onMoveEnd`
fires.

**The uncontrolled camera lives on the element.** Not in a `useState` above
it: that is the difference between a drag step costing two numbers and a
damage strip, and costing a render, a commit and a full-pane claim. The
component passes `defaultCamera` down once and `camera` only when the
application is controlling it. `<Flow>` has the same fork; this is the case
where it is load-bearing rather than tidy.

**A per-backend constant is a smell, and this one is gone.** Worth keeping
as a worked example, because it is the finding most likely to recur for
anything else that draws a lot of geometry. On X11 a fill or stroke becomes
an a8 coverage mask over the path's bounding box, uploaded with one
`PutImage`, so a bigger path is fewer uploads over the same pixels — 12,000
vertices measured best and 500 measured 25% worse. On the Cocoa backend the
path went to `CGContextStrokePath`, whose cost was _quadratic_ in the number
of subpaths — 512 measured best and 12,000 measured **three times worse** —
so `<Map>` probed `app.nativeBezels` and picked one or the other.

That was the wrong place for the knowledge, and filing it said so
(react-x11#456): the right chunk is a fact about CoreGraphics that no caller
can know, and with the two backends wanting opposite values a caller that
batched for one pessimized the other. Core chunks the stroke itself now
(react-x11#457, in 2.6.1), so the probe is gone and one constant serves
both — and batching small on Cocoa now _costs_ 20-25% at the zooms that
hurt, because it cuts the path before core can chunk it well. **The rule to
carry: when a constant has to be chosen per backend, the constant is usually
in the wrong repository.**

**The gap was filed rather than worked around, and it closed**, per "no
escape hatches": `CGContextStrokePath` was quadratic in the number of
subpaths (react-x11#456), so one path holding a tile's two thousand building
rings measured 347 ms and the same rings batched measured a fifth of that.
Fixed in core 2.6.1 (react-x11#457), and this package's floor moved with it.
The hypothesis it replaced is worth keeping as a method note: "the Cocoa
context makes one napi call per `lineTo`" is _true_ and is **not** where the
time goes (0.6% of the profile), and only measuring told the two apart.

**Nothing fetches**, which is `<Html>`'s `onResource` rule and is stated at
the top of `src/maps/sources.ts`: a component whose default made requests
would decide, for the application, whose servers it talks to and whose usage
policy it is bound by. The two OpenStreetMap adapters supply the URL, the
schema and the attribution _around_ a `load` the application still writes.
The attribution is the part that is not merely tidy — for open data it is a
licence condition, so a source carries it and the map draws it.

**Two things the seam got wrong that only a real network found**, both now
pinned by tests, and both the same lesson: a component whose data arrives
asynchronously has to be _runnable_ against the real thing before it is
believed. The `signal` handed to a source was a plain object with an
`aborted` getter; `fetch` checks `instanceof AbortSignal` and throws
`TypeError` on anything else, so **every load failed** in exactly the way
the documentation told people to write — and nothing showed it, because a
failed tile draws nothing and a map whose every tile fails is
pixel-identical to one still loading. Hence `onTileError`,
`MapFrameStats.errors`, and a retry backoff (the same bug had every visible
tile re-asked once a frame, pointed at somebody else's servers).

**And a third that only a deep zoom found: clip everything, and know which
limit you are near.** Two of them, in XRender, reached in ordinary use — a
tile composite's coordinates are **int16**, and a stroke's geometry is
**16.16 fixed point**, so 32,767 either way but for different reasons and on
different paths. An overzoomed tile is the first: at zoom 22 against a z14
pyramid a tile is 131,072 logical pixels across, so one that overlaps the
pane starts 73,000 pixels outside it. Overlay geometry is the second. An
overlay is geography, so its far end stays put as the camera zooms into one
corner of it, and a world is `512 · 2^zoom` pixels — 134 million at zoom 20.
ntk hands a stroke's geometry to XRender in 16.16 fixed point, which
overflows a signed 32-bit word at 32,768, so an unclipped route is a
`RangeError` out of `x11/lib/ext/render.js` thrown from inside `paint`,
where no application can catch it. `src/maps/overlay.ts` clips lines
segment-wise, rings as rings (a fill needs a closed boundary, which segment
clipping cannot give it) and an over-large circle as a clipped ring;
`MapViewNode._composite` clips the destination rectangle and moves the
source rectangle to match, which leaves the scale factor untouched. **Any
element that draws application-supplied geometry in a zoomable viewport has
both bugs until it clips**, and a test that only ever frames what it draws
will never find either — the regressions here zoom until they would throw.

**A pane at the window's origin cannot show its origin added twice.**
`abs`, `contentBox()` and a synthetic event's `x`/`y` are the window's
coordinates, and everything the map places is pane-local until it is drawn,
so the pane's origin has to go in exactly once. `_composite` added it a
second time to every tile from the first version on: the basemap landed the
pane's offset right of and below the markers, labels and overlays, which a
user reported as markers drifting as the map zoomed and holding still as it
panned — a constant offset on screen is a different distance on the ground
at every zoom, and a pan blits both together. No test saw it, because every
one mounted the map at the window's origin, where the offset is zero. It is
the 1x-display trap again with an origin in place of a scale, and it has the
same answer: at least one geometry test mounts the element somewhere else
(`test/maps.test.ts` puts it under a header and beside a sidebar).

**Two traps specific to real tile data**, both found by running the decoder
over half a million real features and both now pinned by tests. `extent` is
**per layer**, not per tile: OSM's Shortbread cuts `streets`, `land`,
`ocean` and `water_polygons` at 2048 and its other twenty layers at 4096, so
a renderer that reads it once draws half of them at twice their size. And a
single _feature_ can be an enormous multipolygon — the low-zoom `land`
layer, the high-zoom `buildings` layer — so per-feature culling never culls
it and a per-feature path flush never flushes it. Both wanted per-**part**
handling.

**One `<Map>`, two renderers.** `<Map>` draws through GL (`src/maps/gl/`:
every frame from vector buckets, through a `<glarea>`) where the connection
has direct GL, and through the retained renderer (`MapViewNode`) everywhere
else — `renderer="auto"`, the default, decided in `src/maps/renderer.ts`.
What makes two renderers one component is that **nothing above the drawing
belongs to either**: the camera, the settle window, the gestures, the hit
test and the handle live on `MapController` (`src/maps/controller.ts`),
which a renderer attaches to as a `MapView`; marker order and paint, the
attribution's layout and the overlay order are `overlay.ts`'s; label anchors
are `anchors.ts`'s. A renderer that grows a camera of its own, a hit test or
its own idea of where a label goes is the bug: the handle would change
meaning across a fallback, and a map moved from one renderer to the other
would visibly move. Three rules came with it:

- **The GL module is a dynamic import**, so `<Map>` alone bundles none of it
  — `test/treeshake.test.ts` looks for the GL pane's element name and a
  shader keyword in the entry chunk. Nothing outside `src/maps/gl/` imports
  from it but `loadGlRenderer()`.
- **Nothing large reaches a float32.** A tile's coordinates are small
  numbers from its own corner; an overlay's are geography, so its bucket is
  int16 from a region around the view, and where the region lands is worked
  out each frame in float64 from the camera (`gl/overlays.ts`). A world
  position in float32 at zoom 22 is hundreds of pixels out.
- **Test both renderers with one suite.** `test/maps-renderers.test.ts` runs
  every handle and event test against both. A GL frame in the harness is the
  surface's `onDraw` called by hand with a stand-in context, after
  `app.chooseGLConfig` is stubbed to a promise that never settles, so the
  harness's own "no GLX" failure never lands. `test/maps.test.ts` is the
  retained renderer's, and stays exactly as it is.

**A GL fill is triangles, cut while the map is still, and the fan is
always there.** The renderer draws an opaque fill as earstrip's triangles —
indices into the fill stream's own records — with no stencil, where it drew
a stencil fan and a cover pass over the layer's squares: 20–30% off a dense
frame. The cut costs half a build again, and **the two paths draw the same
pixels**, which is the fact the rest stands on. `scripts/bench/maps-gl.ts
--fills=stencil|triangles` runs either path, on macOS or, through x11-dri's
GBM/EGL, on Linux. Four things to keep:

- **The cut is not part of the build.** `buildTileBuckets` writes the fan and
  `PendingCut` — which rings make which polygon, eight bytes a ring — and
  `cutTile` cuts later, resumably, a chunk of polygons at a time: a build
  worker straight after its build, the main thread in `CUT_SLICE_MS` slices
  that the view (`_cutSoon`) runs only while the camera is still and nothing
  waits to be built, and that ask for no frame. Moved into the build, it cost
  every tile that arrived during a gesture half its build again. **Work that
  changes no pixel and only makes later frames cheaper waits for the map to
  rest the same way.** And a map that is never still never gets it: that is
  the cost, and the fan is why it is safe.
- **A tile not cut draws its fan, tile by tile.** The renderer takes each
  tile's own path within a layer — fans first, their cover cut to the
  squares of the tiles that need it, then the triangles — since a cut tile
  beside an uncut one is the ordinary state while tiles stream in. A path
  that cannot cut at all keeps the fan everywhere: a table without
  `drawElements`, and an overlay (built again as the view moves). Anything
  new that builds fill records without a `PendingCut` leaves
  `LayerDraw.triangles` undefined, which is what sends a tile to its fan.
- **earstrip is a regular dependency.** 160 KB, no dependencies of its own,
  no native code, and reached only from the lazy GL chunk — the `ical.js`
  judgement, not the `@xterm/headless` one.
- **Its types are ours, through the `#earstrip` import.** earstrip 0.2.0's
  `earstrip.d.ts` has an extensionless relative `import()`, which fails
  `nodenext` with `skipLibCheck` off. `package.json`'s `imports` maps
  `#earstrip` to the package, with a `types` condition pointing at
  `src/maps/gl/earstrip.d.ts`: TypeScript reads that, and Node, tsx and
  esbuild, which never read `types`, load the package. `paths` was tried
  first and is wrong — tsx honours it at run time and loaded the `.d.ts`.
  When a release fixes the declaration (GLMap/earstrip#1), delete the copy
  and import `earstrip` directly.

## A rich text editor over ProseMirror

`src/rich-text-editor/` is `<RichTextEditor>`, and the sentence to keep from
it is: **the model is ProseMirror's and the view is ours.** prosemirror-model,
-state, -transform, -commands, -history, -keymap, -inputrules and
-schema-list run unmodified; prosemirror-view is a dependency for its types
and its `Decoration`/`DecorationSet`, never for `EditorView`, which needs a
DOM. `RichEditorView` (`view.ts`) replaces it and is shaped like it on
purpose: a plugin or a command is handed it as the view, and everything that
lives in state — keymaps, input rules, history, decorations — runs as written
for a browser. `docs/prd-rich-text-editor.md` has the survey and the ledger
of which `EditorView` members and view props exist.

What to know before changing it:

- **Composition, with one retained element per textblock.** Blocks are
  `<box>` flow, and each textblock is `<richeditortext>` — `<richtext>` plus
  a selection band and a caret the view sets imperatively, so a blink or a
  drag re-renders nothing. `BlockView` is memoized on node identity:
  ProseMirror shares every node an edit did not touch, so typing re-renders
  one paragraph and the containers above it. Keep it that way — a prop that
  changes identity every render (a new `ctx`, a fresh style object for every
  block) re-renders the document on every keystroke.
- **Block keys, never positions, reach a block.** Positions move with every
  edit before them. `keys.ts` maps each block's key through the
  transaction's steps (by identity when there is no mapping), and a block
  asks the view for its position when it needs one. Textblock children are
  never keyed. Only what the transaction changed is re-keyed: the top-level
  blocks the two documents share at either end are the same node objects,
  keep their keys and only move, so a keystroke costs the block it lands
  in, where re-keying the document cost six milliseconds a key at 2 MB.
  And a block whose node, key and place are what they were gets its last
  element back (`blockElement` in `render.ts`), so React reconciles the
  block a key changed rather than every block in the window.
- **A value handed in is a reset made of the nodes already there**
  (`replace.ts`). Its first step replaces the whole document with its own
  content. So the history, the caret and a plugin's positions see the reset
  they always saw, and an undo reaches nothing from before it. Then come the
  steps of the change alone, found by `findDiffStart`/`findDiffEnd`. The
  order is load-bearing. With the whole-document step last, a position at
  the edge of the change lands on that step's edge and survives, and an undo
  after an app cleared the draft brought a letter of it back. Narrowing the
  change without the whole-document step does that far more often: the
  typing on either side of it stays undoable. The codec keeps its last parse
  and the nodes each block became (`markdownReader`), so an unchanged block
  is the same node object and its key and element survive through
  `keys.ts`'s identity match.
- **`InlineMap` is the one bridge** between ProseMirror positions (UTF-16, an
  inline leaf counts one) and what `<richtext>` draws (code points, an image
  as its alt text, widgets with no document width, the filler an empty block
  is drawn with). Something new drawn inside a textblock goes through
  `buildInline` and the map; drawn around them, it desynchronises hit
  testing, motion and the a11y text at once.
- **Units.** Event `x`/`y` are logical, the text accessors device pixels;
  `posAtCoords`/`coordsAtPos` take and give logical window coordinates, as a
  plugin expects. The regression is a press at `scale: 2` in
  `test/rich-text-editor.test.ts`.
- **Mod is the backend's; prosemirror-keymap's is the host's.** It reads
  `navigator.platform`, which under Node on a Mac says Mac — Cmd — even while
  the app draws to an X server. `toDomKeyEvent` (`keymap.ts`) swaps Ctrl and
  Meta when the two disagree, and names a chord by its Latin keysym, so
  `Mod-b` is Ctrl+B on X11 and Cmd+B on Cocoa, on any host and any layout.
- **The clipboard is prosemirror-view's, ported** (`clipboard.ts`): the same
  props in the same order, over the htmlparser2 DOM shim in `html.ts`. A copy
  also keeps its slice in the process, because the Cocoa clipboard is
  text-only and a copy and paste inside one editor would otherwise flatten.
- **The markdown parser is shared.** `src/internal/markdown/` is the parser
  `<Markdown>` renders and the one the editor reads with, plus the
  serializer it writes with. A parser change changes both components; the
  model test round-trips a generated corpus and fails on any document that
  loses text or does not settle after one trip.
- **Suggestions are plugin state; the component only draws them.**
  `suggest.ts` keeps the open trigger, its query, the rows and the
  highlight in a plugin's state and takes the list's keys in its
  `handleKeyDown`, so an app that owns the EditorState gets the list by
  putting `suggestions([…])` in its plugins — ahead of `defaultPlugins`, or
  the keymap's Enter splits the paragraph before a row can take it. The
  component's `onKeyDown` runs before every plugin, which is why its
  submit-on-Enter defers to an open list; and an Escape a plugin claims does
  not arm the Tab-out (`view.ts`, `keyDown`) — the list's Escape closes the
  list, and the next one arms the Tab.
- **A markdown table keeps markdown's shape.** `tables.ts` wraps
  prosemirror-tables' commands so that a table which starts with one header
  row, first, and no spans ends that way too: a row added above the header
  becomes it, a deleted header hands over to the row below, and a new cell
  takes its column's alignment. A table of another shape — a header column
  from HTML — is left as prosemirror-tables leaves it. Its `tableEditing()`
  plugin is not used: that cell selection runs on DOM mouse events.
- **Table columns follow their content, measured per cell.** `TableView`
  lays each cell's text out through the app's font manager and caches the
  width by the cell _node_, so typing measures one cell again. The rows are
  separate boxes and still line up because every row's cells get the same
  `flexBasis` and shrink alike.
- **Plugin views are made after the first commit** (`mountPluginViews`,
  from the component's layout effect). A browser's EditorView has its DOM
  from its constructor, and plugin views are written to find `view.dom` —
  y-prosemirror's cursor plugin listens on it for `focusin`/`focusout`,
  which the root element answers. A collaborator's caret is a widget whose
  `toDOM` returns `remoteCaret`'s description (`collab.ts`); the view asks a
  text-less widget's `toDOM` once, cached by the widget's type, and a
  builder that reaches for `document` throws and is skipped.
- **A press on the selection is left to core, so that it can arm a
  drag.** The root is `draggable`; `mouseDown` claims every other press,
  and `onDragStart` cancels a drag whose press was not on the selection.
  An in-app drop reaches its target with no modifiers — core builds it
  with `buttons: 0` — so the copy modifier travels in the slice payload
  from the source's last `onDrag`; and an in-app drop must answer
  synchronously, because `onDragEnd` follows at once.
- **A long document draws a window of its top-level blocks**
  (`virtual.ts`, over `src/internal/`'s window). The view's geometry is
  laid-out text and a block outside the window has none, so the view asks
  `BlockWindow.drawn` before it needs one — `scrollToSelection`, and the
  motions in `LAID_OUT` — and otherwise has the block revealed and
  finishes in the callback. A block is measured with the gap after it:
  the content column keeps its `gap`, and each spacer gives one back.
- **Subpath only.** The one component not re-exported from `src/index.ts`:
  ProseMirror's declarations name DOM globals (`dom-globals.d.ts` declares
  the four this repository needs), and an app importing anything from the
  barrel loads every re-exported declaration. The treeshake test pulls it
  from `./dist/rich-text-editor/index.js`.

## Commands

```bash
npm run build         # tsc: src/ -> dist/. `pretest` and `prepack` run it
npm test              # builds, then node --test via tsx — no $DISPLAY needed
npm run lint          # eslint, over the JavaScript only — see "Linting"
npm run format        # prettier --write
npm run format:check  # what CI runs
npm run typecheck     # builds, then tsc over src, test, examples, scripts
npm run check:package # exports map + tree-shaking contract (needs a build)
npm run docs          # sync docs/ into website/ and serve it
npm run docs:build    # what the deploy workflow runs
npm run bench:zengarden  # the CSS Zen Garden against Chrome — scripts/zengarden/
npm run bench:zengarden -- --native  # the same on the native backend: Windows, a Mac
npm run bench:zengarden:scroll  # a Zen Garden page scrolled, frame costs by region
npm run bench:zengarden:resize  # each design's window dragged narrower, frame costs
```

Every `examples:<name>` needs a display — a real `$DISPLAY`, or a Mac running
the native backend (`REACT_X11_BACKEND=cocoa`). There is one per component;
`package.json` is the list. The ones with something more to say:

```bash
npm run examples:calendar    # a bus, or EventKit, for the day dots
npm run examples:maps        # and a network — real OSM tiles
npm run examples:terminal    # X11 only, and an emulator installed
npm run examples:terminal-vt # a pty module (node-pty), or Bun >= 1.4
npm run examples:terminal-ssh   # SSH_HOST/SSH_USER, and `npm i -D ssh2`
npm run examples:media-player -- <file>   # mpv or VLC on X11, or ffmpeg
npm run examples:tray-host   # X11 only, and no other tray on that display
npm run examples:three       # a GL context: see docs/components/three.md
npm run examples:tree -- <dir>  # defaults to cwd
npm run examples:browser -- [url]  # and a network; BROWSER_DEBUG=1 logs requests
npm run examples:tree -- --stress[=rows]  # generated 100k-row tree instead
npm run examples:flow-stress    # the measured pan loop, with an X-traffic HUD
```

`pretest` and `pretypecheck` both build, and both have to. `package.test.ts`
imports `@react-x11/components` **by name** — the self-reference Node allows
a package with an `exports` map — because that is the only way to exercise
the resolution an installed copy actually gets. That name resolves to
`dist/`, so without a build the packaging test cannot run and `tsc` cannot
even find the module. Do not "optimise" either hook away: the failure is a
clean checkout where `npm run typecheck` reports two missing modules that
are not missing.

Tests are headless: react-x11's harness runs node-x11's pure-JavaScript X
server in-process. Use `{ backend: 'mock' }` unless a test genuinely needs
real pixels — the mock context has no path API, which is why a component's
`paint` should skip drawing rather than throw when it is missing.

## Adding a component

1. Check it against the split criteria above. If it belongs in core, say so
   and stop.
2. `src/<name>/` with `index.ts`.
3. Add the `./<name>` subpath to `exports` — pointing at `dist/` — and the
   re-export to `src/index.ts`. Props types go out through
   `export type { … }`, so `verbatimModuleSyntax` keeps them out of the emit.
   The one exception is a component whose _declarations_ need something an
   app may not have: `rich-text-editor` is subpath-only, because
   ProseMirror's types name DOM globals and the barrel would hand that
   requirement to every app (see "A rich text editor over ProseMirror").
4. Add its entry to `COMPONENTS` in `test/treeshake.test.ts` — export name
   plus a string only that component's modules contain. The "one component
   does not drag in the others" test is a loop over that list, so a missing
   entry silently drops the component out of the guard.
5. Tests in `test/<name>.test.ts`, type tests in `test/types/<name>.tsx`, an
   example in `examples/<name>.tsx`.
6. **A page in `docs/components/<name>.md`**, and its row in
   `docs/README.md`. See "Documentation" below — `test/docs.test.ts` fails
   without it, so this is not a step that can be left for later.
7. If it registers an element, declare it to JSX in the component's
   `index.ts` — the `declare module 'react-x11/jsx-runtime'` augmentation.
   It needs `import type {} from 'react-x11/jsx-runtime';` above it: nothing
   in `src/` writes JSX, so the build program has no other reason to load
   the module being augmented, and TypeScript rejects an augmentation whose
   target it never resolved. The import is type-only and costs no bundle.

## Documentation

**There is one copy of the reference, it lives in `docs/`, and the site
renders it rather than restating it.** `website/scripts/sync-docs.mjs` copies
`docs/` into the Docusaurus tree at build time, adding front matter and
rewriting the links that escape the directory. Nothing under
`website/docs/reference/` is committed, and a page deleted from `docs/`
disappears from the site because the output tree is rebuilt from scratch.

The shape:

- `docs/README.md` — the index, and the site's `/docs/reference` landing
  page. Every component page has a row in one of its two tables.
- `docs/components/<name>.md` — **one page per `src/<name>/`**, components
  and shared modules alike. The filename is the subpath, so
  `@react-x11/components/tray-host` is `docs/components/tray-host.md`.
- `docs/<topic>.md` — design documents and anything that is not one
  component. `prd-vt-terminal.md` is the worked example.

`test/docs.test.ts` is what keeps this true, and it checks both directions:
a component with no page, **and a page with no component**. The second is the
one that rots quietly — delete a component and its page keeps describing
props nothing has, and the site keeps serving it. It also asserts every page
starts with a `# Heading`, because that heading is what titles the page in
the sidebar; without one the sidebar says `tray-host`.

What a component page owes the reader, in roughly this order:

1. The import line and a real snippet — the shortest thing that works.
2. What the component _is_, in a sentence, including whether it registers a
   host element.
3. Props, as a table. The default goes in the description rather than a
   column of its own; most defaults here are a sentence, not a value.
4. The handle, if it has one, and the event shape, if it has one.
5. **The decisions.** Every component in this package has two or three
   behaviours that look like gaps and are not — one tray per display,
   `write()` returning `false` on an embedded emulator, a missing player
   being an ordinary state rather than a throw. Those are the paragraphs the
   reader actually needs, and the source comments are usually already written:
   move the reasoning, do not re-derive it.
6. The `npm run examples:<name>` line, when there is one.

Two rules that are easy to get wrong:

- **Do not restate the README.** It is the tour — what the package is for,
  and why a component is here rather than in core. `docs/` is the detail.
  When both would say the same thing, the README gets the short version and
  links.
- **Links out of `docs/` are rewritten to GitHub by the sync script, and
  links inside it stay relative.** So link a sibling page as
  `[Terminal](terminal.md)`, and the site and the GitHub view of the repo
  both work.

### The site

`website/` is a Docusaurus site with no build step of its own beyond
Docusaurus. It has two hand-written pages — `intro.md` and
`getting-started.md` — and everything else is synced. It deploys to GitHub
Pages from `master` through `.github/workflows/deploy-docs.yml`.

```bash
npm --prefix website ci     # once
npm --prefix website start  # sync + dev server
npm --prefix website run build
```

`onBrokenLinks` and `onBrokenAnchors` are both `throw`, deliberately: a
heading renamed in `docs/` must break the build rather than quietly leave a
dead link. Markdown is parsed with `format: 'detect'`, so `.md` files are
CommonMark and not MDX — these docs are full of bare element names like
`<box>` and of `{braces}`, neither of which is valid MDX.

## Pull requests

### Screenshots

- When a PR contains changes that can be detected by eye (rendering, widgets,
  layout, the docs site), include screenshots **rendered by the PR's own
  code** in the description. Headless recipe: render into node-x11's
  in-process X server, read back with `getImageData` (RGBA, as a canvas's is: core's readback was BGRA once, and a PNG written from it as though it still were has red and blue swapped), save
  with `pngjs`. Everything here is testable without a `$DISPLAY` for exactly
  this reason. For the docs site, `npm run docs:build` and then a headless
  browser against `website/build`.
- **Do not commit PR-illustration images to this repo.** Upload them to
  GitHub's user-attachments storage — the same place a drag-&-drop into the
  description puts them. Commit an image under `docs/img/` only when it is
  useful beyond the PR itself, which means the README or the docs site.
- **Upload with `gh-attach`**, which replays the web UI's upload flow with a
  saved session and splices the results into the body:

  ```bash
  gh-attach sidorares/react-x11-components <pr#> shot-a.png shot-b.png
  ```

  It replaces a `<!-- drag in: shot-a.png -->` placeholder where the body has
  one and appends the rest, so writing those placeholders while drafting is
  worth doing either way. `gh-attach login` re-captures the session when it
  has expired.

- user-attachments has **no public API** (github/community#29993), which is
  why a PAT or `gh` alone cannot do this and why the tool exists. Without a
  usable session, fall back to **ntk's** convention instead of giving up:
  commit the PNGs under `docs/img/` on the PR branch and reference them as
  `https://raw.githubusercontent.com/sidorares/react-x11-components/<commit-sha>/docs/img/…`.
  SHA-pinned links survive the branch being deleted on squash-merge. That
  leaves the images in history, which is the cost, so prefer `gh-attach`.
- A freshly uploaded asset is **private**: its URL 404s for logged-out
  visitors until it is referenced from content they can see. Embedding it in
  the PR body is what publishes it — a bare uploaded URL is useless on its
  own.

### Documentation

A PR that adds or changes a component changes its `docs/components/` page in
the same PR. `test/docs.test.ts` catches the missing page; it cannot catch a
page that still describes the old props.

## Incoming: what is planned to move here

The table is the running decision record, so that "should this move?" is not
re-litigated from scratch each time.

**Moved so far:** `<Calendar>` and `<DatePicker>`, from react-x11
`src/components/`. They are still exported by core as well, and core is
expected to drop them — until it does, an app that imports the name from both
places gets two independent widgets, which is harmless (neither registers a
host element) but is not the end state. See "Vendored from core" above for
what came with them.

**Replaced rather than moved:** core's ntk-backed `<markdown>` element.
`src/markdown/` is a from-scratch successor (its own GFM parser, tolerant
of streaming-truncated input; rendering is box/`<richtext>` composition),
because ntk's `MarkdownView` and `HtmlView` widgets are being deprecated
and neither supported selection. The reuse question was asked against
Vercel's Streamdown first and answered "behaviour yes, code no" — its
pipeline is remark→rehype→DOM, but its `remend` package's
unterminated-markdown rules are implemented natively by
`src/internal/markdown/parse.ts` (as parser tolerance, not a repair pre-pass; the
handlers were read, not imported).

**And `HtmlView`, which this file previously said would never be replaced.**
That line — "there is deliberately no `<html>` successor: nothing in this
package renders through an HTML pass" — was answering a different question,
and the distinction is the thing to keep rather than the conclusion.
_Markdown does not go through HTML_, and that stays true: it has its own AST
and box composition is better for it. `src/html/` exists because HTML arrives
as an **input in its own right** — mail, release notes, a CMS, an exported
report, a model's output — with no markdown upstream of it to render instead.
See "An HTML renderer that draws" above and `docs/prd-html.md`.

And core's own `<Tree>`, which is the first _core widget_ replaced rather than
moved: `src/tree/` is a successor that imports none of it, because core is
retiring the widget rather than handing it over. What that changes about how
one is written is in "Replacing a core widget rather than moving it" above.

| Candidate                                        | Where it is now                                                                                     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<markdown>`, `<html>`                           | replaced by `src/markdown/` and `src/html/` here                                                    | **Done** for both. ntk's document widgets are deprecated ([ntk#106](https://github.com/sidorares/ntk/issues/106)); `<html>` was recorded here as "never" and is not — see the note above and `docs/prd-html.md` for why the distinction changed rather than the rule.                                                                                                                                                                                                                                                                                                                                                                                                         |
| MDX in `<Markdown>`                              | block position + expressions, here (`src/internal/markdown/tags.ts`, `src/markdown/expressions.ts`) | **M1 + M2 shipped — [docs/prd-mdx.md](docs/prd-mdx.md).** Two gates, two statements: `components` decides what a document may _reach_ (a tag is a component iff its name is a key in it, so no document that rendered before can change; attributes are strings/`true`/JSON, nothing evaluated); `scope` decides whether it may _compute_ (`new Function`, no sandbox — never pass it with model output). Still open: the inline half, which needs a `TextRun` that can reserve advance width for an embedded element; `<Html>`'s answer is a CSS line-box engine and is not borrowable.                                                                                      |
| `<svg>`                                          | ntk (`SvgView`), wrapped in react-x11                                                               | **Staying in ntk**, per ntk#106. Recorded here so it is not reopened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `<tex>`                                          | replaced by `src/formula/` here                                                                     | **Done.** The last ntk document widget planned for decommission: `layoutTex` rendered one opaque drawing, so nothing inside it selected. `<Formula>` is a from-scratch successor (KaTeX's virtual DOM + its own CSS-subset layout, none of ntk's tex.js), selectable via the text accessors, fed by `<Markdown>`'s `fences` seam. `katex` is an optionalDependency here; ntk drops it.                                                                                                                                                                                                                                                                                        |
| mermaid                                          | `src/mermaid/` here, compiled by ondine (an optional peer)                                          | **Done**, over [ondine](https://ondine.sh) rather than mermaid: a Rust compiler that follows Mermaid's syntax, shipped as WebAssembly — 13 ms to compile the module once, tens of µs a diagram, no DOM. mermaid itself stays dropped (155 MB for a grammar). ondine's SVG is read into a scene and drawn by a registered element, because `SvgView` reads no custom properties and one opaque drawing selects nothing; `<Markdown>` reaches it through `fences`. ondine is an optional _peer_: some 46 MB installed. See `docs/components/mermaid.md`.                                                                                                                        |
| `<Tabs>`                                         | superseded by `src/tabs/` here                                                                      | **Done.** Same successor relationship as `<Tree>`: Chakra's compositional API with the parts spelled flat (like `<Timeline>`), keeping core's keyboard/RTL behaviour and dropping the items-array API. Core's remainder is an open core-side decision.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `<Tree>`                                         | superseded by `src/tree/` here (see above)                                                          | **Done.** Core's `src/components/Tree.js` is being retired; this is a successor, not a wrapper, and imports none of it. See "Replacing a core widget rather than moving it".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `<Table>`                                        | superseded by `src/table/` here                                                                     | **Done.** Same successor relationship as `<Tree>`; prop-compatible with core's, plus accessors, variable-height virtualization, multi-select and seams. Core's remainder — stripped or removed — is an open core-side decision. `docs/prd-table.md` is the design record.                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3D scene graph, Three.js / r3f layer, `Canvas3D` | `src/three/` here                                                                                   | **Done**, with `<glarea>` staying in core exactly as planned — the worked example in "The boundary can run through a feature". `<Canvas>` is r3f-shaped over one `<glarea>`, with its own JSX runtime subpaths (`./three/jsx-runtime`, `./three/jsx-dev-runtime`) because the intrinsic element names are the family's, not core's. Runs on all three GL flavors, the Cocoa backend's CGL-into-a-CALayer included; `three.js` itself is not a dependency.                                                                                                                                                                                                                     |
| A 2D map                                         | `src/maps/` here                                                                                    | **Done.** `<Map>`: MVT tiles, a GL-style-shaped style subset, markers and overlays, over one element that draws the map. The third scene element, and the first where the scene arrives a tile at a time — see "A map, and the three caches under it" and `docs/prd-maps.md`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| react-flow clone                                 | `src/flow/` here                                                                                    | **Done.** `<Flow>`: react-flow's surface API over one element that draws the graph, with a `render` seam for bodies that must be real widgets. See "Drawing beats composing".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `<Terminal>`, `<MediaPlayer>`                    | new, here (`src/terminal/`, `src/media-player/`)                                                    | **Done.** Built on core's `<foreign>`; the wrapper is here because a binary dependency can never be core's. See "Running someone else's program".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `<TrayHost>`                                     | new, here (`src/tray-host/`)                                                                        | **Done** (issue #17). XEmbed's third consumer here, and the other side of it. Core keeps the _plug_ side — `createRoot({ embedInto })` is renderer internals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A StatusNotifierItem host                        | nowhere yet — but the _item_ side landed in core                                                    | **Still planned here**, as a sibling of `<TrayHost>` with its own issue. Shares intent with `<TrayHost>` and nothing else: it pairs with core's `dbusmenu.js`, not with `<foreign>`. Note the split — the **item** side (an app putting its own icon in a tray) shipped upstream in react-x11 as `useTray()`'s freedesktop rung (react-x11#353), on `src/statusnotifier.js` + the extracted `src/dbusmenuexport.js`. That is the same seam `<TrayHost>` sits on: core owns being _in_ a tray, this package owns _being_ one. A host here consumes `org.kde.StatusNotifierWatcher` and core's dbusmenu **client** half, which does not exist yet and is the real prerequisite. |
| A pure-JS VT backend for `<Terminal>`            | new, here (`src/terminal/vt/`)                                                                      | **Done** (issue #19). `backend="vt"`, behind the existing props: pty + `@xterm/headless` + a cell-grid renderer. See "The terminal that is not somebody else's program".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `<TerminalOutput>` — a captured session          | new, here (`src/terminal-output/` + `src/ansi/`)                                                    | **Phase 1 done.** A log is a document, not a grid, so flow mode is `<richtext>` spans with no dependency at all. The cell-grid path for captures that addressed the cursor is phase 2 — see [the PRD](docs/prd-terminal-output.md).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A WYSIWYG rich text editor                       | new, here (`src/rich-text-editor/`)                                                                 | **Done.** `<RichTextEditor>`: ProseMirror's model, transforms and plugin system, drawn by this package — the view is ours and `EditorView`-shaped, so every plugin that lives in state (keymaps, input rules, history, decorations, collaboration) runs unchanged and the ones that reach into the DOM do not. Not in the barrel: ProseMirror's declarations name DOM globals. See "A rich text editor over ProseMirror" and [the PRD](docs/prd-rich-text-editor.md), which also carries the follow-ups (IME tiers, inline widgets, images in text).                                                                                                                          |

Verified against ntk 7.2.0 on 2026-08-09: `MarkdownView`, `HtmlView`,
`SvgView` and `layoutTex` are all still exported; only mermaid is gone.

A note on precedent: react-x11's `NEXT_STEPS.md` §10 records an earlier
decision that the widget set stays in core and siblings live in that repo as
workspaces. That is still true of the _core widget set_ — it is not what
this package is. This package exists for the things that fail the "vast
majority of apps" test, which the core widgets pass.

## Conventions

Mostly inherited from react-x11. The language is the one place the two repos
have diverged, so moving code between them is no longer quite mechanical —
see below.

- **TypeScript, compiled to ESM.** `src/*.ts` in, `dist/` out,
  `"type": "module"`. What ships is plain ESM JavaScript with declarations
  beside it, so a _consumer_ still needs no build step of their own. That
  was always the point of the older "no build step" rule; this repo now pays
  the compile itself instead of pushing it downstream.
- **No JSX in library source.** `React.createElement` (aliased to `h`). JSX
  is fine in `examples/`, `test/types/` and tests.
- **Declarations are emitted, not written.** The props interface lives beside
  the code that reads it and `tsc` produces the `.d.ts`. `skipLibCheck` is
  still off, so react-x11's own declarations are checked too.
- **`verbatimModuleSyntax` is on**, so a type-only import must say
  `import type`. That is what keeps the emitted JavaScript identical to the
  source minus the types, and what stops a type import becoming a runtime
  one that the tree-shaking guard would then catch.
- Prettier with `singleQuote`, eslint flat config. Both match core's.
- **Conventional commits** — release-please reads them. `feat:` for a new
  component, `fix:` for a bug, `feat!:`/`BREAKING CHANGE:` for a prop or
  export that changes shape.
- Comments explain _why_, especially where getting it wrong fails far from
  the cause. Both traps in "Gotchas" are that shape.

### Moving code to or from core

core is still JavaScript with hand-written `.d.ts`. Bringing a component
here means folding its `.d.ts` into the `.ts`; sending one back means
splitting them again. Everything else — the element registration, the node
subclass, the tests — transfers unchanged, because none of it was ever
typed at runtime.

### Linting

**eslint does not see the TypeScript, and cannot yet.** typescript-eslint's
parser is built on the classic `typescript` JavaScript API; TypeScript 7 is
the native compiler and its package exports `version.cjs` and a set of
`./unstable/*` entry points instead. Every published typescript-eslint,
canary included, still declares `peerDependencies.typescript` as
`>=4.8.4 <6.1.0`. There is no configuration that makes it work.

So `npm run lint` covers `eslint.config.js` and any other `.js`/`.mjs`, and
`tsc` covers the rest: `strict`, plus `noUnusedLocals` standing in for the
`no-unused-vars` rule this repo actually relied on (`args: 'none'` there is
`noUnusedParameters` left off here). `eslint-plugin-react` went with the
last `.jsx` file — its two rules only ever existed to stop `no-unused-vars`
flagging an `import React` that the classic JSX transform required.

**When typescript-eslint supports TypeScript 7**, add it back: install it,
spread `tseslint.configs.recommended`, and give it a `files: ['**/*.ts',
'**/*.tsx']` block. Consider dropping `noUnusedLocals` at that point so the
same finding is not reported twice.

## Releases

release-please on `master` opens the release PR; merging it tags, and the
workflow publishes with npm trusted publishing (OIDC), so there is no token
secret in this repo.

It runs in **manifest mode**: the strategy is in `release-please-config.json`
and the current version in `.release-please-manifest.json`, not in the
workflow. `release-please-action@v5` accepts no per-package inputs — pass
`bump-minor-pre-major` to the action and it warns and ignores it, which looks
like it worked until the release PR proposes the wrong version. Change
release behaviour in the config file.

`bump-minor-pre-major` is what keeps a `feat:` bumping the minor instead of
jumping to 1.0.0. Stay in 0.x until the API has actually been used.

Two one-time setup steps, neither of which the workflow can do:

1. ~~**The first publish must be manual.**~~ **Done** — `0.1.0` is on the
   registry (published 2026-08-09), which is the precondition trusted
   publishing binds to. Kept here because it is the step that is invisible
   once it has happened.
2. The `@react-x11` npm scope must exist and this repo + workflow must be
   configured as a trusted publisher for `@react-x11/components`.

`dist/` is not committed, so publishing depends on the build running. It
does: `prepack` is wired to `npm run build`, which covers `npm publish` and
`npm pack` alike, and the release workflow also builds explicitly so a
compile failure is its own red step. What this means for the manual first
publish is that it has to happen after an `npm ci` in a clean checkout, not
from a tree where `dist/` was left over from something else.

**That gate has cleared.** The rule used to be "do not publish before
react-x11 2.0.0 is on npm", because the peer range could not be satisfied.
Core 2.0.0 shipped, so releases are unblocked — and `0.1.0`, published while
the range was still unsatisfiable, became installable the moment it landed.

## Gotchas

Both of these are inherited from `registerElement`, and both fail a long way
from the cause:

- **`drawn` decides whether the element paints at all.** `paintOrder()`
  filters children on `DRAWN_KINDS`; a kind missing from it lays out
  correctly, reports a sensible `abs` rect, and never appears on screen, with
  no error anywhere. `registerElement` opts you in unless you say otherwise —
  so the failure mode is passing `drawn: false` without meaning it. Assert
  membership in a test, the way `test/markdown.test.ts` does for
  `<richtext>`.
- **`semanticNames` is the difference between DEV and production.** react-x11
  throws in development on a style property written as a flat prop
  (`<richtext color="red">`), because that is usually a real mistake. An
  element whose own vocabulary overlaps the style vocabulary — `color`,
  `width`, `opacity`, `stroke` — must declare those names, or it throws on
  its own props in development and works in production. Check a name with
  `isStyleProp` from `react-x11/style` before you rely on it.

One more, specific to here:

- **`node.kind` must equal the registered element name.** react-x11 rejects
  the node otherwise, and the reason it bothers is that `kind` is what paint
  order, the test queries and the DEV assertion all match on. Keep the name
  in one exported constant per component and use it in all three places.

One that comes from the test harness:

- **The in-process server is not pixman.** ntk draws a mask either itself
  or with the server's trapezoids, picked by size, and since 8.18 its own
  is pixman's algorithm to the byte (sidorares/ntk#507), so on a real X
  server the route never shows. The pure-JavaScript server the suite runs
  on rasterizes trapezoids its own way, and does not always agree. So a
  test that compares a full repaint, large enough to go to the server,
  with a pass over a small clip, rasterized by ntk, can measure the
  harness and not the component: `<Flow>`'s folded edge, a line that
  doubles back on itself, came out 15 levels apart in one column between
  the two — pixman leaves one of its 17 sample columns there uncovered,
  and the harness server covers it — and 15 by both routes on Xvfb, which
  is pixman. Such a test pins ntk's
  route, which still catches what it was written for (`test/flow.test.ts`):

  ```ts
  result.app.options.rasterPolicy = { maxArea: Infinity, maxBytes: Infinity };
  ```

And two that come from subclassing `Node` and augmenting JSX:

- **Underscore-prefixed member names belong to core.** The base `Node`
  assigns own properties like `_theme` in its constructor, and an own
  property silently shadows a subclass's prototype method of the same name
  — `this._theme()` then throws "not a function" at the first paint, far
  from the declaration. Before adding a private `_name` to a node subclass,
  grep react-x11's `nodes.js` for it (`src/charts/node.ts` renamed its
  helper to `_themeRecord` for exactly this).
- **A JSX augmentation's props must be structural.** `npm run typecheck`
  compiles `src/` and, through `package.test.ts`'s self-import, `dist/` in
  one program — so the element augmentation exists twice and TypeScript
  requires the two declarations to be _identical_. Interfaces unify;
  a class with private members is nominal and does not, and the error
  (TS2717, pointing at `dist/`) says nothing about why. That is why
  `ChartSourceData` names the structural `ChartDataLike` rather than the
  `ChartData` class — which is also what lets an app bring its own store.
