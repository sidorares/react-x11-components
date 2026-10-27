// A page's WebSockets on the host's side: what the facade's `WebSocket` asks
// for (the `ws…` ops) carried over the host's seam (`HtmlScripts.webSocket`),
// and what becomes of each connection told back to the page through entries
// (`__ws…`).
//
// Only primitives cross, as everywhere on the bridge: a socket is a number,
// a binary message is base64, and what an entry is handed is JSON. A page's
// object never reaches the seam, and nothing of the seam's reaches the page.
// A connection's fate is told, never asked: the page keeps its own
// `readyState` and `bufferedAmount`, and hears when either moves.
import { connectAllowed } from '../csp.js';
import type { CspPolicy } from '../csp.js';
import { badPort } from '../transport.js';
import type {
  HtmlWebSocket,
  WebSocketConnectionLike,
  WebSocketOpened,
} from '../socket.js';
import type { BufferClass, ClearTimeout, SetTimeout } from './platform.js';

declare const Buffer: BufferClass;
declare const setTimeout: SetTimeout;
declare const clearTimeout: ClearTimeout;
declare const URL: new (url: string) => { protocol: string; hostname: string };

type Primitive = string | number | boolean | null | undefined;

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}
function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** The bytes a connection may have waiting to go before it is flagged as
 *  full and closed (WebSockets, `send()`): what a page that sends without
 *  end is let hold of the process's memory. */
export const SEND_BUFFER = 64 * 1024 * 1024;

/** A host Mixed Content counts as secure however it is reached
 *  (Secure Contexts, "potentially trustworthy"): this machine. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1|.*\.localhost)$/i;

/**
 * Whether a connection to `url` from a document of `origin` is mixed
 * content, which is blocked: a `ws:` endpoint not on this machine, from a
 * page that came over a secure connection (Mixed Content, 4.3). The
 * standard fails such a socket, and WPT's `mixed-content.https.any.js`
 * holds it to `error` and `close`; Chrome and Firefox throw a
 * `SecurityError` from the constructor instead.
 */
export function mixedContent(url: string, origin: string): boolean {
  if (!/^https:/i.test(origin)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'ws:' && !LOOPBACK.test(u.hostname);
  } catch {
    return true;
  }
}

/**
 * What a connection has handed to the network, watched as it goes: `sent`
 * is told the bytes that left since it was last told, a task after each
 * send and then while some still wait. A seam answers how many wait
 * (`bufferedAmount()`), not when they go, so this asks.
 */
export class SendWatch {
  private _queued = 0;
  private _told = 0;
  private _timer: unknown = null;

  constructor(
    private readonly _waiting: () => number,
    private readonly _sent: (bytes: number) => void,
  ) {}

  /** Bytes were handed to the connection. */
  queued(bytes: number): void {
    this._queued += bytes;
    this._schedule(0);
  }

  stop(): void {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }

  private _schedule(ms: number): void {
    if (this._timer !== null) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._check();
    }, ms);
  }

  private _check(): void {
    const waiting = Math.max(0, this._waiting());
    const gone = this._queued - waiting - this._told;
    if (gone > 0) {
      this._told += gone;
      this._sent(gone);
    }
    if (waiting > 0) this._schedule(16);
  }
}

interface Socket {
  id: number;
  url: string;
  protocols: string[];
  conn: WebSocketConnectionLike | null;
  state: 'connecting' | 'open' | 'closing' | 'closed';
  watch: SendWatch | null;
}

/** What the page's sockets are carried over, and how the page is told. */
export interface SocketSeams {
  /** The seam, read as each socket opens. */
  connector(): HtmlWebSocket | undefined;
  /** The origin of the document, or the worker, the sockets are of. */
  origin(): string;
  /** The document's Content Security Policies, which a socket is held to
   *  (`connect-src`). Absent, none. */
  policies?(): CspPolicy[];
  /** The page's console, which a failed socket is told on. */
  log?(level: string, text: string): void;
  /** An entry of the page's, with its input. */
  tell(entry: string, input: unknown): void;
}

