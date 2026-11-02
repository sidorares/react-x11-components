// What a page's realms share with one another, and what a page's compression
// streams run on: the host's half of `BroadcastChannel`, `navigator.locks`
// and `CompressionStream`.
//
// A channel and a lock are the page's origin's. They are kept here, by
// origin, for every realm of this thread: a page and its frames, each with
// a host of its own. A worker's thread has this module to itself, and a tab
// is a process, so neither reaches another: a lock is held across the realms
// of a tab, and `docs/components/html.md` says so.
import { nodeModule } from './platform.js';

/** A `BroadcastChannel` of a realm: told what another posts. */
export interface ChannelEnd {
  id: number;
  tell(id: number, message: string): void;
}
const CHANNELS = new Map<string, Set<ChannelEnd>>();

export function openChannel(key: string, end: ChannelEnd): void {
  let ends = CHANNELS.get(key);
  if (!ends) CHANNELS.set(key, (ends = new Set()));
  ends.add(end);
}
export function closeChannel(key: string, end: ChannelEnd): void {
  const ends = CHANNELS.get(key);
  if (!ends?.delete(end)) return;
  if (!ends.size) CHANNELS.delete(key);
}
/** Each other end of a channel, as a task of its own (HTML 9.5). */
export function postChannel(
  key: string,
  from: ChannelEnd,
  message: string,
  later: (fn: () => void) => void,
): void {
  for (const end of CHANNELS.get(key) ?? []) {
    if (end !== from) later(() => end.tell(end.id, message));
  }
}

/** One `navigator.locks.request` of a realm (Web Locks 1). */
export interface LockRequest {
  id: number;
  name: string;
  exclusive: boolean;
  client: string;
  /** Told the lock is held, and that another stole it. */
  granted(id: number): void;
  stolen(id: number): void;
}
interface LockTable {
  held: LockRequest[];
  /** What waits, by name, in the order it asked. */
  queues: Map<string, LockRequest[]>;
}
const TABLES = new Map<string, LockTable>();
function tableOf(origin: string): LockTable {
  let table = TABLES.get(origin);
  if (!table) {
    TABLES.set(origin, (table = { held: [], queues: new Map() }));
  }
  return table;
}
/** Whether a request can be held beside what is (Web Locks 1, "grantable"). */
function grantable(table: LockTable, request: LockRequest): boolean {
  const others = table.held.filter((h) => h.name === request.name);
  return (
    !others.length || (!request.exclusive && !others.some((h) => h.exclusive))
  );
}
/** Hold whatever waits at the head of each queue and can be. */
function processQueues(table: LockTable): void {
  for (const [name, queue] of table.queues) {
    while (queue.length && grantable(table, queue[0])) {
      const next = queue.shift()!;
      table.held.push(next);
      next.granted(next.id);
    }
    if (!queue.length) table.queues.delete(name);
  }
}
/** Ask for a lock. False where `ifAvailable` said not to wait, and it
 *  would have had to. */
export function requestLock(
  origin: string,
  request: LockRequest,
  ifAvailable: boolean,
  steal: boolean,
): boolean {
  const table = tableOf(origin);
  if (steal) {
    const stays: LockRequest[] = [];
    for (const held of table.held) {
      if (held.name === request.name) held.stolen(held.id);
      else stays.push(held);
    }
    table.held = stays;
    table.held.push(request);
    request.granted(request.id);
    return true;
  }
  const queue = table.queues.get(request.name);
  if (ifAvailable && (queue?.length || !grantable(table, request))) {
    return false;
  }
  if (queue) queue.push(request);
  else table.queues.set(request.name, [request]);
  processQueues(table);
  return true;
}
/** A lock let go, or a request taken back. */
export function releaseLock(origin: string, id: number, client: string): void {
  const table = tableOf(origin);
  const mine = (r: LockRequest): boolean => r.id === id && r.client === client;
  table.held = table.held.filter((r) => !mine(r));
  for (const [name, queue] of table.queues) {
    const stays = queue.filter((r) => !mine(r));
    if (stays.length) table.queues.set(name, stays);
    else table.queues.delete(name);
  }
  processQueues(table);
}
/** Everything a realm held and waited for, as it goes. */
export function releaseClient(origin: string, client: string): void {
  const table = TABLES.get(origin);
  if (!table) return;
  table.held = table.held.filter((r) => r.client !== client);
  for (const [name, queue] of table.queues) {
    const stays = queue.filter((r) => r.client !== client);
    if (stays.length) table.queues.set(name, stays);
    else table.queues.delete(name);
  }
  processQueues(table);
}
/** What `query()` answers, as plain data. */
export function queryLocks(origin: string): string {
  const table = tableOf(origin);
  const info = (r: LockRequest) => ({
    name: r.name,
    mode: r.exclusive ? 'exclusive' : 'shared',
    clientId: r.client,
  });
  return JSON.stringify({
    held: table.held.map(info),
    pending: [...table.queues.values()].flat().map(info),
  });
}

