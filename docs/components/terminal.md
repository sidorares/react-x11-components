# Terminal

```jsx
import { Terminal } from '@react-x11/components/terminal';

<Terminal
  command={['bash', '-lc', 'npm test']}
  cwd={projectDir}
  style={{ flexGrow: 1 }}
  onExit={({ code }) => setPassed(code === 0)}
  onTitleChange={setTabLabel}
  fallback={<text>Install xterm to use the console.</text>}
/>;
```

A real terminal in a react-x11 app, two ways behind one set of props:

- **an embedded emulator** — xterm, urxvt or alacritty, spawned with
  `-into $WID` into a `<foreign>` container this component owns;
- **`backend="vt"`** — this package's own emulator: a pty, `@xterm/headless`
  as the escape-sequence state machine, and a cell-grid renderer that is a
  native element rather than a hole punched in the window.

`backend` defaults to `'auto'`, which walks **xterm → urxvt → alacritty →
vt**. Since the last rung needs nothing installed, `auto` effectively always
succeeds; `fallback` is reached only when there is also no pty module.

**The first three rungs are X11-only.** They are XEmbed, and macOS has no
cross-process window embedding to build that on — react-x11's own
[macOS backend document][macos] says so and names this component in as much.
`backend="vt"` is the whole terminal on the Cocoa backend, and it is a native
element there rather than a hole punched in the window, so nothing is lost
but the choice of emulator.

The probe that picks a rung is a `PATH` probe, and a `PATH` probe cannot see
which backend the app is running on: on a Mac with XQuartz installed,
`'auto'` will still pick that xterm and then have nothing to embed it into.
**An app that runs on both backends should say `backend="vt"` outright**
rather than rely on `'auto'`.

[macos]: https://github.com/sidorares/react-x11/blob/master/docs/macos.md

## Props

### Process

| Prop         | Type                                  | Notes                                                                                                                                                                                     |
| ------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`    | `readonly string[]`                   | argv. Omit for the user's login shell. **Changing it restarts the terminal** — an emulator cannot be handed a new command. Keyed on contents, not identity, so an inline literal is fine. |
| `cwd`        | `string`                              |                                                                                                                                                                                           |
| `env`        | `Record<string, string \| undefined>` | Added to the ambient environment, not a replacement for it.                                                                                                                               |
| `enabled`    | `boolean`                             | False holds off spawning — a pane in a tab that is not open yet.                                                                                                                          |
| `stopSignal` | `string`                              | Sent on unmount and restart. Default `SIGTERM`.                                                                                                                                           |
| `processes`  | `ProcessHost`                         | Where the process runs. See [embed](embed.md).                                                                                                                                            |

### Appearance

| Prop         | Type                  | Notes                                                                                                                    |
| ------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `backend`    | `TerminalBackendName` | `'auto'` (default), `'xterm'`, `'urxvt'`, `'alacritty'`, `'vt'`.                                                         |
| `fontFamily` | `string`              |                                                                                                                          |
| `fontSize`   | `number`              |                                                                                                                          |
| `scrollback` | `number`              | Lines the emulator keeps.                                                                                                |
| `title`      | `string`              | The emulator window's title before the program sets one. XEmbed backends only — the vt backend has no window of its own. |
| `colors`     | `TerminalColors`      | See below.                                                                                                               |
| `focusable`  | `boolean`             | A terminal is a control the user tabs to; default true.                                                                  |
| `fallback`   | `ReactNode`           | Rendered instead of the surface when no backend is available.                                                            |
| `style`      | `Style \| Style[]`    |                                                                                                                          |

### Events

| Prop            | Type                       | Notes                                                                                                                                                                                      |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onExit`        | `(info: ExitInfo) => void` | Including because `restart()` or unmount killed it.                                                                                                                                        |
| `onTitleChange` | `(title: string) => void`  | What the shell says is running.                                                                                                                                                            |
| `onError`       | `(err: Error) => void`     | Spawn failures, and the `BackendUnavailableError` for a machine with nothing installed. **Without a handler neither is reported anywhere** — `status` and `fallback` are the visible half. |

### vt backend only

Each of these needs the emulator to be ours. On an XEmbed backend they are
ignored — the running program owns its cursor, its bell and its clipboard,
and none of it is reachable from out here — with a warning in development,
because a prop that silently does nothing is the worst shape a prop has.

