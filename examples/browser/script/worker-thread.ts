// A dedicated worker's thread (`workers.ts`): a script engine and a host of
// its own over an empty document, the facade made a worker's global
// (`__becomeWorker`), and the worker's script run in it. What the page
// posts arrives as text and is made again here; what this posts, and what
// it fetches, goes to the page process, whose network the browser's policy
// is kept by.
import {
  parentPort,
  receiveMessageOnPort,
  workerData,
} from 'node:worker_threads';
import { Document } from 'domhandler';

import type { HtmlHandle } from '../../../src/html/index.js';
import { ScriptEngine } from './engine.js';
import { DomHost } from './host.js';
import type { FetchRequest, FetchResponse, HostSeams } from './host.js';
import type { FromWorker, ToWorker, WorkerThreadData } from './workers.js';

/** How long one entry into a worker may run. Longer than a page's: a
 *  worker is where a page puts work that takes a while, and its thread
 *  holds up nothing of the page's. */
const WORKER_TIMEOUT_MS = 30_000;

const { init, userAgent, language, sync, flag } =
  workerData as WorkerThreadData;
const port = parentPort!;
const word = new Int32Array(flag);
const tell = (message: FromWorker): void => port.postMessage(message);

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
let fetchSeq = 0;
const fetchThrough = (
  request: FetchRequest,
  signal: AbortSignal,
): Promise<FetchResponse> =>
  new Promise((resolve, reject) => {
    const id = ++fetchSeq;
    fetches.set(id, { resolve, reject });
    tell({ kind: 'fetch', id, request });
    signal.addEventListener(
      'abort',
      () => {
        if (!fetches.delete(id)) return;
        tell({ kind: 'abort', id });
        reject(new TypeError('The fetch was aborted.'));
      },
      { once: true },
    );
  });

const log = (level: string, text: string): void =>
  tell({ kind: 'log', level, text });

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
  userAgent,
  language,
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
};
const engine = new ScriptEngine(host.bridge, {
  timeout: WORKER_TIMEOUT_MS,
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
engine.call('__becomeWorker', { url: init.url, name: init.name });

port.on('message', (m: ToWorker) => {
  if (m.kind === 'message') {
    engine.call('__workerMessage', [0, m.data]);
  } else if (m.kind === 'fetched') {
    const pending = fetches.get(m.id);
    if (!pending) return;
    fetches.delete(m.id);
    if (m.response) pending.resolve(m.response);
    else pending.reject(new TypeError(m.error ?? 'Failed to fetch'));
  }
});

// the worker's script: handed over where it is a blob URL's, and fetched
// where it is not
const source = init.source ?? importScript(init.url);
if (source === null) {
  host.workerScope.error(
    `The worker's script at ${init.url} could not be loaded.`,
    init.url,
    0,
    0,
  );
} else if (init.type === 'module') {
  void engine.module(source, init.url, init.source === null);
} else {
  engine.exec(source, init.url, 0);
}
