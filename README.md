# @react-x11/components

Components for [react-x11](https://github.com/sidorares/react-x11) that do
not belong in the core package.

Everything here is built on react-x11's public API — the built-in host
elements, or the `registerElement` seam in `react-x11/host`. Nothing here
needs a change to core to exist, and core does not grow to carry it.

> **Not published yet.** This package needs react-x11 2.0.0, which is not on
> npm — the subpath exports it imports (`react-x11/host`, `/node`, `/style`,
> `/test`) are on core's `master`, unreleased. Until then, use it from a
> checkout.

## What is here, and what is in core

react-x11 itself carries an element or component when **any** of these hold:

- the vast majority of UI apps use it;
- it depends on renderer internals — implementing it outside would mean
  exposing details that should not be public, or giving up performance;
- it needs enough standards compliance that the behaviour is hard to agree on
  or implement piecemeal.

This package carries it when **all** of these hold:

- a smaller fraction of apps need it;
- it can be built on the public react-x11 API;
- it is big enough that core would pay for it, in install closure or in
  maintenance.

So `<box>`, `<text>`, `<window>`, buttons, menus, dialogs and the rest of the
widget set are core. Heavier, more specialised things live here.

The line can also fall inside a single feature. `<glarea>` is core — it is a
real X window on a GLX visual, which is renderer internals. A Three.js-shaped
scene graph drawn into it is not: that is composition over a public element,
and it belongs here.

## Install

```bash
npm install @react-x11/components
```

`react` and `react-x11` are peer dependencies — deliberately. Registering a
host element mutates state inside react-x11, so a second copy of the renderer
would leave you with an element that lays out correctly and never paints.

## Usage

```jsx
import { Sparkline } from '@react-x11/components';

function App() {
  return (
    <window width={360} height={160} title="components">
      <box style={{ flexGrow: 1, padding: 16 }}>
        <Sparkline
          data={[3, 7, 4, 9, 6, 11, 8]}
          color="#c0392b"
          strokeWidth={2}
          style={{ width: 320, height: 80 }}
        />
      </box>
    </window>
  );
}
```

Importing a component is what teaches react-x11 its element, so there is no
setup call to remember and no registration to run at startup.

## Tree-shaking

Use one component, pay for one component. Each is its own module with its own
entry point, the package declares `"sideEffects": false`, and importing the
barrel for nothing at all bundles to nothing. That last property is a test in
this repo, not an aspiration.

Deep imports work too, for apps without a bundler:

```js
import { Sparkline } from '@react-x11/components/sparkline';
```

## TypeScript

The package is written in TypeScript and ships its own declarations, so
there is no `@types` package to install. Point your compiler at react-x11's
JSX namespace and the host elements type-check:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-x11"
  }
}
```

Importing a component teaches JSX its element too, so `<sparkline>` is a
typed tag as soon as `Sparkline` is in scope. Props types are exported
under their component's name:

```ts
import type { SparklineProps } from '@react-x11/components';
```

## Components

| Component     | Import                                   |                                                       |
| ------------- | ---------------------------------------- | ----------------------------------------------------- |
| `Calendar`    | `@react-x11/components/calendar`         | A month grid: one date or a range, any day blockable. |
| `DatePicker`  | `@react-x11/components/calendar`         | That calendar on a popup, behind a field.             |
| `LineChart` … | `@react-x11/components/charts`           | Cartesian charts; a million points is a normal input. |
| `Code`        | `@react-x11/components/code`             | A static code block: highlighted, selectable.         |
| `CodeEditor`  | `@react-x11/components/code-editor`      | Multiline code editing: highlighting, completion.     |
| `Markdown`    | `@react-x11/components/markdown`         | Streaming-friendly GFM with cross-block selection.    |
| `MediaPlayer` | `@react-x11/components/media-player`     | mpv or VLC, embedded, with real transport control.    |
| `Sparkline`   | `@react-x11/components/sparkline`        | A bare line chart. Needs a width and a height.        |
| `Terminal`    | `@react-x11/components/terminal`         | A real terminal: an embedded emulator, or its own.    |
| `TrayHost`    | `@react-x11/components/tray-host`        | The system tray: applications dock their icons in.    |
| _(hook)_      | `@react-x11/components/desktop-calendar` | The user's real calendar events, over D-Bus.          |

Four shared modules sit underneath and are importable on their own:
`/richtext` (the styled-text element a document selects across),
`/codeblock` (the look of a block of code, shared by `<Code>` and
`<Markdown>`'s fences), `/code-language` (the pluggable tokenizer seam,
the built-in languages and the token palettes) and `/embed` (the spawn,
watch and hand-back lifecycle both XEmbed wrappers are built on).

Selecting text is **core's**, not this package's: a `<box selectable>` is
a surface, everything under it that answers for its own text is in the
selection, and the drag, the word and block granularities, Ctrl+A, Ctrl+C
and PRIMARY come with it (react-x11#291). `<Markdown>` and `<Code>` set
that prop and say which parts are chrome; the elements underneath answer
`textContent`/`textIndexAt`/`textCaretRect`/`textRangeRects`, which is all
an element of your own has to do to join a document.

## Charts

A [shadcn/charts](https://ui.shadcn.com/charts)-shaped component set for
cartesian charts — line, area, bar, scatter — with the composition you
expect and a cost model you usually do not: **every frame is bounded by
pixels, never by points.**

```jsx
import {
  ChartContainer,
  LineChart,
  LineSeries,
  XAxis,
  YAxis,
  CartesianGrid,
  ChartTooltip,
  ChartLegend,
} from '@react-x11/components/charts';