/** The slice of a node zlib stream that is used here. */
interface ZlibStream {
  write(chunk: Uint8Array, done: (error?: Error | null) => void): void;
  end(): void;
  destroy(): void;
  on(event: 'data', fn: (chunk: Uint8Array) => void): void;
  on(event: 'end', fn: () => void): void;
  on(event: 'error', fn: (error: Error) => void): void;
  /** How much of the input it has read: past the end of a stream, what is
   *  left is more than there should be. */
  bytesWritten: number;
}
interface ZlibModule {
  createGzip(): ZlibStream;
  createDeflate(): ZlibStream;
  createDeflateRaw(): ZlibStream;
  createBrotliCompress(): ZlibStream;
  createGunzip(): ZlibStream;
  createInflate(): ZlibStream;
  createInflateRaw(): ZlibStream;
  createBrotliDecompress(): ZlibStream;
}
const zlib = await nodeModule<ZlibModule>('zlib');

const MAKERS: Record<string, () => ZlibStream> = {
  'compress gzip': zlib.createGzip,
  'compress deflate': zlib.createDeflate,
  'compress deflate-raw': zlib.createDeflateRaw,
  'compress brotli': zlib.createBrotliCompress,
  'decompress gzip': zlib.createGunzip,
  'decompress deflate': zlib.createInflate,
  'decompress deflate-raw': zlib.createInflateRaw,
  'decompress brotli': zlib.createBrotliDecompress,
};

/** What becomes of a stream's input, in the order it comes to. */
export interface ZlibEvents {
  output(chunks: Uint8Array[]): void;
  /** All of it is through, or it failed. */
  end(ok: boolean): void;
}
/**
 * A compression stream's zlib. Output is handed over as each write is
 * through, so a `transform` waits for what its chunk came to, and past the
 * end of a compressed stream, more input is a failure, which node's zlib
 * takes for nothing to do with it.
 */
export class PageZlib {
  private _stream: ZlibStream;
  private _held: Uint8Array[] = [];
  private _written = 0;
  private _failed = false;
  private _decompressing: boolean;
  constructor(
    kind: string,
    private _events: ZlibEvents,
  ) {
    this._decompressing = kind.startsWith('decompress');
    this._stream = MAKERS[kind]();
    this._stream.on('data', (chunk) => this._held.push(chunk));
    this._stream.on('error', () => this._fail());
    this._stream.on('end', () => {
      if (this._failed) return;
      this._flush();
      this._events.end(
        !this._decompressing || this._stream.bytesWritten >= this._written,
      );
    });
  }
  private _flush(): void {
    if (this._held.length) this._events.output(this._held);
    this._held = [];
  }
  private _fail(): void {
    if (this._failed) return;
    this._failed = true;
    this._flush();
    this._events.end(false);
  }
  write(bytes: Uint8Array, done: () => void): void {
    this._written += bytes.length;
    this._stream.write(bytes, () => {
      if (this._failed) return;
      this._flush();
      done();
    });
  }
  end(): void {
    this._stream.end();
  }
  dispose(): void {
    this._failed = true;
    this._stream.destroy();
  }
}
