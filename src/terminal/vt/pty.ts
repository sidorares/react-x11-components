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
  /**
   * The grid changed. A local pty turns this into SIGWINCH; SSH sends a
   * `window-change` request. Note the argument order is the one every
   * terminal API uses and `ssh2.setWindow` does not — see the adapter in
   * `examples/terminal-ssh.tsx`.
   */
  resize(cols: number, rows: number): void;
  kill(signal?: string): boolean;
  /**
   * Output from the program.
   *
   * **Bytes are preferred over a string** for any transport that carries
   * them — a socket, an SSH channel, a WebSocket. A `Buffer.toString()` on
   * whatever chunk boundary the network chose splits multi-byte UTF-8 down
   * the middle and produces mojibake that no amount of care further down can
   * repair; handed a `Uint8Array`, this component passes it to the emulator
   * untouched, and the emulator's decoder is stateful across chunks. Node-pty
   * hands over strings and that is fine — it decodes with the same care.
   */
  onData(listener: (chunk: string | Uint8Array) => void): void;
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

// --- the Bun implementation ------------------------------------------------

/**
 * Bun's built-in pty, as of Bun 1.4: `Bun.spawn(argv, { terminal })` hands
 * back a `Terminal` on the subprocess.
 *
 * This exists for the reason the whole file exists in the first place — a pty
 * should not cost 64 MB and a native build. Under Bun it costs nothing: the
 * pty is the runtime's, so `node-pty` is not installed, not probed, and not
 * loaded, and the vt backend works out of the box on a machine with no C
 * toolchain. Same argument as `@xterm/headless` being lazy: an app should not
 * pay for what its runtime already provides.
 *
 * Written structurally, like `NodePty` above and for the same two reasons:
 * `src/` may not name another runtime's types, and `@types/bun` is not
 * installed here (nor in a Node app that merely imports this package).
 */
interface BunTerminalHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BunSubprocess {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly exited: Promise<number>;
  readonly terminal?: BunTerminalHandle | null;
  kill(signal?: string | number): void;
}

interface BunRuntime {
  /** The pty class. Present from 1.4 — this is the feature detector. */
  Terminal?: unknown;
  spawn(
    argv: readonly string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      terminal?: {
        cols?: number;
        rows?: number;
        data?(terminal: BunTerminalHandle, chunk: Uint8Array): void;
      };
    },
  ): BunSubprocess;
}

/**
 * The Bun runtime, if this is Bun *and* its Bun is new enough to have a pty.
 *
 * `Bun.Terminal` rather than a parse of `Bun.version`: the `terminal` option
 * is ignored rather than rejected by a Bun that predates it, so a version
 * comparison is the difference between falling through to node-pty and
 * spawning a child whose output goes nowhere.
 */
function bunRuntime(): BunRuntime | null {
  const bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!bun || typeof bun.spawn !== 'function') return null;
  return typeof bun.Terminal === 'function' ? bun : null;
}

class BunPtySession implements PtySession {
  #proc: BunSubprocess;
  #term: BunTerminalHandle;
  #alive = true;
  // Bun takes the output callback as a *spawn option*, so bytes can land
  // before `openPty` has even returned — let alone before the caller has
  // called `onData`. Anything that arrives in that window is held here and
  // flushed on attach; without it the shell's first prompt is a coin flip.
  #backlog: Uint8Array[] = [];
  #data: ((chunk: Uint8Array) => void) | null = null;
  // Same race, one step later: a program that exits immediately settles
  // `exited` before `onExit` is attached.
  #exit: ExitInfo | null = null;
  #onExit: ((info: ExitInfo) => void) | null = null;

