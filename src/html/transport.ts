// What a page's `WebTransport` is carried over: the seam `<Html scripts>`
// asks to open a session (`HtmlScripts.webTransport`), shaped so that a
// stand-in, a proxy across a worker's thread and a real QUIC stack all
// answer it alike. The page's realm has the W3C API, over its own streams
// (`scripts/webtransport.ts`); what reaches this seam is the network's half
// of it — a session, its datagrams, its streams' bytes — and nothing of the
// page's.
//
// **Nothing is fetched by construction**, so the default answers no session
// at all (`NO_WEBTRANSPORT`): a page's `ready` rejects, as a browser's does
// with no network. `HtmlNetwork.webTransport` is a real one, over the
// optional peer `quico` (`./quico.ts`), where it is installed.
//
// Light on purpose: `<Html>` reaches it whether or not a document runs
// scripts.

declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const URL: new (url: string) => { port: string };

/** What a page asked to open: `new WebTransport(url, options)`, its
 *  options checked and converted as the constructor converts them. */
export interface WebTransportConnectRequest {
  /** An `https:` URL with no fragment. */
  url: string;
  /** The page's origin, which the session's CONNECT names (`Origin`). */
  origin: string;
  /** What the page added to the CONNECT (`options.headers`), minus what a
   *  page may not set. */
  headers: [string, string][];
  /** The application protocols the page offers, in its order
   *  (`WT-Available-Protocols`). */
  protocols: string[];
  /** Pins the server's certificate instead of a CA (W3C WebTransport,
   *  "verify a certificate hash"). */
  serverCertificateHashes: { algorithm: string; value: Uint8Array }[];
  allowPooling: boolean;
  requireUnreliable: boolean;
  congestionControl: 'default' | 'throughput' | 'low-latency';
  anticipatedConcurrentIncomingUnidirectionalStreams: number | null;
  anticipatedConcurrentIncomingBidirectionalStreams: number | null;
}

/** What the session was established with. */
export interface WebTransportReady {
  /** The protocol the server chose among those offered, or ''. */
  protocol: string;
  reliability: 'reliable-only' | 'supports-unreliable';
  congestionControl: 'default' | 'throughput' | 'low-latency';
  /** The response's headers, as they came, a pair a field — `Set-Cookie`
   *  and `wt-protocol` among them, which the host takes out before the
   *  page sees the rest (`responseHeaders`). Absent, none. */
  responseHeaders?: [string, string][];
}

/** A connection's figures (W3C WebTransport, `WebTransportConnectionStats`):
 *  what is not known is left out. */
export interface WebTransportStats {
  bytesSent?: number;
  bytesSentOverhead?: number;
  bytesAcknowledged?: number;
  packetsSent?: number;
  bytesLost?: number;
  packetsLost?: number;
  bytesReceived?: number;
  packetsReceived?: number;
  smoothedRtt?: number;
  rttVariation?: number;
  minRtt?: number;
  estimatedSendRate?: number | null;
  atSendCapacity?: boolean;
}

/** A stream's figures: a sending part's, and a receiving part's. */
export interface WebTransportStreamStats {
  bytesWritten?: number;
  bytesSent?: number;
  bytesAcknowledged?: number;
  bytesReceived?: number;
  bytesRead?: number;
}

/** What becomes of a session, told as it happens. */
export interface WebTransportSessionEvents {
  /** It was established. */
  ready(info: WebTransportReady): void;
  /**
   * It could not be established, or it was lost — the connection closed
   * under it, its certificate was refused, the server answered other than
   * 2xx. No close information: the page's promises reject. Told once, and
   * nothing after it.
   */
  failed(message: string): void;
  /** The server asked for it to be wound down (`WT_DRAIN_SESSION`). */
  draining(): void;
  /** It was closed cleanly by the server, with its code and reason —
   *  `0` and `''` for a session it ended with no capsule. Told once, and
   *  nothing after it. */
  closed(closeCode: number, reason: string): void;
  /** A datagram arrived. */
  datagram(bytes: Uint8Array): void;
  /** The server opened a stream. */
  stream(stream: WebTransportStreamLike, bidirectional: boolean): void;
}

