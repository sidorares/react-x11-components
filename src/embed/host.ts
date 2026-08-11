// The operating system, as an interface — because `<Terminal>` and
// `<MediaPlayer>` are the first things in this package that run somebody
// else's program.
//
// Two reasons this is an interface and not five `import`s:
//
//  1. **`src/` may not name node's types.** `tsconfig.build.json` sets
//     `types: []` on purpose, so a `process` or a `Buffer` in a shipped module
//     fails the build rather than becoming an `@types/node` dependency a
//     consumer has to satisfy. The slice of `child_process`, `fs`, `net` and
//     `os` used here is therefore written out structurally and reached
//     through a dynamic `import()` with a specifier built at run time —
//     exactly what `../desktop-calendar/ical.ts` does for `ical.js`, and what
//     react-x11 does for `dbus-native`.
//  2. **It is the seam the components are tested through.** A fake host
//     records argv and hands back a process that never existed, which is the
//     only way to assert "xterm would have been spawned with `-into 42`"
//     without an xterm. It is public rather than private because the same
//     seam is what an app needs to run the child somewhere else — inside a
//     container, over ssh, under a sandbox — and none of that should require
//     forking the component.

import { delay } from './timers.js';

/** How a spawned child ended. */
export interface ExitInfo {
  /** Exit status, or `null` when a signal ended it. */
  code: number | null;
  /** The signal that ended it, or `null`. */
  signal: string | null;
}

/**
 * A running child, reduced to what an embedded client needs: its pid, a way
 * to signal it, and the two things that can happen to it.
 *
 * Deliberately not node's `ChildProcess`. Listener registration is a method
 * per event rather than an `EventEmitter`, so a fake is a dozen lines and
 * cannot accidentally rely on emitter behaviour (`once`, `removeAllListeners`,
 * the `error`-with-no-listener throw) that the real one has and a fake would
 * have to reimplement.
 */
export interface SpawnedProcess {
  readonly pid: number | null;
  /** POSIX signal name. Returns whether it was delivered. */
  kill(signal?: string): boolean;
  onExit(listener: (info: ExitInfo) => void): void;
  onError(listener: (err: Error) => void): void;
}

export interface SpawnOptions {
  cwd?: string;
  /**
   * Added to the ambient environment rather than replacing it: a terminal
   * with no `PATH` and no `HOME` is not a terminal. An explicit `undefined`
   * removes a variable.
   */
  env?: Record<string, string | undefined>;
}

/**
 * A line-oriented control channel to a player process — mpv's JSON IPC, VLC's
 * rc interface. Text in, text out, and no framing: the protocols disagree
 * about what a message is, so splitting is the caller's.
 */
