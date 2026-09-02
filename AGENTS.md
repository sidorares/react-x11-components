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
  components share — the height index, layout tick and scroll-reveal under
  `<Tree>` and `<Table>`, the typed `hx()` every composed widget writes its
  elements
  with, and the change event and dismiss-on-blur subscription under
  `<Calendar>`/`<DatePicker>` and `<ColorPicker>`/`<ColorField>` — that no
  app needs yet. Deliberately without an `index.ts`,
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
- `test/types/` — type-level tests, compiled by `npm run typecheck`.
- `scripts/check-package.ts` — the exports-map/publishability check. `tsc`
  is the build now, but it has no opinion about the exports map, so this
  still runs.
- `examples/` — one runnable file per component. These need a real
  `$DISPLAY`; CI does not run them.
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
avoid, paid only by the nodes that opt in), it does not scale with the zoom
(there is no transform), and its type reserves a `headerHeight` strip the
body does not cover, because a node made entirely of text fields has nothing
left to drag.

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
2x; each now multiplies by `this.scale` where it enters. Core's
`textIndexAt`/`textCaretRect`/`textRangeRects` seam is the deliberate
exception — it speaks device pixels, and the accessors here answer it that
way. `<CodeEditor>`'s `_posAt(ev.x, ev.y)` and `<ColorPicker>`'s
`fractionIn` still compare a logical event with a device `abs`.

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
the registry `Map`, and the `DRAWN_KINDS` set that `paintOrder()` filters
on. Two copies of react-x11 in one app means the registration lands in one
copy and the render happens in the other, and the symptom is an element that
lays out correctly, reports a sensible rect, and never paints, with no error
anywhere.

### Current status: core is released, and the git pin is gone

react-x11 **2.0.0 is published on npm**, and it carries every subpath this
package imports — `react-x11/host`, `/node`, `/style`, `/test`. Both specs
are now ordinary registry ranges:

- `peerDependencies.react-x11` is `^2.0.0` — what a consumer must supply.
- `devDependencies.react-x11` is `^2.0.0` — what the suite runs against.

Keep them the same range. They are one decision written twice, and a
devDependency that drifts above the peer range means the suite passes
against a core that consumers are not required to have.

Needing something core landed after 2.0.0 is now a normal release wait, not
a pin bump: it ships in 2.1.0, and both ranges pick it up. Do not reach back
for a `github:` spec to get at unreleased core — cut a core release instead.

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

`src/desktop-calendar/` reads the user's real calendars — Google, Microsoft,
CalDAV, local — over D-Bus through Evolution Data Server. It is the reason
`<Calendar dayContent>` exists, and the answer to "how do we get the user's
events" is: **the desktop already did the OAuth**, so this package never sees
a credential.

Two rules it establishes for anything else that talks to the system:

- **Never open your own bus.** `useSessionBus()` (or `sessionBus()` off the
  render path) hands over react-x11's shared connection. A second one makes
  the app two names on the bus — the tray under one, the exported service
  under another — and leaks a connection per mount. `DesktopCalendar` takes
  its bus as a constructor argument for exactly this reason, which is also
  what lets `test/desktop-calendar.test.ts` drive it from a fake one.
- **A heavy parser is an `optionalDependency`, and its types are ours.**
  `ical.js` is needed only to expand recurrence rules, so it is optional and
  loaded through a dynamic `import()` that is allowed to fail —
  `IcalUnavailableError` says which, and the hook reports `'unavailable'`
  rather than throwing. Its _types_ are written out structurally in
  `src/desktop-calendar/ical.ts` rather than imported: `import type … from
'ical.js'` would put it in the type graph and an app that did not install it
  could no longer type-check against this package, which is the opposite of
  optional. react-x11 does the same with `dbus-native`.

"No bus", "no EDS", and "no `ical.js`" are all ordinary states of a perfectly
healthy machine. None of them is an error to report — the calendar renders,
the dots do not.

`src/code-editor/lezer.ts` follows the same dynamic-import rule with one
deliberate difference: `@lezer/highlight` is an **optional peer** rather
than an optional dependency. An optionalDependency installs by default,
which is the right trade for `ical.js` (nothing else would bring it) and
the wrong one here — every `@lezer/<lang>` grammar package the app installs
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
the same shape `desktop-calendar/ical.ts` uses for an optional dependency,
for a different reason. `globalThis` is how `process.env` and the timers are
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
dependency on a binary. Same call `useDesktopCalendarEvents` makes about a
desktop with no Evolution Data Server.

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
  `fallback`, never a throw — the same call the calendar makes about a desktop
  with no Evolution Data Server.
