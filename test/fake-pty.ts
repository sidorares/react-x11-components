// A `PtyHost` that spawns nothing.
//
// The counterpart of `./fake-host.ts` for the vt backend, and the reason
// `PtyHost` is an interface: a terminal is entirely about a program on the
// other end of a pty, and CI has no native module built — so the suite drives
// both ends itself. Bytes in through `feed()`, bytes out in `writes`, which is
// the whole of what the component decides.
//
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it, but
// `tsconfig.json` does typecheck it.
import type { ExitInfo } from '../src/embed/index.js';
import type {
  PtyHost,
  PtyOptions,
  PtySession,
} from '../src/terminal/vt/index.js';

export interface OpenRecord {
  argv: readonly string[];
  options: PtyOptions;
  session: FakePtySession;
}

export class FakePtySession implements PtySession {
  readonly pid = 4242;
  /** Everything the terminal sent towards the program, in order. */
  readonly writes: string[] = [];
  /** Every `resize`, as `[cols, rows]`. */
  readonly resizes: Array<[number, number]> = [];
  readonly signals: string[] = [];
  paused = 0;
  resumed = 0;
  #data: ((chunk: string) => void)[] = [];
  #exit: ((info: ExitInfo) => void)[] = [];
  #alive = true;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }

  onData(listener: (chunk: string) => void): void {
    this.#data.push(listener);
  }

  onExit(listener: (info: ExitInfo) => void): void {
    this.#exit.push(listener);
  }

  pause(): void {
    this.paused++;
  }

  resume(): void {
    this.resumed++;
  }

  /** Pretend the program printed something. */
  feed(chunk: string): void {
    for (const listener of this.#data) listener(chunk);
  }

  /** Pretend it ended. */
  exit(info: ExitInfo = { code: 0, signal: null }): void {
    if (!this.#alive) return;
    this.#alive = false;
    for (const listener of this.#exit) listener(info);
  }

  /** What it was told, as one string — easier to assert than the chunks. */
  get written(): string {
    return this.writes.join('');
  }
}

export class FakePtyHost implements PtyHost {
  readonly opened: OpenRecord[] = [];
  /** False makes the host report "no pty module here". */
  installed: boolean;

  constructor(options: { installed?: boolean } = {}) {
    this.installed = options.installed ?? true;
  }

  async available(): Promise<boolean> {
    return this.installed;
  }

  async openPty(
    argv: readonly string[],
    options: PtyOptions,
  ): Promise<PtySession> {
    if (!this.installed) throw new Error('fake pty: nothing installed');
    const session = new FakePtySession();
    this.opened.push({ argv, options, session });
    return session;
  }

  environment(): Record<string, string | undefined> {
    return { SHELL: '/bin/sh', PATH: '/usr/bin' };
  }

  /** The session of the most recent `openPty`. */
  get last(): FakePtySession | null {
    return this.opened.length
      ? this.opened[this.opened.length - 1].session
      : null;
  }
}
