// <Terminal> — a real terminal emulator, embedded as an element.
//
// The first of the two XEmbed wrappers (the other is `../media-player/`), and
// the reason `<foreign>` exists in core at all: a react-x11 app can now *host*
// another X client instead of only drawing its own pixels.
//
// What this component is, mechanically: a `<foreign>` with no `windowId`, so
// it adopts whatever is put inside it; `xterm -into $WID` spawned with the id
// core hands over in `onReady`; and a per-backend adapter table
// (`./backends.ts`) that turns one set of props into three different command
// lines. Layout, focus, the ICCCM configure and handing the client back on
// unmount are all core's — see react-x11's `foreignnodes.js`.
//
// Registers no element: `<foreign>` is a built-in. Like `<Calendar>`, this
// module has **no side effect at import time at all**.
//
// ### What is deliberately not here
//
// **`write()`.** The issue this came from sketches a handle with
// `write()`/`signal()`/`restart()`, and the other two are here. Writing into
// the terminal is not, because there is no honest way to do it with an
// external emulator: the pty belongs to xterm, not to us, so "type this" would
// have to be synthetic X key events — which xterm ignores unless
// `allowSendEvents` is on (a documented security setting, off by default, and
// not ours to turn on in a user's terminal), and which alacritty's event loop
// filters out entirely. The name is reserved rather than faked: a pure-JS VT
// backend over a pty — the fallback the issue also sketches — owns the input
// side for real, and `write()` lands with it, behind the same props.
import React, { useMemo } from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { useTheme } from 'react-x11';
import type { ForeignProps } from 'react-x11';
import type { Style } from 'react-x11/style';

import {
  BackendUnavailableError,
  resolveBackend,
  useEmbeddedClient,
} from '../embed/index.js';
import type {
  EmbedStatus,
  ExitInfo,
  LaunchPlan,
  PlanContext,
  ProcessHost,
} from '../embed/index.js';
import { backendsFor } from './backends.js';
import type {
  TerminalBackendName,
  TerminalColors,
  TerminalLaunch,
} from './backends.js';
import { useForeignTitle } from './title.js';
import { hx } from './hx.js';

export {
  TERMINAL_BACKENDS,
  alacritty,
  backendsFor,
  urxvt,
  xterm,
} from './backends.js';
export type {
  TerminalBackend,
  TerminalBackendName,
  TerminalColors,
  TerminalLaunch,
} from './backends.js';

const h = React.createElement;

/** `<foreign>`'s props as `hx` takes them — `theme` is dropped because
 *  `hx` re-declares it (see `./hx.ts`). */
type ForeignElementProps = Omit<ForeignProps, 'theme'>;

/** What a `ref` on `<Terminal>` gets. */
export interface TerminalHandle {
  /** Stop the emulator and start a new one. The scrollback is the old
   *  process's and does not survive; nothing else was ours to keep. */
  restart(): void;
  /** Signal the emulator process. `SIGTERM` by default; `false` when there
   *  is no process to signal. */
  signal(signal?: string): boolean;
  /** The emulator's pid, or `null`. */
  readonly pid: number | null;
  /** The `<foreign>` container's X window id — what the emulator was given. */
  readonly windowId: number | null;
  /** Which backend was chosen, once one has been. */
  readonly backend: string | null;
  readonly status: EmbedStatus;
}