- **Their types are ours.** `vt/xterm.ts` and `vt/pty.ts` write out the slice
  each package exposes structurally, for the reason `desktop-calendar/ical.ts`
  does: `import type … from '@xterm/headless'` would make an app that skipped
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
  and nothing else — react-x11's Cocoa backend as of 2.3.x, the default on a
  Mac — makes `_fontSet()` answer null, cached per font key, with a one-time
  development warning; the node then paints its background and nothing else,
  the same posture as the mock backend's missing pixel API. Filed upstream as
  sidorares/react-x11#432 (the face and ctx seams) and #433 (an offscreen
  `Surface`), over windowkit/appkit#1 (the CoreText natives). When they land,
  adoption is a react-x11 floor bump and nothing in `renderer.ts` or
  `fonts.ts` changes, because both already speak the documented contract.
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
  the suite does not fail, it **hangs**. Every test here passes a
  `FakePtyHost`; the one that drives a real pty is opt-in behind
  `REACT_X11_COMPONENTS_REAL_PTY=1` for the same reason.

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
and ntk is react-x11's dependency — so every app that can use this package
has all four installed already. Declaring them adds no packages to an
install; it makes the resolution correct under pnpm's strict layout instead
of relying on npm hoisting. **Check that this is still true before adding a
fifth.** If ntk drops them when the document widgets go, the closure argument
goes with it and the four become this package's to justify alone.

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
so a resize restyles only when it crossed one.

**Form controls are real widgets, mounted beside the element.** `<Flow>`'s
escape hatch, and the same reason: a drawn control takes no focus, says
nothing to an assistive technology, blinks no caret and opens no menu. The
cost is that the box in the flow has to be the size the widget will be
_before the widget exists_, which is why `controls.ts` measures against the
same font metrics and the same palette tokens (`paddingY`, `borderWidth`,
`radius`) core's own widgets read. `<textinput>` and `<textarea>` are
elements rather than components and draw no frame of their own, so the
component supplies one from those tokens — a form in a document and a form in
the window around it have to be the same height.

**Nothing is fetched and nothing is executed, by construction.**
`onResource` is the only way anything loads and `onScript` never runs
anything. Both are the same call `src/desktop-calendar/` makes about
credentials: the host already did the work of knowing its policy, and a
component that silently made requests would turn "render this HTML" into
"make these requests". A declined resource is an ordinary state, not an
error. **Do not add a convenience default that fetches**; the absence is the
feature.

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

