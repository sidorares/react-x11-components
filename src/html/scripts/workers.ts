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
import { isClassicScriptType } from '../dom.js';
import type { ValueModule } from './script-origin.js';
import { readDataUrl } from '../network.js';
import { referrerPolicyOfHeaders } from '../referrer.js';
import type { FetchMode } from '../fetch-metadata.js';
import { nodeModule, threadEntry } from './platform.js';
import type {
  AbortControllerClass,
  AbortSignalLike,
  MessagePortLike as MessagePort,
  UrlClass,
  WorkerLike,
  WorkerThreadsModule,
} from './platform.js';
import { wholeBytes } from './host.js';
import { keepFrameAs } from '../frame-store.js';
import { gpuLockBuffer } from '../webgl.js';
import type {
  FetchRequest,
  FetchResponse,
  PageWorkersLike,
  WorkerInit,
} from './host.js';
import type { HtmlWebTransport } from '../transport.js';
import { TransportRelay } from './transport-relay.js';
import type { TransportAsk, TransportTell } from './transport-relay.js';
import { SocketRelay } from './socket-relay.js';
import type { SocketAsk, SocketTell } from './socket-relay.js';
import type { HtmlWebSocket } from '../socket.js';
import type { HtmlGLContext, HtmlGLOptions, HtmlWebGL } from '../webgl.js';
import type { CanvasText, TextSetting } from '../canvas-text.js';
import type {
  HtmlNotification,
  HtmlNotifications,
  HtmlShownNotification,
} from '../notifications.js';
import type { ChannelRelay } from './peers.js';
import { FsError, opfsOp, releaseOwner } from './opfs.js';
import type { HtmlCacheAnswer, HtmlCacheAsk } from '../cache-storage.js';

declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };
declare const performance: { now(): number; timeOrigin: number };
declare const URL: UrlClass;
declare const setTimeout: (fn: () => void, ms: number) => { unref?(): void };
declare const AbortController: AbortControllerClass;
type AbortController = InstanceType<AbortControllerClass>;

const { MessageChannel, Worker: Thread } =
  await nodeModule<WorkerThreadsModule>('worker_threads');

/** What a page's workers are given by the page they are the workers of. */
export interface PageWorkersSeams {
  /** A worker's request, and the worker that made it. */
  fetch(
    request: FetchRequest,
    signal: AbortSignalLike,
    id?: number,
  ): Promise<FetchResponse>;
  /** What a worker's WebTransport sessions are carried over: the page's
   *  own seam, read as each session opens. */
  readonly webTransport?: HtmlWebTransport;
  /** What a worker's WebSockets are carried over: the page's own seam,
   *  read as each connection opens. */
  readonly webSocket?: HtmlWebSocket;
  /** What a worker's WebGL contexts draw through: the page's own seam, read
   *  as each context opens. */
  readonly webgl?: HtmlWebGL;
  /** The page's text engine, which a worker's canvases set their text in:
   *  asked as each string is drawn or measured. */
  canvasText?(): CanvasText | null;
  /** What a worker's `Notification`s reach: the page's own seam. */
  readonly notifications?: HtmlNotifications;
  /** Where each permission stands for the page, handed to a worker as it
   *  starts. */
  permissions?(): Record<string, string>;
  log(level: string, text: string): void;
  userAgent: string;
  language: string;
  /** A worker asked for a connection its frozen document cannot hold
   *  (`freeze`): the document goes, as one the cache drops. */
  letGo(): void;
  /** A worker posted a message, for the page's `Worker`. */
  message(id: number, data: string): void;
  /** A worker asked of a data channel the page handed it. */
  rtc?(id: number, message: ChannelRelay): void;
  /** A worker's script threw what nothing there caught; or, `failed`, its
   *  script did not come or did not parse, which is a plain `error` at its
   *  `Worker` (HTML 10.2.4, "run a worker", step 24). */
  error(
    id: number,
    message: string,
    filename: string,
    line: number,
    column: number,
    failed?: boolean,
  ): void;
  /** What a worker's `caches` ask, in the store the page's are kept in. */
  caches?(origin: string, ask: HtmlCacheAsk): Promise<HtmlCacheAnswer>;
  /** What a service worker's realm said to its registry, and the bytes of a
   *  body it handed on (`sw-registry.ts`). */
  service?(id: number, text: string, bytes?: Uint8Array): void;
  /** A script a worker imports, where it does not come from the network: a
   *  service worker's, from those it was installed with, and `type` where it
   *  imports a JSON or a text module. */
  script?(id: number, url: string, type?: ValueModule): Promise<string | null>;
  /** A worker's thread started, or ended, whoever ended it. */
  started?(id: number, init: WorkerInit): void;
  exited?(id: number): void;
}