/** What becomes of a stream, told as it happens. */
export interface WebTransportStreamEvents {
  /** There are bytes to `read()`. */
  readable(): void;
  /** The peer finished sending, and every byte it sent has been read. */
  end(): void;
  /** The peer reset its sending part (RESET_STREAM), with its
   *  application's code, or null. */
  reset(code: number | null): void;
  /** The peer asked this side to stop sending (STOP_SENDING), with its
   *  application's code, or null. */
  stopSending(code: number | null): void;
}

/** Where a stream's sending part goes in the session's turns: its order,
 *  and its group, a number `createSendGroup` answered, or null. */
export interface WebTransportPriority {
  sendOrder: number;
  sendGroup: number | null;
}

/** One stream of a session, either direction or both. */
export interface WebTransportStreamLike {
  /** Starts telling the stream's events; what arrived before is kept. */
  listen(events: WebTransportStreamEvents): void;
  /** The bytes that arrived and have not been read, or null. Reading them
   *  is what gives the peer room to send more (flow control). */
  read(): Uint8Array | null;
  /** Sends bytes; settles once the stream will take more. Rejects where
   *  the stream can send no more. */
  write(bytes: Uint8Array): Promise<void>;
  /** Ends the sending part (FIN); settles once that is queued. */
  finish(): Promise<void>;
  /** Abandons the sending part (RESET_STREAM) with an application code. */
  reset(code: number): void;
  /** Stops reading (STOP_SENDING) with an application code. */
  stopSending(code: number): void;
  /** Moves the sending part in the session's turns. */
  prioritize(priority: WebTransportPriority): void;
  stats(): Promise<WebTransportStreamStats>;
}

/** An open session, or one being opened. */
export interface WebTransportSessionLike {
  /** Opens a stream of the page's. Waits for the session where it is still
   *  being established; rejects where it is gone, or where the server
   *  allows no more and the page did not ask to wait. */
  createStream(
    bidirectional: boolean,
    options: WebTransportPriority & { waitUntilAvailable: boolean },
  ): Promise<WebTransportStreamLike>;
  /** Sends a datagram, at once where the session is established: whether
   *  it was queued — false for one larger than `maxDatagramSize()`. */
  sendDatagram(bytes: Uint8Array, priority: WebTransportPriority): boolean;
  /** The largest datagram the session can send now, in bytes. */
  maxDatagramSize(): number;
  /** A send group of the session's, by a number. */
  createSendGroup(): number;
  /** What a send group's streams have sent. */
  groupStats(group: number): Promise<WebTransportStreamStats>;
  /** The connection's figures. */
  stats(): Promise<WebTransportStats>;
  /**
   * Keying material of the session's own, `length` bytes from its TLS
   * exporter for a label and a context of at most 255 bytes each, the
   * length 1 to 4096 — all three checked by the page's realm before they
   * get here (WebTransport over HTTP/3, "Exporting Keying Material").
   * Waits for the session where it is still being established; rejects
   * where it is gone. Optional, as a seam written before it has none: a
   * page's call then rejects with a `NotSupportedError`, and so does one
   * whose rejection is named so.
   */
  exportKeyingMaterial?(
    label: Uint8Array,
    context: Uint8Array,
    length: number,
  ): Promise<Uint8Array>;
  /** Closes the session with a code and a reason of at most 1024 bytes:
   *  `closed` is not told of it, since the page closed it. */
  close(closeCode: number, reason: string): void;
}

/**
 * What a page's `WebTransport` is carried over (`HtmlScripts.webTransport`).
 * `connect` never throws: what becomes of the session is told through
 * `events`, and a session that cannot be had is `failed`.
 */
