// A dedicated worker's thread (`workers.ts`): a script engine and a host of
// its own over an empty document, the facade made a worker's global
// (`__becomeWorker`), and the worker's script run in it. What the page
// posts arrives as text and is made again here; what this posts, and what
// it fetches, goes to the page process, whose network the browser's policy
// is kept by.
import { referrerPolicyOf } from '../referrer.js';
import { Document } from 'domhandler';

import type { HtmlHandle } from '../index.js';
import { ScriptEngine } from './engine.js';
import { DomHost } from './host.js';
import type { FetchRequest, FetchResponse, HostSeams } from './host.js';
import type { Primitive } from './dom.js';
import type { FromWorker, ToWorker, WorkerThreadData } from './workers.js';
import { TransportProxy } from './transport-relay.js';
import { SocketProxy } from './socket-relay.js';
import { addKeySecret } from './subtle.js';
import { FsError } from './opfs.js';
import {
  MODULE_ACCEPT,
  judgeScript,
  type ValueModule,
} from './script-origin.js';
import { nodeModule } from './platform.js';
import type {
  AbortControllerClass,
  AbortSignalLike,
  WorkerThreadsModule,
} from './platform.js';

import type {
  HtmlNotificationEvents,
  HtmlNotifications,
  HtmlShownNotification,
} from '../notifications.js';
import type { HtmlPermissions, HtmlPermissionState } from '../permissions.js';
import type { HtmlCacheAnswer, HtmlCacheAsk } from '../cache-storage.js';
import { gpuWebGL, useGpuLock } from '../webgl.js';
import type { HtmlGLContext, HtmlGLOptions, HtmlWebGL } from '../webgl.js';
import { setFrameIdBase, takeFrame } from '../frame-store.js';
import type { GLAsk, TextAsk } from './workers.js';
import type { CanvasText } from '../canvas-text.js';

declare const AbortController: AbortControllerClass;
declare const performance: { now(): number };
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

const { parentPort, receiveMessageOnPort, workerData } =
  await nodeModule<WorkerThreadsModule>('worker_threads');

/** How long a worker's own code may run in one task. Longer than a page's:
 *  a worker is where a page puts work that takes a while, and its thread
 *  holds up nothing of the page's. */
const WORKER_TIMEOUT_MS = 30_000;
/** And how long a task may take at all, what its ops wait on included
 *  (`EngineOptions.ceiling`): twice it, where a page's is five times, since
 *  a worker's ops lay nothing out, and what one waits on is the network,
 *  an `importScripts`. */
const WORKER_CEILING_MS = 60_000;

const {
  init,
  userAgent,
  language,
  sync,
  flag,
  frozen,
  stopped,
  permissions,
  notifies,
  gpu,
  gpuLock,
  gpuInflight,
  born,
} = workerData as WorkerThreadData;
const port = parentPort!;
const word = new Int32Array(flag);
const tell = (message: FromWorker): void => port.postMessage(message);

// every module this thread starts with is in by here
tell({ kind: 'up' });

/** A worker has no `<Html>`: what a script could ask of a layout answers
 *  nothing. */
const NO_VIEW = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === 'scriptsUnblocked') return () => Promise.resolve();
      if (key === 'matchMedia') return () => false;
      if (
        typeof key === 'string' &&
        /^(document|base|title|activeElement)$/.test(key)
      ) {
        return null;
      }
      return () => null;
    },
  },
) as HtmlHandle;

const fetches = new Map<
  number,
  { resolve: (r: FetchResponse) => void; reject: (e: Error) => void }
>();
/** The bodies still arriving from the page process, by request. */
const bodies = new Map<number, ChunkQueue>();
let fetchSeq = 0;

/** A body the page process hands on a chunk at a time (`chunk`,
 *  `fetchEnd`), read as the host reads a network's. */