/** What the thread is started with. */
export interface WorkerThreadData {
  init: WorkerInit;
  userAgent: string;
  language: string;
  /** The port `importScripts` asks on, and the word it waits on. */
  sync: MessagePort;
  flag: SharedArrayBuffer;
  /** The word that says whether the page's document is frozen, and the one
   *  that counts the threads stopped for it (`PageWorkers.freeze`). */
  frozen: SharedArrayBuffer;
  stopped: SharedArrayBuffer;
  /** Where each permission stands, which `permissionMoved` keeps current. */
  permissions: Record<string, string>;
  /** Whether the page has anything to show a notification with. */
  notifies: boolean;
  /** Whether the page has a GPU, which the thread may open one of its own
   *  on (`gpuWebGL`): its contexts then draw here, where the page's thread
   *  is not held up by a glass panel's frames. */
  gpu: boolean;
  /** The lock every thread takes its turns at the GPU by (`useGpuLock`). */
  gpuLock: SharedArrayBuffer;
  /** One word: the frames this thread shipped that the page has not taken. */
  gpuInflight: SharedArrayBuffer;
  /** When the page made it, as `performance.timeOrigin +
   *  performance.now()` reads it here, which a thread's own origin and
   *  `now` come to alike: where the worker's time starts (HR Time 3, the
   *  time origin), however long its thread takes to come up. */
  born: number;
}

/** What the thread tells this side. */
export type FromWorker =
  /** Its modules are in, and it can be terminated (`PageWorkers.end`). */
  | { kind: 'up' }
  /** It opened a GPU context of its own, which ending it has to let go of
   *  first (`PageWorkers.end`). */
  | { kind: 'gpu' }
  /** It let its contexts go. */
  | { kind: 'gpuGone' }
  /** A frame its GPU drew, for a canvas of the page's: the pixels are moved,
   *  and the number is the one the message that names it will carry. */
  | {
      kind: 'gpuFrame';
      id: number;
      width: number;
      height: number;
      data: Uint8ClampedArray;
    }
  /** A worker's `Notification`, over the page's seam. */
  | { kind: 'notification'; id: number; show: HtmlNotification }
  | { kind: 'notification'; id: number; close: true }
  | { kind: 'notification'; id: number; focus: true }
  | { kind: 'message'; data: string }
  | {
      kind: 'error';
      message: string;
      filename: string;
      line: number;
      column: number;
      failed?: boolean;
    }
  | { kind: 'fetch'; id: number; request: FetchRequest }
  | { kind: 'abort'; id: number }
  | { kind: 'log'; level: string; text: string }
  | { kind: 'close' }
  /** What a service worker's realm says to its registry. */
  | { kind: 'service'; text: string; bytes?: Uint8Array }
  /** What a worker's `caches` ask. */
  | { kind: 'caches'; id: number; origin: string; ask: HtmlCacheAsk }
  /** A worker's own `Worker` (HTML 10.2.6.3): started, posted to and ended
   *  by this process, which is where its thread runs. */
  | { kind: 'nested'; op: 'start'; child: number; init: WorkerInit }
  | { kind: 'nested'; op: 'post'; child: number; data: string }
  | { kind: 'nested'; op: 'end'; child: number }
  | TransportAsk
  | SocketAsk
  | ChannelRelay;

/** What this side tells the thread. */
export type ToWorker =
  | { kind: 'message'; data: string }
  /** Let go of the GPU contexts: it is to end. */
  | { kind: 'releaseGpu' }
  /** What a service worker's registry says to its realm. */
  | { kind: 'service'; text: string }
  /** What a worker's `caches` asked came to. */
  | { kind: 'caches'; id: number; answer: HtmlCacheAnswer }
  | { kind: 'permission'; name: string; state: string }
  /** What became of a worker's notification. */
  | { kind: 'notification'; id: number; told: string }
  | {
      kind: 'fetched';
      id: number;
      /** Its headers; with `streaming`, its body follows as `chunk`s. */
      response?: FetchResponse & { streaming?: boolean };
      error?: string;
    }
  | { kind: 'chunk'; id: number; bytes: Uint8Array }
  | { kind: 'fetchEnd'; id: number; error: string | null }
  /** The word that says whether the page's document is frozen changed. */
  | { kind: 'suspended' }
  /** What a worker's own `Worker` said: a message, or an error, by the
   *  number the worker knows it by. */
  | { kind: 'nested'; op: 'message'; child: number; data: string }
  | {
      kind: 'nested';
      op: 'error';
      child: number;
      message: string;
      filename: string;
      line: number;
      column: number;
    }
  | TransportTell
  | SocketTell
  | ChannelRelay;

