// A worker's WebSockets, carried across its thread to the page process's
// seam (`HtmlScripts.webSocket`), as its `fetch` and its WebTransport
// sessions are (`transport-relay.ts`): the browser's network policy is the
// page process's, and an `HtmlWebSocket` is an object of the host's — a
// runtime's socket, a jar of cookies — that no thread can be handed.
//
// The thread's host is given a `SocketProxy` for its seam, which answers as
// a seam does and posts what it is asked to the page process, where a
// `SocketRelay` for the worker drives the page's own seam and posts what
// becomes of each connection back. What crosses is plain data — numbers,
// strings, a `Uint8Array` copied — over the thread's one channel, tagged
// `{ kind: 'ws' }`. The one answer a connection gives that is not an event,
// `bufferedAmount()`, is answered on the worker's side from the bytes it
// sent less those the page process says went (`sent`).
import type {
  HtmlWebSocket,
  WebSocketConnectRequest,
  WebSocketConnectionLike,
  WebSocketEvents,
  WebSocketOpened,
} from '../socket.js';
import { SendWatch } from './sockets.js';
import type { SetTimeout } from './platform.js';

declare const setTimeout: SetTimeout;

/** What a worker's thread asks of the page process. */
export type SocketAsk =
  | { kind: 'ws'; op: 'connect'; s: number; request: WebSocketConnectRequest }
  | { kind: 'ws'; op: 'send'; s: number; data: string | Uint8Array }
  | {
      kind: 'ws';
      op: 'close';
      s: number;
      code: number | null;
      reason: string;
    };

/** What the page process tells a worker's thread. */
export type SocketTell =
  | { kind: 'ws'; ev: 'open'; s: number; info: WebSocketOpened }
  | { kind: 'ws'; ev: 'message'; s: number; data: string | Uint8Array }
  | { kind: 'ws'; ev: 'sent'; s: number; bytes: number }
  | { kind: 'ws'; ev: 'failed'; s: number; message: string }
  | {
      kind: 'ws';
      ev: 'closed';
      s: number;
      code: number;
      reason: string;
      wasClean: boolean;
    };

/** A message's size on the wire, as `bufferedAmount` counts it. */
function sizeOf(data: string | Uint8Array): number {
  if (typeof data !== 'string') return data.byteLength;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < data.length) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

// --- the worker's side ------------------------------------------------------

interface ProxySocket {
  events: WebSocketEvents;
  buffered: number;
}

/**
 * The seam a worker's host is handed: each connection asked for posted to
 * the page process, and what becomes of it heard back through `heard`.
 */
export class SocketProxy implements HtmlWebSocket {
  private _sockets = new Map<number, ProxySocket>();
  private _seq = 0;

  constructor(private readonly _post: (m: SocketAsk) => void) {}

  connect(
    request: WebSocketConnectRequest,
    events: WebSocketEvents,
  ): WebSocketConnectionLike {
    const s = ++this._seq;
    const socket: ProxySocket = { events, buffered: 0 };
    this._sockets.set(s, socket);
    this._post({ kind: 'ws', op: 'connect', s, request });
    return {
      send: (data) => {
        socket.buffered += sizeOf(data);
        this._post({
          kind: 'ws',
          op: 'send',
          s,
          data: typeof data === 'string' ? data : data.slice(),
        });
      },
      bufferedAmount: () => socket.buffered,
      close: (code, reason) =>
        this._post({ kind: 'ws', op: 'close', s, code, reason }),
    };
  }

  /** What the page process told of a connection. */
  heard(m: SocketTell): void {
    const socket = this._sockets.get(m.s);
    if (!socket) return;
    switch (m.ev) {
      case 'open':
        socket.events.open(m.info);
        return;
      case 'message':
        socket.events.message(m.data);
        return;
      case 'sent':
        socket.buffered = Math.max(0, socket.buffered - m.bytes);
        return;
      case 'failed':
        this._sockets.delete(m.s);
        socket.events.failed(m.message);
        return;
      case 'closed':
        this._sockets.delete(m.s);
        socket.events.closed(m.code, m.reason, m.wasClean);
        return;
    }
  }
}

// --- the page process's side ------------------------------------------------

interface RelayedSocket {
  conn: WebSocketConnectionLike;
  watch: SendWatch;
  done: boolean;
}

/**
 * A worker's connections over the page's own seam: what the worker's
 * thread asks done, and what becomes of each connection posted back.
 */
export class SocketRelay {
  private _sockets = new Map<number, RelayedSocket>();
  private _disposed = false;

  constructor(
    private readonly _connector: () => HtmlWebSocket | undefined,
    private readonly _post: (m: SocketTell) => void,
  ) {}

  /** Whether a connection of the worker's is still open, or opening: what
   *  keeps its page out of the back-forward cache. */
  get open(): boolean {
    for (const r of this._sockets.values()) if (!r.done) return true;
    return false;
  }

  private _tell(m: SocketTell): void {
    if (!this._disposed) this._post(m);
  }

  /** The worker ended: its connections go with it, as a document's do. */
  dispose(): void {
    this._disposed = true;
    for (const r of this._sockets.values()) {
      r.watch.stop();
      try {
        r.conn.close(1001, '');
      } catch {}
    }
    this._sockets.clear();
  }

  /** What the worker's thread asked. */
  heard(m: SocketAsk): void {
    if (this._disposed) return;
    if (m.op === 'connect') {
      this._connect(m.s, m.request);
      return;
    }
    const r = this._sockets.get(m.s);
    if (!r || r.done) return;
    try {
      if (m.op === 'send') {
        r.conn.send(m.data);
        r.watch.queued(sizeOf(m.data));
      } else r.conn.close(m.code, m.reason);
    } catch {}
  }

  private _connect(s: number, request: WebSocketConnectRequest): void {
    // a seam may fail a connection while it is being asked for it
    let ended = false;
    const finish = (r: RelayedSocket | undefined): void => {
      ended = true;
      if (!r) return;
      r.done = true;
      r.watch.stop();
      this._sockets.delete(s);
    };
    const connector = this._connector();
    if (!connector) {
      setTimeout(
        () =>
          this._tell({
            kind: 'ws',
            ev: 'failed',
            s,
            message: 'there is no network.',
          }),
        0,
      );
      return;
    }
    let made: RelayedSocket | undefined;
    const events: WebSocketEvents = {
      open: (info) =>
        this._tell({
          kind: 'ws',
          ev: 'open',
          s,
          info: {
            protocol: String(info?.protocol ?? ''),
            extensions: String(info?.extensions ?? ''),
          },
        }),
      message: (data) => this._tell({ kind: 'ws', ev: 'message', s, data }),
      failed: (message) => {
        finish(made);
        this._tell({ kind: 'ws', ev: 'failed', s, message: String(message) });
      },
      closed: (code, reason, wasClean) => {
        finish(made);
        this._tell({
          kind: 'ws',
          ev: 'closed',
          s,
          code: Number(code),
          reason: String(reason ?? ''),
          wasClean: wasClean === true,
        });
      },
    };
    let conn: WebSocketConnectionLike;
    try {
      conn = connector.connect(request, events);
    } catch (error) {
      events.failed(String((error as Error)?.message ?? error));
      return;
    }
    made = {
      conn,
      done: ended,
      watch: new SendWatch(
        () => (made?.done ? 0 : conn.bufferedAmount()),
        (bytes) => this._tell({ kind: 'ws', ev: 'sent', s, bytes }),
      ),
    };
    if (!ended) this._sockets.set(s, made);
  }
}
