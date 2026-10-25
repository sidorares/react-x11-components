// A page's WebTransport over `quico`: QUIC (RFC 9000), TLS 1.3, HTTP/3 and
// WebTransport over HTTP/3, all of it JavaScript, on the runtime's
// `node:dgram` and `node:crypto` — so the same on Node and on Bun, and no
// native build for anyone. `HtmlNetwork.webTransport` is this
// (`../network.ts`), loaded the first time a page opens a session.
//
// Why quico. Node 24's `node:quic` is experimental and in no release build
// (this Node has no ngtcp2 or nghttp3 at all); `@fails-components/
// webtransport` is a native addon over libquiche that downloads a binary
// as it installs, verifies a server only by certificate hashes unless an
// experimental CA check is on, and has no `getStats()` and no
// `reliability`. quico has the browser's API whole — streams with send
// groups and orders, datagrams, `getStats()`, protocols, the certificate
// verified against the CAs it is handed or pinned by
// `serverCertificateHashes` — and runs wherever `node:dgram` does.
//
// It is an optional peer, as `node-pty` is: three megabytes of an
// HTTP stack an app that shows no WebTransport page never wants, so it is
// never installed for anyone, and an app that wants a page's sessions
// installs it. It is reached by a dynamic `import()` whose specifier the
// compiler cannot see, and its types are written out here, structurally,
// so an app without it type-checks. Not installed, `connect` answers a
// session that fails, as one with no network does.
//
// **One reach into quico's insides**, and why. A browser's CONNECT names
// the page's `Origin` (WebTransport over HTTP/3, 3.3), and a server may
// refuse one that names none — WPT's does, with a 403 — and the page's own
// `headers` option goes on it too. quico's client takes no request headers,
// so `PageSession` adds them where it sends its CONNECT (`_sendConnect`,
// through `_h3.sendHeaders`), only where both are there to wrap; a quico
// without them sends its CONNECT as it would, with no `Origin`. The rest is
// its public API.
import type {
  HtmlWebTransport,
  WebTransportConnectRequest,
  WebTransportPriority,
  WebTransportSessionEvents,
  WebTransportSessionLike,
  WebTransportStats,
  WebTransportStreamEvents,
  WebTransportStreamLike,
  WebTransportStreamStats,
} from './transport.js';

declare const queueMicrotask: (fn: () => void) => void;

// --- quico's shape, the slice read here ------------------------------------

/** A Node stream of a session's (quico's `wt_stream.js`): a Duplex for a
 *  bidirectional stream, a Readable for the server's unidirectional one, a
 *  Writable — wrapped in a WHATWG one — for the page's. */
interface QuicoStream {
  read?(): Uint8Array | null;
  write?(chunk: Uint8Array, callback: (error?: unknown) => void): boolean;
  end?(callback?: () => void): void;
  resetStream?(code: number): boolean;
  stopSending?(code: number): void;
  getStats?(): Promise<Record<string, unknown>>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  sendOrder?: number;
  sendGroup?: unknown;
  readableEnded?: boolean;
  destroyed?: boolean;
}

interface QuicoSendGroup {
  getStats(): Promise<Record<string, unknown>>;
}

interface QuicoSession {
  readonly ready: Promise<void>;
  readonly closed: Promise<{ closeCode: number; reason: string }>;
  readonly protocol: string;
  readonly reliability: string;
  readonly congestionControl: string;
  readonly closeInfo?: { closeCode: number; reason: string };
  readonly incomingBidirectionalStreams: {
    getReader(): { read(): Promise<{ done: boolean }> };
  };
  on(event: string, listener: (...args: never[]) => void): unknown;
  close(info?: { closeCode?: number; reason?: string }): void;
  createBidirectionalStream(options?: object): Promise<QuicoStream>;
  createUnidirectionalStream(options?: object): Promise<QuicoStream>;
  sendDatagram(data: Uint8Array, options?: object): boolean;
  maxDatagramSize(): number;
  createSendGroup(): QuicoSendGroup;
  getStats(): Promise<Record<string, unknown>>;
}

type QuicoSessionClass = new (
  url: string,
  options: Record<string, unknown>,
) => QuicoSession;

interface QuicoModule {
  WebTransport: QuicoSessionClass;
}

/** The optional peer's name. */
export const QUICO_MODULE = 'quico';

