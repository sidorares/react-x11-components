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
| `Code`        | `@react-x11/components/code`             | A static code block: highlighted, selectable.         |
| `CodeEditor`  | `@react-x11/components/code-editor`      | Multiline code editing: highlighting, completion.     |
| `Markdown`    | `@react-x11/components/markdown`         | Streaming-friendly GFM with cross-block selection.    |
| `MediaPlayer` | `@react-x11/components/media-player`     | mpv or VLC, embedded, with real transport control.    |
| `Sparkline`   | `@react-x11/components/sparkline`        | A bare line chart. Needs a width and a height.        |
| `Terminal`    | `@react-x11/components/terminal`         | A real terminal emulator, embedded as an element.     |
| _(hook)_      | `@react-x11/components/desktop-calendar` | The user's real calendar events, over D-Bus.          |

Three shared modules sit underneath and are importable on their own:
`/richtext` (the selectable styled-text element and its cross-block
selection controller), `/code-language` (the pluggable tokenizer seam,
the built-in languages and the token palettes) and `/embed` (the spawn,
watch and hand-back lifecycle both XEmbed wrappers are built on).

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
works everywhere. Copied text is clean: list markers and table chrome stay
behind, cells join with tabs and rows with newlines. Rendering is cached
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
explicit `language={…}`), selection and copy through the same machinery as
`<Markdown>` — and the line-number gutter is not part of the selection, so
copied code pastes clean.

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
- **`<Terminal>` has no `write()`.** There is no honest way to type into an
  external emulator — the pty is xterm's, not ours, and synthetic key events
  are refused by xterm (`allowSendEvents`) and dropped by alacritty. The name
  is reserved for a pure-JS VT backend over a real pty, which would own the
  input side and slot in behind the same props.

`npm run examples:terminal` and
`npm run examples:media-player -- <file>` are both working programs.

Both take a `processes` prop — the `ProcessHost` seam from
`@react-x11/components/embed` — so the child can be run somewhere other than
this machine, and so the test suite can assert what _would_ have been spawned
without an xterm in CI.

## Roadmap

Candidates to move here:

- The 3D scene graph and a Three.js / react-three-fiber-shaped layer, with
  `<glarea>` itself staying in core.
- A react-flow-style node/edge graph editor.
- `<Tabs>`, undecided — it may well stay in core.
- MDX support in `<Markdown>` — see the note in that section.
- A pure-JS VT backend for `<Terminal>`, over a pty rather than an external
  emulator. It would drop the external dependency, work where nothing is
  installed, and be the thing that makes `write()` real — behind the same
  props, which is why the component's API is backend-agnostic already.

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
