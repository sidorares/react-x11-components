// The thread a page's synchronous requests are made on (`sync-fetch.ts`).
//
// A page shares its thread with its network, so while it waits for a
// synchronous `XMLHttpRequest` nothing of that network can run. This is a
// network that can: an `HtmlNetwork` made here from what the page's says of
// itself, over a cookie jar that holds what the page's held as the request
// was made. Its request is `HtmlNetwork.request`, so its headers, its redirects
// and what it does with cookies are the same code as every other request's.
// What the jar came to goes back with the answer.
import { CookieJar, publicSuffixList } from '../cookies.js';
import type { HtmlCookie, HtmlCookieStore } from '../cookies.js';
import { HtmlNetwork } from '../network.js';
import { nodeModule } from './platform.js';
import type { AbortControllerClass, WorkerThreadsModule } from './platform.js';
import type { SyncFetchData, SyncJob, SyncAnswer } from './sync-fetch.js';

declare const AbortController: AbortControllerClass;

const { workerData } = await nodeModule<WorkerThreadsModule>('worker_threads');
const { port, flag, setup } = workerData as SyncFetchData;
// what a host wants done on a thread it does not otherwise reach
if (setup) await import(/* @vite-ignore */ setup);
const word = new Int32Array(flag);

/** The request under way, which an abort ends. */
let running: {
  id: number;
  controller: InstanceType<AbortControllerClass>;
} | null = null;

/** A jar's store over a copy of the page's cookies, keeping what changes. */
class CopiedCookies implements HtmlCookieStore {
  readonly put_: HtmlCookie[] = [];
  readonly gone: HtmlCookie[] = [];
  constructor(private readonly _cookies: HtmlCookie[]) {}
  load(): HtmlCookie[] {
    return this._cookies;
  }
  put(cookie: HtmlCookie): void {
    this.put_.push({ ...cookie });
  }
  delete(cookie: HtmlCookie): void {
    this.gone.push({ ...cookie });
  }
}

async function run(job: SyncJob): Promise<SyncAnswer> {
  const controller = new AbortController();
  running = { id: job.id, controller };
  const store = job.cookies ? new CopiedCookies(job.cookies) : null;
  const suffix = store && job.publicSuffix ? await publicSuffixList() : null;
  const cookies = store
    ? new CookieJar({ store, ...(suffix && { publicSuffix: suffix }) })
    : undefined;
  const network = new HtmlNetwork({
    ...job.options,
    ...(cookies && { cookies }),
  });
  try {
    const {
      charset: _charset,
      chunks: _chunks,
      ...answer
    } = await network.request(job.request, job.page, controller.signal);
    return {
      id: job.id,
      answer,
      ...(store && { put: store.put_, gone: store.gone }),
    };
  } catch (error) {
    return { id: job.id, failed: String((error as Error)?.message ?? error) };
  }
}

port.on('message', (message: unknown) => {
  const m = message as SyncJob | { abort: number };
  if ('abort' in m) {
    if (running?.id === m.abort) running.controller.abort();
    return;
  }
  void run(m).then((answer) => {
    if (running?.id === answer.id) running = null;
    const bytes = answer.answer?.bytes;
    port.postMessage(answer, bytes ? [bytes.buffer as ArrayBuffer] : []);
    Atomics.store(word, 0, answer.id);
    Atomics.notify(word, 0);
  });
});
