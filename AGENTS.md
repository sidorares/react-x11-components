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
  `<Markdown>` and `<Code>` — it paints per-run decoration and answers
  core's four text accessors, so a document selects across it — plus the
  edit menu a read-only surface offers), `src/codeblock/` (the look of a
  block of code: the palette, the runs and the chrome `<Code>` and
  `<Markdown>`'s fences share), `src/code-language/` (the tokenizer
  seam, the built-in languages, the token palettes — under `<CodeEditor>`,
  `<Code>` and `<Markdown>`'s fences alike) and `src/embed/` (the spawn,
  watch and hand-back lifecycle under `<Terminal>` and `<MediaPlayer>`,
  plus the `ProcessHost` seam — see "Running someone else's program"). A
  shared module never calls
  `registerElement` at module scope; `richtext` exports
  `registerRichText()` instead, and **each component that renders the
  element calls it at its own module scope**, so "a component registers
  its element in its own index.ts" keeps holding and an app that imports
  neither component registers nothing.
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
and **no side effect at import time at all**. Both shapes belong here; the
`registerElement` seam is a tool, not an entry requirement.

`src/calendar/hx.ts` is what makes the no-JSX rule survive TypeScript.
`React.createElement`'s own overloads are `@types/react`'s and describe the
DOM, so a `<box onKeyDown>` handler gets checked against React's
`KeyboardEvent` rather than react-x11's. `hx('box', …)` looks the name up in
react-x11's element table instead, and `hx('div', …)` is an error. Reach for
it in any component that writes more than a couple of elements.

### Vendored from core

`src/calendar/dates.ts` and `src/calendar/internal.ts` are copies of code that
is still in react-x11 today — the day arithmetic, `tint`, `changeEvent`,
`useDismissOnWindowBlur`. They were copied rather than imported because they
are not on core's exports map, and they are pure, so the copy is cheap.

**Core is expected to drop `<Calendar>` and `<DatePicker>`, so divergence here
is intended rather than drift.** This package is the owner now. Until that
lands, the two copies exist; do not try to keep them in sync.

Everything else the calendar stands on is public API: `useTheme`,
`createStyles`, `<Icon>`, `useAnchor`/`useAnchorTracking`, the `XK_*` keysyms,
and `cssColorStraight` off `react-x11/ntk`.

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

### Current status: core is unreleased

The subpaths this package imports — `react-x11/host`, `/node`, `/style`,
`/test` — do not exist in the published react-x11 1.2.0. They are on
`master`, unreleased. So:

- `peerDependencies.react-x11` is `^2.0.0` — the version core will cut next
  (there are breaking changes queued on master, so release-please will go to
  2.0.0, not 1.3.0).
- `devDependencies.react-x11` is `github:sidorares/react-x11#<commit>` — a
  **full commit sha, not `#master`**, which is what makes the suite runnable
  and CI green today.

**When core publishes 2.0.0, change the devDependency to `^2.0.0` and drop
the git URL.** Nothing else should need touching.

**The spec names the commit, because the lockfile alone does not hold a
floating one.** `#master` plus a locked commit reads like it pins, and does
on npm 10 — but npm 11 (Node 24) re-resolves the branch and installs
whatever master is now, so `npm ci` gave the matrix two different cores and
only the Node 24 leg failed. Naming the sha is what makes every `npm ci`,
on every npm, install the thing the tree was written against.

So depending on something core landed since that commit is two edits, not
one: use it, and move the pin.

```bash
npm install --package-lock-only --save-dev "github:sidorares/react-x11#<sha>"
npm ci        # what CI installs, and now what it installs everywhere
```

