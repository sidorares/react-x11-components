// The lifecycle both XEmbed wrappers have, with none of the vocabulary
// either of them has.
//
// `<Terminal>` and `<MediaPlayer>` are the same component twice: render a
// `<foreign>` with no `windowId` so it *adopts* whatever turns up inside it,
// take the container id `onReady` hands over, spawn a program that draws into
// that id, and hand the program back when the tree changes. Only the argv and
// the control channel differ, and those are what the two `backends.ts` files
// are for.
//
// Everything here is ordinary React state. The X part is one prop —
// `onReady` — because core's `<foreign>` already owns the protocol
// (react-x11#269, ntk#246): the reparent, the save set, `_XEMBED_INFO`, the
// synthetic ConfigureNotify, and handing the client back on unmount without
// ever destroying it. The one thing asked of the connection directly is
// whether it has that protocol at all (`canHostXEmbed`), because on a backend
// that does not, `onReady` is no evidence either way: the Cocoa backend's
// `<foreign>` still calls it, with `windowId: undefined`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from 'react-x11';

import { nodeProcessHost } from './host.js';
import type { ExitInfo, ProcessHost, SpawnedProcess } from './host.js';

/**
 * Where the child is in its life.
 *
 * `'unavailable'` is not an error state to report as a failure: a machine
 * with no terminal emulator installed, or no mpv, is an ordinary machine.
 * Both components render their `fallback` on it, the way
 * `useDesktopCalendarEvents` reports "no bus, no ical.js" rather than
 * throwing. So is an app on a react-x11 backend that cannot embed another
 * program's window at all — the native macOS one — and `error` says which of
 * the two it is: a `BackendUnavailableError` or an `EmbedUnsupportedError`.
 */
export type EmbedStatus =
  'idle' | 'starting' | 'running' | 'exited' | 'unavailable';

/**
 * No backend for this component is installed.
 *
 * Thrown by a `PlanFactory`, caught by the hook, and turned into
 * `status: 'unavailable'`. `tried` is what was looked for, so the message an
 * app shows can name the install line rather than saying "not found".
 */
export class BackendUnavailableError extends Error {
  readonly tried: readonly string[];

  constructor(what: string, tried: readonly string[]) {
    super(
      `@react-x11/components: no ${what} backend is installed — looked for ` +
        `${tried.join(', ')}. Install one, or pass \`fallback\` to render ` +
        'something else.',
    );
    this.name = 'BackendUnavailableError';
    this.tried = tried;
  }
}

/**
 * This app cannot host another program's window at all.
 *
 * Embedding is XEmbed, and XEmbed is X protocol — a reparent into a
 * container, the save set, ClientMessages — which only react-x11's X11
 * backend has. The native macOS backend has no cross-process window
 * embedding (react-x11 `docs/macos.md`, "What this is, and is not"), so there
 * is no window to hand a program and nothing to spawn.
 *
 * `useEmbeddedClient` reports it as `status: 'unavailable'`, the status a
 * `BackendUnavailableError` gets, and for the same reason: it is an ordinary
 * state of a healthy app, and the component renders its `fallback`. The class
 * is what tells the two apart, because "install xterm" is the wrong advice
 * here.
 */
export class EmbedUnsupportedError extends Error {
  constructor() {
    super(
      '@react-x11/components: this react-x11 backend cannot embed another ' +
        "program's window — XEmbed needs the X11 backend, and the native " +
        'macOS one has no cross-process window embedding at all. Pass ' +
        '`fallback` to render something else.',
    );
    this.name = 'EmbedUnsupportedError';
  }
}

/** The slice of the app `canHostXEmbed` reads. `useApp()` is the escape
 *  hatch, so the shape is written out rather than imported — the call
 *  `../tray-host/manager.ts` makes for the slice it needs. */
interface XEmbedHostApp {
  X?: { SetSelectionOwner?: unknown; ReparentWindow?: unknown } | null;
}

/**
 * Can this app host another program's window?
 *
 * Asked of the connection, because `<foreign>` cannot be the one to say: on
 * react-x11's Cocoa backend it still calls `onReady`, with an undefined
 * `windowId`, and on the headless mock mounting one throws from the commit.
 * The test is `<TrayHost>`'s — its
 * manager reports `'unavailable'` when `app.X` has no `SetSelectionOwner`,
 * which is what core's Cocoa `X` lacks (react-x11 `src/cocoa/app.js`: a stub
 * carrying only the few requests core makes there) and what the headless
 * mock's `X` lacks too. `ReparentWindow` is asked as well, because it is the
 * request an embed is actually made of.
 *
 * Takes the app rather than calling `useApp()`, so it can be asked off the
 * render path — of `createRoot()`'s result, before there is a tree.
 */
