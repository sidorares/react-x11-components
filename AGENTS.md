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

**Three components are X11-only, and always will be**: `<Terminal>`'s
embedded emulators, `<MediaPlayer>` and `<TrayHost>`. All three are XEmbed,
and macOS has no cross-process window embedding — react-x11's own
`docs/macos.md` says so and names this package in as much. That is a wall,
not a gap, so do not file it as one; the answer where an app needs the
capability on both backends is a native sibling, which is what
`backend="vt"` is for the terminal.

All three degrade the same way there — `status: 'unavailable'` plus
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
XQuartz's xterm installed lands on vt. **That is the posture to copy for
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

- `peerDependencies.react-x11` is `^2.38.0` — what a consumer must supply.
- `devDependencies.react-x11` is `^2.38.0` — what the suite runs against.

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
`linebreak` is the sixth, on the same footing: ntk breaks every line with
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
out.

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
so a resize restyles only when it crossed one. The viewport units are the
other, handled the same way: a `vw` or a `vh` is a number once computed, so
the cascade notes at parse time whether any declaration uses one, and only
those documents restyle when that side of the viewport moves. The viewport
is the box that scrolls the element, whose height core's layout pass
decides _after_ the element was measured — so a document that reads it (a
`vh`, the root's percentage height, a box against the initial containing
block; `LayoutResult.readsViewportHeight`) finds the move at paint and asks
to be measured again, which costs a frame per resize and only for those.

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

**Nothing is fetched and nothing is executed, by construction.**
`onResource` is the only way anything loads and `onScript` never runs
anything. Both are the same call the desktop calendar makes about
credentials: the host already did the work of knowing its policy, and a
component that silently made requests would turn "render this HTML" into
"make these requests". A declined resource is an ordinary state, not an
error. **Do not add a convenience default that fetches**; the absence is the
feature.

**What arrives late is answered by what it changes.** A stylesheet the head
links to, or one it imports, holds the first rendering until it is in
(`_renderBlocked`), as a browser holds a page: built before then, the
document was built, laid out and painted unstyled and built again for
each sheet. An image only a background, a border image or a mask paints
is painted where it lands (`_imagePainted`), the store having been told
so where it was asked for (`request`'s `paintOnly`); one whose size lays
something out still builds the boxes. Over a network, the Zen Garden's
designs took eleven builds a page before these and take one.
`htmlsweep.mjs`'s `LATENCY` is how that is measured: answered at once,
arrivals coalesce into a frame and none of it shows. **A sheet declined
or failed after it was asked for is news too** (`'declined'`, in
`resources.ts`): it changes no style, but nothing else asks the held
rendering again. Zen Garden 215 imports two `http:` sheets its secure page's
host refuses, and the bench's harness measured it a viewport tall until a
query built it; anything new that holds the first rendering has to be told
when what it waits on will never come.

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
that changes what an image shows builds the boxes again keeping every
style and **leaves `_sizes` alone**, as a `vw` does: core asks a document
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
it and `resources.ts` reaches the cascade through `svg.ts`.

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
the old one.

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
place a fetching policy belongs: a cache per page process, per-host pacing,
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
the example's workarounds say so where they are.

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
regular on macOS — and neither knows a width at all. `WebFonts.setting`
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
cannot read a selector list in, and nothing more.

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
drawing a move reached: `a:hover svg path` changes no box's style. Two
things keep a page of icons from paying for it, and both are easy to
undo. A rule asked of every `<path>`, or of every element, names the
ancestor it is for by a class or an id, which is looked for once around
the drawing rather than matched from each of its elements
(`ancestorKeys`); and the root's paint is its box's already, so an icon
set's `.icon { fill }` is not matched a second time. GitHub's repository
page, a hundred drawings and no rule for any shape in them, went from a
tenth of a millisecond a drawing to a few microseconds. A property added to
`shapes.ts` has to be one `SvgView` reads. An SVG _image_ is the same
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
that with a test page in Chrome, not with the recollection.

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

**Out of the plane, `placedMatrix` is a projection, and no context draws
through one.** A style out of the plane — by a function of its list,
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
milliseconds. Behind the viewer is nothing (`inFront`), and a layer on macOS
takes only matrices of the plane, so a box out of it is never lifted.

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
per-box caches assume a box's style never changes, so a frame that changes
a length builds boxes rather than restyling them and laying out again — at
once, so that where everything it changed is positioned out of the flow
and no other box moved, it repaints only those boxes' ink
(`_rebuildFrame`). Compare where a box is laid out there, not how far it
draws: an ancestor's ink bounds take in the marquee scrolling inside it.
**A frame repaints a box where it is drawn now** (`_inkOf`): a box fixed
to the viewport, or in one, is laid out at the document's top and drawn
where the pane's scroll has the viewport, so its ink is moved by that
scroll, as the paint and the hit test move it; and a `::before` or an
`::after` has no element in `styles`, so `_changedOutOfFlow` compares its
own box. Zen Garden 215's starburst turns and its robot rises, both fixed
pseudo-elements, and neither showed a frame until a scroll repainted them.
`animate={false}` draws each animation at rest, which is how the Zen
Garden bench runs `<Html>`.

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

**A box drawn on a surface of its own keeps the surface, keyed on its
`Box`.** X11 draws a turned box with text in it on a surface
(`paintRaster`), and X11 and Wayland draw an element an opacity fades as a
group on one (`paintGroup`). The surface is kept (`SpriteStore`) while the
box animates, or while it is no larger than a card's, and each paint draws
it through the matrix and at the opacity it has then — the Box-keyed
cache the hover paragraph warns of, on a still page as much as a moving
one, so it is forgotten wherever what a box draws can change. A build
clears the store, and so does a
layout at another width or under another viewport; `_restyleInPlace` drops
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
  The part is made again then, and its frames are kept apart, by the box,
  its style, the style it inherits from and its animations (`Sampled`): a
  spinner turning in a lifted card paints the card's layer again at each
  of its frames, and sampled the card's whole cycle at each as well until
  the frames were kept so.
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

**A video is core's `<video>`, mounted over the box, and never drawn
here** (`media.ts`, `videos.ts`; core's `docs/architecture/video.md`, 8.2).
The control rule again — a drawn video is a picture of a video — and the
same seam a host answers everything else through: `onResource` is asked
for each source as `kind: 'video'`, and answers with a `src` the platform's
player opens or a `VideoFrames` sink it feeds. The document lays the box
out and paints its poster as before, and the player, transparent until it
has a frame, goes over it, so nothing in the paint changes but the frame a
mounted video with no poster is not drawn in. Two things are
load-bearing. **A player is mounted only where nothing the document paints
after the video reaches its picture**, the sprite test (`paintedAfter`,
`crowded`), because a sibling over the document hides what is drawn over
the video — so a page's overlay keeps the poster, by design. And **a
mounted player is one React element for its element and source**, cut,
rounded and faded by the boxes around it (`renderVideo`'s three boxes): a
new element is a new player, and the video starts again. The boxes fixed to
the viewport are asked about at each paint (`_publishMedia`), since a scroll
brings a header over a player and lays nothing out.

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
npm run bench:zengarden:scroll  # a Zen Garden page scrolled, frame costs by region
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
npm run examples:media-player -- <file>   # X11 only, and mpv or VLC
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
  in-process X server, read back with `getImageData` (BGRA byte order), save
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
| mermaid                                          | nowhere — dropped from ntk                                                                          | **Dropped**, not extracted: 155 MB of install closure for a grammar. If it comes back, it comes back here, as its own subpath, and it stays optional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
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
