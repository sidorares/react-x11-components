// A page's synchronous `XMLHttpRequest`, for the page's own thread.
//
// A page runs on the thread its network does, and a request needs that thread
// to come back: nothing in JavaScript waits for a promise. So the request is
// made on a thread of its own (`sync-fetch-thread.ts`) and this one sleeps on a
// shared word until the answer is posted, or until `timeout` is up. While it
// sleeps nothing of this process runs, no timer and no paint, which is what a
// synchronous request has always meant, and why it has a bound.
//
// `HtmlNetwork` cannot cross a thread. What can is what makes it what it is:
// its options, and its cookies, which go over with each request and come back
// with what became of them (`HtmlSyncNetwork`). A network whose transport is a
// host's function has no such form, and answers null: its pages keep the error
// a synchronous request always had. Nothing the page's thread would have to run
// can be reached from here, which is to say a service worker: its registry is
// on this thread, and its own requests come back to it. A controlled page's
// synchronous request goes to the network, which `docs/components/html.md` says.
//
// A web worker needs none of this: it is the thread that sleeps, and the
// page's network is awake to answer it (`workers.ts`).
import type { HtmlCookie } from '../cookies.js';
import type { HtmlNetworkOptions, HtmlSyncNetwork } from '../network.js';
import type { FetchRequest, FetchResponse } from './host.js';
import { nodeModule, threadEntry } from './platform.js';
import type {
  MessagePortLike,
  WorkerLike,
  WorkerThreadsModule,
} from './platform.js';

declare const performance: { now(): number };

const { MessageChannel, Worker, receiveMessageOnPort } =
  await nodeModule<WorkerThreadsModule>('worker_threads');

const ENTRY = threadEntry(
  (import.meta as { url: string }).url,
  'sync-fetch-thread',
);

/** What a thread is started with. */
export interface SyncFetchData {
  port: MessagePortLike;
  flag: SharedArrayBuffer;
  /** A module to import first (`HtmlNetworkOptions.threadSetup`). */
  setup?: string;
}

/** A request, and the network to make it through. */
export interface SyncJob {
  id: number;
  request: FetchRequest;
  page: string;
  options: Partial<HtmlNetworkOptions>;
  /** The page's cookies now, where it has a jar. */
  cookies: HtmlCookie[] | null;
  publicSuffix: boolean;
}

/** What came of a job. */
export interface SyncAnswer {
  id: number;
  answer?: {
    url: string;
    status: number;
    statusText: string;
    redirected: boolean;
    headers: [string, string][];
    bytes: Uint8Array;
  };
  failed?: string;
  /** What the request did to the copy of the jar. */
  put?: HtmlCookie[];
  gone?: HtmlCookie[];
}

interface Line {
  thread: WorkerLike;
  port: MessagePortLike;
  word: Int32Array;
}

/** The thread, one a process and by the setup it was started with, kept for
 *  the next request: starting one is some 50 ms a page would wait each time. */
const lines = new Map<string, Line>();
let serial = 0;

function lineFor(setup: string | undefined): Line {
  const key = setup ?? '';
  let line = lines.get(key);
  if (line) return line;
  const { port1, port2 } = new MessageChannel();
  const flag = new SharedArrayBuffer(4);
  const source = ENTRY();
  const data: SyncFetchData = { port: port2, flag, ...(setup && { setup }) };
  const thread = new Worker(source, {
    workerData: data,
    transferList: [port2],
    name: 'synchronous requests',
    eval: typeof source === 'string',
  });
  // it holds no process open, and goes with it
  thread.unref();
  port1.unref?.();
  line = { thread, port: port1, word: new Int32Array(flag) };
  thread.on('error', () => lines.delete(key));
  thread.on('exit', () => lines.delete(key));
  lines.set(key, line);
  return line;
}

/**
 * `request` through `network`, as `page`, with this thread asleep for at most
 * `timeout` ms: its response with the bytes whole, or a throw, a `TimeoutError`
 * by name where the time ran out. What it did to the page's cookies is theirs
 * before this returns, as a request's are by the time its answer is read.
 */
export function fetchSync(
  network: HtmlSyncNetwork,
  request: FetchRequest,
  page: string,
  timeout: number,
): FetchResponse {
  const jar = network.cookies;
  const id = ++serial;
  const line = lineFor(network.setup);
  const job: SyncJob = {
    id,
    request,
    page,
    options: network.options,
    cookies: jar ? jar.all() : null,
    publicSuffix: network.publicSuffix,
  };
  line.port.postMessage(job);
  const end = performance.now() + timeout;
  let answer: SyncAnswer | undefined;
  for (;;) {
    // the flag down before what came is read, so that an answer that comes
    // after the read finds it up and wakes the wait at once: one a timeout
    // gave up on may answer late, and is let go
    Atomics.store(line.word, 0, 0);
    for (
      let got = receiveMessageOnPort(line.port);
      got;
      got = receiveMessageOnPort(line.port)
    ) {
      const message = got.message as SyncAnswer;
      if (message.id === id) answer = message;
    }
    if (answer) break;
    const left = end - performance.now();
    if (left <= 0) {
      line.port.postMessage({ abort: id });
      const error = new Error(`${request.url} took too long.`);
      error.name = 'TimeoutError';
      throw error;
    }
    Atomics.wait(line.word, 0, 0, left);
  }
  if (answer.failed !== undefined || !answer.answer) {
    throw new Error(answer.failed ?? 'The request failed.');
  }
  if (jar && (answer.put?.length || answer.gone?.length)) {
    jar.take(answer.put ?? [], answer.gone ?? []);
  }
  return { ...answer.answer, body: '' };
}