export class PageSockets {
  private readonly _sockets = new Map<number, Socket>();
  private _disposed = false;
  /** How deep in the facade's ops this is: a seam that answers while it is
   *  asked would otherwise tell the page inside the call that asked. */
  private _inOp = 0;
  /** What waits to be told a task later, in order. */
  private _later: [string, unknown][] = [];

  constructor(private readonly _seams: SocketSeams) {}

  /** Whether a socket is open, or opening, or closing: what keeps a
   *  document out of the back-forward cache, where its server would see
   *  it held. */
  get open(): boolean {
    for (const s of this._sockets.values()) {
      if (s.state !== 'closed') return true;
    }
    return false;
  }

  /** An op of the facade's whose name starts with `ws`. */
  op(
    op: string,
    a: Primitive,
    b: Primitive,
    c: Primitive,
    d: Primitive,
  ): Primitive {
    this._inOp += 1;
    try {
      return this._op(op, a, b, c, d);
    } finally {
      this._inOp -= 1;
    }
  }

  private _op(
    op: string,
    a: Primitive,
    b: Primitive,
    c: Primitive,
    d: Primitive,
  ): Primitive {
    const text = (v: Primitive): string => (typeof v === 'string' ? v : '');
    switch (op) {
      case 'wsOpen':
        this._open(Number(a), text(b), text(c));
        return null;
      case 'wsSend': {
        const s = this._sockets.get(Number(a));
        if (s?.state !== 'open' || !s.conn) return null;
        const size = Number(d) || 0;
        // a page that sends faster than the network takes is flagged as
        // full, and its connection closed
        if (s.conn.bufferedAmount() + size > SEND_BUFFER) {
          this._fail(s, 'the send buffer is full.');
          return null;
        }
        try {
          s.conn.send(b === true ? bytesOf(text(c)) : text(c));
        } catch (error) {
          this._fail(s, String((error as Error)?.message ?? error));
          return null;
        }
        this._watch(s).queued(size);
        return null;
      }
      case 'wsClose': {
        const s = this._sockets.get(Number(a));
        if (!s) return null;
        if (s.state === 'connecting') {
          // not established yet: the connection is failed (WebSockets,
          // `close()`)
          this._fail(
            s,
            'WebSocket is closed before the connection is established.',
          );
          return null;
        }
        if (s.state !== 'open') return null;
        s.state = 'closing';
        try {
          s.conn?.close(typeof b === 'number' ? b : null, text(c));
        } catch {}
        return null;
      }
      default:
        return null;
    }
  }

  /** The realm goes: every socket it had is closed, an established one with
   *  1001 (going away) and one being established abandoned, as a
   *  document's are when it is unloaded. Nothing is told. */
  dispose(): void {
    this._disposed = true;
    for (const s of this._sockets.values()) this._drop(s, 1001);
    this._sockets.clear();
  }

  /** An entry told: now, or a task later where the page is inside an op
   *  of these, or where something already waits — what becomes of a
   *  connection reaches the page in its own task, and in order. */
  private _tell(entry: string, input: unknown, later = false): void {
    if (this._disposed) return;
    if (!later && !this._inOp && !this._later.length) {
      this._seams.tell(entry, input);
      return;
    }
    if (!this._later.length) {
      setTimeout(() => {
        const waiting = this._later;
        this._later = [];
        for (const [name, value] of waiting) {
          if (!this._disposed) this._seams.tell(name, value);
        }
      }, 0);
    }
    this._later.push([entry, input]);
  }

  private _watch(s: Socket): SendWatch {
    return (s.watch ??= new SendWatch(
      () => (s.state === 'closed' ? 0 : (s.conn?.bufferedAmount() ?? 0)),
      (bytes) => {
        if (s.state !== 'closed') this._tell('__wsSent', [s.id, bytes]);
      },
    ));
  }

  private _drop(s: Socket, code: number): void {
    if (s.state === 'closed') return;
    const established = s.state === 'open';
    s.state = 'closed';
    s.watch?.stop();
    try {
      s.conn?.close(established ? code : null, '');
    } catch {}
  }