let loading: Promise<QuicoModule | null> | null = null;

/**
 * quico, where it is installed, or null. The specifier is a variable on
 * purpose (`src/terminal/vt/pty.ts`'s shape): a literal would put the
 * package in the type graph, where it is not installed, and ask a bundler
 * to resolve it.
 */
export function loadQuico(): Promise<QuicoModule | null> {
  if (!loading) {
    const specifier = QUICO_MODULE;
    loading = (import(/* @vite-ignore */ specifier) as Promise<QuicoModule>)
      .then((m) =>
        typeof m?.WebTransport === 'function' ? m : null,
      )
      .catch(() => null);
  }
  return loading;
}

/** The headers a session's CONNECT carries beside quico's own. */
const EXTRA = Symbol('headers');

/** quico's client, with the page's `Origin` and headers on its CONNECT. */
function pageSessionClass(base: QuicoSessionClass): QuicoSessionClass {
  const proto = base.prototype as Record<string, unknown>;
  if (typeof proto._sendConnect !== 'function') return base;
  class PageSession extends (base as new (
    url: string,
    options: Record<string, unknown>,
  ) => object) {
    _sendConnect(): void {
      const self = this as unknown as {
        [EXTRA]?: Record<string, string>;
        _h3?: {
          sendHeaders?: (
            id: number,
            headers: Record<string, string>,
            fin: boolean,
          ) => void;
        };
      };
      const h3 = self._h3;
      const send = h3?.sendHeaders;
      const extra = self[EXTRA];
      const connect = (proto._sendConnect as () => void).bind(this);
      if (!h3 || typeof send !== 'function' || !extra) {
        connect();
        return;
      }
      // after quico's own, the pseudo-headers first among them, as HTTP/3
      // has a field section
      h3.sendHeaders = (id, headers, fin) =>
        send.call(h3, id, { ...headers, ...extra }, fin);
      try {
        connect();
      } finally {
        h3.sendHeaders = send;
      }
    }
  }
  return PageSession as unknown as QuicoSessionClass;
}

let PageSession: QuicoSessionClass | null = null;

/** Numbers as the page's statistics take them: what is not known is left
 *  out. */
function known(
  raw: Record<string, unknown>,
  keys: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}
const CONNECTION_STATS = [
  'bytesSent',
  'bytesSentOverhead',
  'bytesAcknowledged',
  'packetsSent',
  'bytesLost',
  'packetsLost',
  'bytesReceived',
  'packetsReceived',
  'smoothedRtt',
  'rttVariation',
  'minRtt',
] as const;
const STREAM_STATS = [
  'bytesWritten',
  'bytesSent',
  'bytesAcknowledged',
  'bytesReceived',
  'bytesRead',
] as const;