  constructor(proc: BunSubprocess, term: BunTerminalHandle) {
    this.#proc = proc;
    this.#term = term;
    void proc.exited.then(() => {
      this.#alive = false;
      // Bun reports the signal by *name* (`'SIGTERM'`) and nulls `exitCode`
      // when one ended the child — which is `ExitInfo` exactly, so unlike the
      // node-pty path there is no number to stringify and no name table to
      // get wrong per platform.
      const info: ExitInfo = {
        code: proc.signalCode ? null : (proc.exitCode ?? 0),
        signal: proc.signalCode ?? null,
      };
      if (this.#onExit) this.#onExit(info);
      else this.#exit = info;
    });
  }

  /** Called from the spawn-time `data` callback. */
  receive(chunk: Uint8Array): void {
    if (this.#data) this.#data(chunk);
    else this.#backlog.push(chunk);
  }

  get pid(): number | null {
    return this.#alive ? this.#proc.pid : null;
  }

  write(data: string): void {
    if (!this.#alive) return;
    try {
      this.#term.write(data);
    } catch {
      // the child exited between the keystroke and this write
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.#alive || cols <= 0 || rows <= 0) return;
    try {
      this.#term.resize(cols, rows);
    } catch {
      // same race as write
    }
  }

  kill(signal = 'SIGTERM'): boolean {
    if (!this.#alive) return false;
    try {
      this.#proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#data = listener;
    // Bytes, not a string: Bun hands over a `Buffer`, and the emulator's
    // decoder is stateful across chunks. Decoding here would split a
    // multi-byte character on whatever boundary the pty read returned.
    const held = this.#backlog;
    this.#backlog = [];
    for (const chunk of held) listener(chunk);
  }

  onExit(listener: (info: ExitInfo) => void): void {
    this.#onExit = listener;
    if (this.#exit) {
      const info = this.#exit;
      this.#exit = null;
      listener(info);
    }
  }

  // No `pause`/`resume`: Bun's terminal has no flow control to expose, and
  // the interface makes them optional for exactly this case. The emulator's
  // own write queue still bounds parse work per tick; only the pipe's
  // buffered bytes grow.
}

let sharedBunHost: PtyHost | null = null;

/**
 * The runtime's own pty. Null-free: callers reach it through
 * `defaultPtyHost()`, and `available()` answers honestly under Node.
 */
export function bunPtyHost(): PtyHost {
  if (sharedBunHost) return sharedBunHost;

  const host: PtyHost = {
    environment() {
      return nodeProcess()?.env ?? {};
    },

    async available() {
      return bunRuntime() !== null;
    },

    async openPty(argv, options) {
      const bun = bunRuntime();
      if (!bun) throw new PtyUnavailableError();
      const ambient = host.environment?.() ?? {};
      const merged: Record<string, string> = {};
      for (const [key, value] of Object.entries({
        ...ambient,
        ...options.env,
      })) {
        // An explicit `undefined` removes a variable, as `SpawnOptions` says
        if (value !== undefined) merged[key] = String(value);
      }
      // Bun sets no `TERM` of its own — the pty is a device, not a profile —
      // so the honest advertisement is made here, as the node-pty path makes
      // it through node-pty's `name`.
      merged.TERM ??= 'xterm-256color';
      const file = argv[0] ?? defaultShell(ambient);
      let session: BunPtySession | null = null;
      const proc = bun.spawn([file, ...argv.slice(1)], {
        cwd: options.cwd,
        env: merged,
        terminal: {
          cols: options.cols,
          rows: options.rows,
          data(_terminal, chunk) {
            session?.receive(chunk);
          },
        },
      });
      const term = proc.terminal;
      if (!term) {
        // A Bun that has `Terminal` but did not give us one back: kill the
        // child rather than leak it, and report it as a load failure so the
        // caller renders `fallback` instead of an empty terminal.
        try {
          proc.kill();
        } catch {
          // already gone
        }
        throw new PtyUnavailableError(
          new Error('Bun.spawn returned no terminal for a pty request'),
        );
      }
      session = new BunPtySession(proc, term);
      return session;
    },
  };

  sharedBunHost = host;
  return host;
}

/**
 * The pty the current runtime should use: Bun's own where there is one,
 * `node-pty` otherwise.
 *
 * Bun wins on purpose even when node-pty is installed and would load (Bun's
 * N-API support is good enough that it does). The built-in needs no native
 * build, no ABI match and no 64 MB, and "use what the runtime provides" is
 * the same call this package makes everywhere else. An app that wants the
 * other one back passes `pty={nodePtyHost()}`, which is what the seam is for.
 */
export function defaultPtyHost(): PtyHost {
  return bunRuntime() ? bunPtyHost() : nodePtyHost();
}
