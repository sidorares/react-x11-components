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
// ever destroying it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { nodeProcessHost } from './host.js';
import type { ExitInfo, ProcessHost, SpawnedProcess } from './host.js';

/**
 * Where the child is in its life.
 *
 * `'unavailable'` is not an error state to report as a failure: a machine
 * with no terminal emulator installed, or no mpv, is an ordinary machine.
 * Both components render their `fallback` on it, the way
 * `useDesktopCalendarEvents` reports "no bus, no ical.js" rather than
 * throwing.
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
  /** Spawn failures and missing backends alike. */
  onError?: (err: Error) => void;
}

export interface EmbeddedClient {
  status: EmbedStatus;
  /** The last failure, including a `BackendUnavailableError`. */
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
 */
export function useEmbeddedClient(
  options: UseEmbeddedClientOptions,
): EmbeddedClient {
  const { plan, enabled = true, stopSignal = 'SIGTERM' } = options;
  const host = useMemo(() => options.host ?? nodeProcessHost(), [options.host]);

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

  const handleReady = useCallback((info: { windowId: number }) => {
    setWindowId(info.windowId);
  }, []);

  const restart = useCallback(() => setGeneration((n) => n + 1), []);

  const signal = useCallback((sig = 'SIGTERM') => {
    const child = processRef.current;
    return child ? child.kill(sig) : false;
  }, []);

  useEffect(() => {
    if (!enabled || windowId === null) {
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
  }, [enabled, windowId, plan, host, stopSignal, generation]);

  return {
    status,
    error,
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
