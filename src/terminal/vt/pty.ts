// The pty, as a seam — `ProcessHost` for a program that owns a terminal.
//
// Same argument as `../../embed/host.ts` makes about `child_process`, twice
// over:
//
//  1. **It is a feature, not a test double.** "run the shell in a container /
//     over ssh / under a sandbox" is a real thing to want, and it should not
//     need a fork. That it is also what `test/fake-pty.ts` drives — the only
//     way CI, with no native module built, can assert byte-in/screen-out — is
//     the second reason rather than the first.
//  2. **`src/` may not name node's types**, and a pty is a *native* module on
//     top of that. `node-pty` unpacks to 64 MB (more than react-x11's entire
//     install closure) and `@lydell/node-pty` is a beta; neither is something
//     this package may install for an app that renders a calendar. So both
//     are **optional peer dependencies**, probed in that order at run time,
//     and "neither is here" is `status: 'unavailable'` plus the `fallback` —
//     never a throw.
import type { ExitInfo } from '../../embed/index.js';

/** A live pty: the writable end of somebody's terminal. */
export interface PtySession {
  /** UTF-8 text towards the program. */
  write(data: string): void;
  /** SIGWINCH, with the new grid. */
  resize(cols: number, rows: number): void;
  kill(signal?: string): boolean;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (info: ExitInfo) => void): void;
  /**
   * Flow control. Optional because not every transport has it: without a
   * pause the emulator's own write queue still bounds parse work per tick,
   * and only the pipe's buffered bytes grow. node-pty has both.
   */
  pause?(): void;
  resume?(): void;
  readonly pid: number | null;
}

export interface PtyOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Where a pty comes from. The `processes` prop's counterpart for the vt
 * backend, and public for the same reason.
 */
export interface PtyHost {
  /** Whether `openPty` can be satisfied at all — a module probe, not a spawn. */
  available(): Promise<boolean>;
  openPty(argv: readonly string[], options: PtyOptions): Promise<PtySession>;
  /** The ambient environment, for `SHELL` and the `TERM` defaults. */
  environment?(): Record<string, string | undefined>;
}

// --- the node-pty implementation -------------------------------------------

/**
 * `node-pty`'s shape, structurally — the slice used here.
 *
 * Written out rather than imported for the reason above: neither provider is
 * installed in this repo (nor in most apps), so `import type … from
 * 'node-pty'` would make this package fail to type-check wherever it is not.
 */
interface NodePty {
  spawn(
    file: string,
    args: readonly string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      encoding?: string | null;
    },
  ): NodePtyProcess;
}

interface NodePtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (info: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
}

/**
 * The providers, in preference order. `node-pty` first because it is the one
 * an app is likely to already have; the fork second because it is 13.5 KB
 * plus one platform binary and installs where the other one's build does not.
 */
export const PTY_MODULES: readonly string[] = ['node-pty', '@lydell/node-pty'];

/**
 * Load whichever provider is installed.
 *
 * The specifier is a variable on purpose — the same shape
 * `../../embed/host.ts` uses for node builtins. A literal would put the
 * module in the *type* graph (it is not installed here, so the build would
 * fail) and would make a bundler try to resolve a native addon it can never
 * bundle.
 */
let probing: Promise<NodePty | null> | null = null;
let loadError: Error | null = null;