export interface TerminalProps {
  /**
   * argv to run, `['bash', '-lc', 'npm test']`. Omit it for the user's login
   * shell, which is what every emulator here does with no `-e`.
   *
   * **Changing this restarts the terminal**, because an emulator cannot be
   * handed a new command. Pass a stable array (or a stable `useMemo`) unless a
   * restart is what you mean — the component keys on the *contents*, not the
   * identity, so an inline literal is fine as long as its contents are.
   */
  command?: readonly string[];
  cwd?: string;
  /** Added to the ambient environment, not a replacement for it. */
  env?: Record<string, string | undefined>;
  /** Which emulator. Default `'auto'`: the first of xterm, urxvt, alacritty
   *  that is installed. */
  backend?: TerminalBackendName;
  fontFamily?: string;
  fontSize?: number;
  /** Lines of scrollback the emulator keeps. */
  scrollback?: number;
  /** The emulator's window title before the program sets one of its own. */
  title?: string;
  /**
   * Colours for the emulator. Default: the react-x11 theme's `background` and
   * `text`, with the accent as the cursor, so the pane matches the app around
   * it. Pass `{}` to leave the emulator on its own defaults, or override any
   * subset.
   *
   * `palette` (ANSI 0–15) reaches xterm and alacritty; urxvt takes its from
   * the X resource database, which is the user's and not ours to write.
   */
  colors?: TerminalColors;
  /** The program exited — including because `restart()` or unmount killed
   *  it. */
  onExit?: (info: ExitInfo) => void;
  /** The emulator's `_NET_WM_NAME` changed: what the shell says is running. */
  onTitleChange?: (title: string) => void;
  /** Spawn failures, and the `BackendUnavailableError` for a machine with no
   *  emulator installed. Without a handler neither is reported anywhere —
   *  `status` and `fallback` are the visible half. */
  onError?: (err: Error) => void;
  /** Rendered instead of the surface when no backend is installed. */
  fallback?: ReactNode;
  /** False holds off spawning — a pane in a tab that is not open yet. */
  enabled?: boolean;
  /** Sent on unmount and restart. Default `SIGTERM`. */
  stopSignal?: string;
  /**
   * Where the process runs. Defaults to this machine, through node. The seam
   * is public because "run it in a container / over ssh / under a sandbox" is
   * a real thing to want and should not need a fork — and because it is what
   * the tests drive.
   */
  processes?: ProcessHost;
  /** A terminal is a control the user tabs to. False for a decorative one. */
  focusable?: boolean;
  style?: Style | Style[];
  ref?: Ref<TerminalHandle>;
  'data-testname'?: string;
}

/**
 * A terminal emulator, laid out like any other element.
 *
 * ```jsx
 * <Terminal
 *   command={['bash', '-lc', 'npm test']}
 *   cwd={projectDir}
 *   style={{ flexGrow: 1 }}
 *   onExit={({ code }) => setDone(code === 0)}
 *   onTitleChange={setTabLabel}
 *   fallback={<text>Install xterm to use the console.</text>}
 * />
 * ```
 *
 * **The emulator's window stacks above everything drawn in this one**, the
 * same rule `<glarea>` has, so nothing 2D can overlap it: an overlay belongs
 * in a sibling `<popup>`.
 *
 * **Keys reach the app first.** While the terminal holds focus, react-x11
 * dispatches each key through the React tree and forwards whatever nothing
 * called `preventDefault()` on — so an application chord still wins. The one
 * exception is X's own rule that the pointer position picks the recipient:
 * while the pointer is *over* the terminal, keys go straight to it.
 */