  /** The connection is failed: `error` and a `close` with 1006, a task
   *  later, and the reason on the console, as Chrome writes it. */
  private _fail(s: Socket, message: string): void {
    if (s.state === 'closed') return;
    this._drop(s, 1006);
    this._sockets.delete(s.id);
    this._seams.log?.(
      'error',
      `WebSocket connection to '${s.url}' failed: ${message}`,
    );
    this._tell('__wsClosed', [s.id, 1006, '', false, true], true);
  }

  private _open(id: number, url: string, protocolsJson: string): void {
    let protocols: string[] = [];
    try {
      const parsed = JSON.parse(protocolsJson) as unknown;
      if (Array.isArray(parsed)) protocols = parsed.map(String);
    } catch {}
    const s: Socket = {
      id,
      url,
      protocols,
      conn: null,
      state: 'connecting',
      watch: null,
    };
    this._sockets.set(id, s);
    const origin = this._seams.origin();
    // a port no browser connects to is refused before anything is sent,
    // as a fetch is (Fetch, "bad port")
    if (badPort(url)) {
      this._fail(s, 'its port is blocked.');
      return;
    }
    // a secure page's insecure endpoint, and one the document's policy
    // does not allow, are refused before anything is sent (Mixed Content,
    // and CSP's `connect-src`, which a WebSocket is held to as `fetch` is)
    if (mixedContent(url, origin)) {
      this._seams.log?.(
        'error',
        `Mixed Content: The page at '${origin}' was loaded over HTTPS, but attempted to connect to the insecure WebSocket endpoint '${url}'. This request has been blocked; this endpoint must be available over WSS.`,
      );
      this._fail(s, 'it is mixed content.');
      return;
    }
    if (!connectAllowed(this._seams.policies?.() ?? [], url, origin)) {
      this._seams.log?.(
        'error',
        `Refused to connect to '${url}' because it violates the document's Content Security Policy directive "connect-src".`,
      );
      this._fail(s, 'the Content Security Policy refused it.');
      return;
    }
    const connector = this._seams.connector();
    if (!connector) {
      this._fail(s, 'there is no network.');
      return;
    }
    let conn: WebSocketConnectionLike;
    try {
      conn = connector.connect(
        { url, origin, protocols: [...protocols] },
        {
          open: (info: WebSocketOpened) => {
            if (s.state !== 'connecting') return;
            const protocol = String(info?.protocol ?? '');
            // a subprotocol the page did not offer fails the connection
            // (RFC 6455 4.1, the client's checks of the server's handshake)
            if (protocol && !s.protocols.includes(protocol)) {
              this._fail(
                s,
                `the server chose the subprotocol '${protocol}', which was not offered.`,
              );
              return;
            }
            s.state = 'open';
            this._tell('__wsOpen', [
              id,
              protocol,
              String(info?.extensions ?? ''),
            ]);
          },
          message: (data) => {
            if (s.state !== 'open' && s.state !== 'closing') return;
            if (typeof data === 'string') {
              this._tell('__wsMessage', [id, false, data]);
            } else if (data instanceof Uint8Array) {
              this._tell('__wsMessage', [id, true, base64Of(data)]);
            }
          },
          failed: (message) => this._fail(s, String(message)),
          closed: (code, reason, wasClean) => {
            if (s.state === 'closed') return;
            s.state = 'closed';
            s.watch?.stop();
            this._sockets.delete(id);
            this._tell('__wsClosed', [
              id,
              Number(code) >>> 0 || 1006,
              String(reason ?? ''),
              wasClean === true,
              false,
            ]);
          },
        },
      );
    } catch (error) {
      this._fail(s, String((error as Error)?.message ?? error));
      return;
    }
    s.conn = conn;
    // a socket the seam failed while it was being asked was closed before
    // it had a connection to close
    if (s.state === 'closed') {
      try {
        conn.close(null, '');
      } catch {}
    }
  }
}