class ChunkQueue implements AsyncIterable<Uint8Array> {
  private _chunks: Uint8Array[] = [];
  private _waiting: ((r: IteratorResult<Uint8Array>) => void) | null = null;
  private _failing: ((e: Error) => void) | null = null;
  private _ended = false;
  private _error: Error | null = null;
  constructor(private readonly _id: number) {}
  push(bytes: Uint8Array): void {
    if (this._waiting) {
      const resolve = this._waiting;
      this._waiting = this._failing = null;
      resolve({ done: false, value: bytes });
    } else this._chunks.push(bytes);
  }
  end(error: string | null): void {
    this._ended = true;
    if (error) this._error = new TypeError(error);
    const resolve = this._waiting;
    const reject = this._failing;
    this._waiting = this._failing = null;
    if (this._error) reject?.(this._error);
    else resolve?.({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const chunk = this._chunks.shift();
        if (chunk) return Promise.resolve({ done: false, value: chunk });
        if (this._error) return Promise.reject(this._error);
        if (this._ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
          this._waiting = resolve;
          this._failing = reject;
        });
      },
      return: () => {
        if (bodies.delete(this._id)) tell({ kind: 'abort', id: this._id });
        this.end(null);
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

const fetchThrough = (
  request: FetchRequest,
  signal: AbortSignalLike,
): Promise<FetchResponse> =>
  new Promise((resolve, reject) => {
    const id = ++fetchSeq;
    fetches.set(id, { resolve, reject });
    tell({ kind: 'fetch', id, request });
    signal.addEventListener(
      'abort',
      () => {
        const body = bodies.get(id);
        if (body) {
          bodies.delete(id);
          tell({ kind: 'abort', id });
          body.end('The fetch was aborted.');
          return;
        }
        if (!fetches.delete(id)) return;
        tell({ kind: 'abort', id });
        reject(new TypeError('The fetch was aborted.'));
      },
      { once: true },
    );
  });

const log = (level: string, text: string): void =>
  tell({ kind: 'log', level, text });

// the page's secrets, and the first of them what this seals with
for (const secret of init.keySecrets) addKeySecret(secret);

/** The worker's WebTransport sessions, opened by the page process over the
 *  page's own seam (`transport-relay.ts`). */
const transports = new TransportProxy((m) => tell(m));
/** And its WebSockets (`socket-relay.ts`). */
const sockets = new SocketProxy((m) => tell(m));

/** Where each permission stands for the page, as the page last said: a read
 *  of one is at once, and an answer from across a thread cannot be. */
const permissionStates = new Map(Object.entries(permissions));
const permissionWatchers = new Set<(name: string) => void>();
const permissionsCopied: HtmlPermissions = {
  state: (name) =>
    (permissionStates.get(name) ?? 'denied') as HtmlPermissionState,
  // a window's alone (`Notification.requestPermission`)
  request: () => Promise.resolve('denied'),
  watch: (listener) => {
    permissionWatchers.add(listener);
    return () => permissionWatchers.delete(listener);
  },
};

/** A notification this worker made, on its way or showing. */
interface ShownHere {
  events: HtmlNotificationEvents;
  shown(handle: HtmlShownNotification): void;
  failed(reason: Error): void;
}
const showing = new Map<number, ShownHere>();
let nextShown = 1;
/** Its notifications are the page's to show (`PageWorkers._notification`). */
const notificationsThrough: HtmlNotifications = {
  show(notification, events) {
    return new Promise((resolve, reject) => {
      const id = nextShown;
      nextShown += 1;
      showing.set(id, {
        events,
        shown: resolve,
        failed: reject,
      });
      tell({ kind: 'notification', id, show: notification });
    });
  },
  focus: () => tell({ kind: 'notification', id: 0, focus: true }),
};
const heardNotification = (id: number, told: string): void => {
  const here = showing.get(id);
  if (!here) return;
  if (told === 'show') {
    here.shown({
      close: () => {
        showing.delete(id);
        tell({ kind: 'notification', id, close: true });
      },
    });
  } else if (told === 'click') {
    here.events.click();
  } else if (told === 'close') {
    showing.delete(id);
    here.events.close();
  } else {
    showing.delete(id);
    here.failed(new Error('the notification was not shown'));
  }
};

/** What this worker's `caches` asked, across the thread: its store is the
 *  page's. */
const cacheAsks = new Map<number, (answer: HtmlCacheAnswer) => void>();
let nextCacheAsk = 1;
const cachesThrough = (
  origin: string,
  ask: HtmlCacheAsk,
): Promise<HtmlCacheAnswer> =>
  new Promise((resolve) => {
    const id = nextCacheAsk;
    nextCacheAsk += 1;
    cacheAsks.set(id, resolve);
    tell({ kind: 'caches', id, origin, ask });
  });

const seams: HostSeams = {
  handle: new Proxy(NO_VIEW, {
    get: (target, key, receiver) =>
      key === 'canvasText'
        ? () => pageText()
        : Reflect.get(target, key, receiver),
  }),
  viewport: () => ({
    width: 0,
    height: 0,
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
    dpr: 1,
    left: 0,
    top: 0,
  }),
  scrollTo() {},
  navigate() {},
  reload() {},
  go() {},
  log,
  title() {},
  fetch: fetchThrough,
  webTransport: transports,
  webSocket: sockets,
  caches: cachesThrough,
  permissions: permissionsCopied,
  ...(notifies && { notifications: notificationsThrough }),
  userAgent,
  language,
  secureContext: init.secure,
};

/** What this thread's synchronous requests are numbered by, so that one a
 *  timeout gave up on answers nothing. */
let syncSeq = 0;
seams.fetchSync = (request, timeout) => {
  const id = ++syncSeq;
  sync.postMessage({ id, request });
  const end = performance.now() + timeout;
  const answer = waitFor(
    (m): m is { id: number; response?: FetchResponse; failed?: string } =>
      (m as { id?: number }).id === id,
    end,
  );
  if (!answer) {
    sync.postMessage({ id, abort: true });
    const error = new Error(`${request.url} took too long.`);
    error.name = 'TimeoutError';
    throw error;
  }
  if (answer.response) return answer.response;
  throw new Error(answer.failed ?? 'The request failed.');
};

/** The origin private file system's ops, which the page process holds
 *  (`opfs.ts`): a window and its workers have one store, and an access
 *  handle's reads are synchronous, so each is asked and slept on. */
seams.opfs = (origin, op, a, b, c) => {
  const id = ++syncSeq;
  sync.postMessage({ id, opfs: [origin, op, a, b, c] });
  const answer = waitFor(
    (m): m is { id: number; value?: Primitive; error?: [string, string] } =>
      (m as { id?: number }).id === id,
    performance.now() + 60_000,
  );
  if (!answer)
    throw new FsError('UnknownError', 'The file system did not answer.');
  if (answer.error) throw new FsError(answer.error[0], answer.error[1]);
  return answer.value;
};

/** The page's text engine, which a worker's canvases set their text in: a
 *  worker has none, and drawn with nothing a string was no ink and a guess at
 *  its width. Each ask is made of the page and slept on. Null where the page
 *  has no engine either, which leaves the text as it was. */
const pageText = (() => {
  const ask = (text: TextAsk): { value?: unknown; none?: true } => {
    const id = ++syncSeq;
    sync.postMessage({ id, text });
    const answer = waitFor(
      (m): m is { id: number; value?: unknown; none?: true; error?: string } =>
        (m as { id?: number }).id === id,
      performance.now() + 30_000,
    );
    if (!answer) throw new Error('The page did not answer.');
    if ('error' in answer && answer.error) throw new Error(answer.error);
    return answer;
  };
  let present: boolean | undefined;
  /** Whether the page has an engine, asked once. */
  const has = (): boolean => (present ??= !ask(['now']).none);
  const text = {
    get generation(): number {
      return (ask(['now']).value as [number, string])[0];
    },
    direction: (_element: unknown) =>
      (ask(['now']).value as [number, string])[1],
    font: (value: string, _element: unknown) => ask(['font', value]).value,
    measure: (font: string, string: string, setting: unknown) =>
      ask(['measure', font, string, setting as never]).value,
    raster: (
      font: string,
      string: string,
      size: number,
      setting: unknown,
      stroke: number,
    ) => ask(['raster', font, string, size, setting as never, stroke]).value,
  };
  return (): CanvasText | null =>
    has() ? (text as unknown as CanvasText) : null;
})();

/** The page's GPU, which a worker's WebGL contexts draw through
 *  (`HtmlWebGL`): each call is asked of the page process and slept on, since
 *  `getError` and `readPixels` answer at once. A page with no GPU answers
 *  `open` with null, and the context draws nothing. */
seams.webgl = ((): HtmlWebGL => {
  const ask = (gl: GLAsk) => {
    const id = ++syncSeq;
    sync.postMessage({ id, gl });
    const answer = waitFor(
      (
        m,
      ): m is {
        id: number;
        value?: unknown;
        frame?: Uint8ClampedArray;
        error?: string;
      } => (m as { id?: number }).id === id,
      performance.now() + 30_000,
    );
    if (!answer) throw new Error('The GPU did not answer.');
    if (answer.error) throw new Error(answer.error);
    return answer;
  };
  return {
    open(options: HtmlGLOptions) {
      const opened = ask(['open', options]).value as {
        ctx: number;
        extensions: string[];
      } | null;
      if (!opened) return null;
      const { ctx } = opened;
      // batches posted and not waited for, and how many the page has not
      // got to: past a few it is asked to catch up, since a thread that
      // draws without end would otherwise queue without end
      let posted = 0;
      return {
        extensions: opened.extensions,
        run: (commands) => ask(['run', ctx, commands]).value,
        post: (commands) => {
          sync.postMessage({ id: 0, gl: ['run', ctx, commands], quiet: true });
          posted += 1;
          if (posted >= 64) {
            posted = 0;
            ask(['sync']);
          }
        },
        resize: (width, height) => void ask(['resize', ctx, width, height]),
        present: (into) => {
          const { frame } = ask(['present', ctx, into.length]);
          if (frame) into.set(frame);
        },
        snapshot: () =>
          (ask(['snapshot', ctx]).value as {
            id: number;
            width: number;
            height: number;
          } | null) ?? null,
        discard: (id) => void ask(['discard', ctx, id]),
        frameData: (id) => ask(['frame', ctx, id]).frame ?? null,
        dispose: () => void ask(['dispose', ctx]),
      };
    },
  };
})();

/** A GPU of this thread's own, where the page has one and this thread can
 *  reach it: a glass panel's frames are drawn here, in parallel with the
 *  page, where they were each a request the page's thread ran between its own
 *  tasks (`PageWorkers._gl`) — most of its time under a scroll. What the
 *  page process shows of one is moved to it a frame at a time
 *  (`shipFrame`). Where there is none, the page's GPU is the one above. */
const localGpu = gpu ? await gpuWebGL() : null;
const localContexts = new Set<HtmlGLContext>();
const inflight = new Int32Array(gpuInflight);
if (localGpu) {
  useGpuLock(gpuLock);
  // two threads' frame numbers must not meet in the page process
  setFrameIdBase((1 + Math.floor(Math.random() * 1_000_000)) * 1_000_000_000);
  let told = false;
  seams.webgl = {
    open(options: HtmlGLOptions) {
      const context = localGpu.open(options);
      if (!context) return null;
      if (!told) {
        told = true;
        tell({ kind: 'gpu' });
      }
      localContexts.add(context);
      const dispose = context.dispose.bind(context);
      context.dispose = () => {
        localContexts.delete(context);
        dispose();
      };
      return context;
    },
  };
  seams.shipFrame = (id) => {
    const frame = takeFrame(id);
    if (!frame) return;
    const { width, height } = frame;
    const data =
      frame.data.byteOffset === 0 &&
      frame.data.byteLength === frame.data.buffer.byteLength
        ? frame.data
        : new Uint8ClampedArray(frame.data);
    Atomics.add(inflight, 0, 1);
    port.postMessage({ kind: 'gpuFrame', id, width, height, data }, [
      data.buffer,
    ]);
  };
  // frames are made no faster than the page takes them: a page busy with a
  // scroll or a resize held two of them, and a thread drawing sixty a second
  // behind it held a second of 13 MB frames in its queue, which is the memory
  // a long scroll ran out of. A page that takes none for a while is not
  // waited for, since a frame nobody wants is let go with its canvas.
  let busySince = 0;
  seams.frameBusy = () => {
    if (Atomics.load(inflight, 0) < 2) {
      busySince = 0;
      return false;
    }
    const t = performance.now();
    if (!busySince) busySince = t;
    return t - busySince < 500;
  };
}

/**
 * The page's answer this thread is asleep for, or undefined where `end` came
 * first. Every answer that came is read at each wake, and the flag cleared
 * before they are: one a timeout gave up on answers late, and read alone it
 * left the answer behind it unread with the flag down, so the thread slept
 * through it to the end of its time.
 */
function waitFor<T>(
  wanted: (message: unknown) => message is T,
  end: number,
): T | undefined {
  for (;;) {
    Atomics.store(word, 0, 0);
    for (
      let got = receiveMessageOnPort(sync);
      got;
      got = receiveMessageOnPort(sync)
    ) {
      if (wanted(got.message)) return got.message;
    }
    const left = end - performance.now();
    if (left <= 0) return undefined;
    Atomics.wait(word, 0, 0, left);
  }
}

const host = new DomHost(new Document([]), seams, init.url);
// a blob URL's script has no response to say a policy, and has its owner's
host.referrerPolicy = referrerPolicyOf(init.referrerPolicy);
// and its policies, which one fetched has from its response's headers
// instead (`importScript`)
if (/^(blob|data):/i.test(init.url)) host.csp.addHeaders(init.csp ?? []);
// and its owner's insecure requests policy, whatever its own says
host.csp.upgradeInherited = !!init.upgrades;
/** What the worker's own script is to Fetch (HTML 10.2.5.1). */
const OWN_SCRIPT = {
  destination: init.service
    ? 'serviceworker'
    : init.shared
      ? 'sharedworker'
      : 'worker',
  mode: init.type === 'module' ? 'cors' : 'same-origin',
  // a module worker's own script with the credentials its options name
  ...(init.type === 'module' && init.credentials
    ? { credentials: init.credentials }
    : {}),
} as const;
/** Where the last script `importScript` asked for came from, after its
 *  redirects (`WorkerScope.importedUrl`). */
let importedFrom = '';
const importScript = (
  url: string,
  type?: ValueModule,
  own = false,
): string | null => {
  importedFrom = url;
  // an import is held to the worker's own policies (CSP 3, 4.1.2): its own
  // script was held to its owner's as it was asked for
  if (!own && !host.csp.request({ url, destination: type ? type : 'script' })) {
    return null;
  }
  sync.postMessage({
    url,
    ...(type ? { type } : {}),
    ...(own ? OWN_SCRIPT : {}),
  });
  const answer = waitFor(
    (
      m,
    ): m is {
      source: string | null;
      policy?: string;
      csp?: [string, string][];
      url?: string;
    } => !('id' in (m as object)),
    performance.now() + 60_000,
  );
  if (answer?.url) importedFrom = answer.url;
  // what the worker's own script's response says its requests' referrers
  // are made under, and its Content Security Policies, which an import's
  // has no say in
  if (own) {
    host.referrerPolicy = referrerPolicyOf(answer?.policy);
    if (!/^(blob|data):/i.test(url)) host.csp.addHeaders(answer?.csp ?? []);
  }
  return answer?.source ?? null;
};
host.workerScope = {
  post: (data) => tell({ kind: 'message', data }),
  close: () => tell({ kind: 'close' }),
  importScript,
  importedUrl: () => importedFrom,
  error: (message, filename, line, column, failed) =>
    tell({
      kind: 'error',
      message,
      filename,
      line,
      column,
      ...(failed && { failed: true }),
    }),
  rtc: (message) => tell(message),
  service: (text, bytes) =>
    tell({ kind: 'service', text, ...(bytes ? { bytes } : {}) }),
};
const engine = new ScriptEngine(host.bridge, {
  worker: true,
  timeout: WORKER_TIMEOUT_MS,
  ceiling: WORKER_CEILING_MS,
  cssModules: false,
  onTimeout: () =>
    log('error', 'A script in a worker ran too long, and was stopped.'),
  log,
  settled: () => host.flush(),
  load: async (url, type, dynamic) => {
    // a service worker's modules are those it was installed with, as its
    // `importScripts` are
    if (init.service) {
      return importScript(url, type === 'javascript' ? undefined : type);
    }
    // a graph an `import()` started is the worker's own to fetch, a `script`
    // held to its own policies' `script-src` (HTML's HostLoadImportedModule,
    // with no load state), where the worker's own graph is fetched under the
    // document that started it and held to its `worker-src`: vscode.dev's
    // extension host, a module worker made of a blob in a frame whose
    // `child-src` is its own origin's, imports its code from a CDN its
    // `script-src` names, and was refused
    const destination =
      type !== 'javascript'
        ? type
        : dynamic
          ? 'script'
          : OWN_SCRIPT.destination;
    if (dynamic && !host.csp.request({ url, destination })) return null;
    try {
      const response = await fetchThrough(
        {
          url,
          method: 'GET',
          headers:
            type === 'javascript' ? [] : [['accept', MODULE_ACCEPT[type]]],
          body: null,
          // a module worker's graph is fetched for the worker (HTML 8.1.5.1,
          // "fetch a module worker script graph"), a JSON or text one as such
          mode: 'cors',
          credentials: init.credentials ?? 'same-origin',
          destination,
        },
        new AbortController().signal,
      );
      if (response.status < 200 || response.status >= 300) return null;
      // a module's exports are its importer's to read, so another origin's
      // has to say so, wherever its address came to
      const judged = judgeScript(
        {
          // a JSON or a text module is UTF-8, whatever the response names
          text:
            type !== 'javascript' && response.bytes
              ? new TextDecoder().decode(response.bytes)
              : response.body,
          url: response.url || url,
          headers: response.headers,
        },
        url,
        host.origin,
        'anonymous',
        true,
        type,
      );
      return judged && judged.text;
    } catch {
      return null;
    }
  },
  base: () => host.url,
  // a service worker imports nothing with `import()` (HTML's
  // HostLoadImportedModule)
  dynamicImport: !init.service,
});
host.entries = engine;
// a dedicated or a shared worker's own workers (HTML 10.2.6.3, `Worker`
// being `[Exposed=(Window,DedicatedWorker,SharedWorker)]`): threads of the
// page's process, as its are, asked for and told of across this one's
// channel
if (!init.service) {
  let children = 0;
  host.workers = {
    start(child) {
      const id = ++children;
      tell({ kind: 'nested', op: 'start', child: id, init: child });
      return id;
    },
    refuse: () => ++children,
    post(id, data) {
      tell({ kind: 'nested', op: 'post', child: id, data });
    },
    end(id) {
      tell({ kind: 'nested', op: 'end', child: id });
    },
  };
}
engine.call('__becomeWorker', {
  url: init.url,
  name: init.name,
  shared: !!init.shared,
  service: init.service ?? null,
  born,
});

/** The worker's script, where it has yet to run. */
let script: (() => void) | null = null;
const runScript = (): void => {
  const run = script;
  script = null;
  run?.();
};

/**
 * The worker stops with its document, while the back-forward cache keeps it,
 * and goes on from there as it is shown again (`PageWorkers.freeze`). A
 * script that waited runs before what was held behind it, some of which it
 * may be there to hear, as it would have run before any of that reached it.
 */
const followPage = (): void => {
  const kept = Atomics.load(new Int32Array(frozen), 0) === 1;
  if (kept === engine.frozen) {
    if (!kept) runScript();
    return;
  }
  if (kept) engine.freeze();
  else engine.thaw(runScript);
  Atomics.add(new Int32Array(stopped), 0, kept ? 1 : -1);
};

/**
 * What was posted to a module worker before its script ran, held until it
 * has (HTML 10.2.4, "run a worker": the port's message queue is enabled
 * after the script runs). A classic script runs before any message is read;
 * a module's graph is fetched first, and a shared worker's `connect` heard
 * in the meantime reached no `onconnect` the module had yet to set.
 */
let unheard: unknown[] | null = init.type === 'module' ? [] : null;
const hearHeld = (): void => {
  const held = unheard;
  unheard = null;
  for (const data of held ?? []) engine.call('__workerMessage', [0, data]);
};

port.on('message', (m: ToWorker) => {
  if (m.kind === 'releaseGpu') {
    for (const context of [...localContexts]) context.dispose();
    tell({ kind: 'gpuGone' });
  } else if (m.kind === 'message') {
    if (unheard) unheard.push(m.data);
    else engine.call('__workerMessage', [0, m.data]);
  } else if (m.kind === 'service') {
    engine.call('__sw', [m.text]);
    engine.call('__swDispatched', null);
  } else if (m.kind === 'caches') {
    cacheAsks.get(m.id)?.(m.answer);
    cacheAsks.delete(m.id);
  } else if (m.kind === 'permission') {
    permissionStates.set(m.name, m.state);
    for (const listener of permissionWatchers) listener(m.name);
  } else if (m.kind === 'notification') {
    heardNotification(m.id, m.told);
  } else if (m.kind === 'suspended') {
    followPage();
  } else if (m.kind === 'fetched') {
    const pending = fetches.get(m.id);
    if (!pending) return;
    fetches.delete(m.id);
    if (!m.response) {
      pending.reject(new TypeError(m.error ?? 'Failed to fetch'));
      return;
    }
    const { streaming, ...response } = m.response;
    if (streaming) {
      const chunks = new ChunkQueue(m.id);
      bodies.set(m.id, chunks);
      pending.resolve({ ...response, chunks });
    } else pending.resolve(response);
  } else if (m.kind === 'chunk') {
    bodies.get(m.id)?.push(m.bytes);
  } else if (m.kind === 'fetchEnd') {
    const body = bodies.get(m.id);
    bodies.delete(m.id);
    body?.end(m.error);
  } else if (m.kind === 'wt') {
    transports.heard(m);
  } else if (m.kind === 'ws') {
    sockets.heard(m);
  } else if (m.kind === 'rtc') {
    host.rtcHeard(m);
  } else if (m.kind === 'nested') {
    // what this worker's own `Worker` said, by the number it knows it by
    if (m.op === 'message') engine.call('__workerMessage', [m.child, m.data]);
    else {
      engine.call('__workerError', [
        m.child,
        m.message,
        m.filename,
        m.line,
        m.column,
      ]);
    }
  }
});

// the worker's script: handed over where it is a blob URL's, and fetched
// where it is not
const source = init.source ?? importScript(init.url, undefined, true);
// the worker is at the URL its script came from, after its redirects (HTML
// 10.2.4, "run a worker", step 12.4): its `location`, and what its
// requests and imports resolve against
// A response's URL has no fragment, and the request's goes with it to where
// it landed, as Fetch carries it across a redirect (4.4, "HTTP-redirect
// fetch", step 12)
const withFragment = (url: string): string => {
  const hash = init.url.indexOf('#');
  return hash < 0 || url.includes('#') ? url : url + init.url.slice(hash);
};
const at =
  init.source === null && source !== null && importedFrom
    ? withFragment(importedFrom)
    : init.url;
if (at && at !== init.url) {
  host.url = at;
  engine.call('__workerUrl', [at]);
}
script = () => {
  // a script that did not come, or did not parse, is a plain `error` at the
  // `Worker`, and nothing at this global (HTML 10.2.4, "run a worker")
  const failed = (why: string): void =>
    host.workerScope!.error(why, init.url, 0, 0, true);
  if (source === null) {
    failed(`The worker's script at ${init.url} could not be loaded.`);
    if (init.service) engine.call('__serviceStarted', [false]);
    hearHeld();
  } else if (init.type === 'module') {
    void engine
      .module(source, at || init.url, init.source === null, true)
      .then((ran) => {
        // one whose graph did not all come, or did not parse or link, is its
        // worker's `error`, as one whose script did not
        if (ran === 'unfetched' || ran === 'unparsed') {
          failed(
            `The worker's module script at ${init.url}, or one it imports, could not be loaded or parsed.`,
          );
        }
        if (init.service) engine.call('__serviceStarted', [ran === 'ran']);
        hearHeld();
      });
  } else {
    const ran = engine.exec(source, at || init.url, 0, false, null, () =>
      failed(`The worker's script at ${init.url} did not parse.`),
    );
    // its registry goes on from here (Service Workers 1, "Run Service Worker")
    if (init.service) engine.call('__serviceStarted', [ran]);
  }
};
// its page may have been left while this thread was starting
followPage();
