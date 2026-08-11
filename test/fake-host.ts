// A `ProcessHost` that never starts anything.
//
// This is why `../src/embed/host.ts` is an interface: `<Terminal>` and
// `<MediaPlayer>` are entirely about spawning a program, and CI has neither an
// xterm nor an mpv — so the suite asserts *what would have been spawned*,
// which is the whole of what these components decide.
//
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it, but
// `tsconfig.json` does typecheck it.
import type {
  ExitInfo,
  IpcSocket,
  ProcessHost,
  ScratchSocket,
  SpawnOptions,
  SpawnedProcess,
} from '../src/embed/index.js';

export interface SpawnRecord {
  command: string;
  args: string[];
  options: SpawnOptions;
  process: FakeProcess;
}

export class FakeProcess implements SpawnedProcess {
  readonly pid: number;
  /** Every signal it was sent, in order. */
  readonly signals: string[] = [];
  #exit: ((info: ExitInfo) => void)[] = [];
  #error: ((err: Error) => void)[] = [];

  constructor(pid: number) {
    this.pid = pid;
  }

  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }

  onExit(listener: (info: ExitInfo) => void): void {
    this.#exit.push(listener);
  }

  onError(listener: (err: Error) => void): void {
    this.#error.push(listener);
  }

  /** Pretend the child ended, the way a real one would. */
  exit(info: ExitInfo = { code: 0, signal: null }): void {
    for (const listener of this.#exit) listener(info);
  }

  fail(err: Error): void {
    for (const listener of this.#error) listener(err);
  }
}

/** A control socket both ends of which are in this process. */
export class FakeSocket implements IpcSocket {
  /** Everything the component wrote, verbatim. */
  readonly written: string[] = [];
  closed = false;
  #data: ((chunk: string) => void)[] = [];
  #close: (() => void)[] = [];

  write(data: string): void {
    this.written.push(data);
  }

  onData(listener: (chunk: string) => void): void {
    this.#data.push(listener);
  }

  onClose(listener: () => void): void {
    this.#close.push(listener);
  }

  close(): void {
    this.closed = true;
    for (const listener of this.#close) listener();
  }

  /** Deliver bytes as if the player had sent them. */
  receive(chunk: string): void {
    for (const listener of this.#data) listener(chunk);
  }

  /** The written stream, as the newline-delimited messages it really is. */
  lines(): string[] {
    return this.written.join('').split('\n').filter(Boolean);
  }
}

export interface FakeHostOptions {
  /** Binaries that "exist". Everything else resolves to null. */
  installed?: readonly string[];
  /** Fail the spawn instead of returning a process. */
  spawnError?: Error;
}

export class FakeHost implements ProcessHost {
  readonly spawns: SpawnRecord[] = [];
  readonly sockets: FakeSocket[] = [];
  /** Paths handed out by `socketPath`, and whether they were cleaned up. */
  readonly scratch: { path: string; disposed: boolean }[] = [];
  installed: Set<string>;
  spawnError: Error | null;
  #pid = 1000;
  #scratchCount = 0;

  constructor(options: FakeHostOptions = {}) {
    this.installed = new Set(options.installed ?? []);
    this.spawnError = options.spawnError ?? null;
  }

  environment(): Record<string, string | undefined> {
    return { PATH: '/usr/bin', TERM: 'dumb' };
  }

  async which(command: string): Promise<string | null> {
    return this.installed.has(command) ? `/usr/bin/${command}` : null;
  }

  async spawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions = {},
  ): Promise<SpawnedProcess> {
    if (this.spawnError) throw this.spawnError;
    const process = new FakeProcess(this.#pid++);
    this.spawns.push({ command, args: [...args], options, process });
    return process;
  }

  async socketPath(prefix: string): Promise<ScratchSocket> {
    const entry = {
      path: `/tmp/${prefix}-${this.#scratchCount++}/sock`,
      disposed: false,
    };
    this.scratch.push(entry);
    return {
      path: entry.path,
      async dispose() {
        entry.disposed = true;
      },
    };
  }

  /**
   * Hold every `connect()` open until `releaseConnects()` is called.
   *
   * A real control socket does not exist until the player creates it, so the
   * connect can be seconds behind the spawn — long enough for the component
   * to have unmounted first. That window is where a socket leaks, so it has
   * to be reachable from a test.
   */
  holdConnect = false;
  #gates: (() => void)[] = [];

  async connect(): Promise<IpcSocket> {
    const socket = new FakeSocket();
    this.sockets.push(socket);
    if (this.holdConnect) {
      await new Promise<void>((resolve) => this.#gates.push(resolve));
    }
    return socket;
  }

  releaseConnects(): void {
    const gates = this.#gates;
    this.#gates = [];
    for (const open of gates) open();
  }

  /** The most recent spawn, which is what nearly every assertion wants. */
  get last(): SpawnRecord | undefined {
    return this.spawns[this.spawns.length - 1];
  }
}
