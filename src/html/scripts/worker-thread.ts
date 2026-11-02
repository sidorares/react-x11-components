// A dedicated worker's thread (`workers.ts`): a script engine and a host of
// its own over an empty document, the facade made a worker's global
// (`__becomeWorker`), and the worker's script run in it. What the page
// posts arrives as text and is made again here; what this posts, and what
// it fetches, goes to the page process, whose network the browser's policy
// is kept by.
import { Document } from 'domhandler';

import type { HtmlHandle } from '../index.js';
import { ScriptEngine } from './engine.js';
import { DomHost } from './host.js';
import type { FetchRequest, FetchResponse, HostSeams } from './host.js';
import type { FromWorker, ToWorker, WorkerThreadData } from './workers.js';
import { TransportProxy } from './transport-relay.js';
import { SocketProxy } from './socket-relay.js';
import { addKeySecret } from './subtle.js';
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

declare const AbortController: AbortControllerClass;

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

const seams: HostSeams = {
  handle: NO_VIEW,
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
  permissions: permissionsCopied,
  ...(notifies && { notifications: notificationsThrough }),
  userAgent,
  language,
  secureContext: init.secure,
};

const host = new DomHost(new Document([]), seams, init.url);
const importScript = (url: string): string | null => {
  Atomics.store(word, 0, 0);
  sync.postMessage({ url });
  Atomics.wait(word, 0, 0, 60_000);
  const answer = receiveMessageOnPort(sync)?.message as
    { source: string | null } | undefined;
  return answer?.source ?? null;
};
host.workerScope = {
  post: (data) => tell({ kind: 'message', data }),
  close: () => tell({ kind: 'close' }),
  importScript,
  error: (message, filename, line, column) =>
    tell({ kind: 'error', message, filename, line, column }),
  rtc: (message) => tell(message),
};
const engine = new ScriptEngine(host.bridge, {
  timeout: WORKER_TIMEOUT_MS,
  ceiling: WORKER_CEILING_MS,
  onTimeout: () =>
    log('error', 'A script in a worker ran too long, and was stopped.'),
  log,
  settled: () => host.flush(),
  load: async (url) => {
    try {
      const response = await fetchThrough(
        { url, method: 'GET', headers: [], body: null },
        new AbortController().signal,
      );
      return response.status >= 200 && response.status < 300
        ? response.body
        : null;
    } catch {
      return null;
    }
  },
  base: () => host.url,
});
host.entries = engine;
engine.call('__becomeWorker', {
  url: init.url,
  name: init.name,
  shared: !!init.shared,
  service: init.service ?? null,
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

port.on('message', (m: ToWorker) => {
  if (m.kind === 'message') {
    engine.call('__workerMessage', [0, m.data]);
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
  }
});

// the worker's script: handed over where it is a blob URL's, and fetched
// where it is not
const source = init.source ?? importScript(init.url);
script = () => {
  if (source === null) {
    host.workerScope!.error(
      `The worker's script at ${init.url} could not be loaded.`,
      init.url,
      0,
      0,
    );
    if (init.service) engine.call('__serviceInstall', [false]);
  } else if (init.type === 'module') {
    void engine.module(source, init.url, init.source === null).then((ran) => {
      if (init.service) engine.call('__serviceInstall', [ran]);
    });
  } else {
    const ran = engine.exec(source, init.url, 0);
    // a service worker is installed once its script has run (Service
    // Workers 1, "Install")
    if (init.service) engine.call('__serviceInstall', [ran]);
  }
};
// its page may have been left while this thread was starting
followPage();
