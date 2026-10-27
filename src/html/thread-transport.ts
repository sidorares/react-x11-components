// A transport (`HtmlTransport`) that makes its requests on a thread of its
// own: the runtime's `fetch`, as `HtmlNetwork` makes them with none given,
// run on a worker, the response's head and then its body handed back.
//
// What it is for is the event loop. A response's body comes off its socket
// on the thread that asked for it, a read at a time, and the thread that
// asks in an application is the one that lays out, paints and runs the
// page's scripts: under a page that keeps it busy, each read waits for a
// turn, the socket's buffer fills, and the server is held to it. Babel's
// 2.3 MB, which a frame on joshwcomeau.com loads before it says it is
// ready, came in 2.5 s on the page's thread and 0.27 s on a worker's.
//
// Opt-in: a host hands it to `HtmlNetwork({ fetch: threadTransport() })`.
// Not the default, since a thread is the process's, and a test that stands
// in for `globalThis.fetch` would not reach one.
import type { HtmlTransport } from './network.js';
import { nodeModule } from './scripts/platform.js';
import type { WorkerLike, WorkerThreadsModule } from './scripts/platform.js';

declare const DOMException: new (message: string, name: string) => Error;

type ResponseLike = Awaited<ReturnType<HtmlTransport>>;

/** What `threadTransport` is made with. */
export interface ThreadTransportOptions {
  /**
   * How long a connection may take to come up before the next address is
   * tried, in milliseconds (`net.setDefaultAutoSelectFamilyAttemptTimeout`,
   * on the thread): as `HtmlNetworkOptions.connectTimeout`, which a network
   * given a transport leaves to it. Default 2500; null leaves Node's alone.
   */
  connectTimeout?: number | null;
}

/** How far the thread reads a body ahead of what has been read of it, in
 *  bytes, before it waits: a stream nobody reads to its end — a video's,
 *  read as far as its head — is not read whole into the process. */
const AHEAD = 4 << 20;