const threadSource = threadEntry(
  (import.meta as { url: string }).url,
  'worker-thread',
);

/** Take a notification down, whatever the host's hook makes of it. */
function closeNotification(shown: HtmlShownNotification | null | undefined) {
  try {
    void Promise.resolve(shown?.close()).catch(() => {});
  } catch {
    // nothing is left to hear it did not close
  }
}

/** What a thread asks on its synchronous port, where it sleeps until it is
 *  answered: an `importScripts`, or a synchronous `XMLHttpRequest`, which the
 *  page's network is awake to make. */
type SyncAsk =
  | {
      url: string;
      type?: ValueModule;
      /** What it is to Fetch: the worker's own script, or one it imports
       *  (`Sec-Fetch-Dest`, `-Mode`). */
      destination?: string;
      mode?: FetchMode;
      credentials?: 'omit' | 'same-origin' | 'include';
    }
  | { id: number; request: FetchRequest }
  | { id: number; abort: true }
  /** An op on the origin private file system (`opfs.ts`), which this
   *  process holds for the worker's page and its workers alike. */
  | { id: number; opfs: [string, string, string, string, string] }
  /** An op on the page's GPU (`HtmlWebGL`), which a worker's WebGL contexts
   *  draw through: a context is the page process's, its calls are asked
   *  and slept on, since `getError` and `readPixels` answer at once. */
  | { id: number; gl: GLAsk; quiet?: true }
  /** What a worker's canvas asks of the page's fonts (`canvas-text.ts`): a
   *  worker has no text engine, and sets its text in the page's. */
  | { id: number; text: TextAsk };

/** What a worker's canvas asks of the fonts, as `CanvasText` has them. */
export type TextAsk =
  | ['now']
  | ['font', string]
  | ['measure', string, string, TextSetting]
  | ['raster', string, string, number, TextSetting, number];

/** What a worker asks of its WebGL contexts: its own number for each. */
export type GLAsk =
  | ['open', HtmlGLOptions]
  | ['run', number, unknown[]]
  | ['resize', number, number, number]
  | ['present', number, number]
  | ['sync']
  | ['snapshot', number]
  | ['discard', number, number]
  | ['frame', number, number]
  | ['dispose', number];

interface Running {
  thread: WorkerLike;
  /** Whether its modules are in, as it said (`end`). */
  up: boolean;
  /** Whether it holds a GPU context of its own (`end`). */
  gpu: boolean;
  gpuInflight: SharedArrayBuffer;
  url: string;
  sync: MessagePort;
  fetches: Map<number, AbortController>;
  /** Its WebTransport sessions, made the first time it opens one. */
  transports: TransportRelay | null;
  /** Its WebSockets, made the first time it opens one. */
  sockets: SocketRelay | null;
  /** Its notifications that are showing. */
  shown: Map<number, HtmlShownNotification | null>;
  /** Its WebGL contexts, made on the page's GPU as it opens them. */
  gl: Map<number, HtmlGLContext>;
  /** The workers it started itself, run from here, made the first time it
   *  starts one: what each is known by there, and here. */
  nested: {
    workers: PageWorkers;
    ids: Map<number, number>;
    /** And the other way round. */
    byChild: Map<number, number>;
  } | null;
}

/** How many workers one page may have running at once. A page that spawns
 *  without end would otherwise make a thread each time; past this the
 *  request is logged and dropped, as a browser caps a page's workers.
 *  Firefox allows 512 to a site and Chrome none this low; an idle thread
 *  here is some 20 MB, so 64 is about a gigabyte and a half. Nothing
 *  collects a worker its page can no longer reach, as a browser does, so
 *  a page that makes one a test and ends none holds them all: WPT's
 *  `transfer-datachannel` makes 37, and at 16 every test after the
 *  sixteenth waited for a worker that never started. */
const MAX_WORKERS = 64;