export function canHostXEmbed(app: unknown): boolean {
  const X = (app as XEmbedHostApp | null | undefined)?.X;
  return (
    !!X &&
    typeof X.SetSelectionOwner === 'function' &&
    typeof X.ReparentWindow === 'function'
  );
}

/** What to run, and what to do with it once it is running. */
export interface LaunchPlan {
  /** Absolute path or a name on `PATH`. */
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Which backend this plan chose, for `onBackend` and the handle. */
  backend?: string;
  /**
   * Attach a control channel now that the process exists. Its return value is
   * called at teardown, before the process is signalled.
   */
  attach?(
    process: SpawnedProcess,
  ): void | (() => void) | Promise<void | (() => void)>;
  /** Always run at teardown — temporary directories, sockets. */
  dispose?(): void | Promise<void>;
}

export interface PlanContext {
  /** The `<foreign>` container the program must draw into. */
  windowId: number;
  host: ProcessHost;
}

/** Builds the command line, once the window to draw into exists. */
export type PlanFactory = (context: PlanContext) => Promise<LaunchPlan>;

export interface UseEmbeddedClientOptions {
  /**
   * **Must be referentially stable for as long as the child should keep
   * running.** A new identity is the restart signal — that is how "the
   * command changed" reaches a program that cannot be reconfigured in place —
   * so a factory rebuilt every render restarts the child every render.
   *
   * Both components build theirs with `useMemo` over a *string* key rather
   * than over the props themselves, because `command={['bash']}` is a new
   * array on every paint and an effect keyed on that never settles. Same
   * reason `useDesktopCalendarEvents` keys on `from.getTime()`.
   */
  plan: PlanFactory;
  /** Defaults to `nodeProcessHost()`. */
  host?: ProcessHost;
  /** False holds off entirely — a pane that is not visible yet. */
  enabled?: boolean;
  /** Sent on unmount and on restart. Default `SIGTERM`. */
  stopSignal?: string;
  onStart?: (info: { process: SpawnedProcess; backend?: string }) => void;
  onExit?: (info: ExitInfo) => void;
  /** Spawn failures, missing backends, and an app that cannot host an
   *  embedded window at all (`EmbedUnsupportedError`). */
  onError?: (err: Error) => void;
}

export interface EmbeddedClient {
  status: EmbedStatus;
  /** The last failure, including a `BackendUnavailableError` or an
   *  `EmbedUnsupportedError`. */
  error: Error | null;
  pid: number | null;
  /** The container window, once `<foreign>` has one. */
  windowId: number | null;
  /** Which backend the plan picked. */
  backend: string | null;
  /** Wire straight to `<foreign onReady>`. */
  handleReady: (info: { windowId: number }) => void;
  /** Stop the child and start it again with a freshly built plan. */
  restart: () => void;
  /** Signal the child. `false` if there is not one. */
  signal: (signal?: string) => boolean;
}

/**
 * Run a program inside a `<foreign>`.
 *
 * ```jsx
 * const client = useEmbeddedClient({ plan });
 * return <foreign onReady={client.handleReady} style={{ flexGrow: 1 }} />;
 * ```
 *
 * The `<foreign>` is rendered by the caller rather than here, because the
 * element's props — style, focus, the `onEmbedded`/`onClientGone` handlers a
 * component may want to compose with — belong to the component, not to the
 * lifecycle.
 *
 * **On an app that cannot host XEmbed** (`canHostXEmbed` is false — the
 * native macOS backend), `status` is `'unavailable'` from the first render,
 * `error` is an `EmbedUnsupportedError`, and nothing is probed or spawned.
 * The caller should render no `<foreign>` there either: it has no socket to
 * be.
 */