export interface HtmlWebTransport {
  connect(
    request: WebTransportConnectRequest,
    events: WebTransportSessionEvents,
  ): WebTransportSessionLike;
}

/** A session no network carries: failed as soon as it is asked for. */
const REFUSED: WebTransportSessionLike = {
  createStream: () =>
    Promise.reject(new Error('This session was never established.')),
  sendDatagram: () => false,
  maxDatagramSize: () => 0,
  createSendGroup: () => 0,
  groupStats: () => Promise.resolve({}),
  stats: () => Promise.resolve({}),
  exportKeyingMaterial: () =>
    Promise.reject(new Error('This session was never established.')),
  close() {},
};

/** A seam's session's keying material, or a rejection named
 *  `NotSupportedError` where the seam has no way to export it. */
export function exportFrom(
  session: WebTransportSessionLike,
  label: Uint8Array,
  context: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (typeof session.exportKeyingMaterial !== 'function') {
    const error = new Error('This network cannot export keying material.');
    error.name = 'NotSupportedError';
    return Promise.reject(error);
  }
  return session.exportKeyingMaterial(label, context, length);
}

/**
 * The default `webTransport`: no network, so every session fails, as one
 * a browser with no network asks for — a page hears its `ready` reject a
 * task later, and nothing is sent anywhere.
 */
/** What a session the back-forward cache closed fails with, on the page's
 *  side and across a worker's thread. */
export const LEFT_FOR_CACHE = 'The page entered the back-forward cache.';

export const NO_WEBTRANSPORT: HtmlWebTransport = {
  connect(request, events) {
    setTimeout(
      () =>
        events.failed(
          `${request.url} was not opened: this <Html> has no scripts.webTransport.`,
        ),
      0,
    );
    return REFUSED;
  },
};

/**
 * A session over a seam not had yet — one loaded the first time a page asks
 * for a session — answered at once and carried over it once it is: what
 * the page asks of it meanwhile waits, and a datagram is not sent.
 */
export function deferredSession(
  seam: Promise<HtmlWebTransport>,
  request: WebTransportConnectRequest,
  events: WebTransportSessionEvents,
): WebTransportSessionLike {
  let session: WebTransportSessionLike | null = null;
  let closed: [number, string] | null = null;
  const groups: number[] = [];
  const ready = seam.then(
    (s) => {
      session = s.connect(request, events);
      for (let i = 0; i < groups.length; i += 1) session.createSendGroup();
      if (closed) session.close(closed[0], closed[1]);
      return session;
    },
    (error: unknown) => {
      events.failed(String((error as Error)?.message ?? error));
      return REFUSED;
    },
  );
  return {
    createStream: (bidirectional, options) =>
      ready.then((s) => s.createStream(bidirectional, options)),
    sendDatagram: (bytes, priority) =>
      session ? session.sendDatagram(bytes, priority) : false,
    maxDatagramSize: () => (session ? session.maxDatagramSize() : 0),
    createSendGroup() {
      if (session) return session.createSendGroup();
      groups.push(groups.length + 1);
      return groups.length;
    },
    groupStats: (group) => ready.then((s) => s.groupStats(group)),
    stats: () => ready.then((s) => s.stats()),
    exportKeyingMaterial: (label, context, length) =>
      ready.then((s) => exportFrom(s, label, context, length)),
    close(closeCode, reason) {
      if (session) session.close(closeCode, reason);
      else closed = [closeCode, reason];
    },
  };
}

/** Ports a browser does not connect to (Fetch, "bad port"), which a
 *  WebTransport is refused at as a fetch is. */
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/** Whether a URL's port is one no session is opened to. */
export function badPort(url: string): boolean {
  try {
    const u = new URL(url);
    const port = u.port === '' ? 443 : Number(u.port);
    return BAD_PORTS.has(port);
  } catch {
    return true;
  }
}