export function Terminal(props: TerminalProps): ReactElement {
  const {
    backend = 'auto',
    enabled = true,
    focusable,
    processes,
    stopSignal,
  } = props;
  const theme = useTheme() as unknown as Record<string, unknown>;

  // Everything that goes into the command line, as one string.
  //
  // This is the restart key, and it is a string rather than a dependency list
  // for the reason `useDesktopCalendarEvents` keys on `from.getTime()`:
  // `command={['bash']}` and `colors={{}}` are new identities on every paint,
  // and an effect keyed on them would kill and respawn a terminal per frame.
  const colors = useMemo<TerminalColors>(() => {
    if (props.colors) return props.colors;
    return {
      background: String(theme.background ?? '#101014'),
      foreground: String(theme.text ?? '#e6e6e6'),
      cursor: String(theme.accent ?? theme.text ?? '#e6e6e6'),
    };
    // The theme object is stable per palette in react-x11, so this recomputes
    // when the desktop switches light/dark and not otherwise.
  }, [props.colors, theme]);

  const launch = useMemo<Omit<TerminalLaunch, 'windowId'>>(
    () => ({
      command: props.command,
      title: props.title,
      fontFamily: props.fontFamily,
      fontSize: props.fontSize,
      scrollback: props.scrollback,
      colors,
    }),
    [
      props.command,
      props.title,
      props.fontFamily,
      props.fontSize,
      props.scrollback,
      colors,
    ],
  );

  const key = useMemo(
    () =>
      JSON.stringify([
        backend,
        launch.command ?? null,
        props.cwd ?? null,
        props.env ?? null,
        launch.title ?? null,
        launch.fontFamily ?? null,
        launch.fontSize ?? null,
        launch.scrollback ?? null,
        colors,
      ]),
    [backend, launch, props.cwd, props.env, colors],
  );

  // Read through a ref so the factory's identity — the restart signal — is
  // the key and nothing else. Without this an `env={{ TERM: 'xterm-256color' }}`
  // literal would restart the terminal on every render.
  const latest = React.useRef({ launch, cwd: props.cwd, env: props.env });
  latest.current = { launch, cwd: props.cwd, env: props.env };

  const plan = useMemo(
    () =>
      async ({ windowId, host }: PlanContext): Promise<LaunchPlan> => {
        const candidates = backendsFor(backend);
        if (candidates.length === 0) {
          throw new BackendUnavailableError('terminal', [backend]);
        }
        const chosen = await resolveBackend(host, 'terminal', candidates);
        const current = latest.current;
        return {
          command: chosen.path,
          args: chosen.backend.args({ ...current.launch, windowId }),
          cwd: current.cwd,
          env: current.env,
          backend: chosen.backend.name,
        };
      },
    // `key` is the whole dependency: it is the serialization of everything
    // `latest.current` is read for.
    [backend, key],
  );

  const client = useEmbeddedClient({
    plan,
    host: processes,
    enabled,
    stopSignal,
    onExit: props.onExit,
    onError: props.onError,
  });

  const title = useForeignTitle(props.onTitleChange);

  React.useImperativeHandle(
    props.ref,
    () => ({
      restart: client.restart,
      signal: client.signal,
      get pid() {
        return client.pid;
      },
      get windowId() {
        return client.windowId;
      },
      get backend() {
        return client.backend;
      },
      get status() {
        return client.status;
      },
    }),
    [client],
  );

  const style: Style = {
    flexGrow: 1,
    // What the container shows before the emulator's window covers it, and
    // between an exit and a restart. `<foreign>` reads it off the ordinary
    // `backgroundColor` rather than a prop of its own.
    backgroundColor: colors.background ?? String(theme.background ?? '#101014'),
  };
  const styles: Style[] = [style];
  if (props.style) {
    for (const extra of Array.isArray(props.style)
      ? props.style
      : [props.style]) {
      styles.push(extra);
    }
  }

  // No backend installed is an ordinary state of a perfectly healthy machine,
  // not an error to report — the same call `useDesktopCalendarEvents` makes
  // about a desktop with no Evolution Data Server.
  if (client.status === 'unavailable' && props.fallback !== undefined) {
    return h(React.Fragment, null, props.fallback);
  }

  const foreign: ForeignElementProps = {
    onReady: client.handleReady,
    onEmbedded: title.onEmbedded,
    onClientGone: title.onClientGone,
    focusable: focusable ?? true,
    'aria-label': 'Terminal',
    style: styles,
  };

  // `data-testname` is a runtime convention — react-x11's queries read it off
  // `props` — and its element declarations do not carry it. Attached past the
  // type here so the rest of the object above is still checked against
  // `<foreign>`, which is the whole reason `hx` exists.
  return hx('foreign', {
    ...foreign,
    'data-testname': props['data-testname'],
  } as ForeignElementProps);
}