function loadNodePty(): Promise<NodePty | null> {
  probing ??= (async () => {
    for (const name of PTY_MODULES) {
      try {
        const specifier = name;
        const mod = (await import(/* @vite-ignore */ specifier)) as {
          spawn?: NodePty['spawn'];
          default?: { spawn?: NodePty['spawn'] };
        };
        const spawn = mod.spawn ?? mod.default?.spawn;
        if (typeof spawn === 'function') return { spawn } as NodePty;
      } catch (err) {
        // "Not installed" and "installed but it will not load" are very
        // different problems with the same symptom, and telling a user to
        // install what they already installed is the worst way to spend
        // their afternoon. A missing module is an ordinary state and stays
        // silent; anything else — a native build for the wrong Node ABI, a
        // broken postinstall — is kept and reported through `onError`.
        if (!isModuleNotFound(err)) {
          loadError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }
    return null;
  })();
  return probing;
}

function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/**
 * Why the probe came back empty, when the reason was not "nothing installed".
 *
 * Null both when a pty was found and when none of the modules is there at
 * all — the caller says "install one" for that case, and this for the other.
 */
export function ptyLoadError(): Error | null {
  return loadError;
}

/** The error a caller reports when no pty could be had. */
export class PtyUnavailableError extends Error {
  readonly tried: readonly string[];

  constructor(cause?: unknown) {
    const failed = cause ?? ptyLoadError();
    super(
      failed
        ? `@react-x11/components: a pty module is installed but would not ` +
            `load — ${failed instanceof Error ? failed.message : String(failed)}`
        : `@react-x11/components: no pty module is installed — looked for ` +
            `${PTY_MODULES.join(', ')}. Install one (\`npm i node-pty\`), or ` +
            'pass `fallback` to render something else.',
      { cause: failed ?? undefined },
    );
    this.name = 'PtyUnavailableError';
    this.tried = PTY_MODULES;
  }
}

/** `process`, if there is one — `globalThis` because `process` is not typed. */
function nodeProcess(): {
  env?: Record<string, string | undefined>;
  platform?: string;
} | null {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined>; platform?: string };
  };
  return g.process ?? null;
}

/** The user's login shell, or the last-resort `sh`. */
export function defaultShell(
  env: Record<string, string | undefined> = nodeProcess()?.env ?? {},
): string {
  return env.SHELL || '/bin/sh';
}

class NodePtySession implements PtySession {
  #pty: NodePtyProcess;
  #alive = true;

  constructor(pty: NodePtyProcess) {
    this.#pty = pty;
  }

  get pid(): number | null {
    return this.#alive ? this.#pty.pid : null;
  }

  write(data: string): void {
    if (!this.#alive) return;
    try {
      this.#pty.write(data);
    } catch {
      // the child exited between the keystroke and this write
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.#alive || cols <= 0 || rows <= 0) return;
    try {
      this.#pty.resize(cols, rows);
    } catch {
      // same race as write
    }
  }

  kill(signal = 'SIGTERM'): boolean {
    if (!this.#alive) return false;
    try {
      this.#pty.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  onData(listener: (chunk: string) => void): void {
    this.#pty.onData((chunk) => listener(chunk));
  }

  onExit(listener: (info: ExitInfo) => void): void {
    this.#pty.onExit(({ exitCode, signal }) => {
      this.#alive = false;
      // node-pty reports the signal as a *number*; `ExitInfo` is the embed
      // path's shape, where it is a name. Report the number as a string
      // rather than inventing a name table that would disagree per platform.
      listener({
        code: signal ? null : exitCode,
        signal: signal ? String(signal) : null,
      });
    });
  }

  pause(): void {
    try {
      this.#pty.pause();
    } catch {
      // a provider that does not implement it
    }
  }

  resume(): void {
    try {
      this.#pty.resume();
    } catch {
      // ditto
    }
  }
}

let sharedHost: PtyHost | null = null;

/**
 * The real one: whichever of the two providers is installed.
 *
 * Cached, because the probe is a module load and it holds nothing per-caller.
 * An app that wants a *different* pty — a container, a remote shell — passes
 * it as the `pty` prop instead of replacing this.
 */
export function nodePtyHost(): PtyHost {
  if (sharedHost) return sharedHost;

  const host: PtyHost = {
    environment() {
      return nodeProcess()?.env ?? {};
    },

    async available() {
      return (await loadNodePty()) !== null;
    },

    async openPty(argv, options) {
      const pty = await loadNodePty();
      if (!pty) throw new PtyUnavailableError();
      const ambient = host.environment?.() ?? {};
      const merged: Record<string, string> = {};
      for (const [key, value] of Object.entries({
        ...ambient,
        ...options.env,
      })) {
        // An explicit `undefined` removes a variable, as `SpawnOptions` says
        if (value !== undefined) merged[key] = String(value);
      }
      const file = argv[0] ?? defaultShell(ambient);
      const child = pty.spawn(file, argv.slice(1), {
        // What `TERM` says we are. The emulator core is xterm-compatible, so
        // this is the honest advertisement rather than a flattering one.
        name: merged.TERM ?? 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: merged,
      });
      return new NodePtySession(child);
    },
  };

  sharedHost = host;
  return host;
}