/** What a worker's thread may hold, in megabytes of V8's old and young
 *  space, read as each thread starts. Node ends a thread that grows past it
 *  with `ERR_WORKER_OUT_OF_MEMORY`; Bun 1.4 does not enforce it (the pane's
 *  own bounds are the backstop there), so it is a hint, not a guarantee. A
 *  thread uses some 90 MB of it before its worker's script does anything, so
 *  the worker's own code has the rest, where Chrome gives one gigabytes: a
 *  worker that holds a lot at once is ours to keep small (`handing` in
 *  `caches.ts`). Exported from this module though not from the package, so a
 *  test can lower it, as `stallClock` is held. */
export const workerResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 64,
};

let pageWorkersMade = 0;

export class PageWorkers implements PageWorkersLike {
  private _running = new Map<number, Running>();
  private _seq = 0;
  /** This set of workers' own, apart from every other page's. */
  private readonly _uid = ++pageWorkersMade;
  private _disposed = false;
  /** The word that says the document is frozen, and the count of threads
   *  stopped for it: the page's, which its workers' own workers share. */
  private readonly _frozen: SharedArrayBuffer;
  private readonly _stopped: SharedArrayBuffer;
  /** Threads ended before they were up, which go on loading until they are
   *  (`end`) and hold what a running thread holds, so they count against the
   *  limit: a page that starts and ends workers in a loop has no other. */
  private readonly _ending = new Set<Running>();

  constructor(
    private readonly _seams: PageWorkersSeams,
    private readonly _limit: number = MAX_WORKERS,
    /** Whether a thread keeps the process alive only while something waits
     *  on it (`hold`): a service worker's stays with no page to answer for
     *  it, and held the process 30 seconds past its last client. */
    private readonly _background: boolean = false,
    /** The page's set, where this is a worker's own: its threads count
     *  against the page's limit, which nesting would otherwise multiply
     *  without end, and stop with the page's document. */
    private readonly _root: PageWorkers | null = null,
  ) {
    this._frozen = _root?._frozen ?? new SharedArrayBuffer(4);
    this._stopped = _root?._stopped ?? new SharedArrayBuffer(4);
  }

  /** The threads this set holds, its workers' own among them. */
  private _live(): number {
    let live = this._running.size + this._ending.size;
    for (const running of this._running.values()) {
      if (running.nested) live += running.nested.workers._live();
    }
    return live;
  }

  /** A worker's number, for one that is never started: refused before its
   *  script was asked for. */
  refuse(): number {
    return ++this._seq;
  }

