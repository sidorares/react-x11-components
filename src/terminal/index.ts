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
// Registers no element *itself*: `<foreign>` is a built-in, and the vt
// backend's `<vtterm>` is registered by `./vt/index.ts`, which is reached
// only through a dynamic `import()`. So this module still has **no side
// effect at import time at all**, and an app on an XEmbed backend never loads
// the emulator core.
//
// ### The second backend
//
// `backend="vt"` is the same component over a pty and `@xterm/headless`,
// rendered as a native element rather than as somebody else's X window. It is
// what makes `write()` real — the pty is ours — and what works on a machine
// with no emulator installed, which is why `'auto'` ends there rather than at
// the `fallback`.
//
// **`write()` still returns `false` on the XEmbed backends**, and that is not
// an oversight: the pty belongs to xterm, so "type this" would have to be
// synthetic X key events, which xterm ignores unless `allowSendEvents` is on
// (a documented security setting, off by default and not ours to change in a
// user's terminal) and which alacritty's event loop filters out entirely.
// Returning `false` rather than throwing lets an app feature-test with the
// call itself.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import type { PtyHost } from './vt/pty.js';
import type { VtHandle, VtTerminalProps } from './vt/index.js';

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

/**
 * What `import('./vt/index.js')` resolves to.
 *
 * A `typeof import(…)` type rather than a value import: the whole point is
 * that the vt module — and `@xterm/headless` behind it — is fetched only when
 * a vt terminal is actually rendered, which is what `test/treeshake.test.ts`
 * asserts by bundling this subpath and looking for the emulator in it.
 */
type VtModule = typeof import('./vt/index.js');

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
  /** The `<foreign>` container's X window id — what the emulator was given.
   *  `null` on the vt backend, which has no child X window. */
  readonly windowId: number | null;
  /** Which backend was chosen, once one has been. */
  readonly backend: string | null;
  readonly status: EmbedStatus;

  /**
   * Type into the terminal. **vt backend only** — `false` everywhere else,
   * for the reason at the top of this file, so an app can feature-test with
   * the call itself.
   */
  write(data: string): boolean;
  /** Re-derive the grid from the current layout now, rather than at the next
   *  paint. vt only. */
  resizeToFit(): void;
  /** Columns and rows the emulator currently has. vt only. */
  readonly cols: number | null;
  readonly rows: number | null;
  /** The selected text, or null. vt only. */
  selection(): string | null;
  clearSelection(): void;
  scrollToBottom(): void;
  /** Move the viewport by `n` lines — negative is back into the scrollback. */
  scrollLines(n: number): void;
  /** The visible screen as text: "copy all", and what a test asserts on. */
  serialize(): string | null;
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
  /**
   * Which terminal. Default `'auto'`: the first of xterm, urxvt, alacritty
   * that is installed, and `'vt'` — this package's own emulator, which needs
   * nothing installed — when none of them is.
   */
  backend?: TerminalBackendName;
  fontFamily?: string;
  fontSize?: number;
  /** Lines of scrollback the emulator keeps. */
  scrollback?: number;
  /** The emulator's window title before the program sets one of its own.
   *  XEmbed backends only — the vt backend has no window of its own to name,
   *  and reports the program's own title through `onTitleChange`. */
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

  // --- vt backend only -----------------------------------------------------
  //
  // Each of these needs the emulator to be ours. On an XEmbed backend they are
  // ignored — the running program owns its cursor, its bell and its clipboard,
  // and none of it is reachable from out here — with a warning in development,
  // because a prop that silently does nothing is the worst shape a prop has.

  /** Default `'block'`. */
  cursorStyle?: 'block' | 'underline' | 'bar';
  /** Default true. */
  cursorBlink?: boolean;
  /** The program rang the bell. */
  onBell?: () => void;
  /** What the bell looks like. Default `'none'`; `'visual'` flashes the pane. */
  bell?: 'none' | 'visual';
  /** Honour OSC 52 clipboard *writes* — how `tmux` and `vim` copy out of an
   *  ssh session. Default true. Reads are never answered, at any setting. */
  allowClipboardWrite?: boolean;
  /** The user finished selecting; the text is also on PRIMARY. */
  onSelectionChange?: (text: string) => void;
  /**
   * Where the pty comes from. The `processes` seam's counterpart, public for
   * the same reason — "run the shell in a container / over ssh / under a
   * sandbox" is a real thing to want — and what the tests drive.
   */
  pty?: PtyHost;
}

/** The props only the vt backend reads, for the development warning below. */
const VT_ONLY = [
  'cursorStyle',
  'cursorBlink',
  'onBell',
  'bell',
  'allowClipboardWrite',
  'onSelectionChange',
  'pty',
] as const;

/**
 * Say so, once, when a vt-only prop was passed to an embedded emulator.
 *
 * `process` and `console` come off `globalThis` because the build compiles
 * `src/` with `types: []` — a Node global that wanders in has to fail the
 * build rather than become an implicit `@types/node` dependency.
 */