/** A quico stream as the seam's stream. */
function streamOf(
  s: QuicoStream,
  groups: (n: number | null) => unknown,
): WebTransportStreamLike {
  let events: WebTransportStreamEvents | null = null;
  // what happened before anything listened, told when something does
  const early: ((e: WebTransportStreamEvents) => void)[] = [];
  const tell = (fn: (e: WebTransportStreamEvents) => void): void => {
    if (events) fn(events);
    else early.push(fn);
  };
  s.on('readable', () => tell((e) => e.readable()));
  s.on('end', () => tell((e) => e.end()));
  s.on('peerReset', ((code: number | null) =>
    tell((e) => e.reset(code))) as never);
  s.on('peerStopSending', ((code: number | null) =>
    tell((e) => e.stopSending(code))) as never);
  // a stream's end is told by its events, never as a throw
  s.on('error', () => {});
  return {
    listen(listener) {
      events = listener;
      for (const fn of early.splice(0)) fn(listener);
    },
    read() {
      const chunk = s.read?.() ?? null;
      if (!chunk) return null;
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    },
    write(bytes) {
      return new Promise((resolve, reject) => {
        if (!s.write || s.destroyed) {
          reject(new Error('The stream can send no more.'));
          return;
        }
        s.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
    },
    finish() {
      return new Promise((resolve, reject) => {
        if (!s.end || s.destroyed) {
          reject(new Error('The stream can send no more.'));
          return;
        }
        s.end(() => resolve());
      });
    },
    reset(code) {
      s.resetStream?.(code);
    },
    stopSending(code) {
      s.stopSending?.(code);
    },
    prioritize(priority: WebTransportPriority) {
      if (!('sendOrder' in s)) return;
      s.sendOrder = priority.sendOrder;
      s.sendGroup = groups(priority.sendGroup) ?? null;
    },
    async stats(): Promise<WebTransportStreamStats> {
      try {
        return known((await s.getStats?.()) ?? {}, STREAM_STATS);
      } catch {
        return {};
      }
    },
  };
}

/** What a session's trust is: the CAs its server is verified against. */
export interface QuicoOptions {
  /** The CA certificates, PEM. Default: the runtime's own roots and
   *  `NODE_EXTRA_CA_CERTS`, the ones its `fetch` trusts. */
  ca?: string[];
}

/** The runtime's trusted roots, as its `fetch` has them. */
async function runtimeRoots(): Promise<string[] | undefined> {
  try {
    const specifier = 'node:tls';
    const tls = (await import(/* @vite-ignore */ specifier)) as {
      getCACertificates?: (type?: string) => string[];
      rootCertificates?: readonly string[];
    };
    if (typeof tls.getCACertificates === 'function') {
      return tls.getCACertificates('default');
    }
    return tls.rootCertificates ? [...tls.rootCertificates] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The seam over quico (`HtmlNetwork.webTransport`): each session a
 * connection of its own, as a page's is in a browser that pools none.
 */
export function quicoWebTransport(options: QuicoOptions = {}): HtmlWebTransport {
  let roots: Promise<string[] | undefined> | null = null;
  return {
    connect(request, events) {
      return quicoSession(
        request,
        events,
        () => (roots ??= options.ca ? Promise.resolve(options.ca) : runtimeRoots()),
      );
    },
  };
}

function quicoSession(
  request: WebTransportConnectRequest,
  events: WebTransportSessionEvents,
  roots: () => Promise<string[] | undefined>,
): WebTransportSessionLike {
  let wt: QuicoSession | null = null;
  let over = false;
  let closedByPage = false;
  let closeSeen = false;
  // the server's streams that came before its 200 was told, which follow it
  let told = false;
  const early: [QuicoStream, boolean][] = [];
  const incoming = (s: QuicoStream, bidirectional: boolean): void => {
    if (over) return;
    if (!told) early.push([s, bidirectional]);
    else events.stream(streamOf(s, groupOf), bidirectional);
  };
  const groups = new Map<number, QuicoSendGroup | null>();
  let groupSeq = 0;
  const groupOf = (n: number | null): QuicoSendGroup | null => {
    if (n === null || !groups.has(n)) return null;
    let g = groups.get(n) ?? null;
    if (!g && wt) groups.set(n, (g = wt.createSendGroup()));
    return g;
  };
  const fail = (message: string): void => {
    if (over) return;
    over = true;
    events.failed(message);
  };
  // what the session came to before the page heard it was established,
  // told once it has
  let ended: (() => void) | null = null;
  // the server's end of the CONNECT stream, from quico's closing of the
  // session's incoming streams: read from as the session is made, since
  // the end can come in the packet that brings the 200
  let finished: Promise<boolean> = Promise.resolve(false);
  const ready = (async (): Promise<QuicoSession | null> => {
    const quico = await loadQuico();
    if (!quico) {
      fail(
        `${request.url} was not opened: WebTransport needs the optional package '${QUICO_MODULE}', which is not installed.`,
      );
      return null;
    }
    if (closedByPage) return null;
    PageSession ??= pageSessionClass(quico.WebTransport);
    const hashes = request.serverCertificateHashes;
    const ca = hashes.length ? undefined : await roots();
    if (closedByPage) return null;
    let session: QuicoSession;
    try {
      session = new PageSession(request.url, {
        protocols: request.protocols,
        congestionControl: request.congestionControl,
        requireUnreliable: request.requireUnreliable,
        ...(hashes.length
          ? {
              serverCertificateHashes: hashes.map((h) => ({
                algorithm: h.algorithm,
                value: h.value,
              })),
            }
          : {}),
        ...(ca ? { ca } : {}),
      });
    } catch (error) {
      fail(String((error as Error)?.message ?? error));
      return null;
    }
    (session as unknown as Record<symbol, unknown>)[EXTRA] = {
      origin: request.origin,
      ...Object.fromEntries(request.headers),
    };
    wt = session;
    finished = session.incomingBidirectionalStreams
      .getReader()
      .read()
      .then(
        (r) => r.done,
        () => true,
      );
    session.on('error', () => {});
    session.on('datagram', ((data: Uint8Array) => {
      if (over) return;
      events.datagram(new Uint8Array(data));
    }) as never);
    session.on('stream', ((s: QuicoStream) => incoming(s, true)) as never);
    session.on('unidirectionalStream', ((s: QuicoStream) =>
      incoming(s, false)) as never);
    session.on('draining', () => {
      if (!over) events.draining();
    });
    session.on('close', () => {
      closeSeen = true;
      if (over || closedByPage) return;
      // closed with a capsule (the server's CLOSE_WEBTRANSPORT_SESSION), or
      // lost with the connection under it
      const info = session.closeInfo;
      const end = (): void => {
        if (over) return;
        over = true;
        if (info) {
          events.closed(info.closeCode >>> 0, String(info.reason ?? ''));
        } else events.failed('The WebTransport connection was closed.');
      };
      if (told) end();
      else ended = end;
    });
    return session;
  })();
  void ready.then(async (session) => {
    if (!session) return;
    try {
      await session.ready;
    } catch (error) {
      fail(String((error as Error)?.message ?? error));
      return;
    }
    if (over || closedByPage) return;
    events.ready({
      protocol: session.protocol ?? '',
      reliability:
        session.reliability === 'reliable-only'
          ? 'reliable-only'
          : 'supports-unreliable',
      congestionControl:
        session.congestionControl === 'throughput' ||
        session.congestionControl === 'low-latency'
          ? session.congestionControl
          : 'default',
    });
    told = true;
    for (const [s, bidirectional] of early.splice(0)) incoming(s, bidirectional);
    if (ended) {
      ended();
      return;
    }
    // The server ending the CONNECT stream with no capsule is a clean
    // close with code 0 (WebTransport over HTTP/3, 5): quico closes the
    // session's incoming streams for it, and tells nothing else.
    const done = await finished;
    queueMicrotask(() => {
      if (!done || over || closedByPage || closeSeen) return;
      over = true;
      events.closed(0, '');
      try {
        session.close();
      } catch {}
    });
  });
  return {
    async createStream(bidirectional, options) {
      const session = await ready;
      if (!session) throw new Error('The session was never established.');
      await session.ready;
      const o = {
        sendOrder: options.sendOrder,
        ...(options.sendGroup !== null
          ? { sendGroup: groupOf(options.sendGroup) }
          : {}),
        waitUntilAvailable: options.waitUntilAvailable,
      };
      const s = bidirectional
        ? await session.createBidirectionalStream(o)
        : await session.createUnidirectionalStream(o);
      return streamOf(s, groupOf);
    },
    sendDatagram(bytes, priority) {
      if (!wt || over) return false;
      try {
        return wt.sendDatagram(bytes, {
          sendOrder: priority.sendOrder,
          ...(priority.sendGroup !== null
            ? { sendGroup: groupOf(priority.sendGroup) }
            : {}),
        });
      } catch {
        return false;
      }
    },
    maxDatagramSize() {
      try {
        return wt ? wt.maxDatagramSize() : 0;
      } catch {
        return 0;
      }
    },
    createSendGroup() {
      const n = ++groupSeq;
      groups.set(n, wt ? wt.createSendGroup() : null);
      return n;
    },
    async groupStats(n) {
      const g = groupOf(n);
      if (!g) return { bytesWritten: 0, bytesSent: 0, bytesAcknowledged: 0 };
      return known(await g.getStats(), STREAM_STATS);
    },
    async stats(): Promise<WebTransportStats> {
      const session = await ready;
      if (!session) return {};
      const raw = await session.getStats();
      return {
        ...known(raw, CONNECTION_STATS),
        estimatedSendRate:
          typeof raw.estimatedSendRate === 'number'
            ? raw.estimatedSendRate
            : null,
        atSendCapacity: raw.atSendCapacity === true,
      };
    },
    close(closeCode, reason) {
      if (closedByPage) return;
      closedByPage = true;
      over = true;
      try {
        wt?.close({ closeCode, reason });
      } catch {}
    },
  };
}