const config = {
  cpu: { label: 'CPU', color: '$accent' },
  mem: { label: 'Memory', color: '#e17055' },
};

<ChartContainer config={config} style={{ height: 240 }}>
  <LineChart data={rows}>
    <CartesianGrid />
    <XAxis dataKey="time" type="time" />
    <YAxis />
    <LineSeries dataKey="cpu" />
    <LineSeries dataKey="mem" curve="monotone" />
    <ChartTooltip />
    <ChartLegend />
  </LineChart>
</ChartContainer>;
```

The children are config carriers, recharts-style; one registered element
paints the grid, the axes and every series in a single pass. `data` takes
rows (shadcn-familiar), columns (`{ length, columns }` of typed arrays —
the fast path), or a `ChartData` streaming store whose appends extend the
decimation index incrementally and never rescan.

What "put a lot of effort into performance" means here, concretely:

- **Off the viewport costs nothing.** Core already culls the paint of
  scrolled-away nodes; a `ChartData` append to a fully offscreen chart
  skips even the invalidation — scrolling back repaints from current data.
- **Too small to see costs nothing to draw.** Every series renders through
  a per-pixel-column min/max index (a pyramid over the data, built lazily
  and extended on append), so a million points in a 90px cell cost ~90
  rectangles. A million points that fall on one pixel render one pixel.
- **Server-side drawing commands by default, pixels when they win.** A
  dense line goes out as one batched `FillRectangles` (~8 bytes per pixel
  column); a sparse one as a real antialiased path. The one place a pixel
  push wins — a scatter covering most of the plot — is detected by
  comparing the actual byte costs, and flips to one composited density
  image.

Tooltips snap to the nearest point in O(log n) through a ref into the
element. **The value bubble is a real popup window by default** — anchored
to the data point through core's anchor system, stacked above everything
(content that flows after the chart included), flipped at screen edges,
never focused. `<ChartTooltip mode="overlay">` keeps it as a
hit-transparent box inside the chart instead — one window, one paint
surface — with the documented trade that later siblings can overdraw
whatever part of it would have left the chart's box. The crosshair and
point markers are part of the plot and stay in-window either way, and the
hover's React re-render contributes no damage of its own. Pass
`onFrameStats` to see
what any frame cost: per-series mode, commands issued, estimated wire
bytes, prep and paint time. `npm run examples:charts` is a live tour —
streaming at 60 points/s, a million-point walk, small multiples, stacked
bars and areas, a 200k-point density scatter — with that HUD under every
chart. [`docs/prd-charts.md`](docs/prd-charts.md) is the design record.

Pie/radial charts and a second y axis are deliberately not in this first
cut; the cartesian perf story is.

## Markdown

A GFM renderer built for streamed model output — the
[Streamdown](https://streamdown.ai/) use case, rendered natively. Feed it a
growing `source` and every instant renders clean: unclosed `**bold`,
`` `code `` or a half-arrived `[link](…` never flash their raw markers, an
ambiguous `---` tail is held until it can be read, an open fence is already
a code block. When the stream ends, flip `partial` off.