  start(init: WorkerInit): number {
    const id = ++this._seq;
    if (this._disposed) return id;
    if ((this._root ?? this)._live() >= this._limit) {
      this._seams.log(
        'warn',
        `A page tried to start more than ${this._limit} workers at once; ${init.url} was not started.`,
      );
      return id;
    }
    const { port1, port2 } = new MessageChannel();
    const flag = new SharedArrayBuffer(4);
    const gpuInflight = new SharedArrayBuffer(4);
    const data: WorkerThreadData = {
      init,
      userAgent: this._seams.userAgent,
      language: this._seams.language,
      sync: port2,
      flag,
      frozen: this._frozen,
      stopped: this._stopped,
      permissions: this._seams.permissions?.() ?? {},
      notifies: !!this._seams.notifications,
      gpu: !!this._seams.webgl,
      gpuLock: gpuLockBuffer(),
      gpuInflight,
      born: performance.timeOrigin + performance.now(),
    };
    const source = threadSource();
    const thread = new Thread(source, {
      workerData: data,
      transferList: [port2],
      name: init.name || init.url,
      eval: typeof source === 'string',
      resourceLimits: { ...workerResourceLimits },
    });
    /** Who holds the file locks this worker takes (`opfs.ts`), let go as
     *  its thread ends. */
    const owner = `worker:${this._uid}:${id}`;
    const running: Running = {
      thread,
      up: false,
      url: init.url,
      sync: port1,
      gpu: false,
      gpuInflight,
      fetches: new Map(),
      shown: new Map(),
      gl: new Map(),
      transports: null,
      sockets: null,
      nested: null,
    };
    this._running.set(id, running);
    this._seams.started?.(id, init);
    thread.on('message', (m: FromWorker) => this._heard(id, running, m));
    thread.on('error', (error: Error) => {
      this._seams.error(id, String(error?.message ?? error), init.url, 0, 0);
    });
    thread.on('exit', () => {
      // its own workers go with it (HTML 10.2.4: a worker none of whose
      // owners is left is closed)
      for (const sub of running.nested?.ids.values() ?? []) {
        running.nested!.workers.end(sub);
      }
      releaseOwner(owner);
      for (const context of running.gl.values()) context.dispose();
      running.gl.clear();
      this._seams.exited?.(id);
      this._running.delete(id);
      this._ending.delete(running);
      running.transports?.dispose();
      running.sockets?.dispose();
      port1.close();
    });
    if (this._background) thread.unref();
    const word = new Int32Array(flag);
    /** What a synchronous request of the thread's is waiting on. */
    let waited: AbortController | null = null;
    const answer = (message: unknown): void => {
      port1.postMessage(message);
      Atomics.store(word, 0, 1);
      Atomics.notify(word, 0);
    };
    let nextGl = 1;
    port1.on('message', (m: SyncAsk) => {
      if ('gl' in m) {
        const done = this._gl(running, m.gl, () => nextGl++);
        // a batch posted and not waited for has no one to answer
        if (!m.quiet) answer({ id: m.id, ...done });
        return;
      }
      if ('text' in m) {
        answer({ id: m.id, ...this._text(m.text) });
        return;
      }
      if ('opfs' in m) {
        const [origin, op, a, b, c] = m.opfs;
        try {
          answer({ id: m.id, value: opfsOp(origin, owner, op, a, b, c) });
        } catch (error) {
          const e = error as Partial<FsError>;
          answer({
            id: m.id,
            error: [
              error instanceof FsError ? e.kind! : 'UnknownError',
              String(e.message ?? error),
            ],
          });
        }
        return;
      }
      if ('abort' in m) {
        waited?.abort();
        return;
      }
      if ('request' in m) {
        const controller = new AbortController();
        waited = controller;
        void this._seams
          .fetch(m.request, controller.signal, id)
          .then(async (response) => {
            const { chunks: _chunks, ...rest } = response;
            const bytes = await wholeBytes(response);
            return { ...rest, bytes };
          })
          .then(
            (response) => answer({ id: m.id, response }),
            (error: unknown) =>
              answer({
                id: m.id,
                failed: String((error as Error)?.message ?? error),
              }),
          );
        return;
      }
      // the worker's own script says what its requests' referrers are made
      // under (HTML 10.2.5.1, "run a worker", a policy container from its
      // response)
      const own = m.destination !== undefined;
      void (
        this._seams.script?.(id, m.url, m.type) ??
        this._load(m.url, id, m.destination, m.mode, own, m.credentials)
      ).then((loaded) =>
        answer(
          typeof loaded === 'object' && loaded !== null
            ? loaded
            : { source: loaded },
        ),
      );
    });
    if (this._background) port1.unref?.();
    return id;
  }

  post(id: number, data: string): void {
    const message: ToWorker = { kind: 'message', data };
    this._running.get(id)?.thread.postMessage(message);
  }

  /** Whether something waits on a background thread, which keeps the process
   *  alive for as long as it does. */
  hold(id: number, waited: boolean): void {
    const running = this._running.get(id);
    if (waited) running?.thread.ref();
    else running?.thread.unref();
  }

  /** A service worker's registry to its realm. */
  service(id: number, text: string): void {
    const message: ToWorker = { kind: 'service', text };
    this._running.get(id)?.thread.postMessage(message);
  }

  rtc(id: number, message: ChannelRelay): void {
    this._running.get(id)?.thread.postMessage(message);
  }

  /**
   * A worker goes. Its thread is terminated once its modules are in (`up`)
   * and no sooner: in Node 24.14 to 24.18, 25.7 to 25.9 and 26.0 to 26.3 a
   * thread terminated in the middle of the native CommonJS lexer fails a
   * `ToLocalChecked`, which aborts the process (nodejs/node#63323), so a page
   * left as its worker started took every page in the process with it. It can
   * go back to terminating at once when `engines` leaves those behind.
   */
  end(id: number): void {
    const running = this._running.get(id);
    if (!running) return;
    this._running.delete(id);
    for (const controller of running.fetches.values()) controller.abort();
    running.transports?.dispose();
    running.sockets?.dispose();
    for (const shown of running.shown.values()) closeNotification(shown);
    if (running.gpu) {
      // a context of its own is let go of by the thread that made it, and
      // the thread ended once it has, or after a moment where it cannot
      running.thread.postMessage({ kind: 'releaseGpu' } satisfies ToWorker);
      setTimeout(() => void running.thread.terminate(), 2000).unref?.();
    } else if (running.up) void running.thread.terminate();
    else this._ending.add(running);
  }