**The isolated mode is designed and not built.** `<Html isolated>` — a child
process rendering into an XEmbed window — is specified in `docs/prd-html.md`,
including why the seams stay the parent's and why `handle.document` would
have to say it is a mirror rather than the live tree. The engine is written
so the renderer half is already process-portable; the follow-up adds a runner
over `src/embed/`'s existing lifecycle and changes nothing in `src/html/`.

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
npm run examples:calendar    # needs a real $DISPLAY (and a bus, for events)
npm run examples:charts      # needs a real $DISPLAY
npm run examples:code        # needs a real $DISPLAY
npm run examples:code-editor # needs a real $DISPLAY
npm run examples:html        # needs a real $DISPLAY
npm run examples:markdown    # needs a real $DISPLAY
npm run examples:terminal    # needs a real $DISPLAY and an emulator installed
npm run examples:terminal-vt # needs a real $DISPLAY and a pty module (node-pty)
npm run examples:media-player -- <file>   # needs a real $DISPLAY and mpv/VLC
npm run examples:table       # needs a real $DISPLAY
npm run examples:tray-host   # needs a real $DISPLAY with no tray on it yet
npm run examples:tree -- <dir>  # needs a real $DISPLAY; defaults to cwd
npm run examples:tree -- --stress[=rows]  # generated 100k-row tree instead
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
`src/markdown/parse.ts` (as parser tolerance, not a repair pre-pass; the
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

| Candidate                                        | Where it is now                                          | Status                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<markdown>`, `<html>`                           | replaced by `src/markdown/` and `src/html/` here         | **Done** for both. ntk's document widgets are deprecated ([ntk#106](https://github.com/sidorares/ntk/issues/106)); `<html>` was recorded here as "never" and is not — see the note above and `docs/prd-html.md` for why the distinction changed rather than the rule.                                                                                                                  |
| MDX in `<Markdown>`                              | reserved seams only (`component` AST node)               | **Planned.** Composition-friendly by construction; the parser is the only part that grows. Streaming-compatible in principle.                                                                                                                                                                                                                                                          |
| `<svg>`                                          | ntk (`SvgView`), wrapped in react-x11                    | **Staying in ntk**, per ntk#106. Recorded here so it is not reopened.                                                                                                                                                                                                                                                                                                                  |
| `<tex>`                                          | replaced by `src/formula/` here                          | **Done.** The last ntk document widget planned for decommission: `layoutTex` rendered one opaque drawing, so nothing inside it selected. `<Formula>` is a from-scratch successor (KaTeX's virtual DOM + its own CSS-subset layout, none of ntk's tex.js), selectable via the text accessors, fed by `<Markdown>`'s `fences` seam. `katex` is an optionalDependency here; ntk drops it. |
| mermaid                                          | nowhere — dropped from ntk                               | **Dropped**, not extracted: 155 MB of install closure for a grammar. If it comes back, it comes back here, as its own subpath, and it stays optional.                                                                                                                                                                                                                                  |
| `<Tabs>`                                         | superseded by `src/tabs/` here                           | **Done.** Same successor relationship as `<Tree>`: Chakra's compositional API with the parts spelled flat (like `<Timeline>`), keeping core's keyboard/RTL behaviour and dropping the items-array API. Core's remainder is an open core-side decision.                                                                                                                                 |
| `<Tree>`                                         | superseded by `src/tree/` here (see above)               | **Done.** Core's `src/components/Tree.js` is being retired; this is a successor, not a wrapper, and imports none of it. See "Replacing a core widget rather than moving it".                                                                                                                                                                                                           |
| `<Table>`                                        | superseded by `src/table/` here                          | **Done.** Same successor relationship as `<Tree>`; prop-compatible with core's, plus accessors, variable-height virtualization, multi-select and seams. Core's remainder — stripped or removed — is an open core-side decision. `docs/prd-table.md` is the design record.                                                                                                              |
| 3D scene graph, Three.js / r3f layer, `Canvas3D` | react-x11 `src/scene3d.js`, `src/components/Canvas3D.js` | **Candidate**, with `<glarea>` staying in core. See "The boundary can run through a feature".                                                                                                                                                                                                                                                                                          |
| react-flow clone                                 | `src/flow/` here                                         | **Done.** `<Flow>`: react-flow's surface API over one element that draws the graph, with a `render` seam for bodies that must be real widgets. See "Drawing beats composing".                                                                                                                                                                                                          |
| `<Terminal>`, `<MediaPlayer>`                    | new, here (`src/terminal/`, `src/media-player/`)         | **Done.** Built on core's `<foreign>`; the wrapper is here because a binary dependency can never be core's. See "Running someone else's program".                                                                                                                                                                                                                                      |
| `<TrayHost>`                                     | new, here (`src/tray-host/`)                             | **Done** (issue #17). XEmbed's third consumer here, and the other side of it. Core keeps the _plug_ side — `createRoot({ embedInto })` is renderer internals.                                                                                                                                                                                                                          |
| A StatusNotifierItem host                        | nowhere yet                                              | **Planned**, as a sibling of `<TrayHost>` with its own issue. Shares intent and nothing else: it pairs with core's `dbusmenu.js`, not with `<foreign>`.                                                                                                                                                                                                                                |
| A pure-JS VT backend for `<Terminal>`            | new, here (`src/terminal/vt/`)                           | **Done** (issue #19). `backend="vt"`, behind the existing props: pty + `@xterm/headless` + a cell-grid renderer. See "The terminal that is not somebody else's program".                                                                                                                                                                                                               |
| `<TerminalOutput>` — a captured session          | new, here (`src/terminal-output/` + `src/ansi/`)         | **Phase 1 done.** A log is a document, not a grid, so flow mode is `<richtext>` spans with no dependency at all. The cell-grid path for captures that addressed the cursor is phase 2 — see [the PRD](docs/prd-terminal-output.md).                                                                                                                                                    |

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
