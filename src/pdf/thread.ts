// PDFium on a thread of its own.
//
// A page of a dense map can take PDFium seconds, and nothing the view does
// may wait for that. So the engine is a `worker_threads` thread running
// `PdfiumEngine` (`worker-thread.ts`), and a tile comes back as an array
// moved rather than copied. One thread for the process: the module costs
// some 30 ms to start and holds what it has grown, and two documents on a
// screen want one queue.
//
// Node's modules are reached with a specifier the compiler cannot see, as
// `src/html/scripts/platform.ts` does, for the same reason: `src/` builds
// with `types: []`. Where no thread can be had the module runs where the
// view does, which is what a test on a runtime with no hooks for the entry
// gets, and is only slower to the eye on a heavy page.
import type {
  PageLink,
  PageText,
  PdfEngine,
  PdfDocumentId,
  PdfInfo,
  TilePixels,
  TileRequest,
} from './engine.js';
import { PdfOpenError } from './engine.js';
import { loadPdfium, PdfiumEngine } from './pdfium.js';
import type { FileUrl } from './pdfium.js';

declare const URL: new (url: string, base?: string) => FileUrl;

/** A `worker_threads` `Worker`, the part of it used here. */
interface ThreadLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  on(event: string, listener: (value: never) => void): void;
  unref(): void;
  terminate(): Promise<number>;
}
type ThreadClass = new (url: unknown, options?: unknown) => ThreadLike;

interface Answer {
  id: number;
  value?: unknown;
  error?: { code?: PdfOpenError['code']; message: string };
}

const HERE = (import.meta as { url: string }).url;
const ENTRY = new URL(
  HERE.endsWith('.ts') ? './worker-thread.ts' : './worker-thread.js',
  HERE,
);

function load(specifier: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ specifier) as Promise<
    Record<string, unknown>
  >;
}

export class ThreadEngine implements PdfEngine {
  private readonly _thread: ThreadLike;
  private readonly _pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >();
  private _next = 1;
  private _dead: Error | null = null;

  constructor(thread: ThreadLike) {
    this._thread = thread;
    thread.on('message', (answer: Answer) => {
      const pending = this._pending.get(answer.id);
      if (!pending) return;
      this._pending.delete(answer.id);
      if (answer.error) {
        pending.reject(
          answer.error.code
            ? new PdfOpenError(answer.error.code, answer.error.message)
            : new Error(answer.error.message),
        );
      } else {
        pending.resolve(answer.value as never);
      }
    });
    const died = (error: Error): void => {
      this._dead = error;
      // The next document starts another: a page that took the thread down
      // has no claim on the ones after it.
      shared = null;
      for (const pending of this._pending.values()) pending.reject(error);
      this._pending.clear();
    };
    thread.on('error', died);
    thread.on('exit', () => died(new Error('The PDF thread ended')));
  }

  private _ask<T>(op: string, args: unknown[]): Promise<T> {
    if (this._dead) return Promise.reject(this._dead);
    const id = this._next++;
    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
      });
      this._thread.postMessage({ id, op, args });
    });
  }

  open(data: Uint8Array, options?: { password?: string }): Promise<PdfInfo> {
    return this._ask('open', [data, options]);
  }

  render(handle: PdfDocumentId, tile: TileRequest): Promise<TilePixels | null> {
    return this._ask('render', [handle, tile]);
  }

  text(handle: PdfDocumentId, page: number): Promise<PageText> {
    return this._ask('text', [handle, page]);
  }

  links(handle: PdfDocumentId, page: number): Promise<PageLink[]> {
    return this._ask('links', [handle, page]);
  }

  close(handle: PdfDocumentId): void {
    if (!this._dead)
      this._thread.postMessage({ id: 0, op: 'close', args: [handle] });
  }

  dispose(): void {
    void this._thread.terminate();
  }
}

/** The thread, once it says its module is in, or null where it cannot. */
async function startThread(): Promise<PdfEngine | null> {
  let Worker: ThreadClass;
  try {
    Worker = (await load('node:worker_threads')).Worker as ThreadClass;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let thread: ThreadLike;
    try {
      thread = new Worker(ENTRY);
    } catch {
      resolve(null);
      return;
    }
    thread.unref();
    const answer = (ready: { ready?: boolean }): void => {
      if (ready.ready === undefined) return;
      if (ready.ready) {
        resolve(new ThreadEngine(thread));
      } else {
        void thread.terminate();
        resolve(null);
      }
    };
    thread.on('message', answer as (value: never) => void);
    thread.on('error', () => resolve(null));
    thread.on('exit', () => resolve(null));
  });
}

async function inThisThread(): Promise<PdfEngine | null> {
  const { readFile } = (await load('node:fs/promises')) as {
    readFile: (url: FileUrl) => Promise<Uint8Array>;
  };
  const module = await loadPdfium(readFile, (specifier) =>
    (import.meta as { resolve(s: string): string }).resolve(specifier),
  );
  return module ? new PdfiumEngine(module) : null;
}

let shared: Promise<PdfEngine | null> | null = null;

/**
 * The process's engine: the thread if one starts, the module here if not,
 * and null where the package is not installed. Kept for the process, as the
 * module is costly to start and the thread keeps no event loop alive.
 */
export function defaultPdfEngine(): Promise<PdfEngine | null> {
  shared ??= startThread().then((engine) => engine ?? inThisThread());
  return shared;
}
