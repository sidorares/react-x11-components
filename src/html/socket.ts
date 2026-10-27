// What a page's `WebSocket` is carried over: the seam `<Html scripts>` asks
// to open a connection (`HtmlScripts.webSocket`), shaped so that a stand-in,
// a proxy across a worker's thread and the runtime's own `WebSocket` all
// answer it alike. The page's realm has the WHATWG API
// (`scripts/websocket.ts`); what reaches this seam is the network's half of
// it — a connection, its messages, how it closed — and nothing of the
// page's.
//
// **Nothing is fetched by construction**, so the default opens nothing
// (`NO_WEBSOCKET`): a page's socket fails, as one a browser with no network
// opens does. `HtmlNetwork.webSockets(page)` is a real one, over the
// runtime's global `WebSocket`.
//
// Light on purpose: `<Html>` reaches it whether or not a document runs
// scripts.

declare const setTimeout: (fn: () => void, ms: number) => unknown;

/** What a page asked to open: `new WebSocket(url, protocols)`, its URL and
 *  its protocols checked as the constructor checks them. */
export interface WebSocketConnectRequest {
  /** A `ws:` or `wss:` URL with no fragment. */
  url: string;
  /** The origin of the document or the worker that opened it, which the
   *  opening handshake's `Origin` names (RFC 6455 4.1) — `null` for an
   *  opaque one. */
  origin: string;
  /** The subprotocols the page offers, in its order
   *  (`Sec-WebSocket-Protocol`). */
  protocols: string[];
}

/** What the connection was established with. */
export interface WebSocketOpened {
  /** The subprotocol the server chose among those offered, or ''. */
  protocol: string;
  /** The extensions it agreed to (`Sec-WebSocket-Extensions`), or ''. */
  extensions: string;
}

/** What becomes of a connection, told as it happens. */
export interface WebSocketEvents {
  /** The opening handshake succeeded. */
  open(info: WebSocketOpened): void;
  /** A message arrived: text as a string, binary as bytes. */
  message(data: string | Uint8Array): void;
  /**
   * The connection failed: it could not be established, or it was failed
   * after — a protocol error, a refused handshake, a network gone. Told
   * once, and nothing after it. The page hears `error` and a `close` with
   * code 1006, since every failure looks alike to a script (WebSockets,
   * "fail the WebSocket connection"); the message is the console's.
   */
  failed(message: string): void;
  /** It closed, with the close frame's code and reason — 1005 where the
   *  frame had no code, 1006 where no frame came — and whether the closing
   *  handshake completed. Told once, and nothing after it. */
  closed(code: number, reason: string, wasClean: boolean): void;
}

/** An open connection, or one being opened. */
export interface WebSocketConnectionLike {
  /** Sends a message: text as a string, binary as bytes. */
  send(data: string | Uint8Array): void;
  /** The bytes sent and not yet handed to the network, which is what the
   *  page's `bufferedAmount` comes down by. */
  bufferedAmount(): number;
  /**
   * Starts the closing handshake, with no status code where `code` is
   * null; before the connection is established, abandons it. `closed` or
   * `failed` follows.
   */
  close(code: number | null, reason: string): void;
}

/**
 * What a page's `WebSocket` is carried over (`HtmlScripts.webSocket`).
 * `connect` never throws: what becomes of the connection is told through
 * `events`, and one that cannot be had is `failed`.
 */
export interface HtmlWebSocket {
  connect(
    request: WebSocketConnectRequest,
    events: WebSocketEvents,
  ): WebSocketConnectionLike;
}

/** A connection no network carries. */
export const REFUSED_SOCKET: WebSocketConnectionLike = {
  send() {},
  bufferedAmount: () => 0,
  close() {},
};

/**
 * The default `webSocket`: no network, so every connection fails, as one a
 * browser with no network opens — a page hears `error` and `close` a task
 * later, and nothing is sent anywhere.
 */
export const NO_WEBSOCKET: HtmlWebSocket = {
  connect(request, events) {
    setTimeout(
      () =>
        events.failed(
          `${request.url} was not opened: this <Html> has no scripts.webSocket.`,
        ),
      0,
    );
    return REFUSED_SOCKET;
  },
};
