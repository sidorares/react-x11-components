// A `webSocket` seam a test drives by hand: each connection a page asks for
// is a `FakeConnection`, which records what it was sent and how it was
// closed, and which the test opens, answers, fails or closes.
import type {
  HtmlWebSocket,
  WebSocketConnectRequest,
  WebSocketConnectionLike,
  WebSocketEvents,
} from '../src/html/socket.js';

function sizeOf(data: string | Uint8Array): number {
  return typeof data === 'string'
    ? Buffer.byteLength(data, 'utf8')
    : data.byteLength;
}

export class FakeConnection implements WebSocketConnectionLike {
  readonly sent: (string | Uint8Array)[] = [];
  /** What `close` was called with, each time. */
  readonly closes: [number | null, string][] = [];
  /** What the seam holds and has not sent, which `drain` lets go. */
  buffered = 0;
  /** Each message sent, sent back. */
  echo = false;
  /** A closing handshake the page starts is answered, clean, with its
   *  code — 1005 for none — a task later. */
  answersClose = true;

  constructor(
    readonly request: WebSocketConnectRequest,
    readonly events: WebSocketEvents,
  ) {}

  open(protocol = '', extensions = ''): void {
    this.events.open({ protocol, extensions });
  }

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : data.slice());
    this.buffered += sizeOf(data);
    if (this.echo) {
      const copy = typeof data === 'string' ? data : data.slice();
      setTimeout(() => this.events.message(copy), 0);
    }
  }

  drain(): void {
    this.buffered = 0;
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  close(code: number | null, reason: string): void {
    this.closes.push([code, reason]);
    if (this.answersClose) {
      setTimeout(() => this.events.closed(code ?? 1005, reason, true), 0);
    }
  }
}

export class FakeSockets implements HtmlWebSocket {
  readonly connections: FakeConnection[] = [];

  constructor(private readonly _made: (c: FakeConnection) => void = () => {}) {}

  connect(
    request: WebSocketConnectRequest,
    events: WebSocketEvents,
  ): WebSocketConnectionLike {
    const c = new FakeConnection(request, events);
    this.connections.push(c);
    this._made(c);
    return c;
  }
}