```jsx
import { Markdown } from '@react-x11/components/markdown';

<box style={{ overflow: 'scroll', flexGrow: 1 }}>
  <Markdown
    source={streamed}
    partial={stillStreaming}
    onLink={(href) => open(href)}
    style={{ padding: 16 }}
  />
</box>;
```

The feature set is GFM: headings (ATX and setext), emphasis with the real
CommonMark delimiter algorithm, inline code, links and autolinks, images
(rendered as their alt text, linked to the source — no remote fetches),
nested and task lists, blockquotes, tables with alignment and measured
column widths, thematic breaks, fenced code highlighted through the same
language seam as `<CodeEditor>` (with ntk's highlighter as a fallback for
tags the built-ins do not cover). The parser is this package's own — no
markdown→HTML pass anywhere — and is exported (`parseMarkdown`) with the
AST types.

**Selection is the point.** Text selects across every block — drag,
double-click a word, triple-click a block, Ctrl+A, Ctrl+C — and a mouse-up
with a selection takes the X11 PRIMARY selection, so middle-click paste
works everywhere. All of that is core's `selectable` (react-x11#291); what
this component adds is which parts are chrome, so copied text is clean:
list markers stay behind, and the separators come from the layout, which
for a table is exactly cells with tabs and rows with newlines. Rendering is cached
per top-level block on the raw source text, so appending to the tail
re-renders the tail alone. `npm run examples:markdown` streams a document
in live.

MDX is on the roadmap, not in the box: the AST reserves a `component` node
and the renderer is ordinary React composition, so user components can
interleave — including mid-stream — once the parser learns the syntax.

## Code

The static sibling of `<CodeEditor>`: a read-only, selectable code block
for showing code rather than editing it.

```jsx
import { Code } from '@react-x11/components/code';

<Code source={snippet} lang="ts" lineNumbers />;
```

Highlighting goes through the same language seam (`lang` tag or an
explicit `language={…}`) and the look is shared with `<Markdown>`'s fenced
blocks, so the two agree in one window. Selection and copy are core's; the
line-number gutter is `selectable={false}`, so copied code pastes clean.

## The code editor

A multiline editor for code-shaped input — a SQL box, a shell one-liner, a
config field, a small IDE pane:

```jsx
import {
  CodeEditor,
  sql,
  sqlCompletionSource,
  keywordCompletionSource,
} from '@react-x11/components/code-editor';

<CodeEditor
  language={sql()}
  value={query}
  onChange={(ev) => setQuery(ev.value)}
  completionSources={[
    sqlCompletionSource({ users: ['id', 'name'] }),
    keywordCompletionSource(),
  ]}
  lineNumbers
  style={{ flexGrow: 1 }}
/>;
```

Editing is the full expected set: selection (keyboard and mouse, word and
line variants), undo/redo with coalescing, X11 clipboard including PRIMARY
and middle-click paste, auto-indent, Tab/Shift+Tab indentation, Ctrl+/
comment toggling, bracket matching, and LSP-shaped `diagnostics` squiggles.
Escape then Tab leaves the field. Ctrl+Space asks for completions.

Languages are pluggable, three ways:

- **Built-in, zero dependencies**: `sql()`, `shell()`, `glsl()`,
  `javascript()` (`{ typescript: true }` for TS), `json()` — hand-written
  stream tokenizers on a CodeMirror-5-style line-state engine, or write your
  own with `streamLanguage(…)` in ~50 lines.
- **The CodeMirror grammar world**: `lezerLanguage({ name, parser })` runs
  any `@lezer/<lang>` parser. Install the grammar you want; nothing lezer
  ships with this package.