  dispose(): void {
    this._disposed = true;
    for (const id of [...this._running.keys()]) this.end(id);
  }

  /** A permission moved: each thread's copy follows. */
  permissionMoved(name: string, state: string): void {
    for (const running of this._running.values()) {
      running.thread.postMessage({ kind: 'permission', name, state });
    }
  }

  /** A worker's `Notification`: the page's seam, told back across. */
  private _notification(
    id: number,
    running: Running,
    m: Extract<FromWorker, { kind: 'notification' }>,
  ): void {
    const seam = this._seams.notifications;
    const told = (word: string): void => {
      if (this._running.get(id) !== running) return;
      running.thread.postMessage({
        kind: 'notification',
        id: m.id,
        told: word,
      });
    };
    if ('focus' in m) {
      seam?.focus?.();
    } else if ('close' in m) {
      closeNotification(running.shown.get(m.id));
      running.shown.delete(m.id);
    } else if (!seam) {
      told('error');
    } else {
      running.shown.set(m.id, null);
      void seam
        .show(m.show, {
          click: () => {
            if (running.shown.has(m.id)) told('click');
          },
          close: () => {
            if (running.shown.delete(m.id)) told('close');
          },
        })
        .then(
          (shown) => {
            if (!running.shown.has(m.id)) {
              closeNotification(shown);
              return;
            }
            running.shown.set(m.id, shown);
            told('show');
          },
          () => {
            if (running.shown.delete(m.id)) told('error');
          },
        );
    }
  }

  /**
   * The document is in the back-forward cache, and its workers stop with it
   * (HTML 10.2.4: a worker none of whose owners is fully active is
   * suspendable, and its script does not run), each at its own engine. A
   * thread reads the word, since one still starting hears no message until
   * its script has run, and the message is what has one that is waiting read
   * it. A task under way runs to its end: what it asks reaches a frozen
   * document (`_refused`). Their WebTransport sessions end now, told after
   * the thread has heard it stopped.
   */
  freeze(): void {
    this._suspend(1);
    for (const running of this._running.values()) {
      running.transports?.contextCleanup();
      running.nested?.workers.freeze();
    }
  }

  /** It is shown again, and they go on from where they stopped. */
  thaw(): void {
    this._suspend(0);
  }

  private _suspend(frozen: 0 | 1): void {
    Atomics.store(new Int32Array(this._frozen), 0, frozen);
    const message: ToWorker = { kind: 'suspended' };
    for (const running of this._running.values()) {
      running.thread.postMessage(message);
      running.nested?.workers._suspend(frozen);
    }
  }

  /** How many threads have stopped for the back-forward cache, which is
   *  what a test waits on: a stopped thread does nothing else to say so. */
  get stopped(): number {
    return Atomics.load(new Int32Array(this._stopped), 0);
  }

  /** Whether the document is in the back-forward cache. */
  private get _kept(): boolean {
    return Atomics.load(new Int32Array(this._frozen), 0) === 1;
  }

  /**
   * Whether a connection a worker asked for goes no further: one a task
   * under way as the document was frozen asked for, which `connected` did
   * not know of yet. A peer would see it held, so the document is let go and
   * nothing is opened, as a browser evicts a page that comes to use what
   * would have kept it out of the cache. A WebTransport session keeps no
   * document out, and fails instead (`TransportRelay.refuse`).
   */
  private _refused(m: SocketAsk): boolean {
    if (!this._kept || m.op !== 'connect') return false;
    this._seams.letGo();
    return true;
  }

  /** Whether a worker has a WebSocket open, which keeps the page out of the
   *  back-forward cache as one of its own would. A peer connection a worker
   *  cannot make, and a data channel it is handed stays the page's. */
  get connected(): boolean {
    for (const running of this._running.values()) {
      if (running.sockets?.open || running.nested?.workers.connected) {
        return true;
      }
    }
    return false;
  }

