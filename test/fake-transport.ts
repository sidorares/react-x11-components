// An `HtmlWebTransport` that opens no connection.
//
// The counterpart of `./fake-host.ts` and `./fake-pty.ts` for a page's
// WebTransport, and the reason the seam is an interface: CI runs no QUIC
// server, so the suite plays the server itself. A session's server is a
// `FakeServer`, made for each CONNECT by the test's `serve`, which answers
// it — establishes it or refuses it, echoes what it is sent, opens streams
// of its own, resets and stops them, closes the session — and keeps what
// the page sent for the test to read.
//
// Not a `.test.ts` file, so `tsx --test` does not run it, but `tsconfig.json`
// does typecheck it.
import type {
  HtmlWebTransport,
  WebTransportConnectRequest,
  WebTransportPriority,
  WebTransportSessionEvents,
  WebTransportSessionLike,
  WebTransportStreamEvents,
  WebTransportStreamLike,
} from '../src/html/transport.js';

/** One side of a fake stream, as the server sees and drives it. */
export class FakeStream implements WebTransportStreamLike {
  /** What the page sent on it, in order. */
  readonly received: Uint8Array[] = [];
  /** Whether the page ended its sending part, reset it (its code), or
   *  stopped reading (its code). */
  finished = false;
  resetCode: number | null = null;
  stopCode: number | null = null;
  priority: WebTransportPriority = { sendOrder: 0, sendGroup: null };
  /** What the server sends that the page has not read. */
  private _queue: Uint8Array[] = [];
  private _ended = false;
  private _endTold = false;
  private _events: WebTransportStreamEvents | null = null;
  private _early: ((e: WebTransportStreamEvents) => void)[] = [];
  /** Told what the page sends, as it sends it: an echo server's hook. */
  onData: ((bytes: Uint8Array) => void) | null = null;
  onFinish: (() => void) | null = null;

  constructor(
    readonly bidirectional: boolean,
    /** Whether the page can send on it. */
    readonly sends: boolean,
    /** Whether the page can read from it. */
    readonly reads: boolean,
  ) {}

  private _tell(fn: (e: WebTransportStreamEvents) => void): void {
    if (this._events) fn(this._events);
    else this._early.push(fn);
  }

  // --- the server's side ---------------------------------------------------

  /** The server sends bytes. */
  send(bytes: Uint8Array): void {
    this._queue.push(bytes);
    this._tell((e) => e.readable());
  }
  /** The server ends its sending part. */
  end(): void {
    this._ended = true;
    if (!this._queue.length) this._endNow();
    else this._tell((e) => e.readable());
  }
  private _endNow(): void {
    if (this._endTold) return;
    this._endTold = true;
    this._tell((e) => e.end());
  }
  /** The server resets its sending part (RESET_STREAM). */
  serverReset(code: number | null): void {
    this._queue = [];
    this._tell((e) => e.reset(code));
  }
  /** The server asks the page to stop sending (STOP_SENDING). */
  serverStop(code: number | null): void {
    this._tell((e) => e.stopSending(code));
  }

  // --- the seam's side -----------------------------------------------------

  listen(events: WebTransportStreamEvents): void {
    this._events = events;
    for (const fn of this._early.splice(0)) fn(events);
  }
  read(): Uint8Array | null {
    const next = this._queue.shift() ?? null;
    if (!next && this._ended) setTimeout(() => this._endNow(), 0);
    return next;
  }
  write(bytes: Uint8Array): Promise<void> {
    if (!this.sends || this.finished || this.resetCode !== null) {
      return Promise.reject(new Error('The stream can send no more.'));
    }
    this.received.push(bytes);
    this.onData?.(bytes);
    return Promise.resolve();
  }
  finish(): Promise<void> {
    this.finished = true;
    this.onFinish?.();
    return Promise.resolve();
  }
  reset(code: number): void {
    this.resetCode = code;
  }
  stopSending(code: number): void {
    this.stopCode = code;
  }
  prioritize(priority: WebTransportPriority): void {
    this.priority = priority;
  }
  stats() {
    const sent = this.received.reduce((n, b) => n + b.byteLength, 0);
    return Promise.resolve({
      bytesWritten: sent,
      bytesSent: sent,
      bytesAcknowledged: sent,
      bytesReceived: 0,
      bytesRead: 0,
    });
  }
}