| Prop                  | Type                              | Notes                                                                                                                                         |
| --------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `cursorStyle`         | `'block' \| 'underline' \| 'bar'` | Default `'block'`.                                                                                                                            |
| `cursorBlink`         | `boolean`                         | Default true.                                                                                                                                 |
| `bell`                | `'none' \| 'visual'`              | Default `'none'`; `'visual'` flashes the pane.                                                                                                |
| `onBell`              | `() => void`                      |                                                                                                                                               |
| `allowClipboardWrite` | `boolean`                         | Honour OSC 52 clipboard **writes** — how `tmux` and `vim` copy out of an ssh session. Default true. Reads are never answered, at any setting. |
| `onSelectionChange`   | `(text: string) => void`          | The user finished selecting; the text is also on PRIMARY.                                                                                     |
| `pty`                 | `PtyHost`                         | See "Bring your own pty".                                                                                                                     |

## Colours

```ts
interface TerminalColors {
  background?: string;
  foreground?: string;
  cursor?: string;
  palette?: readonly string[]; // ANSI 0–15
}
```

**The terminal is themed by default.** Background, foreground and cursor come
from the react-x11 palette, so a pane looks like part of the app rather than
a hole punched in it. `colors` overrides any subset, and `colors={{}}` leaves
the emulator on its own defaults.

`palette` reaches xterm and alacritty from the command line, and the vt
backend applies it exactly. urxvt takes its palette from the X resource
database, which is the user's and not ours to write — `TERMINAL_BACKENDS`
carries a `palette: boolean` per backend if you need to check.

## `TerminalHandle`

```ts
const term = useRef(null);
term.current.write('ls\n'); // vt backend only
```

| Member                               | Backends | Notes                                                                |
| ------------------------------------ | -------- | -------------------------------------------------------------------- |
| `restart()`                          | all      | The scrollback is the old process's and does not survive.            |
| `signal(sig?)`                       | all      | `SIGTERM` by default; `false` when there is no process.              |
| `pid`, `status`, `backend`           | all      |                                                                      |
| `windowId`                           | XEmbed   | `null` on vt, which has no child X window.                           |
| `write(data)`                        | vt       | **`false` everywhere else** — see below.                             |
| `cols`, `rows`, `resizeToFit()`      | vt       | `null` elsewhere.                                                    |
| `selection()`, `clearSelection()`    | vt       |                                                                      |
| `scrollLines(n)`, `scrollToBottom()` | vt       | Negative `n` goes back into the scrollback.                          |
| `serialize()`                        | vt       | The visible screen as text — "copy all", and what a test asserts on. |

**`write()` needs the pty to be ours.** On the embedded emulators the pty is
xterm's; synthetic key events are refused by xterm (`allowSendEvents`) and
dropped by alacritty. An app feature-tests with the call itself.

## Things to know about the embedded backends

- **The client's window stacks above everything you draw.** Same rule
  `<glarea>` has. A transport bar or a HUD cannot be a `<box>` over the
  surface — put it beside the element, or in a sibling `<popup>`.
- Mechanically: a `<foreign>` with no `windowId` adopts whatever is put
  inside it, the container's X window id arrives in `onReady`, and the
  component spawns `xterm -into $WID` into it. Layout, focus, the ICCCM
  configure and handing the client back untouched on unmount are all core's.

## `backend="vt"` — the terminal this package draws itself

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

- **It works with nothing installed** — no xterm, no alacritty.
- **`write()` is real**, and with it `cols`/`rows`, `resizeToFit()`,
  `selection()`, `scrollLines()` and `serialize()`.
- **It is a native element.** Theme colours apply exactly, a `<popup>`
  composites _above_ it, and focus follows the app's rules.
- **It is testable without a display.** A fake pty plus the in-process X
  server gives byte-in/pixel-out tests; `test/terminal-vt.test.ts` is one.

Rendering draws with XRender glyph runs into a retained offscreen surface,
scrolls with a server-side copy, and coalesces onto react-x11's vblank-paced
frame clock.