  /** A script's source, through the page's network: null where there is
   *  none to be had. */
  private async _load(
    url: string,
    id: number,
    destination = 'script',
    mode: FetchMode = 'no-cors',
    own = false,
    credentials?: 'omit' | 'same-origin' | 'include',
  ): Promise<
    | string
    | null
    | {
        source: string | null;
        policy: string;
        csp?: [string, string][];
        /** Where it came from, after its redirects. */
        url?: string;
      }
  > {
    // a `data:` script is read here, whatever the mode: Fetch hands a data:
    // URL to its scheme fetch before it asks whose it is (4.1, "main fetch")
    if (/^data:/i.test(url)) {
      const read = readDataUrl(url);
      const source = read ? new TextDecoder().decode(read.bytes) : null;
      return own ? { source, policy: '' } : source;
    }
    try {
      const response = await this._seams.fetch(
        {
          url,
          method: 'GET',
          headers: [],
          body: null,
          mode,
          destination,
          ...(credentials ? { credentials } : {}),
        },
        new AbortController().signal,
        id,
      );
      // a classic worker's script and what it imports, over HTTP(S), are
      // scripts only where their response says so (HTML 8.1.5.1, "fetch a
      // classic worker script" and "fetch a classic worker-imported
      // script"): `text/plain` is a network error, as a 404 is. A module's
      // type is judged where its graph is (`judgeScript`)
      const typed =
        mode === 'cors' ||
        !/^https?:/i.test(response.url || url) ||
        isClassicScriptType(
          (response.headers.find(([k]) => /^content-type$/i.test(k))?.[1] ?? '')
            .split(';')[0]
            .trim(),
        );
      const source =
        typed && response.status >= 200 && response.status < 300
          ? response.body
          : null;
      return own
        ? {
            source,
            // where it came from, which is the worker's URL (HTML 10.2.4,
            // "run a worker": the response's URL)
            url: response.url || url,
            policy: referrerPolicyOfHeaders(response.headers),
            csp: response.headers.filter(([k]) =>
              /^content-security-policy(-report-only)?$/i.test(k),
            ),
          }
        : // an import's, with where it came from, which says whose its
          // errors are (HTML 8.1.4.6, "muted errors")
          { source, policy: '', url: response.url || url };
    } catch {
      return null;
    }
  }

  /**
   * A worker's own `Worker`: a thread of this process's like any, owned by
   * the worker, whose messages and errors go to the worker's thread and not
   * to the page, and its requests to the page's network as the worker's do.
   */
  private _nested(
    id: number,
    running: Running,
    m: Extract<FromWorker, { kind: 'nested' }>,
  ): void {
    const told = (message: ToWorker): void => {
      if (this._running.get(id) === running)
        running.thread.postMessage(message);
    };
    if (m.op === 'start') {
      if (!running.nested) {
        const byChild = new Map<number, number>();
        const childOf = (sub: number): number | undefined => byChild.get(sub);
        const workers = new PageWorkers(
          {
            ...this._seams,
            message: (sub, data) => {
              const child = childOf(sub);
              if (child) told({ kind: 'nested', op: 'message', child, data });
            },
            error: (sub, message, filename, line, column) => {
              const child = childOf(sub);
              if (child) {
                told({
                  kind: 'nested',
                  op: 'error',
                  child,
                  message,
                  filename,
                  line,
                  column,
                });
              }
            },
            // a worker's own workers are no worker the page lists
            started: undefined,
            exited: undefined,
          },
          this._limit,
          false,
          this._root ?? this,
        );
        running.nested = { workers, ids: new Map(), byChild };
      }
      const nested = running.nested;
      const sub = nested.workers.start(m.init);
      nested.ids.set(m.child, sub);
      nested.byChild.set(sub, m.child);
      return;
    }
    const sub = running.nested?.ids.get(m.child);
    if (sub === undefined) return;
    if (m.op === 'post') running.nested!.workers.post(sub, m.data);
    else {
      running.nested!.workers.end(sub);
      running.nested!.ids.delete(m.child);
    }
  }

