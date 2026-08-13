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