/** A session's server, which the test drives. */
export class FakeServer {
  /** The datagrams the page sent. */
  readonly datagrams: Uint8Array[] = [];
  /** The streams the page opened, in order. */
  readonly streams: FakeStream[] = [];
  /** How the page closed the session, where it did. */
  closedWith: { closeCode: number; reason: string } | null = null;
  /** The largest datagram the session takes. */
  maxDatagram = 1200;
  /** Whether a datagram is sent back as it arrives. */
  echoDatagrams = false;
  /** Whether a stream's bytes are sent back on it, its FIN with them. */
  echoStreams = false;
  private _ready = false;
  private _over = false;

  constructor(
    readonly request: WebTransportConnectRequest,
    private readonly _events: WebTransportSessionEvents,
  ) {}

  // --- what the server does --------------------------------------------------

  /** Establishes the session, a task later, choosing `protocol`. */
  accept(protocol = ''): void {
    setTimeout(() => {
      if (this._over) return;
      this._ready = true;
      this._events.ready({
        protocol,
        reliability: 'supports-unreliable',
        congestionControl: this.request.congestionControl,
      });
    }, 0);
  }
  /** Refuses it, or loses it after. */
  fail(message: string): void {
    setTimeout(() => {
      if (this._over) return;
      this._over = true;
      this._events.failed(message);
    }, 0);
  }
  /** Closes it with a code and a reason. */
  close(closeCode = 0, reason = ''): void {
    if (this._over) return;
    this._over = true;
    this._events.closed(closeCode, reason);
  }
  /** Asks it to be wound down. */
  drain(): void {
    this._events.draining();
  }
  /** Sends a datagram. */
  datagram(bytes: Uint8Array): void {
    this._events.datagram(bytes);
  }
  /** Opens a stream of the server's. */
  open(bidirectional: boolean): FakeStream {
    const stream = new FakeStream(bidirectional, bidirectional, true);
    this._events.stream(stream, bidirectional);
    return stream;
  }

  /** The session, as the seam hands it to the host. */
  get session(): WebTransportSessionLike {
    let groups = 0;
    return {
      createStream: (bidirectional, options) => {
        if (!this._ready || this._over) {
          return Promise.reject(new Error('not connected'));
        }
        const stream = new FakeStream(bidirectional, true, bidirectional);
        stream.priority = {
          sendOrder: options.sendOrder,
          sendGroup: options.sendGroup,
        };
        if (this.echoStreams && bidirectional) {
          stream.onData = (bytes) => stream.send(bytes);
          stream.onFinish = () => stream.end();
        }
        this.streams.push(stream);
        return Promise.resolve(stream);
      },
      sendDatagram: (bytes) => {
        if (bytes.byteLength > this.maxDatagram) return false;
        this.datagrams.push(bytes);
        if (this.echoDatagrams) {
          setTimeout(() => this._events.datagram(bytes), 0);
        }
        return true;
      },
      maxDatagramSize: () => this.maxDatagram,
      createSendGroup: () => ++groups,
      groupStats: () =>
        Promise.resolve({ bytesWritten: 0, bytesSent: 0, bytesAcknowledged: 0 }),
      stats: () =>
        Promise.resolve({
          bytesSent: 100,
          packetsSent: 2,
          bytesReceived: 50,
          packetsReceived: 1,
          smoothedRtt: 1.5,
          rttVariation: 0.5,
          minRtt: 1,
          estimatedSendRate: null,
          atSendCapacity: false,
        }),
      close: (closeCode, reason) => {
        this._over = true;
        this.closedWith = { closeCode, reason };
      },
    };
  }
}

/**
 * The seam: `serve` is handed each session's server as the page asks for
 * it, and decides what becomes of it. Every server made is kept, in order.
 */
export class FakeTransport implements HtmlWebTransport {
  readonly servers: FakeServer[] = [];
  constructor(private readonly _serve: (server: FakeServer) => void) {}
  connect(
    request: WebTransportConnectRequest,
    events: WebTransportSessionEvents,
  ): WebTransportSessionLike {
    const server = new FakeServer(request, events);
    this.servers.push(server);
    this._serve(server);
    return server.session;
  }
}