/**
 * The thread, as source: a worker run with `eval`, which Node and Bun both
 * take, so no file has to be found beside this module in whatever bundle
 * it is in. Messages in: `fetch`, `abort`, `read` (bytes read of a body,
 * which lets the thread read on) and `cancel`. Messages out: `head`, then
 * `chunk`s, then `end` — or `error`, for a request or a body that failed.
 */
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
if (workerData.connectTimeout !== null) {
  try {
    require('node:net').setDefaultAutoSelectFamilyAttemptTimeout?.(
      workerData.connectTimeout,
    );
  } catch {}
}
const AHEAD = ${AHEAD};
const live = new Map();
parentPort.on('message', (m) => {
  if (m.kind === 'fetch') {
    run(m);
    return;
  }
  const call = live.get(m.id);
  if (!call) return;
  if (m.kind === 'read') {
    call.ahead -= m.bytes;
    if (call.ahead < AHEAD) wake(call);
  } else {
    call.controller.abort();
    wake(call);
  }
});
function wake(call) {
  const w = call.wake;
  call.wake = null;
  if (w) w();
}
async function run(m) {
  const call = { controller: new AbortController(), ahead: 0, wake: null };
  live.set(m.id, call);
  try {
    const init = {
      method: m.method,
      headers: m.headers,
      redirect: m.redirect,
      signal: call.controller.signal,
    };
    if (m.body !== undefined && m.streamedBody) {
      // a page's stream goes as a stream, its length known, as the
      // network's own does it: Node's fetch sends bytes again on a new
      // connection when a 421 answers them, and a stream never
      const bytes =
        typeof m.body === 'string' ? new TextEncoder().encode(m.body) : m.body;
      init.headers = { ...m.headers, 'content-length': String(bytes.length) };
      init.body = new ReadableStream({
        start(c) {
          if (bytes.length) c.enqueue(bytes);
          c.close();
        },
      });
      init.duplex = 'half';
    } else if (m.body !== undefined) init.body = m.body;
    const response = await fetch(m.url, init);
    parentPort.postMessage({
      kind: 'head',
      id: m.id,
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      redirected: response.redirected,
      headers: [...response.headers.entries()],
      cookies: response.headers.getSetCookie
        ? response.headers.getSetCookie()
        : null,
      body: response.body !== null,
    });
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        while (call.ahead >= AHEAD && !call.controller.signal.aborted) {
          await new Promise((w) => (call.wake = w));
        }
        if (call.controller.signal.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value.slice();
        call.ahead += bytes.byteLength;
        parentPort.postMessage({ kind: 'chunk', id: m.id, bytes }, [
          bytes.buffer,
        ]);
      }
    }
    parentPort.postMessage({ kind: 'end', id: m.id });
  } catch (e) {
    const cause = e && e.cause;
    parentPort.postMessage({
      kind: 'error',
      id: m.id,
      name: e && e.name,
      message: String((e && e.message) || e),
      code: cause && cause.code,
      errors: !!(cause && Array.isArray(cause.errors)),
    });
  } finally {
    live.delete(m.id);
  }
}
`;

type FromThread =
  | {
      kind: 'head';
      id: number;
      url: string;
      status: number;
      statusText: string;
      redirected: boolean;
      headers: [string, string][];
      cookies: string[] | null;
      body: boolean;
    }
  | { kind: 'chunk'; id: number; bytes: Uint8Array }
  | { kind: 'end'; id: number }
  | {
      kind: 'error';
      id: number;
      name?: string;
      message: string;
      code?: string;
      errors: boolean;
    };

/** One request on its way, or its body being read. */
interface Call {
  answer(response: ResponseLike): void;
  fail(error: unknown): void;
  /** The body's chunks the thread sent and nobody read yet. */
  chunks: Uint8Array[];
  /** A read waiting for a chunk, the end or a failure. */
  waiting: {
    resolve(r: { done: boolean; value?: Uint8Array }): void;
    reject(error: unknown): void;
  } | null;
  ended: boolean;
  error: unknown;
  /** Let go of the request's signal. */
  done(): void;
  /** The body is not wanted: the thread stops reading it. */
  cancel(): void;
}

/**
 * A transport whose requests are made on a worker thread, with the
 * runtime's `fetch`, and their bodies read there — so a page that keeps the
 * application's thread busy holds back no download. One thread, made at
 * the first request and kept, unref'd, for the transport's life.
 */
export function threadTransport(
  options: ThreadTransportOptions = {},
): HtmlTransport {
  const connectTimeout =
    options.connectTimeout === undefined ? 2500 : options.connectTimeout;
  const calls = new Map<number, Call>();
  let next = 0;
  let thread: Promise<WorkerLike> | null = null;
  let running: (WorkerLike & { ref(): void }) | null = null;
  // The thread keeps the process alive while something is on its way on
  // it, as the runtime's own `fetch` would, and not otherwise: an
  // application that has stopped asking can exit with it there.
  const begin = (id: number, call: Call): void => {
    calls.set(id, call);
    if (calls.size === 1) running?.ref();
  };
  const forget = (id: number): void => {
    if (calls.delete(id) && calls.size === 0) running?.unref();
  };

  // the thread went: what was on its way fails, and the next request
  // starts another
  const lost = (error: unknown): void => {
    thread = null;
    running = null;
    for (const call of [...calls.values()]) call.fail(error);
    calls.clear();
  };
  const told = (message: FromThread): void => {
    const call = calls.get(message.id);
    if (!call) return;
    if (message.kind === 'head') {
      call.answer(
        responseOf(message, call, (bytes) => read(message.id, bytes)),
      );
    } else if (message.kind === 'chunk') {
      if (call.waiting) {
        const w = call.waiting;
        call.waiting = null;
        read(message.id, message.bytes.byteLength);
        w.resolve({ done: false, value: message.bytes });
      } else call.chunks.push(message.bytes);
    } else if (message.kind === 'end') {
      call.ended = true;
      forget(message.id);
      call.done();
      if (call.waiting) {
        const w = call.waiting;
        call.waiting = null;
        w.resolve({ done: true });
      }
    } else {
      const error = new Error(message.message);
      error.name = message.name ?? 'TypeError';
      if (message.code || message.errors) {
        (error as Error & { cause?: unknown }).cause = {
          code: message.code,
          ...(message.errors && { errors: [] }),
        };
      }
      call.fail(error);
      forget(message.id);
    }
  };
  const start = (): Promise<WorkerLike> =>
    (thread ??= nodeModule<WorkerThreadsModule>('worker_threads').then(
      ({ Worker }) => {
        const worker = new Worker(SOURCE, {
          eval: true,
          workerData: { connectTimeout },
        });
        worker.on('message', (m: never) => told(m as FromThread));
        worker.on('error', lost);
        worker.on('exit', () => lost(new Error('The network thread ended.')));
        // after the listeners, which take the thread's port in again
        running = worker as WorkerLike & { ref(): void };
        if (!calls.size) worker.unref();
        return worker;
      },
    ));
  // what has been read of a body, which lets the thread read on
  const read = (id: number, bytes: number): void => {
    void thread?.then((w) => w.postMessage({ kind: 'read', id, bytes }));
  };

  return async (url, init) => {
    const worker = await start();
    if (init.signal.aborted) throw abortReason(init.signal.reason);
    const id = (next += 1);
    return new Promise<ResponseLike>((resolve, reject) => {
      let answered = false;
      const onAbort = (): void => {
        worker.postMessage({ kind: 'abort', id });
        call.fail(abortReason(init.signal.reason));
        forget(id);
      };
      const call: Call = {
        answer(response) {
          answered = true;
          resolve(response);
        },
        fail(error) {
          call.done();
          if (!answered) {
            answered = true;
            reject(error);
            return;
          }
          if (call.ended || call.error) return;
          call.error = error;
          if (call.waiting) {
            const w = call.waiting;
            call.waiting = null;
            w.reject(error);
          }
        },
        chunks: [],
        waiting: null,
        ended: false,
        error: null,
        done: () => init.signal.removeEventListener('abort', onAbort),
        cancel() {
          forget(id);
          call.done();
          worker.postMessage({ kind: 'cancel', id });
        },
      };
      begin(id, call);
      init.signal.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({
        kind: 'fetch',
        id,
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
        streamedBody: init.streamedBody,
        redirect: init.redirect,
      });
    });
  };
}

/** The response the thread's head stands for, its body read from the
 *  chunks the thread sends after it. */
function responseOf(
  head: Extract<FromThread, { kind: 'head' }>,
  call: Call,
  read: (bytes: number) => void,
): ResponseLike {
  const fields = head.headers;
  const get = (name: string): string | null => {
    const key = name.toLowerCase();
    const values = fields.filter(([k]) => k === key).map(([, v]) => v);
    return values.length ? values.join(', ') : null;
  };
  return {
    url: head.url,
    status: head.status,
    statusText: head.statusText,
    redirected: head.redirected,
    headers: {
      get,
      entries: () => fields[Symbol.iterator](),
      ...(head.cookies && { getSetCookie: () => head.cookies!.slice() }),
    },
    body: head.body
      ? {
          getReader: () => ({
            read() {
              const chunk = call.chunks.shift();
              if (chunk) {
                read(chunk.byteLength);
                return Promise.resolve({ done: false, value: chunk });
              }
              if (call.error) return Promise.reject(call.error);
              if (call.ended) return Promise.resolve({ done: true });
              return new Promise((resolve, reject) => {
                call.waiting = { resolve, reject };
              });
            },
            cancel() {
              call.chunks.length = 0;
              if (!call.ended) {
                call.ended = true;
                call.cancel();
              }
              return Promise.resolve();
            },
          }),
        }
      : null,
  };
}

/** What a request its signal aborted fails with: the signal's reason, or
 *  an `AbortError`. */
function abortReason(reason: unknown): unknown {
  return reason ?? new DOMException('This operation was aborted', 'AbortError');
}
