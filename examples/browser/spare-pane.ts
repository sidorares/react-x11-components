// A spare pane: the next tab's process, started before anyone asks for it.
//
// Most of what a new tab waits for is its process loading code — core, the
// `<Html>` engine and `page.tsx`, compiled and linked, some 0.7 to 1.2 s on
// a Mac before the pane draws anything, and 0.4 to 0.6 s more for the
// scripts runtime where the first page runs them. None of it depends on
// which tab the process is for. So the browser keeps one pane process
// started and loaded (`pane-preload.ts`), waiting for the hello every pane
// waits for, and the next `<Frame>` that asks for a process with the same
// flags and environment is handed it. Its hello imports `page.tsx` from the
// module cache, and what is left is the window and the first frame.
//
// This is a `<Frame transport>`: the seam core gives a host for exactly
// this, which forks `react-x11/frame/child` as its own default does. A
// request that does not match the spare — a test's transport, another
// display, other flags — forks as the default would. A tab's process can be
// any tab's only because nothing in its environment names the tab: the
// tab's key is a prop (`PageProps.tabKey`).
//
// What it costs is one idle process, and `BROWSER_SPARE_PANE=0` turns it
// off. It is started a little after the browser has drawn its first tab,
// and again a little after one is taken, so it is never made while a tab
// waits on the same cores.
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { FrameComponentProps } from 'react-x11';

type Factory = NonNullable<FrameComponentProps['transport']>;
type Request = Parameters<Factory>[0];
type Transport = ReturnType<Factory>;

/** What a pane is started with, as `<Frame>` asks for one. */
interface Launch {
  display: string | undefined;
  execArgv: string[];
  env: Record<string, string | undefined>;
}

const CHILD = fileURLToPath(import.meta.resolve('react-x11/frame/child'));
const PRELOAD = fileURLToPath(new URL('./pane-preload.ts', import.meta.url));

/** How long after the browser starts, or a spare is taken, the next one is
 *  started: past the first frame of the tab that took it. */
const SPARE_AFTER_MS = 1500;

/** A launch as a string, to tell whether a request is the spare's. */
function launchKey({ display, execArgv, env }: Launch): string {
  const names = Object.keys(env).sort();
  return JSON.stringify([
    display ?? null,
    execArgv,
    names.map((n) => [n, env[n] ?? null]),
  ]);
}

/** The environment a pane starts with, as core's `paneEnv` makes it. */
function paneEnv(
  env: Record<string, string | undefined>,
  display: string | undefined,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete out[name];
    else out[name] = value;
  }
  Object.assign(out, extra);
  out.REACT_X11_FRAME = '1';
  if (display) out.DISPLAY = display;
  return out;
}

function forkPane(
  launch: Launch,
  preload: { scripts: boolean } | null,
): ChildProcess {
  return fork(CHILD, [], {
    serialization: 'advanced',
    // as core's own fork: the dev loader (tsx) follows into the pane, the
    // test runner's flags do not, and the pane's own go last
    execArgv: [
      ...process.execArgv.filter(
        (a) => a !== '--test' && !a.startsWith('--test-'),
      ),
      ...launch.execArgv,
      ...(preload ? [`--import=${PRELOAD}`] : []),
    ],
    env: paneEnv(
      launch.env,
      launch.display,
      preload?.scripts ? { BROWSER_PRELOAD_SCRIPTS: '1' } : {},
    ),
  });
}

/** A `FrameTransport` over a forked pane, as core's `forkTransport`. */
function transportOf(child: ChildProcess): Transport {
  return {
    send: (msg) => {
      if (!child.connected) throw new Error('the pane process is gone');
      child.send(msg as never);
    },
    onMessage: (cb) => {
      child.on('message', cb);
      return () => child.off('message', cb);
    },
    onExit: (cb) => {
      // a spare that ended before it was taken is handed out as gone
      if (child.exitCode !== null || child.signalCode !== null) {
        queueMicrotask(() =>
          cb({ code: child.exitCode, signal: child.signalCode }),
        );
        return () => {};
      }
      const onExit = (code: number | null, signal: string | null) =>
        cb({ code, signal });
      const onError = (error: Error) =>
        cb({ code: null, signal: null, error } as never);
      child.on('exit', onExit);
      child.on('error', onError);
      return () => {
        child.off('exit', onExit);
        child.off('error', onError);
      };
    },
    kill: (signal) => {
      try {
        child.kill(signal as NodeJS.Signals);
      } catch {
        // already gone, which is what the signal was for
      }
    },
    pid: child.pid,
  };
}

export interface SparePanes {
  /** The `<Frame transport>`: the spare where it matches, else a fork. */
  transport: Factory;
  /** Whether the next spare preloads the scripts runtime too: where the
   *  browser runs pages' scripts by default, the first page a new tab
   *  shows likely runs them. */
  setScripts(on: boolean): void;
  /** Ends the spare, as the browser goes. */
  dispose(): void;
}

/**
 * Spare panes for `<Frame>`s started with these flags and this environment,
 * which every tab's are. The first spare is started `SPARE_AFTER_MS` after
 * this is made.
 */
export function sparePanes(launch: Omit<Launch, 'display'>): SparePanes {
  const want = launchKey({ ...launch, display: undefined });
  let spare: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scripts = false;
  let disposed = false;

  const usable = (child: ChildProcess | null): child is ChildProcess =>
    !!child &&
    child.connected &&
    child.exitCode === null &&
    child.signalCode === null;

  const start = () => {
    timer = null;
    if (disposed || usable(spare)) return;
    let child: ChildProcess;
    try {
      child = forkPane({ ...launch, display: undefined }, { scripts });
    } catch {
      return;
    }
    // a spare nobody took is no reason to keep the browser running
    child.unref();
    (child.channel as { unref?: () => void } | undefined)?.unref?.();
    child.once('exit', () => {
      if (spare === child) spare = null;
    });
    child.on('error', () => {});
    spare = child;
  };
  const later = () => {
    if (disposed || timer) return;
    timer = setTimeout(start, SPARE_AFTER_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  later();

  const transport: Factory = (request: Request) => {
    const asked: Launch = {
      display: request.display ?? undefined,
      execArgv: [...(request.execArgv ?? [])],
      env: { ...(request.env ?? {}) },
    };
    let child: ChildProcess;
    if (launchKey(asked) === want && usable(spare)) {
      child = spare;
      spare = null;
      // taken: it is a tab's process now, which the browser waits for
      child.ref();
      (child.channel as { ref?: () => void } | undefined)?.ref?.();
    } else {
      child = forkPane(asked, null);
    }
    later();
    return transportOf(child);
  };

  return {
    transport,
    setScripts(on) {
      scripts = on;
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      spare?.kill('SIGTERM');
      spare = null;
    },
  };
}
