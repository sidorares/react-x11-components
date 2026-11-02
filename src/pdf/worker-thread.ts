// The thread `thread.ts` starts: `PdfiumEngine`, answering messages.
import { PdfOpenError } from './engine.js';
import type { PdfEngine, TilePixels } from './engine.js';
import { loadPdfium, PdfiumEngine } from './pdfium.js';
import type { FileUrl } from './pdfium.js';

interface PortLike {
  on(event: 'message', listener: (message: Asked) => void): void;
  postMessage(message: unknown, transfer?: unknown[]): void;
}

interface Asked {
  id: number;
  op: 'open' | 'render' | 'text' | 'links' | 'close';
  args: unknown[];
}

function load(specifier: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ specifier) as Promise<
    Record<string, unknown>
  >;
}

const { parentPort } = (await load('node:worker_threads')) as {
  parentPort: PortLike;
};
const { readFile } = (await load('node:fs/promises')) as {
  readFile: (url: FileUrl) => Promise<Uint8Array>;
};

const module = await loadPdfium(readFile, (specifier) =>
  (import.meta as { resolve(s: string): string }).resolve(specifier),
);

if (!module) {
  parentPort.postMessage({ ready: false });
} else {
  const engine: PdfEngine = new PdfiumEngine(module);
  parentPort.on('message', ({ id, op, args }) => {
    void answer(engine, id, op, args);
  });
  parentPort.postMessage({ ready: true });
}

/** What can be moved rather than copied back. */
function moved(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const data = (value as Partial<TilePixels>).data;
  if (data) return [data.buffer];
  const boxes = (value as { boxes?: Float32Array }).boxes;
  return boxes ? [boxes.buffer] : [];
}

async function answer(
  engine: PdfEngine,
  id: number,
  op: Asked['op'],
  args: unknown[],
): Promise<void> {
  try {
    if (op === 'close') {
      engine.close(args[0] as number);
      return;
    }
    const value = await (
      engine[op] as (...args: unknown[]) => Promise<unknown>
    )(...args);
    parentPort.postMessage({ id, value }, moved(value));
  } catch (error) {
    const failed = error as Error;
    parentPort.postMessage({
      id,
      error: {
        message: failed?.message ?? String(error),
        ...(error instanceof PdfOpenError ? { code: error.code } : {}),
      },
    });
  }
}