  /** A worker's `caches`, in the page's store. */
  private _caches(
    id: number,
    running: Running,
    m: Extract<FromWorker, { kind: 'caches' }>,
  ): void {
    const told = (answer: HtmlCacheAnswer): void => {
      if (this._running.get(id) !== running) return;
      const message: ToWorker = { kind: 'caches', id: m.id, answer };
      running.thread.postMessage(message);
    };
    if (!this._seams.caches) {
      told({ error: 'SecurityError' });
      return;
    }
    this._seams
      .caches(m.origin, m.ask)
      .then(told, () => told({ error: 'UnknownError' }));
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

  /** One of a worker's asks of the page's fonts: what they came to, or
   *  `none` where the page has no text engine, which leaves the worker's
   *  text as it was, drawn as nothing. */
  private _text(ask: TextAsk): {
    value?: unknown;
    none?: true;
    error?: string;
  } {
    try {
      const fonts = this._seams.canvasText?.() ?? null;
      if (!fonts) return { none: true };
      switch (ask[0]) {
        case 'now':
          return { value: [fonts.generation, fonts.direction(null)] };
        case 'font':
          return { value: fonts.font(ask[1], null) };
        case 'measure':
          return { value: fonts.measure(ask[1], ask[2], ask[3]) };
        case 'raster':
          return {
            value: fonts.raster(ask[1], ask[2], ask[3], ask[4], ask[5]),
          };
      }
    } catch (error) {
      return { error: String((error as Error)?.message ?? error) };
    }
  }

  /** One of a worker's WebGL ops, on the page's GPU: what it came to, for
   *  the thread asleep on it. A page with no GPU answers `open` with null,
   *  and the worker's context draws nothing, as the page's own would. */
  private _gl(
    running: Running,
    ask: GLAsk,
    next: () => number,
  ): { value?: unknown; frame?: Uint8ClampedArray; error?: string } {
    try {
      switch (ask[0]) {
        case 'open': {
          const context = this._seams.webgl?.open(ask[1]);
          if (!context) return { value: null };
          const ctx = next();
          running.gl.set(ctx, context);
          return { value: { ctx, extensions: [...context.extensions] } };
        }
        case 'run':
          return {
            value:
              running.gl.get(ask[1])?.run(ask[2] as [string, ...unknown[]][]) ??
              null,
          };
        case 'resize':
          running.gl.get(ask[1])?.resize(ask[2], ask[3]);
          return { value: null };
        case 'present': {
          const frame = new Uint8ClampedArray(ask[2]);
          running.gl.get(ask[1])?.present(frame);
          return { value: null, frame };
        }
        case 'sync':
          return { value: null };
        case 'snapshot':
          return { value: running.gl.get(ask[1])?.snapshot?.() ?? null };
        case 'discard':
          running.gl.get(ask[1])?.discard?.(ask[2]);
          return { value: null };
        case 'frame': {
          const data = running.gl.get(ask[1])?.frameData?.(ask[2]) ?? null;
          return data
            ? { value: null, frame: new Uint8ClampedArray(data) }
            : { value: null };
        }
        case 'dispose':
          running.gl.get(ask[1])?.dispose();
          running.gl.delete(ask[1]);
          return { value: null };
      }
    } catch (error) {
      return { error: String((error as Error)?.message ?? error) };
    }
  }

  private _heard(id: number, running: Running, m: FromWorker): void {
    switch (m.kind) {
      case 'gpu':
        running.gpu = true;
        return;
      case 'gpuGone':
        void running.thread.terminate();
        return;
      case 'gpuFrame':
        keepFrameAs(
          m.id,
          { width: m.width, height: m.height, data: m.data },
          () => {
            Atomics.sub(new Int32Array(running.gpuInflight), 0, 1);
          },
        );
        return;
      case 'up':
        running.up = true;
        if (this._ending.has(running)) void running.thread.terminate();
        return;
      case 'message':
        this._seams.message(id, m.data);
        return;
      case 'error':
        this._seams.error(
          id,
          m.message,
          m.filename,
          m.line,
          m.column,
          m.failed,
        );
        return;
      case 'log':
        this._seams.log(m.level, `[worker ${running.url}] ${m.text}`);
        return;
      case 'close':
        this.end(id);
        return;
      case 'nested':
        this._nested(id, running, m);
        return;
      case 'service':
        this._seams.service?.(id, m.text, m.bytes);
        return;
      case 'caches':
        this._caches(id, running, m);
        return;
      case 'notification':
        this._notification(id, running, m);
        return;
      case 'abort':
        running.fetches.get(m.id)?.abort();
        running.fetches.delete(m.id);
        return;
      case 'rtc':
        // a data channel's the page handed it, which is the page's
        this._seams.rtc?.(id, m);
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
        if (m.op === 'connect' && this._kept) running.transports.refuse(m.s);
        else running.transports.heard(m);
        return;
      case 'ws':
        // a WebSocket's, over the page's own seam
        if (this._refused(m)) return;
        running.sockets ??= new SocketRelay(
          () => this._seams.webSocket,
          (tell) => {
            if (this._running.get(id) === running) {
              running.thread.postMessage(tell);
            }
          },
        );
        running.sockets.heard(m);
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
        this._seams.fetch(m.request, controller.signal, id).then(
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