export function useEmbeddedClient(
  options: UseEmbeddedClientOptions,
): EmbeddedClient {
  const { plan, enabled = true, stopSignal = 'SIGTERM' } = options;
  const host = useMemo(() => options.host ?? nodeProcessHost(), [options.host]);
  // Asked every render: two property reads, and an app does not change
  // backend under a mounted tree.
  const embeddable = canHostXEmbed(useApp());

  const [windowId, setWindowId] = useState<number | null>(null);
  const [status, setStatus] = useState<EmbedStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [pid, setPid] = useState<number | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  // The live child, for `signal()`. A ref rather than state because a caller
  // reaching for it through a handle is not rendering, and re-rendering the
  // tree because a pid arrived would be work for nothing.
  const processRef = useRef<SpawnedProcess | null>(null);

  // Handlers are read at the moment they fire, so a component that passes a
  // fresh arrow function every render does not restart its child.
  const handlers = useRef(options);
  handlers.current = options;

  // No XEmbed on this connection means no window for a program to draw into,
  // whatever `<foreign>` reports: the Cocoa backend's calls `onReady` with an
  // undefined `windowId`, which slipped past a `windowId === null` guard and
  // spawned `xterm -into undefined`. So the app decides, and the lifecycle
  // below starts nothing without it. Decided while rendering rather than in
  // an effect, so the first commit can already be the `fallback`, and
  // reported from an effect keyed on the error itself, so `onError` hears it
  // once rather than once per plan. `enabled` false still means "hold off": a
  // pane nobody can see yet reports nothing.
  const unsupported = enabled && !embeddable;
  const unsupportedError = useMemo(
    () => (unsupported ? new EmbedUnsupportedError() : null),
    [unsupported],
  );
  useEffect(() => {
    if (unsupportedError) handlers.current.onError?.(unsupportedError);
  }, [unsupportedError]);

  const handleReady = useCallback((info: { windowId: number }) => {
    setWindowId(info.windowId);
  }, []);

  const restart = useCallback(() => setGeneration((n) => n + 1), []);

  const signal = useCallback((sig = 'SIGTERM') => {
    const child = processRef.current;
    return child ? child.kill(sig) : false;
  }, []);

  useEffect(() => {
    if (!enabled || !embeddable || windowId === null) {
      setStatus('idle');
      return undefined;
    }

    let live = true;
    let child: SpawnedProcess | null = null;
    let detach: (() => void) | void;
    let planned: LaunchPlan | null = null;

    const fail = (err: unknown, next: EmbedStatus): void => {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (!live) return;
      setError(wrapped);
      setStatus(next);
      handlers.current.onError?.(wrapped);
    };

    void (async () => {
      setStatus('starting');
      setError(null);
      try {
        planned = await plan({ windowId, host });
      } catch (err) {
        // "no xterm on this machine" is not the same kind of news as "spawn
        // failed", and only one of the two is worth a fallback.
        fail(
          err,
          err instanceof BackendUnavailableError ? 'unavailable' : 'exited',
        );
        return;
      }
      if (!live) {
        await planned.dispose?.();
        return;
      }

      try {
        child = await host.spawn(planned.command, planned.args, {
          cwd: planned.cwd,
          env: planned.env,
        });
      } catch (err) {
        await planned.dispose?.();
        fail(err, 'exited');
        return;
      }

      // Unmounted while `spawn` was in flight: nothing rendered it, so
      // nothing should outlive it.
      if (!live) {
        child.kill(stopSignal);
        await planned.dispose?.();
        return;
      }

      processRef.current = child;
      setPid(child.pid);
      setBackend(planned.backend ?? null);
      setStatus('running');

      child.onExit((info) => {
        if (!live) return;
        processRef.current = null;
        setStatus('exited');
        setPid(null);
        handlers.current.onExit?.(info);
      });
      child.onError((err) => fail(err, 'exited'));

      handlers.current.onStart?.({ process: child, backend: planned.backend });

      try {
        const opened = await planned.attach?.(child);
        // Opening a control channel can take seconds — the socket does not
        // exist until the player creates it — so the teardown below may
        // already have run with nothing to tear down. Closing it here is the
        // only chance there will be.
        if (live) detach = opened;
        else opened?.();
      } catch (err) {
        // A control channel that would not open is a degraded player, not a
        // dead one: the video is already on screen.
        fail(err, 'running');
      }
    })();

    return () => {
      live = false;
      processRef.current = null;
      // Order matters: drop the control channel first, so a socket close
      // triggered by the signal is not reported as the player failing.
      try {
        detach?.();
      } catch {
        // a channel that is already gone
      }
      child?.kill(stopSignal);
      void planned?.dispose?.();
    };
    // `plan` is the restart signal — see the note on the option.
  }, [enabled, embeddable, windowId, plan, host, stopSignal, generation]);

  return {
    status: unsupported ? 'unavailable' : status,
    error: unsupportedError ?? error,
    pid,
    windowId,
    backend,
    handleReady,
    restart,
    signal,
  };
}

/**
 * The first of `candidates` that is installed, or a `BackendUnavailableError`
 * naming all of them.
 *
 * Auto-detection rather than a hard dependency is the whole reason both
 * components take a `backend` prop that defaults to `'auto'`: this package
 * cannot depend on a binary, and most machines have exactly one of the ones
 * it can drive.
 */
export async function resolveBackend<T extends { binaries: readonly string[] }>(
  host: ProcessHost,
  what: string,
  candidates: readonly T[],
): Promise<{ backend: T; path: string }> {
  const tried: string[] = [];
  for (const backend of candidates) {
    for (const binary of backend.binaries) {
      tried.push(binary);
      const path = await host.which(binary);
      if (path) return { backend, path };
    }
  }
  throw new BackendUnavailableError(what, tried);
}
