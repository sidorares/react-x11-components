# embed

```ts
import {
  useEmbeddedClient,
  resolveBackend,
  nodeProcessHost,
  connectWhenReady,
  BackendUnavailableError,
} from '@react-x11/components/embed';
```

Running somebody else's program inside a `<foreign>`, without the vocabulary
of any particular program: spawn it, watch it, hand its window back
untouched.

A **shared module**, not a component. It registers no element and renders
nothing at import time, and it exists because
[`<Terminal>`](terminal.md) and [`<MediaPlayer>`](media-player.md) are the
same lifecycle with different argv. It is exported rather than kept private
for two reasons: `ProcessHost` is the seam an app needs to run the child
somewhere else — a container, an ssh host, a sandbox — and a fourth wrapper
around some other `-into WID` program should not have to copy the file to
exist.

## `useEmbeddedClient(options) → EmbeddedClient`

```jsx
const plan = useMemo(() => makePlan(key), [key]);
const client = useEmbeddedClient({ plan, enabled, onExit, onError });

<foreign onReady={client.handleReady} style={{ flexGrow: 1 }} />;
```

| Option       | Type                       | Notes                                                          |
| ------------ | -------------------------- | -------------------------------------------------------------- |
| `plan`       | `PlanFactory`              | **Must be referentially stable.** See below.                   |
| `host`       | `ProcessHost`              | Defaults to `nodeProcessHost()`.                               |
| `enabled`    | `boolean`                  | False holds off entirely — a pane that is not visible yet.     |
| `stopSignal` | `string`                   | Sent on unmount and on restart. Default `SIGTERM`.             |
| `onStart`    | `(info) => void`           | The process exists; `info.backend` is the one the plan picked. |
| `onExit`     | `(info: ExitInfo) => void` |                                                                |
| `onError`    | `(err: Error) => void`     | Spawn failures and missing backends alike.                     |

Returned:

```ts
interface EmbeddedClient {
  status: 'idle' | 'starting' | 'running' | 'exited' | 'unavailable';
  error: Error | null; // the last failure, including BackendUnavailableError
  pid: number | null;
  windowId: number | null; // the container window, once <foreign> has one
  backend: string | null;
  handleReady: (info: { windowId: number }) => void; // wire to <foreign onReady>
  restart: () => void;
  signal: (signal?: string) => boolean;
}
```

### `plan` identity is the restart signal

**A new `plan` identity restarts the child.** That is how "the command
changed" reaches a program that cannot be reconfigured in place — and it is
also why a factory rebuilt every render restarts the child every render.

Both components build theirs with `useMemo` over a **string key** rather than
over the props themselves, because `command={['bash']}` is a new array on
every paint and an effect keyed on that never settles. `useDesktopCalendarEvents`
keys on `from.getTime()` for the same reason.

## `LaunchPlan`

What a `PlanFactory` returns, given a `PlanContext` (`{ windowId, host }`):

```ts
interface LaunchPlan {
  command: string; // absolute path, or a name on PATH
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  backend?: string; // which backend this plan chose
  attach?(process: SpawnedProcess): void | (() => void) | Promise<…>;
  dispose?(): void | Promise<void>;
}
```

`attach` is where a control channel goes — mpv's JSON IPC socket is attached
there. Its return value is called at teardown, **before** the process is
signalled. `dispose` always runs at teardown: temporary directories, sockets.

## `ProcessHost` — where the program runs

```ts
interface ProcessHost {
  which(command: string): Promise<string | null>;
  spawn(command, args, options?): Promise<SpawnedProcess>;
  socketPath(prefix: string): Promise<ScratchSocket>;
  connect(path: string): Promise<IpcSocket>;
  environment(): Record<string, string | undefined>;
}
```

`nodeProcessHost()` is this machine, through node, and is the default. It is
memoized — repeated calls return the same host.

Implement your own and the child runs wherever you say: `docker exec`, an ssh
host, a sandbox. It is also what the test suite drives, which is how
`test/terminal.test.ts` asserts what _would_ have been spawned on a CI
machine with no xterm on it.

`SpawnOptions.env` is **added to the ambient environment** rather than
replacing it — a terminal with no `PATH` and no `HOME` is not a terminal. An
explicit `undefined` removes a variable.

## `resolveBackend(host, what, candidates)`

Walks the candidates in order, and inside each one its `binaries` in order,
returning the first that `which()` finds:

```ts
const { backend, path } = await resolveBackend(host, 'terminal', [
  xterm,
  urxvt,
  alacritty,
]);
```

With none of them installed it throws `BackendUnavailableError`, which
carries `tried` — the binaries it looked for, in order — so the message an
app shows can name them rather than saying "not found".

**Nothing here is a hard dependency.** A machine with no emulator and no
player is an ordinary state of a healthy machine, which is why the miss is a
typed error routed to `onError` and a `fallback`, not a throw out of render.

## `connectWhenReady(host, path, options?)`

A child that creates a unix socket does not create it the instant it starts.
This retries `host.connect(path)` until it succeeds or the deadline passes —
`timeoutMs` defaults to 5000, `intervalMs` to 50 — and rejects with
`IpcConnectError` otherwise.

## Mechanically, what `<foreign>` does

A `<foreign>` with no `windowId` **adopts** whatever is put inside it. The
container's X window id arrives in `onReady`, and the plan spawns
`xterm -into $WID` or `mpv --wid=$WID` into it. Layout, focus, the ICCCM
configure and handing the client back untouched on unmount are all core's —
this module is the process half only.