function warnVtOnly(props: TerminalProps): void {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    console?: { warn(message: string): void };
  };
  if (g.process?.env?.NODE_ENV === 'production') return;
  const named = VT_ONLY.filter((name) => props[name] !== undefined);
  if (named.length === 0) return;
  g.console?.warn(
    `@react-x11/components: <Terminal ${named.join(', ')}> ` +
      `${named.length === 1 ? 'is' : 'are'} only honoured by ` +
      'backend="vt" — an embedded emulator owns its own cursor, bell and ' +
      'clipboard.',
  );
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
 * **On an XEmbed backend the emulator's window stacks above everything drawn
 * in this one**, the same rule `<glarea>` has, so nothing 2D can overlap it:
 * an overlay belongs in a sibling `<popup>`. The vt backend has no child
 * window and composites like any other node, so a `<popup>` over it works.
 *
 * **Keys reach the app first.** While the terminal holds focus, react-x11
 * dispatches each key through the React tree and forwards whatever nothing
 * called `preventDefault()` on — so an application chord still wins. The one
 * exception is X's own rule that the pointer position picks the recipient:
 * while the pointer is *over* an embedded emulator, keys go straight to it.
 *
 * **The vt backend is the floor.** With `backend="auto"` (the default), a
 * machine with no emulator installed gets this package's own — so `fallback`
 * renders only when the pty module or `@xterm/headless` is missing too.
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

  // --- which half of the component is running ------------------------------
  //
  // `'vt'` asks for it outright; `'auto'` arrives here only after the PATH
  // probe found no emulator, which is what makes vt the floor rather than a
  // parallel option. Both halves' hooks run unconditionally — the one that is
  // not in use is simply disabled — because that is what hooks require and
  // because a `<Terminal>` that flips backends must not remount the other one.
  const [vtFallback, setVtFallback] = useState(false);
  const vt = backend === 'vt' || (backend === 'auto' && vtFallback);
  useEffect(() => {
    if (backend !== 'auto') setVtFallback(false);
  }, [backend]);

  const client = useEmbeddedClient({
    plan,
    host: processes,
    enabled: enabled && !vt,
    stopSignal,
    onExit: props.onExit,
    onError: props.onError,
  });

  useEffect(() => {
    if (backend === 'auto' && client.status === 'unavailable') {
      setVtFallback(true);
    }
  }, [backend, client.status]);

  // Not `vt`, because `'auto'` may still land there: what is worth a warning
  // is a backend that was *named* and cannot honour the prop.
  useEffect(() => {
    if (backend !== 'auto' && backend !== 'vt') warnVtOnly(props);
    // Once per backend change, not once per render — the props object is a
    // new identity every time and this is a diagnostic, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  const title = useForeignTitle(props.onTitleChange);

  // The vt module is loaded on demand and never at import time: this is the
  // whole tree-shaking bargain — `@xterm/headless` and the renderer are a
  // separate chunk that an XEmbed app never fetches.
  const [vtModule, setVtModule] = useState<VtModule | null>(null);
  const [vtStatus, setVtStatus] = useState<EmbedStatus>('idle');
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;

  useEffect(() => {
    if (!vt || vtModule) return undefined;
    let live = true;
    void import('./vt/index.js')
      .then((mod) => {
        if (live) setVtModule(mod);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setVtStatus('unavailable');
        onErrorRef.current?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    return () => {
      live = false;
    };
  }, [vt, vtModule]);

  const vtHandle = useRef<VtHandle | null>(null);
  const onVtStatus = useCallback((next: EmbedStatus) => setVtStatus(next), []);

  React.useImperativeHandle(
    props.ref,
    () => ({
      restart: () => (vt ? vtHandle.current?.restart() : client.restart()),
      signal: (signal?: string) =>
        vt
          ? (vtHandle.current?.signal(signal) ?? false)
          : client.signal(signal),
      write: (data: string) => vtHandle.current?.write(data) ?? false,
      resizeToFit: () => vtHandle.current?.resizeToFit(),
      selection: () => vtHandle.current?.selection() ?? null,
      clearSelection: () => vtHandle.current?.clearSelection(),
      scrollToBottom: () => vtHandle.current?.scrollToBottom(),
      scrollLines: (n: number) => vtHandle.current?.scrollLines(n),
      serialize: () => vtHandle.current?.serialize() ?? null,
      get pid() {
        return vt ? (vtHandle.current?.pid ?? null) : client.pid;
      },
      get windowId() {
        // The vt backend draws into this window; there is no child to name.
        return vt ? null : client.windowId;
      },
      get backend() {
        return vt ? 'vt' : client.backend;
      },
      get status() {
        return vt ? vtStatus : client.status;
      },
      get cols() {
        return vtHandle.current?.cols ?? null;
      },
      get rows() {
        return vtHandle.current?.rows ?? null;
      },
    }),
    [client, vt, vtStatus],
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

  if (vt) {
    // Nothing installed *at all* — no emulator, and no pty module or no
    // `@xterm/headless` either — is still an ordinary state of a healthy
    // machine, and still a status plus a fallback rather than a throw.
    if (vtStatus === 'unavailable' && props.fallback !== undefined) {
      return h(React.Fragment, null, props.fallback);
    }
    if (!vtModule) {
      // The dynamic import is in flight. An empty box in the terminal's own
      // background holds the layout, so the pane does not jump when it lands.
      return hx('box', { style: styles });
    }
    const vtProps: VtTerminalProps = {
      command: props.command,
      cwd: props.cwd,
      env: props.env,
      colors,
      fontFamily: props.fontFamily,
      fontSize: props.fontSize,
      scrollback: props.scrollback,
      cursorStyle: props.cursorStyle,
      cursorBlink: props.cursorBlink,
      bell: props.bell,
      onBell: props.onBell,
      allowClipboardWrite: props.allowClipboardWrite,
      onSelectionChange: props.onSelectionChange,
      pty: props.pty,
      enabled,
      stopSignal,
      focusable: focusable ?? true,
      onExit: props.onExit,
      onTitleChange: props.onTitleChange,
      onError: props.onError,
      onStatus: onVtStatus,
      style: styles,
      ref: vtHandle,
      'data-testname': props['data-testname'],
    };
    return h(vtModule.VtTerminal, vtProps);
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