That is the X11 backend, and since react-x11 2.5.0 the native macOS backend
too: the Cocoa face grew ntk's glyph-run seams in 2.4.0
(sidorares/react-x11#432) and the offscreen `Surface` arrived in 2.5.0
(#433), so the same renderer draws CoreText glyph runs into a CG bitmap and
scrolls it in place, unchanged — the adoption that moved this package's
react-x11 floor to `^2.5.0` at the time, since raised for other reasons.
A text engine without those seams (a face with metrics and coverage and
nothing else) is still an ordinary state rather than a throw: the terminal
paints nothing and says so once in development.

### A flood of output, and the window's `frameRate`

A program that prints faster than anyone can read — `find ~`, `cat` of a
large file — claims a repaint per parsed batch, and react-x11's frame clock
paints as many of those as the display allows. On X11 the server's own
backpressure bounds it: the frame is fenced by a round trip, so a flood
paints as often as the server keeps up and no more. On the native macOS
backend the clock is the display's own period and every frame's pixel work
runs on the JS thread, so the same flood paints at 120 Hz and the program
gets what is left — measured at four times slower than XQuartz on the same
machine (docs/prd-frame-pacing.md §2).

**The knob is the window's, not the terminal's.** Pacing belongs to the
surface the frames go to, so react-x11 2.9.0 put it on `<window>` rather
than on any element, and a terminal-shaped app sets it there:

```jsx
<window frameRate="throughput">
  <Terminal backend="vt" style={{ flexGrow: 1 }} />
</window>
```

`createRoot({ frameRate })` says the same for every window a root opens, and
`REACT_X11_FRAME_RATE` overrides both from the environment — an A/B run
needs no code change. The rule prices frames in CPU time rather than
counting them: credit accrues at `budget` ms per ms of wall time, a frame
spends what it cost, and a claim that finds the account in debt waits for it
to refill. So an idle claim never waits — a keystroke's echo after a pause
paints on the next tick whatever the last frame cost — a cheap frame is
never held, and only a _stream_ of expensive ones throttles.

| `frameRate`                  | `budget` | `minFps` | `maxFps` | for                                      |
| ---------------------------- | -------: | -------: | -------: | ---------------------------------------- |
| `'display'`                  |        1 |     none |     none | the default: every frame the clock gives |
| `'adaptive'`                 |     0.25 |       20 |     none | a UI that also streams                   |
| `'throughput'`               |      0.1 |       10 |       30 | large output — the flood case            |
| a number                     |        1 |     none |        n | a plain ceiling, nothing else            |
| `{ budget, minFps, maxFps }` |        — |        — |        — | any of the three, spelled out            |

`examples/terminal-vt.tsx` is the menu that walks them, with a `flood`
button beside it that runs `time awk …` so the shell prints the cost of the
setting itself.

**The element's own half of the gap is done.** `<vtterm>` answers
`Node.opaqueRect()` with its grid and claims a rect inside it, so a repaint
under a flood skips the window and box backgrounds the surface is about to
cover; the renderer composites its surface as a `copy` rather than a blend —
XRender's `Src`, a row memcpy on macOS; and the node subscribes to
`onWriteParsed` alone, where `onScroll` had been firing once per scrolled
line (336,000 claims in a 300,000-line flood). All three are react-x11
2.9.0's seams (sidorares/react-x11#497 and #501), and together they took
that flood from 3.5s to 1.1s on macOS. docs/prd-frame-pacing.md §5.3 is the
design.

Keyboard, mouse and selection are what a terminal user expects:
xterm-compatible key encoding (application cursor and keypad modes, the
modifier parameter scheme, `Alt` as an ESC prefix), mouse reporting in the
tracking mode the program asked for with Shift as the universal "let me
select instead" override, char/word/line selection that publishes PRIMARY,
middle-click paste, Ctrl+Shift+C/V, bracketed paste, and OSC 52 clipboard
writes — never reads, which are answered with nothing whatever a program
asks for.

Escape arms one pass-through Tab, so the terminal is not a keyboard trap.
Escape still reaches the program, and the arming is off while an
alternate-screen application (vim, htop) is up, because it owns Esc-then-Tab
as real input.

### Dependencies, and why they are split

- `@xterm/headless` is an **optionalDependency**: 2 MB, installs by default,
  because nothing else would bring it.
- The pty is an **optional peer** — either `node-pty` or `@lydell/node-pty`,
  probed in that order. node-pty unpacks to 64 MB and builds a native addon,
  which is not something a package a calendar app installed may drag in.
- **Under Bun, neither is needed.** Bun 1.4 has a pty of its own, and the
  backend prefers it over both peers — nothing native is probed or loaded.

```bash
npm i node-pty              # or: npm i @lydell/node-pty — not under Bun
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

### Bring your own pty

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
  multi-byte UTF-8 in half. The emulator's decoder carries a partial
  character across chunks; a per-chunk decode cannot.
- **Empty `argv` means "your default shell, wherever you are".** The
  component does not substitute this machine's `$SHELL`, because over ssh
  that is the wrong answer.
- **A failed connection is `'exited'`, not `'unavailable'`.** `fallback` is
  for "this machine cannot run a terminal at all"; an ssh host that refused
  you is ordinary bad news, and it arrives through `onError`.

`examples/terminal-ssh.tsx` is a complete ssh2 adapter — about eighty lines,
with the three gotchas marked — and runs against a real host:

```bash
npm i --save-dev ssh2
SSH_HOST=example.com SSH_USER=me npm run examples:terminal-ssh
```

## Examples

`npm run examples:terminal` and `npm run examples:terminal-vt` are both
working programs. [The design document](../prd-vt-terminal.md) is behind the
vt backend.
