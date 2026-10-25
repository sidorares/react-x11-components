// A page's dedicated workers (HTML 10.2.6.3), on the page process's side.
// Each is a thread of its own (`worker-thread.ts`) with a script engine and
// a host of its own, over an empty document: the same facade as a page's,
// made a worker's global (`__becomeWorker`). What reaches it from here and
// back is strings and the network's answers: a message is serialized in the
// realm that posts it and made again in the one it is posted to
// (`serializeClone`), as only primitives cross into a realm.
//
// A worker's network is the page's, asked from here, so the browser's
// policy holds for it. `importScripts` is the one call that has to have its
// answer before it returns: the thread asks on a port of its own and waits
// on a shared word (`Atomics.wait`) while this side fetches, then reads the
// answer off the port (`receiveMessageOnPort`). The thread blocks; the page
// does not.
import { isBun, nodeModule, runtimeProcess } from './platform.js';
import type {
  AbortControllerClass,
  AbortSignalLike,
  MessagePortLike as MessagePort,
  UrlClass,
  UrlLike,
  WorkerLike,
  WorkerThreadsModule,
} from './platform.js';
import type {
  FetchRequest,
  FetchResponse,
  PageWorkersLike,
  WorkerInit,
} from './host.js';
import type { HtmlWebTransport } from '../transport.js';
import { TransportRelay } from './transport-relay.js';
import type { TransportAsk, TransportTell } from './transport-relay.js';

declare const URL: UrlClass;
declare const AbortController: AbortControllerClass;
type AbortController = InstanceType<AbortControllerClass>;

const { MessageChannel, Worker: Thread } =
  await nodeModule<WorkerThreadsModule>('worker_threads');

/** What a page's workers are given by the page they are the workers of. */
export interface PageWorkersSeams {
  fetch(request: FetchRequest, signal: AbortSignalLike): Promise<FetchResponse>;
  /** What a worker's WebTransport sessions are carried over: the page's
   *  own seam, read as each session opens. */
  readonly webTransport?: HtmlWebTransport;
  log(level: string, text: string): void;
  userAgent: string;
  language: string;
  /** A worker posted a message, for the page's `Worker`. */
  message(id: number, data: string): void;
  /** A worker's script threw what nothing there caught. */
  error(
    id: number,
    message: string,
    filename: string,
    line: number,
    column: number,
  ): void;
}

/** What the thread is started with. */
export interface WorkerThreadData {
  init: WorkerInit;
  userAgent: string;
  language: string;
  /** The port `importScripts` asks on, and the word it waits on. */
  sync: MessagePort;
  flag: SharedArrayBuffer;
}

/** What the thread tells this side. */
export type FromWorker =
  | { kind: 'message'; data: string }
  | {
      kind: 'error';
      message: string;
      filename: string;
      line: number;
      column: number;
    }
  | { kind: 'fetch'; id: number; request: FetchRequest }
  | { kind: 'abort'; id: number }
  | { kind: 'log'; level: string; text: string }
  | { kind: 'close' }
  | TransportAsk;

/** What this side tells the thread. */
export type ToWorker =
  | { kind: 'message'; data: string }
  | {
      kind: 'fetched';
      id: number;
      /** Its headers; with `streaming`, its body follows as `chunk`s. */
      response?: FetchResponse & { streaming?: boolean };
      error?: string;
    }
  | { kind: 'chunk'; id: number; bytes: Uint8Array }
  | { kind: 'fetchEnd'; id: number; error: string | null }
  | TransportTell;

/** Where this module is, and so the thread's: `dist/`'s JavaScript, or —
 *  run from the source, as the suite runs it — the TypeScript beside it. */
const HERE = (import.meta as { url: string }).url;
const ENTRY = new URL(
  HERE.endsWith('.ts') ? './worker-thread.ts' : './worker-thread.js',
  HERE,
);

/**
 * How a thread is started where the runtime does not hand a thread the
 * hooks that load TypeScript: Bun reads it as it is, and Node from 22 on
 * passes the main thread's module hooks — tsx's — on to a worker, but
 * Node 20 does not, and a thread there could not load its own entry. So on
 * a Node that does not, the thread registers tsx's hooks itself before it
 * imports the entry, where tsx is to be had.
 */
function threadSource(): UrlLike | string {
  const node = isBun()
    ? null
    : Number(runtimeProcess()?.versions.node?.split('.')[0] ?? 0);
  if (node === null || node >= 22 || !HERE.endsWith('.ts')) return ENTRY;
  let tsx: string | null = null;
  try {
    tsx = (import.meta as { resolve(specifier: string): string }).resolve(
      'tsx/esm/api',
    );
  } catch {
    return ENTRY;
  }
  return (
    `import(${JSON.stringify(tsx)})` +
    '.then((api) => api.register())' +
    `.then(() => import(${JSON.stringify(ENTRY.href)}));`
  );
}

interface Running {
  thread: WorkerLike;
  url: string;
  sync: MessagePort;
  fetches: Map<number, AbortController>;
  /** Its WebTransport sessions, made the first time it opens one. */
  transports: TransportRelay | null;
}

/** How many workers one page may have running at once. A page that spawns
 *  without end would otherwise make a thread each time; past this the
 *  request is logged and dropped, as a browser caps a page's workers. */
const MAX_WORKERS = 16;

/** What a worker's thread may hold, in megabytes of V8's old and young
 *  space. Node ends a thread that grows past it with
 *  `ERR_WORKER_OUT_OF_MEMORY`; Bun 1.4 does not enforce it (the pane's own
 *  bounds are the backstop there), so it is a hint, not a guarantee. */
const WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 64,
};

export class PageWorkers implements PageWorkersLike {
  private _running = new Map<number, Running>();
  private _seq = 0;
  private _disposed = false;

  constructor(private readonly _seams: PageWorkersSeams) {}

  start(init: WorkerInit): number {
    const id = ++this._seq;
    if (this._disposed) return id;
    if (this._running.size >= MAX_WORKERS) {
      this._seams.log(
        'warn',
        `A page tried to start more than ${MAX_WORKERS} workers at once; ${init.url} was not started.`,
      );
      return id;
    }
    const { port1, port2 } = new MessageChannel();
    const flag = new SharedArrayBuffer(4);
    const data: WorkerThreadData = {
      init,
      userAgent: this._seams.userAgent,
      language: this._seams.language,
      sync: port2,
      flag,
    };
    const source = threadSource();
    const thread = new Thread(source, {
      workerData: data,
      transferList: [port2],
      name: init.name || init.url,
      eval: typeof source === 'string',
      resourceLimits: WORKER_RESOURCE_LIMITS,
    });
    const running: Running = {
      thread,
      url: init.url,
      sync: port1,
      fetches: new Map(),
      transports: null,
    };
    this._running.set(id, running);
    thread.on('message', (m: FromWorker) => this._heard(id, running, m));
    thread.on('error', (error: Error) => {
      this._seams.error(id, String(error?.message ?? error), init.url, 0, 0);
    });
    thread.on('exit', () => {
      this._running.delete(id);
      running.transports?.dispose();
      port1.close();
    });
    const word = new Int32Array(flag);
    port1.on('message', (m: { url: string }) => {
      void this._load(m.url).then((source) => {
        port1.postMessage({ source });
        Atomics.store(word, 0, 1);
        Atomics.notify(word, 0);
      });
    });
    return id;
  }

  post(id: number, data: string): void {
    const message: ToWorker = { kind: 'message', data };
    this._running.get(id)?.thread.postMessage(message);
  }

  end(id: number): void {
    const running = this._running.get(id);
    if (!running) return;
    this._running.delete(id);
    for (const controller of running.fetches.values()) controller.abort();
    running.transports?.dispose();
    void running.thread.terminate();
  }

  dispose(): void {
    this._disposed = true;
    for (const id of [...this._running.keys()]) this.end(id);
  }

  /** A script's source, through the page's network: null where there is
   *  none to be had. */
  private async _load(url: string): Promise<string | null> {
    try {
      const response = await this._seams.fetch(
        { url, method: 'GET', headers: [], body: null },
        new AbortController().signal,
      );
      return response.status >= 200 && response.status < 300
        ? response.body
        : null;
    } catch {
      return null;
    }
  }

  /** A body handed to the thread a chunk at a time, until it ends or the
   *  thread lets it go. */
  private async _relay(
    running: Running,
    id: number,
    chunks: AsyncIterable<Uint8Array>,
    live: () => boolean,
  ): Promise<void> {
    const iterator = chunks[Symbol.asyncIterator]();
    let error: string | null = null;
    try {
      for (;;) {
        const { done, value } = await iterator.next();
        if (done) break;
        if (!live()) {
          void iterator.return?.();
          return;
        }
        running.thread.postMessage({ kind: 'chunk', id, bytes: value });
      }
    } catch {
      error = 'network error';
    }
    if (!live()) return;
    running.fetches.delete(id);
    running.thread.postMessage({ kind: 'fetchEnd', id, error });
  }

  private _heard(id: number, running: Running, m: FromWorker): void {
    switch (m.kind) {
      case 'message':
        this._seams.message(id, m.data);
        return;
      case 'error':
        this._seams.error(id, m.message, m.filename, m.line, m.column);
        return;
      case 'log':
        this._seams.log(m.level, `[worker ${running.url}] ${m.text}`);
        return;
      case 'close':
        this.end(id);
        return;
      case 'abort':
        running.fetches.get(m.id)?.abort();
        running.fetches.delete(m.id);
        return;
      case 'wt':
        // a WebTransport session's, over the page's own seam
        running.transports ??= new TransportRelay(
          () => this._seams.webTransport,
          (tell) => {
            if (this._running.get(id) === running) {
              running.thread.postMessage(tell);
            }
          },
        );
        running.transports.heard(m);
        return;
      case 'fetch': {
        const controller = new AbortController();
        running.fetches.set(m.id, controller);
        const live = (): boolean =>
          running.fetches.has(m.id) && this._running.get(id) === running;
        const answer = (message: ToWorker): void => {
          if (!live()) return;
          running.fetches.delete(m.id);
          running.thread.postMessage(message);
        };
        this._seams.fetch(m.request, controller.signal).then(
          (response) => {
            const { chunks, ...rest } = response;
            if (!chunks) {
              answer({ kind: 'fetched', id: m.id, response: rest });
              return;
            }
            // a body that arrives a chunk at a time crosses so, as the
            // page's own does
            if (!live()) {
              void chunks[Symbol.asyncIterator]().return?.();
              return;
            }
            running.thread.postMessage({
              kind: 'fetched',
              id: m.id,
              response: { ...rest, streaming: true },
            });
            void this._relay(running, m.id, chunks, live);
          },
          (error: unknown) =>
            answer({
              kind: 'fetched',
              id: m.id,
              error: String((error as Error)?.message ?? error),
            }),
        );
        return;
      }
    }
  }
}
