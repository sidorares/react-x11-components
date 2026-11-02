// What the script engine reaches of the runtime it runs on, written out.
//
// `src/` compiles with `types: []` (tsconfig.build.json), so a Node global or
// a `node:` module named here would fail the build rather than become an
// `@types/node` dependency an app has to satisfy. The engine needs both: it
// is a `node:vm` context a document, its workers are `worker_threads`, and
// it keeps time and makes requests with what Node and Bun put on
// `globalThis`. So the slice of each it uses is typed here, structurally,
// and the modules are loaded with a specifier the compiler cannot see —
// `src/embed/host.ts`'s shape — once the engine is wanted, which is never
// before a document's scripts are turned on.
//
// The globals are declared module by module where they are used (`declare
// const setTimeout: SetTimeout`), never globally: a declaration file here
// would declare them for every module the build compiles, and the next
// `process` that wanders into a component would type-check.

/** `setTimeout`, as Node and Bun have it. */
export type SetTimeout = (
  fn: (...args: never[]) => void,
  ms?: number,
) => unknown;
export type ClearTimeout = (id: unknown) => void;

/** What a request is told to stop by: an `AbortSignal`, as the runtime's
 *  `AbortController` makes one. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(reason?: unknown): void;
}
export type AbortControllerClass = new () => AbortControllerLike;

/** The WHATWG `URL`, the part of it read here. */
export interface UrlLike {
  href: string;
  readonly origin: string;
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  username: string;
  password: string;
  pathname: string;
  search: string;
  hash: string;
}
export type UrlClass = new (url: string, base?: string | UrlLike) => UrlLike;

/** `Buffer`, for base64 both ways. */
export interface BufferClass {
  from(text: string, encoding: 'base64' | 'latin1' | 'utf8'): Uint8Array;
  from(
    buffer: ArrayBufferLike,
    offset?: number,
    length?: number,
  ): Uint8Array & { toString(encoding: 'base64' | 'latin1'): string };
}

/** The slice of `process` the engine reads. */
export interface ProcessLike {
  versions: Record<string, string | undefined>;
  env: Record<string, string | undefined>;
  listeners(event: 'unhandledRejection'): ((...args: never[]) => unknown)[];
  on(event: 'unhandledRejection', listener: (...args: never[]) => void): void;
  off(event: 'unhandledRejection', listener: (...args: never[]) => void): void;
}

/** The runtime's `process`, where it has one. */
export function runtimeProcess(): ProcessLike | null {
  return (globalThis as unknown as { process?: ProcessLike }).process ?? null;
}

/** Whether this is Bun. */
export function isBun(): boolean {
  return (globalThis as { Bun?: unknown }).Bun !== undefined;
}

// --- node:vm -----------------------------------------------------------------

/** A context, opaque here: what `vm.createContext` makes. */
export type VmContext = object;

export interface VmScript {
  runInContext(
    context: VmContext,
    options?: { timeout?: number; displayErrors?: boolean },
  ): unknown;
}

export interface VmCreateContextOptions {
  name?: string;
  microtaskMode?: 'afterEvaluate';
  codeGeneration?: { strings?: boolean; wasm?: boolean };
  importModuleDynamically?: unknown;
}

export interface VmModule {
  Script: new (
    code: string,
    options?: { filename?: string; importModuleDynamically?: unknown },
  ) => VmScript;
  createContext(sandbox: unknown, options?: VmCreateContextOptions): VmContext;
  constants?: { DONT_CONTEXTIFY?: unknown };
  /** Bun's, and Node's behind `--experimental-vm-modules`. */
  SourceTextModule?: unknown;
}

export interface UtilModule {
  types: { isProxy(value: unknown): boolean };
}

// --- node:worker_threads -----------------------------------------------------

export interface MessagePortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: never) => void): void;
  close(): void;
  unref?(): void;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: never) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  terminate(): Promise<number>;
  unref(): void;
}

export interface WorkerThreadsModule {
  Worker: new (
    source: string | UrlLike,
    options: {
      workerData?: unknown;
      transferList?: unknown[];
      name?: string;
      eval?: boolean;
      resourceLimits?: {
        maxOldGenerationSizeMb?: number;
        maxYoungGenerationSizeMb?: number;
        codeRangeSizeMb?: number;
        stackSizeMb?: number;
      };
    },
  ) => WorkerLike;
  MessageChannel: new () => {
    port1: MessagePortLike;
    port2: MessagePortLike;
  };
  parentPort: MessagePortLike | null;
  workerData: unknown;
  receiveMessageOnPort(port: MessagePortLike): { message: unknown } | undefined;
}

/**
 * A `node:` module, loaded without naming it to the compiler or a bundler:
 * the specifier is a variable on purpose (`src/embed/host.ts`).
 */
export function nodeModule<T>(name: string): Promise<T> {
  const specifier = `node:${name}`;
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}