export interface IpcSocket {
  write(data: string): void;
  onData(listener: (chunk: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/** A private directory to put a control socket in, and how to remove it. */
export interface ScratchSocket {
  path: string;
  dispose(): Promise<void>;
}

/**
 * Everything the embedded-client components do outside their own process.
 *
 * Every method is async, including the ones whose node counterparts are not:
 * the node modules behind them are loaded lazily (see the file comment), so
 * the first call is a dynamic `import()` however synchronous `spawn` itself
 * is. Nothing here runs during render, so the cost is invisible.
 */
export interface ProcessHost {
  /**
   * The absolute path `command` resolves to on `PATH`, or `null` when it is
   * not installed. A command containing a slash is tested as-is.
   */
  which(command: string): Promise<string | null>;
  spawn(
    command: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): Promise<SpawnedProcess>;
  /** A path in a fresh private directory, for a child to create a socket at. */
  socketPath(prefix: string): Promise<ScratchSocket>;
  /** Connect to a unix socket a child created. Rejects if it is not there. */
  connect(path: string): Promise<IpcSocket>;
  /** The ambient environment, for defaults and for `PATH`. */
  environment(): Record<string, string | undefined>;
}

// --- the node implementation -----------------------------------------------

/**
 * The node modules this file uses, structurally.
 *
 * Only the members actually called are described. Anything wider would be
 * `@types/node` written out by hand, which is both a maintenance burden and a
 * lie the moment node changes.
 */
interface ChildProcessModule {
  spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdio?: string;
      detached?: boolean;
    },
  ): NodeChildProcess;
}

interface NodeChildProcess {
  pid?: number;
  killed: boolean;
  kill(signal?: string): boolean;
  on(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void,
  ): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

interface FsPromisesModule {
  access(path: string, mode: number): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
}

interface NodeSocket {
  setEncoding(encoding: string): void;
  write(data: string): void;
  end(): void;
  destroy(): void;
  on(event: string, listener: (arg?: unknown) => void): void;
  once(event: string, listener: (arg?: unknown) => void): void;
  removeListener(event: string, listener: (arg?: unknown) => void): void;
}

interface NetModule {
  createConnection(options: { path: string }): NodeSocket;
}

interface OsModule {
  tmpdir(): string;
}

interface PathModule {
  join(...parts: string[]): string;
  isAbsolute(path: string): boolean;
}

/**
 * Load a node builtin without naming it to the compiler.
 *
 * The specifier is a variable on purpose: a literal `import('node:net')`
 * would need `@types/node` in the build program, which is the thing
 * `tsconfig.build.json` refuses. It also keeps a bundler from trying to
 * resolve a node builtin for a target that has none.
 */
const builtins = new Map<string, Promise<unknown>>();
function builtin<T>(name: string): Promise<T> {
  let mod = builtins.get(name);
  if (!mod) {
    const specifier = name;
    mod = import(/* @vite-ignore */ specifier);
    builtins.set(name, mod);
  }
  return mod as Promise<T>;
}

/** `process`, if there is one. `globalThis` because `process` is not typed. */
function nodeProcess(): {
  env?: Record<string, string | undefined>;
  platform?: string;
} | null {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined>; platform?: string };
  };
  return g.process ?? null;
}

/** Executable-by-anyone, `fs.constants.X_OK`. Spelled out rather than read
 *  off the module, which would be a second await for a constant that is 1 on
 *  every platform this package can run on. */
const X_OK = 1;

/** Thrown when a control socket does not appear. */
export class IpcConnectError extends Error {
  constructor(path: string, cause?: unknown) {
    super(`@react-x11/components: could not connect to ${path}`, { cause });
    this.name = 'IpcConnectError';
  }
}

class NodeSpawnedProcess implements SpawnedProcess {
  #child: NodeChildProcess;

  constructor(child: NodeChildProcess) {
    this.#child = child;
  }

  get pid(): number | null {
    return this.#child.pid ?? null;
  }

  kill(signal = 'SIGTERM'): boolean {
    if (this.#child.killed) return false;
    try {
      return this.#child.kill(signal);
    } catch {
      // already reaped, or a pid we no longer own
      return false;
    }
  }

  onExit(listener: (info: ExitInfo) => void): void {
    this.#child.on('exit', (code, signal) => listener({ code, signal }));
  }

  onError(listener: (err: Error) => void): void {
    this.#child.on('error', listener);
  }
}

class NodeIpcSocket implements IpcSocket {
  #socket: NodeSocket;
  #closed = false;

  constructor(socket: NodeSocket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
  }