- **The VS Code grammar world**: `textMateLanguage({ name, grammar })` runs
  an initialized TextMate grammar (via `vscode-textmate` or shiki's core) —
  their tokenizer is line-state shaped too, so it drops straight in.

Completion sources are one async function each, deliberately the shape of an
LSP `textDocument/completion` call, so a language-server client is "just
another source". `npm run examples:code-editor` shows the three input-field
use cases side by side.

## The user's real calendar

`useDesktopCalendarEvents` reads the calendars the desktop already has —
Google, Microsoft, CalDAV, local — through Evolution Data Server over D-Bus.
**Your app never sees a credential and never runs an OAuth flow**, because the
desktop did that already, in Settings.

```jsx
import { Calendar, useDesktopCalendarEvents } from '@react-x11/components';

function Month({ from, to }) {
  const { byDay } = useDesktopCalendarEvents({ from, to, watch: true });

  return (
    <Calendar
      dayContent={(day, state) =>
        (byDay.get(day) ?? []).slice(0, 3).map((ev, i) => (
          <box
            key={i}
            style={{
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: state.selected
                ? state.color
                : (ev.calendar.color ?? '$accent'),
            }}
          />
        ))
      }
    />
  );
}
```

The keys `byDay` uses are exactly the `'YYYY-MM-DD'` days `dayContent` is
handed, so nothing sits between the two.

Expanding recurring events needs [`ical.js`](https://github.com/kewisch/ical.js),
which is an **optional** dependency — install it if you want events:

```bash
npm install ical.js
```

Without it, or with no session bus, or on a desktop with no Evolution Data
Server, `status` is `'unavailable'` and the calendar simply renders without
dots. None of those is an error; they are ordinary states of a healthy
machine. `npm run examples:calendar` in this repo is the whole thing working.

## Hosting another X client: `<Terminal>` and `<MediaPlayer>`

These two are the same component twice, and they are what core's `<foreign>`
element was added for: a react-x11 app can now **host** another X client
rather than only drawing its own pixels.

```jsx
import { Terminal } from '@react-x11/components';

<Terminal
  command={['bash', '-lc', 'npm test']}
  cwd={projectDir}
  style={{ flexGrow: 1 }}
  onExit={({ code }) => setPassed(code === 0)}
  onTitleChange={setTabLabel}
  fallback={<text>Install xterm to use the console.</text>}
/>;
```

```jsx
import { MediaPlayer } from '@react-x11/components';

<MediaPlayer
  src={file}
  aspectRatio="16:9"
  volume={0.8}
  style={{ flexGrow: 1 }}
  onProgress={({ position, duration }) => setScrub(position / duration)}
  onEnded={next}
/>;
```

Mechanically: a `<foreign>` with no `windowId` adopts whatever is put inside
it, the container's X window id arrives in `onReady`, and the component
spawns `xterm -into $WID` or `mpv --wid=$WID` into it. Layout, focus, the
ICCCM configure and handing the client back untouched on unmount are all
core's.

**Nothing is a hard dependency.** No emulator and no player is an ordinary
state of a healthy machine, so `backend` defaults to `'auto'` and picks the
first of xterm / rxvt-unicode / alacritty (or mpv / VLC) that is actually
installed; with none of them, `fallback` renders and `onError` gets a
`BackendUnavailableError` naming what was looked for.

Four things worth knowing before reaching for them:

- **The client's window stacks above everything you draw.** Same rule
  `<glarea>` has. A transport bar or a HUD cannot be a `<box>` over the
  surface — put it beside the element, or in a sibling `<popup>`.
- **The terminal is themed by default.** Background, foreground and cursor
  come from the react-x11 palette, so a pane looks like part of the app.
  `colors` overrides any of it, and `colors={{}}` leaves the emulator on its
  own defaults.
- **`src`, `volume`, `muted` and `paused` are live commands**, sent over
  mpv's JSON IPC socket — changing them does not respawn the player. Under
  VLC that channel is write-only, so play/pause/seek/volume work and
  `onProgress` never fires; `handle.reportsProgress` says which you have.
- **`write()` needs the pty to be ours**, so it works on `backend="vt"`
  below and returns `false` on the embedded emulators: the pty there is
  xterm's, and synthetic key events are refused by xterm
  (`allowSendEvents`) and dropped by alacritty. An app can feature-test with
  the call itself.

`npm run examples:terminal` and
`npm run examples:media-player -- <file>` are both working programs.

Both take a `processes` prop — the `ProcessHost` seam from
`@react-x11/components/embed` — so the child can be run somewhere other than
this machine, and so the test suite can assert what _would_ have been spawned
without an xterm in CI.

### `<Terminal backend="vt">` — the terminal this package draws itself

One prop changes the terminal from a hosted X client into a native element: a
pty (through a pluggable `PtyHost`), [`@xterm/headless`][xterm-headless] as
the escape-sequence state machine, and a cell-grid renderer that draws with
XRender glyph runs into a retained offscreen surface, scrolls with a
server-side copy, and coalesces onto react-x11's vblank-paced frame clock.

```jsx
<Terminal
  backend="vt"
  command={['bash', '-l']}
  cursorStyle="bar"
  bell="visual"
  style={{ flexGrow: 1 }}
  onSelectionChange={setCopied}
  fallback={<text>Install a pty module: npm i node-pty</text>}
/>
```

What it buys over the embedded emulators:

- **It works with nothing installed** — no xterm, no alacritty. That is why
  `backend="auto"` (the default) now ends here instead of at the `fallback`:
  the ladder is xterm → urxvt → alacritty → vt.
- **`write()` is real**, and with it `cols`/`rows`, `resizeToFit()`,
  `selection()`, `scrollLines()` and `serialize()` on the handle.
- **It is a native element, not a hole punched in the window.** Theme colours
  apply exactly (`colors.palette` included, which urxvt cannot take at all),
  a `<popup>` composites _above_ it, and focus follows the app's rules.
- **It is testable without a display.** A fake pty plus the in-process X
  server gives byte-in/pixel-out tests; `test/terminal-vt.test.ts` is one.

The dependencies stay optional, and the split is deliberate:
`@xterm/headless` is an **optionalDependency** (2 MB, installs by default —
nothing else would bring it), while the pty is an **optional peer**, either
`node-pty` or `@lydell/node-pty`, probed in that order. node-pty unpacks to
64 MB and builds a native addon, which is not something a package a calendar
app installed may drag in. So an app installs the one it wants:

```bash
npm i node-pty              # or: npm i @lydell/node-pty
```

With neither present, `status` is `'unavailable'` and `fallback` renders — an
ordinary state of a healthy machine, never a throw. `onError` says _which_
half is missing, and separates "nothing installed" from "installed but it
would not load", because a native module built for another Node ABI looks
exactly like a missing one from the outside and "install it" is then the
wrong advice.

None of it costs anything to an app that does not use it: the whole vt
module, `registerElement('vtterm')` included, sits behind a dynamic
`import()` taken only when the backend is selected, and
`test/treeshake.test.ts` asserts the terminal's entry chunk does not contain
it.

Keyboard, mouse and selection are what a terminal user expects: xterm-compatible
key encoding (application cursor/keypad modes, the modifier parameter
scheme, `Alt` as an ESC prefix), mouse reporting in the tracking mode the
program asked for (with Shift as the universal "let me select instead"
override), char/word/line selection that publishes PRIMARY, middle-click
paste, Ctrl+Shift+C/V, bracketed paste, and OSC 52 clipboard **writes** —
never reads, which are answered with nothing whatever a program asks for.

Escape arms one pass-through Tab, so the terminal is not a keyboard trap;
Escape still reaches the program, and the arming is off while an alternate-screen
application (vim, htop) is up, because it owns Esc-then-Tab as real input.

#### Bring your own pty

`pty` takes a `PtyHost`, and when you pass one **node-pty is never loaded**.
Anything that carries bytes both ways and can be told a size is a terminal:
ssh2, a WebSocket, `docker exec`, a serial port, a device over TCP.

```ts
interface PtyHost {
  available(): Promise<boolean>;
  openPty(argv: readonly string[], opts: PtyOptions): Promise<PtySession>;
  environment?(): Record<string, string | undefined>;
}

interface PtySession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): boolean;
  onData(listener: (chunk: string | Uint8Array) => void): void;
  onExit(listener: (info: ExitInfo) => void): void;
  pause?(): void; // flow control, when the transport has it
  resume?(): void;
  readonly pid: number | null; // null is fine — SSH has no pid
}
```

Three things worth knowing before writing one:

- **Hand over bytes when you have bytes.** `onData` accepts a `Uint8Array` (a
  node `Buffer` is one), and passing it through untouched is not an
  optimisation — a `.toString()` on whatever boundary the network chose cuts
  multi-byte UTF-8 in half. The emulator's decoder carries a partial character
  across chunks; a per-chunk decode cannot.
- **Empty `argv` means "your default shell, wherever you are".** The component
  does not substitute this machine's `$SHELL`, because over ssh that is the
  wrong answer; `nodePtyHost` fills it in locally, and a remote host opens a
  login shell on the far side.
- **A failed connection is `'exited'`, not `'unavailable'`.** `fallback` is for
  "this machine cannot run a terminal at all"; an ssh host that refused you is
  ordinary bad news, and it arrives through `onError`.

[`examples/terminal-ssh.tsx`](examples/terminal-ssh.tsx) is a complete ssh2
adapter — about eighty lines, with the three gotchas marked — and runs against
a real host:

```bash
npm i --save-dev ssh2
SSH_HOST=example.com SSH_USER=me npm run examples:terminal-ssh
```

`npm run examples:terminal-vt` is a working program, and
[`docs/prd-vt-terminal.md`](docs/prd-vt-terminal.md) is the design document
behind it.

[xterm-headless]: https://www.npmjs.com/package/@xterm/headless

## The system tray: `<TrayHost>`

The same protocol as the two above, pointed the other way. `<Terminal>` and
`<MediaPlayer>` spawn a program into a container they own; a tray is handed
windows by applications that were already running, and the
[system tray spec](http://specifications.freedesktop.org/systemtray/latest/)
is XEmbed's biggest surviving consumer.

```jsx
import { TrayHost } from '@react-x11/components';

<TrayHost
  orientation="horizontal"
  iconSize={22}
  onDock={(icon) => log(`docked ${icon.id}`)}
  onUndock={(icon) => log(`gone ${icon.id}`)}
/>;
```

Mounting it takes the `_NET_SYSTEM_TRAY_S<screen>` selection with a real
server timestamp, publishes `_NET_SYSTEM_TRAY_ORIENTATION`, and broadcasts
`MANAGER` to the root — which is what makes applications that started before
the panel go and dock themselves. Each `SYSTEM_TRAY_REQUEST_DOCK` becomes one
`<foreign>`; unmounting gives the selection back and hands every client to
the root untouched.

Four things that are decisions rather than gaps:

- **One tray per display, and a second one says so.** If the selection is
  already owned, the host reports it through `onConflict`, renders
  `fallback`, and embeds nothing — a second panel is a configuration mistake,
  not an exception to throw. Losing the selection later (another tray started)
  releases every icon, because a panel still drawing icons it no longer holds
  is the failure users report as "my tray is empty".
- **A visual is advertised only when there is one.**
  `_NET_SYSTEM_TRAY_VISUAL` appears only when the window the icons are
  embedded into genuinely carries a 32-bit ARGB visual — so put the tray in a
  `<window transparent>` and icons get real translucency, and anywhere else
  they fall back to guessing a background rather than drawing black boxes.
- **Icons are not tab stops.** Every icon is `focusable={false}`: a tray icon
  is a click target, and Tab walking through eleven of them (several of which
  may not have mapped yet) is the worst version of this.
- **Reordering moves nodes, it does not re-embed clients.** `sort` is a
  comparator rather than a list you rebuild, because each `<foreign>` is keyed
  on the window id and its `windowId` never changes. Unmounting one node and
  mounting another with the same id parks the client at the root long enough
  for a window manager to frame it, and the new node then reports
  `onClientGone` for a live window.

Balloon messages — `SYSTEM_TRAY_BEGIN_MESSAGE`, the pre-notification-daemon
way an icon says something — are reassembled from their 20-byte chunks and
forwarded to the desktop's notification service by default. Pass `onMessage`
to draw your own bubble instead (which turns the forwarding off), or
`notify={false}` to drop them.

`npm run examples:tray-host` is a one-row panel that is the tray for its
display. **StatusNotifierItem is not in this component**: modern applications
publish a tray icon over D-Bus, a complete panel supports both, and SNI
shares nothing with this except intent — it belongs beside `<TrayHost>`
rather than inside it.

## Roadmap

Candidates to move here:

- The 3D scene graph and a Three.js / react-three-fiber-shaped layer, with
  `<glarea>` itself staying in core.
- A react-flow-style node/edge graph editor.
- `<Tabs>`, undecided — it may well stay in core.
- MDX support in `<Markdown>` — see the note in that section.
- A StatusNotifierItem host, beside `<TrayHost>` rather than inside it: the
  D-Bus way modern applications publish a tray icon. It pairs with core's
  `dbusmenu.js`, and a complete panel wants both.

`<Markdown>` above **replaces** core's ntk-backed `<markdown>` element
(ntk's `MarkdownView` and `HtmlView` widgets are being deprecated). There
is no `<html>` successor here and no plan for one: rendering is
box-and-text composition, never an HTML pass. `<svg>` and `<tex>` stay in
ntk; mermaid was dropped rather than extracted — 155 MB of install closure
for a grammar.

## Contributing

[AGENTS.md](AGENTS.md) is the contributor guide: the rule for what belongs
here, the layout, the tree-shaking constraints, and the two ways a registered
element fails silently.

## License

MIT
