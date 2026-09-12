// A worker thread's half of `GlTileStore`: tile bytes in, buckets out.
//
// Loaded only as a `Worker` entry and never imported, so the listener below
// is not an import-time side effect of the package — no bundle that follows
// imports can reach this file. What crosses the thread boundary is the point
// of the bucket format: a tile arrives as its own bytes (copied, a few
// hundred kilobytes) and leaves as two ArrayBuffers that are *transferred*,
// so the main thread's whole cost for a tile is the upload.
//
// `node:worker_threads` through a variable specifier, as `src/embed/host.ts`
// reaches `node:net`: `src/` compiles with `types: []`, and a literal
// specifier would make every build depend on Node's type declarations.
import { prepareStyle } from '../paint.js';
import type { PreparedStyle } from '../paint.js';
import { parseVectorTile } from '../sources.js';
import type { MapStyleLayer } from '../style.js';
import { buildTileBuckets } from './buckets.js';

/** What the store sends. */
export type BuildRequest =
  | { type: 'style'; id: number; layers: MapStyleLayer[] }
  | { type: 'build'; job: number; style: number; bytes: Uint8Array };

interface Port {
  on(event: 'message', listener: (message: unknown) => void): void;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

const WORKER_THREADS = 'node:worker_threads';
const { parentPort } = (await import(WORKER_THREADS)) as {
  parentPort: Port | null;
};

/** Compiled filters per style id. Two are kept: the store may still have a
 *  build in flight for the style it is leaving. */
const styles = new Map<number, PreparedStyle>();

parentPort?.on('message', (message) => {
  const request = message as BuildRequest;
  if (request.type === 'style') {
    styles.set(request.id, prepareStyle({ layers: request.layers }));
    for (const id of styles.keys()) if (id < request.id - 1) styles.delete(id);
    return;
  }
  try {
    const prepared = styles.get(request.style);
    if (!prepared) throw new Error(`style ${request.style} was never sent`);
    const data = buildTileBuckets(parseVectorTile(request.bytes), prepared);
    const transfer = [data.line, data.fill];
    if (data.labels) transfer.push(data.labels.anchors.buffer as ArrayBuffer);
    parentPort.postMessage({ job: request.job, data }, transfer);
  } catch (error) {
    parentPort.postMessage({ job: request.job, error: String(error) });
  }
});