  write(data: string): void {
    if (this.#closed) return;
    try {
      this.#socket.write(data);
    } catch {
      // the player exited between the last event and this command
    }
  }

  onData(listener: (chunk: string) => void): void {
    this.#socket.on('data', (chunk) => listener(String(chunk)));
  }

  onClose(listener: () => void): void {
    const fire = (): void => {
      if (this.#closed) return;
      this.#closed = true;
      listener();
    };
    this.#socket.on('close', fire);
    // a socket that errors also closes, but not before something has
    // listened for `error` — an unhandled one on a node socket throws
    this.#socket.on('error', () => {});
  }

  close(): void {
    this.#closed = true;
    try {
      this.#socket.end();
      this.#socket.destroy();
    } catch {
      // already gone
    }
  }
}

let sharedHost: ProcessHost | null = null;

/**
 * The real one: node's `child_process`, `fs`, `net` and `os`.
 *
 * Cached, because it holds nothing per-caller and the module loads it does are
 * worth doing once. An app that wants a *different* host (a container, a
 * remote shell) passes it as the `processes` prop instead of replacing this.
 */
export function nodeProcessHost(): ProcessHost {
  if (sharedHost) return sharedHost;

  const host: ProcessHost = {
    environment() {
      return nodeProcess()?.env ?? {};
    },

    async which(command) {
      if (!command) return null;
      const path = await builtin<PathModule>('node:path');
      const fs = await builtin<FsPromisesModule>('node:fs/promises');
      const runnable = async (candidate: string): Promise<boolean> => {
        try {
          await fs.access(candidate, X_OK);
          return true;
        } catch {
          return false;
        }
      };

      // A path, not a name: PATH is not consulted, exactly as a shell would
      // not consult it.
      if (command.includes('/')) {
        return (await runnable(command)) ? command : null;
      }

      const search = host.environment().PATH ?? '';
      for (const dir of search.split(':')) {
        if (!dir) continue;
        const candidate = path.join(dir, command);
        if (await runnable(candidate)) return candidate;
      }
      return null;
    },

    async spawn(command, args, options = {}) {
      const cp = await builtin<ChildProcessModule>('node:child_process');
      const env = options.env
        ? { ...host.environment(), ...options.env }
        : undefined;
      const child = cp.spawn(command, args, {
        cwd: options.cwd,
        env,
        // The child draws into an X window; its stdio is not ours to show,
        // and an inherited one would interleave with the app's own output.
        // A pipe nobody reads fills and blocks the child, which is worse.
        stdio: 'ignore',
      });
      return new NodeSpawnedProcess(child);
    },

    async socketPath(prefix) {
      const [os, path, fs] = await Promise.all([
        builtin<OsModule>('node:os'),
        builtin<PathModule>('node:path'),
        builtin<FsPromisesModule>('node:fs/promises'),
      ]);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
      return {
        // The directory is what is private, not the socket: a unix socket's
        // own mode is not honoured on every kernel, and a predictable path in
        // a shared /tmp is how another user gets a command channel to the
        // player.
        path: path.join(dir, 'sock'),
        async dispose() {
          try {
            await fs.rm(dir, { recursive: true, force: true });
          } catch {
            // /tmp is allowed to have been cleaned already
          }
        },
      };
    },

    async connect(socketPath) {
      const net = await builtin<NetModule>('node:net');
      return new Promise<IpcSocket>((resolve, reject) => {
        let socket: NodeSocket;
        try {
          socket = net.createConnection({ path: socketPath });
        } catch (err) {
          reject(new IpcConnectError(socketPath, err));
          return;
        }
        const onConnect = (): void => {
          socket.removeListener('error', onError);
          resolve(new NodeIpcSocket(socket));
        };
        const onError = (err?: unknown): void => {
          socket.removeListener('connect', onConnect);
          try {
            socket.destroy();
          } catch {
            // nothing to close
          }
          reject(new IpcConnectError(socketPath, err));
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
      });
    },
  };

  sharedHost = host;
  return host;
}

/**
 * Retry `connect` until the child has created its socket.
 *
 * Every player here is given a socket path and creates it *itself*, some
 * milliseconds after it starts — so the first connect always loses the race,
 * and "the socket is not there yet" and "the player failed to start" look
 * identical for that window. Polling with a deadline is what separates them.
 */
export async function connectWhenReady(
  host: ProcessHost,
  path: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<IpcSocket> {
  const { timeoutMs = 5000, intervalMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      return await host.connect(path);
    } catch (err) {
      last = err;
      if (Date.now() >= deadline) break;
      await delay(intervalMs);
    }
  }
  throw last instanceof Error ? last : new IpcConnectError(path, last);
}