Skipping the bump is the failure that looks like nothing: a working tree that
already has the newer core installed passes everything locally, and every CI
job fails on an import that is not there yet. `src/tray-host/` needed this for
`serverTime()`, and `src/richtext/` for the selection service (#291) and the
edit menu (#289).

**The pin is also how far up master this package has migrated.** It sits at
`70264563` — core's `fix/scroll-blit-claim-race` branch (react-x11#296),
which is `b98d520c` plus one scroll-blit fix and nothing else — deliberately
short of `49fb2b30` (react-x11#290, `feat(theme)!`), which drops `Theme.dim`
and retypes the palette. `src/calendar/` and `src/code-editor/` do not
compile against the theme break yet; that migration is its own change, so
the pin moves past `49fb2b30` together with it or not at all. A branch
commit is an exception to "how far up master", carried because the charts
need the fix: once #296 merges, the next pin bump lands back on master's
first-parent line.

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
  react-x11's entire closure. Both absences are `status: 'unavailable'` plus
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
  racing for one selection unable to be ordered. **This needed the lockfile
  pin bumped**, because core is a `github:…#master` git spec: see "react-x11
  is a peer dependency".
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
npm run examples:markdown    # needs a real $DISPLAY
npm run examples:terminal    # needs a real $DISPLAY and an emulator installed
npm run examples:terminal-vt # needs a real $DISPLAY and a pty module (node-pty)
npm run examples:media-player -- <file>   # needs a real $DISPLAY and mpv/VLC
npm run examples:tray-host   # needs a real $DISPLAY with no tray on it yet
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
and neither supported selection. There is deliberately **no `<html>`
successor**: nothing in this package renders through an HTML pass. The
reuse question was asked against Vercel's Streamdown first and answered
"behaviour yes, code no" — its pipeline is remark→rehype→DOM, but its
`remend` package's unterminated-markdown rules are implemented natively by
`src/markdown/parse.ts` (as parser tolerance, not a repair pre-pass; the
handlers were read, not imported).

| Candidate                                        | Where it is now                                          | Status                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<markdown>`, `<html>`                           | replaced by `src/markdown/` here (see above)             | **Done** for markdown, **never** for html. ntk's document widgets are deprecated; see [ntk#106](https://github.com/sidorares/ntk/issues/106).                            |
| MDX in `<Markdown>`                              | reserved seams only (`component` AST node)               | **Planned.** Composition-friendly by construction; the parser is the only part that grows. Streaming-compatible in principle.                                            |
| `<svg>`, `<tex>`                                 | ntk (`SvgView`, `layoutTex`), wrapped in react-x11       | **Staying in ntk**, per ntk#106. Recorded here so it is not reopened.                                                                                                    |
| mermaid                                          | nowhere — dropped from ntk                               | **Dropped**, not extracted: 155 MB of install closure for a grammar. If it comes back, it comes back here, as its own subpath, and it stays optional.                    |
| `<Tabs>`                                         | react-x11 `src/components/Tabs.js`                       | **Open.** May stay in core. Undecided — do not move it on a hunch.                                                                                                       |
| 3D scene graph, Three.js / r3f layer, `Canvas3D` | react-x11 `src/scene3d.js`, `src/components/Canvas3D.js` | **Candidate**, with `<glarea>` staying in core. See "The boundary can run through a feature".                                                                            |
| react-flow clone                                 | prototype, not yet in any repo                           | **Incoming.** A node/edge graph editor: big, pure composition, small fraction of apps — this package's shape exactly.                                                    |
| `<Terminal>`, `<MediaPlayer>`                    | new, here (`src/terminal/`, `src/media-player/`)         | **Done.** Built on core's `<foreign>`; the wrapper is here because a binary dependency can never be core's. See "Running someone else's program".                        |
| `<TrayHost>`                                     | new, here (`src/tray-host/`)                             | **Done** (issue #17). XEmbed's third consumer here, and the other side of it. Core keeps the _plug_ side — `createRoot({ embedInto })` is renderer internals.            |
| A StatusNotifierItem host                        | nowhere yet                                              | **Planned**, as a sibling of `<TrayHost>` with its own issue. Shares intent and nothing else: it pairs with core's `dbusmenu.js`, not with `<foreign>`.                  |
| A pure-JS VT backend for `<Terminal>`            | new, here (`src/terminal/vt/`)                           | **Done** (issue #19). `backend="vt"`, behind the existing props: pty + `@xterm/headless` + a cell-grid renderer. See "The terminal that is not somebody else's program". |

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

1. **The first publish must be manual.** Trusted publishing binds to a
   package that already exists on the registry, so `npm publish
--access public` has to be run once by hand before the automation works.
2. The `@react-x11` npm scope must exist and this repo + workflow must be
   configured as a trusted publisher for `@react-x11/components`.

`dist/` is not committed, so publishing depends on the build running. It
does: `prepack` is wired to `npm run build`, which covers `npm publish` and
`npm pack` alike, and the release workflow also builds explicitly so a
compile failure is its own red step. What this means for the manual first
publish is that it has to happen after an `npm ci` in a clean checkout, not
from a tree where `dist/` was left over from something else.

Do not publish before react-x11 2.0.0 is on npm — the peer range cannot be
satisfied until then.

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
